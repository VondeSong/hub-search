use super::*;
use crate::agent_work::{tests::claim, ui};
use crate::source_evidence::tests::Fixture;
fn setup(n: usize) -> (Fixture, Work, String) {
    let f = Fixture::new();
    for i in 0..n {
        f.note("notes", &format!("daily/n{i}"), "甲乙丙丁戊己");
    }
    let selection = json!({"libraryId":"notes","directory":"daily"});
    let p = ui(
        &f.root,
        &json!({"action":"previewSourceScope","selection":selection}),
    )
    .unwrap();
    let v=ui(&f.root,&json!({"action":"createWithSourceScope","selection":selection,"expectedManifest":p["snapshot"],"anchor":{"kind":"note","libraryId":"notes","documentId":"daily/n0"},"goal":"覆盖合成检查","successCriteria":"不把工具返回当模型理解"})).unwrap();
    let (w, r) = claim(&f, v["work"]["id"].as_str().unwrap());
    (f, w, r)
}
fn args(w: &Work) -> Value {
    json!({"action":"sourceScopeCoverage","id":w.id,"expectedWorkRevision":w.revision,"expectedAuthorizationVersion":w.authorization_version})
}
fn receipt(f: &Fixture, w: &Work, r: &str, id: &str, start: usize, len: usize) -> Value {
    let request =
        json!({"operation":"read","stepId":id,"locator":w.anchor,"startChar":start,"maxChars":len});
    record(&f.root, r, "toolCall", &request).unwrap();
    let mut source = w
        .grant
        .reader(&f.root)
        .unwrap()
        .read(w.anchor.as_ref().unwrap(), start, len, None)
        .unwrap();
    // A historical length claim cannot manufacture full coverage.
    source.total_chars = 1;
    capture(&f.root, &w.id, r, &request, &json!({"excerpt":source})).unwrap()
}
#[test]
fn source_coverage_unions_actual_ranges_without_counting_replays_or_claiming_extraction() {
    let (f, w, r) = setup(2);
    let a = args(&w);
    let before = ui(&f.root, &a).unwrap();
    assert_eq!(before["noVerifiedReadReceiptMembers"], 2);
    receipt(&f, &w, &r, "one", 0, 3);
    receipt(&f, &w, &r, "overlap", 2, 2);
    receipt(&f, &w, &r, "duplicate", 0, 3);
    let p = ui(&f.root, &a).unwrap();
    assert_eq!(p["partialToolReturnMembers"], 1);
    assert_eq!(p["members"][0]["coveredChars"], 4);
    assert_eq!(p["members"][0]["totalChars"], 6);
    assert_eq!(p["members"][0]["ranges"], json!([[0, 4]]));
    assert!(p["extractedMembers"].is_null());
    assert!(p["modelConsumedMembers"].is_null());
    receipt(&f, &w, &r, "end", 4, 2);
    let p = ui(&f.root, &a).unwrap();
    assert_eq!(p["fullToolReturnMembers"], 1);
    assert_eq!(p["noVerifiedReadReceiptMembers"], 1);
    let c = f.c();
    let records: i64 = c
        .query_row("SELECT count(*) FROM agent_records", [], |r| r.get(0))
        .unwrap();
    assert_eq!(p, ui(&f.root, &a).unwrap());
    assert_eq!(
        records,
        c.query_row::<i64, _, _>("SELECT count(*) FROM agent_records", [], |r| r.get(0))
            .unwrap()
    );
    assert!(!p.to_string().contains("甲乙"));
}
#[test]
fn source_coverage_keeps_missing_trace_and_errors_unknown_and_invalidates_changed_sources() {
    let (f, w, r) = setup(2);
    let a = args(&w);
    let request = json!({"operation":"read","stepId":"error","locator":w.anchor});
    record(&f.root, &r, "toolCall", &request).unwrap();
    capture(
        &f.root,
        &w.id,
        &r,
        &request,
        &json!({"error":"read failed"}),
    )
    .unwrap();
    record(
        &f.root,
        &r,
        "evidence",
        &json!({"legacy":"no original trace header"}),
    )
    .unwrap();
    let p = ui(&f.root, &a).unwrap();
    assert_eq!(p["failedOutcomeRecords"], 1);
    assert_eq!(p["unverifiableOutcomeRecords"], 1);
    assert_eq!(p["noVerifiedReadReceiptMembers"], 2);
    let mut wrong = a.clone();
    wrong["expectedAuthorizationVersion"] = json!(99);
    assert!(ui(&f.root, &wrong).is_err());
    f.note("notes", "daily/n1", "changed");
    assert!(ui(&f.root, &a).unwrap_err().contains("变化"));
    ui(&f.root, &json!({"action":"revoke","id":w.id})).unwrap();
    assert!(ui(&f.root, &a).is_err());
}
#[test]
fn source_coverage_pages_bind_records_and_reject_capacity_without_partial_totals() {
    let (f, w, r) = setup(21);
    let a = args(&w);
    let p = ui(&f.root, &a).unwrap();
    assert_eq!(p["members"].as_array().unwrap().len(), 20);
    let mut next = a.clone();
    next["cursor"] = p["nextCursor"].clone();
    assert_eq!(
        ui(&f.root, &next).unwrap()["members"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    receipt(&f, &w, &r, "new", 0, 2);
    assert!(ui(&f.root, &next).unwrap_err().contains("变化"));
    let c = f.c();
    c.execute("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<4097) INSERT INTO agent_records(id,work_id,run_id,kind,body_json,created_at) SELECT 'coverage-limit-'||x,?1,?2,'toolResult','{}',0 FROM n",params![w.id,r]).unwrap();
    assert!(ui(&f.root, &a).unwrap_err().contains("容量"));
}
