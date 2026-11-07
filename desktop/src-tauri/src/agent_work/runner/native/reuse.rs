//! Checkpoint only mutable artifact state; all original reuse gates still apply.
use super::*;

pub(super) fn checkpoint(
    root: &Path,
    work: &Work,
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
    }
    Ok(json!({
        "fingerprint":format!("{:x}", Sha256::digest(binding.to_string().as_bytes())),
        "bindingParts":measurement::fingerprints(&binding),
        "bindingPhase":if successful { "settled" } else { "initial" }
    }))
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
