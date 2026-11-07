use super::*;
use crate::agent_work::{store, tests::create, ui};
use crate::source_evidence::tests::Fixture;

#[test]
fn future_budget_schema_blocks_execution_without_hiding_readable_history() {
    let (f, id) = setup();
    let w = store::claim(&f.root, &id, "legacy-report").unwrap();
    let report=serde_json::from_value(json!({"status":"needsDecision","summary":"旧成果可读，预算版本待处理","findings":[],"nextSteps":[],"questions":["保留？"],"limitations":[],"waitCondition":""})).unwrap();
    store::publish(
        &f.root,
        &w,
        "legacy-report",
        &report,
        &[],
        &[],
        &json!([]),
        &Value::Null,
        &Control::default(),
    )
    .unwrap();
    store::write(&f.root, |c| {
        insert(
            c,
            &id,
            None,
            "executionBudgetPolicy",
            &json!({"schemaVersion":2,"rootWorkId":id,"limits":{},"legacyReservations":[]}),
        )
    })
    .unwrap();
    assert!(
        view_on(&f.c(), &w).is_err(),
        "unknown budget interpretation stays unavailable"
    );
    let visible = ui(&f.root, &json!({"action":"status","id":id})).unwrap();
    assert!(visible.to_string().contains("旧成果可读，预算版本待处理"));
    assert_eq!(
        visible["lifecycle"]["executionBudget"]["state"],
        "unavailable"
    );
    assert_eq!(visible["lifecycle"]["canResume"], false);
    assert_eq!(
        visible["lifecycle"]["executionModes"],
        json!({"quick":false,"deep":false})
    );
    let before = facts(&f.c(), &id, "delivery").unwrap();
    assert!(ui(&f.root, &json!({"action":"respond","id":id})).is_err());
    assert_eq!(facts(&f.c(), &id, "delivery").unwrap(), before);
    assert!(facts(&f.c(), &id, "nativeRuntime").unwrap().is_empty());
    assert_eq!(
        facts(&f.c(), &id, "executionBudgetPolicy").unwrap()[0]["schemaVersion"],
        2
    );
}

fn tiny() -> Budget {
    let mut b = Budget::mode("quick").unwrap();
    b.model_calls = 1;
    b.output_repair_calls = 0;
    b.tool_steps = 2;
    b.summaries = 2;
    b.entities = 1;
    b.body_chars = 8;
    b.request_bytes = 64;
    b.seconds = 1;
    b
}
fn setup() -> (Fixture, String) {
    let f = Fixture::new();
    f.note("notes", "current", "授权原文");
    let id = create(&f, true);
    (f, id)
}
fn fixed_policy(f: &Fixture, id: &str, b: Budget, multiple: u64) {
    let limits: Counters = planned(&json!(b))
        .unwrap()
        .into_iter()
        .map(|(k, v)| (k, v * multiple))
        .collect();
    store::write(&f.root,|c|insert(c,id,None,"executionBudgetPolicy",&json!({"schemaVersion":1,"rootWorkId":id,"limits":limits,"legacyReservations":[],"origin":"deterministic bounded fixture"}))).unwrap();
}
fn counters(b: Budget) -> Value {
    json!(planned(&json!(b))
        .unwrap()
        .into_keys()
        .map(|k| (k, 0u64))
        .collect::<Counters>())
}
fn fail(f: &Fixture, w: &Work, r: &str) {
    store::fail(&f.root, w, r, "保存的中断；不运行模型").unwrap();
}
fn control(f: &Fixture, id: &str, action: &str, key: &str) -> Value {
    let s = ui(&f.root, &json!({"action":"status","id":id})).unwrap();
    json!({"action":action,"id":id,"commandId":key,"expectedControlRevision":s["lifecycle"]["controlRevision"],"expectedWorkRevision":s["work"]["revision"],"expectedRunId":s["lifecycle"]["activeRunId"]})
}

#[test]
fn public_mode_headroom_matches_atomic_admission_without_changing_limits() {
    let (f, id) = setup();
    let quick = crate::agent_work::assistant::budget("quick").unwrap();
    fixed_policy(&f, &id, quick, 1);
    let before = facts(&f.c(), &id, "executionBudgetPolicy").unwrap();
    let s = ui(&f.root, &json!({"action":"status","id":id})).unwrap();
    assert_eq!(s["lifecycle"]["executionBudget"]["exhausted"], false);
    assert_eq!(
        s["lifecycle"]["executionModes"],
        json!({"quick":true,"deep":false})
    );
    let denied = ui(&f.root, &json!({"action":"respond","id":id,"mode":"deep"})).unwrap_err();
    assert!(denied.contains("累计执行预算不足"));
    assert_eq!(
        ui(&f.root, &json!({"action":"status","id":id})).unwrap()["lifecycle"]["runsUsed"],
        0
    );
    assert!(facts(&f.c(), &id, "nativeRuntime").unwrap().is_empty());
    let w = store::claim_with_budget(&f.root, &id, "admitted-quick", quick).unwrap();
    fail(&f, &w, "admitted-quick");
    let after = ui(&f.root, &json!({"action":"status","id":id})).unwrap();
    assert_eq!(
        after["lifecycle"]["executionModes"],
        json!({"quick":false,"deep":false})
    );
    assert_eq!(facts(&f.c(), &id, "executionBudgetPolicy").unwrap(), before);
}

#[test]
fn positive_remainder_below_public_modes_saves_requirements_without_new_run() {
    let (f, id) = setup();
    fixed_policy(&f, &id, tiny(), 2);
    let before = ui(&f.root, &json!({"action":"status","id":id})).unwrap();
    assert_eq!(before["lifecycle"]["executionBudget"]["exhausted"], false);
    assert_eq!(
        before["lifecycle"]["executionModes"],
        json!({"quick":false,"deep":false})
    );
    let saved = ui(&f.root, &json!({"action":"message","id":id,"text":"保存下次要核对的要求，不启动模型","clientMessageId":"save-only"})).unwrap();
    assert!(saved
        .to_string()
        .contains("保存下次要核对的要求，不启动模型"));
    assert_eq!(saved["lifecycle"]["runsUsed"], 0);
    assert_eq!(
        saved["lifecycle"]["executionModes"],
        before["lifecycle"]["executionModes"]
    );
    assert!(facts(&f.c(), &id, "nativeRuntime").unwrap().is_empty());
    assert!(facts(&f.c(), &id, "executionBudgetReservation")
        .unwrap()
        .is_empty());
}

#[test]
fn reservation_failure_rolls_back_run_and_original_work() {
    let (f, id) = setup();
    let before = store::load(&f.c(), &id).unwrap();
    f.c().execute_batch("CREATE TRIGGER reject_execution_reservation BEFORE INSERT ON agent_records WHEN NEW.kind='executionBudgetReservation' BEGIN SELECT RAISE(ABORT,'reservation commit failure'); END;").unwrap();
    assert!(store::claim_with_budget(&f.root, &id, "not-admitted", tiny()).is_err());
    let after = store::load(&f.c(), &id).unwrap();
    assert_eq!(after.state, before.state);
    assert_eq!(after.active_run, None);
    assert_eq!(after.revision, before.revision);
    assert_eq!(
        f.c()
            .query_row(
                "SELECT COUNT(*) FROM agent_runs WHERE work_id=?1",
                [&id],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    assert!(facts(&f.c(), &id, "executionBudgetPolicy")
        .unwrap()
        .is_empty());
}

#[test]
fn attempt_replay_cannot_double_reserve_or_rewrite_settlement() {
    let (f, id) = setup();
    let b = tiny();
    let w = store::claim_with_budget(&f.root, &id, "once", b).unwrap();
    store::write(&f.root, |c| reserve_on(c, &w, "once", b)).unwrap();
    assert_eq!(
        facts(&f.c(), &id, "executionBudgetReservation")
            .unwrap()
            .len(),
        1
    );
    let mut changed = b;
    changed.tool_steps += 1;
    assert!(store::write(&f.root, |c| reserve_on(c, &w, "once", changed)).is_err());
    let u = counters(b);
    settle(&f.root, &w, "once", &u).unwrap();
    settle(&f.root, &w, "once", &u).unwrap();
    assert_eq!(
        facts(&f.c(), &id, "executionBudgetSettlement")
            .unwrap()
            .len(),
        1
    );
    let mut different = u;
    different["toolSteps"] = json!(1);
    assert!(settle(&f.root, &w, "once", &different).is_err());
}

#[test]
fn lost_final_accounting_retains_quota_across_reopen_and_new_runs() {
    let (f, id) = setup();
    let b = tiny();
    fixed_policy(&f, &id, b, 2);
    let _first = store::claim_with_budget(&f.root, &id, "lost", b).unwrap();
    store::reconcile(&f.root, &id, None).unwrap();
    let reopened = store::load(&f.c(), &id).unwrap();
    assert_eq!(reopened.state, "interrupted");
    let second = store::claim_with_budget(&f.root, &id, "second", b).unwrap();
    fail(&f, &second, "second");
    assert!(store::claim_with_budget(&f.root, &id, "third", b)
        .err()
        .unwrap()
        .contains("累计执行预算不足"));
    let denied = ui(&f.root, &json!({"action":"respond","id":id,"mode":"quick"}))
        .err()
        .unwrap();
    assert!(denied.contains("累计执行预算不足"));
    assert!(facts(&f.c(), &id, "nativeRuntime").unwrap().is_empty());
    let s = ui(&f.root, &json!({"action":"status","id":id})).unwrap();
    assert_eq!(s["lifecycle"]["runsUsed"], 2);
    assert_eq!(
        s["lifecycle"]["executionBudget"]["unsettledRunIds"],
        json!(["lost", "second"])
    );
    assert_eq!(
        s["lifecycle"]["executionBudget"]["chargedOrReserved"]["toolSteps"],
        4
    );
    assert!(s["lifecycle"]["executionBudget"]["providerTokensOrFeesBounded"] == false);
}

#[test]
fn paused_resume_reuses_the_same_budget_root_and_command_identity() {
    let (f, id) = setup();
    let b = tiny();
    fixed_policy(&f, &id, b, 2);
    let w = store::claim_with_budget(&f.root, &id, "stopped", b).unwrap();
    let args = json!({"commandId":"stop","expectedControlRevision":1,"expectedWorkRevision":w.revision,"expectedRunId":"stopped"});
    store::lifecycle::stop(&f.root, &id, &args, false).unwrap();
    assert_eq!(
        view_on(&f.c(), &store::load(&f.c(), &id).unwrap()).unwrap()["exhausted"],
        false,
        "a disabled optional repair dimension is not exhausted execution quota"
    );
    let resume = control(&f, &id, "resume", "same-resume");
    let next = store::lifecycle::resume_with_budget(&f.root, &id, "resumed", &resume, b)
        .unwrap()
        .unwrap();
    assert_eq!(next.id, id);
    assert!(
        store::lifecycle::resume_with_budget(&f.root, &id, "must-not-exist", &resume, b)
            .unwrap()
            .is_none()
    );
    let s = view_on(&f.c(), &next).unwrap();
    assert_eq!(s["rootWorkId"], id);
    assert_eq!(s["chargedOrReserved"]["toolSteps"], 4);
    assert_eq!(
        facts(&f.c(), &id, "executionBudgetPolicy").unwrap().len(),
        1
    );
    assert_eq!(
        facts(&f.c(), &id, "executionBudgetReservation")
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn legacy_partial_usage_is_not_mistaken_for_final_zero() {
    let (f, id) = setup();
    let b = tiny();
    let legacy = store::claim(&f.root, &id, "legacy").unwrap();
    store::record(&f.root, "legacy", "budget", &json!(b)).unwrap();
    store::usage(&f.root, "legacy", &counters(b)).unwrap();
    fail(&f, &legacy, "legacy");
    let current = store::claim_with_budget(&f.root, &id, "new", b).unwrap();
    let s = view_on(&f.c(), &current).unwrap();
    assert_eq!(s["chargedOrReserved"]["toolSteps"], 4);
    assert_eq!(s["unsettledRunIds"], json!(["legacy", "new"]));
    let policy = facts(&f.c(), &id, "executionBudgetPolicy").unwrap();
    assert_eq!(
        policy[0]["legacyReservations"][0]["reserved"]["toolSteps"],
        2
    );
}

#[test]
fn failed_settlement_keeps_reservation_and_known_settlement_preserves_history() {
    let (f, id) = setup();
    let b = tiny();
    fixed_policy(&f, &id, b, 2);
    let w = store::claim_with_budget(&f.root, &id, "delivered", b).unwrap();
    let report=serde_json::from_value(json!({"status":"needsDecision","summary":"已保存且可核对的旧成果","findings":[],"nextSteps":[],"questions":["保留这个结果？"],"limitations":[],"waitCondition":""})).unwrap();
    store::publish(
        &f.root,
        &w,
        "delivered",
        &report,
        &[],
        &[],
        &json!([]),
        &Value::Null,
        &Control::default(),
    )
    .unwrap();
    let delivery = facts(&f.c(), &id, "delivery").unwrap();
    f.c().execute_batch("CREATE TRIGGER reject_execution_settlement BEFORE INSERT ON agent_records WHEN NEW.kind='executionBudgetSettlement' BEGIN SELECT RAISE(ABORT,'settlement commit failure'); END;").unwrap();
    let mut actual = counters(b);
    actual["toolSteps"] = json!(1);
    actual["elapsedMs"] = json!(100);
    assert!(settle(&f.root, &w, "delivered", &actual).is_err());
    assert_eq!(
        view_on(&f.c(), &w).unwrap()["chargedOrReserved"]["toolSteps"],
        2
    );
    f.c()
        .execute_batch("DROP TRIGGER reject_execution_settlement;")
        .unwrap();
    settle(&f.root, &w, "delivered", &actual).unwrap();
    let s = view_on(&f.c(), &w).unwrap();
    assert_eq!(s["chargedOrReserved"]["toolSteps"], 1);
    assert_eq!(s["remaining"]["toolSteps"], 3);
    let second = store::claim_with_budget(&f.root, &id, "unknown-second", b).unwrap();
    fail(&f, &second, "unknown-second");
    assert!(store::claim_with_budget(&f.root, &id, "no-third", b).is_err());
    assert_eq!(facts(&f.c(), &id, "delivery").unwrap(), delivery);
    let read = ui(&f.root, &json!({"action":"status","id":id})).unwrap();
    assert!(read.to_string().contains("已保存且可核对的旧成果"));
}
