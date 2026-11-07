use super::*;
use std::path::PathBuf;
fn base() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .canonicalize()
        .unwrap()
}
fn read(p: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap()
}
fn save(o: &Path, n: &str, v: &Value) {
    std::fs::write(o.join(n), serde_json::to_vec_pretty(v).unwrap()).unwrap();
}
#[test]
#[ignore = "saved zero-model replay or frozen final protocol repair3Runs; no old script retry"]
fn v4_terminal_saved_replay_and_revalidation() {
    let b = base();
    let out = b.join("artifacts/architecture-v4-terminal-accounting-20261027");
    let old = b.join("artifacts/architecture-v4-direct-draft-20261027");
    let contract = read(&out.join("contract.json"));
    let id = contract["workId"].as_str().unwrap();
    let phase = std::env::var("HUB_V4_TERMINAL_PHASE").unwrap();
    if phase == "replay" {
        let input = read(&out.join("replay-input.json"));
        let schema = crate::agent_work::assistant::schema(crate::agent_work::runner::schema());
        let error =
            crate::model_runtime::validate_agent_tool(&input["candidate"], &schema).unwrap_err();
        assert!(error.contains("report"));
        let mut corrected = input["candidate"].clone();
        corrected["report"] = Value::Null;
        crate::model_runtime::validate_agent_tool(&corrected, &schema).unwrap();
        let root = b.join(".local/v4-terminal-replay-20261027/profile");
        let c = crate::source_evidence::open_read_database(&root).unwrap();
        let before = load(&c, id).unwrap();
        let before_runs: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM agent_runs WHERE work_id=?1",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            view_on(&c, &before).unwrap()["chargedOrReserved"],
            tokens(400000, 400000, 8192)
        );
        drop(c);
        reconcile_terminal(&root, id).unwrap();
        let c = crate::source_evidence::open_read_database(&root).unwrap();
        let after = load(&c, id).unwrap();
        assert_eq!(before.state, after.state);
        assert_eq!(before.active_run, after.active_run);
        assert_eq!(after.state, "failed");
        let budget = view_on(&c, &after).unwrap();
        assert_eq!(budget["chargedOrReserved"], tokens(75380, 35956, 228));
        assert!(budget["unmeasuredRunIds"].as_array().unwrap().is_empty());
        assert_eq!(
            c.query_row(
                "SELECT COUNT(*) FROM agent_runs WHERE work_id=?1",
                [id],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            before_runs
        );
        drop(c);
        reconcile_terminal(&root, id).unwrap();
        save(
            &out,
            "offline-replay.json",
            &json!({"schemaError":error,"missingReportStillRejected":true,"correctedFixtureValid":true,"knownUsageReconciled":budget["chargedOrReserved"],"runStillFailed":true,"noRunCreated":true,"reconciliationIdempotent":true,"copyOnly":true,"models":0,"notOriginalFailureRegraded":true}),
        );
        return;
    }
    let stage: usize = phase.parse().unwrap();
    assert!((1..=3).contains(&stage));
    let root = b.join(".local/v4-direct-draft-20261027/profile");
    let freeze = read(&out.join("candidate-freeze.json"));
    assert_eq!(freeze["version"], "0.16.345");
    let c = crate::source_evidence::open_read_database(&root).unwrap();
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM agent_runs WHERE work_id=?1",
            [id],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        stage as i64
    );
    let w = load(&c, id).unwrap();
    drop(c);
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(out.join(format!("formal-{stage}-started.json")))
        .unwrap();
    let text=match stage {1=>"合成草稿修复验收（AI测试输入）：继续完成未交付的当前笔记预览，把原文整理为三个项目符号，保留四项事实、合成限制及原文依据。检查实际草稿后交付，只预览、不保存、不读取其他资料；此前失败保持，不得追认通过。",2=>"合成草稿修订（AI测试输入）：本轮四项编号清单取代此前三个项目符号，分别列出同一原文的数量、责任人、计划日期、验收状态；保留合成限制、原文依据和旧草稿历史。准备并检查本轮新预览，只预览、不保存或执行其他业务写入。",_=>"合成草稿再次修订（AI测试输入）：本轮两列“项目/内容”表格取代此前所有清单格式，列出原文的数量、责任人、计划日期、验收状态四项；保留合成限制、原文依据和旧草稿历史。准备并检查实际新预览，只预览、不保存、不读取其他资料；旧失败保留。"};
    ui(&root,&json!({"action":"message","id":id,"clientMessageId":format!("v4-terminal-repair-{stage}"),"expectedRevision":w.revision,"text":text})).unwrap();
    let mut budget = crate::agent_work::assistant::budget("quick").unwrap();
    budget.model_calls = 5;
    budget.output_repair_calls = 0;
    budget.seconds = 180;
    let start = std::time::Instant::now();
    let result = crate::agent_work::run_mode(&root, id, budget, true);
    save(
        &out,
        &format!("formal-{stage}-return.json"),
        &json!({"ok":result.is_ok(),"error":result.as_ref().err(),"elapsedMs":start.elapsed().as_secs_f64()*1000.0}),
    );
    let state = ui(&root, &json!({"action":"status","id":id})).unwrap();
    save(&out, &format!("formal-{stage}-state.json"), &state);
    assert_eq!(
        std::fs::read_to_string(
            read(&old.join("prepared.json"))["sourceFile"]
                .as_str()
                .unwrap()
        )
        .unwrap(),
        read(&old.join("prepared.json"))["source"].as_str().unwrap()
    );
    assert!(result.is_ok(), "{:?}", result.err());
    assert_eq!(state["work"]["state"], "completed");
}

#[test]
#[ignore = "one separately frozen same-Work Codex native recovery; no DeepSeek retry or source save"]
fn v4_same_work_codex_draft_recovery_once() {
    let b = base();
    let out = b.join("artifacts/architecture-v4-codex-draft-recovery-20261027");
    let contract = read(&out.join("contract.json"));
    let id = contract["workId"].as_str().unwrap();
    let root = b.join(".local/v4-direct-draft-20261027/profile");
    let freeze = read(&out.join("candidate-freeze.json"));
    assert_eq!(freeze["version"], "0.16.345");
    assert_eq!(contract["maxRuns"], 1);
    assert_eq!(contract["maxNativeAgentSessions"], 1);
    let c = crate::source_evidence::open_read_database(&root).unwrap();
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM agent_runs WHERE work_id=?1",
            [id],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        2
    );
    let w = load(&c, id).unwrap();
    assert!(w.active_run.is_none());
    drop(c);
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(out.join("fallback-started.json"))
        .unwrap();
    crate::agent_work::options::configure(&root,&json!({"id":id,"options":{"model":crate::model_runtime::Settings::default(),"autoFlashcardInbox":false}})).unwrap();
    ui(&root,&json!({"action":"message","id":id,"clientMessageId":"v4-codex-draft-recovery-once","expectedRevision":w.revision,"text":"合成草稿恢复验证（AI测试输入）：本轮明确改用Codex原生路径，在同一事项继续完成尚未交付的三项目符号修改草稿，保留原数量17件、责任人陈、计划日期2026-11-04、验收未确认与合成资料的限制。读取当前来源，准备并检查真实草稿后交付预览；不保存或执行其他业务写入、不读取其他资料。之前DeepSeek失败及全部用量保留，不得宣称其原测试通过。"})).unwrap();
    let mut budget = crate::agent_work::assistant::budget("quick").unwrap();
    budget.model_calls = 5;
    budget.output_repair_calls = 0;
    budget.seconds = 180;
    let start = std::time::Instant::now();
    let result = crate::agent_work::run_mode(&root, id, budget, true);
    save(
        &out,
        "fallback-return.json",
        &json!({"ok":result.is_ok(),"error":result.as_ref().err(),"elapsedMs":start.elapsed().as_secs_f64()*1000.0}),
    );
    let state = ui(&root, &json!({"action":"status","id":id})).unwrap();
    save(&out, "fallback-state.json", &state);
    let original = read(&b.join("artifacts/architecture-v4-direct-draft-20261027/prepared.json"));
    assert_eq!(
        std::fs::read_to_string(original["sourceFile"].as_str().unwrap()).unwrap(),
        original["source"].as_str().unwrap()
    );
    assert!(result.is_ok(), "{:?}", result.err());
    assert_eq!(state["work"]["state"], "completed");
}
