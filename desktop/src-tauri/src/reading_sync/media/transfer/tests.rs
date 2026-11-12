use super::*;
use crate::flashcard_cloud_sync::tests::{server, store};
use base64::Engine as _;
mod cache_tests;
mod confirmation_tests;
mod offline_tests;
mod recovery_tests;
mod thumbnail_tests;

#[test]
fn reading_all_download_scalar_cursor_preserves_wrap_order_and_frozen_sequence_boundary() {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch("CREATE TABLE reading_media_manifests(namespace TEXT NOT NULL,local_seq INTEGER NOT NULL,body TEXT NOT NULL); CREATE INDEX reading_media_namespace_sequence ON reading_media_manifests(namespace,local_seq);").unwrap();
    for sequence in 1..=7 {
        c.execute(
            "INSERT INTO reading_media_manifests VALUES('cursor',?1,?2)",
            params![sequence, format!("manifest-{sequence}")],
        )
        .unwrap();
    }
    c.execute(
        "INSERT INTO reading_media_manifests VALUES('other',8,'other')",
        [],
    )
    .unwrap();
    let frozen_upper = 7;
    c.execute(
        "INSERT INTO reading_media_manifests VALUES('cursor',9,'later concurrent manifest')",
        [],
    )
    .unwrap();
    let mut order = Vec::new();
    for (mut after, upper) in [(4, frozen_upper), (0, 4)] {
        while let Some((body, sequence)) = next_local_manifest(&c, "cursor", after, upper).unwrap()
        {
            assert_eq!(body, format!("manifest-{sequence}"));
            order.push(sequence);
            after = sequence;
        }
    }
    assert_eq!(order, vec![5, 6, 7, 1, 2, 3, 4]);
    let mut q=c.prepare("EXPLAIN QUERY PLAN SELECT body,local_seq FROM reading_media_manifests WHERE namespace=?1 AND local_seq>?2 AND local_seq<=?3 ORDER BY local_seq LIMIT 1").unwrap();
    let plan = q
        .query_map(params!["cursor", 4, 7], |r| r.get::<_, String>(3))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
        .join(" ");
    assert!(plan.contains("reading_media_namespace_sequence"));
    assert!(
        !plan.contains("TEMP B-TREE"),
        "scalar iteration must not sort the whole corpus once per row: {plan}"
    );
}

#[tokio::test]
async fn reading_network_blocked_transport_keeps_pending_and_local_cache_without_quota() {
    let server = server().await;
    let remote = store(&server);
    let a = Device::new();
    let b = Device::new();
    a.seed(&png());
    super::super::super::sync_database(&a.db, &remote, NS, "a")
        .await
        .unwrap();
    stage(&a.c(), NS, "a", &policy(&a.c()).unwrap(), None).unwrap();
    let prefix = remote.key("reading/");
    let blocked = remote.with_network_guard(
        prefix,
        std::sync::Arc::new(|| Err("阅读传输已暂停：当前为计费网络".into())),
    );
    let reserved = metadata_u64(&a.c(), "reading_media_reserved", 0);
    assert!(upload_pending(
        &a.db,
        &blocked,
        NS,
        &policy(&a.c()).unwrap(),
        Some((KEY, URL))
    )
    .await
    .is_err());
    assert_eq!(metadata_u64(&a.c(), "reading_media_reserved", 0), reserved);
    assert_eq!(
        a.c()
            .query_row("SELECT count(*) FROM reading_media_outbox", [], |r| r
                .get::<_, usize>(0))
            .unwrap(),
        1
    );
    assert_eq!(fs::read(a.root.join("source.png")).unwrap(), png());
    let remote = store(&server);
    // Restoring a connection does not bypass the persisted automatic wait.
    upload_pending(
        &a.db,
        &remote,
        NS,
        &policy(&a.c()).unwrap(),
        Some((KEY, URL)),
    )
    .await
    .unwrap();
    a.round(&remote, "a").await;
    b.round(&remote, "b").await;
    let prefix = remote.key("reading/");
    let blocked =
        remote.with_network_guard(prefix, std::sync::Arc::new(|| Err("当前为计费网络".into())));
    let reserved = metadata_u64(&b.c(), "reading_media_reserved", 0);
    assert!(download(
        &b.db,
        &blocked,
        NS,
        KEY,
        URL,
        &policy(&b.c()).unwrap(),
        true
    )
    .await
    .is_err());
    assert_eq!(metadata_u64(&b.c(), "reading_media_reserved", 0), reserved);
    let remote = store(&server);
    download(&b.db, &remote, NS, KEY, URL, &policy(&b.c()).unwrap(), true)
        .await
        .unwrap();
    let prefix = remote.key("reading/");
    let blocked =
        remote.with_network_guard(prefix, std::sync::Arc::new(|| Err("当前为计费网络".into())));
    download(
        &b.db,
        &blocked,
        NS,
        KEY,
        URL,
        &policy(&b.c()).unwrap(),
        true,
    )
    .await
    .unwrap();
    assert!(local_available(&b.c(), &b.db, NS, KEY, URL).unwrap());
}
const KEY: &str = "telegram:test-account:media";
const NS: &str = "isolated-media";
const URL: &str = "https://example.invalid/picture.png";

#[tokio::test]
async fn x_cloud_attachments_download_directly_into_obsidian_and_read_without_cloud() {
    use crate::data_backup::media_policy::tests::Fixture;
    const KEY: &str = "x:test-account:media";
    let server = server().await;
    let remote = store(&server);
    let a = Fixture::new();
    let b = Fixture::new();
    for f in [&a, &b] {
        meta(
            &f.c(),
            "reading_media_policy",
            &serde_json::to_string(&Policy {
                enabled: true,
                ..Policy::default()
            })
            .unwrap(),
        )
        .unwrap();
    }
    x_bookmarks::reading_sync_test_import(
        &mut a.c(),
        Post {
            id: "media".into(),
            text: "X offline body".into(),
            content_status: "complete".into(),
            media: vec![crate::collection_models::Media {
                kind: "photo".into(),
                url: URL.into(),
                preview_url: String::new(),
            }],
            ..Post::default()
        },
    );
    let original = a.vault.join("99_Meta/assets/X_assets/original.png");
    fs::write(&original, png()).unwrap();
    x_bookmarks::storage::record_saved_media(&a.c(), KEY, URL, &original).unwrap();
    super::super::super::sync_database(&a.db, &remote, NS, "a")
        .await
        .unwrap();
    sync(&a.db, &remote, NS, "a").await.unwrap();
    super::super::super::sync_database(&b.db, &remote, NS, "b")
        .await
        .unwrap();
    sync(&b.db, &remote, NS, "b").await.unwrap();
    download(
        &b.db,
        &remote,
        NS,
        KEY,
        URL,
        &policy(&b.c()).unwrap(),
        false,
    )
    .await
    .unwrap();
    let path = local_path(&b.c(), KEY, URL).unwrap();
    assert!(path.starts_with(&b.vault));
    assert_eq!(fs::read(&path).unwrap(), png());
    assert!(!b.root.join("reading-media-v1").exists());
    assert!(!b.root.join("collection-files").exists());
    assert_eq!(
        b.c()
            .query_row("SELECT COUNT(*) FROM reading_media_cache_files", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap(),
        0
    );
    drop(remote);
    drop(server);
    assert!(local_available(&b.c(), &b.db, NS, KEY, URL).unwrap());
    let id: i64 = b
        .c()
        .query_row(
            "SELECT local_seq FROM collection_saved_media WHERE item_key=?1",
            [KEY],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        fs::read(x_bookmarks::storage::recorded_media_path(&b.c(), id).unwrap()).unwrap(),
        png()
    );
    assert_eq!(fs::read(original).unwrap(), png());
}
struct Device {
    root: PathBuf,
    db: PathBuf,
}
impl Device {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("hub-reading-media-test-{}", random_url_safe(10)));
        fs::create_dir(&root).unwrap();
        let db = root.join("hub.sqlite3");
        let c = open_database(&db).unwrap();
        x_bookmarks::storage::schema(&c).unwrap();
        meta(
            &c,
            "reading_media_policy",
            &serde_json::to_string(&Policy {
                enabled: true,
                ..Policy::default()
            })
            .unwrap(),
        )
        .unwrap();
        Self { root, db }
    }
    fn c(&self) -> Connection {
        open_database(&self.db).unwrap()
    }
    fn seed(&self, bytes: &[u8]) {
        x_bookmarks::reading_sync_test_import_managed(
            &mut self.c(),
            Post {
                id: "media".into(),
                text: "正文与附件分别恢复".into(),
                media: vec![crate::collection_models::Media {
                    kind: "photo".into(),
                    url: URL.into(),
                    preview_url: String::new(),
                }],
                ..Post::default()
            },
        );
        let path = self.root.join("source.png");
        fs::write(&path, bytes).unwrap();
        x_bookmarks::storage::record_saved_media(&self.c(), KEY, URL, &path).unwrap();
    }
    async fn round(&self, remote: &OssStore, name: &str) -> Summary {
        super::super::super::sync_database(&self.db, remote, NS, name)
            .await
            .unwrap();
        sync(&self.db, remote, NS, name).await.unwrap()
    }
    fn manifest(&self) -> Manifest {
        let (post, _) = current(&self.c(), KEY).unwrap();
        load_manifest(&self.c(), NS, KEY, &post, URL)
            .unwrap()
            .unwrap()
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
            .starts_with("hub-reading-media-test-"));
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn png() -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE+0AAAAASUVORK5CYII=").unwrap()
}

#[tokio::test]
async fn reading_media_cache_reuse_is_free_and_corruption_is_repaired() {
    let server = server().await;
    let remote = store(&server);
    let a = Device::new();
    let b = Device::new();
    a.seed(&png());
    a.round(&remote, "a").await;
    b.round(&remote, "b").await;
    let p = policy(&b.c()).unwrap();
    download(&b.db, &remote, NS, KEY, URL, &p, false)
        .await
        .unwrap();
    let path = local_path(&b.c(), KEY, URL).unwrap();
    let before = metadata_u64(&b.c(), "reading_media_reserved", 0);
    b.c()
        .execute("DELETE FROM collection_saved_media", [])
        .unwrap();
    let no_capacity = Policy {
        cache_mb: 0,
        daily_mb: 0,
        ..p.clone()
    };
    download(&b.db, &remote, NS, KEY, URL, &no_capacity, false)
        .await
        .unwrap();
    assert_eq!(metadata_u64(&b.c(), "reading_media_reserved", 0), before);
    assert_eq!(local_path(&b.c(), KEY, URL).unwrap(), path);
    fs::write(&path, b"damaged local cache").unwrap();
    assert!(!local_available(&b.c(), &b.db, NS, KEY, URL).unwrap());
    download(&b.db, &remote, NS, KEY, URL, &p, true)
        .await
        .unwrap();
    assert_eq!(fs::read(&path).unwrap(), png());
    assert!(local_available(&b.c(), &b.db, NS, KEY, URL).unwrap());
    b.c().execute("UPDATE collection_x_items SET post_json=json_set(post_json,'$.text','new body') WHERE item_key=?1",[KEY]).unwrap();
    assert!(!local_available(&b.c(), &b.db, NS, KEY, URL).unwrap());
    // Original source files remain available offline and are never replaced by cache repair.
    assert!(local_available(&a.c(), &a.db, NS, KEY, URL).unwrap());
    assert_eq!(fs::read(a.root.join("source.png")).unwrap(), png());
}

#[tokio::test]
async fn reading_media_failed_first_batch_does_not_starve_later_uploads() {
    let server = server().await;
    let remote = store(&server);
    let a = Device::new();
    a.seed(&png());
    stage(&a.c(), NS, "a", &policy(&a.c()).unwrap(), None).unwrap();
    let mut m = a.manifest();
    a.c()
        .execute("DELETE FROM reading_media_outbox", [])
        .unwrap();
    for index in 1..=101 {
        m.version.clock = index;
        let body = serde_json::to_vec(&m).unwrap();
        let path = if index == 101 {
            a.root.join("source.png")
        } else {
            a.root.join("missing.png")
        };
        a.c()
            .execute(
                "INSERT INTO reading_media_outbox(namespace,id,body,path) VALUES(?1,?2,?3,?4)",
                params![NS, hash(&body), body, path.to_string_lossy()],
            )
            .unwrap();
    }
    let p = policy(&a.c()).unwrap();
    let first = upload_pending(&a.db, &remote, NS, &p, None).await.unwrap();
    assert_eq!(first.failed, 100);
    assert_eq!(first.uploaded, 0);
    let next = upload_pending(&a.db, &remote, NS, &p, None).await.unwrap();
    assert_eq!(next.uploaded, 1);
    assert!(server
        .state
        .lock()
        .unwrap()
        .files
        .keys()
        .any(|k| k.contains("/blobs/")));
}

#[tokio::test]
async fn reading_media_real_transport_restores_bytes_into_existing_preview_consumer() {
    let server = server().await;
    let remote = store(&server);
    let a = Device::new();
    let b = Device::new();
    let original = png();
    a.seed(&original);
    assert_eq!(a.round(&remote, "a").await.uploaded, 1);
    b.round(&remote, "b").await;
    assert!(local_path(&b.c(), KEY, URL).is_none()); // Default is on demand.
    download(
        &b.db,
        &remote,
        NS,
        KEY,
        URL,
        &policy(&b.c()).unwrap(),
        false,
    )
    .await
    .unwrap();
    let id = b
        .c()
        .query_row(
            "SELECT local_seq FROM collection_saved_media WHERE item_key=?1",
            [KEY],
            |r| r.get(0),
        )
        .unwrap();
    let path = x_bookmarks::storage::recorded_media_path(&b.c(), id).unwrap();
    assert_eq!(fs::read(path).unwrap(), original);
    let items = x_bookmarks::reading_sync_test_items(&b.c(), "all");
    assert_eq!(items[0]["savedMedia"], json!([URL]));
    let files = server.state.lock().unwrap().files.clone();
    for (key, (bytes, _)) in files.iter().filter(|(k, _)| k.contains("/manifests/")) {
        assert!(key.ends_with(".json"));
        assert!(!String::from_utf8_lossy(bytes).contains("source.png"));
        assert!(!String::from_utf8_lossy(bytes).contains("hub-reading-media-test"));
    }
    assert_eq!(a.round(&remote, "a").await.uploaded, 0);
}

#[tokio::test]
async fn reading_media_corrupt_cloud_is_never_published_and_failed_attempts_consume_budget() {
    let server = server().await;
    let remote = store(&server);
    let a = Device::new();
    let b = Device::new();
    a.seed(&png());
    a.round(&remote, "a").await;
    b.round(&remote, "b").await;
    let before = metadata_u64(&b.c(), "reading_media_reserved", 0);
    server.state.lock().unwrap().corrupt = true;
    assert!(download(
        &b.db,
        &remote,
        NS,
        KEY,
        URL,
        &policy(&b.c()).unwrap(),
        false
    )
    .await
    .is_err());
    assert!(local_path(&b.c(), KEY, URL).is_none());
    assert!(metadata_u64(&b.c(), "reading_media_reserved", 0) > before);
    server.state.lock().unwrap().corrupt = false;
    download(&b.db, &remote, NS, KEY, URL, &policy(&b.c()).unwrap(), true)
        .await
        .unwrap();
    assert!(local_path(&b.c(), KEY, URL).is_some());
    assert_eq!(
        b.c()
            .query_row(
                "SELECT count(*) FROM reading_media_errors WHERE namespace=?1 AND item_key=?2",
                params![NS, KEY],
                |r| r.get::<_, usize>(0)
            )
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn reading_media_upload_retry_preserves_pending_and_does_not_certify_missing_blob() {
    let server = server().await;
    let remote = store(&server);
    let a = Device::new();
    a.seed(&png());
    super::super::super::sync_database(&a.db, &remote, NS, "a")
        .await
        .unwrap();
    server.state.lock().unwrap().deny_put = true;
    let result = sync(&a.db, &remote, NS, "a").await.unwrap();
    assert_eq!(result.failed, 1);
    assert_eq!(result.pending, 1);
    assert!(!server
        .state
        .lock()
        .unwrap()
        .files
        .keys()
        .any(|v| v.contains("/manifests/")));
    server.state.lock().unwrap().deny_put = false;
    assert_eq!(sync(&a.db, &remote, NS, "a").await.unwrap().uploaded, 0);
    assert_eq!(
        upload_pending(
            &a.db,
            &remote,
            NS,
            &policy(&a.c()).unwrap(),
            Some((KEY, URL))
        )
        .await
        .unwrap()
        .uploaded,
        1
    );
    // Even correct HEAD metadata must not hide corrupt bytes when explicitly rechecking.
    server.state.lock().unwrap().corrupt = true;
    stage(&a.c(), NS, "a", &policy(&a.c()).unwrap(), Some((KEY, URL))).unwrap();
    assert!(upload_pending(
        &a.db,
        &remote,
        NS,
        &policy(&a.c()).unwrap(),
        Some((KEY, URL))
    )
    .await
    .is_err());
}

#[tokio::test]
async fn reading_media_policy_blocks_oversize_and_requires_manual_archive_transfer() {
    let server = server().await;
    let remote = store(&server);
    let a = Device::new();
    let zip = b"PK\x03\x04archive-test-fixture";
    a.seed(zip);
    a.round(&remote, "a").await;
    assert_eq!(a.manifest().state, "skipped");
    assert!(!server
        .state
        .lock()
        .unwrap()
        .files
        .keys()
        .any(|v| v.contains("/blobs/")));
    stage(&a.c(), NS, "a", &policy(&a.c()).unwrap(), Some((KEY, URL))).unwrap();
    upload_pending(
        &a.db,
        &remote,
        NS,
        &policy(&a.c()).unwrap(),
        Some((KEY, URL)),
    )
    .await
    .unwrap();
    assert_eq!(a.manifest().state, "ready");
    let mut image = png();
    image.resize(MB as usize + 1, 0);
    a.seed(&image);
    let p = Policy {
        enabled: true,
        image_mb: 1,
        ..Policy::default()
    };
    meta(
        &a.c(),
        "reading_media_policy",
        &serde_json::to_string(&p).unwrap(),
    )
    .unwrap();
    a.round(&remote, "a").await;
    assert_eq!(a.manifest().state, "skipped");
    assert!(allowed(&p, "image/png", MB + 1, true));
    assert!(!allowed(&p, "application/x-executable", 10, true));
}

#[tokio::test]
async fn reading_media_daily_and_cache_limits_and_body_changes_prevent_download() {
    let server = server().await;
    let remote = store(&server);
    let a = Device::new();
    let b = Device::new();
    a.seed(&png());
    a.round(&remote, "a").await;
    b.round(&remote, "b").await;
    let mut p = policy(&b.c()).unwrap();
    p.unlimited = false;
    meta(
        &b.c(),
        "reading_media_reserved",
        &(p.daily_mb * MB).to_string(),
    )
    .unwrap();
    assert!(download(&b.db, &remote, NS, KEY, URL, &p, false)
        .await
        .unwrap_err()
        .contains("今日"));
    assert!(local_path(&b.c(), KEY, URL).is_none());
    meta(&b.c(), "reading_media_reserved", "0").unwrap();
    let zero_cache = Policy {
        cache_mb: 0,
        ..p.clone()
    };
    assert!(download(&b.db, &remote, NS, KEY, URL, &zero_cache, true)
        .await
        .unwrap_err()
        .contains("缓存"));
    b.c().execute("UPDATE collection_x_items SET post_json=json_set(post_json,'$.text','已更新正文') WHERE item_key=?1",[KEY]).unwrap();
    assert!(download(&b.db, &remote, NS, KEY, URL, &p, false)
        .await
        .unwrap_err()
        .contains("清单"));
}

#[tokio::test]
async fn reading_media_disabled_policy_sends_nothing_and_automatic_download_restores_images() {
    let server = server().await;
    let remote = store(&server);
    let a = Device::new();
    let b = Device::new();
    a.seed(&png());
    meta(
        &a.c(),
        "reading_media_policy",
        &serde_json::to_string(&Policy::default()).unwrap(),
    )
    .unwrap();
    assert_eq!(sync(&a.db, &remote, NS, "a").await.unwrap().uploaded, 0);
    assert!(server.state.lock().unwrap().files.is_empty());
    meta(
        &a.c(),
        "reading_media_policy",
        &serde_json::to_string(&Policy {
            enabled: true,
            ..Policy::default()
        })
        .unwrap(),
    )
    .unwrap();
    a.round(&remote, "a").await;
    meta(
        &b.c(),
        "reading_media_policy",
        &serde_json::to_string(&Policy {
            enabled: true,
            download: "all".into(),
            ..Policy::default()
        })
        .unwrap(),
    )
    .unwrap();
    assert_eq!(b.round(&remote, "b").await.downloaded, 1);
    assert!(local_path(&b.c(), KEY, URL).is_some());
}

#[tokio::test]
async fn reading_quota_small_object_settles_existing_readback_actual_bytes() {
    let s = server().await;
    let remote = store(&s);
    let d = Device::new();
    let p = policy(&d.c()).unwrap();
    let budget = Budget::new(&p);
    let key = remote.key("reading/media-v1/test-small.json");
    let payload = b"{}";
    assert!(budget.put(&d.db, &p, &remote, &key, payload).await.unwrap());
    assert_eq!(metadata_u64(&d.c(), "reading_transfer_upload", 0), 2);
    assert_eq!(metadata_u64(&d.c(), "reading_transfer_download", 0), 2);
    let before = metadata_u64(&d.c(), "reading_media_reserved", 0);
    assert!(!budget.put(&d.db, &p, &remote, &key, payload).await.unwrap());
    assert_eq!(
        metadata_u64(&d.c(), "reading_media_reserved", 0),
        before + 2
    );
    assert_eq!(
        budget
            .get(&d.db, &p, &remote, &key, MAX_MANIFEST)
            .await
            .unwrap()
            .unwrap(),
        payload
    );
    assert_eq!(
        metadata_u64(&d.c(), "reading_media_reserved", 0),
        before + 4
    );
    assert_eq!(metadata_u64(&d.c(), "reading_transfer_pending", 0), 0);
    assert!(budget
        .get(
            &d.db,
            &p,
            &remote,
            &remote.key("reading/missing"),
            MAX_MANIFEST
        )
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        metadata_u64(&d.c(), "reading_media_reserved", 0),
        before + 4
    );
}
#[tokio::test]
async fn reading_quota_partial_failure_and_cancellation_release_only_unused_bytes() {
    let d = Device::new();
    let mut p = policy(&d.c()).unwrap();
    p.unlimited = false; // Historical batch accounting compatibility only.
    let budget = Budget::new(&p);
    let r = budget
        .reserve(&d.db, &p, 1000, "reading/media-v1/blobs/test")
        .unwrap();
    crate::cloud_transfer_meter::ACTIVE
        .scope(r.meter.clone(), async {
            crate::cloud_transfer_meter::mark();
            crate::cloud_transfer_meter::downloaded(123);
        })
        .await;
    drop(r); // The same guard path runs when a future is cancelled.
    assert_eq!(metadata_u64(&d.c(), "reading_media_reserved", 0), 123);
    assert_eq!(metadata_u64(&d.c(), "reading_transfer_download", 0), 123);
    assert_eq!(
        metadata_u64(&d.c(), "reading_transfer_attachment_download", 0),
        123
    );
    assert_eq!(metadata_u64(&d.c(), "reading_transfer_pending", 0), 0);
    let r = budget
        .reserve(&d.db, &p, 1000, "reading/test.json")
        .unwrap();
    drop(r);
    assert_eq!(metadata_u64(&d.c(), "reading_media_reserved", 0), 123);
    assert_eq!(*budget.left.lock().unwrap(), p.batch_mb * MB - 123);
}
#[tokio::test]
async fn reading_quota_small_read_fits_remaining_allowance_not_max_manifest() {
    let s = server().await;
    let remote = store(&s);
    let d = Device::new();
    let mut p = policy(&d.c()).unwrap();
    p.unlimited = false; // Historical accounting compatibility only.
    let budget = Budget::new(&p);
    let key = remote.key("reading/small.json");
    remote.put_verified(&key, b"{}").await.unwrap();
    meta(
        &d.c(),
        "reading_media_day",
        &chrono::Utc::now().format("%Y-%m-%d").to_string(),
    )
    .unwrap();
    meta(
        &d.c(),
        "reading_media_reserved",
        &(p.daily_mb * MB - 2).to_string(),
    )
    .unwrap();
    assert!(budget
        .get(&d.db, &p, &remote, &key, MAX_MANIFEST)
        .await
        .unwrap()
        .is_some());
    assert_eq!(metadata_u64(&d.c(), "reading_transfer_download", 0), 2);
    assert_eq!(
        metadata_u64(&d.c(), "reading_transfer_legacy", 0),
        p.daily_mb * MB - 2
    );
    assert!(budget
        .get(&d.db, &p, &remote, &key, MAX_MANIFEST)
        .await
        .unwrap_err()
        .contains("额度不足"));
}
#[tokio::test]
async fn reading_quota_nested_scope_is_not_double_counted() {
    let s = server().await;
    let remote = store(&s);
    let d = Device::new();
    let p = policy(&d.c()).unwrap();
    let outer = Budget::new(&p);
    let inner = Budget::new(&p);
    let key = remote.key("reading/nested.json");
    remote.put_verified(&key, b"{}").await.unwrap();
    let mut r = outer.reserve(&d.db, &p, 10, &key).unwrap();
    crate::cloud_transfer_meter::ACTIVE
        .scope(r.meter.clone(), inner.get(&d.db, &p, &remote, &key, 10))
        .await
        .unwrap();
    r.settle().unwrap();
    drop(r);
    assert_eq!(metadata_u64(&d.c(), "reading_media_reserved", 0), 2);
    assert_eq!(metadata_u64(&d.c(), "reading_transfer_pending", 0), 0);
}

#[tokio::test]
async fn reading_quota_interrupted_http_read_counts_received_chunks_not_full_file() {
    let server = server().await;
    let remote = store(&server);
    let d = Device::new();
    let p = policy(&d.c()).unwrap();
    let budget = Budget::new(&p);
    let key = remote.key("reading/media-v1/blobs/partial");
    remote.put_verified(&key, &[42u8; 1000]).await.unwrap();
    server.state.lock().unwrap().truncate_get = Some(100);
    assert!(budget.get(&d.db, &p, &remote, &key, 1000).await.is_err());
    assert_eq!(metadata_u64(&d.c(), "reading_media_reserved", 0), 100);
    assert_eq!(metadata_u64(&d.c(), "reading_transfer_download", 0), 100);
    assert_eq!(metadata_u64(&d.c(), "reading_transfer_pending", 0), 0);
}
#[tokio::test]
async fn reading_quota_failed_upload_counts_sent_body_but_releases_unread_allowance() {
    let server = server().await;
    let remote = store(&server);
    let d = Device::new();
    let p = policy(&d.c()).unwrap();
    let budget = Budget::new(&p);
    server.state.lock().unwrap().deny_put = true;
    assert!(budget
        .put(
            &d.db,
            &p,
            &remote,
            &remote.key("reading/failed.json"),
            b"payload"
        )
        .await
        .is_err());
    assert_eq!(metadata_u64(&d.c(), "reading_transfer_upload", 0), 7);
    assert_eq!(metadata_u64(&d.c(), "reading_transfer_download", 0), 0);
    assert_eq!(metadata_u64(&d.c(), "reading_media_reserved", 0), 7);
    assert_eq!(metadata_u64(&d.c(), "reading_transfer_pending", 0), 0);
}

#[tokio::test]
async fn reading_quota_cancelled_future_settles_and_releases_its_reservation() {
    let d = Device::new();
    let p = policy(&d.c()).unwrap();
    let budget = Budget::new(&p);
    let mut future = Box::pin(async {
        let r = budget
            .reserve(&d.db, &p, 1000, "reading/test.json")
            .unwrap();
        crate::cloud_transfer_meter::ACTIVE
            .scope(r.meter.clone(), async {
                crate::cloud_transfer_meter::mark();
                crate::cloud_transfer_meter::downloaded(123);
                std::future::pending::<()>().await;
            })
            .await;
    });
    assert!(futures::poll!(&mut future).is_pending());
    assert_eq!(metadata_u64(&d.c(), "reading_transfer_pending", 0), 1000);
    drop(future);
    assert_eq!(metadata_u64(&d.c(), "reading_transfer_pending", 0), 0);
    assert_eq!(metadata_u64(&d.c(), "reading_transfer_download", 0), 123);
    assert_eq!(metadata_u64(&d.c(), "reading_media_reserved", 0), 123);
}
#[tokio::test]
async fn reading_quota_changed_cloud_size_cannot_expand_the_reserved_download() {
    let server = server().await;
    let remote = store(&server);
    let d = Device::new();
    let p = policy(&d.c()).unwrap();
    let budget = Budget::new(&p);
    let key = remote.key("reading/race.json");
    remote.put_verified(&key, b"{}").await.unwrap();
    server.state.lock().unwrap().grow_get = Some(1000);
    assert!(budget
        .get(&d.db, &p, &remote, &key, MAX_MANIFEST)
        .await
        .unwrap_err()
        .contains("超过"));
    assert_eq!(metadata_u64(&d.c(), "reading_transfer_pending", 0), 0);
}
#[tokio::test]
async fn reading_quota_webdav_measures_upload_readback_and_existing_object_read() {
    let server = crate::reading_sync::object_store::tests::server().await;
    let remote = crate::reading_sync::object_store::tests::remote(&server);
    let d = Device::new();
    let p = policy(&d.c()).unwrap();
    let budget = Budget::new(&p);
    let key = remote.key("reading/measured.json");
    assert!(budget.put(&d.db, &p, &remote, &key, b"{}").await.unwrap());
    assert_eq!(metadata_u64(&d.c(), "reading_transfer_upload", 0), 2);
    assert_eq!(metadata_u64(&d.c(), "reading_transfer_download", 0), 2);
    assert!(!budget.put(&d.db, &p, &remote, &key, b"{}").await.unwrap());
    assert_eq!(metadata_u64(&d.c(), "reading_transfer_upload", 0), 2);
    assert_eq!(metadata_u64(&d.c(), "reading_transfer_download", 0), 4);
}
#[test]
fn reading_quota_previous_day_reservations_expire_without_becoming_usage() {
    let d = Device::new();
    let p = policy(&d.c()).unwrap();
    let budget = Budget::new(&p);
    meta(&d.c(), "reading_media_day", "2000-01-01").unwrap();
    meta(
        &d.c(),
        "reading_media_reserved",
        &(p.daily_mb * MB).to_string(),
    )
    .unwrap();
    let r = budget.reserve(&d.db, &p, 2, "reading/test.json").unwrap();
    drop(r);
    assert_eq!(metadata_u64(&d.c(), "reading_media_reserved", 0), 0);
    assert_eq!(metadata_u64(&d.c(), "reading_transfer_legacy", 0), 0);
}

#[tokio::test]
async fn runtime_ignores_retired_budgets_and_keeps_upload_download_filters_independent() {
    let server = server().await;
    let remote = store(&server);
    let a = Device::new();
    let b = Device::new();
    a.seed(&png());
    let none = crate::cloud_sync::attachments::Selection {
        image: false,
        video: false,
        pdf: false,
        other: false,
        max_mb: 1,
    };
    let mut directions = crate::cloud_sync::attachments::Directions {
        upload: none.clone(),
        download: none,
    };
    meta(
        &a.c(),
        "cloud_attachments_reading_v1",
        &serde_json::to_string(&directions).unwrap(),
    )
    .unwrap();
    a.round(&remote, "a").await;
    assert!(!server
        .state
        .lock()
        .unwrap()
        .files
        .keys()
        .any(|k| k.contains("/blobs/")));
    directions.upload.image = true;
    meta(
        &a.c(),
        "cloud_attachments_reading_v1",
        &serde_json::to_string(&directions).unwrap(),
    )
    .unwrap();
    meta(
        &a.c(),
        "reading_media_reserved",
        &(u64::MAX / 2).to_string(),
    )
    .unwrap();
    a.round(&remote, "a").await;
    b.round(&remote, "b").await;
    let p = policy(&b.c()).unwrap();
    assert!(p.unlimited);
    meta(
        &b.c(),
        "reading_media_reserved",
        &(u64::MAX / 2).to_string(),
    )
    .unwrap();
    download(&b.db, &remote, NS, KEY, URL, &p, true)
        .await
        .unwrap();
    assert!(local_available(&b.c(), &b.db, NS, KEY, URL).unwrap());
}

#[tokio::test]
async fn local_intake_originals_upload_after_policy_change_without_promoting_cloud_consumers() {
    let server = server().await;
    let remote = store(&server);
    let a = Device::new();
    let b = Device::new();
    let vault = a.root.join("source-vault");
    fs::create_dir_all(vault.join("Telegram")).unwrap();
    fs::create_dir_all(vault.join("99_Meta/assets")).unwrap();
    fs::write(vault.join("99_Meta/assets/proof.png"), png()).unwrap();
    fs::write(vault.join("Telegram/proof.md"), "---\nurl: https://t.me/hub_media_intake/1\n---\n\n正文先同步，图片后补。\n\n![图片](../99_Meta/assets/proof.png)\n").unwrap();
    meta(
        &a.c(),
        "collection_storage_v1",
        &json!({"mode":"obsidian","vaultPath":vault,"downloadMedia":true}).to_string(),
    )
    .unwrap();
    let outcome = x_bookmarks::local_sources::scan(&mut a.c()).unwrap();
    assert_eq!(outcome.changed, 1);
    let key: String = a
        .c()
        .query_row(
            "SELECT item_key FROM collection_local_source_items",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(!remote_only(&a.c(), &key).unwrap());
    let none = crate::cloud_sync::attachments::Selection {
        image: false,
        video: false,
        pdf: false,
        other: false,
        max_mb: 1,
    };
    let mut rules = crate::cloud_sync::attachments::Directions {
        upload: none.clone(),
        download: none,
    };
    let save = |d: &Device, rules: &crate::cloud_sync::attachments::Directions| {
        meta(
            &d.c(),
            "cloud_attachments_reading_v1",
            &serde_json::to_string(rules).unwrap(),
        )
        .unwrap();
    };
    save(&a, &rules);
    save(&b, &rules);
    a.round(&remote, "a").await;
    b.round(&remote, "b").await;
    assert!(remote_only(&b.c(), &key).unwrap());
    assert_eq!(
        stage(&b.c(), NS, "b", &policy(&b.c()).unwrap(), None).unwrap(),
        0
    );
    assert!(!server
        .state
        .lock()
        .unwrap()
        .files
        .keys()
        .any(|k| k.contains("/blobs/")));
    rules.upload.image = true;
    save(&a, &rules);
    a.round(&remote, "a").await;
    rules.download.image = true;
    save(&b, &rules);
    b.round(&remote, "b").await;
    let (post, urls) = current(&b.c(), &key).unwrap();
    assert_eq!(urls.len(), 1);
    let manifest = load_manifest(&b.c(), NS, &key, &post, &urls[0])
        .unwrap()
        .unwrap();
    assert_eq!(manifest.state, "ready");
    assert!(local_available(&b.c(), &b.db, NS, &key, &urls[0]).unwrap());
    assert_eq!(
        fs::read(local_path(&b.c(), &key, &urls[0]).unwrap()).unwrap(),
        png()
    );
    assert_eq!(
        fs::read(vault.join("99_Meta/assets/proof.png")).unwrap(),
        png()
    );
}
