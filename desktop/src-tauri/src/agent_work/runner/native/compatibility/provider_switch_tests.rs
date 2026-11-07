use super::*;
use crate::source_evidence::tests::Fixture;

#[test]
fn direct_provider_execution_invalidates_native_history_but_other_work_does_not() {
    let f = Fixture::new();
    let id = store::create(
        &f.root,
        "handoff".into(),
        String::new(),
        None,
        Grant::default(),
    )
    .unwrap();
    let saved = json!({"providerTurnCompleted":true,"executionManifest":{"runId":"codex-first"}});
    assert_eq!(latest_provider_run(&f.root, &id).unwrap(), None);
    for (run, kind, reusable) in [
        ("codex-first", "nativeRuntime", true),
        ("deepseek-middle", "modelExecution", false),
    ] {
        let work = store::claim(&f.root, &id, run).unwrap();
        store::record(&f.root, run, kind, &json!({})).unwrap();
        assert_eq!(
            provider_turn_completed(
                &saved,
                latest_provider_run(&f.root, &id).unwrap().as_deref()
            ),
            reusable
        );
        store::fail(&f.root, &work, run, "fixture completed").unwrap();
    }
    let other = store::create(
        &f.root,
        "other".into(),
        String::new(),
        None,
        Grant::default(),
    )
    .unwrap();
    store::claim(&f.root, &other, "unrelated").unwrap();
    store::record(&f.root, "unrelated", "modelExecution", &json!({})).unwrap();
    assert_eq!(
        latest_provider_run(&f.root, &id).unwrap().as_deref(),
        Some("deepseek-middle")
    );
    let work = store::claim(&f.root, &id, "codex-return").unwrap();
    store::record(&f.root, "codex-return", "nativeRuntime", &json!({})).unwrap();
    store::record(&f.root, "codex-return", "modelExecution", &json!({})).unwrap();
    let fresh = json!({"providerTurnCompleted":true,"executionManifest":{"runId":"codex-return"}});
    assert!(provider_turn_completed(
        &fresh,
        latest_provider_run(&f.root, &id).unwrap().as_deref()
    ));
    store::fail(&f.root, &work, "codex-return", "fixture completed").unwrap();
}

#[test]
#[ignore = "explicit real Codex/DeepSeek receipt handoff; synthetic chat, requires installed credentials"]
fn real_codex_deepseek_codex_receipt_handoff() {
    let out = std::env::var("HUB_PROVIDER_HANDOFF_REPORT").expect("explicit evidence path");
    let f = Fixture::new();
    let id = store::create(
        &f.root,
        "只回复 READY，不查询、不调用工具、不写入。".into(),
        String::new(),
        None,
        Grant::default(),
    )
    .unwrap();
    let codex = crate::model_runtime::Settings::default();
    let deepseek: crate::model_runtime::Settings = serde_json::from_value(json!({"provider":"deepseek","model":"deepseek-flash","reasoningEffort":"high","fast":false,"maxConcurrent":2})).unwrap();
    let mut cases = Vec::new();
    for (index, model, prompt) in [
        (0, &codex, "只回复 READY，不查询、不调用工具、不写入。"),
        (1, &deepseek, "自行生成一个八位数字回执码，不用以前出现过的数字，只回复八位数字，不解释、不查询、不调用工具、不写入。"),
        (2, &codex, "准确复述上一轮助手实际生成的八位数字回执码。若看不到，就回复 MISSING，不要猜，不查询、不调用工具、不写入。"),
        (3, &codex, "再准确复述刚才的八位数字回执码，只回复数字，不查询、不调用工具、不写入。"),
    ] {
        crate::agent_work::options::configure(&f.root, &json!({"id":id,"options":{"model":model,"webSearch":"disabled","autoFlashcardInbox":false}})).unwrap();
        if index > 0 {
            crate::agent_work::ui(&f.root, &json!({"action":"message","id":id,"clientMessageId":format!("handoff-{index}"),"text":prompt})).unwrap();
        }
        let result = crate::agent_work::ui(&f.root, &json!({"action":"respond","id":id,"mode":"deep"}));
        let view = store::view(&f.root, &id).unwrap();
        let native = store::records(&f.root, &id, "nativeRuntime", 1).unwrap();
        let session = store::records(&f.root, &id, "nativeSession", 1).unwrap();
        cases.push(json!({"index":index,"provider":model.provider,"model":model.model,"runId":view["run"]["id"],"error":result.as_ref().err(),"answer":view["work"]["report"]["prose"]["markdown"],"nativeRuntime":native.first(),"threadId":session.first().map(|s|&s["threadId"])}));
        std::fs::write(&out, serde_json::to_vec_pretty(&json!({"workId":id,"cases":cases})).unwrap()).unwrap();
        result.unwrap();
    }
    let receipt = cases[1]["answer"].as_str().unwrap().trim();
    assert_eq!(receipt.len(), 8, "{cases:?}");
    assert!(receipt.bytes().all(|b| b.is_ascii_digit()));
    for index in [2, 3] {
        assert_eq!(
            cases[index]["answer"].as_str().unwrap().trim(),
            receipt,
            "{cases:?}"
        );
    }
    assert_eq!(cases[2]["nativeRuntime"]["resumed"], false);
    assert_ne!(cases[0]["threadId"], cases[2]["threadId"]);
    assert_eq!(cases[3]["nativeRuntime"]["resumed"], true);
    assert_eq!(cases[2]["threadId"], cases[3]["threadId"]);
}
