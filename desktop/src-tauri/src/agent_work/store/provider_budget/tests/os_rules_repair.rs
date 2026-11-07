//! One authorized supplemental batch; real data in isolated profiles only.
use super::*;
use std::path::PathBuf;
const WORK: &str = "work-MJNpXNOAZu2AzGemGE5bCWiR";
fn read(p: &std::path::Path) -> Value {
    serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap()
}
fn save(p: &std::path::Path, v: &Value) {
    std::fs::write(p, serde_json::to_vec_pretty(v).unwrap()).unwrap();
}
fn paths() -> (PathBuf, PathBuf, Value) {
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .canonicalize()
        .unwrap();
    let out = base.join("artifacts/architecture-v3-os-rules-repair-20261026");
    let root =
        PathBuf::from(std::env::var("HUB_OS_REPAIR_ROOT").expect("explicit isolated profile"));
    assert!(root
        .canonicalize()
        .unwrap()
        .starts_with(base.join(".local")));
    assert!(root.join(".hub-isolated-runtime-v1").is_file());
    let contract = read(&out.join("supplement-contract.json"));
    assert_eq!(contract["workId"], WORK);
    (root, out, contract)
}
fn budget(contract: &Value, bytes: usize) -> Budget {
    let p = &contract["hostPerRun"];
    let n = |k: &str| p[k].as_u64().unwrap();
    Budget {
        model_calls: n("modelCalls") as usize,
        output_repair_calls: n("outputRepairCalls") as usize,
        tool_steps: n("toolSteps") as usize,
        summaries: n("summaries") as usize,
        entities: n("entities") as usize,
        body_chars: n("bodyChars") as usize,
        request_bytes: bytes,
        seconds: n("seconds"),
        model_call_seconds: n("modelCallSeconds"),
    }
}
fn records(root: &std::path::Path) -> Value {
    let c = crate::source_evidence::open_read_database(root).unwrap();
    let mut q=c.prepare("SELECT id,run_id,kind,body_json,created_at FROM agent_records WHERE work_id=?1 ORDER BY rowid").unwrap();
    json!(q
        .query_map([WORK], |r| Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, i64>(4)?
        )))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap())
}
#[test]
#[ignore = "two frozen offline copies: positive probe and space rejection; zero models"]
fn os_rules_preflight_probe() {
    let (root, out, contract) = paths();
    assert!(root.ends_with("preflight-profile") || root.ends_with("negative-guarded-profile"));
    let negative = root.ends_with("negative-guarded-profile");
    let name = if negative {
        "negative-guarded"
    } else {
        "positive"
    };
    assert!(!out.join(format!("{name}-preflight.json")).exists());
    let mut plan = read(&out.join("material-plan.json"));
    if negative {
        plan["requestBytes"] = read(&out.join("positive-preflight.json"))["view"]["materialBudget"]
            ["preflight"]["initialBytes"]
            .as_u64()
            .unwrap()
            .checked_sub(4096)
            .unwrap()
            .into();
    }
    let bytes = plan["requestBytes"].as_u64().unwrap() as usize;
    ui(
        &root,
        &json!({"action":"freezeMaterialPlan","id":WORK,"plan":plan}),
    )
    .unwrap();
    let c = crate::source_evidence::open_read_database(&root).unwrap();
    let reservations = facts(&c, WORK, "providerBudgetReservation").unwrap();
    let runtimes = facts(&c, WORK, "nativeRuntime").unwrap();
    drop(c);
    std::env::set_var("HUB_OS_REPAIR_PREFLIGHT_ONLY", WORK);
    let error =
        crate::agent_work::run_mode(&root, WORK, budget(&contract, bytes), true).unwrap_err();
    std::env::remove_var("HUB_OS_REPAIR_PREFLIGHT_ONLY");
    let view = ui(&root, &json!({"action":"status","id":WORK})).unwrap();
    let c = crate::source_evidence::open_read_database(&root).unwrap();
    assert_eq!(
        facts(&c, WORK, "providerBudgetReservation").unwrap(),
        reservations
    );
    assert_eq!(facts(&c, WORK, "nativeRuntime").unwrap(), runtimes);
    save(
        &out.join(format!("{name}-preflight.json")),
        &json!({"error":error,"view":view,"providerReservationsUnchanged":true,"newProviderRequests":0,"expectedInsufficient":negative}),
    );
    if negative {
        assert!(error.contains("启动前材料余量不足"), "{error}");
        assert_eq!(view["materialBudget"]["preflight"]["allowed"], false);
    } else {
        assert!(error.contains("已保存材料预检诊断"), "{error}");
        assert_eq!(view["materialBudget"]["preflight"]["allowed"], true);
    }
}
#[test]
#[ignore = "one authorized real validation, original Work; no repeat"]
fn os_rules_actual_once() {
    let (root, out, contract) = paths();
    assert!(
        !out.join("negative-incident.json").exists(),
        "batch real-call allowance consumed by preserved incident; no further model calls"
    );
    assert!(root.ends_with("v3-os-observation-20261026/profile"));
    assert!(std::env::var_os("HUB_OS_REPAIR_PREFLIGHT_ONLY").is_none());
    let freeze = read(&out.join("run-freeze.json"));
    assert_eq!(freeze["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(freeze["workId"], WORK);
    assert!(!out.join("actual-model-start.json").exists());
    let before = ui(&root, &json!({"action":"status","id":WORK})).unwrap();
    assert_eq!(
        before["lifecycle"]["providerBudget"]["chargedOrReserved"],
        tokens(350000, 110000, 4500)
    );
    assert_eq!(before["lifecycle"]["providerBudget"]["canAdmitRun"], true);
    let c = crate::source_evidence::open_read_database(&root).unwrap();
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM agent_runs WHERE work_id=?1",
            [WORK],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    let original_reservations = facts(&c, WORK, "providerBudgetReservation").unwrap();
    drop(c);
    ui(&root,&json!({"action":"freezeMaterialPlan","id":WORK,"plan":read(&out.join("material-plan.json"))})).unwrap();
    save(
        &out.join("actual-model-start.json"),
        &json!({"workId":WORK,"version":env!("CARGO_PKG_VERSION"),"attempt":1,"originalReservations":original_reservations}),
    );
    let start = std::time::Instant::now();
    let result = crate::agent_work::run_mode(&root, WORK, budget(&contract, 196608), true);
    let elapsed = start.elapsed().as_secs_f64() * 1000.0;
    save(
        &out.join("actual-model-return.json"),
        &json!({"returned":result.is_ok(),"error":result.as_ref().err(),"elapsedMs":elapsed}),
    );
    let view = ui(&root, &json!({"action":"status","id":WORK})).unwrap();
    save(&out.join("actual-final-state.json"), &view);
    save(&out.join("actual-records.json"), &records(&root));
    let c = crate::source_evidence::open_read_database(&root).unwrap();
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM agent_runs WHERE work_id=?1",
            [WORK],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        2
    );
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM agent_actions WHERE work_id=?1",
            [WORK],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    let after = facts(&c, WORK, "providerBudgetReservation").unwrap();
    for old in original_reservations {
        assert!(after.contains(&old));
    }
}

#[test]
#[ignore = "read-only status reconciliation of interrupted incident; no model"]
fn os_rules_incident_status_only() {
    let (root, out, _) = paths();
    assert!(root.ends_with("negative-profile"));
    assert!(out.join("negative-incident.json").exists());
    let view = ui(&root, &json!({"action":"status","id":WORK})).unwrap();
    save(&out.join("incident-reconciled-state.json"), &view);
    save(
        &out.join("incident-reconciled-records.json"),
        &records(&root),
    );
    assert_eq!(
        view["lifecycle"]["providerBudget"]["chargedOrReserved"],
        tokens(700000, 220000, 9000)
    );
    assert_eq!(view["lifecycle"]["providerBudget"]["canAdmitRun"], false);
}
