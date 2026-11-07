//! Optional, explicitly selected secondary tags share one budgeted evidence fragment.
//! This is not a joint manifest: secondary proposals retain their own review lifecycle.
use super::*;

pub(super) fn contexts(
    c: &Connection,
    r: &Value,
    a: &Value,
    e: &Value,
) -> Result<Option<Value>, String> {
    let saved = selection(c, r)?;
    let fallback = saved.as_array().map(|items| {
        json!(items
            .iter()
            .map(|v| json!({"tag":v["tag"],"definitionVersion":v["definitionVersion"]}))
            .collect::<Vec<_>>())
    });
    let Some(raw) = a.get("additionalTags").or(fallback.as_ref()) else {
        return Ok(None);
    };
    let selected = raw.as_array().ok_or("additionalTags 必须是数组")?;
    if selected.is_empty() || selected.len() > 4 {
        return Err("请明确选择 1–4 个额外标签，不自动扩大标签范围".into());
    }
    let mut seen = std::collections::HashSet::new();
    seen.insert(r["tag"].as_str().unwrap().to_string());
    let mut out = Vec::new();
    for entry in selected {
        let object = entry
            .as_object()
            .ok_or("额外标签必须提供 tag 和 definitionVersion")?;
        if object
            .keys()
            .any(|k| k != "tag" && k != "definitionVersion")
        {
            return Err("额外标签参数包含未知字段".into());
        }
        let tag = normalized_tag_argument(entry, "tag")?;
        if !seen.insert(tag.clone()) {
            return Err("额外标签不能重复，也不能包含主任务标签".into());
        }
        let version = entry["definitionVersion"]
            .as_i64()
            .filter(|v| *v > 0)
            .ok_or("额外标签缺少有效 definitionVersion")?;
        let definition =
            read_definition(c, &tag)?.ok_or_else(|| format!("请先在 Hub 确认标签定义：{tag}"))?;
        if definition["version"] != version {
            return Err(format!(
                "额外标签定义已变化：{tag}；请重新核对，不自动替换版本"
            ));
        }
        let libraries = definition["definition"]["libraryIds"]
            .as_array()
            .ok_or("额外标签范围无效")?;
        let exclusion = tag_assignment::exclusion_state(
            c,
            &tag,
            e["entityId"].as_str().ok_or("缺少实体定位")?,
        )?;
        let status = if !libraries.contains(&e["libraryId"]) {
            "out_of_scope"
        } else if exclusion["excluded"] == true {
            "excluded"
        } else if ["sourceTags", "internalTags"].iter().any(|key| {
            e[key].as_array().is_some_and(|tags| {
                tags.iter()
                    .any(|v| v.as_str().is_some_and(|s| s.to_lowercase() == tag))
            })
        }) {
            "already_tagged"
        } else {
            "eligible"
        };
        out.push(
            json!({"tag":tag,"definitionVersion":version,"definition":definition["definition"],
            "status":status,"exclusionPreference":exclusion,
            "rejectionHistory":tag_assignment::rejection_history(c, &tag, e, "")?}),
        );
    }
    let result = json!(out);
    if saved.is_array() && snapshot(&result) != saved {
        return Err("联合标签集合或定义已固定，不能在旧任务中变更，请恢复原选择或重新规划".into());
    }
    if result.to_string().chars().count() > 16_000 {
        return Err("额外标签上下文超过 16000 字符，请减少标签数量；不截断定义或审核历史".into());
    }
    Ok(Some(result))
}

pub(super) fn context_changed(
    c: &Connection,
    r: &Value,
    ordinal: u64,
    e: &Value,
) -> Result<bool, String> {
    let raw:Option<String>=c.query_row("SELECT json_extract(response_json,'$.result.evidence.additionalTagContexts') FROM tag_content_scan_receipts WHERE run_id=?1 AND json_extract(response_json,'$.result.ordinal')=?2 AND json_extract(response_json,'$.result.evidence.sourceHash')=?3 AND json_extract(response_json,'$.result.evidence.additionalTagContexts') IS NOT NULL AND json_extract(response_json,'$.run.version')>(SELECT reopened_version FROM tag_content_scan_items WHERE run_id=?1 AND ordinal=?2) ORDER BY json_extract(response_json,'$.run.version') DESC LIMIT 1",params![r["runId"].as_str(),ordinal,e["sourceHash"].as_str()],|row|row.get(0)).optional().map_err(|e|e.to_string())?;
    let Some(raw) = raw else { return Ok(false) };
    let before: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    Ok(contexts(c, r, &json!({}), e)?.is_some_and(|now| now != before))
}

fn snapshot(contexts: &Value) -> Value {
    json!(contexts.as_array().unwrap().iter().map(|v| json!({"tag":v["tag"],"definitionVersion":v["definitionVersion"],"definition":v["definition"]})).collect::<Vec<_>>())
}

pub(super) fn selection(c: &Connection, r: &Value) -> Result<Value, String> {
    let raw: Option<String> = c
        .query_row(
            "SELECT contexts_json FROM tag_content_scan_joint_selections WHERE run_id=?1",
            [r["runId"].as_str().unwrap()],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    raw.map(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
        .unwrap_or(Ok(Value::Null))
}

pub(super) fn stale(c: &Connection, r: &Value) -> Result<bool, String> {
    if let Some(tags) = selection(c, r)?.as_array() {
        for tag in tags {
            let current = read_definition(c, tag["tag"].as_str().unwrap())?;
            if current.as_ref().is_none_or(|v| {
                v["version"] != tag["definitionVersion"] || v["definition"] != tag["definition"]
            }) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

pub(super) fn remember(c: &Connection, r: &Value, ordinal: u64, e: &Value) -> Result<(), String> {
    let Some(contexts) = e.get("additionalTagContexts") else {
        return Ok(());
    };
    let id = r["runId"].as_str().unwrap();
    c.execute("INSERT INTO tag_content_scan_joint_selections(run_id,contexts_json) VALUES (?1,?2) ON CONFLICT(run_id) DO NOTHING", params![id,snapshot(contexts).to_string()]).map_err(|e|e.to_string())?;
    for tag in contexts.as_array().unwrap() {
        let state = if tag["status"] == "eligible" {
            "pending"
        } else {
            tag["status"].as_str().unwrap()
        };
        c.execute("INSERT INTO tag_content_scan_joint_items(run_id,ordinal,tag,state,source_hash) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(run_id,ordinal,tag) DO UPDATE SET state=CASE WHEN tag_content_scan_joint_items.source_hash=excluded.source_hash AND tag_content_scan_joint_items.state='recorded' AND excluded.state='pending' THEN 'recorded' ELSE excluded.state END, proposal_id=CASE WHEN tag_content_scan_joint_items.source_hash=excluded.source_hash AND tag_content_scan_joint_items.state='recorded' AND excluded.state='pending' THEN tag_content_scan_joint_items.proposal_id ELSE '' END, source_hash=excluded.source_hash",params![id,ordinal,tag["tag"].as_str(),state,e["sourceHash"].as_str()]).map_err(|e|e.to_string())?;
    }
    Ok(())
}

pub(super) fn progress(c: &Connection, r: &Value, ordinal: Option<i64>) -> Result<Value, String> {
    let mut st=c.prepare("SELECT ordinal,tag,state,proposal_id FROM tag_content_scan_joint_items WHERE run_id=?1 AND (?2 IS NULL OR ordinal=?2) ORDER BY ordinal,tag").map_err(|e|e.to_string())?;
    let items=st.query_map(params![r["runId"].as_str(),ordinal],|row|Ok(json!({"ordinal":row.get::<_,i64>(0)?,"tag":row.get::<_,String>(1)?,"state":row.get::<_,String>(2)?,"proposalId":row.get::<_,String>(3)?}))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    Ok(json!(items))
}

pub(super) fn record(c: &Connection, r: &Value, a: &Value) -> Result<Value, String> {
    let id = r["runId"].as_str().unwrap();
    let ordinal = number(a, "ordinal", 0, i64::MAX as u64)?;
    let tag = normalized_tag_argument(a, "tag")?;
    let pid = required(a, "proposalId")?;
    let (state,source_hash):(String,String)=c.query_row("SELECT state,source_hash FROM tag_content_scan_joint_items WHERE run_id=?1 AND ordinal=?2 AND tag=?3",params![id,ordinal,tag],|row|Ok((row.get(0)?,row.get(1)?))).map_err(|_|"此项未进行该标签的联合取证".to_string())?;
    if state != "pending" {
        return Err("仅待判断的额外标签可以记录".into());
    }
    let raw:String=c.query_row("SELECT proposal_json FROM tag_assignment_proposals WHERE id=?1 AND tag=?2 AND status='pending'",params![pid,tag],|row|row.get(0)).map_err(|_|"必须先提交此标签的待审核建议".to_string())?;
    let p: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let raw: String = c
        .query_row(
            "SELECT source_json FROM tag_content_scan_items WHERE run_id=?1 AND ordinal=?2",
            params![id, ordinal],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let source: Locator = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let e = entity(c, &source)?;
    let contexts = contexts(c, r, &json!({}), &e)?.ok_or("联合选择不存在")?;
    let context = contexts
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["tag"] == tag)
        .ok_or("标签不在固定选择中")?;
    if context["status"] != "eligible"
        || p["source"] != e["source"]
        || p["sourceHash"] != source_hash
        || e["sourceHash"] != source_hash
        || p["definitionVersion"] != context["definitionVersion"]
    {
        return Err("建议来源、版本或适用条件已变化，请重新核对".into());
    }
    let mut st=c.prepare("SELECT response_json FROM tag_content_scan_receipts WHERE run_id=?1 AND json_extract(response_json,'$.result.ordinal')=?2 AND json_extract(response_json,'$.result.state')='read' AND json_extract(response_json,'$.run.version')>(SELECT reopened_version FROM tag_content_scan_items WHERE run_id=?1 AND ordinal=?2) ORDER BY json_extract(response_json,'$.run.version') DESC LIMIT 256").map_err(|e|e.to_string())?;
    let receipts = st
        .query_map(params![id, ordinal], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let quote = p["quote"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("建议缺少原文")?;
    let mut verified = false;
    for raw in receipts {
        let receipt: Value =
            serde_json::from_str(&raw.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let ev = &receipt["result"]["evidence"];
        if ev["sourceHash"] == e["sourceHash"]
            && ev["source"] == e["source"]
            && ev["sourceTags"] == e["sourceTags"]
            && ev["internalTags"] == e["internalTags"]
            && ev["content"].as_str().is_some_and(|s| s.contains(quote))
            && ev["additionalTagContexts"]
                .as_array()
                .is_some_and(|tags| tags.contains(context))
        {
            verified = true;
            break;
        }
    }
    if !verified {
        return Err("缺少本轮实际返回且仍有效的联合证据，请定向补读".into());
    }
    c.execute("UPDATE tag_content_scan_joint_items SET state='recorded',proposal_id=?4 WHERE run_id=?1 AND ordinal=?2 AND tag=?3",params![id,ordinal,tag,pid]).map_err(|e|e.to_string())?;
    Ok(
        json!({"ordinal":ordinal,"tag":tag,"state":"joint_recorded","proposalId":pid,"sourceTagsModified":false}),
    )
}
