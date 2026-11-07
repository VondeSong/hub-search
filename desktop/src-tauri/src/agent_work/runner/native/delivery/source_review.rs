use super::*;

#[test]
#[ignore = "saved real monthly entity refusal and dataset required; no model"]
fn saved_month_without_chart_sources_keep_entity_budget_and_open_all_stored_refs() {
    let r = Replay::saved();
    let control = Control::default();
    let mut context = Context {
        reader: r
            .work
            .grant
            .reader(&r.f.root)
            .unwrap()
            .controlled(control.clone()),
        excerpts: Vec::new(),
        entities: HashSet::new(),
        observations: Vec::new(),
        usage: Usage::default(),
        control: control.clone(),
        budget: assistant::budget("quick").unwrap(),
        candidates: Vec::new(),
        search_read_available: false,
        skills: None,
        skill_request: r.work.goal.clone(),
    };
    let directory = PathBuf::from(std::env::var("HUB_RESPONSE_REPLAY").unwrap());
    let request: Value =
        serde_json::from_slice(&std::fs::read(directory.join("failed-read-request.json")).unwrap())
            .unwrap();
    let failed: Tool = serde_json::from_value(request.clone()).unwrap();
    let target = match &failed {
        Tool::Read { locator, .. } => locator.clone(),
        _ => panic!("saved refusal must be a read"),
    };
    // Reconstruct the full-entity condition using six authorized sources,
    // then replay the exact saved failing request through production dispatch.
    for note in r
        .work
        .grant
        .notes
        .iter()
        .filter(|note| **note != target)
        .take(6)
    {
        context
            .dispatch(Tool::Read {
                locator: note.clone(),
                start_char: 0,
                max_chars: 1,
                expected_version: None,
            })
            .unwrap();
    }
    let entity_error = context.dispatch(failed).unwrap_err();
    assert_eq!(entity_error, "取证实体预算已用尽");
    assert_eq!(context.usage.entities_read, 6);
    assert_eq!(context.budget.entities, 6);
    let mut before_usage = context.usage();
    before_usage.as_object_mut().unwrap().remove("elapsedMs");
    let dataset =
        store::records(&r.f.root, &r.work.id, "sleepDatasetRevision", 32).unwrap()[0].clone();
    assert_eq!(dataset["rows"].as_array().unwrap().len(), 10);
    let args = json!({"action":"sleepDataset","id":r.work.id,"datasetId":dataset["datasetId"],"revision":1});
    let result = crate::agent_work::ui(&r.f.root, &args);
    r.output(
        "no-chart-entry.json",
        json!({"savedFailedRequest":request,"replayedError":entity_error,
        "entities":context.usage.entities_read,"entityBudget":context.budget.entities,
        "uiError":result.as_ref().err(),"modelCalls":0}),
    );
    assert!(
        result.is_ok(),
        "stored dataset without a chart has no formal source review entry: {}",
        result.unwrap_err()
    );
    let inspected = result.unwrap();
    assert_eq!(inspected["content"], dataset);
    let record_count: i64 =
        r.f.c()
            .query_row("SELECT COUNT(*) FROM agent_records", [], |row| row.get(0))
            .unwrap();
    let mut sources = Vec::new();
    for row in dataset["rows"].as_array().unwrap() {
        for (index, evidence) in row["evidenceRefs"].as_array().unwrap().iter().enumerate() {
            let args = json!({"action":"sleepDatasetSource","id":r.work.id,"datasetId":dataset["datasetId"],"revision":1,
                "rowId":row["rowId"],"evidenceIndex":index});
            let source = crate::agent_work::ui(&r.f.root, &args).unwrap();
            let chars: Vec<_> = source["content"].as_str().unwrap().chars().collect();
            let start =
                (evidence["start"].as_u64().unwrap() - source["start"].as_u64().unwrap()) as usize;
            let end =
                (evidence["end"].as_u64().unwrap() - source["start"].as_u64().unwrap()) as usize;
            assert_eq!(
                chars[start..end].iter().collect::<String>(),
                evidence["text"]
            );
            assert_eq!(source["evidence"], *evidence);
            for (key, bad) in [
                ("rowId", json!("unknown")),
                ("evidenceIndex", json!(99)),
                ("revision", json!(0)),
                ("revision", json!(1.5)),
            ] {
                let mut invalid = args.clone();
                invalid[key] = bad;
                assert!(crate::agent_work::ui(&r.f.root, &invalid).is_err());
            }
            sources.push(json!({"rowId":row["rowId"],"day":row["eventDate"],"sourceAligned":true}));
        }
    }
    assert_eq!(sources.len(), 10);
    let mut after_usage = context.usage();
    after_usage.as_object_mut().unwrap().remove("elapsedMs");
    assert_eq!(
        after_usage, before_usage,
        "UI source reads must not start a model or change its budget"
    );
    assert_eq!(
        r.f.c()
            .query_row("SELECT COUNT(*) FROM agent_records", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        record_count
    );
    let view = store::view(&r.f.root, &r.work.id).unwrap();
    assert_eq!(view["sleepDatasets"][0]["content"], dataset);
    assert!(view["analysisArtifacts"].as_array().unwrap().is_empty());
    let other = crate::agent_work::ui(
        &r.f.root,
        &json!({"action":"create","goal":"offline foreign dataset boundary",
        "successCriteria":"keep exact scope","anchor":r.work.anchor,"grant":r.work.grant}),
    )
    .unwrap();
    let mut foreign = args.clone();
    foreign["id"] = other["work"]["id"].clone();
    assert!(crate::agent_work::ui(&r.f.root, &foreign).is_err());
    let snapshots =
        rusqlite::Connection::open(r.f.root.join("analysis-snapshots.sqlite3")).unwrap();
    let expires: i64 = snapshots
        .query_row("SELECT expires_at FROM snapshots LIMIT 1", [], |row| {
            row.get(0)
        })
        .unwrap();
    snapshots
        .execute("UPDATE snapshots SET expires_at=0", [])
        .unwrap();
    assert!(crate::agent_work::ui(&r.f.root, &args)
        .unwrap_err()
        .contains("snapshot_expired"));
    snapshots
        .execute("UPDATE snapshots SET expires_at=?1", [expires])
        .unwrap();
    crate::agent_work::ui(&r.f.root, &json!({"action":"revoke","id":r.work.id})).unwrap();
    assert!(crate::agent_work::ui(&r.f.root, &args).is_err());
    assert_eq!(
        store::records(&r.f.root, &r.work.id, "sleepDatasetRevision", 32).unwrap()[0],
        dataset
    );
    r.output(
        "no-chart-source-validation.json",
        json!({"sources":sources,"allSourceSlicesAligned":true,
        "noChart":true,"entityBudgetStill6":true,"usageUnchanged":true,"recordsUnchanged":true,
        "invalidIdentityAndRangesRejected":true,"foreignWorkRejected":true,"revocationRejected":true,
        "expiredSnapshotRejected":true,"modelCalls":0}),
    );
}
