use super::*;
use crate::source_evidence::tests::Fixture;

fn setup() -> (Fixture, Value) {
    let f = Fixture::new();
    f.note("notes", "current", "受控来源数值3。");
    let id = crate::agent_work::tests::create(&f, false);
    let (w, run) = crate::agent_work::tests::claim(&f, &id);
    let initial = store::working_state::execute(
        &f.root,
        &w,
        &run,
        &json!({"action":"read"}),
        &Control::default(),
    )
    .unwrap();
    store::working_state::execute(&f.root,&w,&run,&json!({"action":"patch","expectedRevision":initial["revision"],"expectedGoalBinding":initial["goalBinding"],"operationId":"seed-record","upsert":[],"remove":[],"pendingTargets":null,"unresolvedQuestions":null}),&Control::default()).unwrap();
    store::fail(&f.root, &w, &run, "受控中断").unwrap();
    let prepared=crate::agent_work::ui(&f.root,&json!({"action":"prepareExternalWork","id":id,"purpose":"finishSavedReport","expectedWorkRevision":1,"expectedAuthorizationVersion":1})).unwrap();
    (f, prepared)
}
fn token(p: &Value) -> &str {
    p["mcpServer"]["env"]["HUB_EXTERNAL_WORK_TOKEN"]
        .as_str()
        .unwrap()
}

#[test]
fn external_work_token_is_single_use_and_status_keeps_live_owner() {
    let (f, p) = setup();
    assert!(WorkSession::open(&f.root, &"x".repeat(43)).is_err());
    let s = WorkSession::open(&f.root, token(&p)).unwrap();
    assert!(WorkSession::open(&f.root, token(&p)).is_err());
    let state =
        crate::agent_work::ui(&f.root, &json!({"action":"status","id":p["workId"]})).unwrap();
    assert_eq!(state["runActive"], true);
    assert_eq!(state["runOwner"], "externalMcp");
    drop(s);
    assert!(store::load(&f.c(), p["workId"].as_str().unwrap())
        .unwrap()
        .active_run
        .is_none());
}

#[test]
fn external_work_scope_rejects_mutation_changed_authority_and_expired_lease() {
    let (f, p) = setup();
    let mut s = WorkSession::open(&f.root, token(&p)).unwrap();
    for name in [
        "hub_importFlashcards",
        "hub_prepareArchive",
        "hub_refresh_context",
    ] {
        assert!(s.call(name, &json!({})).is_err());
    }
    assert!(s
        .call("hub_sleepDataset", &json!({"request":{"action":"create"}}))
        .is_err());
    f.c()
        .execute(
            "UPDATE agent_works SET authorization_version=2 WHERE id=?1",
            [p["workId"].as_str().unwrap()],
        )
        .unwrap();
    assert!(s.call("hub_workContext", &json!({})).is_err());
    drop(s);
    let (f, p) = setup();
    f.c().execute("UPDATE agent_records SET body_json=json_set(body_json,'$.expiresAt',0) WHERE run_id=?1 AND kind='externalReportLease'",[p["runId"].as_str().unwrap()]).unwrap();
    assert!(WorkSession::open(&f.root, token(&p)).is_err());
}

#[test]
fn external_work_report_has_exact_citations_and_flush_before_next_call() {
    let (f, p) = setup();
    let mut s = WorkSession::open(&f.root, token(&p)).unwrap();
    let context = s.call("hub_workContext", &json!({})).unwrap();
    assert!(s.call("hub_goalState", &json!({})).is_err());
    s.flushed().unwrap();
    let quote = context["quoteCatalog"][0]["quoteId"].clone();
    let binding = store::goal::for_run(&f.root, &s.work, &s.run).unwrap();
    let req = store::goal::completion::read_context(&f.root, &s.work, &s.run).unwrap();
    let items=req["requirements"].as_array().unwrap().iter().map(|r|json!({"requirementId":r["requirementId"],"criterion":r["text"],"requiredResult":"response","status":"satisfied","explanation":"受控确定性资格，不计模型自主成绩","refs":[],"supersededBy":null})).collect::<Vec<_>>();
    let mut args = json!({"status":"completed","markdown":"已核对受控来源数值3。[1]","citations":[{"quoteId":quote}],"questions":[],"limitations":["仅受控资格"],"waitCondition":"","completion":{"goalBinding":binding,"items":items}});
    args["citations"][0]["quoteId"] = json!("invalid");
    assert!(s.call("hub_finish", &args).is_err());
    args["citations"][0]["quoteId"] = quote;
    let result = s.call("hub_finish", &args).unwrap();
    assert_eq!(result["published"], true);
    assert!(
        s.call("hub_finish", &args).is_err(),
        "cannot submit twice after publication"
    );
    assert!(store::load(&f.c(), p["workId"].as_str().unwrap())
        .unwrap()
        .report
        .is_some());
    assert_eq!(
        store::records(&f.root, p["workId"].as_str().unwrap(), "delivery", 20)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn external_work_budget_and_source_change_stop_without_publication() {
    let (f, p) = setup();
    let mut s = WorkSession::open(&f.root, token(&p)).unwrap();
    s.ledger.limit = 0;
    assert!(s.call("hub_workContext", &json!({})).is_err());
    drop(s);
    let (f, p) = setup();
    let mut s = WorkSession::open(&f.root, token(&p)).unwrap();
    f.note("notes", "current", "新内容");
    assert!(s.call("hub_workContext", &json!({})).is_err());
    assert!(
        store::records(&f.root, p["workId"].as_str().unwrap(), "delivery", 20)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn external_work_context_supplies_current_dataset_identity_and_reads_it_without_recreation() {
    let (f, p) = setup();
    let mut s = WorkSession::open(&f.root, token(&p)).unwrap();
    let snapshot = crate::source_evidence::analysis::execute(
        &s.work.grant.reader(&f.root).unwrap(),
        "hub_create_analysis_snapshot",
        &json!({}),
    )
    .unwrap();
    let created=artifacts::sleep::execute(&f.root,&s.work,&s.run,&json!({"action":"create","operationId":"saved-analysis-fixture","expectedSnapshot":snapshot["snapshot"],"methodRef":"external-context-fixture","inclusionRule":"受控空数据集，不编造精确主睡眠值","dateRule":"记录日归属，不按起止时间推断睡眠","rows":[]}),&Control::default()).unwrap();
    let context = s.call("hub_workContext", &json!({})).unwrap();
    let datasets = context["result"]["result"]["sleepDatasets"]
        .as_array()
        .unwrap();
    assert_eq!(datasets.len(), 1);
    assert_eq!(datasets[0]["datasetId"], created["datasetId"]);
    assert_eq!(datasets[0]["revision"], 1);
    let request = json!({"request":{"action":"read","datasetId":datasets[0]["datasetId"],"revision":datasets[0]["revision"]}});
    s.flushed().unwrap();
    let read = s.call("hub_sleepDataset", &request).unwrap();
    assert_eq!(read["result"]["result"]["state"], "current");
    assert_eq!(read["result"]["result"]["datasetId"], created["datasetId"]);
    assert_eq!(
        store::records(&f.root, &s.work.id, "sleepDatasetRevision", 20)
            .unwrap()
            .len(),
        1
    );
    assert!(s
        .call("hub_sleepDataset", &json!({"request":{"action":"create"}}))
        .is_err());
}

#[test]
fn external_work_partial_report_can_continue_without_erasing_history_but_completed_cannot() {
    let (f, p) = setup();
    let mut s = WorkSession::open(&f.root, token(&p)).unwrap();
    for status in ["insufficientEvidence", "completed"] {
        let context = s.call("hub_workContext", &json!({})).unwrap();
        s.flushed().unwrap();
        let goal = store::goal::completion::read_context(&f.root, &s.work, &s.run).unwrap();
        let items=goal["requirements"].as_array().unwrap().iter().map(|r|json!({"requirementId":r["requirementId"],"criterion":r["text"],"requiredResult":"response","status":if status=="completed"{"satisfied"}else{"blocked"},"explanation":"受控恢复资格，不计模型成绩或人工确认","refs":[],"supersededBy":null})).collect::<Vec<_>>();
        let report = json!({"status":status,"markdown":"受控来源数值3，保留真实核对状态。[1]","citations":[{"quoteId":context["quoteCatalog"][0]["quoteId"]}],"questions":[],"limitations":["仅受控资格"],"waitCondition":"","completion":{"goalBinding":goal["goalBinding"],"items":items}});
        assert_eq!(s.call("hub_finish", &report).unwrap()["published"], true);
        let next = crate::agent_work::ui(
            &f.root,
            &json!({"action":"prepareExternalWork","id":s.work.id,"purpose":"finishSavedReport","expectedWorkRevision":1,"expectedAuthorizationVersion":1}),
        );
        if status == "completed" {
            assert!(next.is_err());
            break;
        }
        let next = next.unwrap();
        assert_ne!(next["runId"], p["runId"]);
        assert_eq!(
            store::records(&f.root, &s.work.id, "delivery", 20)
                .unwrap()
                .len(),
            1
        );
        let old = store::records(&f.root, &s.work.id, "delivery", 20).unwrap();
        assert_eq!(old[0]["report"]["status"], "insufficientEvidence");
        s = WorkSession::open(&f.root, token(&next)).unwrap();
    }
    assert_eq!(
        store::records(&f.root, &s.work.id, "delivery", 20)
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn external_work_counts_actual_mcp_envelope_and_honors_saved_stop() {
    let (f, p) = setup();
    let mut s = WorkSession::open(&f.root, token(&p)).unwrap();
    let request = json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"independent-test","version":"1"}}});
    let response = json!({"jsonrpc":"2.0","id":1,"result":{"instructions":s.instructions()}});
    let initial = s.ledger.total();
    s.outgoing(&request, &response).unwrap();
    assert_eq!(
        s.ledger.total(),
        initial + response.to_string().len() + 1 - s.ledger.instructions
    );
    let wire = s.call("hub_workContext", &json!({})).unwrap();
    let response = json!({"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":wire.to_string()}]}});
    let initial = s.ledger.total();
    s.outgoing(&json!({"method":"tools/call"}), &response)
        .unwrap();
    assert_eq!(
        s.ledger.total(),
        initial + response.to_string().len() + 1 - wire.to_string().len()
    );
    s.flushed().unwrap();
    let state = store::lifecycle::view_on(&f.c(), &s.work).unwrap();
    store::lifecycle::stop(&f.root,&s.work.id,&json!({"commandId":"stop-external","expectedWorkRevision":1,"expectedControlRevision":state["controlRevision"],"expectedRunId":s.run}),false).unwrap();
    assert!(s.call("hub_workContext", &json!({})).is_err());
}

#[test]
#[ignore = "one prospective external-client report slot in the original February Work"]
fn external_work_saved_february_prepare() {
    let desktop = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let out = closeout_folder(desktop);
    let name =
        std::env::var("HUB_EXTERNAL_PREPARE_CONTRACT").unwrap_or_else(|_| "contract.json".into());
    assert!(matches!(
        name.as_str(),
        "contract.json" | "client-repair-contract.json"
    ));
    let c: Value = serde_json::from_slice(&std::fs::read(out.join(name)).unwrap()).unwrap();
    let root = PathBuf::from(std::env::var("HUB_EXTERNAL_PREPARE_ROOT").unwrap());
    assert!(c["roots"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r.as_str() == root.to_str()));
    let result_path = PathBuf::from(std::env::var("HUB_EXTERNAL_PREPARE_RESULT").unwrap());
    std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(result_path.with_extension("started"))
        .unwrap();
    let id = c["februaryWork"].as_str().unwrap();
    let before = crate::agent_work::ui(&root, &json!({"action":"status","id":id})).unwrap();
    assert_eq!(before["runActive"], false);
    if !c["expectedPriorReport"].is_null() {
        assert_eq!(before["work"]["report"], c["expectedPriorReport"]);
    }
    let history = store::records(&root, id, "delivery", 100).unwrap();
    let original = store::load(
        &crate::source_evidence::open_read_database(&root).unwrap(),
        id,
    )
    .unwrap();
    assert_eq!(original.revision, 1);
    assert!(original.active_run.is_none());
    crate::agent_work::ui(&root,&json!({"action":"extendProviderBudget","id":id,"operationId":c["budgetOperationId"].as_str().unwrap_or("one-independent-february-report"),"reason":c["budgetReason"].as_str().unwrap_or("user delegates completion; one external-client saved-report verification, old timeout unknown retained; no re-extraction or quota reset"),"expectedWorkRevision":1,"expectedAuthorizationVersion":1,"expectedLimits":c["oldLimits"],"limits":c["futureLimits"]})).unwrap();
    let prepared=crate::agent_work::ui(&root,&json!({"action":"prepareExternalWork","id":id,"purpose":"finishSavedReport","expectedWorkRevision":1,"expectedAuthorizationVersion":1})).unwrap();
    assert_eq!(store::records(&root, id, "delivery", 100).unwrap(), history);
    std::fs::write(result_path, serde_json::to_vec(&prepared).unwrap()).unwrap();
    // private runtime folder; contains a one-use capability
}

fn closeout_folder(desktop: &Path) -> PathBuf {
    let name = std::env::var("HUB_EXTERNAL_ARTIFACTS")
        .unwrap_or_else(|_| "architecture-v5-external-closeout-20261028".into());
    assert!(matches!(
        name.as_str(),
        "architecture-v5-external-closeout-20261028" | "architecture-v5-saved-analysis-20261029"
    ));
    desktop.join("artifacts").join(name)
}

#[test]
#[ignore = "zero-model replay of the saved partial report and current dataset, in an isolated copy only"]
fn external_work_saved_analysis_offline_replay() {
    let desktop = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let out = closeout_folder(desktop);
    let c: Value =
        serde_json::from_slice(&std::fs::read(out.join("contract.json")).unwrap()).unwrap();
    let root = PathBuf::from(c["offlineRoot"].as_str().unwrap());
    assert_ne!(root.to_str(), c["root"].as_str());
    let ticket = root.parent().unwrap().join("offline-ticket.json");
    std::env::set_var("HUB_EXTERNAL_PREPARE_ROOT", &root);
    std::env::set_var("HUB_EXTERNAL_PREPARE_RESULT", &ticket);
    external_work_saved_february_prepare();
    let p: Value = serde_json::from_slice(&std::fs::read(&ticket).unwrap()).unwrap();
    let mut s = WorkSession::open(&root, token(&p)).unwrap();
    let context = s.call("hub_workContext", &json!({})).unwrap();
    let datasets = context["result"]["result"]["sleepDatasets"]
        .as_array()
        .unwrap();
    assert_eq!(datasets.len(), 1);
    assert_eq!(datasets[0]["datasetId"], c["datasetId"]);
    assert_eq!(datasets[0]["revision"], 1);
    s.flushed().unwrap();
    let read=s.call("hub_sleepDataset",&json!({"request":{"action":"read","datasetId":datasets[0]["datasetId"],"revision":datasets[0]["revision"]}})).unwrap();
    assert_eq!(read["result"]["result"]["state"], "current");
    assert_eq!(read["result"]["result"]["content"], c["expectedDataset"]);
    let result = json!({"models":0,"entry":"WorkSession production context/projection and hub_sleepDataset read","datasetIdentityDerivedFromContext":true,"datasetUnchanged":true,"manifestBytes":serde_json::to_vec(datasets).unwrap().len(),"chargedBytes":s.ledger.total(),"materialLimit":s.ledger.limit,"partialHistoryRetained":true});
    assert!(s.ledger.total() <= s.ledger.limit);
    s.flushed().unwrap();
    drop(s);
    std::fs::remove_file(ticket).unwrap();
    std::fs::write(
        out.join("offline-replay.json"),
        serde_json::to_vec_pretty(&result).unwrap(),
    )
    .unwrap();
}

#[test]
#[ignore = "zero-model formal status readback only; never creates a Run or changes quota"]
fn external_work_final_readback() {
    let desktop = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let out = closeout_folder(desktop);
    let c: Value =
        serde_json::from_slice(&std::fs::read(out.join("contract.json")).unwrap()).unwrap();
    let root = Path::new(c["root"].as_str().unwrap());
    let january =
        crate::agent_work::ui(root, &json!({"action":"status","id":c["januaryWork"]})).unwrap();
    let february =
        crate::agent_work::ui(root, &json!({"action":"status","id":c["februaryWork"]})).unwrap();
    assert_eq!(january["work"]["state"], "completed");
    assert_eq!(january["runActive"], false);
    assert_eq!(february["runActive"], false);
    std::fs::write(out.join("formal-readback.json"),serde_json::to_vec(&json!({"entry":"agent_work::ui status","models":0,"january":january,"february":february})).unwrap()).unwrap();
}
