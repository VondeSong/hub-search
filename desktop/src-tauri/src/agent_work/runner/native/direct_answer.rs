//! An ordinary native reply is deliverable text, never proof of task or business completion.
use super::*;

// Only positively identified observation tools can use plain native delivery.
pub(super) fn requires_structured_delivery(tool: &Tool) -> bool {
    // These host-owned capabilities use the same scoped evidence reader as Read/Search.
    // Remote annotations and unknown capabilities are not authority to bypass delivery checks.
    if let Tool::Capability { name, .. } = tool {
        if matches!(
            name.as_str(),
            "hub_read_note"
                | "hub_search_notes"
                | "hub_list_note_sources"
                | "hub_read_analysis_snapshot"
        ) {
            return false;
        }
    }
    !matches!(
        tool,
        Tool::Search { .. }
            | Tool::Read { .. }
            | Tool::LoadSkill { .. }
            | Tool::ReadSkillReference { .. }
            | Tool::TraceResult { .. }
            | Tool::ToolSchema { .. }
            | Tool::GoalState { .. }
    )
}

#[derive(Default)]
pub(super) struct Answer {
    text: Option<String>,
}
impl Answer {
    pub(super) fn observe(&mut self, kind: &str, value: &Value) {
        if kind == "finalMessage" {
            self.text = value["text"].as_str().map(str::to_owned);
        } else if matches!(
            kind,
            "started" | "steered" | "userInputSent" | "tool" | "toolReplay" | "contextLifecycle"
        ) || (kind == "event" && value["kind"] == "webSearch")
        {
            self.text = None;
        }
    }
    #[cfg(test)]
    pub(super) fn prepare(
        &self,
        structured_tools: usize,
        finish_attempts: usize,
        web_accessed: &HashSet<String>,
    ) -> Result<Option<Report>, String> {
        self.prepare_cited(
            structured_tools,
            finish_attempts,
            web_accessed,
            &json!([]),
            &[],
        )
    }
    pub(super) fn prepare_cited(
        &self,
        structured_tools: usize,
        finish_attempts: usize,
        web_accessed: &HashSet<String>,
        citations: &Value,
        excerpts: &[EvidenceExcerpt],
    ) -> Result<Option<Report>, String> {
        // Inherited evidence is revalidated by publish; a business/unknown tool or rejected finish still requires Hub proof.
        if structured_tools > 0 || finish_attempts > 0 {
            return Ok(None);
        }
        let Some(text) = self.text.as_deref().filter(|s| !s.trim().is_empty()) else {
            return Ok(None);
        };
        let mut value = assistant::normalize(
            json!({"rationale":"","requests":[],"report":{"status":"completed","markdown":text,"citations":citations,"questions":[],"limitations":[],"waitCondition":"","completion":null}}),
            &json!(quotes::catalog(excerpts)),
        )?;
        let web_sources = web::from_markdown(text, web_accessed);
        if !web_sources.is_empty() {
            value["report"]["prose"]["webSources"] = json!(web_sources);
        }
        let report: Report =
            serde_json::from_value(value["report"].clone()).map_err(|_| "原生答复格式无效")?;
        validate(&report, excerpts)?;
        Ok(Some(report))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_web_link_metadata_is_attached_to_the_final_saved_report() {
        let report =
            answer("参考[官方文档](https://learn.chatgpt.com/docs/app-server#core-primitives)")
                .prepare(
                    0,
                    0,
                    &HashSet::from(["https://developers.openai.com/codex/app-server/".to_string()]),
                )
                .unwrap()
                .unwrap();
        let saved = json!(report);
        assert_eq!(
            saved["prose"]["webSources"][0]["provenance"],
            "modelReference"
        );
        assert!(saved["prose"]["citations"].as_array().unwrap().is_empty());
    }
    fn answer(text: &str) -> Answer {
        let mut a = Answer::default();
        a.observe("finalMessage", &json!({"text":text}));
        a
    }
    #[test]
    fn native_citation_binding_delivers_prose_without_goal_assessment() {
        let f = crate::source_evidence::tests::Fixture::new();
        f.note("notes", "current", "已确认数量为七件。");
        let id = crate::agent_work::tests::create(&f, false);
        let (work, _) = crate::agent_work::tests::claim(&f, &id);
        let evidence = work
            .grant
            .reader(&f.root)
            .unwrap()
            .read(work.anchor.as_ref().unwrap(), 0, 6000, None)
            .unwrap();
        let excerpts = vec![evidence];
        let catalog = json!(quotes::catalog(&excerpts));
        let chosen = json!([{"quoteId":catalog[0]["quoteId"]}]);
        let report = answer("已确认七件。[1]")
            .prepare_cited(0, 0, &HashSet::new(), &chosen, &excerpts)
            .unwrap()
            .unwrap();
        assert!(report.completion.is_none());
        assert_eq!(report.prose.unwrap().citations.len(), 1);
        assert!(answer("未知[2]")
            .prepare_cited(0, 0, &HashSet::new(), &chosen, &excerpts)
            .is_err());
        assert!(answer("旧编号[1]")
            .prepare_cited(
                0,
                0,
                &HashSet::new(),
                &json!([{"quoteId":"missing"}]),
                &excerpts
            )
            .is_err());
        assert!(answer("不可绕过业务核验")
            .prepare_cited(1, 0, &HashSet::new(), &chosen, &excerpts)
            .unwrap()
            .is_none());
    }
    #[test]
    fn native_chat_empty_criteria_retains_only_the_user_request() {
        let f = crate::source_evidence::tests::Fixture::new();
        let created=crate::agent_work::ui(&f.root,&json!({"action":"create","anchor":null,"grant":Grant::default(),"goal":"解释概念","successCriteria":""})).unwrap();
        let id = created["work"]["id"].as_str().unwrap();
        let work = store::load(&f.c(), id).unwrap();
        assert!(work.success_criteria.is_empty());
        let sources = store::goal::completion::sources_on(&f.c(), &work).unwrap();
        assert_eq!(sources.as_array().unwrap().len(), 1);
        assert_eq!(sources[0]["text"], "解释概念");
    }
    #[test]
    fn native_readonly_delivery_preserves_proof_boundaries() {
        for name in [
            "hub_read_note",
            "hub_search_notes",
            "hub_list_note_sources",
            "hub_read_analysis_snapshot",
        ] {
            assert!(!requires_structured_delivery(&Tool::Capability {
                name: name.into(),
                arguments: json!({})
            }));
        }
        assert!(requires_structured_delivery(&Tool::Capability {
            name: "hub_create_analysis_snapshot".into(),
            arguments: json!({})
        }));
        assert!(!requires_structured_delivery(&Tool::GoalState {}));
        assert!(!requires_structured_delivery(&Tool::Search {
            source_kind: "note".into(),
            query: "example".into(),
            limit: 3
        }));
        assert!(requires_structured_delivery(&Tool::Capability {
            name: "unknown".into(),
            arguments: json!({})
        }));
        assert!(requires_structured_delivery(&Tool::WorkingState {
            request: json!({})
        }));
        assert!(answer("只读说明")
            .prepare(0, 0, &HashSet::new())
            .unwrap()
            .is_some());
        assert!(answer("不能绕过被拒交付")
            .prepare(0, 1, &HashSet::new())
            .unwrap()
            .is_none());
        assert!(answer("伪造编号 [1]")
            .prepare(0, 0, &HashSet::new())
            .is_err());
    }
    #[test]
    fn cn05_direct_answer_does_not_bypass_rejected_finish_or_citation_checks() {
        let a = answer("普通说明");
        let seen = HashSet::new();
        for (tools, finishes) in [(1, 0), (0, 1)] {
            assert!(a.prepare(tools, finishes, &seen).unwrap().is_none());
        }
        assert!(a.prepare(0, 0, &seen).unwrap().is_some());
        assert!(answer("未经核对的原文 [1]").prepare(0, 0, &seen).is_err());
    }
    #[test]
    fn cn05_old_final_is_invalidated_by_new_input_material_and_turn() {
        for (kind, value) in [
            ("started", json!({})),
            ("steered", json!({})),
            ("userInputSent", json!({})),
            ("tool", json!({})),
            ("toolReplay", json!({})),
            ("contextLifecycle", json!({})),
            ("event", json!({"kind":"webSearch"})),
        ] {
            let mut a = answer("旧答复");
            a.observe(kind, &value);
            assert!(a.prepare(0, 0, &HashSet::new()).unwrap().is_none());
            a.observe("finalMessage", &json!({"text":"新答复"}));
            assert_eq!(
                a.prepare(0, 0, &HashSet::new()).unwrap().unwrap().summary,
                "新答复"
            );
        }
    }
    #[test]
    fn cn05_long_direct_answer_publishes_reopens_and_does_not_claim_business_completion() {
        let f = crate::source_evidence::tests::Fixture::new();
        f.note("notes", "current", "本地原文");
        let id = crate::agent_work::tests::create(&f, false);
        let (work, run) = crate::agent_work::tests::claim(&f, &id);
        store::record(&f.root, &run, "agentProtocol", &json!({"version":1})).unwrap();
        store::record(&f.root, &run, "nativeRuntime", &json!({"protocol":1})).unwrap();
        let text = format!("{}最后一句完整保留", "中文🙂".repeat(7000));
        store::record(&f.root, &run, "nativeFinal", &json!({"text":text})).unwrap();
        let report = answer(&text)
            .prepare(0, 0, &HashSet::new())
            .unwrap()
            .unwrap();
        let assessment = store::goal::accept_report(
            &f.root,
            &work,
            &run,
            &report,
            &store::goal::for_run(&f.root, &work, &run).unwrap(),
        )
        .unwrap();
        assert_eq!(assessment["semanticChecks"], "notProvided");
        assert_ne!(assessment["workFulfillment"], "fulfilled");
        store::publish(
            &f.root,
            &work,
            &run,
            &report,
            &[],
            &[],
            &json!([]),
            &Value::Null,
            &Control::default(),
        )
        .unwrap();
        let view = store::view(&f.root, &id).unwrap();
        assert_eq!(view["work"]["report"]["prose"]["markdown"], text);
        assert_ne!(view["goalAssessment"]["workFulfillment"], "fulfilled");
        assert_eq!(
            f.c()
                .query_row(
                    "SELECT count(*) FROM agent_actions WHERE work_id=?1",
                    [&id],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert!(view["activity"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["events"]
                .as_array()
                .unwrap()
                .iter()
                .all(|e| e["kind"] != "unpublishedAnswer")));
    }
    #[test]
    fn cn05_over_limit_answer_is_explicit_and_failed_body_remains_visible() {
        let f = crate::source_evidence::tests::Fixture::new();
        f.note("notes", "current", "原文");
        let id = crate::agent_work::tests::create(&f, false);
        let (w, run) = crate::agent_work::tests::claim(&f, &id);
        store::record(&f.root, &run, "agentProtocol", &json!({"version":1})).unwrap();
        let text = "原".repeat(super::super::super::ANSWER_CHARS + 1);
        store::record(&f.root, &run, "nativeFinal", &json!({"text":text})).unwrap();
        assert!(answer(&text).prepare(0, 0, &HashSet::new()).is_err());
        store::fail(&f.root, &w, &run, "答复超过交付上限，原始答复已保留").unwrap();
        let view = store::view(&f.root, &id).unwrap();
        let events = view["activity"][0]["events"].as_array().unwrap();
        assert_eq!(
            events
                .iter()
                .find(|e| e["kind"] == "unpublishedAnswer")
                .unwrap()["label"],
            text
        );
        assert!(store::record(&f.root, &run, "nativeFinal", &json!({"text":"late"})).is_err());
        store::revoke(&f.root, &id).unwrap();
        assert_eq!(store::view(&f.root, &id).unwrap()["activity"], json!([]));
    }
}

#[cfg(test)]
#[test]
fn cn05_answer_contract_is_shared_and_unrelated_record_limits_remain() {
    let text = "文".repeat(super::super::ANSWER_CHARS);
    let args = json!({"status":"completed","markdown":text,"citations":[],"questions":[],"limitations":[],"waitCondition":"","completion":null});
    let specs = tools(None).unwrap();
    let schema = &specs.as_array().unwrap().last().unwrap()["inputSchema"];
    assert!(crate::model_runtime::validate_agent_tool(&args, schema).is_err());
    crate::model_runtime::validate_capability_arguments(&args, schema).unwrap();
    let normalized = assistant::normalize(json!({"report":args}), &json!([])).unwrap();
    let report: Report = serde_json::from_value(normalized["report"].clone()).unwrap();
    validate(&report, &[]).unwrap();
    let mut too_long = args.clone();
    too_long["markdown"] = json!(format!("{text}超"));
    assert!(crate::model_runtime::validate_capability_arguments(&too_long, schema).is_err());
    assert!(assistant::normalize(json!({"report":too_long}), &json!([])).is_err());
    let f = crate::source_evidence::tests::Fixture::new();
    f.note("notes", "current", "原文");
    let id = crate::agent_work::tests::create(&f, false);
    let (_, run) = crate::agent_work::tests::claim(&f, &id);
    store::record(&f.root, &run, "agentProtocol", &json!({"version":1})).unwrap();
    assert!(store::record(
        &f.root,
        &run,
        "toolResult",
        &json!({"text":"x".repeat(65_537)})
    )
    .is_err());
    assert!(store::record(
        &f.root,
        &run,
        "nativeFinal",
        &json!({"text":"x".repeat(524_289)})
    )
    .is_err());
    store::record(&f.root, &run, "nativeFinal", &json!({"text":text})).unwrap();
}

#[cfg(test)]
#[test]
#[ignore = "CN05: one real Codex ordinary answer through production Hub, isolated empty grant; no web or business writes"]
fn cn05_live_native_answer_without_finish_publishes_once() {
    let path = std::env::var("HUB_CN05_LIVE_REPORT").expect("explicit report path required");
    let claim = std::path::Path::new(&path).with_extension("started");
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(claim)
        .unwrap();
    let f = crate::source_evidence::tests::Fixture::new();
    let created=super::super::super::ui(&f.root,&json!({"action":"create","anchor":null,"grant":Grant::default(),"goal":"这是普通答复交付测试。请只用原生最终答复输出：普通答复已经完整保留。不要调用任何工具，也不要调用 hub_finish。","successCriteria":"保存普通答复；不读取资料，不执行操作。"})).unwrap();
    let id = created["work"]["id"].as_str().unwrap();
    options::configure(&f.root,&json!({"id":id,"options":{"model":crate::model_runtime::Settings::default(),"autoFlashcardInbox":false}})).unwrap();
    let started = std::time::Instant::now();
    let result =
        super::super::super::ui(&f.root, &json!({"action":"respond","id":id,"mode":"quick"}));
    let view = store::view(&f.root, id).unwrap();
    let records = store::records(&f.root, id, "nativeResponseDelivery", 10).unwrap();
    std::fs::write(&path,serde_json::to_vec_pretty(&json!({"result":result,"view":view,"nativeResponseDelivery":records,"nativeFinal":store::records(&f.root,id,"nativeFinal",4).unwrap(),"durationMs":started.elapsed().as_millis(),"isolation":"empty grant, synthetic user prompt, no business writes"})).unwrap()).unwrap();
    result.unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(
        view["work"]["report"]["prose"]["markdown"],
        "普通答复已经完整保留。"
    );
    assert_ne!(view["goalAssessment"]["workFulfillment"], "fulfilled");
    assert_eq!(view["actions"]["items"], json!([]));
}

#[cfg(test)]
#[test]
fn cn05c_inherited_evidence_allows_conversation_but_source_changes_still_block_publication() {
    let f = crate::source_evidence::tests::Fixture::new();
    f.note("notes", "current", "已有证据原文");
    let id = crate::agent_work::tests::create(&f, false);
    let (w, run) = crate::agent_work::tests::claim(&f, &id);
    let evidence = w
        .grant
        .reader(&f.root)
        .unwrap()
        .read(w.anchor.as_ref().unwrap(), 0, 6000, None)
        .unwrap();
    let mut answer = Answer::default();
    answer.observe(
        "finalMessage",
        &json!({"text":"沿用前文，局部修复先选择合适的方法，并复用仍有效的验证。"}),
    );
    let report = answer.prepare(0, 0, &HashSet::new()).unwrap().unwrap();
    let assessment = store::goal::accept_report(
        &f.root,
        &w,
        &run,
        &report,
        &store::goal::for_run(&f.root, &w, &run).unwrap(),
    )
    .unwrap();
    assert_ne!(assessment["workFulfillment"], "fulfilled");
    store::publish(
        &f.root,
        &w,
        &run,
        &report,
        &[evidence.clone()],
        &[],
        &json!([]),
        &Value::Null,
        &Control::default(),
    )
    .unwrap();
    assert_eq!(
        store::view(&f.root, &id).unwrap()["work"]["report"]["prose"]["markdown"],
        report.summary
    );
    let other = crate::agent_work::tests::create(&f, false);
    let (w2, r2) = crate::agent_work::tests::claim(&f, &other);
    f.note("notes", "current", "来源已经改变");
    assert!(store::publish(
        &f.root,
        &w2,
        &r2,
        &report,
        &[evidence],
        &[],
        &json!([]),
        &Value::Null,
        &Control::default()
    )
    .is_err());
    assert!(store::view(&f.root, &other).unwrap()["work"]["report"].is_null());
    answer.observe("finalMessage", &json!({"text":"未经本轮映射的历史引用[1]"}));
    assert!(answer.prepare(0, 0, &HashSet::new()).is_err());
}

#[cfg(test)]
#[test]
fn native_web_diagnostics_do_not_reset_an_already_completed_answer() {
    let mut answer = Answer::default();
    answer.observe(
        "finalMessage",
        &json!({"text":"Answer with [source](https://example.org/a)"}),
    );
    answer.observe(
        "webDiagnostics",
        &json!({"kind":"webSearch","errorCount":1}),
    );
    let report = answer.prepare(0, 0, &HashSet::new()).unwrap().unwrap();
    assert!(report.completion.is_none());
    assert!(report.prose.unwrap().markdown.contains("Answer with"));
}
