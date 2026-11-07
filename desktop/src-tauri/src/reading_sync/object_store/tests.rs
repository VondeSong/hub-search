use super::*;
use base64::Engine as _;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

#[derive(Default)]
pub(crate) struct Objects {
    pub(crate) files: BTreeMap<String, Vec<u8>>,
    directories: std::collections::BTreeSet<String>,
    pub(crate) gets: BTreeMap<String, usize>,
    pub(crate) lose_ack: bool,
    pub(crate) escape: bool,
    pub(crate) partial: bool,
    pub(crate) deny_put: bool,
}
pub(crate) struct Server {
    pub(crate) url: String,
    pub(crate) state: Arc<Mutex<Objects>>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
pub(crate) async fn server() -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let state = Arc::new(Mutex::new(Objects::default()));
    state.lock().unwrap().directories.insert("/dav/".into());
    let shared = state.clone();
    let task = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut data = Vec::new();
            let mut chunk = [0; 8192];
            let end = loop {
                let n = socket.read(&mut chunk).await.unwrap();
                if n == 0 {
                    break 0;
                }
                data.extend_from_slice(&chunk[..n]);
                if let Some(i) = data.windows(4).position(|v| v == b"\r\n\r\n") {
                    break i + 4;
                }
            };
            if end == 0 {
                continue;
            }
            let headers = String::from_utf8_lossy(&data[..end]).into_owned();
            let mut lines = headers.lines();
            let first = lines.next().unwrap();
            let parts: Vec<_> = first.split_whitespace().collect();
            let method = parts[0].to_string();
            let path = Url::parse(&format!("http://127.0.0.1{}", parts[1]))
                .unwrap()
                .path()
                .to_string();
            let mut size = 0;
            let mut conditional = false;
            let mut authorized = false;
            for line in lines {
                if let Some((k, v)) = line.split_once(':') {
                    match k.to_ascii_lowercase().as_str() {
                        "content-length" => size = v.trim().parse::<usize>().unwrap(),
                        "if-none-match" => conditional = v.trim() == "*",
                        "authorization" => authorized = v.trim().starts_with("Basic "),
                        _ => {}
                    }
                }
            }
            assert!(
                authorized,
                "test server requires synthetic Basic credentials"
            );
            while data.len() < end + size {
                let n = socket.read(&mut chunk).await.unwrap();
                if n == 0 {
                    break;
                }
                data.extend_from_slice(&chunk[..n]);
            }
            let (status, body, length, lose) = {
                let mut s = shared.lock().unwrap();
                match method.as_str() {
                    "GET" | "HEAD" => {
                        if method == "GET" {
                            *s.gets.entry(path.clone()).or_default() += 1;
                        }
                        match s.files.get(&path) {
                            Some(v) => (
                                200,
                                if method == "HEAD" { vec![] } else { v.clone() },
                                v.len(),
                                false,
                            ),
                            None => (404, vec![], 0, false),
                        }
                    }
                    "MKCOL" => {
                        if s.directories.contains(&path) {
                            (405, vec![], 0, false)
                        } else {
                            s.directories.insert(path.clone());
                            (201, vec![], 0, false)
                        }
                    }
                    "PUT" => {
                        if s.deny_put {
                            (403, vec![], 0, false)
                        } else if conditional && s.files.contains_key(&path) {
                            (412, vec![], 0, false)
                        } else {
                            let bytes = data[end..end + size].to_vec();
                            s.files.insert(path.clone(), bytes);
                            let lose = s.lose_ack;
                            s.lose_ack = false;
                            (201, vec![], 0, lose)
                        }
                    }
                    "DELETE" => {
                        s.files.remove(&path);
                        (204, vec![], 0, false)
                    }
                    "PROPFIND" => {
                        if !s.directories.contains(&path) {
                            (404, vec![], 0, false)
                        } else {
                            let mut entries = vec![(path.clone(), true)];
                            for d in &s.directories {
                                if let Some(child) = d.strip_prefix(&path) {
                                    if !child.is_empty()
                                        && !child.trim_end_matches('/').contains('/')
                                    {
                                        entries.push((d.clone(), true));
                                    }
                                }
                            }
                            for k in s.files.keys() {
                                if let Some(child) = k.strip_prefix(&path) {
                                    if !child.is_empty() && !child.contains('/') {
                                        entries.push((k.clone(), false));
                                    }
                                }
                            }
                            if s.escape {
                                entries.push(("https://outside.invalid/secret".into(), false));
                            }
                            let mut xml = "<?xml version=\"1.0\"?><d:multistatus xmlns:d=\"DAV:\">"
                                .to_string();
                            for (href, dir) in entries {
                                xml.push_str(&format!("<d:response><d:href>{href}</d:href><d:propstat><d:prop><d:resourcetype>{}</d:resourcetype></d:prop><d:status>HTTP/1.1 {}</d:status></d:propstat></d:response>",if dir{"<d:collection/>"}else{""},if s.partial{"403 Forbidden"}else{"200 OK"}));
                            }
                            xml.push_str("</d:multistatus>");
                            let bytes = xml.into_bytes();
                            let len = bytes.len();
                            (207, bytes, len, false)
                        }
                    }
                    _ => (400, vec![], 0, false),
                }
            };
            if lose {
                continue;
            }
            let response = format!(
                "HTTP/1.1 {status} Test\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n"
            );
            let _ = socket.write_all(response.as_bytes()).await;
            let _ = socket.write_all(&body).await;
        }
    });
    Server {
        url: format!("http://{address}/dav/"),
        state,
        task,
    }
}
pub(crate) fn remote(s: &Server) -> WebdavStore {
    WebdavStore::new(
        &s.url,
        "test-account".into(),
        "synthetic-test-password".into(),
    )
    .unwrap()
}
pub(crate) fn config(s: &Server) -> Configuration {
    Configuration::Webdav {
        url: s.url.clone(),
        username: "test-account".into(),
    }
}
pub(crate) const KEY: &str = "telegram:test-account:media";
pub(crate) const URL: &str = "https://example.invalid/picture.png";
pub(crate) struct Device {
    pub(crate) root: PathBuf,
    pub(crate) db: PathBuf,
}
impl Device {
    pub(crate) fn new(s: &Server) -> Self {
        let root =
            std::env::temp_dir().join(format!("hub-reading-webdav-test-{}", random_url_safe(10)));
        fs::create_dir(&root).unwrap();
        let db = root.join("hub.sqlite3");
        let c = open_database(&db).unwrap();
        x_bookmarks::storage::schema(&c).unwrap();
        for (k, v) in [
            ("flashcard_cloud_provider", "webdav"),
            ("flashcard_webdav_url", s.url.as_str()),
            ("flashcard_webdav_username", "test-account"),
            ("cloud_sync_enabled", "1"),
            ("cloud_sync_reading", "1"),
        ] {
            meta(&c, k, v).unwrap();
        }
        meta(&c,"reading_media_policy",r#"{"enabled":true,"download":"all","imageMb":10,"documentMb":20,"batchMb":64,"dailyMb":256,"cacheMb":512}"#).unwrap();
        Self { root, db }
    }
    pub(crate) fn c(&self) -> Connection {
        open_database(&self.db).unwrap()
    }
    pub(crate) fn seed(&self) {
        x_bookmarks::reading_sync_test_import_managed(
            &mut self.c(),
            Post {
                id: "media".into(),
                text: "WebDAV 正式正文".into(),
                content_status: "full".into(),
                media: vec![crate::collection_models::Media {
                    kind: "photo".into(),
                    url: URL.into(),
                    preview_url: String::new(),
                }],
                ..Post::default()
            },
        );
        let path = self.root.join("source.png");
        fs::write(&path, png()).unwrap();
        x_bookmarks::storage::record_saved_media(&self.c(), KEY, URL, &path).unwrap();
    }
    pub(crate) async fn round(&self, remote: &dyn Store, ns: &str, label: &str) {
        crate::reading_sync::sync_database(&self.db, remote, ns, label)
            .await
            .unwrap();
        crate::reading_sync::media::sync(&self.db, remote, ns, label)
            .await
            .unwrap();
    }
}
impl Drop for Device {
    fn drop(&mut self) {
        forget_initialized_database(&self.db);
        assert_eq!(self.root.parent(), Some(std::env::temp_dir().as_path()));
        assert!(self
            .root
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("hub-reading-webdav-test-"));
        let _ = fs::remove_dir_all(&self.root);
    }
}
pub(crate) fn png() -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE+0AAAAASUVORK5CYII=").unwrap()
}

#[tokio::test]
async fn reading_webdav_formal_producer_restores_body_and_original_without_library_writes() {
    let s = server().await;
    let remote = remote(&s);
    let ns = config(&s).namespace();
    let a = Device::new(&s);
    let b = Device::new(&s);
    a.seed();
    a.round(&remote, &ns, "a").await;
    b.round(&remote, &ns, "b").await;
    let post: String = b
        .c()
        .query_row(
            "SELECT post_json FROM collection_x_items WHERE item_key=?1",
            [KEY],
            |r| r.get(0),
        )
        .unwrap();
    assert!(post.contains("WebDAV 正式正文"));
    let path: String = b
        .c()
        .query_row(
            "SELECT path FROM collection_saved_media WHERE item_key=?1 AND media_url=?2",
            params![KEY, URL],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(fs::read(path).unwrap(), png());
    assert_eq!(fs::read(a.root.join("source.png")).unwrap(), png());
    assert_eq!(
        b.c()
            .query_row("SELECT count(*) FROM collection_library_pending", [], |r| r
                .get::<_, usize>(0))
            .unwrap(),
        0
    );
    let files = s.state.lock().unwrap();
    assert!(files
        .files
        .keys()
        .any(|k| k.contains("reading/v1/changes/")));
    assert!(files
        .files
        .keys()
        .any(|k| k.contains("reading/media-v1/blobs/")));
}
#[tokio::test]
async fn reading_webdav_immutable_readback_lost_ack_and_exact_delete() {
    let s = server().await;
    let remote = remote(&s);
    let key = remote.key("reading/source-v1/test.json");
    s.state.lock().unwrap().lose_ack = true;
    assert!(remote.put_verified(&key, b"original bytes").await.unwrap());
    assert!(!remote.put_verified(&key, b"original bytes").await.unwrap());
    assert!(remote.put_verified(&key, b"changed bytes").await.is_err());
    assert_eq!(
        remote.get(&key, 64).await.unwrap(),
        Some(b"original bytes".to_vec())
    );
    assert!(remote.get(&key, 2).await.is_err());
    assert_eq!(remote.head_size(&key).await.unwrap(), Some(14));
    assert_eq!(
        remote.list("reading/source-v1/").await.unwrap(),
        vec![key.clone()]
    );
    remote.delete_exact(&key).await.unwrap();
    assert!(remote.get(&key, 64).await.unwrap().is_none());
    assert!(remote.delete_exact("v2/../outside").await.is_err());
}
#[tokio::test]
async fn reading_webdav_listing_and_network_fail_closed() {
    let s = server().await;
    let remote = remote(&s);
    let key = remote.key("reading/v1/changes/test.json");
    remote.put_verified(&key, b"{}").await.unwrap();
    s.state.lock().unwrap().escape = true;
    assert!(remote.list("reading/v1/changes/").await.is_err());
    s.state.lock().unwrap().escape = false;
    s.state.lock().unwrap().partial = true;
    assert!(remote.list("reading/v1/changes/").await.is_err());
    let before = s.state.lock().unwrap().gets.clone();
    let blocked = remote.with_network_guard(Arc::new(|| Err("metered network".into())));
    assert!(blocked.get(&key, 10).await.is_err());
    assert!(blocked.put_verified(&key, b"{}").await.is_err());
    assert_eq!(s.state.lock().unwrap().gets, before);
    assert!(WebdavStore::new("http://remote.invalid/dav/", "".into(), "".into()).is_err());
    assert!(WebdavStore::new(
        "https://name:secret@example.invalid/dav/",
        "".into(),
        "".into()
    )
    .is_err());
}
