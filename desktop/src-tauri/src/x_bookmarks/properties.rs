use super::*;
pub(super) fn load(c: &Connection, key: &str, read: bool) -> Result<(String, Vec<String>), String> {
    let row: Option<(String, String)> = c
        .query_row(
            "SELECT status,tags FROM collection_x_properties WHERE item_key=?1",
            [key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match row {
        Some((status, tags)) => Ok((
            status,
            serde_json::from_str(&tags).map_err(|_| "标签数据损坏")?,
        )),
        None => Ok((if read { "read" } else { "unread" }.into(), vec![])),
    }
}
pub(super) fn label(status: &str) -> &str {
    match status {
        "read" => "已读",
        "in_progress" => "进行中",
        "abandoned" => "放弃",
        _ => "待读",
    }
}
fn page_request(client: &reqwest::Client, recipe: &RequestRecipe) -> reqwest::RequestBuilder {
    let mut request = client
        .get("https://x.com/i/bookmarks")
        .header("accept", "text/html");
    // API bearer/CSRF/transaction headers cause the HTML route to reject the request.
    for (k, v) in &recipe.headers {
        if matches!(k.as_str(), "cookie" | "user-agent") {
            request = request.header(k, v);
        }
    }
    request
}
fn operation_name(source: Source) -> &'static str {
    if source == Source::Likes {
        "UnfavoriteTweet"
    } else {
        "DeleteBookmark"
    }
}
fn operation_from_bundle(body: &str, operation: &str) -> Option<String> {
    let pattern = regex::Regex::new(&format!(
        r#"queryId\s*:\s*"([A-Za-z0-9_-]+)"\s*,\s*operationName\s*:\s*"{}""#,
        regex::escape(operation)
    ))
    .ok()?;
    pattern.captures(body).map(|cap| cap[1].to_string())
}
// Discover operation IDs from X's current web bundles; never send credentials to asset hosts.
pub(super) async fn operation_id(
    client: &reqwest::Client,
    recipe: &RequestRecipe,
    operation: &str,
) -> Result<String, String> {
    let response = page_request(client, recipe)
        .send()
        .await
        .map_err(|_| "无法读取 X 页面")?;
    if !response.status().is_success() {
        return Err(format!(
            "X 页面读取失败（HTTP {}），请更新连接后重试",
            response.status().as_u16()
        ));
    }
    let html = crate::http_body::text(response, MAX_RESPONSE).await?;
    let urls = regex::Regex::new(r#"https://abs\.twimg\.com/[^\s"'<>]+\.js"#).unwrap();
    let refs = regex::Regex::new(r#"["']([^"']+\.js)["']"#).unwrap();
    let mut entries: Vec<String> = urls
        .find_iter(&html)
        .map(|m| m.as_str().to_string())
        .collect();
    entries.sort_by_key(|url| !url.contains("/main."));
    let mut queue: std::collections::VecDeque<String> = entries.into();
    let mut seen = HashSet::new();
    while let Some(url) = queue.pop_front() {
        if seen.len() >= 120 {
            break;
        }
        if !seen.insert(url.clone()) {
            continue;
        }
        let base = Url::parse(&url).map_err(|_| "资源地址无效")?;
        if !asset_address(&base) {
            continue;
        }
        let response = client
            .get(base.clone())
            .send()
            .await
            .map_err(|_| "无法读取 X 接口定义")?;
        if !response.status().is_success() {
            continue;
        }
        let Ok(body) = crate::http_body::text(response, MAX_RESPONSE).await else {
            continue;
        };
        if let Some(query) = operation_from_bundle(&body, operation) {
            return Ok(query);
        }
        for cap in refs.captures_iter(&body) {
            if let Ok(next) = base.join(&cap[1]) {
                if asset_address(&next) && !seen.contains(next.as_str()) {
                    queue.push_back(next.to_string());
                }
            }
        }
    }
    Err(if operation == "TweetDetail" {
        "无法识别当前 X 内容接口，正文和串帖留待重试。"
    } else {
        "无法识别当前 X 取消接口，本地放弃状态已保存，取消操作留待重试。"
    }
    .into())
}
fn asset_address(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("abs.twimg.com")
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
}
fn cancellation_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "无法初始化连接".into())
}
fn mutation_request(
    client: &reqwest::Client,
    recipe: &RequestRecipe,
    id: &str,
    source: Source,
    query: &str,
) -> reqwest::RequestBuilder {
    let operation = operation_name(source);
    let mut request = client.post(format!("https://x.com/i/api/graphql/{query}/{operation}"));
    for (k, v) in &recipe.headers {
        // The captured transaction belongs to the original GET, not this mutation.
        if k != "x-client-transaction-id" {
            request = request.header(k, v);
        }
    }
    request
        .header("content-type", "application/json")
        .json(&json!({"variables":{"tweet_id":id},"queryId":query}))
}
async fn remove_remote(
    client: &reqwest::Client,
    recipe: &RequestRecipe,
    id: &str,
    source: Source,
    query: &str,
) -> Result<(), String> {
    let response = mutation_request(client, recipe, id, source, query)
        .send()
        .await
        .map_err(|_| "X 取消结果未确认，请重试；取消操作仍在待同步队列")?;
    if !response.status().is_success() {
        return Err(format!(
            "X 取消失败（HTTP {}），取消操作仍在待同步队列",
            response.status().as_u16()
        ));
    }
    let value: Value = response
        .json()
        .await
        .map_err(|_| "X 取消响应无法确认，取消操作仍在待同步队列")?;
    if !removal_confirmed(&value, source) {
        return Err("X 未确认取消成功，取消操作仍在待同步队列".into());
    }
    Ok(())
}
fn removal_confirmed(value: &Value, source: Source) -> bool {
    let field = if source == Source::Likes {
        "unfavorite_tweet"
    } else {
        "tweet_bookmark_delete"
    };
    let errors = value.get("errors").is_some_and(|errors| match errors {
        Value::Null => false,
        Value::Array(items) => !items.is_empty(),
        _ => true,
    });
    !errors && value.pointer(&format!("/data/{field}")) == Some(&json!("Done"))
}
#[tauri::command]
pub(crate) async fn set_collection_properties(
    app: AppHandle,
    key: String,
    status: String,
    tags: Vec<String>,
    expected_status: Option<String>,
    expected_tags: Option<Vec<String>>,
) -> Result<String, String> {
    if !["unread", "read", "in_progress", "abandoned"].contains(&status.as_str()) {
        return Err("阅读状态无效".into());
    }
    let mut clean = Vec::new();
    for tag in tags {
        let tag = tag.trim().trim_start_matches('#').trim();
        if tag.is_empty() {
            continue;
        }
        if tag.chars().count() > 80 || clean.len() >= 50 {
            return Err("标签最多 50 个，每个最多 80 字".into());
        }
        if !clean.iter().any(|v| v == tag) {
            clean.push(tag.to_string());
        }
    }
    {
        let (mut c, _writer) = open_write_database(&database_path(&app)?)?;
        schema(&c)?;
        save_edit(
            &mut c,
            &key,
            &status,
            &clean,
            expected_status.as_deref(),
            expected_tags.as_deref(),
        )?;
    }
    // Database edits are independent of fetch/download locks. File projection is serialized.
    let note = if cfg!(mobile) {
        String::new()
    } else if let Ok(_guard) = SYNC_LOCK.try_lock() {
        flush_local(&app).unwrap_or_else(|e| format!("；Obsidian 属性待补写：{e}"))
    } else {
        "；后台任务结束后补写页面属性".into()
    };
    Ok(format!("状态与标签已保存{note}"))
}

pub(super) fn flush_local(app: &AppHandle) -> Result<String, String> {
    let pending = {
        let (c, _writer) = open_write_database(&database_path(app)?)?;
        schema(&c)?;
        let mut q = c
            .prepare(
                "SELECT item_key,version FROM collection_property_updates ORDER BY local_seq LIMIT 100",
            )
            .map_err(|e| e.to_string())?;
        let rows = q
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows
    };
    for (key, version) in pending {
        storage::update_properties(app, &key)?;
        let (c, _writer) = open_write_database(&database_path(app)?)?;
        acknowledge_local(&c, &key, version)?;
    }
    Ok(String::new())
}
fn acknowledge_local(c: &Connection, key: &str, version: i64) -> Result<(), String> {
    c.execute(
        "DELETE FROM collection_property_updates WHERE item_key=?1 AND version=?2",
        params![key, version],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

// Local edits never fetch X or download media. The outbox is committed with the state.
pub(crate) fn save_edit(
    c: &mut Connection,
    key: &str,
    status: &str,
    tags: &[String],
    expected_status: Option<&str>,
    expected_tags: Option<&[String]>,
) -> Result<(), String> {
    let read: i64 = c
        .query_row(
            "SELECT read_at FROM collection_x_items WHERE item_key=?1",
            [key],
            |r| r.get(0),
        )
        .map_err(|_| "收藏不存在")?;
    let (current_status, mut current_tags) = load(c, key, read > 0)?;
    let status = if expected_status == Some(status) {
        &current_status
    } else {
        status
    };
    if let Some(expected) = expected_tags {
        current_tags.retain(|tag| !expected.contains(tag) || tags.contains(tag));
        for tag in tags {
            if !expected.contains(tag) && !current_tags.contains(tag) {
                current_tags.push(tag.clone());
            }
        }
    } else {
        current_tags = tags.to_vec();
    }
    if current_tags.len() > 50 {
        return Err("合并后的标签超过 50 个，请刷新后整理标签".into());
    }
    save_local(c, key, status, &current_tags)
}

pub(crate) fn save_local(
    c: &mut Connection,
    key: &str,
    status: &str,
    tags: &[String],
) -> Result<(), String> {
    if library::blocked(c, key)? {
        return Err("内容已删除".into());
    }
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let (read, provider): (i64, String) = tx
        .query_row(
            "SELECT read_at,COALESCE(NULLIF(json_extract(post_json,'$.source'),''),'bookmarks') FROM collection_x_items WHERE item_key=?1",
            [key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| "收藏不存在")?;
    let previous = load(&tx, key, read > 0)?.0;
    let passive = cfg!(mobile)
        || super::local_sources::owns(&tx, key)?
        || tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM reading_cloud_items WHERE item_key=?1)",
                [key],
                |r| r.get::<_, bool>(0),
            )
            .map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO collection_x_properties(item_key,status,tags) VALUES(?1,?2,?3) ON CONFLICT(item_key) DO UPDATE SET status=excluded.status,tags=excluded.tags",params![key,status,json!(tags).to_string()]).map_err(|e|e.to_string())?;
    let now = chrono::Utc::now().timestamp_millis();
    tx.execute("UPDATE collection_x_items SET read_at=?2,read_version=max(read_version+1,?3) WHERE item_key=?1",params![key,if status=="read"||status=="abandoned"{now}else{0},now]).map_err(|e|e.to_string())?;
    if !passive {
        tx.execute("DELETE FROM reading_cloud_passive WHERE item_key=?1", [key])
            .map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO collection_property_updates(item_key,version) SELECT item_key,read_version FROM collection_x_items WHERE item_key=?1 ON CONFLICT(item_key) DO UPDATE SET version=excluded.version",[key]).map_err(|e|e.to_string())?;
    }
    if !passive
        && status == "abandoned"
        && previous != "abandoned"
        && matches!(provider.as_str(), "bookmarks" | "likes")
    {
        tx.execute(
            "INSERT OR IGNORE INTO collection_x_outbox(item_key) VALUES(?1)",
            [key],
        )
        .map_err(|e| e.to_string())?;
    }
    if passive || status != "abandoned" {
        tx.execute("DELETE FROM collection_x_outbox WHERE item_key=?1", [key])
            .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}
fn pending_current(c: &Connection, key: &str, version: i64) -> Result<bool, String> {
    c.query_row("SELECT EXISTS(SELECT 1 FROM collection_x_outbox o JOIN collection_x_items i ON i.item_key=o.item_key JOIN collection_x_properties p ON p.item_key=o.item_key WHERE o.item_key=?1 AND i.read_version=?2 AND p.status='abandoned')",params![key,version],|r|r.get(0)).map_err(|e|e.to_string())
}
pub(super) async fn flush(app: &AppHandle, source: Source) -> Result<String, String> {
    let pending = {
        let (c, _writer) = open_write_database(&database_path(app)?)?;
        schema(&c)?;
        let mut q=c.prepare("SELECT o.item_key,i.post_json,i.account,i.read_version FROM collection_x_outbox o JOIN collection_x_items i ON i.item_key=o.item_key JOIN collection_x_properties p ON p.item_key=o.item_key WHERE p.status='abandoned' AND (COALESCE(NULLIF(json_extract(i.post_json,'$.source'),''),'bookmarks'))=?1 ORDER BY o.local_seq").map_err(|e|e.to_string())?;
        let rows = q
            .query_map([source.name()], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows
    };
    if pending.is_empty() {
        return Ok(String::new());
    }
    let recipe = load_recipe(app, source)?;
    let mut done = 0;
    let mut transport = None;
    for (key, body, account, version) in pending {
        if CANCEL.load(Ordering::Relaxed) {
            break;
        }
        let post: Post = serde_json::from_str(&body).map_err(|_| "待取消收藏数据损坏")?;
        let result: Result<bool, String> = if recipe.account != account {
            Err("X 连接账号与收藏所属账号不一致".into())
        } else {
            async {
                if post.id.is_empty() || !post.id.bytes().all(|ch| ch.is_ascii_digit()) {
                    return Err("待取消推文标识无效".into());
                }
                if transport.is_none() {
                    let client = cancellation_client()?;
                    let query = tokio::time::timeout(
                        Duration::from_secs(60),
                        operation_id(&client, &recipe, operation_name(source)),
                    )
                    .await
                    .map_err(|_| "读取 X 取消接口超时，取消操作仍在待同步队列")??;
                    transport = Some((client, query));
                }
                let (client, query) = transport.as_ref().unwrap();
                let current = {
                    let (c, _writer) = open_write_database(&database_path(app)?)?;
                    pending_current(&c, &key, version)?
                };
                if !current || CANCEL.load(Ordering::Relaxed) {
                    return Ok(false);
                }
                remove_remote(client, &recipe, &post.id, source, query).await?;
                Ok(true)
            }
            .await
        };
        let (c, _writer) = open_write_database(&database_path(app)?)?;
        if !pending_current(&c, &key, version)? {
            continue;
        }
        match result {
            Ok(true) => {
                c.execute("DELETE FROM collection_x_outbox WHERE item_key=?1", [key])
                    .map_err(|e| e.to_string())?;
                done += 1;
            }
            Ok(false) => {}
            Err(error) => {
                c.execute(
                    "UPDATE collection_x_outbox SET error=?2 WHERE item_key=?1",
                    params![key, error],
                )
                .map_err(|e| e.to_string())?;
                return Err(format!("已取消 {done} 条；取消待重试：{error}"));
            }
        }
    }
    Ok(format!("已取消 {done} 条 X 收藏"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_reverted_or_newer_abandonment_invalidates_the_remote_snapshot() {
        let mut c = Connection::open_in_memory().unwrap();
        schema(&c).unwrap();
        c.execute("INSERT INTO collection_x_items(item_key,account,post_json,content_hash,collected_at,captured_at) VALUES('pending','test','{}','hash',0,0)",[]).unwrap();
        save_local(&mut c, "pending", "abandoned", &[]).unwrap();
        let old: i64 = c
            .query_row(
                "SELECT read_version FROM collection_x_items WHERE item_key='pending'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(pending_current(&c, "pending", old).unwrap());
        save_local(&mut c, "pending", "unread", &[]).unwrap();
        assert!(!pending_current(&c, "pending", old).unwrap());
        save_local(&mut c, "pending", "abandoned", &[]).unwrap();
        assert!(!pending_current(&c, "pending", old).unwrap());
    }
    #[test]
    fn queued_projection_preserves_a_newer_edit_when_an_older_write_finishes() {
        let mut c = Connection::open_in_memory().unwrap();
        schema(&c).unwrap();
        c.execute("INSERT INTO collection_x_items(item_key,account,post_json,content_hash,collected_at,captured_at) VALUES('queued','test','{}','hash',0,0)",[]).unwrap();
        save_local(&mut c, "queued", "in_progress", &["第一版".into()]).unwrap();
        let old: i64 = c
            .query_row(
                "SELECT version FROM collection_property_updates WHERE item_key='queued'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        save_local(&mut c, "queued", "read", &["最新".into()]).unwrap();
        acknowledge_local(&c, "queued", old).unwrap();
        let latest: i64 = c
            .query_row(
                "SELECT version FROM collection_property_updates WHERE item_key='queued'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(latest > old);
        assert_eq!(
            load(&c, "queued", true).unwrap(),
            ("read".into(), vec!["最新".into()])
        );
        acknowledge_local(&c, "queued", latest).unwrap();
        assert_eq!(
            c.query_row(
                "SELECT count(*) FROM collection_property_updates",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }
    #[test]
    fn telegram_abandonment_is_local_and_never_enters_x_cancellation_outbox() {
        let mut c = Connection::open_in_memory().unwrap();
        schema(&c).unwrap();
        c.execute("INSERT INTO collection_x_items VALUES('telegram:7:42:9','7','{\"id\":\"9\",\"source\":\"telegram\"}','hash',1,1,0,0)",[]).unwrap();
        save_local(&mut c, "telegram:7:42:9", "abandoned", &["收集".into()]).unwrap();
        assert_eq!(
            load(&c, "telegram:7:42:9", true).unwrap(),
            ("abandoned".into(), vec!["收集".into()])
        );
        assert_eq!(
            c.query_row("SELECT count(*) FROM collection_x_outbox", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    fn captured_recipe() -> RequestRecipe {
        RequestRecipe {
            url: "https://x.com/i/api/graphql/read/Bookmarks".into(),
            account: "test".into(),
            headers: BTreeMap::from([
                ("cookie".into(), "auth_token=test; ct0=test".into()),
                ("user-agent".into(), "test-agent".into()),
                ("authorization".into(), "Bearer test".into()),
                ("x-csrf-token".into(), "test".into()),
                ("x-client-transaction-id".into(), "captured-get".into()),
            ]),
        }
    }
    #[test]
    fn discovery_page_uses_browser_headers_without_api_headers() {
        let request = page_request(&cancellation_client().unwrap(), &captured_recipe())
            .build()
            .unwrap();
        assert_eq!(request.url().as_str(), "https://x.com/i/bookmarks");
        assert_eq!(request.headers()["cookie"], "auth_token=test; ct0=test");
        assert_eq!(request.headers()["user-agent"], "test-agent");
        assert_eq!(request.headers()["accept"], "text/html");
        for header in ["authorization", "x-csrf-token", "x-client-transaction-id"] {
            assert!(!request.headers().contains_key(header));
        }
    }
    #[test]
    fn cancellation_preserves_auth_but_does_not_reuse_read_transaction() {
        for source in [Source::Likes, Source::Bookmarks] {
            let request = mutation_request(
                &cancellation_client().unwrap(),
                &captured_recipe(),
                "123",
                source,
                "current-query",
            )
            .build()
            .unwrap();
            assert_eq!(request.method(), reqwest::Method::POST);
            assert!(request.url().path().ends_with(operation_name(source)));
            assert_eq!(request.headers()["authorization"], "Bearer test");
            assert_eq!(request.headers()["x-csrf-token"], "test");
            assert!(request.headers().contains_key("cookie"));
            assert!(!request.headers().contains_key("x-client-transaction-id"));
            let body: Value =
                serde_json::from_slice(request.body().unwrap().as_bytes().unwrap()).unwrap();
            assert_eq!(
                body,
                json!({"variables":{"tweet_id":"123"},"queryId":"current-query"})
            );
        }
    }
    #[test]
    fn discovers_current_operations_and_limits_assets_to_x_cdn() {
        let bundle = r#"{queryId:"new_like-1",operationName:"UnfavoriteTweet"},{queryId:"new_bookmark-2",operationName:"DeleteBookmark"}"#;
        assert_eq!(
            operation_from_bundle(bundle, operation_name(Source::Likes)).as_deref(),
            Some("new_like-1")
        );
        assert_eq!(
            operation_from_bundle(bundle, operation_name(Source::Bookmarks)).as_deref(),
            Some("new_bookmark-2")
        );
        assert!(operation_from_bundle(bundle, "CreateBookmark").is_none());
        assert!(asset_address(
            &Url::parse("https://abs.twimg.com/responsive-web/main.js").unwrap()
        ));
        for url in [
            "http://abs.twimg.com/main.js",
            "https://abs.twimg.com.evil.example/main.js",
            "https://user@abs.twimg.com/main.js",
            "https://abs.twimg.com:444/main.js",
        ] {
            assert!(!asset_address(&Url::parse(url).unwrap()));
        }
    }
    #[test]
    fn only_explicit_error_free_done_confirms_the_matching_cancellation() {
        let like = json!({"data":{"unfavorite_tweet":"Done"}});
        let bookmark = json!({"data":{"tweet_bookmark_delete":"Done"},"errors":[]});
        assert!(removal_confirmed(&like, Source::Likes));
        assert!(removal_confirmed(&bookmark, Source::Bookmarks));
        assert!(!removal_confirmed(&like, Source::Bookmarks));
        assert!(!removal_confirmed(&bookmark, Source::Likes));
        for response in [
            json!({}),
            json!({"data":{"unfavorite_tweet":null}}),
            json!({"data":{"unfavorite_tweet":"Done"},"errors":[{"code":32}]}),
            json!({"data":{"unfavorite_tweet":"Done"},"errors":"failed"}),
        ] {
            assert!(!removal_confirmed(&response, Source::Likes));
        }
    }
    #[test]
    fn local_edits_queue_only_abandonment_and_undo_clears_it() {
        let mut c = Connection::open_in_memory().unwrap();
        schema(&c).unwrap();
        c.execute("INSERT INTO collection_x_items(item_key,account,post_json,content_hash,collected_at,captured_at) VALUES('a','test','{}','hash',0,0)",[]).unwrap();
        for status in ["in_progress", "read", "unread"] {
            save_local(&mut c, "a", status, &["标签".into()]).unwrap();
            assert_eq!(
                c.query_row("SELECT count(*) FROM collection_x_outbox", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
        save_local(&mut c, "a", "abandoned", &[]).unwrap();
        schema(&c).unwrap();
        assert_eq!(
            c.query_row("SELECT count(*) FROM collection_x_outbox", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        c.execute("UPDATE collection_x_outbox SET error='offline'", [])
            .unwrap();
        save_local(&mut c, "a", "abandoned", &["保留".into()]).unwrap();
        assert_eq!(
            c.query_row("SELECT error FROM collection_x_outbox", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "offline"
        );
        save_local(&mut c, "a", "in_progress", &[]).unwrap();
        assert_eq!(
            c.query_row("SELECT count(*) FROM collection_x_outbox", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn properties_survive_schema_and_preserve_custom_tags() {
        let c = Connection::open_in_memory().unwrap();
        schema(&c).unwrap();
        assert_eq!(load(&c, "new", false).unwrap(), ("unread".into(), vec![]));
        assert_eq!(load(&c, "new", true).unwrap().0, "read");
        c.execute(
            "INSERT INTO collection_x_properties VALUES(?1,?2,?3)",
            params!["a", "in_progress", json!(["研究", "稍后实践"]).to_string()],
        )
        .unwrap();
        schema(&c).unwrap();
        let (status, tags) = load(&c, "a", false).unwrap();
        assert_eq!(status, "in_progress");
        assert_eq!(tags, vec!["研究", "稍后实践"]);
        assert_eq!(label("abandoned"), "放弃");
    }
}
