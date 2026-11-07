use super::*;
use crate::agent_work::tests::{claim, create, report};
use crate::source_evidence::tests::Fixture;

fn setup() -> (Fixture, String, String, Value) {
    let f = Fixture::new();
    f.note("notes", "current", "检查配合条件，先测量后加工。");
    let id = create(&f, false);
    let (w, run) = claim(&f, &id);
    runner::investigate(&f.root, &w, &run, &Control::default(), |p, _| {
        Ok(report(p, "检查配合条件"))
    })
    .unwrap();
    let body = json!({"request":{"kind":"flashcards","instruction":"记住加工前的条件","target":"收件箱","baseActionId":null},"revision":w.revision,"authorizationVersion":w.authorization_version,"options":options::load(&f.root,&id).unwrap()});
    store::write(&f.root, |c| {
        store::insert(c, &id, Some(&run), "draftRequest", &body)
    })
    .unwrap();
    (f, id, run, body)
}
#[test]
fn dispatch_is_bound_to_completed_delivery_and_can_only_claim_once() {
    let (f, id, run, body) = setup();
    let w = store::load(&f.c(), &id).unwrap();
    let args = arguments(&id, &run, &body);
    check_dispatch(&f.root, &f.c(), &w, Some(&args)).unwrap();
    let mut forged = args.clone();
    forged["learningGoal"] = json!("伪造要求");
    assert!(check_dispatch(&f.root, &f.c(), &w, Some(&forged)).is_err());
    assert_eq!(view_on(&f.c(), &w).unwrap()["runId"], run);
    claimed(&f.c(), &w, Some(&args), "already-prepared").unwrap();
    assert!(check_dispatch(&f.root, &f.c(), &w, Some(&args)).is_err());
    assert!(view_on(&f.c(), &w).unwrap().is_null());
}
#[test]
fn cancellation_revision_source_and_options_changes_block_pending_dispatch() {
    for change in ["cancel", "message", "source", "options", "revoke"] {
        let (f, id, run, body) = setup();
        match change {
            "cancel" => cancel(&f.root, &id).unwrap(),
            "message" => {
                ui(&f.root,&json!({"action":"message","id":id,"text":"先解释，不做卡","clientMessageId":"next"})).unwrap();
            }
            "source" => f.note("notes", "current", "修改后的来源"),
            "options" => {
                options::configure(&f.root,&json!({"id":id,"options":{"model":null,"autoFlashcardInbox":true},"confirmedAutoInbox":true})).unwrap();
            }
            _ => store::revoke(&f.root, &id).unwrap(),
        }
        let w = store::load(&f.c(), &id).unwrap();
        assert!(
            check_dispatch(&f.root, &f.c(), &w, Some(&arguments(&id, &run, &body))).is_err(),
            "{change}"
        );
    }
}
#[test]
fn inbox_permission_is_an_explicit_current_conversation_choice() {
    let (f, id, run, body) = setup();
    let args = json!({"id":id,"options":{"model":null,"autoFlashcardInbox":true}});
    assert!(options::configure(&f.root, &args).is_err());
    assert!(!options::load(&f.root, &id).unwrap().auto_flashcard_inbox);
    let mut granted = args.clone();
    granted["confirmedAutoInbox"] = json!(true);
    options::configure(&f.root, &granted).unwrap();
    let other = create(&f, false);
    assert!(!options::load(&f.root, &other).unwrap().auto_flashcard_inbox);
    let w = store::load(&f.c(), &id).unwrap();
    // A later grant cannot retroactively approve a draft planned in review mode.
    assert!(check_auto(&f.c(), &w, &run, "anything").is_err());
    assert!(check_dispatch(&f.root, &f.c(), &w, Some(&arguments(&id, &run, &body))).is_err());
    options::configure(
        &f.root,
        &json!({"id":id,"options":{"model":null,"autoFlashcardInbox":false}}),
    )
    .unwrap();
    assert!(!options::load(&f.root, &id).unwrap().auto_flashcard_inbox);
}
#[test]
fn drafts_require_supported_kinds_and_real_archive_targets() {
    let caps = json!({"flashcards":true,"obsidianEdit":false,"archiveTargets":[{"id":"real"}]});
    assert!(validate_request(&Value::Null, &caps).is_ok());
    for request in [
        json!({"kind":"obsidianEdit","instruction":"整理结构","target":""}),
        json!({"kind":"archive","instruction":"归档","target":"guessed"}),
        json!({"kind":"shell","instruction":"run","target":""}),
    ] {
        assert!(validate_request(&request, &caps).is_err());
    }
    assert!(validate_request(
        &json!({"kind":"archive","instruction":"归档","target":"real","baseActionId":null}),
        &caps
    )
    .is_ok());
}

#[test]
#[ignore = "Opt-in real provider: prepare, refine and scoped inbox import using synthetic isolated notes"]
fn installed_provider_conversational_drafts() {
    let f = Fixture::new();
    let source="# 主动回忆\n先理解材料，再合上原文主动回忆。把难以回忆的关键问题做成闪卡，每张只问一个问题。\n草稿先进入收件箱审核，检查问题清楚、答案准确、有原文依据后，才进入正式复习。";
    f.note("notes", "current", source);
    let first=ui(&f.root,&json!({"action":"create","goal":"把当前笔记做成两张中文问答闪卡草稿，建议牌组用收件箱，先给我预览","successCriteria":"根据本轮要求准备有原文依据的草稿","anchor":{"kind":"note","libraryId":"notes","documentId":"current","pageId":null},"grant":{"libraryIds":[],"notes":[{"kind":"note","libraryId":"notes","documentId":"current","pageId":null}],"readingItemKeys":[]}})).unwrap();
    let id = first["work"]["id"].as_str().unwrap().to_owned();
    let mut rounds = Vec::new();
    let mut old_token = String::new();
    for index in 0..3 {
        if index == 2 {
            options::configure(&f.root,&json!({"id":id,"options":{"model":null,"autoFlashcardInbox":true},"confirmedAutoInbox":true})).unwrap();
        }
        if index > 0 {
            ui(&f.root,&json!({"action":"message","id":id,"text":if index==1 {"把刚才两张草稿合并成一张，只考察正式复习前为什么需要审核。保留原文依据，先预览。"}else{"在刚才的一张草稿基础上，把问题改得更简洁，解释保留审核的作用。继续使用收件箱。"},"clientMessageId":format!("live-draft-{index}")})).unwrap();
        }
        let began = std::time::Instant::now();
        let planned = run(&f.root, &json!({"id":id,"mode":"quick"})).unwrap();
        let run_id = planned["draftRequest"]["runId"]
            .as_str()
            .expect("real provider must request a draft")
            .to_owned();
        let w = store::load(&f.c(), &id).unwrap();
        let body = request_on(&f.c(), &w, &run_id).unwrap();
        assert_eq!(body["request"]["kind"], "flashcards");
        if index > 0 {
            assert!(body["request"]["baseActionId"].is_string());
        }
        let prepared = ui(&f.root, &arguments(&id, &run_id, &body)).unwrap();
        let card = &prepared["actions"]["items"][0];
        assert_eq!(card["state"], "prepared");
        assert_eq!(
            card["payload"]["cards"].as_array().unwrap().len(),
            if index == 0 { 2 } else { 1 }
        );
        assert_ne!(card["confirmationToken"].as_str().unwrap(), old_token);
        old_token = card["confirmationToken"].as_str().unwrap().into();
        let completed = auto_inbox(&f.root, &id, &run_id, &prepared).unwrap();
        if index < 2 {
            assert!(completed["actions"]["items"][0]["receipt"].is_null());
        } else {
            assert_eq!(
                completed["actions"]["items"][0]["receipt"]["confirmedBy"],
                "conversationGrant"
            );
            assert_eq!(
                completed["actions"]["items"][0]["receipt"]["result"]["imported"],
                1
            );
        }
        rounds.push(json!({"round":index+1,"durationMs":began.elapsed().as_millis(),"plan":planned,"result":completed}));
        if let Ok(path) = std::env::var("HUB_AGENT_OUTCOMES_REPORT") {
            std::fs::write(
                path,
                serde_json::to_vec_pretty(
                    &json!({"format":"hub-drafts-provider-v1","rounds":rounds}),
                )
                .unwrap(),
            )
            .unwrap();
        }
    }
    ui(&f.root,&json!({"action":"message","id":id,"text":"只解释为什么要审核，不生成或调整草稿，不导入","clientMessageId":"explain-only"})).unwrap();
    let ordinary = run(&f.root, &json!({"id":id,"mode":"quick"})).unwrap();
    assert!(ordinary["draftRequest"].is_null());
    assert_eq!(ordinary["run"]["usage"]["modelCalls"], 1);
    assert!(ordinary["run"]["usage"]["requestBytes"].as_u64().unwrap() <= 131072);
    rounds.push(json!({"round":4,"ordinary":ordinary}));
    if let Ok(path) = std::env::var("HUB_AGENT_OUTCOMES_REPORT") {
        std::fs::write(
            path,
            serde_json::to_vec_pretty(&json!({"format":"hub-drafts-provider-v1","rounds":rounds}))
                .unwrap(),
        )
        .unwrap();
    }
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM flashcards", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
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
            .query_row(
                "SELECT markdown FROM documents WHERE space_id='notes' AND id='current'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        source
    );
}
