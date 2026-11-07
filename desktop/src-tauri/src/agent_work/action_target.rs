//! A user-selected write destination is distinct from the conversation's entry source.
use super::*;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Selection {
    target: Option<EvidenceLocator>,
    authorization_version: i64,
}

pub(super) fn load_on(
    c: &Connection,
    id: &str,
    authorization: i64,
) -> Result<(Option<EvidenceLocator>, Option<String>), String> {
    let raw: Option<(String,String)> = c.query_row("SELECT id,body_json FROM agent_records WHERE work_id=?1 AND kind='actionTarget' ORDER BY rowid DESC LIMIT 1", [id], |r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e|e.to_string())?;
    let Some((identity, raw)) = raw else {
        return Ok((None, None));
    };
    if raw.len() > 4096 {
        return Err("保存目标记录过大".into());
    }
    let selection: Selection = serde_json::from_str(&raw).map_err(|_| "保存目标记录损坏")?;
    if selection.authorization_version != authorization {
        return Ok((None, None));
    }
    if selection
        .target
        .as_ref()
        .is_some_and(|target| !matches!(target, EvidenceLocator::Note { page_id: None, .. }))
    {
        return Err("保存目标不是整篇笔记".into());
    }
    Ok((selection.target, Some(identity)))
}

pub(super) fn options_on(c: &Connection, w: &Work) -> Result<Vec<Value>, String> {
    let mut targets = Vec::new();
    if w.anchor.is_some() || w.state == "revoked" {
        return Ok(targets);
    }
    for note in &w.grant.notes {
        let EvidenceLocator::Note {
            library_id,
            document_id,
            page_id: None,
        } = note
        else {
            continue;
        };
        let row: Option<(String,String)> = c.query_row("SELECT d.title,l.name FROM documents d JOIN libraries l ON l.id=d.space_id WHERE d.space_id=?1 AND d.id=?2 AND d.provider='obsidian' AND l.provider='obsidian' AND l.enabled=1",params![library_id,document_id],|r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e|e.to_string())?;
        if let (Some((title, library)), Ok((_, _, path))) =
            (row, crate::obsidian_edit::path(c, library_id, document_id))
        {
            targets.push(json!({"locator":note,"title":title,"libraryName":library,"path":path}));
        }
    }
    Ok(targets)
}

pub(super) fn select(root: &Path, args: &Value) -> Result<Value, String> {
    let id = text(args, "id", 150)?;
    if args.get("target").is_none() {
        return Err("请选择保存目标或明确清除目标".into());
    }
    let target: Option<EvidenceLocator> =
        serde_json::from_value(args["target"].clone()).map_err(|_| "保存目标无效")?;
    let map = active().lock().map_err(|_| "对话运行状态不可用")?;
    if map.contains_key(&(root_key(root), id.clone())) {
        return Err("请等待当前一轮或动作结束".into());
    }
    store::write(root, |c| {
        let w = store::load(c, &id)?;
        if w.anchor.is_some() {
            return Err("来源对话沿用其明确目标，不能通过此入口更换".into());
        }
        if w.state == "revoked"
            || store::lifecycle::held(&w.state)
            || w.active_run.is_some()
            || args["expectedRevision"].as_i64() != Some(w.revision)
            || args["expectedAuthorizationVersion"].as_i64() != Some(w.authorization_version)
        {
            return Err("对话或授权已变化，请刷新后选择保存目标".into());
        }
        let pending: bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_actions WHERE work_id=?1 AND state IN ('preparing','executing','saved','needs_review','unknown'))",[&id],|r|r.get(0)).map_err(|e|e.to_string())?;
        if pending {
            return Err("已有动作结果待核对，请先核对后再更换保存目标".into());
        }
        if let Some(note) = &target {
            if !options_on(c, &w)?
                .iter()
                .any(|v| v["locator"] == json!(note))
                || !w.grant.contains(note)
            {
                return Err("保存目标必须是当前明确授权的整篇 Obsidian 笔记".into());
            }
            w.grant.reader(root)?.read(note, 0, 1, None)?;
        }
        if target == w.action_target {
            return Ok(());
        }
        let authorization = w.authorization_version;
        store::insert(
            c,
            &id,
            None,
            "actionTarget",
            &json!(Selection {
                target,
                authorization_version: authorization
            }),
        )?;
        c.execute(
            "UPDATE agent_works SET updated_at=?2 WHERE id=?1",
            params![id, store::stamp()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })?;
    drop(map);
    status(root, &id)
}
