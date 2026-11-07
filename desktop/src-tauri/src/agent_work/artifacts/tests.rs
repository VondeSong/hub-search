use super::*;
mod dependencies;
mod goals;
mod revisions;
mod sleep;
mod tasks;
use crate::source_evidence::tests::Fixture;

fn setup() -> (Fixture, Work, String, Value) {
    let f = Fixture::new();
    f.note(
        "notes",
        "current",
        "# 2025-01-01\n学习 学习\n# 2025-02-01\n学习\n",
    );
    let id = super::super::tests::create(&f, true);
    let (work, run) = super::super::tests::claim(&f, &id);
    let snapshot = analysis::execute(
        &work.grant.reader(&f.root).unwrap(),
        "hub_create_analysis_snapshot",
        &json!({}),
    )
    .unwrap();
    let request = json!({"action":"create","operationId":"first-chart",
        "analysis":{"expectedSnapshot":snapshot["snapshot"],"unit":"day","groupBy":"month","terms":["学习"]},
        "spec":{"title":"学习提及次数","mark":"bar","metric":"occurrences","term":"学习","sort":"groupAsc"}});
    (f, work, run, request)
}

fn call(f: &Fixture, work: &Work, run: &str, request: &Value) -> Value {
    execute(&f.root, work, run, request, &Control::default()).unwrap()
}

#[test]
fn chart_revisions_compute_replay_conflict_and_invalidate_checks() {
    let (f, work, run, request) = setup();
    let first = call(&f, &work, &run, &request);
    assert_eq!(
        first["content"]["data"]["rows"],
        json!([{"group":"2025-01","value":2},{"group":"2025-02","value":1}])
    );
    assert_eq!(first["state"], "draft");
    assert_eq!(call(&f, &work, &run, &request), first);
    let check = json!({"action":"validate","artifactId":first["artifactId"],"revision":1});
    let checked = call(&f, &work, &run, &check);
    assert_eq!(checked["state"], "checked");
    assert_eq!(checked["validation"]["visualCheck"], "unavailable");
    let patch = json!({"action":"patch","operationId":"edit-1","artifactId":first["artifactId"],"expectedRevision":1,
        "spec":{"title":"学习趋势","mark":"line","metric":"matchingUnits","term":"学习","sort":"groupDesc"},"analysis":null,"reason":"按提及天数查看"});
    let second = call(&f, &work, &run, &patch);
    assert_eq!(second["artifactId"], first["artifactId"]);
    assert_eq!(second["revision"], 2);
    assert_eq!(second["state"], "draft");
    assert!(second["validation"].is_null());
    assert_eq!(
        second["content"]["data"]["datasetRevision"],
        first["content"]["data"]["datasetRevision"]
    );
    assert_eq!(call(&f, &work, &run, &patch), second);
    let mut conflicting = patch.clone();
    conflicting["operationId"] = json!("edit-2");
    assert!(
        execute(&f.root, &work, &run, &conflicting, &Control::default())
            .unwrap_err()
            .contains("冲突")
    );
    assert!(execute(&f.root, &work, &run, &check, &Control::default())
        .unwrap_err()
        .contains("最新"));
    let old = call(
        &f,
        &work,
        &run,
        &json!({"action":"read","artifactId":first["artifactId"],"revision":1}),
    );
    assert_eq!(old["content"], first["content"]);
    assert_eq!(old["currentRevision"], 2);
    assert_eq!(view_on(&f.root, &f.c(), &work).unwrap()[0]["revision"], 2);
}

#[test]
fn chart_contract_rejects_external_data_scripts_unknown_fields_and_partial_inputs() {
    let (f, work, run, request) = setup();
    for (field, value) in [
        ("url", json!("https://example.com/private")),
        ("transform", json!("x=>x*2")),
        ("values", json!([1, 2])),
    ] {
        let mut bad = request.clone();
        bad["spec"][field] = value;
        assert!(execute(&f.root, &work, &run, &bad, &Control::default()).is_err());
    }
    for (field, value) in [
        ("metric", json!("rate")),
        ("mark", json!("script")),
        ("term", json!("不存在")),
    ] {
        let mut bad = request.clone();
        bad["spec"][field] = value;
        assert!(execute(&f.root, &work, &run, &bad, &Control::default()).is_err());
    }
    let mut bad = request.clone();
    bad["analysis"]["expectedSnapshot"] = json!("live-fingerprint");
    assert!(execute(&f.root, &work, &run, &bad, &Control::default()).is_err());
    f.note("notes", "missing", "");
    let snapshot = analysis::execute(
        &work.grant.reader(&f.root).unwrap(),
        "hub_create_analysis_snapshot",
        &json!({}),
    )
    .unwrap();
    bad = request.clone();
    bad["analysis"]["expectedSnapshot"] = snapshot["snapshot"].clone();
    assert!(execute(&f.root, &work, &run, &bad, &Control::default())
        .unwrap_err()
        .contains("缺失"));
    assert!(records(&f.c(), &work.id, "chartRevision")
        .unwrap()
        .is_empty());
}

#[test]
fn chart_authorization_expiry_and_source_deletion_hide_data_after_reopen() {
    let (f, work, run, request) = setup();
    let first = call(&f, &work, &run, &request);
    f.note(
        "notes",
        "current",
        "# 2025-01-01\n更新的正文不替换历史计数\n",
    );
    let read = json!({"action":"read","artifactId":first["artifactId"],"revision":1});
    assert_eq!(
        call(&f, &work, &run, &read)["content"]["data"],
        first["content"]["data"]
    );
    let mut revoked = work.clone();
    revoked.authorization_version += 1;
    let hidden = view_on(&f.root, &f.c(), &revoked).unwrap();
    assert_eq!(hidden[0]["state"], "unavailable");
    assert!(!hidden.to_string().contains("学习"));
    f.c()
        .execute(
            "DELETE FROM documents WHERE space_id='notes' AND id='current'",
            [],
        )
        .unwrap();
    assert!(execute(&f.root, &work, &run, &read, &Control::default()).is_err());
    assert_eq!(
        store::view(&f.root, &work.id).unwrap()["analysisArtifacts"][0]["state"],
        "unavailable"
    );
}

#[test]
fn chart_delivery_uses_real_snapshot_dependencies_and_requires_current_checks() {
    let (f, work, run, request) = setup();
    let first = call(&f, &work, &run, &request);
    assert!(delivery_dependencies(&f.root, &f.c(), &work, &run, true, &json!({})).is_err());
    call(
        &f,
        &work,
        &run,
        &json!({"action":"validate","artifactId":first["artifactId"],"revision":1}),
    );
    let reads = delivery_dependencies(&f.root, &f.c(), &work, &run, true, &json!({})).unwrap();
    analysis::verify_in_transaction(&work.grant.reader(&f.root).unwrap(), &f.c(), &reads).unwrap();
    let report:runner::Report=serde_json::from_value(json!({"status":"completed","summary":"图表数值已核对","findings":[],"nextSteps":[],"questions":[],"limitations":["仅本地固定输入"],"waitCondition":""})).unwrap();
    store::publish(
        &f.root,
        &work,
        &run,
        &report,
        &[],
        &[],
        &actions::receipts(&f.root, &work.id).unwrap(),
        &json!({}),
        &Control::default(),
    )
    .unwrap();
    let delivery = store::records(&f.root, &work.id, "delivery", 1).unwrap();
    assert_eq!(delivery[0]["materialReads"], reads);
    let view = store::view(&f.root, &work.id).unwrap();
    assert_eq!(view["analysisArtifacts"][0]["state"], "checked");
    // Export the actual serialized Work view for the front-end consumer check.
    if let Ok(path) = std::env::var("HUB_CHART_TEST_VIEW") {
        std::fs::write(path, serde_json::to_vec_pretty(&view).unwrap()).unwrap();
    }
}

#[test]
fn chart_cancelled_or_replaced_runs_do_not_append_and_goal_changes_stale_checks() {
    let (f, work, run, request) = setup();
    let first = call(&f, &work, &run, &request);
    let mut next = work.clone();
    next.revision += 1;
    assert_eq!(
        view_on(&f.root, &f.c(), &next).unwrap()[0]["state"],
        "stale"
    );
    let mut bad = request.clone();
    bad["operationId"] = json!("second");
    f.c()
        .execute(
            "UPDATE agent_works SET active_run=NULL WHERE id=?1",
            [&work.id],
        )
        .unwrap();
    assert!(execute(&f.root, &work, &run, &bad, &Control::default()).is_err());
    assert_eq!(records(&f.c(), &work.id, "chartRevision").unwrap().len(), 1);
    assert_eq!(
        find(
            &f.c(),
            &work.id,
            first["artifactId"].as_str().unwrap(),
            None
        )
        .unwrap()["revision"],
        1
    );
}

#[test]
fn chart_assistant_schema_and_dispatch_share_the_production_contract() {
    let (f, work, run, request) = setup();
    let schema = assistant::schema(runner::schema());
    let encoded = json!({"operation":"chart","request":request});
    let contract = schema["properties"]["requests"]["items"]["anyOf"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["properties"]["operation"]["enum"][0] == "chart")
        .unwrap();
    crate::model_runtime::validate_agent_tool(&encoded, contract).unwrap();
    let control = Control::default();
    let session = assistant::Session {
        root: &f.root,
        work: &work,
        run: &run,
        control: &control,
        operation: None,
        selection: json!({}),
        app: None,
    };
    let result = session
        .dispatch(serde_json::from_value(encoded).unwrap())
        .unwrap();
    assert_eq!(result["content"]["data"]["rows"][0]["value"], 2);
    assert_eq!(
        session.capabilities().unwrap()["charts"][0]["artifactId"],
        result["artifactId"]
    );
}

#[test]
fn expired_chart_requires_explicit_new_input_and_spec_without_reusing_hidden_fields() {
    let (f, work, run, request) = setup();
    let first = call(&f, &work, &run, &request);
    let cache = Connection::open(f.root.join("analysis-snapshots.sqlite3")).unwrap();
    cache
        .execute("UPDATE snapshots SET expires_at=0", [])
        .unwrap();
    assert_eq!(
        view_on(&f.root, &f.c(), &work).unwrap()[0]["state"],
        "unavailable"
    );
    // Change the source so recapture cannot reproduce the same content-addressed
    // snapshot within the same clock second.
    f.note("notes", "fresh", "# 2025-03-01\n学习\n");
    let snapshot = analysis::execute(
        &work.grant.reader(&f.root).unwrap(),
        "hub_create_analysis_snapshot",
        &json!({}),
    )
    .unwrap();
    assert_ne!(
        snapshot["snapshot"],
        request["analysis"]["expectedSnapshot"]
    );
    let mut input = request["analysis"].clone();
    input["expectedSnapshot"] = snapshot["snapshot"].clone();
    let mut patch = json!({"action":"patch","operationId":"refresh-chart","artifactId":first["artifactId"],"expectedRevision":1,"spec":null,"analysis":input,"reason":"采用新输入"});
    assert!(execute(&f.root, &work, &run, &patch, &Control::default()).is_err());
    patch["spec"] = request["spec"].clone();
    let refreshed = call(&f, &work, &run, &patch);
    assert_eq!(refreshed["revision"], 2);
    assert_eq!(refreshed["artifactId"], first["artifactId"]);
    assert_eq!(refreshed["state"], "draft");
}

#[test]
fn changed_stored_content_cannot_reuse_a_successful_numeric_receipt() {
    let (f, work, run, request) = setup();
    let first = call(&f, &work, &run, &request);
    call(
        &f,
        &work,
        &run,
        &json!({"action":"validate","artifactId":first["artifactId"],"revision":1}),
    );
    f.c().execute("UPDATE agent_records SET body_json=json_set(body_json,'$.data.rows[0].value',999) WHERE work_id=?1 AND kind='chartRevision'",[&work.id]).unwrap();
    let hidden = view_on(&f.root, &f.c(), &work).unwrap();
    assert_eq!(hidden[0]["state"], "unavailable");
    assert!(!hidden.to_string().contains("999"));
    assert!(delivery_dependencies(&f.root, &f.c(), &work, &run, true, &json!({})).is_err());
}
