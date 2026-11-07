use super::*;
use crate::agent_work::{
    assistant,
    tests::{claim, create},
};
use crate::source_evidence::tests::Fixture;

fn setup() -> (Fixture, Work, String) {
    let f = Fixture::new();
    f.note("notes", "current", "来源材料");
    let id = create(&f, false);
    super::super::super::conversation::message(&f.root,&id,&json!({"text":"分析 2024–2026 年材料，保留图表，保存方式待定","clientMessageId":"initial-goal"})).unwrap();
    let (w, r) = claim(&f, &id);
    record(&f.root, &r, "nativeRuntime", &json!({"protocol":1})).unwrap();
    (f, w, r)
}
fn call(f: &Fixture, w: &Work, r: &str, req: Value) -> Result<Value, String> {
    assistant::Session {
        root: &f.root,
        work: w,
        run: r,
        control: &Control::default(),
        operation: None,
        selection: Value::Null,
        app: None,
    }
    .dispatch(serde_json::from_value(json!({"operation":"goalRevision","request":req})).unwrap())
}
fn state(f: &Fixture, w: &Work, r: &str) -> Value {
    call(f, w, r, json!({"action":"read","revision":null})).unwrap()
}
fn item(id: &str, kind: &str, text: &str, source: &Value) -> Value {
    json!({"itemId":id,"kind":kind,"text":text,"sourceRefs":[source]})
}
fn content(s: &Value, ambiguous: bool) -> Value {
    let source = &s["sourceCommandId"];
    let mut items = vec![
        item("range", "constraint", "统计 2024–2026", source),
        item("chart", "acceptanceCriterion", "保留图表", source),
    ];
    if ambiguous {
        items.push(item("save", "ambiguity", "保存方式需要澄清", source));
    }
    json!({"effectiveGoal":{"text":"分析 2024–2026 并给出图表","sourceRefs":[source]},"items":items})
}
fn proposal(s: &Value, op: &str, content: Value, retirements: Value) -> Value {
    json!({"action":"revise","operationId":op,"expectedGoalBinding":s["goalBinding"],"expectedGoalRevision":s["revision"],
        "sourceCommandId":s["sourceCommandId"],"content":content,"retirements":retirements,"rationale":"按用户原始要求解释目标"})
}
fn steer(f: &Fixture, w: &Work, r: &str, text: &str, token: &str) {
    let cmd = json!({"text":text,"clientMessageId":token,"runId":r});
    super::super::super::conversation::steer(&f.root, &w.id, &cmd).unwrap();
    record(&f.root, r, "steeringAccepted", &cmd).unwrap();
}
fn report(f: &Fixture, w: &Work, r: &str) -> runner::Report {
    let ctx = completion::read_context(&f.root, w, r).unwrap();
    let items:Vec<_>=ctx["requirements"].as_array().unwrap().iter().map(|i|json!({"requirementId":i["requirementId"],"criterion":i["text"],"requiredResult":"response",
        "status":"satisfied","explanation":"测试评审已逐项核对","refs":[],"supersededBy":null})).collect();
    serde_json::from_value(json!({"status":"completed","summary":"逐项说明结果","findings":[],"nextSteps":[],"questions":[],"limitations":[],"waitCondition":"",
        "completion":{"goalBinding":ctx["goalBinding"],"items":items}})).unwrap()
}
fn publish_answer(f: &Fixture, w: &Work, r: &str, answer: &runner::Report) -> Result<(), String> {
    publish(
        &f.root,
        w,
        r,
        answer,
        &[],
        &[],
        &crate::agent_work::actions::receipts(&f.root, &w.id)?,
        &Value::Null,
        &Control::default(),
    )
}

#[test]
fn revision_protocol_replays_rejects_stale_writes_and_preserves_noop_and_cross_run_state() {
    let (f, w, r) = setup();
    let base = state(&f, &w, &r);
    assert_eq!(base["revision"], 0);
    assert_eq!(base["goalBinding"]["schemaVersion"], 1);
    let body = content(&base, false);
    let req = proposal(&base, "initial", body.clone(), json!([]));
    let first = call(&f, &w, &r, req.clone()).unwrap();
    let current = first["state"].clone();
    assert_eq!(current["revision"], 1);
    assert_eq!(current["goalBinding"]["schemaVersion"], 2);
    assert_eq!(current["scopeRevision"], w.authorization_version);
    assert_eq!(current["grantsAuthority"], false);
    assert_eq!(
        call(&f, &w, &r, req.clone()).unwrap()["receipt"],
        first["receipt"]
    );
    let mut conflict = req.clone();
    conflict["rationale"] = json!("不同内容");
    assert!(call(&f, &w, &r, conflict).unwrap_err().contains("冲突"));
    let mut stale = proposal(&current, "stale", body.clone(), json!([]));
    stale["expectedGoalRevision"] = json!(0);
    assert!(call(&f, &w, &r, stale).unwrap_err().contains("版本"));
    let mut stale = req;
    stale["operationId"] = json!("stale-binding");
    assert!(call(&f, &w, &r, stale).unwrap_err().contains("更新"));
    let noop = call(&f, &w, &r, proposal(&current, "noop", body, json!([]))).unwrap();
    assert_eq!(noop["receipt"]["changed"], false);
    assert_eq!(noop["state"]["revision"], 1);
    assert_eq!(
        records(&f.root, &w.id, "goalRevision", 10).unwrap().len(),
        1
    );
    let answer = report(&f, &w, &r);
    accept_report(&f.root, &w, &r, &answer, &current["goalBinding"]).unwrap();
    publish_answer(&f, &w, &r, &answer).unwrap();
    let (next, nr) = claim(&f, &w.id);
    assert_eq!(state(&f, &next, &nr), current);
    assert!(call(&f, &w, &r, json!({"action":"read","revision":null})).is_err());
    assert_eq!(load(&f.c(), &w.id).unwrap().goal, w.goal);
    assert_eq!(
        load(&f.c(), &w.id).unwrap().authorization_version,
        w.authorization_version
    );
}

#[test]
fn user_revision_replaces_only_conflicts_and_resolves_ambiguity_with_durable_provenance() {
    let (f, w, r) = setup();
    let base = state(&f, &w, &r);
    let original = content(&base, true);
    call(
        &f,
        &w,
        &r,
        proposal(&base, "initial", original.clone(), json!([])),
    )
    .unwrap();
    let answer = report(&f, &w, &r);
    assert_eq!(
        completion::evaluate(&f.root, &f.c(), &w, &r, &answer).unwrap()["workFulfillment"],
        "blocked"
    );
    let initial = view(&f.root, &w.id).unwrap();
    steer(
        &f,
        &w,
        &r,
        "只统计 2025，保存前让我看，先完成预览",
        "narrow",
    );
    let stale = view(&f.root, &w.id).unwrap();
    assert_eq!(stale["goalRevision"]["state"], "needsRevision");
    let current = state(&f, &w, &r);
    let cmd = &current["sourceCommandId"];
    let replacement = json!({"effectiveGoal":{"text":"仅统计 2025，并先提供图表预览","sourceRefs":[cmd]},
        "items":[item("range-2025","constraint","仅统计 2025",cmd),original["items"][1],item("preview","acceptanceCriterion","保存前提供预览，不自动保存",cmd)]});
    let retired = json!([{"itemId":"range","sourceCommandId":cmd,"reason":"用户缩小日期范围","replacementIds":["range-2025"]},
        {"itemId":"save","sourceCommandId":cmd,"reason":"用户明确先预览，保存需后续决定","replacementIds":["preview"]}]);
    let next = call(
        &f,
        &w,
        &r,
        proposal(&current, "narrow", replacement.clone(), retired),
    )
    .unwrap()["state"]
        .clone();
    assert_eq!(next["supersedes"], 1);
    assert_eq!(next["revision"], 2);
    assert_eq!(next["state"], "current");
    assert_eq!(next["unresolvedAmbiguities"], json!([]));
    assert_eq!(next["acceptanceCriteria"][0], original["items"][1]);
    let historical = call(&f, &w, &r, json!({"action":"read","revision":1})).unwrap();
    assert_eq!(historical["state"], "historical");
    assert_eq!(historical["constraints"][0]["text"], "统计 2024–2026");
    assert_eq!(
        completion::sources_on(&f.c(), &w)
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        4
    );
    let revised = view(&f.root, &w.id).unwrap();
    let reopened = load(&f.c(), &w.id).unwrap();
    assert_eq!(state(&f, &reopened, &r), next);
    let mut reuse = replacement;
    reuse["items"]
        .as_array_mut()
        .unwrap()
        .push(original["items"][0].clone());
    assert!(call(&f, &w, &r, proposal(&next, "reuse", reuse, json!([])))
        .unwrap_err()
        .contains("复用"));
    if let Ok(path) = std::env::var("HUB_GOAL_REVISION_VIEW") {
        std::fs::write(
            path,
            serde_json::to_vec_pretty(&json!({"initial":initial,"stale":stale,"revised":revised}))
                .unwrap(),
        )
        .unwrap();
    }
}

#[test]
fn revision_rejects_unattributed_deletion_rewrite_fake_sources_and_authority_fields_atomically() {
    let (f, w, r) = setup();
    let base = state(&f, &w, &r);
    let body = content(&base, true);
    let current = call(
        &f,
        &w,
        &r,
        proposal(&base, "first", body.clone(), json!([])),
    )
    .unwrap()["state"]
        .clone();
    let mut omit = body.clone();
    omit["items"].as_array_mut().unwrap().remove(0);
    assert!(call(
        &f,
        &w,
        &r,
        proposal(&current, "omit", omit.clone(), json!([]))
    )
    .unwrap_err()
    .contains("省略"));
    let retirement = json!([{"itemId":"range","sourceCommandId":current["sourceCommandId"],"reason":"想删除","replacementIds":[]}]);
    assert!(call(
        &f,
        &w,
        &r,
        proposal(&current, "same-command", omit, retirement)
    )
    .unwrap_err()
    .contains("更新的用户命令"));
    let mut rewrite = body.clone();
    rewrite["items"][0]["text"] = json!("统计所有年份");
    assert!(call(
        &f,
        &w,
        &r,
        proposal(&current, "rewrite", rewrite, json!([]))
    )
    .unwrap_err()
    .contains("原地改写"));
    let mut fake = body.clone();
    fake["effectiveGoal"]["sourceRefs"] = json!(["tool-output"]);
    assert!(
        call(&f, &w, &r, proposal(&current, "fake", fake, json!([])))
            .unwrap_err()
            .contains("来源")
    );
    for key in [
        "grant",
        "authorizationVersion",
        "scopeRevision",
        "userConfirmed",
    ] {
        let mut req = proposal(&current, key, body.clone(), json!([]));
        req[key] = json!(true);
        assert!(call(&f, &w, &r, req).is_err());
    }
    let mut wrong = proposal(&current, "wrong-source", body.clone(), json!([]));
    wrong["sourceCommandId"] = json!(format!("{}-goal", w.id));
    assert!(call(&f, &w, &r, wrong)
        .unwrap_err()
        .contains("当前用户命令"));
    let mut huge = body;
    huge["effectiveGoal"]["text"] = json!("x".repeat(33000));
    assert!(
        call(&f, &w, &r, proposal(&current, "huge", huge, json!([])))
            .unwrap_err()
            .contains("容量")
    );
    assert_eq!(state(&f, &w, &r), current);
    assert_eq!(
        records(&f.root, &w.id, "goalRevisionOperation", 20)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn completion_cannot_bypass_active_interpretation_or_outdated_user_command() {
    let (f, w, r) = setup();
    let base = state(&f, &w, &r);
    let current = call(
        &f,
        &w,
        &r,
        proposal(&base, "first", content(&base, false), json!([])),
    )
    .unwrap()["state"]
        .clone();
    let answer = report(&f, &w, &r);
    assert_eq!(
        completion::evaluate(&f.root, &f.c(), &w, &r, &answer).unwrap()["workFulfillment"],
        "fulfilled"
    );
    let mut raw = serde_json::to_value(&answer).unwrap();
    raw["completion"]["items"]
        .as_array_mut()
        .unwrap()
        .retain(|i| !i["requirementId"].as_str().unwrap().contains(":goal:"));
    let missing: runner::Report = serde_json::from_value(raw).unwrap();
    assert_eq!(
        completion::evaluate(&f.root, &f.c(), &w, &r, &missing).unwrap()["workFulfillment"],
        "partial"
    );
    let mut raw = serde_json::to_value(&answer).unwrap();
    let index = raw["completion"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .position(|i| i["requirementId"].as_str().unwrap().ends_with(":range"))
        .unwrap();
    raw["completion"]["items"][index]["status"] = json!("notApplicable");
    raw["completion"]["items"][index]["supersededBy"] = current["sourceCommandId"].clone();
    let bypass: runner::Report = serde_json::from_value(raw).unwrap();
    assert!(completion::evaluate(&f.root, &f.c(), &w, &r, &bypass)
        .unwrap_err()
        .contains("有效解释"));
    steer(&f, &w, &r, "增加文字总结", "new-command");
    let fresh_report = report(&f, &w, &r);
    assert_eq!(
        completion::evaluate(&f.root, &f.c(), &w, &r, &fresh_report).unwrap()["workFulfillment"],
        "partial",
        "fresh binding alone cannot approve an outdated interpretation"
    );
}

#[test]
fn interpretation_changes_invalidate_tasks_and_previously_accepted_completion() {
    let (f, w, r) = setup();
    let base = state(&f, &w, &r);
    let body = content(&base, false);
    let current = call(
        &f,
        &w,
        &r,
        proposal(&base, "first", body.clone(), json!([])),
    )
    .unwrap()["state"]
        .clone();
    let task_store = &crate::agent_work::store::tasks::execute;
    let tree = task_store(
        &f.root,
        &w,
        &r,
        &json!({"action":"read"}),
        &Control::default(),
    )
    .unwrap();
    task_store(&f.root,&w,&r,&json!({"action":"patch","operationId":"done-task","expectedGoalBinding":tree["goalBinding"],"expectedTaskRevision":tree["revision"],"sourceCommandId":tree["sourceCommandId"],"remove":[],
        "upsert":[{"taskId":"review","parentId":null,"requirementRefs":[format!("{}:goal:range",w.id)],"criterion":"核对范围","dependencies":[],"requiredResult":"response","status":"done","proofIds":[],"review":"已核对","blocker":null}]}),&Control::default()).unwrap();
    let answer = report(&f, &w, &r);
    accept_report(&f.root, &w, &r, &answer, &current["goalBinding"]).unwrap();
    let mut refined = body;
    refined["effectiveGoal"]["text"] = json!("根据用户要求分析范围并展示图表");
    call(&f, &w, &r, proposal(&current, "refine", refined, json!([]))).unwrap();
    let actual = view(&f.root, &w.id).unwrap();
    assert_eq!(actual["taskTree"]["tasks"][0]["status"], "pending");
    assert!(!actual["taskTree"]["tasks"][0]["completionEvidence"].is_null());
    assert!(publish_answer(&f, &w, &r, &answer).is_err());
    assert!(records(&f.root, &w.id, "delivery", 1).unwrap().is_empty());
}
