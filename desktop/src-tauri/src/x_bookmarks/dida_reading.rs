//! Dida's exact “稍后读” tag is a durable import-and-delete inbox.
//! A remote delete is eligible only after independent local content/file readback.
use super::*;
use std::sync::atomic::AtomicUsize;
mod exact_source;
pub(crate) mod resolution;
pub(crate) use exact_source::exact_web_task;
pub(crate) use exact_source::verify_login_identity;
#[cfg(all(windows, feature = "integration-dida-source"))]
pub(crate) mod integration;
pub(crate) mod source_recovery;

const TAG: &str = "稍后读";
static LAUNCHING: AtomicBool = AtomicBool::new(false);
static INFLIGHT: AtomicUsize = AtomicUsize::new(0);
static DECISION_LOCK: Mutex<()> = Mutex::new(());
struct Running;
struct Launch;
impl Drop for Launch {
    fn drop(&mut self) {
        LAUNCHING.store(false, Ordering::Relaxed);
    }
}
tokio::task_local! { static DELETE_CONTROL: (PathBuf, Arc<library_runtime::Operation>); }
pub(crate) async fn write_checkpoint(
    client: &reqwest::Client,
    session: &McpSession,
) -> Result<(), String> {
    if let Ok((path, operation)) = DELETE_CONTROL.try_with(Clone::clone) {
        checkpoint_path(&path, &operation)?;
        source_recovery::writer_check(client, session, &path, &operation).await?;
    }
    Ok(())
}
impl Running {
    fn begin() -> Self {
        let _decision = DECISION_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        INFLIGHT.fetch_add(1, Ordering::Relaxed);
        Self
    }
}
impl Drop for Running {
    fn drop(&mut self) {
        INFLIGHT.fetch_sub(1, Ordering::Relaxed);
    }
}
pub(super) fn running() -> bool {
    LAUNCHING.load(Ordering::Relaxed) || INFLIGHT.load(Ordering::Relaxed) > 0
}

pub(crate) fn schema(c: &Connection) -> Result<(), String> {
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS collection_dida_reading (
        library_id TEXT NOT NULL,task_id TEXT NOT NULL,project_id TEXT NOT NULL,
        account_id TEXT NOT NULL DEFAULT '',
        item_key TEXT NOT NULL UNIQUE,snapshot_hash TEXT NOT NULL,raw_json TEXT NOT NULL,
        post_hash TEXT NOT NULL,local_verified INTEGER NOT NULL DEFAULT 0,
        delete_state TEXT NOT NULL DEFAULT 'pending',error TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL,PRIMARY KEY(library_id,task_id));
        CREATE TABLE IF NOT EXISTS collection_dida_reading_policy(version INTEGER PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS collection_dida_reading_assets (
        item_key TEXT NOT NULL,media_url TEXT NOT NULL,blob_hash TEXT NOT NULL,
        file_name TEXT NOT NULL,mime_type TEXT NOT NULL,size INTEGER NOT NULL,
        snapshot_hash TEXT NOT NULL,
        PRIMARY KEY(item_key,media_url));",
    )
    .map_err(|e| format!("无法初始化滴答稍后读回执：{e}"))?;
    source_recovery::schema(c)?;
    resolution::retire_preserved_warnings(c)
}
fn identity(library: &str, account: &str, task: &str) -> String {
    format!(
        "dida:{}",
        storage::hash(format!("{library}\0{account}\0{task}").as_bytes())
    )
}
fn selected(task: &DidaTask) -> bool {
    task.tags.iter().any(|tag| tag == TAG)
}
fn account_scope(c: &Connection, library: &str) -> Result<String, String> {
    let raw: Option<String> = c
        .query_row(
            "SELECT metadata_json FROM libraries WHERE id=?1",
            [library],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let profile = raw
        .as_deref()
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .unwrap_or_default();
    Ok(
        value_string(&profile["preference"], &["userId", "id", "accountId"])
            .unwrap_or_else(|| format!("library:{library}")),
    )
}
fn account_matches(
    c: &Connection,
    library: &str,
    account: &str,
    identity: &Value,
) -> Result<(), String> {
    // An explicitly known MCP account must also match the authenticated web
    // account. The library fallback is only a stable local binding, not proof
    // of membership in a shared list.
    let configured = account_scope(c, library)?;
    if configured != format!("library:{library}")
        && (account != configured
            || identity.get("userId").and_then(Value::as_str) != Some(configured.as_str()))
    {
        return Err("滴答授权与附件登录账号不一致，来源保留".into());
    }
    let actual = identity
        .get("inboxId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("滴答附件账号身份未知，来源保留")?;
    let key = format!("dida_reading_account:{library}:{account}");
    let previous = metadata_string(c, &key);
    if previous.is_empty() {
        meta(c, &key, &storage::hash(actual.as_bytes()))
    } else if previous == storage::hash(actual.as_bytes()) {
        Ok(())
    } else {
        Err("滴答附件登录账号发生变化，已保留来源与本地副本".into())
    }
}
fn snapshot(task: &DidaTask) -> String {
    storage::hash(task.raw.to_string().as_bytes())
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}
fn owned_copy(c: &Connection, _library: &str, task: &str) -> Result<bool, String> {
    if c.query_row("SELECT EXISTS(SELECT 1 FROM collection_remote_copies WHERE provider='dida365' AND object_id=?1 AND parent_id<>'attachment')",[task],|r|r.get::<_,bool>(0)).map_err(|e|e.to_string())? {return Ok(true);}
    for (table, column, condition) in [
        (
            "unified_task_bindings",
            "source_id",
            "AND provider='dida365'",
        ),
        ("feishu_task_bindings", "dida_task_id", ""),
    ] {
        let exists: bool = c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                [table],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if exists
            && c.query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE {column}=?1 {condition})"),
                [task],
                |r| r.get::<_, bool>(0),
            )
            .map_err(|e| e.to_string())?
        {
            return Ok(true);
        }
    }
    Ok(false)
}
fn can_delete(receipt: &Receipt, task: &DidaTask) -> Result<(), String> {
    if !receipt.verified || receipt.state == "deleted" {
        return Err("本地内容尚未完成核验，滴答来源保留".into());
    }
    if !selected(task) || snapshot(task) != receipt.snapshot {
        return Err("滴答来源或稍后读标签已更改，已保留来源与本地副本".into());
    }
    if [
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
        return Err("滴答子任务清单未知或包含尚未逐项迁移的子任务，已保留来源与本地副本".into());
    }
    Ok(())
}
#[derive(Clone)]
struct Receipt {
    key: String,
    project: String,
    snapshot: String,
    post_hash: String,
    verified: bool,
    state: String,
    account: String,
}
fn receipt(c: &Connection, library: &str, task: &str) -> Result<Option<Receipt>, String> {
    c.query_row("SELECT item_key,project_id,snapshot_hash,post_hash,local_verified,delete_state,account_id FROM collection_dida_reading WHERE library_id=?1 AND task_id=?2",params![library,task],|r|Ok(Receipt{key:r.get(0)?,project:r.get(1)?,snapshot:r.get(2)?,post_hash:r.get(3)?,verified:r.get(4)?,state:r.get(5)?,account:r.get(6)?})).optional().map_err(|e|e.to_string())
}
fn outcome(c: &Connection, key: &str, state: &str, error: &str) -> Result<(), String> {
    c.execute("UPDATE collection_dida_reading SET delete_state=?2,error=?3,updated_at=?4 WHERE item_key=?1",params![key,state,error,now_timestamp()]).map_err(|e|e.to_string())?;
    c.execute("INSERT INTO collection_x_enrichment(item_key,signature,checked_at,error) VALUES(?1,'dida-reading',?2,?3) ON CONFLICT(item_key) DO UPDATE SET signature='dida-reading',checked_at=excluded.checked_at,error=excluded.error",params![key,now_timestamp(),error]).map_err(|e|e.to_string())?;
    Ok(())
}
fn checkpoint(app: &AppHandle, operation: &library_runtime::Operation) -> Result<(), String> {
    checkpoint_path(&database_path(app)?, operation)
}
fn checkpoint_path(path: &PathBuf, operation: &library_runtime::Operation) -> Result<(), String> {
    operation.checkpoint()?;
    let c = open_database(path)?;
    if metadata_string(&c, "collection_auto_pause_until")
        .parse::<i64>()
        .unwrap_or(0)
        > now_timestamp()
    {
        return Err("阅读同步已暂停，本地内容和滴答来源均已保留".into());
    }
    Ok(())
}

// A recognized complete batch is required. Never interpret an absent or partial
// attachment inventory as an empty inventory, including cursor-based responses.
fn complete_batch(batch: &Value) -> Result<(), String> {
    fn paginated(value: &Value) -> bool {
        match value {
            Value::Object(map) => map.iter().any(|(key, value)| {
                let key = key.to_ascii_lowercase();
                (matches!(key.as_str(), "hasmore" | "has_more" | "more")
                    && value.as_bool() == Some(true))
                    || (matches!(
                        key.as_str(),
                        "nextcursor" | "next_cursor" | "nextpage" | "next_page"
                    ) && !value.is_null()
                        && value.as_str() != Some("")
                        && value.as_i64() != Some(0))
                    || paginated(value)
            }),
            Value::Array(values) => values.iter().any(paginated),
            _ => false,
        }
    }
    let bean = batch
        .get("syncTaskBean")
        .ok_or("滴答附件库存格式未知，来源保留")?;
    if !bean.get("add").is_some_and(Value::is_array)
        || !bean.get("update").is_some_and(Value::is_array)
        || paginated(batch)
    {
        return Err("滴答附件库存尚未完整读取，来源保留".into());
    }
    Ok(())
}
async fn web_batch(
    app: &AppHandle,
    operation: &library_runtime::Operation,
    library: &str,
) -> Result<Value, String> {
    let account = account_scope(&open_database(&database_path(app)?)?, library)?;
    exact_source::verified_web_batch(app, operation, library, &account).await
}
fn batch_tasks(batch: &Value) -> Vec<DidaTask> {
    let mut tasks = Vec::new();
    for part in ["add", "update"] {
        collect_dida_tasks(&batch["syncTaskBean"][part], "", &mut tasks);
    }
    tasks
}
fn match_web_task(batch: &Value, task: &DidaTask) -> Result<DidaTask, String> {
    complete_batch(batch)?;
    let mut projects = Vec::new();
    collect_dida_projects(batch, &mut projects);
    // Only the batch's explicit inboxId can resolve MCP's generic alias. A
    // matching task ID/body from the authenticated single-task lookup is also
    // required below; arbitrary inbox<user> values are never accepted.
    let project = if task.project_id == "inbox" {
        batch
            .get("inboxId")
            .and_then(Value::as_str)
            .filter(|s| is_dida_inbox_project_id(s))
            .ok_or("滴答收件箱账号身份未知，来源保留")?
    } else {
        task.project_id.as_str()
    };
    if !projects.iter().any(|p| p.id == project) {
        return Err("当前滴答授权与附件会话的清单范围尚未匹配，来源保留".into());
    }
    let web = batch_tasks(batch)
        .into_iter()
        .find(|v| v.id == task.id && v.project_id == project)
        .ok_or("滴答附件库存未包含当前来源，来源保留")?;
    if !web.raw.get("attachments").is_some_and(Value::is_array) {
        return Err("滴答来源的附件清单未知，来源保留".into());
    }
    if web.title != task.title
        || web.content != task.content
        || web.description != task.description
        || web.kind != task.kind
        || web.status != task.status
        || web.tags != task.tags
        || web.items != task.items
    {
        return Err("滴答任务与附件会话的正文版本不一致，来源保留".into());
    }
    Ok(web)
}
async fn read_task(
    client: &reqwest::Client,
    session: &McpSession,
    task: &str,
    project: &str,
    id: u64,
) -> Result<Option<DidaTask>, String> {
    let result = match call_mcp_tool_raw(
        client,
        session,
        "get_task_by_id",
        json!({"task_id":task}),
        id,
    )
    .await
    {
        Ok(v) => v,
        Err(e) if dida_lookup_error_confirms_missing(&e) => return Ok(None),
        Err(e) => return Err(e),
    };
    let mut tasks = Vec::new();
    collect_dida_tasks(&tool_result_json(&result), project, &mut tasks);
    if let Some(task) = tasks
        .into_iter()
        .find(|v| v.id == task && v.project_id == project)
    {
        return Ok(Some(task));
    }
    if dida_lookup_confirms_missing(None, &tool_result_text(&result)) {
        Ok(None)
    } else {
        Err("滴答未返回可核验的来源详情，来源保留".into())
    }
}
fn refs(task: &DidaTask) -> Result<Vec<DidaAttachmentRef>, String> {
    let metadata = dida_attachment_refs_from_metadata(&task.attachments);
    if metadata.len() != task.attachments.len() {
        return Err("滴答包含尚不能识别的原附件，来源保留".into());
    }
    let mut result = metadata;
    for reference in dida_attachment_refs(&format!("{}\n{}", task.content, task.description)) {
        if !result
            .iter()
            .any(|v| v.attachment_id == reference.attachment_id)
        {
            result.push(reference);
        }
    }
    Ok(result)
}
fn media_url(library: &str, task: &str, attachment: &DidaAttachmentRef) -> String {
    format!(
        "dida:{}/{}/{}/{}",
        storage::hash(library.as_bytes()),
        task,
        attachment.attachment_id,
        attachment.file_name
    )
}
// Reading contains the material itself. Task metadata stays in the original
// receipt and in the task interface, not in the imported article body.
fn reading_body(task: &DidaTask) -> String {
    let mut lines = vec![task.title.clone()];
    if !task.content.trim().is_empty() {
        lines.extend([String::new(), task.content.clone()]);
    }
    if !task.description.trim().is_empty() && task.description.trim() != task.content.trim() {
        lines.extend([String::new(), task.description.clone()]);
    }
    if !task.items.is_empty() {
        lines.extend([String::new(), "## 检查项".into()]);
        for item in &task.items {
            let title = value_string(item, &["title", "name"]).unwrap_or_else(|| "未命名".into());
            let checked = value_i64(item, &["status"]).unwrap_or(0) != 0;
            lines.push(format!("- [{}] {title}", if checked { "x" } else { " " }));
        }
    }
    let mut represented = dida_attachment_refs(&task.content)
        .into_iter()
        .chain(dida_attachment_refs(&task.description))
        .map(|attachment| attachment.attachment_id)
        .collect::<HashSet<_>>();
    for attachment in dida_attachment_refs_from_metadata(&task.attachments)
        .into_iter()
        .rev()
    {
        if !represented.insert(attachment.attachment_id.clone()) {
            continue;
        }
        let label = if attachment.link_kind == "image" {
            "![image]".into()
        } else {
            format!("[{}]", attachment.file_name.replace(['[', ']'], ""))
        };
        lines.extend([
            String::new(),
            format!("{label}({})", attachment.markdown_source),
        ]);
    }
    lines.join("\n")
}
fn reading_tags(tags: &[String]) -> Vec<String> {
    tags.iter()
        .filter(|tag| tag.as_str() != TAG)
        .cloned()
        .collect()
}
pub(super) fn migrate_presentation(c: &Connection) -> Result<(), String> {
    const VERSION: i64 = 1;
    if !c.is_autocommit()
        || c.query_row(
            "SELECT EXISTS(SELECT 1 FROM collection_dida_reading_policy WHERE version=?1)",
            [VERSION],
            |r| r.get::<_, bool>(0),
        )
        .map_err(|e| e.to_string())?
    {
        return Ok(());
    }
    let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
    let rows = {
        let mut query = tx.prepare("SELECT r.item_key,r.project_id,r.raw_json,r.post_hash,i.post_json,p.tags FROM collection_dida_reading r JOIN collection_x_items i ON i.item_key=r.item_key LEFT JOIN collection_x_properties p ON p.item_key=i.item_key").map_err(|e| e.to_string())?;
        let rows = query
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, Option<String>>(5)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows
    };
    for (key, project, raw, expected, current, tags) in rows {
        let Ok(mut post) = serde_json::from_str::<Post>(&current) else {
            continue;
        };
        if post.source != "dida" {
            continue;
        }
        let tags_changed = if let Some(tags) =
            tags.and_then(|tags| serde_json::from_str::<Vec<String>>(&tags).ok())
        {
            let clean = reading_tags(&tags);
            if clean != tags {
                tx.execute(
                    "UPDATE collection_x_properties SET tags=?2 WHERE item_key=?1",
                    params![key, json!(clean).to_string()],
                )
                .map_err(|e| e.to_string())?;
                true
            } else {
                false
            }
        } else {
            false
        };
        let mut body_changed = false;
        // Only rewrite known generated bodies; preserve user-edited material.
        if storage::hash(current.as_bytes()) == expected {
            if let Ok(raw) = serde_json::from_str::<Value>(&raw) {
                let mut tasks = Vec::new();
                collect_dida_tasks(&raw, &project, &mut tasks);
                if let Some(task) = tasks.into_iter().find(|task| task.id == post.id) {
                    let legacy = dida_task_markdown(&task, &task.project_id);
                    if post.text == legacy.strip_prefix("# ").unwrap_or(&legacy) {
                        post.text = reading_body(&task);
                        let updated = serde_json::to_string(&post).map_err(|e| e.to_string())?;
                        let hash = storage::hash(updated.as_bytes());
                        tx.execute("UPDATE collection_x_items SET post_json=?2,content_hash=?3 WHERE item_key=?1",params![key,updated,hash]).map_err(|e| e.to_string())?;
                        tx.execute("UPDATE collection_dida_reading SET post_hash=?2,local_verified=CASE WHEN delete_state='deleted' THEN local_verified ELSE 0 END WHERE item_key=?1",params![key,hash]).map_err(|e| e.to_string())?;
                        body_changed = true;
                    }
                }
            }
        }
        if tags_changed || body_changed {
            tx.execute(
                "UPDATE collection_x_items SET read_version=read_version+1 WHERE item_key=?1",
                [&key],
            )
            .map_err(|e| e.to_string())?;
            tx.execute("INSERT INTO collection_property_updates(item_key,version) SELECT item_key,read_version FROM collection_x_items WHERE item_key=?1 ON CONFLICT(item_key) DO UPDATE SET version=excluded.version",[&key]).map_err(|e| e.to_string())?;
        }
    }
    tx.execute(
        "INSERT INTO collection_dida_reading_policy(version) VALUES(?1)",
        [VERSION],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}
fn post_for(library: &str, name: &str, task: &DidaTask, assets: &[DidaAttachmentRef]) -> Post {
    let media = assets
        .iter()
        .map(|a| Media {
            kind: if a.mime_type.starts_with("image/") {
                "photo"
            } else if a.mime_type.starts_with("video/") {
                "video"
            } else {
                "file"
            }
            .into(),
            url: media_url(library, &task.id, a),
            preview_url: String::new(),
        })
        .collect::<Vec<_>>();
    Post {
        id: task.id.clone(),
        source: "dida".into(),
        text: reading_body(task),
        author_name: name.into(),
        published_at: task.created_time.clone().unwrap_or_default(),
        url: dida_task_url(&task.project_id, &task.id),
        media: media.clone(),
        all_media: media,
        content_status: "full".into(),
        ..Default::default()
    }
}
fn commit_import(
    c: &mut Connection,
    library: &str,
    name: &str,
    account: &str,
    task: &DidaTask,
    assets: &[DidaAttachmentRef],
    operation: &library_runtime::Operation,
) -> Result<Receipt, String> {
    if let Some(old) = receipt(c, library, &task.id)? {
        if old.account != account {
            return Err("滴答来源账号绑定发生变化，已保留来源与原本地副本".into());
        }
        if old.state == "deleted" {
            return Ok(old);
        }
    }
    let key = identity(library, account, &task.id);
    let post =
        serde_json::to_string(&post_for(library, name, task, assets)).map_err(|e| e.to_string())?;
    let hash = storage::hash(post.as_bytes());
    let snapshot = snapshot(task);
    let tx = c.transaction().map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO collection_x_items(item_key,account,post_json,collected_at,captured_at,read_at,read_version,content_hash) VALUES(?1,?2,?3,?4,?4,0,0,?5) ON CONFLICT(item_key) DO UPDATE SET post_json=excluded.post_json,content_hash=excluded.content_hash,captured_at=excluded.captured_at WHERE collection_x_items.post_json<>excluded.post_json",params![key,format!("{library}:{account}"),post,chrono::Utc::now().timestamp_millis(),hash]).map_err(|e|e.to_string())?;
    tx.execute("INSERT INTO collection_x_properties(item_key,status,tags) VALUES(?1,'unread',?2) ON CONFLICT(item_key) DO NOTHING",params![key,json!(reading_tags(&task.tags)).to_string()]).map_err(|e|e.to_string())?;
    tx.execute("INSERT INTO collection_dida_reading(library_id,task_id,project_id,item_key,snapshot_hash,raw_json,post_hash,updated_at,account_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(library_id,task_id) DO UPDATE SET project_id=excluded.project_id,snapshot_hash=excluded.snapshot_hash,raw_json=excluded.raw_json,post_hash=excluded.post_hash,local_verified=CASE WHEN collection_dida_reading.snapshot_hash=excluded.snapshot_hash AND collection_dida_reading.post_hash=excluded.post_hash THEN collection_dida_reading.local_verified ELSE 0 END,delete_state='pending',error='',updated_at=excluded.updated_at WHERE collection_dida_reading.delete_state<>'deleted'",params![library,task.id,task.project_id,key,snapshot,task.raw.to_string(),hash,now_timestamp(),account]).map_err(|e|e.to_string())?;
    operation.commit(|| tx.commit().map_err(|e| e.to_string()))?;
    receipt(c, library, &task.id)?.ok_or("滴答本地导入回执丢失".into())
}
async fn save_assets(
    app: &AppHandle,
    state: &State<'_, AppState>,
    library: &str,
    task: &DidaTask,
    verified_cookie: &str,
    assets: &[DidaAttachmentRef],
    key: &str,
    operation: &library_runtime::Operation,
) -> Result<(), String> {
    let blob_store = blob_store_for(app, state)?;
    let client = attachment_http_client()?;
    for asset in assets {
        checkpoint(app, operation)?;
        let url = media_url(library, &task.id, asset);
        let source = format!(
            "{}/{}",
            asset.attachment_id,
            dida_attachment_file_name(&asset.file_name)
        );
        let (downloaded, _) = load_preview_attachment(
            &database_path(app)?,
            &blob_store,
            PROVIDER_DIDA365,
            library,
            &task.id,
            &source,
            &client,
            || Ok(Some(verified_cookie.to_string())),
            true,
        )
        .await?;
        if downloaded.blob.size == 0
            || (matches!(
                downloaded.mime_type.as_str(),
                "text/html" | "application/json"
            ) && downloaded.mime_type != asset.mime_type)
        {
            return Err("滴答附件接口没有返回可核验的原件，来源保留".into());
        }
        record_asset(
            &database_path(app)?,
            &blob_store,
            task,
            asset,
            key,
            &url,
            &downloaded,
            operation,
        )?;
    }
    Ok(())
}
fn record_asset(
    database: &PathBuf,
    blob_store: &BlobStore,
    task: &DidaTask,
    asset: &DidaAttachmentRef,
    key: &str,
    url: &str,
    downloaded: &DownloadedSource,
    operation: &library_runtime::Operation,
) -> Result<(), String> {
    let path = blob_store.path_for(&downloaded.blob.hash)?;
    let (mut c, _writer) = open_write_database(database)?;
    let path = crate::data_backup::retain_media(&c, &path)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO blobs(hash,size,mime_type,relative_path,created_at,verified_at) VALUES(?1,?2,?3,?4,?5,?5) ON CONFLICT(hash) DO UPDATE SET verified_at=excluded.verified_at",params![downloaded.blob.hash,downloaded.blob.size,downloaded.mime_type,downloaded.blob.relative_path,now_timestamp()]).map_err(|e|e.to_string())?;
    tx.execute("INSERT INTO collection_dida_reading_assets(item_key,media_url,blob_hash,file_name,mime_type,size,snapshot_hash) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(item_key,media_url) DO UPDATE SET blob_hash=excluded.blob_hash,file_name=excluded.file_name,mime_type=excluded.mime_type,size=excluded.size,snapshot_hash=excluded.snapshot_hash",params![key,url,downloaded.blob.hash,asset.file_name,downloaded.mime_type,downloaded.blob.size,snapshot(task)]).map_err(|e|e.to_string())?;
    tx.execute("INSERT INTO collection_saved_media(item_key,media_url,path) VALUES(?1,?2,?3) ON CONFLICT(item_key,media_url) DO UPDATE SET path=excluded.path",params![key,url,path.to_string_lossy()]).map_err(|e|e.to_string())?;
    operation.commit(|| tx.commit().map_err(|e| e.to_string()))?;
    Ok(())
}
fn file_hash(path: &Path) -> Result<String, String> {
    use std::io::Read;
    let mut file = fs::File::open(path).map_err(|_| "本地原件不可读取")?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buffer).map_err(|_| "本地原件读回失败")?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn verify_local(
    c: &Connection,
    record: &Receipt,
    cfg: &storage::StorageConfig,
) -> Result<(), String> {
    let (post, content, version): (String, String, i64) = c
        .query_row(
            "SELECT post_json,content_hash,read_version FROM collection_x_items WHERE item_key=?1",
            [&record.key],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|_| "本地阅读正文读回失败")?;
    if storage::hash(post.as_bytes()) != record.post_hash || content != record.post_hash {
        return Err("本地阅读正文尚未完整核验".into());
    }
    let raw: String = c
        .query_row(
            "SELECT raw_json FROM collection_dida_reading WHERE item_key=?1",
            [&record.key],
            |r| r.get(0),
        )
        .map_err(|_| "滴答原文回执读回失败")?;
    if storage::hash(raw.as_bytes()) != record.snapshot {
        return Err("滴答原文回执尚未完整核验".into());
    }
    let post: Post = serde_json::from_str(&post).map_err(|_| "本地阅读正文格式无效")?;
    let vault = if cfg.mode == "obsidian" {
        Some(
            fs::canonicalize(cfg.vault_path.trim())
                .map_err(|_| "默认 Obsidian 库不可访问，滴答来源保留")?,
        )
    } else {
        None
    };
    for asset in threads::assets(&post) {
        let (path,hash,size):(String,String,u64)=c.query_row("SELECT m.path,a.blob_hash,a.size FROM collection_saved_media m JOIN collection_dida_reading_assets a ON a.item_key=m.item_key AND a.media_url=m.media_url WHERE m.item_key=?1 AND m.media_url=?2 AND a.snapshot_hash=?3",params![record.key,asset.url,record.snapshot],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|_|"本地原附件尚未保存，滴答来源保留")?;
        if !fs::metadata(&path).is_ok_and(|m| m.is_file() && m.len() == size && size > 0)
            || file_hash(Path::new(&path))? != hash
        {
            return Err("本地原附件读回核验失败，滴答来源保留".into());
        }
        if let Some(root) = &vault {
            let path =
                fs::canonicalize(path).map_err(|_| "默认 Obsidian 原附件不可访问，滴答来源保留")?;
            if !path.starts_with(root) {
                return Err("默认 Obsidian 原附件尚未保存到当前库，滴答来源保留".into());
            }
        }
    }
    if cfg.mode == "obsidian" {
        let root = fs::canonicalize(cfg.vault_path.trim())
            .map_err(|_| "默认 Obsidian 库不可访问，滴答来源保留")?;
        let cfg_hash=json!({"mode":cfg.mode,"vaultPath":cfg.vault_path,"downloadMedia":cfg.download_media,"noteFormat":4}).to_string();
        let row_input = storage::hash(format!("{content}:{version}:{cfg_hash}").as_bytes());
        let expected_input = storage::hash(
            format!(
                "{row_input}:{}",
                serde_json::to_string(cfg).map_err(|e| e.to_string())?
            )
            .as_bytes(),
        );
        let mut q=c.prepare("SELECT r.root,e.relative_path,e.file_hash,e.media_pending,e.input_hash FROM collection_obsidian_exports e JOIN collection_roots r ON r.destination=e.destination WHERE e.item_key=?1").map_err(|e|e.to_string())?;
        let rows = q
            .query_map([&record.key], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut verified = false;
        for row in rows {
            let (export_root, relative, hash, pending, input) = row.map_err(|e| e.to_string())?;
            if fs::canonicalize(export_root).ok().as_deref() != Some(root.as_path())
                || pending != 0
                || input != expected_input
            {
                continue;
            }
            let path = fs::canonicalize(root.join(relative))
                .map_err(|_| "默认 Obsidian 页面尚未保存，滴答来源保留")?;
            if path.starts_with(&root) && file_hash(&path)? == hash {
                verified = true;
                break;
            }
        }
        if !verified {
            return Err("默认 Obsidian 正文未完成读回核验，滴答来源保留".into());
        }
    }
    Ok(())
}
pub(super) fn local_asset(c: &Connection, url: &str) -> Result<(String, String), String> {
    c.query_row("SELECT a.file_name,a.blob_hash FROM collection_dida_reading_assets a JOIN collection_dida_reading r ON r.item_key=a.item_key AND r.snapshot_hash=a.snapshot_hash WHERE a.media_url=?1 ORDER BY a.item_key LIMIT 1",[url],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|_|"滴答原附件尚未下载，来源保留".into())
}

async fn process(
    app: &AppHandle,
    state: &State<'_, AppState>,
    library: &str,
    name: &str,
    session: &McpSession,
    task_id: &str,
    project: &str,
    operation: &Arc<library_runtime::Operation>,
) -> Result<bool, String> {
    checkpoint(app, operation)?;
    let path = database_path(app)?;
    let old = {
        let c = open_database(&path)?;
        if owned_copy(&c, library, task_id)? {
            return Ok(false);
        }
        receipt(&c, library, task_id)?
    };
    if old
        .as_ref()
        .is_some_and(|r| r.state == "deleted" || r.state == "preserved")
    {
        return Ok(false);
    }
    let client = reqwest::Client::new();
    let task = read_task(&client, session, task_id, project, 74001).await?;
    let Some(task) = task else {
        if let Some(old) = old.filter(|r| r.verified) {
            let c = open_database(&path)?;
            let mut cfg = storage::config(&c)?;
            cfg.download_media = true;
            verify_local(&c, &old, &cfg)?;
            drop(c);
            let (c, _writer) = open_write_database(&path)?;
            operation.commit(|| outcome(&c, &old.key, "deleted", ""))?;
        }
        return Ok(false);
    };
    if !selected(&task) {
        return Err("滴答稍后读标签已移除，来源与本地副本保留".into());
    }
    if !valid_id(&task.id) || !valid_id(&task.project_id) {
        return Err("滴答来源身份无法安全核验".into());
    }
    let account = account_scope(&open_database(&path)?, library)?;
    if old.is_none() {
        // Save the readable MCP body even when the web attachment session is
        // unavailable. This preliminary receipt never authorizes deletion.
        let known = refs(&task).unwrap_or_default();
        let partial = {
            let (mut c, _writer) = open_write_database(&path)?;
            commit_import(&mut c, library, name, &account, &task, &known, operation)?
        };
        let mut cfg = storage::config(&open_database(&path)?)?;
        cfg.download_media = false;
        storage::export_one(app, &partial.key, cfg).await?;
    }
    let (task, identity, verified_cookie) =
        exact_web_task(app, operation, &task, library, &account).await?;
    {
        let (c, _writer) = open_write_database(&path)?;
        operation.commit(|| account_matches(&c, library, &account, &identity))?;
    }
    let assets = refs(&task)?;
    // Publish the authoritative attachment descriptors through the same producer
    // as normal library sync. Task receipt freshness remains a deletion prerequisite.
    operation.commit(|| persist_direct_dida_task(&path, library, &task))?;
    let record = {
        let (mut c, _writer) = open_write_database(&path)?;
        commit_import(&mut c, library, name, &account, &task, &assets, operation)?
    };
    save_assets(
        app,
        state,
        library,
        &task,
        &verified_cookie,
        &assets,
        &record.key,
        operation,
    )
    .await?;
    checkpoint(app, operation)?;
    let mut cfg = storage::config(&open_database(&path)?)?;
    // “稍后读” is an import of originals, even if ordinary previews skip downloads.
    cfg.download_media = true;
    storage::export_one(app, &record.key, cfg.clone()).await?;
    checkpoint(app, operation)?;
    {
        let c = open_database(&path)?;
        verify_local(&c, &record, &cfg)?;
        drop(c);
        let (c, _writer) = open_write_database(&path)?;
        operation.commit(||c.execute("UPDATE collection_dida_reading SET local_verified=1,delete_state='verified',error='' WHERE item_key=?1 AND snapshot_hash=?2 AND post_hash=?3",params![record.key,record.snapshot,record.post_hash]).map(|_|()).map_err(|e|e.to_string()))?;
    }
    let record = receipt(&open_database(&path)?, library, task_id)?.ok_or("滴答迁移回执丢失")?;
    let fresh = read_task(&client, session, task_id, &record.project, 74002).await?;
    if let Some(fresh) = fresh {
        let (fresh, identity, _) =
            exact_web_task(app, operation, &fresh, library, &account).await?;
        {
            let (c, _writer) = open_write_database(&path)?;
            operation.commit(|| account_matches(&c, library, &account, &identity))?;
        }
        can_delete(&record, &fresh)?;
        // Keep the cloud generation stable through the actual authenticated writer.
        let _reading_guard = crate::reading_sync::LOCK.lock().await;
        let permit = source_recovery::authorize(app, &path, &record.key).await?;
        // Re-read the locally committed originals after the final network read.
        verify_local(&open_database(&path)?, &record, &cfg)?;
        checkpoint(app, operation)?;
        {
            let (c, _writer) = open_write_database(&path)?;
            if owned_copy(&c, library, task_id)? {
                return Err("此项已成为 Hub 管理的滴答副本，来源保留".into());
            }
            operation.commit(|| outcome(&c, &record.key, "deleting", ""))?;
        }
        checkpoint(app, operation)?;
        // The shared authenticated writer checks the same library control barrier.
        let result = source_recovery::with_permit(
            app,
            library,
            permit,
            DELETE_CONTROL.scope(
                (path.clone(), operation.clone()),
                call_dida_write_tool_raw(
                    &client,
                    session,
                    "delete_task",
                    json!({"project_id":record.project,"task_id":task_id}),
                    74003,
                ),
            ),
        )
        .await;
        if let Err(error) = result {
            if !dida_lookup_error_confirms_missing(&error) {
                return Err(format!("本地已保存，滴答来源删除待重试：{error}"));
            }
        }
        // A successful write acknowledgement is not a deletion readback.
        checkpoint(app, operation)?;
        if read_task(&client, session, task_id, &record.project, 74004)
            .await?
            .is_some()
        {
            return Err("本地已保存，滴答来源删除尚未确认，稍后重试".into());
        }
    }
    let (c, _writer) = open_write_database(&path)?;
    operation.commit(|| outcome(&c, &record.key, "deleted", ""))?;
    Ok(true)
}

#[derive(Default)]
struct SyncRun {
    attempted: usize,
    completed: usize,
    deferred: usize,
    blocked: usize,
    authentication_error: Option<String>,
}
impl SyncRun {
    fn attempt(&mut self) -> bool {
        if self.authentication_error.is_some() {
            // Authentication is shared by this run. Keep remaining receipts
            // unchanged rather than repeating the same rejected GET per item.
            self.blocked += 1;
            false
        } else {
            self.attempted += 1;
            true
        }
    }
    fn defer(&mut self, error: &str) {
        self.deferred += 1;
        if exact_source::authentication_required(error) {
            self.authentication_error = Some(exact_source::display_error(error));
        }
    }
    fn record(&self, c: &Connection, checked_at: i64) -> Result<(), String> {
        let retained = self.deferred + self.blocked;
        let message = if let Some(error) = &self.authentication_error {
            format!(
                "滴答稍后读：本次已清理 {} 条滴答原内容；{retained} 条仍保留在滴答。{error}",
                self.completed
            )
        } else if retained > 0 {
            format!(
                "滴答稍后读：本次已清理 {} 条滴答原内容；{retained} 条仍保留在滴答，可在同步详情查看原因",
                self.completed
            )
        } else {
            format!("滴答稍后读：本次已清理 {} 条滴答原内容", self.completed)
        };
        meta(c, "dida_reading_status", &message)?;
        meta(c, "dida_reading_last_checked", &checked_at.to_string())?;
        meta(
            c,
            "dida_reading_last_run",
            &json!({
                "attempted":self.attempted,"completed":self.completed,
                "deferred":self.deferred,"blocked":self.blocked,
                "authenticationRequired":self.authentication_error.is_some()
            })
            .to_string(),
        )?;
        if retained == 0 {
            meta(c, "dida_reading_last_success", &checked_at.to_string())?;
            // Older versions wrote last_success even when every item failed.
            // A separate key makes successful completion independently known.
            meta(c, "dida_reading_last_completed", &checked_at.to_string())?;
        }
        Ok(())
    }
}

// Categories describe the reason recorded for this source version. They are
// display information only; neither a category nor a count grants deletion.
fn retained_reason_kind(error: &str) -> &'static str {
    if exact_source::authentication_required(error) {
        "authentication"
    } else if error.contains("额度不足") {
        "quota-exhausted"
    } else if error.contains("版本不一致") || error.contains("来源版本不同") {
        "source-changed"
    } else if error.contains("来源清理未开启") || error.contains("来源清理已关闭") {
        "cleanup-disabled"
    } else if error.contains("附件清单未知")
        || error.contains("附件库存未知")
        || error.contains("没有返回附件列表")
        || error.contains("没有返回这条内容的附件列表")
        || error.contains("附件列表格式异常")
        || error.contains("附件列表尚未完整读取")
    {
        "attachment-list-unavailable"
    } else if error.contains("云端") || error.contains("云同步") || error.contains("恢复凭证")
    {
        "cloud-verification"
    } else if error.contains("附件") || error.contains("原件") {
        "attachment-incomplete"
    } else {
        "other"
    }
}

fn cleanup_summary(c: &Connection) -> Result<Value, String> {
    let mut query = c.prepare(
        "SELECT delete_state,local_verified,error,count(*) FROM collection_dida_reading GROUP BY delete_state,local_verified,error"
    ).map_err(|e| e.to_string())?;
    let rows = query
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, bool>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, usize>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let (mut pending, mut verified, mut deleted) = (0usize, 0usize, 0usize);
    let mut preserved = 0usize;
    let mut reasons = BTreeMap::<String, usize>::new();
    let mut auth_required = false;
    for row in rows {
        let (state, local_verified, error, count) = row.map_err(|e| e.to_string())?;
        if state == "preserved" {
            preserved += count;
            continue;
        }
        if state == "deleted" {
            deleted += count;
            continue;
        }
        pending += count;
        if local_verified {
            verified += count;
        }
        if !error.is_empty() {
            auth_required |= exact_source::authentication_required(&error);
            *reasons
                .entry(exact_source::display_error(&error))
                .or_default() += count;
        }
    }
    let cloud_reading = crate::cloud_sync::policy(c).reading;
    let cleanup_enabled = metadata_bool(c, "reading_source_cleanup", false);
    let mode = if !cloud_reading {
        "local"
    } else if cleanup_enabled {
        "cloud-verified"
    } else {
        "cloud-preserve"
    };
    Ok(json!({
        "mode":mode,"pending":pending,"verified":verified,"deleted":deleted,"preserved":preserved,
        "cloudReading":cloud_reading,"cleanupEnabled":cleanup_enabled,
        "authRequired":auth_required,
        "reasons":reasons.into_iter().map(|(message,count)|json!({"kind":retained_reason_kind(&message),"message":message,"count":count})).collect::<Vec<_>>(),
        "lastRun":serde_json::from_str::<Value>(&metadata_string(c,"dida_reading_last_run")).unwrap_or(Value::Null)
    }))
}

fn last_checked_at(c: &Connection) -> Result<i64, String> {
    let recorded = metadata_string(c, "dida_reading_last_checked")
        .parse::<i64>()
        .unwrap_or(0);
    if recorded > 0 {
        return Ok(recorded);
    }
    // Legacy last_success also included deferred runs. Receipt time is useful
    // as a check time, but cannot establish successful migration completion.
    c.query_row(
        "SELECT COALESCE(max(updated_at),0) FROM collection_dida_reading",
        [],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

pub(crate) async fn sync_library(
    app: &AppHandle,
    library: &str,
    state: &State<'_, AppState>,
    session: &McpSession,
    tasks: &[DidaTask],
    operation: &Arc<library_runtime::Operation>,
) -> Result<(), String> {
    if checkpoint(app, operation).is_err() {
        return Ok(());
    }
    let _running = Running::begin();
    let path = database_path(app)?;
    let (name, mut candidates) = {
        let (c, _writer) = open_write_database(&path)?;
        storage::schema(&c)?;
        let name = c
            .query_row("SELECT name FROM libraries WHERE id=?1", [library], |r| {
                r.get::<_, String>(0)
            })
            .map_err(|e| e.to_string())?;
        let mut candidates = tasks
            .iter()
            .filter(|t| selected(t))
            .map(|t| (t.id.clone(), t.project_id.clone()))
            .collect::<BTreeMap<_, _>>();
        let mut q=c.prepare("SELECT task_id,project_id FROM collection_dida_reading WHERE library_id=?1 AND delete_state<>'deleted'").map_err(|e|e.to_string())?;
        for row in q
            .query_map([library], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?
        {
            let (id, project) = row.map_err(|e| e.to_string())?;
            candidates.entry(id).or_insert(project);
        }
        (name, candidates)
    };
    // A complete web snapshot also finds tagged notes/completed entries absent
    // from the MCP's undone-project listing; every identity is still read via MCP.
    if let Ok(batch) = web_batch(app, operation, library).await {
        let c = open_database(&path)?;
        let mut q = c
            .prepare("SELECT project_id FROM dida_projects WHERE library_id=?1")
            .map_err(|e| e.to_string())?;
        let projects = q
            .query_map([library], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<HashSet<_>, _>>()
            .map_err(|e| e.to_string())?;
        for task in batch_tasks(&batch).into_iter().filter(selected) {
            let inbox = batch.get("inboxId").and_then(Value::as_str);
            if projects.contains(task.project_id.as_str()) {
                candidates.entry(task.id).or_insert(task.project_id);
            } else if projects.contains("inbox") && inbox == Some(task.project_id.as_str()) {
                candidates.entry(task.id).or_insert_with(|| "inbox".into());
            }
        }
    }
    let mut run = SyncRun::default();
    for (task, project) in candidates {
        checkpoint(app, operation)?;
        {
            let c = open_database(&path)?;
            if receipt(&c, library, &task)?.is_some_and(|r| r.state == "preserved") {
                continue;
            }
        }
        if !run.attempt() {
            continue;
        }
        operation.phase("reading_inbox", "导入滴答稍后读并核验本地原件")?;
        match process(
            app, state, library, &name, session, &task, &project, operation,
        )
        .await
        {
            Ok(true) => run.completed += 1,
            Ok(false) => {}
            Err(error) => {
                if library_runtime::is_control_error(&error) {
                    return Err(error);
                }
                run.defer(&error);
                let (c, _writer) = open_write_database(&path)?;
                if let Some(record) = receipt(&c, library, &task)? {
                    operation.commit(|| outcome(&c, &record.key, "pending", &error))?;
                }
                meta(&c, "dida_reading_status", &error)?;
            }
        }
    }
    let (c, _writer) = open_write_database(&path)?;
    operation.commit(|| run.record(&c, now_timestamp()))?;
    Ok(())
}
pub(super) fn source_state(app: &AppHandle, c: &Connection, count: i64) -> Result<Value, String> {
    let sessions = app.state::<AppState>();
    let sessions = sessions.sessions.lock().map_err(|_| "滴答授权会话不可用")?;
    let mut q = c
        .prepare("SELECT id FROM libraries WHERE provider='dida365' AND enabled=1")
        .map_err(|e| e.to_string())?;
    let connected = q
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .any(|id| sessions.contains_key(&id));
    Ok(
        json!({"id":"dida","count":count,"connected":connected,"canResume":false,"running":running(),"status":metadata_string(c,"dida_reading_status"),"lastSuccess":metadata_string(c,"dida_reading_last_completed").parse::<i64>().unwrap_or(0),"lastCheckedAt":last_checked_at(c)?,"didaCleanup":cleanup_summary(c)?,"nextSyncAt":null,"autoBlocked":false}),
    )
}
pub(super) fn launch_if_connected(app: AppHandle) -> Result<bool, String> {
    let ids = {
        let c = open_database(&database_path(&app)?)?;
        let state = app.state::<AppState>();
        let sessions = state.sessions.lock().map_err(|_| "滴答授权会话不可用")?;
        let mut q = c
            .prepare("SELECT id FROM libraries WHERE provider='dida365' AND enabled=1")
            .map_err(|e| e.to_string())?;
        let ids = q
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        ids.into_iter()
            .filter(|id| sessions.contains_key(id))
            .collect::<Vec<_>>()
    };
    if ids.is_empty() {
        return Ok(false);
    }
    {
        let (c, _writer) = open_write_database(&database_path(&app)?)?;
        meta(&c, "collection_auto_pause_until", "0")?;
    }
    if LAUNCHING.swap(true, Ordering::Relaxed) {
        return Ok(true);
    }
    let launch = Launch;
    tauri::async_runtime::spawn(async move {
        let _launch = launch;
        let results = stream::iter(ids)
            .map(|id| {
                let app = app.clone();
                async move {
                    let state = app.state::<AppState>();
                    controlled_library_sync(app.clone(), id, state, false).await
                }
            })
            .buffer_unordered(4)
            .collect::<Vec<_>>()
            .await;
        if let Some(error) = results.into_iter().find_map(Result::err) {
            if let Ok(path) = database_path(&app) {
                if let Ok((c, _writer)) = open_write_database(&path) {
                    let _ = meta(&c, "dida_reading_status", &error);
                }
            }
        }
    });
    Ok(true)
}

#[cfg(test)]
mod tests;
