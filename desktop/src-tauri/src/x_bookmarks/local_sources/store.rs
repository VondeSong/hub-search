use super::*;

fn existing(c: &Connection, sql: &str, a: &str, b: &str) -> Result<Option<String>, String> {
    c.query_row(sql, params![a, b], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())
}
fn receipt(
    c: &Connection,
    root: &Path,
    relative: &str,
) -> Result<Option<(String, String, String)>, String> {
    let mut q=c.prepare("SELECT r.root,e.item_key,e.file_hash,e.input_hash FROM collection_obsidian_exports e JOIN collection_roots r ON r.destination=e.destination WHERE e.relative_path=?1 COLLATE NOCASE ORDER BY e.local_seq").map_err(|e|e.to_string())?;
    for row in q
        .query_map([relative], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?
    {
        let (saved, key, hash, input) = row.map_err(|e| e.to_string())?;
        if crate::library_location::path_key(Path::new(&saved))
            == crate::library_location::path_key(root)
        {
            return Ok(Some((key, hash, input)));
        }
    }
    Ok(None)
}
pub(super) fn hub_export(c: &Connection, root: &Path, relative: &str) -> Result<bool, String> {
    let managed = relative.starts_with("X/书签/")
        || relative.starts_with("X/喜欢/")
        || relative.starts_with("Telegram/收集/");
    if !managed {
        return Ok(false);
    }
    let Some((key, hash, input)) = receipt(c, root, relative)? else {
        return Ok(false);
    };
    Ok(!owns(c, &key)? && input != storage::hash(format!("source-backed-v1:{hash}").as_bytes()))
}
pub(super) fn apply(
    c: &mut Connection,
    root: &Path,
    destination: &str,
    relative: &str,
    note: &markdown::Note,
) -> Result<usize, String> {
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let old:Option<(String,String,String,String)>=tx.query_row("SELECT item_key,identity,file_hash,dependencies FROM collection_local_source_files WHERE destination=?1 AND relative_path=?2",params![destination,relative],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(|e|e.to_string())?;
    let receipt = receipt(&tx, root, relative)?;
    let mapped = old
        .as_ref()
        .filter(|(key, id, _, _)| !key.is_empty() && (id == &note.identity || id.is_empty()))
        .map(|v| v.0.clone());
    let mut key = mapped.clone().or_else(|| {
        if old.is_none() {
            receipt.as_ref().map(|v| v.0.clone())
        } else {
            None
        }
    });
    if key.is_none() {
        key=existing(&tx,"SELECT e.item_key FROM collection_obsidian_exports e JOIN collection_x_items i ON i.item_key=e.item_key WHERE e.file_hash=?1 AND COALESCE(NULLIF(json_extract(i.post_json,'$.source'),''),'bookmarks')=?2 ORDER BY e.local_seq LIMIT 1",&note.file_hash,&note.post.source)?;
    }
    if key.is_none() && !note.identity.is_empty() {
        key=existing(&tx,"SELECT item_key FROM collection_local_source_files WHERE identity=?1 AND identity<>'' AND item_key<>'' AND ?2<>'' ORDER BY checked_at,relative_path LIMIT 1",&note.identity,&note.post.source)?;
    }
    if key.is_none() && note.identity.starts_with("x:") {
        key=existing(&tx,"SELECT item_key FROM collection_x_items WHERE json_extract(post_json,'$.id')=?1 AND COALESCE(NULLIF(json_extract(post_json,'$.source'),''),'bookmarks')=?2 ORDER BY collected_at,item_key LIMIT 1",&note.post.id,&note.post.source)?;
    }
    if key.is_none() && note.identity.starts_with("telegram:") {
        key=existing(&tx,"SELECT item_key FROM collection_x_items WHERE rtrim(json_extract(post_json,'$.url'),'/')=rtrim(?1,'/') AND json_extract(post_json,'$.source')=?2 ORDER BY collected_at,item_key LIMIT 1",&note.post.url,&note.post.source)?;
    }
    if key.is_none() {
        key=existing(&tx,"SELECT item_key FROM collection_local_source_files WHERE fingerprint=?1 AND item_key<>'' AND ?2<>'' ORDER BY checked_at,relative_path LIMIT 1",&note.fingerprint,&note.post.source)?;
    }
    // One-off source mirrors used content-derived keys. Adopt their identity, never reinsert them.
    if key.is_none() {
        let legacy = format!(
            "{}{}",
            if note.post.source == "telegram" {
                "telegram:obsidian:"
            } else {
                "obsidian:x:"
            },
            &note.fingerprint[..40]
        );
        key = existing(
            &tx,
            "SELECT item_key FROM collection_x_items WHERE item_key=?1 AND ?2<>''",
            &legacy,
            &note.post.source,
        )?;
    }
    let key = key.unwrap_or_else(|| {
        format!(
            "obsidian:{}:{}",
            note.post.source,
            storage::hash(if note.identity.is_empty() {
                note.fingerprint.as_bytes()
            } else {
                note.identity.as_bytes()
            })
        )
    });
    let blocked = library::blocked(&tx, &key)?;
    let present: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM collection_x_items WHERE item_key=?1)",
            [&key],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let legacy = receipt.as_ref().is_some_and(|(_, hash, input)| {
        *input == storage::hash(format!("source-backed-v1:{hash}").as_bytes())
    });
    let mut changed = 0;
    if !blocked && !present {
        let body = serde_json::to_string(&note.post).map_err(|e| e.to_string())?;
        let now = chrono::Utc::now().timestamp_millis();
        tx.execute("INSERT INTO collection_x_items(item_key,account,post_json,content_hash,collected_at,captured_at,read_at) VALUES(?1,'obsidian-local',?2,?3,?4,?5,?6)",params![key,body,storage::hash(body.as_bytes()),note.collected,now,if matches!(note.status.as_str(),"read"|"abandoned"){now}else{0}]).map_err(|e|e.to_string())?;
        tx.execute(
            "INSERT INTO collection_x_properties(item_key,status,tags) VALUES(?1,?2,?3)",
            params![key, note.status, json!(note.tags).to_string()],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT OR IGNORE INTO collection_local_source_items(item_key) VALUES(?1)",
            [&key],
        )
        .map_err(|e| e.to_string())?;
        // Older desktops also understand passive mirrors; retain their rollback guard.
        tx.execute(
            "INSERT OR IGNORE INTO reading_cloud_items(item_key) VALUES(?1)",
            [&key],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT OR IGNORE INTO reading_cloud_passive(item_key) VALUES(?1)",
            [&key],
        )
        .map_err(|e| e.to_string())?;
        library::record_saved(&tx, &key, root)?;
        changed += 1;
    } else if legacy {
        tx.execute(
            "INSERT OR IGNORE INTO collection_local_source_items(item_key) VALUES(?1)",
            [&key],
        )
        .map_err(|e| e.to_string())?;
    }
    let owned = owns(&tx, &key)?;
    // Only the adopted original may refresh an existing local projection. A second version
    // or a native Hub item remains intact; every raw version retains its independent receipt.
    let primary:Option<String>=tx.query_row("SELECT relative_path FROM collection_obsidian_exports WHERE destination=?1 AND item_key=?2",params![destination,key],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    let renamed = primary
        .as_ref()
        .is_some_and(|old| !root.join(old).is_file());
    let dependencies = serde_json::to_string(&note.dependencies).map_err(|e| e.to_string())?;
    let content_changed = old
        .as_ref()
        .is_some_and(|(_, _, hash, deps)| hash != &note.file_hash || deps != &dependencies);
    let refresh = owned
        && !blocked
        && (mapped.is_some() && content_changed && primary.as_deref() == Some(relative) || renamed);
    if refresh {
        let body = serde_json::to_string(&note.post).map_err(|e| e.to_string())?;
        changed+=tx.execute("UPDATE collection_x_items SET post_json=?2,content_hash=?3,captured_at=?4 WHERE item_key=?1 AND content_hash<>?3",params![key,body,storage::hash(body.as_bytes()),chrono::Utc::now().timestamp_millis()]).map_err(|e|e.to_string())?;
    }
    if !blocked && owned && (primary.is_none() || primary.as_deref() == Some(relative) || renamed) {
        let pending = note.dependencies.iter().any(|d| d.path.is_empty());
        tx.execute("INSERT INTO collection_obsidian_exports(destination,item_key,relative_path,file_hash,input_hash,media_pending) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(destination,item_key) DO UPDATE SET relative_path=excluded.relative_path,file_hash=excluded.file_hash,input_hash=excluded.input_hash,media_pending=excluded.media_pending",params![destination,key,relative,note.file_hash,storage::hash(format!("source-backed-v1:{}",note.file_hash).as_bytes()),pending]).map_err(|e|e.to_string())?;
    }
    if !blocked && owned {
        for dep in note.dependencies.iter().filter(|d| !d.path.is_empty()) {
            let display = crate::sources::display_local_path(Path::new(&dep.path));
            let url = Url::from_file_path(Path::new(&display))
                .map_err(|_| "附件路径无效")?
                .to_string();
            tx.execute("INSERT INTO collection_saved_media(item_key,media_url,path) VALUES(?1,?2,?3) ON CONFLICT(item_key,media_url) DO UPDATE SET path=excluded.path",params![key,url,dep.path]).map_err(|e|e.to_string())?;
            // No collection_owned_assets: intake may read these files, never delete them.
        }
    }
    tx.execute("INSERT INTO collection_local_source_files(destination,relative_path,item_key,file_hash,fingerprint,identity,dependencies,error,checked_at) VALUES(?1,?2,?3,?4,?5,?6,?7,'',?8) ON CONFLICT(destination,relative_path) DO UPDATE SET item_key=excluded.item_key,file_hash=excluded.file_hash,fingerprint=excluded.fingerprint,identity=excluded.identity,dependencies=excluded.dependencies,error='',checked_at=excluded.checked_at",params![destination,relative,key,note.file_hash,note.fingerprint,note.identity,serde_json::to_string(&note.dependencies).map_err(|e|e.to_string())?,chrono::Utc::now().timestamp_millis()]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(changed)
}
