mod materials;
use super::tests::{claim, create, report};
use super::*;
use crate::source_evidence::tests::Fixture;

fn reply(f: &Fixture, id: &str, expected: &str) -> String {
    let (work, run) = claim(f, id);
    runner::investigate(&f.root, &work, &run, &Control::default(), |prompt, _| {
        let material: Value =
            serde_json::from_str(prompt.split("宿主材料(JSON):\n").nth(1).unwrap()).unwrap();
        assert_eq!(material["conversation"]["currentRequest"], expected);
        let mut answer = report(prompt, "检查配合条件");
        answer["report"]["summary"] = json!(format!("回答：{expected}"));
        Ok(answer)
    })
    .unwrap();
    run
}
fn send(f: &Fixture, id: &str, text: &str, token: &str) -> Value {
    ui(
        &f.root,
        &json!({"action":"message","id":id,"text":text,"clientMessageId":token}),
    )
    .unwrap()
}

#[test]
fn three_turns_preserve_messages_replies_and_request_provenance_after_reopen() {
    let f = Fixture::new();
    f.note("notes", "current", "检查配合条件");
    let id = create(&f, false);
    let initial = store::view(&f.root, &id).unwrap()["work"]["goal"]
        .as_str()
        .unwrap()
        .to_owned();
    reply(&f, &id, &initial);
    for (n, text) in ["解释上一轮的第一点", "把第二点写得更简洁"]
        .iter()
        .enumerate()
    {
        let pending = send(&f, &id, text, &format!("message-{n}"));
        assert_eq!(pending["decisions"], json!([]));
        assert!(pending["work"]["report"].is_null());
        reply(&f, &id, text);
    }
    let reopened = ui(&f.root, &json!({"action":"status","id":id})).unwrap();
    let messages = reopened["conversation"]["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 6);
    assert_eq!(messages[0]["text"], initial);
    assert_eq!(messages[2]["text"], "解释上一轮的第一点");
    assert_eq!(messages[5]["report"]["summary"], "回答：把第二点写得更简洁");
    let work = store::load(&f.c(), &id).unwrap();
    let context = store::conversation::context(&f.root, &work).unwrap();
    assert_eq!(
        context["messages"][1]["summary"],
        format!("回答：{initial}")
    );
    assert!(!context.to_string().contains("e1"));
}

#[test]
fn request_retry_is_idempotent_and_stale_or_active_submissions_are_rejected() {
    let f = Fixture::new();
    f.note("notes", "current", "检查配合条件");
    let id = create(&f, false);
    let first = send(&f, &id, "请解释", "retry");
    let second = send(&f, &id, "请解释", "retry");
    assert_eq!(first["work"]["revision"], second["work"]["revision"]);
    assert_eq!(
        second["conversation"]["messages"].as_array().unwrap().len(),
        2
    );
    assert!(ui(&f.root,&json!({"action":"message","id":id,"text":"旧页面的追问","clientMessageId":"stale","expectedRevision":1})).is_err());
    let (_work, _run) = claim(&f, &id);
    assert!(store::conversation::message(
        &f.root,
        &id,
        &json!({"text":"运行中的追问","clientMessageId":"busy"})
    )
    .is_err());
    assert!(ui(
        &f.root,
        &json!({"action":"message","id":id,"text":"不同内容","clientMessageId":"retry"})
    )
    .is_err());
}

#[test]
fn source_opening_checks_work_identity_quote_version_and_revocation() {
    let f = Fixture::new();
    f.note("notes", "current", "检查配合条件，保留原文定位");
    let id = create(&f, false);
    let initial = store::view(&f.root, &id).unwrap()["work"]["goal"]
        .as_str()
        .unwrap()
        .to_owned();
    let run = reply(&f, &id, &initial);
    let source = |id: &str, quote: &str| {
        ui(
            &f.root,
            &json!({"action":"source","id":id,"runId":run,"evidenceIndex":0,"quote":quote}),
        )
    };
    assert!(source(&id, "检查配合条件").unwrap()["excerpt"]["content"]
        .as_str()
        .unwrap()
        .contains("原文定位"));
    let other = create(&f, false);
    assert!(source(&other, "检查配合条件").is_err());
    assert!(source(&id, "捏造的引用").is_err());
    f.note("notes", "current", "修订后的正文");
    assert!(source(&id, "检查配合条件").is_err());
    let view = store::view(&f.root, &id).unwrap();
    assert!(view["conversation"]["messages"][1]["report"].is_null());
    store::revoke(&f.root, &id).unwrap();
    assert!(source(&id, "检查配合条件").is_err());
    assert_eq!(
        store::view(&f.root, &id).unwrap()["conversation"]["messages"],
        json!([])
    );
}

#[test]
fn invalidated_prior_replies_never_reenter_model_context_as_evidence() {
    let f = Fixture::new();
    f.note("notes", "current", "检查配合条件");
    let id = create(&f, false);
    let initial = store::view(&f.root, &id).unwrap()["work"]["goal"]
        .as_str()
        .unwrap()
        .to_owned();
    reply(&f, &id, &initial);
    send(&f, &id, "继续核对当前版本", "next");
    f.note("notes", "current", "修改后的配合条件");
    let work = store::load(&f.c(), &id).unwrap();
    let context = store::conversation::context(&f.root, &work).unwrap();
    assert!(!context.to_string().contains(&format!("回答：{initial}")));
    assert_eq!(context["currentRequest"], "继续核对当前版本");
    assert_eq!(store::view(&f.root, &id).unwrap()["decisions"], json!([]));
}

#[test]
#[ignore = "Opt-in real provider: three conversational turns using synthetic notes in an isolated database"]
fn installed_provider_three_turn_conversation() {
    let f = Fixture::new();
    f.note("notes","current","# 学习流程\n先理解材料，再合上原文主动回忆。把难以回忆的关键问题做成闪卡，每张只问一个问题。草稿先进入收件箱审核，检查问题清楚、答案准确、有原文依据后，才进入正式复习。");
    if let Ok(settings) = std::env::var("HUB_AGENT_EVAL_SETTINGS") {
        std::fs::copy(settings, f.root.join("codex-suite-v1.json")).unwrap();
    }
    let first=ui(&f.root,&json!({"action":"create","goal":"简要概括这篇笔记的学习流程，引用原文","successCriteria":"直接回答本轮问题，保留原文依据","anchor":{"kind":"note","libraryId":"notes","documentId":"current","pageId":null},"grant":{"libraryIds":[],"notes":[{"kind":"note","libraryId":"notes","documentId":"current","pageId":null}],"readingItemKeys":[]}})).unwrap();
    let id = first["work"]["id"].as_str().unwrap().to_owned();
    let mut rounds = Vec::new();
    for (index, question) in [
        "简要概括这篇笔记的学习流程，引用原文",
        "把刚才的流程改成两条，第二条解释闪卡审核",
        "第二条为什么要先审核？依据原文用一句话回答",
    ]
    .iter()
    .enumerate()
    {
        if index > 0 {
            send(&f, &id, question, &format!("live-{index}"));
        }
        let began = std::time::Instant::now();
        let view = ui(&f.root, &json!({"action":"run","id":id,"mode":"quick"})).unwrap();
        rounds.push(
            json!({"question":question,"durationMs":began.elapsed().as_millis(),"view":view}),
        );
        if let Ok(path) = std::env::var("HUB_AGENT_CONVERSATION_REPORT") {
            std::fs::write(
                path,
                serde_json::to_vec_pretty(
                    &json!({"format":"hub-conversation-provider-v1","rounds":rounds}),
                )
                .unwrap(),
            )
            .unwrap();
        }
        assert!(
            rounds[index]["view"]["work"]["report"].is_object(),
            "round {} did not deliver: {}",
            index + 1,
            rounds[index]["view"]["run"]
        );
        assert_eq!(
            rounds[index]["view"]["conversation"]["messages"]
                .as_array()
                .unwrap()
                .len(),
            (index + 1) * 2
        );
        assert_eq!(rounds[index]["view"]["decisions"], json!([]));
    }
    let reopened = ui(&f.root, &json!({"action":"status","id":id})).unwrap();
    assert_eq!(
        reopened["conversation"]["messages"]
            .as_array()
            .unwrap()
            .len(),
        6
    );
    let c = f.c();
    let writes: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM agent_actions WHERE work_id=?1",
            [id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(writes, 0);
}
