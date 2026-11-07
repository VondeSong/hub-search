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
fn save(out: &Path, name: &str, v: &Value) {
    std::fs::write(out.join(name), serde_json::to_vec_pretty(v).unwrap()).unwrap();
}
const SOURCE:&str="---\naliases: [合成预算草稿]\n---\n数量为17件，责任人为陈，计划日期为2026-11-04。验收状态尚未确认。这是一份合成资料，不代表真实业务已经执行。\n";
#[test]
#[ignore = "zero-model preparation or exactly3 frozen draft-only provider runs, never a save"]
fn v4_direct_draft_fixed_preview_runs() {
    let b = base();
    let out = b.join("artifacts/architecture-v4-direct-draft-20261027");
    let root = b.join(".local/v4-direct-draft-20261027/profile");
    let phase = std::env::var("HUB_V4_DRAFT_PHASE").unwrap();
    let contract = read(&out.join("contract.json"));
    if phase == "prepare" {
        assert!(!root.exists());
        std::fs::create_dir_all(root.join("vault")).unwrap();
        let f = std::mem::ManuallyDrop::new(crate::obsidian_edit::tests::Fixture {
            root: root.clone(),
            vault: root.join("vault"),
        });
        f.c().execute("INSERT INTO libraries(id,provider,name,location,enabled,added_at) VALUES('notes','obsidian','V4合成草稿',?1,1,1)",[f.vault.to_string_lossy().as_ref()]).unwrap();
        let doc = f.seed("Draft.md", SOURCE);
        let locator = json!({"kind":"note","libraryId":"notes","documentId":doc,"pageId":null});
        let settings = crate::model_runtime::Settings {
            provider: "deepseek".into(),
            model: "deepseek-flash".into(),
            reasoning_effort: "none".into(),
            ..Default::default()
        };
        std::fs::write(
            root.join("model-runtime-v1.json"),
            json!({"schemaVersion":2,"settings":settings}).to_string(),
        )
        .unwrap();
        let v=ui(&root,&json!({"action":"create","goal":"合成草稿验收（AI测试输入）：将当前笔记正文整理为三个项目符号，保留数量17件、责任人陈、计划日期2026-11-04、验收尚未确认，以及合成资料不代表真实业务执行的说明。请准备可查看的修改草稿，检查实际草稿后交付预览；只准备不保存，不执行其他业务写入，不读取其他资料。","successCriteria":"有真实持久草稿和实际检查内容，四事实与逐字出处正确；原文件内容、修改时间及属性不变，不得声称已经保存。","anchor":locator,"grant":{"libraryIds":[],"notes":[locator],"readingItemKeys":[]}})).unwrap();
        let id = v["work"]["id"].as_str().unwrap();
        ui(&root,&json!({"action":"freezeProviderBudget","id":id,"expectedWorkRevision":1,"analysisScope":SCOPE,"limits":contract["workLimit"],"perRun":{"inputTokens":400000,"uncachedInputTokens":400000,"outputTokens":8192},"unknownReservations":{}})).unwrap();
        let c = crate::source_evidence::open_read_database(&root).unwrap();
        let w = load(&c, id).unwrap();
        assert_eq!(
            crate::agent_work::actions::view_on(&root, &c, &w).unwrap()["obsidianEditAvailable"],
            true
        );
        save(
            &out,
            "prepared.json",
            &json!({"workId":id,"profile":root,"source":SOURCE,"sourceFile":f.vault.join("Draft.md"),"models":0,"initialState":ui(&root,&json!({"action":"status","id":id})).unwrap()}),
        );
        return;
    }
    let stage: usize = phase.parse().unwrap();
    assert!((1..=3).contains(&stage));
    let prepared = read(&out.join("prepared.json"));
    let id = prepared["workId"].as_str().unwrap();
    let freeze = read(&out.join("candidate-freeze.json"));
    assert_eq!(freeze["version"], "0.16.344");
    let c = crate::source_evidence::open_read_database(&root).unwrap();
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM agent_runs WHERE work_id=?1",
            [id],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        (stage - 1) as i64
    );
    let w = load(&c, id).unwrap();
    drop(c);
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(out.join(format!("formal-{stage}-started.json")))
        .unwrap();
    if stage > 1 {
        let text = if stage == 2 {
            "合成草稿修订（AI测试输入）：根据同一份原文准备本轮新预览，四项编号清单取代此前三个项目符号，分别列出数量、责任人、计划日期、验收状态。保留原四事实、合成限制及出处，保留旧草稿历史；检查实际新草稿，只预览、不保存、不执行其他业务写入。"
        } else {
            "合成草稿再次修订（AI测试输入）：根据同一份原文准备本轮新预览，两列“项目/内容”表格取代此前清单格式，列出数量、责任人、计划日期、验收状态四项。保留原事实、合成限制及出处，保留旧草稿历史；检查实际新草稿，只预览、不保存、不读取其他资料或执行业务写入。"
        };
        ui(&root,&json!({"action":"message","id":id,"clientMessageId":format!("v4-draft-fixed-{stage}"),"expectedRevision":w.revision,"text":text})).unwrap();
    }
    let mut budget = crate::agent_work::assistant::budget("quick").unwrap();
    budget.model_calls = 5;
    budget.output_repair_calls = 0;
    budget.seconds = 180;
    let now = std::time::Instant::now();
    let result = crate::agent_work::run_mode(&root, id, budget, true);
    save(
        &out,
        &format!("formal-{stage}-return.json"),
        &json!({"ok":result.is_ok(),"error":result.as_ref().err(),"elapsedMs":now.elapsed().as_secs_f64()*1000.0}),
    );
    let state = ui(&root, &json!({"action":"status","id":id})).unwrap();
    save(&out, &format!("formal-{stage}-state.json"), &state);
    assert_eq!(
        std::fs::read_to_string(prepared["sourceFile"].as_str().unwrap()).unwrap(),
        SOURCE
    );
    assert!(result.is_ok(), "{:?}", result.err());
    assert_eq!(state["work"]["state"], "completed");
}
