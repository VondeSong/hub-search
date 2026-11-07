use super::*;

fn check(f: &Fixture, work: &Work, run: &str, value: &Value) {
    call(
        f,
        work,
        run,
        &json!({"action":"validate","artifactId":value["artifactId"],"revision":value["revision"]}),
    );
}

fn publish(f: &Fixture, work: &Work, run: &str, summary: &str) -> Result<(), String> {
    let report:runner::Report=serde_json::from_value(json!({"status":"completed","summary":summary,"findings":[],"nextSteps":[],"questions":[],"limitations":["仅本地固定输入"],"waitCondition":""})).unwrap();
    store::publish(
        &f.root,
        work,
        run,
        &report,
        &[],
        &[],
        &actions::receipts(&f.root, &work.id).unwrap(),
        &json!({}),
        &Control::default(),
    )
}

fn patch(first: &Value) -> Value {
    json!({"action":"patch","operationId":"change-counting","artifactId":first["artifactId"],"expectedRevision":1,
        "spec":{"title":"学习天数","mark":"line","metric":"matchingUnits","term":"学习","sort":"groupAsc"},
        "analysis":null,"reason":"改用提及天数"})
}

#[test]
fn report_binds_exact_revision_and_reopens_history_without_pairing_old_prose_with_new_data() {
    let (f, work, run, request) = setup();
    let first = call(&f, &work, &run, &request);
    check(&f, &work, &run, &first);
    publish(&f, &work, &run, "旧口径：共 3 次提及").unwrap();
    let saved = store::records(&f.root, &work.id, "delivery", 1).unwrap()[0].clone();
    assert_eq!(saved["artifactRefs"][0]["revision"], 1);
    assert_eq!(
        saved["artifactRefs"][0]["contentHash"],
        first["content"]["contentHash"]
    );
    let before = store::view(&f.root, &work.id).unwrap();
    assert_eq!(
        before["conversation"]["messages"][1]["artifactState"],
        "current"
    );
    store::conversation::message(
        &f.root,
        &work.id,
        &json!({"text":"改为按提及天数统计","clientMessageId":"chart-follow-up"}),
    )
    .unwrap();
    let (next, next_run) = super::super::super::tests::claim(&f, &work.id);
    let second = call(&f, &next, &next_run, &patch(&first));
    assert_ne!(
        second["content"]["data"]["rows"],
        first["content"]["data"]["rows"]
    );
    let changed = store::view(&f.root, &work.id).unwrap();
    let old = &changed["conversation"]["messages"][1];
    assert_eq!(old["artifactState"], "stale");
    assert_eq!(old["artifactRefs"][0]["revision"], 1);
    assert_eq!(old["artifactRefs"][0]["currentRevision"], 2);
    assert!(old["validity"]
        .as_str()
        .unwrap()
        .contains("旧回答仅供历史查阅"));
    assert_eq!(old["report"]["summary"], "旧口径：共 3 次提及");
    assert_eq!(changed["history"][0]["artifactState"], "stale");
    let context = store::conversation::context(&f.root, &next).unwrap();
    assert!(!context.to_string().contains("共 3 次提及"));
    assert!(publish(&f, &next, &next_run, "未检查的新结果").is_err());
    check(&f, &next, &next_run, &second);
    publish(&f, &next, &next_run, "新口径：共 2 天提及").unwrap();
    let repaired = store::view(&f.root, &work.id).unwrap();
    assert_eq!(repaired["work"]["report"]["summary"], "新口径：共 2 天提及");
    assert_eq!(
        repaired["conversation"]["messages"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["artifactState"],
        "current"
    );
    let deliveries = store::records(&f.root, &work.id, "delivery", 2).unwrap();
    assert_eq!(
        deliveries[1], saved,
        "Published history must remain immutable"
    );
    assert_eq!(deliveries[0]["artifactRefs"][0]["revision"], 2);
    f.c()
        .execute(
            "DELETE FROM documents WHERE space_id='notes' AND id='current'",
            [],
        )
        .unwrap();
    let removed = store::view(&f.root, &work.id).unwrap();
    assert!(removed["work"]["report"].is_null());
    assert!(!removed.to_string().contains("共 3 次提及"));
    assert!(!removed.to_string().contains("共 2 天提及"));
    if let Ok(path) = std::env::var("HUB_CHART_DEPENDENCY_VIEW") {
        std::fs::write(
            path,
            serde_json::to_vec_pretty(
                &json!({"before":before,"changed":changed,"repaired":repaired,"removed":removed}),
            )
            .unwrap(),
        )
        .unwrap();
    }
}

#[test]
fn historical_read_is_not_silently_rebound_to_latest_at_publication() {
    let (f, work, run, request) = setup();
    let first = call(&f, &work, &run, &request);
    check(&f, &work, &run, &first);
    let second = call(&f, &work, &run, &patch(&first));
    check(&f, &work, &run, &second);
    call(
        &f,
        &work,
        &run,
        &json!({"action":"read","artifactId":first["artifactId"],"revision":1}),
    );
    assert_eq!(
        run_references(&f.c(), &work, &run).unwrap()[0]["revision"],
        1
    );
    assert!(publish(&f, &work, &run, "使用旧版的回答").is_err());
    assert!(store::records(&f.root, &work.id, "delivery", 1)
        .unwrap()
        .is_empty());
    call(
        &f,
        &work,
        &run,
        &json!({"action":"read","artifactId":first["artifactId"],"revision":2}),
    );
    publish(&f, &work, &run, "核对最新版的回答").unwrap();
    assert_eq!(
        store::records(&f.root, &work.id, "delivery", 1).unwrap()[0]["artifactRefs"][0]["revision"],
        2
    );
}

#[test]
fn legacy_delivery_recovers_only_from_its_own_chart_receipts_and_bad_refs_fail_closed() {
    let (f, work, run, request) = setup();
    let first = call(&f, &work, &run, &request);
    check(&f, &work, &run, &first);
    publish(&f, &work, &run, "应保留的历史回答").unwrap();
    f.c().execute("UPDATE agent_records SET body_json=json_remove(body_json,'$.artifactRefs') WHERE work_id=?1 AND kind='delivery'",[&work.id]).unwrap();
    let legacy = store::view(&f.root, &work.id).unwrap();
    assert_eq!(
        legacy["conversation"]["messages"][1]["artifactRefs"][0]["revision"],
        1
    );
    assert_eq!(legacy["work"]["report"]["summary"], "应保留的历史回答");
    f.c().execute("UPDATE agent_records SET body_json=json_set(body_json,'$.artifactRefs',json('[{}]')) WHERE work_id=?1 AND kind='delivery'",[&work.id]).unwrap();
    let invalid = store::view(&f.root, &work.id).unwrap();
    assert!(invalid["work"]["report"].is_null());
    assert!(invalid["conversation"]["messages"][1]["report"].is_null());
    assert_eq!(
        invalid["conversation"]["messages"][1]["artifactState"],
        "unavailable"
    );
}

#[test]
fn resumed_chart_context_preserves_dependencies_and_rejects_stale_or_tampered_refs() {
    let (f, work, run, request) = setup();
    let first = call(&f, &work, &run, &request);
    check(&f, &work, &run, &first);
    let refs = run_references(&f.c(), &work, &run).unwrap();
    publish(&f, &work, &run, "首次回答").unwrap();
    let (next, next_run) = super::super::super::tests::claim(&f, &work.id);
    let mut bad = refs.clone();
    bad[0]["contentHash"] = json!("0".repeat(64));
    assert!(inherit_references(&f.root, &next, &next_run, &bad, &Control::default()).is_err());
    assert!(run_references(&f.c(), &next, &next_run)
        .unwrap()
        .as_array()
        .unwrap()
        .is_empty());
    inherit_references(&f.root, &next, &next_run, &refs, &Control::default()).unwrap();
    assert_eq!(
        run_references(&f.c(), &next, &next_run).unwrap()[0]["inherited"],
        true
    );
    publish(&f, &next, &next_run, "续接解释").unwrap();
    assert_eq!(
        store::records(&f.root, &work.id, "delivery", 1).unwrap()[0]["artifactRefs"][0]["revision"],
        1
    );
    let (third, third_run) = super::super::super::tests::claim(&f, &work.id);
    call(&f, &third, &third_run, &patch(&first));
    assert!(inherit_references(&f.root, &third, &third_run, &refs, &Control::default()).is_err());
    assert_eq!(
        run_references(&f.c(), &third, &third_run).unwrap()[0]["revision"],
        2
    );
}
