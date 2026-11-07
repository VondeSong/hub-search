//! SQL delivery inventory and cached verification of immutable local media.
use super::*;
use std::io::Read;
use std::path::Path;

fn schema(c: &Connection) -> Result<(), String> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS flashcard_cloud_media_batches(namespace TEXT PRIMARY KEY,batch TEXT NOT NULL,cutoff INTEGER NOT NULL,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS flashcard_cloud_media_candidates(namespace TEXT NOT NULL,batch TEXT NOT NULL,hash TEXT NOT NULL,referenced INTEGER NOT NULL,queued INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'pending',mime_payload TEXT,PRIMARY KEY(namespace,batch,hash));
      CREATE INDEX IF NOT EXISTS flashcard_media_candidate_pending ON flashcard_cloud_media_candidates(namespace,batch,state,hash);
      CREATE TABLE IF NOT EXISTS flashcard_cloud_media_local_verifications(hash TEXT PRIMARY KEY,path TEXT NOT NULL,size INTEGER NOT NULL,stamp TEXT NOT NULL,mime_payload TEXT,verified_at INTEGER NOT NULL,checks INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS flashcard_cloud_media_receipts(namespace TEXT NOT NULL,hash TEXT NOT NULL,size INTEGER NOT NULL,verified_sha TEXT NOT NULL,remote_identity TEXT,PRIMARY KEY(namespace,hash));").map_err(|e|e.to_string())?;
    let present: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('flashcard_cloud_media_receipts') WHERE name='remote_identity')", [], |r| r.get(0)).map_err(|e|e.to_string())?;
    if !present {
        c.execute(
            "ALTER TABLE flashcard_cloud_media_receipts ADD COLUMN remote_identity TEXT",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn fingerprint(path: &Path) -> Result<(u64, Option<String>), String> {
    let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err("本地附件不是文件".into());
    }
    let size = metadata.len();
    if size > FLASHCARD_SYNC_MAX_MEDIA_BYTES {
        return Err("附件超过 250 MB 单文件限制".into());
    }
    let nanos = |time: std::time::SystemTime| {
        time.duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|v| v.as_nanos().to_string())
    };
    let stamp = metadata.modified().ok().and_then(nanos).map(|modified| {
        serde_json::to_string(&(
            path.to_string_lossy(),
            size,
            modified,
            metadata.created().ok().and_then(nanos),
        ))
        .unwrap()
    });
    Ok((size, stamp))
}
fn cached_local(
    c: &Connection,
    blobs: &BlobStore,
    hash: &str,
) -> Result<Option<(u64, String, bool)>, String> {
    let path = blobs.path_for(hash)?;
    let (size, stamp) = fingerprint(&path)?;
    let Some(stamp) = stamp else {
        return Ok(None);
    };
    let old: Option<(String, u64, String)> = c
        .query_row(
            "SELECT path,size,stamp FROM flashcard_cloud_media_local_verifications WHERE hash=?1",
            [hash],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(old
        .filter(|v| v.0 == path.to_string_lossy() && v.1 == size && v.2 == stamp)
        .map(|_| (size, stamp, false)))
}
pub(super) fn verify_local(
    c: &Connection,
    blobs: &BlobStore,
    hash: &str,
    force: bool,
) -> Result<(u64, String, bool), String> {
    let exists:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='flashcard_cloud_media_local_verifications')",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    if !exists {
        schema(c)?;
    }
    let path = blobs.path_for(hash)?;
    let (size, stamp) = fingerprint(&path)?;
    let old: Option<(String, u64, String)> = c
        .query_row(
            "SELECT path,size,stamp FROM flashcard_cloud_media_local_verifications WHERE hash=?1",
            [hash],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if !force
        && stamp.as_ref().is_some_and(|stamp| {
            old.as_ref()
                .is_some_and(|v| v.0 == path.to_string_lossy() && v.1 == size && &v.2 == stamp)
        })
    {
        return Ok((size, stamp.unwrap(), false));
    }
    let mut file = fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    let mut total = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        total = total.checked_add(n as u64).ok_or("附件长度溢出")?;
        if total > FLASHCARD_SYNC_MAX_MEDIA_BYTES {
            return Err("附件超过 250 MB 单文件限制".into());
        }
        digest.update(&buffer[..n]);
    }
    if total != size || format!("{:x}", digest.finalize()) != hash {
        return Err("本地附件哈希不符；已停止同步".into());
    }
    let after = fingerprint(&path)?;
    if after.0 != size || after.1 != stamp {
        return Err("本地附件在校验期间发生变化；记录已保留".into());
    }
    let stamp = stamp.unwrap_or_default();
    c.execute("INSERT INTO flashcard_cloud_media_local_verifications(hash,path,size,stamp,verified_at,checks) VALUES(?1,?2,?3,?4,?5,1) ON CONFLICT(hash) DO UPDATE SET path=excluded.path,size=excluded.size,stamp=excluded.stamp,verified_at=excluded.verified_at,checks=checks+1",params![hash,path.to_string_lossy(),size,stamp,now_timestamp()]).map_err(|e|e.to_string())?;
    Ok((size, stamp, true))
}

pub(super) async fn verify_local_async(
    db: &PathBuf,
    blobs: &BlobStore,
    hash: &str,
    force: bool,
) -> Result<(u64, String, bool), String> {
    let db = db.clone();
    let blobs = blobs.clone();
    let hash = hash.to_owned();
    tokio::task::spawn_blocking(move || {
        let (c, _writer) = open_write_database(&db)?;
        verify_local(&c, &blobs, &hash, force)
    })
    .await
    .map_err(|_| "附件校验任务中断")?
}
fn register_verified(
    c: &Connection,
    blobs: &BlobStore,
    hash: &str,
    mime: &Option<String>,
    checked: bool,
) -> Result<(), String> {
    let old: Option<String> = c
        .query_row(
            "SELECT mime_payload FROM flashcard_cloud_media_local_verifications WHERE hash=?1",
            [hash],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let indexed: bool = c
        .query_row(
            "SELECT ?2 IS NULL OR EXISTS(SELECT 1 FROM blobs WHERE hash=?1)",
            params![hash, mime],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if checked || old != *mime || !indexed {
        if let Some(raw) = mime {
            media_index::register_item(c, blobs, hash, raw)?;
        }
        c.execute(
            "UPDATE flashcard_cloud_media_local_verifications SET mime_payload=?2 WHERE hash=?1",
            params![hash, mime],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub(super) fn register_local_verified(
    c: &Connection,
    blobs: &BlobStore,
    hash: &str,
    checked: bool,
) -> Result<(), String> {
    let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
    media_index::refresh(&tx)?;
    let mime = media_index::representative(&tx, hash)?;
    register_verified(&tx, blobs, hash, &mime, checked)?;
    tx.commit().map_err(|e| e.to_string())
}
fn begin(c: &mut Connection, ns: &str) -> Result<String, String> {
    schema(c)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    media_index::refresh(&tx)?;
    let batch = random_url_safe(24);
    // A new attempt freezes current references and the durable frozen-upload
    // queue. Previous receipts remain evidence; every remote hash is rechecked.
    tx.execute("INSERT OR IGNORE INTO flashcard_cloud_media_candidates(namespace,batch,hash,referenced,queued) SELECT ?1,?2,hash,1,0 FROM flashcard_cloud_media_references ORDER BY hash",params![ns,batch]).map_err(|e|e.to_string())?;
    tx.execute("INSERT INTO flashcard_cloud_media_candidates(namespace,batch,hash,referenced,queued) SELECT namespace,?2,hash,0,1 FROM flashcard_cloud_media_queue WHERE namespace=?1 ON CONFLICT(namespace,batch,hash) DO UPDATE SET queued=1",params![ns,batch]).map_err(|e|e.to_string())?;
    tx.execute("UPDATE flashcard_cloud_media_candidates SET mime_payload=(SELECT payload FROM flashcard_cloud_media_references r WHERE r.hash=flashcard_cloud_media_candidates.hash AND json_extract(r.payload,'$.url') IN ('http://craft-media.localhost/'||r.hash,'craft-media://localhost/'||r.hash,'hub-media://localhost/'||r.hash) ORDER BY CASE r.field WHEN 'drafts' THEN 0 WHEN 'cards' THEN 1 ELSE 2 END,r.identity,r.ordinal LIMIT 1) WHERE namespace=?1 AND batch=?2",params![ns,batch]).map_err(|e|e.to_string())?;
    tx.execute(
        "DELETE FROM flashcard_cloud_media_candidates WHERE namespace=?1 AND batch<>?2",
        params![ns, batch],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO flashcard_cloud_media_batches(namespace,batch,cutoff,state) VALUES(?1,?2,(SELECT cutoff FROM flashcard_cloud_media_reference_state WHERE id=1),'running') ON CONFLICT(namespace) DO UPDATE SET batch=excluded.batch,cutoff=excluded.cutoff,state=excluded.state",params![ns,batch]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(batch)
}

pub(super) async fn deliver(
    remote: &OssStore,
    db: &PathBuf,
    blobs: &BlobStore,
    ns: &str,
    download: bool,
    force: bool,
    report: &mut CloudReport,
) -> Result<(usize, usize), String> {
    let batch = {
        let (mut c, _writer) = open_write_database(db)?;
        begin(&mut c, ns)?
    };
    let mut counts = (0, 0);
    let mut cursor = String::new();
    let mut scanned = 0usize;
    report.pending_media = 0;
    // Reuse one scalar reader for the batch. Reopening the whole database for
    // each missing or unchanged hash would repeat schema validation per item.
    let reader = open_database(db)?;
    loop {
        let candidate:Option<(String,bool,bool,Option<String>)>=reader.query_row("SELECT hash,referenced,queued,mime_payload FROM flashcard_cloud_media_candidates WHERE namespace=?1 AND batch=?2 AND hash>?3 ORDER BY hash LIMIT 1",params![ns,batch,cursor],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(|e|e.to_string())?;
        let Some((hash, _referenced, queued, mime)) = candidate else {
            break;
        };
        cursor = hash.clone();
        scanned += 1;
        if scanned % 128 == 0 {
            tokio::task::yield_now().await;
        }
        let mut path = blobs.path_for(&hash)?;
        let key = remote.key(&format!("media/{hash}"));
        remote.check_network(&key)?;
        if !path.is_file() {
            if !download {
                report.pending_media += 1;
                continue;
            }
            match remote.get_media_blob(&key, &hash, blobs).await? {
                Some(size) => {
                    counts.1 += 1;
                    report.downloaded_bytes += size;
                    path = blobs.path_for(&hash)?;
                }
                None => {
                    report.pending_media += 1;
                    continue;
                }
            }
        }
        let cached = if force {
            None
        } else {
            cached_local(&reader, blobs, &hash)?
        };
        let (size, stamp, checked) = match cached {
            Some(value) => value,
            None => verify_local_async(db, blobs, &hash, force).await?,
        };
        let previous: Option<String> = reader
            .query_row(
                "SELECT remote_identity FROM flashcard_cloud_media_receipts
             WHERE namespace=?1 AND hash=?2 AND size=?3 AND verified_sha=?2",
                params![ns, hash, size],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .flatten();
        let previous = previous
            .and_then(|v| serde_json::from_str::<crate::flashcard_object_store::Identity>(&v).ok());
        use crate::flashcard_object_store::WriteConfirmation;
        let confirmation = match remote.head_identity(&key).await? {
            Some(head)
                if head.matches(&hash, size)
                    && previous
                        .as_ref()
                        .is_none_or(|old| old.etag.is_none() || old.same_version(&head)) =>
            {
                WriteConfirmation::ExistingMetadata(Some(head))
            }
            Some(head) => {
                if !force && previous.as_ref().is_some_and(|old| old.same_version(&head)) {
                    WriteConfirmation::ExistingMetadata(Some(head))
                } else if let Some(verified) =
                    remote.verified_media_identity(&key, &hash, size).await?
                {
                    WriteConfirmation::ExistingBytes(Some(verified))
                } else {
                    remote
                        .put_media_file_confirmed(&key, &path, &hash, size)
                        .await?
                }
            }
            None => {
                remote
                    .put_media_file_confirmed(&key, &path, &hash, size)
                    .await?
            }
        };
        let confirmed = confirmation.written();
        let mut remote_identity = confirmation.identity().cloned();
        // Only this operation's complete byte check satisfies forced readback.
        // A previous receipt or current HEAD still needs one authoritative GET.
        let bytes_confirmed = matches!(
            confirmation,
            WriteConfirmation::Written(_) | WriteConfirmation::ExistingBytes(_)
        );
        if confirmed {
            counts.0 += 1;
            report.uploaded_bytes += size;
        }
        if force && !bytes_confirmed {
            remote_identity = Some(
                remote
                    .verified_media_identity(&key, &hash, size)
                    .await?
                    .ok_or("迁移附件读回缺失")?,
            );
        }
        let after = fingerprint(&path)?;
        if after.0 != size || after.1.unwrap_or_default() != stamp {
            return Err("本地附件在传输期间发生变化；记录已保留".into());
        }
        // Stable, already acknowledged hashes only need the fresh remote check.
        // Avoid a writer lease and one disk transaction per unchanged attachment.
        // The batch is removed atomically at the end; on interruption it is
        // recaptured and every remote object is checked again before success.
        let remote_identity = remote_identity
            .map(|v| serde_json::to_string(&v))
            .transpose()
            .map_err(|e| e.to_string())?;
        if !checked && !force && !confirmed && !queued {
            let stable:bool=reader.query_row("SELECT EXISTS(SELECT 1 FROM flashcard_cloud_media_local_verifications l JOIN flashcard_cloud_media_receipts r ON r.hash=l.hash WHERE l.hash=?2 AND l.mime_payload IS ?3 AND r.namespace=?1 AND r.size=?4 AND r.verified_sha=?2 AND (?3 IS NULL OR EXISTS(SELECT 1 FROM blobs WHERE hash=?2)))",params![ns,hash,mime,size],|r|r.get(0)).map_err(|e|e.to_string())?;
            let identity_unchanged:bool = reader.query_row("SELECT remote_identity IS ?3 FROM flashcard_cloud_media_receipts WHERE namespace=?1 AND hash=?2", params![ns,hash,remote_identity], |r|r.get(0)).optional().map_err(|e|e.to_string())?.unwrap_or(false);
            if stable && identity_unchanged {
                continue;
            }
        }
        let (mut c, _writer) = open_write_database(db)?;
        let tx = c.transaction().map_err(|e| e.to_string())?;
        register_verified(&tx, blobs, &hash, &mime, checked || force)?;
        tx.execute("INSERT INTO flashcard_cloud_media_receipts(namespace,hash,size,verified_sha,remote_identity) VALUES(?1,?2,?3,?2,?4) ON CONFLICT(namespace,hash) DO UPDATE SET size=excluded.size,verified_sha=excluded.verified_sha,remote_identity=excluded.remote_identity WHERE size<>excluded.size OR verified_sha<>excluded.verified_sha OR remote_identity IS NOT excluded.remote_identity",params![ns,hash,size,remote_identity]).map_err(|e|e.to_string())?;
        tx.execute(
            "DELETE FROM flashcard_cloud_media_queue WHERE namespace=?1 AND hash=?2",
            params![ns, hash],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("UPDATE flashcard_cloud_media_candidates SET state='complete' WHERE namespace=?1 AND batch=?2 AND hash=?3",params![ns,batch,hash]).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
    }
    if force && report.pending_media > 0 {
        return Err("云端内容已合并，但附件未齐全；迁移没有切换当前服务".into());
    }
    let (c, _writer) = open_write_database(db)?;
    if report.pending_media == 0 {
        let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM flashcard_cloud_media_candidates WHERE namespace=?1 AND batch=?2",
            params![ns, batch],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM flashcard_cloud_media_batches WHERE namespace=?1 AND batch=?2",
            params![ns, batch],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
    } else {
        c.execute("UPDATE flashcard_cloud_media_batches SET state='pending' WHERE namespace=?1 AND batch=?2",params![ns,batch]).map_err(|e|e.to_string())?;
    }
    Ok(counts)
}

#[cfg(test)]
#[path = "media_delivery_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "media_delivery_version_tests.rs"]
mod version_tests;
