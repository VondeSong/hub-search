//! Opt-in exact C7 saved-data diagnosis; no provider, synthetic replacement rows or grade.
use super::*;
use crate::source_evidence::tests::Fixture;

#[test]
#[ignore = "requires exact authorized saved C7 failure copies and a fresh report path; no model"]
fn saved_valid_dataset_result_exceeds_legacy_record_with_duplicate_request() {
    let directory = PathBuf::from(std::env::var("HUB_C7_OVERFLOW_REPLAY").unwrap());
    let output = PathBuf::from(std::env::var("HUB_C7_OVERFLOW_REPORT").unwrap());
    assert!(!output.exists());
    let saved: Value =
        serde_json::from_slice(&std::fs::read(directory.join("input.json")).unwrap()).unwrap();
    assert_eq!(saved["request"]["operation"], "sleepDataset");
    assert_eq!(saved["dataset"]["rows"].as_array().unwrap().len(), 9);
    let f = Fixture::new();
    for name in [
        "craft-search.sqlite3",
        "analysis-snapshots.sqlite3",
        "analysis-snapshot-policy.json",
        "library-controls-v1.json",
    ] {
        std::fs::copy(directory.join(name), f.root.join(name)).unwrap();
    }
    // Fixture::new registered the previous fresh file as initialized. A saved
    // database replacing that file must enter the real cold-open migration,
    // rather than inherit the fixture's cache entry for a different file.
    crate::database::forget_initialized_database(&f.root.join("craft-search.sqlite3"));
    let id = saved["dataset"]["workId"].as_str().unwrap();
    let run = saved["runId"].as_str().unwrap();
    let c = f.c();
    let original_count: i64 = c
        .query_row("SELECT count(*) FROM agent_runs", [], |r| r.get(0))
        .unwrap();
    let original_docs: Vec<(String, String)> = c
        .prepare("SELECT id,markdown FROM documents ORDER BY id")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    // Restore the failed run lifecycle only in a disposable copy. The actual
    // committed dataset and every source/grant/record remain as saved.
    c.execute(
        "UPDATE agent_runs SET state='investigating',finished_at=NULL WHERE id=?1",
        [run],
    )
    .unwrap();
    c.execute(
        "UPDATE agent_works SET state='investigating',active_run=?2 WHERE id=?1",
        params![id, run],
    )
    .unwrap();
    let work = store::load(&c, id).unwrap();
    drop(c);
    let control = Control::default();
    let session = assistant::Session {
        root: &f.root,
        work: &work,
        run,
        control: &control,
        operation: None,
        selection: Value::Null,
        app: None,
    };
    let call = json!({"tool":"hub_sleepDataset","arguments":{"request":saved["request"]["request"]},"callId":saved["request"]["stepId"]});
    let mut used = 0;
    let tool = arguments::decode(&f.root, run, &tools(None).unwrap(), &call, &mut used, 24)
        .unwrap()
        .unwrap();
    let result = session.dispatch(tool).unwrap();
    assert_eq!(result["content"], saved["dataset"]);
    let mut observation = result.clone();
    observation["request"] = saved["request"].clone();
    let bytes = serde_json::to_vec(&observation).unwrap().len();
    assert_eq!(bytes, 66106);
    let error = store::record(&f.root, run, "toolResult", &observation).unwrap_err();
    assert_eq!(error, "单条调查记录过大");
    let fixed = observation::attach_request(result.clone(), &saved["request"]);
    let fixed_bytes = serde_json::to_vec(&fixed).unwrap().len();
    assert!(fixed_bytes < 65536);
    assert_eq!(fixed["content"], saved["dataset"]);
    assert_eq!(fixed["request"]["stepId"], saved["request"]["stepId"]);
    assert_eq!(fixed["request"]["rowSubmission"]["count"], 9);
    store::record(&f.root, run, "toolResult", &fixed).unwrap();
    // The new full-outcome owner retains this exact formerly overflowing
    // payload within the same original single-record ceiling. No provider or
    // formal acceptance run is repeated.
    let full_ref =
        store::tool_results::capture(&f.root, id, run, &saved["request"], &result).unwrap();
    let full_body: String = f
        .c()
        .query_row(
            "SELECT body_json FROM agent_records WHERE id=?1",
            [full_ref["recordId"].as_str().unwrap()],
            |r| r.get(0),
        )
        .unwrap();
    let full_bytes = full_body.len();
    assert!(full_bytes < 65536);
    let mut full: Value = serde_json::from_str(&full_body).unwrap();
    full.as_object_mut().unwrap().remove("request");
    full.as_object_mut().unwrap().remove("_hubTrace");
    assert_eq!(full, result);
    let saved_call = store::records(&f.root, id, "toolCall", 32)
        .unwrap()
        .into_iter()
        .find(|v| v["stepId"] == saved["request"]["stepId"])
        .unwrap();
    assert_eq!(saved_call, saved["request"]);
    let c = f.c();
    let final_docs: Vec<(String, String)> = c
        .prepare("SELECT id,markdown FROM documents ORDER BY id")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(original_docs, final_docs);
    assert_eq!(
        c.query_row("SELECT count(*) FROM agent_runs", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        original_count
    );
    std::fs::write(output,serde_json::to_vec_pretty(&json!({"scope":"exact saved request via production argument admission and Session::dispatch, then unchanged store::record; compare legacy echo and fixed production result attachment, not autonomous model or formal grade","datasetBytes":saved["dataset"].to_string().len(),"requestBytes":saved["request"].to_string().len(),"legacyObservationBytes":bytes,"fixedObservationBytes":fixed_bytes,"recordLimit":65536,"legacyError":error,"fixedRecordSaved":true,"exactOriginalToolCallRetained":true,"sameCommittedDataset":true,"documentsUnchanged":true,"newModelCalls":0})).unwrap()).unwrap();
}
