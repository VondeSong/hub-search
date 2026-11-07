use super::*;
use crate::agent_work::{
    assistant,
    tests::{claim, create},
    ui,
};
use crate::source_evidence::tests::Fixture;

fn setup() -> (Fixture, Work, String) {
    let f = Fixture::new();
    f.note(
        "notes",
        "current",
        "真实合成来源：原始数值为3，需要保留口径。",
    );
    let id = create(&f, false);
    let (w, r) = claim(&f, &id);
    (f, w, r)
}
fn read_state(f: &Fixture, w: &Work, r: &str) -> Value {
    execute(
        &f.root,
        w,
        r,
        &json!({"action":"read"}),
        &Control::default(),
    )
    .unwrap()
}
fn patch(f: &Fixture, w: &Work, r: &str, op: &str) -> Value {
    let current = read_state(f, w, r);
    json!({"action":"patch","operationId":op,"expectedRevision":current["revision"],"expectedGoalBinding":current["goalBinding"],"upsert":[],"remove":[],"pendingTargets":null,"unresolvedQuestions":null})
}
fn proposed(id: &str) -> Value {
    json!({"entryId":id,"kind":"conclusion","value":"待核对，不冒充宿主证实","status":"proposed","evidenceRefs":[],"metric":null})
}
fn source(f: &Fixture, w: &Work, r: &str) -> Value {
    let request = json!({"operation":"read","locator":w.anchor,"startChar":0,"maxChars":200,"expectedVersion":null,"stepId":"actual-read"});
    record(&f.root, r, "toolCall", &request).unwrap();
    let excerpt = w
        .grant
        .reader(&f.root)
        .unwrap()
        .read(w.anchor.as_ref().unwrap(), 0, 200, None)
        .unwrap();
    let reference = super::super::tool_results::capture(
        &f.root,
        &w.id,
        r,
        &request,
        &json!({"evidenceId":"e1","excerpt":excerpt}),
    )
    .unwrap();
    json!({"recordId":reference["recordId"],"sha256":reference["sha256"]})
}
fn apply(f: &Fixture, w: &Work, r: &str, request: &Value) -> Result<Value, String> {
    execute(&f.root, w, r, request, &Control::default())
}
fn facts(f: &Fixture) -> (i64, i64, i64) {
    f.c().query_row("SELECT (SELECT count(*) FROM agent_records WHERE kind='workingState'),(SELECT count(*) FROM agent_records WHERE kind='modelExecution'),(SELECT count(*) FROM agent_actions)",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap()
}

#[test]
fn working_state_persists_observation_and_projects_existing_goal_task_owners_after_reopen() {
    let (f, w, r) = setup();
    let reference = source(&f, &w, &r);
    let before_goal = w.goal.clone();
    let before_grant = json!(w.grant);
    let mut request = patch(&f, &w, &r, "save-one");
    request["upsert"] = json!([{"entryId":"observed","kind":"observation","value":"来源记载3，仍须核对统计范围","status":"observed","evidenceRefs":[reference],"metric":null}]);
    request["unresolvedQuestions"] = json!(["这条数据覆盖哪个时间范围？"]);
    let saved = apply(&f, &w, &r, &request).unwrap();
    assert_eq!(saved["saved"], true);
    assert_eq!(saved["revision"], 1);
    let sequence: i64 = saved["sequence"].as_str().unwrap().parse().unwrap();
    assert!(sequence > 0);
    let event = update_event(&w, &r, &saved);
    assert_eq!(event["workId"], w.id);
    assert_eq!(event["runId"], r);
    assert_eq!(event["revision"], 1);
    assert_eq!(event["sequence"], saved["sequence"]);
    assert_eq!(event["eventCategory"], "state");
    assert_eq!(event["publicHasText"], false);
    assert_eq!(event["authorizationVersion"], w.authorization_version);
    let reopened = read_state(&f, &w, &r);
    assert_eq!(reopened["revision"], 1);
    assert_eq!(reopened["entries"][0]["status"], "observed");
    assert_eq!(reopened["entries"][0]["hostSemanticValidation"], false);
    assert_eq!(reopened["grantsAuthority"], false);
    assert_eq!(
        reopened["entries"][0]["sourceRevisions"][0]["sourceRevisions"][0]["locator"],
        json!(w.anchor)
    );
    assert_eq!(
        reopened["currentGoal"],
        goal::revisions::view_on(&f.c(), &w).unwrap()
    );
    assert_eq!(
        reopened["checklist"],
        tasks::view_on(&f.root, &f.c(), &w).unwrap()
    );
    let after = load(&f.c(), &w.id).unwrap();
    assert_eq!(after.goal, before_goal);
    assert_eq!(json!(after.grant), before_grant);
    assert_eq!(facts(&f), (1, 0, 0));
    let control = Control::default();
    let session = assistant::Session {
        root: &f.root,
        work: &w,
        run: &r,
        control: &control,
        operation: None,
        selection: Value::Null,
        app: None,
    };
    assert_eq!(
        session
            .dispatch_for_capture(
                serde_json::from_value(
                    json!({"operation":"workingState","request":{"action":"read"}})
                )
                .unwrap()
            )
            .unwrap()["revision"],
        1
    );
    assert_eq!(
        session.capabilities().unwrap()["workingState"]["revision"],
        1
    );
}

#[test]
fn working_state_operation_replay_conflict_and_stale_goal_preserve_all_saved_facts() {
    let (f, w, r) = setup();
    let mut request = patch(&f, &w, &r, "once");
    request["upsert"] = json!([proposed("first")]);
    apply(&f, &w, &r, &request).unwrap();
    assert_eq!(apply(&f, &w, &r, &request).unwrap()["replayed"], true);
    assert_eq!(facts(&f), (1, 0, 0));
    let mut collision = request.clone();
    collision["upsert"][0]["value"] = json!("different");
    assert!(apply(&f, &w, &r, &collision)
        .unwrap_err()
        .contains("不同内容"));
    let mut stale = request.clone();
    stale["operationId"] = json!("stale-revision");
    assert!(apply(&f, &w, &r, &stale).unwrap_err().contains("版本冲突"));
    let mut bad = patch(&f, &w, &r, "stale-goal");
    bad["expectedGoalBinding"]["workRevision"] = json!(w.revision + 1);
    assert!(apply(&f, &w, &r, &bad).is_err());
    assert_eq!(
        read_state(&f, &w, &r)["entries"][0]["value"],
        "待核对，不冒充宿主证实"
    );
    assert_eq!(facts(&f), (1, 0, 0));
}

#[test]
fn working_state_source_change_and_new_user_goal_hide_stale_text_without_erasing_history() {
    let (f, w, r) = setup();
    let reference = source(&f, &w, &r);
    let mut request = patch(&f, &w, &r, "dependent");
    request["upsert"] = json!([{"entryId":"value","kind":"observation","value":"OLD_SECRET_WORKING_NOTE","status":"observed","evidenceRefs":[reference],"metric":null}]);
    request["unresolvedQuestions"] = json!(["OLD_UNRESOLVED_QUESTION"]);
    apply(&f, &w, &r, &request).unwrap();
    f.note("notes", "current", "changed actual source");
    let changed = read_state(&f, &w, &r);
    assert_eq!(changed["entries"][0]["status"], "stale");
    assert!(changed["entries"][0]["value"].is_null());
    assert_eq!(changed["entries"][0]["evidenceRefs"], json!([]));
    super::super::reconcile(&f.root, &w.id, None).unwrap();
    ui(&f.root,&json!({"action":"message","id":w.id,"text":"新的用户要求，原目标保留","clientMessageId":"real-followup"})).unwrap();
    let current = load(&f.c(), &w.id).unwrap();
    let view = view_on(&f.root, &f.c(), &current).unwrap();
    assert_eq!(view["questionsNeedReview"], true);
    assert_eq!(view["unresolvedQuestions"], json!([]));
    assert!(!view.to_string().contains("OLD_SECRET_WORKING_NOTE"));
    assert_eq!(facts(&f), (1, 0, 0));
    assert!(records(&f.root, &w.id, "workingState", 1).unwrap()[0]
        .to_string()
        .contains("OLD_SECRET_WORKING_NOTE"));
}

#[test]
fn working_state_transaction_failure_does_not_create_a_saved_event_or_modify_prior_notes() {
    let (f, w, r) = setup();
    let mut first = patch(&f, &w, &r, "old");
    first["upsert"] = json!([proposed("old")]);
    apply(&f, &w, &r, &first).unwrap();
    let before = read_state(&f, &w, &r);
    let mut next = patch(&f, &w, &r, "failed");
    next["upsert"] = json!([proposed("new")]);
    f.c().execute_batch("CREATE TRIGGER fail_working_state BEFORE INSERT ON agent_records WHEN NEW.kind='workingState' BEGIN SELECT RAISE(ABORT,'working-state disk commit abort'); END;").unwrap();
    assert!(apply(&f, &w, &r, &next)
        .unwrap_err()
        .contains("working-state disk commit abort"));
    assert_eq!(read_state(&f, &w, &r), before);
    assert_eq!(facts(&f), (1, 0, 0));
    let activity = crate::agent_work::activity::read_on(&f.root, &f.c(), &w).unwrap();
    assert_eq!(
        activity[0]["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["origin"] == "hub-working-state")
            .count(),
        1
    );
    // Transaction abort is not evidence of physical disk exhaustion.
}

#[test]
fn working_state_statistics_need_explicit_context_and_notes_cannot_claim_validation_or_authority() {
    let (f, w, r) = setup();
    let mut request = patch(&f, &w, &r, "invalid");
    let mut note = proposed("invalid");
    note["status"] = json!("validated");
    request["upsert"] = json!([note]);
    assert!(apply(&f, &w, &r, &request).is_err());
    request["upsert"][0]["status"] = json!("observed");
    assert!(apply(&f, &w, &r, &request)
        .unwrap_err()
        .contains("缺少实际工具结果引用"));
    request["upsert"][0]["status"] = json!("proposed");
    request["upsert"][0]["kind"] = json!("statistic");
    assert!(apply(&f, &w, &r, &request)
        .unwrap_err()
        .contains("缺少指标"));
    request["upsert"][0]["metric"] = json!({"metric":"次数","unit":"次","filters":["仅授权来源"],"timeBasis":"记录日","coverage":"仅一份合成资料"});
    assert!(apply(&f, &w, &r, &request).is_ok());
    let mut invented = patch(&f, &w, &r, "not-allowed");
    invented["currentGoal"] = json!("delete user goal");
    assert!(apply(&f, &w, &r, &invented).is_err());
    assert_eq!(load(&f.c(), &w.id).unwrap().goal, w.goal);
    assert_eq!(facts(&f), (1, 0, 0));
}

#[test]
fn working_state_capacity_cross_work_refs_and_unknown_versions_fail_without_erasing_old_records() {
    let (f, w, r) = setup();
    let reference = source(&f, &w, &r);
    let other = create(&f, false);
    let (other, other_run) = claim(&f, &other);
    let mut cross = patch(&f, &other, &other_run, "cross-work");
    cross["upsert"] = json!([{"entryId":"cross","kind":"observation","value":"cannot read foreign","status":"observed","evidenceRefs":[reference],"metric":null}]);
    assert!(apply(&f, &other, &other_run, &cross).is_err());
    let mut many = patch(&f, &w, &r, "full");
    many["upsert"] = json!((0..12)
        .map(|n| proposed(&format!("entry{n}")))
        .collect::<Vec<_>>());
    apply(&f, &w, &r, &many).unwrap();
    let mut excess = patch(&f, &w, &r, "thirteenth");
    excess["upsert"] = json!([proposed("thirteenth")]);
    assert!(apply(&f, &w, &r, &excess)
        .unwrap_err()
        .contains("最多保留12条"));
    let mut huge = patch(&f, &w, &r, "huge");
    huge["unresolvedQuestions"] = json!(["x".repeat(32768)]);
    assert!(apply(&f, &w, &r, &huge)
        .unwrap_err()
        .contains("补丁超过容量"));
    f.c().execute("UPDATE agent_records SET body_json=json_set(body_json,'$.state.schemaVersion',99) WHERE work_id=?1 AND kind='workingState'",[&w.id]).unwrap();
    assert!(for_run(&f.root, &w, &r)
        .unwrap_err()
        .contains("版本或容量不支持"));
    let view = super::super::view(&f.root, &w.id).unwrap();
    assert_eq!(view["workingState"]["state"], "unavailable");
    assert_eq!(view["work"]["goal"], w.goal);
    assert_eq!(facts(&f), (1, 0, 0));
}

#[test]
fn working_state_pending_targets_use_existing_owned_actions_without_confirmation_or_execution() {
    let (f, w, r) = setup();
    let other = create(&f, false);
    for (id, owner) in [
        ("owned-action", w.id.as_str()),
        ("foreign-action", other.as_str()),
    ] {
        // Explicit synthetic action rows for reference ownership only; no
        // confirmation token, receipt, source write or model generation.
        f.c().execute("INSERT INTO agent_actions(id,work_id,kind,base_revision,authorization_version,state,payload_json,context_hash,created_at,updated_at) VALUES(?1,?2,'obsidianEdit',1,1,'prepared',NULL,'synthetic-reference-only',1,1)",params![id,owner]).unwrap();
    }
    let mut request = patch(&f, &w, &r, "owned");
    request["pendingTargets"] = json!(["owned-action"]);
    let result = apply(&f, &w, &r, &request).unwrap();
    assert_eq!(result["pendingTargets"][0]["state"], "prepared");
    assert_eq!(result["pendingTargets"][0]["executedByNote"], false);
    let mut foreign = patch(&f, &w, &r, "foreign");
    foreign["pendingTargets"] = json!(["foreign-action"]);
    assert!(apply(&f, &w, &r, &foreign).is_err());
    let rows: i64 = f
        .c()
        .query_row(
            "SELECT count(*) FROM agent_actions WHERE state='prepared' AND receipt_json IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(rows, 2);
    assert_eq!(facts(&f), (1, 0, 2));
}

#[test]
fn working_state_stopped_run_cannot_update_working_notes_or_recover_authority() {
    let (f, w, r) = setup();
    let mut request = patch(&f, &w, &r, "after-stop");
    request["upsert"] = json!([proposed("blocked")]);
    super::super::reconcile(&f.root, &w.id, None).unwrap();
    assert!(apply(&f, &w, &r, &request).is_err());
    assert_eq!(facts(&f), (0, 0, 0));
    super::super::revoke(&f.root, &w.id).unwrap();
    let current = load(&f.c(), &w.id).unwrap();
    let view = view_on(&f.root, &f.c(), &current).unwrap();
    assert_eq!(view["entries"], json!([]));
    assert_eq!(view["pendingTargets"], json!([]));
    assert_eq!(view["grantsAuthority"], false);
}
