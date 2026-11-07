use super::*;
use crate::obsidian_edit::tests::Fixture;
mod lifecycle;

fn folder(f: &Fixture, name: &str) -> PathBuf {
    let p = f.root.join(format!("source-{name}"));
    for d in ["references", "assets", "scripts", "agents"] {
        std::fs::create_dir_all(p.join(d)).unwrap();
    }
    std::fs::write(p.join("SKILL.md"),format!("---\nname: {name}\ndescription: 合成方法包检验，不是事实证据\nmetadata:\n  custom-field: keep-me\n---\n先读[rules](references/rules.md)，输出用[template](assets/report.md)。不要执行脚本。\n")).unwrap();
    std::fs::write(p.join("references/rules.md"), "保留出处、缺值不补零。\n").unwrap();
    std::fs::write(p.join("assets/report.md"), "# 报告\n事实 / 计算 / 限制\n").unwrap();
    std::fs::write(
        p.join("agents/openai.yaml"),
        "interface:\n  display_name: 固定复核方法\npolicy:\n  allow_implicit_invocation: false\n",
    )
    .unwrap();
    std::fs::write(
        p.join("scripts/never.py"),
        "raise Exception('must not run')\n",
    )
    .unwrap();
    std::fs::write(p.join("assets/opaque.bin"), [0, 255, 128, 17]).unwrap();
    p
}
fn call(f: &Fixture, args: &Value) -> Result<Value, String> {
    crate::agent_work::ui(&f.root, args)
}
fn import(f: &Fixture, path: &Path, key: &str) -> (Value, Value) {
    let preview = call(f, &json!({"action":"skillPackagePreview","directory":path})).unwrap();
    let args = json!({"action":"skillPackageImport","directory":path,"mode":"source","expectedFingerprint":preview["sourceFingerprint"],"clientRequestId":key});
    (call(f, &args).unwrap(), args)
}
fn counts(f: &Fixture) -> Value {
    let c = f.c();
    json!([
        c.query_row(
            "SELECT count(*) FROM agent_skill_source_revisions",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        c.query_row("SELECT count(*) FROM agent_method_versions", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        c.query_row("SELECT count(*) FROM agent_runs", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        c.query_row("SELECT count(*) FROM agent_actions", [], |r| r
            .get::<_, i64>(0))
            .unwrap()
    ])
}

fn reference_description_contract() -> Value {
    let mut contract = json!({
        "shared": crate::hub_capabilities::catalog(),
        "host": crate::agent_work::assistant::schema(crate::agent_work::runner::schema())
    });
    let reference = contract["shared"]["tools"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|tool| tool["name"] == "hub_readSkillReference")
        .unwrap();
    let description = json!("读取已加载技能 references/ 内的文字参考；不执行脚本。");
    assert_ne!(reference["description"], description);
    reference["description"] = description.clone();
    reference["annotations"]["title"] = description;
    contract
}

#[test]
fn c1_folder_import_preserves_bounded_resources_and_reads_templates_only_when_loaded() {
    let f = Fixture::new();
    let p = folder(&f, "fixed-review");
    let original = std::fs::read(p.join("SKILL.md")).unwrap();
    let mtime = std::fs::metadata(p.join("SKILL.md"))
        .unwrap()
        .modified()
        .unwrap();
    let (saved, args) = import(&f, &p, "import-fixed-once");
    assert_eq!(saved["source"]["revision"], 1);
    assert_eq!(saved["files"].as_array().unwrap().len(), 6);
    assert_eq!(saved["verifiedByRealRun"], false);
    assert_eq!(counts(&f), json!([1, 1, 0, 0]));
    assert_eq!(call(&f, &args).unwrap(), saved);
    assert_eq!(counts(&f), json!([1, 1, 0, 0]));
    let mut catalog = Catalog::discover(&f.root).unwrap();
    assert!(catalog
        .read_reference("fixed-review", "assets/report.md")
        .is_err());
    assert!(catalog.load("fixed-review", "复核").is_err());
    let loaded = catalog
        .load("fixed-review", "明确使用 $fixed-review")
        .unwrap();
    assert_eq!(loaded["skill"]["origin"], "registered");
    assert_eq!(loaded["skill"]["methodVersion"], saved["methodVersion"]);
    assert_eq!(
        loaded["referencePaths"],
        json!(["assets/report.md", "references/rules.md"])
    );
    assert!(catalog
        .read_reference("fixed-review", "assets/report.md")
        .unwrap()["content"]
        .as_str()
        .unwrap()
        .contains("事实 / 计算 / 限制"));
    for bad in [
        "../secret.txt",
        "assets/../SKILL.md",
        "assets/opaque.bin",
        "scripts/never.py",
        "references/no.md",
        "assets\\report.md",
        "C:/secret.md",
    ] {
        assert!(
            catalog.read_reference("fixed-review", bad).is_err(),
            "{bad}"
        );
    }
    let version = catalog.fixed_version("fixed-review").unwrap();
    assert_eq!(
        inspection::decode(&version["content"]["files"]["assets/opaque.bin"]).unwrap(),
        vec![0, 255, 128, 17]
    );
    assert!(
        inspection::file_text(&version["content"]["files"], "SKILL.md")
            .unwrap()
            .contains("keep-me")
    );
    catalog.verify().unwrap();
    assert_eq!(std::fs::read(p.join("SKILL.md")).unwrap(), original);
    assert_eq!(
        std::fs::metadata(p.join("SKILL.md"))
            .unwrap()
            .modified()
            .unwrap(),
        mtime
    );
}

#[test]
fn c2_source_update_switch_and_offline_restore_keep_exact_old_method_and_resource_bytes() {
    let f = Fixture::new();
    let p = folder(&f, "update-review");
    let (saved, _) = import(&f, &p, "register-update");
    let id = saved["source"]["packageId"].as_str().unwrap();
    let mut old = Catalog::discover(&f.root).unwrap();
    let pin = old.fixed_version("update-review").unwrap();
    old.pin_version(&pin).unwrap();
    old.load("update-review", "$update-review").unwrap();
    let reference = old
        .read_reference("update-review", "references/rules.md")
        .unwrap();
    std::fs::write(
        p.join("references/rules.md"),
        "新口径：先说明来源与更改。\n",
    )
    .unwrap();
    let checked = call(
        &f,
        &json!({"action":"skillPackageCheck","packageId":id,"expectedRevision":1}),
    )
    .unwrap();
    assert_eq!(checked["changed"], true);
    assert_eq!(counts(&f), json!([1, 1, 0, 0]));
    let updated=call(&f,&json!({"action":"skillPackageUpdate","packageId":id,"expectedRevision":1,"expectedFingerprint":checked["sourceFingerprint"],"clientRequestId":"publish-update"})).unwrap();
    assert_eq!(updated["source"]["revision"], 2);
    assert_ne!(updated["methodVersion"], saved["methodVersion"]);
    old.verify().unwrap();
    assert_eq!(
        old.read_reference("update-review", "references/rules.md")
            .unwrap(),
        reference
    );
    let mut current = Catalog::discover(&f.root).unwrap();
    current.load("update-review", "$update-review").unwrap();
    assert_ne!(
        current
            .read_reference("update-review", "references/rules.md")
            .unwrap()["version"],
        reference["version"]
    );
    let switched=call(&f,&json!({"action":"skillPackageSwitch","packageId":id,"expectedRevision":2,"methodVersion":saved["methodVersion"],"clientRequestId":"switch-old"})).unwrap();
    assert_eq!(switched["source"]["revision"], 3);
    assert_eq!(switched["methodVersion"], saved["methodVersion"]);
    assert_eq!(counts(&f), json!([3, 2, 0, 0]));
    std::fs::rename(&p, f.root.join("source-temporarily-offline")).unwrap();
    let mut reopened = Catalog::discover(&f.root).unwrap();
    reopened.pin_version(&pin).unwrap();
    reopened.load("update-review", "$update-review").unwrap();
    reopened.inherit_reads(&old.reads()).unwrap();
    reopened.verify().unwrap();
    assert_eq!(
        reopened
            .read_reference("update-review", "references/rules.md")
            .unwrap(),
        reference
    );
    assert!(call(
        &f,
        &json!({"action":"skillPackageCheck","packageId":id,"expectedRevision":3})
    )
    .is_err());
}

#[test]
fn c1_missing_unknown_dependencies_and_scripts_are_preserved_but_not_usable_or_executed() {
    let f = Fixture::new();
    let p = folder(&f, "blocked-review");
    std::fs::write(p.join("SKILL.md"),"---\nname: blocked-review\ndescription: 必需资源不支持时不可用\nallowed-tools: shell\n---\n必需[missing](references/missing.md)和[script](scripts/never.py)。\n").unwrap();
    std::fs::write(p.join("agents/openai.yaml"),"policy:\n  unknown_permission: true\ndependencies:\n  tools:\n    - type: mcp\n      value: terminal\n").unwrap();
    let (saved, _) = import(&f, &p, "blocked-import");
    assert_eq!(saved["skill"]["available"], false);
    assert!(
        saved["skill"]["unavailableReasons"]
            .as_array()
            .unwrap()
            .len()
            >= 4
    );
    assert!(Catalog::discover(&f.root)
        .unwrap()
        .load("blocked-review", "$blocked-review")
        .is_err());
    assert!(!p.join("script-executed").exists());
    assert_eq!(counts(&f), json!([1, 1, 0, 0]));
}

#[test]
fn c2_source_preview_conflict_name_conflict_and_request_reuse_never_overwrite_a_package() {
    let f = Fixture::new();
    let p = folder(&f, "conflict-review");
    let (saved, args) = import(&f, &p, "conflict-import");
    let id = &saved["source"]["packageId"];
    let before = counts(&f);
    let mut different = args.clone();
    different["mode"] = json!("copy");
    assert!(call(&f, &different).unwrap_err().contains("同一保存请求"));
    let p2 = f.root.join("other-location");
    std::fs::create_dir_all(&p2).unwrap();
    std::fs::write(
        p2.join("SKILL.md"),
        "---\nname: conflict-review\ndescription: another origin\n---\n不同来源不可覆盖。\n",
    )
    .unwrap();
    let preview = call(&f, &json!({"action":"skillPackagePreview","directory":p2})).unwrap();
    assert!(preview["nameConflict"].is_string());
    assert!(call(&f,&json!({"action":"skillPackageImport","directory":p2,"mode":"copy","expectedFingerprint":preview["sourceFingerprint"],"clientRequestId":"other-location-import"})).is_err());
    let checked = call(
        &f,
        &json!({"action":"skillPackageCheck","packageId":id,"expectedRevision":1}),
    )
    .unwrap();
    assert_eq!(checked["changed"], false);
    std::fs::write(p.join("assets/report.md"), "编辑发生在预览之后").unwrap();
    assert!(call(&f,&json!({"action":"skillPackageUpdate","packageId":id,"expectedRevision":1,"expectedFingerprint":checked["sourceFingerprint"],"clientRequestId":"changed-during-preview"})).unwrap_err().contains("指纹"));
    assert_eq!(counts(&f), before);
    assert_eq!(
        call(
            &f,
            &json!({"action":"skillPackageRequest","clientRequestId":"conflict-import"})
        )
        .unwrap()["found"],
        true
    );
    assert_eq!(
        call(
            &f,
            &json!({"action":"skillPackageRequest","clientRequestId":"changed-during-preview"})
        )
        .unwrap()["found"],
        false
    );
    let foreign = f.root.join("missing-now");
    std::fs::rename(&p, &foreign).unwrap();
    assert_eq!(
        call(&f, &args).unwrap()["methodVersion"],
        saved["methodVersion"]
    );
}

#[test]
fn c2_real_database_abort_preserves_previous_registration_and_all_old_method_bytes() {
    let f = Fixture::new();
    let p = folder(&f, "atomic-review");
    let (saved, _) = import(&f, &p, "atomic-initial");
    let id = &saved["source"]["packageId"];
    let before = counts(&f);
    std::fs::write(
        p.join("assets/report.md"),
        "# 更新后的模板，故障不能让旧版消失",
    )
    .unwrap();
    let checked = call(
        &f,
        &json!({"action":"skillPackageCheck","packageId":id,"expectedRevision":1}),
    )
    .unwrap();
    f.c().execute_batch("CREATE TRIGGER reject_package_publish BEFORE INSERT ON agent_skill_source_revisions BEGIN SELECT RAISE(ABORT,'controlled publication transaction failure'); END;").unwrap();
    let result = call(
        &f,
        &json!({"action":"skillPackageUpdate","packageId":id,"expectedRevision":1,"expectedFingerprint":checked["sourceFingerprint"],"clientRequestId":"abort-update"}),
    );
    assert!(result.is_err());
    assert_eq!(counts(&f), before);
    let reopened = call(&f, &json!({"action":"skillPackageDetails","packageId":id})).unwrap();
    assert_eq!(reopened, saved);
    assert_eq!(
        call(
            &f,
            &json!({"action":"skillPackageRequest","clientRequestId":"abort-update"})
        )
        .unwrap()["found"],
        false
    );
}

#[test]
fn c1_capacity_encoding_and_path_failures_never_create_a_partial_registration() {
    let f = Fixture::new();
    let p = folder(&f, "bounds-review");
    std::fs::write(p.join("assets/huge.bin"), vec![0u8; 49_153]).unwrap();
    assert!(call(&f, &json!({"action":"skillPackagePreview","directory":p})).is_err());
    std::fs::remove_file(p.join("assets/huge.bin")).unwrap();
    for i in 0..28 {
        std::fs::write(p.join(format!("assets/file{i}.txt")), "x").unwrap();
    }
    assert!(call(&f, &json!({"action":"skillPackagePreview","directory":p})).is_err());
    for i in 0..28 {
        std::fs::remove_file(p.join(format!("assets/file{i}.txt"))).unwrap();
    }
    std::fs::write(p.join("SKILL.md"), [255u8]).unwrap();
    assert!(call(&f, &json!({"action":"skillPackagePreview","directory":p})).is_err());
    assert_eq!(counts(&f), json!([0, 0, 0, 0]));
    assert!(!inspection::text_resource("assets/../secret.md"));
    assert!(!inspection::text_resource("assets/C:secret.md"));
    assert!(!inspection::text_resource("assets/name.md."));
}

#[test]
fn c1_windows_capture_holds_file_bytes_and_rejects_real_directory_junctions() {
    let f = Fixture::new();
    let p = folder(&f, "locked-review");
    let captured = inspection::capture(p.to_str().unwrap()).unwrap();
    assert!(std::fs::write(p.join("assets/report.md"), "must fail while captured").is_err());
    drop(captured);
    assert!(std::fs::write(p.join("assets/report.md"), "after release").is_ok());
    #[cfg(windows)]
    {
        let outside = f.root.join("outside-package");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "not authorized").unwrap();
        let link = p.join("assets/junction");
        let result = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link.to_string_lossy().replace('/', "\\"))
            .arg(outside.to_string_lossy().replace('/', "\\"))
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let failure = inspection::capture(p.to_str().unwrap()).err().unwrap();
        assert!(failure.contains("链接") || failure.contains("联接"));
        std::fs::remove_dir(link).unwrap();
        assert_eq!(
            std::fs::read_to_string(outside.join("secret.txt")).unwrap(),
            "not authorized"
        );
    }
}

#[test]
fn c1_registered_snapshots_cannot_be_forged_or_borrowed_from_another_source() {
    let f = Fixture::new();
    let p = folder(&f, "identity-review");
    let (saved, _) = import(&f, &p, "identity-import");
    let catalog = Catalog::discover(&f.root).unwrap();
    let good = catalog.fixed_version("identity-review").unwrap();
    let mut forged = good.clone();
    forged["content"]["files"]["assets/report.md"]["content"] =
        json!("changed without matching digest");
    assert!(versions::restore(&catalog, &forged).is_err());
    let mut forged = good.clone();
    forged["content"]["packageId"] = json!("package-unregistered");
    forged["id"] = json!(format!("method-{}", hash(&forged["content"].to_string())));
    assert!(versions::restore(&catalog, &forged).is_err());
    let mut incompatible = good.clone();
    incompatible["content"]["toolContractVersion"] = json!("unknown-future-tool-contract");
    incompatible["id"] = json!(format!(
        "method-{}",
        hash(&incompatible["content"].to_string())
    ));
    assert_eq!(
        report(None, &incompatible).unwrap()["skill"]["available"],
        false
    );
    assert!(versions::restore(&catalog, &incompatible).is_err());
    let f2 = Fixture::new();
    assert!(versions::restore(&Catalog::discover(&f2.root).unwrap(), &good).is_err());
    assert!(call(
        &f2,
        &json!({"action":"skillPackageDetails","packageId":saved["source"]["packageId"]})
    )
    .is_err());
}

#[test]
fn c1_builtin_version_is_compatible_only_with_the_declared_description_extension() {
    let f = Fixture::new();
    let catalog = Catalog::discover(&f.root).unwrap();
    // Derive the description-only predecessor from today's contract, not an unrelated release hash.
    let mut contract = reference_description_contract();
    let mut legacy = catalog.fixed_version("hub-research").unwrap();
    legacy["content"]["toolContractVersion"] = json!(hash(&contract.to_string()));
    legacy["id"] = json!(format!("method-{}", hash(&legacy["content"].to_string())));
    assert_eq!(legacy["content"]["origin"], "builtin");
    assert!(versions::compatible_contract(
        &legacy["content"]["toolContractVersion"]
    ));
    let old = versions::restore(&catalog, &legacy).unwrap();
    assert_eq!(old.name, legacy["content"]["name"]);
    let mut changed = legacy.clone();
    contract["shared"]["tools"][0]["name"] = json!("unrecognized-tool");
    changed["content"]["toolContractVersion"] = json!(hash(&contract.to_string()));
    changed["id"] = json!(format!("method-{}", hash(&changed["content"].to_string())));
    assert!(!versions::compatible_contract(
        &changed["content"]["toolContractVersion"]
    ));
    assert!(versions::restore(&catalog, &changed).is_err());
}

#[test]
fn c1_new_database_schema_is_atomic_and_rejects_an_incompatible_registration_table() {
    let f = Fixture::new();
    let c = f.c();
    c.execute_batch("DROP TABLE agent_skill_source_revisions; UPDATE metadata SET value='81' WHERE key='schema_version';").unwrap();
    drop(c);
    crate::database::forget_initialized_database(&f.root.join("craft-search.sqlite3"));
    let migrated = f.c();
    assert_eq!(
        migrated
            .query_row(
                "SELECT value FROM metadata WHERE key='schema_version'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        crate::database::DATABASE_SCHEMA_VERSION.to_string()
    );
    migrated.execute_batch("DROP TABLE agent_skill_source_revisions; CREATE TABLE agent_skill_source_revisions(package_id TEXT); UPDATE metadata SET value='81' WHERE key='schema_version';").unwrap();
    drop(migrated);
    crate::database::forget_initialized_database(&f.root.join("craft-search.sqlite3"));
    assert!(crate::open_database(&f.root.join("craft-search.sqlite3")).is_err());
    let raw = Connection::open(f.root.join("craft-search.sqlite3")).unwrap();
    assert_eq!(
        raw.query_row(
            "SELECT value FROM metadata WHERE key='schema_version'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "81"
    );
}

#[test]
fn c1_topic_selection_binds_registered_version_without_starting_a_model_or_expanding_scope() {
    let f = Fixture::new();
    let p = folder(&f, "topic-review");
    let (saved, _) = import(&f, &p, "topic-package-import");
    let doc = f.seed("One.md", "仅这篇笔记的合成材料");
    let topic=call(&f,&json!({"action":"topicCreateEmpty","anchor":{"kind":"note","libraryId":"notes","documentId":doc,"pageId":null},"defaultQuestion":"按固定方法复核当前笔记","title":"可复用方法","period":"2026-10","skill":"topic-review","outputPreference":"保持出处与未知","clientRequestId":"topic-registered-method"})).unwrap();
    assert_eq!(topic["method"]["id"], saved["methodVersion"]);
    assert_eq!(topic["methodCompatible"], true);
    assert_eq!(counts(&f)[2], 0);
    assert_eq!(counts(&f)[3], 0);
    assert!(topic["history"].as_array().unwrap().is_empty());
}

#[test]
fn c1_unknown_configuration_roots_and_hub_permission_fields_are_not_silently_usable() {
    let f = Fixture::new();
    let p = folder(&f, "unknown-environment");
    std::fs::write(
        p.join("agents/openai.yaml"),
        "required_environment:\n  network: true\n",
    )
    .unwrap();
    let preview = call(&f, &json!({"action":"skillPackagePreview","directory":p})).unwrap();
    assert_eq!(preview["skill"]["available"], false);
    assert!(preview["skill"]["unavailableReasons"]
        .to_string()
        .contains("required_environment"));
    std::fs::write(
        p.join("agents/openai.yaml"),
        "interface:\n  display_name: 合成复核\n",
    )
    .unwrap();
    std::fs::write(p.join("SKILL.md"),"---\nname: unknown-environment\ndescription: 未知权限不推定授予\nmetadata:\n  hub:\n    required-permissions: all-files\n---\n只作为兼容失败样本。\n").unwrap();
    let preview = call(&f, &json!({"action":"skillPackagePreview","directory":p})).unwrap();
    assert_eq!(preview["skill"]["available"], false);
    assert!(preview["skill"]["unavailableReasons"]
        .to_string()
        .contains("required-permissions"));
}

#[test]
fn c1_registered_method_load_delivery_and_foreign_version_are_separately_observable() {
    let f = Fixture::new();
    let p = folder(&f, "observed-method");
    let (saved, _) = import(&f, &p, "observed-method-import");
    let doc = f.seed("Observed.md", "受控合成记录，不运行模型");
    let locator = EvidenceLocator::Note {
        library_id: "notes".into(),
        document_id: doc,
        page_id: None,
    };
    let id = store::create(
        &f.root,
        "只验证方法事件归属".into(),
        "不运行模型，不把人为事件当实际采用".into(),
        locator.clone(),
        Grant {
            notes: vec![locator],
            ..Default::default()
        },
    )
    .unwrap();
    let run = "controlled-method-event-test";
    let work = store::claim(&f.root, &id, run).unwrap();
    store::record(
        &f.root,
        run,
        "topicRunBinding",
        &json!({"methodVersion":saved["methodVersion"],"configRevision":1}),
    )
    .unwrap();
    let mut catalog = Catalog::discover(&f.root).unwrap();
    let version = catalog.fixed_version("observed-method").unwrap();
    catalog.pin_version(&version).unwrap();
    store::write(&f.root, |c| {
        crate::agent_work::topics::record_method_use(c, &work, run)
    })
    .unwrap();
    let load = catalog.load("observed-method", "$observed-method").unwrap();
    let request =
        json!({"operation":"loadSkill","name":"observed-method","stepId":"registered-load"});
    store::record(&f.root, run, "toolCall", &request).unwrap();
    store::tool_results::capture(&f.root, &id, run, &request, &load).unwrap();
    let mut foreign = load.clone();
    foreign["skill"]["methodVersion"] = json!("method-foreign");
    let request = json!({"operation":"loadSkill","name":"observed-method","stepId":"foreign-load"});
    store::record(&f.root, run, "toolCall", &request).unwrap();
    store::tool_results::capture(&f.root, &id, run, &request, &foreign).unwrap();
    // Controlled callback qualification only; these are not real provider receipts.
    store::record(
        &f.root,
        run,
        "nativeContextDelivery",
        &json!({"callId":"foreign-load","phase":"flushedToProviderStdin"}),
    )
    .unwrap();
    store::write(&f.root, |c| {
        crate::agent_work::topics::record_method_use(c, &work, run)
    })
    .unwrap();
    let use_record = store::records(&f.root, &id, "topicMethodUse", 1).unwrap()[0].clone();
    assert_eq!(use_record["loadedThisRun"], true);
    assert_eq!(use_record["sentToRuntime"], false);
    assert_eq!(use_record["callIds"], json!(["registered-load"]));
    store::record(
        &f.root,
        run,
        "nativeContextDelivery",
        &json!({"callId":"registered-load","phase":"flushedToProviderStdin"}),
    )
    .unwrap();
    store::write(&f.root, |c| {
        crate::agent_work::topics::record_method_use(c, &work, run)
    })
    .unwrap();
    let record = store::records(&f.root, &id, "topicMethodUse", 1).unwrap()[0].clone();
    assert_eq!(record["sentToRuntime"], true);
    assert_eq!(record["semanticUse"], "unverified");
}
