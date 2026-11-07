use super::*;
use crate::obsidian_edit::tests::Fixture;
use std::fs;
fn setup(whole: bool) -> (Fixture, String) {
    let f = Fixture::new();
    let doc = f.seed("Note.md", "---\naliases: [原别名]\n---\n测量后再加工。\n");
    f.seed("Target.md", "有关加工条件。\n");
    f.seed("Secret.md", "PRIVATE_EDIT_SENTINEL");
    let anchor = EvidenceLocator::Note {
        library_id: "notes".into(),
        document_id: doc,
        page_id: None,
    };
    let grant = Grant {
        library_ids: if whole { vec!["notes".into()] } else { vec![] },
        notes: vec![anchor.clone()],
        ..Default::default()
    };
    let v=ui(&f.root,&json!({"action":"create","goal":"整理笔记","successCriteria":"保留原意","anchor":anchor,"grant":grant})).unwrap();
    (f, v["work"]["id"].as_str().unwrap().into())
}
fn prepared(f: &Fixture, id: &str, body: &str) -> Action {
    let request = json!({"instruction":"整理结构并保持原意"});
    let (w, a, ctx) = claim_action(&f.root, id, "obsidianEdit", |c, w| {
        context_on(&f.root, c, w, &request)
    })
    .unwrap();
    let control = Control::bounded(Duration::from_secs(10));
    let payload = build_payload(&f.root, &w, &ctx, &control, |p, s| {
        assert!(p.contains("测量后再加工"));
        assert!(!p.contains("PRIVATE_EDIT_SENTINEL"));
        assert_eq!(s["additionalProperties"], false);
        Ok(json!({"markdown":body,"summary":"明确测量顺序","warnings":[]}))
    })
    .unwrap();
    publish_payload(&f.root, &w, &a, &payload, &control).unwrap();
    load(&f.c(), id, &a).unwrap()
}
fn submit_action(f: &Fixture, id: &str, a: &Action) -> Result<Value, String> {
    ui(
        &f.root,
        &json!({"action":"submitObsidianEdit","id":id,"actionId":a.id,"confirmationToken":token(a)}),
    )
}

fn recovery_inspect(f: &Fixture, id: &str, a: &Action) -> Result<Value, String> {
    ui(
        &f.root,
        &json!({"action":"inspectObsidianEdit","id":id,"actionId":a.id}),
    )
}
fn recovery_count(f: &Fixture, id: &str, kind: &str) -> i64 {
    f.c()
        .query_row(
            "SELECT COUNT(*) FROM agent_records WHERE work_id=?1 AND kind=?2",
            params![id, kind],
            |r| r.get(0),
        )
        .unwrap()
}

#[test]
fn recovery_budget_frozen_model_drafts_refuse_before_claim_but_report_save_remains_available() {
    let (f, id) = setup(false);
    ui(&f.root,&json!({"action":"freezeProviderBudget","id":id,"expectedWorkRevision":1,"limits":{"inputTokens":1000,"uncachedInputTokens":500,"outputTokens":100},"perRun":{"inputTokens":400,"uncachedInputTokens":200,"outputTokens":40},"unknownReservations":{}})).unwrap();
    for args in [
        json!({"action":"prepareObsidianEdit","id":id,"instruction":"不得调用模型"}),
        json!({"action":"prepareFlashcards","id":id,"learningGoal":"不得调用模型","deckName":"收件箱"}),
        json!({"action":"prepareTagProposal","id":id,"tag":"未读取的标签"}),
    ] {
        assert!(ui(&f.root, &args).unwrap_err().contains("未启动模型"));
    }
    assert!(claim_action(&f.root, &id, "archiveCopy", |_, _| panic!(
        "no archive context or remote access before admission"
    ))
    .err()
    .unwrap()
    .contains("未启动模型"));
    let w = store::load(&f.c(), &id).unwrap();
    assert!(options::operation(
        &f.root,
        &w,
        "agent-obsidian-edit",
        "must refuse before model queue",
        Control::default()
    )
    .err()
    .unwrap()
    .contains("未启动模型"));
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM agent_actions", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(recovery_count(&f, &id, "nativeRuntime"), 0);
    assert_eq!(recovery_count(&f, &id, "modelExecution"), 0);
    report_save_seed(&f, &id, "冻结模型额度后的既有报告保存");
    let a = report_save_prepared(&f, &id);
    let v = submit_action(&f, &id, &a).unwrap();
    assert_eq!(load(&f.c(), &id, &a.id).unwrap().state, "verified");
    assert_eq!(v["actions"]["standaloneModelDrafts"]["allowed"], false);
    assert!(fs::read_to_string(f.vault.join("Note.md"))
        .unwrap()
        .contains("冻结模型额度后的既有报告保存"));
    assert_eq!(recovery_count(&f, &id, "modelExecution"), 0);
}

#[test]
fn recovery_budget_per_action_is_durable_and_does_not_rewrite_source_or_receipt_at_cap() {
    let (f, id) = setup(false);
    let a = prepared(&f, &id, "原保存内容。\n");
    submit_action(&f, &id, &a).unwrap();
    let file = f.vault.join("Note.md");
    let bytes = fs::read(&file).unwrap();
    let time = fs::metadata(&file).unwrap().modified().unwrap();
    for _ in 0..4 {
        recovery_inspect(&f, &id, &a).unwrap();
    }
    let old = load(&f.c(), &id, &a.id).unwrap();
    assert!(recovery_inspect(&f, &id, &a)
        .unwrap_err()
        .contains("核验额度已用尽"));
    let v = ui(&f.root, &json!({"action":"status","id":id})).unwrap();
    assert_eq!(
        v["actions"]["items"][0]["inspectionBudget"]["canInspect"],
        false
    );
    assert_eq!(recovery_count(&f, &id, "recoveryBudgetAttempt"), 4);
    assert_eq!(load(&f.c(), &id, &a.id).unwrap().receipt, old.receipt);
    assert_eq!(fs::read(&file).unwrap(), bytes);
    assert_eq!(fs::metadata(&file).unwrap().modified().unwrap(), time);
    assert_eq!(recovery_count(&f, &id, "modelExecution"), 0);
}

#[test]
fn recovery_budget_failed_reservation_admits_no_file_verification_or_partial_policy() {
    let (f, id) = setup(false);
    let a = prepared(&f, &id, "先前保存。\n");
    submit_action(&f, &id, &a).unwrap();
    let old = load(&f.c(), &id, &a.id).unwrap();
    fs::write(
        f.vault.join("Note.md"),
        "外部新内容，不能当作已核验原保存\n",
    )
    .unwrap();
    f.c().execute_batch("CREATE TRIGGER reject_recovery_attempt BEFORE INSERT ON agent_records WHEN NEW.kind='recoveryBudgetAttempt' BEGIN SELECT RAISE(ABORT,'recovery reservation unavailable'); END;").unwrap();
    assert!(recovery_inspect(&f, &id, &a)
        .unwrap_err()
        .contains("recovery reservation unavailable"));
    assert_eq!(recovery_count(&f, &id, "recoveryBudgetPolicy"), 0);
    assert_eq!(recovery_count(&f, &id, "recoveryBudgetAttempt"), 0);
    let now = load(&f.c(), &id, &a.id).unwrap();
    assert_eq!(now.state, old.state);
    assert_eq!(now.receipt, old.receipt);
    assert_eq!(
        fs::read_to_string(f.vault.join("Note.md")).unwrap(),
        "外部新内容，不能当作已核验原保存\n"
    );
}

#[test]
fn recovery_budget_unknown_write_stops_at_cap_and_status_reopen_preserves_intent_without_replay() {
    let (f, id) = setup(false);
    report_save_seed(&f, &id, "有界未知恢复报告");
    let a = report_save_prepared(&f, &id);
    let c = f.c();
    let w = store::load(&c, &id).unwrap();
    let p = a.payload.as_ref().unwrap();
    let base = snapshot(p).unwrap();
    let after = p["after"].as_str().unwrap();
    journal_execution(&f.root,&w,&a,&json!({"operationId":a.id,"beforeHash":base.hash,"afterHash":files::hash(after.as_bytes()),"fileVerified":false,"goalCompleted":false})).unwrap();
    let mut locked = files::LockedNote::open(&c, &base).unwrap();
    locked.write(after).unwrap();
    drop(locked);
    drop(c);
    // Four durable reservations represent checks whose outcome was lost. No
    // result is fabricated, and reopening cannot refund those attempts.
    for _ in 0..4 {
        store::recovery_budget::reserve(&f.root, &w, &a.id, "user").unwrap();
    }
    let file = f.vault.join("Note.md");
    let bytes = fs::read(&file).unwrap();
    let time = fs::metadata(&file).unwrap().modified().unwrap();
    for _ in 0..2 {
        let v = ui(&f.root, &json!({"action":"status","id":id})).unwrap();
        assert_eq!(v["actions"]["items"][0]["state"], "executing");
        assert_eq!(v["actions"]["items"][0]["receipt"]["fileVerified"], false);
        assert_eq!(
            v["actions"]["items"][0]["inspectionBudget"]["canInspect"],
            false
        );
    }
    assert!(recovery_inspect(&f, &id, &a)
        .unwrap_err()
        .contains("核验额度已用尽"));
    assert!(submit_action(&f, &id, &a).is_err());
    assert_eq!(recovery_count(&f, &id, "recoveryBudgetAttempt"), 4);
    assert_eq!(fs::read(&file).unwrap(), bytes);
    assert_eq!(fs::metadata(&file).unwrap().modified().unwrap(), time);
    assert_eq!(
        String::from_utf8(bytes)
            .unwrap()
            .matches("<!-- hub-report:")
            .count(),
        1
    );
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM agent_actions", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn recovery_budget_future_schema_keeps_receipts_readable_and_refuses_fresh_verification() {
    let (f, id) = setup(false);
    let a = prepared(&f, &id, "已保存原文。\n");
    submit_action(&f, &id, &a).unwrap();
    store::write(&f.root, |c| {
        store::insert(
            c,
            &id,
            None,
            "recoveryBudgetPolicy",
            &json!({"schemaVersion":99,"rootWorkId":id,"workChecks":80,"actionChecks":4}),
        )
    })
    .unwrap();
    let old = load(&f.c(), &id, &a.id).unwrap();
    let v = ui(&f.root, &json!({"action":"status","id":id})).unwrap();
    assert_eq!(v["actions"]["items"][0]["receipt"]["fileVerified"], true);
    assert_eq!(v["actions"]["recoveryBudget"]["state"], "unavailable");
    assert!(recovery_inspect(&f, &id, &a)
        .unwrap_err()
        .contains("核验额度版本或上限不可用"));
    assert_eq!(load(&f.c(), &id, &a.id).unwrap().receipt, old.receipt);
    assert_eq!(recovery_count(&f, &id, "recoveryBudgetAttempt"), 0);
}

#[test]
fn completion_proof_distinguishes_real_preview_save_and_external_changes() {
    let (f, id) = setup(false);
    let draft = prepared(&f, &id, "先测量，再加工。\n");
    let run = "goal-preview";
    let work = store::claim(&f.root, &id, run).unwrap();
    let context = store::goal::completion::read_context(&f.root, &work, run).unwrap();
    let proof = context["proofs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["kind"] == "draft")
        .unwrap();
    let items:Vec<_>=context["requirements"].as_array().unwrap().iter().map(|r|json!({"requirementId":r["requirementId"],"criterion":r["text"],"requiredResult":"action","status":"satisfied","explanation":"已保存修改","refs":[proof["proofId"]],"supersededBy":null})).collect();
    let mut value = json!({"status":"completed","summary":"已准备预览","findings":[],"nextSteps":[],"questions":[],"limitations":[],"waitCondition":"","completion":{"goalBinding":context["goalBinding"],"items":items}});
    let wrong: runner::Report = serde_json::from_value(value.clone()).unwrap();
    assert!(
        store::goal::completion::evaluate(&f.root, &f.c(), &work, run, &wrong)
            .unwrap_err()
            .contains("预览不能证明")
    );
    for item in value["completion"]["items"].as_array_mut().unwrap() {
        item["requiredResult"] = json!("draft");
        item["explanation"] = json!("已准备可核对的预览");
    }
    let report: runner::Report = serde_json::from_value(value).unwrap();
    store::publish(
        &f.root,
        &work,
        run,
        &report,
        &[],
        &[],
        &receipts(&f.root, &id).unwrap(),
        &Value::Null,
        &Control::default(),
    )
    .unwrap();
    assert_eq!(
        store::view(&f.root, &id).unwrap()["goalAssessment"]["workFulfillment"],
        "fulfilled"
    );
    submit_action(&f, &id, &draft).unwrap();
    let work = store::load(&f.c(), &id).unwrap();
    let proofs = completion_proofs_on(&f.root, &f.c(), &work).unwrap();
    assert!(proofs.iter().any(|p| p["kind"] == "action"));
    assert!(proofs.iter().all(|p| p["kind"] != "draft"));
    fs::write(f.vault.join("Note.md"), "外部改变了已保存内容\n").unwrap();
    assert!(completion_proofs_on(&f.root, &f.c(), &work)
        .unwrap()
        .is_empty());
    assert_eq!(
        store::view(&f.root, &id).unwrap()["goalAssessment"]["workFulfillment"],
        "partial"
    );
}
#[test]
fn refining_a_note_uses_the_previous_draft_and_original_file_as_separate_inputs() {
    let (f, id) = setup(false);
    let old = prepared(&f, &id, "先测量，再加工。\n");
    ui(&f.root,&json!({"action":"message","id":id,"text":"给刚才的草稿加一个标题","clientMessageId":"note-refine"})).unwrap();
    let args = json!({"instruction":"给刚才的草稿加一个标题","baseActionId":old.id});
    let (w, a, ctx) = claim_action(&f.root, &id, "obsidianEdit", |c, w| {
        context_on(&f.root, c, w, &args)
    })
    .unwrap();
    let p = build_payload(&f.root, &w, &ctx, &Control::default(), |prompt, _| {
        assert!(prompt.contains("previousDraft"));
        assert!(prompt.contains("先测量，再加工。"));
        Ok(json!({"markdown":"# 加工顺序\n先测量，再加工。\n","summary":"补充标题","warnings":[]}))
    })
    .unwrap();
    assert_eq!(p["snapshot"], old.payload.as_ref().unwrap()["snapshot"]);
    publish_payload(&f.root, &w, &a, &p, &Control::default()).unwrap();
    assert!(submit_action(&f, &id, &old).is_err());
    assert_eq!(
        fs::read_to_string(f.vault.join("Note.md")).unwrap(),
        "---\naliases: [原别名]\n---\n测量后再加工。\n"
    );
    fs::write(f.vault.join("Note.md"), "外部已修改\n").unwrap();
    assert!(context_on(&f.root, &f.c(), &w, &args).is_err());
}
#[test]
fn preview_is_scoped_and_immutable_then_explicit_save_updates_real_file_and_importer() {
    let (f, id) = setup(false);
    f.c().execute_batch("CREATE TRIGGER require_durable_note_journal BEFORE UPDATE OF state ON agent_actions WHEN NEW.state='executing' AND (SELECT synchronous FROM pragma_synchronous)<>2 BEGIN SELECT RAISE(ABORT,'write-ahead record must sync before file write'); END;").unwrap();
    let before = fs::read(f.vault.join("Note.md")).unwrap();
    let a = prepared(&f, &id, "先测量，再加工。\n");
    assert_eq!(fs::read(f.vault.join("Note.md")).unwrap(), before);
    assert!(ui(
        &f.root,
        &json!({"action":"submitObsidianEdit","id":id,"actionId":a.id,"confirmationToken":"wrong"})
    )
    .is_err());
    let view = submit_action(&f, &id, &a).unwrap();
    assert_eq!(view["actions"]["items"][0]["state"], "verified");
    assert_eq!(view["actions"]["items"][0]["receipt"]["indexed"], true);
    let receipt = view["actions"]["items"][0]["receipt"].clone();
    assert_eq!(receipt["operationId"], a.id);
    assert_eq!(receipt["operation"], "editNote");
    assert_eq!(receipt["target"]["path"], "Note.md");
    let file = f.vault.join("Note.md");
    assert_eq!(
        fs::read_to_string(&file).unwrap(),
        "---\naliases: [原别名]\n---\n先测量，再加工。\n"
    );
    let modified = fs::metadata(&file).unwrap().modified().unwrap();
    submit_action(&f, &id, &a).unwrap();
    let reopened = ui(&f.root, &json!({"action":"status","id":id})).unwrap();
    assert_eq!(reopened["actions"]["items"][0]["receipt"], receipt);
    assert_eq!(fs::metadata(file).unwrap().modified().unwrap(), modified);
    let facts = receipts(&f.root, &id).unwrap();
    assert_eq!(facts[0]["kind"], "obsidianEdit");
    assert!(!facts.to_string().contains("先测量，再加工"));
}
#[test]
fn external_changes_expire_confirmation_and_keep_original_draft_visible() {
    let (f, id) = setup(false);
    let a = prepared(&f, &id, "新草稿\n");
    fs::write(f.vault.join("Note.md"), "外部编辑内容\n").unwrap();
    assert!(submit_action(&f, &id, &a).is_err());
    let view = ui(&f.root, &json!({"action":"status","id":id})).unwrap();
    let item = &view["actions"]["items"][0];
    assert_eq!(item["state"], "expired");
    assert!(item["confirmationToken"].is_null());
    assert!(item["payload"]["after"]
        .as_str()
        .unwrap()
        .contains("新草稿"));
    assert_eq!(
        fs::read_to_string(f.vault.join("Note.md")).unwrap(),
        "外部编辑内容\n"
    );
}
#[test]
fn write_ahead_persistence_failure_never_touches_original_bytes() {
    let (f, id) = setup(false);
    let a = prepared(&f, &id, "新正文\n");
    let before = fs::read(f.vault.join("Note.md")).unwrap();
    f.c().execute_batch("CREATE TRIGGER fail_note_journal BEFORE UPDATE OF state ON agent_actions WHEN NEW.state='executing' BEGIN SELECT RAISE(ABORT,'journal unavailable'); END;").unwrap();
    assert!(submit_action(&f, &id, &a).is_err());
    assert_eq!(fs::read(f.vault.join("Note.md")).unwrap(), before);
}

#[test]
fn no_change_preserves_file_time_and_real_edit_invalidates_old_evidence() {
    let (f, id) = setup(false);
    let c = f.c();
    let w = store::load(&c, &id).unwrap();
    let reader = w.grant.reader(&f.root).unwrap();
    let evidence = reader
        .read(w.anchor.as_ref().unwrap(), 0, 200, None)
        .unwrap();
    drop(c);
    let path = f.vault.join("Note.md");
    let modified = fs::metadata(&path).unwrap().modified().unwrap();
    let unchanged = prepared(&f, &id, "测量后再加工。\n");
    submit_action(&f, &id, &unchanged).unwrap();
    assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), modified);
    reader.verify(&evidence).unwrap();
    let changed = prepared(&f, &id, "测量并确认条件后再加工。\n");
    submit_action(&f, &id, &changed).unwrap();
    assert!(reader.verify(&evidence).is_err());
}
#[test]
fn restart_observes_completed_write_without_replay_and_restore_requires_new_confirmation() {
    let (f, id) = setup(false);
    let a = prepared(&f, &id, "完成的修改\n");
    let after = a.payload.as_ref().unwrap()["after"].as_str().unwrap();
    f.c().execute("UPDATE agent_actions SET state='executing',receipt_json='{\"domain\":\"obsidianNoteEdit\",\"goalCompleted\":false}' WHERE id=?1",[&a.id]).unwrap();
    fs::write(f.vault.join("Note.md"), after).unwrap();
    let modified = fs::metadata(f.vault.join("Note.md"))
        .unwrap()
        .modified()
        .unwrap();
    reconcile(&f.root, &id).unwrap();
    assert_eq!(load(&f.c(), &id, &a.id).unwrap().state, "verified");
    assert_eq!(
        fs::metadata(f.vault.join("Note.md"))
            .unwrap()
            .modified()
            .unwrap(),
        modified
    );
    restore(&f.root, &json!({"id":id,"actionId":a.id})).unwrap();
    let restored_id: String = f
        .c()
        .query_row(
            "SELECT id FROM agent_actions ORDER BY rowid DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let b = load(&f.c(), &id, &restored_id).unwrap();
    assert_eq!(b.state, "prepared");
    assert_eq!(fs::read_to_string(f.vault.join("Note.md")).unwrap(), after);
    submit_action(&f, &id, &b).unwrap();
    assert_eq!(
        fs::read_to_string(f.vault.join("Note.md")).unwrap(),
        "---\naliases: [原别名]\n---\n测量后再加工。\n"
    );
}
#[test]
fn interrupted_partial_utf8_is_never_auto_overwritten_and_can_be_explicitly_restored() {
    let (f, id) = setup(false);
    let a = prepared(&f, &id, "尚未完整写入\n");
    f.c().execute("UPDATE agent_actions SET state='executing',receipt_json='{\"goalCompleted\":false}' WHERE id=?1",[&a.id]).unwrap();
    fs::write(f.vault.join("Note.md"), [0xe4, 0xb8]).unwrap();
    reconcile(&f.root, &id).unwrap();
    assert_eq!(load(&f.c(), &id, &a.id).unwrap().state, "needs_review");
    assert_eq!(fs::read(f.vault.join("Note.md")).unwrap(), [0xe4, 0xb8]);
    restore(&f.root, &json!({"id":id,"actionId":a.id})).unwrap();
    let next: String = f
        .c()
        .query_row(
            "SELECT id FROM agent_actions ORDER BY rowid DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let b = load(&f.c(), &id, &next).unwrap();
    submit_action(&f, &id, &b).unwrap();
    assert!(fs::read_to_string(f.vault.join("Note.md"))
        .unwrap()
        .contains("测量后再加工"));
}
#[test]
fn deleted_original_is_not_recreated_and_revocation_hides_backup_and_draft() {
    let (f, id) = setup(false);
    let a = prepared(&f, &id, "新内容\n");
    fs::rename(f.vault.join("Note.md"), f.vault.join("Moved.md")).unwrap();
    assert!(submit_action(&f, &id, &a).is_err());
    assert!(!f.vault.join("Note.md").exists());
    ui(&f.root, &json!({"action":"revoke","id":id})).unwrap();
    let view = ui(&f.root, &json!({"action":"status","id":id})).unwrap();
    assert!(!view.to_string().contains("新内容"));
    assert!(!view.to_string().contains("测量后再加工"));
    assert!(submit_action(&f, &id, &a).is_err());
}
#[test]
fn new_links_are_bound_to_real_authorized_targets() {
    let (f, id) = setup(false);
    let c = f.c();
    let w = store::load(&c, &id).unwrap();
    let ctx = context_on(&f.root, &c, &w, &json!({"instruction":"补充双链"})).unwrap();
    assert!(!ctx.to_string().contains("Secret"));
    assert!(!ctx.to_string().contains("Target.md"));
    let base = snapshot(&ctx).unwrap();
    assert!(validate_links(&base, "[[Target]]", &ctx["linkTargets"]).is_err());
    let (f2, id2) = setup(true);
    let c = f2.c();
    let w = store::load(&c, &id2).unwrap();
    let ctx = context_on(&f2.root, &c, &w, &json!({"instruction":"补充双链"})).unwrap();
    let base = snapshot(&ctx).unwrap();
    validate_links(&base, "[[Target]]", &ctx["linkTargets"]).unwrap();
    validate_links(&base, "[[Target|相关笔记]]", &ctx["linkTargets"]).unwrap();
    assert!(validate_links(&base, "[[Target#未核对的标题]]", &ctx["linkTargets"]).is_err());
    assert!(validate_links(&base, "[[虚构笔记]]", &ctx["linkTargets"]).is_err());
}

fn report_save_seed(f: &Fixture, id: &str, summary: &str) {
    let run = format!("report-save-{}", crate::random_url_safe(8));
    let work = store::claim(&f.root, id, &run).unwrap();
    let evidence = work
        .grant
        .reader(&f.root)
        .unwrap()
        .read(work.action_anchor().unwrap(), 0, 1000, None)
        .unwrap();
    let report: runner::Report = serde_json::from_value(json!({"status":"completed","summary":summary,"findings":[],"nextSteps":[],"questions":[],"limitations":["仅核对当前材料"],"waitCondition":"","prose":{"markdown":format!("{summary} [1]"),"citations":[{"evidenceId":"e1","quote":"测量后再加工。"}]}})).unwrap();
    store::publish(
        &f.root,
        &work,
        &run,
        &report,
        &[evidence],
        &[],
        &json!([]),
        &Value::Null,
        &Control::default(),
    )
    .unwrap();
}
fn report_save_prepared(f: &Fixture, id: &str) -> Action {
    ui(
        &f.root,
        &json!({"action":"prepareObsidianReportSave","id":id}),
    )
    .unwrap();
    let action: String = f
        .c()
        .query_row(
            "SELECT id FROM agent_actions ORDER BY rowid DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    load(&f.c(), id, &action).unwrap()
}

fn independent_setup() -> (Fixture, String, EvidenceLocator, EvidenceLocator) {
    let f = Fixture::new();
    let first = EvidenceLocator::Note {
        library_id: "notes".into(),
        document_id: f.seed("Note.md", "测量后再加工。\n"),
        page_id: None,
    };
    let second = EvidenceLocator::Note {
        library_id: "notes".into(),
        document_id: f.seed("Target.md", "另一篇正文，不能覆盖。\n"),
        page_id: None,
    };
    f.seed("Secret.md", "PRIVATE_EDIT_SENTINEL");
    let created=ui(&f.root,&json!({"action":"create","anchor":null,"grant":Grant::default(),"goal":"独立对话后选择保存目标","successCriteria":"明确确认后保存"})).unwrap();
    let id = created["work"]["id"].as_str().unwrap().to_string();
    ui(&f.root,&json!({"action":"message","id":id,"text":"授权这两篇笔记","expectedRevision":1,"clientMessageId":"two-notes","addNotes":[first,second]})).unwrap();
    (f, id, first, second)
}
fn select_target(f: &Fixture, id: &str, target: &EvidenceLocator) -> Result<Value, String> {
    let w = store::load(&f.c(), id).unwrap();
    ui(
        &f.root,
        &json!({"action":"selectObsidianTarget","id":id,"target":target,"expectedRevision":w.revision,"expectedAuthorizationVersion":w.authorization_version}),
    )
}

#[test]
fn independent_target_requires_explicit_current_authorization_without_changing_entry_or_budget() {
    let (f, id, first, _) = independent_setup();
    let before = ui(&f.root, &json!({"action":"status","id":id})).unwrap();
    assert_eq!(before["actions"]["obsidianEditAvailable"], false);
    assert_eq!(
        before["actions"]["obsidianTargets"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert!(prepare_report(&f.root, &json!({"id":id})).is_err());
    assert!(ui(&f.root,&json!({"action":"selectObsidianTarget","id":id,"target":first,"expectedRevision":1,"expectedAuthorizationVersion":2})).is_err());
    let secret = EvidenceLocator::Note {
        library_id: "notes".into(),
        document_id: f
            .c()
            .query_row("SELECT id FROM documents WHERE path='Secret.md'", [], |r| {
                r.get(0)
            })
            .unwrap(),
        page_id: None,
    };
    assert!(select_target(&f, &id, &secret).is_err());
    let selected = select_target(&f, &id, &first).unwrap();
    assert!(selected["work"]["anchor"].is_null());
    assert_eq!(selected["work"]["actionTarget"], json!(first));
    assert_eq!(selected["work"]["authorizationVersion"], 2);
    assert!(selected["work"]["actionTargetIdentity"].is_string());
    assert_eq!(selected["work"]["grant"], before["work"]["grant"]);
    assert_eq!(
        selected["lifecycle"]["providerBudget"],
        before["lifecycle"]["providerBudget"]
    );
    assert_eq!(recovery_count(&f, &id, "modelExecution"), 0);
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM agent_actions", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn independent_report_survives_target_selection_and_real_append_undo_never_touches_other_notes() {
    let (f, id, first, _) = independent_setup();
    let (w, run) = {
        let run = format!("plain-{}", crate::random_url_safe(8));
        (store::claim(&f.root, &id, &run).unwrap(), run)
    };
    let report:runner::Report=serde_json::from_value(json!({"status":"completed","summary":"保留独立回答","findings":[],"nextSteps":[],"questions":[],"limitations":[],"waitCondition":"","prose":{"markdown":"保留独立回答","citations":[]}})).unwrap();
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
    let selected = select_target(&f, &id, &first).unwrap();
    assert_eq!(
        selected["work"]["report"]["prose"]["markdown"], "保留独立回答",
        "{}",
        selected["validity"]
    );
    let before = fs::read(f.vault.join("Note.md")).unwrap();
    let other = fs::read(f.vault.join("Target.md")).unwrap();
    let other_time = fs::metadata(f.vault.join("Target.md"))
        .unwrap()
        .modified()
        .unwrap();
    let a = report_save_prepared(&f, &id);
    let v = submit_action(&f, &id, &a).unwrap();
    assert_eq!(v["actions"]["items"][0]["state"], "verified");
    let saved = fs::read(f.vault.join("Note.md")).unwrap();
    let saved_time = fs::metadata(f.vault.join("Note.md"))
        .unwrap()
        .modified()
        .unwrap();
    submit_action(&f, &id, &a).unwrap();
    assert_eq!(fs::read(f.vault.join("Note.md")).unwrap(), saved);
    assert_eq!(
        fs::metadata(f.vault.join("Note.md"))
            .unwrap()
            .modified()
            .unwrap(),
        saved_time
    );
    let v = ui(
        &f.root,
        &json!({"action":"restoreObsidianEdit","id":id,"actionId":a.id}),
    )
    .unwrap();
    let undo = load(
        &f.c(),
        &id,
        v["actions"]["items"][0]["id"].as_str().unwrap(),
    )
    .unwrap();
    submit_action(&f, &id, &undo).unwrap();
    assert_eq!(fs::read(f.vault.join("Note.md")).unwrap(), before);
    assert_eq!(fs::read(f.vault.join("Target.md")).unwrap(), other);
    assert_eq!(
        fs::metadata(f.vault.join("Target.md"))
            .unwrap()
            .modified()
            .unwrap(),
        other_time
    );
    assert_eq!(recovery_count(&f, &id, "modelExecution"), 0);
}

#[test]
fn independent_target_switch_expires_approval_and_unknown_save_prevents_switching() {
    let (f, id, first, second) = independent_setup();
    select_target(&f, &id, &first).unwrap();
    report_save_seed(&f, &id, "目标不能悄悄变更");
    let a = report_save_prepared(&f, &id);
    let old_work = store::load(&f.c(), &id).unwrap();
    select_target(&f, &id, &second).unwrap();
    assert!(check_prepared(&f.root, &f.c(), &old_work, &a).is_err());
    assert!(submit_action(&f, &id, &a).is_err());
    select_target(&f, &id, &first).unwrap();
    assert!(submit_action(&f, &id, &a).is_err());
    let w = store::load(&f.c(), &id).unwrap();
    assert!(check_prepared(&f.root, &f.c(), &w, &a).is_err());
    f.c()
        .execute(
            "UPDATE agent_actions SET state='needs_review' WHERE id=?1",
            [&a.id],
        )
        .unwrap();
    assert!(select_target(&f, &id, &second)
        .unwrap_err()
        .contains("结果待核对"));
    assert_eq!(
        fs::read_to_string(f.vault.join("Target.md")).unwrap(),
        "另一篇正文，不能覆盖。\n"
    );
}

#[test]
fn independent_target_is_cleared_by_scope_change_and_cannot_write_or_reuse_old_draft() {
    let (f, id, first, _) = independent_setup();
    select_target(&f, &id, &first).unwrap();
    report_save_seed(&f, &id, "撤权前报告");
    let a = report_save_prepared(&f, &id);
    let before = fs::read(f.vault.join("Note.md")).unwrap();
    let v=ui(&f.root,&json!({"action":"message","id":id,"text":"撤回保存目标授权","clientMessageId":"remove-target","expectedRevision":2,"removeNotes":[first]})).unwrap();
    assert!(v["work"]["actionTarget"].is_null());
    assert_eq!(v["actions"]["obsidianEditAvailable"], false);
    assert!(v["actions"]["items"][0]["payload"].is_null());
    assert!(submit_action(&f, &id, &a).is_err());
    assert_eq!(fs::read(f.vault.join("Note.md")).unwrap(), before);
}

#[test]
fn independent_target_reopens_an_unknown_real_file_write_without_rewriting_or_another_model() {
    let (f, id, first, _) = independent_setup();
    select_target(&f, &id, &first).unwrap();
    report_save_seed(&f, &id, "写后回执恢复");
    let a = report_save_prepared(&f, &id);
    let c = f.c();
    let w = store::load(&c, &id).unwrap();
    let p = a.payload.as_ref().unwrap();
    let base = snapshot(p).unwrap();
    journal_execution(&f.root,&w,&a,&json!({"operationId":a.id,"operation":"appendCurrentReport","reportIdentity":p["reportIdentity"],"fileVerified":false,"goalCompleted":false})).unwrap();
    let mut file = files::LockedNote::open(&c, &base).unwrap();
    file.write(p["after"].as_str().unwrap()).unwrap();
    drop(file);
    drop(c);
    let before = fs::read(f.vault.join("Note.md")).unwrap();
    let time = fs::metadata(f.vault.join("Note.md"))
        .unwrap()
        .modified()
        .unwrap();
    let reopened = ui(&f.root, &json!({"action":"status","id":id})).unwrap();
    assert_eq!(reopened["actions"]["items"][0]["state"], "verified");
    assert_eq!(reopened["work"]["actionTarget"], json!(first));
    assert_eq!(fs::read(f.vault.join("Note.md")).unwrap(), before);
    assert_eq!(
        fs::metadata(f.vault.join("Note.md"))
            .unwrap()
            .modified()
            .unwrap(),
        time
    );
    assert_eq!(recovery_count(&f, &id, "modelExecution"), 0);
}

#[test]
fn report_save_appends_exact_current_text_citations_and_limits_then_replay_is_read_only() {
    let (f, id) = setup(false);
    report_save_seed(&f, &id, "保存报告哨兵：先核对条件");
    let original = fs::read_to_string(f.vault.join("Note.md")).unwrap();
    let a = report_save_prepared(&f, &id);
    let after = a.payload.as_ref().unwrap()["after"].as_str().unwrap();
    assert!(after.starts_with(&original));
    assert!(after.contains("保存报告哨兵：先核对条件 [1]"));
    assert!(after.contains("出处（报告生成时的原句）"));
    assert!(after.contains("仅核对当前材料"));
    assert!(after.contains("> 测量后再加工。"));
    assert!(!after.contains("PRIVATE_EDIT_SENTINEL"));
    assert_eq!(
        fs::read_to_string(f.vault.join("Note.md")).unwrap(),
        original
    );
    let v = submit_action(&f, &id, &a).unwrap();
    assert_eq!(v["actions"]["items"][0]["state"], "verified");
    assert_eq!(v["actions"]["items"][0]["receipt"]["operationId"], a.id);
    assert_eq!(
        v["actions"]["items"][0]["receipt"]["operation"],
        "appendCurrentReport"
    );
    assert_eq!(v["actions"]["items"][0]["receipt"]["fileVerified"], true);
    assert_eq!(fs::read_to_string(f.vault.join("Note.md")).unwrap(), after);
    // The write changes the source and action dependencies. Do not silently
    // rebase the old report; the retained saved-copy receipt stays distinct.
    assert!(v["work"]["report"].is_null());
    let modified = fs::metadata(f.vault.join("Note.md"))
        .unwrap()
        .modified()
        .unwrap();
    submit_action(&f, &id, &a).unwrap();
    assert_eq!(
        fs::metadata(f.vault.join("Note.md"))
            .unwrap()
            .modified()
            .unwrap(),
        modified
    );
    assert!(prepare_report(&f.root, &json!({"id":id})).is_err());
}

#[test]
fn report_save_rejects_new_report_stale_source_revocation_and_wrong_confirmation() {
    let (f, id) = setup(false);
    assert!(prepare_report(&f.root, &json!({"id":id})).is_err());
    report_save_seed(&f, &id, "第一份报告");
    let a = report_save_prepared(&f, &id);
    assert!(ui(
        &f.root,
        &json!({"action":"submitObsidianEdit","id":id,"actionId":a.id,"confirmationToken":"wrong"})
    )
    .is_err());
    report_save_seed(&f, &id, "修订后报告");
    assert!(submit_action(&f, &id, &a).is_err());
    assert!(!fs::read_to_string(f.vault.join("Note.md"))
        .unwrap()
        .contains("第一份报告"));
    let b = report_save_prepared(&f, &id);
    fs::write(f.vault.join("Note.md"), "用户并发追加，必须保留\n").unwrap();
    assert!(submit_action(&f, &id, &b).is_err());
    assert_eq!(
        fs::read_to_string(f.vault.join("Note.md")).unwrap(),
        "用户并发追加，必须保留\n"
    );
    ui(&f.root, &json!({"action":"revoke","id":id})).unwrap();
    assert!(submit_action(&f, &id, &b).is_err());
    let v = ui(&f.root, &json!({"action":"status","id":id})).unwrap();
    assert!(v["actions"]["obsidianReportTarget"].is_null());
    assert!(!v.to_string().contains("修订后报告"));
}

#[test]
fn report_save_unknown_after_durable_intent_observes_target_without_replaying() {
    for written in [false, true] {
        let (f, id) = setup(false);
        report_save_seed(&f, &id, "未知恢复报告");
        let a = report_save_prepared(&f, &id);
        let c = f.c();
        let w = store::load(&c, &id).unwrap();
        let p = a.payload.as_ref().unwrap();
        let base = snapshot(p).unwrap();
        let after = p["after"].as_str().unwrap();
        let receipt = json!({"domain":"obsidianNoteEdit","operationId":a.id,"reportIdentity":p["reportIdentity"],"beforeHash":base.hash,"afterHash":files::hash(after.as_bytes()),"fileVerified":false,"goalCompleted":false});
        let mut locked = files::LockedNote::open(&c, &base).unwrap();
        journal_execution(&f.root, &w, &a, &receipt).unwrap();
        if written {
            locked.write(after).unwrap();
        }
        drop(locked);
        drop(c);
        let before_recovery = fs::read(f.vault.join("Note.md")).unwrap();
        let modified = fs::metadata(f.vault.join("Note.md"))
            .unwrap()
            .modified()
            .unwrap();
        // Drop all handles, then enter the same persistent status/reconcile
        // entry used on reopen. This emulates the receipt-loss crash window,
        // with actual committed intent and real NTFS bytes, without reissue.
        let v = ui(&f.root, &json!({"action":"status","id":id})).unwrap();
        assert_eq!(
            v["actions"]["items"][0]["state"],
            if written { "verified" } else { "interrupted" }
        );
        assert_eq!(fs::read(f.vault.join("Note.md")).unwrap(), before_recovery);
        assert_eq!(
            fs::metadata(f.vault.join("Note.md"))
                .unwrap()
                .modified()
                .unwrap(),
            modified
        );
        if !written {
            submit_action(&f, &id, &a).unwrap();
        }
        assert_eq!(fs::read_to_string(f.vault.join("Note.md")).unwrap(), after);
    }
}

#[test]
fn report_save_journal_failure_and_divergent_unknown_never_overwrite() {
    let (f, id) = setup(false);
    report_save_seed(&f, &id, "失败保全报告");
    let a = report_save_prepared(&f, &id);
    let original = fs::read(f.vault.join("Note.md")).unwrap();
    f.c().execute_batch("CREATE TRIGGER fail_report_intent BEFORE UPDATE OF state ON agent_actions WHEN NEW.state='executing' BEGIN SELECT RAISE(ABORT,'intent unavailable'); END;").unwrap();
    assert!(submit_action(&f, &id, &a).is_err());
    assert_eq!(fs::read(f.vault.join("Note.md")).unwrap(), original);
    f.c()
        .execute_batch("DROP TRIGGER fail_report_intent;")
        .unwrap();
    let w = store::load(&f.c(), &id).unwrap();
    journal_execution(
        &f.root,
        &w,
        &a,
        &json!({"operationId":a.id,"fileVerified":false,"goalCompleted":false}),
    )
    .unwrap();
    fs::write(f.vault.join("Note.md"), "未知写入后又出现的新内容\n").unwrap();
    let v = ui(&f.root, &json!({"action":"status","id":id})).unwrap();
    assert_eq!(v["actions"]["items"][0]["state"], "needs_review");
    assert!(submit_action(&f, &id, &a).is_err());
    assert_eq!(
        fs::read_to_string(f.vault.join("Note.md")).unwrap(),
        "未知写入后又出现的新内容\n"
    );
}

fn report_undo_prepared(f: &Fixture, id: &str, saved: &Action) -> Action {
    ui(
        &f.root,
        &json!({"action":"restoreObsidianEdit","id":id,"actionId":saved.id}),
    )
    .unwrap();
    let action: String = f
        .c()
        .query_row(
            "SELECT id FROM agent_actions ORDER BY rowid DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    load(&f.c(), id, &action).unwrap()
}
fn append_later(f: &Fixture, text: &str) {
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .append(true)
        .open(f.vault.join("Note.md"))
        .unwrap();
    file.write_all(text.as_bytes()).unwrap();
    file.sync_all().unwrap();
}

#[test]
fn report_undo_preserves_later_text_and_original_receipt_with_distinct_idempotent_confirmation() {
    let (f, id) = setup(false);
    let original = fs::read_to_string(f.vault.join("Note.md")).unwrap();
    report_save_seed(&f, &id, "待撤回的报告");
    let saved = report_save_prepared(&f, &id);
    submit_action(&f, &id, &saved).unwrap();
    let old_receipt = load(&f.c(), &id, &saved.id).unwrap().receipt;
    append_later(&f, "\n用户保存后新增的正文，必须保留。\n");
    let before_preview = fs::read(f.vault.join("Note.md")).unwrap();
    let undo = report_undo_prepared(&f, &id, &saved);
    assert_ne!(undo.id, saved.id);
    assert_eq!(fs::read(f.vault.join("Note.md")).unwrap(), before_preview);
    assert_eq!(report_undo_prepared(&f, &id, &saved).id, undo.id);
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM agent_actions", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert!(ui(&f.root,&json!({"action":"submitObsidianEdit","id":id,"actionId":undo.id,"confirmationToken":token(&saved)})).is_err());
    let v = submit_action(&f, &id, &undo).unwrap();
    assert_eq!(
        fs::read_to_string(f.vault.join("Note.md")).unwrap(),
        format!("{original}\n用户保存后新增的正文，必须保留。\n")
    );
    let actual = load(&f.c(), &id, &undo.id).unwrap();
    assert_eq!(actual.state, "verified");
    let receipt = actual.receipt.unwrap();
    assert_eq!(receipt["operation"], "removeSavedReportAppend");
    assert_eq!(receipt["restoresActionId"], saved.id);
    assert_eq!(receipt["goalCompleted"], false);
    assert_eq!(load(&f.c(), &id, &saved.id).unwrap().receipt, old_receipt);
    assert_eq!(v["actions"]["items"][0]["canRestore"], false);
    let modified = fs::metadata(f.vault.join("Note.md"))
        .unwrap()
        .modified()
        .unwrap();
    submit_action(&f, &id, &undo).unwrap();
    report_undo_prepared(&f, &id, &saved);
    assert_eq!(
        fs::metadata(f.vault.join("Note.md"))
            .unwrap()
            .modified()
            .unwrap(),
        modified
    );
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM agent_actions", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
}

#[test]
fn report_undo_refuses_changed_original_or_report_and_requires_new_approval_for_new_base() {
    for change_report in [false, true] {
        let (f, id) = setup(false);
        report_save_seed(&f, &id, "报告原句");
        let saved = report_save_prepared(&f, &id);
        submit_action(&f, &id, &saved).unwrap();
        let current = fs::read_to_string(f.vault.join("Note.md")).unwrap();
        let changed = if change_report {
            current.replace("报告原句", "用户修改报告")
        } else {
            current.replace("测量后再加工。", "修改了原文。")
        };
        fs::write(f.vault.join("Note.md"), &changed).unwrap();
        assert!(ui(
            &f.root,
            &json!({"action":"restoreObsidianEdit","id":id,"actionId":saved.id})
        )
        .is_err());
        assert_eq!(
            fs::read_to_string(f.vault.join("Note.md")).unwrap(),
            changed
        );
        assert_eq!(
            f.c()
                .query_row("SELECT COUNT(*) FROM agent_actions", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    let (f, id) = setup(false);
    let original = fs::read_to_string(f.vault.join("Note.md")).unwrap();
    report_save_seed(&f, &id, "新基线报告");
    let saved = report_save_prepared(&f, &id);
    submit_action(&f, &id, &saved).unwrap();
    let first = report_undo_prepared(&f, &id, &saved);
    append_later(&f, "\n预览后新加的正文\n");
    assert!(submit_action(&f, &id, &first).is_err());
    let second = report_undo_prepared(&f, &id, &saved);
    assert_ne!(first.id, second.id);
    assert!(submit_action(&f, &id, &first).is_err());
    assert_eq!(load(&f.c(), &id, &first.id).unwrap().payload, first.payload);
    submit_action(&f, &id, &second).unwrap();
    assert_eq!(
        fs::read_to_string(f.vault.join("Note.md")).unwrap(),
        format!("{original}\n预览后新加的正文\n")
    );
}

#[test]
fn report_undo_unknown_before_and_after_write_recovers_without_repeating_side_effect() {
    for written in [false, true] {
        let (f, id) = setup(false);
        report_save_seed(&f, &id, "未知撤回");
        let saved = report_save_prepared(&f, &id);
        submit_action(&f, &id, &saved).unwrap();
        append_later(&f, "\n后续正文\n");
        let undo = report_undo_prepared(&f, &id, &saved);
        let c = f.c();
        let w = store::load(&c, &id).unwrap();
        let p = undo.payload.as_ref().unwrap();
        let base = snapshot(p).unwrap();
        let after = p["after"].as_str().unwrap();
        let receipt = json!({"domain":"obsidianNoteEdit","operationId":undo.id,"operation":"removeSavedReportAppend","restoresActionId":saved.id,"beforeHash":base.hash,"afterHash":files::hash(after.as_bytes()),"fileVerified":false,"goalCompleted":false});
        let mut locked = files::LockedNote::open(&c, &base).unwrap();
        journal_execution(&f.root, &w, &undo, &receipt).unwrap();
        if written {
            locked.write(after).unwrap();
        }
        drop(locked);
        drop(c);
        let bytes = fs::read(f.vault.join("Note.md")).unwrap();
        let modified = fs::metadata(f.vault.join("Note.md"))
            .unwrap()
            .modified()
            .unwrap();
        let v = ui(&f.root, &json!({"action":"status","id":id})).unwrap();
        assert_eq!(
            v["actions"]["items"][0]["state"],
            if written { "verified" } else { "interrupted" }
        );
        assert_eq!(fs::read(f.vault.join("Note.md")).unwrap(), bytes);
        assert_eq!(
            fs::metadata(f.vault.join("Note.md"))
                .unwrap()
                .modified()
                .unwrap(),
            modified
        );
        if !written {
            submit_action(&f, &id, &undo).unwrap();
        }
        assert_eq!(fs::read_to_string(f.vault.join("Note.md")).unwrap(), after);
        assert!(fs::read_to_string(f.vault.join("Note.md"))
            .unwrap()
            .contains("后续正文"));
    }
}

#[test]
fn report_undo_refuses_revoked_damaged_backup_and_replaced_file() {
    for failure in ["revoked", "backup", "replacement"] {
        let (f, id) = setup(false);
        report_save_seed(&f, &id, "受保护的撤回");
        let saved = report_save_prepared(&f, &id);
        submit_action(&f, &id, &saved).unwrap();
        let original = fs::read(f.vault.join("Note.md")).unwrap();
        match failure {
            "revoked" => {
                ui(&f.root, &json!({"action":"revoke","id":id})).unwrap();
            }
            "backup" => {
                let mut payload = saved.payload.clone().unwrap();
                payload["snapshot"]["rawBase64"] = json!("invalid");
                f.c()
                    .execute(
                        "UPDATE agent_actions SET payload_json=?2 WHERE id=?1",
                        params![saved.id, payload.to_string()],
                    )
                    .unwrap();
            }
            _ => {
                fs::rename(f.vault.join("Note.md"), f.vault.join("Old.md")).unwrap();
                fs::write(f.vault.join("Note.md"), &original).unwrap();
            }
        }
        assert!(
            ui(
                &f.root,
                &json!({"action":"restoreObsidianEdit","id":id,"actionId":saved.id})
            )
            .is_err(),
            "{failure}"
        );
        assert_eq!(fs::read(f.vault.join("Note.md")).unwrap(), original);
        if failure == "revoked" {
            let v = ui(&f.root, &json!({"action":"status","id":id})).unwrap();
            assert!(!v.to_string().contains("受保护的撤回"));
        }
    }
}

#[test]
fn report_undo_conflict_review_reprepares_current_base_and_requires_its_own_approval() {
    let (f, id) = setup(false);
    let original = fs::read_to_string(f.vault.join("Note.md")).unwrap();
    report_save_seed(&f, &id, "冲突恢复报告");
    let saved = report_save_prepared(&f, &id);
    submit_action(&f, &id, &saved).unwrap();
    let old_receipt = load(&f.c(), &id, &saved.id).unwrap().receipt;
    let first = report_undo_prepared(&f, &id, &saved);
    let old_payload = first.payload.clone();
    append_later(&f, "\n预览之后用户新增的正文\n");
    let current = fs::read_to_string(f.vault.join("Note.md")).unwrap();
    let modified = fs::metadata(f.vault.join("Note.md"))
        .unwrap()
        .modified()
        .unwrap();
    let v = ui(&f.root, &json!({"action":"status","id":id})).unwrap();
    let old_view = v["actions"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["id"] == first.id)
        .unwrap();
    assert_eq!(old_view["state"], "expired");
    assert!(old_view["confirmationToken"].is_null());
    assert_eq!(
        old_view["payload"]["before"],
        old_payload.as_ref().unwrap()["snapshot"]["before"]
    );
    assert_eq!(
        old_view["payload"]["after"],
        old_payload.as_ref().unwrap()["after"]
    );
    assert_eq!(old_view["conflict"]["current"], current);
    assert_eq!(
        old_view["conflict"]["currentHash"],
        files::hash(current.as_bytes())
    );
    assert_eq!(
        old_view["conflict"]["baseHash"],
        old_payload.as_ref().unwrap()["snapshot"]["hash"]
    );
    assert_eq!(old_view["conflict"]["reprepareActionId"], saved.id);
    assert!(submit_action(&f, &id, &first).is_err());
    let v = ui(&f.root, &json!({"action":"restoreObsidianEdit","id":id,"actionId":old_view["conflict"]["reprepareActionId"]})).unwrap();
    let second_id = v["actions"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["state"] == "prepared" && a["payload"]["mode"] == "reportUndo")
        .unwrap()["id"]
        .as_str()
        .unwrap();
    let second = load(&f.c(), &id, second_id).unwrap();
    assert_ne!(first.id, second.id);
    assert_eq!(
        second.payload.as_ref().unwrap()["snapshot"]["before"],
        current
    );
    assert_eq!(load(&f.c(), &id, &first.id).unwrap().payload, old_payload);
    assert!(ui(&f.root, &json!({"action":"submitObsidianEdit","id":id,"actionId":second.id,"confirmationToken":token(&first)})).is_err());
    assert!(submit_action(&f, &id, &first).is_err());
    assert_eq!(
        fs::read_to_string(f.vault.join("Note.md")).unwrap(),
        current
    );
    assert_eq!(
        fs::metadata(f.vault.join("Note.md"))
            .unwrap()
            .modified()
            .unwrap(),
        modified
    );
    submit_action(&f, &id, &second).unwrap();
    assert_eq!(
        fs::read_to_string(f.vault.join("Note.md")).unwrap(),
        format!("{original}\n预览之后用户新增的正文\n")
    );
    assert_eq!(load(&f.c(), &id, &saved.id).unwrap().receipt, old_receipt);
    assert_eq!(load(&f.c(), &id, &first.id).unwrap().payload, old_payload);
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM agent_actions", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        3
    );
}

#[test]
fn report_undo_conflict_review_never_merges_changed_content_or_exposes_revoked_or_replaced_files() {
    for failure in ["original", "report", "revoked", "replacement"] {
        let (f, id) = setup(false);
        report_save_seed(&f, &id, "只读冲突报告");
        let saved = report_save_prepared(&f, &id);
        submit_action(&f, &id, &saved).unwrap();
        let first = report_undo_prepared(&f, &id, &saved);
        let current = fs::read_to_string(f.vault.join("Note.md")).unwrap();
        match failure {
            "original" => fs::write(
                f.vault.join("Note.md"),
                current.replace("测量后再加工。", "用户改了原文。"),
            )
            .unwrap(),
            "report" => fs::write(
                f.vault.join("Note.md"),
                current.replace("只读冲突报告", "用户改了报告"),
            )
            .unwrap(),
            "revoked" => {
                ui(&f.root, &json!({"action":"revoke","id":id})).unwrap();
            }
            _ => {
                fs::rename(f.vault.join("Note.md"), f.vault.join("Old.md")).unwrap();
                fs::write(f.vault.join("Note.md"), "REPLACED_PRIVATE_SENTINEL").unwrap();
            }
        }
        let bytes = fs::read(f.vault.join("Note.md")).unwrap();
        let modified = fs::metadata(f.vault.join("Note.md"))
            .unwrap()
            .modified()
            .unwrap();
        let v = ui(&f.root, &json!({"action":"status","id":id})).unwrap();
        let row = v["actions"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["id"] == first.id)
            .unwrap();
        assert!(row["confirmationToken"].is_null(), "{failure}");
        assert!(row["conflict"]["reprepareActionId"].is_null(), "{failure}");
        if failure == "revoked" {
            assert!(row["payload"].is_null());
            assert!(row["conflict"].is_null());
        } else if failure == "replacement" {
            assert!(row["conflict"]["current"].is_null());
            assert!(!row.to_string().contains("REPLACED_PRIVATE_SENTINEL"));
        } else {
            assert_eq!(
                row["conflict"]["current"],
                String::from_utf8(bytes.clone()).unwrap()
            );
            assert!(row["conflict"]["unavailableReason"]
                .as_str()
                .unwrap()
                .contains("不能自动撤回"));
        }
        assert!(submit_action(&f, &id, &first).is_err());
        assert_eq!(fs::read(f.vault.join("Note.md")).unwrap(), bytes);
        assert_eq!(
            fs::metadata(f.vault.join("Note.md"))
                .unwrap()
                .modified()
                .unwrap(),
            modified
        );
    }
}

#[test]
fn ordinary_expired_note_edit_does_not_gain_report_undo_conflict_capability() {
    let (f, id) = setup(false);
    let draft = prepared(&f, &id, "普通修改草稿。\n");
    append_later(&f, "\n普通修改之后的正文\n");
    let v = ui(&f.root, &json!({"action":"status","id":id})).unwrap();
    let row = v["actions"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["id"] == draft.id)
        .unwrap();
    assert_eq!(row["state"], "expired");
    assert!(row["conflict"].is_null());
    assert!(row["confirmationToken"].is_null());
}

// Explicit saved-fixture qualification, not part of the default regression set.
// Calls the same ui dispatcher used by the GUI; no file/import/receipt mocks.
#[test]
#[ignore = "requires the preserved S5 isolated profile and HUB_V2_A93_EVIDENCE_ROOT"]
fn saved_s5_importer_failure_recovers_without_replaying_source_write() {
    let evidence = std::path::PathBuf::from(
        std::env::var_os("HUB_V2_A93_EVIDENCE_ROOT").expect("explicit saved evidence root"),
    );
    let init: Value =
        serde_json::from_slice(&fs::read(evidence.join("initialization.json")).unwrap()).unwrap();
    let root = std::path::PathBuf::from(init["profile"].as_str().unwrap());
    let file = std::path::PathBuf::from(init["target"].as_str().unwrap());
    let output = evidence.join("backend");
    assert!(root.join(".hub-isolated-runtime-v1").is_file());
    assert!(
        !output.join("before-proof.json").exists(),
        "preserve first attempt"
    );
    let work = init["workId"].as_str().unwrap();
    let action = init["actionId"].as_str().unwrap();
    let initial = fs::read(evidence.join("native/initial-target.md")).unwrap();
    let expected = fs::read(evidence.join("native/expected-after.md")).unwrap();
    assert_eq!(fs::read(&file).unwrap(), initial);
    let record = |name: &str, value: &Value| {
        fs::write(output.join(name), serde_json::to_vec_pretty(value).unwrap()).unwrap();
    };
    let capture = |phase: &str| -> Value {
        let c = crate::source_evidence::open_read_database(&root).unwrap();
        let a = load(&c, work, action).unwrap();
        let p = a.payload.as_ref().unwrap();
        let base = snapshot(p).unwrap();
        let mut q = c
            .prepare("SELECT id FROM agent_actions ORDER BY id")
            .unwrap();
        let ids: Vec<String> = q
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        drop(q);
        let all: Vec<Value> = ids
            .iter()
            .map(|id| serde_json::to_value(load(&c, work, id).unwrap()).unwrap())
            .collect();
        let other: Vec<&Value> = all.iter().filter(|a| a["id"] != action).collect();
        let cache: String = c
            .query_row(
                "SELECT content_hash FROM documents WHERE space_id=?1 AND id=?2",
                params![base.library_id, base.document_id],
                |r| r.get(0),
            )
            .unwrap();
        let runs: i64 = c
            .query_row("SELECT COUNT(*) FROM agent_runs", [], |r| r.get(0))
            .unwrap();
        let triggers: i64 = c.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name IN ('v2_s5_a93_block_document_insert','v2_s5_a93_block_document_update')",[],|r|r.get(0)).unwrap();
        let bytes = fs::read(&file).unwrap();
        let modified = fs::metadata(&file)
            .unwrap()
            .modified()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
            .to_string();
        let result = json!({"phase":phase,"action":a,"otherActions":other,"actionCount":all.len(),"runCount":runs,"cacheHash":cache,"faultTriggers":triggers,"targetHash":files::hash(&bytes),"targetMtimeNs":modified,"reportMarkerCount":String::from_utf8_lossy(&bytes).matches("<!-- hub-report:").count()});
        c.backup("main", output.join(format!("{phase}.sqlite3")), None)
            .unwrap();
        fs::write(output.join(format!("{phase}-target.md")), bytes).unwrap();
        record(&format!("{phase}-proof.json"), &result);
        result
    };
    let view = ui(&root, &json!({"action":"status","id":work})).unwrap();
    let row = view["actions"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["id"] == action)
        .unwrap();
    assert_eq!(row["state"], "prepared");
    let confirmation = row["confirmationToken"]
        .as_str()
        .expect("host-issued confirmation")
        .to_owned();
    let before = capture("before");
    assert_eq!(before["actionCount"], 3);
    assert_eq!(before["runCount"], 1);
    assert_eq!(before["faultTriggers"], 2);
    assert_ne!(before["cacheHash"], files::hash(&expected));
    let reply = ui(&root,&json!({"action":"submitObsidianEdit","id":work,"actionId":action,"confirmationToken":confirmation})).unwrap();
    record("submit-view.json", &reply);
    let pending = capture("pending");
    assert_eq!(fs::read(&file).unwrap(), expected);
    assert_eq!(pending["action"]["state"], "saved");
    assert_eq!(pending["action"]["receipt"]["fileVerified"], true);
    assert_eq!(pending["action"]["receipt"]["indexed"], false);
    assert_ne!(pending["cacheHash"], pending["targetHash"]);
    assert_eq!(pending["faultTriggers"], 2);
    assert_eq!(pending["actionCount"], before["actionCount"]);
    assert_eq!(pending["runCount"], before["runCount"]);
    assert_eq!(pending["otherActions"], before["otherActions"]);
    let modified = fs::metadata(&file).unwrap().modified().unwrap();
    let (c, _writer) = crate::open_write_database(&root.join("craft-search.sqlite3")).unwrap();
    c.execute_batch("DROP TRIGGER v2_s5_a93_block_document_insert; DROP TRIGGER v2_s5_a93_block_document_update;").unwrap();
    drop(c);
    drop(_writer);
    let unblocked = capture("fault-removed");
    assert_eq!(unblocked["action"], pending["action"]);
    assert_eq!(unblocked["cacheHash"], pending["cacheHash"]);
    assert_eq!(unblocked["targetHash"], pending["targetHash"]);
    assert_eq!(unblocked["targetMtimeNs"], pending["targetMtimeNs"]);
    let reply = ui(
        &root,
        &json!({"action":"inspectObsidianEdit","id":work,"actionId":action}),
    )
    .unwrap();
    record("inspect-view.json", &reply);
    let recovered = capture("recovered");
    assert_eq!(fs::read(&file).unwrap(), expected);
    assert_eq!(fs::metadata(&file).unwrap().modified().unwrap(), modified);
    assert_eq!(recovered["action"]["id"], pending["action"]["id"]);
    assert_eq!(recovered["action"]["payload"], before["action"]["payload"]);
    assert_eq!(recovered["action"]["state"], "verified");
    assert_eq!(recovered["action"]["receipt"]["fileVerified"], true);
    assert_eq!(recovered["action"]["receipt"]["indexed"], true);
    assert_eq!(
        recovered["action"]["receipt"]["confirmedAt"],
        pending["action"]["receipt"]["confirmedAt"]
    );
    assert_eq!(recovered["targetHash"], pending["targetHash"]);
    assert_eq!(recovered["targetMtimeNs"], pending["targetMtimeNs"]);
    assert_eq!(recovered["reportMarkerCount"], pending["reportMarkerCount"]);
    assert_eq!(recovered["reportMarkerCount"], 0);
    assert_eq!(recovered["cacheHash"], recovered["targetHash"]);
    assert_eq!(recovered["faultTriggers"], 0);
    assert_eq!(recovered["actionCount"], before["actionCount"]);
    assert_eq!(recovered["runCount"], before["runCount"]);
    assert_eq!(recovered["otherActions"], before["otherActions"]);
    assert_eq!(recovered["action"]["receipt"]["goalCompleted"], false);
    record(
        "case-complete.json",
        &json!({"passed":true,"evidenceLevel":"deterministic_backend_integration","entry":"agent_work::ui","submits":1,"recoveryChecks":1,"newActions":0,"newRuns":0,"models":0,"applicationBuilds":0,"sourceBytesAndMtimeUnchangedDuringRecovery":true}),
    );
}
