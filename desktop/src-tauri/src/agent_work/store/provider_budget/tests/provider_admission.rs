use super::*;
use crate::agent_work::options;

fn settings(provider: &str) -> crate::model_runtime::Settings {
    crate::model_runtime::Settings {
        provider: provider.into(),
        model: if provider == "deepseek" {
            "deepseek-flash".into()
        } else {
            String::new()
        },
        ..Default::default()
    }
}
fn global(f: &Fixture, provider: &str) {
    std::fs::write(
        f.root.join("model-runtime-v1.json"),
        json!({"schemaVersion":2,"settings":settings(provider)}).to_string(),
    )
    .unwrap();
}
fn choose(f: &Fixture, id: &str, provider: &str) {
    // Synthetic selection only; no catalog/credential/provider request is allowed in this check.
    super::super::super::write(&f.root, |c| {
        super::super::super::insert(
            c,
            id,
            None,
            "assistantOptions",
            &json!({"model":settings(provider),"autoFlashcardInbox":false}),
        )
    })
    .unwrap();
}
fn rows(root: &std::path::Path) -> Vec<String> {
    let c = crate::source_evidence::open_read_database(root).unwrap();
    let mut saved = Vec::new();
    for table in [
        "agent_works",
        "agent_runs",
        "agent_records",
        "agent_actions",
    ] {
        let mut q = c
            .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
            .unwrap();
        let n = q.column_count();
        let values = q
            .query_map([], |r| {
                Ok((0..n)
                    .map(|i| format!("{:?}", r.get_ref(i).unwrap()))
                    .collect::<Vec<_>>()
                    .join("|"))
            })
            .unwrap();
        saved.extend(values.map(|r| format!("{table}:{}", r.unwrap())));
    }
    saved
}

#[test]
fn v4_provider_admission_rejects_before_work_run_budget_or_queue_changes() {
    let (f, id) = setup();
    global(&f, "deepseek");
    ui(&f.root, &request(&f, &id)).unwrap();
    let before = rows(&f.root);
    let queue = crate::model_runtime::ui(&f.root, &json!({"action":"get"})).unwrap();
    let error = ui(&f.root, &json!({"action":"respond","id":id})).unwrap_err();
    assert!(
        error.contains("未创建新运行") && error.contains("未启动模型"),
        "{error}"
    );
    assert_eq!(rows(&f.root), before);
    assert_eq!(
        crate::model_runtime::ui(&f.root, &json!({"action":"get"})).unwrap(),
        queue
    );
    assert!(facts(&f.c(), &id, "providerBudgetReservation")
        .unwrap()
        .is_empty());
    choose(&f, &id, "codex");
    let pinned = options::preflight(&f.root, &id, true).unwrap();
    assert!(crate::model_runtime::native_agent_provider(
        &pinned.provider
    ));
    assert_eq!(
        crate::model_runtime::selected_settings(&f.root, Some(pinned))
            .unwrap()
            .provider,
        "codex"
    );
    assert!(options::preflight(&f.root, &id, false).is_err());
}

#[test]
fn v4_provider_admission_uses_effective_selection_and_keeps_unmanaged_legacy_path() {
    let (f, id) = setup();
    global(&f, "codex");
    assert_eq!(
        options::preflight(&f.root, &id, true).unwrap().provider,
        "codex"
    );
    choose(&f, &id, "deepseek");
    assert_eq!(
        options::preflight(&f.root, &id, true).unwrap().provider,
        "deepseek"
    );
    ui(&f.root, &request(&f, &id)).unwrap();
    let before = rows(&f.root);
    assert!(ui(&f.root, &json!({"action":"respond","id":id}))
        .unwrap_err()
        .contains("未预留额度"));
    assert_eq!(rows(&f.root), before);
    assert_eq!(
        crate::model_runtime::ui(&f.root, &json!({"action":"get"})).unwrap()["jobs"],
        json!([])
    );
    assert!(!crate::model_runtime::native_agent_provider("deepseek"));
    assert!(!crate::model_runtime::native_agent_provider("unknown"));
}

#[test]
fn v4_provider_admission_keeps_unknown_and_completed_report_on_explicit_resume_refusal() {
    let (f, id) = setup();
    global(&f, "deepseek");
    let w = super::super::super::claim(&f.root, &id, "old-unknown").unwrap();
    super::super::super::record(
        &f.root,
        "old-unknown",
        "nativeRuntime",
        &json!({"protocol":1}),
    )
    .unwrap();
    close(&f, &w, "old-unknown");
    let mut policy = request(&f, &id);
    policy["unknownReservations"] = json!({"old-unknown":tokens(20,10,4)});
    ui(&f.root, &policy).unwrap();
    f.c().execute("UPDATE agent_works SET state='paused',report_json=?2 WHERE id=?1",rusqlite::params![&id,json!({"status":"completed","summary":"已存历史交付；不是本次恢复成果","findings":[],"nextSteps":[],"questions":[],"limitations":[],"waitCondition":""}).to_string()]).unwrap();
    let before = rows(&f.root);
    let w = load(&f.c(), &id).unwrap();
    let lifecycle = super::super::super::lifecycle::view_on(&f.c(), &w).unwrap();
    let error=ui(&f.root,&json!({"action":"resume","id":id,"commandId":"v4-denied-resume","expectedControlRevision":lifecycle["controlRevision"],"expectedWorkRevision":w.revision,"expectedRunId":null})).unwrap_err();
    assert!(error.contains("未创建新运行"), "{error}");
    assert_eq!(rows(&f.root), before);
    let policy = view_on(&f.c(), &w).unwrap();
    assert_eq!(policy["chargedOrReserved"], tokens(20, 10, 4));
    assert_eq!(policy["unmeasuredRunIds"], json!(["old-unknown"]));
}

#[test]
#[ignore = "fixed three saved-profile rounds; explicit path and round required; zero model"]
fn v4_provider_admission_saved_formal_round() {
    let root = std::path::PathBuf::from(
        std::env::var("HUB_V4_PROVIDER_PROFILE").expect("explicit isolated saved profile"),
    );
    let round: usize = std::env::var("HUB_V4_PROVIDER_ROUND")
        .unwrap()
        .parse()
        .unwrap();
    assert!(
        (1..=3).contains(&round) && root.file_name().unwrap() == format!("round-{round}").as_str()
    );
    assert!(root
        .parent()
        .unwrap()
        .ends_with("v4-provider-admission-20261027"));
    let plan: Value =
        serde_json::from_slice(&std::fs::read(root.join("v4-provider-plan.json")).unwrap())
            .unwrap();
    assert_eq!(plan["round"], round);
    assert_eq!(plan["models"], 0);
    let marker = root.join("v4-provider-started.json");
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(marker)
        .unwrap();
    let id = plan["workId"].as_str().unwrap();
    let before = rows(&root);
    let queue = crate::model_runtime::ui(&root, &json!({"action":"get"})).unwrap();
    let args = plan["request"].clone();
    assert_eq!(args["id"], id);
    let error = ui(&root, &args).unwrap_err();
    assert!(
        error.contains("未创建新运行") && error.contains("未预留额度"),
        "{error}"
    );
    assert_eq!(rows(&root), before);
    assert_eq!(
        crate::model_runtime::ui(&root, &json!({"action":"get"})).unwrap(),
        queue
    );
    let selection = options::preflight(&root, id, true).unwrap_err();
    assert!(selection.contains("未启动模型"));
    std::fs::write(root.join("v4-provider-result.json"),json!({"round":round,"passed":true,"error":error,"formalEntry":args,"businessRowsUnchanged":true,"queueUnchanged":true,"modelCalls":0,"nativeEvidenceLayer":"current compiled Rust backend, real isolated DB/files; not packaged GUI adoption"}).to_string()).unwrap();
}
