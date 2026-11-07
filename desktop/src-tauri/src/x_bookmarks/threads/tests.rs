use super::*;

fn tweet(id: &str, author: &str, parent: &str) -> Value {
    let mut value = super::super::tests::tweet(id);
    value["core"]["user_results"]["result"]["rest_id"] = json!(author);
    value["legacy"]["in_reply_to_status_id_str"] = json!(parent);
    value["legacy"]["conversation_id_str"] = json!("100");
    value["legacy"]["reply_count"] = json!(3);
    value["legacy"]["full_text"] = json!(format!("body {id}"));
    value
}
fn response(posts: Vec<Value>) -> Value {
    json!({"data":{"threaded_conversation_with_injections_v2":{"instructions":[{"entries":posts.into_iter().map(super::super::tests::entry).collect::<Vec<_>>()}]}}})
}
#[test]
fn merges_all_connected_authors_and_ancestors_in_chronological_order() {
    let original = parse_post(&tweet("101", "author", "100")).unwrap();
    let mut unrelated = tweet("106", "author", "unrelated");
    unrelated["legacy"]["conversation_id_str"] = json!("unrelated");
    let pages = [
        response(vec![
            tweet("103", "author", "102"),
            tweet("100", "author", ""),
            tweet("101", "author", "100"),
            tweet("102", "author", "101"),
            tweet("104", "foreign", "101"),
            tweet("105", "author", "104"),
            unrelated,
        ]),
        response(vec![tweet("102", "author", "101")]),
    ];
    let merged = merge_detail(&original, &pages, true).unwrap();
    assert_eq!(
        parts(&merged)
            .iter()
            .map(|post| post.id.as_str())
            .collect::<Vec<_>>(),
        vec!["100", "101", "102", "103", "104", "105"]
    );
    assert_eq!(merged.thread_status, "complete");
    assert_eq!(
        merge_detail(&original, &pages, false)
            .unwrap()
            .thread_status,
        "partial"
    );
    assert!(merge_detail(
        &original,
        &[response(vec![tweet("102", "author", "101")])],
        true
    )
    .is_err());
    let mut error = response(vec![tweet("101", "author", "100")]);
    error["errors"] = json!([{"message":"failed"}]);
    assert!(merge_detail(&original, &[error], true).is_err());
}
#[test]
fn parses_full_quote_author_and_media_and_deduplicates_shared_assets() {
    let mut root = tweet("100", "author", "");
    let mut quote = tweet("90", "quoted-author", "");
    quote["legacy"]["extended_entities"] = json!({"media":[{"type":"photo","media_url_https":"https://pbs.twimg.com/media/quote.jpg"}]});
    root["quoted_status_result"] = json!({"result":{"tweet":quote}});
    root["legacy"]["quoted_status_id_str"] = json!("90");
    let parsed = parse_post(&root).unwrap();
    let quoted = parsed.quote.as_ref().unwrap();
    assert_eq!(quoted.author_id, "quoted-author");
    assert_eq!(quoted.text, "body 90");
    assert_eq!(parsed.quote_id, "90");
    assert_eq!(parsed.all_media.len(), 1);
    let mut reply = tweet("101", "author", "100");
    reply["quoted_status_result"] = root["quoted_status_result"].clone();
    let merged = merge_detail(&parsed, &[response(vec![root, reply])], true).unwrap();
    assert_eq!(merged.thread.len(), 1);
    assert_eq!(collect_media(&merged).len(), 1);
}
#[test]
fn reads_all_reply_cursors_and_preserves_api_feature_flags() {
    let module = json!({"content":{"items":[{"item":{"itemContent":{"tweet_results":{"result":tweet("101","author","100")}}}},{"item":{"itemContent":{"cursorType":"ShowMore","value":"author-cursor"}}}]}});
    let mut value = response(vec![]);
    value["data"]["threaded_conversation_with_injections_v2"]["instructions"][0]["entries"] =
        json!([module,{"content":{"cursorType":"Bottom","value":"foreign-bottom"}}]);
    assert_eq!(
        detail_posts(&value).unwrap().1,
        vec!["author-cursor", "foreign-bottom"]
    );
    let recipe = RequestRecipe {
        url: "https://x.com/i/api/graphql/saved/Bookmarks?features=%7B%22flag%22%3Atrue%7D".into(),
        headers: BTreeMap::new(),
        account: "1".into(),
    };
    let url = detail_url(&recipe, "100", "current-query", Some("continuation")).unwrap();
    let params: BTreeMap<_, _> = url.query_pairs().collect();
    assert_eq!(params["features"], "{\"flag\":true}");
    assert_eq!(
        serde_json::from_str::<Value>(&params["variables"]).unwrap()["cursor"],
        "continuation"
    );
    assert!(detail_url(&recipe, "not-a-tweet", "query", None).is_err());
}
#[test]
#[ignore = "Read-only opt-in validation of a captured public TweetDetail response"]
fn validates_real_example_with_production_parser() {
    let path = std::env::var("HUB_THREAD_FIXTURE_PATH").expect("fixture path");
    let response: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    let original = detail_posts(&response)
        .unwrap()
        .0
        .into_iter()
        .find(|post| post.id == "1840542321831735611")
        .unwrap();
    let merged = merge_detail(&original, &[response], true).unwrap();
    assert_eq!(merged.thread.len(), 36);
    assert_eq!(
        merged
            .thread
            .iter()
            .filter(|post| same_author(post, &merged) && post.quote.is_some())
            .count(),
        1
    );
    assert!(merged.all_media.len() > 12);
    assert_eq!(
        merged
            .thread
            .iter()
            .filter(|post| same_author(post, &merged))
            .count(),
        12
    );
}

#[test]
fn preserves_replies_across_page_budget_and_partial_failure_with_missing_parents() {
    let mut original = parse_post(&tweet("100", "author", "")).unwrap();
    original.thread = vec![parse_post(&tweet("101", "foreign", "100")).unwrap()];
    let mut new = tweet("103", "author", "hidden-parent");
    new["legacy"]["in_reply_to_screen_name"] = json!("foreign");
    let pending = std::collections::VecDeque::from(["next-page".to_string()]);
    let seen = HashSet::from([hash(b"previous-page")]);
    let fresh = capture_result(
        &original,
        &[response(vec![tweet("100", "author", ""), new])],
        &pending,
        &seen,
        String::new(),
    )
    .unwrap();
    assert_eq!(
        fresh
            .thread
            .iter()
            .map(|post| post.id.as_str())
            .collect::<Vec<_>>(),
        ["101", "103"]
    );
    assert_eq!(fresh.thread[1].reply_to_handle, "foreign");
    assert_eq!(fresh.thread_cursors, ["next-page"]);
    assert_eq!(fresh.thread_seen_cursors, [hash(b"previous-page")]);
    assert_eq!(fresh.thread_status, "partial");
    assert!(!capture_complete(&fresh));
    let failed = capture_result(
        &fresh,
        &[response(vec![tweet("100", "author", "")])],
        &pending,
        &seen,
        "连接暂不可用".into(),
    )
    .unwrap();
    assert_eq!(failed.thread.len(), 2);
    assert_eq!(failed.thread_status, "limited");
    assert!(!capture_complete(&failed));
    let ended = capture_result(
        &failed,
        &[response(vec![tweet("100", "author", "")])],
        &std::collections::VecDeque::new(),
        &seen,
        String::new(),
    )
    .unwrap();
    assert_eq!(ended.thread_status, "limited");
    assert!(capture_complete(&ended));
    assert!(ended.thread_error.contains("可访问"));
}
#[test]
fn ignores_terminal_bottom_and_top_but_reads_module_continuations() {
    let value = json!({"data":{"threaded_conversation_with_injections_v2":{"instructions":[
        {"type":"TimelineTerminateTimeline","direction":"Bottom"},
        {"type":"TimelineAddEntries","entries":[{"content":{"cursorType":"Bottom","value":"end"}},{"content":{"cursorType":"Top","value":"previous"}}]},
        {"type":"TimelineAddToModule","moduleItems":[{"item":{"itemContent":{"tweet_results":{"result":tweet("102","foreign","100")}}}},{"item":{"itemContent":{"cursorType":"ShowMoreThreads","value":"more"}}}]}
    ]}}});
    let (posts, cursors) = detail_posts(&value).unwrap();
    assert_eq!(posts[0].id, "102");
    assert_eq!(cursors, ["more"]);
}
#[test]
fn content_refresh_preserves_status_tags_read_flags_and_original_collection_time() {
    let mut c = super::super::tests::database();
    let original = parse_post(&tweet("100", "author", "")).unwrap();
    c.execute(
        "INSERT INTO collection_x_items VALUES('x:123:100','123',?1,'old',10,11,12,13)",
        [serde_json::to_string(&original).unwrap()],
    )
    .unwrap();
    c.execute(
        "INSERT INTO collection_x_properties VALUES('x:123:100','in_progress','[\"个人标签\"]')",
        [],
    )
    .unwrap();
    let mut fresh = original.clone();
    fresh.thread_format = 2;
    fresh.thread_status = "complete".into();
    fresh.reply_count = 0;
    save_refreshed(&mut c, "x:123:100", &fresh).unwrap();
    let times: (i64, i64, i64) = c
        .query_row(
            "SELECT collected_at,read_at,read_version FROM collection_x_items",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(times, (10, 12, 13));
    let props: (String, String) = c
        .query_row("SELECT status,tags FROM collection_x_properties", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!(props, ("in_progress".into(), "[\"个人标签\"]".into()));
    assert!(save_refreshed(&mut c, "missing", &fresh).is_err());
    assert_eq!(
        c.query_row("SELECT count(*) FROM collection_x_enrichment", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}
#[test]
#[ignore = "Read-only opt-in validation of captured public conversation pages"]
fn validates_all_captured_pages_with_production_parser() {
    let root =
        PathBuf::from(std::env::var("HUB_CONVERSATION_FIXTURE_DIR").expect("fixture directory"));
    for (id, page_count, reply_count, self_count) in [
        ("2106592140935729607", 7, 189, 0),
        ("1840542321831735611", 8, 206, 12),
    ] {
        let pages = (0..page_count)
            .map(|index| {
                serde_json::from_slice::<Value>(
                    &fs::read(root.join(format!("{id}-{index}.json"))).unwrap(),
                )
                .unwrap()
            })
            .collect::<Vec<_>>();
        let original = detail_posts(&pages[0])
            .unwrap()
            .0
            .into_iter()
            .find(|post| post.id == id)
            .unwrap();
        let fresh = capture_result(
            &original,
            &pages,
            &std::collections::VecDeque::new(),
            &HashSet::new(),
            String::new(),
        )
        .unwrap();
        assert_eq!(fresh.thread.len(), reply_count);
        assert_eq!(
            fresh
                .thread
                .iter()
                .filter(|post| same_author(post, &fresh))
                .count(),
            self_count
        );
        assert_eq!(fresh.thread_status, "limited");
        assert!(fresh.reply_count > reply_count as u64);
        assert!(parts(&fresh)
            .windows(2)
            .all(|parts| parts[0].id < parts[1].id));
        assert!(fresh.all_media.len() >= 2);
    }
}
