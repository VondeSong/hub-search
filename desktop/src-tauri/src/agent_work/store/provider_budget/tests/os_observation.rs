//! Explicitly authorized real OS observation. Ignored unless exact private paths,
//! frozen contract and one-run sentinel are supplied. No source business writes.
use super::*;
use std::path::{Path, PathBuf};
fn paths() -> (PathBuf, PathBuf, Value) {
    let project = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .canonicalize()
        .unwrap();
    let root = PathBuf::from(std::env::var("HUB_OS_OBS_ROOT").expect("explicit isolated root"));
    let out =
        PathBuf::from(std::env::var("HUB_OS_OBS_OUTPUT").expect("explicit evidence directory"));
    assert_eq!(
        root.canonicalize().unwrap(),
        project
            .join(".local/v3-os-observation-20261026/profile")
            .canonicalize()
            .unwrap()
    );
    assert_eq!(
        out.canonicalize().unwrap(),
        project
            .join("artifacts/architecture-v3-os-observation-20261026")
            .canonicalize()
            .unwrap()
    );
    assert!(root.join(".hub-isolated-runtime-v1").is_file());
    let contract: Value =
        serde_json::from_slice(&std::fs::read(out.join("operation-contract.json")).unwrap())
            .unwrap();
    assert_eq!(contract["caseId"], "OS-OBS-01");
    assert_eq!(contract["source"]["members"].as_array().unwrap().len(), 2);
    (root, out, contract)
}
fn save(out: &Path, name: &str, value: &Value) {
    std::fs::write(out.join(name), serde_json::to_vec_pretty(value).unwrap()).unwrap();
}
#[test]
#[ignore = "explicit authorized two-note OS scope; prepare only, no model"]
fn os_real_observation_prepare_once() {
    let (root, out, contract) = paths();
    assert!(!out.join("initial-state.json").exists());
    let notes = contract["source"]["members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["locator"].clone())
        .collect::<Vec<_>>();
    let created=ui(&root,&json!({"action":"create","goal":contract["goal"],"successCriteria":contract["successCriteria"],"anchor":notes[0],"grant":{"libraryIds":[],"notes":notes,"readingItemKeys":[]}})).unwrap();
    let id = created["work"]["id"].as_str().unwrap();
    assert_ne!(id, "work-qmx-qclI33T4evy-Xe9Dpb4Z");
    ui(&root,&json!({"action":"configureAssistant","id":id,"options":{"model":crate::model_runtime::Settings::default(),"autoFlashcardInbox":false}})).unwrap();
    let v=ui(&root,&json!({"action":"freezeProviderBudget","id":id,"expectedWorkRevision":1,"limits":contract["budget"]["work"],"perRun":contract["budget"]["perRun"],"unknownReservations":{}})).unwrap();
    let c = crate::source_evidence::open_read_database(&root).unwrap();
    let w = load(&c, id).unwrap();
    let reader = w.grant.reader(&root).unwrap();
    let mut shared =
        crate::hub_capabilities::Session::new(&root, Some(w.grant.scope().unwrap())).unwrap();
    let mut proof = Vec::new();
    for member in contract["source"]["members"].as_array().unwrap() {
        let locator: crate::source_evidence::EvidenceLocator =
            serde_json::from_value(member["locator"].clone()).unwrap();
        let actual=shared.call("hub_read_note",&json!({"libraryId":member["locator"]["libraryId"],"documentId":member["locator"]["documentId"],"maxChars":6000}),"controlled preflight only").unwrap();
        let excerpt = reader.read(&locator, 0, 6000, None).unwrap();
        assert_eq!(actual["sourceHash"], member["sourceHash"]);
        assert_eq!(actual["content"], excerpt.content);
        assert_eq!(actual["truncated"], false);
        proof.push(json!({"locator":locator,"version":excerpt.version,"sourceHash":actual["sourceHash"],"characters":actual["originalChars"]}));
    }
    assert_eq!(
        c.query_row::<i64, _, _>(
            "SELECT count(*) FROM agent_runs WHERE work_id=?1",
            [id],
            |r| r.get(0)
        )
        .unwrap(),
        0
    );
    save(
        &out,
        "initial-state.json",
        &json!({"caseId":"OS-OBS-01","root":root,"workId":id,"view":v,"sourceProof":proof,"ruleReads":shared.rule_reads(),"runs":0,"models":0,"businessActions":0,"evidenceLayer":"formal backend scope/rule/provider-policy preparation; not model success"}),
    );
}
#[test]
#[ignore = "exactly one authorized real OS provider Run; final candidate binding and external bounded controller required"]
fn os_real_observation_model_once() {
    let (root, out, contract) = paths();
    let initial: Value =
        serde_json::from_slice(&std::fs::read(out.join("initial-state.json")).unwrap()).unwrap();
    let binding: Value = serde_json::from_slice(
        &std::fs::read(out.join("run-freeze.json")).expect("candidate/harness binding required"),
    )
    .unwrap();
    assert_eq!(binding["caseId"], "OS-OBS-01");
    assert_eq!(binding["phase"], "observe_only");
    assert_eq!(binding["packageVersion"], env!("CARGO_PKG_VERSION"));
    assert!(!out.join("model-run-start.json").exists());
    let id = initial["workId"].as_str().unwrap();
    assert_ne!(id, "work-qmx-qclI33T4evy-Xe9Dpb4Z");
    let c = crate::source_evidence::open_read_database(&root).unwrap();
    let before = load(&c, id).unwrap();
    assert!(before.active_run.is_none());
    assert_eq!(before.state, "ready");
    assert_eq!(
        c.query_row::<i64, _, _>(
            "SELECT count(*) FROM agent_runs WHERE work_id=?1",
            [id],
            |r| r.get(0)
        )
        .unwrap(),
        0
    );
    drop(c);
    let limits = &contract["budget"]["hostPerRun"];
    let n = |key: &str| limits[key].as_u64().unwrap();
    let b = Budget {
        model_calls: n("modelCalls") as usize,
        output_repair_calls: n("outputRepairCalls") as usize,
        tool_steps: n("toolSteps") as usize,
        summaries: n("summaries") as usize,
        entities: n("entities") as usize,
        body_chars: n("bodyChars") as usize,
        request_bytes: n("requestBytes") as usize,
        seconds: n("seconds"),
        model_call_seconds: n("modelCallSeconds"),
    };
    assert_eq!(b.model_calls, 1);
    assert_eq!(b.output_repair_calls, 0);
    assert!(b.seconds <= 180 && b.tool_steps <= 16);
    save(
        &out,
        "model-run-start.json",
        &json!({"caseId":"OS-OBS-01","workId":id,"phase":"observe_only","budget":b,"packageVersion":env!("CARGO_PKG_VERSION"),"additionalAttempts":0}),
    );
    let began = std::time::Instant::now();
    let response = crate::agent_work::run_mode(&root, id, b, true);
    let duration = began.elapsed().as_secs_f64() * 1000.0;
    save(
        &out,
        "model-return.json",
        &match &response {
            Ok(v) => json!({"returned":true,"elapsedMs":duration,"view":v}),
            Err(error) => json!({"returned":false,"elapsedMs":duration,"error":error}),
        },
    );
    let view = ui(&root, &json!({"action":"status","id":id})).unwrap();
    let c = crate::source_evidence::open_read_database(&root).unwrap();
    let mut q=c.prepare("SELECT id,run_id,kind,body_json,created_at FROM agent_records WHERE work_id=?1 ORDER BY rowid").unwrap();
    let rows = q
        .query_map([id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let run_count: i64 = c
        .query_row(
            "SELECT count(*) FROM agent_runs WHERE work_id=?1",
            [id],
            |r| r.get(0),
        )
        .unwrap();
    let actions: i64 = c
        .query_row(
            "SELECT count(*) FROM agent_actions WHERE work_id=?1",
            [id],
            |r| r.get(0),
        )
        .unwrap();
    save(&out, "actual-records.json", &json!(rows));
    save(
        &out,
        "final-state.json",
        &json!({"caseId":"OS-OBS-01","workId":id,"view":view,"runs":run_count,"businessActions":actions,"elapsedMs":duration,"quality":"unscored; independent frozen reference must be consumed","evidenceLayer":"actual provider through formal production backend; no native GUI timing claim"}),
    );
    assert_eq!(run_count, 1);
    assert_eq!(actions, 0);
}
