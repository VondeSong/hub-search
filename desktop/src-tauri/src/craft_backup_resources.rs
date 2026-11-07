//! Read-only links from Hub's disposable index to independently stored backup originals.
use crate::craft_backup::{self, Snapshot};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

#[derive(Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceReport {
    pub registered: usize,
    pub linked: usize,
    pub rejected: usize,
    pub warnings: Vec<String>,
}

pub fn schema(c: &Connection) -> Result<(), String> {
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS craft_backup_files (
      hash TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, mtime TEXT NOT NULL,
      mime_type TEXT NOT NULL, PRIMARY KEY(hash,path));
      CREATE TABLE IF NOT EXISTS craft_backup_resources (
      library_id TEXT NOT NULL, document_id TEXT NOT NULL, root_document_id TEXT NOT NULL,
      remote_url TEXT NOT NULL, hash TEXT NOT NULL, title TEXT NOT NULL, mime_type TEXT NOT NULL,
      size INTEGER NOT NULL, captured_at INTEGER NOT NULL, document_modified_at INTEGER,
      PRIMARY KEY(library_id,document_id,remote_url));
      CREATE INDEX IF NOT EXISTS craft_backup_resources_hash ON craft_backup_resources(hash);",
    )
    .map_err(|e| e.to_string())?;
    let has_block = c
        .prepare("PRAGMA table_info(craft_backup_resources)")
        .map_err(|e| e.to_string())?
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .any(|name| name == "block_id");
    if !has_block {
        c.execute(
            "ALTER TABLE craft_backup_resources ADD COLUMN block_id TEXT",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    let has_revision = c
        .prepare("PRAGMA table_info(craft_backup_resources)")
        .map_err(|e| e.to_string())?
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .any(|name| name == "resource_revision");
    if !has_revision {
        c.execute(
            "ALTER TABLE craft_backup_resources ADD COLUMN resource_revision TEXT",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    c.execute_batch("CREATE TABLE IF NOT EXISTS craft_backup_markdown (
      library_id TEXT NOT NULL, document_id TEXT NOT NULL, markdown TEXT NOT NULL,
      captured_at INTEGER NOT NULL, document_modified_at INTEGER,
      PRIMARY KEY(library_id,document_id));
      CREATE TABLE IF NOT EXISTS craft_backup_url_aliases (
      library_id TEXT NOT NULL, document_id TEXT NOT NULL, remote_url TEXT NOT NULL,
      backup_url TEXT NOT NULL, markdown_hash TEXT NOT NULL,
      PRIMARY KEY(library_id,document_id,remote_url));
      UPDATE craft_backup_resources SET block_id=NULL WHERE block_id='markdown';
      DELETE FROM index_jobs WHERE source_id IN (SELECT id FROM source_items WHERE
        provider='craft' AND source_type='craft_attachment' AND json_extract(metadata_json,'$.backupSnapshot') IS NOT NULL
        AND id='craft_attachment:'||space_id||':'||document_id||':block:markdown');
      DELETE FROM ocr_pages WHERE source_item_id IN (SELECT id FROM source_items WHERE
        provider='craft' AND source_type='craft_attachment' AND json_extract(metadata_json,'$.backupSnapshot') IS NOT NULL
        AND id='craft_attachment:'||space_id||':'||document_id||':block:markdown');
      DELETE FROM content_items WHERE source_item_id IN (SELECT id FROM source_items WHERE
        provider='craft' AND source_type='craft_attachment' AND json_extract(metadata_json,'$.backupSnapshot') IS NOT NULL
        AND id='craft_attachment:'||space_id||':'||document_id||':block:markdown');
      DELETE FROM extractions WHERE source_item_id IN (SELECT id FROM source_items WHERE
        provider='craft' AND source_type='craft_attachment' AND json_extract(metadata_json,'$.backupSnapshot') IS NOT NULL
        AND id='craft_attachment:'||space_id||':'||document_id||':block:markdown');
      DELETE FROM source_items WHERE provider='craft' AND source_type='craft_attachment'
        AND json_extract(metadata_json,'$.backupSnapshot') IS NOT NULL
        AND id='craft_attachment:'||space_id||':'||document_id||':block:markdown';")
      .map_err(|e|e.to_string())?;
    Ok(())
}

/// Pair URLs only when the entire saved document is identical apart from Craft
/// resource URLs. Repeated labels, reordered images, or edited text cannot guess a match.
fn markdown_aliases(live: &str, saved: &str) -> Vec<(String, String)> {
    fn mask(text: &str) -> (String, Vec<String>) {
        let mut result = String::new();
        let mut urls = Vec::new();
        let mut cursor = 0;
        while let Some(offset) = text[cursor..].find("https://r.craft.do/") {
            let start = cursor + offset;
            let end = text[start..]
                .char_indices()
                .find(|(_, ch)| ch.is_whitespace() || [')', '<', '>', '\"', '\''].contains(ch))
                .map(|(i, _)| start + i)
                .unwrap_or(text.len());
            result.push_str(&text[cursor..start]);
            result.push_str("<craft-resource>");
            urls.push(text[start..end].to_string());
            cursor = end;
        }
        result.push_str(&text[cursor..]);
        (result, urls)
    }
    let (live_text, live_urls) = mask(live);
    let (saved_text, saved_urls) = mask(saved);
    if live_text != saved_text || live_urls.len() != saved_urls.len() {
        return Vec::new();
    }
    let mut pairs = std::collections::BTreeMap::<String, String>::new();
    for (a, b) in live_urls.into_iter().zip(saved_urls) {
        if pairs.get(&a).is_some_and(|previous| previous != &b) {
            return Vec::new();
        }
        pairs.insert(a, b);
    }
    pairs.into_iter().collect()
}

fn stamp(path: &Path) -> Result<(u64, String), String> {
    craft_backup::reject_links(path)?;
    let m = fs::metadata(path).map_err(|e| e.to_string())?;
    if !m.is_file() {
        return Err("备份附件不是文件".into());
    }
    Ok((
        m.len(),
        m.modified()
            .map_err(|e| e.to_string())?
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos()
            .to_string(),
    ))
}

fn verify(path: &Path, hash: &str, size: u64) -> Result<String, String> {
    let (actual, mtime) = stamp(path)?;
    if actual == 0 || actual != size || craft_backup::hash_file(path)? != hash {
        return Err("备份附件字节校验失败".into());
    }
    craft_backup::validate_original_content(path, true)?;
    if stamp(path)? != (actual, mtime.clone()) {
        return Err("校验过程中备份附件发生变化".into());
    }
    Ok(mtime)
}

/// Resolves only previously verified files. A moved/missing/changed original falls back
/// to another registered copy or the ordinary Hub cache, never to an arbitrary path.
pub fn file_for(database: &Path, hash: &str) -> Result<Option<PathBuf>, String> {
    let c = Connection::open_with_flags(database, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    let exists: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='craft_backup_files')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !exists {
        return Ok(None);
    }
    let mut q = c
        .prepare("SELECT path,size,mtime FROM craft_backup_files WHERE hash=?1")
        .map_err(|e| e.to_string())?;
    let rows = q
        .query_map([hash], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, u64>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (path, size, mtime) = row.map_err(|e| e.to_string())?;
        let path = PathBuf::from(path);
        if stamp(&path).is_ok_and(|value| value == (size, mtime.clone())) {
            return Ok(Some(path));
        }
        // Changed files are not accepted from their filename alone.
        if verify(&path, hash, size).is_ok() {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

#[derive(Debug)]
pub struct Resource {
    pub hash: String,
    pub title: String,
    pub mime_type: String,
    pub size: u64,
    resource_revision: Option<String>,
    captured_at: i64,
    remote_url: String,
}

fn compatible_source(
    metadata: &str,
    current_hash: Option<&str>,
    updated_at: i64,
    hash: &str,
    size: u64,
    revision: Option<&str>,
    captured_at: i64,
    snapshot: Option<&str>,
    remote_url: &str,
) -> bool {
    let value: serde_json::Value = serde_json::from_str(metadata).unwrap_or_default();
    if value
        .get("remoteUrl")
        .and_then(serde_json::Value::as_str)
        .is_none_or(|url| {
            crate::craft_attachment_resource_locator(url)
                != crate::craft_attachment_resource_locator(remote_url)
        })
    {
        return false;
    }
    if value
        .get("size")
        .and_then(serde_json::Value::as_u64)
        .is_some_and(|s| s != size)
    {
        return false;
    }
    if let Some(current) = value
        .get("resourceRevision")
        .and_then(serde_json::Value::as_str)
    {
        return revision == Some(current);
    }
    if crate::attachment_download_cache::resource_generation(metadata) > 0 {
        return false;
    }
    updated_at <= captured_at
        || current_hash == Some(hash)
        || snapshot.is_some_and(|id| {
            value
                .get("backupSnapshot")
                .and_then(serde_json::Value::as_str)
                == Some(id)
        })
}

pub fn lookup(
    database: &Path,
    library: &str,
    document: &str,
    url: &str,
) -> Result<Option<Resource>, String> {
    let c = crate::open_database(&database.to_path_buf())?;
    if !c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='craft_backup_resources')",
            [],
            |r| r.get::<_, bool>(0),
        )
        .map_err(|e| e.to_string())?
    {
        return Ok(None);
    }
    // The archive index is registered by a background task. An older database
    // can be read before that task upgrades its columns; unknown version
    // evidence must be a cache miss, not a preview-breaking SQL error.
    let has_revision = c
        .prepare("PRAGMA table_info(craft_backup_resources)")
        .map_err(|e| e.to_string())?
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .any(|name| name == "resource_revision");
    if !has_revision {
        return Ok(None);
    }
    let mut resource=c.query_row("SELECT r.hash,r.title,r.mime_type,r.size,r.resource_revision,r.captured_at,r.remote_url FROM craft_backup_resources r
      WHERE r.library_id=?1 AND (r.document_id=?2 OR r.root_document_id=?2)
      AND (r.remote_url=?3 OR EXISTS (SELECT 1 FROM source_items s WHERE s.provider='craft'
        AND s.space_id=r.library_id AND s.document_id=?2 AND json_extract(s.metadata_json,'$.remoteUrl')=?3
        AND lower(json_extract(s.metadata_json,'$.blockId'))=lower(r.block_id)))
      AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.space_id=r.library_id AND d.id=r.root_document_id
          AND d.modified_at>COALESCE(r.document_modified_at,r.captured_at))
      ORDER BY r.captured_at DESC LIMIT 1",params![library,document,url],|r|Ok(Resource{hash:r.get(0)?,title:r.get(1)?,mime_type:r.get(2)?,size:r.get(3)?,resource_revision:r.get(4)?,captured_at:r.get(5)?,remote_url:r.get(6)?})).optional().map_err(|e|e.to_string())?;
    if resource.is_none() {
        let alias_table: bool = c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='craft_backup_url_aliases')",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if alias_table {
            let markdown: Option<String> = c
                .query_row(
                    "SELECT markdown FROM documents WHERE space_id=?1 AND id=?2",
                    params![library, document],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if let Some(markdown) = markdown {
                let digest = format!("{:x}", Sha256::digest(markdown.as_bytes()));
                resource=c.query_row("SELECT r.hash,r.title,r.mime_type,r.size,r.resource_revision,r.captured_at,r.remote_url FROM craft_backup_url_aliases a
                  JOIN craft_backup_resources r ON r.library_id=a.library_id AND r.root_document_id=a.document_id AND r.remote_url=a.backup_url
                  WHERE a.library_id=?1 AND a.document_id=?2 AND a.remote_url=?3 AND a.markdown_hash=?4
                  AND NOT EXISTS(SELECT 1 FROM documents d WHERE d.space_id=r.library_id AND d.id=r.root_document_id AND d.modified_at>COALESCE(r.document_modified_at,r.captured_at))
                  ORDER BY r.captured_at DESC LIMIT 1",params![library,document,url,digest],|r|Ok(Resource{hash:r.get(0)?,title:r.get(1)?,mime_type:r.get(2)?,size:r.get(3)?,resource_revision:r.get(4)?,captured_at:r.get(5)?,remote_url:r.get(6)?})).optional().map_err(|e|e.to_string())?;
                // Synchronization may rotate the URL again. Recheck saved evidence
                // on demand without a download or database write.
                let has_saved:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='craft_backup_markdown')",[],|r|r.get(0)).map_err(|e|e.to_string())?;
                if resource.is_none() && has_saved {
                    let saved:Option<String>=c.query_row("SELECT b.markdown FROM craft_backup_markdown b JOIN documents d ON d.space_id=b.library_id AND d.id=b.document_id
                      WHERE b.library_id=?1 AND b.document_id=?2 AND d.modified_at<=COALESCE(b.document_modified_at,b.captured_at)",params![library,document],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
                    if let Some(saved) = saved {
                        if let Some((_, backup_url)) = markdown_aliases(&markdown, &saved)
                            .into_iter()
                            .find(|(current, _)| current == url)
                        {
                            resource=c.query_row("SELECT hash,title,mime_type,size,resource_revision,captured_at,remote_url FROM craft_backup_resources WHERE library_id=?1 AND root_document_id=?2 AND remote_url=?3 ORDER BY captured_at DESC LIMIT 1",params![library,document,backup_url],|r|Ok(Resource{hash:r.get(0)?,title:r.get(1)?,mime_type:r.get(2)?,size:r.get(3)?,resource_revision:r.get(4)?,captured_at:r.get(5)?,remote_url:r.get(6)?})).optional().map_err(|e|e.to_string())?;
                        }
                    }
                }
            }
        }
    }
    if let Some(candidate) = resource.as_ref() {
        let mut q=c.prepare("SELECT COALESCE(metadata_json,'{}'),blob_hash,updated_at FROM source_items WHERE provider='craft'
            AND space_id=?1 AND document_id=?2 AND (json_extract(metadata_json,'$.remoteUrl')=?3 OR json_extract(metadata_json,'$.markdownSource')=?3)")
            .map_err(|e|e.to_string())?;
        let rows = q
            .query_map(params![library, document, url], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        if rows.iter().any(|(metadata, hash, updated)| {
            !compatible_source(
                metadata,
                hash.as_deref(),
                *updated,
                &candidate.hash,
                candidate.size,
                candidate.resource_revision.as_deref(),
                candidate.captured_at,
                None,
                &candidate.remote_url,
            )
        }) {
            return Ok(None);
        }
    }
    Ok(resource.filter(|r| file_for(database, &r.hash).ok().flatten().is_some()))
}

pub fn register(
    database: &Path,
    root: &Path,
    snapshot: &Snapshot,
) -> Result<ResourceReport, String> {
    craft_backup::reject_links(&root.join("archive.json"))?;
    let identity: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join("archive.json")).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    if identity["libraryId"].as_str() != Some(&snapshot.library_id) {
        return Err("备份空间身份不一致".into());
    }
    let store = crate::blob_store::BlobStore::open(&root.join("objects"))?;
    let mut report = ResourceReport::default();
    // Hashing happens before taking the database writer lock.
    let (c, writer) = crate::open_write_database(&database.to_path_buf())?;
    schema(&c)?;
    drop(writer);
    let mut validated = Vec::new();
    for asset in &snapshot.attachments {
        let Some(hash) = &asset.object_hash else {
            report.rejected += 1;
            continue;
        };
        let checked = (|| {
            let path = store.path_for(hash)?;
            let (size, mtime) = stamp(&path)?;
            if asset.bytes.is_some_and(|expected| expected != size)
                || asset
                    .expected_bytes
                    .is_some_and(|expected| expected != size)
                || size == 0
            {
                return Err("附件长度不一致".to_string());
            }
            let previous: Option<(u64, String)> = c
                .query_row(
                    "SELECT size,mtime FROM craft_backup_files WHERE hash=?1 AND path=?2",
                    params![hash, path.to_string_lossy()],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if previous != Some((size, mtime.clone())) {
                verify(&path, hash, size)?;
            }
            let mime = crate::craft_export::original_mime(&path)?
                .unwrap_or_else(|| asset.mime_type.clone());
            Ok((asset, path, size, mtime, mime))
        })();
        match checked {
            Ok(value) => validated.push(value),
            Err(_) => report.rejected += 1,
        }
    }
    drop(c);
    let (mut c, _writer) = crate::open_write_database(&database.to_path_buf())?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    schema(&tx)?;
    let now = crate::now_timestamp();
    for (asset, path, size, mtime, mime) in validated {
        let hash = asset.object_hash.as_ref().unwrap();
        let owner = snapshot.documents.iter().find(|d| {
            d.id == asset.document_id
                || d.raw_document_id.as_deref() == Some(&asset.document_id)
                || d.block_ids.contains(&asset.document_id)
        });
        let root_id = owner.map(|d| d.id.as_str()).unwrap_or(&asset.document_id);
        let block_id = asset
            .id
            .strip_prefix(&format!("{}:", asset.document_id))
            .and_then(|id| id.strip_suffix(":original"))
            .filter(|id| {
                id.len() == 36
                    && id.bytes().enumerate().all(|(i, b)| {
                        if [8, 13, 18, 23].contains(&i) {
                            b == b'-'
                        } else {
                            b.is_ascii_hexdigit()
                        }
                    })
            });
        tx.execute("INSERT INTO craft_backup_files(hash,path,size,mtime,mime_type) VALUES(?1,?2,?3,?4,?5)
          ON CONFLICT(hash,path) DO UPDATE SET size=excluded.size,mtime=excluded.mtime,mime_type=excluded.mime_type",params![hash,path.to_string_lossy(),size,mtime,mime]).map_err(|e|e.to_string())?;
        let accepted=tx.execute("INSERT INTO craft_backup_resources(library_id,document_id,root_document_id,remote_url,hash,title,mime_type,size,captured_at,document_modified_at,block_id,resource_revision)
          VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12) ON CONFLICT(library_id,document_id,remote_url) DO UPDATE SET
          root_document_id=excluded.root_document_id,hash=excluded.hash,title=excluded.title,mime_type=excluded.mime_type,size=excluded.size,captured_at=excluded.captured_at,document_modified_at=excluded.document_modified_at,block_id=excluded.block_id,resource_revision=excluded.resource_revision
          WHERE excluded.captured_at>=craft_backup_resources.captured_at",
          params![snapshot.library_id,asset.document_id,root_id,asset.remote_url,hash,asset.title,mime,size,snapshot.started_at,owner.and_then(|d|d.modified_at),block_id,asset.resource_revision]).map_err(|e|e.to_string())?;
        report.registered += 1;
        if accepted == 0 {
            continue;
        }
        let newer:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM documents WHERE space_id=?1 AND id=?2 AND modified_at>?3)",params![snapshot.library_id,root_id,owner.and_then(|d|d.modified_at).unwrap_or(snapshot.started_at)],|r|r.get(0)).map_err(|e|e.to_string())?;
        if newer {
            continue;
        }
        tx.execute("INSERT INTO blobs(hash,size,mime_type,relative_path,created_at,verified_at) VALUES(?1,?2,?3,?4,?5,?5)
          ON CONFLICT(hash) DO UPDATE SET verified_at=excluded.verified_at",params![hash,size,mime,format!("{}/{}",&hash[..2],hash),now]).map_err(|e|e.to_string())?;
        let url_hash = format!("{:x}", Sha256::digest(asset.remote_url.as_bytes()));
        let id = block_id
            .map(|block| {
                format!(
                    "craft_attachment:{}:{}:block:{block}",
                    snapshot.library_id, root_id
                )
            })
            .unwrap_or_else(|| {
                format!(
                    "craft_attachment:{}:{}:{}",
                    snapshot.library_id, root_id, url_hash
                )
            });
        let remote_id = block_id
            .map(|block| format!("{root_id}:block:{block}"))
            .unwrap_or_else(|| format!("{root_id}:{url_hash}"));
        let metadata=serde_json::json!({"remoteUrl":asset.remote_url,"linkKind":asset.link_kind,"size":size,"backupSnapshot":snapshot.id,"blockId":block_id,"resourceRevision":asset.resource_revision,"resourceGeneration":0,"discoveryVersion":if block_id.is_some(){2}else{1}}).to_string();
        tx.execute("INSERT INTO source_items(id,space_id,document_id,remote_id,source_type,title,mime_type,blob_hash,content_hash,status,metadata_json,created_at,updated_at,provider,last_seen_at,missing_syncs)
          SELECT ?1,?2,?3,?4,'craft_attachment',?5,?6,NULL,NULL,'discovered',?8,?9,?9,'craft',?9,0
          WHERE EXISTS(SELECT 1 FROM documents WHERE space_id=?2 AND id=?3)
          AND NOT EXISTS(SELECT 1 FROM source_items WHERE space_id=?2 AND document_id IN (?3,?10) AND source_type='craft_attachment'
            AND (json_extract(metadata_json,'$.remoteUrl')=?11 OR (?12 IS NOT NULL AND lower(json_extract(metadata_json,'$.blockId'))=lower(?12))))
          ON CONFLICT(space_id,remote_id,source_type) DO NOTHING",params![id,snapshot.library_id,root_id,remote_id,asset.title,mime,hash,metadata,now,asset.document_id,asset.remote_url,block_id]).map_err(|e|e.to_string())?;
        let mut q=tx.prepare("SELECT id,blob_hash,COALESCE(metadata_json,'{}'),updated_at FROM source_items WHERE provider='craft' AND space_id=?1 AND document_id IN (?2,?3)
          AND source_type='craft_attachment' AND (json_extract(metadata_json,'$.remoteUrl')=?4
            OR (?5 IS NOT NULL AND lower(json_extract(metadata_json,'$.blockId'))=lower(?5)))").map_err(|e|e.to_string())?;
        let items = q
            .query_map(
                params![
                    snapshot.library_id,
                    root_id,
                    asset.document_id,
                    asset.remote_url,
                    block_id
                ],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Option<String>>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, i64>(3)?,
                    ))
                },
            )
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        drop(q);
        for (id, previous_hash, metadata, updated_at) in items {
            if !compatible_source(
                &metadata,
                previous_hash.as_deref(),
                updated_at,
                hash,
                size as u64,
                asset.resource_revision.as_deref(),
                snapshot.started_at,
                Some(&snapshot.id),
                &asset.remote_url,
            ) {
                continue;
            }
            let running: bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM index_jobs WHERE source_id=?1 AND status='running')",[&id],|r|r.get(0)).map_err(|e|e.to_string())?;
            if running && previous_hash.as_deref() != Some(hash) {
                continue;
            }
            tx.execute("UPDATE source_items SET blob_hash=?1,content_hash=?1,mime_type=?2,
                metadata_json=json_set(COALESCE(metadata_json,'{}'),'$.cachedResourceGeneration',COALESCE(json_extract(metadata_json,'$.resourceGeneration'),0)),
                status=CASE WHEN blob_hash=?1 AND status NOT IN ('discovered','unavailable','rejected') THEN status ELSE 'stored' END,updated_at=?3 WHERE id=?4",params![hash,mime,now,id]).map_err(|e|e.to_string())?;
            tx.execute("UPDATE index_jobs SET status='done',last_error=NULL,worker_id=NULL,locked_at=NULL,lease_until=NULL,updated_at=?1 WHERE source_id=?2 AND job_type='download_source' AND status IN ('pending','failed')",params![now,id]).map_err(|e|e.to_string())?;
            if previous_hash.as_deref() != Some(hash) && mime == "application/pdf" {
                tx.execute("INSERT INTO extractions(id,source_item_id,extractor,extractor_version,status,created_at,updated_at) VALUES(?1,?2,'pdf_native','1','pending',?3,?3)
                ON CONFLICT(source_item_id,extractor,extractor_version) DO UPDATE SET status='pending',last_error=NULL,updated_at=excluded.updated_at",params![format!("pdf-native-v1:{id}"),id,now]).map_err(|e|e.to_string())?;
                tx.execute("INSERT INTO index_jobs(job_key,space_id,source_id,source_type,job_type,status,priority,created_at,updated_at,provider) VALUES(?1,?2,?3,'craft_attachment','extract_pdf','pending',25,?4,?4,'craft')
                ON CONFLICT(job_key) DO UPDATE SET status='pending',last_error=NULL,attempts=0,next_attempt_at=0,worker_id=NULL,locked_at=NULL,lease_until=NULL,updated_at=excluded.updated_at WHERE index_jobs.status!='running'",params![format!("extract-pdf:{id}"),snapshot.library_id,id,now]).map_err(|e|e.to_string())?;
            }
            report.linked += 1;
        }
    }
    for doc in &snapshot.documents {
        let live: Option<String> = tx
            .query_row(
                "SELECT markdown FROM documents WHERE space_id=?1 AND id=?2 AND modified_at<=?3",
                params![
                    snapshot.library_id,
                    doc.id,
                    doc.modified_at.unwrap_or(snapshot.started_at)
                ],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let Some(live) = live else { continue };
        let Ok(bytes) = store.read(&doc.markdown_hash) else {
            continue;
        };
        if format!("{:x}", Sha256::digest(&bytes)) != doc.markdown_hash {
            continue;
        }
        let Ok(saved) = String::from_utf8(bytes) else {
            continue;
        };
        tx.execute("INSERT INTO craft_backup_markdown(library_id,document_id,markdown,captured_at,document_modified_at) VALUES(?1,?2,?3,?4,?5)
          ON CONFLICT(library_id,document_id) DO UPDATE SET markdown=excluded.markdown,captured_at=excluded.captured_at,document_modified_at=excluded.document_modified_at WHERE excluded.captured_at>=craft_backup_markdown.captured_at",params![snapshot.library_id,doc.id,saved,snapshot.started_at,doc.modified_at]).map_err(|e|e.to_string())?;
        let digest = format!("{:x}", Sha256::digest(live.as_bytes()));
        for (url, backup_url) in markdown_aliases(&live, &saved) {
            tx.execute("INSERT INTO craft_backup_url_aliases(library_id,document_id,remote_url,backup_url,markdown_hash) VALUES(?1,?2,?3,?4,?5)
              ON CONFLICT(library_id,document_id,remote_url) DO UPDATE SET backup_url=excluded.backup_url,markdown_hash=excluded.markdown_hash",params![snapshot.library_id,doc.id,url,backup_url,digest]).map_err(|e|e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(report)
}

pub fn reconcile(database: &Path) -> Result<ResourceReport, String> {
    let mut total = ResourceReport::default();
    for config in craft_backup::configs(database)? {
        let root = craft_backup::backup_root(&craft_backup::config_options(&config))?;
        // Latest attempt may be incomplete; individual valid originals remain usable.
        let mut points = Vec::new();
        for folder in ["snapshots", "attempts"] {
            if let Ok(entries) = fs::read_dir(root.join(folder)) {
                let newest = entries
                    .filter_map(Result::ok)
                    .map(|e| e.path())
                    .filter(|p| p.extension().is_some_and(|e| e == "json"))
                    .filter_map(|p| {
                        craft_backup::reject_links(&p).ok()?;
                        let s: Snapshot = serde_json::from_slice(&fs::read(&p).ok()?).ok()?;
                        (s.library_id == config.library_id
                            && s.finished_at.is_some()
                            && !s.attachments.is_empty())
                        .then_some(s)
                    })
                    .max_by_key(|s| s.started_at);
                if let Some(s) = newest {
                    points.push(s);
                }
            }
        }
        points.sort_by_key(|s| s.started_at);
        for s in points {
            match register(database, &root, &s) {
                Ok(r) => {
                    total.registered += r.registered;
                    total.linked += r.linked;
                    total.rejected += r.rejected;
                }
                Err(error) => total
                    .warnings
                    .push(format!("{}：{}", config.vault_name, error)),
            }
        }
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blob_store::BlobStore;
    use crate::craft_backup::{SnapshotAttachment, SnapshotDocument};
    use base64::Engine;

    fn fixture() -> (PathBuf, PathBuf, Snapshot) {
        let dir = std::env::temp_dir().join(format!(
            "hub-backup-resources-{:016x}",
            rand::random::<u64>()
        ));
        fs::create_dir_all(&dir).unwrap();
        let database = dir.join("index.sqlite3");
        let c = crate::open_database(&database).unwrap();
        c.execute("INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES('space','craft','Test',1,1)",[]).unwrap();
        c.execute("INSERT INTO documents(space_id,id,title,path,markdown,modified_at,indexed_at,content_hash) VALUES('space','page','Page','Page','body',10,1,'body')",[]).unwrap();
        drop(c);
        let root = dir.join("backup");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("archive.json"), br#"{"libraryId":"space"}"#).unwrap();
        let store = BlobStore::open(&root.join("objects")).unwrap();
        let bytes=base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=").unwrap();
        let blob = store.put(&bytes).unwrap();
        let snapshot = Snapshot {
            version: 1,
            id: "capture".into(),
            library_id: "space".into(),
            library_name: "Test".into(),
            started_at: 20,
            finished_at: Some(21),
            status: "partial".into(),
            inventory_hash: None,
            folders_hash: None,
            connection_hash: None,
            documents: vec![SnapshotDocument {
                id: "page".into(),
                raw_document_id: None,
                title: "Page".into(),
                folder_path: "".into(),
                location: "documents".into(),
                modified_at: Some(10),
                markdown_hash: "".into(),
                structure_hash: "".into(),
                block_ids: vec!["child".into()],
            }],
            attachments: vec![SnapshotAttachment {
                id: "image".into(),
                document_id: "child".into(),
                title: "image.bin".into(),
                mime_type: "application/octet-stream".into(),
                remote_url: "https://r.craft.do/expired".into(),
                link_kind: "image".into(),
                expected_bytes: Some(blob.size),
                resource_revision: None,
                remote_etag: None,
                object_hash: Some(blob.hash),
                bytes: Some(blob.size),
            }],
            external_references: vec![],
            supplemental_objects: Default::default(),
            issues: vec![],
            limitations: vec![],
        };
        (database, root, snapshot)
    }

    #[test]
    fn attachment_traffic_backup_old_revision_cannot_restore_new_source_without_parent_timestamp() {
        let (db, root, mut snapshot) = fixture();
        snapshot.attachments[0].resource_revision = Some("v1".into());
        register(&db, &root, &snapshot).unwrap();
        let c = crate::open_database(&db).unwrap();
        c.execute("UPDATE documents SET modified_at=NULL", [])
            .unwrap();
        c.execute("UPDATE source_items SET blob_hash=NULL,content_hash=NULL,metadata_json=json_set(metadata_json,'$.resourceRevision','v2','$.resourceGeneration',1),updated_at=30",[]).unwrap();
        c.execute("INSERT INTO index_jobs(job_key,space_id,source_id,source_type,job_type,status,created_at,updated_at) SELECT 'download:'||id,space_id,id,source_type,'download_source','pending',30,30 FROM source_items",[]).unwrap();
        drop(c);
        register(&db, &root, &snapshot).unwrap();
        let c = crate::open_database(&db).unwrap();
        assert!(c
            .query_row("SELECT blob_hash IS NULL FROM source_items", [], |r| r
                .get::<_, bool>(0))
            .unwrap());
        assert_eq!(
            c.query_row(
                "SELECT status FROM index_jobs WHERE job_type='download_source'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "pending"
        );
        assert!(
            lookup(&db, "space", "page", &snapshot.attachments[0].remote_url)
                .unwrap()
                .is_none()
        );
        drop(c);
        crate::forget_initialized_database(&db);
        fs::remove_dir_all(db.parent().unwrap()).unwrap();
    }

    #[test]
    fn attachment_traffic_backup_cannot_replace_running_owner() {
        let (db, root, mut snapshot) = fixture();
        snapshot.attachments[0].resource_revision = Some("v1".into());
        register(&db, &root, &snapshot).unwrap();
        let c = crate::open_database(&db).unwrap();
        c.execute(
            "UPDATE source_items SET blob_hash=NULL,content_hash=NULL",
            [],
        )
        .unwrap();
        c.execute("INSERT INTO index_jobs(job_key,space_id,source_id,source_type,job_type,status,worker_id,created_at,updated_at) SELECT 'download:'||id,space_id,id,source_type,'download_source','running','worker',30,30 FROM source_items",[]).unwrap();
        drop(c);
        register(&db, &root, &snapshot).unwrap();
        let c = crate::open_database(&db).unwrap();
        assert!(c
            .query_row("SELECT blob_hash IS NULL FROM source_items", [], |r| r
                .get::<_, bool>(0))
            .unwrap());
        let row: (String, String) = c
            .query_row(
                "SELECT status,worker_id FROM index_jobs WHERE job_type='download_source'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(row, ("running".into(), "worker".into()));
        drop(c);
        crate::forget_initialized_database(&db);
        fs::remove_dir_all(db.parent().unwrap()).unwrap();
    }

    #[test]
    fn attachment_traffic_backup_block_match_cannot_bridge_changed_resource_locator() {
        let (db, root, mut snapshot) = fixture();
        snapshot.attachments[0].id = "child:00000000-0000-4000-8000-000000000001:original".into();
        snapshot.attachments[0].resource_revision = Some("v1".into());
        register(&db, &root, &snapshot).unwrap();
        let c = crate::open_database(&db).unwrap();
        c.execute("UPDATE documents SET modified_at=NULL", [])
            .unwrap();
        c.execute("UPDATE source_items SET blob_hash=NULL,content_hash=NULL,metadata_json=json_set(metadata_json,'$.remoteUrl','https://r.craft.do/different-resource','$.resourceGeneration',1),updated_at=30",[]).unwrap();
        drop(c);
        register(&db, &root, &snapshot).unwrap();
        let c = crate::open_database(&db).unwrap();
        assert!(c
            .query_row("SELECT blob_hash IS NULL FROM source_items", [], |r| r
                .get::<_, bool>(0))
            .unwrap());
        assert!(lookup(
            &db,
            "space",
            "page",
            "https://r.craft.do/different-resource"
        )
        .unwrap()
        .is_none());
        drop(c);
        crate::forget_initialized_database(&db);
        fs::remove_dir_all(db.parent().unwrap()).unwrap();
    }

    #[test]
    fn attachment_traffic_backup_legacy_index_is_readable_before_background_upgrade() {
        let (db, root, mut snapshot) = fixture();
        snapshot.attachments[0].resource_revision = Some("v1".into());
        register(&db, &root, &snapshot).unwrap();
        let c = crate::open_database(&db).unwrap();
        c.execute(
            "ALTER TABLE craft_backup_resources DROP COLUMN resource_revision",
            [],
        )
        .unwrap();
        drop(c);
        assert!(
            lookup(&db, "space", "page", &snapshot.attachments[0].remote_url)
                .unwrap()
                .is_none()
        );
        let cache = BlobStore::open(&db.parent().unwrap().join("disposable"))
            .unwrap()
            .with_backup_index(db.clone());
        assert!(
            !cache
                .read(snapshot.attachments[0].object_hash.as_ref().unwrap())
                .unwrap()
                .is_empty(),
            "known hash-based original access must still work before registration"
        );
        register(&db, &root, &snapshot).unwrap();
        assert!(
            lookup(&db, "space", "page", &snapshot.attachments[0].remote_url)
                .unwrap()
                .is_some()
        );
        crate::forget_initialized_database(&db);
        fs::remove_dir_all(db.parent().unwrap()).unwrap();
    }

    #[test]
    fn inline_markdown_images_use_document_evidence_and_keep_separate_identities() {
        let (db, root, mut snapshot) = fixture();
        let live =
            "one\n![Image](https://r.craft.do/old-one)\ntwo\n![Image](https://r.craft.do/old-two)";
        let saved = live
            .replace("old-one", "new-one")
            .replace("old-two", "new-two");
        let store = BlobStore::open(&root.join("objects")).unwrap();
        snapshot.documents[0].markdown_hash = store.put(saved.as_bytes()).unwrap().hash;
        snapshot.attachments[0].id = "child:markdown:first".into();
        snapshot.attachments[0].remote_url = "https://r.craft.do/new-one".into();
        let mut second = snapshot.attachments[0].clone();
        second.id = "child:markdown:second".into();
        second.remote_url = "https://r.craft.do/new-two".into();
        snapshot.attachments.push(second);
        let c = crate::open_database(&db).unwrap();
        c.execute("UPDATE documents SET markdown=?1", [live])
            .unwrap();
        drop(c);
        register(&db, &root, &snapshot).unwrap();
        assert!(lookup(&db, "space", "page", "https://r.craft.do/old-one")
            .unwrap()
            .is_some());
        assert!(lookup(&db, "space", "page", "https://r.craft.do/old-two")
            .unwrap()
            .is_some());
        let c = crate::open_database(&db).unwrap();
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM source_items", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            c.query_row(
                "SELECT COUNT(*) FROM craft_backup_resources WHERE block_id IS NOT NULL",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        c.execute(
            "UPDATE documents SET markdown=replace(markdown,'old-one','rotated-again')",
            [],
        )
        .unwrap();
        drop(c);
        assert!(
            lookup(&db, "space", "page", "https://r.craft.do/rotated-again")
                .unwrap()
                .is_some()
        );
        let c = crate::open_database(&db).unwrap();
        c.execute("UPDATE documents SET markdown=markdown||'changed'", [])
            .unwrap();
        drop(c);
        assert!(lookup(&db, "space", "page", "https://r.craft.do/old-one")
            .unwrap()
            .is_none());
        assert!(markdown_aliases(live, &saved.replace("two\n", "edited\n")).is_empty());
        assert!(markdown_aliases(
            "https://r.craft.do/a https://r.craft.do/a",
            "https://r.craft.do/b https://r.craft.do/c"
        )
        .is_empty());
    }

    #[test]
    fn partial_snapshot_supplies_verified_images_without_copying_or_cross_space_matches() {
        let (db, root, snapshot) = fixture();
        let r = register(&db, &root, &snapshot).unwrap();
        assert_eq!((r.registered, r.linked, r.rejected), (1, 1, 0));
        assert_eq!(snapshot.status, "partial");
        let resource = lookup(&db, "space", "page", "https://r.craft.do/expired")
            .unwrap()
            .unwrap();
        assert_eq!(resource.mime_type, "image/png");
        assert!(lookup(&db, "other", "page", "https://r.craft.do/expired")
            .unwrap()
            .is_none());
        assert!(lookup(&db, "space", "other", "https://r.craft.do/expired")
            .unwrap()
            .is_none());
        let cache = BlobStore::open(&db.parent().unwrap().join("cache"))
            .unwrap()
            .with_backup_index(db.clone());
        assert_eq!(
            cache.path_for(&resource.hash).unwrap(),
            root.join("objects")
                .join(&resource.hash[..2])
                .join(&resource.hash)
        );
        assert!(!cache.local_path_for(&resource.hash).unwrap().exists());
        assert!(!cache.read(&resource.hash).unwrap().is_empty());
        register(&db, &root, &snapshot).unwrap();
        let c = crate::open_database(&db).unwrap();
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM source_items", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn corrupt_empty_and_html_originals_are_rejected_and_changed_files_fail_closed() {
        let (db, root, mut snapshot) = fixture();
        let store = BlobStore::open(&root.join("objects")).unwrap();
        for bytes in [&b""[..], &b"<html>expired download</html>"[..]] {
            let blob = store.put(bytes).unwrap();
            let mut a = snapshot.attachments[0].clone();
            a.id = blob.hash.clone();
            a.remote_url = format!("https://r.craft.do/{}", blob.hash);
            a.object_hash = Some(blob.hash);
            a.bytes = Some(blob.size);
            a.expected_bytes = Some(blob.size);
            snapshot.attachments.push(a);
        }
        let r = register(&db, &root, &snapshot).unwrap();
        assert_eq!((r.registered, r.rejected), (1, 2));
        let hash = snapshot.attachments[0].object_hash.as_ref().unwrap();
        let path = store.path_for(hash).unwrap();
        fs::write(
            &path,
            vec![b'x'; fs::metadata(&path).unwrap().len() as usize],
        )
        .unwrap();
        assert!(file_for(&db, hash).unwrap().is_none());
        assert!(lookup(&db, "space", "page", "https://r.craft.do/expired")
            .unwrap()
            .is_none());
    }

    #[test]
    fn newer_live_document_is_not_replaced_by_an_older_capture() {
        let (db, root, snapshot) = fixture();
        let c = crate::open_database(&db).unwrap();
        c.execute("UPDATE documents SET modified_at=30", [])
            .unwrap();
        drop(c);
        let r = register(&db, &root, &snapshot).unwrap();
        assert_eq!(r.linked, 0);
        assert!(lookup(&db, "space", "page", "https://r.craft.do/expired")
            .unwrap()
            .is_none());
    }

    #[test]
    fn changed_signed_urls_reuse_block_identity_without_duplicate_source_items() {
        let (db, root, mut snapshot) = fixture();
        let block = "51639948-B87A-47E8-B3AE-E6FA188C6F3D";
        snapshot.attachments[0].id = format!("child:{block}:original");
        let c = crate::open_database(&db).unwrap();
        c.execute("INSERT INTO source_items(id,space_id,document_id,remote_id,source_type,title,status,metadata_json,provider,created_at,updated_at)
          VALUES('existing','space','page','existing','craft_attachment','Image','discovered',?1,'craft',1,1)",
          [serde_json::json!({"remoteUrl":"https://r.craft.do/expired?signature=old","blockId":block.to_ascii_lowercase()}).to_string()]).unwrap();
        drop(c);
        register(&db, &root, &snapshot).unwrap();
        let r = lookup(
            &db,
            "space",
            "page",
            "https://r.craft.do/expired?signature=old",
        )
        .unwrap()
        .unwrap();
        assert_eq!(r.hash, snapshot.attachments[0].object_hash.clone().unwrap());
        let c = crate::open_database(&db).unwrap();
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM source_items", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert!(c
            .query_row(
                "SELECT blob_hash FROM source_items WHERE id='existing'",
                [],
                |r| r.get::<_, Option<String>>(0)
            )
            .unwrap()
            .is_some());
    }

    #[test]
    fn backed_video_reads_requested_ranges_without_a_cache_copy() {
        use std::io::{Read, Seek, SeekFrom};
        let (db, root, mut snapshot) = fixture();
        let bytes = b"\0\0\0\x18ftypmp42\0\0\0\0mp42isom\0\0\0\x10mdat01234567";
        let store = BlobStore::open(&root.join("objects")).unwrap();
        let blob = store.put(bytes).unwrap();
        snapshot.attachments[0].object_hash = Some(blob.hash.clone());
        snapshot.attachments[0].bytes = Some(blob.size);
        snapshot.attachments[0].expected_bytes = Some(blob.size);
        snapshot.attachments[0].mime_type = "video/mp4".into();
        register(&db, &root, &snapshot).unwrap();
        let cache = BlobStore::open(&db.parent().unwrap().join("cache"))
            .unwrap()
            .with_backup_index(db.clone());
        let preview = crate::preview_media_from_blob(&cache, &blob.hash, "video/mp4").unwrap();
        assert_eq!(preview.media_type, "video");
        assert!(!cache.local_path_for(&blob.hash).unwrap().exists());
        let (start, end) = crate::requested_media_range("bytes=8-15", blob.size).unwrap();
        let mut file = fs::File::open(cache.path_for(&blob.hash).unwrap()).unwrap();
        file.seek(SeekFrom::Start(start)).unwrap();
        let mut range = Vec::new();
        file.take(end - start + 1).read_to_end(&mut range).unwrap();
        assert_eq!(range, &bytes[8..16]);
    }

    #[test]
    fn migration_relinks_originals_and_cache_cleanup_never_deletes_them() {
        let (db, root, snapshot) = fixture();
        register(&db, &root, &snapshot).unwrap();
        let moved = root.with_file_name("moved-backup");
        fs::rename(&root, &moved).unwrap();
        register(&db, &moved, &snapshot).unwrap();
        let hash = snapshot.attachments[0].object_hash.as_ref().unwrap();
        let original = moved.join("objects").join(&hash[..2]).join(hash);
        let cache = BlobStore::open(&db.parent().unwrap().join("cache"))
            .unwrap()
            .with_backup_index(db.clone());
        assert_eq!(cache.path_for(hash).unwrap(), original);
        let c = crate::open_database(&db).unwrap();
        c.execute("DELETE FROM source_items", []).unwrap();
        c.execute("UPDATE blobs SET created_at=1", []).unwrap();
        drop(c);
        crate::cleanup_local_storage(&db, &cache, &db.parent().unwrap().join("search-index"))
            .unwrap();
        assert!(original.is_file());
    }

    #[test]
    fn missing_pdf_download_is_replaced_by_a_local_extraction_job_and_repeated_registration_is_stable(
    ) {
        let (db, root, mut snapshot) = fixture();
        let blob = BlobStore::open(&root.join("objects"))
            .unwrap()
            .put(b"%PDF-1.4\n%%EOF\n")
            .unwrap();
        snapshot.attachments[0].object_hash = Some(blob.hash);
        snapshot.attachments[0].bytes = Some(blob.size);
        snapshot.attachments[0].expected_bytes = Some(blob.size);
        snapshot.attachments[0].mime_type = "application/pdf".into();
        register(&db, &root, &snapshot).unwrap();
        let c = crate::open_database(&db).unwrap();
        assert_eq!(
            c.query_row(
                "SELECT COUNT(*) FROM index_jobs WHERE job_type='extract_pdf' AND status='pending'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        c.execute("UPDATE index_jobs SET status='done'", [])
            .unwrap();
        drop(c);
        register(&db, &root, &snapshot).unwrap();
        let c = crate::open_database(&db).unwrap();
        assert_eq!(
            c.query_row(
                "SELECT COUNT(*) FROM index_jobs WHERE status='pending'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }

    #[test]
    #[ignore]
    fn connect_real_backup_resources() {
        let db = PathBuf::from(std::env::var_os("HUB_RESOURCES_DATABASE").unwrap());
        let report = reconcile(&db).unwrap();
        println!("{}", serde_json::to_string(&report).unwrap());
        for config in craft_backup::configs(&db).unwrap() {
            let c = crate::open_database(&db).unwrap();
            let (registered,linked):(i64,i64)=c.query_row("SELECT (SELECT COUNT(*) FROM craft_backup_resources WHERE library_id=?1),(SELECT COUNT(*) FROM source_items WHERE space_id=?1 AND source_type='craft_attachment' AND blob_hash IS NOT NULL)",[&config.library_id],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
            println!(
                "{}: {} backup mappings, {} cached attachment mappings",
                config.vault_name, registered, linked
            );
        }
    }
}
