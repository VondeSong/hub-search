use super::*;
use crate::collection_models::{Media, Post};
use crate::flashcard_object_store::{OssConfig, OssStore};
use base64::Engine as _;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Default)]
struct Objects {
    files: BTreeMap<String, (Vec<u8>, String)>,
    puts: Vec<String>,
    deletes: Vec<String>,
    deny_delete: bool,
    corrupt: Option<String>,
    list_page_size: usize,
    list_requests: Vec<(String, Option<String>)>,
    fail_list_token_once: Option<String>,
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
async fn server() -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let state = Arc::new(Mutex::new(Objects::default()));
    let shared = state.clone();
    let task = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut data = Vec::new();
            let mut buffer = [0; 8192];
            let end = loop {
                let n = socket.read(&mut buffer).await.unwrap();
                if n == 0 {
                    break 0;
                }
                data.extend_from_slice(&buffer[..n]);
                if let Some(i) = data.windows(4).position(|v| v == b"\r\n\r\n") {
                    break i + 4;
                }
            };
            if end == 0 {
                continue;
            }
            let headers = String::from_utf8_lossy(&data[..end]);
            let first = headers.lines().next().unwrap();
            let mut parts = first.split_whitespace();
            let method = parts.next().unwrap().to_string();
            let target = parts.next().unwrap().to_string();
            let mut length = 0;
            let mut hash = String::new();
            for line in headers.lines().skip(1) {
                if let Some((key, value)) = line.split_once(':') {
                    match key.to_ascii_lowercase().as_str() {
                        "content-length" => length = value.trim().parse::<usize>().unwrap(),
                        "x-oss-meta-sha256" => hash = value.trim().into(),
                        _ => {}
                    }
                }
            }
            assert!(headers
                .to_ascii_lowercase()
                .contains("authorization: oss4-hmac-sha256"));
            while data.len() < end + length {
                let n = socket.read(&mut buffer).await.unwrap();
                if n == 0 {
                    break;
                }
                data.extend_from_slice(&buffer[..n]);
            }
            let url = Url::parse(&format!("http://127.0.0.1{target}")).unwrap();
            let key = url.path().trim_start_matches('/').to_string();
            let (status, body, metadata, content_length) = {
                let mut objects = shared.lock().unwrap();
                if method == "GET" && url.query().is_some() {
                    let prefix = url
                        .query_pairs()
                        .find(|(k, _)| k == "prefix")
                        .unwrap()
                        .1
                        .to_string();
                    let token = url
                        .query_pairs()
                        .find(|(k, _)| k == "continuation-token")
                        .map(|(_, v)| v.into_owned());
                    objects.list_requests.push((prefix.clone(), token.clone()));
                    let fail = token.is_some()
                        && objects.fail_list_token_once.as_deref() == token.as_deref();
                    if fail {
                        objects.fail_list_token_once = None;
                    }
                    let all = objects
                        .files
                        .keys()
                        .filter(|k| {
                            k.starts_with(&prefix)
                                && token.as_deref().map_or(true, |after| k.as_str() > after)
                        })
                        .cloned()
                        .collect::<Vec<_>>();
                    let page_size = if objects.list_page_size == 0 {
                        usize::MAX
                    } else {
                        objects.list_page_size
                    };
                    let page = all.iter().take(page_size).collect::<Vec<_>>();
                    let more = all.len() > page.len();
                    let keys = page
                        .iter()
                        .map(|k| format!("<Contents><Key>{k}</Key></Contents>"))
                        .collect::<String>();
                    let next = if more {
                        format!(
                            "<NextContinuationToken>{}</NextContinuationToken>",
                            page.last().unwrap()
                        )
                    } else {
                        String::new()
                    };
                    let body=format!("<ListBucketResult><IsTruncated>{more}</IsTruncated>{keys}{next}</ListBucketResult>").into_bytes();
                    (
                        if fail { 503 } else { 200 },
                        body.clone(),
                        String::new(),
                        body.len(),
                    )
                } else if method == "PUT" {
                    objects.puts.push(key.clone());
                    if objects.files.contains_key(&key) {
                        (409, Vec::new(), String::new(), 0)
                    } else {
                        objects
                            .files
                            .insert(key.clone(), (data[end..end + length].to_vec(), hash));
                        (200, Vec::new(), String::new(), 0)
                    }
                } else if method == "DELETE" {
                    if objects.deny_delete {
                        (403, Vec::new(), String::new(), 0)
                    } else {
                        objects.files.remove(&key);
                        objects.deletes.push(key);
                        (204, Vec::new(), String::new(), 0)
                    }
                } else if let Some((bytes, hash)) = objects.files.get(&key) {
                    let bytes = if objects.corrupt.as_deref() == Some(key.as_str()) {
                        b"corrupt".to_vec()
                    } else {
                        bytes.clone()
                    };
                    let length = bytes.len();
                    (
                        200,
                        if method == "HEAD" { Vec::new() } else { bytes },
                        hash.clone(),
                        length,
                    )
                } else {
                    (404, Vec::new(), String::new(), 0)
                }
            };
            let response=format!("HTTP/1.1 {status} OK\r\nContent-Length: {content_length}\r\nx-oss-meta-sha256: {metadata}\r\nConnection: close\r\n\r\n");
            socket.write_all(response.as_bytes()).await.unwrap();
            socket.write_all(&body).await.unwrap();
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
fn store(server: &Server) -> OssStore {
    OssStore::new(config(), "synthetic-maintenance-secret".into())
        .unwrap()
        .with_test_endpoint(server.url.clone())
}
struct Device {
    root: PathBuf,
    db: PathBuf,
    blobs: BlobStore,
}

#[tokio::test]
async fn actual_oss_preview_resumes_second_page_after_restart_without_partial_maintenance_authority(
) {
    let server = server().await;
    let remote = store(&server);
    let a = Device::new();
    for id in ["501", "502", "503"] {
        a.seed(id);
        a.round(&remote).await;
    }
    let prefix = remote.key("reading/v1/changes/");
    let (first_key, cloud_count, puts_before) = {
        let mut objects = server.state.lock().unwrap();
        let first = objects
            .files
            .keys()
            .find(|k| k.starts_with(&prefix))
            .unwrap()
            .clone();
        assert!(
            objects
                .files
                .keys()
                .filter(|k| k.starts_with(&prefix))
                .count()
                >= 3
        );
        objects.list_page_size = 1;
        objects.fail_list_token_once = Some(first.clone());
        objects.list_requests.clear();
        (first, objects.files.len(), objects.puts.len())
    };
    assert!(
        history::preview(&a.db, &remote, &config().namespace(), &a.identity())
            .await
            .is_err()
    );
    let c = a.c();
    assert_eq!(rows(&c, "cloud_maintenance_runs"), 0);
    assert_eq!(rows(&c, "cloud_maintenance_objects"), 0);
    let token: String = c
        .query_row("SELECT id FROM cloud_maintenance_listings", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(
        c.query_row("SELECT state FROM cloud_maintenance_listings", [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap(),
        "listing"
    );
    drop(c);
    let complete = history::preview(&a.db, &remote, &config().namespace(), &a.identity())
        .await
        .unwrap();
    assert_eq!(complete.token, token);
    assert_eq!(complete.phase, "read");
    assert!(complete.can_advance && !complete.can_clean && !complete.can_restore);
    let objects = server.state.lock().unwrap();
    assert_eq!(
        objects
            .list_requests
            .iter()
            .filter(|(p, n)| p == &prefix && n.is_none())
            .count(),
        1
    );
    assert_eq!(
        objects
            .list_requests
            .iter()
            .filter(|(p, n)| p == &prefix && n.as_deref() == Some(&first_key))
            .count(),
        2
    );
    assert_eq!(objects.files.len(), cloud_count);
    assert_eq!(objects.puts.len(), puts_before);
    assert!(objects.deletes.is_empty());
    drop(objects);
    assert_eq!(rows(&a.c(), "cloud_maintenance_listing_objects"), 0);
    let mut actual = complete;
    for _ in 0..30 {
        if !actual.can_advance {
            break;
        }
        actual = history::advance(
            &a.db,
            &remote,
            &config().namespace(),
            &a.identity(),
            &actual.token,
        )
        .await
        .unwrap();
        assert!(actual.errors.is_empty(), "{}", actual.errors.join("\n"));
    }
    assert_eq!(actual.phase, "ready");
    assert!(actual.can_clean);
}

#[tokio::test]
async fn interrupted_preview_cannot_be_resumed_under_changed_provider_configuration() {
    let server = server().await;
    let remote = store(&server);
    let a = Device::new();
    for id in ["601", "602"] {
        a.seed(id);
        a.round(&remote).await;
    }
    let old = a.identity();
    {
        let mut objects = server.state.lock().unwrap();
        let first = objects
            .files
            .keys()
            .find(|k| k.starts_with(&remote.key("reading/v1/changes/")))
            .unwrap()
            .clone();
        objects.list_page_size = 1;
        objects.fail_list_token_once = Some(first);
    }
    assert!(
        history::preview(&a.db, &remote, &config().namespace(), &old)
            .await
            .is_err()
    );
    let mut changed = config();
    changed.prefix = "DifferentCloud".into();
    a.c()
        .execute(
            "UPDATE metadata SET value=?1 WHERE key='flashcard_oss_config'",
            [serde_json::to_string(&changed).unwrap()],
        )
        .unwrap();
    assert!(
        history::preview(&a.db, &remote, &config().namespace(), &old)
            .await
            .err()
            .unwrap()
            .contains("变化")
    );
    assert_eq!(rows(&a.c(), "cloud_maintenance_runs"), 0);
    assert!(server.state.lock().unwrap().deletes.is_empty());
}
impl Device {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("hub-maintenance-case-{}", random_url_safe(12)));
        fs::create_dir_all(&root).unwrap();
        let db = root.join("index.sqlite3");
        let c = open_database(&db).unwrap();
        x_bookmarks::storage::schema(&c).unwrap();
        schema(&c).unwrap();
        for (key, value) in [
            ("flashcard_cloud_provider", "oss"),
            ("cloud_sync_enabled", "1"),
            ("cloud_sync_reading", "1"),
            ("cloud_sync_flashcards", "1"),
        ] {
            c.execute("INSERT INTO metadata VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,value]).unwrap();
        }
        c.execute(
            "INSERT INTO metadata VALUES('flashcard_oss_config',?1)",
            [serde_json::to_string(&config()).unwrap()],
        )
        .unwrap();
        c.execute("INSERT INTO metadata VALUES('reading_media_policy',?1)",[json!({"enabled":true,"download":"onDemand","imageMb":10,"documentMb":20,"batchMb":512,"dailyMb":10240,"cacheMb":512}).to_string()]).unwrap();
        let blobs = BlobStore::open(&root.join("blobs-v1")).unwrap();
        Self { root, db, blobs }
    }
    fn c(&self) -> Connection {
        open_database(&self.db).unwrap()
    }
    fn seed(&self, id: &str) {
        x_bookmarks::reading_sync_test_import(
            &mut self.c(),
            Post {
                id: id.into(),
                text: format!("完整阅读 {id}"),
                content_status: "complete".into(),
                url: "https://example.invalid/article".into(),
                ..Post::default()
            },
        );
    }
    async fn round(&self, remote: &OssStore) {
        let id = flashcard_sync_device_id(&self.c()).unwrap();
        reading_sync::sync_database(&self.db, remote, &config().namespace(), &id)
            .await
            .unwrap();
        reading_sync::copies::sync(&self.db, remote, &config().namespace(), &id)
            .await
            .unwrap();
        reading_sync::media::sync(&self.db, remote, &config().namespace(), &id)
            .await
            .unwrap();
        crate::flashcard_cloud_sync::sync_database(
            remote,
            &self.db,
            &self.blobs,
            &config().namespace(),
            false,
            false,
        )
        .await
        .unwrap();
    }
    fn identity(&self) -> String {
        source(&self.c()).unwrap().1
    }
}
impl Drop for Device {
    fn drop(&mut self) {
        forget_initialized_database(&self.db);
        // This test exclusively creates this root; verify its resolved parent before recursion.
        if self.root.starts_with(std::env::temp_dir())
            && self
                .root
                .file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with("hub-maintenance-case-"))
            && fs::symlink_metadata(&self.root).is_ok_and(|m| !m.file_type().is_symlink())
        {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}
async fn prepare(device: &Device, remote: &OssStore) -> Plan {
    let mut plan = history::preview(
        &device.db,
        remote,
        &config().namespace(),
        &device.identity(),
    )
    .await
    .unwrap();
    for _ in 0..100 {
        if !plan.can_advance {
            break;
        }
        plan = history::advance(
            &device.db,
            remote,
            &config().namespace(),
            &device.identity(),
            &plan.token,
        )
        .await
        .unwrap();
        assert!(plan.errors.is_empty(), "{}", plan.errors.join("\n"));
    }
    assert_eq!(plan.phase, "ready");
    plan
}
async fn clean(device: &Device, remote: &OssStore, mut plan: Plan) -> Plan {
    for _ in 0..100 {
        if !plan.can_clean {
            break;
        }
        plan = history::clean(
            &device.db,
            remote,
            &config().namespace(),
            &device.identity(),
            &plan.token,
        )
        .await
        .unwrap();
        assert!(plan.errors.is_empty(), "{}", plan.errors.join("\n"));
    }
    plan
}
fn rows(c: &Connection, table: &str) -> usize {
    c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}

#[tokio::test]
async fn maintenance_real_transport_keeps_review_facts_tombstones_new_objects_and_blob_bytes() {
    let server = server().await;
    let remote = store(&server);
    let a = Device::new();
    let offline = Device::new();
    // X originals have an explicitly selected external Obsidian owner; the
    // maintenance data root must never become their implicit fallback vault.
    let originals = Device::new();
    a.c().execute("INSERT INTO metadata(key,value) VALUES('collection_storage_v1',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[json!({"mode":"obsidian","vaultPath":originals.root}).to_string()]).unwrap();
    let photo = "https://example.invalid/photo.png";
    x_bookmarks::reading_sync_test_import(
        &mut a.c(),
        Post {
            id: "101".into(),
            text: "完整阅读 101".into(),
            content_status: "complete".into(),
            url: "https://example.invalid/article".into(),
            media: vec![Media {
                kind: "photo".into(),
                url: photo.into(),
                preview_url: String::new(),
            }],
            ..Post::default()
        },
    );
    let png=base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE+0AAAAASUVORK5CYII=").unwrap();
    let asset = originals.root.join("source.png");
    fs::write(&asset, &png).unwrap();
    x_bookmarks::storage::record_saved_media(&a.c(), "x:test-account:101", photo, &asset).unwrap();
    let destination = x_bookmarks::library::register_root(&a.c(), &originals.root).unwrap();
    x_bookmarks::storage::commit_note(
        &a.c(),
        &originals.root.join("source-note.md"),
        "# 完整阅读 101",
        None,
        &destination,
        "x:test-account:101",
        "source-note.md",
        "test-input",
        false,
    )
    .unwrap();
    let c = a.c();
    c.execute("INSERT INTO flashcard_decks(id,name,created_at,updated_at)VALUES('deck','Review facts',10,10)",[]).unwrap();
    c.execute("INSERT INTO flashcards(id,deck_id,question,answer,created_at,updated_at,due_at)VALUES('card','deck','Q','A',10,10,10)",[]).unwrap();
    let wire =
        serde_json::to_value(flashcard_scheduler::preview(&c, "card", 1000).unwrap()).unwrap();
    flashcard_scheduler::commit(
        &c,
        "card",
        3,
        None,
        wire["reviewKey"].as_str().unwrap(),
        1000,
    )
    .unwrap();
    drop(c);
    a.round(&remote).await;
    offline.round(&remote).await;
    x_bookmarks::properties::save_local(
        &mut a.c(),
        "x:test-account:101",
        "read",
        &vec!["保留".into()],
    )
    .unwrap();
    a.round(&remote).await;
    x_bookmarks::properties::save_local(&mut a.c(), "x:test-account:101", "read", &Vec::new())
        .unwrap();
    apply_flashcard_tombstone(
        &a.c(),
        &FlashcardSnapshotTombstone {
            entity_type: "card".into(),
            entity_id: "card".into(),
            deleted_at: now_timestamp() + 1,
        },
    )
    .unwrap();
    a.round(&remote).await;
    let plan = prepare(&a, &remote).await;
    let blob_key = remote.key("reading/media-v1/blobs/untouched-original");
    remote
        .put_verified(&blob_key, b"original blob stays")
        .await
        .unwrap();
    a.seed("102");
    a.round(&remote).await;
    let concurrent = server
        .state
        .lock()
        .unwrap()
        .files
        .keys()
        .filter(|key| key.contains("reading/v1/changes/"))
        .cloned()
        .collect::<Vec<_>>();
    let done = clean(&a, &remote, plan).await;
    assert_eq!(done.phase, "done");
    assert!(done.deleted > 0);
    assert_eq!(
        server.state.lock().unwrap().files.get(&blob_key).unwrap().0,
        b"original blob stays"
    );
    assert_eq!(fs::read(&asset).unwrap(), png);
    assert_eq!(
        fs::read_to_string(originals.root.join("source-note.md")).unwrap(),
        "# 完整阅读 101"
    );
    assert!(server
        .state
        .lock()
        .unwrap()
        .deletes
        .iter()
        .all(|key| !key.contains("/blobs/") && !key.contains("/media/")));
    let fresh = Device::new();
    fresh.round(&remote).await;
    let items = x_bookmarks::reading_sync_test_items(&fresh.c(), "all");
    assert_eq!(items.len(), 2);
    assert!(items.iter().any(|i| i["post"]["id"] == "102"));
    assert_eq!(rows(&fresh.c(), "flashcard_review_events"), 1);
    assert_eq!(rows(&fresh.c(), "flashcards"), 0);
    assert_eq!(rows(&fresh.c(), "flashcard_sync_tombstones"), 1);
    assert!(rows(&fresh.c(), "reading_media_manifests") >= 1);
    assert!(rows(&fresh.c(), "reading_copy_snapshots") >= 1);
    assert_eq!(rows(&fresh.c(), "collection_obsidian_exports"), 0);
    offline.round(&remote).await;
    assert_eq!(rows(&offline.c(), "flashcards"), 0);
    assert_eq!(rows(&offline.c(), "flashcard_review_events"), 1);
    assert!(concurrent
        .iter()
        .any(|key| server.state.lock().unwrap().files.contains_key(key)));
}

#[tokio::test]
async fn maintenance_corrupt_checkpoint_stops_delete_and_permission_failure_resumes_exact_scope() {
    let server = server().await;
    let remote = store(&server);
    let a = Device::new();
    a.seed("101");
    a.round(&remote).await;
    x_bookmarks::properties::save_local(
        &mut a.c(),
        "x:test-account:101",
        "read",
        &vec!["新版本".into()],
    )
    .unwrap();
    a.round(&remote).await;
    let plan = prepare(&a, &remote).await;
    let proof = checkpoint::proof(&a.c(), &config().namespace(), &plan.token).unwrap();
    server.state.lock().unwrap().corrupt = Some(proof.replacements[0].key.clone());
    let failed = history::clean(
        &a.db,
        &remote,
        &config().namespace(),
        &a.identity(),
        &plan.token,
    )
    .await
    .unwrap();
    assert!(!failed.errors.is_empty());
    assert!(server.state.lock().unwrap().deletes.is_empty());
    {
        let mut state = server.state.lock().unwrap();
        state.corrupt = None;
        state.deny_delete = true;
    }
    let failed = history::clean(
        &a.db,
        &remote,
        &config().namespace(),
        &a.identity(),
        &plan.token,
    )
    .await
    .unwrap();
    assert!(!failed.errors.is_empty());
    assert!(server.state.lock().unwrap().deletes.is_empty());
    server.state.lock().unwrap().deny_delete = false;
    let done = clean(&a, &remote, failed).await;
    assert_eq!(done.phase, "done");
    assert!(done.deleted > 0);
}

#[tokio::test]
async fn maintenance_resumes_bounded_reads_and_read_only_restore_keeps_local_unsynced_changes() {
    let server = server().await;
    let remote = store(&server);
    let a = Device::new();
    for id in 100..205 {
        a.seed(&id.to_string());
    }
    a.round(&remote).await;
    a.round(&remote).await;
    let b = Device::new();
    b.seed("local-only");
    let expected_ids: BTreeSet<String> = (100..205)
        .map(|id| id.to_string())
        .chain(std::iter::once("local-only".into()))
        .collect();
    let assert_complete_items = |items: Vec<Value>| {
        assert_eq!(items.len(), 106);
        let ids: BTreeSet<String> = items
            .iter()
            .map(|item| item["post"]["id"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(ids, expected_ids);
        let local = items
            .iter()
            .find(|item| item["post"]["id"] == "local-only")
            .unwrap();
        assert_eq!(local["post"]["text"], "完整阅读 local-only");
    };
    let first = history::preview_restore(&b.db, &remote, &config().namespace(), &b.identity())
        .await
        .unwrap();
    let next = history::advance_restore(
        &b.db,
        &remote,
        &config().namespace(),
        &b.identity(),
        &first.token,
    )
    .await
    .unwrap();
    assert!(next.read <= 100);
    assert!(next.can_advance);
    let mut ready = next;
    for _ in 0..20 {
        if !ready.can_advance {
            break;
        }
        ready = history::advance_restore(
            &b.db,
            &remote,
            &config().namespace(),
            &b.identity(),
            &ready.token,
        )
        .await
        .unwrap();
        assert!(ready.errors.is_empty(), "{}", ready.errors.join("\n"));
    }
    assert_eq!(ready.phase, "restoreReady");
    let (before, before_puts) = {
        let objects = server.state.lock().unwrap();
        (objects.files.len(), objects.puts.len())
    };
    let mut restored = ready;
    for _ in 0..20 {
        restored = history::restore(
            &b.db,
            &remote,
            &config().namespace(),
            &b.identity(),
            &restored.token,
        )
        .await
        .unwrap();
        assert!(restored.errors.is_empty(), "{}", restored.errors.join("\n"));
        if restored.phase == "done" {
            break;
        }
    }
    assert_eq!(restored.phase, "done");
    assert_complete_items(x_bookmarks::reading_sync_test_items_all(&b.c(), "all"));
    assert!(server.state.lock().unwrap().deletes.is_empty());
    // Only device confirmation is published by recovery; no generated compatibility checkpoint.
    {
        let objects = server.state.lock().unwrap();
        assert_eq!(objects.files.len(), before + 1);
        let published = &objects.puts[before_puts..];
        assert_eq!(published.len(), 1);
        assert!(published[0].starts_with(&remote.key(DEVICE_PREFIX)));
    }
    assert!(!metadata_string(
        &b.c(),
        &format!(
            "cloud_maintenance_confirmed_{}",
            digest(config().namespace().as_bytes())
        )
    )
    .is_empty());
    assert!(rows(&b.c(), "flashcard_cloud_applied") > 0);
    assert!(rows(&b.c(), "reading_sync_applied") >= 105);
    let report = crate::flashcard_cloud_sync::sync_database(
        &remote,
        &b.db,
        &b.blobs,
        &config().namespace(),
        false,
        false,
    )
    .await
    .unwrap();
    assert_eq!(report.cloud_report.unwrap().downloaded_changes, 0);
    // Daily reading sync uploads at most 100 pending items in one round.
    b.round(&remote).await;
    b.round(&remote).await;
    a.round(&remote).await;
    assert_complete_items(x_bookmarks::reading_sync_test_items_all(&a.c(), "all"));
}

#[tokio::test]
async fn maintenance_device_retirement_is_independent_of_heartbeat_and_rejects_current_device() {
    let server = server().await;
    let remote = store(&server);
    let a = Device::new();
    let b = Device::new();
    let ns = config().namespace();
    devices::refresh(&a.db, &remote, &ns, true).await.unwrap();
    devices::refresh(&b.db, &remote, &ns, true).await.unwrap();
    devices::refresh(&a.db, &remote, &ns, false).await.unwrap();
    let a_id = flashcard_sync_device_id(&a.c()).unwrap();
    let b_id = flashcard_sync_device_id(&b.c()).unwrap();
    assert!(devices::retire(&a.c(), &ns, &a_id, true).is_err());
    for retired in [true, false, true] {
        devices::retire(&a.c(), &ns, &b_id, retired).unwrap();
        devices::flush(&a.db, &remote, &ns).await.unwrap();
    }
    devices::refresh(&b.db, &remote, &ns, true).await.unwrap();
    let view = serde_json::to_value(devices::view(&b.c(), &ns, &b_id).unwrap()).unwrap();
    assert!(view
        .as_array()
        .unwrap()
        .iter()
        .any(|d| d["device"] == b_id && d["retired"] == true));
    assert!(!serde_json::to_string(&view)
        .unwrap()
        .contains("synthetic-maintenance-secret"));
    a.seed("101");
    a.round(&remote).await;
    let plan = prepare(&a, &remote).await;
    a.c()
        .execute(
            "UPDATE metadata SET value='0' WHERE key='cloud_sync_enabled'",
            [],
        )
        .unwrap();
    assert!(
        history::clean(&a.db, &remote, &ns, &a.identity(), &plan.token)
            .await
            .is_err()
    );
    assert!(server.state.lock().unwrap().deletes.is_empty());
    a.c()
        .execute(
            "UPDATE metadata SET value='1' WHERE key='cloud_sync_enabled'",
            [],
        )
        .unwrap();
    let done = clean(&a, &remote, plan).await;
    assert_eq!(done.phase, "done");
    assert!(server
        .state
        .lock()
        .unwrap()
        .deletes
        .iter()
        .any(|key| key.contains(DEVICE_PREFIX)));
    let fresh = Device::new();
    devices::refresh(&fresh.db, &remote, &ns, false)
        .await
        .unwrap();
    let view = serde_json::to_value(
        devices::view(
            &fresh.c(),
            &ns,
            &flashcard_sync_device_id(&fresh.c()).unwrap(),
        )
        .unwrap(),
    )
    .unwrap();
    assert!(view
        .as_array()
        .unwrap()
        .iter()
        .any(|d| d["device"] == b_id && d["retired"] == true));
}

#[tokio::test]
async fn maintenance_noncanonical_source_or_changed_namespace_cannot_be_marked_covered() {
    let server = server().await;
    let remote = store(&server);
    let a = Device::new();
    a.seed("101");
    a.round(&remote).await;
    let mut plan = history::preview(&a.db, &remote, &config().namespace(), &a.identity())
        .await
        .unwrap();
    let first = server
        .state
        .lock()
        .unwrap()
        .files
        .keys()
        .find(|k| k.contains("reading/v1/changes/"))
        .unwrap()
        .clone();
    server.state.lock().unwrap().corrupt = Some(first);
    plan = history::advance(
        &a.db,
        &remote,
        &config().namespace(),
        &a.identity(),
        &plan.token,
    )
    .await
    .unwrap();
    assert!(!plan.errors.is_empty());
    assert!(!plan.can_clean);
    assert!(server.state.lock().unwrap().deletes.is_empty());
    let different = serde_json::to_string(&object_store::Configuration::Oss {
        config: OssConfig {
            prefix: "DifferentRoot".into(),
            ..config()
        },
    })
    .unwrap();
    assert!(history::advance(
        &a.db,
        &remote,
        &config().namespace(),
        &different,
        &plan.token
    )
    .await
    .is_err());
}

#[tokio::test]
async fn maintenance_releasing_failed_scratch_preserves_domains_and_cloud_and_allows_fresh_preview()
{
    let server = server().await;
    let remote = store(&server);
    let a = Device::new();
    a.seed("101");
    a.round(&remote).await;
    let first = history::preview(&a.db, &remote, &config().namespace(), &a.identity())
        .await
        .unwrap();
    let read = history::advance(
        &a.db,
        &remote,
        &config().namespace(),
        &a.identity(),
        &first.token,
    )
    .await
    .unwrap();
    assert!(read.staged_bytes > 0);
    let cloud_count = server.state.lock().unwrap().files.len();
    let domain_count = x_bookmarks::reading_sync_test_items(&a.c(), "all").len();
    a.c()
        .execute(
            "UPDATE metadata SET value='0' WHERE key='cloud_sync_enabled'",
            [],
        )
        .unwrap();
    history::release(&a.c()).unwrap();
    let released = plan(&a.c(), &config().namespace(), &first.token).unwrap();
    assert_eq!(released.phase, "released");
    assert_eq!(released.staged_bytes, 0);
    assert!(!released.can_advance && !released.can_clean && !released.can_restore);
    assert_eq!(server.state.lock().unwrap().files.len(), cloud_count);
    assert!(server.state.lock().unwrap().deletes.is_empty());
    assert_eq!(
        x_bookmarks::reading_sync_test_items(&a.c(), "all").len(),
        domain_count
    );
    a.c()
        .execute(
            "UPDATE metadata SET value='1' WHERE key='cloud_sync_enabled'",
            [],
        )
        .unwrap();
    let fresh = prepare(&a, &remote).await;
    assert_ne!(fresh.token, first.token);
    assert_eq!(fresh.phase, "ready");
}

/// Physical-compaction fixture uses each formal owner schema and keeps acquisition partial.
pub(crate) fn seed_physical_partial(c: &Connection, ns: &str) -> (String, String) {
    super::schema(c).unwrap();
    inventory::schema(c).unwrap();
    let listing = digest(format!("physical-partial:{ns}").as_bytes());
    let key = format!(
        "reading/v1/changes/{}.json",
        digest(b"physical-partial-source")
    );
    c.execute("INSERT INTO cloud_maintenance_listings VALUES(?1,?2,'physical-configuration','cleanup','','listing')",params![ns,listing]).unwrap();
    c.execute("INSERT INTO cloud_maintenance_listing_heads VALUES(?1,'physical-configuration','cleanup','',?2)",params![ns,listing]).unwrap();
    c.execute(
        "INSERT INTO cloud_maintenance_listing_objects VALUES(?1,?2,?3,'reading')",
        params![ns, listing, key],
    )
    .unwrap();
    // Formal producer emits a validated, durable, unacknowledged device heartbeat.
    devices::observe(c, ns).unwrap();
    assert_physical_partial(c, ns, &listing, &key);
    (listing, key)
}
pub(crate) fn assert_physical_partial(c: &Connection, ns: &str, listing: &str, key: &str) {
    assert!(inventory::install(c, ns, listing, "physical-configuration", "cleanup").is_err());
    assert_eq!(
        c.query_row(
            "SELECT state FROM cloud_maintenance_listings WHERE namespace=?1 AND id=?2",
            params![ns, listing],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "listing"
    );
    assert!(c.query_row("SELECT EXISTS(SELECT 1 FROM cloud_maintenance_listing_objects WHERE namespace=?1 AND listing=?2 AND key=?3 AND kind='reading')",params![ns,listing,key],|r|r.get::<_,bool>(0)).unwrap());
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM cloud_maintenance_runs WHERE namespace=?1",
            [ns],
            |r| r.get::<_, usize>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM cloud_maintenance_objects WHERE namespace=?1",
            [ns],
            |r| r.get::<_, usize>(0)
        )
        .unwrap(),
        0
    );
    assert!(c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM cloud_device_pending WHERE namespace=?1)",
            [ns],
            |r| r.get::<_, bool>(0)
        )
        .unwrap());
}
