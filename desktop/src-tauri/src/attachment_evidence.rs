//! Input lineage owned by the extraction pipeline, shared with cached evidence.
//! A chunk text hash is never treated as a hash of its input file.
use super::*;

#[derive(Clone, Debug)]
pub(crate) struct Input {
    pub(crate) version: String,
    pub(crate) blob_hash: String,
}
pub(crate) fn migrate(c: &Connection) -> Result<(), String> {
    for table in ["content_items", "ocr_pages", "extractions"] {
        let present: bool = c.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM pragma_table_info('{table}') WHERE name='input_version')"),
            [], |r| r.get(0)).map_err(|e|e.to_string())?;
        if !present {
            c.execute_batch(&format!(
                "ALTER TABLE {table} ADD COLUMN input_version TEXT;"
            ))
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(()) // Legacy extraction rows deliberately remain unbound.
}
pub(crate) fn input_on(c: &Connection, library: &str, source: &str) -> Result<Input, String> {
    let (identity, blob): (Value, String) = c.query_row(
        "SELECT id,space_id,document_id,provider,remote_id,source_type,mime_type,modified_at,content_hash,blob_hash FROM source_items WHERE id=?1 AND space_id=?2 AND status NOT IN ('unavailable','removed','missing')",
        params![source,library], |r| {
            let blob: String = r.get(9)?;
            Ok((json!([r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,String>(5)?,r.get::<_,Option<String>>(6)?,r.get::<_,Option<i64>>(7)?,r.get::<_,Option<String>>(8)?,blob]),blob))
        }).map_err(|_|"附件输入已不可用或尚未下载".to_string())?;
    if blob.len() != 64
        || !blob
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err("附件缺少有效的输入 Blob 身份".into());
    }
    Ok(Input {
        version: format!("v1:{:x}", Sha256::digest(identity.to_string().as_bytes())),
        blob_hash: blob,
    })
}
pub(crate) fn check_on(
    c: &Connection,
    library: &str,
    source: &str,
    input: &Input,
) -> Result<(), String> {
    if input_on(c, library, source)
        .is_ok_and(|v| v.version == input.version && v.blob_hash == input.blob_hash)
    {
        Ok(())
    } else {
        Err("CONTENT_POLICY:附件输入已改变，旧提取结果未提交".into())
    }
}
pub(crate) fn bind_chunks_on(
    c: &Connection,
    library: &str,
    source: &str,
    input: Option<&Input>,
    native_only: bool,
) -> Result<(), String> {
    if let Some(input) = input {
        check_on(c, library, source, input)?;
        c.execute("UPDATE content_items SET input_version=?1 WHERE space_id=?2 AND source_item_id=?3 AND content_type IN ('pdf_page','pdf_ocr','image_ocr') AND (?4=0 OR content_type='pdf_page')",params![input.version,library,source,native_only]).map_err(|e|e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests;
