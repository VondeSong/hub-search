use super::*;
use crate::source_evidence::tests::Fixture;

#[test]
fn user_cancel_preserves_real_action_receipts_and_recovery_blocks_unknown_results() {
    let (f, id) = setup();
    let a = prepared(&f, &id);
    confirm(&f, &id, &a);
    let original = receipts(&f.root, &id).unwrap();
    let proposals = count(&f, "tag_assignment_proposals");
    let command = |kind: &str, key: &str| {
        let s = store::view(&f.root, &id).unwrap();
        json!({"action":kind,"id":id,"commandId":key,"expectedControlRevision":s["lifecycle"]["controlRevision"],
            "expectedWorkRevision":s["work"]["revision"],"expectedRunId":s["lifecycle"]["activeRunId"]})
    };
    ui(&f.root, &command("cancelGoal", "cancel")).unwrap();
    assert_eq!(receipts(&f.root, &id).unwrap(), original);
    assert!(claim(&f.root, &id, "focus").is_err());
    // Simulate an unresolved persisted action, without invoking a remote service.
    f.c()
        .execute(
            "UPDATE agent_actions SET state='unknown' WHERE id=?1",
            [&a.id],
        )
        .unwrap();
    let blocked = store::view(&f.root, &id).unwrap();
    assert_eq!(blocked["lifecycle"]["canResume"], false);
    assert!(
        store::lifecycle::resume(&f.root, &id, "blocked", &command("resume", "blocked")).is_err()
    );
    f.c()
        .execute(
            "UPDATE agent_actions SET state='verified' WHERE id=?1",
            [&a.id],
        )
        .unwrap();
    store::lifecycle::resume(&f.root, &id, "recovered", &command("resume", "resume"))
        .unwrap()
        .unwrap();
    assert_eq!(receipts(&f.root, &id).unwrap(), original);
    assert_eq!(count(&f, "tag_assignment_proposals"), proposals);
    assert_eq!(count(&f, "agent_actions"), 1);
}

fn setup() -> (Fixture, String) {
    let f = Fixture::new();
    f.note(
        "notes",
        "current",
        "检查配合条件 😀单位为毫米，先测量再决定加工。",
    );
    f.note("private", "secret", "PRIVATE_ACTION_SENTINEL");
    // The catalog tag is produced by the normal Obsidian document importer.
    let document = crate::LocalMarkdownDocument {
        id: "seed".into(),
        title: "seed".into(),
        relative_path: "seed.md".into(),
        folder_path: None,
        markdown: "#focus".into(),
        modified_at: 1,
        content_hash: "seed-hash".into(),
        aliases: vec![],
        tags: vec!["focus".into()],
        attachments: vec![],
    };
    let mut c = f.c();
    let tx = c.transaction().unwrap();
    crate::upsert_obsidian_document(&tx, "notes", &document, 1).unwrap();
    tx.commit().unwrap();
    drop(c);
    define(&f.root, 0);
    let id = super::super::tests::create(&f, false);
    (f, id)
}
fn define(root: &Path, version: i64) {
    tags::ui(root,&json!({"action":"save_definition","tag":"focus","expectedVersion":version,
        "definition":{"description":"装配验证","include":"测量和配合条件","exclude":"无关主题","libraryIds":["notes"]}})).unwrap();
}
fn draft() -> Value {
    json!({"decision":"recommend_add","quote":"检查配合条件","rationale":"正文明确记录装配验证条件","risks":"仅核对提供的节选，未向远端核验","confidence":0.8,"reconsiderationReason":""})
}
fn prepared(f: &Fixture, id: &str) -> Action {
    let (w, action, context) = claim(&f.root, id, "FOCUS").unwrap();
    prepare_with(
        &f.root,
        &w,
        &action,
        &context,
        &Control::bounded(Duration::from_secs(5)),
        &json!({"model":"fixture"}),
        |prompt, schema| {
            let data: Value =
                serde_json::from_str(prompt.split("宿主材料(JSON):\n").nth(1).unwrap()).unwrap();
            assert_eq!(data["purpose"], "prepareTagProposal");
            assert_eq!(
                data["selectedTagEvidence"]["source"]["documentId"],
                "current"
            );
            assert!(!prompt.contains("PRIVATE_ACTION_SENTINEL"));
            assert_eq!(schema["additionalProperties"], false);
            assert!(schema["properties"].get("source").is_none());
            Ok(draft())
        },
    )
    .unwrap();
    load(&f.c(), id, &action).unwrap()
}
fn count(f: &Fixture, table: &str) -> i64 {
    f.c()
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}
fn confirm(f: &Fixture, id: &str, a: &Action) -> Value {
    ui(
        &f.root,
        &json!({"action":"submitTagProposal","id":id,"actionId":a.id,"confirmationToken":token(a)}),
    )
    .unwrap()
}
#[test]
fn prepare_is_scoped_immutable_and_has_no_business_write() {
    let (f, id) = setup();
    let a = prepared(&f, &id);
    assert_eq!(a.state, "prepared");
    assert_eq!(a.payload.as_ref().unwrap()["tag"], "focus");
    assert_eq!(count(&f, "tag_assignment_proposals"), 0);
    assert_eq!(count(&f, "hub_content_tags"), 0);
    let view = ui(&f.root, &json!({"action":"status","id":id})).unwrap();
    assert_eq!(view["actions"]["items"][0]["confirmationToken"], token(&a));
    assert_eq!(view["actions"]["tagOptions"], json!(["focus"]));
    assert!(a.payload.unwrap()["idempotencyKey"]
        .as_str()
        .unwrap()
        .starts_with("agent:action-"));
}

#[test]
fn receipt_hints_follow_review_versions_without_reading_proposal_bodies() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    let (f, id) = setup();
    let a = prepared(&f, &id);
    let result = confirm(&f, &id, &a);
    let proposal = result["actions"]["items"][0]["receipt"]["result"]["proposal"]["proposalId"]
        .as_str()
        .unwrap();
    let c = f.c();
    c.authorizer(Some(|ctx: AuthContext<'_>| match ctx.action {
        AuthAction::Read {
            column_name: "proposal_json" | "markdown" | "post_json",
            ..
        } => Authorization::Deny,
        _ => Authorization::Allow,
    }));
    let before = receipt_hints_on(&c, &id).unwrap();
    assert!(!before.to_string().contains("检查配合条件"));
    let preview = tags::ui(&f.root, &json!({"action":"preview","proposalId":proposal})).unwrap();
    tags::ui(&f.root,&json!({"action":"resolve","proposalId":proposal,"resolution":"reject","reviewToken":preview["reviewToken"]})).unwrap();
    let after = receipt_hints_on(&c, &id).unwrap();
    assert_ne!(before, after);
    assert_eq!(after[0]["current"]["status"], "rejected");
    assert_eq!(count(&f, "hub_content_tags"), 0);
}
#[test]
fn confirmation_is_bound_to_work_and_exact_stored_draft() {
    let (f, id) = setup();
    let a = prepared(&f, &id);
    for (work, confirmation) in [(&*id, "forged"), ("another-work", &*token(&a))] {
        assert!(submit(&f.root, work, &a.id, confirmation).is_err());
    }
    let response=ui(&f.root,&json!({"action":"submitTagProposal","id":id,"actionId":a.id,"confirmationToken":token(&a),"payload":{"tag":"another","quote":"forged"}})).unwrap();
    assert_eq!(
        response["actions"]["items"][0]["receipt"]["result"]["proposal"]["tag"],
        "focus"
    );
    assert_eq!(count(&f, "tag_assignment_proposals"), 1);
}
#[test]
fn confirmed_submission_uses_existing_review_and_survives_revoke_without_replaying() {
    let (f, id) = setup();
    let a = prepared(&f, &id);
    let source_before =
        tags::agent_context_on(&f.c(), "focus", &a.payload.as_ref().unwrap()["source"]).unwrap();
    let first = confirm(&f, &id, &a);
    assert_ne!(first["work"]["state"], "completed");
    assert_eq!(
        first["actions"]["items"][0]["receipt"]["goalCompleted"],
        false
    );
    assert_eq!(count(&f, "tag_assignment_proposals"), 1);
    assert_eq!(count(&f, "hub_content_tags"), 0);
    let proposal_id = first["actions"]["items"][0]["receipt"]["result"]["proposal"]["proposalId"]
        .as_str()
        .unwrap();
    let listed = tags::ui(&f.root, &json!({"action":"list","tag":"focus"})).unwrap();
    assert_eq!(listed["proposals"][0]["proposalId"], proposal_id);
    let preview = tags::ui(
        &f.root,
        &json!({"action":"preview","proposalId":proposal_id}),
    )
    .unwrap();
    tags::ui(&f.root,&json!({"action":"resolve","proposalId":proposal_id,"resolution":"accept","reviewToken":preview["reviewToken"]})).unwrap();
    assert_eq!(count(&f, "hub_content_tags"), 1);
    ui(&f.root, &json!({"action":"revoke","id":id})).unwrap();
    let replay = confirm(&f, &id, &a);
    assert_eq!(count(&f, "tag_assignment_proposals"), 1);
    assert_eq!(
        replay["actions"]["items"][0]["currentProposal"]["status"],
        "accepted"
    );
    let source_after =
        tags::agent_context_on(&f.c(), "focus", &a.payload.as_ref().unwrap()["source"]).unwrap();
    assert_eq!(source_before["sourceHash"], source_after["sourceHash"]);
    assert_eq!(source_before["sourceTags"], source_after["sourceTags"]);
}
#[test]
fn source_definition_decision_and_revoke_each_expire_confirmation() {
    for mutation in ["source", "definition", "decision", "revoke"] {
        let (f, id) = setup();
        let a = prepared(&f, &id);
        match mutation {
            "source" => f.note("notes", "current", "修订后的当前正文"),
            "definition" => define(&f.root, 1),
            "decision" => store::decision(&f.root, &id, "暂停补标").unwrap(),
            _ => store::revoke(&f.root, &id).unwrap(),
        }
        assert!(
            submit(&f.root, &id, &a.id, &token(&a)).is_err(),
            "{mutation}"
        );
        let view = ui(&f.root, &json!({"action":"status","id":id})).unwrap();
        assert_eq!(view["actions"]["items"][0]["state"], "expired");
        assert!(view["actions"]["items"][0]["payload"].is_null());
        assert!(view["actions"]["items"][0]
            .get("confirmationToken")
            .is_none());
        assert_eq!(count(&f, "tag_assignment_proposals"), 0);
    }
}
#[test]
fn atomic_domain_and_receipt_commit_rolls_back_both_on_failure() {
    let (f, id) = setup();
    let a = prepared(&f, &id);
    f.c().execute_batch("CREATE TRIGGER reject_agent_receipt BEFORE UPDATE OF receipt_json ON agent_actions WHEN NEW.receipt_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'receipt failure'); END;").unwrap();
    assert!(submit(&f.root, &id, &a.id, &token(&a)).is_err());
    assert_eq!(count(&f, "tag_assignment_proposals"), 0);
    assert_eq!(load(&f.c(), &id, &a.id).unwrap().state, "prepared");
    f.c()
        .execute_batch("DROP TRIGGER reject_agent_receipt")
        .unwrap();
    confirm(&f, &id, &a);
    confirm(&f, &id, &a);
    assert_eq!(count(&f, "tag_assignment_proposals"), 1);
    assert!(tags::submit_on(&f.c(), a.payload.as_ref().unwrap()).is_err());
}
#[test]
fn domain_deduplication_receipt_reports_actual_existing_rejection() {
    let (f, id) = setup();
    let a = prepared(&f, &id);
    let b = prepared(&f, &id);
    let mut other = a.payload.clone().unwrap();
    other["idempotencyKey"] = json!("outside-agent");
    other["decision"] = json!("related_only");
    let c = f.c();
    c.execute_batch("BEGIN IMMEDIATE").unwrap();
    let existing = tags::submit_on(&c, &other).unwrap();
    c.execute_batch("COMMIT").unwrap();
    drop(c);
    let view = confirm(&f, &id, &a);
    assert_eq!(
        view["actions"]["items"][1]["receipt"]["result"]["existing"],
        true
    );
    let proposal_id = existing["proposal"]["proposalId"].as_str().unwrap();
    let preview = tags::ui(
        &f.root,
        &json!({"action":"preview","proposalId":proposal_id}),
    )
    .unwrap();
    tags::ui(&f.root,&json!({"action":"resolve","proposalId":proposal_id,"resolution":"reject","reviewToken":preview["reviewToken"],"note":"不采用"})).unwrap();
    // The unsubmitted draft sees changed review history, never silently creates a new card.
    assert!(submit(&f.root, &id, &b.id, &token(&b)).is_err());
    let current = ui(&f.root, &json!({"action":"status","id":id})).unwrap();
    assert_eq!(
        current["actions"]["items"][1]["currentProposal"]["status"],
        "rejected"
    );
    assert_eq!(count(&f, "tag_assignment_proposals"), 1);
}
#[test]
fn preparation_rejects_fabricated_or_outside_excerpt_quotes_and_model_authority() {
    for invalid in ["quote", "source", "confirmation", "scope"] {
        let (f, id) = setup();
        f.note(
            "notes",
            "current",
            &format!("检查配合条件{}仅全文末尾可见", "x".repeat(6100)),
        );
        let (w, action, context) = claim(&f.root, &id, "focus").unwrap();
        let result = prepare_with(
            &f.root,
            &w,
            &action,
            &context,
            &Control::default(),
            &json!({"model":"fixture"}),
            |_, _| {
                let mut v = draft();
                match invalid {
                    "quote" => v["quote"] = json!("仅全文末尾可见"),
                    "source" => v["source"] = json!({"documentId":"secret"}),
                    "confirmation" => v["confirmationToken"] = json!("model-issued"),
                    _ => v["grant"] = json!({"libraryIds":["private"]}),
                }
                Ok(v)
            },
        );
        assert!(result.is_err(), "{invalid}");
        assert_eq!(count(&f, "tag_assignment_proposals"), 0);
        assert!(load(&f.c(), &id, &action).unwrap().payload.is_none());
    }
}
#[test]
fn cancellation_and_changed_inputs_during_generation_prevent_draft_publication() {
    for mutation in ["cancel", "source", "definition", "decision"] {
        let (f, id) = setup();
        let (w, action, context) = claim(&f.root, &id, "focus").unwrap();
        let control = Control::default();
        let result = prepare_with(
            &f.root,
            &w,
            &action,
            &context,
            &control,
            &json!({"model":"fixture"}),
            |_, _| {
                match mutation {
                    "cancel" => control.cancel(),
                    "source" => f.note("notes", "current", "新正文"),
                    "definition" => define(&f.root, 1),
                    _ => store::decision(&f.root, &id, "保留原方案").unwrap(),
                }
                Ok(draft())
            },
        );
        assert!(result.is_err(), "{mutation}");
        assert!(load(&f.c(), &id, &action).unwrap().payload.is_none());
        assert_eq!(count(&f, "tag_assignment_proposals"), 0);
    }
}
#[test]
fn restart_interrupts_only_orphan_preparations_and_preserves_confirmed_results() {
    let (f, id) = setup();
    let a = prepared(&f, &id);
    confirm(&f, &id, &a);
    let (_, orphan, _) = claim(&f.root, &id, "focus").unwrap();
    let (_, live, _) = claim(&f.root, &id, "focus").unwrap();
    reconcile(&f.root, &id, Some(&live)).unwrap();
    assert_eq!(load(&f.c(), &id, &orphan).unwrap().state, "interrupted");
    assert_eq!(load(&f.c(), &id, &live).unwrap().state, "preparing");
    reconcile(&f.root, &id, None).unwrap();
    assert_eq!(load(&f.c(), &id, &live).unwrap().state, "interrupted");
    assert_eq!(load(&f.c(), &id, &a.id).unwrap().state, "verified");
    assert_eq!(count(&f, "tag_assignment_proposals"), 1);
}
#[test]
fn v73_upgrade_keeps_work_and_backup_restore_keeps_draft_confirmation_and_receipt() {
    let (f, id) = setup();
    f.c()
        .execute_batch(
            "DROP TABLE agent_actions; UPDATE metadata SET value='73' WHERE key='schema_version';",
        )
        .unwrap();
    crate::database::forget_initialized_database(&f.root.join("craft-search.sqlite3"));
    drop(f.c());
    assert_eq!(
        store::load(&f.c(), &id).unwrap().goal,
        "核查安装方案、历史决定及缺失的验证条件，给出下一步"
    );
    let a = prepared(&f, &id);
    confirm(&f, &id, &a);
    let b = prepared(&f, &id);
    let base =
        std::env::temp_dir().join(format!("hub-action-backup-{}", crate::random_url_safe(10)));
    std::fs::create_dir(&base).unwrap();
    let cancel = std::sync::atomic::AtomicBool::new(false);
    let backup = crate::data_backup::backup(
        &f.root,
        &crate::data_backup::BackupOptions {
            destination: base
                .join("actions.hubbackup")
                .to_string_lossy()
                .into_owned(),
            include_external_sources: false,
        },
        &cancel,
        &mut |_| {},
    )
    .unwrap();
    let restored = base.join("restored");
    crate::data_backup::restore(Path::new(&backup.path), &restored, &cancel, &mut |_| {}).unwrap();
    drop(crate::database::open_database(&restored.join("craft-search.sqlite3")).unwrap());
    let c = crate::source_evidence::open_read_database(&restored).unwrap();
    assert_eq!(token(&load(&c, &id, &b.id).unwrap()), token(&b));
    assert_eq!(load(&c, &id, &a.id).unwrap().state, "verified");
    drop(c);
    submit(&restored, &id, &b.id, &token(&b)).unwrap();
    let view = ui(&restored, &json!({"action":"status","id":id})).unwrap();
    assert_eq!(
        view["actions"]["items"][0]["receipt"]["result"]["existing"],
        true
    );
    assert_eq!(base.parent(), Some(std::env::temp_dir().as_path()));
    std::fs::remove_dir_all(base).unwrap();
}
#[test]
fn continued_agent_consumes_real_receipts_and_review_changes_invalidate_delivery() {
    let (f, id) = setup();
    let a = prepared(&f, &id);
    confirm(&f, &id, &a);
    let (w, run) = super::super::tests::claim(&f, &id);
    runner::investigate(&f.root, &w, &run, &Control::default(), |prompt, _| {
        let material: Value =
            serde_json::from_str(prompt.split("宿主材料(JSON):\n").nth(1).unwrap()).unwrap();
        assert_eq!(
            material["businessActionRecords"][0]["currentStatus"],
            "pending"
        );
        assert_eq!(material["businessActionRecords"][0]["goalCompleted"], false);
        Ok(super::super::tests::report(prompt, "检查配合条件"))
    })
    .unwrap();
    assert_eq!(
        store::view(&f.root, &id).unwrap()["work"]["state"],
        "completed"
    );
    let facts = receipts(&f.root, &id).unwrap();
    let proposal_id = facts[0]["proposalId"].as_str().unwrap();
    let preview = tags::ui(
        &f.root,
        &json!({"action":"preview","proposalId":proposal_id}),
    )
    .unwrap();
    tags::ui(&f.root,&json!({"action":"resolve","proposalId":proposal_id,"resolution":"reject","reviewToken":preview["reviewToken"]})).unwrap();
    let view = ui(&f.root, &json!({"action":"status","id":id})).unwrap();
    assert_eq!(view["work"]["state"], "expired");
    assert!(view["work"]["report"].is_null());
    assert_eq!(
        view["actions"]["items"][0]["currentProposal"]["status"],
        "rejected"
    );
}

#[test]
#[ignore = "Opt-in authenticated Codex evaluation; synthetic notes and local pending-review proposal only"]
fn installed_codex_controlled_tag_action_evaluation() {
    let (f, id) = setup();
    if let Ok(settings) = std::env::var("HUB_AGENT_EVAL_SETTINGS") {
        std::fs::copy(settings, f.root.join("codex-suite-v1.json")).unwrap();
    }
    let prepared = ui(
        &f.root,
        &json!({"action":"prepareTagProposal","id":id,"tag":"focus"}),
    )
    .unwrap();
    assert_eq!(count(&f, "tag_assignment_proposals"), 0);
    let a = &prepared["actions"]["items"][0];
    assert_eq!(a["state"], "prepared");
    assert_eq!(a["payload"]["decision"], "recommend_add");
    let confirmation = json!({"action":"submitTagProposal","id":id,"actionId":a["id"],"confirmationToken":a["confirmationToken"]});
    let submitted = ui(&f.root, &confirmation).unwrap();
    let replayed = ui(&f.root, &confirmation).unwrap();
    assert_eq!(count(&f, "tag_assignment_proposals"), 1);
    assert_eq!(count(&f, "hub_content_tags"), 0);
    assert_eq!(submitted["actions"]["items"][0]["state"], "verified");
    assert_eq!(
        submitted["actions"]["items"][0]["receipt"],
        replayed["actions"]["items"][0]["receipt"]
    );
    assert_eq!(
        submitted["actions"]["items"][0]["currentProposal"]["status"],
        "pending"
    );
    if let Ok(path) = std::env::var("HUB_AGENT_EVAL_TRACE") {
        std::fs::write(
            path,
            serde_json::to_vec_pretty(
                &json!({"prepared":prepared,"submitted":submitted,"replayed":replayed}),
            )
            .unwrap(),
        )
        .unwrap();
    }
}
