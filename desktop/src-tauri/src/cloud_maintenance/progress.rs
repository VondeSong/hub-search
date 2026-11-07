//! Exact transaction-derived progress; complete immutable witnesses remain authoritative.
use super::*;
#[cfg(test)]
mod tests;
pub(super) const PENDING_SQL:&str="SELECT key,kind FROM cloud_maintenance_objects WHERE namespace=?1 AND run=?2 AND replacement=?3 AND status=?4 ORDER BY kind,key LIMIT 100";
pub(super) fn schema(c: &Connection) -> Result<(), String> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS cloud_maintenance_progress(namespace TEXT NOT NULL,run TEXT NOT NULL,kind TEXT NOT NULL,replacement INTEGER NOT NULL,status TEXT NOT NULL,objects INTEGER NOT NULL CHECK(objects>=0),body_bytes INTEGER NOT NULL CHECK(body_bytes>=0),PRIMARY KEY(namespace,run,kind,replacement,status));
      CREATE INDEX IF NOT EXISTS cloud_maintenance_progress_status ON cloud_maintenance_progress(namespace,run,replacement,status,kind);
      CREATE TABLE IF NOT EXISTS cloud_maintenance_storage(id INTEGER PRIMARY KEY CHECK(id=1),body_bytes INTEGER NOT NULL CHECK(body_bytes>=0));
      CREATE INDEX IF NOT EXISTS cloud_maintenance_pending_order ON cloud_maintenance_objects(namespace,run,replacement,status,kind,key);
      CREATE INDEX IF NOT EXISTS cloud_maintenance_original_order ON cloud_maintenance_objects(namespace,run,replacement,status,key);
      CREATE TABLE IF NOT EXISTS cloud_maintenance_delete_progress(namespace TEXT NOT NULL,run TEXT NOT NULL,remaining INTEGER NOT NULL CHECK(remaining>=0),PRIMARY KEY(namespace,run));
      CREATE TABLE IF NOT EXISTS cloud_maintenance_delete_candidates(namespace TEXT NOT NULL,run TEXT NOT NULL,key TEXT NOT NULL,kind TEXT NOT NULL,PRIMARY KEY(namespace,run,key));
      CREATE TRIGGER IF NOT EXISTS maintenance_delete_candidate_remove AFTER DELETE ON cloud_maintenance_delete_candidates
      BEGIN UPDATE cloud_maintenance_delete_progress SET remaining=remaining-1 WHERE namespace=OLD.namespace AND run=OLD.run; END;
      CREATE TRIGGER IF NOT EXISTS maintenance_delete_candidate_add AFTER INSERT ON cloud_maintenance_delete_candidates
      BEGIN UPDATE cloud_maintenance_delete_progress SET remaining=remaining+1 WHERE namespace=NEW.namespace AND run=NEW.run; END;
      CREATE TRIGGER IF NOT EXISTS maintenance_object_progress_add AFTER INSERT ON cloud_maintenance_objects
      BEGIN INSERT INTO cloud_maintenance_progress VALUES(NEW.namespace,NEW.run,NEW.kind,NEW.replacement,NEW.status,1,length(NEW.body)) ON CONFLICT(namespace,run,kind,replacement,status) DO UPDATE SET objects=objects+1,body_bytes=body_bytes+length(NEW.body);
        UPDATE cloud_maintenance_storage SET body_bytes=body_bytes+length(NEW.body) WHERE id=1; END;
      CREATE TRIGGER IF NOT EXISTS maintenance_object_progress_remove AFTER DELETE ON cloud_maintenance_objects
      BEGIN UPDATE cloud_maintenance_progress SET objects=objects-1,body_bytes=body_bytes-length(OLD.body) WHERE namespace=OLD.namespace AND run=OLD.run AND kind=OLD.kind AND replacement=OLD.replacement AND status=OLD.status;
        UPDATE cloud_maintenance_storage SET body_bytes=body_bytes-length(OLD.body) WHERE id=1;
        DELETE FROM cloud_maintenance_delete_candidates WHERE namespace=OLD.namespace AND run=OLD.run AND key=OLD.key AND OLD.replacement=0; END;
      CREATE TRIGGER IF NOT EXISTS maintenance_object_progress_update AFTER UPDATE ON cloud_maintenance_objects
      BEGIN UPDATE cloud_maintenance_progress SET objects=objects-1,body_bytes=body_bytes-length(OLD.body) WHERE namespace=OLD.namespace AND run=OLD.run AND kind=OLD.kind AND replacement=OLD.replacement AND status=OLD.status;
        INSERT INTO cloud_maintenance_progress VALUES(NEW.namespace,NEW.run,NEW.kind,NEW.replacement,NEW.status,1,length(NEW.body)) ON CONFLICT(namespace,run,kind,replacement,status) DO UPDATE SET objects=objects+1,body_bytes=body_bytes+length(NEW.body);
        UPDATE cloud_maintenance_storage SET body_bytes=body_bytes+length(NEW.body)-length(OLD.body) WHERE id=1;
        DELETE FROM cloud_maintenance_delete_candidates WHERE namespace=OLD.namespace AND run=OLD.run AND key=OLD.key AND OLD.replacement=0 AND (NEW.namespace<>OLD.namespace OR NEW.run<>OLD.run OR NEW.key<>OLD.key OR NEW.replacement<>0 OR NEW.status<>'read'); END;")
      .map_err(|e|e.to_string())?;
    let ready: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM cloud_maintenance_storage WHERE id=1)",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !ready {
        transaction(c, || {
            // Establish writer ownership before taking the source snapshot. Any concurrent
            // first initialization either completes before this statement or cannot interleave.
            let inserted = c
                .execute(
                    "INSERT OR IGNORE INTO cloud_maintenance_storage VALUES(1,0)",
                    [],
                )
                .map_err(|e| e.to_string())?;
            if inserted == 0 {
                return Ok(());
            }
            c.execute("DELETE FROM cloud_maintenance_progress", [])
                .map_err(|e| e.to_string())?;
            c.execute("INSERT INTO cloud_maintenance_progress SELECT namespace,run,kind,replacement,status,count(*),coalesce(sum(length(body)),0) FROM cloud_maintenance_objects GROUP BY namespace,run,kind,replacement,status",[]).map_err(|e|e.to_string())?;
            c.execute("UPDATE cloud_maintenance_storage SET body_bytes=(SELECT coalesce(sum(length(body)),0) FROM cloud_maintenance_objects) WHERE id=1",[]).map_err(|e|e.to_string())?;
            Ok(())
        })?;
    }
    Ok(())
}
fn transaction(c: &Connection, action: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
    c.execute_batch("SAVEPOINT maintenance_progress_prepare")
        .map_err(|e| e.to_string())?;
    if let Err(error) = action() {
        c.execute_batch(
            "ROLLBACK TO maintenance_progress_prepare; RELEASE maintenance_progress_prepare",
        )
        .map_err(|e| e.to_string())?;
        return Err(error);
    }
    c.execute_batch("RELEASE maintenance_progress_prepare")
        .map_err(|e| e.to_string())
}
pub(super) fn staged(c: &Connection) -> Result<u64, String> {
    c.query_row(
        "SELECT body_bytes FROM cloud_maintenance_storage WHERE id=1",
        [],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}
pub(super) fn count(
    c: &Connection,
    ns: &str,
    id: &str,
    replacement: bool,
    status: &str,
) -> Result<usize, String> {
    c.query_row("SELECT coalesce(sum(objects),0) FROM cloud_maintenance_progress WHERE namespace=?1 AND run=?2 AND replacement=?3 AND status=?4",params![ns,id,replacement,status],|r|r.get(0)).map_err(|e|e.to_string())
}
pub(super) fn prepare_delete(c: &Connection, ns: &str, id: &str) -> Result<(), String> {
    let ready:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM cloud_maintenance_delete_progress WHERE namespace=?1 AND run=?2)",params![ns,id],|r|r.get(0)).map_err(|e|e.to_string())?;
    if ready {
        return Ok(());
    }
    transaction(c, || {
        c.execute("INSERT INTO cloud_maintenance_delete_candidates SELECT o.namespace,o.run,o.key,o.kind FROM cloud_maintenance_objects o WHERE o.namespace=?1 AND o.run=?2 AND o.replacement=0 AND o.kind<>'webdavSnapshot' AND o.status='read' AND NOT EXISTS(SELECT 1 FROM cloud_maintenance_objects r WHERE r.namespace=o.namespace AND r.run=o.run AND r.replacement=1 AND r.key=o.key)",params![ns,id]).map_err(|e|e.to_string())?;
        c.execute("INSERT INTO cloud_maintenance_delete_progress SELECT ?1,?2,count(*) FROM cloud_maintenance_delete_candidates WHERE namespace=?1 AND run=?2",params![ns,id]).map_err(|e|e.to_string())?;
        Ok(())
    })
}
pub(super) fn deletion_remaining(c: &Connection, ns: &str, id: &str) -> Result<usize, String> {
    c.query_row(
        "SELECT remaining FROM cloud_maintenance_delete_progress WHERE namespace=?1 AND run=?2",
        params![ns, id],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}
pub(super) fn deletion_candidates(
    c: &Connection,
    ns: &str,
    id: &str,
) -> Result<Vec<(String, String)>, String> {
    let mut q=c.prepare("SELECT key,kind FROM cloud_maintenance_delete_candidates WHERE namespace=?1 AND run=?2 ORDER BY key LIMIT 100").map_err(|e|e.to_string())?;
    let rows = q
        .query_map(params![ns, id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}
pub(super) fn invalidate_delete(c: &Connection, ns: &str, id: &str) -> Result<(), String> {
    c.execute(
        "DELETE FROM cloud_maintenance_delete_progress WHERE namespace=?1 AND run=?2",
        params![ns, id],
    )
    .map_err(|e| e.to_string())?;
    c.execute(
        "DELETE FROM cloud_maintenance_delete_candidates WHERE namespace=?1 AND run=?2",
        params![ns, id],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}
