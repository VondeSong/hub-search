//! Cache-backed file selection retains the original attachment and parent versions.
use super::*;
fn binding(c: &Connection, library: &str, id: &str) -> Result<Value, String> {
    let (document,parent):(String,String)=c.query_row("SELECT s.document_id,d.content_hash FROM source_items s JOIN documents d ON d.space_id=s.space_id AND d.id=s.document_id JOIN libraries l ON l.id=s.space_id WHERE s.id=?1 AND s.space_id=?2 AND l.enabled=1",params![id,library],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|_|"来源附件不可用")?;
    let input = crate::attachment_evidence::input_on(c, library, id)?;
    Ok(
        json!({"libraryId":library,"sourceItemId":id,"documentId":document,"parentVersion":parent,"inputVersion":input.version,"sha256":input.blob_hash}),
    )
}
pub(super) fn verify(root: &Path, expected: &Value) -> Result<(), String> {
    let c = crate::source_evidence::open_read_database(root)?;
    let current = binding(
        &c,
        expected["libraryId"].as_str().ok_or("分析来源身份缺失")?,
        expected["sourceItemId"]
            .as_str()
            .ok_or("分析附件身份缺失")?,
    )?;
    if current != *expected {
        return Err("分析来源已变化或停用，请重新选择文件".into());
    }
    Ok(())
}
pub(super) fn import(root: &Path, args: &Value) -> Result<Value, String> {
    let c = crate::source_evidence::open_read_database(root)?;
    let library = args["source"]["libraryId"]
        .as_str()
        .ok_or("来源资料库缺失")?;
    let id = args["source"]["sourceItemId"]
        .as_str()
        .ok_or("来源附件缺失")?;
    let origin = binding(&c, library, id)?;
    let store = crate::blob_store::BlobStore::open_existing(&root.join("blobs-v1"))?
        .with_backup_index(root.join("craft-search.sqlite3"));
    let path = store.path_for(origin["sha256"].as_str().unwrap())?;
    if std::fs::metadata(&path).map_err(|_| "来源文件缺失")?.len() > MAX_FILE as u64 {
        return Err("来源文件超过10 MiB".into());
    }
    let data = std::fs::read(path).map_err(|_| "无法读取来源文件")?;
    if digest(&data) != origin["sha256"].as_str().unwrap() {
        return Err("来源文件校验失败".into());
    }
    let (mut title, mime): (String, String) = c
        .query_row(
            "SELECT title,mime_type FROM source_items WHERE id=?1 AND space_id=?2",
            params![id, library],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| "来源附件已移除")?;
    let ext = match mime.as_str() {
        "text/csv" => Some("csv"),
        "application/json" => Some("json"),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => Some("xlsx"),
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" => Some("pptx"),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => Some("docx"),
        "application/pdf" => Some("pdf"),
        _ => None,
    };
    if let Some(ext) = ext.filter(|ext| {
        Path::new(&title)
            .extension()
            .and_then(|v| v.to_str())
            .is_none_or(|v| !v.eq_ignore_ascii_case(ext))
    }) {
        title = format!("{}.{ext}", title.chars().take(150).collect::<String>());
    }
    let data_file = matches!(ext, Some("csv" | "json" | "xlsx"));
    verify(root, &origin)?;
    super::stage_bytes(root, &title, &data, !data_file, &origin)
}

pub(super) fn cached_pdf_pages(
    root: &Path,
    source: &Value,
    max_chars: usize,
) -> Result<Option<Value>, String> {
    let c = crate::source_evidence::open_read_database(root)?;
    c.execute_batch("BEGIN DEFERRED")
        .map_err(|e| e.to_string())?;
    let library = source["libraryId"].as_str().ok_or("来源资料库缺失")?;
    let id = source["sourceItemId"].as_str().ok_or("来源附件缺失")?;
    if binding(&c, library, id)? != *source {
        return Err("来源已换版，请重新添加附件".into());
    }
    let mut stmt = c.prepare(
        "SELECT p.page_number,p.body,p.source_hash FROM content_items p
         JOIN source_items s ON s.id=p.source_item_id AND s.space_id=p.space_id
         WHERE p.space_id=?1 AND p.source_item_id=?2 AND p.input_version=?3
           AND p.content_type='pdf_page' AND s.mime_type='application/pdf'
           AND length(trim(p.body))>0 AND p.page_number IS NOT NULL ORDER BY p.page_number,p.ordinal LIMIT 8",
    ).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(
            params![library, id, source["inputVersion"].as_str()],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .map_err(|e| e.to_string())?;
    let mut remaining = max_chars;
    let mut pages = Vec::new();
    for row in rows {
        let (page, body, hash) = row.map_err(|e| e.to_string())?;
        if digest(body.as_bytes()) != hash {
            return Err("已提取文字的校验失败".into());
        }
        if remaining == 0 {
            break;
        }
        let content: String = body.chars().take(remaining).collect();
        remaining -= content.chars().count();
        pages.push(json!({"page":page,"truncated":content.len()<body.len(),"text":content}));
    }
    Ok((!pages.is_empty()).then(|| json!({"pages":pages,"chars":max_chars-remaining})))
}
pub(in crate::agent_work) fn list(root: &Path, args: &Value) -> Result<Value, String> {
    let query = args["query"].as_str().unwrap_or("").trim();
    if query.chars().count() > 200 {
        return Err("文件查找条件过长".into());
    }
    let c = crate::source_evidence::open_read_database(root)?;
    let mut q=c.prepare("SELECT s.space_id,s.id,s.title,d.title FROM source_items s JOIN documents d ON d.space_id=s.space_id AND d.id=s.document_id JOIN libraries l ON l.id=s.space_id WHERE l.enabled=1 AND s.blob_hash IS NOT NULL AND s.status NOT IN ('removed','missing','unavailable') AND coalesce(s.mime_type,'') NOT LIKE 'image/%' AND (?1='' OR instr(lower(s.title || ' ' || d.title),lower(?1))>0) ORDER BY s.title LIMIT 41").map_err(|e|e.to_string())?;
    let mut items = Vec::new();
    for row in q.query_map([query],|r|Ok(json!({"source":{"libraryId":r.get::<_,String>(0)?,"sourceItemId":r.get::<_,String>(1)?},"title":r.get::<_,String>(2)?,"parentTitle":r.get::<_,String>(3)?}))).map_err(|e|e.to_string())? {items.push(row.map_err(|e|e.to_string())?);}
    let more = items.len() > 40;
    items.truncate(40);
    Ok(json!({"files":items,"hasMore":more}))
}
