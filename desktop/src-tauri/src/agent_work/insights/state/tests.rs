use super::super::tests::Case;
use super::*;

fn import(c: &Case, index: usize) -> Value {
    json!({"action":"insightImport","id":c.work,"deliveryRecordId":c.record,"deliveryHash":c.read()["origin"]["deliveryHash"],"findingPointer":format!("/report/findings/{index}"),"operationId":crate::random_url_safe(18),"confirmDependencies":true,"contextEvidenceIds":[]})
}
fn command(c: &Case, args: Value) -> Result<Value, String> {
    ui(&c.f.root, &args)
}
fn save(c: &Case, index: usize) -> Value {
    command(c, import(c, index)).unwrap()["item"].clone()
}
fn detail(c: &Case, item: &Value) -> Value {
    command(c, json!({"action":"insightDetail","insightId":item["id"]})).unwrap()
}
fn status(c: &Case, item: &Value, state: &str) -> Value {
    let mut args = json!({"action":"insightStatus","insightId":item["id"],"expectedRevision":item["rowRevision"],"operationId":crate::random_url_safe(18),"state":state});
    if state == "later" {
        args["snoozeUntil"] = json!(store::stamp() + 86_400_000);
    }
    command(c, args).unwrap()["item"].clone()
}
fn correct(c: &Case, item: &Value, text: &str) -> (Value, String) {
    let op = crate::random_url_safe(18);
    let value=command(c,json!({"action":"insightFeedback","insightId":item["id"],"expectedRevision":item["rowRevision"],"operationId":op,"kind":"correction","text":text})).unwrap();
    (value["item"].clone(), op)
}
fn delivery(c: &Case, change: impl FnOnce(&mut Value)) -> String {
    let raw: String =
        c.f.c()
            .query_row(
                "SELECT body_json FROM agent_records WHERE id=?1",
                [&c.record],
                |r| r.get(0),
            )
            .unwrap();
    let mut body: Value = serde_json::from_str(&raw).unwrap();
    change(&mut body["report"]);
    let report: runner::Report = serde_json::from_value(body["report"].clone()).unwrap();
    let run = format!("next-{}", crate::random_url_safe(10));
    let work = store::claim(&c.f.root, &c.work, &run).unwrap();
    let reader = work.grant.reader(&c.f.root).unwrap();
    let old: Vec<EvidenceExcerpt> = serde_json::from_value(body["evidence"].clone()).unwrap();
    let evidence = old
        .iter()
        .map(|e| reader.read(&e.locator, 0, 6000, None).unwrap())
        .collect::<Vec<_>>();
    runner::validate(&report, &evidence).unwrap();
    store::publish(
        &c.f.root,
        &work,
        &run,
        &report,
        &evidence,
        &[],
        &json!([]),
        &json!({}),
        &Control::default(),
    )
    .unwrap();
    c.f.c()
        .query_row(
            "SELECT id FROM agent_records WHERE run_id=?1 AND kind='delivery'",
            [run],
            |r| r.get(0),
        )
        .unwrap()
}
fn update(c: &Case, item: &Value, record: &str, index: usize) -> Value {
    let source = super::super::ui(
        &c.f.root,
        &json!({"action":"insightCandidates","id":c.work,"deliveryRecordId":record}),
    )
    .unwrap();
    json!({"action":"insightUpdate","insightId":item["id"],"expectedRevision":item["rowRevision"],"deliveryRecordId":record,"deliveryHash":source["origin"]["deliveryHash"],"findingPointer":format!("/report/findings/{index}"),"operationId":crate::random_url_safe(18),"confirmDependencies":true,"contextEvidenceIds":[]})
}

#[test]
fn s01_s02_stable_identity_duplicate_origin_and_operation_replay() {
    let c = Case::new();
    let args = import(&c, 0);
    let a = command(&c, args.clone()).unwrap();
    let b = save(&c, 1);
    assert_ne!(a["item"]["id"], b["id"]);
    let changed = status(&c, &a["item"], "done");
    let replay = command(&c, args.clone()).unwrap();
    assert_eq!(replay["item"]["id"], a["item"]["id"]);
    assert_eq!(replay["item"]["processingState"], "done");
    assert_eq!(replay["item"]["rowRevision"], changed["rowRevision"]);
    let duplicate = command(&c, import(&c, 0)).unwrap();
    assert_eq!(duplicate["existingOrigin"], true);
    assert_eq!(duplicate["item"]["headRevision"], 1);
    let mut bad = args;
    bad["confirmDependencies"] = json!(false);
    assert!(command(&c, bad).is_err());
    assert_eq!(
        c.f.c()
            .query_row::<i64, _, _>("SELECT COUNT(*) FROM insight_revisions", [], |r| r.get(0))
            .unwrap(),
        2
    );
}

#[test]
fn s02e_changed_origin_hash_is_rejected() {
    let c = Case::new();
    save(&c, 0);
    c.alter(|v| v["report"]["findings"][0]["text"] = json!("被篡改的同出处"));
    assert!(command(&c, import(&c, 0)).is_err());
}

#[test]
fn s03_reordering_updates_explicit_identity_and_keeps_status() {
    let c = Case::new();
    let a = status(&c, &save(&c, 0), "done");
    let b = status(&c, &save(&c, 1), "later");
    let record = delivery(&c, |r| r["findings"].as_array_mut().unwrap().reverse());
    let aa = command(&c, update(&c, &a, &record, 1)).unwrap()["item"].clone();
    let bb = command(&c, update(&c, &b, &record, 0)).unwrap()["item"].clone();
    assert_eq!(aa["id"], a["id"]);
    assert_eq!(aa["processingState"], "done");
    assert_eq!(bb["id"], b["id"]);
    assert_eq!(bb["processingState"], "later");
    assert_eq!(bb["snoozeUntil"], b["snoozeUntil"]);
    assert_eq!(aa["headRevision"], 2);
    let old = command(
        &c,
        json!({"action":"insightDetail","insightId":a["id"],"revision":1}),
    )
    .unwrap();
    assert_eq!(old["snapshot"]["text"], a["snapshot"]["text"]);
}

#[test]
fn s05_expiry_and_compensating_undo_do_not_restore_evidence() {
    let c = Case::new();
    let a = save(&c, 0);
    let args = json!({"action":"insightStatus","insightId":a["id"],"expectedRevision":a["rowRevision"],"operationId":"status-later","state":"later","snoozeUntil":store::stamp()+50000});
    let later = command(&c, args.clone()).unwrap()["item"].clone();
    let expired = store::write(&c.f.root, |db| {
        ui_on(
            &c.f.root,
            db,
            &json!({"action":"insightDetail","insightId":a["id"]}),
            args["snoozeUntil"].as_i64().unwrap() + 1,
        )
    })
    .unwrap();
    assert_eq!(expired["processingState"], "attention");
    assert!(expired["snoozeUntil"].is_null());
    let done = status(&c, &expired, "done");
    c.f.note("notes", "current", "方法已变化。");
    let current = detail(&c, &done);
    let undone=command(&c,json!({"action":"insightUndoStatus","insightId":current["id"],"expectedRevision":current["rowRevision"],"operationId":"undo-later","eventId":"status-later"})).unwrap();
    assert_eq!(undone["item"]["validity"], "review");
    assert_ne!(later["rowRevision"], undone["item"]["rowRevision"]);
}

#[test]
fn s06_feedback_advances_revision_and_wrong_target_origin_conflicts() {
    let c = Case::new();
    let a = save(&c, 0);
    let b = save(&c, 1);
    let (changed, _) = correct(&c, &a, "请核对方法适用版本。");
    let record = delivery(&c, |_| {});
    assert!(command(&c, update(&c, &a, &record, 0)).is_err());
    let mut wrong = update(&c, &changed, &c.record, 1);
    wrong["deliveryHash"] = c.read()["origin"]["deliveryHash"].clone();
    assert!(command(&c, wrong).unwrap_err().contains("已绑定其他"));
    assert_eq!(detail(&c, &a)["rowRevision"], changed["rowRevision"]);
    assert_eq!(detail(&c, &b)["headRevision"], 1);
}

#[test]
fn s07_source_change_is_local_and_new_revision_adopts_current_source() {
    let c = Case::new();
    let a = save(&c, 0);
    let b = save(&c, 1);
    c.f.note(
        "notes",
        "current",
        "验证前先固定输入、预期结果、通过条件和适用版本。",
    );
    let changed = detail(&c, &a);
    assert_eq!(changed["validity"], "review");
    assert_eq!(detail(&c, &b)["validity"], "available");
    let record = delivery(&c, |r| {
        r["findings"][0]["text"] = json!("需要固定适用版本。");
        r["findings"][0]["citations"][0]["quote"] =
            json!("验证前先固定输入、预期结果、通过条件和适用版本。");
    });
    let result = command(&c, update(&c, &changed, &record, 0)).unwrap();
    assert_eq!(result["item"]["validity"], "available");
    assert_eq!(result["item"]["headRevision"], 2);
}

#[test]
fn s08_feedback_is_a_separate_user_source_and_only_explicitly_adopted_feedback_closes() {
    let c = Case::new();
    let b = status(&c, &save(&c, 1), "done");
    let (b, u1) = correct(&c, &b, "这里只完成纸面原型，尚未完成实机验证。");
    let checked = detail(&c, &b);
    assert_eq!(checked["validity"], "review");
    let sent=command(&c,json!({"action":"insightContinue","insightId":checked["id"],"expectedRevision":checked["rowRevision"],"operationId":"continue-u1","feedbackIds":[u1]})).unwrap()["item"].clone();
    let record = delivery(&c, |r| {
        r["findings"][1]["text"] = json!("已完成纸面原型验证，实机验证待进行。")
    });
    let (newer, u2) = correct(&c, &sent, "实机验证尚未安排，请保留这个限制。");
    let mut stale = update(&c, &sent, &record, 1);
    stale["feedbackIds"] = json!([u1]);
    stale["confirmFeedbackHandled"] = json!(true);
    assert!(command(&c, stale).is_err());
    let mut request = update(&c, &newer, &record, 1);
    request["feedbackIds"] = json!([u1]);
    request["confirmFeedbackHandled"] = json!(true);
    let updated = command(&c, request.clone()).unwrap()["item"].clone();
    assert_eq!(updated["processingState"], "done");
    assert_eq!(updated["validity"], "review");
    assert_eq!(updated["snapshot"]["userContextRefs"][0]["feedbackId"], u1);
    assert_eq!(
        updated["snapshot"]["sourceCitations"][0]["quote"],
        "本周已完成原型验证"
    );
    assert!(updated["reasons"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["active"] == true && r["reference"]["feedbackId"] == u2));
    let replay = command(&c, request).unwrap();
    assert_eq!(replay["replayed"], true);
    let withdrawn=command(&c,json!({"action":"insightWithdrawFeedback","insightId":updated["id"],"expectedRevision":updated["rowRevision"],"operationId":"withdraw-u1","feedbackId":u1})).unwrap();
    assert!(withdrawn["item"]["reasons"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["kind"] == "userContextChanged" && r["active"] == true));
}

#[test]
fn s09_access_checks_apply_to_list_detail_history_and_replayed_operations() {
    let c = Case::new();
    let request = import(&c, 1);
    let b = command(&c, request.clone()).unwrap()["item"].clone();
    let a = save(&c, 0);
    let mut work = store::load(&c.f.c(), &c.work).unwrap();
    work.grant.notes.pop();
    c.f.c().execute("UPDATE agent_works SET grant_json=?2,authorization_version=authorization_version+1 WHERE id=?1",params![c.work,serde_json::to_string(&work.grant).unwrap()]).unwrap();
    let denied = detail(&c, &b);
    assert_eq!(denied["validity"], "unavailable");
    assert!(denied.get("snapshot").is_none());
    assert!(denied.get("events").is_none());
    assert_eq!(detail(&c, &a)["validity"], "available");
    let replay = command(&c, request).unwrap();
    assert!(replay["item"].get("snapshot").is_none());
    assert!(!command(&c, json!({"action":"insightList"}))
        .unwrap()
        .to_string()
        .contains("本周已完成"));
}

#[test]
fn s11_new_replacement_keeps_old_identity_and_state() {
    let c = Case::new();
    let a = status(&c, &save(&c, 0), "done");
    let record = delivery(&c, |r| {
        r["findings"].as_array_mut().unwrap().truncate(1);
    });
    let mut args = update(&c, &a, &record, 0);
    args["action"] = json!("insightImport");
    args.as_object_mut().unwrap().remove("insightId");
    args["id"] = json!(c.work);
    let fresh = command(&c, args).unwrap()["item"].clone();
    assert_ne!(a["id"], fresh["id"]);
    assert_eq!(fresh["processingState"], "attention");
    let related=command(&c,json!({"action":"insightRelate","insightId":fresh["id"],"expectedRevision":fresh["rowRevision"],"operationId":"relate-old","supersedes":[a["id"]]})).unwrap();
    assert_eq!(related["item"]["supersedes"], json!([a["id"]]));
    assert_eq!(detail(&c, &a)["processingState"], "done");
}

#[test]
fn s12_failed_multi_table_writes_roll_back_and_unknown_result_retries_are_idempotent() {
    for table in [
        "insights",
        "insight_revisions",
        "insight_origins",
        "insight_events",
    ] {
        let c = Case::new();
        let request = import(&c, 0);
        c.f.c().execute_batch(&format!("CREATE TRIGGER fail_insight BEFORE INSERT ON {table} BEGIN SELECT RAISE(ABORT,'injected failure'); END;")).unwrap();
        assert!(command(&c, request.clone()).is_err());
        for t in [
            "insights",
            "insight_revisions",
            "insight_origins",
            "insight_events",
        ] {
            assert_eq!(
                c.f.c()
                    .query_row::<i64, _, _>(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0))
                    .unwrap(),
                0,
                "{table} -> {t}"
            );
        }
        c.f.c().execute_batch("DROP TRIGGER fail_insight").unwrap();
        let first = command(&c, request.clone()).unwrap();
        let retry = command(&c, request).unwrap();
        assert_eq!(first["item"]["id"], retry["item"]["id"]);
    }
}

#[test]
fn s13_trace_cleanup_and_deleted_work_preserve_user_state_without_leaking_content() {
    let c = Case::new();
    let a = save(&c, 0);
    let (a, _) = correct(&c, &a, "请保留我的修订意见。");
    c.f.c()
        .execute("DELETE FROM agent_records WHERE run_id=?1", [&c.run])
        .unwrap();
    assert_eq!(detail(&c, &a)["snapshot"]["text"], a["snapshot"]["text"]);
    let before_index = detail(&c, &a);
    let mut db = c.f.c();
    let records = crate::search_index_runtime::collect_index_records(&db, None).unwrap();
    let index = crate::search_index_runtime::build_and_activate_search_generation(
        &mut db,
        &c.f.root,
        |index| {
            index.rebuild(&records)?;
            Ok(records.len())
        },
    )
    .unwrap();
    drop(index);
    drop(db);
    assert_eq!(detail(&c, &a), before_index);

    c.f.c()
        .execute_batch("PRAGMA foreign_keys=OFF; DELETE FROM agent_works;")
        .unwrap();
    let v = detail(&c, &a);
    assert_eq!(v["validity"], "unavailable");
    assert!(v.get("snapshot").is_none());
    assert_eq!(
        c.f.c()
            .query_row::<i64, _, _>(
                "SELECT COUNT(*) FROM insight_events WHERE kind='insightFeedback'",
                [],
                |r| r.get(0)
            )
            .unwrap(),
        1
    );
}

#[test]
fn s14_restore_recheck_retains_unresolved_correction_and_does_not_add_content_revision() {
    let c = Case::new();
    let b = save(&c, 1);
    let (b, _) = correct(&c, &b, "尚未完成实机验证。");
    quarantine_restored(&c.f.c()).unwrap();
    let pending = detail(&c, &b);
    assert_eq!(pending["validity"], "unavailable");
    assert!(pending.get("snapshot").is_none());
    assert_eq!(pending["restorePending"], true);
    let checked=command(&c,json!({"action":"insightRestoreAccess","insightId":b["id"],"expectedRevision":pending["rowRevision"],"operationId":"reauthorize-restored-work","confirmCurrentAccess":true})).unwrap()["item"].clone();
    assert_eq!(checked["headRevision"], 1);
    assert_eq!(checked["validity"], "review");
    assert!(checked["reasons"]
        .as_array()
        .unwrap()
        .iter()
        .all(|r| r["kind"] != "restore" || r["active"] == false));
    assert!(checked["reasons"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["kind"] == "feedback" && r["active"] == true));
}

#[test]
fn s14_migration_failure_preserves_prior_shape_and_retry_is_atomic() {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch("CREATE TABLE insight_events(operation_id TEXT, request_hash TEXT, insight_id TEXT, kind TEXT, body_json TEXT,result_revision INTEGER,target_revision INTEGER,created_at INTEGER)").unwrap();
    assert!(migrate(&c).is_err());
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
    migrate(&c).unwrap();
    migrate(&c).unwrap();
    assert_eq!(c.query_row::<i64,_,_>("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('insights','insight_revisions','insight_origins','insight_events')",[],|r|r.get(0)).unwrap(),4);
}

#[test]
fn s07c_explicit_common_background_affects_only_declared_dependents() {
    let c = Case::new();
    let mut a_args = import(&c, 0);
    a_args["contextEvidenceIds"] = json!(["e2"]);
    let a = command(&c, a_args).unwrap()["item"].clone();
    let b = save(&c, 1);
    c.f.note("notes", "progress", "项目口径已改变，需要重新核对。");
    assert_eq!(detail(&c, &a)["validity"], "review");
    assert_eq!(detail(&c, &b)["validity"], "review");
}

#[test]
fn s02c_operation_result_probe_replays_fact_after_new_feedback_without_rolling_it_back() {
    let c = Case::new();
    let request = import(&c, 0);
    let a = command(&c, request.clone()).unwrap()["item"].clone();
    let (a, _) = correct(&c, &a, "保留这个后来补充。");
    let checked = command(
        &c,
        json!({"action":"insightOperation","operationId":request["operationId"]}),
    )
    .unwrap();
    assert_eq!(checked["committed"], true);
    assert_eq!(checked["item"]["rowRevision"], a["rowRevision"]);
    let replay = command(&c, request).unwrap();
    assert_eq!(replay["item"]["rowRevision"], a["rowRevision"]);
    assert_eq!(
        command(
            &c,
            json!({"action":"insightOperation","operationId":"not-committed"})
        )
        .unwrap()["committed"],
        false
    );
}

#[test]
fn s09_exact_source_reads_are_rechecked_and_snapshots_do_not_restore_deleted_sources() {
    let c = Case::new();
    let a = save(&c, 0);
    let request =
        json!({"action":"insightSource","insightId":a["id"],"revision":1,"sourceIndex":0});
    assert!(command(&c, request.clone()).unwrap()["quote"].is_string());
    c.f.note("notes", "current", "当前正文不同。");
    assert!(command(&c, request.clone()).is_err());
    c.f.c()
        .execute("DELETE FROM documents WHERE id='current'", [])
        .unwrap();
    assert!(command(&c, request).is_err());
}

#[test]
fn s15_two_hundred_long_chinese_items_are_paged_without_cutting_off_remaining_results() {
    let c = Case::new();
    let a = save(&c, 0);
    let db = c.f.c();
    let raw: String = db
        .query_row(
            "SELECT body_json FROM insights WHERE id=?1",
            [a["id"].as_str()],
            |r| r.get(0),
        )
        .unwrap();
    let snap = snapshot(&db, a["id"].as_str().unwrap(), 1).unwrap();
    for index in 0..200 {
        let id = format!("scale-{index:04}");
        let mut content = snap.clone();
        content["text"] = json!(format!(
            "第{index}条：{}",
            "中文长标题与资料关联需要保留完整上下文。".repeat(12)
        ));
        content["origin"]["deliveryRecordId"] = json!(format!("scale-delivery-{index}"));
        db.execute(
            "INSERT INTO insights VALUES(?1,?2,1,1,?3,?4,?4)",
            params![id, c.work, raw, store::stamp()],
        )
        .unwrap();
        db.execute(
            "INSERT INTO insight_revisions VALUES(?1,1,?2,?3)",
            params![id, content.to_string(), store::stamp()],
        )
        .unwrap();
    }
    let first_started = std::time::Instant::now();
    let first = command(&c, json!({"action":"insightList"})).unwrap();
    let first_ms = first_started.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(first["items"].as_array().unwrap().len(), 200);
    assert_eq!(first["hasMore"], true);
    let second = command(
        &c,
        json!({"action":"insightList","before":first["nextBefore"]}),
    )
    .unwrap();
    assert_eq!(second["items"].as_array().unwrap().len(), 1);
    assert!(!first["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|i| i["id"] == second["items"][0]["id"]));
    let refresh_started = std::time::Instant::now();
    let refreshed = command(&c, json!({"action":"insightList"})).unwrap();
    let refresh_ms = refresh_started.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(refreshed["items"].as_array().unwrap().len(), 200);
    let before_feedback = detail(&c, &a);
    let feedback_started = std::time::Instant::now();
    let feedback = command(&c, json!({"action":"insightFeedback","insightId":a["id"],"expectedRevision":before_feedback["rowRevision"],"operationId":"scale-feedback-timing","kind":"notNeeded","text":"规模夹具：本轮已知晓。"})).unwrap();
    let feedback_ms = feedback_started.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(feedback["item"]["headRevision"], 1);
    let performance_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".local/insights-ui-scale");
    std::fs::create_dir_all(&performance_root).unwrap();
    std::fs::write(performance_root.join("native-operation-timings.json"), serde_json::to_vec_pretty(&json!({"surface":"formal native insight dispatch on synthetic SQLite; excludes frontend rendering","records":201,"returnedFirstPage":200,"firstReadMs":first_ms,"refreshMs":refresh_ms,"feedbackSaveMs":feedback_ms,"modelCalls":0,"observedAt":store::stamp()})).unwrap()).unwrap();
    let preview = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".local/insights-ui-scale/profile");
    std::fs::create_dir_all(&preview).unwrap();
    std::fs::write(
        preview.join(".hub-isolated-runtime-v1"),
        b"Hub isolated runtime v1\n",
    )
    .unwrap();
    let copy = preview.join(format!("scale-{}.sqlite3", crate::random_url_safe(12)));
    c.f.c()
        .execute("VACUUM INTO ?1", [copy.to_string_lossy().as_ref()])
        .unwrap();
    std::fs::write(
        preview.parent().unwrap().join("latest-database.txt"),
        copy.to_string_lossy().as_bytes(),
    )
    .unwrap();
}

#[test]
fn s14_real_full_backup_roundtrip_preserves_identity_state_and_feedback_but_quarantines_access() {
    let c = Case::new();
    let a = status(&c, &save(&c, 0), "done");
    let b = save(&c, 1);
    let (b, u1) = correct(&c, &b, "这里尚未完成实机验证。");
    let proof = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".local/insights-backup-tests")
        .join(crate::random_url_safe(16));
    std::fs::create_dir_all(&proof).unwrap();
    let cancel = std::sync::atomic::AtomicBool::new(false);
    let options = crate::data_backup::BackupOptions {
        destination: proof.join("roundtrip.hubbackup").to_string_lossy().into(),
        include_external_sources: false,
    };
    let backup = crate::data_backup::backup(&c.f.root, &options, &cancel, &mut |_| {}).unwrap();
    assert!(backup.complete);
    let restored = proof.join("restored");
    crate::data_backup::restore(Path::new(&backup.path), &restored, &cancel, &mut |_| {}).unwrap();
    let db = crate::source_evidence::open_read_database(&restored).unwrap();
    let aa = load(&db, a["id"].as_str().unwrap()).unwrap();
    let bb = load(&db, b["id"].as_str().unwrap()).unwrap();
    assert_eq!(aa["processingState"], "done");
    assert_eq!(aa["headRevision"], 1);
    assert_eq!(bb["headRevision"], 1);
    assert_eq!(
        feedback(&db, &bb, &u1).unwrap()["text"],
        "这里尚未完成实机验证。"
    );
    let visible = ui(
        &restored,
        &json!({"action":"insightDetail","insightId":b["id"]}),
    )
    .unwrap();
    assert_eq!(visible["restorePending"], true);
    assert!(visible.get("snapshot").is_none());
    std::fs::write(proof.join("result.json"),json!({"producer":"insights::state::tests","passed":true,"fullBackup":true,"identitiesRetained":true,"feedbackRetained":true,"oldAuthorizationNotReplayed":true,"models":0}).to_string()).unwrap();
}

#[test]
fn s04_same_finding_in_another_work_keeps_its_own_identity_and_state() {
    let c = Case::new();
    let a = status(&c, &save(&c, 0), "done");
    let work=super::super::super::ui(&c.f.root,&json!({"action":"create","goal":"同文独立事项","successCriteria":"独立保存","anchor":super::super::tests::note("current"),"grant":{"notes":[super::super::tests::note("current"),super::super::tests::note("progress")],"libraryIds":[],"readingItemKeys":[]}})).unwrap();
    let raw: String =
        c.f.c()
            .query_row(
                "SELECT body_json FROM agent_records WHERE id=?1",
                [&c.record],
                |r| r.get(0),
            )
            .unwrap();
    let id = work["work"]["id"].as_str().unwrap();
    let run = "independent-same-text";
    let w = store::claim(&c.f.root, id, run).unwrap();
    let body: Value = serde_json::from_str(&raw).unwrap();
    let report: runner::Report = serde_json::from_value(body["report"].clone()).unwrap();
    let evidence: Vec<EvidenceExcerpt> = serde_json::from_value(body["evidence"].clone()).unwrap();
    store::publish(
        &c.f.root,
        &w,
        run,
        &report,
        &evidence,
        &[],
        &json!([]),
        &json!({}),
        &Control::default(),
    )
    .unwrap();
    let record: String =
        c.f.c()
            .query_row(
                "SELECT id FROM agent_records WHERE run_id=?1 AND kind='delivery'",
                [run],
                |r| r.get(0),
            )
            .unwrap();
    let candidate = super::super::ui(
        &c.f.root,
        &json!({"action":"insightCandidates","id":id,"deliveryRecordId":record}),
    )
    .unwrap();
    let b=command(&c,json!({"action":"insightImport","id":id,"deliveryRecordId":record,"deliveryHash":candidate["origin"]["deliveryHash"],"findingPointer":"/report/findings/0","confirmDependencies":true,"contextEvidenceIds":[],"operationId":"independent-same-text-import"})).unwrap()["item"].clone();
    assert_ne!(a["id"], b["id"]);
    assert_eq!(b["processingState"], "attention");
    assert_eq!(detail(&c, &a)["processingState"], "done");
}
#[test]
fn s06b_candidate_is_rechecked_at_publication_after_source_or_grant_changes() {
    for revoke in [false, true] {
        let c = Case::new();
        let args = import(&c, 1);
        if revoke {
            c.f.c()
                .execute("UPDATE libraries SET enabled=0 WHERE id='notes'", [])
                .unwrap();
        } else {
            c.f.note("notes", "progress", "新进展已改变。");
        }
        assert!(command(&c, args).is_err());
        assert_eq!(
            c.f.c()
                .query_row::<i64, _, _>("SELECT COUNT(*) FROM insights", [], |r| r.get(0))
                .unwrap(),
            0
        );
    }
}
#[test]
fn s11_omission_split_and_merge_preserve_old_identity_and_do_not_inherit_status() {
    let c = Case::new();
    let a = status(&c, &save(&c, 0), "done");
    let b = status(&c, &save(&c, 1), "later");
    let omitted = delivery(&c, |r| r["findings"] = json!([r["findings"][0].clone()]));
    assert_eq!(detail(&c, &b)["processingState"], "later");
    assert_ne!(omitted, c.record);
    let record = delivery(&c, |r| {
        let one = r["findings"][0].clone();
        let two = r["findings"][1].clone();
        let merged = json!({"text":"方法与阶段进展需要合并核对。","citations":[one["citations"][0],two["citations"][0]]});
        r["findings"] = json!([one.clone(), one, merged]);
    });
    let source = super::super::ui(
        &c.f.root,
        &json!({"action":"insightCandidates","id":c.work,"deliveryRecordId":record}),
    )
    .unwrap();
    let mut ids = Vec::new();
    for i in 0..3 {
        let item=command(&c,json!({"action":"insightImport","id":c.work,"deliveryRecordId":record,"deliveryHash":source["origin"]["deliveryHash"],"findingPointer":format!("/report/findings/{i}"),"confirmDependencies":true,"contextEvidenceIds":[],"operationId":crate::random_url_safe(18)})).unwrap()["item"].clone();
        assert_eq!(item["processingState"], "attention");
        let related=command(&c,json!({"action":"insightRelate","insightId":item["id"],"expectedRevision":item["rowRevision"],"operationId":crate::random_url_safe(18),"supersedes":if i==2{json!([a["id"],b["id"]])}else{json!([a["id"]])}})).unwrap()["item"].clone();
        if i == 2 {
            assert_eq!(
                related["snapshot"]["sourceCitations"]
                    .as_array()
                    .unwrap()
                    .len(),
                2
            );
            assert_eq!(related["supersedes"].as_array().unwrap().len(), 2);
        }
        ids.push(item["id"].clone());
    }
    assert_ne!(ids[0], ids[1]);
    assert_ne!(ids[0], a["id"]);
    assert_eq!(detail(&c, &a)["processingState"], "done");
    assert_eq!(detail(&c, &b)["processingState"], "later");
}
#[test]
fn s12b_failed_updates_roll_back_revisions_reasons_origins_feedback_and_result() {
    for table in [
        "insights",
        "insight_revisions",
        "insight_origins",
        "insight_events",
    ] {
        let c = Case::new();
        let a = save(&c, 0);
        let (a, _) = correct(&c, &a, "保留我的纠正。");
        let record = delivery(&c, |r| r["findings"][0]["text"] = json!("新的方法表述。"));
        let request = update(&c, &a, &record, 0);
        let before = detail(&c, &a);
        let kind = if table == "insights" {
            "UPDATE"
        } else {
            "INSERT"
        };
        c.f.c().execute_batch(&format!("CREATE TRIGGER fail_update BEFORE {kind} ON {table} BEGIN SELECT RAISE(ABORT,'injected');END;")).unwrap();
        assert!(command(&c, request.clone()).is_err());
        assert_eq!(detail(&c, &a), before);
        assert_eq!(
            command(
                &c,
                json!({"action":"insightOperation","operationId":request["operationId"]})
            )
            .unwrap()["committed"],
            false
        );
        c.f.c().execute_batch("DROP TRIGGER fail_update").unwrap();
        let after = command(&c, request).unwrap()["item"].clone();
        assert_eq!(after["headRevision"], 2);
        assert_eq!(after["validity"], "review");
    }
}
#[test]
fn s14d_e_restored_changed_revoked_and_missing_sources_cannot_reuse_old_access() {
    for variant in ["changed", "revoked", "deleted"] {
        let c = Case::new();
        let a = save(&c, 0);
        let b = save(&c, 1);
        quarantine_restored(&c.f.c()).unwrap();
        if variant == "changed" {
            c.f.note("notes", "current", "资料已经修订。");
        } else if variant == "revoked" {
            c.f.c().execute("UPDATE agent_works SET grant_json=?2 WHERE id=?1",params![c.work,json!({"notes":[super::super::tests::note("progress")],"libraryIds":[],"readingItemKeys":[]}).to_string()]).unwrap();
        } else {
            c.f.c()
                .execute("DELETE FROM documents WHERE id='current'", [])
                .unwrap();
        }
        let pending = detail(&c, &a);
        assert_eq!(pending["validity"], "unavailable");
        assert!(pending.get("snapshot").is_none());
        let args = json!({"action":"insightRestoreAccess","insightId":a["id"],"expectedRevision":pending["rowRevision"],"operationId":crate::random_url_safe(18),"confirmCurrentAccess":true});
        if variant == "changed" {
            let checked = command(&c, args).unwrap()["item"].clone();
            assert_eq!(checked["validity"], "review");
            assert!(checked["reasons"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["kind"] == "sourceChanged" && r["active"] == true));
        } else {
            assert!(command(&c, args).is_err());
        }
        let independent = detail(&c, &b);
        let checked = command(
            &c,
            json!({"action":"insightRestoreAccess","insightId":b["id"],"expectedRevision":independent["rowRevision"],"operationId":crate::random_url_safe(18),"confirmCurrentAccess":true}),
        );
        if independent["restorePending"] == true {
            assert_eq!(checked.unwrap()["item"]["validity"], "available");
        } else {
            assert_eq!(independent["validity"], "available");
        }
    }
}

#[test]
fn s02c_lost_update_reply_replays_original_fact_after_new_feedback_and_old_origin_stays_old() {
    let c = Case::new();
    let a = save(&c, 0);
    let record = delivery(&c, |r| {
        r["findings"][0]["text"] = json!("调整后的验证建议。")
    });
    let request = update(&c, &a, &record, 0);
    let updated = command(&c, request.clone()).unwrap()["item"].clone();
    let (later, u2) = correct(&c, &updated, "后来新增的纠正。");
    let replay = command(&c, request.clone()).unwrap();
    assert_eq!(replay["replayed"], true);
    assert_eq!(replay["resultRevision"], updated["rowRevision"]);
    assert_eq!(replay["item"]["rowRevision"], later["rowRevision"]);
    assert!(replay["item"]["reasons"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["active"] == true && r["reference"]["feedbackId"] == u2));
    let old = command(&c, update(&c, &later, &c.record, 0)).unwrap();
    assert_eq!(old["existingOrigin"], true);
    assert_eq!(old["item"]["headRevision"], 2);
    let mut changed = request;
    changed["expectedRevision"] = later["rowRevision"].clone();
    assert!(command(&c, changed).is_err());
}
#[test]
fn s14_each_restore_requires_new_access_even_if_previous_restore_reason_was_unresolved() {
    let c = Case::new();
    let a = save(&c, 0);
    quarantine_restored(&c.f.c()).unwrap();
    c.f.c()
        .execute(
            "UPDATE agent_works SET authorization_version=authorization_version+1 WHERE id=?1",
            [&c.work],
        )
        .unwrap();
    // A second restoration resets the fence to this restored Work version.
    quarantine_restored(&c.f.c()).unwrap();
    let pending = detail(&c, &a);
    assert_eq!(pending["validity"], "unavailable");
    assert!(pending.get("snapshot").is_none());
    let checked=command(&c,json!({"action":"insightRestoreAccess","insightId":a["id"],"expectedRevision":pending["rowRevision"],"operationId":"second-restore-fresh-authorization","confirmCurrentAccess":true})).unwrap();
    assert_eq!(checked["item"]["validity"], "available");
}

#[test]
fn s08c_source_recheck_and_s09d_access_recovery_preserve_unresolved_user_correction() {
    for changed in [true, false] {
        let c = Case::new();
        let b = status(&c, &save(&c, 1), "done");
        let (b, u1) = correct(&c, &b, "这里仅完成纸面原型。");
        if changed {
            c.f.note(
                "notes",
                "progress",
                "本周已完成原型验证；采用先小样本、再扩大范围的方法。新版补充：完成范围待核对。",
            );
            let observed = detail(&c, &b);
            assert!(observed["reasons"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["kind"] == "sourceChanged" && r["active"] == true));
            let record = delivery(&c, |r| {
                r["findings"][1]["text"] = json!("本周原型验证有进展，完成范围待核对。")
            });
            let request = update(&c, &observed, &record, 1);
            let checked = command(&c, request).unwrap()["item"].clone();
            assert_eq!(checked["validity"], "review");
            assert!(checked["reasons"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["kind"] == "feedback"
                    && r["reference"]["feedbackId"] == u1
                    && r["active"] == true));
        } else {
            let old: String =
                c.f.c()
                    .query_row(
                        "SELECT grant_json FROM agent_works WHERE id=?1",
                        [&c.work],
                        |r| r.get(0),
                    )
                    .unwrap();
            let mut grant: Value = serde_json::from_str(&old).unwrap();
            grant["notes"] = json!([super::super::tests::note("current")]);
            c.f.c().execute("UPDATE agent_works SET grant_json=?2,authorization_version=authorization_version+1 WHERE id=?1",params![c.work,grant.to_string()]).unwrap();
            let unavailable = detail(&c, &b);
            assert_eq!(unavailable["validity"], "unavailable");
            assert!(unavailable.get("snapshot").is_none());
            c.f.c().execute("UPDATE agent_works SET grant_json=?2,authorization_version=authorization_version+1 WHERE id=?1",params![c.work,old]).unwrap();
            let checked = detail(&c, &b);
            assert_eq!(checked["validity"], "review");
            assert_eq!(checked["processingState"], "done");
            assert!(checked["reasons"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["kind"] == "feedback"
                    && r["reference"]["feedbackId"] == u1
                    && r["active"] == true));
            assert!(checked["reasons"]
                .as_array()
                .unwrap()
                .iter()
                .all(|r| r["kind"] != "sourceUnavailable" || r["active"] == false));
        }
    }
}
