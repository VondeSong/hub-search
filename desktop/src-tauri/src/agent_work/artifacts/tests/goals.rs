use super::*;

fn receive(f: &Fixture, work: &Work, run: &str, token: &str) {
    store::record(&f.root, run, "nativeRuntime", &json!({"protocol":1})).unwrap();
    let input = json!({"text":"改成提及天数","clientMessageId":token,"runId":run});
    store::conversation::steer(&f.root, &work.id, &input).unwrap();
    store::record(&f.root, run, "steeringAccepted", &input).unwrap();
}

#[test]
fn steering_invalidates_chart_and_requires_same_artifact_revision_before_completion() {
    let (f, work, run, request) = setup();
    let first = call(&f, &work, &run, &request);
    let check = json!({"action":"validate","artifactId":first["artifactId"],"revision":1});
    call(&f, &work, &run, &check);
    let refs = run_references(&f.c(), &work, &run).unwrap();
    inherit_references(&f.root, &work, &run, &refs, &Control::default()).unwrap();
    receive(&f, &work, &run, "chart-steer");
    let view = store::view(&f.root, &work.id).unwrap();
    assert_eq!(view["analysisArtifacts"][0]["state"], "stale");
    assert_eq!(view["analysisArtifacts"][0]["content"], first["content"]);
    assert!(execute(&f.root, &work, &run, &check, &Control::default())
        .unwrap_err()
        .contains("最新"));
    assert!(delivery_dependencies(&f.root, &f.c(), &work, &run, true, &Value::Null).is_err());
    assert!(delivery_dependencies(&f.root, &f.c(), &work, &run, false, &Value::Null).is_ok());
    let patch = json!({"action":"patch","operationId":"goal-update","artifactId":first["artifactId"],"expectedRevision":1,
        "spec":{"title":"学习提及天数","mark":"line","metric":"matchingUnits","term":"学习","sort":"groupAsc"},
        "analysis":null,"reason":"落实追加要求"});
    let next = call(&f, &work, &run, &patch);
    assert_eq!(next["artifactId"], first["artifactId"]);
    assert_eq!(next["revision"], 2);
    assert_eq!(next["content"]["goalBinding"]["commandWatermark"], 1);
    call(
        &f,
        &work,
        &run,
        &json!({"action":"validate","artifactId":next["artifactId"],"revision":2}),
    );
    assert!(delivery_dependencies(&f.root, &f.c(), &work, &run, true, &Value::Null).is_ok());
    assert_eq!(
        call(&f, &work, &run, &request)["state"],
        "stale",
        "operation retry cannot rebind old content"
    );
}

#[test]
fn legacy_chart_is_usable_only_when_no_inflight_goal_command_needs_proof() {
    let (f, work, run, request) = setup();
    let first = call(&f, &work, &run, &request);
    call(
        &f,
        &work,
        &run,
        &json!({"action":"validate","artifactId":first["artifactId"],"revision":1}),
    );
    f.c().execute("UPDATE agent_records SET body_json=json_remove(body_json,'$.goalBinding') WHERE work_id=?1 AND kind='chartRevision'", [&work.id]).unwrap();
    assert_eq!(
        store::view(&f.root, &work.id).unwrap()["analysisArtifacts"][0]["state"],
        "checked"
    );
    receive(&f, &work, &run, "legacy-steer");
    assert_eq!(
        store::view(&f.root, &work.id).unwrap()["analysisArtifacts"][0]["state"],
        "stale"
    );
}

#[test]
fn completion_binds_checked_chart_versions_and_rejects_old_proof_after_patch() {
    let (f, work, run, request) = setup();
    let first = call(&f, &work, &run, &request);
    assert!(
        store::goal::completion::read_context(&f.root, &work, &run).unwrap()["proofs"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    call(
        &f,
        &work,
        &run,
        &json!({"action":"validate","artifactId":first["artifactId"],"revision":1}),
    );
    let context = store::goal::completion::read_context(&f.root, &work, &run).unwrap();
    let proof = context["proofs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["kind"] == "chart")
        .unwrap();
    let items:Vec<_>=context["requirements"].as_array().unwrap().iter().map(|r|json!({"requirementId":r["requirementId"],"criterion":r["text"],"requiredResult":"chart","status":"satisfied","explanation":"统计结果已核对","refs":[proof["proofId"]],"supersededBy":null})).collect();
    let report:runner::Report=serde_json::from_value(json!({"status":"completed","summary":"已生成统计图","findings":[],"nextSteps":[],"questions":[],"limitations":[],"waitCondition":"","completion":{"goalBinding":context["goalBinding"],"items":items}})).unwrap();
    // The captured failure retained the mismatch error and real chart proof,
    // but not the rejected finish arguments. These are reconstructed negative
    // cases, not a claimed replay of that missing request.
    for kind in ["action", "response"] {
        let mut wrong = serde_json::to_value(&report).unwrap();
        wrong["completion"]["items"][0]["requiredResult"] = json!(kind);
        let wrong: runner::Report = serde_json::from_value(wrong).unwrap();
        let error =
            store::goal::accept_report(&f.root, &work, &run, &wrong, &context["goalBinding"])
                .unwrap_err();
        assert!(
            error.contains(&format!("要求 {kind}，证据 chart")),
            "{error}"
        );
        assert!(error.contains(proof["proofId"].as_str().unwrap()));
        assert!(store::records(&f.root, &work.id, "finishAcceptance", 1)
            .unwrap()
            .is_empty());
        assert!(store::records(&f.root, &work.id, "delivery", 1)
            .unwrap()
            .is_empty());
    }
    let accepted =
        store::goal::accept_report(&f.root, &work, &run, &report, &context["goalBinding"]).unwrap();
    assert_eq!(accepted["workFulfillment"], "fulfilled");
    assert!(
        store::records(&f.root, &work.id, "finishAcceptance", 1).unwrap()[0]["completion"]
            ["proofVersions"]
            .as_array()
            .unwrap()
            .contains(proof)
    );
    let patch = json!({"action":"patch","operationId":"completion-patch","artifactId":first["artifactId"],"expectedRevision":1,"spec":{"title":"新标题","mark":"line","metric":"matchingUnits","term":"学习","sort":"groupAsc"},"analysis":null,"reason":"修订统计口径"});
    call(&f, &work, &run, &patch);
    call(
        &f,
        &work,
        &run,
        &json!({"action":"validate","artifactId":first["artifactId"],"revision":2}),
    );
    assert!(
        store::goal::completion::evaluate(&f.root, &f.c(), &work, &run, &report)
            .unwrap_err()
            .contains("证据不存在")
    );
}
