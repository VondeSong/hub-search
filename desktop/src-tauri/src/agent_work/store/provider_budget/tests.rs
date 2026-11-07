use super::*;
use crate::agent_work::{tests::create, ui};
use crate::source_evidence::tests::Fixture;

fn tokens(i: u64, u: u64, o: u64) -> Value {
    json!({"inputTokens":i,"uncachedInputTokens":u,"outputTokens":o})
}
fn setup() -> (Fixture, String) {
    let f = Fixture::new();
    f.note("notes", "current", "只读合成来源");
    let id = create(&f, true);
    (f, id)
}
fn request(f: &Fixture, id: &str) -> Value {
    json!({"action":"freezeProviderBudget","id":id,"expectedWorkRevision":load(&f.c(),id).unwrap().revision,"limits":tokens(100,60,20),"perRun":tokens(40,20,8),"unknownReservations":{}})
}
fn close(f: &Fixture, w: &Work, run: &str) {
    super::super::fail(&f.root, w, run, "已停止合成检查，不调用模型").unwrap();
}

#[test]
fn frozen_provider_policy_is_idempotent_and_unknown_legacy_is_not_zero() {
    let (f, id) = setup();
    let old = super::super::claim(&f.root, &id, "legacy").unwrap();
    super::super::record(&f.root, "legacy", "nativeRuntime", &json!({"protocol":1})).unwrap();
    close(&f, &old, "legacy");
    let mut args = request(&f, &id);
    assert!(freeze(&f.root, &args).is_err());
    args["unknownReservations"] = json!({"legacy":tokens(60,30,10)});
    ui(&f.root, &args).unwrap();
    ui(&f.root, &args).unwrap();
    assert_eq!(facts(&f.c(), &id, "providerBudgetPolicy").unwrap().len(), 1);
    let p = view_on(&f.c(), &load(&f.c(), &id).unwrap()).unwrap();
    assert_eq!(p["chargedOrReserved"], tokens(60, 30, 10));
    assert_eq!(p["unmeasuredRunIds"], json!(["legacy"]));
    args["limits"] = tokens(1000, 600, 200);
    assert!(ui(&f.root, &args).is_err());
    let w = super::super::claim_with_budget(&f.root, &id, "next", Budget::mode("quick").unwrap())
        .unwrap();
    close(&f, &w, "next");
    assert!(ui(&f.root, &json!({"action":"respond","id":id}))
        .unwrap_err()
        .contains("Token累计额度不足"));
    assert_eq!(facts(&f.c(), &id, "nativeRuntime").unwrap().len(), 1);
}

#[test]
fn failed_provider_reservation_rolls_back_run_policy_and_current_result() {
    let (f, id) = setup();
    freeze(&f.root, &request(&f, &id)).unwrap();
    let before = load(&f.c(), &id).unwrap();
    f.c().execute_batch("CREATE TRIGGER reject_provider BEFORE INSERT ON agent_records WHEN NEW.kind='providerBudgetReservation' BEGIN SELECT RAISE(ABORT,'provider reserve commit failure'); END;").unwrap();
    assert!(super::super::claim_with_budget(
        &f.root,
        &id,
        "denied",
        Budget::mode("quick").unwrap()
    )
    .is_err());
    let after = load(&f.c(), &id).unwrap();
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
fn incomplete_observation_keeps_reservation_after_reopen_and_final_settlement_is_immutable() {
    let (f, id) = setup();
    freeze(&f.root, &request(&f, &id)).unwrap();
    let b = Budget::mode("quick").unwrap();
    let w = super::super::claim_with_budget(&f.root, &id, "first", b).unwrap();
    observe(&f.root, &w, "first", &tokens(3, 2, 1), false).unwrap();
    observe(&f.root, &w, "first", &json!({"inputTokens":3}), true).unwrap();
    close(&f, &w, "first");
    assert_eq!(
        view_on(&super::super::read(&f.root).unwrap(), &w).unwrap()["chargedOrReserved"],
        tokens(40, 20, 8)
    );
    let w2 = super::super::claim_with_budget(&f.root, &id, "second", b).unwrap();
    super::super::write(&f.root, |c| reserve_on(c, &w2, "second")).unwrap();
    observe(&f.root, &w2, "second", &tokens(7, 4, 2), true).unwrap();
    observe(&f.root, &w2, "second", &tokens(7, 4, 2), true).unwrap();
    assert!(observe(&f.root, &w2, "second", &tokens(6, 4, 2), true).is_err());
    assert_eq!(
        facts(&f.c(), &id, "providerBudgetReservation")
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        view_on(&f.c(), &w2).unwrap()["chargedOrReserved"],
        tokens(47, 24, 10)
    );
    assert_eq!(
        view_on(&f.c(), &w2).unwrap()["unmeasuredRunIds"],
        json!(["first"])
    );
}

#[test]
fn live_overrun_is_committed_before_refusal_and_does_not_release_estimate() {
    let (f, id) = setup();
    freeze(&f.root, &request(&f, &id)).unwrap();
    let w =
        super::super::claim_with_budget(&f.root, &id, "overrun", Budget::mode("quick").unwrap())
            .unwrap();
    assert!(observe(&f.root, &w, "overrun", &tokens(101, 30, 9), false).is_err());
    assert_eq!(
        facts(&f.c(), &id, "providerBudgetObservation").unwrap()[0]["observed"],
        tokens(101, 30, 9)
    );
    assert!(facts(&f.c(), &id, "providerBudgetSettlement")
        .unwrap()
        .is_empty());
    assert!(observe(&f.root, &w, "overrun", &tokens(2, 1, 1), true).is_err());
    let p = view_on(&f.c(), &w).unwrap();
    assert_eq!(p["chargedOrReserved"], tokens(101, 30, 9));
    assert_eq!(p["canAdmitRun"], false);
    close(&f, &w, "overrun");
    assert!(ui(&f.root, &json!({"action":"respond","id":id})).is_err());
}

#[test]
fn known_input_overrun_stops_even_when_cached_usage_is_missing() {
    let (f, id) = setup();
    freeze(&f.root, &request(&f, &id)).unwrap();
    let w = super::super::claim_with_budget(
        &f.root,
        &id,
        "partial-high",
        Budget::mode("quick").unwrap(),
    )
    .unwrap();
    assert!(observe(
        &f.root,
        &w,
        "partial-high",
        &json!({"inputTokens":200}),
        true
    )
    .is_err());
    assert_eq!(
        view_on(&f.c(), &w).unwrap()["chargedOrReserved"],
        tokens(200, 20, 8)
    );
    assert!(facts(&f.c(), &id, "providerBudgetSettlement")
        .unwrap()
        .is_empty());
}

#[test]
fn settlement_commit_failure_retains_full_reservation_and_readonly_status() {
    let (f, id) = setup();
    freeze(&f.root, &request(&f, &id)).unwrap();
    let w = super::super::claim_with_budget(
        &f.root,
        &id,
        "commit-failed",
        Budget::mode("quick").unwrap(),
    )
    .unwrap();
    f.c().execute_batch("CREATE TRIGGER reject_provider_settlement BEFORE INSERT ON agent_records WHEN NEW.kind='providerBudgetSettlement' BEGIN SELECT RAISE(ABORT,'settle commit failure'); END;").unwrap();
    assert!(observe(&f.root, &w, "commit-failed", &tokens(3, 2, 1), true).is_err());
    assert_eq!(
        view_on(&f.c(), &w).unwrap()["chargedOrReserved"],
        tokens(40, 20, 8)
    );
    close(&f, &w, "commit-failed");
    f.c().execute("UPDATE agent_records SET body_json=json_set(body_json,'$.schemaVersion',99) WHERE kind='providerBudgetPolicy'",[]).unwrap();
    assert_eq!(
        ui(&f.root, &json!({"action":"status","id":id})).unwrap()["lifecycle"]["providerBudget"]
            ["state"],
        "unavailable"
    );
    assert!(ui(&f.root, &json!({"action":"respond","id":id})).is_err());
}

#[test]
#[ignore = "explicit saved Work only; bind original frozen cap and prove refusal, no model"]
fn saved_exhausted_work_is_fenced_through_formal_host_entry_without_dispatch() {
    let root = std::path::PathBuf::from(std::env::var("HUB_PROVIDER_FENCE_ROOT").unwrap());
    let id = "work-qmx-qclI33T4evy-Xe9Dpb4Z";
    let before = ui(&root, &json!({"action":"status","id":id})).unwrap();
    assert_eq!(before["lifecycle"]["runsUsed"], 6);
    assert_eq!(before["work"]["state"], "completed");
    let c = super::super::read(&root).unwrap();
    let deliveries = facts(&c, id, "delivery").unwrap();
    let provider_records = facts(&c, id, "nativeRuntime").unwrap();
    drop(c);
    let args = json!({"action":"freezeProviderBudget","id":id,"expectedWorkRevision":before["work"]["revision"],"limits":tokens(1200000,300000,16000),"perRun":tokens(215446,70646,5378),"unknownReservations":{"run-fA3R0kd7DbBDunsO3_o_yYQG":tokens(600000,150000,8000),"run-QJFQ8eVtvUulmFWooVVpoId2":tokens(150000,40000,1000)}});
    let frozen = ui(&root, &args).unwrap();
    assert_eq!(
        frozen["lifecycle"]["providerBudget"]["chargedOrReserved"],
        tokens(1221064, 277064, 12115)
    );
    let error = ui(&root, &json!({"action":"respond","id":id})).unwrap_err();
    assert!(error.contains("Token累计额度不足"));
    let after = ui(&root, &json!({"action":"status","id":id})).unwrap();
    let c = super::super::read(&root).unwrap();
    assert_eq!(after["work"]["state"], "completed");
    assert_eq!(after["lifecycle"]["runsUsed"], 6);
    assert_eq!(facts(&c, id, "delivery").unwrap(), deliveries);
    assert_eq!(facts(&c, id, "nativeRuntime").unwrap(), provider_records);
    if let Ok(out) = std::env::var("HUB_PROVIDER_FENCE_OUT") {
        std::fs::write(out,serde_json::to_vec_pretty(&json!({"providerBudget":after["lifecycle"]["providerBudget"],"runCount":6,"deliveriesUnchanged":true,"newModels":0,"formalEntryError":error,"businessState":"completed"})).unwrap()).unwrap();
    }
}

#[test]
fn reserved_native_analysis_operation_admits_only_its_frozen_current_run() {
    let (f, id) = setup();
    ui(&f.root, &request(&f, &id)).unwrap();
    let w = super::super::claim_with_budget(
        &f.root,
        &id,
        "native-analysis-admission",
        Budget::mode("quick").unwrap(),
    )
    .unwrap();
    let admitted = crate::agent_work::options::operation(
        &f.root,
        &w,
        "agent-investigation",
        "isolated admission check; no provider request",
        crate::model_runtime::Control::default(),
    );
    assert!(
        admitted.is_ok(),
        "reserved native analysis was blocked before provider dispatch: {:?}",
        admitted.err()
    );
    assert_eq!(facts(&f.c(), &id, "nativeRuntime").unwrap().len(), 0);
    assert_eq!(facts(&f.c(), &id, "modelExecution").unwrap().len(), 0);
    let mut stale = w.clone();
    stale.active_run = Some("another-run".into());
    assert!(crate::agent_work::options::operation(
        &f.root,
        &stale,
        "agent-investigation",
        "must refuse stale Run",
        crate::model_runtime::Control::default()
    )
    .is_err());
    assert!(crate::agent_work::options::operation(
        &f.root,
        &w,
        "agent-obsidian-edit",
        "must keep draft guard",
        crate::model_runtime::Control::default()
    )
    .err()
    .unwrap()
    .contains("未启动模型"));
    assert!(observe(
        &f.root,
        &w,
        "native-analysis-admission",
        &json!({"inputTokens":41}),
        false
    )
    .is_err());
    assert!(crate::agent_work::options::operation(
        &f.root,
        &w,
        "agent-investigation",
        "must stop exceeded current Run",
        crate::model_runtime::Control::default()
    )
    .is_err());
}

#[test]
fn reserved_analysis_with_no_extra_capacity_keeps_current_reservation_and_rejects_missing_owner() {
    let (f, id) = setup();
    let mut policy = request(&f, &id);
    policy["limits"] = policy["perRun"].clone();
    ui(&f.root, &policy).unwrap();
    let ready = load(&f.c(), &id).unwrap();
    assert!(crate::agent_work::options::operation(
        &f.root,
        &ready,
        "agent-investigation",
        "no claim yet",
        crate::model_runtime::Control::default()
    )
    .is_err());
    let w = super::super::claim_with_budget(
        &f.root,
        &id,
        "fully-reserved-analysis",
        Budget::mode("quick").unwrap(),
    )
    .unwrap();
    assert_eq!(view_on(&f.c(), &w).unwrap()["canAdmitRun"], false);
    assert!(crate::agent_work::options::operation(
        &f.root,
        &w,
        "agent-investigation",
        "own reservation, no provider call",
        crate::model_runtime::Control::default()
    )
    .is_ok());
    f.c()
        .execute(
            "DELETE FROM agent_records WHERE work_id=?1 AND kind='providerBudgetReservation'",
            [&id],
        )
        .unwrap();
    assert!(crate::agent_work::options::operation(
        &f.root,
        &w,
        "agent-investigation",
        "missing durable reserve",
        crate::model_runtime::Control::default()
    )
    .err()
    .unwrap()
    .contains("持久预算预留"));
    assert_eq!(facts(&f.c(), &id, "modelExecution").unwrap().len(), 0);
}

mod os_observation;

#[test]
fn material_preflight_defers_new_provider_reservation_and_keeps_previous_unknown() {
    let (f, id) = setup();
    ui(&f.root, &request(&f, &id)).unwrap();
    let old = super::super::claim_with_budget(
        &f.root,
        &id,
        "old-unknown",
        Budget::mode("quick").unwrap(),
    )
    .unwrap();
    close(&f, &old, "old-unknown");
    let w = load(&f.c(), &id).unwrap();
    let source = w
        .grant
        .reader(&f.root)
        .unwrap()
        .read(w.anchor.as_ref().unwrap(), 0, 100, None)
        .unwrap();
    let plan = json!({"schemaVersion":1,"workRevision":w.revision,"authorizationVersion":w.authorization_version,"requestBytes":131072,"reads":[{"locator":w.anchor,"version":source.version,"repetitions":1}],"workingStateRoundTrips":0,"workingStateExtraBytes":0,"goalStateReads":0,"otherReplyBytes":10,"reserveRuleRestore":true,"basis":"synthetic exact source receipt plus ten explicitly estimated bytes; no provider execution"});
    ui(
        &f.root,
        &json!({"action":"freezeMaterialPlan","id":id,"plan":plan}),
    )
    .unwrap();
    let next = super::super::claim_with_budget(
        &f.root,
        &id,
        "pending-preflight",
        Budget::mode("quick").unwrap(),
    )
    .unwrap();
    assert_eq!(
        facts(&f.c(), &id, "providerBudgetReservation")
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        view_on(&f.c(), &next).unwrap()["chargedOrReserved"],
        tokens(40, 20, 8)
    );
    check_pending_admission_on(&f.c(), &next).unwrap();
    assert!(check_active_reservation_on(&f.c(), &next).is_err());
    assert!(crate::agent_work::options::operation(
        &f.root,
        &next,
        "agent-obsidian-edit",
        "still no draft",
        crate::model_runtime::Control::default()
    )
    .is_err());
    admit_after_preflight(&f.root, &next, "pending-preflight").unwrap();
    check_active_reservation_on(&f.c(), &next).unwrap();
    assert_eq!(
        facts(&f.c(), &id, "providerBudgetReservation")
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        view_on(&f.c(), &next).unwrap()["chargedOrReserved"],
        tokens(80, 40, 16)
    );
    assert!(facts(&f.c(), &id, "providerBudgetSettlement")
        .unwrap()
        .is_empty());
}
mod os_rules_repair;

#[test]
fn explicit_extension_preserves_unknown_and_rejects_stale_or_active_changes() {
    let (f, id) = setup();
    let original = request(&f, &id);
    ui(&f.root, &original).unwrap();
    let w =
        super::super::claim_with_budget(&f.root, &id, "unknown", Budget::mode("quick").unwrap())
            .unwrap();
    let args = json!({"action":"extendProviderBudget","id":id,"operationId":"one-extension","expectedWorkRevision":w.revision,"expectedAuthorizationVersion":w.authorization_version,"expectedLimits":tokens(100,60,20),"limits":tokens(140,80,28),"reason":"explicit future one-run allowance; preserve all unknown consumption"});
    assert!(ui(&f.root, &args).is_err());
    close(&f, &w, "unknown");
    let reserved = facts(&f.c(), &id, "providerBudgetReservation").unwrap();
    ui(&f.root, &args).unwrap();
    ui(&f.root, &args).unwrap();
    ui(&f.root, &original).unwrap();
    assert_eq!(facts(&f.c(), &id, "providerBudgetPolicy").unwrap().len(), 1);
    assert_eq!(
        facts(&f.c(), &id, "providerBudgetExtension").unwrap().len(),
        1
    );
    assert_eq!(
        facts(&f.c(), &id, "providerBudgetReservation").unwrap(),
        reserved
    );
    let view = view_on(&f.c(), &w).unwrap();
    assert_eq!(view["limits"], tokens(140, 80, 28));
    assert_eq!(view["perRun"], tokens(40, 20, 8));
    assert_eq!(view["chargedOrReserved"], tokens(40, 20, 8));
    assert_eq!(view["unmeasuredRunIds"], json!(["unknown"]));
    let mut bad = args.clone();
    bad["operationId"] = json!("stale");
    assert!(ui(&f.root, &bad).is_err());
    bad = args.clone();
    bad["limits"] = tokens(141, 80, 28);
    assert!(ui(&f.root, &bad).is_err());
    bad = args.clone();
    bad["expectedAuthorizationVersion"] = json!(999);
    assert!(ui(&f.root, &bad).is_err());
    f.c().execute_batch("CREATE TRIGGER reject_extension BEFORE INSERT ON agent_records WHEN NEW.kind='providerBudgetExtension' BEGIN SELECT RAISE(ABORT,'extension commit failure'); END;").unwrap();
    bad = args;
    bad["operationId"] = json!("commit-failure");
    bad["expectedLimits"] = tokens(140, 80, 28);
    bad["limits"] = tokens(180, 100, 36);
    assert!(ui(&f.root, &bad).is_err());
    assert_eq!(view_on(&f.c(), &w).unwrap()["limits"], tokens(140, 80, 28));
}

#[test]
fn material_plan_refresh_requires_exact_prior_plan_and_keeps_history() {
    let (f, id) = setup();
    ui(&f.root, &request(&f, &id)).unwrap();
    let w = load(&f.c(), &id).unwrap();
    let source = w
        .grant
        .reader(&f.root)
        .unwrap()
        .read(w.anchor.as_ref().unwrap(), 0, 100, None)
        .unwrap();
    let plan = json!({"schemaVersion":1,"workRevision":w.revision,"authorizationVersion":w.authorization_version,"requestBytes":188015,"reads":[{"locator":w.anchor,"version":source.version,"repetitions":1}],"workingStateRoundTrips":1,"workingStateExtraBytes":100,"goalStateReads":1,"otherReplyBytes":100,"reserveRuleRestore":true,"basis":"specific frozen source and existing working state; future remainder estimate"});
    ui(
        &f.root,
        &json!({"action":"freezeMaterialPlan","id":id,"plan":plan}),
    )
    .unwrap();
    let frozen = facts(&f.c(), &id, "nativeMaterialPlan").unwrap();
    let mut next = plan.clone();
    next["requestBytes"] = json!(196608);
    assert!(ui(
        &f.root,
        &json!({"action":"freezeMaterialPlan","id":id,"plan":next})
    )
    .is_err());
    let args = json!({"action":"freezeMaterialPlan","id":id,"plan":next,"expectedPlan":plan});
    ui(&f.root, &args).unwrap();
    ui(&f.root, &args).unwrap();
    let saved = facts(&f.c(), &id, "nativeMaterialPlan").unwrap();
    assert_eq!(saved.len(), 2);
    assert_eq!(saved[0], frozen[0]);
    assert_eq!(saved[1]["requestBytes"], 196608);
    let mut stale = args;
    stale["plan"]["requestBytes"] = json!(196609);
    assert!(ui(&f.root, &stale).is_err());
    assert!(facts(&f.c(), &id, "providerBudgetReservation")
        .unwrap()
        .is_empty());
}

mod manifest_admission;
mod os_delivery;
mod provider_admission;
mod report_recovery;
