use super::*;
use crate::flashcard_cloud_sync::tests::{server, store};
use crate::reading_sync::object_store::InventoryPage;
use futures::future::BoxFuture;
use std::sync::{Arc, Mutex};

fn fixture(label: &str) -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../task-state/project-optimization-20261011/cloud-inventory-tests")
        .join(format!("{label}-{}", random_url_safe(10)));
    std::fs::create_dir_all(&root).unwrap();
    let db = root.join("hub.sqlite3");
    open_database(&db).unwrap();
    db
}
fn run_state(c: &Connection, ns: &str, scope: &str) -> (String, String) {
    c.query_row("SELECT epoch,state FROM cloud_inventory_runs WHERE namespace=?1 AND scope=?2 ORDER BY created_at DESC,epoch LIMIT 1",params![ns,scope],|r|Ok((r.get(0)?,r.get(1)?))).unwrap()
}

#[tokio::test]
async fn inventory_real_oss_over_two_hundred_thousand_objects_has_complete_sql_epoch() {
    let s = server().await;
    s.state.lock().unwrap().virtual_list_count = Some(200_001);
    let remote = store(&s);
    let db = fixture("oss-200001");
    let inventory = acquire(&db, &remote, "scale", "all", "changes/")
        .await
        .unwrap();
    let c = open_database(&db).unwrap();
    assert_eq!(inventory.count(&c).unwrap(), 200_001);
    assert_eq!(s.state.lock().unwrap().list_pages, 201);
    let first = inventory.next(&c, None).unwrap().unwrap();
    assert!(first.starts_with(&remote.key("changes/")));
    let (minimum,maximum):(String,String)=c.query_row("SELECT min(relative_key),max(relative_key) FROM cloud_inventory_objects WHERE namespace=?1 AND epoch=?2",params![inventory.namespace,inventory.epoch],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
    assert!(minimum.starts_with("changes/virtual-000000-"));
    assert!(maximum.starts_with("changes/virtual-200000-"));
    c.execute_batch("VACUUM;").unwrap();
    let reopened = load(&c, "scale", "all", &inventory.epoch).unwrap();
    assert_eq!(reopened.count(&c).unwrap(), 200_001);
}

#[tokio::test]
async fn inventory_failed_page_retains_keys_without_authority_and_resumes_exact_epoch() {
    let s = server().await;
    {
        let mut state = s.state.lock().unwrap();
        state.virtual_list_count = Some(2001);
        state.fail_list_page = Some(2);
    }
    let remote = store(&s);
    let db = fixture("page-restart");
    assert!(acquire(&db, &remote, "restart", "changes", "changes/")
        .await
        .is_err());
    let (epoch, state) = run_state(&open_database(&db).unwrap(), "restart", "changes");
    assert_eq!(state, "listing");
    let c = open_database(&db).unwrap();
    assert_eq!(
        c.query_row("SELECT count(*) FROM cloud_inventory_objects", [], |r| {
            r.get::<_, usize>(0)
        })
        .unwrap(),
        1000
    );
    let incomplete = load(&c, "restart", "changes", &epoch).unwrap();
    assert!(incomplete.ensure_complete(&c).is_err());
    assert!(incomplete.next(&c, None).is_err());
    drop(c);
    s.state.lock().unwrap().fail_list_page = None;
    crate::forget_initialized_database(&db);
    let resumed = acquire(&db, &remote, "restart", "changes", "changes/")
        .await
        .unwrap();
    assert_eq!(resumed.epoch, epoch);
    assert_eq!(resumed.count(&open_database(&db).unwrap()).unwrap(), 2001);
}

#[tokio::test]
async fn inventory_repeated_provider_token_preserves_prefix_and_never_completes() {
    let s = server().await;
    {
        let mut state = s.state.lock().unwrap();
        state.virtual_list_count = Some(3001);
        state.repeat_list_token = true;
    }
    let remote = store(&s);
    let db = fixture("token-loop");
    assert!(acquire(&db, &remote, "tokens", "history", "changes/")
        .await
        .unwrap_err()
        .contains("游标重复"));
    let c = open_database(&db).unwrap();
    let (epoch, state) = run_state(&c, "tokens", "history");
    assert_eq!(state, "listing");
    assert_eq!(
        c.query_row("SELECT count(*) FROM cloud_inventory_objects", [], |r| {
            r.get::<_, usize>(0)
        })
        .unwrap(),
        1000
    );
    assert!(load(&c, "tokens", "history", &epoch)
        .unwrap()
        .ensure_complete(&c)
        .is_err());
}

struct Pages {
    page: Arc<Mutex<InventoryPage>>,
}
impl Store for Pages {
    fn key(&self, r: &str) -> String {
        format!("test/v2/{r}")
    }
    fn check_network(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
    fn head_size<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<Option<u64>, String>> {
        Box::pin(async { Ok(None) })
    }
    fn get<'a>(&'a self, _: &'a str, _: usize) -> BoxFuture<'a, Result<Option<Vec<u8>>, String>> {
        Box::pin(async { Err("unused".into()) })
    }
    fn list<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<Vec<String>, String>> {
        Box::pin(async { panic!("aggregate inventory must never be called") })
    }
    fn inventory_page<'a>(
        &'a self,
        _: &'a str,
        _: Option<&'a str>,
    ) -> BoxFuture<'a, Result<InventoryPage, String>> {
        Box::pin(async move { Ok(self.page.lock().unwrap().clone()) })
    }
    fn put_verified<'a>(&'a self, _: &'a str, _: &'a [u8]) -> BoxFuture<'a, Result<bool, String>> {
        Box::pin(async { Err("unused".into()) })
    }
    fn delete_exact<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async { Err("unused".into()) })
    }
}
#[tokio::test]
async fn inventory_rejects_escaped_and_cyclic_pages_and_changed_scope_cannot_reuse_authority() {
    let page = Arc::new(Mutex::new(InventoryPage {
        keys: vec!["other/v2/reading/x.json".into()],
        ..InventoryPage::default()
    }));
    let remote = Pages { page: page.clone() };
    let db = fixture("scope-boundary");
    assert!(acquire(&db, &remote, "n", "scope", "reading/")
        .await
        .is_err());
    let old = run_state(&open_database(&db).unwrap(), "n", "scope").0;
    *page.lock().unwrap() = InventoryPage {
        directories: vec!["reading/".into()],
        ..InventoryPage::default()
    };
    assert!(acquire(&db, &remote, "n", "scope", "reading/")
        .await
        .is_err());
    *page.lock().unwrap() = InventoryPage {
        keys: vec![remote.key("changes/test.json")],
        ..InventoryPage::default()
    };
    let changed = acquire(&db, &remote, "n", "scope", "changes/")
        .await
        .unwrap();
    assert_ne!(changed.epoch, old);
    let c = open_database(&db).unwrap();
    assert_eq!(changed.count(&c).unwrap(), 1);
    assert!(load(&c, "n", "scope", &old)
        .unwrap()
        .ensure_complete(&c)
        .is_err());
    let mut forged = changed.clone();
    forged.prefix = remote.key("reading/");
    assert!(forged.ensure_complete(&c).is_err());
}

#[tokio::test]
async fn inventory_receiver_resume_joins_applied_receipts_and_release_is_atomic() {
    let page = Arc::new(Mutex::new(InventoryPage::default()));
    let remote = Pages { page: page.clone() };
    let db = fixture("receipt-tail");
    let c = open_database(&db).unwrap();
    c.execute_batch("CREATE TABLE IF NOT EXISTS reading_sync_applied(namespace TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(namespace,id));").unwrap();
    for index in 0..103 {
        page.lock()
            .unwrap()
            .keys
            .push(remote.key(&format!("reading/v1/changes/{index:064x}.json")));
    }
    let inventory = acquire_receive(
        &db,
        &remote,
        "receipts",
        "reader",
        "reading/v1/changes/",
        "reading_sync_applied",
    )
    .await
    .unwrap();
    let tx = c.unchecked_transaction().unwrap();
    for index in 0..100 {
        tx.execute(
            "INSERT INTO reading_sync_applied VALUES('receipts',?1)",
            [format!("{index:064x}")],
        )
        .unwrap();
    }
    tx.commit().unwrap();
    assert_eq!(
        inventory
            .unapplied_count(&c, "reading_sync_applied")
            .unwrap(),
        3
    );
    assert!(inventory
        .next_unapplied(&c, "reading_sync_applied", None)
        .unwrap()
        .unwrap()
        .ends_with(&format!("{:064x}.json", 100)));
    *page.lock().unwrap() = InventoryPage::default(); // Frozen keys survive a later provider disappearance.
    let resumed = acquire_receive(
        &db,
        &remote,
        "receipts",
        "reader",
        "reading/v1/changes/",
        "reading_sync_applied",
    )
    .await
    .unwrap();
    assert_eq!(resumed.epoch, inventory.epoch);
    c.execute_batch("CREATE TRIGGER block_inventory_release BEFORE DELETE ON cloud_inventory_runs BEGIN SELECT RAISE(ABORT,'retained'); END;").unwrap();
    assert!(inventory.release(&c).is_err());
    assert_eq!(inventory.count(&c).unwrap(), 103);
    assert_eq!(
        inventory
            .unapplied_count(&c, "reading_sync_applied")
            .unwrap(),
        3
    );
    c.execute_batch("DROP TRIGGER block_inventory_release;")
        .unwrap();
    inventory.release(&c).unwrap();
    assert_eq!(
        c.query_row("SELECT count(*) FROM cloud_inventory_objects", [], |r| {
            r.get::<_, usize>(0)
        })
        .unwrap(),
        0
    );
}

struct NumberedPages {
    total: usize,
    calls: std::sync::atomic::AtomicUsize,
}
impl Store for NumberedPages {
    fn key(&self, r: &str) -> String {
        format!("test/v2/{r}")
    }
    fn check_network(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
    fn head_size<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<Option<u64>, String>> {
        Box::pin(async { Err("unused".into()) })
    }
    fn get<'a>(&'a self, _: &'a str, _: usize) -> BoxFuture<'a, Result<Option<Vec<u8>>, String>> {
        Box::pin(async { Err("unused".into()) })
    }
    fn list<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<Vec<String>, String>> {
        Box::pin(async { panic!("aggregate listing forbidden") })
    }
    fn inventory_page<'a>(
        &'a self,
        r: &'a str,
        token: Option<&'a str>,
    ) -> BoxFuture<'a, Result<InventoryPage, String>> {
        Box::pin(async move {
            self.calls
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let start = token.map(|v| v.parse::<usize>().unwrap()).unwrap_or(0);
            let end = (start + 1000).min(self.total);
            Ok(InventoryPage {
                keys: (start..end)
                    .map(|v| self.key(&format!("{r}{v:064x}.json")))
                    .collect(),
                directories: Vec::new(),
                next: (end < self.total).then(|| end.to_string()),
            })
        })
    }
    fn put_verified<'a>(&'a self, _: &'a str, _: &'a [u8]) -> BoxFuture<'a, Result<bool, String>> {
        Box::pin(async { Err("unused".into()) })
    }
    fn delete_exact<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async { Err("unused".into()) })
    }
}

#[tokio::test]
async fn inventory_two_hundred_thousand_receiver_candidates_drain_in_hundred_item_rounds_without_prefix_scans(
) {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let remote = NumberedPages {
        total: 200_001,
        calls: AtomicUsize::new(0),
    };
    let db = fixture("receiver-200001");
    let mut c = open_database(&db).unwrap();
    c.execute_batch("CREATE TABLE IF NOT EXISTS reading_sync_applied(namespace TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(namespace,id));").unwrap();
    let inventory = acquire_receive(
        &db,
        &remote,
        "large-receiver",
        "reading",
        "reading/v1/changes/",
        "reading_sync_applied",
    )
    .await
    .unwrap();
    assert_eq!(remote.calls.load(Ordering::Relaxed), 201);
    assert_eq!(
        inventory
            .unapplied_count(&c, "reading_sync_applied")
            .unwrap(),
        200_001
    );
    // A failed domain transaction must restore both the receipt and exact pending identity.
    let first = inventory
        .next_unapplied(&c, "reading_sync_applied", None)
        .unwrap()
        .unwrap();
    let tx = c.transaction().unwrap();
    tx.execute(
        "INSERT INTO reading_sync_applied VALUES('large-receiver',?1)",
        [format!("{:064x}", 0)],
    )
    .unwrap();
    assert_eq!(
        inventory
            .unapplied_count(&tx, "reading_sync_applied")
            .unwrap(),
        200_000
    );
    tx.rollback().unwrap();
    assert_eq!(
        inventory
            .next_unapplied(&c, "reading_sync_applied", None)
            .unwrap(),
        Some(first)
    );
    assert_eq!(
        inventory
            .unapplied_count(&c, "reading_sync_applied")
            .unwrap(),
        200_001
    );
    let steps = Arc::new(AtomicUsize::new(0));
    let counted = steps.clone();
    c.progress_handler(
        100,
        Some(move || counted.fetch_add(1, Ordering::Relaxed) >= 1000),
    );
    let mut rounds = 0;
    let mut applied = 0;
    let mut max_round_steps = 0;
    while inventory
        .unapplied_count(&c, "reading_sync_applied")
        .unwrap()
        > 0
    {
        let resumed = acquire_receive(
            &db,
            &remote,
            "large-receiver",
            "reading",
            "reading/v1/changes/",
            "reading_sync_applied",
        )
        .await
        .unwrap();
        assert_eq!(resumed.epoch, inventory.epoch);
        steps.store(0, Ordering::Relaxed);
        let tx = c.transaction().unwrap();
        let mut after = None;
        for _ in 0..100 {
            let Some(key) = resumed
                .next_unapplied(&tx, "reading_sync_applied", after.as_deref())
                .unwrap()
            else {
                break;
            };
            let id = key
                .strip_prefix(&remote.key("reading/v1/changes/"))
                .unwrap()
                .strip_suffix(".json")
                .unwrap();
            tx.execute(
                "INSERT INTO reading_sync_applied VALUES('large-receiver',?1)",
                [id],
            )
            .unwrap();
            after = Some(key);
            applied += 1;
        }
        tx.commit().unwrap();
        max_round_steps = max_round_steps.max(steps.load(Ordering::Relaxed));
        rounds += 1;
    }
    c.progress_handler(0, None::<fn() -> bool>);
    assert_eq!(applied, 200_001);
    assert_eq!(rounds, 2001);
    assert_eq!(remote.calls.load(Ordering::Relaxed), 201); // No page fetch per budget round.
    assert!(max_round_steps<1000,"a bounded round scanned the acknowledged prefix: {max_round_steps} hundreds of SQLite VM instructions");
    assert_eq!(inventory.count(&c).unwrap(), 200_001); // Maintenance witness is never pruned.
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM cloud_inventory_receive_candidates",
            [],
            |r| r.get::<_, usize>(0)
        )
        .unwrap(),
        0
    );
    inventory.release(&c).unwrap();
}
