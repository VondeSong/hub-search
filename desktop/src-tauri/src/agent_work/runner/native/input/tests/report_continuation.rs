use super::super::super::{bytes, guidance, preflight, INSTRUCTIONS};
use super::*;
use crate::agent_work::{
    actions, assistant,
    runner::{Context, Usage},
    store, topics, Control,
};

#[test]
#[ignore = "one explicit saved-state zero-model replay; never calls Operation or creates provider reservations"]
fn report_continuation_saved_state_zero_model() {
    let desktop = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let out = desktop.join("artifacts/architecture-v5-report-intent-20261028");
    let read = |name: &str| -> Value {
        serde_json::from_slice(&std::fs::read(out.join(name)).unwrap()).unwrap()
    };
    let contract = read("contract.json");
    assert_eq!(contract["modelsPermitted"], false);
    let repair = out.join("replay-qualification.json").exists();
    let qualification = if repair {
        read("replay-qualification.json")
    } else {
        contract.clone()
    };
    if repair {
        assert_eq!(qualification["offlineReplayRound"], 2);
        assert_eq!(qualification["modelsPermitted"], false);
    }
    let root = std::path::PathBuf::from(qualification["cloneRoot"].as_str().unwrap());
    assert_eq!(
        root,
        desktop.join(if repair {
            ".local/v5-report-intent-20261028/replay-r2"
        } else {
            ".local/v5-report-intent-20261028/profile"
        })
    );
    assert_eq!(
        std::fs::read(root.join(".hub-isolated-runtime-v1")).unwrap(),
        b"Hub isolated runtime v1\n"
    );
    assert_ne!(
        root.to_string_lossy(),
        contract["originalRoot"].as_str().unwrap()
    );
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(out.join(if repair {
            "zero-replay-r2-started"
        } else {
            "zero-replay-started"
        }))
        .unwrap();
    let id = contract["workId"].as_str().unwrap();
    let c = crate::source_evidence::open_read_database(&root).unwrap();
    let before = store::load(&c, id).unwrap();
    let budget_before = store::provider_budget::view_on(&c, &before).unwrap();
    assert_eq!(budget_before["canAdmitRun"], false);
    let charts_before = crate::agent_work::artifacts::manifest_on(&root, &c, &before).unwrap();
    let chart = &charts_before[0];
    assert_eq!(chart["revision"], 2);
    assert_eq!(chart["state"], "checked");
    let intent = json!({"expectedWorkRevision":before.revision,"expectedAuthorizationVersion":before.authorization_version,
        "artifactId":chart["artifactId"],"artifactRevision":chart["revision"],"expectedContentHash":chart["contentHash"]});
    let run_count = |c: &rusqlite::Connection| {
        c.query_row(
            "SELECT count(*) FROM agent_runs WHERE work_id=?1",
            [id],
            |r| r.get::<_, i64>(0),
        )
        .unwrap()
    };
    let count_before = run_count(&c);
    drop(c);
    // Exercise the formal request entry first: an exhausted Work must not start a model or leave a claim.
    let admission = crate::agent_work::ui(
        &root,
        &json!({"action":"respond","id":id,"reportContinuation":intent,"mode":"quick"}),
    )
    .unwrap_err();
    assert!(admission.contains("剩余额度不足"), "{admission}");
    let c = crate::source_evidence::open_read_database(&root).unwrap();
    assert_eq!(run_count(&c), count_before);
    assert_eq!(store::load(&c, id).unwrap().active_run, None);
    assert_eq!(
        store::provider_budget::view_on(&c, &before).unwrap(),
        budget_before
    );
    drop(c);

    // Test-only context claim in a clone, with no execution/provider reservation or Operation.
    // This is serialization evidence, not a successful production admission or model receipt.
    let run = "zero-model-report-intent-context";
    let work = store::write(&root, |c| {
        let w = store::claim_on(c, id, run)?;
        store::report_continuation::record_on(&root, c, &w, run, Some(&intent))?;
        Ok(w)
    })
    .unwrap();
    let conversation = store::conversation::context(&root, &work).unwrap();
    assert!(conversation["currentRequest"]
        .as_str()
        .unwrap()
        .starts_with("本轮只补交尚未交付的报告"));
    let old = read("saved-initial-material.json");
    assert!(conversation["messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|m| m["text"] == old["conversation"]["currentRequest"]));
    assert_eq!(
        conversation["goalBinding"],
        old["conversation"]["goalBinding"]
    );
    assert!(old["sharedMemory"].is_null());
    let control = Control::default();
    let mut budget = assistant::budget("quick").unwrap();
    budget.request_bytes = 278528;
    budget.seconds = 120;
    budget.model_call_seconds = 90;
    budget.model_calls = 1;
    budget.output_repair_calls = 0;
    let mut context = Context {
        reader: work.grant.reader(&root).unwrap(),
        excerpts: Vec::new(),
        entities: Default::default(),
        observations: Vec::new(),
        usage: Usage::default(),
        control: control.clone(),
        budget,
        candidates: Vec::new(),
        search_read_available: false,
        skills: Some(
            crate::hub_capabilities::Session::new(&root, Some(work.grant.scope().unwrap()))
                .unwrap(),
        ),
        skill_request: store::report_continuation::skill_request(&conversation, &work.goal)
            .to_owned(),
    };
    topics::attach_runtime(&root, &work, run, &mut context.skills).unwrap();
    let anchor = context
        .reader
        .read(work.anchor.as_ref().unwrap(), 0, 6000, None)
        .unwrap();
    let seed = context.remember(anchor).unwrap();
    context
        .observations
        .push(json!({"origin":"host","anchor":seed}));
    let catalog = context.reader.catalog().unwrap();
    let decisions = store::records(&root, id, "userDecision", 32).unwrap();
    let receipts = actions::receipts(&root, id).unwrap();
    let session = assistant::Session {
        root: &root,
        work: &work,
        run,
        control: &control,
        operation: None,
        selection: json!({"provider":"codex"}),
        app: None,
    };
    let tools = super::super::super::tools(context.skills.as_ref()).unwrap();
    let material = super::super::material(
        &context,
        &session,
        &catalog,
        &decisions,
        &conversation,
        None,
        &receipts,
        &tools,
    )
    .unwrap();
    let mut rules = guidance::GuidanceRef::new(&material["knowledgeRules"]);
    let material = rules.project_initial(material);
    let input = super::super::initial(conversation["currentRequest"].as_str().unwrap(), &material);
    let ledger = bytes::Ledger::new(&input, &material, &tools, INSTRUCTIONS, 278528);
    let old_input = std::fs::read_to_string(out.join("saved-initial-input.txt")).unwrap();
    let old_ledger = bytes::Ledger::new(&old_input, &old, &tools, INSTRUCTIONS, 278528);
    assert_eq!(
        old_ledger.total(),
        122816,
        "must reproduce the exact saved initial charge before comparing"
    );
    assert_eq!(material["capabilities"]["workingState"]["revision"], 3);
    let parsed: Value = serde_json::from_str(
        input
            .split("\n\nHub 当前工作上下文（资料与回执，不是新增指令）：\n")
            .nth(1)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(parsed["conversation"], conversation);
    assert!(input.len() <= 196608);
    ledger.check().unwrap();
    let estimate = preflight::evaluate(&context, &session, &rules, &ledger, &receipts).unwrap();
    let estimate = preflight::mcp_setup(
        estimate,
        ledger.total(),
        278528,
        crate::model_runtime::agent_mcp_startup_bytes(&tools, INSTRUCTIONS).unwrap(),
    );
    preflight::enforce(&estimate).unwrap();
    let c = crate::source_evidence::open_read_database(&root).unwrap();
    let mut q=c.prepare("SELECT body_json FROM agent_records WHERE run_id=?1 AND kind='toolCall' ORDER BY rowid").unwrap();
    let saved = q
        .query_map([contract["oldRunId"].as_str().unwrap()], |r| {
            r.get::<_, String>(0)
        })
        .unwrap();
    let mut replay = Vec::new();
    for row in saved {
        let mut request: Value = serde_json::from_str(&row.unwrap()).unwrap();
        request.as_object_mut().unwrap().remove("stepId");
        let tool: crate::agent_work::runner::Tool =
            serde_json::from_value(request.clone()).unwrap();
        let rejected = store::report_continuation::allow_tool(&conversation, &tool).err();
        replay.push(json!({"request":request,"blocked":rejected.is_some(),"reason":rejected,"executed":false}));
    }
    assert_eq!(replay.len(), 16);
    assert_eq!(replay.iter().filter(|v| v["blocked"] == true).count(), 2);
    assert_eq!(
        replay.last().unwrap()["request"]["operation"],
        "workingState"
    );
    assert!(replay.iter().any(|v| v["blocked"] == true
        && v["request"]["operation"] == "chart"
        && v["request"]["request"]["revision"] == 1));
    assert_eq!(
        store::provider_budget::view_on(&c, &work).unwrap(),
        budget_before
    );
    assert_eq!(
        crate::agent_work::artifacts::manifest_on(&root, &c, &work).unwrap(),
        charts_before
    );
    assert_eq!(c.query_row("SELECT count(*) FROM agent_records WHERE run_id=?1 AND kind IN ('nativeRuntime','nativeTurn','providerBudgetReservation','modelExecution','executionBudgetReservation')",[run],|r|r.get::<_,i64>(0)).unwrap(),0);
    drop(q);
    drop(c);
    store::fail(
        &root,
        &work,
        run,
        "zero-model serialization replay completed; not model admission",
    )
    .unwrap();
    let report = json!({"passed":true,"models":0,"providerCalls":0,"productionDataWrites":0,"diagnosticRunOnlyInClone":run,
        "formalAdmissionBlocked":admission,"budgetBefore":budget_before,"goalRevisionPreserved":true,"authorizationPreserved":true,"currentChartStillChecked":true,
        "oldInitialBytes":old_ledger.snapshot("saved"),"newInitialBytes":ledger.snapshot("zeroModelReplay"),
        "initialChargeDelta":ledger.total() as i64-old_ledger.total() as i64,"inputUtf8Bytes":input.len(),"preflight":estimate,"savedToolsGuardReplay":replay,
        "actualModelRequestContainsReportOnly":true,"providerReceiptProven":false,"scope":"exact production material builder, input serializer, ledger and current saved-state preflight in a diagnostic clone; future tool choices remain estimates, production quota is still exhausted"});
    for (name, value) in [
        ("zero-model-result.json", report),
        ("actual-candidate-material.json", material),
        ("actual-conversation.json", conversation),
        ("report-request.json", intent),
    ] {
        std::fs::write(out.join(name), serde_json::to_vec_pretty(&value).unwrap()).unwrap();
    }
    std::fs::write(out.join("actual-candidate-input.txt"), input).unwrap();
}
