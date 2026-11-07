//! Conditional inverse for one verified report append. Preserve later appends;
//! refuse other edits rather than restoring an entire historical file.
use super::*;

fn previous(c: &Connection, work: &str, original: &str) -> Result<Vec<Action>, String> {
    let mut q = c.prepare("SELECT id FROM agent_actions WHERE work_id=?1 AND kind='obsidianEdit' AND json_extract(payload_json,'$.mode')='reportUndo' AND json_extract(payload_json,'$.restoresActionId')=?2 ORDER BY rowid DESC LIMIT 20").map_err(|e|e.to_string())?;
    let ids = q
        .query_map(params![work, original], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    ids.iter().map(|id| load(c, work, id)).collect()
}

pub(super) fn context_on(
    root: &Path,
    c: &Connection,
    w: &Work,
    args: &Value,
) -> Result<Value, String> {
    readable(root, w)?;
    let original = text(args, "restoresActionId", 150)?;
    let old = load(c, &w.id, &original)?;
    let p = old.payload.as_ref().ok_or("原报告追加记录缺失")?;
    let receipt = old
        .receipt
        .as_ref()
        .ok_or("原报告追加尚未核验，请先核对保存结果")?;
    if old.kind != "obsidianEdit"
        || p["mode"] != "reportAppend"
        || old.state != "verified"
        || receipt["fileVerified"] != true
        || receipt["operation"] != "appendCurrentReport"
        || receipt["operationId"] != old.id
        || receipt["reportIdentity"] != p["reportIdentity"]
    {
        return Err("只能撤回已有真实核验回执的报告追加".into());
    }
    if previous(c, &w.id, &original)?
        .iter()
        .any(|a| matches!(a.state.as_str(), "executing" | "saved" | "verified"))
    {
        return Err("已有本次追加的撤回记录，请核对已有结果，不重复撤回".into());
    }
    let base = snapshot(p)?;
    use base64::Engine;
    let raw = base64::engine::general_purpose::STANDARD
        .decode(&base.raw_base64)
        .map_err(|_| "写前副本损坏")?;
    let saved = p["after"].as_str().ok_or("原报告追加正文缺失")?;
    let identity = digest(&p["reportIdentity"]);
    let marker = format!("<!-- hub-report:{identity} -->");
    if files::hash(&raw) != base.hash
        || raw != base.before.as_bytes()
        || !saved.starts_with(&base.before)
        || saved.len() == base.before.len()
        || !saved[base.before.len()..].contains(&marker)
        || receipt["afterHash"] != files::hash(saved.as_bytes())
    {
        return Err("原报告追加副本或回执校验失败，不能自动撤回".into());
    }
    let (library, document) = anchor(w)?;
    if library != base.library_id || document != base.document_id {
        return Err("当前目标与原报告保存目标不同".into());
    }
    let current = files::snapshot(c, library, document)?;
    if current.file_identity != base.file_identity
        || current.vault != base.vault
        || current.relative_path != base.relative_path
    {
        return Err("原文件身份或位置已变化，不能自动撤回".into());
    }
    if !current.before.starts_with(saved) || current.before.matches(&marker).count() != 1 {
        return Err("原文或报告段已被修改，不能自动撤回；当前内容已保留，请人工核对".into());
    }
    let after = format!("{}{}", base.before, &current.before[saved.len()..]);
    let (_, body) = files::split(&after)?;
    if files::compose(&current, body)? != after {
        return Err("撤回会改变当前属性或换行，已停止；请人工核对".into());
    }
    Ok(
        json!({"snapshot":current,"mode":"reportUndo","restoresActionId":original,"reportIdentity":p["reportIdentity"],"after":after}),
    )
}

pub(super) fn prepare(root: &Path, args: &Value, old: &Action) -> Result<Value, String> {
    let id = text(args, "id", 150)?;
    let map = active().lock().map_err(|_| "事项状态不可用")?;
    if map.contains_key(&(root_key(root), id.clone())) {
        return Err("请先等待当前动作结束".into());
    }
    let c = crate::source_evidence::open_read_database(root)?;
    let w = store::load(&c, &id)?;
    readable(root, &w)?;
    for a in previous(&c, &id, &old.id)? {
        if matches!(a.state.as_str(), "executing" | "saved" | "verified")
            || (matches!(a.state.as_str(), "prepared" | "interrupted")
                && check_prepared(root, &c, &w, &a).is_ok())
        {
            drop(c);
            drop(map);
            return status(root, &id);
        }
    }
    drop(c);
    drop(map);
    let request = json!({"mode":"reportUndo","restoresActionId":old.id});
    let (w, action, mut context, control, running) =
        begin_preparation(root, &id, "obsidianEdit", args, |c, w| {
            super::context_on(root, c, w, &request)
        })?;
    context["instruction"] = json!("只撤回所选报告追加，保留原文与后续新增正文");
    context["linkTargets"] = json!([]);
    context["summary"] =
        json!("只移除这次保存的报告段，保留原文、属性和报告后新增的正文；请比较完整文件后确认。");
    context["warnings"] = json!([
        "这是独立撤回动作，原保存回执保留。",
        "原文或报告段变化将停止撤回；不自动合并或恢复整篇旧快照。"
    ]);
    let result = publish_payload(root, &w, &action, &context, &control);
    if let Err(e) = &result {
        fail_preparation(root, &action, e)?;
    }
    drop(running);
    result?;
    status(root, &id)
}

// A read-only view of an expired undo. Never rebase a frozen proposal or turn
// viewing a conflict into a write; the existing preparation service owns that.
pub(super) fn conflict_view(root: &Path, w: &Work, a: &Action, v: &mut Value) {
    let Some(p) = &a.payload else { return };
    if p["mode"] != "reportUndo" || v["state"] != "expired" {
        return;
    }
    v["confirmationToken"] = Value::Null;
    let result: Result<Value, String> = (|| {
        readable(root, w)?;
        let base = snapshot(p)?;
        let (library, document) = anchor(w)?;
        if library != base.library_id || document != base.document_id {
            return Err("当前目标与旧草稿不同，未读取其它文件".into());
        }
        let c = crate::source_evidence::open_read_database(root)?;
        let current = files::snapshot(&c, library, document)?;
        if current.file_identity != base.file_identity
            || current.vault != base.vault
            || current.relative_path != base.relative_path
        {
            return Err("原文件身份或位置已变化，不能自动重新预览；请核对目标".into());
        }
        if !current.utf8 {
            return Err("当前文件不是有效 UTF-8，不能自动重新预览".into());
        }
        let permitted = check_preparation(&c, w).and_then(|_| context_on(root, &c, w, p));
        let (reprepare, reason) = match permitted {
            Ok(_) if w.active_run.is_none() => (p["restoresActionId"].clone(), Value::Null),
            Ok(_) => (Value::Null, json!("请先等待当前事项结束，再重新预览")),
            Err(reason) => (Value::Null, json!(reason)),
        };
        Ok(json!({"current":current.before,"baseHash":base.hash,
            "currentHash":current.hash,"proposedHash":files::hash(p["after"].as_str().ok_or("旧草稿正文缺失")?.as_bytes()),
            "checkedAt":stamp(),"reprepareActionId":reprepare,"unavailableReason":reason}))
    })();
    v["conflict"] = match result {
        Ok(value) => value,
        Err(reason) => json!({"unavailableReason":reason,"reprepareActionId":null}),
    };
}
