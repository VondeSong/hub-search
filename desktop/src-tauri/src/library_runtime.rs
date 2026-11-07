//! Per-library control authority, independent of long database write sections.
//! Work remains in the existing sync and index_jobs pipelines.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::Mutex as AsyncMutex;

const FILE: &str = "library-controls-v1.json";
const CONTROL_ERROR: &str = "资料库操作已停止：";

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
struct Intent {
    paused: bool,
    cancelled: bool,
    removed: bool,
    cleanup_complete: bool,
    epoch: u64,
    updated_at: i64,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Stored {
    schema_version: u8,
    libraries: HashMap<String, Intent>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    pub library_id: String,
    pub state: String,
    pub phase: String,
    pub detail: String,
    pub active_operations: usize,
    pub pending: usize,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

struct Active {
    library_id: String,
    phase: String,
    detail: String,
}
#[derive(Default)]
struct State {
    stopping: bool,
    control_revision: u64,
    intents: HashMap<String, Intent>,
    active: HashMap<u64, Active>,
    errors: HashMap<String, String>,
    phases: HashMap<String, (String, String)>,
    admission: HashMap<String, Arc<AsyncMutex<()>>>,
    next_id: u64,
    updated: HashMap<String, i64>,
    cleanup: HashSet<String>,
}
struct Runtime {
    root: PathBuf,
    state: Mutex<State>,
}

fn clock_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn touch(state: &mut State, id: &str) {
    let previous = state.updated.get(id).copied().unwrap_or_else(|| {
        state
            .intents
            .get(id)
            .map(|intent| intent.updated_at)
            .unwrap_or(0)
    });
    state
        .updated
        .insert(id.into(), clock_ms().max(previous.saturating_add(1)));
}
fn valid_id(id: &str) -> Result<(), String> {
    if id.trim().is_empty() || id.len() > 512 {
        Err("资料库标识无效".into())
    } else {
        Ok(())
    }
}

fn runtime(root: &Path) -> Result<Arc<Runtime>, String> {
    static ROOTS: OnceLock<Mutex<HashMap<PathBuf, Arc<Runtime>>>> = OnceLock::new();
    let canonical = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    // Windows canonicalization adds an extended-path prefix after a new root
    // first exists. Normalize it so accepted operations keep the same authority.
    let key = PathBuf::from(crate::display_local_path(&canonical));
    let mut roots = ROOTS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "资料库控制状态不可用")?;
    if let Some(value) = roots.get(&key) {
        return Ok(value.clone());
    }
    let intents = load_intents(&key)?;
    let runtime = Arc::new(Runtime {
        root: key.clone(),
        state: Mutex::new(State {
            intents,
            ..State::default()
        }),
    });
    roots.insert(key, runtime.clone());
    Ok(runtime)
}

fn load_intents(root: &Path) -> Result<HashMap<String, Intent>, String> {
    let file = root.join(FILE);
    let intents = if file.is_file() {
        let metadata = std::fs::metadata(&file).map_err(|_| "无法读取资料库控制设置")?;
        if metadata.len() > 256_000 {
            return Err("资料库控制设置过大".into());
        }
        let stored: Stored =
            serde_json::from_slice(&std::fs::read(file).map_err(|_| "无法读取资料库控制设置")?)
                .map_err(|_| "资料库控制设置损坏，请先恢复设置")?;
        if stored.schema_version != 1 {
            return Err("资料库控制设置版本不支持".into());
        }
        stored.libraries
    } else {
        HashMap::new()
    };
    Ok(intents)
}

fn persist(runtime: &Runtime, intents: &HashMap<String, Intent>) -> Result<(), String> {
    std::fs::create_dir_all(&runtime.root).map_err(|_| "无法建立资料库控制目录")?;
    let stored = serde_json::to_vec(&Stored {
        schema_version: 1,
        libraries: intents.clone(),
    })
    .map_err(|_| "无法生成资料库控制设置")?;
    if stored.len() > 256_000 {
        return Err("资料库控制设置过大".into());
    }
    let temp = runtime.root.join(format!(
        ".library-controls-{}.tmp",
        crate::random_url_safe(12)
    ));
    let result = (|| {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|_| "无法保存资料库控制设置")?;
        file.write_all(&stored)
            .and_then(|_| file.sync_all())
            .map_err(|_| "无法保存资料库控制设置")?;
        replace_file(&temp, &runtime.root.join(FILE))
            .map_err(|_| "无法提交资料库控制设置".to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result
}
#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(source: *const u16, destination: *const u16, flags: u32) -> i32;
    }
    let source: Vec<_> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<_> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH, same directory/volume.
    if unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), 1 | 8) } == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}
#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::rename(source, destination)
}

fn allowed(state: &State, id: &str, epoch: Option<u64>) -> Result<(), String> {
    if state.stopping {
        return Err(format!("{CONTROL_ERROR}应用正在退出"));
    }
    let intent = state.intents.get(id).cloned().unwrap_or_default();
    if intent.removed {
        return Err(format!("{CONTROL_ERROR}资料库已移除"));
    }
    if intent.paused {
        return Err(format!("{CONTROL_ERROR}资料库已暂停"));
    }
    if epoch.is_some_and(|epoch| epoch != intent.epoch) {
        return Err(format!("{CONTROL_ERROR}本次工作已取消"));
    }
    Ok(())
}

pub(crate) fn is_control_error(error: &str) -> bool {
    error.starts_with(CONTROL_ERROR)
}

/// Exit is process-local: persisted user pause/removal intent is untouched.
pub(crate) fn shutdown(root: &Path) {
    if let Ok(runtime) = runtime(root) {
        if let Ok(mut state) = runtime.state.lock() {
            state.stopping = true;
        }
    }
}
pub(crate) fn gate(root: &Path, library_id: &str) -> Result<(), String> {
    valid_id(library_id)?;
    let runtime = runtime(root)?;
    let state = runtime.state.lock().map_err(|_| "资料库控制状态不可用")?;
    allowed(&state, library_id, None)
}
pub(crate) fn exists_gate(root: &Path, library_id: &str) -> Result<(), String> {
    valid_id(library_id)?;
    let runtime = runtime(root)?;
    let state = runtime.state.lock().map_err(|_| "资料库控制状态不可用")?;
    if state.stopping {
        return Err(format!("{CONTROL_ERROR}应用正在退出"));
    }
    if state.intents.get(library_id).is_some_and(|i| i.removed) {
        Err(format!("{CONTROL_ERROR}资料库已移除"))
    } else {
        Ok(())
    }
}

/// Cached reads may include an already paused library. Publication must still
/// belong to the same control generation, including remove and pause/resume.
pub(crate) struct CachedReadPermit {
    runtime: Arc<Runtime>,
    revision: u64,
}

pub(crate) fn cached_read_permit(root: &Path) -> Result<CachedReadPermit, String> {
    let runtime = runtime(root)?;
    let state = runtime.state.lock().map_err(|_| "资料库控制状态不可用")?;
    if state.stopping {
        return Err(format!("{CONTROL_ERROR}应用正在退出"));
    }
    if state.control_revision == u64::MAX {
        return Err(format!("{CONTROL_ERROR}控制版本已耗尽"));
    }
    let revision = state.control_revision;
    drop(state);
    Ok(CachedReadPermit { runtime, revision })
}

impl CachedReadPermit {
    pub(crate) fn checkpoint(&self) -> Result<(), String> {
        self.commit(|| Ok(()))
    }

    /// The database writer is held before this barrier, matching Operation.
    pub(crate) fn commit<T>(&self, write: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        let state = self
            .runtime
            .state
            .lock()
            .map_err(|_| "资料库控制状态不可用")?;
        if state.stopping {
            return Err(format!("{CONTROL_ERROR}应用正在退出"));
        }
        if state.control_revision != self.revision || state.control_revision == u64::MAX {
            return Err(format!("{CONTROL_ERROR}索引快照期间资料库状态已改变"));
        }
        write()
    }
}

pub(crate) fn admission(root: &Path, library_id: &str) -> Result<Arc<AsyncMutex<()>>, String> {
    gate(root, library_id)?;
    let runtime = runtime(root)?;
    let mut state = runtime.state.lock().map_err(|_| "资料库控制状态不可用")?;
    Ok(state
        .admission
        .entry(library_id.into())
        .or_default()
        .clone())
}

pub(crate) struct Operation {
    runtime: Arc<Runtime>,
    library_id: String,
    id: u64,
    epoch: u64,
}

/// Commit a batch for one data root under a single control barrier. The DB
/// writer must already be held; never nest Operation::commit on this mutex.
pub(crate) fn commit_operations<T>(
    operations: &[Operation],
    write: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let Some(first) = operations.first() else {
        return write();
    };
    if operations
        .iter()
        .any(|operation| !Arc::ptr_eq(&operation.runtime, &first.runtime))
    {
        return Err("资料库批次跨越了不同数据目录".into());
    }
    let state = first
        .runtime
        .state
        .lock()
        .map_err(|_| "资料库控制状态不可用")?;
    for operation in operations {
        allowed(&state, &operation.library_id, Some(operation.epoch))?;
    }
    write()
}

/// Settings may be edited while a library is paused, but never after removal.
pub(crate) fn commit_existing<T>(
    root: &Path,
    library_id: &str,
    write: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    valid_id(library_id)?;
    let runtime = runtime(root)?;
    let state = runtime.state.lock().map_err(|_| "资料库控制状态不可用")?;
    if state.stopping {
        return Err(format!("{CONTROL_ERROR}应用正在退出"));
    }
    if state
        .intents
        .get(library_id)
        .is_some_and(|intent| intent.removed)
    {
        return Err(format!("{CONTROL_ERROR}资料库已移除"));
    }
    write()
}
/// Called while holding the DB writer. Prevent late work using the old directory.
pub(crate) fn commit_idle<T>(
    root: &Path,
    library_id: &str,
    write: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    valid_id(library_id)?;
    let runtime = runtime(root)?;
    let state = runtime.state.lock().map_err(|_| "资料库控制状态不可用")?;
    if state.stopping || state.intents.get(library_id).is_some_and(|i| i.removed) {
        return Err("资料库已停止或移除，不能更换文件夹".into());
    }
    if state.active.values().any(|a| a.library_id == library_id) {
        return Err("资料库正在处理，请先暂停并等待处理停止，再更换文件夹".into());
    }
    write()
}

pub(crate) fn begin(root: &Path, library_id: &str, label: &str) -> Result<Operation, String> {
    valid_id(library_id)?;
    let runtime = runtime(root)?;
    let mut state = runtime.state.lock().map_err(|_| "资料库控制状态不可用")?;
    allowed(&state, library_id, None)?;
    let epoch = state.intents.get(library_id).map(|i| i.epoch).unwrap_or(0);
    state.next_id = state.next_id.wrapping_add(1);
    let id = state.next_id;
    state.active.insert(
        id,
        Active {
            library_id: library_id.into(),
            phase: "starting".into(),
            detail: label.chars().take(160).collect(),
        },
    );
    state.errors.remove(library_id);
    touch(&mut state, library_id);
    drop(state);
    Ok(Operation {
        runtime,
        library_id: library_id.into(),
        id,
        epoch,
    })
}
impl Operation {
    pub(crate) fn checkpoint(&self) -> Result<(), String> {
        let state = self
            .runtime
            .state
            .lock()
            .map_err(|_| "资料库控制状态不可用")?;
        allowed(&state, &self.library_id, Some(self.epoch))
    }
    pub(crate) fn phase(&self, phase: &str, detail: &str) -> Result<(), String> {
        let mut state = self
            .runtime
            .state
            .lock()
            .map_err(|_| "资料库控制状态不可用")?;
        allowed(&state, &self.library_id, Some(self.epoch))?;
        if let Some(active) = state.active.get_mut(&self.id) {
            active.phase = phase.chars().take(40).collect();
            active.detail = detail.chars().take(160).collect();
        }
        touch(&mut state, &self.library_id);
        Ok(())
    }
    /// Acquire this only after the DB writer and immediately around a bounded
    /// commit. Control intent cannot race a late commit past the remove barrier.
    pub(crate) fn commit<T>(&self, write: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        let state = self
            .runtime
            .state
            .lock()
            .map_err(|_| "资料库控制状态不可用")?;
        allowed(&state, &self.library_id, Some(self.epoch))?;
        write()
    }
    pub(crate) fn failed(&self, error: &str) {
        if is_control_error(error) {
            return;
        }
        if let Ok(mut state) = self.runtime.state.lock() {
            state
                .errors
                .insert(self.library_id.clone(), error.chars().take(320).collect());
            touch(&mut state, &self.library_id);
        }
    }
}
impl Drop for Operation {
    fn drop(&mut self) {
        if let Ok(mut state) = self.runtime.state.lock() {
            state.active.remove(&self.id);
            state.phases.insert(
                self.library_id.clone(),
                ("idle".into(), "等待下一次更新".into()),
            );
            touch(&mut state, &self.library_id);
        }
    }
}

fn snapshot(state: &State, id: &str) -> Snapshot {
    let intent = state.intents.get(id).cloned().unwrap_or_default();
    let active: Vec<_> = state
        .active
        .values()
        .filter(|active| active.library_id == id)
        .collect();
    let (status, phase, detail) = if intent.removed {
        if intent.cleanup_complete {
            ("removed", "removed", "已从 Hub 移除，原内容已保留")
        } else {
            ("removing", "removing", "正在停止相关工作并清理本地索引")
        }
    } else if intent.paused {
        if intent.cancelled {
            ("cancelled", "stopping", "本次工作已取消，等待继续")
        } else if active.is_empty() {
            ("paused", "paused", "已暂停资料库更新")
        } else {
            ("pausing", "stopping", "正在完成安全停止")
        }
    } else if let Some((_, active)) = state
        .active
        .iter()
        .filter(|(_, a)| a.library_id == id)
        .max_by_key(|(operation_id, a)| {
            (
                !matches!(a.phase.as_str(), "queued" | "starting"),
                **operation_id,
            )
        })
    {
        ("running", active.phase.as_str(), active.detail.as_str())
    } else if state.errors.contains_key(id) {
        ("failed", "failed", "更新遇到问题，可重试")
    } else {
        ("idle", "idle", "等待下一次更新")
    };
    Snapshot {
        library_id: id.into(),
        state: status.into(),
        phase: phase.into(),
        detail: detail.into(),
        active_operations: active.len(),
        pending: active.iter().filter(|a| a.phase == "queued").count(),
        updated_at: state.updated.get(id).copied().unwrap_or(intent.updated_at),
        last_error: state.errors.get(id).cloned(),
    }
}
pub(crate) fn status(root: &Path, library_id: &str) -> Result<Snapshot, String> {
    valid_id(library_id)?;
    let runtime = runtime(root)?;
    let state = runtime.state.lock().map_err(|_| "资料库控制状态不可用")?;
    Ok(snapshot(&state, library_id))
}
pub(crate) fn statuses(root: &Path) -> Result<Vec<Snapshot>, String> {
    let runtime = runtime(root)?;
    let state = runtime.state.lock().map_err(|_| "资料库控制状态不可用")?;
    let mut ids: Vec<_> = state
        .intents
        .keys()
        .chain(state.active.values().map(|a| &a.library_id))
        .cloned()
        .collect();
    ids.sort();
    ids.dedup();
    Ok(ids.iter().map(|id| snapshot(&state, id)).collect())
}
pub(crate) fn control(root: &Path, library_id: &str, action: &str) -> Result<Snapshot, String> {
    valid_id(library_id)?;
    let runtime = runtime(root)?;
    let mut state = runtime.state.lock().map_err(|_| "资料库控制状态不可用")?;
    let mut intents = state.intents.clone();
    let intent = intents.entry(library_id.into()).or_default();
    if intent.removed && action != "remove" {
        return Err("资料库已移除，请重新添加后使用".into());
    }
    match action {
        "pause" => {
            intent.paused = true;
            intent.cancelled = false;
        }
        "resume" => {
            intent.paused = false;
            intent.cancelled = false;
        }
        "cancel" => {
            intent.paused = true;
            intent.cancelled = true;
        }
        "remove" => {
            intent.removed = true;
            intent.cleanup_complete = false;
        }
        _ => return Err("未知资料库操作".into()),
    }
    intent.epoch = intent.epoch.saturating_add(1);
    intent.updated_at = clock_ms();
    persist(&runtime, &intents)?;
    state.intents = intents;
    state.control_revision = state.control_revision.saturating_add(1);
    state.errors.remove(library_id);
    touch(&mut state, library_id);
    Ok(snapshot(&state, library_id))
}
/// Only an explicit add/connect action may reactivate a removed library ID.
pub(crate) fn initialize(root: &Path, library_id: &str, start_now: bool) -> Result<u64, String> {
    valid_id(library_id)?;
    let runtime = runtime(root)?;
    let mut state = runtime.state.lock().map_err(|_| "资料库控制状态不可用")?;
    let mut intents = state.intents.clone();
    let previous = intents.get(library_id).cloned().unwrap_or_default();
    if previous.removed && !previous.cleanup_complete {
        return Err("资料库仍在移除，请等清理完成后再添加".into());
    }
    let epoch = previous.epoch.saturating_add(1);
    intents.insert(
        library_id.into(),
        Intent {
            paused: !start_now,
            epoch,
            updated_at: clock_ms(),
            ..Intent::default()
        },
    );
    persist(&runtime, &intents)?;
    state.intents = intents;
    state.control_revision = state.control_revision.saturating_add(1);
    state.errors.remove(library_id);
    touch(&mut state, library_id);
    Ok(epoch)
}
/// Complete the same add request without reactivating a later remove intent.
pub(crate) fn activate_initialized(
    root: &Path,
    library_id: &str,
    epoch: u64,
    start_now: bool,
) -> Result<(), String> {
    valid_id(library_id)?;
    let runtime = runtime(root)?;
    let mut state = runtime.state.lock().map_err(|_| "资料库控制状态不可用")?;
    let mut intents = state.intents.clone();
    let intent = intents
        .get_mut(library_id)
        .ok_or("资料库初始化状态不存在")?;
    if intent.removed {
        return Err(format!("{CONTROL_ERROR}资料库已移除"));
    }
    if intent.epoch != epoch {
        return Err(format!("{CONTROL_ERROR}初始化期间资料库状态已更改"));
    }
    intent.paused = !start_now;
    intent.cancelled = false;
    intent.epoch = intent.epoch.saturating_add(1);
    intent.updated_at = clock_ms();
    persist(&runtime, &intents)?;
    state.intents = intents;
    state.control_revision = state.control_revision.saturating_add(1);
    touch(&mut state, library_id);
    Ok(())
}
pub(crate) fn obsidian_gate(root: &Path, vault: &Path) -> Result<Option<String>, String> {
    let database = root.join("craft-search.sqlite3");
    let connection = crate::open_database(&database)?;
    let canonical = std::fs::canonicalize(vault).unwrap_or_else(|_| vault.to_path_buf());
    let canonical = crate::display_local_path(&canonical).to_lowercase();
    let mut statement = connection
        .prepare("SELECT id,location FROM libraries WHERE provider='obsidian' AND enabled=1")
        .map_err(|_| "无法查询 Obsidian 资料库控制状态")?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(|_| "无法查询 Obsidian 资料库控制状态")?;
    for row in rows {
        let (id, location) = row.map_err(|_| "无法查询 Obsidian 资料库控制状态")?;
        if let Some(location) = location {
            let location =
                std::fs::canonicalize(&location).unwrap_or_else(|_| PathBuf::from(location));
            if crate::display_local_path(&location).to_lowercase() == canonical {
                gate(root, &id)?;
                return Ok(Some(id));
            }
        }
    }
    Ok(None)
}
pub(crate) fn complete_remove(
    root: &Path,
    library_id: &str,
    result: &Result<(), String>,
) -> Result<(), String> {
    let runtime = runtime(root)?;
    let mut state = runtime.state.lock().map_err(|_| "资料库控制状态不可用")?;
    if let Err(error) = result {
        state
            .errors
            .insert(library_id.into(), error.chars().take(320).collect());
        touch(&mut state, library_id);
        return Ok(());
    }
    let mut intents = state.intents.clone();
    let intent = intents.get_mut(library_id).ok_or("资料库移除状态不存在")?;
    if !intent.removed {
        return Err("资料库移除状态已改变".into());
    }
    intent.cleanup_complete = true;
    intent.updated_at = clock_ms();
    persist(&runtime, &intents)?;
    state.intents = intents;
    state.control_revision = state.control_revision.saturating_add(1);
    touch(&mut state, library_id);
    Ok(())
}

pub(crate) struct Cleanup {
    runtime: Arc<Runtime>,
    library_id: String,
}
pub(crate) fn begin_cleanup(root: &Path, library_id: &str) -> Result<Option<Cleanup>, String> {
    let runtime = runtime(root)?;
    let mut state = runtime.state.lock().map_err(|_| "资料库控制状态不可用")?;
    if !state
        .intents
        .get(library_id)
        .is_some_and(|intent| intent.removed && !intent.cleanup_complete)
        || !state.cleanup.insert(library_id.into())
    {
        return Ok(None);
    }
    drop(state);
    Ok(Some(Cleanup {
        runtime,
        library_id: library_id.into(),
    }))
}
impl Drop for Cleanup {
    fn drop(&mut self) {
        if let Ok(mut state) = self.runtime.state.lock() {
            state.cleanup.remove(&self.library_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn process_exit_stops_active_and_late_writes_without_persisting_pause() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("task-state/project-optimization-20261011/library-exit-tests")
            .join(crate::random_url_safe(16));
        std::fs::create_dir_all(&root).unwrap();
        control(&root, "vault", "resume").unwrap();
        let before = std::fs::read(root.join(FILE)).unwrap();
        let operation = begin(&root, "vault", "active OCR").unwrap();
        shutdown(&root);
        assert!(is_control_error(&operation.checkpoint().unwrap_err()));
        assert!(begin(&root, "vault", "late OCR").is_err());
        assert!(exists_gate(&root, "vault").is_err());
        let mut published = false;
        assert!(operation
            .commit(|| {
                published = true;
                Ok(())
            })
            .is_err());
        assert!(commit_existing(&root, "vault", || {
            published = true;
            Ok(())
        })
        .is_err());
        assert!(!published);
        assert_eq!(std::fs::read(root.join(FILE)).unwrap(), before);
        let restarted = State {
            intents: load_intents(&root).unwrap(),
            ..State::default()
        };
        assert!(allowed(&restarted, "vault", None).is_ok());
    }
    fn root() -> PathBuf {
        std::env::temp_dir().join(format!(
            "hub-library-runtime-test-{}",
            crate::random_url_safe(16)
        ))
    }
    #[test]
    fn library_management_pause_is_persistent_and_resume_rejects_old_work() {
        let root = root();
        let work = begin(&root, "vault", "更新").unwrap();
        assert_eq!(control(&root, "vault", "pause").unwrap().state, "pausing");
        assert!(is_control_error(&work.checkpoint().unwrap_err()));
        control(&root, "vault", "resume").unwrap();
        assert!(work.checkpoint().is_err());
        assert!(begin(&root, "vault", "新更新").is_ok());
        control(&root, "vault", "pause").unwrap();
        let restarted = State {
            intents: load_intents(&root).unwrap(),
            ..State::default()
        };
        assert_eq!(snapshot(&restarted, "vault").state, "paused");
        assert!(is_control_error(
            &allowed(&restarted, "vault", None).unwrap_err()
        ));
        drop(work);
        assert_eq!(status(&root, "vault").unwrap().state, "paused");
        let _ = std::fs::remove_dir_all(root);
    }
    #[test]
    fn library_management_remove_preserves_sources_and_prevents_late_commit() {
        let root = root();
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("original.md");
        std::fs::write(&source, "original").unwrap();
        let work = begin(&root, "vault", "更新").unwrap();
        control(&root, "vault", "remove").unwrap();
        assert!(work.checkpoint().is_err());
        assert!(gate(&root, "vault").is_err());
        assert!(control(&root, "vault", "resume").is_err());
        assert!(work
            .commit(|| {
                std::fs::write(&source, "late update").unwrap();
                Ok(())
            })
            .is_err());
        assert!(initialize(&root, "vault", true).is_err());
        complete_remove(&root, "vault", &Ok(())).unwrap();
        assert!(activate_initialized(&root, "vault", 0, true).is_err());
        assert_eq!(status(&root, "vault").unwrap().state, "removed");
        assert_eq!(std::fs::read_to_string(source).unwrap(), "original");
        let _ = std::fs::remove_dir_all(root);
    }
    #[test]
    fn library_management_different_libraries_have_independent_admission() {
        let root = root();
        let one = admission(&root, "one").unwrap();
        let two = admission(&root, "two").unwrap();
        let _held = one.try_lock().unwrap();
        assert!(two.try_lock().is_ok());
        assert!(one.try_lock().is_err());
        control(&root, "one", "cancel").unwrap();
        assert!(gate(&root, "one").is_err());
        assert!(gate(&root, "two").is_ok());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn library_management_repeated_controls_replace_durable_file_and_keep_revision() {
        let root = root();
        initialize(&root, "vault", true).unwrap();
        let work = begin(&root, "vault", "更新").unwrap();
        let accepted = status(&root, "vault").unwrap().updated_at;
        work.phase("fetching", "读取正文").unwrap();
        let fetching = status(&root, "vault").unwrap().updated_at;
        assert!(fetching > accepted);
        let paused = control(&root, "vault", "pause").unwrap().updated_at;
        assert!(paused > fetching);
        control(&root, "vault", "resume").unwrap();
        control(&root, "vault", "cancel").unwrap();
        let restarted = State {
            intents: load_intents(&root).unwrap(),
            ..State::default()
        };
        assert_eq!(snapshot(&restarted, "vault").state, "cancelled");
        assert!(allowed(&restarted, "vault", None).is_err());
        let before_drop = status(&root, "vault").unwrap().updated_at;
        drop(work);
        assert!(status(&root, "vault").unwrap().updated_at > before_drop);
        assert!(std::fs::read_dir(&root).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn library_management_staged_add_cannot_resume_after_later_pause_or_remove() {
        let root = root();
        let initial_epoch = initialize(&root, "vault", false).unwrap();
        control(&root, "vault", "pause").unwrap();
        assert!(is_control_error(
            &activate_initialized(&root, "vault", initial_epoch, true).unwrap_err()
        ));
        assert_eq!(status(&root, "vault").unwrap().state, "paused");
        let next_epoch = initialize(&root, "vault", false).unwrap();
        control(&root, "vault", "remove").unwrap();
        complete_remove(&root, "vault", &Ok(())).unwrap();
        assert!(activate_initialized(&root, "vault", next_epoch, true).is_err());
        assert_eq!(status(&root, "vault").unwrap().state, "removed");
        let _ = std::fs::remove_dir_all(root);
    }
}
