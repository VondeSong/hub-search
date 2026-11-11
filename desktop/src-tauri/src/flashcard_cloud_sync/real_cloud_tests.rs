//! Explicit real OSS acceptance, always under a fresh child prefix.
use super::*;
use crate::flashcard_authoring::{import_flashcard_values, resolve_flashcard_drafts_in_connection};

#[tokio::test]
#[ignore = "explicit real OSS integration; requires HUB_OSS_INTEGRATION_CONFIG_DB and existing Windows credential"]
async fn real_oss_flashcard_directions_and_reverse_review() {
    use base64::Engine as _;
    let (config, remote, run) = crate::reading_sync::real_cloud_tests::isolated_oss("flashcards");
    let online = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let guard = online.clone();
    let prefix = remote.key("");
    let remote = remote.with_network_guard(
        prefix,
        Arc::new(move || {
            if guard.load(std::sync::atomic::Ordering::SeqCst) {
                Ok(())
            } else {
                Err("验收注入的离线门禁".into())
            }
        }),
    );
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.local/cloud-sync-acceptance-20261112")
        .join(&run);
    fs::create_dir_all(&root).unwrap();
    let ns = config.namespace();
    let a = root.join("a.sqlite3");
    let b = root.join("b.sqlite3");
    let ba = BlobStore::open(&root.join("blobs-a")).unwrap();
    let bb = BlobStore::open(&root.join("blobs-b")).unwrap();
    let png = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE+0AAAAASUVORK5CYII=").unwrap();
    let blob = ba.put(&png).unwrap();
    import_flashcard_values(&a, "manual", "隔离真云验收".into(), json!({"source":"manual"}),
        vec![json!({"question":"真云附件能否独立补传？","answer":"正文先到，附件按策略补传。", "media":[{
            "url":format!("http://craft-media.localhost/{}",blob.hash), "mimeType":"image/png", "title":"proof.png"
        }]})], true).unwrap();
    let mut c = open_database(&a).unwrap();
    let draft = flashcard_sync_drafts::identity(&local_flashcard_snapshot(&c).unwrap().drafts[0])
        .to_string();
    let deck = ensure_flashcard_deck(&c, "验收牌组").unwrap();
    resolve_flashcard_drafts_in_connection(&mut c, vec![draft], true, Some(deck)).unwrap();
    drop(c);
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
    let save = |db: &PathBuf, rules: &crate::cloud_sync::attachments::Directions| {
        meta(
            &open_database(db).unwrap(),
            "cloud_attachments_flashcards_v1",
            &serde_json::to_string(rules).unwrap(),
        )
        .unwrap();
    };
    save(&a, &rules);
    save(&b, &rules);
    assert!(sync_database(&remote, &a, &ba, &ns, true, false)
        .await
        .is_err());
    let queued: usize = open_database(&a)
        .unwrap()
        .query_row(
            "SELECT count(*) FROM flashcard_cloud_uploads WHERE status='pending'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(queued > 0);
    online.store(true, std::sync::atomic::Ordering::SeqCst);
    for (db, blobs) in [(&a, &ba), (&b, &bb)] {
        sync_database(&remote, db, blobs, &ns, true, false)
            .await
            .unwrap();
    }
    let snapshot = local_flashcard_snapshot(&open_database(&b).unwrap()).unwrap();
    assert_eq!(snapshot.cards.len(), 1);
    assert_eq!(snapshot.cards[0].question, "真云附件能否独立补传？");
    let key = remote.key(&format!("media/{}", blob.hash));
    assert!(remote.head_identity(&key).await.unwrap().is_none());
    assert!(!bb.path_for(&blob.hash).unwrap().exists());
    rules.upload.image = true;
    save(&a, &rules);
    sync_database(&remote, &a, &ba, &ns, true, false)
        .await
        .unwrap();
    sync_database(&remote, &b, &bb, &ns, true, false)
        .await
        .unwrap();
    assert!(remote.head_identity(&key).await.unwrap().is_some());
    assert!(!bb.path_for(&blob.hash).unwrap().exists());
    rules.download.image = true;
    save(&b, &rules);
    sync_database(&remote, &b, &bb, &ns, true, false)
        .await
        .unwrap();
    assert_eq!(bb.read(&blob.hash).unwrap(), png);
    let c = open_database(&b).unwrap();
    let card = &snapshot.cards[0];
    let at = now_timestamp();
    let preview =
        serde_json::to_value(flashcard_scheduler::preview(&c, &card.id, at).unwrap()).unwrap();
    flashcard_scheduler::commit(
        &c,
        &card.id,
        3,
        None,
        preview["reviewKey"].as_str().unwrap(),
        at,
    )
    .unwrap();
    drop(c);
    for (db, blobs) in [(&b, &bb), (&a, &ba), (&b, &bb)] {
        sync_database(&remote, db, blobs, &ns, true, false)
            .await
            .unwrap();
    }
    let sa = local_flashcard_snapshot(&open_database(&a).unwrap()).unwrap();
    let sb = local_flashcard_snapshot(&open_database(&b).unwrap()).unwrap();
    assert_eq!(sa.reviews.len(), 1);
    assert_eq!(sa.cards[0].fsrs_state_json, sb.cards[0].fsrs_state_json);
    assert_eq!(sa.cards[0].due_at, sb.cards[0].due_at);
    let (uploaded, downloaded) = remote.transferred();
    assert!(uploaded + downloaded < 512 * 1024);
    println!(
        "{}",
        json!({"status":"success","module":"flashcards","namespaceSuffixHash":format!("{:x}",Sha256::digest(run.as_bytes())),
        "uploadedBytes":uploaded,"downloadedBytes":downloaded,"formalImportAndAcceptance":true,
        "independentDirections":true,"deferredUploadAndDownload":true,"injectedOfflineQueueRecovered":true,"reverseReviewConverged":true,"remoteObjectsRetained":true})
    );
}
