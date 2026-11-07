use super::*;

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
