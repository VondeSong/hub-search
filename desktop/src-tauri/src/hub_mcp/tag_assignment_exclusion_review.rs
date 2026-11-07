//! Human review keeps exclusion intact. Due dates are not expiry dates.
use super::*;

fn preview(c: &Connection, a: &Value) -> Result<Value, String> {
    if a.get("proposalId").is_some() || a.get("excluded").is_some() {
        return Err("复核仅按当前排除事件定位，不修改 excluded".into());
    }
    let id = a["exclusionEventId"]
        .as_i64()
        .filter(|v| *v > 0)
        .ok_or("排除事件无效")?;
    let (tag, entity): (String, String) = c
        .query_row(
            "SELECT tag,entity_id FROM tag_assignment_exclusion_events WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| "排除事件不存在")?;
    let before = state(c, &tag, &entity)?;
    if before["excluded"] != true || before["version"] != id {
        return Err("排除已撤销或被新事件替代，请刷新".into());
    }
    let now = now_timestamp();
    let next = match a.get("nextReviewAt") {
        Some(v) => v.as_i64().ok_or("下次复核日期无效")?,
        None => {
            let days = a
                .get("reviewAfterDays")
                .map(|v| {
                    v.as_i64()
                        .filter(|n| (1..=3650).contains(n))
                        .ok_or("复核间隔必须为1–3650天")
                })
                .transpose()?
                .unwrap_or(90);
            now + days * 86400
        }
    };
    if next <= now || next > now + 3650 * 86400 {
        return Err("下次复核日期须在未来3650天内".into());
    }
    let version:i64=c.query_row("SELECT COALESCE(MAX(id),0) FROM tag_assignment_exclusion_reviews WHERE exclusion_event_id=?1",[id],|r|r.get(0)).map_err(|e|e.to_string())?;
    let change = json!({"exclusionEventId":id,"tag":tag,"entityId":entity,"exclusionVersion":before["version"],"previousReviewVersion":version,"nextReviewAt":next,"decision":"keep_excluded","actor":"hub-user"});
    Ok(json!({"confirmationToken":digest(&change),"change":change}))
}
pub(super) fn ui(root: &Path, a: &Value) -> Result<Value, String> {
    if argument_text(a, "action") == "exclusion_review_due" {
        return due(root, a);
    }
    if argument_text(a, "action") == "exclusion_review_history" {
        return history(root, a);
    }
    let mut c = open_database(&hub_mcp_database(root)?)?;
    let tx = c
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    if argument_text(a, "action") == "preview_exclusion_review" {
        return preview(&tx, a);
    }
    let key = text_field(a, "requestId", 1, 240)?;
    let old: Option<String> = tx
        .query_row(
            "SELECT request_hash FROM tag_assignment_exclusion_reviews WHERE request_key=?1",
            [&key],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(old) = old {
        if old != digest(a) {
            return Err("请求编号已用于不同复核参数".into());
        }
        return Ok(json!({"replayed":true,"sourceTagsModified":false}));
    }
    if a.get("nextReviewAt").is_none() {
        return Err("确认必须携带预览中的精确复核日期".into());
    }
    let p = preview(&tx, a)?;
    if p["confirmationToken"] != a["confirmationToken"] {
        return Err("复核预览已失效，请重新预览".into());
    }
    let ch = &p["change"];
    tx.execute("INSERT INTO tag_assignment_exclusion_reviews(exclusion_event_id,reviewed_at,next_review_at,change_json,request_key,request_hash) VALUES (?1,?2,?3,?4,?5,?6)",params![ch["exclusionEventId"].as_i64(),now_timestamp(),ch["nextReviewAt"].as_i64(),ch.to_string(),key,digest(a)]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(json!({"sourceTagsModified":false,"exclusionChanged":false,"decision":"keep_excluded"}))
}

fn due(root: &Path, a: &Value) -> Result<Value, String> {
    let c = open_database(&hub_mcp_database(root)?)?;
    let tag = if argument_text(a, "tag").is_empty() {
        String::new()
    } else {
        normalized_tag_argument(a, "tag")?
    };
    let days = a
        .get("olderThanDays")
        .map(|v| {
            v.as_i64()
                .filter(|n| (1..=3650).contains(n))
                .ok_or("olderThanDays 必须为1–3650天")
        })
        .transpose()?
        .unwrap_or(90);
    let now = now_timestamp();
    // Stop after 1001 matching events; no proposal JSON or note bodies are read.
    let count:i64=c.query_row("SELECT COUNT(*) FROM (SELECT e.id FROM tag_assignment_exclusion_events e LEFT JOIN tag_assignment_exclusion_reviews rv ON rv.id=(SELECT MAX(v.id) FROM tag_assignment_exclusion_reviews v WHERE v.exclusion_event_id=e.id) WHERE (?1='' OR e.tag=?1) AND e.excluded=1 AND e.id=(SELECT MAX(x.id) FROM tag_assignment_exclusion_events x WHERE x.tag=e.tag AND x.entity_id=e.entity_id) AND ((rv.id IS NOT NULL AND rv.next_review_at<=?2) OR (rv.id IS NULL AND e.created_at>0 AND e.created_at<=?3)) LIMIT 1001)",params![tag,now,now-days*86400],|r|r.get(0)).map_err(|e|e.to_string())?;
    Ok(
        json!({"count":count.min(1000),"hasMore":count>1000,"asOf":now,"olderThanDays":days,"sourceTagsModified":false}),
    )
}

fn history(root: &Path, a: &Value) -> Result<Value, String> {
    let mut c = open_database(&hub_mcp_database(root)?)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let event = a["exclusionEventId"]
        .as_i64()
        .filter(|v| *v > 0)
        .ok_or("排除事件无效")?;
    let (tag, entity): (String, String) = tx
        .query_row(
            "SELECT tag,entity_id FROM tag_assignment_exclusion_events WHERE id=?1",
            [event],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| "排除事件不存在")?;
    let limit = a
        .get("limit")
        .map(|v| {
            v.as_i64()
                .filter(|n| (1..=50).contains(n))
                .ok_or("limit 必须为1–50")
        })
        .transpose()?
        .unwrap_or(20);
    let max:i64=tx.query_row("SELECT COALESCE(MAX(id),0) FROM tag_assignment_exclusion_reviews WHERE exclusion_event_id=?1",[event],|r|r.get(0)).map_err(|e|e.to_string())?;
    let (watermark, before) = if argument_text(a, "cursor").is_empty() {
        (max, i64::MAX)
    } else {
        let (owner, watermark, before): (i64, i64, i64) =
            serde_json::from_str(argument_text(a, "cursor"))
                .map_err(|_| "复核历史游标无效，请刷新")?;
        if owner != event || watermark < 0 || watermark > max || before <= 0 || before > watermark {
            return Err("游标不属于当前排除事件，请刷新".into());
        }
        (watermark, before)
    };
    let mut st=tx.prepare("SELECT id,reviewed_at,next_review_at FROM tag_assignment_exclusion_reviews WHERE exclusion_event_id=?1 AND id<=?2 AND id<?3 ORDER BY id DESC LIMIT ?4").map_err(|e|e.to_string())?;
    let mut items=st.query_map(params![event,watermark,before,limit+1],|r|Ok(json!({"id":r.get::<_,i64>(0)?,"reviewedAt":r.get::<_,i64>(1)?,"nextReviewAt":r.get::<_,i64>(2)?,"decision":"keep_excluded","actor":"hub-user"}))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    let more = items.len() > limit as usize;
    items.truncate(limit as usize);
    let cursor = if more {
        json!(json!([event, watermark, items.last().unwrap()["id"]]).to_string())
    } else {
        Value::Null
    };
    Ok(
        json!({"exclusionEventId":event,"tag":tag,"entityId":entity,"items":items,"nextCursor":cursor,"snapshotVersion":watermark,"sourceTagsModified":false}),
    )
}
