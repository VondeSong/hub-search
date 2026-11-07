//! Publish an exact, previously accepted report without restarting its provider.
use super::*;
use sha2::{Digest, Sha256};

fn hash(value: &impl Serialize) -> Result<String, String> {
    Ok(format!("{:x}", Sha256::digest(encode(value)?.as_bytes())))
}

fn last(c: &Connection, run: &str, kind: &str) -> Result<Value, String> {
    let raw:String=c.query_row("SELECT body_json FROM agent_records WHERE run_id=?1 AND kind=?2 ORDER BY rowid DESC LIMIT 1",params![run,kind],|r|r.get(0)).map_err(|_|format!("恢复依据缺失：{kind}"))?;
    serde_json::from_str(&raw).map_err(|_| "恢复依据损坏".into())
}

fn verify_material_identity(
    saved_catalog: &Value,
    saved_rules: &Value,
    current_catalog: &Value,
    current_rules: &Value,
) -> Result<(), String> {
    fn rules(value: &Value) -> Result<Value, String> {
        let rows = value
            .as_array()
            .filter(|v| v.len() <= 64)
            .ok_or("规则基版缺失或超过容量")?;
        let mut rows = rows.clone();
        for row in &mut rows {
            let object = row.as_object_mut().ok_or("规则基版格式无效")?;
            // This is a display location in the profile, not the rule's scope,
            // content fingerprint or source path; those remain exact matches.
            if object
                .remove("managedDirectory")
                .and_then(|v| v.as_str().map(str::to_owned))
                .is_none()
            {
                return Err("规则目录记录缺失".into());
            }
        }
        Ok(crate::knowledge_rules::compact_guidance(json!(rows)))
    }
    if !saved_catalog.is_object()
        || saved_catalog != current_catalog
        || rules(saved_rules)? != rules(current_rules)?
    {
        return Err("方法或规则内容、作用域或版本已变化".into());
    }
    Ok(())
}

pub(super) fn eligible_on(
    c: &Connection,
    w: &Work,
    run: &str,
    report: &runner::Report,
) -> Result<(), String> {
    let (latest,revision,authorization,state,error):(String,i64,i64,String,Option<String>)=c.query_row(
        "SELECT id,base_revision,authorization_version,state,error FROM agent_runs WHERE work_id=?1 ORDER BY rowid DESC LIMIT 1",[&w.id],
        |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).map_err(|_|"原运行不存在")?;
    if latest != run
        || revision != w.revision
        || authorization != w.authorization_version
        || !matches!(state.as_str(), "failed" | "interrupted")
        || error.as_deref() != Some("Codex 生成超时，请重试。")
        || !matches!(w.state.as_str(), "failed" | "interrupted")
        || w.active_run.is_some()
        || w.report.is_some()
    {
        return Err("仅能恢复当前事项最近一次生成超时后尚未发布的已核验报告".into());
    }
    let accepted = last(c, run, "finishAcceptance")?;
    if accepted["schemaVersion"] != 1 || accepted["reportHash"] != hash(report)? {
        return Err("报告与原先接受的正文不一致，未发布".into());
    }
    goal::ensure_binding_on(c, w, &accepted["goalBinding"])?;
    goal::ensure_received_on(c, run)?;
    let measurement = last(c, run, "nativeMeasurement")?;
    let budget = last(c, run, "budget")?;
    let limit = budget["modelCallSeconds"]
        .as_u64()
        .ok_or("原生成时限缺失")?
        .saturating_mul(1000);
    let finished_in_time = measurement["tools"]
        .as_array()
        .ok_or("原交付计时缺失")?
        .last()
        .is_some_and(|t| {
            t["tool"] == "hub_finish"
                && t["outcome"] == "returned"
                && t["hostStartMs"]
                    .as_u64()
                    .zip(t["hostHandlingMs"].as_u64())
                    .is_some_and(|(s, d)| s.saturating_add(d) < limit)
        });
    if !finished_in_time || measurement["materialBytes"]["overrunBytes"] != 0 {
        return Err("不能证明原报告在生成与材料预算内接受，未恢复".into());
    }
    let session = last(c, run, "nativeSession")?;
    // shortcut: qualify recovery with business actions or shared memory separately;
    // this entry covers the observed read-only report, never replays an action.
    if session["providerTurnCompleted"] != false
        || session["executionManifest"]["actionRefs"] != json!([])
        || super::super::actions::receipts_on(c, &w.id)? != json!([])
        || session["bindingParts"]["sharedMemory"] != hash(&Value::Null)?
    {
        return Err("当前恢复仅支持无业务动作、无共享记忆的已核验报告".into());
    }
    Ok(())
}

pub(in crate::agent_work) fn recover(root: &Path, args: &Value) -> Result<Value, String> {
    let id = text(args, "id", 150)?;
    let run = text(args, "originRunId", 150)?;
    let raw = args.get("report").ok_or("缺少原报告")?;
    if encode(raw)?.len() > 65_536 {
        return Err("恢复报告超过原单条记录容量".into());
    }
    let report: runner::Report =
        serde_json::from_value(raw.clone()).map_err(|_| "恢复报告格式无效")?;
    let digest = hash(&report)?;
    let control = Control::bounded(std::time::Duration::from_secs(30));
    let work = write(root, |c| {
        let w = load(c, &id)?;
        if args["expectedWorkRevision"] != w.revision
            || args["expectedAuthorizationVersion"] != w.authorization_version
        {
            return Err("事项或授权版本已变化，未恢复报告".into());
        }
        let previous:Option<String>=c.query_row("SELECT body_json FROM agent_records WHERE work_id=?1 AND run_id=?2 AND kind='acceptedReportRecovery' ORDER BY rowid DESC LIMIT 1",params![id,run],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        if let Some(raw) = previous {
            let receipt: Value = serde_json::from_str(&raw).map_err(|_| "恢复回执损坏")?;
            if receipt["reportHash"] != digest {
                return Err("恢复身份已对应另一份报告".into());
            }
            return Ok(None);
        }
        eligible_on(c, &w, &run, &report)?;
        execution_budget::reserve_delivery_on(c, &w, &run)?;
        Ok(Some(w))
    })?;
    let Some(work) = work else {
        return Ok(
            json!({"state":"alreadyPublished","originRunId":run,"reportHash":digest,"providerCalls":0,"historicalRunUnchanged":true}),
        );
    };
    let result = (|| {
        control.check()?;
        let c = read(root)?;
        let session = last(&c, &run, "nativeSession")?;
        let mut q=c.prepare("SELECT body_json FROM agent_records WHERE run_id=?1 AND kind='evidence' ORDER BY rowid").map_err(|e|e.to_string())?;
        let bodies = q
            .query_map([&run], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let mut excerpts = Vec::new();
        let mut bytes = 0;
        for body in bodies {
            bytes += body.len();
            if bytes > 262_144 {
                return Err("原证据超过本恢复入口容量，未发布".into());
            }
            let v: Value = serde_json::from_str(&body).map_err(|_| "原证据损坏")?;
            if v["evidenceId"] != format!("e{}", excerpts.len() + 1) {
                return Err("原引用顺序无法确认".into());
            }
            excerpts.push(
                serde_json::from_value::<EvidenceExcerpt>(v["excerpt"].clone())
                    .map_err(|_| "原文证据无效")?,
            );
        }
        runner::validate(&report, &excerpts)?;
        let candidates: Vec<(EvidenceLocator, crate::source_evidence::EvidenceVersion)> =
            serde_json::from_value(session["dependencies"].clone()).map_err(|_| "来源依赖缺失")?;
        if candidates.len() > 64 {
            return Err("来源依赖超过恢复容量".into());
        }
        let mut skills = crate::hub_capabilities::Session::new(root, Some(work.grant.scope()?))?
            .controlled(control.clone());
        if let Some((binding, version)) = super::super::topics::version_on(&c, &work)? {
            let original = last(&c, &run, "topicRunBinding")?;
            for key in [
                "topicId",
                "configRevision",
                "period",
                "methodVersion",
                "parameters",
                "defaultQuestion",
            ] {
                if original[key] != binding[key] {
                    return Err("专题或固定方法绑定已变化".into());
                }
            }
            skills.pin_version(&version)?;
            skills.set_topic_context(&binding)?;
        }
        verify_material_identity(
            &last(&c, &run, "skillCatalog")?["catalog"],
            &last(&c, &run, "libraryRules")?,
            &skills.metadata(),
            &skills.guidance(),
        )?;
        skills.inherit_reads(&session["skillReads"])?;
        skills.inherit_rules(&session["ruleReads"])?;
        skills.inherit_materials(&session["materialReads"])?;
        drop(q);
        drop(c);
        skills.verify()?;
        let reader = work.grant.reader(root)?.controlled(control.clone());
        write(root, |c| {
            skills.verify()?;
            publish_on(
                root,
                c,
                &work,
                &run,
                &report,
                &excerpts,
                &candidates,
                &json!([]),
                &session["materialReads"],
                &control,
                &reader,
                true,
            )?;
            let receipt = json!({"schemaVersion":1,"originRunId":run,"reportHash":digest,"providerCalls":0,"providerUsageSettled":false,"historicalRunUnchanged":true,"elapsedMs":control.elapsed().as_millis() as u64,"state":"published","scope":"separate saved-report recovery; not a regrade of the failed model run"});
            insert(c, &id, Some(&run), "acceptedReportRecovery", &receipt)?;
            control.check()?;
            Ok(receipt)
        })
    })();
    if let Err(error) = &result {
        // Keep the reservation even if recording the failure also fails.
        let _ = write(root, |c| {
            insert(
                c,
                &id,
                Some(&run),
                "acceptedReportRecoveryFailed",
                &json!({"error":error,"providerCalls":0,"reportHash":digest}),
            )
        });
    }
    result
}

#[cfg(test)]
mod tests;
