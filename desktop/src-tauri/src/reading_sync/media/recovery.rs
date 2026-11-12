//! Explicit inspection of an uploaded version. Cloud bytes, never local cache, prove readability.
use super::*;
use crate::reading_sync as reading;
use std::collections::BTreeMap;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Entry {
    url: String,
    state: String,
    bytes: u64,
    reason: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Plan {
    pub(crate) token: String,
    pub(crate) post_hash: String,
    pub(crate) total: usize,
    pub(crate) download_bytes: u64,
    actionable: bool,
    warnings: Vec<String>,
    items: Vec<Entry>,
    previous: String,
    checked_at: i64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Outcome {
    pub(crate) plan: Plan,
    body_verified: bool,
    pub(crate) verified: usize,
    pub(crate) complete: bool,
    pub(crate) checked_at: i64,
    pub(crate) failures: Vec<String>,
}
struct Snapshot {
    plan: Plan,
    body: Vec<u8>,
    manifests: Vec<Option<Manifest>>,
    policy: Policy,
}
pub(super) fn schema(c: &Connection) -> Result<(), String> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS reading_recovery_runs(namespace TEXT NOT NULL,item_key TEXT NOT NULL,attempt TEXT NOT NULL,token TEXT NOT NULL,state TEXT NOT NULL,checked_at INTEGER NOT NULL,report TEXT NOT NULL,PRIMARY KEY(namespace,item_key));").map_err(|e|e.to_string())
}
fn unknown_content(p: &Post) -> bool {
    !matches!(p.content_status.as_str(), "complete" | "full")
        || p.media.iter().chain(&p.all_media).any(|m| m.url.is_empty())
        || p.thread.iter().any(unknown_content)
        || p.quote.as_deref().is_some_and(unknown_content)
}
fn inspect(c: &Connection, ns: &str, key: &str, extras: bool) -> Result<Snapshot, String> {
    cloud_sync::require_reading(c, false)?;
    let config = object_store::configuration(c)?;
    if config.namespace() != ns {
        return Err("阅读云空间已变化，请重新预览恢复范围".into());
    }
    let record = reading::load(c, key)?.ok_or("当前阅读版本尚未同步，请先同步阅读再检查")?;
    // The caller always rolls this transaction back. Capture detects unsynced domain edits
    // through the same formal producer without publishing versions or touching source actions.
    if reading::capture_one(c, "recovery-preview", key)?.as_ref() != Some(&record) {
        return Err("正文、状态或标签尚未同步，请先同步阅读再检查".into());
    }
    let (post_hash, urls) = originals(c, key)?;
    if urls.len() > 100 {
        return Err("本文原附件超过 100 个，本次未开始云端恢复检查".into());
    }
    let body = reading::bytes(record.clone())?;
    let body_id = hash(&body);
    let uploaded: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM reading_sync_uploaded WHERE namespace=?1 AND item_key=?2 AND id=?3)",params![ns,key,body_id],|r|r.get(0)).map_err(|e|e.to_string())?;
    if !uploaded {
        return Err("当前合并版本尚未完成上传，请同步阅读后重新检查".into());
    }
    let p = policy(c)?;
    let manifests = urls
        .iter()
        .map(|u| load_manifest(c, ns, key, &post_hash, u))
        .collect::<Result<Vec<_>, _>>()?;
    if manifests
        .iter()
        .flatten()
        .map(|m| m.size.min(MAX_FILE))
        .sum::<u64>()
        > 512 * MB
    {
        return Err("本文原附件超过单次恢复检查的 512 MB 上限，本次未开始传输".into());
    }
    let post = &record.body.value.as_ref().ok_or("阅读正文已删除")?.post;
    let mut warnings = Vec::new();
    if offline::incomplete(post) || unknown_content(post) {
        warnings.push("正文完整性未确认，或引用、回复、原附件地址不完整；不能确认完整恢复".into());
    }
    let mut payload = body.len() as u64;
    let mut unique_blobs = BTreeMap::new();
    let mut items = Vec::new();
    for (url, m) in urls.iter().zip(&manifests) {
        let mut e = Entry {
            url: url.clone(),
            state: "unavailable".into(),
            bytes: 0,
            reason: "当前正文的原附件清单尚未同步".into(),
        };
        if let Some(m) = m {
            m.validate()?;
            e.bytes = m.size;
            if m.state != "ready" {
                e.reason = if m.state == "skipped" {
                    "原设备跳过了此原附件，不能算完整恢复"
                } else {
                    "原设备尚未上传完整原附件"
                }
                .into();
            } else if !allowed_explicit(&m.mime, m.size, extras) {
                e.state = "excluded".into();
                e.reason = "未包含音视频/ZIP，或超过当前类型和大小限制".into();
            } else {
                let bytes = serde_json::to_vec(m).map_err(|e| e.to_string())?;
                if bytes.len() > MAX_MANIFEST {
                    return Err("原附件清单超过大小上限".into());
                }
                payload += bytes.len() as u64;
                unique_blobs.entry(m.hash.clone()).or_insert(m.size);
                e.state = "check".into();
                e.reason = "将实际读取云清单和原文件，不使用本机缓存代替".into();
            }
        }
        items.push(e);
    }
    payload += unique_blobs.values().sum::<u64>();
    let token = hash(
        &serde_json::to_vec(&(
            "reading-recovery-v1",
            ns,
            key,
            &body_id,
            &post_hash,
            &manifests,
            &p,
            extras,
            &config,
            metadata_string(c, "reading_cloud_network"),
        ))
        .map_err(|e| e.to_string())?,
    );
    let previous: Option<(String,String,i64)> = c.query_row("SELECT token,state,checked_at FROM reading_recovery_runs WHERE namespace=?1 AND item_key=?2",params![ns,key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|e|e.to_string())?;
    let (previous, checked_at) = previous
        .map(|(old, state, at)| {
            let state = if old != token {
                "stale".into()
            } else if state == "running" {
                "interrupted".into()
            } else {
                state
            };
            let checked_at = if matches!(state.as_str(), "complete" | "partial") {
                at
            } else {
                0
            };
            (state, checked_at)
        })
        .unwrap_or_default();
    Ok(Snapshot {
        plan: Plan {
            token,
            post_hash,
            total: items.len(),
            download_bytes: payload,
            actionable: true,
            warnings,
            items,
            previous,
            checked_at,
        },
        body,
        manifests,
        policy: p,
    })
}
fn snapshot(c: &Connection, ns: &str, key: &str, extras: bool) -> Result<Snapshot, String> {
    let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
    let result = inspect(&tx, ns, key, extras);
    tx.rollback().map_err(|e| e.to_string())?;
    result
}
pub(crate) fn plan(c: &Connection, ns: &str, key: &str, extras: bool) -> Result<Plan, String> {
    Ok(snapshot(c, ns, key, extras)?.plan)
}
pub(crate) fn verify_scope(
    c: &Connection,
    ns: &str,
    key: &str,
    extras: bool,
    token: &str,
) -> Result<(), String> {
    if snapshot(c, ns, key, extras)?.plan.token != token {
        return Err("当前正文、原附件或云空间已变化".into());
    }
    Ok(())
}
pub(crate) fn original_inventory(
    c: &Connection,
    ns: &str,
    key: &str,
) -> Result<Vec<(String, String, String, u64)>, String> {
    let (post, urls) = originals(c, key)?;
    urls.into_iter()
        .map(|url| {
            let m = load_manifest(c, ns, key, &post, &url)?.ok_or("原附件清单尚未同步")?;
            m.validate()?;
            if m.state != "ready" {
                return Err("原附件尚无完整云副本".into());
            }
            Ok((url, m.hash, m.mime, m.size))
        })
        .collect()
}
fn begin(db: &PathBuf, ns: &str, key: &str, p: &Plan) -> Result<String, String> {
    let attempt = random_url_safe(12);
    let (c, _writer) = open_write_database(db)?;
    c.execute("INSERT INTO reading_recovery_runs VALUES(?1,?2,?3,?4,'running',0,?5) ON CONFLICT(namespace,item_key) DO UPDATE SET attempt=excluded.attempt,token=excluded.token,state='running',checked_at=0,report=excluded.report",params![ns,key,attempt,p.token,serde_json::to_string(p).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
    Ok(attempt)
}
fn finish(
    db: &PathBuf,
    ns: &str,
    key: &str,
    attempt: &str,
    state: &str,
    at: i64,
    report: &str,
) -> Result<(), String> {
    let (c, _writer) = open_write_database(db)?;
    let changed = c.execute("UPDATE reading_recovery_runs SET state=?4,checked_at=?5,report=?6 WHERE namespace=?1 AND item_key=?2 AND attempt=?3",params![ns,key,attempt,state,at,report]).map_err(|e|e.to_string())?;
    if changed != 1 {
        return Err("恢复检查记录已被新操作替换，请重新检查".into());
    }
    Ok(())
}
async fn cloud_bytes(
    db: &PathBuf,
    remote: &dyn ReadingStore,
    p: &Policy,
    budget: &mut transfer::Budget,
    key: &str,
    size: usize,
) -> Result<Vec<u8>, String> {
    remote.check_network(key)?;
    budget
        .get(db, p, remote, key, size)
        .await?
        .ok_or("云端对象已缺失，不能确认恢复".into())
}
async fn restore_body(
    db: &PathBuf,
    remote: &dyn ReadingStore,
    s: &Snapshot,
    key: &str,
    budget: &mut transfer::Budget,
) -> Result<(), String> {
    let id = hash(&s.body);
    let bytes = cloud_bytes(
        db,
        remote,
        &s.policy,
        budget,
        &remote.key(&format!("{}{id}.json", reading::PREFIX)),
        s.body.len(),
    )
    .await?;
    if hash(&bytes) != id {
        return Err("云端正文内容校验失败".into());
    }
    let change: reading::Change = serde_json::from_slice(&bytes).map_err(|_| "阅读云格式无效")?;
    if change.version != 1 || change.format != "hub-reading-changes" || change.record.key != key {
        return Err("阅读云协议或条目身份无效".into());
    }
    let scratch = Connection::open_in_memory().map_err(|e| e.to_string())?;
    scratch
        .execute_batch("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);")
        .map_err(|e| e.to_string())?;
    x_bookmarks::storage::schema(&scratch)?;
    reading::merge(&scratch, change.record)?;
    let restored = reading::load(&scratch, key)?.ok_or("云端正文未能恢复")?;
    if reading::bytes(restored)? != s.body {
        return Err("云端状态或标签恢复结果不一致".into());
    }
    let (post, urls) = originals(&scratch, key)?;
    if post != s.plan.post_hash
        || urls
            != s.plan
                .items
                .iter()
                .map(|e| e.url.clone())
                .collect::<Vec<_>>()
    {
        return Err("云端正文或原附件引用恢复结果不一致".into());
    }
    Ok(())
}
async fn restore_asset(
    db: &PathBuf,
    remote: &dyn ReadingStore,
    s: &Snapshot,
    m: &Manifest,
    budget: &mut transfer::Budget,
    verified: &mut BTreeMap<String, Result<(u64, String), String>>,
) -> Result<(), String> {
    let expected = serde_json::to_vec(m).map_err(|e| e.to_string())?;
    let id = hash(&expected);
    let bytes = cloud_bytes(
        db,
        remote,
        &s.policy,
        budget,
        &remote.key(&format!("{MANIFESTS}{id}.json")),
        expected.len(),
    )
    .await?;
    if hash(&bytes) != id {
        return Err("云端原附件清单校验失败".into());
    }
    let cloud: Manifest = serde_json::from_slice(&bytes).map_err(|_| "云端原附件清单格式无效")?;
    cloud.validate()?;
    if cloud != *m {
        return Err("云端原附件清单与当前版本不一致".into());
    }
    if let Some(result) = verified.get(&m.hash) {
        return match result {
            Ok((size, mime)) if *size == m.size && *mime == m.mime => Ok(()),
            Ok(_) => Err("共享文件的大小或格式声明不一致".into()),
            Err(error) => Err(error.clone()),
        };
    }
    let result = async {
        let bytes = cloud_bytes(
            db,
            remote,
            &s.policy,
            budget,
            &remote.key(&format!("reading/media-v1/blobs/{}", m.hash)),
            m.size as usize,
        )
        .await?;
        if bytes.len() as u64 != m.size
            || hash(&bytes) != m.hash
            || !infer::get(&bytes).is_some_and(|v| v.mime_type() == m.mime)
        {
            return Err("云端原附件内容、大小或实际格式校验失败".into());
        }
        Ok((m.size, m.mime.clone()))
    }
    .await;
    // A failed shared blob is also one attempted transfer. Explicit rechecking creates
    // a new memo; a damaged object cannot multiply the previewed payload in this attempt.
    verified.insert(m.hash.clone(), result.clone());
    result.map(|_| ())
}
async fn perform(
    db: &PathBuf,
    remote: &dyn ReadingStore,
    s: &Snapshot,
    key: &str,
    source: Option<&[u8]>,
) -> Result<Outcome, String> {
    remote.check_network(&remote.key("reading/"))?;
    let mut budget = transfer::Budget::new(&s.policy);
    let mut out = Outcome {
        plan: s.plan.clone(),
        body_verified: false,
        verified: 0,
        complete: false,
        checked_at: 0,
        failures: Vec::new(),
    };
    if let Err(e) = restore_body(db, remote, s, key, &mut budget).await {
        out.failures.push(format!("正文：{e}"));
        return Ok(out);
    }
    out.body_verified = true;
    let mut verified = BTreeMap::new();
    for (entry, m) in s.plan.items.iter().zip(&s.manifests) {
        if entry.state != "check" {
            out.failures
                .push(format!("{}：{}", entry.url, entry.reason));
            continue;
        }
        match restore_asset(
            db,
            remote,
            s,
            m.as_ref().ok_or("原附件清单缺失")?,
            &mut budget,
            &mut verified,
        )
        .await
        {
            Ok(()) => out.verified += 1,
            Err(e) => out.failures.push(format!("{}：{e}", entry.url)),
        }
    }
    out.complete =
        out.verified == s.plan.total && out.failures.is_empty() && s.plan.warnings.is_empty();
    if out.complete {
        if let Some(bytes) = source {
            let key = remote.key(&format!("reading/source-v1/{}.json", hash(bytes)));
            let attempt = async {
                remote.check_network(&key)?;
                budget.put(db, &s.policy, remote, &key, bytes).await?;
                let actual = budget
                    .get(db, &s.policy, remote, &key, bytes.len())
                    .await?
                    .ok_or("来源恢复对象已缺失")?;
                if actual != bytes {
                    return Err("来源恢复对象实际字节校验失败".to_string());
                }
                Ok::<(), String>(())
            }
            .await;
            if let Err(e) = attempt {
                out.failures.push(format!("来源快照：{e}"));
                out.complete = false;
            }
        }
    }
    Ok(out)
}
pub(crate) async fn execute(
    db: &PathBuf,
    remote: &dyn ReadingStore,
    ns: &str,
    key: &str,
    extras: bool,
    token: &str,
) -> Result<Outcome, String> {
    execute_inner(db, remote, ns, key, extras, token, None).await
}
pub(crate) async fn execute_source(
    db: &PathBuf,
    remote: &dyn ReadingStore,
    ns: &str,
    key: &str,
    token: &str,
    source_bytes: &[u8],
) -> Result<Outcome, String> {
    if source_bytes.is_empty() || source_bytes.len() > 2 * 1024 * 1024 {
        return Err("来源恢复对象超过 2 MiB 上限或为空".into());
    }
    execute_inner(db, remote, ns, key, true, token, Some(source_bytes)).await
}
async fn execute_inner(
    db: &PathBuf,
    remote: &dyn ReadingStore,
    ns: &str,
    key: &str,
    extras: bool,
    token: &str,
    source: Option<&[u8]>,
) -> Result<Outcome, String> {
    let before = snapshot(&open_database(db)?, ns, key, extras)?;
    if before.plan.token != token {
        return Err("正文、原附件、云空间或策略已变化，请重新预览恢复范围".into());
    }
    if !before.plan.actionable {
        return Err("阅读附件同步已暂停，请开启后重新预览恢复范围".into());
    }
    let attempt = begin(db, ns, key, &before.plan)?;
    let result: Result<Outcome, String> = async {
        let mut out = perform(db, remote, &before, key, source).await?;
        let after = snapshot(&open_database(db)?, ns, key, extras)?;
        if after.plan.token != token {
            return Err("检查期间正文、原附件、云空间或策略已变化，请重新检查".into());
        }
        out.checked_at = now_timestamp();
        out.plan.previous = if out.complete { "complete" } else { "partial" }.into();
        out.plan.checked_at = out.checked_at;
        Ok(out)
    }
    .await;
    match result {
        Ok(out) => {
            finish(
                db,
                ns,
                key,
                &attempt,
                if out.complete { "complete" } else { "partial" },
                out.checked_at,
                &serde_json::to_string(&out).map_err(|e| e.to_string())?,
            )?;
            Ok(out)
        }
        Err(e) => {
            finish(db, ns, key, &attempt, "failed", now_timestamp(), &e)?;
            Err(e)
        }
    }
}
#[tauri::command]
pub(crate) async fn preview_reading_recovery(
    app: AppHandle,
    key: String,
    include_extras: bool,
) -> Result<Plan, String> {
    let _guard = LOCK.lock().await;
    let (c, _writer) = open_write_database(&database_path(&app)?)?;
    x_bookmarks::storage::schema(&c)?;
    let ns = object_store::namespace(&c)?;
    plan(&c, &ns, &key, include_extras)
}
#[tauri::command]
pub(crate) async fn check_reading_recovery(
    app: AppHandle,
    key: String,
    include_extras: bool,
    token: String,
) -> Result<Outcome, String> {
    let _guard = LOCK.lock().await;
    let db = database_path(&app)?;
    let (remote, ns) = {
        let c = open_database(&db)?;
        cloud_sync::require_reading(&c, false)?;
        (object_store::store(&app, &c)?, object_store::namespace(&c)?)
    };
    execute(&db, &remote, &ns, &key, include_extras, &token).await
}
