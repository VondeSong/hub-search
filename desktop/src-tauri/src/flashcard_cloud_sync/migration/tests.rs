use super::*;
use crate::flashcard_cloud_sync::tests as oss;
use crate::reading_sync::object_store::tests as dav;
use crate::x_bookmarks::Post;
fn oss_config() -> Configuration {
    Configuration::Oss {
        config: OssConfig {
            bucket: "test-bucket".into(),
            region: "cn-hangzhou".into(),
            prefix: "HubFlashcards".into(),
            access_key_id: "EXAMPLE".into(),
        },
    }
}

#[tokio::test]
async fn all_module_migration_restores_formal_oss_objects_on_webdav_and_rechecks_cloud_damage() {
    let server = oss::server().await;
    let source = oss::store(&server);
    let target_server = dav::server().await;
    let target = dav::remote(&target_server);
    let a = dav::Device::new(&target_server);
    a.seed();
    let from = oss_config();
    let to = dav::config(&target_server);
    let ns = from.namespace();
    a.round(&source, &ns, "source").await;
    let blobs = BlobStore::open(&a.root.join("flashcard-blobs")).unwrap();
    super::super::sync_database(&source, &a.db, &blobs, &ns, true, false)
        .await
        .unwrap();
    crate::cloud_maintenance::observe_sync_success(&a.db, &source, &ns)
        .await
        .unwrap();
    // Explicit all-module migration includes history even after both module switches are off.
    meta(&a.c(), "cloud_sync_reading", "0").unwrap();
    meta(&a.c(), "cloud_sync_flashcards", "0").unwrap();
    meta(
        &a.c(),
        "reading_media_policy",
        r#"{"enabled":false,"batchMb":64,"dailyMb":256}"#,
    )
    .unwrap();
    copy(&a.db, &source, &target, &from, &to, true)
        .await
        .unwrap();
    assert!(
        target_server
            .state
            .lock()
            .unwrap()
            .files
            .keys()
            .any(|k| k.contains("/changes/") && !k.contains("reading/")),
        "official prefixed flashcard journal must migrate"
    );
    assert!(target_server
        .state
        .lock()
        .unwrap()
        .files
        .keys()
        .any(|k| k.contains("reading/devices-v1/")));
    assert!(target_server
        .state
        .lock()
        .unwrap()
        .files
        .keys()
        .any(|k| k.contains("reading/media-v1/blobs/")));
    let b = dav::Device::new(&target_server);
    b.round(&target, &to.namespace(), "restored").await;
    let path: String = b
        .c()
        .query_row(
            "SELECT path FROM collection_saved_media WHERE item_key=?1 AND media_url=?2",
            params![dav::KEY, dav::URL],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(fs::read(path).unwrap(), dav::png());
    // A completed older receipt cannot suppress the new verification epoch's actual GET.
    let blob = target.key(&format!(
        "reading/media-v1/blobs/{}",
        hash_bytes(&dav::png())
    ));
    let path = format!("/dav/{blob}");
    let before = target_server
        .state
        .lock()
        .unwrap()
        .gets
        .get(&path)
        .copied()
        .unwrap_or(0);
    target_server
        .state
        .lock()
        .unwrap()
        .files
        .insert(path.clone(), vec![0; dav::png().len()]);
    assert!(copy(&a.db, &source, &target, &from, &to, true)
        .await
        .is_err());
    assert!(target_server.state.lock().unwrap().gets[&path] > before);
    assert_eq!(fs::read(a.root.join("source.png")).unwrap(), dav::png());
    target_server
        .state
        .lock()
        .unwrap()
        .files
        .insert(path, dav::png());
    let source_blob = source.key(&format!(
        "reading/media-v1/blobs/{}",
        hash_bytes(&dav::png())
    ));
    server.state.lock().unwrap().files.remove(&source_blob);
    let error = copy(&a.db, &source, &target, &from, &to, true)
        .await
        .unwrap_err();
    assert!(error.contains("缺失"));
    assert_eq!(provider(&a.c()), "webdav");
}

#[tokio::test]
async fn migration_copy_and_independent_read_verification_resume_across_database_reopen() {
    let server = oss::server().await;
    let source = oss::store(&server);
    let target_server = dav::server().await;
    let target = dav::remote(&target_server);
    let a = dav::Device::new(&target_server);
    a.seed();
    for i in 0..100 {
        x_bookmarks::reading_sync_test_import(
            &mut a.c(),
            Post {
                id: format!("resume-{i}"),
                text: format!("正式生产者条目 {i}"),
                content_status: "full".into(),
                ..Post::default()
            },
        );
    }
    let from = oss_config();
    let to = dav::config(&target_server);
    let ns = from.namespace();
    for _ in 0..3 {
        a.round(&source, &ns, "producer").await;
    }
    let mut attempts = Vec::new();
    let mut succeeded = false;
    let mut appended_heartbeats = false;
    for _ in 0..8 {
        let result = copy(&a.db, &source, &target, &from, &to, false).await;
        if let Some(attempt) = a
            .c()
            .query_row(
                "SELECT attempt FROM cloud_migration_verifications LIMIT 1",
                [],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .unwrap()
        {
            attempts.push(attempt);
        }
        if !appended_heartbeats && !attempts.is_empty() && result.is_err() {
            crate::cloud_maintenance::observe_sync_success(&a.db, &source, &ns)
                .await
                .unwrap();
            crate::cloud_maintenance::observe_sync_success(&a.db, &target, &to.namespace())
                .await
                .unwrap();
            appended_heartbeats = true;
        }
        // No in-memory copy or verification receipt is needed after a restart.
        forget_initialized_database(&a.db);
        if result.is_ok() {
            succeeded = true;
            break;
        }
    }
    assert!(succeeded);
    assert!(appended_heartbeats);
    assert!(attempts.len() > 1);
    assert!(attempts.iter().all(|v| v == &attempts[0]));
    let report: Value =
        serde_json::from_str(&metadata_string(&a.c(), "cloud_migration_report")).unwrap();
    assert_eq!(report["state"], "verified");
    assert_eq!(report["verified"], report["verifyTotal"]);
    let b = dav::Device::new(&target_server);
    for _ in 0..3 {
        b.round(&target, &to.namespace(), "restored").await;
    }
    assert_eq!(
        b.c()
            .query_row("SELECT count(*) FROM collection_x_items", [], |r| r
                .get::<_, usize>(0))
            .unwrap(),
        101
    );
    let old_receipt = receipt(&a.c()).unwrap();
    a.c().execute("UPDATE collection_x_items SET post_json=json_set(post_json,'$.text','changed while migrating') WHERE item_key=?1",[dav::KEY]).unwrap();
    assert!(old_receipt.verify(&a.c()).is_err());
    let error = copy(&a.db, &source, &target, &from, &to, false)
        .await
        .unwrap_err();
    assert!(error.contains("100 个对象") && error.contains("游标已保存"));
    let (new_attempt, state): (String, String) = a
        .c()
        .query_row(
            "SELECT attempt,state FROM cloud_migration_verifications LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_ne!(new_attempt, attempts[0]);
    assert_eq!(state, "running");
    let mut completed = false;
    for _ in 0..4 {
        forget_initialized_database(&a.db);
        let result = copy(&a.db, &source, &target, &from, &to, false).await;
        let attempt: String = a
            .c()
            .query_row(
                "SELECT attempt FROM cloud_migration_verifications LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(attempt, new_attempt);
        match result {
            Ok(()) => {
                completed = true;
                break;
            }
            Err(error) => {
                assert!(error.contains("100 个对象") && error.contains("游标已保存"));
            }
        }
    }
    assert!(completed);
    let new_receipt = receipt(&a.c()).unwrap();
    assert_ne!(new_receipt.reading_token, old_receipt.reading_token);
    assert_eq!(
        new_receipt.reading_token,
        reading_sync::migration_domain_token(&a.c()).unwrap()
    );
    new_receipt.verify(&a.c()).unwrap();
}

#[tokio::test]
async fn migration_blocked_network_does_not_reserve_quota_or_switch_connection() {
    let server = oss::server().await;
    let source = oss::store(&server);
    let target_server = dav::server().await;
    let target =
        dav::remote(&target_server).with_network_guard(Arc::new(|| Err("blocked network".into())));
    let a = dav::Device::new(&target_server);
    a.seed();
    let from = oss_config();
    let to = dav::config(&target_server);
    a.round(&source, &from.namespace(), "producer").await;
    let before = metadata_u64(&a.c(), "reading_media_reserved", 0);
    assert!(copy(&a.db, &source, &target, &from, &to, false)
        .await
        .is_err());
    assert_eq!(metadata_u64(&a.c(), "reading_media_reserved", 0), before);
    assert_eq!(provider(&a.c()), "webdav");
    assert!(target_server.state.lock().unwrap().files.is_empty());
}

#[tokio::test]
async fn migration_legacy_budgets_do_not_pause_copy_or_change_connection() {
    let server = oss::server().await;
    let source = oss::store(&server);
    let target_server = dav::server().await;
    let target = dav::remote(&target_server);
    let a = dav::Device::new(&target_server);
    for i in 0..4 {
        x_bookmarks::reading_sync_test_import(
            &mut a.c(),
            Post {
                id: format!("quota-{i}"),
                text: "a".repeat(900 * 1024),
                content_status: "full".into(),
                ..Post::default()
            },
        );
    }
    let from = oss_config();
    let to = dav::config(&target_server);
    a.round(&source, &from.namespace(), "producer").await;
    meta(
        &a.c(),
        "reading_media_policy",
        r#"{"enabled":false,"batchMb":4,"dailyMb":4}"#,
    )
    .unwrap();
    let mut finished = false;
    for _ in 0..20 {
        let result = copy(&a.db, &source, &target, &from, &to, false).await;
        if let Err(error) = &result {
            assert!(
                !error.contains("额度"),
                "retired budgets must not pause migration: {error}"
            );
        }
        forget_initialized_database(&a.db);
        if result.is_ok() {
            finished = true;
            break;
        }
    }
    assert!(
        finished,
        "aggregate cloud content must finish despite retired 4 MiB budgets"
    );
    assert!(metadata_u64(&a.c(), "reading_media_reserved", 0) > 4 * 1024 * 1024);
    assert_eq!(provider(&a.c()), "webdav");
    assert_eq!(
        a.c()
            .query_row("SELECT count(*) FROM cloud_migration_payloads", [], |r| {
                r.get::<_, usize>(0)
            })
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn migration_final_webdav_snapshot_recheck_catches_review_appended_in_long_window() {
    let server = dav::server().await;
    let a = dav::Device::new(&server);
    let c = a.c();
    c.execute("INSERT INTO flashcard_decks(id,name,created_at,updated_at) VALUES('migration-deck','Migration',10,10)",[]).unwrap();
    c.execute("INSERT INTO flashcards(id,deck_id,question,answer,created_at,updated_at,due_at) VALUES('migration-card','migration-deck','Q','A',10,10,10)",[]).unwrap();
    let before = local_flashcard_snapshot(&c).unwrap();
    let proof = hash_bytes(&serde_json::to_vec(&content_identity(&before).unwrap()).unwrap());
    server.state.lock().unwrap().files.insert(
        "/dav/hub-flashcards-v1.json".into(),
        serde_json::to_vec(&before).unwrap(),
    );
    let settings = FlashcardSyncSettings {
        url: server.url.clone(),
        username: "test-account".into(),
        has_password: true,
        auto_sync: false,
        configured: true,
        last_sync_at: None,
        last_error: String::new(),
    };
    let client = reqwest::Client::new();
    check_webdav_snapshot(&client, &settings, "synthetic-test-password", "", &proof)
        .await
        .unwrap();
    let preview =
        serde_json::to_value(flashcard_scheduler::preview(&c, "migration-card", 1000).unwrap())
            .unwrap();
    flashcard_scheduler::commit(
        &c,
        "migration-card",
        3,
        None,
        preview["reviewKey"].as_str().unwrap(),
        1000,
    )
    .unwrap();
    let current = local_flashcard_snapshot(&c).unwrap();
    server.state.lock().unwrap().files.insert(
        "/dav/hub-flashcards-v1.json".into(),
        serde_json::to_vec(&current).unwrap(),
    );
    assert!(
        check_webdav_snapshot(&client, &settings, "synthetic-test-password", "", &proof)
            .await
            .unwrap_err()
            .contains("原服务保持")
    );
    assert_eq!(provider(&c), "webdav");
}

#[tokio::test]
async fn migration_replayed_read_scratch_rejects_version_conflict_after_cursor_boundary() {
    let server = oss::server().await;
    let source = oss::store(&server);
    let target_server = dav::server().await;
    let target = dav::remote(&target_server);
    let a = dav::Device::new(&target_server);
    a.seed();
    for i in 0..100 {
        x_bookmarks::reading_sync_test_import(
            &mut a.c(),
            Post {
                id: format!("conflict-filler-{i}"),
                text: format!("formal filler {i}"),
                content_status: "full".into(),
                ..Post::default()
            },
        );
    }
    let from = oss_config();
    let to = dav::config(&target_server);
    for _ in 0..3 {
        a.round(&source, &from.namespace(), "producer").await;
    }
    let (mut malformed, maximum) = {
        let s = server.state.lock().unwrap();
        let records: Vec<_> = s
            .files
            .iter()
            .filter(|(k, _)| k.contains("reading/v1/changes/"))
            .collect();
        let original = records
            .iter()
            .find_map(|(_, (b, _))| {
                let v: Value = serde_json::from_slice(b).unwrap();
                (v["record"]["key"] == dav::KEY).then_some(v)
            })
            .unwrap();
        let max = records
            .iter()
            .map(|(k, _)| {
                k.rsplit('/')
                    .next()
                    .unwrap()
                    .trim_end_matches(".json")
                    .to_string()
            })
            .max()
            .unwrap();
        (original, max)
    };
    // Only the negative fixture is tampered: same formal Version, different body, valid new content hash.
    let bad = (0..100_000)
        .find_map(|i| {
            malformed["record"]["body"]["value"]["post"]["text"] =
                json!(format!("invalid duplicated version {i}"));
            let b = serde_json::to_vec(&malformed).unwrap();
            let h = hash_bytes(&b);
            (h > maximum).then_some((h, b))
        })
        .expect("find a negative hash after the actual producer objects");
    target
        .put_verified(
            &target.key(&format!("reading/v1/changes/{}.json", bad.0)),
            &bad.1,
        )
        .await
        .unwrap();
    let mut saw_cursor = false;
    let mut rejected = false;
    for _ in 0..8 {
        let result = copy(&a.db, &source, &target, &from, &to, false).await;
        let c = a.c();
        saw_cursor |= c
            .query_row("SELECT count(*)>0 FROM cloud_migration_checks", [], |r| {
                r.get::<_, bool>(0)
            })
            .unwrap();
        drop(c);
        forget_initialized_database(&a.db);
        if result.as_ref().is_err_and(|e| e.contains("重复版本冲突")) {
            rejected = true;
            break;
        }
    }
    assert!(saw_cursor);
    assert!(
        rejected,
        "formal conflict proof must survive the 100-GET restart boundary"
    );
    assert_eq!(provider(&a.c()), "webdav");
}
