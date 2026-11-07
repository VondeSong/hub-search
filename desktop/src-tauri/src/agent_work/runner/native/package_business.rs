//! Bounded C3 qualification on saved controlled material; never part of the application.
use super::*;
use std::path::PathBuf;
mod closeout;
mod report_resume;

fn read(path: impl AsRef<Path>) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}
fn save(out: &Path, name: &str, v: &Value) {
    std::fs::write(out.join(name), serde_json::to_vec_pretty(v).unwrap()).unwrap();
}
fn once(out: &Path, name: &str) {
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(out.join(name))
        .unwrap();
}
fn paths() -> (PathBuf, PathBuf, Value, PathBuf) {
    let desktop = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .canonicalize()
        .unwrap();
    let out = desktop.join("artifacts/architecture-v5-package-business-20261028");
    let init = read(out.join("initialization.json"));
    let root = PathBuf::from(init["root"].as_str().unwrap());
    assert_eq!(
        root.canonicalize().unwrap(),
        desktop
            .join(".local/v5-package-business-20261028/profile")
            .canonicalize()
            .unwrap()
    );
    assert_eq!(
        std::fs::read(root.join(".hub-isolated-runtime-v1")).unwrap(),
        b"Hub isolated runtime v1\n"
    );
    assert_eq!(env!("CARGO_PKG_VERSION"), "0.16.355");
    let freeze = read(
        desktop.join("artifacts/architecture-v5-skill-lifecycle-20261028/candidate-freeze.json"),
    );
    assert_eq!(
        freeze["sourceFreeze"],
        "1b227aeb42cd908ac52f1db7f7b8a855852384b98276ee6b3e480cebaf4683ba"
    );
    assert_eq!(
        format!(
            "{:x}",
            Sha256::digest(std::fs::read(freeze["binary"]["path"].as_str().unwrap()).unwrap())
        ),
        freeze["binary"]["sha256"]
    );
    let source = Path::new(init["sourceFile"].as_str().unwrap());
    assert_eq!(
        format!("{:x}", Sha256::digest(std::fs::read(source).unwrap())),
        init["sourceHash"]
    );
    (desktop, out, init, root)
}
fn ui(root: &Path, v: Value) -> Value {
    crate::agent_work::ui(root, &v).unwrap()
}
fn configure(root: &Path, id: &str, init: &Value, mcp: bool) {
    ui(
        root,
        json!({"action":"configureAssistant","id":id,"options":{"model":init["requestedModel"],"autoFlashcardInbox":false,"externalMcp":mcp}}),
    );
}
fn freeze_tokens(root: &Path, id: &str, revision: i64, runs: u64) {
    ui(
        root,
        json!({"action":"freezeProviderBudget","id":id,"expectedWorkRevision":revision,"limits":{"inputTokens":900000*runs,"uncachedInputTokens":300000*runs,"outputTokens":8192*runs},"perRun":{"inputTokens":900000,"uncachedInputTokens":300000,"outputTokens":8192},"unknownReservations":{}}),
    );
}
fn plan(root: &Path, id: &str, limit: usize, other: usize, basis: &str) -> Value {
    let c = crate::source_evidence::open_read_database(root).unwrap();
    let w = store::load(&c, id).unwrap();
    let version = w
        .grant
        .reader(root)
        .unwrap()
        .read(w.anchor.as_ref().unwrap(), 0, 6000, None)
        .unwrap()
        .version;
    json!({"schemaVersion":1,"workRevision":w.revision,"authorizationVersion":w.authorization_version,"requestBytes":limit,"reads":[{"locator":w.anchor,"version":version,"repetitions":2}],"workingStateRoundTrips":2,"workingStateExtraBytes":4096,"goalStateReads":2,"otherReplyBytes":other,"reserveRuleRestore":true,"basis":basis})
}
fn set_plan(root: &Path, id: &str, p: &Value) {
    let c = crate::source_evidence::open_read_database(root).unwrap();
    let old = store::material_budget::load_on(&c, id).unwrap();
    drop(c);
    ui(
        root,
        json!({"action":"freezeMaterialPlan","id":id,"expectedPlan":old,"plan":p}),
    );
}

#[test]
#[ignore = "exactly one zero-provider preparation and current serialized preflight; sealed old tests are not used"]
fn c3_package_initialize_preflight_once() {
    assert_eq!(std::env::var("HUB_C3_ZERO_PREPARE").unwrap(), "1");
    let (_, out, init, root) = paths();
    assert_eq!(
        read(out.join("zero-preparation-contract.json"))["modelsPermitted"],
        false
    );
    once(&out, "zero-preparation-started");
    let source = PathBuf::from(init["sourceFile"].as_str().unwrap());
    let mtime = std::fs::metadata(&source).unwrap().modified().unwrap();
    drop(crate::open_database(&root.join("craft-search.sqlite3")).unwrap());
    let directory = init["methodDirectory"].as_str().unwrap();
    let preview = ui(
        &root,
        json!({"action":"skillPackagePreview","directory":directory}),
    );
    save(&out, "package-preview.json", &preview);
    let imported = ui(
        &root,
        json!({"action":"skillPackageImport","directory":directory,"mode":"source","expectedFingerprint":preview["sourceFingerprint"],"clientRequestId":"c3-sleep-review-import-once"}),
    );
    save(&out, "package-import.json", &imported);
    let question = read(out.join("scenario-inputs.json"));
    let anchor: EvidenceLocator = serde_json::from_value(init["anchor"].clone()).unwrap();
    let grant = crate::agent_work::Grant {
        notes: vec![anchor.clone()],
        ..Default::default()
    };
    let state = ui(
        &root,
        json!({"action":"create","goal":question["1"],"successCriteria":question["criteria"],"anchor":anchor,"grant":grant}),
    );
    let id = state["work"]["id"].as_str().unwrap().to_string();
    configure(&root, &id, &init, false);
    freeze_tokens(&root, &id, 1, 3);
    let c = crate::source_evidence::open_read_database(&root).unwrap();
    let w = store::load(&c, &id).unwrap();
    let mut environment =
        crate::hub_capabilities::Session::new(&root, Some(w.grant.scope().unwrap())).unwrap();
    let pin = skills::Catalog::discover(&root)
        .unwrap()
        .fixed_version("v5-sleep-review")
        .unwrap();
    let mut raw = vec![environment
        .load("v5-sleep-review", w.goal.as_str())
        .unwrap()];
    for path in [
        "references/evidence.md",
        "references/sleep-method.md",
        "assets/report-template.md",
    ] {
        raw.push(environment.read_reference("v5-sleep-review", path).unwrap());
    }
    environment.verify().unwrap();
    let specs = tools(Some(&environment)).unwrap();
    for name in [
        "hub_sleepDataset",
        "hub_chart",
        "hub_workingState",
        "hub_goalState",
    ] {
        assert!(
            specs.as_array().unwrap().iter().any(|v| v["name"] == name),
            "{name}"
        );
    }
    let excerpt = w
        .grant
        .reader(&root)
        .unwrap()
        .read(w.anchor.as_ref().unwrap(), 0, 6000, None)
        .unwrap();
    let quotes = json!(quotes::catalog(&[excerpt]));
    let rules = environment.guidance();
    let mut guidance = guidance::GuidanceRef::new(&rules);
    let fake = json!({"recordId":"r".repeat(24),"runId":"run-estimate-only-00000000000","sha256":"a".repeat(64),"utf8Bytes":65536});
    let mut components = Vec::new();
    let mut other = 0usize;
    // Old complete DTOs are size references only; no old identity becomes new evidence.
    let mut q=c.prepare("SELECT body_json FROM agent_records WHERE run_id='run-m-uXBb4jnUfY6QCJxVMbH9dJ' AND kind='toolResult' ORDER BY rowid").unwrap();
    let old = q
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .map(|v| serde_json::from_str::<Value>(&v.unwrap()).unwrap())
        .collect::<Vec<_>>();
    drop(q);
    for result in old.iter().filter(|v| {
        matches!(
            v["request"]["operation"].as_str(),
            Some("sleepDataset" | "chart")
        )
    }) {
        raw.push(result.clone());
    }
    let snapshot_allowance = old
        .iter()
        .find(|v| v["request"]["name"] == "hub_read_analysis_snapshot")
        .unwrap()
        .to_string()
        .len();
    for (i, result) in raw.into_iter().enumerate() {
        let full = input::tool_output(
            observation::attach_request(
                result,
                &json!({"operation":"preflightEstimate","stepId":"c".repeat(64)}),
            ),
            fake.clone(),
            quotes.clone(),
            json!([]),
            rules.clone(),
            24,
        );
        let call = format!("saved-size-{i}");
        let wire = guidance.project_for(full, &call);
        guidance.sent(&call);
        let n = wire.to_string().len();
        other += n;
        components.push(json!({"kind":if i<4{"currentMethodReceipt"}else{"savedCompleteDatasetOrChartDto"},"bytes":n,"scope":"current wire projection; future IDs and payload growth are estimates"}));
    }
    other += snapshot_allowance;
    components.push(json!({"kind":"oneSnapshotManifestAllowance","bytes":snapshot_allowance,"basis":"bounded one-note manifest allowance from saved complete snapshot read DTO, not an assertion of exact future reply"}));
    drop(c);
    let basis="Current four full method/resource receipts plus seven saved full dataset/chart DTOs projected through current native wire envelope, one saved snapshot-read DTO allowance; source, goal and working-state reads are separately counted. Old record IDs are estimates only, not new facts.";
    let p = plan(&root, &id, 1048576, other, basis);
    set_plan(&root, &id, &p);
    save(&out, "zero-preflight-plan.json", &p);
    save(
        &out,
        "other-reply-estimate.json",
        &json!({"bytes":other,"components":components,"models":0}),
    );
    save(
        &out,
        "prepared-work.json",
        &json!({"workId":id,"method":pin,"methodQualification":raw_method_scope(),"sourceVersion":p["reads"][0]["version"],"otherReplyBytes":other,"plan":p,"models":0}),
    );
    struct Restore;
    impl Drop for Restore {
        fn drop(&mut self) {
            std::env::remove_var("HUB_OS_REPAIR_PREFLIGHT_ONLY");
        }
    }
    assert!(std::env::var_os("HUB_OS_REPAIR_PREFLIGHT_ONLY").is_none());
    let _restore = Restore;
    std::env::set_var("HUB_OS_REPAIR_PREFLIGHT_ONLY", &id);
    let returned =
        crate::agent_work::run_mode(&root, &id, assistant::budget("quick").unwrap(), true);
    let state = ui(&root, json!({"action":"status","id":id}));
    let c = crate::source_evidence::open_read_database(&root).unwrap();
    let w = store::load(&c, &id).unwrap();
    let provider = store::provider_budget::view_on(&c, &w).unwrap();
    let invoked:i64=c.query_row("SELECT count(*) FROM agent_records WHERE work_id=?1 AND kind IN ('nativeRuntime','providerBudgetReservation','modelExecution')",[&id],|r|r.get(0)).unwrap();
    save(&out, "zero-preflight-state.json", &state);
    save(
        &out,
        "zero-preflight-result.json",
        &json!({"expectedDiagnosticError":returned.as_ref().err(),"preflight":state["materialBudget"]["preflight"],"providerBudget":provider,"providerInvocationRecords":invoked,"mcpSetupEstimateBytes":crate::model_runtime::agent_mcp_startup_bytes(&specs,INSTRUCTIONS).unwrap(),"sourceBytesUnchanged":format!("{:x}",Sha256::digest(std::fs::read(&source).unwrap()))==init["sourceHash"].as_str().unwrap(),"sourceMtimeUnchanged":std::fs::metadata(&source).unwrap().modified().unwrap()==mtime,"models":0,"applicationBuilds":0}),
    );
    assert!(returned.unwrap_err().contains("已保存材料预检诊断"));
    assert_eq!(invoked, 0);
    assert_eq!(provider["canAdmitRun"], true);
    assert_eq!(provider["unmeasuredRunIds"], json!([]));
    assert_eq!(
        std::fs::metadata(source).unwrap().modified().unwrap(),
        mtime
    );
}
fn raw_method_scope() -> Value {
    json!({"fullLoadAndResourcesAvailable":true,"actualPerRunDerivedToolsPresent":true,"modelLoaded":false,"modelSent":false,"scope":"host eligibility only, not semantic adoption or formal business score"})
}

#[test]
#[ignore = "one frozen C3 business case per process, maximum four distinct sessions; no reruns"]
fn c3_package_business_case_once() {
    let case: usize = std::env::var("HUB_C3_BUSINESS_CASE")
        .unwrap()
        .parse()
        .unwrap();
    assert!((1..=4).contains(&case));
    let (desktop, out, init, root) = paths();
    let contract = read(out.join("business-contract.json"));
    assert_eq!(contract["modelsPermitted"], true);
    assert_eq!(contract["maximumSessions"], 4);
    assert_eq!(contract["version"], "0.16.355");
    assert_eq!(
        read(out.join("zero-preflight-result.json"))["providerInvocationRecords"],
        0
    );
    for previous in 1..case {
        assert_eq!(
            read(out.join(format!("case-{previous}-grade.json")))["passed"],
            true
        );
    }
    let prepared = read(out.join("prepared-work.json"));
    let original = prepared["workId"].as_str().unwrap();
    let inputs = read(out.join("scenario-inputs.json"));
    let source = PathBuf::from(init["sourceFile"].as_str().unwrap());
    let mtime = std::fs::metadata(&source).unwrap().modified().unwrap();
    once(&out, &format!("case-{case}-started"));
    let mut id = original.to_string();
    if case == 2 {
        let w = ui(&root, json!({"action":"status","id":original}));
        let t = ui(
            &root,
            json!({"action":"topicCreate","workId":original,"expectedWorkRevision":w["work"]["revision"],"title":"受控睡眠复核","period":"2025-01","skill":"v5-sleep-review","outputPreference":"范围、未知、逐字出处和版本均可复核；不是外部保存成功","clientRequestId":"c3-topic-from-report"}),
        );
        let topic = t["topic"]["id"].as_str().unwrap();
        ui(
            &root,
            json!({"action":"topicBind","topicId":topic,"expectedRevision":1,"workId":original,"expectedWorkRevision":w["work"]["revision"],"period":"2025-01","clientRequestId":"c3-bind-january"}),
        );
        save(&out, "topic-binding.json", &t);
    }
    if case == 3 {
        let t = read(out.join("topic-binding.json"));
        let topic = t["topic"]["id"].as_str().unwrap();
        let updated = ui(
            &root,
            json!({"action":"topicUpdate","topicId":topic,"expectedRevision":1,"title":"受控睡眠复核","defaultQuestion":inputs["3"],"period":"2025-02","outputPreference":"无精确值明确未知，不补零，不带入1月","clientRequestId":"c3-topic-february"}),
        );
        let revision = updated["topic"]["revision"].clone();
        let preview = ui(
            &root,
            json!({"action":"topicWorkPreview","topicId":topic,"expectedRevision":revision,"period":"2025-02"}),
        );
        save(&out, "february-preview.json", &preview);
        let made = ui(
            &root,
            json!({"action":"topicCreateWork","topicId":topic,"expectedRevision":revision,"period":"2025-02","expectedPreview":preview["fingerprint"],"confirmedScope":true,"clientRequestId":"c3-february-create"}),
        );
        id = made["openedWorkId"].as_str().unwrap().to_string();
        freeze_tokens(&root, &id, 1, 1);
        save(&out, "february-initial.json", &made);
    }
    if case == 2 || case == 4 {
        let state = ui(&root, json!({"action":"status","id":id}));
        ui(
            &root,
            json!({"action":"message","id":id,"expectedRevision":state["work"]["revision"],"clientMessageId":format!("c3-case-{case}-controlled-input"),"text":inputs[case.to_string()]}),
        );
    }
    configure(&root, &id, &init, case == 4);
    let p = plan(
        &root,
        &id,
        contract["materialLimitBytes"].as_u64().unwrap() as usize,
        contract["otherReplyBytes"].as_u64().unwrap() as usize,
        contract["materialBasis"].as_str().unwrap(),
    );
    set_plan(&root, &id, &p);
    let c = crate::source_evidence::open_read_database(&root).unwrap();
    let w = store::load(&c, &id).unwrap();
    assert!(w.active_run.is_none());
    assert_eq!(
        skills::Catalog::discover(&root)
            .unwrap()
            .fixed_version("v5-sleep-review")
            .unwrap(),
        prepared["method"]
    );
    assert_eq!(
        store::provider_budget::view_on(&c, &w).unwrap()["canAdmitRun"],
        true
    );
    assert_eq!(w.grant.notes.len(), 1);
    assert_eq!(json!(w.anchor), init["anchor"]);
    let before = ui(&root, json!({"action":"status","id":id}));
    drop(c);
    let mut budget = assistant::budget("quick").unwrap();
    budget.model_calls = 1;
    budget.output_repair_calls = 0;
    budget.request_bytes = contract["materialLimitBytes"].as_u64().unwrap() as usize;
    budget.seconds = contract["cases"][case.to_string()]["seconds"]
        .as_u64()
        .unwrap();
    budget.model_call_seconds = contract["cases"][case.to_string()]["generationSeconds"]
        .as_u64()
        .unwrap();
    save(
        &out,
        &format!("case-{case}-admission.json"),
        &json!({"case":case,"workId":id,"initialState":before,"budget":budget,"candidate":read(desktop.join("artifacts/architecture-v5-skill-lifecycle-20261028/candidate-freeze.json")),"method":prepared["method"],"sourceVersion":p["reads"][0]["version"],"evidenceLevel":"same production native host path in cfg(test) harness; MCP child is frozen actual355; not GUI adoption","exactServedModel":null,"cost":null}),
    );
    if case == 4 {
        let freeze = read(
            desktop
                .join("artifacts/architecture-v5-skill-lifecycle-20261028/candidate-freeze.json"),
        );
        assert!(std::env::var_os("HUB_C3_TEST_PEER").is_none());
        std::env::set_var(
            "HUB_C3_TEST_PEER",
            freeze["binary"]["path"].as_str().unwrap(),
        );
    }
    struct Restore;
    impl Drop for Restore {
        fn drop(&mut self) {
            std::env::remove_var("HUB_C3_TEST_PEER");
        }
    }
    let _restore = Restore;
    let start = std::time::Instant::now();
    let returned = crate::agent_work::run_mode(&root, &id, budget, true);
    let state = ui(&root, json!({"action":"status","id":id}));
    save(&out, &format!("case-{case}-state.json"), &state);
    save(
        &out,
        &format!("case-{case}-return.json"),
        &json!({"ok":returned.is_ok(),"error":returned.as_ref().err(),"elapsedMs":start.elapsed().as_secs_f64()*1000.0,"sourceBytesUnchanged":format!("{:x}",Sha256::digest(std::fs::read(&source).unwrap()))==init["sourceHash"].as_str().unwrap(),"sourceMtimeUnchanged":std::fs::metadata(&source).unwrap().modified().unwrap()==mtime,"actualProviderHttpCalls":null}),
    );
    if out.join("topic-binding.json").exists() {
        let t = read(out.join("topic-binding.json"));
        save(
            &out,
            &format!("case-{case}-topic.json"),
            &ui(
                &root,
                json!({"action":"topicOpen","topicId":t["topic"]["id"]}),
            ),
        );
    }
    assert!(returned.is_ok(), "{:?}", returned.err());
    assert_eq!(state["work"]["state"], "completed");
}

#[test]
#[ignore = "one saved-state qualification, then at most two separately frozen remaining sessions; no original-case retry"]
fn c3_saved_state_supplement_once() {
    let phase = std::env::var("HUB_C3_SAVED_PHASE").unwrap();
    assert!(matches!(phase.as_str(), "qualify" | "recover" | "february"));
    let (desktop, out, init, root) = paths();
    let prepared = read(out.join("prepared-work.json"));
    let original = prepared["workId"].as_str().unwrap();
    assert_eq!(read(out.join("result.json"))["actualBusinessSessions"], 2);
    assert_eq!(read(out.join("case-2-return.json"))["ok"], false);
    if phase == "qualify" {
        assert_eq!(
            read(out.join("supplement-preparation.json"))["modelsPermitted"],
            false
        );
        once(&out, "saved-qualification-started");
        let c = crate::source_evidence::open_read_database(&root).unwrap();
        let w = store::load(&c, original).unwrap();
        assert_eq!(w.revision, 2);
        assert_eq!(w.state, "interrupted");
        let raw:String=c.query_row("SELECT body_json FROM agent_records WHERE work_id=?1 AND kind='chartRevision' ORDER BY rowid DESC LIMIT 1",[original],|r|r.get(0)).unwrap();
        let chart: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(chart["revision"], 2);
        assert_eq!(
            chart["data"]["rows"],
            json!([{"group":"2025-01","sampleCount":2,"value":7.0}])
        );
        assert!(store::goal::chart_current_on(&c, &w, &chart).unwrap());
        let mut changed = w.clone();
        changed.revision += 1;
        assert!(!store::goal::chart_current_on(&c, &changed, &chart).unwrap());
        let binding = store::goal::binding_on(&c, &w).unwrap();
        let before = store::provider_budget::view_on(&c, &w).unwrap();
        assert_eq!(
            before["unmeasuredRunIds"],
            read(out.join("case-2-state.json"))["lifecycle"]["providerBudget"]["unmeasuredRunIds"]
        );
        assert_eq!(before["canAdmitRun"], true);
        drop(c);
        configure(&root, original, &init, true);
        let c = crate::source_evidence::open_read_database(&root).unwrap();
        let after = store::load(&c, original).unwrap();
        assert_eq!(after.revision, w.revision);
        assert_eq!(store::goal::binding_on(&c, &after).unwrap(), binding);
        assert!(store::goal::chart_current_on(&c, &after, &chart).unwrap());
        assert_eq!(store::provider_budget::view_on(&c, &after).unwrap(), before);
        assert_eq!(json!(after.grant), json!(w.grant));
        save(
            &out,
            "saved-qualification.json",
            &json!({"passed":true,"models":0,"currentGoalBinding":binding,"newMessageWouldInvalidateChart":true,"formalMcpConfigurationPreservesGoalChartGrantAndBudget":true,"providerBudget":before,"currentChart":chart,"revision":after.revision,"notProved":"model adoption, report completion or all standalone clients"}),
        );
        return;
    }
    let contract = read(out.join("supplement-contract.json"));
    assert_eq!(contract["modelsPermitted"], true);
    assert_eq!(contract["maximumSessions"], 2);
    assert_eq!(read(out.join("saved-qualification.json"))["passed"], true);
    let label = if phase == "recover" {
        "saved-recovery"
    } else {
        "saved-february"
    };
    if phase == "february" {
        assert_eq!(read(out.join("saved-recovery-grade.json"))["passed"], true);
    }
    once(&out, &format!("{label}-started"));
    let mut id = original.to_string();
    if phase == "february" {
        let topic = read(out.join("topic-binding.json"));
        let topic = topic["topic"]["id"].as_str().unwrap();
        let inputs = read(out.join("scenario-inputs.json"));
        let updated = ui(
            &root,
            json!({"action":"topicUpdate","topicId":topic,"expectedRevision":1,"title":"受控睡眠复核","defaultQuestion":inputs["3"],"period":"2025-02","outputPreference":"无精确值明确未知，不补零，不带入1月","clientRequestId":"c3-saved-february-config"}),
        );
        let revision = updated["topic"]["revision"].clone();
        let preview = ui(
            &root,
            json!({"action":"topicWorkPreview","topicId":topic,"expectedRevision":revision,"period":"2025-02"}),
        );
        let made = ui(
            &root,
            json!({"action":"topicCreateWork","topicId":topic,"expectedRevision":revision,"period":"2025-02","expectedPreview":preview["fingerprint"],"confirmedScope":true,"clientRequestId":"c3-saved-february-create"}),
        );
        id = made["openedWorkId"].as_str().unwrap().to_string();
        freeze_tokens(&root, &id, 1, 1);
        save(&out, "saved-february-preview.json", &preview);
    }
    // A transport choice is not a new user requirement; preserve the current goal binding.
    configure(&root, &id, &init, phase == "recover");
    let p = plan(
        &root,
        &id,
        contract["materialLimitBytes"].as_u64().unwrap() as usize,
        contract["otherReplyBytes"].as_u64().unwrap() as usize,
        contract["materialBasis"].as_str().unwrap(),
    );
    set_plan(&root, &id, &p);
    let before = ui(&root, json!({"action":"status","id":id}));
    assert_eq!(before["lifecycle"]["providerBudget"]["canAdmitRun"], true);
    assert_eq!(
        skills::Catalog::discover(&root)
            .unwrap()
            .fixed_version("v5-sleep-review")
            .unwrap(),
        prepared["method"]
    );
    if phase == "recover" {
        assert_eq!(before["work"]["revision"], 2);
        assert_eq!(
            before["lifecycle"]["providerBudget"]["chargedOrReserved"],
            contract["oldJanuaryChargedOrReserved"]
        );
        assert_eq!(
            before["lifecycle"]["providerBudget"]["unmeasuredRunIds"],
            contract["oldUnknownRunIds"]
        );
    }
    let mut budget = assistant::budget("quick").unwrap();
    budget.model_calls = 1;
    budget.output_repair_calls = 0;
    budget.seconds = 120;
    budget.model_call_seconds = 90;
    budget.request_bytes = contract["materialLimitBytes"].as_u64().unwrap() as usize;
    save(
        &out,
        &format!("{label}-admission.json"),
        &json!({"initialState":before,"budget":budget,"sourceVersion":p["reads"][0]["version"],"method":prepared["method"],"candidate":read(desktop.join("artifacts/architecture-v5-skill-lifecycle-20261028/candidate-freeze.json")),"evidenceLevel":"same host callbacks and exact355 MCP child; not native GUI"}),
    );
    let source = Path::new(init["sourceFile"].as_str().unwrap());
    let mtime = std::fs::metadata(source).unwrap().modified().unwrap();
    if phase == "recover" {
        let freeze = read(
            desktop
                .join("artifacts/architecture-v5-skill-lifecycle-20261028/candidate-freeze.json"),
        );
        assert!(std::env::var_os("HUB_C3_TEST_PEER").is_none());
        std::env::set_var(
            "HUB_C3_TEST_PEER",
            freeze["binary"]["path"].as_str().unwrap(),
        );
    }
    struct Restore;
    impl Drop for Restore {
        fn drop(&mut self) {
            std::env::remove_var("HUB_C3_TEST_PEER");
        }
    }
    let _restore = Restore;
    let start = std::time::Instant::now();
    let returned = crate::agent_work::run_mode(&root, &id, budget, true);
    let state = ui(&root, json!({"action":"status","id":id}));
    save(&out, &format!("{label}-state.json"), &state);
    save(
        &out,
        &format!("{label}-return.json"),
        &json!({"ok":returned.is_ok(),"error":returned.as_ref().err(),"elapsedMs":start.elapsed().as_secs_f64()*1000.0,"sourceBytesUnchanged":format!("{:x}",Sha256::digest(std::fs::read(source).unwrap()))==init["sourceHash"].as_str().unwrap(),"sourceMtimeUnchanged":std::fs::metadata(source).unwrap().modified().unwrap()==mtime,"actualProviderHttpCalls":null}),
    );
    let topic = read(out.join("topic-binding.json"));
    save(
        &out,
        &format!("{label}-topic.json"),
        &ui(
            &root,
            json!({"action":"topicOpen","topicId":topic["topic"]["id"]}),
        ),
    );
    assert!(returned.is_ok(), "{:?}", returned.err());
}
