//! Immutable user-disposition snapshots, independent of mutable queue/source rows.
use crate::{
    attachment_download_failures::public_error, now_timestamp, open_database, open_write_database,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;

fn capture(alias: &str) -> String {
    format!("INSERT OR IGNORE INTO skipped_job_archive(job_id,space_id,source_id,job_type,source_type,resource_generation,title,parent_title,document_path,mime_type,library_name,provider,error,attempts,archived_at)
      SELECT j.id,j.space_id,j.source_id,j.job_type,j.source_type,
        COALESCE(json_extract(CASE WHEN json_valid(s.metadata_json) THEN s.metadata_json ELSE '{{}}' END,'$.resourceGeneration'),0),
        COALESCE(NULLIF(s.title,''),NULLIF(d.title,''),j.source_id),d.title,d.path,s.mime_type,
        COALESCE(l.name,j.space_id),COALESCE(l.provider,j.provider,''),COALESCE(j.last_error,''),j.attempts,j.updated_at
      FROM index_jobs j LEFT JOIN source_items s ON s.id=j.source_id AND s.space_id=j.space_id
      LEFT JOIN documents d ON d.space_id=j.space_id AND d.id=s.document_id
      LEFT JOIN libraries l ON l.id=j.space_id WHERE j.status='dismissed' {alias};")
}
pub(crate) fn schema(c: &Connection) -> Result<(), String> {
    let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
    let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='skipped_job_archive')",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS skipped_job_archive(
        id INTEGER PRIMARY KEY,job_id INTEGER NOT NULL,space_id TEXT NOT NULL,source_id TEXT NOT NULL,
        job_type TEXT NOT NULL,source_type TEXT NOT NULL,resource_generation INTEGER NOT NULL,
        title TEXT NOT NULL,parent_title TEXT,document_path TEXT,mime_type TEXT,library_name TEXT NOT NULL,
        provider TEXT NOT NULL,error TEXT NOT NULL,attempts INTEGER NOT NULL,archived_at INTEGER NOT NULL,
        UNIQUE(job_id,resource_generation));
        CREATE INDEX IF NOT EXISTS skipped_job_archive_latest ON skipped_job_archive(archived_at DESC,id DESC);
        CREATE INDEX IF NOT EXISTS skipped_job_archive_library ON skipped_job_archive(space_id,archived_at DESC,id DESC);")
        .map_err(|e|e.to_string())?;
    for (name, event) in [("updated", "UPDATE OF status"), ("inserted", "INSERT")] {
        tx.execute_batch(&format!("CREATE TRIGGER IF NOT EXISTS skipped_job_{name} AFTER {event} ON index_jobs WHEN NEW.status='dismissed' BEGIN {} END;",capture("AND j.id=NEW.id"))).map_err(|e|e.to_string())?;
    }
    if !exists {
        tx.execute_batch(&capture("")).map_err(|e| e.to_string())?;
    }
    // A lease interrupted at the retry limit must not obtain a fourth attempt.
    tx.execute("UPDATE index_jobs SET status='failed',next_attempt_at=0,worker_id=NULL,locked_at=NULL,lease_until=NULL,
        last_error=COALESCE(NULLIF(last_error,''),'已达到自动尝试上限，请手动重试'),updated_at=?1
        WHERE attempts>=3 AND (status='pending' OR (status='running' AND COALESCE(lease_until,0)<?1))",[now_timestamp()]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Args {
    action: String,
    library_id: Option<String>,
    #[serde(default)]
    offset: usize,
    archive_id: Option<i64>,
    updated_at: Option<i64>,
}
const JOIN:&str="FROM skipped_job_archive a LEFT JOIN index_jobs j ON j.id=a.job_id AND j.space_id=a.space_id AND j.source_id=a.source_id
    LEFT JOIN source_items s ON s.id=a.source_id AND s.space_id=a.space_id
    LEFT JOIN libraries l ON l.id=a.space_id";
fn retryable(c: &Connection, id: i64) -> Result<Option<(i64, String, i64)>, String> {
    c.query_row(&format!("SELECT j.id,j.space_id,j.updated_at {JOIN} WHERE a.id=?1 AND l.enabled=1
      AND j.status IN ('dismissed','failed') AND s.id IS NOT NULL
      AND a.resource_generation=COALESCE(json_extract(CASE WHEN json_valid(s.metadata_json) THEN s.metadata_json ELSE '{{}}' END,'$.resourceGeneration'),0)"),[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))
      .optional().map_err(|e|e.to_string())
}
fn list(c: &Connection, args: &Args, changed: bool) -> Result<Value, String> {
    let total: usize = c
        .query_row(
            "SELECT COUNT(*) FROM skipped_job_archive WHERE (?1 IS NULL OR space_id=?1)",
            [&args.library_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let offset = if total == 0 {
        0
    } else {
        args.offset.min((total - 1) / 25 * 25)
    };
    let mut q=c.prepare(&format!("SELECT a.id,a.title,a.parent_title,a.document_path,a.library_name,a.job_type,a.error,a.attempts,a.archived_at,j.status,j.updated_at,a.space_id {JOIN}
      WHERE (?1 IS NULL OR a.space_id=?1) ORDER BY a.archived_at DESC,a.id DESC LIMIT 25 OFFSET ?2")).map_err(|e|e.to_string())?;
    let rows=q.query_map(params![args.library_id,offset],|r|Ok((r.get::<_,i64>(0)?,json!({
        "id":r.get::<_,i64>(0)?,"title":public_error(&r.get::<_,String>(1)?),
        "parentTitle":r.get::<_,Option<String>>(2)?.map(|s|public_error(&s)),"documentPath":r.get::<_,Option<String>>(3)?.map(|s|public_error(&s)),
        "libraryName":public_error(&r.get::<_,String>(4)?),"jobType":r.get::<_,String>(5)?,"error":public_error(&r.get::<_,String>(6)?),
        "attempts":r.get::<_,i64>(7)?,"archivedAt":r.get::<_,i64>(8)?,"status":r.get::<_,Option<String>>(9)?,"updatedAt":r.get::<_,Option<i64>>(10)?,"libraryId":r.get::<_,String>(11)?
    })))).map_err(|e|e.to_string())?;
    let mut items = Vec::new();
    for row in rows {
        let (id, mut value) = row.map_err(|e| e.to_string())?;
        value["canRetry"] = json!(retryable(c, id)?.is_some());
        items.push(value);
    }
    Ok(json!({"items":items,"total":total,"offset":offset,"changed":changed}))
}
pub(crate) fn handle(path: &PathBuf, args: Args) -> Result<Value, String> {
    if args.action == "list" {
        let c = open_database(path)?;
        let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
        return list(&tx, &args, false);
    }
    if args.action != "retry" {
        return Err("未知的跳过记录操作".into());
    }
    let (mut c, _writer) = open_write_database(path)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let mut changed = false;
    if let Some((id, space, updated)) = args
        .archive_id
        .map(|id| retryable(&tx, id))
        .transpose()?
        .flatten()
    {
        let root = path.parent().ok_or("资料库目录不可用")?;
        crate::library_runtime::gate(root, &space)?;
        if Some(updated) == args.updated_at {
            changed=tx.execute("UPDATE index_jobs SET status='pending',attempts=0,last_error=NULL,next_attempt_at=0,
              updated_at=?1,worker_id=NULL,locked_at=NULL,lease_until=NULL,
              payload=json_remove(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.downloadSkippedGeneration') WHERE id=?2 AND status IN ('dismissed','failed')",params![now_timestamp(),id]).map_err(|e|e.to_string())?>0;
            if changed {
                tx.execute("UPDATE source_items SET status='discovered' WHERE id=(SELECT source_id FROM index_jobs WHERE id=?1) AND blob_hash IS NULL AND status IN ('unavailable','rejected')",[id]).map_err(|e|e.to_string())?;
            }
        }
    }
    let page = list(&tx, &args, changed)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(page)
}
#[tauri::command]
pub(crate) async fn skipped_index_jobs(app: tauri::AppHandle, args: Args) -> Result<Value, String> {
    let path = crate::database_path(&app)?;
    tokio::task::spawn_blocking(move || handle(&path, args))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_and_new_skips_survive_requeue_source_removal_and_reinstall() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE index_jobs(id INTEGER PRIMARY KEY,space_id TEXT,source_id TEXT,source_type TEXT,job_type TEXT,status TEXT,provider TEXT,last_error TEXT,attempts INTEGER,updated_at INTEGER,next_attempt_at INTEGER,worker_id TEXT,locked_at INTEGER,lease_until INTEGER);
          CREATE TABLE source_items(id TEXT,space_id TEXT,document_id TEXT,title TEXT,mime_type TEXT,metadata_json TEXT);CREATE TABLE documents(id TEXT,space_id TEXT,title TEXT,path TEXT);CREATE TABLE libraries(id TEXT,name TEXT,provider TEXT,enabled INTEGER);
          INSERT INTO libraries VALUES('a','Archive','craft',1);INSERT INTO source_items VALUES('s','a','doc','image.png','image/png','{}');INSERT INTO documents VALUES('doc','a','Parent','Folder/Parent');
          INSERT INTO index_jobs VALUES(1,'a','s','craft_attachment','ocr_page','dismissed','craft','bad image',3,10,0,NULL,NULL,NULL);").unwrap();
        schema(&c).unwrap();
        schema(&c).unwrap();
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM skipped_job_archive", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert!(retryable(&c, 1).unwrap().is_some());
        c.execute_batch("UPDATE index_jobs SET status='pending';DELETE FROM source_items;DELETE FROM index_jobs;DELETE FROM libraries;").unwrap();
        schema(&c).unwrap();
        assert!(retryable(&c, 1).unwrap().is_none());
        let page = list(
            &c,
            &Args {
                action: "list".into(),
                library_id: None,
                offset: 0,
                archive_id: None,
                updated_at: None,
            },
            false,
        )
        .unwrap();
        assert_eq!(page["total"], 1);
        assert_eq!(page["items"][0]["parentTitle"], "Parent");
        assert_eq!(page["items"][0]["error"], "bad image");
    }
}
