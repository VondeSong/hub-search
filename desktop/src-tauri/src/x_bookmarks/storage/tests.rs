use super::*;
use tokio::io::AsyncReadExt;

struct Vault(PathBuf);
impl Vault {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("hub-collection-test-{}", random_url_safe(12)));
        fs::create_dir(&path).unwrap();
        Self(fs::canonicalize(path).unwrap())
    }
}

#[tokio::test]
async fn network_partial_http_failure_restart_range_version_and_explicit_discard() {
    use crate::network_traffic_tests::{Reply, Server};
    let vault = Vault::new();
    let path = vault.0.join("resume.bin");
    let body = b"first-half-second-half".to_vec();
    let all = body.clone();
    let requests = Arc::new(Mutex::new(Vec::<String>::new()));
    let observed = requests.clone();
    let mut round = 0;
    let server = Server::new(move |request| {
        observed.lock().unwrap().push(request.headers.clone());
        round += 1;
        let mut reply = if round == 1 {
            let mut r = Reply::new(200, all.clone());
            r.cut = Some(10);
            r
        } else {
            let mut r = Reply::new(206, all[10..].to_vec());
            r.headers = format!(
                "Content-Range: bytes 10-{}/{}\r\n",
                all.len() - 1,
                all.len()
            );
            r
        };
        reply.headers.push_str("ETag: \"original\"\r\n");
        reply
    });
    let client = Server::client();
    let mut used = 0;
    let response = client.get(server.url.clone()).send().await.unwrap();
    assert!(save_response(response, &path, "resource", &mut used, true)
        .await
        .is_err());
    assert!(!path.exists());
    let partial = crate::partial_download::Partial::open(&path, "resource", None).unwrap();
    assert_eq!(partial.length(), 10);
    let response = client
        .get(server.url.clone())
        .header("Range", format!("bytes={}-", partial.length()))
        .header("If-Range", partial.validator().unwrap())
        .send()
        .await
        .unwrap();
    drop(partial);
    save_response(response, &path, "resource", &mut used, true)
        .await
        .unwrap();
    assert_eq!(fs::read(&path).unwrap(), body);
    assert_eq!(used, body.len() as u64);
    assert!(requests.lock().unwrap()[1].contains("range: bytes=10-"));
    assert_eq!(fs::read_dir(&vault.0).unwrap().count(), 1);
    let incomplete = vault.0.join("discard.bin");
    let mut stage = crate::partial_download::Partial::open(&incomplete, "discard", None).unwrap();
    fs::write(stage.data(), b"piece").unwrap();
    stage
        .checkpoint(5, format!("{:x}", Sha256::digest(b"piece")))
        .unwrap();
    drop(stage);
    assert_eq!(crate::partial_download::clear(&vault.0).unwrap(), 1);
    assert_eq!(fs::read_dir(&vault.0).unwrap().count(), 1);
}

#[tokio::test]
async fn network_http_range_rejects_wrong_version_and_200_restarts_safely() {
    use crate::network_traffic_tests::{Reply, Server};
    let vault = Vault::new();
    let path = vault.0.join("version.bin");
    let mut used = 0;
    let mut stage = crate::partial_download::Partial::open(&path, "version", None).unwrap();
    fs::write(stage.data(), b"old").unwrap();
    stage
        .checkpoint(3, format!("{:x}", Sha256::digest(b"old")))
        .unwrap();
    stage.set_validator(Some("\"old\"".into())).unwrap();
    drop(stage);
    let mut round = 0;
    let server = Server::new(move |_| {
        round += 1;
        let mut reply = Reply::new(if round == 1 { 206 } else { 200 }, b"new-full".to_vec());
        reply.headers = "ETag: \"new\"\r\n".into();
        if round == 1 {
            reply.headers.push_str("Content-Range: bytes 3-10/11\r\n");
        }
        reply
    });
    let client = Server::client();
    assert!(save_response(
        client.get(server.url.clone()).send().await.unwrap(),
        &path,
        "version",
        &mut used,
        true
    )
    .await
    .is_err());
    assert_eq!(
        fs::read(
            crate::partial_download::Partial::open(&path, "version", None)
                .unwrap()
                .data()
        )
        .unwrap(),
        b"old"
    );
    save_response(
        client.get(server.url.clone()).send().await.unwrap(),
        &path,
        "version",
        &mut used,
        true,
    )
    .await
    .unwrap();
    assert_eq!(fs::read(path).unwrap(), b"new-full");
}
impl Drop for Vault {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn item() -> Item {
    Item {
        key: "x:123:100".into(),
        collected_at: 1791165600000,
        read: false,
        post: parse_post(&super::super::tests::tweet("100")).unwrap(),
    }
}
#[test]
fn task_content_keeps_source_quote_and_reply_without_obsidian_frontmatter() {
    let mut note = item();
    note.post.text = "主帖第一段\n\n第二段原文".into();
    let mut quote = parse_post(&super::super::tests::tweet("90")).unwrap();
    quote.text = "引用原帖全文".into();
    note.post.quote = Some(Box::new(quote));
    let mut reply = parse_post(&super::super::tests::tweet("101")).unwrap();
    reply.text = "最后一条回复全文".into();
    note.post.thread = vec![reply];
    let body = render_task_content(&note);
    for text in [
        "主帖第一段\n\n第二段原文",
        "引用原帖全文",
        "最后一条回复全文",
        &note.post.url,
    ] {
        assert!(body.contains(text), "{text}");
    }
    assert!(!body.starts_with("---\n"));
    assert!(!body.contains("标签: []"));
    assert!(!body.contains("创建日期:"));
    assert_eq!(body.matches("主帖第一段").count(), 1);
    assert!(body.find("引用原帖全文").unwrap() < body.find("最后一条回复全文").unwrap());
    assert!(render(&note, &[]).starts_with("---\n喜欢:"));
}

#[test]
fn thread_and_structured_quote_share_one_note_and_embed_local_assets_at_their_source() {
    let mut note = item();
    note.post.text = "主帖正文".into();
    let mut quote = parse_post(&super::super::tests::tweet("90")).unwrap();
    quote.text = "被引用原帖正文".into();
    quote.author_name = "引用作者".into();
    quote.media = vec![Media {
        kind: "photo".into(),
        url: "https://pbs.twimg.com/quoted.jpg".into(),
        preview_url: String::new(),
    }];
    let mut reply = parse_post(&super::super::tests::tweet("101")).unwrap();
    reply.text = "楼主补充正文".into();
    reply.quote = Some(Box::new(quote));
    reply.quoted_text = "被引用原帖正文".into();
    note.post.thread = vec![reply];
    note.post.all_media = threads::collect_media(&note.post);
    let markdown = render(&note, &[Some("99_Meta/assets/X_assets/quoted.jpg".into())]);
    assert_eq!(markdown.matches("# 主帖正文").count(), 1);
    assert_eq!(markdown.matches("楼主补充正文").count(), 1);
    assert_eq!(markdown.matches("被引用原帖正文").count(), 1);
    assert!(!markdown.contains("楼主续帖"));
    assert!(markdown.contains("## [Reader @reader]"));
    assert!(markdown.contains("引用作者 @reader"));
    assert!(markdown.contains("> ![[99_Meta/assets/X_assets/quoted.jpg]]"));
    assert!(markdown.contains("https://x.com/i/status/90"));
}

#[test]
fn title_names_match_hub_and_handle_windows_and_obsidian_characters() {
    let vault = Vault::new();
    let c = super::super::tests::database();
    schema(&c).unwrap();
    let mut note = item();
    note.post.text = "  推文标题 👻\n第二行正文  ".into();
    assert_eq!(titles::display_title(&note), "推文标题 👻");
    assert_eq!(
        titles::relative_path(&c, &vault.0, "vault", &note, None).unwrap(),
        "X/书签/推文标题 👻.md"
    );
    assert!(render(&note, &[]).contains("# 推文标题 👻\n"));
    note.post.text = "测试: https://t.co/a?b=1 #标签 [内容] | ^ * \" < > \\".into();
    let relative = titles::relative_path(&c, &vault.0, "vault", &note, None).unwrap();
    assert!(relative.contains("https：／／t.co／a？b=1 ＃标签 ［内容］ ｜ ＾ ＊ ＂ ＜ ＞ ＼"));
    assert!(write_note(
        &safe_path(&vault.0, &relative, false).unwrap(),
        "safe",
        None
    )
    .unwrap());
    for title in ["CON", "nul.txt", "COM1", "LPT²"] {
        note.post.text = title.into();
        assert!(titles::relative_path(&c, &vault.0, "vault", &note, None)
            .unwrap()
            .starts_with("X/书签/_"));
    }
    note.post.text = "😀".repeat(100);
    assert_eq!(titles::display_title(&note).encode_utf16().count(), 160);
    let relative = titles::relative_path(&c, &vault.0, "vault", &note, None).unwrap();
    assert!(
        vault
            .0
            .join(relative)
            .to_string_lossy()
            .trim_start_matches("\\\\?\\")
            .encode_utf16()
            .count()
            <= 240
    );
}

#[test]
fn title_migration_preserves_manual_content_and_never_overwrites_other_notes() {
    let vault = Vault::new();
    let c = super::super::tests::database();
    schema(&c).unwrap();
    let mut note = item();
    note.post.text = "标题".into();
    let old = "X/书签/100.md";
    let old_path = safe_path(&vault.0, old, false).unwrap();
    let body = "---\n标签: [我的标签]\n---\n\n手写正文\n![[99_Meta/assets/X_assets/a.png]]";
    fs::write(&old_path, body).unwrap();
    c.execute(
        "INSERT INTO collection_obsidian_exports(destination,item_key,relative_path,file_hash,input_hash,media_pending) VALUES(?1,?2,?3,?4,?5,0)",
        params!["vault", note.key, old, "old-owned-hash", "input"],
    )
    .unwrap();
    let occupied = safe_path(&vault.0, "X/书签/标题.md", false).unwrap();
    fs::write(&occupied, "其他页面").unwrap();
    let relative = titles::relative_path(&c, &vault.0, "vault", &note, Some(old)).unwrap();
    assert_eq!(relative, "X/书签/标题 — 100.md");
    assert!(!old_path.exists());
    assert_eq!(fs::read_to_string(vault.0.join(&relative)).unwrap(), body);
    assert_eq!(fs::read_to_string(occupied).unwrap(), "其他页面");
    let stored: (String, String) = c
        .query_row(
            "SELECT relative_path,file_hash FROM collection_obsidian_exports",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(stored, (relative.clone(), "old-owned-hash".into()));
    assert_eq!(
        titles::relative_path(&c, &vault.0, "vault", &note, Some(&relative)).unwrap(),
        relative
    );
    let mut duplicate = item();
    duplicate.post.text = note.post.text.clone();
    duplicate.key = "x:123:101".into();
    duplicate.post.id = "101".into();
    assert_eq!(
        titles::relative_path(&c, &vault.0, "vault", &duplicate, None).unwrap(),
        "X/书签/标题 — 101.md"
    );
    assert_eq!(fs::read_dir(vault.0.join("X/书签")).unwrap().count(), 2);
    note.post.text = "新标题".into();
    let renamed = titles::relative_path(&c, &vault.0, "vault", &note, Some(&relative)).unwrap();
    assert_eq!(renamed, "X/书签/新标题.md");
    assert_eq!(fs::read_to_string(vault.0.join(renamed)).unwrap(), body);
}

#[test]
fn vault_layout_frontmatter_types_and_manual_edits_are_preserved() {
    let vault = Vault::new();
    let config = StorageConfig {
        mode: "obsidian".into(),
        vault_path: vault.0.to_string_lossy().into_owned(),
        ..Default::default()
    };
    let root = validate(&config).unwrap().unwrap();
    for dir in ["X/书签", "X/喜欢", ASSETS] {
        assert!(root.join(dir).is_dir());
    }
    let mut item = item();
    item.post.author_name = "名字: \"引用\"\n多行".into();
    let text = render(&item, &[]);
    let frontmatter = text.split("---\n").nth(1).unwrap();
    let value: serde_yaml::Value = serde_yaml::from_str(frontmatter).unwrap();
    let keys: Vec<_> = value
        .as_mapping()
        .unwrap()
        .keys()
        .map(|k| k.as_str().unwrap())
        .collect();
    assert_eq!(
        keys,
        vec![
            "喜欢",
            "标签",
            "状态",
            "发布时间",
            "作者",
            "地址",
            "创建日期"
        ]
    );
    assert_eq!(value["喜欢"].as_bool(), Some(false));
    assert!(value["标签"].as_sequence().unwrap().is_empty());
    assert_eq!(value["状态"].as_str(), Some("待读"));
    assert!(!value["发布时间"].as_str().unwrap().is_empty());
    let path = safe_path(&root, "X/书签/100.md", false).unwrap();
    assert!(write_note(&path, &text, None).unwrap());
    assert!(write_note(&path, &text, None).unwrap()); // crash recovery / same content is idempotent
    item.read = true;
    let updated = render(&item, &[]);
    assert!(write_note(&path, &updated, Some(&hash(text.as_bytes()))).unwrap());
    assert!(fs::read_to_string(&path).unwrap().contains("已读"));
    let manual = updated.replace("标签: []", "标签: [我的标签]") + "\n我的笔记";
    fs::write(&path, &manual).unwrap();
    assert!(!write_note(&path, &text, Some(&hash(updated.as_bytes()))).unwrap());
    assert_eq!(fs::read_to_string(&path).unwrap(), manual);
    assert_eq!(fs::read_dir(root.join("X/书签")).unwrap().count(), 1);
    item.post.source = "likes".into();
    assert!(render(&item, &[]).contains("喜欢: true"));
}

#[test]
fn path_escape_and_unrelated_existing_notes_are_rejected() {
    let vault = Vault::new();
    for path in [
        "../escape",
        "C:/escape",
        "/absolute",
        "X/../../outside",
        "X\\escape",
        "X/dir./a",
        "X//a",
    ] {
        assert!(safe_path(&vault.0, path, false).is_err(), "{path}");
    }
    let path = safe_path(&vault.0, "X/书签/100.md", false).unwrap();
    fs::write(&path, "existing unrelated content").unwrap();
    assert!(!write_note(&path, &render(&item(), &[]), None).unwrap());
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "existing unrelated content"
    );
    assert!(!fs::read_dir(path.parent().unwrap()).unwrap().any(|f| f
        .unwrap()
        .path()
        .extension()
        .is_some_and(|v| v == "tmp")));
}

#[test]
fn media_urls_never_accept_credentials_or_offsite_hosts() {
    assert!(asset_url("https://video.twimg.com/a.mp4?tag=12").is_some());
    for url in [
        "http://video.twimg.com/a.mp4",
        "https://video.twimg.com.attacker.test/a.mp4",
        "https://user:pass@video.twimg.com/a.mp4",
        "https://127.0.0.1/a",
        "file:///a",
        "https://video.twimg.com:999/a",
    ] {
        assert!(asset_url(url).is_none());
    }
    let cfg = serde_json::to_value(StorageConfig::default()).unwrap();
    assert!(cfg.get("maxFileMb").is_none());
    assert!(cfg.get("maxBatchMb").is_none());
}

#[test]
fn export_inputs_detect_changes_but_keep_collection_time() {
    let mut c = super::super::tests::database();
    schema(&c).unwrap();
    let page = super::super::tests::response(vec![super::super::tests::entry(
        super::super::tests::tweet("100"),
    )]);
    persist_page(&mut c, "123", &parse_page(&page).unwrap(), 1234).unwrap();
    let cfg = StorageConfig::default();
    let first = rows(&c, None, &cfg).unwrap();
    let rescheduled = StorageConfig {
        auto_sync_minutes: 45,
        local_sources_minutes: 120,
        ..cfg.clone()
    };
    assert_eq!(
        first[0].input,
        rows(&c, None, &rescheduled).unwrap()[0].input
    );
    c.execute(
        "UPDATE collection_x_items SET read_at=2000,read_version=1",
        [],
    )
    .unwrap();
    let updated = rows(&c, Some("x:123:100"), &cfg).unwrap();
    assert_ne!(first[0].input, updated[0].input);
    assert_eq!(updated[0].item.collected_at, 1234);
    assert!(rows(&c, Some("missing"), &cfg).unwrap().is_empty());
}

// The HTTP body has no Content-Length and exceeds the old suggested 50 MB limit.
// Exercise the same streaming writer used in production without contacting X.
#[tokio::test]
async fn large_chunked_video_streams_to_disk_and_invalid_download_leaves_no_file() {
    CANCEL.store(false, Ordering::Relaxed);
    let vault = Vault::new();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        for valid in [true, false] {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 4096];
            socket.read(&mut request).await.unwrap();
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
            if valid {
                let mut block = vec![0u8; 1024 * 1024];
                block[..24].copy_from_slice(b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom");
                for _ in 0..65 {
                    socket.write_all(b"100000\r\n").await.unwrap();
                    socket.write_all(&block).await.unwrap();
                    socket.write_all(b"\r\n").await.unwrap();
                }
            } else {
                socket.write_all(b"d\r\n<html></html>\r\n").await.unwrap();
            }
            socket.write_all(b"0\r\n\r\n").await.unwrap();
        }
    });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let path = vault.0.join("large.mp4");
    let mut used = 0;
    let response = client
        .get(format!("http://{address}/large"))
        .send()
        .await
        .unwrap();
    save_response(response, &path, "large-fixture", &mut used, false)
        .await
        .unwrap();
    assert_eq!(fs::metadata(&path).unwrap().len(), 65 * 1024 * 1024);
    assert_eq!(used, 65 * 1024 * 1024);
    let second_vault = Vault::new();
    let local_copy = second_vault.0.join("copy.mp4");
    assert!(copy_completed_asset(&path, &local_copy, false)
        .await
        .unwrap());
    assert_eq!(fs::metadata(&local_copy).unwrap().len(), 65 * 1024 * 1024);
    // Reusing a completed local download does not count as network transfer.
    assert_eq!(used, 65 * 1024 * 1024);
    CANCEL.store(true, Ordering::Relaxed);
    let cancelled = second_vault.0.join("cancelled.mp4");
    assert!(copy_completed_asset(&path, &cancelled, false)
        .await
        .is_err());
    assert!(!cancelled.exists());
    CANCEL.store(false, Ordering::Relaxed);
    assert_eq!(fs::read_dir(&second_vault.0).unwrap().count(), 1);
    let invalid = vault.0.join("invalid.mp4");
    let response = client
        .get(format!("http://{address}/invalid"))
        .send()
        .await
        .unwrap();
    assert!(
        save_response(response, &invalid, "invalid-fixture", &mut used, false)
            .await
            .is_err()
    );
    assert!(!invalid.exists());
    assert_eq!(fs::read_dir(&vault.0).unwrap().count(), 1);
    server.await.unwrap();
}

#[test]
fn schedule_defaults_migrate_and_can_be_disabled() {
    let old = r#"{"mode":"obsidian","vaultPath":"D:/existing-vault","downloadMedia":false}"#;
    let migrated: StorageConfig = serde_json::from_str(old).unwrap();
    assert_eq!(migrated.auto_sync_minutes, 30);
    assert_eq!(migrated.vault_path, "D:/existing-vault");
    assert!(!migrated.download_media);
    for minutes in [0, 5, 30, 1440] {
        assert!(validate(&StorageConfig {
            auto_sync_minutes: minutes,
            ..Default::default()
        })
        .is_ok());
    }
    for minutes in [1, 4, 1441] {
        assert!(validate(&StorageConfig {
            auto_sync_minutes: minutes,
            ..Default::default()
        })
        .is_err());
    }
}

#[test]
fn preserves_distinct_video_versions_at_their_source_and_embeds_identical_urls_once() {
    let mut note = item();
    note.post.media = vec![Media {
        kind: "video".into(),
        url: "https://video.twimg.com/own.mp4".into(),
        preview_url: String::new(),
    }];
    let mut quote = note.post.clone();
    quote.id = "90".into();
    quote.media[0].url = "https://video.twimg.com/quoted.mp4".into();
    note.post.quote = Some(Box::new(quote));
    let mut reply = note.post.clone();
    reply.id = "101".into();
    reply.reply_to_id = "99".into();
    reply.reply_to_handle = "another".into();
    reply.quote = None;
    note.post.thread = vec![reply];
    note.post.all_media = threads::collect_media(&note.post);
    let markdown = render(&note, &[Some("own.mp4".into()), Some("quoted.mp4".into())]);
    assert_eq!(markdown.matches("![[own.mp4]]").count(), 1);
    assert_eq!(markdown.matches("![[quoted.mp4]]").count(), 1);
    assert!(markdown.find("**本帖附件**").unwrap() < markdown.find("**引用原帖").unwrap());
    assert!(markdown.contains("回复 @another"));
    assert!(!markdown.contains("楼主续帖"));
    note.post.thread_status = "limited".into();
    note.post.thread_format = 2;
    note.post.reply_count = 295;
    let markdown = render(&note, &[]);
    assert!(markdown.contains("已获取 1 条回复 · X 显示 295 条"));
    assert!(markdown.contains("可访问"));
    assert!(!markdown.contains("楼主串帖尚待补全"));
}

#[test]
fn local_intake_frequency_is_independent_and_validated() {
    let old: StorageConfig =
        serde_json::from_str(r#"{"mode":"database","autoSyncMinutes":60}"#).unwrap();
    assert_eq!(old.local_sources_minutes, 0);
    assert_eq!(old.auto_sync_minutes, 60);
    for minutes in [0, 5, 60, 1440] {
        let cfg = StorageConfig {
            local_sources_minutes: minutes,
            ..old.clone()
        };
        assert!(validate_intervals(&cfg).is_ok());
        let restored: StorageConfig =
            serde_json::from_str(&serde_json::to_string(&cfg).unwrap()).unwrap();
        assert_eq!(restored.local_sources_minutes, minutes);
        assert_eq!(restored.auto_sync_minutes, 60);
    }
    for minutes in [1, 4, 1441] {
        assert!(validate_intervals(&StorageConfig {
            local_sources_minutes: minutes,
            ..old.clone()
        })
        .is_err());
    }
}
