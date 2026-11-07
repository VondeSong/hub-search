//! Explicit saved-fixture checks only. No UI access or alternate product owner.
use super::*;
use std::time::{Duration, Instant};

fn paths() -> (PathBuf, PathBuf, String) {
    let root = PathBuf::from(std::env::var("HUB_V3_SAVED_ROOT").unwrap());
    let output = PathBuf::from(std::env::var("HUB_V3_SAVED_OUTPUT").unwrap());
    let allowed = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../.local")
        .canonicalize()
        .unwrap();
    assert!(root.canonicalize().unwrap().starts_with(allowed));
    assert!(root.join(".hub-isolated-runtime-v1").is_file());
    let id = std::env::var("HUB_V3_SAVED_WORK").unwrap();
    (root, output, id)
}
fn save(out: &Path, name: &str, value: &Value) {
    std::fs::write(out.join(name), serde_json::to_vec_pretty(value).unwrap()).unwrap();
}
fn command(view: &Value, action: &str, token: &str) -> Value {
    json!({"action":action,"id":view["work"]["id"],"commandId":token,
        "expectedControlRevision":view["lifecycle"]["controlRevision"],
        "expectedWorkRevision":view["work"]["revision"],"expectedRunId":view["lifecycle"]["activeRunId"],"mode":"quick"})
}

#[test]
#[ignore = "saved M1 readback + exactly three diagnostic projections; no model or business write"]
fn saved_m1_history_and_projection_once() {
    let (root, out, id) = paths();
    assert!(!out.join("saved-readback.json").exists());
    let mut samples = Vec::new();
    for _ in 0..3 {
        let began = Instant::now();
        let view = ui(&root, &json!({"action":"status","id":id})).unwrap();
        assert_eq!(view["work"]["state"], "completed");
        assert_eq!(view["work"]["grant"]["notes"].as_array().unwrap().len(), 2);
        assert!(view["conversation"]["messages"][1]["report"]["summary"]
            .as_str()
            .unwrap()
            .contains("合成初态"));
        samples.push(json!({"elapsedMs":began.elapsed().as_secs_f64()*1000.0,"view":view}));
    }
    let artifact = samples[0]["view"]["analysisArtifacts"][0]["artifactId"]
        .as_str()
        .unwrap();
    let old = ui(
        &root,
        &json!({"action":"artifact","id":id,"artifactId":artifact,"revision":1}),
    )
    .unwrap();
    let new = ui(
        &root,
        &json!({"action":"artifact","id":id,"artifactId":artifact,"revision":2}),
    )
    .unwrap();
    assert_eq!(old["revision"], 1);
    assert_eq!(old["currentRevision"], 2);
    assert_eq!(
        old["content"]["data"]["rows"],
        json!([{"group":"2025-01","value":2}])
    );
    assert_eq!(
        new["content"]["data"]["rows"],
        json!([{"group":"2025-01","value":2},{"group":"2025-02","value":1}])
    );
    save(
        &out,
        "saved-readback.json",
        &json!({"evidenceLayer":"formal production backend, not native visual","models":0,"projectionSamples":samples,"old":old,"current":new,"diagnosticOnlyNotReplacementFor170msFailure":true}),
    );
}

#[test]
#[ignore = "one actual-provider pause/reopen scenario; explicit isolated root, phase, output and termination controller required"]
fn saved_pause_process_reopen_once() {
    let (root, out, id) = paths();
    let phase = std::env::var("HUB_V3_RECOVERY_PHASE").unwrap();
    let attempt = std::env::var("HUB_V3_RECOVERY_ATTEMPT").unwrap_or_default();
    assert!(matches!(attempt.as_str(), "" | "R1" | "R2"));
    let r2 = attempt == "R2";
    let r1 = attempt == "R1" || r2;
    let base_runs = if r2 {
        4
    } else if r1 {
        3
    } else {
        2
    };
    let key = |suffix: &str| {
        if r2 {
            format!("v3-m2-r2-{suffix}")
        } else if r1 {
            format!("v3-m2-r1-{suffix}")
        } else {
            format!("v3-m2-{suffix}")
        }
    };
    let before = ui(&root, &json!({"action":"status","id":id})).unwrap();
    if phase == "preflight" {
        assert!(
            r2,
            "only the final repaired fixture uses this prerequisite check"
        );
        assert_eq!(before["work"]["state"], "failed");
        assert_eq!(before["lifecycle"]["runsUsed"], base_runs);
        assert_eq!(before["actions"]["items"], json!([]));
        let w = store::load(
            &crate::source_evidence::open_read_database(&root).unwrap(),
            &id,
        )
        .unwrap();
        let reader = w.grant.reader(&root).unwrap();
        let capabilities =
            crate::hub_capabilities::Session::new(&root, Some(w.grant.scope().unwrap())).unwrap();
        let mut reads = Vec::new();
        for locator in &w.grant.notes {
            let excerpt = reader.read(locator, 0, 8000, None).unwrap();
            assert!(!excerpt.content.is_empty());
            reads.push(json!({"locator":locator,"version":excerpt.version,"characters":excerpt.content.chars().count()}));
        }
        save(
            &out,
            "preflight.json",
            &json!({"work":before["work"],"runsUsed":base_runs,"selectedReads":reads,
            "ruleReads":capabilities.rule_reads(),"modelsStarted":0,"qualifiedPause":false,
            "evidenceLayer":"formal scope/rule/source prerequisites after owned fixture restoration; no runtime/tool-result records or model"}),
        );
    } else if phase == "usage-inspect" {
        assert!(!out.join("usage-inspection.json").exists());
        assert_eq!(before["work"]["state"], "interrupted");
        assert_eq!(before["lifecycle"]["usageCompleteness"], "incomplete");
        assert_eq!(
            before["lifecycle"]["unmeasuredRunIds"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(before["lifecycle"]["recordedUsageIsLowerBound"], true);
        save(
            &out,
            "usage-inspection.json",
            &json!({"view":before,"modelsStarted":0,"evidenceLayer":"formal backend saved incomplete usage projection; not a model retry or pause success"}),
        );
    } else if phase == "inspect" {
        assert!(!out.join("interrupted-inspection.json").exists());
        assert_eq!(before["work"]["state"], "interrupted");
        assert_eq!(before["runActive"], false);
        assert_eq!(before["lifecycle"]["runsUsed"], 3);
        assert_eq!(store::records(&root, &id, "delivery", 10).unwrap().len(), 2);
        save(
            &out,
            "interrupted-inspection.json",
            &json!({"view":before,"modelsStarted":0,"evidenceLayer":"formal status reconciled crashed backend host, not a qualified pause or GUI restart"}),
        );
    } else if phase == "pause" {
        assert!(!out.join("pause-ready.json").exists());
        assert_eq!(
            before["work"]["state"],
            if r2 {
                "failed"
            } else if r1 {
                "interrupted"
            } else {
                "completed"
            }
        );
        assert_eq!(before["lifecycle"]["runsUsed"], base_runs);
        ui(&root,&json!({"action":"message","id":id,"expectedRevision":before["work"]["revision"],"clientMessageId":key("before-pause"),"text":"请重新读取两份授权原文并核对现有图表，在同一事项的报告中补充来源覆盖与方法局限。保留原始目标、同一图表及已有数值，不修改来源，不另建事项。"})).unwrap();
        let host_root = root.clone();
        let host_id = id.clone();
        let model = std::thread::spawn(move || {
            ui(
                &host_root,
                &json!({"action":"respond","id":host_id,"mode":"quick"}),
            )
        });
        let began = Instant::now();
        let mut actual_read = Value::Null;
        while began.elapsed() < Duration::from_secs(60) && !model.is_finished() {
            let c = crate::source_evidence::open_read_database(&root).unwrap();
            let w = store::load(&c, &id).unwrap();
            if let Some(run) = w.active_run.as_deref() {
                let raw:Option<String>=c.query_row("SELECT body_json FROM agent_records WHERE run_id=?1 AND kind='toolResult' AND json_extract(body_json,'$.request.name') IN ('hub_read_note','hub_read_analysis_snapshot') AND json_type(body_json,'$.error') IS NULL AND (json_type(body_json,'$.content')='text' OR json_type(body_json,'$.items')='array' OR json_type(body_json,'$.excerpt.content')='text') ORDER BY rowid LIMIT 1",[run],|r|r.get(0)).optional().unwrap();
                if let Some(raw) = raw {
                    actual_read = json!({"runId":run,"record":serde_json::from_str::<Value>(&raw).unwrap(),"observedAfterMs":began.elapsed().as_millis()});
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let active = ui(&root, &json!({"action":"status","id":id})).unwrap();
        if actual_read.is_null() || active["runActive"] != true {
            if active["runActive"] == true {
                let _ = ui(
                    &root,
                    &command(&active, "cancel", &key("qualification-cleanup")),
                );
            }
            save(
                &out,
                "pause-ineligible.json",
                &json!({"actualRead":actual_read,"view":active,"reason":"actual read did not qualify before completion/deadline; no model retry"}),
            );
            panic!("pause trigger did not qualify; dependent resume must stop");
        }
        let stopping = ui(&root, &command(&active, "cancel", &key("stop"))).unwrap();
        assert_eq!(stopping["work"]["state"], "paused");
        let settle = Instant::now();
        while !model.is_finished() && settle.elapsed() < Duration::from_secs(60) {
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(
            model.is_finished(),
            "provider did not settle within bounded stop time"
        );
        let outcome = model.join().unwrap();
        let paused = ui(&root, &json!({"action":"status","id":id})).unwrap();
        assert_eq!(paused["work"]["state"], "paused");
        assert_eq!(paused["runActive"], false);
        assert_eq!(paused["lifecycle"]["runsUsed"], base_runs + 1);
        assert_eq!(paused["actions"]["items"], json!([]));
        save(
            &out,
            "pause-ready.json",
            &json!({"pid":std::process::id(),"actualRead":actual_read,"before":before,"stopping":stopping,"paused":paused,"providerSettled":true,"modelOutcome":outcome,"stopSettlingMs":settle.elapsed().as_millis(),"waitingForOwnedProcessTermination":true}),
        );
        // The external one-shot controller terminates this exact verified host.
        std::thread::sleep(Duration::from_secs(120));
        panic!("termination controller did not terminate host; no resume permitted");
    } else if phase == "resume" {
        assert!(!out.join("resume-result.json").exists());
        let prior: Value =
            serde_json::from_slice(&std::fs::read(out.join("pause-ready.json")).unwrap()).unwrap();
        let terminated: Value =
            serde_json::from_slice(&std::fs::read(out.join("process-terminated.json")).unwrap())
                .unwrap();
        assert_eq!(terminated["verifiedPid"], prior["pid"]);
        assert_eq!(terminated["exited"], true);
        assert_eq!(before["work"]["state"], "paused");
        assert_eq!(before["lifecycle"]["runsUsed"], base_runs + 1);
        assert_eq!(before["work"]["id"], prior["paused"]["work"]["id"]);
        assert_eq!(
            before["lifecycle"]["recordedUsage"],
            prior["paused"]["lifecycle"]["recordedUsage"]
        );
        let appended=ui(&root,&json!({"action":"message","id":id,"expectedRevision":before["work"]["revision"],"clientMessageId":key("paused-append"),"text":"恢复后请在报告中明确补充：文字提及不代表真实学习事件，且本地材料尚未核验远端完整性。仍保留原始目标、同一图表和全部历史，不修改来源。"})).unwrap();
        assert_eq!(appended["work"]["state"], "paused");
        assert_eq!(appended["lifecycle"]["runsUsed"], base_runs + 1);
        let began = Instant::now();
        let resume = command(&appended, "resume", &key("resume"));
        let result = if r1 {
            let saved_root = root.clone();
            let args = resume.clone();
            let worker = std::thread::spawn(move || {
                let started = Instant::now();
                (ui(&saved_root, &args), started.elapsed().as_millis())
            });
            while !worker.is_finished() && began.elapsed() < Duration::from_secs(90) {
                std::thread::sleep(Duration::from_millis(50));
            }
            if !worker.is_finished() {
                let current = ui(&root, &json!({"action":"status","id":id})).unwrap();
                let stop = if current["runActive"] == true {
                    ui(
                        &root,
                        &command(&current, "cancel", &key("resume-deadline-stop")),
                    )
                } else {
                    Ok(current.clone())
                };
                save(
                    &out,
                    "resume-deadline.json",
                    &json!({"elapsedMs":began.elapsed().as_millis(),"view":current,"stop":stop,"frozenMaximumMs":90000}),
                );
                let settling = Instant::now();
                while !worker.is_finished() && settling.elapsed() < Duration::from_secs(20) {
                    std::thread::sleep(Duration::from_millis(50));
                }
                assert!(
                    worker.is_finished(),
                    "resume exceeded deadline and failed to stop; external owner cleanup required"
                );
            }
            let (result, elapsed) = worker.join().unwrap();
            save(
                &out,
                "resume-model-return.json",
                &json!({"elapsedMs":elapsed,"result":result}),
            );
            assert!(
                elapsed <= 90000,
                "frozen resume useful time exceeded; do not regrade or retry"
            );
            result
        } else {
            ui(&root, &resume)
        };
        save(
            &out,
            "resume-result.json",
            &json!({"reopened":before,"appendedWithoutRun":appended,"elapsedMs":began.elapsed().as_millis(),"result":result,"pid":std::process::id(),"evidenceLayer":"real backend host process reopen and actual native provider; not GUI"}),
        );
        let final_view = result.unwrap();
        assert_eq!(final_view["work"]["state"], "completed");
        assert_eq!(final_view["lifecycle"]["runsUsed"], base_runs + 2);
        assert_eq!(final_view["actions"]["items"], json!([]));
    } else {
        panic!("unsupported phase");
    }
}
