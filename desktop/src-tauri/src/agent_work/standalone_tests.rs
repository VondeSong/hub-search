use super::*;
use crate::source_evidence::tests::Fixture;
mod live;

#[test]
fn current_schema_installs_recent_index_without_changing_saved_work() {
    let f = Fixture::new();
    let id = create(&f);
    let before = store::load(&f.c(), &id).unwrap();
    f.c()
        .execute_batch("DROP INDEX agent_works_recent")
        .unwrap();
    crate::database::forget_initialized_database(&f.root.join("craft-search.sqlite3"));
    let c = f.c();
    assert!(c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='agent_works_recent')",
            [],
            |r| r.get::<_, bool>(0)
        )
        .unwrap());
    assert_eq!(
        serde_json::to_value(store::load(&c, &id).unwrap()).unwrap(),
        serde_json::to_value(before).unwrap()
    );
    assert_eq!(
        store::list(&f.root, None, None, None, None).unwrap()["works"][0]["id"],
        id
    );
}

fn create(f: &Fixture) -> String {
    let value=ui(&f.root,&json!({"action":"create","goal":"写一段简短介绍","successCriteria":"直接回答","anchor":null,"grant":Grant::default()})).unwrap();
    assert!(value["work"]["anchor"].is_null());
    value["work"]["id"].as_str().unwrap().into()
}
#[test]
fn initial_user_message_retains_its_recorded_send_time_and_legacy_time_is_unknown() {
    let f = Fixture::new();
    let id = create(&f);
    let saved = store::view(&f.root, &id).unwrap();
    let sent = saved["conversation"]["messages"][0]["createdAt"].as_i64().unwrap();
    assert!(sent > 0);
    f.c().execute("UPDATE agent_works SET updated_at=updated_at+60000 WHERE id=?1", [&id]).unwrap();
    assert_eq!(store::view(&f.root, &id).unwrap()["conversation"]["messages"][0]["createdAt"], sent);
    f.c().execute("DELETE FROM agent_records WHERE work_id=?1 AND kind='conversationCreated'", [&id]).unwrap();
    assert_eq!(store::view(&f.root, &id).unwrap()["conversation"]["messages"][0]["createdAt"], 0);
}
fn note() -> EvidenceLocator {
    EvidenceLocator::Note {
        library_id: "notes".into(),
        document_id: "private".into(),
        page_id: None,
    }
}
fn answer(f: &Fixture, id: &str) {
    let (work, run) = tests::claim(f, id);
    runner::investigate(&f.root,&work,&run,&Control::default(),|prompt,_| {
        assert!(!prompt.contains("秘密原文"));
        Ok(json!({"rationale":"直接回答","requests":[],"report":{"status":"completed","summary":"一段介绍","findings":[],"nextSteps":[],"questions":[],"limitations":[],"waitCondition":"","prose":{"markdown":"这是一段可以继续修改的介绍。","citations":[]}}}))
    }).unwrap();
}
#[test]
fn followup_context_keeps_prose_once_but_preserves_distinct_summary_and_saved_answer() {
    for summary in ["完整回答", "简短摘要"] {
        let f = Fixture::new();
        let id = create(&f);
        let (work, run) = tests::claim(&f, &id);
        runner::investigate(&f.root,&work,&run,&Control::default(),|_,_| {
            Ok(json!({"rationale":"直接回答","requests":[],"report":{"status":"completed","summary":summary,"findings":[],"nextSteps":[],"questions":[],"limitations":[],"waitCondition":"","prose":{"markdown":"完整回答","citations":[]}}}))
        }).unwrap();
        let current = store::load(&f.c(), &id).unwrap();
        let context = store::conversation::context(&f.root, &current).unwrap();
        let answer = &context["messages"][1];
        assert_eq!(answer["text"], "完整回答");
        if summary == "完整回答" {
            assert!(answer.get("summary").is_none());
        } else {
            assert_eq!(answer["summary"], summary);
        }
        let saved = ui(&f.root, &json!({"action":"status","id":id})).unwrap();
        assert_eq!(
            saved["conversation"]["messages"][1]["report"]["summary"],
            summary
        );
        assert_eq!(
            saved["conversation"]["messages"][1]["report"]["prose"]["markdown"],
            "完整回答"
        );
    }
}
#[test]
fn empty_scope_answers_and_reopens_without_reading_private_notes() {
    let f = Fixture::new();
    f.note("notes", "private", "秘密原文");
    let id = create(&f);
    let w = store::load(&f.c(), &id).unwrap();
    assert!(w
        .grant
        .reader(&f.root)
        .unwrap()
        .read(&note(), 0, 100, None)
        .is_err());
    assert!(!w.anchor_authorized());
    assert!(w.source_anchor().is_err());
    answer(&f, &id);
    let reopened = ui(&f.root, &json!({"action":"status","id":id})).unwrap();
    assert_eq!(
        reopened["work"]["report"]["prose"]["markdown"],
        "这是一段可以继续修改的介绍。"
    );
    assert_eq!(reopened["evidence"], json!([]));
    assert_eq!(
        ui(&f.root, &json!({"action":"list"})).unwrap()["works"][0]["id"],
        id
    );
    assert_eq!(reopened["actions"]["obsidianEditAvailable"], false);
}
#[test]
fn adding_and_withdrawing_a_note_keeps_work_history_and_budget_root() {
    let f = Fixture::new();
    f.note("notes", "private", "秘密原文");
    let id = create(&f);
    answer(&f, &id);
    let before = ui(&f.root, &json!({"action":"status","id":id})).unwrap();
    let after=ui(&f.root,&json!({"action":"message","id":id,"text":"结合所选资料继续","clientMessageId":"add-one","expectedRevision":1,"addNotes":[note()]})).unwrap();
    assert_eq!(after["work"]["id"], id);
    assert_eq!(after["work"]["authorizationVersion"], 2);
    assert_eq!(
        after["conversation"]["messages"][1]["report"]["prose"]["markdown"],
        before["work"]["report"]["prose"]["markdown"]
    );
    let w = store::load(&f.c(), &id).unwrap();
    assert!(w.anchor.is_none());
    assert_eq!(
        w.grant
            .reader(&f.root)
            .unwrap()
            .read(&note(), 0, 100, None)
            .unwrap()
            .content,
        "秘密原文"
    );
    assert_eq!(
        after["lifecycle"]["providerBudget"]["rootWorkId"],
        before["lifecycle"]["providerBudget"]["rootWorkId"]
    );
    let after=ui(&f.root,&json!({"action":"message","id":id,"text":"撤回所选资料","clientMessageId":"remove-one","expectedRevision":2,"removeNotes":[note()]})).unwrap();
    assert_eq!(after["work"]["authorizationVersion"], 3);
    let w = store::load(&f.c(), &id).unwrap();
    assert!(w
        .grant
        .reader(&f.root)
        .unwrap()
        .read(&note(), 0, 100, None)
        .is_err());
    let context = store::conversation::context(&f.root, &w).unwrap();
    assert!(!context.to_string().contains("秘密原文"));
    assert!(context.to_string().contains("这是一段可以继续修改的介绍。"));
}
#[test]
fn missing_anchor_never_accepts_implicit_library_access_or_invalid_locator() {
    let f = Fixture::new();
    for anchor in [Value::Null, json!({"kind":"invented"})] {
        assert!(ui(&f.root,&json!({"action":"create","goal":"test","successCriteria":"test","anchor":anchor,"grant":{"libraryIds":["notes"],"notes":[],"readingItemKeys":[]}})).is_err());
    }
    assert_eq!(
        ui(&f.root, &json!({"action":"list"})).unwrap()["works"],
        json!([])
    );
}
#[test]
fn legacy_anchored_records_still_roundtrip_and_filter_by_source() {
    let f = Fixture::new();
    f.note("notes", "current", "旧来源");
    let old = tests::create(&f, false);
    let new = create(&f);
    let anchored=ui(&f.root,&json!({"action":"list","anchor":{"kind":"note","libraryId":"notes","documentId":"current","pageId":null}})).unwrap();
    assert_eq!(anchored["works"].as_array().unwrap().len(), 1);
    assert_eq!(anchored["works"][0]["id"], old);
    assert_ne!(old, new);
    assert_eq!(
        ui(&f.root, &json!({"action":"list"})).unwrap()["works"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn work_history_pages_reach_older_work_without_mutation_or_scope_leak() {
    let f = Fixture::new();
    f.note("notes", "current", "旧来源");
    let anchor = json!({"kind":"note","libraryId":"notes","documentId":"current","pageId":null});
    let mut expected = Vec::new();
    for _ in 0..45 {
        expected.push(
            store::create(
                &f.root,
                "旧独立对话".into(),
                "直接回答".into(),
                None,
                Grant::default(),
            )
            .unwrap(),
        );
    }
    for _ in 0..2 {
        expected.push(tests::create(&f, false));
    }
    f.c()
        .execute("UPDATE agent_works SET updated_at=100", [])
        .unwrap();
    expected.sort();
    let before: Vec<String> = expected
        .iter()
        .map(|id| serde_json::to_string(&store::load(&f.c(), id).unwrap()).unwrap())
        .collect();
    let first = ui(&f.root, &json!({"action":"list"})).unwrap();
    assert_eq!(first["works"].as_array().unwrap().len(), 20);
    let cursor = first["nextCursor"].clone();
    assert!(ui(
        &f.root,
        &json!({"action":"list","anchor":anchor,"before":cursor})
    )
    .is_err());
    for invalid in [
        json!({"updatedAt":-1,"id":"a","anchor":null}),
        json!({"updatedAt":100,"id":"","anchor":null}),
        json!({"updatedAt":100,"id":"a"}),
        json!("bad"),
    ] {
        assert!(ui(&f.root, &json!({"action":"list","before":invalid})).is_err());
    }
    let mut actual = Vec::new();
    let mut page = first;
    loop {
        let rows = page["works"].as_array().unwrap();
        assert!(rows.len() <= 20);
        actual.extend(rows.iter().map(|r| r["id"].as_str().unwrap().to_string()));
        if page["nextCursor"].is_null() {
            break;
        }
        assert!(actual.len() <= expected.len());
        page = ui(
            &f.root,
            &json!({"action":"list","before":page["nextCursor"]}),
        )
        .unwrap();
    }
    assert_eq!(actual, expected);
    let filtered = ui(&f.root, &json!({"action":"list","anchor":anchor})).unwrap();
    assert_eq!(filtered["works"].as_array().unwrap().len(), 2);
    assert!(filtered["nextCursor"].is_null());
    let reopened = ui(
        &f.root,
        &json!({"action":"status","id":actual.last().unwrap()}),
    )
    .unwrap();
    assert_eq!(reopened["work"]["id"], actual.last().unwrap().as_str());
    let after: Vec<String> = expected
        .iter()
        .map(|id| serde_json::to_string(&store::load(&f.c(), id).unwrap()).unwrap())
        .collect();
    assert_eq!(before, after);
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM agent_runs", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn history_pin_delete_and_pagination_preserve_work_receipts() {
    let f = Fixture::new();
    let ids: Vec<_> = (0..24)
        .map(|_| {
            store::create(
                &f.root,
                "历史标题".into(),
                "回答".into(),
                None,
                Grant::default(),
            )
            .unwrap()
        })
        .collect();
    let before = serde_json::to_string(&store::load(&f.c(), &ids[0]).unwrap()).unwrap();
    ui(
        &f.root,
        &json!({"action":"setHistoryPreference","id":ids[0],"pinned":true}),
    )
    .unwrap();
    ui(
        &f.root,
        &json!({"action":"setHistoryPreference","id":ids[1],"deleted":true}),
    )
    .unwrap();
    let mut page = ui(&f.root, &json!({"action":"list"})).unwrap();
    assert_eq!(page["works"][0]["id"], ids[0]);
    let mut actual = Vec::new();
    loop {
        actual.extend(
            page["works"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v["id"].as_str().unwrap().to_owned()),
        );
        if page["nextCursor"].is_null() {
            break;
        }
        page = ui(
            &f.root,
            &json!({"action":"list","before":page["nextCursor"]}),
        )
        .unwrap();
    }
    assert_eq!(actual.len(), 23);
    assert!(!actual.contains(&ids[1]));
    assert_eq!(
        actual
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len(),
        23
    );
    assert_eq!(
        before,
        serde_json::to_string(&store::load(&f.c(), &ids[0]).unwrap()).unwrap()
    );
    assert!(ui(&f.root, &json!({"action":"status","id":ids[1]})).is_ok());
    ui(
        &f.root,
        &json!({"action":"setHistoryPreference","id":ids[1],"deleted":false}),
    )
    .unwrap();
    assert!(ui(
        &f.root,
        &json!({"action":"setHistoryPreference","id":ids[0],"pinned":"bad"})
    )
    .is_err());
    let run = "history-run".to_string();
    store::claim(&f.root, &ids[2], &run).unwrap();
    assert!(ui(
        &f.root,
        &json!({"action":"setHistoryPreference","id":ids[2],"archived":true})
    )
    .is_err());
    assert!(ui(
        &f.root,
        &json!({"action":"setHistoryPreference","id":ids[2],"deleted":true})
    )
    .is_err());
    f.c().execute("INSERT INTO agent_actions(id,work_id,kind,base_revision,authorization_version,state,context_hash,created_at,updated_at) VALUES('history-pending',?1,'archiveCopy',1,1,'unknown','',0,0)",[&ids[3]]).unwrap();
    assert!(ui(
        &f.root,
        &json!({"action":"setHistoryPreference","id":ids[3],"archived":true})
    )
    .is_err());
    assert!(ui(
        &f.root,
        &json!({"action":"setHistoryPreference","id":ids[3],"deleted":true})
    )
    .is_err());
}
