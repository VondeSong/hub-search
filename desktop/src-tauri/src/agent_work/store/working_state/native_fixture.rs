//! One explicit deterministic preparation of an existing synthetic QA Work.
//! This is never a provider result or an actual user confirmation.
use super::*;
use crate::agent_work::assistant;

fn qa_reports(c: &Connection, work: &str) -> Vec<String> {
    // Complete invariant audit for this fixed71-row fixture. Do not lift the
    // generic64-record read limit or use it to infer complete history.
    c.prepare("SELECT body_json FROM agent_records WHERE work_id=?1 AND kind='delivery' ORDER BY rowid DESC LIMIT 72").unwrap()
        .query_map([work],|r|r.get::<_,String>(0)).unwrap().collect::<Result<Vec<_>,_>>().unwrap()
}

#[test]
#[ignore = "one owned synthetic native-read fixture only; no provider, original paid Work immutable"]
fn prepare_native_working_state_once_from_existing_synthetic_history_without_models() {
    let root = PathBuf::from(std::env::var("HUB_WORKING_NATIVE_ROOT").unwrap());
    let out = PathBuf::from(std::env::var("HUB_WORKING_NATIVE_OUT").unwrap());
    assert!(root.join(".hub-isolated-runtime-v1").is_file());
    assert!(out.join("copy-ready.json").is_file());
    assert!(!out.join("prepare-start.json").exists());
    let original = "work-qmx-qclI33T4evy-Xe9Dpb4Z";
    let qa = "work-gKp7MZ4Siwttm3IRqtf4eIyD";
    let c = read(&root).unwrap();
    let original_work = json!(load(&c, original).unwrap());
    let original_facts = records(&root, original, "delivery", 64).unwrap();
    let original_provider = records(&root, original, "providerBudgetPolicy", 2).unwrap();
    let original_host = records(&root, original, "executionBudgetPolicy", 2).unwrap();
    let original_count: i64 = c
        .query_row(
            "SELECT count(*) FROM agent_runs WHERE work_id=?1",
            [original],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(original_count, 6);
    let qa_runs: i64 = c
        .query_row(
            "SELECT count(*) FROM agent_runs WHERE work_id=?1",
            [qa],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(qa_runs, 70);
    assert_eq!(
        c.query_row("SELECT count(*) FROM agent_actions", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(c.query_row("SELECT count(*) FROM agent_records WHERE work_id=?1 AND kind IN ('modelExecution','nativeRuntime')",[qa],|r|r.get::<_,i64>(0)).unwrap(),0);
    let old_reports = qa_reports(&c, qa);
    assert_eq!(old_reports.len(), 70);
    drop(c);
    std::fs::write(out.join("prepare-start.json"),serde_json::to_vec_pretty(&json!({"models":0,"actions":0,"qaWorkId":qa,"originalWorkId":original,"originalRuns":6,"oldQaRuns":70,"oldQaReports":70,
        "evidenceLevel":"deterministic formal backend owners; not provider autonomy or native rendering"})).unwrap()).unwrap();
    crate::agent_work::ui(&root,&json!({"action":"message","id":qa,"text":"合成只读检查：查看完整工具记录与工作笔记；不调用模型、不提交业务动作。","clientMessageId":"native-working-state-20261026"})).unwrap();
    let run = "qa-working-state-20261026";
    let w =
        super::super::claim_with_budget(&root, qa, run, Budget::mode("quick").unwrap()).unwrap();
    let control = Control::default();
    let excerpt = w
        .grant
        .reader(&root)
        .unwrap()
        .read(w.anchor.as_ref().unwrap(), 0, 4000, None)
        .unwrap();
    let request = json!({"operation":"read","locator":w.anchor,"startChar":0,"maxChars":4000,"expectedVersion":null,"stepId":"qa-source-read"});
    record(&root, run, "toolCall", &request).unwrap();
    let reference = super::super::tool_results::capture(
        &root,
        qa,
        run,
        &request,
        &json!({"evidenceId":"e1","excerpt":excerpt,"origin":"deterministic QA, not model"}),
    )
    .unwrap();
    let initial = execute(&root, &w, run, &json!({"action":"read"}), &control).unwrap();
    let patch = json!({"action":"patch","operationId":"native-working-state-first","expectedRevision":initial["revision"],"expectedGoalBinding":initial["goalBinding"],
        "upsert":[{"entryId":"qa-read","kind":"observation","value":"合成工作记录：已保存一份授权材料的实际读取结果。这里只核对界面与持久化，不代表模型自主链通过。","status":"observed","evidenceRefs":[{"recordId":reference["recordId"],"sha256":reference["sha256"]}],"metric":null}],
        "remove":[],"pendingTargets":[],"unresolvedQuestions":["本条是合成只读初态，无需用户决定。"]});
    let request =
        json!({"operation":"workingState","request":patch,"stepId":"qa-working-state-save"});
    record(&root, run, "toolCall", &request).unwrap();
    let session = assistant::Session {
        root: &root,
        work: &w,
        run,
        control: &control,
        operation: None,
        selection: Value::Null,
        app: None,
    };
    let saved = session
        .dispatch_for_capture(
            serde_json::from_value(json!({"operation":"workingState","request":patch})).unwrap(),
        )
        .unwrap();
    assert_eq!(saved["saved"], true);
    assert_eq!(saved["revision"], 1);
    super::super::tool_results::capture(&root, qa, run, &request, &saved).unwrap();
    let report=serde_json::from_value(json!({"status":"needsDecision","summary":"合成只读验收初态：仅检查完整记录和工作笔记，不调用模型、不产生业务操作。","findings":[],"nextSteps":[],"questions":["确定性初态，不需要真实用户确认。"],"limitations":["生产后端确定性建立，不计模型自主或正式成绩"],"waitCondition":""})).unwrap();
    super::super::publish(
        &root,
        &w,
        run,
        &report,
        &[excerpt.clone()],
        &[],
        &json!([]),
        &Value::Null,
        &control,
    )
    .unwrap();
    super::super::execution_budget::settle(&root,&w,run,&json!({"modelCalls":0,"modelRetries":0,"outputRepairs":0,"toolSteps":2,"requestBytes":0,"bodyChars":excerpt.content.chars().count(),"entitiesRead":1,"summaries":0,"elapsedMs":1})).unwrap();
    let c = read(&root).unwrap();
    assert_eq!(json!(load(&c, original).unwrap()), original_work);
    assert_eq!(
        records(&root, original, "delivery", 64).unwrap(),
        original_facts
    );
    assert_eq!(
        records(&root, original, "providerBudgetPolicy", 2).unwrap(),
        original_provider
    );
    assert_eq!(
        records(&root, original, "executionBudgetPolicy", 2).unwrap(),
        original_host
    );
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM agent_runs WHERE work_id=?1",
            [original],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        6
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM agent_actions", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(c.query_row("SELECT count(*) FROM agent_records WHERE work_id=?1 AND kind IN ('modelExecution','nativeRuntime')",[qa],|r|r.get::<_,i64>(0)).unwrap(),0);
    let reports = qa_reports(&c, qa);
    assert_eq!(reports.len(), 71);
    assert_eq!(&reports[1..], old_reports.as_slice());
    let view = super::super::view(&root, qa).unwrap();
    assert_eq!(view["workingState"]["revision"], 1);
    std::fs::write(out.join("initial-state.json"),serde_json::to_vec_pretty(&json!({"models":0,"actions":0,"qaWorkId":qa,"runId":run,"qaRuns":71,"qaReports":71,"oldReportsPreserved":70,"originalWorkRuns":6,"originalWorkUnchanged":true,
        "originalQuotaPoliciesUnchanged":true,"sourceAnchor":w.anchor,"workingState":view["workingState"],"activity":view["activity"],"sourceResultRef":reference,
        "evidenceLevel":"production backend deterministic QA state; actual native rendering and keyboard return still to check; not model or formal grade"})).unwrap()).unwrap();
}
