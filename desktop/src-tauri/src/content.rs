use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use url::Url;

const TARGET_CHARS: usize = 1_000;
const MAX_CHARS: usize = 1_400;
const OVERLAP_CHARS: usize = 120;

#[derive(Debug, Clone)]
pub struct ContentChunk {
    pub id: String,
    pub block_id: String,
    pub page_id: String,
    pub page_title: String,
    pub content_type: String,
    pub heading: String,
    pub body: String,
    pub ordinal: i64,
    pub source_hash: String,
}

#[derive(Debug, Clone)]
pub struct ExtractedChunk {
    pub id: String,
    pub block_id: String,
    pub content_type: String,
    pub heading: String,
    pub body: String,
    pub ordinal: i64,
    pub source_hash: String,
    pub source_item_id: String,
    pub page_number: i64,
}

#[derive(Debug, Clone)]
pub struct StructuredBlockHint {
    pub id: String,
    pub parent_page_id: String,
    pub parent_task_id: Option<String>,
    pub markdown: String,
    pub task_completed: Option<bool>,
    pub task_schedule_date: Option<String>,
    pub task_deadline_date: Option<String>,
    pub task_created_at: Option<String>,
    pub indentation_level: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StructuredBlockLocation {
    pub page_id: Option<String>,
    pub page_titles: Vec<String>,
}

#[derive(Clone)]
struct SectionState {
    block_id: String,
    page_title: String,
    heading: String,
    is_subpage: bool,
}

fn attribute_value(line: &str, name: &str) -> Option<String> {
    let marker = format!("{name}=\"");
    let start = line.find(&marker)? + marker.len();
    let value = &line[start..];
    let end = value.find('"')?;
    Some(value[..end].to_string())
}

fn tag_text(line: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = line.find(&open)? + open.len();
    let end = line[start..].find(&close)? + start;
    Some(line[start..end].trim().to_string())
}

fn clean_line(line: &str) -> String {
    let mut output = String::with_capacity(line.len());
    let mut inside_tag = false;
    for character in line.chars() {
        match character {
            '<' => inside_tag = true,
            '>' => inside_tag = false,
            _ if !inside_tag => output.push(character),
            _ => {}
        }
    }
    output.trim().to_string()
}

fn markdown_link_label(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('[', "\\[")
        .replace(']', "\\]")
}

/// Builds a preview for one Craft page without expanding nested page bodies.
/// Direct children are represented as navigable page links instead.
pub fn craft_page_preview(
    markdown: &str,
    root_document_id: &str,
    requested_page_id: &str,
) -> String {
    craft_page_evidence(markdown, root_document_id, requested_page_id)
        .filter(|body| !body.is_empty())
        .unwrap_or_else(|| markdown.to_string())
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct CraftPageNode {
    pub id: String,
    pub title: String,
    pub parent_id: String,
}

pub(crate) fn craft_page_nodes(markdown: &str, root: &str) -> Result<Vec<CraftPageNode>, String> {
    let mut stack = Vec::<String>::new();
    let mut pages = Vec::<CraftPageNode>::new();
    let mut seen = HashMap::<String, String>::new();
    let mut page_indices = HashMap::<String, usize>::new();
    let mut fence = None;
    let mut content_indents = Vec::new();
    for raw in markdown.lines() {
        let line = raw.trim();
        let indent = raw.len() - raw.trim_start().len();
        // Craft's content boundary ends an unterminated Markdown code fence.
        if line == "</content>" && content_indents.last() == Some(&indent) {
            content_indents.pop();
            fence = None;
            continue;
        }
        if line.starts_with("```") || line.starts_with("~~~") {
            let marker = &line[..3];
            if fence == Some(marker) {
                fence = None;
            } else if fence.is_none() {
                fence = Some(marker);
            }
            continue;
        }
        if fence.is_some() {
            continue;
        }
        if line == "<content>" {
            content_indents.push(indent);
            continue;
        }
        if line.starts_with("<page ") {
            let id = attribute_value(line, "id")
                .filter(|id| !id.is_empty())
                .ok_or("页面缺少身份")?;
            let parent = if id == root && stack.is_empty() {
                String::new()
            } else {
                stack.last().cloned().unwrap_or_else(|| root.to_string())
            };
            if stack.contains(&id) || seen.get(&id).is_some_and(|old| old != &parent) {
                return Err("页面身份或父级冲突".into());
            }
            let first = seen.insert(id.clone(), parent.clone()).is_none();
            if id != root && first {
                page_indices.insert(id.clone(), pages.len());
                pages.push(CraftPageNode {
                    id: id.clone(),
                    title: attribute_value(line, "title").unwrap_or_default(),
                    parent_id: parent,
                });
            }
            stack.push(id);
        } else if line == "</page>" {
            if stack.pop().is_none() {
                return Err("页面结构不完整".into());
            }
        } else if let Some(title) = tag_text(line, "pageTitle") {
            if let Some(page) = stack
                .last()
                .and_then(|id| page_indices.get(id))
                .and_then(|index| pages.get_mut(*index))
            {
                if !page.title.is_empty() && page.title != title {
                    return Err("页面标题快照冲突".into());
                }
                page.title = title;
            }
        }
    }
    if !stack.is_empty() {
        return Err("页面结构不完整".into());
    }
    for page in &mut pages {
        if page.title.trim().is_empty() {
            page.title = "未命名页面".into();
        }
    }
    Ok(pages)
}

/// Exact page projection. Missing pages and empty pages must not fall back to
/// the enclosing document when this content is used as evidence.
pub fn craft_page_evidence(
    markdown: &str,
    root_document_id: &str,
    requested_page_id: &str,
) -> Option<String> {
    let requested_page_id = if requested_page_id.trim().is_empty() {
        root_document_id
    } else {
        requested_page_id
    };
    let mut stack = Vec::<String>::new();
    let mut target_depth = None::<usize>;
    let mut target_content_indent = None::<usize>;
    let mut found_target = false;
    let mut output = Vec::<String>::new();
    let mut child_link_written = HashSet::<String>::new();

    for raw_line in markdown.lines() {
        let trimmed = raw_line.trim();
        if trimmed.starts_with("<page ") {
            let id = attribute_value(trimmed, "id").unwrap_or_default();
            stack.push(id.clone());
            let depth = stack.len();
            if id == requested_page_id {
                target_depth = Some(depth);
                target_content_indent = None;
                found_target = true;
            }
            let is_direct_child = target_depth.is_some_and(|target| depth == target + 1)
                || (!found_target && requested_page_id == root_document_id && depth == 1);
            if is_direct_child {
                if let Some(title) =
                    attribute_value(trimmed, "title").filter(|value| !value.trim().is_empty())
                {
                    if child_link_written.insert(id.clone()) {
                        output.push(format!(
                            "[{}](#craft-subpage={id})",
                            markdown_link_label(title.trim())
                        ));
                    }
                }
            }
            continue;
        }
        if trimmed == "</page>" {
            if target_depth == Some(stack.len()) {
                target_depth = None;
                target_content_indent = None;
            }
            stack.pop();
            continue;
        }
        if trimmed == "<content>" {
            if target_depth == Some(stack.len()) {
                target_content_indent = Some(
                    raw_line
                        .chars()
                        .take_while(|character| *character == ' ')
                        .count()
                        + 2,
                );
            }
            continue;
        }
        if trimmed == "</content>" {
            continue;
        }
        if let Some(title) = tag_text(trimmed, "pageTitle") {
            let is_direct_child = target_depth.is_some_and(|target| stack.len() == target + 1)
                || (!found_target && requested_page_id == root_document_id && stack.len() == 1);
            if is_direct_child {
                let id = stack.last().cloned().unwrap_or_default();
                if !id.is_empty() && child_link_written.insert(id.clone()) {
                    output.push(format!(
                        "[{}](#craft-subpage={id})",
                        markdown_link_label(title.trim())
                    ));
                }
            }
            continue;
        }
        let inside_target = target_depth == Some(stack.len());
        let root_without_wrapper =
            stack.is_empty() && requested_page_id == root_document_id && !found_target;
        if (inside_target || root_without_wrapper) && !trimmed.starts_with("Next page:") {
            let line = if inside_target {
                let indent = target_content_indent.unwrap_or_default();
                let removable = raw_line
                    .as_bytes()
                    .iter()
                    .take(indent)
                    .take_while(|byte| **byte == b' ')
                    .count();
                &raw_line[removable..]
            } else {
                raw_line
            };
            output.push(line.to_string());
        }
    }
    if !found_target && requested_page_id != root_document_id {
        return None;
    }
    Some(output.join("\n").trim().to_string())
}

fn valid_block_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
}

fn object_is_page_like(map: &Map<String, Value>) -> bool {
    let markdown = map.get("markdown").and_then(Value::as_str);
    let block_type = map
        .get("type")
        .and_then(Value::as_str)
        .map(str::to_ascii_lowercase);
    map.get("content").is_some()
        && (markdown.is_none()
            || block_type.as_deref().is_some_and(|value| {
                value.contains("page") || value.contains("card") || value.contains("document")
            }))
}

fn object_editor_url(map: &Map<String, Value>) -> Option<String> {
    map.values().filter_map(Value::as_str).find_map(|value| {
        let url = Url::parse(value).ok()?;
        (url.host_str() == Some("docs.craft.do") && url.path().starts_with("/editor/"))
            .then(|| url.to_string())
    })
}

pub fn structured_block_url(value: &Value, block_id: &str) -> Option<String> {
    fn visit(value: &Value, block_id: &str, parent_page_url: Option<&str>) -> Option<String> {
        match value {
            Value::Object(map) => {
                let id = map
                    .get("id")
                    .or_else(|| map.get("blockId"))
                    .and_then(Value::as_str);
                let own_page_url = object_editor_url(map);
                let page_url = if object_is_page_like(map) {
                    own_page_url.as_deref().or(parent_page_url)
                } else {
                    parent_page_url
                };
                if id == Some(block_id) {
                    let mut url = Url::parse(page_url?).ok()?;
                    url.set_fragment(Some(block_id));
                    return Some(url.to_string());
                }
                for child in map.values() {
                    if let Some(url) = visit(child, block_id, page_url) {
                        return Some(url);
                    }
                }
                None
            }
            Value::Array(items) => items
                .iter()
                .find_map(|child| visit(child, block_id, parent_page_url)),
            Value::String(text) => serde_json::from_str::<Value>(text)
                .ok()
                .and_then(|parsed| visit(&parsed, block_id, parent_page_url)),
            _ => None,
        }
    }

    visit(value, block_id, None)
}

pub fn structured_block_location(
    value: &Value,
    root_document_id: &str,
    block_id: &str,
) -> Option<StructuredBlockLocation> {
    fn page_title(map: &Map<String, Value>) -> Option<String> {
        ["markdown", "title", "pageTitle", "name"]
            .iter()
            .find_map(|key| map.get(*key).and_then(Value::as_str))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    }

    fn visit(
        value: &Value,
        root_document_id: &str,
        block_id: &str,
        pages: &[(String, String)],
    ) -> Option<StructuredBlockLocation> {
        match value {
            Value::Object(map) => {
                let id = map
                    .get("id")
                    .or_else(|| map.get("blockId"))
                    .and_then(Value::as_str);
                let mut nested_pages = pages.to_vec();
                if object_is_page_like(map) {
                    if let Some(id) = id.filter(|id| *id != root_document_id) {
                        nested_pages.push((id.to_string(), page_title(map).unwrap_or_default()));
                    }
                }
                if id == Some(block_id) {
                    return Some(StructuredBlockLocation {
                        page_id: nested_pages.first().map(|(id, _)| id.clone()),
                        page_titles: nested_pages
                            .iter()
                            .filter_map(|(_, title)| (!title.is_empty()).then(|| title.clone()))
                            .collect(),
                    });
                }
                for child in map.values() {
                    if let Some(location) = visit(child, root_document_id, block_id, &nested_pages)
                    {
                        return Some(location);
                    }
                }
                None
            }
            Value::Array(items) => items
                .iter()
                .find_map(|child| visit(child, root_document_id, block_id, pages)),
            Value::String(text) => serde_json::from_str::<Value>(text)
                .ok()
                .and_then(|parsed| visit(&parsed, root_document_id, block_id, pages)),
            _ => None,
        }
    }

    visit(value, root_document_id, block_id, &[])
}

pub fn structured_block_hints(value: &Value) -> Vec<StructuredBlockHint> {
    fn block_markdown(map: &Map<String, Value>) -> Option<String> {
        if let Some(markdown) = map
            .get("markdown")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Some(markdown.to_string());
        }
        let url = map.get("url").and_then(Value::as_str)?.trim();
        if url.is_empty() {
            return None;
        }
        let block_type = map
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase();
        let title = map
            .get("fileName")
            .or_else(|| map.get("altText"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(if block_type.contains("image") {
                "Craft 图片"
            } else {
                "Craft 附件"
            });
        Some(if block_type.contains("image") {
            format!("![{}]({url})", markdown_link_label(title))
        } else if block_type.contains("file") || block_type.contains("attachment") {
            format!("[{}]({url})", markdown_link_label(title))
        } else {
            return None;
        })
    }

    fn task_completed(map: &Map<String, Value>) -> Option<bool> {
        fn state(value: &str) -> Option<bool> {
            match value.to_ascii_lowercase().as_str() {
                "checked" | "done" | "completed" | "complete" | "canceled" | "cancelled" => {
                    Some(true)
                }
                "unchecked" | "open" | "todo" | "active" => Some(false),
                _ => None,
            }
        }
        if let Some(list_style) = map.get("listStyle") {
            match list_style {
                Value::String(value)
                    if matches!(value.to_ascii_lowercase().as_str(), "task" | "todo") =>
                {
                    return map
                        .get("taskInfo")
                        .and_then(Value::as_object)
                        .and_then(|info| info.get("state"))
                        .and_then(Value::as_str)
                        .and_then(state)
                        .or(Some(false));
                }
                Value::Object(style)
                    if style
                        .get("type")
                        .and_then(Value::as_str)
                        .is_some_and(|value| {
                            matches!(value.to_ascii_lowercase().as_str(), "task" | "todo")
                        }) =>
                {
                    return style
                        .get("state")
                        .and_then(Value::as_str)
                        .and_then(state)
                        .or(Some(false));
                }
                _ => {}
            }
        }
        map.get("taskInfo")
            .and_then(Value::as_object)
            .and_then(|info| info.get("state"))
            .and_then(Value::as_str)
            .and_then(state)
    }

    fn visit(
        value: &Value,
        parent_page_id: Option<&str>,
        parent_task_id: Option<&str>,
        hints: &mut Vec<StructuredBlockHint>,
    ) {
        match value {
            Value::Object(map) => {
                let id = map
                    .get("id")
                    .or_else(|| map.get("blockId"))
                    .and_then(Value::as_str)
                    .filter(|value| valid_block_id(value));
                let markdown = block_markdown(map);
                let page_id = if object_is_page_like(map) {
                    id.or(parent_page_id)
                } else {
                    parent_page_id
                };
                let completed = task_completed(map);
                let task_info = map.get("taskInfo").and_then(Value::as_object);
                let schedule_date = task_info
                    .and_then(|info| info.get("scheduleDate"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let deadline_date = task_info
                    .and_then(|info| info.get("deadlineDate"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                // Creation belongs to this task block alone; never inherit the
                // containing document/page's metadata.createdAt.
                let created_at = completed.and_then(|_| {
                    map.get("metadata")
                        .and_then(|metadata| metadata.get("createdAt"))
                        .and_then(Value::as_str)
                        .and_then(crate::task_dates::valid_date)
                });
                let indentation_level = map
                    .get("indentationLevel")
                    .and_then(Value::as_u64)
                    .map(|value| value.min(5) as usize);
                if let (Some(id), Some(parent_page_id), Some(markdown)) =
                    (id, parent_page_id, markdown.as_deref())
                {
                    if !markdown.trim().is_empty() {
                        hints.push(StructuredBlockHint {
                            id: id.to_string(),
                            parent_page_id: parent_page_id.to_string(),
                            parent_task_id: parent_task_id.map(str::to_string),
                            markdown: markdown.trim().to_string(),
                            task_completed: completed,
                            task_schedule_date: schedule_date,
                            task_deadline_date: deadline_date,
                            task_created_at: created_at,
                            indentation_level,
                        });
                    }
                }
                let child_parent_task_id = if completed.is_some() {
                    id.or(parent_task_id)
                } else {
                    parent_task_id
                };
                for child in map.values() {
                    visit(child, page_id, child_parent_task_id, hints);
                }
            }
            Value::Array(items) => {
                for child in items {
                    visit(child, parent_page_id, parent_task_id, hints);
                }
            }
            Value::String(text) => {
                if let Ok(parsed) = serde_json::from_str::<Value>(text) {
                    visit(&parsed, parent_page_id, parent_task_id, hints);
                }
            }
            _ => {}
        }
    }

    let mut hints = Vec::new();
    visit(value, None, None, &mut hints);
    hints
}

fn markdown_heading(markdown: &str) -> Option<&str> {
    markdown.lines().find_map(|line| {
        let line = line.trim();
        let heading = line.strip_prefix('#')?;
        let heading = heading.trim_start_matches('#').trim();
        (!heading.is_empty()).then_some(heading)
    })
}

fn normalized_markdown(markdown: &str) -> String {
    markdown
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn apply_structured_block_hints(chunks: &mut [ContentChunk], hints: &[StructuredBlockHint]) {
    for chunk in chunks {
        if let Some(block_id) =
            structured_block_id(&chunk.block_id, &chunk.heading, &chunk.body, hints)
        {
            chunk.block_id = block_id;
        }
    }
}

pub fn structured_block_id(
    parent_page_id: &str,
    heading: &str,
    body: &str,
    hints: &[StructuredBlockHint],
) -> Option<String> {
    let heading_match = hints.iter().find(|hint| {
        hint.parent_page_id == parent_page_id
            && markdown_heading(&hint.markdown) == Some(heading.trim())
    });
    let body_match = hints.iter().find(|hint| {
        if hint.parent_page_id != parent_page_id {
            return false;
        }
        let markdown = normalized_markdown(&hint.markdown);
        !markdown.is_empty() && body.contains(&markdown)
    });
    heading_match.or(body_match).map(|hint| hint.id.clone())
}

pub fn structured_body_block_id(
    parent_page_id: &str,
    body: &str,
    match_terms: &[String],
    hints: &[StructuredBlockHint],
) -> Option<String> {
    let terms = match_terms
        .iter()
        .map(|term| term.trim().to_lowercase())
        .filter(|term| !term.is_empty())
        .collect::<Vec<_>>();
    if terms.is_empty() {
        return None;
    }
    let normalized_body = normalized_markdown(body).to_lowercase();
    hints
        .iter()
        .filter(|hint| hint.parent_page_id == parent_page_id)
        .filter_map(|hint| {
            let markdown = normalized_markdown(&hint.markdown);
            if markdown.is_empty() {
                return None;
            }
            let lower_markdown = markdown.to_lowercase();
            let matched_terms = terms
                .iter()
                .filter(|term| lower_markdown.contains(term.as_str()))
                .count();
            if matched_terms == 0 {
                return None;
            }
            let belongs_to_chunk = normalized_body.contains(&lower_markdown);
            Some((
                hint,
                belongs_to_chunk,
                matched_terms,
                markdown.chars().count(),
            ))
        })
        .max_by(|left, right| {
            left.1
                .cmp(&right.1)
                .then_with(|| left.2.cmp(&right.2))
                .then_with(|| right.3.cmp(&left.3))
        })
        .map(|(hint, _, _, _)| hint.id.clone())
}

fn take_chars(text: &str, start: usize, count: usize) -> String {
    text.chars().skip(start).take(count).collect()
}

fn push_section_chunks(
    chunks: &mut Vec<ContentChunk>,
    document_key: &str,
    state: &SectionState,
    lines: &mut Vec<String>,
    ordinal: &mut i64,
) {
    let normalized = lines
        .drain(..)
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if normalized.is_empty() {
        return;
    }
    let total = normalized.chars().count();
    let mut start = 0_usize;
    while start < total {
        let remaining = total - start;
        let length = remaining.min(if remaining > MAX_CHARS {
            TARGET_CHARS
        } else {
            MAX_CHARS
        });
        let body = take_chars(&normalized, start, length);
        let source_hash = format!("{:x}", Sha256::digest(body.as_bytes()));
        chunks.push(ContentChunk {
            id: format!("{document_key}:{}", *ordinal),
            block_id: state.block_id.clone(),
            page_id: state.block_id.clone(),
            page_title: state.page_title.clone(),
            content_type: if state.is_subpage {
                "craft_subpage".to_string()
            } else {
                "markdown_section".to_string()
            },
            heading: if state.heading.is_empty() {
                state.page_title.clone()
            } else {
                state.heading.clone()
            },
            body,
            ordinal: *ordinal,
            source_hash,
        });
        *ordinal += 1;
        if start + length >= total {
            break;
        }
        start += length.saturating_sub(OVERLAP_CHARS);
    }
}

pub fn chunk_markdown(
    space_id: &str,
    document_id: &str,
    title: &str,
    markdown: &str,
) -> Vec<ContentChunk> {
    let document_key = format!("{space_id}:{document_id}");
    let mut chunks = Vec::new();
    let mut ordinal = 0_i64;
    let mut stack = vec![SectionState {
        block_id: document_id.to_string(),
        page_title: title.to_string(),
        heading: title.to_string(),
        is_subpage: false,
    }];
    let mut lines = Vec::new();

    for raw_line in markdown.lines() {
        let line = raw_line.trim();
        if line.starts_with("<page ") {
            if let Some(current) = stack.last() {
                push_section_chunks(
                    &mut chunks,
                    &document_key,
                    current,
                    &mut lines,
                    &mut ordinal,
                );
            }
            let block_id = attribute_value(line, "id").unwrap_or_else(|| document_id.to_string());
            stack.push(SectionState {
                is_subpage: block_id != document_id,
                block_id,
                page_title: String::new(),
                heading: String::new(),
            });
            continue;
        }
        if line == "</page>" {
            if let Some(current) = stack.last() {
                push_section_chunks(
                    &mut chunks,
                    &document_key,
                    current,
                    &mut lines,
                    &mut ordinal,
                );
            }
            if stack.len() > 1 {
                stack.pop();
            }
            continue;
        }
        if let Some(page_title) = tag_text(line, "pageTitle") {
            if let Some(current) = stack.last_mut() {
                current.page_title = page_title.clone();
                current.heading = page_title;
            }
            continue;
        }
        if let Some(heading) = line.strip_prefix('#') {
            if let Some(current) = stack.last() {
                push_section_chunks(
                    &mut chunks,
                    &document_key,
                    current,
                    &mut lines,
                    &mut ordinal,
                );
            }
            if let Some(current) = stack.last_mut() {
                current.heading = heading.trim_start_matches('#').trim().to_string();
            }
            continue;
        }
        let cleaned = clean_line(raw_line);
        if !cleaned.is_empty() {
            lines.push(cleaned);
        }
    }
    if let Some(current) = stack.last() {
        push_section_chunks(
            &mut chunks,
            &document_key,
            current,
            &mut lines,
            &mut ordinal,
        );
    }

    // Craft pages can act purely as containers for nested pages. They still need
    // their own searchable record; otherwise a page such as "物料选型" disappears
    // from the index and only references to it in a parent page can be found.
    let mut indexed_page_ids = chunks
        .iter()
        .map(|chunk| chunk.page_id.clone())
        .collect::<HashSet<_>>();
    let mut pending_page_id: Option<String> = None;
    for raw_line in markdown.lines() {
        let line = raw_line.trim();
        if line.starts_with("<page ") {
            pending_page_id = attribute_value(line, "id");
            continue;
        }
        let Some(page_title) = tag_text(line, "pageTitle") else {
            continue;
        };
        let Some(page_id) = pending_page_id.take() else {
            continue;
        };
        if page_id == document_id || !indexed_page_ids.insert(page_id.clone()) {
            continue;
        }
        let body = page_title.clone();
        chunks.push(ContentChunk {
            id: format!("{document_key}:{}", ordinal),
            block_id: page_id.clone(),
            page_id,
            page_title: page_title.clone(),
            content_type: "craft_subpage".to_string(),
            heading: page_title,
            ordinal,
            source_hash: format!("{:x}", Sha256::digest(body.as_bytes())),
            body,
        });
        ordinal += 1;
    }

    if chunks.is_empty() {
        let body = clean_line(markdown);
        let body = if body.is_empty() {
            title.to_string()
        } else {
            body
        };
        chunks.push(ContentChunk {
            id: format!("{document_key}:0"),
            block_id: document_id.to_string(),
            page_id: document_id.to_string(),
            page_title: title.to_string(),
            content_type: "markdown_section".to_string(),
            heading: title.to_string(),
            source_hash: format!("{:x}", Sha256::digest(body.as_bytes())),
            body,
            ordinal: 0,
        });
    }
    chunks
}

pub fn chunk_pdf_pages(
    document_id: &str,
    source_item_id: &str,
    title: &str,
    pages: &[String],
) -> Vec<ExtractedChunk> {
    let mut chunks = Vec::new();
    let mut ordinal = 0_i64;
    for (page_index, page) in pages.iter().enumerate() {
        let normalized = page
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        if normalized.is_empty() {
            continue;
        }
        let total = normalized.chars().count();
        let mut start = 0_usize;
        let page_number = page_index as i64 + 1;
        while start < total {
            let remaining = total - start;
            let length = remaining.min(if remaining > MAX_CHARS {
                TARGET_CHARS
            } else {
                MAX_CHARS
            });
            let body = take_chars(&normalized, start, length);
            let source_hash = format!("{:x}", Sha256::digest(body.as_bytes()));
            chunks.push(ExtractedChunk {
                id: format!("{source_item_id}:p{page_number}:{ordinal}"),
                block_id: document_id.to_string(),
                content_type: "pdf_page".to_string(),
                heading: format!("{title} · 第 {page_number} 页"),
                body,
                ordinal,
                source_hash,
                source_item_id: source_item_id.to_string(),
                page_number,
            });
            ordinal += 1;
            if start + length >= total {
                break;
            }
            start += length.saturating_sub(OVERLAP_CHARS);
        }
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn craft_page_preview_keeps_children_as_links_instead_of_expanding_their_bodies() {
        let markdown = r#"<page id="root">
<pageTitle>Standards</pageTitle>
<content>
Parent introduction.
<page id="child" title="Design standard">
<pageTitle>Design standard</pageTitle>
<content>
Child-only details.
<page id="grandchild">
<pageTitle>2D topology</pageTitle>
<content>Grandchild-only details.</content>
</page>
</content>
</page>
</content>
</page>"#;

        let root = craft_page_preview(markdown, "root", "root");
        assert!(root.contains("Parent introduction."));
        assert!(root.contains("[Design standard](#craft-subpage=child)"));
        assert!(!root.contains("Child-only details."));
        assert!(!root.contains("Grandchild-only details."));

        let child = craft_page_preview(markdown, "root", "child");
        assert!(child.contains("Child-only details."));
        assert!(child.contains("[2D topology](#craft-subpage=grandchild)"));
        assert!(!child.contains("Parent introduction."));
        assert!(!child.contains("Grandchild-only details."));
    }

    #[test]
    fn craft_page_preview_removes_container_indent_but_keeps_toggle_indent() {
        let markdown = r#"<page id="root">
  <pageTitle>Root</pageTitle>
  <content>
    <page id="child">
      <pageTitle>Child</pageTitle>
      <content>
        ## Section

        + Toggle title

          Toggle body

          | A | B |
          | - | - |
          | 1 | 2 |
      </content>
    </page>
  </content>
</page>"#;

        let child = craft_page_preview(markdown, "root", "child");
        assert!(child.starts_with("## Section"));
        assert!(child.contains("\n+ Toggle title\n\n  Toggle body"));
        assert!(child.contains("\n  | A | B |\n  | - | - |"));
        assert!(!child.contains("        ## Section"));
    }

    #[test]
    fn craft_root_without_a_wrapper_lists_top_level_pages() {
        let markdown = r#"Root introduction.
<page id="child">
<pageTitle>Child page</pageTitle>
<content>Hidden child body.</content>
</page>"#;

        let root = craft_page_preview(markdown, "root", "root");
        assert!(root.contains("Root introduction."));
        assert!(root.contains("[Child page](#craft-subpage=child)"));
        assert!(!root.contains("Hidden child body."));
    }

    #[test]
    fn nested_pages_and_headings_become_searchable_chunks() {
        let markdown = r#"<page id="root">
<pageTitle>主页面</pageTitle>
<content>
# 第一章
线束与连接器正文
<page id="child">
<pageTitle>子页面</pageTitle>
<content>OBD 故障码说明</content>
</page>
</content>
</page>"#;
        let chunks = chunk_markdown("space", "root", "主页面", markdown);
        assert!(chunks.iter().any(|chunk| chunk.heading == "第一章"));
        assert!(chunks
            .iter()
            .any(|chunk| chunk.block_id == "child" && chunk.heading == "子页面"));
        assert!(chunks
            .iter()
            .any(|chunk| chunk.block_id == "child" && chunk.content_type == "craft_subpage"));
        assert!(chunks.iter().any(|chunk| chunk.body.contains("OBD")));
    }

    #[test]
    fn container_only_subpages_receive_a_searchable_identity_chunk() {
        let markdown = r#"<page id="root">
<pageTitle>3_物料与选型库</pageTitle>
<content>
<page id="selection">
<pageTitle>物料选型</pageTitle>
<content>
<page id="clip">
<pageTitle>卡扣</pageTitle>
<content>卡扣正文</content>
</page>
</content>
</page>
</content>
</page>"#;
        let chunks = chunk_markdown("space", "root", "3_物料与选型库", markdown);
        let selection = chunks
            .iter()
            .find(|chunk| chunk.page_id == "selection")
            .expect("container-only page should remain independently searchable");
        assert_eq!(selection.page_title, "物料选型");
        assert_eq!(selection.heading, "物料选型");
        assert_eq!(selection.body, "物料选型");
        assert_eq!(selection.content_type, "craft_subpage");
    }

    #[test]
    fn structured_heading_id_replaces_the_parent_page_id() {
        let markdown = r#"<page id="root">
<pageTitle>Root</pageTitle>
<content>
<page id="child">
<pageTitle>Theory</pageTitle>
<content>
### Fishbone Diagram
- Exact body
</content>
</page>
</content>
</page>"#;
        let structured = serde_json::json!({
            "id": "root",
            "content": [{
                "id": "child",
                "content": [
                    {"id": "heading-block", "type": "text", "markdown": "### Fishbone Diagram"},
                    {"id": "body-block", "type": "text", "markdown": "- Exact body"}
                ]
            }]
        });
        let mut chunks = chunk_markdown("space", "root", "Root", markdown);
        apply_structured_block_hints(&mut chunks, &structured_block_hints(&structured));
        let fishbone = chunks
            .iter()
            .find(|chunk| chunk.heading == "Fishbone Diagram")
            .unwrap();
        assert_eq!(fishbone.block_id, "heading-block");
        assert_eq!(fishbone.page_id, "child");
        assert_eq!(fishbone.page_title, "Theory");
    }

    #[test]
    fn structured_body_match_prefers_the_exact_text_block_over_the_section_heading() {
        let hints = vec![
            StructuredBlockHint {
                id: "heading-block".to_string(),
                parent_page_id: "page".to_string(),
                parent_task_id: None,
                markdown: "## 性能优化".to_string(),
                task_completed: None,
                task_schedule_date: None,
                task_deadline_date: None,
                task_created_at: None,
                indentation_level: None,
            },
            StructuredBlockHint {
                id: "intro-block".to_string(),
                parent_page_id: "page".to_string(),
                parent_task_id: None,
                markdown: "星河项目正在建设本地搜索系统。".to_string(),
                task_completed: None,
                task_schedule_date: None,
                task_deadline_date: None,
                task_created_at: None,
                indentation_level: None,
            },
            StructuredBlockHint {
                id: "exact-body-block".to_string(),
                parent_page_id: "page".to_string(),
                parent_task_id: None,
                markdown: "Hub_0.16.4_x64_portable".to_string(),
                task_completed: None,
                task_schedule_date: None,
                task_deadline_date: None,
                task_created_at: None,
                indentation_level: None,
            },
        ];
        let terms = vec!["Hub_0.16.4_x64_portable".to_string()];
        assert_eq!(
            structured_body_block_id(
                "page",
                "星河项目正在建设本地搜索系统。\nHub_0.16.4_x64_portable",
                &terms,
                &hints,
            )
            .as_deref(),
            Some("exact-body-block")
        );
    }

    #[test]
    fn structured_block_hints_keep_native_craft_task_identity_and_state() {
        let structured = serde_json::json!({
            "id": "page-1",
            "type": "page",
            "content": [
                {"id":"task-open","type":"text","markdown":"带充电器","listStyle":{"type":"todo","state":"unchecked"}},
                {"id":"task-parent","type":"text","markdown":"父任务","listStyle":{"type":"todo","state":"unchecked"},"content":[
                    {"id":"task-child","type":"text","markdown":"子任务","listStyle":{"type":"todo","state":"unchecked"}}
                ]},
                {"id":"task-done","type":"text","markdown":"检查线束","indentationLevel":1,"listStyle":"task","taskInfo":{"state":"done","scheduleDate":"2026-08-22","deadlineDate":"2026-08-24"}},
                {"id":"plain","type":"text","markdown":"普通段落"}
            ]
        });
        let hints = structured_block_hints(&structured);
        let open = hints.iter().find(|hint| hint.id == "task-open").unwrap();
        let done = hints.iter().find(|hint| hint.id == "task-done").unwrap();
        let child = hints.iter().find(|hint| hint.id == "task-child").unwrap();
        let plain = hints.iter().find(|hint| hint.id == "plain").unwrap();
        assert_eq!(open.task_completed, Some(false));
        assert_eq!(done.task_completed, Some(true));
        assert_eq!(done.task_schedule_date.as_deref(), Some("2026-08-22"));
        assert_eq!(done.task_deadline_date.as_deref(), Some("2026-08-24"));
        assert_eq!(done.indentation_level, Some(1));
        assert_eq!(child.parent_task_id.as_deref(), Some("task-parent"));
        assert_eq!(plain.task_completed, None);
    }

    #[test]
    fn structured_block_hints_synthesize_task_detail_images() {
        let structured = serde_json::json!({
            "id": "page-1",
            "type": "page",
            "content": [{
                "id":"task-1",
                "type":"text",
                "markdown":"检查车辆",
                "listStyle":{"type":"todo","state":"unchecked"},
                "content":[{
                    "id":"image-1",
                    "type":"image",
                    "url":"https://r.craft.do/image-1",
                    "altText":"现场照片"
                }]
            }]
        });
        let hints = structured_block_hints(&structured);
        let image = hints.iter().find(|hint| hint.id == "image-1").unwrap();
        assert_eq!(image.parent_task_id.as_deref(), Some("task-1"));
        assert_eq!(image.markdown, "![现场照片](https://r.craft.do/image-1)");
        assert_eq!(image.task_completed, None);
    }

    #[test]
    fn structured_block_url_uses_the_parent_page_and_exact_anchor() {
        let structured = serde_json::json!({
            "id": "document",
            "type": "document",
            "url": "https://docs.craft.do/editor/d/space/document",
            "content": [{
                "id": "page",
                "type": "page",
                "url": "https://docs.craft.do/editor/d/space/document/b/page/path?s=session",
                "content": [{
                    "id": "heading-block",
                    "type": "text",
                    "markdown": "### Heading"
                }]
            }]
        });
        assert_eq!(
            structured_block_url(&structured, "heading-block").as_deref(),
            Some(
                "https://docs.craft.do/editor/d/space/document/b/page/path?s=session#heading-block"
            )
        );
    }

    #[test]
    fn structured_block_location_keeps_nested_page_path_and_exact_block() {
        let structured = serde_json::json!({
            "data": [{
                "id": "root",
                "type": "page",
                "markdown": "Root",
                "content": [{
                    "id": "page-a",
                    "type": "page",
                    "markdown": "供应商",
                    "content": [{
                        "id": "page-b",
                        "type": "page",
                        "markdown": "凯密科-中国",
                        "content": [{
                            "id": "exact-block",
                            "type": "text",
                            "markdown": "防水泥"
                        }]
                    }]
                }]
            }]
        });
        assert_eq!(
            structured_block_location(&structured, "root", "exact-block"),
            Some(StructuredBlockLocation {
                page_id: Some("page-a".to_string()),
                page_titles: vec!["供应商".to_string(), "凯密科-中国".to_string()],
            })
        );
    }

    #[test]
    fn pdf_pages_keep_page_numbers_and_parent_deep_link() {
        let chunks = chunk_pdf_pages(
            "document",
            "attachment:space:hash",
            "维修手册.pdf",
            &["第一页正文".to_string(), "第二页 OBD 故障码".to_string()],
        );
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].block_id, "document");
        assert_eq!(chunks[1].page_number, 2);
        assert!(chunks[1].heading.contains("第 2 页"));
    }
}
