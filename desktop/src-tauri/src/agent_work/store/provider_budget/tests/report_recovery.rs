//! One explicitly renewed same-Work recovery; old extraction and failures stay immutable.
use super::*;
use std::path::{Path, PathBuf};
fn read(path: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}
fn save(out: &Path, name: &str, value: &Value) {
    std::fs::write(out.join(name), serde_json::to_vec_pretty(value).unwrap()).unwrap();
}
fn records(f: &Fixture, id: &str) -> Value {
    let c = f.c();
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
    json!(rows)
}
fn sources(f: &Fixture) -> Value {
    let c = f.c();
    let mut q = c
        .prepare("SELECT id,markdown,content_hash FROM documents ORDER BY id")
        .unwrap();
    let rows = q
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    json!(rows)
}
#[test]
#[ignore = "one authorized same-Work report recovery, no new extraction or application build"]
fn saved_two_batch_report_recovery_once() {
    assert_eq!(std::env::var("HUB_REPORT_RECOVERY_ONCE").unwrap(), "1");
    assert!(std::env::var_os("HUB_OS_REPAIR_PREFLIGHT_ONLY").is_none());
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .canonicalize()
        .unwrap();
    let out = base.join("artifacts/architecture-v3-report-recovery-20261027");
    let prior = base.join("artifacts/architecture-v3-manifest-admission-20261027");
    let contract = read(&out.join("contract.json"));
    assert_eq!(contract["maxActualRuns"], 1);
    assert_eq!(contract["applicationBuilds"], 0);
    assert_eq!(contract["candidate"]["version"], env!("CARGO_PKG_VERSION"));
    let root = PathBuf::from(contract["profile"].as_str().unwrap())
        .canonicalize()
        .unwrap();
    assert!(
        root.starts_with(base.join(".local"))
            && root.ends_with("v3-manifest-admission-20261027/profile")
    );
    assert!(root.join(".hub-isolated-runtime-v1").is_file());
    let id = contract["workId"].as_str().unwrap();
    assert_eq!(id, "work-IH_E4BbShM5GIXA421-Kp1Mv");
    assert!(!out.join("invocation-started.json").exists());
    let f = std::mem::ManuallyDrop::new(Fixture { root: root.clone() });
    let before = records(&f, id);
    assert_eq!(before, read(&prior.join("actual-records.json")));
    assert_eq!(sources(&f), read(&prior.join("source-before.json")));
    let w = load(&f.c(), id).unwrap();
    assert_eq!(w.revision, 1);
    assert_eq!(w.authorization_version, 1);
    assert_eq!(w.state, "interrupted");
    assert!(w.active_run.is_none());
    let reserved = facts(&f.c(), id, "providerBudgetReservation").unwrap();
    let datasets = facts(&f.c(), id, "sleepDatasetRevision").unwrap();
    assert_eq!(reserved.len(), 1);
    assert_eq!(datasets.len(), 2);
    let initial = ui(&root, &json!({"action":"status","id":id})).unwrap();
    assert_eq!(
        initial["lifecycle"]["providerBudget"]["limits"],
        contract["oldLimits"]
    );
    assert_eq!(
        initial["lifecycle"]["providerBudget"]["chargedOrReserved"],
        contract["perRun"]
    );
    for value in &datasets {
        let current=ui(&root,&json!({"action":"sleepDataset","id":id,"datasetId":value["datasetId"],"revision":value["revision"]})).unwrap();
        assert_eq!(current["state"], "current");
        assert_eq!(current["content"], *value);
    }
    save(
        &out,
        "qualification.json",
        &json!({"passed":true,"modelCalls":0,"workId":id,"datasets":contract["datasets"],"originalWorkState":w.state,"oldRecords":before.as_array().unwrap().len(),"sourceRows":40,"oldUnknownReservationRetained":true}),
    );
    let mut marker = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(out.join("invocation-started.json"))
        .unwrap();
    use std::io::Write;
    marker
        .write_all(b"one recovery invocation; no automatic retry\n")
        .unwrap();
    marker.sync_all().unwrap();
    ui(&root,&json!({"action":"extendProviderBudget","id":id,"operationId":"saved-batch-report-recovery-once-20261027","reason":contract["reason"],"expectedWorkRevision":1,"expectedAuthorizationVersion":1,"expectedLimits":contract["oldLimits"],"limits":contract["futureLimits"]})).unwrap();
    ui(&root,&json!({"action":"message","id":id,"clientMessageId":"synthetic-report-recovery-20261027","expectedRevision":1,"text":contract["message"]})).unwrap();
    let current = load(&f.c(), id).unwrap();
    assert_eq!(current.revision, 2);
    assert_eq!(current.authorization_version, 1);
    assert_eq!(json!(current.grant), json!(w.grant));
    let old = crate::agent_work::store::material_budget::load_on(&f.c(), id)
        .unwrap()
        .unwrap();
    let mut plan = json!(old);
    plan["workRevision"] = json!(2);
    plan["reads"] = json!(plan["reads"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|v| matches!(
            v["locator"]["documentId"].as_str(),
            Some("daily/n00" | "daily/n31")
        ))
        .cloned()
        .collect::<Vec<_>>());
    assert_eq!(plan["reads"].as_array().unwrap().len(), 2);
    plan["basis"]=json!("Same-Work report recovery: two current note receipts for current citations, saved2 datasets each below40000 bytes and explicit batchSummary below48000, current goal/working envelopes plus existing bounded262144 reply allowance. No new extraction, snapshots, semantic defaults or budget reset.");
    ui(
        &root,
        &json!({"action":"freezeMaterialPlan","id":id,"expectedPlan":old,"plan":plan}),
    )
    .unwrap();
    let ready = ui(&root, &json!({"action":"status","id":id})).unwrap();
    assert_eq!(ready["lifecycle"]["providerBudget"]["canAdmitRun"], true);
    assert_eq!(
        ready["lifecycle"]["providerBudget"]["chargedOrReserved"],
        contract["perRun"]
    );
    assert_eq!(facts(&f.c(), id, "sleepDatasetRevision").unwrap(), datasets);
    for value in &datasets {
        assert_eq!(ui(&root,&json!({"action":"sleepDataset","id":id,"datasetId":value["datasetId"],"revision":value["revision"]})).unwrap()["content"],*value);
    }
    save(&out, "ready-state.json", &ready);
    save(&out, "material-plan.json", &plan);
    let run_start = std::time::Instant::now();
    let returned = crate::agent_work::run_mode(
        &root,
        id,
        crate::agent_work::assistant::budget("deep").unwrap(),
        true,
    );
    save(
        &out,
        "actual-return.json",
        &json!({"ok":returned.is_ok(),"error":returned.as_ref().err(),"elapsedMs":run_start.elapsed().as_secs_f64()*1000.0}),
    );
    let after = ui(&root, &json!({"action":"status","id":id})).unwrap();
    save(&out, "actual-state.json", &after);
    let all = records(&f, id);
    save(&out, "actual-records.json", &all);
    assert!(all
        .as_array()
        .unwrap()
        .starts_with(before.as_array().unwrap()));
    assert_eq!(sources(&f), read(&prior.join("source-before.json")));
    assert_eq!(facts(&f.c(), id, "sleepDatasetRevision").unwrap(), datasets);
    let allocations = facts(&f.c(), id, "providerBudgetReservation").unwrap();
    assert!(allocations.starts_with(&reserved));
    assert_eq!(allocations.len(), 2);
    assert_eq!(
        f.c()
            .query_row(
                "SELECT count(*) FROM agent_actions WHERE work_id=?1",
                [id],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    assert_eq!(
        f.c()
            .query_row(
                "SELECT count(*) FROM agent_runs WHERE work_id=?1",
                [id],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        3
    );
    assert!(returned.is_ok(), "{:?}", returned.err());
    assert!(after["work"]["report"].is_object());
}
