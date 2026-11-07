use super::*;
use crate::agent_work::{artifacts, assistant};

#[test]
fn schema_row_checklist_is_visible_before_writes_and_saved_three_fields_still_fail() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/row-shape-20261024.json")).unwrap();
    let f = Fixture::new();
    let body = fixture["source"].as_str().unwrap();
    assert_eq!(
        format!("{:x}", Sha256::digest(body.as_bytes())),
        fixture["sourceHash"]
    );
    assert_eq!((body.chars().count(), body.len()), (141, 317));
    f.note("notes", "current", body);
    let anchor = EvidenceLocator::Note {
        library_id: "notes".into(),
        document_id: "current".into(),
        page_id: None,
    };
    let id = store::create(
        &f.root,
        fixture["goal"].as_str().unwrap().into(),
        "完整候选、固定出处、保留纠正历史".into(),
        anchor.clone(),
        Grant {
            notes: vec![anchor],
            ..Default::default()
        },
    )
    .unwrap();
    let (work, run) = crate::agent_work::tests::claim(&f, &id);
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
    let capabilities = session.capabilities().unwrap();
    let specs = super::super::super::tools(None).unwrap();
    let wire: Value = serde_json::from_slice(
        &serde_json::to_vec(&json!({"dynamicTools":specs,"capabilities":capabilities})).unwrap(),
    )
    .unwrap();
    let spec = wire["dynamicTools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["name"] == "hub_sleepDataset")
        .unwrap();
    let row =
        &spec["inputSchema"]["properties"]["request"]["anyOf"][0]["properties"]["rows"]["items"];
    let checklist = &wire["capabilities"]["sleepRowChecklist"];
    assert_eq!(checklist["kind"], "requiredFieldChecklist");
    assert_eq!(checklist["valuesProvided"], false);
    assert_eq!(checklist["requiredFields"], row["required"]);
    assert_eq!(checklist["requiredFields"].as_array().unwrap().len(), 16);
    assert_eq!(
        checklist["evidenceRequiredFields"],
        row["properties"]["evidenceRefs"]["items"]["required"]
    );
    assert_eq!(
        checklist["reviewRequiredFields"],
        row["properties"]["reviewBasis"]["required"]
    );
    assert_eq!(checklist, &artifacts::sleep::row_checklist());
    assert!(spec["description"]
        .as_str()
        .unwrap()
        .contains(&checklist["requiredFields"].to_string()));
    assert!(store::records(&f.root, &id, "sleepDatasetRevision", 1)
        .unwrap()
        .is_empty());
    assert!(
        !store::goal::completion::read_context(&f.root, &work, &run).unwrap()["proofs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["kind"] == "chart")
    );
    let saved = &fixture["rejected"];
    let mut steps = 0;
    let feedback = decode(&f.root, &run, &wire["dynamicTools"], saved, &mut steps, 24)
        .unwrap()
        .err()
        .unwrap();
    assert_eq!(feedback["error"], saved["error"]);
    assert_eq!(
        feedback["rowIssues"][0]["missingRequiredFields"],
        saved["rowIssues"][0]["missingRequiredFields"]
    );
    assert_eq!(
        feedback["rowIssues"][0]["missingRequiredFields"]
            .as_array()
            .unwrap()
            .len(),
        13
    );
    assert_eq!(feedback["rowIssues"][0]["unknownFields"], json!([]));
    let keys = saved["arguments"]["request"]["rows"][0]
        .as_object()
        .unwrap();
    let missing: Vec<_> = checklist["requiredFields"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|key| !keys.contains_key(key.as_str().unwrap()))
        .cloned()
        .collect();
    assert_eq!(
        feedback["rowIssues"][0]["missingRequiredFields"],
        json!(missing)
    );
    assert_eq!(
        store::records(&f.root, &id, "toolRejected", 1).unwrap()[0]["arguments"],
        saved["arguments"]
    );
    assert!(store::records(&f.root, &id, "sleepDatasetRevision", 1)
        .unwrap()
        .is_empty());
    // The checklist supplies no facts. Rebind only a saved complete candidate's
    // isolated source/snapshot identities, then use the unchanged formal gates.
    let reader = work.grant.reader(&f.root).unwrap();
    let snapshot = crate::source_evidence::analysis::execute(
        &reader,
        "hub_create_analysis_snapshot",
        &json!({}),
    )
    .unwrap();
    let captured = crate::source_evidence::analysis::execute(
        &reader,
        "hub_read_analysis_snapshot",
        &json!({"expectedSnapshot":snapshot["snapshot"],"itemIndex":0,"start":0,"limit":8000}),
    )
    .unwrap();
    assert_eq!(captured["content"], fixture["source"]);
    let mut request = fixture["acceptedCreate"].clone();
    request["expectedSnapshot"] = snapshot["snapshot"].clone();
    for row in request["rows"].as_array_mut().unwrap() {
        for evidence in row["evidenceRefs"].as_array_mut().unwrap() {
            evidence["sourceRevision"] = captured["sourceRevision"].clone();
            evidence["contentHash"] = captured["sourceRevision"]["bodySha256"].clone();
        }
    }
    let call = json!({"tool":"hub_sleepDataset","callId":"offline-complete-checklist","arguments":{"request":request}});
    let tool = decode(&f.root, &run, &wire["dynamicTools"], &call, &mut steps, 24)
        .unwrap()
        .ok()
        .unwrap();
    assert_eq!(serde_json::to_value(&tool).unwrap()["request"], request);
    let dataset = session.dispatch(tool).unwrap();
    assert_eq!(dataset["revision"], 1);
    assert_eq!(dataset["content"]["coverage"]["metric"]["accepted"], 2);
    assert!(
        !store::goal::completion::read_context(&f.root, &work, &run).unwrap()["proofs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["kind"] == "chart")
    );
    let chart = session.dispatch(Tool::Chart { request:json!({"action":"create","operationId":"checklist-chart","analysis":{"source":"sleepDataset","expectedSnapshot":snapshot["snapshot"],"datasetId":dataset["datasetId"],"datasetRevision":dataset["revision"],"aggregation":"monthlyMean"},"spec":{"title":"主睡眠月均","mark":"bar","metric":"sleep_duration_hours","term":null,"sort":"groupAsc"}}) }).unwrap();
    assert_eq!(
        chart["content"]["data"]["rows"],
        json!([{"group":"2025-01","value":7.25,"sampleCount":2}])
    );
    session.dispatch(Tool::Chart { request:json!({"action":"validate","artifactId":chart["artifactId"],"revision":chart["revision"]}) }).unwrap();
    assert!(
        store::goal::completion::read_context(&f.root, &work, &run).unwrap()["proofs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["kind"] == "chart")
    );
    assert_eq!(steps, 1);
    if let Ok(directory) = std::env::var("HUB_SLEEP_ROW_SHAPE_REPORT") {
        std::fs::write(Path::new(&directory).join("upfront-checklist-replay.json"), serde_json::to_vec_pretty(&json!({"checklist":checklist,"beforeWriteChecklistObserved":true,"notEvidenceOrDefaultValues":true,"savedError":feedback["error"],"missingFields":feedback["rowIssues"][0]["missingRequiredFields"],"argumentsUnchanged":true,"completeCandidateRevision":1,"chartMean":7.25,"chartProofOnlyAfterValidation":true,"sourceSha256":fixture["sourceHash"],"onlyIdentityRebinding":["snapshot","sourceRevision"]})).unwrap()).unwrap();
    }
}
