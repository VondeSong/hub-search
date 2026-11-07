//! The download job is the failure and user-disposition owner. This module
//! projects it for the health page and never starts a network producer.
use crate::{
    attachment_download_cache, hidden_library_ids, now_timestamp, open_database,
    open_write_database,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashSet, path::PathBuf, sync::OnceLock};

const PAGE_LIMIT: usize = 25;
const META: &str = "CASE WHEN json_valid(s.metadata_json) THEN s.metadata_json ELSE '{}' END";
const PAYLOAD: &str = "CASE WHEN json_valid(j.payload) THEN j.payload ELSE '{}' END";

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub(crate) struct Args {
    pub action: String,
    pub library_id: Option<String>,
    pub status: String,
    pub offset: usize,
    pub limit: usize,
    pub items: Vec<Target>,
}
impl Default for Args {
    fn default() -> Self {
        Self {
            action: "list".into(),
            library_id: None,
            status: "failed".into(),
            offset: 0,
            limit: PAGE_LIMIT,
            items: Vec::new(),
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Target {
    pub job_id: i64,
    pub source_id: String,
    pub resource_generation: u64,
    pub updated_at: i64,
    pub status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Item {
    pub job_id: i64,
    pub source_id: String,
    pub source_type: String,
    pub job_type: String,
    pub title: String,
    pub parent_title: Option<String>,
    pub document_path: Option<String>,
    pub mime_type: Option<String>,
    pub source_reference: Option<String>,
    pub error: String,
    pub attempts: i64,
    pub updated_at: i64,
    pub library_id: String,
    pub library_name: String,
    pub provider: String,
    pub document_id: String,
    pub resource_generation: u64,
    pub status: String,
    pub next_attempt_at: Option<i64>,
    pub has_cache: bool,
    pub can_retry: bool,
    pub can_skip: bool,
    pub issue_state: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Library {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub failed_count: usize,
    pub skipped_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Page {
    pub items: Vec<Item>,
    pub total: usize,
    pub failed_count: usize,
    pub skipped_count: usize,
    pub libraries: Vec<Library>,
    pub changed: usize,
    pub unchanged: usize,
    pub offset: usize,
}

fn projection() -> String {
    let generation =
        format!("COALESCE(CAST(json_extract({META},'$.resourceGeneration') AS INTEGER),0)");
    let marker = format!("json_extract({PAYLOAD},'$.downloadSkippedGeneration')");
    let legacy = format!("json_extract({PAYLOAD},'$.resourceGeneration')");
    format!("WITH issues AS (
      SELECT j.*,s.title attachment_title,s.mime_type,s.metadata_json,s.document_id,
        s.blob_hash,s.status source_status,l.name library_name,l.provider actual_provider,
        d.title parent_title,d.path document_path,{generation} resource_generation,
        CASE WHEN {marker} IS NOT NULL THEN {marker}={generation}
          WHEN j.status='dismissed' THEN ({legacy} IS NULL OR {legacy}={generation}) ELSE 0 END skipped
      FROM index_jobs j JOIN source_items s ON s.id=j.source_id AND s.space_id=j.space_id
      JOIN libraries l ON l.id=j.space_id AND l.enabled=1 AND l.provider=s.provider
      JOIN documents d ON d.space_id=s.space_id AND d.id=s.document_id
      WHERE j.job_type='download_source' AND s.provider IN ('craft','dida365')
        AND s.source_type IN ('craft_attachment','dida_attachment')
        AND NOT EXISTS(SELECT 1 FROM json_each(?1) h WHERE h.value=j.space_id)
    ), visible AS (SELECT * FROM issues WHERE skipped OR
      (NULLIF(last_error,'') IS NOT NULL AND
       (status IN ('failed','pending','running') OR
        (status='completed' AND source_status IN ('unavailable','rejected'))))) ")
}

/// Drop complete provider URLs and credential headers, including opaque path
/// tokens. A server response body is never needed to expose an HTTP failure.
pub(crate) fn public_error(raw: &str) -> String {
    static URLS: OnceLock<regex::Regex> = OnceLock::new();
    static SECRETS: OnceLock<regex::Regex> = OnceLock::new();
    static HTTP: OnceLock<regex::Regex> = OnceLock::new();
    let http = HTTP.get_or_init(|| {
        regex::Regex::new(r"HTTP_STATUS:\s*(\d{3})").expect("constant HTTP pattern")
    });
    if let Some(found) = http.captures(raw) {
        return format!(
            "HTTP {} · {}",
            &found[1],
            match &found[1] {
                "401" | "403" => "当前登录或权限无法读取附件，请登录后重试",
                "404" | "410" => "远端附件不存在或地址已失效",
                "429" => "服务暂时限流，请稍后重试",
                _ => "远端服务未能完成附件下载，请稍后重试",
            }
        );
    }
    let urls = URLS.get_or_init(|| {
        regex::Regex::new(r#"(?i)(?:https?://|craft-media://|feishu-media://)[^\s<>\"']+"#)
            .expect("constant URL pattern")
    });
    let secrets=SECRETS.get_or_init(||regex::Regex::new(r#"(?i)\b(?:cookie|authorization|bearer|token|secret|password|credential|signature|access[_-]?key|api[_-]?key|session|ticket|csrf)[\"']?\s*(?:[:=]\s*|\s+)[^\r\n]+"#).expect("constant credential pattern"));
    let cleaned = urls.replace_all(raw, "[附件地址已隐藏]");
    let cleaned = secrets.replace_all(&cleaned, "[敏感信息已隐藏]");
    cleaned.chars().take(800).collect()
}

fn reference(raw: Option<String>) -> Option<String> {
    raw.map(|raw| {
        if let Ok(url) = url::Url::parse(&raw) {
            url.host_str().unwrap_or("附件地址已隐藏").to_string()
        } else {
            "附件地址已隐藏".to_string()
        }
    })
}

fn list(connection: &Connection, hidden: &str, args: &Args) -> Result<Page, String> {
    let base = projection();
    let (failed_count,skipped_count):(usize,usize)=connection.query_row(
        &format!("{base} SELECT COALESCE(SUM(NOT skipped),0),COALESCE(SUM(skipped),0) FROM visible WHERE (?2 IS NULL OR space_id=?2)"),
        params![hidden,args.library_id],|row|Ok((row.get(0)?,row.get(1)?)),
    ).map_err(|_|"无法读取附件问题数量")?;
    let skipped = args.status == "dismissed";
    let total = if skipped { skipped_count } else { failed_count };
    let limit = args.limit.clamp(1, PAGE_LIMIT);
    let offset = if total == 0 {
        0
    } else {
        args.offset.min((total - 1) / limit * limit)
    };
    let mut query=connection.prepare(&format!("{base} SELECT id,source_id,source_type,job_type,
      COALESCE(NULLIF(attachment_title,''),NULLIF(parent_title,''),'附件'),parent_title,document_path,
      mime_type,json_extract(CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{{}}' END,'$.remoteUrl'),
      COALESCE(last_error,''),attempts,updated_at,space_id,library_name,actual_provider,document_id,
      resource_generation,status,next_attempt_at,blob_hash IS NOT NULL,source_status,skipped
      FROM visible WHERE (?2 IS NULL OR space_id=?2) AND skipped=?3
      ORDER BY updated_at DESC,id DESC LIMIT ?4 OFFSET ?5")).map_err(|_|"无法准备附件问题分页")?;
    let rows = query
        .query_map(
            params![hidden, args.library_id, skipped, limit, offset],
            |row| {
                let status: String = row.get(17)?;
                let source_status: String = row.get(20)?;
                let skipped: bool = row.get(21)?;
                let running = status == "running";
                let issue_state = if skipped {
                    "dismissed"
                } else if running {
                    "retrying"
                } else if status == "pending" {
                    "scheduled"
                } else if source_status == "unavailable" {
                    "unavailable"
                } else if source_status == "rejected" {
                    "rejected"
                } else {
                    "failed"
                };
                let retry_at: i64 = row.get(18)?;
                Ok(Item {
                    job_id: row.get(0)?,
                    source_id: row.get(1)?,
                    source_type: row.get(2)?,
                    job_type: row.get(3)?,
                    title: public_error(&row.get::<_, String>(4)?),
                    parent_title: row.get::<_, Option<String>>(5)?.map(|v| public_error(&v)),
                    document_path: row.get::<_, Option<String>>(6)?.map(|v| public_error(&v)),
                    mime_type: row.get(7)?,
                    source_reference: reference(row.get(8)?),
                    error: public_error(&row.get::<_, String>(9)?),
                    attempts: row.get(10)?,
                    updated_at: row.get(11)?,
                    library_id: row.get(12)?,
                    library_name: public_error(&row.get::<_, String>(13)?),
                    provider: row.get(14)?,
                    document_id: row.get(15)?,
                    resource_generation: row.get(16)?,
                    status,
                    next_attempt_at: (retry_at > 0).then_some(retry_at),
                    has_cache: row.get(19)?,
                    can_retry: !running,
                    can_skip: !running && !skipped,
                    issue_state: issue_state.into(),
                })
            },
        )
        .map_err(|_| "无法读取附件问题分页")?;
    let items = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "附件问题分页无效")?;
    drop(query);
    let mut query=connection.prepare(&format!("{base} SELECT space_id,library_name,actual_provider,
      SUM(NOT skipped),SUM(skipped) FROM visible GROUP BY space_id ORDER BY lower(library_name),space_id"))
      .map_err(|_|"无法准备附件问题资料库")?;
    let rows = query
        .query_map([hidden], |row| {
            Ok(Library {
                id: row.get(0)?,
                name: public_error(&row.get::<_, String>(1)?),
                provider: row.get(2)?,
                failed_count: row.get(3)?,
                skipped_count: row.get(4)?,
            })
        })
        .map_err(|_| "无法读取附件问题资料库")?;
    let libraries = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "附件问题资料库无效")?;
    Ok(Page {
        items,
        total,
        failed_count,
        skipped_count,
        libraries,
        changed: 0,
        unchanged: 0,
        offset,
    })
}

pub(crate) fn handle(path: &PathBuf, args: Args) -> Result<Page, String> {
    if !matches!(args.action.as_str(), "list" | "skip" | "retry")
        || !matches!(args.status.as_str(), "failed" | "dismissed")
    {
        return Err("未知的附件问题操作".into());
    }
    if args.items.len() > args.limit.clamp(1, PAGE_LIMIT)
        || (args.action == "list" && !args.items.is_empty())
    {
        return Err("一次只能处理当前分页中的附件".into());
    }
    if args.action == "list" {
        let connection = open_database(path)?;
        let hidden = serde_json::to_string(&hidden_library_ids(path, &connection)?)
            .map_err(|_| "无法读取有效资料库")?;
        let transaction = connection
            .unchecked_transaction()
            .map_err(|_| "无法读取附件问题快照")?;
        let page = list(&transaction, &hidden, &args)?;
        transaction.commit().map_err(|_| "无法结束附件问题快照")?;
        return Ok(page);
    }
    let (mut connection, _writer) = open_write_database(path)?;
    let hidden = serde_json::to_string(&hidden_library_ids(path, &connection)?)
        .map_err(|_| "无法读取有效资料库")?;
    let transaction = connection
        .transaction()
        .map_err(|_| "无法开始附件问题操作")?;
    let before = list(&transaction, &hidden, &args)?;
    let mut seen = HashSet::new();
    let mut changed = 0;
    for target in &args.items {
        let Some(item) = before
            .items
            .iter()
            .find(|item| item.job_id == target.job_id)
        else {
            continue;
        };
        if !seen.insert(target.job_id)
            || item.source_id != target.source_id
            || item.resource_generation != target.resource_generation
            || item.updated_at != target.updated_at
            || item.status != target.status
            || item.status == "running"
            || (args.action == "skip" && !item.can_skip)
            || (args.action == "retry" && !item.can_retry)
        {
            continue;
        }
        if args.action == "skip" {
            changed+=transaction.execute("UPDATE index_jobs SET status='dismissed',updated_at=?1,
              payload=json_set(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.downloadSkippedGeneration',?2)
              WHERE id=?3 AND source_id=?4 AND status=?5 AND updated_at=?6 AND status!='running'",
              params![now_timestamp(),target.resource_generation,target.job_id,target.source_id,target.status,target.updated_at])
              .map_err(|_|"无法跳过附件下载")?;
        } else {
            changed+=transaction.execute("UPDATE index_jobs SET status='pending',attempts=0,updated_at=?1,last_error=NULL,next_attempt_at=0,
              payload=json_remove(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.downloadSkippedGeneration'),
              worker_id=NULL,locked_at=NULL,lease_until=NULL
              WHERE id=?2 AND source_id=?3 AND status=?4 AND updated_at=?5 AND status!='running'",
              params![now_timestamp(),target.job_id,target.source_id,target.status,target.updated_at]).map_err(|_|"无法重新排队附件下载")?;
            transaction.execute("UPDATE source_items SET status='discovered' WHERE id=?1 AND blob_hash IS NULL AND status IN ('unavailable','rejected')",[&target.source_id])
                .map_err(|_|"无法恢复附件下载资格")?;
        }
    }
    let mut page = list(&transaction, &hidden, &args)?;
    page.changed = changed;
    page.unchanged = args.items.len().saturating_sub(changed);
    transaction.commit().map_err(|_| "无法提交附件问题操作")?;
    Ok(page)
}

#[tauri::command]
pub(crate) async fn attachment_download_failures(
    app: tauri::AppHandle,
    args: Args,
) -> Result<Page, String> {
    let path = crate::database_path(&app)?;
    tokio::task::spawn_blocking(move || handle(&path, args))
        .await
        .map_err(|_| "附件问题操作异常，请稍后重试".to_string())?
}

pub(crate) fn eligible_sql() -> String {
    let generation =
        format!("COALESCE(CAST(json_extract({META},'$.resourceGeneration') AS INTEGER),0)");
    format!("(json_extract({PAYLOAD},'$.downloadSkippedGeneration') IS NULL OR json_extract({PAYLOAD},'$.downloadSkippedGeneration')!={generation})")
}

fn skip_value(status: &str, payload: Option<&str>, generation: u64) -> bool {
    let value = payload.and_then(|raw| serde_json::from_str::<Value>(raw).ok());
    let explicit = value
        .as_ref()
        .and_then(|v| v.get("downloadSkippedGeneration"))
        .and_then(Value::as_u64);
    if let Some(skipped) = explicit {
        return skipped == generation;
    }
    if status != "dismissed" {
        return false;
    }
    let legacy = value
        .as_ref()
        .and_then(|v| v.get("resourceGeneration"))
        .and_then(Value::as_u64);
    legacy.is_none_or(|skipped| skipped == generation)
}

pub(crate) fn is_skipped(
    connection: &Connection,
    source: &str,
    metadata: &str,
) -> Result<bool, String> {
    let row:Option<(String,Option<String>)>=connection.query_row("SELECT status,payload FROM index_jobs WHERE source_id=?1 AND job_type='download_source' LIMIT 1",
      [source],|row|Ok((row.get(0)?,row.get(1)?))).optional().map_err(|_|"无法核对附件跳过决定")?;
    Ok(row.is_some_and(|(status, payload)| {
        skip_value(
            &status,
            payload.as_deref(),
            attachment_download_cache::resource_generation(metadata),
        )
    }))
}

pub(crate) fn allow_discovery(
    connection: &Connection,
    source: &str,
    metadata: &str,
    previous_generation: Option<u64>,
    resource_changed: bool,
) -> Result<bool, String> {
    Ok(!is_skipped(connection, source, metadata)?
        || (resource_changed
            && previous_generation.is_some_and(|previous| {
                attachment_download_cache::resource_generation(metadata) > previous
            })))
}

pub(crate) fn require_transfer(
    connection: &Connection,
    source: &str,
    metadata: &str,
) -> Result<(), String> {
    if is_skipped(connection, source, metadata)? {
        return Err("CONTENT_POLICY:此附件已跳过下载，可在下载问题页再次重试".into());
    }
    Ok(())
}

pub(crate) fn require_preview_transfer(
    capture: &crate::PreviewDownloadCapture,
) -> Result<(), String> {
    let connection = open_database(&capture.database)?;
    let current = capture
        .current_metadata(&connection)?
        .ok_or("CONTENT_POLICY:附件已移除，请重新打开预览")?;
    if !capture.matches_metadata(&current) {
        return Err("CONTENT_POLICY:附件已更新，请重新打开预览".into());
    }
    require_transfer(&connection, &capture.source_id, &current)?;
    let retry:Option<(String,Option<String>,i64)>=connection.query_row("SELECT status,last_error,next_attempt_at FROM index_jobs WHERE source_id=?1 AND job_type='download_source' LIMIT 1",
      [&capture.source_id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional().map_err(|_|"无法核对附件下载重试")?;
    if retry.is_some_and(|(status, error, next)| {
        error.is_some_and(|error| !error.is_empty())
            && (matches!(status.as_str(), "failed" | "completed")
                || (status == "pending" && next > now_timestamp()))
    }) {
        return Err("CONTENT_POLICY:此附件正在等待重试，可在下载问题页查看或再次重试".into());
    }
    Ok(())
}

pub(crate) fn record_preview_failure(
    capture: &crate::PreviewDownloadCapture,
    error: &str,
) -> Result<(), String> {
    if crate::pipeline_control_error(error) {
        return Ok(());
    }
    let (mut connection, _writer) = open_write_database(&capture.database)?;
    let Some(current) = capture.current_metadata(&connection)? else {
        return Ok(());
    };
    let requested_url = serde_json::from_str::<Value>(&capture.metadata)
        .ok()
        .and_then(|value| value.get("remoteUrl").cloned());
    let current_url = serde_json::from_str::<Value>(&current)
        .ok()
        .and_then(|value| value.get("remoteUrl").cloned());
    if !capture.matches_metadata(&current)
        || requested_url != current_url
        || is_skipped(&connection, &capture.source_id, &current)?
    {
        return Ok(());
    }
    let transaction = connection
        .transaction()
        .map_err(|_| "无法开始预览下载失败记录")?;
    let now = now_timestamp();
    let public = public_error(error);
    let existing:Option<(String,i64)>=transaction.query_row("SELECT status,attempts FROM index_jobs WHERE source_id=?1 AND job_type='download_source' LIMIT 1",
      [&capture.source_id],|row|Ok((row.get(0)?,row.get(1)?))).optional().map_err(|_|"无法读取预览下载任务")?;
    if existing
        .as_ref()
        .is_some_and(|(status, _)| status == "running")
    {
        // The background worker can be waiting on this preview's source lease.
        // Preserve its ownership, budget and retry plan while recording the attempt.
        transaction.execute("UPDATE index_jobs SET last_error=?1,updated_at=?2 WHERE source_id=?3 AND job_type='download_source' AND status='running'",
          params![public,now,capture.source_id]).map_err(|_|"无法记录处理中的附件错误")?;
    } else {
        let attempts = existing
            .as_ref()
            .map(|(_, attempts)| *attempts)
            .unwrap_or(0)
            .saturating_add(1);
        let terminal = crate::attachment_queue::terminal_download_error(error);
        let (exhausted, retry_at) = crate::search_index_runtime::failure_retry_plan(attempts, now);
        let status = if terminal {
            "completed"
        } else if exhausted {
            "failed"
        } else {
            "pending"
        };
        let retry_at = if terminal { 0 } else { retry_at };
        transaction.execute("INSERT INTO index_jobs(job_key,space_id,source_id,source_type,job_type,status,priority,attempts,last_error,next_attempt_at,created_at,updated_at,provider)
          SELECT 'download:'||id,space_id,id,source_type,'download_source',?1,30,?2,?3,?4,?5,?5,provider FROM source_items WHERE id=?6
          ON CONFLICT(job_key) DO UPDATE SET status=excluded.status,attempts=excluded.attempts,last_error=excluded.last_error,
            next_attempt_at=excluded.next_attempt_at,updated_at=excluded.updated_at WHERE index_jobs.status!='running'",
          params![status,attempts,public,retry_at,now,capture.source_id]).map_err(|_|"无法保存预览下载失败")?;
        if terminal {
            transaction
                .execute(
                    "UPDATE source_items SET status=?1 WHERE id=?2",
                    params![
                        if error.contains("超过")
                            || error.contains("只允许下载")
                            || error.contains("元数据")
                        {
                            "rejected"
                        } else {
                            "unavailable"
                        },
                        capture.source_id
                    ],
                )
                .map_err(|_| "无法记录不可用附件")?;
        }
    }
    transaction
        .commit()
        .map_err(|_| "无法提交预览下载失败记录".to_string())
}

pub(crate) fn mark_legacy_dismissed(
    connection: &Connection,
    scope: Option<&str>,
) -> Result<(), String> {
    connection.execute("UPDATE index_jobs SET payload=json_set(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,
      '$.downloadSkippedGeneration',COALESCE((SELECT json_extract(CASE WHEN json_valid(s.metadata_json) THEN s.metadata_json ELSE '{}' END,'$.resourceGeneration') FROM source_items s WHERE s.id=index_jobs.source_id),0))
      WHERE job_type='download_source' AND status='failed' AND (?1 IS NULL OR space_id=?1)",[scope])
      .map(|_|()).map_err(|_|"无法保存附件跳过决定".into())
}

#[cfg(test)]
#[path = "attachment_download_failures_tests.rs"]
mod tests;
