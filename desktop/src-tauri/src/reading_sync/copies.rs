//! Source-device copy receipts are descriptive metadata, never executable destinations.
use super::*;
const PREFIX: &str = "reading/copies-v1/changes/";
const MAX: usize = 64 * 1024;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Copy {
    id: String,
    provider: String,
    name: String,
    state: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Snapshot {
    format: u32,
    key: String,
    version: Version,
    device_label: String,
    observed_at: i64,
    copies: Vec<Copy>,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Summary {
    uploaded: usize,
    downloaded: usize,
    pending: usize,
}
pub(super) fn schema(c: &Connection) -> Result<(), String> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS reading_copy_snapshots(namespace TEXT,device TEXT,item_key TEXT,body TEXT NOT NULL,PRIMARY KEY(namespace,device,item_key));
    CREATE TABLE IF NOT EXISTS reading_copy_pending(namespace TEXT,id TEXT,body BLOB NOT NULL,PRIMARY KEY(namespace,id));
    CREATE TABLE IF NOT EXISTS reading_copy_applied(namespace TEXT,id TEXT,PRIMARY KEY(namespace,id));").map_err(|e|e.to_string())?;
    crate::local_database_maintenance::ensure_sequences(
        c,
        &["reading_copy_snapshots", "reading_copy_pending"],
    )
}
fn label(device: &str) -> String {
    let platform = match std::env::consts::OS {
        "windows" => "Windows",
        "android" => "Android",
        "macos" => "Mac",
        _ => "Hub",
    };
    format!(
        "{platform} · {}",
        device.chars().take(8).collect::<String>()
    )
}
fn title(
    c: &Connection,
    id: Option<&str>,
    provider: &str,
    root: Option<&str>,
) -> Result<String, String> {
    let has: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='libraries')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let value: Option<String> = if has {
        c.query_row("SELECT name FROM libraries WHERE (?1 IS NOT NULL AND id=?1) OR (?2 IS NOT NULL AND provider='obsidian' AND rtrim(replace(replace(lower(location),'\\','/'),'//?/',''),'/')=rtrim(replace(replace(lower(?2),'\\','/'),'//?/',''),'/')) ORDER BY id LIMIT 1",params![id,root],|r|r.get(0)).optional().map_err(|e|e.to_string())?
    } else {
        None
    };
    // Never fall back to a machine path or an external object identifier.
    Ok(value
        .filter(|v| {
            !v.trim().is_empty()
                && !v.contains(['/', '\\', ':'])
                && !v.chars().any(char::is_control)
        })
        .unwrap_or_else(|| {
            match provider {
                "obsidian" => "Obsidian 资料库",
                "craft" => "Craft 资料库",
                _ => "滴答清单",
            }
            .into()
        })
        .chars()
        .take(80)
        .collect())
}
fn local(c: &Connection, key: &str) -> Result<Vec<Copy>, String> {
    let mut copies = Vec::new();
    let mut q=c.prepare("SELECT e.destination,e.relative_path,e.media_pending,r.root FROM collection_obsidian_exports e LEFT JOIN collection_roots r ON e.destination=r.destination WHERE e.item_key=?1 AND e.file_hash<>'' ORDER BY e.destination").map_err(|e|e.to_string())?;
    let rows = q
        .query_map([key], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, bool>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (target, relative, partial, root) = row.map_err(|e| e.to_string())?;
        let safe = !relative.is_empty()
            && Path::new(&relative)
                .components()
                .all(|p| matches!(p, std::path::Component::Normal(_)));
        let state = if let Some(root) = root.as_deref().filter(|_| safe) {
            match fs::metadata(Path::new(root).join(&relative)) {
                Ok(m) if m.is_file() => {
                    if partial {
                        "partial"
                    } else {
                        "saved"
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => "missing",
                _ => "unknown",
            }
        } else {
            "unknown"
        };
        copies.push(Copy {
            id: hash(
                &serde_json::to_vec(&("obsidian", target, relative)).map_err(|e| e.to_string())?,
            ),
            provider: "obsidian".into(),
            name: title(c, None, "obsidian", root.as_deref())?,
            state: state.into(),
        });
    }
    let mut q=c.prepare("SELECT library_id,provider,object_id FROM collection_remote_copies WHERE item_key=?1 AND verified=1 AND parent_id<>'attachment' AND provider IN ('craft','dida365') ORDER BY library_id,object_id").map_err(|e|e.to_string())?;
    let rows = q
        .query_map([key], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (target, provider, object) = row.map_err(|e| e.to_string())?;
        copies.push(Copy {
            id: hash(
                &serde_json::to_vec(&(&provider, &target, object)).map_err(|e| e.to_string())?,
            ),
            name: title(c, Some(&target), &provider, None)?,
            provider,
            state: "saved".into(),
        });
    }
    copies.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(copies)
}
fn load(c: &Connection, ns: &str, device: &str, key: &str) -> Result<Option<Snapshot>, String> {
    let raw:Option<String>=c.query_row("SELECT body FROM reading_copy_snapshots WHERE namespace=?1 AND device=?2 AND item_key=?3",params![ns,device,key],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    raw.map(|v| serde_json::from_str(&v).map_err(|_| "副本记录损坏".into()))
        .transpose()
}
fn validate(s: &Snapshot) -> Result<(), String> {
    if s.format != 1
        || s.key.is_empty()
        || s.key.len() > 2048
        || s.version.clock == 0
        || s.version.clock > i64::MAX as u64 - 1000000
        || s.version.device.is_empty()
        || s.version.device.len() > 128
        || s.device_label.len() > 256
        || s.observed_at < 0
        || s.copies.len() > 128
    {
        return Err("副本同步记录无效".into());
    }
    let mut ids = std::collections::BTreeSet::new();
    for copy in &s.copies {
        if copy.id.len() != 64
            || !copy.id.bytes().all(|b| b.is_ascii_hexdigit())
            || !ids.insert(&copy.id)
            || !matches!(copy.provider.as_str(), "obsidian" | "craft" | "dida365")
            || !matches!(
                copy.state.as_str(),
                "saved" | "partial" | "missing" | "unknown"
            )
            || copy.name.len() > 256
            || copy.name.is_empty()
        {
            return Err("副本清单无效".into());
        }
    }
    Ok(())
}
fn accept(c: &Connection, ns: &str, s: &Snapshot) -> Result<(), String> {
    validate(s)?;
    if let Some(old) = load(c, ns, &s.version.device, &s.key)? {
        if old.version == s.version && old != *s {
            return Err("副本记录版本冲突".into());
        }
        if old.version >= s.version {
            return Ok(());
        }
    }
    meta(
        c,
        "reading_sync_clock",
        &metadata_u64(c, "reading_sync_clock", 0)
            .max(s.version.clock)
            .to_string(),
    )?;
    c.execute("INSERT INTO reading_copy_snapshots(namespace,device,item_key,body) VALUES(?1,?2,?3,?4) ON CONFLICT(namespace,device,item_key) DO UPDATE SET body=excluded.body",params![ns,s.version.device,s.key,serde_json::to_string(s).map_err(|e|e.to_string())?]).map(|_|()).map_err(|e|e.to_string())
}
fn next_stage_key(
    c: &Connection,
    ns: &str,
    device: &str,
    after: Option<&str>,
) -> Result<Option<String>, String> {
    let condition = if after.is_some() {
        " WHERE item_key>?3"
    } else {
        ""
    };
    let snapshot_condition = if after.is_some() {
        " AND item_key>?3"
    } else {
        ""
    };
    let sql=format!("SELECT min(item_key) FROM (SELECT item_key FROM (SELECT item_key FROM collection_obsidian_exports{condition} ORDER BY item_key LIMIT 1) UNION ALL SELECT item_key FROM (SELECT item_key FROM collection_remote_copies{condition} ORDER BY item_key LIMIT 1) UNION ALL SELECT item_key FROM (SELECT item_key FROM reading_copy_snapshots WHERE namespace=?1 AND device=?2{snapshot_condition} ORDER BY item_key LIMIT 1))");
    let mut statement = c.prepare_cached(&sql).map_err(|e| e.to_string())?;
    if let Some(after) = after {
        statement.query_row(params![ns, device, after], |r| r.get(0))
    } else {
        statement.query_row(params![ns, device], |r| r.get(0))
    }
    .map_err(|e| e.to_string())
}
fn stage(c: &Connection, ns: &str, device: &str) -> Result<usize, String> {
    capture_transaction(c, || stage_records(c, ns, device))
}
fn stage_records(c: &Connection, ns: &str, device: &str) -> Result<usize, String> {
    c.execute_batch("CREATE INDEX IF NOT EXISTS reading_copy_export_keys ON collection_obsidian_exports(item_key); CREATE INDEX IF NOT EXISTS reading_copy_remote_keys ON collection_remote_copies(item_key);").map_err(|e|e.to_string())?;
    let mut after = None;
    let mut count = 0;
    let mut deferred = 0;
    while let Some(key) = next_stage_key(c, ns, device, after.as_deref())? {
        after = Some(key.clone());
        let copies = local(c, &key)?;
        let old = load(c, ns, device, &key)?;
        if old
            .as_ref()
            .is_some_and(|v| v.copies == copies && v.device_label == label(device))
            || (old.is_none() && copies.is_empty())
        {
            continue;
        }
        if count >= 100 {
            deferred += 1;
            continue;
        }
        let snapshot = Snapshot {
            format: 1,
            key,
            version: next(c, device)?,
            device_label: label(device),
            observed_at: now_timestamp(),
            copies,
        };
        validate(&snapshot)?;
        let body = serde_json::to_vec(&snapshot).map_err(|e| e.to_string())?;
        if body.len() > MAX {
            return Err("副本记录超过单条 64 KiB 上限".into());
        }
        c.execute("DELETE FROM reading_copy_pending WHERE namespace=?1 AND json_extract(body,'$.key')=?2 AND json_extract(body,'$.version.device')=?3",params![ns,snapshot.key,device]).map_err(|e|e.to_string())?;
        c.execute(
            "INSERT OR IGNORE INTO reading_copy_pending(namespace,id,body) VALUES(?1,?2,?3)",
            params![ns, hash(&body), body],
        )
        .map_err(|e| e.to_string())?;
        accept(c, ns, &snapshot)?;
        count += 1;
    }
    Ok(deferred)
}
pub(crate) async fn sync(
    db: &PathBuf,
    remote: &dyn ReadingStore,
    ns: &str,
    device: &str,
) -> Result<Summary, String> {
    let deferred = {
        let (mut c, _writer) = open_write_database(db)?;
        let tx = c.transaction().map_err(|e| e.to_string())?;
        let n = stage(&tx, ns, device)?;
        tx.commit().map_err(|e| e.to_string())?;
        n
    };
    let mut report = Summary {
        pending: deferred,
        ..Summary::default()
    };
    let pending = {
        let c = open_database(db)?;
        let mut q=c.prepare("SELECT id,body FROM reading_copy_pending WHERE namespace=?1 ORDER BY local_seq LIMIT 100").map_err(|e|e.to_string())?;
        let rows = q
            .query_map([ns], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows
    };
    for (id, bytes) in pending {
        remote
            .put_verified(&remote.key(&format!("{PREFIX}{id}.json")), &bytes)
            .await?;
        let (mut c, _writer) = open_write_database(db)?;
        let tx = c.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT OR IGNORE INTO reading_copy_applied VALUES(?1,?2)",
            params![ns, id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM reading_copy_pending WHERE namespace=?1 AND id=?2",
            params![ns, id],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        report.uploaded += 1;
    }
    let inventory = crate::cloud_inventory::acquire_receive(
        db,
        remote,
        ns,
        "reading-copies",
        PREFIX,
        "reading_copy_applied",
    )
    .await?;
    let prefix = remote.key(PREFIX);
    let mut receive_after = None;
    while report.downloaded < 100 {
        let Some(key) = inventory.next_unapplied(
            &open_database(db)?,
            "reading_copy_applied",
            receive_after.as_deref(),
        )?
        else {
            break;
        };
        receive_after = Some(key.clone());
        let id = key
            .strip_prefix(&prefix)
            .and_then(|v| v.strip_suffix(".json"))
            .filter(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or("副本对象身份无效")?;
        let bytes = remote.get(&key, MAX).await?.ok_or("云端副本记录已缺失")?;
        if hash(&bytes) != id {
            return Err("副本记录校验失败，未导入".into());
        }
        let snapshot: Snapshot = serde_json::from_slice(&bytes).map_err(|_| "副本记录格式无效")?;
        let (mut c, _writer) = open_write_database(db)?;
        let tx = c.transaction().map_err(|e| e.to_string())?;
        accept(&tx, ns, &snapshot)?;
        tx.execute(
            "INSERT OR IGNORE INTO reading_copy_applied VALUES(?1,?2)",
            params![ns, id],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        report.downloaded += 1;
    }
    let c = open_database(db)?;
    let remote_pending = inventory.unapplied_count(&c, "reading_copy_applied")?;
    report.pending += remote_pending;
    if remote_pending == 0 {
        drop(c);
        let (c, _writer) = open_write_database(db)?;
        inventory.release(&c)?;
    }
    let c = open_database(db)?;
    report.pending += c
        .query_row(
            "SELECT count(*) FROM reading_copy_pending WHERE namespace=?1",
            [ns],
            |r| r.get::<_, usize>(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(report)
}
pub(crate) fn maintenance_import(c: &Connection, ns: &str, body: &[u8]) -> Result<(), String> {
    if body.len() > MAX {
        return Err("副本检查点对象超过上限".into());
    }
    let snapshot: Snapshot = serde_json::from_slice(body).map_err(|_| "副本检查点格式无效")?;
    accept(c, ns, &snapshot)
}
impl Summary {
    pub(crate) fn pending_count(&self) -> usize {
        self.pending
    }
}
pub(crate) fn maintenance_export_page(
    c: &Connection,
    ns: &str,
    after: i64,
) -> Result<Vec<(i64, Vec<u8>)>, String> {
    let mut q=c.prepare("SELECT local_seq,body FROM reading_copy_snapshots WHERE namespace=?1 AND local_seq>?2 ORDER BY local_seq LIMIT 100").map_err(|e|e.to_string())?;
    let rows = q
        .query_map(params![ns, after], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    rows.map(|r| {
        let (id, raw) = r.map_err(|e| e.to_string())?;
        let s: Snapshot = serde_json::from_str(&raw).map_err(|_| "副本投影损坏")?;
        validate(&s)?;
        let body = serde_json::to_vec(&s).map_err(|e| e.to_string())?;
        if body.len() > MAX {
            return Err("副本检查点超限".into());
        }
        Ok((id, body))
    })
    .collect()
}
fn view(c: &Connection, ns: &str, device: &str, key: &str) -> Result<Vec<Value>, String> {
    let mut result = Vec::new();
    let local = local(c, key)?;
    if !local.is_empty() {
        result.push(json!({"device":device,"deviceLabel":label(device),"local":true,"copies":local,"observedAt":null}));
    }
    let mut q=c.prepare("SELECT body FROM reading_copy_snapshots WHERE namespace=?1 AND item_key=?2 AND device<>?3 ORDER BY device").map_err(|e|e.to_string())?;
    let rows = q
        .query_map(params![ns, key, device], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let s: Snapshot =
            serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|_| "副本记录损坏")?;
        if !s.copies.is_empty() {
            result.push(json!({"device":s.version.device,"deviceLabel":s.device_label,"local":false,"copies":s.copies,"observedAt":s.observed_at}));
        }
    }
    Ok(result)
}
#[tauri::command]
pub(crate) fn reading_copy_status(app: AppHandle, key: String) -> Result<Vec<Value>, String> {
    let (c, _writer) = open_write_database(&database_path(&app)?)?;
    x_bookmarks::storage::schema(&c)?;
    let ns = object_store::namespace(&c).unwrap_or_default();
    let device = flashcard_sync_device_id(&c)?;
    view(&c, &ns, &device, &key)
}
#[cfg(test)]
mod tests;
