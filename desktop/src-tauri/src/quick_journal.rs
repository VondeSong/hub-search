//! Durable capture queue. Markdown is the desktop source of truth after import.
use super::*;
use crate::flashcard_object_store::{OssConfig, OssStore};
use crate::reading_sync::object_store::Store;
use sha2::{Digest, Sha256};
pub(crate) mod calendar;
pub(crate) mod edits;
mod format;
pub(crate) mod mobile;
pub(crate) mod voice;
use format::{Attachment, Record, MAX_ATTACHMENT};
#[cfg(target_os = "android")]
mod android;
#[cfg(test)]
mod tests;
pub(crate) static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Settings {
    pub library_id: String,
    pub folder: String,
    pub sync: bool,
    #[serde(default)]
    pub date_folders: bool,
}
fn schema(c: &Connection) -> Result<(), String> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS quick_journal_asset_receipts(namespace TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(namespace,hash));
    CREATE TABLE IF NOT EXISTS quick_journal_records (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,payload TEXT NOT NULL,
        namespace TEXT NOT NULL DEFAULT '',uploaded INTEGER NOT NULL DEFAULT 0,
        applied INTEGER NOT NULL DEFAULT 0,receipted INTEGER NOT NULL DEFAULT 0,library_id TEXT NOT NULL DEFAULT '',path TEXT NOT NULL DEFAULT '');")
        .map_err(|e| e.to_string())?;
    edits::schema(c)
}
fn settings(c: &Connection) -> Result<Settings, String> {
    let raw = metadata_string(c, "quick_journal_settings");
    if raw.is_empty() {
        return Ok(Settings {
            folder: "Journals".into(),
            date_folders: true,
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
fn target(c: &Connection, s: &Settings, date: &str) -> Result<PathBuf, String> {
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
    if !format::valid_date(date) {
        return Err("日记日期无效".into());
    }
    let folder = if s.date_folders {
        format!("{}/{}/{}", s.folder, &date[..4], &date[5..7])
    } else {
        s.folder.clone()
    };
    let mut path = vault.clone();
    for part in folder.split('/') {
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
    let value = settings(&c)?;
    let error = metadata_string(&c, "quick_journal_error");
    let supported = flashcard_cloud_sync::provider(&c) == "oss";
    let p = cloud_sync::policy(&c);
    drop(c);
    drop(_guard);
    Ok(
        json!({"report":sync_report(&database_path(&app)?)?,"supported":supported,"settings":value,"error":error,"mobile":cfg!(mobile),"cloudEnabled":p.enabled,"autoSync":p.auto_sync}),
    )
}
#[tauri::command]
pub(crate) async fn save_quick_journal_settings(
    app: AppHandle,
    value: Settings,
) -> Result<Value, String> {
    let _lock = LOCK.lock().await;
    {
        let (c, _guard) = open_write_database(&database_path(&app)?)?;
        schema(&c)?;
        if !safe_folder(&value.folder) {
            return Err("日记目录无效".into());
        }
        if !cfg!(mobile) {
            if value.sync && value.library_id.is_empty() {
                return Err("请先选择速记要写入的 OS 资料库".into());
            }
            if !value.library_id.is_empty() {
                target(
                    &c,
                    &value,
                    &chrono::Local::now().format("%Y-%m-%d").to_string(),
                )?;
            }
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
    Ok(json!({"warning":schedule_mobile(&app).err()}))
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
pub(crate) fn save_quick_journal_draft(
    app: AppHandle,
    draft: String,
    slot: Option<String>,
) -> Result<(), String> {
    if draft.len() > 200_000 {
        return Err("草稿过大".into());
    }
    if let Some(day) = slot.as_deref() {
        if let Some(id) = day.strip_prefix("edit:") {
            if !draft.is_empty() {
                let value: Value = serde_json::from_str(&draft).map_err(|_| "编辑草稿格式无效")?;
                let record: Record = serde_json::from_value(value["record"].clone())
                    .map_err(|_| "编辑草稿内容无效")?;
                if record.id != id
                    || !format::hex_id(id, 32)
                    || value["revision"].as_str().is_none()
                {
                    return Err("编辑草稿身份无效".into());
                }
            }
        } else {
            let value: Record = serde_json::from_str(&draft).map_err(|_| "日历草稿格式无效")?;
            if value.version != 1 || value.date != day || !format::hex_id(&value.id, 32) {
                return Err("日历草稿日期或身份不一致".into());
            }
        }
    }
    let (c, _guard) = open_write_database(&database_path(&app)?)?;
    meta(&c, &calendar::key(slot.as_deref())?, &draft)
}
#[tauri::command]
pub(crate) fn get_quick_journal_draft(
    app: AppHandle,
    slot: Option<String>,
) -> Result<String, String> {
    Ok(metadata_string(
        &open_database(&database_path(&app)?)?,
        &calendar::key(slot.as_deref())?,
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
    insert_record(db, r)
}
// The remote manifest is durable before optional attachment bytes arrive.
fn insert_record(db: &PathBuf, r: &Record) -> Result<(), String> {
    r.validate()?;
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
    let exists = format::blocks(original)?.iter().any(|(id, _)| id == &r.id);
    let mut patched = original.to_string();
    if exists {
        for a in &r.attachments {
            let placeholder = pending_attachment(&r.id, a);
            let mut single = r.clone();
            single.text = String::new();
            single.attachments = vec![a.clone()];
            let link = format::blocks(&single.markdown("_hub-assets"))?
                .into_iter()
                .next()
                .ok_or("附件区块无效")?
                .1;
            patched = patched.replacen(&placeholder, &link, 1);
        }
        if patched == original {
            return Ok(());
        }
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
    let after = if exists {
        patched
    } else {
        format!("{prefix}{}", r.markdown("_hub-assets"))
    };
    if !format::blocks(&after)?.iter().any(|(id, _)| id == &r.id) {
        return Err("当天日记含未闭合的 Markdown 区块，请在 OS 中修正后重试；原文未修改".into());
    }
    replace_diary(path, before.as_deref(), &after)?;
    if !format::blocks(&fs::read_to_string(path).map_err(|e| e.to_string())?)?
        .iter()
        .any(|(id, _)| id == &r.id)
    {
        return Err("日记写后核验失败".into());
    }
    Ok(())
}
fn replace_diary(path: &Path, before: Option<&str>, after: &str) -> Result<(), String> {
    let parent = path.parent().ok_or("Invalid diary path")?;
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
    if fs::read(path).map_err(|e| e.to_string())? != after.as_bytes() {
        return Err("Diary readback differs".into());
    }
    Ok(())
}
fn pending_attachment(id: &str, a: &Attachment) -> String {
    format!(
        "<!-- hub-attachment:{id}:{} -->\n附件未下载：{}（可在 Hub 速记中下载）",
        a.hash,
        a.name.replace(['[', ']', '<', '>'], "")
    )
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
    let rows = c
        .prepare("SELECT payload FROM quick_journal_records ORDER BY seq")
        .map_err(|e| e.to_string())?
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    for payload in rows {
        let r: Record = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
        r.validate()?;
        let (already, previous, previous_library): (bool, String, String) = c
            .query_row(
                "SELECT applied,path,library_id FROM quick_journal_records WHERE id=?1",
                [&r.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(|e| e.to_string())?;
        let library = if already {
            &previous_library
        } else {
            &s.library_id
        };
        let path = if already && !previous.is_empty() {
            let path = PathBuf::from(previous);
            let location: String = c.query_row(
                "SELECT location FROM libraries WHERE id=?1 AND provider='obsidian' AND enabled=1",
                [library], |r| r.get(0),
            ).map_err(|_| "原日记资料库暂不可用")?;
            if !fs::canonicalize(path.parent().ok_or("日记路径无效")?)
                .map_err(|e| e.to_string())?
                .starts_with(fs::canonicalize(location).map_err(|e| e.to_string())?)
            {
                return Err("原日记目录不能指向资料库外".into());
            }
            path
        } else {
            target(&c, &s, &r.date)?.join(format!("{}.md", r.date))
        };
        let dir = path.parent().ok_or("日记目录无效")?.to_path_buf();
        let mut rendered = r.clone();
        rendered.attachments.clear();
        if already
            && !fs::read_to_string(&path)
                .ok()
                .and_then(|v| format::blocks(&v).ok())
                .is_some_and(|blocks| blocks.iter().any(|(id, _)| id == &r.id))
        {
            continue;
        }
        for a in &r.attachments {
            let bytes = match fs::read(asset(db, &a.hash)?) {
                Ok(v) => v,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    rendered
                        .text
                        .push_str(&format!("\n\n{}", pending_attachment(&r.id, a)));
                    continue;
                }
                Err(e) => return Err(e.to_string()),
            };
            rendered.attachments.push(a.clone());
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
        append(&path, &rendered)?;
        c.execute(
            "UPDATE quick_journal_records SET applied=1,library_id=?2,path=?3 WHERE id=?1",
            params![r.id, library, path.to_string_lossy()],
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
        let rules = {
            let c = open_database(db)?;
            crate::cloud_sync::attachments::policy(&c, "quick")?
        };
        for a in &r.attachments {
            if !rules.upload.allows(
                if a.image { "image/unknown" } else { "" },
                &a.name,
                a.size as u64,
            ) {
                continue;
            }
            let sent = {
                let c = open_database(db)?;
                c.query_row("SELECT EXISTS(SELECT 1 FROM quick_journal_asset_receipts WHERE namespace=?1 AND hash=?2)",params![namespace,a.hash],|r|r.get::<_,bool>(0)).map_err(|e|e.to_string())?
            };
            if sent {
                continue;
            }
            let bytes = match fs::read(asset(db, &a.hash)?) {
                Ok(v) => v,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound && uploaded => continue,
                Err(_) => return Err("本机附件缺失".into()),
            };
            if digest(&bytes) != a.hash || bytes.len() != a.size {
                return Err("本机附件校验失败".into());
            }
            store
                .put_verified(&store.key(&format!("journal/assets/{}", a.hash)), &bytes)
                .await?;
            let (c, _guard) = open_write_database(db)?;
            c.execute(
                "INSERT OR IGNORE INTO quick_journal_asset_receipts VALUES(?1,?2)",
                params![namespace, a.hash],
            )
            .map_err(|e| e.to_string())?;
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
                insert_record(db, &r)?;
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
        for (r, bound, _, _) in queue(db)? {
            if bound != namespace {
                continue;
            }
            let rules = {
                let c = open_database(db)?;
                crate::cloud_sync::attachments::policy(&c, "quick")?
            };
            for a in &r.attachments {
                if asset(db, &a.hash)?.is_file()
                    || !rules.download.allows(
                        if a.image { "image/unknown" } else { "" },
                        &a.name,
                        a.size as u64,
                    )
                {
                    continue;
                }
                let Some(bytes) = store
                    .get(&store.key(&format!("journal/assets/{}", a.hash)), a.size)
                    .await?
                else {
                    continue;
                };
                if bytes.len() != a.size || digest(&bytes) != a.hash {
                    return Err("速记附件校验失败，正文已保留".into());
                }
                data_portability::atomic_write(&asset(db, &a.hash)?, &bytes)?;
            }
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
    edits::transfer(db, store, namespace).await?;
    Ok(())
}
fn sync_configuration(
    c: &Connection,
    automatic: bool,
    mobile: bool,
) -> Result<Option<OssConfig>, String> {
    let s = settings(c)?;
    let p = cloud_sync::policy(c);
    if automatic && (!s.sync || !p.enabled || !p.auto_sync) {
        return Ok(None);
    }
    if !s.sync {
        return Err("本设备速记云同步未开启，请展开“速记保存与同步设置”，勾选后保存设置".into());
    }
    if !p.enabled {
        return Err("云同步总开关未开启，请到“设置 → 云同步”开启；本机记录已保留".into());
    }
    if !mobile && s.library_id.is_empty() {
        return Err("尚未选择 OS 资料库，请在“速记保存与同步设置”中选择并保存".into());
    }
    config(c).map(Some)
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncReport {
    pending_upload: usize,
    awaiting_os: usize,
    written: usize,
}
fn sync_report(db: &PathBuf) -> Result<SyncReport, String> {
    let mut report = SyncReport::default();
    for (record, _, uploaded, applied) in queue(db)? {
        let (uploaded, applied) = edits::status(&open_database(db)?, &record, uploaded, applied)?;
        if !uploaded {
            report.pending_upload += 1;
        }
        if uploaded && !applied {
            report.awaiting_os += 1;
        }
        if applied {
            report.written += 1;
        }
    }
    Ok(report)
}
async fn run(app: &AppHandle, automatic: bool) -> Result<SyncReport, String> {
    let _lock = LOCK.lock().await;
    let db = database_path(app)?;
    let result: Result<SyncReport, String> = async {
        apply_local(&db)?;
        let configuration = {
            let c = open_database(&db)?;
            let Some(configuration) = sync_configuration(&c, automatic, cfg!(mobile))? else {
                return sync_report(&db);
            };
            configuration
        };
        let namespace = configuration.namespace();
        let store = guarded_store(
            &db,
            configuration,
            stored_secret_get(app, "hub-flashcard-oss-secret-v1")?.unwrap_or_default(),
            automatic,
        )?;
        transfer(&db, &store, &namespace).await?;
        sync_report(&db)
    }
    .await;
    {
        let (c, _guard) = open_write_database(&db)?;
        if let Err(ref error) = result {
            if error.starts_with("OSS 对象校验中断") {
                meta(
                    &c,
                    "quick_journal_last_head_failure",
                    &json!({"at":now_timestamp(),"detail":error}).to_string(),
                )?;
            }
        }
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
pub(crate) async fn sync_quick_journal(app: AppHandle) -> Result<SyncReport, String> {
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
        let mut item = json!({"record":r,"body":body,"uploaded":uploaded,"applied":applied,"libraryId":library,"path":path,"namespace":namespace,"sourceError":source_error});
        edits::decorate(&c, &mut item)?;
        items.push(item);
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
pub(crate) async fn export_quick_journal_attachment(
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
    let original: Record = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
    let r = edits::projected(&open_database(&db)?, &original, false)?.0;
    let a = r
        .attachments
        .iter()
        .find(|a| a.hash == hash)
        .ok_or("附件不属于此记录")?;
    if !asset(&db, &hash)?.is_file() {
        let _lock = LOCK.lock().await;
        let configuration = {
            let c = open_database(&db)?;
            sync_configuration(&c, false, cfg!(mobile))?.ok_or("速记云同步未开启")?
        };
        let ns = configuration.namespace();
        let bound: String = open_database(&db)?
            .query_row(
                "SELECT namespace FROM quick_journal_records WHERE id=?1",
                [&r.id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if bound != ns {
            return Err("速记属于其他云空间，原记录保留".into());
        }
        let store = guarded_store(
            &db,
            configuration,
            stored_secret_get(&app, "hub-flashcard-oss-secret-v1")?.unwrap_or_default(),
            false,
        )?;
        let bytes = store
            .get(&store.key(&format!("journal/assets/{hash}")), a.size)
            .await?
            .ok_or("此附件尚未上传，请在原设备放宽上传规则后同步")?;
        if digest(&bytes) != hash || bytes.len() != a.size {
            return Err("附件校验失败".into());
        }
        data_portability::atomic_write(&asset(&db, &hash)?, &bytes)?;
        apply_local(&db)?;
    }
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
