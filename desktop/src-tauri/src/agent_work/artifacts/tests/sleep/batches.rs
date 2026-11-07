use super::*;
const Q: &str = "昨夜主睡眠实际睡了7小时。";
fn setup(count: usize) -> (Fixture, Work, String, Value) {
    let f = Fixture::new();
    for i in 0..count {
        let day =
            chrono::NaiveDate::from_ymd_opt(2025, 1, 1).unwrap() + chrono::Duration::days(i as i64);
        let extra = if i == 0 {
            "\n复核更正：实际主睡眠6.5小时。"
        } else {
            ""
        };
        let body = if count == 2 && i == 1 {
            format!("# {day}\n昨夜主睡眠时长未记。")
        } else {
            format!("# {day}\n{Q}{extra}")
        };
        f.note("notes", &format!("daily/n{i:02}"), &body);
    }
    let selection = json!({"libraryId":"notes","directory":"daily"});
    let preview = ui(
        &f.root,
        &json!({"action":"previewSourceScope","selection":selection}),
    )
    .unwrap();
    let v=ui(&f.root,&json!({"action":"createWithSourceScope","selection":selection,"expectedManifest":preview["snapshot"],"anchor":{"kind":"note","libraryId":"notes","documentId":"daily/n00"},"goal":"合成分批持久数据机制，不运行模型","successCriteria":"区分源分区完整与语义抽取完整"})).unwrap();
    let (w, r) = crate::agent_work::tests::claim(&f, v["work"]["id"].as_str().unwrap());
    let parent = analysis::execute(
        &w.grant.reader(&f.root).unwrap(),
        "hub_source_manifest",
        &json!({"libraryId":"notes","directory":"daily"}),
    )
    .unwrap();
    (f, w, r, parent)
}
fn capture(f: &Fixture, w: &Work, parent: &Value, offset: usize, count: usize) -> Value {
    analysis::execute(&w.grant.reader(&f.root).unwrap(),"hub_create_analysis_snapshot",&json!({"manifestBatch":{"selection":{"libraryId":"notes","directory":"daily"},"expectedManifest":parent["snapshot"],"offset":offset,"count":count}})).unwrap()
}
fn request(f: &Fixture, w: &Work, s: &Value, operation: &str) -> Value {
    let r = w.grant.reader(&f.root).unwrap();
    let mut rows = Vec::new();
    for i in 0..s["itemsTotal"].as_u64().unwrap() {
        let source = analysis::execute(
            &r,
            "hub_read_analysis_snapshot",
            &json!({"expectedSnapshot":s["snapshot"],"itemIndex":i,"limit":8000}),
        )
        .unwrap();
        let day = source["content"]
            .as_str()
            .unwrap()
            .lines()
            .next()
            .unwrap()
            .trim_start_matches("# ");
        let id = format!("row-{}", source["locator"]["documentId"].as_str().unwrap());
        let quote = if source["content"].as_str().unwrap().contains(Q) {
            Q
        } else {
            "昨夜主睡眠时长未记。"
        };
        let mut value = row(
            &source,
            &id,
            day,
            quote,
            if quote == Q { Some(7.0) } else { None },
        );
        value["evidenceRefs"][0]["itemIndex"] = json!(i);
        if quote != Q {
            value["valueKind"] = json!("missing");
            value["ambiguity"] = json!("未记录时长");
            value["exclusionReason"] = json!("缺值不补零");
        }
        rows.push(value);
    }
    json!({"action":"create","operationId":operation,"expectedSnapshot":s["snapshot"],"methodRef":"batch-mechanism-v1","inclusionRule":"仅已接受的明确实际主睡眠","dateRule":"固定正文记录日","rows":rows})
}
fn refs(values: &[&Value]) -> Value {
    json!({"action":"batchSummary","datasets":values.iter().map(|v|json!({"datasetId":v["datasetId"],"revision":v["revision"]})).collect::<Vec<_>>()})
}
fn two(f: &Fixture, w: &Work, r: &str, p: &Value) -> (Value, Value) {
    let a = capture(f, w, p, 0, 20);
    let b = capture(f, w, p, 20, 20);
    (
        dataset(f, w, r, &request(f, w, &a, "batch-a")).unwrap(),
        dataset(f, w, r, &request(f, w, &b, "batch-b")).unwrap(),
    )
}
#[test]
fn manifest_batches_persist_forty_members_and_reopen_readonly_summary_with_exact_lineage() {
    let (f, w, r, p) = setup(40);
    let (a, b) = two(&f, &w, &r, &p);
    let before = records(&f.c(), &w.id, "sleepDatasetRevision").unwrap();
    let summary = dataset(&f, &w, &r, &refs(&[&a, &b])).unwrap();
    assert_eq!(summary["material"]["fixedMembers"], 40);
    assert_eq!(summary["material"]["datasetInputMembers"], 40);
    assert_eq!(summary["material"]["partitionComplete"], true);
    assert_eq!(summary["statistics"][0]["sampleCount"], 31);
    assert_eq!(summary["statistics"][1]["sampleCount"], 9);
    assert_eq!(summary["statistics"][0]["meanHours"], 7.0);
    assert_eq!(summary["statistics"][1]["meanHours"], 7.0);
    assert_eq!(summary["rows"]["acceptedExact"], 40);
    assert!(summary["semanticExtractionComplete"].is_null());
    assert!(summary["modelConsumedMembers"].is_null());
    assert_eq!(summary, dataset(&f, &w, &r, &refs(&[&a, &b])).unwrap());
    assert_eq!(
        before,
        records(&f.c(), &w.id, "sleepDatasetRevision").unwrap()
    );
    let source=ui(&f.root,&json!({"action":"sleepDatasetSource","id":w.id,"datasetId":a["datasetId"],"revision":1,"rowId":a["content"]["rows"][0]["rowId"],"evidenceIndex":0})).unwrap();
    assert!(source["content"].as_str().unwrap().contains(Q));
    assert_eq!(source["evidence"]["itemIndex"], 0);
}
#[test]
fn manifest_batches_refuse_duplicate_material_events_and_incompatible_methods() {
    let (f, w, r, p) = setup(40);
    let a = capture(&f, &w, &p, 0, 20);
    let overlap = capture(&f, &w, &p, 10, 20);
    let av = dataset(&f, &w, &r, &request(&f, &w, &a, "a")).unwrap();
    let bv = dataset(&f, &w, &r, &request(&f, &w, &overlap, "overlap")).unwrap();
    assert!(dataset(&f, &w, &r, &refs(&[&av, &bv]))
        .unwrap_err()
        .contains("重叠"));
    assert!(dataset(&f, &w, &r, &refs(&[&av, &av]))
        .unwrap_err()
        .contains("重复"));
    let end = capture(&f, &w, &p, 20, 20);
    let mut bad = request(&f, &w, &end, "duplicate-event");
    bad["rows"][0]["eventRef"] = av["content"]["rows"][0]["eventRef"].clone();
    let cv = dataset(&f, &w, &r, &bad).unwrap();
    assert!(dataset(&f, &w, &r, &refs(&[&av, &cv]))
        .unwrap_err()
        .contains("重复事件"));
    let mut method = request(&f, &w, &end, "method");
    method["methodRef"] = json!("incompatible-v2");
    let dv = dataset(&f, &w, &r, &method).unwrap();
    assert!(dataset(&f, &w, &r, &refs(&[&av, &dv]))
        .unwrap_err()
        .contains("合同不同"));
}
#[test]
fn manifest_batches_correction_recomputes_only_explicit_latest_revisions_and_retains_history() {
    let (f, w, r, p) = setup(40);
    let (a, b) = two(&f, &w, &r, &p);
    let old = records(&f.c(), &w.id, "sleepDatasetRevision").unwrap();
    let first = dataset(&f, &w, &r, &refs(&[&a, &b])).unwrap();
    let call = json!({"operation":"sleepDataset","request":refs(&[&a,&b]),"stepId":"batch-summary-original"});
    store::record(&f.root, &r, "toolCall", &call).unwrap();
    let cached = store::tool_results::capture(&f.root, &w.id, &r, &call, &first).unwrap();
    store::tool_results::verify_for_replay(&f.root, &w, &r, "batch-summary-original", &cached)
        .unwrap();
    let s = analysis::execute(
        &w.grant.reader(&f.root).unwrap(),
        "hub_read_analysis_snapshot",
        &json!({"expectedSnapshot":a["content"]["snapshot"],"itemIndex":0,"limit":8000}),
    )
    .unwrap();
    let mut rows = a["content"]["rows"].clone();
    let id = rows[0]["rowId"].as_str().unwrap().to_owned();
    rows[0] = row(
        &s,
        &id,
        "2025-01-01",
        "复核更正：实际主睡眠6.5小时。",
        Some(6.5),
    );
    rows[0]["correctionSource"] = json!({"kind":"modelReview","sourceRef":null,"reason":"合成机制检查：采用固定原文中的明确更正"});
    rows[0]["supersedes"] = json!(format!("1:{id}"));
    let revised=dataset(&f,&w,&r,&json!({"action":"revise","operationId":"batch-correct","datasetId":a["datasetId"],"expectedRevision":1,"methodRef":a["content"]["methodRef"],"inclusionRule":a["content"]["inclusionRule"],"dateRule":a["content"]["dateRule"],"rows":rows})).unwrap();
    assert!(dataset(&f, &w, &r, &refs(&[&a, &b]))
        .unwrap_err()
        .contains("已修订"));
    assert!(store::tool_results::verify_for_replay(
        &f.root,
        &w,
        &r,
        "batch-summary-original",
        &cached
    )
    .unwrap_err()
    .contains("已修订"));
    assert!(ui(&f.root,&json!({"action":"readToolResult","id":w.id,"expectedWorkRevision":w.revision,"expectedAuthorizationVersion":w.authorization_version,"recordId":cached["recordId"],"expectedSha256":cached["sha256"],"startChar":0,"maxChars":4000})).is_err());
    let result = dataset(&f, &w, &r, &refs(&[&revised, &b])).unwrap();
    assert!(
        (result["statistics"][0]["meanHours"].as_f64().unwrap() - (31.0 * 7.0 - 0.5) / 31.0).abs()
            < 1e-10
    );
    assert_eq!(result["statistics"][1]["meanHours"], 7.0);
    let saved = records(&f.c(), &w.id, "sleepDatasetRevision").unwrap();
    assert_eq!(&saved[..2], old.as_slice());
    let historical = ui(
        &f.root,
        &json!({"action":"sleepDataset","id":w.id,"datasetId":a["datasetId"],"revision":1}),
    )
    .unwrap();
    assert_eq!(historical["state"], "stale");
    assert_eq!(historical["content"], a["content"]);
    f.note("notes", "daily/n39", "changed");
    assert!(dataset(&f, &w, &r, &refs(&[&revised, &b])).is_err());
}
#[test]
fn manifest_batches_empty_rows_and_missing_values_do_not_become_semantic_completion_or_zero() {
    let (f, w, r, p) = setup(2);
    let a = capture(&f, &w, &p, 0, 1);
    let b = capture(&f, &w, &p, 1, 1);
    let mut empty = request(&f, &w, &a, "empty");
    empty["rows"] = json!([]);
    let av = dataset(&f, &w, &r, &empty).unwrap();
    let bv = dataset(&f, &w, &r, &request(&f, &w, &b, "missing")).unwrap();
    let complete = dataset(&f, &w, &r, &refs(&[&av, &bv])).unwrap();
    assert_eq!(complete["material"]["partitionComplete"], true);
    assert_eq!(complete["material"]["membersWithoutRows"], 1);
    assert_eq!(complete["rows"]["valueKinds"]["missing"], 1);
    assert_eq!(complete["rows"]["acceptedExact"], 0);
    assert_eq!(complete["statistics"], json!([]));
    assert!(complete["semanticExtractionComplete"].is_null());
    let partial = dataset(&f, &w, &r, &refs(&[&bv])).unwrap();
    assert_eq!(partial["material"]["notRepresentedMembers"], 1);
    assert_eq!(partial["material"]["partitionComplete"], false);
}
