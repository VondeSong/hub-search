use super::*;
use crate::collection_models::Media;
use crate::reading_sync::media::offline;

const VIDEO: &str = "telegram://7/video/large.mp4";
const COVER: &str = "telegram://7/thumb/cover.png";
const OTHER_COVER: &str = "telegram://7/thumb/other-cover.png";

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
        ("flashcard_cloud_provider", "oss"),
    ] {
        meta(&d.c(), key, value).unwrap();
    }
    config.namespace()
}

fn post(id: &str, preview: &str) -> Post {
    Post {
        id: id.into(),
        text: "thumbnail compatibility fixture".into(),
        content_status: "complete".into(),
        media: vec![Media {
            kind: "video".into(),
            url: VIDEO.into(),
            preview_url: preview.into(),
        }],
        ..Post::default()
    }
}

fn import(d: &Device, post: Post) {
    x_bookmarks::reading_sync_test_import_managed(&mut d.c(), post);
}

fn save_file(d: &Device, key: &str, url: &str, name: &str, bytes: &[u8]) -> PathBuf {
    let path = d.root.join(name);
    fs::write(&path, bytes).unwrap();
    x_bookmarks::storage::record_saved_media(&d.c(), key, url, &path).unwrap();
    path
}

async fn round(d: &Device, remote: &OssStore, ns: &str, device: &str) -> Summary {
    crate::reading_sync::sync_database(&d.db, remote, ns, device)
        .await
        .unwrap();
    sync(&d.db, remote, ns, device).await.unwrap()
}

fn manifest(d: &Device, ns: &str, key: &str, url: &str) -> Manifest {
    let (post, _) = current(&d.c(), key).unwrap();
    load_manifest(&d.c(), ns, key, &post, url).unwrap().unwrap()
}

fn item(d: &Device, key: &str) -> Value {
    x_bookmarks::reading_sync_test_items(&d.c(), "all")
        .into_iter()
        .find(|item| item["key"] == key)
        .unwrap()
}

fn mp4() -> Vec<u8> {
    b"\0\0\0\x18ftypmp42\0\0\0\0mp42isom\0\0\0\x10mdat01234567".to_vec()
}

#[test]
fn reading_thumbnail_batch_projection_preserves_current_policy_and_eviction_checks() {
    let device = Device::new();
    let namespace = configure(&device);
    let c = device.c();
    let mut posts = Vec::new();
    for (number, id) in ["first", "evicted", "original", "stale"].iter().enumerate() {
        let key = format!("telegram:test-account:{id}");
        let mut source = post(id, COVER);
        if *id == "original" {
            source.media[0].url = COVER.into();
        }
        import(&device, source);
        let (post_hash, _) = current(&c, &key).unwrap();
        let digest = hash(&[number as u8]);
        let manifest = Manifest {
            format: 1,
            key: key.clone(),
            post_hash: if *id == "stale" {
                "0".repeat(64)
            } else {
                post_hash
            },
            url: COVER.into(),
            version: Version {
                clock: 1,
                device: "fixture".into(),
            },
            hash: digest.clone(),
            size: 100,
            mime: "image/png".into(),
            state: "ready".into(),
        };
        c.execute("INSERT INTO reading_media_manifests(namespace,item_key,post_hash,url,body) VALUES(?1,?2,?3,?4,?5)",
            params![namespace,key,manifest.post_hash,COVER,serde_json::to_string(&manifest).unwrap()]).unwrap();
        if *id == "evicted" {
            c.execute(
                "INSERT INTO reading_media_evicted(hash) VALUES(?1)",
                [digest],
            )
            .unwrap();
        }
        let raw: String = c
            .query_row(
                "SELECT post_json FROM collection_x_items WHERE item_key=?1",
                [&key],
                |r| r.get(0),
            )
            .unwrap();
        posts.push((key, raw));
    }
    c.execute_batch("PRAGMA query_only=ON").unwrap();
    let writes = c.total_changes();
    let batch = crate::reading_sync::media::ready_previews_page(
        &c,
        posts.iter().map(|(key, raw)| (key.as_str(), raw.as_str())),
        &namespace,
    )
    .unwrap();
    for (key, _) in &posts {
        assert_eq!(
            batch.get(key).cloned().unwrap_or_default(),
            ready_previews(&c, key, &namespace).unwrap()
        );
    }
    assert_eq!(
        batch.get("telegram:test-account:first"),
        Some(&vec![COVER.to_string()])
    );
    assert_eq!(batch.len(), 1);
    assert_eq!(c.total_changes(), writes);
    c.execute_batch("PRAGMA query_only=OFF").unwrap();
    meta(&c, "cloud_sync_reading", "0").unwrap();
    assert!(crate::reading_sync::media::ready_previews_page(
        &c,
        posts.iter().map(|(key, raw)| (key.as_str(), raw.as_str())),
        &namespace
    )
    .unwrap()
    .is_empty());
}

#[tokio::test]
async fn reading_thumbnail_real_transport_projects_cover_without_claiming_video_offline() {
    let server = server().await;
    let remote = store(&server);
    let a = Device::new();
    let b = Device::new();
    let ns = configure(&a);
    assert_eq!(configure(&b), ns);
    import(&a, post("media", COVER));
    let source = save_file(&a, KEY, COVER, "source-cover.png", &png());

    // The actual outbox producer is blocked before any quota is reserved.
    stage(&a.c(), &ns, "a", &policy(&a.c()).unwrap(), None).unwrap();
    let reserved = metadata_u64(&a.c(), "reading_media_reserved", 0);
    let blocked = store(&server).with_network_guard(
        remote.key("reading/"),
        std::sync::Arc::new(|| Err("reading network fixture paused".into())),
    );
    assert!(upload_pending(
        &a.db,
        &blocked,
        &ns,
        &policy(&a.c()).unwrap(),
        Some((KEY, COVER)),
    )
    .await
    .is_err());
    assert_eq!(metadata_u64(&a.c(), "reading_media_reserved", 0), reserved);
    assert_eq!(
        a.c()
            .query_row(
                "SELECT count(*) FROM reading_media_outbox WHERE namespace=?1 AND json_extract(body,'$.url')=?2",
                params![ns, COVER],
                |r| r.get::<_, usize>(0),
            )
            .unwrap(),
        1
    );

    upload_pending(
        &a.db,
        &remote,
        &ns,
        &policy(&a.c()).unwrap(),
        Some((KEY, COVER)),
    )
    .await
    .unwrap();
    round(&a, &remote, &ns, "a").await;
    assert_eq!(manifest(&a, &ns, KEY, COVER).state, "ready");
    assert_eq!(manifest(&a, &ns, KEY, VIDEO).state, "missing");
    assert_eq!(round(&b, &remote, &ns, "b").await.downloaded, 0);
    assert!(local_path(&b.c(), KEY, COVER).is_none());
    assert_eq!(ready_previews(&b.c(), KEY, &ns).unwrap(), vec![COVER]);
    assert_eq!(item(&b, KEY)["cloudPreviewUrls"], json!([COVER]));
    assert_eq!(item(&b, KEY)["savedMedia"], json!([]));

    download(
        &b.db,
        &remote,
        &ns,
        KEY,
        COVER,
        &policy(&b.c()).unwrap(),
        false,
    )
    .await
    .unwrap();
    let id: i64 = b
        .c()
        .query_row(
            "SELECT local_seq FROM collection_saved_media WHERE item_key=?1 AND media_url=?2",
            params![KEY, COVER],
            |r| r.get(0),
        )
        .unwrap();
    let consumer = x_bookmarks::storage::recorded_media_path(&b.c(), id).unwrap();
    assert_eq!(fs::read(consumer).unwrap(), png());
    assert_eq!(item(&b, KEY)["savedMedia"], json!([COVER]));
    assert!(local_path(&b.c(), KEY, VIDEO).is_none());
    for switch in ["cloud_sync_enabled", "cloud_sync_reading"] {
        meta(&b.c(), switch, "0").unwrap();
        assert_eq!(item(&b, KEY)["cloudPreviewUrls"], json!([]));
        assert_eq!(item(&b, KEY)["savedMedia"], json!([COVER]));
        meta(&b.c(), switch, "1").unwrap();
    }
    let p = policy(&b.c()).unwrap();
    meta(
        &b.c(),
        "reading_media_policy",
        &serde_json::to_string(&Policy {
            enabled: false,
            ..p.clone()
        })
        .unwrap(),
    )
    .unwrap();
    assert_eq!(item(&b, KEY)["cloudPreviewUrls"], json!([]));
    assert_eq!(item(&b, KEY)["savedMedia"], json!([COVER]));
    meta(
        &b.c(),
        "reading_media_policy",
        &serde_json::to_string(&p).unwrap(),
    )
    .unwrap();
    assert_eq!(item(&b, KEY)["cloudPreviewUrls"], json!([COVER]));
    let offline =
        serde_json::to_value(offline::plan(&b.c(), &b.db, &ns, KEY, false).unwrap()).unwrap();
    assert_eq!(offline["total"], 1);
    assert_eq!(offline["complete"], false);
    assert_eq!(offline["items"][0]["url"], VIDEO);
    assert_eq!(fs::read(source).unwrap(), png());
    for (key, (bytes, _)) in &server.state.lock().unwrap().files {
        if key.contains("/manifests/") {
            let value: Value = serde_json::from_slice(bytes).unwrap();
            assert_eq!(value["format"], 1);
            assert!(value.get("role").is_none());
            assert!(!String::from_utf8_lossy(bytes).contains("source-cover.png"));
        }
    }
}

#[tokio::test]
async fn reading_thumbnail_auto_cache_reuse_pin_cleanup_and_body_change_reach_projection() {
    let server = server().await;
    let remote = store(&server);
    let a = Device::new();
    let b = Device::new();
    let ns = configure(&a);
    configure(&b);
    import(&a, post("media", COVER));
    save_file(&a, KEY, COVER, "source-cover.png", &png());
    round(&a, &remote, &ns, "a").await;
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
    assert_eq!(round(&b, &remote, &ns, "b").await.downloaded, 1);
    let path = local_path(&b.c(), KEY, COVER).unwrap();
    let m = manifest(&b, &ns, KEY, COVER);
    let other_key = "telegram:test-account:other";
    import(&a, post("other", OTHER_COVER));
    save_file(&a, other_key, OTHER_COVER, "other-source.png", &png());
    round(&a, &remote, &ns, "a").await;
    // Receive the second article without automatically consuming its blob.
    meta(
        &b.c(),
        "reading_media_policy",
        &serde_json::to_string(&Policy {
            download: "onDemand".into(),
            ..p.clone()
        })
        .unwrap(),
    )
    .unwrap();
    round(&b, &remote, &ns, "b").await;
    let reserved = metadata_u64(&b.c(), "reading_media_reserved", 0);
    let blocked = store(&server).with_network_guard(
        remote.key("reading/"),
        std::sync::Arc::new(|| Err("reading network fixture paused".into())),
    );
    download(&b.db, &blocked, &ns, other_key, OTHER_COVER, &p, false)
        .await
        .unwrap();
    assert_eq!(local_path(&b.c(), other_key, OTHER_COVER).unwrap(), path);
    assert_eq!(metadata_u64(&b.c(), "reading_media_reserved", 0), reserved);
    cache::pin(&b.c(), &b.db, &ns, KEY, COVER).unwrap();
    let status = cache::status(&b.c(), &b.db).unwrap();
    let token = serde_json::to_value(&status).unwrap()["token"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        serde_json::to_value(cache::clean(&b.c(), &b.db, &token).unwrap()).unwrap()["removed"],
        0
    );
    cache::unpin(&b.c(), &m.hash).unwrap();
    let token = serde_json::to_value(cache::status(&b.c(), &b.db).unwrap()).unwrap()["token"]
        .as_str()
        .unwrap()
        .to_string();
    let cloud = server.state.lock().unwrap().files.clone();
    assert_eq!(
        serde_json::to_value(cache::clean(&b.c(), &b.db, &token).unwrap()).unwrap()["removed"],
        1
    );
    assert!(ready_previews(&b.c(), KEY, &ns).unwrap().is_empty());
    assert_eq!(item(&b, KEY)["cloudPreviewUrls"], json!([]));
    assert_eq!(item(&b, other_key)["savedMedia"], json!([]));
    assert_eq!(server.state.lock().unwrap().files, cloud);
    // A stale gallery capability cannot undo cleanup before its list refreshes.
    assert!(require_automatic_preview(&b.c(), &ns, KEY, COVER)
        .unwrap_err()
        .contains("主动清理"));
    meta(
        &b.c(),
        "reading_media_policy",
        &serde_json::to_string(&p).unwrap(),
    )
    .unwrap();
    assert_eq!(round(&b, &remote, &ns, "b").await.downloaded, 0);
    assert!(!path.exists());
    // Explicit use can restore a deliberately evicted cover.
    download(&b.db, &remote, &ns, KEY, COVER, &p, false)
        .await
        .unwrap();
    require_automatic_preview(&b.c(), &ns, KEY, COVER).unwrap();
    assert_eq!(ready_previews(&b.c(), KEY, &ns).unwrap(), vec![COVER]);
    import(&a, post("media", "telegram://7/thumb/new-cover.png"));
    round(&a, &remote, &ns, "a").await;
    round(&b, &remote, &ns, "b").await;
    assert!(ready_previews(&b.c(), KEY, &ns).unwrap().is_empty());
    assert_eq!(item(&b, KEY)["cloudPreviewUrls"], json!([]));
    assert!(download(&b.db, &remote, &ns, KEY, COVER, &p, true)
        .await
        .unwrap_err()
        .contains("不属于"));
}

#[tokio::test]
async fn reading_thumbnail_rejects_non_images_oversize_manual_and_untrusted_remote_mime() {
    let mut oversized = png();
    oversized.resize((2 * MB + 1) as usize, 0);
    let mut policy_oversized = png();
    policy_oversized.resize((MB + 1) as usize, 0);
    for (bytes, image_mb) in [
        (mp4(), 10),
        (b"PK\x03\x04archive fixture".to_vec(), 10),
        (oversized, 10),
        (policy_oversized, 1),
    ] {
        let server = server().await;
        let remote = store(&server);
        let a = Device::new();
        let ns = configure(&a);
        import(&a, post("media", COVER));
        save_file(&a, KEY, COVER, "untrusted-cover", &bytes);
        let p = Policy {
            image_mb,
            ..policy(&a.c()).unwrap()
        };
        meta(
            &a.c(),
            "reading_media_policy",
            &serde_json::to_string(&p).unwrap(),
        )
        .unwrap();
        round(&a, &remote, &ns, "a").await;
        assert_eq!(manifest(&a, &ns, KEY, COVER).state, "skipped");
        stage(&a.c(), &ns, "a", &p, Some((KEY, COVER))).unwrap();
        upload_pending(&a.db, &remote, &ns, &p, Some((KEY, COVER)))
            .await
            .unwrap();
        assert_eq!(manifest(&a, &ns, KEY, COVER).state, "skipped");
        assert!(!server
            .state
            .lock()
            .unwrap()
            .files
            .keys()
            .any(|key| key.contains("/blobs/")));
    }

    let server = server().await;
    let remote = store(&server);
    let a = Device::new();
    let b = Device::new();
    let ns = configure(&a);
    configure(&b);
    import(&a, post("media", COVER));
    save_file(&a, KEY, COVER, "source-cover.png", &png());
    round(&a, &remote, &ns, "a").await;
    round(&b, &remote, &ns, "b").await;
    let mut forged = manifest(&a, &ns, KEY, COVER);
    forged.version.clock += 100;
    forged.mime = "video/mp4".into();
    let bytes = serde_json::to_vec(&forged).unwrap();
    remote
        .put_verified(
            &remote.key(&format!("{MANIFESTS}{}.json", hash(&bytes))),
            &bytes,
        )
        .await
        .unwrap();
    round(&b, &remote, &ns, "b").await;
    let reserved = metadata_u64(&b.c(), "reading_media_reserved", 0);
    assert!(ready_previews(&b.c(), KEY, &ns).unwrap().is_empty());
    assert!(download(
        &b.db,
        &remote,
        &ns,
        KEY,
        COVER,
        &policy(&b.c()).unwrap(),
        true,
    )
    .await
    .is_err());
    assert_eq!(metadata_u64(&b.c(), "reading_media_reserved", 0), reserved);

    // Even a valid image declaration cannot publish actual video bytes to the cache.
    let video = mp4();
    forged.version.clock += 1;
    forged.mime = "image/png".into();
    forged.hash = hash(&video);
    forged.size = video.len() as u64;
    remote
        .put_verified(&blob_key(&remote, &forged.hash), &video)
        .await
        .unwrap();
    let bytes = serde_json::to_vec(&forged).unwrap();
    remote
        .put_verified(
            &remote.key(&format!("{MANIFESTS}{}.json", hash(&bytes))),
            &bytes,
        )
        .await
        .unwrap();
    round(&b, &remote, &ns, "b").await;
    assert!(download(
        &b.db,
        &remote,
        &ns,
        KEY,
        COVER,
        &policy(&b.c()).unwrap(),
        true,
    )
    .await
    .is_err());
    assert!(local_path(&b.c(), KEY, COVER).is_none());
    assert!(cache::pin(&b.c(), &b.db, &ns, KEY, COVER).is_err());
}

#[tokio::test]
async fn reading_thumbnail_enumeration_preserves_v1_body_hash_and_original_overlap_policy() {
    let server = server().await;
    let remote = store(&server);
    let a = Device::new();
    let ns = configure(&a);
    let mut source = post("media", COVER);
    source.thread = vec![post("reply", COVER)];
    source.quote = Some(Box::new(post("quote", COVER)));
    source.media.push(source.media[0].clone());
    import(&a, source);
    let (raw, stored_hash): (String, String) = a
        .c()
        .query_row(
            "SELECT post_json,content_hash FROM collection_x_items WHERE item_key=?1",
            [KEY],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    let (body_hash, urls) = current(&a.c(), KEY).unwrap();
    assert_eq!(body_hash, stored_hash);
    assert_eq!(hash(raw.as_bytes()), stored_hash);
    assert_eq!(urls, vec![COVER.to_string(), VIDEO.to_string()]);
    assert_eq!(originals(&a.c(), KEY).unwrap().1, vec![VIDEO.to_string()]);
    save_file(&a, KEY, COVER, "source-cover.png", &png());
    round(&a, &remote, &ns, "a").await;
    assert_eq!(current(&a.c(), KEY).unwrap().0, stored_hash);
    assert_eq!(
        a.c()
            .query_row(
                "SELECT count(*) FROM reading_media_manifests WHERE namespace=?1 AND item_key=?2",
                params![ns, KEY],
                |r| r.get::<_, usize>(0),
            )
            .unwrap(),
        2
    );

    // A URL also used as an original attachment retains the original manual-video rule.
    let mut overlap = post("media", VIDEO);
    overlap.text = "the preview URL also identifies the original".into();
    overlap.thread_status = "complete".into();
    import(&a, overlap);
    let video = mp4();
    assert_eq!(infer::get(&video).unwrap().mime_type(), "video/mp4");
    save_file(&a, KEY, VIDEO, "original-video.mp4", &video);
    round(&a, &remote, &ns, "a").await;
    assert_eq!(current(&a.c(), KEY).unwrap().1, vec![VIDEO.to_string()]);
    assert_eq!(manifest(&a, &ns, KEY, VIDEO).state, "skipped");
    stage(
        &a.c(),
        &ns,
        "a",
        &policy(&a.c()).unwrap(),
        Some((KEY, VIDEO)),
    )
    .unwrap();
    upload_pending(
        &a.db,
        &remote,
        &ns,
        &policy(&a.c()).unwrap(),
        Some((KEY, VIDEO)),
    )
    .await
    .unwrap();
    assert_eq!(manifest(&a, &ns, KEY, VIDEO).state, "ready");
    assert!(ready_previews(&a.c(), KEY, &ns).unwrap().is_empty());
}
