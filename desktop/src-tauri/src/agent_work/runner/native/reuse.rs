//! Checkpoint only mutable artifact state; all original reuse gates still apply.
use super::*;

pub(super) fn checkpoint(
    root: &Path,
    work: &Work,
    run: &str,
    initial: &Value,
    successful: bool,
) -> Result<Value, String> {
    let mut binding = initial.clone();
    if successful {
        binding["charts"] = super::super::super::artifacts::manifest_on(
            root,
            &crate::source_evidence::open_read_database(root)?,
            work,
        )?;
        let produced = store::records(root, &work.id, "analysisExecution", 100)?;
        if produced.iter().any(|item| item["runId"] == run) {
            use super::super::super::analysis;
            let current = analysis::context(root, work);
            let verified = analysis::references(root, work, Some(run))?;
            if analysis_can_settle(&initial["fileAnalyses"], &current, &verified) {
                binding["fileAnalyses"] = current;
            }
        }
    }
    Ok(json!({
        "fingerprint":format!("{:x}", Sha256::digest(binding.to_string().as_bytes())),
        "bindingParts":measurement::fingerprints(&binding),
        "bindingPhase":if successful { "settled" } else { "initial" }
    }))
}

fn analysis_can_settle(initial: &Value, current: &Value, verified: &Value) -> bool {
    let (Some(old), Some(now), Some(old_reports), Some(now_reports)) = (
        initial["items"].as_array(),
        current["items"].as_array(),
        initial["currentReports"].as_array(),
        current["currentReports"].as_array(),
    ) else {
        return false;
    };
    // Only adopt additions from this successful turn. Revisions and drift in
    // previously supplied results still require rebuilding the provider context.
    initial["capability"] == current["capability"]
        && initial["earlierItemsOmitted"] == current["earlierItemsOmitted"]
        && initial["historyWindowMayBeFull"] == current["historyWindowMayBeFull"]
        && now.ends_with(old)
        && now_reports.ends_with(old_reports)
        && now[..now.len() - old.len()].iter().all(|item| {
            item["available"] == true
                && item["superseded"] == false
                && verified.as_array().into_iter().flatten().any(|receipt| {
                    receipt["executionId"] == item["executionId"]
                        && receipt["files"] == item["files"]
                })
        })
}

// Diagnostic only: a current artifact is not proof of current sources or rules.
// The caller still requires the full fingerprint and every inheritance check.
pub(super) fn chart_context(root: &Path, work: &Work, previous: &Value) -> Value {
    let inspected = crate::source_evidence::open_read_database(root).and_then(|c| {
        super::super::super::artifacts::inspect_references(
            root,
            &c,
            work,
            &previous["artifactRefs"],
        )
    });
    match inspected {
        Ok(view) => json!({
            "state":view["state"],
            "classification":if view["state"] == "current" { "artifactOnlyDrift" } else { "artifactRevalidationRequired" },
            "reason":view["reason"],
            "checks":"artifactReferencesOnly"
        }),
        Err(error) => {
            json!({"state":"unavailable","classification":"artifactContextInvalid","reason":error,"checks":"artifactReferencesOnly"})
        }
    }
}

#[cfg(test)]
mod tests;
