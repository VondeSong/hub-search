use super::*;

fn frozen() -> Value {
    serde_json::from_str(include_str!("fixtures/protocol-feedback-20261024.json")).unwrap()
}
fn output(name: &str, value: &Value) {
    if let Ok(directory) = std::env::var("HUB_SLEEP_PROTOCOL_REPORT") {
        std::fs::write(
            Path::new(&directory).join(name),
            serde_json::to_vec_pretty(value).unwrap(),
        )
        .unwrap();
    }
}
// Only isolated identities are rebound. Keep saved row text, scalar coordinates,
// numeric truth, operation IDs and revision relationships exactly as captured.
fn rebind(
    saved: &Value,
    snapshot: &Value,
    source: &Value,
    id: Option<&Value>,
    user: Option<&Value>,
) -> Value {
    let mut request = saved.clone();
    if request["action"] == "create" {
        request["expectedSnapshot"] = snapshot.clone();
    }
    if let Some(id) = id {
        request["datasetId"] = id.clone();
    }
    for row in request["rows"].as_array_mut().unwrap() {
        for evidence in row["evidenceRefs"].as_array_mut().unwrap() {
            evidence["sourceRevision"] = source["sourceRevision"].clone();
            evidence["contentHash"] = source["sourceRevision"]["bodySha256"].clone();
        }
        if let Some(user) = user {
            for field in ["reviewBasis", "correctionSource"] {
                if row[field]["kind"] == "userCorrection" {
                    row[field]["sourceRef"] = user.clone();
                }
            }
        }
    }
    request
}
fn rejected(f: &Fixture, work: &Work, run: &str, request: &Value, expected: &str) -> String {
    let before = store::records(&f.root, &work.id, "sleepDatasetRevision", 32).unwrap();
    let error = dataset(f, work, run, request).unwrap_err();
    assert!(error.contains(expected), "expected {expected}, got {error}");
    assert_eq!(
        store::records(&f.root, &work.id, "sleepDatasetRevision", 32).unwrap(),
        before
    );
    error
}

#[test]
fn saved_sleep_provenance_rejections_replay_with_precise_feedback_and_strict_delivery() {
    let saved = frozen();
    assert_eq!(saved["source"], DIARY);
    assert_eq!(
        format!("{:x}", Sha256::digest(DIARY.as_bytes())),
        saved["sourceHash"]
    );
    let (f, work, run, base, source) = setup_sleep(DIARY);
    let snapshot = &base["expectedSnapshot"];
    assert_eq!(source["content"], saved["source"]);
    let create = rebind(
        &saved["accepted"][0]["request"]["request"],
        snapshot,
        &source,
        None,
        None,
    );
    assert_eq!(create["rows"], json!([]));
    let empty = dataset(&f, &work, &run, &create).unwrap();
    assert_eq!(empty["revision"], 1);
    let id = &empty["datasetId"];
    let new_rows = rebind(
        &saved["rejected"][1]["request"]["request"],
        snapshot,
        &source,
        Some(id),
        None,
    );
    let added_error = rejected(
        &f,
        &work,
        &run,
        &new_rows,
        saved["rejected"][1]["expectedError"].as_str().unwrap(),
    );
    assert!(added_error.contains("correctionSource 必须非空"));
    assert!(added_error.contains("supersedes 必须为 null"));
    let populated_request = rebind(
        &saved["accepted"][1]["request"]["request"],
        snapshot,
        &source,
        Some(id),
        None,
    );
    // No aliasing a new row to an invented previous row, or inventing a user source.
    let mut false_history = populated_request.clone();
    false_history["rows"][0]["supersedes"] = json!("1:jan01");
    rejected(&f, &work, &run, &false_history, "不能伪造被替代行");
    let mut fake_user = populated_request.clone();
    fake_user["rows"][0]["correctionSource"] = json!({"kind":"userCorrection","sourceRef":"not-a-user-command","reason":"offline invalid source"});
    rejected(&f, &work, &run, &fake_user, "真实原始用户命令");
    let populated = dataset(&f, &work, &run, &populated_request).unwrap();
    assert_eq!(populated["revision"], 2);
    assert_eq!(populated["content"]["coverage"]["metric"]["accepted"], 2);
    let initial = chart_request(&populated);
    let first = call(&f, &work, &run, &initial);
    assert_eq!(
        first["content"]["data"]["rows"],
        json!([{"group":"2025-01","value":7.25,"sampleCount":2}])
    );
    call(
        &f,
        &work,
        &run,
        &json!({"action":"validate","artifactId":first["artifactId"],"revision":first["revision"]}),
    );
    let report = accepted_report(
        &f,
        &work,
        &run,
        "一月主睡眠平均7.25小时，有效样本2，二月歧义排除",
    );
    publish(&f, &work, &run, &report).unwrap();
    let first_delivery = store::records(&f.root, &work.id, "delivery", 1).unwrap()[0].clone();
    ui(&f.root, &json!({"action":"message","id":work.id,"clientMessageId":"offline-protocol-correction","text":saved["correction"]})).unwrap();
    let (next, next_run) = crate::agent_work::tests::claim(&f, &work.id);
    let sources = store::goal::completion::sources_on(&f.c(), &next).unwrap();
    let user = sources
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["text"] == saved["correction"])
        .unwrap()["requirementId"]
        .clone();
    let mut replayed = vec![json!({"case":"reviseNewRows","error":added_error})];
    for index in [2, 3] {
        let request = rebind(
            &saved["rejected"][index]["request"]["request"],
            snapshot,
            &source,
            Some(id),
            Some(&user),
        );
        let error = rejected(
            &f,
            &next,
            &next_run,
            &request,
            saved["rejected"][index]["expectedError"].as_str().unwrap(),
        );
        assert!(error.contains("2:jan02"));
        assert!(
            error.chars().count() < 300,
            "native host feedback must retain the expected relation"
        );
        replayed.push(json!({"case":if index == 2 { "missingSupersedes" } else { "bareRowId" },"error":error}));
    }
    let object = rebind(
        &saved["schemaRejected"]["arguments"]["request"],
        snapshot,
        &source,
        Some(id),
        Some(&user),
    );
    let error = rejected(&f, &next, &next_run, &object, ".supersedes: type");
    replayed.push(json!({"case":"objectSupersedes","error":error}));
    let correction = rebind(
        &saved["accepted"][2]["request"]["request"],
        snapshot,
        &source,
        Some(id),
        Some(&user),
    );
    let mut wrong_revision = correction.clone();
    wrong_revision["rows"][1]["supersedes"] = json!("1:jan02");
    rejected(&f, &next, &next_run, &wrong_revision, "2:jan02");
    let mut fake_source = correction.clone();
    for field in ["reviewBasis", "correctionSource"] {
        fake_source["rows"][1][field]["sourceRef"] = json!("not-a-user-command");
    }
    rejected(&f, &next, &next_run, &fake_source, "真实原始用户命令");
    let mut bad_evidence = correction.clone();
    bad_evidence["rows"][1]["evidenceRefs"][0]["start"] = json!(0);
    rejected(&f, &next, &next_run, &bad_evidence, "出处");
    assert!(
        !store::goal::completion::read_context(&f.root, &next, &next_run).unwrap()["proofs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["kind"] == "chart")
    );
    let corrected = dataset(&f, &next, &next_run, &correction).unwrap();
    assert_eq!(corrected["revision"], 3);
    assert_eq!(
        corrected["content"]["rows"][0],
        populated["content"]["rows"][0]
    );
    assert_eq!(
        corrected["content"]["rows"][2],
        populated["content"]["rows"][2]
    );
    assert_eq!(
        corrected["content"]["rows"][1]["rowId"],
        populated["content"]["rows"][1]["rowId"]
    );
    assert_eq!(
        corrected["content"]["rows"][1]["eventRef"],
        populated["content"]["rows"][1]["eventRef"]
    );
    assert_eq!(corrected["content"]["rows"][1]["normalizedValue"], 7.5);
    assert_eq!(corrected["content"]["rows"][1]["supersedes"], "2:jan02");
    let mut analysis = initial["analysis"].clone();
    analysis["datasetRevision"] = corrected["revision"].clone();
    let rebuilt = call(
        &f,
        &next,
        &next_run,
        &json!({"action":"patch","operationId":"offline-recompute","artifactId":first["artifactId"],"expectedRevision":first["revision"],"spec":null,"analysis":analysis,"reason":"按已核对用户纠正重算"}),
    );
    assert_eq!(rebuilt["artifactId"], first["artifactId"]);
    assert_eq!(
        rebuilt["content"]["data"]["rows"],
        json!([{"group":"2025-01","value":7.0,"sampleCount":2}])
    );
    call(
        &f,
        &next,
        &next_run,
        &json!({"action":"validate","artifactId":rebuilt["artifactId"],"revision":rebuilt["revision"]}),
    );
    let report = accepted_report(
        &f,
        &next,
        &next_run,
        "用户纠正后一月主睡眠平均7小时，有效样本2，二月歧义排除",
    );
    publish(&f, &next, &next_run, &report).unwrap();
    assert_eq!(
        store::records(&f.root, &work.id, "delivery", 2).unwrap()[1],
        first_delivery
    );
    let view = store::view(&f.root, &work.id).unwrap();
    assert_eq!(view["goalAssessment"]["workFulfillment"], "fulfilled");
    assert_eq!(
        view["conversation"]["messages"][1]["artifactState"],
        "stale"
    );
    assert_eq!(
        view["conversation"]["messages"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["artifactState"],
        "current"
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
    output(
        "domain-protocol-replay.json",
        &json!({"replayed":replayed,"acceptedRevisions":[1,2,3],"beforeMean":7.25,"afterMean":7.0,"originalUnchanged":true,"oldDeliveryUnchanged":true,"unchangedRowsPreserved":true,"strictDeliveryPassed":true,"invalidWritesRejectedWithoutNewRevision":true,"sourceSha256":saved["sourceHash"],"identityRebindingOnly":["snapshot","datasetId","sourceRevision","userCommandRef"]}),
    );
}

#[test]
fn full_initial_sleep_create_needs_no_empty_revision_and_cannot_fake_history() {
    let saved = frozen();
    let (f, work, run, mut request, source) = setup_sleep(DIARY);
    // The rejected revise's original rows are a complete initial candidate;
    // keep every saved semantic label and null history field unchanged.
    request["rows"] = rebind(
        &saved["rejected"][1]["request"]["request"],
        &request["expectedSnapshot"],
        &source,
        None,
        None,
    )["rows"]
        .clone();
    let mut fake_history = request.clone();
    fake_history["rows"][0]["correctionSource"] =
        json!({"kind":"modelReview","sourceRef":null,"reason":"not valid on initial create"});
    rejected(&f, &work, &run, &fake_history, "初始抽取不能伪造修订历史");
    let created = dataset(&f, &work, &run, &request).unwrap();
    assert_eq!(created["revision"], 1);
    assert_eq!(created["content"]["coverage"]["metric"]["accepted"], 2);
    assert_eq!(created["content"]["coverage"]["dates"]["uniqueDates"], 3);
    let chart = call(&f, &work, &run, &chart_request(&created));
    assert_eq!(
        chart["content"]["data"]["rows"],
        json!([{"group":"2025-01","value":7.25,"sampleCount":2}])
    );
    output(
        "full-create-check.json",
        &json!({"completeInitialCreateRevision":1,"emptyCreateNotRequired":true,"fakeInitialHistoryRejected":true,"sourceSha256":saved["sourceHash"]}),
    );
}
