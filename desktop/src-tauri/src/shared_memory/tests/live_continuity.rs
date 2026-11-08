//! Real providers and real Basic Memory, only synthetic data in a small owned Fixture.
use super::*;
#[test]
#[ignore = "explicit real Codex/DeepSeek and cached Basic Memory; synthetic isolated project only"]
fn real_provider_memory_revision_and_handoff_acceptance() {
    let out = std::env::var("HUB_MEMORY_HANDOFF_REPORT").expect("explicit report path");
    let f = Fixture::new();
    let cfg = backend::RuntimeConfig {
        python: std::env::var_os("HUB_MEMORY_TEST_PYTHON")
            .expect("cached runtime")
            .into(),
        model_cache: std::env::var_os("HUB_MEMORY_TEST_MODELS")
            .expect("cached model")
            .into(),
    };
    fs::write(
        f.root.join("memory-runtime-v1.json"),
        serde_json::to_vec(&cfg).unwrap(),
    )
    .unwrap();
    f.c()
        .execute(
            "INSERT INTO memory_projects VALUES('alpha','合成甲项目'),('beta','合成乙项目')",
            [],
        )
        .unwrap();
    let call = |args: Value| crate::agent_work::ui(&f.root, &args);
    let create = |goal: &str| {
        call(json!({"action":"create","goal":goal,"successCriteria":"","anchor":null,"grant":{"libraryIds":[],"notes":[],"readingItemKeys":[]}})).unwrap()["work"]["id"].as_str().unwrap().to_string()
    };
    let codex = json!(crate::model_runtime::Settings::default());
    let deepseek = json!({"provider":"deepseek","model":"deepseek-flash","reasoningEffort":"high","fast":false,"maxConcurrent":2});
    let models = [codex, deepseek];
    let mut evidence = Vec::new();
    let mut run = |id: &str, model: &Value, prompt: Option<&str>, expected: &str, label: &str| {
        call(json!({"action":"configureAssistant","id":id,"options":{"model":model,"webSearch":"disabled","autoFlashcardInbox":false}})).unwrap();
        if let Some(text) = prompt {
            call(json!({"action":"message","id":id,"clientMessageId":format!("accept-{}",crate::random_url_safe(10)),"text":text})).unwrap();
        }
        let start = Instant::now();
        let result = call(json!({"action":"respond","id":id,"mode":"deep"}));
        let view = call(json!({"action":"status","id":id})).unwrap();
        let answer = view["work"]["report"]["prose"]["markdown"]
            .as_str()
            .unwrap_or("")
            .to_string();
        evidence.push(json!({"label":label,"provider":model["provider"],"workId":id,"answer":answer,"error":result.as_ref().err(),"elapsedMs":start.elapsed().as_millis(),"memoryUse":view["memoryUse"],"runId":view["run"]["id"]}));
        fs::write(
            &out,
            serde_json::to_vec_pretty(&json!({"cases":evidence})).unwrap(),
        )
        .unwrap();
        result.unwrap();
        assert!(answer.contains(expected), "{label}: {answer}");
    };
    let mut req = request(
        "alpha-a",
        0,
        "本项目发布核对口令是 A731946。旧口令无效。报告使用中文。",
    );
    req["projectId"] = json!("alpha");
    req["kind"] = json!("rule");
    {
        let mut bm = BasicMemory::start(&f.root, &cfg).unwrap();
        save(&f, &mut bm, &req);
        let mut decoy = req.clone();
        decoy["projectId"] = json!("beta");
        decoy["requestKey"] = json!("beta");
        decoy["body"] = json!("乙项目的口令是 WRONG_PROJECT_999。");
        save(&f, &mut bm, &decoy);
    }
    let question="仅根据本轮共享记忆回答本项目发布核对口令。不要用历史聊天或猜测；本轮没有有效记忆时只答 NO_MEMORY，有则只答当前口令。不读取资料、不联网、不保存、不调用工具。";
    let ids = [create(question), create(question)];
    for (index, model) in models.iter().enumerate() {
        ui(
            &f.root,
            &json!({"action":"selectScope","workId":ids[index],"projectId":"alpha","enabled":true}),
        )
        .unwrap();
        run(&ids[index], model, None, "A731946", "confirmed A");
    }
    let old = context(&f.root, &ids[0], "发布口令").unwrap().unwrap();
    req["requestKey"] = json!("alpha-b");
    req["expectedVersion"] = json!(1);
    req["body"] = json!("本项目发布核对口令改为 B864205，替代 A731946。报告使用中文。");
    req["changeReason"] = json!("用户修订方案 A 为 B");
    let item = {
        let mut bm = BasicMemory::start(&f.root, &cfg).unwrap();
        save(&f, &mut bm, &req)
    };
    assert!(verify(&f.root, &old).is_err());
    for (index, model) in models.iter().enumerate() {
        run(&ids[index], model, Some(question), "B864205", "revised B");
    }
    ui(&f.root, &json!({"action":"deactivate","id":item.id})).unwrap();
    for (index, model) in models.iter().enumerate() {
        run(
            &ids[index],
            model,
            Some(question),
            "NO_MEMORY",
            "deactivated",
        );
    }
    ui(
        &f.root,
        &json!({"action":"forget","id":item.id,"confirmed":true}),
    )
    .unwrap();
    assert!(!path(&f.root, &item.revision_id, false).unwrap().exists());
    for (index, model) in models.iter().enumerate() {
        run(&ids[index], model, Some(question), "NO_MEMORY", "forgotten");
    }
    let id=create("请为甲、乙、丙三个核对步骤写一个简短进度表：甲已完成，乙待核对，丙阻塞，疑问是缺少丙的图纸。不要保存、联网、读取资料或调用工具。");
    run(&id, &models[0], None, "丙", "initial progress");
    run(&id,&models[1],Some("接着刚才的进度表修改：乙已完成；丙仍缺图纸。最终输出保留甲、乙、丙三项，说明尚未保存。不要保存、联网、读取资料或调用工具。"),"乙","handoff to DeepSeek");
    run(&id,&models[0],Some("接着上一轮，只用一句话说：哪些已完成、什么还阻塞、结果是否已外部保存。不要保存、联网、读取资料或调用工具。"),"丙","return to Codex");
    let proposal_work=create("请调用 hub_proposeMemory，把这项甲项目规则整理为待确认建议：验收报告统一使用简体中文，验收口令为 C052718。只提出建议，不要自动确认、不保存外部文件、不联网。最后说明需要用户在共享记忆中确认。");
    ui(
        &f.root,
        &json!({"action":"selectScope","workId":proposal_work,"projectId":"alpha","enabled":true}),
    )
    .unwrap();
    run(
        &proposal_work,
        &models[1],
        None,
        "确认",
        "model proposal awaiting confirmation",
    );
    let pending = proposals::list(&f.c(), "alpha").unwrap();
    let proposal = pending
        .iter()
        .find(|p| p["source"]["workId"] == proposal_work)
        .expect("actual model must save a review proposal");
    assert!(context(&f.root, &proposal_work, "验收口令")
        .unwrap()
        .unwrap()
        .items
        .is_empty());
    let mut approval = proposal["candidate"].clone();
    approval["action"] = json!("put");
    approval["projectId"] = json!("alpha");
    approval["proposalId"] = proposal["id"].clone();
    approval["expectedVersion"] = proposal["expectedVersion"].clone();
    approval["requestKey"] = json!("explicit-user-reviewed-live-proposal");
    approval["confirmed"] = json!(true);
    approval["changeReason"] = json!("隔离验收中模拟用户检查并确认");
    ui(&f.root, &approval).unwrap();
    let confirmed = create("只按本轮共享记忆回复验收口令，不用历史，不调用工具，不联网。");
    ui(
        &f.root,
        &json!({"action":"selectScope","workId":confirmed,"projectId":"alpha","enabled":true}),
    )
    .unwrap();
    run(
        &confirmed,
        &models[0],
        None,
        "C052718",
        "confirmed model proposal in a new chat",
    );
    drop(run);
    assert!(!evidence.iter().any(|case| case["answer"]
        .as_str()
        .unwrap()
        .contains("WRONG_PROJECT_999")));
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM agent_actions", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
