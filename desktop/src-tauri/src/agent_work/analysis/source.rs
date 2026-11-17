//! Cache-backed file selection retains the original attachment and parent versions.
use super::*;
fn binding(c: &Connection, library: &str, id: &str) -> Result<Value, String> {
    let (document,parent):(String,String)=c.query_row("SELECT s.document_id,d.content_hash FROM source_items s JOIN documents d ON d.space_id=s.space_id AND d.id=s.document_id JOIN libraries l ON l.id=s.space_id WHERE s.id=?1 AND s.space_id=?2 AND l.enabled=1 AND s.mime_type IN ('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','text/csv','application/json')",params![id,library],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|_|"来源附件不可用")?;
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
    if extension(&title).is_err() {
        title = format!(
            "{}.{}",
            title.chars().take(150).collect::<String>(),
            if mime == "text/csv" {
                "csv"
            } else if mime == "application/json" {
                "json"
            } else {
                "xlsx"
            }
        );
    }
    verify(root, &origin)?;
    super::stage(
        root,
        &json!({"title":title,"base64":base64::engine::general_purpose::STANDARD.encode(data),"sourceBinding":origin}),
    )
}
pub(in crate::agent_work) fn list(root: &Path, args: &Value) -> Result<Value, String> {
    let query = args["query"].as_str().unwrap_or("").trim();
    if query.chars().count() > 200 {
        return Err("文件查找条件过长".into());
    }
    let c = crate::source_evidence::open_read_database(root)?;
    let mut q=c.prepare("SELECT s.space_id,s.id,s.title,d.title FROM source_items s JOIN documents d ON d.space_id=s.space_id AND d.id=s.document_id JOIN libraries l ON l.id=s.space_id WHERE l.enabled=1 AND s.blob_hash IS NOT NULL AND s.status NOT IN ('removed','missing','unavailable') AND s.mime_type IN ('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','text/csv','application/json') AND (?1='' OR instr(lower(s.title || ' ' || d.title),lower(?1))>0) ORDER BY s.title LIMIT 41").map_err(|e|e.to_string())?;
    let mut items = Vec::new();
    for row in q.query_map([query],|r|Ok(json!({"source":{"libraryId":r.get::<_,String>(0)?,"sourceItemId":r.get::<_,String>(1)?},"title":r.get::<_,String>(2)?,"parentTitle":r.get::<_,String>(3)?}))).map_err(|e|e.to_string())? {items.push(row.map_err(|e|e.to_string())?);}
    let more = items.len() > 40;
    items.truncate(40);
    Ok(json!({"files":items,"hasMore":more}))
}
