//! Read-only metadata difference against a frozen manifest, not semantic analysis.
use super::*;

pub(super) fn list(c: &Connection, id: &str, a: &Value) -> Result<Value, String> {
    if a.get("afterOrdinal").is_some() || a.get("filter").is_some() {
        return Err("新增内容检查使用 cursor，不使用进度 filter/afterOrdinal".into());
    }
    // One SQLite snapshot for definitions, old manifest and current locators.
    c.execute_batch("BEGIN DEFERRED")
        .map_err(|e| e.to_string())?;
    let result = list_snapshot(c, id, a);
    let rollback = c.execute_batch("ROLLBACK").map_err(|e| e.to_string());
    rollback?;
    result
}

fn list_snapshot(c: &Connection, id: &str, a: &Value) -> Result<Value, String> {
    let r = report(c, id)?;
    if r["stale"] == true {
        return Err("定义或资料库已变化，请重新规划；不能按旧范围推断新增内容".into());
    }
    let limit = number(a, "limit", 20, 50)?;
    if limit == 0 {
        return Err("limit 必须大于零".into());
    }
    let rows = enumerate_sources(c, &r["manifestScope"].to_string())?;
    let mut st = c
        .prepare("SELECT source_json FROM tag_content_scan_items WHERE run_id=?1 ORDER BY ordinal")
        .map_err(|e| e.to_string())?;
    let mut old = st
        .query_map([id], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let lineage_hash = if !r["incremental"].is_null() {
        let (_, ancestors, fingerprint) = incremental::baseline(c, id)?;
        old.extend(ancestors);
        old.sort();
        old.dedup();
        fingerprint
    } else {
        String::new()
    };
    let mut previous = std::collections::HashSet::new();
    for raw in &old {
        let locator: Locator = serde_json::from_str(raw).map_err(|e| e.to_string())?;
        previous.insert(serde_json::to_string(&locator).map_err(|e| e.to_string())?);
    }
    let mut current = std::collections::HashSet::new();
    let mut additions = Vec::new();
    let mut fingerprint_rows = Vec::new();
    for (source, title) in rows {
        let key = serde_json::to_string(&source).map_err(|e| e.to_string())?;
        fingerprint_rows.push(json!([key, title]));
        if !previous.contains(&key) {
            additions.push(json!({"entityId":locator_entity_id(&source),"source":source,
                "title":title.chars().take(200).collect::<String>(),"state":"not_in_manifest","analyzed":false}));
        }
        current.insert(key);
    }
    let snapshot = hash(&json!([
        id,
        lineage_hash,
        r["version"],
        r["definition"],
        r["jointSelection"],
        r["manifestScope"],
        old,
        fingerprint_rows
    ]));
    let offset = match a.get("cursor") {
        None | Some(Value::Null) => 0,
        Some(Value::String(raw)) if raw.len() <= 256 => {
            let (token, position) = raw.split_once(':').ok_or("无效增量游标")?;
            if token != snapshot {
                return Err("清单、定义或任务已变化，请从首批重新检查".into());
            }
            position.parse::<usize>().map_err(|_| "无效增量游标")?
        }
        _ => return Err("无效增量游标".into()),
    };
    if offset > additions.len() {
        return Err("增量游标超出范围".into());
    }
    let end = offset.saturating_add(limit as usize).min(additions.len());
    Ok(
        json!({"runId":id,"runVersion":r["version"],"manifestMode":r["manifestMode"],
        "manifestScope":r["manifestScope"],"snapshot":snapshot,"newEntityCount":additions.len(),
        "missingFromCurrentIndexCount":previous.difference(&current).count(),
        "currentEntityCount":current.len(),"items":&additions[offset..end],
        "nextCursor":if end<additions.len(){json!(format!("{snapshot}:{end}"))}else{Value::Null},
        "coverageClaim":"locator_difference_only","bodyRead":false,"sourceTagsModified":false,
        "limitations":["仅比较确认范围内的当前索引定位；缺失不代表来源删除",
            "未核对正文变化、适用性或是否漏标；新增不是补标建议",
            "不扩大任务、不增加预算、不启动分析；需用户预览确认新轮次",
            "最多枚举100000个定位；本次只读检查不保存调度或游标"]}),
    )
}
