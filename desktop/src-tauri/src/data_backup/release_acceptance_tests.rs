//! Explicit real-data acceptance, excluded from ordinary runs and production.
use super::*;
use crate::database::{open_database, DATABASE_SCHEMA_VERSION};
use rusqlite::types::ValueRef;
use serde_json::json;

fn table_identity(c: &Connection, table: &str) -> (usize, String) {
    assert!(table.chars().all(|v| v.is_ascii_alphanumeric() || v == '_'));
    query_identity(c, &format!("SELECT * FROM \"{table}\""))
}
fn query_identity(c: &Connection, query: &str) -> (usize, String) {
    let mut q = c.prepare(query).unwrap();
    let columns = q.column_count();
    let mut rows = q.query([]).unwrap();
    let mut hashes = Vec::new();
    while let Some(row) = rows.next().unwrap() {
        let mut hash = Sha256::new();
        for column in 0..columns {
            let data = match row.get_ref(column).unwrap() {
                ValueRef::Null => vec![0],
                ValueRef::Integer(v) => [vec![1], v.to_le_bytes().to_vec()].concat(),
                ValueRef::Real(v) => [vec![2], v.to_le_bytes().to_vec()].concat(),
                ValueRef::Text(v) => [vec![3], v.to_vec()].concat(),
                ValueRef::Blob(v) => [vec![4], v.to_vec()].concat(),
            };
            hash.update((data.len() as u64).to_le_bytes());
            hash.update(data);
        }
        hashes.push(hash.finalize().to_vec());
    }
    hashes.sort();
    let mut hash = Sha256::new();
    for row in &hashes {
        hash.update(row);
    }
    (hashes.len(), format!("{:x}", hash.finalize()))
}
fn authorized(action: &str, authorization: &str) -> (PathBuf, PathBuf) {
    assert_eq!(
        std::env::var("HUB_RELEASE_BACKUP_CONFIRM").as_deref(),
        Ok(action)
    );
    let source = PathBuf::from(std::env::var_os("HUB_RELEASE_DATA_ROOT").unwrap())
        .canonicalize()
        .unwrap();
    let output = PathBuf::from(std::env::var_os("HUB_RELEASE_EVIDENCE_ROOT").unwrap())
        .canonicalize()
        .unwrap();
    assert!(!output.starts_with(&source) && !source.starts_with(&output));
    let approval: serde_json::Value =
        serde_json::from_slice(&fs::read(output.join(authorization)).unwrap()).unwrap();
    assert_eq!(approval["userAuthorizedRealData"], true);
    (source, output)
}
fn expected_snapshot(
    source: &Path,
    output: &Path,
    name: &str,
) -> (String, std::collections::BTreeMap<String, (usize, String)>) {
    let original = readonly(&source.join(DATABASE)).unwrap();
    // Attachment-only queue reconstruction has its own timestamp contract/tests.
    assert!(
        original
            .query_row("SELECT COUNT(*) FROM content_items", [], |r| r
                .get::<_, i64>(0))
            .unwrap()
            > 0
    );
    let schema = schema_version(&original).unwrap().to_string();
    drop(original);
    let expected = output.join(name);
    assert!(!expected.exists());
    // Use the real portability owner, including intentional derived-index and
    // prior restore-marker normalization, without changing the original data.
    snapshot(&source.join(DATABASE), &expected, &AtomicBool::new(false)).unwrap();
    let c = readonly(&expected).unwrap();
    let tables=c.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").unwrap()
        .query_map([],|r|r.get::<_,String>(0)).unwrap().collect::<Result<Vec<_>,_>>().unwrap();
    let before = tables
        .iter()
        .map(|t| (t.clone(), table_identity(&c, t)))
        .collect();
    (schema, before)
}
fn verify_and_upgrade(source: &Path, output: &Path, expected_name: &str, result: RestoreResult) {
    let restored = output
        .join("restore-and-upgrade-copy")
        .canonicalize()
        .unwrap();
    assert_eq!(
        PathBuf::from(&result.destination).canonicalize().unwrap(),
        restored
    );
    assert_eq!(
        PathBuf::from(&result.backup.path).canonicalize().unwrap(),
        output
            .join("before-upgrade.hubbackup")
            .canonicalize()
            .unwrap()
    );
    assert_eq!(
        fs::metadata(&result.backup.path).unwrap().len(),
        result.backup.archive_bytes
    );
    assert!(result.backup.complete);
    let (schema, before) = expected_snapshot(source, output, expected_name);
    assert_eq!(schema, result.backup.schema_version.to_string());
    let copy = readonly(&restored.join(DATABASE)).unwrap();
    for (table, expected) in &before {
        assert_eq!(
            &table_identity(&copy, table),
            expected,
            "restored table differs: {table}"
        );
    }
    drop(copy);
    let migrated = open_database(&restored.join(DATABASE)).unwrap();
    let current = migrated
        .query_row(
            "SELECT value FROM metadata WHERE key='schema_version'",
            [],
            |r| r.get::<_, String>(0),
        )
        .unwrap();
    assert_eq!(current, DATABASE_SCHEMA_VERSION.to_string());
    let protected = before
        .keys()
        .filter(|t| {
            t.starts_with("flashcard")
                || t.starts_with("tag_")
                || t.ends_with("_tags")
                || matches!(
                    t.as_str(),
                    "collection_library_jobs" | "collection_remote_copies"
                )
        })
        .collect::<Vec<_>>();
    for table in &protected {
        // Additive migrations may append columns. Compare every original
        // business field by name, rather than hashing the new schema as old data.
        let expected = readonly(&output.join(expected_name)).unwrap();
        let columns = expected
            .prepare(&format!("PRAGMA table_info(\"{table}\")"))
            .unwrap()
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(columns
            .iter()
            .all(|n| n.chars().all(|v| v.is_ascii_alphanumeric() || v == '_')));
        let projection = columns
            .iter()
            .map(|n| format!("\"{n}\""))
            .collect::<Vec<_>>()
            .join(",");
        assert_eq!(
            &query_identity(&migrated, &format!("SELECT {projection} FROM \"{table}\"")),
            &before[*table],
            "migration changed protected business data: {table}"
        );
    }
    assert_eq!(
        migrated
            .query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    drop(migrated);
    let original = readonly(&source.join(DATABASE)).unwrap();
    assert_eq!(schema_version(&original).unwrap().to_string(), schema);
    let receipt = json!({"sourceSchema":schema,"copySchema":current,"sourceNotMigrated":true,"restoredTablesMatched":before.len(),
        "expectedNormalizationOwner":"data_backup::snapshot / prepare_snapshot; physical search generations and prior restore mapping are intentionally nonportable",
        "protectedMigrationTables":protected,"backupBytes":result.backup.archive_bytes,"backupFiles":result.backup.files,"backupComplete":result.backup.complete,
        "backupWarnings":result.backup.warnings.len(),"excludedDependencies":result.backup.dependencies.iter().filter(|d|!d.included).count(),
        "restoredRoot":restored,"integrity":"ok","countsAndHashes":before});
    assert!(!output.join("backup-restore-upgrade.json").exists());
    fs::write(
        output.join("backup-restore-upgrade.json"),
        serde_json::to_vec_pretty(&receipt).unwrap(),
    )
    .unwrap();
    println!("all portable tables, protected business data and copy-only upgrade verified");
}
#[test]
#[ignore = "requires explicit real-data backup and copy-only migration authorization"]
fn live_backup_restore_and_upgrade_real_data_copy() {
    let (source, output) = authorized("backup-and-upgrade-copy-only", "release-authorization.json");
    let backup = output.join("before-upgrade.hubbackup");
    let restored = output.join("restore-and-upgrade-copy");
    assert!(!backup.exists() && !restored.exists());
    let cancel = AtomicBool::new(false);
    super::backup(
        &source,
        &BackupOptions {
            destination: backup.to_string_lossy().into(),
            include_external_sources: false,
        },
        &cancel,
        &mut |_| {},
    )
    .unwrap();
    inspect(&backup, &cancel, &mut |_| {}).unwrap();
    let result = restore(&backup, &restored, &cancel, &mut |_| {}).unwrap();
    verify_and_upgrade(&source, &output, "expected-fresh-snapshot.sqlite3", result);
}
#[test]
#[ignore = "requires explicit authorization to verify an already restored real-data copy"]
fn live_verify_existing_restored_data_and_upgrade_copy() {
    let (source, output) = authorized("verify-restored-copy-only", "resume-authorization.json");
    // Resume comparison and upgrade only. The successful original restore
    // already verified the entire archive and each restored file.
    let result: RestoreResult = serde_json::from_slice(
        &fs::read(
            output
                .join("restore-and-upgrade-copy")
                .join(STATE)
                .join("restore-report.json"),
        )
        .unwrap(),
    )
    .unwrap();
    verify_and_upgrade(&source, &output, "expected-resume-snapshot.sqlite3", result);
}
