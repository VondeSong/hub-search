//! Provider configuration and restart-safe immutable OSS change journal.
use super::*;
use crate::flashcard_object_store::{OssConfig, OssStore};
mod baseline;
mod history;
mod media_delivery;
mod media_index;
mod migration;
use crate::flashcard_snapshot::records;
mod recovery;
const OSS_SECRET: &str = "hub-flashcard-oss-secret-v1";
const SNAPSHOT_RECORD_FIELDS: [&str; 8] = [
    "folders",
    "tombstones",
    "decks",
    "cards",
    "reviews",
    "qualityRecords",
    "drafts",
    "schedulerProfiles",
];

fn record_identity(field: &str, value: &Value) -> String {
    if field == "tombstones" {
        format!("{}:{}", value["entityType"], value["entityId"])
    } else {
        value["id"].to_string()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CloudSettings {
    provider: String,
    legacy_retired: bool,
    oss: Option<OssConfig>,
    has_secret: bool,
    device_id: String,
    media_policy: String,
    migration: Option<Value>,
}

pub(super) fn provider(c: &Connection) -> String {
    match metadata_string(c, "flashcard_cloud_provider").as_str() {
        "oss" => "oss",
        _ => "none",
    }
    .into()
}
pub(super) fn config(c: &Connection) -> Result<OssConfig, String> {
    serde_json::from_str(&metadata_string(c, "flashcard_oss_config"))
        .map_err(|_| "尚未配置阿里云 OSS".into())
}
fn meta(c: &Connection, key: &str, value: &str) -> Result<(), String> {
    c.execute("INSERT INTO metadata(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,value])
        .map_err(|e| e.to_string())?;
    Ok(())
}
pub(super) fn legacy_retired(c: &Connection) -> bool {
    provider(c) != "oss"
        && (metadata_string(c, "flashcard_cloud_provider") == "webdav"
            || !metadata_string(c, "flashcard_webdav_url").trim().is_empty())
}
pub(super) fn configured(c: &Connection) -> bool {
    provider(c) == "oss" && config(c).and_then(OssConfig::normalized).is_ok()
}
#[tauri::command]
pub(super) fn get_flashcard_cloud_sync_settings(app: AppHandle) -> Result<CloudSettings, String> {
    let (c, _writer) = open_write_database(&database_path(&app)?)?;
    Ok(CloudSettings {
        provider: provider(&c),
        legacy_retired: legacy_retired(&c),
        oss: config(&c).ok(),
        has_secret: stored_secret_get(&app, OSS_SECRET)?.is_some(),
        device_id: flashcard_sync_device_id(&c)?,
        migration: serde_json::from_str(&metadata_string(&c, "cloud_migration_report")).ok(),
        media_policy: match metadata_string(&c, "flashcard_cloud_media_policy").as_str() {
            "onDemand" => "onDemand",
            _ => "all",
        }
        .into(),
    })
}

#[tauri::command]
pub(super) async fn save_flashcard_oss_config(
    app: AppHandle,
    oss: OssConfig,
    secret: Option<String>,
    media_policy: String,
    other_devices_ready: Option<bool>,
) -> Result<CloudSettings, String> {
    let _guard = FLASHCARD_SYNC_LOCK.lock().await;
    let _reading_guard = reading_sync::LOCK.lock().await;
    let _quick_guard = quick_journal::LOCK.lock().await;
    let oss = oss.normalized()?;
    if !matches!(media_policy.as_str(), "all" | "onDemand") {
        return Err("附件下载策略无效".into());
    }
    let db = database_path(&app)?;
    let c = open_database(&db)?;
    let active_change =
        provider(&c) == "oss" && config(&c)?.normalized()?.namespace() != oss.namespace();
    let secret = secret.filter(|s| !s.is_empty());
    if config(&c).is_ok_and(|old| old.access_key_id != oss.access_key_id) && secret.is_none() {
        return Err("更换 AccessKey ID 时，请同时填写对应的 Secret".into());
    }
    if secret.is_none() && stored_secret_get(&app, OSS_SECRET)?.is_none() {
        return Err("请填写 AccessKey Secret".into());
    }
    drop(c);
    let receipt = if active_change {
        Some(
            migration::prepare(
                &app,
                &reading_sync::object_store::Configuration::Oss {
                    config: oss.clone(),
                },
                secret.clone(),
                other_devices_ready.unwrap_or(false),
            )
            .await?,
        )
    } else {
        None
    };
    let (mut c, _writer) = open_write_database(&db)?;
    cloud_sync::initialize(&c)?;
    let previous = stored_secret_get(&app, OSS_SECRET)?;
    if let Some(secret) = &secret {
        stored_secret_set(&app, OSS_SECRET, secret)?;
    }
    let result = (|| {
        let tx = c.transaction().map_err(|e| e.to_string())?;
        if let Some(receipt) = &receipt {
            receipt.verify(&tx)?;
        }
        meta(
            &tx,
            "flashcard_oss_config",
            &serde_json::to_string(&oss).map_err(|e| e.to_string())?,
        )?;
        meta(&tx, "flashcard_cloud_media_policy", &media_policy)?;
        mark_flashcard_sync_dirty(&tx)?;
        tx.commit().map_err(|e| e.to_string())
    })();
    if let Err(e) = result {
        if secret.is_some() {
            if let Some(previous) = previous {
                let _ = stored_secret_set(&app, OSS_SECRET, &previous);
            } else {
                stored_secret_delete(&app, OSS_SECRET);
            }
        }
        return Err(e);
    }
    drop(c);
    drop(_writer);
    get_flashcard_cloud_sync_settings(app)
}
pub(super) fn store(app: &AppHandle, c: &Connection) -> Result<OssStore, String> {
    let remote = OssStore::new(
        config(c)?,
        stored_secret_get(app, OSS_SECRET)?.unwrap_or_default(),
    )?;
    let prefix = remote.key("reading/");
    let guard = match crate::cloud_network::policy(c) {
        Ok(mode) => crate::cloud_network::guard(app.clone(), mode),
        Err(reason) => std::sync::Arc::new(move || Err(reason.clone())),
    };
    Ok(remote.with_network_guard(prefix, guard))
}
#[tauri::command]
pub(super) async fn test_flashcard_oss_connection(app: AppHandle) -> Result<String, String> {
    let _guard = FLASHCARD_SYNC_LOCK.lock().await;
    let c = open_database(&database_path(&app)?)?;
    let remote = store(&app, &c)?;
    drop(c);
    probe_connection(&remote).await?;
    Ok("OSS 列表、上传、下载和读回校验通过；当前同步服务保持不变".into())
}
async fn probe_connection(remote: &OssStore) -> Result<(), String> {
    // A fresh tiny object checks current write permission on every invocation.
    // Keep the content-addressed probe; no delete permission is required.
    let bytes = format!(
        "Hub flashcard OSS connection probe v2 {}",
        random_url_safe(12)
    );
    let key = remote.key(&format!("probes/{:x}", Sha256::digest(bytes.as_bytes())));
    remote.list_page("changes/", None).await?;
    remote.put_verified(&key, bytes.as_bytes()).await?;
    Ok(())
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Change {
    pub(crate) format: String,
    pub(crate) version: i64,
    pub(crate) checkpoint: bool,
    pub(crate) snapshot: FlashcardSyncSnapshot,
}

fn ensure_journal(c: &Connection) -> Result<(), String> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS flashcard_cloud_uploads(
        namespace TEXT NOT NULL,id TEXT NOT NULL,body BLOB NOT NULL,baseline TEXT NOT NULL,status TEXT NOT NULL,
        PRIMARY KEY(namespace,id));
      CREATE TABLE IF NOT EXISTS flashcard_cloud_baselines(namespace TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS flashcard_cloud_applied(namespace TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(namespace,id));
      CREATE TABLE IF NOT EXISTS flashcard_cloud_media_queue(namespace TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(namespace,hash));
      CREATE TABLE IF NOT EXISTS flashcard_cloud_recovery(namespace TEXT NOT NULL,id TEXT NOT NULL,body BLOB NOT NULL,PRIMARY KEY(namespace,id));
      CREATE TABLE IF NOT EXISTS flashcard_cloud_recovery_control(namespace TEXT PRIMARY KEY,body BLOB NOT NULL);")
      .map_err(|e| format!("无法准备同步变更日志：{e}"))?;
    crate::local_database_maintenance::ensure_sequences(c, &["flashcard_cloud_uploads"])
}
fn difference(
    current: &FlashcardSyncSnapshot,
    base: Option<&FlashcardSyncSnapshot>,
) -> Result<Option<FlashcardSyncSnapshot>, String> {
    let Some(base) = base else {
        return Ok(Some(current.clone()));
    };
    let mut next = serde_json::to_value(current).map_err(|e| e.to_string())?;
    let previous = serde_json::to_value(base).map_err(|e| e.to_string())?;
    let mut changed = current.version != base.version;
    for field in SNAPSHOT_RECORD_FIELDS {
        let old: HashMap<_, _> = previous[field]
            .as_array()
            .into_iter()
            .flatten()
            .map(|v| (record_identity(field, v), v))
            .collect();
        let items = next[field].as_array_mut().ok_or("同步快照字段无效")?;
        items.retain(|v| {
            old.get(&record_identity(field, v))
                .is_none_or(|old| *old != v)
        });
        changed |= !items.is_empty();
    }
    if next["studySettings"] == previous["studySettings"] {
        next["studySettings"] = Value::Null;
    } else {
        changed = true;
    }
    if !changed {
        return Ok(None);
    }
    serde_json::from_value(next)
        .map(Some)
        .map_err(|e| e.to_string())
}
fn stage(c: &Connection, namespace: &str, checkpoint: bool) -> Result<(), String> {
    ensure_journal(c)?;
    baseline::stage(c, namespace, checkpoint)
}

pub(crate) fn ensure_tracking(c: &Connection) -> Result<(), String> {
    baseline::ensure_tracking(c)
}

pub(crate) fn rebuilt_review_tables(
    c: &Connection,
    reviews: bool,
    profiles: bool,
) -> Result<(), String> {
    baseline::rebuilt_review_tables(c, reviews, profiles)
}

fn absorb_verified_remote(
    c: &Connection,
    namespace: &str,
    remote: &FlashcardSyncSnapshot,
) -> Result<(), String> {
    baseline::absorb(c, namespace, remote)
}

fn coalesce<T: Clone + Serialize, K: Ord>(
    items: &mut Vec<T>,
    identity: impl Fn(&T) -> String,
    clock: impl Fn(&T) -> Result<K, String>,
) -> Result<(), String> {
    let mut unique = std::collections::BTreeMap::new();
    for item in items.drain(..) {
        let key = identity(&item);
        let order = (
            clock(&item)?,
            serde_json::to_vec(&item).map_err(|e| e.to_string())?,
        );
        if unique
            .get(&key)
            .is_none_or(|(previous, _)| &order > previous)
        {
            unique.insert(key, (order, item));
        }
    }
    *items = unique.into_values().map(|(_, item)| item).collect();
    Ok(())
}
pub(crate) fn compact(snapshot: &mut FlashcardSyncSnapshot) -> Result<(), String> {
    coalesce(
        &mut snapshot.folders,
        |v| v.id.clone(),
        |v| Ok(v.updated_at),
    )?;
    coalesce(&mut snapshot.decks, |v| v.id.clone(), |v| Ok(v.updated_at))?;
    coalesce(&mut snapshot.cards, |v| v.id.clone(), |v| Ok(v.updated_at))?;
    flashcard_review_log::compact(&mut snapshot.reviews)?;
    coalesce(
        &mut snapshot.scheduler_profiles,
        |v| v.id.clone(),
        |v| v.content_id(),
    )?;
    coalesce(
        &mut snapshot.tombstones,
        |v| format!("{}:{}", v.entity_type, v.entity_id),
        |v| Ok(v.deleted_at),
    )?;
    coalesce(
        &mut snapshot.drafts,
        |v| flashcard_sync_drafts::identity(v).into(),
        flashcard_sync_drafts::precedence,
    )?;
    // Quality merge owns conflict histories: remove only exact repeated checkpoint entries.
    let mut seen = HashSet::new();
    snapshot
        .quality_records
        .retain(|v| seen.insert(v.to_string()));
    Ok(())
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CloudReport {
    pub uploaded_bytes: u64,
    pub downloaded_bytes: u64,
    pub pending_media: usize,
    pub uploaded_changes: usize,
    pub downloaded_changes: usize,
    pub completed_at: i64,
}

// Blob bytes and their serving MIME index are one delivery boundary. Inference alone cannot recognize SVG.
pub(super) fn register_media_index(
    c: &Connection,
    snapshot: &FlashcardSyncSnapshot,
    blobs: &BlobStore,
    only: Option<&str>,
) -> Result<(), String> {
    media_index::register_snapshot(c, snapshot, blobs, only)
}

pub(super) async fn sync(
    app: &AppHandle,
    force_checkpoint: bool,
) -> Result<FlashcardSyncSummary, String> {
    let database = database_path(app)?;
    let (remote, namespace, download) = {
        let c = open_database(&database)?;
        (
            store(app, &c)?,
            config(&c)?.namespace(),
            force_checkpoint || metadata_string(&c, "flashcard_cloud_media_policy") != "onDemand",
        )
    };
    let state = app.state::<AppState>();
    let blobs = blob_store_for(app, &state)?;
    let result = sync_database(
        &remote,
        &database,
        &blobs,
        &namespace,
        download,
        force_checkpoint,
    )
    .await?;
    if !force_checkpoint {
        let _reading = reading_sync::LOCK.lock().await;
        let _ =
            crate::cloud_maintenance::observe_sync_success(&database, &remote, &namespace).await;
    }
    Ok(result)
}

pub(crate) async fn sync_database(
    remote: &OssStore,
    database: &PathBuf,
    blobs: &BlobStore,
    namespace: &str,
    download: bool,
    force_checkpoint: bool,
) -> Result<FlashcardSyncSummary, String> {
    let mut report = CloudReport::default();
    let mut uploaded_media = 0;
    let mut downloaded_media = 0;
    for pass in 0..2 {
        {
            let (c, _writer) = open_write_database(&database)?;
            ensure_journal(&c)?;
            baseline::reconcile(&c, namespace, |id| remote.key(&format!("changes/{id}")))?;
            stage(&c, &namespace, force_checkpoint && pass == 0)?;
        }
        loop {
            let pending = {
                let c = open_database(database)?;
                c.query_row("SELECT id,body FROM flashcard_cloud_uploads WHERE namespace=?1 AND status='pending' ORDER BY local_seq LIMIT 1",[namespace],|row|Ok((row.get::<_,String>(0)?,row.get::<_,Vec<u8>>(1)?)))
                    .optional().map_err(|e|e.to_string())?
            };
            let Some((id, body)) = pending else {
                break;
            };
            let change = recovery::decode(&id, &body)?;
            if remote
                .put_verified(&remote.key(&format!("changes/{id}")), &body)
                .await?
            {
                report.uploaded_bytes += body.len() as u64;
                report.uploaded_changes += 1;
            }
            if force_checkpoint
                && remote
                    .get(
                        &remote.key(&format!("changes/{id}")),
                        FLASHCARD_SYNC_MAX_SNAPSHOT_BYTES,
                    )
                    .await?
                    .as_deref()
                    != Some(body.as_slice())
            {
                return Err("迁移内容读回校验失败；当前服务保持不变".into());
            }
            let (mut c, _writer) = open_write_database(database)?;
            let tx = c.transaction().map_err(|e| e.to_string())?;
            for hash in flashcard_snapshot_media_hashes(&change.snapshot) {
                tx.execute("INSERT OR IGNORE INTO flashcard_cloud_media_queue(namespace,hash) VALUES(?1,?2)",params![namespace,hash]).map_err(|e|e.to_string())?;
            }
            baseline::confirm(&tx, namespace, &id)?;
            tx.execute("UPDATE flashcard_cloud_uploads SET status='complete',body=X'',baseline='' WHERE namespace=?1 AND id=?2",params![namespace,id]).map_err(|e|e.to_string())?;
            tx.execute(
                "INSERT OR IGNORE INTO flashcard_cloud_applied(namespace,id) VALUES(?1,?2)",
                params![namespace, remote.key(&format!("changes/{id}"))],
            )
            .map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
        }
    }
    let (downloaded_cards, merged_reviews) =
        recovery::recover_from_store(remote, database, namespace, &mut report).await?;
    let counts = media_delivery::deliver(
        remote,
        database,
        blobs,
        namespace,
        download,
        force_checkpoint,
        &mut report,
    )
    .await?;
    uploaded_media += counts.0;
    downloaded_media += counts.1;

    report.completed_at = now_timestamp();
    (report.uploaded_bytes, report.downloaded_bytes) = remote.transferred();
    {
        let (c, _writer) = open_write_database(&database)?;
        meta(
            &c,
            "flashcard_cloud_report",
            &serde_json::to_string(&report).map_err(|e| e.to_string())?,
        )?;
    }
    Ok(FlashcardSyncSummary {
        uploaded_cards: open_database(database)?
            .query_row("SELECT count(*) FROM flashcards", [], |r| {
                r.get::<_, usize>(0)
            })
            .map_err(|e| e.to_string())?,
        downloaded_cards,
        merged_reviews,
        uploaded_media,
        downloaded_media,
        conflict_retries: 0,
        completed_at: report.completed_at,
        cloud_report: Some(report),
    })
}

#[tauri::command]
pub(super) fn get_flashcard_cloud_sync_report(app: AppHandle) -> Result<Value, String> {
    let c = open_database(&database_path(&app)?)?;
    Ok(serde_json::from_str(&metadata_string(&c, "flashcard_cloud_report")).unwrap_or(Value::Null))
}

#[tauri::command]
pub(super) async fn ensure_flashcard_cloud_attachment(
    app: AppHandle,
    url: String,
) -> Result<(), String> {
    let hash = url
        .strip_prefix("http://craft-media.localhost/")
        .or_else(|| url.strip_prefix("craft-media://localhost/"))
        .or_else(|| url.strip_prefix("hub-media://localhost/"))
        .ok_or("附件地址无效")?;
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("附件身份无效".into());
    }
    let _guard = FLASHCARD_SYNC_LOCK.lock().await;
    let state = app.state::<AppState>();
    let blobs = blob_store_for(&app, &state)?;
    if blobs.path_for(hash)?.is_file() {
        let (_, _, checked) =
            media_delivery::verify_local_async(&database_path(&app)?, &blobs, hash, false).await?;
        let (c, _writer) = open_write_database(&database_path(&app)?)?;
        media_delivery::register_local_verified(&c, &blobs, hash, checked)?;
        return Ok(());
    }
    let (c, _writer) = open_write_database(&database_path(&app)?)?;
    cloud_sync::require_flashcards(&c, false)?;
    if provider(&c) != "oss" {
        return Err("附件尚未下载；请先完成一次云同步".into());
    }
    if !media_index::references(&c, hash)? {
        return Err("本附件未被闪卡内容引用".into());
    }
    let remote = store(&app, &c)?;
    drop(c);
    drop(_writer);
    remote
        .get_media_blob(&remote.key(&format!("media/{hash}")), hash, &blobs)
        .await?
        .ok_or("云端尚无本附件，请在原设备完成上传后重试")?;
    let (_, _, checked) =
        media_delivery::verify_local_async(&database_path(&app)?, &blobs, hash, false).await?;
    let (c, _writer) = open_write_database(&database_path(&app)?)?;
    media_delivery::register_local_verified(&c, &blobs, hash, checked)?;
    Ok(())
}

#[tauri::command]
pub(super) async fn activate_flashcard_cloud_sync(
    app: AppHandle,
    target: String,
) -> Result<CloudSettings, String> {
    if target != "oss" {
        return Err("仅支持阿里云 OSS，旧 WebDAV 同步已停用".into());
    }
    let _guard = FLASHCARD_SYNC_LOCK.lock().await;
    let database = database_path(&app)?;
    let _reading_guard = reading_sync::LOCK.lock().await;
    let _quick_guard = quick_journal::LOCK.lock().await;
    let current = {
        let c = open_database(&database)?;
        reading_sync::object_store::configuration_for(&c, &target)?;
        if stored_secret_get(&app, OSS_SECRET)?.is_none() {
            return Err("请先保存 OSS 访问密钥".into());
        }
        provider(&c)
    };
    if current == target {
        return get_flashcard_cloud_sync_settings(app);
    }
    // Initial activation changes configuration only. The ordinary sync path then honors
    // module and attachment preferences; it never reads or migrates the retired service.
    {
        let (mut c, _writer) = open_write_database(&database)?;
        let tx = c.transaction().map_err(|e| e.to_string())?;
        meta(&tx, "flashcard_cloud_provider", &target)?;
        meta(&tx, "flashcard_sync_last_error", "")?;
        meta(&tx, "flashcard_sync_last_success", "0")?;
        mark_flashcard_sync_dirty(&tx)?;
        tx.commit().map_err(|e| e.to_string())?;
    }
    get_flashcard_cloud_sync_settings(app)
}

#[cfg(test)]
pub(crate) fn content_identity(snapshot: &FlashcardSyncSnapshot) -> Result<Value, String> {
    let mut value = serde_json::to_value(snapshot).map_err(|e| e.to_string())?;
    let object = value.as_object_mut().ok_or("同步内容无效")?;
    object.remove("deviceId");
    object.remove("exportedAt");
    Ok(value)
}
#[cfg(all(test, windows))]
mod real_cloud_tests;
#[cfg(test)]
#[path = "flashcard_cloud_sync_tests.rs"]
pub(crate) mod tests;

#[cfg(test)]
pub(crate) fn maintenance_accept(
    c: &Connection,
    namespace: &str,
    keys: &[String],
    remote: &FlashcardSyncSnapshot,
) -> Result<(), String> {
    ensure_journal(c)?;
    c.execute(
        "INSERT OR IGNORE INTO flashcard_cloud_baselines(namespace,payload) VALUES(?1,?2)",
        params![
            namespace,
            serde_json::to_string(remote).map_err(|e| e.to_string())?
        ],
    )
    .map_err(|e| e.to_string())?;
    absorb_verified_remote(c, namespace, remote)?;
    for key in keys {
        c.execute(
            "INSERT OR IGNORE INTO flashcard_cloud_applied(namespace,id) VALUES(?1,?2)",
            params![namespace, key],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(crate) fn maintenance_accept_database(
    c: &Connection,
    namespace: &str,
    source: &Connection,
) -> Result<(), String> {
    ensure_journal(c)?;
    baseline::accept_database(c, namespace, source)
}
