use super::*;
use crate::source_evidence::tests::Fixture;
fn setup() -> (Fixture, String) {
    let f = Fixture::new();
    f.note(
        "notes",
        "current",
        "检查配合条件 😀单位为毫米，先测量再加工。",
    );
    f.note("private", "secret", "PRIVATE_CARD_SENTINEL");
    let id = crate::agent_work::tests::create(&f, false);
    (f, id)
}
fn request(id: &str) -> Value {
    json!({"id":id,"deckName":"收件箱","learningGoal":"记住测量条件与单位"})
}
fn reply() -> Value {
    json!({"cards":[{"question":"加工前需要核对什么条件？","answer":"先检查配合条件并测量，单位使用毫米。","explanation":"原文把测量列为加工前置条件。","quote":"检查配合条件"}],"uncoveredTargets":["图片与附件未分析"],"ruleApplications":[]})
}
fn prepared(f: &Fixture, id: &str) -> Action {
    let args = request(id);
    let (w, action, context) = claim_action(&f.root, id, "flashcardDrafts", |c, w| {
        context_on(&f.root, c, w, &args)
    })
    .unwrap();
    let payload = build_payload(
        &f.root,
        &w,
        &action,
        &context,
        &json!({"model":"fixture"}),
        &Control::default(),
        |prompt, _| {
            assert!(!prompt.contains("PRIVATE_CARD_SENTINEL"));
            Ok(reply())
        },
    )
    .unwrap();
    publish_payload(&f.root, &w, &action, &payload, &Control::default()).unwrap();
    load(&f.c(), id, &action).unwrap()
}
fn confirm(f: &Fixture, id: &str, a: &Action) -> Value {
    submit(
        &f.root,
        &json!({"id":id,"actionId":a.id,"confirmationToken":token(a)}),
    )
    .unwrap()
}
fn count(f: &Fixture, t: &str) -> i64 {
    f.c()
        .query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0))
        .unwrap()
}
#[test]
fn subset_selection_reissues_confirmation_and_does_not_import_until_confirmed() {
    let (f, id) = setup();
    let mut a = prepared(&f, &id);
    let p = a.payload.as_mut().unwrap();
    let mut second = p["cards"][0].clone();
    second["question"] = json!("加工使用什么单位？");
    second["idempotencyKey"] = json!("second-draft");
    p["cards"].as_array_mut().unwrap().push(second);
    f.c()
        .execute(
            "UPDATE agent_actions SET payload_json=?2 WHERE id=?1",
            params![a.id, p.to_string()],
        )
        .unwrap();
    let old = token(&a);
    let selected = select(
        &f.root,
        &json!({"id":id,"actionId":a.id,"confirmationToken":old,"selectedIndices":[1]}),
    )
    .unwrap();
    let item = &selected["actions"]["items"][0];
    assert_eq!(item["payload"]["cards"].as_array().unwrap().len(), 1);
    assert_ne!(item["confirmationToken"], old);
    assert_eq!(count(&f, "flashcard_drafts"), 0);
    assert!(submit(
        &f.root,
        &json!({"id":id,"actionId":a.id,"confirmationToken":old})
    )
    .is_err());
    assert!(select(&f.root,&json!({"id":id,"actionId":a.id,"confirmationToken":item["confirmationToken"],"selectedIndices":[]})).is_err());
    let current = load(&f.c(), &id, &a.id).unwrap();
    confirm(&f, &id, &current);
    assert_eq!(count(&f, "flashcard_drafts"), 1);
    assert_eq!(count(&f, "flashcards"), 0);
}
#[test]
fn conversational_refinement_keeps_the_old_draft_as_material_and_requires_a_new_confirmation() {
    let (f, id) = setup();
    let old = prepared(&f, &id);
    ui(&f.root,&json!({"action":"message","id":id,"text":"让问题更简短，保留解释","clientMessageId":"refine"})).unwrap();
    let args =
        json!({"learningGoal":"让问题更简短，保留解释","deckName":"收件箱","baseActionId":old.id});
    let (w, a, ctx) = claim_action(&f.root, &id, "flashcardDrafts", |c, w| {
        context_on(&f.root, c, w, &args)
    })
    .unwrap();
    assert!(ctx["previousDraft"]["cards"].is_array());
    let p = build_payload(
        &f.root,
        &w,
        &a,
        &ctx,
        &json!({}),
        &Control::default(),
        |prompt, _| {
            assert!(prompt.contains("加工前需要核对什么条件"));
            let mut r = reply();
            r["cards"][0]["question"] = json!("加工前做什么？");
            Ok(r)
        },
    )
    .unwrap();
    publish_payload(&f.root, &w, &a, &p, &Control::default()).unwrap();
    assert!(submit(
        &f.root,
        &json!({"id":id,"actionId":old.id,"confirmationToken":token(&old)})
    )
    .is_err());
    assert_ne!(token(&load(&f.c(), &id, &a).unwrap()), token(&old));
    f.note("notes", "current", "来源已改变");
    assert!(context_on(&f.root, &f.c(), &w, &args).is_err());
}
#[test]
fn auto_import_cannot_be_forged_from_a_valid_manual_confirmation() {
    let (f, id) = setup();
    let a = prepared(&f, &id);
    assert!(submit(&f.root,&json!({"id":id,"actionId":a.id,"confirmationToken":token(&a),"autoResponseRunId":"guessed-run"})).is_err());
    assert_eq!(count(&f, "flashcard_drafts"), 0);
    confirm(&f, &id, &a);
    assert_eq!(count(&f, "flashcard_drafts"), 1);
}
#[test]
fn draft_then_atomic_import_uses_real_inbox_and_repeated_confirmation_is_idempotent() {
    let (f, id) = setup();
    let a = prepared(&f, &id);
    assert_eq!(count(&f, "flashcard_drafts"), 0);
    let first = confirm(&f, &id, &a);
    let receipt = first["actions"]["items"][0]["receipt"].clone();
    assert_eq!(receipt["result"]["imported"], 1);
    assert_eq!(count(&f, "flashcards"), 0);
    assert_eq!(count(&f, "flashcard_drafts"), 1);
    assert_eq!(count(&f, "flashcard_import_batches"), 1);
    assert_eq!(
        f.c()
            .query_row(
                "SELECT source_path FROM flashcard_import_batches",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "agent://hub/flashcard-drafts"
    );
    let again = confirm(&f, &id, &a);
    assert_eq!(again["actions"]["items"][0]["receipt"], receipt);
    assert_eq!(count(&f, "flashcard_import_batches"), 1);
    let another = prepared(&f, &id);
    let duplicate = confirm(&f, &id, &another);
    assert_eq!(
        duplicate["actions"]["items"][0]["receipt"]["result"]["duplicates"],
        1
    );
    assert_eq!(count(&f, "flashcard_drafts"), 1);
}

#[test]
fn receipt_hints_follow_real_flashcard_review_without_loading_card_bodies() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    let (f, id) = setup();
    let a = prepared(&f, &id);
    let result = confirm(&f, &id, &a);
    let draft = result["actions"]["items"][0]["receipt"]["result"]["drafts"][0]["id"]
        .as_str()
        .unwrap();
    let c = f.c();
    c.authorizer(Some(|ctx: AuthContext<'_>| match ctx.action {
        AuthAction::Read {
            column_name: "question" | "answer" | "markdown" | "post_json",
            ..
        } => Authorization::Deny,
        _ => Authorization::Allow,
    }));
    let before = super::super::receipt_hints_on(&c, &id).unwrap();
    assert!(!before.to_string().contains("加工前需要"));
    f.c().execute("INSERT INTO flashcard_decks(id,name,created_at,updated_at) VALUES('review','学习',1,1)",[]).unwrap();
    let accepted = authoring::resolve_flashcard_drafts_in_connection(
        &mut f.c(),
        vec![draft.into()],
        true,
        Some("review".into()),
    )
    .unwrap();
    assert_eq!(accepted.accepted, 1);
    let after = super::super::receipt_hints_on(&c, &id).unwrap();
    assert_ne!(before, after);
    assert_eq!(after[0]["current"]["drafts"][0]["status"], "accepted");
}
#[test]
fn existing_review_accepts_draft_and_action_reads_its_actual_status_after_revoke() {
    let (f, id) = setup();
    let a = prepared(&f, &id);
    let view = confirm(&f, &id, &a);
    let draft = view["actions"]["items"][0]["receipt"]["result"]["drafts"][0]["id"]
        .as_str()
        .unwrap();
    f.c().execute("INSERT INTO flashcard_decks(id,name,created_at,updated_at) VALUES('study-deck','学习',1,1)",[]).unwrap();
    let deck: String = f
        .c()
        .query_row(
            "SELECT id FROM flashcard_decks WHERE id='study-deck'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let resolved = authoring::resolve_flashcard_drafts_in_connection(
        &mut f.c(),
        vec![draft.into()],
        true,
        Some(deck),
    )
    .unwrap();
    assert_eq!(resolved.accepted, 1);
    store::revoke(&f.root, &id).unwrap();
    let view = confirm(&f, &id, &a);
    assert_eq!(
        view["actions"]["items"][0]["currentResult"]["drafts"][0]["status"],
        "accepted"
    );
    assert_eq!(count(&f, "flashcards"), 1);
    assert_eq!(count(&f, "flashcard_import_batches"), 1);
}
#[test]
fn changed_source_goal_authorization_and_quality_rules_block_old_import() {
    for change in ["source", "decision", "revoke", "quality"] {
        let (f, id) = setup();
        let a = prepared(&f, &id);
        match change {
            "source"=>f.note("notes","current","新正文"),"decision"=>store::decision(&f.root,&id,"改为学习另一目标").unwrap(),
            "revoke"=>store::revoke(&f.root,&id).unwrap(),
            _=>crate::flashcard_quality::merge(&f.c(),&[json!({"id":"rule-new","kind":"rule","text":"Prefer causal explanation","scopeType":"global","scopeValue":"","learningGoal":"","enabled":true,"updatedAt":100})]).unwrap(),
        }
        assert!(
            submit(
                &f.root,
                &json!({"id":id,"actionId":a.id,"confirmationToken":token(&a)})
            )
            .is_err(),
            "{change}"
        );
        assert_eq!(count(&f, "flashcard_drafts"), 0);
        assert_eq!(count(&f, "flashcard_import_batches"), 0);
    }
}
#[test]
fn receipt_failure_rolls_back_the_formal_import_and_sync_side_effects() {
    let (f, id) = setup();
    let a = prepared(&f, &id);
    f.c().execute_batch("CREATE TRIGGER reject_card_receipt BEFORE UPDATE OF receipt_json ON agent_actions WHEN NEW.receipt_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'reject receipt'); END;").unwrap();
    assert!(submit(
        &f.root,
        &json!({"id":id,"actionId":a.id,"confirmationToken":token(&a)})
    )
    .is_err());
    assert_eq!(count(&f, "flashcard_drafts"), 0);
    assert_eq!(count(&f, "flashcard_import_batches"), 0);
    assert_eq!(load(&f.c(), &id, &a.id).unwrap().state, "prepared");
    assert!(authoring::import_flashcard_values_on(
        &f.c(),
        "manual",
        "收件箱".into(),
        json!({}),
        vec![],
        false
    )
    .is_err());
}
#[test]
fn fabricated_quotes_authority_and_truncated_full_material_are_rejected() {
    let (f, id) = setup();
    let args = request(&id);
    let (w, action, context) = claim_action(&f.root, &id, "flashcardDrafts", |c, w| {
        context_on(&f.root, c, w, &args)
    })
    .unwrap();
    for invalid in ["quote", "source", "execution"] {
        let result = build_payload(
            &f.root,
            &w,
            &action,
            &context,
            &json!({"model":"fixture"}),
            &Control::default(),
            |_prompt, _| {
                let mut r = reply();
                match invalid {
                    "quote" => r["cards"][0]["quote"] = json!("不存在"),
                    "source" => r["cards"][0]["sourceDocumentId"] = json!("secret"),
                    _ => r["executed"] = json!(true),
                };
                Ok(r)
            },
        );
        assert!(result.is_err(), "{invalid}");
    }
    f.note("notes", "current", &"x".repeat(12001));
    assert!(context_on(&f.root, &f.c(), &w, &args).is_err());
    assert_eq!(count(&f, "flashcard_drafts"), 0);
}
#[test]
fn unrelated_deck_feedback_is_not_shared_and_authoritative_exclusions_still_apply() {
    let (f, id) = setup();
    let unrelated = json!({"id":"feedback-private","kind":"feedback","updatedAt":1,"excludeTarget":true,"reason":"PRIVATE_FEEDBACK_SENTINEL","snapshot":{"sourceLibraryId":"private","sourceDocumentId":"secret","question":"Private question?","tags":[]}});
    crate::flashcard_quality::merge(&f.c(), &[unrelated]).unwrap();
    let w = store::load(&f.c(), &id).unwrap();
    let ctx = context_on(&f.root, &f.c(), &w, &request(&id)).unwrap();
    assert!(!ctx.to_string().contains("PRIVATE_FEEDBACK_SENTINEL"));
    let excluded = json!({"id":"feedback-excluded","kind":"feedback","updatedAt":2,"excludeTarget":true,"snapshot":{"sourceLibraryId":"notes","sourceDocumentId":"current","sourceBlockId":"","question":"加工前需要核对什么条件？"}});
    crate::flashcard_quality::merge(&f.c(), &[excluded]).unwrap();
    let (w, a, ctx) = claim_action(&f.root, &id, "flashcardDrafts", |c, w| {
        context_on(&f.root, c, w, &request(&id))
    })
    .unwrap();
    assert!(build_payload(
        &f.root,
        &w,
        &a,
        &ctx,
        &json!({"model":"fixture"}),
        &Control::default(),
        |_prompt, _| Ok(reply())
    )
    .is_err());
    assert_eq!(count(&f, "flashcard_drafts"), 0);
}
#[test]
fn changed_inbox_review_invalidates_a_continued_investigation() {
    let (f, id) = setup();
    let a = prepared(&f, &id);
    let view = confirm(&f, &id, &a);
    let (w, run) = crate::agent_work::tests::claim(&f, &id);
    runner::investigate(&f.root, &w, &run, &Control::default(), |prompt, _| {
        assert!(prompt.contains("flashcardDrafts"));
        assert!(prompt.contains("studyActivatedByThisAction"));
        Ok(crate::agent_work::tests::report(prompt, "检查配合条件"))
    })
    .unwrap();
    let draft = view["actions"]["items"][0]["receipt"]["result"]["drafts"][0]["id"]
        .as_str()
        .unwrap();
    authoring::resolve_flashcard_drafts_in_connection(&mut f.c(), vec![draft.into()], false, None)
        .unwrap();
    let fresh = store::view(&f.root, &id).unwrap();
    assert_eq!(fresh["work"]["state"], "expired");
    assert!(fresh["work"]["report"].is_null());
}
#[test]
#[ignore = "Opt-in actual Codex; synthetic note and real inbox admission only"]
fn installed_codex_flashcard_action_evaluation() {
    let (f, id) = setup();
    if let Ok(path) = std::env::var("HUB_AGENT_EVAL_SETTINGS") {
        std::fs::copy(path, f.root.join("codex-suite-v1.json")).unwrap();
    }
    let view = prepare(&f.root, &request(&id)).unwrap();
    assert_eq!(count(&f, "flashcard_drafts"), 0);
    let a = load(
        &f.c(),
        &id,
        view["actions"]["items"][0]["id"].as_str().unwrap(),
    )
    .unwrap();
    let submitted = confirm(&f, &id, &a);
    assert!(
        submitted["actions"]["items"][0]["receipt"]["result"]["imported"]
            .as_i64()
            .unwrap()
            > 0
    );
    assert_eq!(count(&f, "flashcards"), 0);
    if let Ok(path) = std::env::var("HUB_AGENT_EVAL_TRACE") {
        std::fs::write(
            path,
            serde_json::to_vec_pretty(&json!({"prepared":view,"submitted":submitted})).unwrap(),
        )
        .unwrap();
    }
}
