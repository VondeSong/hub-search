//! An explicit Run purpose, without changing the goal or granting a new action.
use super::*;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    expected_work_revision: i64,
    expected_authorization_version: i64,
    artifact_id: String,
    artifact_revision: u64,
    expected_content_hash: String,
}

pub(in crate::agent_work) fn budget(mut value: Budget) -> Budget {
    value.model_calls = value.model_calls.min(1);
    value.output_repair_calls = 0;
    value.seconds = value.seconds.min(120);
    value.model_call_seconds = value.model_call_seconds.min(90);
    value
}

pub(in crate::agent_work) fn prepare_on(
    root: &Path,
    c: &Connection,
    w: &Work,
    args: &Value,
) -> Result<Value, String> {
    let request: Request = serde_json::from_value(args.clone())
        .map_err(|_| "报告接续参数无效；新要求请通过普通消息提交")?;
    if w.state == "revoked"
        || request.expected_work_revision != w.revision
        || request.expected_authorization_version != w.authorization_version
    {
        return Err("报告接续的目标或授权已变化，请刷新后重试".into());
    }
    let charts = super::super::artifacts::manifest_on(root, c, w)?;
    if !charts.as_array().into_iter().flatten().any(|v| {
        v["artifactId"] == request.artifact_id
            && v["revision"] == request.artifact_revision
            && v["contentHash"] == request.expected_content_hash
            && v["state"] == "checked"
    }) {
        return Err("报告接续须绑定当前已核验的图表；来源、数据或版本已变化".into());
    }
    Ok(
        json!({"schemaVersion":1,"intent":"finishExistingReport","request":request,
        "goalBinding":super::goal::binding_on(c,w)?}),
    )
}

pub(in crate::agent_work) fn record_on(
    root: &Path,
    c: &Connection,
    w: &Work,
    run: &str,
    request: Option<&Value>,
) -> Result<(), String> {
    if let Some(request) = request {
        let body = prepare_on(root, c, w, request)?;
        insert(c, &w.id, Some(run), "reportContinuation", &body)?;
    }
    Ok(())
}

// The narrowed task changes execution scope, not the user's explicit skill selection.
pub(in crate::agent_work) fn skill_request<'a>(context: &'a Value, fallback: &'a str) -> &'a str {
    if context.get("reportContinuation").is_some() {
        return context["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .rev()
            .find(|message| message["role"] == "user")
            .and_then(|message| message["text"].as_str())
            .unwrap_or("");
    }
    context["currentRequest"].as_str().unwrap_or(fallback)
}

pub(in crate::agent_work) fn apply(context: &mut Value, body: Value) {
    let request = &body["request"];
    context["currentRequest"] = json!(format!(
        "本轮只补交尚未交付的报告，沿用当前目标和授权。核对固定方法及必要参考/模板、当前授权原文、当前数据、图表 {} 第 {} 版和已保存工作记录，然后通过 hub_finish 正式交付。原有要求仍在 messages 与 goalState 中，作为报告内容依据；其中已完成的修改不要重复执行。不再抽取、纠正、重算、创建快照、改写工作记录或发起业务动作。当前证据不满足时说明具体阻塞，不修改原文、不把历史出处当本轮取证。新增要求仍须经普通消息变更目标；所有旧失败与累计预算保留。",
        request["artifactId"].as_str().unwrap(), request["artifactRevision"]));
    context["reportContinuation"] = body;
}

pub(in crate::agent_work) fn context_on(
    root: &Path,
    c: &Connection,
    w: &Work,
    context: &mut Value,
) -> Result<(), String> {
    let Some(run) = &w.active_run else {
        return Ok(());
    };
    let raw: Option<String> = c.query_row("SELECT body_json FROM agent_records WHERE work_id=?1 AND run_id=?2 AND kind='reportContinuation' ORDER BY rowid DESC LIMIT 1", params![w.id,run], |r| r.get(0)).optional().map_err(|e|e.to_string())?;
    let Some(raw) = raw else {
        return Ok(());
    };
    let body: Value = serde_json::from_str(&raw).map_err(|_| "报告接续记录损坏")?;
    let checked = prepare_on(root, c, w, &body["request"])?;
    if checked != body {
        return Err("报告接续依据已变化，未沿用旧指令".into());
    }
    apply(context, body);
    Ok(())
}

pub(in crate::agent_work) fn allow_tool(
    context: &Value,
    tool: &runner::Tool,
) -> Result<(), String> {
    let Some(bound) = context.get("reportContinuation") else {
        return Ok(());
    };
    use runner::Tool;
    let allowed = match tool {
        Tool::Search { .. }
        | Tool::Read { .. }
        | Tool::LoadSkill { .. }
        | Tool::ReadSkillReference { .. }
        | Tool::TraceResult { .. }
        | Tool::ToolSchema { .. }
        | Tool::GoalState {} => true,
        Tool::Chart { request } => {
            matches!(request["action"].as_str(), Some("read" | "validate"))
                && request["artifactId"] == bound["request"]["artifactId"]
                && request["revision"] == bound["request"]["artifactRevision"]
        }
        Tool::SleepDataset { request }
        | Tool::WorkingState { request }
        | Tool::Task { request }
        | Tool::GoalRevision { request } => request["action"] == "read",
        Tool::Capability { name, .. } => matches!(
            name.as_str(),
            "hub_search_notes" | "hub_read_note" | "hub_read_analysis_snapshot"
        ),
        _ => false,
    };
    if allowed {
        Ok(())
    } else {
        Err("本轮仅补交已有成果的报告，不重复修改、重算、工作记录写入或业务动作；如需新要求请更新目标".into())
    }
}

#[cfg(test)]
mod tests;
