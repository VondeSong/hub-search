//! Recovery evidence comes from the real producer and HTTP transport, never a local cache hit.
use super::*;
use crate::collection_models::Media;
use crate::reading_sync::media::recovery;
use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

const SECOND: &str = "https://example.invalid/second.png";
const LARGE: &str = "https://example.invalid/large.png";
const MISSING: &str = "https://example.invalid/missing.png";
const ZIP: &str = "https://example.invalid/archive.zip";

fn configure(d: &Device) -> String {
    let config = crate::flashcard_object_store::OssConfig {
        bucket: "test-bucket".into(),
        region: "cn-hangzhou".into(),
        prefix: "HubFlashcards".into(),
        access_key_id: "EXAMPLE".into(),
    };
    meta(
        &d.c(),
        "flashcard_oss_config",
        &serde_json::to_string(&config).unwrap(),
    )
    .unwrap();
    for (key, value) in [
        ("cloud_sync_enabled", "1"),
        ("cloud_sync_reading", "1"),
        ("cloud_sync_auto", "0"),
        ("flashcard_cloud_provider", "oss"),
    ] {
        meta(&d.c(), key, value).unwrap();
    }
    config.namespace()
}

fn post(urls: &[&str]) -> Post {
    Post {
        id: "media".into(),
        text: "independent recovery evidence".into(),
        content_status: "complete".into(),
        media: urls
            .iter()
            .map(|url| Media {
                kind: "photo".into(),
                url: (*url).into(),
                preview_url: String::new(),
            })
            .collect(),
        ..Post::default()
    }
}

fn import(d: &Device, value: Post) {
    x_bookmarks::reading_sync_test_import_managed(&mut d.c(), value);
}

fn source(d: &Device, url: &str, name: &str, bytes: &[u8]) -> PathBuf {
    let path = d.root.join(name);
    fs::write(&path, bytes).unwrap();
    x_bookmarks::storage::record_saved_media(&d.c(), KEY, url, &path).unwrap();
    path
}

async fn round(d: &Device, remote: &OssStore, ns: &str, device: &str) {
    crate::reading_sync::sync_database(&d.db, remote, ns, device)
        .await
        .unwrap();
    sync(&d.db, remote, ns, device).await.unwrap();
}

async fn receive(d: &Device, remote: &OssStore, ns: &str) {
    round(d, remote, ns, "consumer").await;
    // The next real round publishes the aggregate snapshot staged after receiving changes.
    crate::reading_sync::sync_database(&d.db, remote, ns, "consumer")
        .await
        .unwrap();
}

fn plan(d: &Device, ns: &str, extras: bool) -> Value {
    serde_json::to_value(recovery::plan(&d.c(), ns, KEY, extras).unwrap()).unwrap()
}

async fn execute(
    d: &Device,
    remote: &OssStore,
    ns: &str,
    extras: bool,
    p: &Value,
) -> Result<Value, String> {
    recovery::execute(&d.db, remote, ns, KEY, extras, p["token"].as_str().unwrap())
        .await
        .map(|v| serde_json::to_value(v).unwrap())
}

fn manifest(d: &Device, ns: &str, url: &str) -> Manifest {
    let (post, _) = current(&d.c(), KEY).unwrap();
    load_manifest(&d.c(), ns, KEY, &post, url).unwrap().unwrap()
}

fn expected_cloud_bytes(
    d: &Device,
    ns: &str,
    server: &crate::flashcard_cloud_sync::tests::Server,
) -> u64 {
    let body_id: String = d
        .c()
        .query_row(
            "SELECT id FROM reading_sync_uploaded WHERE namespace=?1 AND item_key=?2",
            params![ns, KEY],
            |r| r.get(0),
        )
        .unwrap();
    let (_, urls) = originals(&d.c(), KEY).unwrap();
    let objects = server.state.lock().unwrap();
    let body_key = format!("HubFlashcards/v2/reading/v1/changes/{body_id}.json");
    let mut size = objects.files.get(&body_key).unwrap().0.len() as u64;
    let mut blobs = std::collections::BTreeSet::new();
    for url in urls {
        let m = manifest(d, ns, &url);
        let id = hash(&serde_json::to_vec(&m).unwrap());
        let key = format!("HubFlashcards/v2/{MANIFESTS}{id}.json");
        size += objects.files.get(&key).unwrap().0.len() as u64;
        if blobs.insert(m.hash.clone()) {
            let key = format!("HubFlashcards/v2/reading/media-v1/blobs/{}", m.hash);
            size += objects.files.get(&key).unwrap().0.len() as u64;
        }
    }
    size
}

#[tokio::test]
async fn reading_recovery_reads_cloud_again_and_cache_cannot_hide_missing_or_corrupt_cloud() {
    let s = server().await;
    let remote = store(&s);
    let a = Device::new();
    let b = Device::new();
    let ns = configure(&a);
    configure(&b);
    import(&a, post(&[URL]));
    let original = source(&a, URL, "original.png", &png());
    round(&a, &remote, &ns, "producer").await;
    receive(&b, &remote, &ns).await;
    download(
        &b.db,
        &remote,
        &ns,
        KEY,
        URL,
        &policy(&b.c()).unwrap(),
        false,
    )
    .await
    .unwrap();
    let cached = local_path(&b.c(), KEY, URL).unwrap();
    cache::pin(&b.c(), &b.db, &ns, KEY, URL).unwrap();
    let m = manifest(&b, &ns, URL);
    let blob_key = remote.key(&format!("reading/media-v1/blobs/{}", m.hash));
    let cloud = s.state.lock().unwrap().files.clone();
    let expected = expected_cloud_bytes(&b, &ns, &s);
    fs::write(&cached, b"damaged local cache").unwrap();
    for _ in 0..2 {
        let before = remote.transferred().1;
        let out = execute(&b, &remote, &ns, false, &plan(&b, &ns, false))
            .await
            .unwrap();
        assert_eq!(out["bodyVerified"], true);
        assert_eq!(out["verified"], 1);
        assert_eq!(out["complete"], true);
        assert_eq!(remote.transferred().1 - before, expected);
        assert_eq!(fs::read(&cached).unwrap(), b"damaged local cache");
    }
    // A valid pinned cache must not conceal corruption or loss of its remote counterpart.
    fs::write(&cached, png()).unwrap();
    s.state.lock().unwrap().files.get_mut(&blob_key).unwrap().0[0] ^= 1;
    let out = execute(&b, &remote, &ns, false, &plan(&b, &ns, false))
        .await
        .unwrap();
    assert_eq!(out["complete"], false);
    assert_eq!(out["verified"], 0);
    assert!(!out["failures"].as_array().unwrap().is_empty());
    s.state.lock().unwrap().files.remove(&blob_key);
    let out = execute(&b, &remote, &ns, false, &plan(&b, &ns, false))
        .await
        .unwrap();
    assert_eq!(out["complete"], false);
    assert_eq!(out["verified"], 0);
    s.state.lock().unwrap().files = cloud.clone();
    let manifest_key = remote.key(&format!(
        "{MANIFESTS}{}.json",
        hash(&serde_json::to_vec(&m).unwrap())
    ));
    s.state
        .lock()
        .unwrap()
        .files
        .get_mut(&manifest_key)
        .unwrap()
        .0[0] ^= 1;
    assert_eq!(
        execute(&b, &remote, &ns, false, &plan(&b, &ns, false))
            .await
            .unwrap()["complete"],
        false
    );
    s.state.lock().unwrap().files = cloud;
    let body_id: String = b
        .c()
        .query_row(
            "SELECT id FROM reading_sync_uploaded WHERE namespace=?1 AND item_key=?2",
            params![ns, KEY],
            |r| r.get(0),
        )
        .unwrap();
    let body_key = remote.key(&format!("reading/v1/changes/{body_id}.json"));
    s.state.lock().unwrap().files.get_mut(&body_key).unwrap().0[0] ^= 1;
    let out = execute(&b, &remote, &ns, false, &plan(&b, &ns, false))
        .await
        .unwrap();
    assert_eq!(out["bodyVerified"], false);
    assert_eq!(out["complete"], false);
    assert_eq!(fs::read(original).unwrap(), png());
    assert_eq!(fs::read(cached).unwrap(), png());
    assert!(cache::pinned(&b.c(), &m.hash).unwrap());
    for table in [
        "collection_library_jobs",
        "collection_x_outbox",
        "collection_property_updates",
        "collection_obsidian_exports",
    ] {
        assert_eq!(
            b.c()
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                    .get::<_, usize>(0))
                .unwrap(),
            0
        );
    }
}

#[tokio::test]
async fn reading_recovery_manual_gates_reject_without_network_or_quota_and_shared_blob_counts_once()
{
    let s = server().await;
    let remote = store(&s);
    let a = Device::new();
    let b = Device::new();
    let ns = configure(&a);
    configure(&b);
    import(&a, post(&[URL, SECOND]));
    source(&a, URL, "first.png", &png());
    source(&a, SECOND, "second.png", &png());
    round(&a, &remote, &ns, "producer").await;
    receive(&b, &remote, &ns).await;
    let expected = expected_cloud_bytes(&b, &ns, &s);
    assert_eq!(manifest(&b, &ns, URL).hash, manifest(&b, &ns, SECOND).hash);
    for setting in ["cloud_sync_enabled", "cloud_sync_reading"] {
        let p = plan(&b, &ns, false);
        meta(&b.c(), setting, "0").unwrap();
        let before = remote.transferred().1;
        let reserved = metadata_u64(&b.c(), "reading_media_reserved", 0);
        assert!(execute(&b, &remote, &ns, false, &p).await.is_err());
        assert_eq!(remote.transferred().1, before);
        assert_eq!(metadata_u64(&b.c(), "reading_media_reserved", 0), reserved);
        meta(&b.c(), setting, "1").unwrap();
    }
    let p = plan(&b, &ns, false);
    let blocked = store(&s).with_network_guard(
        remote.key("reading/"),
        std::sync::Arc::new(|| Err("metered network blocked by fixture".into())),
    );
    let reserved = metadata_u64(&b.c(), "reading_media_reserved", 0);
    assert!(execute(&b, &blocked, &ns, false, &p).await.is_err());
    assert_eq!(blocked.transferred().1, 0);
    assert_eq!(metadata_u64(&b.c(), "reading_media_reserved", 0), reserved);
    let before = remote.transferred().1;
    let out = execute(&b, &remote, &ns, false, &plan(&b, &ns, false))
        .await
        .unwrap();
    assert_eq!(out["complete"], true);
    assert_eq!(out["verified"], 2);
    assert_eq!(remote.transferred().1 - before, expected);
    assert_eq!(metadata_string(&b.c(), "cloud_sync_auto"), "0");
    assert!(local_path(&b.c(), KEY, URL).is_none());
    assert!(local_path(&b.c(), KEY, SECOND).is_none());
    let m = manifest(&b, &ns, URL);
    let blob = remote.key(&format!("reading/media-v1/blobs/{}", m.hash));
    s.state.lock().unwrap().files.get_mut(&blob).unwrap().0[0] ^= 1;
    let before = remote.transferred().1;
    let reserved = metadata_u64(&b.c(), "reading_media_reserved", 0);
    let p = plan(&b, &ns, false);
    assert_eq!(p["downloadBytes"], expected);
    let out = execute(&b, &remote, &ns, false, &p).await.unwrap();
    assert_eq!(out["complete"], false);
    assert_eq!(out["verified"], 0);
    assert_eq!(out["failures"].as_array().unwrap().len(), 2);
    assert_eq!(remote.transferred().1 - before, expected);
    assert_eq!(
        metadata_u64(&b.c(), "reading_media_reserved", 0) - reserved,
        expected
    );
}

#[tokio::test]
async fn reading_recovery_partial_missing_oversize_and_explicit_extras_never_count_as_full() {
    let s = server().await;
    let remote = store(&s);
    let a = Device::new();
    let b = Device::new();
    let ns = configure(&a);
    configure(&b);
    let mut large = png();
    large.resize((MB + 1) as usize, 0);
    import(&a, post(&[URL, LARGE, ZIP, MISSING]));
    source(&a, URL, "small.png", &png());
    let original_large = source(&a, LARGE, "large.png", &large);
    source(&a, ZIP, "archive.zip", b"PK\x03\x04zip recovery fixture");
    round(&a, &remote, &ns, "producer").await;
    let p = policy(&a.c()).unwrap();
    stage(&a.c(), &ns, "producer", &p, Some((KEY, ZIP))).unwrap();
    upload_pending(&a.db, &remote, &ns, &p, Some((KEY, ZIP)))
        .await
        .unwrap();
    let p = Policy {
        image_mb: 1,
        ..policy(&b.c()).unwrap()
    };
    meta(
        &b.c(),
        "reading_media_policy",
        &serde_json::to_string(&p).unwrap(),
    )
    .unwrap();
    receive(&b, &remote, &ns).await;
    assert_eq!(manifest(&b, &ns, MISSING).state, "missing");
    assert_eq!(manifest(&b, &ns, ZIP).state, "ready");
    for (extras, verified) in [(false, 2), (true, 3)] {
        let out = execute(&b, &remote, &ns, extras, &plan(&b, &ns, extras))
            .await
            .unwrap();
        assert_eq!(out["bodyVerified"], true);
        assert_eq!(out["verified"], verified);
        assert_eq!(out["complete"], false);
        assert!(!out["failures"].as_array().unwrap().is_empty());
        assert_eq!(out["plan"]["total"], 4);
    }
    assert_eq!(fs::read(original_large).unwrap(), large);
    // The same exact producer now publishes a fully recoverable body with only the two small files.
    import(&a, post(&[URL, ZIP]));
    round(&a, &remote, &ns, "producer").await;
    stage(
        &a.c(),
        &ns,
        "producer",
        &policy(&a.c()).unwrap(),
        Some((KEY, ZIP)),
    )
    .unwrap();
    upload_pending(
        &a.db,
        &remote,
        &ns,
        &policy(&a.c()).unwrap(),
        Some((KEY, ZIP)),
    )
    .await
    .unwrap();
    receive(&b, &remote, &ns).await;
    assert_eq!(
        execute(&b, &remote, &ns, false, &plan(&b, &ns, false))
            .await
            .unwrap()["complete"],
        false
    );
    assert_eq!(
        execute(&b, &remote, &ns, true, &plan(&b, &ns, true))
            .await
            .unwrap()["complete"],
        true
    );
    let before = remote.transferred().1;
    let reserved = metadata_u64(&b.c(), "reading_media_reserved", 0);
    let old_plan = plan(&b, &ns, true);
    let mut p = policy(&b.c()).unwrap();
    p.enabled = false;
    meta(
        &b.c(),
        "reading_media_policy",
        &serde_json::to_string(&p).unwrap(),
    )
    .unwrap();
    assert!(execute(&b, &remote, &ns, true, &old_plan).await.is_err());
    assert_eq!(remote.transferred().1, before);
    assert_eq!(metadata_u64(&b.c(), "reading_media_reserved", 0), reserved);
}

#[tokio::test]
async fn reading_recovery_body_only_passes_but_unknown_partial_or_missing_original_cannot_pass() {
    let s = server().await;
    let remote = store(&s);
    let a = Device::new();
    let ns = configure(&a);
    let mut p = policy(&a.c()).unwrap();
    p.enabled = false;
    meta(
        &a.c(),
        "reading_media_policy",
        &serde_json::to_string(&p).unwrap(),
    )
    .unwrap();
    import(&a, post(&[]));
    round(&a, &remote, &ns, "producer").await;
    let out = execute(&a, &remote, &ns, false, &plan(&a, &ns, false))
        .await
        .unwrap();
    assert_eq!(out["bodyVerified"], true);
    assert_eq!(out["verified"], 0);
    assert_eq!(out["complete"], true);
    let mut cases = Vec::new();
    let mut partial = post(&[]);
    partial.content_status = "partial".into();
    cases.push(partial);
    let mut unknown = post(&[]);
    unknown.content_status.clear();
    cases.push(unknown);
    cases.push(post(&[""]));
    let mut quote = post(&[]);
    quote.quote_id = "unfetched-quote".into();
    cases.push(quote);
    let mut reply = post(&[]);
    reply.reply_count = 1;
    reply.thread_format = 0;
    cases.push(reply);
    for value in cases {
        import(&a, value);
        round(&a, &remote, &ns, "producer").await;
        let p = plan(&a, &ns, false);
        assert!(!p["warnings"].as_array().unwrap().is_empty());
        let out = execute(&a, &remote, &ns, false, &p).await.unwrap();
        assert_eq!(out["complete"], false);
        assert_eq!(out["verified"], 0);
    }
    assert!(crate::reading_sync::require_source_preservation(&a.c()).is_err());
    meta(&a.c(), "cloud_sync_enabled", "0").unwrap();
    assert!(crate::reading_sync::require_source_preservation(&a.c()).is_err());
}

#[tokio::test]
async fn reading_recovery_restart_stale_versions_and_namespace_races_invalidate_receipts() {
    let s = server().await;
    let remote = store(&s);
    let a = Device::new();
    let b = Device::new();
    let ns = configure(&a);
    configure(&b);
    import(&a, post(&[URL]));
    source(&a, URL, "original.png", &png());
    round(&a, &remote, &ns, "producer").await;
    receive(&b, &remote, &ns).await;
    let original_plan = plan(&b, &ns, false);
    let out = execute(&b, &remote, &ns, false, &original_plan)
        .await
        .unwrap();
    assert_eq!(out["complete"], true);
    forget_initialized_database(&b.db);
    let reopened = plan(&b, &ns, false);
    assert_eq!(reopened["previous"], "complete");
    assert!(reopened["checkedAt"].as_i64().unwrap() > 0);
    assert!(crate::reading_sync::require_source_preservation(&b.c()).is_err());
    let mut changed = post(&[URL]);
    changed.text = "new body revision".into();
    import(&a, changed);
    round(&a, &remote, &ns, "producer").await;
    receive(&b, &remote, &ns).await;
    let next_plan = plan(&b, &ns, false);
    assert_ne!(next_plan["postHash"], original_plan["postHash"]);
    assert_eq!(next_plan["checkedAt"], 0);
    let before = remote.transferred().1;
    let reserved = metadata_u64(&b.c(), "reading_media_reserved", 0);
    assert!(execute(&b, &remote, &ns, false, &original_plan)
        .await
        .is_err());
    assert_eq!(remote.transferred().1, before);
    assert_eq!(metadata_u64(&b.c(), "reading_media_reserved", 0), reserved);
    let original_config = metadata_string(&b.c(), "flashcard_oss_config");
    let mut other: crate::flashcard_object_store::OssConfig =
        serde_json::from_str(&original_config).unwrap();
    other.prefix = "AnotherReadingScope".into();
    meta(
        &b.c(),
        "flashcard_oss_config",
        &serde_json::to_string(&other).unwrap(),
    )
    .unwrap();
    assert!(execute(&b, &remote, &ns, false, &next_plan).await.is_err());
    assert_eq!(remote.transferred().1, before);
    assert_eq!(metadata_u64(&b.c(), "reading_media_reserved", 0), reserved);
    meta(&b.c(), "flashcard_oss_config", &original_config).unwrap();
    let p = plan(&b, &ns, false);
    let calls = std::sync::Arc::new(AtomicUsize::new(0));
    let guard_calls = calls.clone();
    let db = b.db.clone();
    let altered = serde_json::to_string(&other).unwrap();
    let racing = store(&s).with_network_guard(
        remote.key("reading/"),
        std::sync::Arc::new(move || {
            if guard_calls.fetch_add(1, AtomicOrdering::SeqCst) == 2 {
                let (c, _writer) = open_write_database(&db)?;
                meta(&c, "flashcard_oss_config", &altered)?;
            }
            Ok(())
        }),
    );
    assert!(execute(&b, &racing, &ns, false, &p).await.is_err());
    assert!(calls.load(AtomicOrdering::SeqCst) >= 3);
    assert!(racing.transferred().1 > 0);
    meta(&b.c(), "flashcard_oss_config", &original_config).unwrap();
    let failed = plan(&b, &ns, false);
    assert_eq!(failed["previous"], "failed");
    assert_eq!(failed["checkedAt"], 0);
    assert!(crate::reading_sync::require_source_preservation(&b.c()).is_err());
}
