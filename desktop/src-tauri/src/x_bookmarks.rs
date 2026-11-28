//! X's authenticated web GraphQL bookmark reader. Credentials never enter collection rows.
use super::*;
use std::sync::atomic::AtomicBool;
pub(crate) mod dida_reading;
mod jobs;
pub(crate) mod library;
pub(crate) mod local_sources;
pub(super) mod properties;
pub(crate) mod public_web;
mod query;
pub(crate) use query::saved_copies as search_saved_copies;
pub(crate) use query::{evidence_entries, evidence_link_identities, EvidenceEntry};
mod sorting;
pub(super) mod storage;
pub(super) mod threads;
pub(super) use jobs::start_scheduler;
pub(super) fn launch_collection_export(
    app: AppHandle,
    generation: String,
    guard: tokio::sync::MutexGuard<'static, ()>,
) {
    jobs::begin("saving", "telegram");
    tauri::async_runtime::spawn(async move {
        let _guard = guard;
        let result = storage::export(&app, None).await;
        crate::telegram::export_finished(
            &app,
            &generation,
            result.is_ok() && !CANCEL.load(Ordering::Relaxed),
        );
        jobs::finish(&result);
    });
}

const SECRET: &str = "hub-x-bookmarks-request-v1";
#[derive(Clone, Copy, PartialEq)]
enum Source {
    Bookmarks,
    Likes,
}
impl Source {
    fn parse(value: Option<&str>) -> Result<Self, String> {
        match value.unwrap_or("bookmarks") {
            "bookmarks" => Ok(Self::Bookmarks),
            "likes" => Ok(Self::Likes),
            _ => Err("未知的 X 内容来源".into()),
        }
    }
    fn name(self) -> &'static str {
        if self == Self::Likes {
            "likes"
        } else {
            "bookmarks"
        }
    }
    fn key(self, suffix: &str) -> String {
        format!("x_{}_{}", self.name(), suffix)
    }
    fn secret(self) -> &'static str {
        if self == Self::Likes {
            "hub-x-likes-request-v1"
        } else {
            SECRET
        }
    }
}

const MAX_RESPONSE: usize = 12 * 1024 * 1024;
pub(super) static SYNC_LOCK: AsyncMutex<()> = AsyncMutex::const_new(());
static RUNNING: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);

// A copied request can exceed the Windows credential size limit. Commit a new
// generation only after all of its encrypted chunks have been written.
#[derive(Serialize, Deserialize)]
struct SecretIndex {
    generation: String,
    count: usize,
}
fn secret_parts(app: &AppHandle, source: Source) -> Result<Option<SecretIndex>, String> {
    stored_secret_get(app, source.secret())?
        .map(|v| serde_json::from_str(&v).map_err(|_| "连接凭据索引损坏，请重新导入".to_string()))
        .transpose()
}
fn clear_parts(app: &AppHandle, source: Source, index: &SecretIndex) {
    for i in 0..index.count.min(512) {
        stored_secret_delete(
            app,
            &format!("{}:{}:{i}", source.secret(), index.generation),
        );
    }
}
fn save_recipe(app: &AppHandle, source: Source, recipe: &RequestRecipe) -> Result<(), String> {
    let previous = secret_parts(app, source)?;
    let encoded = serde_json::to_string(recipe).map_err(|_| "无法保存连接")?;
    let chunks = crate::oauth_credentials::split_payload(&encoded);
    let index = SecretIndex {
        generation: random_url_safe(12),
        count: chunks.len(),
    };
    for (i, chunk) in chunks.iter().enumerate() {
        if stored_secret_set(
            app,
            &format!("{}:{}:{i}", source.secret(), index.generation),
            chunk,
        )
        .is_err()
        {
            clear_parts(app, source, &index);
            return Err("无法在系统凭据库保存连接，原连接保留".into());
        }
    }
    if stored_secret_set(
        app,
        source.secret(),
        &serde_json::to_string(&index).unwrap(),
    )
    .is_err()
    {
        clear_parts(app, source, &index);
        return Err("无法保存连接索引，原连接保留".into());
    }
    if let Some(previous) = previous {
        clear_parts(app, source, &previous);
    }
    Ok(())
}
fn load_recipe(app: &AppHandle, source: Source) -> Result<RequestRecipe, String> {
    let index = secret_parts(app, source)?.ok_or("请先导入 X 书签请求")?;
    if index.count == 0 || index.count > 512 {
        return Err("连接凭据无效，请重新导入".into());
    }
    let mut encoded = String::new();
    for i in 0..index.count {
        encoded.push_str(
            &stored_secret_get(
                app,
                &format!("{}:{}:{i}", source.secret(), index.generation),
            )?
            .ok_or("连接凭据不完整，请重新导入")?,
        );
    }
    serde_json::from_str(&encoded).map_err(|_| "连接数据无效，请重新导入请求".into())
}

#[derive(Clone, Serialize, Deserialize)]
struct RequestRecipe {
    url: String,
    headers: BTreeMap<String, String>,
    account: String,
}

// Use the existing chunk owner rather than copying machine-bound credential files.
pub(crate) fn migration_read(app: &AppHandle, source: &str) -> Result<Option<String>, String> {
    let source = Source::parse(Some(source))?;
    if secret_parts(app, source)?.is_none() {
        return Ok(None);
    }
    serde_json::to_string(&load_recipe(app, source)?)
        .map(Some)
        .map_err(|_| "无法读取网页登录连接".into())
}
pub(crate) fn migration_write(app: &AppHandle, source: &str, value: &str) -> Result<(), String> {
    let source = Source::parse(Some(source))?;
    let recipe: RequestRecipe = serde_json::from_str(value).map_err(|_| "网页登录连接格式无效")?;
    let url = Url::parse(&recipe.url).map_err(|_| "网页登录连接地址无效")?;
    if url.scheme() != "https"
        || !matches!(url.host_str(), Some("x.com" | "twitter.com"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || !url.path().starts_with("/i/api/graphql/")
    {
        return Err("网页登录连接地址不受支持".into());
    }
    save_recipe(app, source, &recipe)
}
pub(crate) fn migration_remove(app: &AppHandle, source: &str) -> Result<(), String> {
    let source = Source::parse(Some(source))?;
    if let Some(index) = secret_parts(app, source)? {
        stored_secret_delete(app, source.secret());
        if stored_secret_get(app, source.secret())?.is_some() {
            return Err("无法恢复网页登录连接原状态".into());
        }
        clear_parts(app, source, &index);
    }
    Ok(())
}

pub(super) use crate::collection_models::{Item, Media, Post};

pub(super) fn schema(c: &Connection) -> Result<(), String> {
    local_sources::schema(c)?;
    crate::reading_sync::schema(c)?;
    library::schema(c)?;
    dida_reading::schema(c)?;
    c.execute_batch("CREATE TABLE IF NOT EXISTS collection_x_items (
        item_key TEXT PRIMARY KEY, account TEXT NOT NULL, post_json TEXT NOT NULL,
        content_hash TEXT NOT NULL, collected_at INTEGER NOT NULL, captured_at INTEGER NOT NULL,
        read_at INTEGER NOT NULL DEFAULT 0, read_version INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS collection_x_outbox(item_key TEXT PRIMARY KEY,error TEXT NOT NULL DEFAULT '');
        CREATE TABLE IF NOT EXISTS collection_x_properties (item_key TEXT PRIMARY KEY, status TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]');
        CREATE TABLE IF NOT EXISTS collection_property_updates(item_key TEXT PRIMARY KEY,version INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS collection_x_enrichment(item_key TEXT PRIMARY KEY,signature TEXT NOT NULL,checked_at INTEGER NOT NULL,error TEXT NOT NULL DEFAULT '');
        CREATE INDEX IF NOT EXISTS collection_x_order ON collection_x_items(collected_at DESC,item_key);
        ")
        .map_err(|e| format!("无法初始化收集库：{e}"))?;
    crate::local_database_maintenance::ensure_sequences(
        c,
        &["collection_x_outbox", "collection_property_updates"],
    )?;
    dida_reading::migrate_presentation(c)?;
    crate::reading_sync::incremental::install(c)
}

fn meta(c: &Connection, key: &str, value: &str) -> Result<(), String> {
    c.execute("INSERT INTO metadata(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key,value])
        .map(|_| ()).map_err(|e| e.to_string())
}

// Tokenize the supported DevTools 'Copy as cURL (bash)' representation as data.
// No shell, process, expansion, or command execution is involved.
fn curl_words(input: &str) -> Result<Vec<String>, String> {
    if input.len() > 256 * 1024 {
        return Err("请求过大，请只复制书签这一条请求".into());
    }
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        match (quote, ch) {
            (Some('\''), '\'') | (Some('"'), '"') => quote = None,
            (Some('\''), _) => word.push(ch),
            (_, '\\') => {
                let next = chars.next().ok_or("请求中的转义不完整")?;
                if next == '\r' && chars.peek() == Some(&'\n') {
                    chars.next();
                } else if next != '\n' {
                    word.push(next);
                }
            }
            (None, '\'' | '"') => quote = Some(ch),
            (None, c) if c.is_whitespace() => {
                if !word.is_empty() {
                    words.push(std::mem::take(&mut word));
                }
            }
            _ => word.push(ch),
        }
    }
    if quote.is_some() {
        return Err("请求引号不完整，请使用 Copy as cURL (bash)".into());
    }
    if !word.is_empty() {
        words.push(word);
    }
    Ok(words)
}

fn parse_recipe(input: &str) -> Result<RequestRecipe, String> {
    let words = curl_words(input.trim())?;
    if !matches!(words.first().map(String::as_str), Some("curl" | "curl.exe")) {
        return Err("请粘贴开发者工具 Copy as cURL (bash) 复制的完整请求".into());
    }
    let mut address = None;
    let mut headers = BTreeMap::new();
    let mut index = 1;
    while index < words.len() {
        let part = &words[index];
        if part.starts_with("https://") || part == "--url" || part.starts_with("--url=") {
            let value = if part == "--url" {
                index += 1;
                words.get(index).ok_or("请求缺少 URL 参数")?.clone()
            } else if let Some(value) = part.strip_prefix("--url=") {
                value.to_string()
            } else {
                part.clone()
            };
            if address.is_some() {
                return Err("请只复制一条书签请求".into());
            }
            address = Some(value);
        } else if matches!(
            part.as_str(),
            "-H" | "--header" | "-b" | "--cookie" | "-X" | "--request"
        ) {
            index += 1;
            let value = words.get(index).ok_or("请求参数不完整")?;
            if matches!(part.as_str(), "-X" | "--request") {
                if value != "GET" {
                    return Err("仅接受读取书签的 GET 请求".into());
                }
            } else if matches!(part.as_str(), "-b" | "--cookie") {
                headers.insert("cookie".into(), value.clone());
            } else if let Some((name, value)) = value.split_once(':') {
                let name = name.trim().to_ascii_lowercase();
                if matches!(
                    name.as_str(),
                    "cookie"
                        | "authorization"
                        | "x-csrf-token"
                        | "x-twitter-auth-type"
                        | "x-twitter-active-user"
                        | "x-twitter-client-language"
                        | "x-client-transaction-id"
                        | "user-agent"
                ) {
                    headers.insert(name, value.trim().to_string());
                }
            }
        } else if !matches!(
            part.as_str(),
            "--compressed" | "--http1.1" | "--http2" | "--globoff" | "-g" | "--silent" | "-s"
        ) {
            return Err(
                "请求格式不支持，请重新选择 Copy as cURL (bash)，不要修改复制的内容".into(),
            );
        }
        index += 1;
    }
    let mut url = Url::parse(&address.ok_or("未找到请求地址")?).map_err(|_| "请求地址无效")?;
    if url.scheme() != "https"
        || !matches!(url.host_str(), Some("x.com" | "twitter.com"))
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || !url.path().starts_with("/i/api/graphql/")
        || url.path().split('/').count() != 6
        || !matches!(
            url.path().rsplit('/').next(),
            Some("Bookmarks" | "BookmarksTimeline" | "Likes")
        )
    {
        return Err(
            "请选择返回帖子列表的 Bookmarks 或 Likes 请求，不要选择 ViewerBadgeCounts".into(),
        );
    }
    let mut query: BTreeMap<String, String> = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    let mut variables: Value =
        serde_json::from_str(query.get("variables").ok_or("请求缺少 variables")?)
            .map_err(|_| "variables 格式无效")?;
    let object = variables.as_object_mut().ok_or("variables 必须是对象")?;
    object.remove("cursor");
    object.insert("count".into(), json!(40));
    query.insert("variables".into(), variables.to_string());
    // Only retain GraphQL parameters, never unrelated query credentials or URLs.
    query.retain(|key, _| matches!(key.as_str(), "variables" | "features" | "fieldToggles"));
    url.set_query(None);
    url.set_fragment(None);
    url.query_pairs_mut().extend_pairs(query.iter());
    let cookies = headers
        .get("cookie")
        .ok_or("请求缺少 Cookie，请在已登录的书签页重新复制")?;
    let cookies: BTreeMap<_, _> = cookies
        .split(';')
        .filter_map(|part| part.trim().split_once('='))
        .filter(|(key, _)| matches!(*key, "auth_token" | "ct0" | "twid"))
        .map(|(k, v)| (k.to_string(), v.trim_matches('"').to_string()))
        .collect();
    if ["auth_token", "ct0"]
        .iter()
        .any(|k| cookies.get(*k).is_none_or(String::is_empty))
    {
        return Err("缺少登录 Cookie，请重新登录 X 后复制请求".into());
    }
    if headers.get("x-csrf-token") != cookies.get("ct0") {
        return Err("CSRF 请求头与 Cookie 不匹配，请重新复制完整请求".into());
    }
    if !headers
        .get("authorization")
        .is_some_and(|v| v.starts_with("Bearer "))
    {
        return Err("请求缺少 Authorization".into());
    }
    let twid = percent_encoding::percent_decode_str(
        cookies
            .get("twid")
            .ok_or("请求缺少 twid，无法确认收藏账号")?,
    )
    .decode_utf8()
    .map_err(|_| "账号标识无效")?
    .into_owned();
    let account = twid
        .strip_prefix("u=")
        .filter(|v| !v.is_empty() && v.len() <= 30 && v.bytes().all(|b| b.is_ascii_digit()))
        .ok_or("账号标识无效")?
        .to_string();
    if url.path().ends_with("/Likes") && variables["userId"].as_str() != Some(account.as_str()) {
        return Err("点赞请求必须属于当前登录账号，请在自己的个人主页重新复制 Likes 请求".into());
    }
    Ok(RequestRecipe {
        url: url.into(),
        headers,
        account,
    })
}

fn string(v: &Value, pointer: &str) -> String {
    v.pointer(pointer)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}
fn safe_url(value: &str) -> Option<String> {
    let u = Url::parse(value).ok()?;
    (matches!(u.scheme(), "https" | "http")
        && u.host_str().is_some()
        && u.username().is_empty()
        && u.password().is_none())
    .then(|| u.to_string())
}

// X includes attachment placeholders in full_text but hides them in its reading UI.
// Remove only exact media entities, never arbitrary t.co links or genuine external URLs.
fn readable_post_text(result: &Value) -> String {
    let result = result.get("tweet").unwrap_or(result);
    let note = string(result, "/note_tweet/note_tweet_results/result/text");
    let mut text = if note.is_empty() {
        string(result, "/legacy/full_text")
    } else {
        note
    };
    let external: Vec<String> = [
        "/legacy/entities/urls",
        "/note_tweet/note_tweet_results/result/entity_set/urls",
    ]
    .iter()
    .filter_map(|path| result.pointer(path).and_then(Value::as_array))
    .flatten()
    .map(|entity| string(entity, "/url"))
    .collect();
    for path in ["/legacy/extended_entities/media", "/legacy/entities/media"] {
        if let Some(media) = result.pointer(path).and_then(Value::as_array) {
            for entity in media {
                let url = string(entity, "/url");
                if !url.starts_with("https://t.co/") || external.contains(&url) {
                    continue;
                }
                text = text
                    .split_inclusive(char::is_whitespace)
                    .map(|token| {
                        if token.trim_end() == url {
                            token.trim_start_matches(url.as_str()).to_string()
                        } else {
                            token.to_string()
                        }
                    })
                    .collect();
            }
        }
    }
    text.lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn parse_post(result: &Value) -> Option<Post> {
    parse_post_depth(result, 0)
}
fn parse_post_depth(result: &Value, depth: usize) -> Option<Post> {
    let result = result.get("tweet").unwrap_or(result);
    let id = string(result, "/rest_id");
    let legacy = result.get("legacy")?;
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let user = result
        .pointer("/core/user_results/result")
        .unwrap_or(&Value::Null);
    let author_handle = string(user, "/legacy/screen_name");
    let author_handle = if author_handle.is_empty() {
        string(user, "/core/screen_name")
    } else {
        author_handle
    };
    let mut author_name = string(user, "/legacy/name");
    if author_name.is_empty() {
        author_name = string(user, "/core/name");
    }
    let text = readable_post_text(result);
    let mut media = Vec::new();
    if let Some(values) = legacy
        .pointer("/extended_entities/media")
        .and_then(Value::as_array)
    {
        for m in values.iter().take(20) {
            let kind = string(m, "/type");
            let preview = safe_url(&string(m, "/media_url_https")).unwrap_or_default();
            let mut url = preview.clone();
            if kind != "photo" {
                url = m
                    .pointer("/video_info/variants")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter(|v| v["content_type"] == "video/mp4")
                    .max_by_key(|v| v["bitrate"].as_u64().unwrap_or(0))
                    .and_then(|v| v["url"].as_str())
                    .and_then(safe_url)
                    .unwrap_or_default();
            }
            media.push(Media {
                kind,
                url,
                preview_url: preview,
            });
        }
    }
    let mut links = Vec::new();
    for entities in [
        legacy.pointer("/entities/urls"),
        result.pointer("/note_tweet/note_tweet_results/result/entity_set/urls"),
    ] {
        if let Some(values) = entities.and_then(Value::as_array) {
            for value in values {
                if let Some(url) = safe_url(&string(value, "/expanded_url")) {
                    if !links.contains(&url) {
                        links.push(url);
                    }
                }
            }
        }
    }
    let quote = result
        .pointer("/quoted_status_result/result")
        .map(|v| v.get("tweet").unwrap_or(v));
    let quoted_text = quote.map(readable_post_text).unwrap_or_default();
    let quote = if depth < 4 {
        quote
            .and_then(|value| parse_post_depth(value, depth + 1))
            .map(Box::new)
    } else {
        None
    };
    let incomplete = (legacy["truncated"].as_bool().unwrap_or(false)
        && result
            .pointer("/note_tweet/note_tweet_results/result/text")
            .and_then(Value::as_str)
            .is_none())
        || result.get("article").is_some_and(|v| !v.is_null());
    let mut post = Post {
        url: format!("https://x.com/i/status/{id}"),
        id,
        text,
        author_name,
        author_handle,
        published_at: string(legacy, "/created_at"),
        media,
        links,
        quoted_text,
        content_status: if incomplete { "partial" } else { "text" }.into(),
        liked: legacy["favorited"].as_bool().unwrap_or(false),
        source: "bookmarks".into(),
        author_id: {
            let id = string(user, "/rest_id");
            if id.is_empty() {
                string(legacy, "/user_id_str")
            } else {
                id
            }
        },
        conversation_id: string(legacy, "/conversation_id_str"),
        reply_to_id: string(legacy, "/in_reply_to_status_id_str"),
        reply_to_handle: string(legacy, "/in_reply_to_screen_name"),
        reply_count: legacy["reply_count"].as_u64().unwrap_or(0),
        quote_id: string(legacy, "/quoted_status_id_str"),
        quote,
        thread: vec![],
        all_media: vec![],
        thread_status: String::new(),
        thread_cursors: vec![],
        thread_seen_cursors: vec![],
        thread_format: 0,
        thread_error: String::new(),
        origin: None,
    };
    if post.quote_id.is_empty() {
        post.quote_id = post
            .quote
            .as_ref()
            .map(|quote| quote.id.clone())
            .unwrap_or_default();
    }
    post.all_media = threads::collect_media(&post);
    Some(post)
}

struct Page {
    posts: Vec<Post>,
    cursor: Option<String>,
    unavailable: usize,
    ended: bool,
    cursor_only: bool,
}
fn parse_page(value: &Value) -> Result<Page, String> {
    if value
        .get("errors")
        .and_then(Value::as_array)
        .is_some_and(|v| !v.is_empty())
    {
        return Err("X 返回接口错误；请在浏览器确认登录与书签可访问，再更新请求".into());
    }
    let instructions = [
        "/data/bookmark_timeline_v2/timeline/instructions",
        "/data/bookmark_timeline/timeline/instructions",
        "/data/user/result/timeline_v2/timeline/instructions",
        "/data/user/result/timeline/timeline/instructions",
    ]
    .into_iter()
    .find_map(|path| value.pointer(path).and_then(Value::as_array))
    .ok_or("X 书签响应结构已变化；未将异常响应当作空书签，请更新请求或适配器")?;
    let mut page = Page {
        posts: vec![],
        cursor: None,
        unavailable: 0,
        ended: false,
        cursor_only: false,
    };
    let mut entries = Vec::new();
    let mut recognized = instructions.is_empty();
    for instruction in instructions {
        if matches!(
            instruction["type"].as_str(),
            Some("TimelineAddEntries" | "TimelineReplaceEntry" | "TimelineTerminateTimeline")
        ) {
            recognized = true;
        }
        if instruction["type"] == "TimelineTerminateTimeline"
            && instruction["direction"] == "Bottom"
        {
            page.ended = true;
        }
        if let Some(values) = instruction["entries"].as_array() {
            entries.extend(values.iter());
        }
        if let Some(entry) = instruction.get("entry") {
            entries.push(entry);
        }
    }
    if !recognized {
        return Err("X 返回未知书签指令，未将其当作空书签".into());
    }
    page.cursor_only = !entries.is_empty()
        && entries.iter().all(|entry| {
            matches!(
                entry["content"]["cursorType"].as_str(),
                Some("Top" | "Bottom")
            )
        });
    let mut ids = HashSet::new();
    for entry in entries {
        let content = &entry["content"];
        if content["cursorType"] == "Bottom" {
            page.cursor = content["value"]
                .as_str()
                .filter(|v| !v.is_empty())
                .map(str::to_string);
            continue;
        }
        let mut items = vec![content];
        if let Some(children) = content["items"].as_array() {
            items = children.iter().map(|v| &v["item"]).collect();
        }
        for item in items {
            if let Some(result) = item.pointer("/itemContent/tweet_results/result") {
                if let Some(post) = parse_post(result) {
                    if ids.insert(post.id.clone()) {
                        page.posts.push(post);
                    }
                } else {
                    page.unavailable += 1;
                }
            }
        }
    }
    Ok(page)
}

fn validate_page_progress(
    page: &mut Page,
    current: &str,
    visited: &HashSet<String>,
) -> Result<(), String> {
    if page.ended {
        return Ok(());
    }
    // The live Bookmarks endpoint terminates with an empty cursor-only page
    // whose bottom cursor equals the requested cursor. Non-empty repeats and
    // multi-cursor cycles remain failures, never evidence of completeness.
    if !current.is_empty()
        && page.cursor_only
        && page.posts.is_empty()
        && page.unavailable == 0
        && page.cursor.as_deref() == Some(current)
    {
        page.ended = true;
        return Ok(());
    }
    if page
        .cursor
        .as_ref()
        .is_some_and(|next| visited.contains(next))
    {
        return Err("X 分页游标未推进，已暂停；不会将部分结果标为全部同步完成".into());
    }
    Ok(())
}

#[cfg(test)]
fn persist_page(
    c: &mut Connection,
    account: &str,
    page: &Page,
    captured: i64,
) -> Result<usize, String> {
    persist_source_page(c, account, page, captured, Source::Bookmarks)
}
fn persist_source_page(
    c: &mut Connection,
    account: &str,
    page: &Page,
    captured: i64,
    source: Source,
) -> Result<usize, String> {
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let mut added = 0;
    for post in &page.posts {
        let key = if source == Source::Likes {
            format!("x-likes:{account}:{}", post.id)
        } else {
            format!("x:{account}:{}", post.id)
        };
        // Local originals and a later authenticated fetch share one reading identity.
        // Intake ownership also covers tombstones, so a source refresh cannot resurrect it.
        let local: Option<String> = tx.query_row("SELECT f.item_key FROM collection_local_source_files f JOIN collection_local_source_items s ON s.item_key=f.item_key WHERE f.identity=?1 AND ?2<>'' ORDER BY f.checked_at,f.item_key LIMIT 1",params![format!("x:{}:{}",source.name(),post.id),source.name()],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        if local.is_some() {
            continue;
        }
        if library::blocked(&tx, &key)? {
            continue;
        }
        let mut post = post.clone();
        if post.thread_status != "complete" && post.thread.is_empty() {
            let previous: Option<String> = tx
                .query_row(
                    "SELECT post_json FROM collection_x_items WHERE item_key=?1",
                    [&key],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if let Some(previous) = previous.and_then(|raw| serde_json::from_str::<Post>(&raw).ok())
            {
                if post.quote.is_none()
                    && !post.quote_id.is_empty()
                    && post.quote_id == previous.quote_id
                {
                    post.quote = previous.quote;
                    post.quoted_text = previous.quoted_text;
                }
                post.thread = previous.thread;
                post.thread_cursors = previous.thread_cursors;
                post.thread_seen_cursors = previous.thread_seen_cursors;
                post.thread_format = previous.thread_format;
                post.thread_error = previous.thread_error;
                if post.thread_status.is_empty() {
                    post.thread_status = previous.thread_status;
                }
            }
        }
        post.all_media = threads::collect_media(&post);
        post.source = source.name().into();
        if source == Source::Likes {
            post.liked = true;
        }
        let body = serde_json::to_string(&post).map_err(|e| e.to_string())?;
        let hash = format!("{:x}", Sha256::digest(body.as_bytes()));
        added += tx.execute("INSERT OR IGNORE INTO collection_x_items(item_key,account,post_json,content_hash,collected_at,captured_at) VALUES(?1,?2,?3,?4,?5,?5)", params![key,account,body,hash,captured]).map_err(|e| e.to_string())?;
        // Reimports preserve reading state and the original collection time.
        tx.execute("UPDATE collection_x_items SET post_json=?2,content_hash=?3,captured_at=?4 WHERE item_key=?1 AND content_hash<>?3",params![key,body,hash,captured]).map_err(|e| e.to_string())?;
    }
    meta(
        &tx,
        &source.key("cursor"),
        if page.ended {
            ""
        } else {
            page.cursor.as_deref().unwrap_or("")
        },
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(added)
}

#[tauri::command]
pub(super) async fn save_x_bookmark_connection(
    app: AppHandle,
    request: String,
    source: Option<String>,
) -> Result<(), String> {
    let _guard = SYNC_LOCK.try_lock().map_err(|_| "请先停止当前同步")?;
    let source = Source::parse(source.as_deref())?;
    let recipe = parse_recipe(&request)?;
    if recipe
        .url
        .split('?')
        .next()
        .unwrap_or("")
        .ends_with("/Likes")
        != (source == Source::Likes)
    {
        return Err("请求与所选来源不一致，请切换书签 / 喜欢后重新导入".into());
    }
    save_recipe(&app, source, &recipe)?;
    let (c, _writer) = open_write_database(&database_path(&app)?)?;
    schema(&c)?;
    let same_account = metadata_string(&c, &source.key("account")) == recipe.account;
    meta(&c, &source.key("account"), &recipe.account)?;
    meta(&c, &source.key("auto_blocked"), "0")?;
    meta(
        &c,
        &source.key("last_attempt"),
        &now_timestamp().to_string(),
    )?;
    if !same_account {
        meta(&c, &source.key("cursor"), "")?;
    }
    meta(
        &c,
        &source.key("status"),
        "连接已保存，点击同步验证并导入书签",
    )?;
    Ok(())
}

#[tauri::command]
pub(super) async fn disconnect_x_bookmarks(
    app: AppHandle,
    source: Option<String>,
) -> Result<(), String> {
    let _guard = SYNC_LOCK.try_lock().map_err(|_| "请先停止当前同步")?;
    let source = Source::parse(source.as_deref())?;
    let previous = secret_parts(&app, source)?;
    stored_secret_delete(&app, source.secret());
    if stored_secret_get(&app, source.secret())?.is_some() {
        return Err("无法移除系统中保存的连接，请重试".into());
    }
    if let Some(previous) = previous {
        clear_parts(&app, source, &previous);
    }
    let (c, _writer) = open_write_database(&database_path(&app)?)?;
    meta(&c, &source.key("account"), "")?;
    meta(&c, &source.key("cursor"), "")?;
    meta(&c, &source.key("status"), "已断开连接，本地收藏保留")
}

#[tauri::command]
pub(super) fn cancel_x_bookmark_sync(app: AppHandle) {
    CANCEL.store(true, Ordering::Relaxed);
    crate::telegram::cancel();
    jobs::update(|p| p.message = "正在暂停，已完成的内容会保留".into());
    if let Ok(path) = database_path(&app) {
        if let Ok((c, _writer)) = open_write_database(&path) {
            let minutes = storage::config(&c)
                .map(|cfg| cfg.auto_sync_minutes)
                .unwrap_or(30);
            let _ = meta(
                &c,
                "collection_auto_pause_until",
                &(now_timestamp() + i64::from(minutes) * 60).to_string(),
            );
        }
    }
}

fn report(app: &AppHandle, source: Source, message: &str) -> Result<(), String> {
    let (c, _writer) = open_write_database(&database_path(app)?)?;
    meta(&c, &source.key("status"), message)?;
    jobs::update(|p| {
        p.phase = "fetching".into();
        p.message = message.into();
    });
    let _ = app.emit("collections-updated", json!({"message":message}));
    Ok(())
}

async fn run_sync(app: &AppHandle, restart: bool, source: Source) -> Result<String, String> {
    let recipe = load_recipe(app, source)?;
    let (mut cursor, batch_time) = {
        let (c, _writer) = open_write_database(&database_path(app)?)?;
        schema(&c)?;
        let retry = metadata_string(&c, &source.key("retry_after"))
            .parse::<i64>()
            .unwrap_or(0);
        if retry > now_timestamp() {
            return Err(format!(
                "X 正在限流，请约 {} 分钟后重试",
                (retry - now_timestamp() + 59) / 60
            ));
        }
        let cursor = if restart {
            String::new()
        } else {
            metadata_string(&c, &source.key("cursor"))
        };
        let previous_time = metadata_string(&c, &source.key("batch_time"))
            .parse::<i64>()
            .unwrap_or(0);
        let batch_time = if cursor.is_empty() || previous_time == 0 {
            chrono::Utc::now().timestamp_millis()
        } else {
            previous_time
        };
        if restart {
            meta(&c, &source.key("cursor"), "")?;
        }
        meta(&c, &source.key("batch_time"), &batch_time.to_string())?;
        (cursor, batch_time)
    };
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|_| "无法初始化 X 连接")?;
    let mut visited = HashSet::new();
    let mut received = 0;
    let mut added = 0;
    let mut unavailable = 0;
    let mut enrichment = threads::Enricher::default();
    for page_number in 1..=100 {
        if CANCEL.load(Ordering::Relaxed) {
            return Ok(format!(
                "已暂停，已接收 {received} 条，新增 {added} 条；下次可继续"
            ));
        }
        if !visited.insert(cursor.clone()) {
            return Err("X 返回重复分页游标，已停止；已保存的收藏不受影响".into());
        }
        let mut url = Url::parse(&recipe.url).map_err(|_| "书签请求地址无效")?;
        let mut query: BTreeMap<String, String> = url
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        let mut variables: Value =
            serde_json::from_str(query.get("variables").ok_or("缺少分页参数")?)
                .map_err(|_| "分页参数无效")?;
        if !cursor.is_empty() {
            variables["cursor"] = json!(cursor);
        }
        query.insert("variables".into(), variables.to_string());
        url.set_query(None);
        url.query_pairs_mut().extend_pairs(query.iter());
        let mut request = client
            .get(url)
            .header("accept", "application/json")
            .header("referer", "https://x.com/i/bookmarks");
        for (key, value) in &recipe.headers {
            request = request.header(key, value);
        }
        report(
            app,
            source,
            &format!("正在读取第 {page_number} 页 · 已接收 {received} 条 · 新增 {added} 条"),
        )?;
        let mut response = request
            .send()
            .await
            .map_err(|_| "无法连接 X；请检查网络或系统代理，已保存分页位置")?;
        match response.status().as_u16() {
            401 | 403 => {
                let (c, _writer) = open_write_database(&database_path(app)?)?;
                meta(&c, &source.key("auto_blocked"), "1")?;
                return Err("X 登录失效或要求验证，请在默认浏览器打开书签页并更新请求".into());
            }
            429 => {
                let delay = response
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<i64>().ok())
                    .unwrap_or(900)
                    .max(60);
                let reset = response
                    .headers()
                    .get("x-rate-limit-reset")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<i64>().ok())
                    .unwrap_or(0);
                let (c, _writer) = open_write_database(&database_path(app)?)?;
                meta(
                    &c,
                    &source.key("retry_after"),
                    &(now_timestamp().saturating_add(delay).max(reset)).to_string(),
                )?;
                return Err("X 请求次数已达上限，已暂停并保留进度；稍后继续".into());
            }
            200 => {}
            status => {
                return Err(format!(
                    "X 返回 HTTP {status}；请更新书签请求后重试，已保存数据保留"
                ))
            }
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "X 响应中断，重试将从未完成页继续")?
        {
            if bytes.len() + chunk.len() > MAX_RESPONSE {
                return Err("X 单页响应超过安全大小，已暂停".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| "X 未返回有效 JSON，可能需要重新登录或完成验证")?;
        let mut page = parse_page(&value)?;
        validate_page_progress(&mut page, &cursor, &visited)?;
        threads::enrich_page(app, &recipe, &client, &mut page, source, &mut enrichment).await;
        {
            let (mut c, _writer) = open_write_database(&database_path(app)?)?;
            added += persist_source_page(&mut c, &recipe.account, &page, batch_time, source)?;
        }
        received += page.posts.len();
        unavailable += page.unavailable;
        if page.ended || page.cursor.is_none() {
            if !page.ended && !page.posts.is_empty() {
                return Ok(format!(
                    "已保存 {received} 条，新增 {added} 条；响应没有下一页游标，完整性待确认"
                ));
            }
            return Ok(format!(
                "本轮读取结束 · 接收 {received} 条 · 新增 {added} 条 · 不可用 {unavailable} 条{}",
                enrichment.summary()
            ));
        }
        cursor = page.cursor.unwrap_or_default();
        for _ in 0..15 {
            if CANCEL.load(Ordering::Relaxed) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    Ok(format!(
        "已保存 {received} 条，新增 {added} 条；本轮达到 100 页，点击继续同步读取后续书签"
    ))
}

#[tauri::command]
pub(super) async fn sync_x_bookmarks(
    app: AppHandle,
    restart: bool,
    source: Option<String>,
) -> Result<String, String> {
    if source.as_deref() == Some("dida") {
        return if dida_reading::launch_if_connected(app)? {
            Ok("已开始后台同步滴答稍后读，复用资料库授权".into())
        } else {
            Err("请先连接滴答清单资料库".into())
        };
    }
    let dida_started = if source.as_deref() == Some("all") {
        dida_reading::launch_if_connected(app.clone())?
    } else {
        false
    };
    if source.as_deref() == Some("telegram") {
        return crate::telegram::sync_telegram(app).await;
    }
    if source.as_deref() == Some("all")
        && stored_secret_get(&app, Source::Bookmarks.secret())?.is_none()
        && stored_secret_get(&app, Source::Likes.secret())?.is_none()
    {
        if dida_started {
            crate::telegram::launch_if_connected(app);
            return Ok("已开始后台同步已连接的来源".into());
        }
        return crate::telegram::sync_telegram(app).await;
    }
    let _guard = SYNC_LOCK.try_lock().map_err(|_| "X 书签正在同步")?;
    if source.as_deref() == Some("all") {
        crate::telegram::launch_if_connected(app.clone());
        jobs::launch_all(app, _guard);
        return Ok("已开始同步已连接的来源".into());
    }
    let source = Source::parse(source.as_deref())?;
    jobs::launch_sync(app, source, restart, _guard);
    Ok("已开始后台同步".into())
}
async fn complete_sync(app: &AppHandle, source: Source, restart: bool) -> Result<String, String> {
    {
        let (c, _writer) = open_write_database(&database_path(app)?)?;
        meta(
            &c,
            &source.key("last_attempt"),
            &now_timestamp().to_string(),
        )?;
    }
    let cancellations = properties::flush(app, source).await;
    let outcome = run_sync(app, restart, source).await;
    // Export committed pages even if a later network page failed; pause stops media too.
    let export_result = if !CANCEL.load(Ordering::Relaxed) {
        storage::export(app, None).await
    } else {
        Ok("已暂停".into())
    };
    let outcome = match (outcome, export_result) {
        (Ok(message), Ok(saved)) => Ok(format!("{message} · {saved}")),
        (Ok(message), Err(error)) => Err(format!("{message} · 本地保存待重试：{error}")),
        (Err(error), _) => Err(error),
    };

    let outcome = match (outcome, cancellations) {
        (Ok(message), Ok(cancel)) => Ok(if cancel.is_empty() {
            message
        } else {
            format!("{message} · {cancel}")
        }),
        (Ok(message), Err(error)) => Err(format!("{message} · {error}")),
        (Err(error), Ok(_)) => Err(error),
        (Err(error), Err(cancel)) => Err(format!("{error} · {cancel}")),
    };
    let message = outcome
        .as_ref()
        .map(String::as_str)
        .unwrap_or_else(|e| e.as_str());
    {
        let (c, _writer) = open_write_database(&database_path(app)?)?;
        meta(&c, &source.key("status"), message)?;
        meta(
            &c,
            &source.key("last_attempt"),
            &now_timestamp().to_string(),
        )?;
        if outcome.is_ok() && !CANCEL.load(Ordering::Relaxed) {
            meta(
                &c,
                &source.key("last_success"),
                &now_timestamp().to_string(),
            )?;
        }
    }
    outcome
}

pub(super) fn query_collection_items(
    c: &Connection,
    query: String,
    unread_only: bool,
    offset: u32,
    source: Option<String>,
    status: Option<String>,
    media: Option<String>,
    sort: Option<String>,
    ascending: Option<bool>,
    sorts: Option<Vec<sorting::Rule>>,
) -> Result<(i64, i64, i64, Vec<Value>), String> {
    query::items(
        c,
        query,
        unread_only,
        offset,
        source,
        status,
        media,
        sort,
        ascending,
        sorts,
        query::Filters::default(),
    )
}

#[tauri::command]
pub(super) async fn list_collection_items(
    app: AppHandle,
    query: String,
    unread_only: bool,
    offset: u32,
    source: Option<String>,
    status: Option<String>,
    media: Option<String>,
    sort: Option<String>,
    ascending: Option<bool>,
    sorts: Option<Vec<sorting::Rule>>,
    filters: Option<query::Filters>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        list_collection_items_blocking(
            app,
            query,
            unread_only,
            offset,
            source,
            status,
            media,
            sort,
            ascending,
            sorts,
            filters,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
pub(super) fn list_collection_items_blocking(
    app: AppHandle,
    query: String,
    unread_only: bool,
    offset: u32,
    source: Option<String>,
    status: Option<String>,
    media: Option<String>,
    sort: Option<String>,
    ascending: Option<bool>,
    sorts: Option<Vec<sorting::Rule>>,
    filters: Option<query::Filters>,
) -> Result<Value, String> {
    let c = open_database(&database_path(&app)?)?;
    let filters = filters.unwrap_or_default();
    let compact = filters.compact;
    if compact {
        query::ensure_list_index(&c)?;
    }
    let _snapshot = c.unchecked_transaction().map_err(|e| e.to_string())?;
    let (total, unread, matched, items) = query::items(
        &c,
        query,
        unread_only,
        offset,
        source.clone(),
        status,
        media,
        sort,
        ascending,
        sorts,
        filters,
    )?;
    if compact {
        return Ok(json!({"items":items,"total":total,"unread":unread,"matched":matched}));
    }
    let mut overview = collection_overview(&app, &c, source)?;
    overview["items"] = json!(items);
    overview["total"] = json!(total);
    overview["unread"] = json!(unread);
    overview["matched"] = json!(matched);
    Ok(overview)
}

#[tauri::command]
pub(super) async fn reading_collection_overview(
    app: AppHandle,
    source: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let c = open_database(&database_path(&app)?)?;
        let _snapshot = c.unchecked_transaction().map_err(|e| e.to_string())?;
        collection_overview(&app, &c, source)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(super) async fn reading_collection_post(app: AppHandle, key: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let c = open_database(&database_path(&app)?)?;
        let raw: String = c
            .query_row(
                "SELECT post_json FROM collection_x_items WHERE item_key=?1",
                [key],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        serde_json::from_str(&raw).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn collection_overview(
    app: &AppHandle,
    c: &Connection,
    source: Option<String>,
) -> Result<Value, String> {
    let selected_source = source.clone().unwrap_or_else(|| "bookmarks".into());
    let mut sources = Vec::new();
    let interval = storage::config(&c)?.auto_sync_minutes;
    let counts = query::source_counts(&c)?;
    for source in [Source::Bookmarks, Source::Likes] {
        let count = counts.get(source.name()).copied().unwrap_or(0);
        let last: i64 = metadata_string(&c, &source.key("last_attempt"))
            .parse()
            .unwrap_or(0);
        let next = if interval == 0 || last == 0 {
            None
        } else {
            Some(
                (last + i64::from(interval) * 60)
                    .max(
                        metadata_string(&c, &source.key("retry_after"))
                            .parse()
                            .unwrap_or(0),
                    )
                    .max(
                        metadata_string(&c, "collection_auto_pause_until")
                            .parse()
                            .unwrap_or(0),
                    ),
            )
        };
        sources.push(json!({"id":source.name(),"count":count,"connected":stored_secret_get(&app,source.secret())?.is_some(),
            "canResume":!metadata_string(&c,&source.key("cursor")).is_empty(),"status":metadata_string(&c,&source.key("status")),
            "lastSuccess":metadata_string(&c,&source.key("last_success")).parse::<i64>().unwrap_or(0),"nextSyncAt":next,
            "autoBlocked":metadata_string(&c,&source.key("auto_blocked"))=="1"}));
    }
    sources.push(crate::telegram::source_state(
        &app,
        &c,
        interval,
        counts.get("telegram").copied().unwrap_or(0),
    )?);
    sources.push(dida_reading::source_state(
        &app,
        &c,
        counts.get("dida").copied().unwrap_or(0),
    )?);
    let selected = sources
        .iter()
        .find(|s| s["id"] == selected_source)
        .cloned()
        .unwrap_or_else(|| sources[0].clone());
    let archived:i64=c.query_row("SELECT count(*) FROM collection_x_items i JOIN collection_lifecycle l ON l.item_key=i.item_key WHERE l.state='archived'",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    let pending_cancellations: i64 = c
        .query_row("SELECT count(*) FROM collection_x_outbox", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let mut tags = std::collections::BTreeSet::new();
    let mut statement = c
        .prepare("SELECT tags FROM collection_x_properties")
        .map_err(|e| e.to_string())?;
    for row in statement
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
    {
        if let Ok(raw) = row {
            if let Ok(values) = serde_json::from_str::<Vec<String>>(&raw) {
                tags.extend(values);
            }
        }
    }
    let navigation_counts = query::navigation_counts(&c, source.as_deref())?;
    Ok(
        json!({"navigationCounts":navigation_counts,"archived":archived,"pendingCancellations":pending_cancellations,"availableTags":tags,"sources":sources,"connected":selected["connected"],"running":RUNNING.load(Ordering::Relaxed),
        "canResume":selected["canResume"],
        "status":selected["status"]}),
    )
}

#[tauri::command]
pub(super) async fn set_collection_read(
    app: AppHandle,
    key: String,
    read: bool,
) -> Result<String, String> {
    let tags = {
        let (c, _writer) = open_write_database(&database_path(&app)?)?;
        schema(&c)?;
        properties::load(&c, &key, !read)?.1
    };
    properties::set_collection_properties(
        app,
        key,
        if read { "read" } else { "unread" }.into(),
        tags.clone(),
        None,
        Some(tags),
    )
    .await
}

#[cfg(test)]
mod tests;

#[cfg(test)]
pub(crate) fn reading_sync_test_import(c: &mut Connection, post: Post) {
    storage::schema(c).unwrap();
    persist_source_page(
        c,
        "test-account",
        &Page {
            posts: vec![post],
            cursor: None,
            unavailable: 0,
            ended: true,
            cursor_only: false,
        },
        100,
        Source::Bookmarks,
    )
    .unwrap();
}
#[cfg(test)]
pub(crate) fn reading_sync_test_import_managed(c: &mut Connection, mut post: Post) {
    // Generic cache tests need Hub-owned originals. X originals belong to the user's vault.
    storage::schema(c).unwrap();
    post.source = "telegram".into();
    post.all_media = threads::collect_media(&post);
    let key = format!("telegram:test-account:{}", post.id);
    let body = serde_json::to_string(&post).unwrap();
    let hash = format!("{:x}", Sha256::digest(body.as_bytes()));
    c.execute("INSERT OR IGNORE INTO collection_x_items(item_key,account,post_json,content_hash,collected_at,captured_at) VALUES(?1,'test-account',?2,?3,100,100)",params![key,body,hash]).unwrap();
    c.execute("UPDATE collection_x_items SET post_json=?2,content_hash=?3,captured_at=100 WHERE item_key=?1 AND content_hash<>?3",params![key,body,hash]).unwrap();
}

#[cfg(test)]
pub(crate) fn reading_sync_test_items(c: &Connection, status: &str) -> Vec<Value> {
    query::items(
        c,
        String::new(),
        false,
        0,
        Some("all".into()),
        Some(status.into()),
        None,
        None,
        None,
        None,
        query::Filters::default(),
    )
    .unwrap()
    .3
}

#[cfg(test)]
pub(crate) fn reading_sync_test_items_all(c: &Connection, status: &str) -> Vec<Value> {
    let mut items = Vec::new();
    let mut offset = 0;
    loop {
        let page = query::items(
            c,
            String::new(),
            false,
            offset,
            Some("all".into()),
            Some(status.into()),
            None,
            None,
            None,
            None,
            query::Filters::default(),
        )
        .unwrap()
        .3;
        if page.is_empty() {
            return items;
        }
        offset += page.len() as u32;
        items.extend(page);
    }
}
