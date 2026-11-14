use super::*;

const NOW_MS: i64 = 1_791_331_200_000;
const DAY_MS: i64 = 86_400_000;

#[test]
fn exact_search_target_is_found_outside_the_first_page_and_respects_lifecycle() {
    let c = database();
    seed(&c, "old-target", "bookmarks", NOW_MS - 1000);
    for i in 0..65 {
        seed(&c, &format!("recent-{i}"), "bookmarks", NOW_MS + i);
    }
    assert!(!run(&c, "all", "all", 0, Filters::default())
        .3
        .iter()
        .any(|v| v["key"] == "old-target"));
    let exact = Filters {
        item_key: Some("old-target".into()),
        ..Filters::default()
    };
    let result = run(&c, "all", "all", 0, exact.clone());
    assert_eq!(result.2, 1);
    assert_eq!(result.3[0]["key"], "old-target");
    c.execute(
        "INSERT INTO collection_lifecycle(item_key,state) VALUES('old-target','deleted')",
        [],
    )
    .unwrap();
    assert_eq!(run(&c, "all", "all", 0, exact).2, 0);
}

#[test]
fn collection_navigation_state_is_joined_once_per_item() {
    let c = database();
    seed(&c, "fixture", "bookmarks", NOW_MS);
    let statements = Box::new(std::cell::RefCell::new(Vec::<String>::new()));
    unsafe extern "C" fn capture(
        kind: u32,
        context: *mut std::ffi::c_void,
        statement: *mut std::ffi::c_void,
        _sql: *mut std::ffi::c_void,
    ) -> std::ffi::c_int {
        if kind == rusqlite::ffi::SQLITE_TRACE_STMT as u32 {
            let sql = unsafe { rusqlite::ffi::sqlite3_sql(statement.cast()) };
            if !sql.is_null() {
                let statements = unsafe { &*(context as *const std::cell::RefCell<Vec<String>>) };
                statements.borrow_mut().push(
                    unsafe { std::ffi::CStr::from_ptr(sql) }
                        .to_string_lossy()
                        .into_owned(),
                );
            }
        }
        0
    }
    unsafe {
        rusqlite::ffi::sqlite3_trace_v2(
            c.handle(),
            rusqlite::ffi::SQLITE_TRACE_STMT as u32,
            Some(capture),
            (&*statements as *const std::cell::RefCell<Vec<String>>)
                .cast_mut()
                .cast(),
        );
    }
    let result = navigation_counts(&c, Some("all"));
    unsafe {
        rusqlite::ffi::sqlite3_trace_v2(c.handle(), 0, None, std::ptr::null_mut());
    }
    assert_eq!(result.unwrap()["all"], 1);
    let sql = statements.borrow()[0].clone();
    let plan = c
        .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
        .unwrap()
        .query_map(["all"], |r| r.get::<_, String>(3))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    for index in [
        "sqlite_autoindex_collection_lifecycle_1",
        "sqlite_autoindex_collection_x_properties_1",
    ] {
        assert_eq!(
            plan.iter().filter(|step| step.contains(index)).count(),
            1,
            "navigation must read each item's state once: {plan:?}"
        );
    }
}

#[test]
fn collection_source_counts_preserve_missing_source_status_and_lifecycle() {
    let c = database();
    for source in ["bookmarks", "likes", "telegram", "dida"] {
        for (key, state, status) in [
            ("default", "active", None),
            ("read", "active", Some("read")),
            ("abandoned", "active", Some("abandoned")),
            ("archived", "archived", None),
            ("deleted", "deleted", None),
            ("deleting", "deleting", None),
        ] {
            let key = format!("{source}:{key}");
            seed(&c, &key, source, NOW_MS);
            if state != "active" {
                c.execute(
                    "INSERT INTO collection_lifecycle(item_key,state) VALUES(?1,?2)",
                    params![key, state],
                )
                .unwrap();
            }
            if let Some(status) = status {
                c.execute(
                    "INSERT INTO collection_x_properties VALUES(?1,?2,'[]')",
                    params![key, status],
                )
                .unwrap();
            }
        }
    }
    seed(&c, "legacy", "bookmarks", NOW_MS);
    c.execute("UPDATE collection_x_items SET post_json=json_remove(post_json,'$.source') WHERE item_key='legacy'", []).unwrap();
    c.execute_batch("PRAGMA query_only=ON").unwrap();
    let trace = StatementCount::new(&c);
    let counts = source_counts(&c).unwrap();
    assert_eq!(
        trace.count.get(),
        1,
        "all source badges must share one query"
    );
    assert_eq!(
        counts,
        HashMap::from([
            ("bookmarks".into(), 3),
            ("likes".into(), 2),
            ("telegram".into(), 2),
            ("dida".into(), 2)
        ])
    );
}

struct StatementCount<'a> {
    connection: &'a Connection,
    count: Box<std::cell::Cell<usize>>,
}
impl<'a> StatementCount<'a> {
    fn new(connection: &'a Connection) -> Self {
        unsafe extern "C" fn count(
            kind: u32,
            context: *mut std::ffi::c_void,
            _statement: *mut std::ffi::c_void,
            _sql: *mut std::ffi::c_void,
        ) -> std::ffi::c_int {
            if kind == rusqlite::ffi::SQLITE_TRACE_STMT as u32 {
                let counter = unsafe { &*(context as *const std::cell::Cell<usize>) };
                counter.set(counter.get() + 1);
            }
            0
        }
        let result = Self {
            connection,
            count: Box::new(std::cell::Cell::new(0)),
        };
        // The boxed counter remains stable until Drop removes the SQLite callback.
        let code = unsafe {
            rusqlite::ffi::sqlite3_trace_v2(
                connection.handle(),
                rusqlite::ffi::SQLITE_TRACE_STMT as u32,
                Some(count),
                (&*result.count as *const std::cell::Cell<usize>)
                    .cast_mut()
                    .cast(),
            )
        };
        assert_eq!(code, rusqlite::ffi::SQLITE_OK);
        result
    }
}
impl Drop for StatementCount<'_> {
    fn drop(&mut self) {
        unsafe {
            rusqlite::ffi::sqlite3_trace_v2(
                self.connection.handle(),
                0,
                None,
                std::ptr::null_mut(),
            );
        }
    }
}

#[test]
fn collection_page_projection_is_read_only_and_has_constant_query_count() {
    let c = database();
    for index in 0..61 {
        let key = format!("page-{index:02}");
        seed(&c, &key, "bookmarks", NOW_MS + index);
        c.execute("INSERT INTO collection_x_properties(item_key,status,tags) VALUES(?1,'unread','[\"fixture\"]')",[key]).unwrap();
    }
    c.execute_batch("PRAGMA query_only=ON").unwrap();
    let writes = c.total_changes();
    let trace = StatementCount::new(&c);
    let full = run(&c, "bookmarks", "all", 0, Filters::default());
    assert_eq!(full.3.len(), 60);
    assert_eq!(full.3[0]["tags"], json!(["fixture"]));
    let full_queries = trace.count.replace(0);
    let tail = run(&c, "bookmarks", "all", 60, Filters::default());
    assert_eq!(tail.3.len(), 1);
    let tail_queries = trace.count.replace(0);
    assert_eq!(
        full_queries, tail_queries,
        "page size must not multiply database projections"
    );
    assert!(
        full_queries < 30,
        "unexpected repeated page queries: {full_queries}"
    );
    navigation_counts(&c, Some("bookmarks")).unwrap();
    run(&c, "bookmarks", "all", 0, Filters::default());
    assert_eq!(c.total_changes(), writes);
}

#[test]
fn reading_board_include_abandoned_defaults_off_and_uses_camel_case() {
    let normal: Filters = serde_json::from_value(json!({})).unwrap();
    assert!(!normal.include_abandoned);
    let board: Filters = serde_json::from_value(json!({"includeAbandoned":true})).unwrap();
    assert!(board.include_abandoned);
}

#[test]
fn reading_board_all_states_preserve_lifecycle_and_navigation_counts() {
    let c = database();
    for status in ["unread", "in_progress", "read", "abandoned"] {
        seed(&c, status, "bookmarks", NOW_MS);
        c.execute(
            "INSERT INTO collection_x_properties(item_key,status,tags) VALUES(?1,?1,'[]')",
            [status],
        )
        .unwrap();
    }
    for state in ["archived", "deleted", "deleting"] {
        seed(&c, state, "bookmarks", NOW_MS);
        c.execute(
            "INSERT INTO collection_x_properties(item_key,status,tags) VALUES(?1,'abandoned','[]')",
            [state],
        )
        .unwrap();
        c.execute(
            "INSERT INTO collection_lifecycle(item_key,state) VALUES(?1,?1)",
            [state],
        )
        .unwrap();
    }
    let counts = navigation_counts(&c, Some("bookmarks")).unwrap();
    assert_eq!(counts["all"], 3);
    assert_eq!(counts["abandoned"], 1);
    assert_eq!(run(&c, "bookmarks", "all", 0, Filters::default()).2, 3);
    let board = Filters {
        include_abandoned: true,
        ..Filters::default()
    };
    let result = run(&c, "bookmarks", "all", 0, board.clone());
    assert_eq!(result.2, 4);
    assert_eq!(result.3.len(), 4);
    for status in ["unread", "in_progress", "read", "abandoned"] {
        assert!(result.3.iter().any(|item| item["key"] == status));
        let explicit = run(&c, "bookmarks", status, 0, board.clone());
        assert_eq!(explicit.2, 1);
        assert_eq!(explicit.3[0]["key"], status);
    }
    assert_eq!(navigation_counts(&c, Some("bookmarks")).unwrap(), counts);
}

#[test]
fn reading_board_abandoned_inclusion_preserves_source_and_combined_filters() {
    let c = database();
    for (key, source, status, tags, library, kind, collected) in [
        (
            "kept",
            "bookmarks",
            "abandoned",
            json!(["阅读"]),
            "main",
            "video",
            NOW_MS,
        ),
        (
            "liked",
            "likes",
            "abandoned",
            json!(["阅读"]),
            "main",
            "video",
            NOW_MS,
        ),
        (
            "untagged",
            "bookmarks",
            "abandoned",
            json!([]),
            "main",
            "video",
            NOW_MS,
        ),
        (
            "other-library",
            "bookmarks",
            "abandoned",
            json!(["阅读"]),
            "other",
            "video",
            NOW_MS,
        ),
        (
            "photo",
            "bookmarks",
            "abandoned",
            json!(["阅读"]),
            "main",
            "photo",
            NOW_MS,
        ),
        (
            "old",
            "bookmarks",
            "abandoned",
            json!(["阅读"]),
            "main",
            "video",
            NOW_MS - 8 * DAY_MS,
        ),
        (
            "read",
            "bookmarks",
            "read",
            json!(["阅读"]),
            "main",
            "video",
            NOW_MS,
        ),
    ] {
        seed(&c, key, source, collected);
        let post = Post {
            id: key.into(),
            source: source.into(),
            text: "matching reference".into(),
            media: vec![Media {
                kind: kind.into(),
                url: format!("https://example.invalid/{key}"),
                preview_url: String::new(),
            }],
            ..Post::default()
        };
        c.execute(
            "UPDATE collection_x_items SET post_json=?2 WHERE item_key=?1",
            params![key, serde_json::to_string(&post).unwrap()],
        )
        .unwrap();
        c.execute(
            "INSERT INTO collection_x_properties(item_key,status,tags) VALUES(?1,?2,?3)",
            params![key, status, tags.to_string()],
        )
        .unwrap();
        save_remote(&c, key, library, "saved", true, "document");
    }
    let board = Filters {
        tags: vec!["阅读".into()],
        library_id: Some("main".into()),
        collected_within_days: Some(7),
        include_abandoned: true,
        ..Filters::default()
    };
    let filtered = |source: &str, status: &str, filters: Filters| {
        items_at(
            &c,
            "matching".into(),
            false,
            0,
            Some(source.into()),
            Some(status.into()),
            Some("video".into()),
            None,
            None,
            None,
            filters,
            NOW_MS,
        )
        .unwrap()
    };
    let result = filtered("bookmarks", "all", board.clone());
    assert_eq!(result.2, 2);
    assert!(result.3.iter().any(|item| item["key"] == "kept"));
    assert!(result.3.iter().any(|item| item["key"] == "read"));
    assert_eq!(
        filtered("bookmarks", "read", board.clone()).3[0]["key"],
        "read"
    );
    assert_eq!(
        filtered("bookmarks", "abandoned", board.clone()).3[0]["key"],
        "kept"
    );
    let likes = filtered("likes", "all", board.clone());
    assert_eq!(likes.2, 1);
    assert_eq!(likes.3[0]["key"], "liked");
    let other_library = filtered(
        "bookmarks",
        "all",
        Filters {
            library_id: Some("other".into()),
            ..board.clone()
        },
    );
    assert_eq!(other_library.2, 1);
    assert_eq!(other_library.3[0]["key"], "other-library");
    let normal = filtered(
        "bookmarks",
        "all",
        Filters {
            include_abandoned: false,
            ..board
        },
    );
    assert_eq!(normal.2, 1);
    assert_eq!(normal.3[0]["key"], "read");
}

#[test]
fn collection_navigation_dida_source_is_independent_and_included_in_all() {
    let c = database();
    seed(&c, "dida:one", "dida", NOW_MS);
    seed(&c, "x:one", "bookmarks", NOW_MS);
    let dida = run(&c, "dida", "all", 0, Filters::default());
    assert_eq!(dida.2, 1);
    assert_eq!(dida.3[0]["key"], "dida:one");
    assert_eq!(navigation_counts(&c, Some("dida")).unwrap()["all"], 1);
    assert_eq!(run(&c, "all", "all", 0, Filters::default()).2, 2);
}

#[test]
fn reading_deselection_hides_attention_and_copy_filter_without_destroying_receipts() {
    let c = database();
    seed(&c, "dida-fixture", "dida", NOW_MS);
    save_remote(&c, "dida-fixture", "secondary", "saved", true, "document");
    c.execute("INSERT INTO collection_library_pending(item_key,action,target,phase,error,updated_at) VALUES('dida-fixture','move','secondary','unknown','readback pending',1)", []).unwrap();
    assert_eq!(
        navigation_counts(&c, Some("dida")).unwrap()["needsAttention"],
        1
    );
    assert_eq!(
        navigation_counts(&c, Some("dida")).unwrap()["savedCopies"][0]["count"],
        1
    );
    c.execute(
        "UPDATE collection_library_destinations SET selected=0 WHERE item_key='dida-fixture'",
        [],
    )
    .unwrap();
    let counts = navigation_counts(&c, Some("dida")).unwrap();
    assert_eq!(counts["all"], 1);
    assert_eq!(counts["needsAttention"], 0);
    assert_eq!(counts["savedCopies"], json!([]));
    assert_eq!(
        run(
            &c,
            "dida",
            "all",
            0,
            Filters {
                library_id: Some("secondary".into()),
                ..Filters::default()
            }
        )
        .2,
        0
    );
    assert_eq!(
        c.query_row(
            "SELECT verified FROM collection_remote_copies WHERE item_key='dida-fixture'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    c.execute(
        "UPDATE collection_library_destinations SET selected=1 WHERE item_key='dida-fixture'",
        [],
    )
    .unwrap();
    assert_eq!(
        navigation_counts(&c, Some("dida")).unwrap()["savedCopies"][0]["count"],
        1
    );
}

#[test]
fn collection_navigation_date_windows_use_epoch_milliseconds_for_every_source() {
    let c = database();
    for source in ["bookmarks", "likes", "telegram", "dida"] {
        for (suffix, collected_at) in [
            ("week-outside", NOW_MS - 7 * DAY_MS - 1),
            ("week-exact", NOW_MS - 7 * DAY_MS),
            ("day-outside", NOW_MS - DAY_MS - 1),
            ("day-exact", NOW_MS - DAY_MS),
            ("recent", NOW_MS),
        ] {
            seed(&c, &format!("{source}:{suffix}"), source, collected_at);
        }
        let week = run(
            &c,
            source,
            "all",
            0,
            Filters {
                collected_within_days: Some(7),
                ..Filters::default()
            },
        );
        let day = run(
            &c,
            source,
            "all",
            0,
            Filters {
                collected_within_days: Some(1),
                ..Filters::default()
            },
        );
        assert_eq!(week.2, 4, "source={source}");
        assert_eq!(day.2, 2, "source={source}");
        assert!(week
            .3
            .iter()
            .any(|item| item["key"] == format!("{source}:week-exact")));
        assert!(!week
            .3
            .iter()
            .any(|item| item["key"] == format!("{source}:week-outside")));
        assert!(day
            .3
            .iter()
            .any(|item| item["key"] == format!("{source}:day-exact")));
        assert!(!day
            .3
            .iter()
            .any(|item| item["key"] == format!("{source}:day-outside")));
    }
    assert_eq!(
        run(
            &c,
            "all",
            "all",
            0,
            Filters {
                collected_within_days: Some(7),
                ..Filters::default()
            }
        )
        .2,
        16
    );
    // Exercise the production clock conversion as well as the deterministic boundary.
    let live = database();
    seed(
        &live,
        "old",
        "bookmarks",
        chrono::Utc::now().timestamp_millis() - 8 * DAY_MS,
    );
    assert_eq!(
        items(
            &live,
            "".into(),
            false,
            0,
            Some("all".into()),
            None,
            None,
            None,
            None,
            None,
            Filters {
                collected_within_days: Some(7),
                ..Filters::default()
            }
        )
        .unwrap()
        .2,
        0
    );
}

#[test]
fn daily_reading_uses_collected_date_with_inclusive_start_and_exclusive_end() {
    let c = database();
    let from = NOW_MS / 1000;
    let to = from + 86_400;
    for source in ["bookmarks", "likes", "telegram", "dida"] {
        for (suffix, collected_at) in [
            ("before", NOW_MS - 1),
            ("start", NOW_MS),
            ("end-last-ms", NOW_MS + DAY_MS - 1),
            ("next-day", NOW_MS + DAY_MS),
        ] {
            let key = format!("{source}:{suffix}");
            seed(&c, &key, source, collected_at);
            // Publication time deliberately disagrees with collection time.
            c.execute(
                "UPDATE collection_x_items SET post_json=json_set(post_json,'$.createdAt',?2) WHERE item_key=?1",
                params![key, if suffix == "before" { "2026-10-13T12:00:00Z" } else { "2000-01-01T00:00:00Z" }],
            ).unwrap();
        }
        let day = run(
            &c,
            source,
            "all",
            0,
            Filters {
                collected_from: Some(from),
                collected_to: Some(to),
                ..Filters::default()
            },
        );
        assert_eq!(day.2, 2, "source={source}");
        assert!(day
            .3
            .iter()
            .any(|item| item["key"] == format!("{source}:start")));
        assert!(day
            .3
            .iter()
            .any(|item| item["key"] == format!("{source}:end-last-ms")));
        assert!(day
            .3
            .iter()
            .all(|item| item["collectedAt"].as_i64().unwrap() >= NOW_MS
                && item["collectedAt"].as_i64().unwrap() < NOW_MS + DAY_MS));
    }
    let filters: Filters = serde_json::from_value(json!({
        "collectedFrom": from, "collectedTo": to
    }))
    .unwrap();
    assert_eq!(run(&c, "all", "all", 0, filters).2, 8);
}

#[test]
fn daily_reading_date_window_counts_and_pages_use_the_same_complete_filter() {
    let c = database();
    for n in 0..75 {
        seed(&c, &format!("inside-{n:02}"), "telegram", NOW_MS + n);
    }
    for n in 0..90 {
        seed(
            &c,
            &format!("outside-{n:02}"),
            "telegram",
            NOW_MS + DAY_MS + n,
        );
    }
    let filters = Filters {
        collected_from: Some(NOW_MS / 1000),
        collected_to: Some((NOW_MS + DAY_MS) / 1000),
        ..Filters::default()
    };
    let first = run(&c, "all", "all", 0, filters.clone());
    let last = run(&c, "all", "all", 60, filters);
    assert_eq!(first.2, 75);
    assert_eq!(last.2, 75);
    assert_eq!(first.3.len(), 60);
    assert_eq!(last.3.len(), 15);
    assert!(first
        .3
        .iter()
        .chain(&last.3)
        .all(|item| item["key"].as_str().unwrap().starts_with("inside-")));
    // Global navigation totals retain the reading workspace's existing meaning.
    assert_eq!(navigation_counts(&c, Some("all")).unwrap()["all"], 165);
}

#[test]
fn daily_reading_date_window_intersects_relative_filter_and_rejects_invalid_bounds() {
    let c = database();
    seed(&c, "two-days-old", "bookmarks", NOW_MS - 2 * DAY_MS);
    seed(&c, "today", "bookmarks", NOW_MS);
    let result = run(
        &c,
        "all",
        "all",
        0,
        Filters {
            collected_from: Some((NOW_MS - 3 * DAY_MS) / 1000),
            collected_to: Some((NOW_MS + DAY_MS) / 1000),
            collected_within_days: Some(1),
            ..Filters::default()
        },
    );
    assert_eq!(result.2, 1);
    assert_eq!(result.3[0]["key"], "today");
    for (from, to) in [
        (Some(3), Some(3)),
        (Some(4), Some(3)),
        (Some(i64::MAX), None),
        (None, Some(i64::MIN)),
    ] {
        assert!(items_at(
            &c,
            "".into(),
            false,
            0,
            Some("all".into()),
            None,
            None,
            None,
            None,
            None,
            Filters {
                collected_from: from,
                collected_to: to,
                ..Filters::default()
            },
            NOW_MS
        )
        .is_err());
    }
}

fn database() -> Connection {
    let c = super::super::tests::database();
    storage::schema(&c).unwrap();
    c
}

fn seed(c: &Connection, key: &str, source: &str, collected_at: i64) {
    let post = Post {
        id: key.into(),
        text: "matching reference".into(),
        source: source.into(),
        ..Post::default()
    };
    c.execute("INSERT INTO collection_x_items(item_key,account,post_json,content_hash,collected_at,captured_at) VALUES(?1,'fixture',?2,'fixture',?3,?3)", params![key,serde_json::to_string(&post).unwrap(),collected_at]).unwrap();
}

fn run(
    c: &Connection,
    source: &str,
    status: &str,
    offset: u32,
    filters: Filters,
) -> (i64, i64, i64, Vec<Value>) {
    items_at(
        c,
        "".into(),
        false,
        offset,
        Some(source.into()),
        Some(status.into()),
        None,
        None,
        None,
        None,
        filters,
        NOW_MS,
    )
    .unwrap()
}

fn save_remote(
    c: &Connection,
    key: &str,
    library: &str,
    state: &str,
    verified: bool,
    parent: &str,
) {
    c.execute(
        "INSERT INTO collection_library_destinations(item_key,target,state) VALUES(?1,?2,?3)",
        params![key, library, state],
    )
    .unwrap();
    c.execute("INSERT INTO collection_remote_copies(item_key,library_id,provider,object_id,parent_id,verified) VALUES(?1,?2,'craft',?3,?4,?5)", params![key,library,format!("object-{key}"),parent,verified]).unwrap();
}

#[test]
fn collection_navigation_counts_are_source_scoped_and_complete_before_paging() {
    let c = database();
    for n in 1..=75 {
        seed(&c, &n.to_string(), "bookmarks", NOW_MS + n);
    }
    c.execute(
        "UPDATE collection_x_items SET read_at=1 WHERE item_key='1'",
        [],
    )
    .unwrap();
    c.execute(
        "INSERT INTO collection_x_properties VALUES('2','in_progress','[]'),('3','abandoned','[]')",
        [],
    )
    .unwrap();
    c.execute("INSERT INTO collection_lifecycle(item_key,state) VALUES('4','archived'),('5','deleted'),('6','deleting')",[]).unwrap();
    for key in ["like-unread", "like-read", "like-abandoned"] {
        seed(&c, key, "likes", NOW_MS + 100);
    }
    c.execute("INSERT INTO collection_x_properties VALUES('like-read','read','[]'),('like-abandoned','abandoned','[]')",[]).unwrap();
    let counts = navigation_counts(&c, Some("bookmarks")).unwrap();
    assert_eq!(counts["all"], 71);
    assert_eq!(counts["unread"], 69);
    assert_eq!(counts["inProgress"], 1);
    assert_eq!(counts["read"], 1);
    assert_eq!(counts["archived"], 1);
    assert_eq!(counts["abandoned"], 1);
    assert_eq!(navigation_counts(&c, Some("likes")).unwrap()["all"], 2);
    let (total, unread, matched, first) = run(&c, "bookmarks", "all", 0, Filters::default());
    assert_eq!((total, unread, matched), (75, 74, 71));
    assert_eq!(first.len(), 60);
    let last = run(&c, "bookmarks", "all", 60, Filters::default());
    assert_eq!(last.2, 71);
    assert_eq!(last.3.len(), 11);
    let board = Filters {
        include_abandoned: true,
        ..Filters::default()
    };
    let board_first = run(&c, "bookmarks", "all", 0, board.clone());
    let board_last = run(&c, "bookmarks", "all", 60, board);
    assert_eq!(board_first.2, 72);
    assert_eq!(board_first.3.len(), 60);
    assert_eq!(board_last.2, 72);
    assert_eq!(board_last.3.len(), 12);
    assert_eq!(
        run(&c, "bookmarks", "abandoned", 0, Filters::default()).3[0]["key"],
        "3"
    );
    assert_eq!(
        run(&c, "bookmarks", "archived", 0, Filters::default()).3[0]["key"],
        "4"
    );
    assert_eq!(
        run(&c, "bookmarks", "in_progress", 0, Filters::default()).3[0]["key"],
        "2"
    );
}

#[test]
fn collection_navigation_combined_filters_run_before_pagination_and_use_original_media() {
    let c = database();
    for n in 1..=150 {
        let key = n.to_string();
        seed(
            &c,
            &key,
            "bookmarks",
            if n > 135 {
                NOW_MS - 8 * DAY_MS
            } else {
                NOW_MS - 3 * DAY_MS
            },
        );
        let mut post: Post = serde_json::from_str(
            &c.query_row(
                "SELECT post_json FROM collection_x_items WHERE item_key=?1",
                [&key],
                |r| r.get::<_, String>(0),
            )
            .unwrap(),
        )
        .unwrap();
        post.media.push(Media {
            kind: if (121..=135).contains(&n) {
                "photo"
            } else {
                "video"
            }
            .into(),
            url: format!("https://example.test/{n}"),
            preview_url: String::new(),
        });
        c.execute(
            "UPDATE collection_x_items SET post_json=?2 WHERE item_key=?1",
            params![key, serde_json::to_string(&post).unwrap()],
        )
        .unwrap();
        let tags = if (76..=90).contains(&n) {
            r#"["other","work"]"#
        } else if (91..=105).contains(&n) {
            r#"["AI"]"#
        } else {
            r#"["AI","work"]"#
        };
        c.execute(
            "INSERT INTO collection_x_properties VALUES(?1,'unread',?2)",
            params![key, tags],
        )
        .unwrap();
        save_remote(
            &c,
            &key,
            if (106..=120).contains(&n) {
                "different"
            } else {
                "main"
            },
            "saved",
            true,
            "document",
        );
    }
    let filters = Filters {
        tags: vec!["AI".into(), "work".into()],
        library_id: Some("main".into()),
        collected_within_days: Some(7),
        ..Filters::default()
    };
    let first = items_at(
        &c,
        "matching".into(),
        false,
        0,
        Some("all".into()),
        Some("all".into()),
        Some("video".into()),
        None,
        None,
        None,
        filters.clone(),
        NOW_MS,
    )
    .unwrap();
    let last = items_at(
        &c,
        "matching".into(),
        false,
        60,
        Some("all".into()),
        Some("all".into()),
        Some("video".into()),
        None,
        None,
        None,
        filters,
        NOW_MS,
    )
    .unwrap();
    assert_eq!(first.2, 75);
    assert_eq!(first.3.len(), 60);
    assert_eq!(last.2, 75);
    assert_eq!(last.3.len(), 15);
    assert_eq!(navigation_counts(&c, Some("all")).unwrap()["all"], 150);
    assert!(first.3.iter().chain(last.3.iter()).all(|i| i["key"]
        .as_str()
        .unwrap()
        .parse::<u32>()
        .unwrap()
        <= 75));
    let literal = Filters {
        tags: vec!["AI' OR 1=1 --".into()],
        ..Filters::default()
    };
    assert_eq!(run(&c, "all", "all", 0, literal).2, 0);
}

#[test]
fn collection_navigation_attention_uses_all_jobs_and_pending_targets_without_duplicates() {
    let c = database();
    for n in 1..=130 {
        seed(&c, &n.to_string(), "bookmarks", NOW_MS + n);
    }
    for (key, phase, error) in [
        ("1", "failed", "network"),
        ("2", "unknown", ""),
        ("3", "partial", ""),
        ("4", "needs_review", ""),
        ("5", "writing", "upload failed"),
        ("6", "queued", "old error"),
        ("7", "ready", "old error"),
        ("8", "cancelled", "cancelled"),
        ("9", "paused", "paused"),
        ("10", "saving", ""),
        ("11", "cleanup", ""),
        ("12", "cleanup", "verify failed"),
        ("13", "writing", ""),
        ("16", "failed", "deleted"),
        ("17", "failed", "archived"),
        ("18", "failed", "abandoned"),
        ("130", "failed", "last entry"),
    ] {
        c.execute("INSERT INTO collection_library_jobs(item_key,action,target,phase,error) VALUES(?1,'move','main',?2,?3)",params![key,phase,error]).unwrap();
    }
    for (key, target) in [("1", "second"), ("13", "second"), ("13", "third")] {
        c.execute("INSERT INTO collection_library_pending(item_key,action,target,phase,error,plan,updated_at,goal,cleanup_force,detail) VALUES(?1,'move',?2,'failed','retained','','0','',0,'')",params![key,target]).unwrap();
    }
    c.execute(
        "INSERT INTO collection_x_outbox(item_key,error) VALUES('14','cancel failed')",
        [],
    )
    .unwrap();
    c.execute(
        "INSERT INTO collection_x_enrichment VALUES('15','sig',0,'read failed')",
        [],
    )
    .unwrap();
    c.execute(
        "INSERT INTO collection_lifecycle(item_key,state) VALUES('16','deleted'),('17','archived')",
        [],
    )
    .unwrap();
    c.execute(
        "INSERT INTO collection_x_properties VALUES('18','abandoned','[]')",
        [],
    )
    .unwrap();
    let counts = navigation_counts(&c, Some("all")).unwrap();
    assert_eq!(counts["needsAttention"], 12);
    let (_, _, matched, items) = run(&c, "all", "needs_attention", 0, Filters::default());
    assert_eq!(matched, 12);
    let keys = items
        .iter()
        .map(|i| i["key"].as_str().unwrap())
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        keys,
        std::collections::BTreeSet::from([
            "1", "2", "3", "4", "5", "12", "13", "14", "15", "17", "18", "130"
        ])
    );
    let parked = items.iter().find(|item| item["key"] == "13").unwrap();
    assert_eq!(parked["attentionOperations"].as_array().unwrap().len(), 2);
    assert!(parked["attentionOperations"]
        .as_array()
        .unwrap()
        .iter()
        .all(|operation| operation["parked"] == true));
    assert_eq!(
        items.iter().find(|item| item["key"] == "130").unwrap()["attentionOperations"][0]["target"],
        "main"
    );
    assert_eq!(
        items.iter().find(|item| item["key"] == "14").unwrap()["attentionIssues"][0]["kind"],
        "sourceCancellation"
    );
    assert_eq!(
        items.iter().find(|item| item["key"] == "15").unwrap()["attentionIssues"][0]["kind"],
        "contentUpdate"
    );
}

#[test]
fn collection_navigation_saved_copies_require_completed_verified_content() {
    let c = database();
    for key in [
        "complete",
        "queued",
        "blocked",
        "unverified",
        "attachment-only",
        "abandoned",
        "archived",
    ] {
        seed(&c, key, "bookmarks", NOW_MS + 1);
    }
    for (key, state, verified, parent) in [
        ("complete", "saved", true, "document"),
        ("queued", "queued", true, "document"),
        ("blocked", "blocked", true, "document"),
        ("unverified", "saved", false, "document"),
        ("attachment-only", "saved", true, "attachment"),
        ("abandoned", "saved", true, "document"),
        ("archived", "saved", true, "document"),
    ] {
        save_remote(&c, key, "main", state, verified, parent);
    }
    c.execute(
        "INSERT INTO collection_x_properties VALUES('abandoned','abandoned','[]')",
        [],
    )
    .unwrap();
    c.execute(
        "INSERT INTO collection_lifecycle(item_key,state) VALUES('archived','archived')",
        [],
    )
    .unwrap();
    c.execute("INSERT INTO collection_remote_copies(item_key,library_id,provider,object_id,parent_id,verified) VALUES('complete','main','craft','second-object','document',1)",[]).unwrap();
    let counts = navigation_counts(&c, Some("all")).unwrap();
    assert_eq!(
        counts["savedCopies"],
        json!([{"libraryId":"main","count":1}])
    );
    let filters = Filters {
        library_id: Some("main".into()),
        ..Filters::default()
    };
    assert_eq!(
        run(&c, "all", "all", 0, filters.clone()).3[0]["key"],
        "complete"
    );
    assert_eq!(
        run(&c, "all", "archived", 0, filters).3[0]["key"],
        "archived"
    );
}

#[test]
fn collection_navigation_attention_exceeds_the_operation_log_limit() {
    let c = database();
    for n in 1..=130 {
        let key = n.to_string();
        seed(&c, &key, "bookmarks", NOW_MS + n);
        c.execute("INSERT INTO collection_library_jobs(item_key,action,target,phase,error,updated_at) VALUES(?1,'move','main','failed','fixture',?2)",params![key,n]).unwrap();
    }
    assert_eq!(
        navigation_counts(&c, Some("all")).unwrap()["needsAttention"],
        130
    );
    let first = run(&c, "all", "needs_attention", 0, Filters::default());
    let last = run(&c, "all", "needs_attention", 120, Filters::default());
    assert_eq!(first.2, 130);
    assert_eq!(first.3.len(), 60);
    assert_eq!(last.2, 130);
    assert_eq!(last.3.len(), 10);
    assert!(last
        .3
        .iter()
        .all(|item| item["attentionOperations"].as_array().unwrap().len() == 1));
    assert!(last.3.iter().any(|item| item["key"] == "1"));
}

#[test]
fn collection_navigation_obsidian_maps_completed_default_vault_exports_to_library_ids() {
    let c = database();
    c.execute_batch("CREATE TABLE libraries(id TEXT PRIMARY KEY,provider TEXT,enabled INTEGER,location TEXT,name TEXT); INSERT INTO libraries VALUES('vault-library','obsidian',1,'D:/Notes/','Notes')").unwrap();
    for key in ["default-done", "copy-done", "pending"] {
        seed(&c, key, "bookmarks", NOW_MS + 1);
    }
    c.execute(
        "INSERT INTO collection_roots VALUES('hash','d:\\notes')",
        [],
    )
    .unwrap();
    for key in ["default-done", "copy-done", "pending"] {
        c.execute(
            "INSERT INTO collection_obsidian_exports(destination,item_key,relative_path,file_hash,input_hash,media_pending) VALUES('hash',?1,'note.md','file','input',?2)",
            params![key, i64::from(key == "pending")],
        )
        .unwrap();
        c.execute(
            "INSERT INTO collection_library_destinations(item_key,target,state) VALUES(?1,?2,'saved')",
            params![
                key,
                if key == "copy-done" {
                    "vault-library"
                } else {
                    "vault:hash"
                }
            ],
        )
        .unwrap();
    }
    assert_eq!(
        navigation_counts(&c, Some("all")).unwrap()["savedCopies"],
        json!([{"libraryId":"vault-library","count":2}])
    );
    let filters = Filters {
        library_id: Some("vault-library".into()),
        ..Filters::default()
    };
    assert_eq!(run(&c, "all", "all", 0, filters).2, 2);
}

#[test]
fn collection_navigation_rejects_invalid_view_filters() {
    let c = database();
    for filters in [
        Filters {
            tags: vec!["".into()],
            ..Filters::default()
        },
        Filters {
            library_id: Some("".into()),
            ..Filters::default()
        },
        Filters {
            collected_within_days: Some(0),
            ..Filters::default()
        },
        Filters {
            collected_within_days: Some(36601),
            ..Filters::default()
        },
    ] {
        assert!(items_at(
            &c,
            "".into(),
            false,
            0,
            Some("all".into()),
            None,
            None,
            None,
            None,
            None,
            filters,
            NOW_MS
        )
        .is_err());
    }
    assert!(navigation_counts(&c, Some("unknown")).is_err());
}
