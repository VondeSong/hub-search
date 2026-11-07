use super::*;
fn export_args(f: &Fixture, saved: &Value, key: &str) -> Value {
    let parent = f.root.join(format!("export-{key}"));
    std::fs::create_dir(&parent).unwrap();
    json!({"action":"skillPackageExport","packageId":saved["source"]["packageId"],"expectedRevision":saved["source"]["revision"],"methodVersion":saved["methodVersion"],"directory":parent,"clientRequestId":key})
}
fn delete_args(f: &Fixture, saved: &Value, key: &str) -> Value {
    let plan=call(f,&json!({"action":"skillPackageDeletePreview","packageId":saved["source"]["packageId"],"expectedRevision":saved["source"]["revision"]})).unwrap();
    json!({"action":"skillPackageDelete","packageId":plan["packageId"],"expectedRevision":plan["revision"],"expectedFingerprint":plan["fingerprint"],"confirmed":true,"clientRequestId":key})
}
fn files(path: &Path) -> Value {
    inspection::capture(&crate::display_local_path(path))
        .unwrap()
        .files
}
fn request(f: &Fixture, key: &str) -> Value {
    call(
        f,
        &json!({"action":"skillPackageRequest","clientRequestId":key}),
    )
    .unwrap()
}
#[test]
fn c2_export_copies_exact_inert_bytes_and_same_request_reopens_without_writing() {
    let f = Fixture::new();
    let p = folder(&f, "export-fixed");
    let before = files(&p);
    let mtime = std::fs::metadata(p.join("SKILL.md"))
        .unwrap()
        .modified()
        .unwrap();
    let (saved, _) = import(&f, &p, "export-import");
    let args = export_args(&f, &saved, "copy-one");
    let op = call(&f, &args).unwrap();
    assert_eq!(op["state"], "completed");
    let target = PathBuf::from(op["detail"]["target"].as_str().unwrap());
    let target_time = std::fs::metadata(target.join("SKILL.md"))
        .unwrap()
        .modified()
        .unwrap();
    assert_eq!(files(&target), before);
    assert_eq!(files(&p), before);
    assert_eq!(
        std::fs::metadata(p.join("SKILL.md"))
            .unwrap()
            .modified()
            .unwrap(),
        mtime
    );
    crate::database::forget_initialized_database(&f.root.join("craft-search.sqlite3"));
    assert_eq!(request(&f, "copy-one")["operation"], op);
    assert_eq!(call(&f, &args).unwrap(), op);
    assert_eq!(
        std::fs::metadata(target.join("SKILL.md"))
            .unwrap()
            .modified()
            .unwrap(),
        target_time
    );
    let mut other = args.clone();
    other["directory"] = json!(f.root);
    assert!(call(&f, &other).is_err());
    let mut again = args.clone();
    again["clientRequestId"] = json!("another-copy");
    assert!(call(&f, &again).is_err());
    assert_eq!(files(&target), before);
    assert_eq!(counts(&f), json!([1, 1, 0, 0]));
    std::fs::write(target.join("references/rules.md"), "changed externally").unwrap();
    assert_eq!(request(&f, "copy-one")["operation"]["state"], "unverified");
}
#[test]
fn c2_export_final_receipt_abort_recovers_complete_owned_files_without_rewrite() {
    let f = Fixture::new();
    let p = folder(&f, "export-receipt");
    let (saved, _) = import(&f, &p, "receipt-import");
    let args = export_args(&f, &saved, "receipt-failure");
    f.c().execute_batch("CREATE TRIGGER reject_export_receipt BEFORE UPDATE ON agent_skill_package_operations WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'controlled final receipt failure'); END;").unwrap();
    assert!(call(&f, &args).is_err());
    let target = PathBuf::from(args["directory"].as_str().unwrap()).join("export-receipt");
    let before = files(&target);
    let time = std::fs::metadata(target.join("SKILL.md"))
        .unwrap()
        .modified()
        .unwrap();
    assert_eq!(
        request(&f, "receipt-failure")["operation"]["state"],
        "unverified"
    );
    f.c()
        .execute_batch("DROP TRIGGER reject_export_receipt;")
        .unwrap();
    let recovered = request(&f, "receipt-failure");
    assert_eq!(recovered["operation"]["state"], "completed");
    assert_eq!(files(&target), before);
    assert_eq!(
        std::fs::metadata(target.join("SKILL.md"))
            .unwrap()
            .modified()
            .unwrap(),
        time
    );
    assert_eq!(counts(&f), json!([1, 1, 0, 0]));
}
#[test]
fn c2_export_unowned_partial_or_replaced_directory_is_never_claimed_or_retried() {
    let f = Fixture::new();
    let p = folder(&f, "export-ownership");
    let (saved, _) = import(&f, &p, "owner-import");
    let args = export_args(&f, &saved, "owner-failure");
    f.c().execute_batch("CREATE TRIGGER reject_owner_receipt BEFORE UPDATE ON agent_skill_package_operations BEGIN SELECT RAISE(ABORT,'controlled ownership receipt failure'); END;").unwrap();
    assert!(call(&f, &args).is_err());
    let target = PathBuf::from(args["directory"].as_str().unwrap()).join("export-ownership");
    assert!(target.is_dir());
    assert_eq!(std::fs::read_dir(&target).unwrap().count(), 0);
    f.c()
        .execute_batch("DROP TRIGGER reject_owner_receipt;")
        .unwrap();
    assert_eq!(call(&f, &args).unwrap()["state"], "unverified");
    assert_eq!(std::fs::read_dir(&target).unwrap().count(), 0);
    let args2 = export_args(&f, &saved, "replaced-target");
    let op = call(&f, &args2).unwrap();
    let owned = PathBuf::from(op["detail"]["target"].as_str().unwrap());
    let moved = owned.with_extension("preserved");
    std::fs::rename(&owned, &moved).unwrap();
    std::fs::create_dir(&owned).unwrap();
    assert_eq!(
        request(&f, "replaced-target")["operation"]["state"],
        "unverified"
    );
    assert_eq!(files(&moved), files(&p));
}
#[test]
fn c2_delete_redacts_typed_method_and_reload_copies_but_preserves_outcomes_and_usage() {
    let f = Fixture::new();
    let p = folder(&f, "private-method");
    let original = files(&p);
    let mtime = std::fs::metadata(p.join("SKILL.md"))
        .unwrap()
        .modified()
        .unwrap();
    let (saved, old_import) = import(&f, &p, "private-import");
    let doc = f.seed("Keep.md", "个人材料合成，不修改\n");
    let anchor = EvidenceLocator::Note {
        library_id: "notes".into(),
        document_id: doc,
        page_id: None,
    };
    let id = store::create(
        &f.root,
        "$private-method 核对".into(),
        "保留失败与未知额度".into(),
        anchor.clone(),
        Grant {
            notes: vec![anchor],
            ..Default::default()
        },
    )
    .unwrap();
    let run = "controlled-delete-test";
    let work = store::claim(&f.root, &id, run).unwrap();
    let mut catalog = Catalog::discover(&f.root).unwrap();
    let version = catalog.fixed_version("private-method").unwrap();
    let load = catalog.load("private-method", "$private-method").unwrap();
    let req = json!({"operation":"loadSkill","name":"private-method","stepId":"load-private"});
    store::record(&f.root, run, "toolCall", &req).unwrap();
    let receipt = store::tool_results::capture(&f.root, &id, run, &req, &load).unwrap();
    let reload = store::tool_results::read_for_work(
        &f.root,
        &work,
        receipt["recordId"].as_str().unwrap(),
        receipt["sha256"].as_str().unwrap(),
        0,
        4000,
    )
    .unwrap();
    let req = json!({"operation":"traceResult","recordId":receipt["recordId"],"sha256":receipt["sha256"],"start":0,"limit":4000,"stepId":"reload-private"});
    store::record(&f.root, run, "toolCall", &req).unwrap();
    store::tool_results::capture(&f.root, &id, run, &req, &reload).unwrap();
    store::record(
        &f.root,
        run,
        "diagnostic",
        &json!({"failure":"original failure remains","unknownUsage":true}),
    )
    .unwrap();
    let report:runner::Report=serde_json::from_value(json!({"status":"completed","summary":"受控合成成果，保留删除前历史","findings":[],"nextSteps":[],"questions":[],"limitations":["不是模型质量成绩"],"waitCondition":""})).unwrap();
    store::publish(
        &f.root,
        &work,
        run,
        &report,
        &[],
        &[],
        &json!([]),
        &Value::Null,
        &Control::default(),
    )
    .unwrap();
    let topic=call(&f,&json!({"action":"topicCreate","workId":id,"expectedWorkRevision":1,"title":"保留历史专题","period":"2026-01","skill":"private-method","clientRequestId":"private-topic"})).unwrap();
    let before: Value = {
        let c = f.c();
        json!({"work":store::load(&c,&id).unwrap(),"run":c.query_row("SELECT state||usage_json FROM agent_runs WHERE id=?1",[run],|r|r.get::<_,String>(0)).unwrap(),"other":store::records(&f.root,&id,"diagnostic",1).unwrap()})
    };
    let args = delete_args(&f, &saved, "delete-private");
    let op = call(&f, &args).unwrap();
    assert_eq!(op["state"], "completed");
    assert_eq!(op["detail"]["redactedReadReceipts"], 2);
    assert_eq!(call(&f, &args).unwrap(), op);
    let after: Value = {
        let c = f.c();
        json!({"work":store::load(&c,&id).unwrap(),"run":c.query_row("SELECT state||usage_json FROM agent_runs WHERE id=?1",[run],|r|r.get::<_,String>(0)).unwrap(),"other":store::records(&f.root,&id,"diagnostic",1).unwrap()})
    };
    assert_eq!(before, after);
    assert!(catalog.verify().is_err());
    assert!(Catalog::discover(&f.root)
        .unwrap()
        .pin_version(&version)
        .is_err());
    assert!(store::tool_results::read_for_work(
        &f.root,
        &work,
        receipt["recordId"].as_str().unwrap(),
        receipt["sha256"].as_str().unwrap(),
        0,
        4000
    )
    .is_err());
    assert!(call(&f, &old_import).is_err());
    let reopened = call(
        &f,
        &json!({"action":"topicOpen","topicId":topic["topic"]["id"]}),
    )
    .unwrap();
    assert_eq!(reopened["methodCompatible"], false);
    assert!(reopened["methodUnavailableReason"]
        .as_str()
        .unwrap()
        .contains("删除"));
    assert_eq!(reopened["history"][0]["workId"], id);
    assert_eq!(files(&p), original);
    assert_eq!(
        std::fs::metadata(p.join("SKILL.md"))
            .unwrap()
            .modified()
            .unwrap(),
        mtime
    );
    assert_eq!(request(&f, "delete-private")["operation"], op);
}
#[test]
fn c2_delete_confirmation_stale_scope_and_real_transaction_abort_do_not_partially_delete() {
    let f = Fixture::new();
    let p = folder(&f, "delete-atomic");
    let (saved, _) = import(&f, &p, "atomic-import");
    let args = delete_args(&f, &saved, "atomic-delete");
    let mut unconfirmed = args.clone();
    unconfirmed["confirmed"] = json!(false);
    assert!(call(&f, &unconfirmed).is_err());
    let mut stale = args.clone();
    stale["expectedFingerprint"] = json!("wrong");
    assert!(call(&f, &stale).is_err());
    f.c().execute_batch("CREATE TRIGGER reject_delete BEFORE INSERT ON agent_skill_package_operations WHEN NEW.operation='delete' BEGIN SELECT RAISE(ABORT,'controlled delete receipt abort'); END;").unwrap();
    assert!(call(&f, &args).is_err());
    assert_eq!(
        call(
            &f,
            &json!({"action":"skillPackageDetails","packageId":saved["source"]["packageId"]})
        )
        .unwrap(),
        saved
    );
    assert_eq!(request(&f, "atomic-delete")["found"], false);
    f.c().execute_batch("DROP TRIGGER reject_delete;").unwrap();
    assert_eq!(call(&f, &args).unwrap()["state"], "completed");
}
#[test]
fn c2_deleted_registered_name_does_not_silently_reactivate_raw_folder() {
    let f = Fixture::new();
    let p = folder(&f, "legacy-deleted");
    let raw = f.root.join("agent-skills/legacy-deleted");
    std::fs::create_dir_all(raw.parent().unwrap()).unwrap();
    std::fs::rename(&p, &raw).unwrap();
    let (saved, _) = import(&f, &raw, "legacy-import");
    let op = call(&f, &delete_args(&f, &saved, "legacy-delete")).unwrap();
    assert_eq!(op["state"], "completed");
    let catalog = Catalog::discover(&f.root).unwrap();
    assert!(!catalog.skills.contains_key("legacy-deleted"));
    assert!(raw.join("SKILL.md").is_file());
    let (next, _) = import(&f, &raw, "explicit-reimport");
    assert_ne!(next["source"]["packageId"], saved["source"]["packageId"]);
    assert!(Catalog::discover(&f.root)
        .unwrap()
        .skills
        .contains_key("legacy-deleted"));
}
#[test]
fn c2_same_bytes_changed_tool_contract_requires_an_explicit_new_pin() {
    let f = Fixture::new();
    let p = folder(&f, "tool-pin");
    let (saved, _) = import(&f, &p, "tool-pin-import");
    let c = f.c();
    let mut old =
        crate::agent_work::topics::method_on(&c, saved["methodVersion"].as_str().unwrap()).unwrap();
    old["content"]["toolContractVersion"] =
        json!(hash(&reference_description_contract().to_string()));
    old["id"] = json!(format!("method-{}", hash(&old["content"].to_string())));
    assert!(versions::compatible_contract(
        &old["content"]["toolContractVersion"]
    ));
    c.execute(
        "INSERT INTO agent_method_versions VALUES(?1,?2,0)",
        params![old["id"].as_str(), old.to_string()],
    )
    .unwrap();
    c.execute(
        "UPDATE agent_skill_source_revisions SET method_version=?1",
        [old["id"].as_str()],
    )
    .unwrap();
    drop(c);
    let checked=call(&f,&json!({"action":"skillPackageCheck","packageId":saved["source"]["packageId"],"expectedRevision":1})).unwrap();
    assert_eq!(checked["sourceChanged"], false);
    assert_eq!(checked["methodChanged"], true);
    assert_eq!(checked["changed"], true);
    assert!(call(&f,&json!({"action":"skillPackageDetails","packageId":saved["source"]["packageId"],"methodVersion":42})).is_err());
}
#[test]
fn c2_schema_82_upgrade_retains_rows_and_invalid_operation_table_rolls_back() {
    let f = Fixture::new();
    let p = folder(&f, "schema-keep");
    let (saved, _) = import(&f, &p, "schema-import");
    let c = f.c();
    c.execute_batch("DROP TABLE agent_skill_package_operations;UPDATE metadata SET value='82' WHERE key='schema_version'").unwrap();
    drop(c);
    crate::database::forget_initialized_database(&f.root.join("craft-search.sqlite3"));
    drop(f.c());
    assert_eq!(
        call(
            &f,
            &json!({"action":"skillPackageDetails","packageId":saved["source"]["packageId"]})
        )
        .unwrap(),
        saved
    );
    let c = f.c();
    assert_eq!(
        c.query_row(
            "SELECT value FROM metadata WHERE key='schema_version'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "83"
    );
    c.execute_batch("DROP TABLE agent_skill_package_operations;CREATE TABLE agent_skill_package_operations(id TEXT);UPDATE metadata SET value='82' WHERE key='schema_version'").unwrap();
    drop(c);
    crate::database::forget_initialized_database(&f.root.join("craft-search.sqlite3"));
    assert!(crate::open_database(&f.root.join("craft-search.sqlite3")).is_err());
    let c = Connection::open(f.root.join("craft-search.sqlite3")).unwrap();
    assert_eq!(
        c.query_row(
            "SELECT value FROM metadata WHERE key='schema_version'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "82"
    );
}
#[test]
fn c2_real_hard_link_is_rejected_without_import_or_source_changes() {
    let f = Fixture::new();
    let p = folder(&f, "no-links");
    let before = std::fs::read(p.join("SKILL.md")).unwrap();
    std::fs::hard_link(p.join("SKILL.md"), f.root.join("linked.md")).unwrap();
    assert!(call(&f, &json!({"action":"skillPackagePreview","directory":p})).is_err());
    assert_eq!(std::fs::read(p.join("SKILL.md")).unwrap(), before);
    assert_eq!(counts(&f), json!([0, 0, 0, 0]));
}

#[test]
fn c2_operation_identity_is_shared_inside_write_transaction_and_old_import_status_stays_truthful() {
    let f = Fixture::new();
    let p = folder(&f, "operation-ids");
    let (saved, original) = import(&f, &p, "id-import");
    let args = export_args(&f, &saved, "shared-id");
    assert_eq!(call(&f, &args).unwrap()["state"], "completed");
    store::write(&f.root, |c| {
        assert!(duplicate(c, "shared-id", "different-payload").is_err());
        Ok(())
    })
    .unwrap();
    assert_eq!(
        call(&f, &delete_args(&f, &saved, "id-delete")).unwrap()["state"],
        "completed"
    );
    let old = request(&f, original["clientRequestId"].as_str().unwrap());
    assert_eq!(old["found"], true);
    assert_eq!(old["removedPackageId"], saved["source"]["packageId"]);
    assert!(old.get("detail").is_none());
    assert!(call(&f, &original).is_err());
}
