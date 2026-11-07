use super::*;

#[test]
fn v1_closeout_report_publication_late_write_failure_preserves_delivery_and_history() {
    let (f, id, chart, delivery) = protected();
    let run = "report-publication-write-failure";
    let work = store::claim(&f.root, &id, run).unwrap();
    let current = records(&f.c(), &id, "chartRevision").unwrap()[0].clone();
    call(
        &f,
        &work,
        run,
        &json!({"action":"validate","artifactId":current["artifactId"],"revision":current["revision"]}),
    );
    let report = accepted_report(&f, &work, run, "新报告不应在写入失败后发布");
    let before = store::load(&f.c(), &id).unwrap();
    let publications_before = store::records(&f.root, &id, "nativePublication", 32).unwrap();
    let records_before: i64 = f
        .c()
        .query_row("SELECT COUNT(*) FROM agent_records", [], |r| r.get(0))
        .unwrap();
    // Fail after the production transaction has inserted its delivery and
    // updated its run, so an incomplete rollback cannot pass this check.
    f.c().execute_batch("CREATE TRIGGER reject_report_publish BEFORE UPDATE OF report_json ON agent_works BEGIN SELECT RAISE(ABORT,'injected report publication write failure'); END;").unwrap();
    let error = publish(&f, &work, run, &report).unwrap_err();
    assert!(
        error.contains("injected report publication write failure"),
        "{error}"
    );
    let after = store::load(&f.c(), &id).unwrap();
    assert_eq!(
        serde_json::to_value(&before).unwrap(),
        serde_json::to_value(&after).unwrap()
    );
    assert_eq!(
        f.c()
            .query_row("SELECT state FROM agent_runs WHERE id=?1", [run], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
        "investigating"
    );
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM agent_records", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        records_before
    );
    assert_eq!(
        store::records(&f.root, &id, "nativePublication", 32).unwrap(),
        publications_before
    );
    assert_eq!(
        store::records(&f.root, &id, "delivery", 32).unwrap(),
        vec![delivery.clone()]
    );
    assert_eq!(
        store::view(&f.root, &id).unwrap()["analysisArtifacts"][0]["content"],
        chart
    );
    assert!(view_on(&f.root, &f.c(), &after)
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["content"] == chart));
    output(
        "report-publication-write-failure.json",
        &json!({"entry":"accepted report -> production store::publish -> late agent_works UPDATE failure -> production view/history", "injection":"SQLite BEFORE UPDATE RAISE(ABORT), after delivery insert and run update", "error":error,"transactionRolledBack":true,"oldReportAndDeliveryAndHistoryIntact":true,"failedDeliveryAdded":false,"saveSuccessReported":false,"physicalDiskExhaustionTested":false,"modelCalls":0}),
    );
}

#[test]
fn v1_closeout_snapshot_capture_write_failure_never_returns_usable_identity() {
    let (f, id, chart, delivery) = protected();
    let work = store::load(&f.c(), &id).unwrap();
    let reader = work.grant.reader(&f.root).unwrap();
    let old = analysis::execute(&reader, "hub_create_analysis_snapshot", &json!({})).unwrap();
    let database = f.root.join("analysis-snapshots.sqlite3");
    let snapshots = || {
        let c = rusqlite::Connection::open(&database).unwrap();
        let mut query = c
            .prepare("SELECT id,payload,created_at,expires_at FROM snapshots ORDER BY id")
            .unwrap();
        query
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    };
    let prior = snapshots();
    // Changing the authorized source prevents deduplication against the old
    // successful capture. Existing chart dependencies remain frozen history.
    f.note("notes", "current", "# 2025-01-01\n新的捕获内容\n");
    rusqlite::Connection::open(&database).unwrap().execute_batch("CREATE TRIGGER reject_capture BEFORE INSERT ON snapshots BEGIN SELECT RAISE(ABORT,'injected snapshot capture write failure'); END;").unwrap();
    let error = analysis::execute(
        &reader,
        "hub_create_analysis_snapshot",
        &json!({"supersedes":old["snapshot"]}),
    )
    .unwrap_err();
    assert!(
        error.contains("分析快照保存失败，未发布")
            && error.contains("injected snapshot capture write failure"),
        "{error}"
    );
    assert_eq!(snapshots(), prior);
    let old_read = analysis::execute(
        &reader,
        "hub_read_analysis_snapshot",
        &json!({"expectedSnapshot":old["snapshot"],"itemIndex":0,"start":0,"limit":8000}),
    )
    .unwrap();
    assert!(old_read["content"].as_str().unwrap().contains("2025-01-01"));
    rusqlite::Connection::open(&database)
        .unwrap()
        .execute_batch("DROP TRIGGER reject_capture;")
        .unwrap();

    // Actual filesystem failure at the storage-open boundary, in this fixture
    // only. Keep the old database bytes, then restore them before reading.
    let held = f.root.join("analysis-snapshots-held.sqlite3");
    std::fs::rename(&database, &held).unwrap();
    std::fs::create_dir(&database).unwrap();
    let unavailable = analysis::execute(&reader, "hub_create_analysis_snapshot", &json!({}));
    std::fs::remove_dir(&database).unwrap();
    std::fs::rename(&held, &database).unwrap();
    let path_error = unavailable.unwrap_err();
    assert!(path_error.contains("分析快照存储不可用"), "{path_error}");
    assert_eq!(snapshots(), prior);
    assert!(analysis::execute(
        &reader,
        "hub_read_analysis_snapshot",
        &json!({"expectedSnapshot":old["snapshot"],"itemIndex":0})
    )
    .is_ok());
    assert_eq!(
        store::records(&f.root, &id, "delivery", 1).unwrap()[0],
        delivery
    );
    assert_eq!(
        store::view(&f.root, &id).unwrap()["analysisArtifacts"][0]["content"],
        chart
    );
    output(
        "snapshot-capture-write-failure.json",
        &json!({"entry":"production hub_create_analysis_snapshot -> actual snapshot store -> error; old snapshot and delivery reopened through production readers", "checks":[{"injection":"SQLite snapshot INSERT RAISE(ABORT)","error":error},{"injection":"actual database path occupied by directory, saved database restored byte-for-byte","error":path_error}],"failedCaptureReturnedIdentity":false,"snapshotRowsUnchanged":true,"oldSnapshotReadable":true,"oldDeliveryIntact":true,"saveSuccessReported":false,"physicalDiskExhaustionTested":false,"allIoErrorsCovered":false,"modelCalls":0}),
    );
}
