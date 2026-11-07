//! A source receipt preserves the original task, independently of the readable article.
//! A persisted receipt is history; only an in-flight freshly checked permit can authorize deletion.
use super::*;
use crate::reading_sync::{media::recovery, object_store};
use std::time::Instant;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Original {
    url: String,
    hash: String,
    mime: String,
    size: u64,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    format: String,
    version: u32,
    key: String,
    snapshot_hash: String,
    post_hash: String,
    source_snapshot: Value,
    originals: Vec<Original>,
}
pub(crate) fn migration_inventory(bytes: &[u8]) -> Result<Vec<(String, String, u64)>, String> {
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("来源恢复快照超过大小上限".into());
    }
    let envelope: Envelope = serde_json::from_slice(bytes).map_err(|_| "来源恢复快照格式无效")?;
    let valid_hash = |s: &str| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    };
    if envelope.format != "hub-reading-source-receipt"
        || envelope.version != 1
        || !envelope.key.strip_prefix("dida:").is_some_and(valid_hash)
        || !valid_hash(&envelope.post_hash)
        || storage::hash(envelope.source_snapshot.to_string().as_bytes()) != envelope.snapshot_hash
        || envelope.originals.len() > 100
    {
        return Err("来源恢复快照身份或协议无效".into());
    }
    if !envelope
        .source_snapshot
        .get("attachments")
        .is_some_and(Value::is_array)
        || [
            "childIds",
            "child_ids",
            "children",
            "childTasks",
            "child_tasks",
        ]
        .iter()
        .filter_map(|name| envelope.source_snapshot.get(*name))
        .any(|v| !v.as_array().is_some_and(Vec::is_empty))
    {
        return Err("来源恢复快照的完整附件或子任务库存无法核验".into());
    }
    let mut tasks = Vec::new();
    collect_dida_tasks(&envelope.source_snapshot, "", &mut tasks);
    if tasks.len() != 1 {
        return Err("来源恢复快照必须包含唯一原始任务".into());
    }
    let task = &tasks[0];
    if !selected(task) || !valid_id(&task.id) || !valid_id(&task.project_id) {
        return Err("来源恢复快照任务身份无效".into());
    }
    let refs = refs(task)?;
    if refs.len() != envelope.originals.len() {
        return Err("来源恢复快照的原附件库存不完整".into());
    }
    let library_hash = envelope
        .originals
        .first()
        .and_then(|v| v.url.split('/').next())
        .and_then(|v| v.strip_prefix("dida:"))
        .unwrap_or("");
    let mut seen = HashSet::new();
    for original in &envelope.originals {
        if !valid_hash(library_hash)
            || !valid_hash(&original.hash)
            || original.size == 0
            || original.size > 100 * 1024 * 1024
            || original.mime.is_empty()
            || !seen.insert(&original.url)
            || !refs.iter().any(|a| {
                original.url
                    == format!(
                        "dida:{}/{}/{}/{}",
                        library_hash, task.id, a.attachment_id, a.file_name
                    )
            })
        {
            return Err("来源恢复快照的原件身份、大小或引用不一致".into());
        }
    }
    Ok(envelope
        .originals
        .into_iter()
        .map(|a| (a.hash, a.mime, a.size))
        .collect())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Plan {
    token: String,
    recovery: recovery::Plan,
    source_bytes: usize,
    download_bytes: u64,
    cleanup_enabled: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Report {
    complete: bool,
    checked_at: i64,
    verified: usize,
    total: usize,
    failures: Vec<String>,
}
struct Scope {
    plan: Plan,
    namespace: String,
    envelope: Vec<u8>,
    envelope_hash: String,
    inventory_hash: String,
    snapshot_hash: String,
    post_hash: String,
}
#[derive(Clone)]
pub(super) struct Permit {
    key: String,
    token: String,
    created: Instant,
}
tokio::task_local! { static PERMIT: (AppHandle, String, Permit); }

pub(super) fn schema(c: &Connection) -> Result<(), String> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS reading_source_recovery_receipts(namespace TEXT NOT NULL,item_key TEXT NOT NULL,envelope_hash TEXT NOT NULL,scope_token TEXT NOT NULL,source_hash TEXT NOT NULL,inventory_hash TEXT NOT NULL,post_hash TEXT NOT NULL,state TEXT NOT NULL,checked_at INTEGER NOT NULL,error TEXT NOT NULL,PRIMARY KEY(namespace,item_key));").map_err(|e| e.to_string())
}
fn cleanup_enabled(c: &Connection) -> bool {
    metadata_bool(c, "reading_source_cleanup", false)
}
fn build(c: &Connection, key: &str) -> Result<Scope, String> {
    crate::cloud_sync::require_reading(c, false)?;
    let (library, task_id, project, raw, source_hash, post_hash, verified, state, account): (String,String,String,String,String,String,bool,String,String) = c.query_row("SELECT library_id,task_id,project_id,raw_json,snapshot_hash,post_hash,local_verified,delete_state,account_id FROM collection_dida_reading WHERE item_key=?1",[key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?))).map_err(|_|"当前条目没有本机滴答来源回执")?;
    if identity(&library, &account, &task_id) != key || account_scope(c, &library)? != account {
        return Err("滴答来源账号或资料库身份发生变化，原项保留".into());
    }
    if !verified || state == "deleted" || storage::hash(raw.as_bytes()) != source_hash {
        return Err("本机滴答原始来源尚未完成核验，原项保留".into());
    }
    let source: Value = serde_json::from_str(&raw).map_err(|_| "滴答原始来源快照损坏")?;
    if !source.get("attachments").is_some_and(Value::is_array) {
        return Err("滴答原始附件库存未知，原项保留".into());
    }
    let mut tasks = Vec::new();
    collect_dida_tasks(&source, &project, &mut tasks);
    if tasks.len() != 1 {
        return Err("滴答原始来源必须包含唯一任务，子任务库存不能完整核验，原项保留".into());
    }
    let task = tasks
        .into_iter()
        .find(|v| v.id == task_id && v.project_id == project)
        .ok_or("滴答原始来源身份不一致")?;
    if !selected(&task)
        || snapshot(&task) != source_hash
        || [
            "childIds",
            "child_ids",
            "children",
            "childTasks",
            "child_tasks",
        ]
        .iter()
        .filter_map(|name| task.raw.get(*name))
        .any(|v| !v.as_array().is_some_and(Vec::is_empty))
    {
        return Err("滴答来源标签、身份或子任务库存不能完整核验，原项保留".into());
    }
    let expected: std::collections::BTreeSet<String> = refs(&task)?
        .iter()
        .map(|a| media_url(&library, &task_id, a))
        .collect();
    let mut q = c.prepare("SELECT media_url,blob_hash,mime_type,size FROM collection_dida_reading_assets WHERE item_key=?1 AND snapshot_hash=?2 ORDER BY media_url").map_err(|e| e.to_string())?;
    let originals = q
        .query_map(params![key, source_hash], |r| {
            Ok(Original {
                url: r.get(0)?,
                hash: r.get(1)?,
                mime: r.get(2)?,
                size: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    if originals
        .iter()
        .map(|a| a.url.clone())
        .collect::<std::collections::BTreeSet<_>>()
        != expected
    {
        return Err("滴答原始附件库存与已保存原件不一致，原项保留".into());
    }
    let namespace = object_store::namespace(c)?;
    let base = recovery::plan(c, &namespace, key, true)?;
    if base.post_hash != post_hash {
        return Err("阅读正文与滴答来源版本不同，原项保留".into());
    }
    let mut cloud = recovery::original_inventory(c, &namespace, key)?
        .into_iter()
        .map(|(url, hash, mime, size)| Original {
            url,
            hash,
            mime,
            size,
        })
        .collect::<Vec<_>>();
    cloud.sort_by(|a, b| a.url.cmp(&b.url));
    if cloud != originals {
        return Err("云端原附件清单与滴答来源原件不一致，原项保留".into());
    }
    let inventory_hash = storage::hash(&serde_json::to_vec(&originals).map_err(|e| e.to_string())?);
    let envelope = serde_json::to_vec(&Envelope {
        format: "hub-reading-source-receipt".into(),
        version: 1,
        key: key.into(),
        snapshot_hash: source_hash.clone(),
        post_hash: post_hash.clone(),
        source_snapshot: source,
        originals,
    })
    .map_err(|e| e.to_string())?;
    if envelope.len() > 2 * 1024 * 1024 {
        return Err("滴答原始来源快照超过 2 MB，本次保留原项".into());
    }
    let envelope_hash = storage::hash(&envelope);
    let token = storage::hash(
        &serde_json::to_vec(&(
            "source-recovery-v1",
            &base.token,
            &envelope_hash,
            cleanup_enabled(c),
        ))
        .map_err(|e| e.to_string())?,
    );
    let plan = Plan {
        token,
        recovery: base,
        source_bytes: envelope.len(),
        download_bytes: 0,
        cleanup_enabled: cleanup_enabled(c),
    };
    let mut scope = Scope {
        plan,
        namespace,
        envelope,
        envelope_hash,
        inventory_hash,
        snapshot_hash: source_hash,
        post_hash,
    };
    scope.plan.download_bytes =
        scope.plan.recovery.download_bytes + (scope.envelope.len() as u64) * 3 + 1;
    Ok(scope)
}
fn store_state(
    db: &PathBuf,
    key: &str,
    s: &Scope,
    state: &str,
    at: i64,
    error: &str,
) -> Result<(), String> {
    let (c, _writer) = open_write_database(db)?;
    c.execute("INSERT INTO reading_source_recovery_receipts VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(namespace,item_key) DO UPDATE SET envelope_hash=excluded.envelope_hash,scope_token=excluded.scope_token,source_hash=excluded.source_hash,inventory_hash=excluded.inventory_hash,post_hash=excluded.post_hash,state=excluded.state,checked_at=excluded.checked_at,error=excluded.error", params![s.namespace,key,s.envelope_hash,s.plan.token,s.snapshot_hash,s.inventory_hash,s.post_hash,state,at,error]).map(|_|()).map_err(|e|e.to_string())
}
async fn execute(
    db: &PathBuf,
    remote: &dyn object_store::Store,
    key: &str,
    token: &str,
) -> Result<Report, String> {
    let before = build(&open_database(db)?, key)?;
    if before.plan.token != token {
        return Err("来源、附件、云空间或设置已变化，请重新预览".into());
    }
    store_state(db, key, &before, "running", 0, "")?;
    let result: Result<Report, String> = async {
        let result = recovery::execute_source(
            db,
            remote,
            &before.namespace,
            key,
            &before.plan.recovery.token,
            &before.envelope,
        )
        .await?;
        let after = build(&open_database(db)?, key)?;
        if after.plan.token != token {
            return Err("检查期间来源或云空间已变化，原项保留".into());
        }
        Ok(Report {
            complete: result.complete,
            checked_at: result.checked_at,
            verified: result.verified,
            total: result.plan.total,
            failures: result.failures,
        })
    }
    .await;
    match result {
        Ok(report) => {
            store_state(
                db,
                key,
                &before,
                if report.complete {
                    "complete"
                } else {
                    "partial"
                },
                report.checked_at,
                &report.failures.join("\n"),
            )?;
            Ok(report)
        }
        Err(e) => {
            store_state(db, key, &before, "failed", now_timestamp(), &e)?;
            Err(e)
        }
    }
}
fn validate_permit(c: &Connection, permit: &Permit) -> Result<(), String> {
    if !cleanup_enabled(c) || permit.created.elapsed() > Duration::from_secs(180) {
        return Err("来源清理已关闭或本次恢复凭证过期，滴答原项已保留".into());
    }
    let scope = build(c, &permit.key)?;
    if scope.plan.token != permit.token {
        return Err("来源或云端恢复范围已变化，滴答原项已保留".into());
    }
    let verified: bool=c.query_row("SELECT EXISTS(SELECT 1 FROM reading_source_recovery_receipts WHERE namespace=?1 AND item_key=?2 AND scope_token=?3 AND envelope_hash=?4 AND state='complete')",params![scope.namespace,permit.key,permit.token,scope.envelope_hash],|r|r.get(0)).map_err(|e|e.to_string())?;
    if !verified {
        return Err("本次未取得完整来源恢复凭证，滴答原项已保留".into());
    }
    Ok(())
}
async fn authorize_remote(
    db: &PathBuf,
    remote: &dyn object_store::Store,
    key: &str,
) -> Result<Permit, String> {
    let c = open_database(db)?;
    crate::cloud_sync::require_reading(&c, false)?;
    if !cleanup_enabled(&c) {
        return Err("阅读云同步已启用：来源清理未开启，滴答原项已保留".into());
    }
    let scope = build(&c, key)?;
    drop(c);
    let result = execute(db, remote, key, &scope.plan.token).await?;
    if !result.complete {
        return Err(format!(
            "来源云端恢复检查未完整通过，滴答原项已保留：{}",
            result.failures.join("；")
        ));
    }
    Ok(Permit {
        key: key.into(),
        token: scope.plan.token,
        created: Instant::now(),
    })
}
pub(super) async fn authorize(
    app: &AppHandle,
    db: &PathBuf,
    key: &str,
) -> Result<Option<Permit>, String> {
    let c = open_database(db)?;
    if !crate::cloud_sync::policy(&c).reading {
        return Ok(None);
    }
    let remote = object_store::store(app, &c)?;
    drop(c);
    authorize_remote(db, remote.as_ref(), key).await.map(Some)
}
pub(super) async fn with_permit<F, T>(
    app: &AppHandle,
    library: &str,
    permit: Option<Permit>,
    future: F,
) -> T
where
    F: std::future::Future<Output = T>,
{
    if let Some(permit) = permit {
        PERMIT
            .scope((app.clone(), library.into(), permit), future)
            .await
    } else {
        future.await
    }
}
pub(super) async fn writer_check(
    client: &reqwest::Client,
    session: &McpSession,
    db: &PathBuf,
    operation: &library_runtime::Operation,
) -> Result<(), String> {
    let Some((app, library, permit)) = PERMIT.try_with(Clone::clone).ok() else {
        return crate::reading_sync::require_source_preservation(&open_database(db)?);
    };
    validate_permit(&open_database(db)?, &permit)?;
    let (task_id, account): (String, String) = open_database(db)?
        .query_row(
            "SELECT task_id,account_id FROM collection_dida_reading WHERE item_key=?1",
            [&permit.key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| "来源清理回执丢失")?;
    let record = receipt(&open_database(db)?, &library, &task_id)?.ok_or("来源清理回执丢失")?;
    let fresh = read_task(client, session, &task_id, &record.project, 74005)
        .await?
        .ok_or("滴答来源已消失，先重新同步核验")?;
    let (fresh, identity, _) = exact_web_task(&app, operation, &fresh, &library, &account).await?;
    let c = open_database(db)?;
    account_matches(&c, &library, &account, &identity)?;
    can_delete(&record, &fresh)?;
    let mut cfg = storage::config(&c)?;
    cfg.download_media = true;
    verify_local(&c, &record, &cfg)?;
    if owned_copy(&c, &library, &task_id)? {
        return Err("当前来源已是 Hub 管理的副本，原项保留".into());
    }
    validate_permit(&c, &permit)?;
    checkpoint_path(db, operation)
}

#[tauri::command]
pub(crate) fn get_reading_source_cleanup(app: AppHandle) -> Result<bool, String> {
    Ok(cleanup_enabled(&open_database(&database_path(&app)?)?))
}
#[tauri::command]
pub(crate) async fn set_reading_source_cleanup(
    app: AppHandle,
    enabled: bool,
) -> Result<bool, String> {
    if enabled && cfg!(target_os = "android") {
        return Err("滴答来源清理由桌面端管理".into());
    }
    let _guard = crate::reading_sync::LOCK.lock().await;
    let (c, _writer) = open_write_database(&database_path(&app)?)?;
    if enabled {
        crate::cloud_sync::require_reading(&c, false)?;
    }
    meta(
        &c,
        "reading_source_cleanup",
        if enabled { "1" } else { "0" },
    )?;
    Ok(enabled)
}
#[tauri::command]
pub(crate) async fn preview_reading_source_recovery(
    app: AppHandle,
    key: String,
) -> Result<Plan, String> {
    let _guard = crate::reading_sync::LOCK.lock().await;
    let c = open_database(&database_path(&app)?)?;
    build(&c, &key).map(|s| s.plan)
}
#[tauri::command]
pub(crate) async fn check_reading_source_recovery(
    app: AppHandle,
    key: String,
    token: String,
) -> Result<Report, String> {
    let _guard = crate::reading_sync::LOCK.lock().await;
    let db = database_path(&app)?;
    let remote = object_store::store(&app, &open_database(&db)?)?;
    execute(&db, remote.as_ref(), &key, &token).await
}

#[cfg(test)]
mod tests;
