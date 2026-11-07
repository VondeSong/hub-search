//! Concrete task estimate using current rule projection and existing read/receipt owners.
use super::*;
pub(super) fn evaluate(
    context: &Context,
    session: &assistant::Session<'_>,
    guidance: &guidance::GuidanceRef,
    ledger: &bytes::Ledger,
    receipts: &Value,
) -> Result<Value, String> {
    let c = crate::source_evidence::open_read_database(session.root)?;
    let Some(plan) = store::material_budget::load_on(&c, &session.work.id)? else {
        return Ok(
            json!({"configured":false,"initialBytes":ledger.total(),"expectedAdditionalBytes":null,"limitBytes":ledger.limit,"allowed":ledger.total()<=ledger.limit,"meaning":"only exact initial size checked; no task completion estimate configured"}),
        );
    };
    drop(c);
    if plan.work_revision != session.work.revision
        || plan.authorization_version != session.work.authorization_version
        || plan.request_bytes != context.budget.request_bytes
    {
        return Err("材料预检计划与当前事项、授权或累计上限不一致，未启动模型".into());
    }
    let mut raw_reads = Vec::new();
    let mut excerpts = context.excerpts.clone();
    for item in &plan.reads {
        let current = context
            .reader
            .read(&item.locator, 0, 6000, Some(&item.version))?;
        if current.truncated {
            return Err("预检材料超过已冻结完整读取范围，未启动模型".into());
        }
        let mut raw = if let Some(reference) = &item.saved_result {
            store::tool_results::for_material_estimate(session.root, session.work, reference)?
        } else {
            let crate::source_evidence::EvidenceLocator::Note {
                library_id,
                document_id,
                ..
            } = &item.locator
            else {
                return Err("当前具体余量计划只支持已授权笔记".into());
            };
            crate::hub_capabilities::Session::new(session.root, Some(session.work.grant.scope()?))?
                .call(
                    "hub_read_note",
                    &json!({"libraryId":library_id,"documentId":document_id,"maxChars":6000}),
                    "host material preflight; not model reading",
                )?
        };
        if item.saved_result.is_none() {
            raw["readEvidence"] = json!(current);
        }
        if raw["content"] != current.content
            || raw["readEvidence"]["version"] != json!(current.version)
        {
            return Err("预检回执与当前原文或版本不一致，未启动模型".into());
        }
        if !excerpts
            .iter()
            .any(|e| e.locator == current.locator && e.version == current.version)
        {
            excerpts.push(current);
        }
        raw_reads.push((item, raw));
    }
    let quotes = json!(quotes::catalog(&excerpts));
    let rules = context
        .skills
        .as_ref()
        .map(|s| s.guidance())
        .unwrap_or(Value::Null);
    let fake_ref = json!({"recordId":"r".repeat(24),"runId":session.run,"sha256":"a".repeat(64),"utf8Bytes":65536});
    let frame = |mut raw: Value, name: &str| {
        if let Some(o) = raw.as_object_mut() {
            o.remove("readEvidence");
        }
        let raw = observation::attach_request(
            raw,
            &json!({"operation":"preflightEstimate","stepId":"c".repeat(64),"tool":name}),
        );
        input::tool_output(
            raw,
            fake_ref.clone(),
            quotes.clone(),
            receipts.clone(),
            rules.clone(),
            context.budget.tool_steps,
        )
    };
    let mut projected = guidance.clone();
    let mut components = Vec::new();
    let mut additional = 0usize;
    let mut largest_restore = 0usize;
    let mut ordinal = 0usize;
    for (item, raw) in raw_reads {
        for _ in 0..item.repetitions {
            let full = frame(raw.clone(), "hub_read_note");
            let call = format!("planned-{ordinal}");
            ordinal += 1;
            let wire = projected.project_for(full.clone(), &call);
            projected.sent(&call);
            let mut missing = guidance.clone();
            missing.invalidate();
            let restored = missing.project_for(full, "planned-rule-restore");
            largest_restore = largest_restore.max(
                restored
                    .to_string()
                    .len()
                    .saturating_sub(wire.to_string().len()),
            );
            let n = wire.to_string().len();
            additional += n;
            components.push(json!({"kind":"sourceRead","locator":item.locator,"bytes":n,"basis":if item.saved_result.is_some(){"verified complete saved result; exact production projection, future identities estimated"}else{"current formal read-only backend receipt; not model adoption"}}));
        }
    }
    if plan.working_state_round_trips > 0 {
        let raw = store::working_state::execute(
            session.root,
            session.work,
            session.run,
            &json!({"action":"read"}),
            session.control,
        )?;
        let n = projected
            .project_for(frame(raw, "hub_workingState"), "planned-working")
            .to_string()
            .len()
            + plan.working_state_extra_bytes;
        additional += n * plan.working_state_round_trips;
        components.push(json!({"kind":"workingState","count":plan.working_state_round_trips,"bytesEach":n,"estimatedContentBytesEach":plan.working_state_extra_bytes,"basis":"current read/checklist/goal envelope plus explicitly bounded planned record growth; actual model content remains uncertain"}));
    }
    if plan.goal_state_reads > 0 {
        let raw = store::goal::completion::read_context(session.root, session.work, session.run)?;
        let n = projected
            .project_for(frame(raw, "hub_goalState"), "planned-goal")
            .to_string()
            .len();
        additional += n * plan.goal_state_reads;
        components.push(json!({"kind":"deliveryGoalRead","count":plan.goal_state_reads,"bytesEach":n,"basis":"formal current goal/proof envelope; final report input and finish acknowledgement excluded by existing requestBytes contract, output tokens still bounded"}));
    }
    if plan.reserve_rule_restore {
        additional += largest_restore;
        components.push(json!({"kind":"oneRuleRestore","bytes":largest_restore,"basis":"actual missing-base projection minus known-base reply; one concrete restoration, not unlimited compaction"}));
    }
    additional += plan.other_reply_bytes;
    components.push(json!({"kind":"explicitUncertaintyAllowance","bytes":plan.other_reply_bytes,"basis":plan.basis}));
    let required = ledger.total().saturating_add(additional);
    Ok(
        json!({"configured":true,"initialBytes":ledger.total(),"expectedAdditionalBytes":additional,"expectedTotalBytes":required,"limitBytes":ledger.limit,"shortfallBytes":required.saturating_sub(ledger.limit),"estimatedRemainingBytes":ledger.limit.saturating_sub(required),"allowed":required<=ledger.limit,"components":components,"estimateOnly":true,"runtimeChecksRemain":true,"scope":"future tool choices/content are estimates, not a promise of no overrun; cumulative bytes and old provider reservations never reset"}),
    )
}
pub(super) fn enforce(value: &Value) -> Result<(), String> {
    if value["allowed"] == true {
        Ok(())
    } else {
        Err(format!("启动前材料余量不足：初始占用 {} 字节，预计必要空间 {} 字节，还差 {} 字节；任务已保留，未请求模型",value["initialBytes"],value["expectedAdditionalBytes"],value["shortfallBytes"]))
    }
}

// A bounded setup estimate is admission evidence, not bytes already received by a provider.
pub(super) fn mcp_setup(mut value: Value, initial: usize, limit: usize, setup: usize) -> Value {
    let additional = value["expectedAdditionalBytes"].as_u64().unwrap_or(0) as usize + setup;
    let total = initial.saturating_add(additional);
    value["expectedAdditionalBytes"] = json!(additional);
    value["expectedTotalBytes"] = json!(total);
    value["shortfallBytes"] = json!(total.saturating_sub(limit));
    value["estimatedRemainingBytes"] = json!(limit.saturating_sub(total));
    value["allowed"] = json!(total <= limit);
    value["mcpSetupEstimateBytes"] = json!(setup);
    value["estimateOnly"] = json!(true);
    value["runtimeChecksRemain"] = json!(true);
    value["mcpSetupBasis"]=json!("current exact initialize/tools-list serialization with maximum128-byte request IDs; tools already charged once, repeated instructions and framing included; further calls remain bounded at runtime");
    value
}
#[cfg(test)]
mod mcp_tests {
    use super::*;
    #[test]
    fn setup_shortfall_is_rejected_before_admission_without_resetting_initial_or_other_charges() {
        let old = json!({"configured":true,"initialBytes":100,"expectedAdditionalBytes":40,"allowed":true});
        let exact = mcp_setup(old.clone(), 100, 160, 20);
        assert_eq!(exact["expectedTotalBytes"], 160);
        assert!(enforce(&exact).is_ok());
        let fail = mcp_setup(old, 100, 159, 20);
        assert!(enforce(&fail).unwrap_err().contains("还差 1"));
        assert_eq!(fail["initialBytes"], 100);
        assert_eq!(fail["expectedAdditionalBytes"], 60);
    }
}
