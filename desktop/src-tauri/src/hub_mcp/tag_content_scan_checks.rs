//! Explicit desktop checks persist a bounded page, never reopen or analyze automatically.
use super::*;

fn latest(c: &Connection, id: &str) -> Result<Option<(i64, Value)>, String> {
    let raw:Option<(i64,String)>=c.query_row("SELECT id,response_json FROM tag_content_scan_checks WHERE run_id=?1 ORDER BY id DESC LIMIT 1",[id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e|e.to_string())?;
    raw.map(|(key, raw)| {
        serde_json::from_str(&raw)
            .map(|v| (key, v))
            .map_err(|e| e.to_string())
    })
    .transpose()
}
fn decorate(c: &Connection, id: &str, key: i64, mut page: Value) -> Result<Value, String> {
    let r = report(c, id)?;
    page["checkpointId"] = json!(key);
    page["historical"] = json!(true);
    page["checkpointSuperseded"] = json!(latest(c, id)?.is_some_and(|(latest, _)| latest != key));
    page["checkpointStale"] = json!(page["version"] != r["version"] || r["stale"] == true);
    if page["checkpointStale"] == true || page["checkpointSuperseded"] == true {
        page["nextCursor"] = Value::Null;
    }
    Ok(page)
}
pub(super) fn ui(root: &Path, a: &Value) -> Result<Value, String> {
    let id = required(a, "runId")?;
    let mut c = open_database(&hub_mcp_database(root)?)?;
    run(&c, &id)?;
    if argument_text(a, "action") == "scan_check_history" {
        return history(&mut c, &id, a);
    }
    if argument_text(a, "action") == "scan_check_saved" {
        return match latest(&c, &id)? {
            Some((key, page)) => decorate(&c, &id, key, page),
            None => Ok(json!({"items":[],"saved":false})),
        };
    }
    let key = required(a, "requestId")?;
    let request_hash = hash(a);
    let previous:Option<(i64,String,String)>=c.query_row("SELECT id,request_hash,response_json FROM tag_content_scan_checks WHERE run_id=?1 AND request_id=?2",params![id,key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|e|e.to_string())?;
    if let Some((seq, h, raw)) = previous {
        if h != request_hash {
            return Err("检查请求编号已用于其他参数".into());
        }
        let mut page = decorate(
            &c,
            &id,
            seq,
            serde_json::from_str(&raw).map_err(|e| e.to_string())?,
        )?;
        page["replayed"] = json!(true);
        return Ok(page);
    }
    let before = latest(&c, &id)?;
    if !argument_text(a, "cursor").is_empty() {
        let Some((seq, page)) = &before else {
            return Err("没有可继续的检查断点".into());
        };
        if a["checkpointId"] != json!(seq) || page["nextCursor"] != a["cursor"] {
            return Err("检查断点已变化，请恢复最新检查".into());
        }
    }
    let mut page = reopen::check_items(root, a)?;
    if !page["blockers"]
        .as_array()
        .ok_or("检查状态无效")?
        .is_empty()
    {
        return Err("定义或范围过期，不能继续检查".into());
    }
    let tx = c
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    if latest(&tx, &id)?.as_ref().map(|v| v.0) != before.as_ref().map(|v| v.0)
        || run(&tx, &id)?["version"] != page["version"]
        || !blockers(&tx, &run(&tx, &id)?)?.is_empty()
    {
        return Err("任务或检查断点已变化，请恢复最新状态".into());
    }
    page["saved"] = json!(true);
    tx.execute("INSERT INTO tag_content_scan_checks(run_id,request_id,request_hash,response_json) VALUES (?1,?2,?3,?4)",params![id,key,request_hash,page.to_string()]).map_err(|e|e.to_string())?;
    let seq = tx.last_insert_rowid();
    tx.commit().map_err(|e| e.to_string())?;
    decorate(&c, &id, seq, page)
}

fn history(c: &mut Connection, id: &str, a: &Value) -> Result<Value, String> {
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let r = report(&tx, id)?;
    let limit = number(a, "limit", 5, 10)?;
    if limit == 0 {
        return Err("limit 必须大于零".into());
    }
    let (snapshot, before) = if argument_text(a, "cursor").is_empty() {
        let max: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(id),0) FROM tag_content_scan_checks WHERE run_id=?1",
                [id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        (max, i64::MAX)
    } else {
        let (owner, snapshot, before): (String, i64, i64) =
            serde_json::from_str(argument_text(a, "cursor")).map_err(|_| "检查历史游标无效")?;
        if owner != id || snapshot < 0 || before <= 0 || before > snapshot {
            return Err("检查历史游标不属于此任务或范围无效".into());
        }
        (snapshot, before)
    };
    let mut st=tx.prepare("SELECT id,response_json FROM tag_content_scan_checks WHERE run_id=?1 AND id<=?2 AND id<?3 ORDER BY id DESC LIMIT ?4").map_err(|e|e.to_string())?;
    let rows = st
        .query_map(params![id, snapshot, before, limit + 1], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let more = rows.len() > limit as usize;
    let mut entries = Vec::new();
    for (seq, raw) in rows.into_iter().take(limit as usize) {
        let page: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        entries.push(json!({"checkpointId":seq,"checkedAt":page["checkedAt"],"version":page["version"],"items":page["items"],"reachedEndAtCheck":page["nextCursor"].is_null(),"stale":page["version"]!=r["version"] || r["stale"]==true}));
    }
    let cursor = if more {
        json!(json!([id, snapshot, entries.last().unwrap()["checkpointId"]]).to_string())
    } else {
        Value::Null
    };
    Ok(
        json!({"entries":entries,"nextCursor":cursor,"snapshotMaxId":snapshot,"historical":true,"sourceTagsModified":false,"coverageClaim":"historical_check_batches_not_current_evidence"}),
    )
}
