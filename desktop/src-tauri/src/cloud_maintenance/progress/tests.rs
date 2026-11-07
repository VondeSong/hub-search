use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
fn database() -> Connection {
    let c = initialize_database(&PathBuf::from(":memory:")).unwrap();
    super::super::schema(&c).unwrap();
    c.execute("INSERT INTO cloud_maintenance_runs(namespace,id,configuration,state,phase,created_at,completed_at,error,proof,purpose) VALUES('ns','run','configuration','preview','read',1,0,'','','cleanup')",[]).unwrap();
    c
}
fn truth(c: &Connection) {
    let raw: u64 = c
        .query_row(
            "SELECT coalesce(sum(length(body)),0) FROM cloud_maintenance_objects",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(staged(c).unwrap(), raw);
    for (replacement, status) in [
        (false, "pending"),
        (false, "read"),
        (false, "deleted"),
        (true, "pending"),
        (true, "verified"),
    ] {
        let expected:usize=c.query_row("SELECT count(*) FROM cloud_maintenance_objects WHERE namespace='ns' AND run='run' AND replacement=?1 AND status=?2",params![replacement,status],|r|r.get(0)).unwrap();
        assert_eq!(
            count(c, "ns", "run", replacement, status).unwrap(),
            expected
        );
    }
}
#[test]
fn maintenance_pending_reads_updates_and_plan_have_bounded_vm_work_over_2001_rounds() {
    let c = database();
    c.execute("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<200001) INSERT INTO cloud_maintenance_objects SELECT 'ns','run',printf('%064x',i),'reading',X'','pending',0 FROM n",[]).unwrap();
    let steps = Arc::new(AtomicUsize::new(0));
    let counted = steps.clone();
    c.progress_handler(
        100,
        Some(move || counted.fetch_add(1, Ordering::Relaxed) >= 2000),
    );
    let mut max_steps = 0;
    let mut read = 0;
    for _ in 0..2001 {
        steps.store(0, Ordering::Relaxed);
        let tx = c.unchecked_transaction().unwrap();
        let page = {
            let mut q = tx.prepare(PENDING_SQL).unwrap();
            let rows = q
                .query_map(params!["ns", "run", false, "pending"], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })
                .unwrap();
            rows.collect::<Result<Vec<_>, _>>().unwrap()
        };
        for (key, _) in page {
            tx.execute("UPDATE cloud_maintenance_objects SET body=X'616263',status='read' WHERE namespace='ns' AND run='run' AND key=?1 AND replacement=0",[key]).unwrap();
            read += 1;
        }
        let view = super::super::plan(&tx, "ns", "run").unwrap();
        assert_eq!(view.objects, 200001);
        assert_eq!(view.read, read);
        assert_eq!(view.staged_bytes, 3 * read as u64);
        assert_eq!(staged(&tx).unwrap(), 3 * read as u64);
        tx.commit().unwrap();
        max_steps = max_steps.max(steps.load(Ordering::Relaxed));
    }
    c.progress_handler(0, None::<fn() -> bool>);
    assert_eq!(read, 200001);
    assert!(
        max_steps < 1500,
        "maintenance round rescanned history: {max_steps} hundreds of instructions"
    );
    truth(&c);
}
#[test]
fn deletion_queue_skips_large_kept_replacement_prefix_and_rebuild_invalidation_rolls_back() {
    let c = database();
    c.execute("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<200001) INSERT INTO cloud_maintenance_objects SELECT 'ns','run',CASE WHEN i<=100001 THEN 'a' ELSE 'b' END||printf('%064x',i),'reading',X'616263','read',0 FROM n",[]).unwrap();
    c.execute("INSERT INTO cloud_maintenance_objects SELECT namespace,run,key,kind,X'646566','verified',1 FROM cloud_maintenance_objects WHERE replacement=0 AND key LIKE 'a%'",[]).unwrap();
    prepare_delete(&c, "ns", "run").unwrap();
    assert_eq!(deletion_remaining(&c, "ns", "run").unwrap(), 100000);
    let steps = Arc::new(AtomicUsize::new(0));
    let counted = steps.clone();
    c.progress_handler(
        100,
        Some(move || counted.fetch_add(1, Ordering::Relaxed) >= 2000),
    );
    let mut max_steps = 0;
    let mut deleted = 0;
    for _ in 0..1000 {
        steps.store(0, Ordering::Relaxed);
        let tx = c.unchecked_transaction().unwrap();
        for (key, _) in deletion_candidates(&tx, "ns", "run").unwrap() {
            assert!(key.starts_with('b'));
            tx.execute("UPDATE cloud_maintenance_objects SET status='deleted' WHERE namespace='ns' AND run='run' AND key=?1 AND replacement=0",[key]).unwrap();
            deleted += 1;
        }
        assert_eq!(
            deletion_remaining(&tx, "ns", "run").unwrap(),
            100000 - deleted
        );
        let view = super::super::plan(&tx, "ns", "run").unwrap();
        assert_eq!(view.objects, 200001);
        assert_eq!(view.deleted, deleted);
        tx.commit().unwrap();
        max_steps = max_steps.max(steps.load(Ordering::Relaxed));
    }
    c.progress_handler(0, None::<fn() -> bool>);
    assert!(
        max_steps < 1500,
        "kept replacement prefix was rescanned: {max_steps} hundreds of instructions"
    );
    assert_eq!(deleted, 100000);
    truth(&c);
    let before = staged(&c).unwrap();
    {
        let tx = c.unchecked_transaction().unwrap();
        invalidate_delete(&tx, "ns", "run").unwrap();
        tx.execute(
            "DELETE FROM cloud_maintenance_objects WHERE replacement=1",
            [],
        )
        .unwrap();
        assert!(deletion_remaining(&tx, "ns", "run").is_err());
        assert!(staged(&tx).unwrap() < before);
    }
    assert_eq!(deletion_remaining(&c, "ns", "run").unwrap(), 0);
    assert_eq!(staged(&c).unwrap(), before);
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM cloud_maintenance_objects WHERE replacement=1",
            [],
            |r| r.get::<_, usize>(0)
        )
        .unwrap(),
        100001
    );
}
#[test]
fn counters_preserve_duplicate_upsert_bytes_and_rollback_exact_original_status() {
    let c = database();
    c.execute("INSERT INTO cloud_maintenance_objects VALUES('ns','run','key','reading',X'61','pending',0)",[]).unwrap();
    truth(&c);
    {
        let tx = c.unchecked_transaction().unwrap();
        tx.execute(
            "UPDATE cloud_maintenance_objects SET status='read',body=X'616263'",
            [],
        )
        .unwrap();
        truth(&tx);
    }
    assert_eq!(count(&c, "ns", "run", false, "pending").unwrap(), 1);
    assert_eq!(staged(&c).unwrap(), 1);
    for body in [b"two".as_slice(), b"three".as_slice(), b"three".as_slice()] {
        c.execute("INSERT INTO cloud_maintenance_objects VALUES('ns','run','replacement','reading',?1,'pending',1) ON CONFLICT(namespace,run,key,replacement) DO UPDATE SET kind=excluded.kind,body=excluded.body,status=excluded.status",[body]).unwrap();
        truth(&c);
    }
    assert_eq!(count(&c, "ns", "run", true, "pending").unwrap(), 1);
    assert_eq!(staged(&c).unwrap(), 6);
    c.execute("UPDATE cloud_maintenance_objects SET body=X''", [])
        .unwrap();
    assert_eq!(staged(&c).unwrap(), 0);
    truth(&c);
}
#[test]
fn released_database_backfill_is_exact_and_does_not_repeat_after_status_changes() {
    let c = initialize_database(&PathBuf::from(":memory:")).unwrap();
    // This is the released pre-counter schema, before the new owner is first adopted.
    c.execute_batch("CREATE TABLE cloud_maintenance_runs(namespace TEXT NOT NULL,id TEXT NOT NULL,configuration TEXT NOT NULL,state TEXT NOT NULL,phase TEXT NOT NULL,created_at INTEGER NOT NULL,completed_at INTEGER NOT NULL,error TEXT NOT NULL,proof TEXT NOT NULL,purpose TEXT NOT NULL,PRIMARY KEY(namespace,id)); CREATE TABLE cloud_maintenance_objects(namespace TEXT NOT NULL,run TEXT NOT NULL,key TEXT NOT NULL,kind TEXT NOT NULL,body BLOB NOT NULL,status TEXT NOT NULL,replacement INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(namespace,run,key,replacement));").unwrap();
    c.execute("INSERT INTO cloud_maintenance_runs VALUES('ns','run','configuration','preview','read',1,0,'','','cleanup')",[]).unwrap();
    c.execute("INSERT INTO cloud_maintenance_objects VALUES('ns','run','one','reading',X'616263','read',0),('ns','run','two','copies',X'61','pending',0),('ns','other','three','devices',X'6162','pending',1)",[]).unwrap();
    super::super::schema(&c).unwrap();
    truth(&c);
    assert_eq!(staged(&c).unwrap(), 6);
    c.execute(
        "UPDATE cloud_maintenance_objects SET body=X'61626364',status='read' WHERE key='two'",
        [],
    )
    .unwrap();
    truth(&c);
    assert_eq!(staged(&c).unwrap(), 9);
    super::super::schema(&c).unwrap();
    truth(&c);
    assert_eq!(count(&c, "ns", "run", false, "read").unwrap(), 2);
    assert_eq!(staged(&c).unwrap(), 9);
}
#[test]
fn exact_delete_ack_and_counter_state_survive_reopen_and_rollback() {
    let root = std::env::temp_dir().join(format!(
        "hub-maintenance-progress-unit-{}",
        random_url_safe(16)
    ));
    fs::create_dir_all(&root).unwrap();
    let db = root.join("index.sqlite3");
    let c = initialize_database(&db).unwrap();
    super::super::schema(&c).unwrap();
    c.execute("INSERT INTO cloud_maintenance_runs(namespace,id,configuration,state,phase,created_at,completed_at,error,proof,purpose) VALUES('ns','run','configuration','ready','ready',1,0,'','','cleanup')",[]).unwrap();
    c.execute("INSERT INTO cloud_maintenance_objects VALUES('ns','run','first','reading',X'616263','read',0),('ns','run','second','reading',X'61','read',0)",[]).unwrap();
    prepare_delete(&c, "ns", "run").unwrap();
    {
        let tx = c.unchecked_transaction().unwrap();
        tx.execute(
            "UPDATE cloud_maintenance_objects SET status='deleted' WHERE key='first'",
            [],
        )
        .unwrap();
        assert_eq!(deletion_remaining(&tx, "ns", "run").unwrap(), 1);
        assert_eq!(
            deletion_candidates(&tx, "ns", "run").unwrap()[0].0,
            "second"
        );
    }
    drop(c);
    let c = open_database(&db).unwrap();
    super::super::schema(&c).unwrap();
    assert_eq!(deletion_remaining(&c, "ns", "run").unwrap(), 2);
    assert_eq!(deletion_candidates(&c, "ns", "run").unwrap()[0].0, "first");
    truth(&c);
    c.execute(
        "UPDATE cloud_maintenance_objects SET status='deleted' WHERE key='first'",
        [],
    )
    .unwrap();
    drop(c);
    let c = open_database(&db).unwrap();
    assert_eq!(deletion_remaining(&c, "ns", "run").unwrap(), 1);
    assert_eq!(deletion_candidates(&c, "ns", "run").unwrap()[0].0, "second");
    truth(&c);
    drop(c);
    forget_initialized_database(&db);
    assert!(root
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("hub-maintenance-progress-unit-"));
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn plan_and_status_are_read_only_after_writer_initialization() {
    let c = database();
    super::super::prepare_status(&c).unwrap();
    c.execute("INSERT INTO cloud_maintenance_objects VALUES('ns','run','key','reading',X'616263','read',0)",[]).unwrap();
    c.execute_batch("PRAGMA query_only=ON").unwrap();
    let view = super::super::plan(&c, "ns", "run").unwrap();
    assert_eq!(view.objects, 1);
    assert_eq!(view.read, 1);
    assert_eq!(view.staged_bytes, 3);
    assert!(!super::super::status(&c).unwrap().current_device.is_empty());
    assert_eq!(staged(&c).unwrap(), 3);
}
