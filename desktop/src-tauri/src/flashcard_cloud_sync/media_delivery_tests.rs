//! Real delivery, immutable streaming transport and SQL crash boundaries.
use super::super::tests::{server, store, Server};
use super::*;
use crate::flashcard_authoring::import_flashcard_values;

const BYTES: &[u8] = b"synthetic immutable attachment with verified content";
fn fixture(label: &str, local: bool) -> (PathBuf, BlobStore, String) {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../task-state/project-optimization-20261011/media-delivery-tests")
        .join(format!("{label}-{}", random_url_safe(8)));
    fs::create_dir_all(&root).unwrap();
    let db = root.join("craft-search.sqlite3");
    let blobs = BlobStore::open(&root.join("blobs-v1")).unwrap();
    let hash = format!("{:x}", Sha256::digest(BYTES));
    if local {
        blobs.put(BYTES).unwrap();
    }
    let c = open_database(&db).unwrap();
    ensure_journal(&c).unwrap();
    schema(&c).unwrap();
    c.execute("INSERT INTO flashcard_decks(id,name,created_at,updated_at) VALUES('media-deck','附件',10,10)",[]).unwrap();
    c.execute("INSERT INTO flashcards(id,deck_id,question,answer,created_at,updated_at,due_at,media_json) VALUES('media-card','media-deck','Q','A',10,10,10,?1)",[json!([{"url":format!("http://craft-media.localhost/{hash}"),"mimeType":"text/plain"}]).to_string()]).unwrap();
    (db, blobs, hash)
}
fn checks(db: &PathBuf, hash: &str) -> i64 {
    open_database(db)
        .unwrap()
        .query_row(
            "SELECT checks FROM flashcard_cloud_media_local_verifications WHERE hash=?1",
            [hash],
            |r| r.get(0),
        )
        .unwrap()
}
fn count(db: &PathBuf, query: &str, ns: &str) -> i64 {
    open_database(db)
        .unwrap()
        .query_row(query, [ns], |r| r.get(0))
        .unwrap()
}
fn queue(db: &PathBuf, ns: &str, hash: &str) {
    open_database(db)
        .unwrap()
        .execute(
            "INSERT OR IGNORE INTO flashcard_cloud_media_queue(namespace,hash) VALUES(?1,?2)",
            params![ns, hash],
        )
        .unwrap();
}
async fn run(
    remote: &OssStore,
    db: &PathBuf,
    blobs: &BlobStore,
    ns: &str,
    download: bool,
    force: bool,
) -> Result<CloudReport, String> {
    let mut report = CloudReport::default();
    deliver(remote, db, blobs, ns, download, force, &mut report).await?;
    Ok(report)
}
fn another_store(server: &Server) -> (OssStore, String) {
    let config = OssConfig {
        bucket: "test-bucket".into(),
        region: "cn-hangzhou".into(),
        prefix: "AnotherNamespace".into(),
        access_key_id: "EXAMPLE".into(),
    };
    let ns = config.namespace();
    (
        OssStore::new(config, "synthetic-test-secret".into())
            .unwrap()
            .with_test_endpoint(server.url.clone()),
        ns,
    )
}

#[tokio::test]
async fn attachment_directions_preserve_skipped_bytes_and_resume_after_relaxing_choices() {
    let server = server().await;
    let remote = store(&server);
    let ns = "direction-preferences";
    let (db, blobs, hash) = fixture("direction-upload", true);
    let none = crate::cloud_sync::attachments::Selection {
        image: false,
        video: false,
        pdf: false,
        other: false,
        max_mb: 1,
    };
    let mut rules = crate::cloud_sync::attachments::Directions {
        upload: none.clone(),
        download: none.clone(),
    };
    let save = |db: &PathBuf, rules: &crate::cloud_sync::attachments::Directions| {
        open_database(db).unwrap().execute(
            "INSERT OR REPLACE INTO metadata(key,value) VALUES('cloud_attachments_flashcards_v1',?1)",
            [serde_json::to_string(rules).unwrap()],
        ).unwrap();
    };
    save(&db, &rules);
    run(&remote, &db, &blobs, ns, true, false).await.unwrap();
    let key = remote.key(&format!("media/{hash}"));
    assert!(!server.state.lock().unwrap().files.contains_key(&key));
    assert!(blobs.path_for(&hash).unwrap().is_file());
    rules.upload.other = true;
    save(&db, &rules);
    run(&remote, &db, &blobs, ns, true, false).await.unwrap();
    assert!(server.state.lock().unwrap().files.contains_key(&key));
    let (receiver, local, _) = fixture("direction-download", false);
    rules.upload = none;
    save(&receiver, &rules);
    run(&remote, &receiver, &local, ns, true, false)
        .await
        .unwrap();
    assert!(!local.path_for(&hash).unwrap().is_file());
    rules.download.other = true;
    save(&receiver, &rules);
    run(&remote, &receiver, &local, ns, false, false)
        .await
        .unwrap();
    assert_eq!(fs::read(local.path_for(&hash).unwrap()).unwrap(), BYTES);
    assert!(server.state.lock().unwrap().files.contains_key(&key));
}

#[tokio::test]
async fn media_delivery_real_sync_reopen_skips_stable_local_bytes_but_rechecks_remote_presence() {
    let server = server().await;
    let remote = store(&server);
    let ns = "media-real-sync";
    let (db, blobs, hash) = fixture("stable", true);
    super::super::sync_database(&remote, &db, &blobs, ns, false, false)
        .await
        .unwrap();
    let key = remote.key(&format!("media/{hash}"));
    let (first_gets, first_heads, puts) = {
        let s = server.state.lock().unwrap();
        (s.gets[&key], s.heads[&key], s.puts)
    };
    assert_eq!(checks(&db, &hash), 1);
    open_database(&db).unwrap().execute_batch("CREATE TRIGGER reject_stable_hash_rewrite BEFORE UPDATE ON flashcard_cloud_media_local_verifications BEGIN SELECT RAISE(ABORT,'stable bytes reread'); END;
      CREATE TRIGGER reject_stable_receipt_rewrite BEFORE INSERT ON flashcard_cloud_media_receipts BEGIN SELECT RAISE(ABORT,'stable receipt rewrite'); END;
      CREATE TRIGGER reject_stable_candidate_rewrite BEFORE UPDATE OF state ON flashcard_cloud_media_candidates BEGIN SELECT RAISE(ABORT,'stable candidate rewrite'); END;").unwrap();
    super::super::sync_database(&remote, &db, &blobs, ns, false, false)
        .await
        .unwrap();
    assert_eq!(checks(&db, &hash), 1);
    let s = server.state.lock().unwrap();
    assert_eq!(s.gets[&key], first_gets);
    assert!(s.heads[&key] > first_heads);
    assert_eq!(s.puts, puts);
    assert_eq!(s.files[&key].0, BYTES);
    drop(s);
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM flashcard_cloud_media_receipts WHERE namespace=?1",
            ns
        ),
        1
    );
}

#[tokio::test]
async fn media_delivery_receipt_never_hides_remote_deletion_or_a_new_namespace() {
    let server = server().await;
    let remote = store(&server);
    let ns = "media-deleted";
    let (db, blobs, hash) = fixture("deleted", true);
    run(&remote, &db, &blobs, ns, false, false).await.unwrap();
    let key = remote.key(&format!("media/{hash}"));
    let puts = server.state.lock().unwrap().puts;
    server.state.lock().unwrap().files.remove(&key);
    run(&remote, &db, &blobs, ns, false, false).await.unwrap();
    assert_eq!(server.state.lock().unwrap().puts, puts + 1);
    assert_eq!(checks(&db, &hash), 1);
    let (other, other_ns) = another_store(&server);
    run(&other, &db, &blobs, &other_ns, false, false)
        .await
        .unwrap();
    assert_eq!(
        server.state.lock().unwrap().files[&other.key(&format!("media/{hash}"))].0,
        BYTES
    );
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM flashcard_cloud_media_receipts WHERE namespace=?1",
            &other_ns
        ),
        1
    );
}

#[tokio::test]
async fn media_delivery_legacy_missing_or_wrong_metadata_uses_authoritative_streamed_bytes() {
    let server = server().await;
    let remote = store(&server);
    let ns = "media-metadata";
    let (db, blobs, hash) = fixture("metadata", true);
    let key = remote.key(&format!("media/{hash}"));
    server
        .state
        .lock()
        .unwrap()
        .files
        .insert(key.clone(), (BYTES.to_vec(), String::new()));
    run(&remote, &db, &blobs, ns, false, false).await.unwrap();
    server.state.lock().unwrap().files.get_mut(&key).unwrap().1 = "wrong metadata".into();
    run(&remote, &db, &blobs, ns, false, false).await.unwrap();
    assert_eq!(server.state.lock().unwrap().gets[&key], 2);
    assert_eq!(server.state.lock().unwrap().puts, 0);
    queue(&db, ns, &hash);
    server.state.lock().unwrap().files.get_mut(&key).unwrap().0[0] ^= 1;
    assert!(run(&remote, &db, &blobs, ns, false, false).await.is_err());
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM flashcard_cloud_media_queue WHERE namespace=?1",
            ns
        ),
        1
    );
}

#[tokio::test]
async fn media_delivery_force_reads_every_referenced_remote_body_and_detects_same_stat_local_corruption(
) {
    let server = server().await;
    let remote = store(&server);
    let ns = "media-force";
    let (db, blobs, hash) = fixture("force", true);
    run(&remote, &db, &blobs, ns, false, false).await.unwrap();
    let key = remote.key(&format!("media/{hash}"));
    let gets = server.state.lock().unwrap().gets[&key];
    run(&remote, &db, &blobs, ns, true, true).await.unwrap();
    assert_eq!(checks(&db, &hash), 2);
    assert_eq!(server.state.lock().unwrap().gets[&key], gets + 1);
    let path = blobs.path_for(&hash).unwrap();
    let old = fs::metadata(&path).unwrap().modified().unwrap();
    let mut corrupt = BYTES.to_vec();
    corrupt[0] ^= 1;
    fs::write(&path, corrupt).unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(old)
        .unwrap();
    assert!(run(&remote, &db, &blobs, ns, true, true)
        .await
        .unwrap_err()
        .contains("本地附件哈希"));
    assert_eq!(checks(&db, &hash), 2);
}

#[tokio::test]
async fn media_delivery_changed_stamp_and_changed_blob_root_force_fresh_local_verification() {
    let server = server().await;
    let remote = store(&server);
    let ns = "media-stamp";
    let (db, blobs, hash) = fixture("stamp", true);
    run(&remote, &db, &blobs, ns, false, false).await.unwrap();
    let path = blobs.path_for(&hash).unwrap();
    let stamp =
        fs::metadata(&path).unwrap().modified().unwrap() + std::time::Duration::from_secs(2);
    fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(stamp)
        .unwrap();
    run(&remote, &db, &blobs, ns, false, false).await.unwrap();
    assert_eq!(checks(&db, &hash), 2);
    let relocated = BlobStore::open(&db.parent().unwrap().join("new-blobs")).unwrap();
    relocated.put(BYTES).unwrap();
    run(&remote, &db, &relocated, ns, false, false)
        .await
        .unwrap();
    assert_eq!(checks(&db, &hash), 3);
}

#[tokio::test]
async fn media_delivery_on_demand_preserves_missing_candidates_then_downloads_without_losing_frozen_orphans(
) {
    let server = server().await;
    let remote = store(&server);
    let ns = "media-on-demand";
    let (db, blobs, hash) = fixture("missing", false);
    let key = remote.key(&format!("media/{hash}"));
    server
        .state
        .lock()
        .unwrap()
        .files
        .insert(key.clone(), (BYTES.to_vec(), hash.clone()));
    let report = run(&remote, &db, &blobs, ns, false, false).await.unwrap();
    assert_eq!(report.pending_media, 1);
    assert!(server.state.lock().unwrap().gets.is_empty());
    let report = run(&remote, &db, &blobs, ns, true, false).await.unwrap();
    assert_eq!(report.pending_media, 0);
    assert_eq!(report.downloaded_bytes, BYTES.len() as u64);
    assert_eq!(fs::read(blobs.path_for(&hash).unwrap()).unwrap(), BYTES);
    queue(&db, ns, &hash);
    open_database(&db)
        .unwrap()
        .execute(
            "UPDATE flashcards SET media_json='[]' WHERE id='media-card'",
            [],
        )
        .unwrap();
    server.state.lock().unwrap().files.remove(&key);
    run(&remote, &db, &blobs, ns, false, false).await.unwrap();
    assert_eq!(server.state.lock().unwrap().files[&key].0, BYTES);
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM flashcard_cloud_media_queue WHERE namespace=?1",
            ns
        ),
        0
    );
}

#[tokio::test]
async fn media_delivery_receipt_failure_rolls_back_mime_and_queue_and_restart_uses_remote_identity()
{
    let server = server().await;
    let remote = store(&server);
    let ns = "media-rollback";
    let (db, blobs, hash) = fixture("rollback", true);
    queue(&db, ns, &hash);
    let c = open_database(&db).unwrap();
    c.execute_batch("CREATE TRIGGER reject_media_receipt BEFORE INSERT ON flashcard_cloud_media_receipts BEGIN SELECT RAISE(ABORT,'receipt fixture failure'); END;").unwrap();
    drop(c);
    assert!(run(&remote, &db, &blobs, ns, false, false)
        .await
        .unwrap_err()
        .contains("receipt fixture failure"));
    let c = open_database(&db).unwrap();
    assert_eq!(
        c.query_row("SELECT count(*) FROM blobs WHERE hash=?1", [&hash], |r| r
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        0
    );
    assert_eq!(
        c.query_row(
            "SELECT mime_payload FROM flashcard_cloud_media_local_verifications WHERE hash=?1",
            [&hash],
            |r| r.get::<_, Option<String>>(0)
        )
        .unwrap(),
        None
    );
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM flashcard_cloud_media_queue WHERE namespace=?1",
            ns
        ),
        1
    );
    c.execute_batch("DROP TRIGGER reject_media_receipt;")
        .unwrap();
    drop(c);
    let puts = server.state.lock().unwrap().puts;
    run(&remote, &db, &blobs, ns, false, false).await.unwrap();
    assert_eq!(server.state.lock().unwrap().puts, puts);
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM flashcard_cloud_media_queue WHERE namespace=?1",
            ns
        ),
        0
    );
    assert_eq!(
        open_database(&db)
            .unwrap()
            .query_row("SELECT mime_type FROM blobs WHERE hash=?1", [&hash], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
        "text/plain"
    );
}

#[tokio::test]
async fn media_delivery_streaming_download_rejects_corrupt_truncated_and_grown_bodies_without_committing_blob(
) {
    let server = server().await;
    let remote = store(&server);
    for mode in ["corrupt", "truncate", "grow"] {
        let (db, blobs, hash) = fixture(mode, false);
        let key = remote.key(&format!("media/{hash}"));
        {
            let mut s = server.state.lock().unwrap();
            s.files.insert(key, (BYTES.to_vec(), hash.clone()));
            s.corrupt = mode == "corrupt";
            s.truncate_get = (mode == "truncate").then_some(3);
            s.grow_get = (mode == "grow").then_some(BYTES.len() + 5);
        }
        assert!(run(&remote, &db, &blobs, mode, true, false).await.is_err());
        assert!(!blobs.path_for(&hash).unwrap().exists());
        let staging = blobs.root_path().join("incoming");
        if staging.is_dir() {
            assert_eq!(fs::read_dir(staging).unwrap().count(), 0);
        }
        {
            let mut s = server.state.lock().unwrap();
            s.corrupt = false;
            s.truncate_get = None;
            s.grow_get = None;
        }
        run(&remote, &db, &blobs, mode, true, false).await.unwrap();
        assert_eq!(fs::read(blobs.path_for(&hash).unwrap()).unwrap(), BYTES);
    }
}

#[tokio::test]
async fn media_delivery_large_missing_inventory_is_sql_owned_and_does_not_probe_on_demand() {
    let server = server().await;
    let remote = store(&server);
    let (db, blobs, _) = fixture("large", false);
    let c = open_database(&db).unwrap();
    let tx = c.unchecked_transaction().unwrap();
    for i in 0..10_000 {
        tx.execute(
            "INSERT INTO flashcard_cloud_media_queue(namespace,hash) VALUES('large',?1)",
            [format!("{i:064x}")],
        )
        .unwrap();
    }
    tx.commit().unwrap();
    drop(c);
    let report = run(&remote, &db, &blobs, "large", false, false)
        .await
        .unwrap();
    assert_eq!(report.pending_media, 10_001);
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM flashcard_cloud_media_candidates WHERE namespace=?1",
            "large"
        ),
        10_001
    );
    assert!(server.state.lock().unwrap().heads.is_empty());
    assert!(server.state.lock().unwrap().gets.is_empty());
}

#[tokio::test]
async fn media_delivery_streaming_upload_lost_ack_is_confirmed_and_payload_meter_follows_actual_chunks(
) {
    let server = server().await;
    let remote = store(&server);
    let (db, blobs, _) = fixture("streamed-upload", true);
    let bytes = vec![73u8; 384 * 1024 + 17];
    let hash = blobs.put(&bytes).unwrap().hash;
    let key = remote.key(&format!("media/{hash}"));
    server.state.lock().unwrap().lose_ack = true;
    let meter = Arc::new(crate::cloud_transfer_meter::Meter::default());
    let uploaded = crate::cloud_transfer_meter::ACTIVE
        .scope(Arc::clone(&meter), async {
            remote
                .put_media_file(
                    &key,
                    &blobs.path_for(&hash).unwrap(),
                    &hash,
                    bytes.len() as u64,
                )
                .await
                .unwrap()
        })
        .await;
    assert!(uploaded);
    assert_eq!(meter.finish(), (bytes.len() as u64, bytes.len() as u64));
    assert_eq!(server.state.lock().unwrap().files[&key].0, bytes);
    assert_eq!(server.state.lock().unwrap().puts, 1);
    // A denied transfer cannot release the durable dependency. The next attempt
    // checks existing bytes and succeeds without weakening immutable writes.
    let ns = "denied-upload";
    queue(&db, ns, &hash);
    open_database(&db)
        .unwrap()
        .execute(
            "UPDATE flashcards SET media_json='[]' WHERE id='media-card'",
            [],
        )
        .unwrap();
    server.state.lock().unwrap().files.remove(&key);
    server.state.lock().unwrap().deny_put = true;
    assert!(run(&remote, &db, &blobs, ns, false, false).await.is_err());
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM flashcard_cloud_media_queue WHERE namespace=?1",
            ns
        ),
        1
    );
    server.state.lock().unwrap().deny_put = false;
    run(&remote, &db, &blobs, ns, false, false).await.unwrap();
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM flashcard_cloud_media_queue WHERE namespace=?1",
            ns
        ),
        0
    );
}

#[tokio::test]
async fn media_delivery_mime_matches_released_all_sources_and_rejects_invalid_svg_without_acknowledgment(
) {
    let server = server().await;
    let remote = store(&server);
    let (db, blobs, _) = fixture("mime", true);
    let imported = import_flashcard_values(
        &db,
        "manual",
        "附件草稿".into(),
        json!({"source":"manual"}),
        vec![json!({"question":"附件草稿如何保留？","answer":"保留"})],
        true,
    )
    .unwrap();
    assert_eq!(imported.imported, 1);
    assert_eq!(imported.invalid, 0);
    let svg=blobs.put(br#"<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>"#).unwrap().hash;
    let audio = blobs
        .put(b"RIFF\x10\0\0\0WAVEfmt synthetic-audio")
        .unwrap()
        .hash;
    let before = blobs.put(b"synthetic quality before text").unwrap().hash;
    let c = open_database(&db).unwrap();
    let draft: String = c
        .query_row(
            "SELECT id FROM flashcard_drafts ORDER BY id LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    c.execute(
        "UPDATE flashcards SET media_json=?1 WHERE id='media-card'",
        [
            json!([{"url":format!("http://craft-media.localhost/{svg}"),"mimeType":"text/plain"}])
                .to_string(),
        ],
    )
    .unwrap();
    c.execute(
        "UPDATE flashcard_drafts SET media_json=?1 WHERE id=?2",
        params![
            json!([{"url":format!("hub-media://localhost/{svg}"),"mimeType":"image/svg+xml"}])
                .to_string(),
            draft
        ],
    )
    .unwrap();
    flashcard_quality::merge(&c,&[json!({"id":"media-quality","kind":"feedback","updatedAt":40,"snapshot":{"media":[{"url":format!("craft-media://localhost/{audio}"),"mimeType":"audio/wav"}]},"before":{"media":[{"url":format!("http://craft-media.localhost/{before}"),"mimeType":"text/plain"}]}})]).unwrap();
    let reference = local_flashcard_snapshot(&c).unwrap();
    drop(c);
    let (expected, _, _) = fixture("mime-reference", false);
    let c = open_database(&expected).unwrap();
    media_index::register_snapshot(&c, &reference, &blobs, None).unwrap();
    drop(c);
    run(&remote, &db, &blobs, "mime", false, false)
        .await
        .unwrap();
    for hash in [&svg, &audio, &before] {
        let mime = |db: &PathBuf| {
            open_database(db)
                .unwrap()
                .query_row("SELECT mime_type FROM blobs WHERE hash=?1", [hash], |r| {
                    r.get::<_, String>(0)
                })
                .unwrap()
        };
        assert_eq!(mime(&db), mime(&expected));
    }
    let bad = blobs.put(b"not an SVG document").unwrap().hash;
    open_database(&db).unwrap().execute("UPDATE flashcards SET media_json=?1 WHERE id='media-card'",[json!([{"url":format!("http://craft-media.localhost/{bad}"),"mimeType":"image/svg+xml"}]).to_string()]).unwrap();
    queue(&db, "mime", &bad);
    assert!(run(&remote, &db, &blobs, "mime", false, false)
        .await
        .is_err());
    let c = open_database(&db).unwrap();
    assert_eq!(c.query_row("SELECT count(*) FROM flashcard_cloud_media_receipts WHERE namespace='mime' AND hash=?1",[&bad],|r|r.get::<_,i64>(0)).unwrap(),0);
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM flashcard_cloud_media_queue WHERE namespace='mime' AND hash=?1",
            [&bad],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
}

#[tokio::test]
async fn media_delivery_single_attachment_reuses_mime_validation_and_repairs_missing_index() {
    let (db, blobs, hash) = fixture("single-attachment", true);
    let c = open_database(&db).unwrap();
    let (_, _, checked) = verify_local(&c, &blobs, &hash, false).unwrap();
    register_local_verified(&c, &blobs, &hash, checked).unwrap();
    c.execute_batch("CREATE TRIGGER reject_single_rehash BEFORE UPDATE ON flashcard_cloud_media_local_verifications BEGIN SELECT RAISE(ABORT,'unexpected MIME or hash repeat'); END; CREATE TRIGGER reject_single_mime BEFORE UPDATE ON blobs BEGIN SELECT RAISE(ABORT,'unexpected index repeat'); END;").unwrap();
    let (_, _, checked) = verify_local(&c, &blobs, &hash, false).unwrap();
    assert!(!checked);
    register_local_verified(&c, &blobs, &hash, checked).unwrap();
    c.execute_batch("DROP TRIGGER reject_single_rehash; DROP TRIGGER reject_single_mime;")
        .unwrap();
    c.execute("DELETE FROM blobs WHERE hash=?1", [&hash])
        .unwrap();
    register_local_verified(&c, &blobs, &hash, false).unwrap();
    assert_eq!(
        c.query_row("SELECT mime_type FROM blobs WHERE hash=?1", [&hash], |r| {
            r.get::<_, String>(0)
        })
        .unwrap(),
        "text/plain"
    );
    assert_eq!(checks(&db, &hash), 1);
}
