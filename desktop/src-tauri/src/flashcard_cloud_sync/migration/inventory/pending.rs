//! Indexed pending queues never consume the immutable proof witness.
use super::*;

pub(super) fn schema(c: &Connection) -> Result<(), String> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS cloud_migration_inventory_totals(batch TEXT PRIMARY KEY,total INTEGER NOT NULL CHECK(total>=0));
      CREATE TABLE IF NOT EXISTS cloud_migration_copy_progress(batch TEXT NOT NULL,job TEXT NOT NULL,remaining INTEGER NOT NULL CHECK(remaining>=0),PRIMARY KEY(batch,job));
      CREATE TABLE IF NOT EXISTS cloud_migration_copy_candidates(batch TEXT NOT NULL,job TEXT NOT NULL,key TEXT NOT NULL,priority INTEGER NOT NULL,PRIMARY KEY(batch,key));
      CREATE INDEX IF NOT EXISTS cloud_migration_copy_order ON cloud_migration_copy_candidates(batch,job,priority,key);
      CREATE INDEX IF NOT EXISTS cloud_migration_copy_ack ON cloud_migration_copy_candidates(job,key);
      CREATE TABLE IF NOT EXISTS cloud_migration_check_progress(batch TEXT NOT NULL,attempt TEXT NOT NULL,side TEXT NOT NULL,remaining INTEGER NOT NULL CHECK(remaining>=0),PRIMARY KEY(batch,attempt,side));
      CREATE TABLE IF NOT EXISTS cloud_migration_check_candidates(batch TEXT NOT NULL,attempt TEXT NOT NULL,side TEXT NOT NULL,key TEXT NOT NULL,priority INTEGER NOT NULL,PRIMARY KEY(batch,attempt,side,key));
      CREATE INDEX IF NOT EXISTS cloud_migration_check_order ON cloud_migration_check_candidates(batch,attempt,side,priority,key);
      CREATE INDEX IF NOT EXISTS cloud_migration_check_ack ON cloud_migration_check_candidates(attempt,side,key);
      CREATE TABLE IF NOT EXISTS cloud_migration_receipt_counts(operation TEXT NOT NULL,scope TEXT NOT NULL,total INTEGER NOT NULL CHECK(total>=0),PRIMARY KEY(operation,scope));
      CREATE TRIGGER IF NOT EXISTS migration_copy_candidate_add AFTER INSERT ON cloud_migration_copy_candidates
      BEGIN UPDATE cloud_migration_copy_progress SET remaining=remaining+1 WHERE batch=NEW.batch AND job=NEW.job; END;
      CREATE TRIGGER IF NOT EXISTS migration_copy_candidate_remove AFTER DELETE ON cloud_migration_copy_candidates
      BEGIN UPDATE cloud_migration_copy_progress SET remaining=remaining-1 WHERE batch=OLD.batch AND job=OLD.job; END;
      CREATE TRIGGER IF NOT EXISTS migration_check_candidate_add AFTER INSERT ON cloud_migration_check_candidates
      BEGIN UPDATE cloud_migration_check_progress SET remaining=remaining+1 WHERE batch=NEW.batch AND attempt=NEW.attempt AND side=NEW.side; END;
      CREATE TRIGGER IF NOT EXISTS migration_check_candidate_remove AFTER DELETE ON cloud_migration_check_candidates
      BEGIN UPDATE cloud_migration_check_progress SET remaining=remaining-1 WHERE batch=OLD.batch AND attempt=OLD.attempt AND side=OLD.side; END;
      CREATE TRIGGER IF NOT EXISTS migration_copy_receipt_add AFTER INSERT ON cloud_migration_objects WHEN NEW.state='verified'
      BEGIN UPDATE cloud_migration_receipt_counts SET total=total+1 WHERE operation='copy' AND scope=NEW.job;
        DELETE FROM cloud_migration_copy_candidates WHERE job=NEW.job AND key=NEW.object_key; END;
      CREATE TRIGGER IF NOT EXISTS migration_copy_receipt_update AFTER UPDATE ON cloud_migration_objects
      BEGIN UPDATE cloud_migration_receipt_counts SET total=total-1 WHERE operation='copy' AND scope=OLD.job AND OLD.state='verified' AND (NEW.state<>'verified' OR OLD.job<>NEW.job);
        UPDATE cloud_migration_receipt_counts SET total=total+1 WHERE operation='copy' AND scope=NEW.job AND NEW.state='verified' AND (OLD.state<>'verified' OR OLD.job<>NEW.job);
        INSERT OR IGNORE INTO cloud_migration_copy_candidates SELECT p.batch,p.job,k.key,k.priority FROM cloud_migration_copy_progress p JOIN cloud_migration_inventory_keys k ON k.batch=p.batch AND k.key=OLD.object_key WHERE p.job=OLD.job AND OLD.state='verified' AND (NEW.state<>'verified' OR OLD.job<>NEW.job OR OLD.object_key<>NEW.object_key);
        DELETE FROM cloud_migration_copy_candidates WHERE job=NEW.job AND key=NEW.object_key AND NEW.state='verified'; END;
      CREATE TRIGGER IF NOT EXISTS migration_copy_receipt_remove AFTER DELETE ON cloud_migration_objects WHEN OLD.state='verified'
      BEGIN UPDATE cloud_migration_receipt_counts SET total=total-1 WHERE operation='copy' AND scope=OLD.job;
        INSERT OR IGNORE INTO cloud_migration_copy_candidates SELECT p.batch,p.job,k.key,k.priority FROM cloud_migration_copy_progress p JOIN cloud_migration_inventory_keys k ON k.batch=p.batch AND k.key=OLD.object_key WHERE p.job=OLD.job; END;
      CREATE TRIGGER IF NOT EXISTS migration_check_receipt_add AFTER INSERT ON cloud_migration_checks
      BEGIN UPDATE cloud_migration_receipt_counts SET total=total+1 WHERE operation='check' AND scope=NEW.attempt;
        DELETE FROM cloud_migration_check_candidates WHERE attempt=NEW.attempt AND side=NEW.side AND key=NEW.object_key; END;
      CREATE TRIGGER IF NOT EXISTS migration_check_receipt_update AFTER UPDATE ON cloud_migration_checks
      BEGIN UPDATE cloud_migration_receipt_counts SET total=total-1 WHERE operation='check' AND scope=OLD.attempt AND OLD.attempt<>NEW.attempt;
        UPDATE cloud_migration_receipt_counts SET total=total+1 WHERE operation='check' AND scope=NEW.attempt AND OLD.attempt<>NEW.attempt;
        INSERT OR IGNORE INTO cloud_migration_check_candidates SELECT p.batch,p.attempt,p.side,k.key,k.priority FROM cloud_migration_check_progress p JOIN cloud_migration_inventory_keys k ON k.batch=p.batch AND k.key=OLD.object_key WHERE p.attempt=OLD.attempt AND p.side=OLD.side AND (OLD.attempt<>NEW.attempt OR OLD.side<>NEW.side OR OLD.object_key<>NEW.object_key);
        DELETE FROM cloud_migration_check_candidates WHERE attempt=NEW.attempt AND side=NEW.side AND key=NEW.object_key; END;
      CREATE TRIGGER IF NOT EXISTS migration_check_receipt_remove AFTER DELETE ON cloud_migration_checks
      BEGIN UPDATE cloud_migration_receipt_counts SET total=total-1 WHERE operation='check' AND scope=OLD.attempt;
        INSERT OR IGNORE INTO cloud_migration_check_candidates SELECT p.batch,p.attempt,p.side,k.key,k.priority FROM cloud_migration_check_progress p JOIN cloud_migration_inventory_keys k ON k.batch=p.batch AND k.key=OLD.object_key WHERE p.attempt=OLD.attempt AND p.side=OLD.side; END;")
      .map_err(|e|e.to_string())
}
fn transaction(c: &Connection, action: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
    c.execute_batch("SAVEPOINT migration_pending_prepare")
        .map_err(|e| e.to_string())?;
    if let Err(error) = action() {
        c.execute_batch("ROLLBACK TO migration_pending_prepare; RELEASE migration_pending_prepare")
            .map_err(|e| e.to_string())?;
        return Err(error);
    }
    c.execute_batch("RELEASE migration_pending_prepare")
        .map_err(|e| e.to_string())
}
pub(super) fn seal(c: &Connection, inventory: &Inventory) -> Result<(), String> {
    inventory.ensure_complete(c)?;
    let exists: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM cloud_migration_inventory_totals WHERE batch=?1)",
            [&inventory.id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !exists {
        c.execute("INSERT INTO cloud_migration_inventory_totals SELECT ?1,count(*) FROM cloud_migration_inventory_keys WHERE batch=?1",[&inventory.id]).map_err(|e|e.to_string())?;
    }
    Ok(())
}
pub(super) fn total(c: &Connection, inventory: &Inventory) -> Result<usize, String> {
    c.query_row(
        "SELECT total FROM cloud_migration_inventory_totals WHERE batch=?1",
        [&inventory.id],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}
pub(super) fn adopt_receipts(c: &Connection, operation: &str, scope: &str) -> Result<(), String> {
    let exists:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM cloud_migration_receipt_counts WHERE operation=?1 AND scope=?2)",params![operation,scope],|r|r.get(0)).map_err(|e|e.to_string())?;
    if !exists {
        let sql = if operation == "copy" {
            "INSERT INTO cloud_migration_receipt_counts SELECT 'copy',?1,count(*) FROM cloud_migration_objects WHERE job=?1 AND state='verified'"
        } else {
            "INSERT INTO cloud_migration_receipt_counts SELECT 'check',?1,count(*) FROM cloud_migration_checks WHERE attempt=?1"
        };
        c.execute(sql, [scope]).map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub(super) fn receipts(c: &Connection, operation: &str, scope: &str) -> Result<usize, String> {
    c.query_row(
        "SELECT total FROM cloud_migration_receipt_counts WHERE operation=?1 AND scope=?2",
        params![operation, scope],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}
pub(super) fn prepare_copy(c: &Connection, inventory: &Inventory, job: &str) -> Result<(), String> {
    inventory.ensure_complete(c)?;
    seal(c, inventory)?;
    let exists: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM cloud_migration_copy_progress WHERE batch=?1 AND job=?2)",
            params![inventory.id, job],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if exists {
        return Ok(());
    }
    transaction(c, || {
        adopt_receipts(c, "copy", job)?;
        c.execute("INSERT INTO cloud_migration_copy_candidates SELECT k.batch,?2,k.key,k.priority FROM cloud_migration_inventory_keys k WHERE k.batch=?1 AND NOT EXISTS(SELECT 1 FROM cloud_migration_objects o WHERE o.job=?2 AND o.object_key=k.key AND o.state='verified')",params![inventory.id,job]).map_err(|e|e.to_string())?;
        c.execute("INSERT INTO cloud_migration_copy_progress SELECT ?1,?2,count(*) FROM cloud_migration_copy_candidates WHERE batch=?1 AND job=?2",params![inventory.id,job]).map_err(|e|e.to_string())?;
        Ok(())
    })
}
pub(super) fn prepare_checks(
    c: &Connection,
    inventory: &Inventory,
    attempt: &str,
    side: &str,
) -> Result<(), String> {
    inventory.ensure_complete(c)?;
    seal(c, inventory)?;
    let exists:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM cloud_migration_check_progress WHERE batch=?1 AND attempt=?2 AND side=?3)",params![inventory.id,attempt,side],|r|r.get(0)).map_err(|e|e.to_string())?;
    if exists {
        return Ok(());
    }
    transaction(c, || {
        adopt_receipts(c, "check", attempt)?;
        c.execute("INSERT INTO cloud_migration_check_candidates SELECT k.batch,?2,?3,k.key,k.priority FROM cloud_migration_inventory_keys k WHERE k.batch=?1 AND NOT EXISTS(SELECT 1 FROM cloud_migration_checks o WHERE o.attempt=?2 AND o.side=?3 AND o.object_key=k.key)",params![inventory.id,attempt,side]).map_err(|e|e.to_string())?;
        c.execute("INSERT INTO cloud_migration_check_progress SELECT ?1,?2,?3,count(*) FROM cloud_migration_check_candidates WHERE batch=?1 AND attempt=?2 AND side=?3",params![inventory.id,attempt,side]).map_err(|e|e.to_string())?;
        Ok(())
    })
}
pub(super) fn next(
    c: &Connection,
    inventory: &Inventory,
    job: &str,
    attempt: Option<(&str, &str)>,
) -> Result<Option<String>, String> {
    inventory.ensure_complete(c)?;
    if let Some((attempt, side)) = attempt {
        let prepared:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM cloud_migration_check_progress WHERE batch=?1 AND attempt=?2 AND side=?3)",params![inventory.id,attempt,side],|r|r.get(0)).map_err(|e|e.to_string())?;
        if !prepared {
            return Err("迁移核验待办尚未在正式事务中准备".into());
        }
        c.query_row("SELECT key FROM cloud_migration_check_candidates WHERE batch=?1 AND attempt=?2 AND side=?3 ORDER BY priority,key LIMIT 1",params![inventory.id,attempt,side],|r|r.get(0)).optional().map_err(|e|e.to_string())
    } else {
        let prepared:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM cloud_migration_copy_progress WHERE batch=?1 AND job=?2)",params![inventory.id,job],|r|r.get(0)).map_err(|e|e.to_string())?;
        if !prepared {
            return Err("迁移复制待办尚未在正式事务中准备".into());
        }
        c.query_row("SELECT key FROM cloud_migration_copy_candidates WHERE batch=?1 AND job=?2 ORDER BY priority,key LIMIT 1",params![inventory.id,job],|r|r.get(0)).optional().map_err(|e|e.to_string())
    }
}
pub(super) fn retire(c: &Connection, id: &str) -> Result<(), String> {
    for table in [
        "cloud_migration_copy_progress",
        "cloud_migration_check_progress",
        "cloud_migration_copy_candidates",
        "cloud_migration_check_candidates",
        "cloud_migration_inventory_totals",
    ] {
        c.execute(&format!("DELETE FROM {table} WHERE batch=?1"), [id])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
