//! Current-data accounting and explicit, offline cleanup of proven duplicate copies.
//! Missing manifests, unique files and every business reference remain protected.
use crate::data_backup::consolidation_manifest::{Manifest, ManifestFile};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        LazyLock, Mutex,
    },
    time::{Duration, Instant},
};

const DIRECTORY: &str = "data-backup-v1/cleanup";
const MANIFESTS: &str = "data-backup-v1/consolidation-manifests";
const MAX_JSON: u64 = 64 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CleanupStatus {
    pub id: String,
    pub phase: String,
    pub error: String,
    pub planned_files: u64,
    pub planned_logical_bytes: u64,
    pub deleted_files: u64,
    pub deleted_logical_bytes: u64,
    pub retained_files: u64,
    pub updated_at: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Candidate {
    path: String,
    bytes: u64,
    sha256: String,
    keeper: String,
    manifest: String,
    manifest_sha256: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Plan {
    root: String,
    references: String,
    files: Vec<Candidate>,
}
struct Inspection {
    plan: Plan,
    at: Instant,
}
static INSPECTIONS: LazyLock<Mutex<BTreeMap<String, Inspection>>> =
    LazyLock::new(|| Mutex::new(BTreeMap::new()));

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}
fn id_valid(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())
}
fn check_cancel(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) {
        Err("检查已取消，文件保持原位".into())
    } else {
        Ok(())
    }
}
fn key(path: &Path) -> String {
    crate::library_location::path_key(path)
}
fn within(path: &Path, root: &Path) -> bool {
    let p = key(path);
    let r = key(root);
    p == r || p.starts_with(&format!("{r}/"))
}
fn safe(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.is_empty()
        || relative.contains('\\')
        || relative.contains(':')
        || !Path::new(relative)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err("清理记录包含无效相对路径，文件保留".into());
    }
    let path = root.join(relative);
    crate::craft_backup::reject_links(&path)?;
    if !within(&path, root) {
        return Err("清理记录超出当前数据目录".into());
    }
    Ok(path)
}
fn owned_file(id: &str, relative: &str) -> bool {
    id_valid(id)
        && (relative == format!("data-backup-v1/consolidate-{id}.sqlite3")
            || relative.starts_with(&format!("external-sources/prepared-{id}/")))
}
fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    crate::craft_backup::reject_links(path)?;
    if fs::metadata(path).map_err(|e| e.to_string())?.len() > MAX_JSON {
        return Err("数据管理记录过大，未执行清理".into());
    }
    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| format!("数据管理记录损坏：{e}"))
}
fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    crate::craft_backup::reject_links(path)?;
    crate::data_portability::atomic_write(
        path,
        &serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?,
    )
}
fn hash(path: &Path, cancel: &AtomicBool) -> Result<String, String> {
    crate::craft_backup::reject_links(path)?;
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let before = file.metadata().map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 128 * 1024];
    let mut total = 0u64;
    loop {
        check_cancel(cancel)?;
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        total += n as u64;
        digest.update(&buffer[..n]);
    }
    let after = file.metadata().map_err(|e| e.to_string())?;
    if total != before.len()
        || before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
    {
        return Err("文件在检查中变化，请重新检查".into());
    }
    Ok(format!("{:x}", digest.finalize()))
}
fn file_matches(
    path: &Path,
    bytes: u64,
    sha256: &str,
    cancel: &AtomicBool,
) -> Result<bool, String> {
    match fs::metadata(path) {
        Ok(meta) if meta.is_file() && meta.len() == bytes => Ok(hash(path, cancel)? == sha256),
        Ok(_) => Ok(false),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}
#[derive(Default)]
struct References {
    paths: BTreeSet<String>,
    anchors: BTreeMap<String, PathBuf>,
}
impl References {
    fn add(&mut self, path: &str) {
        if !path.trim().is_empty() {
            self.paths.insert(key(Path::new(path)));
        }
    }
    fn protects(&self, path: &Path) -> bool {
        let p = key(path);
        self.paths
            .iter()
            .any(|r| p == *r || p.starts_with(&format!("{r}/")) || r.starts_with(&format!("{p}/")))
    }
    fn identity(&self) -> String {
        format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(&self.paths, &self.anchors)).unwrap())
        )
    }
}
fn references(root: &Path) -> Result<References, String> {
    let c = Connection::open_with_flags(
        root.join("craft-search.sqlite3"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| e.to_string())?;
    c.execute_batch("BEGIN;").map_err(|e| e.to_string())?;
    let mut result = References::default();
    for (table, column) in [
        ("libraries", "location"),
        ("collection_roots", "root"),
        ("collection_owned_assets", "path"),
        ("collection_saved_media", "path"),
        ("reading_media_outbox", "path"),
        ("craft_backup_files", "path"),
    ] {
        let exists: bool = c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                [table],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !exists {
            continue;
        }
        let mut q = c
            .prepare(&format!(
                "SELECT DISTINCT \"{column}\" FROM \"{table}\" WHERE \"{column}\" IS NOT NULL"
            ))
            .map_err(|e| e.to_string())?;
        for row in q
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
        {
            result.add(&row.map_err(|e| e.to_string())?);
        }
    }
    let mut q=c.prepare("SELECT key,value FROM metadata WHERE key='collection_storage_v1' OR key LIKE 'craft_backup_config:%'").map_err(|e|e.to_string())?;
    let rows = q
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (id, raw) = row.map_err(|e| e.to_string())?;
        if id == "collection_storage_v1" {
            let _: crate::x_bookmarks::storage::StorageConfig =
                serde_json::from_str(&raw).map_err(|_| "阅读保存设置损坏，无法确认文件引用")?;
            let value: Value =
                serde_json::from_str(&raw).map_err(|_| "阅读保存设置损坏，无法确认文件引用")?;
            if let Some(path) = value["vaultPath"].as_str() {
                result.add(path);
            }
        } else {
            let config: crate::craft_backup::BackupConfig =
                serde_json::from_str(&raw).map_err(|_| "Craft 备份设置损坏，无法确认文件引用")?;
            if id != format!("craft_backup_config:{}", config.library_id) {
                return Err("Craft 备份设置身份不一致，文件保留".into());
            }
            let name = format!(
                "{} - 备份",
                crate::craft_export::sanitize_component(&config.vault_name, "Craft")
            );
            let path = Path::new(&config.destination).join(&name);
            result.add(&path.to_string_lossy());
            result.anchors.insert(id, path);
            if let Some(replica) = config.replica_destination.filter(|v| !v.trim().is_empty()) {
                result.add(&Path::new(&replica).join(&name).to_string_lossy());
            }
        }
    }
    Ok(result)
}
fn measured(path: &Path) -> Result<(u64, u64), String> {
    crate::craft_backup::reject_links(path)?;
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((0, 0)),
        Err(e) => return Err(e.to_string()),
    };
    if meta.is_file() {
        return Ok((1, meta.len()));
    }
    let mut result = (0u64, 0u64);
    for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
        let value = measured(&entry.map_err(|e| e.to_string())?.path())?;
        result.0 += value.0;
        result.1 = result.1.saturating_add(value.1);
    }
    Ok(result)
}
fn batches(root: &Path) -> Result<BTreeSet<String>, String> {
    let mut ids = BTreeSet::new();
    for (relative, prefix, suffix) in [
        ("data-backup-v1", "consolidate-", ".sqlite3"),
        ("external-sources", "prepared-", ""),
        (MANIFESTS, "", ".json"),
    ] {
        let parent = safe(root, relative)?;
        let entries = match fs::read_dir(parent) {
            Ok(v) => v,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.to_string()),
        };
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(id) = name
                .strip_prefix(prefix)
                .and_then(|v| v.strip_suffix(suffix))
                .filter(|id| id_valid(id))
            {
                ids.insert(id.into());
            }
        }
    }
    Ok(ids)
}
fn keeper(root: &Path, refs: &References, file: &ManifestFile) -> Result<Option<PathBuf>, String> {
    let (Some(anchor), Some(suffix)) = (&file.anchor_id, &file.anchor_suffix) else {
        return Ok(None);
    };
    let Some(anchor) = refs.anchors.get(anchor) else {
        return Ok(None);
    };
    if !within(anchor, root) {
        return Ok(None);
    }
    let path = safe(anchor, suffix)?;
    match path.canonicalize() {
        Ok(path) => Ok(Some(path)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}
fn scan(root: &Path, cancel: &AtomicBool) -> Result<(Plan, Value), String> {
    let refs = references(root)?;
    let identity = refs.identity();
    let mut plan = Plan {
        root: root.to_string_lossy().into(),
        references: identity.clone(),
        files: Vec::new(),
    };
    let mut candidates = Vec::new();
    let mut retained = Vec::new();
    let mut warnings = Vec::new();
    let mut accepted = BTreeSet::new();
    for id in batches(root)? {
        check_cancel(cancel)?;
        let snapshot = safe(root, &format!("data-backup-v1/consolidate-{id}.sqlite3"))?;
        let prepared = safe(root, &format!("external-sources/prepared-{id}"))?;
        let a = measured(&snapshot)?;
        let b = measured(&prepared)?;
        let total = (a.0 + b.0, a.1.saturating_add(b.1));
        if total.0 == 0 {
            continue;
        }
        let relative = format!("{MANIFESTS}/{id}.json");
        let manifest_path = safe(root, &relative)?;
        let manifest = read_json::<Manifest>(&manifest_path);
        let mut reason = "缺少可验证的程序清单，保留".to_string();
        let start = plan.files.len();
        if let Ok(manifest) = manifest {
            if manifest.version == 1
                && manifest.producer == "hub-consolidation-v1"
                && manifest.id == id
                && matches!(manifest.phase.as_str(), "complete" | "failed" | "cancelled")
            {
                reason = "仍被引用、内容独有、文件已变化或未列入清单，保留".into();
                let manifest_sha = hash(&manifest_path, cancel)?;
                for file in &manifest.files {
                    check_cancel(cancel)?;
                    if !file.created_by_run
                        || !owned_file(&id, &file.relative_path)
                        || file.sha256.len() != 64
                        || !file.sha256.bytes().all(|b| b.is_ascii_hexdigit())
                    {
                        continue;
                    }
                    let path = safe(root, &file.relative_path)?;
                    // Database snapshots preserve an earlier state; byte-unique
                    // recovery copies never become disposable by age alone.
                    if !file.relative_path.starts_with("external-sources/") || refs.protects(&path)
                    {
                        continue;
                    }
                    let Some(keep) = keeper(root, &refs, file)? else {
                        continue;
                    };
                    if within(&keep, &prepared)
                        || !file_matches(&path, file.bytes, &file.sha256, cancel)?
                        || !file_matches(&keep, file.bytes, &file.sha256, cancel)?
                    {
                        continue;
                    }
                    if accepted.insert(key(&path)) {
                        plan.files.push(Candidate {
                            path: file.relative_path.clone(),
                            bytes: file.bytes,
                            sha256: file.sha256.clone(),
                            keeper: keep
                                .strip_prefix(root)
                                .map_err(|_| "保留副本不在当前目录")?
                                .to_string_lossy()
                                .replace('\\', "/"),
                            manifest: relative.clone(),
                            manifest_sha256: manifest_sha.clone(),
                        });
                    }
                }
            } else {
                reason = "整理尚未终止，或清单版本/身份无法验证，保留".into();
            }
        }
        let selected = &plan.files[start..];
        let bytes = selected.iter().map(|f| f.bytes).sum::<u64>();
        let files = selected.len() as u64;
        if files > 0 {
            candidates.push(json!({"id":id,"label":format!("重复整理副本 {}",&id[..8]),"logicalBytes":bytes,"files":files}));
        }
        if total.0 > files {
            retained.push(json!({"id":id,"label":format!("恢复记录 {}",&id[..8]),"logicalBytes":total.1.saturating_sub(bytes),"files":total.0-files,"reason":reason}));
        }
    }
    if references(root)?.identity() != identity {
        return Err("来源或附件引用在检查期间变化，请重新检查".into());
    }
    warnings.push(
        "只清理有程序清单、当前无引用且另有相同保留副本的文件；独有文件和业务附件保留。"
            .to_string(),
    );
    warnings
        .push("显示的是文件逻辑大小；硬链接、文件系统压缩和并发写入会影响实际磁盘释放。".into());
    let value = json!({"logicalBytes":plan.files.iter().map(|f|f.bytes).sum::<u64>(),"files":plan.files.len(),"candidates":candidates,"retained":retained,"warnings":warnings,"requiresRestart":true});
    Ok((plan, value))
}
pub(crate) fn cleanup_status(root: &Path) -> Result<Option<CleanupStatus>, String> {
    let path = safe(root, &format!("{DIRECTORY}/pending.json"))?;
    if !path.exists() {
        return Ok(None);
    }
    let status: CleanupStatus = read_json(&path)?;
    if !id_valid(&status.id) {
        return Err("清理批次身份无效".into());
    }
    Ok(Some(status))
}
fn save_status(root: &Path, status: &CleanupStatus) -> Result<(), String> {
    // Publishing pending is the commit point. A failed history write must never
    // return an error after an unacknowledged deletion request became active.
    write_json(
        &safe(root, &format!("{DIRECTORY}/{}-result.json", status.id))?,
        status,
    )?;
    write_json(&safe(root, &format!("{DIRECTORY}/pending.json"))?, status)
}
pub(crate) fn storage_status(root: &Path) -> Result<Value, String> {
    let usage = crate::data_backup::usage(root)?;
    let retained = measured(&root.join("database-maintenance"))?.1;
    Ok(
        json!({"root":root,"usage":usage,"compaction":{"preview":crate::local_database_maintenance::preview(root)?,"status":crate::local_database_maintenance::status(root)?,"retainedBytes":retained,"note":"压实只缩小当前数据库文件；一致备份和退役源库仍保留，因此总占用不会立刻减少相同大小。"},"cleanup":{"status":cleanup_status(root)?}}),
    )
}
pub(crate) fn preview_cleanup(root: &Path, cancel: &AtomicBool) -> Result<Value, String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let _maintenance = crate::data_portability::maintenance_lock(&root)?;
    let (plan, mut value) = scan(&root, cancel)?;
    let token = crate::random_url_safe(32);
    let mut checks = INSPECTIONS.lock().map_err(|_| "清理预览状态不可用")?;
    checks.retain(|_, v| v.at.elapsed() < Duration::from_secs(600));
    if checks.len() >= 8 {
        checks.clear();
    }
    checks.insert(
        token.clone(),
        Inspection {
            plan,
            at: Instant::now(),
        },
    );
    value["token"] = json!(token);
    Ok(value)
}
fn validate_plan(root: &Path, plan: &Plan, cancel: &AtomicBool) -> Result<(), String> {
    let refs = references(root)?;
    if key(root) != key(Path::new(&plan.root)) || refs.identity() != plan.references {
        return Err("当前目录或文件引用已变化，请重新预览".into());
    }
    let mut manifests = BTreeMap::<String, Manifest>::new();
    let mut paths = BTreeSet::new();
    for file in &plan.files {
        check_cancel(cancel)?;
        let path = safe(root, &file.path)?;
        if !paths.insert(key(&path)) || refs.protects(&path) {
            return Err("清理计划包含重复或正在使用的文件，未删除".into());
        }
        if !manifests.contains_key(&file.manifest) {
            let manifest_path = safe(root, &file.manifest)?;
            if hash(&manifest_path, cancel)? != file.manifest_sha256 {
                return Err("整理清单已变化，请重新预览".into());
            }
            let manifest: Manifest = read_json(&manifest_path)?;
            if manifest.version != 1
                || manifest.producer != "hub-consolidation-v1"
                || !id_valid(&manifest.id)
                || file.manifest != format!("{MANIFESTS}/{}.json", manifest.id)
                || !matches!(manifest.phase.as_str(), "complete" | "failed" | "cancelled")
            {
                return Err("清理计划的程序清单无效".into());
            }
            manifests.insert(file.manifest.clone(), manifest);
        }
        let manifest = &manifests[&file.manifest];
        let recorded = manifest
            .files
            .iter()
            .find(|value| {
                value.relative_path == file.path
                    && value.bytes == file.bytes
                    && value.sha256 == file.sha256
                    && value.created_by_run
            })
            .ok_or("文件不属于已验证的程序清单")?;
        if !file
            .path
            .starts_with(&format!("external-sources/prepared-{}/", manifest.id))
        {
            return Err("此类文件不允许通过恢复副本清理删除".into());
        }
        let kept = safe(root, &file.keeper)?;
        let expected = keeper(root, &refs, recorded)?.ok_or("保留副本已失去当前来源引用")?;
        if key(&kept) != key(&expected)
            || within(
                &kept,
                &root.join(format!("external-sources/prepared-{}", manifest.id)),
            )
        {
            return Err("保留副本不属于已确认的当前来源".into());
        }
        if !file_matches(&path, file.bytes, &file.sha256, cancel)?
            || !file_matches(&kept, file.bytes, &file.sha256, cancel)?
        {
            return Err("候选或保留副本已变化，请重新预览".into());
        }
    }
    Ok(())
}
pub(crate) fn schedule_cleanup(root: &Path, token: &str) -> Result<CleanupStatus, String> {
    if !cfg!(windows) {
        return Err("当前平台暂不支持按文件身份安全清理，文件保持原位".into());
    }
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let _maintenance = crate::data_portability::maintenance_lock(&root)?;
    if cleanup_status(&root)?.is_some_and(|s| matches!(s.phase.as_str(), "requested" | "running")) {
        return Err("已有清理安排，请先完成或取消".into());
    }
    let checks = INSPECTIONS.lock().map_err(|_| "清理预览状态不可用")?;
    let inspection = checks
        .get(token)
        .filter(|v| v.at.elapsed() < Duration::from_secs(600))
        .ok_or("清理预览已过期，请重新检查")?;
    let plan = inspection.plan.clone();
    drop(checks);
    if plan.files.is_empty() {
        return Err("没有已证明可清理的重复文件".into());
    }
    validate_plan(&root, &plan, &AtomicBool::new(false))?;
    let id = format!("{:032x}", rand::random::<u128>());
    let status = CleanupStatus {
        id: id.clone(),
        phase: "requested".into(),
        error: String::new(),
        planned_files: plan.files.len() as u64,
        planned_logical_bytes: plan.files.iter().map(|f| f.bytes).sum(),
        deleted_files: 0,
        deleted_logical_bytes: 0,
        retained_files: plan.files.len() as u64,
        updated_at: now(),
    };
    write_json(&safe(&root, &format!("{DIRECTORY}/{id}-plan.json"))?, &plan)?;
    save_status(&root, &status)?;
    if let Ok(mut checks) = INSPECTIONS.lock() {
        checks.remove(token);
    }
    Ok(status)
}
pub(crate) fn cancel_cleanup(root: &Path) -> Result<CleanupStatus, String> {
    let _maintenance = crate::data_portability::maintenance_lock(root)?;
    let mut status = cleanup_status(root)?.ok_or("没有待执行的清理")?;
    if status.phase != "requested" {
        return Err("清理已经结束或正在执行".into());
    }
    status.phase = "cancelled".into();
    status.updated_at = now();
    save_status(root, &status)?;
    Ok(status)
}
/// Called before the normal database connection and workers. No directory delete
/// or user-supplied path is exposed; only exact files in a confirmed plan qualify.
pub(crate) fn process_pending(root: &Path) -> Result<Option<CleanupStatus>, String> {
    let Some(status) = cleanup_status(root)? else {
        return Ok(None);
    };
    if !matches!(status.phase.as_str(), "requested" | "running") {
        return Ok(Some(status));
    }
    let _session = crate::data_portability::exclusive_session(root)?;
    let _maintenance = crate::data_portability::maintenance_lock(root)?;
    // The unlocked read is only a startup fast path. Another owner may have
    // completed or cancelled the request before both leases were acquired.
    let Some(mut status) = cleanup_status(root)? else {
        return Ok(None);
    };
    if !matches!(status.phase.as_str(), "requested" | "running") {
        return Ok(Some(status));
    }
    if status.phase == "running" {
        // A crash can occur after unlink but before the count was committed.
        // Recount existing paths without attributing unrecorded absences to us.
        let reconciled = (|| -> Result<(u64, u64), String> {
            let plan: Plan = read_json(&safe(
                root,
                &format!("{DIRECTORY}/{}-plan.json", status.id),
            )?)?;
            if key(root) != key(Path::new(&plan.root))
                || plan.files.len() as u64 != status.planned_files
            {
                return Err("清理计划身份不一致".into());
            }
            let mut present = 0u64;
            let mut absent = 0u64;
            for file in &plan.files {
                match fs::metadata(safe(root, &file.path)?) {
                    Ok(_) => present += 1,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => absent += 1,
                    Err(error) => return Err(error.to_string()),
                }
            }
            Ok((present, absent.saturating_sub(status.deleted_files)))
        })();
        status.phase = "partial".into();
        status.error=match reconciled {
            Ok((present,unconfirmed))=>{status.retained_files=present;format!("上次清理中断；只显示已保存的删除计数。当前仍有 {present} 个计划文件，另有 {unconfirmed} 个文件已不存在但未确认删除结果。未继续删除，请重新检查。")},
            Err(error)=>format!("上次清理中断；计数仅为最后一次保存的进度，当前文件数量未能核验。未继续删除，请重新检查：{error}"),
        };
        status.updated_at = now();
        save_status(root, &status)?;
        return Ok(Some(status));
    }
    let result = (|| -> Result<(), String> {
        let plan: Plan = read_json(&safe(
            root,
            &format!("{DIRECTORY}/{}-plan.json", status.id),
        )?)?;
        let cancel = AtomicBool::new(false);
        validate_plan(root, &plan, &cancel)?;
        status.phase = "running".into();
        save_status(root, &status)?;
        for file in &plan.files {
            // Offline ownership excludes Hub/MCP writers. Recheck immediately
            // before removal as other file tools need not honor Hub's lock.
            crate::data_backup::delete_duplicate_copy(
                &safe(root, &file.path)?,
                &safe(root, &file.keeper)?,
                file.bytes,
                &file.sha256,
            )?;
            status.deleted_files += 1;
            status.deleted_logical_bytes = status.deleted_logical_bytes.saturating_add(file.bytes);
            status.retained_files = status.planned_files - status.deleted_files;
            status.updated_at = now();
            save_status(root, &status)?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => {
            status.phase = "complete".into();
            status.error.clear();
        }
        Err(error) => {
            status.phase = if status.deleted_files > 0 {
                "partial"
            } else {
                "failed"
            }
            .into();
            status.error = error;
        }
    }
    status.updated_at = now();
    save_status(root, &status)?;
    Ok(Some(status))
}

#[cfg(test)]
#[path = "data_management_tests.rs"]
mod tests;
