//! Model suggestions are review records, never eligible memory revisions.
use super::*;

pub(crate) fn schema() -> Value {
    json!({"type":"object","properties":{
        "topicKey":{"type":"string","minLength":1,"maxLength":100},
        "title":{"type":"string","minLength":1,"maxLength":100},
        "kind":{"type":"string","enum":["rule","decision"]},
        "body":{"type":"string","minLength":1,"maxLength":1800},
        "reason":{"type":"string","minLength":1,"maxLength":300},
        "sourceRecordId":{"type":"string","minLength":1,"maxLength":180,"description":"选择当前对话中用户消息的 recordId；初始请求为 workId-goal，不能引用模型回答或其他事项。"}},
        "required":["topicKey","title","kind","body","reason","sourceRecordId"],"additionalProperties":false})
}

pub(crate) fn propose(
    root: &Path,
    work: &str,
    run: &str,
    request: &Value,
    provider: &str,
) -> Result<Value, String> {
    crate::model_runtime::validate_agent_tool(request, &schema())?;
    let _maintenance = crate::data_portability::maintenance_lock(root)?;
    let _permit = crate::library_runtime::cached_read_permit(root)?;
    let _guard = lock()
        .try_lock()
        .map_err(|_| "记忆正在更新，请稍后提出建议")?;
    write(root, |c| {
        let (project, revision, authorization): (String,i64,i64) = c.query_row(
            "SELECT s.project_id,w.revision,w.authorization_version FROM memory_work_scopes s JOIN agent_works w ON w.id=s.work_id WHERE w.id=?1 AND w.active_run=?2 AND w.state!='revoked' AND s.enabled=1",params![work,run],
            |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|_| "当前事项未启用记忆或运行已结束；建议未保存")?;
        let memory = format!(
            "hm-{}",
            &hash(format!("{project}\0{}", request["topicKey"].as_str().unwrap()).as_bytes())[..32]
        );
        let existing = load(c, &memory).ok();
        if existing
            .as_ref()
            .is_some_and(|v| matches!(v.state.as_str(), "forgotten" | "deleting"))
        {
            return Err("该主题已遗忘，请勿重新提议旧主题".into());
        }
        let version = existing.map_or(0, |v| v.version);
        let id = format!(
            "mp-{}",
            &hash(json!([work, run, request, version]).to_string().as_bytes())[..32]
        );
        let source = request["sourceRecordId"].as_str().unwrap();
        if source != format!("{work}-goal") {
            let owned:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_records WHERE work_id=?1 AND id=?2 AND kind IN ('userMessage','userDecision','steering'))",params![work,source],|r|r.get(0)).map_err(|e|e.to_string())?;
            if !owned {
                return Err("建议来源必须是当前事项的真实用户消息".into());
            }
        }
        let provenance = json!({"origin":"modelProposal","workId":work,"runId":run,"sourceRecordId":source,"workRevision":revision,"authorizationVersion":authorization,"proposedBy":provider,"proposedAt":chrono::Utc::now().timestamp_millis()});
        let count:i64=c.query_row("SELECT COUNT(*) FROM memory_proposals WHERE state='awaitingConfirmation' AND project_id=?1",[&project],|r|r.get(0)).map_err(|e|e.to_string())?;
        let replay: bool = c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM memory_proposals WHERE id=?1)",
                [&id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if count >= 50 && !replay {
            return Err("待确认建议已达50条，请先处理已有建议".into());
        }
        c.execute("INSERT OR IGNORE INTO memory_proposals(id,memory_id,project_id,expected_version,body_json,source_json,state,created_at) VALUES(?1,?2,?3,?4,?5,?6,'awaitingConfirmation',?7)",params![id,memory,project,version,request.to_string(),provenance.to_string(),chrono::Utc::now().timestamp_millis()]).map_err(|e|e.to_string())?;
        let state: String = c
            .query_row(
                "SELECT state FROM memory_proposals WHERE id=?1",
                [&id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(
            json!({"proposalId":id,"state":state,"eligibleForRecall":false,"notice":"仅保存待确认建议；请用户在共享记忆中检查、修改并确认，不能声称已记住。"}),
        )
    })
}

pub(super) fn list(c: &Connection, project: &str) -> Result<Vec<Value>, String> {
    pending(c, project, false)
}

pub(super) fn for_work(c: &Connection, work: &str) -> Result<Vec<Value>, String> {
    pending(c, work, true)
}

fn pending(c: &Connection, scope: &str, by_work: bool) -> Result<Vec<Value>, String> {
    let mut q=c.prepare("SELECT p.id,p.project_id,p.expected_version,p.body_json,p.source_json,m.name FROM memory_proposals p LEFT JOIN memory_projects m ON m.id=p.project_id WHERE p.state='awaitingConfirmation' AND CASE WHEN ?2 THEN json_extract(p.source_json,'$.workId')=?1 ELSE p.project_id=?1 END ORDER BY p.created_at DESC LIMIT 50").map_err(|e|e.to_string())?;
    let rows = q
        .query_map(params![scope, by_work], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, Option<String>>(5)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    rows.map(|r|{let(id,project,version,body,source,project_name)=r.map_err(|e|e.to_string())?;
        Ok(json!({"id":id,"projectId":project,"projectName":project_name,"expectedVersion":version,"candidate":serde_json::from_str::<Value>(&body).map_err(|_|"建议损坏")?,"source":serde_json::from_str::<Value>(&source).map_err(|_|"建议来源损坏")?}))}).collect()
}

pub(super) fn source(
    c: &Connection,
    args: &Value,
    memory: &str,
    expected: i64,
) -> Result<Value, String> {
    let mut source = if let Some(id) = args["proposalId"].as_str() {
        let (owner,version,state,raw):(String,i64,String,String)=c.query_row("SELECT memory_id,expected_version,state,source_json FROM memory_proposals WHERE id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(|_|"待确认建议不存在")?;
        if owner != memory || version != expected || state != "awaitingConfirmation" {
            return Err("建议或记忆版本已变化，请刷新后重新检查".into());
        }
        serde_json::from_str::<Value>(&raw).map_err(|_| "建议来源损坏")?
    } else {
        json!({"origin":"userEntry","workId":args["workId"]})
    };
    source["confirmedBy"] = json!("explicitUser");
    source["confirmedAt"] = json!(chrono::Utc::now().timestamp_millis());
    source["changeReason"] = json!(args["changeReason"].as_str().unwrap_or("用户确认保存"));
    if source["changeReason"].as_str().unwrap().len() > 900 {
        return Err("修改原因过长".into());
    }
    Ok(source)
}

pub(super) fn accept(
    c: &Connection,
    args: &Value,
    revision: &str,
    source: &Value,
) -> Result<(), String> {
    c.execute(
        "INSERT INTO memory_sources VALUES(?1,?2)",
        params![revision, source.to_string()],
    )
    .map_err(|e| e.to_string())?;
    if let Some(id) = args["proposalId"].as_str() {
        c.execute(
            "UPDATE memory_proposals SET state='accepted' WHERE id=?1",
            [id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}
