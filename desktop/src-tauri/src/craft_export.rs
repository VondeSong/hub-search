use crate::blob_store::BlobStore;
use chrono::NaiveDate;
use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
};
use tauri::{AppHandle, Emitter};
use url::Url;

const MANIFEST_VERSION: u32 = 7;
const MARKDOWN_PATH_ENCODE_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'(')
    .add(b')')
    .add(b'<')
    .add(b'>')
    .add(b'[')
    .add(b']')
    .add(b'`');

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CraftVaultExportOptions {
    pub library_id: String,
    /// Parent directory selected by the user. When `vault_name` is present we
    /// create a dedicated child folder so an export never spills loose files
    /// into an arbitrary directory.
    pub destination: String,
    #[serde(default)]
    pub vault_name: Option<String>,
    #[serde(default = "enabled")]
    pub include_images: bool,
    #[serde(default = "enabled")]
    pub include_videos: bool,
    #[serde(default = "enabled")]
    pub include_other_attachments: bool,
    #[serde(default = "enabled")]
    pub export_daily_notes: bool,
    #[serde(default = "enabled")]
    pub create_obsidian_config: bool,
    #[serde(default)]
    pub backup_interval_minutes: u64,
    #[serde(default)]
    pub replica_destination: Option<String>,
}

fn enabled() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CraftVaultExportProgress {
    pub library_id: String,
    pub phase: String,
    pub completed: usize,
    pub total: usize,
    pub current: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CraftVaultExportSummary {
    pub destination: String,
    pub vault_name: String,
    pub exported_documents: usize,
    pub skipped_documents: usize,
    pub exported_attachments: usize,
    pub skipped_attachments: usize,
    pub conflicts: usize,
    pub failed_attachments: usize,
    pub backup_root: String,
    pub snapshot_id: String,
    pub backup_complete: bool,
    pub issues: Vec<crate::craft_backup::BackupIssue>,
    pub replica_path: Option<String>,
    pub external_references: usize,
}

#[derive(Debug, Clone)]
pub(crate) struct ExportDocument {
    pub id: String,
    pub title: String,
    pub folder_path: String,
    pub markdown: String,
    pub modified_at: Option<i64>,
    pub content_hash: String,
    pub raw_document_id: Option<String>,
    pub block_markdown: Vec<(String, String)>,
}

#[derive(Debug, Clone)]
pub(crate) struct ExportAttachment {
    pub id: String,
    pub document_id: String,
    pub title: String,
    pub mime_type: String,
    pub blob_hash: Option<String>,
    pub remote_url: Option<String>,
    pub link_kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ManifestDocument {
    path: String,
    content_hash: String,
    #[serde(default)]
    rendered_hash: String,
    exported_hash: String,
    modified_at: Option<i64>,
    #[serde(default)]
    raw_document_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ManifestAttachment {
    path: String,
    source_hash: String,
    exported_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ExportManifest {
    version: u32,
    source_library_id: String,
    source_library_name: String,
    documents: HashMap<String, ManifestDocument>,
    attachments: HashMap<String, ManifestAttachment>,
    generated_at: Option<i64>,
}

impl Default for ExportManifest {
    fn default() -> Self {
        Self {
            version: MANIFEST_VERSION,
            source_library_id: String::new(),
            source_library_name: String::new(),
            documents: HashMap::new(),
            attachments: HashMap::new(),
            generated_at: None,
        }
    }
}

pub(crate) fn sanitize_component(value: &str, fallback: &str) -> String {
    let mut result = value
        .trim()
        .chars()
        .map(|character| match character {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '\0'..='\x1f' => '_',
            _ => character,
        })
        .collect::<String>();
    while result.ends_with([' ', '.']) {
        result.pop();
    }
    if result.is_empty() {
        result = fallback.to_string();
    }
    let stem = result
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    if matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    ) {
        result.insert(0, '_');
    }
    result.chars().take(120).collect()
}

fn sanitize_relative_folder(value: &str) -> PathBuf {
    let mut result = PathBuf::new();
    for component in Path::new(value).components() {
        if let Component::Normal(value) = component {
            let value = sanitize_component(&value.to_string_lossy(), "未命名文件夹");
            if value != "." && value != ".." && value != "未分类" {
                result.push(value);
            }
        }
    }
    result
}

fn daily_note_date(title: &str) -> Option<NaiveDate> {
    let title = title.trim();
    ["%Y-%m-%d", "%Y.%m.%d", "%Y/%m/%d", "%Y年%m月%d日"]
        .into_iter()
        .find_map(|format| NaiveDate::parse_from_str(title, format).ok())
}

fn short_id(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    format!("{digest:x}")[..10].to_string()
}

fn allocate_document_paths(
    documents: &[ExportDocument],
    export_daily_notes: bool,
) -> HashMap<String, PathBuf> {
    let mut paths = HashMap::new();
    let mut used = HashSet::new();
    for document in documents {
        let mut relative = if export_daily_notes {
            daily_note_date(&document.title).map(|date| {
                PathBuf::from("日记")
                    .join(date.format("%Y").to_string())
                    .join(date.format("%m").to_string())
                    .join(format!("{}.md", date.format("%Y-%m-%d")))
            })
        } else {
            None
        }
        .unwrap_or_else(|| {
            sanitize_relative_folder(&document.folder_path).join(format!(
                "{}.md",
                sanitize_component(&document.title, "未命名页面")
            ))
        });
        let normalized = relative.to_string_lossy().to_ascii_lowercase();
        if !used.insert(normalized) {
            let stem = relative
                .file_stem()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_else(|| "未命名页面".to_string());
            relative.set_file_name(format!("{stem} - {}.md", short_id(&document.id)));
            used.insert(relative.to_string_lossy().to_ascii_lowercase());
        }
        paths.insert(document.id.clone(), relative);
    }
    paths
}

fn extension_for_attachment(attachment: &ExportAttachment) -> String {
    // Generic Craft names need a MIME type inferred from the original bytes.
    if let Some(extension) = extension_for_mime(&attachment.mime_type) {
        return extension.to_string();
    }
    let title_extension = Path::new(&attachment.title)
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty() && value.len() <= 12 && *value != "bin");
    if let Some(extension) = title_extension {
        return extension.to_ascii_lowercase();
    }
    if let Some(extension) = attachment
        .remote_url
        .as_deref()
        .and_then(|value| Url::parse(value).ok())
        .and_then(|url| {
            Path::new(url.path())
                .extension()
                .and_then(|value| value.to_str())
                .map(str::to_string)
        })
        .filter(|value| !value.is_empty() && value.len() <= 12)
    {
        return extension.to_ascii_lowercase();
    }
    if attachment.mime_type == "application/zip" {
        "zip".to_string()
    } else {
        "bin".to_string()
    }
}

pub(crate) fn extension_for_mime(mime: &str) -> Option<&'static str> {
    Some(match mime.split(';').next().unwrap_or_default().trim() {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "image/tiff" => "tiff",
        "image/heic" => "heic",
        "image/avif" => "avif",
        "image/svg+xml" => "svg",
        "application/pdf" => "pdf",
        "video/quicktime" => "mov",
        "video/webm" => "webm",
        "video/mp4" => "mp4",
        "video/x-matroska" => "mkv",
        "audio/mpeg" => "mp3",
        "audio/mp4" => "m4a",
        "audio/ogg" => "ogg",
        "audio/flac" => "flac",
        "audio/x-wav" | "audio/wav" => "wav",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => "docx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => "xlsx",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" => "pptx",
        // ZIP bytes alone cannot reliably distinguish ZIP from Office documents.
        _ => return None,
    })
}

pub(crate) fn original_mime(path: &Path) -> Result<Option<String>, String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut header = vec![0; 8192];
    let count = file.read(&mut header).map_err(|e| e.to_string())?;
    header.truncate(count);
    if header.starts_with(b"PK\x03\x04") {
        return Ok(Some(zip_original_mime(&mut file)));
    }
    Ok(infer::get(&header).map(|kind| kind.mime_type().to_string()))
}

// Office files share ZIP magic bytes. The central directory identifies their
// actual package; guessing from the first few local headers can mislabel them.
fn zip_original_mime(file: &mut fs::File) -> String {
    let mut identify = || -> Option<&'static str> {
        let size = file.metadata().ok()?.len();
        let tail_length = size.min(65557);
        file.seek(SeekFrom::End(-(tail_length as i64))).ok()?;
        let mut tail = vec![0; tail_length as usize];
        file.read_exact(&mut tail).ok()?;
        let end = tail.windows(4).rposition(|p| p == b"PK\x05\x06")?;
        let end = tail.get(end..)?;
        if end.len() < 22 {
            return None;
        }
        let u32_at = |at| u32::from_le_bytes(end[at..at + 4].try_into().unwrap());
        let length = u32_at(12) as u64;
        let offset = u32_at(16) as u64;
        if length > 32 * 1024 * 1024 || offset.checked_add(length)? > size {
            return None;
        }
        file.seek(SeekFrom::Start(offset)).ok()?;
        let mut directory = vec![0; length as usize];
        file.read_exact(&mut directory).ok()?;
        let mut position = 0;
        let mut office = std::collections::HashSet::new();
        while position < directory.len() {
            let entry = directory.get(position..)?;
            if entry.len() < 46 || &entry[..4] != b"PK\x01\x02" {
                return None;
            }
            let u16_at = |at| u16::from_le_bytes(entry[at..at + 2].try_into().unwrap()) as usize;
            let name_len = u16_at(28);
            let name = entry.get(46..46 + name_len)?;
            match name {
                b"word/document.xml" => {
                    office.insert(
                        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    );
                }
                b"xl/workbook.xml" => {
                    office.insert(
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    );
                }
                b"ppt/presentation.xml" => {
                    office.insert(
                        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                    );
                }
                _ => {}
            }
            position = position.checked_add(46 + name_len + u16_at(30) + u16_at(32))?;
            if position > directory.len() {
                return None;
            }
        }
        (office.len() == 1).then(|| *office.iter().next().unwrap())
    };
    identify().unwrap_or("application/zip").to_string()
}

fn attachment_enabled(attachment: &ExportAttachment, options: &CraftVaultExportOptions) -> bool {
    let image = attachment.mime_type.starts_with("image/") || attachment.link_kind == "image";
    let video = attachment.mime_type.starts_with("video/") || attachment.link_kind == "video";
    if image {
        options.include_images
    } else if video {
        options.include_videos
    } else {
        options.include_other_attachments
    }
}

fn allocate_attachment_paths(
    attachments: &[ExportAttachment],
    documents: &[ExportDocument],
    document_paths: &HashMap<String, PathBuf>,
    options: &CraftVaultExportOptions,
) -> HashMap<String, PathBuf> {
    let mut paths = HashMap::new();
    let mut used = HashSet::new();
    for attachment in attachments {
        if !attachment_enabled(attachment, options) {
            continue;
        }
        let owner_id = attachment_owner_id(attachment, documents, document_paths);
        if owner_id.and_then(|id| document_paths.get(id)).is_none() {
            continue;
        }
        let extension = extension_for_attachment(attachment);
        let original_stem = Path::new(&attachment.title)
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("附件");
        let stem = sanitize_component(original_stem, "附件");
        let id_suffix = short_id(&attachment.id);
        let mut attempt = 0_u32;
        let relative = loop {
            let file_name = match attempt {
                0 => format!("{stem}.{extension}"),
                1 => format!("{stem} - {id_suffix}.{extension}"),
                value => format!("{stem} - {id_suffix}-{value}.{extension}"),
            };
            let candidate = PathBuf::from("attachments").join(file_name);
            if used.insert(candidate.to_string_lossy().to_ascii_lowercase()) {
                break candidate;
            }
            attempt += 1;
        };
        paths.insert(attachment.id.clone(), relative);
    }
    paths
}

fn attachment_owner_id<'a>(
    attachment: &ExportAttachment,
    documents: &'a [ExportDocument],
    document_paths: &HashMap<String, PathBuf>,
) -> Option<&'a String> {
    if document_paths.contains_key(&attachment.document_id) {
        return documents
            .iter()
            .find(|document| document.id == attachment.document_id)
            .map(|document| &document.id);
    }
    documents
        .iter()
        .find(|document| document.markdown.contains(&attachment.document_id))
        .map(|document| &document.id)
}

fn path_for_markdown(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn relative_link(from_document: &Path, target: &Path) -> String {
    let from = from_document.parent().unwrap_or_else(|| Path::new(""));
    let from_components = from.components().collect::<Vec<_>>();
    let target_components = target.components().collect::<Vec<_>>();
    let common = from_components
        .iter()
        .zip(&target_components)
        .take_while(|(left, right)| left == right)
        .count();
    let mut result = PathBuf::new();
    for _ in common..from_components.len() {
        result.push("..");
    }
    for component in target_components.into_iter().skip(common) {
        result.push(component.as_os_str());
    }
    path_for_markdown(&result)
}

fn markdown_link_destination(from_document: &Path, target: &Path) -> String {
    utf8_percent_encode(
        &relative_link(from_document, target),
        MARKDOWN_PATH_ENCODE_SET,
    )
    .to_string()
}

fn rewrite_attachment_urls(
    markdown: &str,
    document_path: &Path,
    document_attachments: &[&ExportAttachment],
    attachment_paths: &HashMap<String, PathBuf>,
) -> String {
    let mut result = markdown.to_string();
    for attachment in document_attachments {
        let (Some(remote_url), Some(target)) = (
            attachment.remote_url.as_deref(),
            attachment_paths.get(&attachment.id),
        ) else {
            continue;
        };
        result = result.replace(
            remote_url,
            &markdown_link_destination(document_path, target),
        );
    }
    result
}

fn rewrite_local_attachment_references(
    markdown: &str,
    document_path: &Path,
    document_attachments: &[&ExportAttachment],
    attachment_paths: &HashMap<String, PathBuf>,
) -> String {
    let candidates = document_attachments
        .iter()
        .map(|attachment| (*attachment, attachment_paths.get(&attachment.id)))
        .collect::<Vec<_>>();
    let mut used = HashSet::new();
    let mut result = String::with_capacity(markdown.len());
    let mut cursor = 0;
    while let Some(relative_start) = markdown[cursor..].find("(attachments/") {
        let start = cursor + relative_start;
        let path_start = start + 1;
        let Some(relative_end) = markdown[path_start..].find(')') else {
            break;
        };
        let end = path_start + relative_end;
        let original = &markdown[path_start..end];
        let original_extension = Path::new(original)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        let image_reference = markdown[..start].rfind('[').is_some_and(|label_open| {
            label_open > 0 && markdown.as_bytes()[label_open - 1] == b'!'
        });
        let decoded = percent_encoding::percent_decode_str(original).decode_utf8_lossy();
        let filename = Path::new(decoded.as_ref())
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or_default();
        let matches = candidates
            .iter()
            .filter(|(attachment, path)| {
                if used.contains(&attachment.id) {
                    return false;
                }
                let target_extension = path
                    .and_then(|path| path.extension())
                    .and_then(|value| value.to_str())
                    .map(str::to_string)
                    .unwrap_or_else(|| extension_for_attachment(attachment));
                let target_is_image =
                    attachment.mime_type.starts_with("image/") || attachment.link_kind == "image";
                let known_name = Path::new(&attachment.title)
                    .file_name()
                    .and_then(|v| v.to_str())
                    .unwrap_or_default();
                let planned_name = path
                    .and_then(|p| p.file_name())
                    .and_then(|v| v.to_str())
                    .unwrap_or_default();
                let identity_matches = filename.eq_ignore_ascii_case(known_name)
                    || (!planned_name.is_empty() && filename.eq_ignore_ascii_case(planned_name))
                    || (attachment.id.len() >= 8
                        && filename
                            .to_lowercase()
                            .contains(&attachment.id.to_lowercase()));
                identity_matches
                    && target_is_image == image_reference
                    && (original_extension.is_empty()
                        || original_extension.eq_ignore_ascii_case(&target_extension))
            })
            .collect::<Vec<_>>();
        let candidate = (matches.len() == 1).then(|| matches[0]);
        result.push_str(&markdown[cursor..path_start]);
        if let Some((attachment, target)) = candidate {
            used.insert(attachment.id.clone());
            if let Some(target) = target {
                result.push_str(&markdown_link_destination(document_path, target));
            } else if let Some(remote_url) = &attachment.remote_url {
                result.push_str(remote_url);
            } else {
                result.push_str(original);
            }
        } else {
            result.push_str(original);
        }
        result.push(')');
        cursor = end + 1;
    }
    result.push_str(&markdown[cursor..]);
    result
}

fn mark_unavailable_attachments(
    markdown: &str,
    attachments: &[&ExportAttachment],
    available: &HashMap<String, PathBuf>,
) -> String {
    use pulldown_cmark::{Event, Parser, Tag};
    let missing = attachments
        .iter()
        .filter(|a| !available.contains_key(&a.id))
        .collect::<Vec<_>>();
    let mut positions = Vec::new();
    for (event, range) in Parser::new(markdown).into_offset_iter() {
        if let Event::Start(Tag::Link { dest_url, .. } | Tag::Image { dest_url, .. }) = event {
            if missing
                .iter()
                .any(|a| a.remote_url.as_deref() == Some(dest_url.as_ref()))
            {
                positions.push(range.end);
            }
        }
    }
    positions.sort_unstable();
    positions.dedup();
    let mut body = markdown.to_string();
    for end in positions.iter().rev() {
        body.insert_str(
            *end,
            " <small>（附件未保存本地原件，离线不可用；原地址保留）</small>",
        );
    }
    if !missing.is_empty() && positions.is_empty() {
        body.push_str("\n\n> [!warning] 附件有缺项\n> 本页关联的部分原件未通过保存校验，离线不可用；请查看阅读导出报告。\n");
    }
    body
}

fn clean_craft_markdown(markdown: &str) -> String {
    let markdown = markdown
        .replace("\\r\\n", "\n")
        .replace("\\n", "\n")
        .replace("\\t", "\t");
    let mut cleaned = String::with_capacity(markdown.len());
    let mut previous_blank = false;
    let mut content_indents = Vec::new();
    for raw_line in markdown.lines() {
        if raw_line.trim_start().starts_with("Next page: blocks get ") {
            continue;
        }
        if raw_line.trim() == "<content>" {
            content_indents.push(raw_line.len() - raw_line.trim_start().len() + 2);
        }
        if raw_line.trim() == "</content>" {
            content_indents.pop();
        }
        let mut line = String::with_capacity(raw_line.len());
        let mut inside_tag = false;
        for character in raw_line.chars() {
            if character == '<' {
                inside_tag = true;
                continue;
            }
            if inside_tag {
                if character == '>' {
                    inside_tag = false;
                }
                continue;
            }
            line.push(character);
        }
        let line = if raw_line.trim_start().starts_with('<') {
            line.trim().to_string()
        } else {
            let indent = content_indents.last().copied().unwrap_or(0);
            let spaces = line.len() - line.trim_start_matches(' ').len();
            line[spaces.min(indent)..].trim_end().to_string()
        };
        if line.is_empty() {
            if previous_blank {
                continue;
            }
            previous_blank = true;
            cleaned.push('\n');
        } else {
            previous_blank = false;
            cleaned.push_str(&line);
            cleaned.push('\n');
        }
    }
    normalize_markdown_tables(cleaned.trim())
}

fn markdown_table_row(line: &str) -> bool {
    let line = line.trim();
    line.starts_with('|') && line.ends_with('|') && line.matches('|').count() >= 2
}

fn markdown_table_separator(line: &str) -> bool {
    markdown_table_row(line)
        && line.trim_matches('|').split('|').all(|cell| {
            let cell = cell.trim().trim_matches(':');
            cell.len() >= 3 && cell.bytes().all(|byte| byte == b'-')
        })
}

fn normalize_markdown_tables(markdown: &str) -> String {
    let lines = markdown
        .lines()
        .map(|line| {
            let trimmed = line.trim();
            if trimmed.starts_with("- |") && trimmed.ends_with('|') {
                trimmed[2..].to_string()
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>();
    let mut compact = Vec::with_capacity(lines.len());
    for (index, line) in lines.iter().enumerate() {
        if line.trim().is_empty() {
            let previous_is_table = compact
                .last()
                .is_some_and(|line: &String| markdown_table_row(line));
            let next_is_table = lines[index + 1..]
                .iter()
                .find(|line| !line.trim().is_empty())
                .is_some_and(|line| markdown_table_row(line));
            if previous_is_table && next_is_table {
                continue;
            }
        }
        compact.push(line.clone());
    }
    let mut result = Vec::with_capacity(compact.len());
    let mut index = 0;
    while index < compact.len() {
        if markdown_table_row(&compact[index]) {
            let start = index;
            while index < compact.len() && markdown_table_row(&compact[index]) {
                index += 1;
            }
            let rows = &compact[start..index];
            result.push(rows[0].clone());
            if rows.len() >= 2 && !markdown_table_separator(&rows[1]) {
                let columns = rows[0].trim().matches('|').count().saturating_sub(1).max(1);
                result.push(format!("| {} |", vec!["---"; columns].join(" | ")));
            }
            result.extend(rows.iter().skip(1).cloned());
        } else {
            result.push(compact[index].clone());
            index += 1;
        }
    }
    result.join("\n").trim().to_string()
}

fn collect_block_references(markdown: &str, targets: &mut HashSet<String>) {
    for suffix in markdown.split("#^").skip(1) {
        let id: String = suffix
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '-')
            .collect();
        if !id.is_empty() {
            targets.insert(id.to_ascii_lowercase());
        }
    }
}

fn collect_vault_block_references(
    root: &Path,
    targets: &mut HashSet<String>,
) -> Result<(), String> {
    for entry in fs::read_dir(root).map_err(|e| format!("无法检查本地段落链接：{e}"))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        // Never follow symlinks or scan internal archives / attachment storage.
        if kind.is_dir()
            && !entry.file_name().to_string_lossy().starts_with('.')
            && entry.file_name() != "assets"
        {
            collect_vault_block_references(&entry.path(), targets)?;
        } else if kind.is_file() && entry.path().extension().is_some_and(|e| e == "md") {
            let text = fs::read_to_string(entry.path())
                .map_err(|e| format!("无法检查本地段落链接：{e}"))?;
            collect_block_references(&text, targets);
        }
    }
    Ok(())
}

fn anchor_blocks(
    markdown: &str,
    blocks: &[(String, String)],
    referenced: &HashSet<String>,
) -> String {
    let mut offsets: HashMap<String, usize> = HashMap::new();
    let mut anchors = Vec::new();
    for (id, text) in blocks {
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            continue;
        }
        let text = clean_craft_markdown(text);
        let cursor = offsets.entry(text.clone()).or_default();
        let end = if text.is_empty() {
            None
        } else {
            markdown[*cursor..]
                .find(&text)
                .map(|start| *cursor + start + text.len())
        };
        if let Some(end) = end {
            *cursor = end;
        }
        let id = id.to_ascii_lowercase();
        if referenced.contains(&id) {
            anchors.push((end.unwrap_or(markdown.len()), format!("\n\n^{id}\n")));
        }
    }
    let mut result = markdown.to_string();
    anchors.sort_by_key(|(offset, _)| std::cmp::Reverse(*offset));
    for (offset, marker) in anchors {
        result.insert_str(offset, &marker);
    }
    result
}

fn rewrite_craft_links(
    markdown: &str,
    document_path: &Path,
    document_paths: &HashMap<String, PathBuf>,
    aliases: &HashMap<String, String>,
) -> String {
    let mut result = String::with_capacity(markdown.len());
    let mut cursor = 0;
    while let Some(relative_open) = markdown[cursor..].find("](") {
        let open = cursor + relative_open;
        let url_start = open + 2;
        let Some(relative_close) = markdown[url_start..].find(')') else {
            break;
        };
        let close = url_start + relative_close;
        let url_text = &markdown[url_start..close];
        let target = Url::parse(url_text)
            .ok()
            .filter(|url| {
                url.scheme() == "craftdocs"
                    || (url.scheme() == "https"
                        && url
                            .host_str()
                            .is_some_and(|h| h == "craft.do" || h.ends_with(".craft.do")))
            })
            .and_then(|url| {
                let mut ids = url
                    .query_pairs()
                    .filter(|(k, _)| k == "blockId")
                    .map(|(_, v)| v.into_owned())
                    .collect::<Vec<_>>();
                ids.extend(
                    url.query_pairs()
                        .filter(|(k, _)| k == "documentId")
                        .map(|(_, v)| v.into_owned()),
                );
                if let Some(paths) = url.path_segments() {
                    ids.extend(paths.rev().map(str::to_string));
                }
                ids.into_iter().find_map(|id| {
                    let alias = aliases
                        .iter()
                        .find(|(key, _)| key.eq_ignore_ascii_case(&id))
                        .map(|(_, v)| v.clone());
                    alias.or_else(|| {
                        document_paths
                            .keys()
                            .find(|key| key.eq_ignore_ascii_case(&id))
                            .cloned()
                    })
                })
            });
        let resolved = target.as_deref().and_then(|value| {
            let (id, anchor) = value
                .split_once("#^")
                .map(|(id, a)| (id, Some(a)))
                .unwrap_or((value, None));
            document_paths.get(id).map(|path| (path, anchor))
        });
        let label_open = markdown[cursor..open]
            .rfind('[')
            .map(|index| cursor + index);
        if let (Some((target, anchor)), Some(label_open)) = (resolved, label_open) {
            if label_open > 0 && markdown.as_bytes()[label_open - 1] == b'!' {
                result.push_str(&markdown[cursor..=close]);
                cursor = close + 1;
                continue;
            }
            let label = &markdown[label_open + 1..open];
            let mut link = relative_link(document_path, target);
            if link.ends_with(".md") {
                link.truncate(link.len() - 3);
            }
            if let Some(anchor) = anchor {
                link.push_str("#^");
                link.push_str(anchor);
            }
            result.push_str(&markdown[cursor..label_open]);
            result.push_str("[[");
            result.push_str(&link);
            if !label.is_empty() {
                result.push('|');
                result.push_str(label);
            }
            result.push_str("]]");
        } else {
            result.push_str(&markdown[cursor..=close]);
        }
        cursor = close + 1;
    }
    result.push_str(&markdown[cursor..]);
    result
}

fn frontmatter(document: &ExportDocument, library_name: &str, daily: Option<NaiveDate>) -> String {
    let library = serde_json::to_string(library_name).unwrap_or_else(|_| "\"\"".to_string());
    // Stable IDs remain in the export manifest; avoid exposing machine fields
    // and a duplicate title in Obsidian's reading properties.
    let mut result = format!("---\nsource: Craft\ncraft_space: {library}\n");
    if let Some(date) = document
        .modified_at
        .and_then(|t| chrono::DateTime::from_timestamp(t, 0))
    {
        result.push_str(&format!("modified: {}\n", date.to_rfc3339()));
    }
    if let Some(date) = daily {
        result.push_str(&format!(
            "date: {}\ntype: daily-note\n",
            date.format("%Y-%m-%d")
        ));
    }
    result.push_str("---\n\n");
    result
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path)
        .map_err(|error| format!("无法读取导出文件 {}：{error}", path.display()))?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)
        .map_err(|error| format!("无法校验导出文件 {}：{error}", path.display()))?;
    Ok(format!("{:x}", hasher.finalize()))
}

fn write_text_with_conflict_protection(
    target: &Path,
    content: &str,
    previous: Option<&ManifestDocument>,
) -> Result<(PathBuf, String, bool), String> {
    let mut actual_target = target.to_path_buf();
    let mut conflict = false;
    if target.is_file() {
        let current_hash = sha256_file(target)?;
        if previous.is_none_or(|entry| entry.exported_hash != current_hash) {
            conflict = true;
            let stem = target
                .file_stem()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_else(|| "Craft 更新".to_string());
            actual_target.set_file_name(format!("{stem} - Craft 更新.md"));
            let mut suffix = 2;
            while actual_target.exists() {
                actual_target.set_file_name(format!("{stem} - Craft 更新 {suffix}.md"));
                suffix += 1;
            }
        }
    }
    if let Some(parent) = actual_target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建导出页面目录 {}：{error}", parent.display()))?;
    }
    fs::write(&actual_target, content)
        .map_err(|error| format!("无法写入导出页面 {}：{error}", actual_target.display()))?;
    let hash = format!("{:x}", Sha256::digest(content.as_bytes()));
    Ok((actual_target, hash, conflict))
}

fn load_manifest(root: &Path) -> ExportManifest {
    fs::read(root.join(".hub-export").join("manifest.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write_json_file(path: &Path, value: &impl Serialize) -> Result<(), String> {
    crate::craft_backup::reject_links(path)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建导出配置目录 {}：{error}", parent.display()))?;
    }
    let bytes =
        serde_json::to_vec_pretty(value).map_err(|error| format!("无法生成导出配置：{error}"))?;
    fs::write(path, bytes).map_err(|error| format!("无法写入导出配置 {}：{error}", path.display()))
}

fn merge_json_object_file(path: &Path, defaults: Value) -> Result<(), String> {
    crate::craft_backup::reject_links(path)?;
    let mut current = if path.exists() {
        serde_json::from_slice::<Value>(&fs::read(path).map_err(|e| e.to_string())?).map_err(
            |_| {
                format!(
                    "Obsidian 配置 {} 无法解析，未覆盖；请先修复或另存为",
                    path.display()
                )
            },
        )?
    } else {
        serde_json::json!({})
    };
    let Some(current_object) = current.as_object_mut() else {
        return Ok(());
    };
    let mut changed = !path.exists();
    if let Some(defaults) = defaults.as_object() {
        for (key, value) in defaults {
            if !current_object.contains_key(key) {
                current_object.insert(key.clone(), value.clone());
                changed = true;
            }
        }
    }
    if !changed {
        return Ok(());
    }
    write_json_file(path, &current)
}

async fn export_attachment(
    blob_store: &BlobStore,
    attachment: &ExportAttachment,
    target: &Path,
) -> Result<String, String> {
    crate::craft_backup::reject_links(target)?;
    let hash = attachment
        .blob_hash
        .as_ref()
        .ok_or("附件原件尚未完整备份")?;
    let source = blob_store.path_for(hash)?;
    crate::craft_backup::validate_original_content(&source, true)?;
    if fs::metadata(&source).map_err(|e| e.to_string())?.len() == 0 {
        return Err("附件原件为 0 字节，未导出空占位文件".into());
    }
    if sha256_file(&source)? != *hash {
        return Err("附件原件校验失败".into());
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::copy(source, target).map_err(|e| e.to_string())?;
    if sha256_file(target)? != *hash {
        return Err("导出的附件校验失败".into());
    }
    Ok(hash.clone())
}

fn emit_progress(app: Option<&AppHandle>, progress: CraftVaultExportProgress) {
    if let Some(app) = app {
        let _ = app.emit("craft-vault-export-progress", progress);
    }
}

pub async fn export_craft_vault(
    app: Option<&AppHandle>,
    library_name: String,
    documents: Vec<ExportDocument>,
    mut attachments: Vec<ExportAttachment>,
    blob_store: &BlobStore,
    options: CraftVaultExportOptions,
) -> Result<CraftVaultExportSummary, String> {
    let destination_parent = PathBuf::from(options.destination.trim());
    if destination_parent.as_os_str().is_empty() {
        return Err("请选择 Vault 的保存位置".to_string());
    }
    let creates_child_vault = options.vault_name.is_some();
    let requested_vault_name = options
        .vault_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&library_name);
    let vault_name = sanitize_component(requested_vault_name, "Craft Vault");
    let destination = if creates_child_vault {
        destination_parent.join(&vault_name)
    } else {
        destination_parent
    };
    crate::craft_backup::reject_links(&destination)?;
    fs::create_dir_all(&destination)
        .map_err(|error| format!("无法创建 Vault 目录 {}：{error}", destination.display()))?;
    let destination = destination
        .canonicalize()
        .map_err(|error| format!("无法确认 Vault 目录：{error}"))?;
    if destination.parent().is_none() {
        return Err("不能把磁盘根目录直接作为 Vault".to_string());
    }
    emit_progress(
        app,
        CraftVaultExportProgress {
            library_id: options.library_id.clone(),
            phase: "preparing".to_string(),
            completed: 0,
            total: documents.len() + attachments.len(),
            current: format!("正在准备 {vault_name}"),
        },
    );

    let previous_manifest = load_manifest(&destination);
    let manifest_needs_rewrite = previous_manifest.version != MANIFEST_VERSION;
    if !previous_manifest.source_library_id.is_empty()
        && previous_manifest.source_library_id != options.library_id
    {
        return Err("该目录已经是另一个 Craft 资料库的导出库，请选择其他目录".to_string());
    }
    for entry in previous_manifest
        .documents
        .values()
        .map(|e| &e.path)
        .chain(previous_manifest.attachments.values().map(|e| &e.path))
    {
        if Path::new(entry)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        {
            return Err("Vault 导出清单包含不安全的文件路径".into());
        }
        crate::craft_backup::reject_links(&destination.join(entry))?;
    }
    let mut document_paths = allocate_document_paths(&documents, options.export_daily_notes);
    // Allocate final paths before rendering links, including locally edited
    // pages. A rename or conflict must not leave links pointing at old paths.
    let mut planned_conflicts = 0;
    for document in &documents {
        let previous = previous_manifest.documents.get(&document.id);
        let managed = previous.filter(|entry| {
            sha256_file(&destination.join(&entry.path))
                .is_ok_and(|hash| hash == entry.exported_hash)
        });
        if let Some(entry) = managed {
            document_paths.insert(document.id.clone(), PathBuf::from(&entry.path));
        } else if let Some(relative) = document_paths.get_mut(&document.id) {
            let target = destination.join(&*relative);
            crate::craft_backup::reject_links(&target)?;
            if target.exists() {
                planned_conflicts += 1;
                let stem = relative.file_stem().unwrap().to_string_lossy().into_owned();
                let mut suffix = 1;
                loop {
                    relative.set_file_name(format!("{stem} - Craft 更新 {suffix}.md"));
                    if !destination.join(&*relative).exists() {
                        break;
                    }
                    suffix += 1;
                }
            }
        }
    }
    for attachment in &mut attachments {
        if let Some(hash) = &attachment.blob_hash {
            if let Ok(path) = blob_store.path_for(hash) {
                if let Ok(Some(mime)) = original_mime(&path) {
                    attachment.mime_type = mime;
                }
            }
        }
    }
    let attachment_paths =
        allocate_attachment_paths(&attachments, &documents, &document_paths, &options);
    let mut raw_document_ids = documents
        .iter()
        .filter_map(|document| {
            document
                .raw_document_id
                .as_ref()
                .map(|raw_id| (raw_id.clone(), document.id.clone()))
        })
        .collect::<HashMap<_, _>>();
    for document in &documents {
        for (id, _) in &document.block_markdown {
            raw_document_ids.insert(
                id.clone(),
                format!("{}#^{}", document.id, id.to_ascii_lowercase()),
            );
        }
    }
    let mut attachments_by_document = HashMap::<String, Vec<&ExportAttachment>>::new();
    for attachment in &attachments {
        if let Some(owner_id) = attachment_owner_id(attachment, &documents, &document_paths) {
            attachments_by_document
                .entry(owner_id.clone())
                .or_default()
                .push(attachment);
        }
    }
    let mut manifest = ExportManifest {
        version: MANIFEST_VERSION,
        source_library_id: options.library_id.clone(),
        source_library_name: library_name.clone(),
        documents: previous_manifest.documents.clone(),
        attachments: if manifest_needs_rewrite {
            HashMap::new()
        } else {
            previous_manifest.attachments.clone()
        },
        generated_at: Some(chrono::Utc::now().timestamp()),
    };
    let mut summary = CraftVaultExportSummary {
        destination: destination.to_string_lossy().to_string(),
        vault_name: vault_name.clone(),
        exported_documents: 0,
        skipped_documents: 0,
        exported_attachments: 0,
        skipped_attachments: 0,
        conflicts: planned_conflicts,
        failed_attachments: 0,
        backup_root: String::new(),
        snapshot_id: String::new(),
        backup_complete: false,
        issues: Vec::new(),
        replica_path: None,
        external_references: 0,
    };

    // Export attachments first. Markdown is generated afterwards and only
    // points at files that were actually exported (or preserved locally).
    let selected_attachments = attachments
        .iter()
        .filter(|attachment| attachment_paths.contains_key(&attachment.id))
        .collect::<Vec<_>>();
    let mut available_attachment_paths = HashMap::<String, PathBuf>::new();
    for (index, attachment) in selected_attachments.iter().enumerate() {
        let planned_relative = attachment_paths
            .get(&attachment.id)
            .ok_or_else(|| "无法分配 Craft 附件导出路径".to_string())?;
        let source_hash = attachment
            .blob_hash
            .clone()
            .or_else(|| attachment.remote_url.clone())
            .unwrap_or_default();
        let previous = if manifest_needs_rewrite {
            None
        } else {
            previous_manifest.attachments.get(&attachment.id)
        };
        let previous_relative = previous.map(|entry| PathBuf::from(&entry.path));
        let previous_target = previous_relative
            .as_ref()
            .map(|relative| destination.join(relative));
        if !manifest_needs_rewrite
            && attachment.blob_hash.as_ref().is_some_and(|hash| {
                blob_store.path_for(hash).is_ok_and(|path| {
                    crate::craft_backup::validate_original_content(&path, true).is_ok()
                })
            })
            && previous.is_some_and(|entry| {
                entry.source_hash == source_hash
                    && Path::new(&entry.path).extension() == planned_relative.extension()
                    && previous_target.as_ref().is_some_and(|path| {
                        fs::metadata(path).is_ok_and(|meta| meta.len() > 0)
                            && sha256_file(path).is_ok_and(|hash| hash == entry.exported_hash)
                    })
            })
        {
            summary.skipped_attachments += 1;
            if let Some(relative) = previous_relative {
                available_attachment_paths.insert(attachment.id.clone(), relative);
            }
            continue;
        }
        let managed_previous_target = previous_target.filter(|path| {
            path.is_file()
                && previous.is_some_and(|entry| {
                    sha256_file(path).is_ok_and(|hash| hash == entry.exported_hash)
                })
        });
        let mut actual_relative = managed_previous_target
            .as_ref()
            .and_then(|path| path.strip_prefix(&destination).ok())
            .map(Path::to_path_buf)
            .unwrap_or_else(|| planned_relative.clone());
        if managed_previous_target.is_some() {
            if let Some(extension) = planned_relative.extension() {
                actual_relative.set_extension(extension);
            }
        }
        let mut target = destination.join(&actual_relative);
        if target.is_file()
            && managed_previous_target.as_ref() != Some(&target)
            && !sha256_file(&target).is_ok_and(|hash| hash == source_hash)
        {
            summary.conflicts += 1;
            let stem = actual_relative
                .file_stem()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_else(|| "附件".to_string());
            let extension = actual_relative
                .extension()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_else(|| "bin".to_string());
            actual_relative.set_file_name(format!(
                "{stem} - Craft 更新 - {}.{extension}",
                short_id(&attachment.id)
            ));
            target = destination.join(&actual_relative);
            let mut suffix = 2;
            while target.exists() {
                actual_relative.set_file_name(format!("{stem} - Craft 更新 {suffix}.{extension}"));
                target = destination.join(&actual_relative);
                suffix += 1;
            }
        }
        emit_progress(
            app,
            CraftVaultExportProgress {
                library_id: options.library_id.clone(),
                phase: "attachments".to_string(),
                completed: index,
                total: selected_attachments.len() + documents.len(),
                current: attachment.title.clone(),
            },
        );
        match export_attachment(blob_store, attachment, &target).await {
            Ok(exported_hash) => {
                manifest.attachments.insert(
                    attachment.id.clone(),
                    ManifestAttachment {
                        path: path_for_markdown(&actual_relative),
                        source_hash,
                        exported_hash,
                    },
                );
                available_attachment_paths.insert(attachment.id.clone(), actual_relative.clone());
                summary.exported_attachments += 1;
            }
            Err(message) => {
                manifest.attachments.remove(&attachment.id);
                summary.failed_attachments += 1;
                summary.issues.push(crate::craft_backup::BackupIssue {
                    object_id: attachment.id.clone(),
                    category: "vault_attachment".into(),
                    message,
                });
            }
        }
    }

    let mut referenced_blocks = HashSet::new();
    for document in &documents {
        let rewritten = rewrite_craft_links(
            &document.markdown,
            &document_paths[&document.id],
            &document_paths,
            &raw_document_ids,
        );
        collect_block_references(&rewritten, &mut referenced_blocks);
    }
    // Keep targets of user-added links in the existing reading vault, too.
    collect_vault_block_references(&destination, &mut referenced_blocks)?;

    for (index, document) in documents.iter().enumerate() {
        let relative = document_paths
            .get(&document.id)
            .ok_or_else(|| "无法分配 Craft 页面导出路径".to_string())?;
        emit_progress(
            app,
            CraftVaultExportProgress {
                library_id: options.library_id.clone(),
                phase: "documents".to_string(),
                completed: selected_attachments.len() + index,
                total: selected_attachments.len() + documents.len(),
                current: document.title.clone(),
            },
        );
        let daily = options
            .export_daily_notes
            .then(|| daily_note_date(&document.title))
            .flatten();
        let document_attachments = attachments_by_document
            .get(&document.id)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let body = rewrite_attachment_urls(
            &anchor_blocks(
                &clean_craft_markdown(&document.markdown),
                &document.block_markdown,
                &referenced_blocks,
            ),
            relative,
            document_attachments,
            &available_attachment_paths,
        );
        let body = rewrite_local_attachment_references(
            &body,
            relative,
            document_attachments,
            &available_attachment_paths,
        );
        let body = rewrite_craft_links(&body, relative, &document_paths, &raw_document_ids);
        let body =
            mark_unavailable_attachments(&body, document_attachments, &available_attachment_paths);
        if body.contains("](craftdocs://") || body.contains("](https://docs.craft.do/") {
            summary.issues.push(crate::craft_backup::BackupIssue {
                object_id: document.id.clone(),
                category: "vault_link".into(),
                message: format!(
                    "页面「{}」含未纳入本空间的 Craft 链接，已保留原始地址，尚未全部本地化",
                    document.title
                ),
            });
        }
        let content = format!("{}{}", frontmatter(document, &library_name, daily), body);
        let rendered_hash = format!("{:x}", Sha256::digest(content.as_bytes()));
        let previous = previous_manifest.documents.get(&document.id);
        let previous_target = previous.map(|entry| destination.join(&entry.path));
        if !manifest_needs_rewrite
            && previous.is_some_and(|entry| {
                entry.content_hash == document.content_hash
                    && entry.rendered_hash == rendered_hash
                    && previous_target.as_ref().is_some_and(|path| {
                        sha256_file(path).is_ok_and(|hash| hash == entry.exported_hash)
                    })
            })
        {
            summary.skipped_documents += 1;
            continue;
        }
        let standard_target = destination.join(relative);
        crate::craft_backup::reject_links(&standard_target)?;
        let target = previous_target
            .filter(|path| {
                path.is_file()
                    && previous.is_some_and(|entry| {
                        sha256_file(path).is_ok_and(|hash| hash == entry.exported_hash)
                    })
            })
            .unwrap_or(standard_target);
        let (actual_target, exported_hash, conflict) =
            write_text_with_conflict_protection(&target, &content, previous)?;
        if conflict {
            summary.conflicts += 1;
        }
        let actual_relative = actual_target
            .strip_prefix(&destination)
            .unwrap_or(&actual_target);
        manifest.documents.insert(
            document.id.clone(),
            ManifestDocument {
                path: path_for_markdown(actual_relative),
                content_hash: document.content_hash.clone(),
                rendered_hash,
                exported_hash,
                modified_at: document.modified_at,
                raw_document_id: document.raw_document_id.clone(),
            },
        );
        summary.exported_documents += 1;
    }

    if options.create_obsidian_config {
        let new_config = !destination.join(".obsidian/app.json").exists();
        merge_json_object_file(
            &destination.join(".obsidian").join("app.json"),
            if new_config {
                serde_json::json!({ "attachmentFolderPath": "attachments", "showInlineTitle":false })
            } else {
                serde_json::json!({})
            },
        )?;
        if options.export_daily_notes {
            merge_json_object_file(
                &destination.join(".obsidian").join("daily-notes.json"),
                serde_json::json!({
                    "folder": "日记",
                    "format": "YYYY/MM/YYYY-MM-DD"
                }),
            )?;
        }
    }
    write_json_file(
        &destination.join(".hub-export").join("manifest.json"),
        &manifest,
    )?;
    for (id, entry) in &manifest.documents {
        summary.issues.extend(crate::craft_export_audit::audit_page(
            &destination,
            id,
            Path::new(&entry.path),
        )?);
    }
    write_json_file(
        &destination.join(".hub-export/export-report.json"),
        &serde_json::json!({
            "kind":"reading-export-validation", "generatedAt":manifest.generated_at,
            "issues":summary.issues,"failedAttachments":summary.failed_attachments,
            "note":"此报告核对阅读产物，不确认原始备份完整性"
        }),
    )?;
    if !documents.is_empty()
        && (!destination.join(".obsidian").is_dir()
            || !manifest
                .documents
                .values()
                .any(|entry| destination.join(&entry.path).is_file()))
    {
        return Err("Vault 结构校验失败：缺少 Obsidian 配置或 Markdown 页面".to_string());
    }
    emit_progress(
        app,
        CraftVaultExportProgress {
            library_id: options.library_id,
            phase: "completed".to_string(),
            completed: documents.len() + selected_attachments.len(),
            total: documents.len() + selected_attachments.len(),
            current: String::new(),
        },
    );
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_referenced_blocks_are_anchored_and_repeated_text_keeps_its_target() {
        let blocks = vec![
            ("first".into(), "Same".into()),
            ("second".into(), "Same".into()),
            ("unused".into(), "Other".into()),
        ];
        let body = anchor_blocks(
            "Same\n\nSame\n\nOther",
            &blocks,
            &HashSet::from(["second".into()]),
        );
        assert!(body.starts_with("Same\n\nSame\n\n^second"));
        assert!(!body.contains("^first"));
        assert!(!body.contains("^unused"));
        let mut references = HashSet::new();
        collect_block_references(
            "[[Note#^SECOND|label]] [local](Note.md#^third)",
            &mut references,
        );
        assert_eq!(references, HashSet::from(["second".into(), "third".into()]));
    }

    #[test]
    fn office_format_uses_the_zip_directory_instead_of_generic_magic_bytes() {
        use base64::Engine;
        let file = std::env::temp_dir().join(format!("hub-office-{:016x}", rand::random::<u64>()));
        // Valid ZIP made by Python's independent ZIP writer: an irrelevant xl/
        // entry comes first, while the actual package contains word/document.xml.
        let bytes = base64::engine::general_purpose::STANDARD.decode("UEsDBBQAAAAAAOCEO12KRrg7DgAAAA4AAAARAAAAeGwvaXJyZWxldmFudC50eHRub3QgYSB3b3JrYm9va1BLAwQUAAAAAADghDtdX1vRTAsAAAALAAAAEQAAAHdvcmQvZG9jdW1lbnQueG1sPGRvY3VtZW50Lz5QSwECFAAUAAAAAADghDtdika4Ow4AAAAOAAAAEQAAAAAAAAAAAAAAgAEAAAAAeGwvaXJyZWxldmFudC50eHRQSwECFAAUAAAAAADghDtdX1vRTAsAAAALAAAAEQAAAAAAAAAAAAAAgAE9AAAAd29yZC9kb2N1bWVudC54bWxQSwUGAAAAAAIAAgB+AAAAdwAAAAAA").unwrap();
        fs::write(&file, bytes).unwrap();
        assert_eq!(
            original_mime(&file).unwrap().unwrap(),
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        );
        fs::write(&file, b"PK\x03\x04incomplete").unwrap();
        assert_eq!(original_mime(&file).unwrap().unwrap(), "application/zip");
        fs::remove_file(file).unwrap();
    }

    #[test]
    fn original_bytes_determine_format_and_migrate_bin_links_without_overwriting_edits() {
        use base64::Engine;
        let root =
            std::env::temp_dir().join(format!("hub-media-test-{:016x}", rand::random::<u64>()));
        fs::create_dir_all(&root).unwrap();
        let store = BlobStore::open(&root.join("objects")).unwrap();
        let png = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=").unwrap();
        let blob = store.put(&png).unwrap();
        let document = ExportDocument {
            id: "doc".into(),
            title: "Note".into(),
            folder_path: String::new(),
            markdown: "![Image](https://r.craft.do/original)".into(),
            modified_at: None,
            content_hash: "source".into(),
            raw_document_id: None,
            block_markdown: Vec::new(),
        };
        let attachment = ExportAttachment {
            id: "asset".into(),
            document_id: "doc".into(),
            title: "image".into(),
            mime_type: String::new(),
            blob_hash: Some(blob.hash),
            remote_url: Some("https://r.craft.do/original".into()),
            link_kind: "image".into(),
        };
        let options = CraftVaultExportOptions {
            library_id: "space".into(),
            destination: root.to_string_lossy().into(),
            vault_name: Some("Vault".into()),
            include_images: true,
            include_videos: true,
            include_other_attachments: true,
            export_daily_notes: true,
            create_obsidian_config: true,
            backup_interval_minutes: 0,
            replica_destination: None,
        };
        let export = || {
            tauri::async_runtime::block_on(export_craft_vault(
                None,
                "Space".into(),
                vec![document.clone()],
                vec![attachment.clone()],
                &store,
                options.clone(),
            ))
            .unwrap()
        };
        assert_eq!(export().exported_attachments, 1);
        let vault = root.join("Vault");
        let mut manifest = load_manifest(&vault);
        assert_eq!(manifest.attachments["asset"].path, "attachments/image.png");
        // Replay a real prior exporter state with the same saved bytes and hashes.
        fs::rename(
            vault.join("attachments/image.png"),
            vault.join("attachments/image.bin"),
        )
        .unwrap();
        manifest.attachments.get_mut("asset").unwrap().path = "attachments/image.bin".into();
        let note = vault.join("Note.md");
        fs::write(
            &note,
            fs::read_to_string(&note)
                .unwrap()
                .replace("image.png", "image.bin"),
        )
        .unwrap();
        manifest.documents.get_mut("doc").unwrap().exported_hash = sha256_file(&note).unwrap();
        manifest.documents.get_mut("doc").unwrap().rendered_hash = sha256_file(&note).unwrap();
        fs::write(
            vault.join(".hub-export/manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        let migrated = export();
        assert_eq!(migrated.exported_attachments, 1);
        assert!(fs::read_to_string(&note)
            .unwrap()
            .contains("attachments/image.png"));
        assert_eq!(
            load_manifest(&vault).attachments["asset"].path,
            "attachments/image.png"
        );
        fs::write(&note, "my local note").unwrap();
        let conflict = export();
        assert_eq!(conflict.conflicts, 1);
        assert_eq!(fs::read_to_string(&note).unwrap(), "my local note");
        let updated = load_manifest(&vault).documents["doc"].path.clone();
        assert!(fs::read_to_string(vault.join(updated))
            .unwrap()
            .contains("attachments/image.png"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn daily_note_titles_use_obsidian_daily_note_paths() {
        let documents = vec![ExportDocument {
            id: "daily-id".to_string(),
            title: "2026.08.02".to_string(),
            folder_path: "Calendar".to_string(),
            markdown: String::new(),
            modified_at: None,
            content_hash: String::new(),
            raw_document_id: None,
            block_markdown: Vec::new(),
        }];
        assert_eq!(
            allocate_document_paths(&documents, true)["daily-id"],
            PathBuf::from("日记/2026/08/2026-08-02.md")
        );
    }

    #[test]
    fn unsafe_and_duplicate_windows_names_are_sanitized() {
        assert_eq!(sanitize_component("A:B/C*", "fallback"), "A_B_C_");
        assert_eq!(sanitize_component("CON", "fallback"), "_CON");
        assert_eq!(sanitize_component("...", "fallback"), "fallback");
    }

    #[test]
    fn craft_page_links_become_relative_obsidian_markdown_links() {
        let paths = HashMap::from([
            ("one".to_string(), PathBuf::from("Folder/One.md")),
            ("two".to_string(), PathBuf::from("Other/Two.md")),
        ]);
        assert_eq!(
            rewrite_craft_links(
                "See [Two](https://docs.craft.do/editor/d/space/two)",
                &paths["one"],
                &paths,
                &HashMap::new()
            ),
            "See [[../Other/Two|Two]]"
        );
    }

    #[test]
    fn block_links_use_local_anchors_and_external_urls_are_not_rewritten() {
        let paths = HashMap::from([("doc".into(), PathBuf::from("Page.md"))]);
        let aliases = HashMap::from([("BLOCK-ID".into(), "doc#^block-id".into())]);
        assert_eq!(
            rewrite_craft_links(
                "[block](craftdocs://open?blockId=BLOCK-ID)",
                Path::new("Other.md"),
                &paths,
                &aliases
            ),
            "[[Page#^block-id|block]]"
        );
        assert_eq!(
            rewrite_craft_links(
                "[web](https://example.com/doc)",
                Path::new("Other.md"),
                &paths,
                &aliases
            ),
            "[web](https://example.com/doc)"
        );
        assert!(anchor_blocks(
            "A paragraph",
            &[("BLOCK-ID".into(), "A paragraph".into())],
            &HashSet::from(["block-id".into()])
        )
        .contains("^block-id"));
        assert_eq!(
            clean_craft_markdown(
                "<page>\n  <content>\n    - parent\n      - child\n  </content>\n</page>"
            ),
            "- parent\n  - child"
        );
    }

    #[test]
    fn craft_structured_wrappers_and_cursor_lines_are_removed() {
        let source = "<page id=\"a\">\n  <pageTitle>标题</pageTitle>\n  <content>\n    正文\n    <highlight color=\"yellow\">重点</highlight>\n  </content>\n</page>\nNext page: blocks get --id a --depth -1";
        assert_eq!(clean_craft_markdown(source), "标题\n\n正文\n重点");
    }

    #[test]
    fn escaped_table_newlines_become_real_markdown_rows() {
        let source = "| 名称 | 数量 |\\n| --- | --- |\\n| 图片 | 2 |";
        assert_eq!(
            clean_craft_markdown(source),
            "| 名称 | 数量 |\n| --- | --- |\n| 图片 | 2 |"
        );
    }

    #[test]
    fn craft_table_spacing_and_list_prefixes_are_normalized() {
        let source = "- | 名称 | 数量 |\n\n| 图片 | 2 |";
        assert_eq!(
            clean_craft_markdown(source),
            "| 名称 | 数量 |\n| --- | --- |\n| 图片 | 2 |"
        );
    }

    #[test]
    fn nested_page_attachments_are_owned_by_the_exported_root_page() {
        let documents = vec![ExportDocument {
            id: "root-page".to_string(),
            title: "Root".to_string(),
            folder_path: String::new(),
            markdown:
                "<page id=\"nested-page\"><content>![Image](attachments/Image.png)</content></page>"
                    .to_string(),
            modified_at: None,
            content_hash: String::new(),
            raw_document_id: None,
            block_markdown: Vec::new(),
        }];
        let attachment = ExportAttachment {
            id: "nested-image".to_string(),
            document_id: "nested-page".to_string(),
            title: "Image.png".to_string(),
            mime_type: "image/png".to_string(),
            blob_hash: None,
            remote_url: Some("https://r.craft.do/image".to_string()),
            link_kind: "image".to_string(),
        };
        let paths = HashMap::from([("root-page".to_string(), PathBuf::from("Root.md"))]);
        assert_eq!(
            attachment_owner_id(&attachment, &documents, &paths).map(String::as_str),
            Some("root-page")
        );
        assert_eq!(
            allocate_attachment_paths(
                &[attachment],
                &documents,
                &paths,
                &CraftVaultExportOptions {
                    library_id: "space".to_string(),
                    destination: "vault".to_string(),
                    vault_name: None,
                    include_images: true,
                    include_videos: true,
                    include_other_attachments: true,
                    export_daily_notes: true,
                    create_obsidian_config: true,
                    backup_interval_minutes: 0,
                    replica_destination: None,
                }
            )["nested-image"],
            PathBuf::from("attachments/Image.png")
        );
    }

    #[test]
    fn daily_note_attachments_stay_in_the_vault_root_attachment_folder() {
        let documents = vec![ExportDocument {
            id: "daily-page".to_string(),
            title: "2026-08-31".to_string(),
            folder_path: "Calendar".to_string(),
            markdown: "![Image](attachments/Image.png)".to_string(),
            modified_at: None,
            content_hash: String::new(),
            raw_document_id: None,
            block_markdown: Vec::new(),
        }];
        let attachment = ExportAttachment {
            id: "daily-image".to_string(),
            document_id: "daily-page".to_string(),
            title: "Image.png".to_string(),
            mime_type: "image/png".to_string(),
            blob_hash: None,
            remote_url: Some("https://r.craft.do/image".to_string()),
            link_kind: "image".to_string(),
        };
        let document_paths = allocate_document_paths(&documents, true);
        let attachment_paths = allocate_attachment_paths(
            &[attachment],
            &documents,
            &document_paths,
            &CraftVaultExportOptions {
                library_id: "space".to_string(),
                destination: "parent".to_string(),
                vault_name: Some("Space - Craft".to_string()),
                include_images: true,
                include_videos: true,
                include_other_attachments: true,
                export_daily_notes: true,
                create_obsidian_config: true,
                backup_interval_minutes: 0,
                replica_destination: None,
            },
        );
        assert_eq!(
            attachment_paths["daily-image"],
            PathBuf::from("attachments/Image.png")
        );
        assert_eq!(
            relative_link(
                &document_paths["daily-page"],
                &attachment_paths["daily-image"]
            ),
            "../../../attachments/Image.png"
        );
    }

    #[test]
    fn attachment_paths_remain_unique_for_ids_with_the_same_prefix() {
        let documents = vec![ExportDocument {
            id: "page".to_string(),
            title: "Page".to_string(),
            folder_path: String::new(),
            markdown: String::new(),
            modified_at: None,
            content_hash: String::new(),
            raw_document_id: None,
            block_markdown: Vec::new(),
        }];
        let attachments = ["first", "second", "third"]
            .into_iter()
            .map(|suffix| ExportAttachment {
                id: format!("craft_attachment_{suffix}"),
                document_id: "page".to_string(),
                title: "Image.png".to_string(),
                mime_type: "image/png".to_string(),
                blob_hash: None,
                remote_url: None,
                link_kind: "image".to_string(),
            })
            .collect::<Vec<_>>();
        let document_paths = allocate_document_paths(&documents, true);
        let attachment_paths = allocate_attachment_paths(
            &attachments,
            &documents,
            &document_paths,
            &CraftVaultExportOptions {
                library_id: "space".to_string(),
                destination: "parent".to_string(),
                vault_name: None,
                include_images: true,
                include_videos: true,
                include_other_attachments: true,
                export_daily_notes: true,
                create_obsidian_config: true,
                backup_interval_minutes: 0,
                replica_destination: None,
            },
        );
        let unique_paths = attachment_paths.values().collect::<HashSet<_>>();
        assert_eq!(unique_paths.len(), 3);
        assert!(attachment_paths
            .values()
            .all(|path| path.starts_with("attachments") && path.extension().unwrap() == "png"));
    }

    #[test]
    fn markdown_attachment_destinations_encode_spaces_for_obsidian() {
        assert_eq!(
            markdown_link_destination(
                Path::new("日记/2026/08/2026-08-02.md"),
                Path::new("attachments/Image - unique.png"),
            ),
            "../../../attachments/Image%20-%20unique.png"
        );

        let attachment = ExportAttachment {
            id: "image".to_string(),
            document_id: "page".to_string(),
            title: "Image.png".to_string(),
            mime_type: "image/png".to_string(),
            blob_hash: None,
            remote_url: None,
            link_kind: "image".to_string(),
        };
        assert_eq!(
            rewrite_local_attachment_references(
                "![Image](attachments/Image.png)",
                Path::new("Page.md"),
                &[&attachment],
                &HashMap::from([(
                    "image".to_string(),
                    PathBuf::from("attachments/Image - unique.png"),
                )]),
            ),
            "![Image](attachments/Image%20-%20unique.png)"
        );
    }

    #[test]
    fn failed_local_attachment_reference_falls_back_to_the_remote_url() {
        let attachment = ExportAttachment {
            id: "image".to_string(),
            document_id: "page".to_string(),
            title: "Image.png".to_string(),
            mime_type: "image/png".to_string(),
            blob_hash: None,
            remote_url: Some("https://r.craft.do/image".to_string()),
            link_kind: "image".to_string(),
        };
        assert_eq!(
            rewrite_local_attachment_references(
                "![Image](attachments/Image.png)",
                Path::new("Page.md"),
                &[&attachment],
                &HashMap::new(),
            ),
            "![Image](https://r.craft.do/image)"
        );
    }
}
