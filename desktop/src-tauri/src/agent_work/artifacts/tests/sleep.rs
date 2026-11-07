use super::*;
mod heading_evidence;
mod protocol;
mod scope;
mod v5_contrast;

const ORIGINAL: &str = "# 2025-01-01\n学习 学习\n# 2025-01-02\n学习\n# 2025-02-01\n学习\n";
// A labeled variant on the same three dates, not a replacement for ORIGINAL.
const DIARY: &str = "# 2025-01-01\n学习 学习 💤e\u{301}\n昨夜主睡眠实际睡了7小时。复核更正：实际主睡眠6.5小时。午睡半小时。\n# 2025-01-02\n学习\n昨夜主睡眠实际睡了8小时。六个多小时是旧估计。\n# 2025-02-01\n学习\n昨晚两点睡，七点起；中间醒过，实际睡眠时长不清楚。\n";

fn setup_sleep(body: &str) -> (Fixture, Work, String, Value, Value) {
    let f = Fixture::new();
    f.note("notes", "current", body);
    let locator = json!({"kind":"note","libraryId":"notes","documentId":"current","pageId":null});
    let view=ui(&f.root,&json!({"action":"create","goal":"按记录日归属主睡眠，排除午睡和模糊值，按月平均；图表保留供纠正","successCriteria":"仅分析所选日记，不修改来源；说明覆盖和排除","anchor":locator,"grant":{"libraryIds":[],"notes":[locator],"readingItemKeys":[]}})).unwrap();
    let (work, run) = super::super::super::tests::claim(&f, view["work"]["id"].as_str().unwrap());
    let reader = work.grant.reader(&f.root).unwrap();
    let snapshot = analysis::execute(&reader, "hub_create_analysis_snapshot", &json!({})).unwrap();
    let source = analysis::execute(
        &reader,
        "hub_read_analysis_snapshot",
        &json!({"expectedSnapshot":snapshot["snapshot"],"itemIndex":0,"start":0,"limit":8000}),
    )
    .unwrap();
    let request = json!({"action":"create","operationId":"sleep-initial","expectedSnapshot":snapshot["snapshot"],"methodRef":"main-sleep-labeled-v1","inclusionRule":"仅明确实际主睡眠，排除午睡、在床时长及歧义","dateRule":"按记录日期、Asia/Shanghai归日，不按入睡时刻跨日推算","rows":[]});
    (f, work, run, request, source)
}

fn row(source: &Value, id: &str, date: &str, quote: &str, hours: Option<f64>) -> Value {
    let body = source["content"].as_str().unwrap();
    let byte = body.find(quote).unwrap();
    let start = body[..byte].chars().count();
    json!({"rowId":id,"eventRef":format!("main-sleep:{date}"),"rawValue":quote,"normalizedValue":hours,"unit":"hours",
        "valueKind":if hours.is_some(){"exact"}else{"ambiguous"},"eventDate":date,"timezone":"Asia/Shanghai","dateBasis":"recordedDay",
        "evidenceRefs":[{"itemIndex":0,"sourceRevision":source["sourceRevision"],"contentHash":source["sourceRevision"]["bodySha256"],"start":start,"end":start+quote.chars().count(),"text":quote}],
        "reviewState":if hours.is_some(){"accepted_for_analysis"}else{"rejected"},
        "reviewBasis":{"kind":"modelReview","sourceRef":null,"reason":"标注候选：语义判断不等于宿主事实认证"},"ambiguity":if hours.is_some(){""}else{"起止时间不能证明实际睡眠时长"},"exclusionReason":if hours.is_some(){""}else{"不纳入精确均值"},"correctionSource":null,"supersedes":null})
}

fn labeled(source: &Value) -> Value {
    json!([
        row(
            source,
            "jan1",
            "2025-01-01",
            "昨夜主睡眠实际睡了7小时。",
            Some(7.0)
        ),
        row(
            source,
            "jan2",
            "2025-01-02",
            "昨夜主睡眠实际睡了8小时。",
            Some(8.0)
        ),
        row(
            source,
            "feb1",
            "2025-02-01",
            "昨晚两点睡，七点起；中间醒过，实际睡眠时长不清楚。",
            None
        )
    ])
}

fn dataset(f: &Fixture, work: &Work, run: &str, request: &Value) -> Result<Value, String> {
    let control = Control::default();
    let session = assistant::Session {
        root: &f.root,
        work,
        run,
        control: &control,
        operation: None,
        selection: json!({}),
        app: None,
    };
    let encoded = json!({"operation":"sleepDataset","request":request});
    let schema = assistant::schema(runner::schema());
    let selected = schema["properties"]["requests"]["items"]["anyOf"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["properties"]["operation"]["enum"][0] == "sleepDataset")
        .unwrap();
    crate::model_runtime::validate_agent_tool(&encoded, selected)?;
    session.dispatch(serde_json::from_value(encoded).unwrap())
}

fn chart_request(value: &Value) -> Value {
    json!({"action":"create","operationId":"sleep-chart","analysis":{"source":"sleepDataset","expectedSnapshot":value["content"]["snapshot"],"datasetId":value["datasetId"],"datasetRevision":value["revision"],"aggregation":"monthlyMean"},"spec":{"title":"主睡眠月均时长","mark":"bar","metric":"sleep_duration_hours","term":null,"sort":"groupAsc"}})
}

fn accepted_report(f: &Fixture, work: &Work, run: &str, summary: &str) -> runner::Report {
    let context = store::goal::completion::read_context(&f.root, work, run).unwrap();
    let proof = context["proofs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["kind"] == "chart")
        .unwrap();
    let items=context["requirements"].as_array().unwrap().iter().map(|r|json!({"requirementId":r["requirementId"],"criterion":r["text"],"requiredResult":"chart","status":"satisfied","explanation":"合成标注核对：均值、覆盖和排除与固定输入一致","refs":[proof["proofId"]],"supersededBy":null})).collect::<Vec<_>>();
    let report=serde_json::from_value(json!({"status":"completed","summary":summary,"findings":[],"nextSteps":[],"questions":[],"limitations":["仅合成标注，历史完整性未知"],"waitCondition":"","completion":{"goalBinding":context["goalBinding"],"items":items}})).unwrap();
    assert_eq!(
        store::goal::accept_report(&f.root, work, run, &report, &context["goalBinding"]).unwrap()
            ["workFulfillment"],
        "fulfilled"
    );
    report
}

fn publish(f: &Fixture, work: &Work, run: &str, report: &runner::Report) -> Result<(), String> {
    store::publish(
        &f.root,
        work,
        run,
        report,
        &[],
        &[],
        &actions::receipts(&f.root, &work.id).unwrap(),
        &json!({}),
        &Control::default(),
    )
}

#[test]
fn sleep_dataset_missing_values_and_invalid_candidates_never_become_zero_or_proof() {
    let (f, work, run, request, _) = setup_sleep(ORIGINAL);
    let saved = dataset(&f, &work, &run, &request).unwrap();
    assert_eq!(
        saved["content"]["coverage"]["dates"]["recognizedSections"],
        3
    );
    assert_eq!(saved["content"]["coverage"]["metric"]["accepted"], 0);
    assert_eq!(
        saved["content"]["coverage"]["metric"]["datesWithoutAcceptedValue"],
        3
    );
    assert_eq!(saved["content"]["coverage"]["history"]["status"], "unknown");
    assert!(execute(
        &f.root,
        &work,
        &run,
        &chart_request(&saved),
        &Control::default()
    )
    .unwrap_err()
    .contains("不将缺失或歧义补零"));
    assert!(records(&f.c(), &work.id, "chartRevision")
        .unwrap()
        .is_empty());

    let (f, work, run, mut request, source) = setup_sleep(DIARY);
    request["rows"] = labeled(&source);
    for invalid in [
        "coordinate",
        "source",
        "date",
        "ambiguousNumber",
        "fakeUser",
        "duplicateEvent",
        "duplicateOccurrence",
        "unknownEvent",
        "mixedTimezone",
    ] {
        let mut bad = request.clone();
        match invalid {
            "coordinate" => bad["rows"][0]["evidenceRefs"][0]["start"] = json!(1),
            "source" => bad["rows"][0]["evidenceRefs"][0]["contentHash"] = json!("fake"),
            "date" => bad["rows"][0]["eventDate"] = json!("2025-01-02"),
            "ambiguousNumber" => bad["rows"][2]["normalizedValue"] = json!(5),
            "fakeUser" => {
                bad["rows"][0]["reviewBasis"] =
                    json!({"kind":"userCorrection","sourceRef":"tool-result","reason":"伪造"})
            }
            "duplicateEvent" => bad["rows"][1]["eventRef"] = bad["rows"][0]["eventRef"].clone(),
            "duplicateOccurrence" => {
                bad["rows"][1] = bad["rows"][0].clone();
                bad["rows"][1]["rowId"] = json!("other");
                bad["rows"][1]["eventRef"] = json!("other");
            }
            "unknownEvent" => bad["rows"][0]["eventRef"] = Value::Null,
            _ => bad["rows"][1]["timezone"] = json!("UTC"),
        }
        assert!(dataset(&f, &work, &run, &bad).is_err(), "{invalid}");
    }
    assert!(records(&f.c(), &work.id, "sleepDatasetRevision")
        .unwrap()
        .is_empty());
    let saved = dataset(&f, &work, &run, &request).unwrap();
    assert_eq!(dataset(&f, &work, &run, &request).unwrap(), saved);
    let mut other = request.clone();
    other["methodRef"] = json!("other-method");
    assert!(dataset(&f, &work, &run, &other)
        .unwrap_err()
        .contains("operationId"));
    assert_eq!(saved["content"]["coverage"]["metric"]["accepted"], 2);
    assert_eq!(saved["content"]["coverage"]["metric"]["excluded"], 1);
}

#[test]
fn sleep_dataset_correction_invalidates_before_recompute_and_rebuilds_same_chart_report() {
    let (f, work, run, mut request, source) = setup_sleep(DIARY);
    request["rows"] = labeled(&source);
    let saved = dataset(&f, &work, &run, &request).unwrap();
    let initial = chart_request(&saved);
    let first = call(&f, &work, &run, &initial);
    assert_eq!(
        first["content"]["data"]["rows"],
        json!([{"group":"2025-01","value":7.5,"sampleCount":2}])
    );
    let check = json!({"action":"validate","artifactId":first["artifactId"],"revision":1});
    call(&f, &work, &run, &check);
    let report = accepted_report(&f, &work, &run, "一月主睡眠平均7.5小时，二月无精确值");
    publish(&f, &work, &run, &report).unwrap();
    let old_delivery = store::records(&f.root, &work.id, "delivery", 1).unwrap()[0].clone();
    let before = store::view(&f.root, &work.id).unwrap();
    // No new user command: this isolates data dependency invalidation from goal invalidation.
    let (next, next_run) = super::super::super::tests::claim(&f, &work.id);
    let mut corrected = saved["content"]["rows"].clone();
    // Correct a deliberately missed correction in the captured source.
    corrected[0] = row(
        &source,
        "jan1",
        "2025-01-01",
        "复核更正：实际主睡眠6.5小时。",
        Some(6.5),
    );
    corrected[0]["reviewBasis"] = json!({"kind":"modelReview","sourceRef":null,"reason":"复核原文更正，采用6.5小时替代已过时的7小时"});
    corrected[0]["correctionSource"] = corrected[0]["reviewBasis"].clone();
    corrected[0]["supersedes"] = json!("1:jan1");
    let revision = json!({"action":"revise","operationId":"correct-sleep","datasetId":saved["datasetId"],"expectedRevision":1,"methodRef":request["methodRef"],"inclusionRule":request["inclusionRule"],"dateRule":request["dateRule"],"rows":corrected});
    let changed = dataset(&f, &next, &next_run, &revision).unwrap();
    assert_eq!(changed["revision"], 2);
    let stale = store::view(&f.root, &work.id).unwrap();
    assert_eq!(stale["analysisArtifacts"][0]["state"], "stale");
    assert_eq!(
        stale["conversation"]["messages"][1]["artifactState"],
        "stale"
    );
    assert_eq!(stale["analysisArtifacts"][0]["content"], first["content"]);
    assert!(stale["conversation"]["messages"][1]["validity"]
        .as_str()
        .unwrap()
        .contains("主睡眠数据已纠正"));
    assert!(execute(&f.root, &next, &next_run, &check, &Control::default()).is_err());
    assert!(
        store::goal::completion::read_context(&f.root, &next, &next_run).unwrap()["proofs"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let mut bad = revision.clone();
    bad["operationId"] = json!("old-revision");
    assert!(dataset(&f, &next, &next_run, &bad)
        .unwrap_err()
        .contains("冲突"));
    let mut patch = json!({"action":"patch","operationId":"recompute","artifactId":first["artifactId"],"expectedRevision":1,"analysis":initial["analysis"],"spec":null,"reason":"按纠正后的主睡眠数据重算"});
    assert!(execute(&f.root, &next, &next_run, &patch, &Control::default()).is_err());
    assert_eq!(
        records(&f.c(), &work.id, "chartRevision").unwrap().len(),
        1,
        "failed recompute preserves old artifact"
    );
    patch["analysis"]["datasetRevision"] = json!(2);
    let second = call(&f, &next, &next_run, &patch);
    assert_eq!(second["artifactId"], first["artifactId"]);
    assert_eq!(
        second["content"]["data"]["rows"],
        json!([{"group":"2025-01","value":7.25,"sampleCount":2}])
    );
    assert_eq!(second["state"], "draft");
    call(
        &f,
        &next,
        &next_run,
        &json!({"action":"validate","artifactId":first["artifactId"],"revision":2}),
    );
    let updated = accepted_report(&f, &next, &next_run, "纠正后一月平均7.25小时，二月未知");
    publish(&f, &next, &next_run, &updated).unwrap();
    let repaired = store::view(&f.root, &work.id).unwrap();
    assert_eq!(repaired["goalAssessment"]["workFulfillment"], "fulfilled");
    assert_eq!(repaired["analysisArtifacts"][0]["state"], "checked");
    assert_eq!(
        store::records(&f.root, &work.id, "delivery", 2).unwrap()[1],
        old_delivery
    );
    let raw: String = f
        .c()
        .query_row(
            "SELECT markdown FROM documents WHERE space_id='notes' AND id='current'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(raw, DIARY);
    if let Ok(directory) = std::env::var("HUB_SLEEP_NATIVE_PROFILE") {
        // Opt-in native UI fixture: preserve real store/snapshot outputs before
        // the denial tests mutate them. Never copy a runtime home or secrets.
        let target = Path::new(&directory);
        std::fs::create_dir(target).unwrap();
        f.c()
            .backup("main", target.join("craft-search.sqlite3"), None)
            .unwrap();
        Connection::open(f.root.join("analysis-snapshots.sqlite3"))
            .unwrap()
            .backup("main", target.join("analysis-snapshots.sqlite3"), None)
            .unwrap();
        std::fs::write(
            target.join(".hub-isolated-runtime-v1"),
            b"Hub isolated runtime v1\n",
        )
        .unwrap();
        std::fs::write(
            target.join("fixture-view.json"),
            serde_json::to_vec_pretty(&repaired).unwrap(),
        )
        .unwrap();
        std::fs::write(target.join("source.md"), DIARY).unwrap();
    }
    // Reopen through the UI after publishing ended both runs. Each read loads
    // persisted work/grant state; it must not restart a run or replace old data.
    let reopen =
        json!({"action":"artifact","id":work.id,"artifactId":first["artifactId"],"revision":1});
    let record_count = store::records(&f.root, &work.id, "chartRevision", 32)
        .unwrap()
        .len();
    let historical = ui(&f.root, &reopen).unwrap();
    assert_eq!(historical["content"], first["content"]);
    assert_eq!(historical["state"], "stale");
    assert_eq!(historical["currentRevision"], 2);
    let mut latest_request = reopen.clone();
    latest_request["revision"] = json!(2);
    let current = ui(&f.root, &latest_request).unwrap();
    assert_eq!(current["content"], second["content"]);
    assert_eq!(current["state"], "checked");
    assert_eq!(
        store::records(&f.root, &work.id, "chartRevision", 32)
            .unwrap()
            .len(),
        record_count
    );
    assert!(store::load(&f.c(), &work.id).unwrap().active_run.is_none());
    for invalid in [json!(0), json!(33), json!(1.5), json!("1"), Value::Null] {
        let mut bad = reopen.clone();
        bad["revision"] = invalid;
        assert!(ui(&f.root, &bad).is_err());
    }
    let other = super::super::super::tests::create(&f, true);
    let mut foreign = reopen.clone();
    foreign["id"] = json!(other);
    assert!(ui(&f.root, &foreign).unwrap_err().contains("当前事项"));
    let source_request = json!({"action":"artifactSource","id":work.id,"artifactId":first["artifactId"],"revision":1,"rowId":"jan1","evidenceIndex":0});
    let captured = ui(&f.root, &source_request).unwrap();
    assert_eq!(captured["content"], DIARY);
    assert_eq!(captured["evidence"]["text"], "昨夜主睡眠实际睡了7小时。");
    let start = captured["evidence"]["start"].as_u64().unwrap() as usize;
    let end = captured["evidence"]["end"].as_u64().unwrap() as usize;
    assert_eq!(
        DIARY
            .chars()
            .skip(start)
            .take(end - start)
            .collect::<String>(),
        captured["evidence"]["text"].as_str().unwrap()
    );
    let mut corrected_source = source_request.clone();
    corrected_source["revision"] = json!(2);
    let corrected_capture = ui(&f.root, &corrected_source).unwrap();
    assert_eq!(
        corrected_capture["evidence"]["text"],
        "复核更正：实际主睡眠6.5小时。"
    );
    for (key, invalid) in [
        ("rowId", json!("unknown")),
        ("evidenceIndex", json!(99)),
        ("evidenceIndex", json!(-1)),
        ("evidenceIndex", json!(0.5)),
        ("id", json!(other)),
    ] {
        let mut bad = source_request.clone();
        bad[key] = invalid;
        assert!(ui(&f.root, &bad).is_err());
    }
    f.note("notes", "current", "当前正文已更新，不应替换固定原文");
    assert_eq!(ui(&f.root, &source_request).unwrap(), captured);
    // Expiry is checked on the formal UI entry, not just the rendered label.
    let snapshots = Connection::open(f.root.join("analysis-snapshots.sqlite3")).unwrap();
    let expires: i64 = snapshots
        .query_row("SELECT expires_at FROM snapshots LIMIT 1", [], |r| r.get(0))
        .unwrap();
    snapshots
        .execute("UPDATE snapshots SET expires_at=0", [])
        .unwrap();
    assert!(ui(&f.root, &source_request)
        .unwrap_err()
        .contains("snapshot_expired"));
    snapshots
        .execute("UPDATE snapshots SET expires_at=?1", [expires])
        .unwrap();
    drop(snapshots);
    if let Ok(path) = std::env::var("HUB_ARTIFACT_SOURCE_VIEW") {
        std::fs::write(
            path,
            serde_json::to_vec_pretty(
                &json!({"source":captured,"correctedSource":corrected_capture}),
            )
            .unwrap(),
        )
        .unwrap();
    }
    if let Ok(path) = std::env::var("HUB_ARTIFACT_REOPEN_VIEW") {
        std::fs::write(
            path,
            serde_json::to_vec_pretty(
                &json!({"view":repaired,"historical":historical,"current":current}),
            )
            .unwrap(),
        )
        .unwrap();
    }
    f.c()
        .execute(
            "UPDATE agent_works SET state='revoked' WHERE id=?1",
            [&work.id],
        )
        .unwrap();
    assert!(ui(&f.root, &reopen).unwrap_err().contains("授权"));
    assert!(ui(&f.root, &source_request).unwrap_err().contains("授权"));
    f.c()
        .execute(
            "UPDATE agent_works SET state='completed' WHERE id=?1",
            [&work.id],
        )
        .unwrap();
    f.c()
        .execute(
            "DELETE FROM documents WHERE space_id='notes' AND id='current'",
            [],
        )
        .unwrap();
    assert!(ui(&f.root, &reopen).is_err());
    assert!(ui(&f.root, &source_request).is_err());
    if let Ok(path) = std::env::var("HUB_SLEEP_VIEW") {
        std::fs::write(
            path,
            serde_json::to_vec_pretty(&json!({"before":before,"stale":stale,"repaired":repaired}))
                .unwrap(),
        )
        .unwrap();
    }
}

#[test]
fn sleep_dataset_revisions_require_provenance_preserve_rows_and_recheck_authorization() {
    let (f, work, run, mut request, source) = setup_sleep(DIARY);
    request["rows"] = labeled(&source);
    let saved = dataset(&f, &work, &run, &request).unwrap();
    let mut change = json!({"action":"revise","operationId":"correction","datasetId":saved["datasetId"],"expectedRevision":1,"methodRef":request["methodRef"],"inclusionRule":request["inclusionRule"],"dateRule":request["dateRule"],"rows":request["rows"]});
    change["rows"][0]["normalizedValue"] = json!(6.5);
    assert!(dataset(&f, &work, &run, &change)
        .unwrap_err()
        .contains("correctionSource"));
    change["rows"] = json!([]);
    assert!(dataset(&f, &work, &run, &change)
        .unwrap_err()
        .contains("不可静默删除"));
    let mut too_large = request.clone();
    too_large["rows"] = json!((0..65)
        .map(|_| request["rows"][0].clone())
        .collect::<Vec<_>>());
    assert!(dataset(&f, &work, &run, &too_large).is_err());
    assert_eq!(
        records(&f.c(), &work.id, "sleepDatasetRevision")
            .unwrap()
            .len(),
        1
    );
    store::record(&f.root, &run, "nativeRuntime", &json!({"protocol":1})).unwrap();
    let command = json!({"text":"确认1月1日实际主睡眠为6.5小时","clientMessageId":"sleep-user-fix","runId":run});
    store::conversation::steer(&f.root, &work.id, &command).unwrap();
    store::record(&f.root, &run, "steeringAccepted", &command).unwrap();
    let sources = store::goal::completion::sources_on(&f.c(), &work).unwrap();
    let source_ref = sources.as_array().unwrap().last().unwrap()["requirementId"].clone();
    change["rows"] = request["rows"].clone();
    change["rows"][0]["normalizedValue"] = json!(6.5);
    change["rows"][0]["reviewBasis"] =
        json!({"kind":"userCorrection","sourceRef":source_ref,"reason":"用户明确确认"});
    change["rows"][0]["correctionSource"] = change["rows"][0]["reviewBasis"].clone();
    change["rows"][0]["supersedes"] = json!("1:jan1");
    let corrected = dataset(&f, &work, &run, &change).unwrap();
    assert_eq!(
        corrected["content"]["rows"][0]["correctionSource"]["sourceRef"],
        source_ref
    );
    let history = dataset(
        &f,
        &work,
        &run,
        &json!({"action":"read","datasetId":saved["datasetId"],"revision":1}),
    )
    .unwrap();
    assert_eq!(history["content"], saved["content"]);
    assert_eq!(history["state"], "stale");
    let chart = call(&f, &work, &run, &chart_request(&corrected));
    f.c()
        .execute(
            "DELETE FROM documents WHERE space_id='notes' AND id='current'",
            [],
        )
        .unwrap();
    let read = json!({"action":"read","datasetId":saved["datasetId"],"revision":1});
    assert!(dataset(&f, &work, &run, &read).is_err());
    let view = store::view(&f.root, &work.id).unwrap();
    assert_eq!(view["analysisArtifacts"][0]["state"], "unavailable");
    assert!(!view.to_string().contains("昨夜主睡眠"));
    assert!(call_manifest(&f, &work).as_array().unwrap().is_empty());
    assert_eq!(chart["revision"], 1);
}

fn call_manifest(f: &Fixture, work: &Work) -> Value {
    super::super::sleep::manifest_on(&f.root, &f.c(), work).unwrap()
}

mod batches;
