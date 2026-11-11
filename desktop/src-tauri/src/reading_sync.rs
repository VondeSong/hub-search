//! Reading replication is a data projection. It never enqueues source/library actions.
pub(crate) mod incremental;
use super::*;
use crate::collection_models::Post;
#[cfg(test)]
use crate::flashcard_object_store::OssStore;
pub(crate) mod object_store;
use object_store::Store as ReadingStore;
pub(crate) mod copies;
#[cfg(any(target_os = "android", test))]
mod foreground;
pub(crate) mod media;

#[cfg(target_os = "android")]
static FOREGROUND: std::sync::Mutex<foreground::ForegroundGate> =
    std::sync::Mutex::new(foreground::ForegroundGate::new());

#[cfg(target_os = "android")]
pub(crate) fn set_foreground(visible: bool) {
    if let Ok(mut gate) = FOREGROUND.lock() {
        gate.set_visible(visible);
    }
}

pub(crate) static LOCK: AsyncMutex<()> = AsyncMutex::const_new(());
const MAX_RECORD: usize = 2 * 1024 * 1024;
const MAX_BATCH: usize = 32 * 1024 * 1024;
const PREFIX: &str = "reading/v1/changes/";

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(deny_unknown_fields)]
struct Version {
    clock: u64,
    device: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Field<T> {
    version: Version,
    value: T,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Body {
    post: Post,
    collected_at: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Record {
    key: String,
    body: Field<Option<Body>>,
    status: Field<String>,
    lifecycle: Field<String>,
    tags: BTreeMap<String, Field<bool>>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Change {
    format: String,
    version: u32,
    record: Record,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Report {
    uploaded: usize,
    downloaded: usize,
    pending: usize,
    completed_at: i64,
    #[serde(default)]
    media: Option<media::Summary>,
    #[serde(default)]
    copies: Option<copies::Summary>,
}

pub(crate) fn schema(c: &Connection) -> Result<(), String> {
    media::schema(c)?;
    copies::schema(c)?;
    c.execute_batch("CREATE TABLE IF NOT EXISTS reading_sync_records(item_key TEXT PRIMARY KEY,body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS reading_sync_pending(namespace TEXT NOT NULL,id TEXT NOT NULL,body BLOB NOT NULL,PRIMARY KEY(namespace,id));
        CREATE TABLE IF NOT EXISTS reading_sync_applied(namespace TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(namespace,id));
        CREATE TABLE IF NOT EXISTS reading_sync_uploaded(namespace TEXT NOT NULL,item_key TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(namespace,item_key));
        CREATE TABLE IF NOT EXISTS reading_cloud_items(item_key TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS reading_cloud_passive(item_key TEXT PRIMARY KEY);") .map_err(|e|e.to_string())?;
    crate::local_database_maintenance::ensure_sequences(
        c,
        &["reading_sync_records", "reading_sync_pending"],
    )
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn meta(c: &Connection, key: &str, value: &str) -> Result<(), String> {
    c.execute("INSERT INTO metadata(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,value]).map(|_|()).map_err(|e|e.to_string())
}
fn next(c: &Connection, device: &str) -> Result<Version, String> {
    let clock = metadata_u64(c, "reading_sync_clock", 0)
        .checked_add(1)
        .ok_or("阅读同步版本已超出范围")?;
    if clock > i64::MAX as u64 {
        return Err("阅读同步版本已超出范围".into());
    }
    meta(c, "reading_sync_clock", &clock.to_string())?;
    Ok(Version {
        clock,
        device: device.into(),
    })
}
fn field<T>(c: &Connection, device: &str, value: T) -> Result<Field<T>, String> {
    Ok(Field {
        version: next(c, device)?,
        value,
    })
}
fn update<T: PartialEq>(
    c: &Connection,
    device: &str,
    current: &mut Field<T>,
    value: T,
) -> Result<(), String> {
    if current.value != value {
        *current = field(c, device, value)?;
    }
    Ok(())
}
fn load(c: &Connection, key: &str) -> Result<Option<Record>, String> {
    c.query_row(
        "SELECT body FROM reading_sync_records WHERE item_key=?1",
        [key],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| e.to_string())?
    .map(|s| serde_json::from_str(&s).map_err(|e| format!("阅读同步记录损坏：{e}")))
    .transpose()
}
fn save(c: &Connection, r: &Record) -> Result<(), String> {
    c.execute("INSERT INTO reading_sync_records(item_key,body) VALUES(?1,?2) ON CONFLICT(item_key) DO UPDATE SET body=excluded.body",params![r.key,serde_json::to_string(r).map_err(|e|e.to_string())?]).map(|_|()).map_err(|e|e.to_string())
}

// Compare the committed domain with the last projection before receiving remote changes.
// Each field/tag gets a logical version; wall-clock skew cannot decide merge order.
fn capture_transaction<T>(
    c: &Connection,
    action: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    c.execute_batch("SAVEPOINT reading_capture")
        .map_err(|e| e.to_string())?;
    match action() {
        Ok(value) => {
            c.execute_batch("RELEASE reading_capture")
                .map_err(|e| e.to_string())?;
            Ok(value)
        }
        Err(error) => {
            c.execute_batch("ROLLBACK TO reading_capture; RELEASE reading_capture")
                .map_err(|e| e.to_string())?;
            Err(error)
        }
    }
}
#[cfg(test)]
thread_local! { static CAPTURE_VISITS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) }; }

fn capture_record(c: &Connection, device: &str, key: &str) -> Result<Record, String> {
    #[cfg(test)]
    CAPTURE_VISITS.with(|visits| visits.set(visits.get() + 1));
    let previous = load(c, &key)?;
    let row: Option<(String, i64, i64)> = c
        .query_row(
            "SELECT post_json,collected_at,read_at FROM collection_x_items WHERE item_key=?1",
            [&key],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let life: String = c
        .query_row(
            "SELECT state FROM collection_lifecycle WHERE item_key=?1",
            [&key],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| "active".into());
    let life = if matches!(life.as_str(), "deleted" | "deleting")
        || previous
            .as_ref()
            .is_some_and(|r| r.lifecycle.value == "deleted")
    {
        "deleted"
    } else {
        life.as_str()
    };
    if row.is_none() && life != "deleted" {
        return Err("阅读正文缺失，已停止同步以免误删云端内容".into());
    }
    let body = if life == "deleted" {
        None
    } else {
        let (json, collected_at, _) = row.as_ref().unwrap();
        let mut post = serde_json::from_str(json).map_err(|_| "阅读正文损坏")?;
        sanitize(&mut post);
        Some(Body {
            post,
            collected_at: *collected_at,
        })
    };
    let properties: Option<(String, String)> = c
        .query_row(
            "SELECT status,tags FROM collection_x_properties WHERE item_key=?1",
            [&key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let (status, tags) = properties.unwrap_or_else(|| {
        (
            if row.as_ref().is_some_and(|r| r.2 > 0) {
                "read"
            } else {
                "unread"
            }
            .into(),
            "[]".into(),
        )
    });
    let tags: std::collections::BTreeSet<String> = serde_json::from_str::<Vec<String>>(&tags)
        .map_err(|_| "阅读标签损坏")?
        .into_iter()
        .collect();
    let mut r = if let Some(r) = previous.clone() {
        r
    } else {
        Record {
            key: key.to_owned(),
            body: field(c, device, None)?,
            status: field(c, device, status.clone())?,
            lifecycle: field(c, device, life.to_string())?,
            tags: BTreeMap::new(),
        }
    };
    update(c, device, &mut r.body, body)?;
    update(c, device, &mut r.status, status)?;
    update(c, device, &mut r.lifecycle, life.into())?;
    let all = r
        .tags
        .keys()
        .cloned()
        .chain(tags.iter().cloned())
        .collect::<std::collections::BTreeSet<_>>();
    for tag in all {
        let present = tags.contains(&tag);
        if let Some(old) = r.tags.get_mut(&tag) {
            update(c, device, old, present)?;
        } else {
            r.tags.insert(tag, field(c, device, present)?);
        }
    }
    validate(&r)?;
    if previous.as_ref() != Some(&r) {
        save(c, &r)?;
    }
    Ok(r)
}
fn capture_one(c: &Connection, device: &str, key: &str) -> Result<Option<Record>, String> {
    capture_transaction(c, || {
        let exists:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM collection_x_items WHERE item_key=?1) OR EXISTS(SELECT 1 FROM collection_lifecycle WHERE item_key=?1 AND state IN ('deleted','deleting')) OR EXISTS(SELECT 1 FROM reading_sync_records WHERE item_key=?1)",[key],|r|r.get(0)).map_err(|e|e.to_string())?;
        if exists {
            capture_record(c, device, key).map(Some)
        } else {
            Ok(None)
        }
    })
}
fn next_capture_key(c: &Connection, after: Option<&str>) -> Result<Option<String>, String> {
    // Each branch reads its first indexed key, so merging the three domains has no prefix scan.
    let condition = if after.is_some() {
        " WHERE item_key>?1"
    } else {
        ""
    };
    let life_condition = if after.is_some() {
        " AND item_key>?1"
    } else {
        ""
    };
    let sql=format!("SELECT min(item_key) FROM (SELECT item_key FROM (SELECT item_key FROM collection_x_items{condition} ORDER BY item_key LIMIT 1) UNION ALL SELECT item_key FROM (SELECT item_key FROM collection_lifecycle WHERE state IN ('deleted','deleting'){life_condition} ORDER BY item_key LIMIT 1) UNION ALL SELECT item_key FROM (SELECT item_key FROM reading_sync_records{condition} ORDER BY item_key LIMIT 1))");
    let mut statement = c.prepare_cached(&sql).map_err(|e| e.to_string())?;
    if let Some(after) = after {
        statement.query_row([after], |r| r.get(0))
    } else {
        statement.query_row([], |r| r.get(0))
    }
    .map_err(|e| e.to_string())
}
fn visit_captured(
    c: &Connection,
    device: &str,
    mut visit: impl FnMut(Record) -> Result<(), String>,
) -> Result<(), String> {
    capture_transaction(c, || {
        c.execute_batch("CREATE INDEX IF NOT EXISTS reading_capture_deleted_keys ON collection_lifecycle(item_key) WHERE state IN ('deleted','deleting')").map_err(|e|e.to_string())?;
        let mut after = None;
        while let Some(key) = next_capture_key(c, after.as_deref())? {
            visit(capture_record(c, device, &key)?)?;
            after = Some(key);
        }
        Ok(())
    })
}
#[cfg(test)]
fn capture(c: &Connection, device: &str, only: Option<&str>) -> Result<Vec<Record>, String> {
    let mut out = Vec::new();
    if let Some(key) = only {
        out.extend(capture_one(c, device, key)?);
    } else {
        visit_captured(c, device, |record| {
            out.push(record);
            Ok(())
        })?;
    }
    Ok(out)
}
fn validate(r: &Record) -> Result<(), String> {
    if r.key.is_empty()
        || r.key.len() > 2048
        || !matches!(
            r.status.value.as_str(),
            "unread" | "read" | "in_progress" | "abandoned"
        )
        || !matches!(
            r.lifecycle.value.as_str(),
            "active" | "archived" | "deleted"
        )
    {
        return Err("阅读同步字段无效".into());
    }
    if r.lifecycle.value != "deleted" && r.body.value.is_none() {
        return Err("阅读同步缺少正文".into());
    }
    if r.tags.len() > 4096
        || r.tags
            .keys()
            .any(|t| t.is_empty() || t.chars().count() > 80)
    {
        return Err("阅读同步标签超出范围".into());
    }
    for v in std::iter::once(&r.body.version)
        .chain([&r.status.version, &r.lifecycle.version])
        .chain(r.tags.values().map(|f| &f.version))
    {
        if v.clock == 0
            || v.clock > i64::MAX as u64 - 1000000
            || v.device.is_empty()
            || v.device.len() > 128
        {
            return Err("阅读同步版本无效".into());
        }
    }
    Ok(())
}
fn sanitize(post: &mut Post) {
    post.thread_cursors.clear();
    post.thread_seen_cursors.clear();
    post.thread_error.clear();
    for child in &mut post.thread {
        sanitize(child);
    }
    if let Some(quote) = &mut post.quote {
        sanitize(quote);
    }
}
fn combine<T: Clone + PartialEq>(local: &mut Field<T>, other: &Field<T>) -> Result<(), String> {
    if other.version == local.version && other.value != local.value {
        return Err("阅读同步出现重复版本冲突，未覆盖本地内容".into());
    }
    if other.version > local.version {
        *local = other.clone();
    }
    Ok(())
}
fn merge(c: &Connection, incoming: Record) -> Result<(), String> {
    validate(&incoming)?;
    let old = load(c, &incoming.key)?;
    let mut merged = old.clone().unwrap_or_else(|| incoming.clone());
    let deleted = merged.lifecycle.value == "deleted" || incoming.lifecycle.value == "deleted";
    combine(&mut merged.body, &incoming.body)?;
    combine(&mut merged.status, &incoming.status)?;
    combine(&mut merged.lifecycle, &incoming.lifecycle)?;
    for (tag, value) in &incoming.tags {
        if let Some(old) = merged.tags.get_mut(tag) {
            combine(old, value)?;
        } else {
            merged.tags.insert(tag.clone(), value.clone());
        }
    }
    if deleted {
        // Deletion is permanent for this identity, including against newer offline body edits.
        merged.lifecycle = old
            .as_ref()
            .map(|r| &r.lifecycle)
            .into_iter()
            .chain(std::iter::once(&incoming.lifecycle))
            .filter(|f| f.value == "deleted")
            .max_by_key(|f| &f.version)
            .unwrap()
            .clone();
    }
    validate(&merged)?;
    bytes(merged.clone())?;
    let max = std::iter::once(&incoming.body.version)
        .chain([&incoming.status.version, &incoming.lifecycle.version])
        .chain(incoming.tags.values().map(|f| &f.version))
        .map(|v| v.clock)
        .max()
        .unwrap_or(0);
    meta(
        c,
        "reading_sync_clock",
        &metadata_u64(c, "reading_sync_clock", 0)
            .max(max)
            .to_string(),
    )?;
    if old.as_ref() == Some(&merged) {
        return Ok(());
    }
    project(c, &merged)?;
    save(c, &merged)
}
fn project(c: &Connection, r: &Record) -> Result<(), String> {
    let exists: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM collection_x_items WHERE item_key=?1)",
            [&r.key],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !exists {
        c.execute(
            "INSERT OR IGNORE INTO reading_cloud_items VALUES(?1)",
            [&r.key],
        )
        .map_err(|e| e.to_string())?;
    }
    c.execute(
        "INSERT OR IGNORE INTO reading_cloud_passive VALUES(?1)",
        [&r.key],
    )
    .map_err(|e| e.to_string())?;
    c.execute("INSERT INTO collection_lifecycle(item_key,state,revision) VALUES(?1,?2,1) ON CONFLICT(item_key) DO UPDATE SET state=excluded.state,revision=revision+1",params![r.key,r.lifecycle.value]).map_err(|e|e.to_string())?;
    if r.lifecycle.value == "deleted" {
        c.execute(
            "DELETE FROM collection_library_pending WHERE item_key=?1",
            [&r.key],
        )
        .map_err(|e| e.to_string())?;
        c.execute("DELETE FROM collection_x_items WHERE item_key=?1", [&r.key])
            .map_err(|e| e.to_string())?;
        c.execute(
            "DELETE FROM collection_x_properties WHERE item_key=?1",
            [&r.key],
        )
        .map_err(|e| e.to_string())?;
    } else if let Some(body) = &r.body.value {
        let json = serde_json::to_string(&body.post).map_err(|e| e.to_string())?;
        c.execute("INSERT INTO collection_x_items(item_key,account,post_json,content_hash,collected_at,captured_at,read_at,read_version) VALUES(?1,'',?2,?3,?4,?5,?6,1) ON CONFLICT(item_key) DO UPDATE SET post_json=excluded.post_json,content_hash=excluded.content_hash,collected_at=excluded.collected_at,read_at=excluded.read_at,read_version=read_version+1",params![r.key,json,hash(json.as_bytes()),body.collected_at,now_timestamp(),if matches!(r.status.value.as_str(),"read"|"abandoned"){chrono::Utc::now().timestamp_millis().max(1)}else{0}]).map_err(|e|e.to_string())?;
        let tags: Vec<_> = r
            .tags
            .iter()
            .filter(|(_, v)| v.value)
            .map(|(k, _)| k)
            .collect();
        c.execute("INSERT INTO collection_x_properties VALUES(?1,?2,?3) ON CONFLICT(item_key) DO UPDATE SET status=excluded.status,tags=excluded.tags",params![r.key,r.status.value,json!(tags).to_string()]).map_err(|e|e.to_string())?;
    }
    // Invalidate stale local side-effect requests. Never generate or replay them from cloud.
    for table in ["collection_x_outbox", "collection_property_updates"] {
        c.execute(&format!("DELETE FROM {table} WHERE item_key=?1"), [&r.key])
            .map_err(|e| e.to_string())?;
    }
    if r.lifecycle.value == "deleted" {
        c.execute("UPDATE collection_library_jobs SET phase='cancelled',error='云端已删除此阅读条目；本机已有外部副本保留' WHERE item_key=?1 AND action<>'delete'",[&r.key]).map_err(|e|e.to_string())?;
    }
    Ok(())
}
fn bytes(record: Record) -> Result<Vec<u8>, String> {
    let bytes = serde_json::to_vec(&Change {
        format: "hub-reading-changes".into(),
        version: 1,
        record,
    })
    .map_err(|e| e.to_string())?;
    if bytes.len() > MAX_RECORD {
        return Err("单篇阅读内容超过 2 MB，未上传；本地内容保留".into());
    }
    Ok(bytes)
}
fn stage(c: &Connection, namespace: &str, device: &str) -> Result<(), String> {
    capture_transaction(c, || {
        incremental::capture_dirty(c, device)?;
        incremental::visit_changes(c, namespace, |r| {
            let key = r.key.clone();
            let body = bytes(r)?;
            let id = hash(&body);
            let known:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM reading_sync_uploaded WHERE namespace=?1 AND item_key=?2 AND id=?3)",params![namespace,key,id],|r|r.get(0)).map_err(|e|e.to_string())?;
            if !known {
                c.execute(
                "INSERT OR IGNORE INTO reading_sync_pending(namespace,id,body) VALUES(?1,?2,?3)",
                params![namespace, id, body],
            )
            .map_err(|e| e.to_string())?;
            }
            Ok(())
        })
    })
}

// Uses the real object transport; tests supply only an HTTP endpoint, not a merge mock.
pub(super) async fn sync_database(
    database: &PathBuf,
    remote: &dyn ReadingStore,
    namespace: &str,
    device: &str,
) -> Result<Report, String> {
    let mut report = Report::default();
    {
        let (mut c, _writer) = open_write_database(database)?;
        x_bookmarks::storage::schema(&c)?;
        let tx = c.transaction().map_err(|e| e.to_string())?;
        stage(&tx, namespace, device)?;
        tx.commit().map_err(|e| e.to_string())?;
    }
    let pending = {
        let c = open_database(database)?;
        let mut q=c.prepare("SELECT id,body FROM reading_sync_pending WHERE namespace=?1 ORDER BY local_seq LIMIT 100").map_err(|e|e.to_string())?;
        let rows = q
            .query_map([namespace], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
            })
            .map_err(|e| e.to_string())?;
        let mut batch = Vec::new();
        let mut size = 0;
        for row in rows {
            let row = row.map_err(|e| e.to_string())?;
            if size + row.1.len() > MAX_BATCH {
                break;
            }
            size += row.1.len();
            batch.push(row);
        }
        batch
    };
    for (id, body) in pending {
        remote
            .put_verified(&remote.key(&format!("{PREFIX}{id}.json")), &body)
            .await?;
        let change: Change = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
        let (mut c, _writer) = open_write_database(database)?;
        let tx = c.transaction().map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO reading_sync_uploaded VALUES(?1,?2,?3) ON CONFLICT(namespace,item_key) DO UPDATE SET id=excluded.id",params![namespace,change.record.key,id]).map_err(|e|e.to_string())?;
        tx.execute(
            "INSERT OR IGNORE INTO reading_sync_applied VALUES(?1,?2)",
            params![namespace, id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM reading_sync_pending WHERE namespace=?1 AND id=?2",
            params![namespace, id],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        report.uploaded += 1;
    }
    let prefix = remote.key(PREFIX);
    let inventory = crate::cloud_inventory::acquire_receive(
        database,
        remote,
        namespace,
        "reading-changes",
        PREFIX,
        "reading_sync_applied",
    )
    .await?;
    let mut consumed = 0;
    let mut receive_after = None;
    while consumed < MAX_BATCH && report.downloaded < 100 {
        let Some(key) = inventory.next_unapplied(
            &open_database(database)?,
            "reading_sync_applied",
            receive_after.as_deref(),
        )?
        else {
            break;
        };
        receive_after = Some(key.clone());
        let id = key
            .strip_prefix(&prefix)
            .and_then(|v| v.strip_suffix(".json"))
            .ok_or("阅读云对象名称无效")?;
        if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("阅读云对象身份无效".into());
        }
        let body = remote
            .get(&key, MAX_RECORD)
            .await?
            .ok_or("阅读云对象在读取时消失，请重试")?;
        if hash(&body) != id {
            return Err("阅读云内容校验失败，未导入".into());
        }
        consumed += body.len();
        let change: Change = serde_json::from_slice(&body).map_err(|_| "阅读云格式无效")?;
        if change.version != 1 || change.format != "hub-reading-changes" {
            return Err("阅读云协议不受支持，请升级 Hub".into());
        }
        let (mut c, _writer) = open_write_database(database)?;
        let tx = c.transaction().map_err(|e| e.to_string())?;
        capture_one(&tx, device, &change.record.key)?; // Preserve edits committed while network requests were in flight.
        merge(&tx, change.record)?;
        tx.execute(
            "INSERT OR IGNORE INTO reading_sync_applied VALUES(?1,?2)",
            params![namespace, id],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        report.downloaded += 1;
    }
    {
        let (c, _writer) = open_write_database(database)?;
        let pending = inventory.unapplied_count(&c, "reading_sync_applied")?;
        report.pending += pending;
        if pending == 0 {
            inventory.release(&c)?;
        }
    }
    {
        let (mut c, _writer) = open_write_database(database)?;
        let tx = c.transaction().map_err(|e| e.to_string())?;
        stage(&tx, namespace, device)?;
        report.pending += tx
            .query_row(
                "SELECT count(*) FROM reading_sync_pending WHERE namespace=?1",
                [namespace],
                |r| r.get::<_, usize>(0),
            )
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
    }
    report.completed_at = now_timestamp();
    Ok(report)
}

pub(crate) fn maintenance_capture(c: &Connection, device: &str) -> Result<(), String> {
    visit_captured(c, device, |_| Ok(()))
}
pub(crate) fn migration_pending(
    body: &Report,
    copies: &copies::Summary,
    media: &media::Summary,
) -> usize {
    body.pending + copies.pending_count() + media.pending_count()
}
pub(crate) fn migration_domain_identity(c: &Connection) -> Result<String, String> {
    struct DigestWriter(Sha256);
    impl std::io::Write for DigestWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.update(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut digest = DigestWriter(Sha256::new());
    digest.0.update(b"[");
    let mut first = true;
    visit_captured(c, "migration-preview", |record| {
        if !first {
            digest.0.update(b",");
        }
        first = false;
        serde_json::to_writer(&mut digest, &record).map_err(|e| e.to_string())
    })?;
    digest.0.update(b"]");
    Ok(format!("{:x}", digest.0.finalize()))
}

pub(crate) fn migration_domain_token(c: &Connection) -> Result<String, String> {
    let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
    let result = migration_domain_identity(&tx);
    tx.rollback().map_err(|e| e.to_string())?;
    result
}
pub(crate) fn maintenance_import(c: &Connection, body: &[u8]) -> Result<(), String> {
    if body.len() > MAX_RECORD {
        return Err("阅读检查点对象超过上限".into());
    }
    let change: Change = serde_json::from_slice(body).map_err(|_| "阅读检查点格式无效")?;
    if change.format != "hub-reading-changes" || change.version != 1 {
        return Err("阅读检查点协议不受支持".into());
    }
    merge(c, change.record)
}
pub(crate) fn maintenance_export_page(
    c: &Connection,
    after: i64,
) -> Result<Vec<(i64, Vec<u8>)>, String> {
    let mut q = c
        .prepare(
            "SELECT local_seq,body FROM reading_sync_records WHERE local_seq>?1 ORDER BY local_seq LIMIT 100",
        )
        .map_err(|e| e.to_string())?;
    let rows = q
        .query_map([after], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    let mut size = 0;
    for row in rows {
        let (id, raw) = row.map_err(|e| e.to_string())?;
        let r: Record = serde_json::from_str(&raw).map_err(|_| "阅读投影记录损坏")?;
        validate(&r)?;
        let body = bytes(r)?;
        if size + body.len() > MAX_BATCH {
            break;
        }
        size += body.len();
        result.push((id, body));
    }
    Ok(result)
}
pub(crate) fn require_source_preservation(c: &Connection) -> Result<(), String> {
    if cloud_sync::policy(c).reading {
        return Err("阅读云同步已启用：正文与附件尚未取得完整云端恢复回执，滴答原项已保留".into());
    }
    Ok(())
}
#[tauri::command]
pub(crate) fn get_reading_sync_status(app: AppHandle) -> Result<Value, String> {
    let c = open_database(&database_path(&app)?)?;
    Ok(
        json!({"supported":object_store::configuration(&c).is_ok(),"running":LOCK.try_lock().is_err(),"lastError":metadata_string(&c,"reading_sync_error"),"report":serde_json::from_str::<Value>(&metadata_string(&c,"reading_sync_report")).unwrap_or(Value::Null)}),
    )
}
#[tauri::command]
pub(crate) async fn sync_reading(app: AppHandle) -> Result<Report, String> {
    run(app, false).await
}
async fn run(app: AppHandle, auto: bool) -> Result<Report, String> {
    let _guard = LOCK.lock().await;
    run_locked(app, auto).await
}
async fn run_locked(app: AppHandle, auto: bool) -> Result<Report, String> {
    #[cfg(target_os = "android")]
    if auto
        && !FOREGROUND
            .lock()
            .map_err(|_| "阅读前台状态不可用")?
            .visible()
    {
        return Err("返回应用后会自动补同步阅读内容".into());
    }
    let database = database_path(&app)?;
    let result: Result<Report, String> = async {
        let (remote, namespace, device) = {
            let (c, _writer) = open_write_database(&database)?;
            cloud_sync::require_reading(&c, auto)?;
            (
                object_store::store(&app, &c)?,
                object_store::namespace(&c)?,
                flashcard_sync_device_id(&c)?,
            )
        };
        remote.check_network(&remote.key("reading/"))?;
        let mut report = sync_database(&database, &remote, &namespace, &device).await?;
        report.copies = Some(copies::sync(&database, &remote, &namespace, &device).await?);
        report.media = Some(media::sync(&database, &remote, &namespace, &device).await?);
        let _ =
            crate::cloud_maintenance::observe_sync_success(&database, &remote, &namespace).await;
        Ok(report)
    }
    .await;
    {
        let (c, _writer) = open_write_database(&database)?;
        match &result {
            Ok(r) => {
                meta(
                    &c,
                    "reading_sync_report",
                    &serde_json::to_string(r).map_err(|e| e.to_string())?,
                )?;
                meta(&c, "reading_sync_error", "")?;
            }
            Err(e) => meta(&c, "reading_sync_error", e)?,
        }
    }
    let _ = app.emit("hub-reading-cloud-changed", ());
    result
}
pub(crate) fn start_scheduler(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        while crate::background_workers::running() {
            #[cfg(target_os = "android")]
            if !FOREGROUND
                .lock()
                .map(|gate| gate.visible())
                .unwrap_or(false)
            {
                if !crate::background_workers::wait(Duration::from_secs(5)).await {
                    break;
                }
                continue;
            }
            // On Android, a lifecycle change can happen while another transfer
            // owns LOCK. Claim only after it is acquired, using the latest state.
            #[cfg(target_os = "android")]
            let _guard = LOCK.lock().await;
            let due = (|| -> Result<bool, String> {
                let (c, _writer) = open_write_database(&database_path(&app)?)?;
                if cloud_sync::require_reading(&c, true).is_err() {
                    return Ok(false);
                }
                let now = now_timestamp();
                #[cfg(target_os = "android")]
                {
                    let mut gate = FOREGROUND.lock().map_err(|_| "阅读前台状态不可用")?;
                    let mut next = *gate;
                    if !next.claim(
                        true,
                        now,
                        metadata_u64(&c, "reading_sync_attempt", 0) as i64,
                    ) {
                        return Ok(false);
                    }
                    // Preserve a catch-up request if persisting the claim fails.
                    meta(&c, "reading_sync_attempt", &now.to_string())?;
                    *gate = next;
                    return Ok(true);
                }
                #[cfg(not(target_os = "android"))]
                {
                    if now.saturating_sub(metadata_u64(&c, "reading_sync_attempt", 0) as i64) < 60 {
                        return Ok(false);
                    }
                    meta(&c, "reading_sync_attempt", &now.to_string())?;
                    Ok(true)
                }
            })();
            if due == Ok(true) {
                #[cfg(target_os = "android")]
                let _ = run_locked(app.clone(), true).await;
                #[cfg(not(target_os = "android"))]
                let _ = run(app.clone(), true).await;
            }
            #[cfg(target_os = "android")]
            drop(_guard);
            if !crate::background_workers::wait(Duration::from_secs(5)).await {
                break;
            }
        }
    });
}

#[cfg(test)]
#[path = "reading_sync_tests.rs"]
mod tests;

pub(crate) fn migration_body_ready(c: &Connection, ns: &str) -> Result<bool, String> {
    let mut q = c
        .prepare("SELECT item_key,body FROM reading_sync_records")
        .map_err(|e| e.to_string())?;
    let rows = q
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (key, body) = row.map_err(|e| e.to_string())?;
        let record: Record = serde_json::from_str(&body).map_err(|_| "阅读迁移当前记录损坏")?;
        let expected = hash(&bytes(record)?);
        let uploaded: Option<String> = c
            .query_row(
                "SELECT id FROM reading_sync_uploaded WHERE namespace=?1 AND item_key=?2",
                params![ns, key],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if uploaded.as_deref() != Some(expected.as_str()) {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(all(test, windows))]
pub(crate) mod real_cloud_tests;
