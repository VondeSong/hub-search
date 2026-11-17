use super::*;
use crate::agent_work::{store, tests::create, ui};
use crate::source_evidence::tests::Fixture;
fn setup() -> (Fixture, String) {
    let f = Fixture::new();
    f.note("notes", "current", "长期只读合成原文");
    let id = create(&f, false);
    (f, id)
}
#[test]
fn initial_library_binding_is_one_user_request_and_an_explicit_repeat_remains_separate() {
    let f = Fixture::new();
    f.note("notes", "current", "实际范围的确定性夹具");
    let view=ui(&f.root,&json!({"action":"create","goal":"核对技能资料","successCriteria":"","anchor":null,"grant":{"libraryIds":[],"notes":[],"readingItemKeys":[]}})).unwrap();
    let id = view["work"]["id"].as_str().unwrap();
    let request = json!({"action":"message","id":id,"text":"核对技能资料","clientMessageId":"initial-scope","expectedRevision":1,"setLibraryIds":["notes"],"initialRequest":true});
    let bound = ui(&f.root, &request).unwrap();
    assert_eq!(
        bound["conversation"]["messages"].as_array().unwrap().len(),
        1
    );
    assert_eq!(bound["conversation"]["messages"][0]["text"], "核对技能资料");
    assert_eq!(bound["work"]["grant"]["libraryIds"], json!(["notes"]));
    assert_eq!(
        bound["work"]["grant"]["attachmentLibraryIds"],
        json!(["notes"])
    );
    let replay = ui(&f.root, &request).unwrap();
    assert_eq!(
        replay["conversation"]["messages"].as_array().unwrap().len(),
        1
    );
    let repeated=ui(&f.root,&json!({"action":"message","id":id,"text":"核对技能资料","clientMessageId":"explicit-repeat"})).unwrap();
    assert_eq!(
        repeated["conversation"]["messages"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}
#[test]
fn initial_library_binding_cannot_relabel_existing_history_or_change_the_initial_question() {
    let f = Fixture::new();
    f.note("notes", "current", "范围夹具");
    let view=ui(&f.root,&json!({"action":"create","goal":"原问题","successCriteria":"","anchor":null,"grant":{"libraryIds":[],"notes":[],"readingItemKeys":[]}})).unwrap();
    let id = view["work"]["id"].as_str().unwrap();
    assert!(ui(&f.root,&json!({"action":"message","id":id,"text":"另一个问题","clientMessageId":"forged-initial","expectedRevision":1,"setLibraryIds":["notes"],"initialRequest":true})).is_err());
    ui(
        &f.root,
        &json!({"action":"message","id":id,"text":"普通追问","clientMessageId":"regular"}),
    )
    .unwrap();
    assert!(ui(&f.root,&json!({"action":"message","id":id,"text":"原问题","clientMessageId":"late-initial","expectedRevision":2,"setLibraryIds":["notes"],"initialRequest":true})).is_err());
    let saved = ui(&f.root, &json!({"action":"status","id":id})).unwrap();
    assert_eq!(
        saved["conversation"]["messages"].as_array().unwrap().len(),
        2
    );
}
#[test]
fn materials_only_filters_old_answers_from_model_context_and_history_not_the_ui() {
    let (f, id) = setup();
    publish(&f, &id, 1, &[], "OLD_WEB_FACT_SENTINEL");
    ui(&f.root, &message(&f, &id, 2)).unwrap();
    ui(&f.root, &json!({"action":"configureAssistant","id":id,"options":{"model":null,"researchPolicy":"materials-only"}})).unwrap();
    let work = load(&f.c(), &id).unwrap();
    let model = context(&f.root, &work).unwrap().to_string();
    assert!(!model.contains("OLD_WEB_FACT_SENTINEL"));
    assert!(model.contains("固定追问2"));
    let history = history(&f.root, &work, None, None, 0, 6000).unwrap();
    assert!(!history.to_string().contains("OLD_WEB_FACT_SENTINEL"));
    assert!(history.to_string().contains("固定追问2"));
    assert!(read_on(&f.root, &f.c(), &work)
        .unwrap()
        .to_string()
        .contains("OLD_WEB_FACT_SENTINEL"));
}
fn note(id: &str) -> EvidenceLocator {
    serde_json::from_value(json!({"kind":"note","libraryId":"notes","documentId":id,"pageId":null}))
        .unwrap()
}
fn message(_f: &Fixture, id: &str, n: usize) -> Value {
    json!({"action":"message","id":id,"text":format!("固定追问{n}，保留原要求"),"clientMessageId":format!("fixed-message-{n}")})
}
fn publish(f: &Fixture, id: &str, n: usize, excerpts: &[EvidenceExcerpt], summary: &str) {
    publish_on(&f.root, id, n, excerpts, summary);
}
fn publish_on(root: &Path, id: &str, n: usize, excerpts: &[EvidenceExcerpt], summary: &str) {
    let b = Budget::mode("quick").unwrap();
    let run = format!("fixed-report-{n}");
    let w = store::claim_with_budget(root, id, &run, b).unwrap();
    let report=serde_json::from_value(json!({"status":"needsDecision","summary":summary,"findings":[],"nextSteps":[],"questions":["仅确定性保全检查"],"limitations":["无模型自主成绩"],"waitCondition":""})).unwrap();
    store::publish(
        root,
        &w,
        &run,
        &report,
        excerpts,
        &[],
        &json!([]),
        &Value::Null,
        &Control::default(),
    )
    .unwrap();
    store::execution_budget::settle(root,&w,&run,&json!({"modelCalls":0,"modelRetries":0,"outputRepairs":0,"toolSteps":0,"requestBytes":0,"bodyChars":0,"entitiesRead":0,"summaries":0,"elapsedMs":1})).unwrap();
}

#[test]
#[ignore = "one explicit owned native-history fixture, original exhausted Work retained, no provider"]
fn prepare_native_history_once_without_models_or_original_work_changes() {
    let root = std::path::PathBuf::from(std::env::var("HUB_HISTORY_NATIVE_ROOT").unwrap());
    let out = std::path::PathBuf::from(std::env::var("HUB_HISTORY_NATIVE_OUT").unwrap());
    assert!(root.join(".hub-isolated-runtime-v1").is_file());
    assert!(
        !out.join("prepare-start.json").exists(),
        "one preparation only"
    );
    let original = "work-qmx-qclI33T4evy-Xe9Dpb4Z";
    let old = ui(&root, &json!({"action":"status","id":original})).unwrap();
    assert_eq!(old["lifecycle"]["runsUsed"], 6);
    assert_eq!(old["lifecycle"]["providerBudget"]["canAdmitRun"], false);
    let old_deliveries = store::records(&root, original, "delivery", 64).unwrap();
    let selection = crate::model_runtime::ui(
        &root,
        &json!({"action":"save","settings":crate::model_runtime::Settings::default()}),
    )
    .unwrap();
    assert_eq!(selection["settings"]["model"], "");
    std::fs::write(out.join("prepare-start.json"),serde_json::to_vec_pretty(&json!({"models":0,"goal":"synthetic native history only","sourceAnchor":old["work"]["anchor"],"originalWork":original,"cliDefaultSelection":true,"noDispatchProof":"nativeRuntime/modelExecution absent; UI case read-only"})).unwrap()).unwrap();
    let value=ui(&root,&json!({"action":"create","goal":"合成历史分页验证 · 70条（不调用模型）","successCriteria":"只读检查已保存的合成记录；不运行模型、不修改来源、不产生业务动作","anchor":old["work"]["anchor"],"grant":{"libraryIds":[],"notes":[old["work"]["anchor"]],"readingItemKeys":[]}})).unwrap();
    let id = value["work"]["id"].as_str().unwrap();
    for n in 1..=70 {
        ui(&root,&json!({"action":"message","id":id,"text":format!("合成历史追问{n}，保留原要求"),"clientMessageId":format!("native-history-{n}")})).unwrap();
        publish_on(&root, id, n, &[], &format!("合成历史回答{n}（无模型）"));
    }
    let view = ui(&root, &json!({"action":"status","id":id})).unwrap();
    assert_eq!(view["lifecycle"]["runsUsed"], 70);
    assert_eq!(view["conversation"]["hasEarlier"], true);
    assert!(view["assistantOptions"]["model"].is_null());
    let c = store::read(&root).unwrap();
    assert_eq!(c.query_row("SELECT COUNT(*) FROM agent_records WHERE work_id=?1 AND kind IN ('nativeRuntime','modelExecution')",[id],|r|r.get::<_,i64>(0)).unwrap(),0);
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM agent_actions", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        store::records(&root, original, "delivery", 64).unwrap(),
        old_deliveries
    );
    assert_eq!(
        ui(&root, &json!({"action":"status","id":original})).unwrap()["lifecycle"]["runsUsed"],
        6
    );
    std::fs::write(out.join("initial-state.json"),serde_json::to_vec_pretty(&json!({"workId":id,"anchor":view["work"]["anchor"],"goal":view["work"]["goal"],"followups":70,"reports":70,"modelRequests":0,"actions":0,"originalWorkRunCount":6,"originalDeliveriesUnchanged":true,"cliDefaultSelection":true,"noDispatchProof":"nativeRuntime/modelExecution absent; UI case read-only","source":"formal production publication owner; synthetic QA messages/reports, not model/user-confirmation scores"})).unwrap()).unwrap();
}
fn last_message(f: &Fixture, id: &str) -> String {
    f.c().query_row("SELECT id FROM agent_records WHERE work_id=?1 AND kind='userMessage' ORDER BY rowid DESC LIMIT 1",[id],|r|r.get(0)).unwrap()
}
fn page_args(f: &Fixture, id: &str, before: &str) -> Value {
    let w = load(&f.c(), id).unwrap();
    json!({"action":"historyPage","id":id,"before":before,"expectedRevision":w.revision,"expectedAuthorizationVersion":w.authorization_version})
}

#[test]
fn seventy_followups_keep_one_work_budget_and_page_every_record_without_replaying_old_messages() {
    let (f, id) = setup();
    let first = message(&f, &id, 1);
    for n in 1..=70 {
        ui(&f.root, &message(&f, &id, n)).unwrap();
        publish(&f, &id, n, &[], &format!("确定性历史回答{n}"));
    }
    let before = ui(&f.root, &json!({"action":"status","id":id})).unwrap();
    assert_eq!(before["lifecycle"]["runsUsed"], 70);
    assert_eq!(before["work"]["revision"], 71);
    let mut conversation = before["conversation"].clone();
    let mut seen = std::collections::BTreeSet::new();
    let mut pages = 0;
    loop {
        for item in conversation["messages"].as_array().unwrap() {
            seen.insert(item["id"].as_str().unwrap().to_string());
        }
        pages += 1;
        if conversation["hasEarlier"] != true {
            break;
        }
        assert!(pages < 4);
        let args = page_args(&f, &id, conversation["nextCursor"].as_str().unwrap());
        let old = ui(&f.root, &args).unwrap();
        assert_eq!(old["workId"], id);
        conversation = old["conversation"].clone();
    }
    assert_eq!(seen.len(), 141);
    assert_eq!(pages, 3);
    let replay = ui(&f.root, &first).unwrap();
    assert_eq!(replay["work"]["revision"], 71);
    let mut different = first.clone();
    different["text"] = json!("不同内容不能占用旧消息身份");
    assert!(ui(&f.root, &different).is_err());
    assert_eq!(
        store::records(&f.root, &id, "executionBudgetPolicy", 1)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        replay["lifecycle"]["executionBudget"],
        before["lifecycle"]["executionBudget"]
    );
    assert_eq!(f.c().query_row("SELECT COUNT(*) FROM agent_records WHERE work_id=?1 AND kind IN ('nativeRuntime','modelExecution')",[&id],|r|r.get::<_,i64>(0)).unwrap(),0);
    assert_eq!(
        f.c()
            .query_row(
                "SELECT COUNT(*) FROM agent_actions WHERE work_id=?1",
                [&id],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    if let Ok(out) = std::env::var("HUB_HISTORY_CONTINUITY_OUT") {
        std::fs::write(out,serde_json::to_vec_pretty(&json!({"sameWork":id,"followups":70,"reports":70,"pages":3,"uniqueVisibleRecordsIncludingGoal":141,"oldMessageReplayUnchanged":true,"sameBudgetRoot":true,"models":0,"actions":0,"legacyFailuresRetained":true})).unwrap()).unwrap();
    }
}

#[test]
fn missing_foreign_or_old_version_cursor_cannot_read_another_work() {
    let (f, id) = setup();
    ui(&f.root, &message(&f, &id, 1)).unwrap();
    let cursor = last_message(&f, &id);
    let stale = page_args(&f, &id, &cursor);
    ui(&f.root, &message(&f, &id, 2)).unwrap();
    assert!(ui(&f.root, &stale).unwrap_err().contains("已更新"));
    let other = create(&f, false);
    ui(&f.root, &message(&f, &other, 1)).unwrap();
    for bad in [
        last_message(&f, &other),
        "missing-record".into(),
        "' OR 1=1 --".into(),
    ] {
        assert!(ui(&f.root, &page_args(&f, &id, &bad))
            .unwrap_err()
            .contains("不属于当前事项"));
    }
    let before = f
        .c()
        .query_row("SELECT COUNT(*) FROM agent_records", [], |r| {
            r.get::<_, i64>(0)
        })
        .unwrap();
    store::revoke(&f.root, &id).unwrap();
    let error = ui(&f.root, &page_args(&f, &id, &cursor)).unwrap_err();
    assert!(error.contains("授权已撤回"));
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM agent_records", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        before
    );
}

#[test]
fn old_pages_use_current_grants_and_retain_hidden_original_delivery() {
    let f = Fixture::new();
    f.note("notes", "current", "长期只读合成原文");
    f.note("notes", "other", "WITHDRAWN_HISTORY_B_SECRET");
    let created=ui(&f.root,&json!({"action":"create","goal":"合成历史出处核对","successCriteria":"只读","anchor":note("current"),"grant":{"libraryIds":[],"notes":[note("current"),note("other")],"readingItemKeys":[]}})).unwrap();
    let id = created["work"]["id"].as_str().unwrap();
    let w = load(&f.c(), id).unwrap();
    let excerpt = w
        .grant
        .reader(&f.root)
        .unwrap()
        .read(&note("other"), 0, 100, None)
        .unwrap();
    publish(&f, id, 1, &[excerpt], "WITHDRAWN_HISTORY_B_SECRET");
    ui(&f.root, &message(&f, id, 1)).unwrap();
    let cursor = last_message(&f, id);
    assert!(ui(&f.root, &page_args(&f, id, &cursor))
        .unwrap()
        .to_string()
        .contains("WITHDRAWN_HISTORY_B_SECRET"));
    let old = store::records(&f.root, id, "delivery", 64).unwrap();
    let revision = load(&f.c(), id).unwrap().revision;
    ui(&f.root,&json!({"action":"message","id":id,"text":"仅撤回另一份合成资料","clientMessageId":"withdraw-other","expectedRevision":revision,"removeNotes":[note("other")]})).unwrap();
    let hidden = ui(&f.root, &page_args(&f, id, &cursor)).unwrap();
    assert!(!hidden.to_string().contains("WITHDRAWN_HISTORY_B_SECRET"));
    assert!(hidden.to_string().contains("历史正文已隐藏"));
    assert_eq!(store::records(&f.root, id, "delivery", 64).unwrap(), old);
}

#[test]
fn oversized_delivery_keeps_recent_requests_and_can_be_read_in_verified_ranges() {
    let (f, id) = setup();
    ui(&f.root, &message(&f, &id, 1)).unwrap();
    let text = format!(
        "{}旧答复末尾检查码 R7319",
        "这是一份很长的已保存报告。".repeat(1100)
    );
    publish(&f, &id, 1, &[], &text);
    let work = load(&f.c(), &id).unwrap();
    let ctx = context(&f.root, &work).unwrap();
    assert!(ctx["messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|m| m["text"] == "固定追问1，保留原要求"));
    let compact = ctx["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["contentTruncated"] == true)
        .unwrap();
    let record = compact["recordId"].as_str().unwrap();
    let first = history(&f.root, &work, None, Some(record), 0, 6000).unwrap();
    assert_eq!(first["truncated"], true);
    let tail = history(
        &f.root,
        &work,
        None,
        Some(record),
        first["totalChars"].as_u64().unwrap() as usize - 100,
        100,
    )
    .unwrap();
    assert!(tail["content"].as_str().unwrap().contains("R7319"));
    assert!(history(&f.root, &work, None, Some("foreign-record"), 0, 100).is_err());
    ui(&f.root, &message(&f, &id, 2)).unwrap();
    assert!(history(&f.root, &work, None, Some(record), 0, 100).is_err());
}

#[test]
fn legacy_followups_keep_thirty_two_guard_and_requirements_reject_before_append() {
    let (f, id) = setup();
    for n in 1..=32 {
        ui(&f.root, &message(&f, &id, n)).unwrap();
    }
    let error = ui(&f.root, &message(&f, &id, 33)).unwrap_err();
    assert!(error.contains("32条"));
    assert!(error.contains("不能新建事项绕过"));
    let (f, id) = setup();
    publish(&f, &id, 1, &[], "原成果保留");
    for n in 1..=126 {
        ui(&f.root, &message(&f, &id, n)).unwrap();
    }
    let before = load(&f.c(), &id).unwrap();
    assert!(ui(&f.root, &message(&f, &id, 127))
        .unwrap_err()
        .contains("要求已达核对容量"));
    assert_eq!(load(&f.c(), &id).unwrap().revision, before.revision);
    assert_eq!(
        f.c()
            .query_row(
                "SELECT COUNT(*) FROM agent_records WHERE work_id=?1 AND kind='userMessage'",
                [&id],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        126
    );
    assert!(ui(&f.root, &json!({"action":"status","id":id})).is_ok());
}
