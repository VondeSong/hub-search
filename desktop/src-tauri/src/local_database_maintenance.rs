//! Explicit offline database compaction. Never called by periodic cleanup.
use rand::RngCore;
use rusqlite::{
    backup::Backup, backup::StepResult, types::ValueRef, Connection, OpenFlags, OptionalExtension,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

pub(crate) const SEQUENCE_TABLES: &[&str] = &[
    "cloud_device_events",
    "cloud_device_pending",
    "cloud_maintenance_runs",
    "flashcard_cloud_uploads",
    "tag_content_scan_budget_history",
    "reading_sync_records",
    "reading_sync_pending",
    "reading_copy_snapshots",
    "reading_copy_pending",
    "reading_media_manifests",
    "reading_media_outbox",
    "collection_property_updates",
    "collection_x_outbox",
    "collection_obsidian_exports",
    "collection_library_destinations",
    "collection_remote_copies",
    "collection_saved_media",
];
const DIRECTORY: &str = "database-maintenance";
const DATABASE: &str = "craft-search.sqlite3";
static SAVEPOINT: AtomicU64 = AtomicU64::new(0);

fn quoted(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

/// Add identities without rebuilding business tables, constraints or triggers.
/// SAVEPOINT makes installation atomic both alone and inside an owner transaction.
pub(crate) fn ensure_sequences(c: &Connection, tables: &[&str]) -> Result<(), String> {
    let name = format!(
        "hub_local_sequence_{}",
        SAVEPOINT.fetch_add(1, Ordering::Relaxed)
    );
    c.execute_batch(&format!("SAVEPOINT {name}"))
        .map_err(|e| e.to_string())?;
    let result = (|| {
        // Lazy owners also install their schema on a bare Connection. Keep the
        // same metadata schema as open_database, inside the owner's savepoint
        // so rejected tables or a failed installation leave no partial schema.
        c.execute_batch(
            "CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
        )
        .map_err(|e| e.to_string())?;
        for table in tables {
            if !SEQUENCE_TABLES.contains(table) {
                return Err("未知本地序号表".into());
            }
            let present: bool = c
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                    [table],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            if !present {
                continue;
            }
            let marker = format!("local_sequence_installed:{table}");
            let installed: Option<String> = c
                .query_row("SELECT value FROM metadata WHERE key=?1", [&marker], |r| {
                    r.get(0)
                })
                .optional()
                .map_err(|e| e.to_string())?;
            if installed.as_deref() == Some("1") {
                // An inconsistent restore must fail before an address can be resolved.
                c.prepare(&format!("SELECT local_seq FROM {} LIMIT 0", quoted(table)))
                    .map_err(|e| format!("本地序号结构损坏：{e}"))?;
                let high_water: Option<String> = c
                    .query_row(
                        "SELECT value FROM metadata WHERE key=?1",
                        [format!("local_sequence:{table}")],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(|e| e.to_string())?;
                if !high_water
                    .as_deref()
                    .and_then(|v| v.parse::<i64>().ok())
                    .is_some_and(|v| v >= 0)
                {
                    return Err(format!("{table} 的本地序号计数损坏"));
                }
                let index = format!("hub_local_seq_{table}");
                let valid_index: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM pragma_index_list(?1) WHERE name=?2 AND \"unique\"=1) AND (SELECT count(*) FROM pragma_index_info(?2))=1 AND EXISTS(SELECT 1 FROM pragma_index_info(?2) WHERE name='local_seq')", [*table, index.as_str()], |r| r.get(0)).map_err(|e| e.to_string())?;
                let triggers: i64 = c.query_row("SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name=?1 AND name IN (?2,?3,?4)", rusqlite::params![table, format!("hub_local_seq_{table}_insert_guard"), format!("hub_local_seq_{table}_assigned"), format!("hub_local_seq_{table}_immutable")], |r| r.get(0)).map_err(|e| e.to_string())?;
                if !valid_index || triggers != 3 {
                    return Err(format!("{table} 的本地序号保护结构损坏"));
                }
                continue;
            }
            if installed.is_some() {
                return Err(format!("{table} 的本地序号版本无效"));
            }
            let q = quoted(table);
            let column: Option<String> = c
                .query_row(
                    "SELECT type FROM pragma_table_info(?1) WHERE name='local_seq'",
                    [table],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if column.is_none() {
                c.execute_batch(&format!("ALTER TABLE {q} ADD COLUMN local_seq INTEGER"))
                    .map_err(|e| e.to_string())?;
            } else if column.as_deref().map(str::to_ascii_uppercase).as_deref() != Some("INTEGER") {
                return Err(format!("{table} 的本地序号类型无效"));
            }
            c.execute_batch(&format!("UPDATE {q} SET local_seq=rowid WHERE local_seq IS NULL; CREATE UNIQUE INDEX IF NOT EXISTS hub_local_seq_{table} ON {q}(local_seq);")).map_err(|e| e.to_string())?;
            let invalid: bool = c
                .query_row(
                    &format!("SELECT EXISTS(SELECT 1 FROM {q} WHERE typeof(local_seq)<>'integer')"),
                    [],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            if invalid {
                return Err(format!("{table} 的本地序号损坏"));
            }
            let key = format!("local_sequence:{table}");
            c.execute(&format!("INSERT INTO metadata(key,value) SELECT ?1,CAST(max(coalesce(max(local_seq),0),0) AS TEXT) FROM {q} WHERE true ON CONFLICT(key) DO UPDATE SET value=CAST(max(CAST(metadata.value AS INTEGER),CAST(excluded.value AS INTEGER)) AS TEXT)"), [&key]).map_err(|e| e.to_string())?;
            c.execute_batch(&format!("CREATE TRIGGER IF NOT EXISTS hub_local_seq_{table}_insert_guard BEFORE INSERT ON {q}
                WHEN NEW.local_seq IS NOT NULL OR CAST((SELECT value FROM metadata WHERE key='{key}') AS INTEGER)=9223372036854775807
                BEGIN SELECT RAISE(ABORT,'local sequence invalid or exhausted'); END;
                CREATE TRIGGER IF NOT EXISTS hub_local_seq_{table}_assigned AFTER INSERT ON {q}
                BEGIN
                  UPDATE metadata SET value=CAST(max(CAST(value AS INTEGER)+CASE WHEN NEW.local_seq IS NULL THEN 1 ELSE 0 END,coalesce(NEW.local_seq,0)) AS TEXT) WHERE key='{key}';
                  UPDATE {q} SET local_seq=CAST((SELECT value FROM metadata WHERE key='{key}') AS INTEGER) WHERE rowid=NEW.rowid AND local_seq IS NULL;
                END;
                CREATE TRIGGER IF NOT EXISTS hub_local_seq_{table}_immutable BEFORE UPDATE OF local_seq ON {q}
                WHEN OLD.local_seq IS NOT NULL AND NEW.local_seq IS NOT OLD.local_seq
                BEGIN SELECT RAISE(ABORT,'local sequence is immutable'); END;")) .map_err(|e| e.to_string())?;
            c.execute("INSERT INTO metadata(key,value) VALUES(?1,'1') ON CONFLICT(key) DO UPDATE SET value=excluded.value", [&marker]).map_err(|e| e.to_string())?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => c
            .execute_batch(&format!("RELEASE {name}"))
            .map_err(|e| e.to_string()),
        Err(error) => {
            c.execute_batch(&format!("ROLLBACK TO {name}; RELEASE {name}"))
                .map_err(|e| format!("{error}；迁移回退失败：{e}"))?;
            Err(error)
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Preview {
    pub database_path: String,
    pub database_bytes: u64,
    pub wal_bytes: u64,
    pub page_count: u64,
    pub free_pages: u64,
    pub reclaimable_bytes: u64,
    pub required_free_bytes: u64,
    pub available_free_bytes: Option<u64>,
}

fn database(root: &Path) -> Result<PathBuf, String> {
    let root = fs::canonicalize(root).map_err(|e| format!("无法读取数据库根目录：{e}"))?;
    let path = root.join(DATABASE);
    let resolved = fs::canonicalize(&path).map_err(|e| format!("无法读取数据库：{e}"))?;
    if resolved.parent() != Some(root.as_path()) || !resolved.is_file() {
        return Err("数据库不属于当前数据根目录".into());
    }
    Ok(resolved)
}
fn readonly(path: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| e.to_string())
}
pub(crate) fn preview(root: &Path) -> Result<Preview, String> {
    let path = database(root)?;
    let c = readonly(&path)?;
    let page_count: u64 = c
        .query_row("PRAGMA page_count", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let free_pages: u64 = c
        .query_row("PRAGMA freelist_count", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let page_size: u64 = c
        .query_row("PRAGMA page_size", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let database_bytes = fs::metadata(&path).map_err(|e| e.to_string())?.len();
    let wal_bytes = fs::metadata(PathBuf::from(format!("{}-wal", path.to_string_lossy())))
        .map(|v| v.len())
        .unwrap_or(0);
    // Keep both the consistent backup and the retired source. VACUUM's temporary
    // space may be as large as its output; reserve the conservative source size.
    let required_free_bytes = database_bytes
        .saturating_add(wal_bytes)
        .saturating_mul(3)
        .saturating_add(16 * 1024 * 1024);
    Ok(Preview {
        database_path: path.to_string_lossy().into(),
        database_bytes,
        wal_bytes,
        page_count,
        free_pages,
        reclaimable_bytes: free_pages.saturating_mul(page_size),
        required_free_bytes,
        available_free_bytes: available_space(root).ok(),
    })
}

#[cfg(windows)]
pub(crate) fn available_space(root: &Path) -> Result<u64, String> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetDiskFreeSpaceExW(
            path: *const u16,
            available: *mut u64,
            total: *mut u64,
            free: *mut u64,
        ) -> i32;
    }
    let path: Vec<u16> = root.as_os_str().encode_wide().chain(Some(0)).collect();
    let (mut available, mut total, mut free) = (0, 0, 0);
    // SAFETY: a NUL-terminated UTF-16 path and three live u64 output locations.
    if unsafe { GetDiskFreeSpaceExW(path.as_ptr(), &mut available, &mut total, &mut free) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(available)
}
#[cfg(not(windows))]
fn available_space(_: &Path) -> Result<u64, String> {
    Err("当前平台尚不提供离线数据库压缩".into())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    pub id: String,
    pub phase: String,
    pub error: String,
    pub before_bytes: u64,
    pub after_bytes: u64,
    pub backup_path: String,
    pub original_path: String,
    pub candidate_sha256: String,
    pub source_sha256: String,
}
fn pointer(root: &Path) -> PathBuf {
    root.join(DIRECTORY).join("pending.json")
}
fn save(path: &Path, state: &Status) -> Result<(), String> {
    let mut nonce = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut nonce);
    let temporary = path.with_extension(format!("{:x}.writing", u64::from_le_bytes(nonce)));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec_pretty(state).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(&temporary, path).map_err(|e| e.to_string())
}
pub(crate) fn status(root: &Path) -> Result<Option<Status>, String> {
    if !pointer(root).exists() {
        return Ok(None);
    }
    let state: Status =
        serde_json::from_slice(&fs::read(pointer(root)).map_err(|e| e.to_string())?)
            .map_err(|_| "数据库维护请求损坏，保留现有数据库")?;
    if state.id.len() != 32 || !state.id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("数据库维护批次身份无效".into());
    }
    Ok(Some(state))
}
fn terminal(phase: &str) -> bool {
    matches!(phase, "complete" | "failed" | "cancelled")
}
pub(crate) fn request(root: &Path) -> Result<Status, String> {
    // Publish one request per data root. GUI and CLI must not overwrite each
    // other's pending batch after both observed the same terminal state.
    let _maintenance = crate::data_portability::maintenance_lock(root)?;
    let info = preview(root)?;
    if status(root)?.is_some_and(|s| !terminal(&s.phase)) {
        return Err("已有待执行的数据库维护，请先完成或取消".into());
    }
    if info.available_free_bytes.is_none() {
        return Err("当前平台无法核验压缩所需空间".into());
    }
    if info.available_free_bytes.unwrap_or(0) < info.required_free_bytes {
        return Err("空间不足，数据库未改变；压缩需要保留完整回退副本".into());
    }
    let parent = root.join(DIRECTORY);
    fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
    let parent = fs::canonicalize(parent).map_err(|e| e.to_string())?;
    let canonical_root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    if parent.parent() != Some(canonical_root.as_path()) {
        return Err("维护目录指向数据根目录之外".into());
    }
    let mut id = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut id);
    let id = id.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let run = parent.join(&id);
    fs::create_dir(&run).map_err(|e| e.to_string())?;
    let state = Status {
        id,
        phase: "requested".into(),
        error: String::new(),
        before_bytes: info.database_bytes,
        after_bytes: 0,
        backup_path: run
            .join("consistent-backup.sqlite3")
            .to_string_lossy()
            .into(),
        original_path: run.join("original.sqlite3").to_string_lossy().into(),
        candidate_sha256: String::new(),
        source_sha256: String::new(),
    };
    save(&run.join("request.json"), &state)?;
    save(&pointer(root), &state)?;
    Ok(state)
}
pub(crate) fn cancel_request(root: &Path) -> Result<Status, String> {
    let mut state = status(root)?.ok_or("没有待执行的数据库维护")?;
    let requested_id = state.id.clone();
    if terminal(&state.phase) {
        return Err("数据库维护已经结束".into());
    }
    let (_, run) = owned_run(root, &state)?;
    // A separate offline CLI can cancel the owner without opening the database.
    // The marker belongs to this exact batch and never changes the owner's phase.
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(run.join("cancel.requested"))
    {
        Ok(mut file) => {
            file.write_all(b"cancel\n").map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.to_string()),
    }
    if state.phase == "requested" {
        // If execution already acquired this batch, phase publication belongs
        // to that owner; its watcher observes the durable cancellation marker.
        if let Ok(_owner) = maintenance_owner(&run) {
            state = status(root)?.ok_or("维护请求已消失")?;
            if state.id != requested_id {
                return Err("维护批次已变化，请重新读取状态后取消".into());
            }
            if state.phase == "requested" {
                state.phase = "cancelled".into();
                save(&pointer(root), &state)?;
                save(&run.join("result.json"), &state)?;
            }
        } else {
            state = status(root)?.ok_or("维护请求已消失")?;
            if state.id != requested_id {
                return Err("维护批次已变化，请重新读取状态后取消".into());
            }
        }
    }
    Ok(state)
}

fn owned_run(root: &Path, state: &Status) -> Result<(PathBuf, PathBuf), String> {
    let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let parent = fs::canonicalize(root.join(DIRECTORY)).map_err(|e| e.to_string())?;
    let run = fs::canonicalize(parent.join(&state.id)).map_err(|e| e.to_string())?;
    if parent.parent() != Some(root.as_path()) || run.parent() != Some(parent.as_path()) {
        return Err("维护目录身份改变，保留现有数据库".into());
    }
    if Path::new(&state.backup_path) != run.join("consistent-backup.sqlite3")
        || Path::new(&state.original_path) != run.join("original.sqlite3")
    {
        return Err("维护回退路径身份改变".into());
    }
    Ok((root, run))
}

#[derive(Debug, PartialEq, Eq, Serialize)]
struct TableDigest {
    name: String,
    columns: Vec<String>,
    rows: u64,
    sum: [u8; 32],
    xor: [u8; 32],
}
#[derive(Debug, PartialEq, Eq, Serialize)]
struct DatabaseDigest {
    schema: Vec<(String, String, String, Option<String>)>,
    tables: Vec<TableDigest>,
    user_version: i64,
    application_id: i64,
}
fn integrity(c: &Connection) -> Result<(), String> {
    let mut q = c
        .prepare("PRAGMA integrity_check")
        .map_err(|e| e.to_string())?;
    let checks = q
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    for check in checks {
        if check.map_err(|e| e.to_string())? != "ok" {
            return Err("数据库完整性检查未通过，保留源库".into());
        }
    }
    let mut q = c
        .prepare("PRAGMA foreign_key_check")
        .map_err(|e| e.to_string())?;
    if q.query([])
        .map_err(|e| e.to_string())?
        .next()
        .map_err(|e| e.to_string())?
        .is_some()
    {
        return Err("数据库外键检查未通过，保留源库".into());
    }
    Ok(())
}
fn digest(c: &Connection, cancelled: &AtomicBool) -> Result<DatabaseDigest, String> {
    let mut q = c.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_autoindex_%' ORDER BY type,name").map_err(|e| e.to_string())?;
    let schema: Vec<(String, String, String, Option<String>)> = q
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    let mut tables = Vec::new();
    for (_, name, _, _) in schema.iter().filter(|s| s.0 == "table") {
        check_cancel(cancelled)?;
        let mut q = c
            .prepare(&format!("SELECT * FROM {}", quoted(name)))
            .map_err(|e| e.to_string())?;
        let columns = q
            .column_names()
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>();
        let mut out = TableDigest {
            name: name.clone(),
            columns,
            rows: 0,
            sum: [0; 32],
            xor: [0; 32],
        };
        let mut rows = q.query([]).map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            if out.rows % 256 == 0 {
                check_cancel(cancelled)?;
            }
            let mut h = Sha256::new();
            for column in 0..out.columns.len() {
                match row.get_ref(column).map_err(|e| e.to_string())? {
                    ValueRef::Null => h.update([0]),
                    ValueRef::Integer(v) => {
                        h.update([1]);
                        h.update(v.to_le_bytes());
                    }
                    ValueRef::Real(v) => {
                        h.update([2]);
                        h.update(v.to_bits().to_le_bytes());
                    }
                    ValueRef::Text(v) => {
                        h.update([3]);
                        h.update((v.len() as u64).to_le_bytes());
                        h.update(v);
                    }
                    ValueRef::Blob(v) => {
                        h.update([4]);
                        h.update((v.len() as u64).to_le_bytes());
                        h.update(v);
                    }
                }
            }
            let value = h.finalize();
            let mut carry = 0u16;
            for i in 0..32 {
                out.xor[i] ^= value[i];
                let total = out.sum[i] as u16 + value[i] as u16 + carry;
                out.sum[i] = total as u8;
                carry = total >> 8;
            }
            out.rows += 1;
        }
        tables.push(out);
    }
    Ok(DatabaseDigest {
        schema,
        tables,
        user_version: c
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| e.to_string())?,
        application_id: c
            .query_row("PRAGMA application_id", [], |r| r.get(0))
            .map_err(|e| e.to_string())?,
    })
}
fn check_cancel(flag: &AtomicBool) -> Result<(), String> {
    if flag.load(Ordering::Relaxed) {
        Err("数据库维护已取消，保留可用源库".into())
    } else {
        Ok(())
    }
}
fn file_hash(file: &mut fs::File) -> Result<String, String> {
    let mut h = Sha256::new();
    let mut buffer = [0u8; 128 * 1024];
    loop {
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&buffer[..n]);
    }
    Ok(format!("{:x}", h.finalize()))
}
fn hash_path(path: &Path) -> Result<String, String> {
    file_hash(&mut fs::File::open(path).map_err(|e| e.to_string())?)
}
fn verify_original(path: &Path, state: &Status) -> Result<(), String> {
    if state.source_sha256.is_empty() || hash_path(path)? != state.source_sha256 {
        return Err("回退源库身份已变化，保留全部维护文件并停止启动".into());
    }
    integrity(&readonly(path)?)
}
#[cfg(windows)]
fn exclusive_file(path: &Path) -> Result<fs::File, String> {
    use std::os::windows::fs::OpenOptionsExt;
    // Allow the owner's SQLite read-only verification and eventual rename while
    // denying every writer. Readers that deny rename make the switch fail safely.
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(5) // FILE_SHARE_READ | FILE_SHARE_DELETE, never SHARE_WRITE.
        .open(path)
        .map_err(|e| format!("数据库仍在使用，未切换文件：{e}"))
}
#[cfg(windows)]
fn maintenance_owner(run: &Path) -> Result<fs::File, String> {
    use std::os::windows::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .share_mode(0)
        .open(run.join("owner.lock"))
        .map_err(|e| format!("已有离线数据库维护正在执行：{e}"))
}
#[cfg(not(windows))]
fn maintenance_owner(_: &Path) -> Result<fs::File, String> {
    Err("当前平台尚不提供离线数据库压缩".into())
}
#[cfg(not(windows))]
fn exclusive_file(_: &Path) -> Result<fs::File, String> {
    Err("当前平台尚不提供离线数据库压缩".into())
}

/// This must run before any normal database connection or worker is started.
pub(crate) fn process_pending(
    root: &Path,
    cancelled: Arc<AtomicBool>,
) -> Result<Option<Status>, String> {
    let Some(state) = status(root)? else {
        return Ok(None);
    };
    if terminal(&state.phase) {
        return Ok(Some(state));
    }
    let _session = crate::data_portability::exclusive_session(root)?;
    let _maintenance = crate::data_portability::maintenance_lock(root)?;
    let Some(state) = status(root)? else {
        return Ok(None);
    };
    if terminal(&state.phase) {
        return Ok(Some(state));
    }
    let (_, run) = owned_run(root, &state)?;
    let marker = run.join("cancel.requested");
    if marker.is_file() {
        cancelled.store(true, Ordering::Relaxed);
    }
    let finished = Arc::new(AtomicBool::new(false));
    let done = finished.clone();
    let flag = cancelled.clone();
    let watcher = std::thread::spawn(move || {
        while !done.load(Ordering::Acquire) {
            if marker.is_file() {
                flag.store(true, Ordering::Relaxed);
                break;
            }
            std::thread::park_timeout(Duration::from_millis(25));
        }
    });
    let result = process_with(root, cancelled, None, |_, _| Ok(()));
    finished.store(true, Ordering::Release);
    watcher.thread().unpark();
    watcher
        .join()
        .map_err(|_| "数据库维护取消观察器异常退出".to_string())?;
    result
}
fn process_with<F: FnMut(&str, &Path) -> Result<(), String>>(
    root: &Path,
    cancelled: Arc<AtomicBool>,
    free_override: Option<u64>,
    mut checkpoint: F,
) -> Result<Option<Status>, String> {
    let Some(mut state) = status(root)? else {
        return Ok(None);
    };
    if terminal(&state.phase) {
        return Ok(Some(state));
    }
    let (root, run) = owned_run(root, &state)?;
    let _owner = maintenance_owner(&run)?;
    let current = status(&root)?.ok_or("维护请求已消失，保留数据库")?;
    if current.id != state.id || current.phase != state.phase {
        return Err("维护请求在取得执行所有权前已变化，请重新读取状态".into());
    }
    let source = root.join(DATABASE);
    let original = run.join("original.sqlite3");
    let backup = run.join("consistent-backup.sqlite3");
    let staged = run.join("compact.sqlite3");
    // A crashed run never starts another compaction on top of its partial files.
    if state.phase != "requested" {
        if original.exists() {
            verify_original(&original, &state)?;
            if source.exists()
                && !state.candidate_sha256.is_empty()
                && hash_path(&source)? == state.candidate_sha256
            {
                let c = readonly(&source)?;
                integrity(&c)?;
                state.phase = "complete".into();
                state.after_bytes = fs::metadata(&source).map_err(|e| e.to_string())?.len();
                state.error.clear();
            } else {
                if source.exists() {
                    fs::rename(&source, run.join("interrupted-candidate.sqlite3"))
                        .map_err(|e| e.to_string())?;
                }
                fs::rename(&original, &source)
                    .map_err(|e| format!("无法恢复源库，请保留维护目录并停止启动：{e}"))?;
                state.phase = "failed".into();
                state.error = "上次维护被中断，已恢复原数据库".into();
            }
        } else if source.exists() {
            state.phase = "failed".into();
            state.error = "上次维护被中断，原数据库保持可用".into();
        } else {
            return Err("数据库维护中断且源库缺失，请使用维护目录中的一致备份恢复".into());
        }
        save(&pointer(&root), &state)?;
        save(&run.join("result.json"), &state)?;
        return Ok(Some(state));
    }
    let result = (|| {
        let info = preview(&root)?;
        let free = free_override
            .or(info.available_free_bytes)
            .ok_or("无法核验磁盘可用空间")?;
        if free < info.required_free_bytes {
            return Err("空间不足，保留原数据库和待同步事实".into());
        }
        check_cancel(&cancelled)?;
        checkpoint("before-open", &run)?;
        // Reject another Hub's open SQLite handle before producing any backup
        // or compaction output. Final exclusion is checked again at the switch.
        drop(exclusive_file(&source)?);
        state.phase = "preparing".into();
        save(&pointer(&root), &state)?;
        let c = Connection::open_with_flags(database(&root)?, OpenFlags::SQLITE_OPEN_READ_WRITE)
            .map_err(|e| e.to_string())?;
        // DELETE mode plus a retained EXCLUSIVE locking mode excludes WAL readers,
        // other writers and a second application before the consistency snapshot.
        c.execute_batch("PRAGMA busy_timeout=1000; PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE; COMMIT;").map_err(|e| format!("数据库仍在使用，未执行压缩：{e}"))?;
        integrity(&c)?;
        let before = digest(&c, &cancelled)?;
        if backup.exists() || staged.exists() || original.exists() {
            return Err("维护输出已存在，保留全部文件并停止本批次".into());
        }
        let mut destination = Connection::open(&backup).map_err(|e| e.to_string())?;
        {
            let handle = Backup::new(&c, &mut destination).map_err(|e| e.to_string())?;
            loop {
                check_cancel(&cancelled)?;
                checkpoint("backup-step", &run)?;
                match handle.step(128).map_err(|e| e.to_string())? {
                    StepResult::Done => break,
                    StepResult::More => {}
                    StepResult::Busy | StepResult::Locked => {
                        return Err("一致备份遇到活动连接，保留源库".into())
                    }
                    _ => return Err("一致备份未完成".into()),
                }
            }
        }
        integrity(&destination)?;
        if digest(&destination, &cancelled)? != before {
            return Err("一致备份内容不相同，保留源库".into());
        }
        // Keep the verified old-schema backup immutable as the recovery boundary.
        drop(destination);
        let migration_copy = run.join("prepared-backup.sqlite3");
        fs::copy(&backup, &migration_copy).map_err(|e| e.to_string())?;
        let destination = Connection::open(&migration_copy).map_err(|e| e.to_string())?;
        ensure_sequences(&destination, SEQUENCE_TABLES)?;
        integrity(&destination)?;
        let expected = digest(&destination, &cancelled)?;
        fs::write(
            run.join("preservation.json"),
            serde_json::to_vec_pretty(&expected).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        state.phase = "backup-ready".into();
        save(&pointer(&root), &state)?;
        checkpoint("before-vacuum", &run)?;
        check_cancel(&cancelled)?;
        let interrupt = destination.get_interrupt_handle();
        let finished = Arc::new(AtomicBool::new(false));
        let done = finished.clone();
        let flag = cancelled.clone();
        let watcher = std::thread::spawn(move || {
            while !done.load(Ordering::Acquire) {
                if flag.load(Ordering::Relaxed) {
                    interrupt.interrupt();
                    break;
                }
                std::thread::park_timeout(Duration::from_millis(25));
            }
        });
        let vacuum = destination
            .execute("VACUUM INTO ?1", [staged.to_string_lossy().as_ref()])
            .map_err(|e| format!("压缩未完成，源库未切换：{e}"));
        finished.store(true, Ordering::Release);
        watcher.thread().unpark();
        let _ = watcher.join();
        vacuum?;
        check_cancel(&cancelled)?;
        drop(destination);
        let compact = readonly(&staged)?;
        integrity(&compact)?;
        if digest(&compact, &cancelled)? != expected {
            return Err("压缩结果的记录、媒体或队列不相同，保留源库".into());
        }
        drop(compact);
        // SQLite's retained EXCLUSIVE lock covers PENDING_BYTE near 1 GiB.
        // A raw read through another handle hits that byte-range lock on large
        // databases, so close SQLite before hashing. Revalidate typed business
        // content under the no-writer handle to cover the ownership-transfer gap.
        drop(c);
        checkpoint("before-file-ownership", &run)?;
        let mut ownership = exclusive_file(&source)?;
        let current = readonly(&source)?;
        integrity(&current)?;
        if digest(&current, &cancelled)? != before {
            return Err("源数据库在切换前已变化，保留最新源库".into());
        }
        drop(current);
        state.source_sha256 = file_hash(&mut ownership)?;
        state.candidate_sha256 = hash_path(&staged)?;
        state.after_bytes = fs::metadata(&staged).map_err(|e| e.to_string())?.len();
        state.phase = "candidate-ready".into();
        save(&pointer(&root), &state)?;
        checkpoint("before-swap", &run)?;
        check_cancel(&cancelled)?;
        fs::rename(&source, &original).map_err(|e| format!("源库未切换：{e}"))?;
        state.phase = "original-retired".into();
        save(&pointer(&root), &state)?;
        checkpoint("after-retire", &run)?;
        check_cancel(&cancelled)?;
        fs::rename(&staged, &source).map_err(|e| format!("压缩文件切换失败：{e}"))?;
        state.phase = "replaced".into();
        save(&pointer(&root), &state)?;
        checkpoint("after-install", &run)?;
        let reopened = readonly(&source)?;
        integrity(&reopened)?;
        if digest(&reopened, &cancelled)? != expected {
            return Err("重新打开后的数据库不相同，恢复源库".into());
        }
        drop(reopened);
        drop(ownership);
        state.phase = "complete".into();
        state.error.clear();
        Ok(())
    })();
    if let Err(error) = result {
        if original.exists() {
            verify_original(&original, &state).map_err(|e| format!("{error}；{e}"))?;
            if source.exists() {
                fs::rename(&source, run.join("failed-candidate.sqlite3"))
                    .map_err(|e| format!("{error}；无法隔离失败文件：{e}"))?;
            }
            fs::rename(&original, &source)
                .map_err(|e| format!("{error}；无法恢复源库，请停止启动：{e}"))?;
            let c = readonly(&source)?;
            integrity(&c)?;
        } else if !source.exists() {
            return Err(format!("{error}；源库缺失，请保留一致备份并停止启动"));
        }
        state.phase = if cancelled.load(Ordering::Relaxed) {
            "cancelled"
        } else {
            "failed"
        }
        .into();
        state.error = error;
    }
    save(&pointer(&root), &state)?;
    save(&run.join("result.json"), &state)?;
    Ok(Some(state))
}

#[cfg(test)]
#[path = "local_database_maintenance_tests.rs"]
mod tests;
