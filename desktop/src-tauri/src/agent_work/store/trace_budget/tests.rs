use super::*;
use crate::agent_work::{tests::create, ui};
use crate::source_evidence::tests::Fixture;
fn setup() -> (Fixture, String) {
    let f = Fixture::new();
    f.note("notes", "current", "连续运行合成来源，不修改");
    let id = create(&f, true);
    (f, id)
}
fn usage() -> Value {
    json!({"modelCalls":0,"modelRetries":0,"outputRepairs":0,"toolSteps":0,"requestBytes":0,"bodyChars":0,"entitiesRead":0,"summaries":0,"elapsedMs":1})
}

#[test]
fn same_work_twenty_one_runs_keep_original_reports_scope_and_cumulative_budget() {
    let (f, id) = setup();
    let b = Budget::mode("quick").unwrap();
    let initial = load(&f.c(), &id).unwrap();
    let before_source = initial
        .grant
        .reader(&f.root)
        .unwrap()
        .read(initial.anchor.as_ref().unwrap(), 0, 100, None)
        .unwrap();
    for n in 1..=21 {
        let run = format!("continuity-{n}");
        let w = super::super::claim_with_budget(&f.root, &id, &run, b).unwrap();
        let report=serde_json::from_value(json!({"status":"needsDecision","summary":format!("第{n}份独立保留的合成结果"),"findings":[],"nextSteps":[],"questions":["仅确定性检查"],"limitations":["不计模型质量"],"waitCondition":""})).unwrap();
        super::super::publish(
            &f.root,
            &w,
            &run,
            &report,
            &[],
            &[],
            &json!([]),
            &Value::Null,
            &Control::default(),
        )
        .unwrap();
        super::super::execution_budget::settle(&f.root, &w, &run, &usage()).unwrap();
    }
    let s = ui(&f.root, &json!({"action":"status","id":id})).unwrap();
    let after = load(&f.c(), &id).unwrap();
    assert_eq!(s["lifecycle"]["runsUsed"], 21);
    assert_eq!(s["lifecycle"]["runLimit"], Value::Null);
    assert_eq!(s["lifecycle"]["traceBudget"]["canAdmitRun"], true);
    assert_eq!(after.id, initial.id);
    assert_eq!(after.goal, initial.goal);
    assert_eq!(json!(after.grant), json!(initial.grant));
    let history = s.to_string();
    assert!(history.contains("第1份独立保留"));
    assert!(history.contains("第11份独立保留"));
    assert!(history.contains("第21份独立保留"));
    assert_eq!(
        super::super::records(&f.root, &id, "delivery", 64)
            .unwrap()
            .len(),
        21
    );
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
    assert_eq!(
        s["lifecycle"]["executionBudget"]["unsettledRunIds"],
        json!([])
    );
    if let Ok(out) = std::env::var("HUB_TRACE_CONTINUITY_OUT") {
        std::fs::write(out,serde_json::to_vec_pretty(&json!({"runs":21,"sameWork":true,"oldestMiddleLatestReadable":true,"models":0,"actions":0,"traceBudget":s["lifecycle"]["traceBudget"],"executionBudget":s["lifecycle"]["executionBudget"]})).unwrap()).unwrap();
    }
    let after_source = after
        .grant
        .reader(&f.root)
        .unwrap()
        .read(after.anchor.as_ref().unwrap(), 0, 100, None)
        .unwrap();
    assert_eq!(json!(before_source), json!(after_source));
}

#[test]
fn payload_exhaustion_refuses_next_run_and_keeps_control_space_and_old_delivery() {
    let (f, id) = setup();
    let b = Budget::mode("quick").unwrap();
    let w = super::super::claim_with_budget(&f.root, &id, "first", b).unwrap();
    let report=serde_json::from_value(json!({"status":"needsDecision","summary":"容量不足后仍可读取的旧成果","findings":[],"nextSteps":[],"questions":["确定性检查"],"limitations":[],"waitCondition":""})).unwrap();
    super::super::publish(
        &f.root,
        &w,
        "first",
        &report,
        &[],
        &[],
        &json!([]),
        &Value::Null,
        &Control::default(),
    )
    .unwrap();
    let deliveries = super::super::records(&f.root, &id, "delivery", 64).unwrap();
    let policy = super::super::records(&f.root, &id, "traceResourcePolicy", 1).unwrap();
    // Storage boundary fault fixture: existing opaque payloads occupy the quota.
    // This is serialized-byte exhaustion, not physical disk-full coverage.
    let c = f.c();
    let payload = json!({"saved":"x".repeat(64000)}).to_string();
    for n in 0..320 {
        c.execute("INSERT INTO agent_records(id,work_id,kind,body_json,created_at) VALUES(?1,?2,'savedTrace',?3,1)",params![format!("capacity-{n}"),id,payload]).unwrap();
    }
    assert!(admission_on(&c, &id, 1).is_err());
    assert!(super::super::claim_with_budget(&f.root, &id, "denied", b).is_err());
    assert!(insert_on(&c, &id, "toolResult", 1_048_576).is_err());
    assert!(insert_on(&c, &id, "lifecycleCommand", 1000).is_ok());
    assert!(insert_on(&c, &id, "recoveryBudgetPolicy", 1000).is_ok());
    assert!(insert_on(&c, &id, "recoveryBudgetAttempt", 1000).is_ok());
    assert!(report_on(&c, &id, 1_048_576).is_err());
    assert_eq!(
        super::super::records(&f.root, &id, "delivery", 64).unwrap(),
        deliveries
    );
    assert!(ui(&f.root, &json!({"action":"status","id":id}))
        .unwrap()
        .to_string()
        .contains("容量不足后仍可读取的旧成果"));
    assert_eq!(
        super::super::records(&f.root, &id, "traceResourcePolicy", 1).unwrap(),
        policy
    );
    assert_eq!(
        ui(&f.root, &json!({"action":"status","id":id})).unwrap()["lifecycle"]["runsUsed"],
        1
    );
}

#[test]
fn unmanaged_twentieth_run_requires_migration_without_suggesting_budget_reset() {
    let (f, id) = setup();
    let c = f.c();
    for n in 0..20 {
        c.execute("INSERT INTO agent_runs(id,work_id,base_revision,authorization_version,state,started_at) VALUES(?1,?2,1,1,'failed',1)",params![format!("legacy-{n}"),id]).unwrap();
    }
    let error =
        super::super::claim_with_budget(&f.root, &id, "denied", Budget::mode("quick").unwrap())
            .err()
            .unwrap();
    assert!(error.contains("不能新建事项绕过"));
    assert!(
        super::super::records(&f.root, &id, "executionBudgetPolicy", 1)
            .unwrap()
            .is_empty()
    );
}
