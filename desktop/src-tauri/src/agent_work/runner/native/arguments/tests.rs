use super::*;
use crate::source_evidence::tests::Fixture;
mod full_rows;
mod row_shape;

#[test]
fn reliability_rejected_trace_read_returns_the_actual_page_limit() {
    let (f, id, run, specs) = setup();
    let call = json!({"tool":"hub_traceResult","callId":"oversized-page","arguments":{"recordId":"record","expectedSha256":"a".repeat(64),"startChar":0,"maxChars":32000}});
    let mut steps = 0;
    let feedback = decode(&f.root, &run, &specs, &call, &mut steps, 24)
        .unwrap()
        .err()
        .unwrap();
    assert_eq!(
        feedback["expectedInputSchema"]["properties"]["maxChars"]["maximum"],
        4000
    );
    assert_eq!(steps, 1);
    assert_eq!(feedback["remainingToolSteps"], 23);
    assert_eq!(feedback["toolExecuted"], false);
    assert_eq!(feedback["retryPerformed"], false);
    let recovery = &feedback["recoveryOptions"][0];
    let schema = input::tool_schema(&specs, recovery["tool"].as_str().unwrap()).unwrap();
    crate::model_runtime::validate_agent_tool(&recovery["arguments"], &schema["inputSchema"]).unwrap();
    assert_eq!(recovery["arguments"]["name"], "hub_traceResult");
    assert_eq!(
        store::records(&f.root, &id, "toolRejected", 10)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn link_identity_tool_reaches_shared_capability_with_no_read_or_finish_semantics() {
    let f = Fixture::new();
    let environment = crate::hub_capabilities::Session::new(
        &f.root,
        Some(EvidenceScope::new(vec![], vec![]).unwrap()),
    )
    .unwrap();
    let specs = tools(Some(&environment)).unwrap();
    let mut used = 0;
    let call = json!({"tool":"hub_resolve_link","callId":"link-id","arguments":{"url":"https://app.notion.com/p/page"}});
    assert!(
        matches!(decode(&f.root,"not-needed-for-valid-input",&specs,&call,&mut used,24).unwrap().unwrap(),Tool::Capability{name,..} if name=="hub_resolve_link")
    );
    assert_eq!(
        specs.as_array().unwrap().last().unwrap()["name"],
        "hub_finish"
    );
}

#[test]
fn working_state_native_schema_reaches_the_actual_shared_dispatch_contract() {
    let (f, _id, run, specs) = setup();
    let mut used = 0;
    let call = json!({"tool":"hub_workingState","callId":"read-working-state","arguments":{"request":{"action":"read"}}});
    assert!(matches!(
        decode(&f.root, &run, &specs, &call, &mut used, 24)
            .unwrap()
            .unwrap(),
        Tool::WorkingState { .. }
    ));
    assert_eq!(
        specs.as_array().unwrap().last().unwrap()["name"],
        "hub_finish"
    );
}

#[test]
fn trace_result_native_tool_schema_admits_bounded_reload_and_preserves_finish_position() {
    let (f, _id, run, specs) = setup();
    assert_eq!(
        specs.as_array().unwrap().last().unwrap()["name"],
        "hub_finish"
    );
    let good = json!({"tool":"hub_traceResult","callId":"reload-schema","arguments":{"recordId":"record","expectedSha256":"a".repeat(64),"startChar":0,"maxChars":4000}});
    let mut steps = 0;
    assert!(matches!(
        decode(&f.root, &run, &specs, &good, &mut steps, 24)
            .unwrap()
            .unwrap(),
        Tool::TraceResult {
            max_chars: 4000,
            ..
        }
    ));
    for (key, value) in [
        ("maxChars", json!(4001)),
        ("startChar", json!(-1)),
        ("expectedSha256", json!("short")),
    ] {
        let mut bad = good.clone();
        bad["arguments"][key] = value;
        assert!(decode(&f.root, &run, &specs, &bad, &mut steps, 24)
            .unwrap()
            .is_err());
    }
}

fn setup() -> (Fixture, String, String, Value) {
    let f = Fixture::new();
    f.note("notes", "current", "# 2025-01-01\n主睡眠6.5小时\n");
    let id = crate::agent_work::tests::create(&f, true);
    let (_, run) = crate::agent_work::tests::claim(&f, &id);
    (f, id, run, super::super::tools(None).unwrap())
}

fn call() -> Value {
    // The native argument gate checks the schema. Snapshot and evidence identity
    // are deliberately left to the existing downstream domain tests.
    json!({"tool":"hub_sleepDataset","callId":"offline-call","arguments":{"request":{
        "action":"create","operationId":"offline-create","expectedSnapshot":"snapshot-test","methodRef":"offline-v1",
        "inclusionRule":"actual main sleep only","dateRule":"recorded day, Asia/Shanghai",
        "rows":[{"rowId":"day1","eventRef":"sleep:2025-01-01","rawValue":"主睡眠6.5小时","normalizedValue":6.5,
            "unit":"hours","valueKind":"exact","eventDate":"2025-01-01","timezone":"Asia/Shanghai","dateBasis":"recordedDay",
            "evidenceRefs":[{"itemIndex":0,"sourceRevision":{"bodySha256":"source-hash"},"contentHash":"source-hash","start":0,"end":9,"text":"主睡眠6.5小时"}],
            "reviewState":"accepted_for_analysis","reviewBasis":{"kind":"modelReview","sourceRef":null,"reason":"explicit source value"},
            "ambiguity":"","exclusionReason":"","correctionSource":null,"supersedes":null}]
    }}})
}

#[test]
fn native_sleep_schema_roundtrip_preserves_complete_rows_and_strict_gate() {
    let (f, id, run, specs) = setup();
    // This is the actual native tool list passed unchanged to AgentRequest and
    // serialized as dynamicTools, not a hand-written consumer schema.
    let wire: Value = serde_json::from_slice(&serde_json::to_vec(&specs).unwrap()).unwrap();
    let spec = wire
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == "hub_sleepDataset")
        .unwrap();
    assert_eq!(
        spec["inputSchema"]["properties"]["request"],
        crate::agent_work::artifacts::sleep::schema()
    );
    let fields = spec["inputSchema"]["properties"]["request"]["anyOf"][0]["properties"]["rows"]
        ["items"]["properties"]
        .as_object()
        .unwrap();
    for field in [
        "normalizedValue",
        "reviewBasis",
        "correctionSource",
        "supersedes",
        "evidenceRefs",
        "dateBasis",
    ] {
        assert!(fields.contains_key(field));
    }
    let mut steps = 0;
    // The shared semantic boundary must reach the native wire for both writes.
    // This checks schema delivery, not whether a model will follow the guidance.
    for action in [0, 1] {
        let kind = &spec["inputSchema"]["properties"]["request"]["anyOf"][action]["properties"]
            ["rows"]["items"]["properties"]["valueKind"];
        assert_eq!(
            kind["enum"],
            json!(["exact", "ambiguous", "missing", "conflicting"])
        );
        let description = kind["description"].as_str().unwrap();
        assert!(description.contains("不能仅据此标missing"));
        assert!(description.contains("既无时长数值也无起止时间线索"));
        assert!(description.contains("不为每个日期虚构missing行"));
    }
    let accepted = decode(&f.root, &run, &wire, &call(), &mut steps, 24).unwrap();
    assert!(matches!(accepted, Ok(Tool::SleepDataset { .. })));
    assert_eq!(
        steps, 0,
        "successful dispatch retains existing accounting owner"
    );
    assert!(store::records(&f.root, &id, "toolRejected", 8)
        .unwrap()
        .is_empty());
    let mut missing = call();
    missing["arguments"]["request"]["rows"][0]
        .as_object_mut()
        .unwrap()
        .remove("reviewBasis");
    let rejected = decode(&f.root, &run, &wire, &missing, &mut steps, 24)
        .unwrap()
        .err()
        .unwrap();
    assert!(rejected["error"].as_str().unwrap().contains("reviewBasis"));
    assert_eq!(rejected["expectedInputSchema"], spec["inputSchema"]);
    if let Ok(dir) = std::env::var("HUB_REJECTION_REPORT") {
        std::fs::write(
            Path::new(&dir).join("native-sleep-input-schema.json"),
            serde_json::to_vec_pretty(&spec["inputSchema"]).unwrap(),
        )
        .unwrap();
    }
}

#[test]
fn native_rejection_persists_exact_request_feedback_and_replays_without_model() {
    let (f, id, run, specs) = setup();
    let mut bad = call();
    bad["arguments"]["request"]["rows"][0]["evidenceRefs"][0]["start"] = json!("not-an-integer");
    let mut steps = 0;
    let first = decode(&f.root, &run, &specs, &bad, &mut steps, 24)
        .unwrap()
        .err()
        .unwrap();
    assert_eq!(steps, 1);
    let saved = store::records(&f.root, &id, "toolRejected", 1).unwrap()[0].clone();
    assert_eq!(saved["arguments"], bad["arguments"]);
    assert_eq!(saved["callId"], bad["callId"]);
    assert_eq!(saved["error"], first["error"]);
    assert_eq!(saved["argumentsOmitted"], false);
    assert!(saved["error"]
        .as_str()
        .unwrap()
        .contains(".evidenceRefs[0].start: type"));
    let replay =
        json!({"tool":saved["tool"],"callId":"offline-replay","arguments":saved["arguments"]});
    let again = decode(&f.root, &run, &specs, &replay, &mut steps, 24)
        .unwrap()
        .err()
        .unwrap();
    assert_eq!(again["error"], first["error"]);
    assert_eq!(steps, 2);
    let gate_error =
        crate::model_runtime::validate_agent_tool(&saved["arguments"], &saved["inputSchema"])
            .unwrap_err();
    assert_eq!(gate_error, saved["error"]);
    assert!(store::records(&f.root, &id, "sleepDatasetRevision", 8)
        .unwrap()
        .is_empty());
    if let Ok(dir) = std::env::var("HUB_REJECTION_REPORT") {
        std::fs::write(Path::new(&dir).join("offline-rejection-replay.json"),serde_json::to_vec_pretty(&json!({"origin":"constructed offline counterexample, not historical failed request","saved":saved,"replayedError":again["error"]})).unwrap()).unwrap();
    }
}

#[test]
fn native_rejection_is_bounded_budgeted_and_cannot_write_after_run_ends() {
    let (f, id, run, specs) = setup();
    let mut bad = call();
    bad["arguments"]["request"]["rows"][0]["rawValue"] = json!("大".repeat(30_000));
    let mut steps = 23;
    let rejected = decode(&f.root, &run, &specs, &bad, &mut steps, 24)
        .unwrap()
        .err()
        .unwrap();
    assert_eq!(steps, 24);
    assert_eq!(rejected["remainingToolSteps"], 0);
    assert!(
        rejected.get("rowIssues").is_none(),
        "omitted oversized arguments must not be echoed through recovery details"
    );
    let saved = store::records(&f.root, &id, "toolRejected", 1).unwrap()[0].clone();
    assert_eq!(saved["argumentsOmitted"], true);
    assert!(saved["arguments"].is_null());
    assert!(saved.to_string().len() <= MAX_DIAGNOSTIC_BYTES);
    assert_eq!(
        saved["argumentsSha256"],
        format!(
            "{:x}",
            Sha256::digest(bad["arguments"].to_string().as_bytes())
        )
    );
    assert!(decode(&f.root, &run, &specs, &bad, &mut steps, 24).is_err());
    assert_eq!(
        store::records(&f.root, &id, "toolRejected", 8)
            .unwrap()
            .len(),
        1
    );
    store::write(&f.root, |c| store::reconcile_on(c, &id, &run)).unwrap();
    let error = decode(&f.root, &run, &specs, &bad, &mut 0, 24)
        .err()
        .unwrap();
    assert!(error.contains("结束"));
    assert_eq!(
        store::records(&f.root, &id, "toolRejected", 8)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn native_sleep_provenance_guidance_replays_saved_object_and_keeps_admission_shape() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../artifacts/tests/sleep/fixtures/protocol-feedback-20261024.json"
    ))
    .unwrap();
    let (f, id, run, specs) = setup();
    f.note("notes", "current", fixture["source"].as_str().unwrap());
    let wire: Value = serde_json::from_slice(&serde_json::to_vec(&specs).unwrap()).unwrap();
    let schema = &wire
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["name"] == "hub_sleepDataset")
        .unwrap()["inputSchema"]["properties"]["request"];
    fn validation_shape(value: &Value) -> Value {
        match value {
            Value::Object(fields) => Value::Object(
                fields
                    .iter()
                    .filter(|(k, _)| k.as_str() != "description")
                    .map(|(k, v)| (k.clone(), validation_shape(v)))
                    .collect(),
            ),
            Value::Array(values) => Value::Array(values.iter().map(validation_shape).collect()),
            value => value.clone(),
        }
    }
    let shape = validation_shape(schema);
    // Keep the legacy hash; isolate only the already-shipped capacity and batch action additions.
    let mut legacy_shape = shape.clone();
    let choices = legacy_shape["anyOf"].as_array_mut().unwrap();
    assert_eq!(choices.len(), 4);
    let batch = choices.pop().unwrap();
    assert_eq!(
        batch,
        json!({"type":"object","additionalProperties":false,"required":["action","datasets"],"properties":{
            "action":{"type":"string","enum":["batchSummary"]},
            "datasets":{"type":"array","minItems":1,"maxItems":8,"items":{"type":"object","additionalProperties":false,"required":["datasetId","revision"],"properties":{"datasetId":{"type":"string","minLength":1,"maxLength":180},"revision":{"type":"integer","minimum":1,"maximum":32}}}}
        }})
    );
    for action in [0, 1] {
        let maximum = &mut legacy_shape["anyOf"][action]["properties"]["rows"]["items"]
            ["properties"]["evidenceRefs"]["items"]["properties"]["itemIndex"]["maximum"];
        assert_eq!(*maximum, 31);
        *maximum = json!(15);
    }
    assert_eq!(
        format!("{:x}", Sha256::digest(legacy_shape.to_string().as_bytes())),
        fixture["schemaValidationSha256"]
    );
    for action in [0, 1] {
        let fields = &schema["anyOf"][action]["properties"]["rows"]["items"]["properties"];
        assert!(fields["correctionSource"]["description"]
            .as_str()
            .unwrap()
            .contains("新增行"));
        assert!(fields["supersedes"]["description"]
            .as_str()
            .unwrap()
            .contains("expectedRevision:rowId"));
        assert!(fields["supersedes"]["description"]
            .as_str()
            .unwrap()
            .contains("未改动行保留"));
    }
    let saved = &fixture["schemaRejected"];
    let mut steps = 0;
    let rejected = decode(&f.root, &run, &wire, saved, &mut steps, 24)
        .unwrap()
        .err()
        .unwrap();
    assert_eq!(rejected["error"], saved["expectedError"]);
    assert_eq!(steps, 1);
    assert_eq!(rejected["remainingToolSteps"], 23);
    assert_eq!(
        rejected["expectedInputSchema"]["properties"]["request"],
        *schema
    );
    let recorded = store::records(&f.root, &id, "toolRejected", 1).unwrap();
    assert_eq!(recorded[0]["arguments"], saved["arguments"]);
    assert!(store::records(&f.root, &id, "sleepDatasetRevision", 1)
        .unwrap()
        .is_empty());
    if let Ok(directory) = std::env::var("HUB_SLEEP_PROTOCOL_REPORT") {
        std::fs::write(Path::new(&directory).join("schema-protocol-replay.json"), serde_json::to_vec_pretty(&json!({"legacyValidationShapeSha256":fixture["schemaValidationSha256"],"currentValidationShapeSha256":format!("{:x}",Sha256::digest(shape.to_string().as_bytes())),"declaredValidationAdditions":{"sourceIndexMaximum":{"legacy":15,"current":31},"batchSummary":{"datasetsMaximum":8,"revisionMaximum":32,"exactShapeSeparatelyChecked":true},"authority":"INSIGHTS_IMPLEMENTATION_PLAN 9.83 and9.138 scope continuation; legacy fixture/hash unchanged"},"savedObjectRejected":rejected["error"],"fieldGuidanceOnNativeWire":true,"rejectionBudgetCounted":true,"rejectedArgumentsPreserved":true})).unwrap()).unwrap();
    }
}
