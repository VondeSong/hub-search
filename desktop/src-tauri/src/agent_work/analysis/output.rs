//! Validate actual deliverable bytes before issuing a successful receipt.
use super::*;

pub(super) fn validate(path: &Path, ext: &str) -> Result<(), String> {
    match ext {
        "svg" => {
            let original = std::fs::read_to_string(path).map_err(|_| "SVG编码无效")?;
            let safe = svg(&original)?;
            if safe != original {
                std::fs::write(path, safe).map_err(|_| "无法规范化SVG声明")?;
            }
        }
        "png" => {
            let data = std::fs::read(path).map_err(|_| "PNG不可读")?;
            if !data.starts_with(b"\x89PNG\r\n\x1a\n") {
                return Err("PNG文件头无效".into());
            }
            images::decode(&data)?;
        }
        "pdf" => {
            let doc = lopdf::Document::load(path).map_err(|_| "PDF结构无效")?;
            if doc.is_encrypted() || doc.get_pages().is_empty() {
                return Err("PDF加密或没有页面".into());
            }
            fn active(object: &lopdf::Object) -> bool {
                match object {
                    lopdf::Object::Dictionary(d) => d.iter().any(|(k, v)| {
                        matches!(
                            k.as_slice(),
                            b"JS"
                                | b"JavaScript"
                                | b"OpenAction"
                                | b"AA"
                                | b"Launch"
                                | b"EmbeddedFiles"
                                | b"RichMedia"
                                | b"XFA"
                        ) || active(v)
                    }),
                    lopdf::Object::Stream(s) => active(&lopdf::Object::Dictionary(s.dict.clone())),
                    lopdf::Object::Array(a) => a.iter().any(active),
                    lopdf::Object::Name(n) => {
                        matches!(n.as_slice(), b"JavaScript" | b"Launch" | b"RichMedia")
                    }
                    _ => false,
                }
            }
            if doc.objects.values().any(active) {
                return Err("PDF包含活动内容或嵌入文件".into());
            }
        }
        "xlsx" => {
            let data = std::fs::read(path).map_err(|_| "XLSX不可读")?;
            let mut zip =
                zip::ZipArchive::new(std::io::Cursor::new(data)).map_err(|_| "XLSX结构无效")?;
            if zip.len() > 10000
                || zip.by_name("[Content_Types].xml").is_err()
                || zip.by_name("xl/workbook.xml").is_err()
            {
                return Err("XLSX缺少工作簿结构".into());
            }
            let mut expanded = 0u64;
            for i in 0..zip.len() {
                let file = zip.by_index(i).map_err(|_| "XLSX内容损坏")?;
                expanded = expanded.saturating_add(file.size());
                let name = file.name().to_ascii_lowercase();
                if expanded > 128 * 1024 * 1024
                    || file.enclosed_name().is_none()
                    || name.contains("vbaproject")
                    || name.contains("externallinks/")
                {
                    return Err("XLSX含宏、外部链接或超出容量".into());
                }
            }
        }
        "json" => {
            serde_json::from_slice::<Value>(&std::fs::read(path).map_err(|_| "JSON不可读")?)
                .map_err(|_| "JSON格式无效")?;
        }
        "csv" | "md" => {
            std::fs::read_to_string(path).map_err(|_| "文字产物须使用UTF-8")?;
        }
        _ => return Err("分析输出类型不在允许范围".into()),
    }
    Ok(())
}

fn css(value: &str) -> Result<(), String> {
    // Static Matplotlib styles use local fragment URLs. Refuse CSS imports,
    // escapes and every non-fragment URL rather than maintaining URL schemes.
    let s = value.to_ascii_lowercase();
    if s.contains(['@', '\\']) || s.contains("javascript:") {
        return Err("SVG包含活动样式".into());
    }
    let refs = regex::Regex::new(r#"url\s*\(\s*['\"]?([^)'\"\s]+)"#).expect("static CSS URLs");
    if refs.captures_iter(&s).any(|c| !c[1].starts_with('#')) {
        return Err("SVG包含外部样式引用".into());
    }
    Ok(())
}

pub(super) fn svg(original: &str) -> Result<String, String> {
    let standard=regex::Regex::new(r#"(?is)<!DOCTYPE\s+svg\s+PUBLIC\s+"-//W3C//DTD SVG 1\.1//EN"\s+"https?://www\.w3\.org/Graphics/SVG/1\.1/DTD/svg11\.dtd"\s*>"#).expect("static SVG doctype");
    let safe = standard.replace_all(original, "").into_owned();
    let mut reader = quick_xml::Reader::from_str(&safe);
    let mut depth = 0usize;
    let mut roots = 0usize;
    let mut style_depth = None;
    loop {
        use quick_xml::events::Event;
        let event = reader.read_event().map_err(|_| "SVG结构无效")?;
        match event {
            Event::Start(ref tag) | Event::Empty(ref tag) => {
                let name = String::from_utf8_lossy(tag.local_name().as_ref()).to_ascii_lowercase();
                if depth == 0 {
                    roots += 1;
                    if name != "svg" || roots != 1 {
                        return Err("SVG根节点无效".into());
                    }
                }
                if matches!(
                    name.as_str(),
                    "script"
                        | "foreignobject"
                        | "iframe"
                        | "object"
                        | "embed"
                        | "animate"
                        | "set"
                        | "animatetransform"
                        | "animatemotion"
                        | "handler"
                ) {
                    return Err("SVG包含活动元素".into());
                }
                for attr in tag.attributes() {
                    let attr = attr.map_err(|_| "SVG属性无效")?;
                    let key = String::from_utf8_lossy(attr.key.as_ref()).to_ascii_lowercase();
                    let value = attr
                        .decoded_and_normalized_value(
                            quick_xml::XmlVersion::Implicit1_0,
                            reader.decoder(),
                        )
                        .map_err(|_| "SVG属性编码无效")?;
                    if key.rsplit(':').next().unwrap_or("").starts_with("on")
                        || key == "xml:base"
                        || ((key == "href" || key.ends_with(":href")) && !value.starts_with('#'))
                    {
                        return Err("SVG包含外部或活动引用".into());
                    }
                    css(&value)?;
                }
                if matches!(event, Event::Start(_)) {
                    depth += 1;
                    if name == "style" {
                        style_depth = Some(depth);
                    }
                }
            }
            Event::End(_) => {
                if style_depth == Some(depth) {
                    style_depth = None;
                }
                depth = depth.checked_sub(1).ok_or("SVG节点未配对")?;
            }
            Event::Text(t) if style_depth.is_some() => {
                css(&t.decode().map_err(|_| "SVG样式编码无效")?)?;
            }
            Event::CData(t) if style_depth.is_some() => {
                css(&t.decode().map_err(|_| "SVG样式编码无效")?)?;
            }
            Event::GeneralRef(_) if style_depth.is_some() => {
                return Err("SVG样式不接受实体引用".into())
            }
            Event::DocType(_) | Event::PI(_) => return Err("SVG包含额外文档声明或处理指令".into()),
            Event::Eof => break,
            _ => (),
        }
    }
    if roots != 1 || depth != 0 {
        return Err("SVG结构不完整".into());
    }
    Ok(safe)
}
