//! Per-item lifecycle and additive verified copies. Operations survive process exits.
use super::*;
pub(super) mod control;
pub(crate) mod conversion;
mod pending;
mod projection;
mod queue;
pub(crate) use queue::try_relocation;
mod selection;
// Shared local assets need exclusion only during file work, not an entire X/network sync.
pub(crate) static FILES_LOCK: AsyncMutex<()> = AsyncMutex::const_new(());
fn operation_error(value: &mut Value) {
    if !value.is_object() {
        return;
    }
    let error = value["error"].as_str().unwrap_or("").to_string();
    value["attachmentLoginRequired"] =
        json!(value["phase"] != "cancelled" && conversion::attachment_login_required(&error));
    value["error"] = json!(conversion::user_error(&error));
}
fn operation_context(c: &Connection, value: &mut Value) {
    let key = value["key"].as_str().unwrap_or("");
    let title = c
        .query_row(
            "SELECT post_json FROM collection_x_items WHERE item_key=?1",
            [key],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|raw| serde_json::from_str::<Post>(&raw).ok())
        .map(|post| {
            storage::display_title(&Item {
                key: key.into(),
                post,
                collected_at: 0,
                read: false,
            })
        })
        .filter(|title| !title.trim().is_empty())
        .or_else(|| value["plan"]["title"].as_str().map(str::to_string))
        .unwrap_or_else(|| "未命名内容".into());
    let target = value["target"].as_str().unwrap_or("");
    let target_name = if target == "hub" {
        "Hub 本地数据库".into()
    } else if let Some(hash) = target.strip_prefix("vault:") {
        c.query_row(
            "SELECT root FROM collection_roots WHERE destination=?1",
            [hash],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|root| {
            root.trim_end_matches(['/', '\\'])
                .rsplit(['/', '\\'])
                .find(|name| !name.is_empty())
                .map(|name| format!("Obsidian · {name}"))
        })
        .unwrap_or_else(|| "Obsidian".into())
    } else {
        c.query_row("SELECT name FROM libraries WHERE id=?1", [target], |row| {
            row.get::<_, String>(0)
        })
        .ok()
        .or_else(|| value["plan"]["libraryName"].as_str().map(str::to_string))
        .unwrap_or_else(|| "资料库".into())
    };
    value["itemTitle"] = json!(title);
    value["targetName"] = json!(target_name);
}
fn queue_automatic_saves(c: &Connection) -> Result<usize, String> {
    c.execute("UPDATE collection_library_jobs SET phase='ready' WHERE action='move' AND phase='needs_review' AND error='' AND CASE WHEN json_valid(plan) THEN COALESCE(json_extract(plan,'$.agentActionId'),'')='' ELSE 1 END AND CASE WHEN json_valid(plan) THEN json_extract(plan,'$.status')='planned' AND (json_extract(plan,'$.provider')='craft' OR (json_extract(plan,'$.provider')='dida365' AND json_array_length(plan,'$.tasks')=1 AND json_extract(plan,'$.tasks[0].kind')='reference')) ELSE 0 END",[]).map_err(|e|e.to_string())
}
fn upgrade_unwritten_craft_plans(c: &Connection) -> Result<usize, String> {
    // Replan only operations with no possible external write; keep partial/unknown identities.
    c.execute("UPDATE collection_library_jobs SET phase='queued',plan='',error='',detail='' 
        WHERE action='move' AND phase IN ('needs_review','ready') AND error='' AND CASE WHEN json_valid(plan) THEN COALESCE(json_extract(plan,'$.agentActionId'),'')='' ELSE 1 END
        AND NOT EXISTS(SELECT 1 FROM collection_remote_copies r WHERE r.item_key=collection_library_jobs.item_key)
        AND CASE WHEN json_valid(plan) THEN json_extract(plan,'$.provider')='craft'
          AND json_extract(plan,'$.status') IN ('planned','needs_input')
          AND COALESCE(json_extract(plan,'$.archivePolicyVersion'),'')<>'video-upload-only-daily-v1'
        ELSE 0 END", []).map_err(|e| e.to_string())
}

pub(crate) fn schema(c: &Connection) -> Result<(), String> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS collection_library_policy(version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS collection_library_destinations(item_key TEXT NOT NULL,target TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'queued',selected INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(item_key,target));
      CREATE TABLE IF NOT EXISTS collection_lifecycle(
      item_key TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'active',
      destination TEXT, revision INTEGER NOT NULL DEFAULT 0,destination_name TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS collection_roots(destination TEXT PRIMARY KEY, root TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collection_owned_assets(item_key TEXT NOT NULL,path TEXT NOT NULL,PRIMARY KEY(item_key,path));
      CREATE TABLE IF NOT EXISTS collection_message_tombstones(bot_id INTEGER NOT NULL,user_id INTEGER NOT NULL,message_id INTEGER NOT NULL,channel TEXT NOT NULL,item_key TEXT NOT NULL,fingerprint TEXT NOT NULL DEFAULT '',PRIMARY KEY(bot_id,user_id,message_id,channel));
      CREATE TABLE IF NOT EXISTS collection_library_jobs(
      item_key TEXT PRIMARY KEY, action TEXT NOT NULL, target TEXT NOT NULL DEFAULT '',
      phase TEXT NOT NULL DEFAULT 'queued', error TEXT NOT NULL DEFAULT '',
      plan TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL DEFAULT 0,goal TEXT NOT NULL DEFAULT '',cleanup_force INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS collection_remote_copies(
      item_key TEXT NOT NULL, library_id TEXT NOT NULL, provider TEXT NOT NULL,
      object_id TEXT NOT NULL, parent_id TEXT NOT NULL DEFAULT '',
      content_hash TEXT NOT NULL DEFAULT '', verified INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(item_key,library_id,object_id));")
      .map_err(|e| e.to_string())?;
    for (column, definition) in [
        ("goal", "TEXT NOT NULL DEFAULT ''"),
        ("detail", "TEXT NOT NULL DEFAULT ''"),
        ("cleanup_force", "INTEGER NOT NULL DEFAULT 0"),
        ("inflight", "INTEGER NOT NULL DEFAULT 0"),
    ] {
        let present:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('collection_library_jobs') WHERE name=?1)",[column],|r|r.get(0)).map_err(|e|e.to_string())?;
        if !present {
            c.execute(
                &format!("ALTER TABLE collection_library_jobs ADD COLUMN {column} {definition}"),
                [],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    let selected: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('collection_library_destinations') WHERE name='selected')", [], |r|r.get(0)).map_err(|e|e.to_string())?;
    let source_operation:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('collection_remote_copies') WHERE name='source_operation_id')",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    if !source_operation {
        c.execute("ALTER TABLE collection_remote_copies ADD COLUMN source_operation_id TEXT NOT NULL DEFAULT ''",[]).map_err(|e|e.to_string())?;
    }
    if !selected {
        c.execute("ALTER TABLE collection_library_destinations ADD COLUMN selected INTEGER NOT NULL DEFAULT 1", []).map_err(|e|e.to_string())?;
    }
    pending::schema(c)?;
    let has_name:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('collection_lifecycle') WHERE name='destination_name')",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    if !has_name {
        c.execute(
            "ALTER TABLE collection_lifecycle ADD COLUMN destination_name TEXT NOT NULL DEFAULT ''",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    let has_fingerprint:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('collection_message_tombstones') WHERE name='fingerprint')",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    if !has_fingerprint {
        c.execute("ALTER TABLE collection_message_tombstones ADD COLUMN fingerprint TEXT NOT NULL DEFAULT ''",[]).map_err(|e|e.to_string())?;
    }
    c.execute("CREATE INDEX IF NOT EXISTS collection_message_tombstone_fingerprint ON collection_message_tombstones(bot_id,user_id,fingerprint,channel)",[]).map_err(|e|e.to_string())?;
    let migrated: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM collection_library_policy WHERE version=1)",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !migrated {
        c.execute("INSERT OR IGNORE INTO collection_library_destinations(item_key,target,state) SELECT item_key,destination,'saved' FROM collection_lifecycle WHERE destination IS NOT NULL AND state NOT IN ('deleted','deleting')", []).map_err(|e| e.to_string())?;
        c.execute("INSERT OR IGNORE INTO collection_library_destinations(item_key,target,state) SELECT DISTINCT item_key,library_id,'saved' FROM collection_remote_copies WHERE verified=1 AND parent_id<>'attachment' AND NOT EXISTS(SELECT 1 FROM collection_lifecycle l WHERE l.item_key=collection_remote_copies.item_key AND l.state IN ('deleted','deleting'))", []).map_err(|e| e.to_string())?;
        let has_exports: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='collection_obsidian_exports')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
        if has_exports {
            c.execute("INSERT OR IGNORE INTO collection_library_destinations(item_key,target,state) SELECT e.item_key,'vault:'||e.destination,'saved' FROM collection_obsidian_exports e WHERE NOT EXISTS(SELECT 1 FROM collection_lifecycle l WHERE l.item_key=e.item_key AND l.state IN ('deleted','deleting'))", []).map_err(|e| e.to_string())?;
            c.execute(
                "INSERT OR IGNORE INTO collection_library_policy(version) VALUES(1)",
                [],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    crate::local_database_maintenance::ensure_sequences(
        c,
        &[
            "collection_library_destinations",
            "collection_remote_copies",
        ],
    )
}
pub(crate) fn blocked(c: &Connection, key: &str) -> Result<bool, String> {
    c.query_row("SELECT EXISTS(SELECT 1 FROM collection_lifecycle WHERE item_key=?1 AND state IN ('deleting','deleted'))",[key],|r|r.get(0)).map_err(|e|e.to_string())
}
pub(crate) fn decorate(c: &Connection, key: &str, value: &mut Value) -> Result<(), String> {
    projection::decorate_one(c, key, value)
}
pub(super) fn decorate_page(c: &Connection, items: &mut [Value]) -> Result<(), String> {
    projection::decorate_page(c, items)
}
pub(super) fn attention_operations(c: &Connection, key: &str) -> Result<Vec<Value>, String> {
    let predicate = super::query::BLOCKED_OPERATION;
    let mut statement = c.prepare(&format!("SELECT item_key,action,target,phase,error,plan,detail,0 AS parked,updated_at FROM collection_library_jobs WHERE item_key=?1 AND {predicate} AND NOT EXISTS(SELECT 1 FROM collection_library_destinations d WHERE d.item_key=collection_library_jobs.item_key AND d.target=collection_library_jobs.target AND d.selected=0) UNION ALL SELECT item_key,action,target,phase,error,plan,detail,1 AS parked,updated_at FROM collection_library_pending WHERE item_key=?1 AND {predicate} AND NOT EXISTS(SELECT 1 FROM collection_library_destinations d WHERE d.item_key=collection_library_pending.item_key AND d.target=collection_library_pending.target AND d.selected=0) ORDER BY updated_at DESC")).map_err(|e|e.to_string())?;
    let mut operations = statement.query_map([key], |r|Ok(json!({"key":r.get::<_,String>(0)?,"action":r.get::<_,String>(1)?,"target":r.get::<_,String>(2)?,"phase":r.get::<_,String>(3)?,"error":r.get::<_,String>(4)?,"plan":serde_json::from_str::<Value>(&r.get::<_,String>(5)?).unwrap_or(Value::Null),"detail":r.get::<_,String>(6)?,"parked":r.get::<_,bool>(7)?}))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    for operation in &mut operations {
        operation_error(operation);
    }
    Ok(operations)
}
pub(super) fn attention_issues(c: &Connection, key: &str) -> Result<Vec<Value>, String> {
    let mut statement = c.prepare("SELECT 'sourceCancellation',error FROM collection_x_outbox WHERE item_key=?1 AND error<>'' UNION ALL SELECT 'contentUpdate',error FROM collection_x_enrichment WHERE item_key=?1 AND error<>''").map_err(|e|e.to_string())?;
    let issues = statement.query_map([key], |r| Ok(json!({"kind":r.get::<_,String>(0)?,"error":conversion::user_error(&r.get::<_,String>(1)?)}))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    Ok(issues)
}
fn normalized_vault_path(path: &str) -> String {
    path.replace('\\', "/")
        .trim_start_matches("//?/")
        .trim_end_matches('/')
        .to_lowercase()
}
fn has_libraries(c: &Connection) -> Result<bool, String> {
    c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='libraries')",
        [],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}
fn obsidian_location(
    c: &Connection,
    root: &str,
    libraries: bool,
    inherited: bool,
) -> Result<Value, String> {
    let library: Option<(String, String)> = if libraries && !root.is_empty() {
        c.query_row("SELECT id,name FROM libraries WHERE provider='obsidian' AND enabled=1 AND rtrim(replace(replace(lower(location),'\\','/'),'//?/',''),'/')=rtrim(replace(replace(lower(?1),'\\','/'),'//?/',''),'/') ORDER BY id LIMIT 1", [root], |r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e| e.to_string())?
    } else {
        None
    };
    let (id, name) = match library {
        Some((id, name)) => (Some(id), name),
        None => (
            None,
            root.trim_end_matches(['/', '\\'])
                .rsplit(['/', '\\'])
                .find(|part| !part.is_empty())
                .unwrap_or("Obsidian")
                .to_string(),
        ),
    };
    Ok(json!({"kind":"obsidian","name":name,"path":root,"libraryId":id,"isDefault":inherited}))
}
fn storage_location(
    c: &Connection,
    key: &str,
    chosen: Option<&str>,
    libraries: bool,
) -> Result<Value, String> {
    if chosen == Some("hub") {
        return Ok(json!({"kind":"hub","name":"Hub 本地数据库","isDefault":false}));
    }
    if let Some(hash) = chosen.and_then(|id| id.strip_prefix("vault:")) {
        let root: Option<String> = c
            .query_row(
                "SELECT root FROM collection_roots WHERE destination=?1",
                [hash],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        return obsidian_location(c, root.as_deref().unwrap_or(""), libraries, false);
    }
    if let Some(id) = chosen {
        if libraries {
            let library: Option<(String, String, Option<String>, bool)> = c
                .query_row(
                    "SELECT provider,name,location,enabled FROM libraries WHERE id=?1",
                    [id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if let Some((kind, name, path, enabled)) = library {
                return Ok(
                    json!({"kind":kind,"name":name,"path":path,"libraryId":enabled.then_some(id),"isDefault":false}),
                );
            }
        }
        return Ok(json!({"kind":"library","name":"未连接的资料库","isDefault":false}));
    }
    // An existing export is evidence of the item's location, even if its vault
    // has not been added to Hub's library list or the default has since changed.
    let export: Option<Option<String>> = c.query_row("SELECT r.root FROM collection_obsidian_exports e LEFT JOIN collection_roots r ON r.destination=e.destination WHERE e.item_key=?1 ORDER BY e.local_seq DESC LIMIT 1", [key], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
    if let Some(root) = export {
        return obsidian_location(c, root.as_deref().unwrap_or(""), libraries, false);
    }
    let base = storage::config(c)?;
    if base.mode == "obsidian" {
        obsidian_location(c, &base.vault_path, libraries, true)
    } else {
        Ok(json!({"kind":"hub","name":"Hub 本地数据库","isDefault":true}))
    }
}
fn resolve_move_target(c: &Connection, requested: &str) -> Result<String, String> {
    if requested != "default" {
        return Ok(requested.into());
    }
    let base = storage::config(c)?;
    if base.mode != "obsidian" {
        return Ok("hub".into());
    }
    let root = fs::canonicalize(&base.vault_path)
        .map_err(|_| "默认 Obsidian 目录不可用，请检查保存位置设置")?;
    let hash = register_root(c, &root)?;
    let location = obsidian_location(c, &root.to_string_lossy(), has_libraries(c)?, true)?;
    Ok(location["libraryId"]
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| format!("vault:{hash}")))
}
pub(crate) fn refresh_names(c: &Connection) -> Result<(), String> {
    let present: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='libraries')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if present {
        c.execute("INSERT OR IGNORE INTO collection_lifecycle(item_key) SELECT DISTINCT item_key FROM collection_obsidian_exports",[]).map_err(|e|e.to_string())?;
        c.execute("WITH names AS MATERIALIZED (
          SELECT item_key,COALESCE((SELECT name FROM libraries WHERE id=destination AND enabled=1),
            (SELECT l.name FROM collection_obsidian_exports e
             JOIN collection_roots r ON r.destination=e.destination
             JOIN libraries l ON l.provider='obsidian' AND l.enabled=1
               AND replace(replace(lower(l.location),'\\','/'),'//?/','')=replace(replace(lower(r.root),'\\','/'),'//?/','')
             WHERE e.item_key=collection_lifecycle.item_key
               AND (collection_lifecycle.destination IS NULL OR collection_lifecycle.destination='vault:'||r.destination)
             ORDER BY e.local_seq DESC LIMIT 1),'') AS name
          FROM collection_lifecycle)
          UPDATE collection_lifecycle SET destination_name=(SELECT name FROM names WHERE names.item_key=collection_lifecycle.item_key)
          WHERE EXISTS(SELECT 1 FROM names WHERE names.item_key=collection_lifecycle.item_key AND names.name IS NOT collection_lifecycle.destination_name)",[]).map_err(|e|e.to_string())?;
    }
    Ok(())
}
pub(super) fn record_saved(c: &Connection, key: &str, root: &Path) -> Result<(), String> {
    let present: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='libraries')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let library = if present {
        c.query_row("SELECT id,name FROM libraries WHERE provider='obsidian' AND enabled=1 AND replace(replace(lower(location),'\\','/'),'//?/','')=replace(replace(lower(?1),'\\','/'),'//?/','')",[root.to_string_lossy()],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional().map_err(|e|e.to_string())?
    } else {
        None
    };
    let (id, name) = match library {
        Some(library) => library,
        None => (format!("vault:{}", register_root(c, root)?), String::new()),
    };
    c.execute("INSERT INTO collection_lifecycle(item_key,destination,destination_name) SELECT ?1,?2,?3 WHERE NOT EXISTS(SELECT 1 FROM collection_library_destinations d WHERE d.item_key=?1 AND d.target=?2 AND d.selected=0) ON CONFLICT(item_key) DO UPDATE SET destination=excluded.destination,destination_name=excluded.destination_name WHERE destination IS NULL",params![key,id,name]).map_err(|e|e.to_string())?;
    c.execute("INSERT INTO collection_library_destinations(item_key,target,state) VALUES(?1,?2,'saved') ON CONFLICT(item_key,target) DO UPDATE SET state='saved'", params![key,id]).map_err(|e| e.to_string())?;
    Ok(())
}
pub(crate) fn register_root(c: &Connection, root: &Path) -> Result<String, String> {
    let key = crate::library_location::path_key(root);
    let mut q = c
        .prepare("SELECT destination,root FROM collection_roots")
        .map_err(|e| e.to_string())?;
    let rows = q
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (destination, saved) = row.map_err(|e| e.to_string())?;
        if crate::library_location::path_key(Path::new(&saved)) == key {
            return Ok(destination);
        }
    }
    let destination = storage::hash(root.to_string_lossy().as_bytes());
    c.execute("INSERT INTO collection_roots(destination,root) VALUES(?1,?2) ON CONFLICT(destination) DO UPDATE SET root=excluded.root",params![destination,root.to_string_lossy()]).map_err(|e|e.to_string())?;
    Ok(destination)
}
/// Runs in the caller's transaction. Keep existing copy identities and history.
pub(crate) fn relocate_root(c: &Connection, old: &Path, new: &Path) -> Result<(), String> {
    let old_key = crate::library_location::path_key(old);
    let mut q = c
        .prepare("SELECT destination,root FROM collection_roots")
        .map_err(|e| e.to_string())?;
    let rows = q
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(q);
    for (destination, root) in rows {
        if crate::library_location::path_key(Path::new(&root)) == old_key {
            c.execute(
                "UPDATE collection_roots SET root=?1 WHERE destination=?2",
                params![new.to_string_lossy(), destination],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    storage::relocate_vault_preferences(c, old, new)?;
    for table in ["collection_owned_assets", "collection_saved_media"] {
        let mut q = c
            .prepare(&format!("SELECT rowid,path FROM {table}"))
            .map_err(|e| e.to_string())?;
        let rows = q
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        drop(q);
        for (rowid, path) in rows {
            let normalized =
                crate::sources::display_local_path(Path::new(&path)).replace('\\', "/");
            let old_display = crate::sources::display_local_path(old).replace('\\', "/");
            let prefix = format!("{}/", old_display.trim_end_matches('/'));
            #[cfg(windows)]
            let matches = normalized
                .to_lowercase()
                .starts_with(&prefix.to_lowercase());
            #[cfg(not(windows))]
            let matches = normalized.starts_with(&prefix);
            if matches {
                let suffix: PathBuf = Path::new(&normalized)
                    .components()
                    .skip(Path::new(&old_display).components().count())
                    .collect();
                let rewritten = new.join(suffix);
                c.execute(
                    &format!("UPDATE {table} SET path=?1 WHERE rowid=?2"),
                    params![rewritten.to_string_lossy(), rowid],
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

pub(crate) fn track_asset(c: &Connection, key: &str, path: &Path) -> Result<(), String> {
    // Obsidian owns X originals. Hub must never claim deletion ownership of them.
    if crate::data_backup::media_policy::is_x(key) {
        return Ok(());
    }
    let path = crate::data_backup::retain_media(c, path)?;
    c.execute(
        "INSERT OR IGNORE INTO collection_owned_assets(item_key,path) VALUES(?1,?2)",
        params![key, path.to_string_lossy()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
fn register_known_roots(app: &AppHandle, c: &Connection) -> Result<(), String> {
    c.execute("INSERT OR IGNORE INTO collection_owned_assets SELECT item_key,path FROM collection_saved_media m WHERE m.item_key NOT LIKE 'x:%' AND m.item_key NOT LIKE 'x-likes:%' AND m.item_key NOT LIKE 'obsidian:x:%' AND NOT EXISTS(SELECT 1 FROM collection_local_source_items s WHERE s.item_key=m.item_key)",[]).map_err(|e|e.to_string())?;
    let cfg = storage::config(c)?;
    if cfg.mode == "obsidian" {
        if let Ok(root) = fs::canonicalize(&cfg.vault_path) {
            register_root(c, &root)?;
        }
    }
    let local = active_data_root(app)?.join("collection-files");
    if let Ok(root) = fs::canonicalize(local) {
        register_root(c, &root)?;
    }
    let mut statement = c
        .prepare("SELECT location FROM libraries WHERE provider='obsidian'")
        .map_err(|e| e.to_string())?;
    for row in statement
        .query_map([], |r| r.get::<_, Option<String>>(0))
        .map_err(|e| e.to_string())?
    {
        if let Some(path) = row.map_err(|e| e.to_string())? {
            if let Ok(root) = fs::canonicalize(path) {
                register_root(c, &root)?;
            }
        }
    }
    Ok(())
}
pub(crate) fn effective_config(
    c: &Connection,
    key: &str,
    base: &storage::StorageConfig,
) -> Result<storage::StorageConfig, String> {
    // Additional library copies never replace the primary local storage policy.
    let _ = (c, key);
    Ok(base.clone())
}

fn target_config(
    c: &Connection,
    id: &str,
    base: &storage::StorageConfig,
) -> Result<storage::StorageConfig, String> {
    if let Some(hash) = id.strip_prefix("vault:") {
        let root: String = c
            .query_row(
                "SELECT root FROM collection_roots WHERE destination=?1",
                [hash],
                |r| r.get(0),
            )
            .map_err(|_| "旧保存目录尚未识别")?;
        let mut cfg = base.clone();
        cfg.mode = "obsidian".into();
        cfg.vault_path = root;
        return Ok(cfg);
    }
    let (provider, location): (String, Option<String>) = c
        .query_row(
            "SELECT provider,location FROM libraries WHERE id=?1 AND enabled=1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| "资料库已移除，请选择保存位置")?;
    let mut cfg = base.clone();
    if provider == "obsidian" {
        cfg.mode = "obsidian".into();
        cfg.vault_path = location.ok_or("资料库目录不可用")?;
    } else {
        cfg.mode = "database".into();
        cfg.vault_path.clear();
    }
    Ok(cfg)
}
pub(super) fn pin_defaults(c: &Connection, old: &storage::StorageConfig) -> Result<(), String> {
    let destination = if old.mode == "obsidian" {
        // Preserve the old destination while its directory is offline. Changing
        // a default must not silently redirect existing items into a new vault.
        let root =
            fs::canonicalize(&old.vault_path).unwrap_or_else(|_| PathBuf::from(&old.vault_path));
        if !root.is_absolute() {
            return Err("原默认保存目录无效，请先修复保存位置".into());
        }
        format!("vault:{}", register_root(c, &root)?)
    } else {
        "hub".into()
    };
    c.execute("INSERT INTO collection_lifecycle(item_key,destination) SELECT i.item_key,COALESCE((SELECT 'vault:'||e.destination FROM collection_obsidian_exports e WHERE e.item_key=i.item_key ORDER BY e.local_seq DESC LIMIT 1),?1) FROM collection_x_items i WHERE NOT EXISTS(SELECT 1 FROM collection_lifecycle l WHERE l.item_key=i.item_key AND l.destination IS NOT NULL) ON CONFLICT(item_key) DO UPDATE SET destination=excluded.destination",[destination]).map_err(|e|e.to_string())?;
    Ok(())
}
fn exists(c: &Connection, key: &str) -> Result<(), String> {
    if blocked(c, key)? {
        return Err("内容已删除，不能修改或再次保存".into());
    }
    let present: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM collection_x_items WHERE item_key=?1)",
            [key],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if present {
        Ok(())
    } else {
        Err("内容不存在".into())
    }
}
pub(crate) fn blocked_message(
    c: &Connection,
    bot: i64,
    user: i64,
    message: i64,
    channel: &str,
) -> Result<bool, String> {
    c.query_row("SELECT EXISTS(SELECT 1 FROM collection_message_tombstones WHERE bot_id=?1 AND user_id=?2 AND message_id=?3 AND channel=?4)",params![bot,user,message,channel],|r|r.get(0)).map_err(|e|e.to_string())
}
pub(crate) fn deleted_counterpart(
    c: &Connection,
    bot: i64,
    user: i64,
    message: &Value,
    channel: &str,
) -> Result<Option<String>, String> {
    let fingerprint = crate::telegram::tdl::fingerprint(message);
    c.query_row("SELECT item_key FROM collection_message_tombstones WHERE bot_id=?1 AND user_id=?2 AND fingerprint=?3 AND channel<>?4 LIMIT 1",params![bot,user,fingerprint,channel],|r|r.get(0)).optional().map_err(|e|e.to_string())
}
#[tauri::command]
pub(crate) async fn confirm_collection_migration_cleanup(
    app: AppHandle,
    key: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        confirm_collection_migration_cleanup_blocking(app, key)
    })
    .await
    .map_err(|e| e.to_string())?
}
pub(crate) fn confirm_collection_migration_cleanup_blocking(
    app: AppHandle,
    key: String,
) -> Result<(), String> {
    let (c, _writer) = open_write_database(&database_path(&app)?)?;
    schema(&c)?;
    exists(&c, &key)?;
    let changed=c.execute("UPDATE collection_library_jobs SET cleanup_force=1,error='' WHERE item_key=?1 AND action='move' AND phase='cleanup' AND error LIKE '旧页面有手动修改%'",[&key]).map_err(|e|e.to_string())?;
    if changed != 1 {
        return Err("没有等待确认的旧副本清理".into());
    }
    kick(app);
    Ok(())
}
#[tauri::command]
pub(crate) async fn collection_delete_preview(
    app: AppHandle,
    key: String,
    migration: Option<bool>,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        collection_delete_preview_blocking(app, key, migration)
    })
    .await
    .map_err(|e| e.to_string())?
}
pub(crate) fn collection_delete_preview_blocking(
    app: AppHandle,
    key: String,
    migration: Option<bool>,
) -> Result<Vec<String>, String> {
    let (c, _writer) = open_write_database(&database_path(&app)?)?;
    storage::schema(&c)?;
    exists(&c, &key)?;
    register_known_roots(&app, &c)?;
    let target: Option<String> = if migration.unwrap_or(false) {
        c.query_row(
            "SELECT target FROM collection_library_jobs WHERE item_key=?1",
            [&key],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
    } else {
        None
    };
    let keep = collection_cleanup_keep_destination(&c, target.as_deref())?;
    let mut result = Vec::new();
    let mut s=c.prepare("SELECT COALESCE(r.root,'未识别的 Obsidian 目录'),e.relative_path FROM collection_obsidian_exports e LEFT JOIN collection_roots r ON e.destination=r.destination WHERE e.item_key=?1 AND (?2 IS NULL OR e.destination<>?2)").map_err(|e|e.to_string())?;
    for row in s
        .query_map(params![key, keep], |r| {
            Ok(format!(
                "{} / {}",
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?
            ))
        })
        .map_err(|e| e.to_string())?
    {
        result.push(row.map_err(|e| e.to_string())?);
    }
    let mut s=c.prepare("SELECT COALESCE(l.name,r.library_id),r.object_id FROM collection_remote_copies r LEFT JOIN libraries l ON l.id=r.library_id WHERE r.item_key=?1 AND r.parent_id<>'attachment' AND (?2 IS NULL OR r.library_id<>?2)").map_err(|e|e.to_string())?;
    for row in s
        .query_map(params![key, target], |r| {
            Ok(format!(
                "{} / {}",
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?
            ))
        })
        .map_err(|e| e.to_string())?
    {
        result.push(row.map_err(|e| e.to_string())?);
    }
    Ok(result)
}
fn collection_cleanup_keep_destination(
    c: &Connection,
    target: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(target) = target.filter(|target| *target != "hub") else {
        return Ok(None);
    };
    let cfg = target_config(c, target, &storage::config(c)?)?;
    if cfg.mode != "obsidian" {
        return Ok(None);
    }
    let root = fs::canonicalize(&cfg.vault_path).map_err(|e| e.to_string())?;
    Ok(Some(register_root(c, &root)?))
}
#[tauri::command]
pub(crate) async fn set_collection_lifecycle(
    app: AppHandle,
    key: String,
    state: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || set_collection_lifecycle_blocking(app, key, state))
        .await
        .map_err(|e| e.to_string())?
}
pub(crate) fn set_collection_lifecycle_blocking(
    app: AppHandle,
    key: String,
    state: String,
) -> Result<String, String> {
    if cfg!(mobile) && state == "deleting" {
        return Err("请在桌面端删除阅读条目及其资料库副本；手机端可归档".into());
    }
    if !matches!(state.as_str(), "active" | "archived" | "deleting") {
        return Err("未知状态".into());
    }
    let (c, _writer) = open_write_database(&database_path(&app)?)?;
    storage::schema(&c)?;
    exists(&c, &key)?;
    register_known_roots(&app, &c)?;
    if state == "deleting" {
        let unknown:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM collection_library_jobs WHERE item_key=?1 AND phase='unknown')",[&key],|r|r.get(0)).map_err(|e|e.to_string())?;
        if unknown {
            return Err(
                "上次外部写入结果未知，请先在处理方案中关联实际页面或任务，才能完整清理".into(),
            );
        }
    }
    let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO collection_lifecycle(item_key,state,revision) VALUES(?1,?2,1) ON CONFLICT(item_key) DO UPDATE SET state=excluded.state,revision=revision+1",params![key,state]).map_err(|e|e.to_string())?;
    if state == "deleting" {
        tx.execute(
            "DELETE FROM collection_library_destinations WHERE item_key=?1",
            [&key],
        )
        .map_err(|e| e.to_string())?;
        remember_messages(&tx, &key)?;
        purge_body(&tx, &key)?;
        tx.execute("INSERT INTO collection_library_jobs(item_key,action,phase,updated_at) VALUES(?1,'delete','queued',?2) ON CONFLICT(item_key) DO UPDATE SET action='delete',target='',phase='queued',error='',plan='',updated_at=excluded.updated_at",params![key,now_timestamp()]).map_err(|e|e.to_string())?;
        for table in ["collection_x_outbox", "collection_property_updates"] {
            tx.execute(&format!("DELETE FROM {table} WHERE item_key=?1"), [&key])
                .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    if state == "deleting" {
        kick(app);
        Ok("已移出数据库，正在清理已保存的页面和附件".into())
    } else {
        Ok(if state == "archived" {
            "已归档"
        } else {
            "已恢复到收藏与待读"
        }
        .into())
    }
}
#[tauri::command]
pub(crate) async fn collection_library_operations(app: AppHandle) -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || collection_library_operations_blocking(app))
        .await
        .map_err(|e| e.to_string())?
}
pub(crate) fn collection_library_operations_blocking(app: AppHandle) -> Result<Vec<Value>, String> {
    let c = open_database(&database_path(&app)?)?;
    stored_operations(&c)
}
fn stored_operations(c: &Connection) -> Result<Vec<Value>, String> {
    let mut s=c.prepare("SELECT item_key,action,target,phase,error,plan,detail,0 AS parked,updated_at FROM collection_library_jobs WHERE action<>'move' OR NOT EXISTS(SELECT 1 FROM collection_library_destinations d WHERE d.item_key=collection_library_jobs.item_key AND d.target=collection_library_jobs.target AND d.selected=0) UNION ALL SELECT item_key,action,target,phase,error,plan,detail,1 AS parked,updated_at FROM collection_library_pending WHERE action<>'move' OR NOT EXISTS(SELECT 1 FROM collection_library_destinations d WHERE d.item_key=collection_library_pending.item_key AND d.target=collection_library_pending.target AND d.selected=0) ORDER BY updated_at DESC LIMIT 100").map_err(|e|e.to_string())?;
    let result=s.query_map([],|r|Ok(json!({"key":r.get::<_,String>(0)?,"action":r.get::<_,String>(1)?,"target":r.get::<_,String>(2)?,"phase":r.get::<_,String>(3)?,"error":r.get::<_,String>(4)?,"plan":serde_json::from_str::<Value>(&r.get::<_,String>(5)?).unwrap_or(Value::Null),"detail":r.get::<_,String>(6)?,"parked":r.get::<_,bool>(7)?,"updatedAt":r.get::<_,i64>(8)?}))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string());
    result.map(|mut operations| {
        for operation in &mut operations {
            operation_error(operation);
            operation_context(c, operation);
        }
        operations
    })
}
#[tauri::command]
pub(crate) async fn retry_collection_library_operation(
    app: AppHandle,
    key: String,
    expected_target: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        retry_collection_library_operation_blocking(app, key, expected_target)
    })
    .await
    .map_err(|e| e.to_string())?
}
pub(crate) fn retry_collection_library_operation_blocking(
    app: AppHandle,
    key: String,
    expected_target: Option<String>,
) -> Result<(), String> {
    if cfg!(mobile) {
        return Err("请在桌面端管理资料库副本".into());
    }
    let (c, _writer) = open_write_database(&database_path(&app)?)?;
    schema(&c)?;
    retry_operation(&c, &key, expected_target.as_deref())?;
    kick(app);
    Ok(())
}
fn retry_operation(c: &Connection, key: &str, expected_target: Option<&str>) -> Result<(), String> {
    let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
    let target: Option<String> = tx
        .query_row(
            "SELECT target FROM collection_library_jobs WHERE item_key=?1",
            [key],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    conversion::check_expected_target(expected_target, target.as_deref())?;
    let target = target.ok_or("记录已取消、正在写入或结果未知，请通过保存位置发起新方案")?;
    let changed=tx.execute("UPDATE collection_library_jobs SET phase=CASE WHEN phase='cleanup' AND error LIKE '目标附件%' THEN CASE WHEN plan<>'' THEN 'needs_review' ELSE 'queued' END WHEN phase='cleanup' THEN 'cleanup' WHEN plan<>'' AND action='move' THEN 'needs_review' ELSE 'queued' END,error='',updated_at=?2 WHERE item_key=?1 AND target=?3 AND phase NOT IN ('writing','unknown','cancelled')",params![key,now_timestamp(),target]).map_err(|e|e.to_string())?;
    if changed == 0 {
        return Err("记录已取消、正在写入或结果未知，请通过保存位置发起新方案".into());
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
pub(crate) async fn move_collection_to_library(
    app: AppHandle,
    key: String,
    destination: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        move_collection_to_library_blocking(app, key, destination)
    })
    .await
    .map_err(|e| e.to_string())?
}
pub(crate) fn move_collection_to_library_blocking(
    app: AppHandle,
    key: String,
    destination: String,
) -> Result<String, String> {
    if cfg!(mobile) {
        return Err("请在桌面端管理资料库副本".into());
    }
    let (c, _writer) = open_write_database(&database_path(&app)?)?;
    storage::schema(&c)?;
    exists(&c, &key)?;
    register_known_roots(&app, &c)?;
    let resolved = resolve_move_target(&c, &destination)?;
    if resolved != "hub" && !(destination == "default" && resolved.starts_with("vault:")) {
        let provider: String = c
            .query_row(
                "SELECT provider FROM libraries WHERE id=?1 AND enabled=1",
                [&resolved],
                |r| r.get(0),
            )
            .map_err(|_| "请选择已添加的资料库")?;
        if !matches!(provider.as_str(), "obsidian" | "craft" | "dida365") {
            return Err("此资料库暂不支持收藏写入".into());
        }
    }
    queue_library_move(&c, &key, &resolved)?;
    drop(_writer);
    kick(app);
    Ok("已加入复制队列，默认本地页面和附件会保留".into())
}
fn queue_library_move(c: &Connection, key: &str, destination: &str) -> Result<(), String> {
    c.execute("INSERT INTO collection_library_destinations(item_key,target,state,selected) VALUES(?1,?2,'queued',1) ON CONFLICT(item_key,target) DO UPDATE SET selected=1", params![key,destination]).map_err(|e|e.to_string())?;
    pending::request_retry(c, key, destination)?;
    promote_copy_requests(c)?;
    Ok(())
}
#[tauri::command]
pub(crate) async fn remove_collection_library_destination(
    app: AppHandle,
    key: String,
    destination: String,
) -> Result<String, String> {
    if cfg!(mobile) {
        return Err("请在桌面端管理资料库副本".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let (c, writer) = open_write_database(&database_path(&app)?)?;
        storage::schema(&c)?;
        selection::remove(&c, &key, &destination)?;
        drop(writer);
        kick(app);
        Ok("已取消此资料库选择，已保存的副本和附件保留".into())
    })
    .await
    .map_err(|e| e.to_string())?
}
fn promote_copy_requests(c: &Connection) -> Result<(), String> {
    c.execute_batch("SAVEPOINT collection_promote")
        .map_err(|e| e.to_string())?;
    let result = promote_copy_requests_inner(c);
    if result.is_err() {
        let _ = c.execute_batch("ROLLBACK TO collection_promote");
    }
    c.execute_batch("RELEASE collection_promote")
        .map_err(|e| e.to_string())?;
    result
}
fn promote_copy_requests_inner(c: &Connection) -> Result<(), String> {
    pending::yield_blocked(c)?;
    c.execute("DELETE FROM collection_library_jobs WHERE phase='cancelled' AND inflight=0 AND (EXISTS(SELECT 1 FROM collection_library_destinations d WHERE d.item_key=collection_library_jobs.item_key AND d.target=collection_library_jobs.target AND d.selected=0) OR EXISTS(SELECT 1 FROM collection_library_destinations d WHERE d.item_key=collection_library_jobs.item_key AND d.state='queued' AND d.selected=1))", []).map_err(|e| e.to_string())?;
    c.execute("INSERT INTO collection_library_jobs(item_key,action,target,updated_at) SELECT d.item_key,'move',d.target,?1 FROM collection_library_destinations d WHERE d.state='queued' AND d.selected=1 AND d.local_seq=(SELECT MIN(q.local_seq) FROM collection_library_destinations q WHERE q.item_key=d.item_key AND q.state='queued' AND q.selected=1) AND NOT EXISTS(SELECT 1 FROM collection_library_jobs j WHERE j.item_key=d.item_key) AND NOT EXISTS(SELECT 1 FROM collection_lifecycle l WHERE l.item_key=d.item_key AND l.state IN ('deleted','deleting'))", [now_timestamp()]).map_err(|e| e.to_string())?;
    pending::restore_requested(c)?;
    Ok(())
}
pub(crate) fn complete_copy(c: &Connection, key: &str, target: &str) -> Result<(), String> {
    let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
    let current: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM collection_library_jobs j WHERE j.item_key=?1 AND j.target=?2 AND j.action='move' AND j.phase<>'cancelled' AND NOT EXISTS(SELECT 1 FROM collection_library_destinations d WHERE d.item_key=j.item_key AND d.target=j.target AND d.selected=0) AND NOT EXISTS(SELECT 1 FROM collection_lifecycle l WHERE l.item_key=j.item_key AND l.state IN ('deleted','deleting')))",params![key,target],|r|r.get(0)).map_err(|e| e.to_string())?;
    if !current {
        return Err("保存请求已改变，已保留现有副本关联".into());
    }
    tx.execute("INSERT INTO collection_library_destinations(item_key,target,state) VALUES(?1,?2,'saved') ON CONFLICT(item_key,target) DO UPDATE SET state='saved'",params![key,target]).map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM collection_library_jobs WHERE item_key=?1 AND target=?2",
        params![key, target],
    )
    .map_err(|e| e.to_string())?;
    promote_copy_requests(&tx)?;
    tx.commit().map_err(|e| e.to_string())
}

fn claim_dispatch(
    c: &Connection,
    key: &str,
    action: &str,
    target: &str,
    automatic: bool,
) -> Result<bool, String> {
    let changed = c.execute("UPDATE collection_library_jobs SET inflight=1 WHERE item_key=?1 AND action=?2 AND target=?3 AND inflight=0 AND phase<>'cancelled' AND (?4=0 OR (phase IN ('queued','cleanup','ready') AND error='' AND CASE WHEN json_valid(plan) THEN COALESCE(json_extract(plan,'$.agentActionId'),'')='' ELSE 1 END)) AND (action<>'move' OR NOT EXISTS(SELECT 1 FROM collection_library_destinations d WHERE d.item_key=collection_library_jobs.item_key AND d.target=collection_library_jobs.target AND d.selected=0))",params![key,action,target,automatic]).map_err(|e|e.to_string())?;
    Ok(changed == 1)
}
pub(super) fn begin_copy_dispatch(app: &AppHandle, key: &str, target: &str) -> Result<(), String> {
    let (c, _writer) = open_write_database(&database_path(app)?)?;
    if claim_dispatch(&c, key, "move", target, false)? {
        Ok(())
    } else {
        Err("此保存请求已取消或已改变，请重新打开处理记录".into())
    }
}
fn release_dispatch(c: &Connection, key: &str, target: &str) -> Result<(), String> {
    c.execute(
        "UPDATE collection_library_jobs SET inflight=0 WHERE item_key=?1 AND target=?2",
        params![key, target],
    )
    .map_err(|e| e.to_string())?;
    promote_copy_requests(c)
}
pub(super) fn finish_copy_dispatch(app: &AppHandle, key: &str, target: &str) -> Result<(), String> {
    let (c, _writer) = open_write_database(&database_path(app)?)?;
    release_dispatch(&c, key, target)?;
    WORKER_WAKE.notify_one();
    Ok(())
}

fn job_detail(app: &AppHandle, key: &str, detail: &str) -> Result<(), String> {
    control::phase("collection", detail)?;
    let (c, _writer) = open_write_database(&database_path(app)?)?;
    let changed = c
        .execute(
            "UPDATE collection_library_jobs SET detail=?2 WHERE item_key=?1 AND phase<>'cancelled'",
            params![key, detail],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        Err("保存请求已取消或已改变".into())
    } else {
        Ok(())
    }
}
fn job_phase(app: &AppHandle, key: &str, phase: &str, error: &str) -> Result<(), String> {
    control::phase(phase, "保存收藏副本")?;
    let (c, _writer) = open_write_database(&database_path(app)?)?;
    let changed = c.execute(
        "UPDATE collection_library_jobs SET phase=?2,error=?3,updated_at=?4 WHERE item_key=?1 AND phase<>'cancelled'",
        params![key, phase, error, now_timestamp()],
    )
    .map_err(|e| e.to_string())?;
    if changed == 0 {
        Err("保存请求已取消或已改变".into())
    } else {
        Ok(())
    }
}
pub(crate) fn remember_messages(c: &Connection, key: &str) -> Result<(), String> {
    for (table, user, channel) in [
        ("collection_telegram_messages", "chat_id", "bot"),
        ("collection_telegram_tdl_messages", "user_id", "tdl"),
    ] {
        let present: bool = c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name=?1)",
                [table],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if present {
            c.execute(&format!("INSERT OR IGNORE INTO collection_message_tombstones(bot_id,user_id,message_id,channel,item_key) SELECT bot_id,{user},message_id,'{channel}',item_key FROM {table} WHERE item_key=?1"),[key]).map_err(|e|e.to_string())?;
            let rows = {
                let mut q=c.prepare(&format!("SELECT bot_id,{user},message_id,message_json FROM {table} WHERE item_key=?1")).map_err(|e|e.to_string())?;
                let result = q
                    .query_map([key], |r| {
                        Ok((
                            r.get::<_, i64>(0)?,
                            r.get::<_, i64>(1)?,
                            r.get::<_, i64>(2)?,
                            r.get::<_, String>(3)?,
                        ))
                    })
                    .map_err(|e| e.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?;
                result
            };
            for (bot, user, id, raw) in rows {
                if let Ok(message) = serde_json::from_str::<Value>(&raw) {
                    c.execute("UPDATE collection_message_tombstones SET fingerprint=?5 WHERE bot_id=?1 AND user_id=?2 AND message_id=?3 AND channel=?4",params![bot,user,id,channel,crate::telegram::tdl::fingerprint(&message)]).map_err(|e|e.to_string())?;
                }
            }
        }
    }
    Ok(())
}
pub(crate) fn purge_body(c: &Connection, key: &str) -> Result<(), String> {
    for table in [
        "collection_x_items",
        "collection_x_properties",
        "collection_x_enrichment",
        "collection_property_updates",
        "collection_x_outbox",
        "collection_telegram_messages",
        "collection_telegram_tdl_messages",
        "collection_library_pending",
    ] {
        let present: bool = c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                [table],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if present {
            c.execute(&format!("DELETE FROM {table} WHERE item_key=?1"), [key])
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
// Only dispatch is serialized; the permits reserve each operation's actual libraries.
static WORKER: AtomicBool = AtomicBool::new(false);
static WORKER_WAKE: tokio::sync::Notify = tokio::sync::Notify::const_new();
pub(crate) fn kick(app: AppHandle) {
    if WORKER.swap(true, Ordering::SeqCst) {
        WORKER_WAKE.notify_one();
        return;
    }
    tauri::async_runtime::spawn(async move {
        let jobs = (|| -> Result<Vec<(String, String, String)>, String> {
                let (c, _writer) = open_write_database(&database_path(&app)?)?;
                storage::schema(&c)?;
                register_known_roots(&app, &c)?;
                promote_copy_requests(&c)?;
                queue_automatic_saves(&c)?;
                let mut q = c.prepare("SELECT item_key,action,target FROM collection_library_jobs WHERE phase IN ('queued','cleanup','ready') AND error='' AND CASE WHEN json_valid(plan) THEN COALESCE(json_extract(plan,'$.agentActionId'),'')='' ELSE 1 END ORDER BY updated_at,item_key").map_err(|e| e.to_string())?;
                let rows = q.query_map([], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|e| e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?;
                Ok(rows)
        })().unwrap_or_default();
        for (key, action, target) in jobs {
            if action != "delete" && control::gate_target(&app, &target).is_err() {
                // Paused targets remain queued; restoring a library admits the same job.
                continue;
            }
            let permit = (|| {
                let c = open_database(&database_path(&app)?)?;
                queue::try_acquire(&c, &key)
            })();
            let permit = match permit {
                Ok(Some(permit)) => permit,
                Ok(None) => continue,
                Err(error) => {
                    if let Ok(path) = database_path(&app) {
                        if let Ok((c, _writer)) = open_write_database(&path) {
                            let _ = c.execute("UPDATE collection_library_jobs SET error=?2,phase=CASE WHEN phase='cleanup' THEN phase ELSE 'failed' END WHERE item_key=?1 AND phase IN ('queued','ready','cleanup')", params![key,error]);
                        }
                    }
                    continue;
                }
            };
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _permit = permit;
                // Recheck the dispatch snapshot after reserving; a cancellation may have won.
                let current = database_path(&app)
                    .ok()
                    .and_then(|p| open_write_database(&p).ok())
                    .and_then(|(c, _writer)| claim_dispatch(&c, &key, &action, &target, true).ok())
                    .unwrap_or(false);
                if !current {
                    return;
                }
                let result = if action == "delete" {
                    delete_item(&app, &key).await
                } else {
                    copy_item(&app, &key, &target).await
                };
                if let Err(error) = result {
                    if let Ok(path) = database_path(&app) {
                        if let Ok((c, _writer)) = open_write_database(&path) {
                            if crate::library_runtime::is_control_error(&error) {
                                let _ = c.execute("UPDATE collection_library_jobs SET error='',phase=CASE WHEN json_valid(plan) AND json_extract(plan,'$.status')='planned' THEN 'ready' ELSE 'queued' END,detail=?2 WHERE item_key=?1 AND target=?3 AND action='move' AND phase<>'cancelled'", params![key,error,target]);
                            } else {
                                let _=c.execute("UPDATE collection_library_jobs SET error=?2,phase=CASE WHEN phase IN ('queued','ready','planning','saving') THEN 'failed' ELSE phase END,updated_at=?3 WHERE item_key=?1 AND action=?4 AND target=?5 AND phase<>'cancelled'",params![key,error,now_timestamp(),action,target]);
                            }
                        }
                    }
                }
                // Always release after the result, including controlled stops and errors.
                let _ = finish_copy_dispatch(&app, &key, &target);
            });
        }
        WORKER.store(false, Ordering::SeqCst);
        // Permit release wakes the dispatcher. Do not spin on queued, busy libraries.
    });
}
pub(crate) fn start_worker(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Ok(path) = database_path(&app) {
            if let Ok((c, _writer)) = open_write_database(&path) {
                if schema(&c).is_ok() {
                    let _ = c.execute("UPDATE collection_library_jobs SET inflight=0", []);
                    let _=c.execute("UPDATE collection_library_jobs SET phase='queued' WHERE phase IN ('planning','saving')",[]);
                    let _=c.execute("UPDATE collection_library_jobs SET phase='unknown',error='上次写入中断，请核对目标资料库后处理，避免重复创建' WHERE phase='writing' AND action='move'",[]);
                    let _ = upgrade_unwritten_craft_plans(&c);
                    let _ = c.execute("UPDATE collection_library_jobs SET error='',detail='核验完成，记录已保存副本' WHERE action='move' AND phase='cleanup' AND (error='' OR error LIKE '旧页面有手动修改%')", []);
                }
            }
        }
        while crate::background_workers::running() {
            if !WORKER.load(Ordering::SeqCst) {
                kick(app.clone());
            }
            tokio::select! {
                running = crate::background_workers::wait(Duration::from_secs(15)) => { if !running { break; } },
                _ = WORKER_WAKE.notified() => {},
            }
        }
    });
}
// Resolve for cleanup without creating directories. Reject junctions, symlinks and parent traversal.
fn owned_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.is_empty()
        || relative.contains('\\')
        || relative.contains(':')
        || relative
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
    {
        return Err("保存路径无效，未删除文件".into());
    }
    let canonical = fs::canonicalize(root).map_err(|_| "保存目录离线，清理将在重试后继续")?;
    let mut path = canonical.clone();
    for part in relative.split('/') {
        path.push(part);
        if path.exists() {
            let resolved = fs::canonicalize(&path).map_err(|e| e.to_string())?;
            if !resolved.starts_with(&canonical) {
                return Err("文件已移动到资料库之外，未删除".into());
            }
            path = resolved;
        }
    }
    Ok(path)
}
fn remove_file(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("无法删除 {}：{e}", path.display())),
    }
}
fn cleanup_notes(c: &Connection, key: &str, keep: Option<&str>) -> Result<(), String> {
    let mut s=c.prepare("SELECT e.destination,e.relative_path,r.root,e.file_hash FROM collection_obsidian_exports e LEFT JOIN collection_roots r ON r.destination=e.destination WHERE e.item_key=?1 AND (?2 IS NULL OR e.destination<>?2)").map_err(|e|e.to_string())?;
    let rows = s
        .query_map(params![key, keep], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    for (destination, relative, root, expected) in rows {
        let original:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM collection_local_source_files WHERE destination=?1 AND relative_path=?2)",params![destination,relative],|r|r.get(0)).map_err(|e|e.to_string())?;
        if original {
            continue;
        }
        let root = root.ok_or("旧 Obsidian 目录尚未识别，请重新添加该资料库后重试")?;
        let path = owned_path(Path::new(&root), &relative)?;
        let deleting = blocked(c, key)?;
        let force: bool = c
            .query_row(
                "SELECT cleanup_force FROM collection_library_jobs WHERE item_key=?1",
                [key],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or(false);
        if !deleting
            && !force
            && path.is_file()
            && storage::hash(&fs::read(&path).map_err(|e| e.to_string())?) != expected
        {
            return Err("旧页面有手动修改，已保留两个副本；请核对后重试迁移".into());
        }
        remove_file(&path)?;
        let has_libraries: bool = c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='libraries')",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if has_libraries {
            let mut q = c
                .prepare("SELECT id,location FROM libraries WHERE provider='obsidian'")
                .map_err(|e| e.to_string())?;
            for row in q
                .query_map([], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
                })
                .map_err(|e| e.to_string())?
            {
                let (id, location) = row.map_err(|e| e.to_string())?;
                if location.is_some_and(|p| {
                    fs::canonicalize(p)
                        .is_ok_and(|p| fs::canonicalize(&root).is_ok_and(|root| root == p))
                }) {
                    let has_documents: bool = c
                        .query_row(
                            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='documents')",
                            [],
                            |r| r.get(0),
                        )
                        .map_err(|e| e.to_string())?;
                    if has_documents {
                        let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
                        delete_obsidian_document(
                            &tx,
                            &id,
                            &obsidian_document_id(&relative),
                            now_timestamp(),
                        )?;
                        tx.commit().map_err(|e| e.to_string())?;
                    }
                }
            }
        }
        c.execute(
            "DELETE FROM collection_obsidian_exports WHERE item_key=?1 AND destination=?2",
            params![key, destination],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn referenced_assets(root: &Path, relatives: &[String]) -> HashSet<String> {
    let mut referenced = HashSet::new();
    let unknown = || relatives.iter().cloned().collect::<HashSet<_>>();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let Ok(entries) = fs::read_dir(directory) else {
            return unknown();
        };
        for entry in entries {
            let Ok(entry) = entry else {
                return unknown();
            };
            let Ok(kind) = entry.file_type() else {
                return unknown();
            };
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                if matches!(entry.file_name().to_str(), Some(".obsidian" | ".git")) {
                    continue;
                }
                let Ok(path) = fs::canonicalize(entry.path()) else {
                    return unknown();
                };
                if !path.starts_with(root) {
                    continue;
                }
                pending.push(path);
            } else if kind.is_file() && entry.path().extension().is_some_and(|v| v == "md") {
                let Ok(text) = fs::read_to_string(entry.path()) else {
                    return unknown();
                };
                for relative in relatives {
                    let name = Path::new(relative)
                        .file_name()
                        .and_then(|p| p.to_str())
                        .unwrap_or(relative);
                    if text.contains(relative) || text.contains(name) {
                        referenced.insert(relative.clone());
                    }
                }
                if referenced.len() == relatives.len() {
                    return referenced;
                }
            }
        }
    }
    referenced
}
fn remove_unreferenced_assets(
    c: &Connection,
    key: &str,
    keep_root: Option<&Path>,
) -> Result<Vec<String>, String> {
    let roots = {
        let mut s = c
            .prepare("SELECT root FROM collection_roots")
            .map_err(|e| e.to_string())?;
        let v = s
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        v
    };
    let paths = {
        let mut s = c
            .prepare("SELECT path FROM collection_owned_assets WHERE item_key=?1 AND NOT EXISTS(SELECT 1 FROM collection_local_source_items s WHERE s.item_key=collection_owned_assets.item_key)")
            .map_err(|e| e.to_string())?;
        let v = s
            .query_map([key], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        v
    };
    let roots = roots
        .iter()
        .filter_map(|root| fs::canonicalize(root).ok())
        .collect::<Vec<_>>();
    let mut candidates: HashMap<PathBuf, Vec<(String, PathBuf)>> = HashMap::new();
    for raw in &paths {
        let path = Path::new(raw);
        if keep_root.is_some_and(|root| path.starts_with(root)) {
            continue;
        }
        let shared:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM collection_owned_assets WHERE path=?1 AND item_key<>?2)",params![raw,key],|r|r.get(0)).map_err(|e|e.to_string())?;
        if !shared && path.exists() {
            let root = roots
                .iter()
                .filter(|r| path.starts_with(r))
                .max_by_key(|r| r.components().count())
                .ok_or("附件目录尚未识别，未删除目录外文件")?;
            let relative = path
                .strip_prefix(&root)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            if !(relative.starts_with("99_Meta/assets/X_assets/")
                || relative.starts_with("99_Meta/assets/Telegram_assets/"))
            {
                return Err("附件不在收集专用目录，未删除".into());
            }
            let resolved = owned_path(&root, &relative)?;
            candidates
                .entry(root.clone())
                .or_default()
                .push((relative, resolved));
        }
    }
    for (root, entries) in candidates {
        let relatives = entries
            .iter()
            .map(|(relative, _)| relative.clone())
            .collect::<Vec<_>>();
        let referenced = referenced_assets(&root, &relatives);
        for (relative, resolved) in entries {
            if !referenced.contains(&relative) {
                remove_file(&resolved)?;
            }
        }
    }
    Ok(paths
        .into_iter()
        .filter(|raw| !keep_root.is_some_and(|root| Path::new(raw).starts_with(root)))
        .collect())
}
fn forget_assets(c: &Connection, key: &str, paths: &[String]) -> Result<(), String> {
    for raw in paths {
        c.execute(
            "DELETE FROM collection_saved_media WHERE item_key=?1 AND path=?2",
            params![key, raw],
        )
        .map_err(|e| e.to_string())?;
        c.execute(
            "DELETE FROM collection_owned_assets WHERE item_key=?1 AND path=?2",
            params![key, raw],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[cfg(test)]
fn cleanup_assets(c: &Connection, key: &str, keep_root: Option<&Path>) -> Result<(), String> {
    let paths = remove_unreferenced_assets(c, key, keep_root)?;
    forget_assets(c, key, &paths)
}
fn delete_local_item(app: &AppHandle, key: &str) -> Result<(), String> {
    let path = database_path(app)?;
    {
        let (c, _writer) = open_write_database(&path)?;
        cleanup_notes(&c, key, None)?;
    }
    let paths = remove_unreferenced_assets(&open_database(&path)?, key, None)?;
    let (c, _writer) = open_write_database(&path)?;
    let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
    forget_assets(&tx, key, &paths)?;
    purge_body(&tx, key)?;
    tx.commit().map_err(|e| e.to_string())
}
async fn delete_item(app: &AppHandle, key: &str) -> Result<(), String> {
    job_phase(app, key, "cleanup", "")?;
    {
        let _source_guard = FILES_LOCK.lock().await;
        let app = app.clone();
        let key = key.to_owned();
        tauri::async_runtime::spawn_blocking(move || delete_local_item(&app, &key))
            .await
            .map_err(|e| e.to_string())??;
    }
    conversion::cleanup_remote(app, key, None).await?;
    let (c, _writer) = open_write_database(&database_path(app)?)?;
    let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE collection_lifecycle SET state='deleted',destination=NULL WHERE item_key=?1",
        [key],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM collection_library_jobs WHERE item_key=?1",
        [key],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}
fn verify_assets(c: &Connection, key: &str, post: &Post, root: &Path) -> Result<(), String> {
    for media in threads::assets(post) {
        let path: Option<String> = c
            .query_row(
                "SELECT path FROM collection_saved_media WHERE item_key=?1 AND media_url=?2",
                params![key, media.url],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let available = match path {
            Some(path) => saved_asset_at(c, key, Path::new(&path), root)?,
            None => false,
        };
        if !available {
            return Err("目标附件尚未完整保存，保留原页面和附件，请补写后重试".into());
        }
    }
    Ok(())
}
fn saved_asset_at(c: &Connection, key: &str, latest: &Path, root: &Path) -> Result<bool, String> {
    let valid = |path: &Path| fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.len() > 0);
    if latest.starts_with(root) {
        return Ok(valid(latest));
    }
    // A later default export may update the preview pointer while another vault copy remains valid.
    let mut query = c
        .prepare("SELECT root FROM collection_roots")
        .map_err(|e| e.to_string())?;
    let roots = query
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let Some(source) = roots
        .iter()
        .map(Path::new)
        .filter(|source| latest.starts_with(source))
        .max_by_key(|source| source.components().count())
    else {
        return Ok(false);
    };
    let relative = latest
        .strip_prefix(source)
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    let candidate = owned_path(root, &relative)?;
    let owned: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM collection_owned_assets WHERE item_key=?1 AND path=?2)",
            params![key, candidate.to_string_lossy()],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(owned && valid(&candidate))
}
async fn copy_item(app: &AppHandle, key: &str, target: &str) -> Result<(), String> {
    control::scope(app, target, copy_item_inner(app, key, target)).await
}
async fn copy_item_inner(app: &AppHandle, key: &str, target: &str) -> Result<(), String> {
    let (mut cfg, provider, phase) = {
        let (c, _writer) = open_write_database(&database_path(app)?)?;
        exists(&c, key)?;
        let base = storage::config(&c)?;
        let phase: String = c
            .query_row(
                "SELECT phase FROM collection_library_jobs WHERE item_key=?1",
                [key],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if target == "hub" {
            let mut cfg = base;
            cfg.mode = "database".into();
            cfg.vault_path.clear();
            (cfg, "hub".to_string(), phase)
        } else if target.starts_with("vault:") {
            (
                target_config(&c, target, &base)?,
                "obsidian".to_string(),
                phase,
            )
        } else {
            let provider = c
                .query_row(
                    "SELECT provider FROM libraries WHERE id=?1 AND enabled=1",
                    [target],
                    |r| r.get::<_, String>(0),
                )
                .map_err(|_| "资料库已移除")?;
            (target_config(&c, target, &base)?, provider, phase)
        }
    };
    cfg.download_media = control::outgoing_enabled(app, target, &provider)?;
    if matches!(provider.as_str(), "craft" | "dida365") && phase == "ready" {
        return conversion::resume_automatic_save(app, key).await;
    }
    if matches!(provider.as_str(), "craft" | "dida365") && phase != "cleanup" {
        return conversion::prepare(app, key, target, &provider).await;
    }
    job_detail(app, key, "保存本地页面和附件")?;
    if phase != "cleanup" {
        job_phase(app, key, "saving", "")?;
        storage::export_one(app, key, cfg.clone()).await?;
        let (c, _writer) = open_write_database(&database_path(app)?)?;
        exists(&c, key)?;
        let root = if provider == "obsidian" {
            fs::canonicalize(&cfg.vault_path).map_err(|e| e.to_string())?
        } else {
            fs::canonicalize(active_data_root(app)?.join("collection-files"))
                .map_err(|e| e.to_string())?
        };
        let raw: String = c
            .query_row(
                "SELECT post_json FROM collection_x_items WHERE item_key=?1",
                [key],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let post: Post = serde_json::from_str(&raw).map_err(|_| "内容损坏")?;
        if cfg.download_media {
            verify_assets(&c, key, &post, &root)?;
        }
        if provider == "obsidian" {
            let destination = register_root(&c, &root)?;
            let (relative,pending):(String,i64)=c.query_row("SELECT relative_path,media_pending FROM collection_obsidian_exports WHERE destination=?1 AND item_key=?2",params![destination,key],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|_|"目标页面未写入，保留原保存位置")?;
            if pending != 0 || !owned_path(&root, &relative)?.is_file() {
                return Err("页面或附件尚未完整保存，保留原保存位置".into());
            }
        }
        drop(_writer);
        drop(c);
        job_phase(app, key, "cleanup", "")?;
    }
    finish_copy(app, key, target, &cfg).await
}
pub(super) async fn finish_copy(
    app: &AppHandle,
    key: &str,
    target: &str,
    cfg: &storage::StorageConfig,
) -> Result<(), String> {
    if cfg.mode == "obsidian" || target == "hub" {
        let _source_guard = FILES_LOCK.lock().await;
        let (c, _writer) = open_write_database(&database_path(app)?)?;
        exists(&c, key)?;
        conversion::verify_source_revision(&c, key)?;
        let root = if cfg.mode == "obsidian" {
            fs::canonicalize(&cfg.vault_path)
        } else {
            fs::canonicalize(active_data_root(app)?.join("collection-files"))
        }
        .map_err(|e| e.to_string())?;
        let raw: String = c
            .query_row(
                "SELECT post_json FROM collection_x_items WHERE item_key=?1",
                [key],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let post: Post = serde_json::from_str(&raw).map_err(|_| "内容损坏")?;
        if cfg.download_media {
            verify_assets(&c, key, &post, &root)?;
        }
        if cfg.mode == "obsidian" {
            let destination = register_root(&c, &root)?;
            let(relative,hash,pending):(String,String,i64)=c.query_row("SELECT relative_path,file_hash,media_pending FROM collection_obsidian_exports WHERE destination=?1 AND item_key=?2",params![destination,key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|_|"目标页面尚未核验，保留原副本")?;
            let path = owned_path(&root, &relative)?;
            if pending != 0
                || fs::read(path)
                    .map(|bytes| storage::hash(&bytes) != hash)
                    .unwrap_or(true)
            {
                return Err("目标页面已更改或保存不完整，保留原副本".into());
            }
        }
    }
    let (c, _writer) = open_write_database(&database_path(app)?)?;
    control::commit(|| complete_copy(&c, key, target))?;
    WORKER_WAKE.notify_one();
    Ok(())
}

#[cfg(test)]
mod tests;
