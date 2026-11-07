use super::*;
use crate::reading_sync::object_store::InventoryPage;
use futures::future::BoxFuture;
use std::sync::atomic::{AtomicBool, Ordering};

struct Database {
    root: PathBuf,
    db: PathBuf,
}
impl Database {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hub-migration-inventory-unit-{}",
            random_url_safe(16)
        ));
        fs::create_dir_all(&root).unwrap();
        let db = root.join("index.sqlite3");
        initialize_database(&db).unwrap();
        Self { root, db }
    }
    fn c(&self) -> Connection {
        open_database(&self.db).unwrap()
    }
}
impl Drop for Database {
    fn drop(&mut self) {
        forget_initialized_database(&self.db);
        assert!(self
            .root
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("hub-migration-inventory-unit-"));
        let _ = fs::remove_dir_all(&self.root);
    }
}
struct Pages {
    fail: AtomicBool,
    invalid: AtomicBool,
    calls: Mutex<Vec<(String, Option<String>)>>,
}
impl Pages {
    fn new() -> Self {
        Self {
            fail: AtomicBool::new(true),
            invalid: AtomicBool::new(false),
            calls: Mutex::new(Vec::new()),
        }
    }
}
impl Store for Pages {
    fn key(&self, r: &str) -> String {
        format!("owned/{r}")
    }
    fn check_network(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
    fn head_size<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<Option<u64>, String>> {
        Box::pin(async { panic!("inventory must not HEAD payloads") })
    }
    fn get<'a>(&'a self, _: &'a str, _: usize) -> BoxFuture<'a, Result<Option<Vec<u8>>, String>> {
        Box::pin(async { panic!("inventory must not GET payloads") })
    }
    fn list<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<Vec<String>, String>> {
        Box::pin(async { panic!("complete listing path is retired") })
    }
    fn put_verified<'a>(&'a self, _: &'a str, _: &'a [u8]) -> BoxFuture<'a, Result<bool, String>> {
        Box::pin(async { panic!("listing must not publish") })
    }
    fn delete_exact<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async { panic!("listing must not delete") })
    }
    fn inventory_page<'a>(
        &'a self,
        r: &'a str,
        next: Option<&'a str>,
    ) -> BoxFuture<'a, Result<InventoryPage, String>> {
        Box::pin(async move {
            self.calls
                .lock()
                .unwrap()
                .push((r.into(), next.map(str::to_owned)));
            if r != "reading/v1/changes/" {
                return Ok(InventoryPage::default());
            }
            match next {
                None => Ok(InventoryPage {
                    keys: vec![self.key(&format!("{r}{}.json", "a".repeat(64)))],
                    next: Some("second".into()),
                    directories: Vec::new(),
                }),
                Some("second") if self.fail.swap(false, Ordering::SeqCst) => {
                    Err("injected second-page transport interruption".into())
                }
                Some("second") => Ok(InventoryPage {
                    keys: vec![self.key(&format!(
                        "{r}{}.json",
                        if self.invalid.load(Ordering::SeqCst) {
                            "invalid".into()
                        } else {
                            "b".repeat(64)
                        }
                    ))],
                    next: None,
                    directories: Vec::new(),
                }),
                _ => panic!("unexpected continuation"),
            }
        })
    }
}
#[tokio::test]
async fn paged_migration_restart_never_exposes_incomplete_manifest_and_resumes_exact_continuation()
{
    let db = Database::new();
    let remote = Pages::new();
    assert!(
        acquire(&db.db, &remote, "ns", "job", "source", "copy", true)
            .await
            .is_err()
    );
    let c = db.c();
    let batch: String = c
        .query_row(
            "SELECT batch FROM cloud_migration_inventory_heads",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let pending = Inventory { id: batch.clone() };
    assert!(pending.count(&c).is_err());
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM cloud_migration_inventory_keys",
            [],
            |r| r.get::<_, usize>(0)
        )
        .unwrap(),
        0
    );
    drop(c); // A new connection represents process restart; no memory cursor survives.
    let complete = acquire(&db.db, &remote, "ns", "job", "source", "copy", true)
        .await
        .unwrap();
    assert_eq!(complete.id, batch);
    assert_eq!(complete.count(&db.c()).unwrap(), 2);
    let calls = remote.calls.lock().unwrap();
    assert_eq!(
        calls
            .iter()
            .filter(|(r, n)| r == "reading/v1/changes/" && n.is_none())
            .count(),
        1
    );
    assert_eq!(
        calls
            .iter()
            .filter(|(r, n)| r == "reading/v1/changes/" && n.as_deref() == Some("second"))
            .count(),
        2
    );
}
#[tokio::test]
async fn malformed_final_page_retains_epoch_but_cannot_install_complete_inventory() {
    let db = Database::new();
    let remote = Pages::new();
    remote.fail.store(false, Ordering::SeqCst);
    remote.invalid.store(true, Ordering::SeqCst);
    assert!(
        acquire(&db.db, &remote, "ns", "job", "source", "copy", false)
            .await
            .is_err()
    );
    assert_eq!(
        db.c()
            .query_row(
                "SELECT count(*) FROM cloud_migration_inventory_batches WHERE state='complete'",
                [],
                |r| r.get::<_, usize>(0)
            )
            .unwrap(),
        0
    );
    assert_eq!(
        db.c()
            .query_row(
                "SELECT count(*) FROM cloud_migration_inventory_keys",
                [],
                |r| r.get::<_, usize>(0)
            )
            .unwrap(),
        0
    );
}
fn manifest(c: &Connection, id: &str, keys: &[&str]) -> Inventory {
    super::super::schema(c).unwrap();
    c.execute("INSERT INTO cloud_migration_inventory_batches VALUES(?1,'job','source','test','ns','complete')",[id]).unwrap();
    for key in keys {
        c.execute(
            "INSERT INTO cloud_migration_inventory_keys VALUES(?1,?2,?3)",
            params![id, key, priority(key)],
        )
        .unwrap();
    }
    let inventory = Inventory { id: id.into() };
    pending::seal(c, &inventory).unwrap();
    inventory
}
#[test]
fn sql_inventory_allows_large_history_and_limits_heartbeat_extensions_to_append_only() {
    let c = Connection::open_in_memory().unwrap();
    let old = manifest(&c, "old", &["reading/v1/changes/a"]);
    let appended = manifest(
        &c,
        "append",
        &["reading/v1/changes/a", "reading/devices-v1/changes/b"],
    );
    assert!(appended.append_heartbeats(&c, &old).unwrap());
    assert!(!old.append_heartbeats(&c, &appended).unwrap());
    let changed = manifest(
        &c,
        "changed",
        &["reading/v1/changes/a", "reading/v1/changes/b"],
    );
    assert!(!changed.append_heartbeats(&c, &old).unwrap());
    c.execute("INSERT INTO cloud_migration_inventory_batches VALUES('large','job','source','test','ns','listing')",[]).unwrap();
    c.execute("INSERT INTO cloud_migration_inventory_keys SELECT 'large',key,priority FROM cloud_migration_inventory_keys WHERE batch='changed'",[]).unwrap();
    c.execute("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<200001) INSERT INTO cloud_migration_inventory_keys SELECT 'large','reading/source-v1/'||printf('%064x',i),1 FROM n",[]).unwrap();
    c.execute(
        "UPDATE cloud_migration_inventory_batches SET state='complete' WHERE id='large'",
        [],
    )
    .unwrap();
    let large = Inventory { id: "large".into() };
    pending::seal(&c, &large).unwrap();
    assert_eq!(large.count(&c).unwrap(), 200003);
    assert!(large.covers(&c, &old).unwrap());
    assert!(!large.equal(&c, &old).unwrap());
}
#[test]
fn complete_released_key_json_over_32_mib_is_streamed_and_malformed_eof_rolls_back() {
    let db = Database::new();
    let c = db.c();
    super::super::schema(&c).unwrap();
    c.execute("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<350001) INSERT INTO cloud_migration_verifications SELECT 'job','scope','attempt','running',350001,'['||group_concat(json_quote('reading/checkpoints-v1/proofs/'||printf('%064x',i)||'.json'))||']','[]' FROM n",[]).unwrap();
    let bytes: i64 = c
        .query_row(
            "SELECT length(source_keys) FROM cloud_migration_verifications",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(bytes > 32 * 1024 * 1024);
    let inventory = previous(&c, "job", "attempt", "source").unwrap().unwrap();
    assert_eq!(inventory.count(&c).unwrap(), 350001);
    let tx = c.unchecked_transaction().unwrap();
    compatibility(&tx, "job", "attempt", &inventory, &inventory).unwrap();
    tx.commit().unwrap();
    assert_eq!(c.query_row("SELECT typeof(source_keys)='text' AND json_valid(source_keys) AND json_array_length(source_keys)=350001 FROM cloud_migration_verifications",[],|r|r.get::<_,bool>(0)).unwrap(),true);
    c.execute("UPDATE cloud_migration_verifications SET attempt='broken',source_keys='[\"reading/source-v1/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"] trailing'",[]).unwrap();
    let before: i64 = c
        .query_row(
            "SELECT count(*) FROM cloud_migration_inventory_batches",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(previous(&c, "job", "broken", "source").unwrap().is_none());
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM cloud_migration_inventory_batches",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        before
    );
}
#[test]
fn incomplete_manifest_cannot_write_released_compatibility_receipt() {
    let c = Connection::open_in_memory().unwrap();
    super::super::schema(&c).unwrap();
    let inventory = manifest(&c, "pending", &[]);
    c.execute(
        "UPDATE cloud_migration_inventory_batches SET state='listing'",
        [],
    )
    .unwrap();
    c.execute("INSERT INTO cloud_migration_verifications VALUES('job','scope','attempt','running',0,'[]','[]')",[]).unwrap();
    assert!(compatibility(&c, "job", "attempt", &inventory, &inventory).is_err());
    assert_eq!(
        c.query_row(
            "SELECT source_keys FROM cloud_migration_verifications",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "[]"
    );
}

use std::sync::atomic::AtomicUsize;
fn database() -> (Connection, Inventory) {
    let c = Connection::open_in_memory().unwrap();
    super::super::schema(&c).unwrap();
    c.execute("INSERT INTO cloud_migration_inventory_batches VALUES('batch','job','source','test','ns','listing')",[]).unwrap();
    c.execute("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<200001) INSERT INTO cloud_migration_inventory_keys SELECT 'batch',CASE i%3 WHEN 0 THEN 'reading/media-v1/manifests/' WHEN 1 THEN 'reading/source-v1/' ELSE 'reading/media-v1/blobs/' END||printf('%064x',i),CASE i%3 WHEN 0 THEN 0 WHEN 1 THEN 1 ELSE 2 END FROM n",[]).unwrap();
    c.execute(
        "UPDATE cloud_migration_inventory_batches SET state='complete' WHERE id='batch'",
        [],
    )
    .unwrap();
    let inventory = Inventory { id: "batch".into() };
    pending::seal(&c, &inventory).unwrap();
    c.execute("INSERT INTO cloud_migration_objects SELECT 'job',key,'pending',0 FROM cloud_migration_inventory_keys WHERE batch='batch'",[]).unwrap();
    pending::prepare_copy(&c, &inventory, "job").unwrap();
    (c, inventory)
}
#[test]
fn indexed_copy_and_check_acknowledgements_keep_vm_cost_bounded_through_2001_rounds() {
    let (c, inventory) = database();
    let steps = Arc::new(AtomicUsize::new(0));
    let callback = steps.clone();
    c.progress_handler(
        100,
        Some(move || callback.fetch_add(1, Ordering::Relaxed) >= 1500),
    );
    let mut max_round = 0usize;
    let mut copied = 0usize;
    let mut last = None;
    for _round in 0..2001 {
        steps.store(0, Ordering::Relaxed);
        let tx = c.unchecked_transaction().unwrap();
        for _ in 0..100 {
            let Some(key) = inventory.next(&tx, "job", None).unwrap() else {
                break;
            };
            let ordering = (priority(&key), key.clone());
            if let Some(previous) = last.as_ref() {
                assert!(previous < &ordering);
            }
            last = Some(ordering);
            tx.execute("UPDATE cloud_migration_objects SET state='verified' WHERE job='job' AND object_key=?1",[&key]).unwrap();
            copied += 1;
        }
        assert_eq!(pending::receipts(&tx, "copy", "job").unwrap(), copied);
        assert_eq!(inventory.count(&tx).unwrap(), 200001);
        tx.commit().unwrap();
        max_round = max_round.max(steps.load(Ordering::Relaxed));
    }
    assert_eq!(copied, 200001);
    assert!(inventory.next(&c, "job", None).unwrap().is_none());
    assert!(
        max_round < 1000,
        "copy round scanned acknowledged prefix: {max_round} hundreds of SQLite instructions"
    );
    c.progress_handler(0, None::<fn() -> bool>);
    pending::prepare_checks(&c, &inventory, "attempt", "source").unwrap();
    let callback = steps.clone();
    c.progress_handler(
        100,
        Some(move || callback.fetch_add(1, Ordering::Relaxed) >= 1500),
    );
    let mut checked = 0usize;
    let mut max_check_round = 0usize;
    for _round in 0..2001 {
        steps.store(0, Ordering::Relaxed);
        let tx = c.unchecked_transaction().unwrap();
        for _ in 0..100 {
            let Some(key) = inventory
                .next(&tx, "job", Some(("attempt", "source")))
                .unwrap()
            else {
                break;
            };
            tx.execute("INSERT INTO cloud_migration_checks VALUES('attempt','source',?1,1) ON CONFLICT(attempt,side,object_key) DO UPDATE SET size=excluded.size",[&key]).unwrap();
            checked += 1;
        }
        assert_eq!(pending::receipts(&tx, "check", "attempt").unwrap(), checked);
        assert_eq!(inventory.count(&tx).unwrap(), 200001);
        tx.commit().unwrap();
        max_check_round = max_check_round.max(steps.load(Ordering::Relaxed));
    }
    c.progress_handler(0, None::<fn() -> bool>);
    assert_eq!(checked, 200001);
    assert!(max_check_round<1000,"check round scanned acknowledged prefix: {max_check_round} hundreds of SQLite instructions");
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM cloud_migration_inventory_keys WHERE batch='batch'",
            [],
            |r| r.get::<_, usize>(0)
        )
        .unwrap(),
        200001
    );
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM cloud_migration_checks WHERE attempt='attempt'",
            [],
            |r| r.get::<_, usize>(0)
        )
        .unwrap(),
        200001
    );
}
#[test]
fn pending_and_counter_changes_rollback_and_reopen_without_losing_priority_or_other_side() {
    let db = Database::new();
    let c = db.c();
    super::super::schema(&c).unwrap();
    let manifest_key = format!("reading/media-v1/manifests/{}.json", "a".repeat(64));
    let blob_key = format!("reading/media-v1/blobs/{}", "a".repeat(64));
    let inventory = manifest(&c, "rollback", &[&blob_key, &manifest_key]);
    pending::prepare_copy(&c, &inventory, "job").unwrap();
    c.execute("INSERT INTO cloud_migration_objects SELECT 'job',key,'pending',0 FROM cloud_migration_inventory_keys WHERE batch='rollback'",[]).unwrap();
    assert_eq!(
        inventory.next(&c, "job", None).unwrap(),
        Some(manifest_key.clone())
    );
    {
        let tx = c.unchecked_transaction().unwrap();
        tx.execute(
            "UPDATE cloud_migration_objects SET state='verified' WHERE job='job' AND object_key=?1",
            [&manifest_key],
        )
        .unwrap();
        assert_eq!(pending::receipts(&tx, "copy", "job").unwrap(), 1);
        assert_eq!(
            inventory.next(&tx, "job", None).unwrap(),
            Some(blob_key.clone())
        );
    }
    assert_eq!(pending::receipts(&c, "copy", "job").unwrap(), 0);
    drop(c);
    let c = db.c();
    assert_eq!(
        inventory.next(&c, "job", None).unwrap(),
        Some(manifest_key.clone())
    );
    pending::prepare_checks(&c, &inventory, "attempt", "source").unwrap();
    pending::prepare_checks(&c, &inventory, "attempt", "target").unwrap();
    {
        let tx = c.unchecked_transaction().unwrap();
        tx.execute(
            "INSERT INTO cloud_migration_checks VALUES('attempt','source',?1,1)",
            [&manifest_key],
        )
        .unwrap();
        assert_eq!(
            inventory
                .next(&tx, "job", Some(("attempt", "source")))
                .unwrap(),
            Some(blob_key.clone())
        );
        assert_eq!(
            inventory
                .next(&tx, "job", Some(("attempt", "target")))
                .unwrap(),
            Some(manifest_key.clone())
        );
    }
    assert_eq!(pending::receipts(&c, "check", "attempt").unwrap(), 0);
    drop(c);
    let c = db.c();
    assert_eq!(
        inventory
            .next(&c, "job", Some(("attempt", "source")))
            .unwrap(),
        Some(manifest_key)
    );
}
#[test]
fn released_acknowledgements_are_adopted_once_and_exact_identity_transitions_restore_pending() {
    let c = Connection::open_in_memory().unwrap();
    super::super::schema(&c).unwrap();
    let a = format!("reading/source-v1/{}", "a".repeat(64));
    let b = format!("reading/source-v1/{}", "b".repeat(64));
    let inventory = manifest(&c, "adoption", &[&a, &b]);
    c.execute(
        "INSERT INTO cloud_migration_objects VALUES('job',?1,'verified',1)",
        [&a],
    )
    .unwrap();
    c.execute(
        "INSERT INTO cloud_migration_checks VALUES('attempt','source',?1,1)",
        [&a],
    )
    .unwrap();
    pending::prepare_copy(&c, &inventory, "job").unwrap();
    pending::prepare_checks(&c, &inventory, "attempt", "source").unwrap();
    pending::prepare_checks(&c, &inventory, "attempt", "target").unwrap();
    assert_eq!(pending::receipts(&c, "copy", "job").unwrap(), 1);
    assert_eq!(pending::receipts(&c, "check", "attempt").unwrap(), 1);
    assert_eq!(inventory.next(&c, "job", None).unwrap(), Some(b.clone()));
    assert_eq!(
        inventory
            .next(&c, "job", Some(("attempt", "target")))
            .unwrap(),
        Some(a.clone())
    );
    c.execute(
        "UPDATE cloud_migration_objects SET object_key=?1 WHERE job='job' AND object_key=?2",
        params![b, a],
    )
    .unwrap();
    assert_eq!(pending::receipts(&c, "copy", "job").unwrap(), 1);
    assert_eq!(inventory.next(&c, "job", None).unwrap(), Some(a.clone()));
    c.execute(
        "UPDATE cloud_migration_objects SET state='pending' WHERE job='job' AND object_key=?1",
        [&b],
    )
    .unwrap();
    assert_eq!(pending::receipts(&c, "copy", "job").unwrap(), 0);
    for size in [2, 2, 3] {
        c.execute("INSERT INTO cloud_migration_checks VALUES('attempt','source',?1,?2) ON CONFLICT(attempt,side,object_key) DO UPDATE SET size=excluded.size",params![a,size]).unwrap();
    }
    assert_eq!(pending::receipts(&c, "check", "attempt").unwrap(), 1);
    c.execute("DELETE FROM cloud_migration_checks WHERE attempt='attempt' AND side='source' AND object_key=?1",[&a]).unwrap();
    assert_eq!(pending::receipts(&c, "check", "attempt").unwrap(), 0);
    assert_eq!(
        inventory
            .next(&c, "job", Some(("attempt", "source")))
            .unwrap(),
        Some(a)
    );
    pending::prepare_checks(&c, &inventory, "attempt", "source").unwrap();
    assert_eq!(pending::receipts(&c, "check", "attempt").unwrap(), 0);
}
