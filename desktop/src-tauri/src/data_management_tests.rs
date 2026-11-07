use super::*;
use rusqlite::params;

struct Fixture {
    root: PathBuf,
    old_id: String,
    active_id: String,
    relative: String,
    kept: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let base = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("task-state/data-management-20261016/test-fixtures");
        fs::create_dir_all(&base).unwrap();
        let root = base.join(format!("cleanup-{}", crate::random_url_safe(12)));
        fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let old_id = "1".repeat(32);
        let active_id = "2".repeat(32);
        let relative =
            format!("external-sources/prepared-{old_id}/archive/Archive - 备份/objects/shared.bin");
        let active = root.join(format!("external-sources/prepared-{active_id}/archive"));
        let kept = active.join("Archive - 备份/objects/shared.bin");
        fs::create_dir_all(kept.parent().unwrap()).unwrap();
        fs::write(&kept, b"kept original").unwrap();
        let old = root.join(&relative);
        fs::create_dir_all(old.parent().unwrap()).unwrap();
        fs::write(&old, b"kept original").unwrap();
        fs::write(
            root.join(format!(
                "external-sources/prepared-{old_id}/unique.running.json"
            )),
            vec![b'u'; 722],
        )
        .unwrap();
        let c = crate::open_database(&root.join("craft-search.sqlite3")).unwrap();
        crate::craft_backup_resources::schema(&c).unwrap();
        crate::reading_sync::schema(&c).unwrap();
        let config = crate::craft_backup::BackupConfig {
            library_id: "craft".into(),
            destination: active.to_string_lossy().into(),
            vault_name: "Archive".into(),
            interval_minutes: 60,
            replica_destination: None,
            last_attempt_at: 0,
            last_success_at: None,
            last_error: None,
        };
        c.execute(
            "INSERT INTO metadata(key,value) VALUES('craft_backup_config:craft',?1)",
            [serde_json::to_string(&config).unwrap()],
        )
        .unwrap();
        drop(c);
        let fixture = Self {
            root,
            old_id,
            active_id,
            relative,
            kept,
        };
        fixture.write_manifest("failed", true);
        fixture
    }
    fn write_manifest(&self, phase: &str, created: bool) {
        let path = self.root.join(&self.relative);
        let manifest = Manifest {
            version: 1,
            producer: "hub-consolidation-v1".into(),
            id: self.old_id.clone(),
            phase: phase.into(),
            created_at: 1,
            updated_at: 2,
            files: vec![ManifestFile {
                relative_path: self.relative.clone(),
                bytes: fs::metadata(&path).unwrap().len(),
                sha256: hash(&path, &AtomicBool::new(false)).unwrap(),
                anchor_id: Some("craft_backup_config:craft".into()),
                anchor_suffix: Some("objects/shared.bin".into()),
                created_by_run: created,
            }],
        };
        write_json(&self.manifest_path(), &manifest).unwrap();
    }
    fn manifest_path(&self) -> PathBuf {
        self.root.join(format!("{MANIFESTS}/{}.json", self.old_id))
    }
    fn scan(&self) -> (Plan, Value) {
        scan(&self.root, &AtomicBool::new(false)).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if std::thread::panicking() {
            return;
        }
        crate::database::forget_initialized_database(&self.root.join("craft-search.sqlite3"));
        let base = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("task-state/data-management-20261016/test-fixtures")
            .canonicalize()
            .unwrap();
        assert_eq!(self.root.parent(), Some(base.as_path()));
        fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn cleanup_preview_proves_duplicate_and_keeps_unique_active_and_unmanifested_files() {
    let fixture = Fixture::new();
    let (plan, preview) = fixture.scan();
    assert_eq!(plan.files.len(), 1);
    assert_eq!(preview["files"], 1);
    assert_eq!(preview["candidates"][0]["logicalBytes"], 13);
    let retained = preview["retained"].as_array().unwrap();
    assert!(retained
        .iter()
        .any(|v| v["id"] == fixture.old_id && v["logicalBytes"] == 722));
    assert!(retained.iter().any(|v| v["id"] == fixture.active_id));
    fs::remove_file(fixture.manifest_path()).unwrap();
    assert!(fixture.scan().0.files.is_empty());
    fixture.write_manifest("running", true);
    assert!(fixture.scan().0.files.is_empty());
    fixture.write_manifest("cancelled", false);
    assert!(fixture.scan().0.files.is_empty());
    fixture.write_manifest("complete", true);
    fs::write(&fixture.kept, b"other content").unwrap();
    assert!(fixture.scan().0.files.is_empty());
}

#[test]
fn every_formal_path_reference_prevents_recovery_copy_cleanup() {
    let fixture = Fixture::new();
    let path = fixture
        .root
        .join(&fixture.relative)
        .to_string_lossy()
        .into_owned();
    let c = crate::open_database(&fixture.root.join("craft-search.sqlite3")).unwrap();
    for (insert,delete) in [
        ("INSERT INTO libraries(id,provider,name,location,enabled,added_at) VALUES('guard','obsidian','Guard',?1,1,1)","DELETE FROM libraries WHERE id='guard'"),
        ("INSERT INTO collection_roots(destination,root) VALUES('guard',?1)","DELETE FROM collection_roots WHERE destination='guard'"),
        ("INSERT INTO collection_owned_assets(item_key,path) VALUES('guard',?1)","DELETE FROM collection_owned_assets WHERE item_key='guard'"),
        ("INSERT INTO collection_saved_media(item_key,media_url,path) VALUES('guard','url',?1)","DELETE FROM collection_saved_media WHERE item_key='guard'"),
        ("INSERT INTO reading_media_outbox(namespace,id,body,path) VALUES('guard','id',X'00',?1)","DELETE FROM reading_media_outbox WHERE namespace='guard'"),
        ("INSERT INTO craft_backup_files(hash,path,size,mtime,mime_type) VALUES('guard',?1,13,'1','application/octet-stream')","DELETE FROM craft_backup_files WHERE hash='guard'"),
    ] {
        c.execute(insert,[&path]).unwrap();assert!(fixture.scan().0.files.is_empty(),"{insert}");c.execute(delete,[]).unwrap();
    }
    c.execute("INSERT INTO metadata(key,value) VALUES('collection_storage_v1',?1)",[json!({"mode":"obsidian","vaultPath":fixture.root.join(format!("external-sources/prepared-{}",fixture.old_id))}).to_string()]).unwrap();
    assert!(fixture.scan().0.files.is_empty());
    c.execute(
        "UPDATE metadata SET value=?1 WHERE key='collection_storage_v1'",
        [json!({"mode":"obsidian","vaultPath":123}).to_string()],
    )
    .unwrap();
    assert!(scan(&fixture.root, &AtomicBool::new(false)).is_err());
    c.execute("DELETE FROM metadata WHERE key='collection_storage_v1'", [])
        .unwrap();
    let raw: String = c
        .query_row(
            "SELECT value FROM metadata WHERE key='craft_backup_config:craft'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let mut cfg: crate::craft_backup::BackupConfig = serde_json::from_str(&raw).unwrap();
    cfg.replica_destination = Some(
        fixture
            .root
            .join(format!(
                "external-sources/prepared-{}/archive",
                fixture.old_id
            ))
            .to_string_lossy()
            .into(),
    );
    c.execute(
        "UPDATE metadata SET value=?1 WHERE key='craft_backup_config:craft'",
        [serde_json::to_string(&cfg).unwrap()],
    )
    .unwrap();
    assert!(fixture.scan().0.files.is_empty());
}

#[test]
fn cleanup_plan_revalidates_manifest_reference_and_file_identity() {
    let fixture = Fixture::new();
    let (plan, _) = fixture.scan();
    let cancel = AtomicBool::new(false);
    validate_plan(&fixture.root, &plan, &cancel).unwrap();
    let mut tampered = plan.clone();
    tampered.files[0].path = "collection-files/business.bin".into();
    assert!(validate_plan(&fixture.root, &tampered, &cancel).is_err());
    let mut tampered = plan.clone();
    tampered.files[0].keeper = tampered.files[0].path.clone();
    assert!(validate_plan(&fixture.root, &tampered, &cancel).is_err());
    fs::write(fixture.root.join(&fixture.relative), b"newer version").unwrap();
    assert!(validate_plan(&fixture.root, &plan, &cancel).is_err());
    fs::write(fixture.root.join(&fixture.relative), b"kept original").unwrap();
    fixture.write_manifest("running", true);
    assert!(validate_plan(&fixture.root, &plan, &cancel).is_err());
}

#[cfg(windows)]
#[test]
fn scheduled_cleanup_uses_offline_proof_and_preserves_unique_file_and_current_source() {
    let fixture = Fixture::new();
    let preview = preview_cleanup(&fixture.root, &AtomicBool::new(false)).unwrap();
    let scheduled = schedule_cleanup(&fixture.root, preview["token"].as_str().unwrap()).unwrap();
    assert_eq!(scheduled.phase, "requested");
    assert!(fixture.root.join(&fixture.relative).is_file());
    let done = process_pending(&fixture.root).unwrap().unwrap();
    assert_eq!(done.phase, "complete");
    assert_eq!(done.deleted_files, 1);
    assert_eq!(done.deleted_logical_bytes, 13);
    assert!(!fixture.root.join(&fixture.relative).exists());
    assert!(fixture.kept.is_file());
    assert!(fixture
        .root
        .join(format!(
            "external-sources/prepared-{}/unique.running.json",
            fixture.old_id
        ))
        .is_file());
    assert_eq!(
        process_pending(&fixture.root)
            .unwrap()
            .unwrap()
            .deleted_files,
        1
    );
}

#[cfg(windows)]
#[test]
fn scheduled_cleanup_stops_for_new_reference_and_can_be_cancelled_before_start() {
    let fixture = Fixture::new();
    let preview = preview_cleanup(&fixture.root, &AtomicBool::new(false)).unwrap();
    schedule_cleanup(&fixture.root, preview["token"].as_str().unwrap()).unwrap();
    assert_eq!(cancel_cleanup(&fixture.root).unwrap().phase, "cancelled");
    assert!(fixture.root.join(&fixture.relative).exists());
    let preview = preview_cleanup(&fixture.root, &AtomicBool::new(false)).unwrap();
    schedule_cleanup(&fixture.root, preview["token"].as_str().unwrap()).unwrap();
    let c = crate::open_database(&fixture.root.join("craft-search.sqlite3")).unwrap();
    c.execute(
        "INSERT INTO collection_owned_assets(item_key,path) VALUES('new',?1)",
        params![fixture.root.join(&fixture.relative).to_string_lossy()],
    )
    .unwrap();
    drop(c);
    let done = process_pending(&fixture.root).unwrap().unwrap();
    assert_eq!(done.phase, "failed");
    assert_eq!(done.deleted_files, 0);
    assert!(fixture.root.join(&fixture.relative).is_file());
}

#[test]
fn failed_history_write_never_publishes_a_cleanup_request() {
    let fixture = Fixture::new();
    let status = CleanupStatus {
        id: "a".repeat(32),
        phase: "requested".into(),
        error: String::new(),
        planned_files: 1,
        planned_logical_bytes: 13,
        deleted_files: 0,
        deleted_logical_bytes: 0,
        retained_files: 1,
        updated_at: now(),
    };
    fs::create_dir_all(
        fixture
            .root
            .join(format!("{DIRECTORY}/{}-result.json", status.id)),
    )
    .unwrap();
    assert!(save_status(&fixture.root, &status).is_err());
    assert!(cleanup_status(&fixture.root).unwrap().is_none());
    assert!(fixture.root.join(&fixture.relative).is_file());
}

#[cfg(windows)]
#[test]
fn stale_preview_cannot_schedule_and_interrupted_cleanup_recounts_without_claiming_unconfirmed_deletion(
) {
    let fixture = Fixture::new();
    let preview = preview_cleanup(&fixture.root, &AtomicBool::new(false)).unwrap();
    fs::write(fixture.root.join(&fixture.relative), b"newer version").unwrap();
    assert!(schedule_cleanup(&fixture.root, preview["token"].as_str().unwrap()).is_err());
    assert!(cleanup_status(&fixture.root).unwrap().is_none());
    fs::write(fixture.root.join(&fixture.relative), b"kept original").unwrap();
    let preview = preview_cleanup(&fixture.root, &AtomicBool::new(false)).unwrap();
    let mut scheduled =
        schedule_cleanup(&fixture.root, preview["token"].as_str().unwrap()).unwrap();
    scheduled.phase = "running".into();
    save_status(&fixture.root, &scheduled).unwrap();
    // Simulate the crash window after unlink and before the completion count.
    fs::remove_file(fixture.root.join(&fixture.relative)).unwrap();
    let done = process_pending(&fixture.root).unwrap().unwrap();
    assert_eq!(done.phase, "partial");
    assert_eq!(done.deleted_files, 0);
    assert_eq!(done.deleted_logical_bytes, 0);
    assert_eq!(done.retained_files, 0);
    assert!(done.error.contains("1 个文件已不存在但未确认"));
    assert!(fixture.kept.is_file());
}
