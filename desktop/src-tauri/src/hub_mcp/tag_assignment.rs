//! Evidence-backed content assignments. Model tools submit; only the Hub UI resolves.
use super::*;
#[path = "tag_assignment_definition_draft.rs"]
pub(super) mod definition_draft;
#[path = "tag_assignment_discover.rs"]
pub(super) mod discover;
#[path = "tag_assignment_exclusion.rs"]
mod exclusion;
#[path = "tag_assignment_generate.rs"]
pub(super) mod generate;

pub(super) fn exclusion_state(c: &Connection, tag: &str, entity_id: &str) -> Result<Value, String> {
    exclusion::state(c, tag, entity_id)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Locator {
    pub provider: String,
    pub library_id: String,
    pub document_id: String,
    #[serde(default)]
    pub page_id: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Definition {
    description: String,
    include: String,
    exclude: String,
    library_ids: Vec<String>,
}

fn digest(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}

fn text_field(value: &Value, key: &str, min: usize, max: usize) -> Result<String, String> {
    let text = value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if !(min..=max).contains(&text.chars().count()) {
        return Err(format!("{key} 必须为 {min}–{max} 个字符"));
    }
    Ok(text.to_string())
}

pub(super) fn read_definition(c: &Connection, tag: &str) -> Result<Option<Value>, String> {
    c.query_row("SELECT version,definition_json FROM tag_assignment_definitions WHERE tag=?1", [tag], |r| {
        let raw: String = r.get(1)?;
        Ok(json!({"tag":tag,"version":r.get::<_,i64>(0)?,"definition":serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null)}))
    }).optional().map_err(|e| e.to_string())
}

pub(super) fn definition(root: &Path, args: &Value) -> Result<Value, String> {
    let tag = normalized_tag_argument(args, "tag")?;
    let c = open_database(&hub_mcp_database(root)?)?;
    Ok(
        json!({"definition":read_definition(&c,&tag)?,"draft":definition_draft::read(&c,&tag)?,"libraries":hub_list_libraries(root)?["libraries"]}),
    )
}

/// Explicitly selected definition and exact entity only. This is a bounded
/// projection of the existing domain evidence, not a second tagging workflow.
pub(crate) fn agent_context_on(c: &Connection, tag: &str, source: &Value) -> Result<Value, String> {
    let tag = normalized_tag_argument(&json!({"tag":tag}), "tag")?;
    let d = read_definition(c, &tag)?.ok_or("请先在标签治理中确认标签定义")?;
    let source: Locator = serde_json::from_value(source.clone()).map_err(|_| "补标来源无效")?;
    if !d["definition"]["libraryIds"]
        .as_array()
        .is_some_and(|libs| libs.iter().any(|v| v.as_str() == Some(&source.library_id)))
    {
        return Err("内容不在标签定义的资料库范围内".into());
    }
    let e = entity(c, &source)?;
    let body = e["content"].as_str().unwrap_or_default();
    let content: String = body.chars().take(6000).collect();
    Ok(json!({"tag":tag,"definitionVersion":d["version"],
        "definition":{"description":d["definition"]["description"],"include":d["definition"]["include"],"exclude":d["definition"]["exclude"]},
        "source":source,"sourceHash":e["sourceHash"],"title":e["title"],"content":content,
        "startChar":0,"endChar":content.chars().count(),"totalChars":body.chars().count(),
        "truncated":content.chars().count()<body.chars().count(),
        "sourceTags":e["sourceTags"],"internalTags":e["internalTags"],
        "exclusionPreference":exclusion::state(c,&tag,e["entityId"].as_str().unwrap_or_default())?,
        "rejectionHistory":rejection_history(c,&tag,&e,"")?}))
}

pub(crate) fn agent_options_on(c: &Connection, library: &str) -> Result<Vec<String>, String> {
    let mut q=c.prepare("SELECT tag FROM tag_assignment_definitions WHERE EXISTS(SELECT 1 FROM json_each(definition_json,'$.libraryIds') WHERE value=?1) ORDER BY tag LIMIT 100").map_err(|e|e.to_string())?;
    let rows = q
        .query_map([library], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

fn save_definition(root: &Path, args: &Value) -> Result<Value, String> {
    let tag = normalized_tag_argument(args, "tag")?;
    let mut d: Definition = serde_json::from_value(args["definition"].clone())
        .map_err(|e| format!("标签定义无效：{e}"))?;
    d.description = text_field(&args["definition"], "description", 1, 2000)?;
    d.include = text_field(&args["definition"], "include", 1, 2000)?;
    d.exclude = text_field(&args["definition"], "exclude", 0, 2000)?;
    d.library_ids.sort();
    d.library_ids.dedup();
    if d.library_ids.is_empty() || d.library_ids.len() > 100 {
        return Err("请选择 1–100 个资料库".into());
    }
    let expected = args["expectedVersion"].as_i64().ok_or("缺少标签定义版本")?;
    let mut c = open_database(&hub_mcp_database(root)?)?;
    let tx = c
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let count: i64 = tx
        .query_row(
            &format!(
                "{HUB_TAG_ENTITIES_CTE} SELECT COUNT(*) FROM all_tags WHERE normalized_tag=?1"
            ),
            [&tag],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if count == 0 {
        return Err("标签已不存在，请刷新标签目录".into());
    }
    for library in &d.library_ids {
        let valid: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM libraries WHERE id=?1 AND enabled=1 AND provider IN ('craft','obsidian','dida365'))",[library],|r|r.get(0)).map_err(|e|e.to_string())?;
        if !valid {
            return Err(format!("资料库不可用或暂不支持：{library}"));
        }
    }
    let current = read_definition(&tx, &tag)?;
    if current
        .as_ref()
        .and_then(|v| v["version"].as_i64())
        .unwrap_or(0)
        != expected
    {
        return Err("标签定义已变化，请重新加载后保存".into());
    }
    tx.execute("INSERT INTO tag_assignment_definitions(tag,version,definition_json,updated_at) VALUES (?1,?2,?3,?4) ON CONFLICT(tag) DO UPDATE SET version=excluded.version,definition_json=excluded.definition_json,updated_at=excluded.updated_at",params![tag,expected+1,serde_json::to_string(&d).map_err(|e|e.to_string())?,now_timestamp()]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    definition(root, args)
}

// Resolve actual current content; never parse a colon-delimited entity ID to infer scope.
fn quote_context(body: &str, quote: &str) -> Value {
    if quote.is_empty() {
        return Value::Null;
    }
    let Some(start) = body.find(quote) else {
        return Value::Null;
    };
    let before = &body[..start];
    let after = &body[start + quote.len()..];
    let heading = before
        .lines()
        .rev()
        .find(|line| line.trim_start().starts_with('#'))
        .map(|line| line.trim().to_string());
    json!({"heading":heading,"startChar":before.chars().count(),
        "endChar":before.chars().count()+quote.chars().count(),
        "occurrences":body.match_indices(quote).count(),
        "before":before.chars().rev().take(160).collect::<String>().chars().rev().collect::<String>(),
        "after":after.chars().take(160).collect::<String>()})
}

#[test]
fn assignment_quote_context_tracks_unicode_and_missing_quotes() {
    let body = "# 日记\n😀前文\n证据。\n后文证据。";
    let context = quote_context(body, "证据。");
    assert_eq!(context["heading"], json!("# 日记"));
    assert_eq!(context["occurrences"], json!(2));
    let start = context["startChar"].as_u64().unwrap() as usize;
    assert_eq!(
        body.chars().skip(start).take(3).collect::<String>(),
        "证据。"
    );
    assert!(quote_context(body, "不存在").is_null());
    assert!(quote_context(body, "").is_null());
}

pub(super) fn entity(c: &Connection, source: &Locator) -> Result<Value, String> {
    if !matches!(source.provider.as_str(), "craft" | "obsidian" | "dida365") {
        return Err("当前补标支持 Craft、Obsidian 和滴答文本内容".into());
    }
    if source.library_id.is_empty() || source.document_id.is_empty() {
        return Err("来源定位不能为空".into());
    }
    if source.provider != "craft" && !source.page_id.is_empty() {
        return Err("该来源不支持页面定位".into());
    }
    if source.provider == "craft" && source.page_id.is_empty() {
        return Err("Craft 补标必须提供精确 pageId".into());
    }
    let record =
        crate::source_evidence::document_record(c, &source.library_id, &source.document_id)?;
    if record.provider != source.provider {
        return Err("来源类型已改变，请重新取证".into());
    }
    let crate::source_evidence::DocumentRecord {
        mut title,
        path,
        markdown: mut body,
        content_hash: document_hash,
        library_name,
        ..
    } = record;
    if source.provider == "craft" {
        let mut st=c.prepare("SELECT page_title,body FROM content_items WHERE space_id=?1 AND document_id=?2 AND COALESCE(NULLIF(page_id,''),document_id)=?3 AND COALESCE(source_item_id,'')='' AND content_type IN ('document','craft_subpage','markdown_section') ORDER BY ordinal,id").map_err(|e|e.to_string())?;
        let parts = st
            .query_map(
                params![source.library_id, source.document_id, source.page_id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        if parts.is_empty() {
            return Err("Craft 页面当前没有可定位的正文证据".into());
        }
        if source.page_id != source.document_id {
            if let Some((t, _)) = parts.iter().find(|(t, _)| !t.trim().is_empty()) {
                title = t.clone();
            }
        }
        body = parts
            .into_iter()
            .map(|(_, b)| b)
            .collect::<Vec<_>>()
            .join("\n");
    } else if source.provider == "dida365" {
        body=c.query_row("SELECT content || char(10) || description FROM dida_tasks WHERE library_id=?1 AND task_id=?2",params![source.library_id,source.document_id],|r|r.get(0)).map_err(|_|"滴答任务当前不可用".to_string())?;
    }
    if body.trim().is_empty() {
        return Err("当前内容没有可分析文本".into());
    }
    let tags = tag_assignment_source_tags(
        c,
        &source.provider,
        &source.library_id,
        &source.document_id,
        &source.page_id,
    )?;
    let mut st=c.prepare("SELECT tag FROM hub_content_tags WHERE library_id=?1 AND provider=?2 AND document_id=?3 AND page_id=?4 ORDER BY tag").map_err(|e|e.to_string())?;
    let internal = st
        .query_map(
            params![
                source.library_id,
                source.provider,
                source.document_id,
                source.page_id
            ],
            |r| r.get::<_, String>(0),
        )
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let entity_id = if source.provider == "craft" {
        format!(
            "craft:{}:{}:{}",
            source.library_id, source.document_id, source.page_id
        )
    } else {
        format!(
            "{}:{}:{}",
            source.provider, source.library_id, source.document_id
        )
    };
    Ok(
        json!({"source":source,"entityId":entity_id,"provider":source.provider,"libraryId":source.library_id,
        "documentId":source.document_id,"pageId":source.page_id,"blockId":source.page_id,"libraryName":library_name,
        "available":true,"title":title,"path":path,"content":body,
        "contentType":match source.provider.as_str() {"dida365"=>"dida_task","obsidian"=>"obsidian_markdown",_=>"craft_subpage"},
        "sourceHash":digest(&json!([source,title,path,document_hash,body])),
        "duplicateGroupKey":digest(&json!(body.split_whitespace().collect::<Vec<_>>().join(" "))),
        "sourceTags":tags.iter().map(|(t,_)|t).collect::<Vec<_>>(),"internalTags":internal}),
    )
}

pub(super) fn rejection_history(
    c: &Connection,
    tag: &str,
    e: &Value,
    exclude: &str,
) -> Result<Value, String> {
    let mut st = c.prepare("SELECT id,updated_at,substr(note,1,500),json_extract(proposal_json,'$.definitionVersion'),json_extract(proposal_json,'$.sourceHash'),json_extract(proposal_json,'$.decision') FROM tag_assignment_proposals WHERE tag=?1 AND status='rejected' AND json_extract(proposal_json,'$.entityId')=?2 AND id<>?3 ORDER BY updated_at DESC,id DESC LIMIT 6").map_err(|e|e.to_string())?;
    let mut items = st.query_map(params![tag,e["entityId"].as_str(),exclude], |row| Ok(json!({"proposalId":row.get::<_,String>(0)?,"rejectedAt":row.get::<_,i64>(1)?,"reviewNote":row.get::<_,String>(2)?,"definitionVersion":row.get::<_,Option<i64>>(3)?,"sameSourceHash":row.get::<_,Option<String>>(4)?.as_deref()==e["sourceHash"].as_str(),"decision":row.get::<_,Option<String>>(5)?}))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    let more = items.len() > 5;
    items.truncate(5);
    Ok(
        json!({"items":items,"hasMore":more,"policy":"历史驳回是审核事实，不是永久排除或语义结论；再次提交须说明重新考虑的依据"}),
    )
}

pub(super) fn evidence(root: &Path, args: &Value) -> Result<Value, String> {
    let source: Locator =
        serde_json::from_value(args["source"].clone()).map_err(|e| format!("来源定位无效：{e}"))?;
    let c = open_database(&hub_mcp_database(root)?)?;
    let mut e = entity(&c, &source)?;
    if args.get("tag").is_some() {
        let tag = normalized_tag_argument(args, "tag")?;
        e["rejectionHistory"] = rejection_history(&c, &tag, &e, "")?;
        e["exclusionPreference"] =
            exclusion::state(&c, &tag, e["entityId"].as_str().unwrap_or_default())?;
    }
    let content = e["content"].as_str().unwrap_or_default();
    let total = content.chars().count();
    let start = args["startChar"].as_u64().unwrap_or(0) as usize;
    if start > total {
        return Err("startChar 超过当前正文长度".into());
    }
    let limit = argument_usize(args, "maxChars", 3000, 6000);
    let part = content.chars().skip(start).take(limit).collect::<String>();
    let end = start + part.chars().count();
    e["content"] = json!(part);
    e["startChar"] = json!(start);
    e["totalChars"] = json!(total);
    e["nextStartChar"] = if end < total { json!(end) } else { Value::Null };
    Ok(e)
}

fn row(r: &Row<'_>) -> rusqlite::Result<Value> {
    let raw: String = r.get(4)?;
    Ok(
        json!({"proposalId":r.get::<_,String>(0)?,"tag":r.get::<_,String>(1)?,"status":r.get::<_,String>(2)?,
        "version":r.get::<_,i64>(3)?,"proposal":serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null),
        "note":r.get::<_,String>(5)?,"createdAt":r.get::<_,i64>(6)?}),
    )
}
const SELECT: &str = "id,tag,status,version,proposal_json,note,created_at";
// Listing only needs source identity and location, not note bodies or review tokens.
fn source_summary(c: &Connection, proposal: &Value) -> Result<Value, String> {
    let Ok(source) = serde_json::from_value::<Locator>(proposal["source"].clone()) else {
        return Ok(json!({"available":false}));
    };
    let mut summary = json!({"available":false,"entityId":proposal["entityId"],
        "provider":source.provider,"libraryId":source.library_id,"documentId":source.document_id,
        "pageId":source.page_id,"blockId":source.page_id,"title":proposal["title"]});
    let library: Option<(String, bool)> = c
        .query_row(
            "SELECT name,enabled FROM libraries WHERE id=?1 AND provider=?2",
            params![source.library_id, source.provider],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((name, enabled)) = library else {
        return Ok(summary);
    };
    summary["libraryName"] = json!(name);
    let document: Option<(String, String)> = c
        .query_row(
            "SELECT title,path FROM documents WHERE space_id=?1 AND id=?2 AND provider=?3",
            params![source.library_id, source.document_id, source.provider],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((mut title, path)) = document else {
        return Ok(summary);
    };
    summary["path"] = json!(path);
    if source.provider == "craft" {
        let page: Option<String> = c.query_row(
            "SELECT page_title FROM content_items WHERE space_id=?1 AND document_id=?2 AND COALESCE(NULLIF(page_id,''),document_id)=?3 AND COALESCE(source_item_id,'')='' AND content_type IN ('document','craft_subpage','markdown_section') ORDER BY (page_title=''),ordinal,id LIMIT 1",
            params![source.library_id,source.document_id,source.page_id], |r|r.get(0),
        ).optional().map_err(|e|e.to_string())?;
        let Some(page_title) = page else {
            return Ok(summary);
        };
        if source.page_id != source.document_id && !page_title.trim().is_empty() {
            title = page_title;
        }
    } else if !source.page_id.is_empty()
        || !matches!(source.provider.as_str(), "obsidian" | "dida365")
    {
        return Ok(summary);
    }
    summary["title"] = json!(title);
    summary["available"] = json!(enabled);
    summary["contentType"] = json!(match source.provider.as_str() {
        "dida365" => "dida_task",
        "obsidian" => "obsidian_markdown",
        _ => "craft_subpage",
    });
    Ok(summary)
}

fn get(c: &Connection, id: &str) -> Result<Value, String> {
    c.query_row(
        &format!("SELECT {SELECT} FROM tag_assignment_proposals WHERE id=?1"),
        [id],
        row,
    )
    .map_err(|_| "补标建议不存在".into())
}

pub(crate) fn agent_receipt_on(c: &Connection, id: &str) -> Result<Value, String> {
    get(c, id)
}
pub(crate) fn agent_receipt_hint_on(c: &Connection, id: &str) -> Result<Value, String> {
    c.query_row(
        "SELECT status,version FROM tag_assignment_proposals WHERE id=?1",
        [id],
        |r| Ok(json!({"status":r.get::<_,String>(0)?,"version":r.get::<_,i64>(1)?})),
    )
    .optional()
    .map_err(|e| e.to_string())
    .map(|v| v.unwrap_or(json!({"available":false})))
}

pub(super) fn list(root: &Path, args: &Value) -> Result<Value, String> {
    let c = open_database(&hub_mcp_database(root)?)?;
    let tag = argument_text(args, "tag").to_lowercase();
    let status = match argument_text(args, "status") {
        "" => "pending",
        v if ["pending", "accepted", "rejected", "withdrawn"].contains(&v) => v,
        _ => return Err("建议状态无效".into()),
    };
    let limit = argument_usize(args, "limit", 20, 100);
    let filter = if let Some(raw) = args.get("proposalIds") {
        let ids: Vec<String> = serde_json::from_value(raw.clone()).map_err(|_| "建议筛选无效")?;
        if ids.len() > 100 {
            return Err("建议筛选过多".into());
        }
        json!(ids).to_string()
    } else {
        String::new()
    };
    let cursor = argument_text(args, "cursor");
    let (time, id) = if cursor.is_empty() {
        (i64::MAX, String::new())
    } else {
        serde_json::from_str::<(i64, String)>(cursor).map_err(|_| "分页游标无效")?
    };
    let mut st=c.prepare(&format!("SELECT {SELECT} FROM tag_assignment_proposals WHERE (?1='' OR tag=?1) AND status=?2 AND (?6='' OR id IN (SELECT value FROM json_each(?6))) AND (created_at<?3 OR (created_at=?3 AND id<?4)) ORDER BY created_at DESC,id DESC LIMIT ?5")).map_err(|e|e.to_string())?;
    let mut proposals = st
        .query_map(
            params![tag, status, time, id, (limit + 1) as i64, filter],
            row,
        )
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let more = proposals.len() > limit;
    proposals.truncate(limit);
    let cursor = if more {
        proposals
            .last()
            .map(|p| json!([p["createdAt"], p["proposalId"]]).to_string())
    } else {
        None
    };
    for proposal in &mut proposals {
        proposal["sourceInfo"] = source_summary(&c, &proposal["proposal"])?;
    }
    Ok(json!({"proposals":proposals,"nextCursor":cursor}))
}

fn preview_on(c: &Connection, p: &Value) -> Result<Value, String> {
    let a = &p["proposal"];
    let tag = p["tag"].as_str().unwrap_or_default();
    let current = read_definition(c, tag)?;
    let definition_stale = current
        .as_ref()
        .is_none_or(|d| d["version"] != a["definitionVersion"]);
    let source: Locator = serde_json::from_value(a["source"].clone()).map_err(|e| e.to_string())?;
    let resolved = entity(c, &source);
    let mut blockers = Vec::<String>::new();
    if definition_stale {
        blockers.push("标签定义已变化，请重新分析".into());
    }
    let (stale, ev) = match resolved {
        Ok(mut e) => {
            let stale = e["sourceHash"] != a["sourceHash"];
            if stale {
                blockers.push("正文证据已变化，请重新分析".into());
            }
            let quote = a["quote"].as_str().unwrap_or_default();
            if quote.is_empty() || !e["content"].as_str().unwrap_or_default().contains(quote) {
                blockers.push("原文依据当前无法定位".into());
            }
            let assigned = e["internalTags"]
                .as_array()
                .is_some_and(|t| t.iter().any(|v| v.as_str() == Some(tag)));
            let source_has = e["sourceTags"].as_array().is_some_and(|t| {
                t.iter()
                    .any(|v| v.as_str().is_some_and(|s| s.to_lowercase() == tag))
            });
            if source_has {
                blockers.push("来源已经带有该标签".into());
            }
            if assigned && p["status"] != "accepted" {
                blockers.push("Hub 已有该内容标签".into());
            }
            e["quoteContext"] = quote_context(e["content"].as_str().unwrap_or_default(), quote);
            e.as_object_mut().unwrap().remove("content");
            e["snippet"] = a["quote"].clone();
            (stale, e)
        }
        Err(error) => {
            blockers.push(error);
            (true, Value::Null)
        }
    };
    if a["decision"] != "recommend_add" {
        blockers.push("此结论不是补标建议".into());
    }
    let history = rejection_history(c, tag, a, p["proposalId"].as_str().unwrap_or_default())?;
    let preference = exclusion::state(c, tag, a["entityId"].as_str().unwrap_or_default())?;
    if preference["excluded"] == true {
        blockers.push("用户已持续排除此标签对该内容的补标；需先在已驳回详情撤销排除".into());
    }
    let token = digest(&json!([p, current, ev, blockers, history, preference]));
    Ok(
        json!({"proposal":p,"stale":stale||definition_stale,"reviewBlocked":!blockers.is_empty(),
        "reviewBlockers":blockers,"evidence":ev,"reviewToken":token,"rejectionHistory":history,"exclusionPreference":preference,"sourceTagsModified":false}),
    )
}
pub(super) fn preview(root: &Path, args: &Value) -> Result<Value, String> {
    let c = open_database(&hub_mcp_database(root)?)?;
    preview_on(&c, &get(&c, argument_text(args, "proposalId"))?)
}

pub(super) fn submit(root: &Path, args: &Value) -> Result<Value, String> {
    let mut c = open_database(&hub_mcp_database(root)?)?;
    let tx = c
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let result = submit_on(&tx, args)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(result)
}

// Shared domain boundary. The caller owns the transaction; the Agent can
// atomically verify its authorization and persist the actual business receipt.
pub(crate) fn submit_on(c: &Connection, args: &Value) -> Result<Value, String> {
    if c.is_autocommit() {
        return Err("补标提交必须处于调用者持有的事务中".into());
    }
    if args["schemaVersion"] != "hub.tag-assignment.v1" || args["executed"] != false {
        return Err("必须提交 hub.tag-assignment.v1 且 executed=false".into());
    }
    let tag = normalized_tag_argument(args, "tag")?;
    let key = text_field(args, "idempotencyKey", 1, 240)?;
    let request_hash = digest(args);
    let prior: Option<(String, String)> = c
        .query_row(
            "SELECT id,request_hash FROM tag_assignment_proposals WHERE request_key=?1",
            [&key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some((id, hash)) = prior {
        if hash != request_hash {
            return Err("幂等键已用于不同的建议内容".into());
        }
        return Ok(json!({"proposal":get(c,&id)?,"replayed":true}));
    }
    let definition = read_definition(c, &tag)?.ok_or("请先在 Hub 确认标签定义和资料库范围")?;
    if args["definitionVersion"] != definition["version"] {
        return Err("标签定义已变化，请重新分析".into());
    }
    let source: Locator =
        serde_json::from_value(args["source"].clone()).map_err(|e| format!("来源无效：{e}"))?;
    if !definition["definition"]["libraryIds"]
        .as_array()
        .is_some_and(|libs| libs.iter().any(|v| v.as_str() == Some(&source.library_id)))
    {
        return Err("内容不在标签定义的资料库范围内".into());
    }
    let e = entity(c, &source)?;
    if args["sourceHash"] != e["sourceHash"] {
        return Err("正文版本已变化，请重新取证".into());
    }
    let decision = text_field(args, "decision", 1, 30)?;
    if ![
        "recommend_add",
        "related_only",
        "out_of_scope",
        "insufficient_evidence",
    ]
    .contains(&decision.as_str())
    {
        return Err("补标结论类型无效".into());
    }
    let quote = text_field(args, "quote", 1, 2000)?;
    if !e["content"].as_str().unwrap_or_default().contains(&quote) {
        return Err("原文依据不存在于当前内容中".into());
    }
    let rationale = text_field(args, "rationale", 1, 3000)?;
    let risks = text_field(args, "risks", 0, 2000)?;
    let confidence = args["confidence"]
        .as_f64()
        .filter(|v| (0.0..=1.0).contains(v))
        .ok_or("confidence 必须在 0–1 之间")?;
    if !matches!(args["generator"]["agent"].as_str(), Some("codex" | "hub"))
        || !matches!(
            args["generator"]["workflow"].as_str(),
            Some("single-tag-assignment" | "multi-tag-assignment")
        )
    {
        return Err(
            "generator 必须标明 hub 或 codex，以及 single-tag-assignment 或 multi-tag-assignment"
                .into(),
        );
    }
    let generator = normalized_tag_proposal_generator(args)?;
    if generator["agent"] == "hub"
        && !matches!(generator["provider"].as_str(), Some("codex" | "deepseek"))
    {
        return Err("Hub 生成记录必须包含实际模型提供方".into());
    }
    let id = format!("tag-assignment-{}", random_url_safe(12));
    let mut p = json!({"schemaVersion":"hub.tag-assignment.v1","tag":tag,"source":source,"entityId":e["entityId"],
        "title":e["title"],"sourceHash":e["sourceHash"],"definitionVersion":definition["version"],"definition":definition["definition"],
        "decision":decision,"quote":quote,"rationale":rationale,"risks":risks,"confidence":confidence,"generator":generator,"executed":false});
    // Avoid duplicate review cards even when the model chooses another retry key.
    let prior:Option<String>=c.query_row("SELECT id FROM tag_assignment_proposals WHERE tag=?1 AND json_extract(proposal_json,'$.entityId')=?2 AND json_extract(proposal_json,'$.sourceHash')=?3 AND json_extract(proposal_json,'$.definitionVersion')=?4 AND status IN ('pending','accepted','rejected') LIMIT 1",params![tag,e["entityId"].as_str(),e["sourceHash"].as_str(),definition["version"].as_i64()],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    if let Some(prior) = prior {
        return Ok(json!({"proposal":get(c,&prior)?,"existing":true}));
    }
    if exclusion::state(c, &tag, e["entityId"].as_str().unwrap_or_default())?["excluded"] == true {
        return Err("用户已持续排除此标签对该内容的补标；不得换版本、改理由或重试绕过，需用户在 Hub 撤销排除".into());
    }
    let history = rejection_history(c, &tag, &e, "")?;
    let reason=text_field(args,"reconsiderationReason",if history["items"].as_array().is_some_and(|a| !a.is_empty()) {1} else {0},2000)
        .map_err(|_|"此内容有历史驳回记录：请携带 tag 重新取证核对 rejectionHistory，并提供 1–2000 字的 reconsiderationReason；不得直接重复提交".to_string())?;
    p["reconsiderationReason"] = json!(reason);
    p["rejectionHistoryAtSubmission"] = history;
    c.execute("INSERT INTO tag_assignment_proposals(id,tag,status,proposal_json,request_key,request_hash,created_at,updated_at) VALUES (?1,?2,'pending',?3,?4,?5,?6,?6)",params![id,tag,p.to_string(),key,request_hash,now_timestamp()]).map_err(|e|e.to_string())?;
    let stored = get(c, &id)?;
    Ok(json!({"proposal":stored,"sourceTagsModified":false}))
}

fn resolve(root: &Path, args: &Value) -> Result<Value, String> {
    let id = text_field(args, "proposalId", 1, 240)?;
    let resolution = argument_text(args, "resolution");
    if !["accept", "reject", "withdraw"].contains(&resolution) {
        return Err("审核操作无效".into());
    }
    let mut c = open_database(&hub_mcp_database(root)?)?;
    let tx = c
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let p = get(&tx, &id)?;
    let state = p["status"].as_str().unwrap_or_default();
    if (resolution == "withdraw" && state != "accepted")
        || (resolution != "withdraw" && state != "pending")
    {
        return Err("建议状态已经变化，请刷新".into());
    }
    let preview = preview_on(&tx, &p)?;
    if args["reviewToken"] != preview["reviewToken"] {
        return Err("预演已过期，请重新查看证据".into());
    }
    if resolution == "accept" && preview["reviewBlocked"] == true {
        return Err(format!("不能批准：{}", preview["reviewBlockers"]));
    }
    let source: Locator =
        serde_json::from_value(p["proposal"]["source"].clone()).map_err(|e| e.to_string())?;
    if resolution == "accept" {
        tx.execute("INSERT INTO hub_content_tags(library_id,provider,document_id,page_id,tag,proposal_id) VALUES (?1,?2,?3,?4,?5,?6)",params![source.library_id,source.provider,source.document_id,source.page_id,p["tag"].as_str(),id]).map_err(|e|format!("内容标签已有变化：{e}"))?;
    } else if resolution == "withdraw" {
        tx.execute("DELETE FROM hub_content_tags WHERE proposal_id=?1", [&id])
            .map_err(|e| e.to_string())?;
    }
    let status = match resolution {
        "accept" => "accepted",
        "withdraw" => "withdrawn",
        _ => "rejected",
    };
    tx.execute("UPDATE tag_assignment_proposals SET status=?2,version=version+1,note=?3,updated_at=?4 WHERE id=?1",params![id,status,text_field(args,"note",0,2000)?,now_timestamp()]).map_err(|e|e.to_string())?;
    if resolution != "reject" {
        tx.execute("INSERT INTO metadata(key,value) VALUES ('content_tag_revision','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1",[]).map_err(|e|e.to_string())?;
        tx.execute("INSERT INTO index_jobs(job_key,space_id,source_id,source_type,job_type,status,priority,created_at,updated_at,provider) VALUES (?1,?2,?3,'document','upsert_lexical','pending',20,?4,?4,?5) ON CONFLICT(job_key) DO UPDATE SET status='pending',job_type='upsert_lexical',attempts=0,updated_at=excluded.updated_at,next_attempt_at=0,worker_id=NULL,locked_at=NULL,lease_until=NULL",params![format!("lexical:{}:{}",source.library_id,source.document_id),source.library_id,source.document_id,now_timestamp(),source.provider]).map_err(|e|e.to_string())?;
    }
    let result = get(&tx, &id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(
        json!({"proposal":result,"internalTagsChanged":resolution!="reject","sourceTagsModified":false}),
    )
}

pub(crate) fn ui(root: &Path, args: &Value) -> Result<Value, String> {
    match argument_text(args, "action") {
        "definition" => definition(root, args),
        "scan_generate" => super::tag_content_scan::generate::run(root, args),
        "save_definition" => save_definition(root, args),
        "governance_analyze" => super::tag_governance_generate::run(root, args),
        "governance_audit_status" => super::tag_audit::status(root, &json!({})),
        "generate_definition" => generate::generate(root, args),
        "discover_assignments" => discover::run(root, args),
        "discovery_status" => discover::status(root, args),
        "definition_models" => crate::model_runtime::models_for(root),
        "list" => list(root, args),
        "preview" => preview(root, args),
        "resolve" => resolve(root, args),
        "preview_exclusion"
        | "apply_exclusion"
        | "list_exclusions"
        | "preview_exclusion_review"
        | "apply_exclusion_review"
        | "exclusion_review_history"
        | "exclusion_review_due" => exclusion::ui(root, args),
        "scan_status"
        | "scan_history"
        | "scan_budget_history"
        | "scan_reopen_items"
        | "scan_reopen_history"
        | "scan_check_items"
        | "scan_check_save"
        | "scan_check_saved"
        | "scan_check_history"
        | "scan_preview_reopen"
        | "scan_apply_reopen"
        | "scan_preview_new"
        | "scan_create_new"
        | "scan_preview_budget"
        | "scan_apply_budget" => tag_content_scan::ui(root, args),
        _ => Err("内容补标操作无效".into()),
    }
}

pub(super) fn tools() -> Vec<Value> {
    let source = json!({"type":"object","properties":{"provider":{"enum":["craft","obsidian","dida365"]},"libraryId":{"type":"string"},"documentId":{"type":"string"},"pageId":{"type":"string"}},"required":["provider","libraryId","documentId"],"additionalProperties":false});
    let entries=vec![
        ("hub_tag_assignment_definition","读取已确认定义、范围和版本，以及 Codex 草稿 draft。definition=null 时可生成草稿并用 hub_submit_tag_assignment_definition_draft 回填 Hub，待用户编辑并确认。草稿不是已确认定义，不能用来提交补标。",true,json!({"tag":{"type":"string"}}),vec!["tag"]),
        ("hub_submit_tag_assignment_definition_draft","保存 Codex 生成的定义草稿供 Hub 自动回填和用户编辑；不确认定义、不改变资料库范围或来源标签。先核对 catalog、profile、taxonomy，已有样本不代表完整边界。expectedVersion 使用已确认版本，无定义时为 0。",false,json!({"tag":{"type":"string"},"expectedVersion":{"type":"integer","minimum":0},"definition":{"type":"object","properties":{"description":{"type":"string","minLength":1,"maxLength":2000},"include":{"type":"string","minLength":1,"maxLength":2000},"exclude":{"type":"string","maxLength":2000}},"required":["description","include","exclude"],"additionalProperties":false},"idempotencyKey":{"type":"string","minLength":1,"maxLength":240}}),vec!["tag","expectedVersion","definition","idempotencyKey"]),
        ("hub_read_tag_assignment_evidence","按精确来源读取当前补标证据，返回 sourceHash、原文和分页位置。提交建议必须使用这里的哈希和逐字原文。",true,json!({"tag":{"type":"string","description":"目标标签；传入后返回该实体的跨版本驳回历史"},"source":source,"startChar":{"type":"integer","minimum":0},"maxChars":{"type":"integer","minimum":1,"maximum":6000,"default":3000}}),vec!["source"]),
        ("hub_list_tag_assignment_proposals","分页读取内容补标待审核或历史建议。",true,json!({"tag":{"type":"string"},"status":{"enum":["pending","accepted","rejected","withdrawn"]},"limit":{"type":"integer","minimum":1,"maximum":100},"cursor":{"type":"string"}}),vec![]),
        ("hub_preview_tag_assignment_proposal","重新检查补标正文、定义和已有标签；返回 stale、reviewBlocked 和可定位证据。批准与撤销在 Hub 界面进行。",true,json!({"proposalId":{"type":"string"}}),vec!["proposalId"]),
        ("hub_submit_tag_assignment_proposal","提交单篇内容的补标判断到 Hub 待审核；不会批准或改来源标签。使用当前定义版本和证据哈希，原文 quote 必须逐字可定位。",false,json!({"schemaVersion":{"const":"hub.tag-assignment.v1"},"tag":{"type":"string"},"source":source,"sourceHash":{"type":"string"},"definitionVersion":{"type":"integer","minimum":1},"reconsiderationReason":{"type":"string","maxLength":2000,"description":"同标签同实体有历史驳回时必填，说明新证据或定义变化为何值得重新审核"},"decision":{"enum":["recommend_add","related_only","out_of_scope","insufficient_evidence"]},"quote":{"type":"string","minLength":1,"maxLength":2000},"rationale":{"type":"string","minLength":1,"maxLength":3000},"risks":{"type":"string","maxLength":2000},"confidence":{"type":"number","minimum":0,"maximum":1},"generator":{"type":"object","properties":{"agent":{"enum":["codex","hub"]},"provider":{"enum":["codex","deepseek"]},"workflow":{"enum":["single-tag-assignment","multi-tag-assignment"]},"model":{"type":"string"}},"required":["agent","workflow"],"additionalProperties":false},"executed":{"const":false},"idempotencyKey":{"type":"string","minLength":1,"maxLength":240}}),vec!["schemaVersion","tag","source","sourceHash","definitionVersion","decision","quote","rationale","confidence","generator","executed","idempotencyKey"]),
    ];
    entries.into_iter().map(|(name,description,read,properties,required)|json!({"name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false},"annotations":{"readOnlyHint":read,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}})).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires logged-in Codex CLI and makes a real generation request"]
    fn desktop_definition_generation_saves_only_draft() {
        let f = Fixture::new();
        let result = ui(&f.root,&json!({"action":"generate_definition","tag":"focus","expectedVersion":1,"currentInput":{"description":"冲动行为","include":"","exclude":""}})).unwrap();
        assert_eq!(result["definition"]["version"], 1);
        assert_eq!(
            result["definition"]["definition"]["description"],
            "Impulse awareness"
        );
        assert!(!result["draft"]["definition"]["description"]
            .as_str()
            .unwrap()
            .is_empty());
        assert_eq!(result["draft"]["baseVersion"], 1);
    }
    #[test]
    fn definition_draft_is_unconfirmed_idempotent_and_version_locked() {
        let f = Fixture::new();
        let args = json!({"tag":"focus","expectedVersion":1,"definition":{"description":"Draft","include":"Impulse","exclude":""},"idempotencyKey":"draft-one"});
        let first = definition_draft::submit(&f.root, &args).unwrap();
        assert_eq!(first["confirmed"], false);
        assert_eq!(first, definition_draft::submit(&f.root, &args).unwrap());
        let read = definition(&f.root, &json!({"tag":"focus"})).unwrap();
        assert_eq!(read["definition"]["version"], 1);
        assert_eq!(
            read["definition"]["definition"]["description"],
            "Impulse awareness"
        );
        assert_eq!(read["draft"]["definition"]["description"], "Draft");
        let mut conflict = args.clone();
        conflict["definition"]["description"] = json!("Different");
        assert!(definition_draft::submit(&f.root, &conflict).is_err());
        f.define(1);
        conflict["idempotencyKey"] = json!("draft-two");
        assert!(definition_draft::submit(&f.root, &conflict).is_err());
        f.c()
            .execute(
                "DELETE FROM tag_assignment_definitions WHERE tag='focus'",
                [],
            )
            .unwrap();
        conflict["expectedVersion"] = json!(0);
        definition_draft::submit(&f.root, &conflict).unwrap();
        assert!(definition(&f.root, &json!({"tag":"focus"})).unwrap()["definition"].is_null());
    }

    #[test]
    fn desktop_discovery_submits_only_evidence_backed_pending_proposals() {
        let f = Fixture::new();
        let mut c = f.c();
        let snapshot = IndexRebuildSnapshot::open(&c).unwrap();
        snapshot
            .activate(&mut c, &f.root.join("tantivy-generations-v1"))
            .unwrap();
        drop(snapshot);
        drop(c);
        let saved = definition(&f.root, &json!({"tag":"focus"})).unwrap();
        let args = json!({"tag":"focus","expectedVersion":1,"currentInput":saved["definition"]["definition"]});
        let mut calls = 0;
        let report = discover::run_with(&f.root,&args, |_, _, _, _, _| {
            calls+=1;
            if calls==1 { Ok(json!({"queries":["zzzznomatch"]})) }
            else if calls==2 { Ok(json!({"queries":["impulse"]})) }
            else { Ok(json!({"decision":"recommend_add","quote":"Pause before acting on impulse.","rationale":"Pause before acting is explicit.","risks":"Limited first round.","confidence":0.8})) }
        }).unwrap();
        assert_eq!(report["retrievalRounds"].as_array().unwrap().len(), 2);
        assert_eq!(report["retrievalRounds"][0]["counts"]["retrievedHits"], 0);
        assert_eq!(report["readEntities"], 1);
        assert_eq!(report["submitted"].as_array().unwrap().len(), 1);
        assert_eq!(report["submitted"][0]["preview"]["reviewBlocked"], false);
        let pending = list(&f.root, &json!({"tag":"focus","status":"pending"})).unwrap();
        assert_eq!(pending["proposals"].as_array().unwrap().len(), 1);
        let id = report["submitted"][0]["proposalId"].as_str().unwrap();
        f.resolve(id, "reject");
        let skipped = discover::run_with(&f.root, &args, |_, schema, _, _, _| {
            assert!(
                schema["properties"].get("queries").is_some(),
                "historically rejected evidence must not be judged again without new basis"
            );
            Ok(json!({"queries":["impulse"]}))
        })
        .unwrap();
        assert!(skipped["submitted"].as_array().unwrap().is_empty());
        assert!(skipped["unjudged"][0]["reason"]
            .as_str()
            .unwrap()
            .contains("历史驳回"));
        let mut unsaved = args.clone();
        unsaved["currentInput"]["include"] = json!("changed");
        assert!(
            discover::run_with(&f.root, &unsaved, |_, _, _, _, _| panic!(
                "must not call model for unsaved definition"
            ))
            .is_err()
        );
    }

    #[test]
    #[ignore = "requires logged-in Codex CLI; generates one fixture proposal"]
    fn desktop_discovery_live_decision() {
        let f = Fixture::new();
        let mut c = f.c();
        let snapshot = IndexRebuildSnapshot::open(&c).unwrap();
        snapshot
            .activate(&mut c, &f.root.join("tantivy-generations-v1"))
            .unwrap();
        drop(snapshot);
        drop(c);
        let saved = definition(&f.root, &json!({"tag":"focus"})).unwrap();
        let report=discover::run_with(&f.root,&json!({"tag":"focus","expectedVersion":1,"currentInput":saved["definition"]["definition"]}),|prompt,schema,model,effort,fast| {
            if schema["properties"].get("queries").is_some() { Ok(json!({"queries":["impulse"]})) }
            else { generate::run_structured(prompt,schema,model,effort,fast) }
        }).unwrap();
        assert_eq!(report["submitted"].as_array().unwrap().len(), 1, "{report}");
    }

    #[test]
    fn desktop_discovery_resumes_saved_queue_and_rejects_changed_definition() {
        let f = Fixture::new();
        let mut c = f.c();
        for n in 0..6 {
            c.execute("INSERT INTO content_items(id,space_id,document_id,block_id,content_type,heading,body,ordinal,source_hash,page_id,page_title,provider) VALUES (?1,'lib','doc',?1,'craft_subpage',?1,?2,?3,'hash',?1,?1,'craft')",params![format!("extra{n}"),format!("Pause before acting on impulse. Unique {n}"),n+2]).unwrap();
        }
        let snapshot = IndexRebuildSnapshot::open(&c).unwrap();
        snapshot
            .activate(&mut c, &f.root.join("tantivy-generations-v1"))
            .unwrap();
        drop(snapshot);
        drop(c);
        let saved = definition(&f.root, &json!({"tag":"focus"})).unwrap();
        let mut args = json!({"tag":"focus","expectedVersion":1,"currentInput":saved["definition"]["definition"]});
        let answer = || json!({"decision":"recommend_add","quote":"Pause before acting on impulse.","rationale":"Explicit pause.","risks":"","confidence":0.8});
        let first = discover::run_with(&f.root, &args, |_, schema, _, _, _| {
            Ok(if schema["properties"].get("queries").is_some() {
                json!({"queries":["impulse"]})
            } else {
                answer()
            })
        })
        .unwrap();
        assert_eq!(first["processedCount"], 5);
        assert_eq!(first["remainingCount"], 2);
        let restored = discover::status(&f.root, &json!({"tag":"focus"})).unwrap();
        assert_eq!(restored["nextOffset"], 5);
        args["resume"] = json!(true);
        let second = discover::run_with(&f.root, &args, |_, schema, _, _, _| {
            assert!(schema["properties"].get("queries").is_none());
            Ok(answer())
        })
        .unwrap();
        assert_eq!(second["processedCount"], 7);
        assert_eq!(second["readEntities"], 7);
        assert_eq!(second["remainingCount"], 0);
        assert_eq!(second["submitted"].as_array().unwrap().len(), 7);
        f.define(1);
        args["expectedVersion"] = json!(2);
        assert!(
            discover::status(&f.root, &json!({"tag":"focus"})).unwrap()["stale"]
                .as_bool()
                .unwrap()
        );
        assert!(discover::run_with(&f.root, &args, |_, _, _, _, _| panic!(
            "stale queue must not invoke model"
        ))
        .is_err());
    }
    struct Fixture {
        root: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("hub-assignment-review-{}", random_url_safe(8)));
            std::fs::create_dir_all(&root).unwrap();
            let c = open_database(&root.join("craft-search.sqlite3")).unwrap();
            c.execute_batch("INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES ('lib','craft','Test',1,1);
                INSERT INTO documents(space_id,id,title,path,markdown,modified_at,indexed_at,content_hash,provider)
                VALUES ('lib','doc','Root','Root','root and child',1,1,'hash','craft');
                INSERT INTO content_items(id,space_id,document_id,block_id,content_type,heading,body,ordinal,source_hash,page_id,page_title,provider)
                VALUES ('root','lib','doc','doc','document','Root','unrelated parent content',0,'hash','doc','Root','craft'),
                ('child','lib','doc','child','craft_subpage','Child','Pause before acting on impulse.',1,'hash','child','Child','craft');
                INSERT INTO craft_tags(space_id,document_id,page_id,tag,normalized_tag) VALUES ('lib','doc','doc','focus','focus');").unwrap();
            drop(c);
            let f = Self { root };
            f.define(0);
            f
        }
        fn c(&self) -> Connection {
            open_database(&self.root.join("craft-search.sqlite3")).unwrap()
        }
        fn define(&self, version: i64) {
            save_definition(&self.root,&json!({"tag":"focus","expectedVersion":version,
                "definition":{"description":"Impulse awareness","include":"Recognize impulses before acting","exclude":"Unrelated parents","libraryIds":["lib"]}})).unwrap();
        }
        fn args(&self) -> Value {
            let source =
                json!({"provider":"craft","libraryId":"lib","documentId":"doc","pageId":"child"});
            let e = evidence(&self.root, &json!({"source":source})).unwrap();
            json!({"schemaVersion":"hub.tag-assignment.v1","tag":"focus","source":source,"sourceHash":e["sourceHash"],
                "definitionVersion":1,"decision":"recommend_add","quote":"Pause before acting on impulse.",
                "rationale":"The text explicitly asks for a pause.","confidence":0.8,"executed":false,
                "generator":{"agent":"codex","workflow":"single-tag-assignment"},"idempotencyKey":"one"})
        }
        fn propose(&self) -> String {
            submit(&self.root, &self.args()).unwrap()["proposal"]["proposalId"]
                .as_str()
                .unwrap()
                .into()
        }
        fn preview(&self, id: &str) -> Value {
            preview(&self.root, &json!({"proposalId":id})).unwrap()
        }
        fn resolve(&self, id: &str, action: &str) -> Value {
            resolve(&self.root,&json!({"proposalId":id,"resolution":action,"reviewToken":self.preview(id)["reviewToken"]})).unwrap()
        }
        fn members(&self) -> i64 {
            self.c()
                .query_row("SELECT COUNT(*) FROM hub_content_tags", [], |r| r.get(0))
                .unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
    #[test]
    fn assignment_list_locates_current_source_without_reading_or_approving() {
        let f = Fixture::new();
        let id = f.propose();
        f.c().execute_batch("UPDATE content_items SET page_title='Renamed child' WHERE id='child'; UPDATE documents SET path='Folder/Root';").unwrap();
        let page = list(&f.root, &json!({})).unwrap();
        let item = &page["proposals"][0];
        assert_eq!(item["proposalId"], id);
        assert_eq!(item["status"], "pending");
        let source = &item["sourceInfo"];
        assert_eq!(source["available"], true);
        assert_eq!(source["libraryName"], "Test");
        assert_eq!(source["title"], "Renamed child");
        assert_eq!(source["path"], "Folder/Root");
        assert_eq!(source["documentId"], "doc");
        assert_eq!(source["pageId"], "child");
        assert!(source.get("content").is_none());
        assert!(item.get("reviewToken").is_none());
        assert_eq!(f.members(), 0);
        f.c()
            .execute_batch("UPDATE libraries SET enabled=0;")
            .unwrap();
        assert_eq!(
            list(&f.root, &json!({})).unwrap()["proposals"][0]["sourceInfo"]["available"],
            false
        );
        f.c()
            .execute_batch(
                "UPDATE libraries SET enabled=1; DELETE FROM content_items WHERE id='child';",
            )
            .unwrap();
        assert_eq!(
            list(&f.root, &json!({})).unwrap()["proposals"][0]["sourceInfo"]["available"],
            false
        );
    }

    #[test]
    fn assignment_source_summary_keeps_obsidian_vault_and_path() {
        let f = Fixture::new();
        f.c().execute_batch("INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES ('vault','obsidian','Main',1,1); INSERT INTO documents(space_id,id,title,path,markdown,modified_at,indexed_at,content_hash,provider) VALUES ('vault','note','Child','工作/Child.md','Body',1,1,'hash','obsidian');").unwrap();
        let source = source_summary(&f.c(), &json!({"source":{"provider":"obsidian","libraryId":"vault","documentId":"note"},"entityId":"obsidian:vault:note","title":"Old title"})).unwrap();
        assert_eq!(source["available"], true);
        assert_eq!(source["provider"], "obsidian");
        assert_eq!(source["libraryId"], "vault");
        assert_eq!(source["libraryName"], "Main");
        assert_eq!(source["path"], "工作/Child.md");
        assert_eq!(source["title"], "Child");
    }

    #[test]
    fn assignment_approval_and_withdrawal_are_internal_and_page_scoped() {
        let f = Fixture::new();
        let id = f.propose();
        assert_eq!(f.members(), 0);
        assert_eq!(f.preview(&id)["reviewBlocked"], false);
        assert_eq!(f.resolve(&id, "accept")["internalTagsChanged"], true);
        assert_eq!(f.members(), 1);
        let c = f.c();
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM craft_tags", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(c.query_row("SELECT COUNT(DISTINCT entity_id) FROM hub_content_tag_memberships WHERE tag='focus'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        let records = collect_index_records(&c, None).unwrap();
        let child = records.iter().find(|r| r.block_id == "child");
        // Validate actual index fields, not only the review table.
        assert!(child.is_some());
        assert!(child.unwrap().tags.contains("focus"));
        assert_eq!(c.query_row("SELECT COUNT(*) FROM index_jobs WHERE job_type='upsert_lexical' AND status='pending'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        drop(c);
        assert_eq!(
            f.resolve(&id, "withdraw")["proposal"]["status"],
            "withdrawn"
        );
        assert_eq!(f.members(), 0);
        let records = collect_index_records(&f.c(), None).unwrap();
        assert!(!records
            .iter()
            .find(|r| r.block_id == "child")
            .unwrap()
            .tags
            .contains("focus"));
    }
    #[test]
    fn assignment_exclusion_event_revoke_survives_missing_origin_and_preserves_audit() {
        let f = Fixture::new();
        let pid = f.propose();
        f.resolve(&pid, "reject");
        let p = ui(
            &f.root,
            &json!({"action":"preview_exclusion","proposalId":pid,"excluded":true}),
        )
        .unwrap();
        ui(&f.root,&json!({"action":"apply_exclusion","proposalId":pid,"excluded":true,"requestId":"enable","confirmationToken":p["confirmationToken"]})).unwrap();
        let id =
            ui(&f.root, &json!({"action":"list_exclusions"})).unwrap()["items"][0]["id"].clone();
        f.c()
            .execute("DELETE FROM tag_assignment_proposals", [])
            .unwrap();
        let a = json!({"action":"preview_exclusion","exclusionEventId":id,"excluded":false});
        let p = ui(&f.root, &a).unwrap();
        assert_eq!(p["change"]["entityId"], "craft:lib:doc:child");
        assert_eq!(p["change"]["tag"], "focus");
        assert_eq!(
            f.c()
                .query_row(
                    "SELECT COUNT(*) FROM tag_assignment_exclusion_events",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        let apply = json!({"action":"apply_exclusion","exclusionEventId":id,"excluded":false,"requestId":"revoke-orphan","confirmationToken":p["confirmationToken"]});
        ui(&f.root, &apply).unwrap();
        assert_eq!(ui(&f.root, &apply).unwrap()["replayed"], true);
        assert!(
            ui(&f.root, &json!({"action":"list_exclusions"})).unwrap()["items"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            f.c()
                .query_row(
                    "SELECT COUNT(*) FROM tag_assignment_exclusion_events",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            2
        );
        assert_eq!(
            f.c()
                .query_row("SELECT COUNT(*) FROM tag_assignment_proposals", [], |r| r
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
            0
        );
        assert_eq!(
            f.c()
                .query_row("SELECT COUNT(*) FROM hub_content_tags", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn assignment_exclusion_event_revoke_rejects_enable_mixed_targets_and_stale_event() {
        let f = Fixture::new();
        let pid = f.propose();
        f.resolve(&pid, "reject");
        f.c().execute("INSERT INTO tag_assignment_exclusion_events(tag,entity_id,proposal_id,excluded,request_key,request_hash,created_at) VALUES ('focus','craft:lib:doc:child',?1,1,'one','fixture',1)",[&pid]).unwrap();
        let id =
            ui(&f.root, &json!({"action":"list_exclusions"})).unwrap()["items"][0]["id"].clone();
        let a = json!({"action":"preview_exclusion","exclusionEventId":id,"excluded":false});
        let p = ui(&f.root, &a).unwrap();
        for bad in [
            json!({"action":"preview_exclusion","exclusionEventId":id,"excluded":true}),
            json!({"action":"preview_exclusion","exclusionEventId":id,"excluded":false,"proposalId":pid}),
            json!({"action":"preview_exclusion","exclusionEventId":0,"excluded":false}),
        ] {
            assert!(ui(&f.root, &bad).is_err());
        }
        f.c().execute("INSERT INTO tag_assignment_exclusion_events(tag,entity_id,proposal_id,excluded,request_key,request_hash,created_at) VALUES ('focus','craft:lib:doc:child',?1,1,'new','fixture',2)",[&pid]).unwrap();
        assert!(ui(&f.root, &a).is_err());
        assert!(ui(&f.root,&json!({"action":"apply_exclusion","exclusionEventId":id,"excluded":false,"requestId":"stale","confirmationToken":p["confirmationToken"]})).is_err());
        assert_eq!(
            f.c()
                .query_row(
                    "SELECT COUNT(*) FROM tag_assignment_exclusion_events",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            2
        );
    }

    #[test]
    fn assignment_exclusion_list_pages_snapshot_and_history_without_writes() {
        let f = Fixture::new();
        let pid = f.propose();
        f.resolve(&pid, "reject");
        for n in 0..43 {
            f.c().execute("INSERT INTO tag_assignment_exclusion_events(tag,entity_id,proposal_id,excluded,request_key,request_hash,created_at) VALUES ('focus',?1,?2,1,?1,'test',100)",params![format!("entity-{n}"),pid]).unwrap();
        }
        let a = json!({"action":"list_exclusions","tag":"focus","mode":"active","limit":7});
        let mut page = ui(&f.root, &a).unwrap();
        let snapshot = page["snapshotVersion"].clone();
        f.c().execute("INSERT INTO tag_assignment_exclusion_events(tag,entity_id,proposal_id,excluded,request_key,request_hash,created_at) VALUES ('focus','entity-0',?1,0,'revoke','test',100)",[&pid]).unwrap();
        let mut ids = std::collections::HashSet::new();
        loop {
            assert_eq!(page["snapshotVersion"], snapshot);
            for item in page["items"].as_array().unwrap() {
                assert!(ids.insert(item["id"].as_i64().unwrap()));
                assert_eq!(item["canManage"], false);
            }
            if page["nextCursor"].is_null() {
                break;
            }
            let mut next = a.clone();
            next["cursor"] = page["nextCursor"].clone();
            page = ui(&f.root, &next).unwrap();
        }
        assert_eq!(ids.len(), 43);
        let fresh = ui(
            &f.root,
            &json!({"action":"list_exclusions","tag":"focus","mode":"active","limit":50}),
        )
        .unwrap();
        assert_eq!(fresh["items"].as_array().unwrap().len(), 42);
        let history = ui(
            &f.root,
            &json!({"action":"list_exclusions","tag":"focus","mode":"history","limit":50}),
        )
        .unwrap();
        assert_eq!(history["items"].as_array().unwrap().len(), 44);
        assert_eq!(history["items"][0]["excluded"], false);
        assert_eq!(
            f.c()
                .query_row(
                    "SELECT COUNT(*) FROM tag_assignment_exclusion_events",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            44
        );
    }

    #[test]
    fn assignment_exclusion_list_rejects_cross_scope_and_missing_origin_is_visible() {
        let f = Fixture::new();
        let pid = f.propose();
        f.resolve(&pid, "reject");
        for n in 0..2 {
            f.c().execute("INSERT INTO tag_assignment_exclusion_events(tag,entity_id,proposal_id,excluded,request_key,request_hash,created_at) VALUES ('focus',?1,?2,1,?1,'test',1)",params![format!("entity-{n}"),pid]).unwrap();
        }
        let a = json!({"action":"list_exclusions","tag":"focus","limit":1});
        let page = ui(&f.root, &a).unwrap();
        let mut next = a.clone();
        next["cursor"] = page["nextCursor"].clone();
        next["tag"] = json!("other");
        assert!(ui(&f.root, &next).is_err());
        next["tag"] = json!("focus");
        next["mode"] = json!("history");
        assert!(ui(&f.root, &next).is_err());
        next = a.clone();
        next["limit"] = json!(51);
        assert!(ui(&f.root, &next).is_err());
        f.c()
            .execute("DELETE FROM tag_assignment_proposals", [])
            .unwrap();
        let page = ui(&f.root, &a).unwrap();
        assert_eq!(page["items"][0]["proposalTitle"], "");
        assert_eq!(page["items"][0]["canManage"], false);
        assert!(
            ui(&f.root, &json!({"action":"list_exclusions","tag":"other"})).unwrap()["items"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn exclusion_due_reminder_counts_latest_events_without_mutation() {
        let f = Fixture::new();
        let pid = f.propose();
        let now = now_timestamp();
        for (entity, time, excluded) in [
            ("old", now - 200 * 86400, true),
            ("recent", now, true),
            ("unknown", 0, true),
            ("revoked", now - 200 * 86400, true),
            ("revoked", now, false),
            ("future-review", now - 200 * 86400, true),
            ("due-review", now, true),
        ] {
            f.c().execute("INSERT INTO tag_assignment_exclusion_events(tag,entity_id,proposal_id,excluded,request_key,request_hash,created_at) VALUES ('focus',?1,?2,?3,?4,'test',?5)",params![entity,pid,excluded,format!("{entity}-{excluded}"),time]).unwrap();
        }
        for (entity, time) in [("future-review", now + 86400), ("due-review", now - 1)] {
            f.c().execute("INSERT INTO tag_assignment_exclusion_reviews(exclusion_event_id,reviewed_at,next_review_at,change_json,request_key,request_hash) SELECT id,?1,?2,'{}',entity_id,'test' FROM tag_assignment_exclusion_events WHERE entity_id=?3",params![now,time,entity]).unwrap();
        }
        let a = json!({"action":"exclusion_review_due","tag":"focus","olderThanDays":90});
        let due = ui(&f.root, &a).unwrap();
        assert_eq!(due["count"], 2);
        assert_eq!(due["hasMore"], false);
        let list = ui(
            &f.root,
            &json!({"action":"list_exclusions","mode":"review","tag":"focus","olderThanDays":90}),
        )
        .unwrap();
        assert_eq!(list["items"].as_array().unwrap().len(), 2);
        assert_eq!(
            ui(
                &f.root,
                &json!({"action":"exclusion_review_due","tag":"other"})
            )
            .unwrap()["count"],
            0
        );
        for days in [0, 3651, -1] {
            assert!(ui(
                &f.root,
                &json!({"action":"exclusion_review_due","olderThanDays":days})
            )
            .is_err());
        }
        f.c().execute("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1001) INSERT INTO tag_assignment_exclusion_events(tag,entity_id,proposal_id,excluded,request_key,request_hash,created_at) SELECT 'bulk',CAST(x AS TEXT),?1,1,'bulk-'||x,'test',?2 FROM n",params![pid,now-200*86400]).unwrap();
        let capped = ui(&f.root, &json!({"action":"exclusion_review_due"})).unwrap();
        assert_eq!(capped["count"], 1000);
        assert_eq!(capped["hasMore"], true);
        assert_eq!(
            f.c()
                .query_row(
                    "SELECT COUNT(*) FROM tag_assignment_exclusion_reviews",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            2
        );
    }

    #[test]
    fn exclusion_review_history_is_read_only_scoped_and_snapshot_paginated() {
        let f = Fixture::new();
        let pid = f.propose();
        let now = now_timestamp();
        f.c().execute("INSERT INTO tag_assignment_exclusion_events(tag,entity_id,proposal_id,excluded,request_key,request_hash,created_at) VALUES ('focus','one',?1,1,'history-event','test',?2)",params![pid,now]).unwrap();
        let event = f
            .c()
            .query_row(
                "SELECT id FROM tag_assignment_exclusion_events WHERE request_key='history-event'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .unwrap();
        let a = json!({"action":"exclusion_review_history","exclusionEventId":event,"limit":1});
        assert!(ui(&f.root, &a).unwrap()["items"]
            .as_array()
            .unwrap()
            .is_empty());
        let add = |key: &str| {
            f.c().execute("INSERT INTO tag_assignment_exclusion_reviews(exclusion_event_id,reviewed_at,next_review_at,change_json,request_key,request_hash) VALUES (?1,?2,?3,'{}',?4,'test')",params![event,now,now+86400,key]).unwrap();
        };
        add("first");
        add("second");
        let first = ui(&f.root, &a).unwrap();
        add("late");
        let mut next = a.clone();
        next["cursor"] = first["nextCursor"].clone();
        let second = ui(&f.root, &next).unwrap();
        assert_eq!(second["items"][0]["id"], 1);
        assert!(second["nextCursor"].is_null());
        assert_eq!(first["snapshotVersion"], second["snapshotVersion"]);
        f.c().execute("INSERT INTO tag_assignment_exclusion_events(tag,entity_id,proposal_id,excluded,request_key,request_hash,created_at) VALUES ('focus','one',?1,0,'revoke-history','test',?2)",params![pid,now]).unwrap();
        assert_eq!(ui(&f.root, &a).unwrap()["items"][0]["id"], 3);
        next["exclusionEventId"] = json!(event + 1);
        assert!(ui(&f.root, &next).is_err());
        for limit in [0, 51, -1] {
            let mut bad = a.clone();
            bad["limit"] = json!(limit);
            assert!(ui(&f.root, &bad).is_err());
        }
        assert_eq!(
            f.c()
                .query_row(
                    "SELECT COUNT(*) FROM tag_assignment_exclusion_reviews",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            3
        );
    }

    #[test]
    fn exclusion_review_confirmation_snapshot_and_event_scope() {
        let f = Fixture::new();
        let pid = f.propose();
        let now = now_timestamp();
        for entity in ["one", "two"] {
            f.c().execute("INSERT INTO tag_assignment_exclusion_events(tag,entity_id,proposal_id,excluded,request_key,request_hash,created_at) VALUES ('focus',?1,?2,1,?1,'test',?3)",params![entity,pid,now-200*86400]).unwrap();
        }
        let list = json!({"action":"list_exclusions","tag":"focus","mode":"review","limit":1});
        let first = ui(&f.root, &list).unwrap();
        let id: i64 = f
            .c()
            .query_row(
                "SELECT id FROM tag_assignment_exclusion_events WHERE entity_id='one'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let a = json!({"action":"preview_exclusion_review","exclusionEventId":id,"nextReviewAt":now+86400});
        let p = ui(&f.root, &a).unwrap();
        assert_eq!(
            f.c()
                .query_row(
                    "SELECT COUNT(*) FROM tag_assignment_exclusion_reviews",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        let mut apply = a.clone();
        apply["action"] = json!("apply_exclusion_review");
        apply["confirmationToken"] = p["confirmationToken"].clone();
        apply["requestId"] = json!("review-one");
        assert_eq!(ui(&f.root, &apply).unwrap()["exclusionChanged"], false);
        assert_eq!(ui(&f.root, &apply).unwrap()["replayed"], true);
        assert_eq!(
            f.c()
                .query_row(
                    "SELECT COUNT(*) FROM tag_assignment_exclusion_reviews",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(
            f.c()
                .query_row(
                    "SELECT COUNT(*) FROM tag_assignment_exclusion_events",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            2
        );
        let mut stale = apply.clone();
        stale["requestId"] = json!("stale");
        assert!(ui(&f.root, &stale).is_err());
        let mut next = list.clone();
        next["cursor"] = first["nextCursor"].clone();
        assert_eq!(ui(&f.root, &next).unwrap()["items"][0]["entityId"], "one");
        assert!(ui(&f.root, &list).unwrap()["nextCursor"].is_null());
        let active = ui(
            &f.root,
            &json!({"action":"list_exclusions","mode":"active"}),
        )
        .unwrap();
        assert_eq!(active["items"][1]["nextReviewAt"], now + 86400);
        f.c()
            .execute(
                "UPDATE tag_assignment_exclusion_reviews SET next_review_at=?1",
                [now - 1],
            )
            .unwrap();
        assert!(!ui(&f.root, &list).unwrap()["nextCursor"].is_null());
        f.c().execute("INSERT INTO tag_assignment_exclusion_events(tag,entity_id,proposal_id,excluded,request_key,request_hash,created_at) VALUES ('focus','one',?1,1,'renewed','test',?2)",params![pid,now]).unwrap();
        assert!(ui(&f.root, &a).is_err());
        let renewed = ui(
            &f.root,
            &json!({"action":"list_exclusions","mode":"active"}),
        )
        .unwrap();
        assert!(renewed["items"][0]["nextReviewAt"].is_null());
    }

    #[test]
    fn exclusion_age_review_filters_latest_active_events_without_writes() {
        let f = Fixture::new();
        let pid = f.propose();
        let now = now_timestamp();
        let add = |entity: &str, time: i64, excluded: bool, key: &str| {
            f.c().execute("INSERT INTO tag_assignment_exclusion_events(tag,entity_id,proposal_id,excluded,request_key,request_hash,created_at) VALUES ('focus',?1,?2,?3,?4,'test',?5)",params![entity,pid,excluded,key,time]).unwrap();
        };
        add("old1", now - 200 * 86400, true, "old1");
        add("old2", now - 200 * 86400, true, "old2");
        add("recent", now - 86400, true, "recent");
        add("unknown", 0, true, "unknown");
        add("future", now + 86400, true, "future");
        add("revoked", now - 200 * 86400, true, "before-revoke");
        add("revoked", now, false, "revoke");
        add("renewed", now - 200 * 86400, true, "before-renew");
        add("renewed", now, true, "renew");
        let a = json!({"action":"list_exclusions","tag":"focus","mode":"review","olderThanDays":90,"limit":1});
        let first = ui(&f.root, &a).unwrap();
        assert_eq!(first["items"][0]["entityId"], "old2");
        add("late", now - 200 * 86400, true, "late");
        let mut next = a.clone();
        next["cursor"] = first["nextCursor"].clone();
        let second = ui(&f.root, &next).unwrap();
        assert_eq!(second["items"][0]["entityId"], "old1");
        assert!(second["nextCursor"].is_null());
        assert_eq!(first["asOf"], second["asOf"]);
        next["olderThanDays"] = json!(30);
        assert!(ui(&f.root, &next).is_err());
        for days in [0, -1, 3651] {
            let mut bad = a.clone();
            bad["olderThanDays"] = json!(days);
            assert!(ui(&f.root, &bad).is_err());
        }
        let mut bad = a.clone();
        bad["mode"] = json!("history");
        assert!(ui(&f.root, &bad).is_err());
        let mut all = a;
        all["limit"] = json!(50);
        assert_eq!(
            ui(&f.root, &all).unwrap()["items"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
        assert_eq!(
            f.c()
                .query_row(
                    "SELECT COUNT(*) FROM tag_assignment_exclusion_events",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            10
        );
    }

    #[test]
    fn assignment_exclusion_requires_confirmation_is_reversible_and_scoped() {
        let f = Fixture::new();
        let id = f.propose();
        let mut a = json!({"action":"preview_exclusion","proposalId":id,"excluded":true});
        assert!(ui(&f.root, &a).is_err());
        f.resolve(&id, "reject");
        let p = ui(&f.root, &a).unwrap();
        let entity = f.args()["source"].clone();
        assert_eq!(
            evidence(&f.root, &json!({"source":entity,"tag":"focus"})).unwrap()
                ["exclusionPreference"]["excluded"],
            false
        );
        a["action"] = json!("apply_exclusion");
        a["requestId"] = json!("exclude");
        a["confirmationToken"] = p["confirmationToken"].clone();
        ui(&f.root, &a).unwrap();
        assert_eq!(ui(&f.root, &a).unwrap()["replayed"], true);
        assert_eq!(
            evidence(&f.root, &json!({"source":entity,"tag":"focus"})).unwrap()
                ["exclusionPreference"]["excluded"],
            true
        );
        assert_eq!(
            evidence(&f.root, &json!({"source":entity,"tag":"other"})).unwrap()
                ["exclusionPreference"]["excluded"],
            false
        );
        f.define(1);
        let mut args = f.args();
        args["definitionVersion"] = json!(2);
        args["idempotencyKey"] = json!("blocked");
        args["reconsiderationReason"] = json!("New version");
        assert!(submit(&f.root, &args).unwrap_err().contains("持续排除"));
        let revoke = json!({"action":"preview_exclusion","proposalId":id,"excluded":false});
        let p = ui(&f.root, &revoke).unwrap();
        let mut apply = revoke.clone();
        apply["action"] = json!("apply_exclusion");
        apply["requestId"] = json!("revoke");
        apply["confirmationToken"] = p["confirmationToken"].clone();
        ui(&f.root, &apply).unwrap();
        assert_eq!(
            submit(&f.root, &args).unwrap()["proposal"]["status"],
            "pending"
        );
        let mut stale = a.clone();
        stale["requestId"] = json!("stale");
        assert!(ui(&f.root, &stale).is_err());
        assert_eq!(
            f.c()
                .query_row(
                    "SELECT COUNT(*) FROM tag_assignment_exclusion_events",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            2
        );
        assert_eq!(f.preview(&id)["proposal"]["status"], "rejected");
        assert_eq!(
            f.c()
                .query_row("SELECT COUNT(*) FROM hub_content_tags", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn assignment_exclusion_migrates_54_and_invalidates_pending_review() {
        let f = Fixture::new();
        let id = f.propose();
        f.resolve(&id, "reject");
        f.define(1);
        let mut args = f.args();
        args["definitionVersion"] = json!(2);
        args["idempotencyKey"] = json!("new");
        args["reconsiderationReason"] = json!("Updated scope");
        let p = submit(&f.root, &args).unwrap();
        let new = p["proposal"]["proposalId"].as_str().unwrap();
        let old = f.preview(new);
        f.c().execute_batch("DROP TABLE tag_assignment_exclusion_events; UPDATE metadata SET value='54' WHERE key='schema_version';").unwrap();
        forget_initialized_database(&f.root.join("craft-search.sqlite3"));
        let a = json!({"action":"preview_exclusion","proposalId":id,"excluded":true});
        let p = ui(&f.root, &a).unwrap();
        ui(&f.root,&json!({"action":"apply_exclusion","proposalId":id,"excluded":true,"requestId":"exclusion","confirmationToken":p["confirmationToken"]})).unwrap();
        let fresh = f.preview(new);
        assert_eq!(fresh["reviewBlocked"], true);
        assert_ne!(old["reviewToken"], fresh["reviewToken"]);
        assert!(resolve(
            &f.root,
            &json!({"proposalId":new,"resolution":"accept","reviewToken":fresh["reviewToken"]})
        )
        .is_err());
    }

    #[test]
    fn assignment_cross_version_rejection_requires_reason_preserves_decision() {
        let f = Fixture::new();
        let id = f.propose();
        f.resolve(&id, "reject");
        f.define(1);
        let mut a = f.args();
        a["definitionVersion"] = json!(2);
        a["idempotencyKey"] = json!("next");
        assert!(submit(&f.root, &a)
            .unwrap_err()
            .contains("reconsiderationReason"));
        let e = evidence(&f.root, &json!({"tag":"focus","source":a["source"]})).unwrap();
        assert_eq!(e["rejectionHistory"]["items"][0]["proposalId"], id);
        assert_eq!(e["rejectionHistory"]["items"][0]["sameSourceHash"], true);
        a["reconsiderationReason"] =
            json!("Updated boundary warrants review; previous rejection remains valid history.");
        let new = submit(&f.root, &a).unwrap();
        assert_eq!(new["proposal"]["status"], "pending");
        assert_eq!(
            new["proposal"]["proposal"]["rejectionHistoryAtSubmission"]["items"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(f.preview(&id)["proposal"]["status"], "rejected");
        assert_eq!(submit(&f.root, &a).unwrap()["replayed"], true);
        a["idempotencyKey"] = json!("duplicate");
        a.as_object_mut().unwrap().remove("reconsiderationReason");
        assert_eq!(submit(&f.root, &a).unwrap()["existing"], true);
        let p = f.preview(new["proposal"]["proposalId"].as_str().unwrap());
        assert_eq!(p["rejectionHistory"]["items"][0]["definitionVersion"], 1);
        assert_eq!(
            f.c()
                .query_row("SELECT COUNT(*) FROM hub_content_tags", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn assignment_rejection_history_is_bounded_scoped_and_token_bound() {
        let f = Fixture::new();
        let first = f.propose();
        f.resolve(&first, "reject");
        for n in 0..6 {
            f.c().execute("INSERT INTO tag_assignment_proposals(id,tag,status,proposal_json,request_key,request_hash,created_at,updated_at) SELECT ?1,tag,status,proposal_json,?1,request_hash,created_at,updated_at FROM tag_assignment_proposals WHERE id=?2",params![format!("copy-{n}"),first]).unwrap();
        }
        let source = f.args()["source"].clone();
        let e = evidence(&f.root, &json!({"tag":"focus","source":source})).unwrap();
        assert_eq!(e["rejectionHistory"]["items"].as_array().unwrap().len(), 5);
        assert_eq!(e["rejectionHistory"]["hasMore"], true);
        let other = evidence(&f.root, &json!({"tag":"another","source":source})).unwrap();
        assert!(other["rejectionHistory"]["items"]
            .as_array()
            .unwrap()
            .is_empty());
        let parent=evidence(&f.root,&json!({"tag":"focus","source":{"provider":"craft","libraryId":"lib","documentId":"doc","pageId":"doc"}})).unwrap();
        assert!(parent["rejectionHistory"]["items"]
            .as_array()
            .unwrap()
            .is_empty());
        let old = f.preview(&first)["reviewToken"].clone();
        f.c()
            .execute(
                "UPDATE tag_assignment_proposals SET note='new audit note' WHERE id<>?1",
                [&first],
            )
            .unwrap();
        assert_ne!(old, f.preview(&first)["reviewToken"]);
    }

    #[test]
    fn assignment_rejects_changed_content_and_old_preview_even_if_document_hash_unchanged() {
        let f = Fixture::new();
        let id = f.propose();
        let old = f.preview(&id);
        f.c()
            .execute(
                "UPDATE content_items SET body=body || ' changed' WHERE id='child'",
                [],
            )
            .unwrap();
        let current = f.preview(&id);
        assert_eq!(current["stale"], true);
        assert_eq!(current["reviewBlocked"], true);
        for token in [old["reviewToken"].clone(), current["reviewToken"].clone()] {
            assert!(resolve(
                &f.root,
                &json!({"proposalId":id,"resolution":"accept","reviewToken":token})
            )
            .is_err());
        }
        assert_eq!(f.members(), 0);
        assert_eq!(f.resolve(&id, "reject")["proposal"]["status"], "rejected");
    }
    #[test]
    fn assignment_definition_versions_block_old_submissions_and_approvals() {
        let f = Fixture::new();
        let args = f.args();
        let id = f.propose();
        f.define(1);
        assert_eq!(f.preview(&id)["stale"], true);
        let mut next = args;
        next["idempotencyKey"] = json!("changed-definition");
        assert!(submit(&f.root, &next).unwrap_err().contains("定义"));
        assert_eq!(f.members(), 0);
    }
    #[test]
    fn assignment_idempotency_business_deduplication_and_status_guard() {
        let f = Fixture::new();
        let args = f.args();
        let id = f.propose();
        assert_eq!(submit(&f.root, &args).unwrap()["replayed"], true);
        let mut changed = args.clone();
        changed["rationale"] = json!("different");
        assert!(submit(&f.root, &changed).is_err());
        changed["idempotencyKey"] = json!("another-key");
        assert_eq!(
            submit(&f.root, &changed).unwrap()["proposal"]["proposalId"],
            id
        );
        f.resolve(&id, "reject");
        assert_eq!(
            submit(&f.root, &changed).unwrap()["proposal"]["status"],
            "rejected"
        );
        assert!(resolve(&f.root,&json!({"proposalId":id,"resolution":"accept","reviewToken":f.preview(&id)["reviewToken"]})).is_err());
        assert_eq!(f.members(), 0);
    }
    #[test]
    fn assignment_requires_live_exact_evidence_and_keeps_conservative_decisions_blocked() {
        let f = Fixture::new();
        let mut a = f.args();
        a["quote"] = json!("invented quotation");
        assert!(submit(&f.root, &a).is_err());
        a = f.args();
        a["source"]["pageId"] = json!("doc");
        assert!(submit(&f.root, &a).is_err());
        a = f.args();
        a["decision"] = json!("related_only");
        let id = submit(&f.root, &a).unwrap()["proposal"]["proposalId"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(f.preview(&id)["reviewBlocked"], true);
        f.c().execute("UPDATE libraries SET enabled=0", []).unwrap();
        assert_eq!(f.preview(&id)["stale"], true);
        assert!(evidence(&f.root, &json!({"source":a["source"]})).is_err());
    }
    #[test]
    fn assignment_evidence_paginates_and_mcp_has_no_approval_tool() {
        let f = Fixture::new();
        let a = f.args();
        let page = evidence(&f.root, &json!({"source":a["source"],"maxChars":5})).unwrap();
        assert_eq!(page["content"], "Pause");
        let next = evidence(
            &f.root,
            &json!({"source":a["source"],"startChar":page["nextStartChar"],"maxChars":6000}),
        )
        .unwrap();
        assert_eq!(
            format!(
                "{}{}",
                page["content"].as_str().unwrap(),
                next["content"].as_str().unwrap()
            ),
            a["quote"]
        );
        assert_eq!(next["sourceHash"], page["sourceHash"]);
        let tools = tools();
        assert_eq!(tools.len(), 6);
        assert_eq!(
            tools
                .iter()
                .filter(|t| t["annotations"]["readOnlyHint"] == false)
                .count(),
            2
        );
        assert_eq!(
            tools.last().unwrap()["name"],
            "hub_submit_tag_assignment_proposal"
        );
    }
}
