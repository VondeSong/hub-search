//! Durable provider inventories. Incomplete listings never grant scope authority.
use crate::reading_sync::object_store::{InventoryPage, Store};
use crate::{now_timestamp, open_database, open_write_database, random_url_safe};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::PathBuf;

#[derive(Clone, Debug)]
pub(crate) struct Inventory {
    pub namespace: String,
    pub scope: String,
    pub epoch: String,
    pub prefix: String,
    pub provider_prefix: String,
    pub root_relative: String,
}

pub(crate) fn schema(c: &Connection) -> Result<(), String> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS cloud_inventory_runs(
        namespace TEXT NOT NULL,scope TEXT NOT NULL,epoch TEXT NOT NULL,root_relative TEXT NOT NULL,
        provider_prefix TEXT NOT NULL,root_prefix TEXT NOT NULL,state TEXT NOT NULL,error TEXT NOT NULL,
        created_at INTEGER NOT NULL,PRIMARY KEY(namespace,scope,epoch));
      CREATE INDEX IF NOT EXISTS cloud_inventory_incomplete ON cloud_inventory_runs(namespace,scope,state,created_at);
      CREATE TABLE IF NOT EXISTS cloud_inventory_objects(
        namespace TEXT NOT NULL,epoch TEXT NOT NULL,key TEXT NOT NULL,relative_key TEXT NOT NULL,
        PRIMARY KEY(namespace,epoch,key),UNIQUE(namespace,epoch,relative_key));
      CREATE TABLE IF NOT EXISTS cloud_inventory_directories(
        namespace TEXT NOT NULL,epoch TEXT NOT NULL,relative TEXT NOT NULL,state TEXT NOT NULL,
        continuation TEXT,parent_relative TEXT NOT NULL,origin_token TEXT NOT NULL,
        PRIMARY KEY(namespace,epoch,relative));
      CREATE INDEX IF NOT EXISTS cloud_inventory_frontier ON cloud_inventory_directories(namespace,epoch,state,relative);
      CREATE TABLE IF NOT EXISTS cloud_inventory_tokens(
        namespace TEXT NOT NULL,epoch TEXT NOT NULL,directory TEXT NOT NULL,token TEXT NOT NULL,
        PRIMARY KEY(namespace,epoch,directory,token));
      CREATE TABLE IF NOT EXISTS cloud_inventory_receive_progress(
        namespace TEXT NOT NULL,epoch TEXT NOT NULL,applied_table TEXT NOT NULL,
        remaining INTEGER NOT NULL CHECK(remaining>=0),PRIMARY KEY(namespace,epoch));
      CREATE TABLE IF NOT EXISTS cloud_inventory_receive_candidates(
        namespace TEXT NOT NULL,epoch TEXT NOT NULL,key TEXT NOT NULL,id TEXT NOT NULL,
        applied_table TEXT NOT NULL,PRIMARY KEY(namespace,epoch,key));
      CREATE INDEX IF NOT EXISTS cloud_inventory_receive_identity ON cloud_inventory_receive_candidates(applied_table,namespace,id);
      CREATE TRIGGER IF NOT EXISTS cloud_inventory_receive_ack AFTER DELETE ON cloud_inventory_receive_candidates
      BEGIN UPDATE cloud_inventory_receive_progress SET remaining=remaining-1 WHERE namespace=OLD.namespace AND epoch=OLD.epoch; END;")
        .map_err(|e| format!("无法保存云对象清单；已取得记录保留：{e}"))
}

pub(crate) fn load(
    c: &Connection,
    namespace: &str,
    scope: &str,
    epoch: &str,
) -> Result<Inventory, String> {
    c.query_row("SELECT root_prefix,provider_prefix,root_relative FROM cloud_inventory_runs WHERE namespace=?1 AND scope=?2 AND epoch=?3",params![namespace,scope,epoch],|r|Ok(Inventory {
        namespace: namespace.into(), scope: scope.into(), epoch: epoch.into(),
        prefix: r.get(0)?, provider_prefix: r.get(1)?, root_relative: r.get(2)?,
    })).map_err(|_| "云对象清单身份不存在；请重新取得完整清单".into())
}

impl Inventory {
    pub(crate) fn ensure_complete(&self, c: &Connection) -> Result<(), String> {
        let ready: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM cloud_inventory_runs WHERE namespace=?1 AND scope=?2 AND epoch=?3 AND root_prefix=?4 AND provider_prefix=?5 AND root_relative=?6 AND state='complete')",params![self.namespace,self.scope,self.epoch,self.prefix,self.provider_prefix,self.root_relative],|r|r.get(0)).map_err(|e|e.to_string())?;
        if ready {
            Ok(())
        } else {
            Err("云对象清单尚未完整；未取得维护或迁移授权".into())
        }
    }
    pub(crate) fn count(&self, c: &Connection) -> Result<usize, String> {
        self.ensure_complete(c)?;
        c.query_row(
            "SELECT count(*) FROM cloud_inventory_objects WHERE namespace=?1 AND epoch=?2",
            params![self.namespace, self.epoch],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())
    }
    pub(crate) fn next(
        &self,
        c: &Connection,
        after: Option<&str>,
    ) -> Result<Option<String>, String> {
        self.ensure_complete(c)?;
        c.query_row("SELECT key FROM cloud_inventory_objects WHERE namespace=?1 AND epoch=?2 AND key>?3 ORDER BY key LIMIT 1",params![self.namespace,self.epoch,after.unwrap_or("")],|r|r.get(0)).optional().map_err(|e|e.to_string())
    }
    pub(crate) fn validate_hash_objects(&self, c: &Connection) -> Result<(), String> {
        self.ensure_complete(c)?;
        let invalid:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM cloud_inventory_objects WHERE namespace=?1 AND epoch=?2 AND (length(relative_key)<>length(?3)+69 OR substr(relative_key,1,length(?3))<>?3 OR substr(relative_key,-5)<>'.json' OR substr(relative_key,length(?3)+1,64) GLOB '*[^0-9a-fA-F]*'))",params![self.namespace,self.epoch,self.root_relative],|r|r.get(0)).map_err(|e|e.to_string())?;
        if invalid {
            Err("云对象名称或内容身份无效；原记录已保留".into())
        } else {
            Ok(())
        }
    }
    fn applied_table(table: &str) -> Result<&str, String> {
        match table {
            "reading_sync_applied"
            | "reading_copy_applied"
            | "reading_media_applied"
            | "cloud_device_applied" => Ok(table),
            _ => Err("云对象消费记录域无效".into()),
        }
    }
    pub(crate) fn next_unapplied(
        &self,
        c: &Connection,
        table: &str,
        after: Option<&str>,
    ) -> Result<Option<String>, String> {
        self.ensure_receiver(c, table)?;
        c.query_row(
            "SELECT key FROM cloud_inventory_receive_candidates WHERE namespace=?1 AND epoch=?2 AND key>?3 ORDER BY key LIMIT 1",
            params![
                self.namespace,
                self.epoch,
                after.unwrap_or("")
            ],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())
    }
    pub(crate) fn unapplied_count(&self, c: &Connection, table: &str) -> Result<usize, String> {
        self.ensure_receiver(c, table)?;
        c.query_row(
            "SELECT remaining FROM cloud_inventory_receive_progress WHERE namespace=?1 AND epoch=?2",
            params![self.namespace, self.epoch],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())
    }
    fn ensure_receiver(&self, c: &Connection, table: &str) -> Result<(), String> {
        self.ensure_complete(c)?;
        let table = Self::applied_table(table)?;
        let valid: bool=c.query_row("SELECT EXISTS(SELECT 1 FROM cloud_inventory_receive_progress WHERE namespace=?1 AND epoch=?2 AND applied_table=?3)",params![self.namespace,self.epoch,table],|r|r.get(0)).map_err(|e|e.to_string())?;
        if valid {
            Ok(())
        } else {
            Err("云对象接收队列尚未取得完整身份".into())
        }
    }
    fn prepare_receiver(&self, c: &Connection, table: &str) -> Result<(), String> {
        self.ensure_complete(c)?;
        let table = Self::applied_table(table)?;
        let previous: Option<String>=c.query_row("SELECT applied_table FROM cloud_inventory_receive_progress WHERE namespace=?1 AND epoch=?2",params![self.namespace,self.epoch],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        if let Some(previous) = previous {
            return if previous == table {
                Ok(())
            } else {
                Err("云对象接收记录域发生变化；原队列保留".into())
            };
        }
        // The immutable scope witness stays intact. Only this receiver's pending index is pruned.
        self.validate_hash_objects(c)?;
        c.execute_batch("SAVEPOINT cloud_inventory_receive_init")
            .map_err(|e| e.to_string())?;
        let result = (|| {
            c.execute_batch(&format!("CREATE TRIGGER IF NOT EXISTS cloud_inventory_ack_{table} AFTER INSERT ON {table} BEGIN DELETE FROM cloud_inventory_receive_candidates WHERE applied_table='{table}' AND namespace=NEW.namespace AND id=NEW.id; END;")).map_err(|e|e.to_string())?;
            c.execute(
                "INSERT INTO cloud_inventory_receive_progress VALUES(?1,?2,?3,0)",
                params![self.namespace, self.epoch, table],
            )
            .map_err(|e| e.to_string())?;
            let added=c.execute(&format!("INSERT INTO cloud_inventory_receive_candidates(namespace,epoch,key,id,applied_table) SELECT o.namespace,o.epoch,o.key,substr(o.relative_key,length(?3)+1,64),?4 FROM cloud_inventory_objects o WHERE o.namespace=?1 AND o.epoch=?2 AND NOT EXISTS(SELECT 1 FROM {table} a WHERE a.namespace=o.namespace AND a.id=substr(o.relative_key,length(?3)+1,64))"),params![self.namespace,self.epoch,self.root_relative,table]).map_err(|e|e.to_string())?;
            c.execute("UPDATE cloud_inventory_receive_progress SET remaining=?3 WHERE namespace=?1 AND epoch=?2",params![self.namespace,self.epoch,added]).map_err(|e|e.to_string())?;
            Ok::<_, String>(())
        })();
        if let Err(error) = result {
            c.execute_batch(
                "ROLLBACK TO cloud_inventory_receive_init; RELEASE cloud_inventory_receive_init",
            )
            .map_err(|e| e.to_string())?;
            return Err(error);
        }
        c.execute_batch("RELEASE cloud_inventory_receive_init")
            .map_err(|e| e.to_string())
    }
    pub(crate) fn release(&self, c: &Connection) -> Result<(), String> {
        self.ensure_complete(c)?;
        c.execute_batch("SAVEPOINT cloud_inventory_release")
            .map_err(|e| e.to_string())?;
        let result = (|| {
            for table in [
                "cloud_inventory_receive_candidates",
                "cloud_inventory_receive_progress",
                "cloud_inventory_objects",
                "cloud_inventory_directories",
                "cloud_inventory_tokens",
            ] {
                c.execute(
                    &format!("DELETE FROM {table} WHERE namespace=?1 AND epoch=?2"),
                    params![self.namespace, self.epoch],
                )
                .map_err(|e| e.to_string())?;
            }
            c.execute(
                "DELETE FROM cloud_inventory_runs WHERE namespace=?1 AND scope=?2 AND epoch=?3",
                params![self.namespace, self.scope, self.epoch],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
        })();
        if let Err(error) = result {
            c.execute_batch("ROLLBACK TO cloud_inventory_release; RELEASE cloud_inventory_release")
                .map_err(|e| e.to_string())?;
            return Err(error);
        }
        c.execute_batch("RELEASE cloud_inventory_release")
            .map_err(|e| e.to_string())
    }
}

fn valid_relative(value: &str, directory: bool) -> bool {
    value.len() <= 1024
        && ((value.is_empty() && directory)
            || (value.ends_with('/') == directory
                && value.trim_end_matches('/').split('/').all(|part| {
                    !part.is_empty()
                        && !matches!(part, "." | "..")
                        && part
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
                })))
}

fn begin(
    c: &mut Connection,
    remote: &dyn Store,
    ns: &str,
    scope: &str,
    relative: &str,
) -> Result<Inventory, String> {
    if scope.is_empty()
        || scope.len() > 1024
        || scope.chars().any(char::is_control)
        || !valid_relative(relative, true)
    {
        return Err("云对象清单范围无效".into());
    }
    schema(c)?;
    let prefix = remote.key(relative);
    let provider_prefix = remote.key("");
    if prefix != format!("{provider_prefix}{relative}") {
        return Err("云对象清单命名空间无效".into());
    }
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let resumed:Option<String>=tx.query_row("SELECT epoch FROM cloud_inventory_runs WHERE namespace=?1 AND scope=?2 AND state='listing' AND root_relative=?3 AND provider_prefix=?4 AND root_prefix=?5 ORDER BY created_at DESC,epoch LIMIT 1",params![ns,scope,relative,provider_prefix,prefix],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    let epoch = if let Some(epoch) = resumed {
        epoch
    } else {
        tx.execute("UPDATE cloud_inventory_runs SET state='superseded' WHERE namespace=?1 AND scope=?2 AND state='listing'",params![ns,scope]).map_err(|e|e.to_string())?;
        let epoch = random_url_safe(24);
        tx.execute(
            "INSERT INTO cloud_inventory_runs VALUES(?1,?2,?3,?4,?5,?6,'listing','',?7)",
            params![
                ns,
                scope,
                epoch,
                relative,
                provider_prefix,
                prefix,
                now_timestamp()
            ],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO cloud_inventory_directories VALUES(?1,?2,?3,'pending',NULL,'','')",
            params![ns, epoch, relative],
        )
        .map_err(|e| e.to_string())?;
        epoch
    };
    tx.commit().map_err(|e| e.to_string())?;
    Ok(Inventory {
        namespace: ns.into(),
        scope: scope.into(),
        epoch,
        prefix,
        provider_prefix,
        root_relative: relative.into(),
    })
}

fn frontier(
    c: &Connection,
    inventory: &Inventory,
) -> Result<Option<(String, Option<String>)>, String> {
    c.query_row("SELECT relative,continuation FROM cloud_inventory_directories WHERE namespace=?1 AND epoch=?2 AND state='pending' ORDER BY relative LIMIT 1",params![inventory.namespace,inventory.epoch],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e|e.to_string())
}

fn retain_page(
    c: &mut Connection,
    inventory: &Inventory,
    directory: &str,
    token: Option<&str>,
    page: InventoryPage,
) -> Result<(), String> {
    let requested_prefix = format!("{}{directory}", inventory.provider_prefix);
    let logical_size = page
        .keys
        .iter()
        .chain(&page.directories)
        .try_fold(0usize, |size, key| {
            size.checked_add(key.len()).ok_or("云对象清单页面长度溢出")
        })?;
    if logical_size > 8 * 1024 * 1024
        || page
            .next
            .as_ref()
            .is_some_and(|v| v.is_empty() || v.len() > 8 * 1024 * 1024)
    {
        return Err("云对象清单页面超过安全大小".into());
    }
    for key in &page.keys {
        let relative = key
            .strip_prefix(&inventory.provider_prefix)
            .ok_or("云对象超出同步命名空间")?;
        if !key.starts_with(&requested_prefix)
            || !key.starts_with(&inventory.prefix)
            || !valid_relative(relative, false)
        {
            return Err("云对象越过请求范围；未授予完整清单授权".into());
        }
    }
    let mut seen_directories = std::collections::HashSet::new(); // Only one bounded provider page.
    for child in &page.directories {
        let tail = child.strip_prefix(directory).ok_or("云目录越过请求范围")?;
        if !seen_directories.insert(child.as_str())
            || !valid_relative(child, true)
            || tail.is_empty()
            || tail.trim_end_matches('/').contains('/')
            || !child.starts_with(&inventory.root_relative)
        {
            return Err("云目录包含重复、循环或非直属子目录；未跳过记录".into());
        }
    }
    let tx = c.transaction().map_err(|e| e.to_string())?;
    {
        let mut insert = tx
            .prepare_cached("INSERT OR IGNORE INTO cloud_inventory_objects VALUES(?1,?2,?3,?4)")
            .map_err(|e| e.to_string())?;
        for key in page.keys {
            let relative = key
                .strip_prefix(&inventory.provider_prefix)
                .ok_or("云对象命名空间无效")?;
            insert
                .execute(params![inventory.namespace, inventory.epoch, key, relative])
                .map_err(|e| e.to_string())?;
        }
    }
    let mut invalid = None;
    for child in page.directories {
        let inserted=tx.execute("INSERT OR IGNORE INTO cloud_inventory_directories VALUES(?1,?2,?3,'pending',NULL,?4,?5)",params![inventory.namespace,inventory.epoch,child,directory,token.unwrap_or("")]).map_err(|e|e.to_string())?;
        if inserted == 0 {
            let replay:bool=tx.query_row("SELECT parent_relative=?4 AND origin_token=?5 FROM cloud_inventory_directories WHERE namespace=?1 AND epoch=?2 AND relative=?3",params![inventory.namespace,inventory.epoch,child,directory,token.unwrap_or("")],|r|r.get(0)).map_err(|e|e.to_string())?;
            if !replay {
                invalid = Some("云对象清单含重复或循环目录；取得记录已保留");
            }
        }
    }
    if let Some(next) = &page.next {
        let inserted = tx
            .execute(
                "INSERT OR IGNORE INTO cloud_inventory_tokens VALUES(?1,?2,?3,?4)",
                params![inventory.namespace, inventory.epoch, directory, next],
            )
            .map_err(|e| e.to_string())?;
        if inserted == 0 || token == Some(next) {
            invalid = Some("云对象清单分页游标重复；取得记录已保留");
        }
    }
    if let Some(error) = invalid {
        tx.execute(
            "UPDATE cloud_inventory_runs SET error=?4 WHERE namespace=?1 AND scope=?2 AND epoch=?3",
            params![inventory.namespace, inventory.scope, inventory.epoch, error],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        return Err(error.into());
    }
    tx.execute("UPDATE cloud_inventory_directories SET state=?4,continuation=?5 WHERE namespace=?1 AND epoch=?2 AND relative=?3",params![inventory.namespace,inventory.epoch,directory,if page.next.is_some(){"pending"}else{"complete"},page.next]).map_err(|e|e.to_string())?;
    tx.execute(
        "UPDATE cloud_inventory_runs SET error='' WHERE namespace=?1 AND scope=?2 AND epoch=?3",
        params![inventory.namespace, inventory.scope, inventory.epoch],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

pub(crate) async fn acquire(
    db: &PathBuf,
    remote: &dyn Store,
    ns: &str,
    scope: &str,
    relative: &str,
) -> Result<Inventory, String> {
    let inventory = {
        let (mut c, _writer) = open_write_database(db)?;
        begin(&mut c, remote, ns, scope, relative)?
    };
    loop {
        let next = frontier(&open_database(db)?, &inventory)?;
        let Some((directory, token)) = next else {
            break;
        };
        let page = match remote.inventory_page(&directory, token.as_deref()).await {
            Ok(page) => page,
            Err(error) => {
                let (c, _writer) = open_write_database(db)?;
                c.execute("UPDATE cloud_inventory_runs SET error=?4 WHERE namespace=?1 AND scope=?2 AND epoch=?3",params![ns,scope,inventory.epoch,error]).map_err(|e|e.to_string())?;
                return Err(error);
            }
        };
        let (mut c, _writer) = open_write_database(db)?;
        if let Err(error) = retain_page(&mut c, &inventory, &directory, token.as_deref(), page) {
            c.execute("UPDATE cloud_inventory_runs SET error=?4 WHERE namespace=?1 AND scope=?2 AND epoch=?3",params![ns,scope,inventory.epoch,error]).map_err(|e|e.to_string())?;
            return Err(error);
        }
    }
    let (mut c, _writer) = open_write_database(db)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    if frontier(&tx, &inventory)?.is_some() {
        return Err("云对象清单仍有未完成页面".into());
    }
    tx.execute("UPDATE cloud_inventory_runs SET state='complete',error='' WHERE namespace=?1 AND scope=?2 AND epoch=?3 AND state='listing'",params![ns,scope,inventory.epoch]).map_err(|e|e.to_string())?;
    inventory.ensure_complete(&tx)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(inventory)
}

/// A bounded receiver drains its frozen tail before taking a new provider inventory.
/// This keeps unacknowledged identities durable without retaining duplicate complete epochs.
pub(crate) async fn acquire_receive(
    db: &PathBuf,
    remote: &dyn Store,
    ns: &str,
    scope: &str,
    relative: &str,
    applied_table: &str,
) -> Result<Inventory, String> {
    let previous = {
        let (c, _writer) = open_write_database(db)?;
        schema(&c)?;
        c.query_row("SELECT epoch FROM cloud_inventory_runs WHERE namespace=?1 AND scope=?2 AND root_relative=?3 AND provider_prefix=?4 AND root_prefix=?5 AND state='complete' ORDER BY created_at DESC,epoch LIMIT 1",params![ns,scope,relative,remote.key(""),remote.key(relative)],|r|r.get::<_,String>(0)).optional().map_err(|e|e.to_string())?.map(|epoch|load(&c,ns,scope,&epoch)).transpose()?
    };
    if let Some(previous) = previous {
        let (c, _writer) = open_write_database(db)?;
        previous.prepare_receiver(&c, applied_table)?;
        if previous.unapplied_count(&c, applied_table)? > 0 {
            return Ok(previous);
        }
        previous.release(&c)?;
    }
    let inventory = acquire(db, remote, ns, scope, relative).await?;
    let (c, _writer) = open_write_database(db)?;
    inventory.prepare_receiver(&c, applied_table)?;
    Ok(inventory)
}

#[cfg(test)]
mod tests;
