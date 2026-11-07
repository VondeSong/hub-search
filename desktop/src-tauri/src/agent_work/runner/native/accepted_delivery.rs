//! A provider timeout cannot turn an already checked report into lost work.
use super::*;
use std::time::Duration;

pub(super) fn provider_completed(
    result: &Result<Value, String>,
    accepted_after: Option<Duration>,
    generation_limit: Duration,
    control: &Control,
) -> Result<bool, String> {
    match result {
        Ok(_) => Ok(true),
        // shortcut: only the observed Codex generation timeout is recoverable;
        // qualify other provider endings before extending this boundary.
        Err(error)
            if error == "Codex 生成超时，请重试。"
                && accepted_after.is_some_and(|elapsed| elapsed < generation_limit) =>
        {
            control.check()?;
            Ok(false)
        }
        Err(error) => Err(error.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepted_delivery_timeout_is_narrow_and_keeps_parent_stop_authoritative() {
        let timeout: Result<Value, String> = Err("Codex 生成超时，请重试。".into());
        let control = Control::default();
        let limit = Duration::from_secs(90);
        assert!(
            !provider_completed(&timeout, Some(Duration::from_secs(88)), limit, &control).unwrap()
        );
        assert!(provider_completed(&Ok(Value::Null), None, limit, &control).unwrap());
        for accepted in [None, Some(limit), Some(limit + Duration::from_millis(1))] {
            assert!(provider_completed(&timeout, accepted, limit, &control).is_err());
        }
        for error in [
            "用户已取消",
            "材料额度耗尽",
            "提供方Token额度不足",
            "MCP发送回执不匹配",
        ] {
            assert!(provider_completed(
                &Err(error.into()),
                Some(Duration::from_secs(88)),
                limit,
                &control
            )
            .is_err());
        }
        control.cancel();
        assert!(
            provider_completed(&timeout, Some(Duration::from_secs(88)), limit, &control).is_err()
        );
    }

    #[test]
    #[ignore = "one saved357 accepted-report replay; no model or live database writes"]
    fn accepted_delivery_saved_report_zero_model() {
        let desktop = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let out = desktop.join("artifacts/architecture-v5-357-verification-20261028/tail-repair");
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(out.join("saved-replay-started"))
            .unwrap();
        let fixture: Value =
            serde_json::from_slice(&std::fs::read(out.join("model-candidate.json")).unwrap())
                .unwrap();
        let excerpts: Vec<EvidenceExcerpt> = fixture["evidence"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| serde_json::from_value(v["excerpt"].clone()).unwrap())
            .collect();
        let normalized = assistant::normalize(
            json!({"rationale":"","requests":[],"report":fixture["args"]}),
            &json!(quotes::catalog(&excerpts)),
        )
        .unwrap();
        let report: Report = serde_json::from_value(normalized["report"].clone()).unwrap();
        validate(&report, &excerpts).unwrap();
        let report_hash = format!(
            "{:x}",
            Sha256::digest(serde_json::to_string(&report).unwrap().as_bytes())
        );
        assert_eq!(report_hash, fixture["expectedReportHash"].as_str().unwrap());
        let root = desktop.join(".local/v5-package-business-20261028/profile");
        let c = crate::source_evidence::open_read_database(&root).unwrap();
        let w = store::load(&c, fixture["originWork"].as_str().unwrap()).unwrap();
        assert_eq!(w.revision, 2);
        assert_eq!(w.authorization_version, 1);
        assert!(w.active_run.is_none());
        w.grant
            .reader(&root)
            .unwrap()
            .verify_in_transaction(&c, &excerpts)
            .unwrap();
        std::fs::write(
            out.join("normalized-report.json"),
            serde_json::to_vec_pretty(&json!(report)).unwrap(),
        )
        .unwrap();
        std::fs::write(out.join("saved-replay-result.json"),serde_json::to_vec_pretty(&json!({"passed":true,"models":0,"databaseWrites":0,"exactAcceptedReportHash":report_hash,"currentSourceVerified":true,"historicalFailureRegraded":false})).unwrap()).unwrap();
    }
}
