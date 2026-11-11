//! Explicit host scope changes. A model interpretation cannot call this.
use super::*;

pub(super) fn additions(value: &Value) -> Result<Vec<EvidenceLocator>, String> {
    let mut notes = selected(value, "addNotes")?;
    let sources: Vec<EvidenceLocator> =
        serde_json::from_value(value.get("addSources").cloned().unwrap_or(json!([])))
            .map_err(|_| "追加资料身份无效")?;
    if notes.len() + sources.len() > 31
        || sources.iter().any(|s| {
            !matches!(
                s,
                EvidenceLocator::Note { .. }
                    | EvidenceLocator::Reading { .. }
                    | EvidenceLocator::Task { .. }
            )
        })
    {
        return Err("每次最多追加31份明确的页面、任务或阅读条目".into());
    }
    notes.extend(sources);
    Ok(notes)
}
pub(super) fn removals(value: &Value) -> Result<Vec<EvidenceLocator>, String> {
    selected(value, "removeNotes")
}
fn selected(value: &Value, field: &str) -> Result<Vec<EvidenceLocator>, String> {
    let notes: Vec<EvidenceLocator> =
        serde_json::from_value(value.get(field).cloned().unwrap_or(json!([])))
            .map_err(|_| "追加材料必须是明确选中的笔记列表")?;
    if notes.len() > 31
        || notes
            .iter()
            .any(|n| !matches!(n, EvidenceLocator::Note { .. }))
    {
        return Err("每次最多变更 31 份笔记，不接受整库或其他来源授权".into());
    }
    Ok(notes)
}

pub(super) fn extend(
    root: &Path,
    c: &Connection,
    work: &Work,
    notes: &[EvidenceLocator],
    removed: &[EvidenceLocator],
) -> Result<Grant, String> {
    let unresolved: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_actions WHERE work_id=?1 AND state IN ('executing','unknown','reconciliation_required'))",
        [&work.id], |r| r.get(0),
    ).map_err(|e| e.to_string())?;
    if unresolved {
        return Err("业务动作结果待核对，请先核对再调整材料".into());
    }
    if work.grant.manifest.is_some() && (!notes.is_empty() || !removed.is_empty()) {
        return Err("固定清单不能通过单篇追加或撤回改变；可停止整个事项的来源授权".into());
    }
    let mut grant = work.grant.clone();
    for note in removed {
        let library = match note {
            EvidenceLocator::Note { library_id, .. } => library_id,
            _ => return Err("只能撤回明确笔记授权".into()),
        };
        if grant.library_ids.contains(library) {
            return Err("当前为整库授权，不能仅撤回其中一篇；请使用停止来源授权入口".into());
        }
        if work.anchor.as_ref().is_some_and(|anchor| {
            (Grant {
                notes: vec![note.clone()],
                ..Default::default()
            })
            .contains(anchor)
        }) {
            return Err("当前锚点必须保留；可先停止整个事项的来源授权".into());
        }
        if notes.contains(note) {
            return Err("同一材料不能同时追加和撤回授权".into());
        }
        let index = grant
            .notes
            .iter()
            .position(|old| old == note)
            .ok_or("所选材料不在明确授权范围内，请刷新后重试")?;
        grant.notes.remove(index);
    }
    for note in notes {
        let note = crate::source_evidence::resolve_note_page(root, c, note.clone())?;
        if removed.contains(&note) {
            return Err("同一材料不能同时追加和撤回授权".into());
        }
        if grant.notes.contains(&note)
            || (!matches!(&note, EvidenceLocator::Note { .. }) && grant.contains(&note))
        {
            return Err("所选材料已在授权范围内，请刷新材料清单".into());
        }
        match &note {
            EvidenceLocator::Note { .. } => grant.notes.push(note.clone()),
            EvidenceLocator::Reading { item_key } => grant.reading_item_keys.push(item_key.clone()),
            EvidenceLocator::Task { .. } => grant.sources.push(note.clone()),
            _ => return Err("不支持追加此类资料".into()),
        }
        if grant.notes.len() + grant.sources.len() + grant.reading_item_keys.len() > 32 {
            return Err("当前事项最多授权 32 份明确材料，原范围已保留".into());
        }
        grant.reader(root)?.read(&note, 0, 1, None)?;
    }
    Ok(grant)
}

/// Old fixed inputs keep their exact scope digest after a scope change.
/// This reader is for saved evidence only; new model tools use the current grant.
/// Revocation/deletion still invalidate reads, and an old scope cannot exceed
/// the current authorization. No global snapshot eligibility rule is relaxed.
pub(in crate::agent_work) fn grant_at(
    c: &Connection,
    work: &Work,
    revision: i64,
) -> Result<Grant, String> {
    if work.state == "revoked" || revision < 1 || revision > work.revision {
        return Err("历史材料范围或授权不可用".into());
    }
    let raw: Option<String> = c.query_row(
        "SELECT body_json FROM agent_records WHERE work_id=?1 AND kind='userMessage' AND json_type(body_json,'$.scopeBefore')='object' AND json_extract(body_json,'$.revision')>?2 ORDER BY CAST(json_extract(body_json,'$.revision') AS INTEGER) LIMIT 1",
        params![work.id, revision], |r| r.get(0),
    ).optional().map_err(|e| e.to_string())?;
    let Some(raw) = raw else {
        return Ok(work.grant.clone());
    };
    let body: Value = serde_json::from_str(&raw).map_err(|_| "历史材料授权记录损坏")?;
    if body["authorizationVersion"] != work.authorization_version && work.anchor.is_some() {
        return Err("历史材料授权已失效".into());
    }
    let old: Grant =
        serde_json::from_value(body["scopeBefore"].clone()).map_err(|_| "历史材料范围损坏")?;
    if old.manifest != work.grant.manifest
        || old.library_ids != work.grant.library_ids
        || old
            .reading_item_keys
            .iter()
            .any(|key| !work.grant.reading_item_keys.contains(key))
        || old
            .sources
            .iter()
            .any(|source| !work.grant.contains(source))
        || old.attachment_library_ids != work.grant.attachment_library_ids
        || old
            .images
            .iter()
            .any(|image| !work.grant.images.contains(image))
        || old.notes.iter().any(|n| !work.grant.contains(n))
    {
        return Err("历史材料范围超出当前授权".into());
    }
    old.scope()?;
    Ok(old)
}
