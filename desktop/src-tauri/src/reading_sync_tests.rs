use super::*;
use crate::flashcard_cloud_sync::tests::{server, store};
const KEY: &str = "x:test-account:123";
const NS: &str = "reading-test-namespace";
struct Device(PathBuf);
impl Device {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("hub-reading-sync-{}.sqlite3", random_url_safe(12)));
        let c = open_database(&path).unwrap();
        x_bookmarks::storage::schema(&c).unwrap();
        Self(path)
    }
    fn conn(&self) -> Connection {
        open_database(&self.0).unwrap()
    }
    fn seed(&self) {
        x_bookmarks::reading_sync_test_import(
            &mut self.conn(),
            Post {
                id: "123".into(),
                text: "可恢复的阅读正文".into(),
                url: "https://example.test/article".into(),
                thread_cursors: vec!["private-fetch-cursor".into()],
                ..Post::default()
            },
        );
    }
    fn edit(&self, status: &str, tags: &[&str]) {
        x_bookmarks::properties::save_local(
            &mut self.conn(),
            KEY,
            status,
            &tags.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        )
        .unwrap();
    }
    async fn sync(&self, remote: &OssStore, name: &str) -> Result<Report, String> {
        sync_database(&self.0, remote, NS, name).await
    }
    fn record(&self) -> Record {
        load(&self.conn(), KEY).unwrap().unwrap()
    }
    fn count(&self, table: &str) -> i64 {
        self.conn()
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }
}
impl Drop for Device {
    fn drop(&mut self) {
        for suffix in ["", "-wal", "-shm"] {
            let _ = fs::remove_file(format!("{}{suffix}", self.0.display()));
        }
    }
}

#[tokio::test]
async fn reading_receiver_round_budget_resumes_frozen_inventory_without_relisting_or_side_effects()
{
    let server = server().await;
    let remote = store(&server);
    let source = Device::new();
    for index in 0..101 {
        x_bookmarks::reading_sync_test_import(
            &mut source.conn(),
            Post {
                id: format!("budget-{index}"),
                text: format!("Complete source body {index}"),
                url: format!("https://example.invalid/{index}"),
                ..Post::default()
            },
        );
    }
    assert_eq!(source.count("collection_x_items"), 101);
    source.sync(&remote, "source").await.unwrap();
    source.sync(&remote, "source").await.unwrap();
    let destination = Device::new();
    let first = destination.sync(&remote, "receiver").await.unwrap();
    assert_eq!(first.downloaded, 100);
    assert_eq!(destination.count("reading_sync_applied"), 100);
    let epoch:String=destination.conn().query_row("SELECT epoch FROM cloud_inventory_runs WHERE namespace=?1 AND scope='reading-changes' AND state='complete'",[NS],|r|r.get(0)).unwrap();
    assert!(!epoch.is_empty());
    let listing_requests = server.state.lock().unwrap().list_pages;
    server.state.lock().unwrap().virtual_list_count = Some(0); // The frozen tail must not depend on a new provider listing.
    crate::forget_initialized_database(&destination.0);
    let second = destination.sync(&remote, "receiver").await.unwrap();
    assert_eq!(second.downloaded, 1);
    assert_eq!(destination.count("reading_sync_applied"), 101);
    assert_eq!(destination.count("collection_x_items"), 101);
    assert_eq!(destination.count("collection_library_jobs"), 0);
    assert_eq!(destination.count("collection_x_outbox"), 0);
    assert_eq!(destination.count("cloud_inventory_runs"), 0);
    assert_eq!(server.state.lock().unwrap().list_pages, listing_requests);
}

#[test]
fn reading_capture_streaming_identity_keeps_unicode_sort_json_bytes_and_versions() {
    let a = Device::new();
    for id in ["Z", "a", "汉字", "Ω", "🧠", "quote\"\\"] {
        x_bookmarks::reading_sync_test_import(
            &mut a.conn(),
            Post {
                id: id.into(),
                text: format!("正文 {id} Greek Ελληνικά emoji 🧠\nquoted \" and slash \\"),
                ..Post::default()
            },
        );
    }
    let c = a.conn();
    let clock_before = metadata_u64(&c, "reading_sync_clock", 0);
    let preview = migration_domain_token(&c).unwrap();
    assert_eq!(metadata_u64(&c, "reading_sync_clock", 0), clock_before);
    assert_eq!(a.count("reading_sync_records"), 0);
    let tx = c.unchecked_transaction().unwrap();
    let mut reference = capture(&tx, "migration-preview", None).unwrap();
    reference.sort_by(|a, b| a.key.cmp(&b.key));
    assert_eq!(preview, hash(&serde_json::to_vec(&reference).unwrap()));
    assert_eq!(migration_domain_identity(&tx).unwrap(), preview);
    assert!(reference
        .windows(2)
        .all(|pair| pair[0].key.as_bytes() < pair[1].key.as_bytes()));
    assert_eq!(reference[0].status.version.clock, 2);
    assert_eq!(reference[0].lifecycle.version.clock, 3);
    assert_eq!(reference[0].body.version.clock, 4);
    tx.rollback().unwrap();
    assert_eq!(a.count("reading_sync_records"), 0);
    stage(&c, NS, "source").unwrap();
    let before = metadata_u64(&c, "reading_sync_clock", 0);
    stage(&c, NS, "source").unwrap();
    assert_eq!(metadata_u64(&c, "reading_sync_clock", 0), before);
    assert_eq!(a.count("reading_sync_pending"), 6);
    assert!(capture_one(&c, "source", "absent-key").unwrap().is_none());
}

#[test]
fn reading_capture_late_failure_rolls_back_records_clock_pending_and_lifecycle_index() {
    let a = Device::new();
    for id in ["aaa", "bbb", "zzz"] {
        x_bookmarks::reading_sync_test_import(
            &mut a.conn(),
            Post {
                id: id.into(),
                text: id.into(),
                ..Post::default()
            },
        );
    }
    let c = a.conn();
    c.execute(
        "UPDATE collection_x_items SET post_json='{' WHERE item_key='x:test-account:zzz'",
        [],
    )
    .unwrap();
    let clock = metadata_u64(&c, "reading_sync_clock", 0);
    assert!(stage(&c, NS, "device").unwrap_err().contains("正文损坏"));
    assert_eq!(a.count("reading_sync_records"), 0);
    assert_eq!(a.count("reading_sync_pending"), 0);
    assert_eq!(metadata_u64(&c, "reading_sync_clock", 0), clock);
    assert_eq!(a.count("collection_x_items"), 3);
    c.execute(
        "DELETE FROM collection_x_items WHERE item_key='x:test-account:zzz'",
        [],
    )
    .unwrap();
    c.execute("INSERT INTO collection_lifecycle(item_key,state,revision) VALUES('x:test-account:gone','deleted',1)",[]).unwrap();
    stage(&c, NS, "device").unwrap();
    let tombstone = load(&c, "x:test-account:gone").unwrap().unwrap();
    assert_eq!(tombstone.lifecycle.value, "deleted");
    assert!(tombstone.body.value.is_none());
    assert_eq!(a.count("reading_sync_pending"), 3);
}

#[test]
fn reading_capture_transaction_blocks_concurrent_source_write_and_next_capture_sees_new_item() {
    let a = Device::new();
    a.seed();
    let c = a.conn();
    let other = a.conn();
    other.busy_timeout(std::time::Duration::ZERO).unwrap();
    let mut attempted = false;
    visit_captured(&c,"source",|_| {
        attempted=true;
        assert!(other.execute("INSERT INTO collection_lifecycle(item_key,state,revision) VALUES('x:test-account:new','deleted',1)",[]).is_err());
        Ok(())
    }).unwrap();
    assert!(attempted);
    other.execute("INSERT INTO collection_lifecycle(item_key,state,revision) VALUES('x:test-account:new','deleted',1)",[]).unwrap();
    stage(&c, NS, "source").unwrap();
    assert_eq!(
        load(&c, "x:test-account:new")
            .unwrap()
            .unwrap()
            .lifecycle
            .value,
        "deleted"
    );
    assert_eq!(a.count("reading_sync_records"), 2);
}

#[tokio::test]
async fn reading_sync_real_transport_roundtrip_concurrent_edits_and_passive_projection() {
    let server = server().await;
    let remote = store(&server);
    let a = Device::new();
    let b = Device::new();
    a.seed();
    a.edit("unread", &["基础"]);
    a.sync(&remote, "a").await.unwrap();
    b.sync(&remote, "b").await.unwrap();
    let items = x_bookmarks::reading_sync_test_items(&b.conn(), "all");
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["post"]["text"], "可恢复的阅读正文");
    assert_eq!(items[0]["cloudImported"], true);
    assert!(b
        .record()
        .body
        .value
        .unwrap()
        .post
        .thread_cursors
        .is_empty());
    assert_eq!(b.count("collection_library_jobs"), 0);
    assert_eq!(b.count("reading_cloud_passive"), 1);
    // Independent offline edits: changing the status must not replace the other device's tag.
    a.edit("read", &["基础"]);
    b.edit("unread", &["手机"]);
    a.sync(&remote, "a").await.unwrap();
    b.sync(&remote, "b").await.unwrap();
    a.sync(&remote, "a").await.unwrap();
    b.sync(&remote, "b").await.unwrap();
    assert_eq!(a.record(), b.record());
    let r = a.record();
    assert_eq!(r.status.value, "read");
    assert!(!r.tags["基础"].value);
    assert!(r.tags["手机"].value);
    b.edit("abandoned", &["手机"]);
    assert_eq!(b.count("collection_x_outbox"), 0);
    assert_eq!(b.count("collection_property_updates"), 0);
    b.sync(&remote, "b").await.unwrap();
    a.sync(&remote, "a").await.unwrap();
    assert_eq!(a.count("collection_x_outbox"), 0);
    assert_eq!(a.count("collection_property_updates"), 0);
    let item = x_bookmarks::reading_sync_test_items(&a.conn(), "abandoned");
    assert_eq!(item[0]["status"], "abandoned");
    assert!(server
        .state
        .lock()
        .unwrap()
        .files
        .keys()
        .all(|k| k.contains("/reading/v1/changes/")));
}

#[tokio::test]
async fn reading_sync_offline_and_lost_ack_keep_stable_pending_and_corruption_cannot_apply() {
    let server = server().await;
    let remote = store(&server);
    let a = Device::new();
    let b = Device::new();
    a.seed();
    server.state.lock().unwrap().deny_put = true;
    assert!(a.sync(&remote, "a").await.is_err());
    assert_eq!(a.count("reading_sync_pending"), 1);
    let first = a.record();
    {
        let mut state = server.state.lock().unwrap();
        state.deny_put = false;
        state.lose_ack = true;
    }
    let _ = a.sync(&remote, "a").await;
    a.sync(&remote, "a").await.unwrap();
    assert_eq!(a.record(), first);
    assert_eq!(server.state.lock().unwrap().files.len(), 1);
    server.state.lock().unwrap().corrupt = true;
    assert!(b.sync(&remote, "b").await.is_err());
    assert_eq!(b.count("reading_sync_applied"), 0);
    assert_eq!(b.count("collection_x_items"), 0);
    server.state.lock().unwrap().corrupt = false;
    b.sync(&remote, "b").await.unwrap();
    assert_eq!(b.record(), a.record());
}

#[tokio::test]
async fn reading_sync_archival_and_permanent_deletion_survive_offline_edits_and_replay() {
    let server = server().await;
    let remote = store(&server);
    let a = Device::new();
    let b = Device::new();
    a.seed();
    a.sync(&remote, "a").await.unwrap();
    b.sync(&remote, "b").await.unwrap();
    a.conn().execute("INSERT INTO collection_lifecycle(item_key,state,revision) VALUES(?1,'archived',1) ON CONFLICT(item_key) DO UPDATE SET state='archived'",[KEY]).unwrap();
    a.sync(&remote, "a").await.unwrap();
    b.sync(&remote, "b").await.unwrap();
    assert_eq!(
        x_bookmarks::reading_sync_test_items(&b.conn(), "archived").len(),
        1
    );
    b.edit("read", &["离线编辑"]);
    a.conn()
        .execute(
            "UPDATE collection_lifecycle SET state='deleted' WHERE item_key=?1",
            [KEY],
        )
        .unwrap();
    a.sync(&remote, "a").await.unwrap();
    b.sync(&remote, "b").await.unwrap();
    a.sync(&remote, "a").await.unwrap();
    b.sync(&remote, "b").await.unwrap();
    assert_eq!(a.record().lifecycle.value, "deleted");
    assert_eq!(b.record().lifecycle.value, "deleted");
    assert_eq!(b.count("collection_x_items"), 0);
    assert_eq!(b.count("collection_library_jobs"), 0);
    // A fresh third device replays immutable objects in hash order, not temporal order.
    let c = Device::new();
    c.sync(&remote, "c").await.unwrap();
    assert_eq!(c.record().lifecycle.value, "deleted");
    assert_eq!(c.count("collection_x_items"), 0);
    // Reimport uses the actual source producer and must respect the tombstone.
    c.seed();
    assert_eq!(c.count("collection_x_items"), 0);
}

#[test]
fn reading_sync_stale_editor_applies_only_intended_changes_and_source_preservation_survives_pause()
{
    let a = Device::new();
    a.seed();
    a.edit("read", &["电脑新增"]);
    x_bookmarks::properties::save_edit(
        &mut a.conn(),
        KEY,
        "unread",
        &["手机新增".into()],
        Some("unread"),
        Some(&[]),
    )
    .unwrap();
    let items = x_bookmarks::reading_sync_test_items(&a.conn(), "all");
    assert_eq!(items[0]["status"], "read");
    assert_eq!(items[0]["tags"], json!(["电脑新增", "手机新增"]));
    meta(&a.conn(), "cloud_sync_reading", "1").unwrap();
    meta(&a.conn(), "cloud_sync_enabled", "0").unwrap();
    assert!(require_source_preservation(&a.conn()).is_err());
    assert!(cloud_sync::require_reading(&a.conn(), false).is_err());
    meta(&a.conn(), "cloud_sync_reading", "0").unwrap();
    assert!(require_source_preservation(&a.conn()).is_ok());
}

#[test]
fn reading_sync_tombstone_merge_order_is_deterministic_and_record_size_is_bounded() {
    let a = Device::new();
    a.seed();
    capture(&a.conn(), "a", None).unwrap();
    let live = a.record();
    let mut first = live.clone();
    first.lifecycle = Field {
        version: Version {
            clock: 100,
            device: "a".into(),
        },
        value: "deleted".into(),
    };
    let mut second = first.clone();
    second.lifecycle.version = Version {
        clock: 200,
        device: "b".into(),
    };
    merge(&a.conn(), second.clone()).unwrap();
    merge(&a.conn(), first.clone()).unwrap();
    merge(&a.conn(), live.clone()).unwrap();
    let b = Device::new();
    merge(&b.conn(), first).unwrap();
    merge(&b.conn(), live).unwrap();
    merge(&b.conn(), second).unwrap();
    assert_eq!(a.record(), b.record());
    let mut huge = a.record();
    huge.body.value.as_mut().unwrap().post.text = "x".repeat(MAX_RECORD);
    assert!(bytes(huge).is_err());
}

#[test]
fn reading_sync_idle_stage_does_not_revisit_unchanged_records() {
    let a = Device::new();
    a.seed();
    let c = a.conn();
    stage(&c, NS, "device").unwrap();
    c.execute("INSERT INTO reading_sync_uploaded(namespace,item_key,id) SELECT ?1,?2,id FROM reading_sync_pending",params![NS,KEY]).unwrap();
    c.execute("DELETE FROM reading_sync_pending", []).unwrap();
    CAPTURE_VISITS.with(|n| n.set(0));
    stage(&c, NS, "device").unwrap();
    assert_eq!(
        CAPTURE_VISITS.with(|n| n.get()),
        0,
        "an unchanged acknowledged record must not be loaded/parsed each sync tick"
    );
    assert_eq!(a.count("reading_sync_pending"), 0);
    a.edit("read", &["updated"]);
    stage(&c, NS, "device").unwrap();
    assert_eq!(CAPTURE_VISITS.with(|n| n.get()), 1);
    assert_eq!(a.record().status.value, "read");
    assert_eq!(a.count("reading_sync_pending"), 1);
}

#[test]
fn reading_incremental_full_namespace_and_single_delta_preserve_over_500_records() {
    let a = Device::new();
    let mut c = a.conn();
    for id in 0..501 {
        x_bookmarks::reading_sync_test_import(
            &mut c,
            Post {
                id: id.to_string(),
                text: format!("reading item {id}"),
                ..Post::default()
            },
        );
    }
    stage(&c, NS, "device").unwrap();
    assert_eq!(a.count("reading_sync_records"), 501);
    assert_eq!(a.count("reading_sync_pending"), 501);
    c.execute("INSERT INTO reading_sync_uploaded SELECT ?1,json_extract(CAST(body AS TEXT),'$.record.key'),id FROM reading_sync_pending",[NS]).unwrap();
    c.execute("DELETE FROM reading_sync_pending", []).unwrap();
    CAPTURE_VISITS.with(|n| n.set(0));
    stage(&c, NS, "device").unwrap();
    assert_eq!(CAPTURE_VISITS.with(|n| n.get()), 0);
    a.edit("read", &["changed"]);
    stage(&c, NS, "device").unwrap();
    assert_eq!(CAPTURE_VISITS.with(|n| n.get()), 1);
    assert_eq!(a.count("reading_sync_pending"), 1);
    stage(&c, "fresh-namespace", "device").unwrap();
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM reading_sync_pending WHERE namespace='fresh-namespace'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        501
    );
    assert_eq!(a.count("reading_sync_records"), 501);
    let mut q=c.prepare("EXPLAIN QUERY PLAN SELECT r.body FROM reading_record_revisions v JOIN reading_sync_records r ON r.item_key=v.item_key WHERE v.revision>?1 AND v.revision<=?2 ORDER BY v.revision,v.item_key").unwrap();
    let plans = q
        .query_map(params![0, 1], |r| r.get::<_, String>(3))
        .unwrap()
        .map(Result::unwrap)
        .collect::<Vec<_>>();
    assert!(
        plans
            .iter()
            .any(|p| p.contains("SEARCH v USING") && p.contains("reading_record_changed_keys")),
        "{plans:?}"
    );
}

#[test]
fn reading_incremental_failure_keeps_cursor_dirty_and_pending_recoverable() {
    let a = Device::new();
    a.seed();
    let c = a.conn();
    stage(&c, NS, "device").unwrap();
    let cursor: i64 = c
        .query_row(
            "SELECT revision FROM reading_stage_cursors WHERE namespace=?1",
            [NS],
            |r| r.get(0),
        )
        .unwrap();
    let pending = a.count("reading_sync_pending");
    let original = a.record();
    c.execute(
        "UPDATE collection_x_items SET post_json='{' WHERE item_key=?1",
        [KEY],
    )
    .unwrap();
    assert!(stage(&c, NS, "device").is_err());
    assert_eq!(a.record(), original);
    assert_eq!(a.count("reading_sync_pending"), pending);
    assert_eq!(
        c.query_row(
            "SELECT revision FROM reading_stage_cursors WHERE namespace=?1",
            [NS],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        cursor
    );
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM reading_input_dirty WHERE item_key=?1",
            [KEY],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    x_bookmarks::reading_sync_test_import(
        &mut a.conn(),
        Post {
            id: "123".into(),
            text: "recovered changed body".into(),
            ..Post::default()
        },
    );
    stage(&c, NS, "device").unwrap();
    assert!(a
        .record()
        .body
        .value
        .unwrap()
        .post
        .text
        .contains("recovered changed body"));
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM reading_input_dirty", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
