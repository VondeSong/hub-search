//! An archive action binds a real reading item, selected destination and actual
//! domain plan. Unknown remote outcomes are observed, never blindly replayed.
use super::*;
use crate::x_bookmarks::library::conversion as domain;

pub(super) fn options_on(c: &Connection, w: &Work) -> Result<Value, String> {
    if w.state == "revoked" || !matches!(w.anchor, Some(EvidenceLocator::Reading { .. })) {
        return Ok(json!([]));
    }
    let mut q=c.prepare("SELECT id,name FROM libraries WHERE provider IN ('craft','dida365') AND enabled=1 ORDER BY name,id LIMIT 100").map_err(|e|e.to_string())?;
    let values = q
        .query_map([], |r| {
            Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?}))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(json!(values))
}
fn key(w: &Work) -> Result<&str, String> {
    if let Some(EvidenceLocator::Reading { item_key }) = &w.anchor {
        Ok(item_key)
    } else {
        Err("归档从真实阅读条目发起，不把普通笔记伪装成收藏".into())
    }
}
pub(super) fn context_on(
    root: &Path,
    c: &Connection,
    w: &Work,
    args: &Value,
) -> Result<Value, String> {
    let key = key(w)?;
    let target = text(args, "libraryId", 150)?;
    if !w.anchor_authorized() {
        return Err("阅读条目不在事项授权中".into());
    }
    let source = w
        .grant
        .reader(root)?
        .read(w.source_anchor()?, 0, 15000, None)?;
    if source.truncated {
        return Err("原材料超过本次受控归档准备范围，请使用现有保存流程或缩小材料".into());
    }
    w.grant
        .reader(root)?
        .verify_in_transaction(c, &[source.clone()])?;
    let target_info=c.query_row("SELECT id,name,provider,COALESCE(location,'') FROM libraries WHERE id=?1 AND provider IN ('craft','dida365') AND enabled=1",[&target],|r|Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"provider":r.get::<_,String>(2)?,"location":r.get::<_,String>(3)?}))).optional().map_err(|e|e.to_string())?.ok_or("目标 Craft 或滴答资料库已不可用")?;
    let mut context = json!({"source":source,"sourceRevision":domain::agent_source_revision(c,key)?,"libraryId":target,"target":target_info});
    if let Some(instruction) = args["instruction"].as_str() {
        if !instruction.trim().is_empty() {
            context["instruction"] = json!(text(args, "instruction", 2000)?);
        }
    }
    refinement(c, w, args, "archiveCopy", context)
}
async fn prepare(app: tauri::AppHandle, args: Value) -> Result<Value, String> {
    let root = crate::active_data_root(&app)?;
    let id = text(&args, "id", 150)?;
    let target = text(&args, "libraryId", 150)?;
    crate::library_runtime::gate(&root, &target)?;
    let connection = domain::agent_connection_fingerprint(&app, &target)?;
    let (w, action, context, control, running) =
        begin_preparation(&root, &id, "archiveCopy", &args, |c, w| {
            domain::agent_eligible_on(c, key(w)?, &target)?;
            context_on(&root, c, w, &args)
        })?;
    let result=async {
        let op_root=root.clone();let op_control=control.clone();
        let model_work=w.clone();
        let operation=std::sync::Arc::new(tokio::task::spawn_blocking(move||options::operation(&op_root,&model_work,"agent-craft-archive","准备受控归档方案",op_control)).await.map_err(|_|"归档模型准入已中断")??);
        let decisions=store::records(&root,&id,"userDecision",32)?;
        let goal=format!("{}\n本轮具体要求：{}\n待调整的旧方案（只是草稿，不是已执行事实）：{}\n完成条件：{}\n用户已确认的信息：{}",w.goal,context["instruction"],context["previousDraft"],w.success_criteria,json!(decisions));
        let result=domain::prepare_agent_plan(&app,key(&w)?,&target,goal,context["sourceRevision"].as_str().unwrap_or_default().into(),operation.clone(),control.clone()).await;
        let result=result.and_then(|mut plan|{
            control.check()?;
            if plan["revision"]!=context["sourceRevision"] {return Err("归档准备期间原文发生变化".into());}
            if domain::agent_connection_fingerprint(&app,&target)?!=connection {return Err("归档连接已改变，请重新准备".into());}
            if plan["status"]!="planned" {return Err(plan["reason"].as_str().unwrap_or("归档方案仍缺少必要条件").chars().take(200).collect());}
            plan["agentActionId"]=json!(action);plan["agentWorkId"]=json!(id);
            let mut payload=json!({"libraryId":target,"targetName":context["target"]["name"],"sourceTitle":context["source"]["title"],"connectionFingerprint":connection,"plan":plan});
            for field in ["instruction","baseActionId"] {if let Some(v)=context.get(field){payload[field]=v.clone();}}
            publish_payload(&root,&w,&action,&payload,&control)
        });
        operation.finish(&result);result
    }.await;
    if let Err(error) = &result {
        fail_preparation(&root, &action, error)?;
    }
    drop(running);
    result?;
    status(&root, &id)
}
fn claim_execution(
    root: &Path,
    id: &str,
    action: &str,
    confirmation: &str,
    connection: &str,
) -> Result<Option<(Work, Action, Control, Running)>, String> {
    let permit = crate::library_runtime::cached_read_permit(root)?;
    let control = Control::bounded(Duration::from_secs(600)).guarded(move || permit.checkpoint());
    let map_key = (root_key(root), id.to_string());
    let mut map = active().lock().map_err(|_| "事项运行状态不可用")?;
    if map.contains_key(&map_key) {
        return Err("该事项正在运行，请先停止或等待".into());
    }
    let claimed = store::write(root, |c| {
        let a = load(c, id, action)?;
        if a.kind != "archiveCopy" || token(&a) != confirmation {
            return Err("归档确认与具体方案不匹配".into());
        }
        if a.state == "verified" {
            return Ok(None);
        }
        if !["prepared", "interrupted", "partial"].contains(&a.state.as_str()) {
            return Err("写入结果尚未核对，请先核对或关联已有目标，不能重复创建".into());
        }
        let w = store::load(c, id)?;
        check_prepared(root, c, &w, &a)?;
        let payload = a.payload.as_ref().ok_or("归档方案缺失")?;
        if payload["connectionFingerprint"].as_str() != Some(connection) {
            return Err("目标连接或认证已改变，请重新准备归档方案".into());
        }
        let plan = &payload["plan"];
        let target = payload["libraryId"].as_str().ok_or("归档目标无效")?;
        if a.state != "prepared" {
            let current = domain::agent_receipt_on(c, key(&w)?, target, plan)?;
            if current["state"] == "unknown" {
                return Err("当前没有足够证据安全继续，请先关联并核对目标".into());
            }
        }
        domain::agent_claim_on(c, key(&w)?, target, plan)?;
        let receipt=a.receipt.clone().unwrap_or(json!({"domain":"collectionArchive","confirmedBy":"user","confirmedAt":stamp(),"goalCompleted":false}));
        c.execute("UPDATE agent_actions SET state='executing',receipt_json=?2,error=NULL,updated_at=?3 WHERE id=?1",params![action,receipt.to_string(),stamp()]).map_err(|e|e.to_string())?;
        Ok(Some((w, a)))
    })?;
    let Some((w, a)) = claimed else {
        return Ok(None);
    };
    map.insert(
        map_key.clone(),
        Active {
            run_id: action.into(),
            control: control.clone(),
            is_action: true,
        },
    );
    Ok(Some((w, a, control, Running(map_key))))
}
fn record_result(root: &Path, id: &str, action: &str, error: Option<&str>) -> Result<(), String> {
    store::write(root, |c| {
        let a = load(c, id, action)?;
        let current = current_on(c, &a)?;
        let state = current["state"].as_str().unwrap_or("unknown");
        let mut receipt = a
            .receipt
            .unwrap_or(json!({"domain":"collectionArchive","goalCompleted":false}));
        receipt["result"] = current.clone();
        receipt["observedAt"] = json!(stamp());
        c.execute(
            "UPDATE agent_actions SET state=?2,receipt_json=?3,error=?4,updated_at=?5 WHERE id=?1",
            params![
                action,
                state,
                receipt.to_string(),
                error.map(|e| e.chars().take(200).collect::<String>()),
                stamp()
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
}
async fn submit(app: tauri::AppHandle, args: Value) -> Result<Value, String> {
    let root = crate::active_data_root(&app)?;
    let id = text(&args, "id", 150)?;
    let action = text(&args, "actionId", 150)?;
    let confirmation = text(&args, "confirmationToken", 100)?;
    let a = load(
        &crate::source_evidence::open_read_database(&root)?,
        &id,
        &action,
    )?;
    if a.kind != "archiveCopy" || token(&a) != confirmation {
        return Err("归档确认与方案不匹配".into());
    }
    if a.state == "verified" {
        return status(&root, &id);
    }
    let target = a
        .payload
        .as_ref()
        .and_then(|p| p["libraryId"].as_str())
        .ok_or("归档目标缺失")?
        .to_string();
    let connection = domain::agent_connection_fingerprint(&app, &target)?;
    let Some((w, a, control, running)) =
        claim_execution(&root, &id, &action, &confirmation, &connection)?
    else {
        return status(&root, &id);
    };
    let payload = a.payload.clone().ok_or("归档方案缺失")?;
    let guard_app = app.clone();
    let guard_root = root.clone();
    let guard_work = w.clone();
    let guard_action = a.clone();
    let guard_target = target.clone();
    let guarded = control.guarded(move || {
        let c = crate::source_evidence::open_read_database(&guard_root)?;
        check_prepared(&guard_root, &c, &guard_work, &guard_action)?;
        let payload = guard_action.payload.as_ref().ok_or("归档方案缺失")?;
        domain::agent_checkpoint_on(&c, key(&guard_work)?, &guard_target, &payload["plan"])?;
        if domain::agent_connection_fingerprint(&guard_app, &guard_target)? != connection {
            return Err("归档目标连接已改变，停止后续写入".into());
        }
        Ok(())
    });
    let result = domain::execute_agent_plan(&app, key(&w)?, &payload["plan"], guarded).await;
    // Facts are retained even after a decision change or cancellation. Never
    // discard a returned remote ID just because the original grant expired.
    record_result(
        &root,
        &id,
        &action,
        result.as_ref().err().map(String::as_str),
    )?;
    drop(running);
    status(&root, &id)
}
pub(super) fn current_on(c: &Connection, a: &Action) -> Result<Value, String> {
    let p = a.payload.as_ref().ok_or("归档方案缺失")?;
    domain::agent_receipt_on(
        c,
        p["plan"]["itemId"].as_str().ok_or("阅读身份缺失")?,
        p["libraryId"].as_str().ok_or("归档目标缺失")?,
        &p["plan"],
    )
}
pub(super) fn fact_on(c: &Connection, a: &Action) -> Result<Value, String> {
    Ok(
        json!({"origin":"host","actionId":a.id,"kind":a.kind,"state":a.state,"confirmedAt":a.receipt.as_ref().map(|r|&r["confirmedAt"]),
        "recordedResult":a.receipt.as_ref().map(|r|domain::agent_receipt_verification(r["result"].clone())),"currentResult":current_on(c,a).unwrap_or(json!({"available":false})),"goalCompleted":false}),
    )
}
pub(super) fn reconcile(root: &Path, id: &str, live: Option<&str>) -> Result<(), String> {
    let c = crate::source_evidence::open_read_database(root)?;
    let mut q=c.prepare("SELECT id FROM agent_actions WHERE work_id=?1 AND kind='archiveCopy' AND state='executing' AND id<>COALESCE(?2,'')").map_err(|e|e.to_string())?;
    let ids = q
        .query_map(params![id, live], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(q);
    drop(c);
    for action in ids {
        record_result(
            root,
            id,
            &action,
            Some("上次执行已中断，已按现有业务记录核对；结果未知时不自动重试"),
        )?;
    }
    Ok(())
}
async fn associate(app: tauri::AppHandle, args: Value) -> Result<Value, String> {
    let root = crate::active_data_root(&app)?;
    let id = text(&args, "id", 150)?;
    let action = text(&args, "actionId", 150)?;
    let remote = text(&args, "remoteId", 150)?;
    let confirmation = text(&args, "confirmationToken", 100)?;
    let a = load(
        &crate::source_evidence::open_read_database(&root)?,
        &id,
        &action,
    )?;
    if a.kind != "archiveCopy"
        || token(&a) != confirmation
        || !["unknown", "partial"].contains(&a.state.as_str())
        || a.receipt.is_none()
    {
        return Err("当前没有可关联的已确认归档动作".into());
    }
    let p = a.payload.ok_or("归档方案缺失")?;
    if domain::agent_connection_fingerprint(&app, p["libraryId"].as_str().ok_or("归档目标缺失")?)?
        != p["connectionFingerprint"].as_str().unwrap_or_default()
    {
        return Err("目标连接已改变，请恢复原连接后再核对已有目标".into());
    }
    // The existing association entry performs a readback and checks the exact
    // stored plan while holding the same per-item resource reservation.
    Box::pin(domain::resolve_collection_conversion_checked(
        app,
        p["plan"]["itemId"].as_str().ok_or("材料身份缺失")?.into(),
        remote,
        p["libraryId"].as_str().map(str::to_string),
        Some(p["plan"].clone()),
    ))
    .await?;
    record_result(&root, &id, &action, None)?;
    status(&root, &id)
}
pub(super) async fn ui(app: tauri::AppHandle, args: Value) -> Result<Value, String> {
    if args.to_string().len() > 65536 {
        return Err("事项请求过大".into());
    }
    match args["action"].as_str().unwrap_or_default() {
        // Keep domain preparation/execution frames out of Tauri's command
        // future, which is initially constructed on the Windows main thread.
        "prepareArchive" => Box::pin(prepare(app, args)).await,
        "submitArchive" => Box::pin(submit(app, args)).await,
        "associateArchive" => Box::pin(associate(app, args)).await,
        _ => Err("未知归档动作".into()),
    }
}

#[cfg(test)]
mod tests;
