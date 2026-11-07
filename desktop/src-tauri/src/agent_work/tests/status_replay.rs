//! Opt-in saved-data diagnosis through the unchanged public status entry.
use super::*;

#[test]
#[ignore = "requires explicit project-owned copied profiles and output; no model"]
fn v1_replay_saved_status_phases() {
    let plan: Value = serde_json::from_slice(
        &std::fs::read(std::env::var("HUB_V1_STATUS_REPLAY_PLAN").unwrap()).unwrap(),
    )
    .unwrap();
    assert!(std::env::var_os("HUB_V1_STATUS_PHASES").is_some());
    let output = PathBuf::from(plan["output"].as_str().unwrap());
    assert!(!output.exists(), "keep each diagnostic run immutable");
    let mut results = Vec::new();
    for item in plan["items"].as_array().unwrap() {
        let root = PathBuf::from(item["profile"].as_str().unwrap());
        assert!(
            root.to_string_lossy().contains(".local")
                && root.join(".hub-isolated-runtime-v1").is_file()
        );
        let id = item["workId"].as_str().unwrap();
        let count = || {
            let c = crate::source_evidence::open_read_database(&root).unwrap();
            c.query_row("SELECT count(*) FROM agent_runs", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap()
        };
        let before = count();
        let mut samples = Vec::new();
        for _ in 0..3 {
            crate::hub_capabilities::take_test_catalog_builds();
            let value = ui(&root, &json!({"action":"status","id":id})).unwrap();
            let catalog_builds = crate::hub_capabilities::take_test_catalog_builds();
            assert!(
                catalog_builds <= 1,
                "static tool titles must not rebuild the full catalog per event: {catalog_builds}"
            );
            assert_eq!(value["work"]["id"], id);
            assert_eq!(value["work"]["state"], "completed");
            assert!(value["work"]["report"].is_object());
            samples.push(json!({"projectionMs":value["nativeTiming"]["projectionMs"],"phases":value["diagnosticProjectionPhases"],"catalogBuilds":catalog_builds,
                "activity":value["activity"],
                "artifactStates":value["analysisArtifacts"].as_array().unwrap().iter().map(|v|json!([v["artifactId"],v["revision"],v["state"]])).collect::<Vec<_>>(),
                "datasets":value["sleepDatasets"].as_array().unwrap().iter().map(|v|json!([v["datasetId"],v["revision"],v["state"]])).collect::<Vec<_>>(),
                "validity":value["validity"]}));
        }
        assert_eq!(count(), before, "a status read must not start a model");
        results.push(json!({"caseId":item["caseId"],"attempt":item["attempt"],"profile":root,"modelCalls":0,"formalScore":null,"samples":samples}));
    }
    std::fs::write(output,serde_json::to_vec_pretty(&json!({"track":"diagnostic saved-data status replay, not native UI timing or formal score","results":results})).unwrap()).unwrap();
}

#[test]
#[ignore = "requires explicit copied C6 profiles; concurrent snapshot diagnosis, no model"]
fn v1_replay_saved_status_during_snapshot_capture() {
    let plan: Value = serde_json::from_slice(
        &std::fs::read(std::env::var("HUB_V1_STATUS_REPLAY_PLAN").unwrap()).unwrap(),
    )
    .unwrap();
    assert!(std::env::var_os("HUB_V1_STATUS_PHASES").is_some());
    let output = PathBuf::from(plan["output"].as_str().unwrap());
    assert!(!output.exists(), "keep each diagnostic run immutable");
    let mut results = Vec::new();
    for item in plan["items"].as_array().unwrap() {
        let root = PathBuf::from(item["profile"].as_str().unwrap());
        assert!(
            root.to_string_lossy().contains(".local")
                && root.join(".hub-isolated-runtime-v1").is_file()
        );
        let id = item["workId"].as_str().unwrap();
        let startup_started = std::time::Instant::now();
        crate::source_evidence::analysis::prepare_existing_store(&root).unwrap();
        let startup_ms = startup_started.elapsed().as_secs_f64() * 1000.0;
        let count = || {
            let c = crate::source_evidence::open_read_database(&root).unwrap();
            c.query_row("SELECT count(*) FROM agent_runs", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap()
        };
        let before = count();
        let mut samples = Vec::new();
        for _ in 0..3 {
            let c = crate::source_evidence::open_read_database(&root).unwrap();
            let reader = store::load(&c, id).unwrap().grant.reader(&root).unwrap();
            drop(c);
            let arguments = item["captureArguments"].clone();
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
            let capture_barrier = barrier.clone();
            let capture = std::thread::spawn(move || {
                capture_barrier.wait();
                crate::source_evidence::analysis::execute(
                    &reader,
                    "hub_create_analysis_snapshot",
                    &arguments,
                )
            });
            barrier.wait();
            let value = ui(&root, &json!({"action":"status","id":id})).unwrap();
            let saved = capture.join().unwrap().unwrap();
            assert!(saved["snapshot"]
                .as_str()
                .is_some_and(|s| s.starts_with("analysis-v1:")));
            samples.push(json!({"projectionMs":value["nativeTiming"]["projectionMs"],"phases":value["diagnosticProjectionPhases"],"workState":value["work"]["state"],"validity":value["validity"],"snapshot":saved["snapshot"]}));
        }
        assert_eq!(
            count(),
            before,
            "offline capture/status must not start a model"
        );
        results.push(json!({"caseId":item["caseId"],"attempt":item["attempt"],"profile":root,"productionStartupMigrationMs":startup_ms,"modelCalls":0,"formalScore":null,"samples":samples}));
    }
    std::fs::write(output,serde_json::to_vec_pretty(&json!({"track":"saved completed data plus concurrent official snapshot capture/status; not exact historical live state or formal grade","results":results})).unwrap()).unwrap();
}
