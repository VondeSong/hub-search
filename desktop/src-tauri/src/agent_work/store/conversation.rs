//! Conversation requests remain distinct from confirmed decisions. Replies are
//! read through the same version checks as other durable deliveries.
use super::*;

pub(in crate::agent_work) fn steer(root: &Path, id: &str, value: &Value) -> Result<(), String> {
    write(root, |c| steer_on(c, id, value))
}

pub(super) fn steer_on(c: &Connection, id: &str, value: &Value) -> Result<(), String> {
    let content = super::super::text(value, "text", 4000)?;
    let client_id = super::super::text(value, "clientMessageId", 100)?;
    let run = super::super::text(value, "runId", 150)?;
    let work = load(c, id)?;
    if work.state == "revoked" {
        return Err("来源授权已撤回".into());
    }
    let saved = records_on(c, id, "steering", 64)?;
    if let Some(old) = saved.iter().find(|m| m["clientMessageId"] == client_id) {
        return if old["text"] == content && old["runId"] == run {
            Ok(())
        } else {
            Err("追加消息身份与已保存内容不一致".into())
        };
    }
    if work.active_run.as_deref() != Some(&run) || work.state != "investigating" {
        return Err("这一轮已结束，请作为新的追问发送".into());
    }
    let native: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_records WHERE run_id=?1 AND kind='nativeRuntime')",
            [&run],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !native {
        return Err("当前模型接入尚不支持运行中追加，请停止后发送".into());
    }
    if saved.len() >= 32 {
        return Err("追加要求已达本对话容量，请完成后新建对话".into());
    }
    insert(
        c,
        id,
        Some(&run),
        "steering",
        &json!({"text":content,"clientMessageId":client_id,"runId":run,"revision":work.revision,"author":"user"}),
    )
}

pub(in crate::agent_work) fn message(root: &Path, id: &str, value: &Value) -> Result<(), String> {
    write(root, |c| message_on(root, c, id, value))
}

pub(in crate::agent_work) fn message_on(
    root: &Path,
    c: &Connection,
    id: &str,
    value: &Value,
) -> Result<(), String> {
    let content = super::super::text(value, "text", 4000)?;
    let client_id = super::super::text(value, "clientMessageId", 100)?;
    let additions = super::materials::additions(value)?;
    let removals = super::materials::removals(value)?;
    let library_ids = value
        .get("setLibraryIds")
        .map(|v| {
            let ids: Vec<String> =
                serde_json::from_value(v.clone()).map_err(|_| "资料库范围必须是列表")?;
            EvidenceScope::new(ids, vec![]).map(|scope| scope.whole_libraries().to_vec())
        })
        .transpose()?;
    let add_images = images::selection(value, "addImages")?;
    let remove_images = images::selection(value, "removeImages")?;
    let initial_request = value["initialRequest"] == true;
    let work = load(c, id)?;
    if work.state == "revoked" {
        return Err("该对话的来源授权已撤回".into());
    }
    let previous:Option<String>=c.query_row("SELECT body_json FROM agent_records WHERE work_id=?1 AND kind='userMessage' AND json_extract(body_json,'$.clientMessageId')=?2 ORDER BY rowid LIMIT 1",params![id,client_id],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    if let Some(previous) = previous {
        let previous: Value = serde_json::from_str(&previous).map_err(|_| "已保存消息身份损坏")?;
        return if previous["text"] == content
            && previous.get("addNotes").cloned().unwrap_or(json!([])) == json!(additions)
            && previous.get("removeNotes").cloned().unwrap_or(json!([])) == json!(removals)
            && previous.get("addImages").cloned().unwrap_or(json!([])) == json!(add_images)
            && previous.get("removeImages").cloned().unwrap_or(json!([])) == json!(remove_images)
            && (previous["initialRequest"] == true) == initial_request
            && previous
                .get("setLibraryIds")
                .cloned()
                .unwrap_or(Value::Null)
                == json!(library_ids)
        {
            Ok(())
        } else {
            Err("消息身份与已保存内容不一致".into())
        };
    }
    if work.active_run.is_some() {
        return Err("请先停止当前一轮，再发送新的要求".into());
    }
    if value["expectedRevision"]
        .as_i64()
        .is_some_and(|revision| revision != work.revision)
    {
        return Err("对话已在其他位置更新，请刷新后再发送".into());
    }
    if initial_request {
        let has_history: bool = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_records WHERE work_id=?1 AND kind='userMessage') OR EXISTS(SELECT 1 FROM agent_runs WHERE work_id=?1)",
            [id], |r| r.get(0),
        ).map_err(|e|e.to_string())?;
        if has_history
            || work.anchor.is_some()
            || work.revision != 1
            || content != work.goal
            || (library_ids.is_none() && additions.is_empty() && add_images.is_empty())
            || !removals.is_empty()
            || !remove_images.is_empty()
        {
            return Err("初次资料范围绑定不能替代已有对话或改变问题".into());
        }
    }
    let count: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM agent_records WHERE work_id=?1 AND kind='userMessage'",
            [id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if count >= 32 && !super::trace_budget::managed_on(c, id)? {
        return Err(
            "旧对话已达32条追问保护上限；历史保留，需先核验同一事项资源与预算，不能新建事项绕过"
                .into(),
        );
    }
    if super::goal::completion::requirements_on(c, &work)?
        .as_array()
        .map_or(true, |items| items.len() >= 128)
    {
        return Err("当前要求已达核对容量；未追加新要求，已有成果和预算保留".into());
    }
    let mut body = json!({"text":content,"author":"user","revision":work.revision+1,"clientMessageId":client_id,"addNotes":additions,"removeNotes":removals,"addImages":add_images,"removeImages":remove_images});
    body["presentation"] = crate::agent_work::skills::request_presentation(&content);
    if initial_request {
        body["initialRequest"] = json!(true);
    }
    if let Some(ids) = &library_ids {
        body["setLibraryIds"] = json!(ids);
    }
    if library_ids.is_some()
        || !additions.is_empty()
        || !removals.is_empty()
        || !add_images.is_empty()
        || !remove_images.is_empty()
    {
        if value["expectedRevision"].as_i64() != Some(work.revision) {
            return Err("追加材料需要当前事项版本，请刷新后重试".into());
        }
        let mut grant = super::materials::extend(root, c, &work, &additions, &removals)?;

        if let Some(ids) = &library_ids {
            if grant.manifest.is_some() {
                return Err("固定清单不能改为整库授权".into());
            }
            for library in ids {
                let exists: bool = c
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM libraries WHERE id=?1)",
                        [library],
                        |r| r.get(0),
                    )
                    .map_err(|e| e.to_string())?;
                if !exists {
                    return Err("资料库已不存在，请刷新范围".into());
                }
            }
            grant.library_ids = ids.clone();
            grant.attachment_library_ids = ids.clone();
            // Narrowing whole-library access must retain the explicit conversation anchor.
            if let Some(anchor) = &work.anchor {
                if !grant.contains(anchor) {
                    match anchor {
                        EvidenceLocator::Note { .. } => grant.notes.push(anchor.clone()),
                        _ => grant.sources.push(anchor.clone()),
                    }
                }
            }
            grant.scope()?;
        }
        images::extend(root, c, &mut grant, &add_images, &remove_images)?;
        let image_scope_changed = grant.images != work.grant.images;
        if image_scope_changed
            || library_ids.is_some()
            || !additions.is_empty()
            || !removals.is_empty()
        {
            body["scopeBefore"] = json!(work.grant);
            body["authorizationVersion"] = json!(work.authorization_version);
            body["scopeAfter"] = json!(grant);
            c.execute("UPDATE agent_works SET grant_json=?2,authorization_version=authorization_version+CASE WHEN anchor_json='null' OR ?3 THEN 1 ELSE 0 END WHERE id=?1", params![id,encode(&grant)?,library_ids.is_some() || image_scope_changed]).map_err(|e|e.to_string())?;
        }
    }
    insert(c, id, None, "userMessage", &body)?;
    c.execute("UPDATE agent_works SET revision=revision+1,state=CASE WHEN state IN ('paused','cancelled') THEN state ELSE 'ready' END,active_run=NULL,report_json=NULL,updated_at=?2 WHERE id=?1", params![id,stamp()]).map_err(|e|e.to_string())?;
    super::super::watch::pause_on(c, id, "已收到新的要求，自动复查已暂停")?;
    Ok(())
}

pub(in crate::agent_work) fn read_on(
    root: &Path,
    c: &Connection,
    work: &Work,
) -> Result<Value, String> {
    let mut delivery_reads = super::delivery_read::DeliveryRead::new(root, c, work);
    read_on_cached(c, work, &mut delivery_reads)
}

pub(super) fn read_on_cached(
    c: &Connection,
    work: &Work,
    delivery_reads: &mut super::delivery_read::DeliveryRead<'_>,
) -> Result<Value, String> {
    page_on_cached(c, work, delivery_reads, None)
}

pub(in crate::agent_work) fn page(root: &Path, args: &Value) -> Result<Value, String> {
    let id = super::super::text(args, "id", 150)?;
    let before = super::super::text(args, "before", 150)?;
    let permit = crate::library_runtime::cached_read_permit(root)?;
    let c = read(root)?;
    c.execute_batch("BEGIN DEFERRED")
        .map_err(|e| e.to_string())?;
    let work = load(&c, &id)?;
    if work.state == "revoked" {
        return Err("来源授权已撤回，不能读取历史正文".into());
    }
    if args["expectedRevision"].as_i64() != Some(work.revision)
        || args["expectedAuthorizationVersion"].as_i64() != Some(work.authorization_version)
    {
        return Err("事项或授权已更新，请刷新后重新查看历史".into());
    }
    let mut delivery_reads = super::delivery_read::DeliveryRead::new(root, &c, &work);
    let conversation = page_on_cached(&c, &work, &mut delivery_reads, Some(&before))?;
    c.execute_batch("COMMIT").map_err(|e| e.to_string())?;
    permit.checkpoint()?;
    Ok(
        json!({"workId":work.id,"workRevision":work.revision,"authorizationVersion":work.authorization_version,"conversation":conversation,"sourceFreshness":"notVerifiedWithRemote"}),
    )
}

pub(in crate::agent_work) fn is_scope_confirmation(kind: &str, body: &Value) -> bool {
    kind == "userMessage"
        && (body["scopeOnly"] == true
            || (body["clientMessageId"]
                .as_str()
                .is_some_and(|id| id.starts_with("scope-"))
                && body["text"] == "已明确更新下一轮资料范围，历史与累计用量保留。"
                && body["scopeBefore"].is_object()
                && body["scopeAfter"].is_object()))
}

fn page_on_cached(
    c: &Connection,
    work: &Work,
    delivery_reads: &mut super::delivery_read::DeliveryRead<'_>,
    before: Option<&str>,
) -> Result<Value, String> {
    if work.state == "revoked" {
        return Ok(json!({"messages":[],"hasEarlier":false}));
    }
    let before_row=before.map(|id| c.query_row("SELECT rowid FROM agent_records WHERE work_id=?1 AND id=?2 AND kind IN ('userMessage','userDecision','steering','delivery')",params![work.id,id],|r|r.get::<_,i64>(0)).map_err(|_|"历史定位已失效或不属于当前事项".to_string())).transpose()?;
    let mut query = c.prepare("SELECT r.id,r.kind,r.body_json,r.created_at,r.run_id,u.authorization_version,u.base_revision FROM agent_records r LEFT JOIN agent_runs u ON u.id=r.run_id WHERE r.work_id=?1 AND r.kind IN ('userMessage','userDecision','steering','delivery') AND (?2 IS NULL OR r.rowid<?2) ORDER BY r.rowid DESC LIMIT 65").map_err(|e|e.to_string())?;
    let mut rows = query
        .query_map(params![work.id, before_row], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<i64>>(5)?,
                r.get::<_, Option<i64>>(6)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let has_earlier = rows.len() > 64;
    rows.truncate(64);
    let next_cursor = has_earlier.then(|| rows.last().unwrap().0.clone());
    rows.reverse();
    let created_at: i64 = c.query_row("SELECT COALESCE(json_extract(body_json,'$.createdAt'),0) FROM agent_records WHERE work_id=?1 AND kind='conversationCreated' ORDER BY rowid LIMIT 1", [&work.id], |r| r.get(0)).optional().map_err(|e|e.to_string())?.unwrap_or(0);
    let initial_presentation: Option<String> = c.query_row("SELECT json_extract(body_json,'$.presentation') FROM agent_records WHERE work_id=?1 AND kind='conversationCreated' ORDER BY rowid LIMIT 1",[&work.id],|r|r.get(0)).optional().map_err(|e|e.to_string())?.flatten();
    let initial_presentation = initial_presentation
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(|| crate::agent_work::skills::request_presentation(&work.goal));
    let has_initial_request: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_records WHERE work_id=?1 AND kind='userMessage' AND json_extract(body_json,'$.initialRequest')=1)",
        [&work.id], |r|r.get(0),
    ).map_err(|e|e.to_string())?;
    let mut messages = if has_initial_request {
        Vec::new()
    } else {
        let original_scope = super::materials::grant_at(c, work, 1).ok();
        let initial_materials = original_scope
            .as_ref()
            .map(|grant| {
                super::materials::message_cards(
                    delivery_reads.root(),
                    c,
                    work,
                    &super::materials::explicit_locators(grant),
                )
            })
            .unwrap_or(json!([]));
        let recorded_images: Option<String> = c.query_row(
            "SELECT json_extract(body_json,'$.images') FROM agent_records WHERE work_id=?1 AND kind='conversationCreated' ORDER BY rowid LIMIT 1",
            [&work.id], |r| r.get(0),
        ).optional().map_err(|e|e.to_string())?.flatten();
        let mut initial_images: Vec<images::ImageGrant> = match recorded_images {
            Some(raw) => serde_json::from_str(&raw).map_err(|_| "初始图片记录损坏")?,
            None if work.revision == 1 => work.grant.images.clone(),
            None => {
                // Older conversations did not store the creation-time image list.
                let previous: Option<String> = c.query_row(
                    "SELECT json_extract(body_json,'$.scopeBefore.images') FROM agent_records WHERE work_id=?1 AND kind='userMessage' AND json_type(body_json,'$.scopeBefore')='object' ORDER BY rowid LIMIT 1",
                    [&work.id], |r| r.get(0),
                ).optional().map_err(|e|e.to_string())?.flatten();
                previous
                    .and_then(|raw| serde_json::from_str(&raw).ok())
                    .unwrap_or_default()
            }
        };
        initial_images.retain(|grant| work.grant.images.contains(grant));
        vec![
            json!({"id":format!("{}-goal",work.id),"role":"user","text":work.goal,"displayText":initial_presentation["text"],"skills":initial_presentation["skills"],"createdAt":created_at,"revision":1,"kind":"request","materials":initial_materials,"images":initial_images}),
        ]
    };
    for (id, kind, raw, created_at, run_id, authorization, revision) in rows {
        let body: Value = serde_json::from_str(&raw).map_err(|_| "对话记录损坏")?;
        if kind != "delivery" {
            if !super::super::insights::review::material_message_visible(c, work, &body)? {
                continue;
            }
            if kind == "steering" && authorization != Some(work.authorization_version) {
                continue;
            }
            let scope_only = is_scope_confirmation(&kind, &body);
            let attachments: Vec<EvidenceLocator> =
                serde_json::from_value(body.get("addNotes").cloned().unwrap_or(json!([])))
                    .map_err(|_| "对话资料身份损坏")?;
            let materials =
                super::materials::message_cards(delivery_reads.root(), c, work, &attachments);
            let presentation = body.get("presentation").cloned().unwrap_or_else(|| {
                crate::agent_work::skills::request_presentation(body["text"].as_str().unwrap_or(""))
            });
            let mut attached_images = images::selection(&body, "addImages")?;
            attached_images.retain(|grant| work.grant.images.contains(grant));
            messages.push(json!({"id":id,"role":"user","text":body["text"],"displayText":presentation["text"],"skills":presentation["skills"],"createdAt":created_at,"revision":body["revision"],"kind":if scope_only {"scope"} else if kind=="userDecision" {"decision"} else {"request"},"materials":materials,"images":attached_images}));
            continue;
        }
        let verified = (|| {
            let run = run_id.as_deref().ok_or("回答运行身份缺失")?;
            delivery_reads.verify(work, run, &body, authorization.unwrap_or(-1))
        })();
        let (report, evidence, validity, artifact_refs, artifact_state) = match verified {
            Ok((excerpts, projection)) => (
                body["report"].clone(),
                excerpts,
                if projection["state"] == "stale" {
                    projection["reason"]
                        .as_str()
                        .unwrap_or("图表已修订，回答需重新核对")
                        .to_owned()
                } else if revision != Some(work.revision) {
                    "这是当时的回答，后续要求已更新".to_owned()
                } else {
                    String::new()
                },
                projection["references"].clone(),
                projection["state"].clone(),
            ),
            Err(reason) => (
                Value::Null,
                Vec::new(),
                format!("{reason}；历史正文已隐藏"),
                json!([]),
                json!("unavailable"),
            ),
        };
        messages.push(json!({"id":id,"role":"assistant","runId":run_id,"createdAt":created_at,"revision":revision,"report":report,"evidence":evidence,"validity":validity,"artifactRefs":artifact_refs,"artifactState":artifact_state}));
    }
    Ok(json!({"messages":messages,"hasEarlier":has_earlier,"nextCursor":next_cursor}))
}

/// Bounded, current-authorization history access, including exact old delivery text.
pub(in crate::agent_work) fn history(
    root: &Path,
    work: &Work,
    before: Option<&str>,
    record_id: Option<&str>,
    start: usize,
    max: usize,
) -> Result<Value, String> {
    if max == 0 || max > 6000 {
        return Err("历史读取范围须为1至6000字符".into());
    }
    let permit = crate::library_runtime::cached_read_permit(root)?;
    let c = read(root)?;
    c.execute_batch("BEGIN DEFERRED")
        .map_err(|e| e.to_string())?;
    let current = load(&c, &work.id)?;
    if current.state == "revoked"
        || current.revision != work.revision
        || current.authorization_version != work.authorization_version
    {
        return Err("事项或来源授权已变化，请刷新".into());
    }
    let mut reads = super::delivery_read::DeliveryRead::new(root, &c, &current);
    let following = if let Some(id) = record_id.filter(|id| *id != format!("{}-goal", work.id)) {
        let row:i64=c.query_row("SELECT rowid FROM agent_records WHERE work_id=?1 AND id=?2 AND kind IN ('userMessage','userDecision','steering','delivery')",params![work.id,id],|r|r.get(0)).map_err(|_|"历史记录不属于当前事项")?;
        c.query_row("SELECT id FROM agent_records WHERE work_id=?1 AND rowid>?2 AND kind IN ('userMessage','userDecision','steering','delivery') ORDER BY rowid LIMIT 1",params![work.id,row],|r|r.get::<_,String>(0)).optional().map_err(|e|e.to_string())?
    } else {
        None
    };
    let page = page_on_cached(
        &c,
        &current,
        &mut reads,
        if record_id.is_some() {
            following.as_deref()
        } else {
            before
        },
    )?;
    let mut value = if let Some(id) = record_id {
        page["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == id)
            .cloned()
            .ok_or("该历史消息当前不可见")?
    } else {
        page.clone()
    };
    if super::super::options::load_on(&c, &work.id)?.materials_only() {
        if let Some(messages) = value["messages"].as_array_mut() {
            for message in messages {
                restrict_model_history(message);
            }
        } else {
            restrict_model_history(&mut value);
        }
    }
    let text = serde_json::to_string(&value).map_err(|e| e.to_string())?;
    let total = text.chars().count();
    if start > total {
        return Err("历史字符起点超出范围".into());
    }
    c.execute_batch("COMMIT").map_err(|e| e.to_string())?;
    permit.checkpoint()?;
    Ok(
        json!({"content":text.chars().skip(start).take(max).collect::<String>(),"startChar":start,"endChar":(start+max).min(total),"totalChars":total,"truncated":start+max<total,"nextCursor":page["nextCursor"],"hasEarlier":page["hasEarlier"],"sourceKind":"conversationHistory","policy":"这是历史材料；旧答复不能证明当前来源有效或业务操作完成。"}),
    )
}

#[cfg(test)]
mod paging_tests;

fn restrict_model_history(message: &mut Value) {
    if message["role"] == "assistant" {
        *message = json!({"id":message["id"],"role":"assistant","kind":message["kind"],"notice":"仅依据材料：历史回答只保留身份，不提供旧事实；请读取当前授权原文。"});
    }
}

pub(in crate::agent_work) fn context(root: &Path, work: &Work) -> Result<Value, String> {
    context_with_images(root, work).map(|(context, _)| context)
}

pub(in crate::agent_work) fn context_with_images(
    root: &Path,
    work: &Work,
) -> Result<(Value, Vec<images::ImageGrant>), String> {
    super::tasks::refresh(root, &work.id)?;
    let c = read(root)?;
    c.execute_batch("BEGIN DEFERRED")
        .map_err(|e| e.to_string())?;
    let current = load(&c, &work.id)?;
    if current.revision != work.revision
        || current.authorization_version != work.authorization_version
    {
        return Err("对话或来源授权已改变".into());
    }
    let conversation = read_on(root, &c, work)?;
    let materials_only = super::super::options::load_on(&c, &work.id)?.materials_only();
    let mut messages = Vec::new();
    let mut bytes = 0;
    let mut omitted = conversation["hasEarlier"] == true;
    for message in conversation["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .rev()
    {
        if message["kind"] == "scope" {
            continue;
        }
        if materials_only && message["role"] != "user" {
            continue;
        }
        let mut item = if message["role"] == "user" {
            json!({"role":"user","kind":message["kind"],"text":message["text"],"materials":message["materials"]})
        } else if message["report"].is_object()
            && message["artifactRefs"]
                .as_array()
                .is_some_and(|refs| !refs.is_empty())
        {
            // A rebuilt model context must read charts explicitly before reusing numbers.
            // Preserve identity and the reason for staleness, not old statistical prose.
            json!({"role":"assistant","artifactRefs":message["artifactRefs"],"artifactState":message["artifactState"],"validity":message["validity"],
                "summary":"这条历史回答依赖图表。请先调用 chart read 读取所需版本；当前结论须采用最新版本并核对，不能直接复用旧数值。"})
        } else if message["report"].is_object() {
            // Old eN identities must never become current evidence citations.
            json!({"role":"assistant","summary":message["report"]["summary"],"findings":message["report"]["findings"].as_array().map(|items|items.iter().map(|v|v["text"].clone()).collect::<Vec<_>>()),"nextSteps":message["report"]["nextSteps"].as_array().map(|items|items.iter().map(|v|json!({"action":v["action"],"reason":v["reason"]})).collect::<Vec<_>>()),"questions":message["report"]["questions"],"limitations":message["report"]["limitations"]})
        } else {
            continue;
        };
        if work.anchor.is_none() && message["report"]["prose"]["markdown"].is_string() {
            item["text"] = message["report"]["prose"]["markdown"].clone();
            if item["summary"] == item["text"] {
                item.as_object_mut().unwrap().remove("summary");
            }
        }
        item["recordId"] = message["id"].clone();
        if item.to_string().len() > 5000 {
            let content = item["text"]
                .as_str()
                .or_else(|| item["summary"].as_str())
                .unwrap_or("");
            item = json!({"role":item["role"],"kind":item["kind"],"recordId":message["id"],"text":content.chars().take(1000).collect::<String>(),"contentTruncated":true,"notice":"历史片段已缩短；需要完整内容时调用 conversationHistory，以 recordId 和字符范围读取。"});
            omitted = true;
        }
        let size = item.to_string().len();
        if bytes + size > 16000 {
            omitted = true;
            break;
        }
        bytes += size;
        messages.push(item);
    }
    messages.reverse();
    let latest_request = conversation["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .rev()
        .find(|m| m["role"] == "user" && m["kind"] != "scope");
    let request = latest_request
        .and_then(|m| m["text"].as_str())
        .unwrap_or(&work.goal);
    let mut request_materials = latest_request
        .map(|m| m["materials"].clone())
        .unwrap_or(json!([]));
    let request_images = latest_request
        .map(|message| images::selection(message, "images"))
        .transpose()?
        .unwrap_or_default();
    let request = if super::materials::skill_only(request) {
        if request_materials
            .as_array()
            .is_none_or(|items| items.is_empty())
        {
            request_materials = super::materials::message_cards(
                root,
                &c,
                &current,
                &super::materials::explicit_locators(&current.grant),
            );
        }
        if request_materials
            .as_array()
            .is_none_or(|items| !items.iter().any(|item| item["available"] == true))
            && request_images.is_empty()
        {
            format!("{request}\n本轮未附带页面或原图。若当前另有明确的任务对象（如已选择的标签），按该对象处理；否则先请用户补充本轮要处理的内容，不要重复以前不同输入的成稿。")
        } else {
            format!("{request}\n请使用上述技能处理本轮明确附带的资料（见 currentRequestMaterials、hostSelectedRead 与 originalImages）；以这些资料为处理对象，保留原记录的日期、事实与不确定性。历史回答仅作对话背景，不能直接作为本轮成稿。资料超出已读取部分时按需补读，不把整理当天当作原记录的发生日期。")
        }
    } else {
        request.to_owned()
    };
    let mut context = json!({"currentRequest":request,"currentRequestMaterials":request_materials,"goalState":super::goal::completion::context_on(root,&c,&current)?,"goalBinding":super::goal::binding_on(&c, &current)?,"messages":messages,"earlierMessagesOmitted":omitted,"historyCursor":conversation["nextCursor"],"handoffPolicy":"当前目标和最新修订以goalState为准；进度与问题见capabilities.workingState，保存以businessActionRecords为准。历史不完整时可调用conversationHistory按页或recordId补读；不得把摘要、助手旧回答或准备中的草稿当作完成事实。","policy":"普通用户消息是本轮要求，不自动成为确认事实或长期记忆；助手历史回答本身不是事实证据。Hub 笔记的精确编号引用只能选择本轮 quoteCatalog，并核验当前授权和版本，不能沿用历史编号。公开网页来源可复用同一原生会话中已实际读取且仍适用的内容，以具名 HTTPS 链接引用；总结、解释和启示类追问材料足够时直接回答，不为重复引用而联网。新增事实、时效变化、证据冲突、上下文缺失或用户要求复核时再查证。普通延伸追问不等于否定此前事实。"});
    super::report_continuation::context_on(root, &c, &current, &mut context)?;
    Ok((context, request_images))
}

pub(in crate::agent_work) fn source(
    root: &Path,
    id: &str,
    run: &str,
    index: usize,
    quote: &str,
) -> Result<Value, String> {
    let c = read(root)?;
    c.execute_batch("BEGIN DEFERRED")
        .map_err(|e| e.to_string())?;
    let work = load(&c, id)?;
    if work.state == "revoked" {
        return Err("来源授权已撤回".into());
    }
    let raw: String=c.query_row("SELECT r.body_json FROM agent_records r JOIN agent_runs u ON u.id=r.run_id WHERE r.work_id=?1 AND r.run_id=?2 AND r.kind='delivery' AND u.authorization_version=?3 ORDER BY r.rowid DESC LIMIT 1",params![id,run,work.authorization_version],|r|r.get(0)).map_err(|_|"引用记录不可读取")?;
    let body: Value = serde_json::from_str(&raw).map_err(|_| "引用记录损坏")?;
    let excerpts: Vec<EvidenceExcerpt> =
        serde_json::from_value(body["evidence"].clone()).map_err(|_| "引用来源损坏")?;
    let selected = excerpts.get(index).ok_or("引用编号无效")?;
    let offset = selected
        .content
        .find(quote)
        .filter(|_| !quote.is_empty())
        .ok_or("引文不属于这一来源")?;
    let start =
        (selected.start_char + selected.content[..offset].chars().count()).saturating_sub(1000);
    let reader = work.grant.reader(root)?;
    reader.verify_in_transaction(&c, std::slice::from_ref(selected))?;
    drop(c);
    let excerpt = reader.read(&selected.locator, start, 6000, Some(&selected.version))?;
    Ok(json!({"excerpt":excerpt}))
}
