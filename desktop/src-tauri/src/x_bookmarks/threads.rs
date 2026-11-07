use super::*;
fn hash(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}

pub(super) fn collect_media(post: &Post) -> Vec<Media> {
    fn collect(post: &Post, result: &mut Vec<Media>, seen: &mut HashSet<String>) {
        for media in &post.media {
            let key = if media.url.is_empty() {
                media.preview_url.clone()
            } else {
                media.url.clone()
            };
            if seen.insert(key) {
                result.push(media.clone());
            }
        }
        if let Some(quote) = &post.quote {
            collect(quote, result, seen);
        }
        for part in &post.thread {
            collect(part, result, seen);
        }
    }
    let mut result = vec![];
    collect(post, &mut result, &mut HashSet::new());
    result
}
pub(super) fn assets(post: &Post) -> &[Media] {
    if post.all_media.is_empty() {
        &post.media
    } else {
        &post.all_media
    }
}
pub(super) fn parts(post: &Post) -> Vec<&Post> {
    let mut parts = vec![post];
    parts.extend(post.thread.iter());
    parts.sort_by(|a, b| a.id.len().cmp(&b.id.len()).then(a.id.cmp(&b.id)));
    parts
}
#[cfg(test)]
fn same_author(a: &Post, b: &Post) -> bool {
    if !a.author_id.is_empty() && !b.author_id.is_empty() {
        a.author_id == b.author_id
    } else {
        !a.author_handle.is_empty() && a.author_handle.eq_ignore_ascii_case(&b.author_handle)
    }
}
fn entries(value: &Value) -> Result<Vec<&Value>, String> {
    if value
        .get("errors")
        .and_then(Value::as_array)
        .is_some_and(|errors| !errors.is_empty())
    {
        return Err("X 串帖响应包含错误，已保留现有内容".into());
    }
    let instructions = value
        .pointer("/data/threaded_conversation_with_injections_v2/instructions")
        .and_then(Value::as_array)
        .ok_or("X 串帖响应结构已变化，已保留现有内容")?;
    let mut entries = vec![];
    for instruction in instructions {
        if let Some(items) = instruction["entries"].as_array() {
            entries.extend(items);
        }
        if let Some(entry) = instruction.get("entry") {
            entries.push(entry);
        }
        if let Some(items) = instruction["moduleItems"].as_array() {
            entries.extend(items.iter().map(|item| item.get("item").unwrap_or(item)));
        }
    }
    Ok(entries)
}
fn detail_posts(value: &Value) -> Result<(Vec<Post>, Vec<String>), String> {
    let mut posts = vec![];
    let mut cursors = vec![];
    let mut seen = HashSet::new();
    for entry in entries(value)? {
        let content = entry.get("content").unwrap_or(entry);
        let mut items = vec![content];
        if let Some(children) = content["items"].as_array() {
            items.extend(children.iter().map(|item| item.get("item").unwrap_or(item)));
        }
        for item in items {
            if let Some(result) = item.pointer("/itemContent/tweet_results/result") {
                if let Some(post) = parse_post(result) {
                    if seen.insert(post.id.clone()) {
                        posts.push(post);
                    }
                }
            }
            let cursor = item
                .pointer("/itemContent/value")
                .or_else(|| item.get("value"))
                .and_then(Value::as_str);
            let kind = item
                .pointer("/itemContent/cursorType")
                .or_else(|| item.get("cursorType"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if !kind.is_empty() && kind != "Top" && !(kind == "Bottom" && bottom_ended(value)) {
                if let Some(cursor) = cursor {
                    if !cursor.is_empty() && !cursors.iter().any(|old| old == cursor) {
                        cursors.push(cursor.to_string());
                    }
                }
            }
        }
    }
    Ok((posts, cursors))
}
fn bottom_ended(value: &Value) -> bool {
    value
        .pointer("/data/threaded_conversation_with_injections_v2/instructions")
        .and_then(Value::as_array)
        .is_some_and(|instructions| {
            instructions
                .iter()
                .any(|i| i["type"] == "TimelineTerminateTimeline" && i["direction"] == "Bottom")
        })
}
pub(super) fn merge_detail(
    original: &Post,
    pages: &[Value],
    complete: bool,
) -> Result<Post, String> {
    let mut candidates = original
        .thread
        .iter()
        .cloned()
        .map(|post| (post.id.clone(), post))
        .collect::<std::collections::BTreeMap<_, _>>();
    let mut found_focal = false;
    for page in pages {
        for post in detail_posts(page)?.0 {
            found_focal |= post.id == original.id;
            candidates.insert(post.id.clone(), post);
        }
    }
    if !found_focal {
        return Err("X 未返回原帖正文，已保留现有内容".into());
    }
    let mut focal = candidates
        .get(&original.id)
        .cloned()
        .ok_or("X 未返回原帖正文，已保留现有内容")?;
    let mut connected = HashSet::from([focal.id.clone()]);
    // Conversation identity keeps accessible replies whose direct parent was deleted or hidden.
    if !focal.conversation_id.is_empty() {
        connected.extend(
            candidates
                .values()
                .filter(|post| post.conversation_id == focal.conversation_id)
                .map(|post| post.id.clone()),
        );
    }
    loop {
        let before = connected.len();
        for post in candidates.values() {
            if connected.contains(&post.reply_to_id)
                || connected.iter().any(|id| {
                    candidates
                        .get(id)
                        .is_some_and(|child| child.reply_to_id == post.id)
                })
            {
                connected.insert(post.id.clone());
            }
        }
        if connected.len() == before {
            break;
        }
    }
    focal.thread = candidates
        .into_values()
        .filter(|post| post.id != focal.id && connected.contains(&post.id))
        .collect();
    focal
        .thread
        .sort_by(|a, b| a.id.len().cmp(&b.id.len()).then(a.id.cmp(&b.id)));
    focal.source = original.source.clone();
    if focal.source == "likes" {
        focal.liked = true;
    }
    focal.thread_status = if complete { "complete" } else { "partial" }.into();
    focal.all_media = collect_media(&focal);
    Ok(focal)
}
fn detail_url(
    recipe: &RequestRecipe,
    id: &str,
    query: &str,
    cursor: Option<&str>,
) -> Result<Url, String> {
    if id.is_empty() || !id.bytes().all(|ch| ch.is_ascii_digit()) {
        return Err("推文标识无效".into());
    }
    let original = Url::parse(&recipe.url).map_err(|_| "X 连接地址无效")?;
    let parameters: BTreeMap<String, String> = original
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    let mut variables = json!({"focalTweetId":id,"with_rux_injections":false,"rankingMode":"Relevance","includePromotedContent":false,"withCommunity":true,"withQuickPromoteEligibilityTweetFields":false,"withBirdwatchNotes":true,"withVoice":true});
    if let Some(cursor) = cursor {
        variables["cursor"] = json!(cursor);
    }
    let mut url = Url::parse(&format!("https://x.com/i/api/graphql/{query}/TweetDetail"))
        .map_err(|_| "X 内容接口无效")?;
    url.query_pairs_mut()
        .append_pair("variables", &variables.to_string())
        .append_pair(
            "features",
            parameters
                .get("features")
                .map(String::as_str)
                .unwrap_or("{}"),
        )
        .append_pair(
            "fieldToggles",
            &json!({"withArticleRichContentState":true,"withArticlePlainText":false}).to_string(),
        );
    Ok(url)
}
async fn read_detail(
    client: &reqwest::Client,
    recipe: &RequestRecipe,
    id: &str,
    query: &str,
    cursor: Option<&str>,
) -> Result<Value, String> {
    let mut request = client
        .get(detail_url(recipe, id, query, cursor)?)
        .header("accept", "application/json");
    for (key, value) in &recipe.headers {
        if key != "x-client-transaction-id" {
            request = request.header(key, value);
        }
    }
    let mut response = request
        .send()
        .await
        .map_err(|_| "无法连接 X 串帖接口，已保留现有内容")?;
    if !response.status().is_success() {
        return Err(format!(
            "X 串帖接口 HTTP {}，内容留待重试",
            response.status().as_u16()
        ));
    }
    let mut bytes = vec![];
    while let Some(chunk) = response.chunk().await.map_err(|_| "X 串帖响应中断")? {
        if bytes.len() + chunk.len() > MAX_RESPONSE {
            return Err("X 串帖响应超过大小限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "X 串帖未返回有效数据".into())
}
const THREAD_FORMAT: u32 = 2;
const DETAIL_PAGE_LIMIT: usize = 20;
const SYNC_DETAIL_BUDGET: usize = 80;

fn capture_complete(post: &Post) -> bool {
    post.thread_format == THREAD_FORMAT
        && post.thread_cursors.is_empty()
        && matches!(post.thread_status.as_str(), "complete" | "limited")
}
fn capture_result(
    original: &Post,
    pages: &[Value],
    pending: &std::collections::VecDeque<String>,
    seen: &HashSet<String>,
    error: String,
) -> Result<Post, String> {
    let mut fresh = merge_detail(original, pages, pending.is_empty() && error.is_empty())?;
    fresh.thread_format = THREAD_FORMAT;
    fresh.thread_cursors = pending.iter().cloned().collect();
    fresh.thread_seen_cursors = seen.iter().cloned().collect();
    fresh.thread_seen_cursors.sort();
    fresh.thread_error = error;
    if !fresh.thread_error.is_empty() {
        fresh.thread_status = "limited".into();
    } else if pending.is_empty() && fresh.reply_count > fresh.thread.len() as u64 {
        fresh.thread_status = "limited".into();
        fresh.thread_error = "X 本次未返回更多可访问的回复".into();
    }
    fresh.all_media = collect_media(&fresh);
    Ok(fresh)
}
// Retain unread cursors across page budgets, pauses and transient failures.
async fn fetch(
    client: &reqwest::Client,
    recipe: &RequestRecipe,
    original: &Post,
    query: &str,
    max_pages: usize,
) -> Result<(Post, usize), String> {
    let first = read_detail(client, recipe, &original.id, query, None).await?;
    let (initial_posts, initial_cursors) = detail_posts(&first)?;
    if !initial_posts.iter().any(|post| post.id == original.id) {
        return Err("X 未返回原帖正文，已保留现有内容".into());
    }
    let mut pages = vec![first];
    let mut resumed =
        original.thread_format == THREAD_FORMAT && !original.thread_cursors.is_empty();
    let mut pending: std::collections::VecDeque<String> = if resumed {
        original.thread_cursors.clone()
    } else {
        initial_cursors.clone()
    }
    .into();
    let mut seen: HashSet<String> = if resumed {
        original.thread_seen_cursors.iter().cloned().collect()
    } else {
        HashSet::new()
    };
    let mut known: HashSet<String> = if resumed {
        original.thread.iter().map(|post| post.id.clone()).collect()
    } else {
        HashSet::new()
    };
    known.extend(initial_posts.into_iter().map(|post| post.id));
    let mut requests = 1;
    let mut error = String::new();
    let mut empty_pages = 0;
    while !pending.is_empty() && requests < max_pages && known.len() < 5000 {
        if CANCEL.load(Ordering::Relaxed) {
            break;
        }
        let cursor = pending.pop_front().unwrap();
        let cursor_hash = hash(cursor.as_bytes());
        if seen.contains(&cursor_hash) {
            error = "X 重复返回回复分页，已保留获取到的内容".into();
            break;
        }
        requests += 1;
        match read_detail(client, recipe, &original.id, query, Some(&cursor)).await {
            Ok(page) => {
                let (posts, cursors) = match detail_posts(&page) {
                    Ok(page) => page,
                    Err(reason) => {
                        pending.push_front(cursor);
                        error = reason;
                        break;
                    }
                };
                let added = posts
                    .iter()
                    .filter(|post| !known.contains(&post.id))
                    .count();
                known.extend(posts.into_iter().map(|post| post.id));
                empty_pages = if added == 0 { empty_pages + 1 } else { 0 };
                seen.insert(cursor_hash);
                for next in cursors {
                    if !seen.contains(&hash(next.as_bytes())) && !pending.contains(&next) {
                        pending.push_back(next);
                    } else if added == 0 && !bottom_ended(&page) {
                        error = "X 本次未返回更多可访问的回复".into();
                    }
                }
                pages.push(page);
                if empty_pages >= 2 {
                    error = "X 本次未返回更多可访问的回复".into();
                    break;
                }
                if !error.is_empty() {
                    break;
                }
                resumed = false;
            }
            Err(reason) => {
                if resumed {
                    // A saved continuation may expire. Restart from today's first page once.
                    resumed = false;
                    seen.clear();
                    pending = initial_cursors.clone().into();
                    continue;
                }
                pending.push_front(cursor);
                error = reason;
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    Ok((
        capture_result(original, &pages, &pending, &seen, error)?,
        requests,
    ))
}
fn signature(post: &Post) -> String {
    hash(
        format!(
            "replies-v2:{}:{}:{}",
            post.reply_count, post.quote_id, post.text
        )
        .as_bytes(),
    )
}
fn key(account: &str, source: Source, id: &str) -> String {
    format!(
        "{}:{account}:{id}",
        if source == Source::Likes {
            "x-likes"
        } else {
            "x"
        }
    )
}
#[derive(Default)]
pub(super) struct Enricher {
    requests: usize,
    page_requests: usize,
    completed: usize,
    pending: usize,
    query: Option<Result<String, String>>,
    last_error: String,
}
impl Enricher {
    pub(super) fn summary(&self) -> String {
        if self.completed + self.pending == 0 {
            String::new()
        } else {
            let mut summary = format!(
                " · 回复已获取 {} 个帖子 · 待继续 {} 个帖子",
                self.completed, self.pending
            );
            if !self.last_error.is_empty() {
                summary.push_str(&format!("；{}", self.last_error));
            }
            summary
        }
    }
}
pub(super) async fn enrich_page(
    app: &AppHandle,
    recipe: &RequestRecipe,
    client: &reqwest::Client,
    page: &mut Page,
    source: Source,
    state: &mut Enricher,
) {
    for post in &mut page.posts {
        if CANCEL.load(Ordering::Relaxed) {
            break;
        }
        if post.reply_count == 0
            && post.reply_to_id.is_empty()
            && (post.quote_id.is_empty() || post.quote.is_some())
        {
            continue;
        }
        let key = key(&recipe.account, source, &post.id);
        let signature = signature(post);
        let now = now_timestamp();
        let previous=database_path(app).ok().and_then(|path|Connection::open(path).ok()).and_then(|c|c.query_row("SELECT e.signature,e.checked_at,e.error,i.post_json FROM collection_x_enrichment e JOIN collection_x_items i ON i.item_key=e.item_key WHERE e.item_key=?1",[&key],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?))).optional().ok().flatten());
        let saved = previous
            .as_ref()
            .and_then(|(_, _, _, raw)| serde_json::from_str::<Post>(raw).ok());
        if previous.as_ref().is_some_and(|(old, time, error, _)| {
            error.is_empty()
                && old == &signature
                && now - *time < 86400
                && saved.as_ref().is_some_and(|saved| {
                    capture_complete(saved) && self::signature(saved) == signature
                })
        }) {
            continue;
        }
        if state.requests >= 40
            || state.page_requests >= SYNC_DETAIL_BUDGET
            || previous
                .as_ref()
                .is_some_and(|(_, time, error, _)| !error.is_empty() && now - *time < 300)
        {
            post.thread_status = "pending".into();
            state.pending += 1;
            continue;
        }
        state.requests += 1;
        let mut original = post.clone();
        if let Some(saved) = saved.filter(|saved| {
            saved.text == post.text
                && saved.reply_count == post.reply_count
                && saved.quote_id == post.quote_id
        }) {
            original.thread = saved.thread;
            original.thread_status = saved.thread_status;
            original.thread_cursors = saved.thread_cursors;
            original.thread_seen_cursors = saved.thread_seen_cursors;
            original.thread_format = saved.thread_format;
        }
        if state.query.is_none() {
            state.query = Some(
                tokio::time::timeout(
                    Duration::from_secs(45),
                    properties::operation_id(client, recipe, "TweetDetail"),
                )
                .await
                .unwrap_or_else(|_| Err("读取 X 内容接口超时".into())),
            );
        }
        let result = match state.query.as_ref().unwrap() {
            Ok(query) => {
                fetch(
                    client,
                    recipe,
                    &original,
                    query,
                    DETAIL_PAGE_LIMIT.min(SYNC_DETAIL_BUDGET - state.page_requests),
                )
                .await
            }
            Err(error) => Err(error.clone()),
        };
        let error = match result {
            Ok((fresh, requests)) => {
                state.page_requests += requests;
                let error = if capture_complete(&fresh) {
                    String::new()
                } else {
                    if fresh.thread_error.is_empty() {
                        "回复尚未读取完整，将在下次同步继续".into()
                    } else {
                        fresh.thread_error.clone()
                    }
                };
                *post = fresh;
                if error.is_empty() {
                    state.completed += 1;
                } else {
                    state.pending += 1;
                }
                error
            }
            Err(error) => {
                state.page_requests += 1;
                post.thread_status = "pending".into();
                state.pending += 1;
                state.last_error = error.clone();
                if error.contains("HTTP 429")
                    || error.contains("HTTP 401")
                    || error.contains("HTTP 403")
                {
                    state.query = Some(Err(error.clone()));
                }
                error
            }
        };
        if let Ok(path) = database_path(app) {
            if let Ok((c, _writer)) = open_write_database(&path) {
                let _=c.execute("INSERT INTO collection_x_enrichment(item_key,signature,checked_at,error) VALUES(?1,?2,?3,?4) ON CONFLICT(item_key) DO UPDATE SET signature=excluded.signature,checked_at=excluded.checked_at,error=excluded.error",params![key,signature,now,error]);
            }
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}
#[tauri::command]
pub(crate) async fn refresh_collection_content(
    app: AppHandle,
    key: String,
) -> Result<String, String> {
    let guard = SYNC_LOCK
        .try_lock()
        .map_err(|_| "请等待当前同步或保存结束")?;
    let (body, account) = {
        let (c, _writer) = open_write_database(&database_path(&app)?)?;
        c.query_row(
            "SELECT post_json,account FROM collection_x_items WHERE item_key=?1",
            [&key],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .map_err(|_| "收藏不存在")?
    };
    let original: Post = serde_json::from_str(&body).map_err(|_| "收藏内容损坏")?;
    let source = Source::parse(Some(&original.source))?;
    let recipe = load_recipe(&app, source)?;
    if recipe.account != account {
        return Err("X 连接账号与收藏所属账号不一致".into());
    }
    jobs::begin("fetching", source.name());
    tauri::async_runtime::spawn(async move {
        let _guard = guard;
        let result = async {
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(30))
                .build()
                .map_err(|_| "无法初始化 X 连接")?;
            let query = tokio::time::timeout(
                Duration::from_secs(45),
                properties::operation_id(&client, &recipe, "TweetDetail"),
            )
            .await
            .map_err(|_| "读取 X 内容接口超时")??;
            let (fresh, _) = fetch(&client, &recipe, &original, &query, DETAIL_PAGE_LIMIT).await?;
            {
                let (mut c, _writer) = open_write_database(&database_path(&app)?)?;
                save_refreshed(&mut c, &key, &fresh)?;
            }
            let saved = storage::export(&app, Some(&key)).await?;
            Ok(format!(
                "内容已更新 · 已获取 {} 条回复{} · {saved}",
                fresh.thread.len(),
                if fresh.thread_status == "limited" {
                    " · X 本次可访问范围有限"
                } else if fresh.thread_status == "partial" {
                    " · 下次继续获取"
                } else {
                    ""
                }
            ))
        }
        .await;
        jobs::finish(&result);
    });
    Ok("正在更新正文、回复和引用".into())
}

fn save_refreshed(c: &mut Connection, key: &str, fresh: &Post) -> Result<(), String> {
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let body = serde_json::to_string(fresh).map_err(|e| e.to_string())?;
    let changed = tx.execute("UPDATE collection_x_items SET post_json=?2,content_hash=?3,captured_at=?4 WHERE item_key=?1",
        params![key,body,hash(body.as_bytes()),chrono::Utc::now().timestamp_millis()]).map_err(|e|e.to_string())?;
    if changed != 1 {
        return Err("收藏不存在".into());
    }
    let incomplete = if capture_complete(fresh) {
        ""
    } else {
        "回复尚待继续获取"
    };
    tx.execute("INSERT INTO collection_x_enrichment(item_key,signature,checked_at,error) VALUES(?1,?2,?3,?4) ON CONFLICT(item_key) DO UPDATE SET signature=excluded.signature,checked_at=excluded.checked_at,error=excluded.error",
        params![key,signature(fresh),now_timestamp(),incomplete]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests;
