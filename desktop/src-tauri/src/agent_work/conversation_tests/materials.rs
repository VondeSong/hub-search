use super::*;
use crate::source_evidence::analysis;
#[test]
fn library_scope_changes_are_explicit_versioned_and_idempotent() {
    let f = Fixture::new();
    f.note("notes", "current", "current");
    let id = create(&f, false);
    let req = json!({"action":"message","id":id,"text":"按库查找","clientMessageId":"libraries","expectedRevision":1,"setLibraryIds":["notes","craft"]});
    let mut unversioned = req.clone();
    unversioned
        .as_object_mut()
        .unwrap()
        .remove("expectedRevision");
    assert!(ui(&f.root, &unversioned).is_err());
    let first = ui(&f.root, &req).unwrap();
    assert_eq!(
        first["work"]["grant"]["libraryIds"],
        json!(["craft", "notes"])
    );
    assert_eq!(
        first["work"]["grant"]["attachmentLibraryIds"],
        json!(["craft", "notes"])
    );
    assert_eq!(
        ui(&f.root, &req).unwrap()["work"]["revision"],
        first["work"]["revision"]
    );
    let mut changed = req.clone();
    changed["setLibraryIds"] = json!(["notes"]);
    assert!(ui(&f.root, &changed).is_err());
    changed["clientMessageId"] = json!("invalid");
    changed["expectedRevision"] = json!(2);
    changed["setLibraryIds"] = json!(["missing"]);
    assert!(ui(&f.root, &changed).is_err());
    assert_eq!(store::load(&f.c(), &id).unwrap().revision, 2);
    changed["setLibraryIds"] = json!([]);
    let cleared = ui(&f.root, &changed).unwrap();
    assert_eq!(cleared["work"]["grant"]["libraryIds"], json!([]));
    assert!(store::load(&f.c(), &id)
        .unwrap()
        .grant
        .attachment_library_ids
        .is_empty());
    assert!(store::load(&f.c(), &id)
        .unwrap()
        .grant
        .contains(&serde_json::from_value(locator("current")).unwrap()));
}
mod recovery;
mod withdrawal;

fn locator(id: &str) -> Value {
    json!({"kind":"note","libraryId":"notes","documentId":id,"pageId":null})
}
fn request(id: &str, revision: i64, token: &str, notes: Value) -> Value {
    json!({"action":"message","id":id,"text":"合并新增材料，修订原图表及报告，保留原要求","clientMessageId":token,"expectedRevision":revision,"addNotes":notes})
}
fn chart(f: &Fixture, w: &Work, run: &str, req: &Value) -> Value {
    artifacts::execute(&f.root, w, run, req, &Control::default()).unwrap()
}
fn publish(f: &Fixture, w: &Work, run: &str, summary: &str) {
    let report: runner::Report=serde_json::from_value(json!({"status":"completed","summary":summary,"findings":[],"nextSteps":[],"questions":[],"limitations":["固定合成输入"],"waitCondition":""})).unwrap();
    store::publish(
        &f.root,
        w,
        run,
        &report,
        &[],
        &[],
        &actions::receipts(&f.root, &w.id).unwrap(),
        &json!({}),
        &Control::default(),
    )
    .unwrap();
}

#[test]
fn explicit_addition_revises_same_chart_and_preserves_exact_history_scope() {
    let f = Fixture::new();
    f.note("notes", "current", "# 2025-01-01\n学习 学习\n");
    f.note("notes", "extra", "# 2025-02-01\n学习\n");
    f.note("notes", "secret", "# 2025-03-01\nPRIVATE_SENTINEL 学习\n");
    let id = create(&f, false);
    let (w, r) = claim(&f, &id);
    let snapshot = analysis::execute(
        &w.grant.reader(&f.root).unwrap(),
        "hub_create_analysis_snapshot",
        &json!({}),
    )
    .unwrap();
    let first = chart(
        &f,
        &w,
        &r,
        &json!({"action":"create","operationId":"initial-chart","analysis":{"expectedSnapshot":snapshot["snapshot"],"unit":"day","groupBy":"month","terms":["学习"]},"spec":{"title":"学习提及次数","mark":"bar","metric":"occurrences","term":"学习","sort":"groupAsc"}}),
    );
    chart(
        &f,
        &w,
        &r,
        &json!({"action":"validate","artifactId":first["artifactId"],"revision":1}),
    );
    publish(&f, &w, &r, "原一月两次");
    let old_delivery = store::records(&f.root, &id, "delivery", 1).unwrap()[0].clone();
    let msg = request(&id, 1, "add-extra", json!([locator("extra")]));
    let added = ui(&f.root, &msg).unwrap();
    assert_eq!(added["work"]["id"], id);
    assert_eq!(added["work"]["revision"], 2);
    assert_eq!(added["work"]["authorizationVersion"], 1);
    assert_eq!(added["work"]["grant"]["notes"].as_array().unwrap().len(), 2);
    assert!(added["work"]["report"].is_null());
    assert_eq!(
        added["conversation"]["messages"][1]["report"]["summary"],
        "原一月两次"
    );
    assert_eq!(added["analysisArtifacts"][0]["state"], "stale");
    assert_eq!(ui(&f.root, &msg).unwrap()["work"]["revision"], 2);
    let (next, run) = claim(&f, &id);
    assert_eq!(next.goal, w.goal);
    let reader = next.grant.reader(&f.root).unwrap();
    assert!(reader
        .read(
            &serde_json::from_value(locator("secret")).unwrap(),
            0,
            100,
            None
        )
        .is_err());
    assert!(
        analysis::execute(
            &reader,
            "hub_read_analysis_snapshot",
            &json!({"expectedSnapshot":snapshot["snapshot"],"itemIndex":0})
        )
        .is_err(),
        "new tools must not silently use the original scope"
    );
    let old = chart(
        &f,
        &next,
        &run,
        &json!({"action":"read","artifactId":first["artifactId"],"revision":1}),
    );
    assert_eq!(old["content"], first["content"]);
    let fresh = analysis::execute(&reader, "hub_create_analysis_snapshot", &json!({})).unwrap();
    assert_eq!(fresh["itemsTotal"], 2);
    let second = chart(
        &f,
        &next,
        &run,
        &json!({"action":"patch","operationId":"expanded-chart","artifactId":first["artifactId"],"expectedRevision":1,"spec":null,"analysis":{"expectedSnapshot":fresh["snapshot"],"unit":"day","groupBy":"month","terms":["学习"]},"reason":"用户明确追加二月材料"}),
    );
    assert_eq!(second["artifactId"], first["artifactId"]);
    assert_eq!(second["revision"], 2);
    assert_eq!(
        second["content"]["data"]["rows"],
        json!([{"group":"2025-01","value":2},{"group":"2025-02","value":1}])
    );
    chart(
        &f,
        &next,
        &run,
        &json!({"action":"validate","artifactId":first["artifactId"],"revision":2}),
    );
    publish(&f, &next, &run, "原一月两次，新增二月一次，合计三次");
    let reopened = ui(&f.root, &json!({"action":"status","id":id})).unwrap();
    assert_eq!(
        reopened["conversation"]["messages"][1]["report"]["summary"],
        "原一月两次"
    );
    assert_eq!(
        store::records(&f.root, &id, "delivery", 2).unwrap()[1],
        old_delivery
    );
    assert_eq!(
        ui(
            &f.root,
            &json!({"action":"artifact","id":id,"artifactId":first["artifactId"],"revision":1})
        )
        .unwrap()["content"],
        first["content"]
    );
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM agent_works", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM agent_actions", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    ui(&f.root, &json!({"action":"revoke","id":id})).unwrap();
    assert!(ui(
        &f.root,
        &json!({"action":"artifact","id":id,"artifactId":first["artifactId"],"revision":1})
    )
    .is_err());
}

#[test]
fn stale_busy_invalid_and_failed_scope_additions_are_atomic() {
    let f = Fixture::new();
    f.note("notes", "current", "原材料");
    f.note("notes", "extra", "追加材料");
    let id = create(&f, false);
    for notes in [
        json!([locator("extra"), locator("missing")]),
        json!([locator("extra"), locator("extra")]),
        json!([{"kind":"task","libraryId":"notes","sourceId":"x"}]),
    ] {
        assert!(ui(&f.root, &request(&id, 1, "invalid", notes)).is_err());
        assert_eq!(store::load(&f.c(), &id).unwrap().grant.notes.len(), 1);
    }
    let mut no_revision = request(&id, 1, "unversioned", json!([locator("extra")]));
    no_revision
        .as_object_mut()
        .unwrap()
        .remove("expectedRevision");
    assert!(ui(&f.root, &no_revision).is_err());
    f.c().execute_batch("CREATE TRIGGER fail_scope_message BEFORE INSERT ON agent_records WHEN NEW.kind='userMessage' BEGIN SELECT RAISE(ABORT,'scope commit failure'); END;").unwrap();
    let req = request(&id, 1, "atomic", json!([locator("extra")]));
    assert!(ui(&f.root, &req).is_err());
    assert_eq!(store::load(&f.c(), &id).unwrap().grant.notes.len(), 1);
    f.c()
        .execute_batch("DROP TRIGGER fail_scope_message")
        .unwrap();
    ui(&f.root, &req).unwrap();
    assert!(ui(
        &f.root,
        &request(&id, 1, "stale", json!([locator("current")]))
    )
    .is_err());
    let mut changed = req.clone();
    changed["addNotes"] = json!([]);
    assert!(ui(&f.root, &changed).is_err());
    let (_w, _r) = claim(&f, &id);
    assert!(ui(
        &f.root,
        &request(&id, 2, "busy", json!([locator("missing")]))
    )
    .is_err());
}

#[test]
#[ignore = "one explicit persistent synthetic V3 baseline; no model or business write"]
fn prepare_v3_material_addition_once() {
    let root = PathBuf::from(std::env::var("HUB_V3_SCENARIO_ROOT").unwrap());
    let output = PathBuf::from(std::env::var("HUB_V3_EVIDENCE_ROOT").unwrap());
    let allowed = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../.local")
        .canonicalize()
        .unwrap();
    assert!(!root.exists(), "do not replace a used scenario");
    std::fs::create_dir_all(root.parent().unwrap()).unwrap();
    assert!(root
        .parent()
        .unwrap()
        .canonicalize()
        .unwrap()
        .starts_with(&allowed));
    std::fs::create_dir(&root).unwrap();
    std::fs::write(
        root.join(".hub-isolated-runtime-v1"),
        "Hub isolated runtime v1\n",
    )
    .unwrap();
    let vault = root.join("vault");
    std::fs::create_dir(&vault).unwrap();
    let files = std::mem::ManuallyDrop::new(crate::obsidian_edit::tests::Fixture {
        root: root.clone(),
        vault: vault.clone(),
    });
    files.c().execute("INSERT INTO libraries(id,provider,name,location,enabled,added_at) VALUES('notes','obsidian','V3 追加材料合成库',?1,1,1)",[vault.to_string_lossy().as_ref()]).unwrap();
    let a = files.seed("V3-A-一月.md", "# 2025-01-01\n学习 学习\n");
    let b = files.seed("V3-B-二月.md", "# 2025-02-01\n学习\n");
    let secret = files.seed("V3-C-未授权.md", "# 2025-03-01\nPRIVATE_V3_SENTINEL 学习\n");
    let f = std::mem::ManuallyDrop::new(Fixture { root: root.clone() });
    let view=ui(&root,&json!({"action":"create","goal":"仅按授权材料统计“学习”的文字提及次数，按月升序生成柱图和报告，保留同一事项与图表身份。不要修改来源，不计未授权材料。","successCriteria":"数值和范围准确；保留出处、旧材料、图表与报告历史；修订原图，不另建事项。","anchor":locator(&a),"grant":{"libraryIds":[],"notes":[locator(&a)],"readingItemKeys":[]}})).unwrap();
    let id = view["work"]["id"].as_str().unwrap();
    let (w, r) = claim(&f, id);
    let snap = analysis::execute(
        &w.grant.reader(&root).unwrap(),
        "hub_create_analysis_snapshot",
        &json!({}),
    )
    .unwrap();
    let first = chart(
        &f,
        &w,
        &r,
        &json!({"action":"create","operationId":"v3-fixed-baseline","analysis":{"expectedSnapshot":snap["snapshot"],"unit":"day","groupBy":"month","terms":["学习"]},"spec":{"title":"学习提及次数","mark":"bar","metric":"occurrences","term":"学习","sort":"groupAsc"}}),
    );
    chart(
        &f,
        &w,
        &r,
        &json!({"action":"validate","artifactId":first["artifactId"],"revision":1}),
    );
    publish(&f,&w,&r,"合成初态：目前仅授权一月材料，“学习”共提及 2 次。该初态由正式生产入口确定性建立，不计模型成绩。");
    f.index();
    let saved = ui(&root, &json!({"action":"status","id":id})).unwrap();
    assert_eq!(saved["analysisArtifacts"][0]["state"], "checked");
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM agent_actions", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    f.c()
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .unwrap();
    std::fs::write(output.join("initial-state.json"),serde_json::to_vec_pretty(&json!({"root":root,"vault":vault,"workId":id,"anchor":locator(&a),"addition":locator(&b),"forbidden":locator(&secret),"chart":first,"view":saved,"initialRuns":1,"initialActions":0,"modelCalls":0,"seedIsDeterministicReferenceNotAutonomousSuccess":true})).unwrap()).unwrap();
}

#[test]
fn mixed_source_addition_is_explicit_idempotent_and_preserves_history_scope() {
    let f = Fixture::new();
    f.note("notes", "current", "initial");
    f.note("notes", "extra", "extra");
    f.reading("reading-1", "reading source");
    f.c().execute_batch("INSERT INTO documents(space_id,id,title,path,markdown,indexed_at,content_hash,provider) VALUES('craft','doc','Project','Root','Task',1,'hash','craft'); INSERT INTO craft_task_blocks(space_id,document_id,block_id,title,completed,source_hash) VALUES('craft','doc','block','Task source',0,'hash');").unwrap();

    let id = create(&f, false);
    let req = json!({"action":"message","id":id,"text":"compare materials","clientMessageId":"mixed","expectedRevision":1,"addSources":[locator("extra"),{"kind":"reading","itemKey":"reading-1"},{"kind":"task","libraryId":"craft","sourceId":"block"}]});
    let first = ui(&f.root, &req).unwrap();
    assert_eq!(
        first["work"]["grant"]["readingItemKeys"],
        json!(["reading-1"])
    );
    assert_eq!(first["work"]["grant"]["notes"].as_array().unwrap().len(), 2);
    let retry = ui(&f.root, &req).unwrap();
    assert_eq!(retry["work"]["revision"], first["work"]["revision"]);
    let w = store::load(&f.c(), &id).unwrap();
    let old = store::materials::grant_at(&f.c(), &w, 1).unwrap();
    assert!(old.reading_item_keys.is_empty());
    assert!(old.sources.is_empty());
    assert_eq!(w.grant.sources.len(), 1);
    assert_eq!(old.notes.len(), 1);
    let invalid = json!({"action":"message","id":id,"text":"missing","clientMessageId":"invalid","expectedRevision":2,"addSources":[{"kind":"reading","itemKey":"missing"}]});
    assert!(ui(&f.root, &invalid).is_err());
    assert_eq!(store::load(&f.c(), &id).unwrap().revision, 2);
}
