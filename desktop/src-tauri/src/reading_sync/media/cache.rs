//! Device-local ownership, pins and explicit cleanup. Never deletes source or cloud files.
use super::*;

pub(super) fn schema(c: &Connection) -> Result<(), String> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS reading_media_cache_files(name TEXT PRIMARY KEY,hash TEXT NOT NULL,size INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS reading_media_cache_pins(hash TEXT PRIMARY KEY,label TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS reading_media_evicted(hash TEXT PRIMARY KEY);").map_err(|e|e.to_string())
}
fn linked(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}
pub(super) fn root(db: &Path) -> Result<PathBuf, String> {
    let root = db
        .parent()
        .ok_or("数据库目录不可用")?
        .join("reading-media-v1");
    match fs::symlink_metadata(&root) {
        Ok(m) if linked(&m) || !m.is_dir() => Err("阅读缓存目录不是普通目录，已停止操作".into()),
        Ok(_) => Ok(root),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(root),
        Err(e) => Err(e.to_string()),
    }
}
pub(super) fn regular(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.is_file() && !linked(&m))
}
fn owned_name(name: &str, digest: &str) -> bool {
    let Some((stem, ext)) = name.split_once('.') else {
        return false;
    };
    stem == digest
        && valid_hash(digest)
        && !ext.is_empty()
        && ext.len() <= 8
        && ext
            .bytes()
            .all(|v| v.is_ascii_lowercase() || v.is_ascii_digit())
}
pub(super) fn register(c: &Connection, db: &Path, path: &Path, m: &Manifest) -> Result<(), String> {
    if path.parent() != Some(root(db)?.as_path()) || !regular(path) {
        return Err("附件不属于 Hub 阅读缓存".into());
    }
    let name = path
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or("缓存文件名无效")?;
    if !owned_name(name, &m.hash) {
        return Err("缓存身份无效".into());
    }
    c.execute("INSERT INTO reading_media_cache_files VALUES(?1,?2,?3) ON CONFLICT(name) DO UPDATE SET hash=excluded.hash,size=excluded.size",params![name,m.hash,m.size]).map_err(|e|e.to_string())?;
    c.execute("DELETE FROM reading_media_evicted WHERE hash=?1", [&m.hash])
        .map_err(|e| e.to_string())?;
    Ok(())
}
pub(super) fn pinned(c: &Connection, digest: &str) -> Result<bool, String> {
    c.query_row(
        "SELECT EXISTS(SELECT 1 FROM reading_media_cache_pins WHERE hash=?1)",
        [digest],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}
pub(super) fn evicted(c: &Connection, digest: &str) -> Result<bool, String> {
    c.query_row(
        "SELECT EXISTS(SELECT 1 FROM reading_media_evicted WHERE hash=?1)",
        [digest],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}
// Adopt only legacy files actually recorded by the old download consumer and verified now.
fn adopt(c: &Connection, db: &Path) -> Result<(), String> {
    let root = root(db)?;
    let paths = {
        let mut q = c
            .prepare("SELECT DISTINCT path FROM collection_saved_media")
            .map_err(|e| e.to_string())?;
        let rows = q
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows
    };
    for path in paths {
        let path = PathBuf::from(path);
        if path.parent() != Some(root.as_path()) || !regular(&path) {
            continue;
        }
        let Some(name) = path.file_name().and_then(|v| v.to_str()) else {
            continue;
        };
        let Some(digest) = path.file_stem().and_then(|v| v.to_str()) else {
            continue;
        };
        if !owned_name(name, digest) {
            continue;
        }
        let known: bool = c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM reading_media_cache_files WHERE name=?1)",
                [name],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if known {
            continue;
        }
        let Ok(bytes) = file_bytes(&path) else {
            continue;
        };
        let Some(kind) = infer::get(&bytes) else {
            continue;
        };
        if hash(&bytes) != digest
            || !supported(kind.mime_type())
            || path.extension().and_then(|v| v.to_str()) != Some(kind.extension())
        {
            continue;
        }
        c.execute(
            "INSERT OR IGNORE INTO reading_media_cache_files VALUES(?1,?2,?3)",
            params![name, digest, bytes.len() as u64],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Pin {
    hash: String,
    label: String,
    available: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    bytes: u64,
    pinned_bytes: u64,
    removable_bytes: u64,
    removable_count: usize,
    other_count: usize,
    pins: Vec<Pin>,
    token: String,
}
#[derive(Serialize)]
struct Candidate {
    name: String,
    hash: String,
    size: u64,
    modified: u128,
}
fn snapshot(c: &Connection, db: &Path) -> Result<(Status, Vec<Candidate>), String> {
    adopt(c, db)?;
    let root = root(db)?;
    let mut status = Status {
        bytes: 0,
        pinned_bytes: 0,
        removable_bytes: 0,
        removable_count: 0,
        other_count: 0,
        pins: Vec::new(),
        token: String::new(),
    };
    let mut files = Vec::new();
    let mut available = std::collections::BTreeSet::new();
    if root.exists() {
        for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let metadata = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
            if linked(&metadata) || !metadata.is_file() {
                status.other_count += 1;
                continue;
            }
            status.bytes = status.bytes.saturating_add(metadata.len());
            let name = entry.file_name().to_string_lossy().into_owned();
            let digest: Option<String> = c
                .query_row(
                    "SELECT hash FROM reading_media_cache_files WHERE name=?1",
                    [&name],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            let Some(digest) = digest.filter(|v| owned_name(&name, v)) else {
                status.other_count += 1;
                continue;
            };
            available.insert(digest.clone());
            if pinned(c, &digest)? {
                status.pinned_bytes += metadata.len();
                continue;
            }
            let pending: bool = c
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM reading_media_outbox WHERE path=?1)",
                    [entry.path().to_string_lossy().as_ref()],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            if pending {
                status.other_count += 1;
                continue;
            }
            files.push(Candidate {
                name,
                hash: digest,
                size: metadata.len(),
                modified: metadata
                    .modified()
                    .map_err(|e| e.to_string())?
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|e| e.to_string())?
                    .as_nanos(),
            });
        }
    }
    files.sort_by(|a, b| a.name.cmp(&b.name));
    let mut q = c
        .prepare("SELECT hash,label FROM reading_media_cache_pins ORDER BY hash")
        .map_err(|e| e.to_string())?;
    status.pins = q
        .query_map([], |r| {
            let hash: String = r.get(0)?;
            Ok(Pin {
                available: available.contains(&hash),
                hash,
                label: r.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    status.removable_count = files.len();
    status.removable_bytes = files.iter().map(|v| v.size).sum();
    status.token = hash(&serde_json::to_vec(&(&files, &status.pins)).map_err(|e| e.to_string())?);
    Ok((status, files))
}
pub(super) fn status(c: &Connection, db: &Path) -> Result<Status, String> {
    Ok(snapshot(c, db)?.0)
}
pub(super) fn pin(c: &Connection, db: &Path, ns: &str, key: &str, url: &str) -> Result<(), String> {
    let (post, urls) = current(c, key)?;
    if !urls.iter().any(|v| v == url) {
        return Err("附件不属于当前正文".into());
    }
    let m = load_manifest(c, ns, key, &post, url)?.ok_or("当前正文的附件清单尚未同步")?;
    let path = local_path(c, key, url).ok_or("附件尚未下载，无法离线保留")?;
    if m.state != "ready" || !transfer::matches_manifest(&path, &m) {
        return Err("附件校验未通过，无法离线保留".into());
    }
    register(c, db, &path, &m)?;
    c.execute("INSERT INTO reading_media_cache_pins VALUES(?1,?2) ON CONFLICT(hash) DO UPDATE SET label=excluded.label",params![m.hash,url]).map(|_|()).map_err(|e|e.to_string())
}
pub(super) fn unpin(c: &Connection, digest: &str) -> Result<(), String> {
    if !valid_hash(digest) {
        return Err("附件身份无效".into());
    }
    c.execute(
        "DELETE FROM reading_media_cache_pins WHERE hash=?1",
        [digest],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Cleanup {
    removed: usize,
    removed_bytes: u64,
    failures: Vec<String>,
    status: Status,
}
pub(super) fn clean(c: &Connection, db: &Path, token: &str) -> Result<Cleanup, String> {
    let (before, files) = snapshot(c, db)?;
    if token != before.token {
        return Err("缓存或离线保留状态已变化，请重新预览清理范围".into());
    }
    let root = root(db)?;
    let mut removed = 0;
    let mut bytes = 0;
    let mut failures = Vec::new();
    for file in files {
        let path = root.join(&file.name);
        if !owned_name(&file.name, &file.hash) || !regular(&path) || pinned(c, &file.hash)? {
            return Err("缓存身份已变化，请重新预览".into());
        }
        // Persist intent before deletion. A crash must not cause an automatic re-download.
        c.execute(
            "INSERT OR IGNORE INTO reading_media_evicted VALUES(?1)",
            [&file.hash],
        )
        .map_err(|e| e.to_string())?;
        match fs::remove_file(&path) {
            Ok(()) => {
                removed += 1;
                bytes += file.size;
                let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
                tx.execute(
                    "DELETE FROM collection_saved_media WHERE path=?1",
                    [path.to_string_lossy().as_ref()],
                )
                .map_err(|e| e.to_string())?;
                tx.execute(
                    "DELETE FROM reading_media_cache_files WHERE name=?1",
                    [&file.name],
                )
                .map_err(|e| e.to_string())?;
                tx.commit().map_err(|e| e.to_string())?;
            }
            Err(e) => failures.push(format!("附件暂时无法清理：{e}")),
        }
    }
    Ok(Cleanup {
        removed,
        removed_bytes: bytes,
        failures,
        status: status(c, db)?,
    })
}
#[tauri::command]
pub(crate) async fn get_reading_cache_status(app: AppHandle) -> Result<Status, String> {
    let _guard = LOCK.lock().await;
    let db = database_path(&app)?;
    let (c, _writer) = open_write_database(&db)?;
    x_bookmarks::storage::schema(&c)?;
    status(&c, &db)
}
#[tauri::command]
pub(crate) async fn clean_reading_cache(app: AppHandle, token: String) -> Result<Cleanup, String> {
    let _guard = LOCK.lock().await;
    let db = database_path(&app)?;
    let (c, _writer) = open_write_database(&db)?;
    clean(&c, &db, &token)
}
#[tauri::command]
pub(crate) async fn unpin_reading_attachment(app: AppHandle, hash: String) -> Result<(), String> {
    let _guard = LOCK.lock().await;
    let (c, _writer) = open_write_database(&database_path(&app)?)?;
    unpin(&c, &hash)
}
#[tauri::command]
pub(crate) async fn pin_reading_attachment(
    app: AppHandle,
    key: String,
    url: String,
) -> Result<(), String> {
    let _guard = LOCK.lock().await;
    let db = database_path(&app)?;
    let (ns, needs_download) = {
        let c = open_database(&db)?;
        let ns = object_store::namespace(&c)?;
        let (post, urls) = current(&c, &key)?;
        if !urls.contains(&url) {
            return Err("附件不属于当前正文".into());
        }
        let m = load_manifest(&c, &ns, &key, &post, &url)?.ok_or("请先同步此附件的云端清单")?;
        let ready = local_path(&c, &key, &url)
            .is_some_and(|path| regular(&path) && transfer::matches_manifest(&path, &m));
        (ns, !ready)
    };
    if needs_download {
        let (remote, p) = {
            let c = open_database(&db)?;
            cloud_sync::require_reading(&c, false)?;
            let p = policy(&c)?;
            if !p.enabled {
                return Err("请先开启阅读附件同步，下载后才能离线保留".into());
            }
            (object_store::store(&app, &c)?, p)
        };
        transfer::download(&db, &remote, &ns, &key, &url, &p, true).await?;
    }
    let (c, _writer) = open_write_database(&db)?;
    pin(&c, &db, &ns, &key, &url)
}
