//! Explicit cloud maintenance. Verified replacement records precede every exact deletion.
//! Domain import/export owns merge rules; this coordinator never garbage-collects blobs.
use super::*;
use crate::reading_sync::object_store::{self, Store};

mod checkpoint;
mod devices;
mod history;
mod inventory;
mod progress;
mod proof_stream;
#[cfg(test)]
pub(crate) mod tests;

const DEVICE_PREFIX: &str = "reading/devices-v1/changes/";
const PROOF_PREFIX: &str = "reading/checkpoints-v1/proofs/";
const MAX_OBJECTS: usize = 200_000;
const MAX_STAGED_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const ROUND_BYTES: usize = 32 * 1024 * 1024;

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn schema(c: &Connection) -> Result<(), String> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS cloud_device_events(namespace TEXT NOT NULL,device TEXT NOT NULL,kind TEXT NOT NULL,clock INTEGER NOT NULL,writer TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(namespace,device,kind));
        CREATE TABLE IF NOT EXISTS cloud_device_pending(namespace TEXT NOT NULL,id TEXT NOT NULL,body BLOB NOT NULL,PRIMARY KEY(namespace,id));
        CREATE TABLE IF NOT EXISTS cloud_maintenance_runs(namespace TEXT NOT NULL,id TEXT NOT NULL,configuration TEXT NOT NULL,state TEXT NOT NULL,phase TEXT NOT NULL,created_at INTEGER NOT NULL,completed_at INTEGER NOT NULL,error TEXT NOT NULL,proof TEXT NOT NULL,purpose TEXT NOT NULL,PRIMARY KEY(namespace,id));
        CREATE TABLE IF NOT EXISTS cloud_maintenance_objects(namespace TEXT NOT NULL,run TEXT NOT NULL,key TEXT NOT NULL,kind TEXT NOT NULL,body BLOB NOT NULL,status TEXT NOT NULL,replacement INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(namespace,run,key,replacement));
        CREATE INDEX IF NOT EXISTS cloud_maintenance_objects_progress ON cloud_maintenance_objects(namespace,run,replacement,status);")
    .map_err(|e|e.to_string())?;
    crate::local_database_maintenance::ensure_sequences(
        c,
        &[
            "cloud_device_events",
            "cloud_device_pending",
            "cloud_maintenance_runs",
        ],
    )?;
    c.execute("CREATE INDEX IF NOT EXISTS cloud_maintenance_latest ON cloud_maintenance_runs(namespace,created_at DESC,local_seq DESC)",[]).map_err(|e|e.to_string())?;
    progress::schema(c)
}
/// Called only with the database writer. Status consumers themselves are pure reads.
fn prepare_status(c: &Connection) -> Result<(), String> {
    let installed:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='cloud_maintenance_storage')",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    let ready = installed
        && c.query_row(
            "SELECT EXISTS(SELECT 1 FROM cloud_maintenance_storage WHERE id=1)",
            [],
            |r| r.get::<_, bool>(0),
        )
        .map_err(|e| e.to_string())?;
    if !ready {
        schema(c)?;
    }
    flashcard_sync_device_id(c)?;
    Ok(())
}
fn require_enabled(c: &Connection) -> Result<(), String> {
    if !cloud_sync::policy(c).enabled {
        return Err("本设备云同步已暂停，请先开启云同步再执行维护".into());
    }
    Ok(())
}
fn source(c: &Connection) -> Result<(String, String), String> {
    let namespace = object_store::namespace(c)?;
    let configuration =
        serde_json::to_string(&object_store::configuration(c)?).map_err(|e| e.to_string())?;
    Ok((namespace, configuration))
}
fn remote(app: &AppHandle, db: &PathBuf) -> Result<(Box<dyn Store>, String, String), String> {
    let c = open_database(db)?;
    require_enabled(&c)?;
    let (ns, configuration) = source(&c)?;
    Ok((object_store::store(app, &c)?, ns, configuration))
}
fn check_network(remote: &dyn Store) -> Result<(), String> {
    // Maintenance contains reading records too; its small control objects follow that policy.
    remote.check_network(&remote.key("reading/"))
}
fn set_run(
    c: &Connection,
    ns: &str,
    id: &str,
    state: &str,
    phase: &str,
    error: &str,
) -> Result<(), String> {
    c.execute("UPDATE cloud_maintenance_runs SET state=?3,phase=?4,error=?5,completed_at=CASE WHEN ?3='complete' THEN ?6 ELSE completed_at END WHERE namespace=?1 AND id=?2",params![ns,id,state,phase,error,now_timestamp()]).map_err(|e|e.to_string())?;
    Ok(())
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModuleProgress {
    module: String,
    objects: usize,
    read: usize,
    checkpoints: usize,
    verified: usize,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Plan {
    token: String,
    purpose: String,
    state: String,
    phase: String,
    objects: usize,
    read: usize,
    checkpoints: usize,
    verified: usize,
    deleted: usize,
    staged_bytes: u64,
    created_at: i64,
    completed_at: i64,
    can_advance: bool,
    can_clean: bool,
    can_restore: bool,
    errors: Vec<String>,
    modules: Vec<ModuleProgress>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    supported: bool,
    current_device: String,
    devices: Vec<devices::DeviceView>,
    plan: Option<Plan>,
    confirmed_checkpoint: String,
}
fn plan(c: &Connection, ns: &str, id: &str) -> Result<Plan, String> {
    let (state,phase,error,created_at,completed_at,purpose):(String,String,String,i64,i64,String)=c.query_row("SELECT state,phase,error,created_at,completed_at,purpose FROM cloud_maintenance_runs WHERE namespace=?1 AND id=?2",params![ns,id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).map_err(|_|"维护批次不存在，请重新预览")?;
    let mut q=c.prepare("SELECT kind,replacement,status,objects,body_bytes FROM cloud_maintenance_progress WHERE namespace=?1 AND run=?2 AND objects>0").map_err(|e|e.to_string())?;
    let rows = q
        .query_map(params![ns, id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, bool>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, usize>(3)?,
                r.get::<_, u64>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut modules: BTreeMap<String, ModuleProgress> = BTreeMap::new();
    let (mut objects, mut read, mut checkpoints, mut verified, mut deleted, mut staged_bytes) =
        (0, 0, 0, 0, 0, 0);
    for row in rows {
        let (kind, replacement, status, count, bytes) = row.map_err(|e| e.to_string())?;
        staged_bytes += bytes;
        let m = modules.entry(kind.clone()).or_insert(ModuleProgress {
            module: kind,
            objects: 0,
            read: 0,
            checkpoints: 0,
            verified: 0,
        });
        if replacement {
            checkpoints += count;
            m.checkpoints += count;
            if status == "verified" {
                verified += count;
                m.verified += count;
            }
        } else {
            objects += count;
            m.objects += count;
            if status != "pending" {
                read += count;
                m.read += count;
            }
            if status == "deleted" {
                deleted += count;
            }
        }
    }
    Ok(Plan {
        token: id.into(),
        purpose,
        state: state.clone(),
        phase: phase.clone(),
        objects,
        read,
        checkpoints,
        verified,
        deleted,
        staged_bytes,
        created_at,
        completed_at,
        can_advance: matches!(phase.as_str(), "read" | "build" | "publish" | "verify"),
        can_clean: matches!(phase.as_str(), "ready" | "delete" | "deleteVerify"),
        can_restore: checkpoints > 0
            && staged_bytes > 0
            && matches!(
                phase.as_str(),
                "ready"
                    | "delete"
                    | "done"
                    | "restore"
                    | "restoreVerify"
                    | "restoreReady"
                    | "restoreSourceVerify"
            ),
        errors: if error.is_empty() {
            Vec::new()
        } else {
            vec![error]
        },
        modules: modules.into_values().collect(),
    })
}
fn status(c: &Connection) -> Result<Status, String> {
    let current = metadata_string(c, "flashcard_sync_device_id");
    if current.trim().is_empty() {
        return Err("设备状态尚未完成初始化".into());
    }
    let Ok((ns, _)) = source(c) else {
        return Ok(Status {
            supported: false,
            current_device: current,
            devices: Vec::new(),
            plan: None,
            confirmed_checkpoint: String::new(),
        });
    };
    let latest:Option<String>=c.query_row("SELECT id FROM cloud_maintenance_runs WHERE namespace=?1 ORDER BY created_at DESC,local_seq DESC LIMIT 1",[&ns],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    Ok(Status {
        supported: true,
        devices: devices::view(c, &ns, &current)?,
        plan: latest.map(|id| plan(c, &ns, &id)).transpose()?,
        current_device: current,
        confirmed_checkpoint: metadata_string(
            c,
            &format!("cloud_maintenance_confirmed_{}", digest(ns.as_bytes())),
        ),
    })
}
fn check_scope(c: &Connection, ns: &str, id: &str, configuration: &str) -> Result<(), String> {
    require_enabled(c)?;
    let stored: String = c
        .query_row(
            "SELECT configuration FROM cloud_maintenance_runs WHERE namespace=?1 AND id=?2",
            params![ns, id],
            |r| r.get(0),
        )
        .map_err(|_| "维护批次已过期，请重新预览")?;
    if stored != configuration || source(c)? != (ns.into(), configuration.into()) {
        return Err("云连接已变化，旧维护批次不能继续，请重新预览".into());
    }
    Ok(())
}
#[tauri::command]
pub(crate) fn get_cloud_maintenance_status(app: AppHandle) -> Result<Status, String> {
    let (c, _writer) = open_write_database(&database_path(&app)?)?;
    prepare_status(&c)?;
    status(&c)
}
#[tauri::command]
pub(crate) async fn refresh_cloud_devices(app: AppHandle) -> Result<Status, String> {
    let _flash = FLASHCARD_SYNC_LOCK.lock().await;
    let _reading = reading_sync::LOCK.lock().await;
    let db = database_path(&app)?;
    let (remote, ns, _) = remote(&app, &db)?;
    devices::refresh(&db, remote.as_ref(), &ns, true).await?;
    let c = open_database(&db)?;
    status(&c)
}
#[tauri::command]
pub(crate) async fn set_cloud_device_retired(
    app: AppHandle,
    device: String,
    retired: bool,
) -> Result<Status, String> {
    #[cfg(mobile)]
    return Err("设备管理请在桌面端执行".into());
    let _flash = FLASHCARD_SYNC_LOCK.lock().await;
    let _reading = reading_sync::LOCK.lock().await;
    let db = database_path(&app)?;
    let (remote, ns, _) = remote(&app, &db)?;
    devices::refresh(&db, remote.as_ref(), &ns, false).await?;
    {
        let (c, _writer) = open_write_database(&db)?;
        devices::retire(&c, &ns, &device, retired)?;
    }
    devices::refresh(&db, remote.as_ref(), &ns, false).await?;
    let c = open_database(&db)?;
    status(&c)
}
#[tauri::command]
pub(crate) async fn preview_cloud_history_cleanup(app: AppHandle) -> Result<Plan, String> {
    #[cfg(mobile)]
    return Err("生成维护检查点请在桌面端执行".into());
    let _flash = FLASHCARD_SYNC_LOCK.lock().await;
    let _reading = reading_sync::LOCK.lock().await;
    let db = database_path(&app)?;
    let (remote, ns, configuration) = remote(&app, &db)?;
    let snapshot = None;
    history::preview_with_snapshot(
        &db,
        remote.as_ref(),
        &ns,
        &configuration,
        "cleanup",
        snapshot,
    )
    .await
}
#[tauri::command]
pub(crate) async fn advance_cloud_history_cleanup(
    app: AppHandle,
    token: String,
) -> Result<Plan, String> {
    #[cfg(mobile)]
    return Err("生成维护检查点请在桌面端执行".into());
    let _flash = FLASHCARD_SYNC_LOCK.lock().await;
    let _reading = reading_sync::LOCK.lock().await;
    let db = database_path(&app)?;
    let (remote, ns, configuration) = remote(&app, &db)?;
    history::advance(&db, remote.as_ref(), &ns, &configuration, &token).await
}
#[tauri::command]
pub(crate) async fn clean_cloud_history(app: AppHandle, token: String) -> Result<Plan, String> {
    #[cfg(mobile)]
    return Err("清理云历史请在桌面端执行".into());
    let _flash = FLASHCARD_SYNC_LOCK.lock().await;
    let _reading = reading_sync::LOCK.lock().await;
    let db = database_path(&app)?;
    let (remote, ns, configuration) = remote(&app, &db)?;
    history::clean(&db, remote.as_ref(), &ns, &configuration, &token).await
}
#[tauri::command]
pub(crate) async fn restore_cloud_history(app: AppHandle, token: String) -> Result<Plan, String> {
    let _flash = FLASHCARD_SYNC_LOCK.lock().await;
    let _reading = reading_sync::LOCK.lock().await;
    let db = database_path(&app)?;
    let (remote, ns, configuration) = remote(&app, &db)?;
    let snapshot = None;
    history::restore_with_snapshot(&db, remote.as_ref(), &ns, &configuration, &token, snapshot)
        .await
}
#[tauri::command]
pub(crate) async fn preview_cloud_restore(app: AppHandle) -> Result<Plan, String> {
    let _flash = FLASHCARD_SYNC_LOCK.lock().await;
    let _reading = reading_sync::LOCK.lock().await;
    let db = database_path(&app)?;
    let (remote, ns, configuration) = remote(&app, &db)?;
    let snapshot = None;
    history::preview_with_snapshot(
        &db,
        remote.as_ref(),
        &ns,
        &configuration,
        "restore",
        snapshot,
    )
    .await
}
#[tauri::command]
pub(crate) async fn advance_cloud_restore(app: AppHandle, token: String) -> Result<Plan, String> {
    let _flash = FLASHCARD_SYNC_LOCK.lock().await;
    let _reading = reading_sync::LOCK.lock().await;
    let db = database_path(&app)?;
    let (remote, ns, configuration) = remote(&app, &db)?;
    history::advance_restore(&db, remote.as_ref(), &ns, &configuration, &token).await
}
#[tauri::command]
pub(crate) async fn release_cloud_maintenance(app: AppHandle) -> Result<Status, String> {
    let _flash = FLASHCARD_SYNC_LOCK.lock().await;
    let _reading = reading_sync::LOCK.lock().await;
    let db = database_path(&app)?;
    let (c, _writer) = open_write_database(&db)?;
    history::release(&c)?;
    flashcard_sync_device_id(&c)?;
    status(&c)
}
/// Call after a successful formal sync, with its existing lock still held. Publication failure
/// leaves a durable retry event and must not turn a completed domain sync into a false failure.
pub(crate) async fn observe_sync_success(
    db: &PathBuf,
    remote: &dyn Store,
    ns: &str,
) -> Result<(), String> {
    {
        let (c, _writer) = open_write_database(db)?;
        schema(&c)?;
        devices::observe(&c, ns)?;
    }
    devices::flush(db, remote, ns).await
}
