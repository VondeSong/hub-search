//! Bounded closeout through production dispatch and an actual provider, using synthetic data.
use super::*;

fn base() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}
fn save(out: &Path, name: &str, value: &Value) {
    std::fs::write(out.join(name), serde_json::to_vec_pretty(value).unwrap()).unwrap();
}
fn records(root: &Path, id: &str) -> Value {
    let mut result = serde_json::Map::new();
    for kind in [
        "toolCall",
        "toolRejected",
        "toolResult",
        "watchdogIntervention",
        "nativeMeasurement",
        "nativeCompletion",
        "modelExecution",
        "nativeFinal",
        "contextCompaction",
    ] {
        result.insert(
            kind.into(),
            json!(store::records(root, id, kind, 200).unwrap()),
        );
    }
    json!(result)
}

#[test]
#[ignore = "explicit catalog export; no provider and no business writes"]
fn export_complete_tool_catalog() {
    let out = base().join("artifacts/agent-autonomy-closeout-20261105");
    let native = tools(None).unwrap();
    let shared = crate::hub_capabilities::catalog();
    for list in [
        native.as_array().unwrap(),
        shared["tools"].as_array().unwrap(),
    ] {
        let mut names = std::collections::BTreeSet::new();
        for tool in list {
            assert!(names.insert(tool["name"].as_str().unwrap()));
            assert!(!tool["description"].as_str().unwrap().is_empty());
            assert!(tool["inputSchema"].is_object());
        }
    }
    save(&out, "native-tools.json", &native);
    save(&out, "shared-tools.json", &shared);
}

#[test]
#[ignore = "one real Codex turn; explicit synthetic repeated-read closeout only"]
fn repeated_reads_and_failure_recovery() {
    assert_eq!(
        std::env::var("HUB_AUTONOMY_CLOSEOUT_REAL").as_deref(),
        Ok("1")
    );
    let out = base().join("artifacts/agent-autonomy-closeout-20261105/provider");
    let root = base().join(".local/agent-autonomy-closeout-20261105/provider-profile");
    std::fs::create_dir_all(&out).unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(out.join("started"))
        .unwrap();
    assert!(!root.exists());
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(
        root.join(".hub-isolated-runtime-v1"),
        b"Hub isolated runtime v1\n",
    )
    .unwrap();
    let f =
        std::mem::ManuallyDrop::new(crate::source_evidence::tests::Fixture { root: root.clone() });
    f.c().execute("INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES('notes','obsidian','Synthetic closeout',1,1)",[]).unwrap();
    f.note(
        "notes",
        "current",
        "# 验收资料\n数量为7件。验收条件待确认。复核代码为 ORCHID-73。\n",
    );
    let anchor = json!({"kind":"note","libraryId":"notes","documentId":"current","pageId":null});
    let prompt="只读故障和重复复核验收：先顺序调用 hub_read 五次，每次 locator 为 kind=note, libraryId=notes, documentId=current, pageId=null，startChar=0、maxChars=100、expectedVersion=stale-probe。这个过期版本用于制造连续读取失败，请完成五次而不要提前修正（无写入）。之后自行选择修正方法读到当前正文，并再按相同有效参数复核四次，共五次成功读取，用于确认有目的重复读取不被打断。每次失败后简短说明当前第几次验证。最后报告数量、未确认项及原文引用。仅测试，不保存业务资料。";
    let created=crate::agent_work::ui(&root,&json!({"action":"create","goal":prompt,"successCriteria":"","anchor":anchor,"grant":{"notes":[anchor],"libraryIds":[],"readingItemKeys":[]}})).unwrap();
    let id = created["work"]["id"].as_str().unwrap();
    options::configure(&root,&json!({"id":id,"options":{"model":{"provider":"codex","model":"","reasoningEffort":"","fast":false,"maxConcurrent":2},"autoFlashcardInbox":false}})).unwrap();
    let budget = Budget {
        model_calls: 2,
        output_repair_calls: 0,
        tool_steps: 24,
        summaries: 4,
        entities: 2,
        body_chars: 12000,
        request_bytes: 262144,
        seconds: 180,
        model_call_seconds: 150,
    };
    for phase in ["repetition-and-recovery"] {
        let started = std::time::Instant::now();
        let result = crate::agent_work::run_mode(&root, id, budget, true);
        let view = store::view(&root, id).unwrap();
        let record = records(&root, id);
        save(
            &out,
            &format!("{phase}.json"),
            &json!({"result":result,"view":view,"records":record,"elapsedMs":started.elapsed().as_millis()}),
        );
        result.unwrap();
        let answer = view["work"]["report"]["prose"]["markdown"]
            .as_str()
            .unwrap();
        assert!(!view["work"]["report"]["prose"]["citations"]
            .as_array()
            .unwrap()
            .is_empty());
        let calls = record["toolCall"].as_array().unwrap();
        if phase == "repetition-and-recovery" {
            assert!(answer.contains('7') && answer.contains("确认"));
            assert_eq!(
                calls
                    .iter()
                    .filter(|v| v["operation"] == "read"
                        && v["expectedVersion"]["fingerprint"] == "stale-probe")
                    .count(),
                5
            );
            assert!(
                calls
                    .iter()
                    .filter(|v| v["operation"] == "read"
                        && v["expectedVersion"]["fingerprint"] != "stale-probe")
                    .count()
                    >= 5
            );
            assert!(record["watchdogIntervention"].as_array().unwrap().len() <= 1);
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
    save(
        &out,
        "complete.json",
        &json!({"passed":true,"workId":id,"runs":1,"compactions":0,"businessActions":0}),
    );
}

// Saved trace qualification uses the actual normalized version object and no provider.
#[test]
#[ignore = "explicit saved synthetic provider trace; zero new model calls"]
fn verify_saved_repetition_trace() {
    let out = base().join("artifacts/agent-autonomy-closeout-20261105/provider");
    let prior: Value =
        serde_json::from_slice(&std::fs::read(out.join("repetition-and-recovery.json")).unwrap())
            .unwrap();
    assert!(prior["result"].get("Ok").is_some());
    let calls = prior["records"]["toolCall"].as_array().unwrap();
    assert_eq!(
        calls
            .iter()
            .filter(|v| v["operation"] == "read"
                && v["expectedVersion"]["fingerprint"] == "stale-probe")
            .count(),
        5
    );
    assert_eq!(
        calls
            .iter()
            .filter(|v| v["operation"] == "read" && v["expectedVersion"].is_null())
            .count(),
        5
    );
    assert_eq!(
        prior["records"]["watchdogIntervention"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(prior["view"]["work"]["report"]["prose"]["markdown"]
        .as_str()
        .unwrap()
        .contains('7'));
    assert!(!prior["view"]["work"]["report"]["prose"]["citations"]
        .as_array()
        .unwrap()
        .is_empty());
    save(
        &out,
        "trace-verification.json",
        &json!({"passed":true,"versionObjectAssertionCorrected":true,"newModelCalls":0,"readFailures":5,"successfulReads":5,"sameSuccessParameterRepeats":4,"advisories":1,"source":"repetition-and-recovery.json"}),
    );
}
