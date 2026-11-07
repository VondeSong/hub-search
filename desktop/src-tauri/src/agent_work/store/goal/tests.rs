use super::*;
use crate::agent_work::tests::{claim, create};
use crate::source_evidence::tests::Fixture;

fn setup() -> (Fixture, Work, String) {
    let f = Fixture::new();
    f.note("notes", "current", "检查配合条件");
    let id = create(&f, false);
    let (work, run) = claim(&f, &id);
    record(&f.root, &run, "nativeRuntime", &json!({"protocol":1})).unwrap();
    (f, work, run)
}

fn answer(summary: &str) -> runner::Report {
    serde_json::from_value(json!({"status":"completed","summary":summary,
        "findings":[],"nextSteps":[],"questions":[],"limitations":[],"waitCondition":""}))
    .unwrap()
}

fn reviewed(work: &Work, context: &Value, state: &str) -> runner::Report {
    let items: Vec<_> = context["requirements"].as_array().unwrap().iter().map(|r|json!({
        "requirementId":r["requirementId"],"criterion":r["text"],"requiredResult":"response",
        "status":state,"explanation":"已逐项核对正文与用户要求","refs":[],"supersededBy":null
    })).collect();
    let value = json!({"status":"completed","summary":format!("针对 {} 的回答",work.goal),
        "findings":[],"nextSteps":[],"questions":[],"limitations":[],"waitCondition":"",
        "completion":{"goalBinding":context["goalBinding"],"items":items}});
    serde_json::from_value(value).unwrap()
}

#[test]
fn completion_distinguishes_run_settlement_and_goal_fulfillment_and_reopens() {
    let (f, work, run) = setup();
    let report = answer("单轮结束但没有逐项核对");
    accept_report(
        &f.root,
        &work,
        &run,
        &report,
        &for_run(&f.root, &work, &run).unwrap(),
    )
    .unwrap();
    publish_report(&f, &work, &run, &report).unwrap();
    let partial = view(&f.root, &work.id).unwrap();
    assert_eq!(partial["work"]["state"], "completed");
    assert_eq!(partial["goalAssessment"]["workFulfillment"], "partial");
    let (next, next_run) = claim(&f, &work.id);
    record(&f.root, &next_run, "nativeRuntime", &json!({"protocol":1})).unwrap();
    let context = completion::read_context(&f.root, &next, &next_run).unwrap();
    let report = reviewed(&next, &context, "satisfied");
    accept_report(&f.root, &next, &next_run, &report, &context["goalBinding"]).unwrap();
    publish_report(&f, &next, &next_run, &report).unwrap();
    let fulfilled = view(&f.root, &work.id).unwrap();
    assert_eq!(fulfilled["goalAssessment"]["workFulfillment"], "fulfilled");
    assert_eq!(fulfilled["goalAssessment"]["coverageComplete"], true);
    assert_eq!(
        fulfilled["goalAssessment"]["requirements"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        fulfilled["goalAssessment"]["proofVersions"],
        json!([]),
        "ordinary answers need no artificial tool steps"
    );
    conversation::message(
        &f.root,
        &work.id,
        &json!({"text":"补充适用范围","clientMessageId":"f-follow"}),
    )
    .unwrap();
    let changed = view(&f.root, &work.id).unwrap();
    assert_eq!(changed["goalAssessment"]["workFulfillment"], "partial");
    assert_eq!(
        changed["goalAssessment"]["requirements"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    assert_eq!(
        records(&f.root, &work.id, "delivery", 1).unwrap()[0]["deliveryAssessment"]
            ["workFulfillment"],
        "fulfilled",
        "historical facts remain immutable"
    );
    if let Ok(path) = std::env::var("HUB_COMPLETION_VIEW") {
        std::fs::write(
            path,
            serde_json::to_vec_pretty(
                &json!({"partial":partial,"fulfilled":fulfilled,"changed":changed}),
            )
            .unwrap(),
        )
        .unwrap();
    }
}

#[test]
fn completion_rejects_fabricated_proofs_and_stale_goals_and_keeps_missing_requirements() {
    let (f, work, run) = setup();
    let context = completion::read_context(&f.root, &work, &run).unwrap();
    let report = reviewed(&work, &context, "satisfied");
    let mut value = serde_json::to_value(&report).unwrap();
    value["completion"]["items"].as_array_mut().unwrap().pop();
    let missing: runner::Report = serde_json::from_value(value.clone()).unwrap();
    let assessed = completion::evaluate(&f.root, &f.c(), &work, &run, &missing).unwrap();
    assert_eq!(assessed["workFulfillment"], "partial");
    assert_eq!(assessed["coverageComplete"], false);
    value["completion"]["items"][0]["requiredResult"] = json!("action");
    let no_receipt = serde_json::from_value(value.clone()).unwrap();
    assert!(
        completion::evaluate(&f.root, &f.c(), &work, &run, &no_receipt)
            .unwrap_err()
            .contains("缺少真实")
    );
    value["completion"]["items"][0]["refs"] = json!(["action:invented"]);
    assert!(completion::evaluate(
        &f.root,
        &f.c(),
        &work,
        &run,
        &serde_json::from_value(value).unwrap()
    )
    .unwrap_err()
    .contains("证据不存在"));
    let command = steer(&f, &work, &run, "fresh");
    record(&f.root, &run, "steeringAccepted", &command).unwrap();
    assert!(completion::evaluate(&f.root, &f.c(), &work, &run, &report)
        .unwrap_err()
        .contains("用户要求已更新"));
}

#[test]
fn completion_blocks_unmet_goals_and_requires_user_provenance_for_supersession() {
    let (f, work, run) = setup();
    let context = completion::read_context(&f.root, &work, &run).unwrap();
    let blocked = reviewed(&work, &context, "blocked");
    let result = completion::evaluate(&f.root, &f.c(), &work, &run, &blocked).unwrap();
    assert_eq!(result["workFulfillment"], "blocked");
    let mut value = serde_json::to_value(reviewed(&work, &context, "satisfied")).unwrap();
    value["completion"]["items"][0]["status"] = json!("notApplicable");
    assert!(completion::evaluate(
        &f.root,
        &f.c(),
        &work,
        &run,
        &serde_json::from_value(value.clone()).unwrap()
    )
    .unwrap_err()
    .contains("较新的用户"));
    let command = steer(&f, &work, &run, "replace");
    record(&f.root, &run, "steeringAccepted", &command).unwrap();
    let next = completion::read_context(&f.root, &work, &run).unwrap();
    value = serde_json::to_value(reviewed(&work, &next, "satisfied")).unwrap();
    value["completion"]["items"][0]["status"] = json!("notApplicable");
    value["completion"]["items"][0]["supersededBy"] =
        next["requirements"][2]["requirementId"].clone();
    value["completion"]["items"][0]["explanation"] =
        json!("用户明确改为只预览，原执行部分本轮不适用");
    let report = serde_json::from_value(value.clone()).unwrap();
    let result = completion::evaluate(&f.root, &f.c(), &work, &run, &report).unwrap();
    assert_eq!(result["workFulfillment"], "fulfilled");
    assert_eq!(
        result["completionEvidence"][0]["supersededBy"],
        next["requirements"][2]["requirementId"]
    );
    value["status"] = json!("insufficientEvidence");
    assert_eq!(
        completion::evaluate(
            &f.root,
            &f.c(),
            &work,
            &run,
            &serde_json::from_value(value).unwrap()
        )
        .unwrap()["workFulfillment"],
        "partial"
    );
}

#[test]
fn completion_schema_and_assistant_normalization_preserve_the_same_review() {
    let (f, work, run) = setup();
    let context = completion::read_context(&f.root, &work, &run).unwrap();
    let report = serde_json::to_value(reviewed(&work, &context, "satisfied")).unwrap();
    let value = json!({"rationale":"","requests":[],"report":{"status":"completed","markdown":"已核对当前要求","citations":[],"questions":[],"limitations":[],"waitCondition":"","completion":report["completion"]}});
    let schema = crate::agent_work::assistant::schema(runner::schema());
    crate::model_runtime::validate_agent_tool(&value, &schema).unwrap();
    let normalized = crate::agent_work::assistant::normalize(value, &json!([])).unwrap();
    let report: runner::Report = serde_json::from_value(normalized["report"].clone()).unwrap();
    assert_eq!(
        completion::evaluate(&f.root, &f.c(), &work, &run, &report).unwrap()["workFulfillment"],
        "fulfilled"
    );
}

#[test]
fn completion_split_criteria_reuse_exact_ids_and_reject_invented_suffixes() {
    let (f, work, run) = setup();
    let context = completion::read_context(&f.root, &work, &run).unwrap();
    let mut value = serde_json::to_value(reviewed(&work, &context, "satisfied")).unwrap();
    let mut split = value["completion"]["items"][0].clone();
    split["criterion"] = json!("同一要求的另一项条件");
    value["completion"]["items"]
        .as_array_mut()
        .unwrap()
        .push(split);
    let report = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(
        completion::evaluate(&f.root, &f.c(), &work, &run, &report).unwrap()["workFulfillment"],
        "fulfilled"
    );
    value["completion"]["items"][0]["requirementId"] = json!(format!(
        "{}-1",
        context["requirements"][0]["requirementId"]
            .as_str()
            .unwrap()
    ));
    let report = serde_json::from_value(value).unwrap();
    assert_eq!(
        completion::evaluate(&f.root, &f.c(), &work, &run, &report).unwrap_err(),
        "核对引用了不存在的用户要求"
    );
    let schema = completion::schema();
    assert!(
        schema["anyOf"][0]["properties"]["items"]["items"]["properties"]["requirementId"]
            ["description"]
            .as_str()
            .unwrap()
            .contains("禁止添加序号或后缀")
    );
}

fn steer(f: &Fixture, work: &Work, run: &str, token: &str) -> Value {
    let input = json!({"text":"只要预览，先核对当前要求","clientMessageId":token,"runId":run});
    conversation::steer(&f.root, &work.id, &input).unwrap();
    input
}

fn publish_report(
    f: &Fixture,
    work: &Work,
    run: &str,
    report: &runner::Report,
) -> Result<(), String> {
    publish(
        &f.root,
        work,
        run,
        report,
        &[],
        &[],
        &crate::agent_work::actions::receipts(&f.root, &work.id).unwrap(),
        &Value::Null,
        &Control::default(),
    )
}

#[test]
fn goal_binding_is_durable_idempotent_and_scoped_to_its_work() {
    let (f, work, run) = setup();
    let initial = for_run(&f.root, &work, &run).unwrap();
    let command = steer(&f, &work, &run, "one");
    assert!(for_run(&f.root, &work, &run)
        .unwrap_err()
        .contains("尚未接收"));
    let pending = binding_on(&f.c(), &work).unwrap();
    conversation::steer(&f.root, &work.id, &command).unwrap();
    assert_eq!(binding_on(&f.c(), &work).unwrap(), pending);
    assert_eq!(pending["commandWatermark"], 1);
    assert_eq!(pending["workRevision"], initial["workRevision"]);
    assert_ne!(initial, pending);
    let other_id = create(&f, false);
    let (other, other_run) = claim(&f, &other_id);
    assert_eq!(
        for_run(&f.root, &other, &other_run).unwrap()["commandWatermark"],
        0
    );
    assert!(ensure_binding_on(&f.c(), &other, &pending).is_err());
    record(&f.root, &run, "steeringAccepted", &command).unwrap();
    assert_eq!(for_run(&f.root, &work, &run).unwrap(), pending);
    let reopened = load(&f.c(), &work.id).unwrap();
    assert_eq!(
        conversation::context(&f.root, &reopened).unwrap()["goalBinding"],
        pending
    );
}

#[test]
fn native_publication_requires_exact_accepted_report_and_persists_assessment() {
    let (f, work, run) = setup();
    let report = answer("已核对当前材料");
    assert!(publish_report(&f, &work, &run, &report)
        .unwrap_err()
        .contains("缺少最终"));
    let binding = for_run(&f.root, &work, &run).unwrap();
    accept_report(&f.root, &work, &run, &report, &binding).unwrap();
    assert_eq!(
        records(&f.root, &work.id, "finishAcceptance", 1).unwrap()[0]["report"],
        json!(report)
    );
    assert!(publish_report(&f, &work, &run, &answer("替换成另一个结论")).is_err());
    assert!(records(&f.root, &work.id, "delivery", 1)
        .unwrap()
        .is_empty());
    publish_report(&f, &work, &run, &report).unwrap();
    let saved = records(&f.root, &work.id, "delivery", 1).unwrap().remove(0);
    assert_eq!(saved["goalBinding"], binding);
    assert_eq!(
        saved["deliveryAssessment"]["reportHash"],
        report_hash(&report).unwrap()
    );
    assert_eq!(
        saved["deliveryAssessment"]["semanticStatusSource"],
        "notProvided"
    );
    assert_eq!(saved["deliveryAssessment"]["workFulfillment"], "partial");
    assert_eq!(
        view(&f.root, &work.id).unwrap()["work"]["report"]["summary"],
        "已核对当前材料"
    );
}

#[test]
fn late_command_cannot_publish_old_acceptance_even_after_provider_acknowledges() {
    let (f, work, run) = setup();
    let report = answer("旧目标的结论");
    let old = for_run(&f.root, &work, &run).unwrap();
    accept_report(&f.root, &work, &run, &report, &old).unwrap();
    let command = steer(&f, &work, &run, "late");
    assert!(publish_report(&f, &work, &run, &report)
        .unwrap_err()
        .contains("尚未接收"));
    record(&f.root, &run, "steeringAccepted", &command).unwrap();
    assert!(publish_report(&f, &work, &run, &report)
        .unwrap_err()
        .contains("核验后"));
    assert!(accept_report(&f.root, &work, &run, &report, &old).is_err());
    assert!(records(&f.root, &work.id, "delivery", 1)
        .unwrap()
        .is_empty());
    assert_eq!(
        view(&f.root, &work.id).unwrap()["work"]["state"],
        "investigating"
    );
    let updated = answer("已处理追加要求，只交付预览");
    let latest = for_run(&f.root, &work, &run).unwrap();
    accept_report(&f.root, &work, &run, &updated, &latest).unwrap();
    publish_report(&f, &work, &run, &updated).unwrap();
    let saved = records(&f.root, &work.id, "delivery", 1).unwrap().remove(0);
    assert_eq!(saved["goalBinding"]["commandWatermark"], 1);
    assert_eq!(
        records(&f.root, &work.id, "finishAcceptance", 8)
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn report_without_charts_becomes_historical_when_new_command_is_committed() {
    let (f, work, run) = setup();
    let report = answer("历史回答保持原字节");
    accept_report(
        &f.root,
        &work,
        &run,
        &report,
        &for_run(&f.root, &work, &run).unwrap(),
    )
    .unwrap();
    publish_report(&f, &work, &run, &report).unwrap();
    let saved = records(&f.root, &work.id, "delivery", 1).unwrap();
    let before = view(&f.root, &work.id).unwrap();
    let (next, next_run) = claim(&f, &work.id);
    record(&f.root, &next_run, "nativeRuntime", &json!({"protocol":1})).unwrap();
    steer(&f, &next, &next_run, "next");
    let snapshot = view(&f.root, &work.id).unwrap();
    let history = &snapshot["conversation"]["messages"][1];
    assert_eq!(history["artifactState"], "stale");
    assert_eq!(history["report"]["summary"], "历史回答保持原字节");
    assert!(history["validity"].as_str().unwrap().contains("要求已更新"));
    assert_eq!(records(&f.root, &work.id, "delivery", 1).unwrap(), saved);
    if let Ok(path) = std::env::var("HUB_GOAL_BINDING_VIEW") {
        std::fs::write(
            path,
            serde_json::to_vec_pretty(&json!({"before":before,"changed":snapshot})).unwrap(),
        )
        .unwrap();
    }
}
