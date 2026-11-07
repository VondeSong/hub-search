//! Durable capture queue. Markdown is the desktop source of truth after import.
use super::*;
use crate::flashcard_object_store::{OssConfig, OssStore};
use crate::reading_sync::object_store::Store;
use sha2::{Digest, Sha256};
mod format;
use format::{Attachment, Record, MAX_ATTACHMENT};
#[cfg(target_os = "android")]
mod android;
#[cfg(test)]
mod tests;
static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Settings {
    pub library_id: String,
    pub folder: String,
    pub sync: bool,
}
fn schema(c: &Connection) -> Result<(), String> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS quick_journal_records (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,payload TEXT NOT NULL,
        namespace TEXT NOT NULL DEFAULT '',uploaded INTEGER NOT NULL DEFAULT 0,
        applied INTEGER NOT NULL DEFAULT 0,receipted INTEGER NOT NULL DEFAULT 0,library_id TEXT NOT NULL DEFAULT '',path TEXT NOT NULL DEFAULT '');")
        .map_err(|e| e.to_string())
}
fn settings(c: &Connection) -> Result<Settings, String> {
    let raw = metadata_string(c, "quick_journal_settings");
    if raw.is_empty() {
        return Ok(Settings {
            folder: "Journals".into(),
            ..Default::default()
        });
    }
    serde_json::from_str(&raw).map_err(|_| "速记设置无法读取".into())
}
fn meta(c: &Connection, key: &str, value: &str) -> Result<(), String> {
    c.execute("INSERT INTO metadata(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,value]).map_err(|e|e.to_string())?;
    Ok(())
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn root(db: &Path) -> Result<PathBuf, String> {
    Ok(db
        .parent()
        .ok_or("速记数据目录无效")?
        .join("quick-journal-v1"))
}
fn asset(db: &Path, hash: &str) -> Result<PathBuf, String> {
    if !format::hex_id(hash, 64) {
        return Err("附件标识无效".into());
    }
    Ok(root(db)?.join("assets").join(hash))
}
fn safe_folder(folder: &str) -> bool {
    !folder.is_empty()
        && folder.len() < 200
        && !folder.contains('\\')
        && folder.split('/').all(|p| {
            !p.is_empty()
                && p != "."
                && p != ".."
                && !p.chars().any(|c| c.is_control() || "<>:\"|?*".contains(c))
        })
}
fn target(c: &Connection, s: &Settings) -> Result<PathBuf, String> {
    if !safe_folder(&s.folder) {
        return Err("请填写库内日记目录，例如 Journals".into());
    }
    let location: String = c
        .query_row(
            "SELECT location FROM libraries WHERE id=?1 AND provider='obsidian' AND enabled=1",
            [&s.library_id],
            |r| r.get(0),
        )
        .map_err(|_| "请先选择已接入的 OS Obsidian 库")?;
    let vault = fs::canonicalize(location).map_err(|_| "OS 库暂时不可用")?;
    let mut path = vault.clone();
    for part in s.folder.split('/') {
        path.push(part);
        if path.exists()
            && !fs::canonicalize(&path)
                .map_err(|e| e.to_string())?
                .starts_with(&vault)
        {
            return Err("日记目录不能指向库外".into());
        }
    }
    Ok(path)
}
fn config(c: &Connection) -> Result<OssConfig, String> {
    if flashcard_cloud_sync::provider(c) != "oss" {
        return Err("速记首版需要在云同步中启用阿里云 OSS 连接".into());
    }
    flashcard_cloud_sync::config(c)?.normalized()
}
#[tauri::command]
pub(crate) fn get_quick_journal_settings(app: AppHandle) -> Result<Value, String> {
    let (c, _guard) = open_write_database(&database_path(&app)?)?;
    schema(&c)?;
    Ok(
        json!({"settings":settings(&c)?,"error":metadata_string(&c,"quick_journal_error"),"mobile":cfg!(mobile)}),
    )
}
#[tauri::command]
pub(crate) async fn save_quick_journal_settings(
    app: AppHandle,
    value: Settings,
) -> Result<(), String> {
    let _lock = LOCK.lock().await;
    {
        let (c, _guard) = open_write_database(&database_path(&app)?)?;
        schema(&c)?;
        if !safe_folder(&value.folder) {
            return Err("日记目录无效".into());
        }
        if !cfg!(mobile) && !value.library_id.is_empty() {
            target(&c, &value)?;
        }
        if value.sync {
            config(&c)?;
        }
        meta(
            &c,
            "quick_journal_settings",
            &serde_json::to_string(&value).map_err(|e| e.to_string())?,
        )?;
    }
    schedule_mobile(&app)?;
    Ok(())
}
#[tauri::command]
pub(crate) fn stage_quick_journal_attachment(
    app: AppHandle,
    name: String,
    content: String,
) -> Result<Attachment, String> {
    use base64::Engine;
    if content.len() > MAX_ATTACHMENT.div_ceil(3) * 4 {
        return Err("附件最多 20 MB".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(content)
        .map_err(|_| "附件数据编码无效")?;
    if bytes.len() > MAX_ATTACHMENT
        || name.is_empty()
        || name.len() > 255
        || name.chars().any(char::is_control)
    {
        return Err("附件最多 20 MB，名称不能含控制字符".into());
    }
    let hash = digest(&bytes);
    let image = infer::get(&bytes).is_some_and(|t| {
        matches!(
            t.mime_type(),
            "image/jpeg" | "image/png" | "image/gif" | "image/webp"
        )
    });
    let path = asset(&database_path(&app)?, &hash)?;
    if !path.exists() {
        data_portability::atomic_write(&path, &bytes)?;
    }
    Ok(Attachment {
        hash,
        name,
        size: bytes.len(),
        image,
    })
}
#[tauri::command]
pub(crate) fn save_quick_journal_draft(app: AppHandle, draft: String) -> Result<(), String> {
    if draft.len() > 200_000 {
        return Err("草稿过大".into());
    }
    let (c, _guard) = open_write_database(&database_path(&app)?)?;
    meta(&c, "quick_journal_draft", &draft)
}
#[tauri::command]
pub(crate) fn get_quick_journal_draft(app: AppHandle) -> Result<String, String> {
    Ok(metadata_string(
        &open_database(&database_path(&app)?)?,
        "quick_journal_draft",
    ))
}
fn enqueue(db: &PathBuf, r: &Record) -> Result<(), String> {
    r.validate()?;
    for a in &r.attachments {
        let bytes = fs::read(asset(db, &a.hash)?).map_err(|_| "附件未保存，请重新添加")?;
        if bytes.len() != a.size || digest(&bytes) != a.hash {
            return Err("本机附件校验失败".into());
        }
    }
    let (mut c, _guard) = open_write_database(db)?;
    c.execute_batch("PRAGMA synchronous=FULL;")
        .map_err(|e| e.to_string())?;
    schema(&c)?;
    let payload = serde_json::to_string(r).map_err(|e| e.to_string())?;
    let existing: Option<String> = c
        .query_row(
            "SELECT payload FROM quick_journal_records WHERE id=?1",
            [&r.id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(old) = existing {
        return if old == payload {
            Ok(())
        } else {
            Err("此记录 ID 已用于另一条内容，请重新打开录入区".into())
        };
    }
    let tx = c.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO quick_journal_records(id,payload) VALUES(?1,?2)",
        params![r.id, payload],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}
#[tauri::command]
pub(crate) fn capture_quick_journal(app: AppHandle, record: Record) -> Result<Value, String> {
    enqueue(&database_path(&app)?, &record)?;
    // A scheduling failure never turns a durable capture into a failed save.
    let warning = schedule_mobile(&app).err();
    Ok(json!({"id":record.id,"warning":warning}))
}

/// Preserve all existing bytes and compare under a Windows deny-write handle before replacement.
fn append(path: &Path, r: &Record) -> Result<(), String> {
    let parent = path.parent().ok_or("日记路径无效")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    if path.exists()
        && fs::symlink_metadata(path)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
    {
        return Err("不写入链接日记文件".into());
    }
    let before = match fs::read_to_string(path) {
        Ok(v) => Some(v),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    let original = before.as_deref().unwrap_or("");
    if format::blocks(original)?.iter().any(|(id, _)| id == &r.id) {
        return Ok(());
    }
    let prefix = if before.is_none() {
        format!("# {}\n\n", r.date)
    } else {
        format!(
            "{original}{}",
            if original.ends_with("\n\n") {
                ""
            } else {
                "\n\n"
            }
        )
    };
    let after = format!("{prefix}{}", r.markdown("_hub-assets"));
    if !format::blocks(&after)?.iter().any(|(id, _)| id == &r.id) {
        return Err("当天日记含未闭合的 Markdown 区块，请在 OS 中修正后重试；原文未修改".into());
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(4);
    }
    let _guard = if before.is_some() {
        let mut file = options.open(path).map_err(|_| "日记正被编辑，稍后重试")?;
        let mut current = String::new();
        file.read_to_string(&mut current)
            .map_err(|e| e.to_string())?;
        if Some(current.as_str()) != before.as_deref() {
            return Err("日记已变化，稍后重试".into());
        }
        Some(file)
    } else {
        None
    };
    if before.is_none() {
        // Claim a new date without replacing a diary concurrently created by Obsidian.
        let temporary = parent.join(format!(".hub-journal-{}.tmp", random_url_safe(12)));
        data_portability::atomic_write(&temporary, after.as_bytes())?;
        let result = fs::hard_link(&temporary, path)
            .map_err(|_| "当天日记已被创建或磁盘不支持安全创建，稍后重试".to_string());
        let _ = fs::remove_file(temporary);
        result?;
    } else {
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            #[link(name = "Kernel32")]
            unsafe extern "system" {
                fn ReplaceFileW(
                    replaced: *const u16,
                    replacement: *const u16,
                    backup: *const u16,
                    flags: u32,
                    exclude: *mut std::ffi::c_void,
                    reserved: *mut std::ffi::c_void,
                ) -> i32;
            }
            let temp = parent.join(format!(".hub-journal-{}.tmp", random_url_safe(12)));
            data_portability::atomic_write(&temp, after.as_bytes())?;
            let wide = |p: &Path| {
                p.as_os_str()
                    .encode_wide()
                    .chain(Some(0))
                    .collect::<Vec<_>>()
            };
            let ok = unsafe {
                ReplaceFileW(
                    wide(path).as_ptr(),
                    wide(&temp).as_ptr(),
                    std::ptr::null(),
                    0,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 {
                let error = std::io::Error::last_os_error();
                let _ = fs::remove_file(&temp);
                return Err(format!("日记安全替换失败，原文保留：{error}"));
            }
        }
        #[cfg(not(windows))]
        data_portability::atomic_write(path, after.as_bytes())?;
    }
    if !format::blocks(&fs::read_to_string(path).map_err(|e| e.to_string())?)?
        .iter()
        .any(|(id, _)| id == &r.id)
    {
        return Err("日记写后核验失败".into());
    }
    Ok(())
}
fn apply_local(db: &PathBuf) -> Result<(), String> {
    if cfg!(mobile) {
        return Ok(());
    }
    let (c, _guard) = open_write_database(db)?;
    schema(&c)?;
    let s = settings(&c)?;
    if s.library_id.is_empty() {
        return Ok(());
    }
    let dir = target(&c, &s)?;
    let rows = c
        .prepare("SELECT payload FROM quick_journal_records WHERE applied=0 ORDER BY seq")
        .map_err(|e| e.to_string())?
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    for payload in rows {
        let r: Record = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
        r.validate()?;
        for a in &r.attachments {
            let bytes = fs::read(asset(db, &a.hash)?).map_err(|_| "附件仍在等待下载")?;
            if bytes.len() != a.size || digest(&bytes) != a.hash {
                return Err("附件校验失败，日记未写入".into());
            }
            let asset_dir = dir.join("_hub-assets");
            if asset_dir.exists()
                && !fs::canonicalize(&asset_dir)
                    .map_err(|e| e.to_string())?
                    .starts_with(fs::canonicalize(&dir).map_err(|e| e.to_string())?)
            {
                return Err("附件目录不能指向日记目录外".into());
            }
            data_portability::atomic_write(&asset_dir.join(a.filename()), &bytes)?;
        }
        let path = dir.join(format!("{}.md", r.date));
        append(&path, &r)?;
        c.execute(
            "UPDATE quick_journal_records SET applied=1,library_id=?2,path=?3 WHERE id=?1",
            params![r.id, s.library_id, path.to_string_lossy()],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn queue(db: &PathBuf) -> Result<Vec<(Record, String, bool, bool)>, String> {
    let (c, _guard) = open_write_database(db)?;
    schema(&c)?;
    let rows = c
        .prepare(
            "SELECT payload,namespace,uploaded,applied FROM quick_journal_records ORDER BY seq",
        )
        .map_err(|e| e.to_string())?
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, bool>(2)?,
                r.get::<_, bool>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    rows.into_iter()
        .map(|(p, n, u, a)| {
            Ok((
                serde_json::from_str(&p).map_err(|e| e.to_string())?,
                n,
                u,
                a,
            ))
        })
        .collect()
}
fn update(db: &PathBuf, sql: &str, id: &str, namespace: &str) -> Result<(), String> {
    let (c, _guard) = open_write_database(db)?;
    c.execute(sql, params![id, namespace])
        .map_err(|e| e.to_string())?;
    Ok(())
}
async fn transfer(db: &PathBuf, store: &dyn Store, namespace: &str) -> Result<(), String> {
    for (r, bound, uploaded, _) in queue(db)? {
        if !bound.is_empty() && bound != namespace {
            continue;
        }
        if !uploaded {
            update(
                db,
                "UPDATE quick_journal_records SET namespace=?2 WHERE id=?1",
                &r.id,
                namespace,
            )?;
            for a in &r.attachments {
                let bytes = fs::read(asset(db, &a.hash)?).map_err(|_| "本机附件缺失")?;
                if digest(&bytes) != a.hash || bytes.len() != a.size {
                    return Err("本机附件校验失败".into());
                }
                store
                    .put_verified(&store.key(&format!("journal/assets/{}", a.hash)), &bytes)
                    .await?;
            }
            store
                .put_verified(
                    &store.key(&format!("journal/records/{}.json", r.id)),
                    &serde_json::to_vec(&r).map_err(|e| e.to_string())?,
                )
                .await?;
            update(
                db,
                "UPDATE quick_journal_records SET uploaded=1 WHERE id=?1 AND namespace=?2",
                &r.id,
                namespace,
            )?;
        }
    }
    if !cfg!(mobile) {
        let receiver = {
            let (c, _guard) = open_write_database(db)?;
            if settings(&c)?.library_id.is_empty() {
                return Ok(());
            }
            let mut id = metadata_string(&c, "quick_journal_receiver");
            if id.is_empty() {
                id = random_url_safe(24);
                meta(&c, "quick_journal_receiver", &id)?;
            }
            id
        };
        // Immutable ownership prevents two desktops from importing the same inbox into different vaults.
        store
            .put_verified(
                &store.key("journal/writer.json"),
                &serde_json::to_vec(&json!({"version":1,"receiver":receiver}))
                    .map_err(|e| e.to_string())?,
            )
            .await
            .map_err(|e| format!("无法确认本电脑为 OS 写入端（同一云目录只支持一台电脑）：{e}"))?;
        let mut continuation = None;
        loop {
            let page = store
                .inventory_page("journal/records/", continuation.as_deref())
                .await?;
            for key in page.keys {
                let id = key
                    .strip_prefix(&store.key("journal/records/"))
                    .and_then(|v| v.strip_suffix(".json"))
                    .filter(|v| format::hex_id(v, 32))
                    .ok_or("云端速记对象名称无效")?;
                let exists = {
                    let c = open_database(db)?;
                    c.query_row(
                        "SELECT EXISTS(SELECT 1 FROM quick_journal_records WHERE id=?1)",
                        [id],
                        |r| r.get::<_, bool>(0),
                    )
                    .map_err(|e| e.to_string())?
                };
                if exists {
                    continue;
                }
                let bytes = store.get(&key, 200_000).await?.ok_or("云端速记暂不可用")?;
                let r: Record = serde_json::from_slice(&bytes).map_err(|_| "云端速记格式无效")?;
                r.validate()?;
                if r.id != id {
                    return Err("云端速记 ID 不匹配".into());
                }
                for a in &r.attachments {
                    let bytes = store
                        .get(
                            &store.key(&format!("journal/assets/{}", a.hash)),
                            MAX_ATTACHMENT,
                        )
                        .await?
                        .ok_or("附件仍在等待上传")?;
                    if digest(&bytes) != a.hash || bytes.len() != a.size {
                        return Err("云端附件校验失败".into());
                    }
                    data_portability::atomic_write(&asset(db, &a.hash)?, &bytes)?;
                }
                enqueue(db, &r)?;
                update(
                    db,
                    "UPDATE quick_journal_records SET uploaded=1,namespace=?2 WHERE id=?1",
                    &r.id,
                    namespace,
                )?;
            }
            if page.next.is_none() {
                break;
            }
            if page.next == continuation {
                return Err("云端分页游标重复".into());
            }
            continuation = page.next;
        }
        apply_local(db)?;
    }
    for (r, bound, _, applied) in queue(db)? {
        if bound != namespace {
            continue;
        }
        let key = store.key(&format!("journal/receipts/{}.json", r.id));
        let receipt=serde_json::to_vec(&json!({"version":1,"id":r.id,"hash":digest(&serde_json::to_vec(&r).map_err(|e|e.to_string())?)})).map_err(|e|e.to_string())?;
        if !cfg!(mobile) && applied {
            let sent = {
                let c = open_database(db)?;
                c.query_row(
                    "SELECT receipted FROM quick_journal_records WHERE id=?1",
                    [&r.id],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(|e| e.to_string())?
            };
            if !sent {
                store.put_verified(&key, &receipt).await?;
                update(
                    db,
                    "UPDATE quick_journal_records SET receipted=1 WHERE id=?1 AND namespace=?2",
                    &r.id,
                    namespace,
                )?;
            }
        }
        if cfg!(mobile)
            && !applied
            && store.get(&key, 1024).await?.as_deref() == Some(receipt.as_slice())
        {
            update(
                db,
                "UPDATE quick_journal_records SET applied=1 WHERE id=?1 AND namespace=?2",
                &r.id,
                namespace,
            )?;
        }
    }
    Ok(())
}
async fn run(app: &AppHandle, automatic: bool) -> Result<(), String> {
    let _lock = LOCK.lock().await;
    let db = database_path(app)?;
    let result = async {
        apply_local(&db)?;
        let configuration = {
            let c = open_database(&db)?;
            let s = settings(&c)?;
            let p = cloud_sync::policy(&c);
            if !s.sync || !p.enabled || (automatic && !p.auto_sync) {
                return Ok(());
            }
            config(&c)?
        };
        let namespace = configuration.namespace();
        let store = guarded_store(
            &db,
            configuration,
            stored_secret_get(app, "hub-flashcard-oss-secret-v1")?.unwrap_or_default(),
            automatic,
        )?;
        transfer(&db, &store, &namespace).await
    }
    .await;
    {
        let (c, _guard) = open_write_database(&db)?;
        meta(
            &c,
            "quick_journal_error",
            result.as_ref().err().map(String::as_str).unwrap_or(""),
        )?;
    }
    result
}
fn guarded_store(
    db: &PathBuf,
    configuration: OssConfig,
    secret: String,
    automatic: bool,
) -> Result<OssStore, String> {
    let namespace = configuration.namespace();
    let db = db.clone();
    let store = OssStore::new(configuration, secret)?;
    let prefix = store.key("journal/");
    Ok(store.with_network_guard(
        prefix,
        std::sync::Arc::new(move || {
            let c = open_database(&db)?;
            let p = cloud_sync::policy(&c);
            if !settings(&c)?.sync || !p.enabled || (automatic && !p.auto_sync) {
                return Err("速记云同步已暂停".into());
            }
            if config(&c)?.namespace() != namespace {
                return Err("OSS 连接已变化，本次同步已停止".into());
            }
            Ok(())
        }),
    ))
}
#[tauri::command]
pub(crate) async fn sync_quick_journal(app: AppHandle) -> Result<(), String> {
    run(&app, false).await
}
fn schedule_mobile(app: &AppHandle) -> Result<(), String> {
    #[cfg(target_os = "android")]
    app.state::<AndroidSourceOpener>()
        .0
        .run_mobile_plugin::<()>(
            "scheduleQuickJournal",
            json!({"root":active_data_root(app)?.to_string_lossy()}),
        )
        .map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "android"))]
    let _ = app;
    Ok(())
}
pub(crate) fn start_scheduler(app: AppHandle) {
    #[cfg(target_os = "android")]
    {
        let _ = schedule_mobile(&app);
    }
    #[cfg(not(target_os = "android"))]
    tauri::async_runtime::spawn(async move {
        while crate::background_workers::running() {
            let _ = run(&app, true).await;
            if !crate::background_workers::wait(Duration::from_secs(60)).await {
                break;
            }
        }
    });
}

#[tauri::command]
pub(crate) fn list_quick_journal(app: AppHandle) -> Result<Value, String> {
    let db = database_path(&app)?;
    let (c, _guard) = open_write_database(&db)?;
    schema(&c)?;
    let rows=c.prepare("SELECT payload,uploaded,applied,library_id,path,namespace FROM quick_journal_records ORDER BY seq DESC").map_err(|e|e.to_string())?.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,bool>(1)?,r.get::<_,bool>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,String>(5)?))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    let mut files = std::collections::HashMap::new();
    let mut items = Vec::new();
    for (payload, uploaded, applied, library, path, namespace) in rows {
        let r: Record = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
        let mut body = r.text.clone();
        let mut missing = false;
        let mut source_error = String::new();
        if applied && !cfg!(mobile) {
            let parsed = files.entry(path.clone()).or_insert_with(|| {
                fs::read_to_string(&path)
                    .map_err(|e| e.to_string())
                    .and_then(|v| format::blocks(&v))
            });
            match parsed {
                Ok(blocks) => match blocks.iter().find(|(id, _)| id == &r.id) {
                    Some((_, v)) => body = v.clone(),
                    None => missing = true,
                },
                Err(e) => source_error = format!("OS 原文暂不可读，当前显示采集副本：{e}"),
            };
        }
        if missing {
            continue;
        }
        items.push(json!({"record":r,"body":body,"uploaded":uploaded,"applied":applied,"libraryId":library,"path":path,"namespace":namespace,"sourceError":source_error}));
    }
    Ok(json!({"items":items,"error":metadata_string(&c,"quick_journal_error")}))
}
#[tauri::command]
pub(crate) fn quick_journal_image(app: AppHandle, hash: String) -> Result<String, String> {
    let bytes = fs::read(asset(&database_path(&app)?, &hash)?).map_err(|_| "附件不在本机")?;
    let mime = infer::get(&bytes)
        .filter(|t| {
            matches!(
                t.mime_type(),
                "image/jpeg" | "image/png" | "image/gif" | "image/webp"
            )
        })
        .ok_or("不是可预览图片")?;
    use base64::Engine;
    Ok(format!(
        "data:{};base64,{}",
        mime.mime_type(),
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}
#[tauri::command]
pub(crate) fn export_quick_journal_attachment(
    app: AppHandle,
    id: String,
    hash: String,
    destination: String,
) -> Result<(), String> {
    let db = database_path(&app)?;
    let payload: String = open_database(&db)?
        .query_row(
            "SELECT payload FROM quick_journal_records WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .map_err(|_| "速记不存在")?;
    let r: Record = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
    let a = r
        .attachments
        .iter()
        .find(|a| a.hash == hash)
        .ok_or("附件不属于此记录")?;
    let bytes = fs::read(asset(&db, &hash)?).map_err(|_| "附件不在本机")?;
    if digest(&bytes) != hash {
        return Err("附件校验失败".into());
    }
    BlobStore::open(&blob_store_path(&app)?)?.put(&bytes)?;
    let mime = infer::get(&bytes).map(|t| t.mime_type().to_string());
    flashcard_attachments::save_flashcard_attachment(
        app,
        format!("craft-media://localhost/{hash}"),
        destination,
        Some(a.name.clone()),
        mime,
    )
}
#[tauri::command]
pub(crate) fn open_quick_journal(app: AppHandle, id: String) -> Result<(), String> {
    let c = open_database(&database_path(&app)?)?;
    let (library, path): (String, String) = c
        .query_row(
            "SELECT library_id,path FROM quick_journal_records WHERE id=?1 AND applied=1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| "尚未写入 OS")?;
    let location: String = c
        .query_row(
            "SELECT location FROM libraries WHERE id=?1 AND provider='obsidian'",
            [library],
            |r| r.get(0),
        )
        .map_err(|_| "OS 库不可用")?;
    let relative = Path::new(&path)
        .strip_prefix(&location)
        .map_err(|_| "日记不在目标库中")?;
    open_external(
        &app,
        &obsidian_open_url(
            &obsidian_vault_name(Path::new(&location)),
            &relative.to_string_lossy(),
        )?,
    )
}
