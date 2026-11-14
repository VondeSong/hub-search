//! Read-only PDF navigation over the existing file, extraction rows and index.
use crate::{attachment_evidence, blob_store::BlobStore, search_index::SearchIndex};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};

const MAX_CHUNKS: usize = 10_000;
const MAX_HIT_PAGES: usize = 1_000;

pub(crate) struct PdfSource {
    pub source_id: String,
    pub hash: String,
    pub title: String,
    pub page_count: u32,
    pub page_count_note: Option<String>,
    pub input_version: Option<String>,
}

pub(crate) fn source_on(
    c: &Connection,
    store: &BlobStore,
    result_id: &str,
) -> Result<PdfSource, String> {
    let (id,library,hash,title):(String,String,String,String)=if let Some(id)=result_id.strip_prefix("attachment-meta:") {
        c.query_row("SELECT id,space_id,blob_hash,title FROM source_items WHERE id=?1 AND mime_type='application/pdf' AND status NOT IN ('removed','missing','unavailable')",params![id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))
    } else {
        c.query_row("SELECT s.id,s.space_id,s.blob_hash,s.title FROM content_items ci JOIN source_items s ON s.id=ci.source_item_id WHERE ci.id=?1 AND ci.content_type IN ('pdf_page','pdf_ocr','pdf_attachment') AND s.mime_type='application/pdf' AND s.status NOT IN ('removed','missing','unavailable')",params![result_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))
    }.map_err(|_|"本地 PDF 来源不可用或尚未下载".to_string())?;
    let path = store.path_for(&hash)?;
    crate::craft_backup::reject_links(&path)?;
    let input_version = attachment_evidence::input_on(c, &library, &id)
        .ok()
        .map(|i| i.version);
    let (page_count, page_count_note) = match crate::ocr::pdf_page_count(&path) {
        Ok(count) => (count, None),
        Err(error) => {
            let count:u32=c.query_row("SELECT MAX(COALESCE((SELECT MAX(page_count) FROM extractions WHERE source_item_id=?1 AND (input_version IS NULL OR input_version=?2)),0),COALESCE((SELECT MAX(page_number) FROM content_items WHERE source_item_id=?1 AND content_type IN ('pdf_page','pdf_ocr') AND (input_version IS NULL OR input_version=?2)),0))",params![id,input_version],|r|r.get(0)).map_err(|e|e.to_string())?;
            if count == 0 {
                return Err(error);
            }
            (
                count,
                Some(format!(
                    "无法核验原文件页数：{error}；暂按已有提取记录显示 {count} 页，请对照原件。"
                )),
            )
        }
    };
    if page_count == 0 {
        return Err("PDF 没有可预览页面".into());
    }
    Ok(PdfSource {
        source_id: id,
        hash,
        title,
        page_count,
        page_count_note,
        input_version,
    })
}

pub(crate) fn validate_page(page: u32, total: u32) -> Result<u32, String> {
    if page == 0 || page > total {
        Err(format!("PDF 页码超出范围：请输入 1–{total}"))
    } else {
        Ok(page)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PdfSearchPages {
    pub source_id: String,
    pub query: String,
    pub page_count: u32,
    pub page_count_note: Option<String>,
    pub indexed_page_count: usize,
    pub available_text_page_count: usize,
    pub hit_pages: Vec<u32>,
    pub extraction_status: String,
    pub failed_page_count: usize,
    pub revision_status: String,
    pub truncated: bool,
}

pub(crate) fn search_pages_on(
    c: &Connection,
    store: &BlobStore,
    index: &SearchIndex,
    result_id: &str,
    query: &str,
) -> Result<PdfSearchPages, String> {
    if query.len() > 2_000 {
        return Err("PDF 检索关键词过长，请缩短后重试".into());
    }
    let source = source_on(c, store, result_id)?;
    let mut rows=c.prepare("SELECT id,page_number,body,input_version FROM content_items WHERE source_item_id=?1 AND content_type IN ('pdf_page','pdf_ocr') AND page_number BETWEEN 1 AND ?2 ORDER BY page_number,ordinal,id LIMIT ?3").map_err(|e|e.to_string())?;
    let records = rows
        .query_map(
            params![source.source_id, source.page_count, (MAX_CHUNKS + 1) as i64],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, u32>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut truncated = records.len() > MAX_CHUNKS;
    let mut legacy = false;
    let mut stale = false;
    let mut current = BTreeMap::new();
    let mut pages = BTreeSet::new();
    for (id, page, body, version) in records.into_iter().take(MAX_CHUNKS) {
        if version.is_some() && version != source.input_version {
            stale = true;
            continue;
        }
        legacy |= version.is_none();
        pages.insert(page);
        current.insert(id, body);
    }
    let ids = current.keys().cloned().collect::<Vec<_>>();
    let mut hit_pages = Vec::new();
    let mut indexed_page_count = 0;
    if !query.trim().is_empty() && !ids.is_empty() {
        let indexed = index.search_pdf_pages("*", &ids, MAX_HIT_PAGES + 1)?;
        truncated |= indexed.len() > MAX_HIT_PAGES;
        indexed_page_count = indexed
            .iter()
            .filter(|hit| current.get(&hit.item_id) == Some(&hit.body))
            .count()
            .min(MAX_HIT_PAGES);
        let hits = index.search_pdf_pages(query, &ids, MAX_HIT_PAGES + 1)?;
        truncated |= hits.len() > MAX_HIT_PAGES;
        for hit in hits {
            // A delayed index commit must not expose a hit from an older body.
            if current.get(&hit.item_id) != Some(&hit.body) {
                stale = true;
                continue;
            }
            if let Some(page) = hit
                .page_number
                .and_then(|p| u32::try_from(p).ok())
                .filter(|p| *p <= source.page_count)
            {
                hit_pages.push(page);
            }
        }
        hit_pages.sort_unstable();
        hit_pages.dedup();
        hit_pages.truncate(MAX_HIT_PAGES);
    }
    let extraction_status=c.query_row("SELECT status FROM extractions WHERE source_item_id=?1 AND extractor='pdf_native' AND (input_version IS NULL OR input_version=?2) ORDER BY updated_at DESC LIMIT 1",params![source.source_id,source.input_version],|r|r.get::<_,String>(0)).optional().map_err(|e|e.to_string())?.unwrap_or("not_extracted".into());
    let failed_page_count=c.query_row("SELECT COUNT(*) FROM ocr_pages WHERE source_item_id=?1 AND status='failed' AND (input_version IS NULL OR input_version=?2)",params![source.source_id,source.input_version],|r|r.get::<_,usize>(0)).map_err(|e|e.to_string())?;
    Ok(PdfSearchPages {
        source_id: source.source_id,
        query: query.trim().into(),
        page_count: source.page_count,
        page_count_note: source.page_count_note,
        indexed_page_count,
        available_text_page_count: pages.len(),
        hit_pages,
        extraction_status,
        failed_page_count,
        revision_status: if stale {
            "stale"
        } else if legacy {
            "legacy"
        } else {
            "current"
        }
        .into(),
        truncated,
    })
}

pub(crate) fn page_text_on(
    c: &Connection,
    source: &PdfSource,
    page: u32,
) -> Result<(String, String, String), String> {
    validate_page(page, source.page_count)?;
    let mut statement=c.prepare("SELECT body,content_type,input_version FROM content_items WHERE source_item_id=?1 AND page_number=?2 AND content_type IN ('pdf_page','pdf_ocr') ORDER BY ordinal,id").map_err(|e|e.to_string())?;
    let rows = statement
        .query_map(params![source.source_id, page], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let stale = rows
        .iter()
        .any(|(_, _, v)| v.is_some() && v != &source.input_version);
    let eligible = rows
        .into_iter()
        .filter(|(_, _, v)| v.is_none() || v == &source.input_version)
        .collect::<Vec<_>>();
    let kind = if eligible.iter().any(|(_, k, _)| k == "pdf_ocr") {
        "pdf_ocr"
    } else {
        "pdf_native"
    }
    .into();
    let state=if !eligible.is_empty(){if eligible.iter().all(|(t,_,_)|t.trim().is_empty()){"empty"}else{"indexed"}}
        else if stale{"stale"}else{
            let failed=c.query_row("SELECT EXISTS(SELECT 1 FROM ocr_pages WHERE source_item_id=?1 AND page_number=?2 AND status='failed' AND (input_version IS NULL OR input_version=?3)) OR EXISTS(SELECT 1 FROM extractions WHERE source_item_id=?1 AND extractor='pdf_native' AND status='failed' AND (input_version IS NULL OR input_version=?3))",params![source.source_id,page,source.input_version],|r|r.get::<_,bool>(0)).map_err(|e|e.to_string())?;
            if failed{"failed"}else{"not_extracted"}
        }.into();
    let text =
        crate::merge_preview_chunks(&eligible.into_iter().map(|(t, _, _)| t).collect::<Vec<_>>());
    Ok((text, kind, state))
}

/// External readers receive a verified disposable working copy, never the source.
pub(crate) fn page_link_on(
    c: &Connection,
    store: &BlobStore,
    result_id: &str,
    page: u32,
) -> Result<String, String> {
    static COPY_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _copy = COPY_LOCK.lock().map_err(|_| "PDF 副本准备状态不可用")?;
    let source = source_on(c, store, result_id)?;
    if let Some(note) = source.page_count_note {
        return Err(note);
    }
    validate_page(page, source.page_count)?;
    let original = store.path_for(&source.hash)?;
    if crate::craft_backup::hash_file(&original)? != source.hash {
        return Err("PDF 原件校验失败，未打开".into());
    }
    let directory = store.root_path().join("opened/pdf-pages");
    crate::craft_backup::reject_links(&directory)?;
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let mut filename = PathBuf::from(crate::craft_export::sanitize_component(
        &source.title,
        "PDF",
    ));
    filename.set_extension("pdf");
    let filename = filename.to_string_lossy();
    let stem = Path::new(filename.as_ref())
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy();
    let mut target = directory.join(format!("{}-{filename}", &source.hash[..12]));
    let mut suffix = 2;
    crate::craft_backup::reject_links(&target)?;
    while target.exists() && crate::craft_backup::hash_file(&target)? != source.hash {
        target = directory.join(format!("{}-{stem}-{suffix}.pdf", &source.hash[..12]));
        crate::craft_backup::reject_links(&target)?;
        suffix += 1;
    }
    crate::craft_backup::reject_links(&target)?;
    if !target.exists() {
        std::fs::copy(&original, &target).map_err(|e| e.to_string())?;
    }
    if crate::craft_backup::hash_file(&target)? != source.hash {
        return Err("PDF 工作副本校验失败".into());
    }
    let canonical = target.canonicalize().map_err(|e| e.to_string())?;
    let text = canonical.to_string_lossy();
    let normal = PathBuf::from(text.strip_prefix(r"\\?\").unwrap_or(&text));
    let mut url = url::Url::from_file_path(&normal).map_err(|_| "无法生成本机 PDF 链接")?;
    url.set_fragment(Some(&format!("page={page}")));
    Ok(url.to_string())
}

#[cfg(all(test, windows))]
mod tests;
