use super::*;

#[test]
#[ignore = "saved authorized26-note inputs and omission required; no model"]
fn v1_closure_saved_waking_omission_enters_formal_dataset_without_inventing_hours() {
    let r = Replay::saved();
    let before =
        store::records(&r.f.root, &r.work.id, "sleepDatasetRevision", 32).unwrap()[0].clone();
    assert_eq!(before["rows"].as_array().unwrap().len(), 10);
    assert!(!before["rows"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["eventDate"] == "2025-07-03"));
    let reader = r.work.grant.reader(&r.f.root).unwrap();
    let listed = crate::source_evidence::analysis::execute(
        &reader,
        "hub_list_note_sources",
        &json!({"expectedSnapshot":before["snapshot"],"limit":32}),
    )
    .unwrap();
    assert_eq!(listed["total"], 26);
    let item = listed["notes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| {
            item["path"]
                .as_str()
                .is_some_and(|p| p.ends_with("2025-07-03.md"))
        })
        .unwrap();
    let source=crate::source_evidence::analysis::execute(&reader,"hub_read_analysis_snapshot",&json!({"expectedSnapshot":before["snapshot"],"itemIndex":item["itemIndex"],"start":0,"limit":8000})).unwrap();
    let quote = "醒来还是惶恐不安的。";
    let body = source["content"].as_str().unwrap();
    let byte = body.find(quote).unwrap();
    let start = body[..byte].chars().count();
    let end = start + quote.chars().count();
    assert_eq!((start, end), (19, 29));
    let mut rows = before["rows"].as_array().unwrap().clone();
    rows.push(json!({"rowId":"offline-waking-clue","eventRef":"main-sleep-clue:2025-07-03","rawValue":quote,"normalizedValue":null,"unit":"hours","valueKind":"missing","eventDate":"2025-07-03","timezone":"Asia/Shanghai","dateBasis":"recordedDay","evidenceRefs":[{"itemIndex":item["itemIndex"],"sourceRevision":source["sourceRevision"],"contentHash":source["sourceRevision"]["bodySha256"],"start":start,"end":end,"text":quote}],"reviewState":"rejected","reviewBasis":{"kind":"modelReview","sourceRef":null,"reason":"独立AI逐文复核：明确醒来，缺少事件时刻和实际时长，仅保留相关线索"},"ambiguity":"无法确定实际主睡眠小时数；情绪不作为时长依据","exclusionReason":"无精确实际时长，不进入均值","correctionSource":{"kind":"modelReview","sourceRef":null,"reason":"原文逐篇复核发现遗漏；非用户数值纠正"},"supersedes":null}));
    let request = json!({"action":"revise","operationId":"offline-waking-omission","datasetId":before["datasetId"],"expectedRevision":before["revision"],"methodRef":before["methodRef"],"inclusionRule":before["inclusionRule"],"dateRule":before["dateRule"],"rows":rows});
    let control = Control::default();
    let mut invented = request.clone();
    let index = invented["rows"].as_array().unwrap().len() - 1;
    invented["rows"][index]["normalizedValue"] = json!(7.0);
    invented["rows"][index]["reviewState"] = json!("accepted_for_analysis");
    assert!(crate::agent_work::artifacts::sleep::execute(
        &r.f.root, &r.work, &r.run, &invented, &control
    )
    .is_err());
    let result = crate::agent_work::artifacts::sleep::execute(
        &r.f.root, &r.work, &r.run, &request, &control,
    )
    .unwrap();
    assert_eq!(result["revision"], 2);
    assert_eq!(result["content"]["rows"].as_array().unwrap().len(), 11);
    assert_eq!(result["content"]["coverage"]["metric"]["accepted"], 0);
    assert_eq!(result["content"]["coverage"]["material"]["read"], 26);
    assert_eq!(
        &result["content"]["rows"].as_array().unwrap()[..10],
        before["rows"].as_array().unwrap()
    );
    let original = store::records(&r.f.root, &r.work.id, "sleepDatasetRevision", 32)
        .unwrap()
        .into_iter()
        .find(|v| v["revision"] == 1)
        .unwrap();
    assert_eq!(original, before);
    let mut catalog = skills::Catalog::discover(&r.f.root).unwrap();
    let loaded = catalog
        .load("hub-statistics", "主睡眠完整候选与排除")
        .unwrap();
    assert!(loaded.to_string().contains("本人明确叙述"));
    assert!(crate::agent_work::artifacts::sleep::schema()
        .to_string()
        .contains("本人明确醒来"));
    r.output("quality-omission-formal-replay.json",json!({"savedDataset":before["datasetId"],"oldRows":10,"newRows":11,"newRow":result["content"]["rows"][index],"oldRevisionUnchanged":true,"sourceAligned":true,"accepted":0,"numericInventionRejected":true,"modelCalls":0,"scope":"offline repair admissibility and live tool/skill rule adoption only; not autonomous model recovery or real work mutation"}));
}
