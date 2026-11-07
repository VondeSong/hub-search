//! Explicit attachments are read before the model decides their relevance.
use super::*;

pub(super) fn prepare(
    root: &Path,
    work: &Work,
    run: &str,
    context: &mut Context,
) -> Result<(), String> {
    let previous = store::records(root, &work.id, "evidence", 64)?;
    let mut selected = if work.grant.manifest.is_none() {
        let mut items = work.grant.notes.clone();
        items.extend(work.grant.sources.clone());
        items.extend(
            work.grant
                .reading_item_keys
                .iter()
                .map(|key| EvidenceLocator::Reading {
                    item_key: key.clone(),
                }),
        );
        // Recover attachments that older runs authorized but never read.
        items.retain(|locator| {
            !previous
                .iter()
                .any(|record| record["excerpt"]["locator"] == json!(locator))
        });
        items
    } else {
        Vec::new()
    };
    for message in store::records(root, &work.id, "userMessage", 32)? {
        if message["revision"].as_i64() == Some(work.revision) {
            let additions: Vec<EvidenceLocator> =
                serde_json::from_value(message.get("addNotes").cloned().unwrap_or(json!([])))
                    .map_err(|_| "本轮资料清单损坏")?;
            selected.splice(0..0, additions);
        }
    }
    let mut seen = HashSet::new();
    for locator in selected {
        context.control.check()?;
        let key = serde_json::to_string(&locator).map_err(|e| e.to_string())?;
        if !seen.insert(key.clone()) || context.entities.contains(&key) {
            continue;
        }
        // Use the normal evidence reader, including exact page scope and budgets.
        let available = context
            .budget
            .body_chars
            .saturating_sub(context.usage.body_chars)
            .min(if crate::source_evidence::local_text::is_local(&locator) {
                20_000
            } else {
                6000
            });
        let result = if !work.grant.contains(&locator) {
            Err("资料已不在当前授权范围内".into())
        } else if available == 0 || context.entities.len() >= context.budget.entities {
            Err("本轮资料读取预算已用尽".into())
        } else {
            context
                .reader
                .read(&locator, 0, available, None)
                .and_then(|excerpt| context.remember(excerpt))
        };
        match result {
            Ok(mut evidence) => {
                evidence["origin"] = json!("hostSelectedRead");
                store::record(root, run, "evidence", &evidence)?;
                context.observations.push(evidence);
            }
            Err(error) => {
                context.control.check()?;
                let notice = json!({"origin":"hostSelectedRead","locator":locator,"readError":error,
                    "meaning":"用户本轮选择的资料未读入，不能声称已分析；可在权限与预算内补读。"});
                store::record(root, run, "selectedMaterialReadError", &notice)?;
                context.observations.push(notice);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
