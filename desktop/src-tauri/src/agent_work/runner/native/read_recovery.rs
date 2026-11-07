//! Bounded WG advisory checks, saved real traces and one separately admitted adoption run.
use super::*;
use std::path::{Path, PathBuf};
fn request(call: &str) -> Value {
    json!({"operation":"read","stepId":call,"locator":{"kind":"note","libraryId":"notes","documentId":"current"},"startChar":0,"maxChars":100})
}
fn raw() -> Value {
    json!({"excerpt":{"content":"核对原文","version":{"kind":"document","fingerprint":"source-v1"},"startChar":0,"endChar":4}})
}
fn reference() -> Value {
    json!({"recordId":"saved-result","sha256":"a".repeat(64)})
}
fn binding() -> Value {
    json!({"workId":"work","workRevision":1,"authorizationVersion":1,"commandWatermark":0})
}
fn event() -> Value {
    let mut p = read_progress::ReadProgress::default();
    assert!(p
        .observe(&request("first"), &raw(), &reference(), &binding(), 0, 0)
        .is_none());
    p.observe(&request("review"), &raw(), &reference(), &binding(), 0, 1)
        .unwrap()
}
#[test]
fn advisory_uses_live_schema_and_preserves_success_raw_source_and_budget_fields() {
    let hint = read_progress::recovery_options(&event(), &tools(None).unwrap()).unwrap();
    assert_eq!(hint["stallEstablished"], false);
    assert_eq!(hint["recoveryPerformed"], false);
    assert_eq!(hint["readExecution"], "executed");
    assert_eq!(hint["currentEvidence"], false);
    assert!(hint.to_string().len() <= 2048);
    let full = input::tool_output(
        raw(),
        reference(),
        json!(["same quotes"]),
        json!([{"state":"unknown"}]),
        json!({}),
        7,
    );
    let mut wire = full.clone();
    wire["runtimeGuidance"] = hint;
    assert!(wire.get("error").is_none());
    assert!(wire.to_string().len() > full.to_string().len());
    wire.as_object_mut().unwrap().remove("runtimeGuidance");
    assert_eq!(wire, full);
}
#[test]
fn absent_tool_bad_identity_and_subsequent_repeats_do_not_emit_recovery_options() {
    let specs = tools(None).unwrap();
    assert!(read_progress::recovery_options(&event(), &json!([])).is_none());
    let mut e = event();
    e["resultRef"]["sha256"] = json!("bad");
    assert!(read_progress::recovery_options(&e, &specs).is_none());
    for (key, value) in [
        ("sameReadCount", json!(3)),
        ("stallEstablished", json!(true)),
        ("decision", json!("stop_run")),
    ] {
        let mut e = event();
        e[key] = value;
        assert!(read_progress::recovery_options(&e, &specs).is_none());
    }
}
#[test]
fn formal_historical_recovery_preserves_receipt_and_revocation_still_rejects() {
    use crate::agent_work::tests::{claim, create};
    use crate::source_evidence::tests::Fixture;
    let f = Fixture::new();
    f.note("notes", "current", "当前来源保持不变");
    let id = create(&f, false);
    let (w, r) = claim(&f, &id);
    let c = f.c();
    let bind = store::goal::binding_on(&c, &w).unwrap();
    drop(c);
    let mut p = read_progress::ReadProgress::default();
    let mut hint = None;
    let mut original = Value::Null;
    for i in 0..2 {
        let mut req = request(&format!("review-{i}"));
        req["locator"] = json!(w.anchor);
        store::record(&f.root, &r, "toolCall", &req).unwrap();
        let excerpt = w
            .grant
            .reader(&f.root)
            .unwrap()
            .read(w.anchor.as_ref().unwrap(), 0, 100, None)
            .unwrap();
        original = json!({"excerpt":excerpt});
        let result = store::tool_results::capture(&f.root, &w.id, &r, &req, &original).unwrap();
        if let Some(e) = p.observe(&req, &original, &result, &bind, 0, i) {
            hint = read_progress::recovery_options(&e, &tools(None).unwrap());
        }
    }
    let hint = hint.unwrap();
    let a = &hint["recoveryOptions"][0]["arguments"];
    let control = Control::default();
    let session = assistant::Session {
        root: &f.root,
        work: &w,
        run: &r,
        control: &control,
        operation: None,
        selection: json!({}),
        app: None,
    };
    let tool = Tool::TraceResult {
        record_id: a["recordId"].as_str().unwrap().into(),
        expected_sha256: a["expectedSha256"].as_str().unwrap().into(),
        start_char: 0,
        max_chars: a["maxChars"].as_u64().unwrap() as usize,
    };
    let recovered = session.dispatch(tool).unwrap();
    assert_eq!(recovered["historical"], true);
    assert_eq!(recovered["currentEvidence"], false);
    let saved: Value = serde_json::from_str(recovered["content"].as_str().unwrap()).unwrap();
    assert_eq!(saved["excerpt"], original["excerpt"]);
    crate::agent_work::ui(&f.root, &json!({"action":"revoke","id":id})).unwrap();
    assert!(store::tool_results::read_for_work(
        &f.root,
        &w,
        a["recordId"].as_str().unwrap(),
        a["expectedSha256"].as_str().unwrap(),
        0,
        4000
    )
    .is_err());
    assert_eq!(
        f.c()
            .query_row("SELECT count(*) FROM agent_actions", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(f.c().query_row("SELECT count(*) FROM agent_records WHERE kind IN ('nativeRuntime','providerBudgetReservation')",[],|r|r.get::<_,i64>(0)).unwrap(),0);
}
fn base() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .canonicalize()
        .unwrap()
}
fn read(p: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap()
}
fn save(out: &Path, name: &str, value: &Value) {
    std::fs::write(out.join(name), serde_json::to_vec_pretty(value).unwrap()).unwrap();
}
fn records(root: &Path, id: &str) -> Value {
    let c = crate::source_evidence::open_read_database(root).unwrap();
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
#[test]
#[ignore = "one saved real legitimate-review replay; no provider or original database writes"]
fn saved_real_reviews_qualify_advisory_without_stall_claim() {
    assert_eq!(std::env::var("HUB_WG_REPLAY").unwrap(), "1");
    let base = base();
    let out = base.join("artifacts/architecture-v3-read-recovery-20261027");
    assert!(!out.join("replay-started.json").exists());
    save(&out, "replay-started.json", &json!({"modelRuns":0}));
    let rows =
        read(&base.join("artifacts/architecture-v3-os-admission-20261026/actual-records.json"));
    let mut calls = std::collections::HashMap::new();
    let mut bindings = std::collections::HashMap::new();
    for r in rows.as_array().unwrap() {
        let b: Value = serde_json::from_str(r[3].as_str().unwrap()).unwrap();
        if r[2] == "toolCall" {
            calls.insert(b["stepId"].as_str().unwrap().to_string(), b);
        } else if r[2] == "readProgressObservation" {
            bindings.insert(r[1].as_str().unwrap().to_string(), b["userBinding"].clone());
        }
    }
    let mut observers = std::collections::HashMap::new();
    let mut outcomes = Vec::new();
    for r in rows.as_array().unwrap() {
        if r[2] != "toolResult" && r[2] != "evidence" {
            continue;
        }
        let b: Value = serde_json::from_str(r[3].as_str().unwrap()).unwrap();
        let Some(call) = b["_hubTrace"]["callId"].as_str() else {
            continue;
        };
        let Some(request) = calls.get(call) else {
            continue;
        };
        if !read_progress::supports(request) {
            continue;
        }
        let run = r[1].as_str().unwrap();
        let Some(bind) = bindings.get(run) else {
            continue;
        };
        let reference = json!({"recordId":r[0],"runId":r[1],"sha256":b["_hubTrace"]["sha256"],"utf8Bytes":b["_hubTrace"]["utf8Bytes"]});
        let observer = observers
            .entry(run.to_string())
            .or_insert_with(read_progress::ReadProgress::default);
        if let Some(observed) = observer.observe(request, &b, &reference, bind, 0, 0) {
            let hint = read_progress::recovery_options(&observed, &tools(None).unwrap()).unwrap();
            assert_eq!(hint["stallEstablished"], false);
            assert_eq!(hint["decision"], "allow");
            outcomes.push(json!({"runId":run,"callId":call,"hint":hint,"layer":"saved actual purposeful-review negative; not a natural stall or population false-positive rate"}));
        }
    }
    assert_eq!(outcomes.len(), 3);
    save(
        &out,
        "saved-review-replay.json",
        &json!({"cases":outcomes,"modelRuns":0,"allowedLegitimateReviews":3,"blockedLegitimateReviews":0,"actualStallCases":0,"automaticLimitsQualified":false}),
    );
}

#[test]
#[ignore = "one bounded diagnostic preflight or separately frozen actual WG advisory adoption; never M2"]
fn bounded_same_work_advisory_entry() {
    let base = base();
    let out = base.join("artifacts/architecture-v3-read-recovery-20261027");
    let contract = read(&out.join("contract.json"));
    let phase = std::env::var("HUB_WG_PHASE").unwrap();
    assert!(phase == "preflight" || phase == "actual");
    let probe = phase == "preflight";
    let root = if probe {
        base.join(".local/v3-read-recovery-20261027/preflight-profile")
    } else {
        PathBuf::from(contract["profile"].as_str().unwrap())
    };
    assert!(root
        .canonicalize()
        .unwrap()
        .starts_with(base.join(".local")));
    assert!(root.join(".hub-isolated-runtime-v1").is_file());
    let id = contract["workId"].as_str().unwrap();
    assert_eq!(id, "work-MJNpXNOAZu2AzGemGE5bCWiR");
    assert_eq!(
        read(&out.join("saved-review-replay.json"))["allowedLegitimateReviews"],
        3
    );
    if !probe {
        assert_eq!(
            read(&out.join("preflight-state.json"))["materialBudget"]["preflight"]["allowed"],
            true
        );
        let candidate = read(&out.join("candidate-freeze.json"));
        assert_eq!(candidate["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(candidate["sourceFreezeUnchanged"], true);
    }
    let old = crate::agent_work::ui(&root, &json!({"action":"status","id":id})).unwrap();
    assert_eq!(old["work"]["revision"], 1);
    assert_eq!(old["work"]["authorizationVersion"], 1);
    assert_eq!(old["work"]["state"], "completed");
    assert_eq!(
        old["lifecycle"]["providerBudget"]["chargedOrReserved"],
        contract["oldChargedOrReserved"]
    );
    let before = records(&root, id);
    assert_eq!(
        before,
        read(&base.join("artifacts/architecture-v3-os-admission-20261026/actual-records.json"))
    );
    let started_path = out.join(format!("{phase}-started.json"));
    let mut marker = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(started_path)
        .expect("one phase attempt");
    use std::io::Write;
    marker.write_all(serde_json::to_string(&json!({"phase":phase,"maxModelRuns":if probe{0}else{1},"workId":id,"version":env!("CARGO_PKG_VERSION")})).unwrap().as_bytes()).unwrap();
    marker.sync_all().unwrap();
    crate::agent_work::ui(&root,&json!({"action":"extendProviderBudget","id":id,"operationId":"wg-advisory-adoption-once-20261027","reason":"one future adoption run for new read-recovery advisory; preserve three old unknown reservations, no context repair or old pass regrading","expectedWorkRevision":1,"expectedAuthorizationVersion":1,"expectedLimits":contract["oldLimits"],"limits":contract["futureLimits"]})).unwrap();
    crate::agent_work::ui(&root,&json!({"action":"message","id":id,"clientMessageId":"wg-advisory-verification-20261027","expectedRevision":1,"text":"合成验收指令，由AI按本次开发授权生成，不冒充人类原始发言。本轮仅验证恢复提示：沿用原两篇范围和所有约束，主动完整读取两篇，随后以相同工具和参数再读第一篇。若宿主提供历史回读选项，调用一次该选项读取首段，明确历史不代替当前证据；再交付简短对照报告并保留两篇本轮引文。不得压缩、搜索其他资料或进行业务写入。"})).unwrap();
    let c = crate::source_evidence::open_read_database(&root).unwrap();
    let expected = store::material_budget::load_on(&c, id).unwrap().unwrap();
    drop(c);
    let mut plan =
        read(&base.join("artifacts/architecture-v3-os-admission-20261026/material-plan.json"));
    plan["workRevision"] = json!(2);
    plan["workingStateRoundTrips"] = json!(0);
    plan["workingStateExtraBytes"] = json!(0);
    // One history page is at most1000 Unicode scalars. UTF-8 plus JSON escaping is conservatively6 bytes/scalar.
    plan["otherReplyBytes"] = json!(6477 + 2048 + 6000);
    plan["basis"]=json!("Same two sources read2+1, two goal checks and one rule restore; unchanged224KiB ceiling. Saved6477 envelope allowance plus bounded2048-byte new advisory and one1000-character history page at conservative6 UTF-8/JSON bytes per scalar. No working-state update required; runtime cumulative accounting remains mandatory.");
    crate::agent_work::ui(
        &root,
        &json!({"action":"freezeMaterialPlan","id":id,"expectedPlan":expected,"plan":plan}),
    )
    .unwrap();
    if probe {
        std::env::set_var("HUB_OS_REPAIR_PREFLIGHT_ONLY", id);
    } else {
        assert!(std::env::var_os("HUB_OS_REPAIR_PREFLIGHT_ONLY").is_none());
    }
    let started = std::time::Instant::now();
    let result = crate::agent_work::run_mode(
        &root,
        id,
        Budget {
            model_calls: 1,
            output_repair_calls: 0,
            tool_steps: 16,
            summaries: 20,
            entities: 2,
            body_chars: 6000,
            request_bytes: 229376,
            seconds: 180,
            model_call_seconds: 120,
        },
        true,
    );
    std::env::remove_var("HUB_OS_REPAIR_PREFLIGHT_ONLY");
    save(
        &out,
        &format!("{phase}-return.json"),
        &json!({"ok":result.is_ok(),"error":result.as_ref().err(),"elapsedMs":started.elapsed().as_secs_f64()*1000.0}),
    );
    let view = crate::agent_work::ui(&root, &json!({"action":"status","id":id})).unwrap();
    save(&out, &format!("{phase}-state.json"), &view);
    let after = records(&root, id);
    save(&out, &format!("{phase}-records.json"), &after);
    assert_eq!(
        &after.as_array().unwrap()[..before.as_array().unwrap().len()],
        before.as_array().unwrap()
    );
    if probe {
        assert_eq!(
            after
                .as_array()
                .unwrap()
                .iter()
                .filter(|r| r[2] == "nativeRuntime")
                .count(),
            before
                .as_array()
                .unwrap()
                .iter()
                .filter(|r| r[2] == "nativeRuntime")
                .count()
        );
        let error = result.unwrap_err();
        assert!(
            error.contains("已保存材料预检诊断") || error.contains("启动前材料余量不足"),
            "{error}"
        );
    } else {
        assert!(result.is_ok(), "{:?}", result.err());
        assert!(view["work"]["report"].is_object());
    }
}
