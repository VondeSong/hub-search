use crate::craft_backup::{reject_links, BackupIssue};
use percent_encoding::percent_decode_str;
use pulldown_cmark::{Event, Options, Parser, Tag};
use std::{
    collections::BTreeSet,
    fs,
    path::{Component, Path, PathBuf},
};

/// Resolve only explicit relative paths; never guess a page from its basename.
fn local_target(root: &Path, page: &Path, target: &str) -> Option<(PathBuf, String)> {
    if target.starts_with('/') || target.starts_with('\\') {
        return None;
    }
    if url::Url::parse(target).is_ok() {
        return None;
    }
    let (path, fragment) = target.split_once('#').unwrap_or((target, ""));
    let decoded = percent_decode_str(path).decode_utf8().ok()?;
    let base = if decoded.is_empty() {
        page.to_path_buf()
    } else {
        page.parent()?.join(decoded.as_ref())
    };
    let mut normalized = PathBuf::new();
    for c in base.components() {
        match c {
            Component::Normal(v) => normalized.push(v),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Some((root.join("__outside_vault__"), fragment.into()));
                }
            }
            _ => return None,
        }
    }
    let exact = root.join(&normalized);
    if exact.is_file() || normalized.extension().is_some() {
        return Some((exact, fragment.into()));
    }
    Some((root.join(normalized.with_extension("md")), fragment.into()))
}

pub fn audit_page(root: &Path, id: &str, page: &Path) -> Result<Vec<BackupIssue>, String> {
    let actual = root.join(page);
    reject_links(&actual)?;
    let body = fs::read_to_string(actual).map_err(|e| e.to_string())?;
    let parser = Parser::new_ext(
        &body,
        Options::ENABLE_TABLES
            | Options::ENABLE_WIKILINKS
            | Options::ENABLE_YAML_STYLE_METADATA_BLOCKS,
    );
    let mut issues = Vec::new();
    let mut seen = BTreeSet::new();
    for event in parser {
        let Event::Start(Tag::Link { dest_url, .. } | Tag::Image { dest_url, .. }) = event else {
            continue;
        };
        let target = dest_url.as_ref();
        if !seen.insert(target.to_string()) {
            continue;
        }
        let reason =
            if target.starts_with("craftdocs:") || target.starts_with("https://docs.craft.do/") {
                Some("Craft 目标未解析，保留原地址")
            } else if target.starts_with("https://res.craft.do/")
                || target.starts_with("https://r.craft.do/")
            {
                Some("远程资源尚未本地化，离线不可用")
            } else if let Some((path, fragment)) = local_target(root, page, target) {
                reject_links(&path)?;
                if !path.is_file() {
                    Some("本地目标不存在；未按同名页猜测或创建空页")
                } else if let Some(anchor) = fragment.strip_prefix('^') {
                    let expected = format!("^{anchor}");
                    if fs::read_to_string(path)
                        .is_ok_and(|s| s.lines().any(|l| l.trim_end().ends_with(&expected)))
                    {
                        None
                    } else {
                        Some("本地块定位编号不存在")
                    }
                } else {
                    None
                }
            } else {
                None
            };
        if let Some(reason) = reason {
            issues.push(BackupIssue {
                object_id: id.into(),
                category: "vault_link".into(),
                message: format!("{}：{reason}（{target}）", page.display()),
            });
        }
    }
    Ok(issues)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn markdown_and_wiki_links_report_real_missing_paths_but_ignore_code() {
        let root =
            std::env::temp_dir().join(format!("hub-export-audit-{:016x}", rand::random::<u64>()));
        fs::create_dir_all(root.join("目录")).unwrap();
        fs::write(root.join("目录/目标 中文.md"), "段落 ^block1\n").unwrap();
        fs::write(root.join("目录/正文.md"),"[有效](目标%20中文.md#^block1)\n[[目标 中文#^block1|链接]]\n[坏块](目标%20中文.md#^bad)\n[[不存在|别名]]\n`[代码](无文件.md)`\n```md\n[[例子]]\n```\n").unwrap();
        let issues = audit_page(&root, "page", Path::new("目录/正文.md")).unwrap();
        assert_eq!(issues.len(), 2, "{issues:?}");
        assert!(issues.iter().any(|i| i.message.contains("块定位")));
        assert!(issues.iter().any(|i| i.message.contains("不存在")));
        fs::remove_dir_all(root).unwrap();
    }
}
