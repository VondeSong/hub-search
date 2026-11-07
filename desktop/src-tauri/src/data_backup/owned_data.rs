//! Upgrade the old external-file layout before normal writers are admitted.
//! Original Obsidian vaults remain independent; originals are copied, not moved.
use super::*;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

const MARKER: &str = "hub_owned_data_v1";

/// The same startup migration, with no GUI, workers, credentials or host change.
pub(crate) fn migrate_owned_data_offline(root: &Path) -> Result<Value, String> {
    let root = files::existing_directory(root)?;
    let _session = crate::data_portability::exclusive_session(&root)?;
    let c = readonly(&root.join(DATABASE))?;
    if schema_version(&c)? != crate::database::DATABASE_SCHEMA_VERSION {
        return Err("请先用当前 Hub 升级数据目录，再执行离线整理".into());
    }
    drop(c);
    crate::data_portability::prepare_opened_root(&root, false)?;
    initialize_owned_data(&root)?;
    let c = readonly(&root.join(DATABASE))?;
    let value: String = c
        .query_row("SELECT value FROM metadata WHERE key=?1", [MARKER], |r| {
            r.get(0)
        })
        .map_err(|e| e.to_string())?;
    let marker: Value = serde_json::from_str(&value).map_err(|e| e.to_string())?;
    Ok(
        json!({"root":root,"migration":marker,"credentialsAccessed":false,"workersStarted":false,"obsidianOriginalsModified":false}),
    )
}

pub(crate) fn managed_craft_parent(
    database: &Path,
    library: &str,
    preferred: &str,
) -> Result<PathBuf, String> {
    let root = files::existing_directory(database.parent().ok_or("数据库缺少数据目录")?)?;
    let sources = root.join("external-sources");
    if !preferred.is_empty() {
        let preferred = Path::new(preferred);
        files::reject_links(preferred)?;
        if let Ok(path) = preferred.canonicalize() {
            if path.starts_with(&sources) && path.is_dir() {
                return Ok(path);
            }
        }
    }
    let id = format!("{:x}", Sha256::digest(library.as_bytes()));
    let parent = sources.join("craft").join(&id[..24]);
    files::reject_links(&parent)?;
    fs::create_dir_all(&parent).map_err(io_error)?;
    files::reject_links(&parent)?;
    parent.canonicalize().map_err(io_error)
}

fn table(c: &Connection, name: &str) -> Result<bool, String> {
    c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [name],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

fn needs_collection(c: &Connection, root: &Path) -> Result<bool, String> {
    let inside = |value: &str| {
        let root = crate::library_location::path_key(root);
        let path = crate::library_location::path_key(Path::new(value));
        path == root || path.starts_with(&format!("{root}/"))
    };
    let mut q = c
        .prepare("SELECT value FROM metadata WHERE key LIKE 'craft_backup_config:%'")
        .map_err(|e| e.to_string())?;
    for row in q
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
    {
        let value: Value =
            serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        if !inside(
            value["destination"]
                .as_str()
                .ok_or("Craft 原件缺少保存目录")?,
        ) {
            return Ok(true);
        }
    }
    let has_local = table(c, "collection_local_source_items")?;
    for name in [
        "collection_saved_media",
        "collection_owned_assets",
        "reading_media_outbox",
    ] {
        if !table(c, name)? {
            continue;
        }
        let exclude = if has_local && name != "reading_media_outbox" {
            " AND NOT EXISTS(SELECT 1 FROM collection_local_source_items local WHERE local.item_key=media.item_key)"
        } else {
            ""
        };
        let policy = media_policy::external_clause(name);
        let mut q = c.prepare(&format!("SELECT DISTINCT path FROM {name} media WHERE path IS NOT NULL AND path<>''{exclude}{policy}")).map_err(|e|e.to_string())?;
        for row in q
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
        {
            let value = row.map_err(|e| e.to_string())?;
            let path = crate::library_location::path_key(Path::new(&value));
            let cache = crate::library_location::path_key(&root.join("reading-media-v1"));
            if !inside(&value) || path.starts_with(&format!("{cache}/")) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

pub(crate) fn initialize_owned_data(root: &Path) -> Result<(), String> {
    x_media::initialize_references(root)?;
    let database = root.join(DATABASE);
    let c = readonly(&database)?;
    let marker: Option<String> = c
        .query_row("SELECT value FROM metadata WHERE key=?1", [MARKER], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    if marker
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .is_some_and(|v| v["version"] == 1)
    {
        return Ok(());
    }
    let collect = needs_collection(&c, root)?;
    drop(c);
    let summary = if collect {
        consolidate(root, &AtomicBool::new(false), &mut |_| {})?
    } else {
        json!({"ready":true,"copiedFiles":0,"copiedBytes":0,"warnings":[]})
    };
    let (mut c, _writer) = crate::open_write_database(&database)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    // Queue only missing originals. OCR and extraction preferences stay intact,
    // and running/rejected/unavailable or explicitly skipped sources stay intact.
    let download_eligible = crate::attachment_download_failures::eligible_sql();
    let queued = tx.execute(&format!("INSERT INTO index_jobs(job_key,space_id,source_id,source_type,job_type,status,priority,created_at,updated_at)
        SELECT 'download:'||s.id,s.space_id,s.id,s.source_type,'download_source','pending',30,?1,?1
        FROM source_items s JOIN libraries l ON l.id=s.space_id
        JOIN documents d ON d.space_id=s.space_id AND d.id=s.document_id
        LEFT JOIN index_jobs j ON j.job_key='download:'||s.id
        WHERE l.enabled=1 AND l.provider IN ('craft','dida365') AND s.source_type IN ('craft_attachment','dida_attachment')
          AND s.blob_hash IS NULL AND s.status NOT IN ('rejected','unavailable')
          AND COALESCE(j.status,'') NOT IN ('running','dismissed') AND {download_eligible}
        ON CONFLICT(job_key) DO UPDATE SET status='pending',attempts=0,updated_at=excluded.updated_at,
          last_error=NULL,next_attempt_at=0,worker_id=NULL,locked_at=NULL,lease_until=NULL
        WHERE index_jobs.status!='running'"), [crate::now_timestamp()]).map_err(|e|e.to_string())?;
    tx.execute("INSERT INTO metadata(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![MARKER,json!({"version":1,"summary":summary,"queuedOriginals":queued,"obsidianOriginalsModified":false}).to_string()]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}
