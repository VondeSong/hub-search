//! Read-only keyword pilot over an existing Work's explicitly selected notes.
use super::*;

fn reader(root: &Path, work: &Work) -> Result<(EvidenceReader, usize), String> {
    if !work.grant.library_ids.is_empty() {
        return Err(
            "关联试点只使用明确选中的少量笔记；请先在原事项收窄资料范围，不使用整库授权".into(),
        );
    }
    work.grant.verify_manifest(root)?;
    let mut notes = work.grant.notes.clone();
    notes.extend(
        work.grant
            .sources
            .iter()
            .filter(|s| matches!(s, EvidenceLocator::Note { .. }))
            .cloned(),
    );
    if let Some(manifest) = &work.grant.manifest {
        notes.extend(manifest.members.clone());
    }
    let mut unique = Vec::new();
    for note in notes {
        if !unique.contains(&note) {
            unique.push(note);
        }
    }
    if unique.is_empty() || unique.len() > 32 {
        return Err("关联试点需要原事项明确选中的 1–32 份笔记；其他类型资料仍从原事项核对".into());
    }
    let count = unique.len();
    Ok((
        EvidenceReader::new(
            root,
            EvidenceScope::new(vec![], vec![])?.with_notes(unique)?,
        ),
        count,
    ))
}

pub(super) fn ui(root: &Path, args: &Value) -> Result<Value, String> {
    let id = text(args, "id", 150)?;
    let permit = crate::library_runtime::cached_read_permit(root)?;
    let c = crate::source_evidence::open_read_database(root)?;
    let work = work_on(&c, &id)?;
    let (reader, count) = reader(root, &work)?;
    let result = if args["action"] == "insightRecall" {
        let query = text(args, "query", 120)?;
        let mut result = reader.search(crate::source_evidence::EvidenceKind::Note, &query, 11)?;
        let more = result.candidates.len() > 10;
        result.candidates.truncate(10);
        for candidate in &result.candidates {
            reader.read(&candidate.locator, 0, 1, Some(&candidate.version))?;
        }
        json!({"workId":id,"scopeCount":count,"query":query,"candidates":result.candidates,
            "limitReached":more,"unavailableCandidates":result.unavailable_candidates,
            "retrieval":"literalSelectedNotes","exhaustive":false,"sourceFreshness":"notVerifiedWithRemote"})
    } else {
        let locator: EvidenceLocator =
            serde_json::from_value(args["locator"].clone()).map_err(|_| "候选资料身份无效")?;
        let version: crate::source_evidence::EvidenceVersion =
            serde_json::from_value(args["version"].clone())
                .map_err(|_| "需要有效的候选资料版本")?;
        let start = args["startChar"]
            .as_u64()
            .unwrap_or(0)
            .min(usize::MAX as u64) as usize;
        serde_json::to_value(reader.read(&locator, start, 2000, Some(&version))?)
            .map_err(|e| e.to_string())?
    };
    let current = work_on(&c, &id)?;
    if current.authorization_version != work.authorization_version
        || current.revision != work.revision
    {
        return Err("查找期间原事项或授权已变化，请重新查找".into());
    }
    permit.checkpoint()?;
    Ok(result)
}

#[cfg(test)]
mod tests;
