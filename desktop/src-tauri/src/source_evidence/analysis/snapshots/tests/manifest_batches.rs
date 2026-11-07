use super::*;
fn batch_args(parent: &Value, offset: usize, count: usize) -> Value {
    json!({"manifestBatch":{"selection":{"libraryId":"notes","directory":"daily"},"expectedManifest":parent["snapshot"],"offset":offset,"count":count}})
}
fn seed_batch(f: &Fixture) {
    for n in 0..40 {
        f.note("notes", &format!("daily/n{n:02}"), "本批真实缓存正文");
    }
    f.note("notes", "outside/secret", "不得捕获的目录外正文");
}
#[test]
fn manifest_batch_capture_is_exact_disjoint_and_keeps_parent_identity() {
    let f = Fixture::new();
    seed_batch(&f);
    let r = reader(&f);
    let parent = crate::source_evidence::analysis::execute(
        &r,
        "hub_source_manifest",
        &json!({"libraryId":"notes","directory":"daily","limit":1}),
    )
    .unwrap();
    let mut ids = std::collections::HashSet::new();
    for offset in [0, 20] {
        let saved = create(&r, &batch_args(&parent, offset, 20)).unwrap();
        assert_eq!(saved["itemsTotal"], 20);
        assert_eq!(saved["manifestBatch"]["totalMembers"], 40);
        assert_eq!(
            saved["manifestBatch"]["expectedManifest"],
            parent["snapshot"]
        );
        let listed = execute(
            &r,
            "hub_list_note_sources",
            &json!({"expectedSnapshot":saved["snapshot"],"limit":32}),
        )
        .unwrap();
        for note in listed["notes"].as_array().unwrap() {
            assert!(note["locator"]["documentId"]
                .as_str()
                .unwrap()
                .starts_with("daily/"));
            assert!(ids.insert(note["locator"].clone().to_string()));
        }
        assert_eq!(
            load(&r, saved["snapshot"].as_str().unwrap())
                .unwrap()
                .input
                .format,
            BATCH_FORMAT
        );
    }
    assert_eq!(ids.len(), 40);
}
#[test]
fn manifest_batch_capture_rejects_stale_foreign_and_invalid_ranges_before_publishing() {
    let f = Fixture::new();
    seed_batch(&f);
    let r = reader(&f);
    let parent = crate::source_evidence::analysis::execute(
        &r,
        "hub_source_manifest",
        &json!({"libraryId":"notes","directory":"daily"}),
    )
    .unwrap();
    for count in [0, 33] {
        assert!(create(&r, &batch_args(&parent, 0, count)).is_err());
    }
    let mut bad = batch_args(&parent, 0, 20);
    bad["manifestBatch"]["count"] = json!(1.5);
    assert!(create(&r, &bad).is_err());
    assert!(create(&r, &batch_args(&parent, 5001, 20)).is_err());
    assert!(create(&r, &batch_args(&parent, 40, 20)).is_err());
    let mut extra = batch_args(&parent, 0, 20);
    extra["query"] = json!("daily");
    assert!(create(&r, &extra).is_err());
    let exact = EvidenceReader::new(
        &f.root,
        EvidenceScope::new(vec![], vec![])
            .unwrap()
            .with_notes(vec![EvidenceLocator::Note {
                library_id: "notes".into(),
                document_id: "daily/n00".into(),
                page_id: None,
            }])
            .unwrap(),
    );
    assert!(create(&exact, &batch_args(&parent, 0, 20)).is_err());
    f.note("notes", "daily/n01", "changed");
    assert!(create(&r, &batch_args(&parent, 0, 20)).is_err());
    assert!(!f.root.join(DATABASE).exists());
}
#[test]
fn manifest_batch_format_is_distinct_while_ordinary_historical_snapshot_behavior_stays() {
    let f = Fixture::new();
    seed_batch(&f);
    let r = reader(&f);
    let ordinary = create(&r, &json!({"query":"daily/n00"})).unwrap();
    assert_eq!(
        load(&r, ordinary["snapshot"].as_str().unwrap())
            .unwrap()
            .input
            .format,
        FORMAT
    );
    assert!(ordinary.get("manifestBatch").is_none());
    let parent = crate::source_evidence::analysis::execute(
        &r,
        "hub_source_manifest",
        &json!({"libraryId":"notes","directory":"daily"}),
    )
    .unwrap();
    let batch = create(&r, &batch_args(&parent, 0, 1)).unwrap();
    let mut wrong = json!({"expectedSnapshot":batch["snapshot"],"manifestBatch":batch_args(&parent,1,1)["manifestBatch"]});
    assert!(execute(&r, "hub_list_note_sources", &wrong).is_err());
    wrong.as_object_mut().unwrap().remove("manifestBatch");
    assert_eq!(
        execute(&r, "hub_list_note_sources", &wrong).unwrap()["total"],
        1
    );
    f.note("notes", "daily/n00", "edited");
    let body = execute(
        &r,
        "hub_read_analysis_snapshot",
        &json!({"expectedSnapshot":ordinary["snapshot"],"itemIndex":0}),
    )
    .unwrap();
    assert!(body["content"]
        .as_str()
        .unwrap()
        .contains("本批真实缓存正文"));
    f.c()
        .execute("UPDATE libraries SET enabled=0 WHERE id='notes'", [])
        .unwrap();
    assert!(execute(
        &r,
        "hub_list_note_sources",
        &json!({"expectedSnapshot":batch["snapshot"]})
    )
    .is_err());
}
