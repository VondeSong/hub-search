use super::*;
use crate::obsidian_edit::tests::Fixture;

fn work(f: &Fixture, doc: &str) -> String {
    let anchor = EvidenceLocator::Note {
        library_id: "notes".into(),
        document_id: doc.into(),
        page_id: None,
    };
    store::create(
        &f.root,
        "核对当前合成材料".into(),
        "保留原工作及来源".into(),
        anchor.clone(),
        Grant {
            notes: vec![anchor],
            ..Default::default()
        },
    )
    .unwrap()
}
fn fixture() -> (Fixture, String, String) {
    let f = Fixture::new();
    let doc = f.seed(
        "Topic.md",
        "合成材料：本次学习记录2次，未作真实业务执行。\n",
    );
    let id = work(&f, &doc);
    let run = format!("topic-fixture-{}", crate::random_url_safe(8));
    let w = store::claim(&f.root, &id, &run).unwrap();
    let report:runner::Report=serde_json::from_value(json!({"status":"completed","summary":"受控合成成果，仅作为专题关联输入。","findings":[],"nextSteps":[],"questions":[],"limitations":["不是模型质量成绩"],"waitCondition":""})).unwrap();
    store::publish(
        &f.root,
        &w,
        &run,
        &report,
        &[],
        &[],
        &json!([]),
        &Value::Null,
        &Control::default(),
    )
    .unwrap();
    (f, id, doc)
}
fn create_args(id: &str) -> Value {
    json!({"action":"topicCreate","workId":id,"expectedWorkRevision":1,"title":"材料复核","period":"2026-10","skill":"hub-statistics","outputPreference":"简短说明覆盖范围","clientRequestId":"create-topic-once"})
}
fn originals(f: &Fixture, id: &str) -> Value {
    let c = f.c();
    let w = store::load(&c, id).unwrap();
    let records = c
        .prepare("SELECT body_json FROM agent_records WHERE work_id=?1 ORDER BY rowid")
        .unwrap()
        .query_map([id], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let runs = c
        .prepare("SELECT id,state,usage_json FROM agent_runs WHERE work_id=?1 ORDER BY rowid")
        .unwrap()
        .query_map([id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    json!({"work":w,"records":records,"runs":runs,"actions":c.query_row("SELECT COUNT(*) FROM agent_actions",[],|r|r.get::<_,i64>(0)).unwrap()})
}
#[test]
fn v5_topic_create_reopen_keeps_ids_method_bytes_source_and_work_ledger() {
    let (f, id, _) = fixture();
    let before = originals(&f, &id);
    let path = f.vault.join("Topic.md");
    let mtime = std::fs::metadata(&path).unwrap().modified().unwrap();
    let args = create_args(&id);
    let first = crate::agent_work::ui(&f.root, &args).unwrap();
    let topic = first["topic"]["id"].as_str().unwrap();
    assert_eq!(first["topic"]["revision"], 1);
    assert_eq!(first["history"][0]["workId"], id);
    assert_eq!(first["history"][0]["methodAdoption"], "seeOriginalRun");
    assert!(first["method"]["content"]["files"]["SKILL.md"]
        .as_str()
        .unwrap()
        .contains("完整枚举"));
    let reopened =
        crate::agent_work::ui(&f.root, &json!({"action":"topicOpen","topicId":topic})).unwrap();
    assert_eq!(reopened, first);
    assert_eq!(crate::agent_work::ui(&f.root, &args).unwrap(), first);
    assert_eq!(originals(&f, &id), before);
    assert_eq!(std::fs::metadata(path).unwrap().modified().unwrap(), mtime);
}
#[test]
fn v5_topic_configuration_conflict_and_archive_do_not_rewrite_work_or_history() {
    let (f, id, _) = fixture();
    let first = ui(&f.root, &create_args(&id)).unwrap();
    let topic = first["topic"]["id"].as_str().unwrap();
    let before = originals(&f, &id);
    let update = json!({"action":"topicUpdate","topicId":topic,"expectedRevision":1,"title":"下期材料复核","period":"2026-11","outputPreference":"保留旧成果","clientRequestId":"update-once"});
    let changed = ui(&f.root, &update).unwrap();
    assert_eq!(changed["topic"]["revision"], 2);
    assert_eq!(changed["history"][0]["period"], "2026-10");
    let mut stale = update.clone();
    stale["clientRequestId"] = json!("conflict-once");
    assert!(ui(&f.root, &stale).unwrap_err().contains("另一处变化"));
    let old: String = f
        .c()
        .query_row(
            "SELECT config_json FROM agent_topic_revisions WHERE topic_id=?1 AND revision=1",
            [topic],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(decode(&old).unwrap()["parameters"]["period"], "2026-10");
    ui(&f.root,&json!({"action":"topicArchive","topicId":topic,"expectedRevision":2,"archived":true,"clientRequestId":"archive-once"})).unwrap();
    assert!(
        ui(&f.root, &json!({"action":"topicList"})).unwrap()["topics"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(originals(&f, &id), before);
}
#[test]
fn v5_topic_same_period_uses_original_work_without_creating_or_resetting_work() {
    let (f, id, doc) = fixture();
    let first = ui(&f.root, &create_args(&id)).unwrap();
    let topic = first["topic"]["id"].as_str().unwrap();
    let second = work(&f, &doc);
    let count: i64 = f
        .c()
        .query_row("SELECT COUNT(*) FROM agent_works", [], |r| r.get(0))
        .unwrap();
    let mut args = json!({"action":"topicLink","topicId":topic,"expectedRevision":1,"workId":second,"period":"2026-10","clientRequestId":"same-period-denied"});
    assert!(ui(&f.root, &args).unwrap_err().contains("原工作"));
    args["period"] = json!("2026-11");
    args["clientRequestId"] = json!("next-period-existing-work");
    let result = ui(&f.root, &args).unwrap();
    assert_eq!(result["history"].as_array().unwrap().len(), 2);
    assert_eq!(result["history"][0]["state"], "ready");
    assert_eq!(result["history"][0]["hasReport"], false);
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM agent_works", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        count
    );
    assert_eq!(store::load(&f.c(), &id).unwrap().state, "completed");
}
#[test]
fn v5_topic_publish_failure_and_capacity_preserve_previous_configuration_and_method() {
    let (f, id, _) = fixture();
    let first = ui(&f.root, &create_args(&id)).unwrap();
    let topic = first["topic"]["id"].as_str().unwrap();
    let before = originals(&f, &id);
    let methods: i64 = f
        .c()
        .query_row("SELECT COUNT(*) FROM agent_method_versions", [], |r| {
            r.get(0)
        })
        .unwrap();
    f.c().execute_batch("CREATE TRIGGER topic_revision_failure BEFORE INSERT ON agent_topic_revisions WHEN NEW.revision=2 BEGIN SELECT RAISE(ABORT,'synthetic topic publish failure'); END;").unwrap();
    let result = ui(
        &f.root,
        &json!({"action":"topicUpdate","topicId":topic,"expectedRevision":1,"title":"应当回滚","period":"2026-11","skill":"hub-flashcards","clientRequestId":"publish-failure-once"}),
    );
    assert!(result.is_err());
    assert_eq!(
        ui(&f.root, &json!({"action":"topicOpen","topicId":topic})).unwrap(),
        first
    );
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM agent_method_versions", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        methods
    );
    assert_eq!(originals(&f, &id), before);
    assert!(admit(&f.c(), DATA_BYTES + 1).is_err());
}

#[test]
fn v5_topic_binding_keeps_budget_checks_provider_before_run_and_freezes_old_config() {
    let (f, id, _) = fixture();
    let first = ui(&f.root, &create_args(&id)).unwrap();
    let topic = first["topic"]["id"].as_str().unwrap();
    crate::agent_work::ui(&f.root,&json!({"action":"freezeProviderBudget","id":id,"expectedWorkRevision":1,"limits":{"inputTokens":1000,"uncachedInputTokens":500,"outputTokens":100},"perRun":{"inputTokens":400,"uncachedInputTokens":200,"outputTokens":40},"unknownReservations":{}})).unwrap();
    let before = store::load(&f.c(), &id).unwrap();
    let count: i64 = f
        .c()
        .query_row(
            "SELECT COUNT(*) FROM agent_records WHERE work_id=?1",
            [&id],
            |r| r.get(0),
        )
        .unwrap();
    let args = json!({"action":"topicBind","topicId":topic,"expectedRevision":1,"workId":id,"expectedWorkRevision":1,"period":"2026-10","clientRequestId":"bind-original"});
    ui(&f.root, &args).unwrap();
    ui(&f.root, &args).unwrap();
    assert_eq!(
        f.c()
            .query_row(
                "SELECT COUNT(*) FROM agent_records WHERE work_id=?1",
                [&id],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        count + 1
    );
    assert_eq!(json!(store::load(&f.c(), &id).unwrap()), json!(before));
    assert!(preflight(&f.root, &f.c(), &before, "codex", true).is_ok());
    assert!(preflight(&f.root, &f.c(), &before, "deepseek", true)
        .unwrap_err()
        .contains("未创建新运行"));
    assert!(preflight(&f.root, &f.c(), &before, "codex", false).is_err());
    ui(&f.root,&json!({"action":"topicUpdate","topicId":topic,"expectedRevision":1,"title":"新配置","period":"2026-11","skill":"hub-flashcards","clientRequestId":"change-future-only"})).unwrap();
    let (binding, method) = version_on(&f.c(), &before).unwrap().unwrap();
    assert_eq!(binding["configRevision"], 1);
    assert_eq!(binding["parameters"]["period"], "2026-10");
    assert_eq!(method, first["method"]);
    let mut changed = before.clone();
    changed.authorization_version += 1;
    assert!(version_on(&f.c(), &changed)
        .unwrap_err()
        .contains("授权已变化"));
    f.c()
        .execute("UPDATE libraries SET enabled=0 WHERE id='notes'", [])
        .unwrap();
    assert!(ui(&f.root,&json!({"action":"topicBind","topicId":topic,"expectedRevision":2,"workId":id,"expectedWorkRevision":1,"period":"2026-10","clientRequestId":"withdrawn-denied"})).is_err());
    assert!(preflight(&f.root, &f.c(), &before, "codex", true).is_err());
}

#[test]
fn v5_topic_runtime_pin_and_actual_method_delivery_are_separate_from_binding() {
    let (f, id, _) = fixture();
    let first = ui(&f.root, &create_args(&id)).unwrap();
    let topic = first["topic"]["id"].as_str().unwrap();
    ui(&f.root,&json!({"action":"topicBind","topicId":topic,"expectedRevision":1,"workId":id,"expectedWorkRevision":1,"period":"2026-10","clientRequestId":"runtime-bind"})).unwrap();
    let run = "topic-runtime-only";
    let w = store::claim(&f.root, &id, run).unwrap();
    let mut session = Some(
        crate::hub_capabilities::Session::new(&f.root, Some(w.grant.scope().unwrap())).unwrap(),
    );
    attach_runtime(&f.root, &w, run, &mut session).unwrap();
    assert_eq!(
        session
            .as_ref()
            .unwrap()
            .fixed_version("hub-statistics")
            .unwrap(),
        first["method"]
    );
    let metadata = session.as_ref().unwrap().metadata();
    assert_eq!(metadata["selectedTopic"]["parameters"]["period"], "2026-10");
    store::write(&f.root, |c| record_method_use(c, &w, run)).unwrap();
    let saved = read_topic(&f.root, topic).unwrap();
    assert_eq!(saved["history"][0]["methodUse"]["loadedThisRun"], false);
    assert_eq!(saved["history"][0]["methodUse"]["sentToRuntime"], false);
    let result = session
        .as_mut()
        .unwrap()
        .load("hub-statistics", "核对合成资料")
        .unwrap();
    let request =
        json!({"operation":"loadSkill","name":"hub-statistics","stepId":"fixed-method-call"});
    store::record(&f.root, run, "toolCall", &request).unwrap();
    store::tool_results::capture(&f.root, &id, run, &request, &result).unwrap();
    store::record(
        &f.root,
        run,
        "nativeContextDelivery",
        &json!({"callId":"fixed-method-call","phase":"flushedToProviderStdin"}),
    )
    .unwrap();
    store::write(&f.root, |c| record_method_use(c, &w, run)).unwrap();
    let saved = read_topic(&f.root, topic).unwrap();
    assert_eq!(saved["history"][0]["methodUse"]["loadedThisRun"], true);
    assert_eq!(saved["history"][0]["methodUse"]["sentToRuntime"], true);
    assert_eq!(
        saved["history"][0]["methodUse"]["semanticUse"],
        "unverified"
    );
    session.as_ref().unwrap().verify().unwrap();
}

#[test]
fn v5_topic_schema_rejects_partial_tables_and_upgrade_keeps_original_rows() {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch("CREATE TABLE agent_topic_works(topic_id TEXT,period TEXT);")
        .unwrap();
    assert!(store::migrate(&c).is_err());
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch("CREATE TABLE agent_topic_revisions(topic_id TEXT NOT NULL,revision INTEGER NOT NULL,method_version TEXT NOT NULL,config_json TEXT NOT NULL,client_id TEXT NOT NULL,request_hash TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(topic_id,revision));").unwrap();
    assert!(store::migrate(&c).is_err());
    let (f, id, _) = fixture();
    let original = originals(&f, &id);
    let path = f.root.join("craft-search.sqlite3");
    f.c().execute_batch("DROP TABLE agent_topic_works;DROP TABLE agent_topic_revisions;DROP TABLE agent_method_versions;UPDATE metadata SET value='80' WHERE key='schema_version';").unwrap();
    crate::database::forget_initialized_database(&path);
    let c = crate::open_database(&path).unwrap();
    assert_eq!(
        c.query_row(
            "SELECT value FROM metadata WHERE key='schema_version'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        crate::database::DATABASE_SCHEMA_VERSION.to_string()
    );
    let methods: i64 = c
        .query_row("SELECT COUNT(*) FROM agent_method_versions", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(methods, 0);
    drop(c);
    assert!(
        ui(&f.root, &json!({"action":"topicList"})).unwrap()["topics"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(originals(&f, &id), original);
}

#[test]
#[ignore = "one separately frozen saved-scope qualification; zero models, no source writes"]
fn v5_topic_saved_scope_method_qualification_once() {
    let desktop = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .canonicalize()
        .unwrap();
    let out = desktop.join("artifacts/architecture-v5-topic-pages-20261027");
    let init: Value =
        serde_json::from_slice(&std::fs::read(out.join("method-initialization.json")).unwrap())
            .unwrap();
    let root = PathBuf::from(init["qualifiedCopy"].as_str().unwrap());
    assert_eq!(
        root.canonicalize().unwrap(),
        desktop
            .join(".local/v5-topic-reuse-20261027/native-migration")
            .canonicalize()
            .unwrap()
    );
    let c = crate::source_evidence::open_read_database(&root).unwrap();
    let w = store::load(&c, "work-nmy1ihC7_c2v82OB_zIZBIuw").unwrap();
    assert_eq!(w.revision, 3);
    assert!(w.active_run.is_none());
    assert_eq!(json!(w.grant), init["grant"]);
    let before = store::provider_budget::view_on(&c, &w).unwrap();
    assert_eq!(
        before["chargedOrReserved"],
        init["expectedChargedOrReserved"]
    );
    assert_eq!(before["unmeasuredRunIds"], json!([]));
    assert_eq!(before["canAdmitRun"], true);
    let selection = crate::agent_work::options::preflight(&root, &w.id, true).unwrap();
    assert_eq!(selection.provider, "codex");
    let pin = skills::Catalog::discover(&root)
        .unwrap()
        .fixed_version("hub-research")
        .unwrap();
    let mut session =
        crate::hub_capabilities::Session::new(&root, Some(w.grant.scope().unwrap())).unwrap();
    session.pin_version(&pin).unwrap();
    let loaded = session
        .load("hub-research", "$hub-research 核对合成原文")
        .unwrap();
    session.verify().unwrap();
    assert_eq!(loaded["kind"], "skillInstructions");
    assert_eq!(loaded["skill"]["name"], "hub-research");
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(out.join("method-qualification-once"))
        .unwrap();
    std::fs::write(out.join("method-qualification.json"),serde_json::to_vec_pretty(&json!({"passed":true,"models":0,"candidatePackageVersion":env!("CARGO_PKG_VERSION"),"realSavedScope":true,"scopedMethodLoadAllowed":true,"method":pin,"providerBudget":before,"originalWorkAndLedgerUnmodified":true,"realModelAdoption":false})).unwrap()).unwrap();
}

#[test]
#[ignore = "exactly one frozen V5 fixed-method real Run on original Work; no old protocol retry"]
fn v5_topic_method_real_once() {
    use sha2::{Digest, Sha256};
    let desktop = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .canonicalize()
        .unwrap();
    let out = desktop.join("artifacts/architecture-v5-topic-pages-20261027");
    let read = |name: &str| -> Value {
        serde_json::from_slice(&std::fs::read(out.join(name)).unwrap()).unwrap()
    };
    let save = |name: &str, value: &Value| {
        std::fs::write(out.join(name), serde_json::to_vec_pretty(value).unwrap()).unwrap();
    };
    let contract = read("contract.json");
    let init = read("method-initialization.json");
    let freeze = read("candidate-freeze.json");
    assert_eq!(contract["maxRealRuns"], 1);
    assert_eq!(contract["maxNativeSessions"], 1);
    assert_eq!(freeze["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(read("method-qualification.json")["passed"], true);
    let binary = PathBuf::from(freeze["binary"]["path"].as_str().unwrap());
    assert_eq!(
        format!("{:x}", Sha256::digest(std::fs::read(binary).unwrap())),
        freeze["binary"]["sha256"].as_str().unwrap()
    );
    let root = PathBuf::from(init["root"].as_str().unwrap());
    assert_eq!(
        root.canonicalize().unwrap(),
        desktop
            .join(".local/v4-direct-draft-20261027/profile")
            .canonicalize()
            .unwrap()
    );
    let id = "work-nmy1ihC7_c2v82OB_zIZBIuw";
    assert_eq!(init["workId"], id);
    let source = PathBuf::from(init["source"]["path"].as_str().unwrap());
    let source_before = std::fs::read(&source).unwrap();
    let mtime = std::fs::metadata(&source).unwrap().modified().unwrap();
    assert_eq!(
        format!("{:x}", Sha256::digest(&source_before)),
        init["source"]["sha256"].as_str().unwrap()
    );
    let c = crate::open_database(&root.join("craft-search.sqlite3")).unwrap();
    let w = store::load(&c, id).unwrap();
    assert_eq!(w.state, "completed");
    assert_eq!(w.revision, 3);
    assert!(w.active_run.is_none());
    assert_eq!(json!(w.grant), init["grant"]);
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM agent_runs WHERE work_id=?1",
            [id],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        3
    );
    let before = store::provider_budget::view_on(&c, &w).unwrap();
    assert_eq!(
        before["chargedOrReserved"],
        init["expectedChargedOrReserved"]
    );
    assert_eq!(before["unmeasuredRunIds"], json!([]));
    assert_eq!(before["canAdmitRun"], true);
    assert_eq!(
        crate::agent_work::options::preflight(&root, id, true)
            .unwrap()
            .provider,
        "codex"
    );
    drop(c);
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(out.join("method-started"))
        .unwrap();
    save(
        "method-admission.json",
        &json!({"workId":id,"workRevision":w.revision,"budgetBefore":before,"existingLedgerRetained":true,"originalSchemaUpgradedInPlace":81,"modelSessionCap":1,"exactServedModel":"unavailable","feesKnown":false}),
    );
    let topic=crate::agent_work::ui(&root,&json!({"action":"topicCreate","workId":id,"expectedWorkRevision":w.revision,"title":"合成资料固定方法核对","period":"2026-10","skill":"hub-research","outputPreference":"本轮只读核对，当前要求优先于专题默认问题","clientRequestId":"v5-method-topic-create-once"})).unwrap();
    let topic_id = topic["topic"]["id"].as_str().unwrap();
    crate::agent_work::ui(&root,&json!({"action":"topicBind","topicId":topic_id,"expectedRevision":1,"workId":id,"expectedWorkRevision":w.revision,"period":"2026-10","clientRequestId":"v5-method-bind-once"})).unwrap();
    let text="固定方法采用验证（AI测试输入）：本轮明确使用 $hub-research，加载已绑定方法并完整读取当前合成笔记原文，核对数量、责任人、计划日期及验收状态，交付简短有原文出处的报告；明确原文为合成资料，不能证明真实业务执行。当前目标是只读事实核对；不要准备新草稿、修改原笔记或执行其它业务动作，不读其它资料。当前要求优先于专题默认问题，原失败和用量继续保留。";
    crate::agent_work::ui(&root,&json!({"action":"message","id":id,"clientMessageId":"v5-method-readonly-revision-once","expectedRevision":w.revision,"text":text})).unwrap();
    let mut budget = crate::agent_work::assistant::budget("quick").unwrap();
    budget.model_calls = 1;
    budget.output_repair_calls = 0;
    budget.seconds = 180;
    budget.model_call_seconds = 75;
    budget.request_bytes = 196608;
    budget.body_chars = 36000;
    let started = std::time::Instant::now();
    let result = crate::agent_work::run_mode(&root, id, budget, true);
    save(
        "method-return.json",
        &json!({"ok":result.is_ok(),"error":result.as_ref().err(),"elapsedMs":started.elapsed().as_secs_f64()*1000.0,"sourceBytesUnchanged":std::fs::read(&source).unwrap()==source_before,"sourceMtimeUnchanged":std::fs::metadata(&source).unwrap().modified().unwrap()==mtime}),
    );
    let state = crate::agent_work::ui(&root, &json!({"action":"status","id":id})).unwrap();
    save("method-state.json", &state);
    let topic =
        crate::agent_work::ui(&root, &json!({"action":"topicOpen","topicId":topic_id})).unwrap();
    save("method-topic.json", &topic);
    assert!(result.is_ok(), "{:?}", result.err());
    assert_eq!(state["work"]["state"], "completed");
    assert_eq!(topic["history"][0]["methodUse"]["loadedThisRun"], true);
    assert_eq!(topic["history"][0]["methodUse"]["sentToRuntime"], true);
    assert_eq!(std::fs::read(&source).unwrap(), source_before);
    assert_eq!(
        std::fs::metadata(&source).unwrap().modified().unwrap(),
        mtime
    );
}
