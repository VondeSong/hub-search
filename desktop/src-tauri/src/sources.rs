use serde::Serialize;
use serde_yaml::Value as YamlValue;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};

pub const PROVIDER_CRAFT: &str = "craft";
pub const PROVIDER_OBSIDIAN: &str = "obsidian";
pub const PROVIDER_DIDA365: &str = "dida365";
pub const PROVIDER_FEISHU: &str = "feishu";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySummary {
    pub id: String,
    pub provider: String,
    pub name: String,
    pub location: Option<String>,
    pub connected: bool,
    pub document_count: i64,
    pub last_sync: Option<String>,
    pub excluded_paths: Vec<String>,
    pub icon_svg: Option<String>,
    pub default_icon_url: Option<String>,
}

#[derive(Debug, Clone)]
pub struct LocalMarkdownDocument {
    pub id: String,
    pub title: String,
    pub relative_path: String,
    pub folder_path: Option<String>,
    pub markdown: String,
    pub modified_at: i64,
    pub content_hash: String,
    pub aliases: Vec<String>,
    pub tags: Vec<String>,
    pub attachments: Vec<LocalAttachmentReference>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalAttachmentReference {
    pub relative_path: String,
    pub title: String,
    pub mime_type: String,
    pub modified_at: i64,
    pub size: u64,
}

pub fn obsidian_library_id(root: &Path) -> Result<String, String> {
    let canonical = root
        .canonicalize()
        .map_err(|error| format!("无法读取 Obsidian 库路径：{error}"))?;
    let normalized = canonical
        .to_string_lossy()
        .replace('\\', "/")
        .to_lowercase();
    let digest = Sha256::digest(normalized.as_bytes());
    Ok(format!("obsidian:{}", encode_hex(&digest[..12])))
}

pub fn obsidian_vault_name(root: &Path) -> String {
    root.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("Obsidian")
        .to_string()
}

pub fn display_local_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        if let Some(rest) = value.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    value.into_owned()
}

pub fn scan_obsidian_vault(
    root: &Path,
    excluded_paths: &[String],
) -> Result<Vec<LocalMarkdownDocument>, String> {
    scan_obsidian_vault_controlled(root, excluded_paths, &|| Ok(()))
}

pub(crate) fn scan_obsidian_vault_controlled(
    root: &Path,
    excluded_paths: &[String],
    checkpoint: &impl Fn() -> Result<(), String>,
) -> Result<Vec<LocalMarkdownDocument>, String> {
    checkpoint()?;
    let canonical = root
        .canonicalize()
        .map_err(|error| format!("无法打开 Obsidian 库：{error}"))?;
    if !canonical.is_dir() {
        return Err("Obsidian 库路径不是文件夹".to_string());
    }
    let mut markdown_paths = Vec::new();
    let mut attachment_paths = Vec::new();
    scan_directory(
        &canonical,
        &canonical,
        excluded_paths,
        &mut markdown_paths,
        &mut attachment_paths,
        checkpoint,
    )?;
    let mut attachment_lookup: HashMap<String, Vec<PathBuf>> = HashMap::new();
    for path in attachment_paths {
        if let Some(name) = path.file_name().and_then(|value| value.to_str()) {
            attachment_lookup
                .entry(name.to_lowercase())
                .or_default()
                .push(path);
        }
    }
    let mut documents = markdown_paths
        .iter()
        .map(|path| {
            checkpoint()?;
            read_markdown_document_inner(&canonical, path, Some(&attachment_lookup), excluded_paths)
        })
        .collect::<Result<Vec<_>, _>>()?;
    documents.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(documents)
}

fn scan_directory(
    root: &Path,
    directory: &Path,
    excluded_paths: &[String],
    markdown_paths: &mut Vec<PathBuf>,
    attachment_paths: &mut Vec<PathBuf>,
    checkpoint: &impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    let entries = fs::read_dir(directory)
        .map_err(|error| format!("无法枚举 Obsidian 目录 {}：{error}", directory.display()))?;
    for entry in entries {
        checkpoint()?;
        let entry = entry.map_err(|error| format!("无法读取 Obsidian 目录项：{error}"))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("无法读取 Obsidian 文件类型：{error}"))?;
        if file_type.is_symlink() {
            continue;
        }
        let relative_path = path
            .strip_prefix(root)
            .ok()
            .map(|value| value.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        if obsidian_path_is_excluded(&relative_path, excluded_paths) {
            continue;
        }
        if file_type.is_dir() {
            if should_ignore_directory(&entry.file_name().to_string_lossy()) {
                continue;
            }
            scan_directory(
                root,
                &path,
                excluded_paths,
                markdown_paths,
                attachment_paths,
                checkpoint,
            )?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let extension = path
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or_default();
        if extension.eq_ignore_ascii_case("md") {
            markdown_paths.push(path);
        } else if attachment_mime_type(extension).is_some() {
            attachment_paths.push(path);
        }
    }
    Ok(())
}

pub(crate) fn should_ignore_directory(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        ".obsidian" | ".trash" | ".git" | ".basic-memory" | "node_modules"
    )
}

pub fn read_markdown_document_with_exclusions(
    root: &Path,
    path: &Path,
    excluded_paths: &[String],
) -> Result<LocalMarkdownDocument, String> {
    read_markdown_document_inner(root, path, None, excluded_paths)
}

fn read_markdown_document_inner(
    root: &Path,
    path: &Path,
    attachment_lookup: Option<&HashMap<String, Vec<PathBuf>>>,
    excluded_paths: &[String],
) -> Result<LocalMarkdownDocument, String> {
    let bytes = fs::read(path)
        .map_err(|error| format!("无法读取 Obsidian 文档 {}：{error}", path.display()))?;
    let markdown = String::from_utf8(bytes.clone())
        .map_err(|error| format!("Obsidian 文档不是有效 UTF-8（{}）：{error}", path.display()))?;
    let comparable_root = PathBuf::from(display_local_path(root));
    let comparable_path = PathBuf::from(display_local_path(path));
    let relative = comparable_path
        .strip_prefix(&comparable_root)
        .map_err(|_| "Obsidian 文档不在资料库目录内".to_string())?;
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("Obsidian 文档路径包含不安全组件".to_string());
    }
    let relative_path = relative.to_string_lossy().replace('\\', "/");
    let title = path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("Untitled")
        .to_string();
    let folder_path = relative
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(|parent| parent.to_string_lossy().replace('\\', "/"));
    let modified_at = fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    let content_hash = encode_hex(&Sha256::digest(&bytes));
    let id = obsidian_document_id(&relative_path);
    let aliases = obsidian_frontmatter_aliases(&markdown);
    let tags = obsidian_markdown_tags(&markdown);
    let attachments =
        discover_local_attachments(root, path, &markdown, attachment_lookup, excluded_paths);
    Ok(LocalMarkdownDocument {
        id,
        title,
        relative_path,
        folder_path,
        markdown,
        modified_at,
        content_hash,
        aliases,
        tags,
        attachments,
    })
}

fn attachment_mime_type(extension: &str) -> Option<&'static str> {
    match extension.to_ascii_lowercase().as_str() {
        "pdf" => Some("application/pdf"),
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        "bmp" => Some("image/bmp"),
        "tif" | "tiff" => Some("image/tiff"),
        "mp4" | "m4v" => Some("video/mp4"),
        "mov" => Some("video/quicktime"),
        "webm" => Some("video/webm"),
        _ => None,
    }
}

fn attachment_targets(markdown: &str) -> Vec<String> {
    use pulldown_cmark::{Event, Parser, Tag};

    let mut targets = Vec::new();
    for event in Parser::new(markdown) {
        if let Event::Start(Tag::Link { dest_url, .. } | Tag::Image { dest_url, .. }) = event {
            targets.push(dest_url.into_string());
        }
    }
    let mut remainder = markdown;
    while let Some(start) = remainder.find("[[") {
        remainder = &remainder[start + 2..];
        let Some(end) = remainder.find("]]") else {
            break;
        };
        targets.push(remainder[..end].to_string());
        remainder = &remainder[end + 2..];
    }
    targets
}

fn configured_attachment_folder(root: &Path) -> Option<PathBuf> {
    let bytes = fs::read(root.join(".obsidian").join("app.json")).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let folder = value.get("attachmentFolderPath")?.as_str()?.trim();
    if folder.is_empty() || folder == "." {
        None
    } else {
        Some(PathBuf::from(folder))
    }
}

fn discover_local_attachments(
    root: &Path,
    source_path: &Path,
    markdown: &str,
    attachment_lookup: Option<&HashMap<String, Vec<PathBuf>>>,
    excluded_paths: &[String],
) -> Vec<LocalAttachmentReference> {
    let canonical_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let source_folder = source_path.parent().unwrap_or(root);
    let configured_folder = configured_attachment_folder(&canonical_root);
    let mut seen = HashSet::new();
    let mut attachments = Vec::new();
    for raw_target in attachment_targets(markdown) {
        let target = raw_target
            .split('|')
            .next()
            .unwrap_or_default()
            .split('#')
            .next()
            .unwrap_or_default()
            .split('^')
            .next()
            .unwrap_or_default()
            .trim()
            .trim_matches(['<', '>']);
        if target.is_empty()
            || target.starts_with('#')
            || target.contains("://")
            || target.starts_with("data:")
        {
            continue;
        }
        let decoded = percent_encoding::percent_decode_str(target)
            .decode_utf8_lossy()
            .replace('\\', "/");
        let target_path = PathBuf::from(decoded.as_str());
        let Some(extension) = target_path.extension().and_then(|value| value.to_str()) else {
            continue;
        };
        let Some(mime_type) = attachment_mime_type(extension) else {
            continue;
        };
        let mut candidates = Vec::new();
        if target_path.is_absolute() {
            candidates
                .push(canonical_root.join(target_path.strip_prefix("/").unwrap_or(&target_path)));
        } else {
            candidates.push(source_folder.join(&target_path));
            candidates.push(canonical_root.join(&target_path));
            if let Some(folder) = &configured_folder {
                candidates.push(canonical_root.join(folder).join(&target_path));
            }
        }
        if target_path.components().count() == 1 {
            if let (Some(lookup), Some(name)) = (
                attachment_lookup,
                target_path.file_name().and_then(|value| value.to_str()),
            ) {
                if let Some(matches) = lookup.get(&name.to_lowercase()) {
                    if matches.len() == 1 {
                        candidates.push(matches[0].clone());
                    }
                }
            }
        }
        let Some(canonical) = candidates
            .into_iter()
            .filter_map(|candidate| candidate.canonicalize().ok())
            .find(|candidate| candidate.is_file() && candidate.starts_with(&canonical_root))
        else {
            continue;
        };
        let Ok(relative) = canonical.strip_prefix(&canonical_root) else {
            continue;
        };
        if relative.components().any(|component| match component {
            Component::Normal(name) => should_ignore_directory(&name.to_string_lossy()),
            _ => true,
        }) {
            continue;
        }
        let relative_path = relative.to_string_lossy().replace('\\', "/");
        if obsidian_path_is_excluded(&relative_path, excluded_paths) {
            continue;
        }
        if !seen.insert(relative_path.to_lowercase()) {
            continue;
        }
        let metadata = fs::metadata(&canonical).ok();
        let modified_at = metadata
            .as_ref()
            .and_then(|value| value.modified().ok())
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_secs() as i64)
            .unwrap_or(0);
        attachments.push(LocalAttachmentReference {
            title: canonical
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("附件")
                .to_string(),
            relative_path,
            mime_type: mime_type.to_string(),
            modified_at,
            size: metadata.map(|value| value.len()).unwrap_or(0),
        });
    }
    attachments.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    attachments
}

pub fn obsidian_document_id(relative_path: &str) -> String {
    encode_hex(&Sha256::digest(relative_path.replace('\\', "/").as_bytes()))
}

pub fn obsidian_frontmatter_aliases(markdown: &str) -> Vec<String> {
    let Some(frontmatter) = obsidian_frontmatter(markdown) else {
        return Vec::new();
    };
    let Ok(YamlValue::Mapping(mapping)) = serde_yaml::from_str::<YamlValue>(frontmatter) else {
        return Vec::new();
    };
    let mut aliases = Vec::new();
    for (key, value) in mapping {
        let Some(key) = key.as_str() else {
            continue;
        };
        if !key.eq_ignore_ascii_case("alias") && !key.eq_ignore_ascii_case("aliases") {
            continue;
        }
        match value {
            YamlValue::String(value) => push_alias(&mut aliases, &value),
            YamlValue::Sequence(values) => {
                for value in values {
                    if let YamlValue::String(value) = value {
                        push_alias(&mut aliases, &value);
                    }
                }
            }
            _ => {}
        }
    }
    aliases
}

pub fn obsidian_markdown_tags(markdown: &str) -> Vec<String> {
    let mut tags = Vec::new();
    if let Some(frontmatter) = obsidian_frontmatter(markdown) {
        if let Ok(YamlValue::Mapping(mapping)) = serde_yaml::from_str::<YamlValue>(frontmatter) {
            for (key, value) in mapping {
                let Some(key) = key.as_str() else {
                    continue;
                };
                if !key.eq_ignore_ascii_case("tag") && !key.eq_ignore_ascii_case("tags") {
                    continue;
                }
                match value {
                    YamlValue::String(value) => {
                        for tag in value.split([' ', ',']) {
                            push_tag(&mut tags, tag);
                        }
                    }
                    YamlValue::Sequence(values) => {
                        for value in values {
                            if let YamlValue::String(value) = value {
                                push_tag(&mut tags, &value);
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    let mut in_code_fence = false;
    for line in markdown.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_code_fence = !in_code_fence;
            continue;
        }
        if in_code_fence || trimmed.starts_with("---") {
            continue;
        }
        let characters = line.char_indices().collect::<Vec<_>>();
        for (index, (_, character)) in characters.iter().enumerate() {
            if *character != '#' {
                continue;
            }
            let boundary_before = index == 0
                || characters[index - 1].1.is_whitespace()
                || "([{\"'".contains(characters[index - 1].1);
            let Some((start, first)) = characters.get(index + 1).copied() else {
                continue;
            };
            if !boundary_before || first.is_whitespace() || first == '#' {
                continue;
            }
            let end = characters
                .iter()
                .skip(index + 1)
                .find(|(_, value)| {
                    value.is_whitespace() || ",.;:!?，。；：！？)]}\"'".contains(*value)
                })
                .map(|(offset, _)| *offset)
                .unwrap_or(line.len());
            push_tag(&mut tags, &line[start..end]);
        }
    }
    tags
}

fn obsidian_frontmatter(markdown: &str) -> Option<&str> {
    let content = markdown.strip_prefix('\u{feff}').unwrap_or(markdown);
    let body = content
        .strip_prefix("---\r\n")
        .or_else(|| content.strip_prefix("---\n"))?;
    let mut offset = 0;
    for segment in body.split_inclusive('\n') {
        let line = segment.trim_end_matches(['\r', '\n']);
        if line == "---" || line == "..." {
            return Some(&body[..offset]);
        }
        offset += segment.len();
    }
    None
}

fn push_alias(aliases: &mut Vec<String>, value: &str) {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 512
        || aliases
            .iter()
            .any(|existing| existing.eq_ignore_ascii_case(value))
    {
        return;
    }
    aliases.push(value.to_string());
}

fn push_tag(tags: &mut Vec<String>, value: &str) {
    let value = value.trim().trim_start_matches('#').trim_end_matches('/');
    if value.is_empty()
        || value.len() > 256
        || tags
            .iter()
            .any(|existing: &String| existing.eq_ignore_ascii_case(value))
    {
        return;
    }
    tags.push(value.to_string());
}

fn wildcard_path_matches(pattern: &str, path: &str) -> bool {
    let pattern = pattern.as_bytes();
    let path = path.as_bytes();
    let (mut pattern_index, mut path_index) = (0_usize, 0_usize);
    let (mut star_index, mut star_path_index) = (None, 0_usize);
    while path_index < path.len() {
        if pattern_index < pattern.len()
            && (pattern[pattern_index] == b'?' || pattern[pattern_index] == path[path_index])
        {
            pattern_index += 1;
            path_index += 1;
        } else if pattern_index < pattern.len() && pattern[pattern_index] == b'*' {
            star_index = Some(pattern_index);
            pattern_index += 1;
            star_path_index = path_index;
        } else if let Some(star) = star_index {
            pattern_index = star + 1;
            star_path_index += 1;
            path_index = star_path_index;
        } else {
            return false;
        }
    }
    while pattern_index < pattern.len() && pattern[pattern_index] == b'*' {
        pattern_index += 1;
    }
    pattern_index == pattern.len()
}

pub fn obsidian_path_is_excluded(relative_path: &str, excluded_paths: &[String]) -> bool {
    let path = relative_path
        .trim()
        .trim_start_matches(['/', '\\'])
        .replace('\\', "/")
        .to_lowercase();
    if path.is_empty() {
        return false;
    }
    excluded_paths.iter().any(|raw_pattern| {
        let pattern = raw_pattern
            .trim()
            .trim_start_matches(['/', '\\'])
            .trim_end_matches('/')
            .replace('\\', "/")
            .to_lowercase();
        if pattern.is_empty() {
            return false;
        }
        if pattern.contains('*') || pattern.contains('?') {
            return wildcard_path_matches(&pattern, &path);
        }
        if pattern.contains('/') {
            path == pattern || path.starts_with(&format!("{pattern}/"))
        } else {
            path.split('/').any(|component| component == pattern)
        }
    })
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

pub fn obsidian_open_url(vault_name: &str, relative_path: &str) -> Result<String, String> {
    let mut url = url::Url::parse("obsidian://open")
        .map_err(|error| format!("无法构造 Obsidian 深层链接：{error}"))?;
    let (file, fragment) = relative_path
        .split_once('#')
        .map(|(file, fragment)| (file, Some(fragment)))
        .unwrap_or((relative_path, None));
    let mut target = file.trim_end_matches(".md").to_string();
    if let Some(fragment) = fragment.filter(|value| !value.is_empty()) {
        target.push('#');
        target.push_str(fragment);
    }
    url.query_pairs_mut()
        .append_pair("vault", vault_name)
        .append_pair("file", &target);
    // Obsidian treats `+` literally in its custom URI instead of decoding it as a
    // query-string space. Keep standard percent encoding for spaces.
    Ok(url.to_string().replace('+', "%20"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn library_management_obsidian_scan_stops_at_file_boundaries_and_preserves_sources() {
        let root =
            std::env::temp_dir().join(format!("hub-scan-control-{}", crate::random_url_safe(16)));
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("original.md");
        std::fs::write(&source, "# Original\nbody").unwrap();
        let checkpoints = std::cell::Cell::new(0);
        let result = scan_obsidian_vault_controlled(&root, &[], &|| {
            let calls = checkpoints.get() + 1;
            checkpoints.set(calls);
            if calls >= 3 {
                Err("资料库操作已停止：资料库已暂停".into())
            } else {
                Ok(())
            }
        });
        assert!(result.unwrap_err().starts_with("资料库操作已停止："));
        assert_eq!(checkpoints.get(), 3);
        assert_eq!(
            std::fs::read_to_string(&source).unwrap(),
            "# Original\nbody"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn stable_library_id_and_open_url() {
        let root = std::env::temp_dir().join("craft-search-obsidian-id");
        let _ = fs::create_dir_all(&root);
        let first = obsidian_library_id(&root).unwrap();
        let second = obsidian_library_id(&root).unwrap();
        assert_eq!(first, second);
        let url = obsidian_open_url("Main", "目录/页面.md").unwrap();
        assert!(url.starts_with("obsidian://open?"));
        assert!(url.contains("vault=Main"));
        let spaced = obsidian_open_url("Main Vault", "Craft Search 验收/北辰预览验收.md").unwrap();
        assert!(spaced.contains("vault=Main%20Vault"));
        assert!(spaced.contains("file=Craft%20Search%20%E9%AA%8C%E6%94%B6%2F%E5%8C%97%E8%BE%B0%E9%A2%84%E8%A7%88%E9%AA%8C%E6%94%B6"));
        assert!(!spaced.contains('+'));
        let heading = obsidian_open_url("Main", "目录/页面.md#指定章节").unwrap();
        assert!(heading.contains("file=%E7%9B%AE%E5%BD%95%2F%E9%A1%B5%E9%9D%A2%23"));
    }

    #[test]
    fn frontmatter_aliases_support_strings_lists_and_bom() {
        let markdown = "\u{feff}---\nalias: 主入口\naliases:\n  - 首页\n  - Home\n  - 首页\ntags: [test]\n---\n# 标题";
        assert_eq!(
            obsidian_frontmatter_aliases(markdown),
            vec!["主入口", "首页", "Home"]
        );
    }

    #[test]
    fn tags_support_frontmatter_inline_values_and_code_fences() {
        let markdown =
            "---\ntags: [项目, 搜索/质量]\n---\n正文 #本地优先 与 #项目\n```md\n#不应索引\n```";
        assert_eq!(
            obsidian_markdown_tags(markdown),
            vec!["项目", "搜索/质量", "本地优先"]
        );
    }

    #[test]
    fn exclusion_rules_support_components_prefixes_and_wildcards() {
        let exclusions = vec![
            "Archive".to_string(),
            "Templates/**".to_string(),
            "*.canvas".to_string(),
        ];
        assert!(obsidian_path_is_excluded(
            "项目/Archive/旧笔记.md",
            &exclusions
        ));
        assert!(obsidian_path_is_excluded(
            "Templates/日报/模板.md",
            &exclusions
        ));
        assert!(obsidian_path_is_excluded("白板.canvas", &exclusions));
        assert!(!obsidian_path_is_excluded("项目/进行中.md", &exclusions));
    }

    #[test]
    fn same_named_vaults_have_distinct_ids() {
        let base = std::env::temp_dir().join(format!(
            "craft-search-same-vault-name-{}",
            std::process::id()
        ));
        let first = base.join("one").join("Main");
        let second = base.join("two").join("Main");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();

        assert_ne!(
            obsidian_library_id(&first).unwrap(),
            obsidian_library_id(&second).unwrap()
        );

        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn windows_extended_paths_are_cleaned_for_display() {
        #[cfg(windows)]
        {
            assert_eq!(
                display_local_path(Path::new(r"\\?\D:\Notes\Main")),
                r"D:\Notes\Main"
            );
            assert_eq!(
                display_local_path(Path::new(r"\\?\UNC\server\share\Main")),
                r"\\server\share\Main"
            );
        }
    }

    #[test]
    fn obsidian_attachment_references_resolve_supported_local_files() {
        let root = std::env::temp_dir().join(format!(
            "craft-search-attachment-refs-{}",
            std::process::id()
        ));
        let notes = root.join("Notes");
        let assets = root.join("assets");
        std::fs::create_dir_all(root.join(".obsidian")).unwrap();
        std::fs::create_dir_all(&notes).unwrap();
        std::fs::create_dir_all(&assets).unwrap();
        std::fs::write(
            root.join(".obsidian").join("app.json"),
            r#"{"attachmentFolderPath":"assets"}"#,
        )
        .unwrap();
        std::fs::write(assets.join("手册.pdf"), b"%PDF-1.4\n%%EOF").unwrap();
        std::fs::write(assets.join("photo one.jpg"), b"jpeg-fixture").unwrap();
        std::fs::write(assets.join("demo.mp4"), b"video-fixture").unwrap();
        std::fs::write(notes.join("local.png"), b"png-fixture").unwrap();
        std::fs::write(notes.join("ignored.docx"), b"docx-fixture").unwrap();
        std::fs::write(
            notes.join("页面.md"),
            "![[手册.pdf]]\n![本地图](local.png)\n[照片](../assets/photo%20one.jpg)\n![[demo.mp4]]\n![[ignored.docx]]",
        )
        .unwrap();

        let documents = scan_obsidian_vault(&root, &[]).unwrap();
        assert_eq!(documents.len(), 1);
        let paths = documents[0]
            .attachments
            .iter()
            .map(|attachment| attachment.relative_path.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            paths,
            vec![
                "Notes/local.png",
                "assets/demo.mp4",
                "assets/photo one.jpg",
                "assets/手册.pdf"
            ]
        );
        assert_eq!(documents[0].attachments[1].mime_type, "video/mp4");
        assert_eq!(documents[0].attachments[3].mime_type, "application/pdf");

        let _ = std::fs::remove_dir_all(root);
    }
}
