//! One independent R7-source qualification; never continues a sealed Work.
use super::*;
use std::path::{Path, PathBuf};
fn seed(f: &Fixture) {
    f.c().execute("INSERT OR IGNORE INTO libraries(id,provider,name,enabled,added_at) VALUES('notes','obsidian','Synthetic batch notes',1,1)",[]).unwrap();
    for i in 0..40 {
        let day = chrono::NaiveDate::from_ymd_opt(2025, 1, 1).unwrap() + chrono::Duration::days(i);
        let extra = if i == 0 {
            "\n复核更正：实际主睡眠6.5小时。"
        } else {
            ""
        };
        f.note(
            "notes",
            &format!("daily/n{i:02}"),
            &format!("# {day}\n昨夜主睡眠实际睡了7小时。{extra}"),
        );
    }
}
fn scoped(f: &Fixture) -> String {
    let selection = json!({"libraryId":"notes","directory":"daily"});
    let preview = ui(
        &f.root,
        &json!({"action":"previewSourceScope","selection":selection}),
    )
    .unwrap();
    assert_eq!(preview["totalMembers"], 40);
    assert_eq!(preview["members"].as_array().unwrap().len(), 20);
    ui(&f.root,&json!({"action":"createWithSourceScope","selection":selection,"expectedManifest":preview["snapshot"],"anchor":{"kind":"note","libraryId":"notes","documentId":"daily/n00"},"goal":"只分析固定daily目录的40份合成记录。自主核对固定清单，按不重叠的20份+20份捕获两个manifestBatch快照；分页完整阅读两批原文，采用正文明确更正，不将旧数值重复计事件。为两批分别保存有逐行出处的主睡眠数据集，调用batchSummary核对完整分区和按记录日的月均值，交付简短报告（包含两批原文出处和覆盖/局限）。不必创建图表，不修改来源或目标，不产生业务写入；不能把主机预检当作模型阅读。","successCriteria":"40份/40个记录日无遗漏重复；明确实际主睡眠才接受，正文更正优先；按记录日和Asia/Shanghai归月。两批数据集及月均、样本数、出处可回读；分区完整不能冒称一般语义穷尽性、远端完整或真实资料验收。"})).unwrap()["work"]["id"].as_str().unwrap().to_owned()
}
fn plan(f: &Fixture, id: &str) -> Value {
    let w = load(&f.c(), id).unwrap();
    let reader = w.grant.reader(&f.root).unwrap();
    let reads=(0..40).map(|i|{let locator=json!({"kind":"note","libraryId":"notes","documentId":format!("daily/n{i:02}"),"pageId":null});let source=reader.read(&serde_json::from_value(locator.clone()).unwrap(),0,6000,None).unwrap();json!({"locator":locator,"version":source.version,"repetitions":1})}).collect::<Vec<_>>();
    json!({"schemaVersion":1,"workRevision":w.revision,"authorizationVersion":w.authorization_version,"requestBytes":3_145_728,"reads":reads,"workingStateRoundTrips":2,"workingStateExtraBytes":8192,"goalStateReads":2,"otherReplyBytes":262144,"reserveRuleRestore":true,"basis":"R7 identical 40-source two-batch fixture: exact production note receipts (conservative versus 8-item pages), two dataset payloads up to 40000 each and batch summary up to 48000, plus 134144 bytes for bounded manifest/snapshot envelopes and changing quote catalogs. All counted against the unchanged 3MiB deep Run ceiling; output tokens independently bounded."})
}
#[test]
fn multi_batch_material_plan_registers_forty_and_preserves_hard_admission_bounds() {
    let f = Fixture::new();
    seed(&f);
    let id = scoped(&f);
    ui(&f.root, &request(&f, &id)).unwrap();
    let p = plan(&f, &id);
    ui(
        &f.root,
        &json!({"action":"freezeMaterialPlan","id":id,"plan":p}),
    )
    .unwrap();
    let before = facts(&f.c(), &id, "nativeMaterialPlan").unwrap();
    assert_eq!(before.len(), 1);
    for field in ["reads", "otherReplyBytes", "requestBytes"] {
        let mut bad = p.clone();
        if field == "reads" {
            let one = bad["reads"][0].clone();
            bad["reads"] = json!(vec![one; 65]);
        } else {
            bad[field] = json!(if field == "otherReplyBytes" {
                262145
            } else {
                3_145_729
            });
        }
        assert!(ui(
            &f.root,
            &json!({"action":"freezeMaterialPlan","id":id,"expectedPlan":p,"plan":bad})
        )
        .is_err());
    }
    assert_eq!(facts(&f.c(), &id, "nativeMaterialPlan").unwrap(), before);
    assert!(facts(&f.c(), &id, "providerBudgetReservation")
        .unwrap()
        .is_empty());
    assert_eq!(
        f.c()
            .query_row(
                "SELECT count(*) FROM agent_runs WHERE work_id=?1",
                [&id],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}
fn save(out: &Path, name: &str, v: &Value) {
    std::fs::write(out.join(name), serde_json::to_vec_pretty(v).unwrap()).unwrap();
}
fn read(p: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap()
}
fn records(f: &Fixture, id: &str) -> Value {
    let c = f.c();
    let mut q=c.prepare("SELECT id,run_id,kind,body_json,created_at FROM agent_records WHERE work_id=?1 ORDER BY rowid").unwrap();
    let values = q
        .query_map([id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    json!(values)
}
#[test]
#[ignore = "one zero-model preparation then at most one independent 40-member provider run"]
fn manifest_admission_qualification_once() {
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .canonicalize()
        .unwrap();
    let out = base.join("artifacts/architecture-v3-manifest-admission-20261027");
    let root = base.join(".local/v3-manifest-admission-20261027/profile");
    let phase = std::env::var("HUB_MANIFEST_ADMISSION_PHASE").unwrap();
    assert!(phase == "prepare" || phase == "actual");
    let contract = read(&out.join("contract.json"));
    assert_eq!(contract["maxActualRuns"], 1);
    assert_eq!(contract["maxCompactions"], 0);
    assert!(
        !out.join(format!("{phase}-started.json")).exists(),
        "fixed phase already consumed"
    );
    let id = if phase == "prepare" {
        assert!(!root.exists());
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join(".hub-isolated-runtime-v1"),
            b"Hub isolated runtime v1\n",
        )
        .unwrap();
        let f = std::mem::ManuallyDrop::new(Fixture { root: root.clone() });
        seed(&f);
        let id = scoped(&f);
        ui(&root,&json!({"action":"configureAssistant","id":id,"options":{"model":{"provider":"codex","model":"","reasoningEffort":"","fast":false,"maxConcurrent":2},"autoFlashcardInbox":false}})).unwrap();
        ui(&root,&json!({"action":"freezeProviderBudget","id":id,"expectedWorkRevision":1,"limits":contract["providerWorkTotal"],"perRun":contract["providerPerRun"],"unknownReservations":{}})).unwrap();
        let p = plan(&f, &id);
        ui(
            &root,
            &json!({"action":"freezeMaterialPlan","id":id,"plan":p}),
        )
        .unwrap();
        save(&out, "material-plan.json", &p);
        let rows = f
            .c()
            .prepare("SELECT id,markdown,content_hash FROM documents ORDER BY id")
            .unwrap()
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(rows.len(), 40);
        save(&out, "source-before.json", &json!(rows));
        save(
            &out,
            "initial-state.json",
            &json!({"workId":id,"root":root,"modelRuns":0,"actions":0,"sources":40,"version":env!("CARGO_PKG_VERSION")}),
        );
        id
    } else {
        let initial = read(&out.join("initial-state.json"));
        assert_eq!(initial["version"], env!("CARGO_PKG_VERSION"));
        let state = read(&out.join("prepare-state.json"));
        assert_eq!(state["materialBudget"]["preflight"]["allowed"], true);
        assert_eq!(
            read(&out.join("run-freeze.json"))["version"],
            env!("CARGO_PKG_VERSION")
        );
        assert!(std::env::var_os("HUB_OS_REPAIR_PREFLIGHT_ONLY").is_none());
        initial["workId"].as_str().unwrap().to_owned()
    };
    let f = std::mem::ManuallyDrop::new(Fixture { root: root.clone() });
    let before = records(&f, &id);
    save(
        &out,
        &format!("{phase}-started.json"),
        &json!({"workId":id,"phase":phase,"maxActualRuns":if phase=="prepare"{0}else{1},"version":env!("CARGO_PKG_VERSION")}),
    );
    if phase == "prepare" {
        std::env::set_var("HUB_OS_REPAIR_PREFLIGHT_ONLY", &id);
        assert_eq!(std::env::var("HUB_OS_REPAIR_PREFLIGHT_ONLY").unwrap(), id);
    }
    let start = std::time::Instant::now();
    let returned = crate::agent_work::run_mode(
        &root,
        &id,
        crate::agent_work::assistant::budget("deep").unwrap(),
        true,
    );
    if phase == "prepare" {
        std::env::remove_var("HUB_OS_REPAIR_PREFLIGHT_ONLY");
    }
    save(
        &out,
        &format!("{phase}-return.json"),
        &json!({"ok":returned.is_ok(),"error":returned.as_ref().err(),"elapsedMs":start.elapsed().as_secs_f64()*1000.0}),
    );
    let view = ui(&root, &json!({"action":"status","id":id})).unwrap();
    save(&out, &format!("{phase}-state.json"), &view);
    let all = records(&f, &id);
    save(&out, &format!("{phase}-records.json"), &all);
    assert!(all
        .as_array()
        .unwrap()
        .starts_with(before.as_array().unwrap()));
    assert_eq!(
        f.c()
            .query_row(
                "SELECT count(*) FROM agent_actions WHERE work_id=?1",
                [&id],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    let rows = f
        .c()
        .prepare("SELECT id,markdown,content_hash FROM documents ORDER BY id")
        .unwrap()
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(json!(rows), read(&out.join("source-before.json")));
    if phase == "prepare" {
        let error = returned.unwrap_err();
        assert!(
            error.contains("已保存材料预检诊断") || error.contains("启动前材料余量不足"),
            "{error}"
        );
        assert_eq!(view["materialBudget"]["preflight"]["allowed"], true);
        assert!(facts(&f.c(), &id, "providerBudgetReservation")
            .unwrap()
            .is_empty());
        assert!(facts(&f.c(), &id, "nativeRuntime").unwrap().is_empty());
    } else {
        assert!(returned.is_ok(), "{:?}", returned.err());
        assert!(view["work"]["report"].is_object());
    }
}
