//! User commands remain the authority. This binding is a projection of durable
//! Work/command identities, not a model-authored replacement for user intent.
use super::*;
use sha2::{Digest, Sha256};

pub(in crate::agent_work) mod completion;
pub(in crate::agent_work) mod revisions;

#[cfg(test)]
mod tests;

pub(in crate::agent_work) fn user_binding_on(c: &Connection, work: &Work) -> Result<Value, String> {
    let (count, last): (i64, Option<String>) = c.query_row(
        "SELECT COUNT(*),(SELECT id FROM agent_records WHERE work_id=?1 AND kind='steering' ORDER BY rowid DESC LIMIT 1) FROM agent_records WHERE work_id=?1 AND kind='steering'",
        [&work.id], |r| Ok((r.get(0)?,r.get(1)?)),
    ).map_err(|e| e.to_string())?;
    Ok(
        json!({"schemaVersion":1,"workId":work.id,"workRevision":work.revision,
        "authorizationVersion":work.authorization_version,"commandWatermark":count,"lastCommandId":last}),
    )
}

pub(in crate::agent_work) fn binding_on(c: &Connection, work: &Work) -> Result<Value, String> {
    let mut binding = user_binding_on(c, work)?;
    let revision = revisions::number_on(c, work)?;
    if revision > 0 {
        binding["schemaVersion"] = json!(2);
        binding["goalRevision"] = json!(revision);
    }
    Ok(binding)
}
pub(in crate::agent_work) fn command_on(c: &Connection, work: &Work) -> Result<String, String> {
    let command: Option<String> = c.query_row("SELECT id FROM agent_records WHERE work_id=?1 AND kind IN ('userMessage','userDecision','steering') ORDER BY rowid DESC LIMIT 1",[&work.id],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    Ok(command.unwrap_or_else(|| format!("{}-goal", work.id)))
}
pub(in crate::agent_work) fn ensure_binding_on(
    c: &Connection,
    work: &Work,
    expected: &Value,
) -> Result<(), String> {
    if *expected != binding_on(c, work)? {
        return Err("用户要求已更新，请按最新要求重新核对并提交".into());
    }
    Ok(())
}

pub(in crate::agent_work) fn chart_current_on(
    c: &Connection,
    work: &Work,
    chart: &Value,
) -> Result<bool, String> {
    let current = binding_on(c, work)?;
    Ok(match chart.get("goalBinding") {
        Some(saved) => *saved == current,
        // Old chart revisions cannot prove which in-flight commands they used.
        None => {
            current["schemaVersion"] == 1
                && chart["goalRevision"] == work.revision
                && current["commandWatermark"] == 0
        }
    })
}

pub(in crate::agent_work) fn ensure_received_on(c: &Connection, run: &str) -> Result<(), String> {
    let mut query=c.prepare("SELECT s.work_id,s.body_json FROM agent_records s WHERE s.run_id=?1 AND s.kind='steering' AND NOT EXISTS(SELECT 1 FROM agent_records a WHERE a.run_id=?1 AND a.work_id=s.work_id AND a.kind='steeringAccepted' AND json_extract(a.body_json,'$.clientMessageId')=json_extract(s.body_json,'$.clientMessageId'))").map_err(|e|e.to_string())?;
    let pending = query
        .query_map([run], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    for row in pending {
        let (work, raw) = row.map_err(|e| e.to_string())?;
        let message: Value = serde_json::from_str(&raw).map_err(|_| "追加要求记录损坏")?;
        if !super::native_input::resolved_answer_on(c, &work, run, &message)? {
            return Err("运行中追加要求尚未接收，请接收后重新核对成果".into());
        }
    }
    Ok(())
}

pub(in crate::agent_work) fn current_run_on(
    c: &Connection,
    work: &Work,
    run: &str,
) -> Result<Work, String> {
    let current = load(c, &work.id)?;
    if current.revision != work.revision
        || current.authorization_version != work.authorization_version
        || current.active_run.as_deref() != Some(run)
        || current.state != "investigating"
    {
        return Err("调查依据、运行或授权已改变".into());
    }
    ensure_received_on(c, run)?;
    Ok(current)
}

pub(in crate::agent_work) fn for_run(root: &Path, work: &Work, run: &str) -> Result<Value, String> {
    let c = read(root)?;
    c.execute_batch("BEGIN DEFERRED")
        .map_err(|e| e.to_string())?;
    let current = current_run_on(&c, work, run)?;
    binding_on(&c, &current)
}

fn report_hash(report: &runner::Report) -> Result<String, String> {
    Ok(format!("{:x}", Sha256::digest(encode(report)?.as_bytes())))
}

/// Native finish accepts a precise report at a precise command boundary. The
/// final publication must still pass source, action and chart validation.
pub(in crate::agent_work) fn accept_report(
    root: &Path,
    work: &Work,
    run: &str,
    report: &runner::Report,
    expected: &Value,
) -> Result<Value, String> {
    write(root, |c| {
        let current = current_run_on(c, work, run)?;
        ensure_binding_on(c, &current, expected)?;
        super::super::artifacts::delivery_dependencies(
            root,
            c,
            &current,
            run,
            report.status == "completed",
            &Value::Null,
        )?;
        let refs = super::super::artifacts::run_references(c, &current, run)?;
        super::tasks::revalidate_on(root, c, &current)?;
        let assessment = completion::evaluate(root, c, &current, run, report)?;
        insert(
            c,
            &work.id,
            Some(run),
            "finishAcceptance",
            &json!({
                "schemaVersion":1,"goalBinding":expected,"reportHash":report_hash(report)?,"report":report,
                "artifactRefs":refs,"completion":assessment,
            }),
        )?;
        Ok(assessment)
    })
}

pub(in crate::agent_work) fn assessment_on(
    root: &Path,
    c: &Connection,
    work: &Work,
    run: &str,
    report: &runner::Report,
    refs: &Value,
) -> Result<Value, String> {
    ensure_received_on(c, run)?;
    let binding = binding_on(c, work)?;
    let hash = report_hash(report)?;
    super::tasks::revalidate_on(root, c, work)?;
    let mut assessment = completion::evaluate(root, c, work, run, report)?;
    let native: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_records WHERE run_id=?1 AND kind='nativeRuntime')",
            [run],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if native {
        let raw: Option<String> = c.query_row(
            "SELECT body_json FROM agent_records WHERE run_id=?1 AND kind='finishAcceptance' ORDER BY rowid DESC LIMIT 1",
            [run], |r| r.get(0),
        ).optional().map_err(|e| e.to_string())?;
        let saved: Value = serde_json::from_str(&raw.ok_or("缺少最终交付核验，请重新提交")?)
            .map_err(|_| "最终交付核验记录损坏")?;
        if saved["schemaVersion"] != 1
            || saved["goalBinding"] != binding
            || saved["reportHash"] != hash
            || saved["artifactRefs"] != *refs
            || saved["completion"] != assessment
        {
            return Err("最终核验后要求或成果已改变，请重新提交；旧结果未发布".into());
        }
    }
    assessment["schemaVersion"] = json!(2);
    assessment["goalBinding"] = binding;
    assessment["reportHash"] = json!(hash);
    assessment["artifactRefs"] = refs.clone();
    assessment["semanticStatus"] = json!(report.status);
    Ok(assessment)
}
