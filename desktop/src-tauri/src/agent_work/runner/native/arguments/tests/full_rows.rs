use super::*;

fn frozen() -> Value {
    serde_json::from_str(include_str!("fixtures/full-rows-20261024.json")).unwrap()
}
fn output(name: &str, value: &Value) {
    if let Ok(directory) = std::env::var("HUB_SLEEP_FULL_ROWS_REPORT") {
        std::fs::write(
            Path::new(&directory).join(name),
            serde_json::to_vec_pretty(value).unwrap(),
        )
        .unwrap();
    }
}
fn saved_call(request: &Value) -> Value {
    json!({"tool":"hub_sleepDataset","callId":"offline-full-rows","arguments":{"request":request}})
}

#[test]
fn saved_short_sleep_rows_replay_without_normalization_and_disclose_full_contract() {
    let fixture = frozen();
    let (f, id, run, specs) = setup();
    f.note("notes", "current", fixture["source"].as_str().unwrap());
    assert_eq!(
        format!(
            "{:x}",
            Sha256::digest(fixture["source"].as_str().unwrap().as_bytes())
        ),
        fixture["sourceHash"]
    );
    let wire: Value = serde_json::from_slice(&serde_json::to_vec(&specs).unwrap()).unwrap();
    let spec = wire
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["name"] == "hub_sleepDataset")
        .unwrap();
    assert!(spec["description"]
        .as_str()
        .unwrap()
        .contains("date/hours/rowId"));
    for action in [0, 1] {
        let rows =
            &spec["inputSchema"]["properties"]["request"]["anyOf"][action]["properties"]["rows"];
        assert!(rows["description"].as_str().unwrap().contains("完整行"));
        assert!(rows["items"]["description"]
            .as_str()
            .unwrap()
            .contains("缺字段不等于 null"));
    }
    let work = store::load(&f.c(), &id).unwrap();
    let mut environment =
        crate::hub_capabilities::Session::new(&f.root, Some(work.grant.scope().unwrap())).unwrap();
    let loaded = environment.load("hub-statistics", "按主睡眠统计").unwrap();
    assert!(loaded["instructions"]
        .as_str()
        .unwrap()
        .contains("不为取得 datasetId"));
    assert!(loaded["instructions"]
        .as_str()
        .unwrap()
        .contains("date/hours/rowId"));
    let saved = &fixture["rejected"];
    let mut steps = 0;
    let rejected = decode(&f.root, &run, &wire, saved, &mut steps, 24)
        .unwrap()
        .err()
        .unwrap();
    assert_eq!(rejected["error"], saved["error"]);
    assert_eq!(rejected["remainingToolSteps"], 23);
    assert_eq!(rejected["rowIssues"][0]["rowIndex"], 0);
    assert_eq!(
        rejected["rowIssues"][0]["missingRequiredFields"],
        fixture["rowFieldReview"][0]["missingRequiredFields"]
    );
    assert_eq!(
        rejected["rowIssues"][0]["unknownFields"],
        json!(["date", "hours"])
    );
    assert_eq!(rejected["rowIssues"][0]["unknownFieldCount"], 2);
    assert_eq!(rejected["expectedInputSchema"], spec["inputSchema"]);
    let record = store::records(&f.root, &id, "toolRejected", 1).unwrap()[0].clone();
    assert_eq!(record["arguments"], saved["arguments"]);
    assert_eq!(record["error"], saved["error"]);
    assert_eq!(record["rowIssues"], rejected["rowIssues"]);
    assert_eq!(
        record["rowSubmissionPolicy"],
        rejected["rowSubmissionPolicy"]
    );
    assert!(record.to_string().len() <= MAX_DIAGNOSTIC_BYTES);
    // Both legal alternatives remain valid at the unchanged admission gate.
    // No source validation or persistence is implied by schema admission alone.
    for accepted in fixture["accepted"].as_array().unwrap() {
        let request = &accepted["request"]["request"];
        let tool = decode(&f.root, &run, &wire, &saved_call(request), &mut steps, 24)
            .unwrap()
            .ok()
            .unwrap();
        assert_eq!(
            serde_json::to_value(tool).unwrap()["request"],
            *request,
            "never fill or convert model fields"
        );
    }
    assert_eq!(steps, 1);
    assert!(store::records(&f.root, &id, "sleepDatasetRevision", 1)
        .unwrap()
        .is_empty());
    output(
        "saved-short-row-replay.json",
        &json!({"sourceSha256":fixture["sourceHash"],"originalError":saved["error"],"feedback":rejected,"argumentsPreserved":true,"emptyCreateStillAdmitted":true,"savedCompleteRowsAdmittedUnchanged":true,"domainWrites":0,"guidanceOnNativeWireAndLoadedSkill":true}),
    );
}

#[test]
fn sleep_row_recovery_is_bounded_and_never_accepts_date_hours_aliases() {
    let fixture = frozen();
    let (f, id, run, specs) = setup();
    f.note("notes", "current", fixture["source"].as_str().unwrap());
    let mut call = fixture["rejected"].clone();
    let mut row = call["arguments"]["request"]["rows"][0].clone();
    for index in 0..12 {
        row[format!("unknown_{index}")] = json!(true);
    }
    row["non_schema_".repeat(12)] = json!(true);
    call["arguments"]["request"]["rows"] = json!(vec![row; 10]);
    let mut steps = 0;
    let rejected = decode(&f.root, &run, &specs, &call, &mut steps, 24)
        .unwrap()
        .err()
        .unwrap();
    assert_eq!(rejected["rowIssueLimit"], 4);
    assert_eq!(rejected["rowIssues"].as_array().unwrap().len(), 4);
    assert!(rejected["rowIssues"].to_string().len() < 8192);
    for issue in rejected["rowIssues"].as_array().unwrap() {
        assert_eq!(issue["unknownFieldCount"], 15);
        assert_eq!(issue["unknownFields"].as_array().unwrap().len(), 8);
        assert!(issue["unknownFields"]
            .as_array()
            .unwrap()
            .iter()
            .all(|name| name.as_str().unwrap().len() <= 80));
    }
    let mut complete = fixture["accepted"][1]["request"]["request"].clone();
    complete["rows"][0]["date"] = json!("2025-01-01");
    complete["rows"][0]["hours"] = json!(6.5);
    let aliases = saved_call(&complete);
    let alias_error = decode(&f.root, &run, &specs, &aliases, &mut steps, 24)
        .unwrap()
        .err()
        .unwrap();
    assert_eq!(
        alias_error["rowIssues"][0]["missingRequiredFields"],
        json!([])
    );
    assert_eq!(
        alias_error["rowIssues"][0]["unknownFields"],
        json!(["date", "hours"])
    );
    assert_eq!(steps, 2);
    let records = store::records(&f.root, &id, "toolRejected", 2).unwrap();
    assert_eq!(records[0]["arguments"], aliases["arguments"]);
    assert_eq!(records[1]["arguments"], call["arguments"]);
    assert!(store::records(&f.root, &id, "sleepDatasetRevision", 1)
        .unwrap()
        .is_empty());
    output(
        "bounded-row-recovery.json",
        &json!({"issuesLimit":4,"unknownNamesLimit":8,"unknownNameByteLimit":80,"diagnosticBytes":rejected["rowIssues"].to_string().len(),"completeRowsWithAliasesStillRejected":true,"noNormalizationOrDomainWrite":true,"budgetedRejections":steps}),
    );
}
