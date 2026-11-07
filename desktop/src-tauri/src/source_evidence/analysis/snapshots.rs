//! Immutable, bounded local analysis inputs. This is a derived cache, never a
//! source of authorization or a replacement for the source documents database.
use super::*;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

const PREFIX: &str = "analysis-v1:";
const DATABASE: &str = "analysis-snapshots.sqlite3";
const FORMAT: u32 = 1;
const BATCH_FORMAT: u32 = 2;
mod manifest_batch;
const MAX_ENCODED: usize = 64 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Policy {
    retention_hours: u32,
    max_store_mib: u32,
}

impl Policy {
    fn read(root: &Path) -> Result<Self, String> {
        let path = root.join("analysis-snapshot-policy.json");
        let policy = match std::fs::metadata(&path) {
            Ok(meta) if meta.len() <= 4096 => {
                serde_json::from_slice(&std::fs::read(&path).map_err(|e| e.to_string())?)
                    .map_err(|e| format!("分析快照配置无效：{e}"))?
            }
            Ok(_) => return Err("分析快照配置超过 4 KiB".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Self {
                retention_hours: 168,
                max_store_mib: 128,
            },
            Err(e) => return Err(e.to_string()),
        };
        if !(1..=2160).contains(&policy.retention_hours)
            || !(1..=1024).contains(&policy.max_store_mib)
        {
            return Err("分析快照配置需要 retentionHours=1..2160、maxStoreMib=1..1024".into());
        }
        Ok(policy)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    format: u32,
    scope_digest: String,
    filter: Value,
    source_as_of: i64,
    supersedes: Option<String>,
    items: Vec<Source>,
    bodies: Vec<Result<String, String>>,
    byte_count: usize,
}

struct Saved {
    id: String,
    input: Input,
    expires_at: i64,
}

pub(super) fn is_frozen(value: &Value) -> bool {
    value.as_str().is_some_and(|s| s.starts_with(PREFIX))
}

fn filter(args: &Value) -> Value {
    let mut value = json!({"libraryId":args["libraryId"].as_str().unwrap_or_default(),
        "query":args["query"].as_str().unwrap_or_default().trim().to_lowercase()});
    if let Some(batch) = args.get("manifestBatch") {
        value["manifestBatch"] = batch.clone();
    }
    value
}

fn scope_digest(reader: &EvidenceReader) -> String {
    let mut libraries = reader.scope.library_ids.clone();
    libraries.sort();
    let mut notes = reader
        .scope
        .notes
        .iter()
        .map(|v| serde_json::to_string(v).unwrap())
        .collect::<Vec<_>>();
    notes.sort();
    fingerprint(&json!({"libraries":libraries,"notes":notes}))
}

fn validate_id(id: &str) -> Result<(), String> {
    let suffix = id.strip_prefix(PREFIX).ok_or("analysis_snapshot_invalid")?;
    if suffix.len() != 64 || !suffix.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("analysis_snapshot_invalid".into());
    }
    Ok(())
}

pub(super) fn prepare_existing_store(root: &Path) -> Result<(), String> {
    let path = root.join(DATABASE);
    if !path.exists() {
        return Ok(());
    }
    // Format-only startup work: never create a missing cache or change payloads,
    // identities, expiry or policy. Captures retain their own durable admission.
    let c = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|e| format!("分析快照并发初始化失败：{e}"))?;
    c.busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    c.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA journal_size_limit=0;",
    )
    .map_err(|e| format!("分析快照并发初始化失败：{e}"))
}

fn database(root: &Path, write: bool) -> Result<Connection, String> {
    let flags = if write {
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE
    } else {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    };
    let c = Connection::open_with_flags(root.join(DATABASE), flags)
        .map_err(|e| format!("evidence_unavailable：分析快照存储不可用：{e}"))?;
    c.busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    if write {
        // Keep payload and manifest in one atomic SQLite commit. Freed pages are
        // reused; max_page_count bounds the main database, not all transient
        // journal bytes or physical disk exhaustion. WAL lets report readers
        // inspect old committed inputs while another capture commits.
        c.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA journal_size_limit=0;
            CREATE TABLE IF NOT EXISTS snapshots (
                id TEXT PRIMARY KEY, created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL, payload TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS snapshots_expiry ON snapshots(expires_at);",
        )
        .map_err(|e| e.to_string())?;
        let page_size: i64 = c
            .pragma_query_value(None, "page_size", |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let physical = (Policy::read(root)?.max_store_mib as i64 * 1024 * 1024 * 2) / page_size;
        c.pragma_update(None, "max_page_count", physical)
            .map_err(|e| e.to_string())?;
    }
    Ok(c)
}

fn load(reader: &EvidenceReader, id: &str) -> Result<Saved, String> {
    load_with_expiry(reader, id, false)
}

fn load_with_expiry(
    reader: &EvidenceReader,
    id: &str,
    allow_expired: bool,
) -> Result<Saved, String> {
    validate_id(id)?;
    let c = database(&reader.root, false)?;
    let row = c.query_row("SELECT expires_at,CASE WHEN length(CAST(payload AS BLOB))<=?2 THEN payload ELSE NULL END FROM snapshots WHERE id=?1", params![id,MAX_ENCODED as i64],
        |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?))).optional().map_err(|e| e.to_string())?
        .ok_or("evidence_unavailable：分析快照不存在或已回收")?;
    if !allow_expired && row.0 <= chrono::Utc::now().timestamp() {
        return Err("snapshot_expired：请创建新分析快照，不自动替换旧输入".into());
    }
    let payload = row.1.ok_or("evidence_unavailable：分析快照容量无效")?;
    if format!("{PREFIX}{:x}", Sha256::digest(payload.as_bytes())) != id {
        return Err("evidence_unavailable：分析快照摘要不匹配".into());
    }
    let input: Input =
        serde_json::from_str(&payload).map_err(|e| format!("evidence_unavailable：{e}"))?;
    if !(input.format == FORMAT && input.filter.get("manifestBatch").is_none()
        || input.format == BATCH_FORMAT && input.filter["manifestBatch"].is_object())
        || input.items.len() != input.bodies.len()
        || input.items.len() > MAX_NOTES
        || input.byte_count > MAX_BYTES
        || input.scope_digest != scope_digest(reader)
    {
        return Err(
            "analysis_snapshot_scope_or_format_mismatch：快照不属于当前授权范围或格式".into(),
        );
    }
    Ok(Saved {
        id: id.into(),
        input,
        expires_at: row.0,
    })
}

fn eligible(
    reader: &EvidenceReader,
    c: &Connection,
    visible: &[String],
    saved: &Saved,
    args: &Value,
) -> Result<(), String> {
    if reader
        .scope
        .library_ids
        .iter()
        .any(|id| !visible.contains(id))
    {
        return Err("evidence_unavailable：来源已撤权".into());
    }
    // Optional filters may be omitted when reopening a snapshot. If supplied,
    // they must describe exactly the original membership query.
    for key in ["libraryId", "query", "manifestBatch"] {
        if args.get(key).is_some_and(|v| !v.is_null())
            && filter(args)[key] != saved.input.filter[key]
        {
            return Err("analysis_snapshot_filter_mismatch：不能用旧快照替换筛选范围".into());
        }
    }
    for item in &saved.input.items {
        reader.checkpoint()?;
        let EvidenceLocator::Note {
            library_id,
            document_id,
            page_id,
        } = &item.locator
        else {
            return Err("analysis_snapshot_invalid".into());
        };
        if !visible.contains(library_id) || !reader.scope.permits_note(&item.locator) {
            return Err("evidence_unavailable：来源已撤权".into());
        }
        // Current eligibility, not current content version: historical analysis
        // survives edits, but never source deletion or loss of page identity.
        document_record(c, library_id, document_id)
            .map_err(|_| "evidence_unavailable：来源已删除或不可用")?;
        if page_id.is_some() {
            reader
                .snapshot(c, visible, &item.locator)
                .map_err(|_| "evidence_unavailable：来源页面已删除或不可用")?;
        }
    }
    Ok(())
}

pub(super) fn verify(
    reader: &EvidenceReader,
    c: &Connection,
    visible: &[String],
    id: &Value,
    args: &Value,
) -> Result<(), String> {
    let saved = load(reader, id.as_str().ok_or("analysis_snapshot_invalid")?)?;
    eligible(reader, c, visible, &saved, args)
}

fn summary(saved: &Saved) -> Value {
    let missing = saved.input.bodies.iter().filter(|b| b.is_err()).count();
    let mut value = json!({"snapshot":saved.id,"manifestDigest":saved.id.strip_prefix(PREFIX),"status":if missing==0 {"ready"} else {"partial"},
        "scopeRevision":saved.input.scope_digest,"sourceAsOf":saved.input.source_as_of,"createdAt":saved.input.source_as_of,
        "expiresAt":saved.expires_at,"byteCount":saved.input.byte_count,"itemsTotal":saved.input.items.len(),"unavailableItems":missing,
        "coverage":"authorizedLocalCache","sourceFreshness":"capturedLocalCacheNotVerifiedWithRemote",
        "consistency":"immutableCapturedInput","parserVersion":"note-page-v1","methodVersion":"literal-analysis-v1",
        "supersedes":saved.input.supersedes});
    if let Some(batch) = saved.input.filter.get("batchDescriptor") {
        value["manifestBatch"] = batch.clone();
    }
    value
}

pub(super) fn create(reader: &EvidenceReader, args: &Value) -> Result<Value, String> {
    let policy = Policy::read(&reader.root)?;
    let input = reader.in_snapshot(|c, visible| {
        let source_as_of = chrono::Utc::now().timestamp();
        if let Some(previous) = args["supersedes"].as_str() {
            let previous = load_with_expiry(reader, previous, true)?;
            eligible(reader, c, visible, &previous, args)?;
        }
        let (mut items, batch_descriptor) = if let Some(batch) = args.get("manifestBatch") {
            if args.get("libraryId").is_some() || args.get("query").is_some() {
                return Err("固定分批输入不能混用额外资料库或标题筛选".into());
            }
            let (items, descriptor) = manifest_batch::select(reader, c, visible, batch)?;
            (items, Some(descriptor))
        } else {
            (sources(reader, c, visible, args)?, None)
        };
        let mut capture_filter = filter(args);
        if let Some(descriptor) = &batch_descriptor {
            capture_filter["batchDescriptor"] = descriptor.clone();
        }
        let started = Instant::now();
        let mut bodies = Vec::with_capacity(items.len());
        let mut byte_count = 0usize;
        for item in &mut items {
            reader.checkpoint()?;
            if started.elapsed() > Duration::from_secs(10) {
                return Err("分析快照捕获超过 10 秒，请缩小范围；未发布快照".into());
            }
            let body = reader.snapshot(c, visible, &item.locator).map(|s| {
                item.version = json!({"metadata":item.version,"evidenceVersion":s.version,
                    "bodySha256":format!("{:x}",Sha256::digest(s.body.as_bytes()))});
                s.body
            });
            if let Ok(body) = &body {
                byte_count = byte_count
                    .checked_add(body.len())
                    .ok_or("分析快照容量溢出")?;
            }
            if byte_count > MAX_BYTES {
                return Err("分析快照正文超过 32 MiB；未发布快照".into());
            }
            bodies.push(body);
        }
        Ok(Input {
            format: if batch_descriptor.is_some() {
                BATCH_FORMAT
            } else {
                FORMAT
            },
            scope_digest: scope_digest(reader),
            filter: capture_filter,
            source_as_of,
            supersedes: args["supersedes"].as_str().map(str::to_owned),
            items,
            bodies,
            byte_count,
        })
    })?;
    let payload = serde_json::to_string(&input).map_err(|e| e.to_string())?;
    if payload.len() > MAX_ENCODED {
        return Err("分析快照编码超过 64 MiB；未发布快照".into());
    }
    let id = format!("{PREFIX}{:x}", Sha256::digest(payload.as_bytes()));
    let expires_at = input.source_as_of + i64::from(policy.retention_hours) * 3600;
    let mut c = database(&reader.root, true)?;
    let tx = c
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM snapshots WHERE expires_at<=?1",
        [input.source_as_of],
    )
    .map_err(|e| e.to_string())?;
    let used: i64 = tx
        .query_row(
            "SELECT COALESCE(SUM(length(CAST(payload AS BLOB))),0) FROM snapshots WHERE id<>?1",
            [&id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if used as u64 + payload.len() as u64 > u64::from(policy.max_store_mib) * 1024 * 1024 {
        return Err(
            "analysis_snapshot_quota_exceeded：保留中的快照已达配额；不会静默删除未过期输入".into(),
        );
    }
    reader.checkpoint()?;
    tx.execute(
        "INSERT OR IGNORE INTO snapshots(id,created_at,expires_at,payload) VALUES(?1,?2,?3,?4)",
        params![id, input.source_as_of, expires_at, payload],
    )
    .map_err(|e| format!("分析快照保存失败，未发布：{e}"))?;
    tx.commit()
        .map_err(|e| format!("分析快照提交失败，未发布：{e}"))?;
    // Reopen the committed object through the same authorization boundary as all
    // consumers. A revocation during capture must not return usable evidence.
    reader.in_snapshot(|c, visible| {
        let saved = load(reader, &id)?;
        eligible(reader, c, visible, &saved, args)?;
        Ok(summary(&saved))
    })
}

// Opt-in pages preserve each captured source and scalar range. The character
// ceiling applies to the whole page, never independently to every member.
fn read_page(reader: &EvidenceReader, saved: &Saved, args: &Value) -> Result<Value, String> {
    let count = args["itemCount"]
        .as_u64()
        .filter(|n| (1..=8).contains(n))
        .ok_or("itemCount 必须为1至8的整数")? as usize;
    let mut index = args["itemIndex"]
        .as_u64()
        .ok_or("itemIndex 必须为非负整数")? as usize;
    if index >= saved.input.items.len() {
        return Err("分析快照条目不存在".into());
    }
    let mut start = args["start"].as_u64().unwrap_or(0) as usize;
    let limit = args["limit"].as_u64().unwrap_or(4000).clamp(1, 8000) as usize;
    let mut remaining = limit;
    let mut items = Vec::new();
    let mut next = Value::Null;
    while items.len() < count && index < saved.input.items.len() {
        reader.checkpoint()?;
        let item = &saved.input.items[index];
        let body = saved.input.bodies[index]
            .as_ref()
            .map_err(|e| format!("evidence_unavailable：{e}"))?;
        let total = body.chars().count();
        if start > total {
            return Err("原文起点超出字符范围".into());
        }
        let text: String = body.chars().skip(start).take(remaining).collect();
        let end = start + text.chars().count();
        remaining -= end - start;
        items.push(
            json!({"itemIndex":index,"locator":item.locator,"sourceRevision":item.version,
            "title":item.title,"path":item.path,"content":text,"start":start,"end":end,
            "totalCharacters":total,"offsetUnit":"unicodeScalarValue",
            "nextStart":if end<total{Some(end)}else{None}}),
        );
        if end < total {
            next = json!({"itemIndex":index,"start":end});
            break;
        }
        index += 1;
        start = 0;
        next = if index < saved.input.items.len() {
            json!({"itemIndex":index,"start":0})
        } else {
            Value::Null
        };
        if remaining == 0 {
            break;
        }
    }
    Ok(
        json!({"pageFormat":"analysisSourcePage-v1","items":items,"readCharacters":limit-remaining,"next":next}),
    )
}

pub(super) fn execute(reader: &EvidenceReader, name: &str, args: &Value) -> Result<Value, String> {
    reader.in_snapshot(|c,visible| {
        let id=args["expectedSnapshot"].as_str().ok_or("expectedSnapshot 必须指向已创建的分析快照")?;
        let saved=load(reader,id)?;
        eligible(reader,c,visible,&saved,args)?;
        let mut result=match name {
            "hub_list_note_sources" => {
                let offset=args["offset"].as_u64().unwrap_or(0) as usize;
                let limit=args["limit"].as_u64().unwrap_or(30).clamp(1,50) as usize;
                let notes=saved.input.items.iter().enumerate().skip(offset).take(limit).map(|(i,s)|json!({"itemIndex":i,"locator":s.locator,"title":s.title,"path":s.path,"libraryName":s.library,"sourceRevision":s.version})).collect::<Vec<_>>();
                let end=offset.saturating_add(notes.len());
                json!({"notes":notes,"total":saved.input.items.len(),"nextOffset":if end<saved.input.items.len(){Some(end)}else{None},"filter":if saved.input.format==BATCH_FORMAT{"versionBoundManifestMemberInterval"}else{"titleOrPathContains"},"bodyRead":false})
            },
            "hub_analyze_notes" => analyze(reader,c,visible,&saved.input.items,args,id,Some(&saved.input.bodies))?,
            "hub_read_analysis_snapshot" => {
                if args.get("itemCount").is_some() {
                    let mut page = read_page(reader,&saved,args)?;
                    page["snapshot"]=json!(saved.id);
                    page["inputSet"]=summary(&saved);
                    page["sourceFreshness"]=json!("historicalCapturedInputNotCurrentSource");
                    if page.to_string().len() > 48_000 {
                        return Err("分析原文分页超过48000字节，未返回部分结果；请调小itemCount或limit".into());
                    }
                    return Ok(page);
                }
                let index=args["itemIndex"].as_u64().ok_or("itemIndex 必须为非负整数")? as usize;
                let item=saved.input.items.get(index).ok_or("分析快照条目不存在")?;
                let body=saved.input.bodies[index].as_ref().map_err(|e|format!("evidence_unavailable：{e}"))?;
                let start=args["start"].as_u64().unwrap_or(0) as usize;
                let limit=args["limit"].as_u64().unwrap_or(4000).clamp(1,8000) as usize;
                let total=body.chars().count();
                if start>total {return Err("原文起点超出字符范围".into());}
                let text=body.chars().skip(start).take(limit).collect::<String>();
                let end=start+text.chars().count();
                json!({"itemIndex":index,"locator":item.locator,"sourceRevision":item.version,"title":item.title,"content":text,"start":start,"end":end,"totalCharacters":total,"offsetUnit":"unicodeScalarValue","nextStart":if end<total{Some(end)}else{None}})
            },
            _=>return Err("未知分析快照操作".into()),
        };
        result["snapshot"]=json!(saved.id);
        result["inputSet"]=summary(&saved);
        result["sourceFreshness"]=json!("historicalCapturedInputNotCurrentSource");
        Ok(result)
    })
}

#[cfg(test)]
mod tests;
