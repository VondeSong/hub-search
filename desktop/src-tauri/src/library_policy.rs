//! Persisted content-stage policy. A policy change never schedules historical work.
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Policy {
    pub image_download: bool,
    pub image_ocr: bool,
    pub pdf_download: bool,
    pub other_download: bool,
    pub pdf_text: bool,
    pub pdf_ocr: bool,
    pub outgoing_attachments: bool,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub(crate) struct Overrides {
    pub image_download: Option<bool>,
    pub image_ocr: Option<bool>,
    pub pdf_download: Option<bool>,
    pub other_download: Option<bool>,
    pub pdf_text: Option<bool>,
    pub pdf_ocr: Option<bool>,
    pub outgoing_attachments: Option<bool>,
}
impl Overrides {
    fn resolve(&self, global: &Policy) -> Policy {
        Policy {
            image_download: self.image_download.unwrap_or(global.image_download),
            image_ocr: self.image_ocr.unwrap_or(global.image_ocr),
            pdf_download: self.pdf_download.unwrap_or(global.pdf_download),
            other_download: self.other_download.unwrap_or(global.other_download),
            pdf_text: self.pdf_text.unwrap_or(global.pdf_text),
            pdf_ocr: self.pdf_ocr.unwrap_or(global.pdf_ocr),
            outgoing_attachments: self
                .outgoing_attachments
                .unwrap_or(global.outgoing_attachments),
        }
    }
}
pub(crate) fn global(connection: &Connection) -> Policy {
    let old_pdf = crate::metadata_bool(connection, "pdf_enabled", true);
    Policy {
        // Downloading images no longer depends on the legacy OCR switch.
        image_download: crate::metadata_bool(connection, "image_download_enabled", true),
        image_ocr: crate::metadata_bool(
            connection,
            "image_ocr_policy_enabled",
            crate::metadata_bool(connection, "image_ocr_enabled", true),
        ),
        pdf_download: crate::metadata_bool(connection, "pdf_download_enabled", old_pdf),
        other_download: crate::metadata_bool(connection, "other_download_enabled", false),
        pdf_text: crate::metadata_bool(connection, "pdf_native_text_enabled", old_pdf),
        pdf_ocr: crate::metadata_bool(
            connection,
            "pdf_ocr_policy_enabled",
            old_pdf && crate::metadata_bool(connection, "pdf_ocr_enabled", true),
        ),
        outgoing_attachments: crate::metadata_bool(
            connection,
            "outgoing_attachments_enabled",
            true,
        ),
    }
}
pub(crate) fn capabilities(provider: &str) -> Policy {
    capabilities_for(provider, cfg!(windows))
}
fn capabilities_for(provider: &str, native_ocr: bool) -> Policy {
    let incoming = matches!(provider, "craft" | "obsidian" | "dida365" | "global");
    Policy {
        image_download: incoming,
        image_ocr: incoming && native_ocr,
        pdf_download: incoming,
        other_download: matches!(provider, "craft" | "dida365" | "global"),
        pdf_text: incoming,
        pdf_ocr: incoming && native_ocr,
        outgoing_attachments: matches!(provider, "craft" | "obsidian" | "dida365" | "global"),
    }
}
fn library(connection: &Connection, id: &str) -> Result<(String, Value), String> {
    let (provider, metadata): (String, Option<String>) = connection
        .query_row(
            "SELECT provider,metadata_json FROM libraries WHERE id=?1 AND enabled=1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "找不到已启用的资料库。".to_string())?;
    let metadata = metadata
        .map(|value| serde_json::from_str(&value))
        .transpose()
        .map_err(|_| "资料库设置格式无效。".to_string())?
        .unwrap_or_else(|| json!({}));
    if !metadata.is_object() {
        return Err("资料库设置格式无效。".into());
    }
    Ok((provider, metadata))
}
fn overrides(metadata: &Value) -> Result<Overrides, String> {
    metadata
        .get("contentPolicy")
        .filter(|value| !value.is_null())
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|_| "资料库内容策略格式无效。".to_string())
        .map(|value| value.unwrap_or_default())
}
pub(crate) fn effective(connection: &Connection, id: &str) -> Result<Policy, String> {
    let (provider, metadata) = library(connection, id)?;
    let mut policy = overrides(&metadata)?.resolve(&global(connection));
    let support = capabilities(&provider);
    policy.image_download &= support.image_download;
    policy.image_ocr &= support.image_ocr;
    policy.pdf_download &= support.pdf_download;
    policy.pdf_text &= support.pdf_text;
    policy.other_download &= support.other_download;
    policy.pdf_ocr &= support.pdf_ocr;
    policy.outgoing_attachments &= support.outgoing_attachments;
    if matches!(provider.as_str(), "craft" | "dida365") {
        // These are durable Hub originals; OCR/extraction and outgoing writes
        // remain separate options, but local preservation is unconditional.
        policy.image_download = true;
        policy.pdf_download = true;
        policy.other_download = true;
    }
    Ok(policy)
}
pub(crate) fn get(connection: &Connection, id: Option<&str>) -> Result<Value, String> {
    let global = global(connection);
    match id.filter(|id| !id.trim().is_empty()) {
        Some(id) => {
            let (provider, metadata) = library(connection, id)?;
            Ok(
                json!({"libraryId":id,"provider":provider,"global":global,"overrides":overrides(&metadata)?,"effective":effective(connection,id)?,"capabilities":capabilities(&provider)}),
            )
        }
        None => Ok(
            json!({"libraryId":Value::Null,"provider":"global","global":global,"overrides":Overrides::default(),"effective":global,"capabilities":capabilities("global")}),
        ),
    }
}
pub(crate) fn save(
    connection: &mut Connection,
    id: Option<&str>,
    args: &Value,
) -> Result<Value, String> {
    let transaction = connection
        .transaction()
        .map_err(|_| "无法保存资料库内容策略。".to_string())?;
    match id.filter(|id| !id.trim().is_empty()) {
        Some(id) => {
            let value: Overrides = serde_json::from_value(
                args.get("policy")
                    .or_else(|| args.get("overrides"))
                    .cloned()
                    .unwrap_or(Value::Null),
            )
            .map_err(|_| "资料库内容策略格式无效。".to_string())?;
            let (_, mut metadata) = library(&transaction, id)?;
            metadata["contentPolicy"] = json!(value);
            transaction
                .execute(
                    "UPDATE libraries SET metadata_json=?1 WHERE id=?2 AND enabled=1",
                    params![metadata.to_string(), id],
                )
                .map_err(|_| "无法保存资料库内容策略。".to_string())?;
        }
        None => {
            let policy: Policy = serde_json::from_value(args["policy"].clone())
                .map_err(|_| "全局内容策略格式无效。".to_string())?;
            for (key, value) in [
                ("image_download_enabled", policy.image_download),
                ("image_ocr_policy_enabled", policy.image_ocr),
                ("image_ocr_enabled", policy.image_ocr),
                ("pdf_download_enabled", policy.pdf_download),
                ("pdf_native_text_enabled", policy.pdf_text),
                ("other_download_enabled", policy.other_download),
                ("pdf_ocr_policy_enabled", policy.pdf_ocr),
                ("pdf_ocr_enabled", policy.pdf_ocr),
                ("outgoing_attachments_enabled", policy.outgoing_attachments),
                // Compatibility snapshot for existing settings clients.
                (
                    "pdf_enabled",
                    policy.pdf_download || policy.pdf_text || policy.pdf_ocr,
                ),
            ] {
                transaction.execute("INSERT INTO metadata(key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,if value {"1"} else {"0"}]).map_err(|_| "无法保存全局内容策略。".to_string())?;
            }
            transaction.execute("INSERT INTO metadata(key,value) VALUES ('library_policy_explicit_mode','1') ON CONFLICT(key) DO UPDATE SET value='1'",[]).map_err(|_| "无法保存内容策略迁移状态。".to_string())?;
        }
    }
    transaction
        .commit()
        .map_err(|_| "无法保存资料库内容策略。".to_string())?;
    get(connection, id)
}

/// Explicitly supplement missing or failed stages for this library. Completed
/// work is preserved; merely changing an option never calls this function.
pub(crate) fn supplement(connection: &mut Connection, id: &str) -> Result<usize, String> {
    let policy = effective(connection, id)?;
    let transaction = connection
        .transaction()
        .map_err(|_| "无法准备资料库补齐任务。".to_string())?;
    let sources = {
        let mut statement = transaction.prepare("SELECT id,source_type,provider,COALESCE(mime_type,''),COALESCE(json_extract(metadata_json,'$.linkKind'),''),blob_hash FROM source_items WHERE space_id=?1 AND source_type IN ('craft_attachment','dida_attachment','obsidian_attachment')").map_err(|_| "无法读取待补齐附件。".to_string())?;
        let values = statement
            .query_map([id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            })
            .map_err(|_| "无法读取待补齐附件。".to_string())?;
        values
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "无法读取待补齐附件。".to_string())?
    };
    let mut queued = 0;
    let now = crate::now_timestamp();
    for (source, source_type, provider, mime, link_kind, blob) in sources {
        let job_type = if blob.is_none() {
            if provider == "obsidian" {
                "import_local_source"
            } else {
                "download_source"
            }
        } else if mime == "application/pdf" {
            "extract_pdf"
        } else if is_image_source(&mime, &link_kind) {
            "ocr_page"
        } else {
            continue;
        };
        if !source_allowed(&policy, job_type, &mime, &link_kind) {
            continue;
        }
        if job_type == "download_source" {
            let metadata: String = transaction
                .query_row(
                    "SELECT COALESCE(metadata_json,'{}') FROM source_items WHERE id=?1",
                    [&source],
                    |row| row.get(0),
                )
                .map_err(|_| "无法读取附件下载决定")?;
            if crate::attachment_download_failures::is_skipped(&transaction, &source, &metadata)? {
                continue;
            }
        }
        if job_type == "ocr_page" {
            let completed: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM extractions WHERE source_item_id=?1 AND extractor='windows_ocr' AND status='completed')",[&source],|r|r.get(0)).map_err(|_|"无法核对附件完成状态。".to_string())?;
            if completed {
                continue;
            }
            crate::queue_ocr_pages(&transaction, id, &source, 1, &[1], now)?;
            queued += 1;
            continue;
        }
        if job_type == "extract_pdf" {
            let native_done: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM extractions WHERE source_item_id=?1 AND extractor='pdf_native' AND status IN ('completed','partial','needs_ocr') AND page_count>0)",[&source],|r|r.get(0)).map_err(|_|"无法核对 PDF 完成状态。".to_string())?;
            let ocr_done: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM extractions WHERE source_item_id=?1 AND extractor='windows_ocr' AND status IN ('completed','empty'))",[&source],|r|r.get(0)).map_err(|_|"无法核对 PDF OCR 完成状态。".to_string())?;
            if (!policy.pdf_text || native_done) && (!policy.pdf_ocr || ocr_done) {
                continue;
            }
            transaction.execute("INSERT INTO extractions(id,source_item_id,extractor,extractor_version,status,created_at,updated_at) VALUES (?1,?2,'pdf_native','1','pending',?3,?3) ON CONFLICT(source_item_id,extractor,extractor_version) DO NOTHING",params![format!("pdf-native-v1:{source}"),source,now]).map_err(|_|"无法准备 PDF 提取记录。".to_string())?;
        }
        let prefix = if job_type == "extract_pdf" {
            "extract-pdf"
        } else if job_type == "import_local_source" {
            "import-local"
        } else {
            "download"
        };
        queued += transaction.execute("INSERT INTO index_jobs(job_key,space_id,source_id,source_type,job_type,status,priority,created_at,updated_at,provider) VALUES (?1,?2,?3,?4,?5,'pending',25,?6,?6,?7) ON CONFLICT(job_key) DO UPDATE SET status='pending',attempts=0,last_error=NULL,next_attempt_at=0,worker_id=NULL,locked_at=NULL,lease_until=NULL,updated_at=excluded.updated_at WHERE index_jobs.status NOT IN ('pending','running')",params![format!("{prefix}:{source}"),id,source,source_type,job_type,now,provider]).map_err(|_|"无法安排附件补齐任务。".to_string())?;
    }
    transaction
        .commit()
        .map_err(|_| "无法保存资料库补齐任务。".to_string())?;
    Ok(queued)
}
pub(crate) fn stage_allowed(policy: &Policy, job_type: &str, pdf: bool) -> bool {
    match (job_type, pdf) {
        ("download_source" | "import_local_source", false) => policy.image_download,
        ("download_source" | "import_local_source", true) => policy.pdf_download,
        ("extract_pdf", true) => policy.pdf_text || policy.pdf_ocr,
        ("ocr_page", false) => policy.image_ocr,
        ("ocr_page", true) => policy.pdf_ocr,
        _ => false,
    }
}
// A concrete MIME type wins over legacy presentation metadata.
pub(crate) fn is_image_source(mime: &str, link_kind: &str) -> bool {
    mime.starts_with("image/")
        || (matches!(mime, "" | "application/octet-stream") && link_kind == "image")
}
pub(crate) fn source_allowed(policy: &Policy, job_type: &str, mime: &str, link_kind: &str) -> bool {
    if mime == "application/pdf" {
        stage_allowed(policy, job_type, true)
    } else if is_image_source(mime, link_kind) {
        stage_allowed(policy, job_type, false)
    } else {
        matches!(job_type, "download_source" | "import_local_source") && policy.other_download
    }
}
pub(crate) fn outgoing_enabled(
    root: &std::path::Path,
    id: &str,
    provider: &str,
) -> Result<bool, String> {
    let connection = crate::open_database(&root.join("craft-search.sqlite3"))?;
    let (actual, _) = library(&connection, id)?;
    if actual != provider {
        return Err("资料库提供方已变化。".into());
    }
    Ok(effective(&connection, id)?.outgoing_attachments)
}
/// Fixed SQL over the existing j/s/l aliases. Filtering happens before ranking,
/// so disabled images cannot starve enabled PDFs in the same library.
pub(crate) fn eligible_sql(connection: &Connection, job_type: &str) -> String {
    if job_type == "ocr_page" && !cfg!(windows) {
        return "0".into();
    }
    let global = global(connection);
    let field = |name: &str, fallback: bool| {
        let setting = format!(
            "COALESCE(json_extract(l.metadata_json,'$.contentPolicy.{name}'),{})=1",
            if fallback { 1 } else { 0 }
        );
        if matches!(name, "imageDownload" | "pdfDownload" | "otherDownload") {
            format!("(l.provider IN ('craft','dida365') OR ({setting}))")
        } else {
            setting
        }
    };
    let (image, pdf) = match job_type {
        "download_source" | "import_local_source" => (
            field("imageDownload", global.image_download),
            field("pdfDownload", global.pdf_download),
        ),
        "extract_pdf" => (
            "0".into(),
            format!(
                "({} OR {})",
                field("pdfText", global.pdf_text),
                field("pdfOcr", global.pdf_ocr)
            ),
        ),
        "ocr_page" => (
            field("imageOcr", global.image_ocr),
            field("pdfOcr", global.pdf_ocr),
        ),
        _ => ("0".into(), "0".into()),
    };
    let other = if matches!(job_type, "download_source" | "import_local_source") {
        field("otherDownload", global.other_download)
    } else {
        "0".into()
    };
    let disposition = if job_type == "download_source" {
        format!(
            " AND {}",
            crate::attachment_download_failures::eligible_sql()
        )
    } else {
        String::new()
    };
    let image_source = "(COALESCE(s.mime_type,'') LIKE 'image/%' OR (COALESCE(s.mime_type,'') IN ('','application/octet-stream') AND COALESCE(json_extract(s.metadata_json,'$.linkKind'),'')='image'))";
    format!("l.enabled=1 AND l.provider IN ('craft','obsidian','dida365') AND ((({image}) AND {image_source}) OR (({pdf}) AND COALESCE(s.mime_type,'')='application/pdf') OR (({other}) AND l.provider IN ('craft','dida365') AND COALESCE(s.mime_type,'')!='application/pdf' AND NOT {image_source})){disposition}")
}

#[cfg(test)]
mod tests {
    #[test]
    fn mobile_keeps_originals_and_pdf_text_without_scheduling_desktop_ocr() {
        let policy = super::capabilities_for("craft", false);
        assert!(policy.image_download && policy.pdf_download && policy.pdf_text);
        assert!(!policy.image_ocr && !policy.pdf_ocr);
        assert!(super::capabilities_for("craft", true).image_ocr);
        assert!(!super::capabilities_for("feishu", true).image_download);
    }
    use super::*;
    use crate::{blob_store::BlobStore, library_runtime};
    use std::path::PathBuf;

    #[test]
    fn missing_mime_original_is_downloadable_for_an_automatically_owned_provider() {
        let c = crate::open_database(&std::env::temp_dir().join(format!(
            "hub-null-mime-{}.sqlite3",
            crate::random_url_safe(12)
        )))
        .unwrap();
        c.execute(
            "INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES('a','craft','A',1,1)",
            [],
        )
        .unwrap();
        c.execute("INSERT INTO source_items(id,space_id,document_id,remote_id,source_type,title,status,metadata_json,created_at,updated_at) VALUES('s','a','doc','s','craft_attachment','file','deferred','{\"linkKind\":\"link\"}',1,1)",[]).unwrap();
        c.execute("INSERT INTO index_jobs(job_key,space_id,source_id,source_type,job_type,status,created_at,updated_at) VALUES('download:s','a','s','craft_attachment','download_source','pending',1,1)",[]).unwrap();
        let filter = eligible_sql(&c, "download_source");
        let allowed:bool=c.query_row(&format!("SELECT ({filter}) FROM index_jobs j JOIN source_items s ON s.id=j.source_id JOIN libraries l ON l.id=j.space_id"),[],|r|r.get(0)).unwrap();
        assert!(allowed);
        assert_eq!(
            crate::attachment_queue::blocked_downloads(&c, None, "[]").unwrap(),
            0
        );
        let path = std::path::PathBuf::from(c.path().unwrap());
        drop(c);
        crate::forget_initialized_database(&path);
        std::fs::remove_file(path).unwrap();
    }

    struct Scratch {
        root: PathBuf,
        path: PathBuf,
    }
    impl Scratch {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "hub-library-policy-test-{}",
                crate::random_url_safe(16)
            ));
            std::fs::create_dir_all(&root).unwrap();
            let path = root.join("craft-search.sqlite3");
            drop(crate::open_database(&path).unwrap());
            Self { root, path }
        }
        fn connection(&self) -> Connection {
            crate::open_database(&self.path).unwrap()
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
    fn library(connection: &Connection, id: &str, provider: &str, policy: Value) {
        connection.execute("INSERT INTO libraries(id,provider,name,enabled,added_at,metadata_json) VALUES (?1,?2,?1,1,1,?3)",params![id,provider,json!({"preserved":"keep","contentPolicy":policy}).to_string()]).unwrap();
    }
    fn source(
        connection: &Connection,
        id: &str,
        library: &str,
        mime: &str,
        provider: &str,
        blob: Option<&str>,
    ) {
        let kind = if provider == "obsidian" {
            "obsidian_attachment"
        } else if provider == "dida365" {
            "dida_attachment"
        } else {
            "craft_attachment"
        };
        connection.execute("INSERT INTO source_items(id,space_id,document_id,remote_id,source_type,title,mime_type,status,blob_hash,created_at,updated_at,provider) VALUES (?1,?2,'doc',?1,?3,?1,?4,'discovered',?5,1,1,?6)",params![id,library,kind,mime,blob,provider]).unwrap();
    }
    fn download(connection: &Connection, id: &str, library: &str) {
        connection.execute("INSERT INTO index_jobs(job_key,space_id,source_id,source_type,job_type,status,priority,created_at,updated_at) VALUES (?1,?2,?3,'craft_attachment','download_source','pending',30,1,1)",params![format!("download:{id}"),library,id]).unwrap();
    }
    #[test]
    fn owned_provider_originals_are_unconditional_in_policy_and_queue_without_forcing_ocr() {
        let fixture = Scratch::new();
        let c = fixture.connection();
        for key in [
            "image_download_enabled",
            "pdf_download_enabled",
            "other_download_enabled",
            "image_ocr_policy_enabled",
            "pdf_native_text_enabled",
            "pdf_ocr_policy_enabled",
        ] {
            c.execute("INSERT INTO metadata(key,value) VALUES(?1,'0') ON CONFLICT(key) DO UPDATE SET value='0'", [key]).unwrap();
        }
        for (id, provider) in [
            ("craft", "craft"),
            ("dida", "dida365"),
            ("obsidian", "obsidian"),
        ] {
            library(
                &c,
                id,
                provider,
                json!({"imageDownload":false,"pdfDownload":false,"otherDownload":false}),
            );
            let p = effective(&c, id).unwrap();
            let owned = provider != "obsidian";
            assert_eq!(p.image_download, owned);
            assert_eq!(p.pdf_download, owned);
            assert_eq!(p.other_download, owned);
            assert!(!p.image_ocr && !p.pdf_text && !p.pdf_ocr);
            for (suffix, mime) in [
                ("image", "image/png"),
                ("pdf", "application/pdf"),
                ("video", "video/mp4"),
            ] {
                let source_id = format!("{id}-{suffix}");
                source(&c, &source_id, id, mime, provider, None);
                download(&c, &source_id, id);
                let filter = eligible_sql(&c, "download_source");
                let queued: bool = c.query_row(&format!("SELECT ({filter}) FROM index_jobs j JOIN source_items s ON s.id=j.source_id JOIN libraries l ON l.id=j.space_id WHERE s.id=?1"), [&source_id], |r|r.get(0)).unwrap();
                assert_eq!(queued, owned);
            }
        }
        library(&c, "new-craft", "craft", Value::Null);
        assert!(effective(&c, "new-craft").unwrap().other_download);
    }
    #[test]
    fn library_management_policy_migration_separates_download_and_ocr() {
        let fixture = Scratch::new();
        let connection = fixture.connection();
        connection.execute_batch("INSERT INTO metadata(key,value) VALUES ('image_ocr_enabled','0'),('pdf_enabled','0'),('pdf_ocr_enabled','1');").unwrap();
        let policy = global(&connection);
        assert!(policy.image_download);
        assert!(!policy.image_ocr);
        assert!(!policy.pdf_download && !policy.pdf_text && !policy.pdf_ocr);
        assert!(!policy.other_download);
        assert!(source_allowed(&policy, "download_source", "image/png", ""));
        assert!(!source_allowed(&policy, "ocr_page", "image/png", ""));
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM index_jobs", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn library_management_policy_persistence_inheritance_and_capability() {
        let fixture = Scratch::new();
        let mut connection = fixture.connection();
        library(&connection, "vault", "obsidian", Value::Null);
        library(&connection, "feishu", "feishu", Value::Null);
        let mut policy = global(&connection);
        policy.image_ocr = false;
        policy.pdf_text = false;
        save(&mut connection, None, &json!({"policy":policy})).unwrap();
        save(
            &mut connection,
            Some("vault"),
            &json!({"overrides":{"imageOcr":true,"pdfText":true,"otherDownload":true}}),
        )
        .unwrap();
        let resolved = effective(&connection, "vault").unwrap();
        assert!(resolved.image_ocr && resolved.pdf_text && resolved.outgoing_attachments);
        assert!(!resolved.other_download);
        let metadata: String = connection
            .query_row(
                "SELECT metadata_json FROM libraries WHERE id='vault'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&metadata).unwrap()["preserved"],
            "keep"
        );
        assert!(!effective(&connection, "feishu").unwrap().image_download);
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM index_jobs", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        // Old compatibility metadata cannot override the new single policy.
        connection
            .execute(
                "UPDATE metadata SET value='1' WHERE key='image_ocr_enabled'",
                [],
            )
            .unwrap();
        assert!(!global(&connection).image_ocr);
        assert!(
            !crate::read_settings(&fixture.path)
                .unwrap()
                .image_ocr_enabled
        );
    }

    #[test]
    fn library_management_uniform_policy_payload_keeps_nullable_inheritance() {
        let fixture = Scratch::new();
        let mut connection = fixture.connection();
        library(&connection, "one", "craft", Value::Null);
        let saved=save(&mut connection,Some("one"),&json!({"policy":{"imageDownload":null,"imageOcr":false,"pdfDownload":null,"otherDownload":true,"pdfText":null,"pdfOcr":null,"outgoingAttachments":null},"overrides":{"imageOcr":true}})).unwrap();
        assert_eq!(saved["overrides"]["imageDownload"], Value::Null);
        assert_eq!(saved["effective"]["imageOcr"], false);
        assert_eq!(saved["effective"]["otherDownload"], true);
        assert!(save(
            &mut connection,
            Some("one"),
            &json!({"policy":{"imageOcr":"true"}})
        )
        .is_err());
    }

    #[tokio::test]
    async fn library_management_task_sync_rejects_old_epoch_snapshot_commit() {
        let fixture = Scratch::new();
        let connection = fixture.connection();
        library(&connection, "one", "craft", Value::Null);
        drop(connection);
        let operation = library_runtime::begin(&fixture.root, "one", "task sync test").unwrap();
        let control = std::sync::Arc::new(crate::TaskSyncLibraryControl {
            operations: vec![operation],
            libraries: std::collections::HashMap::from([("one".to_string(), 0)]),
        });
        crate::TASK_SYNC_LIBRARY_CONTROL
            .scope(control, async {
                crate::save_task_sync_provider_snapshot(&fixture.path, "initial", "craft", "hash")
                    .unwrap();
                library_runtime::control(&fixture.root, "one", "pause").unwrap();
                library_runtime::control(&fixture.root, "one", "resume").unwrap();
                let error =
                    crate::save_task_sync_provider_snapshot(&fixture.path, "late", "craft", "hash")
                        .unwrap_err();
                assert!(library_runtime::is_control_error(&error));
                assert!(crate::task_sync_library_checkpoint(Some("other")).is_err());
            })
            .await;
        let connection = fixture.connection();
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM task_sync_snapshots WHERE hub_task_id='late'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM task_sync_snapshots WHERE hub_task_id='initial'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
    }
    #[tokio::test]
    async fn library_management_successful_create_receipt_survives_pause_without_baseline() {
        let fixture = Scratch::new();
        let connection = fixture.connection();
        library(&connection, "craft", "craft", Value::Null);
        library(&connection, "dida", "dida365", Value::Null);
        drop(connection);
        let craft = crate::TaskSyncRecord {
            provider: "craft".into(),
            library_id: "craft".into(),
            source_space_name: "Craft".into(),
            source_id: "returned-craft-id".into(),
            parent_source_id: String::new(),
            document_id: "document".into(),
            parent_page_id: "document".into(),
            raw_document_id: String::new(),
            title: "Created task".into(),
            completed: false,
            start_at: String::new(),
            due_at: String::new(),
            is_all_day: false,
            time_zone: String::new(),
            schedule_date: String::new(),
            deadline_date: String::new(),
            project_id: String::new(),
            content: String::new(),
            description: String::new(),
            tags: Vec::new(),
            is_project_page: false,
        };
        let hub = crate::unified_task_id("craft", "craft", &craft.source_id);
        let operations = vec![
            library_runtime::begin(&fixture.root, "craft", "create").unwrap(),
            library_runtime::begin(&fixture.root, "dida", "create").unwrap(),
        ];
        let control = std::sync::Arc::new(crate::TaskSyncLibraryControl {
            operations,
            libraries: std::collections::HashMap::from([("craft".into(), 0), ("dida".into(), 1)]),
        });
        crate::TASK_SYNC_LIBRARY_CONTROL
            .scope(control, async {
                // The remote response has already returned these stable object IDs.
                library_runtime::control(&fixture.root, "craft", "pause").unwrap();
                crate::save_task_sync_identity_receipt(
                    &fixture.path,
                    &hub,
                    &craft,
                    "dida",
                    "returned-dida-id",
                )
                .unwrap();
                crate::save_dida_attachment_mapping(
                    &fixture.path,
                    &hub,
                    "returned-dida-id",
                    "blob",
                    "returned-attachment-id",
                    "a.jpg",
                    "image/jpeg",
                )
                .unwrap();
                crate::save_task_sync_project_create_receipt(
                    &fixture.path,
                    &hub,
                    "returned-parent-id",
                )
                .unwrap();
                assert!(crate::save_task_sync_provider_snapshot(
                    &fixture.path,
                    &hub,
                    "craft",
                    "unverified"
                )
                .is_err());
                library_runtime::control(&fixture.root, "craft", "resume").unwrap();
                assert!(crate::save_task_sync_provider_snapshot(
                    &fixture.path,
                    &hub,
                    "craft",
                    "old-epoch"
                )
                .is_err());
                crate::save_task_sync_identity_receipt(
                    &fixture.path,
                    &hub,
                    &craft,
                    "dida",
                    "returned-dida-id",
                )
                .unwrap();
            })
            .await;
        // These are the same production loaders used before creating new objects.
        let pairs = crate::load_task_sync_pairs(&fixture.path).unwrap();
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0].craft_source_id, "returned-craft-id");
        assert_eq!(pairs[0].dida_source_id, "returned-dida-id");
        assert_eq!(
            crate::load_dida_attachment_mapping(&fixture.path, &hub, "returned-dida-id", "blob")
                .unwrap()
                .unwrap()
                .0,
            "returned-attachment-id"
        );
        assert_eq!(
            crate::task_sync_project_create_receipt(&fixture.path, &hub)
                .unwrap()
                .as_deref(),
            Some("returned-parent-id")
        );
        let connection = fixture.connection();
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM task_sync_snapshots", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        drop(connection);
        crate::clear_task_sync_identity_receipt_after_delete(
            &fixture.path,
            &hub,
            "dida365",
            "unrelated-id",
        )
        .unwrap();
        assert_eq!(crate::load_task_sync_pairs(&fixture.path).unwrap().len(), 1);
        crate::clear_task_sync_identity_receipt_after_delete(
            &fixture.path,
            &hub,
            "dida365",
            "returned-dida-id",
        )
        .unwrap();
        assert!(crate::load_task_sync_pairs(&fixture.path)
            .unwrap()
            .is_empty());
        crate::clear_task_sync_project_create_receipt(&fixture.path, &hub).unwrap();
        assert!(crate::task_sync_project_create_receipt(&fixture.path, &hub)
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn library_management_uploaded_craft_receipt_resumes_same_block_without_verified_content()
    {
        let fixture = Scratch::new();
        let connection = fixture.connection();
        library(&connection, "craft", "craft", Value::Null);
        drop(connection);
        let operation = library_runtime::begin(&fixture.root, "craft", "upload").unwrap();
        let control = std::sync::Arc::new(crate::TaskSyncLibraryControl {
            operations: vec![operation],
            libraries: std::collections::HashMap::from([("craft".into(), 0)]),
        });
        crate::TASK_SYNC_LIBRARY_CONTROL
            .scope(control, async {
                library_runtime::control(&fixture.root, "craft", "pause").unwrap();
                crate::save_managed_craft_attachment_receipt(
                    &fixture.path,
                    "hub",
                    "blob",
                    "returned-block-id",
                    true,
                )
                .unwrap();
                let (hash, blocks) = crate::managed_craft_content_state(&fixture.path, "hub")
                    .unwrap()
                    .unwrap();
                assert!(hash.is_empty());
                assert_eq!(
                    blocks.attachments.get("blob").map(String::as_str),
                    Some("returned-block-id")
                );
                assert!(blocks.attachment_pending_moves.contains("blob"));
                assert!(crate::save_managed_craft_content_state(
                    &fixture.path,
                    "hub",
                    "verified-hash",
                    &blocks
                )
                .is_err());
                library_runtime::control(&fixture.root, "craft", "resume").unwrap();
                crate::save_managed_craft_attachment_receipt(
                    &fixture.path,
                    "hub",
                    "blob",
                    "returned-block-id",
                    false,
                )
                .unwrap();
            })
            .await;
        let (hash, blocks) = crate::managed_craft_content_state(&fixture.path, "hub")
            .unwrap()
            .unwrap();
        assert!(hash.is_empty());
        assert_eq!(blocks.attachments.len(), 1);
        assert!(blocks.attachment_pending_moves.is_empty());
        crate::clear_managed_craft_attachment_receipt_after_delete(
            &fixture.path,
            "hub",
            "returned-block-id",
        )
        .unwrap();
        assert!(crate::managed_craft_content_state(&fixture.path, "hub")
            .unwrap()
            .unwrap()
            .1
            .attachments
            .is_empty());
    }

    #[test]
    fn library_management_policy_scheduler_filters_before_library_ranking() {
        let fixture = Scratch::new();
        let connection = fixture.connection();
        library(
            &connection,
            "one",
            "obsidian",
            json!({"imageDownload":false,"pdfDownload":true}),
        );
        source(&connection, "image", "one", "image/png", "obsidian", None);
        download(&connection, "image", "one");
        source(
            &connection,
            "pdf",
            "one",
            "application/pdf",
            "obsidian",
            None,
        );
        download(&connection, "pdf", "one");
        drop(connection);
        let claimed =
            crate::claim_enabled_attachment_jobs(&fixture.path, "download_source", 1).unwrap();
        assert_eq!(claimed.len(), 1);
        assert_eq!(claimed[0].source_id, "pdf");
        let connection = fixture.connection();
        assert_eq!(
            connection
                .query_row(
                    "SELECT status FROM index_jobs WHERE source_id='image'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "pending"
        );
    }
    #[test]
    fn library_management_policy_paused_library_does_not_starve_others() {
        let fixture = Scratch::new();
        let connection = fixture.connection();
        library(&connection, "a", "craft", Value::Null);
        library(&connection, "z", "craft", Value::Null);
        for i in 0..20 {
            let id = format!("a-{i}");
            source(&connection, &id, "a", "image/png", "craft", None);
            download(&connection, &id, "a");
        }
        source(&connection, "z-only", "z", "image/png", "craft", None);
        download(&connection, "z-only", "z");
        library_runtime::control(&fixture.root, "a", "pause").unwrap();
        drop(connection);
        let claimed =
            crate::claim_enabled_attachment_jobs(&fixture.path, "download_source", 1).unwrap();
        assert_eq!(claimed.len(), 1);
        assert_eq!(claimed[0].source_id, "z-only");
        let mut connection = fixture.connection();
        let saved = library_runtime::commit_existing(&fixture.root, "a", || {
            save(
                &mut connection,
                Some("a"),
                &json!({"overrides":{"imageOcr":false}}),
            )
        })
        .unwrap();
        assert_eq!(saved["effective"]["imageOcr"], false);
    }
    #[test]
    fn library_management_policy_supplement_is_scoped_and_video_is_download_only() {
        let fixture = Scratch::new();
        let mut connection = fixture.connection();
        library(&connection, "one", "craft", json!({"otherDownload":true}));
        library(&connection, "two", "craft", Value::Null);
        source(&connection, "video", "one", "video/mp4", "craft", None);
        source(
            &connection,
            "other-image",
            "two",
            "image/png",
            "craft",
            None,
        );
        assert_eq!(supplement(&mut connection, "one").unwrap(), 1);
        let jobs: Vec<(String, String)> = {
            let mut statement = connection
                .prepare("SELECT source_id,job_type FROM index_jobs")
                .unwrap();
            let values = statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap();
            values.collect::<Result<_, _>>().unwrap()
        };
        assert_eq!(jobs, vec![("video".into(), "download_source".into())]);
        assert!(!source_allowed(
            &effective(&connection, "one").unwrap(),
            "ocr_page",
            "video/mp4",
            ""
        ));
        assert_eq!(supplement(&mut connection, "one").unwrap(), 0);
    }
    #[test]
    fn attachment_followup_known_mime_overrides_image_hint_for_ocr() {
        let fixture = Scratch::new();
        let connection = fixture.connection();
        library(
            &connection,
            "one",
            "craft",
            json!({"imageOcr":true,"pdfOcr":false}),
        );
        let policy = effective(&connection, "one").unwrap();
        for mime in ["video/mp4", "audio/mpeg", "text/plain", "application/pdf"] {
            assert!(
                !source_allowed(&policy, "ocr_page", mime, "image"),
                "{mime}"
            );
        }
        for mime in ["", "application/octet-stream", "image/jpeg"] {
            assert!(source_allowed(&policy, "ocr_page", mime, "image"), "{mime}");
        }
    }
    #[test]
    fn attachment_followup_claims_only_supported_ocr_despite_stale_image_hint() {
        let fixture = Scratch::new();
        let connection = fixture.connection();
        library(
            &connection,
            "one",
            "craft",
            json!({"imageOcr":true,"pdfOcr":false}),
        );
        for (id, mime) in [
            ("video", "video/mp4"),
            ("pdf", "application/pdf"),
            ("image", "image/jpeg"),
        ] {
            source(&connection, id, "one", mime, "craft", None);
            connection
                .execute(
                    "UPDATE source_items SET metadata_json='{\"linkKind\":\"image\"}' WHERE id=?1",
                    [id],
                )
                .unwrap();
            connection.execute("INSERT INTO index_jobs(job_key,space_id,source_id,source_type,job_type,status,priority,created_at,updated_at,payload) VALUES(?1,'one',?1,'craft_attachment','ocr_page','pending',30,1,1,'{\"pageNumber\":1}')", [id]).unwrap();
        }
        drop(connection);
        let jobs = crate::claim_enabled_attachment_jobs(&fixture.path, "ocr_page", 8).unwrap();
        assert_eq!(
            jobs.iter()
                .map(|j| j.source_id.as_str())
                .collect::<Vec<_>>(),
            vec!["image"]
        );
    }
    #[test]
    fn library_management_policy_image_storage_without_ocr_and_cancelled_commit() {
        let fixture = Scratch::new();
        let connection = fixture.connection();
        library(&connection, "one", "craft", json!({"imageOcr":false}));
        source(&connection, "image", "one", "image/png", "craft", None);
        download(&connection, "image", "one");
        source(&connection, "cancelled", "one", "image/png", "craft", None);
        download(&connection, "cancelled", "one");
        drop(connection);
        let mut jobs =
            crate::claim_enabled_attachment_jobs(&fixture.path, "download_source", 2).unwrap();
        let job = jobs.remove(
            jobs.iter()
                .position(|job| job.source_id == "image")
                .unwrap(),
        );
        let store = BlobStore::open(&fixture.root.join("blobs")).unwrap();
        let operation =
            crate::begin_pipeline_operation(&fixture.path, &job, "download_source").unwrap();
        crate::persist_download_success_controlled(
            &fixture.path,
            &job,
            crate::DownloadedSource {
                blob: store.put(b"original image").unwrap(),
                mime_type: "image/png".into(),
            },
            Some(&operation),
        )
        .unwrap();
        let connection = fixture.connection();
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM index_jobs WHERE job_type='ocr_page'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert!(connection
            .query_row(
                "SELECT blob_hash FROM source_items WHERE id='image'",
                [],
                |row| row.get::<_, Option<String>>(0)
            )
            .unwrap()
            .is_some());
        drop(connection);
        let job = &jobs[0];
        let stale = crate::begin_pipeline_operation(&fixture.path, job, "download_source").unwrap();
        library_runtime::control(&fixture.root, "one", "pause").unwrap();
        library_runtime::control(&fixture.root, "one", "resume").unwrap();
        let error = crate::persist_download_success_controlled(
            &fixture.path,
            job,
            crate::DownloadedSource {
                blob: store.put(b"late image").unwrap(),
                mime_type: "image/png".into(),
            },
            Some(&stale),
        )
        .unwrap_err();
        assert!(library_runtime::is_control_error(&error));
        let connection = fixture.connection();
        assert!(connection
            .query_row(
                "SELECT blob_hash FROM source_items WHERE id='cancelled'",
                [],
                |row| row.get::<_, Option<String>>(0)
            )
            .unwrap()
            .is_none());
    }
    #[test]
    fn library_management_policy_requeue_preserves_completed_ocr_pages() {
        let fixture = Scratch::new();
        let mut connection = fixture.connection();
        library(&connection, "one", "craft", Value::Null);
        source(
            &connection,
            "image",
            "one",
            "image/png",
            "craft",
            Some("hash"),
        );
        let transaction = connection.transaction().unwrap();
        crate::queue_ocr_pages(&transaction, "one", "image", 1, &[1], 1).unwrap();
        transaction.commit().unwrap();
        connection.execute_batch("UPDATE ocr_pages SET status='completed',body='verified text' WHERE source_item_id='image';UPDATE index_jobs SET status='completed' WHERE source_id='image';UPDATE extractions SET status='completed' WHERE source_item_id='image';").unwrap();
        let transaction = connection.transaction().unwrap();
        crate::queue_ocr_pages(&transaction, "one", "image", 1, &[1], 2).unwrap();
        transaction.commit().unwrap();
        let result: (String, String) = connection
            .query_row(
                "SELECT status,body FROM ocr_pages WHERE source_item_id='image'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(result, ("completed".into(), "verified text".into()));
        assert_eq!(
            connection
                .query_row(
                    "SELECT status FROM extractions WHERE source_item_id='image'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "completed"
        );
    }

    #[tokio::test]
    async fn library_management_policy_pdf_ocr_only_preserves_shared_native_cache() {
        use lopdf::{dictionary, Object};
        let fixture = Scratch::new();
        let store = BlobStore::open(&fixture.root.join("blobs")).unwrap();
        let mut pdf = lopdf::Document::with_version("1.5");
        let pages = pdf.new_object_id();
        let page = pdf.add_object(dictionary! {"Type"=>"Page","Parent"=>pages});
        pdf.objects.insert(pages,Object::Dictionary(dictionary!{"Type"=>"Pages","Kids"=>vec![page.into()],"Count"=>1,"MediaBox"=>vec![0.into(),0.into(),595.into(),842.into()]}));
        let catalog = pdf.add_object(dictionary! {"Type"=>"Catalog","Pages"=>pages});
        pdf.trailer.set("Root", catalog);
        let pdf_file = fixture.root.join("one-page.pdf");
        pdf.save(&pdf_file).unwrap();
        let pdf_blob = store
            .put_file(&pdf_file, crate::MAX_ATTACHMENT_BYTES)
            .unwrap();
        let native = store.put(b"already cached native text").unwrap();
        let mut connection = fixture.connection();
        library(
            &connection,
            "one",
            "craft",
            json!({"pdfText":false,"pdfOcr":true}),
        );
        source(
            &connection,
            "pdf",
            "one",
            "application/pdf",
            "craft",
            Some(&pdf_blob.hash),
        );
        connection.execute("INSERT INTO extraction_cache(blob_hash,extractor,extractor_version,page_number,status,text_blob_hash,page_count,created_at,updated_at) VALUES (?1,'pdf_native','1',0,'completed',?2,1,1,1)",params![pdf_blob.hash,native.hash]).unwrap();
        connection.execute("INSERT INTO extractions(id,source_item_id,extractor,extractor_version,status,created_at,updated_at) VALUES ('native:pdf','pdf','pdf_native','1','pending',1,1)",[]).unwrap();
        connection.execute("INSERT INTO index_jobs(job_key,space_id,source_id,source_type,job_type,status,created_at,updated_at) VALUES ('extract-pdf:pdf','one','pdf','craft_attachment','extract_pdf','pending',1,1)",[]).unwrap();
        drop(connection);
        assert_eq!(
            crate::process_pdf_jobs(&fixture.path, &store)
                .await
                .unwrap(),
            1
        );
        let mut connection = fixture.connection();
        let cache:(String,String)=connection.query_row("SELECT status,text_blob_hash FROM extraction_cache WHERE blob_hash=?1 AND extractor='pdf_native'",[&pdf_blob.hash],|row|Ok((row.get(0)?,row.get(1)?))).unwrap();
        assert_eq!(cache, ("completed".into(), native.hash));
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM content_items WHERE source_item_id='pdf'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM index_jobs WHERE source_id='pdf' AND job_type='ocr_page' AND status='pending'",[],|row|row.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(connection.query_row("SELECT status FROM extractions WHERE source_item_id='pdf' AND extractor='pdf_native'",[],|row|row.get::<_,String>(0)).unwrap(),"counted");
        save(
            &mut connection,
            Some("one"),
            &json!({"overrides":{"pdfText":true,"pdfOcr":false}}),
        )
        .unwrap();
        assert_eq!(supplement(&mut connection, "one").unwrap(), 1);
        drop(connection);
        assert_eq!(
            crate::process_pdf_jobs(&fixture.path, &store)
                .await
                .unwrap(),
            1
        );
        let connection = fixture.connection();
        assert_eq!(
            connection
                .query_row(
                    "SELECT body FROM content_items WHERE source_item_id='pdf'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "already cached native text"
        );
    }
}
