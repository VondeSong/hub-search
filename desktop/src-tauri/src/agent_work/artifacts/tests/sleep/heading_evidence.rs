use super::*;

#[test]
fn recorded_day_evidence_can_include_its_heading_but_not_other_sections_or_heading_alone() {
    // R12's rejected first source/quote; the appended section exercises the next-date boundary.
    let first = "# 2025-01-01\n昨夜主睡眠实际睡了7小时。\n复核更正：实际主睡眠6.5小时。";
    let second = "# 2025-01-02\n昨夜主睡眠实际睡了8小时。";
    let body = format!("{first}\n{second}");
    let (f, work, run, mut request, source) = setup_sleep(&body);
    for (operation, quote, day) in [
        ("heading-only", "# 2025-01-01", "2025-01-01"),
        ("wrong-day", first, "2025-01-02"),
        ("cross-section", body.as_str(), "2025-01-01"),
    ] {
        let mut bad = request.clone();
        bad["operationId"] = json!(operation);
        bad["rows"] = json!([row(&source, "bad", day, quote, Some(6.5))]);
        assert!(
            dataset(&f, &work, &run, &bad)
                .unwrap_err()
                .contains("事件归日与出处所在日期段不一致"),
            "{operation}"
        );
    }
    assert!(records(&f.c(), &work.id, "sleepDatasetRevision")
        .unwrap()
        .is_empty());
    let mut corrected = row(&source, "jan1", "2025-01-01", first, Some(6.5));
    corrected["rawValue"] = json!("6.5小时");
    request["rows"] = json!([
        corrected,
        row(&source, "jan2", "2025-01-02", second, Some(8.0))
    ]);
    let saved = dataset(&f, &work, &run, &request).unwrap();
    assert_eq!(saved["content"]["coverage"]["metric"]["accepted"], 2);
    assert_eq!(saved["content"]["rows"][0]["evidenceRefs"][0]["start"], 0);
    assert!(
        saved["content"]["rows"][1]["evidenceRefs"][0]["start"]
            .as_u64()
            .unwrap()
            > 0
    );
    assert_eq!(dataset(&f, &work, &run, &request).unwrap(), saved);
}
