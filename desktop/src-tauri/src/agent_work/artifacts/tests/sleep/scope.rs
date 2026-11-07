use super::*;
mod capacity;
mod case_triggers;
mod chart_capacity;
mod formal_coverage;
mod formal_initial;
mod reference;
mod storage_faults;

const QUOTE: &str = "昨夜主睡眠实际睡了7小时。";

fn output(name: &str, value: &Value) {
    if let Ok(directory) = std::env::var("HUB_SLEEP_SCOPE_REPORT") {
        std::fs::write(
            Path::new(&directory).join(name),
            serde_json::to_vec_pretty(value).unwrap(),
        )
        .unwrap();
    }
}

fn selected_work(f: &Fixture, ids: &[String], whole: bool) -> (Work, String, Value, Value) {
    let locator =
        |id: &str| json!({"kind":"note","libraryId":"notes","documentId":id,"pageId":null});
    let notes = if whole {
        vec![locator(&ids[0])]
    } else {
        ids.iter().map(|id| locator(id)).collect::<Vec<_>>()
    };
    let view=ui(&f.root,&json!({"action":"create","goal":"核对所选日记的主睡眠并保留图表和出处","successCriteria":"全范围，不修改原文，空值不补零","anchor":locator(&ids[0]),"grant":{"libraryIds":if whole{vec!["notes"]}else{vec![]},"notes":notes,"readingItemKeys":[]}})).unwrap();
    let (work, run) = crate::agent_work::tests::claim(f, view["work"]["id"].as_str().unwrap());
    let reader = work.grant.reader(&f.root).unwrap();
    let snapshot = analysis::execute(
        &reader,
        "hub_create_analysis_snapshot",
        &if whole {
            json!({"query":"scope-month/"})
        } else {
            json!({})
        },
    )
    .unwrap();
    let request = json!({"action":"create","operationId":"month-input","expectedSnapshot":snapshot["snapshot"],"methodRef":"scoped-month-offline","inclusionRule":"仅明确实际主睡眠，不补零","dateRule":"先固定标题日期段，无标题时核对固定文件记录日","rows":[]});
    (work, run, snapshot, request)
}

fn source(f: &Fixture, work: &Work, snapshot: &Value, index: usize) -> Value {
    analysis::execute(
        &work.grant.reader(&f.root).unwrap(),
        "hub_read_analysis_snapshot",
        &json!({"expectedSnapshot":snapshot["snapshot"],"itemIndex":index,"start":0,"limit":8000}),
    )
    .unwrap()
}

fn seed(f: &Fixture, count: usize, body: &str) -> Vec<String> {
    (0..count)
        .map(|index| {
            let id = format!("scope-{index:02}");
            let day = if index < 31 {
                format!("2025-07-{:02}", index + 1)
            } else {
                format!("2025-08-{:02}", index - 30)
            };
            f.note("notes", &id, body);
            f.c()
                .execute(
                    "UPDATE documents SET title=?1,path=?2 WHERE space_id='notes' AND id=?3",
                    rusqlite::params![day, format!("scope-month/{day}.md"), id],
                )
                .unwrap();
            id
        })
        .collect()
}

fn protected() -> (Fixture, String, Value, Value) {
    let (f, work, run, mut request, source) = setup_sleep(DIARY);
    request["rows"] = labeled(&source);
    let saved = dataset(&f, &work, &run, &request).unwrap();
    let chart = call(&f, &work, &run, &chart_request(&saved));
    call(
        &f,
        &work,
        &run,
        &json!({"action":"validate","artifactId":chart["artifactId"],"revision":1}),
    );
    let report = accepted_report(&f, &work, &run, "保留已有合成成果");
    publish(&f, &work, &run, &report).unwrap();
    let delivery = store::records(&f.root, &work.id, "delivery", 1).unwrap()[0].clone();
    (f, work.id, chart["content"].clone(), delivery)
}

fn preserved(f: &Fixture, id: &str, chart: &Value, delivery: &Value) -> bool {
    let view = store::view(&f.root, id).unwrap();
    view["work"]["state"] == "completed"
        && view["goalAssessment"]["workFulfillment"] == "fulfilled"
        && view["analysisArtifacts"][0]["state"] == "checked"
        && view["analysisArtifacts"][0]["content"] == *chart
        && store::records(&f.root, id, "delivery", 1).unwrap()[0] == *delivery
}

#[test]
fn sleep_scope_headerless_file_day_and_last_source_index_keep_exact_evidence() {
    let f = Fixture::new();
    let body = format!("学习 💤e\u{301}\n{QUOTE}");
    let ids = seed(&f, 1, &body);
    let (work, run, snapshot, mut request) = selected_work(&f, &ids, false);
    let first = source(&f, &work, &snapshot, 0);
    request["rows"] = json!([row(&first, "day-one", "2025-07-01", QUOTE, Some(7.0))]);
    let admitted = dataset(&f, &work, &run, &request);
    output(
        "filename-entry.json",
        &json!({"sourceCount":1,"bodyHasDateHeading":false,"outcome":if admitted.is_ok(){"accepted"}else{"rejected"},"error":admitted.as_ref().err(),"sourceBodyUnchanged":first["content"]==body}),
    );
    assert!(
        admitted.is_ok(),
        "headerless recorded-day entry rejected: {}",
        admitted.unwrap_err()
    );
    let saved = admitted.unwrap();
    assert_eq!(
        saved["content"]["coverage"]["dates"]["recognizedSections"],
        1
    );
    assert_eq!(saved["content"]["coverage"]["dates"]["fileDateSections"], 1);
    assert_eq!(
        saved["content"]["coverage"]["dates"]["unassignedCharacters"],
        0
    );
    let chart = call(&f, &work, &run, &chart_request(&saved));
    assert_eq!(
        chart["content"]["data"]["rows"],
        json!([{"group":"2025-07","value":7.0,"sampleCount":1}])
    );

    let wide = Fixture::new();
    let ids = seed(&wide, 32, &body);
    let (work, run, snapshot, mut request) = selected_work(&wide, &ids, false);
    let last = source(&wide, &work, &snapshot, 31);
    let mut candidate = row(&last, "last-source", "2025-08-01", QUOTE, Some(7.0));
    candidate["evidenceRefs"][0]["itemIndex"] = json!(31);
    request["rows"] = json!([candidate]);
    let saved = dataset(&wide, &work, &run, &request).unwrap();
    assert_eq!(saved["content"]["coverage"]["material"]["read"], 32);
    assert_eq!(saved["content"]["coverage"]["dates"]["uniqueDates"], 32);
    let mut invalid = request.clone();
    invalid["operationId"] = json!("bad-index");
    invalid["rows"][0]["evidenceRefs"][0]["itemIndex"] = json!(32);
    let index_error = dataset(&wide, &work, &run, &invalid).unwrap_err();
    output(
        "index-rejection.json",
        &json!({"rejectedIndex":32,"error":index_error}),
    );
    assert!(
        index_error.contains("$.request.rows[0].evidenceRefs[0].itemIndex: range]"),
        "{index_error}"
    );
    assert_eq!(
        store::records(&wide.root, &work.id, "sleepDatasetRevision", 32)
            .unwrap()
            .len(),
        1
    );

    for (path, title, text, date) in [
        ("undated.md", "undated", QUOTE, "2025-07-01"),
        ("2025-02-30.md", "undated", QUOTE, "2025-07-01"),
        ("2025-07-01.md", "2025-07-02", QUOTE, "2025-07-01"),
        (
            "2025-07-01.md",
            "2025-07-01",
            "# 2025-07-02\n昨夜主睡眠实际睡了7小时。",
            "2025-07-01",
        ),
    ] {
        let bad = Fixture::new();
        bad.note("notes", "one", text);
        bad.c()
            .execute(
                "UPDATE documents SET path=?1,title=?2 WHERE id='one'",
                rusqlite::params![path, title],
            )
            .unwrap();
        let (w, r, s, mut request) = selected_work(&bad, &["one".into()], false);
        let excerpt = source(&bad, &w, &s, 0);
        request["rows"] = json!([row(&excerpt, "bad-day", date, QUOTE, Some(7.0))]);
        assert!(dataset(&bad, &w, &r, &request)
            .unwrap_err()
            .contains("归日"));
        assert!(store::records(&bad.root, &w.id, "sleepDatasetRevision", 32)
            .unwrap()
            .is_empty());
    }
    output(
        "file-and-index-guards.json",
        &json!({"maxSourcesRead":32,"lastIndexAccepted":31,"index32Rejected":true,"missingInvalidConflictingFilenameAndHeadingOverrideRejected":true,"rawScalarEvidenceUnchanged":true}),
    );
}

#[test]
fn sleep_scope_capacity_and_long_note_refusals_preserve_delivered_results() {
    let (f, old, chart, delivery) = protected();
    let ids = seed(&f, 33, QUOTE);
    let (work, run, snapshot, request) = selected_work(&f, &ids, true);
    assert_eq!(snapshot["itemsTotal"], 33);
    let error = dataset(&f, &work, &run, &request).unwrap_err();
    assert!(error.contains("固定材料"));
    assert!(
        store::records(&f.root, &work.id, "sleepDatasetRevision", 32)
            .unwrap()
            .is_empty()
    );
    assert!(preserved(&f, &old, &chart, &delivery));
    let other = Fixture::new();
    let ids = seed(&other, 1, &"长".repeat(8001));
    let (w, r, _, request) = selected_work(&other, &ids, false);
    assert!(dataset(&other, &w, &r, &request)
        .unwrap_err()
        .contains("8000"));
    assert!(
        store::records(&other.root, &w.id, "sleepDatasetRevision", 32)
            .unwrap()
            .is_empty()
    );
    output(
        "capacity-refusals.json",
        &json!({"selectedCount":33,"error":error,"noRejectedDatasetWritten":true,"existingCheckedChartAndDeliveryPreserved":true,"singleNote8001CharactersRejected":true}),
    );
}

#[test]
#[ignore = "explicit authorized 26-file manifest and private isolated temp root required"]
fn sleep_scope_selected_real_month_26_notes_enters_without_losing_existing_delivery() {
    let path = std::env::var("HUB_SLEEP_MONTH_MANIFEST").expect("set authorized manifest");
    let manifest: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(manifest["selection"]["targetStart"], "2025-07-01");
    assert_eq!(manifest["selection"]["targetEnd"], "2025-07-31");
    let inputs = manifest["inputs"].as_array().unwrap();
    assert_eq!(inputs.len(), 26);
    let root =
        std::fs::canonicalize(manifest["selection"]["sourceDirectory"].as_str().unwrap()).unwrap();
    let (f, old, chart, delivery) = protected();
    std::fs::write(
        f.root.join("analysis-snapshot-policy.json"),
        b"{\"retentionHours\":168,\"maxStoreMib\":128}",
    )
    .unwrap();
    let mut ids = Vec::new();
    let mut scalars = 0;
    let mut byte_count = 0;
    for (index, item) in inputs.iter().enumerate() {
        let day = item["recordedDay"].as_str().unwrap();
        assert!(
            day.len() == 10
                && day.starts_with("2025-07-")
                && day.bytes().all(|b| b.is_ascii_digit() || b == b'-')
        );
        let file = std::fs::canonicalize(root.join(format!("{day}.md"))).unwrap();
        assert!(
            file.parent() == Some(root.as_path()),
            "source escaped selected directory"
        );
        let bytes = std::fs::read(&file).unwrap();
        assert!(
            format!("{:x}", Sha256::digest(&bytes)) == item["sha256"].as_str().unwrap(),
            "frozen original hash changed"
        );
        byte_count += bytes.len();
        let body = String::from_utf8(bytes).unwrap();
        scalars += body.trim_start_matches('\u{feff}').chars().count();
        let id = format!("real-month-{index:02}");
        f.note("notes", &id, &body);
        f.c()
            .execute(
                "UPDATE documents SET title=?1,path=?2 WHERE space_id='notes' AND id=?3",
                rusqlite::params![day, format!("selected-month/{day}.md"), id],
            )
            .unwrap();
        ids.push(id);
    }
    assert_eq!(scalars, 11370);
    assert_eq!(byte_count, 28456);
    let (work, run, snapshot, request) = selected_work(&f, &ids, false);
    assert_eq!(snapshot["itemsTotal"], 26);
    let result = dataset(&f, &work, &run, &request);
    let protection = preserved(&f, &old, &chart, &delivery);
    assert!(protection);
    let mut evidence = json!({"selectedNotes":26,"unicodeScalars":scalars,"utf8Bytes":byte_count,"request":request,"outcome":if result.is_ok(){"accepted"}else{"rejected"},"error":result.as_ref().err(),"existingCheckedChartAndDeliveryPreserved":protection,"privateOriginalTextExported":false,"modelCalls":0,"semanticExtractionVerified":false});
    if let Ok(saved) = &result {
        evidence["coverage"] = saved["content"]["coverage"].clone();
        evidence["datasetRevision"] = saved["revision"].clone();
    }
    output("selected-month-entry.json", &evidence);
    assert!(
        result.is_ok(),
        "selected 26-note formal entry rejected: {}",
        result.unwrap_err()
    );
    let saved = result.unwrap();
    assert_eq!(saved["content"]["coverage"]["material"]["read"], 26);
    assert_eq!(
        saved["content"]["coverage"]["dates"]["fileDateSections"],
        26
    );
    assert_eq!(saved["content"]["coverage"]["dates"]["uniqueDates"], 26);
    assert_eq!(saved["content"]["coverage"]["metric"]["accepted"], 0);
    assert!(
        store::goal::completion::read_context(&f.root, &work, &run).unwrap()["proofs"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(execute(
        &f.root,
        &work,
        &run,
        &chart_request(&saved),
        &Control::default()
    )
    .is_err());
    for item in inputs {
        let bytes =
            std::fs::read(root.join(format!("{}.md", item["recordedDay"].as_str().unwrap())))
                .unwrap();
        assert!(format!("{:x}", Sha256::digest(bytes)) == item["sha256"].as_str().unwrap());
    }
}
