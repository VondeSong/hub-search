use super::*;
use crate::source_evidence::tests::Fixture;

fn reader(f: &Fixture) -> EvidenceReader {
    EvidenceReader::new(
        &f.root,
        EvidenceScope::new(vec!["notes".into()], vec![]).unwrap(),
    )
}
fn capture(f: &Fixture) -> Value {
    create(&reader(f), &json!({})).unwrap()
}

#[test]
fn frozen_statistics_and_pages_survive_edits_additions_and_reopening() {
    let f = Fixture::new();
    f.note("notes", "a", "学习 学习");
    f.note("notes", "b", "学习");
    let saved = capture(&f);
    assert_eq!(saved["status"], "ready");
    let first = execute(
        &reader(&f),
        "hub_list_note_sources",
        &json!({"expectedSnapshot":saved["snapshot"],"limit":1}),
    )
    .unwrap();
    f.note("notes", "a", "工作");
    f.note("notes", "new", "学习 学习 学习");
    let next = execute(
        &reader(&f),
        "hub_list_note_sources",
        &json!({"expectedSnapshot":saved["snapshot"],"offset":first["nextOffset"]}),
    )
    .unwrap();
    assert_eq!(next["total"], 2);
    assert_eq!(next["notes"][0]["locator"]["documentId"], "b");
    let stats = execute(
        &reader(&f),
        "hub_analyze_notes",
        &json!({"expectedSnapshot":saved["snapshot"],"terms":["学习"]}),
    )
    .unwrap();
    assert_eq!(stats["totals"]["terms"][0]["occurrences"], 3);
    assert_eq!(
        stats["sourceFreshness"],
        "historicalCapturedInputNotCurrentSource"
    );
    let latest = create(&reader(&f), &json!({"supersedes":saved["snapshot"]})).unwrap();
    assert_ne!(latest["snapshot"], saved["snapshot"]);
    assert_eq!(latest["supersedes"], saved["snapshot"]);
    let stats = execute(
        &reader(&f),
        "hub_analyze_notes",
        &json!({"expectedSnapshot":latest["snapshot"],"terms":["学习"]}),
    )
    .unwrap();
    assert_eq!(stats["totals"]["terms"][0]["occurrences"], 4);
}

#[test]
fn frozen_body_uses_unicode_scalar_ranges_and_original_revision() {
    let f = Fixture::new();
    f.note("notes", "a", "中😀e\u{301}文");
    let saved = capture(&f);
    f.note("notes", "a", "已改正文");
    let value = execute(
        &reader(&f),
        "hub_read_analysis_snapshot",
        &json!({"expectedSnapshot":saved["snapshot"],"itemIndex":0,"start":1,"limit":3}),
    )
    .unwrap();
    assert_eq!(value["content"], "😀e\u{301}");
    assert_eq!(value["end"], 4);
    assert_eq!(value["nextStart"], 4);
    assert_eq!(
        value["sourceRevision"]["bodySha256"],
        format!("{:x}", Sha256::digest("中😀e\u{301}文".as_bytes()))
    );
}

#[test]
fn deletion_revocation_and_scope_substitution_cannot_read_frozen_evidence() {
    let f = Fixture::new();
    f.note("notes", "a", "PRIVATE_SENTINEL");
    let saved = capture(&f);
    let args = json!({"expectedSnapshot":saved["snapshot"],"itemIndex":0});
    let wrong = EvidenceReader::new(
        &f.root,
        EvidenceScope::new(vec!["private".into()], vec![]).unwrap(),
    );
    assert!(execute(&wrong, "hub_read_analysis_snapshot", &args).is_err());
    f.c()
        .execute("UPDATE libraries SET enabled=0 WHERE id='notes'", [])
        .unwrap();
    assert!(execute(&reader(&f), "hub_read_analysis_snapshot", &args).is_err());
    f.c()
        .execute("UPDATE libraries SET enabled=1 WHERE id='notes'", [])
        .unwrap();
    f.c()
        .execute(
            "DELETE FROM documents WHERE space_id='notes' AND id='a'",
            [],
        )
        .unwrap();
    assert!(execute(&reader(&f), "hub_read_analysis_snapshot", &args)
        .unwrap_err()
        .contains("evidence_unavailable"));
}

#[test]
fn missing_body_is_partial_and_does_not_turn_into_a_later_body() {
    let f = Fixture::new();
    f.note("notes", "bad", "");
    let saved = capture(&f);
    assert_eq!(saved["status"], "partial");
    assert_eq!(saved["unavailableItems"], 1);
    f.note("notes", "bad", "后来同步成功");
    let stats = execute(
        &reader(&f),
        "hub_analyze_notes",
        &json!({"expectedSnapshot":saved["snapshot"]}),
    )
    .unwrap();
    assert_eq!(stats["complete"], false);
    assert_eq!(stats["documentsAnalyzed"], 0);
    assert!(execute(
        &reader(&f),
        "hub_read_analysis_snapshot",
        &json!({"expectedSnapshot":saved["snapshot"],"itemIndex":0})
    )
    .is_err());
}

#[test]
fn expired_missing_and_corrupt_snapshots_are_explicit_failures() {
    let f = Fixture::new();
    f.note("notes", "a", "正文");
    let saved = capture(&f);
    let args = json!({"expectedSnapshot":saved["snapshot"]});
    let c = database(&f.root, true).unwrap();
    c.execute("UPDATE snapshots SET expires_at=0", []).unwrap();
    assert!(execute(&reader(&f), "hub_analyze_notes", &args)
        .unwrap_err()
        .contains("snapshot_expired"));
    let next = create(&reader(&f), &json!({"supersedes":saved["snapshot"]})).unwrap();
    assert_eq!(next["supersedes"], saved["snapshot"]);
    c.execute("UPDATE snapshots SET payload='{}'", []).unwrap();
    assert!(execute(
        &reader(&f),
        "hub_analyze_notes",
        &json!({"expectedSnapshot":next["snapshot"]})
    )
    .unwrap_err()
    .contains("摘要不匹配"));
    c.execute("DELETE FROM snapshots", []).unwrap();
    assert!(execute(&reader(&f), "hub_analyze_notes", &args)
        .unwrap_err()
        .contains("evidence_unavailable"));
}

#[test]
fn quota_failure_keeps_previous_snapshot_and_does_not_publish_partial_input() {
    let f = Fixture::new();
    f.note("notes", "a", "original");
    let saved = capture(&f);
    std::fs::write(
        f.root.join("analysis-snapshot-policy.json"),
        r#"{"retentionHours":24,"maxStoreMib":1}"#,
    )
    .unwrap();
    f.note("notes", "a", &"x".repeat(1024 * 1024));
    assert!(create(&reader(&f), &json!({}))
        .unwrap_err()
        .contains("quota_exceeded"));
    let count: i64 = database(&f.root, false)
        .unwrap()
        .query_row("SELECT COUNT(*) FROM snapshots", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1);
    let value = execute(
        &reader(&f),
        "hub_read_analysis_snapshot",
        &json!({"expectedSnapshot":saved["snapshot"],"itemIndex":0}),
    )
    .unwrap();
    assert_eq!(value["content"], "original");
}

#[test]
fn filter_and_exact_note_authorization_remain_bound_to_snapshot() {
    let f = Fixture::new();
    f.note("notes", "a", "public");
    f.note("notes", "b", "SECRET");
    let scope = EvidenceScope::new(vec![], vec![])
        .unwrap()
        .with_notes(vec![EvidenceLocator::Note {
            library_id: "notes".into(),
            document_id: "a".into(),
            page_id: None,
        }])
        .unwrap();
    let r = EvidenceReader::new(&f.root, scope);
    let saved = create(&r, &json!({"query":"a"})).unwrap();
    let list = execute(
        &r,
        "hub_list_note_sources",
        &json!({"expectedSnapshot":saved["snapshot"]}),
    )
    .unwrap();
    assert_eq!(list["total"], 1);
    assert!(!list.to_string().contains("SECRET"));
    assert!(execute(
        &r,
        "hub_analyze_notes",
        &json!({"expectedSnapshot":saved["snapshot"],"query":"b"})
    )
    .unwrap_err()
    .contains("filter_mismatch"));
    assert!(
        create(&reader(&f), &json!({"supersedes":saved["snapshot"]}))
            .unwrap_err()
            .contains("scope_or_format_mismatch")
    );
}

#[test]
fn cancelled_capture_and_invalid_policy_publish_no_snapshot() {
    let f = Fixture::new();
    f.note("notes", "a", "正文");
    let control = crate::model_runtime::Control::default();
    control.cancel();
    assert!(create(&reader(&f).controlled(control), &json!({})).is_err());
    assert!(!f.root.join(DATABASE).exists());
    std::fs::write(
        f.root.join("analysis-snapshot-policy.json"),
        r#"{"retentionHours":0,"maxStoreMib":128}"#,
    )
    .unwrap();
    assert!(create(&reader(&f), &json!({})).is_err());
    assert!(!f.root.join(DATABASE).exists());
}

#[test]
fn committed_input_stays_readable_during_capture_write_and_expiry_is_not_cached() {
    let f = Fixture::new();
    f.note("notes", "a", "old committed source");
    let saved = capture(&f);
    let writer = database(&f.root, true).unwrap();
    assert_eq!(
        writer
            .pragma_query_value(None, "journal_mode", |r| r.get::<_, String>(0))
            .unwrap(),
        "wal"
    );
    assert_eq!(
        writer
            .pragma_query_value(None, "synchronous", |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        writer
            .pragma_query_value(None, "journal_size_limit", |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    writer
        .execute_batch("BEGIN EXCLUSIVE; UPDATE snapshots SET expires_at=0;")
        .unwrap();
    let r = reader(&f);
    let id = saved["snapshot"].clone();
    let (send, receive) = std::sync::mpsc::channel();
    let read = std::thread::spawn(move || {
        send.send(execute(
            &r,
            "hub_read_analysis_snapshot",
            &json!({"expectedSnapshot":id,"itemIndex":0}),
        ))
        .unwrap();
    });
    // The reader must finish before releasing this writer. This tests locking
    // semantics, not a formal performance score or an artificial model delay.
    let observed = receive.recv_timeout(Duration::from_secs(1));
    writer.execute_batch("ROLLBACK").unwrap();
    read.join().unwrap();
    let observed = observed
        .expect("old committed input waited for unrelated capture writer")
        .unwrap();
    assert_eq!(observed["content"], "old committed source");
    writer
        .execute("UPDATE snapshots SET expires_at=0", [])
        .unwrap();
    assert!(execute(
        &reader(&f),
        "hub_read_analysis_snapshot",
        &json!({"expectedSnapshot":saved["snapshot"],"itemIndex":0})
    )
    .unwrap_err()
    .contains("snapshot_expired"));
}

#[test]
fn startup_prepares_legacy_store_without_creating_cache_or_changing_saved_facts() {
    let f = Fixture::new();
    f.note("notes", "a", "original");
    prepare_existing_store(&f.root).unwrap();
    assert!(!f.root.join(DATABASE).exists());
    let old = capture(&f);
    let c = Connection::open(f.root.join(DATABASE)).unwrap();
    c.execute_batch("PRAGMA journal_mode=DELETE").unwrap();
    let facts: String = c
        .query_row(
            "SELECT id||payload||created_at||expires_at FROM snapshots",
            [],
            |r| r.get(0),
        )
        .unwrap();
    drop(c);
    prepare_existing_store(&f.root).unwrap();
    let c = Connection::open(f.root.join(DATABASE)).unwrap();
    assert_eq!(
        c.pragma_query_value(None, "journal_mode", |r| r.get::<_, String>(0))
            .unwrap(),
        "wal"
    );
    assert_eq!(
        c.query_row(
            "SELECT id||payload||created_at||expires_at FROM snapshots",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        facts
    );
    drop(c);
    assert_eq!(
        execute(
            &reader(&f),
            "hub_read_analysis_snapshot",
            &json!({"expectedSnapshot":old["snapshot"],"itemIndex":0})
        )
        .unwrap()["content"],
        "original"
    );
}

mod manifest_batches;
