//! Selection does not transfer ownership or delete already saved files.
use super::*;

fn same_root(left: &str, right: &str) -> bool {
    normalized_vault_path(left) == normalized_vault_path(right)
        || fs::canonicalize(left)
            .ok()
            .zip(fs::canonicalize(right).ok())
            .is_some_and(|(left, right)| left == right)
}
fn target_root(c: &Connection, target: &str) -> Result<Option<String>, String> {
    if let Some(hash) = target.strip_prefix("vault:") {
        c.query_row(
            "SELECT root FROM collection_roots WHERE destination=?1",
            [hash],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())
    } else if has_libraries(c)? {
        c.query_row(
            "SELECT location FROM libraries WHERE id=?1 AND provider='obsidian'",
            [target],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|e| e.to_string())
        .map(Option::flatten)
    } else {
        Ok(None)
    }
}
fn protect_default(c: &Connection, target: &str) -> Result<(), String> {
    let cfg = storage::config(c)?;
    if target == "default" || target == "hub" && cfg.mode != "obsidian" {
        return Err("默认本地保存位置始终保留，不能取消".into());
    }
    if cfg.mode == "obsidian"
        && target_root(c, target)?
            .as_deref()
            .is_some_and(|root| same_root(root, &cfg.vault_path))
    {
        return Err("默认本地页面和附件始终保留，不能取消".into());
    }
    Ok(())
}
fn aliases(c: &Connection, key: &str, target: &str) -> Result<Vec<String>, String> {
    let Some(root) = target_root(c, target)? else {
        return Ok(vec![target.into()]);
    };
    let libraries = if has_libraries(c)? {
        " UNION SELECT id FROM libraries WHERE provider='obsidian'"
    } else {
        ""
    };
    let sql = format!("SELECT target FROM collection_library_destinations WHERE item_key=?1 UNION SELECT target FROM collection_library_jobs WHERE item_key=?1 UNION SELECT target FROM collection_library_pending WHERE item_key=?1 UNION SELECT destination FROM collection_lifecycle WHERE item_key=?1 AND destination IS NOT NULL UNION SELECT 'vault:'||destination FROM collection_roots{libraries}");
    let mut statement = c.prepare(&sql).map_err(|e| e.to_string())?;
    let candidates = statement
        .query_map([key], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut targets = vec![target.to_string()];
    for candidate in candidates {
        if candidate != target
            && target_root(c, &candidate)?
                .as_deref()
                .is_some_and(|path| same_root(path, &root))
        {
            targets.push(candidate);
        }
    }
    Ok(targets)
}
pub(super) fn remove(c: &Connection, key: &str, target: &str) -> Result<(), String> {
    exists(c, key)?;
    protect_default(c, target)?;
    let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
    // A vault root can have both a historical hash and a registered library ID.
    // Deselect both identities so a late local export cannot reintroduce its badge.
    for target in aliases(&tx, key, target)? {
        // Keep a durable row for legacy jobs too. Late receipts may update the
        // physical state, but never turn selection back on.
        tx.execute("INSERT INTO collection_library_destinations(item_key,target,state,selected) VALUES(?1,?2,CASE WHEN EXISTS(SELECT 1 FROM collection_remote_copies WHERE item_key=?1 AND library_id=?2 AND verified=1 AND parent_id<>'attachment') THEN 'saved' ELSE 'queued' END,0) ON CONFLICT(item_key,target) DO UPDATE SET selected=0", params![key,target]).map_err(|e|e.to_string())?;
        pending::retain_cancelled(&tx, key, &target)?;
        tx.execute("UPDATE collection_library_jobs SET phase='cancelled',error='',detail='已取消此资料库选择，现有副本和附件保留',updated_at=?3 WHERE item_key=?1 AND target=?2 AND action='move'", params![key,target,now_timestamp()]).map_err(|e|e.to_string())?;
        tx.execute("UPDATE collection_lifecycle SET destination=NULL,destination_name='' WHERE item_key=?1 AND destination=?2",params![key,target]).map_err(|e|e.to_string())?;
    }
    promote_copy_requests(&tx)?;
    tx.commit().map_err(|e| e.to_string())
}
