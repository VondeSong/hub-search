use super::*;
fn entry(lib: &str, dir: &str) -> Value {
    json!({"kind":"libraryInstructions","scope":{"libraryId":lib,"directory":dir},"version":"v1","source":"AGENTS.md","instructions":"完整规则保持作用域。".repeat(160)})
}
fn rules(doc: &str, e: Value) -> Value {
    json!({"kind":"libraryRules","libraryId":"os","documentId":doc,"fingerprint":"v1","entries":[e]})
}
#[test]
fn nested_exact_scope_initial_subset_and_original_business_fields_are_preserved() {
    let a = rules("a", entry("os", "root"));
    let b = rules("b", entry("os", "root"));
    let initial = json!([a, b]);
    let mut g = GuidanceRef::new(&initial);
    assert!(g.initial_view().to_string().len() < initial.to_string().len());
    let raw = json!({"knowledgeRules":initial,"result":[{"knowledgeRules":a,"content":"完整原文","readEvidence":{"source":"version"}}],"quoteCatalog":[{"quoteId":"e1:q1","text":"原句"}],"businessActionRecords":[{"state":"unknown"}]});
    let wire = g.project_for(raw.clone(), "one");
    assert!(wire["result"][0]["knowledgeRulesRef"].is_object());
    assert_eq!(wire["quoteCatalog"], raw["quoteCatalog"]);
    assert_eq!(wire["businessActionRecords"], raw["businessActionRecords"]);
    assert_eq!(wire["result"][0]["content"], raw["result"][0]["content"]);
    g.invalidate();
    assert_eq!(g.restore_replay(wire).unwrap(), raw);
}
#[test]
fn different_scope_version_and_unflushed_new_rule_never_borrow_a_baseline() {
    let mut g = GuidanceRef::new(&json!([rules("a", entry("os", "root"))]));
    for e in [entry("other", "root"), entry("os", "child"), {
        let mut v = entry("os", "root");
        v["instructions"] = json!("changed".repeat(300));
        v
    }] {
        let raw = json!({"result":{"knowledgeRules":rules("a",e)}});
        assert_eq!(g.project_for(raw.clone(), "not-sent"), raw);
        assert_eq!(g.project_for(raw.clone(), "still-not-sent"), raw);
    }
    let new = json!({"result":{"knowledgeRules":rules("new",entry("os","new"))}});
    assert_eq!(g.project_for(new.clone(), "new"), new);
    g.sent("new");
    assert!(g.project_for(new, "following")["result"]["knowledgeRulesRef"].is_object());
}
#[test]
fn restart_compaction_and_tampered_references_restore_or_reject_without_redispatch() {
    let a = rules("a", entry("os", "root"));
    let b = rules("b", entry("os", "root"));
    let mut g = GuidanceRef::new(&json!([a, b]));
    let full = json!({"result":{"knowledgeRules":a,"content":"actual"},"knowledgeRules":[a,b]});
    let wire = g.project_for(full.clone(), "old");
    let mut bad = wire.clone();
    bad["result"]["knowledgeRulesRef"]["sha256"] = json!("wrong");
    assert!(g.restore_replay(bad).is_err());
    g.invalidate();
    let restored = g.restore_replay(wire.clone()).unwrap();
    assert_eq!(restored, full);
    let resend = g.project_for(restored, "old");
    assert!(resend.to_string().contains("完整规则"));
    g.sent("old");
    assert!(g.project_for(full.clone(), "after").to_string().len() < resend.to_string().len());
    let restarted = GuidanceRef::new(&json!([b, a]));
    let restored = restarted.restore_replay(wire).unwrap();
    assert!(restored["result"]["knowledgeRules"].is_object());
    assert_eq!(restored["result"]["content"], "actual");
}
#[test]
fn late_old_send_confirmation_cannot_activate_a_new_context_baseline() {
    let mut g = GuidanceRef::new(&json!([]));
    let full = json!({"result":{"knowledgeRules":rules("new",entry("os","child")),"content":"原始业务正文"},"businessActionRecords":[{"state":"unknown"}]});
    assert_eq!(g.project_for(full.clone(), "old-unsent"), full);
    g.invalidate();
    g.sent("old-unsent");
    assert_eq!(g.project_for(full.clone(), "current-unsent"), full);
    g.sent("old-unsent");
    assert_eq!(g.project_for(full.clone(), "still-unsent"), full);
    g.sent("current-unsent");
    let wire = g.project_for(full.clone(), "after-current-send");
    assert!(wire["result"]["knowledgeRulesRef"].is_object());
    assert_eq!(wire["result"]["content"], full["result"]["content"]);
    assert_eq!(wire["businessActionRecords"], full["businessActionRecords"]);
    g.invalidate();
    assert_eq!(g.restore_replay(wire).unwrap(), full);
}
#[test]
#[ignore = "one saved OS failure replay; no provider or source writes"]
fn saved_os_projection_round_trip_and_byte_delta() {
    let p = std::path::PathBuf::from(std::env::var("HUB_OS_RULE_REPLAY").unwrap());
    let v: Value =
        serde_json::from_slice(&std::fs::read(p.join("replay-input.json")).unwrap()).unwrap();
    let mut g = GuidanceRef::new(&v["initialRules"]);
    let material = g.project_initial(v["initialMaterial"].clone());
    let input = super::super::input::initial(v["request"].as_str().unwrap(), &material);
    let full = v["fullToolOutput"].clone();
    let wire = g.project_for(full.clone(), "saved-call");
    g.invalidate();
    assert_eq!(g.restore_replay(wire.clone()).unwrap(), full);
    let recovery = g.project_for(full.clone(), "saved-call");
    assert_eq!(wire["quoteCatalog"], full["quoteCatalog"]);
    assert_eq!(wire["businessActionRecords"], full["businessActionRecords"]);
    assert_eq!(wire["result"][0]["content"], full["result"][0]["content"]);
    let result = json!({"evidenceLayer":"saved data through production serializers/projection; not a model replay","originalInitialInputBytes":v["originalInitialInputBytes"],"repairedInitialInputBytes":input.len(),"originalFirstWireBytes":v["originalFirstWireBytes"],"repairedFirstWireBytes":wire.to_string().len(),"missingBaseWireBytes":recovery.to_string().len(),"initialRulesBefore":v["initialRules"].to_string().len(),"initialRulesAfter":material["knowledgeRules"].to_string().len(),"businessFieldsUnchanged":true,"restoredOriginalExactly":true});
    std::fs::write(
        p.join("offline-replay-result.json"),
        serde_json::to_vec_pretty(&result).unwrap(),
    )
    .unwrap();
}
