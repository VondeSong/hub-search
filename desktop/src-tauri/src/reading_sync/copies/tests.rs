use super::*;
use crate::flashcard_cloud_sync::tests::{server, store};
const KEY: &str = "x:test-account:123";
const NS: &str = "isolated-copy-metadata";
struct Device {
    root: PathBuf,
    db: PathBuf,
}
impl Device {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("hub-reading-copies-{}", random_url_safe(10)));
        fs::create_dir(&root).unwrap();
        let db = root.join("hub.sqlite3");
        let c = open_database(&db).unwrap();
        x_bookmarks::storage::schema(&c).unwrap();
        Self { root, db }
    }
    fn c(&self) -> Connection {
        open_database(&self.db).unwrap()
    }
    fn export(&self, partial: bool) {
        x_bookmarks::reading_sync_test_import(
            &mut self.c(),
            Post {
                id: "123".into(),
                text: "正文".into(),
                ..Post::default()
            },
        );
        let destination = x_bookmarks::library::register_root(&self.c(), &self.root).unwrap();
        assert!(x_bookmarks::storage::commit_note(
            &self.c(),
            &self.root.join("private-note.md"),
            "# 正文",
            None,
            &destination,
            KEY,
            "private-note.md",
            "test-input",
            partial
        )
        .unwrap());
    }
    async fn round(&self, remote: &OssStore, device: &str) -> Result<Summary, String> {
        super::super::sync_database(&self.db, remote, NS, device).await?;
        sync(&self.db, remote, NS, device).await
    }
    fn view(&self, device: &str) -> Vec<Value> {
        view(&self.c(), NS, device, KEY).unwrap()
    }
}
impl Drop for Device {
    fn drop(&mut self) {
        forget_initialized_database(&self.db);
        assert_eq!(self.root.parent(), Some(std::env::temp_dir().as_path()));
        assert!(self
            .root
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("hub-reading-copies-"));
        let _ = fs::remove_dir_all(&self.root);
    }
}
#[tokio::test]
async fn reading_copy_real_export_transports_read_only_metadata_without_paths_or_side_effects() {
    let server = server().await;
    let remote = store(&server);
    let a = Device::new();
    let b = Device::new();
    a.export(false);
    assert_eq!(a.round(&remote, "desktop-a").await.unwrap().uploaded, 1);
    b.round(&remote, "phone-b").await.unwrap();
    let rows = b.view("phone-b");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["local"], false);
    assert_eq!(rows[0]["copies"][0]["state"], "saved");
    assert_eq!(rows[0]["copies"][0]["provider"], "obsidian");
    for table in [
        "collection_obsidian_exports",
        "collection_remote_copies",
        "collection_library_jobs",
        "collection_x_outbox",
    ] {
        assert_eq!(
            b.c()
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                    .get::<_, usize>(0))
                .unwrap(),
            0
        );
    }
    assert_eq!(
        x_bookmarks::reading_sync_test_items(&b.c(), "all")[0]["post"]["text"],
        "正文"
    );
    for (bytes, _) in server
        .state
        .lock()
        .unwrap()
        .files
        .iter()
        .filter(|(k, _)| k.contains("copies-v1"))
        .map(|(_, v)| v)
    {
        let wire = String::from_utf8_lossy(bytes);
        assert!(!wire.contains("private-note.md"));
        assert!(!wire.contains("hub-reading-copies-"));
        assert!(!wire.contains("relativePath"));
    }
    assert_eq!(a.round(&remote, "desktop-a").await.unwrap().uploaded, 0);
    assert_eq!(b.round(&remote, "phone-b").await.unwrap().uploaded, 0);
}
#[tokio::test]
async fn reading_copy_withdrawal_survives_replay_and_another_devices_copies_remain() {
    let server = server().await;
    let remote = store(&server);
    let a = Device::new();
    let b = Device::new();
    a.export(false);
    a.round(&remote, "a").await.unwrap();
    b.round(&remote, "b").await.unwrap();
    b.export(false);
    b.round(&remote, "b").await.unwrap();
    let old = load(&a.c(), NS, "a", KEY).unwrap().unwrap();
    a.c()
        .execute(
            "DELETE FROM collection_obsidian_exports WHERE item_key=?1",
            [KEY],
        )
        .unwrap();
    a.round(&remote, "a").await.unwrap();
    b.round(&remote, "b").await.unwrap();
    assert_eq!(b.view("b").len(), 1);
    assert_eq!(b.view("b")[0]["local"], true);
    accept(&b.c(), NS, &old).unwrap();
    assert_eq!(b.view("b").len(), 1);
    assert_eq!(
        fs::read_to_string(a.root.join("private-note.md")).unwrap(),
        "# 正文"
    );
    assert_eq!(a.view("a")[0]["device"], "b");
}
#[tokio::test]
async fn reading_copy_partial_missing_and_queued_selection_are_not_complete_copies() {
    let server = server().await;
    let remote = store(&server);
    let a = Device::new();
    let b = Device::new();
    a.c().execute("INSERT INTO collection_library_destinations(item_key,target,state) VALUES(?1,'fake-choice','saved')",[KEY]).unwrap();
    assert!(a.view("a").is_empty());
    a.export(true);
    a.round(&remote, "a").await.unwrap();
    b.round(&remote, "b").await.unwrap();
    assert_eq!(b.view("b")[0]["copies"][0]["state"], "partial");
    fs::rename(a.root.join("private-note.md"), a.root.join("moved-note.md")).unwrap();
    a.round(&remote, "a").await.unwrap();
    b.round(&remote, "b").await.unwrap();
    assert_eq!(b.view("b")[0]["copies"][0]["state"], "missing");
    assert_eq!(
        fs::read_to_string(a.root.join("moved-note.md")).unwrap(),
        "# 正文"
    );
}
#[tokio::test]
async fn reading_copy_retry_and_corruption_keep_pending_and_preserve_remote_projection() {
    let server = server().await;
    let remote = store(&server);
    let a = Device::new();
    let b = Device::new();
    a.export(false);
    super::super::sync_database(&a.db, &remote, NS, "a")
        .await
        .unwrap();
    server.state.lock().unwrap().deny_put = true;
    assert!(sync(&a.db, &remote, NS, "a").await.is_err());
    assert_eq!(
        a.c()
            .query_row("SELECT count(*) FROM reading_copy_pending", [], |r| r
                .get::<_, usize>(0))
            .unwrap(),
        1
    );
    server.state.lock().unwrap().deny_put = false;
    assert_eq!(sync(&a.db, &remote, NS, "a").await.unwrap().uploaded, 1);
    server.state.lock().unwrap().corrupt = true;
    assert!(sync(&b.db, &remote, NS, "b").await.is_err());
    assert!(b.view("b").is_empty());
    server.state.lock().unwrap().corrupt = false;
    b.round(&remote, "b").await.unwrap();
    assert_eq!(b.view("b").len(), 1);
}
#[test]
fn reading_copy_only_verified_document_receipts_are_shared_and_namespace_isolated() {
    let a = Device::new();
    a.c().execute("INSERT INTO collection_remote_copies(item_key,library_id,provider,object_id,parent_id,verified) VALUES(?1,'private-library','craft','private-object','document',0)",[KEY]).unwrap();
    assert!(local(&a.c(), KEY).unwrap().is_empty());
    a.c()
        .execute("UPDATE collection_remote_copies SET verified=1", [])
        .unwrap();
    stage(&a.c(), NS, "a").unwrap();
    assert_eq!(local(&a.c(), KEY).unwrap().len(), 1);
    let wire = serde_json::to_string(&load(&a.c(), NS, "a", KEY).unwrap()).unwrap();
    assert!(!wire.contains("private-object"));
    assert!(!wire.contains("private-library"));
    assert!(view(&a.c(), "other-namespace", "b", KEY)
        .unwrap()
        .iter()
        .all(|v| v["local"] == true));
    a.c()
        .execute(
            "UPDATE collection_remote_copies SET parent_id='attachment'",
            [],
        )
        .unwrap();
    assert!(local(&a.c(), KEY).unwrap().is_empty());
}

#[tokio::test]
async fn reading_copy_real_producer_more_than_hundred_changes_drains_tail_and_recovers_after_reopen(
) {
    let s = server().await;
    let remote = store(&s);
    let a = Device::new();
    let b = Device::new();
    let c = a.c();
    let destination = x_bookmarks::library::register_root(&c, &a.root).unwrap();
    for index in 0..225 {
        let id = format!("budget-{index:03}");
        x_bookmarks::reading_sync_test_import(
            &mut a.c(),
            Post {
                id: id.clone(),
                text: format!("Body {index}"),
                ..Post::default()
            },
        );
        let name = format!("private-{index:03}.md");
        assert!(x_bookmarks::storage::commit_note(
            &c,
            &a.root.join(&name),
            "# owned content",
            None,
            &destination,
            &format!("x:test-account:{id}"),
            &name,
            "test-input",
            false
        )
        .unwrap());
    }
    let first = sync(&a.db, &remote, NS, "producer").await.unwrap();
    assert_eq!(first.uploaded, 100);
    assert_eq!(first.pending, 125);
    assert_eq!(metadata_u64(&c, "reading_sync_clock", 0), 100);
    crate::forget_initialized_database(&a.db);
    let second = sync(&a.db, &remote, NS, "producer").await.unwrap();
    assert_eq!(second.uploaded, 100);
    assert_eq!(second.pending, 25);
    let third = sync(&a.db, &remote, NS, "producer").await.unwrap();
    assert_eq!(third.uploaded, 25);
    assert_eq!(third.pending, 0);
    assert_eq!(metadata_u64(&c, "reading_sync_clock", 0), 225);
    assert_eq!(
        sync(&a.db, &remote, NS, "producer").await.unwrap().uploaded,
        0
    );
    assert_eq!(
        sync(&b.db, &remote, NS, "receiver")
            .await
            .unwrap()
            .downloaded,
        100
    );
    crate::forget_initialized_database(&b.db);
    assert_eq!(
        sync(&b.db, &remote, NS, "receiver")
            .await
            .unwrap()
            .downloaded,
        100
    );
    let tail = sync(&b.db, &remote, NS, "receiver").await.unwrap();
    assert_eq!(tail.downloaded, 25);
    assert_eq!(tail.pending, 0);
    assert_eq!(
        b.c()
            .query_row("SELECT count(*) FROM reading_copy_snapshots", [], |r| r
                .get::<_, usize>(
                0
            ))
            .unwrap(),
        225
    );
    assert_eq!(
        b.c()
            .query_row("SELECT count(*) FROM collection_library_jobs", [], |r| {
                r.get::<_, usize>(0)
            })
            .unwrap(),
        0
    );
}

#[test]
fn reading_copy_late_corrupt_projection_rolls_back_hundred_item_budget_clock_and_pending() {
    let a = Device::new();
    let c = a.c();
    for index in 0..101 {
        c.execute("INSERT INTO collection_remote_copies(item_key,library_id,provider,object_id,parent_id,verified) VALUES(?1,'library','craft',?2,'document',1)",params![format!("a-{index:03}"),format!("object-{index}")]).unwrap();
    }
    c.execute("INSERT INTO reading_copy_snapshots(namespace,device,item_key,body) VALUES(?1,'device','zzz','{')",[NS]).unwrap();
    let clock = metadata_u64(&c, "reading_sync_clock", 0);
    assert!(stage(&c, NS, "device")
        .unwrap_err()
        .contains("副本记录损坏"));
    assert_eq!(metadata_u64(&c, "reading_sync_clock", 0), clock);
    assert_eq!(
        c.query_row("SELECT count(*) FROM reading_copy_pending", [], |r| r
            .get::<_, usize>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM reading_copy_snapshots", [], |r| r
            .get::<_, usize>(
            0
        ))
        .unwrap(),
        1
    );
    c.execute(
        "DELETE FROM reading_copy_snapshots WHERE item_key='zzz'",
        [],
    )
    .unwrap();
    assert_eq!(stage(&c, NS, "device").unwrap(), 1);
    assert_eq!(stage(&c, NS, "device").unwrap(), 0);
    assert_eq!(metadata_u64(&c, "reading_sync_clock", 0), 101);
}
