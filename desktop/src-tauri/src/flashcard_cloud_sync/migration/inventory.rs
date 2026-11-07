//! Complete provider epochs, scalar copy ordering and streamed released receipts.
use super::*;
use serde::de::{DeserializeSeed, Error, SeqAccess, Visitor};
use std::fmt;
use std::io::Write;
mod pending;
#[cfg(test)]
mod tests;

#[derive(Clone)]
pub(super) struct Inventory {
    pub(super) id: String,
}

pub(super) fn schema(c: &Connection) -> Result<(), String> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS cloud_migration_inventory_batches(id TEXT PRIMARY KEY,job TEXT NOT NULL,side TEXT NOT NULL,stage TEXT NOT NULL,namespace TEXT NOT NULL,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cloud_migration_inventory_heads(job TEXT NOT NULL,side TEXT NOT NULL,stage TEXT NOT NULL,batch TEXT NOT NULL,PRIMARY KEY(job,side,stage));
      CREATE TABLE IF NOT EXISTS cloud_migration_inventory_prefixes(batch TEXT NOT NULL,prefix TEXT NOT NULL,namespace TEXT NOT NULL,scope TEXT NOT NULL,epoch TEXT NOT NULL,PRIMARY KEY(batch,prefix));
      CREATE TABLE IF NOT EXISTS cloud_migration_inventory_keys(batch TEXT NOT NULL,key TEXT NOT NULL,priority INTEGER NOT NULL,PRIMARY KEY(batch,key));
      CREATE INDEX IF NOT EXISTS cloud_migration_inventory_order ON cloud_migration_inventory_keys(batch,priority,key);
      CREATE TABLE IF NOT EXISTS cloud_migration_verification_inventories(attempt TEXT NOT NULL,side TEXT NOT NULL,inventory TEXT NOT NULL,PRIMARY KEY(attempt,side));").map_err(|e|e.to_string())?;
    pending::schema(c)
}
fn priority(key: &str) -> i64 {
    if key.starts_with("reading/media-v1/manifests/") {
        0
    } else if key.starts_with("reading/media-v1/blobs/") {
        2
    } else {
        1
    }
}
impl Inventory {
    pub(super) fn ensure_complete(&self, c: &Connection) -> Result<(), String> {
        let complete: bool = c
            .query_row(
                "SELECT state='complete' FROM cloud_migration_inventory_batches WHERE id=?1",
                [&self.id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !complete {
            return Err("云迁移清单尚未完整，不能复制或授予核验权限".into());
        }
        Ok(())
    }
    pub(super) fn count(&self, c: &Connection) -> Result<usize, String> {
        self.ensure_complete(c)?;
        pending::total(c, self)
    }
    pub(super) fn next(
        &self,
        c: &Connection,
        job: &str,
        attempt: Option<(&str, &str)>,
    ) -> Result<Option<String>, String> {
        pending::next(c, self, job, attempt)
    }
    pub(super) fn equal(&self, c: &Connection, other: &Inventory) -> Result<bool, String> {
        self.ensure_complete(c)?;
        other.ensure_complete(c)?;
        c.query_row("SELECT NOT EXISTS(SELECT key FROM cloud_migration_inventory_keys WHERE batch=?1 EXCEPT SELECT key FROM cloud_migration_inventory_keys WHERE batch=?2) AND NOT EXISTS(SELECT key FROM cloud_migration_inventory_keys WHERE batch=?2 EXCEPT SELECT key FROM cloud_migration_inventory_keys WHERE batch=?1)",params![self.id,other.id],|r|r.get(0)).map_err(|e|e.to_string())
    }
    pub(super) fn covers(&self, c: &Connection, required: &Inventory) -> Result<bool, String> {
        self.ensure_complete(c)?;
        required.ensure_complete(c)?;
        c.query_row("SELECT NOT EXISTS(SELECT key FROM cloud_migration_inventory_keys WHERE batch=?2 EXCEPT SELECT key FROM cloud_migration_inventory_keys WHERE batch=?1)",params![self.id,required.id],|r|r.get(0)).map_err(|e|e.to_string())
    }
    pub(super) fn append_heartbeats(
        &self,
        c: &Connection,
        previous: &Inventory,
    ) -> Result<bool, String> {
        self.ensure_complete(c)?;
        previous.ensure_complete(c)?;
        c.query_row("SELECT NOT EXISTS(SELECT key FROM cloud_migration_inventory_keys WHERE batch=?2 EXCEPT SELECT key FROM cloud_migration_inventory_keys WHERE batch=?1) AND NOT EXISTS(SELECT key FROM cloud_migration_inventory_keys n WHERE n.batch=?1 AND n.key NOT LIKE 'reading/devices-v1/%' AND NOT EXISTS(SELECT 1 FROM cloud_migration_inventory_keys o WHERE o.batch=?2 AND o.key=n.key))",params![self.id,previous.id],|r|r.get(0)).map_err(|e|e.to_string())
    }
    pub(super) fn dependencies(&self, c: &Connection, job: &str) -> Result<bool, String> {
        self.ensure_complete(c)?;
        c.query_row("SELECT NOT EXISTS(SELECT 1 FROM cloud_migration_references r WHERE r.job=?2 AND NOT EXISTS(SELECT 1 FROM cloud_migration_inventory_keys k WHERE k.batch=?1 AND k.key='reading/media-v1/blobs/'||r.hash)) AND NOT EXISTS(SELECT 1 FROM cloud_migration_card_refs r WHERE r.job=?2 AND NOT EXISTS(SELECT 1 FROM cloud_migration_inventory_keys k WHERE k.batch=?1 AND k.key='media/'||r.hash))",params![self.id,job],|r|r.get(0)).map_err(|e|e.to_string())
    }
}

pub(super) async fn acquire(
    db: &PathBuf,
    remote: &dyn Store,
    namespace: &str,
    job: &str,
    side: &str,
    stage: &str,
    all: bool,
) -> Result<Inventory, String> {
    let id = {
        let (mut c, _writer) = open_write_database(db)?;
        super::schema(&c)?;
        crate::cloud_inventory::schema(&c)?;
        let existing:Option<String>=c.query_row("SELECT h.batch FROM cloud_migration_inventory_heads h JOIN cloud_migration_inventory_batches b ON b.id=h.batch WHERE h.job=?1 AND h.side=?2 AND h.stage=?3 AND b.namespace=?4 AND b.state='listing'",params![job,side,stage,namespace],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        if let Some(id) = existing {
            id
        } else {
            let id = random_url_safe(24);
            let tx = c.transaction().map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT INTO cloud_migration_inventory_batches VALUES(?1,?2,?3,?4,?5,'listing')",
                params![id, job, side, stage, namespace],
            )
            .map_err(|e| e.to_string())?;
            tx.execute("INSERT INTO cloud_migration_inventory_heads VALUES(?1,?2,?3,?4) ON CONFLICT(job,side,stage) DO UPDATE SET batch=excluded.batch",params![job,side,stage,id]).map_err(|e|e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
            id
        }
    };
    let mut prefixes = PREFIXES.to_vec();
    if all {
        prefixes.extend(["changes/", "media/"]);
    }
    for prefix in prefixes {
        let previous:Option<(String,String,String)>=open_database(db)?.query_row("SELECT namespace,scope,epoch FROM cloud_migration_inventory_prefixes WHERE batch=?1 AND prefix=?2",params![id,prefix],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|e|e.to_string())?;
        if let Some((ns, scope, epoch)) = previous {
            let c = open_database(db)?;
            let frozen = crate::cloud_inventory::load(&c, &ns, &scope, &epoch)?;
            frozen.ensure_complete(&c)?;
            if frozen.provider_prefix != remote.key("") || frozen.prefix != remote.key(prefix) {
                return Err("迁移云空间在清单恢复时变化".into());
            }
            continue;
        }
        let scope = format!("migration:{id}:{prefix}");
        let inventory =
            crate::cloud_inventory::acquire(db, remote, namespace, &scope, prefix).await?;
        let (mut c, _writer) = open_write_database(db)?;
        let tx = c.transaction().map_err(|e| e.to_string())?;
        inventory.ensure_complete(&tx)?;
        let mut q=tx.prepare("SELECT relative_key FROM cloud_inventory_objects WHERE namespace=?1 AND epoch=?2 ORDER BY key").map_err(|e|e.to_string())?;
        let mut rows = q
            .query(params![namespace, inventory.epoch])
            .map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let key: String = row.get(0).map_err(|e| e.to_string())?;
            limit(&key)?;
            identity(&key)?;
            if !key.starts_with(prefix) {
                return Err("迁移清单对象越过已冻结目录范围".into());
            }
            tx.execute(
                "INSERT OR IGNORE INTO cloud_migration_inventory_keys VALUES(?1,?2,?3)",
                params![id, key, priority(&key)],
            )
            .map_err(|e| e.to_string())?;
        }
        drop(rows);
        drop(q);
        tx.execute(
            "INSERT OR REPLACE INTO cloud_migration_inventory_prefixes VALUES(?1,?2,?3,?4,?5)",
            params![id, prefix, namespace, scope, inventory.epoch],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
    }
    let (c, _writer) = open_write_database(db)?;
    let completed: usize = c.query_row("SELECT count(*) FROM cloud_migration_inventory_prefixes p JOIN cloud_inventory_runs r ON r.namespace=p.namespace AND r.scope=p.scope AND r.epoch=p.epoch AND r.state='complete' WHERE p.batch=?1 AND p.namespace=?2",params![id,namespace],|r|r.get(0)).map_err(|e|e.to_string())?;
    if completed != PREFIXES.len() + if all { 2 } else { 0 } {
        return Err("迁移清单范围尚未全部完成；不能复制或核验".into());
    }
    c.execute(
        "UPDATE cloud_migration_inventory_batches SET state='complete' WHERE id=?1",
        [&id],
    )
    .map_err(|e| e.to_string())?;
    let inventory = Inventory { id };
    pending::seal(&c, &inventory)?;
    if side == "source" && stage == "copy" {
        pending::prepare_copy(&c, &inventory, job)?;
    }
    Ok(inventory)
}

struct Legacy<'a> {
    c: &'a Connection,
    id: &'a str,
}
impl<'de> DeserializeSeed<'de> for Legacy<'_> {
    type Value = ();
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_seq(self)
    }
}
impl<'de> Visitor<'de> for Legacy<'_> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("complete migration object keys")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        while let Some(key) = seq.next_element::<String>()? {
            limit(&key).map_err(A::Error::custom)?;
            identity(&key).map_err(A::Error::custom)?;
            self.c
                .execute(
                    "INSERT OR IGNORE INTO cloud_migration_inventory_keys VALUES(?1,?2,?3)",
                    params![self.id, key, priority(&key)],
                )
                .map_err(A::Error::custom)?;
        }
        Ok(())
    }
}
pub(super) fn previous(
    c: &Connection,
    job: &str,
    attempt: &str,
    side: &str,
) -> Result<Option<Inventory>, String> {
    if let Some(id)=c.query_row("SELECT inventory FROM cloud_migration_verification_inventories WHERE attempt=?1 AND side=?2",params![attempt,side],|r|r.get::<_,String>(0)).optional().map_err(|e|e.to_string())?{let inventory=Inventory{id};pending::seal(c,&inventory)?;return Ok(Some(inventory));}
    let field = if side == "source" {
        "source_keys"
    } else if side == "target" {
        "target_keys"
    } else {
        return Err("迁移核验侧无效".into());
    };
    let row:Option<(i64,String)>=c.query_row(&format!("SELECT rowid,typeof({field}) FROM cloud_migration_verifications WHERE job=?1 AND attempt=?2"),params![job,attempt],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e|e.to_string())?;
    let Some((row, kind)) = row else {
        return Ok(None);
    };
    if kind != "text" {
        return Ok(None);
    }
    c.execute_batch("SAVEPOINT migration_legacy_keys")
        .map_err(|e| e.to_string())?;
    let id = random_url_safe(24);
    let parsed = (|| {
        c.execute(
            "INSERT INTO cloud_migration_inventory_batches VALUES(?1,?2,?3,'legacy','','listing')",
            params![id, job, side],
        )
        .map_err(|e| e.to_string())?;
        let blob = c
            .blob_open("main", "cloud_migration_verifications", field, row, true)
            .map_err(|e| e.to_string())?;
        let mut de = serde_json::Deserializer::from_reader(std::io::BufReader::new(blob));
        Legacy { c, id: &id }
            .deserialize(&mut de)
            .and_then(|_| de.end())
            .map_err(|e| e.to_string())?;
        c.execute(
            "UPDATE cloud_migration_inventory_batches SET state='complete' WHERE id=?1",
            [&id],
        )
        .map_err(|e| e.to_string())?;
        c.execute(
            "INSERT INTO cloud_migration_verification_inventories VALUES(?1,?2,?3)",
            params![attempt, side, id],
        )
        .map_err(|e| e.to_string())?;
        pending::seal(c, &Inventory { id: id.clone() })?;
        Ok::<(), String>(())
    })();
    if parsed.is_err() {
        c.execute_batch("ROLLBACK TO migration_legacy_keys; RELEASE migration_legacy_keys")
            .map_err(|e| e.to_string())?;
        return Ok(None);
    }
    c.execute_batch("RELEASE migration_legacy_keys")
        .map_err(|e| e.to_string())?;
    Ok(Some(Inventory { id }))
}
struct Counter(usize);
impl Write for Counter {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0 = self
            .0
            .checked_add(b.len())
            .ok_or_else(|| std::io::Error::other("迁移兼容清单长度溢出"))?;
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn array(c: &Connection, inventory: &Inventory, w: &mut impl Write) -> Result<(), String> {
    inventory.ensure_complete(c)?;
    w.write_all(b"[").map_err(|e| e.to_string())?;
    let mut q = c
        .prepare(
            "SELECT key FROM cloud_migration_inventory_keys WHERE batch=?1 ORDER BY priority,key",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = q.query([&inventory.id]).map_err(|e| e.to_string())?;
    let mut first = true;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let key: String = row.get(0).map_err(|e| e.to_string())?;
        if !first {
            w.write_all(b",").map_err(|e| e.to_string())?;
        }
        first = false;
        serde_json::to_writer(&mut *w, &key).map_err(|e| e.to_string())?;
    }
    w.write_all(b"]").map_err(|e| e.to_string())
}
pub(super) fn compatibility(
    c: &Connection,
    job: &str,
    attempt: &str,
    source: &Inventory,
    target: &Inventory,
) -> Result<(), String> {
    for (side, field, inventory) in [
        ("source", "source_keys", source),
        ("target", "target_keys", target),
    ] {
        let mut count = Counter(0);
        array(c, inventory, &mut count)?;
        // Allocate TEXT while preserving its released type. BLOB API mutates
        // these exact UTF-8 bytes within the caller's unpublished transaction.
        c.execute(&format!("UPDATE cloud_migration_verifications SET {field}=CAST(zeroblob(?2) AS TEXT) WHERE job=?1"),params![job,i64::try_from(count.0).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
        let row: i64 = c
            .query_row(
                "SELECT rowid FROM cloud_migration_verifications WHERE job=?1",
                [job],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let mut blob = c
            .blob_open("main", "cloud_migration_verifications", field, row, false)
            .map_err(|e| e.to_string())?;
        array(c, inventory, &mut blob)?;
        blob.close().map_err(|e| e.to_string())?;
        pending::prepare_checks(c, inventory, attempt, side)?;
        c.execute(
            "INSERT OR REPLACE INTO cloud_migration_verification_inventories VALUES(?1,?2,?3)",
            params![attempt, side, inventory.id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Retire only generated inventories no longer used by an active scope or the
/// current verification receipt. Business cloud journals are never selected.
pub(super) fn retire(c: &Connection, job: &str) -> Result<(), String> {
    c.execute("DELETE FROM cloud_migration_verification_inventories WHERE NOT EXISTS(SELECT 1 FROM cloud_migration_verifications v WHERE v.attempt=cloud_migration_verification_inventories.attempt)",[]).map_err(|e|e.to_string())?;
    loop {
        let id:Option<String>=c.query_row("SELECT id FROM cloud_migration_inventory_batches b WHERE job=?1 AND state='complete' AND NOT EXISTS(SELECT 1 FROM cloud_migration_inventory_heads h WHERE h.batch=b.id) AND NOT EXISTS(SELECT 1 FROM cloud_migration_verification_inventories v WHERE v.inventory=b.id) ORDER BY id LIMIT 1",[job],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        let Some(id) = id else { break };
        loop {
            let prefix:Option<(String,String,String,String)>=c.query_row("SELECT prefix,namespace,scope,epoch FROM cloud_migration_inventory_prefixes WHERE batch=?1 ORDER BY prefix LIMIT 1",[&id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(|e|e.to_string())?;
            let Some((prefix, ns, scope, epoch)) = prefix else {
                break;
            };
            crate::cloud_inventory::load(c, &ns, &scope, &epoch)?.release(c)?;
            c.execute(
                "DELETE FROM cloud_migration_inventory_prefixes WHERE batch=?1 AND prefix=?2",
                params![id, prefix],
            )
            .map_err(|e| e.to_string())?;
        }
        pending::retire(c, &id)?;
        c.execute(
            "DELETE FROM cloud_migration_inventory_keys WHERE batch=?1",
            [&id],
        )
        .map_err(|e| e.to_string())?;
        c.execute(
            "DELETE FROM cloud_migration_inventory_batches WHERE id=?1",
            [&id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(super) fn receipt_count(c: &Connection, operation: &str, scope: &str) -> Result<usize, String> {
    // The report caller already owns the writer. Adopt released receipts once,
    // including an old verification header reached before this copy budget finishes.
    pending::adopt_receipts(c, operation, scope)?;
    pending::receipts(c, operation, scope)
}
