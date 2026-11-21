use super::*;
use std::collections::BTreeSet;

fn schema(c: &Connection) {
    c.execute_batch(
        "CREATE TABLE agent_works (
            id TEXT PRIMARY KEY, goal TEXT NOT NULL, state TEXT NOT NULL,
            anchor_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
            grant_json TEXT NOT NULL DEFAULT '{\"libraryIds\":[\"retained\"]}',
            revision INTEGER NOT NULL DEFAULT 7);
         CREATE TABLE agent_records (
            id INTEGER PRIMARY KEY, work_id TEXT NOT NULL, kind TEXT NOT NULL,
            body_json TEXT NOT NULL);",
    )
    .unwrap();
}

fn database() -> Connection {
    let c = Connection::open_in_memory().unwrap();
    schema(&c);
    c
}

fn work(c: &Connection, id: &str, title: &str, updated: i64) {
    c.execute(
        "INSERT INTO agent_works(id,goal,state,anchor_json,updated_at)
         VALUES(?1,?2,'completed','null',?3)",
        params![id, title, updated],
    )
    .unwrap();
}

fn append(c: &Connection, id: &str, kind: &str, body: &Value) -> Result<(), String> {
    c.execute(
        "INSERT INTO agent_records(work_id,kind,body_json) VALUES(?1,?2,?3)",
        params![id, kind, body.to_string()],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

fn preference(c: &Connection, id: &str, args: Value) -> Result<Value, String> {
    let change = change(&args)?;
    preference_on(c, id, &change, |next| {
        append(c, id, "historyPreference", next)
    })
}

fn page(c: &Connection, query: &str, archived: bool, before: Option<&Value>) -> Value {
    list_on(
        c,
        "null",
        before,
        Some(&json!(query)),
        Some(&json!(archived)),
    )
    .unwrap()
}

fn ids(value: &Value) -> Vec<String> {
    value["works"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["id"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn rename_preserves_original_goal_and_survives_history_changes() {
    let c = database();
    work(&c, "renamed", "原始问题", 10);
    preference(&c, "renamed", json!({"title":"  可搜索的新标题  "})).unwrap();
    preference(&c, "renamed", json!({"pinned":true})).unwrap();
    assert_eq!(
        title_on(&c, "renamed").unwrap().as_deref(),
        Some("可搜索的新标题")
    );
    let row = &page(&c, "新标题", false, None)["works"][0];
    assert_eq!(row["goal"], "原始问题");
    assert_eq!(row["title"], "可搜索的新标题");
    assert_eq!(row["pinned"], true);
    assert_eq!(ids(&page(&c, "原始问题", false, None)), vec!["renamed"]);
    assert!(change(&json!({"title":"   "})).is_err());
}

#[test]
fn title_search_filters_all_stored_rows_before_paging_and_ignores_answer_bodies() {
    let c = database();
    for n in 0..60 {
        work(&c, &format!("recent-{n:02}"), "近期其他对话", 10_000 + n);
    }
    for n in 0..45 {
        work(
            &c,
            &format!("match-{n:02}"),
            &format!("线束分析 {n}"),
            1_000 + n,
        );
    }
    append(
        &c,
        "recent-00",
        "delivery",
        &json!({"text":"线束分析：已撤回的正文"}),
    )
    .unwrap();
    assert!(ids(&page(&c, "", false, None))
        .iter()
        .all(|id| id.starts_with("recent-")));
    let first = page(&c, "  线束分析  ", false, None);
    assert_eq!(first["query"], "线束分析");
    assert_eq!(first["works"].as_array().unwrap().len(), 20);
    let second = page(&c, "线束分析", false, Some(&first["nextCursor"]));
    let third = page(&c, "线束分析", false, Some(&second["nextCursor"]));
    assert!(third["nextCursor"].is_null());
    let all = [ids(&first), ids(&second), ids(&third)].concat();
    assert_eq!(all.len(), 45);
    assert_eq!(all.iter().collect::<BTreeSet<_>>().len(), 45);
    assert!(all.iter().all(|id| id.starts_with("match-")));
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM agent_records", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn search_is_literal_case_insensitive_for_ascii_and_bound_to_each_cursor() {
    let c = database();
    for n in 0..25 {
        work(&c, &format!("id-{n:02}"), "Hub 100%_总结", n);
    }
    work(&c, "other", "普通对话", 99);
    let first = page(&c, "hub", false, None);
    assert_eq!(first["works"].as_array().unwrap().len(), 20);
    assert_eq!(
        page(&c, "%_", false, None)["works"]
            .as_array()
            .unwrap()
            .len(),
        20
    );
    assert!(ids(&page(&c, "' OR 1=1 --", false, None)).is_empty());
    for (query, archived, anchor) in [
        ("其他", false, Value::Null),
        ("hub", true, Value::Null),
        ("hub", false, json!({"kind":"note","libraryId":"different"})),
    ] {
        assert!(list_on(
            &c,
            &anchor.to_string(),
            Some(&first["nextCursor"]),
            Some(&json!(query)),
            Some(&json!(archived))
        )
        .is_err());
    }
    let mut legacy = page(&c, "", false, None)["nextCursor"].clone();
    legacy.as_object_mut().unwrap().remove("query");
    legacy.as_object_mut().unwrap().remove("archived");
    assert!(list_on(&c, "null", Some(&legacy), None, None).is_ok());
    assert!(list_on(&c, "null", Some(&legacy), Some(&json!("hub")), None).is_err());
}

#[test]
fn pinned_rows_cross_page_boundaries_once_and_archive_uses_date_order() {
    let c = database();
    for n in 0..42 {
        let id = format!("id-{n:02}");
        work(&c, &id, "分析记录", 1_000 + n);
        if n < 21 {
            preference(&c, &id, json!({"pinned":true})).unwrap();
        }
    }
    let first = page(&c, "", false, None);
    let second = page(&c, "", false, Some(&first["nextCursor"]));
    let third = page(&c, "", false, Some(&second["nextCursor"]));
    let all = [ids(&first), ids(&second), ids(&third)].concat();
    let expected: Vec<_> = (0..21)
        .rev()
        .chain((21..42).rev())
        .map(|n| format!("id-{n:02}"))
        .collect();
    assert_eq!(all, expected);
    for id in &all {
        preference(&c, id, json!({"archived":true})).unwrap();
    }
    assert!(ids(&page(&c, "", false, None)).is_empty());
    let first = page(&c, "", true, None);
    let second = page(&c, "", true, Some(&first["nextCursor"]));
    let third = page(&c, "", true, Some(&second["nextCursor"]));
    assert_eq!(
        [ids(&first), ids(&second), ids(&third)].concat(),
        (0..42)
            .rev()
            .map(|n| format!("id-{n:02}"))
            .collect::<Vec<_>>()
    );
}

#[test]
fn archive_survives_reopen_and_restore_keeps_legacy_pin_grants_and_records() {
    let path = std::env::temp_dir().join(format!(
        "hub-history-{}-{}.sqlite3",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    struct Cleanup(std::path::PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    let _cleanup = Cleanup(path.clone());
    {
        let c = Connection::open(&path).unwrap();
        schema(&c);
        work(&c, "retained", "已固定的历史对话", 1_000);
        append(
            &c,
            "retained",
            "historyPreference",
            &json!({"pinned":true,"deleted":false}),
        )
        .unwrap();
        append(
            &c,
            "retained",
            "delivery",
            &json!({"receipt":"KEEP_RECEIPT"}),
        )
        .unwrap();
        assert_eq!(page(&c, "", false, None)["works"][0]["archived"], false);
        assert_eq!(
            preference(&c, "retained", json!({"archived":true})).unwrap(),
            json!({"pinned":true,"deleted":false,"archived":true})
        );
    }
    let c = Connection::open(&path).unwrap();
    assert!(ids(&page(&c, "", false, None)).is_empty());
    assert_eq!(ids(&page(&c, "", true, None)), ["retained"]);
    preference(&c, "retained", json!({"archived":false})).unwrap();
    assert_eq!(page(&c, "", false, None)["works"][0]["pinned"], true);
    assert!(ids(&page(&c, "", true, None)).is_empty());
    assert_eq!(
        c.query_row(
            "SELECT grant_json,revision FROM agent_works WHERE id='retained'",
            [],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        )
        .unwrap(),
        ("{\"libraryIds\":[\"retained\"]}".into(), 7)
    );
    assert_eq!(
        c.query_row(
            "SELECT body_json FROM agent_records WHERE kind='delivery'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "{\"receipt\":\"KEEP_RECEIPT\"}"
    );
}

#[test]
fn deletion_and_undo_preserve_archive_and_pin_independently() {
    let c = database();
    work(&c, "chat", "需要保留", 1);
    preference(&c, "chat", json!({"archived":true,"pinned":true})).unwrap();
    preference(&c, "chat", json!({"deleted":true})).unwrap();
    assert!(ids(&page(&c, "", true, None)).is_empty());
    assert!(ids(&page(&c, "", false, None)).is_empty());
    preference(&c, "chat", json!({"deleted":false})).unwrap();
    assert_eq!(page(&c, "", true, None)["works"][0]["pinned"], true);
    preference(&c, "chat", json!({"pinned":false})).unwrap();
    assert_eq!(page(&c, "", true, None)["works"][0]["archived"], true);
}

#[test]
fn unchanged_preferences_do_not_append_and_failed_owner_writes_do_not_claim_success() {
    let c = database();
    work(&c, "chat", "保留状态", 1);
    preference(&c, "chat", json!({"archived":false})).unwrap();
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM agent_records", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    let error = preference_on(
        &c,
        "chat",
        &change(&json!({"archived":true})).unwrap(),
        |_| Err("宿主写入失败".into()),
    )
    .unwrap_err();
    assert_eq!(error, "宿主写入失败");
    assert_eq!(ids(&page(&c, "", false, None)), ["chat"]);
    preference(&c, "chat", json!({"archived":true})).unwrap();
    preference(&c, "chat", json!({"archived":true})).unwrap();
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM agent_records", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn invalid_filters_preferences_and_corrupt_records_fail_without_changing_history() {
    let c = database();
    work(&c, "chat", "保留状态", 1);
    for args in [
        json!({}),
        json!({"archived":"true"}),
        json!({"pinned":null}),
        json!({"deleted":1}),
    ] {
        assert!(change(&args).is_err());
    }
    assert!(list_on(&c, "null", None, Some(&json!(8)), None).is_err());
    assert!(list_on(&c, "null", None, None, Some(&json!("true"))).is_err());
    assert!(list_on(&c, "null", None, Some(&json!("字".repeat(200))), None).is_ok());
    assert!(list_on(&c, "null", None, Some(&json!("字".repeat(201))), None).is_err());
    c.execute("INSERT INTO agent_records(work_id,kind,body_json) VALUES('chat','historyPreference','broken')", []).unwrap();
    assert_eq!(
        preference(&c, "chat", json!({"archived":true})).unwrap_err(),
        "历史偏好损坏"
    );
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM agent_records", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn contextual_history_preserves_the_owners_serialized_locator_and_cursor_scope() {
    let c = database();
    // EvidenceLocator struct order is not serde_json::Value's sorted-map order.
    let anchor = r#"{"kind":"note","libraryId":"notes","documentId":"current","pageId":null}"#;
    for n in 0..24 {
        let id = format!("scoped-{n:02}");
        work(&c, &id, "当前页面对话", n);
        c.execute(
            "UPDATE agent_works SET anchor_json=?2 WHERE id=?1",
            params![id, anchor],
        )
        .unwrap();
    }
    work(&c, "other", "别的页面", 99);
    let first = list_on(&c, anchor, None, None, None).unwrap();
    assert_eq!(ids(&first).len(), 20);
    let second = list_on(&c, anchor, Some(&first["nextCursor"]), None, None).unwrap();
    assert_eq!(ids(&second).len(), 4);
    assert!(ids(&first)
        .iter()
        .chain(ids(&second).iter())
        .all(|id| id.starts_with("scoped-")));
    assert_eq!(
        first["nextCursor"]["anchor"],
        serde_json::from_str::<Value>(anchor).unwrap()
    );
}
