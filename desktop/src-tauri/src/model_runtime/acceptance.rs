//! Explicit opt-in only. Uses user-authorized real Hub data and production
//! entry points. It creates named acceptance works/drafts, never source writes.
use super::*;
use sha2::{Digest, Sha256};
fn save(dir: &Path, name: &str, value: &Value) {
    std::fs::write(dir.join(name), serde_json::to_vec_pretty(value).unwrap()).unwrap();
}
fn source_digest(root: &Path) -> String {
    let c = crate::source_evidence::open_read_database(root).unwrap();
    let mut query=c.prepare("SELECT space_id,id,title,path,markdown,content_hash FROM documents ORDER BY space_id,id").unwrap();
    let rows = query
        .query_map([], |r| {
            Ok((0..6)
                .map(|i| r.get::<_, Option<String>>(i).unwrap_or_default())
                .collect::<Vec<_>>())
        })
        .unwrap();
    let mut digest = Sha256::new();
    for row in rows {
        let bytes = serde_json::to_vec(&row.unwrap()).unwrap();
        digest.update((bytes.len() as u64).to_le_bytes());
        digest.update(bytes);
    }
    format!("{:x}", digest.finalize())
}
fn create(root: &Path, anchor: &Value, goal: &str) -> String {
    let view=crate::agent_work::ui(root,&json!({"action":"create","goal":goal,"successCriteria":"只依据本次授权原文，简短回答并给出准确引用。","anchor":anchor,"grant":{"libraryIds":[],"notes":[anchor],"readingItemKeys":[],"sources":[],"attachmentLibraryIds":[]}})).unwrap();
    view["work"]["id"].as_str().unwrap().into()
}
fn scope(root: &Path, id: &str, project: &str) {
    crate::shared_memory::ui(
        root,
        &json!({"action":"selectScope","workId":id,"projectId":project,"enabled":true}),
    )
    .unwrap();
}
fn run(root: &Path, id: &str) -> Value {
    let result =
        crate::agent_work::ui(root, &json!({"action":"run","id":id,"mode":"quick"})).unwrap();
    assert_eq!(
        result["work"]["state"], "completed",
        "real investigation failed: {}",
        result["run"]["error"]
    );
    assert!(!result["evidence"].as_array().unwrap().is_empty());
    result
}
fn project(root: &Path, name: &str) -> String {
    let view =
        crate::shared_memory::ui(root, &json!({"action":"createProject","name":name})).unwrap();
    view["projects"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["name"] == name)
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .into()
}
fn selection(root: &Path, provider: &str, model: &str, effort: &str) {
    ui(root,&json!({"action":"save","settings":{"provider":provider,"model":model,"reasoningEffort":effort,"fast":false,"maxConcurrent":2}})).unwrap();
}
struct Environment(Vec<(String, Option<std::ffi::OsString>)>);

#[test]
#[ignore = "Explicit original-library repair diagnostic; requires HUB_ORIGINAL_LIBRARY_REPAIR_CONFIG; real API and app-owned works only"]
fn original_library_investigation_repair_diagnostic() {
    let config: Value = serde_json::from_slice(
        &std::fs::read(
            std::env::var_os("HUB_ORIGINAL_LIBRARY_REPAIR_CONFIG")
                .expect("explicit original-library config"),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(config["format"], "hub-original-library-repair-v1");
    let root = PathBuf::from(config["dataRoot"].as_str().unwrap());
    let evidence = PathBuf::from(config["evidenceDir"].as_str().unwrap());
    assert!(root.join("craft-search.sqlite3").is_file() && evidence.is_dir());
    let settings_before = read_settings(&root).unwrap();
    selection(&root, "deepseek", "deepseek-flash", "none");
    let mut results = Vec::new();
    for case in config["cases"].as_array().unwrap() {
        if config["onlyCase"]
            .as_str()
            .is_some_and(|id| case["id"] != id)
        {
            continue;
        }
        let library = case["anchor"][0].as_str().unwrap();
        let document = case["anchor"][1].as_str().unwrap();
        let anchor = json!({"kind":"note","libraryId":library,"documentId":document,"pageId":if library.starts_with("obsidian:"){Value::Null}else{json!(document)}});
        let libraries = if case["scope"] == "anchor-only" {
            json!([])
        } else {
            json!([library])
        };
        let created = crate::agent_work::ui(&root, &json!({"action":"create","goal":case["goal"],"successCriteria":case["minimum"],"anchor":anchor,"grant":{"libraryIds":libraries,"notes":[anchor],"readingItemKeys":[],"sources":[],"attachmentLibraryIds":[]}})).unwrap();
        let id = created["work"]["id"].as_str().unwrap();
        let result = crate::agent_work::ui(&root, &json!({"action":"run","id":id,"mode":"quick"}));
        results.push(json!({"case":case["id"],"workId":id,"result":result}));
        save(&evidence, "diagnostic-results.json", &json!(results));
    }
    ui(&root, &json!({"action":"save","settings":settings_before})).unwrap();
    assert!(!results.is_empty());
    if config["requireDelivered"] == true {
        for (case, result) in config["cases"].as_array().unwrap().iter().zip(&results) {
            let view = &result["result"]["Ok"];
            assert!(
                matches!(
                    view["work"]["state"].as_str(),
                    Some("completed" | "insufficientEvidence")
                ),
                "{}: {}",
                case["id"],
                view["run"]["error"]
            );
            let excerpts = view["evidence"].as_array().unwrap();
            let cited: std::collections::HashSet<_> = view["work"]["report"]["findings"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|f| f["citations"].as_array().unwrap())
                .filter_map(|c| {
                    let i = c["evidenceId"]
                        .as_str()?
                        .strip_prefix('e')?
                        .parse::<usize>()
                        .ok()?
                        .checked_sub(1)?;
                    excerpts.get(i)?["locator"]["documentId"].as_str()
                })
                .collect();
            for required in case["requiredDocuments"].as_array().unwrap() {
                if case["id"] == "CAR-unknown" {
                    assert!(excerpts
                        .iter()
                        .any(|e| e["locator"]["documentId"] == *required));
                    continue;
                }
                assert!(
                    cited.contains(required.as_str().unwrap()),
                    "{} missing citation for {}",
                    case["id"],
                    required
                );
            }
        }
    }
}
impl Environment {
    fn without_codex() -> Self {
        let changes = [
            ("LOCALAPPDATA", "C:/Windows/Temp/hub-no-codex"),
            ("APPDATA", "C:/Windows/Temp/hub-no-codex"),
            ("PATH", "C:/Windows/System32"),
            ("CODEX_HOME", "C:/Windows/Temp/hub-no-codex"),
            ("USERPROFILE", "C:/Windows/Temp/hub-no-codex"),
        ];
        let mut old = Vec::new();
        for (k, v) in changes {
            old.push((k.to_string(), std::env::var_os(k)));
            std::env::set_var(k, v);
        }
        Self(old)
    }
}
impl Drop for Environment {
    fn drop(&mut self) {
        for (k, v) in &self.0 {
            if let Some(v) = v {
                std::env::set_var(k, v)
            } else {
                std::env::remove_var(k)
            }
        }
    }
}

#[test]
#[ignore = "Explicit real-data/API acceptance: requires HUB_LIVE_MODEL_ACCEPTANCE_CONFIG; creates acceptance works, memories and drafts"]
fn real_data_direct_provider_and_shared_memory_acceptance() {
    let config_path = std::env::var_os("HUB_LIVE_MODEL_ACCEPTANCE_CONFIG")
        .expect("explicit acceptance config required");
    let config: Value = serde_json::from_slice(&std::fs::read(config_path).unwrap()).unwrap();
    assert_eq!(config["format"], "hub-model-real-data-acceptance-v1");
    let root = PathBuf::from(config["dataRoot"].as_str().unwrap());
    let evidence = PathBuf::from(config["evidenceDir"].as_str().unwrap());
    assert!(root.join("craft-search.sqlite3").is_file() && evidence.is_dir());
    if let Some(prior) = config["cleanupPriorIdentity"].as_str() {
        let identity: Value = serde_json::from_slice(&std::fs::read(prior).unwrap()).unwrap();
        let c = crate::source_evidence::open_read_database(&root).unwrap();
        for key in ["ruleId", "decisionId"] {
            let id = identity[key].as_str().unwrap();
            let project: String = c
                .query_row(
                    "SELECT project_id FROM memory_entries WHERE id=?1",
                    [id],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(project, identity["projectA"].as_str().unwrap());
            let state: String = c
                .query_row("SELECT state FROM memory_entries WHERE id=?1", [id], |r| {
                    r.get(0)
                })
                .unwrap();
            if state != "forgotten" {
                crate::shared_memory::ui(
                    &root,
                    &json!({"action":"forget","id":id,"confirmed":true}),
                )
                .unwrap();
            }
        }
    }
    let before = source_digest(&root);
    save(
        &evidence,
        "live-progress.json",
        &json!({"stage":"importCredential","sourceDigestBefore":before}),
    );
    ui(
        &root,
        &json!({"action":"importCredential","path":config["keyFile"]}),
    )
    .unwrap();
    assert_eq!(
        ui(&root, &json!({"action":"credentialStatus"})).unwrap()["deepseekConfigured"],
        true
    );
    selection(&root, "deepseek", "deepseek-flash", "none");
    let catalog = ui(&root, &json!({"action":"models","provider":"deepseek"})).unwrap();
    save(&evidence, "live-catalog.json", &catalog);
    let batch = format!("HBM-01B 联合验收 {}", crate::random_url_safe(8));
    let project_a = project(&root, &format!("{batch} A"));
    let project_b = project(&root, &format!("{batch} B"));
    let put = json!({"action":"put","projectId":project_a,"topicKey":"source-boundary","title":"浏览器分类的证据边界（验收）","kind":"rule","body":"在此验收项目中，区分分类计划生成和浏览器实际执行；没有实际执行记录时，只报告来源能够证明的职责，不声称已经改变浏览器。","expectedVersion":0,"requestKey":format!("{batch}-rule-1"),"confirmed":true});
    let mem = crate::shared_memory::ui(&root, &put).unwrap();
    let rule = mem["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["projectId"] == project_a && v["topicKey"] == "source-boundary")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    crate::shared_memory::ui(&root, &put).unwrap(); // Same request is idempotent.
    let decision_put = json!({"action":"put","projectId":project_a,"topicKey":"tabweave-responsibility","title":"TabWeave 的职责约定（联合验收）","kind":"decision","body":"TabWeave 资料记载：仅生成符合输入 Schema 的分类计划，由 TabWeave 负责采集、校验与执行。此条只用于本次跨提供方联合验收，不扩大工具和来源授权。","expectedVersion":0,"requestKey":format!("{batch}-decision-1"),"confirmed":true});
    let mem = crate::shared_memory::ui(&root, &decision_put).unwrap();
    let decision = mem["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["projectId"] == project_a && v["topicKey"] == "tabweave-responsibility")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    save(
        &evidence,
        "live-identity.json",
        &json!({"projectA":project_a,"projectB":project_b,"ruleId":rule,"decisionId":decision,"batch":batch}),
    );
    let mut works = Vec::new();
    // This process has no discoverable Codex executable, login or skills directory
    // during all initial direct-provider work; no source/database fixture is seeded.
    {
        let _environment = Environment::without_codex();
        assert!(cli::candidates().is_empty());
        assert!(crate::model_skills::load(
            "craft-general-archive",
            &["references/write-protocol.md"]
        )
        .is_ok());
        for (index, item) in config["questions"].as_array().unwrap().iter().enumerate() {
            let id = create(&root, &item["anchor"], item["goal"].as_str().unwrap());
            scope(&root, &id, &project_a);
            save(
                &evidence,
                "live-progress.json",
                &json!({"stage":"deepseekInvestigation","index":index,"workId":id}),
            );
            let result = run(&root, &id);
            assert!(result["memoryUse"]["items"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v["id"] == rule && v["version"] == 1));
            if index == 0 {
                assert!(
                    result["memoryUse"]["items"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|v| v["id"] == decision && v["version"] == 1),
                    "relevant decision was not retrieved by Basic Memory"
                );
            }
            save(
                &evidence,
                &format!("deepseek-investigation-{index}.json"),
                &result,
            );
            works.push(id);
        }
        let id = &works[0];
        save(
            &evidence,
            "live-progress.json",
            &json!({"stage":"flashcards","workId":id}),
        );
        let cards=crate::agent_work::ui(&root,&json!({"action":"prepareFlashcards","id":id,"deckName":format!("{batch}（草稿）"),"learningGoal":"区分 TabWeave 分类计划生成、校验与浏览器实际执行职责"})).unwrap();
        assert!(cards["actions"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["kind"] == "flashcardDrafts" && v["state"] == "prepared"));
        save(&evidence, "deepseek-flashcard-drafts.json", &cards);
        let tag = config["tag"].as_str().unwrap();
        let def =
            crate::hub_mcp::tag_assignment::ui(&root, &json!({"action":"definition","tag":tag}))
                .unwrap();
        let version = def["definition"]["version"].as_i64().unwrap_or(0);
        let current = def["definition"]["definition"].clone();
        let tag_draft=crate::hub_mcp::tag_assignment::ui(&root,&json!({"action":"generate_definition","tag":tag,"expectedVersion":version,"currentInput":current})).unwrap();
        assert!(tag_draft["draft"]["id"].is_i64());
        assert_eq!(
            tag_draft["definition"]["version"],
            def["definition"]["version"]
        );
        save(&evidence, "deepseek-tag-definition-draft.json", &tag_draft);
        save(
            &evidence,
            "live-progress.json",
            &json!({"stage":"tagConsumers"}),
        );
        let id = create(
            &root,
            &config["tagAnchor"],
            "核对这份工作相关材料与已保存的工作心态定义，准备一条待审核补标建议，不改来源。",
        );
        let proposal = crate::agent_work::ui(
            &root,
            &json!({"action":"prepareTagProposal","id":id,"tag":tag}),
        )
        .unwrap();
        assert!(proposal["actions"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["kind"] == "tagProposal" && v["state"] == "prepared"));
        save(&evidence, "deepseek-tag-proposal.json", &proposal);
        let governance = crate::hub_mcp::tag_assignment::ui(
            &root,
            &json!({"action":"governance_analyze","tag":tag,"global":false}),
        )
        .unwrap();
        assert!(governance["errors"].as_array().unwrap().is_empty());
        save(&evidence, "deepseek-tag-governance.json", &governance);
        let discovery=crate::hub_mcp::tag_assignment::ui(&root,&json!({"action":"discover_assignments","tag":tag,"expectedVersion":version,"currentInput":def["definition"]["definition"],"resume":false})).unwrap();
        save(&evidence, "deepseek-tag-discovery.json", &discovery);
        let preview = crate::hub_mcp::tag_assignment::ui(
            &root,
            &json!({"action":"scan_preview_new","tag":tag,"maxEntities":1,"maxChars":6000}),
        )
        .unwrap();
        let scan=crate::hub_mcp::tag_assignment::ui(&root,&json!({"action":"scan_create_new","tag":tag,"maxEntities":1,"maxChars":6000,"definitionVersion":version,"requestId":format!("{batch}-scan"),"confirmationToken":preview["confirmationToken"]})).unwrap();
        let scanned = crate::hub_mcp::tag_assignment::ui(
            &root,
            &json!({"action":"scan_generate","tag":tag,"runId":scan["run"]["runId"]}),
        )
        .unwrap();
        assert!(scanned["errors"].as_array().unwrap().is_empty());
        save(&evidence, "deepseek-content-scan.json", &scanned);
    }
    // A different provider receives the same current Hub memory identity and scope.
    selection(&root, "codex", "gpt-6-sol", "high");
    let first = &config["questions"][0];
    let codex_id = create(&root, &first["anchor"], first["goal"].as_str().unwrap());
    scope(&root, &codex_id, &project_a);
    save(
        &evidence,
        "live-progress.json",
        &json!({"stage":"codexReuse","workId":codex_id}),
    );
    let codex = run(&root, &codex_id);
    assert!(codex["memoryUse"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["id"] == rule && v["version"] == 1));
    assert!(codex["memoryUse"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["id"] == decision && v["version"] == 1));
    save(&evidence, "codex-memory-reuse.json", &codex);
    let update = json!({"action":"put","projectId":project_a,"topicKey":"source-boundary","title":"浏览器分类的证据边界（验收）","kind":"rule","body":"在此验收项目中，先给出职责和准确依据，再单独说明尚未核对的限制；计划生成、校验与浏览器执行分别描述，不把建议写成已执行事实。","expectedVersion":1,"requestKey":format!("{batch}-rule-2"),"confirmed":true});
    crate::shared_memory::ui(&root, &update).unwrap();
    selection(&root, "deepseek", "deepseek-flash", "none");
    let updated_id = create(&root, &first["anchor"], first["goal"].as_str().unwrap());
    scope(&root, &updated_id, &project_a);
    let updated = run(&root, &updated_id);
    assert!(updated["memoryUse"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["id"] == rule && v["version"] == 2));
    save(&evidence, "updated-memory-v2.json", &updated);
    let other_id = create(&root, &first["anchor"], first["goal"].as_str().unwrap());
    scope(&root, &other_id, &project_b);
    let other = run(&root, &other_id);
    assert!(!other["memoryUse"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["id"] == rule));
    save(&evidence, "project-isolation.json", &other);
    crate::shared_memory::ui(&root, &json!({"action":"deactivate","id":rule})).unwrap();
    let context = crate::shared_memory::context(&root, &updated_id, "TabWeave")
        .unwrap()
        .unwrap();
    assert!(!context.audit()["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["id"] == rule));
    save(&evidence, "deactivated-memory.json", &context.audit());
    crate::shared_memory::ui(
        &root,
        &json!({"action":"forget","id":rule,"confirmed":true}),
    )
    .unwrap();
    crate::shared_memory::ui(
        &root,
        &json!({"action":"forget","id":decision,"confirmed":true}),
    )
    .unwrap();
    let context = crate::shared_memory::context(&root, &updated_id, "TabWeave")
        .unwrap()
        .unwrap();
    assert!(!context.audit()["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["id"] == rule));
    save(&evidence, "forgotten-memory.json", &context.audit());
    // An interrupted real HTTP call must release the common queue and allow a new run.
    let cancel_id = create(&root, &first["anchor"], first["goal"].as_str().unwrap());
    scope(&root, &cancel_id, &project_a);
    let thread_root = root.clone();
    let thread_id = cancel_id.clone();
    let running = std::thread::spawn(move || {
        crate::agent_work::ui(
            &thread_root,
            &json!({"action":"run","id":thread_id,"mode":"quick"}),
        )
    });
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        let view = ui(&root, &json!({"action":"status"})).unwrap();
        if view["jobs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["state"] == "running")
        {
            break;
        }
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(30));
    }
    std::thread::sleep(Duration::from_millis(400));
    crate::agent_work::ui(&root, &json!({"action":"cancel","id":cancel_id})).unwrap();
    let interrupted = running.join().unwrap().unwrap();
    assert_eq!(interrupted["work"]["state"], "interrupted");
    save(&evidence, "real-cancelled.json", &interrupted);
    let resumed = run(&root, &cancel_id);
    save(&evidence, "real-resumed.json", &resumed);
    assert_eq!(
        before,
        source_digest(&root),
        "source documents changed during acceptance"
    );
    let final_runtime = ui(&root, &json!({"action":"status"})).unwrap();
    save(&evidence, "runtime-jobs.json", &final_runtime);
    assert!(!final_runtime["jobs"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| matches!(v["state"].as_str(), Some("queued" | "running"))));
    save(
        &evidence,
        "live-progress.json",
        &json!({"stage":"passed","sourceDigestBefore":before,"sourceDigestAfter":source_digest(&root),"ruleId":rule,"projectA":project_a,"projectB":project_b,"deepseekWorks":works,"codexWork":codex_id,"updatedWork":updated_id,"otherProjectWork":other_id,"cancelledAndResumedWork":cancel_id,"secretExported":false,"sourceDocumentsUnchanged":true,"sourceWrites":0,"flashcardActivation":false,"tagDefinitionConfirmed":false}),
    );
}
