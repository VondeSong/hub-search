use super::*;

// Match the collection title: the first nonempty line, up to 160 UTF-16 units.
pub(super) fn display_title(item: &Item) -> String {
    let text = item.post.text.trim();
    let first = text.split(['\r', '\n']).find(|line| !line.is_empty());
    first.map(|line| truncate(line, 160)).unwrap_or_else(|| {
        format!(
            "{}的{}",
            if item.post.author_name.is_empty() {
                "X 用户"
            } else {
                &item.post.author_name
            },
            if item.post.source == "dida" {
                "稍后读"
            } else if item.post.source == "telegram" {
                "收集"
            } else {
                "推文"
            }
        )
    })
}

fn truncate(text: &str, limit: usize) -> String {
    let mut used = 0;
    text.chars()
        .take_while(|ch| {
            used += ch.len_utf16();
            used <= limit
        })
        .collect()
}

fn stem(item: &Item) -> String {
    let title = display_title(item);
    let name: String = title
        .chars()
        .filter(|ch| !ch.is_control())
        .map(|ch| match ch {
            '<' => '＜',
            '>' => '＞',
            ':' => '：',
            '"' => '＂',
            '/' => '／',
            '\\' => '＼',
            '|' => '｜',
            '?' => '？',
            '*' => '＊',
            '#' => '＃',
            '[' => '［',
            ']' => '］',
            '^' => '＾',
            _ => ch,
        })
        .collect();
    let name = name.trim_end_matches([' ', '.']);
    let base = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            base.strip_prefix(prefix).is_some_and(|n| {
                matches!(
                    n,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        });
    if name.is_empty() {
        "X 推文".into()
    } else if reserved {
        format!("_{name}")
    } else {
        name.into()
    }
}

pub(super) fn relative_path(
    c: &Connection,
    root: &Path,
    destination: &str,
    item: &Item,
    previous: Option<&str>,
) -> Result<String, String> {
    let folder = if item.post.source == "dida" {
        "滴答/稍后读"
    } else if item.post.source == "telegram" {
        "Telegram/收集"
    } else if item.post.source == "likes" {
        "X/喜欢"
    } else {
        "X/书签"
    };
    let name = stem(item);
    // Leave room for Windows' path limit, including vault directory and collision suffix.
    let root_length = root
        .to_string_lossy()
        .trim_start_matches("\\\\?\\")
        .encode_utf16()
        .count();
    let budget = 240usize
        .saturating_sub(root_length + folder.encode_utf16().count() + 5)
        .min(160);
    if budget < 32 {
        return Err("Obsidian 库路径过长，无法安全创建标题页面".into());
    }
    for attempt in 0..100 {
        let suffix = match attempt {
            0 => String::new(),
            1 => format!(" — {}", item.post.id),
            _ => format!(
                " — {}-{}-{attempt}",
                item.post.id,
                &hash(item.key.as_bytes())[..8]
            ),
        };
        let base = truncate(&name, budget.saturating_sub(suffix.encode_utf16().count()))
            .trim_end_matches([' ', '.'])
            .to_owned();
        let relative = format!("{folder}/{base}{suffix}.md");
        if previous.is_some_and(|old| old == relative) {
            return Ok(relative);
        }
        let owned_elsewhere: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM collection_obsidian_exports WHERE destination=?1 AND relative_path=?2 COLLATE NOCASE AND item_key<>?3)", params![destination,relative,item.key], |r| r.get(0)).map_err(|e| e.to_string())?;
        let path = safe_path(root, &relative, false)?;
        if owned_elsewhere {
            continue;
        }
        if path.exists() {
            // On Windows a case-only title change is the same file.
            if previous.is_some_and(|old| old.eq_ignore_ascii_case(&relative)) {
                return Ok(previous.unwrap().into());
            }
            continue;
        }
        if let Some(old) = previous {
            let old_path = safe_path(root, old, false)?;
            if old_path.exists() {
                // Create without replacing a concurrently created note; preserve even manual edits.
                fs::hard_link(&old_path, &path).map_err(|e| format!("无法更改页面名称：{e}"))?;
                if let Err(error) = c.execute("UPDATE collection_obsidian_exports SET relative_path=?3 WHERE destination=?1 AND item_key=?2", params![destination,item.key,relative]) {
                    let _ = fs::remove_file(&path);
                    return Err(error.to_string());
                }
                if fs::read(&old_path).map_err(|e| e.to_string())?
                    != fs::read(&path).map_err(|e| e.to_string())?
                {
                    return Err("改名期间旧页面被修改，两个文件均已保留".into());
                }
                fs::remove_file(&old_path)
                    .map_err(|e| format!("页面已改名，但旧文件未能移除：{e}"))?;
            } else {
                c.execute("UPDATE collection_obsidian_exports SET relative_path=?3 WHERE destination=?1 AND item_key=?2", params![destination,item.key,relative]).map_err(|e| e.to_string())?;
            }
        }
        return Ok(relative);
    }
    Err("同名页面过多，已保留原页面".into())
}

// A local startup migration: no X requests, media downloads or content rewrites.
pub(super) fn migrate(app: &AppHandle) -> Result<(), String> {
    let (c, _writer) = open_write_database(&database_path(app)?)?;
    schema(&c)?;
    let cfg = config(&c)?;
    let Some(root) = validate(&cfg)? else {
        return Ok(());
    };
    let destination = library::register_root(&c, &root)?;
    let mut changed = 0;
    let mut failed = 0;
    for row in rows(&c, None, &cfg)? {
        let previous: Option<String> = c.query_row("SELECT relative_path FROM collection_obsidian_exports WHERE destination=?1 AND item_key=?2", params![destination,row.item.key], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
        let Some(old) = previous else {
            continue;
        };
        let original:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM collection_local_source_files WHERE destination=?1 AND relative_path=?2)",params![destination,old],|r|r.get(0)).map_err(|e|e.to_string())?;
        if original || super::super::local_sources::original_layout(&old) {
            continue;
        }
        match relative_path(&c, &root, &destination, &row.item, Some(&old)) {
            Ok(new) if new != old => changed += 1,
            Ok(_) => {}
            Err(_) => failed += 1,
        }
    }
    if changed > 0 || failed > 0 {
        meta(
            &c,
            "collection_export_status",
            &format!("页面名称已更新 {changed} 条；{failed} 条未能改名，原内容保留"),
        )?;
    }
    Ok(())
}
