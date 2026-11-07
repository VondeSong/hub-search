//! User-confirmed, append-only preference events. Never exposed as MCP writes.
use super::*;
#[path = "tag_assignment_exclusion_review.rs"]
mod review;

pub(super) fn state(c: &Connection, tag: &str, entity: &str) -> Result<Value, String> {
    c.query_row("SELECT id,excluded,created_at,proposal_id FROM tag_assignment_exclusion_events WHERE tag=?1 AND entity_id=?2 ORDER BY id DESC LIMIT 1",params![tag,entity],|r|Ok(json!({"version":r.get::<_,i64>(0)?,"excluded":r.get::<_,bool>(1)?,"updatedAt":r.get::<_,i64>(2)?,"originProposalId":r.get::<_,String>(3)?}))).optional().map_err(|e|e.to_string()).map(|v|v.unwrap_or(json!({"version":0,"excluded":false})))
}

fn preview(c: &Connection, a: &Value) -> Result<Value, String> {
    if a.get("exclusionEventId").is_some() {
        if a["excluded"] != false || a.get("proposalId").is_some() {
            return Err("事件定位仅支持撤销，不接受来源建议参数或创建排除".into());
        }
        let id = a["exclusionEventId"]
            .as_i64()
            .filter(|id| *id > 0)
            .ok_or("排除事件编号无效")?;
        let (tag,entity,proposal,excluded):(String,String,String,bool)=c.query_row("SELECT tag,entity_id,proposal_id,excluded FROM tag_assignment_exclusion_events WHERE id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(|_|"排除事件不存在".to_string())?;
        let before = state(c, &tag, &entity)?;
        if !excluded || before["excluded"] != true || before["version"] != id {
            return Err("此事件已不是当前启用的排除，请刷新清单".into());
        }
        let change = json!({"proposalId":proposal,"exclusionEventId":id,"tag":tag,"entityId":entity,"title":"按排除事件定位的内容","before":before,"excluded":false,"scope":"same_tag_exact_entity_until_revoked","actor":"hub-user","reason":"用户按当前排除事件确认撤销，不依赖来源建议"});
        return Ok(json!({"change":change,"confirmationToken":digest(&change)}));
    }
    let p = get(c, &text_field(a, "proposalId", 1, 240)?)?;
    if p["status"] != "rejected" {
        return Err("请从已驳回建议管理排除，普通驳回不会自动排除".into());
    }
    let target = a["excluded"].as_bool().ok_or("excluded 必须为布尔值")?;
    let entity = p["proposal"]["entityId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("缺少精确实体定位")?;
    let tag = p["tag"].as_str().ok_or("标签缺失")?;
    let before = state(c, tag, entity)?;
    if before["excluded"] == target {
        return Err("偏好已是目标状态，请刷新查看".into());
    }
    let change = json!({"proposalId":p["proposalId"],"proposalVersion":p["version"],"tag":tag,"entityId":entity,"source":p["proposal"]["source"],"title":p["proposal"]["title"],"before":before,"excluded":target,"scope":"same_tag_exact_entity_until_revoked","actor":"hub-user"});
    Ok(json!({"change":change,"confirmationToken":digest(&change)}))
}

pub(super) fn ui(root: &Path, a: &Value) -> Result<Value, String> {
    if matches!(
        argument_text(a, "action"),
        "preview_exclusion_review"
            | "apply_exclusion_review"
            | "exclusion_review_history"
            | "exclusion_review_due"
    ) {
        return review::ui(root, a);
    }
    if argument_text(a, "action") == "list_exclusions" {
        return list(root, a);
    }
    let mut c = open_database(&hub_mcp_database(root)?)?;
    let tx = c
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    if argument_text(a, "action") == "preview_exclusion" {
        return preview(&tx, a);
    }
    let key = text_field(a, "requestId", 1, 240)?;
    let old: Option<String> = tx
        .query_row(
            "SELECT request_hash FROM tag_assignment_exclusion_events WHERE request_key=?1",
            [&key],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(old) = old {
        if old != digest(a) {
            return Err("请求编号已用于其他参数".into());
        }
        return Ok(json!({"replayed":true,"sourceTagsModified":false}));
    }
    let p = preview(&tx, a)?;
    if p["confirmationToken"] != a["confirmationToken"] {
        return Err("排除偏好预览已失效，请刷新重新确认".into());
    }
    let ch = &p["change"];
    tx.execute("INSERT INTO tag_assignment_exclusion_events(tag,entity_id,proposal_id,excluded,request_key,request_hash,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",params![ch["tag"].as_str(),ch["entityId"].as_str(),ch["proposalId"].as_str(),ch["excluded"].as_bool(),key,digest(a),now_timestamp()]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(json!({"sourceTagsModified":false,"internalTagsChanged":false}))
}

fn list(root: &Path, a: &Value) -> Result<Value, String> {
    let mut c = open_database(&hub_mcp_database(root)?)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let tag = if argument_text(a, "tag").is_empty() {
        String::new()
    } else {
        normalized_tag_argument(a, "tag")?
    };
    let mode = match argument_text(a, "mode") {
        "" | "active" => "active",
        "history" => "history",
        "review" => "review",
        _ => return Err("mode 必须为 active、history 或 review".into()),
    };
    let days = if mode == "review" {
        match a.get("olderThanDays") {
            None => 90,
            Some(v) => v
                .as_i64()
                .filter(|n| (1..=3650).contains(n))
                .ok_or("olderThanDays 必须为1–3650天")?,
        }
    } else {
        if a.get("olderThanDays").is_some() {
            return Err("天数筛选仅适用于 review 视图".into());
        }
        0
    };
    let mut as_of = now_timestamp();
    let mut review_watermark: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(id),0) FROM tag_assignment_exclusion_reviews",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let limit = match a.get("limit") {
        None => 20,
        Some(v) => v
            .as_i64()
            .filter(|n| (1..=50).contains(n))
            .ok_or("limit 必须为 1–50")?,
    };
    let (watermark, before) = if argument_text(a, "cursor").is_empty() {
        let max:i64=tx.query_row("SELECT COALESCE(MAX(id),0) FROM tag_assignment_exclusion_events WHERE (?1='' OR tag=?1)",[&tag],|r|r.get(0)).map_err(|e|e.to_string())?;
        (max, i64::MAX)
    } else {
        let (owner, kind, watermark, before) = if mode == "review" {
            let (owner, kind, watermark, before, cursor_days, time, reviews): (
                String,
                String,
                i64,
                i64,
                i64,
                i64,
                i64,
            ) = serde_json::from_str(argument_text(a, "cursor")).map_err(|_| "复核清单游标无效")?;
            if cursor_days != days
                || time <= 0
                || time > as_of
                || reviews < 0
                || reviews > review_watermark
            {
                return Err("复核天数或时点已变化，请刷新".into());
            }
            as_of = time;
            review_watermark = reviews;
            (owner, kind, watermark, before)
        } else {
            serde_json::from_str::<(String, String, i64, i64)>(argument_text(a, "cursor"))
                .map_err(|_| "排除清单游标无效")?
        };
        if owner != tag || kind != mode || watermark < 0 || before <= 0 || before > watermark {
            return Err("游标不属于当前标签/视图，请刷新".into());
        }
        (watermark, before)
    };
    let cutoff = as_of.saturating_sub(days * 86400);
    let mut st=tx.prepare("SELECT e.id,e.tag,e.entity_id,e.proposal_id,e.excluded,e.created_at,COALESCE(json_extract(p.proposal_json,'$.title'),''),COALESCE(p.status='rejected' AND p.tag=e.tag AND json_extract(p.proposal_json,'$.entityId')=e.entity_id,0),rv.reviewed_at,rv.next_review_at FROM tag_assignment_exclusion_events e LEFT JOIN tag_assignment_proposals p ON p.id=e.proposal_id LEFT JOIN tag_assignment_exclusion_reviews rv ON rv.id=(SELECT MAX(v.id) FROM tag_assignment_exclusion_reviews v WHERE v.exclusion_event_id=e.id AND v.id<=?7) WHERE (?1='' OR e.tag=?1) AND e.id<=?2 AND e.id<?3 AND (?4<>'review' OR (rv.id IS NOT NULL AND rv.next_review_at<=?8) OR (rv.id IS NULL AND e.created_at>0 AND e.created_at<=?6)) AND (?4='history' OR (e.excluded=1 AND e.id=(SELECT MAX(x.id) FROM tag_assignment_exclusion_events x WHERE x.tag=e.tag AND x.entity_id=e.entity_id AND x.id<=?2))) ORDER BY e.id DESC LIMIT ?5").map_err(|e|e.to_string())?;
    let mut items=st.query_map(params![tag,watermark,before,mode,limit+1,cutoff,review_watermark,as_of],|r|Ok(json!({"id":r.get::<_,i64>(0)?,"tag":r.get::<_,String>(1)?,"entityId":r.get::<_,String>(2)?,"proposalId":r.get::<_,String>(3)?,"excluded":r.get::<_,bool>(4)?,"createdAt":r.get::<_,i64>(5)?,"proposalTitle":r.get::<_,String>(6)?,"canManage":r.get::<_,bool>(7)?,"lastReviewedAt":r.get::<_,Option<i64>>(8)?,"nextReviewAt":r.get::<_,Option<i64>>(9)?}))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    let more = items.len() > limit as usize;
    items.truncate(limit as usize);
    let cursor = if more {
        json!(if mode == "review" {
            json!([
                tag,
                mode,
                watermark,
                items.last().unwrap()["id"],
                days,
                as_of,
                review_watermark
            ])
            .to_string()
        } else {
            json!([tag, mode, watermark, items.last().unwrap()["id"]]).to_string()
        })
    } else {
        Value::Null
    };
    Ok(
        json!({"items":items,"nextCursor":cursor,"snapshotVersion":watermark,"mode":mode,"olderThanDays":if mode=="review"{json!(days)}else{Value::Null},"asOf":as_of,"sourceTagsModified":false}),
    )
}
