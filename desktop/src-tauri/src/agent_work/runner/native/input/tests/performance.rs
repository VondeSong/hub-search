use super::*;

#[test]
fn deferred_manuals_keep_all_tools_and_the_full_argument_gate() {
    let (f, _id, run, _catalog, full) = setup();
    let wire = wire_tools(&full, &Value::Null);
    assert_eq!(
        wire.as_array().unwrap().len(),
        full.as_array().unwrap().len()
    );
    assert!(wire.to_string().len() + 15_000 < full.to_string().len());
    for spec in full.as_array().unwrap() {
        assert_eq!(
            tool_schema(&full, spec["name"].as_str().unwrap()).unwrap(),
            *spec
        );
    }
    assert!(tool_schema(&full, "hub_not_available").is_err());
    let read =
        json!({"tool":"hub_toolSchema","callId":"schema","arguments":{"name":"hub_sleepDataset"}});
    let mut used = 0;
    assert!(matches!(
        super::super::super::arguments::decode(&f.root, &run, &full, &read, &mut used, 24)
            .unwrap()
            .unwrap(),
        Tool::ToolSchema { .. }
    ));
    let bad = json!({"tool":"hub_sleepDataset","callId":"bad","arguments":{"request":{"action":"create","rows":[{"date":"2025-01-01","hours":7}]}}});
    crate::model_runtime::validate_agent_tool(
        &bad["arguments"],
        &wire
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["name"] == "hub_sleepDataset")
            .unwrap()["inputSchema"],
    )
    .unwrap();
    assert!(
        super::super::super::arguments::decode(&f.root, &run, &full, &bad, &mut used, 24)
            .unwrap()
            .is_err()
    );
    assert_eq!(used, 1);
}

#[test]
fn quote_and_rule_references_require_delivery_and_recover_exactly() {
    use super::super::super::guidance::GuidanceRef;
    let rules = json!([{"entries":[{"scope":{"libraryId":"os"},"instructions":"规则".repeat(500)}]}, {"entries":[{"scope":{"libraryId":"os"},"instructions":"规则".repeat(500)}]}]);
    let quotes = json!([{"quoteId":"e1:q1","text":"证据".repeat(500)}]);
    let mut g = GuidanceRef::new(&rules);
    let material = g.project_initial(json!({"knowledgeRules":rules,"quoteCatalog":quotes}));
    assert!(material["knowledgeRules"].to_string().len() < rules.to_string().len());
    let raw = json!({"knowledgeRules":rules,"quoteCatalog":quotes,"result":{"content":"全文"},"businessActionRecords":[{"state":"unknown"}]});
    let wire = g.project_for(raw.clone(), "first");
    assert!(wire["knowledgeRules"].is_array());
    assert!(wire["quoteCatalogRef"].is_object());
    g.invalidate();
    assert_eq!(g.restore_replay(wire.clone()).unwrap(), raw);
    let unsent = g.project_for(raw.clone(), "unsent");
    assert_eq!(unsent["quoteCatalog"], quotes);
    assert_eq!(
        g.project_for(raw.clone(), "also-unsent")["quoteCatalog"],
        quotes
    );
    g.sent("unsent");
    assert!(g.project_for(raw.clone(), "confirmed")["quoteCatalogRef"].is_object());
    let mut changed = raw.clone();
    changed["quoteCatalog"][0]["text"] = json!("changed");
    assert_eq!(
        g.project_for(changed.clone(), "new-version")["quoteCatalog"],
        changed["quoteCatalog"]
    );
    let mut bad = wire;
    bad["quoteCatalogRef"]["sha256"] = json!("tampered");
    assert!(g.restore_replay(bad).is_err());
    g.invalidate();
    g.sent("also-unsent");
    assert_eq!(
        g.project_for(raw.clone(), "after-late-confirm")["quoteCatalog"],
        quotes
    );
}

#[test]
#[ignore = "explicit saved 365 sample; no model or source/database writes"]
fn saved_reading_payload_performance_replay() {
    use super::super::super::guidance::GuidanceRef;
    let path = std::path::PathBuf::from(std::env::var("HUB_PERFORMANCE_REPLAY").unwrap());
    let saved: Value =
        serde_json::from_slice(&std::fs::read(path.join("replay-input.json")).unwrap()).unwrap();
    for citation in saved["citations"].as_array().unwrap() {
        assert!(saved["evidence"][citation["evidenceId"].as_str().unwrap()]
            .as_str()
            .unwrap()
            .contains(citation["quote"].as_str().unwrap()));
    }
    let mut material = saved["material"].clone();
    material["hubCapabilities"] = capability_context(saved["catalog"].clone(), &saved["tools"]);
    let mut guidance = GuidanceRef::new(&saved["rules"]);
    material["knowledgeRules"] = saved["rules"].clone();
    material = guidance.project_initial(material);
    let wire_tools = wire_tools(&saved["tools"], &saved["material"]["skills"]);
    let mut frames = Vec::new();
    for (i, frame) in saved["frames"].as_array().unwrap().iter().enumerate() {
        let call = format!("saved-{i}");
        let raw = &frame["full"];
        let wire = guidance.project_for(raw.clone(), &call);
        let mut lost = guidance.clone();
        lost.invalidate();
        assert_eq!(lost.restore_replay(wire.clone()).unwrap(), *raw);
        assert_eq!(wire["businessActionRecords"], raw["businessActionRecords"]);
        frames.push(json!({"beforeBytes":frame["wireBytes"],"afterBytes":wire.to_string().len(),"quoteCatalogReferenced":wire.get("quoteCatalogRef").is_some(),"fullResultPreserved":true,"recoveryExact":true}));
        guidance.sent(&call);
    }
    let result = json!({"scope":"saved 365 input/output through production serializers; no provider tokens/latency claims", "initialMaterialBeforeBytes":saved["material"].to_string().len(),"initialMaterialAfterBytes":material.to_string().len(),"toolsBeforeBytes":saved["tools"].to_string().len(),"toolsAfterBytes":wire_tools.to_string().len(),"frames":frames,"exactCitationCount":saved["citations"].as_array().unwrap().len(),"originalReportSha256":saved["reportSha256"]});
    assert!(
        result["initialMaterialAfterBytes"].as_u64().unwrap()
            < result["initialMaterialBeforeBytes"].as_u64().unwrap()
    );
    assert!(
        result["toolsAfterBytes"].as_u64().unwrap() < result["toolsBeforeBytes"].as_u64().unwrap()
    );
    std::fs::write(
        path.join("offline-replay-result.json"),
        serde_json::to_vec_pretty(&result).unwrap(),
    )
    .unwrap();
}

#[test]
#[ignore = "one explicit real-model comparison in a disposable snapshot; no desktop UI"]
fn saved_reading_one_native_comparison() {
    let out = std::path::PathBuf::from(std::env::var("HUB_PERFORMANCE_REPLAY").unwrap());
    let desktop = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let root = desktop.join(".local/agent-context-performance-20261029/profile");
    assert_eq!(
        std::fs::read(root.join(".hub-isolated-runtime-v1")).unwrap(),
        b"Hub isolated runtime v1\n"
    );
    let request: Value =
        serde_json::from_slice(&std::fs::read(out.join("native-contract.json")).unwrap()).unwrap();
    assert_eq!(request["attempts"], 1);
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(out.join("native-comparison-started"))
        .unwrap();
    let mut before = store::view(&root, request["oldWorkId"].as_str().unwrap()).unwrap();
    before.as_object_mut().unwrap().remove("nativeTiming");
    let created = crate::agent_work::ui(&root, &request["create"]).unwrap();
    let id = created["work"]["id"].as_str().unwrap();
    let start = std::time::Instant::now();
    let result = crate::agent_work::ui(&root, &json!({"action":"respond","id":id,"mode":"quick"}));
    let elapsed = start.elapsed().as_millis();
    let view = store::view(&root, id).unwrap();
    let records = store::records(&root, id, "nativeMeasurement", 2).unwrap();
    let summary = json!({"scope":"actual native runner and real provider in isolated unit harness; not shipping EXE/UI timing", "workId":id,"status":if result.is_ok(){"returned"}else{"failed"},"error":result.as_ref().err(),"hostElapsedMs":elapsed,"measurement":records,"view":view});
    std::fs::write(
        out.join("native-comparison.json"),
        serde_json::to_vec_pretty(&summary).unwrap(),
    )
    .unwrap();
    let mut after = store::view(&root, request["oldWorkId"].as_str().unwrap()).unwrap();
    after.as_object_mut().unwrap().remove("nativeTiming");
    assert_eq!(after, before);
    result.unwrap();
    assert_eq!(view["work"]["state"], "completed");
    assert_eq!(view["actions"]["items"].as_array().map_or(0, Vec::len), 0);
}
