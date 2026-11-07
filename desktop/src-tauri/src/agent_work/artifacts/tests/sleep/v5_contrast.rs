use super::*;
use std::time::Instant;

fn save(round: usize, stage: &str, value: &Value) {
    if let Ok(directory) = std::env::var("HUB_V5_CONTRAST_DIR") {
        std::fs::write(
            Path::new(&directory).join(format!("round-{round}-{stage}.json")),
            serde_json::to_vec_pretty(value).unwrap(),
        )
        .unwrap();
    }
}

fn comparable(data: &Value) -> Value {
    let mut extraction = data["extractionDataset"].clone();
    // Independent rebuild has a new identity and no historical correction claim.
    for key in ["datasetId", "revision"] {
        extraction.as_object_mut().unwrap().remove(key);
    }
    for row in extraction["rows"].as_array_mut().unwrap() {
        for key in ["correctionSource", "supersedes"] {
            row.as_object_mut().unwrap().remove(key);
        }
    }
    json!({"rows":data["rows"],"unit":data["unit"],"statistics":data["statistics"],"extractionDataset":extraction})
}

fn contrast(round: usize) {
    let (f, w, r, mut request, source) = setup_sleep(DIARY);
    request["rows"] = labeled(&source);
    let first_data = dataset(&f, &w, &r, &request).unwrap();
    let first_request = chart_request(&first_data);
    let first = call(&f, &w, &r, &first_request);
    call(
        &f,
        &w,
        &r,
        &json!({"action":"validate","artifactId":first["artifactId"],"revision":1}),
    );
    publish(
        &f,
        &w,
        &r,
        &accepted_report(&f, &w, &r, "历史基版：一月7.5小时；二月无精确值"),
    )
    .unwrap();
    let before_delivery = store::records(&f.root, &w.id, "delivery", 1).unwrap()[0].clone();
    let (w, r) = crate::agent_work::tests::claim(&f, &w.id);
    save(
        round,
        "baseline",
        &json!({"dataset":first_data,"chart":first,"delivery":before_delivery,"source":source}),
    );

    let started = Instant::now();
    let mut rows = first_data["content"]["rows"].clone();
    rows[0] = row(
        &source,
        "jan1",
        "2025-01-01",
        "复核更正：实际主睡眠6.5小时。",
        Some(6.5),
    );
    rows[0]["correctionSource"] = json!({"kind":"modelReview","sourceRef":null,"reason":"受控对照：固定原文有明确6.5小时更正；不是用户确认"});
    rows[0]["supersedes"] = json!("1:jan1");
    let delta_request = json!({"action":"revise","operationId":"v5-contrast-revise","datasetId":first_data["datasetId"],"expectedRevision":1,"methodRef":request["methodRef"],"dateRule":request["dateRule"],"inclusionRule":request["inclusionRule"],"rows":rows});
    let revised = dataset(&f, &w, &r, &delta_request).unwrap();
    let revision_ms = started.elapsed().as_secs_f64() * 1000.0;
    let stale = store::view(&f.root, &w.id).unwrap();
    save(
        round,
        "revised",
        &json!({"request":delta_request,"dataset":revised,"stale":stale,"datasetRevisionMs":revision_ms}),
    );
    assert_eq!(revised["revision"], 2);
    assert_eq!(
        &revised["content"]["rows"].as_array().unwrap()[1..],
        &first_data["content"]["rows"].as_array().unwrap()[1..]
    );
    assert_eq!(stale["analysisArtifacts"][0]["state"], "stale");
    assert_eq!(stale["analysisArtifacts"][0]["content"], first["content"]);
    let patch = json!({"action":"patch","operationId":"v5-contrast-chart","artifactId":first["artifactId"],"expectedRevision":1,"analysis":chart_request(&revised)["analysis"],"spec":null,"reason":"复用未变抽取；月均值仍完整重算"});
    let computed_at = Instant::now();
    let corrected = call(&f, &w, &r, &patch);
    let delta_compute_ms = computed_at.elapsed().as_secs_f64() * 1000.0;
    let validated_at = Instant::now();
    call(
        &f,
        &w,
        &r,
        &json!({"action":"validate","artifactId":first["artifactId"],"revision":2}),
    );
    let delta_validate_ms = validated_at.elapsed().as_secs_f64() * 1000.0;
    let delta_total_ms = started.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(corrected["artifactId"], first["artifactId"]);

    // Reconstruct every candidate from the same frozen source, not revised.rows.
    let full_started = Instant::now();
    let fresh_source = analysis::execute(&w.grant.reader(&f.root).unwrap(), "hub_read_analysis_snapshot", &json!({"expectedSnapshot":first_data["content"]["snapshot"],"itemIndex":0,"start":0,"limit":8000})).unwrap();
    assert_eq!(fresh_source, source);
    let mut full_request = request.clone();
    full_request["operationId"] = json!("v5-contrast-full-create");
    full_request["rows"] = json!([
        row(
            &fresh_source,
            "jan1",
            "2025-01-01",
            "复核更正：实际主睡眠6.5小时。",
            Some(6.5)
        ),
        row(
            &fresh_source,
            "jan2",
            "2025-01-02",
            "昨夜主睡眠实际睡了8小时。",
            Some(8.0)
        ),
        row(
            &fresh_source,
            "feb1",
            "2025-02-01",
            "昨晚两点睡，七点起；中间醒过，实际睡眠时长不清楚。",
            None
        )
    ]);
    let full_data = dataset(&f, &w, &r, &full_request).unwrap();
    let full_dataset_ms = full_started.elapsed().as_secs_f64() * 1000.0;
    let full_compute_at = Instant::now();
    let mut full_chart_request = chart_request(&full_data);
    full_chart_request["operationId"] = json!("v5-contrast-full-chart");
    let full_chart = call(&f, &w, &r, &full_chart_request);
    let full_compute_ms = full_compute_at.elapsed().as_secs_f64() * 1000.0;
    let full_validate_at = Instant::now();
    call(
        &f,
        &w,
        &r,
        &json!({"action":"validate","artifactId":full_chart["artifactId"],"revision":1}),
    );
    let full_validate_ms = full_validate_at.elapsed().as_secs_f64() * 1000.0;
    let full_total_ms = full_started.elapsed().as_secs_f64() * 1000.0;
    save(
        round,
        "comparison",
        &json!({"incrementalExtractionDataset":revised,"incrementalChart":corrected,"fullRequest":full_request,"fullDataset":full_data,"fullChart":full_chart,"timingMs":{"reuseDatasetRevision":revision_ms,"reuseFullAggregationChartDispatch":delta_compute_ms,"reuseValidation":delta_validate_ms,"reusePathTotal":delta_total_ms,"fullReadAndDatasetCreate":full_dataset_ms,"fullAggregationChartDispatch":full_compute_ms,"fullValidation":full_validate_ms,"fullPathTotal":full_total_ms},"aggregationMode":"full monthlyMean on both paths","reusedUnchangedRows":2,"changedRows":1,"models":0}),
    );
    assert_ne!(revised["datasetId"], full_data["datasetId"]);
    assert_eq!(
        comparable(&corrected["content"]["data"]),
        comparable(&full_chart["content"]["data"])
    );
    assert_eq!(
        corrected["content"]["data"]["rows"],
        json!([{"group":"2025-01","value":7.25,"sampleCount":2}])
    );
    assert_eq!(revised["content"]["coverage"]["metric"]["ambiguous"], 1);
    assert_eq!(
        revised["content"]["coverage"]["metric"]["datesWithoutAcceptedValue"],
        1
    );
    assert_eq!(
        full_data["content"]["rows"][0]["correctionSource"],
        Value::Null
    );
    assert_eq!(revised["content"]["rows"][0]["supersedes"], "1:jan1");

    publish(
        &f,
        &w,
        &r,
        &accepted_report(&f, &w, &r, "纠正后一月7.25小时；二月有歧义，不补零"),
    )
    .unwrap();
    assert_eq!(
        store::records(&f.root, &w.id, "delivery", 2).unwrap()[1],
        before_delivery
    );
    let historical = ui(&f.root,&json!({"action":"sleepDataset","id":w.id,"datasetId":first_data["datasetId"],"revision":1})).unwrap();
    assert_eq!(historical["content"], first_data["content"]);
    assert_eq!(historical["state"], "stale");
    let current = ui(
        &f.root,
        &json!({"action":"artifact","id":w.id,"artifactId":first["artifactId"],"revision":2}),
    )
    .unwrap();
    assert_eq!(current["state"], "checked");
    let captured = ui(&f.root,&json!({"action":"sleepDatasetSource","id":w.id,"datasetId":revised["datasetId"],"revision":2,"rowId":"jan1","evidenceIndex":0})).unwrap();
    assert_eq!(captured["content"], DIARY);
    let actual: String = f
        .c()
        .query_row(
            "SELECT markdown FROM documents WHERE space_id='notes' AND id='current'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(actual, DIARY);
    save(
        round,
        "result",
        &json!({"passed":true,"sameSnapshot":first_data["content"]["snapshot"],"method":request["methodRef"],"sameNumericalRowsCoverageAndSources":true,"oldDeliveryAndDatasetPreserved":true,"sourceUnchanged":true,"currentChecked":true,"reusedExtractionRows":2,"fullAggregationBothPaths":true,"models":0,"realModelSemanticAcceptance":false}),
    );
}

#[test]
fn v5_reused_extraction_matches_full_rebuild_round_1() {
    contrast(1);
}
#[test]
fn v5_reused_extraction_matches_full_rebuild_round_2() {
    contrast(2);
}
#[test]
fn v5_reused_extraction_matches_full_rebuild_round_3() {
    contrast(3);
}
