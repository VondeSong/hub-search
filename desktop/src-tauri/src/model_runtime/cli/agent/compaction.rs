//! Native compaction shares its admitted Run; an acknowledgement is not completion.
use serde_json::{json, Value};
use std::collections::HashMap;

#[derive(Default)]
struct Requested {
    started_turns: std::collections::HashSet<String>,
    turn: Option<String>,
    item: Option<String>,
    item_done: bool,
}
impl Requested {
    fn event(&mut self, thread: &str, method: &str, p: &Value) -> Result<bool, String> {
        if p["threadId"] != thread {
            return Ok(false);
        }
        if method == "turn/started" {
            let turn = p["turn"]["id"]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 256)
                .ok_or("整理回合身份无效")?;
            if self.started_turns.len() >= 64 && !self.started_turns.contains(turn) {
                return Err("整理期间回合数量超过容量，未继续模型".into());
            }
            self.started_turns.insert(turn.to_string());
        }
        if matches!(method, "item/started" | "item/completed")
            && p["item"]["type"] == "contextCompaction"
        {
            let turn = p["turnId"].as_str().unwrap_or_default();
            if !self.started_turns.contains(turn) {
                return Err("整理事件缺少匹配的回合开始，未继续模型".into());
            }
            if method == "item/started" && self.turn.is_none() {
                self.turn = Some(turn.to_string());
            }
            if self.turn.as_deref() != Some(turn) {
                return Err("整理事件缺少匹配的整理回合，未继续模型".into());
            }
            let id = p["item"]["id"]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 256)
                .ok_or("整理事件身份无效")?;
            if self.item.as_deref().is_some_and(|old| old != id) {
                return Err("整理事件身份改变，未继续模型".into());
            }
            if method == "item/started" {
                self.item = Some(id.to_string());
            } else {
                if self.item.as_deref() != Some(id) {
                    return Err("没有匹配的整理开始，未继续模型".into());
                }
                self.item_done = true;
            }
        }
        if method == "turn/completed"
            && self.turn.as_deref() == p["turn"]["id"].as_str()
            && self.turn.is_some()
        {
            if p["turn"]["status"] != "completed" || !self.item_done {
                return Err("原生整理未完成，进展已保留".into());
            }
            return Ok(true);
        }
        if method == "turn/completed" {
            if let Some(turn) = p["turn"]["id"].as_str() {
                self.started_turns.remove(turn);
            }
        }
        Ok(false)
    }
}

pub(super) fn request(
    process: &mut super::Process,
    thread: &str,
    control: &super::Control,
    host: &mut impl FnMut(&str, &Value) -> Result<Value, String>,
) -> Result<Observed, String> {
    host(
        "contextLifecycle",
        &json!({"schemaVersion":1,"threadId":thread,"state":"requested","origin":"hostRequest","hostRequested":true,"budgetReset":false}),
    )?;
    let ack = process.rpc(
        "compact",
        "thread/compact/start",
        json!({"threadId":thread}),
        control,
    )?;
    if !ack.as_object().is_some_and(|v| v.is_empty()) {
        return Err("原生整理确认格式不受支持，未继续模型".into());
    }
    host(
        "contextLifecycle",
        &json!({"schemaVersion":1,"threadId":thread,"state":"acknowledged","origin":"hostRequest","hostRequested":true,"completionProven":false}),
    )?;
    let mut state = Requested::default();
    let mut observed = Observed::default();
    let mut count = 0usize;
    loop {
        control.check()?;
        let Some(event) = process.receive(control)? else {
            continue;
        };
        count += 1;
        if count > 256 {
            return Err("原生整理事件超过容量，进展已保留".into());
        }
        let method = event["method"].as_str().unwrap_or_default();
        let p = &event["params"];
        if event.get("id").is_some() && !method.is_empty() {
            process.send(json!({"id":event["id"],"error":{"code":-32601,"message":"Tools are unavailable during context compaction"}}))?;
            return Err("整理期间出现工具调用，未执行或重放动作".into());
        }
        if p["threadId"] != thread {
            continue;
        }
        if method == "thread/tokenUsage/updated" {
            host("usage", &p["tokenUsage"])?;
        }
        if method == "error" {
            return Err("原生整理返回错误，已有进展已保留".into());
        }
        let done = state.event(thread, method, p)?;
        if let Some(mut value) = observed.event(thread, method, p)? {
            value["hostRequested"] = json!(true);
            value["origin"] = json!("hostRequest");
            value["state"] = json!(if method == "item/completed" {
                "itemCompleted"
            } else {
                "started"
            });
            host("contextLifecycle", &value)?;
        }
        if done {
            host(
                "contextLifecycle",
                &json!({"schemaVersion":1,"threadId":thread,"turnId":state.turn,"itemId":state.item,"state":"completed","origin":"hostRequest","hostRequested":true,"completionProven":true,"budgetReset":false}),
            )?;
            return Ok(observed);
        }
    }
}
#[derive(Default, Debug)]
pub(super) struct Observed {
    items: HashMap<(String, String), bool>,
}
impl Observed {
    pub(super) fn event(
        &mut self,
        thread: &str,
        method: &str,
        p: &Value,
    ) -> Result<Option<Value>, String> {
        if !matches!(method, "item/started" | "item/completed")
            || p["item"]["type"] != "contextCompaction"
            || p["threadId"] != thread
        {
            return Ok(None);
        }
        let identity = |v: &Value| {
            v.as_str()
                .filter(|s| !s.is_empty() && s.len() <= 256)
                .map(str::to_owned)
                .ok_or_else(|| "原生压缩事件身份无效".to_string())
        };
        let turn = identity(&p["turnId"])?;
        let item = identity(&p["item"]["id"])?;
        let completed = method == "item/completed";
        let key = (turn.clone(), item.clone());
        let old = self.items.get(&key).copied();
        // Duplicate completion or delayed start never regresses a terminal observation.
        if old == Some(true) || old == Some(completed) {
            return Ok(None);
        }
        if old.is_none() && self.items.len() >= 64 {
            return Err("原生压缩事件数量超过容量，进展已保留".into());
        }
        self.items.insert(key, completed);
        Ok(Some(
            json!({"schemaVersion":1,"provider":"codex-app-server","threadId":thread,"turnId":turn,"itemId":item,
          "state":if completed {"completed"}else{"started"},"observedStart":old==Some(false)||!completed,
          "origin":"publicLifecycle","hostRequested":false,"baselineState":"unknown","privateSummaryAvailable":false,
          "providerTimestampMs":p[if completed {"completedAtMs"}else{"startedAtMs"}].as_i64()}),
        ))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn event(turn: &str) -> Value {
        json!({"threadId":"own","turnId":turn,"item":{"type":"contextCompaction","id":"compact-1","content":"PRIVATE_MUST_NOT_LEAK"},"startedAtMs":10,"completedAtMs":20})
    }
    #[test]
    fn same_thread_independent_turn_is_observed_without_claiming_a_host_request() {
        let mut o = Observed::default();
        let a = o
            .event("own", "item/started", &event("other-turn"))
            .unwrap()
            .unwrap();
        assert_eq!(a["state"], "started");
        assert_eq!(a["hostRequested"], false);
        assert_eq!(a["baselineState"], "unknown");
        assert!(!a.to_string().contains("PRIVATE"));
        let b = o
            .event("own", "item/completed", &event("other-turn"))
            .unwrap()
            .unwrap();
        assert_eq!(b["state"], "completed");
        assert_eq!(b["observedStart"], true);
    }
    #[test]
    fn foreign_unbound_ack_and_deprecated_events_do_not_prove_completion() {
        let mut o = Observed::default();
        let mut e = event("t");
        for method in ["thread/compact/start", "thread/compacted", "turn/completed"] {
            assert!(o.event("own", method, &e).unwrap().is_none());
        }
        e["threadId"] = json!("foreign");
        assert!(o.event("own", "item/completed", &e).unwrap().is_none());
        e.as_object_mut().unwrap().remove("threadId");
        assert!(o.event("own", "item/completed", &e).unwrap().is_none());
    }
    #[test]
    fn duplicate_and_out_of_order_events_do_not_regress_or_invent_start() {
        let mut o = Observed::default();
        let e = event("t");
        let done = o.event("own", "item/completed", &e).unwrap().unwrap();
        assert_eq!(done["observedStart"], false);
        assert!(o.event("own", "item/started", &e).unwrap().is_none());
        assert!(o.event("own", "item/completed", &e).unwrap().is_none());
        assert!(o
            .event("own", "item/started", &event("t2"))
            .unwrap()
            .is_some());
    }
    #[test]
    fn malformed_and_unbounded_lifecycle_fails_closed() {
        let mut o = Observed::default();
        let mut e = event("t");
        e["turnId"] = json!("");
        assert!(o.event("own", "item/started", &e).is_err());
        for n in 0..64 {
            o.event("own", "item/started", &event(&format!("t{n}")))
                .unwrap();
        }
        assert!(o.event("own", "item/started", &event("overflow")).is_err());
        assert!(o
            .event("own", "item/completed", &event("t0"))
            .unwrap()
            .is_some());
    }
    #[test]
    fn requested_compaction_requires_paired_lifecycle_and_own_completed_turn() {
        let mut s = Requested::default();
        assert!(!s
            .event("own", "thread/compact/start", &json!({"threadId":"own"}))
            .unwrap());
        assert!(s.event("own", "item/completed", &event("t")).is_err());
        s.event(
            "own",
            "turn/started",
            &json!({"threadId":"own","turn":{"id":"t"}}),
        )
        .unwrap();
        assert!(!s
            .event(
                "own",
                "turn/completed",
                &json!({"threadId":"foreign","turn":{"id":"t","status":"completed"}})
            )
            .unwrap());
        s.event("own", "item/started", &event("t")).unwrap();
        s.event("own", "item/completed", &event("t")).unwrap();
        assert!(!s.event("own", "item/started", &event("t")).unwrap());
        assert!(s
            .event(
                "own",
                "turn/completed",
                &json!({"threadId":"own","turn":{"id":"t","status":"completed"}})
            )
            .unwrap());
    }
    #[test]
    fn request_failure_and_unmatched_completion_cannot_start_next_turn() {
        let mut s = Requested::default();
        s.event(
            "own",
            "turn/started",
            &json!({"threadId":"own","turn":{"id":"t"}}),
        )
        .unwrap();
        assert!(s
            .event(
                "own",
                "turn/completed",
                &json!({"threadId":"own","turn":{"id":"t","status":"completed"}})
            )
            .is_ok());
        assert!(s.event("own", "item/started", &event("other")).is_err());
        assert!(s
            .event(
                "own",
                "turn/started",
                &json!({"threadId":"own","turn":{"id":"new"}})
            )
            .is_ok());
    }
    #[test]
    fn resumed_goal_turn_does_not_own_compaction() {
        let mut s = Requested::default();
        for turn in ["goal", "compact"] {
            assert!(!s.event("own", "turn/started", &json!({"threadId":"own","turn":{"id":turn}})).unwrap());
        }
        assert!(!s.event("own", "turn/completed", &json!({"threadId":"own","turn":{"id":"goal","status":"interrupted"}})).unwrap());
        s.event("own", "item/started", &event("compact")).unwrap();
        s.event("own", "item/completed", &event("compact")).unwrap();
        assert!(s.event("own", "turn/completed", &json!({"threadId":"own","turn":{"id":"compact","status":"completed"}})).unwrap());
    }
    #[test]
    fn completed_unrelated_turn_cannot_later_claim_compaction() {
        let mut s = Requested::default();
        s.event("own", "turn/started", &json!({"threadId":"own","turn":{"id":"old"}})).unwrap();
        s.event("own", "turn/completed", &json!({"threadId":"own","turn":{"id":"old","status":"completed"}})).unwrap();
        assert!(s.event("own", "item/started", &event("old")).is_err());
    }
    #[cfg(windows)]
    fn process(events: Vec<Value>) -> super::super::Process {
        use std::os::windows::process::CommandExt;
        use std::process::{Command, Stdio};
        let mut child =
            Command::new(std::env::var_os("COMSPEC").unwrap_or_else(|| "cmd.exe".into()))
                .args(["/d", "/c", "more > NUL"])
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(0x08000000)
                .spawn()
                .unwrap();
        let input = child.stdin.take().unwrap();
        let (tx, rx) = std::sync::mpsc::sync_channel(32);
        for e in events {
            tx.send(Ok(e)).unwrap();
        }
        drop(tx);
        let auth =
            std::env::temp_dir().join(format!("hub-test-auth-{}", crate::random_url_safe(18)));
        let auth_file = super::super::authentication::snapshot(&auth, b"{}").unwrap();
        super::super::Process {
            child,
            input,
            output: rx,
            readers: vec![],
            auth,
            _auth_file: auth_file,
            login: None,
            pending: Default::default(),
            group: None,
        }
    }
    #[cfg(windows)]
    #[test]
    fn request_driver_defers_early_events_accounts_usage_and_never_treats_ack_as_done() {
        let start = json!({"method":"turn/started","params":{"threadId":"own","turn":{"id":"compact-turn"}}});
        let item = |method: &str| json!({"method":method,"params":event("compact-turn")});
        let mut p = process(vec![
            start,
            item("item/started"),
            json!({"id":"compact","result":{}}),
            item("item/completed"),
            json!({"method":"thread/tokenUsage/updated","params":{"threadId":"own","tokenUsage":{"total":{"inputTokens":21}}}}),
            json!({"method":"turn/completed","params":{"threadId":"own","turn":{"id":"compact-turn","status":"completed"}}}),
        ]);
        let mut callbacks = vec![];
        request(
            &mut p,
            "own",
            &super::super::Control::bounded(std::time::Duration::from_secs(2)),
            &mut |kind, v| {
                callbacks.push((kind.to_owned(), v.clone()));
                Ok(Value::Null)
            },
        )
        .unwrap();
        assert_eq!(
            callbacks
                .iter()
                .filter(|(_, v)| v["completionProven"] == true)
                .count(),
            1
        );
        assert!(callbacks
            .iter()
            .any(|(k, v)| k == "usage" && v["total"]["inputTokens"] == 21));
        assert_eq!(callbacks.last().unwrap().1["state"], "completed");
        let mut ack_only = process(vec![json!({"id":"compact","result":{}})]);
        assert!(request(
            &mut ack_only,
            "own",
            &super::super::Control::bounded(std::time::Duration::from_secs(1)),
            &mut |_, _| Ok(Value::Null)
        )
        .is_err());
    }
    #[cfg(windows)]
    #[test]
    fn request_driver_rejects_tools_and_cancellation_without_replay() {
        let mut p = process(vec![
            json!({"id":"compact","result":{}}),
            json!({"id":"tool","method":"item/tool/call","params":{"threadId":"own","tool":"save"}}),
        ]);
        assert!(request(
            &mut p,
            "own",
            &super::super::Control::bounded(std::time::Duration::from_secs(2)),
            &mut |_, _| Ok(Value::Null)
        )
        .unwrap_err()
        .contains("未执行或重放"));
        let mut p = process(vec![]);
        let control = super::super::Control::default();
        control.cancel();
        assert!(request(&mut p, "own", &control, &mut |_, _| Ok(Value::Null)).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn compaction_wait_uses_native_generation_ceiling_before_host_deadline() {
        let mut p = process(vec![]);
        let (tx, rx) = std::sync::mpsc::sync_channel(2);
        p.output = rx;
        p.pending.push_back(json!({"id":"compact","result":{}}));
        let mut parent = super::super::Control::bounded(std::time::Duration::from_secs(2));
        parent.generation_ceiling = Some(std::time::Duration::from_millis(10));
        let child = parent.native_turn_control();
        let result = request(&mut p, "own", &child, &mut |_, _| Ok(Value::Null));
        drop(tx);
        assert_eq!(
            result.unwrap_err(),
            crate::model_runtime::cli::GENERATION_TIMEOUT
        );
        assert!(parent.check().is_ok());
    }
}
