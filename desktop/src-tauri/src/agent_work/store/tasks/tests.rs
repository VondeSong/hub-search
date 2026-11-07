use super::*;
use crate::agent_work::{
    assistant,
    tests::{claim, create},
};
use crate::source_evidence::tests::Fixture;

#[test]
fn capacity_rejection_preserves_tree_and_leaves_room_for_invalidation_events() {
    let (f, w, r) = setup();
    let initial = state(&f, &w, &r);
    let steps = |offset: usize| {
        (offset..offset + 4)
            .map(|n| {
                let mut v = step(&w, &format!("task{n}"), "done", &[]);
                v["criterion"] = json!("c".repeat(900));
                v["review"] = json!("r".repeat(1900));
                v
            })
            .collect::<Vec<_>>()
    };
    let saved =
        dispatch(&f, &w, &r, request(&initial, "first-batch", steps(0))).unwrap()["state"].clone();
    assert!(
        dispatch(&f, &w, &r, request(&saved, "second-batch", steps(4)))
            .unwrap_err()
            .contains("容量")
    );
    assert_eq!(state(&f, &w, &r), saved);
    record(&f.root, &r, "nativeRuntime", &json!({"protocol":1})).unwrap();
    let cmd = json!({"text":"补充约束","clientMessageId":"capacity-steer","runId":r});
    conversation::steer(&f.root, &w.id, &cmd).unwrap();
    record(&f.root, &r, "steeringAccepted", &cmd).unwrap();
    let current = view(&f.root, &w.id).unwrap()["taskTree"].clone();
    assert!(current["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .all(|t| t["status"] == "pending"));
    assert_eq!(current["invalidations"].as_array().unwrap().len(), 4);
}

fn setup() -> (Fixture, Work, String) {
    let f = Fixture::new();
    f.note("notes", "current", "检查配合条件");
    let id = create(&f, false);
    let (work, run) = claim(&f, &id);
    (f, work, run)
}
fn dispatch(f: &Fixture, w: &Work, r: &str, v: Value) -> Result<Value, String> {
    assistant::Session {
        root: &f.root,
        work: w,
        run: r,
        control: &Control::default(),
        operation: None,
        selection: Value::Null,
        app: None,
    }
    .dispatch(serde_json::from_value(json!({"operation":"task","request":v})).unwrap())
}
fn state(f: &Fixture, w: &Work, r: &str) -> Value {
    dispatch(f, w, r, json!({"action":"read"})).unwrap()
}
fn step(w: &Work, id: &str, status: &str, deps: &[&str]) -> Value {
    json!({"taskId":id,"parentId":null,"requirementRefs":[format!("{}-goal",w.id)],"criterion":id,
        "dependencies":deps,"requiredResult":"response","status":status,"proofIds":[],"review":"已核对结果","blocker":null})
}
fn request(s: &Value, op: &str, steps: Vec<Value>) -> Value {
    json!({"action":"patch","operationId":op,"expectedGoalBinding":s["goalBinding"],"expectedTaskRevision":s["revision"],
        "sourceCommandId":s["sourceCommandId"],"upsert":steps,"remove":[]})
}
fn task<'a>(s: &'a Value, id: &str) -> &'a Value {
    s["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["taskId"] == id)
        .unwrap()
}
fn report(f: &Fixture, w: &Work, r: &str) -> runner::Report {
    let ctx = goal::completion::read_context(&f.root, w, r).unwrap();
    let items:Vec<_>=ctx["requirements"].as_array().unwrap().iter().map(|q|json!({"requirementId":q["requirementId"],"criterion":q["text"],
        "requiredResult":"response","status":"satisfied","explanation":"逐项核对回答","refs":[],"supersededBy":null})).collect();
    serde_json::from_value(json!({"status":"completed","summary":"已核对并说明条件","findings":[],"nextSteps":[],"questions":[],"limitations":[],"waitCondition":"",
        "completion":{"goalBinding":ctx["goalBinding"],"items":items}})).unwrap()
}

#[test]
fn task_tool_replays_operations_checks_cas_and_propagates_only_dependencies() {
    let (f, w, r) = setup();
    let s = state(&f, &w, &r);
    let initial = request(
        &s,
        "first",
        vec![
            step(&w, "a", "done", &[]),
            step(&w, "b", "done", &["a"]),
            step(&w, "c", "done", &["b"]),
            step(&w, "independent", "done", &[]),
        ],
    );
    let result = dispatch(&f, &w, &r, initial.clone()).unwrap();
    assert_eq!(result["committedRevision"], 1);
    assert_eq!(
        dispatch(&f, &w, &r, initial.clone()).unwrap()["replayed"],
        true
    );
    let mut bad = initial.clone();
    bad["upsert"][0]["criterion"] = json!("different");
    assert!(dispatch(&f, &w, &r, bad).unwrap_err().contains("身份"));
    let mut stale = initial.clone();
    stale["operationId"] = json!("stale");
    assert!(dispatch(&f, &w, &r, stale).unwrap_err().contains("版本"));
    let change = request(
        &result["state"],
        "change",
        vec![step(&w, "a", "pending", &[])],
    );
    let s = dispatch(&f, &w, &r, change).unwrap()["state"].clone();
    assert_eq!(task(&s, "b")["status"], "pending");
    assert_eq!(task(&s, "c")["status"], "pending");
    assert_eq!(task(&s, "independent")["status"], "done");
    assert_eq!(s["invalidations"].as_array().unwrap().len(), 2);
    assert!(!task(&s, "b")["completionEvidence"].is_null());
    let replay = dispatch(&f, &w, &r, initial).unwrap();
    assert_eq!(replay["committedRevision"], 1);
    assert_eq!(replay["state"], s);
    assert!(dispatch(
        &f,
        &w,
        &r,
        request(&s, "premature", vec![step(&w, "c", "done", &["b"])])
    )
    .is_err());
    let reopened = load(&f.c(), &w.id).unwrap();
    assert_eq!(state(&f, &reopened, &r), s);
    let restored = dispatch(
        &f,
        &w,
        &r,
        request(
            &s,
            "review",
            vec![
                step(&w, "a", "done", &[]),
                step(&w, "b", "done", &["a"]),
                step(&w, "c", "done", &["b"]),
            ],
        ),
    )
    .unwrap()["state"]
        .clone();
    assert_eq!(task(&restored, "c")["status"], "done");
    assert!(task(&restored, "c")["needsRevalidation"].is_null());
    let answer = report(&f, &w, &r);
    publish(
        &f.root,
        &w,
        &r,
        &answer,
        &[],
        &[],
        &crate::agent_work::actions::receipts(&f.root, &w.id).unwrap(),
        &Value::Null,
        &Control::default(),
    )
    .unwrap();
    let (next, next_run) = claim(&f, &w.id);
    assert_eq!(
        state(&f, &next, &next_run),
        restored,
        "Work-owned task state survives a new run"
    );
    assert!(
        dispatch(&f, &w, &r, json!({"action":"read"})).is_err(),
        "previous run cannot mutate or read through the tool"
    );
    let history = records(&f.root, &w.id, "taskTree", 20).unwrap();
    assert!(history.iter().any(|s| s["tree"]["invalidations"]
        .as_array()
        .is_some_and(|v| v.len() == 2)));
}

#[test]
fn task_graph_contract_rejects_cycles_dangling_removal_and_forged_facts_atomically() {
    let (f, w, r) = setup();
    let s = state(&f, &w, &r);
    let mut child = step(&w, "child", "pending", &["parent"]);
    child["parentId"] = json!("parent");
    assert!(dispatch(
        &f,
        &w,
        &r,
        request(
            &s,
            "cycle",
            vec![step(&w, "parent", "pending", &[]), child.clone()]
        )
    )
    .unwrap_err()
    .contains("循环"));
    child["dependencies"] = json!([]);
    assert!(dispatch(
        &f,
        &w,
        &r,
        request(
            &s,
            "parent-early",
            vec![step(&w, "parent", "done", &[]), child.clone()]
        )
    )
    .is_err());
    let s = dispatch(
        &f,
        &w,
        &r,
        request(&s, "valid", vec![step(&w, "parent", "pending", &[]), child]),
    )
    .unwrap()["state"]
        .clone();
    let mut remove = request(&s, "remove", vec![]);
    remove["remove"] = json!(["parent"]);
    assert!(dispatch(&f, &w, &r, remove).unwrap_err().contains("父任务"));
    for field in [
        "completionEvidence",
        "authorizationVersion",
        "needsRevalidation",
    ] {
        let mut bad = step(&w, "extra", "done", &[]);
        bad[field] = json!("forged");
        assert!(dispatch(&f, &w, &r, request(&s, field, vec![bad])).is_err());
    }
    for status in ["waiting_decision", "blocked"] {
        assert!(dispatch(
            &f,
            &w,
            &r,
            request(&s, status, vec![step(&w, "extra", status, &[])])
        )
        .is_err());
    }
    let mut bad = step(&w, "extra", "done", &[]);
    bad["requiredResult"] = json!("action");
    assert!(dispatch(&f, &w, &r, request(&s, "no-receipt", vec![bad]))
        .unwrap_err()
        .contains("真实成果"));
    assert_eq!(
        state(&f, &w, &r),
        s,
        "rejected patches must not mutate state"
    );
    let mut cancelled = step(&w, "parent", "cancelled", &[]);
    cancelled["review"] = json!("");
    let mut rm = request(&s, "delete-step", vec![cancelled]);
    rm["remove"] = json!(["child"]);
    dispatch(&f, &w, &r, rm).unwrap();
    assert_eq!(
        goal::completion::requirements_on(&f.c(), &w)
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn open_tasks_gate_fulfillment_and_changes_after_finish_reject_publication() {
    let (f, w, r) = setup();
    record(&f.root, &r, "nativeRuntime", &json!({"protocol":1})).unwrap();
    let answer = report(&f, &w, &r);
    assert_eq!(
        goal::completion::evaluate(&f.root, &f.c(), &w, &r, &answer).unwrap()["workFulfillment"],
        "fulfilled"
    );
    let s = state(&f, &w, &r);
    let s = dispatch(
        &f,
        &w,
        &r,
        request(&s, "start", vec![step(&w, "a", "in_progress", &[])]),
    )
    .unwrap()["state"]
        .clone();
    assert_eq!(
        goal::completion::evaluate(&f.root, &f.c(), &w, &r, &answer).unwrap()["workFulfillment"],
        "partial"
    );
    let s = dispatch(
        &f,
        &w,
        &r,
        request(&s, "done", vec![step(&w, "a", "done", &[])]),
    )
    .unwrap()["state"]
        .clone();
    assert_eq!(
        goal::accept_report(&f.root, &w, &r, &answer, &s["goalBinding"]).unwrap()
            ["workFulfillment"],
        "fulfilled"
    );
    dispatch(
        &f,
        &w,
        &r,
        request(&s, "new", vec![step(&w, "b", "pending", &[])]),
    )
    .unwrap();
    let error = publish(
        &f.root,
        &w,
        &r,
        &answer,
        &[],
        &[],
        &crate::agent_work::actions::receipts(&f.root, &w.id).unwrap(),
        &Value::Null,
        &Control::default(),
    )
    .unwrap_err();
    assert!(error.contains("最终核验后"), "{error}");
    assert!(records(&f.root, &w.id, "delivery", 1).unwrap().is_empty());
}

#[test]
fn steering_invalidates_done_tasks_durably_and_stale_commands_cannot_rebind() {
    let (f, w, r) = setup();
    let old = state(&f, &w, &r);
    let s = dispatch(
        &f,
        &w,
        &r,
        request(&old, "done", vec![step(&w, "a", "done", &[])]),
    )
    .unwrap()["state"]
        .clone();
    record(&f.root, &r, "nativeRuntime", &json!({"protocol":1})).unwrap();
    let command = json!({"text":"补充适用范围","clientMessageId":"tasks-steer","runId":r});
    conversation::steer(&f.root, &w.id, &command).unwrap();
    record(&f.root, &r, "steeringAccepted", &command).unwrap();
    let changed = view(&f.root, &w.id).unwrap()["taskTree"].clone();
    assert_eq!(task(&changed, "a")["status"], "pending");
    assert_ne!(changed["goalBinding"], s["goalBinding"]);
    assert_eq!(
        changed["goalBinding"]["workRevision"],
        s["goalBinding"]["workRevision"]
    );
    let history = records(&f.root, &w.id, "taskTree", 10).unwrap();
    assert_eq!(history[0]["origin"], "hostRevalidation");
    assert_eq!(view(&f.root, &w.id).unwrap()["taskTree"], changed);
    assert_eq!(
        records(&f.root, &w.id, "taskTree", 10).unwrap().len(),
        history.len()
    );
    assert!(dispatch(
        &f,
        &w,
        &r,
        request(&s, "stale-goal", vec![step(&w, "a", "done", &[])])
    )
    .is_err());
    let mut req = request(&changed, "wrong-source", vec![step(&w, "a", "done", &[])]);
    req["sourceCommandId"] = old["sourceCommandId"].clone();
    assert!(dispatch(&f, &w, &r, req)
        .unwrap_err()
        .contains("当前用户命令"));
}
