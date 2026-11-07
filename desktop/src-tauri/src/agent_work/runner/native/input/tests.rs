use super::*;
mod evidence_reuse;
mod performance;
mod report_continuation;
use crate::source_evidence::tests::Fixture;
use sha2::Digest;

#[test]
fn followup_policy_reuses_web_sources_without_reusing_hub_citation_ids() {
    let (f, id, _, _, _) = setup();
    let work = store::load(&f.c(), &id).unwrap();
    let conversation = store::conversation::context(&f.root, &work).unwrap();
    let resumed = conversation_context(&conversation, true);
    let policy = resumed["policy"].as_str().unwrap();
    assert!(policy.contains("Hub 笔记的精确编号引用只能选择本轮 quoteCatalog"));
    assert!(policy.contains("核验当前授权和版本"));
    assert!(policy.contains("公开网页来源可复用同一原生会话中已实际读取"));
    assert!(policy.contains("上下文缺失或用户要求复核时再查证"));
    assert!(!policy.contains("请重新读取当前原文，引用只能"));
    assert_eq!(resumed["historyMode"], "nativeThread");
}

#[test]
fn capability_descriptions_only_reference_an_exact_native_definition() {
    let definition = json!({"type":"function","name":"hub_sample","description":"Read current authorized material","inputSchema":{"type":"object"}});
    let entry = json!({"name":"hub_sample","available":true,"description":definition["description"],"inputSchema":definition["inputSchema"],"permission":"read"});
    let catalog = json!({"tools":[entry]});
    let projected = capability_context(catalog.clone(), &json!([definition]));
    assert_eq!(projected["tools"][0]["descriptionRef"]["nativeTool"], "hub_sample");
    assert!(projected["tools"][0].get("description").is_none());
    assert_eq!(projected["tools"][0]["permission"], "read");
    let mut changed = definition.clone();
    changed["description"] = json!("Different scope");
    let retained = capability_context(catalog, &json!([changed]));
    assert_eq!(retained["tools"][0]["description"], definition["description"]);
    assert!(retained["tools"][0].get("descriptionRef").is_none());
}

#[test]
fn resumed_conversation_uses_native_history_and_fresh_threads_keep_rebuild_context() {
    let original = json!({"currentRequest":"解释上一轮第二点","messages":[{"role":"assistant","text":"previous answer"}],"earlierMessagesOmitted":true,"goalState":{"state":"active"},"goalBinding":{"revision":2},"reportContinuation":{"id":"saved"},"policy":"read current sources"});
    let resumed = conversation_context(&original, true);
    assert!(resumed.get("messages").is_none());
    assert!(resumed.get("earlierMessagesOmitted").is_none());
    assert_eq!(resumed["historyMode"], "nativeThread");
    for key in [
        "currentRequest",
        "goalState",
        "goalBinding",
        "reportContinuation",
        "policy",
    ] {
        assert_eq!(resumed[key], original[key]);
    }
    assert_eq!(conversation_context(&original, false), original);
    assert_eq!(original["messages"].as_array().unwrap().len(), 1);
    let pending = json!({"currentRequest":"再解释第二点","messages":[
        {"role":"user","text":"原要求"},{"role":"assistant","text":"已有回答"},
        {"role":"user","text":"先补充来源"},{"role":"user","text":"再解释第二点"}
    ]});
    assert_eq!(
        conversation_context(&pending, true)["messages"],
        json!([
            {"role":"user","text":"先补充来源"},{"role":"user","text":"再解释第二点"}
        ])
    );
}

#[test]
fn reliability_rereading_a_source_always_returns_its_complete_current_citations() {
    let quotes = json!([{"evidenceId":"e1","quoteId":"e1:q1","text":"other source"},{"evidenceId":"e2","quoteId":"e2:q1","text":"原文".repeat(300)},{"evidenceId":"e2","quoteId":"e2:q2","text":"原文尾部"}]);
    let observation =
        json!({"evidenceId":"e2","excerpt":{"content":"原文正文","version":"current"}});
    let output = tool_output(
        observation,
        json!({"recordId":"full-result"}),
        quotes.clone(),
        json!([]),
        json!([]),
        10,
    );
    assert_eq!(output["quoteCatalog"], json!([quotes[1], quotes[2]]));
    assert_eq!(output["quoteCatalogScope"], "currentRead");
    let mut guidance = super::super::guidance::GuidanceRef::new(&json!([]));
    let first = guidance.project_for(output.clone(), "first");
    guidance.sent("first");
    let again = guidance.project_for(output.clone(), "reread");
    assert_eq!(first["quoteCatalog"], output["quoteCatalog"]);
    assert_eq!(again["quoteCatalog"], first["quoteCatalog"]);
    assert!(again.get("quoteCatalogRef").is_none());
    guidance.invalidate();
    assert_eq!(
        guidance.project_for(output.clone(), "after-compaction")["quoteCatalog"],
        output["quoteCatalog"]
    );
    assert_eq!(quotes.as_array().unwrap().len(), 3);
}

const DIARY: &str = "# 2025-01-01\n学习 学习 💤e\u{301}\n昨夜主睡眠实际睡了7小时。复核更正：实际主睡眠6.5小时。午睡半小时。\n# 2025-01-02\n学习\n昨夜主睡眠实际睡了8小时。六个多小时是旧估计。\n# 2025-02-01\n学习\n昨晚两点睡，七点起；中间醒过，实际睡眠时长不清楚。\n";

fn setup() -> (Fixture, String, String, Value, Value) {
    let f = Fixture::new();
    f.note("notes", "current", DIARY);
    let id = crate::agent_work::tests::create(&f, false);
    let (work, run) = crate::agent_work::tests::claim(&f, &id);
    let environment =
        crate::hub_capabilities::Session::new(&f.root, Some(work.grant.scope().unwrap())).unwrap();
    let catalog = environment.tools().unwrap();
    let tools = super::super::tools(Some(&environment)).unwrap();
    (f, id, run, catalog, tools)
}

#[test]
fn native_capability_context_preserves_callable_contract_and_unavailable_metadata() {
    let (_f, _id, _run, catalog, tools) = setup();
    assert_eq!(
        format!("{:x}", sha2::Sha256::digest(DIARY.as_bytes())),
        "c1764ded59b1e56ebf3147cc811e4c23ce315f5b2550a7ff9adca5607057a848"
    );
    let before_tools = tools.clone();
    let projected = capability_context(catalog.clone(), &tools);
    // Same serde boundary used for the native input and dynamicTools. The
    // consumer can resolve every reference from the complete native definitions.
    let wire: Value = serde_json::from_slice(
        &serde_json::to_vec(&json!({"hubCapabilities":projected,"tools":tools})).unwrap(),
    )
    .unwrap();
    assert_eq!(wire["tools"], before_tools);
    let mut restored = wire["hubCapabilities"].clone();
    let mut count = 0;
    let mut unavailable = 0;
    for entry in restored["tools"].as_array_mut().unwrap() {
        if entry.get("inputSchemaState").is_some() {
            let original = catalog["tools"]
                .as_array()
                .unwrap()
                .iter()
                .find(|tool| tool["name"] == entry["name"])
                .unwrap();
            assert_eq!(original["available"], false);
            assert!(!wire["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tool| tool["name"] == entry["name"]));
            let metadata = json!({"name":original["name"],"available":false,"unavailableReason":original["unavailableReason"],"inputSchemaState":"notExposedWhileUnavailable"});
            assert_eq!(
                *entry, metadata,
                "all permission/reason/identity metadata is retained"
            );
            // Host-only audit reconstruction. The model cannot recover or call
            // these unavailable arguments from a fabricated schema reference.
            *entry = original.clone();
            unavailable += 1;
        }
        if let Some(reference) = entry.get("inputSchemaRef").cloned() {
            let definition = wire["tools"]
                .as_array()
                .unwrap()
                .iter()
                .find(|t| t["name"] == reference["nativeTool"])
                .unwrap();
            let fields = entry.as_object_mut().unwrap();
            fields.remove("inputSchemaRef");
            fields.insert("inputSchema".into(), definition["inputSchema"].clone());
            if fields.remove("descriptionRef").is_some() {
                fields.insert("description".into(), definition["description"].clone());
            }
            count += 1;
        }
    }
    assert_eq!(
        restored, catalog,
        "host audit: metadata and callable contracts stay exact; omitted unavailable schemas require original host catalog"
    );
    assert!(count > 0);
    assert!(unavailable > 0);
    assert!(projected.to_string().len() < catalog.to_string().len());
    if let Ok(directory) = std::env::var("HUB_NATIVE_CONTEXT_REPORT") {
        let root = std::path::Path::new(&directory);
        let summary = json!({"unavailableSchemasOmitted":unavailable,"unavailableArgumentsAvailableToModel":false,"schemaReferences":count,"catalogBeforeUtf8Bytes":catalog.to_string().len(),"catalogAfterUtf8Bytes":projected.to_string().len(),"savedUtf8Bytes":catalog.to_string().len()-projected.to_string().len(),"nativeToolSchemaUtf8Bytes":tools.to_string().len(),"sourceSha256":format!("{:x}",sha2::Sha256::digest(DIARY.as_bytes())),"fullContractRestored":restored==catalog,"nativeToolsUnchanged":tools==before_tools});
        for (name, value) in [
            ("context-comparison.json", summary),
            ("catalog-before.json", catalog),
            ("catalog-after.json", projected),
            ("native-tools.json", tools),
        ] {
            std::fs::write(root.join(name), serde_json::to_vec_pretty(&value).unwrap()).unwrap();
        }
    }
}

#[test]
fn omitted_unavailable_schema_never_becomes_a_callable_tool_or_permission() {
    let (f, id, run, catalog, tools) = setup();
    let compact = capability_context(catalog.clone(), &tools);
    let unavailable = compact["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["inputSchemaState"] == "notExposedWhileUnavailable")
        .unwrap();
    let name = unavailable["name"].as_str().unwrap();
    assert_eq!(unavailable["available"], false);
    assert!(!tools
        .as_array()
        .unwrap()
        .iter()
        .any(|tool| tool["name"] == name));
    let mut steps = 0;
    assert!(super::super::arguments::decode(
        &f.root,
        &run,
        &tools,
        &json!({"tool":name,"arguments":{},"callId":"unavailable-only"}),
        &mut steps,
        24
    )
    .unwrap()
    .is_err());
    let work = crate::agent_work::store::load(&f.c(), &id).unwrap();
    let mut environment =
        crate::hub_capabilities::Session::new(&f.root, Some(work.grant.scope().unwrap())).unwrap();
    let denied = environment
        .call(name, &json!({}), "不得扩大授权")
        .unwrap_err();
    assert_eq!(denied, unavailable["unavailableReason"].as_str().unwrap());
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
}

#[test]
fn native_capability_context_keeps_full_schema_without_an_exact_available_base() {
    let (_f, _id, _run, catalog, tools) = setup();
    for absent_catalog in [Value::Null, json!({})] {
        assert_eq!(
            capability_context(absent_catalog.clone(), &tools),
            absent_catalog
        );
    }
    for absent in [Value::Null, json!([])] {
        assert_eq!(capability_context(catalog.clone(), &absent), catalog);
    }
    let compact = capability_context(catalog.clone(), &tools);
    let entry = compact["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t.get("inputSchemaRef").is_some())
        .unwrap();
    let name = entry["name"].as_str().unwrap();
    for case in ["unavailable", "differentSchema", "duplicateDefinition"] {
        let mut original = catalog.clone();
        let mut definitions = tools.clone();
        let target = original["tools"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|t| t["name"] == name)
            .unwrap();
        if case == "unavailable" {
            target["available"] = json!(false);
        }
        let expected = target.clone();
        let definition = definitions
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|t| t["name"] == name)
            .unwrap();
        if case == "differentSchema" {
            definition["inputSchema"] = json!({"type":"object"});
        }
        if case == "duplicateDefinition" {
            let extra = definition.clone();
            definitions.as_array_mut().unwrap().push(extra);
        }
        let result = capability_context(original, &definitions);
        assert_eq!(
            result["tools"]
                .as_array()
                .unwrap()
                .iter()
                .find(|t| t["name"] == name)
                .unwrap(),
            &expected,
            "{case}"
        );
    }
}

#[test]
fn native_context_saved_sleep_requests_retain_original_schema_rejections() {
    let (f, id, run, catalog, tools) = setup();
    let fixtures: Value =
        serde_json::from_str(include_str!("fixtures/sleep-arguments-20261024.json")).unwrap();
    let mut steps = 0;
    let mut results = Vec::new();
    let projected = capability_context(catalog, &tools);
    assert!(projected["tools"].is_array());
    for saved in fixtures["rejected"].as_array().unwrap() {
        let response =
            super::super::arguments::decode(&f.root, &run, &tools, saved, &mut steps, 24)
                .unwrap()
                .err()
                .unwrap();
        assert_eq!(response["error"], saved["error"]);
        results.push(json!({"stage":saved["stage"],"error":response["error"]}));
    }
    for saved in fixtures["accepted"].as_array().unwrap() {
        let tool = super::super::arguments::decode(&f.root, &run, &tools, saved, &mut steps, 24)
            .unwrap()
            .ok()
            .unwrap();
        assert!(matches!(
            tool,
            crate::agent_work::runner::Tool::SleepDataset { .. }
        ));
    }
    assert_eq!(steps, 2);
    assert_eq!(
        crate::agent_work::store::records(&f.root, &id, "toolRejected", 8)
            .unwrap()
            .len(),
        2
    );
    if let Ok(directory) = std::env::var("HUB_NATIVE_CONTEXT_REPORT") {
        std::fs::write(std::path::Path::new(&directory).join("saved-request-replay.json"), serde_json::to_vec_pretty(&json!({"rejected":results,"acceptedSavedRequests":2,"gate":"native arguments::decode, schema and deserialization only; no domain dispatch or model"})).unwrap()).unwrap();
    }
}
