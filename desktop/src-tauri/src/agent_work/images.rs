//! Explicit original-image grants. OCR/text permission never implies permission to send pixels.
use super::*;
use base64::Engine;
use sha2::{Digest, Sha256};
use std::io::Read;

const MAX_BYTES: usize = 4 * 1024 * 1024;
const MAX_IMAGES: usize = 8;
const MAX_LOCAL_BYTES: usize = 256 * 1024;
mod pages;
const LOCAL_LIBRARY: &str = "__hub_chat_images";
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ImageGrant {
    library_id: String,
    document_id: String,
    source_item_id: String,
    input_version: String,
    blob_hash: String,
}
fn identity(
    root: &Path,
    c: &Connection,
    library: &str,
    source: &str,
) -> Result<(ImageGrant, String, String), String> {
    if library == files::LIBRARY {
        let (page, id) = if source.starts_with("pdf-page:") {
            let (p, id) = pages::parts(source)?;
            (Some(p), id)
        } else {
            (None, source)
        };
        let value = files::metadata(root, id)?;
        let pdf = value["extension"] == "pdf";
        if pdf != page.is_some()
            || page.is_some_and(|p| p as u64 > value["pages"].as_u64().unwrap_or(0))
            || !pdf && !value["mime"].as_str().unwrap_or("").starts_with("image/")
        {
            return Err("公开图片或PDF页码无效".into());
        }
        return Ok((
            ImageGrant {
                library_id: library.into(),
                document_id: id.into(),
                source_item_id: source.into(),
                input_version: format!(
                    "public-v1:{:x}",
                    Sha256::digest(format!("{value}:{page:?}:2400"))
                ),
                blob_hash: value["sha256"].as_str().ok_or("公开图片哈希缺失")?.into(),
            },
            format!(
                "{} · 公开资料{}",
                value["title"].as_str().unwrap_or("资料"),
                page.map(|p| format!(" · 第 {p} 页")).unwrap_or_default()
            ),
            if pdf {
                "image/png".into()
            } else {
                value["mime"].as_str().unwrap().into()
            },
        ));
    }
    if source.starts_with("pdf-page:") {
        return pages::identity(c, library, source);
    }
    if library == LOCAL_LIBRARY {
        if source.len() != 64 || !source.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("图片标识无效".into());
        }
        let metadata = std::fs::read(
            root.join("collection-files/agent-images")
                .join(format!("{source}.json")),
        )
        .map_err(|_| "本地图片缓存缺失，请重新添加")?;
        let value: Value = serde_json::from_slice(&metadata).map_err(|_| "图片记录损坏")?;
        return Ok((
            ImageGrant {
                library_id: library.into(),
                document_id: source.into(),
                source_item_id: source.into(),
                input_version: source.into(),
                blob_hash: source.into(),
            },
            value["title"].as_str().unwrap_or("图片").into(),
            value["mime"].as_str().unwrap_or("").into(),
        ));
    }
    let (document,title,mime,parent):(String,String,String,String)=c.query_row(
        "SELECT s.document_id,d.title || ' · ' || s.title,s.mime_type,d.content_hash FROM source_items s JOIN libraries l ON l.id=s.space_id JOIN documents d ON d.space_id=s.space_id AND d.id=s.document_id WHERE s.id=?1 AND s.space_id=?2 AND l.enabled=1 AND s.mime_type IN ('image/png','image/jpeg','image/webp') AND s.status NOT IN ('unavailable','removed','missing')",
        params![source,library],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(|_|"原图不可用，仅支持已缓存的PNG、JPEG、WebP图片")?;
    let input = crate::attachment_evidence::input_on(c, library, source)?;
    Ok((
        ImageGrant {
            library_id: library.into(),
            document_id: document,
            source_item_id: source.into(),
            input_version: format!(
                "v2:{:x}",
                Sha256::digest(format!("{}:{parent}", input.version))
            ),
            blob_hash: input.blob_hash,
        },
        title,
        mime,
    ))
}
fn bytes(root: &Path, c: &Connection, g: &ImageGrant) -> Result<(Vec<u8>, String), String> {
    let (current, _, mime) = identity(root, c, &g.library_id, &g.source_item_id)?;
    let legacy = g.input_version.starts_with("v1:")
        && current.document_id == g.document_id
        && current.blob_hash == g.blob_hash
        && crate::attachment_evidence::input_on(c, &g.library_id, &g.source_item_id)
            .is_ok_and(|v| v.version == g.input_version);
    if current != *g && !legacy {
        return Err("原图版本已变化，请撤回旧图片并重新选择授权".into());
    }
    if g.library_id == files::LIBRARY {
        let value = files::metadata(root, &g.document_id)?;
        let path = files::path_for(root, &value)?;
        let data = if let Some(page) = pages::number(&g.source_item_id) {
            crate::ocr::render_pdf_page_png(&path, page, 2400)?
        } else {
            std::fs::read(path).map_err(|_| "公开图片不可读")?
        };
        if data.is_empty() || data.len() > MAX_BYTES {
            return Err("公开图片或PDF页面超过4 MiB，未降低清晰度".into());
        }
        return Ok((data, mime));
    }
    if g.source_item_id.starts_with("pdf-page:") {
        return pages::render(root, c, g);
    }
    let path = if g.library_id == LOCAL_LIBRARY {
        root.join("collection-files/agent-images")
            .join(format!("{}.image", g.source_item_id))
    } else {
        let store = crate::blob_store::BlobStore::open_existing(&root.join("blobs-v1"))?
            .with_backup_index(root.join("craft-search.sqlite3"));
        store.path_for(&g.blob_hash)?
    };
    let mut data = Vec::new();
    std::fs::File::open(path)
        .map_err(|_| "原图缓存缺失，请恢复附件后再继续")?
        .take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut data)
        .map_err(|_| "原图读取失败")?;
    if data.is_empty() || data.len() > MAX_BYTES {
        return Err("原图超过4 MiB单图上限；请选择相关局部或较小图片".into());
    }
    if format!("{:x}", Sha256::digest(&data)) != g.blob_hash {
        return Err("原图字节与授权哈希不符，未发送图片".into());
    }
    let signature = match mime.as_str() {
        "image/png" => data.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => data.starts_with(&[255, 216, 255]),
        "image/webp" => data.starts_with(b"RIFF") && data.get(8..12) == Some(b"WEBP"),
        _ => false,
    };
    if !signature {
        return Err("原图类型与文件字节不符".into());
    }
    Ok((data, mime))
}
pub(super) fn verify(root: &Path, c: &Connection, grants: &[ImageGrant]) -> Result<(), String> {
    if grants.len() > MAX_IMAGES {
        return Err("每个对话最多授权8张图片或PDF页面；实际发送仍受本轮材料额度限制".into());
    }
    for g in grants {
        bytes(root, c, g)?;
    }
    Ok(())
}
// Decode the exact bounded bytes, not a mutable source path; no extra image dependency.
#[cfg(windows)]
pub(super) fn decode(data: &[u8]) -> Result<(u32, u32), String> {
    use windows::{
        Graphics::Imaging::BitmapDecoder,
        Storage::Streams::{DataWriter, InMemoryRandomAccessStream},
    };
    let result = (|| -> windows::core::Result<(u32, u32)> {
        let stream = InMemoryRandomAccessStream::new()?;
        let writer = DataWriter::CreateDataWriter(&stream)?;
        writer.WriteBytes(data)?;
        writer.StoreAsync()?.get()?;
        writer.DetachStream()?;
        stream.Seek(0)?;
        let decoder = BitmapDecoder::CreateAsync(&stream)?.get()?;
        let w = decoder.PixelWidth()?;
        let h = decoder.PixelHeight()?;
        if w == 0 || h == 0 || w > 8192 || h > 8192 || (w as u64) * (h as u64) > 16_000_000 {
            return Err(windows::core::Error::from_hresult(windows::core::HRESULT(
                0x80070057u32 as i32,
            )));
        }
        let bitmap = decoder.GetSoftwareBitmapAsync()?.get()?;
        bitmap.Close()?;
        stream.Close()?;
        Ok((w, h))
    })();
    result.map_err(|_| "原图解码失败或尺寸超过8192边长/1600万像素上限".into())
}
#[cfg(not(windows))]
pub(super) fn decode(_: &[u8]) -> Result<(u32, u32), String> {
    Err("当前平台尚未接入原图解码核验".into())
}

pub(super) fn prepare(
    root: &Path,
    grants: &[ImageGrant],
) -> Result<(Vec<Value>, Value, usize), String> {
    let c = crate::source_evidence::open_read_database(root)?;
    verify(root, &c, grants)?;
    let mut input = Vec::new();
    let mut metadata = Vec::new();
    let mut raw_bytes = 0;
    for g in grants {
        let (data, mime) = bytes(root, &c, g)?;
        let (w, h) = decode(&data)?;
        raw_bytes += data.len();
        input.push(json!({"type":"image","url":format!("data:{mime};base64,{}",base64::engine::general_purpose::STANDARD.encode(&data))}));
        let (_, title, _) = identity(root, &c, &g.library_id, &g.source_item_id)?;
        metadata.push(json!({"grant":g,"title":title,"width":w,"height":h,"bytes":data.len(),"page":pages::number(&g.source_item_id),"meaning":"exact source image or explicitly selected rendered PDF page; not OCR text or an exact quotation; only these images were sent, other pages/images remain unread"}));
    }
    Ok((input, json!(metadata), raw_bytes))
}

pub(super) fn list(root: &Path, args: &Value) -> Result<Value, String> {
    let query = args["query"].as_str().unwrap_or("").trim();
    if query.chars().count() > 200 {
        return Err("图片查找条件过长".into());
    }
    let c = crate::source_evidence::open_read_database(root)?;
    let mut q=c.prepare("SELECT s.space_id,s.id FROM source_items s JOIN libraries l ON l.id=s.space_id JOIN documents d ON d.space_id=s.space_id AND d.id=s.document_id WHERE l.enabled=1 AND s.blob_hash IS NOT NULL AND s.mime_type IN ('image/png','image/jpeg','image/webp','application/pdf') AND s.status NOT IN ('unavailable','removed','missing') AND (?1='' OR instr(lower(s.title || ' ' || d.title),lower(?1))>0) ORDER BY s.space_id,s.id LIMIT 41").map_err(|e|e.to_string())?;
    let ids = q
        .query_map([query], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut more = ids.len() > 40;
    let mut items = ids
        .into_iter()
        .take(40)
        .filter_map(|(l, s)| {
            let page = args["page"].as_u64().unwrap_or(1);
            if page == 0 || page > 10000 { return None; }
            let pdf:bool=c.query_row("SELECT mime_type='application/pdf' FROM source_items WHERE id=?1",[&s],|r|r.get(0)).ok()?;
            let s=if pdf {format!("pdf-page:{page}:{s}")} else {s};
            identity(root, &c, &l, &s)
                .ok()
                .map(|(grant, title, mime)| json!({"grant":grant,"title":title,"mime":mime,"page":if pdf{Some(page)}else{None},"kind":if pdf{"pdfPage"}else{"image"}}))
        })
        .collect::<Vec<_>>();
    let page = args["page"].as_u64().unwrap_or(1);
    if (1..=10000).contains(&page) {
        for item in files::list_images(root, query, page as u32)? {
            if let Ok((grant, title, mime)) = identity(
                root,
                &c,
                files::LIBRARY,
                item["sourceItemId"].as_str().unwrap_or(""),
            ) {
                items.push(json!({"grant":grant,"title":title,"mime":mime,"page":if mime=="image/png" && item["sourceItemId"].as_str().unwrap_or("").starts_with("pdf-page:"){Some(page)}else{None},"kind":if item["sourceItemId"].as_str().unwrap_or("").starts_with("pdf-page:"){"pdfPage"}else{"image"}}));
            }
        }
    }
    more |= items.len() > 40;
    items.truncate(40);
    Ok(json!({"images":items,"hasMore":more}))
}

/// Staging is local only; the message action separately binds the exact bytes to a conversation.
pub(super) fn stage(root: &Path, args: &Value) -> Result<Value, String> {
    let title = super::text(args, "title", 200)?;
    let mime = args["mime"].as_str().unwrap_or("");
    if !matches!(mime, "image/png" | "image/jpeg" | "image/webp") {
        return Err("仅支持 PNG、JPEG、WebP 图片".into());
    }
    let encoded = args["base64"].as_str().ok_or("缺少图片内容")?;
    if encoded.len() > (MAX_LOCAL_BYTES + 2) / 3 * 4 {
        return Err("图片压缩后仍超过256 KiB，请选择较小图片".into());
    }
    let data = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "图片内容无效")?;
    if data.is_empty() || data.len() > MAX_LOCAL_BYTES {
        return Err("图片大小无效".into());
    }
    let matches = match mime {
        "image/png" => data.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => data.starts_with(&[255, 216, 255]),
        "image/webp" => data.starts_with(b"RIFF") && data.get(8..12) == Some(b"WEBP"),
        _ => false,
    };
    if !matches {
        return Err("图片类型与文件内容不一致".into());
    }
    decode(&data)?;
    let hash = format!("{:x}", Sha256::digest(&data));
    let directory = root.join("collection-files/agent-images");
    std::fs::create_dir_all(&directory).map_err(|_| "无法创建图片缓存")?;
    std::fs::write(directory.join(format!("{hash}.image")), &data)
        .map_err(|_| "无法保存图片缓存")?;
    std::fs::write(
        directory.join(format!("{hash}.json")),
        json!({"title":title,"mime":mime}).to_string(),
    )
    .map_err(|_| "无法保存图片记录")?;
    let c = crate::source_evidence::open_read_database(root)?;
    let (grant, _, _) = identity(root, &c, LOCAL_LIBRARY, &hash)?;
    bytes(root, &c, &grant)?;
    Ok(json!({"grant":grant,"title":title,"mime":mime}))
}

pub(super) fn preview(root: &Path, args: &Value) -> Result<Value, String> {
    let grant: ImageGrant =
        serde_json::from_value(args["grant"].clone()).map_err(|_| "图片标识无效")?;
    let c = crate::source_evidence::open_read_database(root)?;
    let (data, mime) = bytes(root, &c, &grant)?;
    let (_, title, _) = identity(root, &c, &grant.library_id, &grant.source_item_id)?;
    Ok(
        json!({"title":title,"url":format!("data:{mime};base64,{}",base64::engine::general_purpose::STANDARD.encode(data))}),
    )
}
pub(super) fn selection(value: &Value, field: &str) -> Result<Vec<ImageGrant>, String> {
    let images: Vec<ImageGrant> =
        serde_json::from_value(value.get(field).cloned().unwrap_or(json!([])))
            .map_err(|_| "原图授权参数无效")?;
    if images.len() > MAX_IMAGES {
        return Err("每次最多变更8张图片或PDF页面".into());
    }
    Ok(images)
}
pub(super) fn extend(
    root: &Path,
    c: &Connection,
    grant: &mut Grant,
    add: &[ImageGrant],
    remove: &[ImageGrant],
) -> Result<(), String> {
    if grant.manifest.is_some() && (!add.is_empty() || !remove.is_empty()) {
        return Err("固定笔记清单不包含原图授权，请使用普通对话".into());
    }
    for image in remove {
        if add.contains(image) {
            return Err("同一原图不能同时授权与撤回".into());
        }
        let n = grant
            .images
            .iter()
            .position(|g| g == image)
            .ok_or("旧原图授权已变化，请刷新")?;
        grant.images.remove(n);
    }
    for image in add {
        if grant
            .images
            .iter()
            .any(|g| g.library_id == image.library_id && g.source_item_id == image.source_item_id)
        {
            return Err("原图已授权；版本变化时请先撤回旧授权".into());
        }
        let (data, _) = bytes(root, c, image)?;
        decode(&data)?;
        grant.images.push(image.clone());
    }
    if grant.images.len() > MAX_IMAGES {
        return Err("每个对话最多授权8张图片或PDF页面".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests;
