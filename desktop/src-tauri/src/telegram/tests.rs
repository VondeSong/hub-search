use super::*;

fn db() -> Connection {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)")
        .unwrap();
    schema(&c).unwrap();
    crate::x_bookmarks::storage::schema(&c).unwrap();
    c
}
fn cfg() -> Inbox {
    Inbox {
        bot_id: 7,
        username: "hub_collect_bot".into(),
        user_id: 42,
        enabled: true,
        ..Inbox::default()
    }
}
fn message(id: i64, text: &str) -> Value {
    json!({"message_id":id,"date":1727740800+id,"chat":{"id":42,"type":"private"},"from":{"id":42,"first_name":"Collector","username":"owner"},"text":text})
}
fn update(id: i64, message: Value) -> Value {
    json!({"update_id":id,"message":message})
}
fn items(c: &Connection, source: &str) -> Vec<Value> {
    crate::x_bookmarks::query_collection_items(
        c,
        String::new(),
        false,
        0,
        Some(source.into()),
        None,
        None,
        None,
        None,
        None,
    )
    .unwrap()
    .3
}
#[test]
fn inbox_is_in_the_shared_collection_and_replays_preserve_read_tags_and_dates() {
    let mut c = db();
    let mut cfg = cfg();
    let updates = vec![update(1, message(9, "A saved note"))];
    assert_eq!(
        persist_updates(&mut c, &mut cfg, &updates, 2000)
            .unwrap()
            .added,
        1
    );
    let key = "telegram:7:42:9";
    c.execute(
        "UPDATE collection_x_items SET read_at=44,read_version=8 WHERE item_key=?1",
        [key],
    )
    .unwrap();
    c.execute(
        "INSERT INTO collection_x_properties VALUES(?1,'in_progress','[\"学习\"]')",
        [key],
    )
    .unwrap();
    let mut replay = cfg.clone();
    replay.offset = 0;
    assert_eq!(
        persist_updates(&mut c, &mut replay, &updates, 3000)
            .unwrap()
            .changed,
        0
    );
    let mut edit = message(9, "Edited note");
    edit["edit_date"] = json!(3001);
    assert_eq!(
        persist_updates(
            &mut c,
            &mut cfg,
            &[json!({"update_id":2,"edited_message":edit})],
            4000
        )
        .unwrap()
        .changed,
        1
    );
    let result = items(&c, "telegram");
    assert_eq!(result.len(), 1);
    assert_eq!(items(&c, "all").len(), 1);
    assert!(items(&c, "bookmarks").is_empty());
    assert!(items(&c, "likes").is_empty());
    assert_eq!(result[0]["status"], "in_progress");
    assert_eq!(result[0]["tags"], json!(["学习"]));
    assert_eq!(result[0]["collectedAt"], 2000000);
    assert_eq!(result[0]["post"]["text"], "Edited note");
    assert!(result[0]["read"].as_bool().unwrap());
    assert_eq!(inbox(&c).unwrap().offset, 3);
}
#[test]
fn pairing_only_accepts_the_confirmation_code_and_private_owner_messages() {
    let mut c = db();
    let mut cfg = Inbox {
        bot_id: 7,
        username: "bot".into(),
        pair_code: "hub_confirm".into(),
        pair_expires: 9000,
        enabled: true,
        ..Inbox::default()
    };
    let mut group = message(1, "/start hub_confirm");
    group["chat"]["type"] = json!("group");
    let mut other = message(5, "another user");
    other["from"]["id"] = json!(43);
    other["chat"]["id"] = json!(43);
    let updates = vec![
        update(1, message(1, "unconfirmed")),
        update(2, group),
        update(3, message(2, "/start hub_confirm")),
        update(4, message(3, "my note")),
        update(5, other),
    ];
    let stats = persist_updates(&mut c, &mut cfg, &updates, 1000).unwrap();
    assert_eq!(cfg.user_id, 42);
    assert!(cfg.pair_code.is_empty());
    assert_eq!(cfg.offset, 6);
    assert_eq!(stats.added, 1);
    assert_eq!(stats.ignored, 4);
    assert_eq!(items(&c, "all")[0]["post"]["text"], "my note");
}
#[test]
fn album_late_members_and_edits_update_one_page_in_message_order() {
    let mut c = db();
    let mut cfg = cfg();
    let photo = |id: i64, caption: &str| {
        let mut m = message(id, "");
        m.as_object_mut().unwrap().remove("text");
        m["caption"] = json!(caption);
        m["media_group_id"] = json!("album1");
        m["photo"] = json!([{"file_id":format!("small_{id}"),"width":10,"height":10},{"file_id":format!("large_{id}"),"width":100,"height":100}]);
        m
    };
    let first = photo(12, "Second caption");
    let early = photo(11, "First caption");
    assert_eq!(
        persist_updates(&mut c, &mut cfg, &[update(1, first)], 1000)
            .unwrap()
            .added,
        1
    );
    assert_eq!(
        persist_updates(&mut c, &mut cfg, &[update(2, early.clone())], 2000)
            .unwrap()
            .changed,
        1
    );
    let result = items(&c, "all");
    assert_eq!(result.len(), 1);
    assert_eq!(result[0]["key"], "telegram:7:42:album:album1");
    assert_eq!(result[0]["post"]["id"], "11");
    assert_eq!(result[0]["post"]["text"], "First caption\n\nSecond caption");
    assert_eq!(result[0]["post"]["media"].as_array().unwrap().len(), 2);
    let mut edited = early;
    edited["caption"] = json!("Revised first");
    persist_updates(
        &mut c,
        &mut cfg,
        &[json!({"update_id":3,"edited_message":edited})],
        3000,
    )
    .unwrap();
    assert_eq!(
        items(&c, "all")[0]["post"]["text"],
        "Revised first\n\nSecond caption"
    );
}
#[test]
fn a_bad_message_rolls_back_both_items_and_the_acknowledgement_offset() {
    let mut c = db();
    let mut cfg = cfg();
    let mut bad = message(2, "invalid");
    bad["date"] = json!("bad");
    assert!(persist_updates(
        &mut c,
        &mut cfg,
        &[update(1, message(1, "valid")), update(2, bad)],
        1000
    )
    .is_err());
    assert_eq!(cfg.offset, 0);
    assert!(items(&c, "all").is_empty());
    assert_eq!(inbox(&c).unwrap().offset, 0);
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM collection_telegram_messages",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}
#[test]
fn forwards_files_and_unicode_links_preserve_source_without_token_urls() {
    let mut m = message(1, "😀 https://example.com");
    m["entities"] = json!([{"type":"url","offset":3,"length":19}]);
    m["forward_origin"] = json!({"type":"channel","date":1,"chat":{"id":-123,"title":"Research","username":"research"},"message_id":90});
    m["document"] = json!({"file_id":"document_id","file_name":"../研究报告.pdf"});
    let post = normalize_message(&cfg(), &m).unwrap();
    assert_eq!(post.author_name, "Research");
    assert_eq!(post.url, "https://t.me/research/90");
    assert_eq!(post.origin.as_ref().unwrap().name, "Research");
    assert_eq!(post.links, vec!["https://example.com"]);
    assert!(post.media[0].url.starts_with("telegram://7/document_id/"));
    assert_eq!(media_extension(&post.media[0]), "pdf");
    let serialized = serde_json::to_string(&post).unwrap();
    assert!(!serialized.contains("api.telegram.org"));
    assert!(!serialized.contains("bot7:"));
    assert!(entity_slice("😀", 1, 1).is_none());
}
#[test]
fn a_large_video_keeps_its_local_thumbnail_identity_and_sanitized_error() {
    let mut m = message(1, "");
    m["video"] =
        json!({"file_id":"video_id","file_size":50000000,"thumbnail":{"file_id":"thumb_id"}});
    let post = normalize_message(&cfg(), &m).unwrap();
    assert_eq!(post.text, "视频.mp4");
    assert_eq!(post.media[0].kind, "video");
    assert!(post.media[0].preview_url.contains("thumb_id"));
    let error = api_error(
        400,
        &json!({"description":"Bad Request: file is too big bot7:SECRET"}),
    );
    assert!(error.message.contains("20 MB"));
    assert!(!error.message.contains("SECRET"));
    assert!(!error.blocked);
    assert!(api_error(409, &json!({})).blocked);
    assert_eq!(
        api_error(429, &json!({"parameters":{"retry_after":300}})).retry,
        300
    );
}
#[test]
fn shared_obsidian_renderer_uses_the_hub_title_origin_and_local_attachments() {
    let mut m = message(12, "A collected title\nBody of the note");
    m["forward_origin"] = json!({"type":"channel","date":1,"chat":{"id":-123,"title":"Research","username":"research"},"message_id":90});
    m["document"] = json!({"file_id":"document_id","file_name":"paper.pdf"});
    let mut post = normalize_message(&cfg(), &m).unwrap();
    post.all_media = post.media.clone();
    let item = crate::collection_models::Item {
        key: "telegram:7:42:12".into(),
        post,
        collected_at: 1727740800000,
        read: false,
    };
    let note = crate::x_bookmarks::storage::render(
        &item,
        &[Some("99_Meta/assets/Telegram_assets/paper.pdf".into())],
    );
    assert!(note.contains("# A collected title\n"));
    assert!(note.contains("转发自 Research"));
    assert!(note.contains("![[99_Meta/assets/Telegram_assets/paper.pdf]]"));
    assert!(note.contains("[打开 Telegram 来源](<https://t.me/research/90>)"));
    assert!(!note.contains("打开 X 原文"));
    assert!(!note.contains("api.telegram.org"));
}
#[test]
fn publication_sort_compares_telegram_dates_with_x_snowflakes() {
    let mut c = db();
    let mut cfg = cfg();
    persist_updates(
        &mut c,
        &mut cfg,
        &[update(1, message(9, "October note"))],
        2000,
    )
    .unwrap();
    let post = Post {
        id: "1840542321831735611".into(),
        source: "bookmarks".into(),
        text: "September tweet".into(),
        ..Post::default()
    };
    c.execute("INSERT INTO collection_x_items VALUES('x:123:1840542321831735611','123',?1,'hash',1,1,0,0)",[serde_json::to_string(&post).unwrap()]).unwrap();
    let run = |ascending| {
        crate::x_bookmarks::query_collection_items(
            &c,
            String::new(),
            false,
            0,
            Some("all".into()),
            None,
            None,
            Some("published".into()),
            Some(ascending),
            None,
        )
        .unwrap()
        .3
    };
    assert_eq!(run(true)[0]["post"]["source"], "bookmarks");
    assert_eq!(run(false)[0]["post"]["source"], "telegram");
}
#[tokio::test]
async fn connection_validation_keeps_existing_webhook_and_never_consumes_updates() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        for (method, result) in [
            ("getMe", json!({"id":7,"is_bot":true,"username":"test_bot"})),
            (
                "getWebhookInfo",
                json!({"url":"https://existing.example/receiver"}),
            ),
        ] {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = [0; 4096];
            let n = socket.read(&mut buf).await.unwrap();
            assert!(String::from_utf8_lossy(&buf[..n]).starts_with(&format!(
                "POST /bot7:abcdefghijklmnopqrst/{method} HTTP/1.1"
            )));
            let body = json!({"ok":true,"result":result}).to_string();
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        }
    });
    let api = Api {
        client: reqwest::Client::builder().no_proxy().build().unwrap(),
        base: format!("http://{address}"),
    };
    let error = validate_bot(&api, "7:abcdefghijklmnopqrst")
        .await
        .unwrap_err();
    assert!(error.contains("已有 webhook"));
    assert!(!error.contains("abcdefghijklmnopqrst"));
    server.await.unwrap();
}
#[tokio::test]
async fn protocol_receiver_commits_before_advancing_the_next_request() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        for expected in [0, 2] {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = vec![];
            let request = loop {
                let mut buf = [0; 4096];
                let size = socket.read(&mut buf).await.unwrap();
                assert!(size > 0);
                bytes.extend_from_slice(&buf[..size]);
                if let Some(split) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..split]);
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|s| s.trim().parse::<usize>().unwrap())
                        })
                        .unwrap();
                    if bytes.len() >= split + 4 + length {
                        break (
                            headers.to_string(),
                            serde_json::from_slice::<Value>(&bytes[split + 4..]).unwrap(),
                        );
                    }
                }
            };
            assert!(request
                .0
                .starts_with("POST /bot7:TEST_TOKEN/getUpdates HTTP/1.1"));
            assert_eq!(request.1["offset"], expected);
            assert_eq!(
                request.1["allowed_updates"],
                json!(["message", "edited_message"])
            );
            let body = if expected == 0 {
                json!({"ok":true,"result":[update(1,message(1,"A note"))]})
            } else {
                json!({"ok":true,"result":[]})
            }
            .to_string();
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        }
    });
    let api = Api {
        client: reqwest::Client::builder().no_proxy().build().unwrap(),
        base: format!("http://{address}"),
    };
    let mut cfg = cfg();
    let mut c = db();
    let updates = fetch_updates(&api, "7:TEST_TOKEN", &cfg).await.unwrap();
    persist_updates(&mut c, &mut cfg, &updates, 1000).unwrap();
    assert_eq!(inbox(&c).unwrap().offset, 2);
    assert_eq!(items(&c, "all")[0]["post"]["text"], "A note");
    assert!(fetch_updates(&api, "7:TEST_TOKEN", &inbox(&c).unwrap())
        .await
        .unwrap()
        .is_empty());
    server.await.unwrap();
}
