use pulldown_cmark::{Event, Parser, Tag, TagEnd};
use serde_json::Value;
use std::collections::HashSet;
use url::Url;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredAttachment {
    pub url: String,
    pub title: String,
    pub link_kind: String,
    pub mime_hint: Option<String>,
    pub size: Option<u64>,
    pub should_download: bool,
    pub block_id: Option<String>,
    pub block_id_exact: bool,
    pub resource_revision: Option<String>,
}

struct PendingLink {
    url: String,
    label: String,
    image: bool,
}

fn is_craft_resource_url(value: &str) -> bool {
    Url::parse(value)
        .ok()
        .filter(|url| url.scheme() == "https")
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
        .is_some_and(|host| host == "r.craft.do")
}

fn file_extension(title: &str) -> Option<String> {
    let leaf = title.rsplit(['/', '\\']).next()?.trim();
    let (_, extension) = leaf.rsplit_once('.')?;
    let extension = extension.trim().to_ascii_lowercase();
    (!extension.is_empty() && extension.len() <= 12).then_some(extension)
}

fn mime_from_extension(extension: &str) -> Option<&'static str> {
    match extension {
        "pdf" => Some("application/pdf"),
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        "svg" => Some("image/svg+xml"),
        "mp4" | "m4v" => Some("video/mp4"),
        "mov" => Some("video/quicktime"),
        "webm" => Some("video/webm"),
        "docx" => Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        "doc" => Some("application/msword"),
        "xlsx" => Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
        "xls" => Some("application/vnd.ms-excel"),
        "pptx" => Some("application/vnd.openxmlformats-officedocument.presentationml.presentation"),
        "ppt" => Some("application/vnd.ms-powerpoint"),
        "zip" => Some("application/zip"),
        "txt" | "log" | "md" => Some("text/plain"),
        _ => None,
    }
}

fn finalize_link(link: PendingLink) -> Option<DiscoveredAttachment> {
    if !is_craft_resource_url(&link.url) {
        return None;
    }
    let title = if link.label.trim().is_empty() {
        if link.image {
            "Craft 图片"
        } else {
            "Craft 附件"
        }
        .to_string()
    } else {
        link.label.trim().to_string()
    };
    let mime_hint = file_extension(&title)
        .as_deref()
        .and_then(mime_from_extension)
        .map(str::to_string);
    let is_video = mime_hint
        .as_deref()
        .is_some_and(|mime_type| mime_type.starts_with("video/"));
    // Videos remain remote until the user presses play in the preview. This keeps
    // opening a document from triggering large background downloads.
    let should_download =
        link.image && !is_video || mime_hint.as_deref() == Some("application/pdf");
    Some(DiscoveredAttachment {
        url: link.url,
        title,
        link_kind: if is_video {
            "video"
        } else if link.image {
            "image"
        } else {
            "link"
        }
        .to_string(),
        mime_hint,
        size: None,
        should_download,
        block_id: None,
        block_id_exact: false,
        resource_revision: None,
    })
}

fn valid_block_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
}

fn resource_revision_from_json_node(
    map: &serde_json::Map<String, Value>,
    block_type: &str,
) -> Option<String> {
    if !matches!(block_type, "image" | "video" | "file") {
        return None;
    }
    // The attachment block's revision describes its resource. A page or text
    // block's modification time does not establish a linked file's revision.
    let value = map.get("metadata")?.get("lastModifiedAt")?;
    match value {
        Value::String(value) => {
            let value = value.trim();
            (!value.is_empty()).then(|| value.to_string())
        }
        Value::Number(value) if value.is_i64() || value.is_u64() => Some(value.to_string()),
        _ => None,
    }
}

fn attachment_from_json_node(
    map: &serde_json::Map<String, Value>,
    block_id: Option<&str>,
) -> Option<DiscoveredAttachment> {
    let url = map.get("url")?.as_str()?.to_string();
    let title = map
        .get("fileName")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let block_type = map
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let video = block_type.contains("video");
    let image = block_type.contains("image") || video;
    let mut attachment = finalize_link(PendingLink {
        url,
        label: title,
        image,
    })?;
    attachment.block_id = block_id
        .filter(|value| valid_block_id(value))
        .map(str::to_string);
    attachment.block_id_exact = attachment.block_id.is_some();
    attachment.size = ["fileSize", "size", "byteSize", "contentLength"]
        .iter()
        .find_map(|key| map.get(*key).and_then(Value::as_u64));
    attachment.resource_revision = resource_revision_from_json_node(map, &block_type);
    if video {
        attachment.link_kind = "video".to_string();
        attachment.should_download = false;
        if attachment.mime_hint.is_none() {
            attachment.mime_hint = Some("video/mp4".to_string());
        }
    }
    Some(attachment)
}

pub fn discover_attachments_from_json(value: &Value) -> Vec<DiscoveredAttachment> {
    fn visit(
        value: &Value,
        parent_block_id: Option<&str>,
        structured_pass: bool,
        discovered: &mut Vec<DiscoveredAttachment>,
        seen: &mut HashSet<String>,
        structured_urls: &mut HashSet<String>,
    ) {
        match value {
            Value::Object(map) => {
                let own_block_id = map
                    .get("id")
                    .or_else(|| map.get("blockId"))
                    .and_then(Value::as_str)
                    .filter(|value| valid_block_id(value));
                let block_id = own_block_id.or(parent_block_id);
                if structured_pass {
                    if let Some(attachment) = attachment_from_json_node(map, block_id) {
                        structured_urls.insert(attachment.url.clone());
                        let identity = attachment.block_id.as_deref().map_or_else(
                            || format!("url:{}", attachment.url),
                            |block| format!("block:{block}:url:{}", attachment.url),
                        );
                        if seen.insert(identity) {
                            discovered.push(attachment);
                        }
                    }
                } else if let Some(markdown) = map.get("markdown").and_then(Value::as_str) {
                    let markdown_attachments = discover_attachments(markdown);
                    let block_type = map
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_ascii_lowercase();
                    let exact_block = own_block_id.is_some()
                        && markdown_attachments.len() == 1
                        && matches!(
                            block_type.as_str(),
                            "text" | "image" | "video" | "file" | "drawing" | "code" | "richurl"
                        );
                    for mut attachment in markdown_attachments {
                        attachment.block_id = block_id.map(str::to_string);
                        attachment.block_id_exact = exact_block;
                        if !structured_urls.contains(&attachment.url)
                            && seen.insert(format!("url:{}", attachment.url))
                        {
                            discovered.push(attachment);
                        }
                    }
                }
                for child in map.values() {
                    visit(
                        child,
                        block_id,
                        structured_pass,
                        discovered,
                        seen,
                        structured_urls,
                    );
                }
            }
            Value::Array(items) => {
                for child in items {
                    visit(
                        child,
                        parent_block_id,
                        structured_pass,
                        discovered,
                        seen,
                        structured_urls,
                    );
                }
            }
            Value::String(text) => {
                if let Ok(parsed) = serde_json::from_str::<Value>(text) {
                    visit(
                        &parsed,
                        parent_block_id,
                        structured_pass,
                        discovered,
                        seen,
                        structured_urls,
                    );
                }
            }
            _ => {}
        }
    }

    let mut discovered = Vec::new();
    let mut seen = HashSet::new();
    let mut structured_urls = HashSet::new();
    // A page's Markdown can repeat URLs from its descendant media blocks. Read
    // every structured resource before using Markdown to fill missing links.
    for structured_pass in [true, false] {
        visit(
            value,
            None,
            structured_pass,
            &mut discovered,
            &mut seen,
            &mut structured_urls,
        );
    }
    discovered
}

pub fn attachment_block_id(markdown: &str, attachment_url: &str) -> Option<String> {
    let mut page_stack = Vec::<String>::new();
    for raw_line in markdown.lines() {
        let line = raw_line.trim();
        if line.starts_with("</page") {
            page_stack.pop();
        }
        if let Some(start) = line.find("<page ") {
            let tag = &line[start..];
            let id = tag
                .find("id=\"")
                .map(|index| &tag[index + 4..])
                .and_then(|remainder| remainder.split('"').next())
                .filter(|value| valid_block_id(value));
            if let Some(id) = id {
                page_stack.push(id.to_string());
            }
        }
        if line.contains(attachment_url) {
            return page_stack.last().cloned();
        }
    }
    None
}

pub fn discover_attachments(markdown: &str) -> Vec<DiscoveredAttachment> {
    let mut markdown_without_craft_tags = String::with_capacity(markdown.len());
    let mut inside_tag = false;
    for character in markdown.chars() {
        match character {
            '<' => inside_tag = true,
            '>' if inside_tag => {
                inside_tag = false;
                markdown_without_craft_tags.push('\n');
            }
            _ if !inside_tag => markdown_without_craft_tags.push(character),
            _ => {}
        }
    }
    let markdown_without_craft_tags = markdown_without_craft_tags
        .lines()
        .map(str::trim_start)
        .collect::<Vec<_>>()
        .join("\n");
    let mut pending: Option<PendingLink> = None;
    let mut discovered = Vec::new();
    let mut seen = HashSet::new();
    for event in Parser::new(&markdown_without_craft_tags) {
        match event {
            Event::Start(Tag::Link { dest_url, .. }) => {
                pending = Some(PendingLink {
                    url: dest_url.into_string(),
                    label: String::new(),
                    image: false,
                });
            }
            Event::Start(Tag::Image { dest_url, .. }) => {
                pending = Some(PendingLink {
                    url: dest_url.into_string(),
                    label: String::new(),
                    image: true,
                });
            }
            Event::Text(value) | Event::Code(value) => {
                if let Some(link) = pending.as_mut() {
                    link.label.push_str(&value);
                }
            }
            Event::End(TagEnd::Link) | Event::End(TagEnd::Image) => {
                if let Some(link) = pending.take() {
                    if let Some(mut attachment) = finalize_link(link) {
                        attachment.block_id = attachment_block_id(markdown, &attachment.url);
                        if seen.insert(attachment.url.clone()) {
                            discovered.push(attachment);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    discovered
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn craft_attachment_cache_markdown_multiple_links_do_not_share_exact_block_identity() {
        let items = discover_attachments_from_json(&serde_json::json!({
            "id": "text-1",
            "type": "text",
            "markdown": "[one.pdf](https://r.craft.do/one) [two.pdf](https://r.craft.do/two)"
        }));
        assert_eq!(items.len(), 2);
        assert!(items
            .iter()
            .all(|item| item.block_id.as_deref() == Some("text-1")));
        assert!(items.iter().all(|item| !item.block_id_exact));
    }

    #[test]
    fn craft_attachment_cache_page_markdown_keeps_only_location_hint() {
        for value in [
            serde_json::json!({
                "id": "page-1", "type": "page",
                "markdown": "[manual.pdf](https://r.craft.do/resource)"
            }),
            serde_json::json!({
                "id": "page-1", "type": "page",
                "content": [{"type": "text", "markdown": "[manual.pdf](https://r.craft.do/resource)"}]
            }),
        ] {
            let items = discover_attachments_from_json(&value);
            assert_eq!(items.len(), 1);
            assert_eq!(items[0].block_id.as_deref(), Some("page-1"));
            assert!(!items[0].block_id_exact);
        }
    }

    #[test]
    fn craft_attachment_cache_distinct_blocks_sharing_url_keep_their_identity() {
        let value = serde_json::json!({
            "id": "page-1",
            "type": "page",
            "markdown": "![Image](https://r.craft.do/shared-resource)",
            "content": [
                {"id":"image-1","type":"image","url":"https://r.craft.do/shared-resource"},
                {"id":"image-2","type":"image","url":"https://r.craft.do/shared-resource"},
                {"id":"image-1","type":"image","url":"https://r.craft.do/shared-resource"}
            ]
        });
        let items = discover_attachments_from_json(&value);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].block_id.as_deref(), Some("image-1"));
        assert_eq!(items[1].block_id.as_deref(), Some("image-2"));
        assert!(items.iter().all(|item| item.block_id_exact));
    }

    #[test]
    fn craft_attachment_cache_structured_metadata_overrides_markdown_fallback() {
        let value = serde_json::json!({
            "data": [{
                "id": "image-block-1",
                "type": "image",
                "fileName": "original.png",
                "fileSize": 2048,
                "url": "https://r.craft.do/current-resource",
                "markdown": "![Image](https://r.craft.do/current-resource)",
                "metadata": {"lastModifiedAt": "2026-10-13T10:00:00Z"}
            }]
        });
        let items = discover_attachments_from_json(&value);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].size, Some(2048));
        assert_eq!(items[0].title, "original.png");
        assert_eq!(items[0].block_id.as_deref(), Some("image-block-1"));
        assert_eq!(
            items[0].resource_revision.as_deref(),
            Some("2026-10-13T10:00:00Z")
        );
    }

    #[test]
    fn craft_attachment_cache_child_resource_precedes_parent_markdown() {
        let value = serde_json::json!({
            "id": "page-1",
            "type": "page",
            "markdown": "![Image](https://r.craft.do/resource)",
            "metadata": {"lastModifiedAt": "parent-revision"},
            "content": [{
                "id": "image-1",
                "type": "image",
                "fileName": "original.png",
                "fileSize": 12,
                "url": "https://r.craft.do/resource",
                "metadata": {"lastModifiedAt": "resource-revision"}
            }]
        });
        let items = discover_attachments_from_json(&value);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].block_id.as_deref(), Some("image-1"));
        assert_eq!(items[0].title, "original.png");
        assert_eq!(items[0].size, Some(12));
        assert_eq!(
            items[0].resource_revision.as_deref(),
            Some("resource-revision")
        );
    }

    #[test]
    fn craft_attachment_cache_markdown_does_not_inherit_container_revision() {
        let value = serde_json::json!({
            "id": "page-1",
            "type": "page",
            "metadata": {"lastModifiedAt": "parent-revision"},
            "content": [{
                "id": "text-1",
                "type": "text",
                "markdown": "[manual.pdf](https://r.craft.do/resource)",
                "metadata": {"lastModifiedAt": "text-revision"}
            }]
        });
        let items = discover_attachments_from_json(&value);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].block_id.as_deref(), Some("text-1"));
        assert!(items[0].resource_revision.is_none());
        assert!(
            discover_attachments("![Image](https://r.craft.do/resource)")[0]
                .resource_revision
                .is_none()
        );
    }

    #[test]
    fn craft_attachment_cache_revision_accepts_only_own_nonempty_scalar() {
        for kind in ["image", "file", "video"] {
            for (revision, expected) in [
                (
                    serde_json::json!("  resource-revision  "),
                    Some("resource-revision"),
                ),
                (serde_json::json!(42), Some("42")),
                (serde_json::json!("  "), None),
                (Value::Null, None),
                (serde_json::json!(true), None),
                (serde_json::json!([]), None),
                (serde_json::json!({"value": "revision"}), None),
                (serde_json::json!(1.5), None),
            ] {
                let value = serde_json::json!({
                    "id": "resource-1",
                    "type": kind,
                    "url": "https://r.craft.do/resource",
                    "metadata": {"lastModifiedAt": revision}
                });
                let items = discover_attachments_from_json(&value);
                assert_eq!(items.len(), 1);
                assert_eq!(items[0].resource_revision.as_deref(), expected);
            }
        }
        let value = serde_json::json!({
            "id": "page-1",
            "type": "page",
            "metadata": {"lastModifiedAt": "parent-revision"},
            "content": [{"id": "image-1", "type": "image", "url": "https://r.craft.do/resource"}]
        });
        assert!(discover_attachments_from_json(&value)[0]
            .resource_revision
            .is_none());
    }

    #[test]
    fn craft_attachment_cache_revision_distinguishes_replacement_from_url_rotation() {
        let resource = |url: &str, revision: &str| {
            discover_attachments_from_json(&serde_json::json!({
                "id": "image-1",
                "type": "image",
                "fileSize": 2048,
                "url": url,
                "metadata": {"lastModifiedAt": revision}
            }))
            .remove(0)
        };
        let original = resource("https://r.craft.do/original-address", "version-1");
        let rotated = resource("https://r.craft.do/new-address", "version-1");
        let replaced = resource("https://r.craft.do/original-address", "version-2");
        assert_eq!(original.block_id, rotated.block_id);
        assert_eq!(original.resource_revision, rotated.resource_revision);
        assert_eq!(original.block_id, replaced.block_id);
        assert_eq!(original.size, replaced.size);
        assert_ne!(original.resource_revision, replaced.resource_revision);
    }

    #[test]
    fn discovers_craft_files_and_defers_images() {
        let markdown = r#"<page id="root"><content>
[手册.pdf](https://r.craft.do/abc-123)
![示意图](https://r.craft.do/image-456)
[demo.mp4](https://r.craft.do/video-789)
[外部链接](https://example.com/file.pdf)
[重复手册.pdf](https://r.craft.do/abc-123)
</content></page>"#;
        let items = discover_attachments(markdown);
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].mime_hint.as_deref(), Some("application/pdf"));
        assert!(items[0].should_download);
        assert_eq!(items[1].link_kind, "image");
        assert!(items[1].should_download);
        assert_eq!(items[2].mime_hint.as_deref(), Some("video/mp4"));
        assert_eq!(items[2].link_kind, "video");
        assert!(!items[2].should_download);
    }

    #[test]
    fn discovers_fresh_structured_attachment_urls() {
        let value = serde_json::json!({
            "data": [{
                "id": "image-block-1",
                "type": "file",
                "fileName": "维修手册.pdf",
                "url": "https://r.craft.do/fresh-resource"
            }]
        });
        let items = discover_attachments_from_json(&value);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "维修手册.pdf");
        assert!(items[0].should_download);
        assert_eq!(items[0].block_id.as_deref(), Some("image-block-1"));
        assert!(items[0].block_id_exact);
    }

    #[test]
    fn discovers_structured_video_as_click_to_load_media() {
        let value = serde_json::json!({
            "data": [{
                "id": "video-block-1",
                "type": "video",
                "fileName": "demo.mp4",
                "fileSize": 2048,
                "url": "https://r.craft.do/video-resource"
            }]
        });
        let items = discover_attachments_from_json(&value);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].mime_hint.as_deref(), Some("video/mp4"));
        assert_eq!(items[0].link_kind, "video");
        assert_eq!(items[0].size, Some(2048));
        assert!(!items[0].should_download);
    }

    #[test]
    fn resolves_attachment_to_its_nested_page() {
        let markdown = r#"<page id="root">
<page id="nested-page">
![示意图](https://r.craft.do/image-456)
</page>
</page>"#;
        assert_eq!(
            attachment_block_id(markdown, "https://r.craft.do/image-456").as_deref(),
            Some("nested-page")
        );
    }

    #[test]
    fn binds_markdown_image_to_its_structured_block() {
        let value = serde_json::json!({
            "data": [{
                "id": "image-block-32",
                "type": "text",
                "markdown": "![Image](https://r.craft.do/image-32)"
            }]
        });
        let items = discover_attachments_from_json(&value);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].url, "https://r.craft.do/image-32");
        assert_eq!(items[0].block_id.as_deref(), Some("image-block-32"));
        assert!(items[0].block_id_exact);
    }
}
