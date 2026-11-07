use super::*;

struct Fixture {
    root: PathBuf,
    database: PathBuf,
    connection: Connection,
    operation: Arc<library_runtime::Operation>,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("hub-reading-inbox-{}", random_url_safe(12)));
        fs::create_dir_all(&root).unwrap();
        let database = root.join("isolated.sqlite3");
        let connection = Connection::open(&database).unwrap();
        connection.execute_batch("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE libraries(id TEXT PRIMARY KEY,name TEXT,metadata_json TEXT);
            INSERT INTO libraries VALUES('fixture','隔离滴答','{}');
            CREATE TABLE collection_x_items(item_key TEXT PRIMARY KEY,account TEXT NOT NULL,post_json TEXT NOT NULL,collected_at INTEGER,captured_at INTEGER,read_at INTEGER,read_version INTEGER,content_hash TEXT);
            CREATE TABLE collection_x_properties(item_key TEXT PRIMARY KEY,status TEXT,tags TEXT);
            CREATE TABLE collection_property_updates(item_key TEXT PRIMARY KEY,version INTEGER);
            CREATE TABLE collection_x_enrichment(item_key TEXT PRIMARY KEY,signature TEXT,checked_at INTEGER,error TEXT);
            CREATE TABLE collection_remote_copies(item_key TEXT,library_id TEXT,provider TEXT,object_id TEXT,parent_id TEXT,verified INTEGER);
            CREATE TABLE collection_saved_media(item_key TEXT,media_url TEXT,path TEXT,PRIMARY KEY(item_key,media_url));
            CREATE TABLE collection_roots(destination TEXT PRIMARY KEY,root TEXT);
            CREATE TABLE collection_obsidian_exports(destination TEXT,item_key TEXT,relative_path TEXT,file_hash TEXT,input_hash TEXT,media_pending INTEGER,PRIMARY KEY(destination,item_key));").unwrap();
        schema(&connection).unwrap();
        crate::database::register_initialized_fixture(&database);
        let operation = Arc::new(library_runtime::begin(&root, "fixture", "隔离阅读测试").unwrap());
        Self {
            root,
            database,
            connection,
            operation,
        }
    }
    fn import(&mut self, task: &DidaTask) -> Receipt {
        commit_import(
            &mut self.connection,
            "fixture",
            "隔离滴答",
            "account-one",
            task,
            &refs(task).unwrap(),
            &self.operation,
        )
        .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        forget_initialized_database(&self.database);
        let db = std::mem::replace(&mut self.connection, Connection::open_in_memory().unwrap());
        let _ = db.close();
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn task(kind: &str) -> DidaTask {
    let raw = json!({"id":"task-one","projectId":"project-one","title":"稍后阅读资料","content":"完整正文\n\n[原始资料](https://example.invalid/source)","desc":"附加说明","kind":kind,"tags":["稍后读","已有标签"],"status":0,"items":[],"attachments":[],"modifiedTime":"2026-10-07T09:30:00.000+0000","createdTime":"2026-10-07T09:00:00.000+0000"});
    let mut tasks = Vec::new();
    collect_dida_tasks(&raw, "project-one", &mut tasks);
    tasks.remove(0)
}
fn batch(task: &DidaTask) -> Value {
    json!({"inboxId":"inbox123","projectProfiles":[{"id":"project-one","name":"阅读资料"}],"syncTaskBean":{"add":[task.raw],"update":[]}})
}
fn verified(record: &Receipt) -> Receipt {
    Receipt {
        verified: true,
        state: "verified".into(),
        ..record.clone()
    }
}

#[tokio::test]
async fn network_reading_asset_reuses_library_cache_and_updates_strict_task_receipt() {
    use crate::network_traffic_tests::{Fixture as NativeFixture, Reply, Server};
    let f = NativeFixture::new(PROVIDER_DIDA365);
    let c = open_database(&f.db).unwrap();
    super::super::schema(&c).unwrap();
    schema(&c).unwrap();
    drop(c);
    let count = Arc::new(AtomicUsize::new(0));
    let calls = count.clone();
    let server = Server::new(move |_| {
        let index = calls.fetch_add(1, Ordering::Relaxed);
        Reply::new(
            200,
            if index == 0 {
                b"%PDF-1.4 original reading source".to_vec()
            } else {
                b"%PDF-1.4 changed reading source with a new length".to_vec()
            },
        )
    });
    let operation = library_runtime::begin(&f.root, "space", "阅读缓存测试").unwrap();
    let aid = "0123456789abcdef01234567";
    let mut previous = String::new();
    for (title, status, revision, expected_gets) in [
        ("First", 0, "one", 1),
        ("Renamed", 2, "one", 1),
        ("Renamed", 2, "two", 2),
        ("Final title", 2, "two", 2),
    ] {
        let mut raw = json!({"id":"doc","projectId":"project","title":title,"content":"body","status":status,"kind":"TEXT","tags":["稍后读"],
            "attachments":[{"id":aid,"fileName":"reading.pdf","md5":revision}]});
        if title == "First" {
            raw["attachments"][0]["size"] = json!(b"%PDF-1.4 original reading source".len());
        }
        let mut tasks = Vec::new();
        collect_dida_tasks(&raw, "project", &mut tasks);
        let task = tasks.remove(0);
        persist_direct_dida_task(&f.db, "space", &task).unwrap();
        let record = {
            let (mut c, _writer) = open_write_database(&f.db).unwrap();
            commit_import(
                &mut c,
                "space",
                "Fixture",
                "account",
                &task,
                &refs(&task).unwrap(),
                &operation,
            )
            .unwrap()
        };
        if !previous.is_empty() {
            assert_ne!(previous, record.snapshot);
        }
        previous = record.snapshot.clone();
        let asset = refs(&task).unwrap().remove(0);
        let source = format!("{}/{}", asset.attachment_id, asset.file_name);
        let (bytes, _) = load_cached_attachment_resolving(
            &f.db,
            &f.store,
            PROVIDER_DIDA365,
            "space",
            "doc",
            &source,
            &Server::client(),
            || Ok(Some("fixture-cookie".into())),
            true,
            |_| Ok(server.url.clone()),
            MAX_ATTACHMENT_BYTES,
        )
        .await
        .unwrap();
        assert_eq!(
            bytes.blob.size,
            if revision == "one" {
                b"%PDF-1.4 original reading source".len() as u64
            } else {
                b"%PDF-1.4 changed reading source with a new length".len() as u64
            }
        );
        record_asset(
            &f.db,
            &f.store,
            &task,
            &asset,
            &record.key,
            &media_url("space", "doc", &asset),
            &bytes,
            &operation,
        )
        .unwrap();
        assert_eq!(count.load(Ordering::Relaxed), expected_gets);
        let c = open_database(&f.db).unwrap();
        verify_local(&c, &record, &storage::StorageConfig::default()).unwrap();
        assert!(!record.verified); // Reusing bytes alone never grants source deletion.
    }
}

#[test]
fn conflict_choice_is_terminal_reversible_and_bound_to_reviewed_receipt() {
    let mut f = Fixture::new();
    let record = f.import(&task("TEXT"));
    outcome(
        &f.connection,
        &record.key,
        "pending",
        "滴答任务与附件会话的正文版本不一致，来源保留",
    )
    .unwrap();
    let rows = resolution::list(&f.connection).unwrap();
    let row = &rows[0];
    let apply = |snapshot: &str, preserve: bool, error: &str, updated: i64| {
        resolution::resolve(
            &f.connection,
            &record.key,
            snapshot,
            error,
            updated,
            preserve,
        )
    };
    assert!(apply(
        "stale",
        true,
        row["error"].as_str().unwrap(),
        row["updatedAt"].as_i64().unwrap()
    )
    .is_err());
    apply(
        &record.snapshot,
        true,
        row["error"].as_str().unwrap(),
        row["updatedAt"].as_i64().unwrap(),
    )
    .unwrap();
    let summary = cleanup_summary(&f.connection).unwrap();
    assert_eq!(summary["pending"], 0);
    assert_eq!(summary["preserved"], 1);
    assert_eq!(summary["deleted"], 0);
    assert!(apply(
        &record.snapshot,
        true,
        row["error"].as_str().unwrap(),
        row["updatedAt"].as_i64().unwrap()
    )
    .is_err());
    let rows = resolution::list(&f.connection).unwrap();
    let row = &rows[0];
    apply(
        &record.snapshot,
        false,
        row["error"].as_str().unwrap(),
        row["updatedAt"].as_i64().unwrap(),
    )
    .unwrap();
    assert_eq!(cleanup_summary(&f.connection).unwrap()["pending"], 1);
    assert!(
        !receipt(&f.connection, "fixture", "task-one")
            .unwrap()
            .unwrap()
            .verified
    );
}

#[test]
fn attachment_inventory_issue_can_be_explicitly_ended_without_deleting_any_data() {
    let mut f = Fixture::new();
    let source = task("TEXT");
    let record = f.import(&source);
    outcome(
        &f.connection,
        &record.key,
        "pending",
        "滴答没有返回附件列表，暂时保留原内容",
    )
    .unwrap();
    let rows = resolution::list(&f.connection).unwrap();
    let row = &rows[0];
    assert_eq!(row["reasonKind"], "attachment-list-unavailable");
    assert_eq!(
        row["sourceUrl"],
        dida_task_url(&source.project_id, &source.id)
    );
    let before = f.connection.query_row(
        "SELECT raw_json,snapshot_hash,post_hash,local_verified FROM collection_dida_reading WHERE item_key=?1",
        [&record.key], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, bool>(3)?)),
    ).unwrap();
    resolution::resolve(
        &f.connection,
        &record.key,
        row["snapshot"].as_str().unwrap(),
        row["error"].as_str().unwrap(),
        row["updatedAt"].as_i64().unwrap(),
        true,
    )
    .unwrap();
    let after = f.connection.query_row(
        "SELECT raw_json,snapshot_hash,post_hash,local_verified FROM collection_dida_reading WHERE item_key=?1",
        [&record.key], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, bool>(3)?)),
    ).unwrap();
    assert_eq!(before, after);
    assert!(f
        .connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM collection_x_items WHERE item_key=?1)",
            [&record.key],
            |r| r.get::<_, bool>(0)
        )
        .unwrap());
    assert_eq!(cleanup_summary(&f.connection).unwrap()["pending"], 0);
    assert_eq!(cleanup_summary(&f.connection).unwrap()["preserved"], 1);
    assert_eq!(cleanup_summary(&f.connection).unwrap()["deleted"], 0);
    assert!(
        !receipt(&f.connection, "fixture", &source.id)
            .unwrap()
            .unwrap()
            .verified
    );
    let rows = resolution::list(&f.connection).unwrap();
    let row = &rows[0];
    resolution::resolve(
        &f.connection,
        &record.key,
        row["snapshot"].as_str().unwrap(),
        row["error"].as_str().unwrap(),
        row["updatedAt"].as_i64().unwrap(),
        false,
    )
    .unwrap();
    assert_eq!(cleanup_summary(&f.connection).unwrap()["pending"], 1);
}

#[test]
fn retained_decisions_cannot_modify_deleting_deleted_or_changed_receipts() {
    for state in ["deleting", "deleted"] {
        let mut f = Fixture::new();
        let record = f.import(&task("TEXT"));
        outcome(
            &f.connection,
            &record.key,
            state,
            "滴答没有返回附件列表，暂时保留原内容",
        )
        .unwrap();
        assert_eq!(resolution::list(&f.connection).unwrap(), json!([]));
        let (error, updated) = f
            .connection
            .query_row(
                "SELECT error,updated_at FROM collection_dida_reading WHERE item_key=?1",
                [&record.key],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
            )
            .unwrap();
        for preserve in [true, false] {
            assert!(resolution::resolve(
                &f.connection,
                &record.key,
                &record.snapshot,
                &error,
                updated,
                preserve
            )
            .is_err());
        }
        assert_eq!(
            receipt(&f.connection, "fixture", "task-one")
                .unwrap()
                .unwrap()
                .state,
            state
        );
    }
    let mut f = Fixture::new();
    let record = f.import(&task("TEXT"));
    outcome(
        &f.connection,
        &record.key,
        "pending",
        "滴答没有返回附件列表，暂时保留原内容",
    )
    .unwrap();
    let rows = resolution::list(&f.connection).unwrap();
    let row = &rows[0];
    f.connection
        .execute(
            "UPDATE collection_dida_reading SET snapshot_hash='changed' WHERE item_key=?1",
            [&record.key],
        )
        .unwrap();
    assert!(resolution::resolve(
        &f.connection,
        &record.key,
        row["snapshot"].as_str().unwrap(),
        row["error"].as_str().unwrap(),
        row["updatedAt"].as_i64().unwrap(),
        true
    )
    .is_err());
    assert_eq!(
        receipt(&f.connection, "fixture", "task-one")
            .unwrap()
            .unwrap()
            .state,
        "pending"
    );
}

#[test]
fn retained_decisions_retire_only_the_selected_source_warning_and_keep_audit_history() {
    for preserve in [true, false] {
        let mut f = Fixture::new();
        let record = f.import(&task("TEXT"));
        outcome(
            &f.connection,
            &record.key,
            "pending",
            "滴答任务与附件会话的正文版本不一致，来源保留",
        )
        .unwrap();
        if !preserve {
            f.connection.execute("UPDATE collection_dida_reading SET delete_state='preserved',error='用户选择保留两边内容，已结束自动清理' WHERE item_key=?1", [&record.key]).unwrap();
        }
        f.connection
            .execute(
                "UPDATE collection_x_enrichment SET checked_at=123 WHERE item_key=?1",
                [&record.key],
            )
            .unwrap();
        f.connection.execute("INSERT INTO collection_x_enrichment(item_key,signature,checked_at,error) VALUES('other-item','dida-reading',456,'另一个条目的问题')", []).unwrap();
        let rows = resolution::list(&f.connection).unwrap();
        let row = &rows[0];
        assert!(resolution::resolve(
            &f.connection,
            &record.key,
            "stale",
            row["error"].as_str().unwrap(),
            row["updatedAt"].as_i64().unwrap(),
            preserve
        )
        .is_err());
        assert_eq!(
            f.connection
                .query_row(
                    "SELECT error FROM collection_x_enrichment WHERE item_key=?1",
                    [&record.key],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "滴答任务与附件会话的正文版本不一致，来源保留"
        );
        resolution::resolve(
            &f.connection,
            &record.key,
            row["snapshot"].as_str().unwrap(),
            row["error"].as_str().unwrap(),
            row["updatedAt"].as_i64().unwrap(),
            preserve,
        )
        .unwrap();
        assert_eq!(f.connection.query_row("SELECT signature,checked_at,error FROM collection_x_enrichment WHERE item_key=?1", [&record.key], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?))).unwrap(), ("dida-reading".to_string(), 123, String::new()));
        assert_eq!(
            f.connection
                .query_row(
                    "SELECT error FROM collection_x_enrichment WHERE item_key='other-item'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "另一个条目的问题"
        );
        let reason: String = f
            .connection
            .query_row(
                "SELECT error FROM collection_dida_reading WHERE item_key=?1",
                [&record.key],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            reason,
            if preserve {
                "用户选择保留两边内容，已结束自动清理"
            } else {
                "用户要求重新读取检查"
            }
        );
    }
}

#[test]
fn retained_decisions_leave_other_enrichment_signatures_unchanged() {
    for preserve in [true, false] {
        let mut f = Fixture::new();
        let record = f.import(&task("TEXT"));
        outcome(
            &f.connection,
            &record.key,
            "pending",
            "滴答没有返回附件列表，暂时保留原内容",
        )
        .unwrap();
        f.connection.execute("UPDATE collection_x_enrichment SET signature='other-source',error='其他来源的处理问题',checked_at=456 WHERE item_key=?1", [&record.key]).unwrap();
        let rows = resolution::list(&f.connection).unwrap();
        let row = &rows[0];
        resolution::resolve(
            &f.connection,
            &record.key,
            row["snapshot"].as_str().unwrap(),
            row["error"].as_str().unwrap(),
            row["updatedAt"].as_i64().unwrap(),
            preserve,
        )
        .unwrap();
        assert_eq!(f.connection.query_row("SELECT signature,checked_at,error FROM collection_x_enrichment WHERE item_key=?1", [&record.key], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?))).unwrap(), ("other-source".to_string(), 456, "其他来源的处理问题".to_string()));
    }
}

#[test]
fn retained_decision_rolls_back_when_retiring_its_warning_fails() {
    let mut f = Fixture::new();
    let record = f.import(&task("TEXT"));
    outcome(
        &f.connection,
        &record.key,
        "pending",
        "滴答没有返回附件列表，暂时保留原内容",
    )
    .unwrap();
    let rows = resolution::list(&f.connection).unwrap();
    let row = &rows[0];
    f.connection.execute_batch("CREATE TRIGGER reject_enrichment_clear BEFORE UPDATE ON collection_x_enrichment BEGIN SELECT RAISE(ABORT,'isolated warning failure'); END;").unwrap();
    assert!(resolution::resolve(
        &f.connection,
        &record.key,
        row["snapshot"].as_str().unwrap(),
        row["error"].as_str().unwrap(),
        row["updatedAt"].as_i64().unwrap(),
        true
    )
    .is_err());
    assert_eq!(resolution::list(&f.connection).unwrap(), rows);
    assert_eq!(
        f.connection
            .query_row(
                "SELECT error FROM collection_x_enrichment WHERE item_key=?1",
                [&record.key],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "滴答没有返回附件列表，暂时保留原内容"
    );
}

#[test]
fn reading_schema_retires_legacy_preserved_warnings_without_touching_other_receipts() {
    let mut f = Fixture::new();
    let mut keys = Vec::new();
    for (name, state, signature) in [
        ("old-preserved", "preserved", "dida-reading"),
        ("still-pending", "pending", "dida-reading"),
        ("still-verified", "verified", "dida-reading"),
        ("other-source", "preserved", "other-source"),
        ("already-deleted", "deleted", "dida-reading"),
    ] {
        let mut source = task("TEXT");
        source.id = name.into();
        source.raw["id"] = json!(name);
        let record = f.import(&source);
        outcome(
            &f.connection,
            &record.key,
            state,
            if state == "preserved" {
                "用户选择保留两边内容，已结束自动清理"
            } else {
                "尚待核验的原项"
            },
        )
        .unwrap();
        f.connection.execute("UPDATE collection_x_enrichment SET signature=?2,error='旧版本遗留的问题',checked_at=123 WHERE item_key=?1", params![record.key,signature]).unwrap();
        keys.push((record.key, state, signature));
    }
    let before = f.connection.query_row("SELECT group_concat(delete_state||error,'|') FROM collection_dida_reading ORDER BY item_key", [], |r| r.get::<_, String>(0)).unwrap();
    schema(&f.connection).unwrap();
    schema(&f.connection).unwrap();
    for (key, state, signature) in keys {
        let row = f
            .connection
            .query_row(
                "SELECT signature,checked_at,error FROM collection_x_enrichment WHERE item_key=?1",
                [&key],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            row,
            (
                signature.to_string(),
                123,
                if state == "preserved" && signature == "dida-reading" {
                    String::new()
                } else {
                    "旧版本遗留的问题".to_string()
                }
            )
        );
    }
    let after = f.connection.query_row("SELECT group_concat(delete_state||error,'|') FROM collection_dida_reading ORDER BY item_key", [], |r| r.get::<_, String>(0)).unwrap();
    assert_eq!(before, after);
}

#[test]
fn reading_schema_handles_fresh_database_before_enrichment_exists() {
    let f = Fixture::new();
    f.connection
        .execute_batch("DROP TABLE collection_x_enrichment;")
        .unwrap();
    schema(&f.connection).unwrap();
}

#[test]
fn reading_inbox_legacy_auth_failure_summary_preserves_all_receipts_and_cloud_policy() {
    let mut fixture = Fixture::new();
    fixture.connection.execute_batch("INSERT INTO metadata VALUES('cloud_sync_reading','1'); INSERT INTO metadata VALUES('cloud_sync_enabled','1'); INSERT INTO metadata VALUES('dida_reading_last_success','1791510977');").unwrap();
    for index in 0..40 {
        let mut source = task("TEXT");
        source.id = format!("task-{index}");
        source.raw["id"] = json!(source.id);
        let record = fixture.import(&source);
        if index < 8 {
            fixture
                .connection
                .execute(
                    "UPDATE collection_dida_reading SET local_verified=1 WHERE item_key=?1",
                    [&record.key],
                )
                .unwrap();
            outcome(&fixture.connection, &record.key, "deleted", "").unwrap();
        } else {
            outcome(
                &fixture.connection,
                &record.key,
                "pending",
                "滴答精确来源读取失败（HTTP 401），来源保留",
            )
            .unwrap();
        }
    }
    fixture
        .connection
        .execute(
            "UPDATE collection_dida_reading SET updated_at=1791510977",
            [],
        )
        .unwrap();
    let summary = cleanup_summary(&fixture.connection).unwrap();
    assert_eq!(summary["pending"], 32);
    assert_eq!(summary["verified"], 0);
    assert_eq!(summary["deleted"], 8);
    assert_eq!(summary["authRequired"], true);
    assert_eq!(summary["mode"], "cloud-preserve");
    assert_eq!(summary["reasons"][0]["count"], 32);
    assert!(summary["reasons"][0]["message"]
        .as_str()
        .unwrap()
        .contains("请重新登录"));
    assert!(summary["lastRun"].is_null());
    assert_eq!(last_checked_at(&fixture.connection).unwrap(), 1791510977);
    assert!(metadata_string(&fixture.connection, "dida_reading_last_completed").is_empty());
    // Reading an old run never enables cleanup or rewrites source errors.
    assert!(metadata_string(&fixture.connection, "reading_source_cleanup").is_empty());
    let legacy: i64 = fixture.connection.query_row("SELECT count(*) FROM collection_dida_reading WHERE error='滴答精确来源读取失败（HTTP 401），来源保留'", [], |r|r.get(0)).unwrap();
    assert_eq!(legacy, 32);
    meta(&fixture.connection, "reading_source_cleanup", "1").unwrap();
    assert_eq!(
        cleanup_summary(&fixture.connection).unwrap()["mode"],
        "cloud-verified"
    );
    meta(&fixture.connection, "cloud_sync_reading", "0").unwrap();
    assert_eq!(
        cleanup_summary(&fixture.connection).unwrap()["mode"],
        "local"
    );
}

#[test]
fn reading_inbox_auth_failure_stops_run_without_hiding_blocked_items_or_successful_history() {
    let mut fixture = Fixture::new();
    let source = task("TEXT");
    let original = fixture.import(&source);
    let mut successful = SyncRun::default();
    assert!(successful.attempt());
    successful.completed = 1;
    successful.record(&fixture.connection, 100).unwrap();
    assert_eq!(
        cleanup_summary(&fixture.connection).unwrap()["lastRun"]["authenticationRequired"],
        false
    );
    let mut failed = SyncRun::default();
    for index in 0..32 {
        if failed.attempt() {
            assert_eq!(index, 0);
            failed.defer("滴答精确来源读取失败（HTTP 401），来源保留");
        }
    }
    failed.record(&fixture.connection, 200).unwrap();
    let summary = cleanup_summary(&fixture.connection).unwrap();
    assert_eq!(
        summary["lastRun"],
        json!({"attempted":1,"completed":0,"deferred":1,"blocked":31,"authenticationRequired":true})
    );
    assert!(
        metadata_string(&fixture.connection, "dida_reading_status").contains("32 条仍保留在滴答")
    );
    assert!(metadata_string(&fixture.connection, "dida_reading_status").contains("请重新登录"));
    assert!(!metadata_string(&fixture.connection, "dida_reading_status").contains("等待重试"));
    assert_eq!(
        metadata_string(&fixture.connection, "dida_reading_last_success"),
        "100"
    );
    assert_eq!(
        metadata_string(&fixture.connection, "dida_reading_last_completed"),
        "100"
    );
    assert_eq!(last_checked_at(&fixture.connection).unwrap(), 200);
    // Blocking is local to this run; a subsequent login/retry reuses the same
    // saved identity and can attempt the existing import without duplication.
    let mut retry = SyncRun::default();
    assert!(retry.attempt());
    let again = fixture.import(&source);
    assert_eq!(again.key, original.key);
    assert_eq!(again.snapshot, original.snapshot);
    assert_eq!(
        fixture
            .connection
            .query_row("SELECT count(*) FROM collection_x_items", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    let record = receipt(&fixture.connection, "fixture", &source.id)
        .unwrap()
        .unwrap();
    assert!(!record.verified);
    assert_eq!(record.state, "pending");
    assert!(can_delete(&record, &source).is_err());
}

#[test]
fn reading_inbox_non_auth_failure_does_not_block_other_sources_or_claim_complete_success() {
    let fixture = Fixture::new();
    let mut run = SyncRun::default();
    assert!(run.attempt());
    run.defer("本地原附件读回核验失败，滴答来源保留");
    assert!(run.attempt());
    run.completed += 1;
    run.record(&fixture.connection, 300).unwrap();
    assert_eq!(run.attempted, 2);
    assert_eq!(run.blocked, 0);
    assert!(metadata_string(&fixture.connection, "dida_reading_last_success").is_empty());
    assert!(metadata_string(&fixture.connection, "dida_reading_last_completed").is_empty());
    assert_eq!(last_checked_at(&fixture.connection).unwrap(), 300);
    assert!(metadata_string(&fixture.connection, "dida_reading_status")
        .contains("1 条仍保留在滴答，可在同步详情查看原因"));
    assert!(!metadata_string(&fixture.connection, "dida_reading_status").contains("等待重试"));
}

#[test]
fn reading_cleanup_summary_separates_disabled_deletion_from_unknown_attachment_inventory() {
    let mut fixture = Fixture::new();
    meta(&fixture.connection, "cloud_sync_reading", "1").unwrap();
    let reasons = [
        (
            "阅读云同步已启用：来源清理未开启，滴答原项已保留",
            "cleanup-disabled",
            true,
        ),
        (
            "滴答来源的附件清单未知，来源保留",
            "attachment-list-unavailable",
            false,
        ),
        (
            "滴答没有返回附件列表，暂时保留原内容",
            "attachment-list-unavailable",
            false,
        ),
        (
            "滴答返回的附件列表格式异常，暂时保留原内容",
            "attachment-list-unavailable",
            false,
        ),
        (
            "本地原附件读回核验失败，滴答来源保留",
            "attachment-incomplete",
            false,
        ),
        (
            "来源云端恢复检查未完整通过，滴答原项已保留",
            "cloud-verification",
            true,
        ),
    ];
    for (index, (message, _, locally_verified)) in reasons.iter().enumerate() {
        let mut source = task("TEXT");
        source.id = format!("task-{index}");
        source.raw["id"] = json!(source.id);
        let record = fixture.import(&source);
        fixture
            .connection
            .execute(
                "UPDATE collection_dida_reading SET local_verified=?2 WHERE item_key=?1",
                params![record.key, locally_verified],
            )
            .unwrap();
        outcome(&fixture.connection, &record.key, "pending", message).unwrap();
    }
    let summary = cleanup_summary(&fixture.connection).unwrap();
    assert_eq!(summary["pending"], 6);
    assert_eq!(summary["verified"], 2);
    assert_eq!(summary["cloudReading"], true);
    assert_eq!(summary["cleanupEnabled"], false);
    assert_eq!(summary["authRequired"], false);
    for (message, kind, _) in reasons {
        let row = summary["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["message"] == message)
            .unwrap();
        assert_eq!(row["kind"], kind);
        assert_eq!(row["count"], 1);
    }
    // Summarizing old receipts neither fills an unknown attachment inventory
    // nor enables cleanup or claims that incomplete local originals passed.
    assert!(metadata_string(&fixture.connection, "reading_source_cleanup").is_empty());
    let unverified: i64 = fixture
        .connection
        .query_row(
            "SELECT count(*) FROM collection_dida_reading WHERE local_verified=0",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(unverified, 4);
}

#[test]
fn reading_inbox_imports_material_without_rule_tag_or_generated_task_metadata() {
    let mut fixture = Fixture::new();
    let mut source = task("NOTE");
    source.time_zone = Some("Asia/Shanghai".into());
    source.items = vec![
        json!({"title":"正文中的检查项","status":0}),
        json!({"title":"已勾选条目","status":1}),
    ];
    source.content.push_str("\n\n**状态：** 这是用户写下的正文");
    source.attachments = vec![
        json!({"id":"0123456789abcdef01234567","name":"原件.pdf","fileType":"application/pdf"}),
    ];
    source.raw["timeZone"] = json!(source.time_zone);
    source.raw["items"] = json!(source.items);
    source.raw["content"] = json!(source.content);
    source.raw["attachments"] = json!(source.attachments);
    let original = source.raw.to_string();
    let record = fixture.import(&source);
    let (post, tags, raw): (String, String, String) = fixture.connection.query_row("SELECT i.post_json,p.tags,r.raw_json FROM collection_x_items i JOIN collection_x_properties p ON p.item_key=i.item_key JOIN collection_dida_reading r ON r.item_key=i.item_key WHERE i.item_key=?1",[&record.key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
    let post: Post = serde_json::from_str(&post).unwrap();
    assert!(post.text.starts_with("稍后阅读资料\n\n完整正文"));
    assert!(post.text.contains("附加说明"));
    assert!(post.text.contains("- [ ] 正文中的检查项"));
    assert!(post.text.contains("- [x] 已勾选条目"));
    assert!(post.text.contains("**状态：** 这是用户写下的正文"));
    assert!(post.text.contains("原件.pdf"));
    assert_eq!(post.all_media.len(), 1);
    assert!(!post.text.contains("**清单：**"));
    assert!(!post.text.contains("**时区：**"));
    assert!(!post.text.contains("**标签：**"));
    assert_eq!(
        serde_json::from_str::<Vec<String>>(&tags).unwrap(),
        vec!["已有标签"]
    );
    assert_eq!(raw, original);
    assert!(selected(&source));
    // Task view keeps its own presentation; Reading's policy is not global.
    assert!(dida_task_markdown(&source, "原清单").contains("**时区：** Asia/Shanghai"));
}

fn legacy_import(fixture: &mut Fixture, source: &DidaTask, state: &str) -> Receipt {
    let record = fixture.import(source);
    let mut post = post_for("fixture", "隔离滴答", source, &refs(source).unwrap());
    let legacy = dida_task_markdown(source, &source.project_id);
    post.text = legacy.strip_prefix("# ").unwrap_or(&legacy).into();
    let post = serde_json::to_string(&post).unwrap();
    let hash = storage::hash(post.as_bytes());
    fixture
        .connection
        .execute(
            "UPDATE collection_x_items SET post_json=?2,content_hash=?3 WHERE item_key=?1",
            params![record.key, post, hash],
        )
        .unwrap();
    fixture
        .connection
        .execute(
            "UPDATE collection_x_properties SET tags=?2,status='in_progress' WHERE item_key=?1",
            params![record.key, json!(source.tags).to_string()],
        )
        .unwrap();
    fixture.connection.execute("UPDATE collection_dida_reading SET post_hash=?2,delete_state=?3,local_verified=1 WHERE item_key=?1",params![record.key,hash,state]).unwrap();
    receipt(&fixture.connection, "fixture", &source.id)
        .unwrap()
        .unwrap()
}

#[test]
fn reading_inbox_migration_cleans_deleted_import_once_without_changing_source_receipt() {
    let mut fixture = Fixture::new();
    let source = task("NOTE");
    let before = legacy_import(&mut fixture, &source, "deleted");
    migrate_presentation(&fixture.connection).unwrap();
    let after = receipt(&fixture.connection, "fixture", &source.id)
        .unwrap()
        .unwrap();
    assert_eq!(after.state, "deleted");
    assert_eq!(after.snapshot, before.snapshot);
    assert_eq!(after.verified, before.verified);
    assert_ne!(after.post_hash, before.post_hash);
    let (post, tags, raw, status, version): (String, String, String, String, i64) = fixture.connection.query_row("SELECT i.post_json,p.tags,r.raw_json,p.status,i.read_version FROM collection_x_items i JOIN collection_x_properties p ON p.item_key=i.item_key JOIN collection_dida_reading r ON r.item_key=i.item_key WHERE i.item_key=?1",[&before.key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).unwrap();
    assert_eq!(
        serde_json::from_str::<Post>(&post).unwrap().text,
        reading_body(&source)
    );
    assert_eq!(
        serde_json::from_str::<Vec<String>>(&tags).unwrap(),
        vec!["已有标签"]
    );
    assert_eq!(raw, source.raw.to_string());
    assert_eq!(status, "in_progress");
    assert_eq!(version, 1);
    assert_eq!(storage::hash(post.as_bytes()), after.post_hash);
    migrate_presentation(&fixture.connection).unwrap();
    assert_eq!(
        fixture
            .connection
            .query_row("SELECT read_version FROM collection_x_items", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        fixture
            .connection
            .query_row("SELECT version FROM collection_property_updates", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(fixture.import(&source).state, "deleted");
}

#[test]
fn reading_inbox_migration_keeps_edited_body_and_other_sources() {
    let mut fixture = Fixture::new();
    let source = task("TEXT");
    let before = legacy_import(&mut fixture, &source, "verified");
    let mut edited = post_for("fixture", "隔离滴答", &source, &[]);
    edited.text = "用户编辑正文：稍后读\n**清单：** 用户自己的列表".into();
    let edited = serde_json::to_string(&edited).unwrap();
    fixture
        .connection
        .execute(
            "UPDATE collection_x_items SET post_json=?2,content_hash=?3 WHERE item_key=?1",
            params![before.key, edited, storage::hash(edited.as_bytes())],
        )
        .unwrap();
    let mut other = source.clone();
    other.id = "other-source".into();
    other.raw["id"] = json!(other.id);
    let other_record = legacy_import(&mut fixture, &other, "deleted");
    fixture.connection.execute("UPDATE collection_x_items SET post_json=json_set(post_json,'$.source','bookmarks') WHERE item_key=?1",[&other_record.key]).unwrap();
    migrate_presentation(&fixture.connection).unwrap();
    assert_eq!(
        fixture
            .connection
            .query_row(
                "SELECT post_json FROM collection_x_items WHERE item_key=?1",
                [&before.key],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        edited
    );
    assert_eq!(
        receipt(&fixture.connection, "fixture", &source.id)
            .unwrap()
            .unwrap()
            .post_hash,
        before.post_hash
    );
    assert_eq!(
        fixture
            .connection
            .query_row(
                "SELECT tags FROM collection_x_properties WHERE item_key=?1",
                [&other_record.key],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        json!(other.tags).to_string()
    );
}

#[test]
fn reading_inbox_migration_requires_pending_import_to_verify_cleaned_local_version() {
    let mut fixture = Fixture::new();
    let source = task("TEXT");
    let before = legacy_import(&mut fixture, &source, "verified");
    assert!(can_delete(&before, &source).is_ok());
    migrate_presentation(&fixture.connection).unwrap();
    let after = receipt(&fixture.connection, "fixture", &source.id)
        .unwrap()
        .unwrap();
    assert_eq!(after.state, "verified");
    assert!(!after.verified);
    assert!(can_delete(&after, &source).is_err());
    verify_local(
        &fixture.connection,
        &after,
        &storage::StorageConfig::default(),
    )
    .unwrap();
    can_delete(&verified(&after), &source).unwrap();
}

#[test]
fn reading_inbox_requires_the_exact_tag_for_tasks_and_notes() {
    for kind in ["TEXT", "NOTE"] {
        let mut source = task(kind);
        assert!(selected(&source));
        for tag in ["稍后阅读", "稍后读书", "稍后读 ", "#稍后读"] {
            source.tags = vec![tag.into()];
            assert!(!selected(&source));
        }
    }
}
#[test]
fn reading_inbox_identity_and_receipt_survive_restart_without_duplicate_import() {
    assert_ne!(
        identity("lib", "one", "task"),
        identity("lib", "two", "task")
    );
    assert_ne!(
        identity("first", "one", "task"),
        identity("second", "one", "task")
    );
    let mut fixture = Fixture::new();
    let source = task("NOTE");
    let first = fixture.import(&source);
    let reopened = Connection::open(&fixture.database).unwrap();
    assert_eq!(
        receipt(&reopened, "fixture", &source.id)
            .unwrap()
            .unwrap()
            .key,
        first.key
    );
    let again = fixture.import(&source);
    assert_eq!(first.key, again.key);
    assert_eq!(
        fixture
            .connection
            .query_row("SELECT count(*) FROM collection_x_items", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert!(!again.verified);
    let content: String = fixture
        .connection
        .query_row("SELECT post_json FROM collection_x_items", [], |r| r.get(0))
        .unwrap();
    assert!(content.contains("完整正文"));
    assert!(content.contains("附加说明"));
}
#[test]
fn reading_inbox_preliminary_body_is_saved_without_authorizing_source_deletion() {
    let mut fixture = Fixture::new();
    let mut source = task("TEXT");
    source.raw.as_object_mut().unwrap().remove("attachments");
    let record = fixture.import(&source);
    verify_local(
        &fixture.connection,
        &record,
        &storage::StorageConfig::default(),
    )
    .unwrap();
    assert!(can_delete(&record, &source).is_err());
    assert!(match_web_task(&batch(&source), &source).is_err());
}
#[test]
fn reading_inbox_rejects_changed_source_tag_version_and_unmigrated_children() {
    let mut fixture = Fixture::new();
    let source = task("NOTE");
    let record = verified(&fixture.import(&source));
    can_delete(&record, &source).unwrap();
    let mut edited = source.clone();
    edited.raw["content"] = json!("用户在同步期间编辑");
    assert!(can_delete(&record, &edited).is_err());
    let mut untagged = source.clone();
    untagged.tags.retain(|t| t != TAG);
    assert!(can_delete(&record, &untagged).is_err());
    let mut parent = source.clone();
    parent.raw["childIds"] = json!(["child-one"]);
    let parent_record = Receipt {
        snapshot: snapshot(&parent),
        ..record
    };
    assert!(can_delete(&parent_record, &parent).is_err());
}
#[test]
fn reading_inbox_unknown_or_paginated_attachment_inventory_keeps_source() {
    let source = task("NOTE");
    let complete = batch(&source);
    match_web_task(&complete, &source).unwrap();
    assert!(complete_batch(&json!({})).is_err());
    let mut paged = complete.clone();
    paged["hasMore"] = json!(true);
    assert!(complete_batch(&paged).is_err());
    let mut cursor = complete.clone();
    cursor["nextCursor"] = json!("next");
    assert!(complete_batch(&cursor).is_err());
    let mut missing = complete.clone();
    missing["syncTaskBean"]["add"][0]
        .as_object_mut()
        .unwrap()
        .remove("attachments");
    assert!(match_web_task(&missing, &source).is_err());
    let mut wrong = complete.clone();
    wrong["projectProfiles"] = json!([]);
    assert!(match_web_task(&wrong, &source).is_err());
    let mut edited = complete;
    edited["syncTaskBean"]["add"][0]["content"] = json!("不同版本");
    assert!(match_web_task(&edited, &source).is_err());
}
#[test]
fn reading_inbox_resolves_only_the_explicit_current_account_inbox() {
    let mut web = task("NOTE");
    web.project_id = "inbox123".into();
    web.raw["projectId"] = json!("inbox123");
    let batch = batch(&web);
    let mut alias = web.clone();
    alias.project_id = "inbox".into();
    alias.raw["projectId"] = json!("inbox");
    let matched = match_web_task(&batch, &alias).unwrap();
    assert_eq!(matched.project_id, "inbox123");
    let mut wrong = batch.clone();
    wrong["inboxId"] = json!("inbox456");
    assert!(match_web_task(&wrong, &alias).is_err());
    // The existing MCP reader canonicalizes either response form to its
    // supplied project, before the complete-web-inventory account check.
    let mut parsed = Vec::new();
    collect_dida_tasks(&alias.raw, "inbox123", &mut parsed);
    assert_eq!(parsed[0].project_id, "inbox123");
    match_web_task(&batch, &parsed[0]).unwrap();
}
#[test]
fn reading_inbox_keeps_hub_copies_and_craft_or_feishu_task_bindings() {
    let fixture = Fixture::new();
    let c = &fixture.connection;
    c.execute("INSERT INTO collection_remote_copies(item_key,library_id,provider,object_id,parent_id,verified) VALUES('copy','other-library','dida365','task-copy','project',0)",[]).unwrap();
    assert!(owned_copy(c, "fixture", "task-copy").unwrap());
    c.execute_batch("CREATE TABLE unified_task_bindings(provider TEXT,source_id TEXT);INSERT INTO unified_task_bindings VALUES('dida365','task-craft');CREATE TABLE feishu_task_bindings(dida_task_id TEXT);INSERT INTO feishu_task_bindings VALUES('task-feishu');").unwrap();
    assert!(owned_copy(c, "fixture", "task-craft").unwrap());
    assert!(owned_copy(c, "fixture", "task-feishu").unwrap());
    assert!(!owned_copy(c, "fixture", "user-source").unwrap());
}
#[test]
fn reading_inbox_delete_outbox_remains_idempotent_after_success_or_error() {
    let mut fixture = Fixture::new();
    let source = task("NOTE");
    let record = fixture.import(&source);
    outcome(
        &fixture.connection,
        &record.key,
        "pending",
        "HTTP 500，来源保留",
    )
    .unwrap();
    assert_eq!(
        receipt(&fixture.connection, "fixture", &source.id)
            .unwrap()
            .unwrap()
            .state,
        "pending"
    );
    outcome(&fixture.connection, &record.key, "deleted", "").unwrap();
    let mut restored = source.clone();
    restored.raw["content"] = json!("远端恢复原身份");
    restored.content = "远端恢复原身份".into();
    let prior = fixture
        .connection
        .query_row("SELECT post_json FROM collection_x_items", [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap();
    assert_eq!(fixture.import(&restored).state, "deleted");
    assert_eq!(
        fixture
            .connection
            .query_row("SELECT post_json FROM collection_x_items", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        prior
    );
}
#[test]
fn reading_inbox_local_body_and_receipt_require_independent_readback() {
    let mut fixture = Fixture::new();
    let source = task("NOTE");
    let record = fixture.import(&source);
    verify_local(
        &fixture.connection,
        &record,
        &storage::StorageConfig::default(),
    )
    .unwrap();
    fixture
        .connection
        .execute("UPDATE collection_dida_reading SET raw_json='{}'", [])
        .unwrap();
    assert!(verify_local(
        &fixture.connection,
        &record,
        &storage::StorageConfig::default()
    )
    .is_err());
    fixture
        .connection
        .execute(
            "UPDATE collection_dida_reading SET raw_json=?1",
            [source.raw.to_string()],
        )
        .unwrap();
    fixture
        .connection
        .execute("UPDATE collection_x_items SET post_json='{}'", [])
        .unwrap();
    assert!(verify_local(
        &fixture.connection,
        &record,
        &storage::StorageConfig::default()
    )
    .is_err());
}
#[test]
fn reading_inbox_attachment_version_and_original_hash_are_required() {
    let mut fixture = Fixture::new();
    let mut source = task("NOTE");
    source.attachments = vec![json!({"id":"0123456789abcdef01234567","fileName":"原件.pdf"})];
    source.raw["attachments"] = json!(source.attachments);
    let record = fixture.import(&source);
    let asset = refs(&source).unwrap().remove(0);
    let url = media_url("fixture", &source.id, &asset);
    assert!(verify_local(
        &fixture.connection,
        &record,
        &storage::StorageConfig::default()
    )
    .is_err());
    let path = fixture.root.join("original.pdf");
    let bytes = b"%PDF-1.7 original bytes";
    fs::write(&path, bytes).unwrap();
    fixture
        .connection
        .execute(
            "INSERT INTO collection_saved_media(item_key,media_url,path) VALUES(?1,?2,?3)",
            params![record.key, url, path.to_string_lossy()],
        )
        .unwrap();
    fixture.connection.execute("INSERT INTO collection_dida_reading_assets(item_key,media_url,blob_hash,file_name,mime_type,size,snapshot_hash) VALUES(?1,?2,?3,'原件.pdf','application/pdf',?4,?5)",params![record.key,url,storage::hash(bytes),bytes.len(),record.snapshot]).unwrap();
    verify_local(
        &fixture.connection,
        &record,
        &storage::StorageConfig::default(),
    )
    .unwrap();
    let vault = fixture.root.join("vault");
    fs::create_dir_all(&vault).unwrap();
    let mut cfg = storage::StorageConfig::default();
    cfg.mode = "obsidian".into();
    cfg.vault_path = vault.to_string_lossy().into();
    assert!(verify_local(&fixture.connection, &record, &cfg)
        .unwrap_err()
        .contains("原附件尚未保存到当前库"));
    fixture
        .connection
        .execute(
            "UPDATE collection_dida_reading_assets SET snapshot_hash='old-version'",
            [],
        )
        .unwrap();
    assert!(verify_local(
        &fixture.connection,
        &record,
        &storage::StorageConfig::default()
    )
    .is_err());
    assert!(local_asset(&fixture.connection, &url).is_err());
    fixture
        .connection
        .execute(
            "UPDATE collection_dida_reading_assets SET snapshot_hash=?1",
            [&record.snapshot],
        )
        .unwrap();
    fs::write(&path, b"%PDF-1.7 tampered bytes").unwrap();
    assert!(verify_local(
        &fixture.connection,
        &record,
        &storage::StorageConfig::default()
    )
    .is_err());
}
#[test]
fn reading_inbox_default_obsidian_requires_the_current_export_version() {
    let mut fixture = Fixture::new();
    let source = task("NOTE");
    let record = fixture.import(&source);
    let vault = fixture.root.join("vault");
    fs::create_dir_all(&vault).unwrap();
    let mut cfg = storage::StorageConfig::default();
    cfg.mode = "obsidian".into();
    cfg.vault_path = vault.to_string_lossy().into();
    cfg.download_media = true;
    let note = vault.join("note.md");
    fs::write(&note, "已保存正文").unwrap();
    fixture
        .connection
        .execute(
            "INSERT INTO collection_roots(destination,root) VALUES('vault',?1)",
            [vault.to_string_lossy().to_string()],
        )
        .unwrap();
    fixture.connection.execute("INSERT INTO collection_obsidian_exports(destination,item_key,relative_path,file_hash,input_hash,media_pending) VALUES('vault',?1,'note.md',?2,'stale-input',0)",params![record.key,file_hash(&note).unwrap()]).unwrap();
    assert!(verify_local(&fixture.connection, &record, &cfg).is_err());
    let cfg_hash=json!({"mode":cfg.mode,"vaultPath":cfg.vault_path,"downloadMedia":cfg.download_media,"noteFormat":4}).to_string();
    let input = storage::hash(format!("{}:0:{cfg_hash}", record.post_hash).as_bytes());
    let input =
        storage::hash(format!("{input}:{}", serde_json::to_string(&cfg).unwrap()).as_bytes());
    fixture
        .connection
        .execute(
            "UPDATE collection_obsidian_exports SET input_hash=?1",
            [input],
        )
        .unwrap();
    verify_local(&fixture.connection, &record, &cfg).unwrap();
    fs::write(&note, "用户修改的正文").unwrap();
    assert!(verify_local(&fixture.connection, &record, &cfg).is_err());
}
#[test]
fn reading_inbox_account_change_cannot_rebind_existing_receipts() {
    let mut fixture = Fixture::new();
    let source = task("NOTE");
    fixture.import(&source);
    assert!(commit_import(
        &mut fixture.connection,
        "fixture",
        "隔离滴答",
        "other-account",
        &source,
        &[],
        &fixture.operation
    )
    .is_err());
    account_matches(
        &fixture.connection,
        "fixture",
        "account-one",
        &batch(&source),
    )
    .unwrap();
    let mut different = batch(&source);
    different["inboxId"] = json!("inbox999");
    assert!(account_matches(&fixture.connection, "fixture", "account-one", &different).is_err());
}
#[tokio::test]
async fn reading_inbox_pause_during_writer_rate_wait_prevents_any_delete_request() {
    let fixture = Fixture::new();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let limiter = Arc::new(CraftRateLimiter::default());
    limiter.state.lock().await.next_allowed = Instant::now() + Duration::from_millis(120);
    let session = McpSession {
        space_id: "fixture".into(),
        space_name: "隔离滴答".into(),
        endpoint: format!("http://{}", listener.local_addr().unwrap()),
        access_token: "isolated-test-token".into(),
        session_id: None,
        protocol_version: "2025-03-26".into(),
        rate_limiter: limiter,
        deep_link_template: None,
    };
    let client = reqwest::Client::new();
    let mut write = Box::pin(DELETE_CONTROL.scope(
        (fixture.database.clone(), fixture.operation.clone()),
        call_dida_write_tool_raw(
            &client,
            &session,
            "delete_task",
            json!({"task_id":"isolated","project_id":"isolated"}),
            1,
        ),
    ));
    assert!(tokio::time::timeout(Duration::from_millis(20), &mut write)
        .await
        .is_err());
    library_runtime::control(&fixture.root, "fixture", "pause").unwrap();
    library_runtime::control(&fixture.root, "fixture", "resume").unwrap();
    assert!(write.await.is_err());
    assert!(
        tokio::time::timeout(Duration::from_millis(20), listener.accept())
            .await
            .is_err()
    );
}
#[tokio::test]
async fn reading_inbox_verified_originals_use_the_shared_delete_protocol() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut fixture = Fixture::new();
    let source = task("NOTE");
    let record = verified(&fixture.import(&source));
    verify_local(
        &fixture.connection,
        &record,
        &storage::StorageConfig::default(),
    )
    .unwrap();
    can_delete(&record, &source).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut buffer = [0u8; 4096];
        let message = loop {
            let n = socket.read(&mut buffer).await.unwrap();
            assert!(n > 0);
            request.extend_from_slice(&buffer[..n]);
            let Some(split) = request.windows(4).position(|v| v == b"\r\n\r\n") else {
                continue;
            };
            let header = String::from_utf8_lossy(&request[..split]);
            let length = header
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .and_then(|v| v.trim().parse::<usize>().ok())
                })
                .unwrap();
            if request.len() < split + 4 + length {
                continue;
            }
            break serde_json::from_slice::<Value>(&request[split + 4..split + 4 + length])
                .unwrap();
        };
        assert_eq!(message["method"], "tools/call");
        assert_eq!(message["params"]["name"], "delete_task");
        assert_eq!(message["params"]["arguments"]["task_id"], "task-one");
        assert_eq!(message["params"]["arguments"]["project_id"], "project-one");
        let body=json!({"jsonrpc":"2.0","id":74003,"result":{"isError":false,"content":[{"type":"text","text":"deleted"}]}}).to_string();
        let response=format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
        socket.write_all(response.as_bytes()).await.unwrap();
    });
    let session = McpSession {
        space_id: "fixture".into(),
        space_name: "隔离滴答".into(),
        endpoint,
        access_token: "isolated-test-token".into(),
        session_id: None,
        protocol_version: "2025-03-26".into(),
        rate_limiter: Arc::new(CraftRateLimiter::default()),
        deep_link_template: None,
    };
    let result = DELETE_CONTROL
        .scope(
            (fixture.database.clone(), fixture.operation.clone()),
            call_dida_write_tool_raw(
                &reqwest::Client::new(),
                &session,
                "delete_task",
                json!({"task_id":source.id,"project_id":source.project_id}),
                74003,
            ),
        )
        .await;
    assert!(result.is_ok(), "{result:?}");
    server.await.unwrap();
    fixture
        .operation
        .commit(|| outcome(&fixture.connection, &record.key, "deleted", ""))
        .unwrap();
    assert_eq!(
        receipt(&fixture.connection, "fixture", &source.id)
            .unwrap()
            .unwrap()
            .state,
        "deleted"
    );
}

#[tokio::test]
async fn reading_sync_prevents_source_delete_even_with_verified_local_body_and_master_paused() {
    let mut fixture = Fixture::new();
    let source = task("NOTE");
    let record = verified(&fixture.import(&source));
    verify_local(
        &fixture.connection,
        &record,
        &storage::StorageConfig::default(),
    )
    .unwrap();
    can_delete(&record, &source).unwrap();
    fixture.connection.execute_batch("INSERT INTO metadata VALUES('cloud_sync_reading','1'); INSERT INTO metadata VALUES('cloud_sync_enabled','0');").unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let session = McpSession {
        space_id: "fixture".into(),
        space_name: "隔离滴答".into(),
        endpoint: format!("http://{}", listener.local_addr().unwrap()),
        access_token: "isolated-test-token".into(),
        session_id: None,
        protocol_version: "2025-03-26".into(),
        rate_limiter: Arc::new(CraftRateLimiter::default()),
        deep_link_template: None,
    };
    let result = DELETE_CONTROL
        .scope(
            (fixture.database.clone(), fixture.operation.clone()),
            call_dida_write_tool_raw(
                &reqwest::Client::new(),
                &session,
                "delete_task",
                json!({"task_id":"task-one","project_id":"project-one"}),
                1,
            ),
        )
        .await;
    assert!(result.unwrap_err().contains("原项已保留"));
    assert!(
        tokio::time::timeout(Duration::from_millis(30), listener.accept())
            .await
            .is_err()
    );
}

#[test]
fn dida_retention_reasons_prioritize_quota_and_source_versions() {
    assert_eq!(
        retained_reason_kind("来源云端恢复检查未完整通过：正文：今日附件额度不足"),
        "quota-exhausted"
    );
    assert_eq!(
        retained_reason_kind("滴答任务与附件会话的正文版本不一致，来源保留"),
        "source-changed"
    );
}
