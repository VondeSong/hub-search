//! A bounded, durable content manifest for one confirmed tag. Never approves tags.
use super::*;
use tag_assignment::{entity, read_definition, Locator};
#[path = "tag_content_scan_checks.rs"]
mod checks;
#[path = "tag_content_scan_discovery.rs"]
mod discovery;
#[path = "tag_content_scan_generate.rs"]
pub(super) mod generate;
#[path = "tag_content_scan_incremental.rs"]
mod incremental;
#[path = "tag_content_scan_joint.rs"]
mod joint;
#[path = "tag_content_scan_reopen.rs"]
mod reopen;
#[path = "tag_content_scan_union.rs"]
mod union;

// Match the canonical evidence identity without loading any source body.
fn locator_entity_id(source: &Locator) -> String {
    if source.provider == "craft" {
        format!(
            "craft:{}:{}:{}",
            source.library_id, source.document_id, source.page_id
        )
    } else {
        format!(
            "{}:{}:{}",
            source.provider, source.library_id, source.document_id
        )
    }
}

fn skip_excluded(c: &Connection, r: &Value, a: &Value) -> Result<Value, String> {
    if union::enabled(r) {
        return Err("合并范围任务须用 read 逐标签检查，不能按主标签排除整篇".into());
    }
    let id = r["runId"].as_str().unwrap();
    let ordinal = number(a, "ordinal", 0, i64::MAX as u64)?;
    let (raw, state): (String, String) = c
        .query_row(
            "SELECT source_json,state FROM tag_content_scan_items WHERE run_id=?1 AND ordinal=?2",
            params![id, ordinal],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "清单项不存在".to_string())?;
    if state != "unread" {
        return Err("仅未读项可按用户排除跳过；恢复须在 Hub 单独确认".into());
    }
    let source: Locator = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let entity_id = locator_entity_id(&source);
    let preference = tag_assignment::exclusion_state(c, r["tag"].as_str().unwrap(), &entity_id)?;
    let excluded = preference["excluded"] == true;
    if excluded {
        c.execute(
            "UPDATE tag_content_scan_items SET state='excluded' WHERE run_id=?1 AND ordinal=?2",
            params![id, ordinal],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(
        json!({"ordinal":ordinal,"state":if excluded {"excluded"} else {"not_excluded"},
        "entityId":entity_id,"exclusionPreference":preference,"analyzed":false}),
    )
}

fn hash(v: &Value) -> String {
    format!("{:x}", Sha256::digest(v.to_string().as_bytes()))
}

fn required(a: &Value, key: &str) -> Result<String, String> {
    let s = argument_text(a, key);
    if s.is_empty() || s.chars().count() > 240 {
        return Err(format!("{key} 必填且最多 240 字符"));
    }
    Ok(s.to_string())
}

fn number(a: &Value, key: &str, default: u64, max: u64) -> Result<u64, String> {
    let n = match a.get(key) {
        Some(v) => v.as_u64().ok_or_else(|| format!("{key} 必须为非负整数"))?,
        None => default,
    };
    if n > max {
        return Err(format!("{key} 超出上限 {max}"));
    }
    Ok(n)
}

fn run(c: &Connection, id: &str) -> Result<Value, String> {
    c.query_row("SELECT tag,definition_json,version,status,max_entities,max_chars,entities_read,chars_read,created_at,manifest_mode FROM tag_content_scan_runs WHERE id=?1",[id],|r| {
        let raw: String = r.get(1)?;
        Ok(json!({"runId":id,"tag":r.get::<_,String>(0)?,"definition":serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null),
            "version":r.get::<_,i64>(2)?,"status":r.get::<_,String>(3)?,
            "maxEntities":r.get::<_,i64>(4)?,"maxChars":r.get::<_,i64>(5)?,
            "entitiesRead":r.get::<_,i64>(6)?,"charsRead":r.get::<_,i64>(7)?,"createdAt":r.get::<_,i64>(8)?,"manifestMode":r.get::<_,String>(9)?}))
    }).map_err(|_|"内容扫描任务不存在".into())
}

fn blockers(c: &Connection, r: &Value) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    if joint::stale(c, r)? {
        out.push("额外标签定义已变化：联合任务仅可查看，请重新规划".into());
    }
    if read_definition(c, r["tag"].as_str().unwrap_or_default())?.as_ref() != Some(&r["definition"])
    {
        out.push("标签定义或范围已变化：旧任务只读，请重新规划".into());
    }
    for lib in union::scope(c, r)?.as_array().ok_or("任务定义损坏")? {
        let enabled: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM libraries WHERE id=?1 AND enabled=1 AND provider IN ('craft','obsidian','dida365'))",[lib.as_str().unwrap_or_default()],|row|row.get(0)).map_err(|e|e.to_string())?;
        if !enabled {
            out.push(format!(
                "资料库已不可用：{}",
                lib.as_str().unwrap_or_default()
            ));
        }
    }
    Ok(out)
}

fn report(c: &Connection, id: &str) -> Result<Value, String> {
    let mut r = run(c, id)?;
    r["incremental"] = incremental::metadata(c, id)?;
    r["manifestScope"] = union::scope(c, &r)?;
    let mut counts = json!({"unread":0,"read":0,"recorded":0,"reused":0,"already_tagged":0,"unavailable":0,"excluded":0,"joint_only":0});
    let mut st = c
        .prepare("SELECT state,COUNT(*) FROM tag_content_scan_items WHERE run_id=?1 GROUP BY state")
        .map_err(|e| e.to_string())?;
    for row in st
        .query_map([id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|e| e.to_string())?
    {
        let (state, n) = row.map_err(|e| e.to_string())?;
        counts[state] = json!(n);
    }
    let total: i64 = counts
        .as_object()
        .unwrap()
        .values()
        .filter_map(Value::as_i64)
        .sum();
    r["totalEntities"] = json!(total);
    r["jointSelection"] = joint::selection(c, &r)?;
    let mut joint_counts = json!({"pending":0,"recorded":0,"excluded":0,"already_tagged":0,"out_of_scope":0,"unavailable":0});
    let mut joint_st=c.prepare("SELECT state,COUNT(*) FROM tag_content_scan_joint_items WHERE run_id=?1 GROUP BY state").map_err(|e|e.to_string())?;
    for row in joint_st
        .query_map([id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|e| e.to_string())?
    {
        let (state, count) = row.map_err(|e| e.to_string())?;
        joint_counts[state] = json!(count);
    }
    let covered: i64 = joint_counts
        .as_object()
        .unwrap()
        .values()
        .filter_map(Value::as_i64)
        .sum();
    joint_counts["unvisited"] =
        json!(total * r["jointSelection"].as_array().map_or(0, |v| v.len() as i64) - covered);
    r["jointCounts"] = joint_counts;
    r["jointCoverageClaim"] = json!(if union::enabled(&r) {
        "confirmed_union_secondary_pairs"
    } else {
        "primary_manifest_secondary_pairs_not_full_corpus"
    });
    r["counts"] = counts;
    let mut decisions =
        json!({"recommend_add":0,"related_only":0,"out_of_scope":0,"insufficient_evidence":0});
    let mut st=c.prepare("SELECT decision,COUNT(*) FROM tag_content_scan_items WHERE run_id=?1 AND state='recorded' GROUP BY decision").map_err(|e|e.to_string())?;
    for row in st
        .query_map([id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|e| e.to_string())?
    {
        let (decision, n) = row.map_err(|e| e.to_string())?;
        decisions[decision] = json!(n);
    }
    r["decisionCounts"] = decisions;
    r["blockers"] = json!(blockers(c, &r)?);
    r["stale"] = json!(!r["blockers"].as_array().unwrap().is_empty());
    r["remainingChars"] = json!(r["maxChars"].as_i64().unwrap() - r["charsRead"].as_i64().unwrap());
    r["remainingEntities"] =
        json!(r["maxEntities"].as_i64().unwrap() - r["entitiesRead"].as_i64().unwrap());
    r["coverageClaim"] = json!("manifest_accounting_not_full_semantic_analysis");
    r["sourceTagsModified"] = json!(false);
    r["limitations"] = json!([
        "清单冻结开始时的已索引 Craft 页面、Obsidian 笔记和滴答任务定位，不包含之后新增内容、图片或附件",
        "正文在 read 时读取当前版本，record 时再次校验；清单不是正文快照",
        "recorded 仅表示有已保存的判断，不表示判断正确、已批准或读完全文；unavailable 是未解决项",
        "reused 是完整正文证据未变时关联已有待审核判断，不是本轮新分析；原判断仍可能有误，审核时再次校验",
        "预算仅约束本任务 read 返回的正文字符和不同实体数，不等于 Codex 总 token；不要通过其他工具或新任务绕过预算"
    ]);
    Ok(r)
}

pub(super) fn status(root: &Path, a: &Value) -> Result<Value, String> {
    let c = open_database(&hub_mcp_database(root)?)?;
    let mut id = argument_text(a, "runId").to_string();
    if id.is_empty() {
        let tag = normalized_tag_argument(a, "tag")?;
        id = c.query_row("SELECT id FROM tag_content_scan_runs WHERE tag=?1 ORDER BY created_at DESC,id DESC LIMIT 1",[tag],|r|r.get(0)).optional().map_err(|e|e.to_string())?.unwrap_or_default();
        if id.is_empty() {
            return Ok(json!({"run":null}));
        }
    }
    match argument_text(a, "mode") {
        "" | "progress" => {}
        "new_entities" => return discovery::list(&c, &id, a),
        _ => return Err("mode 必须为 progress 或 new_entities".into()),
    }
    if a.get("cursor").is_some() {
        return Err("进度查询使用 afterOrdinal；cursor 仅用于 new_entities".into());
    }
    let after = number(a, "afterOrdinal", 0, i64::MAX as u64)?;
    let limit = number(a, "limit", 20, 50)?.max(1);
    let filter = match argument_text(a, "filter") {
        "" | "pending" => "pending",
        "all" => "all",
        _ => return Err("filter 必须为 pending 或 all".into()),
    };
    let mut st = c.prepare("SELECT ordinal,source_json,title,state,proposal_id,decision,error,source_hash,spans_json FROM tag_content_scan_items WHERE run_id=?1 AND ordinal>?2 AND (?3='all' OR state IN ('unread','read') OR EXISTS(SELECT 1 FROM tag_content_scan_joint_items j WHERE j.run_id=tag_content_scan_items.run_id AND j.ordinal=tag_content_scan_items.ordinal AND j.state='pending')) ORDER BY ordinal LIMIT ?4").map_err(|e|e.to_string())?;
    let mut items = st.query_map(params![id,after,filter,limit+1],|r| {
        let raw:String=r.get(1)?;
        let raw_spans:String=r.get(8)?;
        let spans:Value=serde_json::from_str(&raw_spans).unwrap_or(Value::Null);
        Ok(json!({"ordinal":r.get::<_,i64>(0)?,"source":serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null),
            "title":r.get::<_,String>(2)?,"state":r.get::<_,String>(3)?,"proposalId":r.get::<_,String>(4)?,
            "decision":r.get::<_,String>(5)?,"error":r.get::<_,String>(6)?,"readSourceHash":r.get::<_,String>(7)?,
            "lastCoveredRange":spans.as_array().and_then(|v|v.last()),"coveredRangeCount":spans.as_array().map(Vec::len)}))
    }).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    let more = items.len() > limit as usize;
    items.truncate(limit as usize);
    let current = report(&c, &id)?;
    for item in &mut items {
        item["jointItems"] = joint::progress(&c, &current, item["ordinal"].as_i64())?;
    }
    Ok(
        json!({"run":report(&c,&id)?,"nextAfterOrdinal":if more {items.last().unwrap()["ordinal"].clone()}else{Value::Null},"items":items}),
    )
}

fn start(c: &Connection, a: &Value) -> Result<Value, String> {
    let tag = normalized_tag_argument(a, "tag")?;
    let key = required(a, "idempotencyKey")?;
    let prior: Option<(String, String)> = c
        .query_row(
            "SELECT id,request_hash FROM tag_content_scan_runs WHERE request_key=?1",
            [&key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some((id, h)) = prior {
        if h != hash(a) {
            return Err("幂等键已用于不同的任务参数".into());
        }
        return Ok(json!({"run":report(c,&id)?,"replayed":true}));
    }
    let definition = read_definition(c, &tag)?.ok_or("请先在 Hub 保存补标定义和范围")?;
    if a["definitionVersion"] != definition["version"] {
        return Err("标签定义已变化，请重新读取".into());
    }
    let max_entities = number(a, "maxEntities", 30, 5000)?;
    let max_chars = number(a, "maxChars", 15_000, 5_000_000)?;
    if max_entities == 0 || max_chars == 0 {
        return Err("预算必须大于零".into());
    }
    let id = format!("content-scan-{}", random_url_safe(12));
    c.execute("INSERT INTO tag_content_scan_runs(id,tag,definition_json,max_entities,max_chars,request_key,request_hash,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",params![id,tag,definition.to_string(),max_entities,max_chars,key,hash(a),now_timestamp()]).map_err(|e|e.to_string())?;
    let r = run(c, &id)?;
    let baseline = if a.get("incrementalFromRunId").is_some_and(|v| !v.is_null()) {
        if a.get("unionTags").is_some_and(|v| !v.is_null()) {
            return Err("增量任务继承基准标签集合，不能同时指定 unionTags".into());
        }
        let base_id = required(a, "incrementalFromRunId")?;
        let (base, sources, fingerprint) = incremental::baseline(c, &base_id)?;
        if base["tag"] != r["tag"] || base["definition"] != r["definition"] {
            return Err("增量基准不属于当前标签定义".into());
        }
        if union::enabled(&base) {
            let tags: Vec<Value> = joint::selection(c, &base)?
                .as_array()
                .unwrap()
                .iter()
                .map(|v| json!({"tag":v["tag"],"definitionVersion":v["definitionVersion"]}))
                .collect();
            union::configure(c, &r, &json!({"unionTags":tags}))?;
        }
        c.execute("INSERT INTO tag_content_scan_incremental(run_id,base_run_id,baseline_hash) VALUES (?1,?2,?3)",params![id,base_id,fingerprint]).map_err(|e|e.to_string())?;
        Some(sources)
    } else {
        union::configure(c, &r, a)?;
        None
    };
    let r = run(c, &id)?;
    let reasons = blockers(c, &r)?;
    if !reasons.is_empty() {
        return Err(reasons.join("；"));
    }
    let scope = union::scope(c, &r)?.to_string();
    let mut rows = enumerate_sources(c, &scope)?;
    if let Some(previous) = baseline {
        rows.retain(|(source, _)| !previous.contains(&serde_json::to_string(source).unwrap()));
        if rows.is_empty() {
            return Err("没有基准链之外的新增实体，无需创建增量任务".into());
        }
    }
    for (i, (source, title)) in rows.into_iter().enumerate() {
        c.execute("INSERT INTO tag_content_scan_items(run_id,ordinal,source_json,title) VALUES (?1,?2,?3,?4)",params![id,(i+1) as i64,serde_json::to_string(&source).map_err(|e|e.to_string())?,title.chars().take(200).collect::<String>()]).map_err(|e|e.to_string())?;
    }
    Ok(json!({"run":report(c,&id)?}))
}

fn enumerate_sources(c: &Connection, scope: &str) -> Result<Vec<(Locator, String)>, String> {
    // Enumerate entities, not tags or search hits. Parent/child pages remain distinct.
    let mut st=c.prepare("SELECT d.provider,d.space_id,d.id,
        CASE WHEN d.provider='craft' THEN COALESCE(NULLIF(ci.page_id,''),ci.document_id) ELSE '' END page,
        MIN(CASE WHEN d.provider='craft' AND ci.page_title<>'' THEN ci.page_title ELSE d.title END)
        FROM documents d JOIN libraries l ON l.id=d.space_id AND l.enabled=1
        LEFT JOIN content_items ci ON d.provider='craft' AND ci.space_id=d.space_id AND ci.document_id=d.id
            AND COALESCE(ci.source_item_id,'')='' AND ci.content_type IN ('document','craft_subpage','markdown_section')
        WHERE d.space_id IN (SELECT value FROM json_each(?1)) AND (
            (d.provider='craft' AND ci.id IS NOT NULL) OR d.provider='obsidian' OR
            (d.provider='dida365' AND EXISTS(SELECT 1 FROM dida_tasks t WHERE t.library_id=d.space_id AND t.task_id=d.id)))
        GROUP BY d.provider,d.space_id,d.id,page ORDER BY d.provider,d.space_id,d.id,page LIMIT 100001").map_err(|e|e.to_string())?;
    let rows = st
        .query_map([scope], |r| {
            Ok((
                Locator {
                    provider: r.get(0)?,
                    library_id: r.get(1)?,
                    document_id: r.get(2)?,
                    page_id: r.get(3)?,
                },
                r.get::<_, String>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    if rows.len() > 100_000 {
        return Err("范围超过 100000 个实体，请缩小定义范围，不会保存截断清单".into());
    }
    Ok(rows)
}

fn read_item(c: &Connection, r: &Value, a: &Value) -> Result<Value, String> {
    let id = r["runId"].as_str().unwrap();
    let ordinal = number(a, "ordinal", 0, i64::MAX as u64)?;
    let (raw,state,old_hash,raw_spans,read_once):(String,String,String,String,bool)=c.query_row("SELECT source_json,state,source_hash,spans_json,read_once FROM tag_content_scan_items WHERE run_id=?1 AND ordinal=?2",params![id,ordinal],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?))).map_err(|_|"清单项不存在".to_string())?;
    if matches!(
        state.as_str(),
        "recorded" | "reused" | "already_tagged" | "excluded"
    ) {
        return Err("此项已处理，不能重复读取".into());
    }
    let source: Locator = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let mut e = match entity(c, &source) {
        Ok(v) => v,
        Err(reason) => {
            union::unavailable(c, r, ordinal)?;
            c.execute("UPDATE tag_content_scan_items SET state='unavailable',error=?3 WHERE run_id=?1 AND ordinal=?2",params![id,ordinal,reason]).map_err(|e|e.to_string())?;
            return Ok(json!({"ordinal":ordinal,"state":"unavailable","reason":reason}));
        }
    };
    let tag = r["tag"].as_str().unwrap();
    let additional_contexts = joint::contexts(c, r, a, &e)?;
    if union::enabled(r) {
        e["primaryTagStatus"] = json!(union::primary_status(c, r, &e)?);
        e["additionalTagContexts"] = additional_contexts.clone().ok_or("联合选择缺失")?;
        if e["primaryTagStatus"] != "eligible"
            && !e["additionalTagContexts"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v["status"] == "eligible")
        {
            joint::remember(c, r, ordinal, &e)?;
            c.execute("UPDATE tag_content_scan_items SET state='joint_only',source_hash=?3,spans_json='[]' WHERE run_id=?1 AND ordinal=?2",params![id,ordinal,e["sourceHash"].as_str()]).map_err(|e|e.to_string())?;
            e.as_object_mut().unwrap().remove("content");
            return Ok(
                json!({"ordinal":ordinal,"state":"joint_only","evidence":e,"analyzed":false}),
            );
        }
    }
    if !union::enabled(r)
        && ["sourceTags", "internalTags"].iter().any(|key| {
            e[key].as_array().is_some_and(|vs| {
                vs.iter()
                    .any(|v| v.as_str().is_some_and(|s| s.to_lowercase() == tag))
            })
        })
    {
        c.execute("UPDATE tag_content_scan_items SET state='already_tagged',error='' WHERE run_id=?1 AND ordinal=?2",params![id,ordinal]).map_err(|e|e.to_string())?;
        return Ok(json!({"ordinal":ordinal,"state":"already_tagged"}));
    }
    if e["content"].as_str().unwrap_or_default().trim().is_empty() {
        union::unavailable(c, r, ordinal)?;
        c.execute("UPDATE tag_content_scan_items SET state='unavailable',error='正文为空，未分析' WHERE run_id=?1 AND ordinal=?2",params![id,ordinal]).map_err(|e|e.to_string())?;
        return Ok(json!({"ordinal":ordinal,"state":"unavailable","reason":"正文为空，未分析"}));
    }
    let remaining = r["maxChars"].as_u64().unwrap() - r["charsRead"].as_u64().unwrap();
    if remaining == 0 || (!read_once && r["entitiesRead"] == r["maxEntities"]) {
        return Err("任务预算已用尽，进度保留；不要自动新建任务或改用无预算接口继续读取".into());
    }
    let content = e["content"].as_str().unwrap();
    let total = content.chars().count();
    let start = number(a, "startChar", 0, total as u64)? as usize;
    if start >= total {
        return Err("startChar 必须指向有效正文".into());
    }
    let requested = number(a, "maxChars", 1500, 6000)?.max(1).min(remaining) as usize;
    let part = content
        .chars()
        .skip(start)
        .take(requested)
        .collect::<String>();
    let end = start + part.chars().count();
    let mut spans: Vec<(usize, usize)> = if old_hash == e["sourceHash"].as_str().unwrap() {
        serde_json::from_str(&raw_spans).map_err(|e| e.to_string())?
    } else {
        Vec::new()
    };
    if spans.len() >= 256 {
        return Err("单实体最多 256 次分段取证".into());
    }
    spans.push((start, end));
    spans.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (start, end) in spans {
        if let Some(last) = merged.last_mut().filter(|last| start <= last.1) {
            last.1 = last.1.max(end);
        } else {
            merged.push((start, end));
        }
    }
    let spans = merged;
    c.execute("UPDATE tag_content_scan_items SET state='read',source_hash=?3,spans_json=?4,read_once=1,error='' WHERE run_id=?1 AND ordinal=?2",params![id,ordinal,e["sourceHash"].as_str(),serde_json::to_string(&spans).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
    c.execute("UPDATE tag_content_scan_runs SET entities_read=entities_read+?2,chars_read=chars_read+?3 WHERE id=?1",params![id,if read_once {0}else{1},(end-start) as i64]).map_err(|e|e.to_string())?;
    e["rejectionHistory"] = tag_assignment::rejection_history(c, tag, &e, "")?;
    e["exclusionPreference"] =
        tag_assignment::exclusion_state(c, tag, e["entityId"].as_str().unwrap_or_default())?;
    e["content"] = json!(part);
    if let Some(contexts) = additional_contexts {
        e["additionalTagContexts"] = contexts;
        e["jointCoverageClaim"] = json!(if union::enabled(r) {
            "confirmed_union_scope"
        } else {
            "selected_secondary_tags_on_primary_manifest_only"
        });
    }
    e["startChar"] = json!(start);
    e["totalChars"] = json!(total);
    e["nextStartChar"] = if end < total { json!(end) } else { Value::Null };
    joint::remember(c, r, ordinal, &e)?;
    if union::enabled(r) && e["primaryTagStatus"] != "eligible" {
        c.execute(
            "UPDATE tag_content_scan_items SET state='joint_only' WHERE run_id=?1 AND ordinal=?2",
            params![id, ordinal],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(json!({"ordinal":ordinal,"state":"read","evidence":e}))
}

// Character offsets are Unicode scalar offsets, matching read_item, not UTF-8 bytes.
fn verified_cache_range(e: &Value, ev: &Value, chars: &[char]) -> Option<(usize, usize)> {
    if ev["source"] != e["source"]
        || ev["sourceHash"] != e["sourceHash"]
        || ev["sourceTags"] != e["sourceTags"]
        || ev["internalTags"] != e["internalTags"]
        || ev["totalChars"].as_u64()? != chars.len() as u64
    {
        return None;
    }
    let start = usize::try_from(ev["startChar"].as_u64()?).ok()?;
    let part = ev["content"].as_str()?;
    let length = part.chars().count();
    if length == 0 || length > 6000 {
        return None;
    }
    let end = start.checked_add(length)?;
    let expected = chars.get(start..end)?;
    if !part.chars().eq(expected.iter().copied()) {
        return None;
    }
    if end == chars.len() {
        if !ev["nextStartChar"].is_null() {
            return None;
        }
    } else if ev["nextStartChar"].as_u64()? != end as u64 {
        return None;
    }
    Some((start, end))
}

fn complete_cache_coverage(mut ranges: Vec<(usize, usize)>, total: usize) -> bool {
    ranges.sort_unstable();
    let mut covered = 0;
    for (start, end) in ranges {
        if start > covered {
            return false;
        }
        covered = covered.max(end);
    }
    total > 0 && covered == total
}

// All validated read fragments must belong to one original run and cover the current text.
// Reused items never become cache donors, and rejected/withdrawn proposals never qualify.
fn reuse(c: &Connection, r: &Value, a: &Value) -> Result<Value, String> {
    if union::enabled(r) {
        return Err("合并范围任务需要逐标签取证，不能仅复用主标签判断".into());
    }
    let id = r["runId"].as_str().unwrap();
    let ordinal = number(a, "ordinal", 0, i64::MAX as u64)?;
    let (raw, state): (String, String) = c
        .query_row(
            "SELECT source_json,state FROM tag_content_scan_items WHERE run_id=?1 AND ordinal=?2",
            params![id, ordinal],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "清单项不存在".to_string())?;
    if state != "unread" {
        return Err("仅未读项可尝试复用；已读项按原取证流程处理".into());
    }
    let source: Locator = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let e = entity(c, &source)?;
    let miss = || json!({"ordinal":ordinal,"state":"cache_miss","notice":"未找到可安全复用的完整正文判断，按原预算 read 取证；未返回正文"});
    let reopened: i64 = c
        .query_row(
            "SELECT reopened_version FROM tag_content_scan_items WHERE run_id=?1 AND ordinal=?2",
            params![id, ordinal],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if reopened > 0 {
        return Ok(
            json!({"ordinal":ordinal,"state":"cache_miss","notice":"此项经用户重开，必须重新 read，不沿用旧判断"}),
        );
    }
    let tag = r["tag"].as_str().unwrap();
    if ["sourceTags", "internalTags"].iter().any(|k| {
        e[k].as_array().is_some_and(|tags| {
            tags.iter()
                .any(|t| t.as_str().is_some_and(|t| t.to_lowercase() == tag))
        })
    }) {
        return Ok(miss());
    }
    let content = e["content"].as_str().unwrap();
    if content.chars().count() > 200_000 {
        return Ok(miss());
    }
    let chars: Vec<char> = content.chars().collect();
    let mut st = c.prepare("SELECT i.run_id,i.ordinal,i.proposal_id,p.proposal_json FROM tag_content_scan_items i JOIN tag_content_scan_runs r ON r.id=i.run_id JOIN tag_assignment_proposals p ON p.id=i.proposal_id WHERE i.run_id<>?1 AND i.source_json=?2 AND i.source_hash=?3 AND i.state='recorded' AND r.tag=?4 AND r.definition_json=?5 AND p.status='pending' ORDER BY r.created_at DESC,r.id DESC LIMIT 20").map_err(|e|e.to_string())?;
    let candidates = st
        .query_map(
            params![
                id,
                raw,
                e["sourceHash"].as_str(),
                tag,
                r["definition"].to_string()
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    for (old_run, old_ordinal, proposal_id, raw_p) in candidates {
        let p: Value = serde_json::from_str(&raw_p).map_err(|e| e.to_string())?;
        if p["source"] != e["source"]
            || p["sourceHash"] != e["sourceHash"]
            || p["definitionVersion"] != r["definition"]["version"]
            || p["definition"] != r["definition"]["definition"]
            || p["tag"] != r["tag"]
            || !p["confidence"].as_f64().is_some_and(|v| v >= 0.75)
            || !matches!(
                p["decision"].as_str(),
                Some("recommend_add" | "related_only" | "out_of_scope")
            )
            || p["quote"]
                .as_str()
                .is_none_or(|q| q.is_empty() || !content.contains(q))
        {
            continue;
        }
        let mut receipts = c.prepare("SELECT response_json FROM tag_content_scan_receipts WHERE run_id=?1 AND json_extract(response_json,'$.result.ordinal')=?2 AND json_extract(response_json,'$.result.state')='read' AND json_extract(response_json,'$.run.version')>(SELECT reopened_version FROM tag_content_scan_items WHERE run_id=?1 AND ordinal=?2) ORDER BY request_id LIMIT 512").map_err(|e|e.to_string())?;
        let reads = receipts
            .query_map(params![old_run, old_ordinal], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let mut ranges = Vec::new();
        for raw_read in reads {
            let receipt: Value = serde_json::from_str(&raw_read.map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            let ev = &receipt["result"]["evidence"];
            if let Some(range) = verified_cache_range(&e, ev, &chars) {
                ranges.push(range);
            }
        }
        let read_receipt_count = ranges.len();
        if !complete_cache_coverage(ranges, chars.len()) {
            continue;
        }
        c.execute("UPDATE tag_content_scan_items SET state='reused',proposal_id=?3,decision=?4,source_hash=?5 WHERE run_id=?1 AND ordinal=?2",params![id,ordinal,proposal_id,p["decision"].as_str(),e["sourceHash"].as_str()]).map_err(|e|e.to_string())?;
        return Ok(
            json!({"ordinal":ordinal,"state":"reused","proposalId":proposal_id,"decision":p["decision"],"fromRunId":old_run,"fromOrdinal":old_ordinal,"verifiedReadReceiptCount":read_receipt_count,"coveredChars":chars.len(),"source":e["source"],"sourceHash":e["sourceHash"],"contextHash":hash(&json!([e["sourceTags"],e["internalTags"]])),"notice":"复用已有待审核判断，不是本轮新分析；完整覆盖仅指取证范围，不保证判断正确。未读取正文到 Codex、未批准标签，请 preview 原建议"}),
        );
    }
    Ok(miss())
}

fn record(c: &Connection, r: &Value, a: &Value) -> Result<Value, String> {
    let id = r["runId"].as_str().unwrap();
    let ordinal = number(a, "ordinal", 0, i64::MAX as u64)?;
    let proposal_id = required(a, "proposalId")?;
    let (raw,state,source_hash,spans):(String,String,String,String)=c.query_row("SELECT source_json,state,source_hash,spans_json FROM tag_content_scan_items WHERE run_id=?1 AND ordinal=?2",params![id,ordinal],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).map_err(|_|"清单项不存在".to_string())?;
    if state != "read" {
        return Err("必须先通过本任务 read 取证，再记录已有建议".into());
    }
    let (tag, p): (String, String) = c
        .query_row(
            "SELECT tag,proposal_json FROM tag_assignment_proposals WHERE id=?1",
            [&proposal_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "补标建议不存在，请先提交待审核".to_string())?;
    let p: Value = serde_json::from_str(&p).map_err(|e| e.to_string())?;
    let source: Locator = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let e = entity(c, &source)?;
    if tag != r["tag"].as_str().unwrap()
        || p["source"] != serde_json::to_value(&source).map_err(|e| e.to_string())?
        || p["definitionVersion"] != r["definition"]["version"]
    {
        return Err("建议的标签、来源或定义版本不属于当前清单项".into());
    }
    if union::enabled(r) && union::primary_status(c, r, &e)? != "eligible" {
        return Err("主标签当前不适用或已排除，请重新核对".into());
    }
    if p["sourceHash"] != source_hash || e["sourceHash"] != source_hash {
        return Err("正文版本已变化或建议不对应本轮取证，请重新 read".into());
    }
    let spans: Vec<(usize, usize)> = serde_json::from_str(&spans).map_err(|e| e.to_string())?;
    let quote = p["quote"].as_str().unwrap_or_default();
    if quote.is_empty()
        || !spans.iter().any(|(start, end)| {
            e["content"]
                .as_str()
                .unwrap()
                .chars()
                .skip(*start)
                .take(end - start)
                .collect::<String>()
                .contains(quote)
        })
    {
        return Err("建议原文未出现在本任务实际返回的证据片段中，请定向补读".into());
    }
    c.execute("UPDATE tag_content_scan_items SET state='recorded',proposal_id=?3,decision=?4 WHERE run_id=?1 AND ordinal=?2",params![id,ordinal,proposal_id,p["decision"].as_str()]).map_err(|e|e.to_string())?;
    Ok(
        json!({"ordinal":ordinal,"proposalId":proposal_id,"decision":p["decision"],"state":"recorded"}),
    )
}

pub(super) fn step(root: &Path, a: &Value) -> Result<Value, String> {
    if a.get("unionTags").is_some() || a.get("incrementalFromRunId").is_some() {
        return Err("合并范围只能在 Hub 预览并确认新任务，不能由 MCP 扩大范围".into());
    }
    if a.get("additionalTags").is_some() && argument_text(a, "action") != "read" {
        return Err("additionalTags 仅可用于 read，不扩大任务范围或复用结论".into());
    }
    let mut c = open_database(&hub_mcp_database(root)?)?;
    let tx = c
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    if argument_text(a, "action") == "start" {
        let result = start(&tx, a)?;
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(result);
    }
    let id = required(a, "runId")?;
    let request_id = required(a, "requestId")?;
    let prior:Option<(String,String)>=tx.query_row("SELECT request_hash,response_json FROM tag_content_scan_receipts WHERE run_id=?1 AND request_id=?2",params![id,request_id],|row|Ok((row.get(0)?,row.get(1)?))).optional().map_err(|e|e.to_string())?;
    if let Some((h, raw)) = prior {
        if h != hash(a) {
            return Err("requestId 已用于不同的参数".into());
        }
        let mut result: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        let receipt_version = result["run"]["version"].as_i64().unwrap_or(0);
        let ordinal = result["result"]["ordinal"].as_i64().unwrap_or(0);
        let reopened:i64 = tx.query_row("SELECT reopened_version FROM tag_content_scan_items WHERE run_id=?1 AND ordinal=?2",params![id,ordinal],|row|row.get(0)).optional().map_err(|e|e.to_string())?.unwrap_or(0);
        result["run"] = report(&tx, &id)?;
        if reopened > 0 && receipt_version <= reopened {
            result["result"] = json!({"ordinal":ordinal,"state":"superseded_by_reopen","notice":"此项已由用户重开，旧回执仅供历史审计，不能用于当前取证或记录"});
            result["replayed"] = json!(true);
            return Ok(result);
        }
        if result["result"]["state"] == "reused" {
            let source: Locator = serde_json::from_value(result["result"]["source"].clone())
                .map_err(|e| e.to_string())?;
            let valid = entity(&tx, &source).is_ok_and(|e| {
                e["sourceHash"] == result["result"]["sourceHash"]
                    && hash(&json!([e["sourceTags"], e["internalTags"]]))
                        == result["result"]["contextHash"]
            });
            let pending:bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM tag_assignment_proposals WHERE id=?1 AND status='pending')",[result["result"]["proposalId"].as_str().unwrap_or_default()],|row|row.get(0)).map_err(|e|e.to_string())?;
            if !valid || !pending || result["run"]["stale"] == true {
                result["result"]["state"] = json!("stale_reuse");
                result["result"]["notice"] =
                    json!("原复用依据已变化，此回执不能作为当前有效判断；历史台账保留，需重新规划");
            }
        }
        if let Some(ev) = result.pointer("/result/evidence").cloned() {
            let source: Locator =
                serde_json::from_value(ev["source"].clone()).map_err(|e| e.to_string())?;
            let current = entity(&tx, &source);
            let joint_valid = if ev.get("additionalTagContexts").is_some() {
                current.as_ref().is_ok_and(|v| {
                    v["sourceTags"] == ev["sourceTags"]
                        && v["internalTags"] == ev["internalTags"]
                        && joint::contexts(&tx, &result["run"], a, v).is_ok_and(|contexts| {
                            contexts.as_ref() == ev.get("additionalTagContexts")
                        })
                })
            } else {
                true
            };
            let primary_valid = !union::enabled(&result["run"])
                || current.as_ref().is_ok_and(|v| {
                    union::primary_status(&tx, &result["run"], v)
                        .is_ok_and(|s| ev["primaryTagStatus"] == s)
                });
            if !joint_valid
                || !primary_valid
                || result["run"]["stale"] == true
                || !current
                    .as_ref()
                    .is_ok_and(|v| v["sourceHash"] == ev["sourceHash"])
            {
                result["result"].as_object_mut().unwrap().remove("evidence");
                result["result"]["state"] = json!("stale_evidence");
            }
        }
        result["replayed"] = json!(true);
        result["replayNotice"] =
            json!("这是原操作回执，证据不是重新读取的当前正文；record 会重新校验版本");
        return Ok(result);
    }
    let r = run(&tx, &id)?;
    if a["expectedVersion"] != r["version"] {
        return Err("任务进度已变化，请先读取 hub_tag_content_scan_status".into());
    }
    if r["status"] != "active" {
        return Err("任务已经结束，只可查看".into());
    }
    let reasons = blockers(&tx, &r)?;
    if !reasons.is_empty() {
        return Err(reasons.join("；"));
    }
    let result = match argument_text(a, "action") {
        "read" => read_item(&tx, &r, a)?,
        "record" => record(&tx, &r, a)?,
        "record_secondary" => joint::record(&tx, &r, a)?,
        "reuse" => reuse(&tx, &r, a)?,
        "skip_excluded" => skip_excluded(&tx, &r, a)?,
        "finish" => {
            if union::enabled(&r) && report(&tx, &id)?["jointCounts"]["unvisited"] != 0 {
                return Err("合并清单仍有未访问的标签组合，不能结束".into());
            }
            let pending:i64=tx.query_row("SELECT COUNT(*) FROM tag_content_scan_joint_items WHERE run_id=?1 AND state='pending'",[&id],|row|row.get(0)).map_err(|e|e.to_string())?;
            if pending > 0 {
                return Err("仍有额外标签待判断，不能结束；先逐项提交并 record_secondary".into());
            }
            let n:i64=tx.query_row("SELECT COUNT(*) FROM tag_content_scan_items WHERE run_id=?1 AND state IN ('unread','read')",[&id],|row|row.get(0)).map_err(|e|e.to_string())?;
            if n > 0 {
                return Err("仍有未读取或未记录判断的实体，不能结束".into());
            }
            tx.execute(
                "UPDATE tag_content_scan_runs SET status='completed' WHERE id=?1",
                [&id],
            )
            .map_err(|e| e.to_string())?;
            json!({"manifestFinished":true,"semanticAnalysisComplete":false})
        }
        _ => return Err("action 必须为 start/read/record/reuse/skip_excluded/finish".into()),
    };
    tx.execute(
        "UPDATE tag_content_scan_runs SET version=version+1 WHERE id=?1",
        [&id],
    )
    .map_err(|e| e.to_string())?;
    let response = json!({"run":report(&tx,&id)?,"result":result});
    tx.execute("INSERT INTO tag_content_scan_receipts(run_id,request_id,request_hash,response_json) VALUES (?1,?2,?3,?4)",params![id,request_id,hash(a),response.to_string()]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(response)
}

fn budget_preview(c: &Connection, a: &Value) -> Result<Value, String> {
    let id = required(a, "runId")?;
    let r = report(c, &id)?;
    if a["expectedVersion"] != r["version"] {
        return Err("任务进度已变化，请刷新后重新预览".into());
    }
    if r["status"] != "active" || r["stale"] == true {
        return Err("任务已结束或定义/范围已过期，不能追加预算".into());
    }
    if r["counts"]["unread"].as_u64().unwrap_or(0) + r["counts"]["read"].as_u64().unwrap_or(0) == 0
    {
        return Err("清单已无待处理项，无需追加预算".into());
    }
    let add_entities = number(a, "addEntities", 0, 5000)?;
    let add_chars = number(a, "addChars", 0, 5_000_000)?;
    if add_entities == 0 && add_chars == 0 {
        return Err("至少追加一项额度".into());
    }
    let next_entities = r["maxEntities"].as_u64().unwrap() + add_entities;
    let next_chars = r["maxChars"].as_u64().unwrap() + add_chars;
    if next_entities > 5000 || next_chars > 5_000_000 {
        return Err("单任务总额度最多 5000 个实体、5000000 正文字符".into());
    }
    let change = json!({"runId":id,"tag":r["tag"],"expectedVersion":r["version"],"addEntities":add_entities,"addChars":add_chars,
        "before":{"maxEntities":r["maxEntities"],"maxChars":r["maxChars"]},"after":{"maxEntities":next_entities,"maxChars":next_chars},
        "entitiesRead":r["entitiesRead"],"charsRead":r["charsRead"],"definition":r["definition"],"actor":"hub-user"});
    Ok(json!({"change":change,"confirmationToken":hash(&change),"sourceTagsModified":false}))
}

fn budget_status(c: &Connection, id: &str) -> Result<Value, String> {
    let mut st=c.prepare("SELECT change_json,created_at FROM tag_content_scan_budget_history WHERE run_id=?1 ORDER BY created_at DESC,local_seq DESC LIMIT 10").map_err(|e|e.to_string())?;
    let history=st.query_map([id],|r| {
        let raw:String=r.get(0)?;
        Ok(json!({"change":serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null),"createdAt":r.get::<_,i64>(1)?}))
    }).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    Ok(json!({"run":report(c,id)?,"budgetHistory":history}))
}

fn new_round_preview(c: &Connection, a: &Value) -> Result<Value, String> {
    let tag = normalized_tag_argument(a, "tag")?;
    let definition = read_definition(c, &tag)?.ok_or("请先在 Hub 保存补标定义与范围")?;
    let max_entities = number(a, "maxEntities", 30, 5000)?;
    let max_chars = number(a, "maxChars", 15000, 5_000_000)?;
    let mut st = c
        .prepare("SELECT id,version,status FROM tag_content_scan_runs WHERE tag=?1 ORDER BY id")
        .map_err(|e| e.to_string())?;
    let prior = st
        .query_map([&tag], |r| {
            Ok(json!([
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?
            ]))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    // Reuse the actual manifest builder under a savepoint. Preview never persists a run.
    c.execute_batch("SAVEPOINT new_round_preview")
        .map_err(|e| e.to_string())?;
    let result = (|| {
        let r = start(
            c,
            &json!({"tag":tag,"definitionVersion":definition["version"],"idempotencyKey":format!("preview-{}",random_url_safe(16)),"maxEntities":max_entities,"maxChars":max_chars,"unionTags":a.get("unionTags"),"incrementalFromRunId":a.get("incrementalFromRunId")}),
        )?;
        let id = r["run"]["runId"].as_str().unwrap();
        let mut st=c.prepare("SELECT source_json,title FROM tag_content_scan_items WHERE run_id=?1 ORDER BY ordinal").map_err(|e|e.to_string())?;
        let items = st
            .query_map([id], |r| {
                Ok(json!([r.get::<_, String>(0)?, r.get::<_, String>(1)?]))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let plan = json!({"tag":tag,"incrementalFromRunId":a.get("incrementalFromRunId"),"incremental":r["run"]["incremental"],"unionTags":a.get("unionTags"),"jointSelection":r["run"]["jointSelection"],"manifestMode":r["run"]["manifestMode"],"manifestScope":r["run"]["manifestScope"],"definition":definition,"maxEntities":max_entities,"maxChars":max_chars,"totalEntities":items.len(),"manifestHash":hash(&json!(items)),"priorRunsHash":hash(&json!(prior)),"previousRunCount":prior.len(),"activeRunCount":prior.iter().filter(|r|r[2]=="active").count()});
        Ok(json!({"plan":plan,"confirmationToken":hash(&plan)}))
    })();
    c.execute_batch("ROLLBACK TO new_round_preview; RELEASE new_round_preview")
        .map_err(|e| e.to_string())?;
    result
}

// Only reachable from the desktop command router, never registered as MCP tools.
pub(super) fn ui(root: &Path, a: &Value) -> Result<Value, String> {
    if matches!(
        argument_text(a, "action"),
        "scan_check_save" | "scan_check_saved" | "scan_check_history"
    ) {
        return checks::ui(root, a);
    }
    if matches!(
        argument_text(a, "action"),
        "scan_reopen_items"
            | "scan_reopen_history"
            | "scan_check_items"
            | "scan_preview_reopen"
            | "scan_apply_reopen"
    ) {
        return reopen::ui(root, a);
    }
    if argument_text(a, "action") == "scan_budget_history" {
        let id = required(a, "runId")?;
        let c = open_database(&hub_mcp_database(root)?)?;
        run(&c, &id)?;
        let limit = number(a, "limit", 20, 50)?.max(1);
        let (time, key) = if argument_text(a, "cursor").is_empty() {
            (i64::MAX, String::new())
        } else {
            let (cursor_run, time, key): (String, i64, String) =
                serde_json::from_str(argument_text(a, "cursor")).map_err(|_| "预算历史游标无效")?;
            if cursor_run != id {
                return Err("预算历史游标不属于当前任务".into());
            }
            (time, key)
        };
        let mut st = c.prepare("SELECT request_id,change_json,created_at FROM tag_content_scan_budget_history WHERE run_id=?1 AND (created_at<?2 OR (created_at=?2 AND request_id<?3)) ORDER BY created_at DESC,request_id DESC LIMIT ?4").map_err(|e| e.to_string())?;
        let mut entries = st.query_map(params![id,time,key,limit+1], |r| {
            let raw: String = r.get(1)?;
            Ok(json!({"requestId":r.get::<_,String>(0)?,"change":serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null),"createdAt":r.get::<_,i64>(2)?}))
        }).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
        let more = entries.len() > limit as usize;
        entries.truncate(limit as usize);
        let next = if more {
            let last = entries.last().unwrap();
            json!(json!([id, last["createdAt"], last["requestId"]]).to_string())
        } else {
            Value::Null
        };
        return Ok(json!({"entries":entries,"nextCursor":next}));
    }
    if argument_text(a, "action") == "scan_history" {
        let tag = normalized_tag_argument(a, "tag")?;
        let c = open_database(&hub_mcp_database(root)?)?;
        let limit = number(a, "limit", 20, 50)?.max(1);
        let (time, id) = if argument_text(a, "cursor").is_empty() {
            (i64::MAX, String::new())
        } else {
            serde_json::from_str::<(i64, String)>(argument_text(a, "cursor"))
                .map_err(|_| "历史游标无效")?
        };
        let mut st=c.prepare("SELECT id,created_at,version,status,max_entities,max_chars,entities_read,chars_read FROM tag_content_scan_runs WHERE tag=?1 AND (created_at<?2 OR (created_at=?2 AND id<?3)) ORDER BY created_at DESC,id DESC LIMIT ?4").map_err(|e|e.to_string())?;
        let mut runs=st.query_map(params![tag,time,id,limit+1],|r|Ok(json!({"runId":r.get::<_,String>(0)?,"createdAt":r.get::<_,i64>(1)?,"version":r.get::<_,i64>(2)?,"status":r.get::<_,String>(3)?,"maxEntities":r.get::<_,i64>(4)?,"maxChars":r.get::<_,i64>(5)?,"entitiesRead":r.get::<_,i64>(6)?,"charsRead":r.get::<_,i64>(7)?}))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
        let more = runs.len() > limit as usize;
        runs.truncate(limit as usize);
        let cursor = if more {
            let last = runs.last().unwrap();
            json!([last["createdAt"], last["runId"]]).to_string()
        } else {
            String::new()
        };
        return Ok(json!({"runs":runs,"nextCursor":if more {json!(cursor)}else{Value::Null}}));
    }
    if argument_text(a, "action") == "scan_status" {
        let s = status(root, a)?;
        return match s["run"]["runId"].as_str() {
            Some(id) => budget_status(&open_database(&hub_mcp_database(root)?)?, id),
            None => Ok(json!({"run":null,"budgetHistory":[]})),
        };
    }
    let mut c = open_database(&hub_mcp_database(root)?)?;
    let tx = c
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    if argument_text(a, "action") == "scan_preview_new" {
        return new_round_preview(&tx, a);
    }
    if argument_text(a, "action") == "scan_create_new" {
        let token = required(a, "confirmationToken")?;
        let tag = normalized_tag_argument(a, "tag")?;
        let key = format!("new-round:{}", required(a, "requestId")?);
        let mut start_args = json!({"tag":tag,"definitionVersion":a["definitionVersion"],"maxEntities":a["maxEntities"],"maxChars":a["maxChars"],"idempotencyKey":key,"confirmationToken":token});
        if let Some(tags) = a.get("unionTags") {
            start_args["unionTags"] = tags.clone();
        }
        if let Some(base) = a.get("incrementalFromRunId") {
            start_args["incrementalFromRunId"] = base.clone();
        }
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM tag_content_scan_runs WHERE request_key=?1)",
                [&key],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !exists {
            let preview = new_round_preview(&tx, a)?;
            if preview["confirmationToken"] != token
                || preview["plan"]["definition"]["version"] != a["definitionVersion"]
            {
                return Err("新轮次预览已失效，定义、清单或旧任务进度已变化，请重新预览".into());
            }
        }
        let created = start(&tx, &start_args)?;
        let result = budget_status(&tx, created["run"]["runId"].as_str().unwrap())?;
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(result);
    }
    if argument_text(a, "action") == "scan_preview_budget" {
        return budget_preview(&tx, a);
    }
    if argument_text(a, "action") != "scan_apply_budget" {
        return Err("未知预算操作".into());
    }
    let id = required(a, "runId")?;
    let key = required(a, "requestId")?;
    let prior:Option<String>=tx.query_row("SELECT request_hash FROM tag_content_scan_budget_history WHERE run_id=?1 AND request_id=?2",params![id,key],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    if let Some(previous) = prior {
        if previous != hash(a) {
            return Err("预算请求编号已用于不同参数".into());
        }
        let mut response = budget_status(&tx, &id)?;
        response["replayed"] = json!(true);
        return Ok(response);
    }
    let preview = budget_preview(&tx, a)?;
    if a["confirmationToken"] != preview["confirmationToken"] {
        return Err("预算确认已失效，请重新预览，不会增加额度".into());
    }
    let change = &preview["change"];
    tx.execute("UPDATE tag_content_scan_runs SET max_entities=?2,max_chars=?3,version=version+1 WHERE id=?1",params![id,change["after"]["maxEntities"].as_u64(),change["after"]["maxChars"].as_u64()]).map_err(|e|e.to_string())?;
    tx.execute("INSERT INTO tag_content_scan_budget_history(run_id,request_id,request_hash,change_json,created_at) VALUES (?1,?2,?3,?4,?5)",params![id,key,hash(a),change.to_string(),now_timestamp()]).map_err(|e|e.to_string())?;
    let result = budget_status(&tx, &id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(result)
}

pub(super) fn tools() -> Vec<Value> {
    let common = json!({"runId":{"type":"string"},"tag":{"type":"string"},"mode":{"enum":["progress","new_entities"]},"cursor":{"type":"string","maxLength":256},"afterOrdinal":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":50},"filter":{"enum":["pending","all"]}});
    vec![
        json!({"name":"hub_tag_content_scan_status","description":"只读恢复内容扫描台账。用 runId 或 tag 查询；默认 progress 返回前20个未处理实体，不返回正文。counts 不代表全库语义分析完成。mode=new_entities 只读比较旧清单与当前确认范围内的索引定位，最多枚举100000个定位，每页最多50个新增项；使用 nextCursor 原样续页，不用 filter/afterOrdinal。游标绑定任务、定义和清单，变化后须重新首批。新增不是漏标建议，缺失不是来源删除，不检测正文变化。不扩大任务、不花正文预算、不创建调度；分析新增内容前须由用户预览确认新轮次。",
            "inputSchema":{"type":"object","properties":common,"anyOf":[{"required":["runId"]},{"required":["tag"]}],"additionalProperties":false},
            "annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}}),
        json!({"name":"hub_tag_content_scan_step","description":"若 run.manifestMode=union：范围已由桌面预览确认，read 按 primaryTagStatus 和 additionalTagContexts 分别判断，主标签非 eligible 不 record 但须检查额外标签；joint_only 元数据响应不算正文分析。禁止 skip_excluded/reuse 按主标签跳过整篇；finish 还要求额外 unvisited=0。MCP 不可创建或扩张 union 范围。以下主标签跳过规则仅适用于 single。用户授权逐批内容检查后，start 固定已确认标签定义范围内的文本实体清单和累计预算。未读项可先 skip_excluded：仅已有用户排除偏好才跳过，不读取正文、不扣预算、不是已分析；not_excluded 时继续 reuse/read。撤销排除后须在 Hub 单项确认恢复。未读项可先 reuse：逐段验证同一旧任务的原文、字符位置、定义和标签上下文，无缺口覆盖当前全文才关联较高置信度待审核判断为 reused。最多检查20候选、每候选512回执、正文200000字符；有缺口、超限或证据变化即 cache_miss，按返回版本正常 read，不循环查询。复用不返回正文、不扣正文额度，非本轮新分析，完整取证不保证判断正确。首次成功联合 read 固定额外标签集合与定义快照；后续 read 省略 additionalTags 自动恢复，显式变更被拒绝。status 返回 jointSelection/jointCounts 和每项 jointItems。额外建议提交并 preview 后，用 record_secondary(tag,ordinal,proposalId) 保存断点，按同任务真实证据强校验；存在 pending 额外判断不能 finish，unvisited 仍是未覆盖而非完成分析。read 可显式携带 additionalTags（最多4个 tag/definitionVersion），在同一正文旁返回各自定义、范围、排除及驳回历史，总额外上下文最多16000字符；不重复返回或扣费正文。仅 eligible 可独立提交内容补标建议，各自 preview，不能用主任务 record 记录额外标签。主任务已带标签/排除的项仍跳过，因此不是全库联合覆盖；上下文仍有 token 成本。read 按 ordinal 返回有限当前证据并扣减任务预算；补读也计费，同一 requestId 原参数重试不重复扣减。先提交补标建议，再 record 关联 proposalId，强校验本任务实际读过的证据。finish 只允许无未处理项。默认30实体/15000正文字符，预算耗尽保留断点并报告，不自动加预算或新开任务绕过。定义变化旧任务只读。不会批准或修改来源标签。",
            "inputSchema":{"type":"object","properties":{
                "action":{"enum":["start","read","record","record_secondary","reuse","skip_excluded","finish"]},"tag":{"type":"string"},"definitionVersion":{"type":"integer","minimum":1},"idempotencyKey":{"type":"string"},
                "runId":{"type":"string"},"requestId":{"type":"string"},"expectedVersion":{"type":"integer","minimum":1},"ordinal":{"type":"integer","minimum":1},
                "startChar":{"type":"integer","minimum":0},"maxChars":{"type":"integer","minimum":1,"maximum":5000000,"description":"start 的任务累计预算；read 单次最多6000"},
                "maxEntities":{"type":"integer","minimum":1,"maximum":5000},"proposalId":{"type":"string"},"additionalTags":{"type":"array","minItems":1,"maxItems":4,"items":{"type":"object","properties":{"tag":{"type":"string"},"definitionVersion":{"type":"integer","minimum":1}},"required":["tag","definitionVersion"],"additionalProperties":false},"description":"仅 read：用户明确选择的额外标签；共用这一份正文，不属于主任务覆盖计数"}},"required":["action"],"additionalProperties":false,
                "allOf":[{"if":{"properties":{"action":{"const":"start"}}},"then":{"required":["tag","definitionVersion","idempotencyKey"]},"else":{"required":["runId","requestId","expectedVersion"]}},
                    {"if":{"properties":{"action":{"const":"read"}}},"then":{"required":["ordinal"],"properties":{"maxChars":{"maximum":6000}}}},
                    {"if":{"properties":{"action":{"const":"record"}}},"then":{"required":["ordinal","proposalId"]}},
                    {"if":{"properties":{"action":{"const":"record_secondary"}}},"then":{"required":["ordinal","tag","proposalId"]}},
                    {"if":{"properties":{"action":{"enum":["reuse","skip_excluded"]}}},"then":{"required":["ordinal"]}}]},
            "annotations":{"readOnlyHint":false,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}}),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        root: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("hub-content-scan-test-{}", random_url_safe(12)));
            std::fs::create_dir_all(&root).unwrap();
            let f = Self { root };
            f.c().execute_batch("INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES ('lib','craft','Test',1,1),('excluded','obsidian','Private',1,1);
                INSERT INTO documents(space_id,id,title,path,markdown,indexed_at,content_hash,provider) VALUES
                ('lib','doc','Root','Root','parent and child',1,'hash','craft'),
                ('excluded','secret','Private','Private','excluded content',1,'hash','obsidian');
                INSERT INTO content_items(id,space_id,document_id,block_id,content_type,heading,body,ordinal,source_hash,page_id,page_title,provider) VALUES
                ('root','lib','doc','doc','document','Root','Parent tagged text.',0,'hash','doc','Root','craft'),
                ('child','lib','doc','child','craft_subpage','Child','Pause before acting. More context.',1,'hash','child','Child','craft'),
                ('child2','lib','doc','child2','craft_subpage','Child2','A different note.',2,'hash','child2','Child2','craft');
                INSERT INTO craft_tags(space_id,document_id,page_id,tag,normalized_tag) VALUES ('lib','doc','doc','focus','focus');").unwrap();
            f.define(0);
            f
        }
        fn c(&self) -> Connection {
            open_database(&self.root.join("craft-search.sqlite3")).unwrap()
        }
        fn define(&self, version: i64) {
            tag_assignment::ui(&self.root,&json!({"action":"save_definition","tag":"focus","expectedVersion":version,"definition":{"description":"Focus","include":"A pause before action","exclude":"Other topics","libraryIds":["lib"]}})).unwrap();
        }
        fn start(&self, chars: u64, entities: u64) -> Value {
            step(&self.root,&json!({"action":"start","tag":"focus","definitionVersion":1,"idempotencyKey":"start","maxChars":chars,"maxEntities":entities})).unwrap()["run"].clone()
        }
        fn read_args(r: &Value, ord: i64, key: &str) -> Value {
            json!({"action":"read","runId":r["runId"],"expectedVersion":r["version"],"requestId":key,"ordinal":ord,"maxChars":20})
        }
        fn read(&self, r: &Value, ord: i64, key: &str) -> Value {
            step(&self.root, &Self::read_args(r, ord, key)).unwrap()
        }
        fn proposal(&self, e: &Value, quote: &str) -> Value {
            tag_assignment::submit(&self.root,&json!({"schemaVersion":"hub.tag-assignment.v1","tag":"focus","definitionVersion":1,"source":e["source"],"sourceHash":e["sourceHash"],"decision":"recommend_add","quote":quote,"rationale":"Explicit pause","confidence":0.8,"executed":false,"idempotencyKey":random_url_safe(10),"generator":{"agent":"codex","workflow":"single-tag-assignment"}})).unwrap()["proposal"].clone()
        }
        fn record_args(r: &Value, p: &Value) -> Value {
            json!({"action":"record","runId":r["runId"],"expectedVersion":r["version"],"requestId":"record","ordinal":1,"proposalId":p["proposalId"]})
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn check_history_paginates_frozen_batches_and_rejects_cross_run_cursor() {
        let f = Fixture::new();
        let r = f.start(100, 30);
        let id = r["runId"].as_str().unwrap();
        let save = |key: &str| {
            ui(
                &f.root,
                &json!({"action":"scan_check_save","runId":id,"requestId":key,"limit":1}),
            )
            .unwrap()
        };
        save("one");
        save("two");
        save("three");
        let a = json!({"action":"scan_check_history","runId":id,"limit":1});
        let first = ui(&f.root, &a).unwrap();
        assert_eq!(first["entries"].as_array().unwrap().len(), 1);
        save("four");
        let mut next = a.clone();
        next["cursor"] = first["nextCursor"].clone();
        let second = ui(&f.root, &next).unwrap();
        assert!(
            second["entries"][0]["checkpointId"].as_i64()
                < first["entries"][0]["checkpointId"].as_i64()
        );
        next["cursor"] = second["nextCursor"].clone();
        let third = ui(&f.root, &next).unwrap();
        assert!(third["nextCursor"].is_null());
        let fresh = ui(&f.root, &a).unwrap();
        assert_ne!(fresh["snapshotMaxId"], first["snapshotMaxId"]);
        next["cursor"] = json!(json!(["other", 100, 1]).to_string());
        assert!(ui(&f.root, &next).is_err());
        f.define(1);
        assert_eq!(ui(&f.root, &a).unwrap()["entries"][0]["stale"], true);
        assert_eq!(
            f.c()
                .query_row("SELECT COUNT(*) FROM tag_content_scan_checks", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            4
        );
    }

    #[test]
    fn replayed_check_is_superseded_after_another_batch() {
        let f = Fixture::new();
        let r = f.start(100, 30);
        let mut a = json!({"action":"scan_check_save","runId":r["runId"],"requestId":"one"});
        ui(&f.root, &a).unwrap();
        a["requestId"] = json!("two");
        ui(&f.root, &a).unwrap();
        a["requestId"] = json!("one");
        let replay = ui(&f.root, &a).unwrap();
        assert_eq!(replay["checkpointSuperseded"], true);
        assert!(replay["nextCursor"].is_null());
        assert_eq!(replay["replayed"], true);
        let current = ui(
            &f.root,
            &json!({"action":"scan_check_saved","runId":r["runId"]}),
        )
        .unwrap();
        assert_eq!(current["checkpointSuperseded"], false);
    }

    #[test]
    fn persisted_check_restores_and_continues_without_changing_scan() {
        let f = Fixture::new();
        let r = f.start(100, 30);
        let id = r["runId"].as_str().unwrap();
        f.c()
            .execute(
                "UPDATE tag_content_scan_items SET state='unavailable' WHERE run_id=?1",
                [id],
            )
            .unwrap();
        let before = report(&f.c(), id).unwrap();
        let a = json!({"action":"scan_check_save","runId":id,"requestId":"check-one","limit":1});
        let first = ui(&f.root, &a).unwrap();
        assert_eq!(first["items"].as_array().unwrap().len(), 1);
        assert_eq!(
            ui(&f.root, &a).unwrap()["checkpointId"],
            first["checkpointId"]
        );
        let restore = ui(&f.root, &json!({"action":"scan_check_saved","runId":id})).unwrap();
        assert_eq!(restore["nextCursor"], first["nextCursor"]);
        assert_eq!(restore["historical"], true);
        let next = json!({"action":"scan_check_save","runId":id,"requestId":"check-two","limit":1,"cursor":restore["nextCursor"],"checkpointId":restore["checkpointId"]});
        let second = ui(&f.root, &next).unwrap();
        assert_ne!(second["items"][0]["ordinal"], first["items"][0]["ordinal"]);
        let mut old = next.clone();
        old["requestId"] = json!("old-cursor");
        assert!(ui(&f.root, &old).is_err());
        assert_eq!(report(&f.c(), id).unwrap(), before);
        f.c()
            .execute(
                "UPDATE tag_content_scan_runs SET version=version+1 WHERE id=?1",
                [id],
            )
            .unwrap();
        let stale = ui(&f.root, &json!({"action":"scan_check_saved","runId":id})).unwrap();
        assert_eq!(stale["checkpointStale"], true);
        assert!(stale["nextCursor"].is_null());
        assert_eq!(ui(&f.root, &a).unwrap()["checkpointStale"], true);
    }

    #[test]
    fn persisted_check_rejects_bad_requests_and_keeps_read_only_path() {
        let f = Fixture::new();
        let r = f.start(100, 30);
        let saved = json!({"action":"scan_check_saved","runId":r["runId"]});
        assert_eq!(ui(&f.root, &saved).unwrap()["saved"], false);
        ui(
            &f.root,
            &json!({"action":"scan_check_items","runId":r["runId"]}),
        )
        .unwrap();
        assert_eq!(ui(&f.root, &saved).unwrap()["saved"], false);
        let a =
            json!({"action":"scan_check_save","runId":r["runId"],"requestId":"check","limit":1});
        ui(&f.root, &a).unwrap();
        let mut changed = a.clone();
        changed["limit"] = json!(2);
        assert!(ui(&f.root, &changed).is_err());
        f.define(1);
        assert_eq!(ui(&f.root, &saved).unwrap()["checkpointStale"], true);
        let mut fresh = a;
        fresh["requestId"] = json!("fresh");
        assert!(ui(&f.root, &fresh).is_err());
        assert!(step(&f.root, &fresh).is_err());
    }

    #[test]
    fn incremental_rounds_preserve_ancestors_and_bind_preview() {
        let f = Fixture::new();
        let base = f.start(100, 30);
        let request = |id: &Value| json!({"action":"scan_preview_new","tag":"focus","incrementalFromRunId":id,"maxEntities":30,"maxChars":15000});
        assert!(ui(&f.root, &request(&base["runId"])).is_err());
        let add = |id: &str| {
            f.c().execute("INSERT INTO content_items(id,space_id,document_id,block_id,content_type,heading,body,ordinal,source_hash,page_id,page_title,provider) VALUES (?1,'lib','doc',?1,'craft_subpage',?1,'New content',10,'hash',?1,?1,'craft')",[id]).unwrap();
        };
        add("new-one");
        let p = ui(&f.root, &request(&base["runId"])).unwrap();
        assert_eq!(p["plan"]["totalEntities"], 1);
        assert_eq!(
            f.c()
                .query_row(
                    "SELECT COUNT(*) FROM tag_content_scan_incremental",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        let create = |id: &Value, p: &Value, key: &str| json!({"action":"scan_create_new","tag":"focus","incrementalFromRunId":id,"maxEntities":30,"maxChars":15000,"definitionVersion":1,"confirmationToken":p["confirmationToken"],"requestId":key});
        add("new-two");
        assert!(ui(&f.root, &create(&base["runId"], &p, "stale")).is_err());
        let p = ui(&f.root, &request(&base["runId"])).unwrap();
        let a = create(&base["runId"], &p, "delta");
        let first = ui(&f.root, &a).unwrap()["run"].clone();
        assert_eq!(first["totalEntities"], 2);
        assert_eq!(first["incremental"]["baseRunId"], base["runId"]);
        assert_eq!(ui(&f.root, &a).unwrap()["run"]["runId"], first["runId"]);
        assert_eq!(
            report(&f.c(), base["runId"].as_str().unwrap()).unwrap(),
            base
        );
        assert!(ui(&f.root, &request(&first["runId"])).is_err());
        add("new-three");
        let discovered = status(
            &f.root,
            &json!({"runId":first["runId"],"mode":"new_entities"}),
        )
        .unwrap();
        assert_eq!(discovered["newEntityCount"], 1);
        let p = ui(&f.root, &request(&first["runId"])).unwrap();
        let second = ui(&f.root, &create(&first["runId"], &p, "delta-two")).unwrap();
        assert_eq!(second["run"]["totalEntities"], 1);
        let items = status(&f.root, &json!({"runId":second["run"]["runId"]})).unwrap();
        assert_eq!(items["items"][0]["source"]["pageId"], "new-three");
        assert!(step(
            &f.root,
            &json!({"action":"start","tag":"focus","incrementalFromRunId":base["runId"]})
        )
        .is_err());
    }

    #[test]
    fn incremental_union_inherits_selection_and_rejects_changed_baseline() {
        let f = Fixture::new();
        f.c().execute_batch("INSERT INTO tag_assignment_definitions(tag,version,definition_json,updated_at) VALUES ('second',1,'{\"description\":\"Second\",\"include\":\"Test\",\"exclude\":\"\",\"libraryIds\":[\"excluded\"]}',1);").unwrap();
        let c = f.c();
        let base=start(&c,&json!({"tag":"focus","definitionVersion":1,"idempotencyKey":"base-union","unionTags":[{"tag":"second","definitionVersion":1}]})).unwrap()["run"].clone();
        c.execute_batch("INSERT INTO documents(space_id,id,title,path,markdown,indexed_at,content_hash,provider) VALUES ('excluded','new-note','New','New','Text',1,'hash','obsidian')").unwrap();
        let a =
            json!({"action":"scan_preview_new","tag":"focus","incrementalFromRunId":base["runId"]});
        let p = ui(&f.root, &a).unwrap();
        assert_eq!(p["plan"]["totalEntities"], 1);
        assert_eq!(p["plan"]["manifestMode"], "union");
        assert_eq!(p["plan"]["jointSelection"], base["jointSelection"]);
        let mut bad = a.clone();
        bad["unionTags"] = json!([]);
        assert!(ui(&f.root, &bad).is_err());
        c.execute(
            "UPDATE tag_assignment_definitions SET version=2 WHERE tag='second'",
            [],
        )
        .unwrap();
        assert!(ui(&f.root, &a).is_err());
    }

    #[test]
    fn new_entity_discovery_is_paginated_read_only_and_snapshot_bound() {
        let f = Fixture::new();
        let r = f.start(100, 30);
        let a = json!({"runId":r["runId"],"mode":"new_entities","limit":1});
        assert_eq!(status(&f.root, &a).unwrap()["newEntityCount"], 0);
        f.c().execute_batch("INSERT INTO content_items(id,space_id,document_id,block_id,content_type,heading,body,ordinal,source_hash,page_id,page_title,provider) VALUES
            ('new1','lib','doc','new1','craft_subpage','New1','secret body',3,'hash','new1','New1','craft'),
            ('new2','lib','doc','new2','craft_subpage','New2','secret body',4,'hash','new2','New2','craft');").unwrap();
        let first = status(&f.root, &a).unwrap();
        assert_eq!(first["newEntityCount"], 2);
        assert_eq!(first["currentEntityCount"], 5);
        assert_eq!(first["items"][0]["source"]["pageId"], "new1");
        assert!(!first.to_string().contains("secret body"));
        let mut next = a.clone();
        next["cursor"] = first["nextCursor"].clone();
        let second = status(&f.root, &next).unwrap();
        assert_eq!(second["items"][0]["source"]["pageId"], "new2");
        assert!(second["nextCursor"].is_null());
        assert_eq!(report(&f.c(), r["runId"].as_str().unwrap()).unwrap(), r);
        f.c()
            .execute("DELETE FROM content_items WHERE id='new1'", [])
            .unwrap();
        assert!(status(&f.root, &next).is_err());
        f.c()
            .execute("DELETE FROM content_items WHERE id='child'", [])
            .unwrap();
        assert_eq!(
            status(&f.root, &a).unwrap()["missingFromCurrentIndexCount"],
            1
        );
        f.define(1);
        assert!(status(&f.root, &a).is_err());
    }

    #[test]
    fn new_entity_discovery_respects_union_scope_and_rejects_mixed_paging() {
        let f = Fixture::new();
        let r = f.start(100, 30);
        let a = json!({"runId":r["runId"],"mode":"new_entities"});
        assert_eq!(status(&f.root, &a).unwrap()["newEntityCount"], 0);
        f.c().execute_batch("INSERT INTO tag_assignment_definitions(tag,version,definition_json,updated_at) VALUES ('second',1,'{\"description\":\"Second\",\"include\":\"Test\",\"exclude\":\"\",\"libraryIds\":[\"excluded\"]}',1);").unwrap();
        union::configure(
            &f.c(),
            &r,
            &json!({"unionTags":[{"tag":"second","definitionVersion":1}]}),
        )
        .unwrap();
        let union = status(&f.root, &a).unwrap();
        assert_eq!(union["manifestMode"], "union");
        assert_eq!(union["newEntityCount"], 1);
        assert_eq!(union["items"][0]["source"]["libraryId"], "excluded");
        for (key, value) in [
            ("afterOrdinal", json!(0)),
            ("filter", json!("all")),
            ("limit", json!(0)),
            ("cursor", json!("invalid")),
        ] {
            let mut bad = a.clone();
            bad[key] = value;
            assert!(status(&f.root, &bad).is_err());
        }
        let mut bad = a.clone();
        bad["mode"] = json!("progress");
        bad["cursor"] = json!("invalid");
        assert!(status(&f.root, &bad).is_err());
        let mut bad = a.clone();
        bad["mode"] = json!("unknown");
        assert!(status(&f.root, &bad).is_err());
    }

    #[test]
    fn union_preview_and_creation_bind_scope_without_expanding_old_runs() {
        let f = Fixture::new();
        let old = f.start(100, 30);
        f.c().execute_batch("INSERT INTO tag_assignment_definitions(tag,version,definition_json,updated_at) SELECT 'second',version,json_set(definition_json,'$.libraryIds',json('[\"lib\",\"excluded\"]')),updated_at FROM tag_assignment_definitions WHERE tag='focus'").unwrap();
        let mut args = json!({"action":"scan_preview_new","tag":"focus","maxEntities":30,"maxChars":100,"unionTags":[{"tag":"second","definitionVersion":1}]});
        let preview = ui(&f.root, &args).unwrap();
        assert_eq!(preview["plan"]["totalEntities"], 4);
        assert_eq!(preview["plan"]["manifestMode"], "union");
        assert_eq!(
            f.c()
                .query_row("SELECT COUNT(*) FROM tag_content_scan_runs", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        args["action"] = json!("scan_create_new");
        args["requestId"] = json!("union");
        args["definitionVersion"] = json!(1);
        args["confirmationToken"] = preview["confirmationToken"].clone();
        let created = ui(&f.root, &args).unwrap();
        assert_eq!(created["run"]["jointSelection"][0]["tag"], "second");
        assert_eq!(created["run"]["jointCounts"]["unvisited"], 4);
        assert_eq!(
            ui(&f.root, &args).unwrap()["run"]["runId"],
            created["run"]["runId"]
        );
        assert_eq!(
            report(&f.c(), old["runId"].as_str().unwrap()).unwrap()["totalEntities"],
            3
        );
        let root = f.read(&created["run"], 3, "root");
        assert_eq!(
            root["result"]["evidence"]["primaryTagStatus"],
            "already_tagged"
        );
        assert_eq!(
            root["result"]["evidence"]["additionalTagContexts"][0]["status"],
            "eligible"
        );
        assert_eq!(root["run"]["counts"]["joint_only"], 1);
        let private = f.read(&root["run"], 4, "private");
        assert_eq!(
            private["result"]["evidence"]["primaryTagStatus"],
            "out_of_scope"
        );
        assert_eq!(
            private["result"]["evidence"]["additionalTagContexts"][0]["status"],
            "eligible"
        );
        assert!(step(&f.root,&json!({"action":"skip_excluded","runId":created["run"]["runId"],"expectedVersion":private["run"]["version"],"ordinal":1,"requestId":"wrong-skip"})).is_err());
        assert!(step(&f.root, &json!({"action":"start","unionTags":[]})).is_err());
    }

    #[test]
    fn union_skips_only_when_all_tags_ineligible_and_accounts_unavailable() {
        let f = Fixture::new();
        f.c().execute_batch("INSERT INTO tag_assignment_definitions(tag,version,definition_json,updated_at) SELECT 'second',version,definition_json,updated_at FROM tag_assignment_definitions WHERE tag='focus'; INSERT INTO craft_tags(space_id,document_id,page_id,tag,normalized_tag) VALUES ('lib','doc','doc','second','second');").unwrap();
        let mut args = json!({"action":"scan_preview_new","tag":"focus","maxEntities":30,"maxChars":100,"unionTags":[{"tag":"second","definitionVersion":1}]});
        let preview = ui(&f.root, &args).unwrap();
        args["action"] = json!("scan_create_new");
        args["requestId"] = json!("union");
        args["definitionVersion"] = json!(1);
        args["confirmationToken"] = preview["confirmationToken"].clone();
        let created = ui(&f.root, &args).unwrap();
        let root = f.read(&created["run"], 3, "root");
        assert_eq!(root["result"]["state"], "joint_only");
        assert!(root["result"]["evidence"].get("content").is_none());
        assert_eq!(root["run"]["charsRead"], 0);
        assert_eq!(root["run"]["jointCounts"]["already_tagged"], 1);
        f.c()
            .execute_batch("DELETE FROM content_items WHERE page_id IN ('child','child2')")
            .unwrap();
        let one = f.read(&root["run"], 1, "gone1");
        let two = f.read(&one["run"], 2, "gone2");
        assert_eq!(two["run"]["jointCounts"]["unavailable"], 2);
        assert_eq!(two["run"]["jointCounts"]["unvisited"], 0);
        let finished=step(&f.root,&json!({"action":"finish","runId":two["run"]["runId"],"expectedVersion":two["run"]["version"],"requestId":"finish"})).unwrap();
        assert_eq!(finished["result"]["semanticAnalysisComplete"], false);
    }

    #[test]
    fn joint_read_shares_body_and_preserves_per_tag_boundaries() {
        let f = Fixture::new();
        f.c().execute_batch("INSERT INTO tag_assignment_definitions(tag,version,definition_json,updated_at) SELECT 'second',version,definition_json,updated_at FROM tag_assignment_definitions WHERE tag='focus';
            INSERT INTO tag_assignment_definitions(tag,version,definition_json,updated_at) SELECT 'blocked',version,definition_json,updated_at FROM tag_assignment_definitions WHERE tag='focus';
            INSERT INTO tag_assignment_definitions(tag,version,definition_json,updated_at) SELECT 'present',version,definition_json,updated_at FROM tag_assignment_definitions WHERE tag='focus';
            INSERT INTO tag_assignment_definitions(tag,version,definition_json,updated_at) SELECT 'elsewhere',version,json_set(definition_json,'$.libraryIds',json('[\"excluded\"]')),updated_at FROM tag_assignment_definitions WHERE tag='focus';
            INSERT INTO craft_tags(space_id,document_id,page_id,tag,normalized_tag) VALUES ('lib','doc','child','present','present');
            INSERT INTO tag_assignment_exclusion_events(tag,entity_id,proposal_id,excluded,request_key,request_hash,created_at) VALUES ('blocked','craft:lib:doc:child','test',1,'joint-exclude','hash',1);").unwrap();
        let r = f.start(100, 30);
        let mut a = Fixture::read_args(&r, 1, "joint");
        a["additionalTags"] = json!([{"tag":"second","definitionVersion":1},{"tag":"blocked","definitionVersion":1},{"tag":"present","definitionVersion":1},{"tag":"elsewhere","definitionVersion":1}]);
        let read = step(&f.root, &a).unwrap();
        let contexts = &read["result"]["evidence"]["additionalTagContexts"];
        for (i, state) in ["eligible", "excluded", "already_tagged", "out_of_scope"]
            .iter()
            .enumerate()
        {
            assert_eq!(contexts[i]["status"], *state);
            assert!(contexts[i].get("content").is_none());
        }
        assert_eq!(read["run"]["charsRead"], 20);
        assert_eq!(read["run"]["entitiesRead"], 1);
        assert_eq!(read["run"]["counts"]["read"], 1);
        assert_eq!(step(&f.root, &a).unwrap()["run"]["charsRead"], 20);
        let e = &read["result"]["evidence"];
        let p=tag_assignment::submit(&f.root,&json!({"schemaVersion":"hub.tag-assignment.v1","tag":"second","definitionVersion":1,"source":e["source"],"sourceHash":e["sourceHash"],"decision":"recommend_add","quote":"Pause before acting.","rationale":"Explicit pause","confidence":0.8,"executed":false,"idempotencyKey":"secondary","generator":{"agent":"codex","workflow":"multi-tag-assignment"}})).unwrap();
        assert_eq!(p["proposal"]["status"], "pending");
        assert!(step(&f.root, &Fixture::record_args(&read["run"], &p["proposal"])).is_err());
        let record = json!({"action":"record_secondary","runId":r["runId"],"expectedVersion":read["run"]["version"],"requestId":"secondary-record","ordinal":1,"tag":"second","proposalId":p["proposal"]["proposalId"]});
        let recorded = step(&f.root, &record).unwrap();
        assert_eq!(recorded["run"]["jointCounts"]["recorded"], 1);
        assert_eq!(recorded["run"]["jointCounts"]["excluded"], 1);
        assert_eq!(recorded["run"]["jointCounts"]["unvisited"], 8);
        assert_eq!(recorded["run"]["charsRead"], 20);
        assert_eq!(step(&f.root, &record).unwrap()["replayed"], true);
        assert_eq!(
            f.c()
                .query_row("SELECT COUNT(*) FROM hub_content_tags", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn joint_selection_restores_without_arguments_and_rejects_changes() {
        let f = Fixture::new();
        f.c().execute_batch("INSERT INTO tag_assignment_definitions(tag,version,definition_json,updated_at) SELECT 'second',version,definition_json,updated_at FROM tag_assignment_definitions WHERE tag='focus'; INSERT INTO tag_assignment_definitions(tag,version,definition_json,updated_at) SELECT 'third',version,definition_json,updated_at FROM tag_assignment_definitions WHERE tag='focus'").unwrap();
        let r = f.start(100, 30);
        let mut a = Fixture::read_args(&r, 1, "joint");
        a["additionalTags"] = json!([{"tag":"second","definitionVersion":1}]);
        let read = step(&f.root, &a).unwrap();
        let resumed = f.read(&read["run"], 2, "resume");
        assert_eq!(
            resumed["result"]["evidence"]["additionalTagContexts"][0]["tag"],
            "second"
        );
        assert_eq!(resumed["run"]["jointCounts"]["pending"], 2);
        let mut change = Fixture::read_args(&resumed["run"], 1, "change");
        change["additionalTags"] = json!([{"tag":"third","definitionVersion":1}]);
        assert!(step(&f.root, &change).unwrap_err().contains("已固定"));
        let main = f.proposal(&read["result"]["evidence"], "Pause before acting.");
        let done = step(&f.root, &Fixture::record_args(&resumed["run"], &main)).unwrap();
        let pending = status(&f.root, &json!({"runId":r["runId"]})).unwrap();
        assert_eq!(pending["items"][0]["ordinal"], 1);
        assert_eq!(pending["items"][0]["jointItems"][0]["state"], "pending");
        assert!(step(&f.root,&json!({"action":"finish","runId":r["runId"],"expectedVersion":done["run"]["version"],"requestId":"finish"})).unwrap_err().contains("额外标签待判断"));
        f.c().execute_batch("INSERT INTO tag_assignment_exclusion_events(tag,entity_id,proposal_id,excluded,request_key,request_hash,created_at) VALUES ('second','craft:lib:doc:child','test',1,'changed','hash',1)").unwrap();
        let mut apply = json!({"action":"scan_preview_reopen","runId":r["runId"],"ordinal":1,"expectedVersion":done["run"]["version"]});
        let preview = reopen::ui(&f.root, &apply).unwrap();
        assert_eq!(preview["change"]["reason"], "额外标签上下文已变化");
        apply["action"] = json!("scan_apply_reopen");
        apply["requestId"] = json!("joint-reopen");
        apply["confirmationToken"] = preview["confirmationToken"].clone();
        let reopened = reopen::ui(&f.root, &apply).unwrap();
        assert_eq!(reopened["run"]["jointCounts"]["pending"], 1);
        assert_eq!(reopened["run"]["jointCounts"]["unvisited"], 2);
        assert_eq!(reopened["run"]["charsRead"], done["run"]["charsRead"]);
        f.c()
            .execute_batch("UPDATE tag_assignment_definitions SET version=2 WHERE tag='second'")
            .unwrap();
        assert_eq!(
            status(&f.root, &json!({"runId":r["runId"]})).unwrap()["run"]["stale"],
            true
        );
    }

    #[test]
    fn joint_read_rejects_invalid_selection_without_spending() {
        let f = Fixture::new();
        let r = f.start(100, 30);
        for tags in [
            json!([]),
            json!([{"tag":"missing","definitionVersion":1}]),
            json!([{"tag":"focus","definitionVersion":1}]),
            json!([{"tag":"other"}]),
            json!(vec![json!({"tag":"other","definitionVersion":1}); 5]),
        ] {
            let mut a = Fixture::read_args(&r, 1, "invalid");
            a["additionalTags"] = tags;
            assert!(step(&f.root, &a).is_err());
        }
        assert_eq!(
            report(&f.c(), r["runId"].as_str().unwrap()).unwrap()["charsRead"],
            0
        );
        assert_eq!(
            report(&f.c(), r["runId"].as_str().unwrap()).unwrap()["version"],
            1
        );
    }

    #[test]
    fn joint_read_replay_revalidates_secondary_definition_and_exclusion() {
        for mode in ["definition", "exclusion", "context"] {
            let f = Fixture::new();
            f.c().execute_batch("INSERT INTO tag_assignment_definitions(tag,version,definition_json,updated_at) SELECT 'second',version,definition_json,updated_at FROM tag_assignment_definitions WHERE tag='focus'").unwrap();
            let r = f.start(100, 30);
            let mut a = Fixture::read_args(&r, 1, "joint");
            a["additionalTags"] = json!([{"tag":"second","definitionVersion":1}]);
            step(&f.root, &a).unwrap();
            match mode {
                "definition" => f.c().execute_batch("UPDATE tag_assignment_definitions SET version=2 WHERE tag='second'").unwrap(),
                "exclusion" => f.c().execute_batch("INSERT INTO tag_assignment_exclusion_events(tag,entity_id,proposal_id,excluded,request_key,request_hash,created_at) VALUES ('second','craft:lib:doc:child','test',1,'test','hash',1)").unwrap(),
                _ => f.c().execute_batch("INSERT INTO craft_tags(space_id,document_id,page_id,tag,normalized_tag) VALUES ('lib','doc','child','second','second')").unwrap(),
            }
            let replay = step(&f.root, &a).unwrap();
            assert_eq!(replay["result"]["state"], "stale_evidence");
            assert!(replay["result"].get("evidence").is_none());
            assert_eq!(replay["run"]["charsRead"], 20);
        }
    }

    #[test]
    fn content_scan_exclusion_skip_does_not_read_body_or_spend_budget() {
        let f = Fixture::new();
        let r = f.start(100, 30);
        f.c().execute_batch("INSERT INTO tag_assignment_exclusion_events(tag,entity_id,proposal_id,excluded,request_key,request_hash,created_at) VALUES ('focus','craft:lib:doc:child','gone',1,'exclude','hash',1); DELETE FROM content_items WHERE page_id='child';").unwrap();
        let a = json!({"action":"skip_excluded","runId":r["runId"],"expectedVersion":r["version"],"requestId":"skip","ordinal":1});
        let skipped = step(&f.root, &a).unwrap();
        assert_eq!(skipped["result"]["state"], "excluded");
        assert_eq!(skipped["run"]["counts"]["excluded"], 1);
        assert_eq!(skipped["run"]["counts"]["recorded"], 0);
        assert_eq!(skipped["run"]["charsRead"], 0);
        assert_eq!(skipped["run"]["entitiesRead"], 0);
        assert!(skipped["result"].get("evidence").is_none());
        assert_eq!(step(&f.root, &a).unwrap()["replayed"], true);
        assert!(step(
            &f.root,
            &Fixture::read_args(&skipped["run"], 1, "read-skipped")
        )
        .is_err());
        let second = step(&f.root, &json!({"action":"skip_excluded","runId":r["runId"],"expectedVersion":skipped["run"]["version"],"requestId":"check-second","ordinal":2})).unwrap();
        assert_eq!(second["result"]["state"], "not_excluded");
        assert_eq!(second["run"]["counts"]["unread"], 2);
    }

    #[test]
    fn content_scan_exclusion_revocation_requires_explicit_versioned_restore() {
        let f = Fixture::new();
        let r = f.start(100, 30);
        let event = |excluded: bool| {
            f.c().execute("INSERT INTO tag_assignment_exclusion_events(tag,entity_id,proposal_id,excluded,request_key,request_hash,created_at) VALUES ('focus','craft:lib:doc:child','gone',?1,?2,'hash',1)",params![excluded, random_url_safe(10)]).unwrap();
        };
        event(true);
        let a = json!({"action":"skip_excluded","runId":r["runId"],"expectedVersion":r["version"],"requestId":"skip","ordinal":1});
        let skipped = step(&f.root, &a).unwrap();
        let mut p = json!({"action":"scan_preview_reopen","runId":r["runId"],"expectedVersion":skipped["run"]["version"],"ordinal":1});
        assert!(reopen::ui(&f.root, &p).unwrap_err().contains("排除仍生效"));
        event(false);
        assert_eq!(
            report(&f.c(), r["runId"].as_str().unwrap()).unwrap()["counts"]["excluded"],
            1
        );
        let preview = reopen::ui(&f.root, &p).unwrap();
        assert_eq!(preview["change"]["reason"], "排除已撤销，可恢复取证");
        p["action"] = json!("scan_apply_reopen");
        p["requestId"] = json!("restore");
        p["confirmationToken"] = preview["confirmationToken"].clone();
        event(true);
        assert!(reopen::ui(&f.root, &p).is_err());
        event(false);
        assert!(reopen::ui(&f.root, &p).unwrap_err().contains("预览已失效"));
        p["action"] = json!("scan_preview_reopen");
        p["confirmationToken"] = reopen::ui(&f.root, &p).unwrap()["confirmationToken"].clone();
        p["action"] = json!("scan_apply_reopen");
        let restored = reopen::ui(&f.root, &p).unwrap();
        assert_eq!(restored["run"]["counts"]["excluded"], 0);
        assert_eq!(restored["run"]["charsRead"], 0);
        assert_eq!(restored["run"]["maxChars"], 100);
        assert_eq!(reopen::ui(&f.root, &p).unwrap()["replayed"], true);
        assert_eq!(
            step(&f.root, &a).unwrap()["result"]["state"],
            "superseded_by_reopen"
        );
        assert_eq!(
            f.read(&restored["run"], 1, "restored-read")["run"]["entitiesRead"],
            1
        );
    }

    #[test]
    fn content_scan_manifest_enumerates_untagged_pages_in_confirmed_scope() {
        let f = Fixture::new();
        let r = f.start(100, 30);
        assert_eq!(r["totalEntities"], 3);
        let s = status(&f.root, &json!({"runId":r["runId"],"limit":1})).unwrap();
        assert_eq!(s["items"][0]["source"]["pageId"], "child");
        assert_eq!(s["nextAfterOrdinal"], 1);
        let page = status(
            &f.root,
            &json!({"runId":r["runId"],"afterOrdinal":1,"limit":1}),
        )
        .unwrap();
        assert_eq!(page["items"][0]["source"]["pageId"], "child2");
        let read = f.read(&r, 3, "parent");
        assert_eq!(read["result"]["state"], "already_tagged");
        assert_eq!(read["run"]["charsRead"], 0);
        let err = step(
            &f.root,
            &json!({"action":"finish","runId":r["runId"],"expectedVersion":read["run"]["version"],"requestId":"finish"}),
        );
        assert!(err.is_err());
        // Content added after start is not silently added to the frozen manifest.
        f.c().execute("INSERT INTO content_items(id,space_id,document_id,block_id,content_type,heading,body,ordinal,source_hash,page_id,page_title,provider) VALUES ('later','lib','doc','later','craft_subpage','Later','Added later',3,'hash','later','Later','craft')",[]).unwrap();
        assert_eq!(
            status(&f.root, &json!({"tag":"focus"})).unwrap()["run"]["totalEntities"],
            3
        );
    }

    #[test]
    fn content_scan_budget_is_cumulative_and_replays_do_not_charge_again() {
        let f = Fixture::new();
        let r = f.start(25, 1);
        let a = Fixture::read_args(&r, 1, "first");
        let one = step(&f.root, &a).unwrap();
        assert_eq!(one["run"]["charsRead"], 20);
        let replay = step(&f.root, &a).unwrap();
        assert_eq!(replay["replayed"], true);
        assert_eq!(replay["run"]["charsRead"], 20);
        let mut changed = a.clone();
        changed["maxChars"] = json!(1);
        assert!(step(&f.root, &changed).is_err());
        assert!(
            step(&f.root, &Fixture::read_args(&one["run"], 2, "new-entity"))
                .unwrap_err()
                .contains("预算")
        );
        let mut next = Fixture::read_args(&one["run"], 1, "more");
        next["startChar"] = json!(20);
        let two = step(&f.root, &next).unwrap();
        assert_eq!(
            two["result"]["evidence"]["content"]
                .as_str()
                .unwrap()
                .chars()
                .count(),
            5
        );
        assert_eq!(two["run"]["charsRead"], 25);
        assert_eq!(two["run"]["entitiesRead"], 1);
        assert!(step(&f.root, &Fixture::read_args(&two["run"], 1, "exhausted")).is_err());
    }

    #[test]
    fn content_scan_record_requires_saved_current_and_actually_read_evidence() {
        let f = Fixture::new();
        let r = f.start(100, 30);
        let one = f.read(&r, 1, "read");
        let p = f.proposal(&one["result"]["evidence"], "More context.");
        let a = Fixture::record_args(&one["run"], &p);
        assert!(step(&f.root, &a).unwrap_err().contains("实际返回"));
        let mut more = Fixture::read_args(&one["run"], 1, "more");
        more["startChar"] = json!(20);
        let read = step(&f.root, &more).unwrap();
        let a = Fixture::record_args(&read["run"], &p);
        let done = step(&f.root, &a).unwrap();
        assert_eq!(done["run"]["counts"]["recorded"], 1);
        assert_eq!(step(&f.root, &a).unwrap()["replayed"], true);
        assert_eq!(
            f.c()
                .query_row("SELECT COUNT(*) FROM hub_content_tags", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            f.c()
                .query_row("SELECT status FROM tag_assignment_proposals", [], |r| {
                    r.get::<_, String>(0)
                })
                .unwrap(),
            "pending"
        );
    }

    #[test]
    fn content_scan_content_changes_and_definition_changes_are_not_silent() {
        let f = Fixture::new();
        let r = f.start(100, 30);
        let read = f.read(&r, 1, "read");
        let p = f.proposal(&read["result"]["evidence"], "Pause before acting.");
        f.c()
            .execute(
                "UPDATE content_items SET body='Changed body' WHERE id='child'",
                [],
            )
            .unwrap();
        assert!(step(&f.root, &Fixture::record_args(&read["run"], &p))
            .unwrap_err()
            .contains("版本已变化"));
        f.define(1);
        assert_eq!(
            status(&f.root, &json!({"runId":r["runId"]})).unwrap()["run"]["stale"],
            true
        );
        assert!(step(&f.root, &Fixture::read_args(&read["run"], 2, "next"))
            .unwrap_err()
            .contains("定义"));
    }

    #[test]
    fn content_scan_missing_content_is_unresolved_not_analyzed_and_start_is_idempotent() {
        let f = Fixture::new();
        let r = f.start(100, 30);
        assert_eq!(f.start(100, 30)["runId"], r["runId"]);
        assert!(step(&f.root,&json!({"action":"start","tag":"focus","definitionVersion":1,"idempotencyKey":"start","maxChars":101,"maxEntities":30})).is_err());
        f.c()
            .execute("DELETE FROM content_items WHERE id='child'", [])
            .unwrap();
        let missing = f.read(&r, 1, "missing");
        assert_eq!(missing["run"]["counts"]["unavailable"], 1);
        assert_eq!(missing["run"]["counts"]["recorded"], 0);
        assert_eq!(missing["run"]["charsRead"], 0);
        assert!(step(&f.root, &Fixture::read_args(&r, 2, "old-version"))
            .unwrap_err()
            .contains("进度已变化"));
    }

    #[test]
    fn content_scan_read_only_status_and_disabled_scope_do_not_start_work() {
        let f = Fixture::new();
        assert_eq!(
            status(&f.root, &json!({"tag":"focus"})).unwrap()["run"],
            Value::Null
        );
        let r = f.start(100, 30);
        f.c()
            .execute("UPDATE libraries SET enabled=0 WHERE id='lib'", [])
            .unwrap();
        assert_eq!(
            status(&f.root, &json!({"runId":r["runId"]})).unwrap()["run"]["stale"],
            true
        );
        assert!(step(&f.root, &Fixture::read_args(&r, 1, "read")).is_err());
        assert!(tools()
            .iter()
            .all(|v| v["annotations"]["destructiveHint"] == false));
    }

    #[test]
    fn content_scan_empty_completion_and_migration_preserve_existing_assignments() {
        let f = Fixture::new();
        f.c().execute_batch("DROP TABLE tag_content_scan_reopen_history; DROP TABLE tag_content_scan_receipts; DROP TABLE tag_content_scan_items; DROP TABLE tag_content_scan_runs; UPDATE metadata SET value='51' WHERE key='schema_version';").unwrap();
        forget_initialized_database(&f.root.join("craft-search.sqlite3"));
        assert_eq!(
            f.c()
                .query_row(
                    "SELECT value FROM metadata WHERE key='schema_version'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            DATABASE_SCHEMA_VERSION.to_string()
        );
        assert!(
            tag_assignment::definition(&f.root, &json!({"tag":"focus"})).unwrap()["definition"]
                .is_object()
        );
        f.c().execute("DELETE FROM content_items", []).unwrap();
        let r = f.start(100, 30);
        assert_eq!(r["totalEntities"], 0);
        let a = json!({"action":"finish","runId":r["runId"],"expectedVersion":r["version"],"requestId":"finish"});
        let done = step(&f.root, &a).unwrap();
        assert_eq!(done["run"]["status"], "completed");
        assert_eq!(done["result"]["semanticAnalysisComplete"], false);
        assert_eq!(step(&f.root, &a).unwrap()["replayed"], true);
    }

    #[test]
    fn content_scan_changed_evidence_is_not_returned_as_current_on_replay() {
        let f = Fixture::new();
        let r = f.start(100, 30);
        let a = Fixture::read_args(&r, 1, "read");
        let first = step(&f.root, &a).unwrap();
        f.c()
            .execute(
                "UPDATE content_items SET body='New content' WHERE id='child'",
                [],
            )
            .unwrap();
        let replay = step(&f.root, &a).unwrap();
        assert_eq!(replay["result"]["state"], "stale_evidence");
        assert!(replay["result"].get("evidence").is_none());
        assert_eq!(replay["run"]["charsRead"], first["run"]["charsRead"]);
    }

    #[test]
    fn content_scan_enumerates_obsidian_and_dida_without_requiring_tags() {
        let f = Fixture::new();
        f.c().execute_batch("INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES ('tasks','dida365','Tasks',1,1);
            INSERT INTO documents(space_id,id,title,path,markdown,indexed_at,content_hash,provider) VALUES ('tasks','t','Task','Task','Task text',1,'hash','dida365');
            INSERT INTO dida_tasks(library_id,task_id,project_id,title,content,description,raw_json,last_seen_at) VALUES ('tasks','t','p','Task','Pause before action','More context','{}',1);").unwrap();
        tag_assignment::ui(&f.root,&json!({"action":"save_definition","tag":"focus","expectedVersion":1,"definition":{"description":"Focus","include":"Pause","exclude":"","libraryIds":["excluded","tasks"]}})).unwrap();
        let r = step(
            &f.root,
            &json!({"action":"start","tag":"focus","definitionVersion":2,"idempotencyKey":"start"}),
        )
        .unwrap()["run"]
            .clone();
        assert_eq!(r["totalEntities"], 2);
        let first = f.read(&r, 1, "task");
        assert_eq!(first["result"]["evidence"]["provider"], "dida365");
        let second = f.read(&first["run"], 2, "note");
        assert_eq!(second["result"]["evidence"]["provider"], "obsidian");
        assert_eq!(second["run"]["entitiesRead"], 2);
    }

    fn preview_budget(f: &Fixture, r: &Value) -> Value {
        ui(&f.root,&json!({"action":"scan_preview_budget","runId":r["runId"],"expectedVersion":r["version"],"addEntities":2,"addChars":40})).unwrap()
    }
    fn apply_args(p: &Value) -> Value {
        json!({"action":"scan_apply_budget","runId":p["change"]["runId"],"expectedVersion":p["change"]["expectedVersion"],"addEntities":p["change"]["addEntities"],"addChars":p["change"]["addChars"],"confirmationToken":p["confirmationToken"],"requestId":"budget-test"})
    }

    #[test]
    fn content_scan_budget_confirmation_preserves_usage_and_is_idempotent() {
        let f = Fixture::new();
        let r = f.start(20, 1);
        let first = f.read(&r, 1, "first");
        let p = preview_budget(&f, &first["run"]);
        assert_eq!(
            status(&f.root, &json!({"tag":"focus"})).unwrap()["run"]["maxChars"],
            20
        );
        let a = apply_args(&p);
        let next = ui(&f.root, &a).unwrap();
        assert_eq!(next["run"]["maxChars"], 60);
        assert_eq!(next["run"]["maxEntities"], 3);
        assert_eq!(next["run"]["charsRead"], 20);
        assert_eq!(next["run"]["entitiesRead"], 1);
        assert_eq!(next["run"]["counts"]["read"], 1);
        assert_eq!(next["budgetHistory"].as_array().unwrap().len(), 1);
        assert_eq!(ui(&f.root, &a).unwrap()["replayed"], true);
        let mut altered = a.clone();
        altered["addChars"] = json!(50);
        assert!(ui(&f.root, &altered).is_err());
        assert_eq!(f.read(&next["run"], 2, "next")["run"]["entitiesRead"], 2);
        assert_eq!(
            f.c()
                .query_row("SELECT COUNT(*) FROM hub_content_tags", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn content_scan_budget_rejects_stale_or_tampered_confirmations() {
        let f = Fixture::new();
        let r = f.start(100, 30);
        let p = preview_budget(&f, &r);
        let mut a = apply_args(&p);
        a["confirmationToken"] = json!("wrong");
        assert!(ui(&f.root, &a).is_err());
        a = apply_args(&p);
        a["addChars"] = json!(41);
        assert!(ui(&f.root, &a).is_err());
        f.read(&r, 1, "concurrent-read");
        assert!(ui(&f.root, &apply_args(&p))
            .unwrap_err()
            .contains("进度已变化"));
        assert_eq!(
            f.c()
                .query_row(
                    "SELECT COUNT(*) FROM tag_content_scan_budget_history",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }

    #[test]
    fn content_scan_budget_is_ui_only_bounded_and_scope_checked() {
        let f = Fixture::new();
        let r = f.start(100, 30);
        let mut a = json!({"action":"scan_preview_budget","runId":r["runId"],"expectedVersion":r["version"],"addEntities":0,"addChars":0});
        assert!(ui(&f.root, &a).is_err());
        a["addChars"] = json!(-1);
        assert!(ui(&f.root, &a).is_err());
        a["addChars"] = json!(5_000_000);
        assert!(ui(&f.root, &a).is_err());
        a["addChars"] = json!(1.2);
        assert!(ui(&f.root, &a).is_err());
        let p = preview_budget(&f, &r);
        let b = apply_args(&p);
        assert!(step(&f.root, &b).is_err());
        assert!(hub_mcp_tools()["tools"]
            .as_array()
            .unwrap()
            .iter()
            .all(|t| !t["name"].as_str().unwrap().contains("budget")));
        f.define(1);
        assert!(ui(&f.root, &b).is_err());
    }

    #[test]
    fn content_scan_budget_migration_keeps_the_old_manifest() {
        let f = Fixture::new();
        let r = f.start(100, 30);
        let before = status(&f.root, &json!({"runId":r["runId"]})).unwrap();
        assert_eq!(before["items"].as_array().unwrap().len(), 3);
        // A v52 database has neither this table nor its later sequence markers.
        // Keep the production corruption check intact for inconsistent restores.
        f.c().execute_batch("DROP TABLE tag_content_scan_reopen_history; ALTER TABLE tag_content_scan_items DROP COLUMN reopened_version; DROP TABLE tag_content_scan_budget_history;
            DELETE FROM metadata WHERE key IN ('local_sequence_installed:tag_content_scan_budget_history','local_sequence:tag_content_scan_budget_history');
            UPDATE metadata SET value='52' WHERE key='schema_version';").unwrap();
        forget_initialized_database(&f.root.join("craft-search.sqlite3"));
        let recovered = ui(&f.root, &json!({"action":"scan_status","runId":r["runId"]})).unwrap();
        assert_eq!(
            status(&f.root, &json!({"runId":r["runId"]})).unwrap()["items"],
            before["items"]
        );
        assert_eq!(recovered["run"]["totalEntities"], 3);
        assert_eq!(recovered["run"]["maxChars"], 100);
        assert_eq!(recovered["budgetHistory"], json!([]));
        let p = preview_budget(&f, &recovered["run"]);
        f.c()
            .execute(
                "UPDATE tag_content_scan_runs SET status='completed' WHERE id=?1",
                [r["runId"].as_str().unwrap()],
            )
            .unwrap();
        assert!(ui(&f.root, &apply_args(&p)).is_err());
    }

    #[test]
    fn content_scan_new_round_requires_current_preview_and_replays_once() {
        let f = Fixture::new();
        let old = f.start(100, 30);
        let a =
            json!({"action":"scan_preview_new","tag":"focus","maxEntities":30,"maxChars":15000});
        let p = ui(&f.root, &a).unwrap();
        assert_eq!(p["plan"]["totalEntities"], 3);
        assert_eq!(p["plan"]["previousRunCount"], 1);
        let count = || {
            f.c()
                .query_row("SELECT COUNT(*) FROM tag_content_scan_runs", [], |r| {
                    r.get::<_, i64>(0)
                })
                .unwrap()
        };
        assert_eq!(count(), 1);
        let create = json!({"action":"scan_create_new","tag":"focus","maxEntities":30,"maxChars":15000,"definitionVersion":1,"confirmationToken":p["confirmationToken"],"requestId":"new-round-test"});
        let result = ui(&f.root, &create).unwrap();
        assert_ne!(result["run"]["runId"], old["runId"]);
        assert_eq!(result["run"]["charsRead"], 0);
        assert_eq!(
            ui(&f.root, &create).unwrap()["run"]["runId"],
            result["run"]["runId"]
        );
        assert_eq!(count(), 2);
        let mut altered = create.clone();
        altered["maxChars"] = json!(16000);
        assert!(ui(&f.root, &altered).is_err());
        altered = create.clone();
        altered["requestId"] = json!("another-request");
        assert!(ui(&f.root, &altered).is_err());
        assert!(step(&f.root, &create).is_err());
        assert_eq!(count(), 2);
    }

    #[test]
    fn content_scan_new_round_invalidates_on_progress_or_definition_change() {
        let f = Fixture::new();
        let old = f.start(100, 30);
        let preview = || ui(&f.root, &json!({"action":"scan_preview_new","tag":"focus"})).unwrap();
        let create = |p: Value| json!({"action":"scan_create_new","tag":"focus","maxEntities":30,"maxChars":15000,"definitionVersion":1,"confirmationToken":p["confirmationToken"],"requestId":"stale-round"});
        let p = preview();
        f.read(&old, 1, "changed-progress");
        assert!(ui(&f.root, &create(p)).is_err());
        let p = preview();
        f.define(1);
        assert!(ui(&f.root, &create(p)).is_err());
        for value in [0, -1, 5001] {
            assert!(ui(
                &f.root,
                &json!({"action":"scan_preview_new","tag":"focus","maxEntities":value})
            )
            .is_err());
        }
        assert_eq!(
            f.c()
                .query_row("SELECT COUNT(*) FROM tag_content_scan_runs", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn content_scan_cache_ranges_validate_unicode_gaps_overlaps_and_context() {
        let e = json!({"source":{"id":"page"},"sourceHash":"hash","sourceTags":["x"],"internalTags":[],"content":"甲😀乙\nabc"});
        let chars: Vec<char> = e["content"].as_str().unwrap().chars().collect();
        let part = |start: usize, end: usize| {
            let mut ev = e.clone();
            ev["content"] = json!(chars[start..end].iter().collect::<String>());
            ev["startChar"] = json!(start);
            ev["totalChars"] = json!(chars.len());
            ev["nextStartChar"] = if end == chars.len() {
                Value::Null
            } else {
                json!(end)
            };
            ev
        };
        let a = verified_cache_range(&e, &part(0, 3), &chars).unwrap();
        let b = verified_cache_range(&e, &part(2, 7), &chars).unwrap();
        assert!(complete_cache_coverage(vec![b, a, a], 7));
        for ranges in [vec![(0, 3), (4, 7)], vec![(1, 7)], vec![(0, 6)], vec![]] {
            assert!(!complete_cache_coverage(ranges, 7));
        }
        for (field, value) in [
            ("content", json!("甲X乙")),
            ("sourceHash", json!("old")),
            ("sourceTags", json!([])),
            ("internalTags", json!(["new"])),
            ("totalChars", json!(8)),
            ("startChar", json!(-1)),
            ("nextStartChar", json!(4)),
        ] {
            let mut ev = part(0, 3);
            ev[field] = value;
            assert!(verified_cache_range(&e, &ev, &chars).is_none(), "{field}");
        }
    }

    #[test]
    fn content_scan_reuses_long_segmented_evidence_but_never_a_gap() {
        for gap in [false, true] {
            let f = Fixture::new();
            let body = format!("Pause before acting.{}", "中文😀".repeat(2400));
            f.c()
                .execute("UPDATE content_items SET body=?1 WHERE id='child'", [body])
                .unwrap();
            let r = f.start(20000, 30);
            let mut a = Fixture::read_args(&r, 1, "first");
            a["maxChars"] = json!(6000);
            let first = step(&f.root, &a).unwrap();
            let mut a = Fixture::read_args(&first["run"], 1, "second");
            a["startChar"] = json!(if gap { 6001 } else { 5990 });
            a["maxChars"] = json!(6000);
            let second = step(&f.root, &a).unwrap();
            let p = f.proposal(&first["result"]["evidence"], "Pause before acting.");
            step(&f.root, &Fixture::record_args(&second["run"], &p)).unwrap();
            let next=step(&f.root,&json!({"action":"start","tag":"focus","definitionVersion":1,"idempotencyKey":"next"})).unwrap();
            let result=step(&f.root,&json!({"action":"reuse","runId":next["run"]["runId"],"ordinal":1,"expectedVersion":1,"requestId":"reuse"})).unwrap();
            assert_eq!(
                result["result"]["state"],
                if gap { "cache_miss" } else { "reused" }
            );
            assert_eq!(result["run"]["charsRead"], 0);
            if !gap {
                assert_eq!(result["result"]["verifiedReadReceiptCount"], 2);
                assert!(result["result"]["coveredChars"].as_u64().unwrap() > 6000);
            }
        }
    }

    #[test]
    fn content_scan_reuse_is_budget_free_idempotent_and_separate_from_new_analysis() {
        let f = Fixture::new();
        let r = f.start(100, 30);
        let mut read = Fixture::read_args(&r, 1, "full");
        read["maxChars"] = json!(100);
        let read = step(&f.root, &read).unwrap();
        let p = f.proposal(&read["result"]["evidence"], "Pause before acting.");
        step(&f.root, &Fixture::record_args(&read["run"], &p)).unwrap();
        let next = step(&f.root,&json!({"action":"start","tag":"focus","definitionVersion":1,"idempotencyKey":"next","maxChars":1,"maxEntities":1})).unwrap();
        let a = json!({"action":"reuse","runId":next["run"]["runId"],"expectedVersion":1,"ordinal":1,"requestId":"reuse"});
        let reused = step(&f.root, &a).unwrap();
        assert_eq!(reused["result"]["state"], "reused");
        assert_eq!(reused["result"]["proposalId"], p["proposalId"]);
        assert!(reused["result"].get("evidence").is_none());
        assert_eq!(reused["run"]["counts"]["reused"], 1);
        assert_eq!(reused["run"]["counts"]["recorded"], 0);
        assert_eq!(reused["run"]["decisionCounts"]["recommend_add"], 0);
        assert_eq!(reused["run"]["charsRead"], 0);
        assert_eq!(reused["run"]["entitiesRead"], 0);
        assert_eq!(step(&f.root, &a).unwrap()["replayed"], true);
        assert!(step(&f.root, &Fixture::read_args(&reused["run"], 1, "no-reread")).is_err());
        assert_eq!(
            f.c()
                .query_row("SELECT COUNT(*) FROM tag_assignment_proposals", [], |r| r
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
            1
        );
        assert_eq!(
            f.c()
                .query_row("SELECT COUNT(*) FROM hub_content_tags", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        f.c()
            .execute("UPDATE tag_assignment_proposals SET status='rejected'", [])
            .unwrap();
        assert_eq!(step(&f.root, &a).unwrap()["result"]["state"], "stale_reuse");
    }

    #[test]
    fn content_scan_reuse_rejects_partial_changed_or_reviewed_evidence() {
        for mode in [
            "partial",
            "body",
            "tags",
            "rejected",
            "withdrawn",
            "confidence",
            "insufficient",
            "definition",
            "other-page",
        ] {
            let f = Fixture::new();
            let r = f.start(100, 30);
            let mut read = Fixture::read_args(&r, 1, "full");
            if mode != "partial" {
                read["maxChars"] = json!(100);
            }
            let read = step(&f.root, &read).unwrap();
            let p = f.proposal(&read["result"]["evidence"], "Pause before acting.");
            step(&f.root, &Fixture::record_args(&read["run"], &p)).unwrap();
            match mode {
                "body" => {
                    f.c()
                        .execute(
                            "UPDATE content_items SET body=body || ' changed' WHERE id='child'",
                            [],
                        )
                        .unwrap();
                }
                "tags" => {
                    f.c().execute("INSERT INTO craft_tags(space_id,document_id,page_id,tag,normalized_tag) VALUES ('lib','doc','child','new','new')",[]).unwrap();
                }
                "rejected" | "withdrawn" => {
                    f.c()
                        .execute("UPDATE tag_assignment_proposals SET status=?1", [mode])
                        .unwrap();
                }
                "confidence" => {
                    f.c().execute("UPDATE tag_assignment_proposals SET proposal_json=json_set(proposal_json,'$.confidence',0.5)",[]).unwrap();
                }
                "insufficient" => {
                    f.c().execute("UPDATE tag_assignment_proposals SET proposal_json=json_set(proposal_json,'$.decision','insufficient_evidence')",[]).unwrap();
                }
                "definition" => f.define(1),
                _ => {}
            }
            let next = step(&f.root,&json!({"action":"start","tag":"focus","definitionVersion":if mode=="definition" {2}else{1},"idempotencyKey":"next"})).unwrap();
            let a = json!({"action":"reuse","runId":next["run"]["runId"],"expectedVersion":1,"ordinal":if mode=="other-page" {2}else{1},"requestId":"reuse"});
            let result = step(&f.root, &a).unwrap();
            assert_eq!(result["result"]["state"], "cache_miss", "{mode}");
            assert_eq!(result["run"]["charsRead"], 0);
            assert_eq!(result["run"]["counts"]["unread"], 3);
        }
    }

    #[test]
    fn content_scan_reopen_preserves_budget_audit_and_invalidates_old_receipts() {
        let f = Fixture::new();
        let r = f.start(100, 30);
        let old_args = Fixture::read_args(&r, 1, "old-read");
        let read = step(&f.root, &old_args).unwrap();
        let p = f.proposal(&read["result"]["evidence"], "Pause before acting.");
        let recorded = step(&f.root, &Fixture::record_args(&read["run"], &p)).unwrap();
        f.c()
            .execute("UPDATE tag_content_scan_runs SET status='completed'", [])
            .unwrap();
        f.c()
            .execute(
                "UPDATE content_items SET body=body||' changed' WHERE id='child'",
                [],
            )
            .unwrap();
        let a = json!({"action":"scan_preview_reopen","runId":r["runId"],"ordinal":1,"expectedVersion":recorded["run"]["version"]});
        let preview = ui(&f.root, &a).unwrap();
        assert_eq!(
            status(&f.root, &json!({"runId":r["runId"]})).unwrap()["run"]["counts"]["recorded"],
            1
        );
        let mut apply = a.clone();
        apply["action"] = json!("scan_apply_reopen");
        apply["requestId"] = json!("reopen");
        apply["confirmationToken"] = preview["confirmationToken"].clone();
        let result = ui(&f.root, &apply).unwrap();
        assert_eq!(result["run"]["status"], "active");
        assert_eq!(result["run"]["counts"]["recorded"], 0);
        assert_eq!(result["run"]["charsRead"], 20);
        assert_eq!(result["run"]["entitiesRead"], 1);
        assert_eq!(ui(&f.root, &apply).unwrap()["replayed"], true);
        assert_eq!(
            f.c()
                .query_row(
                    "SELECT COUNT(*) FROM tag_content_scan_reopen_history",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(
            f.c()
                .query_row("SELECT status FROM tag_assignment_proposals", [], |r| {
                    r.get::<_, String>(0)
                })
                .unwrap(),
            "pending"
        );
        assert_eq!(
            step(&f.root, &old_args).unwrap()["result"]["state"],
            "superseded_by_reopen"
        );
        let miss=step(&f.root,&json!({"action":"reuse","runId":r["runId"],"ordinal":1,"expectedVersion":result["run"]["version"],"requestId":"no-old-cache"})).unwrap();
        assert_eq!(miss["result"]["state"], "cache_miss");
        let fresh = f.read(&miss["run"], 1, "fresh");
        assert_eq!(fresh["run"]["entitiesRead"], 1);
        assert_eq!(fresh["run"]["charsRead"], 40);
        assert!(step(&f.root, &apply).is_err());
    }

    #[test]
    fn content_scan_reopen_rejects_unchanged_reviewed_or_stale_confirmation() {
        for mode in ["unchanged", "reviewed", "definition", "token"] {
            let f = Fixture::new();
            let r = f.start(100, 30);
            let read = f.read(&r, 1, "read");
            let p = f.proposal(&read["result"]["evidence"], "Pause before acting.");
            let done = step(&f.root, &Fixture::record_args(&read["run"], &p)).unwrap();
            let mut a = json!({"action":"scan_preview_reopen","runId":r["runId"],"ordinal":1,"expectedVersion":done["run"]["version"]});
            if mode != "unchanged" {
                f.c()
                    .execute(
                        "UPDATE content_items SET body=body||' change' WHERE id='child'",
                        [],
                    )
                    .unwrap();
            }
            match mode {
                "reviewed" => {
                    f.c()
                        .execute("UPDATE tag_assignment_proposals SET status='rejected'", [])
                        .unwrap();
                }
                "definition" => f.define(1),
                "token" => {
                    let p = ui(&f.root, &a).unwrap();
                    a["action"] = json!("scan_apply_reopen");
                    a["requestId"] = json!("changed");
                    a["confirmationToken"] = p["confirmationToken"].clone();
                    f.c()
                        .execute(
                            "UPDATE content_items SET body=body||' again' WHERE id='child'",
                            [],
                        )
                        .unwrap();
                }
                _ => {}
            }
            assert!(ui(&f.root, &a).is_err(), "{mode}");
            assert_eq!(
                f.c()
                    .query_row(
                        "SELECT COUNT(*) FROM tag_content_scan_reopen_history",
                        [],
                        |r| r.get::<_, i64>(0)
                    )
                    .unwrap(),
                0
            );
        }
    }

    #[test]
    fn content_scan_reopen_migrates_53_and_recovers_unavailable_item() {
        let f = Fixture::new();
        let r = f.start(100, 30);
        f.c().execute_batch("DROP TABLE tag_content_scan_reopen_history; ALTER TABLE tag_content_scan_items DROP COLUMN reopened_version; UPDATE metadata SET value='53' WHERE key='schema_version';").unwrap();
        forget_initialized_database(&f.root.join("craft-search.sqlite3"));
        let c = f.c();
        assert_eq!(
            c.query_row(
                "SELECT reopened_version FROM tag_content_scan_items LIMIT 1",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        c.execute(
            "UPDATE tag_content_scan_items SET state='unavailable' WHERE ordinal=1",
            [],
        )
        .unwrap();
        let mut a = json!({"action":"scan_preview_reopen","runId":r["runId"],"ordinal":1,"expectedVersion":1});
        let p = ui(&f.root, &a).unwrap();
        assert_eq!(p["change"]["reason"], "内容已恢复可用");
        a["action"] = json!("scan_apply_reopen");
        a["confirmationToken"] = p["confirmationToken"].clone();
        a["requestId"] = json!("restore");
        assert_eq!(ui(&f.root, &a).unwrap()["run"]["counts"]["unavailable"], 0);
    }

    #[test]
    fn content_scan_reused_context_baseline_handles_internal_tags_and_restoration() {
        let f = Fixture::new();
        let r = f.start(100, 30);
        let mut a = Fixture::read_args(&r, 1, "full");
        a["maxChars"] = json!(100);
        let read = step(&f.root, &a).unwrap();
        let p = f.proposal(&read["result"]["evidence"], "Pause before acting.");
        step(&f.root, &Fixture::record_args(&read["run"], &p)).unwrap();
        let next = step(
            &f.root,
            &json!({"action":"start","tag":"focus","definitionVersion":1,"idempotencyKey":"next"}),
        )
        .unwrap();
        let reused=step(&f.root,&json!({"action":"reuse","runId":next["run"]["runId"],"expectedVersion":1,"ordinal":1,"requestId":"reuse"})).unwrap();
        assert_eq!(reused["result"]["state"], "reused");
        let check = || {
            ui(
                &f.root,
                &json!({"action":"scan_check_items","runId":next["run"]["runId"]}),
            )
            .unwrap()["items"][0]["assessment"]["code"]
                .clone()
        };
        assert_eq!(check(), "evidence_unchanged");
        f.c().execute("INSERT INTO hub_content_tags(library_id,provider,document_id,page_id,tag,proposal_id) VALUES ('lib','craft','doc','child','context',?1)",[p["proposalId"].as_str().unwrap()]).unwrap();
        assert_eq!(check(), "context_changed");
        let preview=ui(&f.root,&json!({"action":"scan_preview_reopen","runId":next["run"]["runId"],"expectedVersion":reused["run"]["version"],"ordinal":1})).unwrap();
        assert_eq!(
            preview["change"]["previousContextHash"],
            reused["result"]["contextHash"]
        );
        f.c().execute("DELETE FROM hub_content_tags", []).unwrap();
        assert_eq!(check(), "evidence_unchanged");
        // A receipt with no actual baseline must not become an empty-tag baseline.
        f.c().execute("UPDATE tag_content_scan_receipts SET response_json=json_remove(response_json,'$.result.contextHash') WHERE run_id=?1",[next["run"]["runId"].as_str().unwrap()]).unwrap();
        assert_eq!(check(), "context_unknown");
    }

    #[test]
    fn content_scan_context_only_reopen_is_confirmed_and_fail_closed() {
        for mode in ["changed", "missing", "reviewed", "token", "old_generation"] {
            let f = Fixture::new();
            let r = f.start(100, 30);
            let read = f.read(&r, 1, "read");
            let p = f.proposal(&read["result"]["evidence"], "Pause before acting.");
            let done = step(&f.root, &Fixture::record_args(&read["run"], &p)).unwrap();
            f.c().execute("INSERT INTO craft_tags(space_id,document_id,page_id,tag,normalized_tag) VALUES ('lib','doc','child','new-context','new-context')", []).unwrap();
            match mode {
                "missing" => {
                    f.c()
                        .execute("DELETE FROM tag_content_scan_receipts", [])
                        .unwrap();
                }
                "old_generation" => {
                    f.c()
                        .execute(
                            "UPDATE tag_content_scan_items SET reopened_version=2 WHERE ordinal=1",
                            [],
                        )
                        .unwrap();
                }
                "reviewed" => {
                    f.c()
                        .execute("UPDATE tag_assignment_proposals SET status='rejected'", [])
                        .unwrap();
                }
                _ => {}
            }
            let before = status(&f.root, &json!({"runId":r["runId"]})).unwrap();
            let checked = ui(
                &f.root,
                &json!({"action":"scan_check_items","runId":r["runId"]}),
            )
            .unwrap();
            let code = if mode == "reviewed" {
                "reviewed"
            } else if matches!(mode, "missing" | "old_generation") {
                "context_unknown"
            } else {
                "context_changed"
            };
            assert_eq!(checked["items"][0]["assessment"]["code"], code, "{mode}");
            assert_eq!(
                before,
                status(&f.root, &json!({"runId":r["runId"]})).unwrap()
            );
            let mut a = json!({"action":"scan_preview_reopen","runId":r["runId"],"ordinal":1,"expectedVersion":done["run"]["version"]});
            if matches!(mode, "missing" | "reviewed" | "old_generation") {
                assert!(ui(&f.root, &a).is_err());
                continue;
            }
            let preview = ui(&f.root, &a).unwrap();
            assert_eq!(
                preview["change"]["reason"],
                "标签上下文已变化（正文证据未变）"
            );
            assert_eq!(
                preview["change"]["before"]["sourceHash"],
                preview["change"]["currentSourceHash"]
            );
            assert_ne!(
                preview["change"]["previousContextHash"],
                preview["change"]["contextHash"]
            );
            a["action"] = json!("scan_apply_reopen");
            a["requestId"] = json!("context-reopen");
            a["confirmationToken"] = preview["confirmationToken"].clone();
            if mode == "token" {
                f.c().execute("UPDATE craft_tags SET tag='another-context',normalized_tag='another-context' WHERE page_id='child'",[]).unwrap();
                assert!(ui(&f.root, &a).is_err());
            } else {
                let applied = ui(&f.root, &a).unwrap();
                assert_eq!(applied["run"]["charsRead"], done["run"]["charsRead"]);
                assert_eq!(applied["run"]["entitiesRead"], done["run"]["entitiesRead"]);
                assert_eq!(applied["run"]["counts"]["recorded"], 0);
                assert_eq!(
                    step(&f.root, &Fixture::read_args(&r, 1, "read")).unwrap()["result"]["state"],
                    "superseded_by_reopen"
                );
            }
        }
    }

    #[test]
    fn content_scan_batch_check_classifies_without_writing() {
        for (mode, code) in [
            ("unchanged", "evidence_unchanged"),
            ("changed", "evidence_changed"),
            ("reviewed", "reviewed"),
            ("missing", "source_unavailable"),
            ("definition", "run_stale"),
            ("tagged", "already_tagged"),
        ] {
            let f = Fixture::new();
            let r = f.start(100, 30);
            let read = f.read(&r, 1, "read");
            let p = f.proposal(&read["result"]["evidence"], "Pause before acting.");
            step(&f.root, &Fixture::record_args(&read["run"], &p)).unwrap();
            match mode {
                "changed" => {
                    f.c()
                        .execute(
                            "UPDATE content_items SET body=body||' changed' WHERE id='child'",
                            [],
                        )
                        .unwrap();
                }
                "reviewed" => {
                    f.c()
                        .execute("UPDATE tag_assignment_proposals SET status='rejected'", [])
                        .unwrap();
                }
                "missing" => {
                    f.c()
                        .execute("DELETE FROM content_items WHERE id='child'", [])
                        .unwrap();
                }
                "definition" => f.define(1),
                "tagged" => {
                    f.c().execute("INSERT INTO craft_tags(space_id,document_id,page_id,tag,normalized_tag) VALUES ('lib','doc','child','focus','focus')",[]).unwrap();
                }
                _ => {}
            }
            let before = status(&f.root, &json!({"runId":r["runId"],"filter":"all"})).unwrap();
            let checked = ui(
                &f.root,
                &json!({"action":"scan_check_items","runId":r["runId"]}),
            )
            .unwrap();
            assert_eq!(checked["items"][0]["assessment"]["code"], code, "{mode}");
            assert_eq!(
                checked["items"][0]["assessment"]["canReopen"],
                mode == "changed"
            );
            assert!(checked["items"][0].get("rawSource").is_none());
            assert_eq!(
                status(&f.root, &json!({"runId":r["runId"],"filter":"all"})).unwrap(),
                before
            );
            assert_eq!(
                f.c()
                    .query_row(
                        "SELECT COUNT(*) FROM tag_content_scan_reopen_history",
                        [],
                        |r| r.get::<_, i64>(0)
                    )
                    .unwrap(),
                0
            );
        }
    }

    #[test]
    fn content_scan_batch_check_pages_recovered_items_and_rejects_stale_cursors() {
        let f = Fixture::new();
        let r = f.start(100, 30);
        f.c()
            .execute("UPDATE tag_content_scan_items SET state='unavailable'", [])
            .unwrap();
        let a = json!({"action":"scan_check_items","runId":r["runId"],"limit":1});
        let p = ui(&f.root, &a).unwrap();
        assert_eq!(p["items"][0]["assessment"]["code"], "source_recovered");
        let mut a = a.clone();
        a["cursor"] = p["nextCursor"].clone();
        let second = ui(&f.root, &a).unwrap();
        assert_eq!(second["items"][0]["ordinal"], 2);
        a["cursor"] = second["nextCursor"].clone();
        let third = ui(&f.root, &a).unwrap();
        assert_eq!(third["items"][0]["assessment"]["code"], "already_tagged");
        assert!(third["nextCursor"].is_null());
        a["cursor"] = json!(json!(["other-run", 1, 1]).to_string());
        assert!(ui(&f.root, &a).is_err());
        a["cursor"] = p["nextCursor"].clone();
        f.c()
            .execute("UPDATE tag_content_scan_runs SET version=version+1", [])
            .unwrap();
        assert!(ui(&f.root, &a).is_err());
        assert!(ui(
            &f.root,
            &json!({"action":"scan_check_items","runId":r["runId"],"limit":21})
        )
        .is_err());
    }

    #[test]
    fn content_scan_reopen_history_is_scoped_paginated_and_read_only() {
        let f = Fixture::new();
        let r = f.start(100, 30);
        let id = r["runId"].as_str().unwrap();
        for n in 0..25 {
            let change = json!({"ordinal":1,"expectedVersion":n+1,"before":{"title":"Note","state":"recorded","proposalId":"old-p","sourceHash":"old","spans":"private audit field"},"reason":"正文证据版本已变化","charsRead":20,"maxChars":100,"entitiesRead":1,"maxEntities":30,"beforeRunStatus":"active","currentSourceHash":"new","proposal":{"status":"pending"},"actor":"hub-user"});
            f.c().execute("INSERT INTO tag_content_scan_reopen_history(run_id,request_id,request_hash,change_json,created_at) VALUES (?1,?2,'test',?3,100)",params![id,format!("key-{n:03}"),change.to_string()]).unwrap();
        }
        let before = status(&f.root, &json!({"runId":id})).unwrap();
        let mut ids = BTreeSet::new();
        let mut cursor = Value::Null;
        loop {
            let mut a = json!({"action":"scan_reopen_history","runId":id,"limit":7});
            if !cursor.is_null() {
                a["cursor"] = cursor.clone();
            }
            let p = ui(&f.root, &a).unwrap();
            for e in p["entries"].as_array().unwrap() {
                assert!(ids.insert(e["requestId"].as_str().unwrap().to_string()));
                assert_eq!(e["snapshot"]["previousProposalId"], "old-p");
                assert_eq!(e["snapshot"]["charsRead"], 20);
                assert!(e["snapshot"].get("spans").is_none());
            }
            cursor = p["nextCursor"].clone();
            if cursor.is_null() {
                break;
            }
        }
        assert_eq!(ids.len(), 25);
        assert_eq!(status(&f.root, &json!({"runId":id})).unwrap(), before);
        for cursor in [
            "invalid".to_string(),
            json!(["other-run", 100, "key-000"]).to_string(),
        ] {
            assert!(ui(
                &f.root,
                &json!({"action":"scan_reopen_history","runId":id,"cursor":cursor})
            )
            .is_err());
        }
        assert!(ui(
            &f.root,
            &json!({"action":"scan_reopen_history","runId":"missing"})
        )
        .is_err());
        assert!(ui(
            &f.root,
            &json!({"action":"scan_reopen_history","runId":id,"limit":51})
        )
        .is_err());
    }

    #[test]
    fn content_scan_budget_history_pages_without_writes_or_cross_run_cursors() {
        let f = Fixture::new();
        let r = f.start(100, 30);
        let id = r["runId"].as_str().unwrap();
        for n in 0..25 {
            f.c().execute("INSERT INTO tag_content_scan_budget_history(run_id,request_id,request_hash,change_json,created_at) VALUES (?1,?2,'test','{}',100)", params![id,format!("request-{n:03}")]).unwrap();
        }
        let before = ui(&f.root, &json!({"action":"scan_status","runId":id})).unwrap();
        let mut cursor = Value::Null;
        let mut ids = BTreeSet::new();
        loop {
            let mut a = json!({"action":"scan_budget_history","runId":id,"limit":7});
            if !cursor.is_null() {
                a["cursor"] = cursor.clone();
            }
            let p = ui(&f.root, &a).unwrap();
            for entry in p["entries"].as_array().unwrap() {
                assert!(ids.insert(entry["requestId"].as_str().unwrap().to_string()));
            }
            cursor = p["nextCursor"].clone();
            if cursor.is_null() {
                break;
            }
        }
        assert_eq!(ids.len(), 25);
        assert_eq!(
            ui(&f.root, &json!({"action":"scan_status","runId":id})).unwrap(),
            before
        );
        for cursor in [
            "invalid".to_string(),
            json!(["another-run", 100, "request-000"]).to_string(),
        ] {
            assert!(ui(
                &f.root,
                &json!({"action":"scan_budget_history","runId":id,"cursor":cursor})
            )
            .is_err());
        }
        assert!(ui(
            &f.root,
            &json!({"action":"scan_budget_history","runId":"missing"})
        )
        .is_err());
        assert!(ui(
            &f.root,
            &json!({"action":"scan_budget_history","runId":id,"limit":51})
        )
        .is_err());
    }

    #[test]
    fn content_scan_history_pages_stably_and_never_changes_runs() {
        let f = Fixture::new();
        for n in 0..5 {
            step(&f.root,&json!({"action":"start","tag":"focus","definitionVersion":1,"idempotencyKey":format!("history-{n}")})).unwrap();
        }
        f.c()
            .execute("UPDATE tag_content_scan_runs SET created_at=100", [])
            .unwrap();
        let mut cursor = Value::Null;
        let mut ids = BTreeSet::new();
        loop {
            let mut a = json!({"action":"scan_history","tag":"focus","limit":2});
            if !cursor.is_null() {
                a["cursor"] = cursor.clone();
            }
            let page = ui(&f.root, &a).unwrap();
            for r in page["runs"].as_array().unwrap() {
                assert!(ids.insert(r["runId"].as_str().unwrap().to_string()));
                assert_eq!(r["version"], 1);
            }
            cursor = page["nextCursor"].clone();
            if cursor.is_null() {
                break;
            }
        }
        assert_eq!(ids.len(), 5);
        assert_eq!(
            ui(&f.root, &json!({"action":"scan_history","tag":"other"})).unwrap()["runs"],
            json!([])
        );
        assert!(ui(
            &f.root,
            &json!({"action":"scan_history","tag":"focus","cursor":"invalid"})
        )
        .is_err());
        assert_eq!(
            f.c()
                .query_row(
                    "SELECT SUM(chars_read) FROM tag_content_scan_runs",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }
}
