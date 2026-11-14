//! Repairs durable download work from verified cache and provider facts.
use crate::{
    blob_store::BlobStore, library_policy, library_runtime, now_timestamp, open_write_database,
};
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};
use std::{io::Read, path::PathBuf};
const UNSUPPORTED_OCR_SOURCE: &str = if cfg!(windows) {
    "s.source_type IN ('craft_attachment','dida_attachment','obsidian_attachment') AND COALESCE(s.mime_type,'') NOT IN ('','application/octet-stream','application/pdf') AND s.mime_type NOT LIKE 'image/%'"
} else {
    "s.source_type IN ('craft_attachment','dida_attachment','obsidian_attachment')"
};
pub(crate) fn retryable_ocr_sql(job_alias: &str) -> String {
    format!("({job_alias}.job_type!='ocr_page' OR NOT EXISTS(SELECT 1 FROM source_items s WHERE s.id={job_alias}.source_id AND s.space_id={job_alias}.space_id AND {UNSUPPORTED_OCR_SOURCE}))")
}

/// Metadata correction, not a successful extraction or a user's skip decision.
/// Keep the original attempts/error and never steal a running source's work.
pub(crate) fn retire_unsupported_ocr(c: &Connection, scope: Option<&str>) -> Result<usize, String> {
    let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
    let rows = {
        let mut q=tx.prepare(&format!("SELECT j.id,j.source_id FROM index_jobs j JOIN source_items s ON s.id=j.source_id AND s.space_id=j.space_id
          WHERE j.job_type='ocr_page' AND j.status IN ('pending','failed') AND (?1 IS NULL OR j.space_id=?1)
            AND {UNSUPPORTED_OCR_SOURCE}
            AND NOT EXISTS(SELECT 1 FROM index_jobs owner WHERE owner.source_id=j.source_id AND owner.job_type='ocr_page' AND owner.status='running')
          ORDER BY j.id LIMIT 32")).map_err(|e|e.to_string())?;
        let rows = q
            .query_map([scope], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    let now = now_timestamp();
    for (id, source) in &rows {
        tx.execute("UPDATE index_jobs SET status='not_applicable',updated_at=?1,next_attempt_at=0,worker_id=NULL,locked_at=NULL,lease_until=NULL,
          last_error=COALESCE(NULLIF(last_error,''),'当前设备或附件类型不适用文字识别；原件保留') WHERE id=?2",params![now,id]).map_err(|e|e.to_string())?;
        tx.execute("UPDATE ocr_pages SET status='not_applicable',updated_at=?1 WHERE source_item_id=?2 AND status IN ('failed','pending')",params![now,source]).map_err(|e|e.to_string())?;
        tx.execute("UPDATE extractions SET status='not_applicable',updated_at=?1 WHERE source_item_id=?2 AND extractor='windows_ocr' AND status IN ('failed','pending')",params![now,source]).map_err(|e|e.to_string())?;
        tx.execute("UPDATE source_items SET status='stored',updated_at=?1 WHERE id=?2 AND blob_hash IS NOT NULL AND status IN ('ocr_pending','ocr_failed','failed')",params![now,source]).map_err(|e|e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(rows.len())
}
pub(crate) fn reconcile_ocr_types(path: &PathBuf) -> Result<usize, String> {
    let (c, _writer) = open_write_database(path)?;
    retire_unsupported_ocr(&c, None)
}

pub(crate) fn provider_reports_missing(error: &str) -> bool {
    let Some(body) = error.strip_prefix("HTTP_STATUS:500 Internal Server Error ") else {
        return false;
    };
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| {
            v.get("errorCode")
                .and_then(|s| s.as_str())
                .map(str::to_owned)
        })
        .is_some_and(|code| matches!(code.as_str(), "attachment_not_exist" | "task_not_found"))
}

pub(crate) fn terminal_download_error(error: &str) -> bool {
    error.starts_with("ATTACHMENT_UNAVAILABLE:")
        || error.starts_with("HTTP_STATUS:404")
        || error.starts_with("HTTP_STATUS:410")
        || error.contains("超过 100 MB")
        || error.contains("只允许下载")
        || error.contains("元数据")
}

/// Policy waits remain durable and resume under the saved policy. They do not
/// mean a download is in progress and must not contribute to active UI counts.
pub(crate) fn blocked_downloads(
    c: &Connection,
    scope: Option<&str>,
    hidden: &str,
) -> Result<i64, String> {
    let policy = library_policy::eligible_sql(c, "download_source");
    c.query_row(
        &format!(
            "SELECT COUNT(*) FROM index_jobs j
        JOIN source_items s ON s.id=j.source_id JOIN libraries l ON l.id=j.space_id
        WHERE j.job_type IN ('download_source','import_local_source') AND j.status='pending'
          AND (?1 IS NULL OR j.space_id=?1)
          AND NOT EXISTS(SELECT 1 FROM json_each(?2) h WHERE h.value=j.space_id)
          AND NOT ({policy})"
        ),
        params![scope, hidden],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// Never claims a network job or alters a running owner. Cache checks happen
/// without holding the writer, then the same source hash/state is revalidated.
pub(crate) fn reconcile(path: &PathBuf, store: &BlobStore) -> Result<usize, String> {
    let c = crate::open_database(path)?;
    let rows = {
        let mut q = c.prepare("SELECT j.id,j.space_id,j.source_id,j.status,j.last_error,s.provider,s.blob_hash,b.size
          FROM index_jobs j JOIN source_items s ON s.id=j.source_id LEFT JOIN blobs b ON b.hash=s.blob_hash
          WHERE j.job_type='download_source' AND j.status IN ('pending','failed')
            AND ((s.blob_hash IS NOT NULL AND b.size IS NOT NULL AND COALESCE(s.mime_type,'') NOT LIKE 'image/%' AND COALESCE(s.mime_type,'')!='application/pdf')
                 OR (s.provider='dida365' AND j.status='failed' AND j.last_error LIKE 'HTTP_STATUS:500%'))
          ORDER BY j.id LIMIT 32").map_err(|e|e.to_string())?;
        let rows = q
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, Option<String>>(6)?,
                    r.get::<_, Option<u64>>(7)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    drop(c);
    let root = path.parent().ok_or("资料库路径不可用")?;
    let mut completed = 0;
    for (id, space, source, status, error, provider, hash, size) in rows {
        let operation = match library_runtime::begin(root, &space, "核对下载任务") {
            Ok(op) => op,
            Err(e) if library_runtime::is_control_error(&e) => continue,
            Err(e) => return Err(e),
        };
        let cached = if let (Some(hash), Some(size)) = (&hash, size) {
            let valid = (|| -> Result<bool, String> {
                let file_path = store.local_path_for(hash)?;
                let mut file = std::fs::File::open(file_path).map_err(|e| e.to_string())?;
                if file.metadata().map_err(|e| e.to_string())?.len() != size {
                    return Ok(false);
                }
                let mut digest = Sha256::new();
                let mut buffer = [0; 64 * 1024];
                loop {
                    operation.checkpoint()?;
                    let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
                    if n == 0 {
                        break;
                    }
                    digest.update(&buffer[..n]);
                }
                Ok(format!("{:x}", digest.finalize()) == *hash)
            })();
            valid.unwrap_or(false)
        } else {
            false
        };
        let missing = !cached
            && provider == "dida365"
            && hash.is_none()
            && error.as_deref().is_some_and(provider_reports_missing);
        if !cached && !missing {
            continue;
        }
        let (mut c, _writer) = open_write_database(path)?;
        let tx = c.transaction().map_err(|e| e.to_string())?;
        let now = now_timestamp();
        let changed=tx.execute("UPDATE index_jobs SET status='completed',updated_at=?1,next_attempt_at=0,worker_id=NULL,locked_at=NULL,lease_until=NULL,last_error=?2
          WHERE id=?3 AND status=?4 AND last_error IS ?5 AND EXISTS(SELECT 1 FROM source_items s WHERE s.id=?6 AND s.blob_hash IS ?7)",
          params![now,if missing {Some("ATTACHMENT_UNAVAILABLE:滴答服务器确认附件或所属任务不存在")} else {None},id,status,error,source,hash]).map_err(|e|e.to_string())?;
        if changed > 0 && missing {
            tx.execute("UPDATE source_items SET status='unavailable',updated_at=?1 WHERE id=?2 AND blob_hash IS NULL",params![now,source]).map_err(|e|e.to_string())?;
        }
        operation.commit(|| tx.commit().map_err(|e| e.to_string()))?;
        completed += changed;
    }
    Ok(completed)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn attachment_disposition_startup_and_retry_keep_video_out_of_failures() {
        let root = std::env::temp_dir().join(format!(
            "hub-ocr-disposition-{}",
            crate::random_url_safe(12)
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("craft-search.sqlite3");
        let c = crate::open_database(&path).unwrap();
        c.execute(
            "INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES('a','craft','A',1,1)",
            [],
        )
        .unwrap();
        for (id, mime, status) in [
            ("video", "video/mp4", "failed"),
            ("image", "image/jpeg", "failed"),
            ("pdf", "application/pdf", "failed"),
            ("unknown", "", "failed"),
            ("running", "video/mp4", "running"),
            ("dismissed", "video/mp4", "dismissed"),
        ] {
            c.execute("INSERT INTO source_items(id,space_id,document_id,remote_id,source_type,title,mime_type,status,metadata_json,provider,created_at,updated_at) VALUES(?1,'a','doc',?1,'craft_attachment',?1,?2,'stored','{\"linkKind\":\"image\"}','craft',1,1)",params![id,mime]).unwrap();
            c.execute("INSERT INTO index_jobs(job_key,space_id,source_id,source_type,job_type,status,attempts,payload,last_error,created_at,updated_at) VALUES(?1,'a',?1,'craft_attachment','ocr_page',?2,2,'{\"pageNumber\":1}','original diagnostic',1,1)",params![id,status]).unwrap();
        }
        c.execute("INSERT INTO extractions(id,source_item_id,extractor,extractor_version,status,page_count,created_at,updated_at,last_error) VALUES('ocr:video','video','windows_ocr','1','failed',1,1,1,'original diagnostic')",[]).unwrap();
        c.execute("INSERT INTO ocr_pages(source_item_id,page_number,status,updated_at,last_error) VALUES('video',1,'failed',1,'original diagnostic')",[]).unwrap();
        drop(c);
        crate::database::forget_initialized_database(&path);
        let c = crate::open_database(&path).unwrap();
        let video: (String, i64, String) = c
            .query_row(
                "SELECT status,attempts,last_error FROM index_jobs WHERE source_id='video'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            video,
            ("not_applicable".into(), 2, "original diagnostic".into())
        );
        assert_eq!(c.query_row("SELECT p.status,e.status FROM ocr_pages p JOIN extractions e ON e.source_item_id=p.source_item_id WHERE p.source_item_id='video'",[],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).unwrap(),("not_applicable".into(),"not_applicable".into()));
        for (id, expected) in [
            ("image", "failed"),
            ("pdf", "failed"),
            ("unknown", "failed"),
            ("running", "running"),
            ("dismissed", "dismissed"),
        ] {
            assert_eq!(
                c.query_row(
                    "SELECT status FROM index_jobs WHERE source_id=?1",
                    [id],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
                expected
            );
        }
        // New stale work can arrive after initialization. Even beyond one
        // maintenance batch, neither retry entry may put it back in the queue.
        for n in 0..34 {
            let id = format!("late-{n}");
            c.execute("INSERT INTO source_items(id,space_id,document_id,remote_id,source_type,title,mime_type,status,provider,created_at,updated_at) VALUES(?1,'a','doc',?1,'craft_attachment',?1,'video/mp4','stored','craft',1,1)",[&id]).unwrap();
            c.execute("INSERT INTO index_jobs(job_key,space_id,source_id,source_type,job_type,status,attempts,payload,last_error,created_at,updated_at) VALUES(?1,'a',?1,'craft_attachment','ocr_page','failed',2,'{\"pageNumber\":1}','original diagnostic',1,1)",[&id]).unwrap();
        }
        drop(c);
        assert_eq!(crate::retry_failed_ocr_jobs(&path, Some("a")).unwrap(), 3);
        let c = crate::open_database(&path).unwrap();
        assert_eq!(
            c.query_row(
                "SELECT status FROM index_jobs WHERE source_id='video'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "not_applicable"
        );
        assert_eq!(c.query_row("SELECT COUNT(*) FROM index_jobs WHERE source_id LIKE 'late-%' AND status IN ('pending','running')",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        drop(c);
        assert_eq!(
            crate::retry_failed_index_jobs(&path, Some("a"), true).unwrap(),
            0
        );
        let c = crate::open_database(&path).unwrap();
        assert_eq!(
            crate::index_job_metadata::counts(&c, None, "[]").unwrap().4,
            0
        );
        drop(c);
        crate::database::forget_initialized_database(&path);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn attachment_followup_missing_task_is_terminal_provider_fact() {
        assert!(provider_reports_missing(
            "HTTP_STATUS:500 Internal Server Error {\"errorCode\":\"task_not_found\"}"
        ));
        for error in [
            "HTTP_STATUS:500 Internal Server Error {\"errorCode\":\"temporary_failure\",\"errorMessage\":\"task_not_found\"}",
            "HTTP_STATUS:503 Service Unavailable {\"errorCode\":\"task_not_found\"}",
        ] {
            assert!(!provider_reports_missing(error));
        }
    }
    #[test]
    fn missing_provider_fact_requires_exact_structured_code() {
        assert!(provider_reports_missing(
            "HTTP_STATUS:500 Internal Server Error {\"errorCode\":\"attachment_not_exist\"}"
        ));
        for s in ["HTTP_STATUS:500 Internal Server Error unavailable", "HTTP_STATUS:500 Internal Server Error {\"errorCode\":\"temporary_failure\",\"message\":\"attachment_not_exist\"}","HTTP_STATUS:503 Service Unavailable {\"errorCode\":\"attachment_not_exist\"}"] {assert!(!provider_reports_missing(s));}
    }
    #[test]
    fn cache_reconciliation_preserves_running_corrupt_and_policy_waits() {
        let root = std::env::temp_dir().join(format!("hub-queue-{}", crate::random_url_safe(16)));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("craft-search.sqlite3");
        let c = crate::open_database(&path).unwrap();
        let store = BlobStore::open(&root.join("blobs")).unwrap();
        c.execute("INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES('a','dida365','A',1,1)",[]).unwrap();
        let blob = store.put(b"verified stored attachment").unwrap();
        c.execute("INSERT INTO blobs(hash,size,mime_type,relative_path,created_at,verified_at) VALUES(?1,?2,'video/mp4',?3,1,1)",params![blob.hash,blob.size,blob.relative_path]).unwrap();
        for (id,status,hash,error) in [("cached","pending",Some(blob.hash.as_str()),None),("running","running",Some(blob.hash.as_str()),None),("missing","failed",None,Some("HTTP_STATUS:500 Internal Server Error {\"errorCode\":\"attachment_not_exist\"}")),("missing-task","failed",None,Some("HTTP_STATUS:500 Internal Server Error {\"errorCode\":\"task_not_found\"}")),("wait","pending",None,None)] {
            c.execute("INSERT INTO source_items(id,space_id,document_id,remote_id,source_type,title,mime_type,status,blob_hash,provider,created_at,updated_at) VALUES(?1,'a','doc',?1,'dida_attachment',?1,'video/mp4','stored',?2,'dida365',1,1)",params![id,hash]).unwrap();
            c.execute("INSERT INTO index_jobs(job_key,space_id,source_id,source_type,job_type,status,created_at,updated_at,last_error) VALUES(?1,'a',?1,'dida_attachment','download_source',?2,1,1,?3)",params![id,status,error]).unwrap();
        }
        // Craft/Dida original downloads are automatically owned. Put the
        // explicit policy wait in an Obsidian library where it still applies.
        c.execute("INSERT INTO libraries(id,provider,name,enabled,added_at,metadata_json) VALUES('b','obsidian','B',1,1,'{\"contentPolicy\":{\"imageDownload\":false}}')",[]).unwrap();
        c.execute("UPDATE source_items SET space_id='b',provider='obsidian',source_type='obsidian_file',mime_type='image/png' WHERE id='wait'",[]).unwrap();
        c.execute(
            "UPDATE index_jobs SET space_id='b',source_type='obsidian_file' WHERE source_id='wait'",
            [],
        )
        .unwrap();
        assert_eq!(blocked_downloads(&c, None, "[]").unwrap(), 1);
        assert_eq!(blocked_downloads(&c, Some("a"), "[]").unwrap(), 0);
        assert_eq!(reconcile(&path, &store).unwrap(), 3);
        assert_eq!(blocked_downloads(&c, None, "[]").unwrap(), 1);
        assert_eq!(blocked_downloads(&c, Some("b"), "[]").unwrap(), 1);
        assert_eq!(blocked_downloads(&c, Some("b"), "[\"b\"]").unwrap(), 0);
        assert_eq!(reconcile(&path, &store).unwrap(), 0);
        assert_eq!(
            c.query_row(
                "SELECT status FROM index_jobs WHERE source_id='running'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "running"
        );
        assert_eq!(
            c.query_row(
                "SELECT status FROM source_items WHERE id='missing'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "unavailable"
        );
        let missing_task: (String, String) = c.query_row(
            "SELECT s.status,j.last_error FROM source_items s JOIN index_jobs j ON j.source_id=s.id WHERE s.id='missing-task'",
            [], |r| Ok((r.get(0)?,r.get(1)?)),
        ).unwrap();
        assert_eq!(missing_task.0, "unavailable");
        assert!(missing_task.1.starts_with("ATTACHMENT_UNAVAILABLE:"));
        c.execute(
            "UPDATE index_jobs SET status='pending' WHERE source_id='cached'",
            [],
        )
        .unwrap();
        std::fs::write(store.local_path_for(&blob.hash).unwrap(), b"corrupted").unwrap();
        assert_eq!(reconcile(&path, &store).unwrap(), 0);
        drop(c);
        std::fs::remove_dir_all(root).unwrap();
    }
}
