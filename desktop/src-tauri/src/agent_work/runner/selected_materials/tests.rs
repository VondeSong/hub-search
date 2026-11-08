use super::*;
use crate::agent_work::tests::claim;
use crate::source_evidence::tests::Fixture;

fn note(id: &str) -> EvidenceLocator {
    EvidenceLocator::Note {
        library_id: "notes".into(),
        document_id: id.into(),
        page_id: None,
    }
}
fn create(f: &Fixture, notes: Vec<EvidenceLocator>) -> String {
    let v = ui(&f.root, &json!({"action":"create","goal":"直接回答当前问题","successCriteria":"按相关性采用资料","anchor":null,
        "grant":Grant::default()})).unwrap();
    let id = v["work"]["id"].as_str().unwrap().to_string();
    if !notes.is_empty() {
        ui(&f.root, &json!({"action":"message","id":id,"text":"分析当前问题","clientMessageId":"initial-materials","expectedRevision":1,"addNotes":notes})).unwrap();
    }
    id
}
fn answer() -> Value {
    json!({"rationale":"阅读后判断材料与问题无关，直接回答","requests":[],"report":{"status":"completed","summary":"直接回答","findings":[],"nextSteps":[],"questions":[],"limitations":[],"waitCondition":"","prose":{"markdown":"这次无需采用附件。","citations":[]}}})
}
#[test]
fn long_local_text_is_pre_read_and_tail_remains_addressable_without_inline_message() {
    let f = Fixture::new();
    let body = format!("{}END_OF_LOCAL_FILE", "长文".repeat(20_000));
    let staged = ui(
        &f.root,
        &json!({"action":"stageTextFile","title":"长文.md","text":body}),
    )
    .unwrap();
    let locator: EvidenceLocator = serde_json::from_value(staged["locator"].clone()).unwrap();
    let id = create(&f, vec![locator.clone()]);
    let (work, run) = claim(&f, &id);
    let mut c = context(&f, &work);
    prepare(&f.root, &work, &run, &mut c).unwrap();
    assert_eq!(c.excerpts[0].total_chars, 40_017);
    assert!(c.excerpts[0].truncated);
    assert_eq!(c.excerpts[0].start_char, 0);
    assert!(store::records(&f.root, &id, "userMessage", 10)
        .unwrap()
        .iter()
        .all(|m| !m.to_string().contains("END_OF_LOCAL_FILE")));
    let tail = work
        .grant
        .reader(&f.root)
        .unwrap()
        .read(&locator, 40_000, 100, None)
        .unwrap();
    assert_eq!(tail.content, "END_OF_LOCAL_FILE");
    assert_eq!(
        ui(
            &f.root,
            &json!({"action":"create","goal":"x".repeat(70_000)})
        )
        .unwrap_err(),
        "调查请求过大"
    );
    let anchored=ui(&f.root,&json!({"action":"create","goal":"读取附件","successCriteria":"按相关性使用","anchor":locator,"grant":{"libraryIds":[],"notes":[locator],"readingItemKeys":[]}})).unwrap();
    assert_eq!(anchored["work"]["grant"]["notes"][0], json!(locator));
}
fn context(f: &Fixture, w: &Work) -> Context {
    Context {
        reader: w.grant.reader(&f.root).unwrap(),
        excerpts: vec![],
        entities: HashSet::new(),
        observations: vec![],
        usage: Usage::default(),
        control: Control::default(),
        budget: Budget::mode("quick").unwrap(),
        candidates: vec![],
        search_read_available: false,
        skills: None,
        skill_request: w.goal.clone(),
    }
}

#[test]
fn selected_body_reaches_model_but_citation_is_optional() {
    let f = Fixture::new();
    f.note("notes", "chosen", "SELECTED_BODY_SENTINEL");
    f.note("notes", "secret", "UNAUTHORIZED_BODY_SENTINEL");
    let id = create(&f, vec![note("chosen")]);
    let (w, r) = claim(&f, &id);
    investigate(&f.root, &w, &r, &Control::default(), |prompt, _| {
        assert!(prompt.contains("SELECTED_BODY_SENTINEL"));
        assert!(prompt.contains("hostSelectedRead"));
        assert!(!prompt.contains("UNAUTHORIZED_BODY_SENTINEL"));
        Ok(answer())
    })
    .unwrap();
    let saved = store::load(&f.c(), &id).unwrap();
    assert!(saved.report.is_some());
    let evidence = store::records(&f.root, &id, "evidence", 32).unwrap();
    assert_eq!(evidence.len(), 1);
    assert_eq!(evidence[0]["excerpt"]["content"], "SELECTED_BODY_SENTINEL");
    let activity = crate::agent_work::activity::read_on(&f.root, &f.c(), &saved).unwrap();
    assert!(activity.to_string().contains("已读取资料"));
}

#[test]
fn selected_material_completion_repair_keeps_citations_and_proof_validation() {
    let f = Fixture::new();
    f.note(
        "notes",
        "chosen",
        "收藏用于组件选型。收藏不表示已完成采用评估。",
    );
    let id = create(&f, vec![note("chosen")]);
    let (w, run) = claim(&f, &id);
    let control = Control::bounded(Duration::from_secs(30));
    let session = assistant::Session {
        root: &f.root,
        work: &w,
        run: &run,
        control: &control,
        operation: None,
        selection: json!({"provider":"deepseek"}),
        app: None,
    };
    let mut calls = 0;
    investigate_assistant(&f.root, &w, &run, &control, assistant::budget("quick").unwrap(), &session, |prompt, schema| {
        assert!(prompt.contains(store::goal::completion::GUIDE));
        let material: Value = serde_json::from_str(prompt.split("宿主材料(JSON):\n").last().unwrap()).unwrap();
        let goal = &material["conversation"]["goalState"];
        let example: Value = serde_json::from_str(prompt.split("完整输出示例(JSON):\n").nth(1).unwrap().lines().next().unwrap()).unwrap();
        crate::model_runtime::validate_agent_tool(&example, schema).unwrap();
        assert_eq!(example["report"]["completion"]["goalBinding"], goal["goalBinding"]);
        assert_eq!(example["report"]["completion"]["items"][0]["requirementId"], goal["requirements"][0]["requirementId"]);
        let items = goal["requirements"].as_array().unwrap().iter().map(|requirement| json!({
            "requirementId":requirement["requirementId"],"criterion":requirement["text"],
            "requiredResult":"response","status":"satisfied","explanation":"只读概括所选原文并标注引用。",
            "refs":[],"supersededBy":null,
        })).collect::<Vec<_>>();
        let mut response = json!({"rationale":"仅概括所选原文。","requests":[],"report":{
            "status":"completed","completion":{"goalBinding":goal["goalBinding"],"items":items},
            "markdown":"收藏用于组件选型，但不表示已完成采用评估。[1]",
            "citations":[{"quoteId":material["quoteCatalog"][0]["quoteId"]}],
            "questions":[],"limitations":[],"waitCondition":"",
        }});
        calls += 1;
        if calls == 1 {
            response["report"]["completion"]["note"] = Value::Null;
            let error = crate::model_runtime::validate_agent_tool(&response, schema).unwrap_err();
            assert!(error.contains("$.report.completion: additionalProperties"), "{error}");
            assert!(error.contains("allowed fields: [\"goalBinding\",\"items\"]"), "{error}");
            return Err(error);
        }
        assert_eq!(calls, 2, "repair must keep the existing bounded budget");
        let repair = material["observations"].as_array().unwrap().iter().find(|o| o["completionRepair"].is_object()).unwrap();
        assert_eq!(repair["completionRepair"]["contract"], store::goal::completion::GUIDE);
        assert!(repair["completionRepair"]["instruction"].as_str().unwrap().contains("不要重新创建已存在的草稿"));
        assert!(material["observations"].as_array().unwrap().iter().any(|o| o["outputRejected"].as_str().is_some_and(|e| e.contains("additionalProperties") && e.contains("allowed fields: [\"goalBinding\",\"items\"]"))));
        crate::model_runtime::validate_agent_tool(&response, schema).unwrap();
        Ok(response)
    }).unwrap();
    assert_eq!(calls, 2);
    let saved = store::load(&f.c(), &id).unwrap();
    assert_eq!(saved.state, "completed");
    assert!(!saved.report.unwrap().prose.unwrap().citations.is_empty());
    assert_eq!(
        f.c()
            .query_row("SELECT count(*) FROM agent_actions", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    let error =
        store::goal::completion::resolve_proofs(&json!([]), &["e1:q1".into()], "response", false)
            .unwrap_err();
    assert!(
        error.contains("完成证据不存在"),
        "source quotes are never completion proofs"
    );
}

#[test]
fn followup_addition_is_read_without_title_in_question() {
    let f = Fixture::new();
    f.note("notes", "chosen", "FOLLOWUP_ATTACHMENT_SENTINEL");
    let id = create(&f, vec![]);
    let (w, r) = claim(&f, &id);
    investigate(&f.root, &w, &r, &Control::default(), |_, _| Ok(answer())).unwrap();
    ui(&f.root,&json!({"action":"message","id":id,"text":"另一个问题","clientMessageId":"addition","expectedRevision":1,"addNotes":[note("chosen")]})).unwrap();
    let (w, r) = claim(&f, &id);
    investigate(&f.root, &w, &r, &Control::default(), |prompt, _| {
        assert!(prompt.contains("FOLLOWUP_ATTACHMENT_SENTINEL"));
        Ok(answer())
    })
    .unwrap();
    ui(&f.root,&json!({"action":"message","id":id,"text":"继续","clientMessageId":"ordinary","expectedRevision":2})).unwrap();
    let (w, r) = claim(&f, &id);
    let mut ctx = context(&f, &w);
    prepare(&f.root, &w, &r, &mut ctx).unwrap();
    assert!(
        ctx.excerpts.is_empty(),
        "old authorization is not a fresh attachment"
    );
}

#[test]
fn partial_reads_and_budget_skips_are_explicit() {
    let f = Fixture::new();
    f.note("notes", "long", &"长".repeat(7000));
    f.note("notes", "extra", "第二份资料");
    let id = create(&f, vec![note("long"), note("extra")]);
    let (w, r) = claim(&f, &id);
    let mut ctx = context(&f, &w);
    ctx.budget.body_chars = 6000;
    prepare(&f.root, &w, &r, &mut ctx).unwrap();
    assert_eq!(ctx.excerpts.len(), 1);
    assert!(ctx.excerpts[0].truncated);
    assert_eq!(ctx.usage.body_chars, 6000);
    assert!(ctx.observations[1]["readError"]
        .as_str()
        .unwrap()
        .contains("预算"));
    let activity = crate::agent_work::activity::read_on(&f.root, &f.c(), &w)
        .unwrap()
        .to_string();
    assert!(activity.contains("已读取部分资料"));
    assert!(activity.contains("添加的资料未读入"));
}

#[test]
fn missing_material_is_not_reported_as_read() {
    let f = Fixture::new();
    f.note("notes", "chosen", "原文");
    let id = create(&f, vec![note("chosen")]);
    let (w, r) = claim(&f, &id);
    f.c()
        .execute("DELETE FROM documents WHERE id='chosen'", [])
        .unwrap();
    let mut ctx = context(&f, &w);
    prepare(&f.root, &w, &r, &mut ctx).unwrap();
    assert!(ctx.excerpts.is_empty());
    assert_eq!(ctx.usage.entities_read, 0);
    assert!(ctx.observations[0]["readError"].is_string());
    assert_eq!(
        store::records(&f.root, &id, "selectedMaterialReadError", 32)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn previously_ignored_attachment_is_recovered_on_next_question() {
    let f = Fixture::new();
    f.note("notes", "chosen", "LEGACY_UNREAD_ATTACHMENT");
    let id = create(&f, vec![note("chosen")]);
    let (w, r) = claim(&f, &id);
    let report: Report = serde_json::from_value(answer()["report"].clone()).unwrap();
    store::publish(
        &f.root,
        &w,
        &r,
        &report,
        &[],
        &[],
        &json!([]),
        &json!({}),
        &Control::default(),
    )
    .unwrap();
    ui(&f.root, &json!({"action":"message","id":id,"text":"继续分析","clientMessageId":"recover","expectedRevision":w.revision})).unwrap();
    let (w, r) = claim(&f, &id);
    investigate(&f.root, &w, &r, &Control::default(), |prompt, _| {
        assert!(prompt.contains("LEGACY_UNREAD_ATTACHMENT"));
        Ok(answer())
    })
    .unwrap();
}
