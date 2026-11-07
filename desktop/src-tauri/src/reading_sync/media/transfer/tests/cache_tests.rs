use super::*;

#[cfg(windows)]
#[tokio::test]
async fn reading_cache_locked_file_reports_partial_cleanup_and_retries() {
    use std::os::windows::fs::OpenOptionsExt;
    let (a, b, _server, remote) = prepare().await;
    let old_path = local_path(&b.c(), KEY, URL).unwrap();
    let mut replacement = png();
    replacement.push(0);
    a.seed(&replacement);
    a.round(&remote, "a").await;
    b.round(&remote, "b").await;
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
    assert_eq!(status(&b)["removableCount"], 2);
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&old_path)
        .unwrap();
    let result = serde_json::to_value(cache::clean(&b.c(), &b.db, &token(&b)).unwrap()).unwrap();
    assert_eq!(result["removed"], 1);
    assert_eq!(result["failures"].as_array().unwrap().len(), 1);
    assert!(old_path.is_file());
    drop(held);
    let retried = serde_json::to_value(cache::clean(&b.c(), &b.db, &token(&b)).unwrap()).unwrap();
    assert_eq!(retried["removed"], 1);
    assert_eq!(retried["status"]["removableCount"], 0);
}
fn status(d: &Device) -> Value {
    serde_json::to_value(cache::status(&d.c(), &d.db).unwrap()).unwrap()
}
fn token(d: &Device) -> String {
    status(d)["token"].as_str().unwrap().into()
}
async fn prepare() -> (
    Device,
    Device,
    crate::flashcard_cloud_sync::tests::Server,
    OssStore,
) {
    let server = server().await;
    let remote = store(&server);
    let a = Device::new();
    let b = Device::new();
    a.seed(&png());
    a.round(&remote, "a").await;
    b.round(&remote, "b").await;
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
    (a, b, server, remote)
}
#[tokio::test]
async fn reading_cache_pins_protect_shared_bytes_and_cleanup_reaches_preview_consumer() {
    let (a, b, server, _remote) = prepare().await;
    let path = local_path(&b.c(), KEY, URL).unwrap();
    x_bookmarks::storage::record_saved_media(&b.c(), "telegram:shared-reference", URL, &path)
        .unwrap();
    let cloud = server.state.lock().unwrap().files.clone();
    cache::pin(&b.c(), &b.db, NS, KEY, URL).unwrap();
    forget_initialized_database(&b.db);
    let s = status(&b);
    assert_eq!(s["pins"].as_array().unwrap().len(), 1);
    assert_eq!(s["removableCount"], 0);
    assert_eq!(s["pinnedBytes"], png().len());
    let kept = serde_json::to_value(cache::clean(&b.c(), &b.db, &token(&b)).unwrap()).unwrap();
    assert_eq!(kept["removed"], 0);
    assert!(path.is_file());
    cache::unpin(&b.c(), &b.manifest().hash).unwrap();
    assert!(path.is_file());
    let cleaned = serde_json::to_value(cache::clean(&b.c(), &b.db, &token(&b)).unwrap()).unwrap();
    assert_eq!(cleaned["removed"], 1);
    assert_eq!(cleaned["removedBytes"], png().len());
    assert!(!path.exists());
    assert!(local_path(&b.c(), KEY, URL).is_none());
    assert!(local_path(&b.c(), "telegram:shared-reference", URL).is_none());
    assert_eq!(
        x_bookmarks::reading_sync_test_items(&b.c(), "all")[0]["savedMedia"],
        json!([])
    );
    assert_eq!(fs::read(a.root.join("source.png")).unwrap(), png());
    assert_eq!(server.state.lock().unwrap().files, cloud);
}
#[tokio::test]
async fn reading_cache_stale_preview_and_pending_uploads_are_protected() {
    let (_a, b, _server, _remote) = prepare().await;
    let old = token(&b);
    cache::pin(&b.c(), &b.db, NS, KEY, URL).unwrap();
    assert!(cache::clean(&b.c(), &b.db, &old)
        .unwrap_err()
        .contains("重新预览"));
    cache::unpin(&b.c(), &b.manifest().hash).unwrap();
    let path = local_path(&b.c(), KEY, URL).unwrap();
    b.c()
        .execute(
            "INSERT INTO reading_media_outbox(namespace,id,body,path) VALUES(?1,'protected',?2,?3)",
            params![NS, b"{}".as_slice(), path.to_string_lossy()],
        )
        .unwrap();
    assert_eq!(status(&b)["removableCount"], 0);
    cache::clean(&b.c(), &b.db, &token(&b)).unwrap();
    assert!(path.is_file());
}
#[tokio::test]
async fn reading_cache_cleanup_skips_unknown_files_and_external_paths() {
    let (_a, b, _server, _remote) = prepare().await;
    let root = cache::root(&b.db).unwrap();
    let unknown = root.join("personal-note.txt");
    fs::write(&unknown, b"keep").unwrap();
    let temporary = root.join(".unfinished.tmp");
    fs::write(&temporary, b"keep").unwrap();
    let folder = root.join("user-folder");
    fs::create_dir(&folder).unwrap();
    fs::write(folder.join("keep.txt"), b"keep").unwrap();
    let external = b.root.join("external.png");
    fs::write(&external, png()).unwrap();
    x_bookmarks::storage::record_saved_media(&b.c(), "external", URL, &external).unwrap();
    b.c()
        .execute(
            "INSERT INTO reading_media_cache_files VALUES('../external.png',?1,1)",
            [hash(&png())],
        )
        .unwrap();
    assert_eq!(status(&b)["otherCount"], 3);
    cache::clean(&b.c(), &b.db, &token(&b)).unwrap();
    assert!(
        unknown.exists()
            && temporary.exists()
            && folder.join("keep.txt").exists()
            && external.exists()
    );
    assert!(local_path(&b.c(), "external", URL).is_some());
}
#[tokio::test]
async fn reading_cache_eviction_survives_restart_and_explicit_download_restores_bytes() {
    let (_a, b, _server, remote) = prepare().await;
    cache::clean(&b.c(), &b.db, &token(&b)).unwrap();
    let p = Policy {
        download: "all".into(),
        ..policy(&b.c()).unwrap()
    };
    meta(
        &b.c(),
        "reading_media_policy",
        &serde_json::to_string(&p).unwrap(),
    )
    .unwrap();
    forget_initialized_database(&b.db);
    assert_eq!(b.round(&remote, "b").await.downloaded, 0);
    assert!(local_path(&b.c(), KEY, URL).is_none());
    download(&b.db, &remote, NS, KEY, URL, &p, false)
        .await
        .unwrap();
    assert!(!cache::evicted(&b.c(), &b.manifest().hash).unwrap());
    let id = b
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
}
#[tokio::test]
async fn reading_cache_legacy_adoption_and_failed_download_never_claim_offline_pin() {
    let (_a, b, server, remote) = prepare().await;
    b.c()
        .execute("DELETE FROM reading_media_cache_files", [])
        .unwrap();
    assert_eq!(status(&b)["removableCount"], 1); // Existing v1 cache is adopted through its real saved-media record.
    cache::clean(&b.c(), &b.db, &token(&b)).unwrap();
    server.state.lock().unwrap().corrupt = true;
    assert!(
        download(&b.db, &remote, NS, KEY, URL, &policy(&b.c()).unwrap(), true)
            .await
            .is_err()
    );
    assert!(cache::pin(&b.c(), &b.db, NS, KEY, URL).is_err());
    assert_eq!(status(&b)["pins"], json!([]));
}
