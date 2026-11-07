use super::*;
use crate::agent_work::{
    artifacts, assistant,
    tests::{claim, create},
    ui,
};
use crate::source_evidence::tests::Fixture;

fn setup() -> (Fixture, Work, String) {
    let f = Fixture::new();
    f.note("notes", "current", "# 2025-01-01\n学习 学习");
    let id = create(&f, true);
    let (w, r) = claim(&f, &id);
    (f, w, r)
}
fn command(f: &Fixture, id: &str, action: &str, key: &str) -> Value {
    let s = view(&f.root, id).unwrap();
    json!({"action":action,"id":id,"commandId":key,"expectedControlRevision":s["lifecycle"]["controlRevision"],
        "expectedWorkRevision":s["work"]["revision"],"expectedRunId":s["lifecycle"]["activeRunId"]})
}
fn dispatch(f: &Fixture, w: &Work, r: &str, request: Value) -> Result<Value, String> {
    assistant::Session {
        root: &f.root,
        work: w,
        run: r,
        control: &Control::default(),
        operation: None,
        selection: Value::Null,
        app: None,
    }
    .dispatch(serde_json::from_value(request).unwrap())
}
fn done_task(f: &Fixture, w: &Work, r: &str) {
    let s = dispatch(
        f,
        w,
        r,
        json!({"operation":"task","request":{"action":"read"}}),
    )
    .unwrap();
    dispatch(f,w,r,json!({"operation":"task","request":{"action":"patch","operationId":"done",
        "expectedGoalBinding":s["goalBinding"],"expectedTaskRevision":s["revision"],"sourceCommandId":s["sourceCommandId"],"remove":[],
        "upsert":[{"taskId":"answer","parentId":null,"requirementRefs":[format!("{}-goal",w.id)],"criterion":"核对回答",
        "dependencies":[],"requiredResult":"response","status":"done","proofIds":[],"review":"已经核对","blocker":null}]}})).unwrap();
}
fn answer() -> runner::Report {
    serde_json::from_value(json!({"status":"completed","summary":"历史回答","findings":[],"nextSteps":[],"questions":[],"limitations":[],"waitCondition":""})).unwrap()
}

#[test]
fn completion_winning_race_keeps_real_delivery_after_user_cancels_goal() {
    let (f, w, r) = setup();
    let stale = command(&f, &w.id, "cancel", "late-stop");
    publish(
        &f.root,
        &w,
        &r,
        &answer(),
        &[],
        &[],
        &json!([]),
        &Value::Null,
        &Control::default(),
    )
    .unwrap();
    assert!(stop(&f.root, &w.id, &stale, false).is_err());
    let completed = view(&f.root, &w.id).unwrap();
    assert_eq!(completed["run"]["state"], "completed");
    let cancelled = ui(
        &f.root,
        &command(&f, &w.id, "cancelGoal", "cancel-after-completion"),
    )
    .unwrap();
    assert_eq!(cancelled["run"]["state"], "completed");
    assert_eq!(cancelled["goalAssessment"]["workFulfillment"], "cancelled");
    assert_eq!(records(&f.root, &w.id, "delivery", 10).unwrap().len(), 1);
    assert!(cancelled["conversation"]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["report"]["summary"] == "历史回答"));
}

#[test]
fn stop_resume_is_idempotent_and_old_generation_cannot_publish_or_mutate() {
    let (f, w, r) = setup();
    done_task(&f, &w, &r);
    usage(&f.root, &r, &json!({"toolSteps":3,"modelCalls":2})).unwrap();
    let before = view(&f.root, &w.id).unwrap();
    let stop_cmd = command(&f, &w.id, "cancel", "stop");
    assert!(stop(&f.root, &w.id, &stop_cmd, false).unwrap());
    assert!(!stop(&f.root, &w.id, &stop_cmd, false).unwrap());
    let paused = view(&f.root, &w.id).unwrap();
    assert_eq!(paused["work"]["state"], "paused");
    assert_eq!(paused["taskTree"], before["taskTree"]);
    assert_eq!(paused["work"]["revision"], before["work"]["revision"]);
    assert!(claim_on(&f.c(), &w.id, "bypass").is_err());
    assert!(dispatch(&f, &w, &r, json!({"operation":"goalState"})).is_err());
    let resume_cmd = command(&f, &w.id, "resume", "resume");
    let next = resume(&f.root, &w.id, "next", &resume_cmd)
        .unwrap()
        .unwrap();
    assert!(resume(&f.root, &w.id, "duplicate", &resume_cmd)
        .unwrap()
        .is_none());
    assert!(!stop(&f.root, &w.id, &stop_cmd, false).unwrap());
    let mut stale = stop_cmd.clone();
    stale["commandId"] = json!("stale");
    assert!(stop(&f.root, &w.id, &stale, false)
        .unwrap_err()
        .contains("变化"));
    let mut conflict = resume_cmd.clone();
    conflict["mode"] = json!("deep");
    assert!(resume(&f.root, &w.id, "conflict", &conflict)
        .err()
        .unwrap()
        .contains("身份"));
    fail(&f.root, &w, &r, "旧运行迟到失败").unwrap();
    assert!(publish(
        &f.root,
        &w,
        &r,
        &answer(),
        &[],
        &[],
        &json!([]),
        &Value::Null,
        &Control::default()
    )
    .is_err());
    assert!(record(&f.root, &r, "late", &json!({})).is_err());
    let current = view(&f.root, &w.id).unwrap();
    assert_eq!(current["lifecycle"]["activeRunId"], "next");
    assert_eq!(current["lifecycle"]["runsUsed"], 2);
    assert_eq!(current["lifecycle"]["recordedUsage"]["toolSteps"], 3);
    assert_eq!(current["taskTree"], before["taskTree"]);
    assert_eq!(next.authorization_version, w.authorization_version);
    let old: String = f
        .c()
        .query_row("SELECT state FROM agent_runs WHERE id=?1", [&r], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(old, "aborted");
}

#[test]
fn user_cancel_is_distinct_from_fulfillment_and_append_does_not_resume() {
    let (f, w, r) = setup();
    done_task(&f, &w, &r);
    let cmd = command(&f, &w.id, "cancelGoal", "cancel-goal");
    let cancelled = ui(&f.root, &cmd).unwrap();
    assert_eq!(cancelled["goalAssessment"]["workFulfillment"], "cancelled");
    assert_eq!(cancelled["taskTree"]["tasks"][0]["status"], "done");
    let appended=ui(&f.root,&json!({"action":"message","id":w.id,"text":"恢复时补充说明局限","clientMessageId":"append"})).unwrap();
    assert_eq!(appended["work"]["state"], "cancelled");
    assert_eq!(appended["taskTree"]["tasks"][0]["status"], "pending");
    assert_eq!(appended["lifecycle"]["runsUsed"], 1);
    assert!(ui(&f.root, &json!({"action":"respond","id":w.id})).is_err());
    let cmd = command(&f, &w.id, "resume", "resume-cancelled");
    resume(&f.root, &w.id, "recovered", &cmd).unwrap().unwrap();
    let recovered = view(&f.root, &w.id).unwrap();
    assert_eq!(recovered["goalAssessment"]["workFulfillment"], "partial");
    assert_eq!(recovered["work"]["id"], w.id);
    if let Ok(path) = std::env::var("HUB_LIFECYCLE_VIEW") {
        std::fs::write(
            path,
            serde_json::to_vec_pretty(
                &json!({"cancelled":cancelled,"appended":appended,"recovered":recovered}),
            )
            .unwrap(),
        )
        .unwrap();
    }
}

#[test]
fn ui_stop_persists_before_signal_and_does_not_claim_tools_already_stopped() {
    let (f, w, r) = setup();
    let control = Control::default();
    let key = (crate::agent_work::root_key(&f.root), w.id.clone());
    crate::agent_work::active().lock().unwrap().insert(
        key.clone(),
        crate::agent_work::Active {
            run_id: r.clone(),
            control: control.clone(),
            is_action: false,
        },
    );
    let running = crate::agent_work::Running(key);
    let cmd = command(&f, &w.id, "cancel", "ui-stop");
    let stopping = ui(&f.root, &cmd).unwrap();
    assert!(control.check().is_err());
    assert_eq!(stopping["lifecycle"]["state"], "stopping");
    assert_eq!(stopping["lifecycle"]["canResume"], false);
    assert!(ui(&f.root, &command(&f, &w.id, "resume", "too-soon")).is_err());
    drop(running);
    let paused = ui(&f.root, &json!({"action":"status","id":w.id})).unwrap();
    assert_eq!(paused["lifecycle"]["state"], "paused");
    assert_eq!(paused["lifecycle"]["canResume"], true);
    assert_eq!(paused["run"]["state"], "aborted");
}

#[test]
fn failed_control_commit_does_not_cancel_live_owner_or_change_state() {
    let (f, w, r) = setup();
    let control = Control::default();
    let key = (crate::agent_work::root_key(&f.root), w.id.clone());
    crate::agent_work::active().lock().unwrap().insert(
        key.clone(),
        crate::agent_work::Active {
            run_id: r.clone(),
            control: control.clone(),
            is_action: false,
        },
    );
    let _running = crate::agent_work::Running(key);
    let cmd = command(&f, &w.id, "cancel", "disk-failure");
    f.c().execute_batch("CREATE TRIGGER fail_control BEFORE INSERT ON agent_records WHEN NEW.kind='lifecycleCommand' BEGIN SELECT RAISE(ABORT,'injected storage failure'); END").unwrap();
    assert!(ui(&f.root, &cmd).is_err());
    assert!(control.check().is_ok());
    assert_eq!(load(&f.c(), &w.id).unwrap().active_run, Some(r));
    assert_eq!(load(&f.c(), &w.id).unwrap().state, "investigating");
    assert!(records(&f.root, &w.id, "lifecycleCommand", 1)
        .unwrap()
        .is_empty());
}

#[test]
fn recovery_rejects_missing_source_revocation_and_run_limit_without_losing_history() {
    let (f, w, r) = setup();
    stop(&f.root, &w.id, &command(&f, &w.id, "cancel", "stop"), false).unwrap();
    let cmd = command(&f, &w.id, "resume", "resume");
    f.c()
        .execute(
            "DELETE FROM documents WHERE id='current' AND space_id='notes'",
            [],
        )
        .unwrap();
    assert!(resume(&f.root, &w.id, "missing", &cmd).is_err());
    assert_eq!(load(&f.c(), &w.id).unwrap().state, "paused");
    f.note("notes", "current", "恢复的材料");
    // Fault injection: a retained Work with nineteen other completed attempts.
    for n in 1..20 {
        f.c().execute("INSERT INTO agent_runs(id,work_id,base_revision,authorization_version,state,started_at) VALUES(?1,?2,1,1,'completed',1)",params![format!("past-{n}"),w.id]).unwrap();
    }
    let limit = command(&f, &w.id, "resume", "limit");
    assert!(resume(&f.root, &w.id, "over-limit", &limit)
        .err()
        .unwrap()
        .contains("20"));
    assert_eq!(
        view_on(&f.c(), &load(&f.c(), &w.id).unwrap()).unwrap()["runsUsed"],
        20
    );
    revoke(&f.root, &w.id).unwrap();
    assert!(resume(
        &f.root,
        &w.id,
        "revoked",
        &command(&f, &w.id, "resume", "revoked")
    )
    .err()
    .unwrap()
    .contains("授权"));
    assert!(records(&f.root, &w.id, "lifecycleCommand", 10)
        .unwrap()
        .iter()
        .all(|v| v["payload"]["kind"] != "resume"));
    assert!(!r.is_empty());
}

#[test]
fn cancelled_work_preserves_chart_and_recovery_revalidates_source_dependencies() {
    let (f, w, r) = setup();
    let snapshot = crate::source_evidence::analysis::execute(
        &w.grant.reader(&f.root).unwrap(),
        "hub_create_analysis_snapshot",
        &json!({}),
    )
    .unwrap();
    let chart=artifacts::execute(&f.root,&w,&r,&json!({"action":"create","operationId":"chart",
        "analysis":{"expectedSnapshot":snapshot["snapshot"],"unit":"day","groupBy":"month","terms":["学习"]},
        "spec":{"title":"学习次数","mark":"bar","metric":"occurrences","term":"学习","sort":"groupAsc"}}),&Control::default()).unwrap();
    artifacts::execute(
        &f.root,
        &w,
        &r,
        &json!({"action":"validate","artifactId":chart["artifactId"],"revision":1}),
        &Control::default(),
    )
    .unwrap();
    let before = view(&f.root, &w.id).unwrap()["analysisArtifacts"].clone();
    stop(
        &f.root,
        &w.id,
        &command(&f, &w.id, "cancelGoal", "cancel"),
        true,
    )
    .unwrap();
    assert_eq!(view(&f.root, &w.id).unwrap()["analysisArtifacts"], before);
    let next = resume(
        &f.root,
        &w.id,
        "next",
        &command(&f, &w.id, "resume", "resume"),
    )
    .unwrap()
    .unwrap();
    assert_eq!(view(&f.root, &w.id).unwrap()["analysisArtifacts"], before);
    assert!(artifacts::execute(
        &f.root,
        &w,
        &r,
        &json!({"action":"validate","artifactId":chart["artifactId"],"revision":1}),
        &Control::default()
    )
    .is_err());
    f.c()
        .execute(
            "DELETE FROM documents WHERE id='current' AND space_id='notes'",
            [],
        )
        .unwrap();
    assert!(artifacts::execute(
        &f.root,
        &next,
        "next",
        &json!({"action":"validate","artifactId":chart["artifactId"],"revision":1}),
        &Control::default()
    )
    .is_err());
}
