//! User control owns dispatch eligibility, never business action outcomes.
use super::*;

#[cfg(test)]
mod tests;

pub(in crate::agent_work) fn held(state: &str) -> bool {
    matches!(state, "paused" | "cancelled")
}

fn revision(c: &Connection, id: &str) -> Result<i64, String> {
    c.query_row("SELECT (SELECT COUNT(*) FROM agent_runs WHERE work_id=?1)+(SELECT COUNT(*) FROM agent_records WHERE work_id=?1 AND kind='lifecycleCommand')", [id], |r| r.get(0)).map_err(|e|e.to_string())
}

pub(in crate::agent_work) fn view_on(c: &Connection, w: &Work) -> Result<Value, String> {
    let count: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM agent_runs WHERE work_id=?1",
            [&w.id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let trace_budget = super::trace_budget::view_on(c, w, count).unwrap_or_else(
        |error| json!({"state":"unavailable","reason":error,"canAdmitRun":false,"runLimit":null}),
    );
    let trace_available = trace_budget["canAdmitRun"] == true;
    let unresolved: i64 = c.query_row("SELECT COUNT(*) FROM agent_actions WHERE work_id=?1 AND state IN ('executing','unknown','reconciliation_required')", [&w.id], |r|r.get(0)).map_err(|e|e.to_string())?;
    let execution_budget = super::execution_budget::view_on(c, w).unwrap_or_else(|error| {
        json!({
        "state":"unavailable","reason":error,"rootWorkId":w.id,"providerTokensOrFeesBounded":false})
    });
    let provider_budget = super::provider_budget::view_on(c, w)
        .unwrap_or_else(|error| json!({"state":"unavailable","reason":error}));
    let provider_unavailable =
        provider_budget["state"] == "unavailable" || provider_budget["state"] == "exhausted";
    let execution_unavailable = provider_unavailable
        || execution_budget["state"] == "unavailable"
        || execution_budget["exhausted"] == true;
    let mode_available = |mode: &str| {
        unresolved == 0
            && trace_available
            && !execution_unavailable
            && w.state != "revoked"
            && execution_budget["canAdmitModes"][mode] == true
    };
    let execution_modes = json!({"quick":mode_available("quick"),"deep":mode_available("deep")});
    let last = records_on(c, &w.id, "lifecycleCommand", 1)?
        .into_iter()
        .next();
    let mut q = c
        .prepare("SELECT usage_json FROM agent_runs WHERE work_id=?1 ORDER BY rowid")
        .map_err(|e| e.to_string())?;
    let rows = q
        .query_map([&w.id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut usage = serde_json::Map::new();
    for row in rows {
        let value: Value = serde_json::from_str(&row.map_err(|e| e.to_string())?)
            .map_err(|_| "运行用量记录损坏")?;
        for (key, number) in value.as_object().into_iter().flatten() {
            if let Some(n) = number.as_u64() {
                let total = usage
                    .get(key)
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
                    .saturating_add(n);
                usage.insert(key.clone(), json!(total));
            }
        }
    }
    let mut unknown=c.prepare("SELECT u.id FROM agent_runs u WHERE u.work_id=?1 AND u.state<>'investigating' AND EXISTS(SELECT 1 FROM agent_records r WHERE r.run_id=u.id AND r.kind='nativeRuntime') AND NOT EXISTS(SELECT 1 FROM agent_records e WHERE e.run_id=u.id AND e.kind='modelExecution' AND json_type(e.body_json,'$.inputTokens')='integer') ORDER BY u.rowid").map_err(|e|e.to_string())?;
    let unmeasured = unknown
        .query_map([&w.id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(
        json!({"schemaVersion":1,"controlRevision":revision(c,&w.id)?,"workRevision":w.revision,
        "activeRunId":w.active_run,"state":w.state,"requiresExplicitResume":held(&w.state),
        "canResume":held(&w.state) && unresolved==0 && trace_available && !execution_unavailable,
        "recoveryMode":"newRunWithRevalidatedContext","runsUsed":count,"runLimit":trace_budget["runLimit"],"traceBudget":trace_budget,
        "executionModes":execution_modes,"providerBudget":provider_budget,"executionBudget":execution_budget,"recordedUsage":usage,"usageCompleteness":if unmeasured.is_empty(){"recorded"}else{"incomplete"},
        "unmeasuredRunIds":unmeasured,"recordedUsageIsLowerBound":!unmeasured.is_empty(),
        "unresolvedActions":unresolved,"lastCommand":last,
        "reason":if unresolved>0 {"业务动作结果待核验，请先核验后继续"} else if !trace_available {if trace_budget["state"]=="legacy" {"旧事项已达20次运行保护上限；成果和历史已保留，不能新建事项绕过预算"} else {"事项记录资源不可用，已停止新分析；成果和恢复信息保留"}} else if execution_unavailable {"事项执行额度不可用，已暂停新分析；旧成果与待核对结果仍可查看"} else if w.state=="cancelled" {"用户已取消目标；已发生的业务动作不会撤销"} else if w.state=="paused" {"本轮已停止；补充文字只保存，明确继续后才开始新一轮"} else {""}}),
    )
}

fn identity(args: &Value) -> Result<String, String> {
    super::super::text(args, "commandId", 100)
}

fn payload(args: &Value, kind: &str) -> Value {
    let mut body = json!({"kind":kind,"expectedControlRevision":args["expectedControlRevision"],
        "expectedWorkRevision":args["expectedWorkRevision"],"expectedRunId":args["expectedRunId"],"mode":args["mode"]});
    if args["resumeQueue"] == true {
        body["resumeQueue"] = json!(true);
        body["selectedMessageId"] = args["selectedMessageId"].clone();
    }
    if let Some(report) = args.get("reportContinuation") {
        body["reportContinuation"] = report.clone();
    }
    body
}

fn replay(c: &Connection, id: &str, command: &str, payload: &Value) -> Result<bool, String> {
    let raw: Option<String> = c.query_row("SELECT body_json FROM agent_records WHERE work_id=?1 AND kind='lifecycleCommand' AND json_extract(body_json,'$.commandId')=?2",params![id,command],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    if let Some(raw) = raw {
        let old: Value = serde_json::from_str(&raw).map_err(|_| "控制回执损坏")?;
        if old["payload"] != *payload {
            return Err("控制命令身份已用于不同内容".into());
        }
        return Ok(true);
    }
    Ok(false)
}

pub(in crate::agent_work) fn resume_replayed(
    root: &Path,
    id: &str,
    args: &Value,
) -> Result<bool, String> {
    replay(&read(root)?, id, &identity(args)?, &payload(args, "resume"))
}

fn check(c: &Connection, w: &Work, args: &Value) -> Result<(), String> {
    if w.state == "revoked" {
        return Err("来源授权已撤回，不能恢复".into());
    }
    if args["expectedControlRevision"].as_i64() != Some(revision(c, &w.id)?)
        || args["expectedWorkRevision"].as_i64() != Some(w.revision)
        || !args
            .get("expectedRunId")
            .is_some_and(|v| *v == json!(w.active_run))
    {
        return Err("控制状态已变化，请刷新后重试".into());
    }
    Ok(())
}

fn receipt(
    c: &Connection,
    w: &Work,
    command: &str,
    payload: &Value,
    run: Option<&str>,
) -> Result<(), String> {
    insert(
        c,
        &w.id,
        None,
        "lifecycleCommand",
        &json!({"schemaVersion":1,"commandId":command,"origin":"user",
        "payload":payload,"controlRevision":revision(c,&w.id)?+1,"runId":run,"state":"applied","committedAt":stamp()}),
    )
}

/// Returns whether a new command committed. A replay must not cancel a later run.
pub(in crate::agent_work) fn stop(
    root: &Path,
    id: &str,
    args: &Value,
    cancel_goal: bool,
) -> Result<bool, String> {
    let command = identity(args)?;
    let body = payload(args, if cancel_goal { "cancelGoal" } else { "stopRun" });
    write(root, |c| {
        if replay(c, id, &command, &body)? {
            return Ok(false);
        }
        let w = load(c, id)?;
        check(c, &w, args)?;
        if let Some(run) = w.active_run.as_deref() {
            c.execute("UPDATE agent_runs SET state='aborted',finished_at=?2,error='用户已停止本轮；在途业务结果按动作账本核验' WHERE id=?1 AND state='investigating'",params![run,stamp()]).map_err(|e|e.to_string())?;
        }
        // Do not change content/authorization revisions or erase prior facts.
        c.execute("UPDATE agent_works SET state=?2,active_run=NULL,report_json=NULL,updated_at=?3 WHERE id=?1",params![id,if cancel_goal {"cancelled"} else {"paused"},stamp()]).map_err(|e|e.to_string())?;
        super::super::watch::pause_on(c, id, "用户已停止工作，需明确继续")?;
        receipt(c, &w, &command, &body, w.active_run.as_deref())?;
        Ok(true)
    })
}

/// Admission and receipt share the run claim transaction. Replays never launch twice.
pub(in crate::agent_work) fn resume(
    root: &Path,
    id: &str,
    run: &str,
    args: &Value,
) -> Result<Option<Work>, String> {
    resume_impl(root, id, run, args, None)
}
pub(in crate::agent_work) fn resume_with_budget(
    root: &Path,
    id: &str,
    run: &str,
    args: &Value,
    budget: Budget,
) -> Result<Option<Work>, String> {
    resume_impl(root, id, run, args, Some(budget))
}
fn resume_impl(
    root: &Path,
    id: &str,
    run: &str,
    args: &Value,
    budget: Option<Budget>,
) -> Result<Option<Work>, String> {
    let command = identity(args)?;
    let body = payload(args, "resume");
    write(root, |c| {
        if replay(c, id, &command, &body)? {
            return Ok(None);
        }
        let w = load(c, id)?;
        check(c, &w, args)?;
        if !held(&w.state) {
            return Err("当前事项不处于暂停或取消状态".into());
        }
        let state = view_on(c, &w)?;
        if state["canResume"] != true {
            return Err(state["reason"].as_str().unwrap_or("不能恢复").into());
        }
        if args["resumeQueue"] == true {
            super::followups::resume_on(root, c, id, args["selectedMessageId"].as_str())?;
        }
        let w = load(c, id)?;
        if let Some(anchor) = &w.anchor {
            w.grant.reader(root)?.read(anchor, 0, 1, None)?;
        }
        tasks::revalidate_on(root, c, &w)?;
        // Rebuild context from durable goal, tasks, artifacts and action receipts.
        // No provider checkpoint or external write is replayed here.
        c.execute("UPDATE agent_works SET state='ready' WHERE id=?1", [id])
            .map_err(|e| e.to_string())?;
        let next = claim_on(c, id, run)?;
        super::report_continuation::record_on(root, c, &next, run, args.get("reportContinuation"))?;
        if let Some(budget) = budget {
            super::execution_budget::reserve_on(c, &next, run, budget)?;
        }
        receipt(c, &w, &command, &body, Some(run))?;
        insert(
            c,
            id,
            Some(run),
            "lifecycleRecovery",
            &json!({"schemaVersion":1,"commandId":command,
            "mode":"newRunWithRevalidatedContext","goalBinding":goal::binding_on(c,&next)?,
            "priorRuns":state["runsUsed"],"priorRecordedUsage":state["recordedUsage"],
            "actions":super::super::actions::receipts_on(c,id)?,"taskTree":tasks::view_on(root,c,&next)?}),
        )?;
        Ok(Some(next))
    })
}
