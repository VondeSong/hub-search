use super::*;

#[tokio::test]
async fn attachment_traffic_existing_object_uses_one_read_budget_and_missing_requires_upload_budget(
) {
    let server = server().await;
    let remote = store(&server);
    let a = Device::new();
    let mut p = policy(&a.c()).unwrap();
    p.unlimited = false; // Historical accounting compatibility only.
    p.batch_mb = 4;
    p.daily_mb = 4;
    let bytes = vec![42; (3 * MB) as usize];
    let key = blob_key(&remote, &hash(&bytes));
    server
        .state
        .lock()
        .unwrap()
        .files
        .insert(key.clone(), (bytes.clone(), String::new()));
    let budget = Budget::new(&p);
    verified_put(&a.db, &p, &budget, &remote, NS, &key, &bytes, false)
        .await
        .unwrap();
    assert_eq!(server.state.lock().unwrap().gets[&key], 1);
    assert_eq!(metadata_u64(&a.c(), "reading_media_reserved", 0), 3 * MB);
    assert_eq!(metadata_u64(&a.c(), "reading_transfer_pending", 0), 0);
    assert_eq!(*budget.left.lock().unwrap(), MB);
    let missing = remote.key("reading/media-v1/blobs/not-present");
    assert!(
        verified_put(&a.db, &p, &budget, &remote, NS, &missing, &bytes, false)
            .await
            .is_err()
    );
    assert!(
        !server.state.lock().unwrap().heads.contains_key(&missing),
        "N admission must precede HEAD"
    );
    // Fresh batch allowance still cannot authorize a real 2N upload.
    meta(&a.c(), "reading_media_reserved", "0").unwrap();
    assert!(verified_put(
        &a.db,
        &p,
        &Budget::new(&p),
        &remote,
        NS,
        &missing,
        &bytes,
        false
    )
    .await
    .is_err());
    assert_eq!(server.state.lock().unwrap().puts, 0);
    assert_eq!(metadata_u64(&a.c(), "reading_media_reserved", 0), 0);
    assert_eq!(metadata_u64(&a.c(), "reading_transfer_pending", 0), 0);
}

#[tokio::test]
async fn attachment_traffic_admission_wait_preserves_retries_and_next_day_resumes_automatically() {
    let server = server().await;
    let remote = store(&server);
    let a = Device::new();
    a.seed(&png());
    let mut p = policy(&a.c()).unwrap();
    p.unlimited = false;
    stage(&a.c(), NS, "a", &p, None).unwrap();
    meta(
        &a.c(),
        "reading_media_day",
        &chrono::Utc::now().format("%Y-%m-%d").to_string(),
    )
    .unwrap();
    meta(
        &a.c(),
        "reading_media_reserved",
        &(p.daily_mb * MB).to_string(),
    )
    .unwrap();
    for _ in 0..=retry::MAX_ATTEMPTS {
        a.c()
            .execute("UPDATE reading_media_retries SET next_at=0", [])
            .unwrap();
        assert_eq!(
            upload_pending(&a.db, &remote, NS, &p, None)
                .await
                .unwrap()
                .failed,
            1
        );
        let (attempts, deadline): (u64, i64) = a
            .c()
            .query_row(
                "SELECT attempts,next_at FROM reading_media_retries WHERE kind='upload'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(attempts, 0);
        assert!(deadline > now_timestamp());
    }
    assert!(server.state.lock().unwrap().heads.is_empty());
    assert_eq!(server.state.lock().unwrap().puts, 0);
    let yesterday = (chrono::Utc::now() - chrono::Duration::days(1))
        .format("%Y-%m-%d")
        .to_string();
    meta(&a.c(), "reading_media_day", &yesterday).unwrap();
    a.c()
        .execute("UPDATE reading_media_retries SET next_at=0", [])
        .unwrap();
    assert_eq!(
        upload_pending(&a.db, &remote, NS, &p, None)
            .await
            .unwrap()
            .uploaded,
        1
    );
    assert_eq!(
        a.c()
            .query_row("SELECT count(*) FROM reading_media_retries", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        a.c()
            .query_row("SELECT count(*) FROM reading_media_outbox", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(server.state.lock().unwrap().puts, 2);
}

#[tokio::test]
async fn attachment_traffic_oss_existing_bytes_are_read_once_without_etag_shortcuts() {
    let server = crate::reading_sync::object_store::tests::server().await;
    let remote = crate::reading_sync::object_store::tests::remote(&server);
    let a = Device::new();
    let bytes = png();
    let key = remote.key(&format!("reading/media-v1/blobs/{}", hash(&bytes)));
    let request_key = key.clone();
    server
        .state
        .lock()
        .unwrap()
        .files
        .insert(request_key.clone(), (bytes.clone(), String::new()));
    for _ in 0..2 {
        verified_put(
            &a.db,
            &policy(&a.c()).unwrap(),
            &Budget::new(&policy(&a.c()).unwrap()),
            &remote,
            NS,
            &key,
            &bytes,
            false,
        )
        .await
        .unwrap();
    }
    assert_eq!(
        server.state.lock().unwrap().gets[&request_key],
        2,
        "one real GET per invocation; absent ETag cannot make a durable receipt sufficient"
    );
}

#[tokio::test]
async fn attachment_traffic_reading_receipt_requires_current_version_namespace_and_bytes() {
    let server = server().await;
    let remote = store(&server);
    let a = Device::new();
    let bytes = png();
    let key = blob_key(&remote, &hash(&bytes));
    {
        let mut s = server.state.lock().unwrap();
        s.files.insert(key.clone(), (bytes.clone(), String::new()));
        s.etags.insert(key.clone(), "\"version-one\"".into());
    }
    let p = policy(&a.c()).unwrap();
    for _ in 0..2 {
        verified_put(
            &a.db,
            &p,
            &Budget::new(&p),
            &remote,
            NS,
            &key,
            &bytes,
            false,
        )
        .await
        .unwrap();
    }
    assert_eq!(server.state.lock().unwrap().gets[&key], 1);
    verified_put(
        &a.db,
        &p,
        &Budget::new(&p),
        &remote,
        "other-namespace",
        &key,
        &bytes,
        false,
    )
    .await
    .unwrap();
    assert_eq!(server.state.lock().unwrap().gets[&key], 2);
    server
        .state
        .lock()
        .unwrap()
        .etags
        .insert(key.clone(), "\"version-two\"".into());
    verified_put(
        &a.db,
        &p,
        &Budget::new(&p),
        &remote,
        NS,
        &key,
        &bytes,
        false,
    )
    .await
    .unwrap();
    assert_eq!(server.state.lock().unwrap().gets[&key], 3);
    {
        let mut s = server.state.lock().unwrap();
        s.etags.insert(key.clone(), "\"version-three\"".into());
        s.files.get_mut(&key).unwrap().0[0] ^= 1;
    }
    assert!(verified_put(
        &a.db,
        &p,
        &Budget::new(&p),
        &remote,
        NS,
        &key,
        &bytes,
        false
    )
    .await
    .is_err());
    let saved: String = a
        .c()
        .query_row(
            "SELECT identity FROM reading_media_object_receipts
        WHERE namespace=?1 AND object_key=?2",
            params![NS, key],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<crate::flashcard_object_store::Identity>(&saved)
            .unwrap()
            .etag
            .as_deref(),
        Some("\"version-two\"")
    );
}

#[tokio::test]
async fn attachment_traffic_manifest_failure_preserves_blob_proof_and_backoff_until_retry() {
    let server = server().await;
    let remote = store(&server);
    let a = Device::new();
    a.seed(&png());
    let p = policy(&a.c()).unwrap();
    stage(&a.c(), NS, "a", &p, None).unwrap();
    let key = blob_key(&remote, &a.manifest().hash);
    {
        let mut s = server.state.lock().unwrap();
        s.etags.insert(key.clone(), "\"verified-blob\"".into());
        s.deny_manifests = true;
    }
    assert_eq!(
        upload_pending(&a.db, &remote, NS, &p, None)
            .await
            .unwrap()
            .failed,
        1
    );
    let before = server.state.lock().unwrap().gets[&key];
    let retry: (i64, i64) = a
        .c()
        .query_row(
            "SELECT attempts,next_at FROM reading_media_retries WHERE kind='upload'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    stage(&a.c(), NS, "a", &p, None).unwrap();
    assert_eq!(
        upload_pending(&a.db, &remote, NS, &p, None)
            .await
            .unwrap()
            .uploaded,
        0
    );
    assert_eq!(
        a.c()
            .query_row(
                "SELECT attempts,next_at FROM reading_media_retries WHERE kind='upload'",
                [],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
            )
            .unwrap(),
        retry
    );
    server.state.lock().unwrap().deny_manifests = false;
    // Expire the persisted producer-owned deadline, avoiding a two-minute test sleep.
    a.c()
        .execute("UPDATE reading_media_retries SET next_at=0", [])
        .unwrap();
    assert_eq!(
        upload_pending(&a.db, &remote, NS, &p, None)
            .await
            .unwrap()
            .uploaded,
        1
    );
    assert_eq!(
        server.state.lock().unwrap().gets[&key],
        before,
        "manifest retry must HEAD-check its saved blob version instead of downloading it again"
    );
    assert_eq!(
        a.c()
            .query_row("SELECT count(*) FROM reading_media_retries", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn attachment_traffic_reading_retries_stop_and_explicit_retry_rechecks_bytes() {
    let server = server().await;
    let remote = store(&server);
    let a = Device::new();
    a.seed(&png());
    let p = policy(&a.c()).unwrap();
    stage(&a.c(), NS, "a", &p, None).unwrap();
    let key = blob_key(&remote, &a.manifest().hash);
    {
        let mut s = server.state.lock().unwrap();
        s.etags.insert(key.clone(), "\"verified-blob\"".into());
        s.deny_manifests = true;
    }
    for _ in 0..retry::MAX_ATTEMPTS {
        a.c()
            .execute("UPDATE reading_media_retries SET next_at=0", [])
            .unwrap();
        assert_eq!(
            upload_pending(&a.db, &remote, NS, &p, None)
                .await
                .unwrap()
                .failed,
            1
        );
    }
    let puts = server.state.lock().unwrap().puts;
    assert_eq!(
        upload_pending(&a.db, &remote, NS, &p, None)
            .await
            .unwrap()
            .failed,
        0
    );
    assert_eq!(server.state.lock().unwrap().puts, puts);
    server.state.lock().unwrap().deny_manifests = false;
    assert_eq!(
        upload_pending(&a.db, &remote, NS, &p, Some((KEY, URL)))
            .await
            .unwrap()
            .uploaded,
        1
    );
    assert_eq!(
        a.c()
            .query_row("SELECT count(*) FROM reading_media_outbox", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    let gets = server.state.lock().unwrap().gets[&key];
    server.state.lock().unwrap().corrupt = true;
    stage(&a.c(), NS, "a", &p, Some((KEY, URL))).unwrap();
    assert!(upload_pending(&a.db, &remote, NS, &p, Some((KEY, URL)))
        .await
        .is_err());
    assert!(
        server.state.lock().unwrap().gets[&key] > gets,
        "explicit recheck must not hide behind a matching ETag receipt"
    );
}
