use super::*;

fn fixture() -> (Connection, PathBuf) {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../artifacts/local-sources-tests")
        .join(random_url_safe(12));
    fs::create_dir_all(root.join("X")).unwrap();
    fs::create_dir_all(root.join("Telegram")).unwrap();
    let root = root.canonicalize().unwrap();
    let mut c = super::super::tests::database();
    storage::schema(&c).unwrap();
    set_root(&mut c, &root);
    (c, root)
}
fn set_root(c: &mut Connection, root: &Path) {
    meta(
        c,
        "collection_storage_v1",
        &json!({"mode":"obsidian","vaultPath":root,"downloadMedia":true,"autoSyncMinutes":0})
            .to_string(),
    )
    .unwrap();
}
fn note(root: &Path, name: &str, body: &str) {
    let path = root.join(name);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, body).unwrap();
}
fn x(id: &str, body: &str) -> String {
    format!("---\nurl: https://x.com/example/status/{id}\nx_id: '{id}'\nauthor: Example\ndate: '2026-10-14T10:00:00+08:00'\n状态: 待读\ntags: [知识]\n---\n\n{body}\n")
}
fn keys(c: &Connection) -> Vec<String> {
    c.prepare("SELECT item_key FROM collection_x_items ORDER BY item_key")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}
fn post(c: &Connection, key: &str) -> Post {
    serde_json::from_str(
        &c.query_row(
            "SELECT post_json FROM collection_x_items WHERE item_key=?1",
            [key],
            |r| r.get::<_, String>(0),
        )
        .unwrap(),
    )
    .unwrap()
}

#[test]
fn new_local_files_reach_the_real_reading_query_without_a_registered_library() {
    let (mut c, root) = fixture();
    note(
        &root,
        "X/first.md",
        &x(
            "1000000000000000001",
            "# 有意义的正文\n\n这是原文 #作者标签",
        ),
    );
    note(
        &root,
        "Telegram/raw.md",
        "**Forwarded from [Channel](https://t.me/channel)**\n\n消息正文",
    );
    assert_eq!(scan(&mut c).unwrap().changed, 2);
    let all = super::super::reading_sync_test_items_all(&c, "all");
    assert_eq!(all.len(), 2);
    let posts: Vec<Post> = keys(&c).iter().map(|k| post(&c, k)).collect();
    assert!(posts
        .iter()
        .any(|p| p.source == "telegram" && p.origin.as_ref().unwrap().name == "Channel"));
    assert_eq!(
        posts
            .iter()
            .find(|p| p.source == "bookmarks")
            .unwrap()
            .published_at,
        "2026-10-14T10:00:00+08:00"
    );
    let tags: Vec<String> = c
        .prepare("SELECT tags FROM collection_x_properties")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert!(!tags.join("").contains("作者标签"));
    assert_eq!(scan(&mut c).unwrap().changed, 0);
}

#[test]
fn duplicates_and_rename_preserve_reading_state_and_source_bytes() {
    let (mut c, root) = fixture();
    let raw = x("1000000000000000002", "不变的正文");
    note(&root, "X/original.md", &raw);
    scan(&mut c).unwrap();
    let key = keys(&c).remove(0);
    properties::save_local(&mut c, &key, "read", &["自选".into()]).unwrap();
    let state: (i64, i64) = c
        .query_row(
            "SELECT read_at,read_version FROM collection_x_items WHERE item_key=?1",
            [&key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    note(&root, "X/copy.md", &raw);
    scan(&mut c).unwrap();
    assert_eq!(keys(&c), vec![key.clone()]);
    fs::rename(root.join("X/original.md"), root.join("X/renamed.md")).unwrap();
    scan(&mut c).unwrap();
    assert_eq!(keys(&c), vec![key.clone()]);
    assert_eq!(fs::read_to_string(root.join("X/renamed.md")).unwrap(), raw);
    assert_eq!(
        c.query_row(
            "SELECT read_at,read_version FROM collection_x_items WHERE item_key=?1",
            [&key],
            |r| Ok((r.get(0)?, r.get(1)?))
        )
        .unwrap(),
        state
    );
    assert_eq!(
        properties::load(&c, &key, true).unwrap(),
        ("read".into(), vec!["自选".into()])
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM collection_x_outbox", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
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
fn late_media_and_content_updates_keep_the_same_key_state_and_local_media_contract() {
    let (mut c, root) = fixture();
    note(
        &root,
        "Telegram/late.md",
        "消息原文\n\n![[Telegram/photos/late.png]]",
    );
    scan(&mut c).unwrap();
    let key = keys(&c).remove(0);
    assert_eq!(post(&c, &key).content_status, "partial");
    properties::save_local(&mut c, &key, "in_progress", &[]).unwrap();
    note(&root, "Telegram/photos/late.png", "image bytes");
    scan(&mut c).unwrap();
    assert_eq!(keys(&c), vec![key.clone()]);
    let p = post(&c, &key);
    assert_eq!(p.media.len(), 1);
    assert!(p.content_status.is_empty());
    assert!(!p.text.contains("![["));
    let path: String = c
        .query_row(
            "SELECT path FROM collection_saved_media WHERE item_key=?1 AND media_url=?2",
            params![key, p.media[0].url],
            |r| r.get(0),
        )
        .unwrap();
    assert!(Path::new(&path).is_file());
    note(
        &root,
        "Telegram/late.md",
        "消息原文\n\n补充段落\n\n![[Telegram/photos/late.png]]",
    );
    scan(&mut c).unwrap();
    assert!(post(&c, &key).text.contains("补充段落"));
    assert_eq!(properties::load(&c, &key, false).unwrap().0, "in_progress");
    assert_eq!(keys(&c).len(), 1);
}

#[test]
fn native_imports_before_or_after_intake_do_not_duplicate_or_overwrite_reading() {
    let (mut c, root) = fixture();
    let id = "1000000000000000003";
    let incoming = Post {
        id: id.into(),
        text: "Hub 的完整原文和回复".into(),
        url: format!("https://x.com/example/status/{id}"),
        ..Default::default()
    };
    super::super::reading_sync_test_import(&mut c, incoming.clone());
    let key = keys(&c).remove(0);
    let original = post(&c, &key);
    properties::save_local(&mut c, &key, "read", &[]).unwrap();
    note(&root, "X/native.md", &x(id, "另一份历史原文"));
    scan(&mut c).unwrap();
    assert_eq!(keys(&c), vec![key.clone()]);
    assert_eq!(post(&c, &key), original);
    assert!(!owns(&c, &key).unwrap());
    note(&root, "X/local.md", &x("1000000000000000004", "本地先到"));
    scan(&mut c).unwrap();
    super::super::reading_sync_test_import(
        &mut c,
        Post {
            id: "1000000000000000004".into(),
            text: "后来 API 同步".into(),
            ..Default::default()
        },
    );
    assert_eq!(keys(&c).len(), 2);
    assert!(keys(&c).iter().any(|k| post(&c, k).text == "本地先到"));
}

#[test]
fn legacy_source_mirror_receipts_are_adopted_without_resetting_content_or_read_state() {
    let (mut c, root) = fixture();
    let raw = x("1000000000000000005", "历史原文");
    note(&root, "X/legacy.md", &raw);
    let old = Post {
        id: "1000000000000000005".into(),
        text: "旧导入的正文必须原样保留".into(),
        source: "bookmarks".into(),
        ..Default::default()
    };
    super::super::reading_sync_test_import(&mut c, old);
    let key = keys(&c).remove(0);
    let before = post(&c, &key);
    properties::save_local(&mut c, &key, "read", &["原标签".into()]).unwrap();
    let dest = library::register_root(&c, &root).unwrap();
    let hash = storage::hash(raw.as_bytes());
    c.execute("INSERT INTO collection_obsidian_exports(destination,item_key,relative_path,file_hash,input_hash) VALUES(?1,?2,'X/legacy.md',?3,?4)",params![dest,key,hash,storage::hash(format!("source-backed-v1:{hash}").as_bytes())]).unwrap();
    c.execute("INSERT INTO reading_cloud_items VALUES(?1)", [&key])
        .unwrap();
    c.execute("INSERT INTO reading_cloud_passive VALUES(?1)", [&key])
        .unwrap();
    assert_eq!(scan(&mut c).unwrap().changed, 0);
    assert!(owns(&c, &key).unwrap());
    assert_eq!(post(&c, &key), before);
    assert_eq!(properties::load(&c, &key, true).unwrap().0, "read");
}

#[test]
fn native_telegram_export_copied_to_another_path_keeps_its_reading_identity() {
    let (mut c, root) = fixture();
    let p = Post {
        id: "99".into(),
        source: "telegram".into(),
        text: "来自原生 Telegram 收集的正文".into(),
        url: "https://t.me/example_bot".into(),
        ..Default::default()
    };
    let json = serde_json::to_string(&p).unwrap();
    c.execute("INSERT INTO collection_x_items(item_key,account,post_json,content_hash,collected_at,captured_at,read_at) VALUES('telegram:1:2:99','1',?1,?2,100,100,200)",params![json,storage::hash(json.as_bytes())]).unwrap();
    let item = Item {
        key: "telegram:1:2:99".into(),
        post: p.clone(),
        collected_at: 100,
        read: true,
    };
    let raw = storage::render(&item, &[]);
    note(&root, "Telegram/收集/native.md", &raw);
    note(&root, "Telegram/duplicate.md", &raw);
    let destination = library::register_root(&c, &root).unwrap();
    c.execute("INSERT INTO collection_obsidian_exports(destination,item_key,relative_path,file_hash,input_hash) VALUES(?1,'telegram:1:2:99','Telegram/收集/native.md',?2,'native-export')",params![destination,storage::hash(raw.as_bytes())]).unwrap();
    assert_eq!(scan(&mut c).unwrap().changed, 0);
    assert_eq!(keys(&c), vec![item.key.clone()]);
    assert_eq!(post(&c, &item.key), p);
    assert!(!owns(&c, &item.key).unwrap());
}

#[test]
fn identical_attachments_at_different_paths_dedupe_and_different_versions_stay_in_sources() {
    let (mut c, root) = fixture();
    note(&root, "Telegram/photos/one.png", "same image");
    note(&root, "Telegram/photos/two.png", "same image");
    note(
        &root,
        "Telegram/one.md",
        "同一正文\n\n![[Telegram/photos/one.png]]",
    );
    note(
        &root,
        "Telegram/two.md",
        "同一正文\n\n![[Telegram/photos/two.png]]",
    );
    scan(&mut c).unwrap();
    assert_eq!(keys(&c).len(), 1);
    assert!(root.join("Telegram/one.md").is_file());
    assert!(root.join("Telegram/two.md").is_file());
    note(&root, "X/version-a.md", &x("1000000000000000006", "版本 A"));
    note(
        &root,
        "X/version-b.md",
        &x("1000000000000000006", "版本 B\n新增回复"),
    );
    scan(&mut c).unwrap();
    assert_eq!(keys(&c).len(), 2);
    assert!(fs::read_to_string(root.join("X/version-b.md"))
        .unwrap()
        .contains("新增回复"));
}

#[test]
fn tombstones_and_archives_are_not_resurrected_or_reset() {
    let (mut c, root) = fixture();
    note(
        &root,
        "X/deleted.md",
        &x("1000000000000000007", "删除后不要回来"),
    );
    scan(&mut c).unwrap();
    let key = keys(&c).remove(0);
    c.execute(
        "UPDATE collection_lifecycle SET state='deleted',revision=revision+1 WHERE item_key=?1",
        [&key],
    )
    .unwrap();
    c.execute("DELETE FROM collection_x_items WHERE item_key=?1", [&key])
        .unwrap();
    note(
        &root,
        "X/copy.md",
        &x("1000000000000000007", "删除后不要回来"),
    );
    scan(&mut c).unwrap();
    assert!(keys(&c).is_empty());
    super::super::reading_sync_test_import(
        &mut c,
        Post {
            id: "1000000000000000007".into(),
            text: "后续 API 同步也不能复活".into(),
            ..Default::default()
        },
    );
    assert!(keys(&c).is_empty());
    note(&root, "Telegram/archive.md", "归档保留");
    scan(&mut c).unwrap();
    let key = keys(&c).remove(0);
    c.execute(
        "UPDATE collection_lifecycle SET state='archived',revision=9 WHERE item_key=?1",
        [&key],
    )
    .unwrap();
    note(&root, "Telegram/archive.md", "归档保留\n更新原文");
    scan(&mut c).unwrap();
    assert_eq!(
        c.query_row(
            "SELECT state,revision FROM collection_lifecycle WHERE item_key=?1",
            [&key],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        )
        .unwrap(),
        ("archived".into(), 9)
    );
}

#[test]
fn backlog_tail_and_malformed_input_recover_across_database_reopen() {
    let (c, root) = fixture();
    let db = root.join("intake.sqlite3");
    c.backup("main", &db, None).unwrap();
    drop(c);
    let mut c = Connection::open(&db).unwrap();
    for n in 0..130 {
        note(
            &root,
            &format!("Telegram/{n:03}.md"),
            &format!("各不相同的第 {n} 条消息"),
        );
    }
    note(
        &root,
        "Telegram/000-bad.md",
        "---\nurl: [ unfinished\n---\n正文",
    );
    let first = scan(&mut c).unwrap();
    assert!(first.remaining > 0);
    assert_eq!(first.errors, 1);
    drop(c);
    let mut c = Connection::open(&db).unwrap();
    scan(&mut c).unwrap();
    let tail = scan(&mut c).unwrap();
    assert_eq!(tail.remaining, 0);
    assert_eq!(keys(&c).len(), 130);
    note(&root, "Telegram/000-bad.md", "已修复的消息");
    scan(&mut c).unwrap();
    assert_eq!(keys(&c).len(), 131);
    assert_eq!(scan(&mut c).unwrap().changed, 0);
}

#[test]
fn manual_default_does_not_scan_until_explicitly_requested() {
    let (mut c, root) = fixture();
    let cfg = storage::config(&c).unwrap();
    assert_eq!(cfg.local_sources_minutes, 0);
    assert_eq!(schedule::delay(&c, &cfg, now_timestamp()), None);
    note(
        &root,
        "X/manual.md",
        &x("1000000000000000070", "仅手动接入"),
    );
    assert!(schedule::batch(&mut c, &cfg, true, true).unwrap().is_none());
    assert!(keys(&c).is_empty());
    assert_eq!(
        schedule::batch(&mut c, &cfg, false, true)
            .unwrap()
            .unwrap()
            .changed,
        1
    );
    assert_eq!(schedule::delay(&c, &cfg, now_timestamp()), None);
    assert_eq!(
        schedule::batch(&mut c, &cfg, false, true)
            .unwrap()
            .unwrap()
            .changed,
        0
    );
    assert_eq!(keys(&c).len(), 1);
}

#[test]
fn user_interval_survives_reload_and_respects_manual_checks_and_root_changes() {
    let (mut c, root) = fixture();
    let mut cfg = storage::config(&c).unwrap();
    cfg.local_sources_minutes = 60;
    meta(
        &c,
        "collection_storage_v1",
        &serde_json::to_string(&cfg).unwrap(),
    )
    .unwrap();
    assert_eq!(schedule::delay(&c, &cfg, 2000), Some(Duration::ZERO));
    meta(
        &c,
        "collection_local_sources_attempt_v1",
        &json!({"root":cfg.vault_path,"at":2000}).to_string(),
    )
    .unwrap();
    let reloaded = storage::config(&c).unwrap();
    assert_eq!(reloaded.auto_sync_minutes, 0);
    assert_eq!(reloaded.local_sources_minutes, 60);
    assert_eq!(
        schedule::delay(&c, &reloaded, 2030),
        Some(Duration::from_secs(3570))
    );
    assert_eq!(schedule::delay(&c, &reloaded, 5600), Some(Duration::ZERO));
    cfg.local_sources_minutes = 5;
    assert_eq!(
        schedule::delay(&c, &cfg, 2030),
        Some(Duration::from_secs(270))
    );
    cfg.vault_path = root.join("other-vault").to_string_lossy().into();
    assert_eq!(schedule::delay(&c, &cfg, 2030), Some(Duration::ZERO));
    cfg.vault_path = root.to_string_lossy().into();
    cfg.local_sources_minutes = 0;
    meta(
        &c,
        "collection_storage_v1",
        &serde_json::to_string(&cfg).unwrap(),
    )
    .unwrap();
    note(&root, "X/pending.md", &x("1000000000000000071", "等待手动"));
    assert!(schedule::batch(&mut c, &reloaded, true, false)
        .unwrap()
        .is_none());
    assert!(keys(&c).is_empty());
    schedule::batch(&mut c, &cfg, false, true).unwrap().unwrap();
    cfg.local_sources_minutes = 60;
    assert!(
        schedule::delay(&c, &cfg, now_timestamp())
            .unwrap()
            .as_secs()
            > 3590
    );
}

#[test]
fn changing_saved_vault_stops_the_old_batch_and_preserves_originals() {
    let (mut c, root) = fixture();
    let old = storage::config(&c).unwrap();
    note(&root, "X/old.md", &x("1000000000000000072", "旧库原件"));
    let new_root = root.join("new-vault");
    fs::create_dir_all(new_root.join("X")).unwrap();
    set_root(&mut c, &new_root);
    assert!(schedule::batch(&mut c, &old, false, true)
        .unwrap()
        .is_none());
    assert!(keys(&c).is_empty());
    assert!(root.join("X/old.md").is_file());
}
