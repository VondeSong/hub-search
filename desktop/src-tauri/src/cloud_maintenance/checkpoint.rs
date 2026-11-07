use super::*;
use crate::flashcard_cloud_sync::{compact, Change};
#[cfg(test)]
mod tests;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Replacement {
    pub key: String,
    pub kind: String,
    pub hash: String,
}
#[cfg(test)]
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Proof {
    pub format: u32,
    pub generation: String,
    pub namespace_hash: String,
    pub device: String,
    pub created_at: i64,
    pub covered_hash: String,
    pub covered_objects: usize,
    pub replacements: Vec<Replacement>,
}
pub(super) fn scratch() -> Result<Connection, String> {
    let c = initialize_database(&PathBuf::from(":memory:"))?;
    x_bookmarks::storage::schema(&c)?;
    reading_sync::schema(&c)?;
    schema(&c)?;
    Ok(c)
}
pub(super) fn validate_object(kind: &str, key: &str, body: &[u8]) -> Result<(), String> {
    let hash = digest(body);
    if kind == "webdavSnapshot" {
        if key != format!("webdav-snapshot:{hash}") {
            return Err("WebDAV 闪卡快照身份不符".into());
        }
        let snapshot: FlashcardSyncSnapshot =
            serde_json::from_slice(body).map_err(|_| "WebDAV 闪卡快照格式无效")?;
        return flashcard_scheduler::validate_snapshot(&snapshot);
    }
    if kind == "flashcards" {
        if !key.ends_with(&format!("-{hash}.json")) {
            return Err("闪卡历史对象内容身份不符".into());
        }
        let change: Change = serde_json::from_slice(body).map_err(|_| "闪卡历史对象格式无效")?;
        if change.format != "hub-flashcard-changes" || !matches!(change.version, 2 | 3 | 4) {
            return Err("闪卡历史协议不受支持，请升级 Hub".into());
        }
        flashcard_scheduler::validate_snapshot(&change.snapshot)?;
    } else if !key.ends_with(&format!("/{hash}.json")) {
        return Err("阅读历史对象内容身份不符".into());
    }
    Ok(())
}
fn each_source(
    c: &Connection,
    ns: &str,
    id: &str,
    mut action: impl FnMut(&str, &[u8]) -> Result<(), String>,
) -> Result<(), String> {
    let mut q=c.prepare("SELECT kind,body FROM cloud_maintenance_objects WHERE namespace=?1 AND run=?2 AND replacement=0 ORDER BY key").map_err(|e|e.to_string())?;
    let rows = q
        .query_map(params![ns, id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (kind, body) = row.map_err(|e| e.to_string())?;
        action(&kind, &body)?;
    }
    Ok(())
}
/// Two passes through formal snapshots keep immutable review events when their delta
/// preceded the card/deck delta. Every source object is persisted and read individually.
pub(super) fn import_sources(
    c: &Connection,
    ns: &str,
    id: &str,
    scratch: &mut Connection,
) -> Result<(), String> {
    each_source(c, ns, id, |kind, body| {
        match kind {
            "flashcards" => {
                let mut change: Change =
                    serde_json::from_slice(body).map_err(|_| "闪卡历史对象损坏")?;
                change.snapshot.reviews.clear();
                compact(&mut change.snapshot)?;
                merge_flashcard_snapshot(scratch, &change.snapshot)?;
            }
            "webdavSnapshot" => {
                let mut snapshot: FlashcardSyncSnapshot =
                    serde_json::from_slice(body).map_err(|e| e.to_string())?;
                snapshot.reviews.clear();
                compact(&mut snapshot)?;
                merge_flashcard_snapshot(scratch, &snapshot)?;
            }
            "reading" => reading_sync::maintenance_import(scratch, body)?,
            "copies" => reading_sync::copies::maintenance_import(scratch, ns, body)?,
            "manifests" => reading_sync::media::maintenance_import(scratch, ns, body)?,
            "devices" => devices::maintenance_import(scratch, ns, body)?,
            _ => return Err("不支持的维护对象类别".into()),
        };
        Ok(())
    })?;
    each_source(c, ns, id, |kind, body| {
        if kind == "flashcards" {
            let mut change: Change =
                serde_json::from_slice(body).map_err(|_| "闪卡历史对象损坏")?;
            // All events, including events for deleted cards, are passed to the formal log owner.
            compact(&mut change.snapshot)?;
            merge_flashcard_snapshot(scratch, &change.snapshot)?;
        } else if kind == "webdavSnapshot" {
            let mut snapshot: FlashcardSyncSnapshot =
                serde_json::from_slice(body).map_err(|e| e.to_string())?;
            compact(&mut snapshot)?;
            merge_flashcard_snapshot(scratch, &snapshot)?;
        }
        Ok(())
    })
}
fn insert(
    c: &Connection,
    ns: &str,
    id: &str,
    key: &str,
    kind: &str,
    body: &[u8],
) -> Result<(), String> {
    validate_object(kind, key, body)?;
    let staged = progress::staged(c)?;
    if staged + body.len() as u64 > MAX_STAGED_BYTES {
        return Err("维护暂存超过 2 GB 安全上限，原历史未清理".into());
    }
    c.execute(
        "INSERT INTO cloud_maintenance_objects VALUES(?1,?2,?3,?4,?5,'pending',1) ON CONFLICT(namespace,run,key,replacement) DO UPDATE SET kind=excluded.kind,body=excluded.body,status=excluded.status",
        params![ns, id, key, kind, body],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
fn emit_flashcards(
    c: &Connection,
    ns: &str,
    id: &str,
    remote: &dyn Store,
    device: &str,
    scratch: &Connection,
) -> Result<(), String> {
    use crate::flashcard_snapshot::records;
    let mut empty = records::empty(scratch)?;
    empty.device_id = device.into();
    let shell = serde_json::to_value(empty).map_err(|e| e.to_string())?;
    let emit = |value: Value| -> Result<(), String> {
        let snapshot: FlashcardSyncSnapshot =
            serde_json::from_value(value).map_err(|e| e.to_string())?;
        flashcard_scheduler::validate_snapshot(&snapshot)?;
        let body = serde_json::to_vec(&Change {
            format: "hub-flashcard-changes".into(),
            version: 4,
            checkpoint: true,
            snapshot,
        })
        .map_err(|e| e.to_string())?;
        if body.len() > FLASHCARD_SYNC_MAX_SNAPSHOT_BYTES {
            return Err("单个闪卡检查点超过 32 MB，历史尚未清理".into());
        }
        let key = remote.key(&format!("changes/{device}-{}.json", digest(&body)));
        insert(c, ns, id, &key, "flashcards", &body)
    };
    // Settings are their own compatible delta; all arrays keep every normalized domain fact.
    let mut settings = shell.clone();
    settings["studySettings"] =
        serde_json::to_value(records::study(scratch)).map_err(|e| e.to_string())?;
    emit(settings)?;
    for field in records::FIELDS {
        let mut chunk = Vec::new();
        let mut bytes = 0;
        records::visit(scratch, field, |item| {
            let size = serde_json::to_vec(&item).map_err(|e| e.to_string())?.len() + 1;
            if !chunk.is_empty() && bytes + size > 8 * 1024 * 1024 {
                let mut part = shell.clone();
                part[field] = Value::Array(std::mem::take(&mut chunk));
                emit(part)?;
                bytes = 0;
            }
            chunk.push(item);
            bytes += size;
            Ok(())
        })?;
        if !chunk.is_empty() {
            let mut part = shell.clone();
            part[field] = Value::Array(chunk);
            emit(part)?;
        }
    }
    Ok(())
}
/// Canonical remote flashcard state for the official baseline owner. This reads generated
/// compatible pieces rather than collecting all historical deltas into a giant vector.
pub(super) fn flashcard_checkpoint(
    c: &Connection,
    ns: &str,
    id: &str,
) -> Result<Connection, String> {
    let mut restored = scratch()?;
    for reviews in [false, true] {
        let mut q=c.prepare("SELECT body FROM cloud_maintenance_objects WHERE namespace=?1 AND run=?2 AND replacement=1 AND kind='flashcards' ORDER BY key").map_err(|e|e.to_string())?;
        let rows = q
            .query_map(params![ns, id], |r| r.get::<_, Vec<u8>>(0))
            .map_err(|e| e.to_string())?;
        for row in rows {
            let mut change: Change = serde_json::from_slice(&row.map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            if !reviews {
                change.snapshot.reviews.clear();
            }
            merge_flashcard_snapshot(&mut restored, &change.snapshot)?;
        }
    }
    Ok(restored)
}
fn fingerprint(scratch: &Connection, ns: &str) -> Result<BTreeMap<&'static str, String>, String> {
    use std::io::Write;
    let mut domains = BTreeMap::new();
    domains.insert(
        "flashcards",
        crate::flashcard_snapshot::records::content_hash(scratch)?,
    );
    scratch.execute_batch("CREATE TEMP TABLE IF NOT EXISTS maintenance_domain_hashes(hash TEXT NOT NULL); CREATE INDEX IF NOT EXISTS maintenance_domain_hashes_order ON maintenance_domain_hashes(hash);").map_err(|e|e.to_string())?;
    for kind in ["reading", "copies", "manifests", "devices"] {
        scratch
            .execute("DELETE FROM maintenance_domain_hashes", [])
            .map_err(|e| e.to_string())?;
        let mut after = 0;
        loop {
            let rows = match kind {
                "reading" => reading_sync::maintenance_export_page(scratch, after)?,
                "copies" => reading_sync::copies::maintenance_export_page(scratch, ns, after)?,
                "manifests" => reading_sync::media::maintenance_export_page(scratch, ns, after)?,
                _ => devices::maintenance_export_page(scratch, ns, after)?,
            };
            if rows.is_empty() {
                break;
            }
            for (row, body) in rows {
                after = row;
                scratch
                    .execute(
                        "INSERT INTO maintenance_domain_hashes VALUES(?1)",
                        [digest(&body)],
                    )
                    .map_err(|e| e.to_string())?;
            }
        }
        let mut hash = proof_stream::HashWriter::new();
        hash.write_all(b"[").map_err(|e| e.to_string())?;
        let mut q = scratch
            .prepare("SELECT hash FROM maintenance_domain_hashes ORDER BY hash")
            .map_err(|e| e.to_string())?;
        let mut rows = q.query([]).map_err(|e| e.to_string())?;
        let mut first = true;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            if !first {
                hash.write_all(b",").map_err(|e| e.to_string())?;
            }
            first = false;
            let item: String = row.get(0).map_err(|e| e.to_string())?;
            serde_json::to_writer(&mut hash, &item).map_err(|e| e.to_string())?;
        }
        hash.write_all(b"]").map_err(|e| e.to_string())?;
        domains.insert(kind, hash.finish());
    }
    scratch
        .execute("DELETE FROM maintenance_domain_hashes", [])
        .map_err(|e| e.to_string())?;
    Ok(domains)
}
pub(super) fn verify_coverage(
    c: &Connection,
    ns: &str,
    id: &str,
    expected: &Connection,
) -> Result<(), String> {
    let mut restored = scratch()?;
    // The same two-pass domain import is used for generated checkpoints and original logs.
    for reviews in [false, true] {
        let mut q=c.prepare("SELECT kind,body FROM cloud_maintenance_objects WHERE namespace=?1 AND run=?2 AND replacement=1 ORDER BY key").map_err(|e|e.to_string())?;
        let rows = q
            .query_map(params![ns, id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (kind, body) = row.map_err(|e| e.to_string())?;
            if kind == "flashcards" {
                let mut change: Change =
                    serde_json::from_slice(&body).map_err(|e| e.to_string())?;
                if !reviews {
                    change.snapshot.reviews.clear();
                }
                merge_flashcard_snapshot(&mut restored, &change.snapshot)?;
            } else if !reviews {
                match kind.as_str() {
                    "reading" => reading_sync::maintenance_import(&restored, &body)?,
                    "copies" => reading_sync::copies::maintenance_import(&restored, ns, &body)?,
                    "manifests" => reading_sync::media::maintenance_import(&restored, ns, &body)?,
                    "devices" => devices::maintenance_import(&restored, ns, &body)?,
                    _ => return Err("检查点类型无效".into()),
                }
            }
        }
    }
    if fingerprint(expected, ns)? != fingerprint(&restored, ns)? {
        return Err("检查点未覆盖完整领域状态；历史未清理".into());
    }
    Ok(())
}
pub(super) fn build(c: &Connection, remote: &dyn Store, ns: &str, id: &str) -> Result<(), String> {
    let unread = progress::count(c, ns, id, false, "pending")?;
    if unread != 0 {
        return Err("历史对象尚未全部读取；不能生成覆盖检查点".into());
    }
    let mut scratch = scratch()?;
    import_sources(c, ns, id, &mut scratch)?;
    let device = flashcard_sync_device_id(c)?;
    let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
    progress::invalidate_delete(&tx, ns, id)?;
    tx.execute(
        "DELETE FROM cloud_maintenance_objects WHERE namespace=?1 AND run=?2 AND replacement=1",
        params![ns, id],
    )
    .map_err(|e| e.to_string())?;
    let has_flashcards:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM cloud_maintenance_objects WHERE namespace=?1 AND run=?2 AND replacement=0 AND kind IN ('flashcards','webdavSnapshot'))",params![ns,id],|r|r.get(0)).map_err(|e|e.to_string())?;
    if has_flashcards {
        emit_flashcards(&tx, ns, id, remote, &device, &scratch)?;
    }
    for (kind, prefix) in [
        ("reading", "reading/v1/changes/"),
        ("copies", "reading/copies-v1/changes/"),
        ("manifests", "reading/media-v1/manifests/"),
        ("devices", DEVICE_PREFIX),
    ] {
        let mut after = 0;
        loop {
            let page = match kind {
                "reading" => reading_sync::maintenance_export_page(&scratch, after)?,
                "copies" => reading_sync::copies::maintenance_export_page(&scratch, ns, after)?,
                "manifests" => reading_sync::media::maintenance_export_page(&scratch, ns, after)?,
                _ => devices::maintenance_export_page(&scratch, ns, after)?,
            };
            if page.is_empty() {
                break;
            }
            for (row, body) in page {
                after = row;
                let key = remote.key(&format!("{prefix}{}.json", digest(&body)));
                insert(&tx, ns, id, &key, kind, &body)?;
            }
        }
    }
    verify_coverage(&tx, ns, id, &scratch)?;
    let raw = proof_stream::build(&tx, ns, id, &device)?;
    tx.execute("UPDATE cloud_maintenance_runs SET proof=?3,state='prepared',phase='publish',error='' WHERE namespace=?1 AND id=?2",params![ns,id,raw]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}
#[cfg(test)]
pub(super) fn proof(c: &Connection, ns: &str, id: &str) -> Result<Proof, String> {
    let raw: String = c
        .query_row(
            "SELECT proof FROM cloud_maintenance_runs WHERE namespace=?1 AND id=?2",
            params![ns, id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let p: Proof = serde_json::from_str(&raw).map_err(|_| "检查点证明尚未准备好或已损坏")?;
    if p.format != 1
        || p.generation != id
        || p.namespace_hash != digest(ns.as_bytes())
        || !valid_hash(&p.generation)
        || !valid_hash(&p.covered_hash)
        || p.replacements.is_empty()
        || p.replacements.len() > MAX_OBJECTS
    {
        return Err("检查点证明无效".into());
    }
    Ok(p)
}
