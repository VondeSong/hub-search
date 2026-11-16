use super::*;
use crate::obsidian_edit::tests::Fixture;
mod charts;
mod sleep;

#[test]
fn direct_contract_omits_only_explicitly_unavailable_capabilities() {
    let original = schema(runner::schema());
    let mut catalog = crate::hub_capabilities::catalog();
    for (i, tool) in catalog["tools"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .enumerate()
    {
        tool["available"] = json!(i % 2 == 0);
        tool["unavailableReason"] = json!("本轮未授权");
    }
    let projected = available_schema(original.clone(), &catalog);
    let requests = projected["properties"]["requests"]["items"]["anyOf"]
        .as_array()
        .unwrap();
    for request in original["properties"]["requests"]["items"]["anyOf"]
        .as_array()
        .unwrap()
    {
        let disabled = catalog["tools"].as_array().unwrap().iter().any(|tool| {
            tool["available"] == false
                && request["properties"]["operation"]["enum"] == json!(["capability"])
                && request["properties"]["name"]["enum"] == json!([tool["name"]])
        });
        assert_eq!(requests.contains(request), !disabled);
    }
    assert_eq!(
        projected["properties"]["report"],
        original["properties"]["report"]
    );
    assert_eq!(available_schema(original.clone(), &Value::Null), original);
    let metadata = capability_metadata(catalog.clone(), &projected);
    for (before, after) in catalog["tools"]
        .as_array()
        .unwrap()
        .iter()
        .zip(metadata["tools"].as_array().unwrap())
    {
        for field in [
            "name",
            "description",
            "annotations",
            "available",
            "unavailableReason",
        ] {
            assert_eq!(before[field], after[field]);
        }
        assert!(after.get("inputSchema").is_none());
    }
}

#[test]
#[ignore = "pure value measurement of an explicitly supplied real initial request; no database or model calls"]
fn direct_contract_saved_material_measurement() {
    let path = std::env::var("HUB_MATERIAL_INPUT").unwrap();
    let text = std::fs::read_to_string(path).unwrap();
    let material: Value = serde_json::from_str(&text[text.find('{').unwrap()..]).unwrap();
    let mut catalog = crate::hub_capabilities::catalog();
    for tool in catalog["tools"].as_array_mut().unwrap() {
        let saved = material["hubCapabilities"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|saved| saved["name"] == tool["name"])
            .unwrap();
        tool["available"] = saved["available"].clone();
        tool["unavailableReason"] = saved["unavailableReason"].clone();
    }
    let before = schema(runner::schema());
    let after = available_schema(before.clone(), &catalog);
    let sizes: Vec<_> = before["properties"]["requests"]["items"]["anyOf"].as_array().unwrap().iter().map(|r| json!({"operation":r["properties"]["operation"]["enum"],"name":r["properties"]["name"]["enum"],"bytes":r.to_string().len()})).collect();
    let result = json!({"nativeInitialInputBytes":text.len(),"beforeSchemaBytes":before.to_string().len(),"afterSchemaBytes":after.to_string().len(),"savedSchemaBytes":before.to_string().len()-after.to_string().len(),"allTools":catalog["tools"].as_array().unwrap().len(),"availableTools":catalog["tools"].as_array().unwrap().iter().filter(|t|t["available"]==true).count(),"operations":sizes,"scope":"production direct schema and saved real availability; not an exact failed DeepSeek prompt or a model run"});
    println!("MATERIAL_CONTRACT {result}");
    assert!(after.to_string().len() < before.to_string().len());
}

#[test]
fn capability_metadata_keeps_availability_and_schemas_remain_in_request_contract() {
    let mut catalog = crate::hub_capabilities::catalog();
    catalog["tools"][0]["available"] = json!(false);
    catalog["tools"][0]["unavailableReason"] = json!("当前仅授权具体材料");
    let contract = schema(runner::schema());
    let metadata = capability_metadata(catalog.clone(), &contract);
    assert_eq!(
        metadata["tools"].as_array().unwrap().len(),
        catalog["tools"].as_array().unwrap().len()
    );
    let requests = contract["properties"]["requests"]["items"]["anyOf"]
        .as_array()
        .unwrap();
    for (tool, projected) in catalog["tools"]
        .as_array()
        .unwrap()
        .iter()
        .zip(metadata["tools"].as_array().unwrap())
    {
        let request = requests
            .iter()
            .find(|r| r["properties"]["name"]["enum"][0] == tool["name"])
            .unwrap();
        assert_eq!(request["properties"]["arguments"], tool["inputSchema"]);
        assert!(projected.get("inputSchema").is_none());
        assert_eq!(projected["description"], tool["description"]);
        assert_eq!(projected["annotations"], tool["annotations"]);
        assert_eq!(projected["available"], tool["available"]);
        assert_eq!(projected["unavailableReason"], tool["unavailableReason"]);
    }
    // An external or changed schema can be the sole argument contract; retain it.
    let external = json!({"tools":[{"name":"external_unique_tool","inputSchema":{"type":"object","properties":{"externalOnly":{"type":"string"}}}}]});
    assert_eq!(capability_metadata(external.clone(), &contract), external);
    catalog["tools"][0]["available"] = json!(true);
    catalog["tools"][0]["inputSchema"]["properties"]["changedArgument"] = json!({"type":"string"});
    assert_eq!(
        capability_metadata(catalog.clone(), &contract)["tools"][0],
        catalog["tools"][0]
    );
}

#[test]
fn answer_schema_and_host_share_the_citation_limit_and_specific_feedback() {
    let schema = schema(runner::schema());
    assert_eq!(
        schema["properties"]["report"]["anyOf"][0]["properties"]["citations"]["maxItems"],
        40
    );
    let catalog = json!((1..=41)
        .map(|i| json!({"quoteId":format!("e1:q{i}"),"evidenceId":"e1","text":format!("原文 {i}")}))
        .collect::<Vec<_>>());
    let answer = |count: usize| json!({"report":{"status":"completed","markdown":(1..=count).map(|i|format!("结论[{i}]。")).collect::<String>(),"citations":(1..=count).map(|i|json!({"quoteId":format!("e1:q{i}")})).collect::<Vec<_>>(),"questions":[],"limitations":[],"waitCondition":""}});
    assert!(normalize(answer(40), &catalog).is_ok());
    let oversized = answer(41);
    let error = normalize(oversized.clone(), &catalog).unwrap_err();
    assert!(error.contains("最多 40 项引用") && error.contains("当前为 41 项"));
    let mut empty = answer(1);
    empty["report"]["markdown"] = json!("");
    assert_eq!(
        normalize(empty, &catalog).unwrap_err(),
        "助手答复为空，未发布本轮回答。"
    );
    let mut long = answer(1);
    long["report"]["markdown"] = json!("文".repeat(runner::ANSWER_CHARS + 1));
    assert!(normalize(long, &catalog).unwrap_err().contains("正文超过"));
}

#[test]
fn reliability_native_turn_uses_existing_run_budget_and_keeps_other_limits() {
    for mode in ["quick", "deep"] {
        let original = budget(mode).unwrap();
        let native = provider_budget(original, "codex");
        let mut expected = json!(original);
        expected["modelCallSeconds"] = json!(original.seconds);
        assert_eq!(json!(native), expected);
        assert_eq!(
            json!(provider_budget(original, "deepseek")),
            json!(original)
        );
        let continuation = store::report_continuation::budget(native);
        assert_eq!(continuation.seconds, 120);
        assert_eq!(continuation.model_call_seconds, 90);
        let control = Control::bounded(Duration::from_secs(native.seconds))
            .with_generation_ceiling(Duration::from_secs(native.model_call_seconds));
        assert!(control.remaining().unwrap() <= Duration::from_secs(original.seconds));
        control.cancel();
        assert!(control.check().is_err());
    }
}

#[test]
fn reliability_rules_storage_matches_admission_without_relaxing_other_records() {
    let (f, _, _, run) = setup();
    let value = json!({"rules":"中".repeat(24000)});
    assert!(value.to_string().len() > 65536);
    store::record(&f.root, &run, "libraryRules", &value).unwrap();
    assert_eq!(
        store::record(&f.root, &run, "toolResult", &value).unwrap_err(),
        "单条调查记录过大"
    );
    let oversized = json!({"rules":"中".repeat(44000)});
    assert!(store::record(&f.root, &run, "libraryRules", &oversized).is_err());
}

#[test]
#[ignore = "read-only replay of the explicitly supplied personal-copy failure"]
fn reliability_saved_three_note_rules_replay() {
    let root = std::path::PathBuf::from(std::env::var("HUB_RELIABILITY_ROOT").unwrap());
    let work = store::view(&root, "work-xKhugdtA8VkKN_hByQeKLCwV").unwrap();
    let grant: Grant = serde_json::from_value(work["work"]["grant"].clone()).unwrap();
    let skills =
        crate::hub_capabilities::Session::new(&root, Some(grant.scope().unwrap())).unwrap();
    let guidance = skills.guidance();
    let compact_bytes = guidance.to_string().len();
    let (f, _, _, run) = setup();
    store::record(&f.root, &run, "libraryRules", &guidance).unwrap();
    assert!(compact_bytes < 65536);
    assert!(guidance.as_array().unwrap().len() >= 3);
    skills.verify().unwrap();
    println!(
        "RELIABILITY rulesBytes={compact_bytes}; bundles={}; productionFailurePreserved=true",
        guidance.as_array().unwrap().len()
    );
}

fn setup() -> (Fixture, String, Work, String) {
    let f = Fixture::new();
    let doc=f.seed("Learning.md","# 主动回忆\n先理解材料，再合上原文主动回忆。\n每张闪卡只考一个明确的问题，答案应自足。\n草稿先进入收件箱审核，检查准确并有原文依据后，才进入正式复习。\n");
    let anchor = EvidenceLocator::Note {
        library_id: "notes".into(),
        document_id: doc,
        page_id: None,
    };
    let id = store::create(
        &f.root,
        "整理这篇笔记的结构，再做两张问答闪卡，并检查草稿。先预览。".into(),
        "保留事实与来源，只准备草稿".into(),
        anchor.clone(),
        Grant {
            notes: vec![anchor],
            ..Default::default()
        },
    )
    .unwrap();
    let run = format!("test-agent-{}", crate::random_url_safe(8));
    let w = store::claim(&f.root, &id, &run).unwrap();
    store::record(
        &f.root,
        &run,
        "agentProtocol",
        &json!({"version":1,"options":options::load(&f.root,&id).unwrap()}),
    )
    .unwrap();
    (f, id, w, run)
}

fn qualification_fixture(managed: bool) -> (Fixture, Work, String) {
    let f = Fixture::new();
    let doc = f.seed("Qualification.md", "数量17件，验收尚未确认。\n");
    let anchor = EvidenceLocator::Note {
        library_id: "notes".into(),
        document_id: doc,
        page_id: None,
    };
    let id = store::create(
        &f.root,
        "准备预览".into(),
        "只预览，不保存".into(),
        anchor.clone(),
        Grant {
            notes: vec![anchor],
            ..Default::default()
        },
    )
    .unwrap();
    if managed {
        ui(&f.root,&json!({"action":"freezeProviderBudget","id":id,"expectedWorkRevision":1,
            "analysisScope":store::provider_budget::direct::SCOPE,
            "limits":{"inputTokens":600000,"uncachedInputTokens":600000,"outputTokens":24576},
            "perRun":{"inputTokens":200000,"uncachedInputTokens":200000,"outputTokens":8192},"unknownReservations":{}})).unwrap();
    }
    let run = format!("qualification-{}", crate::random_url_safe(8));
    let w = store::claim_with_budget(&f.root, &id, &run, budget("quick").unwrap()).unwrap();
    (f, w, run)
}

#[test]
fn v4_qualification_managed_deepseek_hides_and_rejects_new_drafts_without_writes() {
    let (f, w, run) = qualification_fixture(true);
    let control = Control::default();
    let session = Session {
        root: &f.root,
        work: &w,
        run: &run,
        control: &control,
        operation: None,
        selection: json!({"provider":"deepseek"}),
        app: None,
    };
    let caps = session.capabilities().unwrap();
    assert_eq!(caps["obsidianEdit"], false);
    assert_eq!(caps["flashcards"], false);
    assert_eq!(caps["autoFlashcardInbox"], false);
    assert_eq!(caps["draftProvider"]["allowed"], false);
    let before: i64 = f
        .c()
        .query_row("SELECT COUNT(*) FROM agent_records", [], |r| r.get(0))
        .unwrap();
    let source = std::fs::read(f.vault.join("Qualification.md")).unwrap();
    let mtime = std::fs::metadata(f.vault.join("Qualification.md"))
        .unwrap()
        .modified()
        .unwrap();
    for value in [
        json!({"operation":"draftContext","kind":"obsidianEdit","instruction":"仅预览","target":"当前笔记","baseActionId":null}),
        json!({"operation":"prepareDraft","contextId":"not-dispatched","candidate":{}}),
        json!({"operation":"prepareArchive","instruction":"仅预览","libraryId":"notes","baseActionId":null}),
        json!({"operation":"importFlashcards","actionId":"not-dispatched"}),
    ] {
        let error = session
            .dispatch_for_capture(serde_json::from_value(value).unwrap())
            .unwrap_err();
        assert!(
            error.contains("Codex") && error.contains("累计用量"),
            "{error}"
        );
    }
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM agent_records", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        before
    );
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM agent_actions", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        std::fs::read(f.vault.join("Qualification.md")).unwrap(),
        source
    );
    assert_eq!(
        std::fs::metadata(f.vault.join("Qualification.md"))
            .unwrap()
            .modified()
            .unwrap(),
        mtime
    );
}

#[test]
fn v4_qualification_same_policy_codex_can_prepare_and_deepseek_can_inspect_saved_draft() {
    let (f, w, run) = qualification_fixture(true);
    let control = Control::default();
    let session = Session {
        root: &f.root,
        work: &w,
        run: &run,
        control: &control,
        operation: None,
        selection: json!({"provider":"codex"}),
        app: None,
    };
    assert_eq!(session.capabilities().unwrap()["obsidianEdit"], true);
    let context=session.dispatch_for_capture(serde_json::from_value(json!({"operation":"draftContext","kind":"obsidianEdit","instruction":"只准备预览","target":"当前笔记","baseActionId":null})).unwrap()).unwrap();
    let draft=session.dispatch_for_capture(serde_json::from_value(json!({"operation":"prepareDraft","contextId":context["contextId"],"candidate":{"markdown":"- 数量17件。\n- 验收尚未确认。\n","summary":"仅预览","warnings":[]}})).unwrap()).unwrap();
    let deepseek = Session {
        selection: json!({"provider":"deepseek"}),
        ..session
    };
    let readback = deepseek
        .dispatch_for_capture(
            serde_json::from_value(
                json!({"operation":"inspectDraft","actionId":draft["actionId"]}),
            )
            .unwrap(),
        )
        .unwrap();
    assert_eq!(readback["content"]["after"], draft["content"]["after"]);
    assert_eq!(readback["state"], "prepared");
    assert_eq!(
        std::fs::read_to_string(f.vault.join("Qualification.md")).unwrap(),
        "数量17件，验收尚未确认。\n"
    );
}

#[test]
fn v4_qualification_legacy_deepseek_keeps_existing_draft_context_scope() {
    let (f, w, run) = qualification_fixture(false);
    let control = Control::default();
    let session = Session {
        root: &f.root,
        work: &w,
        run: &run,
        control: &control,
        operation: None,
        selection: json!({"provider":"deepseek"}),
        app: None,
    };
    assert_eq!(session.capabilities().unwrap()["obsidianEdit"], true);
    let context=session.dispatch_for_capture(serde_json::from_value(json!({"operation":"draftContext","kind":"obsidianEdit","instruction":"只预览","target":"当前笔记","baseActionId":null})).unwrap()).unwrap();
    assert!(context["contextId"].is_string());
}

#[test]
fn direct_tool_envelope_requires_explicit_null_report() {
    let schema = schema(runner::schema());
    let mut value = json!({"rationale":"只读格式回放","requests":[{"operation":"goalState"}]});
    assert!(crate::model_runtime::validate_agent_tool(&value, &schema).is_err());
    value["report"] = Value::Null;
    crate::model_runtime::validate_agent_tool(&value, &schema).unwrap();
    assert!(schema["description"].as_str().unwrap().contains("不能省略"));
}
fn host(prompt: &str) -> Value {
    serde_json::from_str(prompt.split("宿主材料(JSON):\n").last().unwrap()).unwrap()
}
fn tools(rationale: &str, requests: Value) -> Value {
    json!({"rationale":rationale,"requests":requests,"report":null})
}
fn answer(material: &Value) -> Value {
    json!({"rationale":"","requests":[],"report":{"status":"completed",
        "markdown":"已按要求准备草稿，保留主动回忆和审核条件。[1]\n\n| 成果 | 状态 |\n|---|---|\n| 草稿 | 待确认 |",
        "citations":[{"quoteId":material["quoteCatalog"][0]["quoteId"]}],"questions":[],"limitations":[],"waitCondition":""}})
}
fn contexts(m: &Value) -> Vec<&Value> {
    m["observations"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|v| v["contextId"].is_string())
        .collect()
}
fn drafts(m: &Value) -> Vec<&Value> {
    m["observations"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|v| v["actionId"].is_string())
        .collect()
}
fn card(quote: &str) -> Value {
    json!({"cards":[{"question":"为什么先理解再主动回忆？","answer":"主动回忆前先理解材料。","explanation":"理解建立含义联系，合上原文后再检验是否能够提取。","quote":quote}],
        "uncoveredTargets":[],"ruleApplications":[]})
}
fn execute(
    f: &Fixture,
    w: &Work,
    run: &str,
    ask: impl FnMut(&str, &Value) -> Result<Value, String>,
) -> Result<(), String> {
    execute_budget(f, w, run, budget("quick")?, ask)
}
fn execute_budget(
    f: &Fixture,
    w: &Work,
    run: &str,
    budget: Budget,
    ask: impl FnMut(&str, &Value) -> Result<Value, String>,
) -> Result<(), String> {
    let control = Control::bounded(Duration::from_secs(30));
    let session = Session {
        root: &f.root,
        work: w,
        run,
        control: &control,
        operation: None,
        selection: json!({"provider":"fixture"}),
        app: None,
    };
    runner::investigate_assistant(&f.root, w, run, &control, budget, &session, ask)
}

#[test]
fn structured_agent_selects_skill_then_reference_and_activity_uses_real_results() {
    let (f, id, w, run) = setup();
    let mut call = 0;
    execute(&f,&w,&run,|prompt,schema| {
        let material=host(prompt);
        assert!(schema["properties"]["requests"]["items"]["anyOf"].as_array().unwrap().iter().any(|s|s["properties"]["operation"]["enum"][0]=="loadSkill"));
        assert_eq!(material["skills"]["runtime"],"hub");
        let reply=match call {
            0=>{
                assert!(material["skills"]["skills"].as_array().unwrap().iter().all(|s|s.get("instructions").is_none()));
                tools("先读取闪卡检查方法。",json!([{"operation":"loadSkill","name":"hub-flashcards"}]))
            }
            1=>{
                assert!(material["observations"].as_array().unwrap().iter().any(|o|o["kind"]=="skillInstructions" && o["instructions"].as_str().unwrap().contains("candidateSchema")));
                tools("读取需要的质量参考。",json!([{"operation":"readSkillReference","name":"hub-flashcards","path":"references/quality.md"}]))
            }
            _=>{
                assert!(material["observations"].as_array().unwrap().iter().any(|o|o["kind"]=="skillReference"));
                json!({"rationale":"","requests":[],"report":{"status":"completed","markdown":"已读取检查方法；本轮没有制作或保存草稿。","citations":[],"questions":[],"limitations":[],"waitCondition":""}})
            }
        };
        call+=1;
        Ok(reply)
    }).unwrap();
    assert_eq!(call, 3);
    let view = store::view(&f.root, &id).unwrap();
    let events = view["activity"].as_array().unwrap().last().unwrap()["events"]
        .as_array()
        .unwrap();
    assert_eq!(events.iter().filter(|e| e["kind"] == "skill").count(), 2);
    assert!(events.iter().any(|e| e["detail"]
        .as_str()
        .is_some_and(|s| s.contains("Hub 内置") && s.contains("版本"))));
    let reference = store::records(&f.root, &id, "toolResult", 10)
        .unwrap()
        .into_iter()
        .find(|row| row["kind"] == "skillReference")
        .unwrap();
    let expected = format!("参考版本 {}", &reference["version"].as_str().unwrap()[..12]);
    assert!(events.iter().any(|event| event["detail"]
        .as_str()
        .is_some_and(|detail| detail.contains(&expected))));
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM agent_actions", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        store::records(&f.root, &id, "evidence", 20).unwrap().len(),
        1
    );
}

#[test]
fn skill_loading_failure_is_observed_and_does_not_prevent_a_direct_answer() {
    let (f, id, w, run) = setup();
    let mut call = 0;
    execute(&f, &w, &run, |prompt, _| {
        let material = host(prompt);
        let reply = if call == 0 {
            tools(
                "核对所选方法。",
                json!([{"operation":"loadSkill","name":"not-installed"}]),
            )
        } else {
            assert!(material["observations"]
                .as_array()
                .unwrap()
                .iter()
                .any(|o| o["error"].as_str().is_some_and(|s| s.contains("未找到"))));
            answer(&material)
        };
        call += 1;
        Ok(reply)
    })
    .unwrap();
    let view = store::view(&f.root, &id).unwrap();
    assert!(
        view["activity"].as_array().unwrap().last().unwrap()["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["state"] == "failed" && e["label"] == "读取技能说明")
    );
}

#[test]
fn skill_change_during_a_model_call_prevents_publishing_a_stale_answer() {
    let (f, id, w, run) = setup();
    let directory = f.root.join("agent-skills/custom-method");
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("SKILL.md");
    std::fs::write(
        &path,
        "---\nname: custom-method\ndescription: 自定义方法\n---\n第一版。\n",
    )
    .unwrap();
    let result = execute(&f, &w, &run, |prompt, _| {
        let material = host(prompt);
        std::fs::write(
            &path,
            "---\nname: custom-method\ndescription: 自定义方法\n---\n第二版。\n",
        )
        .unwrap();
        Ok(answer(&material))
    });
    assert!(result.unwrap_err().contains("技能目录或内容已变化"));
    assert!(store::view(&f.root, &id).unwrap()["work"]["report"].is_null());
}

#[test]
fn shared_tools_preserve_scope_citations_and_model_selected_search_then_read() {
    let (f, id, w, run) = setup();
    {
        let mut c = f.c();
        let records = crate::search_index_runtime::collect_index_records(&c, None).unwrap();
        crate::search_index_runtime::build_and_activate_search_generation(
            &mut c,
            &f.root.join("tantivy-generations-v1"),
            |index| {
                index.rebuild(&records)?;
                Ok(records.len())
            },
        )
        .unwrap();
    }
    std::fs::write(f.vault.join("AGENTS.md"), "本库回答使用中文，并保留来源。").unwrap();
    let mut call = 0;
    execute(&f,&w,&run,|prompt,_| {
        let material=host(prompt);
        assert!(material["knowledgeRules"].to_string().contains("本库回答使用中文"));
        let locator=&material["observations"][0]["anchor"]["excerpt"]["locator"];
        let reply=match call {
            0=>tools("先定位相关材料。",json!([{"operation":"capability","name":"hub_search_notes","arguments":{"query":"主动回忆","limit":5}}])),
            1=>{
                // Search did not silently choose and read a result for the model.
                assert_eq!(material["observations"].as_array().unwrap().iter().filter(|v|v.get("evidenceId").is_some()).count(),0);
                assert!(material["observations"].as_array().unwrap().iter().any(|v|v["candidates"].is_array()));
                tools("读取选中的原文。",json!([{"operation":"capability","name":"hub_read_note","arguments":{"libraryId":locator["libraryId"],"documentId":locator["documentId"],"maxChars":1000}}]))
            }
            _=>answer(&material),
        };call+=1;Ok(reply)
    }).unwrap();
    assert_eq!(call, 3);
    let view = store::view(&f.root, &id).unwrap();
    assert!(view["work"]["report"].is_object());
    assert!(store::records(&f.root, &id, "libraryRules", 10)
        .unwrap()
        .iter()
        .any(|r| r.to_string().contains("本库回答使用中文")));
    assert!(view["activity"]
        .to_string()
        .contains("已加载知识库工作规则"));
}

#[test]
fn rule_changes_during_model_work_block_stale_publication() {
    let (f, id, w, run) = setup();
    let path = f.vault.join("AGENTS.md");
    std::fs::write(&path, "第一版约定").unwrap();
    let result = execute(&f, &w, &run, |prompt, _| {
        let material = host(prompt);
        assert!(material["knowledgeRules"]
            .to_string()
            .contains("第一版约定"));
        std::fs::write(&path, "第二版约定").unwrap();
        Ok(answer(&material))
    });
    assert!(result.unwrap_err().contains("知识库规则已变化"));
    assert!(store::view(&f.root, &id).unwrap()["work"]["report"].is_null());
}

#[test]
#[ignore = "Opt-in: real Codex skill selection, synthetic data and local skill packages only"]
fn installed_native_agent_selects_hub_skills_and_restarts_after_reference_changes() {
    let mut cases = Vec::new();
    for name in ["simple", "automatic", "explicit", "unavailable"] {
        let (f, id, w, run) = setup();
        store::fail(&f.root, &w, &run, "fixture setup").unwrap();
        let directory = f.root.join("agent-skills/study-audit");
        std::fs::create_dir_all(directory.join("references")).unwrap();
        std::fs::write(directory.join("SKILL.md"),"---\nname: study-audit\ndescription: 学习审核方法：用户要求按当前学习审核方法核对并给出方法中的规则口令时使用，需读取配套参考。\nmetadata:\n  hub:\n    title: 学习审核方法\n---\n读取 references/check.md，回答其中的规则口令。口令属于方法检查项，不是用户原文证据，不要伪造来源引用。不要制作或保存任何业务草稿。\n").unwrap();
        std::fs::write(
            directory.join("references/check.md"),
            "本方法的规则口令为 HUB-SKILL-5381。只输出该口令。\n",
        )
        .unwrap();
        if name == "explicit" {
            std::fs::create_dir_all(directory.join("agents")).unwrap();
            std::fs::write(
                directory.join("agents/openai.yaml"),
                "policy:\n  allow_implicit_invocation: false\n",
            )
            .unwrap();
        }
        if name == "unavailable" {
            std::fs::create_dir_all(directory.join("agents")).unwrap();
            std::fs::write(
                directory.join("agents/openai.yaml"),
                "dependencies:\n  tools:\n    - type: mcp\n      value: external-terminal\n",
            )
            .unwrap();
        }
        let instruction=match name {
            "simple"=>"只回复收到两个字，不需要查找、技能、制作或保存。",
            "automatic"=>"请按当前可用的学习审核方法，给出方法中的规则口令。不要制作、修改或导入。",
            "explicit"=>"$study-audit 请给出此方法中的规则口令，不要制作或保存。",
            _=>"$study-audit 请使用这个方法。若其依赖当前不可用，直接说明具体原因，不必尝试替代或制作成果。",
        };
        ui(&f.root,&json!({"action":"message","id":id,"clientMessageId":format!("skills-{name}"),"text":instruction})).unwrap();
        options::configure(&f.root,&json!({"id":id,"options":{"model":crate::model_runtime::Settings::default(),"autoFlashcardInbox":false}})).unwrap();
        let result = ui(&f.root, &json!({"action":"respond","id":id,"mode":"deep"}));
        let view = store::view(&f.root, &id).unwrap();
        let calls = store::records(&f.root, &id, "toolCall", 64).unwrap();
        cases.push(json!({"case":name,"result":result,"view":view,"toolCalls":calls}));
        let save = |cases: &Vec<Value>| {
            if let Ok(report) = std::env::var("HUB_AGENT_SKILL_REPORT") {
                std::fs::write(
                    report,
                    serde_json::to_vec_pretty(&json!({"cases":cases})).unwrap(),
                )
                .unwrap();
            }
        };
        save(&cases);
        result.unwrap();
        let markdown = view["work"]["report"]["prose"]["markdown"]
            .as_str()
            .unwrap();
        if name == "simple" {
            assert_eq!(markdown.trim(), "收到");
            assert!(calls.is_empty());
        }
        if matches!(name, "automatic" | "explicit") {
            assert!(markdown.contains("HUB-SKILL-5381"), "{markdown}");
            assert!(calls
                .iter()
                .any(|c| c["operation"] == "loadSkill" && c["name"] == "study-audit"));
            assert!(calls.iter().any(|c| c["operation"] == "readSkillReference"));
        }
        assert!(view["actions"]["items"].as_array().unwrap().is_empty());
        if name == "automatic" {
            let first = store::records(&f.root, &id, "nativeSession", 1).unwrap()[0].clone();
            for (revision, text, changed) in [
                (
                    "same",
                    "继续只回答刚才方法的规则口令，不需要重新查找。",
                    false,
                ),
                (
                    "changed",
                    "请重新按当前学习审核方法读取规则口令，并只输出口令。",
                    true,
                ),
            ] {
                if changed {
                    std::fs::write(
                        directory.join("references/check.md"),
                        "本方法规则口令更新为 HUB-SKILL-9274。只输出该口令。\n",
                    )
                    .unwrap();
                }
                ui(&f.root,&json!({"action":"message","id":id,"clientMessageId":format!("skills-{revision}"),"text":text})).unwrap();
                let result = ui(&f.root, &json!({"action":"respond","id":id,"mode":"deep"}));
                let view = store::view(&f.root, &id).unwrap();
                let current = store::records(&f.root, &id, "nativeSession", 1).unwrap()[0].clone();
                cases.push(
                    json!({"case":revision,"result":result,"view":view,"nativeSession":current}),
                );
                save(&cases);
                result.unwrap();
                if changed {
                    assert_ne!(first["threadId"], current["threadId"]);
                    assert!(view["work"]["report"]["prose"]["markdown"]
                        .as_str()
                        .unwrap()
                        .contains("HUB-SKILL-9274"));
                } else {
                    assert_eq!(first["threadId"], current["threadId"]);
                }
            }
        }
    }
}

#[test]
fn archive_without_enough_budget_returns_feedback_and_keeps_a_final_answer_possible() {
    let (f, id, w, run) = setup();
    let mut limited = budget("quick").unwrap();
    limited.model_calls = 3;
    let mut call = 0;
    execute_budget(&f, &w, &run, limited, |prompt, _| {
        let material = host(prompt);
        let reply = if call == 0 {
            tools("先核对归档是否可行。", json!([{"operation":"prepareArchive","instruction":"准备归档","libraryId":"unavailable","baseActionId":null}]))
        } else {
            assert!(material["observations"].as_array().unwrap().iter().any(|item| item["error"].as_str().is_some_and(|error| error.contains("剩余预算不足"))));
            answer(&material)
        };
        call += 1;
        Ok(reply)
    }).unwrap();
    assert_eq!(call, 2);
    let view = store::view(&f.root, &id).unwrap();
    assert_eq!(view["work"]["state"], "completed");
    assert!(view["actions"]["items"].as_array().unwrap().is_empty());
    assert_eq!(view["run"]["usage"]["modelCalls"], 2);
}
#[test]
fn one_run_prepares_two_kinds_checks_actual_results_and_keeps_sources_unchanged() {
    let (f, id, w, run) = setup();
    let before = std::fs::read(f.vault.join("Learning.md")).unwrap();
    let mut call = 0;
    execute(&f,&w,&run,|p,s|{
        let m=host(p);
        assert!(s["properties"]["requests"]["items"]["anyOf"].as_array().unwrap().len()>2);
        let value=match call {
            0=>tools("先核对原文，再分别整理笔记与制作卡片。",json!([
                {"operation":"draftContext","kind":"flashcards","instruction":"准备一张主动回忆卡","target":"收件箱","baseActionId":null},
                {"operation":"draftContext","kind":"obsidianEdit","instruction":"增加一个清楚的标题，保留事实","target":"","baseActionId":null}])),
            1=>{
                let contexts=contexts(&m);assert_eq!(contexts.len(),2);
                tools("制作两种草稿，原文件保持待确认状态。",json!([
                    {"operation":"prepareDraft","contextId":contexts[0]["contextId"],"candidate":card("先理解材料，再合上原文主动回忆。")},
                    {"operation":"prepareDraft","contextId":contexts[1]["contextId"],"candidate":{"markdown":"# 学习方法\n先理解材料，再合上原文主动回忆。\n每张闪卡只考一个明确的问题，答案应自足。\n草稿先进入收件箱审核，检查准确并有原文依据后，才进入正式复习。\n","summary":"整理标题","warnings":[]}}]))
            },
            2=>{
                let prepared=drafts(&m);assert_eq!(prepared.len(),2);
                assert_eq!(prepared[0]["content"]["cards"].as_array().unwrap().len(),1);
                assert!(prepared[1]["content"]["after"].as_str().unwrap().starts_with("# 学习方法"));
                tools("已收到实际草稿，再检查内容与来源。",json!([
                    {"operation":"inspectDraft","actionId":prepared[0]["actionId"]},
                    {"operation":"inspectDraft","actionId":prepared[1]["actionId"]}]))
            },
            _=>answer(&m),
        };
        call+=1;Ok(value)
    }).unwrap();
    assert_eq!(call, 4);
    let view = store::view(&f.root, &id).unwrap();
    assert!(view["work"]["report"]["prose"]["markdown"]
        .as_str()
        .unwrap()
        .contains("| 成果 |"));
    assert_eq!(view["actions"]["items"].as_array().unwrap().len(), 2);
    assert!(view["actions"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|a| a["state"] == "prepared"));
    assert!(view["activity"][0]["events"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["label"] == "核对 1 张闪卡草稿"));
    assert_eq!(std::fs::read(f.vault.join("Learning.md")).unwrap(), before);
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM flashcard_drafts", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
#[test]
fn failed_candidate_is_observed_then_corrected_and_refined_in_the_same_run() {
    let (f, id, w, run) = setup();
    let mut call = 0;
    execute(&f,&w,&run,|p,_|{
        let m=host(p);
        let value=match call {
            0=>tools("先取得制作要求。",json!([{"operation":"draftContext","kind":"flashcards","instruction":"一张主动回忆卡","target":"收件箱","baseActionId":null}])),
            1=>tools("准备候选。",json!([{"operation":"prepareDraft","contextId":contexts(&m)[0]["contextId"],"candidate":card("不存在的引文")}])),
            2=>{
                assert!(m["observations"].as_array().unwrap().iter().any(|v|v["error"].as_str().is_some_and(|e|e.contains("引文"))));
                tools("引文校验未通过，改用实际原文。",json!([{"operation":"prepareDraft","contextId":contexts(&m)[0]["contextId"],"candidate":card("先理解材料，再合上原文主动回忆。")}]))
            },
            3=>tools("检查后调整提问方式。",json!([{"operation":"draftContext","kind":"flashcards","instruction":"让问题更简洁","target":"收件箱","baseActionId":drafts(&m)[0]["actionId"]}])),
            4=>{
                let mut candidate=card("先理解材料，再合上原文主动回忆。");candidate["cards"][0]["question"]=json!("主动回忆前先做什么？");
                tools("按新要求替换草稿。",json!([{"operation":"prepareDraft","contextId":contexts(&m).last().unwrap()["contextId"],"candidate":candidate}]))
            },
            _=>answer(&m),
        };call+=1;Ok(value)
    }).unwrap();
    let view = store::view(&f.root, &id).unwrap();
    assert_eq!(view["actions"]["items"][0]["state"], "prepared");
    assert_eq!(view["actions"]["items"][1]["state"], "superseded");
    assert!(view["actions"]["items"][1]["confirmationToken"].is_null());
    assert!(view["activity"][0]["events"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["state"] == "failed"));
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM agent_actions", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
}
#[test]
fn source_change_cancellation_and_forged_context_cannot_admit_a_draft() {
    let (f, _id, w, run) = setup();
    let context =
        actions::assistant::context(&f.root, &w, &run, "flashcards", "做一张卡", "收件箱", None)
            .unwrap();
    assert!(actions::assistant::prepare(
        &f.root,
        &w,
        &run,
        "forged",
        &card("先理解材料，再合上原文主动回忆。"),
        &json!({}),
        &Control::default()
    )
    .is_err());
    // Flashcard evidence is the indexed source version. Commit the changed
    // source through its normal producer rather than only changing the file.
    f.seed("Learning.md", "外部修改");
    assert!(actions::assistant::prepare(
        &f.root,
        &w,
        &run,
        context["contextId"].as_str().unwrap(),
        &card("先理解材料，再合上原文主动回忆。"),
        &json!({}),
        &Control::default()
    )
    .is_err());
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM agent_actions", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    let (f, _id, w, run) = setup();
    let control = Control::default();
    let session = Session {
        root: &f.root,
        work: &w,
        run: &run,
        control: &control,
        operation: None,
        selection: json!({}),
        app: None,
    };
    let result = runner::investigate_assistant(
        &f.root,
        &w,
        &run,
        &control,
        budget("quick").unwrap(),
        &session,
        |_, _| {
            control.cancel();
            Ok(tools(
                "准备卡片。",
                json!([{"operation":"draftContext","kind":"flashcards","instruction":"做卡","target":"收件箱","baseActionId":null}]),
            ))
        },
    );
    assert!(result.is_err());
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM agent_actions", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
#[test]
fn simple_answer_has_no_forced_plan_or_tools_and_unknown_citations_fail_closed() {
    let (f, id, w, run) = setup();
    execute(&f, &w, &run, |p, _| Ok(answer(&host(p)))).unwrap();
    let view = store::view(&f.root, &id).unwrap();
    assert_eq!(view["run"]["usage"]["modelCalls"], 1);
    assert!(view["actions"]["items"].as_array().unwrap().is_empty());
    let activity = view["activity"].as_array().unwrap().last().unwrap();
    assert_eq!(activity["steps"], 0);
    assert!(activity["events"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["kind"] == "context" && e["origin"] == "hub-context"));
    let wrong = json!({"rationale":"","requests":[],"report":{"status":"completed","markdown":"结论[2]","citations":[{"quoteId":"e1:q1"}],"questions":[],"limitations":[],"waitCondition":""}});
    assert!(normalize(
        wrong,
        &json!([{"quoteId":"e1:q1","evidenceId":"e1","text":"原文"}])
    )
    .is_err());
}
#[test]
fn explicit_import_choice_uses_exact_draft_and_retry_returns_the_existing_receipt() {
    let (f, id, old, old_run) = setup();
    store::fail(&f.root, &old, &old_run, "fixture setup").unwrap();
    ui(&f.root,&json!({"action":"message","id":id,"clientMessageId":"import-intent","text":"制作一张闪卡，并按本对话授权导入收件箱。"})).unwrap();
    options::configure(&f.root,&json!({"id":id,"options":{"model":null,"autoFlashcardInbox":true},"confirmedAutoInbox":true})).unwrap();
    let run = format!("test-auto-{}", crate::random_url_safe(8));
    let w = store::claim(&f.root, &id, &run).unwrap();
    store::record(
        &f.root,
        &run,
        "agentProtocol",
        &json!({"version":1,"options":options::load(&f.root,&id).unwrap()}),
    )
    .unwrap();
    let mut call = 0;
    execute(&f,&w,&run,|p,_|{
        let m=host(p);
        let value=match call{
            0=>tools("先读取制卡要求。",json!([{"operation":"draftContext","kind":"flashcards","instruction":"制作一张主动回忆卡","target":"收件箱","baseActionId":null}])),
            1=>tools("准备有原文依据的卡片。",json!([{"operation":"prepareDraft","contextId":contexts(&m)[0]["contextId"],"candidate":card("先理解材料，再合上原文主动回忆。")}])) ,
            2=>tools("按本轮要求导入这份草稿。",json!([{"operation":"importFlashcards","actionId":drafts(&m)[0]["actionId"]}])),
            3=>{
                assert!(m["observations"].as_array().unwrap().iter().any(|o|o["imported"]==true));
                tools("核对同一导入请求的回执。",json!([{"operation":"importFlashcards","actionId":drafts(&m)[0]["actionId"]}]))
            },
            _=>{
                assert!(m["observations"].as_array().unwrap().iter().any(|o|o["alreadyImported"]==true));
                let mut reply=answer(&m);reply["report"]["markdown"]=json!("已按本对话授权导入闪卡收件箱，等待审核。[1]");reply
            }
        };call+=1;Ok(value)
    }).unwrap();
    assert_eq!(call, 5);
    let view = store::view(&f.root, &id).unwrap();
    assert_eq!(view["actions"]["items"][0]["state"], "verified");
    assert!(view["work"]["report"].is_object());
    assert_eq!(
        f.c()
            .query_row(
                "SELECT COUNT(*) FROM flashcard_drafts WHERE status='pending'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM flashcards", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn preview_with_inbox_permission_never_imports_as_a_side_effect_of_finishing() {
    let (f, id, old, old_run) = setup();
    store::fail(&f.root, &old, &old_run, "fixture setup").unwrap();
    options::configure(&f.root,&json!({"id":id,"options":{"model":null,"autoFlashcardInbox":true},"confirmedAutoInbox":true})).unwrap();
    let run = format!("test-preview-{}", crate::random_url_safe(8));
    let w = store::claim(&f.root, &id, &run).unwrap();
    store::record(
        &f.root,
        &run,
        "agentProtocol",
        &json!({"version":1,"options":options::load(&f.root,&id).unwrap()}),
    )
    .unwrap();
    let mut call = 0;
    execute(&f,&w,&run,|p,_|{
        let m=host(p);
        let reply=match call {
            0=>tools("只准备预览。",json!([{"operation":"draftContext","kind":"flashcards","instruction":"只预览一张主动回忆卡","target":"收件箱","baseActionId":null}])),
            1=>tools("提交草稿。",json!([{"operation":"prepareDraft","contextId":contexts(&m)[0]["contextId"],"candidate":card("先理解材料，再合上原文主动回忆。")}])) ,
            _=>answer(&m)
        };
        call+=1;Ok(reply)
    }).unwrap();
    assert_eq!(
        call, 3,
        "finishing must not insert an extra import/repair model turn"
    );
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM flashcard_drafts", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    let view = store::view(&f.root, &id).unwrap();
    assert_eq!(view["actions"]["items"][0]["state"], "prepared");
    assert!(view["activity"][0]["events"]
        .as_array()
        .unwrap()
        .iter()
        .all(|e| !e["label"].as_str().unwrap_or_default().contains("已导入")));
}

#[test]
fn import_tool_rejects_missing_grant_and_old_run_draft_without_writing() {
    let (f, id, w, run) = setup();
    let mut call = 0;
    execute(&f,&w,&run,|p,_|{
        let m=host(p);
        let reply=match call {
            0=>tools("读取材料。",json!([{"operation":"draftContext","kind":"flashcards","instruction":"一张卡","target":"收件箱","baseActionId":null}])),
            1=>tools("准备草稿。",json!([{"operation":"prepareDraft","contextId":contexts(&m)[0]["contextId"],"candidate":card("先理解材料，再合上原文主动回忆。")}])) ,
            2=>tools("尝试导入。",json!([{"operation":"importFlashcards","actionId":drafts(&m)[0]["actionId"]}])),
            _=>{
                assert!(m["observations"].as_array().unwrap().iter().any(|o|o["error"].as_str().is_some_and(|s|s.contains("未授权"))));
                answer(&m)
            }
        };
        call+=1;Ok(reply)
    }).unwrap();
    let action = store::view(&f.root, &id).unwrap()["actions"]["items"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    options::configure(&f.root,&json!({"id":id,"options":{"model":null,"autoFlashcardInbox":true},"confirmedAutoInbox":true})).unwrap();
    let later = format!("test-later-{}", crate::random_url_safe(8));
    let next = store::claim(&f.root, &id, &later).unwrap();
    store::record(
        &f.root,
        &later,
        "agentProtocol",
        &json!({"version":1,"options":options::load(&f.root,&id).unwrap()}),
    )
    .unwrap();
    assert!(actions::assistant::import_flashcards(
        &f.root,
        &next,
        &later,
        &action,
        &Control::default()
    )
    .unwrap_err()
    .contains("本轮"));
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM flashcard_drafts", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
#[test]
#[ignore = "Opt-in: actual provider performs compound drafting through the production assistant"]
fn installed_provider_workbench() {
    let (f, id, w, run) = setup();
    store::fail(&f.root, &w, &run, "fixture setup, no model invoked").unwrap();
    let started = std::time::Instant::now();
    let view = ui(&f.root, &json!({"action":"respond","id":id,"mode":"deep"})).unwrap();
    if let Ok(path) = std::env::var("HUB_AGENT_WORKBENCH_REPORT") {
        std::fs::write(path,serde_json::to_vec_pretty(&json!({"view":view,"durationMs":started.elapsed().as_millis(),"isolation":"synthetic note; no original-source or remote writes"})).unwrap()).unwrap();
    }
    let items = view["actions"]["items"].as_array().unwrap();
    assert!(items
        .iter()
        .any(|a| a["kind"] == "flashcardDrafts" && a["state"] == "prepared"));
    assert!(items
        .iter()
        .any(|a| a["kind"] == "obsidianEdit" && a["state"] == "prepared"));
    assert!(view["work"]["report"]["prose"]["markdown"].is_string());
    assert!(
        view["activity"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["native"] == true)
            || view["run"]["usage"]["modelCalls"].as_u64().unwrap() > 2
    );
    assert_eq!(std::fs::read_to_string(f.vault.join("Learning.md")).unwrap(),"# 主动回忆\n先理解材料，再合上原文主动回忆。\n每张闪卡只考一个明确的问题，答案应自足。\n草稿先进入收件箱审核，检查准确并有原文依据后，才进入正式复习。\n");
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM flashcard_drafts", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn native_stream_updates_are_durable_monotonic_and_rejected_after_stop() {
    let (f, id, w, run) = setup();
    let control = Control::default();
    let event =
        json!({"id":"reasoning-1:0","kind":"reasoning","text":"核对原文","state":"running"});
    store::stream(&f.root, &w, &run, &event, &control).unwrap();
    let first = store::view(&f.root, &id).unwrap();
    let initial_time = first["activity"][0]["events"][0]["createdAt"].clone();
    let initial_sequence = first["activity"][0]["events"][0]["sequence"].clone();
    store::stream(&f.root,&w,&run,&json!({"id":"later-command","kind":"tool","operation":"command","text":"运行命令","state":"completed"}),&control).unwrap();
    let mut updated = event.clone();
    updated["text"] = json!("核对原文后再检查草稿");
    updated["state"] = json!("completed");
    store::stream(&f.root, &w, &run, &updated, &control).unwrap();
    let second = store::view(&f.root, &id).unwrap();
    assert!(second["recordVersion"].as_i64() > first["recordVersion"].as_i64());
    let stream = second["activity"][0]["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["kind"] == "reasoning")
        .collect::<Vec<_>>();
    assert_eq!(stream.len(), 1);
    assert_eq!(stream[0]["label"], "核对原文后再检查草稿");
    assert_eq!(stream[0]["createdAt"], initial_time);
    assert_eq!(stream[0]["sequence"], initial_sequence);
    assert!(stream[0]["finishedAt"].as_i64().unwrap() >= initial_time.as_i64().unwrap());
    let ordered = second["activity"][0]["events"].as_array().unwrap();
    assert!(ordered[0]["sequence"].as_i64().unwrap() < ordered[1]["sequence"].as_i64().unwrap());
    store::stream(&f.root, &w, &run, &event, &control).unwrap();
    let after_late_start = store::view(&f.root, &id).unwrap();
    assert_eq!(
        after_late_start["activity"][0]["events"],
        second["activity"][0]["events"]
    );
    assert!(store::stream(
        &f.root,
        &w,
        &run,
        &json!({"id":"private","kind":"rawReasoning","text":"PRIVATE"}),
        &control
    )
    .is_err());
    control.cancel();
    assert!(store::stream(&f.root, &w, &run, &event, &control).is_err());
    store::fail(&f.root, &w, &run, "stopped").unwrap();
    assert!(store::stream(&f.root, &w, &run, &event, &Control::default()).is_err());
}

#[test]
fn display_retention_does_not_stop_execution_or_final_delivery_records() {
    let (f, id, w, run) = setup();
    let control = Control::default();
    let pending = json!({"id":"pending","kind":"tool","operation":"command","text":"尚在运行","state":"running"});
    store::stream(&f.root, &w, &run, &pending, &control).unwrap();
    for index in 0..24 {
        store::stream(&f.root,&w,&run,&json!({"id":format!("display-{index}"),"kind":"message","text":"x".repeat(30_000),"state":"completed"}),&control).unwrap();
    }
    store::stream(&f.root, &w, &run, &pending, &control).unwrap();
    let during = store::view(&f.root, &id).unwrap();
    let pending_event = during["activity"][0]["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["label"] == "尚在运行")
        .unwrap();
    assert!(pending_event["finishedAt"].is_null());
    let mut completed = pending.clone();
    completed["state"] = json!("completed");
    store::stream(&f.root, &w, &run, &completed, &control).unwrap();
    store::record(
        &f.root,
        &run,
        "nativeFinal",
        &json!({"text":"最后答复仍可完整保存"}),
    )
    .unwrap();
    let view = store::view(&f.root, &id).unwrap();
    assert!(view["activity"][0]["events"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["origin"] == "hub-display-limit" && e["truncated"] == true));
    assert!(
        store::records(&f.root, &id, "nativeFinal", 1).unwrap()[0]["text"]
            .as_str()
            .unwrap()
            .contains("完整保存")
    );
}

#[test]
fn steering_binds_exact_run_and_identity_and_survives_without_changing_revision() {
    let (f, id, w, run) = setup();
    let message = json!({"action":"steer","id":id,"runId":run,"clientMessageId":"steer-one","text":"补充核对审核条件"});
    assert!(ui(&f.root, &message).is_err());
    store::record(&f.root, &run, "nativeRuntime", &json!({"protocol":1})).unwrap();
    ui(&f.root, &message).unwrap();
    ui(&f.root, &message).unwrap();
    let view = store::view(&f.root, &id).unwrap();
    assert_eq!(view["work"]["revision"], w.revision);
    assert_eq!(
        store::records(&f.root, &id, "steering", 32).unwrap().len(),
        1
    );
    assert!(view["conversation"]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|m| m["text"] == "补充核对审核条件"));
    let mut changed = message.clone();
    changed["text"] = json!("另一要求");
    assert!(ui(&f.root, &changed).is_err());
    let mut wrong = message.clone();
    wrong["clientMessageId"] = json!("wrong");
    wrong["runId"] = json!("other");
    assert!(ui(&f.root, &wrong).is_err());
    store::fail(&f.root, &w, &run, "stopped").unwrap();
    changed["clientMessageId"] = json!("late");
    assert!(ui(&f.root, &changed).is_err());
}

#[test]
#[ignore = "Opt-in: real Codex native agent, isolated synthetic note, drafts only"]
fn installed_native_agent_continuity_and_steering() {
    let (f, id, w, run) = setup();
    store::fail(&f.root, &w, &run, "fixture setup").unwrap();
    options::configure(&f.root,&json!({"id":id,"options":{"model":crate::model_runtime::Settings::default(),"autoFlashcardInbox":false}})).unwrap();
    let root = f.root.clone();
    let work = id.clone();
    let task =
        std::thread::spawn(move || ui(&root, &json!({"action":"respond","id":work,"mode":"deep"})));
    let started = std::time::Instant::now();
    let mut sent = false;
    let mut live = false;
    let mut observations = Vec::new();
    while !task.is_finished() {
        if let Ok(view) = store::view(&f.root, &id) {
            if let Some(active) = view["activity"]
                .as_array()
                .and_then(|runs| runs.last())
                .filter(|r| r["running"] == true && r["native"] == true)
            {
                live |= active["events"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|e| e["kind"] == "message" || e["kind"] == "reasoning");
                if !sent {
                    let steer = json!({"action":"steer","id":id,"runId":active["runId"],"clientMessageId":"native-live-steer","text":"补充要求：最终正文以“测试核对结果”开头。继续完成原来的笔记修改和两张闪卡草稿，并检查。"});
                    if ui(&f.root, &steer).is_ok() {
                        sent = true;
                    }
                }
                observations.push(json!({"elapsedMs":started.elapsed().as_millis(),"events":active["events"].as_array().unwrap().len(),"publicStreamBeforeCompletion":live}));
            }
        }
        assert!(started.elapsed() < Duration::from_secs(910));
        std::thread::sleep(Duration::from_millis(200));
    }
    let result = task.join().unwrap();
    let first = store::view(&f.root, &id).unwrap();
    let save = |name: &str, value: &Value| {
        if let Ok(directory) = std::env::var("HUB_AGENT_NATIVE_REPORT") {
            std::fs::create_dir_all(&directory).unwrap();
            std::fs::write(
                Path::new(&directory).join(name),
                serde_json::to_vec_pretty(value).unwrap(),
            )
            .unwrap();
        }
    };
    save(
        "native-first.json",
        &json!({"result":result,"view":first,"live":live,"steered":sent,"observations":observations,
            "nativeFinal":store::records(&f.root,&id,"nativeFinal",4).unwrap(),"protocol":store::records(&f.root,&id,"nativeProtocol",32).unwrap()}),
    );
    result.unwrap();
    assert!(live && sent);
    assert!(first["work"]["report"]["prose"]["markdown"]
        .as_str()
        .unwrap()
        .starts_with("测试核对结果"));
    assert!(first["actions"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|a| a["kind"] == "flashcardDrafts" && a["state"] == "prepared"));
    assert!(first["actions"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|a| a["kind"] == "obsidianEdit" && a["state"] == "prepared"));
    ui(&f.root,&json!({"action":"message","id":id,"clientMessageId":"native-next","text":"继续刚才的草稿，把两张闪卡合并成一张，并检查新草稿。不要保存或导入。"})).unwrap();
    let second_result = ui(&f.root, &json!({"action":"respond","id":id,"mode":"deep"}));
    let second = store::view(&f.root, &id).unwrap();
    save(
        "native-second.json",
        &json!({"result":second_result,"view":second}),
    );
    second_result.unwrap();
    assert_eq!(
        second["activity"].as_array().unwrap().last().unwrap()["native"],
        true
    );
    assert_eq!(
        store::records(&f.root, &id, "nativeRuntime", 1).unwrap()[0]["resumed"],
        true
    );
    let cards = second["actions"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|a| a["kind"] == "flashcardDrafts" && a["state"] == "prepared")
        .collect::<Vec<_>>();
    assert_eq!(cards.len(), 1);
    assert_eq!(cards[0]["payload"]["cards"].as_array().unwrap().len(), 1);
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM flashcard_drafts", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(std::fs::read_to_string(f.vault.join("Learning.md")).unwrap(),"# 主动回忆\n先理解材料，再合上原文主动回忆。\n每张闪卡只考一个明确的问题，答案应自足。\n草稿先进入收件箱审核，检查准确并有原文依据后，才进入正式复习。\n");
    assert!(!f
        .root
        .join("agent-runtime")
        .join(&id)
        .join("home/auth.json")
        .exists());
    ui(&f.root,&json!({"action":"message","id":id,"clientMessageId":"native-stop","text":"继续逐项核对这篇笔记和刚才的闪卡草稿，先说明核对计划，再重新读取并检查，不执行保存。"})).unwrap();
    let root = f.root.clone();
    let work = id.clone();
    let stopping =
        std::thread::spawn(move || ui(&root, &json!({"action":"respond","id":work,"mode":"deep"})));
    let wait = std::time::Instant::now();
    let mut cancelled = false;
    while !stopping.is_finished() {
        {
            let view = store::view(&f.root, &id).unwrap();
            let bound:bool=f.c().query_row("SELECT EXISTS(SELECT 1 FROM agent_records WHERE run_id=?1 AND kind='nativeTurn')",[view["run"]["id"].as_str().unwrap_or_default()],|r|r.get(0)).unwrap();
            if view["activity"]
                .as_array()
                .unwrap()
                .last()
                .is_some_and(|a| a["running"] == true && a["native"] == true)
                && bound
            {
                ui(&f.root, &json!({"action":"cancel","id":id,"commandId":"native-stop",
                    "expectedControlRevision":view["lifecycle"]["controlRevision"],"expectedWorkRevision":view["work"]["revision"],
                    "expectedRunId":view["lifecycle"]["activeRunId"]})).unwrap();
                cancelled = true;
                break;
            }
        }
        assert!(wait.elapsed() < Duration::from_secs(40));
        std::thread::sleep(Duration::from_millis(100));
    }
    let cancelled_at = std::time::Instant::now();
    let stopped = stopping.join().unwrap();
    assert!(cancelled && stopped.is_err());
    assert!(cancelled_at.elapsed() < Duration::from_secs(10));
    let view = store::view(&f.root, &id).unwrap();
    save(
        "native-stopped.json",
        &json!({"result":stopped,"view":view,"shutdownMs":cancelled_at.elapsed().as_millis()}),
    );
    assert_eq!(status(&f.root, &id).unwrap()["runActive"], false);
    let resumed = ui(
        &f.root,
        &json!({"action":"resume","id":id,"mode":"deep","commandId":"native-resume",
        "expectedControlRevision":view["lifecycle"]["controlRevision"],"expectedWorkRevision":view["work"]["revision"],
        "expectedRunId":view["lifecycle"]["activeRunId"]}),
    );
    let view = store::view(&f.root, &id).unwrap();
    save(
        "native-resumed.json",
        &json!({"result":resumed,"view":view}),
    );
    resumed.unwrap();
    assert_eq!(view["work"]["state"], "completed");
    assert!(!f
        .root
        .join("agent-runtime")
        .join(&id)
        .join("home/auth.json")
        .exists());
}

#[test]
#[ignore = "Opt-in: real Codex autonomy cases, synthetic notes and isolated inbox only"]
fn installed_native_agent_chooses_tools_from_intent_instead_of_a_fixed_workflow() {
    let mut cases = Vec::new();
    for (name, instruction, allow_import) in [
        (
            "simple",
            "只回复“收到”这两个字，不需要查找、制作、检查或导入任何内容。",
            false,
        ),
        (
            "read-tail",
            "请找到这篇笔记文末新增的复习审核码，只回答该码并引用原句。不要制作草稿或导入。",
            false,
        ),
        (
            "preview",
            "根据当前笔记制作一张中文问答闪卡，并检查。只预览，不要导入。",
            true,
        ),
        (
            "import",
            "根据当前笔记制作一张中文问答闪卡，检查后按本对话授权导入收件箱。",
            true,
        ),
    ] {
        let (f, id, w, run) = setup();
        store::fail(&f.root, &w, &run, "fixture setup").unwrap();
        if name == "read-tail" {
            let text = format!(
                "# 主动回忆\n{}\n补充规则：复习审核码为 HUB-TAIL-8427。\n",
                "阅读背景说明。".repeat(1100)
            );
            f.seed("Learning.md", &text);
        }
        ui(&f.root,&json!({"action":"message","id":id,"clientMessageId":format!("autonomy-{name}"),"text":instruction})).unwrap();
        options::configure(&f.root,&json!({"id":id,"options":{"model":crate::model_runtime::Settings::default(),"autoFlashcardInbox":allow_import},"confirmedAutoInbox":allow_import})).unwrap();
        let outcome = ui(&f.root, &json!({"action":"respond","id":id,"mode":"deep"}));
        let view = store::view(&f.root, &id).unwrap();
        let calls = store::records(&f.root, &id, "toolCall", 64).unwrap();
        let inbox: i64 = f
            .c()
            .query_row("SELECT COUNT(*) FROM flashcard_drafts", [], |r| r.get(0))
            .unwrap();
        let case = json!({"case":name,"request":instruction,"result":outcome,"toolCalls":calls,"inboxDrafts":inbox,"view":view});
        cases.push(case);
        if let Ok(directory) = std::env::var("HUB_AGENT_NATIVE_REPORT") {
            std::fs::create_dir_all(&directory).unwrap();
            std::fs::write(
                Path::new(&directory).join("native-autonomy.json"),
                serde_json::to_vec_pretty(&json!({"cases":cases})).unwrap(),
            )
            .unwrap();
        }
        outcome.unwrap();
        let markdown = view["work"]["report"]["prose"]["markdown"]
            .as_str()
            .unwrap();
        match name {
            "simple" => {
                assert_eq!(markdown.trim(), "收到");
                assert!(calls.is_empty());
                assert_eq!(
                    view["activity"].as_array().unwrap().last().unwrap()["steps"],
                    0
                );
                assert!(view["actions"]["items"].as_array().unwrap().is_empty());
            }
            "read-tail" => {
                assert!(markdown.contains("HUB-TAIL-8427"));
                assert!(calls.iter().any(|c| c["operation"] == "read"));
                assert!(view["actions"]["items"].as_array().unwrap().is_empty());
            }
            "preview" => {
                assert_eq!(inbox, 0);
                assert!(calls.iter().all(|c| c["operation"] != "importFlashcards"));
                assert!(view["actions"]["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|a| a["kind"] == "flashcardDrafts" && a["state"] == "prepared"));
            }
            "import" => {
                assert_eq!(inbox, 1);
                assert_eq!(
                    calls
                        .iter()
                        .filter(|c| c["operation"] == "importFlashcards")
                        .count(),
                    1
                );
                assert!(view["actions"]["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|a| a["kind"] == "flashcardDrafts" && a["state"] == "verified"));
            }
            _ => unreachable!(),
        }
        if name != "import" {
            assert_eq!(inbox, 0);
        }
        assert_eq!(
            f.c()
                .query_row("SELECT COUNT(*) FROM flashcards", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert!(!f
            .root
            .join("agent-runtime")
            .join(&id)
            .join("home/auth.json")
            .exists());
    }
}
