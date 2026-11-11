//! Explicit, bounded article downloads. Existing verified cache and pins own the files.
use super::*;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Entry {
    url: String,
    state: String,
    bytes: u64,
    reason: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Plan {
    token: String,
    post_hash: String,
    total: usize,
    available: usize,
    retained: usize,
    download_bytes: u64,
    actionable: usize,
    complete: bool,
    warnings: Vec<String>,
    items: Vec<Entry>,
    previous: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Outcome {
    succeeded: usize,
    failures: Vec<String>,
    plan: Plan,
}
pub(super) fn schema(c: &Connection) -> Result<(), String> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS reading_offline_runs(namespace TEXT,item_key TEXT,id TEXT NOT NULL,state TEXT NOT NULL,plan TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(namespace,item_key));").map_err(|e|e.to_string())
}
pub(super) fn incomplete(p: &Post) -> bool {
    p.content_status == "partial"
        || matches!(p.thread_status.as_str(), "pending" | "partial" | "limited")
        || (p.thread_format < 2 && p.reply_count > 0)
        || (!p.quote_id.is_empty() && p.quote.is_none())
        || p.thread.iter().any(incomplete)
        || p.quote.as_deref().is_some_and(incomplete)
}
pub(super) fn plan(
    c: &Connection,
    db: &Path,
    ns: &str,
    key: &str,
    extras: bool,
) -> Result<Plan, String> {
    // SQLite snapshot keeps body, manifests and policy from different revisions out of one plan.
    let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
    let result = inspect(&tx, db, ns, key, extras);
    tx.rollback().map_err(|e| e.to_string())?;
    result
}
fn inspect(c: &Connection, db: &Path, ns: &str, key: &str, extras: bool) -> Result<Plan, String> {
    let (post_hash, urls) = originals(c, key)?;
    if urls.len() > 100 {
        return Err("本文登记附件超过 100 个，请使用逐项下载；本次未开始批量传输".into());
    }
    let p = policy(c)?;
    let manifests = urls
        .iter()
        .map(|url| load_manifest(c, ns, key, &post_hash, url))
        .collect::<Result<Vec<_>, _>>()?;
    if manifests
        .iter()
        .flatten()
        .map(|m| m.size.min(MAX_FILE))
        .sum::<u64>()
        > 512 * MB
    {
        return Err("本文附件超过单次离线检查的 512 MB 上限，请使用逐项下载".into());
    }
    let mut items = Vec::new();
    let mut available = 0;
    let mut retained = 0;
    let mut actionable = 0;
    let mut needed = std::collections::BTreeMap::new();
    let root = cache::root(db)?;
    for (url, manifest) in urls.iter().zip(&manifests) {
        let mut e = Entry {
            url: url.clone(),
            state: "unavailable".into(),
            bytes: 0,
            reason: "当前正文的附件清单尚未同步".into(),
        };
        if let Some(m) = manifest {
            m.validate()?;
            e.bytes = m.size;
            if m.state != "ready" {
                e.reason = if m.state == "skipped" {
                    "原设备跳过了此附件，请先在原设备上传"
                } else {
                    "原设备尚未上传完整附件"
                }
                .into();
            } else if let Some(path) = local_path(c, key, url)
                .filter(|path| cache::regular(path) && transfer::matches_manifest(path, m))
            {
                available += 1;
                if path.parent() != Some(root.as_path()) {
                    e.state = "original".into();
                    retained += 1;
                    e.reason = "原设备文件已校验；不由 Hub 缓存清理管理".into();
                } else if cache::pinned(c, &m.hash)? {
                    e.state = "retained".into();
                    retained += 1;
                    e.reason = "已校验并离线保留".into();
                } else {
                    e.state = "retain".into();
                    actionable += 1;
                    e.reason = "本机已校验，待离线保留".into();
                }
            } else if !allowed_explicit(&m.mime, m.size, extras) {
                e.state = "excluded".into();
                e.reason = "未包含音视频/ZIP，或超过当前大小限制".into();
            } else {
                e.state = "download".into();
                actionable += 1;
                e.reason = "待下载、校验并保留".into();
                needed.insert(m.hash.clone(), m.size);
            }
        }
        items.push(e);
    }
    let raw: String = c
        .query_row(
            "SELECT post_json FROM collection_x_items WHERE item_key=?1",
            [key],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let post: Post = serde_json::from_str(&raw).map_err(|_| "阅读正文损坏")?;
    let warnings = if incomplete(&post) {
        vec!["正文、引用或回复仍可能不完整；离线下载不会补采原文".into()]
    } else {
        Vec::new()
    };
    let token = hash(
        &serde_json::to_vec(&(ns, key, &post_hash, &p, extras, &manifests, &items))
            .map_err(|e| e.to_string())?,
    );
    let previous: String = c
        .query_row(
            "SELECT state FROM reading_offline_runs WHERE namespace=?1 AND item_key=?2",
            params![ns, key],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    Ok(Plan {
        token,
        post_hash,
        total: items.len(),
        available,
        retained,
        download_bytes: needed.values().sum(),
        actionable,
        complete: retained == items.len() && warnings.is_empty(),
        warnings,
        items,
        previous: if previous == "running" {
            "interrupted".into()
        } else {
            previous
        },
    })
}
fn finish(db: &PathBuf, ns: &str, key: &str, state: &str, result: &str) -> Result<(), String> {
    let (c, _writer) = open_write_database(db)?;
    c.execute(
        "UPDATE reading_offline_runs SET state=?3,result=?4 WHERE namespace=?1 AND item_key=?2",
        params![ns, key, state, result],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}
// Caller owns the reading lock. A persisted plan precedes downloads; retry is always explicit.
pub(super) async fn execute(
    db: &PathBuf,
    remote: Option<&dyn ReadingStore>,
    ns: &str,
    key: &str,
    extras: bool,
    token: &str,
) -> Result<Outcome, String> {
    let (before, p) = {
        let (c, _writer) = open_write_database(db)?;
        let before = plan(&c, db, ns, key, extras)?;
        if before.token != token {
            return Err("正文、附件或策略已变化，请重新检查离线范围".into());
        }
        let p = policy(&c)?;
        if before.items.iter().any(|e| e.state == "download") {
            cloud_sync::require_reading(&c, false)?;
            if remote.is_none() {
                return Err("离线下载需要有效的云连接".into());
            }
        }
        c.execute("INSERT INTO reading_offline_runs VALUES(?1,?2,?3,'running',?4,'') ON CONFLICT(namespace,item_key) DO UPDATE SET id=excluded.id,state=excluded.state,plan=excluded.plan,result=''",params![ns,key,random_url_safe(12),serde_json::to_string(&before).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
        (before, p)
    };
    let result = async {
        let mut budget = transfer::Budget::new(&p);
        let mut succeeded = 0;
        let mut failures = Vec::new();
        for entry in before
            .items
            .iter()
            .filter(|e| matches!(e.state.as_str(), "download" | "retain"))
        {
            if current(&open_database(db)?, key)?.0 != before.post_hash {
                return Err("正文已变化，已停止；已完成附件保留，请重新检查".to_string());
            }
            let attempt = async {
                if entry.state == "download" {
                    transfer::download_with_budget(
                        db,
                        remote.ok_or("云连接不可用")?,
                        ns,
                        key,
                        &entry.url,
                        &p,
                        true,
                        &mut budget,
                    )
                    .await?;
                }
                let (c, _writer) = open_write_database(db)?;
                if current(&c, key)?.0 != before.post_hash {
                    return Err("正文已变化，未保留旧附件".into());
                }
                cache::pin(&c, db, ns, key, &entry.url)
            }
            .await;
            match attempt {
                Ok(()) => succeeded += 1,
                Err(e) => failures.push(format!("{}：{e}", entry.url)),
            }
        }
        let c = open_database(db)?;
        let after = plan(&c, db, ns, key, extras)?;
        if after.post_hash != before.post_hash {
            return Err("正文已变化，已完成附件保留，请重新检查".into());
        }
        Ok(Outcome {
            succeeded,
            failures,
            plan: after,
        })
    }
    .await;
    match result {
        Ok(mut out) => {
            let state = if out.plan.complete && out.failures.is_empty() {
                "complete"
            } else {
                "partial"
            };
            out.plan.previous = state.into();
            finish(
                db,
                ns,
                key,
                state,
                &serde_json::to_string(&out).map_err(|e| e.to_string())?,
            )?;
            Ok(out)
        }
        Err(e) => {
            finish(db, ns, key, "failed", &e)?;
            Err(e)
        }
    }
}
#[tauri::command]
pub(crate) async fn preview_reading_offline(
    app: AppHandle,
    key: String,
    include_extras: bool,
) -> Result<Plan, String> {
    let _guard = LOCK.lock().await;
    let db = database_path(&app)?;
    let (c, _writer) = open_write_database(&db)?;
    x_bookmarks::storage::schema(&c)?;
    let ns = object_store::namespace(&c).unwrap_or_default();
    plan(&c, &db, &ns, &key, include_extras)
}
#[tauri::command]
pub(crate) async fn download_reading_offline(
    app: AppHandle,
    key: String,
    include_extras: bool,
    token: String,
) -> Result<Outcome, String> {
    let _guard = LOCK.lock().await;
    let db = database_path(&app)?;
    let (ns, remote) = {
        let c = open_database(&db)?;
        let ns = object_store::namespace(&c).unwrap_or_default();
        let before = plan(&c, &db, &ns, &key, include_extras)?;
        if before.token != token {
            return Err("正文、附件或策略已变化，请重新检查离线范围".into());
        }
        let remote = if before.items.iter().any(|e| e.state == "download") {
            Some(object_store::store(&app, &c)?)
        } else {
            None
        };
        (ns, remote)
    };
    execute(&db, remote.as_deref(), &ns, &key, include_extras, &token).await
}
