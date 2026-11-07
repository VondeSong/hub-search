//! Host-only scope preview and confirmation; never exposed as a model tool.
use super::*;
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ManifestGrant {
    selection: Value,
    snapshot: String,
    pub(super) members: Vec<EvidenceLocator>,
}
fn selection(args: &Value) -> Result<Value, String> {
    let value = args.get("selection").ok_or("缺少材料范围")?;
    let object = value.as_object().ok_or("材料范围无效")?;
    if object
        .keys()
        .any(|k| !["libraryId", "directory", "dateFrom", "dateTo"].contains(&k.as_str()))
    {
        return Err("材料范围含未知字段".into());
    }
    text(value, "libraryId", 1024)?;
    Ok(value.clone())
}
fn host_reader(root: &Path, selection: &Value) -> Result<EvidenceReader, String> {
    // Host preview may enumerate the selected library's metadata. This reader
    // is never passed to a model session or saved as the Work's grant.
    Ok(EvidenceReader::new(
        root,
        EvidenceScope::new(vec![text(selection, "libraryId", 1024)?], vec![])?,
    ))
}
pub(super) fn preview(root: &Path, args: &Value) -> Result<Value, String> {
    let selected = selection(args)?;
    let reader = host_reader(root, &selected)?;
    let mut request = selected;
    if let Some(cursor) = args.get("cursor") {
        request["cursor"] = cursor.clone();
    }
    request["limit"] = json!(20);
    let mut page =
        crate::source_evidence::analysis::execute(&reader, "hub_source_manifest", &request)?;
    page["authorization"] = json!(
        "host metadata preview only; confirm the unchanged manifest to authorize its fixed members"
    );
    Ok(page)
}
fn collect(root: &Path, selected: &Value, expected: &str) -> Result<Vec<EvidenceLocator>, String> {
    if !expected.starts_with("source-manifest-v1:") {
        return Err("需要有效的预览清单身份".into());
    }
    let reader = host_reader(root, selected)?;
    let mut request = selected.clone();
    request["limit"] = json!(20);
    let mut members = Vec::new();
    loop {
        let page =
            crate::source_evidence::analysis::execute(&reader, "hub_source_manifest", &request)?;
        if page["snapshot"].as_str() != Some(expected) {
            return Err("预览清单的范围、成员或版本已变化，请重新确认".into());
        }
        for member in page["members"].as_array().ok_or("清单成员无效")? {
            let locator: EvidenceLocator = serde_json::from_value(member["locator"].clone())
                .map_err(|_| "清单成员身份无效")?;
            if members.contains(&locator) {
                return Err("清单包含重复成员".into());
            }
            members.push(locator);
        }
        if members.len() > 5000
            || serde_json::to_vec(&members)
                .map_err(|e| e.to_string())?
                .len()
                > 32768
        {
            return Err("固定材料范围超过容量上限，未截断或授权部分成员".into());
        }
        if page["nextCursor"].is_null() {
            break;
        }
        request["cursor"] = page["nextCursor"].clone();
    }
    if members.is_empty() {
        return Err("所选范围没有可授权材料".into());
    }
    Ok(members)
}
/// Resolve host metadata through the existing version-bound collector; no model grant yet.
pub(super) fn resolve(root: &Path, args: &Value) -> Result<(Grant, Value), String> {
    let selected = selection(args)?;
    let mut page = preview(root, args)?;
    let snapshot = text(&page, "snapshot", 100)?;
    let members = collect(root, &selected, &snapshot)?;
    // Existing grant verification stays byte-for-byte unchanged; only this new host preview retains metadata.
    let mut details = page["members"].as_array().ok_or("清单成员无效")?.clone();
    let mut cursor = page["nextCursor"].clone();
    while !cursor.is_null() {
        let next = preview(root, &json!({"selection":selected,"cursor":cursor}))?;
        if next["snapshot"] != snapshot {
            return Err("预览清单已变化，请重新核对".into());
        }
        details.extend(
            next["members"]
                .as_array()
                .ok_or("清单成员无效")?
                .iter()
                .cloned(),
        );
        if details.len() > members.len() {
            return Err("预览成员数量不一致".into());
        }
        cursor = next["nextCursor"].clone();
    }
    let listed = details
        .iter()
        .map(|item| {
            serde_json::from_value::<EvidenceLocator>(item["locator"].clone())
                .map_err(|_| "清单身份无效")
        })
        .collect::<Result<Vec<_>, _>>()?;
    if listed != members {
        return Err("预览成员与已核对范围不一致".into());
    }
    let grant = Grant {
        manifest: Some(ManifestGrant {
            selection: selected,
            snapshot,
            members,
        }),
        ..Default::default()
    };
    if serde_json::to_vec(&grant).map_err(|e| e.to_string())?.len() > 32768 {
        return Err("固定授权记录超过32KiB，未授权或创建事项".into());
    }
    page["members"] = json!(details);
    page["nextCursor"] = Value::Null;
    Ok((grant, page))
}
impl ManifestGrant {
    pub(super) fn verify(&self, root: &Path) -> Result<(), String> {
        if collect(root, &self.selection, &self.snapshot)? != self.members {
            return Err("固定材料成员与原清单不一致".into());
        }
        Ok(())
    }
}
pub(super) fn create(root: &Path, args: &Value) -> Result<Value, String> {
    if args.get("grant").is_some() {
        return Err("清单确认入口不接受额外授权".into());
    }
    let selected = selection(args)?;
    let expected = text(args, "expectedManifest", 100)?;
    let goal = text(args, "goal", 2000)?;
    let criteria = text(args, "successCriteria", 2000)?;
    let anchor: EvidenceLocator =
        serde_json::from_value(args["anchor"].clone()).map_err(|_| "调查对象无效")?;
    let manifest = ManifestGrant {
        members: collect(root, &selected, &expected)?,
        selection: selected,
        snapshot: expected,
    };
    let grant = Grant {
        manifest: Some(manifest),
        ..Default::default()
    };
    if serde_json::to_vec(&grant).map_err(|e| e.to_string())?.len() > 32768 {
        return Err("固定授权记录超过32KiB，未创建事项".into());
    }
    if !grant.contains(&anchor) {
        return Err("调查对象不在清单固定成员内".into());
    }
    grant.reader(root)?.read(&anchor, 0, 1, None)?;
    let id = store::create(root, goal, criteria, anchor, grant)?;
    status(root, &id)
}
#[cfg(test)]
mod tests;

/// A host-confirmed scope change stays in this Work and its existing ledgers.
pub(super) fn replace(root: &Path, args: &Value) -> Result<(), String> {
    let id = text(args, "id", 150)?;
    let client = text(args, "clientMessageId", 100)?;
    let content = text(args, "text", 1000)?;
    let selected = selection(args)?;
    let expected = text(args, "expectedManifest", 100)?;
    let prior = text(args, "expectedPreviousManifest", 100)?;
    let revision = args["expectedRevision"]
        .as_i64()
        .ok_or("需要当前事项版本")?;
    if args.get("grant").is_some() {
        return Err("清单确认入口不接受额外授权".into());
    }
    let request = json!({"selection":selected,"expectedManifest":expected,"expectedPreviousManifest":prior,"expectedRevision":revision,"text":content});
    store::write(root, |c| {
        let work = store::load(c, &id)?;
        if work.state == "revoked" {
            return Err("来源授权已撤回，不能通过清单刷新恢复".into());
        }
        let previous:Option<String>=c.query_row("SELECT body_json FROM agent_records WHERE work_id=?1 AND kind='userMessage' AND json_extract(body_json,'$.clientMessageId')=?2 ORDER BY rowid LIMIT 1",params![id,client],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        if let Some(previous) = previous {
            let saved: Value = serde_json::from_str(&previous).map_err(|_| "范围变更记录损坏")?;
            return if saved["scopeChangeRequest"] == request {
                Ok(())
            } else {
                Err("范围确认身份已用于不同内容，原记录保留".into())
            };
        }
        if work.active_run.is_some() {
            return Err("请先停止当前一轮，再重新确认材料范围".into());
        }
        let unresolved:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_actions WHERE work_id=?1 AND state IN ('executing','unknown','reconciliation_required'))",[&id],|r|r.get(0)).map_err(|e|e.to_string())?;
        if unresolved {
            return Err("业务动作结果待核对，不能变更材料范围".into());
        }
        let old = work
            .grant
            .manifest
            .as_ref()
            .ok_or("当前事项没有固定清单，不能通过刷新扩展授权")?;
        if work.revision != revision || old.snapshot != prior {
            return Err("事项版本或原清单已变化，请刷新后重新确认".into());
        }
        let count: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM agent_records WHERE work_id=?1 AND kind='userMessage'",
                [&id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if count >= 32 && !store::trace_budget::managed_on(c, &id)? {
            return Err("旧对话已达32条追问保护上限；不能通过清单刷新绕过".into());
        }
        if store::goal::completion::requirements_on(c, &work)?
            .as_array()
            .map_or(true, |v| v.len() >= 128)
        {
            return Err("当前要求已达核对容量，原范围保留".into());
        }
        let manifest = ManifestGrant {
            members: collect(root, &selected, &expected)?,
            selection: selected.clone(),
            snapshot: expected.clone(),
        };
        let grant = Grant {
            manifest: Some(manifest),
            ..Default::default()
        };
        if serde_json::to_vec(&grant).map_err(|e| e.to_string())?.len() > 32768 {
            return Err("固定授权记录超过32KiB，原范围保留".into());
        }
        if !work
            .anchor
            .as_ref()
            .is_some_and(|anchor| grant.contains(anchor))
        {
            return Err("新范围不包含当前锚点，原范围保留".into());
        }
        let body = json!({"text":content,"author":"user","revision":work.revision+1,"clientMessageId":client,"addNotes":[],"removeNotes":[],"scopeChangeRequest":request,"scopeBefore":work.grant,"scopeAfter":grant,"authorizationVersion":work.authorization_version,"scopeChange":"confirmedFrozenManifestReplacement"});
        if body.to_string().len() > 65536 {
            return Err("完整范围变更记录超过64KiB，原范围与预算保留".into());
        }
        store::insert(c, &id, None, "userMessage", &body)?;
        c.execute("UPDATE agent_works SET grant_json=?2,revision=revision+1,state=CASE WHEN state IN ('paused','cancelled') THEN state ELSE 'ready' END,active_run=NULL,report_json=NULL,updated_at=?3 WHERE id=?1",params![id,serde_json::to_string(&grant).map_err(|e|e.to_string())?,chrono::Utc::now().timestamp_millis()]).map_err(|e|e.to_string())?;
        watch::pause_on(c, &id, "材料范围已重新确认，自动复查暂停")?;
        Ok(())
    })
}
