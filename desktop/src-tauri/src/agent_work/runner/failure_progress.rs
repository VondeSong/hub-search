//! One advisory per consecutive failure streak; execution limits have separate owners.
use serde_json::{json, Value};

#[derive(Default)]
pub(super) struct FailureProgress {
    key: Option<Value>,
    call: String,
    count: u8,
    acknowledged: bool,
    model_item: String,
    subsequent_item: bool,
    notified: bool,
}
impl FailureProgress {
    pub(super) fn sent(&mut self, call: &str) {
        if self.call == call {
            self.acknowledged = true;
        }
    }
    pub(super) fn event(&mut self, value: &Value) {
        if !matches!(
            value["kind"].as_str(),
            Some("reasoning" | "message" | "answer")
        ) {
            return;
        }
        if let Some(id) = value["id"].as_str().filter(|id| !id.is_empty()) {
            if self.acknowledged && self.model_item != id {
                self.subsequent_item = true;
            }
            self.model_item = id.into();
        }
    }
    pub(super) fn observe(
        &mut self,
        request: &Value,
        raw: &Value,
        binding: &Value,
        generation: u64,
    ) -> Option<Value> {
        // Writes, polling and unclassified errors cannot trigger automatic intervention.
        if !super::read_progress::supports(request)
            || raw["origin"] != "host"
            || !raw["error"].is_string()
        {
            *self = Self::default();
            return None;
        }
        let call = request["stepId"].as_str()?;
        if call.is_empty() || call == self.call {
            return None;
        }
        let mut parameters = request.clone();
        parameters.as_object_mut()?.remove("stepId");
        let key = json!({"request":parameters,"error":raw["error"],"binding":binding,"generation":generation});
        if self.key.as_ref() != Some(&key) {
            self.notified = false;
        }
        self.count = if self.key.as_ref() == Some(&key) && self.acknowledged && self.subsequent_item
        {
            self.count.saturating_add(1)
        } else {
            1
        };
        self.key = Some(key);
        self.call = call.into();
        self.acknowledged = false;
        self.subsequent_item = false;
        if self.count < 2 || self.notified {
            return None;
        }
        self.notified = true;
        Some(
            json!({"schemaVersion":1,"origin":"host_watchdog","policyVersion":"read-failure-advisory-2","providerProcessingProven":false,
            "mode":"advisory","decision":"allow","callId":call,"consecutiveFailures":self.count,
            "userBinding":binding,"contextGeneration":generation,"recoveryPerformed":false,
            "error":raw["error"],"sourceFreshness":"unknown","retryPerformed":false,
            "recoveryOptions":[{"action":"correctArguments","description":"根据实际错误和工具格式调整参数或读取范围"},{"action":"chooseAlternative","description":"按任务需要选择其它已授权方法，或说明当前证据缺口"}],
            "message":"相同参数连续读取失败。请结合实际错误自主选择修正参数、其它方法或说明缺口。此提示不证明任务卡住，不要求调用指定工具；现有预算、授权和取消边界仍有效。"}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(n: u8) -> Value {
        json!({"operation":"read","stepId":format!("c{n}"),"locator":"source"})
    }
    fn failure() -> Value {
        json!({"origin":"host","error":"source unavailable"})
    }
    #[test]
    fn repeated_failures_advise_once_and_never_pause() {
        let mut p = FailureProgress::default();
        for n in 1..=20 {
            let result = p.observe(&request(n), &failure(), &json!({"revision":1}), 0);
            if n != 2 {
                assert!(result.is_none());
            } else {
                assert_eq!(result.unwrap()["decision"], "allow");
            }
            assert!(p
                .observe(&request(n), &failure(), &json!({"revision":1}), 0)
                .is_none());
            p.sent(&format!("c{n}"));
            p.event(&json!({"kind":"reasoning","id":format!("reason-{n}")}));
        }
    }
    #[test]
    fn unacknowledged_calls_never_escalate() {
        let mut p = FailureProgress::default();
        for n in 1..20 {
            assert!(p
                .observe(&request(n), &failure(), &Value::Null, 0)
                .is_none());
        }
    }
    #[test]
    fn missing_public_output_does_not_rearm_the_same_advisory() {
        let mut p = FailureProgress::default();
        let mut hints = 0;
        for n in 1..=20 {
            hints += usize::from(
                p.observe(&request(n), &failure(), &Value::Null, 0)
                    .is_some(),
            );
            p.sent(&format!("c{n}"));
            if n % 3 != 0 {
                p.event(&json!({"kind":"reasoning","id":format!("r{n}")}));
            }
        }
        assert_eq!(hints, 1);
    }
    #[test]
    fn flushed_parallel_calls_without_new_model_items_never_escalate() {
        let mut p = FailureProgress::default();
        for n in 1..20 {
            assert!(p
                .observe(&request(n), &failure(), &Value::Null, 0)
                .is_none());
            p.sent(&format!("c{n}"));
        }
    }
    #[test]
    fn progress_user_change_and_compaction_reset_failures() {
        let mut p = FailureProgress::default();
        p.observe(&request(1), &failure(), &json!(1), 0);
        p.sent("c1");
        assert!(p.observe(&request(2), &failure(), &json!(2), 0).is_none());
        p.sent("c2");
        assert!(p.observe(&request(3), &failure(), &json!(2), 1).is_none());
        p.sent("c3");
        assert!(p
            .observe(&request(4), &json!({"content":"ok"}), &json!(2), 1)
            .is_none());
        assert!(p.observe(&request(5), &failure(), &json!(2), 1).is_none());
        let mut write = request(6);
        write["operation"] = json!("prepareArchive");
        assert!(p.observe(&write, &failure(), &json!(2), 1).is_none());
    }
    #[test]
    fn advisory_preserves_results_and_running_state_until_explicit_stop() {
        use crate::agent_work::{
            store,
            tests::{claim, create},
        };
        use crate::source_evidence::tests::Fixture;
        let f = Fixture::new();
        f.note("notes", "current", "保留来源");
        let id = create(&f, false);
        let (work, run) = claim(&f, &id);
        let binding = store::goal::binding_on(&f.c(), &work).unwrap();
        let mut detector = FailureProgress::default();
        for n in 1..=4 {
            let request = request(n);
            store::record(&f.root, &run, "toolCall", &request).unwrap();
            let reference =
                store::tool_results::capture(&f.root, &id, &run, &request, &failure()).unwrap();
            if let Some(mut intervention) = detector.observe(&request, &failure(), &binding, 0) {
                intervention["resultRef"] = reference;
                store::record(&f.root, &run, "watchdogIntervention", &intervention).unwrap();
                assert_eq!(intervention["decision"], "allow");
            }
            detector.sent(&format!("c{n}"));
            detector.event(&json!({"kind":"reasoning","id":format!("r{n}")}));
        }
        let reopened = store::load(&f.c(), &id).unwrap();
        assert_eq!(reopened.state, "investigating");
        assert_eq!(reopened.active_run.as_deref(), Some(run.as_str()));
        assert_eq!(
            store::records(&f.root, &id, "toolResult", 32)
                .unwrap()
                .len(),
            4
        );
        let interventions = store::records(&f.root, &id, "watchdogIntervention", 32).unwrap();
        assert_eq!(interventions.len(), 1);
        assert_eq!(interventions[0]["decision"], "allow");
        store::fail(&f.root, &work, &run, "用户中断").unwrap();
        let (resumed, next_run) = claim(&f, &id);
        assert_eq!(resumed.id, work.id);
        assert_ne!(next_run, run);
        assert_eq!(
            store::records(&f.root, &id, "toolResult", 32)
                .unwrap()
                .len(),
            4
        );
    }
}
