//! Library identities survive directory moves and remote display-name changes.
use crate::{sources, Connection};
use rusqlite::params;
use std::path::Path;

pub(crate) fn path_key(path: &Path) -> String {
    let resolved = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let value = sources::display_local_path(&resolved).replace('\\', "/");
    #[cfg(windows)]
    let value = value.to_lowercase();
    value.trim_end_matches('/').to_string()
}

pub(crate) fn obsidian_id_at(c: &Connection, root: &Path) -> Result<Option<String>, String> {
    let mut q = c.prepare("SELECT id,location FROM libraries WHERE provider='obsidian' AND location IS NOT NULL ORDER BY enabled DESC,added_at,id").map_err(|e| e.to_string())?;
    let rows = q
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    let key = path_key(root);
    for row in rows {
        let (id, location) = row.map_err(|e| e.to_string())?;
        if path_key(Path::new(&location)) == key {
            return Ok(Some(id));
        }
    }
    Ok(None)
}

pub(crate) fn vault_name(c: &Connection, id: &str) -> Result<String, String> {
    let location: String = c
        .query_row(
            "SELECT location FROM libraries WHERE id=?1 AND provider='obsidian' AND enabled=1",
            [id],
            |r| r.get(0),
        )
        .map_err(|_| "Obsidian 资料库没有有效的文件夹位置")?;
    Ok(sources::obsidian_vault_name(Path::new(&location)))
}

pub(crate) fn relocate_obsidian(
    c: &mut Connection,
    id: &str,
    root: &Path,
) -> Result<String, String> {
    let root = root
        .canonicalize()
        .map_err(|e| format!("无法访问所选文件夹：{e}"))?;
    if !root.is_dir() {
        return Err("请选择 Obsidian 库的根文件夹".into());
    }
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let old: String = tx
        .query_row(
            "SELECT location FROM libraries WHERE id=?1 AND provider='obsidian' AND enabled=1",
            [id],
            |r| r.get(0),
        )
        .map_err(|_| "找不到要重新定位的 Obsidian 库")?;
    // Reject an unrelated folder before reconciliation could delete cached notes.
    crate::x_bookmarks::storage::relocation::ensure_unoccupied(
        &tx,
        Path::new(&old),
        Some(id),
        &root,
    )?;
    crate::x_bookmarks::storage::relocation::verify_same_vault(
        &tx,
        Path::new(&old),
        Some(id),
        &root,
    )?;
    let location = sources::display_local_path(&root);
    crate::x_bookmarks::library::relocate_root(&tx, Path::new(&old), &root)?;
    tx.execute("UPDATE libraries SET location=?1,name=CASE WHEN COALESCE(json_extract(metadata_json,'$.displayNameCustomized'),0)=1 THEN name ELSE ?2 END WHERE id=?3", params![location, sources::obsidian_vault_name(&root), id]).map_err(|e| e.to_string())?;
    crate::x_bookmarks::library::refresh_names(&tx)?;
    tx.commit()
        .map_err(|e| format!("无法保存资料库的新位置：{e}"))?;
    Ok(location)
}

pub(crate) fn refresh_craft_name(
    c: &mut Connection,
    id: &str,
    remote_name: &str,
) -> Result<String, String> {
    let tx = c.transaction().map_err(|e| e.to_string())?;
    tx.execute("UPDATE libraries SET name=?1 WHERE id=?2 AND provider='craft' AND enabled=1 AND COALESCE(json_extract(metadata_json,'$.displayNameCustomized'),0)<>1", params![remote_name, id]).map_err(|e| e.to_string())?;
    let name: String = tx
        .query_row(
            "SELECT name FROM libraries WHERE id=?1 AND provider='craft' AND enabled=1",
            [id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    tx.execute("UPDATE spaces SET name=?1 WHERE id=?2", params![name, id])
        .map_err(|e| e.to_string())?;
    crate::x_bookmarks::library::refresh_names(&tx)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(name)
}

#[cfg(test)]
mod tests;
