//! Durable composer outbox. Queue delivery is separate from native steering.
use super::*;

fn rows(c: &Connection, id: &str) -> Result<Vec<Value>, String> {
    let mut values = records_on(c, id, "followup", 256)?;
    values.reverse();
    Ok(values)
}
fn put(c: &Connection, id: &str, value: &Value) -> Result<(), String> {
    c.execute("UPDATE agent_records SET body_json=?3,created_at=?4 WHERE work_id=?1 AND kind='followup' AND json_extract(body_json,'$.clientMessageId')=?2",params![id,value["clientMessageId"].as_str().ok_or("消息身份缺失")?,encode(value)?,stamp()]).map_err(|e|e.to_string())?;
    Ok(())
}
fn payload(root: &Path, c: &Connection, work: &Work, args: &Value) -> Result<Value, String> {
    let content = args["text"].as_str().unwrap_or("").trim();
    if content.chars().count() > 4000 {
        return Err("补充内容超过4000字符".into());
    }
    let notes = materials::additions(args)?;
    let images = images::selection(args, "addImages")?;
    if content.is_empty() && notes.is_empty() && images.is_empty() {
        return Err("请输入内容或添加附件".into());
    }
    if args.get("setLibraryIds").is_some()
        || !materials::removals(args)?.is_empty()
        || !images::selection(args, "removeImages")?.is_empty()
    {
        return Err("运行中补充仅添加明确材料；撤回或调整整库范围请在本轮结束后操作".into());
    }
    let notes = notes
        .into_iter()
        .filter(|n| !work.grant.contains(n))
        .collect::<Vec<_>>();
    let mut versions = Vec::new();
    if !notes.is_empty() || !images.is_empty() {
        let mut grant = materials::extend(root, c, work, &notes, &[])?;
        images::extend(root, c, &mut grant, &images, &[])?;
        for note in &notes {
            let excerpt = grant.reader(root)?.read(note, 0, 1, None)?;
            versions.push(json!({"locator":note,"version":excerpt.version}));
        }
    }
    Ok(
        json!({"text":content,"addNotes":notes.iter().filter(|n|matches!(n,EvidenceLocator::Note{..})).collect::<Vec<_>>(),"addSources":notes.iter().filter(|n|!matches!(n,EvidenceLocator::Note{..})).collect::<Vec<_>>(),"addImages":images,"versions":versions}),
    )
}
fn validate_materials(
    root: &Path,
    c: &Connection,
    work: &Work,
    data: &Value,
) -> Result<(), String> {
    if materials::additions(data)?.is_empty() && images::selection(data, "addImages")?.is_empty() {
        return Ok(());
    }
    let notes = materials::additions(data)?
        .into_iter()
        .filter(|n| !work.grant.contains(n))
        .collect::<Vec<_>>();
    let mut grant = materials::extend(root, c, work, &notes, &[])?;
    let new_images = images::selection(data, "addImages")?
        .into_iter()
        .filter(|g| !work.grant.images.contains(g))
        .collect::<Vec<_>>();
    images::extend(root, c, &mut grant, &new_images, &[])?;
    for version in data["versions"].as_array().into_iter().flatten() {
        let locator: EvidenceLocator =
            serde_json::from_value(version["locator"].clone()).map_err(|_| "资料身份损坏")?;
        let expected: crate::source_evidence::EvidenceVersion =
            serde_json::from_value(version["version"].clone()).map_err(|_| "资料版本损坏")?;
        grant.reader(root)?.read(&locator, 0, 1, Some(&expected))?;
    }
    images::verify(root, c, &images::selection(data, "addImages")?)
}
fn normalize_additions(data: &mut Value, work: &Work) -> Result<(), String> {
    let notes = materials::additions(data)?
        .into_iter()
        .filter(|n| !work.grant.contains(n))
        .collect::<Vec<_>>();
    data["addNotes"] = json!(notes
        .iter()
        .filter(|n| matches!(n, EvidenceLocator::Note { .. }))
        .collect::<Vec<_>>());
    data["addSources"] = json!(notes
        .iter()
        .filter(|n| !matches!(n, EvidenceLocator::Note { .. }))
        .collect::<Vec<_>>());
    Ok(())
}
pub(in crate::agent_work) fn save(root: &Path, args: &Value) -> Result<(), String> {
    let id = super::super::text(args, "id", 150)?;
    let key = super::super::text(args, "clientMessageId", 100)?;
    write(root, |c| {
        let work = load(c, &id)?;
        if work.state == "revoked" {
            return Err("来源授权已撤回".into());
        }
        let mode = args["deliveryMode"].as_str().unwrap_or("queue");
        if !matches!(mode, "steer" | "queue") {
            return Err("发送方式无效".into());
        }
        let existing = rows(c, &id)?;
        // Compare the original request before normalizing already-authorized attachments.
        let request = json!({"text":args["text"],"addNotes":args.get("addNotes").cloned().unwrap_or(json!([])),"addSources":args.get("addSources").cloned().unwrap_or(json!([])),"addImages":args.get("addImages").cloned().unwrap_or(json!([])),"deliveryMode":mode});
        if let Some(old) = existing.iter().find(|m| m["clientMessageId"] == key) {
            return if old["request"] == request {
                Ok(())
            } else {
                Err("消息身份与已保存内容不一致".into())
            };
        }
        if existing.len() >= 256
            || existing
                .iter()
                .filter(|m| matches!(m["state"].as_str(), Some("queued" | "held" | "failed")))
                .count()
                >= 32
        {
            return Err("待发消息已达容量，请先处理已有消息".into());
        }
        if args["expectedAuthorizationVersion"].as_i64() != Some(work.authorization_version) {
            return Err("资料授权已改变，请刷新后发送".into());
        }
        if mode == "steer"
            && args.get("expectedRunId").is_some()
            && args["expectedRunId"].as_str() != work.active_run.as_deref()
        {
            return Err("这一轮已结束或改变，请刷新后作为下一轮发送".into());
        }
        let data = payload(root, c, &work, args)?;
        let paused = matches!(
            work.state.as_str(),
            "paused" | "cancelled" | "failed" | "interrupted" | "expired"
        );
        insert(
            c,
            &id,
            None,
            "followup",
            &json!({"clientMessageId":key,"request":request,"payload":data,"deliveryMode":mode,"targetRunId":work.active_run,"authorizationVersion":work.authorization_version,"state":if paused{"held"}else{"queued"},"editVersion":1,"createdAt":stamp()}),
        )
    })
}
pub(in crate::agent_work) fn change(root: &Path, args: &Value) -> Result<(), String> {
    let id = super::super::text(args, "id", 150)?;
    write(root, |c| {
        let work = load(c, &id)?;
        if work.state == "revoked" {
            return Err("来源授权已撤回".into());
        }
        let key = super::super::text(args, "clientMessageId", 100)?;
        let mut item = rows(c, &id)?
            .into_iter()
            .find(|m| m["clientMessageId"] == key)
            .ok_or("待发消息不存在")?;
        if !matches!(item["state"].as_str(), Some("queued" | "held" | "failed")) {
            return Err("消息已经开始投递，请刷新".into());
        }
        if args["editVersion"] != item["editVersion"] {
            return Err("待发消息已改变，请刷新".into());
        }
        match args["operation"].as_str() {
            Some("cancel") => item["state"] = json!("cancelled"),
            Some("edit") => {
                item["payload"] = payload(root, c, &work, args)?;
                item["authorizationVersion"] = json!(work.authorization_version);
                if item["state"] == "failed" {
                    item["state"] = json!("held");
                }
                item.as_object_mut().unwrap().remove("error");
            }
            Some("send") => {
                if args.get("expectedRunId").is_none()
                    || args["expectedRunId"] != json!(work.active_run)
                {
                    return Err("这一轮已结束或改变，请刷新后发送".into());
                }
                if let Some(run) = work.active_run.as_deref() {
                    if !super::super::activity::can_steer_on(c, run)? {
                        return Err("当前运行不支持即时追加，消息仍按下一轮排队".into());
                    }
                }
                item["deliveryMode"] = json!("steer");
                item["state"] = json!("queued");
                item["targetRunId"] = json!(work.active_run);
            }
            _ => return Err("未知待发消息操作".into()),
        }
        item["editVersion"] = json!(item["editVersion"].as_i64().unwrap_or(1) + 1);
        put(c, &id, &item)
    })
}
pub(in crate::agent_work) fn view_on(c: &Connection, work: &Work) -> Result<Value, String> {
    if work.state == "revoked" {
        return Ok(json!([]));
    }
    let mut result = rows(c, &work.id)?;
    for item in &mut result {
        item.as_object_mut().unwrap().remove("request");
        if item["state"] == "steering" {
            let accepted:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_records WHERE work_id=?1 AND kind='steeringAccepted' AND json_extract(body_json,'$.clientMessageId')=?2)",params![work.id,item["clientMessageId"].as_str()],|r|r.get(0)).map_err(|e|e.to_string())?;
            item["state"] = json!(if accepted {
                "received"
            } else if work
                .active_run
                .as_ref()
                .is_some_and(|run| item["runId"] == *run)
            {
                "sending"
            } else {
                "unconfirmed"
            });
        }
        // A process exit never silently starts a durable queue on reopening.
        if item["state"] == "queued" && work.active_run.is_none() {
            item["state"] = json!("held");
        }
    }
    Ok(json!(result))
}
pub(in crate::agent_work) fn hold(root: &Path, id: &str) -> Result<(), String> {
    write(root, |c| {
        for mut item in rows(c, id)? {
            if item["state"] == "queued" {
                item["state"] = json!("held");
                put(c, id, &item)?;
            }
        }
        Ok(())
    })
}

// Admission and scope change commit together, at a serialized runtime callback boundary.
pub(in crate::agent_work) fn admit(
    root: &Path,
    work: &Work,
    run: &str,
) -> Result<(Work, Vec<Value>), String> {
    write(root, |c| {
        let mut current = load(c, &work.id)?;
        if current.revision != work.revision
            || current.authorization_version != work.authorization_version
            || current.active_run.as_deref() != Some(run)
        {
            return Err("调查依据或授权已改变".into());
        }
        let mut accepted = Vec::new();
        for mut item in rows(c, &work.id)?.into_iter().filter(|m| {
            m["state"] == "queued" && m["deliveryMode"] == "steer" && m["targetRunId"] == run
        }) {
            if item["authorizationVersion"].as_i64() != Some(work.authorization_version) {
                item["state"] = json!("failed");
                item["error"] = json!("授权已改变，请编辑并重新核对材料");
                put(c, &work.id, &item)?;
                continue;
            }
            let mut data = item["payload"].clone();
            if let Err(error) = validate_materials(root, c, &current, &data) {
                item["state"] = json!("failed");
                item["error"] = json!(error);
                put(c, &work.id, &item)?;
                continue;
            }
            normalize_additions(&mut data, &current)?;
            data["clientMessageId"] = item["clientMessageId"].clone();
            data["expectedRevision"] = json!(current.revision);
            if data["text"].as_str().unwrap_or("").is_empty() {
                data["text"] = json!("请查看本次补充的附件。");
            }
            let has_materials = !materials::additions(&data)?.is_empty()
                || data["addImages"].as_array().is_some_and(|a| !a.is_empty());
            if has_materials {
                c.execute(
                    "UPDATE agent_works SET active_run=NULL WHERE id=?1",
                    [&work.id],
                )
                .map_err(|e| e.to_string())?;
                conversation::message_on(root, c, &work.id, &data)?;
                c.execute("DELETE FROM agent_records WHERE work_id=?1 AND kind='userMessage' AND json_extract(body_json,'$.clientMessageId')=?2",params![work.id,data["clientMessageId"].as_str()]).map_err(|e|e.to_string())?;
                c.execute(
                    "UPDATE agent_works SET active_run=?2,state='investigating' WHERE id=?1",
                    params![work.id, run],
                )
                .map_err(|e| e.to_string())?;
                current = load(c, &work.id)?;
                c.execute(
                    "UPDATE agent_runs SET base_revision=?2,authorization_version=?3 WHERE id=?1",
                    params![run, current.revision, current.authorization_version],
                )
                .map_err(|e| e.to_string())?;
                insert(
                    c,
                    &work.id,
                    Some(run),
                    "followupScope",
                    &json!({"clientMessageId":data["clientMessageId"],"revision":current.revision,"authorizationVersion":current.authorization_version,"grant":current.grant}),
                )?;
            }
            data["runId"] = json!(run);
            data["revision"] = json!(current.revision);
            data["author"] = json!("user");
            insert(c, &work.id, Some(run), "steering", &data)?;
            item["state"] = json!("steering");
            item["runId"] = json!(run);
            put(c, &work.id, &item)?;
            accepted.push(data);
        }
        for mut later in rows(c, &work.id)? {
            if later["state"] == "queued"
                && later["authorizationVersion"].as_i64() == Some(work.authorization_version)
            {
                later["authorizationVersion"] = json!(current.authorization_version);
                put(c, &work.id, &later)?;
            }
        }
        Ok((current, accepted))
    })
}

pub(in crate::agent_work) fn resume_on(
    root: &Path,
    c: &Connection,
    id: &str,
    selected: Option<&str>,
) -> Result<(), String> {
    for mut item in rows(c, id)? {
        if item["state"] == "held" && selected.is_none_or(|key| item["clientMessageId"] == key) {
            item["state"] = json!("queued");
            put(c, id, &item)?;
        }
    }
    if !take_on(root, c, id, true, selected)? {
        return Err("队列没有可发送消息，请编辑并核对首条消息的资料与授权后重试".into());
    }
    Ok(())
}
pub(in crate::agent_work) fn take_next(root: &Path, id: &str) -> Result<bool, String> {
    write(root, |c| take_on(root, c, id, false, None))
}
pub(in crate::agent_work) fn take_explicit(
    root: &Path,
    id: &str,
    args: &Value,
) -> Result<bool, String> {
    write(root, |c| {
        let work = load(c, id)?;
        if args.get("expectedRunId").is_none() || args["expectedRunId"] != json!(work.active_run) {
            return Err("这一轮已结束或改变，请刷新后发送".into());
        }
        if work.active_run.is_some()
            || matches!(work.state.as_str(), "revoked" | "paused" | "cancelled")
        {
            return Err("当前对话不能恢复队列，请刷新".into());
        }
        let selected = args["selectedMessageId"].as_str();
        for mut item in rows(c, id)? {
            if item["state"] == "held" && selected.is_none_or(|key| item["clientMessageId"] == key)
            {
                item["state"] = json!("queued");
                put(c, id, &item)?;
            }
        }
        take_on(root, c, id, true, selected)
    })
}
fn take_on(
    root: &Path,
    c: &Connection,
    id: &str,
    explicit: bool,
    selected: Option<&str>,
) -> Result<bool, String> {
    let work = load(c, id)?;
    if work.active_run.is_some()
        || work.state == "revoked"
        || (!explicit
            && matches!(
                work.state.as_str(),
                "paused" | "cancelled" | "failed" | "interrupted" | "expired"
            ))
    {
        return Ok(false);
    }
    let Some(mut item) = rows(c, id)?
        .into_iter()
        .find(|m| m["state"] == "queued" && selected.is_none_or(|key| m["clientMessageId"] == key))
    else {
        return Ok(false);
    };
    if item["authorizationVersion"].as_i64() != Some(work.authorization_version) {
        item["state"] = json!("failed");
        item["error"] = json!("资料授权已改变，请编辑待发消息重新核对");
        put(c, id, &item)?;
        return Ok(false);
    }
    let mut data = item["payload"].clone();
    if let Err(error) = validate_materials(root, c, &work, &data) {
        item["state"] = json!("failed");
        item["error"] = json!(error);
        put(c, id, &item)?;
        return Ok(false);
    }
    normalize_additions(&mut data, &work)?;
    data["clientMessageId"] = item["clientMessageId"].clone();
    data["expectedRevision"] = json!(work.revision);
    if data["text"].as_str().unwrap_or("").is_empty() {
        data["text"] = json!("请查看本次补充的附件。");
    }
    conversation::message_on(root, c, id, &data)?;
    item["state"] = json!("saved");
    put(c, id, &item)?;
    // Explicit additions do not invalidate other messages already queued by this user.
    let updated = load(c, id)?;
    for mut later in rows(c, id)? {
        if later["state"] == "queued"
            && later["authorizationVersion"].as_i64() == Some(work.authorization_version)
        {
            later["authorizationVersion"] = json!(updated.authorization_version);
            put(c, id, &later)?;
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests;
