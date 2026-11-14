use super::*;

#[test]
fn source_details_preserve_the_catalog_inbox_and_repair_legacy_aliases() {
    for canonical in ["inbox", "inbox42"] {
        let root = std::env::temp_dir().join(format!("hub-inbox-identity-{}", random_url_safe(12)));
        fs::create_dir(&root).unwrap();
        let path = root.join("test.sqlite3");
        let c = open_database(&path).unwrap();
        c.execute("INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES('inbox-test','dida365','Inbox test',1,1)",[]).unwrap();
        c.execute("INSERT INTO dida_projects(library_id,project_id,name,raw_json,synced_at) VALUES('inbox-test',?1,'收件箱','{}',1)",[canonical]).unwrap();
        drop(c);
        let raw = json!({"id":"source","projectId":"inbox42","title":"Action","content":"Original and confirmed advice","kind":"TEXT","status":0});
        let mut tasks = Vec::new();
        collect_dida_tasks(&raw, "inbox42", &mut tasks);
        let op = library_runtime::begin(&root, "inbox-test", "test").unwrap();
        assert_eq!(
            persist_changed(&path, "inbox-test", tasks.clone(), None, None, None, &op).unwrap(),
            1
        );
        let c = open_database(&path).unwrap();
        let (project, stored): (String,String) = c.query_row("SELECT project_id,raw_json FROM dida_tasks WHERE library_id='inbox-test' AND task_id='source'",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert_eq!(project, canonical);
        assert_eq!(serde_json::from_str::<Value>(&stored).unwrap(), raw);
        drop(c);
        assert_eq!(
            persist_changed(&path, "inbox-test", tasks.clone(), None, None, None, &op).unwrap(),
            0
        );
        let c = open_database(&path).unwrap();
        c.execute(
            "UPDATE dida_tasks SET project_id='inbox-legacy' WHERE task_id='source'",
            [],
        )
        .unwrap();
        drop(c);
        assert_eq!(
            persist_changed(&path, "inbox-test", tasks, None, None, None, &op).unwrap(),
            1
        );
        assert_eq!(
            open_database(&path)
                .unwrap()
                .query_row(
                    "SELECT project_id FROM dida_tasks WHERE task_id='source'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            canonical
        );
        let mut other = Vec::new();
        collect_dida_tasks(
            &json!({"id":"other","projectId":"other-project","title":"Different list","content":"Preserve actual moves"}),
            "inbox42",
            &mut other,
        );
        persist_changed(&path, "inbox-test", other, None, None, None, &op).unwrap();
        assert_eq!(
            open_database(&path)
                .unwrap()
                .query_row(
                    "SELECT project_id FROM dida_tasks WHERE task_id='other'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "other-project"
        );
        drop(op);
        forget_initialized_database(&path);
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn completed_windows_overlap_and_drain_long_offline_gaps_without_skipping() {
    let now = chrono::DateTime::parse_from_rfc3339("2026-10-14T00:10:00+08:00")
        .unwrap()
        .timestamp();
    let (first, cursor) = completed_window(now, None);
    assert_eq!(cursor, now);
    assert!(
        chrono::DateTime::parse_from_rfc3339(first["search"]["startDate"].as_str().unwrap())
            .unwrap()
            .timestamp()
            < now - 29 * 86400
    );
    let (_, a) = completed_window(now, Some(now - 60 * 86400));
    let (_, b) = completed_window(now, Some(a));
    assert_eq!(a, now - 48 * 86400);
    assert_eq!(b, now - 36 * 86400);
}

#[test]
fn lightweight_changes_use_normal_storage_and_do_not_reindex_identical_snapshots() {
    let root = std::env::temp_dir().join(format!("hub-fast-task-{}", random_url_safe(12)));
    fs::create_dir(&root).unwrap();
    let path = root.join("test.sqlite3");
    let c = open_database(&path).unwrap();
    c.execute("INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES('fast','dida365','Fast',1,1)",[]).unwrap();
    drop(c);
    let mut tasks = Vec::new();
    collect_dida_tasks(
        &json!({"id":"external-new","projectId":"inbox","title":"Created without a date","content":"Original body","status":0,"createdTime":"2026-10-14T00:01:00+0800"}),
        "inbox",
        &mut tasks,
    );
    let op = library_runtime::begin(&root, "fast", "test").unwrap();
    assert_eq!(
        persist_changed(&path, "fast", tasks.clone(), Some(10), None, None, &op).unwrap(),
        1
    );
    let c = open_database(&path).unwrap();
    c.execute("UPDATE index_jobs SET status='completed'", [])
        .unwrap();
    drop(c);
    assert_eq!(
        persist_changed(&path, "fast", tasks.clone(), Some(20), None, None, &op).unwrap(),
        0
    );
    assert_eq!(
        open_database(&path)
            .unwrap()
            .query_row(
                "SELECT status FROM index_jobs WHERE source_id='external-new'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "completed"
    );
    tasks[0].status = 2;
    tasks[0].raw["status"] = json!(2);
    tasks[0].completed_time = Some("2026-10-14T00:02:00+0800".into());
    tasks[0].raw["completedTime"] = json!("2026-10-14T00:02:00+0800");
    assert_eq!(
        persist_changed(&path, "fast", tasks, Some(30), None, None, &op).unwrap(),
        1
    );
    assert_eq!(
        metadata_string(&open_database(&path).unwrap(), "dida_fast_completed:fast"),
        "30"
    );
    drop(op);
    forget_initialized_database(&path);
    fs::remove_dir_all(root).unwrap();
}
