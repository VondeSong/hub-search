//! Whole-profile movement is a restart boundary. Inspection never upgrades a database.
use crate::{data_backup, database::DATABASE_SCHEMA_VERSION};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};

mod paths;
pub(crate) use paths::{apply_source_mappings, prepare_opened_root, remap_paths};

pub(crate) const SESSION_LOCK: &str = ".hub-session.lock";

/// The caller has copied a stopped profile and holds its exclusive session lease.
/// Materialize external originals on the destination disk, not the old disk.
pub(crate) fn finish_storage_move(source: &Path, target: &Path) -> Result<Value, String> {
    {
        let (mut connection, _writer) =
            crate::open_write_database(&target.join("craft-search.sqlite3"))?;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        remap_paths(&transaction, source, target)?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    let result = data_backup::consolidate(target, &AtomicBool::new(false), &mut |_| {})?;
    prepare_opened_root(target, false)?;
    Ok(result)
}
pub(crate) const MAINTENANCE_LOCK: &str = ".hub-maintenance.lock";
pub(crate) struct DataRootSession {
    pub root: PathBuf,
    _lease: File,
}

fn lock_file(root: &Path, name: &str, shared: bool) -> Result<File, String> {
    crate::craft_backup::reject_links(root)?;
    let path = root.join(name);
    crate::craft_backup::reject_links(&path)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|e| format!("无法锁定数据目录：{e}"))?;
    crate::file_lock::try_lock(&file, shared).map_err(|error| {
        if error.kind() == std::io::ErrorKind::WouldBlock {
            "数据仍在使用或正在备份，请等待操作结束；迁移前请退出使用此目录的其他 Hub / MCP 进程。"
                .to_string()
        } else {
            format!("无法锁定数据目录：{error}")
        }
    })?;
    Ok(file)
}
pub(crate) fn session_lease(root: &Path) -> Result<File, String> {
    lock_file(root, SESSION_LOCK, true)
}
pub(crate) fn exclusive_session(root: &Path) -> Result<File, String> {
    lock_file(root, SESSION_LOCK, false)
}
pub(crate) fn maintenance_lock(root: &Path) -> Result<File, String> {
    lock_file(root, MAINTENANCE_LOCK, false)
}
fn installation_host_identity(installation: &str) -> String {
    // A user may copy the entire default app-data folder, including its bootstrap.
    // Bind the transfer check to this Windows installation without storing its raw ID.
    #[cfg(windows)]
    {
        use winreg::{
            enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY},
            RegKey,
        };
        let machine = RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey_with_flags(
                "SOFTWARE\\Microsoft\\Cryptography",
                KEY_READ | KEY_WOW64_64KEY,
            )
            .and_then(|key| key.get_value::<String, _>("MachineGuid"))
            .ok()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| std::env::var("COMPUTERNAME").ok());
        if let Some(machine) = machine {
            return format!(
                "windows:{:x}",
                Sha256::digest(format!("{installation}\0{machine}").as_bytes())
            );
        }
    }
    installation.to_owned()
}
pub(crate) fn initialize_session(app: &AppHandle) -> Result<(), String> {
    let root = crate::active_data_root(app)?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let lease = session_lease(&root)?;
    let installation_id = if crate::isolated_runtime::enabled() {
        // An isolated run never reads or creates the real machine bootstrap.
        format!(
            "isolated:{:x}",
            Sha256::digest(crate::library_location::path_key(&root).as_bytes())
        )
    } else {
        let mut config = crate::read_storage_bootstrap(app);
        if config.installation_id.trim().is_empty() {
            config.installation_id = crate::random_url_safe(32);
            // This bootstrap stays in the installation's default app-data directory,
            // even when the active profile is portable or uses a custom directory.
            crate::write_storage_bootstrap(app, &config)?;
        }
        installation_host_identity(&config.installation_id)
    };
    paths::initialize_root_host(&root, &installation_id)?;
    data_backup::initialize_owned_data(&root)?;
    app.manage(DataRootSession {
        root,
        _lease: lease,
    });
    Ok(())
}

pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("保存位置没有父目录")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = parent.join(format!(".hub-write-{}.tmp", crate::random_url_safe(12)));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        drop(file);
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            #[link(name = "Kernel32")]
            unsafe extern "system" {
                fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
            }
            let from: Vec<_> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
            let to: Vec<_> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0x1 | 0x8) } == 0 {
                return Err(format!(
                    "无法原子保存设置：{}",
                    std::io::Error::last_os_error()
                ));
            }
        }
        #[cfg(not(windows))]
        fs::rename(&temporary, path).map_err(|e| e.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn hash_file(path: &Path, cancel: &AtomicBool) -> Result<String, String> {
    crate::craft_backup::reject_links(path)?;
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("操作已取消，原数据保持不变".into());
        }
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}
fn fingerprint(path: &Path, directory: bool, cancel: &AtomicBool) -> Result<String, String> {
    if !directory {
        return hash_file(path, cancel);
    }
    let mut digest = Sha256::new();
    for name in ["craft-search.sqlite3", "craft-search.sqlite3-wal"] {
        let file = path.join(name);
        if file.exists() {
            digest.update(name);
            digest.update(hash_file(&file, cancel)?);
        }
    }
    Ok(format!("{:x}", digest.finalize()))
}

pub(crate) fn verify_database(root: &Path) -> Result<i64, String> {
    crate::craft_backup::reject_links(root)?;
    let path = root.join("craft-search.sqlite3");
    crate::craft_backup::reject_links(&path)?;
    let c = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("这不是可读取的 Hub 数据目录：{e}"))?;
    let schema: i64 = c
        .query_row(
            "SELECT CAST(value AS INTEGER) FROM metadata WHERE key='schema_version'",
            [],
            |r| r.get(0),
        )
        .map_err(|_| "目录中缺少 Hub 数据库版本信息")?;
    if schema < 1 || schema > DATABASE_SCHEMA_VERSION {
        return Err(format!("数据版本 {schema} 无法由当前程序打开（支持至 {DATABASE_SCHEMA_VERSION}），请使用兼容版本。"));
    }
    let check: String = c
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if check != "ok" {
        return Err(format!("数据库完整性检查失败：{check}"));
    }
    c.prepare("SELECT id FROM libraries LIMIT 0")
        .map_err(|_| "数据库缺少资料库结构")?;
    Ok(schema)
}

#[derive(Clone)]
struct Inspection {
    path: PathBuf,
    fingerprint: String,
    directory: bool,
    at: Instant,
}
static INSPECTIONS: LazyLock<Mutex<HashMap<String, Inspection>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
fn remember(path: PathBuf, fingerprint: String, directory: bool) -> Result<String, String> {
    let token = crate::random_url_safe(24);
    let mut cache = INSPECTIONS.lock().map_err(|_| "检查状态不可用")?;
    cache.retain(|_, value| value.at.elapsed() < Duration::from_secs(1800));
    if cache.len() >= 16 {
        cache.clear();
    }
    cache.insert(
        token.clone(),
        Inspection {
            path,
            fingerprint,
            directory,
            at: Instant::now(),
        },
    );
    Ok(token)
}
fn checked_token(token: &str, directory: bool, cancel: &AtomicBool) -> Result<Inspection, String> {
    let value = INSPECTIONS
        .lock()
        .map_err(|_| "检查状态不可用")?
        .get(token)
        .cloned()
        .ok_or("检查结果已过期，请重新检查")?;
    if value.directory != directory
        || value.at.elapsed() >= Duration::from_secs(1800)
        || fingerprint(&value.path, directory, cancel)? != value.fingerprint
    {
        return Err("检查后源数据发生变化，请重新检查后再继续".into());
    }
    Ok(value)
}

fn count_table(c: &Connection, table: &str) -> Result<u64, String> {
    let exists: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
            [table],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !exists {
        return Ok(0);
    }
    c.query_row(&format!("SELECT count(*) FROM \"{table}\""), [], |r| {
        r.get(0)
    })
    .map_err(|e| e.to_string())
}
fn dependency_status(root: &Path) -> Result<Vec<Value>, String> {
    data_backup::dependencies(root)?
        .into_iter()
        .map(|dependency| {
            let can_relocate = matches!(
                dependency.kind.as_str(),
                "obsidian" | "craftBackup" | "reading"
            );
            let mut value = serde_json::to_value(&dependency).map_err(|e| e.to_string())?;
            value["canRelocate"] = json!(can_relocate);
            value["description"] = json!(if dependency.available {
                "来源路径可用"
            } else {
                "此电脑未找到原来源，请重新定位或重新连接"
            });
            Ok(value)
        })
        .collect()
}
fn inspect_directory(path: &Path, cancel: &AtomicBool) -> Result<Value, String> {
    let root = path
        .canonicalize()
        .map_err(|e| format!("无法访问数据目录：{e}"))?;
    if !root.join("craft-search.sqlite3").is_file() {
        return Err(if root.join(".hub-export/manifest.json").is_file() || root.join(".obsidian").is_dir() {
            "这是 Craft 导出或 Obsidian 阅读库，不是 Hub 数据目录。可在 Obsidian 中打开或添加为 Obsidian 资料库；完整搬家请选择包含 craft-search.sqlite3 的 Hub 数据目录，或恢复 .hubbackup。"
        } else { "此文件夹没有 Hub 数据库 craft-search.sqlite3；请选择 Hub 数据目录或使用“从备份恢复”。" }.into());
    }
    let _session = exclusive_session(&root)?;
    let schema = verify_database(&root)?;
    let c = Connection::open_with_flags(
        root.join("craft-search.sqlite3"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| e.to_string())?;
    let mut warnings = vec![
        "此目录保存 Hub 数据。如果原电脑已准备加密授权副本，可在此目录打开后输入迁移密码恢复授权。"
            .to_string(),
    ];
    if count_table(&c, "user_profile_values")? == 0 {
        warnings.push("此目录没有已迁入的个人设置。若来自旧版，请先在原电脑升级，确认收藏、视图和草稿已保存后再复制。".into());
    }
    let token = remember(root.clone(), fingerprint(&root, true, cancel)?, true)?;
    Ok(json!({"token":token,"path":root,"schemaVersion":schema,
        "libraries":count_table(&c,"libraries")?,"documents":count_table(&c,"documents")?,
        "profileValues":count_table(&c,"user_profile_values")?,"warnings":warnings,
        "dependencies":dependency_status(&root)?}))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingOpen {
    pub path: String,
    pub fingerprint: String,
}

pub(crate) fn complete_pending_open(app: &AppHandle) -> Result<(), String> {
    let mut config = crate::read_storage_bootstrap(app);
    let original_config = config.clone();
    let Some(pending) = config.pending_open.clone() else {
        return Ok(());
    };
    let result = (|| {
        let root = PathBuf::from(&pending.path);
        let _session = exclusive_session(&root)?;
        let _maintenance = maintenance_lock(&root)?;
        if fingerprint(&root, true, &AtomicBool::new(false))? != pending.fingerprint {
            return Err("待打开的数据在重启前发生变化，已保留原目录；请重新检查。".into());
        }
        verify_database(&root)?;
        prepare_opened_root(&root, true)?;
        config.mode = crate::STORAGE_MODE_CUSTOM.into();
        config.custom_path = Some(crate::sources::display_local_path(&root));
        config.pending = None;
        config.pending_open = None;
        config.last_error = None;
        // Explicit selection wins over a marker next to this executable.
        config.prefer_config = true;
        crate::write_storage_bootstrap(app, &config)
    })();
    if let Err(error) = &result {
        config = original_config;
        config.pending_open = None;
        config.last_error = Some(error.clone());
        let _ = crate::write_storage_bootstrap(app, &config);
    }
    result
}

struct ActiveOperation {
    id: String,
    phase: String,
    cancel: Arc<AtomicBool>,
}
static ACTIVE: LazyLock<Mutex<Option<ActiveOperation>>> = LazyLock::new(|| Mutex::new(None));
struct Operation {
    id: String,
    cancel: Arc<AtomicBool>,
}
impl Operation {
    fn begin(id: &str, phase: &str) -> Result<Self, String> {
        let mut active = ACTIVE.lock().map_err(|_| "数据操作状态不可用")?;
        if active.is_some() {
            return Err("已有数据操作正在进行，请等待完成或取消后再试".into());
        }
        let id = if id.is_empty() {
            crate::random_url_safe(16)
        } else {
            id.to_string()
        };
        if id.len() > 120 {
            return Err("操作标识过长".into());
        }
        let cancel = Arc::new(AtomicBool::new(false));
        *active = Some(ActiveOperation {
            id: id.clone(),
            phase: phase.into(),
            cancel: cancel.clone(),
        });
        Ok(Self { id, cancel })
    }
}
impl Drop for Operation {
    fn drop(&mut self) {
        if let Ok(mut active) = ACTIVE.lock() {
            if active.as_ref().is_some_and(|value| value.id == self.id) {
                *active = None;
            }
        }
    }
}
fn required<'a>(args: &'a Value, name: &str) -> Result<&'a str, String> {
    args[name]
        .as_str()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| format!("缺少 {name}"))
}
fn schedule_open(app: &AppHandle, inspection: &Inspection) -> Result<(), String> {
    if crate::isolated_runtime::enabled() {
        return Err("隔离验证不会更改本机启动目录".into());
    }
    let mut config = crate::read_storage_bootstrap(app);
    config.pending_open = Some(PendingOpen {
        path: crate::sources::display_local_path(&inspection.path),
        fingerprint: inspection.fingerprint.clone(),
    });
    config.pending = None;
    config.last_error = None;
    crate::write_storage_bootstrap(app, &config)
}
fn restart(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(450)).await;
        crate::window_lifecycle::request_profile_restart(&app);
    });
}

#[tauri::command]
pub(crate) async fn data_portability(app: AppHandle, args: Value) -> Result<Value, String> {
    let action = required(&args, "action")?.to_string();
    if action == "cancel" {
        let id = required(&args, "operationId")?;
        let active = ACTIVE.lock().map_err(|_| "数据操作状态不可用")?;
        let operation = active
            .as_ref()
            .filter(|o| o.id == id)
            .ok_or("此操作已经结束")?;
        operation.cancel.store(true, Ordering::Relaxed);
        return Ok(json!({"cancelling":true}));
    }
    if action == "relocate_dependency" {
        let _operation = Operation::begin(args["operationId"].as_str().unwrap_or(""), &action)?;
        return paths::relocate_dependency(app, &args).await;
    }
    let root = crate::active_data_root(&app)?;
    let app_for_work = app.clone();
    let result = tokio::task::spawn_blocking(move || {
        if action == "status" || action == "storage_status" {
            let active = ACTIVE.lock().map_err(|_| "数据操作状态不可用")?.as_ref().map(|o| json!({"operationId":o.id,"phase":o.phase}));
            if action == "storage_status" {
                let mut value=crate::data_management::storage_status(&root)?;
                value["activeOperation"]=json!(active);
                return Ok(value);
            }
            return Ok(json!({"root":root,"usage":data_backup::usage(&root)?,
                "dependencies":dependency_status(&root)?,"schedule":data_backup::load_auto_config(&root)?,
                "activeOperation":active,"hasAccountCopy":root.join(crate::account_migration::FILE).is_file(),"warnings":["整体复制此数据目录即可搬家；Obsidian 原始库由你移动后重新加载。账号授权可选择加密放入同一目录。"]}));
        }
        let operation = Operation::begin(args["operationId"].as_str().unwrap_or(""), &action)?;
        let mut progress = |p: data_backup::Progress| {
            let mut value = serde_json::to_value(p).unwrap_or_else(|_| json!({}));
            value["operationId"] = json!(operation.id);
            let _ = app_for_work.emit("data-portability-progress", value);
        };
        match action.as_str() {
            "list_large_files" => crate::data_backup::large_files::list(&root,&args,&operation.cancel),
            "reveal_large_file" => {
                let path=crate::data_backup::large_files::checked_path(&root,required(&args,"relativePath")?)?;
                tauri_plugin_opener::reveal_item_in_dir(path).map_err(|e|e.to_string())?;
                Ok(json!({"revealed":true}))
            }
            "preview_recovery_cleanup" => {
                progress(data_backup::Progress {phase:"inspectRecoveryCopies".into(),completed_bytes:0,total_bytes:None,completed_files:0,total_files:None});
                crate::data_management::preview_cleanup(&root,&operation.cancel)
            }
            "schedule_recovery_cleanup" => {
                let status=crate::data_management::schedule_cleanup(&root,required(&args,"token")?)?;
                drop(operation);
                let _=app_for_work.emit("data-portability-updated",json!({"action":"schedule_recovery_cleanup"}));
                Ok(json!({"status":status,"restartRequired":false}))
            }
            "cancel_recovery_cleanup" => {
                let status=crate::data_management::cancel_cleanup(&root)?;
                drop(operation);
                let _=app_for_work.emit("data-portability-updated",json!({"action":"cancel_recovery_cleanup"}));
                Ok(json!(status))
            }
            "account_catalog" => crate::account_migration::catalog(&app_for_work,&root),
            "remove_accounts_copy" => crate::account_migration::remove_copy(&root),
            "prepare_accounts" => {
                let ids: Vec<String> = serde_json::from_value(args["ids"].clone()).map_err(|_|"迁移项目无效")?;
                let accounts=crate::account_migration::prepare(&app_for_work,&root,&ids,required(&args,"password")?)?;
                Ok(json!({"root":root,"ready":true,"warnings":[],"hasAccountCopy":true,"accounts":accounts}))
            }
            "prepare_copy" => {
                let mut result=crate::data_backup::consolidate(&root,&operation.cancel,&mut progress)?;
                if args["includeCredentials"].as_bool().unwrap_or(false) {
                    let ids: Vec<String> = serde_json::from_value(args["ids"].clone()).map_err(|_|"迁移项目无效")?;
                    match crate::account_migration::prepare(&app_for_work,&root,&ids,required(&args,"password")?) {
                        Ok(accounts)=>result["accounts"]=accounts,
                        Err(error)=>{result["ready"]=json!(false);result["warnings"].as_array_mut().unwrap().push(json!(format!("现有文件已收拢，但授权副本未更新：{error}。如目录中已有旧授权副本，它仍被保留。")));}
                    }
                }
                result["hasAccountCopy"]=json!(root.join(crate::account_migration::FILE).is_file()); Ok(result)
            }
            "inspect_accounts" => {
                let path = root.join(crate::account_migration::FILE).canonicalize().map_err(|_|"本数据目录没有加密授权副本")?;
                let before = fingerprint(&path,false,&operation.cancel)?;
                let mut preview = crate::account_migration::inspect(&app_for_work,&root,&path,required(&args,"password")?)?;
                if before != fingerprint(&path,false,&operation.cancel)? { return Err("授权包在检查时发生变化，请重新选择".into()); }
                preview["token"] = json!(remember(path,before,false)?); Ok(preview)
            }
            "import_accounts" => {
                let checked = checked_token(required(&args,"token")?,false,&operation.cancel)?;
                if args["targetRoot"].as_str() != root.to_str() { return Err("当前数据目录已改变，请重新检查授权包".into()); }
                let ids: Vec<String> = serde_json::from_value(args["ids"].clone()).map_err(|_|"迁移项目无效")?;
                crate::account_migration::import(&app_for_work,&root,&checked.path,required(&args,"password")?,&ids,args["overwrite"].as_bool().unwrap_or(false))
            }
            "inspect_directory" => inspect_directory(Path::new(required(&args,"path")?), &operation.cancel),
            "open_directory" => {
                let checked = checked_token(required(&args,"token")?, true, &operation.cancel)?;
                if checked.path == root { return Ok(json!({"restartRequired":false})); }
                let _session = exclusive_session(&checked.path)?;
                verify_database(&checked.path)?;
                schedule_open(&app_for_work, &checked)?;
                Ok(json!({"restartRequired":true}))
            }
            "create_backup" => {
                let options = data_backup::BackupOptions { destination:required(&args,"destination")?.into(), include_external_sources:false };
                Ok(json!(data_backup::backup(&root,&options,&operation.cancel,&mut progress)?))
            }
            "inspect_backup" => {
                let path = Path::new(required(&args,"path")?).canonicalize().map_err(|e|e.to_string())?;
                let before = fingerprint(&path,false,&operation.cancel)?;
                let summary = data_backup::inspect(&path,&operation.cancel,&mut progress)?;
                if before != fingerprint(&path,false,&operation.cancel)? { return Err("备份在检查过程中发生变化，请重试".into()); }
                let token = remember(path,before,false)?;
                let mut value = json!(summary); value["token"] = json!(token); Ok(value)
            }
            "restore_backup" => {
                let checked = checked_token(required(&args,"token")?,false,&operation.cancel)?;
                let destination = Path::new(required(&args,"destination")?);
                let mut restored = data_backup::restore(&checked.path,destination,&operation.cancel,&mut progress)?;
                // The verified target is published now: report it even if follow-up preparation fails.
                let prepared = match paths::finish_restore(Path::new(&restored.destination),&restored.path_mappings) {
                    Ok(()) => { restored.warnings = paths::completed_restore_warnings(&restored.warnings); true },
                    Err(error) => { restored.warnings.push(format!("数据已恢复到 {}，路径准备未完成：{error}。请保留此目录并重新检查。",restored.destination)); false }
                };
                let mut open_after = prepared && args["openAfterRestore"].as_bool().unwrap_or(false);
                if open_after {
                    let scheduled = (|| -> Result<(),String> {
                        let path = PathBuf::from(&restored.destination).canonicalize().map_err(|e|e.to_string())?;
                        schedule_open(&app_for_work,&Inspection { fingerprint:fingerprint(&path,true,&AtomicBool::new(false))?,path,directory:true,at:Instant::now() })
                    })();
                    if let Err(error) = scheduled { open_after = false; restored.warnings.push(format!("恢复已完成，未切换目录：{error}")); }
                }
                let mut value = json!(restored); value["restartRequired"] = json!(open_after); Ok(value)
            }
            "save_schedule" => {
                let config: data_backup::AutoBackupConfig = serde_json::from_value(args["config"].clone()).map_err(|e|format!("自动备份设置无效：{e}"))?;
                data_backup::save_auto_config(&root,&config)?;
                Ok(json!(data_backup::load_auto_config(&root)?))
            }
            _ => Err("未知数据管理操作".into()),
        }
    }).await.map_err(|e|format!("数据管理操作中断：{e}"))??;
    if result["restartRequired"] == true {
        restart(&app);
    }
    Ok(result)
}

pub(crate) fn start_scheduler(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        while crate::background_workers::wait(Duration::from_secs(60)).await {
            let app = app.clone();
            let _ = tokio::task::spawn_blocking(move || -> Result<(), String> {
                let root = crate::active_data_root(&app)?;
                let operation = Operation::begin("", "automatic_backup")?;
                let mut progress = |p: data_backup::Progress| {
                    let mut value = serde_json::to_value(p).unwrap_or_else(|_| json!({}));
                    value["operationId"] = json!(operation.id);
                    let _ = app.emit("data-portability-progress", value);
                };
                let outcome = data_backup::run_due(&root, &operation.cancel, &mut progress);
                drop(operation);
                let _ = app.emit("data-portability-updated", ());
                outcome.map(|_| ())
            })
            .await;
        }
    });
}
pub(crate) fn shutdown() {
    if let Ok(active) = ACTIVE.lock() {
        if let Some(active) = active.as_ref() {
            active.cancel.store(true, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests;
