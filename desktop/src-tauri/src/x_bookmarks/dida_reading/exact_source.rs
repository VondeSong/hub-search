//! The authenticated web API supplements the official MCP task read with the
//! original attachment/child inventory. These are private web endpoints, not
//! the official MCP or Open API. Keep the returned TaskModel unchanged; never
//! turn a wrapper or recursively deduplicated list into completeness evidence.
use super::*;

const API: &str = "https://api.dida365.com";
const RESPONSE_LIMIT: usize = 2 * 1024 * 1024;
// The fixed discovery endpoint returns the account inventory rather than one
// task. Bound it separately so ordinary accounts are not capped at task size.
const BATCH_RESPONSE_LIMIT: usize = 32 * 1024 * 1024;
const STATUS_PATH: &str = "/api/v2/user/status";
const BATCH_PATH: &str = "/api/v3/batch/check/0";

enum WebReadError {
    Authentication(reqwest::StatusCode),
    Other(String),
}

impl WebReadError {
    fn message(self) -> String {
        match self {
            Self::Authentication(status) => http_error(status),
            Self::Other(message) => message,
        }
    }
}

impl From<&str> for WebReadError {
    fn from(message: &str) -> Self {
        Self::Other(message.to_string())
    }
}

impl From<String> for WebReadError {
    fn from(message: String) -> Self {
        Self::Other(message)
    }
}

#[derive(Default)]
struct AccountBinding {
    user: Option<String>,
    inbox_hash: String,
}

impl AccountBinding {
    fn read(c: &Connection, library: &str, account: &str) -> Result<Self, String> {
        let configured = account_scope(c, library)?;
        let user = (configured != format!("library:{library}")).then_some(configured);
        if user.as_deref().is_some_and(|user| user != account) {
            return Err("滴答授权与附件登录账号不一致，来源保留".into());
        }
        let inbox_hash = c
            .query_row(
                "SELECT value FROM metadata WHERE key=?1",
                [format!("dida_reading_account:{library}:{account}")],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| "滴答账号绑定暂不可核验，来源保留")?
            .unwrap_or_default();
        Ok(Self { user, inbox_hash })
    }

    fn verify(&self, status: &Value) -> Result<(String, String), String> {
        let (user, inbox) = status_identity(status)?;
        if self.user.as_deref().is_some_and(|bound| bound != user) {
            return Err("滴答授权与附件登录账号不一致，来源保留".into());
        }
        if !self.inbox_hash.is_empty() && self.inbox_hash != storage::hash(inbox.as_bytes()) {
            return Err("滴答附件登录账号发生变化，已保留来源与本地副本".into());
        }
        Ok((user.to_string(), inbox.to_string()))
    }
}

// The login check is read-only: reuse the same account and inbox guards as the
// exact source read without creating an initial binding or touching receipts.
pub(crate) fn verify_login_identity(
    c: &Connection,
    library: &str,
    status: &Value,
) -> Result<bool, String> {
    let configured = account_scope(c, library)?;
    let binding = AccountBinding::read(c, library, &configured)?;
    binding.verify(status)?;
    Ok(binding.user.is_some() || !binding.inbox_hash.is_empty())
}

fn http_error(status: reqwest::StatusCode) -> String {
    match status {
        reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN => format!(
            "滴答网页登录未通过（{}），请重新登录；原项已保留",
            status.as_u16()
        ),
        _ => format!("滴答精确来源读取失败（HTTP {}），来源保留", status.as_u16()),
    }
}

pub(super) fn authentication_required(error: &str) -> bool {
    [
        "滴答网页登录未通过（401）",
        "滴答网页登录未通过（403）",
        "滴答精确来源读取失败（HTTP 401）",
        "滴答精确来源读取失败（HTTP 403）",
    ]
    .iter()
    .any(|prefix| error.contains(prefix))
}

pub(super) fn display_error(error: &str) -> String {
    for status in [
        reqwest::StatusCode::UNAUTHORIZED,
        reqwest::StatusCode::FORBIDDEN,
    ] {
        if error.starts_with(&format!("滴答精确来源读取失败（HTTP {}）", status.as_u16()))
        {
            return http_error(status);
        }
    }
    error.to_string()
}

fn status_identity(status: &Value) -> Result<(&str, &str), String> {
    let user = status
        .get("userId")
        .and_then(Value::as_str)
        .filter(|id| valid_id(id))
        .ok_or("滴答登录账号身份未知，来源保留")?;
    let inbox = status
        .get("inboxId")
        .and_then(Value::as_str)
        .filter(|id| valid_id(id) && is_dida_inbox_project_id(id) && *id != "inbox")
        .ok_or("滴答收件箱账号身份未知，来源保留")?;
    Ok((user, inbox))
}

fn task_path(mcp: &DidaTask, status: &Value) -> Result<String, String> {
    let (_, inbox) = status_identity(status)?;
    let project = if mcp.project_id == "inbox" {
        inbox
    } else {
        mcp.project_id.as_str()
    };
    if !valid_id(&mcp.id) || !valid_id(project) {
        return Err("滴答来源身份无法安全核验".into());
    }
    Ok(format!(
        "/api/v2/task/{}?projectId={project}&withChildren=true",
        mcp.id
    ))
}

fn paginated(value: &Value) -> bool {
    match value {
        Value::Object(map) => map.iter().any(|(key, value)| {
            let key = key.to_ascii_lowercase();
            (matches!(key.as_str(), "hasmore" | "has_more" | "more")
                && value.as_bool() != Some(false))
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

fn nested_task(value: &Value) -> bool {
    match value {
        Value::Object(map) => {
            (map.contains_key("id") && map.contains_key("projectId") && map.contains_key("title"))
                || map.values().any(nested_task)
        }
        Value::Array(values) => values.iter().any(nested_task),
        _ => false,
    }
}

// Validate the exact task even when that endpoint omits the attachment field.
// An attachment supplement must never hide a changed task, unknown children,
// or an account/project mismatch in the initial response.
fn validate_task_fields(raw: &Value, mcp: &DidaTask, status: &Value) -> Result<(), String> {
    let (_, inbox) = status_identity(status)?;
    let project = if mcp.project_id == "inbox" {
        inbox
    } else {
        mcp.project_id.as_str()
    };
    let object = raw.as_object().ok_or("滴答单任务格式未知，来源保留")?;
    if raw.get("id").and_then(Value::as_str) != Some(mcp.id.as_str())
        || raw.get("projectId").and_then(Value::as_str) != Some(project)
        || !valid_id(&mcp.id)
        || !valid_id(project)
        || ["tasks", "task", "data", "result"]
            .iter()
            .any(|key| object.contains_key(*key))
        || object.values().any(nested_task)
        || paginated(&raw)
    {
        return Err("滴答单任务身份或完整性未知，来源保留".into());
    }
    // The installed web client treats missing children/childIds from this
    // exact GET as no children. Explicit null or another unknown shape is not
    // an empty inventory. Do not synthesize fields in the raw source snapshot.
    for key in [
        "children",
        "childIds",
        "child_ids",
        "childTasks",
        "child_tasks",
    ] {
        if raw
            .get(key)
            .is_some_and(|value| !value.as_array().is_some_and(Vec::is_empty))
        {
            return Err("滴答子任务清单未知或尚未逐项迁移，来源保留".into());
        }
    }
    let etag = raw
        .get("etag")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or("滴答来源版本未知，来源保留")?;
    if mcp.raw.get("etag").and_then(Value::as_str) != Some(etag) {
        return Err("滴答任务与附件会话的版本不一致，来源保留".into());
    }
    let tags = match raw.get("tags") {
        None => Vec::new(),
        Some(Value::Array(tags)) if tags.iter().all(Value::is_string) => tags
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        _ => return Err("滴答任务标签格式未知，来源保留".into()),
    };
    let items = raw
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .ok_or("滴答任务条目清单未知，来源保留")?;
    let title = value_string(&raw, &["title"]).ok_or("滴答任务标题未知，来源保留")?;
    let kind = value_string(&raw, &["kind"]).ok_or("滴答任务类型未知，来源保留")?;
    let status_value = value_i64(&raw, &["status"]).ok_or("滴答任务状态未知，来源保留")?;
    let content = value_string(&raw, &["content"]).unwrap_or_default();
    let description = value_string(&raw, &["desc", "description"]).unwrap_or_default();
    if title != mcp.title
        || content != mcp.content
        || description != mcp.description
        || kind != mcp.kind
        || status_value != mcp.status
        || tags != mcp.tags
        || items != mcp.items
    {
        return Err("滴答任务与附件会话的正文版本不一致，来源保留".into());
    }
    Ok(())
}

fn match_task(raw: Value, mcp: &DidaTask, status: &Value) -> Result<DidaTask, String> {
    validate_task_fields(&raw, mcp, status)?;
    let attachments = match raw.get("attachments") {
        Some(Value::Array(attachments)) => attachments.clone(),
        None => return Err("滴答没有返回附件列表，暂时保留原内容".into()),
        _ => return Err("滴答返回的附件列表格式异常，暂时保留原内容".into()),
    };
    let (_, inbox) = status_identity(status)?;
    let project = if mcp.project_id == "inbox" {
        inbox
    } else {
        mcp.project_id.as_str()
    };
    // Parse only this top-level web TaskModel. The general MCP collector
    // recursively traverses containers and deduplicates IDs, unsuitable here.
    Ok(DidaTask {
        id: mcp.id.clone(),
        project_id: project.to_string(),
        title: mcp.title.clone(),
        content: mcp.content.clone(),
        description: mcp.description.clone(),
        kind: mcp.kind.clone(),
        status: mcp.status,
        priority: value_i64(&raw, &["priority"]).unwrap_or(0),
        start_date: value_string(&raw, &["startDate", "start_date"]),
        due_date: value_string(&raw, &["dueDate", "due_date"]),
        created_time: value_string(
            &raw,
            &["createdTime", "created_time", "createdAt", "created_at"],
        ),
        modified_time: value_string(
            &raw,
            &["modifiedTime", "modified_time", "updatedAt", "updated_at"],
        ),
        completed_time: value_string(&raw, &["completedTime", "completed_time"]),
        time_zone: value_string(&raw, &["timeZone", "time_zone"]),
        column_id: value_string(&raw, &["columnId", "column_id"]),
        column_name: value_string(&raw, &["columnName", "column_name"]),
        parent_id: value_string(&raw, &["parentId", "parent_id"]),
        tags: mcp.tags.clone(),
        items: mcp.items.clone(),
        attachments,
        raw,
    })
}

async fn get_json(
    app: &AppHandle,
    operation: &library_runtime::Operation,
    client: &reqwest::Client,
    cookie: String,
    path: String,
) -> Result<Value, WebReadError> {
    checkpoint(app, operation)?;
    let response_limit = if path == BATCH_PATH {
        BATCH_RESPONSE_LIMIT
    } else {
        RESPONSE_LIMIT
    };
    let mut response = client
        .get(format!("{API}{path}"))
        .header(reqwest::header::COOKIE, cookie)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::REFERER, "https://dida365.com/webapp/")
        .send()
        .await
        .map_err(|_| "滴答精确来源读取失败，来源保留")?;
    checkpoint(app, operation)?;
    if !response.status().is_success() {
        return Err(match response.status() {
            reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN => {
                WebReadError::Authentication(response.status())
            }
            status => WebReadError::Other(http_error(status)),
        });
    }
    if response
        .content_length()
        .is_some_and(|n| n > response_limit as u64)
    {
        return Err("滴答精确来源超出读取上限，来源保留".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "滴答精确来源读取中断，来源保留")?
    {
        checkpoint(app, operation)?;
        if body.len().saturating_add(chunk.len()) > response_limit {
            return Err("滴答精确来源超出读取上限，来源保留".into());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| "滴答精确来源返回无效内容，来源保留".into())
}

async fn read_authenticated_with_candidates<Read, ReadFuture, BuildPath>(
    candidates: Vec<(String, usize)>,
    binding: &AccountBinding,
    build_path: BuildPath,
    mut read: Read,
) -> Result<(Value, Value, String), String>
where
    Read: FnMut(String, String) -> ReadFuture,
    ReadFuture: std::future::Future<Output = Result<Value, WebReadError>>,
    BuildPath: Fn(&Value) -> Result<String, String>,
{
    let mut last_authentication = None;
    let mut authenticated_identity = None;
    for (cookie, _) in candidates {
        let status = match read(cookie.clone(), STATUS_PATH.to_string()).await {
            Ok(status) => status,
            Err(WebReadError::Authentication(status)) => {
                last_authentication = Some(status);
                continue;
            }
            Err(error) => return Err(error.message()),
        };
        let identity = binding.verify(&status)?;
        // A content request can reject a session after /user/status accepted it.
        // Retrying another store must stay on that exact account, including
        // the first import for which no durable inbox binding exists yet.
        if authenticated_identity
            .as_ref()
            .is_some_and(|previous| previous != &identity)
        {
            return Err("滴答附件登录账号发生变化，已保留来源与本地副本".into());
        }
        authenticated_identity = Some(identity);
        let path = build_path(&status)?;
        let raw = match read(cookie.clone(), path).await {
            Ok(raw) => raw,
            Err(WebReadError::Authentication(status)) => {
                last_authentication = Some(status);
                continue;
            }
            Err(error) => return Err(error.message()),
        };
        // The caller uses this same verified cookie for original attachments;
        // do not reselect an unverified store after verifying task identity.
        return Ok((raw, status, cookie));
    }
    Err(last_authentication
        .map(http_error)
        .unwrap_or_else(|| "尚未检测到已登录的滴答网页会话，请完成登录后再检查".into()))
}

async fn verified_web_read<BuildPath>(
    app: &AppHandle,
    operation: &library_runtime::Operation,
    library: &str,
    account: &str,
    build_path: BuildPath,
) -> Result<(Value, Value, String), String>
where
    BuildPath: Fn(&Value) -> Result<String, String>,
{
    checkpoint(app, operation)?;
    let binding = {
        let c = Connection::open_with_flags(
            database_path(app)?,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|_| "滴答账号绑定暂不可核验，来源保留")?;
        AccountBinding::read(&c, library, account)?
    };
    let candidates = dida_attachment_cookie_candidates(app)?;
    let client = web_client()?;
    let result =
        read_authenticated_with_candidates(candidates, &binding, build_path, |cookie, path| {
            get_json(app, operation, &client, cookie, path)
        })
        .await?;
    checkpoint(app, operation)?;
    Ok(result)
}

fn web_client() -> Result<reqwest::Client, String> {
    // This API has fixed HTTPS endpoints and never follows a redirect to another
    // task/login service with the authenticated Cookie.
    reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0")
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "滴答精确来源读取暂不可用".to_string())
}

fn match_task_inventory_batch(
    batch: Value,
    mcp: &DidaTask,
    status: &Value,
) -> Result<DidaTask, String> {
    let batch = match_batch(batch, status)?;
    if paginated(&batch) {
        return Err("滴答附件列表尚未完整读取，暂时保留原内容".into());
    }
    // Look only at direct TaskModels and reject duplicate IDs, including a
    // second project. Recursive collection/deduplication can hide ambiguity.
    let mut matches = ["add", "update"]
        .into_iter()
        .flat_map(|part| batch["syncTaskBean"][part].as_array().unwrap().iter())
        .filter(|raw| raw.get("id").and_then(Value::as_str) == Some(mcp.id.as_str()));
    let raw = matches
        .next()
        .ok_or("滴答没有返回这条内容的附件列表，暂时保留原内容")?;
    if matches.next().is_some() {
        return Err("滴答返回了重复的来源记录，暂时保留原内容".into());
    }
    // Keep the complete batch TaskModel as returned. In particular, missing
    // attachments must not be synthesized as [], even for a text-only task.
    match_task(raw.clone(), mcp, status)
}

async fn task_with_inventory<Read, ReadFuture>(
    raw: Value,
    mcp: &DidaTask,
    status: &Value,
    cookie: &str,
    mut read: Read,
) -> Result<DidaTask, String>
where
    Read: FnMut(String, String) -> ReadFuture,
    ReadFuture: std::future::Future<Output = Result<Value, WebReadError>>,
{
    validate_task_fields(&raw, mcp, status)?;
    if raw.get("attachments").is_some() {
        // Explicit null/unknown shapes are errors, not an omitted field that
        // another endpoint may supplement.
        return match_task(raw, mcp, status);
    }
    let identity = status_identity(status)?;
    let before = read(cookie.to_string(), STATUS_PATH.to_string())
        .await
        .map_err(WebReadError::message)?;
    if status_identity(&before)? != identity {
        return Err("滴答附件登录账号发生变化，已保留来源与本地副本".into());
    }
    let batch = read(cookie.to_string(), BATCH_PATH.to_string())
        .await
        .map_err(WebReadError::message)?;
    let task = match_task_inventory_batch(batch, mcp, &before)?;
    let after = read(cookie.to_string(), STATUS_PATH.to_string())
        .await
        .map_err(WebReadError::message)?;
    if status_identity(&after)? != identity {
        return Err("滴答附件登录账号发生变化，已保留来源与本地副本".into());
    }
    Ok(task)
}

pub(crate) async fn exact_web_task(
    app: &AppHandle,
    operation: &library_runtime::Operation,
    mcp: &DidaTask,
    library: &str,
    account: &str,
) -> Result<(DidaTask, Value, String), String> {
    let (raw, status, cookie) = verified_web_read(app, operation, library, account, |status| {
        task_path(mcp, status)
    })
    .await?;
    let client = web_client()?;
    let task = task_with_inventory(raw, mcp, &status, &cookie, |cookie, path| {
        get_json(app, operation, &client, cookie, path)
    })
    .await?;
    checkpoint(app, operation)?;
    Ok((task, status, cookie))
}

fn match_batch(batch: Value, status: &Value) -> Result<Value, String> {
    super::complete_batch(&batch)?;
    let (_, inbox) = status_identity(status)?;
    if batch
        .get("inboxId")
        .is_some_and(|value| value.as_str() != Some(inbox))
    {
        return Err("滴答来源库存与网页登录账号不一致，来源保留".into());
    }
    Ok(batch)
}

pub(super) async fn verified_web_batch(
    app: &AppHandle,
    operation: &library_runtime::Operation,
    library: &str,
    account: &str,
) -> Result<Value, String> {
    let (batch, status, _) = verified_web_read(app, operation, library, account, |_| {
        Ok(BATCH_PATH.to_string())
    })
    .await?;
    match_batch(batch, &status)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status() -> Value {
        json!({"userId":"account-one","inboxId":"inbox123","username":"never-persist-this"})
    }
    fn source() -> DidaTask {
        let raw = json!({"id":"task-one","projectId":"project-one","title":"隔离阅读资料","content":"正文","desc":"说明","kind":"TEXT","status":0,"priority":1,"tags":["稍后读"],"items":[],"attachments":[],"etag":"version-one"});
        let mut tasks = Vec::new();
        collect_dida_tasks(&raw, "project-one", &mut tasks);
        tasks.remove(0)
    }

    type ScriptedRead = (String, String, Result<Value, WebReadError>);

    fn response(cookie: &str, path: &str, result: Result<Value, WebReadError>) -> ScriptedRead {
        (cookie.to_string(), path.to_string(), result)
    }

    fn task_response(cookie: &str, raw: Value) -> ScriptedRead {
        response(
            cookie,
            "/api/v2/task/task-one?projectId=project-one&withChildren=true",
            Ok(raw),
        )
    }

    async fn scripted_read<BuildPath>(
        candidates: &[&str],
        binding: &AccountBinding,
        script: Vec<ScriptedRead>,
        build_path: BuildPath,
    ) -> Result<(Value, Value, String), String>
    where
        BuildPath: Fn(&Value) -> Result<String, String>,
    {
        let mut script = std::collections::VecDeque::from(script);
        let result = read_authenticated_with_candidates(
            candidates
                .iter()
                .map(|cookie| (cookie.to_string(), 1))
                .collect(),
            binding,
            build_path,
            |cookie, path| {
                let (expected_cookie, expected_path, result) = script
                    .pop_front()
                    .expect("unexpected request or candidate fallback");
                assert_eq!(cookie, expected_cookie);
                assert_eq!(path, expected_path);
                std::future::ready(result)
            },
        )
        .await;
        assert!(script.is_empty(), "expected request was not made");
        result
    }

    async fn scripted_candidates(
        candidates: &[&str],
        binding: &AccountBinding,
        script: Vec<ScriptedRead>,
    ) -> Result<(DidaTask, Value, String), String> {
        let mcp = source();
        let (raw, status, cookie) = scripted_read(candidates, binding, script, |status| {
            task_path(&mcp, status)
        })
        .await?;
        let task = match_task(raw, &mcp, &status)?;
        Ok((task, status, cookie))
    }

    async fn scripted_batch(
        candidates: &[&str],
        binding: &AccountBinding,
        script: Vec<ScriptedRead>,
    ) -> Result<Value, String> {
        let (raw, status, _) =
            scripted_read(candidates, binding, script, |_| Ok(BATCH_PATH.to_string())).await?;
        match_batch(raw, &status)
    }

    fn batch() -> Value {
        json!({"inboxId":"inbox123", "syncTaskBean":{"add":[source().raw],"update":[]}})
    }

    fn without_attachments(mut raw: Value) -> Value {
        raw.as_object_mut().unwrap().remove("attachments");
        raw
    }

    async fn scripted_inventory_for(
        raw: Value,
        mcp: &DidaTask,
        script: Vec<ScriptedRead>,
    ) -> Result<DidaTask, String> {
        let mut script = std::collections::VecDeque::from(script);
        let result = task_with_inventory(raw, mcp, &status(), "verified-store", |cookie, path| {
            let (expected_cookie, expected_path, result) = script
                .pop_front()
                .expect("unexpected attachment supplement request");
            assert_eq!(cookie, expected_cookie);
            assert_eq!(path, expected_path);
            std::future::ready(result)
        })
        .await;
        assert!(
            script.is_empty(),
            "expected supplement request was not made"
        );
        result
    }

    async fn scripted_inventory(raw: Value, script: Vec<ScriptedRead>) -> Result<DidaTask, String> {
        scripted_inventory_for(raw, &source(), script).await
    }

    fn supplement_script(batch: Value) -> Vec<ScriptedRead> {
        vec![
            response("verified-store", STATUS_PATH, Ok(status())),
            response("verified-store", BATCH_PATH, Ok(batch)),
            response("verified-store", STATUS_PATH, Ok(status())),
        ]
    }

    #[tokio::test]
    async fn exact_source_missing_inventory_supplements_unchanged_native_task_using_same_cookie() {
        let mcp = source();
        for attachments in [
            json!([]),
            json!([{"id":"attachment-one","fileName":"tiny.png","size":70}]),
        ] {
            let mut complete = mcp.raw.clone();
            complete["attachments"] = attachments.clone();
            complete["childIds"] = json!([]);
            complete["batchOnlyField"] = json!("preserved");
            let inventory =
                json!({"inboxId":"inbox123","syncTaskBean":{"add":[],"update":[complete]}});
            let expected = inventory["syncTaskBean"]["update"][0].clone();
            let first = scripted_inventory(
                without_attachments(mcp.raw.clone()),
                supplement_script(inventory.clone()),
            )
            .await
            .unwrap();
            let reread = scripted_inventory(
                without_attachments(mcp.raw.clone()),
                supplement_script(inventory),
            )
            .await
            .unwrap();
            assert_eq!(first.raw, expected);
            assert_eq!(reread.raw, first.raw);
            assert_eq!(first.attachments, attachments.as_array().unwrap().clone());
        }
    }

    #[tokio::test]
    async fn exact_source_explicit_inventory_or_invalid_shape_never_requests_supplement() {
        let mcp = source();
        assert_eq!(
            scripted_inventory(mcp.raw.clone(), vec![])
                .await
                .unwrap()
                .raw,
            mcp.raw
        );
        for value in [Value::Null, json!({}), json!("unknown"), json!(false)] {
            let mut raw = mcp.raw.clone();
            raw["attachments"] = value;
            let error = scripted_inventory(raw, vec![]).await.err().unwrap();
            assert!(error.contains("附件列表格式异常"));
        }
    }

    #[tokio::test]
    async fn exact_source_supplement_never_hides_initial_identity_body_version_or_children_change()
    {
        let mcp = source();
        for (field, value) in [
            ("id", json!("other-task")),
            ("projectId", json!("other-project")),
            ("title", json!("changed")),
            ("content", json!("changed")),
            ("desc", json!("changed")),
            ("kind", json!("NOTE")),
            ("status", json!(2)),
            ("tags", json!([])),
            ("items", json!([{"id":"check-one","title":"changed"}])),
            ("etag", json!("changed-version")),
            ("etag", json!(" ")),
            ("children", Value::Null),
            ("childIds", json!(["child-one"])),
            ("hasMore", json!(true)),
            ("data", json!({"task":mcp.raw})),
        ] {
            let mut raw = without_attachments(mcp.raw.clone());
            raw[field] = value;
            assert!(scripted_inventory(raw, vec![]).await.is_err(), "{field}");
        }
    }

    #[tokio::test]
    async fn exact_source_supplement_rejects_incomplete_ambiguous_or_changed_batch_inventory() {
        let mcp = source();
        let mut invalid_batches = Vec::new();
        for (field, value) in [
            ("hasMore", json!(true)),
            ("hasMore", Value::Null),
            ("nextCursor", json!("next")),
            ("inboxId", json!("inbox999")),
            ("inboxId", Value::Null),
        ] {
            let mut invalid = batch();
            invalid[field] = value;
            invalid_batches.push(invalid);
        }
        let mut partial = batch();
        partial["syncTaskBean"]
            .as_object_mut()
            .unwrap()
            .remove("update");
        invalid_batches.push(partial);
        invalid_batches.push(json!({"syncTaskBean":{"add":[],"update":[]}}));
        invalid_batches.push(json!({"syncTaskBean":{"add":[mcp.raw],"update":[mcp.raw]}}));
        let mut other_project = mcp.raw.clone();
        other_project["projectId"] = json!("other-project");
        invalid_batches.push(json!({"syncTaskBean":{"add":[mcp.raw,other_project],"update":[]}}));
        for (field, value) in [
            ("projectId", json!("other-project")),
            ("etag", json!("changed-version")),
            ("content", json!("changed")),
            ("desc", json!("changed")),
            ("childIds", json!(["child-one"])),
            ("children", Value::Null),
            ("attachments", Value::Null),
            ("attachments", json!({})),
        ] {
            let mut invalid = batch();
            invalid["syncTaskBean"]["add"][0][field] = value;
            invalid_batches.push(invalid);
        }
        let mut missing = batch();
        missing["syncTaskBean"]["add"][0]
            .as_object_mut()
            .unwrap()
            .remove("attachments");
        invalid_batches.push(missing);
        for invalid in invalid_batches {
            let error = scripted_inventory(
                without_attachments(mcp.raw.clone()),
                vec![
                    response("verified-store", STATUS_PATH, Ok(status())),
                    response("verified-store", BATCH_PATH, Ok(invalid)),
                ],
            )
            .await
            .err()
            .unwrap();
            assert!(!authentication_required(&error));
        }
    }

    #[tokio::test]
    async fn exact_source_supplement_cannot_switch_verified_user_or_inbox_before_or_after_batch() {
        for field in ["userId", "inboxId"] {
            let mut changed = status();
            changed[field] = json!(if field == "userId" {
                "account-two"
            } else {
                "inbox999"
            });
            for script in [
                vec![response("verified-store", STATUS_PATH, Ok(changed.clone()))],
                vec![
                    response("verified-store", STATUS_PATH, Ok(status())),
                    response("verified-store", BATCH_PATH, Ok(batch())),
                    response("verified-store", STATUS_PATH, Ok(changed.clone())),
                ],
            ] {
                let error = scripted_inventory(without_attachments(source().raw), script)
                    .await
                    .err()
                    .unwrap();
                assert!(error.contains("账号发生变化"));
                assert!(!authentication_required(&error));
            }
        }
    }

    #[tokio::test]
    async fn exact_source_supplement_authentication_or_network_failure_never_reselects_cookie() {
        for path in [STATUS_PATH, BATCH_PATH] {
            for rejected in [
                reqwest::StatusCode::UNAUTHORIZED,
                reqwest::StatusCode::FORBIDDEN,
            ] {
                let mut script = Vec::new();
                if path == BATCH_PATH {
                    script.push(response("verified-store", STATUS_PATH, Ok(status())));
                }
                script.push(response(
                    "verified-store",
                    path,
                    Err(WebReadError::Authentication(rejected)),
                ));
                let error = scripted_inventory(without_attachments(source().raw), script)
                    .await
                    .err()
                    .unwrap();
                assert!(authentication_required(&error));
                assert!(!error.contains("verified-store"));
            }
        }
        let error = scripted_inventory(
            without_attachments(source().raw),
            vec![
                response("verified-store", STATUS_PATH, Ok(status())),
                response(
                    "verified-store",
                    BATCH_PATH,
                    Err(http_error(reqwest::StatusCode::INTERNAL_SERVER_ERROR).into()),
                ),
            ],
        )
        .await
        .err()
        .unwrap();
        assert!(error.contains("500"));
    }

    #[tokio::test]
    async fn exact_source_supplement_resolves_inbox_only_from_current_verified_account() {
        let mut mcp = source();
        mcp.project_id = "inbox".to_string();
        let mut raw = without_attachments(mcp.raw.clone());
        raw["projectId"] = json!("inbox123");
        let mut complete = mcp.raw.clone();
        complete["projectId"] = json!("inbox123");
        let task = scripted_inventory_for(
            raw,
            &mcp,
            supplement_script(
                json!({"inboxId":"inbox123","syncTaskBean":{"add":[complete],"update":[]}}),
            ),
        )
        .await
        .unwrap();
        assert_eq!(task.project_id, "inbox123");
        assert!(task
            .raw
            .get("attachments")
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn exact_source_batch_discovery_reuses_authenticated_fallback_without_changing_raw() {
        let expected = batch();
        for (first_rejected_path, mut script) in [
            (
                STATUS_PATH,
                vec![response(
                    "expired-store",
                    STATUS_PATH,
                    Err(WebReadError::Authentication(
                        reqwest::StatusCode::UNAUTHORIZED,
                    )),
                )],
            ),
            (
                BATCH_PATH,
                vec![
                    response("expired-store", STATUS_PATH, Ok(status())),
                    response(
                        "expired-store",
                        BATCH_PATH,
                        Err(WebReadError::Authentication(reqwest::StatusCode::FORBIDDEN)),
                    ),
                ],
            ),
        ] {
            script.extend([
                response("valid-store", STATUS_PATH, Ok(status())),
                response("valid-store", BATCH_PATH, Ok(expected.clone())),
            ]);
            let actual = scripted_batch(
                &["expired-store", "valid-store"],
                &AccountBinding::default(),
                script,
            )
            .await
            .unwrap();
            assert_eq!(actual, expected, "{first_rejected_path}");
        }
        let mut no_inbox_field = expected;
        no_inbox_field.as_object_mut().unwrap().remove("inboxId");
        assert_eq!(
            match_batch(no_inbox_field.clone(), &status()).unwrap(),
            no_inbox_field
        );
    }

    #[tokio::test]
    async fn exact_source_batch_invalid_inventory_or_account_never_falls_back() {
        let mut wrong_inbox = batch();
        wrong_inbox["inboxId"] = json!("inbox999");
        let mut unknown_inbox = batch();
        unknown_inbox["inboxId"] = Value::Null;
        let mut partial = batch();
        partial["hasMore"] = json!(true);
        let mut missing_inventory = batch();
        missing_inventory["syncTaskBean"]
            .as_object_mut()
            .unwrap()
            .remove("update");
        for invalid in [
            wrong_inbox,
            unknown_inbox,
            partial,
            missing_inventory,
            json!({}),
        ] {
            let error = scripted_batch(
                &["first-store", "unused-store"],
                &AccountBinding::default(),
                vec![
                    response("first-store", STATUS_PATH, Ok(status())),
                    response("first-store", BATCH_PATH, Ok(invalid)),
                ],
            )
            .await
            .err()
            .unwrap();
            assert!(!authentication_required(&error));
        }
        let error = scripted_batch(
            &["first-store", "unused-store"],
            &AccountBinding::default(),
            vec![
                response("first-store", STATUS_PATH, Ok(status())),
                response(
                    "first-store",
                    BATCH_PATH,
                    Err(http_error(reqwest::StatusCode::INTERNAL_SERVER_ERROR).into()),
                ),
            ],
        )
        .await
        .err()
        .unwrap();
        assert!(error.contains("500"));
    }

    #[tokio::test]
    async fn exact_source_batch_authentication_fallback_cannot_switch_verified_account() {
        let mut switched = status();
        switched["userId"] = json!("account-two");
        let error = scripted_batch(
            &["first-store", "switched-store", "unused-store"],
            &AccountBinding::default(),
            vec![
                response("first-store", STATUS_PATH, Ok(status())),
                response(
                    "first-store",
                    BATCH_PATH,
                    Err(WebReadError::Authentication(
                        reqwest::StatusCode::UNAUTHORIZED,
                    )),
                ),
                response("switched-store", STATUS_PATH, Ok(switched)),
            ],
        )
        .await
        .err()
        .unwrap();
        assert!(error.contains("账号发生变化"));
        assert!(!authentication_required(&error));
    }

    #[tokio::test]
    async fn exact_source_uses_the_first_valid_login_store_for_status_and_task() {
        let result = scripted_candidates(
            &["new-login", "expired-main"],
            &AccountBinding::default(),
            vec![
                response("new-login", STATUS_PATH, Ok(status())),
                task_response("new-login", source().raw),
            ],
        )
        .await
        .unwrap();
        assert_eq!(result.2, "new-login");
        assert_eq!(result.0.id, "task-one");
        assert_eq!(result.1, status());
    }

    #[tokio::test]
    async fn exact_source_falls_back_only_from_401_or_403_using_independent_headers() {
        for rejected in [
            reqwest::StatusCode::UNAUTHORIZED,
            reqwest::StatusCode::FORBIDDEN,
        ] {
            let result = scripted_candidates(
                &["expired-store", "valid-store"],
                &AccountBinding::default(),
                vec![
                    response(
                        "expired-store",
                        STATUS_PATH,
                        Err(WebReadError::Authentication(rejected)),
                    ),
                    response("valid-store", STATUS_PATH, Ok(status())),
                    task_response("valid-store", source().raw),
                ],
            )
            .await
            .unwrap();
            assert_eq!(result.2, "valid-store");
        }
    }

    #[tokio::test]
    async fn exact_source_all_rejected_sessions_request_login_without_credential_output() {
        let error = scripted_candidates(
            &["fixture-private-cookie-one", "fixture-private-cookie-two"],
            &AccountBinding::default(),
            vec![
                response(
                    "fixture-private-cookie-one",
                    STATUS_PATH,
                    Err(WebReadError::Authentication(
                        reqwest::StatusCode::UNAUTHORIZED,
                    )),
                ),
                response(
                    "fixture-private-cookie-two",
                    STATUS_PATH,
                    Err(WebReadError::Authentication(reqwest::StatusCode::FORBIDDEN)),
                ),
            ],
        )
        .await
        .err()
        .unwrap();
        assert!(authentication_required(&error));
        assert!(error.contains("请重新登录"));
        assert!(!error.contains("fixture-private-cookie"));
        assert!(!error.contains("username"));
        assert!(scripted_candidates(&[], &AccountBinding::default(), vec![])
            .await
            .is_err());
    }

    #[tokio::test]
    async fn exact_source_non_authentication_failures_never_try_another_store() {
        let network = "滴答精确来源读取失败，来源保留";
        for error in [
            network.to_string(),
            http_error(reqwest::StatusCode::INTERNAL_SERVER_ERROR),
        ] {
            let actual = scripted_candidates(
                &["first-store", "other-store"],
                &AccountBinding::default(),
                vec![response(
                    "first-store",
                    STATUS_PATH,
                    Err(error.clone().into()),
                )],
            )
            .await
            .err()
            .unwrap();
            assert_eq!(actual, error);
        }
        let error = scripted_candidates(
            &["first-store", "other-store"],
            &AccountBinding::default(),
            vec![
                response("first-store", STATUS_PATH, Ok(status())),
                response(
                    "first-store",
                    "/api/v2/task/task-one?projectId=project-one&withChildren=true",
                    Err(http_error(reqwest::StatusCode::INTERNAL_SERVER_ERROR).into()),
                ),
            ],
        )
        .await
        .err()
        .unwrap();
        assert!(error.contains("500"));
        assert!(!authentication_required(&error));
    }

    #[tokio::test]
    async fn exact_source_task_authentication_fallback_pins_the_verified_account() {
        let rejected = || {
            response(
                "first-store",
                "/api/v2/task/task-one?projectId=project-one&withChildren=true",
                Err(WebReadError::Authentication(
                    reqwest::StatusCode::UNAUTHORIZED,
                )),
            )
        };
        let result = scripted_candidates(
            &["first-store", "same-account-store"],
            &AccountBinding::default(),
            vec![
                response("first-store", STATUS_PATH, Ok(status())),
                rejected(),
                response("same-account-store", STATUS_PATH, Ok(status())),
                task_response("same-account-store", source().raw),
            ],
        )
        .await
        .unwrap();
        assert_eq!(result.2, "same-account-store");
        for field in ["userId", "inboxId"] {
            let mut switched = status();
            switched[field] = json!(if field == "userId" {
                "account-two"
            } else {
                "inbox999"
            });
            let error = scripted_candidates(
                &["first-store", "switched-account-store", "unused-store"],
                &AccountBinding::default(),
                vec![
                    response("first-store", STATUS_PATH, Ok(status())),
                    rejected(),
                    response("switched-account-store", STATUS_PATH, Ok(switched)),
                ],
            )
            .await
            .err()
            .unwrap();
            assert!(error.contains("账号发生变化"));
            assert!(!authentication_required(&error));
        }
    }

    #[tokio::test]
    async fn exact_source_bound_account_and_unknown_identity_fail_before_task_read() {
        let wrong_user = AccountBinding {
            user: Some("account-two".into()),
            inbox_hash: String::new(),
        };
        let wrong_inbox = AccountBinding {
            user: None,
            inbox_hash: storage::hash(b"inbox999"),
        };
        for binding in [&wrong_user, &wrong_inbox] {
            assert!(scripted_candidates(
                &["first-store", "unused-store"],
                binding,
                vec![response("first-store", STATUS_PATH, Ok(status()))],
            )
            .await
            .is_err());
        }
        for invalid in [json!({}), json!({"userId":"account-one","inboxId":"inbox"})] {
            assert!(scripted_candidates(
                &["first-store", "unused-store"],
                &AccountBinding::default(),
                vec![response("first-store", STATUS_PATH, Ok(invalid))],
            )
            .await
            .is_err());
        }
    }

    #[tokio::test]
    async fn exact_source_changed_task_version_does_not_fall_back_to_another_store() {
        let mut changed = source().raw;
        changed["etag"] = json!("changed-version");
        let error = scripted_candidates(
            &["first-store", "unused-store"],
            &AccountBinding::default(),
            vec![
                response("first-store", STATUS_PATH, Ok(status())),
                task_response("first-store", changed),
            ],
        )
        .await
        .err()
        .unwrap();
        assert!(error.contains("版本不一致"));
        assert!(!authentication_required(&error));
    }

    #[test]
    fn exact_source_reads_existing_account_binding_without_creating_or_changing_it() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE libraries(id TEXT PRIMARY KEY,metadata_json TEXT);INSERT INTO libraries VALUES('fixture','{}');").unwrap();
        let before = c.total_changes();
        let unbound = AccountBinding::read(&c, "fixture", "library:fixture").unwrap();
        assert!(unbound.user.is_none());
        assert!(unbound.inbox_hash.is_empty());
        unbound.verify(&status()).unwrap();
        assert_eq!(c.total_changes(), before);
        assert!(metadata_string(&c, "dida_reading_account:fixture:library:fixture").is_empty());
        c.execute(
            "INSERT INTO metadata VALUES(?1,?2)",
            params![
                "dida_reading_account:fixture:library:fixture",
                storage::hash(b"inbox123")
            ],
        )
        .unwrap();
        c.execute(
            "UPDATE libraries SET metadata_json=?1",
            [json!({"preference":{"userId":"account-one"}}).to_string()],
        )
        .unwrap();
        let before = c.total_changes();
        assert!(AccountBinding::read(&c, "fixture", "account-two").is_err());
        let configured = AccountBinding::read(&c, "fixture", "account-one").unwrap();
        configured.verify(&status()).unwrap();
        let mut switched = status();
        switched["userId"] = json!("account-two");
        assert!(configured.verify(&switched).is_err());
        assert_eq!(c.total_changes(), before);
        c.execute("UPDATE libraries SET metadata_json='{}'", [])
            .unwrap();
        let before = c.total_changes();
        let bound = AccountBinding::read(&c, "fixture", "library:fixture").unwrap();
        assert_eq!(bound.inbox_hash, storage::hash(b"inbox123"));
        switched = status();
        switched["inboxId"] = json!("inbox999");
        assert!(bound.verify(&switched).is_err());
        assert_eq!(c.total_changes(), before);
    }

    #[test]
    fn exact_source_authentication_errors_request_login_and_recognize_legacy_receipts() {
        for status in [
            reqwest::StatusCode::UNAUTHORIZED,
            reqwest::StatusCode::FORBIDDEN,
        ] {
            let current = http_error(status);
            assert!(current.contains("请重新登录"));
            assert!(authentication_required(&current));
            let legacy = format!("滴答精确来源读取失败（HTTP {}），来源保留", status.as_u16());
            assert!(authentication_required(&legacy));
            assert_eq!(display_error(&legacy), current);
            assert!(authentication_required(&format!(
                "本地已保存，滴答来源删除待重试：{current}"
            )));
        }
        for error in [
            http_error(reqwest::StatusCode::INTERNAL_SERVER_ERROR),
            "滴答附件下载失败（HTTP 403）".to_string(),
            "滴答任务与附件会话的版本不一致，来源保留".to_string(),
        ] {
            assert!(!authentication_required(&error));
            assert_eq!(display_error(&error), error);
        }
    }

    #[test]
    fn exact_source_preserves_web_raw_and_complete_original_inventory() {
        let mcp = source();
        let mut raw = mcp.raw.clone();
        raw["attachments"] = json!([
            {"id":"attachment-one","fileName":"tiny.png","fileType":"image/png","size":70},
            {"id":"attachment-two","fileName":"tiny.pdf","fileType":"application/pdf","size":128}
        ]);
        let task = match_task(raw.clone(), &mcp, &status()).unwrap();
        assert_eq!(task.raw, raw);
        assert_eq!(task.attachments.len(), 2);
        assert!(task.raw.get("children").is_none());
        assert!(task.raw.get("childIds").is_none());
        assert!(match_task(mcp.raw.clone(), &mcp, &status())
            .unwrap()
            .attachments
            .is_empty());
    }

    #[test]
    fn exact_source_rejects_wrappers_duplicates_partial_or_unknown_inventory() {
        let mcp = source();
        assert!(match_task(json!([mcp.raw, mcp.raw]), &mcp, &status()).is_err());
        for (field, value) in [
            ("id", json!("other-task")),
            ("projectId", json!("other-project")),
            ("attachments", Value::Null),
            ("tasks", json!([mcp.raw, mcp.raw])),
            ("data", json!({"task":mcp.raw})),
            ("hasMore", json!(true)),
            ("hasMore", Value::Null),
            ("nextCursor", json!("next")),
            ("unknown", json!({"hasMore":true})),
            ("unknown", json!({"task":mcp.raw})),
        ] {
            let mut raw = mcp.raw.clone();
            raw[field] = value;
            assert!(match_task(raw, &mcp, &status()).is_err(), "{field}");
        }
        let mut raw = mcp.raw.clone();
        raw.as_object_mut().unwrap().remove("attachments");
        assert!(match_task(raw, &mcp, &status()).is_err());
    }

    #[test]
    fn exact_source_requires_each_mcp_body_field_and_nonempty_matching_etag() {
        let mcp = source();
        for (field, value) in [
            ("title", json!("changed")),
            ("content", json!("changed")),
            ("desc", json!("changed")),
            ("kind", json!("NOTE")),
            ("status", json!(2)),
            ("tags", json!([])),
            ("items", json!([{"id":"check-one","title":"changed"}])),
            ("etag", json!("version-two")),
            ("etag", json!(" ")),
        ] {
            let mut raw = mcp.raw.clone();
            raw[field] = value;
            assert!(match_task(raw, &mcp, &status()).is_err(), "{field}");
        }
        let mut missing = mcp.clone();
        missing.raw.as_object_mut().unwrap().remove("etag");
        assert!(match_task(mcp.raw.clone(), &missing, &status()).is_err());
        let mut no_tags = mcp.clone();
        no_tags.tags.clear();
        no_tags.raw.as_object_mut().unwrap().remove("tags");
        assert!(match_task(no_tags.raw.clone(), &no_tags, &status()).is_ok());
    }

    #[test]
    fn exact_source_rejects_all_existing_or_unknown_children_without_synthesis() {
        let mcp = source();
        for field in [
            "children",
            "childIds",
            "child_ids",
            "childTasks",
            "child_tasks",
        ] {
            for value in [Value::Null, json!(["child-one"]), json!({})] {
                let mut raw = mcp.raw.clone();
                raw[field] = value;
                assert!(match_task(raw, &mcp, &status()).is_err(), "{field}");
            }
            let mut raw = mcp.raw.clone();
            raw[field] = json!([]);
            assert_eq!(match_task(raw.clone(), &mcp, &status()).unwrap().raw, raw);
        }
    }

    #[test]
    fn exact_source_resolves_only_the_current_authenticated_inbox_alias() {
        let mut mcp = source();
        mcp.project_id = "inbox".into();
        let mut raw = mcp.raw.clone();
        raw["projectId"] = json!("inbox123");
        assert_eq!(
            task_path(&mcp, &status()).unwrap(),
            "/api/v2/task/task-one?projectId=inbox123&withChildren=true"
        );
        assert_eq!(
            match_task(raw.clone(), &mcp, &status()).unwrap().project_id,
            "inbox123"
        );
        raw["projectId"] = json!("inbox999");
        assert!(match_task(raw, &mcp, &status()).is_err());
        for invalid in [
            json!({}),
            json!({"userId":"account-one","inboxId":"inbox"}),
            json!({"userId":null,"inboxId":"inbox123"}),
        ] {
            assert!(task_path(&mcp, &invalid).is_err());
        }
        mcp.id = "task/other".into();
        assert!(task_path(&mcp, &status()).is_err());
    }

    #[test]
    fn exact_source_account_binding_reuses_only_hash_and_checks_explicit_user() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE libraries(id TEXT PRIMARY KEY,metadata_json TEXT);INSERT INTO libraries VALUES('fixture','{}');").unwrap();
        account_matches(&c, "fixture", "library:fixture", &status()).unwrap();
        let saved = metadata_string(&c, "dida_reading_account:fixture:library:fixture");
        assert_eq!(saved, storage::hash(b"inbox123"));
        assert!(!saved.contains("never-persist-this"));
        c.execute(
            "UPDATE libraries SET metadata_json=?1",
            [json!({"preference":{"userId":"account-one"}}).to_string()],
        )
        .unwrap();
        account_matches(&c, "fixture", "account-one", &status()).unwrap();
        let mut switched = status();
        switched["userId"] = json!("account-two");
        assert!(account_matches(&c, "fixture", "account-one", &switched).is_err());
        switched = status();
        switched["inboxId"] = json!("inbox999");
        assert!(account_matches(&c, "fixture", "account-one", &switched).is_err());
        assert!(
            account_matches(&c, "fixture", "account-one", &json!({"inboxId":"inbox123"})).is_err()
        );
        assert!(metadata_string(&c, "dida_reading_account:fixture:account-two").is_empty());
    }
}
