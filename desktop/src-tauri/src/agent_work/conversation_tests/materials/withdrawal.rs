use super::*;

#[test]
fn whole_library_and_active_scope_cannot_be_partly_withdrawn() {
    let f = Fixture::new();
    f.note("notes", "current", "主材料");
    f.note("notes", "extra", "附加材料");
    let whole = create(&f, true);
    let remove = |id: &str| json!({"action":"message","id":id,"text":"撤回附加材料授权","clientMessageId":"remove-extra","expectedRevision":1,"removeNotes":[locator("extra")]});
    assert!(ui(&f.root, &remove(&whole))
        .unwrap_err()
        .contains("整库授权"));
    assert!(store::records(&f.root, &whole, "userMessage", 10)
        .unwrap()
        .is_empty());
    let created=ui(&f.root,&json!({"action":"create","goal":"核对两份材料","successCriteria":"按授权范围","anchor":locator("current"),"grant":{"libraryIds":[],"notes":[locator("current"),locator("extra")],"readingItemKeys":[]}})).unwrap();
    let id = created["work"]["id"].as_str().unwrap();
    let (_w, _r) = claim(&f, id);
    assert!(ui(&f.root, &remove(id))
        .unwrap_err()
        .contains("停止当前一轮"));
    assert_eq!(store::load(&f.c(), id).unwrap().grant.notes.len(), 2);
}

#[test]
fn exact_extra_note_withdrawal_preserves_unaffected_history_and_real_sources() {
    let files = crate::obsidian_edit::tests::Fixture::new();
    let a = files.seed("A.md", "# 2025-01-01\n学习 学习\n");
    let b = files.seed("B.md", "# 2025-02-01\n学习\n");
    let f = std::mem::ManuallyDrop::new(Fixture {
        root: files.root.clone(),
    });
    let before = std::fs::read(files.vault.join("B.md")).unwrap();
    let modified = std::fs::metadata(files.vault.join("B.md"))
        .unwrap()
        .modified()
        .unwrap();
    let created=ui(&f.root,&json!({"action":"create","goal":"统计授权材料的学习次数并保留同一图表及历史，不修改来源","successCriteria":"保持明确授权和版本","anchor":locator(&a),"grant":{"libraryIds":[],"notes":[locator(&a)],"readingItemKeys":[]}})).unwrap();
    let id = created["work"]["id"].as_str().unwrap();
    let (w, r) = claim(&f, id);
    let snap = analysis::execute(
        &w.grant.reader(&f.root).unwrap(),
        "hub_create_analysis_snapshot",
        &json!({}),
    )
    .unwrap();
    let first = chart(
        &f,
        &w,
        &r,
        &json!({"action":"create","operationId":"withdraw-baseline","analysis":{"expectedSnapshot":snap["snapshot"],"unit":"day","groupBy":"month","terms":["学习"]},"spec":{"title":"学习次数","mark":"bar","metric":"occurrences","term":"学习","sort":"groupAsc"}}),
    );
    chart(
        &f,
        &w,
        &r,
        &json!({"action":"validate","artifactId":first["artifactId"],"revision":1}),
    );
    store::record(
        &f.root,
        &r,
        "agentStream",
        &json!({"kind":"message","state":"completed","text":"UNREVOKED_PUBLIC_A"}),
    )
    .unwrap();
    publish(&f, &w, &r, "仅A两次");
    ui(&f.root, &request(id, 1, "grant-b", json!([locator(&b)]))).unwrap();
    let (both, run) = claim(&f, id);
    store::record(
        &f.root,
        &run,
        "agentStream",
        &json!({"kind":"message","state":"completed","text":"WITHDRAWN_PUBLIC_B_SECRET"}),
    )
    .unwrap();
    let snap = analysis::execute(
        &both.grant.reader(&f.root).unwrap(),
        "hub_create_analysis_snapshot",
        &json!({}),
    )
    .unwrap();
    let mut actual_read = analysis::execute(
        &both.grant.reader(&f.root).unwrap(),
        "hub_read_analysis_snapshot",
        &json!({"expectedSnapshot":snap["snapshot"],"itemIndex":0,"itemCount":8,"limit":8000}),
    )
    .unwrap();
    actual_read["request"] = json!({"operation":"capability","name":"hub_read_analysis_snapshot","arguments":{"expectedSnapshot":snap["snapshot"],"itemIndex":0,"itemCount":8,"limit":8000},"stepId":"actual-fixed-read"});
    store::record(&f.root, &run, "toolResult", &actual_read).unwrap();
    let second = chart(
        &f,
        &both,
        &run,
        &json!({"action":"patch","operationId":"with-b","artifactId":first["artifactId"],"expectedRevision":1,"analysis":{"expectedSnapshot":snap["snapshot"],"unit":"day","groupBy":"month","terms":["学习"]},"spec":null,"reason":"明确追加B"}),
    );
    chart(
        &f,
        &both,
        &run,
        &json!({"action":"validate","artifactId":second["artifactId"],"revision":2}),
    );
    publish(&f, &both, &run, "A与B三次");
    let deliveries = store::records(&f.root, id, "delivery", 10).unwrap();
    let withdraw = json!({"action":"message","id":id,"text":"明确撤回B的读取授权，今后仅用A；保留原始目标和全部历史","clientMessageId":"withdraw-b","expectedRevision":2,"removeNotes":[locator(&b)]});
    f.c().execute_batch("CREATE TRIGGER abort_withdraw BEFORE INSERT ON agent_records WHEN NEW.kind='userMessage' BEGIN SELECT RAISE(ABORT,'withdraw transaction failed'); END;").unwrap();
    assert!(ui(&f.root, &withdraw).is_err());
    assert_eq!(store::load(&f.c(), id).unwrap().grant.notes.len(), 2);
    assert_eq!(
        store::records(&f.root, id, "delivery", 10).unwrap(),
        deliveries
    );
    f.c().execute_batch("DROP TRIGGER abort_withdraw").unwrap();
    let changed = ui(&f.root, &withdraw).unwrap();
    assert_eq!(changed["work"]["revision"], 3);
    assert_eq!(changed["work"]["grant"]["notes"], json!([locator(&a)]));
    assert!(changed["work"]["report"].is_null());
    let current = store::load(&f.c(), id).unwrap();
    assert!(current
        .grant
        .reader(&f.root)
        .unwrap()
        .read(&serde_json::from_value(locator(&b)).unwrap(), 0, 100, None)
        .is_err());
    let old_a = ui(
        &f.root,
        &json!({"action":"artifact","id":id,"artifactId":first["artifactId"],"revision":1}),
    )
    .unwrap();
    assert_eq!(
        old_a["content"]["data"]["rows"],
        json!([{"group":"2025-01","value":2}])
    );
    assert!(ui(
        &f.root,
        &json!({"action":"artifact","id":id,"artifactId":first["artifactId"],"revision":2})
    )
    .is_err());
    let messages = changed["conversation"]["messages"].as_array().unwrap();
    assert_eq!(messages[1]["report"]["summary"], "仅A两次");
    assert!(messages[3]["report"].is_null());
    if let Ok(path) = std::env::var("HUB_V3_WITHDRAW_VIEW") {
        std::fs::write(path,serde_json::to_vec_pretty(&json!({"view":changed,"sourceBytesUnchanged":std::fs::read(files.vault.join("B.md")).unwrap()==before,"sourceMtimeUnchanged":std::fs::metadata(files.vault.join("B.md")).unwrap().modified().unwrap()==modified,"models":0})).unwrap()).unwrap();
    }
    assert!(
        !changed["activity"]
            .to_string()
            .contains("WITHDRAWN_PUBLIC_B_SECRET"),
        "public progress from revoked scope must not bypass delivery/source checks"
    );
    assert!(
        changed["activity"]
            .to_string()
            .contains("UNREVOKED_PUBLIC_A"),
        "unaffected single-note progress should remain visible"
    );
    assert_eq!(
        store::records(&f.root, id, "delivery", 10).unwrap(),
        deliveries,
        "source withdrawal must never erase published records"
    );
    assert_eq!(ui(&f.root, &withdraw).unwrap()["work"]["revision"], 3);
    for bad in [
        json!([locator(&a)]),
        json!([locator(&b)]),
        json!([locator("missing")]),
    ] {
        let mut req = withdraw.clone();
        req["clientMessageId"] = json!("bad");
        req["expectedRevision"] = json!(3);
        req["removeNotes"] = bad;
        assert!(ui(&f.root, &req).is_err());
    }
    assert_eq!(std::fs::read(files.vault.join("B.md")).unwrap(), before);
    assert_eq!(
        std::fs::metadata(files.vault.join("B.md"))
            .unwrap()
            .modified()
            .unwrap(),
        modified
    );
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM agent_actions", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
