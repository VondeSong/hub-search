use super::*;

const DIARY: &str = "# 2025-01-01\n学习 学习\n# 2025-01-02\n学习\n# 2025-02-01\n学习\n";

pub(super) fn turn(f: &Fixture, id: &str, stage: &str, diary: &str) -> Value {
    // Same owner as UI respond, with a smaller opt-in test budget. No fake model,
    // injected tool sequence, or precomputed chart is supplied to the runtime.
    let mut limits = budget("quick").unwrap();
    limits.seconds = 180;
    limits.model_call_seconds = 180;
    let started = std::time::Instant::now();
    let result = run_mode(&f.root, id, limits, true);
    let run_elapsed_ms = started.elapsed().as_millis();
    let view_started = std::time::Instant::now();
    let view = store::view(&f.root, id).unwrap();
    let view_elapsed_ms = view_started.elapsed().as_millis();
    if let Ok(directory) = std::env::var("HUB_AGENT_NATIVE_REPORT") {
        std::fs::create_dir_all(&directory).unwrap();
        let evidence = json!({
            "stage":stage,"elapsedMs":run_elapsed_ms,"viewReadMs":view_elapsed_ms,"result":result,"view":view,
            "measurements":store::records(&f.root,id,"nativeMeasurement",4).unwrap(),
            "recordCapacity": f.c().query_row("SELECT COUNT(*),COALESCE(SUM(length(CAST(body_json AS BLOB))),0),COALESCE(MAX(length(CAST(body_json AS BLOB))),0) FROM agent_records WHERE run_id=(SELECT id FROM agent_runs WHERE work_id=?1 ORDER BY rowid DESC LIMIT 1)",[id],|r| Ok(json!({"count":r.get::<_,i64>(0)?,"utf8Bytes":r.get::<_,i64>(1)?,"largestRecordUtf8Bytes":r.get::<_,i64>(2)?}))).unwrap(),
            "tools":store::records(&f.root,id,"toolCall",64).unwrap(),
            "toolResults":store::records(&f.root,id,"toolResult",64).unwrap(),
            "toolRejections":store::records(&f.root,id,"toolRejected",64).unwrap(),
            "finishProtocol": f.c().prepare("SELECT rowid,run_id,kind,body_json FROM agent_records WHERE work_id=?1 AND kind IN ('reportRejected','finishAcceptance','nativeFinal','nativeCompletion') ORDER BY rowid").unwrap().query_map([id],|r| Ok(json!({"sequence":r.get::<_,i64>(0)?,"runId":r.get::<_,String>(1)?,"kind":r.get::<_,String>(2)?,"body":serde_json::from_str::<Value>(&r.get::<_,String>(3)?).unwrap()}))).unwrap().collect::<Result<Vec<_>,_>>().unwrap(),
            "runtime":store::records(&f.root,id,"nativeRuntime",4).unwrap(),
            "deliveries":store::records(&f.root,id,"delivery",4).unwrap(),
            "chartRevisions":store::records(&f.root,id,"chartRevision",16).unwrap(),
            "chartValidations":store::records(&f.root,id,"chartValidation",16).unwrap(),
            "sleepDatasetRevisions":store::records(&f.root,id,"sleepDatasetRevision",32).unwrap(),
            "evidence":store::records(&f.root,id,"evidence",64).unwrap()
        });
        std::fs::write(
            Path::new(&directory).join(format!("native-chart-{stage}.json")),
            serde_json::to_vec_pretty(&evidence).unwrap(),
        )
        .unwrap();
        // run_mode has settled before this read-only capture. Keep the isolated
        // database (and WAL if present) before assertions/Fixture cleanup.
        for suffix in ["", "-wal"] {
            let source = f.root.join(format!("craft-search.sqlite3{suffix}"));
            if source.exists() {
                std::fs::copy(
                    source,
                    Path::new(&directory).join(format!("native-chart-{stage}.sqlite3{suffix}")),
                )
                .unwrap();
            }
        }
    }
    result.unwrap();
    let measurement = &view["activity"].as_array().unwrap().last().unwrap()["measurement"];
    assert_eq!(measurement["schemaVersion"], 1);
    assert_eq!(measurement["runtimeSucceeded"], true);
    assert_eq!(measurement["omittedTools"], 0);
    assert!(measurement["uiDoneMs"].is_null());
    for stage in ["inputSent", "firstEventObserved", "completed"] {
        assert!(
            measurement["provider"][stage]["adapter"]["elapsedMs"].is_number(),
            "missing {stage}"
        );
    }
    assert_eq!(
        measurement["provider"]["inputSent"]["adapter"]["threadId"],
        measurement["provider"]["completed"]["adapter"]["threadId"]
    );

    assert_eq!(view["work"]["state"], "completed");
    assert_eq!(
        view["goalAssessment"]["workFulfillment"], "fulfilled",
        "a settled run is not enough to pass the scenario"
    );
    assert_eq!(
        view["activity"].as_array().unwrap().last().unwrap()["native"],
        true
    );
    assert_eq!(
        std::fs::read_to_string(f.vault.join("Diary.md")).unwrap(),
        diary
    );
    assert!(view["actions"]["items"].as_array().unwrap().is_empty());
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM flashcard_drafts", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    view
}

fn checked_chart(view: &Value, mark: &str, metric: &str, january: i64) -> Value {
    let charts = view["analysisArtifacts"].as_array().unwrap();
    assert_eq!(
        charts.len(),
        1,
        "The follow-up must revise the same artifact"
    );
    let chart = &charts[0];
    assert_eq!(chart["state"], "checked");
    assert_eq!(chart["content"]["spec"]["mark"], mark);
    assert_eq!(chart["content"]["spec"]["metric"], metric);
    let mut rows = chart["content"]["data"]["rows"].as_array().unwrap().clone();
    rows.sort_by_key(|row| row["group"].as_str().unwrap().to_owned());
    assert_eq!(
        rows,
        vec![
            json!({"group":"2025-01","value":january}),
            json!({"group":"2025-02","value":1})
        ]
    );
    let current = view["conversation"]["messages"]
        .as_array()
        .unwrap()
        .last()
        .unwrap();
    assert_eq!(current["artifactState"], "current");
    assert_eq!(
        current["artifactRefs"][0]["artifactId"],
        chart["artifactId"]
    );
    assert_eq!(current["artifactRefs"][0]["revision"], chart["revision"]);
    assert_eq!(
        current["artifactRefs"][0]["contentHash"],
        chart["content"]["contentHash"]
    );
    assert_eq!(
        current["artifactRefs"][0]["datasetRevision"],
        chart["content"]["data"]["datasetRevision"]
    );
    chart.clone()
}

#[test]
#[ignore = "Opt-in: two real Codex turns, isolated synthetic diary, 180 seconds per turn"]
fn installed_native_agent_creates_and_revises_chart_from_intent() {
    let f = Fixture::new();
    // Configure retention before creating any analysis snapshot. This fixture is
    // removed by its existing owner; exported anonymous evidence is retained.
    let policy = json!({"retentionHours":168,"maxStoreMib":128});
    std::fs::write(
        f.root.join("analysis-snapshot-policy.json"),
        policy.to_string(),
    )
    .unwrap();
    if let Ok(directory) = std::env::var("HUB_AGENT_NATIVE_REPORT") {
        use sha2::{Digest, Sha256};
        std::fs::create_dir_all(&directory).unwrap();
        let manifest = json!({"schemaVersion":1,"status":"exploratoryDraft","architecture":"1.14",
            "caseId":"three-day-chart-revision","formalGatePassed":false,"plannedIndependentRuns":1,
            "source":{"kind":"synthetic","notes":1,"dateSections":3,"earliestDate":"2025-01-01","latestDate":"2025-02-01","inclusiveCalendarSpanDays":32,
                "unicodeScalars":DIARY.chars().count(),"utf8Bytes":DIARY.len(),"longestNoteUnicodeScalars":DIARY.chars().count(),"longestNoteUtf8Bytes":DIARY.len(),
                "sha256":format!("{:x}",Sha256::digest(DIARY.as_bytes())),"candidateExtractionRows":null,"validExtractionRows":null},
            "permission":"one selected synthetic note, source read-only; no personal library",
            "retention":policy,"capacity":{"singleRecordUtf8Bytes":65536,"assistantRunRecords":256,"assistantRunUtf8Bytes":1048576,"ordinaryRunRecords":64,"ordinaryRunUtf8Bytes":262144,"chartDataUtf8Bytes":48000},
            "cleanup":"isolated Fixture Drop removes work/source/snapshot/runtime; report directory retained for review",
            "truth":{"created":{"2025-01":3,"2025-02":1},"revised":{"2025-01":2,"2025-02":1},"method":"literal occurrences then distinct date sections containing keyword; same artifact"},
            "environment":{"os":std::env::consts::OS,"arch":std::env::consts::ARCH,"appVersion":env!("CARGO_PKG_VERSION"),"provider":"openai","requestedSettings":crate::model_runtime::Settings::default(),"resolvedModel":null,"providerCacheState":null,
                "processState":"fresh app-server process each turn; same Work and snapshots on revision; not a cold-provider claim"},
            "executionGuardSecondsPerTurn":180,"uiTiming":null,"persistenceBudget":null,"renderBudget":null,
            "scoring":"exact numeric assertions, same artifact revision, source unchanged, no actions/drafts; descriptive median/max only, no P95 or formal 3/3 claim",
            "unknowns":["representative real scale pending user selection","native UI timing","provider network first byte","separate tool queue/execution and commit timing","actual cost","resolved provider model/cache identity"],
            "priorEvidence":"architecture-v1-native-charts-20261023 (preserved, incomparable environment unknowns)"});
        std::fs::write(
            Path::new(&directory).join("manifest.draft.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
    }
    let doc = f.seed("Diary.md", DIARY);
    let anchor = EvidenceLocator::Note {
        library_id: "notes".into(),
        document_id: doc,
        page_id: None,
    };
    let id = store::create(
        &f.root,
        "按这份日记中各个月正文里‘学习’二字的字面出现次数画柱状图，给出简短结论并核对数值。仅分析 2025 年 1 月和 2 月，图表保留供我继续修改。".into(),
        "只分析所选日记，不修改源笔记".into(),
        anchor.clone(),
        Grant { notes:vec![anchor], ..Default::default() },
    ).unwrap();
    options::configure(&f.root,&json!({"id":id,"options":{"model":crate::model_runtime::Settings::default(),"autoFlashcardInbox":false}})).unwrap();
    let before = turn(&f, &id, "created", DIARY);
    let first = checked_chart(&before, "bar", "occurrences", 3);
    let delivery = store::records(&f.root, &id, "delivery", 1).unwrap()[0].clone();
    ui(&f.root,&json!({"action":"message","id":id,"clientMessageId":"native-chart-follow-up","text":"把刚才那张图改为折线图，口径改成每月提到‘学习’的天数，同一天只算一天；沿用同一图表，更新结论并核对。"})).unwrap();
    let after = turn(&f, &id, "revised", DIARY);
    let second = checked_chart(&after, "line", "matchingUnits", 2);
    assert_eq!(first["artifactId"], second["artifactId"]);
    assert!(second["revision"].as_u64().unwrap() > first["revision"].as_u64().unwrap());
    assert_eq!(
        after["conversation"]["messages"][1]["artifactState"],
        "stale"
    );
    assert_eq!(
        after["conversation"]["messages"][1]["artifactRefs"][0]["revision"],
        first["revision"]
    );
    assert_eq!(
        store::records(&f.root, &id, "delivery", 2).unwrap()[1],
        delivery,
        "Historical delivery must remain immutable"
    );
}
