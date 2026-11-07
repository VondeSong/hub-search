//! Opt-in fixed synthetic provider qualification; never opens the sealed OS Work.
use super::*;
use std::path::PathBuf;
fn save(out: &Path, name: &str, value: &Value) {
    std::fs::write(out.join(name), serde_json::to_vec_pretty(value).unwrap()).unwrap();
}
#[test]
#[ignore = "explicit two-Run synthetic qualification, one compaction, no retry"]
fn native_compaction_actual_once() {
    assert_eq!(std::env::var("HUB_NATIVE_COMPACTION_REAL").unwrap(), "1");
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .canonicalize()
        .unwrap();
    let fresh = std::env::var("HUB_NATIVE_COMPACTION_NEW_CLI")
        .ok()
        .as_deref()
        == Some("0.166");
    let batch = std::env::var("HUB_NATIVE_COMPACTION_THREE_BATCHES").ok().as_deref() == Some("1");
    let closeout = std::env::var("HUB_NATIVE_COMPACTION_CLOSEOUT").ok().as_deref() == Some("1");
    let out = base.join(if closeout {
        "artifacts/agent-autonomy-closeout-20261105/compaction"
    } else if batch {
        "artifacts/agent-three-batches-20261105/compaction"
    } else if fresh {
        "artifacts/agent-core-remaining-20261101/compaction"
    } else {
        "artifacts/architecture-v3-native-compaction-20261026"
    });
    let root = base.join(if closeout {
        ".local/agent-autonomy-closeout-20261105/compaction-profile"
    } else if batch {
        ".local/agent-three-batches-20261105/compaction-profile"
    } else if fresh {
        ".local/native-compaction-20261101/profile"
    } else {
        ".local/v3-native-compaction-20261026/profile"
    });
    assert!(!root.exists());
    assert!(!out.join("actual-started.json").exists());
    let contract: Value =
        serde_json::from_slice(&std::fs::read(out.join("actual-contract.json")).unwrap()).unwrap();
    assert_eq!(contract["maxRuns"], 2);
    assert_eq!(contract["maxCompactions"], 1);
    assert_eq!(contract["version"], env!("CARGO_PKG_VERSION"));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(
        root.join(".hub-isolated-runtime-v1"),
        b"synthetic compaction qualification",
    )
    .unwrap();
    let f =
        std::mem::ManuallyDrop::new(crate::source_evidence::tests::Fixture { root: root.clone() });
    f.c().execute("INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES('notes','obsidian','Synthetic compaction notes',1,1)",[]).unwrap();
    f.note("notes","current","# Synthetic plan\n已确认数量为7件，负责人为林，截止日期为2026-11-03。\n验收条件尚未确认。仅为合成测试数据，不代表真实业务授权。\n");
    let anchor = json!({"kind":"note","libraryId":"notes","documentId":"current","pageId":null});
    let view=super::super::super::ui(&root,&json!({"action":"create","goal":"每轮先调用 hub_read 重新读取当前笔记原文，不用旧答复补全细节。仅根据当前合成笔记报告已确认的数量、负责人、截止日期及未确认事项。先调用hub_goalState核对当前要求，再交付带原文出处的简短报告。不得业务写入，不得新建任务树或改写目标；旧报告不是新的取证。","successCriteria":"7件、林、2026-11-03及验收条件待确认均准确并有原文引用；没有业务动作。","anchor":anchor,"grant":{"notes":[anchor],"libraryIds":[],"readingItemKeys":[]}})).unwrap();
    let id = view["work"]["id"].as_str().unwrap().to_owned();
    super::super::super::ui(&root,&json!({"action":"configureAssistant","id":id,"options":{"model":{"provider":"codex","model":"","reasoningEffort":"","fast":false,"maxConcurrent":2},"autoFlashcardInbox":false}})).unwrap();
    super::super::provider_budget::freeze(&root,&json!({"id":id,"expectedWorkRevision":1,"limits":{"inputTokens":700000,"uncachedInputTokens":220000,"outputTokens":9000},"perRun":{"inputTokens":350000,"uncachedInputTokens":110000,"outputTokens":4500},"unknownReservations":{}})).unwrap();
    let budget = Budget {
        model_calls: 2,
        output_repair_calls: 0,
        tool_steps: 12,
        summaries: 4,
        entities: 1,
        body_chars: 6000,
        request_bytes: 262144,
        seconds: 180,
        model_call_seconds: 120,
    };
    let body_before: String = f
        .c()
        .query_row(
            "SELECT markdown FROM documents WHERE id='current'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    save(
        &out,
        "actual-started.json",
        &json!({"workId":id,"root":root,"maxRuns":2,"maxCompactions":1,"version":env!("CARGO_PKG_VERSION")}),
    );
    for phase in ["baseline", "compacted"] {
        if phase == "compacted" {
            request(&root,&json!({"id":id,"operationId":"synthetic-compact-once","expectedWorkRevision":1,"expectedAuthorizationVersion":1})).unwrap();
        }
        let started = std::time::Instant::now();
        let result = super::super::super::run_mode(&root, &id, budget, true);
        save(
            &out,
            &format!("actual-{phase}-return.json"),
            &json!({"ok":result.is_ok(),"error":result.as_ref().err(),"elapsedMs":started.elapsed().as_secs_f64()*1000.0}),
        );
        let view = super::super::super::ui(&root, &json!({"action":"status","id":id})).unwrap();
        save(&out, &format!("actual-{phase}-state.json"), &view);
        let c = f.c();
        let mut q=c.prepare("SELECT id,run_id,kind,body_json,created_at FROM agent_records WHERE work_id=?1 ORDER BY rowid").unwrap();
        let records = q
            .query_map([&id], |r| {
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
        save(
            &out,
            &format!("actual-{phase}-records.json"),
            &json!(records),
        );
        assert!(result.is_ok(), "{phase}: {:?}", result.err());
        assert!(view["work"]["report"].is_object());
        let report = &view["work"]["report"]["prose"];
        let text = report["markdown"].as_str().unwrap();
        for item in ["7", "林", "2026-11-03", "确认"] {
            assert!(text.contains(item), "missing {item}");
        }
        assert!(report["citations"]
            .as_array()
            .is_some_and(|v| !v.is_empty()));
        if phase == "compacted" {
            let lifecycle = &view["contextCompaction"]["latestLifecycle"];
            assert_eq!(lifecycle["state"], "completed");
            assert_eq!(lifecycle["hostRequested"], true);
            assert_eq!(lifecycle["completionProven"], true);
            if closeout {
                let reads = records.iter().filter(|r| r.2 == "toolCall")
                    .filter(|r| serde_json::from_str::<Value>(&r.3).unwrap()["operation"] == "read").count();
                assert!(reads >= 2, "both turns must obtain current source evidence");
            }
        }
    }
    assert_eq!(
        f.c()
            .query_row(
                "SELECT markdown FROM documents WHERE id='current'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        body_before
    );
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
    save(
        &out,
        "actual-complete.json",
        &json!({"passed":true,"workId":id,"providerRuns":2,"hostCompactionRequests":1,"sourceUnchanged":true,"businessActions":0,"scope":"synthetic backend/provider qualification, not long-task or GUI acceptance"}),
    );
}
