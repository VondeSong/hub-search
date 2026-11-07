//! Safe lifecycle receipts never contain event text, reasoning, IDs or stderr.
//! One bounded final JSON reply is held separately for the existing result
//! consumer. Only a terminal completion within the host deadline releases it.
use serde::Serialize;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use std::time::Instant;

const MAX_LINE: usize = 256 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Receipt {
    pub provider: &'static str,
    pub model: Option<String>,
    pub http_status: Option<u16>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub cached_input_tokens: Option<u64>,
    pub uncached_input_tokens: Option<u64>,
    pub usage_complete: bool,
    pub outcome: &'static str,
    pub phase: &'static str,
    pub elapsed_ms: u64,
    pub input_sent_ms: Option<u64>,
    pub first_event_ms: Option<u64>,
    pub turn_started_ms: Option<u64>,
    pub first_item_ms: Option<u64>,
    pub turn_completed_ms: Option<u64>,
    pub turn_failed_ms: Option<u64>,
    pub error_events: u64,
    pub reported_error: Option<&'static str>,
    pub stream_bytes: u64,
    pub stderr_bytes: u64,
    pub event_count: u64,
    pub discarded_lines: u64,
    pub exit_code: Option<i32>,
}
struct State {
    started: Instant,
    receipt: Receipt,
    line: Vec<u8>,
    oversized: bool,
    last_reply: Option<Value>,
    completed_reply: Option<Value>,
    completed_at: Option<Instant>,
}
#[derive(Clone)]
pub(super) struct Trace(Arc<Mutex<State>>);
impl Trace {
    pub(super) fn new() -> Self {
        Self(Arc::new(Mutex::new(State {
            started: Instant::now(),
            line: Vec::new(),
            oversized: false,
            last_reply: None,
            completed_reply: None,
            completed_at: None,
            receipt: Receipt {
                provider: "codex",
                model: None,
                http_status: None,
                input_tokens: None,
                output_tokens: None,
                total_tokens: None,
                cached_input_tokens: None,
                uncached_input_tokens: None,
                usage_complete: false,
                outcome: "running",
                phase: "starting",
                elapsed_ms: 0,
                input_sent_ms: None,
                first_event_ms: None,
                turn_started_ms: None,
                first_item_ms: None,
                turn_completed_ms: None,
                turn_failed_ms: None,
                error_events: 0,
                reported_error: None,
                stream_bytes: 0,
                stderr_bytes: 0,
                event_count: 0,
                discarded_lines: 0,
                exit_code: None,
            },
        })))
    }
    pub(super) fn input_sent(&self) {
        let mut s = self.0.lock().unwrap_or_else(|e| e.into_inner());
        s.receipt.input_sent_ms = Some(s.started.elapsed().as_millis() as u64);
    }
    pub(super) fn stderr(&self, n: usize) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .receipt
            .stderr_bytes += n as u64;
    }
    pub(super) fn stream(&self, bytes: &[u8]) {
        let mut s = self.0.lock().unwrap_or_else(|e| e.into_inner());
        s.receipt.stream_bytes += bytes.len() as u64;
        for b in bytes {
            if *b == b'\n' {
                let elapsed = s.started.elapsed().as_millis() as u64;
                if !s.oversized {
                    let parsed = serde_json::from_slice::<Value>(&s.line).ok();
                    let kind = parsed.as_ref().and_then(|v| v["type"].as_str());
                    if let Some(kind) = kind.filter(|k| {
                        matches!(
                            *k,
                            "thread.started"
                                | "turn.started"
                                | "turn.completed"
                                | "turn.failed"
                                | "item.started"
                                | "item.updated"
                                | "item.completed"
                                | "error"
                        )
                    }) {
                        s.receipt.event_count += 1;
                        s.receipt.first_event_ms.get_or_insert(elapsed);
                        match kind {
                            "turn.started" => {
                                s.last_reply = None;
                                s.completed_reply = None;
                                s.completed_at = None;
                                s.receipt.turn_completed_ms = None;
                                s.receipt.turn_failed_ms = None;
                                s.receipt.turn_started_ms.get_or_insert(elapsed);
                            }
                            "turn.completed" => {
                                if let Some(usage) = parsed.as_ref().and_then(|v| v.get("usage")) {
                                    s.receipt.input_tokens = usage["input_tokens"].as_u64();
                                    s.receipt.output_tokens = usage["output_tokens"].as_u64();
                                    s.receipt.total_tokens = s
                                        .receipt
                                        .input_tokens
                                        .zip(s.receipt.output_tokens)
                                        .map(|(i, o)| i + o);
                                }
                                s.receipt.turn_completed_ms.get_or_insert(elapsed);
                                s.completed_reply = s.last_reply.take();
                                s.completed_at = Some(Instant::now());
                            }
                            "turn.failed" | "error" => {
                                s.completed_reply = None;
                                s.completed_at = None;
                                s.receipt.error_events += 1;
                                if kind == "turn.failed" {
                                    s.receipt.turn_failed_ms.get_or_insert(elapsed);
                                }
                                if let Some(category) = parsed
                                    .as_ref()
                                    .and_then(|v| {
                                        v["error"]["message"]
                                            .as_str()
                                            .or_else(|| v["message"].as_str())
                                    })
                                    .and_then(failure_category)
                                {
                                    s.receipt.reported_error = Some(category);
                                }
                            }
                            "item.started" | "item.updated" | "item.completed" => {
                                s.receipt.first_item_ms.get_or_insert(elapsed);
                                if let Some(item) = parsed
                                    .as_ref()
                                    .map(|v| &v["item"])
                                    .filter(|v| v["type"].as_str() == Some("agent_message"))
                                {
                                    // Never collect reasoning or partial messages. A later
                                    // invalid/oversized final message invalidates the candidate.
                                    s.last_reply = if kind == "item.completed" {
                                        item["text"]
                                            .as_str()
                                            .filter(|text| text.len() <= super::MAX_OUTPUT_BYTES)
                                            .and_then(|text| serde_json::from_str(text).ok())
                                    } else {
                                        None
                                    };
                                }
                            }
                            _ => {}
                        }
                    } else {
                        s.receipt.discarded_lines += 1;
                        s.last_reply = None;
                        s.completed_reply = None;
                        s.completed_at = None;
                    }
                } else {
                    s.receipt.discarded_lines += 1;
                    s.last_reply = None;
                    s.completed_reply = None;
                    s.completed_at = None;
                }
                s.line.clear();
                s.oversized = false;
            } else if !s.oversized {
                if s.line.len() < MAX_LINE {
                    s.line.push(*b);
                } else {
                    s.line.clear();
                    s.oversized = true;
                }
            }
        }
    }
    pub(super) fn finish(&self, outcome: &'static str, exit_code: Option<i32>) -> Receipt {
        let s = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let mut r = s.receipt.clone();
        r.elapsed_ms = s.started.elapsed().as_millis() as u64;
        r.outcome = outcome;
        r.exit_code = exit_code;
        r.phase = if r.turn_completed_ms.is_some() {
            "waitingForExit"
        } else if r.first_item_ms.is_some() {
            "receivingItems"
        } else if r.turn_started_ms.is_some() {
            "waitingForModel"
        } else if r.input_sent_ms.is_some() {
            "waitingForTurn"
        } else {
            "sendingInput"
        };
        r
    }
    pub(super) fn reported_error(&self) -> Option<&'static str> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .receipt
            .reported_error
    }
    pub(super) fn completed_output(&self, deadline: Instant) -> Option<Value> {
        let s = self.0.lock().unwrap_or_else(|e| e.into_inner());
        s.completed_at.filter(|at| *at <= deadline)?;
        s.completed_reply.clone()
    }
}

#[test]
fn final_output_requires_terminal_completion_and_never_uses_reasoning_or_late_events() {
    let t = Trace::new();
    let deadline = Instant::now() + std::time::Duration::from_secs(10);
    t.stream(b"{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"{\\\"answer\\\":true}\"}}\n");
    assert!(t.completed_output(deadline).is_none());
    t.stream(b"{\"type\":\"turn.completed\"}\n");
    assert_eq!(
        t.completed_output(deadline),
        Some(serde_json::json!({"answer":true}))
    );
    assert!(t
        .completed_output(Instant::now() - std::time::Duration::from_secs(1))
        .is_none());
    assert!(!serde_json::to_string(&t.finish("completedOutput", None))
        .unwrap()
        .contains("answer"));
    t.stream(b"{\"type\":\"turn.started\"}\n{\"type\":\"item.completed\",\"item\":{\"type\":\"reasoning\",\"text\":\"{\\\"answer\\\":true}\"}}\n{\"type\":\"turn.completed\"}\n");
    assert!(t.completed_output(deadline).is_none());
    t.stream(b"{\"type\":\"turn.started\"}\n{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"{\\\"answer\\\":true}\"}}\n");
    t.stream(&vec![b'x'; MAX_LINE + 1]);
    t.stream(b"\n{\"type\":\"turn.completed\"}\n");
    assert!(
        t.completed_output(deadline).is_none(),
        "an unobserved oversized final message cannot reuse an earlier candidate"
    );
}

pub(super) fn failure_category(text: &str) -> Option<&'static str> {
    let text = text.to_ascii_lowercase();
    if text.contains("401") || text.contains("login") || text.contains("authentication") {
        Some("authentication")
    } else if text.contains("429") || text.contains("usage limit") {
        Some("quota")
    } else if text.contains("model")
        && (text.contains("not supported") || text.contains("not found") || text.contains("access"))
    {
        Some("modelUnavailable")
    } else {
        None
    }
}

#[test]
fn only_cli_error_events_classify_failures_and_never_retain_messages() {
    let t = Trace::new();
    t.stream(b"{\"type\":\"item.completed\",\"item\":{\"text\":\"401 authentication PRIVATE_MESSAGE\"}}\n");
    assert_eq!(t.reported_error(), None);
    t.stream(
        b"{\"type\":\"turn.failed\",\"error\":{\"message\":\"429 usage limit PRIVATE_MESSAGE\"}}\n",
    );
    assert_eq!(t.reported_error(), Some("quota"));
    let r = t.finish("failed", Some(1));
    assert_eq!(r.error_events, 1);
    assert!(r.turn_failed_ms.is_some());
    assert!(!serde_json::to_string(&r)
        .unwrap()
        .contains("PRIVATE_MESSAGE"));
}

#[test]
fn fragmented_events_keep_facts_without_content_or_deadline_authority() {
    let t = Trace::new();
    t.input_sent();
    t.stream(b"{\"type\":\"turn.sta");
    t.stream(b"rted\"}\n{\"type\":\"item.completed\",\"item\":{\"type\":\"reasoning\",\"text\":\"PRIVATE_SECRET\"}}\n");
    t.stderr(123);
    let r = t.finish("callTimeout", None);
    assert_eq!(r.event_count, 2);
    assert_eq!(r.phase, "receivingItems");
    let saved = serde_json::to_string(&r).unwrap();
    assert!(!saved.contains("PRIVATE_SECRET") && !saved.contains("reasoning"));
    assert_eq!(r.stderr_bytes, 123);
}
#[test]
fn oversized_or_untrusted_content_cannot_forge_lifecycle_events() {
    let t = Trace::new();
    t.input_sent();
    t.stream(&vec![b'x'; MAX_LINE + 2]);
    t.stream(b"\n{\"type\":\"item.completed\",\"item\":{\"text\":\"turn.completed\"}}\n{\"type\":\"turn.completed\"}\n");
    let r = t.finish("success", Some(0));
    assert_eq!(r.discarded_lines, 1);
    assert_eq!(r.event_count, 2);
    assert_eq!(r.phase, "waitingForExit");
    assert!(r.turn_completed_ms.is_some());
}
