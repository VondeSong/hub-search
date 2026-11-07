use super::*;

#[test]
#[ignore = "explicit authorized month manifest, reference and private profile required; no model"]
fn selected_month_reference_preserves_unknowns_and_cannot_complete_a_chart_goal() {
    let load = |name: &str| -> Value {
        serde_json::from_slice(&std::fs::read(std::env::var(name).unwrap()).unwrap()).unwrap()
    };
    let manifest = load("HUB_SLEEP_MONTH_MANIFEST");
    let reference = load("HUB_SLEEP_MONTH_REFERENCE");
    assert_eq!(reference["version"], "selected-month-reference-v1");
    assert_eq!(reference["formalGold"], false);
    let source_root =
        std::fs::canonicalize(manifest["selection"]["sourceDirectory"].as_str().unwrap()).unwrap();
    let profile = PathBuf::from(std::env::var("HUB_SLEEP_MONTH_PROFILE").unwrap());
    let policy = std::fs::read(profile.join("analysis-snapshot-policy.json")).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&policy).unwrap(),
        json!({"retentionHours":168,"maxStoreMib":128})
    );
    let (f, old, old_chart, delivery) = protected();
    std::fs::write(f.root.join("analysis-snapshot-policy.json"), policy).unwrap();
    let mut ids = Vec::new();
    let inputs = manifest["inputs"].as_array().unwrap();
    assert_eq!(inputs.len(), 26);
    for (index, item) in inputs.iter().enumerate() {
        let day = item["recordedDay"].as_str().unwrap();
        assert!(day.starts_with("2025-07-") && day.len() == 10);
        let path = std::fs::canonicalize(source_root.join(format!("{day}.md"))).unwrap();
        assert_eq!(path.parent(), Some(source_root.as_path()));
        let bytes = std::fs::read(path).unwrap();
        assert_eq!(format!("{:x}", Sha256::digest(&bytes)), item["sha256"]);
        let id = format!("reference-{index:02}");
        f.note("notes", &id, &String::from_utf8(bytes).unwrap());
        f.c()
            .execute(
                "UPDATE documents SET title=?1,path=?2 WHERE space_id='notes' AND id=?3",
                rusqlite::params![day, format!("selected-month/{day}.md"), id],
            )
            .unwrap();
        ids.push(id);
    }
    let (work, run, snapshot, mut request) = selected_work(&f, &ids, false);
    let reader = work.grant.reader(&f.root).unwrap();
    let listed = analysis::execute(
        &reader,
        "hub_list_note_sources",
        &json!({"expectedSnapshot":snapshot["snapshot"],"limit":32}),
    )
    .unwrap();
    let annotations = reference["rows"].as_array().unwrap();
    assert_eq!(annotations.len(), 8);
    let rows: Vec<Value> = annotations.iter().map(|annotation| {
        let item = listed["notes"].as_array().unwrap().iter()
            .find(|item| item["title"] == annotation["recordedDay"]).unwrap();
        let index = item["itemIndex"].as_u64().unwrap() as usize;
        let captured = source(&f, &work, &snapshot, index);
        assert_eq!(captured["sourceRevision"]["bodySha256"], annotation["sourceSha256"]);
        let start = annotation["span"]["start"].as_u64().unwrap() as usize;
        let end = annotation["span"]["end"].as_u64().unwrap() as usize;
        let text: String = captured["content"].as_str().unwrap().chars().skip(start).take(end-start).collect();
        assert_eq!(format!("{:x}",Sha256::digest(text.as_bytes())), annotation["span"]["utf8Sha256"]);
        let mut row = row(&captured, annotation["rowId"].as_str().unwrap(),
            annotation["recordedDay"].as_str().unwrap(), &text, None);
        assert_eq!(row["evidenceRefs"][0]["start"], start);
        assert_eq!(row["evidenceRefs"][0]["end"], end);
        row["evidenceRefs"][0]["itemIndex"] = json!(index);
        row["valueKind"] = annotation["valueKind"].clone();
        row["ambiguity"] = annotation["reasonCode"].clone();
        row["exclusionReason"] = json!("No explicit actual main-sleep duration; never impute zero or subtract clock clues.");
        row["reviewBasis"]["reason"] = json!("Offline close-reading reference; not autonomous generation or a user correction.");
        row
    }).collect();
    request["rows"] = json!(rows);
    let result = dataset(&f, &work, &run, &request);
    output(
        "reference-entry.json",
        &json!({"outcome":if result.is_ok(){"accepted"}else{"rejected"},
        "error":result.as_ref().err(),"modelCalls":0,"autonomousExtractionVerified":false,"referenceRows":8}),
    );
    let saved = result.unwrap();
    let coverage = &saved["content"]["coverage"];
    assert_eq!(coverage["material"]["read"], 26);
    assert_eq!(coverage["dates"]["fileDateSections"], 26);
    assert_eq!(coverage["metric"]["candidates"], 8);
    assert_eq!(coverage["metric"]["ambiguous"], 6);
    assert_eq!(coverage["metric"]["missing"], 2);
    assert_eq!(coverage["metric"]["accepted"], 0);
    assert_eq!(coverage["metric"]["datesWithoutAcceptedValue"], 26);
    let chart_error = execute(
        &f.root,
        &work,
        &run,
        &chart_request(&saved),
        &Control::default(),
    )
    .unwrap_err();
    assert!(chart_error.contains("不将缺失或歧义补零"), "{chart_error}");
    assert!(store::records(&f.root, &work.id, "chartRevision", 32)
        .unwrap()
        .is_empty());
    assert!(
        store::goal::completion::read_context(&f.root, &work, &run).unwrap()["proofs"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_ne!(
        store::view(&f.root, &work.id).unwrap()["goalAssessment"]["workFulfillment"],
        "fulfilled"
    );
    assert!(preserved(&f, &old, &old_chart, &delivery));
    for item in inputs {
        let bytes = std::fs::read(
            source_root.join(format!("{}.md", item["recordedDay"].as_str().unwrap())),
        )
        .unwrap();
        assert_eq!(format!("{:x}", Sha256::digest(bytes)), item["sha256"]);
    }
    output(
        "reference-validation.json",
        &json!({"coverage":coverage,"chartRejection":chart_error,
        "chartCreated":false,"completionProofCreated":false,"workFulfilled":false,
        "existingChartAndReportPreserved":true,"alignedSpans":8,"originalsUnchanged":26,
        "productionPolicyUsed":true,"runnerBudgetExercised":false,"modelCalls":0,
        "autonomousExtractionVerified":false,"formalV1Gate":false}),
    );
}
