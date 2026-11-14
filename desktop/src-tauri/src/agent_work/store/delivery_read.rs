//! Verification reuse is confined to one Work and one database read snapshot.
use super::*;
use std::collections::HashMap;
type Verified = Result<(Vec<EvidenceExcerpt>, Value), String>;
pub(super) struct DeliveryRead<'a> {
    root: &'a Path,
    c: &'a Connection,
    identity: (String, i64, i64),
    entries: HashMap<String, (Value, Verified)>,
}
impl<'a> DeliveryRead<'a> {
    pub(super) fn new(root: &'a Path, c: &'a Connection, work: &Work) -> Self {
        Self {
            root,
            c,
            identity: (work.id.clone(), work.revision, work.authorization_version),
            entries: HashMap::new(),
        }
    }
    pub(super) fn verify(
        &mut self,
        work: &Work,
        run: &str,
        body: &Value,
        authorization: i64,
    ) -> Verified {
        if self.identity != (work.id.clone(), work.revision, work.authorization_version)
            || (authorization != work.authorization_version && work.anchor.is_some())
            || work.state == "revoked"
        {
            return Err("来源或授权不可用".into());
        }
        if let Some((saved, value)) = self.entries.get(run) {
            if saved == body {
                return value.clone();
            }
        }
        let value = (|| {
            if work.anchor.is_none() {
                let actual: i64 = self
                    .c
                    .query_row(
                        "SELECT authorization_version FROM agent_runs WHERE id=?1 AND work_id=?2",
                        params![run, work.id],
                        |r| r.get(0),
                    )
                    .map_err(|e| e.to_string())?;
                if authorization != actual
                    || authorization < 1
                    || authorization > work.authorization_version
                {
                    return Err("历史回答授权身份不匹配".into());
                }
            }
            if !crate::shared_memory::historical_use_valid(self.root, self.c, &work.id, run)? {
                return Err(
                    "这条历史回答使用的共享记忆已被修订、停用或遗忘，请按当前记忆重新核对".into(),
                );
            }
            let excerpts: Vec<EvidenceExcerpt> =
                serde_json::from_value(body["evidence"].clone()).map_err(|_| "调查取证记录损坏")?;
            let candidates: Vec<(EvidenceLocator, crate::source_evidence::EvidenceVersion)> =
                serde_json::from_value(body.get("candidates").cloned().unwrap_or(json!([])))
                    .map_err(|_| "调查候选依赖记录损坏")?;
            let revision: i64 = self
                .c
                .query_row(
                    "SELECT base_revision FROM agent_runs WHERE id=?1 AND work_id=?2",
                    params![run, work.id],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            let grant = super::materials::grant_at(self.c, work, revision)?;
            images::verify(self.root, self.c, &grant.images)?;
            let reader = grant.reader(self.root)?;
            reader.verify_in_transaction(self.c, &excerpts)?;
            reader.verify_candidates_in_transaction(self.c, &candidates)?;
            crate::source_evidence::analysis::verify_in_transaction(
                &reader,
                self.c,
                &body["materialReads"],
            )?;
            let report: runner::Report =
                serde_json::from_value(body["report"].clone()).map_err(|_| "交付损坏")?;
            super::super::insights::review::publication(self.root, self.c, work, &report)?;
            let projection =
                super::super::artifacts::delivery_projection(self.root, self.c, work, run, body)?;
            Ok((excerpts, projection))
        })();
        if self.entries.len() < 65 {
            self.entries
                .insert(run.into(), (body.clone(), value.clone()));
        }
        value
    }
}
