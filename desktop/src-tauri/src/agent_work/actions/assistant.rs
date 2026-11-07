//! In-run drafting uses the same validators and persistence as manual drafting.
//! The model receives current material first, then submits a candidate. No
//! original file, remote page or study queue is changed by these tools.
use super::*;
use std::sync::Arc;

pub(in crate::agent_work) fn flashcard_schema() -> Value {
    flashcards::schema()
}
pub(in crate::agent_work) fn edit_schema() -> Value {
    json!({"type":"object","additionalProperties":false,"required":["markdown","summary","warnings"],"properties":{
        "markdown":{"type":"string"},"summary":{"type":"string"},"warnings":{"type":"array","items":{"type":"string"}}}})
}
fn action_kind(kind: &str) -> Result<&'static str, String> {
    match kind {
        "flashcards" => Ok("flashcardDrafts"),
        "obsidianEdit" => Ok("obsidianEdit"),
        _ => Err("此工具仅准备闪卡或笔记修改".into()),
    }
}
fn args(kind: &str, instruction: &str, target: &str, base: Option<&str>) -> Result<Value, String> {
    let mut args = json!({"instruction":instruction,"baseActionId":base});
    text(&args, "instruction", 2000)?;
    match kind {
        "flashcards" => {
            args["learningGoal"] = json!(instruction);
            args["deckName"] = json!(if target.trim().is_empty() {
                "收件箱"
            } else {
                target
            });
        }
        "obsidianEdit" => (),
        _ => return Err("不支持的草稿种类".into()),
    }
    Ok(args)
}
fn current(
    root: &Path,
    c: &Connection,
    w: &Work,
    kind: &str,
    args: &Value,
) -> Result<Value, String> {
    match kind {
        "flashcards" => flashcards::context_on(root, c, w, args),
        "obsidianEdit" => obsidian::context_on(root, c, w, args),
        _ => Err("不支持的草稿种类".into()),
    }
}
pub(in crate::agent_work) fn context(
    root: &Path,
    w: &Work,
    run: &str,
    kind: &str,
    instruction: &str,
    target: &str,
    base: Option<&str>,
) -> Result<Value, String> {
    let args = args(kind, instruction, target, base)?;
    store::check_run(root, w, run)?;
    let c = crate::source_evidence::open_read_database(root)?;
    let context = current(root, &c, w, kind, &args)?;
    let id = format!("context-{}", crate::random_url_safe(16));
    let mut material = context.clone();
    let source = if kind == "flashcards" {
        let source = material["source"].clone();
        material.as_object_mut().unwrap().remove("source");
        source
    } else {
        let snapshot: crate::obsidian_edit::Snapshot =
            serde_json::from_value(material["snapshot"].clone()).map_err(|_| "笔记快照损坏")?;
        let (_, body) = crate::obsidian_edit::split(&snapshot.before)?;
        if body.chars().count() > 12000 {
            return Err("笔记正文超过本次修改范围".into());
        }
        material.as_object_mut().unwrap().remove("snapshot");
        material["markdown"] = json!(body);
        json!(w.grant.reader(root)?.read(
            w.action_anchor().ok_or("请先明确选择保存目标")?,
            0,
            16000,
            None
        )?)
    };
    drop(c);
    store::record(
        root,
        run,
        "draftContext",
        &json!({"id":id,"kind":kind,"args":args,"hash":digest(&context)}),
    )?;
    Ok(
        json!({"contextId":id,"kind":kind,"material":material,"readEvidence":source,
        "candidateSchema":if kind=="flashcards"{flashcard_schema()}else{edit_schema()},
        "instructions":if kind=="flashcards"{"Prepare 1–5 Chinese question/answer cards. Each quote must be an exact continuous line in this source. Honor quality rules and explain uncovered targets; do not invent unsupported facts."}else{"Return the complete edited body markdown without frontmatter, preserve facts, references and attachments; new wiki links must match linkTargets. Return summary and warnings."}}),
    )
}
fn saved_context(root: &Path, w: &Work, run: &str, id: &str) -> Result<Value, String> {
    let c = crate::source_evidence::open_read_database(root)?;
    let raw:String=c.query_row("SELECT body_json FROM agent_records WHERE work_id=?1 AND run_id=?2 AND kind='draftContext' AND json_extract(body_json,'$.id')=?3 ORDER BY rowid DESC LIMIT 1",params![w.id,run,id],|r|r.get(0)).map_err(|_|"草稿上下文不属于当前运行，请先读取制作上下文")?;
    serde_json::from_str(&raw).map_err(|_| "草稿上下文记录损坏".into())
}
fn admit(
    c: &Connection,
    w: &Work,
    run: &str,
    id: &str,
    kind: &str,
    context: &Value,
    payload: &Value,
    context_id: Option<&str>,
) -> Result<(), String> {
    check_preparation(c, w)?;
    if w.active_run.as_deref() != Some(run) {
        return Err("草稿所属运行已改变".into());
    }
    let count: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM agent_actions WHERE work_id=?1",
            [&w.id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if count >= 20 {
        return Err("此对话的草稿记录已满，请新建对话".into());
    }
    c.execute("INSERT INTO agent_actions(id,work_id,kind,base_revision,authorization_version,state,payload_json,context_hash,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,'prepared',?6,?7,?8,?8)",
        params![id,w.id,kind,w.revision,w.authorization_version,payload.to_string(),digest(context),stamp()]).map_err(|e|e.to_string())?;
    store::insert(
        c,
        &w.id,
        Some(run),
        "agentDraft",
        &json!({"actionId":id,"contextId":context_id,"candidateHash":digest(payload)}),
    )?;
    Ok(())
}
pub(in crate::agent_work) fn prepare(
    root: &Path,
    w: &Work,
    run: &str,
    id: &str,
    candidate: &Value,
    selection: &Value,
    control: &Control,
) -> Result<Value, String> {
    let saved = saved_context(root, w, run, id)?;
    let kind = saved["kind"].as_str().ok_or("草稿类型缺失")?;
    let c = crate::source_evidence::open_read_database(root)?;
    let context = current(root, &c, w, kind, &saved["args"])?;
    if json!(digest(&context)) != saved["hash"] {
        return Err("制作上下文已变化，请重新读取".into());
    }
    let existing:Option<String>=c.query_row("SELECT json_extract(body_json,'$.actionId') FROM agent_records WHERE run_id=?1 AND kind='agentDraft' AND json_extract(body_json,'$.contextId')=?2",[run,id],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    drop(c);
    if let Some(id) = existing {
        return inspect(root, w, &id);
    }
    let action = format!("action-{}", crate::random_url_safe(18));
    let mut payload = match kind {
        "flashcards" => {
            flashcards::build_payload(root, w, &action, &context, selection, control, |_, _| {
                Ok(candidate.clone())
            })?
        }
        "obsidianEdit" => {
            obsidian::build_payload(root, w, &context, control, |_, _| Ok(candidate.clone()))?
        }
        _ => return Err("不支持的草稿类型".into()),
    };
    payload["originRunId"] = json!(run);
    control.check()?;
    store::write(root, |c| {
        let fresh = current(root, c, w, kind, &saved["args"])?;
        if digest(&fresh) != digest(&context) {
            return Err("草稿提交前来源已变化".into());
        }
        admit(
            c,
            w,
            run,
            &action,
            action_kind(kind)?,
            &context,
            &payload,
            Some(id),
        )?;
        if let Some(base) = saved["args"]["baseActionId"].as_str() {
            c.execute("UPDATE agent_actions SET state='superseded',updated_at=?2 WHERE id=?1 AND work_id=?3 AND state='prepared'",params![base,stamp(),w.id]).map_err(|e|e.to_string())?;
        }
        control.check()
    })?;
    inspect(root, w, &action)
}
pub(in crate::agent_work) fn inspect(root: &Path, w: &Work, id: &str) -> Result<Value, String> {
    let c = crate::source_evidence::open_read_database(root)?;
    let a = load(&c, &w.id, id)?;
    check_preparation(&c, w)?;
    if a.authorization_version != w.authorization_version
        || a.base_revision != w.revision
        || a.state != "prepared"
    {
        return Err("只能检查本轮仍有效的待确认草稿".into());
    }
    let p = a.payload.as_ref().ok_or("草稿缺失")?;
    check_action_context(root, &c, w, &a)?;
    let content = match a.kind.as_str() {
        "flashcardDrafts" => {
            json!({"cards":p["cards"],"uncoveredTargets":p["uncoveredTargets"],"deckName":p["deckName"]})
        }
        "obsidianEdit" => {
            json!({"after":p["after"],"summary":p["summary"],"warnings":p["warnings"]})
        }
        "archiveCopy" => {
            let mut plan = p["plan"].clone();
            // Target inventory belongs to persisted preparation, not the draft inspection result.
            let omitted = plan
                .as_object_mut()
                .and_then(|p| p.remove("context"))
                .is_some();
            json!({"plan":plan,"targetName":p["targetName"],"preparationContextOmitted":omitted})
        }
        _ => return Err("此工具不支持该业务记录".into()),
    };
    Ok(
        json!({"actionId":a.id,"kind":a.kind,"state":a.state,"content":content,
        "validation":"Source versions and domain constraints checked. This is a draft, not a saved source or imported card. Inspect semantic quality against the user request; refine using draftContext with this baseActionId when needed."}),
    )
}
pub(in crate::agent_work) fn import_flashcards(
    root: &Path,
    w: &Work,
    run: &str,
    id: &str,
    control: &Control,
) -> Result<Value, String> {
    control.check()?;
    store::check_run(root, w, run)?;
    store::write(root, |c| {
        check_preparation(c, w)?;
        let current = options::load_on(c, &w.id)?;
        if !current.auto_flashcard_inbox {
            return Err("本对话未授权直接导入；请保留草稿供用户确认".into());
        }
        let raw:String=c.query_row("SELECT body_json FROM agent_records WHERE run_id=?1 AND work_id=?2 AND kind='agentProtocol' ORDER BY rowid LIMIT 1",params![run,w.id],|r|r.get(0)).map_err(|_|"没有本轮导入授权快照")?;
        let saved: Value = serde_json::from_str(&raw).map_err(|_| "本轮授权快照损坏")?;
        if saved["options"] != json!(current) || saved["options"]["autoFlashcardInbox"] != true {
            return Err("导入授权与本轮不匹配".into());
        }
        let a = load(c, &w.id, id)?;
        if a.kind != "flashcardDrafts"
            || a.payload.as_ref().and_then(|p| p["originRunId"].as_str()) != Some(run)
        {
            return Err("只能导入明确指定的本轮闪卡草稿".into());
        }
        check_action_context(root, c, w, &a)?;
        if a.state == "verified" {
            let receipt = a.receipt.as_ref().ok_or("导入回执缺失")?;
            if receipt["confirmedBy"] != "conversationGrant" {
                return Err("草稿已经由其它入口处理，请读取现有回执".into());
            }
            return Ok(
                json!({"actionId":id,"imported":true,"alreadyImported":true,"receipt":receipt}),
            );
        }
        if a.state != "prepared" {
            return Err("只能导入仍有效的待确认闪卡草稿".into());
        }
        control.check()?;
        let receipt = flashcards::import_on(c, &a, "conversationGrant")?;
        store::insert(c, &w.id, Some(run), "agentImportReceipt", &receipt)?;
        control.check()?;
        Ok(
            json!({"actionId":id,"imported":true,"alreadyImported":false,"receipt":receipt,
            "meaning":"已导入闪卡收件箱，待审核，未进入正式复习。"}),
        )
    })
}
pub(in crate::agent_work) async fn archive(
    app: &tauri::AppHandle,
    w: &Work,
    run: &str,
    instruction: &str,
    target: &str,
    base: Option<&str>,
    operation: Arc<Operation>,
    control: Control,
) -> Result<Value, String> {
    let root = crate::active_data_root(app)?;
    store::check_run(&root, w, run)?;
    let args = json!({"libraryId":target,"instruction":instruction,"baseActionId":base});
    text(&args, "instruction", 2000)?;
    let c = crate::source_evidence::open_read_database(&root)?;
    let key = if let Some(EvidenceLocator::Reading { item_key }) = &w.anchor {
        item_key.clone()
    } else {
        return Err("归档从当前阅读条目发起".into());
    };
    let context = archive::context_on(&root, &c, w, &args)?;
    drop(c);
    let connection =
        crate::x_bookmarks::library::conversion::agent_connection_fingerprint(app, target)?;
    let goal = format!(
        "{}\n本轮要求：{}\n原草稿：{}\n仅准备方案，用户确认后由原归档服务执行。",
        w.goal, instruction, context["previousDraft"]
    );
    let mut plan = crate::x_bookmarks::library::conversion::prepare_agent_plan(
        app,
        &key,
        target,
        goal,
        context["sourceRevision"]
            .as_str()
            .ok_or("来源版本缺失")?
            .into(),
        operation,
        control.clone(),
    )
    .await?;
    control.check()?;
    if plan["status"] != "planned" || plan["revision"] != context["sourceRevision"] {
        return Err("归档方案尚未就绪或来源已变化".into());
    }
    if crate::x_bookmarks::library::conversion::agent_connection_fingerprint(app, target)?
        != connection
    {
        return Err("归档连接已变化".into());
    }
    let id = format!("action-{}", crate::random_url_safe(18));
    plan["agentActionId"] = json!(id);
    plan["agentWorkId"] = json!(w.id);
    let payload = json!({"libraryId":target,"targetName":context["target"]["name"],"sourceTitle":context["source"]["title"],
        "connectionFingerprint":connection,"plan":plan,"instruction":instruction,"baseActionId":base,"originRunId":run});
    store::write(&root, |c| {
        if digest(&archive::context_on(&root, c, w, &args)?) != digest(&context) {
            return Err("归档材料已变化".into());
        }
        admit(c, w, run, &id, "archiveCopy", &context, &payload, None)?;
        control.check()
    })?;
    inspect(&root, w, &id)
}
