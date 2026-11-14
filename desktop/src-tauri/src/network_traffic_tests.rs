use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, AtomicUsize};

#[tokio::test]
async fn feishu_media_uses_remote_resource_token_contract() {
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = calls.clone();
    let png = vec![137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0];
    let encoded = STANDARD.encode(&png);
    let server = Server::new(move |request| {
        assert!(request
            .headers
            .to_ascii_lowercase()
            .contains("x-lark-mcp-uat: local-test-token"));
        assert!(request
            .headers
            .to_ascii_lowercase()
            .contains("x-lark-mcp-allowed-tools: get-user,list-docs,fetch-doc,fetch-file"));
        let body: Value = serde_json::from_slice(&request.body).unwrap();
        assert_eq!(body["method"], "tools/call");
        assert_eq!(body["params"]["name"], "fetch-file");
        assert_eq!(
            body["params"]["arguments"],
            json!({"resource_token":"image_123"})
        );
        seen.fetch_add(1, Ordering::SeqCst);
        let mut reply = Reply::new(200, json!({"jsonrpc":"2.0","id":body["id"],"result":{"content":[{"type":"image","mimeType":"image/png","data":encoded}]}}).to_string());
        reply.headers = "Content-Type: application/json\r\n".into();
        reply
    });
    let session = McpSession {
        space_id: "media-test".into(),
        space_name: "media-test".into(),
        endpoint: server.url.to_string(),
        access_token: "local-test-token".into(),
        session_id: None,
        protocol_version: "2025-03-26".into(),
        deep_link_template: None,
        rate_limiter: Arc::new(CraftRateLimiter::default()),
    };
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let payload = fetch_feishu_media(&client, &session, "image_123")
        .await
        .unwrap();
    assert_eq!(payload, (png, "image/png".into()));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

pub(crate) struct Request {
    pub method: String,
    pub path: String,
    pub headers: String,
    pub body: Vec<u8>,
}
pub(crate) struct Reply {
    pub status: u16,
    pub headers: String,
    pub body: Vec<u8>,
    pub chunked: bool,
    pub cut: Option<usize>,
}
impl Reply {
    pub(crate) fn new(status: u16, body: impl Into<Vec<u8>>) -> Self {
        Self {
            status,
            headers: String::new(),
            body: body.into(),
            chunked: false,
            cut: None,
        }
    }
}
pub(crate) struct Server {
    pub url: Url,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Server {
    pub(crate) fn new(mut handler: impl FnMut(Request) -> Reply + Send + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let done = stop.clone();
        let thread = std::thread::spawn(move || {
            while !done.load(Ordering::Relaxed) {
                let Ok((mut socket, _)) = listener.accept() else {
                    std::thread::sleep(Duration::from_millis(5));
                    continue;
                };
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                socket
                    .set_write_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut buffer = Vec::new();
                let mut bytes = [0u8; 8192];
                let header_end = loop {
                    let n = socket.read(&mut bytes).unwrap();
                    if n == 0 {
                        return;
                    }
                    buffer.extend_from_slice(&bytes[..n]);
                    if let Some(n) = buffer.windows(4).position(|s| s == b"\r\n\r\n") {
                        break n + 4;
                    }
                };
                let headers = String::from_utf8_lossy(&buffer[..header_end]).into_owned();
                let size = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .and_then(|s| s.trim().parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                while buffer.len() < header_end + size {
                    let n = socket.read(&mut bytes).unwrap();
                    if n == 0 {
                        break;
                    }
                    buffer.extend_from_slice(&bytes[..n]);
                }
                let first: Vec<_> = headers.lines().next().unwrap().split_whitespace().collect();
                let reply = handler(Request {
                    method: first[0].into(),
                    path: first[1].into(),
                    headers: headers.clone(),
                    body: buffer[header_end..].to_vec(),
                });
                if reply.status == 0 {
                    continue;
                }
                let framing = if reply.chunked {
                    "Transfer-Encoding: chunked".into()
                } else {
                    format!("Content-Length: {}", reply.body.len())
                };
                if write!(
                    socket,
                    "HTTP/1.1 {} Fixture\r\n{}\r\n{}Connection: close\r\n\r\n",
                    reply.status, framing, reply.headers
                )
                .is_err()
                {
                    continue;
                }
                let body = &reply.body[..reply.cut.unwrap_or(reply.body.len())];
                if reply.chunked {
                    for block in body.chunks(8192) {
                        if write!(socket, "{:x}\r\n", block.len())
                            .and_then(|_| socket.write_all(block))
                            .and_then(|_| socket.write_all(b"\r\n"))
                            .is_err()
                        {
                            break;
                        }
                    }
                    if reply.cut.is_none() {
                        let _ = socket.write_all(b"0\r\n\r\n");
                    }
                } else {
                    let _ = socket.write_all(body);
                }
            }
        });
        Self {
            url,
            stop,
            thread: Some(thread),
        }
    }
    pub(crate) fn client() -> reqwest::Client {
        reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap()
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let result = self.thread.take().unwrap().join();
        if !std::thread::panicking() {
            result.unwrap();
        }
    }
}

pub(crate) struct Fixture {
    pub root: PathBuf,
    pub db: PathBuf,
    pub store: BlobStore,
}
impl Fixture {
    pub(crate) fn new(provider: &str) -> Self {
        let root = std::env::temp_dir().join(format!("hub-network-fix-{}", random_url_safe(12)));
        fs::create_dir_all(&root).unwrap();
        let db = root.join("craft-search.sqlite3");
        let c = open_database(&db).unwrap();
        c.execute("INSERT INTO spaces(id,name,mcp_url,added_at) VALUES('space','Fixture','https://example.invalid/mcp',1)",[]).unwrap();
        c.execute("INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES('space',?1,'Fixture',1,1)",[provider]).unwrap();
        c.execute("INSERT INTO documents(space_id,id,title,path,markdown,indexed_at,content_hash,provider) VALUES('space','doc','Title','Title','body',1,'body',?1)",[provider]).unwrap();
        Self {
            store: BlobStore::open(&root.join("blobs")).unwrap(),
            root,
            db,
        }
    }
    pub(crate) fn craft(&self, doc: &str, url: &str, version: &str) {
        let markdown = format!("![file.png]({url})");
        persist_document_batch(&self.db,&self.store,vec![IndexedDocument { space_id:"space".into(),id:doc.into(),title:doc.into(),path:doc.into(),folder_id:None,
            content_hash:format!("{:x}",Sha256::digest(markdown.as_bytes())),markdown,modified_at:Some(10),indexed_at:now_timestamp(),
            attachments:discover_attachments_from_json(&json!({"id":"file","type":"image","fileName":"file.png","url":url,"metadata":{"lastModifiedAt":version}})),block_hints:vec![] }]).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        forget_initialized_database(&self.db);
        fs::remove_dir_all(&self.root).unwrap();
    }
}

#[tokio::test]
async fn network_two_task_writes_preserve_text_and_reuse_canonical_attachment_cache() {
    let f = Fixture::new(PROVIDER_CRAFT);
    let c = open_database(&f.db).unwrap();
    c.execute("INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES('dida','dida365','Dida',1,1)",[]).unwrap();
    c.execute(
        "UPDATE task_sync_settings SET dida_library_id='dida' WHERE id=1",
        [],
    )
    .unwrap();
    drop(c);
    let bytes = b"\x89PNG\r\n\x1a\noriginal";
    let hash = format!("{:x}", Sha256::digest(bytes));
    save_dida_attachment_mapping(
        &f.db,
        "hub-task",
        "dida-task",
        &hash,
        "0123456789abcdef01234567",
        "file.png",
        "image/png",
    )
    .unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let count = requests.clone();
    let server = Server::new(move |_| {
        count.fetch_add(1, Ordering::Relaxed);
        Reply::new(200, bytes.to_vec())
    });
    let client = Server::client();
    for (title, signature) in [("Original", "one"), ("Changed title", "two")] {
        let url = format!("https://r.craft.do/original?X-Amz-Signature={signature}");
        f.craft("doc", &url, "same-version");
        let task = TaskSyncRecord {
            provider: PROVIDER_CRAFT.into(),
            library_id: "space".into(),
            source_space_name: "Fixture".into(),
            source_id: "task".into(),
            parent_source_id: String::new(),
            document_id: "doc".into(),
            parent_page_id: "doc".into(),
            raw_document_id: "doc".into(),
            title: title.into(),
            completed: false,
            start_at: String::new(),
            due_at: String::new(),
            is_all_day: false,
            time_zone: String::new(),
            schedule_date: String::new(),
            deadline_date: String::new(),
            project_id: String::new(),
            content: format!("{title}\n\n![file.png]({url})"),
            description: String::new(),
            tags: vec![],
            is_project_page: false,
        };
        let result = prepare_craft_dida_content(
            None,
            &f.db,
            &f.store,
            &client,
            "hub-task",
            &task,
            "project",
            "dida-task",
            "craft://fixture",
            |_| Ok(server.url.clone()),
        )
        .await
        .unwrap();
        assert!(result.content.contains(title));
        assert!(result.content.contains("0123456789abcdef01234567/file.png"));
        assert!(result.active_blob_hashes.contains(&hash));
    }
    assert_eq!(requests.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn network_dida_ambiguous_ack_and_confirmation_write_failure_use_same_remote_object() {
    for failure in ["lost", "invalid", "receipt"] {
        let f = Fixture::new(PROVIDER_CRAFT);
        let counts = Arc::new(Mutex::new((0, 0)));
        let calls = counts.clone();
        let server = Server::new(move |r| {
            let mut counts = calls.lock().unwrap();
            if r.method == "GET" {
                counts.1 += 1;
                Reply::new(200, b"original".to_vec())
            } else {
                counts.0 += 1;
                Reply::new(
                    if failure == "lost" { 0 } else { 200 },
                    if failure == "invalid" {
                        b"bad-json".to_vec()
                    } else {
                        Vec::new()
                    },
                )
            }
        });
        let client = Server::client();
        let upload = server.url.join("upload/project/task/stable-id").unwrap();
        let readback = server.url.join("file/stable-id").unwrap();
        if failure == "receipt" {
            assert!(matches!(
                upload_intents::admit(&f.db, "schema-init", PROVIDER_DIDA365, "other").unwrap(),
                upload_intents::Admission::Send
            ));
            open_database(&f.db).unwrap().execute_batch("CREATE TRIGGER reject_confirmation BEFORE UPDATE ON attachment_upload_intents WHEN new.status='confirmed' BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END;").unwrap();
        }
        assert!(dida_upload_attachment_once_request(
            &f.db,
            "account",
            &client,
            upload.clone(),
            readback.clone(),
            "cookie-one",
            "stable-id",
            "file.bin",
            "application/octet-stream",
            b"original".to_vec()
        )
        .await
        .is_err());
        if failure == "receipt" {
            open_database(&f.db)
                .unwrap()
                .execute_batch("DROP TRIGGER reject_confirmation")
                .unwrap();
        }
        forget_initialized_database(&f.db);
        dida_upload_attachment_once_request(
            &f.db,
            "account",
            &client,
            upload.clone(),
            readback.clone(),
            "cookie-two",
            "stable-id",
            "file.bin",
            "application/octet-stream",
            b"original".to_vec(),
        )
        .await
        .unwrap();
        dida_upload_attachment_once_request(
            &f.db,
            "account",
            &client,
            upload,
            readback,
            "cookie-three",
            "stable-id",
            "file.bin",
            "application/octet-stream",
            b"original".to_vec(),
        )
        .await
        .unwrap();
        assert_eq!(*counts.lock().unwrap(), (1, 1));
    }
}

#[tokio::test]
async fn network_receive_budget_stops_chunked_success_and_error_bodies() {
    let server = Server::new(|r| {
        let mut reply = Reply::new(
            if r.path.contains("error") { 500 } else { 200 },
            vec![b'x'; 4 * 1024 * 1024],
        );
        reply.chunked = true;
        reply
    });
    let client = Server::client();
    assert!(
        http_body::bytes(client.get(server.url.clone()).send().await.unwrap(), 8192)
            .await
            .unwrap_err()
            .contains("上限")
    );
    let detail = http_body::diagnostic(
        client
            .get(server.url.join("error").unwrap())
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(detail.len(), http_body::DIAGNOSTIC_BYTES);
    let mut reply = Reply::new(200, b"full-tail-content".to_vec());
    reply.chunked = true;
    let valid = Server::new(move |_| Reply {
        status: reply.status,
        headers: String::new(),
        body: reply.body.clone(),
        chunked: true,
        cut: None,
    });
    assert_eq!(
        http_body::text(client.get(valid.url.clone()).send().await.unwrap(), 17)
            .await
            .unwrap(),
        "full-tail-content"
    );
}

#[tokio::test]
async fn network_craft_interrupted_reads_recover_without_replaying_creates() {
    for mode in ["read", "tool-read", "create"] {
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        let server = Server::new(move |request| {
            let payload: Value = serde_json::from_slice(&request.body).unwrap();
            assert_eq!(
                payload["params"]["name"],
                if mode == "create" {
                    "craft_write"
                } else {
                    "craft_read"
                }
            );
            let mut reply = Reply::new(200, json!({"jsonrpc":"2.0","id":payload["id"],"result":{"content":[{"type":"text","text":"complete source"}]}}).to_string());
            if seen.fetch_add(1, Ordering::SeqCst) == 0 {
                reply.cut = Some(8);
            }
            reply
        });
        let session = McpSession {
            space_id: "body-recovery".into(),
            space_name: "Fixture".into(),
            endpoint: server.url.to_string(),
            access_token: "local-test-token".into(),
            session_id: None,
            protocol_version: "2025-03-26".into(),
            deep_link_template: None,
            rate_limiter: Arc::new(CraftRateLimiter::default()),
        };
        let result = if mode == "read" {
            call_craft_read_raw(&Server::client(), &session, "blocks get --id fixture", 1).await
        } else {
            call_craft_tool_raw(&Server::client(), &session,
                if mode == "create" { "craft_write" } else { "craft_read" },
                json!({"command":if mode == "create" { "blocks insert --parent fixture --markdown body" } else { "blocks get --id fixture" }}), 1).await
        };
        if mode == "create" {
            assert_eq!(result.unwrap_err(), "响应读取中断");
            assert_eq!(calls.load(Ordering::SeqCst), 1);
        } else {
            assert_eq!(tool_result_text(&result.unwrap()), "complete source");
            assert_eq!(calls.load(Ordering::SeqCst), 2);
        }
    }
}

#[tokio::test]
async fn network_craft_body_recovery_is_bounded_and_respects_http_status() {
    for status in [200, 403] {
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        let server = Server::new(move |_| {
            seen.fetch_add(1, Ordering::SeqCst);
            let mut reply = Reply::new(status, "响应读取中断 timeout");
            if status == 200 {
                reply.cut = Some(8);
            }
            reply
        });
        let session = McpSession {
            space_id: "bounded-body-recovery".into(),
            space_name: "Fixture".into(),
            endpoint: server.url.to_string(),
            access_token: "local-test-token".into(),
            session_id: None,
            protocol_version: "2025-03-26".into(),
            deep_link_template: None,
            rate_limiter: Arc::new(CraftRateLimiter::default()),
        };
        let error = call_craft_read_raw(&Server::client(), &session, "blocks get --id fixture", 1)
            .await
            .unwrap_err();
        assert_eq!(
            calls.load(Ordering::SeqCst),
            if status == 200 {
                CRAFT_REQUEST_MAX_ATTEMPTS as usize
            } else {
                1
            }
        );
        assert_eq!(craft_transport_error_is_transient(&error), status == 200);
    }
    assert!(!craft_transport_error_is_transient("响应超过接收上限"));
}

#[tokio::test]
async fn network_craft_body_timeout_keeps_its_safe_error_category() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!(
        "http://{}/private?token=must-not-appear",
        listener.local_addr().unwrap()
    );
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut input = [0u8; 8192];
        socket.read(&mut input).unwrap();
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1000000\r\nConnection: close\r\n\r\nx")
            .unwrap();
        let _ = socket.read(&mut input);
    });
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_millis(250))
        .build()
        .unwrap();
    let response = client.get(url).send().await.unwrap();
    let error = http_body::text(response, http_body::MCP_BYTES)
        .await
        .unwrap_err();
    assert_eq!(error, "响应读取超时");
    assert!(craft_transport_error_is_transient(&error));
    assert!(!error.contains("token"));
    tokio::task::spawn_blocking(move || server.join().unwrap())
        .await
        .unwrap();
}

#[tokio::test]
async fn network_dida_unconfirmed_upload_survives_list_move_without_new_post() {
    let f = Fixture::new(PROVIDER_DIDA365);
    let counts = Arc::new(Mutex::new((0, 0)));
    let calls = counts.clone();
    let server = Server::new(move |r| {
        let mut counts = calls.lock().unwrap();
        if r.method == "GET" {
            counts.1 += 1;
            Reply::new(200, b"original".to_vec())
        } else {
            counts.0 += 1;
            Reply::new(0, Vec::new())
        }
    });
    let client = Server::client();
    let first = dida_upload_attachment_once_request(
        &f.db,
        "account",
        &client,
        server.url.join("upload/old-list/task/stable-id").unwrap(),
        server.url.join("file/stable-id").unwrap(),
        "cookie",
        "stable-id",
        "file.bin",
        "application/octet-stream",
        b"original".to_vec(),
    )
    .await;
    assert!(first.is_err());
    forget_initialized_database(&f.db);
    dida_upload_attachment_once_request(
        &f.db,
        "account",
        &client,
        server.url.join("upload/new-list/task/stable-id").unwrap(),
        server.url.join("file/stable-id").unwrap(),
        "new-cookie",
        "stable-id",
        "file.bin",
        "application/octet-stream",
        b"original".to_vec(),
    )
    .await
    .unwrap();
    assert_eq!(*counts.lock().unwrap(), (1, 1));
}

#[tokio::test]
async fn network_slow_error_body_obeys_cancellation_and_releases_connection() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let closed = Arc::new(AtomicBool::new(false));
    let observed = closed.clone();
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut input = [0u8; 8192];
        socket.read(&mut input).unwrap();
        socket
            .write_all(
                b"HTTP/1.1 500 Error\r\nContent-Length: 1000000\r\nConnection: close\r\n\r\nx",
            )
            .unwrap();
        observed.store(socket.read(&mut input).unwrap() == 0, Ordering::Relaxed);
    });
    let cancelled = Arc::new(AtomicBool::new(false));
    let flag = cancelled.clone();
    let timer = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        flag.store(true, Ordering::Relaxed);
    });
    let response = Server::client().get(url).send().await.unwrap();
    let started = std::time::Instant::now();
    let result = http_body::diagnostic_checked(response, || {
        if cancelled.load(Ordering::Relaxed) {
            Err("cancelled".into())
        } else {
            Ok(())
        }
    })
    .await;
    assert_eq!(result.unwrap_err(), "cancelled");
    assert!(started.elapsed() < Duration::from_secs(1));
    timer.join().unwrap();
    tokio::task::spawn_blocking(move || server.join().unwrap())
        .await
        .unwrap();
    assert!(closed.load(Ordering::Relaxed));
}

#[tokio::test]
async fn network_task_cache_reuses_signature_cross_document_and_repairs_corruption() {
    let f = Fixture::new(PROVIDER_CRAFT);
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let server = Server::new(move |_| {
        count.fetch_add(1, Ordering::Relaxed);
        Reply::new(200, b"\x89PNG\r\n\x1a\noriginal".to_vec())
    });
    let client = Server::client();
    for (doc, signature) in [("doc", "first"), ("doc", "second"), ("other", "third")] {
        let url = format!("https://r.craft.do/task-original?X-Amz-Signature={signature}");
        f.craft(doc, &url, "v1");
        let remote = server.url.clone();
        load_cached_attachment_resolving(
            &f.db,
            &f.store,
            PROVIDER_CRAFT,
            "space",
            doc,
            &url,
            &client,
            || Ok(None),
            true,
            move |_| Ok(remote),
            20 * 1024 * 1024,
        )
        .await
        .unwrap();
    }
    assert_eq!(calls.load(Ordering::Relaxed), 1);
    let url = "https://r.craft.do/task-original?X-Amz-Signature=fourth";
    let capture =
        read_preview_download_capture(&f.db, PROVIDER_CRAFT, "space", "doc", url, None).unwrap();
    fs::write(
        f.store
            .path_for(capture.blob_hash.as_ref().unwrap())
            .unwrap(),
        b"corrupt",
    )
    .unwrap();
    load_cached_attachment_resolving(
        &f.db,
        &f.store,
        PROVIDER_CRAFT,
        "space",
        "doc",
        url,
        &client,
        || Ok(None),
        true,
        |_| Ok(server.url.clone()),
        20 * 1024 * 1024,
    )
    .await
    .unwrap();
    assert_eq!(calls.load(Ordering::Relaxed), 2);
    f.craft("doc", url, "v2");
    load_cached_attachment_resolving(
        &f.db,
        &f.store,
        PROVIDER_CRAFT,
        "space",
        "doc",
        url,
        &client,
        || Ok(None),
        true,
        |_| Ok(server.url.clone()),
        20 * 1024 * 1024,
    )
    .await
    .unwrap();
    assert_eq!(calls.load(Ordering::Relaxed), 3);
}

#[test]
fn network_auto_sync_has_one_durable_admission_and_failure_throttle() {
    let f = Fixture::new(PROVIDER_CRAFT);
    let c = open_database(&f.db).unwrap();
    c.execute_batch("INSERT INTO metadata(key,value) VALUES('flashcard_cloud_provider','oss'),('cloud_sync_auto','1'),('cloud_sync_enabled','1'),('flashcard_sync_dirty','1'),('flashcard_oss_config','{\"bucket\":\"test-bucket\",\"region\":\"cn-hangzhou\",\"prefix\":\"HubFlashcards\",\"accessKeyId\":\"EXAMPLE\"}');").unwrap();
    assert!(claim_flashcard_auto_sync_due(&f.db).unwrap());
    assert!(!claim_flashcard_auto_sync_due(&f.db).unwrap());
    record_flashcard_sync_result_in_connection(
        &c,
        now_timestamp(),
        &Err("controlled failure".into()),
    )
    .unwrap();
    assert!(!claim_flashcard_auto_sync_due(&f.db).unwrap());
    c.execute(
        "UPDATE metadata SET value='0' WHERE key='flashcard_sync_last_attempt'",
        [],
    )
    .unwrap();
    assert!(claim_flashcard_auto_sync_due(&f.db).unwrap());
}

#[tokio::test]
async fn network_upload_missing_or_invalid_ack_survives_restart_without_reupload() {
    for status in [0, 200] {
        let f = Fixture::new(PROVIDER_CRAFT);
        let calls = Arc::new(AtomicUsize::new(0));
        let n = calls.clone();
        let server = Server::new(move |_| {
            n.fetch_add(1, Ordering::Relaxed);
            Reply::new(status, b"not json".to_vec())
        });
        let client = Server::client();
        for _ in 0..2 {
            assert!(upload_craft_task_attachment_once(
                &f.db,
                "task",
                &client,
                &server.url,
                "fixture",
                "01234567-89ab-cdef-0123-456789abcdef",
                "image/png",
                b"original".to_vec()
            )
            .await
            .is_err());
            forget_initialized_database(&f.db);
        }
        assert_eq!(calls.load(Ordering::Relaxed), 1);
    }
}

#[tokio::test]
async fn network_confirmed_upload_receipt_handles_caller_save_failure_and_new_content() {
    let f = Fixture::new(PROVIDER_CRAFT);
    let calls = Arc::new(AtomicUsize::new(0));
    let n = calls.clone();
    let id = "01234567-89ab-cdef-0123-456789abcdef";
    let server = Server::new(move |_| {
        n.fetch_add(1, Ordering::Relaxed);
        Reply::new(200, serde_json::to_vec(&json!({"blockId":id})).unwrap())
    });
    let client = Server::client();
    for bytes in [
        b"original".to_vec(),
        b"original".to_vec(),
        b"changed".to_vec(),
    ] {
        assert_eq!(
            upload_craft_task_attachment_once(
                &f.db,
                "task",
                &client,
                &server.url,
                "fixture",
                id,
                "image/png",
                bytes
            )
            .await
            .unwrap(),
            id
        );
        forget_initialized_database(&f.db); // No caller mapping is written; only the durable boundary receipt exists.
    }
    assert_eq!(calls.load(Ordering::Relaxed), 2);
}
