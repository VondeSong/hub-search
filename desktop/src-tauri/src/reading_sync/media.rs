//! Attachment manifests are separate from reading v1 records; old clients ignore them.
use super::*;
use std::io::Read;
pub(crate) mod cache;
pub(crate) mod offline;
pub(crate) mod recovery;
mod references;
mod transfer;
pub(crate) use references::ready_previews;
pub(crate) use references::ready_previews_page;
use references::{current, originals, preview_only};
pub(crate) use transfer::admission_wait;
pub(crate) use transfer::Budget as MigrationBudget;
pub(crate) use transfer::{ensure, sync, Summary};
pub(crate) fn migration_policy(c: &Connection) -> Result<Policy, String> {
    policy(c)
}
const MB: u64 = 1024 * 1024;
const MAX_FILE: u64 = 100 * MB;
const MAX_MANIFEST: usize = 16 * 1024;
const MAX_PREVIEW: u64 = 2 * MB;
const MANIFESTS: &str = "reading/media-v1/manifests/";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub(crate) struct Policy {
    enabled: bool,
    download: String,
    image_mb: u64,
    document_mb: u64,
    batch_mb: u64,
    daily_mb: u64,
    cache_mb: u64,
}
impl Default for Policy {
    fn default() -> Self {
        Self {
            enabled: false,
            download: "onDemand".into(),
            image_mb: 10,
            document_mb: 20,
            batch_mb: 64,
            daily_mb: 256,
            cache_mb: 512,
        }
    }
}
impl Policy {
    fn validate(&self) -> Result<(), String> {
        if !matches!(self.download.as_str(), "onDemand" | "all")
            || !(1..=100).contains(&self.image_mb)
            || !(1..=100).contains(&self.document_mb)
            || !(4..=512).contains(&self.batch_mb)
            || !(self.batch_mb..=10240).contains(&self.daily_mb)
            || !(100..=10240).contains(&self.cache_mb)
        {
            return Err("附件策略超出允许范围；每日额度不能小于单轮额度".into());
        }
        Ok(())
    }
}
fn policy(c: &Connection) -> Result<Policy, String> {
    let value = metadata_string(c, "reading_media_policy");
    let p = if value.is_empty() {
        Policy::default()
    } else {
        serde_json::from_str(&value).map_err(|_| "附件同步设置损坏")?
    };
    p.validate()?;
    Ok(p)
}
pub(super) fn schema(c: &Connection) -> Result<(), String> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS reading_media_manifests(namespace TEXT,item_key TEXT,post_hash TEXT,url TEXT,body TEXT NOT NULL,PRIMARY KEY(namespace,item_key,post_hash,url));
    CREATE TABLE IF NOT EXISTS reading_media_outbox(namespace TEXT,id TEXT,body BLOB NOT NULL,path TEXT NOT NULL,PRIMARY KEY(namespace,id));
    CREATE TABLE IF NOT EXISTS reading_media_applied(namespace TEXT,id TEXT,PRIMARY KEY(namespace,id));
    CREATE TABLE IF NOT EXISTS reading_media_errors(namespace TEXT,item_key TEXT,url TEXT,error TEXT NOT NULL,PRIMARY KEY(namespace,item_key,url));
    CREATE TABLE IF NOT EXISTS reading_media_sources(namespace TEXT,item_key TEXT,url TEXT,stamp TEXT NOT NULL,PRIMARY KEY(namespace,item_key,url));").map_err(|e|e.to_string())?;
    crate::local_database_maintenance::ensure_sequences(
        c,
        &["reading_media_manifests", "reading_media_outbox"],
    )?;
    c.execute_batch("CREATE INDEX IF NOT EXISTS reading_media_namespace_sequence ON reading_media_manifests(namespace,local_seq);").map_err(|e|e.to_string())?;
    cache::schema(c)?;
    transfer::ensure_transfer_schema(c)?;
    offline::schema(c)?;
    recovery::schema(c)
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    format: u32,
    key: String,
    post_hash: String,
    url: String,
    version: Version,
    hash: String,
    size: u64,
    mime: String,
    state: String,
}
fn valid_hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
impl Manifest {
    fn validate(&self) -> Result<(), String> {
        if self.format != 1
            || self.key.is_empty()
            || self.key.len() > 2048
            || !valid_hash(&self.post_hash)
            || self.url.is_empty()
            || self.url.len() > 8192
            || self.version.clock == 0
            || self.version.clock > i64::MAX as u64 - 1000000
            || self.version.device.is_empty()
            || self.version.device.len() > 128
            || !matches!(self.state.as_str(), "ready" | "missing" | "skipped")
            || (self.state == "ready"
                && (self.size == 0
                    || self.size > MAX_FILE
                    || !valid_hash(&self.hash)
                    || !supported(&self.mime)))
        {
            return Err("阅读附件清单无效".into());
        }
        Ok(())
    }
}
pub(crate) fn maintenance_import(c: &Connection, ns: &str, body: &[u8]) -> Result<(), String> {
    if body.len() > MAX_MANIFEST {
        return Err("附件检查点清单超过上限".into());
    }
    let m: Manifest = serde_json::from_slice(body).map_err(|_| "附件检查点清单无效")?;
    accept(c, ns, &m)
}
pub(crate) fn maintenance_export_page(
    c: &Connection,
    ns: &str,
    after: i64,
) -> Result<Vec<(i64, Vec<u8>)>, String> {
    let mut q=c.prepare("SELECT local_seq,body FROM reading_media_manifests WHERE namespace=?1 AND local_seq>?2 ORDER BY local_seq LIMIT 100").map_err(|e|e.to_string())?;
    let rows = q
        .query_map(params![ns, after], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    rows.map(|r| {
        let (id, raw) = r.map_err(|e| e.to_string())?;
        let m: Manifest = serde_json::from_str(&raw).map_err(|_| "附件投影损坏")?;
        m.validate()?;
        let body = serde_json::to_vec(&m).map_err(|e| e.to_string())?;
        if body.len() > MAX_MANIFEST {
            return Err("附件检查点超限".into());
        }
        Ok((id, body))
    })
    .collect()
}
fn supported(mime: &str) -> bool {
    matches!(
        mime,
        "image/jpeg"
            | "image/png"
            | "image/gif"
            | "image/webp"
            | "application/pdf"
            | "application/zip"
            | "video/mp4"
            | "video/webm"
            | "video/quicktime"
            | "audio/mpeg"
            | "audio/mp4"
            | "audio/ogg"
            | "application/ogg"
            | "audio/wav"
            | "audio/x-wav"
            | "audio/flac"
    )
}
fn allowed(p: &Policy, mime: &str, size: u64, manual: bool) -> bool {
    if !supported(mime) || size == 0 || size > MAX_FILE {
        return false;
    }
    if mime.starts_with("image/") {
        size <= p.image_mb * MB
    } else if mime == "application/pdf" {
        size <= p.document_mb * MB
    } else {
        manual
    }
}
fn allowed_resource(
    c: &Connection,
    key: &str,
    url: &str,
    p: &Policy,
    mime: &str,
    size: u64,
    manual: bool,
) -> Result<bool, String> {
    Ok(allowed(p, mime, size, manual)
        && (!preview_only(c, key, url)? || (mime.starts_with("image/") && size <= MAX_PREVIEW)))
}
fn local_path(c: &Connection, key: &str, url: &str) -> Option<PathBuf> {
    c.query_row(
        "SELECT path FROM collection_saved_media WHERE item_key=?1 AND media_url=?2",
        params![key, url],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
    .map(PathBuf::from)
    .filter(|p| p.is_file())
}
fn load_manifest(
    c: &Connection,
    ns: &str,
    key: &str,
    post: &str,
    url: &str,
) -> Result<Option<Manifest>, String> {
    let raw:Option<String>=c.query_row("SELECT body FROM reading_media_manifests WHERE namespace=?1 AND item_key=?2 AND post_hash=?3 AND url=?4",params![ns,key,post,url],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    raw.map(|v| serde_json::from_str(&v).map_err(|_| "本机附件清单损坏".into()))
        .transpose()
}
fn accept(c: &Connection, ns: &str, m: &Manifest) -> Result<(), String> {
    m.validate()?;
    if let Some(old) = load_manifest(c, ns, &m.key, &m.post_hash, &m.url)? {
        if old.version == m.version && old != *m {
            return Err("附件清单版本冲突".into());
        }
        if old.version >= m.version {
            return Ok(());
        }
    }
    meta(
        c,
        "reading_sync_clock",
        &metadata_u64(c, "reading_sync_clock", 0)
            .max(m.version.clock)
            .to_string(),
    )?;
    c.execute("INSERT INTO reading_media_manifests(namespace,item_key,post_hash,url,body) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(namespace,item_key,post_hash,url) DO UPDATE SET body=excluded.body",params![ns,m.key,m.post_hash,m.url,serde_json::to_string(m).map_err(|e|e.to_string())?]).map(|_|()).map_err(|e|e.to_string())
}
fn file_bytes(path: &Path) -> Result<Vec<u8>, String> {
    bounded_file_bytes(path, MAX_FILE, "附件超过 100 MB 硬上限")
}
fn bounded_file_bytes(path: &Path, limit: u64, too_large: &str) -> Result<Vec<u8>, String> {
    let f = fs::File::open(path).map_err(|_| "本地原附件不可读取")?;
    if f.metadata().map_err(|e| e.to_string())?.len() > limit {
        return Err(too_large.into());
    }
    let mut bytes = Vec::new();
    f.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err(too_large.into());
    }
    Ok(bytes)
}
fn resource_bytes(c: &Connection, key: &str, url: &str, path: &Path) -> Result<Vec<u8>, String> {
    if preview_only(c, key, url)? {
        bounded_file_bytes(path, MAX_PREVIEW, "缩略图超过 2 MB 上限")
    } else {
        file_bytes(path)
    }
}
fn stage(
    c: &Connection,
    ns: &str,
    device: &str,
    p: &Policy,
    only: Option<(&str, &str)>,
) -> Result<usize, String> {
    let keys = {
        let mut q=c.prepare("SELECT item_key FROM collection_x_items WHERE NOT EXISTS(SELECT 1 FROM reading_cloud_items r WHERE r.item_key=collection_x_items.item_key) AND NOT EXISTS(SELECT 1 FROM collection_lifecycle l WHERE l.item_key=collection_x_items.item_key AND l.state IN ('deleted','deleting'))").map_err(|e|e.to_string())?;
        let result = q
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        result
    };
    let mut staged = 0;
    let mut deferred = 0;
    for key in keys {
        if only.is_some_and(|(k, _)| k != key) {
            continue;
        }
        let (post_hash, urls) = current(c, &key)?;
        for url in urls {
            if only.is_some_and(|(_, u)| u != url) {
                continue;
            }
            let path = local_path(c, &key, &url);
            let stat = path.as_ref().and_then(|p| fs::metadata(p).ok());
            let stamp = format!(
                "{post_hash}:{path:?}:{:?}:{:?}:{}",
                stat.as_ref().map(|s| s.len()),
                stat.and_then(|s| s.modified().ok()),
                serde_json::to_string(p).map_err(|e| e.to_string())?
            );
            let old_stamp:Option<String>=c.query_row("SELECT stamp FROM reading_media_sources WHERE namespace=?1 AND item_key=?2 AND url=?3",params![ns,key,url],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
            if only.is_none() && old_stamp.as_deref() == Some(&stamp) {
                continue;
            }
            if staged >= 100 {
                deferred += 1;
                continue;
            }
            staged += 1;
            let mut m = Manifest {
                format: 1,
                key: key.clone(),
                post_hash: post_hash.clone(),
                url: url.clone(),
                version: Version::default(),
                hash: String::new(),
                size: 0,
                mime: String::new(),
                state: "missing".into(),
            };
            if let Some(path) = &path {
                let size = fs::metadata(path).map_err(|_| "无法读取原附件大小")?.len();
                if size <= MAX_FILE && (!preview_only(c, &key, &url)? || size <= MAX_PREVIEW) {
                    let bytes = resource_bytes(c, &key, &url, path)?;
                    m.size = bytes.len() as u64;
                    m.hash = hash(&bytes);
                    m.mime = infer::get(&bytes)
                        .map(|v| v.mime_type().to_string())
                        .unwrap_or_default();
                    m.state =
                        if allowed_resource(c, &key, &url, p, &m.mime, m.size, only.is_some())? {
                            "ready"
                        } else {
                            "skipped"
                        }
                        .into();
                } else {
                    m.size = size;
                    m.state = "skipped".into();
                }
            }
            if let Some(old) = load_manifest(c, ns, &key, &post_hash, &url)? {
                // A previously explicit upload is not withdrawn by the automatic policy.
                if only.is_none()
                    && old.state == "ready"
                    && old.hash == m.hash
                    && allowed_resource(c, &key, &url, p, &old.mime, old.size, true)?
                {
                    m = old.clone();
                }
                m.version = old.version.clone();
                if only.is_none() && old == m {
                    c.execute("INSERT INTO reading_media_sources VALUES(?1,?2,?3,?4) ON CONFLICT(namespace,item_key,url) DO UPDATE SET stamp=excluded.stamp",params![ns,key,url,stamp]).map_err(|e|e.to_string())?;
                    continue;
                }
            }
            m.version = next(c, device)?;
            m.validate()?;
            let body = serde_json::to_vec(&m).map_err(|e| e.to_string())?;
            if body.len() > MAX_MANIFEST {
                return Err("附件清单超过上限".into());
            }
            let id = hash(&body);
            c.execute("DELETE FROM reading_media_outbox WHERE namespace=?1 AND json_extract(body,'$.key')=?2 AND json_extract(body,'$.url')=?3",params![ns,key,url]).map_err(|e|e.to_string())?;
            c.execute(
                "INSERT OR IGNORE INTO reading_media_outbox(namespace,id,body,path) VALUES(?1,?2,?3,?4)",
                params![
                    ns,
                    id,
                    body,
                    path.map(|p| p.to_string_lossy().into_owned())
                        .unwrap_or_default()
                ],
            )
            .map_err(|e| e.to_string())?;
            accept(c, ns, &m)?;
            c.execute("INSERT INTO reading_media_sources VALUES(?1,?2,?3,?4) ON CONFLICT(namespace,item_key,url) DO UPDATE SET stamp=excluded.stamp",params![ns,key,url,stamp]).map_err(|e|e.to_string())?;
        }
    }
    c.execute(
        "DELETE FROM reading_media_retries WHERE namespace=?1 AND kind='upload'
        AND id NOT IN(SELECT id FROM reading_media_outbox WHERE namespace=?1)",
        [ns],
    )
    .map_err(|e| e.to_string())?;
    Ok(deferred)
}

#[tauri::command]
pub(crate) fn get_reading_media_policy(app: AppHandle) -> Result<Value, String> {
    let c = open_database(&database_path(&app)?)?;
    let day = metadata_string(&c, "reading_media_day");
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let current = day >= today;
    let total = if current {
        metadata_u64(&c, "reading_media_reserved", 0)
    } else {
        0
    };
    let tracked = current && metadata_string(&c, "reading_transfer_day") == day;
    let value = |key| if tracked { metadata_u64(&c, key, 0) } else { 0 };
    Ok(
        json!({"policy":policy(&c)?, "reservedBytes":total, "day":today,
            "uploadedBytes":value("reading_transfer_upload"), "downloadedBytes":value("reading_transfer_download"),
            "attachmentDownloadedBytes":value("reading_transfer_attachment_download"),
            "metadataDownloadedBytes":value("reading_transfer_metadata_download"),
            "pendingBytes":value("reading_transfer_pending"),
            "legacyReservedBytes":if tracked { value("reading_transfer_legacy") } else { total }
        }),
    )
}
#[tauri::command]
pub(crate) async fn release_reading_legacy_reservation(
    app: AppHandle,
    day: String,
    bytes: u64,
) -> Result<(), String> {
    let _guard = LOCK.lock().await;
    let (c, _writer) = open_write_database(&database_path(&app)?)?;
    release_legacy(
        &c,
        &day,
        bytes,
        &chrono::Utc::now().format("%Y-%m-%d").to_string(),
    )
}

fn release_legacy(c: &Connection, day: &str, bytes: u64, today: &str) -> Result<(), String> {
    let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
    let stored_day = metadata_string(&tx, "reading_media_day");
    let tracked = metadata_string(&tx, "reading_transfer_day") == stored_day;
    let total = metadata_u64(&tx, "reading_media_reserved", 0);
    let legacy = if tracked {
        metadata_u64(&tx, "reading_transfer_legacy", 0)
    } else {
        total
    };
    if day != today || stored_day != day || bytes == 0 || bytes != legacy || legacy > total {
        return Err("额度记录已变化，请刷新后再释放旧版预留".into());
    }
    if !tracked {
        for key in [
            "reading_transfer_upload",
            "reading_transfer_download",
            "reading_transfer_attachment_download",
            "reading_transfer_metadata_download",
            "reading_transfer_pending",
        ] {
            meta(&tx, key, "0")?;
        }
        meta(&tx, "reading_transfer_day", day)?;
    }
    meta(&tx, "reading_media_reserved", &(total - legacy).to_string())?;
    meta(&tx, "reading_transfer_legacy", "0")?;
    meta(
        &tx,
        "reading_transfer_legacy_release",
        &json!({"day":day,"bytes":bytes,"at":now_timestamp()}).to_string(),
    )?;
    tx.commit().map_err(|e| e.to_string())
}

#[cfg(test)]
mod legacy_release_tests {
    use super::*;
    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)")
            .unwrap();
        meta(&c, "reading_media_day", "2026-10-09").unwrap();
        meta(&c, "reading_media_reserved", "100").unwrap();
        c
    }
    #[test]
    fn releases_only_legacy_and_preserves_measured_and_pending_transfers() {
        let c = db();
        for (key, value) in [
            ("reading_transfer_day", "2026-10-09"),
            ("reading_transfer_legacy", "60"),
            ("reading_transfer_upload", "10"),
            ("reading_transfer_download", "20"),
            ("reading_transfer_pending", "10"),
        ] {
            meta(&c, key, value).unwrap();
        }
        release_legacy(&c, "2026-10-09", 60, "2026-10-09").unwrap();
        assert_eq!(metadata_u64(&c, "reading_media_reserved", 0), 40);
        assert_eq!(metadata_u64(&c, "reading_transfer_upload", 0), 10);
        assert_eq!(metadata_u64(&c, "reading_transfer_download", 0), 20);
        assert_eq!(metadata_u64(&c, "reading_transfer_pending", 0), 10);
        assert!(release_legacy(&c, "2026-10-09", 60, "2026-10-09").is_err());
    }
    #[test]
    fn rejects_stale_amount_and_day_then_initializes_legacy_accounting() {
        let c = db();
        assert!(release_legacy(&c, "2026-10-09", 99, "2026-10-09").is_err());
        assert!(release_legacy(&c, "2026-10-09", 100, "2026-10-10").is_err());
        assert_eq!(metadata_u64(&c, "reading_media_reserved", 0), 100);
        release_legacy(&c, "2026-10-09", 100, "2026-10-09").unwrap();
        assert_eq!(metadata_u64(&c, "reading_media_reserved", 1), 0);
        assert_eq!(metadata_string(&c, "reading_transfer_day"), "2026-10-09");
        assert!(metadata_string(&c, "reading_transfer_legacy_release").contains("100"));
    }
}

#[tauri::command]
pub(crate) async fn update_reading_media_policy(
    app: AppHandle,
    settings: Policy,
) -> Result<Policy, String> {
    settings.validate()?;
    let _guard = LOCK.lock().await;
    let (c, _writer) = open_write_database(&database_path(&app)?)?;
    meta(
        &c,
        "reading_media_policy",
        &serde_json::to_string(&settings).map_err(|e| e.to_string())?,
    )?;
    policy(&c)
}
#[tauri::command]
pub(crate) fn reading_attachment_status(app: AppHandle, key: String) -> Result<Value, String> {
    let database = database_path(&app)?;
    let (c, _writer) = open_write_database(&database)?;
    x_bookmarks::storage::schema(&c)?;
    let ns = object_store::namespace(&c).unwrap_or_default();
    let (post, urls) = current(&c, &key)?;
    let imported: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM reading_cloud_items WHERE item_key=?1)",
            [&key],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let mut items = Vec::new();
    for url in urls {
        let m = load_manifest(&c, &ns, &key, &post, &url)?;
        let local = local_path(&c, &key, &url).is_some();
        let pinned = m
            .as_ref()
            .map(|v| cache::pinned(&c, &v.hash))
            .transpose()?
            .unwrap_or(false);
        let can_pin = m.as_ref().is_some_and(|v| v.state == "ready")
            && (imported
                || local_path(&c, &key, &url).is_some_and(|path| {
                    cache::root(&database).is_ok_and(|root| path.parent() == Some(root.as_path()))
                }));
        let pending:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM reading_media_outbox WHERE namespace=?1 AND json_extract(body,'$.key')=?2 AND json_extract(body,'$.url')=?3)",params![ns,key,url],|r|r.get(0)).map_err(|e|e.to_string())?;
        let error:String=c.query_row("SELECT error FROM reading_media_errors WHERE namespace=?1 AND item_key=?2 AND url=?3",params![ns,key,url],|r|r.get(0)).optional().map_err(|e|e.to_string())?.unwrap_or_default();
        items.push(json!({"url":url,"thumbnail":preview_only(&c,&key,&url)?,"local":local,"canUpload":local&&!imported,"state":if pending{"pending"}else{m.as_ref().map(|v|v.state.as_str()).unwrap_or("unshared")},"size":m.as_ref().map(|v|v.size),"mime":m.as_ref().map(|v|v.mime.as_str()),"error":error,"pinned":pinned,"canPin":can_pin,"hash":m.as_ref().map(|v|v.hash.as_str())}));
    }
    Ok(json!(items))
}
#[tauri::command]
pub(crate) async fn transfer_reading_attachment(
    app: AppHandle,
    key: String,
    url: String,
    upload: bool,
) -> Result<String, String> {
    let _guard = LOCK.lock().await;
    let database = database_path(&app)?;
    let (remote, ns, device, p) = {
        let (c, _writer) = open_write_database(&database)?;
        cloud_sync::require_reading(&c, false)?;
        let p = policy(&c)?;
        if !p.enabled {
            return Err("请先开启阅读附件同步".into());
        }
        let (_, urls) = current(&c, &key)?;
        if !urls.contains(&url) {
            return Err("附件不属于当前阅读条目".into());
        }
        (
            object_store::store(&app, &c)?,
            object_store::namespace(&c)?,
            flashcard_sync_device_id(&c)?,
            p,
        )
    };
    if upload {
        {
            let c = open_database(&database)?;
            if c.query_row(
                "SELECT EXISTS(SELECT 1 FROM reading_cloud_items WHERE item_key=?1)",
                [&key],
                |r| r.get::<_, bool>(0),
            )
            .map_err(|e| e.to_string())?
            {
                return Err("请在采集此文章的原设备上传附件".into());
            }
        }
        {
            let (mut c, _writer) = open_write_database(&database)?;
            let tx = c.transaction().map_err(|e| e.to_string())?;
            stage(&tx, &ns, &device, &p, Some((&key, &url)))?;
            tx.commit().map_err(|e| e.to_string())?;
        }
        transfer::upload_pending(&database, &remote, &ns, &p, Some((&key, &url))).await?;
        let c = open_database(&database)?;
        let (post, _) = current(&c, &key)?;
        if !load_manifest(&c, &ns, &key, &post, &url)?.is_some_and(|m| m.state == "ready") {
            return Err("此附件未上传：请检查文件是否在本机、类型是否支持及大小上限".into());
        }
        Ok("附件已上传并通过读回校验".into())
    } else {
        transfer::download(&database, &remote, &ns, &key, &url, &p, true).await?;
        Ok("附件已下载并通过校验".into())
    }
}
