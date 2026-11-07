use super::*;

fn request(operation: &str) -> String {
    let mut url = Url::parse(&format!(
        "https://x.com/i/api/graphql/test-query/{operation}"
    ))
    .unwrap();
    url.query_pairs_mut()
        .append_pair(
            "variables",
            r#"{"count":20,"cursor":"old-page","userId":"123"}"#,
        )
        .append_pair("features", r#"{"example":true}"#);
    format!("curl '{}' \\\n -H 'authorization: Bearer fake-public-client' \\\n -H 'x-csrf-token: fake-csrf' \\\n -b 'auth_token=fake-secret; ct0=fake-csrf; twid=u%3D123; extra=retained' --compressed", url)
}
pub(super) fn tweet(id: &str) -> Value {
    json!({"rest_id":id,"legacy":{"full_text":"hello","created_at":"Mon Oct 05 02:00:00 +0000 2026","entities":{"urls":[{"expanded_url":"https://example.com/read"}]}},"core":{"user_results":{"result":{"legacy":{"name":"Reader","screen_name":"reader"}}}}})
}
pub(super) fn response(entries: Vec<Value>) -> Value {
    json!({"data":{"bookmark_timeline_v2":{"timeline":{"instructions":[{"type":"TimelineAddEntries","entries":entries}]}}}})
}
pub(super) fn entry(tweet: Value) -> Value {
    json!({"content":{"itemContent":{"tweet_results":{"result":tweet}}}})
}
pub(super) fn database() -> Connection {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)")
        .unwrap();
    storage::schema(&c).unwrap();
    c
}

#[test]
fn imported_request_preserves_features_and_auth_but_resets_pagination() {
    let recipe = parse_recipe(&request("Bookmarks")).unwrap();
    assert_eq!(recipe.account, "123");
    assert!(recipe.headers["cookie"].contains("extra=retained"));
    let url = Url::parse(&recipe.url).unwrap();
    let query: BTreeMap<_, _> = url.query_pairs().collect();
    let vars: Value = serde_json::from_str(&query["variables"]).unwrap();
    assert!(vars.get("cursor").is_none());
    assert_eq!(vars["count"], 40);
    assert_eq!(query["features"], r#"{"example":true}"#);
}

#[test]
fn vivaldi_explicit_url_forms_match_positional_url_without_weakening_validation() {
    let original = request("Bookmarks");
    let expected = parse_recipe(&original).unwrap();
    for prefix in ["curl --url ", "curl --url="] {
        let parsed = parse_recipe(&original.replacen("curl ", prefix, 1)).unwrap();
        assert_eq!(parsed.url, expected.url);
        assert_eq!(parsed.headers, expected.headers);
        assert_eq!(parsed.account, expected.account);
    }
    for invalid in [
        "curl --url".to_string(),
        original.replacen("curl ", "curl --url https://example.com ", 1),
        original
            .replacen("curl ", "curl --url ", 1)
            .replace("https://x.com/", "https://example.com/"),
        original
            .replacen("curl ", "curl --url=", 1)
            .replace("https://x.com/", "http://x.com/"),
    ] {
        assert!(parse_recipe(&invalid).is_err());
    }
}

#[test]
fn request_rejects_other_operations_hosts_methods_and_commands() {
    for operation in ["ViewerBadgeCounts", "DeleteBookmark"] {
        assert!(parse_recipe(&request(operation)).is_err());
    }
    for input in [
        request("Bookmarks").replace("https://x.com/", "https://x.com.attacker.test/"),
        request("Bookmarks") + " -X POST",
        request("Bookmarks") + " ; echo injected",
        request("Bookmarks") + " https://example.com",
        request("Bookmarks") + " --output out",
    ] {
        assert!(parse_recipe(&input).is_err());
    }
}

#[test]
fn auth_validation_never_echoes_secrets() {
    let input = request("Bookmarks").replace("ct0=fake-csrf", "ct0=secret-mismatch");
    let error = parse_recipe(&input).err().unwrap();
    assert!(!error.contains("secret-mismatch"));
    assert!(!error.contains("fake-secret"));
    assert!(
        parse_recipe(&request("Bookmarks").replace("auth_token=fake-secret", "auth_token="))
            .is_err()
    );
}

#[test]
fn page_extracts_long_text_quote_media_cursor_and_deduplicates() {
    let mut post = tweet("100");
    post["note_tweet"] = json!({"note_tweet_results":{"result":{"text":"full long text"}}});
    post["legacy"]["truncated"] = json!(true);
    post["quoted_status_result"] = json!({"result":tweet("200")});
    post["legacy"]["extended_entities"] = json!({"media":[{"type":"video","media_url_https":"https://pbs.twimg.com/test.jpg","video_info":{"variants":[{"content_type":"application/x-mpegURL","url":"https://video.twimg.com/video.m3u8"},{"content_type":"video/mp4","bitrate":100,"url":"https://video.twimg.com/low.mp4"},{"content_type":"video/mp4","bitrate":400,"url":"https://video.twimg.com/high.mp4"}]}}]});
    let page = parse_page(&response(vec![
        entry(post.clone()),
        entry(json!({"tweet":post})),
        json!({"content":{"cursorType":"Bottom","value":"next"}}),
    ]))
    .unwrap();
    assert_eq!(page.posts.len(), 1);
    assert_eq!(page.posts[0].text, "full long text");
    assert_eq!(page.posts[0].quoted_text, "hello");
    assert_eq!(page.posts[0].content_status, "text");
    assert_eq!(
        page.posts[0].media[0].url,
        "https://video.twimg.com/high.mp4"
    );
    assert_eq!(page.cursor.as_deref(), Some("next"));
}

#[test]
fn unavailable_and_changed_responses_are_not_silent_success() {
    let page = parse_page(&response(vec![entry(
        json!({"__typename":"TweetUnavailable"}),
    )]))
    .unwrap();
    assert_eq!(page.unavailable, 1);
    assert!(parse_page(&json!({"data":{"unknown":{}}})).is_err());
    assert!(parse_page(&json!({"errors":[{"message":"fake-secret"}]}))
        .err()
        .unwrap()
        .find("fake-secret")
        .is_none());
    assert!(parse_page(&json!({"data":{"bookmark_timeline_v2":{"timeline":{"instructions":[{"type":"ChangedProtocol"}]}}}})).is_err());
    assert!(safe_url("javascript:alert(1)").is_none());
    assert!(safe_url("https://user:secret@example.com").is_none());
}

#[test]
fn reimport_preserves_read_state_first_seen_and_account_isolation() {
    let mut c = database();
    let mut page = parse_page(&response(vec![
        entry(tweet("100")),
        json!({"content":{"cursorType":"Bottom","value":"next"}}),
    ]))
    .unwrap();
    assert_eq!(persist_page(&mut c, "123", &page, 1000).unwrap(), 1);
    c.execute(
        "UPDATE collection_x_items SET read_at=1500,read_version=1500",
        [],
    )
    .unwrap();
    page.posts[0].text = "edited".into();
    assert_eq!(persist_page(&mut c, "123", &page, 2000).unwrap(), 0);
    let state: (i64, i64, i64, String) = c
        .query_row(
            "SELECT collected_at,read_at,captured_at,post_json FROM collection_x_items",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();
    assert_eq!((state.0, state.1, state.2), (1000, 1500, 2000));
    assert!(state.3.contains("edited"));
    assert_eq!(persist_page(&mut c, "456", &page, 3000).unwrap(), 1);
    assert_eq!(metadata_string(&c, "x_bookmarks_cursor"), "next");
    page.ended = true;
    persist_page(&mut c, "123", &page, 4000).unwrap();
    assert!(metadata_string(&c, "x_bookmarks_cursor").is_empty());
}

#[test]
fn page_and_cursor_commit_atomically() {
    let mut c = database();
    meta(&c, "x_bookmarks_cursor", "previous").unwrap();
    c.execute_batch("CREATE TRIGGER deny_cursor BEFORE UPDATE ON metadata BEGIN SELECT RAISE(ABORT,'test failure'); END;").unwrap();
    let page = parse_page(&response(vec![
        entry(tweet("100")),
        json!({"content":{"cursorType":"Bottom","value":"next"}}),
    ]))
    .unwrap();
    assert!(persist_page(&mut c, "123", &page, 1000).is_err());
    assert_eq!(
        c.query_row("SELECT count(*) FROM collection_x_items", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(metadata_string(&c, "x_bookmarks_cursor"), "previous");
}

#[test]
fn empty_repeated_cursor_is_terminal_but_content_repeats_and_cycles_are_not() {
    let bottom = json!({"content":{"cursorType":"Bottom","value":"tail"}});
    let mut page = parse_page(&response(vec![
        json!({"content":{"cursorType":"Top","value":"top"}}),
        bottom.clone(),
    ]))
    .unwrap();
    let visited = HashSet::from(["tail".to_string(), "previous".to_string()]);
    validate_page_progress(&mut page, "tail", &visited).unwrap();
    assert!(page.ended);
    let mut c = database();
    meta(&c, "x_bookmarks_cursor", "tail").unwrap();
    persist_page(&mut c, "123", &page, 1000).unwrap();
    assert!(metadata_string(&c, "x_bookmarks_cursor").is_empty());
    for item in [
        entry(tweet("100")),
        entry(json!({"__typename":"TweetUnavailable"})),
        json!({"content":{"unknown":"changed"}}),
    ] {
        let mut repeated = parse_page(&response(vec![item, bottom.clone()])).unwrap();
        assert!(validate_page_progress(&mut repeated, "tail", &visited).is_err());
        assert!(!repeated.ended);
    }
    let mut cycle = parse_page(&response(vec![bottom.clone()])).unwrap();
    assert!(validate_page_progress(&mut cycle, "previous", &visited).is_err());
    let mut advancing = parse_page(&response(vec![bottom])).unwrap();
    validate_page_progress(
        &mut advancing,
        "before-tail",
        &HashSet::from(["before-tail".to_string()]),
    )
    .unwrap();
    assert!(!advancing.ended);
}

#[test]
fn likes_are_own_account_only_and_have_separate_rows_and_cursor() {
    let recipe = parse_recipe(&request("Likes")).unwrap();
    assert!(recipe.url.contains("/Likes?"));
    assert!(
        parse_recipe(&request("Likes").replace("userId%22%3A%22123", "userId%22%3A%22999"))
            .is_err()
    );
    let value = json!({"data":{"user":{"result":{"timeline_v2":{"timeline":{"instructions":[{"type":"TimelineAddEntries","entries":[entry(tweet("100")),{"content":{"cursorType":"Bottom","value":"likes-next"}}]}]}}}}}});
    let page = parse_page(&value).unwrap();
    let mut c = database();
    persist_page(&mut c, "123", &page, 1000).unwrap();
    persist_source_page(&mut c, "123", &page, 1000, Source::Likes).unwrap();
    assert_eq!(
        c.query_row("SELECT count(*) FROM collection_x_items", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
    let body: String = c
        .query_row(
            "SELECT post_json FROM collection_x_items WHERE item_key='x-likes:123:100'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let post: Post = serde_json::from_str(&body).unwrap();
    assert!(post.liked);
    assert_eq!(post.source, "likes");
    assert_eq!(metadata_string(&c, "x_likes_cursor"), "likes-next");
    assert_eq!(metadata_string(&c, "x_bookmarks_cursor"), "likes-next");
    meta(&c, "x_likes_cursor", "separate").unwrap();
    persist_page(&mut c, "123", &page, 2000).unwrap();
    assert_eq!(metadata_string(&c, "x_likes_cursor"), "separate");
}

#[test]
fn database_views_filter_before_paging_and_sort_across_all_sources() {
    let mut c = database();
    for n in 1..=75 {
        let mut post = parse_post(&tweet(&n.to_string())).unwrap();
        post.author_name = if n % 2 == 0 { "Alpha" } else { "Zulu" }.into();
        if n % 3 == 0 {
            post.media.push(Media {
                kind: "video".into(),
                url: format!("https://video.twimg.com/{n}.mp4"),
                preview_url: String::new(),
            });
        }
        let page = Page {
            posts: vec![post],
            cursor_only: false,
            cursor: None,
            ended: true,
            unavailable: 0,
        };
        persist_source_page(
            &mut c,
            "123",
            &page,
            n,
            if n % 2 == 0 {
                Source::Likes
            } else {
                Source::Bookmarks
            },
        )
        .unwrap();
    }
    c.execute("UPDATE collection_x_items SET read_at=1 WHERE json_extract(post_json,'$.id') IN ('72','75')",[]).unwrap();
    let run = |source: &str, status: &str, media: &str, sort: &str, asc: bool, offset: u32| {
        query_collection_items(
            &c,
            String::new(),
            false,
            offset,
            Some(source.into()),
            Some(status.into()),
            Some(media.into()),
            Some(sort.into()),
            Some(asc),
            None,
        )
        .unwrap()
    };
    let (total, unread, matched, items) = run("all", "all", "all", "published", true, 60);
    assert_eq!((total, unread, matched), (75, 73, 75));
    assert_eq!(items.len(), 15);
    assert_eq!(items[0]["post"]["id"], "61");
    let (_, _, matched, items) = run("likes", "unread", "video", "published", false, 0);
    assert_eq!(matched, 11);
    assert_eq!(items[0]["post"]["id"], "66");
    assert!(items
        .iter()
        .all(|i| i["post"]["source"] == "likes" && i["read"] == false));
    let (_, _, matched, items) = run("all", "read", "links", "author", true, 0);
    assert_eq!(matched, 2);
    assert_eq!(items[0]["post"]["authorName"], "Alpha");
    assert!(query_collection_items(
        &c,
        String::new(),
        false,
        0,
        Some("bad".into()),
        None,
        None,
        None,
        None,
        None
    )
    .is_err());
}

#[test]
fn reading_text_removes_only_confirmed_media_placeholders() {
    let mut value = tweet("100");
    value["legacy"]["full_text"] =
        json!("有感而发。 https://t.co/image\n阅读 https://t.co/article");
    value["legacy"]["extended_entities"] = json!({"media":[{"url":"https://t.co/image","type":"photo","media_url_https":"https://pbs.twimg.com/a.jpg"}]});
    value["legacy"]["entities"]["urls"] =
        json!([{"url":"https://t.co/article","expanded_url":"https://example.com/read"}]);
    assert_eq!(
        parse_post(&value).unwrap().text,
        "有感而发。\n阅读 https://t.co/article"
    );
    value["legacy"]["full_text"] = json!("https://t.co/imageLong https://t.co/image");
    assert_eq!(parse_post(&value).unwrap().text, "https://t.co/imageLong");
    value["note_tweet"] = json!({"note_tweet_results":{"result":{"text":"长文 https://t.co/image","entity_set":{"urls":[]}}}});
    assert_eq!(parse_post(&value).unwrap().text, "长文");
    value["quoted_status_result"] = json!({"result":tweet("101")});
    value["quoted_status_result"]["result"]["legacy"]["full_text"] =
        json!("保留普通短链 https://t.co/external");
    assert!(parse_post(&value)
        .unwrap()
        .quoted_text
        .ends_with("https://t.co/external"));
}

#[test]
fn regular_feed_does_not_erase_enriched_threads_quotes_or_local_properties() {
    let mut c = database();
    let mut post = parse_post(&tweet("100")).unwrap();
    post.thread_status = "complete".into();
    post.quote_id = "90".into();
    post.quote = Some(Box::new(parse_post(&tweet("90")).unwrap()));
    post.thread = vec![parse_post(&tweet("101")).unwrap()];
    let mut page = Page {
        posts: vec![post],
        cursor: None,
        cursor_only: false,
        ended: true,
        unavailable: 0,
    };
    persist_page(&mut c, "123", &page, 1000).unwrap();
    c.execute(
        "UPDATE collection_x_items SET read_at=1234,read_version=2",
        [],
    )
    .unwrap();
    c.execute(
        "INSERT INTO collection_x_properties VALUES('x:123:100','in_progress','[\"user-tag\"]')",
        [],
    )
    .unwrap();
    let mut short = parse_post(&tweet("100")).unwrap();
    short.quote_id = "90".into();
    page.posts = vec![short];
    persist_page(&mut c, "123", &page, 2000).unwrap();
    let (body, collected, read): (String, i64, i64) = c
        .query_row(
            "SELECT post_json,collected_at,read_at FROM collection_x_items",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    let enriched: Post = serde_json::from_str(&body).unwrap();
    assert_eq!(enriched.thread.len(), 1);
    assert_eq!(enriched.quote.unwrap().id, "90");
    assert_eq!(enriched.thread_status, "complete");
    assert_eq!((collected, read), (1000, 1234));
    assert_eq!(
        properties::load(&c, "x:123:100", true).unwrap(),
        ("in_progress".into(), vec!["user-tag".into()])
    );
}
