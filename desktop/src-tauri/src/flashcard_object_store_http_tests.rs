use super::*;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Clone, Copy, Debug)]
enum HeadHeaders {
    Verified,
    MissingLength,
    WrongLength,
    MissingHash,
    WrongHash,
}

#[derive(Debug, Default, PartialEq)]
struct Counts {
    head: usize,
    get: usize,
    put: usize,
}

struct Objects {
    bytes: Option<Vec<u8>>,
    headers: HeadHeaders,
    counts: Counts,
}

struct Server {
    url: Url,
    state: Arc<Mutex<Objects>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn server(bytes: Option<&[u8]>, headers: HeadHeaders) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
    let state = Arc::new(Mutex::new(Objects {
        bytes: bytes.map(Vec::from),
        headers,
        counts: Counts::default(),
    }));
    let shared = Arc::clone(&state);
    let task = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut data = Vec::new();
            let mut chunk = [0; 4096];
            let end = loop {
                let n = socket.read(&mut chunk).await.unwrap();
                if n == 0 {
                    break 0;
                }
                data.extend_from_slice(&chunk[..n]);
                assert!(data.len() <= 16 * 1024);
                if let Some(position) = data.windows(4).position(|part| part == b"\r\n\r\n") {
                    break position + 4;
                }
            };
            if end == 0 {
                continue;
            }
            let request = String::from_utf8(data[..end].to_vec()).unwrap();
            let method = request.split_whitespace().next().unwrap();
            let fields: BTreeMap<_, _> = request
                .lines()
                .skip(1)
                .filter_map(|line| line.split_once(':'))
                .map(|(key, value)| (key.to_ascii_lowercase(), value.trim().to_owned()))
                .collect();
            assert!(fields["authorization"].starts_with("OSS4-HMAC-SHA256"));
            let size = fields
                .get("content-length")
                .map(|value| value.parse::<usize>().unwrap())
                .unwrap_or(0);
            while data.len() < end + size {
                let n = socket.read(&mut chunk).await.unwrap();
                assert!(n > 0);
                data.extend_from_slice(&chunk[..n]);
            }
            let (status, body, hash, length) = {
                let mut objects = shared.lock().unwrap();
                match method {
                    "HEAD" => {
                        objects.counts.head += 1;
                        match objects.bytes.as_ref() {
                            Some(bytes) => {
                                let length = match objects.headers {
                                    HeadHeaders::MissingLength => None,
                                    HeadHeaders::WrongLength => Some(bytes.len() + 1),
                                    _ => Some(bytes.len()),
                                };
                                let hash = match objects.headers {
                                    HeadHeaders::MissingHash => None,
                                    HeadHeaders::WrongHash => Some("incorrect-sha256".to_string()),
                                    _ => Some(format!("{:x}", Sha256::digest(bytes))),
                                };
                                (200, Vec::new(), hash, length)
                            }
                            None => (404, Vec::new(), None, Some(0)),
                        }
                    }
                    "GET" => {
                        objects.counts.get += 1;
                        match objects.bytes.as_ref() {
                            Some(bytes) => (200, bytes.clone(), None, Some(bytes.len())),
                            None => (404, Vec::new(), None, Some(0)),
                        }
                    }
                    "PUT" => {
                        objects.counts.put += 1;
                        assert_eq!(fields["x-oss-forbid-overwrite"], "true");
                        if objects.bytes.is_some() {
                            (409, Vec::new(), None, Some(0))
                        } else {
                            let bytes = data[end..end + size].to_vec();
                            assert_eq!(
                                fields["x-oss-meta-sha256"],
                                format!("{:x}", Sha256::digest(&bytes))
                            );
                            objects.bytes = Some(bytes);
                            (200, Vec::new(), None, Some(0))
                        }
                    }
                    _ => panic!("Unexpected HTTP method: {method}"),
                }
            };
            let mut response = format!("HTTP/1.1 {status} Test\r\nConnection: close\r\n");
            if let Some(length) = length {
                response.push_str(&format!("Content-Length: {length}\r\n"));
            }
            if let Some(hash) = hash {
                response.push_str(&format!("x-oss-meta-sha256: {hash}\r\n"));
            }
            response.push_str("\r\n");
            socket.write_all(response.as_bytes()).await.unwrap();
            socket.write_all(&body).await.unwrap();
            socket.shutdown().await.unwrap();
        }
    });
    Server { url, state, task }
}

fn store(server: &Server) -> OssStore {
    OssStore::new(
        OssConfig {
            bucket: "test-bucket".into(),
            region: "cn-hangzhou".into(),
            prefix: "HubFlashcards".into(),
            access_key_id: "EXAMPLE".into(),
        },
        "synthetic-test-secret".into(),
    )
    .unwrap()
    .with_test_endpoint(server.url.clone())
}

async fn put(remote: &OssStore, bytes: &[u8]) -> Result<bool, String> {
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        remote.put_verified(&remote.key("media/test-object"), bytes),
    )
    .await
    .expect("Loopback HTTP verification timed out")
}

#[tokio::test]
async fn head_existing_nonempty_object_skips_get_and_put() {
    let bytes = b"a non-empty attachment already in OSS";
    let server = server(Some(bytes), HeadHeaders::Verified).await;
    let remote = store(&server);
    assert!(!put(&remote, bytes).await.unwrap());
    assert_eq!(
        server.state.lock().unwrap().counts,
        Counts {
            head: 1,
            get: 0,
            put: 0
        }
    );
    assert_eq!(remote.transferred(), (0, 0));
}

#[tokio::test]
async fn head_untrusted_metadata_falls_back_to_exact_body_verification() {
    let bytes = b"an attachment checked through the real GET fallback";
    for headers in [
        HeadHeaders::MissingLength,
        HeadHeaders::WrongLength,
        HeadHeaders::MissingHash,
        HeadHeaders::WrongHash,
    ] {
        let server = server(Some(bytes), headers).await;
        let remote = store(&server);
        assert!(!put(&remote, bytes).await.unwrap(), "{headers:?}");
        assert_eq!(
            server.state.lock().unwrap().counts,
            Counts {
                head: 1,
                get: 1,
                put: 0
            },
            "{headers:?}"
        );
        assert_eq!(remote.transferred(), (0, bytes.len() as u64), "{headers:?}");
    }
}

#[tokio::test]
async fn head_fallback_rejects_conflicting_content_without_overwrite() {
    let server = server(Some(b"wrong-content"), HeadHeaders::MissingHash).await;
    let remote = store(&server);
    assert!(put(&remote, b"right-content")
        .await
        .unwrap_err()
        .contains("内容身份不一致"));
    assert_eq!(
        server.state.lock().unwrap().counts,
        Counts {
            head: 1,
            get: 1,
            put: 0
        }
    );
    assert_eq!(
        server.state.lock().unwrap().bytes.as_deref(),
        Some(b"wrong-content".as_slice())
    );
}

#[tokio::test]
async fn head_missing_object_still_uploads_and_reads_back_exact_bytes() {
    let bytes = b"a new non-empty attachment";
    let server = server(None, HeadHeaders::Verified).await;
    let remote = store(&server);
    assert!(put(&remote, bytes).await.unwrap());
    assert_eq!(
        server.state.lock().unwrap().counts,
        Counts {
            head: 1,
            get: 2,
            put: 1
        }
    );
    assert_eq!(
        server.state.lock().unwrap().bytes.as_deref(),
        Some(bytes.as_slice())
    );
    assert_eq!(
        remote.transferred(),
        (bytes.len() as u64, bytes.len() as u64)
    );
}
