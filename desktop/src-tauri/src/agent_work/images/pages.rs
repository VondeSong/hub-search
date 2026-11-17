//! Virtual page grants bind a rendered page to its PDF and parent-note versions.
use super::*;

pub(super) fn parts(source: &str) -> Result<(u32, &str), String> {
    let (page, id) = source
        .strip_prefix("pdf-page:")
        .and_then(|s| s.split_once(':'))
        .ok_or("PDF页面身份无效")?;
    let page: u32 = page.parse().map_err(|_| "PDF页码无效")?;
    if !(1..=10000).contains(&page) || id.is_empty() {
        return Err("PDF页码或附件身份无效".into());
    }
    Ok((page, id))
}
pub(super) fn number(source: &str) -> Option<u32> {
    parts(source).ok().map(|p| p.0)
}
pub(super) fn identity(
    c: &Connection,
    library: &str,
    source: &str,
) -> Result<(ImageGrant, String, String), String> {
    let (page, id) = parts(source)?;
    let (document,title,parent):(String,String,String)=c.query_row("SELECT s.document_id,d.title || ' · ' || s.title,d.content_hash FROM source_items s JOIN documents d ON d.space_id=s.space_id AND d.id=s.document_id JOIN libraries l ON l.id=s.space_id WHERE s.id=?1 AND s.space_id=?2 AND l.enabled=1 AND s.mime_type='application/pdf' AND s.status NOT IN ('removed','missing','unavailable')",params![id,library],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|_|"PDF附件不可用或资料库已停用")?;
    let input = crate::attachment_evidence::input_on(c, library, id)?;
    Ok((
        ImageGrant {
            library_id: library.into(),
            document_id: document,
            source_item_id: source.into(),
            input_version: format!(
                "page-v1:{:x}",
                Sha256::digest(format!("{}:{parent}:{page}:2400", input.version))
            ),
            blob_hash: input.blob_hash,
        },
        format!("{title} · 第 {page} 页"),
        "image/png".into(),
    ))
}
pub(super) fn render(
    root: &Path,
    c: &Connection,
    g: &ImageGrant,
) -> Result<(Vec<u8>, String), String> {
    if identity(c, &g.library_id, &g.source_item_id)?.0 != *g {
        return Err("PDF或所属笔记已变化，请重新选择页面".into());
    }
    let (page, _) = parts(&g.source_item_id)?;
    let store = crate::blob_store::BlobStore::open_existing(&root.join("blobs-v1"))?
        .with_backup_index(root.join("craft-search.sqlite3"));
    let path = store.path_for(&g.blob_hash)?;
    if crate::craft_backup::hash_file(&path)? != g.blob_hash {
        return Err("PDF原件校验失败".into());
    }
    let key = format!(
        "{:x}",
        Sha256::digest(format!("{}:{}", g.input_version, g.blob_hash))
    );
    let dir = root.join("collection-files/agent-pdf-pages");
    crate::craft_backup::reject_links(&dir)?;
    std::fs::create_dir_all(&dir).map_err(|_| "无法准备PDF页面缓存")?;
    let cache = dir.join(format!("{key}.png"));
    crate::craft_backup::reject_links(&cache)?;
    // Always render from the verified original. A mutable cache is never evidence.
    let data = crate::ocr::render_pdf_page_png(&path, page, 2400)?;
    if data.is_empty() || data.len() > MAX_BYTES {
        return Err("PDF页面超过4 MiB，请选择相关文字或其他页面；未自动降低清晰度".into());
    }
    decode(&data)?;
    std::fs::write(&cache, &data).map_err(|_| "无法保存PDF页面缓存")?;
    Ok((data, "image/png".into()))
}
