//! Bounded facts from the original transport, active only in an explicit probe.
//! Never store request arguments, endpoints, headers, response text or secrets.
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Instant;

const MAX_REQUESTS: usize = 64;
tokio::task_local! { pub(super) static TRACE: Arc<Trace>; }

pub(super) struct Trace {
    started: Instant,
    state: Mutex<State>,
}
struct State {
    round: u64,
    phase: &'static str,
    completed_rounds: u64,
    requests: Vec<Value>,
    next_request: u64,
}
impl Trace {
    pub(super) fn new() -> Arc<Self> {
        Arc::new(Self {
            started: Instant::now(),
            state: Mutex::new(State {
                round: 0,
                phase: "preflight",
                completed_rounds: 0,
                requests: Vec::new(),
                next_request: 0,
            }),
        })
    }
    pub(super) fn snapshot(&self) -> Value {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        json!({"version":1,"elapsedMs":self.started.elapsed().as_millis() as u64,
            "round":state.round,"phase":state.phase,"completedRounds":state.completed_rounds,
            "requestCount":state.next_request,"requestsTruncated":state.next_request > MAX_REQUESTS as u64,
            "requests":state.requests})
    }
}
pub(super) fn phase(phase: &'static str, round: u64) {
    let _ = TRACE.try_with(|trace| {
        let mut state = trace.state.lock().unwrap_or_else(|e| e.into_inner());
        state.phase = phase;
        state.round = round;
    });
}
pub(super) fn completed_round() {
    let _ = TRACE.try_with(|trace| {
        trace
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .completed_rounds += 1;
    });
}

pub(crate) struct Request {
    trace: Option<Arc<Trace>>,
    record: Value,
    started: Instant,
}
impl Request {
    pub(crate) fn begin(payload: &Value) -> Self {
        let trace = TRACE.try_with(Arc::clone).ok();
        let mut record = Value::Null;
        if let Some(trace) = &trace {
            let mut state = trace.state.lock().unwrap_or_else(|e| e.into_inner());
            state.next_request += 1;
            let method = match payload["method"].as_str() {
                Some("initialize") => "initialize",
                Some("tools/list") => "toolsList",
                Some("notifications/initialized") => "initialized",
                Some("tools/call") if payload["params"]["name"] == "craft_read" => {
                    match payload["params"]["arguments"]["command"].as_str() {
                        Some("connection info") => "connectionInfo",
                        Some(c) if c.starts_with("blocks get ") && c.contains("--format json") => {
                            "structuredPage"
                        }
                        Some(c)
                            if c.starts_with("blocks get ") && c.contains("--format markdown") =>
                        {
                            "markdownPage"
                        }
                        _ => "otherRead",
                    }
                }
                _ => "other",
            };
            record = json!({"sequence":state.next_request,"round":state.round,"phase":state.phase,
                "method":method,"requestId":payload["id"].as_u64(),"outcome":"interrupted"});
        }
        Self {
            trace,
            record,
            started: Instant::now(),
        }
    }
    pub(crate) fn response(&mut self, status: reqwest::StatusCode) {
        if self.trace.is_some() {
            self.record["httpStatus"] = json!(status.as_u16());
        }
    }
    pub(crate) fn transport_error(&mut self, error: &reqwest::Error) {
        self.failed(if error.is_timeout() {
            "timeout"
        } else if error.is_connect() {
            "connect"
        } else if error.is_body() {
            "body"
        } else if error.is_decode() {
            "decode"
        } else {
            "transport"
        });
    }
    pub(crate) fn failed(&mut self, category: &'static str) {
        if self.trace.is_some() {
            self.record["outcome"] = json!(category);
        }
    }
    pub(crate) fn completed(&mut self, body: &Value) {
        self.failed(if body.get("error").is_some() {
            "rpcError"
        } else if body["result"]["isError"].as_bool() == Some(true) {
            "toolError"
        } else {
            "completed"
        });
    }
}
impl Drop for Request {
    fn drop(&mut self) {
        if let Some(trace) = &self.trace {
            self.record["elapsedMs"] = json!(self.started.elapsed().as_millis() as u64);
            let mut state = trace.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.requests.len() < MAX_REQUESTS {
                state.requests.push(self.record.take());
            }
        }
    }
}
