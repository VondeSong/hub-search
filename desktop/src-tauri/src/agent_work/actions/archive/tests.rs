use super::*;
use crate::source_evidence::tests::Fixture;

#[test]
fn archive_inspection_keeps_draft_but_omits_large_preparation_inventory() {
    let (f, id) = setup();
    let a = prepared(&f, &id);
    let mut payload = a.payload.unwrap();
    payload["plan"]["context"] = json!({"inventory":"x".repeat(140_000)});
    f.c()
        .execute(
            "UPDATE agent_actions SET payload_json=?2 WHERE id=?1",
            params![a.id, payload.to_string()],
        )
        .unwrap();
    let work = store::load(&f.c(), &id).unwrap();
    let result = super::super::assistant::inspect(&f.root, &work, &a.id).unwrap();
    assert_eq!(result["content"]["preparationContextOmitted"], true);
    let mut expected = payload["plan"].clone();
    expected.as_object_mut().unwrap().remove("context");
    assert_eq!(result["content"]["plan"], expected);
    assert!(result.to_string().len() < 65536);
    assert_eq!(load(&f.c(), &id, &a.id).unwrap().payload.unwrap(), payload);
}

#[test]
#[ignore = "requires authorized saved Dida draft and fresh report path; no model or remote writes"]
fn saved_dida_archive_inspection_fits_unchanged_record_limit() {
    let source = std::path::PathBuf::from(std::env::var("HUB_DIDA_DRAFT_REPLAY").unwrap());
    let output = std::path::PathBuf::from(std::env::var("HUB_DIDA_DRAFT_REPORT").unwrap());
    assert!(!output.exists());
    let f = Fixture::new();
    std::fs::copy(source, f.root.join("craft-search.sqlite3")).unwrap();
    crate::database::forget_initialized_database(&f.root.join("craft-search.sqlite3"));
    let id = "work--44J5OEMeh-hLmPTP1eKrzEQ";
    let run = "run-qODbmUFGIgw7GhZoInwVAfKH";
    let action = "action-6i-1e5ERU1M-kF9Z9R3KKQ_t";
    let c = f.c();
    let original = load(&c, id, action).unwrap().payload.unwrap();
    let count: i64 = c
        .query_row("SELECT count(*) FROM agent_runs", [], |r| r.get(0))
        .unwrap();
    // Restore lifecycle only in the disposable copy to inspect the saved prepared action.
    c.execute(
        "UPDATE agent_runs SET state='investigating',finished_at=NULL WHERE id=?1",
        [run],
    )
    .unwrap();
    c.execute(
        "UPDATE agent_works SET state='investigating',active_run=?2 WHERE id=?1",
        params![id, run],
    )
    .unwrap();
    let work = store::load(&c, id).unwrap();
    let raw:String = c.query_row("SELECT body_json FROM agent_records WHERE run_id=?1 AND kind='toolCall' ORDER BY rowid DESC LIMIT 1",[run],|r|r.get(0)).unwrap();
    let request: Value = serde_json::from_str(&raw).unwrap();
    drop(c);
    let result = super::super::assistant::inspect(&f.root, &work, action).unwrap();
    let mut expected = original["plan"].clone();
    let context = expected.as_object_mut().unwrap().remove("context").unwrap();
    assert_eq!(result["content"]["plan"], expected);
    assert_eq!(expected["provider"], "dida365");
    let mut legacy = result.clone();
    legacy["content"]["plan"]["context"] = context;
    assert_eq!(
        store::record(&f.root, run, "toolResult", &legacy).unwrap_err(),
        "单条调查记录过大"
    );
    let saved = store::tool_results::capture(&f.root, id, run, &request, &result).unwrap();
    let body: String = f
        .c()
        .query_row(
            "SELECT body_json FROM agent_records WHERE id=?1",
            [saved["recordId"].as_str().unwrap()],
            |r| r.get(0),
        )
        .unwrap();
    assert!(body.len() < 65536);
    assert_eq!(
        store::tool_results::raw(&serde_json::from_str(&body).unwrap()).unwrap(),
        result
    );
    assert_eq!(load(&f.c(), id, action).unwrap().payload.unwrap(), original);
    assert_eq!(
        f.c()
            .query_row("SELECT count(*) FROM agent_runs", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        count
    );
    std::fs::write(output,serde_json::to_vec_pretty(&json!({"legacyBytes":legacy.to_string().len(),"savedRecordBytes":body.len(),"limit":65536,"completeDraftPreserved":true,"persistedPayloadUnchanged":true,"modelCalls":0,"remoteWrites":0,"scope":"saved draft inspection and original admitted call result capture; past failed run remains failed in original profile"})).unwrap()).unwrap();
}

#[test]
fn desktop_archive_dispatch_and_action_futures_have_bounded_stack_frames() {
    fn bytes<F>(_: impl FnOnce(tauri::AppHandle, Value) -> F) -> usize {
        std::mem::size_of::<F>()
    }
    for (name, size) in [
        ("dispatch", bytes(ui)),
        ("prepare", bytes(prepare)),
        ("submit", bytes(submit)),
        ("associate", bytes(associate)),
    ] {
        assert!(
            size <= 262_144,
            "{name} future is {size} bytes; keep nested domain futures on the heap"
        );
    }
}
fn setup() -> (Fixture, String) {
    let f = Fixture::new();
    let post = crate::collection_models::Post {
        id: "reading".into(),
        text: "加工前测量孔距公差，单位为毫米。".into(),
        author_name: "Fixture".into(),
        author_handle: "fixture".into(),
        url: "https://example.com/reading".into(),
        source: "telegram".into(),
        ..Default::default()
    };
    let raw = serde_json::to_string(&post).unwrap();
    f.c().execute("INSERT INTO collection_x_items(item_key,account,post_json,content_hash,collected_at,captured_at) VALUES('reading','fixture',?1,'reading-v1',1,1)",[raw]).unwrap();
    let anchor = EvidenceLocator::Reading {
        item_key: "reading".into(),
    };
    let view = ui_create(&f, &anchor);
    let id = view["work"]["id"].as_str().unwrap().into();
    (f, id)
}
fn ui_create(f: &Fixture, anchor: &EvidenceLocator) -> Value {
    crate::agent_work::ui(&f.root,&json!({"action":"create","goal":"整理并保存装配验证资料","successCriteria":"保留原材料，核对实际保存结果","anchor":anchor,"grant":{"libraryIds":[],"notes":[],"readingItemKeys":["reading"]}})).unwrap()
}
fn prepared(f: &Fixture, id: &str) -> Action {
    let (w, action, context) = claim_action(&f.root, id, "archiveCopy", |c, w| {
        domain::agent_eligible_on(c, "reading", "craft")?;
        context_on(&f.root, c, w, &json!({"libraryId":"craft"}))
    })
    .unwrap();
    // This fixture exercises the action and domain transaction, not model
    // planning or a live Craft server. Actual planning remains the old owner.
    let plan = json!({"status":"planned","provider":"craft","libraryId":"craft","libraryName":"Craft","itemId":"reading","revision":context["sourceRevision"],"contentRevision":context["sourceRevision"],"contractVersion":"content-to-tasks-hub-v2","mode":"plan_only","operationId":format!("op:{action}"),"agentActionId":action,"agentWorkId":id,
        "title":"装配验证资料","markdown":"加工前测量孔距公差，单位为毫米。","summary":"保存装配资料","reason":"需要后续核对","destinationPath":"Craft / 实验记录","documentId":"","anchorId":"","folderId":"","attachments":[],"warnings":[]});
    let p = json!({"libraryId":"craft","targetName":"Craft","sourceTitle":context["source"]["title"],"connectionFingerprint":"fixture","plan":plan});
    publish_payload(&f.root, &w, &action, &p, &Control::default()).unwrap();
    load(&f.c(), id, &action).unwrap()
}
fn execute_claim(f: &Fixture, id: &str, a: &Action) -> (Work, Action, Control, Running) {
    claim_execution(&f.root, id, &a.id, &token(a), "fixture")
        .unwrap()
        .unwrap()
}
fn seed_result(f: &Fixture, a: &Action) {
    let p = a.payload.as_ref().unwrap();
    domain::record_remote_copy(
        &f.c(),
        "reading",
        "craft",
        "craft",
        "page-created",
        "document",
        "",
        p["plan"]["operationId"].as_str().unwrap(),
    )
    .unwrap();
}

#[test]
fn model_archive_facts_clarify_legacy_flags_without_rewriting_the_receipt() {
    let (f, id) = setup();
    let mut a = prepared(&f, &id);
    seed_result(&f, &a);
    let raw = json!({"state":"verified","copies":[{"objectId":"legacy-asset","parentId":"attachment","verified":false}],"goalCompleted":false});
    a.receipt = Some(json!({"result":raw.clone(),"goalCompleted":false}));
    let facts = fact_on(&f.c(), &a).unwrap();
    assert!(facts["recordedResult"]["copies"][0]["verified"].is_null());
    assert_eq!(
        facts["recordedResult"]["copies"][0]["verification"],
        "notRecordedIndividually"
    );
    assert_eq!(
        facts["currentResult"]["verificationScope"]["remoteAttachmentBytes"],
        "not compared"
    );
    assert_eq!(a.receipt.unwrap()["result"], raw);
}
#[test]
fn archive_draft_never_queues_or_writes_and_binds_real_reading_source() {
    let (f, id) = setup();
    let a = prepared(&f, &id);
    assert_eq!(a.kind, "archiveCopy");
    let count: i64 = f
        .c()
        .query_row("SELECT COUNT(*) FROM collection_library_jobs", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(count, 0);
    assert_eq!(
        options_on(&f.c(), &store::load(&f.c(), &id).unwrap()).unwrap()[0]["id"],
        "craft"
    );
    let mut w = store::load(&f.c(), &id).unwrap();
    w.anchor = Some(EvidenceLocator::Note {
        library_id: "notes".into(),
        document_id: "fake".into(),
        page_id: None,
    });
    assert!(context_on(&f.root, &f.c(), &w, &json!({"libraryId":"craft"})).is_err());
}
#[test]
fn confirmation_and_domain_claim_are_atomic_and_do_not_overwrite_other_jobs() {
    let (f, id) = setup();
    let a = prepared(&f, &id);
    assert!(claim_execution(&f.root, &id, &a.id, "forged", "fixture").is_err());
    f.c().execute_batch("CREATE TRIGGER reject_archive_confirmation BEFORE UPDATE OF state ON agent_actions WHEN NEW.state='executing' BEGIN SELECT RAISE(ABORT,'reject confirmation'); END;").unwrap();
    assert!(claim_execution(&f.root, &id, &a.id, &token(&a), "fixture").is_err());
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM collection_library_jobs", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    f.c().execute_batch("DROP TRIGGER reject_archive_confirmation; INSERT INTO collection_library_jobs(item_key,action,target,phase,plan) VALUES('reading','move','craft','unknown','{}');").unwrap();
    assert!(claim_execution(&f.root, &id, &a.id, &token(&a), "fixture").is_err());
    assert_eq!(load(&f.c(), &id, &a.id).unwrap().state, "prepared");
}
#[test]
fn unknown_outcome_is_preserved_and_never_automatically_replayed() {
    let (f, id) = setup();
    let a = prepared(&f, &id);
    let (_, _, _, running) = execute_claim(&f, &id, &a);
    f.c()
        .execute(
            "UPDATE collection_library_jobs SET phase='writing' WHERE item_key='reading'",
            [],
        )
        .unwrap();
    drop(running);
    reconcile(&f.root, &id, None).unwrap();
    let unknown = load(&f.c(), &id, &a.id).unwrap();
    assert_eq!(unknown.state, "unknown");
    assert!(claim_execution(&f.root, &id, &a.id, &token(&a), "fixture").is_err());
    assert_eq!(
        f.c()
            .query_row(
                "SELECT phase FROM collection_library_jobs WHERE item_key='reading'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "writing"
    );
    let facts = super::super::receipts(&f.root, &id).unwrap();
    assert_eq!(facts[0]["state"], "unknown");
}
#[test]
fn returned_remote_identity_survives_cancellation_and_full_proof_restores_success_without_reexecution(
) {
    let (f, id) = setup();
    let a = prepared(&f, &id);
    let (_, _, control, running) = execute_claim(&f, &id, &a);
    control.cancel();
    seed_result(&f, &a);
    record_result(&f.root, &id, &a.id, Some("已停止")).unwrap();
    drop(running);
    let partial = load(&f.c(), &id, &a.id).unwrap();
    assert_eq!(partial.state, "partial");
    assert_eq!(
        partial.receipt.as_ref().unwrap()["result"]["copies"][0]["objectId"],
        "page-created"
    );
    f.c()
        .execute(
            "UPDATE collection_library_jobs SET phase='cancelled' WHERE item_key='reading'",
            [],
        )
        .unwrap();
    let view = status(&f.root, &id).unwrap();
    assert_eq!(view["actions"]["items"][0]["canContinue"], false);
    assert!(claim_execution(&f.root, &id, &a.id, &token(&a), "fixture").is_err());
    f.c()
        .execute(
            "UPDATE collection_library_jobs SET phase='partial' WHERE item_key='reading'",
            [],
        )
        .unwrap();
    domain::mark_copy_verified(&f.c(), "reading", "craft", "page-created").unwrap();
    crate::x_bookmarks::library::complete_copy(&f.c(), "reading", "craft").unwrap();
    // Model a crash after the domain completion commit and before its Agent receipt.
    f.c()
        .execute(
            "UPDATE agent_actions SET state='executing' WHERE id=?1",
            [&a.id],
        )
        .unwrap();
    reconcile(&f.root, &id, None).unwrap();
    let done = load(&f.c(), &id, &a.id).unwrap();
    assert_eq!(done.state, "verified");
    store::revoke(&f.root, &id).unwrap();
    assert!(
        claim_execution(&f.root, &id, &a.id, &token(&a), "removed connection")
            .unwrap()
            .is_none()
    );
    assert_eq!(done.receipt.as_ref().unwrap()["goalCompleted"], false);
}
#[test]
fn changed_source_decision_target_and_connection_each_block_archive_confirmation() {
    for change in ["source", "decision", "revoke", "target", "connection"] {
        let (f, id) = setup();
        let a = prepared(&f, &id);
        match change {
            "source" => {
                f.c().execute("UPDATE collection_x_items SET content_hash='changed' WHERE item_key='reading'",[]).unwrap();
            }
            "decision" => store::decision(&f.root, &id, "暂不归档").unwrap(),
            "revoke" => store::revoke(&f.root, &id).unwrap(),
            "target" => {
                f.c()
                    .execute("UPDATE libraries SET enabled=0 WHERE id='craft'", [])
                    .unwrap();
            }
            _ => (),
        }
        assert!(
            claim_execution(
                &f.root,
                &id,
                &a.id,
                &token(&a),
                if change == "connection" {
                    "changed"
                } else {
                    "fixture"
                }
            )
            .is_err(),
            "{change}"
        );
        assert_eq!(
            f.c()
                .query_row("SELECT COUNT(*) FROM collection_library_jobs", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}
#[test]
fn operation_identity_prevents_an_unrelated_verified_copy_becoming_this_actions_success() {
    let (f, id) = setup();
    let a = prepared(&f, &id);
    let (_, _, _, running) = execute_claim(&f, &id, &a);
    domain::record_remote_copy(
        &f.c(),
        "reading",
        "craft",
        "craft",
        "unrelated-page",
        "document",
        "",
        "another-operation",
    )
    .unwrap();
    domain::mark_copy_verified(&f.c(), "reading", "craft", "unrelated-page").unwrap();
    crate::x_bookmarks::library::complete_copy(&f.c(), "reading", "craft").unwrap();
    drop(running);
    reconcile(&f.root, &id, None).unwrap();
    assert_eq!(load(&f.c(), &id, &a.id).unwrap().state, "unknown");
    assert!(
        current_on(&f.c(), &load(&f.c(), &id, &a.id).unwrap()).unwrap()["copies"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}
#[test]
fn prepared_and_verified_archive_survive_formal_backup_and_restore() {
    for verified in [false, true] {
        let (f, id) = setup();
        let a = prepared(&f, &id);
        if verified {
            let (_, _, _, running) = execute_claim(&f, &id, &a);
            seed_result(&f, &a);
            domain::mark_copy_verified(&f.c(), "reading", "craft", "page-created").unwrap();
            crate::x_bookmarks::library::complete_copy(&f.c(), "reading", "craft").unwrap();
            drop(running);
            reconcile(&f.root, &id, None).unwrap();
        }
        let base =
            std::env::temp_dir().join(format!("hub-action-backup-{}", crate::random_url_safe(12)));
        std::fs::create_dir(&base).unwrap();
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let backup = crate::data_backup::backup(
            &f.root,
            &crate::data_backup::BackupOptions {
                destination: base
                    .join("actions.hubbackup")
                    .to_string_lossy()
                    .into_owned(),
                include_external_sources: false,
            },
            &cancel,
            &mut |_| {},
        )
        .unwrap();
        let restored = base.join("restored");
        crate::data_backup::restore(Path::new(&backup.path), &restored, &cancel, &mut |_| {})
            .unwrap();
        drop(crate::database::open_database(&restored.join("craft-search.sqlite3")).unwrap());
        let c = crate::source_evidence::open_read_database(&restored).unwrap();
        let saved = load(&c, &id, &a.id).unwrap();
        assert_eq!(saved.state, if verified { "verified" } else { "prepared" });
        if verified {
            assert_eq!(current_on(&c, &saved).unwrap()["state"], "verified");
        } else {
            check_prepared(&restored, &c, &store::load(&c, &id).unwrap(), &saved).unwrap();
        }
        assert_eq!(token(&saved), token(&a));
        drop(c);
        assert_eq!(base.parent(), Some(std::env::temp_dir().as_path()));
        std::fs::remove_dir_all(base).unwrap();
    }
}

#[test]
fn dida_reference_binds_provider_and_rejects_action_or_duplicate_plans() {
    let (f, id) = setup();
    let c = f.c();
    let w = store::load(&c, &id).unwrap();
    let choices = options_on(&c, &w).unwrap();
    assert!(choices
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["id"] == "dida"));
    let context = context_on(&f.root, &c, &w, &json!({"libraryId":"dida"})).unwrap();
    assert_eq!(context["target"]["provider"], "dida365");
    let plan = json!({"provider":"dida365","libraryId":"dida","itemId":"reading","revision":context["sourceRevision"],"status":"planned","agentActionId":"dida-action","operationId":"one","referenceBodyFormat":"source-v1","tasks":[{"kind":"reference"}]});
    let tx = c.unchecked_transaction().unwrap();
    let mut invalid = plan.clone();
    invalid["provider"] = json!("craft");
    assert!(domain::agent_claim_on(&tx, "reading", "dida", &invalid).is_err());
    invalid = plan.clone();
    invalid["tasks"][0]["kind"] = json!("action");
    assert!(domain::agent_claim_on(&tx, "reading", "dida", &invalid).is_err());
    domain::agent_claim_on(&tx, "reading", "dida", &plan).unwrap();
    domain::agent_claim_on(&tx, "reading", "dida", &plan).unwrap();
    invalid = plan.clone();
    invalid["agentActionId"] = json!("another");
    assert!(domain::agent_claim_on(&tx, "reading", "dida", &invalid).is_err());
    assert_eq!(
        tx.query_row::<i64, _, _>("SELECT COUNT(*) FROM collection_library_jobs", [], |r| r
            .get(0))
            .unwrap(),
        1
    );
    tx.commit().unwrap();
}
