//! Non-actionable page acquisition becomes a manifest only after complete scope.
use super::*;

pub(super) fn schema(c: &Connection) -> Result<(), String> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS cloud_maintenance_listings(namespace TEXT NOT NULL,id TEXT NOT NULL,configuration TEXT NOT NULL,purpose TEXT NOT NULL,snapshot_hash TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(namespace,id));
      CREATE TABLE IF NOT EXISTS cloud_maintenance_listing_heads(namespace TEXT NOT NULL,configuration TEXT NOT NULL,purpose TEXT NOT NULL,snapshot_hash TEXT NOT NULL,listing TEXT NOT NULL,PRIMARY KEY(namespace,configuration,purpose,snapshot_hash));
      CREATE TABLE IF NOT EXISTS cloud_maintenance_listing_prefixes(namespace TEXT NOT NULL,listing TEXT NOT NULL,kind TEXT NOT NULL,scope TEXT NOT NULL,epoch TEXT NOT NULL,PRIMARY KEY(namespace,listing,kind));
      CREATE TABLE IF NOT EXISTS cloud_maintenance_listing_objects(namespace TEXT NOT NULL,listing TEXT NOT NULL,key TEXT NOT NULL,kind TEXT NOT NULL,PRIMARY KEY(namespace,listing,key,kind));").map_err(|e|e.to_string())?;
    crate::cloud_inventory::schema(c)
}
pub(super) async fn acquire(
    db: &PathBuf,
    remote: &dyn Store,
    ns: &str,
    configuration: &str,
    purpose: &str,
    snapshot: Option<&[u8]>,
) -> Result<String, String> {
    let snapshot_hash = snapshot.map(digest).unwrap_or_default();
    let id = {
        let (mut c, _writer) = open_write_database(db)?;
        schema(&c)?;
        require_enabled(&c)?;
        if source(&c)? != (ns.into(), configuration.into()) {
            return Err("云连接在预览时变化，请重试".into());
        }
        let old:Option<String>=c.query_row("SELECT l.id FROM cloud_maintenance_listing_heads h JOIN cloud_maintenance_listings l ON l.namespace=h.namespace AND l.id=h.listing WHERE h.namespace=?1 AND h.configuration=?2 AND h.purpose=?3 AND h.snapshot_hash=?4 AND l.state IN ('listing','complete')",params![ns,configuration,purpose,snapshot_hash],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        if let Some(id) = old {
            id
        } else {
            let id =
                digest(format!("{}:{}:{}", ns, now_timestamp(), random_url_safe(16)).as_bytes());
            let tx = c.transaction().map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT INTO cloud_maintenance_listings VALUES(?1,?2,?3,?4,?5,'listing')",
                params![ns, id, configuration, purpose, snapshot_hash],
            )
            .map_err(|e| e.to_string())?;
            tx.execute("INSERT INTO cloud_maintenance_listing_heads VALUES(?1,?2,?3,?4,?5) ON CONFLICT(namespace,configuration,purpose,snapshot_hash) DO UPDATE SET listing=excluded.listing",params![ns,configuration,purpose,snapshot_hash,id]).map_err(|e|e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
            id
        }
    };
    for (kind, relative, _) in history::SCOPES {
        let prior:Option<(String,String)>=open_database(db)?.query_row("SELECT scope,epoch FROM cloud_maintenance_listing_prefixes WHERE namespace=?1 AND listing=?2 AND kind=?3",params![ns,id,kind],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e|e.to_string())?;
        if let Some((scope, epoch)) = prior {
            let c = open_database(db)?;
            let frozen = crate::cloud_inventory::load(&c, ns, &scope, &epoch)?;
            frozen.ensure_complete(&c)?;
            if frozen.provider_prefix != remote.key("") || frozen.prefix != remote.key(relative) {
                return Err("维护清单恢复时云目录变化".into());
            }
            continue;
        }
        check_network(remote)?;
        let scope = format!("maintenance:{id}:{kind}");
        let inventory = crate::cloud_inventory::acquire(db, remote, ns, &scope, relative).await?;
        let (mut c, _writer) = open_write_database(db)?;
        let tx = c.transaction().map_err(|e| e.to_string())?;
        inventory.ensure_complete(&tx)?;
        let mut q=tx.prepare("SELECT key FROM cloud_inventory_objects WHERE namespace=?1 AND epoch=?2 ORDER BY key").map_err(|e|e.to_string())?;
        let mut rows = q
            .query(params![ns, inventory.epoch])
            .map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let key: String = row.get(0).map_err(|e| e.to_string())?;
            history::validate_key(remote, kind, &key)?;
            tx.execute(
                "INSERT OR IGNORE INTO cloud_maintenance_listing_objects VALUES(?1,?2,?3,?4)",
                params![ns, id, key, kind],
            )
            .map_err(|e| e.to_string())?;
        }
        drop(rows);
        drop(q);
        tx.execute(
            "INSERT INTO cloud_maintenance_listing_prefixes VALUES(?1,?2,?3,?4,?5)",
            params![ns, id, kind, scope, inventory.epoch],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
    }
    let (c, _writer) = open_write_database(db)?;
    require_enabled(&c)?;
    if source(&c)? != (ns.into(), configuration.into()) {
        return Err("云连接在预览时变化，请重试".into());
    }
    let complete:usize=c.query_row("SELECT count(*) FROM cloud_maintenance_listing_prefixes p JOIN cloud_inventory_runs r ON r.namespace=p.namespace AND r.scope=p.scope AND r.epoch=p.epoch AND r.state='complete' WHERE p.namespace=?1 AND p.listing=?2",params![ns,id],|r|r.get(0)).map_err(|e|e.to_string())?;
    if complete != history::SCOPES.len() {
        return Err("维护清单尚有未完成范围；本次不能准备、恢复或清理".into());
    }
    c.execute(
        "UPDATE cloud_maintenance_listings SET state='complete' WHERE namespace=?1 AND id=?2",
        params![ns, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}
pub(super) fn install(
    c: &Connection,
    ns: &str,
    id: &str,
    configuration: &str,
    purpose: &str,
) -> Result<usize, String> {
    let complete:bool=c.query_row("SELECT state='complete' AND configuration=?3 AND purpose=?4 FROM cloud_maintenance_listings WHERE namespace=?1 AND id=?2",params![ns,id,configuration,purpose],|r|r.get(0)).map_err(|e|e.to_string())?;
    if !complete {
        return Err("维护清单不完整或范围已经变化".into());
    }
    c.execute("INSERT INTO cloud_maintenance_objects(namespace,run,key,kind,body,status,replacement) SELECT namespace,listing,key,kind,X'','pending',0 FROM cloud_maintenance_listing_objects WHERE namespace=?1 AND listing=?2",params![ns,id]).map_err(|e|e.to_string())?;
    c.query_row(
        "SELECT count(*) FROM cloud_maintenance_listing_objects WHERE namespace=?1 AND listing=?2",
        params![ns, id],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}
pub(super) fn retire(c: &Connection, ns: &str, id: &str) -> Result<(), String> {
    loop {
        let prefix:Option<(String,String,String)>=c.query_row("SELECT kind,scope,epoch FROM cloud_maintenance_listing_prefixes WHERE namespace=?1 AND listing=?2 ORDER BY kind LIMIT 1",params![ns,id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|e|e.to_string())?;
        let Some((kind, scope, epoch)) = prefix else {
            break;
        };
        crate::cloud_inventory::load(c, ns, &scope, &epoch)?.release(c)?;
        c.execute("DELETE FROM cloud_maintenance_listing_prefixes WHERE namespace=?1 AND listing=?2 AND kind=?3",params![ns,id,kind]).map_err(|e|e.to_string())?;
    }
    c.execute(
        "DELETE FROM cloud_maintenance_listing_objects WHERE namespace=?1 AND listing=?2",
        params![ns, id],
    )
    .map_err(|e| e.to_string())?;
    c.execute(
        "UPDATE cloud_maintenance_listings SET state='installed' WHERE namespace=?1 AND id=?2",
        params![ns, id],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}
