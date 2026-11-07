//! Explicit desktop source writes. Preview snapshots and recovery copies stay in Hub.
use super::*;
use std::io::Write;

const MAX_BYTES: usize = 2 * 1024 * 1024;
static WRITE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct Candidate {
    id: String,
    kind: String,
    proposal_id: String,
    origin: String,
    library_id: String,
    library_name: String,
    provider: String,
    document_id: String,
    page_id: String,
    title: String,
    path: String,
    add_tag: String,
    remove_tag: String,
}

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
struct BlockChange {
    id: String,
    before: String,
    after: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Plan {
    candidate: Candidate,
    before: String,
    after: String,
    changes: Vec<BlockChange>,
    append: String,
    source_path: String,
    created_at: i64,
}

fn hash(value: &impl Serialize) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(value).unwrap_or_default())
    )
}

fn text<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args[key]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() < 512)
        .ok_or_else(|| format!("缺少有效的 {key}"))
}

fn valid_tag(tag: &str) -> bool {
    !tag.is_empty()
        && tag.chars().count() <= 80
        && tag
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '/'))
        && !tag.starts_with('/')
        && !tag.ends_with('/')
        && !tag.contains("//")
        && tag.chars().any(|c| c.is_alphabetic() || c == '_')
}

fn candidates(c: &Connection, kind: &str, proposal_id: &str) -> Result<Vec<Candidate>, String> {
    let table = match kind {
        "assignment" => "tag_assignment_proposals",
        "governance" => "tag_governance_proposals",
        _ => return Err("写回类型无效".into()),
    };
    let raw: (String, String) = c
        .query_row(
            &format!("SELECT status,proposal_json FROM {table} WHERE id=?1"),
            [proposal_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| "找不到已批准建议")?;
    if raw.0 != "accepted" {
        return Err("只有已批准的建议可以写回来源".into());
    }
    let mut entries = Vec::new();
    if kind == "assignment" {
        let mut st = c.prepare("SELECT h.library_id,l.name,h.provider,h.document_id,h.page_id,d.title,d.path,h.tag,'' FROM hub_content_tags h JOIN libraries l ON l.id=h.library_id AND l.enabled=1 JOIN documents d ON d.space_id=h.library_id AND d.id=h.document_id AND d.provider=h.provider WHERE h.proposal_id=?1").map_err(|e|e.to_string())?;
        let rows = st
            .query_map([proposal_id], candidate_row)
            .map_err(|e| e.to_string())?;
        for row in rows {
            entries.push(row.map_err(|e| e.to_string())?);
        }
    } else {
        // Only concrete canonical replacements can be represented in a source note.
        // Parent/child and split decisions remain relationships, not bulk tag edits.
        let mut st = c.prepare("WITH source_tags AS (
          SELECT space_id library_id,'obsidian' provider,document_id,'' page_id,normalized_tag FROM obsidian_tags
          UNION SELECT space_id,'craft',document_id,page_id,normalized_tag FROM craft_tags
        ) SELECT DISTINCT s.library_id,l.name,s.provider,s.document_id,s.page_id,d.title,d.path,r.target_tag_id,r.source_tag_id
          FROM tag_taxonomy_relations r JOIN source_tags s ON s.normalized_tag=r.source_tag_id
          JOIN libraries l ON l.id=s.library_id AND l.enabled=1
          JOIN documents d ON d.space_id=s.library_id AND d.id=s.document_id AND d.provider=s.provider
          WHERE r.proposal_id=?1 AND r.relation_type IN ('alias','merge','retire') AND r.target_tag_id<>''
          ORDER BY s.library_id,s.document_id,s.page_id,r.source_tag_id,r.target_tag_id LIMIT 1001").map_err(|e|e.to_string())?;
        let rows = st
            .query_map([proposal_id], candidate_row)
            .map_err(|e| e.to_string())?;
        for row in rows {
            entries.push(row.map_err(|e| e.to_string())?);
        }
        if entries.len() > 1000 {
            return Err("此建议影响超过 1000 项，请拆分治理建议后写回".into());
        }
    }
    for entry in &mut entries {
        if entry.provider == "craft" && !entry.page_id.eq_ignore_ascii_case(&entry.document_id) {
            let page_title: Option<String> = c.query_row(
                "SELECT page_title FROM content_items WHERE space_id=?1 AND document_id=?2 AND page_id=?3 COLLATE NOCASE AND page_title<>'' AND COALESCE(source_item_id,'')='' AND content_type IN ('document','craft_subpage','markdown_section') ORDER BY ordinal,id LIMIT 1",
                params![entry.library_id,entry.document_id,entry.page_id], |r|r.get(0),
            ).optional().map_err(|e|e.to_string())?;
            if let Some(title) = page_title {
                entry.title = title;
            }
        }
        entry.kind = kind.into();
        entry.proposal_id = proposal_id.into();
        entry.origin = hash(&raw);
        entry.id = hash(&(
            kind,
            proposal_id,
            &entry.library_id,
            &entry.document_id,
            &entry.page_id,
            &entry.add_tag,
            &entry.remove_tag,
        ));
    }
    Ok(entries)
}

fn candidate_row(r: &Row<'_>) -> rusqlite::Result<Candidate> {
    Ok(Candidate {
        id: String::new(),
        kind: String::new(),
        proposal_id: String::new(),
        origin: String::new(),
        library_id: r.get(0)?,
        library_name: r.get(1)?,
        provider: r.get(2)?,
        document_id: r.get(3)?,
        page_id: r.get(4)?,
        title: r.get(5)?,
        path: r.get(6)?,
        add_tag: r.get(7)?,
        remove_tag: r.get(8)?,
    })
}

fn revalidate(c: &Connection, old: &Candidate) -> Result<Candidate, String> {
    let current = candidates(c, &old.kind, &old.proposal_id)?
        .into_iter()
        .find(|v| v.id == old.id)
        .ok_or("建议或来源标签已变化，请重新预览")?;
    if hash(&current) != hash(old) {
        return Err("建议或笔记定位已变化，请重新预览".into());
    }
    if !valid_tag(&current.add_tag)
        || (!current.remove_tag.is_empty() && !valid_tag(&current.remove_tag))
    {
        return Err("标签名称无法安全写入来源，请先规范名称".into());
    }
    if current.provider == "craft"
        && [&current.add_tag, &current.remove_tag]
            .iter()
            .filter(|tag| !tag.is_empty())
            .any(|tag| craft_markdown_tags(&format!("#{tag}")) != vec![tag.to_string()])
    {
        return Err("此标签名称无法通过当前 Craft 标签格式可靠识别，请先规范名称".into());
    }
    // Refuse ambiguous or chained mappings rather than applying a partial canonical target.
    if !current.remove_tag.is_empty() {
        let conflict: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM tag_taxonomy_relations WHERE relation_type IN ('alias','merge','retire') AND target_tag_id<>'' AND ((source_tag_id=?1 AND target_tag_id<>?2) OR source_tag_id=?2))",params![current.remove_tag,current.add_tag],|r|r.get(0)).map_err(|e|e.to_string())?;
        if conflict {
            return Err("规范标签存在冲突或连续映射，请先整理 Hub 标签关系".into());
        }
    }
    Ok(current)
}

fn local_path(c: &Connection, entry: &Candidate) -> Result<(PathBuf, PathBuf), String> {
    let location: String = c
        .query_row(
            "SELECT location FROM libraries WHERE id=?1 AND provider='obsidian' AND enabled=1",
            [&entry.library_id],
            |r| r.get(0),
        )
        .map_err(|_| "Obsidian 资料库不可用")?;
    let relative = Path::new(&entry.path);
    if relative
        .components()
        .any(|p| !matches!(p, Component::Normal(_)))
        || relative
            .extension()
            .and_then(|s| s.to_str())
            .is_none_or(|s| !s.eq_ignore_ascii_case("md"))
        || obsidian_document_id(&entry.path) != entry.document_id
    {
        return Err("笔记路径或身份无效".into());
    }
    let root = Path::new(&location)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let path = root
        .join(relative)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !path.starts_with(&root)
        || obsidian_path_is_excluded(&entry.path, &library_excluded_paths(c, &entry.library_id)?)
    {
        return Err("笔记不在允许写入的资料库范围内".into());
    }
    Ok((root, path))
}

// Only plain Markdown text ranges are eligible. Code, links, images and HTML are untouched.
fn replace_inline(body: &str, old: &str, new: &str) -> String {
    use pulldown_cmark::{Event, Parser, Tag, TagEnd};
    if old.is_empty() {
        return body.into();
    }
    let mut excluded = 0usize;
    let mut edits = Vec::new();
    for (event, range) in Parser::new(body).into_offset_iter() {
        match event {
            Event::Start(Tag::CodeBlock(_) | Tag::Link { .. } | Tag::Image { .. }) => excluded += 1,
            Event::End(TagEnd::CodeBlock | TagEnd::Link | TagEnd::Image) => {
                excluded = excluded.saturating_sub(1)
            }
            Event::Text(value)
                if excluded == 0 && body.get(range.clone()) == Some(value.as_ref()) =>
            {
                let value = value.as_ref();
                for (offset, _) in value.match_indices('#') {
                    let previous = body[..range.start + offset].chars().next_back();
                    if previous
                        .is_some_and(|c| !c.is_whitespace() && !"([{，。；：！？、".contains(c))
                    {
                        continue;
                    }
                    let tail = &value[offset + 1..];
                    let end = tail
                        .find(|c: char| !(c.is_alphanumeric() || matches!(c, '_' | '-' | '/')))
                        .unwrap_or(tail.len());
                    if tail[..end].to_lowercase() == old.to_lowercase() {
                        edits.push((range.start + offset + 1, range.start + offset + 1 + end));
                    }
                }
            }
            _ => {}
        }
    }
    let mut result = body.to_string();
    for (start, end) in edits.into_iter().rev() {
        result.replace_range(start..end, new);
    }
    result
}

fn transform_markdown(before: &str, add: &str, remove: &str) -> Result<String, String> {
    if !valid_tag(add) || (!remove.is_empty() && !valid_tag(remove)) {
        return Err("标签名称无效".into());
    }
    let bom = if before.starts_with('\u{feff}') {
        "\u{feff}"
    } else {
        ""
    };
    let content = before.strip_prefix('\u{feff}').unwrap_or(before);
    let nl = if content.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let open = if content.starts_with("---\r\n") {
        5
    } else if content.starts_with("---\n") {
        4
    } else {
        0
    };
    let (front, body, closing) = if open > 0 {
        let mut end = open;
        let mut found = None;
        for line in content[open..].split_inclusive('\n') {
            if matches!(line.trim_end_matches(['\r', '\n']), "---" | "...") {
                found = Some((end, end + line.len()));
                break;
            }
            end += line.len();
        }
        let (end, after) = found.ok_or("YAML 属性未闭合，未修改笔记")?;
        (&content[open..end], &content[after..], &content[end..after])
    } else {
        ("", content, "")
    };
    let mut tags = Vec::<String>::new();
    let mut span = None;
    if open > 0 {
        let yaml: serde_yaml::Value =
            serde_yaml::from_str(front).map_err(|_| "YAML 属性格式无效，未修改笔记")?;
        if !yaml.is_null() && !yaml.is_mapping() {
            return Err("YAML 属性必须是对象".into());
        }
        if let Some(mapping) = yaml.as_mapping() {
            for (key, value) in mapping {
                if key.as_str().is_some_and(|s| {
                    s.eq_ignore_ascii_case("tags") || s.eq_ignore_ascii_case("tag")
                }) {
                    if span.is_some() {
                        return Err("同时存在多种标签属性，请先统一为 tags".into());
                    }
                    match value {
                        serde_yaml::Value::Null => {}
                        serde_yaml::Value::String(s) => tags.extend(
                            s.split([',', ' '])
                                .filter(|s| !s.is_empty())
                                .map(|s| s.trim_start_matches('#').to_string()),
                        ),
                        serde_yaml::Value::Sequence(values) => {
                            for value in values {
                                tags.push(
                                    value
                                        .as_str()
                                        .ok_or("标签属性含非文本值")?
                                        .trim_start_matches('#')
                                        .to_string(),
                                );
                            }
                        }
                        _ => return Err("标签属性格式不支持".into()),
                    }
                    // Locate the exact top-level field; preserve every unrelated property byte.
                    let key = key.as_str().unwrap();
                    let mut offset = 0;
                    let mut start = None;
                    let mut end = front.len();
                    for line in front.split_inclusive('\n') {
                        let top = !line.starts_with([' ', '\t'])
                            && !line.trim().is_empty()
                            && !line.trim_start().starts_with('#');
                        if start.is_none()
                            && line.strip_prefix(key).is_some_and(|s| s.starts_with(':'))
                        {
                            start = Some(offset);
                        } else if start.is_some() && top && !line.starts_with('-') {
                            end = offset;
                            break;
                        }
                        offset += line.len();
                    }
                    span = Some((
                        start.ok_or("标签属性使用了复杂 YAML 写法，请先改为普通 tags 字段")?,
                        end,
                    ));
                }
            }
        }
    }
    let has =
        |items: &[String], tag: &str| items.iter().any(|t| t.to_lowercase() == tag.to_lowercase());
    if remove.is_empty() && has(&obsidian_markdown_tags(before), add) {
        return Ok(before.into());
    }
    if !remove.is_empty() && !has(&obsidian_markdown_tags(before), remove) {
        return Ok(before.into());
    }
    tags.retain(|t| remove.is_empty() || t.to_lowercase() != remove.to_lowercase());
    if !has(&tags, add) {
        tags.push(add.into());
    }
    let field = format!(
        "tags: {}{nl}",
        serde_json::to_string(&tags).map_err(|e| e.to_string())?
    );
    let mut front = front.to_string();
    if let Some((start, end)) = span {
        front.replace_range(start..end, &field);
    } else {
        front.push_str(&field);
    }
    let body = replace_inline(body, remove, add);
    let after = if open > 0 {
        format!("{bom}---{nl}{front}{closing}{body}")
    } else {
        format!("{bom}---{nl}{front}---{nl}{body}")
    };
    let yaml = after.strip_prefix('\u{feff}').unwrap_or(&after);
    let yaml = &yaml[if yaml.starts_with("---\r\n") { 5 } else { 4 }..];
    let yaml_end = yaml
        .split_inclusive('\n')
        .scan(0usize, |offset, line| {
            let start = *offset;
            *offset += line.len();
            Some((start, line))
        })
        .find(|(_, line)| matches!(line.trim_end_matches(['\r', '\n']), "---" | "..."))
        .map(|(offset, _)| offset)
        .ok_or("修改后 YAML 未闭合")?;
    serde_yaml::from_str::<serde_yaml::Value>(&yaml[..yaml_end])
        .map_err(|_| "标签属性依赖 YAML 锚点等复杂结构，无法安全写回")?;
    if !remove.is_empty() && has(&obsidian_markdown_tags(&after), remove) {
        return Err("原标签含无法安全替换的写法，请在来源中修改；笔记尚未写入".into());
    }
    Ok(after)
}

fn page_text_blocks(
    value: &Value,
    root: bool,
    out: &mut Vec<(String, String)>,
) -> Result<(), String> {
    if !root
        && (matches!(value["type"].as_str(), Some("page" | "collectionItem"))
            || matches!(value["textStyle"].as_str(), Some("page" | "card")))
    {
        return Ok(());
    }
    if matches!(
        value["type"].as_str(),
        Some("text" | "page" | "collectionItem")
    ) {
        let markdown = value["markdown"]
            .as_str()
            .or_else(|| value["title"]["markdown"].as_str());
        if let (Some(id), Some(markdown)) = (value["id"].as_str(), markdown) {
            out.push((id.into(), markdown.into()));
        }
    }
    if let Some(items) = value["content"].as_array() {
        for child in items {
            page_text_blocks(child, false, out)?;
        }
    }
    Ok(())
}

async fn craft_snapshot(
    state: &State<'_, AppState>,
    entry: &Candidate,
) -> Result<Vec<(String, String)>, String> {
    if !valid_craft_block_id(&entry.document_id) || !valid_craft_block_id(&entry.page_id) {
        return Err("Craft 页面定位无效".into());
    }
    let session = session_for_space(state, &entry.library_id)?;
    let client = reqwest::Client::new();
    read_craft_page_snapshot(&client, &session, &entry.page_id, 71000).await
}

async fn read_craft_page_snapshot(
    client: &reqwest::Client,
    session: &McpSession,
    page_id: &str,
    request: u64,
) -> Result<Vec<(String, String)>, String> {
    // A parent document's block response may omit a nested page. Read the exact
    // stable page identity, then require that identity at the response root.
    let response = call_craft_read_raw(
        client,
        session,
        &format!(
            "blocks get --id {} --depth -1 --format json",
            craft_cli_quote(page_id)
        ),
        request,
    )
    .await?;
    if response["isError"] == true {
        return Err("Craft 未能读取目标页面，请检查来源连接".into());
    }
    let value = tool_result_json(&response);
    craft_snapshot_blocks(&value, page_id)
}

fn craft_snapshot_blocks(value: &Value, page_id: &str) -> Result<Vec<(String, String)>, String> {
    if serde_json::to_vec(value).map_err(|e| e.to_string())?.len() > MAX_BYTES {
        return Err("此 Craft 页面过大，暂不支持写回".into());
    }
    // Refuse split pages: a partial snapshot cannot authorize a source edit.
    if next_page_cursor_from_value(value).is_some() || response_claims_more_pages(value) {
        return Err("此 Craft 页面返回分页内容，暂不能形成完整写回预览".into());
    }
    let roots = value.get("data").unwrap_or(value);
    let page = if let Some(roots) = roots.as_array() {
        if roots.len() != 1 {
            return Err("Craft 返回的目标页面不唯一，已停止预览".into());
        }
        &roots[0]
    } else {
        roots
    };
    if !page["id"]
        .as_str()
        .is_some_and(|id| id.eq_ignore_ascii_case(page_id))
    {
        return Err("Craft 返回的页面与所选页面不一致，请重新同步后核对来源".into());
    }
    if !(matches!(page["type"].as_str(), Some("page" | "collectionItem"))
        || matches!(page["textStyle"].as_str(), Some("page" | "card")))
    {
        return Err("Craft 目标已不是页面，请重新同步后核对来源".into());
    }
    let mut blocks = Vec::new();
    page_text_blocks(page, true, &mut blocks)?;
    if blocks.is_empty() {
        return Err("Craft 未返回可核验的页面正文".into());
    }
    Ok(blocks)
}

async fn preview(
    path: &PathBuf,
    state: &State<'_, AppState>,
    args: &Value,
) -> Result<Value, String> {
    let entry = {
        let c = open_database(path)?;
        candidates(&c, text(args, "kind")?, text(args, "proposalId")?)?
            .into_iter()
            .find(|v| v.id == args["candidateId"].as_str().unwrap_or_default())
            .ok_or("写回项已变化，请刷新清单")?
    };
    let entry = {
        let c = open_database(path)?;
        revalidate(&c, &entry)?
    };
    let mut plan = Plan {
        candidate: entry.clone(),
        before: String::new(),
        after: String::new(),
        changes: Vec::new(),
        append: String::new(),
        source_path: String::new(),
        created_at: now_timestamp(),
    };
    match entry.provider.as_str() {
        "obsidian" => {
            let (_, file) = {
                let c = open_database(path)?;
                local_path(&c, &entry)?
            };
            if fs::metadata(&file).map_err(|e| e.to_string())?.len() > MAX_BYTES as u64 {
                return Err("笔记超过 2 MB，暂不支持写回".into());
            }
            plan.before = fs::read_to_string(&file).map_err(|e| e.to_string())?;
            plan.after = transform_markdown(&plan.before, &entry.add_tag, &entry.remove_tag)?;
            plan.source_path = file.to_string_lossy().into();
        }
        "craft" => {
            let session = session_for_space(state, &entry.library_id)?;
            if !craft_tool_names(&reqwest::Client::new(), &session, 70999)
                .await?
                .contains("craft_write")
            {
                return Err("此 Craft 连接没有写入权限，请在连接设置中启用写入后重新连接".into());
            }
            let blocks = craft_snapshot(state, &entry).await?;
            plan.before = serde_json::to_string(&blocks).map_err(|e| e.to_string())?;
            let tags = blocks
                .iter()
                .flat_map(|(_, body)| craft_markdown_tags(body))
                .collect::<Vec<_>>();
            let has = |tag: &str| tags.iter().any(|t| t.to_lowercase() == tag.to_lowercase());
            if entry.remove_tag.is_empty() {
                if !has(&entry.add_tag) {
                    plan.append = format!("#{}", entry.add_tag);
                }
            } else if has(&entry.remove_tag) {
                for (id, before) in &blocks {
                    let after = replace_inline(before, &entry.remove_tag, &entry.add_tag);
                    if after != *before {
                        plan.changes.push(BlockChange {
                            id: id.clone(),
                            before: before.clone(),
                            after,
                        });
                    }
                }
                if plan.changes.is_empty() {
                    return Err("未找到可安全替换的原标签，请在 Craft 中修改".into());
                }
            }
        }
        _ => return Err("此来源暂不支持标签写回".into()),
    }
    let noop = if entry.provider == "obsidian" {
        plan.before == plan.after
    } else {
        plan.append.is_empty() && plan.changes.is_empty()
    };
    let id = format!("writeback-{:032x}", rand::random::<u128>());
    let token = hash(&plan);
    let c = open_database(path)?;
    c.execute("INSERT INTO tag_source_writebacks(id,plan_json,status,created_at,updated_at) VALUES (?1,?2,'preview',?3,?3)",params![id,serde_json::to_string(&plan).map_err(|e|e.to_string())?,plan.created_at]).map_err(|e|e.to_string())?;
    let changes = if entry.provider == "obsidian" {
        json!([{"before":plan.before,"after":plan.after}])
    } else {
        json!(plan.changes)
    };
    Ok(
        json!({"id":id,"token":token,"candidate":entry,"noop":noop,"changes":changes,"append":plan.append,"expiresAt":plan.created_at+1800}),
    )
}

fn atomic_local_write(file: &Path, before: &str, after: &str, id: &str) -> Result<(), String> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(4);
    }
    let mut guard = options
        .open(file)
        .map_err(|e| format!("笔记正在被其他程序使用：{e}"))?;
    let mut current = String::new();
    guard
        .read_to_string(&mut current)
        .map_err(|e| e.to_string())?;
    if current != before {
        return Err("原笔记已变化，请重新预览".into());
    }
    let temporary = file.with_file_name(format!(".{id}.tmp"));
    let mut created = false;
    let result = (|| {
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        created = true;
        output
            .write_all(after.as_bytes())
            .and_then(|_| output.sync_all())
            .map_err(|e| e.to_string())?;
        fs::set_permissions(
            &temporary,
            fs::metadata(file).map_err(|e| e.to_string())?.permissions(),
        )
        .map_err(|e| e.to_string())?;
        drop(output);
        fs::rename(&temporary, file).map_err(|e| format!("无法替换笔记文件，原文件仍保留：{e}"))
    })();
    if created && result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn save_result(path: &PathBuf, id: &str, status: &str, result: &Value) -> Result<(), String> {
    open_database(path)?
        .execute(
            "UPDATE tag_source_writebacks SET status=?2,result_json=?3,updated_at=?4 WHERE id=?1",
            params![id, status, result.to_string(), now_timestamp()],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

async fn apply(
    app: &AppHandle,
    state: &State<'_, AppState>,
    path: &PathBuf,
    args: &Value,
) -> Result<Value, String> {
    let _lock = WRITE_LOCK.lock().await;
    let id = text(args, "id")?;
    let (raw, status, result): (String, String, String) = open_database(path)?
        .query_row(
            "SELECT plan_json,status,result_json FROM tag_source_writebacks WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|_| "找不到写回预览")?;
    let plan: Plan = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    if text(args, "token")? != hash(&plan) {
        return Err("写回确认与预览不一致".into());
    }
    if status == "written" || status == "unchanged" {
        return serde_json::from_str(&result).map_err(|e| e.to_string());
    }
    if status != "preview" {
        return Err("此写回已尝试，可能已部分完成。请重新预览当前来源，勿重复提交旧操作".into());
    }
    if now_timestamp() - plan.created_at > 1800 {
        return Err("写回预览已过期，请重新预览".into());
    }
    {
        let c = open_database(path)?;
        revalidate(&c, &plan.candidate)?;
    }
    // Claim before any external effect. A lost response is never automatically replayed.
    let claimed=open_database(path)?.execute("UPDATE tag_source_writebacks SET status='writing',updated_at=?2 WHERE id=?1 AND status='preview'",params![id,now_timestamp()]).map_err(|e|e.to_string())?;
    if claimed != 1 {
        return Err("此写回已由其他窗口处理".into());
    }
    let outcome = write_source(app, state, path, id, &plan).await;
    match outcome {
        Ok(result) => {
            let status = if result["changed"] == true {
                "written"
            } else {
                "unchanged"
            };
            if let Err(e) = save_result(path, id, status, &result) {
                return Ok(
                    json!({"status":"written","changed":result["changed"],"warning":format!("来源已验证，但记录保存失败：{e}。请勿重复写入。"),"id":id}),
                );
            }
            let _ = app.emit("hub-content-tags-changed", ());
            Ok(result)
        }
        Err(error) => {
            let _ = save_result(path, id, "needs_review", &json!({"error":error}));
            Err(format!(
                "{error}。原文快照已保存在 Hub 写回记录 {id}；请重新预览后核对。"
            ))
        }
    }
}

async fn write_source(
    app: &AppHandle,
    state: &State<'_, AppState>,
    path: &PathBuf,
    id: &str,
    plan: &Plan,
) -> Result<Value, String> {
    let entry = &plan.candidate;
    let mut warning = String::new();
    let changed = match entry.provider.as_str() {
        "obsidian" => {
            let (root, file) = {
                let c = open_database(path)?;
                local_path(&c, entry)?
            };
            if file.to_string_lossy() != plan.source_path {
                return Err("来源路径已变化".into());
            }
            if fs::read_to_string(&file).map_err(|e| e.to_string())? != plan.before {
                return Err("原笔记已变化，请重新预览".into());
            }
            if plan.before == plan.after {
                return Ok(json!({"id":id,"status":"unchanged","changed":false}));
            }
            atomic_local_write(&file, &plan.before, &plan.after, id)?;
            if fs::read_to_string(&file).map_err(|e| e.to_string())? != plan.after {
                return Err("来源已写入，但读回内容不一致".into());
            }
            if let Err(e) = sync_obsidian_changed_paths_database(
                path,
                &entry.library_id,
                &root,
                &HashSet::from([file]),
            ) {
                warning = format!("标签已写入，Hub 索引稍后刷新：{e}");
            } else if let Err(e) = flush_index_jobs(app, state).await {
                warning = format!("标签已写入，搜索索引稍后刷新：{e}");
            }
            true
        }
        "craft" => {
            let before = craft_snapshot(state, entry).await?;
            if serde_json::to_string(&before).map_err(|e| e.to_string())? != plan.before {
                return Err("Craft 页面内容已变化，请重新预览".into());
            }
            if plan.append.is_empty() && plan.changes.is_empty() {
                return Ok(json!({"id":id,"status":"unchanged","changed":false}));
            }
            let client = reqwest::Client::new();
            let session = session_for_space(state, &entry.library_id)?;
            for (i, change) in plan.changes.iter().enumerate() {
                let current = craft_snapshot(state, entry).await?;
                if !current
                    .iter()
                    .any(|(id, body)| id == &change.id && body == &change.before)
                {
                    return Err("Craft 待修改块已变化，已停止后续写入".into());
                }
                let payload = json!({"id":change.id,"markdown":change.after});
                call_craft_tool_raw(&client,&session,"craft_write",json!({"command":format!("blocks update --json {}",craft_cli_quote(&payload.to_string()))}),73000+i as u64).await?;
            }
            if !plan.append.is_empty() {
                call_craft_tool_raw(&client,&session,"craft_write",json!({"command":craft_task_detail_markdown_command(&entry.page_id,&plan.append)}),74000).await?;
            }
            let after = craft_snapshot(state, entry).await?;
            for change in &plan.changes {
                if !after
                    .iter()
                    .any(|(id, body)| id == &change.id && body == &change.after)
                {
                    return Err("Craft 已接收写入，但未能核验全部修改".into());
                }
            }
            if !after.iter().any(|(_, body)| {
                craft_markdown_tags(body)
                    .iter()
                    .any(|tag| tag.to_lowercase() == entry.add_tag.to_lowercase())
            }) {
                return Err("Craft 已接收写入，但读回未找到目标标签".into());
            }
            if !entry.remove_tag.is_empty()
                && after.iter().any(|(_, body)| {
                    craft_markdown_tags(body)
                        .iter()
                        .any(|tag| tag.to_lowercase() == entry.remove_tag.to_lowercase())
                })
            {
                return Err("Craft 中仍有原标签，请核对部分完成的写回".into());
            }
            warning = "已读回确认 Craft 标签；下次来源同步后更新 Hub 来源标签索引。".into();
            true
        }
        _ => return Err("不支持的来源".into()),
    };
    Ok(json!({"id":id,"status":"written","changed":changed,"warning":warning}))
}

pub(super) async fn ui(
    app: &AppHandle,
    state: &State<'_, AppState>,
    args: &Value,
) -> Result<Value, String> {
    let path = database_path(app)?;
    match text(args, "action")? {
        "source_writeback_list" => {
            let entries = candidates(
                &open_database(&path)?,
                text(args, "kind")?,
                text(args, "proposalId")?,
            )?;
            let offset = args["offset"].as_u64().unwrap_or(0).min(1000) as usize;
            let total = entries.len();
            Ok(
                json!({"items":entries.into_iter().skip(offset).take(20).collect::<Vec<_>>(),"total":total,"nextOffset":if offset+20<total{Some(offset+20)}else{None}}),
            )
        }
        "source_writeback_preview" => preview(&path, state, args).await,
        "source_writeback_apply" => apply(app, state, &path, args).await,
        "source_writeback_history" => {
            let c = open_database(&path)?;
            let mut st=c.prepare("SELECT id,status,updated_at,result_json FROM tag_source_writebacks WHERE json_extract(plan_json,'$.candidate.proposalId')=?1 AND json_extract(plan_json,'$.candidate.kind')=?2 AND status<>'preview' ORDER BY created_at DESC,id DESC LIMIT 30").map_err(|e|e.to_string())?;
            let rows=st.query_map(params![text(args,"proposalId")?,text(args,"kind")?],|r|Ok(json!({"id":r.get::<_,String>(0)?,"status":r.get::<_,String>(1)?,"updatedAt":r.get::<_,i64>(2)?,"result":serde_json::from_str::<Value>(&r.get::<_,String>(3)?).unwrap_or(Value::Null)}))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
            Ok(json!({"items":rows}))
        }
        "source_writeback_record" => {
            let c = open_database(&path)?;
            let (raw, status, result): (String, String, String) = c
                .query_row(
                    "SELECT plan_json,status,result_json FROM tag_source_writebacks WHERE id=?1",
                    [text(args, "id")?],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .map_err(|e| e.to_string())?;
            Ok(
                json!({"plan":serde_json::from_str::<Value>(&raw).map_err(|e|e.to_string())?,"status":status,"result":serde_json::from_str::<Value>(&result).map_err(|e|e.to_string())?}),
            )
        }
        _ => Err("未知的来源写回操作".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_frontmatter_without_changing_body_and_is_idempotent() {
        let before = "\u{feff}# 标题\r\n\r\n正文与 ![[附件.png]]\r\n";
        let after = transform_markdown(before, "项目/完成", "").unwrap();
        assert_eq!(
            after,
            "\u{feff}---\r\ntags: [\"项目/完成\"]\r\n---\r\n# 标题\r\n\r\n正文与 ![[附件.png]]\r\n"
        );
        assert_eq!(transform_markdown(&after, "项目/完成", "").unwrap(), after);
    }

    #[test]
    fn replaces_yaml_and_exact_inline_tags_preserving_other_properties() {
        let before = "---\ntitle: 'Keep: spacing'\naliases: [A, B]\ntags:\n  - old\n  - keep\nupdated: 2026-09-11\n---\n正文 #old 与 #old/child 和 #older。\n";
        let after = transform_markdown(before, "new", "old").unwrap();
        assert!(after.contains("title: 'Keep: spacing'\naliases: [A, B]\n"));
        assert!(after.contains("tags: [\"keep\",\"new\"]\nupdated: 2026-09-11\n"));
        assert!(after.ends_with("正文 #new 与 #old/child 和 #older。\n"));
    }

    #[test]
    fn markdown_replacement_excludes_code_links_images_and_escaped_text() {
        let before="#old\n\n`#old` [#old](https://site/#old) ![#old](image.png) \\#old\n\n```text\n#old\n```\n\n正常 #old。";
        let after = replace_inline(before, "old", "new");
        assert!(after.starts_with("#new\n"));
        assert!(after.contains("`#old` [#old](https://site/#old) ![#old](image.png) \\#old"));
        assert!(after.contains("```text\n#old\n```"));
        assert!(after.ends_with("正常 #new。"));
    }

    #[test]
    fn malformed_or_complex_yaml_is_rejected_without_a_write() {
        for before in [
            "---\ntags: [oops\n---\nbody",
            "---\ntags: [old]\nbody",
            "---\ntag: old\ntags: [old]\n---\nbody",
            "---\ntags: &taglist [old]\nother: *taglist\n---\nbody",
        ] {
            assert!(
                transform_markdown(before, "new", "old").is_err(),
                "{before}"
            );
        }
        assert!(!valid_tag("x; blocks delete --id y"));
        assert!(!valid_tag("x\ny"));
        assert!(!valid_tag("12"));
    }

    #[test]
    fn replacement_deduplicates_destination_and_handles_single_tag_property() {
        let after =
            transform_markdown("---\ntag: old, new, keep\n---\n正文 #old", "new", "old").unwrap();
        assert!(after.contains("tags: [\"new\",\"keep\"]"));
        assert!(after.ends_with("正文 #new"));
        assert_eq!(
            transform_markdown("正文 #new", "new", "old").unwrap(),
            "正文 #new"
        );
    }

    #[test]
    fn craft_snapshot_checks_root_identity_and_complete_page_scope() {
        let id = "16012723-860A-48D0-85DF-A832C0C21341";
        let page = json!({"id":id.to_ascii_lowercase(),"type":"page","markdown":"Page","content":[{"id":"body","type":"text","markdown":"#old"},{"id":"child","type":"page","markdown":"Child","content":[{"id":"nested","type":"text","markdown":"#other"}]}]});
        let blocks = craft_snapshot_blocks(&json!({"data":[page.clone()]}), id).unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[1], ("body".into(), "#old".into()));
        assert!(craft_snapshot_blocks(
            &json!({"data":[{"id":"wrong","type":"page","content":[page.clone()]}]}),
            id
        )
        .is_err());
        assert!(craft_snapshot_blocks(
            &json!({"data":[page.clone()],"nextCursor":"another-page"}),
            id
        )
        .unwrap_err()
        .contains("分页"));
        assert!(craft_snapshot_blocks(&json!({"data":[page.clone()],"hasMore":true}), id).is_err());
        assert!(craft_snapshot_blocks(&json!({"data":[page.clone(),page]}), id).is_err());
        assert!(craft_snapshot_blocks(
            &json!({"id":id,"type":"text","markdown":"ordinary block"}),
            id
        )
        .is_err());
    }

    #[test]
    fn craft_page_scope_does_not_include_child_pages_or_code_blocks() {
        let doc = json!({"id":"doc","type":"page","markdown":"Title","content":[
            {"id":"text","type":"text","markdown":"#old"},
            {"id":"code","type":"code","markdown":"#old"},
            {"id":"child","type":"page","markdown":"Child","content":[{"id":"nested","type":"text","markdown":"#old"}]},
            {"id":"card","type":"text","textStyle":"card","markdown":"#old","content":[]}
        ]});
        let mut blocks = Vec::new();
        page_text_blocks(&doc, true, &mut blocks).unwrap();
        assert_eq!(
            blocks,
            vec![
                ("doc".into(), "Title".into()),
                ("text".into(), "#old".into())
            ]
        );
        let child = &doc["content"][2];
        blocks.clear();
        page_text_blocks(child, true, &mut blocks).unwrap();
        assert_eq!(
            blocks,
            vec![
                ("child".into(), "Child".into()),
                ("nested".into(), "#old".into())
            ]
        );
    }

    struct Fixture {
        root: PathBuf,
        database: PathBuf,
        file: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "hub-source-writeback-{:032x}",
                rand::random::<u128>()
            ));
            fs::create_dir_all(&root).unwrap();
            let database = root.join("hub.sqlite3");
            let file = root.join("note.md");
            fs::write(&file, "正文 #old").unwrap();
            let c = open_database(&database).unwrap();
            c.execute("INSERT INTO libraries(id,provider,name,location,enabled,added_at) VALUES ('lib','obsidian','Vault',?1,1,1)",[root.to_string_lossy().as_ref()]).unwrap();
            c.execute("INSERT INTO documents(space_id,id,title,path,markdown,content_hash,indexed_at,provider) VALUES ('lib',?1,'Note','note.md','正文 #old','hash',1,'obsidian')",[obsidian_document_id("note.md")]).unwrap();
            c.execute_batch("INSERT INTO tag_assignment_proposals(id,tag,status,proposal_json,request_key,request_hash,created_at,updated_at) VALUES ('assignment','new','accepted','{}','assignment','hash',1,1);
                INSERT INTO tag_governance_proposals(id,schema_version,index_revision,status,summary,tag_ids_json,proposal_json,created_at,updated_at) VALUES ('governance','hub.tag-governance.v1','index','accepted','merge','[\"old\",\"new\"]','{}',1,1);
                INSERT INTO tag_taxonomy_relations(id,relation_type,source_tag_id,target_tag_id,proposal_id,recommendation_index,created_at) VALUES ('relation','merge','old','new','governance',0,1);").unwrap();
            c.execute("INSERT INTO obsidian_tags(space_id,document_id,tag,normalized_tag) VALUES ('lib',?1,'old','old')",[obsidian_document_id("note.md")]).unwrap();
            c.execute("INSERT INTO hub_content_tags(library_id,provider,document_id,page_id,tag,proposal_id) VALUES ('lib','obsidian',?1,'','new','assignment')",[obsidian_document_id("note.md")]).unwrap();
            Self {
                root,
                database,
                file,
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn lists_only_approved_memberships_and_detects_withdrawal() {
        let f = Fixture::new();
        let c = open_database(&f.database).unwrap();
        let entries = candidates(&c, "assignment", "assignment").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].add_tag, "new");
        assert!(entries[0].remove_tag.is_empty());
        assert!(revalidate(&c, &entries[0]).is_ok());
        c.execute(
            "UPDATE tag_assignment_proposals SET status='withdrawn' WHERE id='assignment'",
            [],
        )
        .unwrap();
        assert!(revalidate(&c, &entries[0]).is_err());
    }

    #[test]
    fn canonical_replacement_refuses_conflicting_targets() {
        let f = Fixture::new();
        let c = open_database(&f.database).unwrap();
        let entries = candidates(&c, "governance", "governance").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].remove_tag, "old");
        assert!(revalidate(&c, &entries[0]).is_ok());
        c.execute_batch("INSERT INTO tag_taxonomy_relations(id,relation_type,source_tag_id,target_tag_id,proposal_id,recommendation_index,created_at) VALUES ('conflict','alias','old','other','governance',1,1)").unwrap();
        assert!(revalidate(&c, &entries[0]).is_err());
    }

    #[test]
    fn local_path_checks_identity_traversal_and_disabled_libraries() {
        let f = Fixture::new();
        let c = open_database(&f.database).unwrap();
        let entry = candidates(&c, "assignment", "assignment")
            .unwrap()
            .remove(0);
        assert!(local_path(&c, &entry).is_ok());
        let mut invalid = entry.clone();
        invalid.path = "../outside.md".into();
        assert!(local_path(&c, &invalid).is_err());
        invalid = entry.clone();
        invalid.document_id = "other".into();
        assert!(local_path(&c, &invalid).is_err());
        c.execute("UPDATE libraries SET enabled=0", []).unwrap();
        assert!(local_path(&c, &entry).is_err());
    }

    #[test]
    fn atomic_write_preserves_newer_edits_and_never_removes_foreign_temp_files() {
        let f = Fixture::new();
        assert!(atomic_local_write(&f.file, "stale", "new", "test").is_err());
        assert_eq!(fs::read_to_string(&f.file).unwrap(), "正文 #old");
        let occupied = f.root.join(".test.tmp");
        fs::write(&occupied, "keep").unwrap();
        assert!(atomic_local_write(&f.file, "正文 #old", "new", "test").is_err());
        assert_eq!(fs::read_to_string(&occupied).unwrap(), "keep");
        atomic_local_write(&f.file, "正文 #old", "正文 #new", "success").unwrap();
        assert_eq!(fs::read_to_string(&f.file).unwrap(), "正文 #new");
    }

    #[test]
    fn migration_persists_backup_and_claim_allows_only_one_writer() {
        let f = Fixture::new();
        let c = open_database(&f.database).unwrap();
        c.execute("INSERT INTO tag_source_writebacks(id,plan_json,status,created_at,updated_at) VALUES ('one','{\"before\":\"original\"}','preview',1,1)",[]).unwrap();
        assert_eq!(c.execute("UPDATE tag_source_writebacks SET status='writing' WHERE id='one' AND status='preview'",[]).unwrap(),1);
        assert_eq!(c.execute("UPDATE tag_source_writebacks SET status='writing' WHERE id='one' AND status='preview'",[]).unwrap(),0);
        save_result(
            &f.database,
            "one",
            "needs_review",
            &json!({"error":"lost response"}),
        )
        .unwrap();
        let original:String=c.query_row("SELECT json_extract(plan_json,'$.before') FROM tag_source_writebacks WHERE id='one'",[],|r|r.get(0)).unwrap();
        assert_eq!(original, "original");
    }
}

#[cfg(test)]
mod live_contract_tests {
    use super::*;
    #[test]
    #[ignore = "Requires explicit library and document; reads remote Craft only"]
    fn live_craft_writeback_read_contract() {
        let library = std::env::var("HUB_WRITEBACK_TEST_LIBRARY").expect("explicit library");
        let document = std::env::var("HUB_WRITEBACK_TEST_DOCUMENT").expect("explicit document");
        let target_page =
            std::env::var("HUB_WRITEBACK_TEST_PAGE").unwrap_or_else(|_| document.clone());
        tauri::async_runtime::block_on(async {
            let client = reqwest::Client::new();
            let mut credential = load_credential(&library).expect("stored Craft connection");
            let token = refresh_access_token(&client, &mut credential)
                .await
                .expect("refresh connection");
            save_credential(&library, &credential).expect("save rotated credential");
            let authenticated = initialize_authenticated_connection(
                &client,
                &credential.mcp_url,
                token.access_token,
            )
            .await
            .expect("initialize Craft");
            let session = &authenticated.session;
            let help = call_craft_read_raw(&client, session, "blocks learn", 79000)
                .await
                .map(|value| tool_result_text(&value))
                .unwrap_or_else(|error| error);
            let relevant = help
                .lines()
                .filter(|line| {
                    let s = line.to_lowercase();
                    s.contains("tag") || s.contains("blocks add") || s.contains("blocks update")
                })
                .collect::<Vec<_>>();
            println!("Craft help contract: {}", relevant.join("\n"));
            let formatting = call_craft_read_raw(&client, session, "blocks learn text", 79099)
                .await
                .map(|value| tool_result_text(&value))
                .unwrap_or_else(|error| error);
            println!("Craft text formatting contract: {}", formatting);
            let blocks = read_craft_page_snapshot(&client, session, &target_page, 79001)
                .await
                .expect("read exact target page snapshot");
            assert!(!blocks.is_empty(), "structured source content is available");
            let tag_count = blocks
                .iter()
                .flat_map(|(_, body)| craft_markdown_tags(body))
                .count();
            println!("Recognized {tag_count} existing inline tags on the selected live page.");
            println!("Verified live Craft structured root and {} own-page text blocks; no source writes performed.",blocks.len());
        });
    }
}
