use super::super::super::offline;
use super::*;
fn enable(d: &Device) {
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
    for (k, v) in [
        ("cloud_sync_enabled", "1"),
        ("cloud_sync_reading", "1"),
        ("flashcard_cloud_provider", "oss"),
    ] {
        meta(&d.c(), k, v).unwrap();
    }
}
fn seed(d: &Device, assets: Vec<(&str, Vec<u8>)>, partial: bool) {
    x_bookmarks::reading_sync_test_import_managed(
        &mut d.c(),
        Post {
            id: "media".into(),
            text: "可离线阅读的正文".into(),
            content_status: if partial { "partial" } else { "complete" }.into(),
            media: assets
                .iter()
                .map(|(url, _)| crate::collection_models::Media {
                    kind: "photo".into(),
                    url: (*url).into(),
                    preview_url: String::new(),
                })
                .collect(),
            ..Post::default()
        },
    );
    for (index, (url, bytes)) in assets.iter().enumerate() {
        let path = d.root.join(format!("source-{index}"));
        fs::write(&path, bytes).unwrap();
        x_bookmarks::storage::record_saved_media(&d.c(), KEY, url, &path).unwrap();
    }
}
fn preview(d: &Device, extras: bool) -> Value {
    serde_json::to_value(offline::plan(&d.c(), &d.db, NS, KEY, extras).unwrap()).unwrap()
}
async fn run(
    d: &Device,
    remote: Option<&OssStore>,
    extras: bool,
    p: &Value,
) -> Result<Value, String> {
    offline::execute(
        &d.db,
        remote.map(|v| v as &dyn ReadingStore),
        NS,
        KEY,
        extras,
        p["token"].as_str().unwrap(),
    )
    .await
    .map(|v| serde_json::to_value(v).unwrap())
}
#[tokio::test]
async fn reading_offline_real_transport_pins_and_survives_restart_without_cloud_access() {
    let s = server().await;
    let remote = store(&s);
    let a = Device::new();
    let b = Device::new();
    enable(&b);
    seed(&a, vec![(URL, png())], false);
    a.round(&remote, "a").await;
    b.round(&remote, "b").await;
    let p = preview(&b, false);
    assert_eq!(p["complete"], false);
    assert_eq!(p["downloadBytes"], png().len());
    let result = run(&b, Some(&remote), false, &p).await.unwrap();
    assert_eq!(result["plan"]["complete"], true);
    let path = local_path(&b.c(), KEY, URL).unwrap();
    assert_eq!(fs::read(&path).unwrap(), png());
    assert!(cache::pinned(&b.c(), &b.manifest().hash).unwrap());
    let summary = serde_json::to_value(cache::status(&b.c(), &b.db).unwrap()).unwrap();
    assert_eq!(summary["removableCount"], 0);
    forget_initialized_database(&b.db);
    assert_eq!(preview(&b, false)["complete"], true);
    // A batch interrupted after its file commit is reconciled by real bytes, not an old success flag.
    b.c()
        .execute("UPDATE reading_offline_runs SET state='running'", [])
        .unwrap();
    assert_eq!(preview(&b, false)["previous"], "interrupted");
    cache::unpin(&b.c(), &b.manifest().hash).unwrap();
    meta(&b.c(), "cloud_sync_enabled", "0").unwrap();
    let before = metadata_u64(&b.c(), "reading_media_reserved", 0);
    let result = run(&b, None, false, &preview(&b, false)).await.unwrap();
    assert_eq!(result["plan"]["complete"], true);
    assert_eq!(metadata_u64(&b.c(), "reading_media_reserved", 0), before);
    assert_eq!(
        x_bookmarks::reading_sync_test_items(&b.c(), "all")[0]["post"]["text"],
        "可离线阅读的正文"
    );
    for table in [
        "collection_library_jobs",
        "collection_x_outbox",
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
async fn reading_offline_explicit_extras_and_missing_body_never_claim_complete() {
    let s = server().await;
    let remote = store(&s);
    let a = Device::new();
    let b = Device::new();
    enable(&b);
    let zip = "https://example.invalid/a.zip";
    seed(
        &a,
        vec![(URL, png()), (zip, b"PK\x03\x04test zipped bytes".to_vec())],
        true,
    );
    a.round(&remote, "a").await;
    // The original producer only publishes ZIP bytes after an explicit item upload.
    stage(&a.c(), NS, "a", &policy(&a.c()).unwrap(), Some((KEY, zip))).unwrap();
    upload_pending(
        &a.db,
        &remote,
        NS,
        &policy(&a.c()).unwrap(),
        Some((KEY, zip)),
    )
    .await
    .unwrap();
    b.round(&remote, "b").await;
    let p = preview(&b, false);
    assert!(p["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["state"] == "excluded"));
    let result = run(&b, Some(&remote), false, &p).await.unwrap();
    assert_eq!(result["plan"]["complete"], false);
    assert_eq!(result["plan"]["available"], 1);
    let result = run(&b, Some(&remote), true, &preview(&b, true))
        .await
        .unwrap();
    assert_eq!(result["plan"]["available"], 2);
    assert_eq!(result["plan"]["complete"], false);
    assert_eq!(result["plan"]["warnings"].as_array().unwrap().len(), 1);
}
#[tokio::test]
async fn reading_offline_retired_budgets_do_not_split_explicit_downloads() {
    let s = server().await;
    let remote = store(&s);
    let a = Device::new();
    let b = Device::new();
    enable(&b);
    let mut bytes = png();
    bytes.resize(3 * 1024 * 1024, 0);
    let mut other = bytes.clone();
    other.push(1);
    seed(
        &a,
        vec![(URL, bytes), ("https://example.invalid/z.png", other)],
        false,
    );
    a.round(&remote, "a").await;
    b.round(&remote, "b").await;
    let p = Policy {
        enabled: false,
        image_mb: 1,
        batch_mb: 4,
        daily_mb: 4,
        ..policy(&b.c()).unwrap()
    };
    meta(
        &b.c(),
        "reading_media_policy",
        &serde_json::to_string(&p).unwrap(),
    )
    .unwrap();
    let result = run(&b, Some(&remote), false, &preview(&b, false))
        .await
        .unwrap();
    assert_eq!(result["succeeded"], 2);
    assert!(result["failures"].as_array().unwrap().is_empty());
    assert_eq!(result["plan"]["complete"], true);
    assert!(metadata_u64(&b.c(), "reading_media_reserved", 0) > 4 * MB);
    let transferred = remote.transferred();
    assert_eq!(preview(&b, false)["complete"], true);
    assert_eq!(remote.transferred(), transferred);
}

#[tokio::test]
async fn reading_offline_rejects_stale_preview_and_paused_download_then_repairs_corruption() {
    let s = server().await;
    let remote = store(&s);
    let a = Device::new();
    let b = Device::new();
    enable(&b);
    seed(&a, vec![(URL, png())], false);
    a.round(&remote, "a").await;
    b.round(&remote, "b").await;
    let stale = preview(&b, false);
    let p = Policy {
        image_mb: 9,
        ..policy(&b.c()).unwrap()
    };
    meta(
        &b.c(),
        "reading_media_policy",
        &serde_json::to_string(&p).unwrap(),
    )
    .unwrap();
    assert!(run(&b, Some(&remote), false, &stale)
        .await
        .unwrap_err()
        .contains("重新检查"));
    meta(&b.c(), "cloud_sync_enabled", "0").unwrap();
    assert!(run(&b, Some(&remote), false, &preview(&b, false))
        .await
        .unwrap_err()
        .contains("暂停"));
    assert!(local_path(&b.c(), KEY, URL).is_none());
    meta(&b.c(), "cloud_sync_enabled", "1").unwrap();
    s.state.lock().unwrap().corrupt = true;
    let failed = run(&b, Some(&remote), false, &preview(&b, false))
        .await
        .unwrap();
    assert_eq!(failed["plan"]["complete"], false);
    assert_eq!(failed["succeeded"], 0);
    assert!(!cache::pinned(&b.c(), &b.manifest().hash).unwrap());
    s.state.lock().unwrap().corrupt = false;
    assert_eq!(
        run(&b, Some(&remote), false, &preview(&b, false))
            .await
            .unwrap()["plan"]["complete"],
        true
    );
    let p = preview(&b, false);
    fs::write(local_path(&b.c(), KEY, URL).unwrap(), b"broken").unwrap();
    assert_eq!(preview(&b, false)["complete"], false);
    assert!(run(&b, Some(&remote), false, &p).await.is_err());
    assert_eq!(
        run(&b, Some(&remote), false, &preview(&b, false))
            .await
            .unwrap()["plan"]["complete"],
        true
    );
    let old = preview(&b, false);
    seed(&a, vec![(URL, png())], true);
    a.round(&remote, "a").await;
    b.round(&remote, "b").await;
    assert!(run(&b, Some(&remote), false, &old).await.is_err());
}
#[tokio::test]
async fn reading_offline_unsynced_manifest_stays_unavailable_and_body_only_is_supported() {
    let s = server().await;
    let remote = store(&s);
    let a = Device::new();
    let b = Device::new();
    seed(&a, vec![(URL, png())], false);
    super::super::super::super::sync_database(&a.db, &remote, NS, "a")
        .await
        .unwrap();
    super::super::super::super::sync_database(&b.db, &remote, NS, "b")
        .await
        .unwrap();
    let p = preview(&b, false);
    assert_eq!(p["complete"], false);
    assert_eq!(p["actionable"], 0);
    assert_eq!(p["items"][0]["state"], "unavailable");
    seed(&a, vec![], false);
    assert_eq!(preview(&a, false)["complete"], true);
}
