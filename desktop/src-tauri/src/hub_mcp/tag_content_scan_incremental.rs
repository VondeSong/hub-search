//! Desktop-confirmed new locators only. Ancestor manifests remain immutable.
use super::*;

pub(super) fn baseline(
    c: &Connection,
    id: &str,
) -> Result<(Value, std::collections::HashSet<String>, String), String> {
    let base = run(c, id)?;
    if !blockers(c, &base)?.is_empty() {
        return Err("基准任务定义或范围过期，请重新规划".into());
    }
    if !union::enabled(&base)
        && joint::selection(c, &base)?
            .as_array()
            .is_some_and(|v| !v.is_empty())
    {
        return Err("旧单标签任务附加的联合取证不具备并集范围，请先建立合并范围任务".into());
    }
    let mut next = Some(id.to_string());
    let mut seen = std::collections::HashSet::new();
    let mut sources = std::collections::HashSet::new();
    let mut fingerprint = Vec::new();
    while let Some(id) = next {
        if seen.len() >= 100 || !seen.insert(id.clone()) {
            return Err("增量基准链过长或存在循环，请重新规划".into());
        }
        let r = run(c, &id)?;
        if r["definition"] != base["definition"]
            || r["manifestMode"] != base["manifestMode"]
            || joint::selection(c, &r)? != joint::selection(c, &base)?
        {
            return Err("增量基准链定义不一致".into());
        }
        let mut st = c
            .prepare(
                "SELECT source_json FROM tag_content_scan_items WHERE run_id=?1 ORDER BY ordinal",
            )
            .map_err(|e| e.to_string())?;
        let rows = st
            .query_map([&id], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        fingerprint.push(json!([id, r["version"], rows]));
        sources.extend(rows);
        if sources.len() > 100000 {
            return Err("增量基准累计超过100000个实体，请缩小范围重新规划".into());
        }
        next = c
            .query_row(
                "SELECT base_run_id FROM tag_content_scan_incremental WHERE run_id=?1",
                [&id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
    }
    Ok((base, sources, hash(&json!(fingerprint))))
}

pub(super) fn metadata(c: &Connection, id: &str) -> Result<Value, String> {
    c.query_row("SELECT base_run_id,baseline_hash FROM tag_content_scan_incremental WHERE run_id=?1",[id],|r|Ok(json!({"baseRunId":r.get::<_,String>(0)?,"baselineHash":r.get::<_,String>(1)?,"coverageClaim":"new_locators_only_not_changed_content"}))).optional().map(|v|v.unwrap_or(Value::Null)).map_err(|e|e.to_string())
}
