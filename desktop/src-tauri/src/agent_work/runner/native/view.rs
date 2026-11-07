//! Actual Hub tool-return views, not the provider's complete internal context.
//! Preparing a view is not proof that its bytes reached a model.
use super::*;
use std::collections::HashMap;
const MAX_WIRE_BYTES: usize = 196_608; // Same per-payload ceiling as the initial context.
#[derive(Default)]
pub(super) struct View {
    generation: u64,
    sequence: u64,
    pending: HashMap<String, Value>,
}
impl View {
    pub(super) fn generation(&self) -> u64 {
        self.generation
    }
    pub(super) fn invalidate(&mut self) -> Result<(), String> {
        self.generation = self.generation.checked_add(1).ok_or("上下文代次超过容量")?;
        Ok(())
    }
    pub(super) fn prepare(
        &mut self,
        root: &Path,
        work: &Work,
        run: &str,
        call: &str,
        output: &Value,
        replay: bool,
    ) -> Result<(), String> {
        if call.is_empty() || call.len() > 256 {
            return Err("上下文返回调用身份无效".into());
        }
        let serialized = output.to_string();
        if serialized.len() > MAX_WIRE_BYTES {
            return Err(
                "工具返回超过单次上下文容量；完整结果已保留，未裁剪要求、引用或业务回执".into(),
            );
        }
        if self.pending.contains_key(call) || self.pending.len() >= 128 {
            return Err("上下文返回尚未确认发送，未覆盖旧状态".into());
        }
        let sequence = self
            .sequence
            .checked_add(1)
            .ok_or("上下文表示版本超过容量")?;
        let mut fields = serde_json::Map::new();
        for key in ["quoteCatalog", "businessActionRecords", "knowledgeRules"] {
            if let Some(value) = output.get(key) {
                fields.insert(
                    key.into(),
                    json!({"representation":"full","utf8Bytes":value.to_string().len()}),
                );
            }
        }
        if let Some(value) = output.get("knowledgeRulesRef") {
            fields.insert(
                "knowledgeRules".into(),
                json!({"representation":"reference","digestRef":value}),
            );
        }
        if let Some(value) = output.get("quoteCatalogRef") {
            fields.insert(
                "quoteCatalog".into(),
                json!({"representation":"reference","digestRef":value}),
            );
        }
        let prepared = json!({"schemaVersion":1,"policyVersion":"hub-tool-return-view-1","workId":work.id,"runId":run,
       "contextVersion":format!("{run}:{sequence}"),"generation":self.generation.to_string(),"callId":call,"phase":"prepared",
       "sourceResultRef":output.get("toolResultRef"),"representation":"host-tool-return","fieldRepresentations":fields,
       "outputSha256":format!("{:x}",Sha256::digest(serialized.as_bytes())),"outputUtf8Bytes":serialized.len(),
       "estimatedTokens":null,"providerActiveContextTokens":null,"replay":replay,
       "reason":"exact bounded tool response; full trace and server history unchanged","providerReceived":null});
        store::record(root, run, "nativeContextView", &prepared)?;
        self.sequence = sequence;
        self.pending.insert(call.to_string(), prepared);
        Ok(())
    }
    pub(super) fn sent(&mut self, root: &Path, run: &str, event: &Value) -> Result<(), String> {
        let call = event["callId"]
            .as_str()
            .ok_or("上下文发送回执缺少调用身份")?;
        let Some(prepared) = self.pending.get(call) else {
            return Ok(());
        }; // Finish/rejected-argument replies have no complete-result view.
        if prepared["runId"] != run
            || event["outputSha256"] != prepared["outputSha256"]
            || event["outputUtf8Bytes"] != prepared["outputUtf8Bytes"]
        {
            return Err("上下文发送回执与已生成表示不一致".into());
        }
        store::record(
            root,
            run,
            "nativeContextDelivery",
            &json!({"schemaVersion":1,"contextVersion":prepared["contextVersion"],"generation":prepared["generation"],"callId":call,"phase":if event["transport"]=="mcpStdio"{"flushedToExternalMcpStdout"}else{"flushedToProviderStdin"},"outputSha256":prepared["outputSha256"],"outputUtf8Bytes":prepared["outputUtf8Bytes"],"providerReceived":null,"modelConsumed":null}),
        )?;
        self.pending.remove(call);
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_work::tests::{claim, create};
    use crate::source_evidence::tests::Fixture;
    fn setup() -> (Fixture, Work, String) {
        let f = Fixture::new();
        f.note("notes", "current", "合成原文");
        let id = create(&f, false);
        let (w, r) = claim(&f, &id);
        (f, w, r)
    }
    fn sent(v: &View, call: &str) -> Value {
        let p = &v.pending[call];
        json!({"callId":call,"outputSha256":p["outputSha256"],"outputUtf8Bytes":p["outputUtf8Bytes"]})
    }
    #[test]
    fn view_preparation_is_not_delivery_and_records_actual_bytes_without_token_claims() {
        let (f, w, r) = setup();
        let mut v = View::default();
        let output = json!({"quoteCatalog":["中文🙂"],"businessActionRecords":[{"state":"unknown"}],"knowledgeRules":{"scope":"current"}});
        let old = output.clone();
        v.prepare(&f.root, &w, &r, "call", &output, false).unwrap();
        assert_eq!(output, old);
        let rows = store::records(&f.root, &w.id, "nativeContextView", 10).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["outputUtf8Bytes"], output.to_string().len());
        assert!(rows[0]["estimatedTokens"].is_null());
        assert!(store::records(&f.root, &w.id, "nativeContextDelivery", 10)
            .unwrap()
            .is_empty());
        v.sent(&f.root, &r, &sent(&v, "call")).unwrap();
        let delivered = store::records(&f.root, &w.id, "nativeContextDelivery", 10).unwrap();
        assert_eq!(delivered.len(), 1);
        assert!(delivered[0]["modelConsumed"].is_null());
        v.sent(&f.root, &r, &json!({"callId":"call"})).unwrap();
        assert_eq!(
            store::records(&f.root, &w.id, "nativeContextDelivery", 10)
                .unwrap()
                .len(),
            1
        );
    }
    #[test]
    fn oversized_protected_fields_fail_before_view_and_generation_does_not_reset_work() {
        let (f, w, r) = setup();
        let mut v = View::default();
        let before = serde_json::to_value(&w).unwrap();
        let output = json!({"quoteCatalog":["字".repeat(MAX_WIRE_BYTES)],"businessActionRecords":[{"state":"unknown"}]});
        assert!(v
            .prepare(&f.root, &w, &r, "call", &output, false)
            .unwrap_err()
            .contains("未裁剪"));
        assert!(store::records(&f.root, &w.id, "nativeContextView", 10)
            .unwrap()
            .is_empty());
        v.invalidate().unwrap();
        v.prepare(&f.root, &w, &r, "call", &json!({"result":"actual"}), true)
            .unwrap();
        assert_eq!(v.pending["call"]["generation"], "1");
        assert_eq!(
            serde_json::to_value(store::load(&f.c(), &w.id).unwrap()).unwrap(),
            before
        );
    }
    #[test]
    fn failed_persistence_or_mismatched_flush_never_claims_delivery() {
        let (f, w, r) = setup();
        let mut v = View::default();
        f.c().execute_batch("CREATE TRIGGER fail_view BEFORE INSERT ON agent_records WHEN NEW.kind='nativeContextView' BEGIN SELECT RAISE(ABORT,'view-abort'); END;").unwrap();
        assert!(v
            .prepare(&f.root, &w, &r, "call", &json!({"actual":true}), false)
            .is_err());
        assert!(v.pending.is_empty());
        f.c().execute_batch("DROP TRIGGER fail_view;").unwrap();
        v.prepare(&f.root, &w, &r, "call", &json!({"actual":true}), false)
            .unwrap();
        let mut wrong = sent(&v, "call");
        wrong["outputSha256"] = json!("wrong");
        assert!(v.sent(&f.root, &r, &wrong).is_err());
        f.c().execute_batch("CREATE TRIGGER fail_delivery BEFORE INSERT ON agent_records WHEN NEW.kind='nativeContextDelivery' BEGIN SELECT RAISE(ABORT,'delivery-abort'); END;").unwrap();
        assert!(v.sent(&f.root, &r, &sent(&v, "call")).is_err());
        assert!(v.pending.contains_key("call"));
        assert!(store::records(&f.root, &w.id, "nativeContextDelivery", 10)
            .unwrap()
            .is_empty());
    }
    #[test]
    fn mcp_stdout_flush_does_not_claim_provider_stdin_or_model_consumption() {
        let (f, w, r) = setup();
        let mut v = View::default();
        v.prepare(
            &f.root,
            &w,
            &r,
            "mcp-call",
            &json!({"result":"controlled"}),
            false,
        )
        .unwrap();
        let mut e = sent(&v, "mcp-call");
        e["transport"] = json!("mcpStdio");
        v.sent(&f.root, &r, &e).unwrap();
        let rows = store::records(&f.root, &w.id, "nativeContextDelivery", 1).unwrap();
        assert_eq!(rows[0]["phase"], "flushedToExternalMcpStdout");
        assert!(rows[0]["providerReceived"].is_null());
        assert!(rows[0]["modelConsumed"].is_null());
    }
}
