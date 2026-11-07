use super::*;

#[test]
fn interpretation_version_invalidates_checked_chart_until_same_artifact_is_revised() {
    let (f, w, r, req) = setup();
    let chart = call(&f, &w, &r, &req);
    call(
        &f,
        &w,
        &r,
        &json!({"action":"validate","artifactId":chart["artifactId"],"revision":1}),
    );
    let s = store::goal::revisions::execute(
        &f.root,
        &w,
        &r,
        &json!({"action":"read","revision":null}),
        &Control::default(),
    )
    .unwrap();
    store::goal::revisions::execute(&f.root,&w,&r,&json!({"action":"revise","operationId":"interpret","expectedGoalBinding":s["goalBinding"],"expectedGoalRevision":0,"sourceCommandId":s["sourceCommandId"],
        "content":{"effectiveGoal":{"text":"按授权材料核对统计","sourceRefs":[s["sourceCommandId"]]},"items":[]},"retirements":[],"rationale":"明确当前统计目标"}),&Control::default()).unwrap();
    let view = store::view(&f.root, &w.id).unwrap();
    assert_eq!(view["analysisArtifacts"][0]["state"], "stale");
    assert!(delivery_dependencies(&f.root, &f.c(), &w, &r, true, &Value::Null).is_err());
    call(
        &f,
        &w,
        &r,
        &json!({"action":"patch","operationId":"rebind-chart","artifactId":chart["artifactId"],"expectedRevision":1,"analysis":null,
        "spec":{"title":"核对统计结果","mark":"bar","metric":"occurrences","term":"学习","sort":"groupAsc"},"reason":"按当前解释重新核对"}),
    );
    call(
        &f,
        &w,
        &r,
        &json!({"action":"validate","artifactId":chart["artifactId"],"revision":2}),
    );
    assert!(delivery_dependencies(&f.root, &f.c(), &w, &r, true, &Value::Null).is_ok());
    assert_eq!(
        store::view(&f.root, &w.id).unwrap()["analysisArtifacts"][0]["content"]["goalBinding"]
            ["goalRevision"],
        1
    );
}
