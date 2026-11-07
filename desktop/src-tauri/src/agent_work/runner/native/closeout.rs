use super::*;
use crate::source_evidence::tests::Fixture;
fn plan(bytes: usize) -> store::material_budget::Plan {
    serde_json::from_value(json!({"schemaVersion":1,"workRevision":1,"authorizationVersion":1,"requestBytes":bytes,"reads":[{"locator":{"kind":"note","libraryId":"notes","documentId":"current","pageId":null},"version":{"kind":"document","fingerprint":"version"},"repetitions":1}],"workingStateRoundTrips":0,"workingStateExtraBytes":0,"goalStateReads":1,"otherReplyBytes":0,"reserveRuleRestore":true,"basis":"bounded test of frozen GUI material plan admission"})).unwrap()
}
#[test]
fn gui_and_mode_admission_share_frozen_request_ceiling_without_raising_mode_limits() {
    let legacy = assistant::budget("quick").unwrap();
    assert_eq!(legacy.request_bytes, 1_048_576);
    assert_eq!(
        json!(assistant::budget_for_plan("quick", None).unwrap()),
        json!(legacy)
    );
    let p = plan(262144);
    let bounded = assistant::budget_for_plan("quick", Some(&p)).unwrap();
    assert_eq!(bounded.request_bytes, 262144);
    let mut old = json!(legacy);
    old["requestBytes"] = json!(262144);
    assert_eq!(json!(bounded), old);
    let p = plan(3_145_728);
    assert!(assistant::budget_for_plan("quick", Some(&p)).is_err());
    assert_eq!(
        assistant::budget_for_plan("deep", Some(&p))
            .unwrap()
            .request_bytes,
        3_145_728
    );
    assert!(assistant::budget_for_plan("deep", Some(&plan(0))).is_err());
}
#[test]
fn repeated_schema_failure_keeps_exact_errors_and_stops_at_original_tool_budget() {
    let f = Fixture::new();
    f.note("notes", "current", "controlled failure input");
    let id = crate::agent_work::tests::create(&f, false);
    let (_, run) = crate::agent_work::tests::claim(&f, &id);
    let specs = tools(None).unwrap();
    let mut used = 0;
    for i in 0..3 {
        let call = json!({"tool":"hub_read","callId":format!("bad-{i}"),"arguments":{"locator":"wrong-type"}});
        let feedback = arguments::decode(&f.root, &run, &specs, &call, &mut used, 3)
            .unwrap()
            .err()
            .unwrap();
        assert!(feedback["error"].as_str().is_some_and(|s| !s.is_empty()));
        assert_eq!(feedback["remainingToolSteps"], 2 - i);
    }
    assert!(arguments::decode(
        &f.root,
        &run,
        &specs,
        &json!({"tool":"hub_read","callId":"bad-4","arguments":{}}),
        &mut used,
        3
    )
    .err()
    .unwrap()
    .contains("预算"));
    let records = store::records(&f.root, &id, "toolRejected", 4).unwrap();
    assert_eq!(records.len(), 3);
    assert!(records
        .iter()
        .all(|r| r["inputSchema"].is_object() && r["arguments"].is_object()));
    assert_eq!(
        specs.as_array().unwrap().last().unwrap()["name"],
        "hub_finish"
    );
    assert_eq!(f.c().query_row("SELECT count(*) FROM agent_records WHERE kind IN ('nativeRuntime','providerBudgetReservation')",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    assert_eq!(
        f.c()
            .query_row("SELECT count(*) FROM agent_actions", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
#[ignore = "one saved Work admission comparison; GUI budgets only, no provider dispatch"]
fn saved_gui_budget_admission_old_rejects_and_bounded_plan_passes() {
    assert_eq!(std::env::var("HUB_V3_CLOSEOUT_ADMISSION").unwrap(), "1");
    let base = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .canonicalize()
        .unwrap();
    let out = base.join("artifacts/architecture-v3-closeout-20261027");
    let root = base.join(".local/v3-closeout-20261027/admission-profile");
    let read = |p: std::path::PathBuf| -> Value {
        serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap()
    };
    let contract = read(out.join("contract.json"));
    let id = contract["sourceWorkId"].as_str().unwrap();
    assert_eq!(id, "work-ygzNlDPVgd95DWCe22jmNW93");
    assert!(!out.join("admission-started.json").exists());
    std::fs::write(
        out.join("admission-started.json"),
        b"{\"providerRuns\":0,\"comparisons\":2}",
    )
    .unwrap();
    crate::agent_work::ui(&root,&json!({"action":"extendProviderBudget","id":id,"operationId":"closeout-admission-diagnostic-only","reason":"diagnostic copy only; two zero-model entry comparisons, preserve all old unknown","expectedWorkRevision":2,"expectedAuthorizationVersion":1,"expectedLimits":contract["oldLimits"],"limits":contract["futureLimits"]})).unwrap();
    let c = crate::source_evidence::open_read_database(&root).unwrap();
    let plan = store::material_budget::load_on(&c, id).unwrap().unwrap();
    let before=c.query_row("SELECT count(*) FROM agent_records WHERE work_id=?1 AND kind IN ('nativeRuntime','providerBudgetReservation')",[id],|r|r.get::<_,i64>(0)).unwrap();
    drop(c);
    let old = assistant::budget("quick").unwrap();
    let bounded = assistant::budget_for_plan("quick", Some(&plan)).unwrap();
    assert_eq!(old.request_bytes, 1048576);
    assert_eq!(bounded.request_bytes, 262144);
    let mut results = Vec::new();
    for (label, budget) in [("oldGuiDefault", old), ("boundedGuiPlan", bounded)] {
        std::env::set_var("HUB_OS_REPAIR_PREFLIGHT_ONLY", id);
        let returned = crate::agent_work::run_mode(&root, id, budget, true);
        std::env::remove_var("HUB_OS_REPAIR_PREFLIGHT_ONLY");
        let error = returned.err().unwrap();
        let state = crate::agent_work::ui(&root, &json!({"action":"status","id":id})).unwrap();
        if label == "oldGuiDefault" {
            assert!(error.contains("累计上限不一致"), "{error}");
        } else {
            assert!(error.contains("已保存材料预检诊断"), "{error}");
            assert_eq!(state["materialBudget"]["preflight"]["allowed"], true);
        }
        results.push(json!({"entry":label,"budget":budget,"error":error,"preflight":state["materialBudget"]["preflight"]}));
    }
    let c = crate::source_evidence::open_read_database(&root).unwrap();
    assert_eq!(before,c.query_row("SELECT count(*) FROM agent_records WHERE work_id=?1 AND kind IN ('nativeRuntime','providerBudgetReservation')",[id],|r|r.get::<_,i64>(0)).unwrap());
    std::fs::write(
        out.join("admission-proof.json"),
        serde_json::to_vec_pretty(
            &json!({"results":results,"providerRuns":0,"originalProfileMutated":false}),
        )
        .unwrap(),
    )
    .unwrap();
}

#[test]
#[ignore = "prepare one existing Work for bounded native UI verification; zero model calls"]
fn prepare_native_gui_copy_once() {
    assert_eq!(std::env::var("HUB_V3_CLOSEOUT_PREPARE").unwrap(), "1");
    let base = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .canonicalize()
        .unwrap();
    let out = base.join("artifacts/architecture-v3-closeout-20261027");
    let read = |p: std::path::PathBuf| -> Value {
        serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap()
    };
    let contract = read(out.join("contract.json"));
    let root = std::path::PathBuf::from(contract["activeValidationProfile"].as_str().unwrap());
    let id = contract["sourceWorkId"].as_str().unwrap();
    assert!(root
        .canonicalize()
        .unwrap()
        .starts_with(base.join(".local")));
    assert_eq!(id, "work-ygzNlDPVgd95DWCe22jmNW93");
    assert!(!out.join("gui-ready.json").exists());
    assert_eq!(read(out.join("admission-proof.json"))["providerRuns"], 0);
    let before = crate::agent_work::ui(&root, &json!({"action":"status","id":id})).unwrap();
    assert_eq!(before["work"]["revision"], 2);
    assert_eq!(before["work"]["authorizationVersion"], 1);
    assert_eq!(
        before["lifecycle"]["providerBudget"]["chargedOrReserved"],
        contract["oldChargedOrReserved"]
    );
    crate::agent_work::ui(&root,&json!({"action":"extendProviderBudget","id":id,"operationId":"v3-closeout-ui-two-runs","reason":"prospective native stop/reopen/explicit fresh-context recovery qualification, at most2 sessions, preserve old unknown and all old failures; not original compaction or M2 rerun","expectedWorkRevision":2,"expectedAuthorizationVersion":1,"expectedLimits":contract["oldLimits"],"limits":contract["futureLimits"]})).unwrap();
    crate::agent_work::ui(&root,&json!({"action":"message","id":id,"clientMessageId":"v3-closeout-ui-recovery-20261027","expectedRevision":2,"text":"合成原生界面恢复验收输入，由AI依据本次用户授权生成，不冒充人类确认数据。沿用当前合成笔记和同一事项，先调用goalState核对当前要求，再主动完整读取current原文。报告保留已确认的数量、负责人、截止日期及验收条件未确认，并新增单独一行：缺失信息：验收条件尚未明确。若本轮被停止，保留已完成工作和历史，只在明确继续后完成未交付部分；新上下文可以重新核验必要原文，不能新建事项、清零预算、重复发布已完成报告。给出逐字出处，不请求压缩，不新建任务树，不修改来源或进行业务动作。"})).unwrap();
    let c = crate::source_evidence::open_read_database(&root).unwrap();
    let previous = store::material_budget::load_on(&c, id).unwrap().unwrap();
    let mut plan = previous.clone();
    plan.work_revision = 3;
    drop(c);
    crate::agent_work::ui(
        &root,
        &json!({"action":"freezeMaterialPlan","id":id,"expectedPlan":previous,"plan":plan}),
    )
    .unwrap();
    let state = crate::agent_work::ui(&root, &json!({"action":"status","id":id})).unwrap();
    assert_eq!(state["work"]["revision"], 3);
    assert_eq!(state["work"]["state"], "ready");
    assert_eq!(state["lifecycle"]["providerBudget"]["canAdmitRun"], true);
    std::fs::write(
        out.join("gui-ready.json"),
        serde_json::to_vec_pretty(&state).unwrap(),
    )
    .unwrap();
}
