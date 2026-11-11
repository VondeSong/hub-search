use super::*;
use crate::reading_sync::object_store::InventoryPage;
use futures::future::BoxFuture;
use std::{collections::BTreeMap, sync::Mutex};

#[derive(Default)]
struct MemoryStore(Mutex<BTreeMap<String, Vec<u8>>>);
impl Store for MemoryStore {
    fn key(&self, r: &str) -> String {
        format!("prefix/v2/{r}")
    }
    fn check_network(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
    fn head_size<'a>(&'a self, k: &'a str) -> BoxFuture<'a, Result<Option<u64>, String>> {
        Box::pin(async move { Ok(self.0.lock().unwrap().get(k).map(|v| v.len() as u64)) })
    }
    fn get<'a>(&'a self, k: &'a str, max: usize) -> BoxFuture<'a, Result<Option<Vec<u8>>, String>> {
        Box::pin(async move {
            let v = self.0.lock().unwrap().get(k).cloned();
            if v.as_ref().is_some_and(|v| v.len() > max) {
                return Err("too large".into());
            }
            Ok(v)
        })
    }
    fn inventory_page<'a>(
        &'a self,
        r: &'a str,
        _: Option<&'a str>,
    ) -> BoxFuture<'a, Result<InventoryPage, String>> {
        Box::pin(async move {
            Ok(InventoryPage {
                keys: self
                    .0
                    .lock()
                    .unwrap()
                    .keys()
                    .filter(|k| k.starts_with(&self.key(r)))
                    .cloned()
                    .collect(),
                ..Default::default()
            })
        })
    }
    fn list<'a>(&'a self, r: &'a str) -> BoxFuture<'a, Result<Vec<String>, String>> {
        Box::pin(async move { Ok(self.inventory_page(r, None).await?.keys) })
    }
    fn put_verified<'a>(&'a self, k: &'a str, b: &'a [u8]) -> BoxFuture<'a, Result<bool, String>> {
        Box::pin(async move {
            let mut data = self.0.lock().unwrap();
            if let Some(old) = data.get(k) {
                if old != b {
                    return Err("immutable conflict".into());
                }
                return Ok(false);
            }
            data.insert(k.into(), b.to_vec());
            Ok(true)
        })
    }
    fn delete_exact<'a>(&'a self, k: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            self.0.lock().unwrap().remove(k);
            Ok(())
        })
    }
}
struct Fixture {
    dir: PathBuf,
    db: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("hub-quick-journal-{}", random_url_safe(12)));
        fs::create_dir_all(dir.join("vault")).unwrap();
        let db = dir.join("craft-search.sqlite3");
        let c = Connection::open(&db).unwrap();
        c.execute_batch("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE libraries(id TEXT,provider TEXT,location TEXT,enabled INTEGER);").unwrap();
        schema(&c).unwrap();
        c.execute(
            "INSERT INTO libraries VALUES('os','obsidian',?1,1)",
            [dir.join("vault").to_string_lossy()],
        )
        .unwrap();
        meta(
            &c,
            "quick_journal_settings",
            &serde_json::to_string(&Settings {
                library_id: "os".into(),
                folder: "Journals".into(),
                sync: true,
                date_folders: false,
            })
            .unwrap(),
        )
        .unwrap();
        crate::database::register_initialized_fixture(&db);
        Self { dir, db }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        crate::database::forget_initialized_database(&self.db);
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn save_settings(f: &Fixture, s: &Settings) {
    meta(
        &open_database(&f.db).unwrap(),
        "quick_journal_settings",
        &serde_json::to_string(s).unwrap(),
    )
    .unwrap();
}
#[test]
fn new_settings_use_date_folders_while_legacy_settings_keep_their_destination() {
    let f = Fixture::new();
    let c = open_database(&f.db).unwrap();
    assert!(!settings(&c).unwrap().date_folders);
    meta(
        &c,
        "quick_journal_settings",
        r#"{"libraryId":"os","folder":"Journals/2026/11","sync":true}"#,
    )
    .unwrap();
    let old = settings(&c).unwrap();
    assert!(!old.date_folders);
    assert!(target(&c, &old, "2026-09-30")
        .unwrap()
        .ends_with("Journals/2026/11"));
    c.execute(
        "DELETE FROM metadata WHERE key='quick_journal_settings'",
        [],
    )
    .unwrap();
    assert!(settings(&c).unwrap().date_folders);
}
#[test]
fn dates_route_to_original_month_and_keep_existing_diaries_and_applied_records() {
    let f = Fixture::new();
    let mut r = record();
    enqueue(&f.db, &r).unwrap();
    apply_local(&f.db).unwrap();
    let legacy = f.dir.join("vault/Journals/2026-11-07.md");
    let old = fs::read_to_string(&legacy).unwrap();
    save_settings(
        &f,
        &Settings {
            library_id: "os".into(),
            folder: "Journals".into(),
            sync: true,
            date_folders: true,
        },
    );
    for (id, date) in [
        ("b", "2026-12-31"),
        ("c", "2027-01-01"),
        ("d", "2024-02-29"),
    ] {
        r.id = id.repeat(32);
        r.date = date.into();
        let path = f.dir.join(format!(
            "vault/Journals/{}/{}/{}.md",
            &date[..4],
            &date[5..7],
            date
        ));
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "# 人工日记\n\n已有内容\n").unwrap();
        enqueue(&f.db, &r).unwrap();
        apply_local(&f.db).unwrap();
        apply_local(&f.db).unwrap();
        let md = fs::read_to_string(&path).unwrap();
        assert!(md.starts_with("# 人工日记\n\n已有内容\n"));
        assert_eq!(format::blocks(&md).unwrap().len(), 1);
    }
    assert_eq!(fs::read_to_string(legacy).unwrap(), old);
    assert!(!f.dir.join("vault/Journals/2026/11/2026-11-07.md").exists());
}
#[test]
fn manual_sync_explains_each_disabled_gate_and_mobile_does_not_require_a_vault() {
    let f = Fixture::new();
    let c = open_database(&f.db).unwrap();
    meta(&c, "cloud_sync_enabled", "0").unwrap();
    meta(
        &c,
        "quick_journal_settings",
        r#"{"libraryId":"","folder":"Journals","sync":false}"#,
    )
    .unwrap();
    assert!(sync_configuration(&c, false, true)
        .unwrap_err()
        .contains("速记云同步未开启"));
    assert!(sync_configuration(&c, true, true).unwrap().is_none());
    meta(
        &c,
        "quick_journal_settings",
        r#"{"libraryId":"","folder":"Journals","sync":true}"#,
    )
    .unwrap();
    assert!(sync_configuration(&c, false, true)
        .unwrap_err()
        .contains("总开关"));
    meta(&c, "cloud_sync_enabled", "1").unwrap();
    meta(&c, "cloud_sync_auto", "0").unwrap();
    meta(&c, "flashcard_cloud_provider", "oss").unwrap();
    meta(
        &c,
        "flashcard_oss_config",
        r#"{"bucket":"hub-test","region":"cn-shanghai","prefix":"test","accessKeyId":"test"}"#,
    )
    .unwrap();
    assert!(sync_configuration(&c, false, false)
        .unwrap_err()
        .contains("OS 资料库"));
    assert!(sync_configuration(&c, false, true).unwrap().is_some());
    assert!(sync_configuration(&c, true, true).unwrap().is_none());
}
#[test]
fn sync_report_does_not_call_pending_records_uploaded_or_written() {
    let f = Fixture::new();
    let r = record();
    enqueue(&f.db, &r).unwrap();
    assert_eq!(sync_report(&f.db).unwrap().pending_upload, 1);
    update(
        &f.db,
        "UPDATE quick_journal_records SET uploaded=1,namespace=?2 WHERE id=?1",
        &r.id,
        "test",
    )
    .unwrap();
    let report = sync_report(&f.db).unwrap();
    assert_eq!(report.pending_upload, 0);
    assert_eq!(report.awaiting_os, 1);
    assert_eq!(report.written, 0);
    apply_local(&f.db).unwrap();
    assert_eq!(sync_report(&f.db).unwrap().written, 1);
}

#[tokio::test]
async fn cloud_replay_writes_body_before_attachments_and_preserves_manual_edits() {
    let f = Fixture::new();
    let store = MemoryStore::default();
    let mut r = record();
    let bytes = b"attachment";
    let hash = digest(bytes);
    r.attachments.push(Attachment {
        hash: hash.clone(),
        name: "evidence.txt".into(),
        size: bytes.len(),
        image: false,
    });
    store
        .put_verified(
            &store.key(&format!("journal/records/{}.json", r.id)),
            &serde_json::to_vec(&r).unwrap(),
        )
        .await
        .unwrap();
    transfer(&f.db, &store, "test").await.unwrap();
    assert!(
        fs::read_to_string(f.dir.join("vault/Journals/2026-11-07.md"))
            .unwrap()
            .contains("附件未下载")
    );
    store
        .put_verified(&store.key(&format!("journal/assets/{hash}")), bytes)
        .await
        .unwrap();
    transfer(&f.db, &store, "test").await.unwrap();
    let path = f.dir.join("vault/Journals/2026-11-07.md");
    let md = fs::read_to_string(&path).unwrap();
    assert!(md.contains(&format!("{hash}.txt")));
    assert!(store
        .get(&store.key(&format!("journal/receipts/{}.json", r.id)), 1024)
        .await
        .unwrap()
        .is_some());
    fs::write(&path, md.replace("记录", "原文中的人工修改")).unwrap();
    transfer(&f.db, &store, "test").await.unwrap();
    let edited = fs::read_to_string(&path).unwrap();
    assert!(edited.contains("人工修改"));
    assert_eq!(format::blocks(&edited).unwrap().len(), 1);
    // Rebuilding the local queue from the inbox does not restore the old body over an existing ID.
    open_database(&f.db)
        .unwrap()
        .execute("DELETE FROM quick_journal_records", [])
        .unwrap();
    transfer(&f.db, &store, "test").await.unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), edited);
}
#[test]
fn retries_keep_one_queue_entry_and_never_clear_an_unrelated_draft() {
    let f = Fixture::new();
    let r = record();
    meta(
        &open_database(&f.db).unwrap(),
        "quick_journal_draft",
        "unrelated",
    )
    .unwrap();
    enqueue(&f.db, &r).unwrap();
    enqueue(&f.db, &r).unwrap();
    assert_eq!(queue(&f.db).unwrap().len(), 1);
    let mut changed = r;
    changed.text = "changed".into();
    assert!(enqueue(&f.db, &changed).is_err());
    assert_eq!(
        metadata_string(&open_database(&f.db).unwrap(), "quick_journal_draft"),
        "unrelated"
    );
}
#[tokio::test]
async fn another_desktop_cannot_claim_the_same_cloud_inbox() {
    let a = Fixture::new();
    let b = Fixture::new();
    let store = MemoryStore::default();
    transfer(&a.db, &store, "test").await.unwrap();
    assert!(transfer(&b.db, &store, "test").await.is_err());
}
fn record() -> Record {
    Record {
        version: 1,
        id: "a".repeat(32),
        date: "2026-11-07".into(),
        text: "记录\n\n第二段 #想法".into(),
        attachments: vec![],
    }
}
#[test]
fn append_preserves_frontmatter_manual_edits_and_deduplicates_retries() {
    let dir = std::env::temp_dir().join(format!("hub-journal-test-{}", random_url_safe(12)));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("2026-11-07.md");
    let before = "---\ntags: [日记]\n---\n\n# 当天\n\n手写内容\n";
    fs::write(&path, before).unwrap();
    let r = record();
    append(&path, &r).unwrap();
    let first = fs::read_to_string(&path).unwrap();
    assert!(first.starts_with(before));
    fs::write(&path, first.replace("第二段", "手工修改")).unwrap();
    append(&path, &r).unwrap();
    let final_text = fs::read_to_string(&path).unwrap();
    assert!(final_text.contains("手工修改"));
    assert_eq!(format::blocks(&final_text).unwrap().len(), 1);
    let mut second = r.clone();
    second.id = "b".repeat(32);
    append(&path, &second).unwrap();
    assert_eq!(
        format::blocks(&fs::read_to_string(&path).unwrap())
            .unwrap()
            .len(),
        2
    );
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn creates_one_daily_file_and_rejects_broken_boundaries() {
    let dir = std::env::temp_dir().join(format!("hub-journal-test-{}", random_url_safe(12)));
    let path = dir.join("2026-11-07.md");
    append(&path, &record()).unwrap();
    let before = fs::read_to_string(&path).unwrap();
    assert!(before.starts_with("# 2026-11-07\n"));
    let broken = before.replace("v1 end", "v7 end");
    fs::write(&path, &broken).unwrap();
    assert!(append(&path, &record()).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), broken);
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn folder_never_escapes_vault() {
    for f in ["../a", "/abs", "C:/test", "a\\b", "a/../b", ""] {
        assert!(!safe_folder(f));
    }
    assert!(safe_folder("日记/每日"));
}

#[test]
fn deferred_attachments_patch_only_generated_markers_without_replaying_body() {
    let f = Fixture::new();
    let mut r = record();
    let bytes = b"late asset";
    let a = Attachment {
        hash: digest(bytes),
        name: "proof.pdf".into(),
        size: bytes.len(),
        image: false,
    };
    r.attachments.push(a.clone());
    assert!(enqueue(&f.db, &r).is_err());
    insert_record(&f.db, &r).unwrap();
    apply_local(&f.db).unwrap();
    let path = f.dir.join("vault/Journals/2026-11-07.md");
    let initial = fs::read_to_string(&path).unwrap();
    assert!(initial.contains("附件未下载"));
    fs::write(&path, initial.replace("记录", "人工修改")).unwrap();
    data_portability::atomic_write(&asset(&f.db, &a.hash).unwrap(), bytes).unwrap();
    apply_local(&f.db).unwrap();
    apply_local(&f.db).unwrap();
    let after = fs::read_to_string(&path).unwrap();
    assert!(after.contains("人工修改"));
    assert!(!after.contains("附件未下载"));
    assert!(after.contains(&a.filename()));
    assert_eq!(format::blocks(&after).unwrap().len(), 1);
    fs::write(&path, "用户已删除整个速记区块\n").unwrap();
    apply_local(&f.db).unwrap();
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "用户已删除整个速记区块\n"
    );
}

#[tokio::test]
async fn direction_choices_defer_assets_and_later_patch_the_original_edited_diary() {
    direction_roundtrip(&MemoryStore::default(), "test").await;
}

#[cfg(windows)]
#[tokio::test]
#[ignore = "explicit real OSS integration; requires HUB_OSS_INTEGRATION_CONFIG_DB and existing Windows credential"]
async fn real_oss_quick_journal_defers_assets_and_preserves_edited_diary() {
    let (config, store, run) = crate::reading_sync::real_cloud_tests::isolated_oss("quick");
    direction_roundtrip(&store, &config.namespace()).await;
    let (uploaded, downloaded) = store.transferred();
    assert!(uploaded + downloaded < 4 * 1024 * 1024);
    println!(
        "{}",
        json!({"status":"success", "module":"quick", "namespaceSuffixHash":digest(run.as_bytes()),
        "uploadedBytes":uploaded,"downloadedBytes":downloaded,"bodyBeforeAssets":true,
        "independentDirections":true,"deferredUploadAndDownload":true,"uploadAndDownloadSizeLimits":true,"editedDiaryPreserved":true,"remoteObjectsRetained":true})
    );
}

async fn direction_roundtrip(store: &dyn Store, namespace: &str) {
    let sender = Fixture::new();
    let receiver = Fixture::new();
    let mut bytes = b"%PDF-1.4\n".to_vec();
    bytes.resize(1024 * 1024 + 1, b' ');
    let a = Attachment {
        hash: digest(&bytes),
        name: "proof.pdf".into(),
        size: bytes.len(),
        image: false,
    };
    let mut r = record();
    r.attachments.push(a.clone());
    data_portability::atomic_write(&asset(&sender.db, &a.hash).unwrap(), &bytes).unwrap();
    enqueue(&sender.db, &r).unwrap();
    let c = open_database(&sender.db).unwrap();
    let mut s = settings(&c).unwrap();
    s.library_id.clear(); // Producer has no desktop writer, as on mobile.
    meta(
        &c,
        "quick_journal_settings",
        &serde_json::to_string(&s).unwrap(),
    )
    .unwrap();
    let none = crate::cloud_sync::attachments::Selection {
        image: false,
        video: false,
        pdf: false,
        other: false,
        max_mb: 1,
    };
    let mut rules = crate::cloud_sync::attachments::Directions {
        upload: none.clone(),
        download: none,
    };
    let save = |db: &PathBuf, rules: &crate::cloud_sync::attachments::Directions| {
        meta(
            &open_database(db).unwrap(),
            "cloud_attachments_quick_v1",
            &serde_json::to_string(rules).unwrap(),
        )
        .unwrap();
    };
    save(&sender.db, &rules);
    save(&receiver.db, &rules);
    transfer(&sender.db, store, namespace).await.unwrap();
    transfer(&receiver.db, store, namespace).await.unwrap();
    let path = receiver.dir.join("vault/Journals/2026-11-07.md");
    let initial = fs::read_to_string(&path).unwrap();
    assert!(initial.contains("附件未下载"));
    fs::write(&path, initial.replace("第二段", "人工修改")).unwrap();
    assert!(store
        .head_size(&store.key(&format!("journal/assets/{}", a.hash)))
        .await
        .unwrap()
        .is_none());
    rules.upload.pdf = true;
    save(&sender.db, &rules);
    transfer(&sender.db, store, namespace).await.unwrap();
    assert!(store
        .head_size(&store.key(&format!("journal/assets/{}", a.hash)))
        .await
        .unwrap()
        .is_none());
    rules.upload.max_mb = 2;
    save(&sender.db, &rules);
    transfer(&sender.db, store, namespace).await.unwrap();
    transfer(&receiver.db, store, namespace).await.unwrap();
    assert!(!asset(&receiver.db, &a.hash).unwrap().exists());
    rules.download.pdf = true;
    save(&receiver.db, &rules);
    transfer(&receiver.db, store, namespace).await.unwrap();
    assert!(!asset(&receiver.db, &a.hash).unwrap().exists());
    rules.download.max_mb = 2;
    save(&receiver.db, &rules);
    transfer(&receiver.db, store, namespace).await.unwrap();
    assert_eq!(
        fs::read(asset(&receiver.db, &a.hash).unwrap()).unwrap(),
        bytes
    );
    let final_text = fs::read_to_string(&path).unwrap();
    assert!(final_text.contains("人工修改"));
    assert!(!final_text.contains("附件未下载"));
    assert!(final_text.contains(&a.filename()));
    assert_eq!(format::blocks(&final_text).unwrap().len(), 1);
}
