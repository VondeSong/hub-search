use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;
fn fixture(
    status: u16,
    body: String,
    delay: Duration,
) -> (String, std::thread::JoinHandle<String>) {
    fixture_parts(status, vec![(body, delay)])
}
fn fixture_parts(
    status: u16,
    parts: Vec<(String, Duration)>,
) -> (String, std::thread::JoinHandle<String>) {
    fixture_parts_held(status, parts, Duration::ZERO)
}
fn fixture_parts_held(
    status: u16,
    parts: Vec<(String, Duration)>,
    hold: Duration,
) -> (String, std::thread::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let join = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut buf = [0; 4096];
        loop {
            let n = stream.read(&mut buf).unwrap();
            if n == 0 {
                break;
            }
            bytes.extend_from_slice(&buf[..n]);
            if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&bytes[..end]);
                let len = head
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .and_then(|n| n.trim().parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                if bytes.len() >= end + 4 + len {
                    break;
                }
            }
        }
        let length = if hold.is_zero() {
            format!(
                "Content-Length: {}\r\n",
                parts.iter().map(|(s, _)| s.len()).sum::<usize>()
            )
        } else {
            String::new()
        };
        let head=format!("HTTP/1.1 {status} Test\r\nContent-Type: text/event-stream\r\n{length}Connection: close\r\n\r\n");
        let _ = stream.write_all(head.as_bytes());
        for (part, delay) in parts {
            std::thread::sleep(delay);
            if stream.write_all(part.as_bytes()).is_err() {
                break;
            }
            let _ = stream.flush();
        }
        std::thread::sleep(hold);
        String::from_utf8(bytes).unwrap()
    });
    (url, join)
}
fn completion_schema() -> Value {
    json!({"type":"object","additionalProperties":false,"properties":{"report":{"anyOf":[
        {"type":"object","additionalProperties":false,"properties":{"completion":{"anyOf":[
            {"type":"object","additionalProperties":false,"required":["goalBinding","items"],
             "properties":{"goalBinding":{"type":"object"},"items":{"type":"array"}}},
            {"type":"null"}
        ]}}},{"type":"null"}
    ]}}})
}

#[test]
fn empty_completion_placeholders_are_removed_before_strict_stream_validation() {
    let schema = completion_schema();
    let expected = json!({"report":{"completion":{"goalBinding":{"workRevision":3},"items":[{"refs":["actual-proof"],"status":"satisfied"}]}}});
    let mut padded = expected.clone();
    padded["report"]["completion"]["note"] = Value::Null;
    padded["report"]["completion"]["completion"] = Value::Null;
    padded["report"]["completion"]["goalBindingAdditional"] = Value::Null;
    padded["report"]["completion"]["providerPadding"] = Value::Null;
    padded["report"]["completion"]["itemCount"] = json!(1);
    assert!(super::super::schema::validate(&padded, &schema).is_err());
    let (url, server) = fixture(200, response(&padded.to_string(), "stop"), Duration::ZERO);
    let result = run_at(
        &url,
        "fixture-secret",
        &json!({}),
        &schema,
        &Control::default(),
    )
    .unwrap();
    server.join().unwrap();
    assert_eq!(
        result, expected,
        "binding, requirements and proof references must remain exact"
    );
}

#[test]
fn completion_placeholder_compatibility_preserves_all_other_rejections_and_contracts() {
    let schema = completion_schema();
    let valid = json!({"report":{"completion":{"goalBinding":{},"items":[]}}});
    for (field, value) in [
        ("note", json!("not empty")),
        ("completion", json!({})),
        ("unknown", json!(false)),
        ("itemCount", json!(1)),
        ("itemCount", json!("0")),
        ("itemCount", json!(-1)),
    ] {
        let mut candidate = valid.clone();
        candidate["report"]["completion"][field] = value;
        let original = candidate.clone();
        canonicalize_completion_placeholders(&mut candidate, &schema);
        assert_eq!(candidate, original);
        assert!(super::super::schema::validate(&candidate, &schema).is_err());
    }
    let mut wrong_binding = valid.clone();
    wrong_binding["report"]["completion"]["goalBinding"] = Value::Null;
    wrong_binding["report"]["completion"]["note"] = Value::Null;
    canonicalize_completion_placeholders(&mut wrong_binding, &schema);
    assert!(wrong_binding["report"]["completion"]["goalBinding"].is_null());
    assert!(super::super::schema::validate(&wrong_binding, &schema).is_err());
    let mut other = schema.clone();
    other
        .pointer_mut("/properties/report/anyOf/0/properties/completion/anyOf/0/properties")
        .unwrap()["note"] = json!({"type":"null"});
    let mut candidate = valid.clone();
    candidate["report"]["completion"]["note"] = Value::Null;
    let original = candidate.clone();
    canonicalize_completion_placeholders(&mut candidate, &other);
    assert_eq!(
        candidate, original,
        "never rewrite an unrelated or expanded contract"
    );
    super::super::schema::validate(&candidate, &other).unwrap();
    let mut candidate = valid;
    candidate["report"]["note"] = Value::Null;
    canonicalize_completion_placeholders(&mut candidate, &schema);
    assert!(super::super::schema::validate(&candidate, &schema).is_err());
}

fn json_response(content: &str, reason: &str) -> String {
    json!({"model":"deepseek-flash","choices":[{"finish_reason":reason,"message":{"content":content,"reasoning_content":"PRIVATE_REASONING"}}],"usage":{"prompt_tokens":29,"completion_tokens":8,"total_tokens":37}}).to_string()
}
fn response(content: &str, reason: &str) -> String {
    let raw: Value = serde_json::from_str(&json_response(content, reason)).unwrap();
    format!(
        "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
        json!({"choices":[{"index":0,"delta":{"reasoning_content":"PRIVATE_REASONING","content":content},"finish_reason":null}]}),
        json!({"model":raw["model"],"choices":[{"index":0,"delta":{},"finish_reason":reason}],"usage":raw["usage"]})
    )
}
pub(super) fn framing_response() -> String {
    let frame = format!(
        "data: {}\n\n",
        json!({"id":"a".repeat(64),"object":"chat.completion.chunk","created":1718345013,"model":"deepseek-flash","system_fingerprint":"f".repeat(32),"choices":[{"index":0,"delta":{"reasoning_content":"r"},"finish_reason":null,"logprobs":null}]})
    );
    format!(
        "{}{}",
        frame.repeat(7000),
        response("{\"answer\":\"ok\"}", "stop")
    )
}
#[test]
fn http_stream_accepts_framing_overhead_above_the_catalog_response_limit() {
    let wire = framing_response();
    assert!(wire.len() > 2 * 1024 * 1024);
    let (url, server) = fixture(200, wire, Duration::ZERO);
    let control = Control::default();
    assert_eq!(
        run_at(&url, "fixture-secret", &json!({}), &schema(), &control).unwrap()["answer"],
        "ok"
    );
    server.join().unwrap();
    assert!(control.execution_receipts()[0].stream_bytes > 2 * 1024 * 1024);
}
fn settings() -> Settings {
    Settings {
        provider: "deepseek".into(),
        model: "deepseek-flash".into(),
        reasoning_effort: "none".into(),
        ..Settings::default()
    }
}
#[test]
fn http_stream_publishes_before_completion_and_retains_final_validation() {
    let prefix = format!(
        "data: {}\n\n",
        json!({"choices":[{"index":0,"delta":{"content":"{\"rationale\":\"核对事实\",\"report\":{\"markdown\":\"实时片段"},"finish_reason":null}]})
    );
    let suffix = format!(
        "data: {}\n\ndata: [DONE]\n\n",
        json!({"choices":[{"index":0,"delta":{"content":"已完成\"}}"},"finish_reason":"stop"}]})
    );
    let (url, server) = fixture_parts(
        200,
        vec![
            (prefix, Duration::from_millis(180)),
            (suffix, Duration::from_millis(350)),
        ],
    );
    let mut early = false;
    let start = Instant::now();
    let mut events = vec![];
    let schema = json!({"type":"object","required":["rationale","report"],"properties":{"rationale":{"type":"string"},"report":{"type":"object"}}});
    let value = run_at_stream(
        &url,
        "fixture-secret",
        &json!({}),
        &schema,
        &Control::default(),
        &mut |event| {
            if event["kind"] == "answer" && event["text"] == "实时片段" {
                early = start.elapsed() < Duration::from_millis(500);
            }
            events.push(event.clone());
            Ok(())
        },
    )
    .unwrap();
    server.join().unwrap();
    assert!(early);
    assert_eq!(value["report"]["markdown"], "实时片段已完成");
    assert!(events
        .iter()
        .any(|e| e["kind"] == "reasoning" && e["text"] == "核对事实"));
    // A preview is not a validated result: missing required answer still fails.
    let (url, server) = fixture(
        200,
        response(
            "{\"rationale\":\"说明\",\"report\":{\"markdown\":\"未核验\"}}",
            "stop",
        ),
        Duration::ZERO,
    );
    assert!(run_at_stream(
        &url,
        "fixture-secret",
        &json!({}),
        &super::tests::schema(),
        &Control::default(),
        &mut |_| Ok(())
    )
    .is_err());
    server.join().unwrap();
}
#[test]
fn streamed_preview_cancellation_never_delivers_and_missing_done_preserves_known_usage() {
    let first = format!(
        "data: {}\n\n",
        json!({"choices":[{"index":0,"delta":{"content":"{\"rationale\":\"核对资料\",\"report\":{\"markdown\":\"尚未完成"},"finish_reason":null}]})
    );
    let (url, server) = fixture_parts(
        200,
        vec![
            (first, Duration::from_millis(170)),
            ("data: [DONE]\n\n".into(), Duration::from_millis(350)),
        ],
    );
    let control = Control::bounded(Duration::from_secs(3));
    let mut saw_preview = false;
    let result = run_at_stream(
        &url,
        "fixture-secret",
        &json!({}),
        &schema(),
        &control,
        &mut |event| {
            if event["kind"] == "answer" && event["text"] == "尚未完成" {
                saw_preview = true;
                control.cancel();
            }
            Ok(())
        },
    );
    server.join().unwrap();
    assert!(saw_preview && result.is_err());
    assert_eq!(control.execution_receipts()[0].outcome, "cancelled");
    let broken = response("{\"answer\":\"not-final\"}", "stop").replace("data: [DONE]\n\n", "");
    let (url, server) = fixture(200, broken, Duration::ZERO);
    let control = Control::default();
    assert_eq!(
        run_at(&url, "fixture-secret", &json!({}), &schema(), &control).unwrap_err(),
        TRUNCATED
    );
    server.join().unwrap();
    let receipt = &control.execution_receipts()[0];
    assert_eq!(receipt.total_tokens, Some(37));
    assert_ne!(receipt.outcome, "completedOutput");
}
fn schema() -> Value {
    json!({"type":"object","required":["answer"],"additionalProperties":false,"properties":{"answer":{"type":"string"}}})
}
#[test]
fn done_finishes_before_transport_close_without_skipping_final_validation() {
    for (content, valid) in [("{\"answer\":\"ok\"}", true), ("{}", false)] {
        let (url, server) = fixture_parts_held(
            200,
            vec![(response(content, "stop"), Duration::ZERO)],
            Duration::from_millis(900),
        );
        let control = Control::bounded(Duration::from_millis(500));
        let result = run_at(&url, "fixture-secret", &json!({}), &schema(), &control);
        server.join().unwrap();
        if valid {
            assert_eq!(result.unwrap()["answer"], "ok");
            assert_eq!(control.execution_receipts()[0].outcome, "completedOutput");
        } else {
            assert!(super::super::schema::is_rejection(&result.unwrap_err()));
        }
    }
}
#[test]
fn direct_wire_contract_and_real_response_usage_are_host_validated() {
    let schema = schema();
    let body = body("真实材料是数据", &schema, &settings(), &[], false).unwrap();
    let (url, server) = fixture(
        200,
        response("{\"answer\":\"结果\"}", "stop"),
        Duration::ZERO,
    );
    let control = Control::bounded(Duration::from_secs(2));
    assert_eq!(
        run_at(&url, "test-only-secret", &body, &schema, &control).unwrap()["answer"],
        "结果"
    );
    let request = server.join().unwrap();
    let value: Value = serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert!(request.starts_with("POST /chat/completions "));
    assert!(request
        .to_lowercase()
        .contains("authorization: bearer test-only-secret"));
    assert_eq!(value["messages"][0]["role"], "system");
    assert_eq!(value["messages"][1]["role"], "user");
    assert_eq!(value["response_format"]["type"], "json_object");
    assert_eq!(value["thinking"]["type"], "disabled");
    assert_eq!(value["stream"], true);
    assert_eq!(value["stream_options"]["include_usage"], true);
    let r = &control.execution_receipts()[0];
    assert_eq!(r.input_tokens, Some(29));
    assert_eq!(r.output_tokens, Some(8));
    assert_eq!(r.total_tokens, Some(37));
    assert_eq!(r.outcome, "completedOutput");
    let serialized = serde_json::to_string(r).unwrap();
    for private in ["test-only-secret", "PRIVATE_REASONING", "真实材料", "结果"] {
        assert!(!serialized.contains(private));
    }
}
#[test]
fn auth_balance_rate_limit_and_server_errors_are_distinct_and_never_echo_or_retry() {
    for (status, expected) in [
        (401, AUTH),
        (402, QUOTA),
        (403, AUTH),
        (429, RATE),
        (500, SERVER),
        (400, CAPABILITY),
    ] {
        let (url, server) = fixture(status, "PRIVATE_KEY_AND_INPUT".into(), Duration::ZERO);
        let control = Control::bounded(Duration::from_secs(2));
        assert_eq!(
            run_at(
                &url,
                "fixture-secret",
                &json!({"model":"deepseek-flash"}),
                &schema(),
                &control
            )
            .unwrap_err(),
            expected,
        );
        server.join().unwrap();
        assert_eq!(control.execution_receipts().len(), 1);
        assert!(!serde_json::to_string(&control.execution_receipts())
            .unwrap()
            .contains("PRIVATE"));
    }
}
#[test]
fn malformed_truncated_schema_invalid_and_tool_results_never_deliver() {
    for (body, expected) in [
        ("data: invalid json\n\n".into(), FORMAT),
        (response("not-json", "stop"), FORMAT),
        (response("{}", "length"), TRUNCATED),
        (
            response("{}", "stop"),
            "模型返回格式不符合要求，未提交结果，请重试。",
        ),
    ] {
        let (url, server) = fixture(200, body, Duration::ZERO);
        let control = Control::default();
        let error = run_at(&url, "fixture-secret", &json!({}), &schema(), &control).unwrap_err();
        if expected.starts_with("模型返回格式") {
            assert!(super::super::schema::is_rejection(&error));
            assert!(error.contains("$.answer: required"));
        } else {
            assert_eq!(error, expected);
        }
        server.join().unwrap();
        assert_eq!(control.execution_receipts()[0].outcome, "failed");
    }
}
#[test]
fn cancellation_and_total_deadline_drop_pending_http_and_keep_later_recovery_possible() {
    for cancel in [false, true] {
        let (url, server) = fixture(
            200,
            response("{\"answer\":\"late\"}", "stop"),
            Duration::from_millis(220),
        );
        let control = if cancel {
            Control::bounded(Duration::from_secs(2))
        } else {
            Control::bounded(Duration::from_millis(60))
        };
        let stop = control.clone();
        let stopper = cancel.then(|| {
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(50));
                stop.cancel();
            })
        });
        let at = Instant::now();
        let err = run_at(&url, "fixture-secret", &json!({}), &schema(), &control).unwrap_err();
        assert!(at.elapsed() < Duration::from_millis(200));
        assert!(err.contains(if cancel { "中断" } else { "时限" }));
        if let Some(stop) = stopper {
            stop.join().unwrap();
        }
        server.join().unwrap();
        assert_ne!(control.execution_receipts()[0].outcome, "completedOutput");
    }
    let (url, server) = fixture(
        200,
        response("{\"answer\":\"recovered\"}", "stop"),
        Duration::ZERO,
    );
    assert_eq!(
        run_at(
            &url,
            "fixture-secret",
            &json!({}),
            &schema(),
            &Control::default()
        )
        .unwrap()["answer"],
        "recovered"
    );
    server.join().unwrap();
}
#[test]
fn discovery_and_capabilities_are_explicit() {
    let catalog=parse_models(&serde_json::to_vec(&json!({"data":[{"id":"deepseek-flash","name":"Flash","input_modalities":["text","image"],"effort":{"supported_levels":["low","high","max"]}},{"id":"deepseek-v4-pro","input_modalities":["text"]}]})).unwrap()).unwrap();
    assert_eq!(
        catalog["models"][0]["reasoningLevels"],
        json!(["none", "low", "high", "max"])
    );
    assert!(body(
        "text",
        &schema(),
        &settings(),
        &[PathBuf::from("not-read")],
        false
    )
    .unwrap_err()
    .contains("不支持"));
    assert!(super::super::basic_validate(&Settings {
        fast: true,
        ..settings()
    })
    .is_err());
}

#[test]
fn generation_timeout_and_unknown_connection_outcome_are_not_silent_successes() {
    let (url, server) = fixture(
        200,
        response("{\"answer\":\"late\"}", "stop"),
        Duration::from_millis(1200),
    );
    let control =
        Control::bounded(Duration::from_secs(3)).with_generation_ceiling(Duration::from_secs(1));
    assert_eq!(
        run_at(&url, "fixture-secret", &json!({}), &schema(), &control).unwrap_err(),
        GENERATION_TIMEOUT
    );
    server.join().unwrap();
    assert_eq!(control.execution_receipts()[0].outcome, "callTimeout");
    assert!(super::super::is_retryable_model_error(GENERATION_TIMEOUT));
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut input = [0; 4096];
        let _ = stream.read(&mut input);
    });
    let control = Control::bounded(Duration::from_secs(2));
    assert_eq!(
        run_at(&url, "fixture-secret", &json!({}), &schema(), &control).unwrap_err(),
        NETWORK
    );
    server.join().unwrap();
    assert_eq!(control.execution_receipts()[0].outcome, "resultUnknown");
    assert_eq!(control.execution_receipts().len(), 1);
}

#[test]
fn v4_direct_usage_keeps_raw_cache_counts_and_missing_is_not_zero() {
    let mut receipt = execution::Trace::new().finish("running", None);
    let mut raw: Value =
        serde_json::from_str(&json_response("{\"answer\":\"ok\"}", "stop")).unwrap();
    parse_response(&serde_json::to_vec(&raw).unwrap(), &mut receipt).unwrap();
    assert!(
        !receipt.usage_complete
            && receipt.cached_input_tokens.is_none()
            && receipt.uncached_input_tokens.is_none()
    );
    raw["usage"]["prompt_cache_hit_tokens"] = json!(9);
    raw["usage"]["prompt_cache_miss_tokens"] = json!(20);
    parse_response(&serde_json::to_vec(&raw).unwrap(), &mut receipt).unwrap();
    assert!(receipt.usage_complete);
    raw["usage"]["prompt_cache_miss_tokens"] = json!(21);
    parse_response(&serde_json::to_vec(&raw).unwrap(), &mut receipt).unwrap();
    assert!(!receipt.usage_complete);
    assert_eq!(receipt.uncached_input_tokens, Some(21));
}
#[test]
fn v4_direct_exact_body_admission_precedes_http_and_output_is_capped() {
    let value = body("合成只读材料", &schema(), &settings(), &[], false).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let mut calls = 0;
    let denied_url = format!("http://{}", listener.local_addr().unwrap());
    assert!(run_at_admitted(
        &denied_url,
        "test-only-secret",
        value.clone(),
        &schema(),
        &Control::bounded(Duration::from_secs(2)),
        Some(7),
        &mut |b| {
            calls += 1;
            assert_eq!(b["max_tokens"], 7);
            Err("synthetic durable reserve refusal".into())
        },
        &mut |_| Ok(())
    )
    .is_err());
    assert_eq!(calls, 1);
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    let mut admitted = Value::Null;
    let (url, server) = fixture(200, response("{\"answer\":\"ok\"}", "stop"), Duration::ZERO);
    run_at_admitted(
        &url,
        "test-only-secret",
        value,
        &schema(),
        &Control::bounded(Duration::from_secs(3)),
        Some(17),
        &mut |b| {
            admitted = b.clone();
            Ok(())
        },
        &mut |_| Ok(()),
    )
    .unwrap();
    let wire = server.join().unwrap();
    let actual: Value = serde_json::from_str(wire.split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(actual, admitted);
    assert_eq!(actual["max_tokens"], 17);
    assert!(run_at_admitted(
        &url,
        "test-only-secret",
        actual,
        &schema(),
        &Control::default(),
        Some(0),
        &mut |_| panic!("zero output must not reach admission"),
        &mut |_| Ok(())
    )
    .is_err());
}
