use super::*;
use crate::source_evidence::tests::Fixture;

#[test]
fn report_continuation_preserves_manual_skill_request_without_widening_selection() {
    let f = Fixture::new();
    let directory = f.root.join("agent-skills/manual-review");
    std::fs::create_dir_all(directory.join("agents")).unwrap();
    std::fs::write(directory.join("SKILL.md"),"---\nname: manual-review\ndescription: Explicit selection fixture\n---\nRead the authorized evidence.\n").unwrap();
    std::fs::write(
        directory.join("agents/openai.yaml"),
        "policy:\n  allow_implicit_invocation: false\n",
    )
    .unwrap();
    for (message, allowed) in [
        ("请使用 $manual-review 复核", true),
        ("请使用 $manual-review-other", false),
        ("x$manual-review", false),
        ("\\$manual-review", false),
        ("本轮不用技能", false),
    ] {
        let mut context = json!({"currentRequest":message,"messages":[{"role":"user","text":"先前用 $manual-review"},{"role":"user","text":message},{"role":"assistant","text":"$manual-review"}]});
        apply(
            &mut context,
            json!({"request":{"artifactId":"chart","artifactRevision":2}}),
        );
        let before = context.to_string();
        let mut catalog = crate::agent_work::skills::Catalog::discover(&f.root).unwrap();
        assert!(catalog
            .load("manual-review", context["currentRequest"].as_str().unwrap())
            .is_err());
        assert_eq!(
            catalog
                .load("manual-review", skill_request(&context, "$manual-review"))
                .is_ok(),
            allowed,
            "{message}"
        );
        assert_eq!(context.to_string(), before);
    }
}

#[test]
fn report_continuation_skill_request_missing_or_ordinary_context_fails_safely() {
    let missing = json!({"currentRequest":"report only","reportContinuation":{},"messages":[{"role":"assistant","text":"$manual-review"},{"role":"tool","text":"$manual-review"}]});
    assert_eq!(skill_request(&missing, "$manual-review"), "");
    let malformed = json!({"reportContinuation":{},"messages":[{"role":"user","text":"$old"},{"role":"user","text":null}]});
    assert_eq!(skill_request(&malformed, "$old"), "");
    let ordinary =
        json!({"currentRequest":"current user request","messages":[{"role":"user","text":"$old"}]});
    assert_eq!(skill_request(&ordinary, "fallback"), "current user request");
    assert_eq!(skill_request(&json!({}), "fallback"), "fallback");
}

#[test]
#[ignore = "one readonly saved356 failure replay; no Run claim, model, budget change or candidate"]
fn report_continuation_saved_manual_skill_gate_zero_model() {
    let desktop = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let out = desktop.join("artifacts/architecture-v5-closeout-20261028");
    let read = |name: &str| -> Value {
        serde_json::from_slice(&std::fs::read(out.join(name)).unwrap()).unwrap()
    };
    assert_eq!(read("offline-followup.json")["maximumModels"], 0);
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(out.join("manual-skill-zero-started"))
        .unwrap();
    let contract = read("contract.json");
    let grade = read("january-grade.json");
    let root = Path::new(contract["root"].as_str().unwrap());
    assert_eq!(
        root,
        desktop.join(".local/v5-package-business-20261028/profile")
    );
    let id = contract["workId"].as_str().unwrap();
    let c = crate::source_evidence::open_read_database(root).unwrap();
    let w = super::super::load(&c, id).unwrap();
    assert!(w.active_run.is_none());
    let rows_before: i64 = c
        .query_row("SELECT count(*) FROM agent_records", [], |row| row.get(0))
        .unwrap();
    let budget_before = super::super::provider_budget::view_on(&c, &w).unwrap();
    let raw:String=c.query_row("SELECT body_json FROM agent_records WHERE work_id=?1 AND run_id=?2 AND kind='reportContinuation'",params![id,grade["runId"].as_str().unwrap()],|row|row.get(0)).unwrap();
    let body: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(prepare_on(root, &c, &w, &body["request"]).unwrap(), body);
    let mut context = super::super::conversation::context(root, &w).unwrap();
    let original = context["currentRequest"].as_str().unwrap().to_owned();
    apply(&mut context, body);
    assert_eq!(skill_request(&context, &w.goal), original);
    let serialized = context.to_string();
    let mut catalog = crate::agent_work::skills::Catalog::discover(root).unwrap();
    let prepared: Value = serde_json::from_slice(
        &std::fs::read(
            desktop.join("artifacts/architecture-v5-package-business-20261028/prepared-work.json"),
        )
        .unwrap(),
    )
    .unwrap();
    catalog.pin_version(&prepared["method"]).unwrap();
    let denied = catalog
        .load(
            "v5-sleep-review",
            context["currentRequest"].as_str().unwrap(),
        )
        .unwrap_err();
    assert_eq!(denied, "这个技能需要用户用 $技能名称 明确指定");
    let loaded = catalog
        .load("v5-sleep-review", skill_request(&context, &w.goal))
        .unwrap();
    assert_eq!(loaded["skill"]["methodVersion"], contract["methodVersion"]);
    let mut references = Vec::new();
    for path in [
        "references/evidence.md",
        "references/sleep-method.md",
        "assets/report-template.md",
    ] {
        let value = catalog.read_reference("v5-sleep-review", path).unwrap();
        assert!(!value["content"].as_str().unwrap().is_empty());
        references.push(path);
    }
    catalog.verify().unwrap();
    assert_eq!(context.to_string(), serialized);
    assert_eq!(
        c.query_row("SELECT count(*) FROM agent_records", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        rows_before
    );
    assert_eq!(
        super::super::provider_budget::view_on(&c, &w).unwrap(),
        budget_before
    );
    std::fs::write(out.join("manual-skill-zero-result.json"),serde_json::to_vec_pretty(&json!({"passed":true,"models":0,"newRuns":0,"budgetUnchanged":true,"originalDenialReproduced":denied,"fixedVersion":contract["methodVersion"],"referencesRead":references,"modelFacingContextChangedByGate":false,"scope":"saved real context and formal Catalog gate; not model adoption or native binary verification"})).unwrap()).unwrap();
}

#[test]
fn report_entry_budget_uses_the_frozen_work_plan_and_never_enlarges_runtime_limits() {
    let (f, w, _) = setup();
    let plain = crate::agent_work::assistant::budget_for_work(&f.root, &w.id, "quick").unwrap();
    assert_eq!(
        plain.request_bytes,
        crate::agent_work::assistant::budget("quick")
            .unwrap()
            .request_bytes
    );
    crate::agent_work::ui(&f.root,&json!({"action":"freezeProviderBudget","id":w.id,"expectedWorkRevision":w.revision,
        "limits":{"inputTokens":900000,"uncachedInputTokens":300000,"outputTokens":8192},
        "perRun":{"inputTokens":900000,"uncachedInputTokens":300000,"outputTokens":8192},"unknownReservations":{}})).unwrap();
    let version = w
        .grant
        .reader(&f.root)
        .unwrap()
        .read(w.anchor.as_ref().unwrap(), 0, 1, None)
        .unwrap()
        .version;
    let plan = json!({"schemaVersion":1,"workRevision":w.revision,"authorizationVersion":w.authorization_version,"requestBytes":278528,
        "reads":[{"locator":w.anchor,"version":version,"repetitions":1}],"workingStateRoundTrips":1,"workingStateExtraBytes":0,"goalStateReads":2,
        "otherReplyBytes":4096,"reserveRuleRestore":true,"basis":"bounded fixture for the shared work material ceiling; no model requested"});
    crate::agent_work::ui(
        &f.root,
        &json!({"action":"freezeMaterialPlan","id":w.id,"plan":plan}),
    )
    .unwrap();
    for mode in ["quick", "deep"] {
        let raw = crate::agent_work::assistant::budget_for_work(&f.root, &w.id, mode).unwrap();
        let limited = budget(raw);
        assert_eq!(limited.request_bytes, 278528);
        assert_eq!(limited.model_calls, 1);
        assert_eq!(limited.output_repair_calls, 0);
        assert_eq!(limited.seconds, 120);
        assert_eq!(limited.model_call_seconds, raw.model_call_seconds.min(90));
    }
    let mut stricter = plain;
    stricter.seconds = 20;
    stricter.model_call_seconds = 10;
    stricter.model_calls = 0;
    let limited = budget(stricter);
    assert_eq!(limited.seconds, 20);
    assert_eq!(limited.model_call_seconds, 10);
    assert_eq!(limited.model_calls, 0);
    assert!(super::super::load(&f.c(), &w.id)
        .unwrap()
        .active_run
        .is_none());
}

fn setup() -> (Fixture, Work, Value) {
    let f = Fixture::new();
    f.note("notes", "current", "# 2025-01-01\n学习 学习\n");
    let id = crate::agent_work::tests::create(&f, true);
    let (w, run) = crate::agent_work::tests::claim(&f, &id);
    let reader = w.grant.reader(&f.root).unwrap();
    let snapshot = crate::source_evidence::analysis::execute(
        &reader,
        "hub_create_analysis_snapshot",
        &json!({}),
    )
    .unwrap();
    let chart=crate::agent_work::artifacts::execute(&f.root,&w,&run,&json!({"action":"create","operationId":"chart",
        "analysis":{"expectedSnapshot":snapshot["snapshot"],"unit":"day","groupBy":"month","terms":["学习"]},
        "spec":{"title":"学习","mark":"bar","metric":"occurrences","term":"学习","sort":"groupAsc"}}),&Control::default()).unwrap();
    crate::agent_work::artifacts::execute(
        &f.root,
        &w,
        &run,
        &json!({"action":"validate","artifactId":chart["artifactId"],"revision":1}),
        &Control::default(),
    )
    .unwrap();
    super::super::fail(&f.root, &w, &run, "saved incomplete report").unwrap();
    let w = super::super::load(&f.c(), &id).unwrap();
    let request = json!({"expectedWorkRevision":w.revision,"expectedAuthorizationVersion":w.authorization_version,
        "artifactId":chart["artifactId"],"artifactRevision":1,"expectedContentHash":chart["content"]["contentHash"]});
    (f, w, request)
}

#[test]
fn report_continuation_reaches_current_request_without_goal_change_and_does_not_leak_to_next_run() {
    let (f, w, request) = setup();
    let binding = super::super::goal::binding_on(&f.c(), &w).unwrap();
    let next = super::super::claim_with_report(
        &f.root,
        &w.id,
        "report-only",
        Budget::mode("quick").unwrap(),
        Some(&request),
    )
    .unwrap();
    let context = super::super::conversation::context(&f.root, &next).unwrap();
    assert!(context["currentRequest"]
        .as_str()
        .unwrap()
        .starts_with("本轮只补交尚未交付的报告"));
    assert!(context["messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["text"] == w.goal));
    assert_eq!(next.revision, w.revision);
    assert_eq!(json!(next.grant), json!(w.grant));
    assert_eq!(context["goalBinding"], binding);
    assert_eq!(
        crate::agent_work::artifacts::manifest_on(&f.root, &f.c(), &next).unwrap()[0]["state"],
        "checked"
    );
    super::super::fail(&f.root, &next, "report-only", "zero-model fixture").unwrap();
    let later =
        super::super::claim_with_budget(&f.root, &w.id, "ordinary", Budget::mode("quick").unwrap())
            .unwrap();
    let context = super::super::conversation::context(&f.root, &later).unwrap();
    assert_eq!(context["currentRequest"], w.goal);
    assert!(context.get("reportContinuation").is_none());
}

#[test]
fn report_continuation_rejects_new_requirements_stale_identity_and_corrupt_chart_without_partial_claim(
) {
    let (f, w, request) = setup();
    for (field, value) in [
        ("text", json!("also change data")),
        ("expectedWorkRevision", json!(99)),
        ("expectedAuthorizationVersion", json!(99)),
        ("artifactRevision", json!(2)),
        ("expectedContentHash", json!("wrong")),
    ] {
        let mut bad = request.clone();
        bad[field] = value;
        assert!(super::super::claim_with_report(
            &f.root,
            &w.id,
            "rejected",
            Budget::mode("quick").unwrap(),
            Some(&bad)
        )
        .is_err());
        assert!(super::super::load(&f.c(), &w.id)
            .unwrap()
            .active_run
            .is_none());
        assert_eq!(
            f.c()
                .query_row(
                    "SELECT count(*) FROM agent_runs WHERE id='rejected'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }
    super::super::conversation::message(
        &f.root,
        &w.id,
        &json!({"text":"new requirement","clientMessageId":"new"}),
    )
    .unwrap();
    let changed = super::super::load(&f.c(), &w.id).unwrap();
    assert!(prepare_on(&f.root, &f.c(), &changed, &request).is_err());
    let mut current = request.clone();
    current["expectedWorkRevision"] = json!(changed.revision);
    assert!(prepare_on(&f.root, &f.c(), &changed, &current).is_err());
    let mut revoked = changed;
    revoked.state = "revoked".into();
    assert!(prepare_on(&f.root, &f.c(), &revoked, &current).is_err());
}

#[test]
fn report_continuation_resume_is_atomic_and_replay_binds_the_intent() {
    let (f, w, request) = setup();
    let state = super::super::view(&f.root, &w.id).unwrap();
    let stop = json!({"commandId":"stop","expectedControlRevision":state["lifecycle"]["controlRevision"],"expectedWorkRevision":w.revision,"expectedRunId":null});
    super::super::lifecycle::stop(&f.root, &w.id, &stop, false).unwrap();
    let state = super::super::view(&f.root, &w.id).unwrap();
    let mut resume = json!({"action":"resume","commandId":"resume","expectedControlRevision":state["lifecycle"]["controlRevision"],"expectedWorkRevision":w.revision,"expectedRunId":null,"reportContinuation":request});
    let next = super::super::lifecycle::resume_with_budget(
        &f.root,
        &w.id,
        "resumed",
        &resume,
        Budget::mode("quick").unwrap(),
    )
    .unwrap()
    .unwrap();
    assert!(
        super::super::conversation::context(&f.root, &next).unwrap()["reportContinuation"]
            .is_object()
    );
    assert!(super::super::lifecycle::resume_replayed(&f.root, &w.id, &resume).unwrap());
    resume["reportContinuation"]["artifactRevision"] = json!(2);
    assert!(super::super::lifecycle::resume_replayed(&f.root, &w.id, &resume).is_err());
}

#[test]
fn report_continuation_allows_reads_and_exact_chart_validation_but_no_repeat_writes() {
    let mut context = json!({"currentRequest":"old","messages":[{"text":"old"}]});
    apply(
        &mut context,
        json!({"request":{"artifactId":"chart","artifactRevision":2}}),
    );
    for value in [
        json!({"operation":"workingState","request":{"action":"patch"}}),
        json!({"operation":"sleepDataset","request":{"action":"revise"}}),
        json!({"operation":"chart","request":{"action":"patch"}}),
        json!({"operation":"capability","name":"hub_create_analysis_snapshot","arguments":{}}),
        json!({"operation":"chart","request":{"action":"read","artifactId":"other","revision":2}}),
    ] {
        let tool: runner::Tool = serde_json::from_value(value).unwrap();
        assert!(allow_tool(&context, &tool).is_err());
        assert!(allow_tool(&json!({}), &tool).is_ok());
    }
    for value in [
        json!({"operation":"workingState","request":{"action":"read"}}),
        json!({"operation":"sleepDataset","request":{"action":"read","datasetId":"saved","revision":2}}),
        json!({"operation":"chart","request":{"action":"validate","artifactId":"chart","revision":2}}),
        json!({"operation":"goalState"}),
    ] {
        assert!(allow_tool(&context, &serde_json::from_value(value).unwrap()).is_ok());
    }
}
