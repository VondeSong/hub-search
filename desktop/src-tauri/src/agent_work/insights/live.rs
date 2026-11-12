//! Opt-in S16: two real user rounds on persistent, synthetic, isolated notes.
use super::*;
fn save(out: &Path, name: &str, value: &Value) {
    std::fs::write(out.join(name), serde_json::to_vec_pretty(value).unwrap()).unwrap();
}
fn dispatch(root: &Path, args: Value) -> Value {
    super::super::ui(root, &args).unwrap()
}
fn select(root: &Path, work: &str) -> Value {
    let records = dispatch(root, json!({"action":"insightDeliveries","id":work}));
    let record = records["items"][0]["deliveryRecordId"]
        .as_str()
        .expect("published delivery");
    dispatch(
        root,
        json!({"action":"insightCandidates","id":work,"deliveryRecordId":record}),
    )
}
fn mutation(root: &Path, item: &Value, action: &str, extra: Value) -> Value {
    let mut args = json!({"action":action,"insightId":item["id"],"expectedRevision":item["rowRevision"],"operationId":crate::random_url_safe(18)});
    for (key, value) in extra.as_object().unwrap() {
        args[key] = value.clone();
    }
    dispatch(root, args)
}
#[test]
#[ignore = "exactly two real Codex user rounds; writes only the named synthetic acceptance profile"]
fn s16_two_real_user_rounds_once() {
    assert_eq!(std::env::var("HUB_INSIGHTS_S16").as_deref(), Ok("1"));
    let out = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".local/insights-s16-20261112");
    std::fs::create_dir_all(&out).unwrap();
    std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(out.join("attempt-started"))
        .expect("never repeat a real attempt without a recorded repair/new attempt");
    let root = out.join("profile");
    let vault = root.join("vault");
    std::fs::create_dir_all(&vault).unwrap();
    std::fs::write(
        root.join(".hub-isolated-runtime-v1"),
        b"Hub isolated runtime v1\n",
    )
    .unwrap();
    let mut c = crate::open_database(&root.join("craft-search.sqlite3")).unwrap();
    c.execute("INSERT INTO libraries(id,provider,name,location,enabled,added_at) VALUES('insights-s16','obsidian','洞察隔离验收资料',?1,1,1)",[vault.to_string_lossy().as_ref()]).unwrap();
    let mut notes = Vec::new();
    for (name, text) in [
        (
            "D1.md",
            "样本编号为蓝湾-731。验证前先固定输入、预期结果和通过条件。",
        ),
        (
            "D2.md",
            "本周已完成原型验证；采用先小样本、再扩大范围的方法。",
        ),
    ] {
        let path = vault.join(name);
        std::fs::write(&path, text).unwrap();
        let doc = crate::read_markdown_document_with_exclusions(&vault, &path, &[]).unwrap();
        let tx = c.transaction().unwrap();
        crate::upsert_obsidian_document(&tx, "insights-s16", &doc, 1).unwrap();
        tx.commit().unwrap();
        notes.push(
            json!({"kind":"note","libraryId":"insights-s16","documentId":doc.id,"pageId":null}),
        );
    }
    drop(c);
    let prompt="请根据已选的 D1 和 D2，分别给出验证前的方法建议与本周验证进展，说明资料没有限定的完成范围。请交付有精确资料引用的结构化发现，使用 hub_finish 的 findings，供我逐条保存；普通正文自然表达即可。不改原文，不执行其他保存。";
    let created = dispatch(
        &root,
        json!({"action":"create","goal":prompt,"successCriteria":"方法建议与进展分别有对应原文依据；完成范围未知则保留未知。","anchor":notes[0],"grant":{"notes":notes,"libraryIds":[],"readingItemKeys":[]}}),
    );
    let work = created["work"]["id"].as_str().unwrap();
    let options = json!({"provider":"codex","model":"gpt-6.1-sol","reasoningEffort":"","fast":false,"maxConcurrent":2});
    dispatch(
        &root,
        json!({"action":"configureAssistant","id":work,"options":{"model":options,"autoFlashcardInbox":false,"externalMcp":false}}),
    );
    let b = assistant::budget("quick").unwrap();
    save(
        &out,
        "plan.json",
        &json!({"schema":86,"workId":work,"notes":notes,"model":options,"maximumUserRounds":2,"initialMessage":prompt,"plannedUserSupplement":"这里的‘完成’仅指纸面原型，尚未完成实机验证。","normalBudget":{"modelCalls":b.model_calls,"toolSteps":b.tool_steps,"bodyChars":b.body_chars,"requestBytes":b.request_bytes,"seconds":b.seconds,"modelCallSeconds":b.model_call_seconds,"nativeModelCallSeconds":assistant::provider_budget(b,"codex").model_call_seconds},"automaticModelRetries":0,"sources":"synthetic D1/D2 only"}),
    );
    for phase in 1..=2 {
        let result = super::super::run_mode(&root, work, assistant::budget("quick").unwrap(), true);
        let view = dispatch(&root, json!({"action":"status","id":work}));
        let records = store::records(&root, work, "modelExecution", 50).unwrap();
        save(
            &out,
            &format!("round-{phase}.json"),
            &json!({"result":result,"status":view,"modelExecutions":records}),
        );
        result.unwrap();
        let candidates = select(&root, work);
        save(&out, &format!("round-{phase}-candidates.json"), &candidates);
        let usable = candidates["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|v| v["eligibility"] == "verifiedSources")
            .collect::<Vec<_>>();
        assert!(
            !usable.is_empty(),
            "real structured candidates required; preserve failure instead of resampling"
        );
        if phase == 1 && std::env::var("HUB_INSIGHTS_S16_MANUAL").as_deref() == Ok("1") {
            save(
                &out,
                "desktop-handoff.json",
                &json!({"root":root,"workId":work,"completedUserRounds":1,"remainingUserRounds":1,"next":"Use the formal desktop UI to save findings, set later, save U1, explicitly continue once, and explicitly update from the second delivery."}),
            );
            return;
        }
        if phase == 1 {
            let mut saved = Vec::new();
            for v in usable {
                let result = dispatch(
                    &root,
                    json!({"action":"insightImport","id":work,"deliveryRecordId":candidates["origin"]["deliveryRecordId"],"deliveryHash":candidates["origin"]["deliveryHash"],"findingPointer":v["findingPointer"],"confirmDependencies":true,"contextEvidenceIds":[],"operationId":crate::random_url_safe(18)}),
                );
                saved.push(result["item"].clone());
            }
            let target = saved
                .iter()
                .find(|v| {
                    v["snapshot"]["sourceCitations"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|e| e["excerpt"]["locator"]["documentId"] == notes[1]["documentId"])
                })
                .expect("progress finding cites D2");
            let target = mutation(
                &root,
                target,
                "insightStatus",
                json!({"state":"later","snoozeUntil":store::stamp()+86_400_000}),
            )["item"]
                .clone();
            let feedback_op = crate::random_url_safe(18);
            let feedback = mutation(
                &root,
                &target,
                "insightFeedback",
                json!({"operationId":feedback_op,"kind":"correction","text":"这里的‘完成’仅指纸面原型，尚未完成实机验证。"}),
            );
            let feedback_id = feedback_op.as_str();
            let sent = mutation(
                &root,
                &feedback["item"],
                "insightContinue",
                json!({"feedbackIds":[feedback_id]}),
            );
            save(
                &out,
                "saved-round-one.json",
                &json!({"items":saved,"target":sent["item"],"feedbackId":feedback_id}),
            );
        } else {
            let previous: Value =
                serde_json::from_slice(&std::fs::read(out.join("saved-round-one.json")).unwrap())
                    .unwrap();
            let target = &previous["target"];
            let v = usable
                .iter()
                .find(|v| {
                    v["text"]
                        .as_str()
                        .is_some_and(|s| s.contains("纸面") && s.contains("实机"))
                })
                .expect("correct paper-only / device-unverified meaning");
            let result = dispatch(
                &root,
                json!({"action":"insightUpdate","insightId":target["id"],"expectedRevision":target["rowRevision"],"deliveryRecordId":candidates["origin"]["deliveryRecordId"],"deliveryHash":candidates["origin"]["deliveryHash"],"findingPointer":v["findingPointer"],"confirmDependencies":true,"contextEvidenceIds":[],"feedbackIds":[previous["feedbackId"]],"confirmFeedbackHandled":true,"operationId":crate::random_url_safe(18)}),
            );
            save(&out, "updated-round-two.json", &result);
            assert_eq!(result["item"]["id"], target["id"]);
            assert_eq!(result["item"]["processingState"], "later");
            assert_eq!(
                result["item"]["snapshot"]["userContextRefs"][0]["feedbackId"],
                previous["feedbackId"]
            );
            for e in result["item"]["snapshot"]["sourceCitations"]
                .as_array()
                .unwrap()
            {
                assert!(!e["quote"].as_str().unwrap().contains("纸面"));
            }
            let reopened = dispatch(
                &root,
                json!({"action":"insightDetail","insightId":target["id"]}),
            );
            assert_eq!(reopened["headRevision"], 2);
            assert_eq!(reopened["processingState"], "later");
            save(&out, "reopened.json", &reopened);
        }
    }
}

#[test]
#[ignore = "requires the frozen real schema-85 synthetic database created by the preceding desktop binary"]
fn s14a_b_upgrade_actual_frozen_schema85_and_failed_retry() {
    let out = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".local/insights-schema85-frozen");
    let frozen = out.join("schema85.sqlite3");
    let freeze: Value =
        serde_json::from_slice(&std::fs::read(out.join("freeze.json")).unwrap()).unwrap();
    assert_eq!(
        format!("{:x}", Sha256::digest(std::fs::read(&frozen).unwrap())),
        freeze["databaseSha256"].as_str().unwrap()
    );
    for fail_first in [false, true] {
        let path = out.join(format!("upgrade-{}.sqlite3", crate::random_url_safe(12)));
        std::fs::copy(&frozen, &path).unwrap();
        if fail_first {
            let c = Connection::open(&path).unwrap();
            c.execute_batch("CREATE TABLE insight_events(operation_id TEXT,request_hash TEXT,insight_id TEXT,kind TEXT,body_json TEXT,result_revision INTEGER,target_revision INTEGER,created_at INTEGER)").unwrap();
            drop(c);
            assert!(crate::open_database(&path).is_err());
            let c = Connection::open(&path).unwrap();
            assert_eq!(
                c.query_row::<String, _, _>(
                    "SELECT value FROM metadata WHERE key='schema_version'",
                    [],
                    |r| r.get(0)
                )
                .unwrap(),
                "85"
            );
            assert_eq!(
                c.query_row::<i64, _, _>(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name='insights'",
                    [],
                    |r| r.get(0)
                )
                .unwrap(),
                0
            );
            c.execute_batch("DROP TABLE insight_events").unwrap();
        }
        let c = crate::open_database(&path).unwrap();
        assert_eq!(
            c.query_row::<String, _, _>(
                "SELECT value FROM metadata WHERE key='schema_version'",
                [],
                |r| r.get(0)
            )
            .unwrap(),
            "86"
        );
        assert_eq!(
            c.query_row::<String, _, _>(
                "SELECT value FROM metadata WHERE key='insights_upgrade_synthetic_marker'",
                [],
                |r| r.get(0)
            )
            .unwrap(),
            "蓝湾-731"
        );
        assert_eq!(
            c.query_row::<i64, _, _>(
                "SELECT COUNT(*) FROM pragma_table_info('insight_origins') WHERE pk>0",
                [],
                |r| r.get(0)
            )
            .unwrap(),
            3
        );
        save(
            &out,
            if fail_first {
                "retry-result.json"
            } else {
                "upgrade-result.json"
            },
            &json!({"fromSchema":85,"toSchema":86,"database":path,"oldMarkerPreserved":true,"failedAttemptRolledBack":fail_first}),
        );
    }
}
