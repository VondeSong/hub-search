//! Whole-library archives. Backup owns maintenance admission for its entire operation.
//! SQLite is snapshotted through the backup API; no live database/WAL is copied.
//! Portable files include Codex model preferences and completed .hubfc restore
//! points. Machine credentials, unfinished exports and disposable indexes stay out.
use rusqlite::{
    backup::{Backup, StepResult},
    Connection, OpenFlags,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

mod archive;
mod automatic;
mod consolidation;
pub(crate) mod consolidation_manifest;
mod dependencies;
mod files;
pub(crate) mod large_files;
mod legacy_media_paths;
pub(crate) mod media_policy;
mod owned_data;
mod owned_media;
#[cfg(all(test, windows))]
mod release_acceptance_tests;
pub(crate) mod x_media;
pub(crate) use consolidation::consolidate;
pub(crate) use legacy_media_paths::{preview_legacy_media_paths, repair_legacy_media_paths};
pub(crate) use owned_data::{
    initialize_owned_data, managed_craft_parent, migrate_owned_data_offline,
};
pub(crate) use owned_media::retain_media;

pub(crate) use automatic::{load_auto_config, run_due, save_auto_config, AutoBackupConfig};
pub(crate) const DATABASE: &str = "craft-search.sqlite3";

/// Delete one exact duplicate while holding both file identities against
/// replacement. The caller supplies the manifest and reference proof.
pub(crate) fn delete_duplicate_copy(
    path: &Path,
    keeper: &Path,
    bytes: u64,
    expected: &str,
) -> Result<(), String> {
    let mut kept = files::open_stable(keeper)?;
    files::delete_verified(path, |mut candidate| {
        for file in [&mut candidate, &mut kept] {
            if file.metadata().map_err(io_error)?.len() != bytes {
                return Err("重复副本大小已变化，文件保留".into());
            }
            let mut digest = Sha256::new();
            let mut buffer = [0u8; 128 * 1024];
            loop {
                let n = file.read(&mut buffer).map_err(io_error)?;
                if n == 0 {
                    break;
                }
                digest.update(&buffer[..n]);
            }
            if format!("{:x}", digest.finalize()) != expected {
                return Err("重复副本内容已变化，文件保留".into());
            }
        }
        Ok(())
    })
}
const STATE: &str = "data-backup-v1";
const MAX_FILES: usize = 1_000_000;
const MAX_BYTES: u64 = 8 * 1024 * 1024 * 1024 * 1024;
const MAX_WARNINGS: usize = 200;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupOptions {
    pub destination: String,
    #[serde(default)]
    pub include_external_sources: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Dependency {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub source_path: String,
    pub included: bool,
    pub archive_path: Option<String>,
    pub available: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupSummary {
    pub path: String,
    pub dataset_id: String,
    pub created_at: i64,
    pub app_version: String,
    pub schema_version: i64,
    pub files: u64,
    pub bytes: u64,
    pub archive_bytes: u64,
    pub checksum: String,
    pub complete: bool,
    pub dependencies: Vec<Dependency>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PathMapping {
    pub source_path: String,
    pub restored_path: String,
    pub kind: String,
    pub id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RestoreResult {
    pub destination: String,
    pub backup: BackupSummary,
    pub path_mappings: Vec<PathMapping>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Progress {
    pub phase: String,
    pub completed_bytes: u64,
    pub total_bytes: Option<u64>,
    pub completed_files: u64,
    pub total_files: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Header {
    version: u32,
    dataset_id: String,
    operation_id: String,
    automatic: bool,
    created_at: i64,
    app_version: String,
    schema_version: i64,
    source_root: String,
    files: u64,
    bytes: u64,
    complete: bool,
    dependencies: Vec<Dependency>,
    warnings: Vec<String>,
}

#[derive(Clone, Debug)]
struct InputFile {
    source: PathBuf,
    relative: String,
    size: u64,
    modified: Option<std::time::SystemTime>,
    expected_hash: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageCategory {
    pub id: String,
    pub label: String,
    pub logical_bytes: u64,
    pub files: u64,
    pub rebuildable: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Usage {
    pub root: String,
    pub logical_bytes: u64,
    pub files: u64,
    pub categories: Vec<UsageCategory>,
    pub warnings: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RunState {
    version: u32,
    id: String,
    operation: String,
    state: String,
    created_at: i64,
    output: String,
    staged_path: String,
    error: Option<String>,
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}
fn identifier() -> String {
    format!("{:032x}", rand::random::<u128>())
}
fn io_error(error: impl std::fmt::Display) -> String {
    format!("数据备份文件操作失败：{error}")
}
fn checkpoint(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) {
        Err("数据操作已取消，原数据保持可用".into())
    } else {
        Ok(())
    }
}
fn phase(callback: &mut dyn FnMut(Progress), name: &str) {
    callback(Progress {
        phase: name.into(),
        completed_bytes: 0,
        total_bytes: None,
        completed_files: 0,
        total_files: None,
    });
}
fn warning(warnings: &mut Vec<String>, message: String) {
    if warnings.len() < MAX_WARNINGS {
        warnings.push(message);
    } else if warnings.len() == MAX_WARNINGS {
        warnings.push("更多缺失或排除项未逐条显示；此备份不包含全部外部来源。".into());
    }
}

fn state_directory(root: &Path) -> Result<PathBuf, String> {
    let path = root.join(STATE);
    files::reject_links(&path)?;
    fs::create_dir_all(&path).map_err(io_error)?;
    Ok(path)
}

pub(crate) fn dataset_id(root: &Path) -> Result<String, String> {
    let file = state_directory(root)?.join("dataset.json");
    if file.exists() {
        files::reject_links(&file)?;
        let id: String = files::read_json(&file)?;
        if id.len() != 32 || !id.bytes().all(|v| v.is_ascii_hexdigit()) {
            return Err("数据集标识损坏".into());
        }
        return Ok(id);
    }
    let id = identifier();
    files::write_new_json(&file, &id)?;
    Ok(id)
}

fn record_run(root: &Path, run: &RunState) -> Result<(), String> {
    let directory = state_directory(root)?.join("runs");
    files::reject_links(&directory)?;
    fs::create_dir_all(&directory).map_err(io_error)?;
    files::replace_json(&directory.join(format!("{}.json", run.id)), run)
}

fn readonly(path: &Path) -> Result<Connection, String> {
    files::reject_links(path)?;
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| e.to_string())
}

fn schema_version(connection: &Connection) -> Result<i64, String> {
    let value: String = connection
        .query_row(
            "SELECT value FROM metadata WHERE key='schema_version'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| format!("不是有效的 Hub 数据库：{e}"))?;
    let version = value.parse::<i64>().map_err(|_| "数据库版本无效")?;
    if version < 5 || version > crate::database::DATABASE_SCHEMA_VERSION {
        return Err(format!(
            "数据库版本 {version} 不受当前程序支持（最高 {}）",
            crate::database::DATABASE_SCHEMA_VERSION
        ));
    }
    Ok(version)
}

fn validate_database(path: &Path, expected: i64, cancel: &AtomicBool) -> Result<(), String> {
    let c = readonly(path)?;
    checkpoint(cancel)?;
    if schema_version(&c)? != expected {
        return Err("数据库版本与备份清单不一致".into());
    }
    // An integrity scan may execute one long SQLite call. Interrupt that call
    // when cancelled instead of waiting until a result row becomes available.
    let stopped = AtomicBool::new(false);
    struct Stop<'a>(&'a AtomicBool);
    impl Drop for Stop<'_> {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Relaxed);
        }
    }
    std::thread::scope(|scope| {
        let interrupt = c.get_interrupt_handle();
        let finished = &stopped;
        let monitor = scope.spawn(move || {
            while !finished.load(Ordering::Relaxed) {
                if cancel.load(Ordering::Relaxed) {
                    interrupt.interrupt();
                    break;
                }
                std::thread::sleep(Duration::from_millis(15));
            }
        });
        let stop = Stop(&stopped);
        let result = (|| {
            let mut q = c
                .prepare("PRAGMA integrity_check")
                .map_err(|e| e.to_string())?;
            let mut rows = q.query([]).map_err(|e| e.to_string())?;
            let mut seen = false;
            while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                checkpoint(cancel)?;
                let result: String = row.get(0).map_err(|e| e.to_string())?;
                if result != "ok" {
                    return Err(format!("备份数据库完整性校验失败：{result}"));
                }
                seen = true;
            }
            if !seen {
                return Err("数据库完整性校验未返回结果".into());
            }
            Ok(())
        })();
        drop(stop);
        monitor.join().map_err(|_| "数据库校验取消监控意外终止")?;
        result
    })
}

/// The archive excludes Tantivy files, so physical generation pointers are not
/// portable. Ordinary content uses the existing empty-index full rebuild. The
/// attachment-only case needs lexical jobs because that rebuild checks whether
/// content_items is nonempty before it considers searchable attachment titles.
fn prepare_snapshot(connection: &mut Connection) -> Result<(), String> {
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    transaction
        .execute(
            "DELETE FROM metadata WHERE key='hub_restore_path_mappings_v1'",
            [],
        )
        .map_err(|e| format!("无法准备可再次恢复的数据库快照：{e}"))?;
    let table = |name: &str| -> Result<bool, String> {
        transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                [name],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())
    };
    if table("search_index_generations")? {
        transaction
            .execute("DELETE FROM search_index_generations", [])
            .map_err(|e| format!("无法重置备份的派生索引位置：{e}"))?;
    }
    if table("content_items")? && table("source_items")? && table("index_jobs")? {
        let has_content: bool = transaction
            .query_row("SELECT EXISTS(SELECT 1 FROM content_items)", [], |r| {
                r.get(0)
            })
            .map_err(|e| e.to_string())?;
        if !has_content {
            transaction
                .execute(
                    "DELETE FROM index_jobs WHERE job_type IN ('upsert_lexical','delete_lexical')",
                    [],
                )
                .map_err(|e| e.to_string())?;
            let has_provider: bool = transaction
                .query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('index_jobs') WHERE name='provider') AND EXISTS(SELECT 1 FROM pragma_table_info('documents') WHERE name='provider')", [], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            let (column, value) = if has_provider {
                (",provider", ",d.provider")
            } else {
                ("", "")
            };
            transaction.execute(&format!(
                "INSERT INTO index_jobs(job_key,space_id,source_id,source_type,job_type,status,priority,created_at,updated_at{column})
                 SELECT 'lexical:'||d.space_id||':'||d.id,d.space_id,d.id,'document','upsert_lexical','pending',10,?1,?1{value}
                 FROM documents d WHERE EXISTS(SELECT 1 FROM source_items s WHERE s.space_id=d.space_id AND s.document_id=d.id
                   AND s.source_type IN ('craft_attachment','obsidian_attachment') AND length(trim(s.title))>0)"),
                [now()]).map_err(|e| format!("无法准备附件标题索引重建：{e}"))?;
        }
    }
    transaction.commit().map_err(|e| e.to_string())
}

fn snapshot(source: &Path, target: &Path, cancel: &AtomicBool) -> Result<i64, String> {
    files::reject_links(source)?;
    // BEGIN IMMEDIATE on a separate connection prevents external writers during
    // the Backup API read; using the same connection would make backup busy.
    let guard = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|e| e.to_string())?;
    guard
        .execute_batch("PRAGMA busy_timeout=1500; BEGIN IMMEDIATE;")
        .map_err(|e| format!("数据库正忙，稍后再备份：{e}"))?;
    let input = readonly(source)?;
    let version = schema_version(&input)?;
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(io_error)?;
    let mut output = Connection::open(target).map_err(|e| e.to_string())?;
    let operation = Backup::new(&input, &mut output).map_err(|e| e.to_string())?;
    let started = Instant::now();
    loop {
        checkpoint(cancel)?;
        match operation
            .step(256)
            .map_err(|e| format!("无法创建数据库一致快照：{e}"))?
        {
            StepResult::Done => break,
            StepResult::More => {}
            StepResult::Busy | StepResult::Locked
                if started.elapsed() < Duration::from_secs(30) =>
            {
                std::thread::sleep(Duration::from_millis(20))
            }
            _ => return Err("数据库快照等待超时，请稍后重试".into()),
        }
    }
    drop(operation);
    drop(input);
    guard
        .execute_batch("ROLLBACK;")
        .map_err(|e| e.to_string())?;
    // A restored library can itself be backed up later. This marker belongs to
    // the previous physical restore, not the dataset: retaining it would reject
    // the next restore's different path mapping identity. Modify only the copy.
    prepare_snapshot(&mut output)?;
    output
        .execute_batch("PRAGMA journal_mode=DELETE;")
        .map_err(|e| e.to_string())?;
    drop(output);
    validate_database(target, version, cancel)?;
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(target)
        .and_then(|f| f.sync_all())
        .map_err(io_error)?;
    Ok(version)
}

/// Acquires the shared GC/backup/root-switch maintenance lease for this operation.
pub(crate) fn backup(
    root: &Path,
    options: &BackupOptions,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(Progress),
) -> Result<BackupSummary, String> {
    backup_kind(root, options, false, cancel, progress)
}

fn backup_kind(
    root: &Path,
    options: &BackupOptions,
    automatic: bool,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(Progress),
) -> Result<BackupSummary, String> {
    checkpoint(cancel)?;
    let root = files::existing_directory(root)?;
    let _maintenance = crate::data_portability::maintenance_lock(&root)?;
    let target = files::new_target(Path::new(&options.destination), false)?;
    if target.extension().and_then(|s| s.to_str()) != Some("hubbackup") {
        return Err("备份文件必须使用 .hubbackup 扩展名".into());
    }
    if target.starts_with(&root) {
        return Err("备份文件请选择当前数据目录以外的位置".into());
    }
    let id = identifier();
    let staged = target.with_extension(format!("hubbackup.{id}.partial"));
    let mut run = RunState {
        version: 1,
        id: id.clone(),
        operation: "backup".into(),
        state: "pending".into(),
        created_at: now(),
        output: target.to_string_lossy().into(),
        staged_path: staged.to_string_lossy().into(),
        error: None,
    };
    record_run(&root, &run)?;
    let outcome: Result<BackupSummary, String> = (|| {
        let identity = dataset_id(&root)?;
        let snapshot_path = state_directory(&root)?.join(format!("snapshot-{id}.sqlite3"));
        phase(progress, "snapshot");
        let source_bytes = fs::metadata(root.join(DATABASE)).map_err(io_error)?.len();
        let wal_bytes = fs::metadata(root.join("craft-search.sqlite3-wal"))
            .map(|m| m.len())
            .unwrap_or(0);
        files::check_space(
            &root,
            source_bytes
                .saturating_add(wal_bytes)
                .saturating_add(16 * 1024 * 1024),
        )?;
        let schema = snapshot(&root.join(DATABASE), &snapshot_path, cancel)?;
        phase(progress, "scan");
        let mut inputs = vec![files::input(&snapshot_path, DATABASE.to_string(), None)?];
        let mut warnings = Vec::new();
        let mut complete = true;
        files::collect_local(&root, &mut inputs, &mut warnings, cancel)?;
        let mut dependencies = dependencies::discover(
            &snapshot_path,
            &root,
            options.include_external_sources,
            &mut warnings,
        )?;
        if dependencies
            .iter()
            .filter(|d| d.included)
            .any(|d| target.starts_with(Path::new(&d.source_path)))
        {
            return Err("备份输出不能位于本次收录的来源目录中，请选择独立保存位置".into());
        }
        dependencies::collect(&root, &mut dependencies, &mut inputs, &mut warnings, cancel)?;
        dependencies::check_references(
            &snapshot_path,
            &mut inputs,
            &mut dependencies,
            &mut warnings,
            &mut complete,
        )?;
        dependencies::collect_reading_assets(
            &snapshot_path,
            &mut inputs,
            &mut dependencies,
            &mut warnings,
            &mut complete,
            cancel,
            None,
        )?;
        if dependencies
            .iter()
            .any(|v| !v.included && !matches!(v.kind.as_str(), "obsidian" | "reading"))
        {
            complete = false;
        }
        let bytes = inputs.iter().try_fold(0u64, |sum, input| {
            sum.checked_add(input.size).ok_or("备份数据太大")
        })?;
        if inputs.len() > MAX_FILES || bytes > MAX_BYTES {
            return Err("备份超过 100 万文件或 8 TB 上限".into());
        }
        let header = Header {
            version: 1,
            dataset_id: identity,
            operation_id: id,
            automatic,
            created_at: now(),
            app_version: env!("CARGO_PKG_VERSION").into(),
            schema_version: schema,
            source_root: root.to_string_lossy().into(),
            files: inputs.len() as u64,
            bytes,
            complete,
            dependencies,
            warnings,
        };
        files::check_space(
            target.parent().ok_or("目标目录不可用")?,
            bytes
                .saturating_add(bytes / 100)
                .saturating_add(16 * 1024 * 1024),
        )?;
        phase(progress, "archive");
        archive::write(&staged, &header, &inputs, cancel, progress)?;
        // External applications do not participate in Hub's maintenance lock.
        // Re-read every external file and re-enumerate its directory after copy.
        phase(progress, "verifySources");
        dependencies::verify_external(&header.dependencies, &inputs, cancel)?;
        phase(progress, "verify");
        let (verified_header, mut summary) = archive::read(&staged, None, cancel, progress)?;
        if verified_header.operation_id != header.operation_id {
            return Err("备份操作标识不一致".into());
        }
        checkpoint(cancel)?;
        files::publish_new_file(&staged, &target)?;
        summary.path = target.to_string_lossy().into();
        if let Err(error) = fs::remove_file(&snapshot_path) {
            warning(
                &mut summary.warnings,
                format!(
                    "备份已保存；临时数据库仍保留在 {}：{error}",
                    snapshot_path.display()
                ),
            );
        }
        Ok(summary)
    })();
    match outcome {
        Ok(mut summary) => {
            run.state = "succeeded".into();
            if let Err(error) = record_run(&root, &run) {
                warning(
                    &mut summary.warnings,
                    format!(
                        "备份已经保存到 {}，但操作记录保存失败：{error}",
                        target.display()
                    ),
                );
            }
            phase(progress, "complete");
            Ok(summary)
        }
        Err(error) => {
            run.state = if cancel.load(Ordering::Relaxed) {
                "cancelled"
            } else {
                "failed"
            }
            .into();
            run.error = Some(error.clone());
            let record_error = record_run(&root, &run)
                .err()
                .map(|e| format!("；状态记录失败：{e}"))
                .unwrap_or_default();
            Err(format!(
                "{error}；本次临时文件如已生成，将保留在 {}{record_error}",
                staged.display()
            ))
        }
    }
}

pub(crate) fn inspect(
    path: &Path,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(Progress),
) -> Result<BackupSummary, String> {
    archive::read(path, None, cancel, progress).map(|(_, summary)| summary)
}

pub(crate) fn dependencies(root: &Path) -> Result<Vec<Dependency>, String> {
    let root = files::existing_directory(root)?;
    dependencies::discover(&root.join(DATABASE), &root, false, &mut Vec::new())
}

/// Restore creates only a new directory. It never switches the running library.
/// Path mappings are persisted and returned for the main portability owner to apply.
pub(crate) fn restore(
    path: &Path,
    destination: &Path,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(Progress),
) -> Result<RestoreResult, String> {
    checkpoint(cancel)?;
    let destination = files::new_target(destination, true)?;
    let parent = destination.parent().ok_or("恢复目录不可用")?;
    let id = identifier();
    let staging = parent.join(format!(".hub-restore-{id}"));
    let ledger = parent.join(format!(".hub-restore-{id}.json"));
    let mut run = RunState {
        version: 1,
        id,
        operation: "restore".into(),
        state: "pending".into(),
        created_at: now(),
        output: destination.to_string_lossy().into(),
        staged_path: staging.to_string_lossy().into(),
        error: None,
    };
    files::write_new_json(&ledger, &run)?;
    let outcome: Result<RestoreResult, String> = (|| {
        let header = archive::header(path)?;
        // Reserve per-file allocation overhead as well as payload, including
        // many tiny attachments which would defeat a payload-only estimate.
        files::check_space(
            parent,
            header
                .bytes
                .saturating_add(header.files.saturating_mul(64 * 1024))
                .saturating_add(16 * 1024 * 1024),
        )?;
        fs::create_dir(&staging).map_err(io_error)?;
        phase(progress, "restore");
        let (header, summary) = archive::read(path, Some(&staging), cancel, progress)?;
        phase(progress, "verifyDatabase");
        validate_database(&staging.join(DATABASE), header.schema_version, cancel)?;
        {
            let restored = Connection::open(staging.join(DATABASE)).map_err(|e| e.to_string())?;
            crate::shared_memory::quarantine_restored(&restored)?;
        }
        let mut mappings = vec![PathMapping {
            source_path: header.source_root,
            restored_path: destination.to_string_lossy().into(),
            kind: "dataRoot".into(),
            id: "dataRoot".into(),
        }];
        for dependency in &header.dependencies {
            if let Some(relative) = dependency
                .archive_path
                .as_ref()
                .filter(|_| dependency.included)
            {
                if dependency.kind != "externalAttachment" {
                    fs::create_dir_all(staging.join(files::safe_relative(relative)?))
                        .map_err(io_error)?;
                }
                mappings.push(PathMapping {
                    source_path: dependency.source_path.clone(),
                    restored_path: destination
                        .join(files::safe_relative(relative)?)
                        .to_string_lossy()
                        .into(),
                    kind: dependency.kind.clone(),
                    id: dependency.id.clone(),
                });
            }
        }
        let state = state_directory(&staging)?;
        files::write_new_json(&state.join("dataset.json"), &header.dataset_id)?;
        files::write_new_json(&state.join("restore-path-mappings.json"), &mappings)?;
        let mut warnings = summary.warnings.clone();
        warning(
            &mut warnings,
            "备份中的共享记忆按历史内容恢复，需重新确认后使用；本机记忆运行环境需重新连接。".into(),
        );
        warning(
            &mut warnings,
            "如果原目录已准备加密授权副本，它会随数据恢复；在新电脑输入迁移密码解锁，否则可重新登录。".into(),
        );
        warning(
            &mut warnings,
            "换机后需为后续云同步生成新的设备身份；已有复习与同步历史保留原作者。".into(),
        );
        warning(
            &mut warnings,
            "已恢复数据文件；打开前需由换机检查应用路径映射，搜索索引将在打开后重建。".into(),
        );
        let result = RestoreResult {
            destination: destination.to_string_lossy().into(),
            backup: summary,
            path_mappings: mappings,
            warnings,
        };
        files::write_new_json(&state.join("restore-report.json"), &result)?;
        checkpoint(cancel)?;
        files::publish_new_directory(&staging, &destination)?;
        Ok(result)
    })();
    match outcome {
        Ok(mut result) => {
            run.state = "succeeded".into();
            if let Err(error) = files::replace_json(&ledger, &run) {
                warning(
                    &mut result.warnings,
                    format!(
                        "数据已恢复到 {}，操作记录保存失败：{error}",
                        destination.display()
                    ),
                );
            }
            phase(progress, "complete");
            Ok(result)
        }
        Err(error) => {
            run.state = if cancel.load(Ordering::Relaxed) {
                "cancelled"
            } else {
                "failed"
            }
            .into();
            run.error = Some(error.clone());
            let record_error = files::replace_json(&ledger, &run)
                .err()
                .map(|e| format!("；状态记录失败：{e}"))
                .unwrap_or_default();
            Err(format!(
                "{error}；已展开的文件保留在 {}，目标数据未覆盖{record_error}",
                staging.display()
            ))
        }
    }
}

fn usage_category(relative: &Path) -> (&'static str, &'static str, bool) {
    match relative
        .components()
        .next()
        .and_then(|v| v.as_os_str().to_str())
        .unwrap_or("")
    {
        DATABASE | "craft-search.sqlite3-wal" | "craft-search.sqlite3-shm" => {
            ("database", "正文、资料和个人设置", false)
        }
        "blobs-v1" => ("attachments", "文档与闪卡附件", false),
        "collection-files" => ("reading", "阅读正文与附件原件", false),
        "external-sources" => ("sources", "已收拢的来源文件", false),
        "tantivy-generations-v1" | "tantivy-v1" => ("indexes", "可重建搜索索引", true),
        "logs" | "crash-reports" => ("logs", "日志", true),
        STATE | "database-maintenance" | "flashcard-backups" => {
            ("recovery", "备份记录与恢复文件", false)
        }
        "codex-suite-v1.json" | "model-runtime-v1.json" => ("settings", "个人功能设置", false),
        "webview-v1" | "EBWebView" => ("webview", "界面缓存与旧版设置", false),
        _ => ("other", "其他本地文件", false),
    }
}
pub(crate) fn usage(root: &Path) -> Result<Usage, String> {
    let root = files::existing_directory(root)?;
    let mut groups: BTreeMap<String, UsageCategory> = BTreeMap::new();
    let mut warnings = Vec::new();
    files::walk(
        &root,
        &root,
        &mut |path, meta| {
            let relative = path.strip_prefix(&root).map_err(|e| e.to_string())?;
            let (id, label, rebuildable) = usage_category(relative);
            let entry = groups.entry(id.into()).or_insert(UsageCategory {
                id: id.into(),
                label: label.into(),
                logical_bytes: 0,
                files: 0,
                rebuildable,
            });
            entry.logical_bytes = entry.logical_bytes.saturating_add(meta.len());
            entry.files += 1;
            Ok(())
        },
        &mut warnings,
        &AtomicBool::new(false),
        false,
    )?;
    let categories: Vec<_> = groups.into_values().collect();
    Ok(Usage {
        root: root.to_string_lossy().into(),
        logical_bytes: categories.iter().map(|c| c.logical_bytes).sum(),
        files: categories.iter().map(|c| c.files).sum(),
        categories,
        warnings,
    })
}

#[cfg(test)]
mod tests;
