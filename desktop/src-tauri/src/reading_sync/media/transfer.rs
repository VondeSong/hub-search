use super::*;
use crate::flashcard_object_store::{ObjectBytes, WriteConfirmation};
use std::io::Write;
mod confirmation;
mod retry;

pub(crate) fn admission_wait(message: String) -> String {
    retry::wait(retry::Admission::Network, message)
}
fn check_network(remote: &dyn ReadingStore, key: &str) -> Result<(), String> {
    remote.check_network(key).map_err(admission_wait)
}

pub(super) fn ensure_transfer_schema(c: &Connection) -> Result<(), String> {
    confirmation::schema(c)?;
    retry::schema(c)
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Summary {
    uploaded: usize,
    downloaded: usize,
    failed: usize,
    pending: usize,
}
impl Summary {
    pub(crate) fn pending_count(&self) -> usize {
        self.pending + self.failed
    }
}

#[derive(Clone)]
pub(crate) struct Budget {
    left: Arc<std::sync::Mutex<u64>>,
}
struct Reservation {
    db: PathBuf,
    day: String,
    bytes: u64,
    left: Arc<std::sync::Mutex<u64>>,
    meter: Arc<crate::cloud_transfer_meter::Meter>,
    attachment: bool,
    settled: bool,
}
impl Reservation {
    fn settle(&mut self) -> Result<(), String> {
        if self.settled {
            return Ok(());
        }
        let (up, down) = self.meter.finish();
        let actual = up.saturating_add(down);
        let (c, _writer) = open_write_database(&self.db)?;
        let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
        if metadata_string(&tx, "reading_media_day") == self.day {
            let total = metadata_u64(&tx, "reading_media_reserved", 0)
                .saturating_sub(self.bytes)
                .saturating_add(actual);
            meta(&tx, "reading_media_reserved", &total.to_string())?;
            for (key, amount) in [
                ("reading_transfer_upload", up),
                ("reading_transfer_download", down),
                (
                    if self.attachment {
                        "reading_transfer_attachment_download"
                    } else {
                        "reading_transfer_metadata_download"
                    },
                    down,
                ),
            ] {
                let value = metadata_u64(&tx, key, 0).saturating_add(amount);
                meta(&tx, key, &value.to_string())?;
            }
            let pending =
                metadata_u64(&tx, "reading_transfer_pending", 0).saturating_sub(self.bytes);
            meta(&tx, "reading_transfer_pending", &pending.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        self.settled = true;
        drop(c);
        drop(_writer);
        let mut left = self.left.lock().unwrap_or_else(|e| e.into_inner());
        *left = left.saturating_add(self.bytes).saturating_sub(actual);
        Ok(())
    }
}
impl Drop for Reservation {
    fn drop(&mut self) {
        let _ = self.settle();
    }
}
impl Budget {
    pub(crate) fn new(p: &Policy) -> Self {
        Self {
            left: Arc::new(std::sync::Mutex::new(p.batch_mb * MB)),
        }
    }
    fn reserve(
        &self,
        db: &PathBuf,
        p: &Policy,
        bytes: u64,
        key: &str,
    ) -> Result<Reservation, String> {
        let mut left = self.left.lock().map_err(|_| "传输额度锁不可用")?;
        if bytes > *left {
            return Err(retry::wait(
                retry::Admission::Quota,
                "本轮云端传输额度不足，原内容保留",
            ));
        }
        let (c, _writer) = open_write_database(db)?;
        let day = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let old = metadata_string(&c, "reading_media_day");
        let reset = day > old;
        let used = if reset {
            0
        } else {
            metadata_u64(&c, "reading_media_reserved", 0)
        };
        if used.saturating_add(bytes) > p.daily_mb * MB {
            return Err(retry::wait(
                retry::Admission::Quota,
                "今日云端传输额度不足，原内容保留；可在云同步设置查看实际传输与旧版预留",
            ));
        }
        let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
        let effective_day = if reset { day } else { old };
        if metadata_string(&tx, "reading_transfer_day") != effective_day {
            for k in [
                "reading_transfer_upload",
                "reading_transfer_download",
                "reading_transfer_attachment_download",
                "reading_transfer_metadata_download",
                "reading_transfer_pending",
            ] {
                meta(&tx, k, "0")?;
            }
            // Historical reservations cannot truthfully be reconstructed as transferred bytes.
            meta(&tx, "reading_transfer_legacy", &used.to_string())?;
            meta(&tx, "reading_transfer_day", &effective_day)?;
        }
        meta(&tx, "reading_media_day", &effective_day)?;
        meta(
            &tx,
            "reading_media_reserved",
            &used.saturating_add(bytes).to_string(),
        )?;
        let pending = metadata_u64(&tx, "reading_transfer_pending", 0).saturating_add(bytes);
        meta(&tx, "reading_transfer_pending", &pending.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        *left -= bytes;
        Ok(Reservation {
            db: db.clone(),
            day: effective_day,
            bytes,
            left: self.left.clone(),
            meter: Arc::new(Default::default()),
            attachment: key.contains("/media-v1/blobs/"),
            settled: false,
        })
    }
    pub(crate) async fn get(
        &self,
        db: &PathBuf,
        p: &Policy,
        remote: &dyn ReadingStore,
        key: &str,
        max: usize,
    ) -> Result<Option<Vec<u8>>, String> {
        Ok(self
            .get_with_identity(db, p, remote, key, max)
            .await?
            .map(|v| v.bytes))
    }
    async fn get_with_identity(
        &self,
        db: &PathBuf,
        p: &Policy,
        remote: &dyn ReadingStore,
        key: &str,
        max: usize,
    ) -> Result<Option<ObjectBytes>, String> {
        if crate::cloud_transfer_meter::active() {
            return remote.get_with_identity(key, max).await;
        }
        check_network(remote, key)?;
        let Some(size) = remote.head_size(key).await? else {
            return Ok(None);
        };
        if size > max as u64 {
            return Err("云对象超过大小上限".into());
        }
        let mut r = self.reserve(db, p, size, key)?;
        let result = crate::cloud_transfer_meter::ACTIVE
            .scope(
                r.meter.clone(),
                remote.get_with_identity(key, size as usize),
            )
            .await;
        // In-memory test stores have no HTTP layer. Their successful payload is still measurable.
        if let Ok(Some(object)) = &result {
            r.meter.fallback(0, object.bytes.len() as u64);
        }
        r.settle()?;
        result
    }
    pub(crate) async fn put(
        &self,
        db: &PathBuf,
        p: &Policy,
        remote: &dyn ReadingStore,
        key: &str,
        bytes: &[u8],
    ) -> Result<bool, String> {
        Ok(self
            .put_confirmed(db, p, remote, key, bytes)
            .await?
            .written())
    }
    async fn put_confirmed(
        &self,
        db: &PathBuf,
        p: &Policy,
        remote: &dyn ReadingStore,
        key: &str,
        bytes: &[u8],
    ) -> Result<WriteConfirmation, String> {
        if crate::cloud_transfer_meter::active() {
            return remote.put_confirmed(key, bytes).await;
        }
        check_network(remote, key)?;
        // Admit an existing object's actual GET before even issuing HEAD.
        let mut probe = self.reserve(db, p, bytes.len() as u64, key)?;
        let existing = crate::cloud_transfer_meter::ACTIVE
            .scope(probe.meter.clone(), async {
                let Some(size) = remote.head_size(key).await? else {
                    return Ok(None);
                };
                if size != bytes.len() as u64 {
                    return Err("云端附件校验失败".into());
                }
                remote.get_with_identity(key, bytes.len()).await
            })
            .await;
        if let Ok(Some(object)) = &existing {
            probe.meter.fallback(0, object.bytes.len() as u64);
        }
        probe.settle()?;
        if let Some(object) = existing? {
            if object.bytes != bytes {
                return Err("云端附件校验失败".into());
            }
            return Ok(WriteConfirmation::ExistingBytes(object.identity));
        }
        // HEAD/GET absence has released N before reserving the full write + readback.
        let mut r = self.reserve(
            db,
            p,
            (bytes.len() as u64).saturating_mul(2).saturating_add(1),
            key,
        )?;
        let result = crate::cloud_transfer_meter::ACTIVE
            .scope(r.meter.clone(), remote.put_confirmed(key, bytes))
            .await;
        if result.as_ref().is_ok_and(|v| v.written()) {
            r.meter.fallback(bytes.len() as u64, 0);
        }
        r.settle()?;
        result
    }
}
fn error(db: &PathBuf, ns: &str, key: &str, url: &str, message: &str) -> Result<(), String> {
    let (c, _writer) = open_write_database(db)?;
    c.execute("INSERT INTO reading_media_errors VALUES(?1,?2,?3,?4) ON CONFLICT(namespace,item_key,url) DO UPDATE SET error=excluded.error",params![ns,key,url,message]).map(|_|()).map_err(|e|e.to_string())
}
fn blob_key(remote: &dyn ReadingStore, hash: &str) -> String {
    remote.key(&format!("reading/media-v1/blobs/{hash}"))
}
async fn verified_put(
    db: &PathBuf,
    p: &Policy,
    budget: &Budget,
    remote: &dyn ReadingStore,
    ns: &str,
    key: &str,
    bytes: &[u8],
    force: bool,
) -> Result<(), String> {
    confirmation::put(db, p, budget, remote, ns, key, bytes, force).await
}
async fn upload_one(
    db: &PathBuf,
    remote: &dyn ReadingStore,
    ns: &str,
    p: &Policy,
    budget: &mut Budget,
    id: &str,
    body: &[u8],
    path: &str,
    force: bool,
) -> Result<(), String> {
    let m: Manifest = serde_json::from_slice(body).map_err(|_| "待上传附件清单损坏")?;
    m.validate()?;
    if hash(body) != id {
        return Err("待上传附件身份不一致".into());
    }
    let is_current = {
        let c = open_database(db)?;
        current(&c, &m.key).is_ok_and(|(post, urls)| post == m.post_hash && urls.contains(&m.url))
    };
    if !is_current {
        let (c, _writer) = open_write_database(db)?;
        c.execute(
            "DELETE FROM reading_media_outbox WHERE namespace=?1 AND id=?2",
            params![ns, id],
        )
        .map_err(|e| e.to_string())?;
        retry::clear(&c, ns, "upload", id)?;
        return Ok(());
    }
    // Re-check today's policy even for an outbox staged before a settings change.
    check_network(remote, &remote.key(MANIFESTS))?;
    if m.state == "ready" {
        if !allowed_resource(
            &open_database(db)?,
            &m.key,
            &m.url,
            p,
            &m.mime,
            m.size,
            true,
        )? {
            return Err(retry::wait(
                retry::Admission::Type,
                "附件超过当前类型或大小限制，待同步记录保留",
            ));
        }
        let bytes = resource_bytes(&open_database(db)?, &m.key, &m.url, Path::new(path))?;
        if hash(&bytes) != m.hash || bytes.len() as u64 != m.size {
            return Err("原附件已变化，请再次同步以建立新清单".into());
        }
        verified_put(
            db,
            p,
            budget,
            remote,
            ns,
            &blob_key(remote, &m.hash),
            &bytes,
            force,
        )
        .await?;
    }
    verified_put(
        db,
        p,
        budget,
        remote,
        ns,
        &remote.key(&format!("{MANIFESTS}{id}.json")),
        body,
        force,
    )
    .await?;
    let (mut c, _writer) = open_write_database(db)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT OR IGNORE INTO reading_media_applied VALUES(?1,?2)",
        params![ns, id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM reading_media_outbox WHERE namespace=?1 AND id=?2",
        params![ns, id],
    )
    .map_err(|e| e.to_string())?;
    retry::clear(&tx, ns, "upload", id)?;
    tx.execute(
        "DELETE FROM reading_media_errors WHERE namespace=?1 AND item_key=?2 AND url=?3",
        params![ns, m.key, m.url],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}
async fn uploads(
    db: &PathBuf,
    remote: &dyn ReadingStore,
    ns: &str,
    p: &Policy,
    budget: &mut Budget,
    only: Option<(&str, &str)>,
) -> Result<Summary, String> {
    let cursor_key = format!("reading_media_upload_cursor_{}", hash(ns.as_bytes()));
    let pending = {
        let c = open_database(db)?;
        let cursor = metadata_u64(&c, &cursor_key, 0);
        let mut q=c.prepare("SELECT o.id,o.body,o.path,o.local_seq FROM reading_media_outbox o
            WHERE o.namespace=?1 AND (?2 IS NULL OR (json_extract(o.body,'$.key')=?2 AND json_extract(o.body,'$.url')=?3))
            AND (?2 IS NOT NULL OR NOT EXISTS(SELECT 1 FROM reading_media_retries r
                WHERE r.namespace=o.namespace AND r.kind='upload' AND r.id=o.id AND (r.attempts>=?6 OR r.next_at>?5)))
            ORDER BY (o.local_seq<=?4),o.local_seq LIMIT 100").map_err(|e|e.to_string())?;
        let rows = q
            .query_map(
                params![
                    ns,
                    only.map(|v| v.0),
                    only.map(|v| v.1),
                    cursor,
                    now_timestamp(),
                    retry::MAX_ATTEMPTS
                ],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Vec<u8>>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, u64>(3)?,
                    ))
                },
            )
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows
    };
    let mut result = Summary::default();
    for (id, body, path, cursor) in pending {
        if only.is_none() {
            let (c, _writer) = open_write_database(db)?;
            meta(&c, &cursor_key, &cursor.to_string())?;
        }
        let (attempt, waiting) = retry::track(upload_one(
            db,
            remote,
            ns,
            p,
            budget,
            &id,
            &body,
            &path,
            only.is_some(),
        ))
        .await;
        match attempt {
            Ok(()) => result.uploaded += 1,
            Err(e) => {
                let m: Manifest = serde_json::from_slice(&body).map_err(|_| "附件队列损坏")?;
                let stopped = retry::failed(db, ns, "upload", &id, waiting)?;
                let message = if stopped {
                    format!("{e}；自动重试已暂停，请手动重试此附件")
                } else {
                    e.clone()
                };
                error(db, ns, &m.key, &m.url, &message)?;
                result.failed += 1;
                if only.is_some() {
                    return Err(e);
                }
            }
        }
    }
    Ok(result)
}
pub(super) async fn upload_pending(
    db: &PathBuf,
    remote: &dyn ReadingStore,
    ns: &str,
    p: &Policy,
    only: Option<(&str, &str)>,
) -> Result<Summary, String> {
    uploads(db, remote, ns, p, &mut Budget::new(p), only).await
}
fn cache_root(db: &Path) -> Result<PathBuf, String> {
    cache::root(db)
}
fn cache_size(root: &Path) -> Result<u64, String> {
    if !root.exists() {
        return Ok(0);
    }
    let mut size = 0u64;
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        size = size.saturating_add(entry.metadata().map_err(|e| e.to_string())?.len());
    }
    Ok(size)
}
pub(super) fn matches_manifest(path: &Path, m: &Manifest) -> bool {
    file_bytes(path).is_ok_and(|bytes| {
        bytes.len() as u64 == m.size
            && hash(&bytes) == m.hash
            && infer::get(&bytes).is_some_and(|v| v.mime_type() == m.mime)
    })
}
fn matching_cache(db: &Path, m: &Manifest) -> Result<Option<PathBuf>, String> {
    let root = cache_root(db)?;
    if !root.exists() {
        return Ok(None);
    }
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.file_stem().and_then(|v| v.to_str()) == Some(m.hash.as_str())
            && cache::regular(&path)
            && matches_manifest(&path, m)
        {
            return Ok(Some(path));
        }
    }
    Ok(None)
}
fn local_available(
    c: &Connection,
    db: &Path,
    ns: &str,
    key: &str,
    url: &str,
) -> Result<bool, String> {
    let Some(path) = local_path(c, key, url) else {
        return Ok(false);
    };
    if path.parent() != Some(cache_root(db)?.as_path()) {
        return Ok(true);
    }
    let (post, _) = current(c, key)?;
    Ok(load_manifest(c, ns, key, &post, url)?
        .is_some_and(|m| m.state == "ready" && matches_manifest(&path, &m)))
}
fn store_cache(db: &PathBuf, m: &Manifest, bytes: &[u8], p: &Policy) -> Result<PathBuf, String> {
    let detected = infer::get(bytes).ok_or("附件实际格式无法识别")?;
    if detected.mime_type() != m.mime || hash(bytes) != m.hash || bytes.len() as u64 != m.size {
        return Err("附件内容、格式或大小校验失败".into());
    }
    let root = cache_root(db)?;
    let target = root.join(format!("{}.{}", m.hash, detected.extension()));
    if fs::symlink_metadata(&target).is_ok() && !cache::regular(&target) {
        return Err("缓存目标不是普通文件，已停止下载".into());
    }
    if target.is_file() && file_bytes(&target).is_ok_and(|v| v == bytes) {
        return Ok(target);
    }
    let replaced_size = fs::metadata(&target).map(|v| v.len()).unwrap_or(0);
    if cache_size(&root)?
        .saturating_sub(replaced_size)
        .saturating_add(m.size)
        > p.cache_mb * MB
    {
        return Err(retry::wait(
            retry::Admission::Cache,
            "阅读附件缓存已达上限，请在云同步设置中提高缓存额度",
        ));
    }
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let temporary = root.join(format!(".{}.{}.tmp", m.hash, random_url_safe(8)));
    let result = (|| {
        let mut f = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        f.write_all(bytes).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
        drop(f);
        fs::rename(&temporary, &target).map_err(|e| e.to_string())?;
        Ok(target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}
pub(super) async fn download_with_budget(
    db: &PathBuf,
    remote: &dyn ReadingStore,
    ns: &str,
    key: &str,
    url: &str,
    p: &Policy,
    manual: bool,
    budget: &mut Budget,
) -> Result<(), String> {
    let m = {
        let c = open_database(db)?;
        let (post, urls) = current(&c, key)?;
        if !urls.iter().any(|v| v == url) {
            return Err("附件不属于当前正文".into());
        }
        load_manifest(&c, ns, key, &post, url)?.ok_or("尚未收到此正文的附件清单，请先同步阅读")?
    };
    if m.state != "ready" {
        return Err("云端尚无完整附件；请在原设备上传".into());
    }
    if !allowed_resource(&open_database(db)?, key, url, p, &m.mime, m.size, manual)? {
        return Err(retry::wait(
            retry::Admission::Type,
            "此附件需手动下载，或超过当前大小限制",
        ));
    }
    // Source downloads remain usable without charging cloud budgets.
    {
        let (c, _writer) = open_write_database(db)?;
        if let Some(path) = local_path(&c, key, url) {
            if matches_manifest(&path, &m) {
                if path.parent() == Some(cache_root(db)?.as_path()) {
                    cache::register(&c, db, &path, &m)?;
                }
                return Ok(());
            }
        }
    }
    let external_x = crate::data_backup::media_policy::is_x(key);
    if external_x {
        crate::data_backup::media_policy::x_vault(&open_database(db)?)?;
    }
    let root = cache_root(db)?;
    // Reuse verified blobs across articles without another network transfer or quota charge.
    if let Some(path) = matching_cache(db, &m)? {
        let (c, _writer) = open_write_database(db)?;
        if current(&c, key)?.0 != m.post_hash {
            return Err("阅读正文已变化，未关联旧附件".into());
        }
        x_bookmarks::storage::record_saved_media(&c, key, url, &path)?;
        if !external_x {
            cache::register(&c, db, &path, &m)?;
        }
        c.execute(
            "DELETE FROM reading_media_errors WHERE namespace=?1 AND item_key=?2 AND url=?3",
            params![ns, key, url],
        )
        .map_err(|e| e.to_string())?;
        return Ok(());
    }
    // A damaged owned cache file can be replaced even when the cache is otherwise full.
    let replaced_size = fs::read_dir(&root)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|v| v.path().file_stem().and_then(|s| s.to_str()) == Some(m.hash.as_str()))
        .filter_map(|v| v.metadata().ok())
        .map(|v| v.len())
        .sum::<u64>();
    if !external_x
        && cache_size(&root)?
            .saturating_sub(replaced_size)
            .saturating_add(m.size)
            > p.cache_mb * MB
    {
        return Err(retry::wait(
            retry::Admission::Cache,
            "阅读附件缓存额度不足，请提高缓存上限",
        ));
    }
    check_network(remote, &blob_key(remote, &m.hash))?;
    let bytes = budget
        .get(
            db,
            p,
            remote,
            &blob_key(remote, &m.hash),
            m.size as usize + 1,
        )
        .await?
        .ok_or("云端附件已缺失，请在原设备重新上传")?;
    // A local edit or deletion while downloading must not attach stale media to new content.
    let (mut c, _writer) = open_write_database(db)?;
    let (post, urls) = current(&c, key)?;
    if post != m.post_hash || !urls.iter().any(|v| v == url) {
        return Err("阅读正文已变化，未关联旧附件".into());
    }
    let path = if external_x {
        if hash(&bytes) != m.hash
            || bytes.len() as u64 != m.size
            || !infer::get(&bytes).is_some_and(|kind| kind.mime_type() == m.mime)
        {
            return Err("附件内容、格式或大小校验失败".into());
        }
        crate::data_backup::media_policy::save_x_bytes(&c, url, &bytes)?
    } else {
        store_cache(db, &m, &bytes, p)?
    };
    let tx = c.transaction().map_err(|e| e.to_string())?;
    if !external_x {
        cache::register(&tx, db, &path, &m)?;
    }
    x_bookmarks::storage::record_saved_media(&tx, key, url, &path)?;
    tx.execute(
        "DELETE FROM reading_media_errors WHERE namespace=?1 AND item_key=?2 AND url=?3",
        params![ns, key, url],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}
pub(super) async fn download(
    db: &PathBuf,
    remote: &dyn ReadingStore,
    ns: &str,
    key: &str,
    url: &str,
    p: &Policy,
    manual: bool,
) -> Result<(), String> {
    let manifest = {
        let c = open_database(db)?;
        current(&c, key)
            .ok()
            .map(|(post, _)| load_manifest(&c, ns, key, &post, url))
            .transpose()?
            .flatten()
    };
    let retry_id = manifest
        .as_ref()
        .map(|m| serde_json::to_vec(m).map(|v| hash(&v)))
        .transpose()
        .map_err(|e| e.to_string())?;
    if !manual {
        if let (Some(m), Some(id)) = (&manifest, &retry_id) {
            let c = open_database(db)?;
            if !retry::due(&c, ns, "download", id)?
                && !local_path(&c, key, url).is_some_and(|path| matches_manifest(&path, m))
            {
                return Err("附件暂时不可用，稍后自动重试；也可手动下载".into());
            }
        }
    }
    let (result, waiting) = retry::track(download_with_budget(
        db,
        remote,
        ns,
        key,
        url,
        p,
        manual,
        &mut Budget::new(p),
    ))
    .await;
    if let Err(e) = &result {
        if let Some(id) = &retry_id {
            retry::failed(db, ns, "download", id, waiting)?;
        }
        error(db, ns, key, url, e)?;
    } else {
        let (c, _writer) = open_write_database(db)?;
        if let Some(id) = &retry_id {
            retry::clear(&c, ns, "download", id)?;
        }
        c.execute(
            "DELETE FROM reading_media_errors WHERE namespace=?1 AND item_key=?2 AND url=?3",
            params![ns, key, url],
        )
        .map_err(|e| e.to_string())?;
    }
    result
}
fn require_automatic_preview(c: &Connection, ns: &str, key: &str, url: &str) -> Result<(), String> {
    if preview_only(c, key, url)? {
        let (post, _) = current(c, key)?;
        if let Some(m) = load_manifest(c, ns, key, &post, url)? {
            if cache::evicted(c, &m.hash)? {
                return Err("缩略图已主动清理，请在附件云副本中手动下载".into());
            }
        }
    }
    Ok(())
}
pub(crate) async fn ensure(app: &AppHandle, key: &str, url: &str) -> Result<(), String> {
    let db = database_path(app)?;
    {
        let c = open_database(&db)?;
        let ns = object_store::namespace(&c).unwrap_or_default();
        if local_available(&c, &db, &ns, key, url)? {
            return Ok(());
        }
    }
    let _guard = LOCK.lock().await;
    let (remote, ns, p) = {
        let c = open_database(&db)?;
        cloud_sync::require_reading(&c, false)?;
        let p = policy(&c)?;
        let ns = object_store::namespace(&c)?;
        if !p.enabled {
            return Err("附件尚未下载，请开启阅读附件同步或在原设备下载".into());
        }
        require_automatic_preview(&c, &ns, key, url)?;
        (object_store::store(app, &c)?, ns, p)
    };
    download(&db, &remote, &ns, key, url, &p, false).await
}
fn next_local_manifest(
    c: &Connection,
    ns: &str,
    after: u64,
    upper: u64,
) -> Result<Option<(String, u64)>, String> {
    c.query_row("SELECT body,local_seq FROM reading_media_manifests WHERE namespace=?1 AND local_seq>?2 AND local_seq<=?3 ORDER BY local_seq LIMIT 1",params![ns,after,upper],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e|e.to_string())
}

pub(crate) async fn sync(
    db: &PathBuf,
    remote: &dyn ReadingStore,
    ns: &str,
    device: &str,
) -> Result<Summary, String> {
    let p = {
        let c = open_database(db)?;
        policy(&c)?
    };
    if !p.enabled {
        return Ok(Summary::default());
    }
    let deferred = {
        let (mut c, _writer) = open_write_database(db)?;
        let tx = c.transaction().map_err(|e| e.to_string())?;
        let deferred = stage(&tx, ns, device, &p, None)?;
        tx.commit().map_err(|e| e.to_string())?;
        deferred
    };
    let mut budget = Budget::new(&p);
    let mut result = uploads(db, remote, ns, &p, &mut budget, None).await?;
    result.pending += deferred;
    let prefix = remote.key(MANIFESTS);
    let inventory = crate::cloud_inventory::acquire_receive(
        db,
        remote,
        ns,
        "reading-media-manifests",
        MANIFESTS,
        "reading_media_applied",
    )
    .await?;
    let mut received = 0;
    let mut receive_after = None;
    while received < 100 {
        let Some(key) = inventory.next_unapplied(
            &open_database(db)?,
            "reading_media_applied",
            receive_after.as_deref(),
        )?
        else {
            break;
        };
        receive_after = Some(key.clone());
        let id = key
            .strip_prefix(&prefix)
            .and_then(|v| v.strip_suffix(".json"))
            .filter(|v| valid_hash(v))
            .ok_or("附件清单对象名称无效")?;
        check_network(remote, &key)?;
        let bytes = match budget.get(db, &p, remote, &key, MAX_MANIFEST).await {
            Ok(Some(bytes)) => bytes,
            Ok(None) => return Err("附件清单读取时消失".into()),
            Err(e) if e.contains("传输额度不足") => {
                continue;
            }
            Err(e) => return Err(e),
        };
        if hash(&bytes) != id {
            return Err("附件清单哈希校验失败".into());
        }
        let m: Manifest = serde_json::from_slice(&bytes).map_err(|_| "附件清单格式无效")?;
        let (mut c, _writer) = open_write_database(db)?;
        let tx = c.transaction().map_err(|e| e.to_string())?;
        accept(&tx, ns, &m)?;
        tx.execute(
            "INSERT OR IGNORE INTO reading_media_applied VALUES(?1,?2)",
            params![ns, id],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        received += 1;
    }
    {
        let (c, _writer) = open_write_database(db)?;
        let pending = inventory.unapplied_count(&c, "reading_media_applied")?;
        result.pending += pending;
        if pending == 0 {
            inventory.release(&c)?;
        }
    }
    if p.download == "all" {
        let cursor_key = format!("reading_media_download_cursor_{}", hash(ns.as_bytes()));
        let (start_cursor, max_sequence) = {
            let c = open_database(db)?;
            let cursor = metadata_u64(&c, &cursor_key, 0);
            let maximum=c.query_row("SELECT coalesce(max(local_seq),0) FROM reading_media_manifests WHERE namespace=?1",[ns],|r|r.get::<_,u64>(0)).map_err(|e|e.to_string())?;
            (cursor, maximum)
        };
        let mut attempted = 0;
        let mut wrapped = false;
        let mut scan_sequence = start_cursor;
        loop {
            let next = {
                let c = open_database(db)?;
                next_local_manifest(
                    &c,
                    ns,
                    scan_sequence,
                    if wrapped {
                        start_cursor.min(max_sequence)
                    } else {
                        max_sequence
                    },
                )?
            };
            let Some((raw, cursor)) = next else {
                if !wrapped {
                    wrapped = true;
                    scan_sequence = 0;
                    continue;
                }
                break;
            };
            scan_sequence = cursor;
            let m: Manifest = serde_json::from_str(&raw).map_err(|_| "附件清单损坏")?;
            let retry_id = hash(raw.as_bytes());
            if m.state != "ready"
                || !allowed_resource(
                    &open_database(db)?,
                    &m.key,
                    &m.url,
                    &p,
                    &m.mime,
                    m.size,
                    false,
                )
                .unwrap_or(false)
            {
                continue;
            }
            {
                let c = open_database(db)?;
                if !current(&c, &m.key).is_ok_and(|(post, _)| post == m.post_hash)
                    || cache::evicted(&c, &m.hash)?
                    || local_available(&c, db, ns, &m.key, &m.url)?
                {
                    continue;
                }
                if !retry::due(&c, ns, "download", &retry_id)? {
                    result.pending += 1;
                    continue;
                }
            }
            if attempted >= 100 {
                result.pending += 1;
                continue;
            }
            attempted += 1;
            {
                let (c, _writer) = open_write_database(db)?;
                meta(&c, &cursor_key, &cursor.to_string())?;
            }
            let (attempt, waiting) = retry::track(download_with_budget(
                db,
                remote,
                ns,
                &m.key,
                &m.url,
                &p,
                false,
                &mut budget,
            ))
            .await;
            match attempt {
                Ok(()) => {
                    let (c, _writer) = open_write_database(db)?;
                    retry::clear(&c, ns, "download", &retry_id)?;
                    result.downloaded += 1;
                }
                Err(e) => {
                    let stopped = retry::failed(db, ns, "download", &retry_id, waiting)?;
                    let message = if stopped {
                        format!("{e}；自动重试已暂停，请手动下载此附件")
                    } else {
                        e
                    };
                    error(db, ns, &m.key, &m.url, &message)?;
                    result.failed += 1;
                }
            }
        }
    }
    {
        let c = open_database(db)?;
        result.pending += c
            .query_row(
                "SELECT count(*) FROM reading_media_outbox WHERE namespace=?1",
                [ns],
                |r| r.get::<_, usize>(0),
            )
            .map_err(|e| e.to_string())?;
    }
    Ok(result)
}

#[cfg(test)]
mod tests;
