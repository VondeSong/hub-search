//! Desktop-only, explicit confirmation for a single stale manifest item.
use super::*;

// Use only the latest read/reuse receipt in this item's current generation.
// Missing legacy evidence is unknown, never proof that context changed.
fn prior_context(
    c: &Connection,
    id: &str,
    ordinal: u64,
    source_hash: &Value,
) -> Result<Option<String>, String> {
    let raw: Option<String> = c.query_row(
        "SELECT json_object('state',json_extract(response_json,'$.result.state'),'sourceHash',COALESCE(json_extract(response_json,'$.result.evidence.sourceHash'),json_extract(response_json,'$.result.sourceHash')),'sourceTags',json_extract(response_json,'$.result.evidence.sourceTags'),'internalTags',json_extract(response_json,'$.result.evidence.internalTags'),'contextHash',json_extract(response_json,'$.result.contextHash')) FROM tag_content_scan_receipts WHERE run_id=?1 AND json_extract(response_json,'$.result.ordinal')=?2 AND json_extract(response_json,'$.result.state') IN ('read','reused') AND json_extract(response_json,'$.run.version')>(SELECT reopened_version FROM tag_content_scan_items WHERE run_id=?1 AND ordinal=?2) ORDER BY json_extract(response_json,'$.run.version') DESC LIMIT 1",
        params![id,ordinal], |row| row.get(0)).optional().map_err(|e|e.to_string())?;
    let Some(raw) = raw else { return Ok(None) };
    let v: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    if v["sourceHash"] != *source_hash {
        return Ok(None);
    }
    if v["state"] == "reused" {
        return Ok(v["contextHash"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_string));
    }
    if !["sourceTags", "internalTags"].iter().all(|k| {
        v[k].as_array()
            .is_some_and(|a| a.iter().all(Value::is_string))
    }) {
        return Ok(None);
    }
    Ok(Some(hash(&json!([v["sourceTags"], v["internalTags"]]))))
}

fn preview(c: &Connection, a: &Value) -> Result<Value, String> {
    let id = required(a, "runId")?;
    let r = report(c, &id)?;
    if r["version"] != a["expectedVersion"] {
        return Err("任务进度已变化，请刷新后重试".into());
    }
    if r["stale"] == true {
        return Err("定义或资料库范围已变化，请新建一轮，不能重开旧任务项".into());
    }
    let ordinal = number(a, "ordinal", 0, i64::MAX as u64)?;
    let before=c.query_row("SELECT source_json,title,state,source_hash,spans_json,proposal_id,decision,error,read_once,reopened_version FROM tag_content_scan_items WHERE run_id=?1 AND ordinal=?2",params![id,ordinal],|row| {
        Ok(json!({"source":row.get::<_,String>(0)?,"title":row.get::<_,String>(1)?,"state":row.get::<_,String>(2)?,"sourceHash":row.get::<_,String>(3)?,"spans":row.get::<_,String>(4)?,"proposalId":row.get::<_,String>(5)?,"decision":row.get::<_,String>(6)?,"error":row.get::<_,String>(7)?,"readOnce":row.get::<_,bool>(8)?,"reopenedVersion":row.get::<_,i64>(9)?}))
    }).map_err(|_|"清单项不存在".to_string())?;
    if !matches!(
        before["state"].as_str(),
        Some("recorded" | "reused" | "unavailable" | "excluded" | "joint_only")
    ) {
        return Err("仅已记录、已复用、已排除或此前不可用的项支持检查重开".into());
    }
    let source: Locator =
        serde_json::from_str(before["source"].as_str().unwrap()).map_err(|e| e.to_string())?;
    let preference = tag_assignment::exclusion_state(
        c,
        r["tag"].as_str().unwrap(),
        &locator_entity_id(&source),
    )?;
    if preference["excluded"] == true && !union::enabled(&r) {
        return Err("用户排除仍生效，请先撤销排除，再单独确认恢复取证".into());
    }
    let e = entity(c, &source)?;
    let tag = r["tag"].as_str().unwrap();
    if !union::enabled(&r)
        && ["sourceTags", "internalTags"].iter().any(|k| {
            e[k].as_array().is_some_and(|v| {
                v.iter()
                    .any(|t| t.as_str().is_some_and(|t| t.to_lowercase() == tag))
            })
        })
    {
        return Err("内容已带目标标签，不需要补标重开".into());
    }
    let proposal = if let Some(pid) = before["proposalId"].as_str().filter(|p| !p.is_empty()) {
        let (status, version): (String, i64) = c
            .query_row(
                "SELECT status,version FROM tag_assignment_proposals WHERE id=?1",
                [pid],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|_| "原建议不存在，不能安全重开".to_string())?;
        if status != "pending" {
            return Err("原建议已审核：保留原决定，本批不支持重开已批准、驳回或撤销的建议".into());
        }
        json!({"proposalId":pid,"status":status,"version":version})
    } else {
        Value::Null
    };
    if proposal.is_null()
        && before["state"] != "unavailable"
        && before["state"] != "excluded"
        && before["state"] != "joint_only"
    {
        return Err("原建议缺失，不能安全重开".into());
    }
    let previous_context = prior_context(c, &id, ordinal, &before["sourceHash"])?;
    let current_context = hash(&json!([e["sourceTags"], e["internalTags"]]));
    let reason = if before["state"] == "excluded" {
        "排除已撤销，可恢复取证"
    } else if before["state"] == "unavailable" {
        "内容已恢复可用"
    } else if before["sourceHash"] != e["sourceHash"] {
        "正文证据版本已变化"
    } else if union::changed(c, &r, ordinal, &e)? {
        "主标签适用状态已变化"
    } else if joint::context_changed(c, &r, ordinal, &e)? {
        "额外标签上下文已变化"
    } else {
        match previous_context.as_deref() {
            Some(old) if old != current_context => "标签上下文已变化（正文证据未变）",
            Some(_) => return Err("正文证据与标签上下文未变化，无需重开".into()),
            None => return Err("正文证据未变，但缺少有效历史标签上下文，不能据此重开".into()),
        }
    };
    let change = json!({"runId":id,"ordinal":ordinal,"expectedVersion":r["version"],"beforeRunStatus":r["status"],"before":before,"proposal":proposal,"currentSourceHash":e["sourceHash"],"contextHash":current_context,"previousContextHash":previous_context,"primaryTagStatus":if union::enabled(&r) {json!(union::primary_status(c,&r,&e)?)} else {Value::Null},"jointContexts":joint::contexts(c,&r,&json!({}),&e)?,"exclusionPreference":preference,"definition":r["definition"],"reason":reason,"entitiesRead":r["entitiesRead"],"charsRead":r["charsRead"],"maxEntities":r["maxEntities"],"maxChars":r["maxChars"],"actor":"hub-user"});
    Ok(json!({"change":change,"confirmationToken":hash(&change)}))
}

pub(super) fn ui(root: &Path, a: &Value) -> Result<Value, String> {
    if argument_text(a, "action") == "scan_check_items" {
        return check_items(root, a);
    }
    if argument_text(a, "action") == "scan_reopen_history" {
        return history(root, a);
    }
    let mut c = open_database(&hub_mcp_database(root)?)?;
    let tx = c
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let id = required(a, "runId")?;
    if argument_text(a, "action") == "scan_reopen_items" {
        let r = run(&tx, &id)?;
        let after = number(a, "afterOrdinal", 0, i64::MAX as u64)?;
        let mut st=tx.prepare("SELECT ordinal,title,state FROM tag_content_scan_items WHERE run_id=?1 AND ordinal>?2 AND state IN ('recorded','reused','unavailable','excluded','joint_only') ORDER BY ordinal LIMIT 21").map_err(|e|e.to_string())?;
        let mut items=st.query_map(params![id,after],|row|Ok(json!({"ordinal":row.get::<_,i64>(0)?,"title":row.get::<_,String>(1)?,"state":row.get::<_,String>(2)?}))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
        let more = items.len() > 20;
        items.truncate(20);
        return Ok(
            json!({"items":items,"version":r["version"],"nextAfterOrdinal":if more{items.last().unwrap()["ordinal"].clone()}else{Value::Null}}),
        );
    }
    if argument_text(a, "action") == "scan_preview_reopen" {
        return preview(&tx, a);
    }
    let key = required(a, "requestId")?;
    let prior:Option<String>=tx.query_row("SELECT request_hash FROM tag_content_scan_reopen_history WHERE run_id=?1 AND request_id=?2",params![id,key],|row|row.get(0)).optional().map_err(|e|e.to_string())?;
    if let Some(h) = prior {
        if h != hash(a) {
            return Err("重开请求编号已用于其他参数".into());
        }
        return Ok(json!({"run":report(&tx,&id)?,"replayed":true}));
    }
    let p = preview(&tx, a)?;
    if p["confirmationToken"] != a["confirmationToken"] {
        return Err("重开预览已失效，请刷新重新检查".into());
    }
    let change = &p["change"];
    let ordinal = change["ordinal"].as_u64().unwrap();
    let version = change["expectedVersion"].as_i64().unwrap() + 1;
    tx.execute(
        "DELETE FROM tag_content_scan_joint_items WHERE run_id=?1 AND ordinal=?2",
        params![id, ordinal],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO tag_content_scan_reopen_history(run_id,request_id,request_hash,change_json,created_at) VALUES (?1,?2,?3,?4,?5)",params![id,key,hash(a),change.to_string(),now_timestamp()]).map_err(|e|e.to_string())?;
    tx.execute("UPDATE tag_content_scan_items SET state='unread',source_hash='',spans_json='[]',proposal_id='',decision='',error='',reopened_version=?3 WHERE run_id=?1 AND ordinal=?2",params![id,ordinal,version]).map_err(|e|e.to_string())?;
    tx.execute(
        "UPDATE tag_content_scan_runs SET status='active',version=?2 WHERE id=?1",
        params![id, version],
    )
    .map_err(|e| e.to_string())?;
    let result =
        json!({"run":report(&tx,&id)?,"reopenedOrdinal":ordinal,"sourceTagsModified":false});
    tx.commit().map_err(|e| e.to_string())?;
    Ok(result)
}

fn assess(c: &Connection, r: &Value, item: &Value) -> Result<Value, String> {
    let result = |code: &str, reason: String, can_reopen: bool| json!({"code":code,"reason":reason,"canReopen":can_reopen});
    if r["stale"] == true {
        return Ok(result(
            "run_stale",
            "定义或资料库范围已变化，不能重开旧任务项".into(),
            false,
        ));
    }
    let source: Locator = match serde_json::from_str(item["rawSource"].as_str().unwrap_or_default())
    {
        Ok(v) => v,
        Err(_) => {
            return Ok(result(
                "invalid_source",
                "来源定位无法解析，需人工核对".into(),
                false,
            ))
        }
    };
    let preference = tag_assignment::exclusion_state(
        c,
        r["tag"].as_str().unwrap(),
        &locator_entity_id(&source),
    )?;
    if preference["excluded"] == true && !union::enabled(&r) {
        return Ok(result(
            "excluded",
            "用户排除仍生效，撤销后才可确认恢复".into(),
            false,
        ));
    }
    let e = match entity(c, &source) {
        Ok(e) => e,
        Err(reason) => return Ok(result("source_unavailable", reason, false)),
    };
    let tag = r["tag"].as_str().unwrap();
    if !union::enabled(&r)
        && ["sourceTags", "internalTags"].iter().any(|k| {
            e[k].as_array().is_some_and(|vs| {
                vs.iter()
                    .any(|v| v.as_str().is_some_and(|s| s.to_lowercase() == tag))
            })
        })
    {
        return Ok(result(
            "already_tagged",
            "当前已带目标标签，不需要补标重开".into(),
            false,
        ));
    }
    let pid = item["proposalId"].as_str().unwrap_or_default();
    if !pid.is_empty() {
        let state: Option<String> = c
            .query_row(
                "SELECT status FROM tag_assignment_proposals WHERE id=?1",
                [pid],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        match state.as_deref() {
            Some("pending") => {}
            Some(s) => {
                return Ok(result(
                    "reviewed",
                    format!("原建议已审核（{s}），保留原决定"),
                    false,
                ))
            }
            None => {
                return Ok(result(
                    "missing_proposal",
                    "原建议缺失，需人工核对".into(),
                    false,
                ))
            }
        }
    } else if item["state"] != "unavailable"
        && item["state"] != "excluded"
        && item["state"] != "joint_only"
    {
        return Ok(result(
            "missing_proposal",
            "没有可核对的原建议，不推断判断有效".into(),
            false,
        ));
    }
    if item["state"] == "excluded" {
        return Ok(result(
            "exclusion_revoked",
            "排除已撤销，可单独确认恢复取证".into(),
            true,
        ));
    }
    if item["state"] == "unavailable" {
        return Ok(result(
            "source_recovered",
            "此前不可用的内容已恢复，可单独预览重开".into(),
            true,
        ));
    }
    if item["sourceHash"] != e["sourceHash"] {
        return Ok(result(
            "evidence_changed",
            "正文证据版本已变化，可单独预览重开".into(),
            true,
        ));
    }
    if union::changed(c, r, item["ordinal"].as_u64().unwrap(), &e)?
        || joint::context_changed(c, r, item["ordinal"].as_u64().unwrap(), &e)?
    {
        return Ok(result(
            "joint_context_changed",
            "额外标签上下文已变化，可单独预览重开".into(),
            true,
        ));
    }
    let old = prior_context(
        c,
        r["runId"].as_str().unwrap(),
        item["ordinal"].as_u64().unwrap(),
        &item["sourceHash"],
    )?;
    Ok(match old {
        Some(old) if old != hash(&json!([e["sourceTags"], e["internalTags"]])) => result(
            "context_changed",
            "标签上下文已变化（正文证据未变），可单独预览重开".into(),
            true,
        ),
        Some(_) => result(
            "evidence_unchanged",
            "正文证据与最近取证时的标签上下文未变，不代表判断正确".into(),
            false,
        ),
        None => result(
            "context_unknown",
            "正文证据未变，但缺少有效历史标签上下文，无法核验".into(),
            false,
        ),
    })
}

pub(super) fn check_items(root: &Path, a: &Value) -> Result<Value, String> {
    let mut c = open_database(&hub_mcp_database(root)?)?;
    // A read transaction gives each page a consistent local snapshot without a write lock.
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let id = required(a, "runId")?;
    let r = report(&tx, &id)?;
    let limit = number(a, "limit", 10, 20)?.max(1);
    let after = if argument_text(a, "cursor").is_empty() {
        0
    } else {
        let (owner, version, ordinal): (String, i64, u64) =
            serde_json::from_str(argument_text(a, "cursor")).map_err(|_| "检查游标无效")?;
        if owner != id || Some(version) != r["version"].as_i64() {
            return Err("任务或进度已变化，请从头刷新检查，不混用旧结果".into());
        }
        if ordinal > i64::MAX as u64 {
            return Err("检查游标超出范围".into());
        }
        ordinal
    };
    let mut st=tx.prepare("SELECT ordinal,title,state,source_json,source_hash,proposal_id FROM tag_content_scan_items WHERE run_id=?1 AND ordinal>?2 AND state IN ('recorded','reused','unavailable','excluded','joint_only') ORDER BY ordinal LIMIT ?3").map_err(|e|e.to_string())?;
    let mut items=st.query_map(params![id,after,limit+1],|row|Ok(json!({"ordinal":row.get::<_,i64>(0)?,"title":row.get::<_,String>(1)?,"state":row.get::<_,String>(2)?,"rawSource":row.get::<_,String>(3)?,"sourceHash":row.get::<_,String>(4)?,"proposalId":row.get::<_,String>(5)?}))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    let more = items.len() > limit as usize;
    items.truncate(limit as usize);
    let checked_at = now_timestamp();
    for item in &mut items {
        let assessment = assess(&tx, &r, item)?;
        item["assessment"] = assessment;
        item["checkedAt"] = json!(checked_at);
        item.as_object_mut().unwrap().remove("rawSource");
        item.as_object_mut().unwrap().remove("sourceHash");
    }
    let cursor = if more {
        json!(json!([id, r["version"], items.last().unwrap()["ordinal"]]).to_string())
    } else {
        Value::Null
    };
    Ok(
        json!({"items":items,"version":r["version"],"checked":true,"nextCursor":cursor,"blockers":r["blockers"],"checkedAt":checked_at,"sourceTagsModified":false,"coverageClaim":"processed_items_version_check_not_semantic_analysis"}),
    )
}

fn history(root: &Path, a: &Value) -> Result<Value, String> {
    let c = open_database(&hub_mcp_database(root)?)?;
    let id = required(a, "runId")?;
    run(&c, &id)?;
    let limit = number(a, "limit", 20, 50)?.max(1);
    let (time, key) = if argument_text(a, "cursor").is_empty() {
        (i64::MAX, String::new())
    } else {
        let (owner, time, key): (String, i64, String) =
            serde_json::from_str(argument_text(a, "cursor")).map_err(|_| "重开历史游标无效")?;
        if owner != id {
            return Err("重开历史游标不属于当前任务".into());
        }
        (time, key)
    };
    let mut st=c.prepare("SELECT request_id,change_json,created_at FROM tag_content_scan_reopen_history WHERE run_id=?1 AND (created_at<?2 OR (created_at=?2 AND request_id<?3)) ORDER BY created_at DESC,request_id DESC LIMIT ?4").map_err(|e|e.to_string())?;
    let mut entries=st.query_map(params![id,time,key,limit+1],|row|{
        let raw:String=row.get(1)?;
        let p:Value=serde_json::from_str(&raw).unwrap_or(Value::Null);
        let snapshot=if p.is_object(){json!({"ordinal":p["ordinal"],"title":p["before"]["title"],"reason":p["reason"],"previousState":p["before"]["state"],"previousRunStatus":p["beforeRunStatus"],"expectedVersion":p["expectedVersion"],"previousProposalId":p["before"]["proposalId"],"proposalStatusAtReopen":p["proposal"]["status"],"actor":p["actor"],"entitiesRead":p["entitiesRead"],"charsRead":p["charsRead"],"maxEntities":p["maxEntities"],"maxChars":p["maxChars"],"previousSourceHash":p["before"]["sourceHash"],"currentSourceHashAtReopen":p["currentSourceHash"]})}else{Value::Null};
        Ok(json!({"requestId":row.get::<_,String>(0)?,"createdAt":row.get::<_,i64>(2)?,"snapshot":snapshot}))
    }).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    let more = entries.len() > limit as usize;
    entries.truncate(limit as usize);
    let next = if more {
        let last = entries.last().unwrap();
        json!(json!([id, last["createdAt"], last["requestId"]]).to_string())
    } else {
        Value::Null
    };
    Ok(json!({"entries":entries,"nextCursor":next,"sourceTagsModified":false}))
}
