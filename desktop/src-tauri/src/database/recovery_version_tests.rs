use super::*;
use serde_json::json;

fn facts(c: &Connection) -> Vec<Vec<Vec<String>>> {
    [
        "agent_works",
        "agent_runs",
        "agent_records",
        "agent_actions",
        "documents",
    ]
    .into_iter()
    .map(|table| {
        let mut q = c
            .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
            .unwrap();
        let n = q.column_count();
        let rows = q
            .query_map([], |r| {
                (0..n)
                    .map(|i| r.get_ref(i).map(|v| format!("{v:?}")))
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .unwrap();
        rows.collect::<Result<Vec<_>, _>>().unwrap()
    })
    .collect()
}
fn fixture() -> (crate::source_evidence::tests::Fixture, String) {
    let f = crate::source_evidence::tests::Fixture::new();
    f.note("notes", "current", "数据库升级保留来源、额度与未知结果。");
    let anchor = json!({"kind":"note","libraryId":"notes","documentId":"current","pageId":null});
    let v=crate::agent_work::ui(&f.root,&json!({"action":"create","goal":"保留同一事项和预算","successCriteria":"升级不重置额度或未知回执","anchor":anchor,"grant":{"libraryIds":[],"notes":[anchor],"readingItemKeys":[]}})).unwrap();
    let id = v["work"]["id"].as_str().unwrap().to_owned();
    crate::agent_work::ui(&f.root,&json!({"action":"freezeProviderBudget","id":id,"expectedWorkRevision":1,"limits":{"inputTokens":1000,"uncachedInputTokens":500,"outputTokens":100},"perRun":{"inputTokens":400,"uncachedInputTokens":200,"outputTokens":40},"unknownReservations":{}})).unwrap();
    let c = f.c();
    c.execute("INSERT INTO agent_actions(id,work_id,kind,base_revision,authorization_version,state,context_hash,receipt_json,created_at,updated_at) VALUES('unknown-owned',?1,'obsidianEdit',1,1,'unknown','saved-context','{\"fileVerified\":false,\"goalCompleted\":false}',1,1)",[&id]).unwrap();
    c.execute("INSERT INTO agent_records(id,work_id,kind,body_json,created_at) VALUES('recovery-policy',?1,'recoveryBudgetPolicy',?2,1)",rusqlite::params![id,json!({"schemaVersion":1,"rootWorkId":id,"workChecks":80,"actionChecks":4}).to_string()]).unwrap();
    (f, id)
}

#[test]
fn recovery_epoch_upgrade_keeps_work_quota_unknown_receipt_and_is_idempotent() {
    let (f, id) = fixture();
    let path = f.root.join("craft-search.sqlite3");
    let before = facts(&f.c());
    f.c()
        .execute(
            "UPDATE metadata SET value='78' WHERE key='schema_version'",
            [],
        )
        .unwrap();
    forget_initialized_database(&path);
    let c = open_database(&path).unwrap();
    assert_eq!(facts(&c), before);
    let version: String = c
        .query_row(
            "SELECT value FROM metadata WHERE key='schema_version'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(version, DATABASE_SCHEMA_VERSION.to_string());
    drop(c);
    let status = crate::agent_work::ui(&f.root, &json!({"action":"status","id":id})).unwrap();
    assert_eq!(status["actions"]["standaloneModelDrafts"]["allowed"], false);
    assert_eq!(
        status["actions"]["items"][0]["receipt"]["fileVerified"],
        false
    );
    assert_eq!(facts(&f.c()), before);
    forget_initialized_database(&path);
    assert_eq!(facts(&open_database(&path).unwrap()), before);
}

#[test]
fn recovery_epoch_future_database_refuses_read_write_and_preserves_facts() {
    let (f, _) = fixture();
    let path = f.root.join("craft-search.sqlite3");
    let before = facts(&f.c());
    f.c()
        .execute(
            "UPDATE metadata SET value=?1 WHERE key='schema_version'",
            [(DATABASE_SCHEMA_VERSION + 1).to_string()],
        )
        .unwrap();
    forget_initialized_database(&path);
    assert!(open_database(&path)
        .err()
        .unwrap()
        .contains("高于当前程序支持"));
    assert!(crate::source_evidence::open_read_database(&f.root)
        .err()
        .unwrap()
        .contains("不兼容"));
    let c = Connection::open(&path).unwrap();
    assert_eq!(facts(&c), before);
    assert_eq!(
        c.query_row(
            "SELECT value FROM metadata WHERE key='schema_version'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        (DATABASE_SCHEMA_VERSION + 1).to_string()
    );
}

#[test]
#[ignore = "one explicitly owned saved schema78 copy; no model or action dispatch"]
fn qualify_saved_recovery_epoch_upgrade_once_without_models_or_fact_rewrite() {
    let root = PathBuf::from(std::env::var("HUB_RECOVERY_EPOCH_ROOT").unwrap());
    let out = PathBuf::from(std::env::var("HUB_RECOVERY_EPOCH_OUT").unwrap());
    assert!(root.join(".hub-isolated-runtime-v1").is_file());
    assert!(!out.join("migration-start.json").exists());
    let path = root.join("craft-search.sqlite3");
    let c = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(
        c.query_row(
            "SELECT value FROM metadata WHERE key='schema_version'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "78"
    );
    let before = facts(&c);
    let original = "work-qmx-qclI33T4evy-Xe9Dpb4Z";
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM agent_runs WHERE work_id=?1",
            [original],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        6
    );
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM agent_actions", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    drop(c);
    std::fs::write(
        out.join("migration-start.json"),
        serde_json::to_vec_pretty(
            &json!({"models":0,"sourceEpoch":78,"targetEpoch":79,"originalWork":original}),
        )
        .unwrap(),
    )
    .unwrap();
    let c = open_database(&path).unwrap();
    assert_eq!(facts(&c), before);
    let after: String = c
        .query_row(
            "SELECT value FROM metadata WHERE key='schema_version'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(after, "79");
    drop(c);
    forget_initialized_database(&path);
    assert_eq!(facts(&open_database(&path).unwrap()), before);
    std::fs::write(out.join("migration-result.json"),serde_json::to_vec_pretty(&json!({"models":0,"businessDispatch":0,"oldEpoch":78,"newEpoch":79,"allWorkRunRecordActionDocumentRowsUnchanged":true,"originalWorkRuns":6,"idempotentReopen":true,"evidenceLevel":"formal backend/database migration, not native GUI or model"})).unwrap()).unwrap();
}
