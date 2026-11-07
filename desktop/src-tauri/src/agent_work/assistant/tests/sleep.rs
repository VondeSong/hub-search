use super::*;
use sha2::{Digest, Sha256};

// Byte-identical to the labeled three-date variant verified by artifacts/tests/sleep.rs.
// The original keyword diary is unchanged; this is not a real-scale corpus.
const DIARY: &str = "# 2025-01-01\n学习 学习 💤e\u{301}\n昨夜主睡眠实际睡了7小时。复核更正：实际主睡眠6.5小时。午睡半小时。\n# 2025-01-02\n学习\n昨夜主睡眠实际睡了8小时。六个多小时是旧估计。\n# 2025-02-01\n学习\n昨晚两点睡，七点起；中间醒过，实际睡眠时长不清楚。\n";
const SOURCE_HASH: &str = "c1764ded59b1e56ebf3147cc811e4c23ce315f5b2550a7ff9adca5607057a848";
const GOAL: &str = "请从所选日记自主整理主睡眠实际时长，按每段标题的记录日归属，时区为北京时间；区分午睡、在床时间、旧估计与明确更正，只将有充分依据的精确小时数纳入每月平均。画一张图，保留在当前事项供我继续纠正，并给出简短结论、有效样本数、原文依据、四层覆盖和排除说明。仅分析2025年1月和2月；未知不补零，也不由睡觉起止时间推算实际睡眠。";
const CORRECTION: &str = "我确认纠正：2025年1月2日的实际主睡眠为7.5小时，原文8小时不准确。请将本条作为用户纠正依据，保留原始记载和更正历史，不修改源日记；沿用刚才的数据集和同一张图，重新计算月均、核对并更新报告。其它日期和规则保持不变。";

#[test]
fn sleep_native_fixture_matches_frozen_three_day_sample() {
    assert_eq!(
        format!("{:x}", Sha256::digest(DIARY.as_bytes())),
        SOURCE_HASH
    );
    assert_eq!(DIARY.chars().count(), 141);
    assert_eq!(DIARY.len(), 317);
    assert_eq!(DIARY.lines().filter(|l| l.starts_with("# ")).count(), 3);
    assert!(DIARY.contains("复核更正：实际主睡眠6.5小时。"));
    assert!(DIARY.contains("实际睡眠时长不清楚。"));
}

fn latest_dataset(f: &Fixture, id: &str) -> Value {
    store::records(&f.root, id, "sleepDatasetRevision", 32).unwrap()[0].clone()
}

#[test]
fn sleep_frozen_classification_replays_saved_failure_without_relaxing_score() {
    // Exact saved dataset from the failed native turn, not reconstructed output.
    let saved: Value =
        serde_json::from_str(include_str!("fixtures/sleep-classification-20261024.json")).unwrap();
    let failure = std::panic::catch_unwind(|| score(&saved, 8.0)).unwrap_err();
    let message = failure
        .downcast_ref::<String>()
        .map(String::as_str)
        .or_else(|| failure.downcast_ref::<&str>().copied())
        .unwrap_or("");
    assert!(message.contains("missing") && message.contains("ambiguous"));

    // Explicit offline adjudication only: temporal clues + interrupted sleep
    // cannot establish actual duration. Keep the source, numeric truth and gates.
    let mut reviewed = saved.clone();
    let row = reviewed["rows"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|r| r["eventDate"] == "2025-02-01")
        .unwrap();
    assert_eq!(row["valueKind"], "missing");
    assert_eq!(
        row["rawValue"],
        "昨晚两点睡，七点起；中间醒过，实际睡眠时长不清楚。"
    );
    row["valueKind"] = json!("ambiguous");
    row["ambiguity"] = json!("有起止时间和中途醒来线索，无法确定实际睡眠时长");
    // Keep the derived coverage consistent with this explicit candidate edit.
    reviewed["coverage"]["metric"]["missing"] = json!(0);
    reviewed["coverage"]["metric"]["ambiguous"] = json!(2);
    let checked = score(&reviewed, 8.0);
    assert_eq!(
        checked["acceptedPrecision"],
        json!({"correct":2,"denominator":2})
    );
    assert_eq!(checked["alignedEvidence"], 6);
    for kind in ["missing", "exact", "conflicting"] {
        let mut wrong = reviewed.clone();
        let row = wrong["rows"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|r| r["eventDate"] == "2025-02-01")
            .unwrap();
        row["valueKind"] = json!(kind);
        assert!(std::panic::catch_unwind(|| score(&wrong, 8.0)).is_err());
    }
    if let Ok(directory) = std::env::var("HUB_AGENT_NATIVE_REPORT") {
        std::fs::write(Path::new(&directory).join("classification-replay.json"),
            serde_json::to_vec_pretty(&json!({"savedCandidateRejected":true,
                "failure":message,"offlineReviewedCandidate":checked,
                "goldLabelUnchanged":"ambiguous","wrongKindsRejected":["missing","exact","conflicting"],
                "realModelCalls":0,"historicalRunStillFailed":true})).unwrap()).unwrap();
    }
}

fn score(dataset: &Value, january_second: f64) -> Value {
    assert_eq!(dataset["metric"], "sleep_duration_hours");
    assert_eq!(dataset["unit"], "hours");
    assert_eq!(dataset["offsetUnit"], "unicodeScalarValue");
    let rows = dataset["rows"].as_array().unwrap();
    let mut accepted: Vec<_> = rows
        .iter()
        .filter(|r| r["reviewState"] == "accepted_for_analysis")
        .collect();
    accepted.sort_by_key(|r| r["eventDate"].as_str().unwrap());
    assert_eq!(accepted.len(), 2, "precision and duplicate gate");
    for (row, date, hours) in [
        (accepted[0], "2025-01-01", 6.5),
        (accepted[1], "2025-01-02", january_second),
    ] {
        assert_eq!(row["eventDate"], date);
        assert_eq!(row["normalizedValue"].as_f64(), Some(hours));
        assert_eq!(row["valueKind"], "exact");
        assert_eq!(row["timezone"], "Asia/Shanghai");
        assert_eq!(row["unit"], "hours");
        assert!(row["eventRef"].as_str().is_some());
    }
    assert_ne!(accepted[0]["eventRef"], accepted[1]["eventRef"]);
    let ambiguous: Vec<_> = rows
        .iter()
        .filter(|r| r["eventDate"] == "2025-02-01")
        .collect();
    assert!(!ambiguous.is_empty(), "ambiguous event must remain visible");
    for row in ambiguous {
        assert_eq!(row["valueKind"], "ambiguous");
        assert!(row["normalizedValue"].is_null());
        assert_ne!(row["reviewState"], "accepted_for_analysis");
        assert!(!row["exclusionReason"].as_str().unwrap().is_empty());
    }
    let mut evidence_count = 0;
    for row in rows {
        let refs = row["evidenceRefs"].as_array().unwrap();
        assert!(!refs.is_empty());
        for evidence in refs {
            let start = evidence["start"].as_u64().unwrap() as usize;
            let end = evidence["end"].as_u64().unwrap() as usize;
            assert!(start < end && end <= DIARY.chars().count());
            assert_eq!(
                evidence["text"],
                DIARY
                    .chars()
                    .skip(start)
                    .take(end - start)
                    .collect::<String>()
            );
            assert_eq!(evidence["contentHash"], SOURCE_HASH);
            assert_eq!(evidence["sourceRevision"]["bodySha256"], SOURCE_HASH);
            evidence_count += 1;
        }
    }
    assert_eq!(dataset["coverage"]["material"]["read"], 1);
    assert_eq!(dataset["coverage"]["dates"]["uniqueDates"], 3);
    assert_eq!(dataset["coverage"]["metric"]["accepted"], 2);
    assert_eq!(
        dataset["coverage"]["metric"]["datesWithoutAcceptedValue"],
        1
    );
    assert_eq!(dataset["coverage"]["history"]["status"], "unknown");
    json!({"acceptedPrecision":{"correct":2,"denominator":2},"acceptedRecall":{"found":2,"denominator":2},"alignedEvidence":evidence_count,"candidateRows":rows.len(),"ambiguousExcluded":true,"duplicateAcceptedEvents":0})
}

fn checked_chart(view: &Value, dataset: &Value, mean: f64) -> Value {
    let charts = view["analysisArtifacts"].as_array().unwrap();
    assert_eq!(charts.len(), 1, "correction must update one artifact");
    let chart = &charts[0];
    assert_eq!(chart["state"], "checked");
    assert_eq!(chart["content"]["spec"]["metric"], "sleep_duration_hours");
    assert_eq!(
        chart["content"]["analysis"]["datasetId"],
        dataset["datasetId"]
    );
    assert_eq!(
        chart["content"]["analysis"]["datasetRevision"],
        dataset["revision"]
    );
    assert_eq!(
        chart["content"]["data"]["rows"],
        json!([{"group":"2025-01","value":mean,"sampleCount":2}])
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
    chart.clone()
}

#[test]
#[ignore = "Opt-in: one real native sleep extraction/correction scenario, two turns at most"]
fn installed_native_agent_extracts_and_corrects_sleep_from_intent() {
    let directory = std::env::var("HUB_AGENT_NATIVE_REPORT")
        .expect("evidence output is required before real execution");
    let directory = Path::new(&directory);
    std::fs::create_dir_all(directory).unwrap();
    let manifest = json!({"case":"three-day-main-sleep-native-v1","architecture":"1.14","independentRuns":1,"maxModelTurns":2,"secondsPerTurn":180,"formalV1Gate":false,
        "source":{"kind":"existing labeled synthetic variant","sha256":SOURCE_HASH,"unicodeScalars":DIARY.chars().count(),"utf8Bytes":DIARY.len(),"notes":1,"dateSections":3,"dates":["2025-01-01","2025-01-02","2025-02-01"]},
        "goal":GOAL,"correction":CORRECTION,"truth":{"created":[6.5,8.0],"corrected":[6.5,7.5],"januaryMeanBefore":7.25,"januaryMeanAfter":7.0,"february":"ambiguous excluded, no zero"},
        "qualityGate":{"acceptedPrecision":1.0,"acceptedRecall":1.0,"sourceAlignment":1.0,"duplicateAcceptedEvents":0},
        "method":"natural-language intent through production run_mode; no seeded dataset, chart, tool sequence or semantic candidates; assertions are not model input",
        "retention":{"retentionHours":168,"maxStoreMib":128},"provider":"configured default native provider","resolvedModel":null,"realScale":"pending user selection","stop":"on scenario failure export feedback and analyze; no automatic experiment rerun"});
    std::fs::write(
        directory.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
    let f = Fixture::new();
    std::fs::write(
        f.root.join("analysis-snapshot-policy.json"),
        json!({"retentionHours":168,"maxStoreMib":128}).to_string(),
    )
    .unwrap();
    let doc = f.seed("Diary.md", DIARY);
    let anchor = EvidenceLocator::Note {
        library_id: "notes".into(),
        document_id: doc,
        page_id: None,
    };
    let id = store::create(
        &f.root,
        GOAL.into(),
        "只分析所选日记，不修改源笔记；主睡眠按记录日归属，精确值才聚合，保留出处、排除与四层覆盖"
            .into(),
        anchor.clone(),
        Grant {
            notes: vec![anchor],
            ..Default::default()
        },
    )
    .unwrap();
    options::configure(&f.root,&json!({"id":id,"options":{"model":crate::model_runtime::Settings::default(),"autoFlashcardInbox":false}})).unwrap();
    let before = charts::turn(&f, &id, "sleep-created", DIARY);
    let first_data = latest_dataset(&f, &id);
    let before_score = score(&first_data, 8.0);
    let first_chart = checked_chart(&before, &first_data, 7.25);
    let delivery = store::records(&f.root, &id, "delivery", 1).unwrap()[0].clone();
    std::fs::write(
        directory.join("score-created.json"),
        serde_json::to_vec_pretty(&before_score).unwrap(),
    )
    .unwrap();
    ui(&f.root,&json!({"action":"message","id":id,"clientMessageId":"native-sleep-correction","text":CORRECTION})).unwrap();
    let stale = store::view(&f.root, &id).unwrap();
    std::fs::write(
        directory.join("stale-view.json"),
        serde_json::to_vec_pretty(&stale).unwrap(),
    )
    .unwrap();
    assert_eq!(stale["analysisArtifacts"][0]["state"], "stale");
    let after = charts::turn(&f, &id, "sleep-corrected", DIARY);
    let second_data = latest_dataset(&f, &id);
    let after_score = score(&second_data, 7.5);
    let second_chart = checked_chart(&after, &second_data, 7.0);
    assert_eq!(first_data["datasetId"], second_data["datasetId"]);
    assert!(second_data["revision"].as_u64().unwrap() > first_data["revision"].as_u64().unwrap());
    assert_eq!(first_chart["artifactId"], second_chart["artifactId"]);
    assert!(second_chart["revision"].as_u64().unwrap() > first_chart["revision"].as_u64().unwrap());
    let corrected = second_data["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["eventDate"] == "2025-01-02" && r["reviewState"] == "accepted_for_analysis")
        .unwrap();
    assert_eq!(corrected["correctionSource"]["kind"], "userCorrection");
    assert_eq!(corrected["reviewBasis"]["kind"], "userCorrection");
    let c = f.c();
    let work = store::load(&c, &id).unwrap();
    let sources = store::goal::completion::sources_on(&c, &work).unwrap();
    let source = sources
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["text"] == CORRECTION)
        .unwrap();
    assert_eq!(
        corrected["correctionSource"]["sourceRef"],
        source["requirementId"]
    );
    assert_eq!(
        corrected["reviewBasis"]["sourceRef"],
        source["requirementId"]
    );
    assert!(corrected["supersedes"]
        .as_str()
        .is_some_and(|v| v.ends_with(&format!(":{}", corrected["rowId"].as_str().unwrap()))));
    let old = first_data["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["eventDate"] == "2025-01-02" && r["reviewState"] == "accepted_for_analysis")
        .unwrap();
    assert_eq!(old["rowId"], corrected["rowId"]);
    assert_eq!(old["eventRef"], corrected["eventRef"]);
    assert_eq!(
        store::records(&f.root, &id, "delivery", 2).unwrap()[1],
        delivery
    );
    assert_eq!(
        after["conversation"]["messages"][1]["artifactState"],
        "stale"
    );
    assert!(store::records(&f.root, &id, "sleepDatasetRevision", 32)
        .unwrap()
        .contains(&first_data));
    std::fs::write(
        directory.join("score-corrected.json"),
        serde_json::to_vec_pretty(&after_score).unwrap(),
    )
    .unwrap();
}
