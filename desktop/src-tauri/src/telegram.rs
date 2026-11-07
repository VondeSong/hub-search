//! Telegram bot inbox. Updates and the next offset commit together, before media I/O.
//! Bot tokens never enter collection rows, URLs exposed to the webview, or diagnostics.
use super::*;
use crate::collection_models::{Media, Origin, Post};
use std::sync::atomic::AtomicBool;
pub(crate) mod tdl;

const SECRET: &str = "hub-telegram-bot-token-v1";
const CONFIG: &str = "collection_telegram_connection_v1";
const MAX_RESPONSE: usize = 12 * 1024 * 1024;
static LOCK: AsyncMutex<()> = AsyncMutex::const_new(());
static RUNNING: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Inbox {
    bot_id: i64,
    username: String,
    user_id: i64,
    offset: i64,
    pair_code: String,
    pair_expires: i64,
    enabled: bool,
    blocked: bool,
    last_attempt: i64,
    last_success: i64,
    retry_after: i64,
    status: String,
}
fn schema(c: &Connection) -> Result<(), String> {
    crate::x_bookmarks::schema(c)?;
    tdl::schema(c)?;
    c.execute_batch("CREATE TABLE IF NOT EXISTS collection_telegram_messages (
        bot_id INTEGER NOT NULL, chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL,
        item_key TEXT NOT NULL, message_json TEXT NOT NULL,
        PRIMARY KEY(bot_id,chat_id,message_id));
        CREATE INDEX IF NOT EXISTS collection_telegram_group ON collection_telegram_messages(item_key,message_id);")
        .map_err(|e| e.to_string())
}
fn inbox(c: &Connection) -> Result<Inbox, String> {
    let value = metadata_string(c, CONFIG);
    if value.is_empty() {
        Ok(Inbox::default())
    } else {
        serde_json::from_str(&value).map_err(|_| "Telegram 连接设置损坏，请重新连接".into())
    }
}
fn save_inbox(c: &Connection, value: &Inbox) -> Result<(), String> {
    c.execute("INSERT INTO metadata(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![CONFIG, serde_json::to_string(value).map_err(|_| "无法保存 Telegram 设置")?])
        .map(|_| ()).map_err(|e| e.to_string())
}
pub(super) fn source_state(
    app: &AppHandle,
    c: &Connection,
    minutes: u32,
    count: i64,
) -> Result<Value, String> {
    let cfg = inbox(c)?;
    let connected = cfg.enabled && stored_secret_get(app, SECRET)?.is_some();
    let next = if connected && !cfg.blocked && (minutes > 0 || !cfg.pair_code.is_empty()) {
        Some(
            (cfg.last_attempt
                + if cfg.user_id == 0 {
                    15
                } else {
                    i64::from(minutes) * 60
                })
            .max(cfg.retry_after),
        )
    } else {
        None
    };
    Ok(
        json!({"id":"telegram","count":count,"connected":connected,"canResume":false,
        "status":cfg.status,"lastSuccess":cfg.last_success,"nextSyncAt":next,"autoBlocked":cfg.blocked,
        "paired":cfg.user_id>0,"botUsername":cfg.username,
        "pairingUrl":if connected && !cfg.pair_code.is_empty() && cfg.pair_expires > now_timestamp() {format!("https://t.me/{}?start={}",cfg.username,cfg.pair_code)} else {String::new()}}),
    )
}

#[derive(Debug)]
struct ApiError {
    message: String,
    retry: i64,
    blocked: bool,
}
impl ApiError {
    fn message(message: &str) -> Self {
        Self {
            message: message.into(),
            retry: 60,
            blocked: false,
        }
    }
}
struct Api {
    client: reqwest::Client,
    base: String,
}
impl Api {
    fn new() -> Result<Self, String> {
        Ok(Self {
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(15))
                .timeout(Duration::from_secs(45))
                .build()
                .map_err(|_| "无法初始化 Telegram 连接")?,
            base: "https://api.telegram.org".into(),
        })
    }
    async fn call(&self, token: &str, method: &str, payload: Value) -> Result<Value, ApiError> {
        // Errors intentionally omit reqwest's URL, which contains the token.
        let mut response = self
            .client
            .post(format!("{}/bot{token}/{method}", self.base))
            .json(&payload)
            .send()
            .await
            .map_err(|_| ApiError::message("无法连接 Telegram，请检查网络或代理后重试"))?;
        let code = response.status().as_u16();
        let mut bytes = vec![];
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| ApiError::message("Telegram 响应中断，已保存的内容保留"))?
        {
            if bytes.len() + chunk.len() > MAX_RESPONSE {
                return Err(ApiError::message("Telegram 单次响应过大，收件位置已保留"));
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| ApiError::message("Telegram 响应格式无效，请稍后重试"))?;
        if code == 200 && value["ok"] == true {
            return value
                .get("result")
                .cloned()
                .ok_or_else(|| ApiError::message("Telegram 响应缺少结果"));
        }
        Err(api_error(
            value["error_code"].as_u64().unwrap_or(u64::from(code)) as u16,
            &value,
        ))
    }
}
fn api_error(code: u16, value: &Value) -> ApiError {
    let oversized = value["description"]
        .as_str()
        .unwrap_or("")
        .to_ascii_lowercase()
        .contains("file is too big");
    ApiError {
        message: if oversized {
            "Telegram 云端接口仅支持下载 20 MB 以内的附件，正文已保留".into()
        } else {
            match code {401|404=>"Telegram Token 无效或已失效，请更新连接".into(),
            409=>"机器人正在由其他服务接收消息，请停止另一接收程序后重试；Hub 不会更改现有 webhook".into(),
            429=>"Telegram 请求限流，等待冷却后会继续".into(),
            _=>format!("Telegram 请求未成功（HTTP {code}），可稍后重试")}
        },
        retry: value
            .pointer("/parameters/retry_after")
            .and_then(Value::as_i64)
            .unwrap_or(60)
            .clamp(1, 86400),
        blocked: matches!(code, 401 | 404 | 409),
    }
}
fn valid_token(token: &str) -> bool {
    let Some((id, secret)) = token.split_once(':') else {
        return false;
    };
    id.parse::<i64>().is_ok_and(|id| id > 0)
        && (20..=200).contains(&secret.len())
        && secret
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
async fn validate_bot(api: &Api, token: &str) -> Result<(i64, String), String> {
    if !valid_token(token) {
        return Err("请填写 BotFather 提供的完整机器人 Token".into());
    }
    let me = api
        .call(token, "getMe", json!({}))
        .await
        .map_err(|e| e.message)?;
    let id = me["id"]
        .as_i64()
        .filter(|id| *id > 0)
        .ok_or("Telegram 未返回机器人身份")?;
    let username = me["username"]
        .as_str()
        .filter(|u| !u.is_empty() && u.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'))
        .ok_or("Telegram 未返回机器人名称")?;
    if me["is_bot"] != true || token.split(':').next() != Some(id.to_string().as_str()) {
        return Err("机器人身份与 Token 不一致".into());
    }
    let hook = api
        .call(token, "getWebhookInfo", json!({}))
        .await
        .map_err(|e| e.message)?;
    if !hook["url"]
        .as_str()
        .ok_or("Telegram 未返回接收状态")?
        .is_empty()
    {
        return Err("此机器人已有 webhook 接收服务。请使用专用收集机器人，或先在原服务中安排转存；Hub 不会删除现有 webhook。".into());
    }
    Ok((id, username.into()))
}

#[tauri::command]
pub(super) async fn save_telegram_connection(
    app: AppHandle,
    token: String,
) -> Result<String, String> {
    let guard = LOCK
        .try_lock()
        .map_err(|_| "请等待 Telegram 本轮收件结束")?;
    let token = token.trim();
    let api = Api::new()?;
    let (id, username) = validate_bot(&api, token).await?;
    let old_secret = stored_secret_get(&app, SECRET)?;
    let (c, _writer) = open_write_database(&database_path(&app)?)?;
    schema(&c)?;
    let old = inbox(&c)?;
    let mut cfg = if old.bot_id == id {
        old
    } else {
        Inbox::default()
    };
    cfg.bot_id = id;
    cfg.username = username;
    cfg.enabled = true;
    cfg.blocked = false;
    cfg.retry_after = 0;
    if cfg.user_id == 0 {
        cfg.pair_code = format!("hub_{}", random_url_safe(18));
        cfg.pair_expires = now_timestamp() + 86400;
    }
    cfg.status = if cfg.user_id > 0 {
        "连接已更新，收件位置与本地内容保留".into()
    } else {
        "等待账号确认：打开机器人并发送开始消息".into()
    };
    stored_secret_set(&app, SECRET, token)
        .map_err(|_| "无法在系统凭据库保存 Telegram Token，原连接保留")?;
    if let Err(error) = save_inbox(&c, &cfg) {
        if let Some(old) = old_secret {
            let _ = stored_secret_set(&app, SECRET, &old);
        } else {
            stored_secret_delete(&app, SECRET);
        }
        return Err(error);
    }
    drop(c);
    drop(_writer);
    drop(guard);
    launch_if_connected(app);
    Ok(if cfg.user_id > 0 {
        "Telegram 已连接，可立即同步".into()
    } else {
        "连接已保存，请打开机器人确认你的账号；确认消息不会收进数据库".into()
    })
}
#[tauri::command]
pub(super) async fn disconnect_telegram(app: AppHandle) -> Result<(), String> {
    let _guard = LOCK
        .try_lock()
        .map_err(|_| "请等待 Telegram 本轮收件结束")?;
    stored_secret_delete(&app, SECRET);
    if stored_secret_get(&app, SECRET)?.is_some() {
        return Err("无法移除 Telegram 凭据，请重试".into());
    }
    let (c, _writer) = open_write_database(&database_path(&app)?)?;
    let mut cfg = inbox(&c)?;
    cfg.enabled = false;
    cfg.pair_code.clear();
    cfg.status = "已断开 Telegram，本地收集内容保留".into();
    save_inbox(&c, &cfg)
}
#[tauri::command]
pub(super) async fn sync_telegram(app: AppHandle) -> Result<String, String> {
    let guard = LOCK.try_lock().map_err(|_| "Telegram 正在收件")?;
    let c = open_database(&database_path(&app)?)?;
    if !inbox(&c)?.enabled || stored_secret_get(&app, SECRET)?.is_none() {
        return Err("请先连接 Telegram 机器人".into());
    }
    drop(c);
    launch(app, guard);
    Ok("已开始 Telegram 后台收件".into())
}
pub(super) fn launch_if_connected(app: AppHandle) {
    let Ok(guard) = LOCK.try_lock() else {
        return;
    };
    let connected = (|| -> Result<bool, String> {
        let c = open_database(&database_path(&app)?)?;
        Ok(inbox(&c)?.enabled && stored_secret_get(&app, SECRET)?.is_some())
    })();
    if connected == Ok(true) {
        launch(app, guard);
    }
}
fn launch(app: AppHandle, guard: tokio::sync::MutexGuard<'static, ()>) {
    RUNNING.store(true, Ordering::Relaxed);
    CANCEL.store(false, Ordering::Relaxed);
    tauri::async_runtime::spawn(async move {
        let _guard = guard;
        let result = receive(&app).await;
        if let Ok(path) = database_path(&app) {
            if let Ok((c, _writer)) = open_write_database(&path) {
                if let Ok(mut cfg) = inbox(&c) {
                    match result {
                        Ok(message) => cfg.status = message,
                        Err(error) => {
                            cfg.status = error.message;
                            cfg.retry_after = now_timestamp() + error.retry;
                            cfg.blocked = error.blocked;
                        }
                    }
                    let _ = save_inbox(&c, &cfg);
                }
            }
        }
        RUNNING.store(false, Ordering::Relaxed);
        tdl::launch_if_ready(&app);
        let _ = app.emit("collections-updated", json!({"source":"telegram"}));
    });
}
pub(super) fn cancel() {
    CANCEL.store(true, Ordering::Relaxed);
    tdl::cancel();
}
pub(super) fn running() -> bool {
    RUNNING.load(Ordering::Relaxed)
}

async fn receive(app: &AppHandle) -> Result<String, ApiError> {
    let path = database_path(app).map_err(|e| ApiError::message(&e))?;
    let token = stored_secret_get(app, SECRET)
        .map_err(|_| ApiError::message("无法读取 Telegram 凭据"))?
        .ok_or_else(|| ApiError::message("请先连接 Telegram 机器人"))?;
    let mut cfg = {
        let (c, _writer) = open_write_database(&path).map_err(|e| ApiError::message(&e))?;
        schema(&c).map_err(|e| ApiError::message(&e))?;
        let mut cfg = inbox(&c).map_err(|e| ApiError::message(&e))?;
        if cfg.retry_after > now_timestamp() {
            return Err(ApiError {
                message: "Telegram 正在等待冷却，稍后可继续".into(),
                retry: cfg.retry_after - now_timestamp(),
                blocked: cfg.blocked,
            });
        }
        cfg.blocked = false;
        cfg.last_attempt = now_timestamp();
        cfg.status = "正在接收 Telegram 消息".into();
        save_inbox(&c, &cfg).map_err(|e| ApiError::message(&e))?;
        cfg
    };
    let api = Api::new().map_err(|e| ApiError::message(&e))?;
    let mut total = Stats::default();
    for _ in 0..20 {
        if CANCEL.load(Ordering::Relaxed) {
            break;
        }
        let updates = fetch_updates(&api, &token, &cfg).await?;
        let len = updates.len();
        {
            let (mut c, _writer) = open_write_database(&path).map_err(|e| ApiError::message(&e))?;
            let stats = persist_updates(&mut c, &mut cfg, &updates, now_timestamp())
                .map_err(|e| ApiError::message(&e))?;
            total.added += stats.added;
            total.changed += stats.changed;
            total.ignored += stats.ignored;
        }
        let _ = app.emit("collections-updated", json!({"source":"telegram"}));
        if len < 100 {
            break;
        }
    }
    if cfg.user_id == 0 {
        return Ok(if cfg.pair_expires > now_timestamp() {
            "等待账号确认：点击打开机器人并发送开始消息".into()
        } else {
            "账号确认已过期，请更新 Telegram 连接后重新确认".into()
        });
    }
    // Shared export is queued independently; a long X run never blocks receiving updates.
    {
        let (c, _writer) = open_write_database(&path).map_err(|e| ApiError::message(&e))?;
        let generation = chrono::Utc::now()
            .timestamp_nanos_opt()
            .unwrap_or(now_timestamp() * 1_000_000_000)
            .to_string();
        c.execute("INSERT INTO metadata(key,value) VALUES('telegram_export_pending',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[generation]).map_err(|e|ApiError::message(&e.to_string()))?;
    }
    queue_export(app, true);
    Ok(format!(
        "Telegram 收件结束 · 新增 {} 条 · 更新 {} 条 · 忽略 {} 条{}",
        total.added,
        total.changed,
        total.ignored,
        if CANCEL.load(Ordering::Relaxed) {
            " · 已暂停，收件位置已保留"
        } else {
            ""
        }
    ))
}
async fn fetch_updates(api: &Api, token: &str, cfg: &Inbox) -> Result<Vec<Value>, ApiError> {
    let result=api.call(token,"getUpdates",json!({"offset":cfg.offset,"limit":100,"timeout":0,"allowed_updates":["message","edited_message"]})).await?;
    result
        .as_array()
        .filter(|a| a.len() <= 100)
        .cloned()
        .ok_or_else(|| ApiError::message("Telegram 未返回有效收件列表"))
}
#[derive(Default)]
struct Stats {
    added: usize,
    changed: usize,
    ignored: usize,
}
fn message_key(bot: i64, message: &Value) -> Result<String, String> {
    let chat = message
        .pointer("/chat/id")
        .and_then(Value::as_i64)
        .ok_or("Telegram 消息缺少聊天身份")?;
    let id = message["message_id"]
        .as_i64()
        .filter(|id| *id > 0)
        .ok_or("Telegram 消息缺少消息身份")?;
    Ok(
        if let Some(group) = message["media_group_id"].as_str().filter(|g| {
            !g.is_empty()
                && g.len() <= 100
                && g.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        }) {
            format!("telegram:{bot}:{chat}:album:{group}")
        } else {
            format!("telegram:{bot}:{chat}:{id}")
        },
    )
}
fn persist_updates(
    c: &mut Connection,
    cfg: &mut Inbox,
    updates: &[Value],
    now: i64,
) -> Result<Stats, String> {
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let mut next = cfg.clone();
    let mut stats = Stats::default();
    let mut keys = std::collections::BTreeSet::new();
    let mut ordered = updates.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|u| u["update_id"].as_i64().unwrap_or(-1));
    for update in ordered {
        let id = update["update_id"]
            .as_i64()
            .filter(|id| *id >= 0)
            .ok_or("Telegram 更新缺少身份，收件位置未推进")?;
        if id < next.offset {
            continue;
        }
        next.offset = id.checked_add(1).ok_or("Telegram 更新身份无效")?;
        let Some(message) = update
            .get("message")
            .or_else(|| update.get("edited_message"))
        else {
            stats.ignored += 1;
            continue;
        };
        let user = message
            .pointer("/from/id")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let private = message.pointer("/chat/type").and_then(Value::as_str) == Some("private")
            && message.pointer("/chat/id").and_then(Value::as_i64) == Some(user);
        let text = message["text"].as_str().unwrap_or("").trim();
        if next.user_id == 0
            && private
            && user > 0
            && next.pair_expires > now
            && !next.pair_code.is_empty()
            && text == format!("/start {}", next.pair_code)
        {
            next.user_id = user;
            next.pair_code.clear();
            stats.ignored += 1;
            continue;
        }
        if !private || user == 0 || user != next.user_id || text.starts_with("/start hub_") {
            stats.ignored += 1;
            continue;
        }
        if crate::x_bookmarks::library::blocked_message(
            &tx,
            next.bot_id,
            user,
            message["message_id"].as_i64().unwrap_or(0),
            "bot",
        )? {
            stats.ignored += 1;
            continue;
        }
        let key = tdl::key_for_bot(&tx, &next, message, &message_key(next.bot_id, message)?)?;
        if crate::x_bookmarks::library::blocked(&tx, &key)? {
            stats.ignored += 1;
            continue;
        }
        tdl::attach_bot(&tx, &next, &key, message)?;
        tx.execute("INSERT INTO collection_telegram_messages(bot_id,chat_id,message_id,item_key,message_json) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(bot_id,chat_id,message_id) DO UPDATE SET message_json=excluded.message_json",
            params![next.bot_id,user,message["message_id"].as_i64(),key,message.to_string()]).map_err(|e|e.to_string())?;
        keys.insert(key);
    }
    for key in keys {
        let messages = tdl::messages_for_key(&tx, &key)?;
        let post = normalize_album(&next, &messages)?;
        let body = serde_json::to_string(&post).map_err(|e| e.to_string())?;
        let digest = format!("{:x}", Sha256::digest(body.as_bytes()));
        let previous: Option<String> = tx
            .query_row(
                "SELECT content_hash FROM collection_x_items WHERE item_key=?1",
                [&key],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if previous.as_deref() == Some(&digest) {
            continue;
        }
        tx.execute("INSERT INTO collection_x_items(item_key,account,post_json,content_hash,collected_at,captured_at) VALUES(?1,?2,?3,?4,?5,?5) ON CONFLICT(item_key) DO UPDATE SET post_json=excluded.post_json,content_hash=excluded.content_hash,captured_at=excluded.captured_at",
            params![key,next.bot_id.to_string(),body,digest,now*1000]).map_err(|e|e.to_string())?;
        if previous.is_none() {
            stats.added += 1;
        } else {
            stats.changed += 1;
        }
    }
    if next.user_id > 0 {
        next.last_success = now;
    }
    if stats.added + stats.changed > 0 {
        let generation = chrono::Utc::now()
            .timestamp_nanos_opt()
            .unwrap_or(now * 1_000_000_000)
            .to_string();
        tx.execute("INSERT INTO metadata(key,value) VALUES('telegram_export_pending',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[generation]).map_err(|e|e.to_string())?;
    }
    save_inbox(&tx, &next)?;
    tx.commit().map_err(|e| e.to_string())?;
    *cfg = next;
    Ok(stats)
}
fn name(user: &Value) -> String {
    let title = user["title"].as_str().unwrap_or("");
    if !title.is_empty() {
        return title.into();
    }
    [
        user["first_name"].as_str().unwrap_or(""),
        user["last_name"].as_str().unwrap_or(""),
    ]
    .into_iter()
    .filter(|s| !s.is_empty())
    .collect::<Vec<_>>()
    .join(" ")
}
fn safe_link(value: &str) -> Option<String> {
    let u = Url::parse(value).ok()?;
    (matches!(u.scheme(), "http" | "https")
        && u.username().is_empty()
        && u.password().is_none()
        && u.host_str().is_some())
    .then(|| value.to_string())
}
fn entity_slice(text: &str, offset: u64, length: u64) -> Option<String> {
    let units = text.encode_utf16().collect::<Vec<_>>();
    let start = usize::try_from(offset).ok()?;
    let end = start.checked_add(usize::try_from(length).ok()?)?;
    String::from_utf16(units.get(start..end)?).ok()
}
fn normalize_album(cfg: &Inbox, messages: &[Value]) -> Result<Post, String> {
    let first = messages.first().ok_or("Telegram 相册为空")?;
    let mut post = normalize_message(cfg, first)?;
    let mut text = vec![];
    let mut media = vec![];
    let mut links = vec![];
    for message in messages {
        let part = normalize_message(cfg, message)?;
        if !part.text.is_empty() && !text.contains(&part.text) {
            text.push(part.text);
        }
        for asset in part.media {
            if !media.iter().any(|m: &Media| m.url == asset.url) {
                media.push(asset);
            }
        }
        for link in part.links {
            if !links.contains(&link) {
                links.push(link);
            }
        }
    }
    post.text = text.join("\n\n");
    post.media = media;
    post.links = links;
    post.all_media = post.media.clone();
    Ok(post)
}
fn normalize_message(cfg: &Inbox, message: &Value) -> Result<Post, String> {
    let id = message["message_id"]
        .as_i64()
        .filter(|id| *id > 0)
        .ok_or("Telegram 消息身份无效")?;
    let date = message["date"]
        .as_i64()
        .and_then(|t| chrono::DateTime::from_timestamp(t, 0))
        .ok_or("Telegram 消息时间无效")?;
    let sender = &message["from"];
    let origin = &message["forward_origin"];
    let original = origin
        .get("sender_user")
        .or_else(|| origin.get("chat"))
        .or_else(|| origin.get("sender_chat"));
    let author = original.unwrap_or(sender);
    let mut post = Post {
        id: id.to_string(),
        source: "telegram".into(),
        published_at: date.to_rfc3339(),
        author_name: origin["sender_user_name"]
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| name(author)),
        author_handle: if !origin.is_null() && original.is_none() {
            String::new()
        } else {
            author["username"].as_str().unwrap_or("").into()
        },
        author_id: author["id"].as_i64().unwrap_or(0).to_string(),
        url: format!("https://t.me/{}", cfg.username),
        content_status: "text".into(),
        thread_format: 2,
        ..Post::default()
    };
    if let Some(original_date) = origin["date"]
        .as_i64()
        .and_then(|t| chrono::DateTime::from_timestamp(t, 0))
    {
        post.published_at = original_date.to_rfc3339();
    }
    if origin["type"] == "channel" {
        if let (Some(handle), Some(original_id)) = (
            origin.pointer("/chat/username").and_then(Value::as_str),
            origin["message_id"].as_i64(),
        ) {
            if handle
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_')
                && original_id > 0
            {
                post.url = format!("https://t.me/{handle}/{original_id}");
            }
        }
    }
    if !origin.is_null() {
        post.origin = Some(Origin {
            name: post.author_name.clone(),
            url: if post.url != format!("https://t.me/{}", cfg.username) {
                post.url.clone()
            } else {
                String::new()
            },
        });
    }
    post.text = message
        .get("text")
        .or_else(|| message.get("caption"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .into();
    for entity in message
        .get("entities")
        .or_else(|| message.get("caption_entities"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let value = if entity["type"] == "text_link" {
            entity["url"].as_str().map(str::to_string)
        } else if entity["type"] == "url" {
            entity_slice(
                &post.text,
                entity["offset"].as_u64().unwrap_or(u64::MAX),
                entity["length"].as_u64().unwrap_or(u64::MAX),
            )
        } else {
            None
        };
        if let Some(link) = value.as_deref().and_then(safe_link) {
            if !post.links.contains(&link) {
                post.links.push(link);
            }
        }
    }
    if let Some(photo) = message["photo"].as_array().and_then(|p| {
        p.iter()
            .max_by_key(|p| p["width"].as_u64().unwrap_or(0) * p["height"].as_u64().unwrap_or(0))
    }) {
        post.media
            .push(asset(cfg.bot_id, photo, "photo", "图片.jpg")?);
    }
    for (field, kind, fallback) in [
        ("video", "video", "视频.mp4"),
        ("animation", "animated_gif", "动画.mp4"),
        ("video_note", "video", "视频消息.mp4"),
        ("audio", "audio", "音频.mp3"),
        ("voice", "audio", "语音.ogg"),
        ("document", "document", "附件.bin"),
        ("sticker", "document", "贴纸.webp"),
    ] {
        if message[field].is_object() {
            post.media
                .push(asset(cfg.bot_id, &message[field], kind, fallback)?);
        }
    }
    if post.text.is_empty() {
        if let Some(contact) = message.get("contact") {
            post.text = format!(
                "{} {}\n{}",
                contact["first_name"].as_str().unwrap_or("联系人"),
                contact["last_name"].as_str().unwrap_or(""),
                contact["phone_number"].as_str().unwrap_or("")
            );
        } else if let Some(location) = message.get("location") {
            post.text = format!("位置：{}, {}", location["latitude"], location["longitude"]);
        } else if let Some(poll) = message.get("poll") {
            post.text = poll["question"].as_str().unwrap_or("投票").into();
        } else if let Some(media) = post.media.first() {
            post.text = asset_name(&media.url);
        } else {
            post.text = "Telegram 消息（此类型暂不支持预览）".into();
        }
    }
    Ok(post)
}
fn asset(bot: i64, value: &Value, kind: &str, fallback: &str) -> Result<Media, String> {
    let id = value["file_id"]
        .as_str()
        .filter(|id| valid_file_id(id))
        .ok_or("Telegram 附件身份无效")?;
    let name = value["file_name"]
        .as_str()
        .filter(|name| !name.is_empty())
        .unwrap_or(fallback);
    let url = asset_address(bot, id, name);
    let thumbnail = value
        .get("thumbnail")
        .and_then(|t| t["file_id"].as_str())
        .filter(|id| valid_file_id(id));
    Ok(Media {
        kind: kind.into(),
        url,
        preview_url: thumbnail
            .map(|id| asset_address(bot, id, "封面.jpg"))
            .unwrap_or_default(),
    })
}
fn valid_file_id(id: &str) -> bool {
    (1..=1024).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn asset_address(bot: i64, file: &str, name: &str) -> String {
    let mut url = Url::parse(&format!("telegram://{bot}")).unwrap();
    url.path_segments_mut().unwrap().push(file).push(name);
    url.to_string()
}
fn asset_name(address: &str) -> String {
    Url::parse(address)
        .ok()
        .and_then(|url| {
            url.path_segments()
                .and_then(|s| s.last())
                .map(str::to_string)
        })
        .map(|s| {
            percent_encoding::percent_decode_str(&s)
                .decode_utf8_lossy()
                .to_string()
        })
        .unwrap_or_else(|| "附件".into())
}
pub(super) fn media_extension(media: &Media) -> String {
    let name = asset_name(&media.url);
    let ext = Path::new(&name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !ext.is_empty() && ext.len() <= 12 && ext.bytes().all(|b| b.is_ascii_alphanumeric()) {
        ext
    } else {
        match media.kind.as_str() {
            "photo" => "jpg",
            "video" | "animated_gif" => "mp4",
            "audio" => "ogg",
            _ => "bin",
        }
        .into()
    }
}
pub(super) async fn download_response(
    app: &AppHandle,
    client: &reqwest::Client,
    address: &str,
    resume: Option<(u64, String)>,
) -> Result<reqwest::Response, String> {
    let url = Url::parse(address).map_err(|_| "Telegram 附件地址无效")?;
    let bot = url
        .host_str()
        .and_then(|s| s.parse::<i64>().ok())
        .ok_or("Telegram 附件缺少机器人身份")?;
    let file = url
        .path_segments()
        .and_then(|mut s| s.next())
        .filter(|id| valid_file_id(id))
        .ok_or("Telegram 附件身份无效")?;
    if url.scheme() != "telegram"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Telegram 附件地址无效".into());
    }
    let c = open_database(&database_path(app)?)?;
    let cfg = inbox(&c)?;
    if cfg.bot_id != bot || !cfg.enabled {
        return Err("该附件的机器人连接已断开，请重新连接后重试".into());
    }
    drop(c);
    let token = stored_secret_get(app, SECRET)?.ok_or("Telegram 连接已断开")?;
    let info = Api::new()?
        .call(&token, "getFile", json!({"file_id":file}))
        .await
        .map_err(|e| e.message)?;
    let path = info["file_path"]
        .as_str()
        .filter(|p| {
            !p.is_empty()
                && p.len() < 2048
                && p.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_./-".contains(&b))
                && p.split('/').all(|s| !s.is_empty() && s != "." && s != "..")
        })
        .ok_or("Telegram 未返回可用的附件路径")?;
    let mut request = client.get(format!("https://api.telegram.org/file/bot{token}/{path}"));
    if let Some((offset, validator)) = resume {
        request = request
            .header("Range", format!("bytes={offset}-"))
            .header("If-Range", validator);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "Telegram 附件下载中断，可稍后重试")?;
    if !response.status().is_success() {
        return Err(format!(
            "Telegram 附件下载失败（HTTP {}）",
            response.status().as_u16()
        ));
    }
    Ok(response)
}
fn queue_export(app: &AppHandle, force: bool) {
    let Ok(guard) = crate::x_bookmarks::SYNC_LOCK.try_lock() else {
        return;
    };
    let pending = (|| -> Result<Option<String>, String> {
        let c = open_database(&database_path(app)?)?;
        let generation = metadata_string(&c, "telegram_export_pending");
        if generation.is_empty() || generation == "0" {
            return Ok(None);
        }
        let retry = metadata_string(&c, "telegram_export_retry")
            .parse::<i64>()
            .unwrap_or(0);
        let paused = metadata_string(&c, "collection_auto_pause_until")
            .parse::<i64>()
            .unwrap_or(0);
        if !force && now_timestamp() < retry.max(paused) {
            return Ok(None);
        }
        Ok(Some(generation))
    })();
    if let Ok(Some(generation)) = pending {
        crate::x_bookmarks::launch_collection_export(app.clone(), generation, guard);
    }
}
pub(super) fn export_finished(app: &AppHandle, generation: &str, succeeded: bool) {
    if let Ok(path) = database_path(app) {
        if let Ok((c, _writer)) = open_write_database(&path) {
            if succeeded {
                // Receiving can continue during an export; never clear a newer batch.
                let _=c.execute("UPDATE metadata SET value='0' WHERE key='telegram_export_pending' AND value=?1",[generation]);
            } else {
                let _=c.execute("INSERT INTO metadata(key,value) VALUES('telegram_export_retry',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[(now_timestamp()+60).to_string()]);
            }
        }
    }
}
pub(super) fn start_scheduler(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        while crate::background_workers::running() {
            if !crate::background_workers::wait(Duration::from_secs(15)).await {
                break;
            }
            queue_export(&app, false);
            let Ok(guard) = LOCK.try_lock() else {
                continue;
            };
            let due = (|| -> Result<bool, String> {
                let c = open_database(&database_path(&app)?)?;
                let cfg = inbox(&c)?;
                let paused = metadata_string(&c, "collection_auto_pause_until")
                    .parse::<i64>()
                    .unwrap_or(0);
                if !cfg.enabled
                    || cfg.blocked
                    || cfg.retry_after.max(paused) > now_timestamp()
                    || stored_secret_get(&app, SECRET)?.is_none()
                {
                    return Ok(false);
                }
                let minutes = crate::x_bookmarks::storage::config(&c)?.auto_sync_minutes;
                let interval = if cfg.user_id == 0 && cfg.pair_expires > now_timestamp() {
                    15
                } else {
                    if minutes == 0 {
                        return Ok(false);
                    }
                    i64::from(minutes) * 60
                };
                Ok(now_timestamp() >= cfg.last_attempt + interval)
            })();
            if due == Ok(true) {
                launch(app.clone(), guard);
            }
        }
    });
}

#[cfg(test)]
mod tests;
