use super::*;
use std::io::Read;

const MAX_NOTE: u64 = 2 * 1024 * 1024;
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Dependency {
    pub target: String,
    pub path: String,
    pub stamp: String,
    pub digest: String,
}
pub(super) struct Note {
    pub post: Post,
    pub file_hash: String,
    pub fingerprint: String,
    pub identity: String,
    pub dependencies: Vec<Dependency>,
    pub status: String,
    pub tags: Vec<String>,
    pub collected: i64,
}
fn text(fm: &serde_yaml::Value, fields: &[&str]) -> String {
    for field in fields {
        if let Some(value) = fm.get(*field) {
            let result = match value {
                serde_yaml::Value::String(s) => s.clone(),
                serde_yaml::Value::Number(n) => n.to_string(),
                _ => String::new(),
            };
            if !result.trim().is_empty() {
                return result;
            }
        }
    }
    String::new()
}
fn stamp(path: &Path) -> String {
    fs::metadata(path)
        .ok()
        .and_then(|m| {
            Some(format!(
                "{}:{}",
                m.len(),
                m.modified()
                    .ok()?
                    .duration_since(std::time::UNIX_EPOCH)
                    .ok()?
                    .as_nanos()
            ))
        })
        .unwrap_or_default()
}
fn read(path: &Path) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(MAX_NOTE + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_NOTE {
        return Err("Markdown 超过 2 MiB，保留原件并等待拆分后接入".into());
    }
    Ok(bytes)
}
pub(super) fn unchanged(
    c: &Connection,
    destination: &str,
    relative: &str,
    path: &Path,
    root: &Path,
) -> Result<bool, String> {
    let old: Option<(String,String,String)> = c.query_row("SELECT file_hash,dependencies,error FROM collection_local_source_files WHERE destination=?1 AND relative_path=?2",params![destination,relative],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|e|e.to_string())?;
    let Some((hash, deps, error)) = old else {
        return Ok(false);
    };
    if !error.is_empty() || hash.is_empty() {
        return Ok(false);
    }
    let Ok(bytes) = read(path) else {
        return Ok(false);
    };
    if storage::hash(&bytes) != hash {
        return Ok(false);
    }
    let deps: Vec<Dependency> = serde_json::from_str(&deps).map_err(|e| e.to_string())?;
    for dep in deps {
        // Missing references are retried: attachments may arrive after Markdown.
        if dep.path.is_empty() {
            return Ok(false);
        }
        let p = Path::new(&dep.path);
        if !p.canonicalize().is_ok_and(|p| p.starts_with(root)) || stamp(p) != dep.stamp {
            return Ok(false);
        }
    }
    Ok(true)
}
fn resolve(
    root: &Path,
    note: &Path,
    raw: &str,
    wiki: bool,
    lookup: &HashMap<String, Vec<PathBuf>>,
) -> Option<PathBuf> {
    let decoded = percent_encoding::percent_decode_str(
        raw.split(['#', '|'])
            .next()
            .unwrap_or("")
            .trim()
            .trim_matches(['<', '>']),
    )
    .decode_utf8()
    .ok()?
    .replace('\\', "/");
    if decoded.is_empty() || decoded.contains(":") || decoded.starts_with("//") {
        return None;
    }
    let target = Path::new(decoded.trim_start_matches('/'));
    let candidates = if wiki {
        vec![root.join(target), note.parent()?.join(target)]
    } else {
        vec![note.parent()?.join(target), root.join(target)]
    };
    for candidate in candidates {
        if let Ok(path) = candidate.canonicalize() {
            if path.starts_with(root) && path.is_file() {
                return Some(path);
            }
        }
    }
    if target.components().count() == 1 {
        let candidates = lookup.get(&decoded.to_lowercase())?;
        if candidates.len() == 1 {
            let p = candidates[0].canonicalize().ok()?;
            if p.starts_with(root) {
                return Some(p);
            }
        }
    }
    None
}
fn kind(target: &str) -> Option<&'static str> {
    let ext = Path::new(target.split(['?', '#', '|']).next().unwrap_or(""))
        .extension()?
        .to_str()?
        .to_lowercase();
    Some(match ext.as_str() {
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "avif" | "bmp" | "svg" | "tif" | "tiff" => {
            "photo"
        }
        "mp4" | "webm" | "mov" | "mkv" | "m4v" => "video",
        "mp3" | "ogg" | "wav" | "m4a" | "flac" | "opus" => "audio",
        "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "zip" | "txt" => "file",
        _ => return None,
    })
}
fn digest(c: &Connection, path: &Path, stamp: &str) -> Result<String, String> {
    let name = path.to_string_lossy();
    let cached: Option<String> = c
        .query_row(
            "SELECT digest FROM collection_local_source_assets WHERE path=?1 AND stamp=?2",
            params![name, stamp],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(hash) = cached {
        return Ok(hash);
    }
    let mut input = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = input.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    if self::stamp(path) != stamp {
        return Err("附件仍在写入，下一轮重试".into());
    }
    let hash = format!("{:x}", hash.finalize());
    c.execute("INSERT INTO collection_local_source_assets(path,stamp,digest) VALUES(?1,?2,?3) ON CONFLICT(path) DO UPDATE SET stamp=excluded.stamp,digest=excluded.digest",params![name,stamp,hash]).map_err(|e|e.to_string())?;
    Ok(hash)
}
fn millis(value: &str) -> Option<i64> {
    if let Ok(value) = chrono::DateTime::parse_from_rfc3339(value) {
        return Some(value.timestamp_millis());
    }
    for format in [
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y%m%d%H%M%S%.f",
    ] {
        if let Ok(value) = chrono::NaiveDateTime::parse_from_str(value, format) {
            if let chrono::LocalResult::Single(value) =
                chrono::TimeZone::from_local_datetime(&chrono::Local, &value)
            {
                return Some(value.timestamp_millis());
            }
        }
    }
    None
}
pub(super) fn parse(
    c: &Connection,
    root: &Path,
    path: &Path,
    lookup: &HashMap<String, Vec<PathBuf>>,
) -> Result<Note, String> {
    let resolved = path.canonicalize().map_err(|e| e.to_string())?;
    if !resolved.starts_with(root) {
        return Err("素材路径越出所选库".into());
    }
    let before = stamp(path);
    let bytes = read(path)?;
    let raw = std::str::from_utf8(&bytes)
        .map_err(|_| "Markdown 不是 UTF-8，保留原件")?
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n");
    let (fm, mut body) = if let Some(rest) = raw.strip_prefix("---\n") {
        let end = rest
            .find("\n---\n")
            .or_else(|| rest.strip_suffix("\n---").map(str::len))
            .ok_or("页面属性尚未完整写入，下一轮重试")?;
        let value: serde_yaml::Value =
            serde_yaml::from_str(&rest[..end]).map_err(|e| format!("页面属性无法解析：{e}"))?;
        (value, rest[(end + 5).min(rest.len())..].to_string())
    } else {
        (serde_yaml::Value::Null, raw)
    };
    let telegram = path
        .strip_prefix(root)
        .is_ok_and(|p| p.starts_with("Telegram"));
    let forward =
        regex::Regex::new(r"^\s*\*\*Forwarded from \[([^\]]+)\]\((https?://[^)]+)\)\*\*\s*")
            .unwrap();
    let origin = if telegram {
        forward.captures(&body).map(|cap| {
            (
                cap[1].to_string(),
                cap[2].to_string(),
                cap.get(0).unwrap().end(),
            )
        })
    } else {
        None
    };
    if let Some((_, _, end)) = &origin {
        body = body[*end..].to_string();
    }
    let mut url = text(&fm, &["url", "地址", "source_url", "source"]);
    if url.is_empty() {
        url = origin.as_ref().map(|v| v.1.clone()).unwrap_or_default();
    }
    let x = regex::Regex::new(
        r"(?i)https?://(?:www\.)?(?:x\.com|twitter\.com)/(?:[^/]+/status|i/web/status)/(\d+)",
    )
    .unwrap();
    let tg = regex::Regex::new(
        r"(?i)^https?://(?:t\.me|telegram\.me)/(?:c/)?([^/]+)/(\d+)(?:[/?#].*)?$",
    )
    .unwrap();
    if url.is_empty() && !telegram {
        url = x
            .find(&body)
            .map(|m| m.as_str().to_string())
            .unwrap_or_default();
    }
    let xid = if !telegram {
        let supplied = text(&fm, &["x_id"]);
        if !supplied.is_empty() && supplied.bytes().all(|b| b.is_ascii_digit()) {
            supplied
        } else {
            x.captures(&url)
                .map(|c| c[1].to_string())
                .unwrap_or_default()
        }
    } else {
        String::new()
    };
    let identity = if !xid.is_empty() {
        format!(
            "x:{}:{xid}",
            if path
                .strip_prefix(root)
                .is_ok_and(|p| p.starts_with("X/喜欢"))
            {
                "likes"
            } else {
                "bookmarks"
            }
        )
    } else if telegram {
        tg.captures(&url)
            .map(|c| format!("telegram:{}/{}", c[1].to_lowercase(), &c[2]))
            .unwrap_or_default()
    } else {
        String::new()
    };
    let mut references = Vec::new();
    let mut protected = Vec::new();
    use pulldown_cmark::{Event, Tag};
    let mut in_code = false;
    for (event, range) in pulldown_cmark::Parser::new(&body).into_offset_iter() {
        match event {
            Event::Start(Tag::CodeBlock(_)) => in_code = true,
            Event::End(pulldown_cmark::TagEnd::CodeBlock) => in_code = false,
            Event::Code(_) => protected.push(range),
            Event::Start(Tag::Image { dest_url, .. } | Tag::Link { dest_url, .. }) if !in_code => {
                if kind(&dest_url).is_some() {
                    let caption = body[range.clone()]
                        .trim_start_matches('!')
                        .strip_prefix('[')
                        .and_then(|s| s.split_once(']'))
                        .map(|(caption, _)| caption.to_string())
                        .unwrap_or_default();
                    references.push((
                        range.start,
                        range.end,
                        dest_url.into_string(),
                        false,
                        caption,
                    ));
                }
            }
            _ if in_code => protected.push(range),
            _ => {}
        }
    }
    let wiki = regex::Regex::new(r"!?\[\[([^\]\n]+)\]\]").unwrap();
    for cap in wiki.captures_iter(&body) {
        let m = cap.get(0).unwrap();
        if protected
            .iter()
            .any(|r| r.start <= m.start() && m.start() < r.end)
            || kind(&cap[1]).is_none()
        {
            continue;
        }
        let caption = cap[1]
            .split_once('|')
            .map(|(_, s)| s.to_string())
            .filter(|s| !s.chars().all(|c| c.is_ascii_digit() || c == 'x'))
            .unwrap_or_default();
        references.push((m.start(), m.end(), cap[1].to_string(), true, caption));
    }
    references.sort_by_key(|v| v.0);
    references.dedup_by_key(|v| v.0);
    let mut deps = Vec::new();
    let mut media = Vec::new();
    let mut replacements = Vec::new();
    let mut assets = Vec::new();
    let mut missing = Vec::new();
    for (start, end, target, wiki, caption) in references {
        if target.starts_with("https://") || target.starts_with("http://") {
            continue;
        }
        if let Some(asset) = resolve(root, path, &target, wiki, lookup) {
            let stamp = stamp(&asset);
            let hash = digest(c, &asset, &stamp)?;
            let size = fs::metadata(&asset).map_err(|e| e.to_string())?.len();
            let media_url =
                Url::from_file_path(Path::new(&crate::sources::display_local_path(&asset)))
                    .map_err(|_| "附件路径无法转换")?
                    .to_string();
            if !media.iter().any(|m: &Media| m.url == media_url) {
                media.push(Media {
                    kind: kind(&target).unwrap_or("file").into(),
                    url: media_url,
                    preview_url: String::new(),
                });
                assets.push((hash.clone(), size));
                deps.push(Dependency {
                    target: target.clone(),
                    path: asset.to_string_lossy().into_owned(),
                    stamp,
                    digest: hash,
                });
            }
            replacements.push((start, end, caption));
        } else {
            deps.push(Dependency {
                target: target.clone(),
                path: String::new(),
                stamp: String::new(),
                digest: String::new(),
            });
            missing.push(target);
        }
    }
    for (start, end, caption) in replacements.into_iter().rev() {
        body.replace_range(start..end, &caption);
    }
    body = regex::Regex::new(r"\n(?:[ \t]*\n){2,}")
        .unwrap()
        .replace_all(body.trim(), "\n\n")
        .into_owned();
    if body.is_empty() {
        if deps.is_empty() {
            return Err("素材尚无正文或附件，等待写入完成".into());
        }
        body = if telegram {
            "Telegram 附件素材".into()
        } else {
            path.file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        };
    }
    if !missing.is_empty() {
        body.push_str("\n\n原件中的以下附件尚未在本地找到：\n");
        body.push_str(
            &missing
                .iter()
                .map(|s| format!("- {s}"))
                .collect::<Vec<_>>()
                .join("\n"),
        );
    }
    let fingerprint = storage::hash(
        json!({"origin":url,"body":body,"assets":assets})
            .to_string()
            .as_bytes(),
    );
    let relative = relative(root, path);
    let vault = root.file_name().unwrap_or_default().to_string_lossy();
    let mut uri = Url::parse("obsidian://open").unwrap();
    uri.query_pairs_mut()
        .append_pair("vault", &vault)
        .append_pair("file", relative.strip_suffix(".md").unwrap_or(&relative));
    let uri = uri.to_string().replace('+', "%20");
    let mut post = Post {
        id: if xid.is_empty() {
            format!("obsidian-{}", &fingerprint[..24])
        } else {
            xid
        },
        text: body,
        url: if url.is_empty() { uri.clone() } else { url },
        source: if telegram {
            "telegram"
        } else if path
            .strip_prefix(root)
            .is_ok_and(|p| p.starts_with("X/喜欢"))
        {
            "likes"
        } else {
            "bookmarks"
        }
        .into(),
        media: media.clone(),
        all_media: media,
        published_at: text(&fm, &["date", "发布时间", "published_at"]),
        author_name: text(&fm, &["author", "作者"]),
        thread_format: 2,
        ..Default::default()
    };
    if let Some((name, url, _)) = origin {
        if post.author_name.is_empty() {
            post.author_name = name.clone();
        }
        post.origin = Some(crate::collection_models::Origin { name, url });
    }
    post.author_handle = text(&fm, &["author_handle"]);
    if post.author_handle.is_empty() {
        post.author_handle = text(&fm, &["author_url"])
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or("")
            .into();
    }
    if !missing.is_empty() {
        post.content_status = "partial".into();
    }
    if telegram {
        if let Some(cap) = tg.captures(&post.url) {
            post.id = cap[2].into();
        }
    }
    post.reply_count = text(&fm, &["replies"]).parse().unwrap_or(0);
    if post.reply_count > 0 {
        post.thread_status = "limited".into();
        post.thread_error = "历史原件未包含回复正文".into();
    }
    post.links = regex::Regex::new(r#"https?://[^\s<>\[\]()"\u{200b}]+"#)
        .unwrap()
        .find_iter(&post.text)
        .map(|m| m.as_str().to_string())
        .collect();
    post.links.push(uri);
    let mut seen = HashSet::new();
    post.links.retain(|s| seen.insert(s.clone()));
    let state = text(&fm, &["状态", "status"]);
    let status = match state.as_str() {
        "已读" | "read" => "read",
        "进行中" | "阅读中" | "in_progress" => "in_progress",
        "放弃" | "abandoned" => "abandoned",
        _ => "unread",
    }
    .to_string();
    let tags_value = fm.get("tags").or_else(|| fm.get("标签"));
    let mut tags = Vec::new();
    if let Some(value) = tags_value {
        let values = value
            .as_sequence()
            .cloned()
            .unwrap_or_else(|| vec![value.clone()]);
        for value in values {
            if let Some(s) = value.as_str() {
                let s = s.trim().trim_start_matches('#');
                if !s.is_empty()
                    && s.chars().count() <= 80
                    && !tags.contains(&s.to_string())
                    && tags.len() < 50
                {
                    tags.push(s.to_string());
                }
            }
        }
    }
    let collected = millis(&text(
        &fm,
        &["创建日期", "collected_at", "collected", "captured_at"],
    ))
    .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
    if stamp(path) != before {
        return Err("素材仍在写入，下一轮重试".into());
    }
    if serde_json::to_vec(&post).map_err(|e| e.to_string())?.len() > 1536 * 1024 {
        return Err("阅读缓存超过单条容量，保留原件并等待拆分".into());
    }
    Ok(Note {
        post,
        file_hash: storage::hash(&bytes),
        fingerprint,
        identity,
        dependencies: deps,
        status,
        tags,
        collected,
    })
}
