use super::*;
use std::path::PathBuf;
fn base() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .canonicalize()
        .unwrap()
}
fn save(out: &Path, name: &str, value: &Value) {
    std::fs::write(out.join(name), serde_json::to_vec_pretty(value).unwrap()).unwrap();
}
fn read(p: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap()
}
fn all_records(root: &Path, id: &str) -> Value {
    let c = crate::source_evidence::open_read_database(root).unwrap();
    let mut q=c.prepare("SELECT id,run_id,kind,body_json,created_at FROM agent_records WHERE work_id=?1 ORDER BY rowid").unwrap();
    json!(q
        .query_map([id], |r| Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, i64>(4)?
        )))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap())
}
const SOURCE:&str="合成预算验收资料：数量为17件，责任人为陈，计划日期为2026-11-04。验收状态尚未确认。这是一份合成资料，不代表真实业务已经执行。";
#[test]
#[ignore = "explicit single zero-model preparation OR fixed real-provider round; frozen controller required"]
fn v4_direct_saved_work_qualification_and_fixed_provider_round() {
    let b = base();
    let out = b.join("artifacts/architecture-v4-direct-budget-20261027");
    let root = b.join(".local/v4-direct-budget-20261027/profile");
    let phase = std::env::var("HUB_V4_DIRECT_PHASE").unwrap();
    if phase == "prepare" {
        assert!(!root.exists());
        std::fs::create_dir_all(&root).unwrap();
        // The persisted acceptance profile is never a temporary Fixture's deletion target.
        let f = std::mem::ManuallyDrop::new(Fixture { root: root.clone() });
        f.c().execute_batch("INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES('notes','obsidian','V4合成预算资料',1,1)").unwrap();
        f.note("notes", "current", SOURCE);
        std::fs::write(root.join("current.md"), SOURCE).unwrap();
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
        let locator =
            json!({"kind":"note","libraryId":"notes","documentId":"current","pageId":null});
        let view=ui(&root,&json!({"action":"create","goal":"合成只读验收：根据唯一已授权笔记说明数量、责任人和计划日期，并明确验收状态是否已确认；提供逐字出处。先主动读取当前原文并调用goalState核对有效要求，只交付简短回答，不生成图表、任务树、草稿或业务动作，不读取其他资料。","successCriteria":"四项事实准确，逐字出处来自当前原文，不把未确认写成完成。","anchor":locator,"grant":{"libraryIds":[],"notes":[locator],"readingItemKeys":[],"sources":[],"attachmentLibraryIds":[]}})).unwrap();
        let id = view["work"]["id"].as_str().unwrap();
        ui(&root,&json!({"action":"freezeProviderBudget","id":id,"expectedWorkRevision":1,"analysisScope":SCOPE,"limits":tokens(600000,600000,24576),"perRun":tokens(200000,200000,8192),"unknownReservations":{}})).unwrap();
        save(
            &out,
            "prepared.json",
            &json!({"root":root,"workId":id,"models":0,"source":SOURCE,"initialRecords":all_records(&root,id),"initialState":ui(&root,&json!({"action":"status","id":id})).unwrap(),"scope":SCOPE}),
        );
        let credential =
            crate::model_runtime::ui(&root, &json!({"action":"credentialStatus"})).unwrap();
        let catalog = if credential["deepseekConfigured"] == true {
            crate::model_runtime::ui(&root, &json!({"action":"models","provider":"deepseek"}))
        } else {
            Err("未配置提供方凭据".into())
        };
        let qualified = catalog.as_ref().is_ok_and(|v| {
            v["models"]
                .as_array()
                .is_some_and(|a| a.iter().any(|m| m["id"] == "deepseek-flash"))
        });
        save(
            &out,
            "provider-qualification.json",
            &json!({"qualified":qualified,"credentialConfigured":credential["deepseekConfigured"],"catalog":catalog.as_ref().ok(),"error":catalog.as_ref().err(),"providerModelRequests":0,"newWorkForIndependentV4Case":true,"sealedWorkTouched":false}),
        );
        assert!(
            qualified,
            "No provider generation allowed without qualification"
        );
        return;
    }
    let round: usize = phase.parse().unwrap();
    assert!((1..=3).contains(&round));
    let prepared = read(&out.join("prepared.json"));
    assert_eq!(prepared["root"], json!(root));
    let id = prepared["workId"].as_str().unwrap();
    let qualified = read(&out.join("provider-qualification.json"));
    assert_eq!(qualified["qualified"], true);
    let freeze = read(&out.join("candidate-freeze.json"));
    assert_eq!(freeze["version"], "0.16.343");
    assert_eq!(freeze["maxProviderRuns"], 3);
    let marker = out.join(format!("formal-{round}-started.json"));
    let mut marker_file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(marker)
        .unwrap();
    use std::io::Write;
    marker_file
        .write_all(json!({"round":round,"workId":id}).to_string().as_bytes())
        .unwrap();
    let c = crate::source_evidence::open_read_database(&root).unwrap();
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM agent_runs WHERE work_id=?1",
            [id],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        (round - 1) as i64
    );
    drop(c);
    let old = all_records(&root, id);
    if round > 1 {
        let w = load(
            &crate::source_evidence::open_read_database(&root).unwrap(),
            id,
        )
        .unwrap();
        let text = if round == 2 {
            "合成验收追加要求：根据同一份资料，把回答改为两句，仍须保留数量、责任人、日期、验收尚未确认和出处；不修改来源、不产生业务动作。"
        } else {
            "合成验收再次追加：将同一资料的数量写成数字加单位，并把计划日期和未确认状态放在同一句；保留责任人和出处，不能宣称实际业务完成。"
        };
        ui(&root,&json!({"action":"message","id":id,"clientMessageId":format!("v4-direct-fixed-{round}"),"expectedRevision":w.revision,"text":text})).unwrap();
    }
    let mut budget = crate::agent_work::assistant::budget("quick").unwrap();
    budget.model_calls = 3;
    budget.output_repair_calls = 0;
    budget.seconds = 180;
    let began = std::time::Instant::now();
    let result = crate::agent_work::run_mode(&root, id, budget, true);
    save(
        &out,
        &format!("formal-{round}-return.json"),
        &json!({"ok":result.is_ok(),"error":result.as_ref().err(),"elapsedMs":began.elapsed().as_secs_f64()*1000.0}),
    );
    let after = ui(&root, &json!({"action":"status","id":id})).unwrap();
    save(&out, &format!("formal-{round}-state.json"), &after);
    let records = all_records(&root, id);
    save(&out, &format!("formal-{round}-records.json"), &records);
    assert!(records
        .as_array()
        .unwrap()
        .starts_with(old.as_array().unwrap()));
    assert_eq!(
        std::fs::read_to_string(root.join("current.md")).unwrap(),
        SOURCE
    );
    assert_eq!(
        crate::source_evidence::open_read_database(&root)
            .unwrap()
            .query_row("SELECT COUNT(*) FROM agent_actions", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert!(result.is_ok(), "{:?}", result.err());
    assert_eq!(after["work"]["state"], "completed");
}

#[test]
#[ignore = "prospectively frozen two same-Work budget continuations; old tool-adherence failure retained"]
fn v4_budget_saved_two_continuations() {
    let b = base();
    let out = b.join("artifacts/architecture-v4-budget-continuity-20261027");
    let contract = read(&out.join("contract.json"));
    assert_eq!(contract["maxNewRuns"], 2);
    assert_eq!(contract["maxApplicationBuilds"], 0);
    let stage: usize = std::env::var("HUB_V4_BUDGET_CONTINUATION")
        .unwrap()
        .parse()
        .unwrap();
    assert!((1..=2).contains(&stage));
    let root = b.join(".local/v4-direct-budget-20261027/profile");
    let id = contract["workId"].as_str().unwrap();
    let frozen = read(&out.join("candidate-freeze.json"));
    assert_eq!(frozen["version"], "0.16.343");
    let old_failure =
        read(&b.join("artifacts/architecture-v4-direct-budget-20261027/formal-1-review.json"));
    assert_eq!(old_failure["passed"], false);
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
    assert_eq!(w.state, "completed");
    assert!(w.active_run.is_none());
    let budget_view = super::super::super::view_on(&c, &w).unwrap();
    assert_eq!(budget_view["limits"], contract["workLimit"]);
    assert_eq!(budget_view["canAdmitRun"], true);
    drop(c);
    let marker = out.join(format!("continuation-{stage}-started.json"));
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(marker)
        .unwrap();
    let before = all_records(&root, id);
    let text = if stage == 1 {
        "合成预算连续性验收的未来阶段指令（AI按本次开发授权编写，不是人类业务确认）：原先指定goalState调用的测试失败保持，不在本轮追认或修复；以下新的预算专项目标替代先前固定工具路径限定，其他事实、权限与预算要求保留。允许按宿主已提供的当前原文和goalState直接核对，必要时自行选择工具。请把同一份资料的回答正文修订为两句，完整保留数量、责任人、计划日期、验收未确认，并说明资料是合成的、不代表真实业务执行；用引用标记对应出处区的逐字原文，不在正文重复抄写全文。不要读取其他来源，不生成图表、任务树、草稿或业务动作。"
    } else {
        "合成预算连续性验收再次修订（AI测试输入）：本轮四项清单取代上一条两句格式，列出同一资料的数量、责任人、计划日期、验收状态，保留逐字出处和合成资料的限制说明。其余只读范围与预算要求保持，原指定工具服从失败仍未解决；本轮不要求额外的读取/goalState调用，不得声称旧失败通过。"
    };
    ui(&root,&json!({"action":"message","id":id,"clientMessageId":format!("v4-budget-continuation-{stage}"),"expectedRevision":w.revision,"text":text})).unwrap();
    let mut budget = crate::agent_work::assistant::budget("quick").unwrap();
    budget.model_calls = 2;
    budget.output_repair_calls = 0;
    budget.seconds = 180;
    let started = std::time::Instant::now();
    let result = crate::agent_work::run_mode(&root, id, budget, true);
    save(
        &out,
        &format!("continuation-{stage}-return.json"),
        &json!({"ok":result.is_ok(),"error":result.as_ref().err(),"elapsedMs":started.elapsed().as_secs_f64()*1000.0}),
    );
    let state = ui(&root, &json!({"action":"status","id":id})).unwrap();
    save(&out, &format!("continuation-{stage}-state.json"), &state);
    let after = all_records(&root, id);
    save(&out, &format!("continuation-{stage}-records.json"), &after);
    assert!(after
        .as_array()
        .unwrap()
        .starts_with(before.as_array().unwrap()));
    assert_eq!(
        std::fs::read_to_string(root.join("current.md")).unwrap(),
        SOURCE
    );
    assert!(result.is_ok(), "{:?}", result.err());
    assert_eq!(state["work"]["state"], "completed");
}

#[test]
#[ignore = "saved zero-model protocol replay or frozen two repair runs; never resumes sealed tests"]
fn v4_completion_protocol_saved_replay_and_fixed_runs() {
    let b = base();
    let out = b.join("artifacts/architecture-v4-completion-protocol-20261027");
    let root = b.join(".local/v4-direct-budget-20261027/profile");
    let contract = read(&out.join("contract.json"));
    let id = contract["workId"].as_str().unwrap();
    let phase = std::env::var("HUB_V4_COMPLETION_PHASE").unwrap();
    let c = crate::source_evidence::open_read_database(&root).unwrap();
    let w = load(&c, id).unwrap();
    if phase == "offline" {
        let before = all_records(&root, id);
        let input = read(&out.join("replay-input.json"));
        let raw = input["candidate"].clone();
        crate::model_runtime::validate_agent_tool(
            &raw,
            &crate::agent_work::assistant::schema(crate::agent_work::runner::schema()),
        )
        .unwrap();
        let normalized =
            crate::agent_work::assistant::normalize(raw, &input["quoteCatalog"]).unwrap();
        let report = serde_json::from_value(normalized["report"].clone()).unwrap();
        let run = input["runId"].as_str().unwrap();
        let error =
            crate::agent_work::store::goal::completion::evaluate(&root, &c, &w, run, &report)
                .unwrap_err();
        assert_eq!(error, "核对引用了不存在的用户要求");
        let mut corrected = normalized["report"].clone();
        for (i, item) in corrected["completion"]["items"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .enumerate()
        {
            item["requirementId"] = input["goalState"]["requirements"][if i < 4 {
                0
            } else if i == 4 {
                1
            } else {
                2
            }]["requirementId"]
                .clone();
        }
        let report = serde_json::from_value(corrected).unwrap();
        let evaluated =
            crate::agent_work::store::goal::completion::evaluate(&root, &c, &w, run, &report)
                .unwrap();
        assert_eq!(evaluated["coverageComplete"], true);
        assert_eq!(evaluated["workFulfillment"], "fulfilled");
        assert_eq!(all_records(&root, id), before);
        save(
            &out,
            "offline-replay.json",
            &json!({"originalRejected":error,"correctedFixtureCoverage":evaluated["coverageComplete"],"correctedFixtureSemanticSource":evaluated["semanticChecks"],"recordsUnchanged":true,"models":0,"diagnosticOnly":true,"productionRemapping":false}),
        );
        return;
    }
    let stage: usize = phase.parse().unwrap();
    assert!((1..=2).contains(&stage));
    let freeze = read(&out.join("candidate-freeze.json"));
    assert_eq!(freeze["version"], "0.16.344");
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM agent_runs WHERE work_id=?1",
            [id],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        (stage + 1) as i64
    );
    assert!(w.active_run.is_none());
    let budget_view = super::super::super::view_on(&c, &w).unwrap();
    assert_eq!(budget_view["limits"], contract["workLimit"]);
    assert_eq!(budget_view["canAdmitRun"], true);
    drop(c);
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(out.join(format!("formal-{stage}-started.json")))
        .unwrap();
    let before = all_records(&root, id);
    let text = if stage == 1 {
        "合成预算连续性修复验收（AI测试输入）：请根据同一授权资料完成上次未交付的两句修订，完整保留数量、责任人、计划日期、验收未确认、合成资料不代表真实业务执行的说明和逐字出处。沿用上一条允许使用宿主已提供的当前原文和目标状态的范围；不要求额外读取或goalState调用，不读取其他来源，不生成图表、任务、草稿或业务动作。原两次失败保持，不得声称旧失败通过。"
    } else {
        "合成预算连续性再次修订（AI测试输入）：以四项清单取代先前的两句格式，分别列出同一资料的数量、责任人、计划日期、验收状态；保留逐字出处和合成资料不代表真实业务执行的限制说明。其余只读范围、预算和既有失败记录保持，不需要额外读取或goalState调用，不得声称旧失败通过。"
    };
    ui(&root,&json!({"action":"message","id":id,"clientMessageId":format!("v4-completion-repair-{stage}"),"expectedRevision":w.revision,"text":text})).unwrap();
    let mut budget = crate::agent_work::assistant::budget("quick").unwrap();
    budget.model_calls = 2;
    budget.output_repair_calls = 0;
    budget.seconds = 180;
    let began = std::time::Instant::now();
    let result = crate::agent_work::run_mode(&root, id, budget, true);
    save(
        &out,
        &format!("formal-{stage}-return.json"),
        &json!({"ok":result.is_ok(),"error":result.as_ref().err(),"elapsedMs":began.elapsed().as_secs_f64()*1000.0}),
    );
    let state = ui(&root, &json!({"action":"status","id":id})).unwrap();
    save(&out, &format!("formal-{stage}-state.json"), &state);
    let records = all_records(&root, id);
    save(&out, &format!("formal-{stage}-records.json"), &records);
    assert!(records
        .as_array()
        .unwrap()
        .starts_with(before.as_array().unwrap()));
    assert_eq!(
        std::fs::read_to_string(root.join("current.md")).unwrap(),
        SOURCE
    );
    assert!(result.is_ok(), "{:?}", result.err());
    assert_eq!(state["work"]["state"], "completed");
}
