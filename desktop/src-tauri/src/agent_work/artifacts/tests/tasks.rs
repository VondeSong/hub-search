use super::*;
use crate::agent_work::store::tasks;

#[test]
fn unrelated_checked_chart_keeps_its_task_done_when_another_chart_changes() {
    let (f, w, r, req) = setup();
    let first = call(&f, &w, &r, &req);
    call(
        &f,
        &w,
        &r,
        &json!({"action":"validate","artifactId":first["artifactId"],"revision":1}),
    );
    let mut req = req;
    req["operationId"] = json!("second-chart");
    let second = call(&f, &w, &r, &req);
    call(
        &f,
        &w,
        &r,
        &json!({"action":"validate","artifactId":second["artifactId"],"revision":1}),
    );
    let ctx = store::goal::completion::read_context(&f.root, &w, &r).unwrap();
    let first_proof = ctx["proofs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["reference"]["artifactId"] == first["artifactId"])
        .unwrap();
    let second_proof = ctx["proofs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["reference"]["artifactId"] == second["artifactId"])
        .unwrap();
    patch(
        &f,
        &w,
        &r,
        "two-tasks",
        vec![
            task(&w, "one", "第一张图", None, &[], Some(first_proof)),
            task(&w, "two", "第二张图", None, &[], Some(second_proof)),
        ],
    );
    call(
        &f,
        &w,
        &r,
        &json!({"action":"patch","operationId":"first-change","artifactId":first["artifactId"],"expectedRevision":1,
        "spec":{"title":"新标题","mark":"bar","metric":"occurrences","term":"学习","sort":"groupAsc"},"analysis":null,"reason":"调整第一张图"}),
    );
    let view = store::view(&f.root, &w.id).unwrap();
    assert_eq!(status(&view, "one"), "pending");
    assert_eq!(status(&view, "two"), "done");
    let context = store::goal::completion::read_context(&f.root, &w, &r).unwrap();
    assert!(context["proofs"].as_array().unwrap().contains(second_proof));
}

fn task(
    w: &Work,
    id: &str,
    criterion: &str,
    parent: Option<&str>,
    deps: &[&str],
    proof: Option<&Value>,
) -> Value {
    json!({"taskId":id,"parentId":parent,"requirementRefs":[format!("{}-goal",w.id)],"criterion":criterion,
        "dependencies":deps,"requiredResult":if proof.is_some(){"chart"}else{"response"},"status":"done",
        "proofIds":proof.map(|p|vec![p["proofId"].clone()]).unwrap_or_default(),"review":"已核对统计与说明","blocker":null})
}
fn patch(f: &Fixture, w: &Work, r: &str, op: &str, steps: Vec<Value>) -> Value {
    let s = tasks::execute(
        &f.root,
        w,
        r,
        &json!({"action":"read"}),
        &Control::default(),
    )
    .unwrap();
    tasks::execute(&f.root,w,r,&json!({"action":"patch","operationId":op,"expectedGoalBinding":s["goalBinding"],
        "expectedTaskRevision":s["revision"],"sourceCommandId":s["sourceCommandId"],"upsert":steps,"remove":[]}),&Control::default()).unwrap()
}
fn chart_proof(f: &Fixture, w: &Work, r: &str) -> Value {
    store::goal::completion::read_context(&f.root, w, r).unwrap()["proofs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["kind"] == "chart")
        .unwrap()
        .clone()
}
fn status<'a>(view: &'a Value, id: &str) -> &'a Value {
    &view["taskTree"]["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["taskId"] == id)
        .unwrap()["status"]
}

#[test]
fn chart_revision_and_source_changes_revalidate_task_dependencies_with_real_views() {
    let (f, w, r, req) = setup();
    let chart = call(&f, &w, &r, &req);
    call(
        &f,
        &w,
        &r,
        &json!({"action":"validate","artifactId":chart["artifactId"],"revision":1}),
    );
    let proof = chart_proof(&f, &w, &r);
    patch(
        &f,
        &w,
        &r,
        "complete",
        vec![
            task(&w, "summary", "汇总结果", None, &[], None),
            task(
                &w,
                "chart",
                "核对统计图",
                Some("summary"),
                &[],
                Some(&proof),
            ),
            task(
                &w,
                "explain",
                "解释统计结果",
                Some("summary"),
                &["chart"],
                None,
            ),
            task(&w, "independent", "独立说明", None, &[], None),
        ],
    );
    let complete = store::view(&f.root, &w.id).unwrap();
    assert_eq!(status(&complete, "summary"), "done");
    call(
        &f,
        &w,
        &r,
        &json!({"action":"patch","operationId":"task-chart-change","artifactId":chart["artifactId"],"expectedRevision":1,
        "spec":{"title":"学习提及天数","mark":"line","metric":"matchingUnits","term":"学习","sort":"groupAsc"},"analysis":null,"reason":"重新核对统计口径"}),
    );
    let stale = store::view(&f.root, &w.id).unwrap();
    for id in ["chart", "explain", "summary"] {
        assert_eq!(status(&stale, id), "pending");
    }
    assert_eq!(status(&stale, "independent"), "done");
    assert_eq!(
        stale["taskTree"]["invalidations"].as_array().unwrap().len(),
        3
    );
    call(
        &f,
        &w,
        &r,
        &json!({"action":"validate","artifactId":chart["artifactId"],"revision":2}),
    );
    assert_eq!(
        status(&store::view(&f.root, &w.id).unwrap(), "chart"),
        "pending",
        "validating chart alone cannot complete semantic task review"
    );
    let proof = chart_proof(&f, &w, &r);
    patch(
        &f,
        &w,
        &r,
        "revalidated",
        vec![
            task(&w, "summary", "汇总结果", None, &[], None),
            task(
                &w,
                "chart",
                "核对统计图",
                Some("summary"),
                &[],
                Some(&proof),
            ),
            task(
                &w,
                "explain",
                "解释统计结果",
                Some("summary"),
                &["chart"],
                None,
            ),
        ],
    );
    let revalidated = store::view(&f.root, &w.id).unwrap();
    assert_eq!(status(&revalidated, "chart"), "done");
    let reopened = store::load(&f.c(), &w.id).unwrap();
    assert_eq!(
        store::view(&f.root, &reopened.id).unwrap()["taskTree"],
        revalidated["taskTree"]
    );
    f.note("notes", "current", "# 2025-01-01\n来源内容已更改\n");
    let edited = store::view(&f.root, &w.id).unwrap();
    assert_eq!(
        status(&edited, "chart"),
        "done",
        "fixed historical input survives live content edits"
    );
    f.c()
        .execute(
            "DELETE FROM documents WHERE space_id='notes' AND id='current'",
            [],
        )
        .unwrap();
    let source_changed = store::view(&f.root, &w.id).unwrap();
    assert_eq!(status(&source_changed, "chart"), "pending");
    assert_eq!(status(&source_changed, "independent"), "done");
    if let Ok(path) = std::env::var("HUB_TASK_TREE_VIEW") {
        std::fs::write(path,serde_json::to_vec_pretty(&json!({"complete":complete,"stale":stale,"revalidated":revalidated,"sourceChanged":source_changed})).unwrap()).unwrap();
    }
}
