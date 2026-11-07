use super::*;
use std::path::PathBuf;

#[test]
#[ignore = "one current-state preflight or one admitted continuation; original failures retained"]
fn corrected_path_admission() {
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .canonicalize()
        .unwrap();
    let out = base.join("artifacts/architecture-v3-os-admission-20261026");
    let contract = read(&out.join("contract.json"));
    let root = PathBuf::from(contract["profile"].as_str().unwrap());
    assert!(root
        .canonicalize()
        .unwrap()
        .starts_with(base.join(".local")));
    assert!(root.ends_with("negative-profile"));
    assert!(root.join(".hub-isolated-runtime-v1").is_file());
    assert_eq!(contract["workId"], WORK);
    let phase = std::env::var("HUB_OS_ADMISSION_PHASE").unwrap();
    assert!(phase == "preflight" || phase == "actual");
    let probe = phase == "preflight";
    assert!(!out.join(format!("{phase}-state.json")).exists());
    if probe {
        std::env::set_var("HUB_OS_REPAIR_PREFLIGHT_ONLY", WORK);
    } else {
        assert!(std::env::var_os("HUB_OS_REPAIR_PREFLIGHT_ONLY").is_none());
        assert_eq!(
            read(&out.join("preflight-state.json"))["materialBudget"]["preflight"]["allowed"],
            true
        );
    }
    let before = ui(&root, &json!({"action":"status","id":WORK})).unwrap();
    assert_eq!(before["work"]["revision"], 1);
    assert_eq!(before["work"]["authorizationVersion"], 1);
    assert_eq!(
        before["lifecycle"]["providerBudget"]["chargedOrReserved"],
        tokens(1050000, 330000, 13500)
    );
    let c = crate::source_evidence::open_read_database(&root).unwrap();
    let reservations_before = facts(&c, WORK, "providerBudgetReservation").unwrap();
    assert_eq!(reservations_before.len(), 3);
    let runtime_before = facts(&c, WORK, "nativeRuntime").unwrap().len();
    assert_eq!(runtime_before, 3);
    let old_plan = crate::agent_work::store::material_budget::load_on(&c, WORK)
        .unwrap()
        .unwrap();
    drop(c);
    let mut sentinel = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(out.join(format!("{phase}-started.json")))
        .expect("one attempt per phase");
    use std::io::Write;
    sentinel.write_all(serde_json::to_string(&json!({"phase":phase,"maxModelRuns":if probe{0}else{1},"version":env!("CARGO_PKG_VERSION")})).unwrap().as_bytes()).unwrap();
    sentinel.sync_all().unwrap();
    ui(&root,&json!({"action":"extendProviderBudget","id":WORK,"operationId":"os-corrected-path-once-20261026","reason":"one prospective 224KiB continuation after corrected current-state preflight; retain all three unknown reservations","expectedWorkRevision":1,"expectedAuthorizationVersion":1,"expectedLimits":contract["originalLimits"],"limits":contract["futureLimits"]})).unwrap();
    ui(&root,&json!({"action":"freezeMaterialPlan","id":WORK,"expectedPlan":old_plan,"plan":read(&out.join("material-plan.json"))})).unwrap();
    let budget = Budget {
        model_calls: 1,
        output_repair_calls: 0,
        tool_steps: 16,
        summaries: 20,
        entities: 2,
        body_chars: 6000,
        request_bytes: 229376,
        seconds: 180,
        model_call_seconds: 120,
    };
    let started = std::time::Instant::now();
    let returned = crate::agent_work::run_mode(&root, WORK, budget, true);
    std::env::remove_var("HUB_OS_REPAIR_PREFLIGHT_ONLY");
    save(
        &out.join(format!("{phase}-return.json")),
        &json!({"ok":returned.is_ok(),"error":returned.as_ref().err(),"elapsedMs":started.elapsed().as_secs_f64()*1000.0}),
    );
    let view = ui(&root, &json!({"action":"status","id":WORK})).unwrap();
    save(&out.join(format!("{phase}-state.json")), &view);
    let c = crate::source_evidence::open_read_database(&root).unwrap();
    let reservations = facts(&c, WORK, "providerBudgetReservation").unwrap();
    for old in &reservations_before {
        assert!(reservations.contains(old));
    }
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM agent_actions WHERE work_id=?1",
            [WORK],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    let mut q=c.prepare("SELECT id,run_id,kind,body_json,created_at FROM agent_records WHERE work_id=?1 ORDER BY rowid").unwrap();
    let rows = q
        .query_map([WORK], |r| {
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
    save(&out.join(format!("{phase}-records.json")), &json!(rows));
    if probe {
        assert_eq!(reservations, reservations_before);
        assert_eq!(
            facts(&c, WORK, "nativeRuntime").unwrap().len(),
            runtime_before
        );
        let error = returned.unwrap_err();
        assert!(
            error.contains("已保存材料预检诊断") || error.contains("启动前材料余量不足"),
            "{error}"
        );
        assert!(view["materialBudget"]["preflight"]["allowed"].is_boolean());
    } else {
        assert!(returned.is_ok(), "{:?}", returned.err());
        assert!(view["work"]["report"].is_object());
    }
}
const WORK: &str = "work-MJNpXNOAZu2AzGemGE5bCWiR";
fn read(p: &std::path::Path) -> Value {
    serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap()
}
fn save(p: &std::path::Path, v: &Value) {
    std::fs::write(p, serde_json::to_vec_pretty(v).unwrap()).unwrap();
}
#[test]
#[ignore = "finite same-Work continuation; explicit preflight or actual phase only"]
fn same_work_delivery() {
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .canonicalize()
        .unwrap();
    let out = base.join("artifacts/architecture-v3-os-delivery-20261026");
    let contract = read(&out.join("continuation-contract.json"));
    let root = PathBuf::from(contract["profile"].as_str().unwrap());
    assert!(root
        .canonicalize()
        .unwrap()
        .starts_with(base.join(".local")));
    assert!(root.ends_with("negative-profile"));
    assert!(root.join(".hub-isolated-runtime-v1").is_file());
    assert_eq!(contract["workId"], WORK);
    let phase = std::env::var("HUB_OS_DELIVERY_PHASE").unwrap();
    assert!(phase == "preflight" || phase == "preflight2" || phase == "actual");
    let probe = phase.starts_with("preflight");
    assert!(!out.join(format!("{phase}-state.json")).exists());
    if probe {
        std::env::set_var("HUB_OS_REPAIR_PREFLIGHT_ONLY", WORK);
    } else {
        assert!(std::env::var_os("HUB_OS_REPAIR_PREFLIGHT_ONLY").is_none());
        let build = read(&out.join("candidate-freeze.json"));
        assert_eq!(build["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(build["exitCode"], 0);
        assert_eq!(
            read(&out.join("preflight2-state.json"))["materialBudget"]["preflight"]["allowed"],
            true
        );
    }
    let before = ui(&root, &json!({"action":"status","id":WORK})).unwrap();
    assert_eq!(before["work"]["revision"], 1);
    assert_eq!(before["work"]["authorizationVersion"], 1);
    assert_eq!(
        before["lifecycle"]["providerBudget"]["chargedOrReserved"],
        tokens(700000, 220000, 9000)
    );
    let c = crate::source_evidence::open_read_database(&root).unwrap();
    let old_reservations = facts(&c, WORK, "providerBudgetReservation").unwrap();
    assert_eq!(old_reservations.len(), 2);
    let runtime_count = facts(&c, WORK, "nativeRuntime").unwrap().len();
    assert_eq!(runtime_count, 2);
    let old_plan = crate::agent_work::store::material_budget::load_on(&c, WORK)
        .unwrap()
        .unwrap();
    drop(c);
    ui(&root,&json!({"action":"extendProviderBudget","id":WORK,"operationId":"os-delivery-once-20261026","reason":"user delegates continuation decisions; one future attempt, retain both unknown reservations","expectedWorkRevision":1,"expectedAuthorizationVersion":1,"expectedLimits":contract["originalLimits"],"limits":contract["futureLimits"]})).unwrap();
    let mut plan =
        read(&base.join("artifacts/architecture-v3-os-rules-repair-20261026/material-plan.json"));
    plan["workingStateRoundTrips"] = json!(1);
    plan["workingStateExtraBytes"] = json!(0);
    plan["basis"]=json!("Same-Work recovery: three current source reads for valid citations/recheck, one read of already persisted working notes, goal verification, one concrete rule restoration and prior explicit uncertainty allowance. Existing note save has valid receipt; further optional patch remains runtime-budgeted.");
    ui(
        &root,
        &json!({"action":"freezeMaterialPlan","id":WORK,"expectedPlan":old_plan,"plan":plan}),
    )
    .unwrap();
    if !probe {
        use std::io::Write;
        let mut sentinel = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(out.join("actual-model-start.json"))
            .expect("one actual call only");
        sentinel.write_all(serde_json::to_string(&json!({"workId":WORK,"version":env!("CARGO_PKG_VERSION"),"attempt":1,"oldReservations":old_reservations})).unwrap().as_bytes()).unwrap();
        sentinel.sync_all().unwrap();
    }
    let budget = Budget {
        model_calls: 1,
        output_repair_calls: 0,
        tool_steps: 16,
        summaries: 20,
        entities: 2,
        body_chars: 6000,
        request_bytes: 196608,
        seconds: 180,
        model_call_seconds: 120,
    };
    let started = std::time::Instant::now();
    let returned = crate::agent_work::run_mode(&root, WORK, budget, true);
    let elapsed = started.elapsed().as_secs_f64() * 1000.0;
    std::env::remove_var("HUB_OS_REPAIR_PREFLIGHT_ONLY");
    save(
        &out.join(format!("{phase}-return.json")),
        &json!({"ok":returned.is_ok(),"error":returned.as_ref().err(),"elapsedMs":elapsed}),
    );
    let view = ui(&root, &json!({"action":"status","id":WORK})).unwrap();
    save(&out.join(format!("{phase}-state.json")), &view);
    let c = crate::source_evidence::open_read_database(&root).unwrap();
    let reservations = facts(&c, WORK, "providerBudgetReservation").unwrap();
    for old in &old_reservations {
        assert!(reservations.contains(old));
    }
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM agent_actions WHERE work_id=?1",
            [WORK],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    let mut q=c.prepare("SELECT id,run_id,kind,body_json,created_at FROM agent_records WHERE work_id=?1 ORDER BY rowid").unwrap();
    let rows = q
        .query_map([WORK], |r| {
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
    save(&out.join(format!("{phase}-records.json")), &json!(rows));
    if probe {
        assert_eq!(reservations, old_reservations);
        assert_eq!(
            facts(&c, WORK, "nativeRuntime").unwrap().len(),
            runtime_count
        );
        assert!(returned.unwrap_err().contains("已保存材料预检诊断"));
        assert_eq!(view["materialBudget"]["preflight"]["allowed"], true);
    } else {
        assert!(returned.is_ok(), "{:?}", returned.err());
        assert!(view["work"]["report"].is_object());
    }
}
