use super::*;
use rusqlite::params;

// Only synthetic fixtures below the project-owned evidence root. Each fixture
// records its producer before data creation; failed runs remain inspectable.
struct Fixture {
    base: PathBuf,
    root: PathBuf,
}
impl Fixture {
    fn new(name: &str) -> Self {
        let parent = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("task-state/data-portability-20261015/backup-tests");
        fs::create_dir_all(&parent).unwrap();
        let base = parent.join(format!("{name}-{}", identifier()));
        fs::create_dir(&base).unwrap();
        files::write_new_json(
            &base.join("run.json"),
            &serde_json::json!({"producer":"data_backup::tests","state":"running","name":name}),
        )
        .unwrap();
        let root = base.join("source");
        fs::create_dir(&root).unwrap();
        Self {
            base: fs::canonicalize(base).unwrap(),
            root: fs::canonicalize(root).unwrap(),
        }
    }
    fn database(&self) -> Connection {
        let c = Connection::open(self.root.join(DATABASE)).unwrap();
        c.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
            CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            INSERT INTO metadata VALUES('schema_version','72');
            CREATE TABLE libraries(id TEXT PRIMARY KEY,provider TEXT,name TEXT,location TEXT);
            CREATE TABLE documents(id TEXT PRIMARY KEY,markdown TEXT);
            CREATE TABLE blobs(hash TEXT PRIMARY KEY,size INTEGER NOT NULL,relative_path TEXT);
            CREATE TABLE user_profile_values(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            INSERT INTO documents VALUES('doc','来自数据库 WAL 的正文');
            INSERT INTO user_profile_values VALUES('favorites','[\"doc\"]');",
        )
        .unwrap();
        c
    }
    fn options(&self, name: &str) -> BackupOptions {
        BackupOptions {
            destination: self
                .base
                .join(format!("{name}.hubbackup"))
                .to_string_lossy()
                .into(),
            include_external_sources: false,
        }
    }
    fn finish(&self) {
        files::replace_json(
            &self.base.join("run.json"),
            &serde_json::json!({"producer":"data_backup::tests","state":"succeeded"}),
        )
        .unwrap();
    }
}
fn cancel() -> AtomicBool {
    AtomicBool::new(false)
}

fn legacy_media_fixture(name: &str) -> (Fixture, Connection, PathBuf, String) {
    let fixture = Fixture::new(name);
    let c = fixture.database();
    c.execute(
        "UPDATE metadata SET value=?1 WHERE key='schema_version'",
        [crate::database::DATABASE_SCHEMA_VERSION.to_string()],
    )
    .unwrap();
    c.execute_batch("CREATE TABLE reading_media_outbox(namespace TEXT,id TEXT,body BLOB NOT NULL,path TEXT NOT NULL,local_seq INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(namespace,id));
        CREATE TABLE collection_saved_media(item_key TEXT,media_url TEXT,path TEXT);").unwrap();
    let data = b"exact preserved media bytes";
    let hash = format!("{:x}", Sha256::digest(data));
    let cached = fixture
        .root
        .join("collection-files/recovered-assets")
        .join(&hash)
        .join("image.jpg");
    fs::create_dir_all(cached.parent().unwrap()).unwrap();
    fs::write(&cached, data).unwrap();
    let body=serde_json::json!({"format":1,"key":"item","url":"https://example.test/image.jpg","hash":hash,"size":data.len(),"state":"ready","version":1,"postHash":"post","mime":"image/jpeg"}).to_string();
    let old = fixture
        .base
        .join("OldVault/assets/image.jpg")
        .to_string_lossy()
        .into_owned();
    c.execute(
        "INSERT INTO reading_media_outbox(namespace,id,body,path) VALUES('ns','id',?1,?2)",
        params![body.as_bytes(), old],
    )
    .unwrap();
    c.execute(
        "INSERT INTO collection_saved_media VALUES('item','https://example.test/image.jpg',?1)",
        [cached.to_string_lossy().as_ref()],
    )
    .unwrap();
    (fixture, c, cached, body)
}

#[test]
fn legacy_media_paths_relink_exact_bytes_and_preserve_manifest_and_original_vault() {
    let (fixture, c, cached, body) = legacy_media_fixture("legacy-paths-exact");
    let original = fixture.base.join("OriginalVault");
    fs::create_dir(&original).unwrap();
    fs::write(original.join("note.md"), "original unchanged").unwrap();
    let plan =
        legacy_media_paths::plan(&fixture.root.join(DATABASE), &fixture.root, &cancel()).unwrap();
    assert_eq!(plan.summary()["relinked"], 1);
    assert_eq!(plan.unresolved, 0);
    plan.verify(&fixture.root, &cancel()).unwrap();
    plan.apply(&c).unwrap();
    let (path, after, sequence): (String, String, i64) = c
        .query_row(
            "SELECT path,CAST(body AS TEXT),local_seq FROM reading_media_outbox",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        fs::canonicalize(path).unwrap(),
        fs::canonicalize(cached).unwrap()
    );
    assert_eq!(after, body);
    assert_eq!(sequence, 0);
    assert_eq!(
        fs::read_to_string(original.join("note.md")).unwrap(),
        "original unchanged"
    );
    fixture.finish();
}

#[test]
fn legacy_media_paths_reject_same_name_or_size_with_different_content() {
    let (fixture, c, cached, _) = legacy_media_fixture("legacy-paths-tampered");
    let length = fs::metadata(&cached).unwrap().len() as usize;
    fs::write(&cached, vec![b'x'; length]).unwrap();
    let old: String = c
        .query_row("SELECT path FROM reading_media_outbox", [], |r| r.get(0))
        .unwrap();
    let plan =
        legacy_media_paths::plan(&fixture.root.join(DATABASE), &fixture.root, &cancel()).unwrap();
    assert_eq!(plan.changed(), 0);
    assert_eq!(plan.unresolved, 1);
    assert!(!plan.ignore_outbox_path(&old));
    assert_eq!(
        c.query_row("SELECT path FROM reading_media_outbox", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        old
    );
    fixture.finish();
}

#[test]
fn legacy_media_paths_clear_only_skipped_manifest_path_without_changing_saved_video() {
    let (fixture, c, cached, _) = legacy_media_fixture("legacy-paths-skipped");
    let body=serde_json::json!({"format":1,"key":"item","url":"https://example.test/video.mp4","hash":"","size":272920630,"state":"skipped","version":1}).to_string();
    c.execute("UPDATE reading_media_outbox SET body=?1", [body.as_bytes()])
        .unwrap();
    let before = fs::read(&cached).unwrap();
    let plan =
        legacy_media_paths::plan(&fixture.root.join(DATABASE), &fixture.root, &cancel()).unwrap();
    assert_eq!(plan.summary()["clearedSkippedPaths"], 1);
    plan.apply(&c).unwrap();
    assert_eq!(
        c.query_row("SELECT path FROM reading_media_outbox", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        ""
    );
    assert_eq!(
        c.query_row(
            "SELECT CAST(body AS TEXT) FROM reading_media_outbox",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        body
    );
    assert_eq!(fs::read(cached).unwrap(), before);
    fixture.finish();
}

#[test]
fn legacy_media_paths_conflict_rolls_back_all_relinks_and_keeps_newer_body() {
    let (fixture, mut c, _, body) = legacy_media_fixture("legacy-paths-conflict");
    c.execute("INSERT INTO reading_media_outbox SELECT namespace,'second',body,path,local_seq FROM reading_media_outbox",[]).unwrap();
    let plan =
        legacy_media_paths::plan(&fixture.root.join(DATABASE), &fixture.root, &cancel()).unwrap();
    assert_eq!(plan.changed(), 2);
    let newer = body.replace("\"version\":1", "\"version\":2");
    c.execute(
        "UPDATE reading_media_outbox SET body=?1 WHERE id='second'",
        [newer.as_bytes()],
    )
    .unwrap();
    {
        let tx = c.transaction().unwrap();
        assert!(plan.apply(&tx).is_err());
    }
    let old: String = c
        .query_row(
            "SELECT path FROM reading_media_outbox WHERE id='id'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(old.contains("OldVault"));
    assert_eq!(
        c.query_row(
            "SELECT CAST(body AS TEXT) FROM reading_media_outbox WHERE id='second'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        newer
    );
    fixture.finish();
}

#[test]
fn legacy_media_paths_maintenance_requires_stopped_profile_and_preserves_cache() {
    let (fixture, c, cached, body) = legacy_media_fixture("legacy-paths-maintenance");
    drop(c);
    let preview = preview_legacy_media_paths(&fixture.root).unwrap();
    assert_eq!(preview["relinked"], 1);
    let session = crate::data_portability::session_lease(&fixture.root).unwrap();
    assert!(repair_legacy_media_paths(&fixture.root).is_err());
    drop(session);
    let result = repair_legacy_media_paths(&fixture.root).unwrap();
    assert_eq!(result["relinked"], 1);
    let receipt: serde_json::Value =
        serde_json::from_slice(&fs::read(result["receipt"].as_str().unwrap()).unwrap()).unwrap();
    assert_eq!(receipt["state"], "committed");
    let c = Connection::open(fixture.root.join(DATABASE)).unwrap();
    assert_eq!(
        c.query_row(
            "SELECT CAST(body AS TEXT) FROM reading_media_outbox",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        body
    );
    assert!(cached.is_file());
    fixture.finish();
}

#[test]
fn consolidation_relinks_legacy_upload_paths_in_its_publication_transaction() {
    let fixture = Fixture::new("consolidate-legacy-paths");
    let c = crate::open_database(&fixture.root.join(DATABASE)).unwrap();
    c.execute_batch("CREATE TABLE IF NOT EXISTS reading_media_outbox(namespace TEXT,id TEXT,body BLOB NOT NULL,path TEXT NOT NULL,local_seq INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(namespace,id));
        CREATE TABLE IF NOT EXISTS collection_saved_media(item_key TEXT,media_url TEXT,path TEXT);").unwrap();
    let bytes = b"owned cached file";
    let hash = format!("{:x}", Sha256::digest(bytes));
    let cached = fixture
        .root
        .join("collection-files/recovered-assets")
        .join(&hash)
        .join("image.jpg");
    fs::create_dir_all(cached.parent().unwrap()).unwrap();
    fs::write(&cached, bytes).unwrap();
    let body=serde_json::json!({"format":1,"key":"item","url":"https://example.test/image.jpg","hash":hash,"size":bytes.len(),"state":"ready","version":1}).to_string();
    let old = fixture
        .base
        .join("MissingVault/image.jpg")
        .to_string_lossy()
        .into_owned();
    c.execute(
        "INSERT INTO reading_media_outbox(namespace,id,body,path) VALUES('ns','id',?1,?2)",
        params![body.as_bytes(), old],
    )
    .unwrap();
    drop(c);
    let result = consolidate(&fixture.root, &cancel(), &mut |_| {}).unwrap();
    assert_eq!(result["legacyMediaPaths"]["relinked"], 1);
    assert_eq!(result["ready"], true);
    let c = Connection::open(fixture.root.join(DATABASE)).unwrap();
    let path: String = c
        .query_row("SELECT path FROM reading_media_outbox", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        fs::canonicalize(path).unwrap(),
        fs::canonicalize(cached).unwrap()
    );
    fixture.finish();
}

#[test]
fn archive_round_trip_preserves_wal_profile_and_attachments_and_excludes_machine_files() {
    let fixture = Fixture::new("round-trip");
    let c = fixture.database();
    let data = b"attachment source bytes";
    let hash = format!("{:x}", Sha256::digest(data));
    let relative = format!("{}/{hash}", &hash[..2]);
    fs::create_dir_all(fixture.root.join("blobs-v1").join(&hash[..2])).unwrap();
    fs::write(fixture.root.join("blobs-v1").join(&relative), data).unwrap();
    c.execute(
        "INSERT INTO blobs VALUES(?1,?2,?3)",
        params![hash, data.len() as i64, relative],
    )
    .unwrap();
    for name in ["tantivy-generations-v1", "mobile-secrets-v1"] {
        fs::create_dir(fixture.root.join(name)).unwrap();
        fs::write(fixture.root.join(name).join("excluded"), b"not portable").unwrap();
    }
    fs::create_dir(fixture.root.join("collection-files")).unwrap();
    fs::write(fixture.root.join("collection-files/article.md"), "阅读副本").unwrap();
    let codex_settings=br#"{"schemaVersion":1,"settings":{"model":"test-model","reasoningEffort":"high","fast":false,"maxConcurrent":2}}"#;
    fs::write(fixture.root.join("codex-suite-v1.json"), codex_settings).unwrap();
    let model_settings=br#"{"schemaVersion":2,"settings":{"provider":"deepseek","model":"deepseek-flash","reasoningEffort":"none","fast":false,"maxConcurrent":2}}"#;
    fs::write(fixture.root.join("model-runtime-v1.json"), model_settings).unwrap();
    fs::create_dir(fixture.root.join("flashcard-backups")).unwrap();
    // This tests preservation of an already-existing restore point's bytes;
    // flashcard archive semantics are owned and tested by flashcard_backup.
    let previous_backup = b"HUBFC001 existing user restore point";
    fs::write(
        fixture.root.join("flashcard-backups/backup-existing.hubfc"),
        previous_backup,
    )
    .unwrap();
    fs::write(
        fixture
            .root
            .join("flashcard-backups/import-running.partial"),
        b"unfinished import",
    )
    .unwrap();
    let options = fixture.options("all");
    let summary = backup(&fixture.root, &options, &cancel(), &mut |_| {}).unwrap();
    assert!(summary.complete);
    assert!(summary.files >= 3);
    assert_eq!(
        inspect(Path::new(&options.destination), &cancel(), &mut |_| {})
            .unwrap()
            .checksum,
        summary.checksum
    );
    let target = fixture.base.join("restored");
    let result = restore(Path::new(&summary.path), &target, &cancel(), &mut |_| {}).unwrap();
    let restored = readonly(&target.join(DATABASE)).unwrap();
    assert_eq!(
        restored
            .query_row("SELECT markdown FROM documents WHERE id='doc'", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
        "来自数据库 WAL 的正文"
    );
    assert_eq!(
        restored
            .query_row(
                "SELECT value FROM user_profile_values WHERE key='favorites'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "[\"doc\"]"
    );
    assert_eq!(
        fs::read(target.join("blobs-v1").join(&relative)).unwrap(),
        data
    );
    assert!(!target.join("mobile-secrets-v1").exists());
    assert!(!target.join("tantivy-generations-v1").exists());
    assert_eq!(
        fs::read(target.join("codex-suite-v1.json")).unwrap(),
        codex_settings
    );
    assert_eq!(
        fs::read(target.join("model-runtime-v1.json")).unwrap(),
        model_settings
    );
    assert_eq!(
        fs::read(target.join("flashcard-backups/backup-existing.hubfc")).unwrap(),
        previous_backup
    );
    assert!(!target
        .join("flashcard-backups/import-running.partial")
        .exists());
    assert_eq!(dataset_id(&target).unwrap(), summary.dataset_id);
    assert_eq!(result.path_mappings[0].kind, "dataRoot");
    assert!(fixture.root.join(DATABASE).exists());
    fixture.finish();
}

#[test]
fn referenced_craft_original_is_materialized_and_missing_attachments_are_reported() {
    let fixture = Fixture::new("external-original");
    let c = fixture.database();
    let original = fixture.base.join("original.bin");
    let data = b"craft original";
    fs::write(&original, data).unwrap();
    let hash = format!("{:x}", Sha256::digest(data));
    c.execute_batch("CREATE TABLE craft_backup_files(hash TEXT,path TEXT,size INTEGER);")
        .unwrap();
    c.execute(
        "INSERT INTO blobs VALUES(?1,?2,?3)",
        params![hash, data.len() as i64, format!("{}/{hash}", &hash[..2])],
    )
    .unwrap();
    c.execute(
        "INSERT INTO craft_backup_files VALUES(?1,?2,?3)",
        params![hash, original.to_str().unwrap(), data.len() as i64],
    )
    .unwrap();
    let missing = "a".repeat(64);
    c.execute(
        "INSERT INTO blobs VALUES(?1,4,?2)",
        params![missing, format!("aa/{missing}")],
    )
    .unwrap();
    let summary = backup(
        &fixture.root,
        &fixture.options("original"),
        &cancel(),
        &mut |_| {},
    )
    .unwrap();
    assert!(!summary.complete);
    assert!(summary.warnings.iter().any(|v| v.contains("未找到")));
    assert!(summary
        .dependencies
        .iter()
        .any(|d| d.kind == "externalAttachment" && d.included));
    let target = fixture.base.join("restored");
    restore(Path::new(&summary.path), &target, &cancel(), &mut |_| {}).unwrap();
    assert_eq!(
        fs::read(target.join("blobs-v1").join(&hash[..2]).join(&hash)).unwrap(),
        data
    );
    fixture.finish();
}

#[test]
fn external_vault_changes_abort_publication_and_retains_original_database() {
    let fixture = Fixture::new("source-race");
    let c = fixture.database();
    let vault = fixture.base.join("Vault");
    fs::create_dir(&vault).unwrap();
    let note = vault.join("note.md");
    fs::write(&note, "before").unwrap();
    c.execute(
        "INSERT INTO libraries VALUES('vault','obsidian','Vault',?1)",
        [vault.to_str().unwrap()],
    )
    .unwrap();
    let mut options = fixture.options("race");
    options.include_external_sources = true;
    let error = backup(&fixture.root, &options, &cancel(), &mut |progress| {
        if progress.phase == "verifySources" {
            fs::write(&note, "after!").unwrap();
        }
    })
    .unwrap_err();
    assert!(error.contains("变化"));
    assert!(!Path::new(&options.destination).exists());
    assert_eq!(
        c.query_row("SELECT count(*) FROM documents", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    fixture.finish();
}

#[test]
fn archive_rejects_corruption_truncation_nonempty_restore_and_cancellation() {
    let fixture = Fixture::new("reject");
    let _c = fixture.database();
    let summary = backup(
        &fixture.root,
        &fixture.options("valid"),
        &cancel(),
        &mut |_| {},
    )
    .unwrap();
    let bytes = fs::read(&summary.path).unwrap();
    let bad = fixture.base.join("bad.hubbackup");
    let mut corrupt = bytes.clone();
    let position = corrupt.len() - 1;
    corrupt[position] ^= 1;
    fs::write(&bad, corrupt).unwrap();
    assert!(inspect(&bad, &cancel(), &mut |_| {})
        .unwrap_err()
        .contains("SHA256"));
    fs::write(&bad, &bytes[..bytes.len() - 11]).unwrap();
    assert!(inspect(&bad, &cancel(), &mut |_| {}).is_err());
    let target = fixture.base.join("occupied");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("keep.txt"), "keep").unwrap();
    assert!(restore(Path::new(&summary.path), &target, &cancel(), &mut |_| {}).is_err());
    assert_eq!(fs::read_to_string(target.join("keep.txt")).unwrap(), "keep");
    let cancelled = AtomicBool::new(false);
    let options = fixture.options("cancelled");
    assert!(backup(&fixture.root, &options, &cancelled, &mut |p| {
        if p.phase == "archive" {
            cancelled.store(true, Ordering::Relaxed)
        }
    })
    .is_err());
    assert!(!Path::new(&options.destination).exists());
    fixture.finish();
}

#[test]
fn archive_paths_reject_traversal_ads_windows_devices_and_case_collisions() {
    for path in [
        "../escape",
        "/absolute",
        "C:/absolute",
        "a\\b",
        "a//b",
        "a/./b",
        "a/../b",
        "NUL.txt",
        "a/COM1",
        "a./b",
        "a /b",
        "a:b",
    ] {
        assert!(files::safe_relative(path).is_err(), "{path}");
    }
    assert!(files::safe_relative("external-sources/abc/Vault/中文.md").is_ok());
    let fixture = Fixture::new("path-collision");
    let _c = fixture.database();
    let path = fixture.base.join("payload");
    fs::write(&path, "data").unwrap();
    let inputs = vec![
        files::input(&path, "collection-files/A.md".into(), None).unwrap(),
        files::input(&path, "collection-files/a.md".into(), None).unwrap(),
    ];
    let header = Header {
        version: 1,
        dataset_id: identifier(),
        operation_id: identifier(),
        automatic: false,
        created_at: now(),
        app_version: "test".into(),
        schema_version: 72,
        source_root: fixture.root.to_string_lossy().into(),
        files: 2,
        bytes: 8,
        complete: true,
        dependencies: vec![],
        warnings: vec![],
    };
    assert!(archive::write(
        &fixture.base.join("collision.hubbackup"),
        &header,
        &inputs,
        &cancel(),
        &mut |_| {}
    )
    .unwrap_err()
    .contains("冲突"));
    fixture.finish();
}

#[test]
fn automatic_backup_defaults_off_and_only_retains_verified_owned_same_dataset_files() {
    let fixture = Fixture::new("automatic");
    let _c = fixture.database();
    assert!(!load_auto_config(&fixture.root).unwrap().enabled);
    assert!(run_due(&fixture.root, &cancel(), &mut |_| {})
        .unwrap()
        .is_none());
    let folder = fixture.base.join("backups");
    fs::create_dir(&folder).unwrap();
    let unrelated = folder.join("unrelated.hubbackup");
    fs::write(&unrelated, "user file").unwrap();
    let config = AutoBackupConfig {
        enabled: true,
        destination: folder.to_string_lossy().into(),
        interval_hours: 1,
        keep_count: 1,
        ..Default::default()
    };
    save_auto_config(&fixture.root, &config).unwrap();
    let first = run_due(&fixture.root, &cancel(), &mut |_| {})
        .unwrap()
        .unwrap();
    assert!(run_due(&fixture.root, &cancel(), &mut |_| {})
        .unwrap()
        .is_none());
    let mut due = load_auto_config(&fixture.root).unwrap();
    due.last_attempt_at = Some(now() - 3601);
    files::replace_json(&fixture.root.join(STATE).join("automatic.json"), &due).unwrap();
    let second = run_due(&fixture.root, &cancel(), &mut |_| {})
        .unwrap()
        .unwrap();
    assert!(Path::new(&second.path).exists());
    assert_eq!(fs::read_to_string(&unrelated).unwrap(), "user file");
    #[cfg(windows)]
    assert!(!Path::new(&first.path).exists());
    #[cfg(not(windows))]
    assert!(Path::new(&first.path).exists());
    // An incomplete later file must not displace the latest complete restore point.
    _c.execute(
        "INSERT INTO blobs VALUES(?1,3,?2)",
        params!["b".repeat(64), format!("bb/{}", "b".repeat(64))],
    )
    .unwrap();
    let mut due = load_auto_config(&fixture.root).unwrap();
    due.last_attempt_at = Some(now() - 3601);
    files::replace_json(&fixture.root.join(STATE).join("automatic.json"), &due).unwrap();
    let incomplete = run_due(&fixture.root, &cancel(), &mut |_| {})
        .unwrap()
        .unwrap();
    assert!(!incomplete.complete);
    assert!(Path::new(&second.path).exists());
    assert!(Path::new(&incomplete.path).exists());
    fixture.finish();
}

#[test]
fn published_backup_remains_successful_when_final_run_record_cannot_be_written() {
    let fixture = Fixture::new("published-record-failure");
    let _c = fixture.database();
    let summary = backup(
        &fixture.root,
        &fixture.options("published"),
        &cancel(),
        &mut |p| {
            if p.phase == "verifySources" {
                let runs = fixture.root.join(STATE).join("runs");
                fs::rename(&runs, fixture.root.join(STATE).join("preserved-runs")).unwrap();
                fs::write(&runs, "blocked by synthetic fixture").unwrap();
            }
        },
    )
    .unwrap();
    assert!(Path::new(&summary.path).is_file());
    assert!(summary.warnings.iter().any(|w| w.contains("记录保存失败")));
    assert_eq!(
        inspect(Path::new(&summary.path), &cancel(), &mut |_| {})
            .unwrap()
            .checksum,
        summary.checksum
    );
    fixture.finish();
}

#[test]
fn owned_reading_assets_outside_data_root_are_copied_with_explicit_path_mapping() {
    let fixture = Fixture::new("reading-assets");
    let c = fixture.database();
    let asset = fixture.base.join("reading.jpg");
    fs::write(&asset, b"reading bytes").unwrap();
    c.execute_batch("CREATE TABLE collection_saved_media(item_key TEXT,media_url TEXT,path TEXT);")
        .unwrap();
    c.execute(
        "INSERT INTO collection_saved_media VALUES('item','media',?1)",
        [asset.to_str().unwrap()],
    )
    .unwrap();
    let summary = backup(
        &fixture.root,
        &fixture.options("reading"),
        &cancel(),
        &mut |_| {},
    )
    .unwrap();
    let restored = restore(
        Path::new(&summary.path),
        &fixture.base.join("restored"),
        &cancel(),
        &mut |_| {},
    )
    .unwrap();
    let mapping = restored
        .path_mappings
        .iter()
        .find(|m| m.source_path == asset.to_str().unwrap())
        .unwrap();
    assert_eq!(fs::read(&mapping.restored_path).unwrap(), b"reading bytes");
    assert_eq!(fs::read(&asset).unwrap(), b"reading bytes");
    fixture.finish();
}

#[test]
fn repeated_backup_restore_drops_previous_mapping_receipt_only_from_new_snapshots() {
    let fixture = Fixture::new("repeat-restore");
    let c = fixture.database();
    c.execute(
        "INSERT INTO metadata VALUES('hub_restore_path_mappings_v1','previous-restore')",
        [],
    )
    .unwrap();
    let first = backup(
        &fixture.root,
        &fixture.options("first"),
        &cancel(),
        &mut |_| {},
    )
    .unwrap();
    assert_eq!(
        c.query_row(
            "SELECT value FROM metadata WHERE key='hub_restore_path_mappings_v1'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "previous-restore"
    );
    let restored = fixture.base.join("first-restored");
    restore(Path::new(&first.path), &restored, &cancel(), &mut |_| {}).unwrap();
    let restored_c = Connection::open(restored.join(DATABASE)).unwrap();
    assert_eq!(
        restored_c
            .query_row(
                "SELECT count(*) FROM metadata WHERE key='hub_restore_path_mappings_v1'",
                [],
                |r| r.get::<_, u64>(0)
            )
            .unwrap(),
        0
    );
    // Represent the mapping receipt committed by the portability restore owner.
    restored_c
        .execute(
            "INSERT INTO metadata VALUES('hub_restore_path_mappings_v1','first-restore-mapping')",
            [],
        )
        .unwrap();
    let second = backup(
        &restored,
        &fixture.options("second"),
        &cancel(),
        &mut |_| {},
    )
    .unwrap();
    assert_eq!(
        restored_c
            .query_row(
                "SELECT value FROM metadata WHERE key='hub_restore_path_mappings_v1'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "first-restore-mapping"
    );
    let twice = fixture.base.join("second-restored");
    restore(Path::new(&second.path), &twice, &cancel(), &mut |_| {}).unwrap();
    let twice_c = readonly(&twice.join(DATABASE)).unwrap();
    assert_eq!(
        twice_c
            .query_row(
                "SELECT count(*) FROM metadata WHERE key='hub_restore_path_mappings_v1'",
                [],
                |r| r.get::<_, u64>(0)
            )
            .unwrap(),
        0
    );
    assert_eq!(
        twice_c
            .query_row("SELECT markdown FROM documents WHERE id='doc'", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
        "来自数据库 WAL 的正文"
    );
    assert_eq!(dataset_id(&restored).unwrap(), dataset_id(&twice).unwrap());
    fixture.finish();
}

#[cfg(unix)]
#[test]
fn symbolic_source_and_ancestor_links_are_rejected() {
    let fixture = Fixture::new("links");
    let _c = fixture.database();
    let outside = fixture.base.join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("secret"), b"external").unwrap();
    let link = fixture.root.join("collection-files");
    std::os::unix::fs::symlink(&outside, &link).unwrap();
    assert!(files::reject_links(&link.join("secret")).is_err());
    assert!(backup(
        &fixture.root,
        &fixture.options("link"),
        &cancel(),
        &mut |_| {}
    )
    .is_err());
    fixture.finish();
}

#[test]
fn published_automatic_backup_reports_receipt_failure_and_keeps_previous_copy() {
    let fixture = Fixture::new("receipt-failure");
    let _c = fixture.database();
    let folder = fixture.base.join("backups");
    fs::create_dir(&folder).unwrap();
    save_auto_config(
        &fixture.root,
        &AutoBackupConfig {
            enabled: true,
            destination: folder.to_string_lossy().into(),
            interval_hours: 1,
            keep_count: 1,
            ..Default::default()
        },
    )
    .unwrap();
    let first = run_due(&fixture.root, &cancel(), &mut |_| {})
        .unwrap()
        .unwrap();
    let mut config = load_auto_config(&fixture.root).unwrap();
    config.last_attempt_at = Some(now() - 3601);
    files::replace_json(&fixture.root.join(STATE).join("automatic.json"), &config).unwrap();
    let second = run_due(&fixture.root, &cancel(), &mut |p| {
        if p.phase == "complete" {
            let receipts = fixture.root.join(STATE).join("receipts");
            fs::rename(
                &receipts,
                fixture.root.join(STATE).join("preserved-receipts"),
            )
            .unwrap();
            fs::write(receipts, "synthetic receipt failure").unwrap();
        }
    })
    .unwrap()
    .unwrap();
    assert!(second.warnings.iter().any(|w| w.contains("轮换记录")));
    assert!(Path::new(&first.path).is_file());
    assert!(Path::new(&second.path).is_file());
    assert_eq!(
        inspect(Path::new(&second.path), &cancel(), &mut |_| {})
            .unwrap()
            .checksum,
        second.checksum
    );
    assert_eq!(
        load_auto_config(&fixture.root).unwrap().last_success_at,
        Some(second.created_at)
    );
    fixture.finish();
}

#[test]
fn restored_external_sources_are_complete_in_a_default_second_backup() {
    let fixture = Fixture::new("owned-restored-source");
    let c = fixture.database();
    let vault = fixture.base.join("Vault");
    fs::create_dir(&vault).unwrap();
    fs::write(vault.join("note.md"), "portable source").unwrap();
    c.execute(
        "INSERT INTO libraries VALUES('vault','obsidian','Vault',?1)",
        [vault.to_str().unwrap()],
    )
    .unwrap();
    let mut first_options = fixture.options("first");
    first_options.include_external_sources = true;
    let first = backup(&fixture.root, &first_options, &cancel(), &mut |_| {}).unwrap();
    assert!(first.complete);
    let target = fixture.base.join("restored");
    let restored = restore(Path::new(&first.path), &target, &cancel(), &mut |_| {}).unwrap();
    let mapping = restored
        .path_mappings
        .iter()
        .find(|m| m.id == "vault")
        .unwrap();
    // The portability owner applies these mappings before opening the restored root.
    let restored_c = Connection::open(target.join(DATABASE)).unwrap();
    restored_c
        .execute(
            "UPDATE libraries SET location=?1 WHERE id='vault'",
            [&mapping.restored_path],
        )
        .unwrap();
    let second = backup(
        &target,
        &fixture.options("second-default"),
        &cancel(),
        &mut |_| {},
    )
    .unwrap();
    assert!(second.complete, "{:?}", second.warnings);
    assert!(second
        .dependencies
        .iter()
        .all(|d| d.included && d.archive_path.is_some()));
    let twice = fixture.base.join("restored-twice");
    let result = restore(Path::new(&second.path), &twice, &cancel(), &mut |_| {}).unwrap();
    let vault = result
        .path_mappings
        .iter()
        .find(|m| m.id == "vault")
        .unwrap();
    assert_eq!(
        fs::read_to_string(Path::new(&vault.restored_path).join("note.md")).unwrap(),
        "portable source"
    );
    fixture.finish();
}

#[test]
fn restored_database_rebuilds_search_for_completed_content_and_attachment_only_libraries() {
    use crate::search_index_runtime::{
        flush_index_jobs_budgeted, open_or_create_active_search_index,
    };
    for attachment_only in [false, true] {
        let fixture = Fixture::new(if attachment_only {
            "search-attachment"
        } else {
            "search-content"
        });
        let database = fixture.root.join(DATABASE);
        let mut c = crate::open_database(&database).unwrap();
        c.execute("INSERT INTO spaces(id,name,mcp_url,added_at) VALUES('scope','Scope','https://example.test',1)", []).unwrap();
        c.execute("INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES('scope','craft','Scope',1,1)", []).unwrap();
        let store = crate::blob_store::BlobStore::open(&fixture.root.join("blobs-v1")).unwrap();
        let body = "portablerebuildneedle".to_string();
        crate::persist_document_batch(
            &database,
            &store,
            vec![crate::IndexedDocument {
                space_id: "scope".into(),
                id: "doc".into(),
                title: "Portable document".into(),
                path: "fixture".into(),
                folder_id: None,
                content_hash: format!("{:x}", Sha256::digest(body.as_bytes())),
                markdown: body,
                modified_at: Some(1),
                indexed_at: 1,
                attachments: vec![],
                block_hints: vec![],
            }],
        )
        .unwrap();
        if attachment_only {
            c.execute("DELETE FROM content_items", []).unwrap();
            c.execute("INSERT INTO source_items(id,space_id,document_id,remote_id,source_type,title,status,created_at,updated_at)
                VALUES('attachment','scope','doc','attachment','craft_attachment','portableattachmentneedle.pdf','downloaded',1,1)", []).unwrap();
        }
        let index_root = fixture.root.join("tantivy-generations-v1");
        let empty = open_or_create_active_search_index(&mut c, &index_root).unwrap();
        let source_index = flush_index_jobs_budgeted(
            &database,
            empty.clone(),
            &index_root,
            2,
            Duration::from_secs(30),
        )
        .unwrap()
        .unwrap_or(empty);
        let query = if attachment_only {
            "portableattachmentneedle"
        } else {
            "portablerebuildneedle"
        };
        assert!(!source_index
            .search(query, 10, None, None, None, true, true, true, true)
            .unwrap()
            .is_empty());
        assert_eq!(c.query_row("SELECT COUNT(*) FROM index_jobs WHERE job_type='upsert_lexical' AND status='completed'", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        c.execute("INSERT INTO index_jobs(job_key,space_id,source_id,source_type,job_type,status,created_at,updated_at)
            VALUES('kept-download','scope','attachment','craft_attachment','download_source','completed',1,1)", []).unwrap();
        let summary = backup(
            &fixture.root,
            &fixture.options("search"),
            &cancel(),
            &mut |_| {},
        )
        .unwrap();
        // Preparing the portable copy cannot clear the source generation/jobs.
        assert!(
            c.query_row(
                "SELECT COUNT(*) FROM search_index_generations WHERE status='active'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap()
                > 0
        );
        assert_eq!(
            c.query_row(
                "SELECT status FROM index_jobs WHERE job_type='upsert_lexical'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "completed"
        );
        let target = fixture.base.join("restored");
        restore(Path::new(&summary.path), &target, &cancel(), &mut |_| {}).unwrap();
        assert!(!target.join("tantivy-generations-v1").exists());
        let restored_database = target.join(DATABASE);
        let mut restored_c = crate::open_database(&restored_database).unwrap();
        assert_eq!(
            restored_c
                .query_row("SELECT COUNT(*) FROM search_index_generations", [], |r| r
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
            0
        );
        assert_eq!(
            restored_c
                .query_row(
                    "SELECT status FROM index_jobs WHERE job_key='kept-download'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "completed"
        );
        if attachment_only {
            assert_eq!(
                restored_c
                    .query_row(
                        "SELECT status FROM index_jobs WHERE job_type='upsert_lexical'",
                        [],
                        |r| r.get::<_, String>(0)
                    )
                    .unwrap(),
                "pending"
            );
        }
        let restored_index_root = target.join("tantivy-generations-v1");
        let empty =
            open_or_create_active_search_index(&mut restored_c, &restored_index_root).unwrap();
        let restored_index = flush_index_jobs_budgeted(
            &restored_database,
            empty.clone(),
            &restored_index_root,
            2,
            Duration::from_secs(30),
        )
        .unwrap()
        .unwrap_or(empty);
        let hits = restored_index
            .search(query, 10, None, None, None, true, true, true, true)
            .unwrap();
        assert!(
            hits.iter().any(|hit| hit.document_id == "doc"),
            "{attachment_only}"
        );
        drop(restored_index);
        drop(source_index);
        drop(restored_c);
        drop(c);
        drop(store);
        crate::forget_initialized_database(&database);
        crate::forget_initialized_database(&restored_database);
        fixture.finish();
    }
}

#[test]
fn usage_walk_tolerates_queued_directory_changes_but_strict_backup_walk_fails() {
    for strict in [false, true] {
        for replace_with_file in [false, true] {
            let fixture = Fixture::new("usage-directory-race");
            let scan = fixture.base.join("scan");
            fs::create_dir(&scan).unwrap();
            for name in ["cache-a", "cache-b"] {
                let directory = scan.join(name);
                fs::create_dir(&directory).unwrap();
                fs::write(directory.join("entry"), b"cache bytes").unwrap();
            }
            let preserved = fixture.base.join("preserved-cache");
            let mut changed = None;
            let mut counted = 0usize;
            let mut warnings = Vec::new();
            let result = files::walk(
                &scan,
                &scan,
                &mut |path, _| {
                    counted += 1;
                    if changed.is_none() {
                        // The root contains only directories, so the complete
                        // root enumeration has queued both before any callback.
                        // Whichever child is visited first, invalidate the other.
                        let first = path
                            .strip_prefix(&scan)
                            .unwrap()
                            .components()
                            .next()
                            .unwrap();
                        let other = if first.as_os_str() == "cache-a" {
                            "cache-b"
                        } else {
                            "cache-a"
                        };
                        let queued = scan.join(other);
                        fs::rename(&queued, &preserved).unwrap();
                        if replace_with_file {
                            fs::write(&queued, b"now a file").unwrap();
                        }
                        changed = Some(queued);
                    }
                    Ok(())
                },
                &mut warnings,
                &cancel(),
                strict,
            );
            assert_eq!(counted, 1);
            assert_eq!(fs::read(preserved.join("entry")).unwrap(), b"cache bytes");
            if strict {
                assert!(result.is_err());
            } else {
                result.unwrap();
                let changed = changed.unwrap();
                assert!(warnings
                    .iter()
                    .any(|w| w.contains(changed.to_str().unwrap())));
            }
            fixture.finish();
        }
    }
}

#[test]
fn usage_walk_keeps_root_and_callback_failures_fatal() {
    let fixture = Fixture::new("usage-fatal-errors");
    let missing = fixture.base.join("missing-root");
    assert!(files::walk(
        &missing,
        &missing,
        &mut |_, _| Ok(()),
        &mut Vec::new(),
        &cancel(),
        false
    )
    .is_err());
    assert!(usage(&missing).is_err());
    let scan = fixture.base.join("scan");
    fs::create_dir(&scan).unwrap();
    fs::write(scan.join("entry"), b"data").unwrap();
    let error = files::walk(
        &scan,
        &scan,
        &mut |_, _| Err("callback failure".into()),
        &mut Vec::new(),
        &cancel(),
        false,
    )
    .unwrap_err();
    assert_eq!(error, "callback failure");
    fixture.finish();
}

#[test]
fn single_folder_copy_keeps_craft_originals_profile_and_encrypted_accounts_but_not_obsidian_sources(
) {
    let fixture = Fixture::new("single-folder-copy");
    let database = fixture.root.join(DATABASE);
    let c = crate::open_database(&database).unwrap();
    c.execute("INSERT INTO spaces(id,name,mcp_url,added_at) VALUES('scope','Scope','https://example.test',1)",[]).unwrap();
    c.execute("INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES('scope','craft','Scope',1,1)",[]).unwrap();
    let external = fixture.base.join("original-craft");
    fs::create_dir(&external).unwrap();
    let archive = external.join("xv - Craft - 备份");
    fs::create_dir(&archive).unwrap();
    fs::write(archive.join("original.bin"), b"craft original bytes").unwrap();
    let obsidian = fixture.base.join("personal-obsidian");
    fs::create_dir(&obsidian).unwrap();
    fs::write(obsidian.join("note.md"), "independent user vault").unwrap();
    c.execute("INSERT INTO libraries(id,provider,name,enabled,location,added_at) VALUES('vault','obsidian','Vault',1,?1,1)",[obsidian.to_str().unwrap()]).unwrap();
    let config = crate::craft_backup::BackupConfig {
        library_id: "scope".into(),
        destination: external.to_string_lossy().into(),
        vault_name: "xv - Craft".into(),
        interval_minutes: 1440,
        replica_destination: None,
        last_attempt_at: 0,
        last_success_at: None,
        last_error: None,
    };
    c.execute(
        "INSERT INTO metadata(key,value) VALUES('craft_backup_config:scope',?1)",
        [serde_json::to_string(&config).unwrap()],
    )
    .unwrap();
    c.execute(
        "INSERT INTO metadata(key,value) VALUES('hub_data_root',?1)",
        [crate::sources::display_local_path(&fixture.root)],
    )
    .unwrap();
    c.execute(
        "INSERT INTO user_profile_values(key,value) VALUES('hub.synthetic-copy','preserved')",
        [],
    )
    .unwrap();
    fs::write(
        fixture.root.join(crate::account_migration::FILE),
        b"HUBAUTH1 opaque encrypted synthetic bytes",
    )
    .unwrap();
    let prepared = consolidate(&fixture.root, &cancel(), &mut |_| {}).unwrap();
    assert_eq!(prepared["ready"], true);
    assert_eq!(prepared["obsidianOriginalsIncluded"], false);
    assert!(archive.join("original.bin").is_file());
    assert!(obsidian.join("note.md").is_file());
    let config_raw: String = c
        .query_row(
            "SELECT value FROM metadata WHERE key='craft_backup_config:scope'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let managed: crate::craft_backup::BackupConfig = serde_json::from_str(&config_raw).unwrap();
    assert!(Path::new(&managed.destination)
        .canonicalize()
        .unwrap()
        .starts_with(&fixture.root));
    drop(c);
    let copied = fixture.base.join("another-computer");
    fs::create_dir(&copied).unwrap();
    crate::copy_storage_tree(&fixture.root, &copied).unwrap();
    assert!(external.starts_with(&fixture.base));
    fs::rename(&external, fixture.base.join("retained-original-craft")).unwrap();
    crate::data_portability::prepare_opened_root(&copied, true).unwrap();
    let copied_db = copied.join(DATABASE);
    let restored = crate::open_database(&copied_db).unwrap();
    let raw: String = restored
        .query_row(
            "SELECT value FROM metadata WHERE key='craft_backup_config:scope'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let relocated: crate::craft_backup::BackupConfig = serde_json::from_str(&raw).unwrap();
    assert!(Path::new(&relocated.destination)
        .canonicalize()
        .unwrap()
        .starts_with(&copied));
    assert_eq!(
        fs::read(Path::new(&relocated.destination).join("xv - Craft - 备份/original.bin")).unwrap(),
        b"craft original bytes"
    );
    assert_eq!(
        restored
            .query_row(
                "SELECT value FROM user_profile_values WHERE key='hub.synthetic-copy'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "preserved"
    );
    assert_eq!(
        fs::read(copied.join(crate::account_migration::FILE)).unwrap(),
        b"HUBAUTH1 opaque encrypted synthetic bytes"
    );
    assert!(!copied.join("personal-obsidian").exists());
    drop(restored);
    crate::forget_initialized_database(&database);
    crate::forget_initialized_database(&copied_db);
    fixture.finish();
}

#[test]
fn changing_storage_collects_originals_on_target_without_growing_the_old_root() {
    let fixture = Fixture::new("move-consolidates-on-target");
    let database = fixture.root.join(DATABASE);
    let c = crate::open_database(&database).unwrap();
    c.execute("INSERT INTO spaces(id,name,mcp_url,added_at) VALUES('scope','Scope','https://example.test',1)",[]).unwrap();
    c.execute("INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES('scope','craft','Scope',1,1)",[]).unwrap();
    let external = fixture.base.join("external-originals");
    fs::create_dir(&external).unwrap();
    let archive = external.join("xv - Craft - 备份");
    fs::create_dir(&archive).unwrap();
    fs::write(archive.join("original.bin"), b"original on another disk").unwrap();
    let config = crate::craft_backup::BackupConfig {
        library_id: "scope".into(),
        destination: external.to_string_lossy().into(),
        vault_name: "xv - Craft".into(),
        interval_minutes: 1440,
        replica_destination: None,
        last_attempt_at: 0,
        last_success_at: None,
        last_error: None,
    };
    c.execute(
        "INSERT INTO metadata(key,value) VALUES('craft_backup_config:scope',?1)",
        [serde_json::to_string(&config).unwrap()],
    )
    .unwrap();
    c.execute(
        "INSERT INTO metadata(key,value) VALUES('hub_data_root',?1)",
        [crate::sources::display_local_path(&fixture.root)],
    )
    .unwrap();
    drop(c);
    let target = fixture.base.join("new-disk-data");
    fs::create_dir(&target).unwrap();
    crate::copy_storage_tree(&fixture.root, &target).unwrap();
    let moved = crate::data_portability::finish_storage_move(&fixture.root, &target).unwrap();
    assert_eq!(moved["ready"], true);
    assert!(!fixture.root.join("external-sources").exists());
    assert!(!fixture.root.join(STATE).exists());
    assert!(target.join("external-sources").is_dir());
    let target_database = target.join(DATABASE);
    let restored = crate::open_database(&target_database).unwrap();
    let raw: String = restored
        .query_row(
            "SELECT value FROM metadata WHERE key='craft_backup_config:scope'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let config: crate::craft_backup::BackupConfig = serde_json::from_str(&raw).unwrap();
    assert!(Path::new(&config.destination)
        .canonicalize()
        .unwrap()
        .starts_with(&target));
    assert_eq!(
        fs::read(Path::new(&config.destination).join("xv - Craft - 备份/original.bin")).unwrap(),
        b"original on another disk"
    );
    assert!(archive.join("original.bin").is_file());
    drop(restored);
    crate::forget_initialized_database(&database);
    crate::forget_initialized_database(&target_database);
    fixture.finish();
}

#[test]
fn consolidation_reuses_a_previously_materialized_reading_asset() {
    let fixture = Fixture::new("reuse-prepared-reading-asset");
    let database = fixture.root.join(DATABASE);
    let c = crate::open_database(&database).unwrap();
    let external = fixture.base.join("saved-image.png");
    let bytes = b"verified existing reading attachment";
    fs::write(&external, bytes).unwrap();
    let hash = format!("{:x}", Sha256::digest(bytes));
    let local = fixture
        .root
        .join("collection-files/recovered-assets")
        .join(&hash)
        .join("saved-image.png");
    fs::create_dir_all(local.parent().unwrap()).unwrap();
    fs::write(&local, bytes).unwrap();
    c.execute(
        "INSERT INTO collection_owned_assets(item_key,path) VALUES('item',?1)",
        [external.to_str().unwrap()],
    )
    .unwrap();
    let result = consolidate(&fixture.root, &cancel(), &mut |_| {}).unwrap();
    assert_eq!(result["ready"], true);
    assert_eq!(result["copiedFiles"], 0);
    let path: String = c
        .query_row(
            "SELECT path FROM collection_owned_assets WHERE item_key='item'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        fs::canonicalize(path).unwrap(),
        fs::canonicalize(&local).unwrap()
    );
    assert_eq!(fs::read(&external).unwrap(), bytes);
    drop(c);
    crate::forget_initialized_database(&database);
    fixture.finish();
}

#[cfg(windows)]
#[test]
fn consolidation_merges_windows_aliases_without_losing_owned_asset_associations() {
    let fixture = Fixture::new("reading-asset-windows-aliases");
    let database = fixture.root.join(DATABASE);
    let c = crate::open_database(&database).unwrap();
    let external = fixture.base.join("owned.png");
    let bytes = b"one original with two Windows path spellings";
    fs::write(&external, bytes).unwrap();
    let canonical = fs::canonicalize(&external).unwrap();
    let display = crate::sources::display_local_path(&canonical);
    assert_ne!(canonical.to_string_lossy(), display);
    for path in [canonical.to_string_lossy().into_owned(), display] {
        c.execute(
            "INSERT INTO collection_owned_assets(item_key,path) VALUES('first',?1)",
            [&path],
        )
        .unwrap();
        c.execute(
            "INSERT INTO collection_owned_assets(item_key,path) VALUES('second',?1)",
            [&path],
        )
        .unwrap();
    }
    let result = consolidate(&fixture.root, &cancel(), &mut |_| {}).unwrap();
    assert_eq!(result["ready"], true);
    assert_eq!(result["copiedFiles"], 1);
    let rows: Vec<(String, String)> = c
        .prepare("SELECT item_key,path FROM collection_owned_assets ORDER BY item_key")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].0, "first");
    assert_eq!(rows[1].0, "second");
    assert_eq!(rows[0].1, rows[1].1);
    assert!(Path::new(&rows[0].1)
        .canonicalize()
        .unwrap()
        .starts_with(&fixture.root));
    assert_eq!(fs::read(&rows[0].1).unwrap(), bytes);
    assert_eq!(fs::read(&external).unwrap(), bytes);
    drop(c);
    crate::forget_initialized_database(&database);
    fixture.finish();
}

#[test]
fn consolidation_reports_current_craft_and_dida_attachments_without_local_copies() {
    let fixture = Fixture::new("offline-attachment-coverage");
    let database = fixture.root.join(DATABASE);
    let c = crate::open_database(&database).unwrap();
    for (id, provider, kind) in [
        ("craft", "craft", "craft_attachment"),
        ("dida", "dida365", "dida_attachment"),
        ("vault", "obsidian", "obsidian_attachment"),
    ] {
        c.execute(
            "INSERT INTO spaces(id,name,mcp_url,added_at) VALUES(?1,?1,'https://example.test',1)",
            [id],
        )
        .unwrap();
        c.execute(
            "INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES(?1,?2,?1,1,1)",
            params![id, provider],
        )
        .unwrap();
        c.execute("INSERT INTO documents(space_id,id,title,path,markdown,provider,indexed_at,content_hash) VALUES(?1,'doc','Saved','','saved local text',?2,1,'saved-text')",params![id,provider]).unwrap();
        c.execute("INSERT INTO source_items(id,space_id,document_id,remote_id,source_type,title,status,provider,created_at,updated_at) VALUES(?1,?1,'doc','remote',?2,'missing attachment','deferred',?3,1,1)",params![id,kind,provider]).unwrap();
    }
    let result = consolidate(&fixture.root, &cancel(), &mut |_| {}).unwrap();
    assert_eq!(result["ready"], false);
    let warnings = result["warnings"].as_array().unwrap();
    assert!(warnings
        .iter()
        .any(|w| w.as_str().unwrap().contains("Craft 尚有 1")));
    assert!(warnings
        .iter()
        .any(|w| w.as_str().unwrap().contains("滴答清单 尚有 1")));
    assert!(!warnings
        .iter()
        .any(|w| w.as_str().unwrap().contains("Obsidian")));
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM documents WHERE markdown='saved local text'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        3
    );
    drop(c);
    crate::forget_initialized_database(&database);
    fixture.finish();
}
