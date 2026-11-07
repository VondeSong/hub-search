//! Explicit synthetic real-provider acceptance, with no external writes.
use super::*;
mod closeout;

#[test]
#[ignore = "three bounded real Codex tasks; explicit isolated evidence directory"]
fn autonomous_choices_and_argument_recovery() {
    assert_eq!(std::env::var("HUB_AUTONOMY_REAL").as_deref(), Ok("1"));
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let scoped_only = std::env::var("HUB_AUTONOMY_SCOPED_ONLY").as_deref() == Ok("1");
    let recovery_only = std::env::var("HUB_AUTONOMY_RECOVERY_ONLY").as_deref() == Ok("1");
    let out = base.join(if recovery_only {
        "artifacts/agent-autonomy-20261105/actual-recovery"
    } else if scoped_only {
        "artifacts/agent-autonomy-20261105/actual-scoped"
    } else {
        "artifacts/agent-autonomy-20261105/actual"
    });
    std::fs::create_dir_all(&out).unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(out.join("started"))
        .unwrap();
    let f = crate::source_evidence::tests::Fixture::new();
    f.note(
        "notes",
        "current",
        "# 数量\n本次合成测试数量为7件，验收条件尚未确认。\n",
    );
    f.note(
        "notes",
        "owner",
        "# 分工\n本次合成测试负责人为林，截止日期为2026-11-03。\n",
    );
    let cases = [
        ("direct", "只回答数字：2加3等于多少？不需要查询资料。", false),
        ("sources", "综合两篇合成资料，说明数量、负责人、截止日期，以及仍待确认的条件，附原文引用。自行决定如何获取资料。", true),
        ("recovery", "进行一次只读参数恢复测试：先用 hub_read 读取 locator kind=note, libraryId=notes, documentId=current, pageId=null，startChar=0，maxChars=100，expectedVersion=null。使用这次返回的 toolResultRef 调用 hub_traceResult，recordId 和 expectedSha256 取真实回执，startChar=0，但故意传 maxChars=4001。观察实际参数拒绝后，自行选择合规参数完成一次历史回查。最后按当前原文引用回答数量和未确认事项，区分历史结果与当前引用。仅测试只读工具，不保存或修改资料。", true),
    ];
    for (name, prompt, scoped) in cases {
        if recovery_only && name != "recovery" {
            continue;
        }
        if scoped_only && !scoped {
            continue;
        }
        let notes = if scoped {
            json!([
                {"kind":"note","libraryId":"notes","documentId":"current","pageId":null},
                {"kind":"note","libraryId":"notes","documentId":"owner","pageId":null}
            ])
        } else {
            json!([])
        };
        let anchor = if scoped {
            notes[0].clone()
        } else {
            Value::Null
        };
        let view = crate::agent_work::ui(&f.root, &json!({"action":"create","goal":prompt,"successCriteria":"","anchor":anchor,"grant":{"libraryIds":[],"notes":notes,"readingItemKeys":[]}})).unwrap();
        let id = view["work"]["id"].as_str().unwrap();
        options::configure(&f.root,&json!({"id":id,"options":{"model":{"provider":"codex","model":"","reasoningEffort":"","fast":false,"maxConcurrent":2},"autoFlashcardInbox":false}})).unwrap();
        let started = std::time::Instant::now();
        let result =
            crate::agent_work::ui(&f.root, &json!({"action":"respond","id":id,"mode":"quick"}));
        let view = store::view(&f.root, id).unwrap();
        let mut records = serde_json::Map::new();
        for kind in [
            "toolCall",
            "toolRejected",
            "watchdogIntervention",
            "nativeMeasurement",
            "nativeCompletion",
            "modelExecution",
            "nativeFinal",
        ] {
            records.insert(
                kind.into(),
                json!(store::records(&f.root, id, kind, 200).unwrap()),
            );
        }
        std::fs::write(out.join(format!("{name}.json")),serde_json::to_vec_pretty(&json!({"result":result,"view":view,"records":records,"elapsedMs":started.elapsed().as_millis()})).unwrap()).unwrap();
        result.unwrap();
        let report = &view["work"]["report"]["prose"];
        let text = report["markdown"].as_str().unwrap();
        if name == "direct" {
            assert!(text.contains('5'));
            assert!(records["toolCall"].as_array().unwrap().is_empty());
        } else {
            assert!(text.contains('7') && text.contains("确认"));
            assert!(!report["citations"].as_array().unwrap().is_empty());
            if name == "sources" {
                assert!(text.contains('林') && text.contains("2026-11-03"));
            }
            if name == "recovery" {
                assert!(records["toolRejected"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|r| r["tool"] == "hub_traceResult"));
                assert!(records["toolCall"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|r| r["operation"] == "traceResult"));
            }
        }
        assert_eq!(
            f.c()
                .query_row(
                    "SELECT count(*) FROM agent_actions WHERE work_id=?1",
                    [id],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }
    std::fs::write(out.join("complete.json"),serde_json::to_vec_pretty(&json!({"passed":true,"cases":if recovery_only {1} else if scoped_only {2} else {3},"externalWrites":0,"scope":"synthetic provider acceptance; not a population benchmark"})).unwrap()).unwrap();
}
