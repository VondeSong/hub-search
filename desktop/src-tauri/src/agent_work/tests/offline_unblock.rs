//! Bounded saved-receipt replay and separately admitted fallback; never the sealed M2.
use super::*;
use std::path::{Path, PathBuf};
fn read(p: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap()
}
fn save(out: &Path, name: &str, value: &Value) {
    std::fs::write(out.join(name), serde_json::to_vec_pretty(value).unwrap()).unwrap();
}
fn base() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .canonicalize()
        .unwrap()
}
fn records(root: &Path, id: &str) -> Value {
    let c = crate::source_evidence::open_read_database(root).unwrap();
    let mut q=c.prepare("SELECT id,run_id,kind,body_json,created_at FROM agent_records WHERE work_id=?1 ORDER BY rowid").unwrap();
    json!(q
        .query_map([id], |r| Ok((
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
#[ignore = "explicit one offline replay, SQLite diagnostic copies, zero provider requests"]
fn saved_heading_payloads_and_segmented_status_once() {
    assert_eq!(std::env::var("HUB_V3_OFFLINE_UNBLOCK").unwrap(), "1");
    let base = base();
    let out = base.join("artifacts/architecture-v3-offline-unblock-20261027");
    assert!(!out.join("offline-started.json").exists());
    save(
        &out,
        "offline-started.json",
        &json!({"modelCalls":0,"headingRequests":2,"projectionSamples":3}),
    );
    let root = base.join(".local/v3-offline-unblock-20261027/m1-profile");
    // The oldM1 copy is epoch78; only the formal database owner may upgrade it.
    crate::database::open_database(&root.join("craft-search.sqlite3")).unwrap();
    let id = "work-qmx-qclI33T4evy-Xe9Dpb4Z";
    let before = records(&root, id);
    let mut samples = Vec::new();
    for _ in 0..3 {
        let started = std::time::Instant::now();
        let value = ui(&root, &json!({"action":"status","id":id})).unwrap();
        let total = value["nativeTiming"]["projectionMs"].as_f64().unwrap();
        let phases = value["nativeTiming"]["phases"].as_array().unwrap();
        assert!(phases.len() >= 12);
        let mut previous = 0.0;
        for phase in phases {
            let elapsed = phase["elapsedMs"].as_f64().unwrap();
            assert!(elapsed >= previous && elapsed <= total);
            previous = elapsed;
        }
        samples.push(json!({"projectionMs":total,"wholeEntryMs":started.elapsed().as_secs_f64()*1000.0,"phases":phases,"state":value["work"]["state"],"validity":value["validity"]}));
    }
    assert_eq!(before, records(&root, id));
    save(
        &out,
        "segmented-status.json",
        &json!({"samples":samples,"modelCalls":0,"layer":"formal current backend/debug harness, upgraded savedM1 copy; not historical live/native score"}),
    );
    let root = base.join(".local/v3-offline-unblock-20261027/heading-profile");
    let id = "work-IH_E4BbShM5GIXA421-Kp1Mv";
    let before = records(&root, id);
    let requests = read(&out.join("heading-requests.json"));
    assert_eq!(requests.as_array().unwrap().len(), 2);
    let run = "offline-saved-heading-payload";
    let work = store::claim(&root, id, run).unwrap();
    let control = Control::default();
    let session = assistant::Session {
        root: &root,
        work: &work,
        run,
        control: &control,
        operation: None,
        selection: json!({}),
        app: None,
    };
    let mut outcomes = Vec::new();
    for (i, raw) in requests.as_array().unwrap().iter().enumerate() {
        let mut request = raw.clone();
        let original_operation = request["request"]["operationId"].clone();
        request.as_object_mut().unwrap().remove("stepId");
        request["request"]["operationId"] = json!(format!("offline-heading-replay-{i}"));
        let value = session
            .dispatch(serde_json::from_value(request).unwrap())
            .unwrap();
        let saved = value["content"]["rows"].as_array().unwrap();
        let original = raw["request"]["rows"].as_array().unwrap();
        assert_eq!(saved.len(), 20);
        for (a, b) in saved.iter().zip(original) {
            assert_eq!(a["normalizedValue"], b["normalizedValue"]);
            assert_eq!(a["evidenceRefs"], b["evidenceRefs"]);
        }
        outcomes.push(json!({"originalOperationId":original_operation,"datasetId":value["datasetId"],"rows":saved.len(),"sourceCoordinatesPreserved":true}));
    }
    store::fail(
        &root,
        &work,
        run,
        "zero-model diagnostic replay completed; not a provider Run or user report",
    )
    .unwrap();
    let after = records(&root, id);
    assert!(after
        .as_array()
        .unwrap()
        .starts_with(before.as_array().unwrap()));
    let c = crate::source_evidence::open_read_database(&root).unwrap();
    assert_eq!(c.query_row("SELECT count(*) FROM agent_records WHERE run_id=?1 AND kind IN ('nativeRuntime','modelExecution','providerBudgetReservation')",[run],|r|r.get::<_,i64>(0)).unwrap(),0);
    save(
        &out,
        "heading-replay.json",
        &json!({"outcomes":outcomes,"rows":40,"modelCalls":0,"sameOriginalModelValuesAndEvidence":true,"onlyRequestChange":"operationId avoids original committed idempotency keys in diagnostic copy; no model choices or source values regenerated","originalRecordsRetained":true,"layer":"formal assistant Session dispatch and sleepDataset validation; not new autonomous model adoption"}),
    );
}

#[test]
#[ignore = "one supplemental same-R11-Work fresh-context fallback; no new compaction or source writes"]
fn fresh_context_fallback_once() {
    assert_eq!(std::env::var("HUB_V3_FALLBACK_ONCE").unwrap(), "1");
    let base = base();
    let out = base.join("artifacts/architecture-v3-offline-unblock-20261027");
    let contract = read(&out.join("contract.json"));
    assert_eq!(contract["maxActualModelRuns"], 1);
    assert!(out.join("heading-replay.json").is_file());
    assert!(!out.join("actual-started.json").exists());
    let prior = base.join("artifacts/architecture-v3-native-compaction-20261026");
    let initial = read(&prior.join("actual-started.json"));
    let root = PathBuf::from(initial["root"].as_str().unwrap());
    assert!(root.ends_with("v3-native-compaction-20261026/profile"));
    let id = initial["workId"].as_str().unwrap();
    assert_eq!(id, contract["workId"]);
    let before = records(&root, id);
    assert_eq!(before, read(&prior.join("actual-compacted-records.json")));
    let old = ui(&root, &json!({"action":"status","id":id})).unwrap();
    assert_eq!(
        old["lifecycle"]["providerBudget"]["limits"],
        contract["oldLimits"]
    );
    assert_eq!(old["contextCompaction"]["pending"], false);
    let revision = old["work"]["revision"].as_i64().unwrap();
    save(
        &out,
        "actual-started.json",
        &json!({"workId":id,"oldRevision":revision,"maxActualRuns":1,"newCompactions":0}),
    );
    ui(&root,&json!({"action":"extendProviderBudget","id":id,"operationId":"bounded-fresh-context-fallback-20261027","reason":"用户明确授权本补充验证；仅在同一Work保留旧unknown后追加一份原单Run准入；旧同线程压缩失败保持","expectedWorkRevision":revision,"expectedAuthorizationVersion":1,"expectedLimits":contract["oldLimits"],"limits":contract["futureLimits"]})).unwrap();
    ui(&root,&json!({"action":"message","id":id,"clientMessageId":"synthetic-fallback-20261027","expectedRevision":revision,"text":"合成恢复验收输入（由AI依据当前执行授权生成，不是人类确认数据）：从持久资料重建上下文，继续交付原事项尚未完成的本轮报告。主动读取已授权current原文，调用goalState核对全部当前要求，再交付简短报告，含7件、林、2026-11-03、验收条件未确认及逐字出处。说明这是原生压缩后中断后的新上下文恢复，不能宣称原同线程续跑成功。保留原失败、报告历史与累计预算；不再请求压缩，不修改来源、不产生业务动作、图表或任务树。"})).unwrap();
    let c = crate::source_evidence::open_read_database(&root).unwrap();
    let work = store::load(&c, id).unwrap();
    drop(c);
    let source = work
        .grant
        .reader(&root)
        .unwrap()
        .read(work.anchor.as_ref().unwrap(), 0, 6000, None)
        .unwrap();
    let source_before = source.content.clone();
    let plan = json!({"schemaVersion":1,"workRevision":work.revision,"authorizationVersion":1,"requestBytes":262144,"reads":[{"locator":work.anchor,"version":source.version,"repetitions":1}],"workingStateRoundTrips":0,"workingStateExtraBytes":0,"goalStateReads":1,"otherReplyBytes":contract["savedReceiptAllowanceBytes"],"reserveRuleRestore":true,"basis":"One current source receipt + current goal envelope + one full rule restore; other envelopes=twice largest saved baseline receipt, exact source/rules projected by native preflight; no generic32KB quota and no existing ledger reset."});
    ui(
        &root,
        &json!({"action":"freezeMaterialPlan","id":id,"plan":plan}),
    )
    .unwrap();
    let budget = Budget {
        model_calls: 2,
        output_repair_calls: 0,
        tool_steps: 12,
        summaries: 4,
        entities: 1,
        body_chars: 6000,
        request_bytes: 262144,
        seconds: 180,
        model_call_seconds: 120,
    };
    let started = std::time::Instant::now();
    let returned = run_mode(&root, id, budget, true);
    save(
        &out,
        "actual-return.json",
        &json!({"ok":returned.is_ok(),"error":returned.as_ref().err(),"elapsedMs":started.elapsed().as_secs_f64()*1000.0}),
    );
    let after = ui(&root, &json!({"action":"status","id":id})).unwrap();
    save(&out, "actual-state.json", &after);
    let all = records(&root, id);
    save(&out, "actual-records.json", &all);
    assert!(all
        .as_array()
        .unwrap()
        .starts_with(before.as_array().unwrap()));
    assert_eq!(
        work.grant
            .reader(&root)
            .unwrap()
            .read(work.anchor.as_ref().unwrap(), 0, 6000, None)
            .unwrap()
            .content,
        source_before
    );
    assert!(returned.is_ok(), "{:?}", returned.err());
    assert!(after["work"]["report"].is_object());
}
