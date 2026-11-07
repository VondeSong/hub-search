//! Narrow observe-only source-read progress facts; never a tool authorization gate.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
const WINDOW: usize = 16;
const AGE_MS: u64 = 600_000;
fn canonical(v: &Value) -> Value {
    match v {
        Value::Object(m) => {
            let mut keys = m.keys().collect::<Vec<_>>();
            keys.sort();
            let mut out = serde_json::Map::new();
            for k in keys {
                out.insert(k.clone(), canonical(&m[k]));
            }
            Value::Object(out)
        }
        Value::Array(a) => Value::Array(a.iter().map(canonical).collect()),
        _ => v.clone(),
    }
}
fn digest(v: &Value) -> String {
    format!("{:x}", Sha256::digest(canonical(v).to_string().as_bytes()))
}
struct Read {
    key: Value,
    fingerprint: String,
    first: Value,
    last_call: String,
    seen: u64,
    at: u64,
}
#[derive(Default)]
pub(super) struct ReadProgress {
    recent: VecDeque<Read>,
}
pub(super) fn supports(request: &Value) -> bool {
    request["operation"] == "read"
        || (request["operation"] == "capability" && request["name"] == "hub_read_note")
}
impl ReadProgress {
    pub(super) fn observe(
        &mut self,
        request: &Value,
        raw: &Value,
        result_ref: &Value,
        binding: &Value,
        generation: u64,
        now_ms: u64,
    ) -> Option<Value> {
        // Other reads, errors, unknown revisions, polls and writes are outside this qualified subset.
        if !supports(request) || raw.get("error").is_some() {
            return None;
        }
        let excerpt = if request["operation"] == "read" {
            &raw["excerpt"]
        } else {
            &raw["readEvidence"]
        };
        let version = &excerpt["version"];
        if version["fingerprint"].as_str().is_none_or(|v| v.is_empty())
            || version["kind"].as_str().is_none_or(|v| v.is_empty())
            || excerpt["content"].as_str().is_none()
        {
            return None;
        }
        let call = request["stepId"].as_str()?;
        if call.is_empty()
            || result_ref["recordId"].as_str().is_none()
            || result_ref["sha256"].as_str().is_none()
            || binding["workId"].as_str().is_none()
        {
            return None;
        }
        let mut parameters = request.clone();
        parameters.as_object_mut()?.remove("stepId");
        let key = canonical(
            &json!({"parameters":parameters,"userBinding":binding,"generation":generation.to_string(),"source":excerpt}),
        );
        let fingerprint = digest(&key);
        self.recent
            .retain(|r| now_ms >= r.at && now_ms - r.at <= AGE_MS);
        if let Some(old) = self
            .recent
            .iter_mut()
            .find(|r| r.fingerprint == fingerprint && r.key == key)
        {
            if old.last_call == call {
                return None;
            } // Same-call transport replay is not a new attempt.
            old.seen = old.seen.saturating_add(1);
            old.last_call = call.to_string();
            old.at = now_ms;
            return Some(
                json!({"schemaVersion":1,"policyVersion":"verified-read-observation-1","fingerprintVersion":"canonical-json-sha256-1",
          "mode":"observe_only","decision":"allow","reason":"same_request_and_verified_source_in_same_user_context_binding",
          "callId":call,"fingerprint":fingerprint,"sameReadCount":old.seen,"firstResultRef":old.first,"resultRef":result_ref,
          "userBinding":binding,"contextGeneration":generation.to_string(),"sourceVersion":version,
          "range":{"startChar":excerpt["startChar"],"endChar":excerpt["endChar"]},"modelInternalProgress":"unknown",
          "providerVisibility":"unknown","stallEstablished":false,"recoveryPerformed":false,"windowEntries":WINDOW,"windowAgeMs":AGE_MS}),
            );
        }
        if self.recent.len() >= WINDOW {
            self.recent.pop_front();
        }
        self.recent.push_back(Read {
            key,
            fingerprint,
            first: result_ref.clone(),
            last_call: call.to_string(),
            seen: 1,
            at: now_ms,
        });
        None
    }
}
// Offer recovery without turning a legitimate source review into a stall.
pub(super) fn recovery_options(observed: &Value, tools: &Value) -> Option<Value> {
    if observed["mode"] != "observe_only"
        || observed["decision"] != "allow"
        || observed["stallEstablished"] != false
        || observed["sameReadCount"] != 2
    {
        return None;
    }
    let spec = tools
        .as_array()?
        .iter()
        .find(|tool| tool["name"] == "hub_traceResult")?;
    let reference = &observed["resultRef"];
    let arguments = json!({"recordId":reference["recordId"],"expectedSha256":reference["sha256"],"startChar":0,"maxChars":1000});
    crate::model_runtime::validate_agent_tool(&arguments, &spec["inputSchema"]).ok()?;
    let hint = json!({"schemaVersion":1,"origin":"host_watchdog","mode":"advisory",
        "execution":"advisory_only","readExecution":"executed","decision":"allow",
        "reasonCode":"repeated_verified_read_not_proof_of_stall","relatedCallId":observed["callId"],
        "relatedResultRef":reference,"userBinding":observed["userBinding"],"contextGeneration":observed["contextGeneration"],
        "stallEstablished":false,"recoveryPerformed":false,"currentEvidence":false,
        "message":"本次原文读取已成功。若需恢复完整工具回执，可使用下列只读入口；返回历史不能代替本轮事实取证或新鲜度核验。有目的复核可以继续读取，不因重复而判定卡住。",
        "recoveryOptions":[{"tool":"hub_traceResult","arguments":arguments,"historical":true,"currentEvidence":false}],
        "policy":"Optional recovery only; no tool is blocked, no business action replayed and no budget reset. Later pages use the returned nextStartChar."});
    (hint.to_string().len() <= 2048).then_some(hint)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn request(call: &str) -> Value {
        json!({"operation":"read","stepId":call,"locator":{"documentId":"Case Sensitive"},"startChar":0,"maxChars":100,"expectedVersion":null})
    }
    fn raw() -> Value {
        json!({"evidenceId":"e1","excerpt":{"content":"真实来源","version":{"kind":"document","fingerprint":"actual-source-version"},"startChar":0,"endChar":4}})
    }
    fn reference() -> Value {
        json!({"recordId":"actual-record","sha256":"actual-raw-hash"})
    }
    fn binding() -> Value {
        json!({"workId":"w","workRevision":1,"authorizationVersion":1,"commandWatermark":0})
    }
    #[test]
    fn actual_source_reads_link_distinct_durable_results_without_model_or_business_actions() {
        use crate::agent_work::{
            store,
            tests::{claim, create},
        };
        use crate::source_evidence::tests::Fixture;
        let f = Fixture::new();
        f.note("notes", "current", "实际隔离合成来源");
        let id = create(&f, false);
        let (w, r) = claim(&f, &id);
        let binding = store::goal::binding_on(&f.c(), &w).unwrap();
        let mut observer = ReadProgress::default();
        let mut refs = Vec::new();
        for i in 0..2 {
            let request = json!({"operation":"read","locator":w.anchor,"startChar":0,"maxChars":100,"expectedVersion":null,"stepId":format!("read-{i}")});
            store::record(&f.root, &r, "toolCall", &request).unwrap();
            let excerpt = w
                .grant
                .reader(&f.root)
                .unwrap()
                .read(w.anchor.as_ref().unwrap(), 0, 100, None)
                .unwrap();
            let raw = json!({"evidenceId":"e1","excerpt":excerpt});
            let result = store::tool_results::capture(&f.root, &w.id, &r, &request, &raw).unwrap();
            refs.push(result.clone());
            let event = observer.observe(&request, &raw, &result, &binding, 0, i);
            if i == 0 {
                assert!(event.is_none());
            } else {
                store::record(&f.root, &r, "readProgressObservation", &event.unwrap()).unwrap();
            }
        }
        assert_ne!(refs[0]["recordId"], refs[1]["recordId"]);
        let event = store::records(&f.root, &w.id, "readProgressObservation", 2).unwrap();
        assert_eq!(event.len(), 1);
        assert_eq!(event[0]["firstResultRef"], refs[0]);
        assert_eq!(event[0]["resultRef"], refs[1]);
        assert_eq!(event[0]["decision"], "allow");
        assert_eq!(f.c().query_row("SELECT count(*) FROM agent_records WHERE kind IN ('nativeRuntime','modelExecution')",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        assert_eq!(
            f.c()
                .query_row("SELECT count(*) FROM agent_actions", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn shared_note_read_uses_actual_versioned_evidence_but_not_arbitrary_capabilities() {
        use crate::agent_work::{
            store,
            tests::{claim, create},
        };
        use crate::source_evidence::tests::Fixture;
        let f = Fixture::new();
        f.note("notes", "current", "实际共享读取来源");
        let id = create(&f, false);
        let (w, r) = claim(&f, &id);
        let bind = store::goal::binding_on(&f.c(), &w).unwrap();
        let mut p = ReadProgress::default();
        let source = w
            .grant
            .reader(&f.root)
            .unwrap()
            .read(w.anchor.as_ref().unwrap(), 0, 100, None)
            .unwrap();
        let raw = json!({"content":source.content,"readEvidence":source});
        let mut req = json!({"operation":"capability","name":"hub_read_note","arguments":{"libraryId":"notes","documentId":"current","startChar":0,"maxChars":100},"stepId":"shared-1"});
        for i in 0..2 {
            req["stepId"] = json!(format!("shared-{i}"));
            store::record(&f.root, &r, "toolCall", &req).unwrap();
            let reference = store::tool_results::capture(&f.root, &w.id, &r, &req, &raw).unwrap();
            let event = p.observe(&req, &raw, &reference, &bind, 0, i);
            if i == 0 {
                assert!(event.is_none());
            } else {
                assert_eq!(event.unwrap()["sameReadCount"], 2);
            }
        }
        req["arguments"]["startChar"] = json!(4);
        req["stepId"] = json!("new-range");
        assert!(p.observe(&req, &raw, &reference(), &bind, 0, 3).is_none());
        req["name"] = json!("hub_read_analysis_snapshot");
        assert!(!supports(&req));
        assert!(p.observe(&req, &raw, &reference(), &bind, 0, 4).is_none());
        assert!(!supports(
            &json!({"operation":"capability","name":"hub_importFlashcards"})
        ));
    }
    #[test]
    fn exact_repeat_is_observed_without_claiming_stall_or_limiting_execution() {
        let mut p = ReadProgress::default();
        assert!(p
            .observe(&request("c1"), &raw(), &reference(), &binding(), 0, 0)
            .is_none());
        assert!(p
            .observe(&request("c1"), &raw(), &reference(), &binding(), 0, 1)
            .is_none());
        let event = p
            .observe(&request("c2"), &raw(), &reference(), &binding(), 0, 2)
            .unwrap();
        assert_eq!(event["sameReadCount"], 2);
        assert_eq!(event["decision"], "allow");
        assert_eq!(event["stallEstablished"], false);
        assert_eq!(event["modelInternalProgress"], "unknown");
    }
    #[test]
    fn new_range_version_user_requirement_or_generation_is_not_the_same_attempt() {
        let mut p = ReadProgress::default();
        p.observe(&request("a"), &raw(), &reference(), &binding(), 0, 0);
        let mut req = request("b");
        req["startChar"] = json!(4);
        assert!(p
            .observe(&req, &raw(), &reference(), &binding(), 0, 1)
            .is_none());
        let mut source = raw();
        source["excerpt"]["version"]["fingerprint"] = json!("new-version");
        assert!(p
            .observe(&request("c"), &source, &reference(), &binding(), 0, 2)
            .is_none());
        let mut user = binding();
        user["commandWatermark"] = json!(1);
        assert!(p
            .observe(&request("d"), &raw(), &reference(), &user, 0, 3)
            .is_none());
        assert!(p
            .observe(&request("e"), &raw(), &reference(), &binding(), 1, 4)
            .is_none());
    }
    #[test]
    fn canonical_fingerprint_preserves_types_case_whitespace_and_array_order() {
        assert_eq!(digest(&json!({"b":2,"a":1})), digest(&json!({"a":1,"b":2})));
        for (a, b) in [
            (json!({"x":"1"}), json!({"x":1})),
            (json!(["a,b"]), json!(["a", "b"])),
            (json!("Case"), json!("case")),
            (json!(" a"), json!("a")),
            (json!([1, 2]), json!([2, 1])),
        ] {
            assert_ne!(digest(&a), digest(&b));
        }
    }
    #[test]
    fn errors_unknown_versions_polls_and_business_operations_do_not_become_repeat_evidence() {
        let mut p = ReadProgress::default();
        let mut unknown = raw();
        unknown["excerpt"]["version"] = Value::Null;
        assert!(p
            .observe(&request("c"), &unknown, &reference(), &binding(), 0, 0)
            .is_none());
        assert!(p
            .observe(
                &request("c"),
                &json!({"error":"temporarily unavailable"}),
                &reference(),
                &binding(),
                0,
                0
            )
            .is_none());
        for op in [
            "search",
            "inspectDraft",
            "importFlashcards",
            "workingState",
            "traceResult",
        ] {
            let mut req = request("c");
            req["operation"] = json!(op);
            assert!(p
                .observe(&req, &raw(), &reference(), &binding(), 0, 0)
                .is_none());
        }
        assert!(p.recent.is_empty());
    }
    #[test]
    fn old_window_eviction_cannot_reset_any_business_budget_or_claim_cross_restart_progress() {
        let mut p = ReadProgress::default();
        p.observe(&request("first"), &raw(), &reference(), &binding(), 0, 0);
        assert!(p
            .observe(
                &request("later"),
                &raw(),
                &reference(),
                &binding(),
                0,
                AGE_MS + 1
            )
            .is_none());
        for i in 0..20 {
            let mut req = request("distinct");
            req["startChar"] = json!(i + 100);
            p.observe(&req, &raw(), &reference(), &binding(), 0, AGE_MS + 2);
        }
        assert_eq!(p.recent.len(), WINDOW);
        assert!(ReadProgress::default()
            .observe(
                &request("after-restart"),
                &raw(),
                &reference(),
                &binding(),
                0,
                0
            )
            .is_none());
    }
}
