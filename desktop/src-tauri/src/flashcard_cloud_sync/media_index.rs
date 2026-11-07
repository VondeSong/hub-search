//! Incremental media references preserve archived and resolved-draft sources.
use super::*;

pub(super) fn refresh(c: &Connection) -> Result<(), String> {
    baseline::ensure_tracking(c)?;
    c.execute_batch("SAVEPOINT flashcard_media_references;")
        .map_err(|e| e.to_string())?;
    let result = (|| {
        c.execute_batch("CREATE TABLE IF NOT EXISTS flashcard_cloud_media_reference_state(id INTEGER PRIMARY KEY CHECK(id=1),cutoff INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS flashcard_cloud_media_references(field TEXT NOT NULL,identity TEXT NOT NULL,ordinal INTEGER NOT NULL,hash TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(field,identity,ordinal));
          CREATE INDEX IF NOT EXISTS flashcard_cloud_media_reference_hash ON flashcard_cloud_media_references(hash,field,identity,ordinal);
          INSERT OR IGNORE INTO flashcard_cloud_media_reference_state(id,cutoff) VALUES(1,-1);").map_err(|e|e.to_string())?;
        let old: i64 = c
            .query_row(
                "SELECT cutoff FROM flashcard_cloud_media_reference_state WHERE id=1",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let cutoff: i64 = c
            .query_row(
                "SELECT revision FROM flashcard_cloud_revision_state WHERE id=1",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let mut query=c.prepare("SELECT field,identity FROM flashcard_cloud_entity_revisions WHERE field IN ('cards','drafts','qualityRecords') AND revision>?1 AND revision<=?2 ORDER BY field,identity").map_err(|e|e.to_string())?;
        let mut rows = query
            .query(params![old, cutoff])
            .map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let field: String = row.get(0).map_err(|e| e.to_string())?;
            let identity: String = row.get(1).map_err(|e| e.to_string())?;
            c.execute(
                "DELETE FROM flashcard_cloud_media_references WHERE field=?1 AND identity=?2",
                params![field, identity],
            )
            .map_err(|e| e.to_string())?;
            let mut ordinal = 0i64;
            records::media_record(c, &field, &identity, |item| {
                if let Some(hash) = records::media_hash(item) {
                    c.execute("INSERT INTO flashcard_cloud_media_references(field,identity,ordinal,hash,payload) VALUES(?1,?2,?3,?4,?5)",params![field,identity,ordinal,hash,item.to_string()]).map_err(|e|e.to_string())?;
                }
                ordinal += 1;
                Ok(())
            })?;
        }
        c.execute(
            "UPDATE flashcard_cloud_media_reference_state SET cutoff=?1 WHERE id=1",
            [cutoff],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })();
    match result {
        Ok(()) => c
            .execute_batch("RELEASE flashcard_media_references")
            .map_err(|e| e.to_string()),
        Err(e) => {
            c.execute_batch(
                "ROLLBACK TO flashcard_media_references; RELEASE flashcard_media_references",
            )
            .map_err(|error| format!("{e}; {error}"))?;
            Err(e)
        }
    }
}

#[cfg(test)]
pub(super) fn hashes(c: &Connection) -> Result<HashSet<String>, String> {
    refresh(c)?;
    let mut query = c
        .prepare("SELECT DISTINCT hash FROM flashcard_cloud_media_references")
        .map_err(|e| e.to_string())?;
    let rows = query
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<HashSet<_>, _>>()
        .map_err(|e| e.to_string())
}

pub(super) fn references(c: &Connection, hash: &str) -> Result<bool, String> {
    refresh(c)?;
    c.query_row(
        "SELECT EXISTS(SELECT 1 FROM flashcard_cloud_media_references WHERE hash=?1)",
        [hash],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

#[cfg(test)]
pub(super) fn register_local(
    c: &Connection,
    blobs: &BlobStore,
    only: Option<&str>,
) -> Result<(), String> {
    refresh(c)?;
    if let Some(hash) = only {
        if let Some(raw) = representative(c, hash)? {
            register_item(c, blobs, hash, &raw)?;
        }
        return Ok(());
    }
    let mut seen = HashSet::new();
    let query = if only.is_some() {
        "SELECT payload FROM flashcard_cloud_media_references WHERE hash=?1 ORDER BY CASE field WHEN 'drafts' THEN 0 WHEN 'cards' THEN 1 ELSE 2 END,identity,ordinal"
    } else {
        "SELECT payload FROM flashcard_cloud_media_references WHERE ?1 IS NULL ORDER BY CASE field WHEN 'drafts' THEN 0 WHEN 'cards' THEN 1 ELSE 2 END,identity,ordinal"
    };
    let mut statement = c.prepare(query).map_err(|e| e.to_string())?;
    let mut rows = statement.query([only]).map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let value: Value =
            serde_json::from_str(&row.get::<_, String>(0).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        index_item(c, blobs, only, &mut seen, &value)?;
    }
    Ok(())
}

pub(super) fn register_snapshot(
    c: &Connection,
    snapshot: &FlashcardSyncSnapshot,
    blobs: &BlobStore,
    only: Option<&str>,
) -> Result<(), String> {
    let mut seen = HashSet::new();
    for item in flashcard_sync_drafts::media(&snapshot.drafts) {
        index_item(c, blobs, only, &mut seen, item)?;
    }
    for card in &snapshot.cards {
        if let Ok(items) = serde_json::from_str::<Vec<Value>>(&card.media_json) {
            for item in &items {
                index_item(c, blobs, only, &mut seen, item)?;
            }
        }
    }
    for record in &snapshot.quality_records {
        for item in [&record["snapshot"], &record["before"]]
            .into_iter()
            .flat_map(|card| card["media"].as_array().into_iter().flatten())
        {
            index_item(c, blobs, only, &mut seen, item)?;
        }
    }
    Ok(())
}

pub(super) fn representative(c: &Connection, hash: &str) -> Result<Option<String>, String> {
    c.query_row("SELECT payload FROM flashcard_cloud_media_references WHERE hash=?1 AND json_extract(payload,'$.url') IN ('http://craft-media.localhost/'||?1,'craft-media://localhost/'||?1,'hub-media://localhost/'||?1) ORDER BY CASE field WHEN 'drafts' THEN 0 WHEN 'cards' THEN 1 ELSE 2 END,identity,ordinal LIMIT 1",[hash],|r|r.get(0)).optional().map_err(|e|e.to_string())
}

pub(super) fn register_item(
    c: &Connection,
    blobs: &BlobStore,
    hash: &str,
    raw: &str,
) -> Result<(), String> {
    let item: Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
    index_item(c, blobs, Some(hash), &mut HashSet::new(), &item)
}

fn index_item(
    c: &Connection,
    blobs: &BlobStore,
    only: Option<&str>,
    seen: &mut HashSet<String>,
    item: &Value,
) -> Result<(), String> {
    use std::io::Read;
    let Some(url) = item["url"].as_str() else {
        return Ok(());
    };
    let Some(hash) = url
        .strip_prefix("http://craft-media.localhost/")
        .or_else(|| url.strip_prefix("craft-media://localhost/"))
        .or_else(|| url.strip_prefix("hub-media://localhost/"))
    else {
        return Ok(());
    };
    if hash.len() != 64
        || !hash.bytes().all(|b| b.is_ascii_hexdigit())
        || only.is_some_and(|wanted| wanted != hash)
        || !seen.insert(hash.to_string())
    {
        return Ok(());
    }
    let path = blobs.path_for(hash)?;
    if !path.is_file() {
        return Ok(());
    }
    let size = fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if size > FLASHCARD_SYNC_MAX_MEDIA_BYTES {
        return Err("附件超出大小限制".into());
    }
    let mut signature = Vec::new();
    fs::File::open(&path)
        .map_err(|e| e.to_string())?
        .take(8192)
        .read_to_end(&mut signature)
        .map_err(|e| e.to_string())?;
    let mime = if item["mimeType"] == "image/svg+xml" {
        if size > flashcard_attachments::MAX_BYTES as u64 {
            return Err("SVG 超出 64 MB 限制".into());
        }
        let bytes = fs::read(&path).map_err(|e| e.to_string())?;
        hub_mcp::validate_flashcard_svg(std::str::from_utf8(&bytes).map_err(|_| "SVG 编码无效")?)?;
        "image/svg+xml"
    } else {
        infer::get(&signature).map(|v| v.mime_type()).unwrap_or(
            if item["mimeType"] == "text/plain" {
                "text/plain"
            } else {
                "application/octet-stream"
            },
        )
    };
    c.execute("INSERT INTO blobs(hash,size,mime_type,relative_path,created_at,verified_at) VALUES(?1,?2,?3,?4,?5,?5) ON CONFLICT(hash) DO UPDATE SET size=excluded.size,verified_at=excluded.verified_at,mime_type=CASE WHEN blobs.mime_type IS NULL OR blobs.mime_type IN ('','application/octet-stream') THEN excluded.mime_type ELSE blobs.mime_type END",params![hash,size as i64,mime,format!("{}/{hash}",&hash[..2]),now_timestamp()]).map_err(|e|e.to_string())?;
    Ok(())
}
