use super::*;
use crate::flashcard_authoring::{import_flashcard_values, resolve_flashcard_drafts_in_connection};
#[path = "flashcard_cloud_sync/resource_tests.rs"]
mod resource_tests;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Default)]
pub(crate) struct Objects {
    pub(crate) files: std::collections::BTreeMap<String, (Vec<u8>, String)>,
    pub(crate) lose_ack: bool,
    pub(crate) puts: usize,
    pub(crate) gets: std::collections::BTreeMap<String, usize>,
    pub(crate) heads: std::collections::BTreeMap<String, usize>,
    pub(crate) list_pages: usize,
    pub(crate) virtual_list_count: Option<usize>,
    pub(crate) fail_list_page: Option<usize>,
    pub(crate) repeat_list_token: bool,
    pub(crate) corrupt: bool,
    pub(crate) truncate_get: Option<usize>,
    pub(crate) grow_get: Option<usize>,
    pub(crate) offline: bool,
    pub(crate) deny_put: bool,
    pub(crate) deny_manifests: bool,
    pub(crate) etags: std::collections::BTreeMap<String, String>,
    deny_media: bool,
}
pub(crate) struct Server {
    pub(crate) url: Url,
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
    let shared = Arc::clone(&state);
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
                if let Some(i) = data.windows(4).position(|p| p == b"\r\n\r\n") {
                    break i + 4;
                }
            };
            if end == 0 {
                continue;
            }
            let headers = String::from_utf8_lossy(&data[..end]);
            let mut lines = headers.lines();
            let first = lines.next().unwrap();
            let parts: Vec<_> = first.split_whitespace().collect();
            let method = parts[0].to_string();
            let target = parts[1].to_string();
            let mut size = 0;
            let mut metadata = String::new();
            let mut signed = false;
            let mut forbid = false;
            for line in lines {
                if let Some((k, v)) = line.split_once(':') {
                    match k.to_ascii_lowercase().as_str() {
                        "content-length" => size = v.trim().parse::<usize>().unwrap(),
                        "x-oss-meta-sha256" => metadata = v.trim().into(),
                        "authorization" => signed = v.trim().starts_with("OSS4-HMAC-SHA256"),
                        "x-oss-forbid-overwrite" => forbid = v.trim() == "true",
                        _ => {}
                    }
                }
            }
            assert!(signed || target.starts_with("/rollback/"));
            while data.len() < end + size {
                let n = socket.read(&mut chunk).await.unwrap();
                if n == 0 {
                    break;
                }
                data.extend_from_slice(&chunk[..n]);
            }
            let url = Url::parse(&format!("http://127.0.0.1{target}")).unwrap();
            let key = url.path().trim_start_matches('/').to_string();
            let etag;
            let (status, body, hash, length, lose) = {
                let mut s = shared.lock().unwrap();
                etag = s.etags.get(&key).cloned();
                if method == "GET" && url.query().is_none() {
                    *s.gets.entry(key.clone()).or_default() += 1;
                }
                if method == "HEAD" {
                    *s.heads.entry(key.clone()).or_default() += 1;
                }
                if s.offline {
                    (503, vec![], String::new(), 0, false)
                } else {
                    match method.as_str() {
                        "GET" if url.query().is_some() => {
                            s.list_pages += 1;
                            let query: HashMap<_, _> = url.query_pairs().into_owned().collect();
                            let prefix = &query["prefix"];
                            let offset = query
                                .get("continuation-token")
                                .and_then(|v| v.parse::<usize>().ok())
                                .unwrap_or(0);
                            if s.fail_list_page == Some(s.list_pages) {
                                (503, vec![], String::new(), 0, false)
                            } else {
                                // The history-scale endpoint generates only its current
                                // page. The test server must not hide a production peak
                                // behind its own all-history key Vec.
                                let (keys, total, page_size) =
                                    if let Some(total) = s.virtual_list_count {
                                        let end = (offset + 1000).min(total);
                                        (
                                            (offset..end)
                                                .map(|index| {
                                                    format!(
                                                        "{prefix}virtual-{index:06}-{}.json",
                                                        "a".repeat(64)
                                                    )
                                                })
                                                .collect::<Vec<_>>(),
                                            total,
                                            1000,
                                        )
                                    } else {
                                        let all: Vec<_> = s
                                            .files
                                            .keys()
                                            .filter(|k| k.starts_with(prefix))
                                            .cloned()
                                            .collect();
                                        let total = all.len();
                                        (all.into_iter().skip(offset).take(2).collect(), total, 2)
                                    };
                                let next = (offset + page_size).min(total);
                                let mut xml = format!(
                                    "<ListBucketResult><IsTruncated>{}</IsTruncated>",
                                    next < total
                                );
                                for key in keys {
                                    xml.push_str(&format!("<Contents><Key>{key}</Key></Contents>"));
                                }
                                if next < total {
                                    let token = if s.repeat_list_token {
                                        "repeat".to_string()
                                    } else {
                                        next.to_string()
                                    };
                                    xml.push_str(&format!(
                                        "<NextContinuationToken>{token}</NextContinuationToken>"
                                    ));
                                }
                                xml.push_str("</ListBucketResult>");
                                let bytes = xml.into_bytes();
                                let len = bytes.len();
                                (200, bytes, String::new(), len, false)
                            }
                        }
                        "GET" | "HEAD" => match s.files.get(&key) {
                            Some((bytes, hash)) => {
                                let mut body = if method == "HEAD" {
                                    vec![]
                                } else {
                                    bytes.clone()
                                };
                                if let Some(limit) = s.truncate_get {
                                    body.truncate(limit);
                                }
                                if s.corrupt && !body.is_empty() {
                                    body[0] ^= 1;
                                }
                                if method == "GET" {
                                    if let Some(size) = s.grow_get {
                                        body.resize(size, 42);
                                    }
                                }
                                (
                                    200,
                                    body,
                                    hash.clone(),
                                    if method == "GET" {
                                        s.grow_get.unwrap_or(bytes.len())
                                    } else {
                                        bytes.len()
                                    },
                                    false,
                                )
                            }
                            None => (404, vec![], String::new(), 0, false),
                        },
                        "PUT" => {
                            assert!(forbid);
                            s.puts += 1;
                            if s.deny_put
                                || (s.deny_media && key.contains("/media/"))
                                || (s.deny_manifests && key.contains("/media-v1/manifests/"))
                            {
                                (403, vec![], String::new(), 0, false)
                            } else if s.files.contains_key(&key) {
                                (409, vec![], String::new(), 0, false)
                            } else {
                                s.files
                                    .insert(key, (data[end..end + size].to_vec(), metadata));
                                let lose = s.lose_ack;
                                s.lose_ack = false;
                                (200, vec![], String::new(), 0, lose)
                            }
                        }
                        _ => (405, vec![], String::new(), 0, false),
                    }
                }
            };
            if lose {
                continue;
            }
            let metadata = if hash.is_empty() {
                String::new()
            } else {
                format!("x-oss-meta-sha256: {hash}\r\n")
            };
            let etag = etag.map(|v| format!("ETag: {v}\r\n")).unwrap_or_default();
            let response=format!("HTTP/1.1 {status} Test\r\nContent-Length: {length}\r\n{metadata}{etag}Connection: close\r\n\r\n");
            let _ = socket.write_all(response.as_bytes()).await;
            let _ = socket.write_all(&body).await;
        }
    });
    Server {
        url: Url::parse(&format!("http://{address}/")).unwrap(),
        state,
        task,
    }
}
fn config() -> OssConfig {
    OssConfig {
        bucket: "test-bucket".into(),
        region: "cn-hangzhou".into(),
        prefix: "HubFlashcards".into(),
        access_key_id: "EXAMPLE".into(),
    }
}
pub(crate) fn store(server: &Server) -> OssStore {
    OssStore::new(config(), "synthetic-test-secret".into())
        .unwrap()
        .with_test_endpoint(server.url.clone())
}
fn device(label: &str) -> (PathBuf, BlobStore) {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../artifacts/cloud-sync-20261002/rust-cases")
        .join(format!("{label}-{}", random_url_safe(8)));
    fs::create_dir_all(&root).unwrap();
    (
        root.join("craft-search.sqlite3"),
        BlobStore::open(&root.join("blobs-v1")).unwrap(),
    )
}
fn pending_count(db: &PathBuf) -> i64 {
    let c = open_database(db).unwrap();
    c.query_row(
        "SELECT COUNT(*) FROM flashcard_cloud_uploads WHERE status='pending'",
        [],
        |r| r.get(0),
    )
    .unwrap()
}

#[test]
fn fsrs_protocol_upgrade_is_published_without_record_edits() {
    let (path, _) = device("fsrs-protocol");
    let c = open_database(&path).unwrap();
    ensure_journal(&c).unwrap();
    let mut old = local_flashcard_snapshot(&c).unwrap();
    old.version = 2;
    c.execute(
        "INSERT INTO flashcard_cloud_baselines(namespace,payload) VALUES(?1,?2)",
        params![config().namespace(), serde_json::to_string(&old).unwrap()],
    )
    .unwrap();
    stage(&c, &config().namespace(), false).unwrap();
    let body: Vec<u8> = c
        .query_row(
            "SELECT body FROM flashcard_cloud_uploads WHERE status='pending'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let change: Change = serde_json::from_slice(&body).unwrap();
    assert_eq!(change.version, 4); // Old clients reject the envelope before aggregation.
    assert_eq!(change.snapshot.version, 4);
    assert!(!change.checkpoint);
    assert!(change.snapshot.cards.is_empty());
}

#[tokio::test]
async fn fsrs_review_state_round_trips_through_oss_change_objects() {
    let server = server().await;
    let (a, blobs_a) = device("fsrs-oss-a");
    let (b, blobs_b) = device("fsrs-oss-b");
    let c = open_database(&a).unwrap();
    c.execute("INSERT INTO flashcard_decks(id,name,created_at,updated_at) VALUES('fsrs-deck','FSRS',10,10)",[]).unwrap();
    c.execute("INSERT INTO flashcards(id,deck_id,question,answer,created_at,updated_at,due_at) VALUES('fsrs-card','fsrs-deck','Q','A',10,10,10)",[]).unwrap();
    let wire =
        serde_json::to_value(flashcard_scheduler::preview(&c, "fsrs-card", 1000).unwrap()).unwrap();
    let first = flashcard_scheduler::commit(
        &c,
        "fsrs-card",
        3,
        None,
        wire["reviewKey"].as_str().unwrap(),
        1000,
    )
    .unwrap();
    drop(c);
    for (path, blobs) in [(&a, &blobs_a), (&b, &blobs_b)] {
        sync_database(
            &store(&server),
            path,
            blobs,
            &config().namespace(),
            true,
            false,
        )
        .await
        .unwrap();
    }
    let c = open_database(&b).unwrap();
    let received = local_flashcard_snapshot(&c).unwrap();
    assert_eq!(received.cards[0].due_at, first.card.due_at);
    assert_eq!(received.reviews[0].scheduler_version, 1);
    let wire = serde_json::to_value(
        flashcard_scheduler::preview(&c, "fsrs-card", 1000 + 3 * 86400).unwrap(),
    )
    .unwrap();
    flashcard_scheduler::commit(
        &c,
        "fsrs-card",
        2,
        None,
        wire["reviewKey"].as_str().unwrap(),
        1000 + 3 * 86400,
    )
    .unwrap();
    let expected = local_flashcard_snapshot(&c).unwrap();
    drop(c);
    for (path, blobs) in [(&b, &blobs_b), (&a, &blobs_a)] {
        sync_database(
            &store(&server),
            path,
            blobs,
            &config().namespace(),
            true,
            false,
        )
        .await
        .unwrap();
    }
    let actual = local_flashcard_snapshot(&open_database(&a).unwrap()).unwrap();
    assert_eq!(
        actual.cards[0].fsrs_state_json,
        expected.cards[0].fsrs_state_json
    );
    assert_eq!(actual.cards[0].due_at, expected.cards[0].due_at);
    assert_eq!(actual.reviews.len(), 2);
    let state = server.state.lock().unwrap();
    for (key, (body, _)) in &state.files {
        if key.contains("changes/") {
            let change: Change = serde_json::from_slice(body).unwrap();
            assert_eq!(change.version, 4);
            assert_eq!(change.snapshot.version, 4);
        }
    }
}

#[tokio::test]
async fn fsrs_offline_reviews_upload_before_failed_media_and_resume_after_restart() {
    let server = server().await;
    let (a, blobs_a) = device("events-offline-a");
    let (b, blobs_b) = device("events-offline-b");
    let bytes=b"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\"><rect width=\"20\" height=\"20\" fill=\"red\"/></svg>";
    let blob = blobs_a.put(bytes).unwrap();
    {
        let c = open_database(&a).unwrap();
        c.execute("INSERT INTO flashcard_decks(id,name,created_at,updated_at) VALUES('d','Offline',10,10)",[]).unwrap();
        c.execute("INSERT INTO flashcards(id,deck_id,question,answer,media_json,created_at,updated_at,due_at)
            VALUES('c','d','Q','A',?1,10,10,10)",[json!([{"url":media_protocol_url(&blob.hash),"mimeType":"image/svg+xml"}]).to_string()]).unwrap();
        let p = serde_json::to_value(flashcard_scheduler::preview(&c, "c", 1000).unwrap()).unwrap();
        flashcard_scheduler::commit(&c, "c", 3, None, p["reviewKey"].as_str().unwrap(), 1000)
            .unwrap();
    }
    server.state.lock().unwrap().offline = true;
    assert!(sync_database(
        &store(&server),
        &a,
        &blobs_a,
        &config().namespace(),
        true,
        false
    )
    .await
    .is_err());
    assert_eq!(pending_count(&a), 1);
    {
        let c = open_database(&a).unwrap();
        let p = serde_json::to_value(flashcard_scheduler::preview(&c, "c", 2000).unwrap()).unwrap();
        flashcard_scheduler::commit(&c, "c", 2, None, p["reviewKey"].as_str().unwrap(), 2000)
            .unwrap();
        assert_eq!(local_flashcard_snapshot(&c).unwrap().reviews.len(), 2);
    }
    {
        let mut state = server.state.lock().unwrap();
        state.offline = false;
        state.deny_media = true;
    }
    assert!(sync_database(
        &store(&server),
        &a,
        &blobs_a,
        &config().namespace(),
        true,
        false
    )
    .await
    .is_err());
    assert_eq!(
        pending_count(&a),
        0,
        "review objects were acknowledged even though the attachment failed"
    );
    let queue_count = |path: &PathBuf| {
        open_database(path)
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM flashcard_cloud_media_queue",
                [],
                |r| r.get::<_, i64>(0),
            )
            .unwrap()
    };
    assert_eq!(queue_count(&a), 1);
    sync_database(
        &store(&server),
        &b,
        &blobs_b,
        &config().namespace(),
        false,
        false,
    )
    .await
    .unwrap();
    let received = local_flashcard_snapshot(&open_database(&b).unwrap()).unwrap();
    assert_eq!(received.reviews.len(), 2);
    assert_eq!(received.scheduler_profiles[0].parameters.len(), 21);
    let local = local_flashcard_snapshot(&open_database(&a).unwrap()).unwrap();
    assert_eq!(
        received.cards[0].fsrs_state_json,
        local.cards[0].fsrs_state_json
    );
    forget_initialized_database(&a);
    server.state.lock().unwrap().deny_media = false;
    sync_database(
        &store(&server),
        &a,
        &blobs_a,
        &config().namespace(),
        true,
        false,
    )
    .await
    .unwrap();
    assert_eq!(queue_count(&a), 0);
    sync_database(
        &store(&server),
        &b,
        &blobs_b,
        &config().namespace(),
        true,
        false,
    )
    .await
    .unwrap();
    assert_eq!(blobs_b.read(&blob.hash).unwrap(), bytes);
    assert_eq!(
        local_flashcard_snapshot(&open_database(&a).unwrap())
            .unwrap()
            .reviews
            .len(),
        2
    );
}

#[tokio::test]
async fn connection_probe_checks_write_permission_on_every_run() {
    let server = server().await;
    let remote = store(&server);
    probe_connection(&remote).await.unwrap();
    probe_connection(&remote).await.unwrap();
    {
        let mut state = server.state.lock().unwrap();
        assert_eq!(state.puts, 2);
        assert_eq!(state.files.len(), 2);
        state.deny_put = true;
    }
    assert!(probe_connection(&remote).await.is_err());
    assert_eq!(server.state.lock().unwrap().files.len(), 2);
}

#[test]
fn same_second_deck_folder_and_setting_edits_converge() {
    let (a, _) = device("same-second-a");
    let (b, _) = device("same-second-b");
    let mut ca = open_database(&a).unwrap();
    let mut cb = open_database(&b).unwrap();
    ca.execute("INSERT INTO flashcard_deck_folders(id,name,sort_order,created_at,updated_at) VALUES('folder-shared','共享',0,100,100)",[]).unwrap();
    ca.execute("INSERT INTO flashcard_decks(id,name,folder_id,sort_order,created_at,updated_at) VALUES('deck-shared','共享牌组','folder-shared',0,100,100)",[]).unwrap();
    merge_flashcard_snapshot(&mut cb, &local_flashcard_snapshot(&ca).unwrap()).unwrap();
    for (c, name, limit) in [(&ca, "A", 10), (&cb, "B", 50)] {
        c.execute(
            "UPDATE flashcard_deck_folders SET name=?1,updated_at=200",
            params![name],
        )
        .unwrap();
        c.execute(
            "UPDATE flashcard_decks SET name=?1,updated_at=200",
            params![name],
        )
        .unwrap();
        meta(c, "flashcard_daily_new_limit", &limit.to_string()).unwrap();
        meta(c, "flashcard_daily_new_limit_updated_at", "200").unwrap();
    }
    let sa = local_flashcard_snapshot(&ca).unwrap();
    let sb = local_flashcard_snapshot(&cb).unwrap();
    merge_flashcard_snapshot(&mut ca, &sb).unwrap();
    merge_flashcard_snapshot(&mut cb, &sa).unwrap();
    assert_eq!(
        content_identity(&local_flashcard_snapshot(&ca).unwrap()).unwrap(),
        content_identity(&local_flashcard_snapshot(&cb).unwrap()).unwrap()
    );
}

#[tokio::test]
async fn journal_roundtrip_survives_lost_ack_and_restarts_and_restores_inbox_media() {
    let server = server().await;
    let remote = store(&server);
    let (a, blobs_a) = device("oss-a");
    let (b, blobs_b) = device("oss-b");
    let bytes = b"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"40\" height=\"40\"><rect width=\"40\" height=\"40\" fill=\"blue\"/></svg>";
    let blob = blobs_a.put(bytes).unwrap();
    import_flashcard_values(&a,"manual","收件箱".into(),json!({"source":"manual"}),vec![json!({"question":"附件说明什么？","answer":"证据","media":[{"url":media_protocol_url(&blob.hash),"mimeType":"image/svg+xml","title":"证据.svg"}]})],true).unwrap();
    server.state.lock().unwrap().lose_ack = true;
    sync_database(&remote, &a, &blobs_a, &config().namespace(), true, false)
        .await
        .unwrap();
    let puts = server.state.lock().unwrap().puts;
    assert_eq!(pending_count(&a), 0);
    sync_database(
        &store(&server),
        &a,
        &blobs_a,
        &config().namespace(),
        true,
        false,
    )
    .await
    .unwrap();
    assert_eq!(server.state.lock().unwrap().puts, puts);
    sync_database(
        &store(&server),
        &b,
        &blobs_b,
        &config().namespace(),
        false,
        false,
    )
    .await
    .unwrap();
    let c = open_database(&b).unwrap();
    let snapshot = local_flashcard_snapshot(&c).unwrap();
    assert_eq!(snapshot.drafts.len(), 1);
    let report: Value =
        serde_json::from_str(&metadata_string(&c, "flashcard_cloud_report")).unwrap();
    assert_eq!(report["pendingMedia"], 1);
    assert!(!blobs_b.path_for(&blob.hash).unwrap().exists());
    drop(c);
    // Publishing the imported content on a later run must not bypass on-demand policy.
    sync_database(
        &store(&server),
        &b,
        &blobs_b,
        &config().namespace(),
        false,
        false,
    )
    .await
    .unwrap();
    assert!(!blobs_b.path_for(&blob.hash).unwrap().exists());
    sync_database(
        &store(&server),
        &b,
        &blobs_b,
        &config().namespace(),
        true,
        false,
    )
    .await
    .unwrap();
    assert_eq!(blobs_b.read(&blob.hash).unwrap(), bytes);
    let c = open_database(&b).unwrap();
    assert_eq!(
        c.query_row(
            "SELECT mime_type FROM blobs WHERE hash=?1",
            params![blob.hash],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "image/svg+xml"
    );
    assert!(server.state.lock().unwrap().list_pages >= 4);
}

#[tokio::test]
async fn offline_queue_is_stable_and_corrupt_remote_does_not_advance_applied() {
    let server = server().await;
    let remote = store(&server);
    let (db, blobs) = device("offline-queue");
    let c = open_database(&db).unwrap();
    stage(&c, &config().namespace(), false).unwrap();
    let id: String = c
        .query_row("SELECT id FROM flashcard_cloud_uploads", [], |r| r.get(0))
        .unwrap();
    stage(&c, &config().namespace(), false).unwrap();
    assert_eq!(pending_count(&db), 1);
    drop(c);
    server.state.lock().unwrap().offline = true;
    assert!(
        sync_database(&remote, &db, &blobs, &config().namespace(), true, false)
            .await
            .is_err()
    );
    assert_eq!(pending_count(&db), 1);
    server.state.lock().unwrap().offline = false;
    sync_database(&remote, &db, &blobs, &config().namespace(), true, false)
        .await
        .unwrap();
    let c = open_database(&db).unwrap();
    assert_eq!(
        c.query_row("SELECT id FROM flashcard_cloud_uploads LIMIT 1", [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap(),
        id
    );
    drop(c);
    let (fresh, fresh_blobs) = device("corrupt-read");
    server.state.lock().unwrap().corrupt = true;
    let result = sync_database(
        &store(&server),
        &fresh,
        &fresh_blobs,
        &config().namespace(),
        true,
        false,
    )
    .await;
    assert!(result.is_err());
    let c = open_database(&fresh).unwrap();
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM flashcard_cloud_applied", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn object_listing_drains_multiple_full_pages_and_tail() {
    let server = server().await;
    let remote = store(&server);
    for index in 0..5 {
        let key = remote.key(&format!("changes/sample-{index}.json"));
        remote
            .put_verified(&key, format!("sample-{index}").as_bytes())
            .await
            .unwrap();
    }
    let keys = remote.list("changes/").await.unwrap();
    assert_eq!(keys.len(), 5);
    assert_eq!(server.state.lock().unwrap().list_pages, 3);
}

#[tokio::test]
async fn two_offline_acceptances_converge_and_incremental_edits_keep_the_deck() {
    let server = server().await;
    let ns = config().namespace();
    let (a, ba) = device("accept-a");
    let (b, bb) = device("accept-b");
    import_flashcard_values(
        &a,
        "manual",
        "学习".into(),
        json!({"source":"manual"}),
        vec![json!({"question":"为什么要验证？","answer":"防止丢失"})],
        true,
    )
    .unwrap();
    sync_database(&store(&server), &a, &ba, &ns, true, false)
        .await
        .unwrap();
    sync_database(&store(&server), &b, &bb, &ns, true, false)
        .await
        .unwrap();
    for (db, name) in [(&a, "A"), (&b, "B")] {
        let mut c = open_database(db).unwrap();
        let id = flashcard_sync_drafts::identity(&local_flashcard_snapshot(&c).unwrap().drafts[0])
            .to_string();
        let deck = ensure_flashcard_deck(&c, name).unwrap();
        resolve_flashcard_drafts_in_connection(&mut c, vec![id], true, Some(deck)).unwrap();
        // Deliberately cross creation seconds; wall-clock coincidence used to
        // hide the missing created_at update in the snapshot conflict winner.
        c.execute(
            "UPDATE flashcards SET created_at=?1",
            [if name == "A" { 100 } else { 101 }],
        )
        .unwrap();
    }
    for (db, blobs) in [(&a, &ba), (&b, &bb), (&a, &ba), (&b, &bb)] {
        sync_database(&store(&server), db, blobs, &ns, true, false)
            .await
            .unwrap();
    }
    let c = open_database(&a).unwrap();
    let before = local_flashcard_snapshot(&c).unwrap();
    assert_eq!(before.cards.len(), 1);
    let other = local_flashcard_snapshot(&open_database(&b).unwrap()).unwrap();
    assert_eq!(
        serde_json::to_value(&before.cards).unwrap(),
        serde_json::to_value(&other.cards).unwrap()
    );
    c.execute(
        "UPDATE flashcards SET question='修改后的问题',updated_at=updated_at+10",
        [],
    )
    .unwrap();
    mark_flashcard_sync_dirty(&c).unwrap();
    drop(c);
    sync_database(&store(&server), &a, &ba, &ns, true, false)
        .await
        .unwrap();
    sync_database(&store(&server), &b, &bb, &ns, true, false)
        .await
        .unwrap();
    let after = local_flashcard_snapshot(&open_database(&b).unwrap()).unwrap();
    assert_eq!(after.cards[0].deck_id, before.cards[0].deck_id);
    assert_eq!(after.cards[0].question, "修改后的问题");
    assert!(!after.decks.iter().any(|d| d.name == "同步闪卡"));
}

#[tokio::test]
async fn recovery_handles_review_before_card_and_repeated_checkpoints() {
    let server = server().await;
    let remote = store(&server);
    let (source, _) = device("order-source");
    let (target, blobs) = device("order-target");
    import_flashcard_values(
        &source,
        "manual",
        "复习".into(),
        json!({"source":"manual"}),
        vec![json!({"question":"复习顺序？","answer":"事件不可丢"})],
        false,
    )
    .unwrap();
    let mut c = open_database(&source).unwrap();
    let ids = local_flashcard_snapshot(&c)
        .unwrap()
        .drafts
        .iter()
        .map(|d| flashcard_sync_drafts::identity(d).to_string())
        .collect();
    let deck = ensure_flashcard_deck(&c, "复习").unwrap();
    resolve_flashcard_drafts_in_connection(&mut c, ids, true, Some(deck)).unwrap();
    let full = local_flashcard_snapshot(&c).unwrap();
    drop(c);
    let card = &full.cards[0];
    let mut review = full.clone();
    review.cards.clear();
    review.decks.clear();
    review.folders.clear();
    review.reviews = vec![FlashcardSnapshotReview {
        id: "review-before-card".into(),
        scheduler_profile_id: String::new(),
        scheduler_version: 0,
        previous_fsrs_state_json: String::new(),
        card_id: card.id.clone(),
        rating: 3,
        reviewed_at: card.created_at + 1,
        previous_due_at: card.due_at,
        next_due_at: card.created_at + 86401,
        previous_interval_days: 0.0,
        next_interval_days: 1.0,
        elapsed_ms: None,
        previous_ease: None,
        previous_repetitions: None,
        previous_lapses: None,
    }];
    for (name, snapshot) in [
        ("a-review", review),
        ("z-card", full.clone()),
        ("zz-checkpoint", full),
    ] {
        let body = serde_json::to_vec(&Change {
            format: "hub-flashcard-changes".into(),
            version: 2,
            checkpoint: true,
            snapshot,
        })
        .unwrap();
        remote
            .put_verified(
                &remote.key(&format!("changes/{name}-{:x}.json", Sha256::digest(&body))),
                &body,
            )
            .await
            .unwrap();
    }
    sync_database(
        &store(&server),
        &target,
        &blobs,
        &config().namespace(),
        true,
        false,
    )
    .await
    .unwrap();
    let snapshot = local_flashcard_snapshot(&open_database(&target).unwrap()).unwrap();
    assert_eq!(snapshot.cards.len(), 1);
    assert_eq!(snapshot.reviews.len(), 1);
    assert_eq!(snapshot.cards[0].repetitions, 1);
    sync_database(
        &store(&server),
        &target,
        &blobs,
        &config().namespace(),
        true,
        false,
    )
    .await
    .unwrap();
    assert_eq!(
        local_flashcard_snapshot(&open_database(&target).unwrap())
            .unwrap()
            .reviews
            .len(),
        1
    );
}

#[tokio::test]
async fn unchanged_sync_skips_own_log_reads_and_received_record_echoes() {
    let server = server().await;
    let ns = config().namespace();
    let (a, blobs_a) = device("no-echo-a");
    let (b, blobs_b) = device("no-echo-b");
    import_flashcard_values(&a, "manual", "学习".into(), json!({"source":"manual"}),
        vec![json!({"question":"是否再次上传收到的卡片？","answer":"云端已经存在的完整记录无需回传"})], true).unwrap();
    sync_database(&store(&server), &a, &blobs_a, &ns, true, false)
        .await
        .unwrap();
    // A new object gets an absence probe and PUT readback, never an own-log replay.
    let own_keys: Vec<_> = server.state.lock().unwrap().files.keys().cloned().collect();
    assert_eq!(own_keys.len(), 1);
    assert_eq!(server.state.lock().unwrap().gets[&own_keys[0]], 2);
    // One pre-PUT GET checks absence, then one GET verifies the uploaded bytes.
    sync_database(&store(&server), &b, &blobs_b, &ns, true, false)
        .await
        .unwrap();
    // A must first read B's newly published initial checkpoint. That is a new
    // remote object, not a repeated read of an already applied journal.
    sync_database(&store(&server), &a, &blobs_a, &ns, true, false)
        .await
        .unwrap();
    let puts = server.state.lock().unwrap().puts;
    let gets = server.state.lock().unwrap().gets.clone();
    for (db, blobs) in [
        (&a, &blobs_a),
        (&b, &blobs_b),
        (&a, &blobs_a),
        (&b, &blobs_b),
    ] {
        let result = sync_database(&store(&server), db, blobs, &ns, true, false)
            .await
            .unwrap();
        assert_eq!(result.cloud_report.unwrap().uploaded_changes, 0);
    }
    let state = server.state.lock().unwrap();
    assert_eq!(
        state.puts, puts,
        "remote records must not create echo journals"
    );
    assert_eq!(state.gets, gets, "applied journals must not be read again");
    drop(state);
    assert_eq!(
        local_flashcard_snapshot(&open_database(&b).unwrap())
            .unwrap()
            .drafts
            .len(),
        1
    );
}

#[test]
fn completed_payload_cleanup_preserves_pending_retries_and_checkpoint_cadence() {
    let (db, _) = device("queue-cleanup");
    let c = open_database(&db).unwrap();
    let ns = config().namespace();
    stage(&c, &ns, false).unwrap();
    let pending: (String, Vec<u8>, String) = c
        .query_row(
            "SELECT id,body,baseline FROM flashcard_cloud_uploads WHERE status='pending'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    for i in 0..50 {
        c.execute("INSERT INTO flashcard_cloud_uploads(namespace,id,body,baseline,status) VALUES(?1,?2,?3,?4,'complete')",
            params![ns, format!("legacy-{i}"), pending.1, pending.2]).unwrap();
    }
    stage(&c, &ns, false).unwrap();
    let retained: (String, Vec<u8>, String) = c
        .query_row(
            "SELECT id,body,baseline FROM flashcard_cloud_uploads WHERE status='pending'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(pending, retained);
    assert_eq!(c.query_row("SELECT SUM(length(body)+length(baseline)) FROM flashcard_cloud_uploads WHERE status='complete'", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM flashcard_cloud_uploads WHERE status='complete'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        50
    );
    // Promote the first pending snapshot, then change a real draft: this is the
    // next upload after 50 completed entries and must still be a full checkpoint.
    baseline::confirm(&c, &ns, &pending.0).unwrap();
    c.execute(
        "DELETE FROM flashcard_cloud_uploads WHERE status='pending'",
        [],
    )
    .unwrap();
    c.execute(
        "INSERT INTO flashcard_cloud_baselines(namespace,payload) VALUES(?1,?2) ON CONFLICT(namespace) DO UPDATE SET payload=excluded.payload",
        params![ns, pending.2],
    )
    .unwrap();
    drop(c);
    import_flashcard_values(
        &db,
        "manual",
        "学习".into(),
        json!({"source":"manual"}),
        vec![json!({"question":"清理后还保留检查点吗？","answer":"保留已完成计数"})],
        true,
    )
    .unwrap();
    let c = open_database(&db).unwrap();
    stage(&c, &ns, false).unwrap();
    let body: Vec<u8> = c
        .query_row(
            "SELECT body FROM flashcard_cloud_uploads WHERE status='pending'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(serde_json::from_slice::<Change>(&body).unwrap().checkpoint);
}

#[test]
fn verified_baseline_keeps_local_edits_and_generated_conflict_history_pending() {
    let (db, _) = device("baseline-proof");
    import_flashcard_values(
        &db,
        "manual",
        "学习".into(),
        json!({"source":"manual"}),
        vec![
            json!({"question":"本地修改是否会被吞掉？","answer":"不能把完整当前状态当已上传基线"}),
        ],
        true,
    )
    .unwrap();
    let mut c = open_database(&db).unwrap();
    ensure_journal(&c).unwrap();
    let ns = config().namespace();
    flashcard_quality::merge(
        &c,
        &[json!({"id":"shared-feedback","kind":"feedback","updatedAt":10,"comment":"旧版本"})],
    )
    .unwrap();
    let initial = local_flashcard_snapshot(&c).unwrap();
    c.execute(
        "INSERT INTO flashcard_cloud_baselines(namespace,payload) VALUES(?1,?2)",
        params![ns, serde_json::to_string(&initial).unwrap()],
    )
    .unwrap();
    // These writes simulate edits after staging while the network is in flight.
    c.execute(
        "UPDATE flashcard_drafts SET question=?1,updated_at=updated_at+1 WHERE id=?2",
        params![
            "网络传输期间发生的本地编辑",
            flashcard_sync_drafts::identity(&initial.drafts[0])
        ],
    )
    .unwrap();
    flashcard_quality::merge(
        &c,
        &[json!({"id":"shared-feedback","kind":"feedback","updatedAt":20,"comment":"本地未上传"})],
    )
    .unwrap();
    let mut incoming = initial.clone();
    incoming.quality_records =
        vec![json!({"id":"shared-feedback","kind":"feedback","updatedAt":30,"comment":"远端已知"})];
    merge_flashcard_snapshot(&mut c, &incoming).unwrap();
    let local = local_flashcard_snapshot(&c).unwrap();
    absorb_verified_remote(&c, &ns, &incoming).unwrap();
    let payload: String = c
        .query_row(
            "SELECT payload FROM flashcard_cloud_baselines WHERE namespace=?1",
            params![ns],
            |r| r.get(0),
        )
        .unwrap();
    let compatibility: FlashcardSyncSnapshot = serde_json::from_str(&payload).unwrap();
    assert_eq!(
        serde_json::to_value(&compatibility).unwrap(),
        serde_json::to_value(&initial).unwrap(),
        "legacy reader retains an intact valid snapshot"
    );
    let baseline = baseline::snapshot_for_test(&c, &ns).unwrap();
    let diff = difference(&local, Some(&baseline)).unwrap().unwrap();
    assert_eq!(
        diff.drafts.len(),
        1,
        "unuploaded local edit must remain pending"
    );
    assert!(
        diff.quality_records.iter().all(|v| v["kind"] == "history"),
        "only cloud-known exact feedback can be absorbed"
    );
    assert!(
        diff.quality_records
            .iter()
            .any(|v| v["historyType"] == "version"
                && v["recordId"] == "shared-feedback"
                && v["comment"] == "本地未上传"
                && v["updatedAt"] == 20),
        "the losing unuploaded local feedback must remain recoverable"
    );
    assert!(diff
        .quality_records
        .iter()
        .any(|v| v["historyType"] == "sync-merge"));
}
