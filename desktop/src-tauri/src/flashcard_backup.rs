//! Portable flashcard archives. Binary payloads never pass through the WebView.
//! Recovery uses the same immutable event merge as sync, inside one transaction.
use crate::flashcard_study_settings::read_flashcard_study_settings;

use super::*;
use std::io::{Read, Seek, Write};
mod operation;

const MAGIC: &[u8; 8] = b"HUBFC001";
const MAX_ARCHIVE: u64 = 2 * 1024 * 1024 * 1024;
const MAX_MANIFEST: u64 = 128 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    version: u32,
    app_version: String,
    snapshot: FlashcardSyncSnapshot,
    attachments: Vec<Attachment>,
    external_links: usize,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Attachment {
    hash: String,
    size: u64,
    mime_type: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Summary {
    path: String,
    checksum: String,
    created_at: i64,
    cards: usize,
    reviews: usize,
    attachments: usize,
    profiles: usize,
    external_links: usize,
    bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct History {
    items: Vec<Summary>,
    issues: Vec<HistoryIssue>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryIssue {
    path: String,
    error: String,
}

struct Archive {
    manifest: Manifest,
    offsets: Vec<u64>,
    checksum: String,
    bytes: u64,
}

fn io_error(e: impl std::fmt::Display) -> String {
    format!("闪卡备份文件操作失败：{e}")
}

// Inspect every card, including suspended/archived cards, inbox and quality history.
fn references(snapshot: &FlashcardSyncSnapshot) -> Result<(BTreeSet<String>, usize), String> {
    let mut items = Vec::new();
    for card in &snapshot.cards {
        items.extend(
            serde_json::from_str::<Vec<Value>>(&card.media_json)
                .map_err(|_| "卡片附件信息损坏，无法生成完整备份")?,
        );
    }
    items.extend(
        flashcard_sync_drafts::media(&snapshot.drafts)
            .into_iter()
            .cloned(),
    );
    for record in &snapshot.quality_records {
        for card in [&record["snapshot"], &record["before"]] {
            items.extend(card["media"].as_array().into_iter().flatten().cloned());
        }
    }
    let mut hashes = BTreeSet::new();
    let mut links = BTreeSet::new();
    for item in items {
        let url = item["url"]
            .as_str()
            .ok_or("附件缺少地址，无法生成完整备份")?;
        if let Some(hash) = url
            .strip_prefix("http://craft-media.localhost/")
            .or_else(|| url.strip_prefix("craft-media://localhost/"))
            .or_else(|| url.strip_prefix("hub-media://localhost/"))
        {
            if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err("附件地址无效，无法生成完整备份".into());
            }
            hashes.insert(hash.to_ascii_lowercase());
        } else if url.starts_with("https://") || url.starts_with("http://") {
            links.insert(url.to_string());
        } else {
            return Err("备份包含未导入本地的附件，请先将附件导入闪卡".into());
        }
    }
    Ok((hashes, links.len()))
}

fn digest_reader(
    reader: &mut impl Read,
    limit: u64,
    mut output: Option<&mut dyn Write>,
) -> Result<(String, u64), String> {
    let mut digest = Sha256::new();
    let mut size = 0;
    let mut buffer = vec![0; 64 * 1024];
    loop {
        operation::checkpoint()?;
        let count = reader.read(&mut buffer).map_err(io_error)?;
        if count == 0 {
            break;
        }
        size += count as u64;
        if size > limit {
            return Err("备份文件超过 2 GB 或附件长度不符".into());
        }
        digest.update(&buffer[..count]);
        if let Some(writer) = &mut output {
            operation::checkpoint()?;
            writer.write_all(&buffer[..count]).map_err(io_error)?;
        }
    }
    Ok((format!("{:x}", digest.finalize()), size))
}

fn inspect(file: &mut fs::File) -> Result<Archive, String> {
    operation::checkpoint()?;
    let bytes = file.metadata().map_err(io_error)?.len();
    if bytes > MAX_ARCHIVE {
        return Err("备份文件超过 2 GB".into());
    }
    file.rewind().map_err(io_error)?;
    let mut magic = [0; 8];
    file.read_exact(&mut magic).map_err(io_error)?;
    if &magic != MAGIC {
        return Err("不是支持的 Hub 闪卡备份文件，请升级应用或重新选择".into());
    }
    let mut length = [0; 8];
    file.read_exact(&mut length).map_err(io_error)?;
    let length = u64::from_le_bytes(length);
    if length > MAX_MANIFEST || length > bytes.saturating_sub(48) {
        return Err("备份清单长度无效".into());
    }
    let mut expected = [0; 32];
    file.read_exact(&mut expected).map_err(io_error)?;
    let mut json = vec![0; length as usize];
    for chunk in json.chunks_mut(64 * 1024) {
        operation::checkpoint()?;
        file.read_exact(chunk).map_err(io_error)?;
    }
    if Sha256::digest(&json).as_slice() != expected {
        return Err("备份清单校验失败，原数据未修改".into());
    }
    let manifest: Manifest =
        serde_json::from_slice(&json).map_err(|_| "备份清单损坏或版本不兼容")?;
    if manifest.version != 1 || !matches!(manifest.snapshot.version, 4 | 5) {
        return Err("备份版本不支持，请升级应用".into());
    }
    flashcard_scheduler::validate_snapshot(&manifest.snapshot)?;
    let profiles: HashSet<_> = manifest
        .snapshot
        .scheduler_profiles
        .iter()
        .map(|p| p.id.as_str())
        .collect();
    if profiles.len() != manifest.snapshot.scheduler_profiles.len()
        || manifest
            .snapshot
            .reviews
            .iter()
            .any(|r| r.scheduler_version > 0 && !profiles.contains(r.scheduler_profile_id.as_str()))
    {
        return Err("备份缺少复习记录使用的算法参数，或参数重复".into());
    }
    for card in &manifest.snapshot.cards {
        operation::checkpoint()?;
        if !card.fsrs_state_json.is_empty() {
            let state: Value = serde_json::from_str(&card.fsrs_state_json).map_err(io_error)?;
            let id = state["profileId"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(flashcard_profiles::default_id);
            if !profiles.contains(id.as_str()) {
                return Err("备份缺少卡片使用的算法参数".into());
            }
        }
    }
    let (references, external) = references(&manifest.snapshot)?;
    let listed: BTreeSet<_> = manifest
        .attachments
        .iter()
        .map(|a| a.hash.clone())
        .collect();
    if listed != references
        || listed.len() != manifest.attachments.len()
        || external != manifest.external_links
    {
        return Err("备份附件清单不完整或存在重复项".into());
    }
    let mut offsets = Vec::new();
    for item in &manifest.attachments {
        operation::checkpoint()?;
        let offset = file.stream_position().map_err(io_error)?;
        if item.size == 0 || item.size > bytes.saturating_sub(offset) {
            return Err("备份附件缺失或已截断".into());
        }
        offsets.push(offset);
        let (hash, size) = digest_reader(&mut Read::by_ref(file).take(item.size), item.size, None)?;
        if hash != item.hash || size != item.size {
            return Err("备份附件校验失败，原数据未修改".into());
        }
    }
    if file.stream_position().map_err(io_error)? != bytes {
        return Err("备份包含未识别的多余数据".into());
    }
    file.rewind().map_err(io_error)?;
    let (checksum, _) = digest_reader(file, MAX_ARCHIVE, None)?;
    Ok(Archive {
        manifest,
        offsets,
        checksum,
        bytes,
    })
}

impl Archive {
    fn summary(&self, path: &Path) -> Summary {
        Summary {
            path: path.to_string_lossy().into(),
            checksum: self.checksum.clone(),
            created_at: self.manifest.snapshot.exported_at,
            cards: self.manifest.snapshot.cards.len(),
            reviews: self.manifest.snapshot.reviews.len(),
            attachments: self.manifest.attachments.len(),
            profiles: self.manifest.snapshot.scheduler_profiles.len(),
            external_links: self.manifest.external_links,
            bytes: self.bytes,
        }
    }
}

struct PreparedArchive {
    manifest: Manifest,
    json: Vec<u8>,
    // Open under the same writer admission as the database snapshot. Unlinking
    // or replacing a cache path later cannot remove the bytes from these handles.
    sources: Vec<fs::File>,
}

fn prepare(connection: &mut Connection, root: &Path) -> Result<PreparedArchive, String> {
    operation::checkpoint()?;
    let tx = connection.transaction().map_err(io_error)?;
    let mut snapshot = local_flashcard_snapshot(&tx)?;
    snapshot.study_settings = Some(read_flashcard_study_settings(&tx));
    let (hashes, external_links) = references(&snapshot)?;
    let store = BlobStore::open(&root.join("blobs-v1"))?;
    let mut attachments = Vec::new();
    let mut sources = Vec::new();
    let mut total = 48;
    for hash in hashes {
        operation::checkpoint()?;
        let path = store.path_for(&hash)?;
        let source = fs::File::open(&path)
            .map_err(|_| "部分附件尚未下载，无法生成完整备份。请先联网同步并下载附件，再重试。")?;
        let size = source.metadata().map_err(io_error)?.len();
        total += size;
        if total > MAX_ARCHIVE {
            return Err("完整备份超过 2 GB，无法导出".into());
        }
        let mime_type = tx
            .query_row("SELECT mime_type FROM blobs WHERE hash=?1", [&hash], |r| {
                r.get::<_, String>(0)
            })
            .optional()
            .map_err(io_error)?
            .unwrap_or_else(|| "application/octet-stream".into());
        attachments.push(Attachment {
            hash,
            size,
            mime_type,
        });
        sources.push(source);
    }
    let manifest = Manifest {
        version: 1,
        app_version: env!("CARGO_PKG_VERSION").into(),
        snapshot,
        attachments,
        external_links,
    };
    let json = serde_json::to_vec(&manifest).map_err(io_error)?;
    if json.len() as u64 > MAX_MANIFEST || total + json.len() as u64 > MAX_ARCHIVE {
        return Err("备份超过大小上限".into());
    }
    tx.commit().map_err(io_error)?;
    Ok(PreparedArchive {
        manifest,
        json,
        sources,
    })
}

fn publish(mut prepared: PreparedArchive, root: &Path, label: &str) -> Result<Summary, String> {
    operation::checkpoint()?;
    let manifest = &prepared.manifest;
    let json = &prepared.json;
    let folder = root.join("flashcard-backups");
    fs::create_dir_all(&folder).map_err(io_error)?;
    let path = folder.join(format!(
        "{label}-{}-{:016x}.hubfc",
        now_timestamp(),
        rand::thread_rng().next_u64()
    ));
    let staging = path.with_extension("partial");
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staging)
            .map_err(io_error)?;
        file.write_all(MAGIC).map_err(io_error)?;
        file.write_all(&(json.len() as u64).to_le_bytes())
            .map_err(io_error)?;
        file.write_all(&Sha256::digest(&json)).map_err(io_error)?;
        for chunk in json.chunks(64 * 1024) {
            operation::checkpoint()?;
            file.write_all(chunk).map_err(io_error)?;
        }
        for (item, source) in manifest.attachments.iter().zip(&mut prepared.sources) {
            let (hash, size) = digest_reader(source, item.size, Some(&mut file))?;
            if hash != item.hash || size != item.size {
                return Err("本地附件校验失败，备份未完成".into());
            }
        }
        file.sync_all().map_err(io_error)?;
        drop(file);
        let archive = inspect(&mut fs::File::open(&staging).map_err(io_error)?)?;
        operation::commit(label != "before-restore", || {
            fs::rename(&staging, &path).map_err(io_error)
        })?;
        Ok(archive.summary(&path))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&staging);
    }
    result
}

#[cfg(test)]
fn create(connection: &mut Connection, root: &Path, label: &str) -> Result<Summary, String> {
    publish(prepare(connection, root)?, root, label)
}

fn create_database(database: &PathBuf, root: &Path, label: &str) -> Result<Summary, String> {
    create_database_after_snapshot(database, root, label, || {})
}

fn create_database_after_snapshot(
    database: &PathBuf,
    root: &Path,
    label: &str,
    after_snapshot: impl FnOnce(),
) -> Result<Summary, String> {
    let prepared = {
        let (mut connection, _writer) = open_write_database(database)?;
        prepare(&mut connection, root)?
    };
    after_snapshot();
    publish(prepared, root, label)
}

fn snapshot_identity(snapshot: &FlashcardSyncSnapshot) -> Result<String, String> {
    crate::flashcard_snapshot::identity::backup(snapshot)
}

fn restore(
    connection: &mut Connection,
    root: &Path,
    path: &Path,
    checksum: &str,
) -> Result<Value, String> {
    restore_after_safety(connection, root, path, checksum, || {})
}

fn restore_after_safety(
    connection: &mut Connection,
    root: &Path,
    path: &Path,
    checksum: &str,
    after_safety: impl FnOnce(),
) -> Result<Value, String> {
    let mut file = fs::File::open(path).map_err(io_error)?;
    let archive = inspect(&mut file)?;
    if archive.checksum != checksum {
        return Err("备份自预览后发生变化，请重新选择文件".into());
    }
    // A failed merge rolls back every database change. Content-addressed blobs
    // are installed first, so a committed card never references an absent blob.
    let store = BlobStore::open(&root.join("blobs-v1"))?;
    for (item, offset) in archive.manifest.attachments.iter().zip(&archive.offsets) {
        operation::checkpoint()?;
        file.seek(SeekFrom::Start(*offset)).map_err(io_error)?;
        let staged = store.staging_path()?;
        let outcome: Result<(), String> = (|| {
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&staged)
                .map_err(io_error)?;
            let (hash, size) = digest_reader(
                &mut Read::by_ref(&mut file).take(item.size),
                item.size,
                Some(&mut output),
            )?;
            if hash != item.hash || size != item.size {
                return Err("备份读取期间发生变化，恢复已取消".into());
            }
            output.sync_all().map_err(io_error)?;
            drop(output);
            let target = store.path_for(&hash)?;
            if target.exists() {
                let (old_hash, _) = digest_reader(
                    &mut fs::File::open(&target).map_err(io_error)?,
                    MAX_ARCHIVE,
                    None,
                )?;
                if old_hash != hash {
                    return Err("本地附件已损坏，请先修复附件缓存后恢复".into());
                }
            }
            operation::commit(false, || store.commit_staged(&staged, &hash, size))?;
            Ok(())
        })();
        if outcome.is_err() {
            let _ = fs::remove_file(&staged);
        }
        outcome?;
    }
    let prepared = {
        let _writer = lock_database_writer()?;
        prepare(connection, root)?
    };
    let baseline = snapshot_identity(&prepared.manifest.snapshot)?;
    let safety = publish(prepared, root, "before-restore")?;
    after_safety();
    let _writer = lock_database_writer()?;
    let tx = connection.transaction().map_err(io_error)?;
    let mut current = local_flashcard_snapshot(&tx)?;
    current.study_settings = Some(read_flashcard_study_settings(&tx));
    if snapshot_identity(&current)? != baseline {
        return Err("生成恢复前备份时本机闪卡发生变化；备份已保留，请重新确认恢复".into());
    }
    // Cleanup shares writer admission. Recheck published paths at the final
    // commit boundary so a cache cleanup during IO cannot produce absent references.
    let mut retained = Vec::new();
    for item in &archive.manifest.attachments {
        operation::checkpoint()?;
        let blob = fs::File::open(store.path_for(&item.hash)?)
            .map_err(|_| "恢复附件在提交前已变化，请重新恢复")?;
        if blob.metadata().map_err(io_error)?.len() != item.size {
            return Err("恢复附件长度已变化，原数据库未修改".into());
        }
        retained.push(blob);
    }
    let (cards, reviews) =
        merge_flashcard_snapshot_in_transaction(&tx, &archive.manifest.snapshot)?;
    for item in &archive.manifest.attachments {
        tx.execute("INSERT INTO blobs(hash,size,mime_type,relative_path,created_at,verified_at) VALUES(?1,?2,?3,?4,?5,?5) ON CONFLICT(hash) DO UPDATE SET verified_at=excluded.verified_at",
            params![item.hash,item.size as i64,item.mime_type,format!("{}/{}",&item.hash[..2],item.hash),now_timestamp()]).map_err(io_error)?;
    }
    mark_flashcard_sync_dirty(&tx)?;
    operation::commit(true, || tx.commit().map_err(io_error))?;
    Ok(json!({"cards":cards,"reviews":reviews,"safetyBackup":safety}))
}

fn owned_path(root: &Path, path: &str) -> Result<PathBuf, String> {
    let path = Path::new(path).canonicalize().map_err(io_error)?;
    let folder = root
        .join("flashcard-backups")
        .canonicalize()
        .map_err(io_error)?;
    if path.parent() != Some(folder.as_path())
        || path.extension().and_then(|e| e.to_str()) != Some("hubfc")
    {
        return Err("请选择已校验的闪卡备份文件".into());
    }
    Ok(path)
}

fn begin_operation(
    app: &AppHandle,
    root: &Path,
    operation_id: &str,
) -> Result<operation::Operation, String> {
    let accepted = operation::begin(root, operation_id)?;
    #[cfg(target_os = "android")]
    {
        let app = app.clone();
        let operation_id = operation_id.to_owned();
        accepted.on_cancel(move || {
            app.state::<AndroidSourceOpener>()
                .0
                .run_mobile_plugin::<()>(
                    "cancelFlashcardBackup",
                    json!({"operationId":operation_id}),
                )
                .map_err(io_error)
        })?;
    }
    #[cfg(not(target_os = "android"))]
    let _ = app;
    Ok(accepted)
}

#[tauri::command]
pub(super) async fn create_flashcard_backup(
    app: AppHandle,
    operation_id: String,
) -> Result<Summary, String> {
    let root = active_data_root(&app)?;
    let operation = begin_operation(&app, &root, &operation_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        operation.run(|| create_database(&database_path(&app)?, &root, "backup"))
    })
    .await
    .map_err(io_error)?
}

#[tauri::command]
pub(super) async fn inspect_flashcard_backup(
    app: AppHandle,
    path: String,
    operation_id: String,
) -> Result<Summary, String> {
    let root = active_data_root(&app)?;
    let operation = begin_operation(&app, &root, &operation_id)?;
    tauri::async_runtime::spawn_blocking(move || {
      operation.run(|| {
        let folder = root.join("flashcard-backups");
        fs::create_dir_all(&folder).map_err(io_error)?;
        let staging = folder.join(format!(
            "import-{:016x}.partial",
            rand::thread_rng().next_u64()
        ));
        let result = (|| {
            #[cfg(target_os = "android")]
            if path.starts_with("content://") {
                app.state::<AndroidSourceOpener>()
                    .0
                    .run_mobile_plugin::<()>(
                        "readFlashcardBackup",
                        json!({"uri":path,"destination":staging.to_string_lossy(),"operationId":operation_id}),
                    )
                    .map_err(io_error)?;
            } else {
                copy_input(&path, &staging)?;
            }
            #[cfg(not(target_os = "android"))]
            copy_input(&path, &staging)?;
            let archive = inspect(&mut fs::File::open(&staging).map_err(io_error)?)?;
            let target = staging.with_extension("hubfc");
            operation::commit(true, || fs::rename(&staging, &target).map_err(io_error))?;
            Ok(archive.summary(&target))
        })();
        if result.is_err() {
            let _ = fs::remove_file(&staging);
        }
        result
      })
    })
    .await
    .map_err(io_error)?
}

fn copy_input(source: &str, destination: &Path) -> Result<(), String> {
    copy_input_controlled(source, destination, false)
}
fn copy_input_controlled(source: &str, destination: &Path, terminal: bool) -> Result<(), String> {
    operation::checkpoint()?;
    let mut input = fs::File::open(source).map_err(io_error)?;
    if !input.metadata().map_err(io_error)?.is_file() {
        return Err("请选择备份文件".into());
    }
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(io_error)?;
    let result = (|| {
        digest_reader(&mut input, MAX_ARCHIVE, Some(&mut output))?;
        output.sync_all().map_err(io_error)?;
        operation::commit(terminal, || Ok(()))
    })();
    drop(output);
    if result.is_err() {
        let _ = fs::remove_file(destination);
    }
    result
}

#[tauri::command]
pub(super) async fn restore_flashcard_backup(
    app: AppHandle,
    path: String,
    checksum: String,
    operation_id: String,
) -> Result<Value, String> {
    let root = active_data_root(&app)?;
    let operation = begin_operation(&app, &root, &operation_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        operation.run(|| {
            let path = owned_path(&root, &path)?;
            let mut connection = open_database(&database_path(&app)?)?;
            restore(&mut connection, &root, &path, &checksum)
        })
    })
    .await
    .map_err(io_error)?
}

#[tauri::command]
pub(super) async fn save_flashcard_backup(
    app: AppHandle,
    path: String,
    destination: String,
    operation_id: String,
) -> Result<(), String> {
    let root = active_data_root(&app)?;
    let operation = begin_operation(&app, &root, &operation_id)?;
    tauri::async_runtime::spawn_blocking(move || {
      operation.run(|| {
        let path = owned_path(&root, &path)?;
        let archive = inspect(&mut fs::File::open(&path).map_err(io_error)?)?;
        #[cfg(target_os="android")]
        if destination.is_empty() {
            let opener = app.state::<AndroidSourceOpener>();
            let plugin = &opener.0;
            let prepared: Value = plugin.run_mobile_plugin("prepareFlashcardBackupExport", json!({
                "sourcePath":path.to_string_lossy(),"hash":archive.checksum,
                "fileName":format!("Hub闪卡备份-{}.hubfc",archive.manifest.snapshot.exported_at),"mimeType":"application/octet-stream","operationId":operation_id
            })).map_err(io_error)?;
            let token = prepared["token"].as_str().ok_or("备份导出暂存记录无效")?;
            // Preparing the binary snapshot remains cancellable. Opening the
            // durable native save flow is the short authoritative publication.
            let result = operation::commit(true, || plugin.run_mobile_plugin::<()>(
                "openFlashcardBackupExport", json!({"token":token})
            ).map_err(io_error));
            if result.is_err() {
                let _ = plugin.run_mobile_plugin::<()>("discardFlashcardBackupExport", json!({"token":token}));
            }
            return result;
        }
        #[cfg(not(target_os="android"))]
        let _ = archive;
        let target = Path::new(&destination);
        if !target.is_absolute() { return Err("请选择备份保存位置".into()); }
        let parent = target.parent().ok_or("保存位置无效")?.canonicalize().map_err(io_error)?;
        if parent.starts_with(root.canonicalize().map_err(io_error)?) || target.exists() {
            return Err("请选择 Hub 数据目录之外的新文件名，已有文件不会被覆盖".into());
        }
        // create_new means a cancelled or racing save can never overwrite data.
        copy_input_controlled(path.to_str().ok_or("备份路径无效")?, target, true)
      })
    }).await.map_err(io_error)?
}

fn list_history(root: &Path) -> Result<History, String> {
    let folder = root.join("flashcard-backups");
    let mut history = History {
        items: Vec::new(),
        issues: Vec::new(),
    };
    if !folder.exists() {
        return Ok(history);
    }
    let mut paths: Vec<_> = fs::read_dir(folder)
        .map_err(io_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(io_error)?
        .into_iter()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("hubfc"))
        .collect();
    paths.sort_by_key(|p| std::cmp::Reverse(fs::metadata(p).and_then(|m| m.modified()).ok()));
    for path in paths.into_iter().take(10) {
        operation::checkpoint()?;
        match fs::File::open(&path)
            .map_err(io_error)
            .and_then(|mut file| inspect(&mut file))
        {
            Ok(archive) => history.items.push(archive.summary(&path)),
            Err(error) => history.issues.push(HistoryIssue {
                path: path.to_string_lossy().into(),
                error,
            }),
        }
    }
    Ok(history)
}

#[tauri::command]
pub(super) async fn list_flashcard_backups(
    app: AppHandle,
    operation_id: String,
) -> Result<History, String> {
    let root = active_data_root(&app)?;
    let operation = begin_operation(&app, &root, &operation_id)?;
    tauri::async_runtime::spawn_blocking(move || operation.run(|| list_history(&root)))
        .await
        .map_err(io_error)?
}

#[tauri::command]
pub(super) fn cancel_flashcard_backup(
    app: AppHandle,
    operation_id: String,
) -> Result<bool, String> {
    operation::cancel(&active_data_root(&app)?, &operation_id)
}
pub(super) fn shutdown() {
    operation::shutdown();
}

#[cfg(test)]
mod tests;
