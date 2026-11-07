use super::*;

fn event(delta: Value, finish: Value) -> String {
    format!("data: {}\r\n\r\n",json!({"choices":[{"index":0,"delta":delta,"finish_reason":finish}]}))
}
#[test]
fn fragmented_sse_and_unicode_expose_only_public_fields_and_keep_usage() {
    let text=r#"{"rationale":"核对原文，不推断\n未知","requests":[],"report":{"markdown":"第一段\n\"引用\"😀","private":"HIDDEN"}}"#;
    let wire=format!(": keepalive\r\n\r\n{}{}data: {}\n\ndata: [DONE]\n\n",
        event(json!({"reasoning_content":"PRIVATE_RAW_REASONING"}),Value::Null),
        event(json!({"content":text}),json!("stop")),
        json!({"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":5,"total_tokens":8,"prompt_cache_hit_tokens":1,"prompt_cache_miss_tokens":2}}));
    let mut events=vec![];
    let mut publish=|v:&Value| {events.push(v.clone());Ok(())};
    let mut stream=Stream::new(&mut publish);
    stream.start().unwrap();
    for byte in wire.as_bytes() { stream.feed(&[*byte]).unwrap(); }
    let mut receipt=execution::Trace::new().finish("running",None);
    assert!(parse_response(&stream.finish().unwrap(),&mut receipt).is_ok());
    stream.preview("completed",true).unwrap();
    assert!(receipt.usage_complete);
    assert_eq!(receipt.total_tokens,Some(8));
    assert_eq!(events.iter().rev().find(|e|e["kind"]=="answer").unwrap()["text"],"第一段\n\"引用\"😀");
    assert_eq!(events.iter().rev().find(|e|e["kind"]=="reasoning").unwrap()["text"],"核对原文，不推断\n未知");
    assert!(!json!(events).to_string().contains("PRIVATE_RAW"));
    assert!(!json!(events).to_string().contains("HIDDEN"));
}

#[test]
fn partial_public_strings_wait_for_incomplete_escapes_and_do_not_match_nested_impostors() {
    assert_eq!(field(r#"{"rationale":"核对\n日期\uD83D"#,&["rationale"]),Some("核对\n日期".into()));
    assert_eq!(field(r#"{"rationale":"核对","report":{"markdown":"答复\"片段"#,&["report","markdown"]),Some("答复\"片段".into()));
    assert_eq!(field(r#"{"metadata":{"rationale":"private"},"rationale":"公开"#,&["rationale"]),Some("公开".into()));
    assert_eq!(field(r#"{"report":null,"requests":[{"markdown":"private"}]}"#,&["report","markdown"]),None);
}

#[test]
fn missing_done_finish_truncation_tool_calls_and_invalid_data_never_validate() {
    for wire in [
        event(json!({"content":"{}"}),json!("stop")),
        format!("{}data: [DONE]\n\n",event(json!({"content":"{}"}),Value::Null)),
        format!("{}data: [DONE]\n\n",event(json!({"content":"{}"}),json!("length"))),
        "data: {invalid}\n\n".into(),
        event(json!({"tool_calls":[{"id":"unexpected"}]}),Value::Null),
        format!("{}{}data: [DONE]\n\n",event(json!({"content":"{}"}),json!("stop")),event(json!({"content":"more"}),Value::Null)),
    ] {
        let mut publish=|_:&Value|Ok(());
        let mut stream=Stream::new(&mut publish);
        let value=stream.feed(wire.as_bytes()).and_then(|_|stream.finish()).and_then(|b|parse_response(&b,&mut execution::Trace::new().finish("running",None)));
        assert!(value.is_err(),"{wire}");
    }
}

#[test]
fn oversized_stream_is_bounded_without_publishing_raw_data() {
    let mut publish=|_:&Value|Ok(());
        let mut stream=Stream::new(&mut publish);
    assert_eq!(stream.feed(&vec![b'x';MAX_WIRE_BYTES+1]).unwrap_err(),TOO_LARGE);
}

#[test]
fn capped_preview_reports_truncation_even_when_its_visible_prefix_does_not_change() {
    let mut events = vec![];
    let mut publish = |v: &Value| { events.push(v.clone()); Ok(()) };
    let mut stream = Stream::new(&mut publish);
    stream.content = format!("{{\"report\":{{\"markdown\":\"{}", "字".repeat(6000));
    stream.preview("running", true).unwrap();
    stream.content.push('后');
    stream.last = Instant::now() - Duration::from_millis(151);
    stream.preview("running", false).unwrap();
    let answers: Vec<_> = events.iter().filter(|e| e["kind"] == "answer").collect();
    assert_eq!(answers.len(), 2);
    assert_ne!(answers[0]["truncated"], true);
    assert_eq!(answers[1]["truncated"], true);
    assert_eq!(answers[1]["text"].as_str().unwrap().chars().count(), 6000);
}

#[test]
fn sse_framing_does_not_exhaust_text_budget_and_raw_reasoning_remains_bounded() {
    let wire = super::super::tests::framing_response();
    assert!(wire.len() > 2 * 1024 * 1024 && wire.len() < MAX_WIRE_BYTES);
    let mut events = vec![];
    let mut publish = |v: &Value| { events.push(v.clone()); Ok(()) };
    let mut stream = Stream::new(&mut publish);
    for chunk in wire.as_bytes().chunks(4096) { stream.feed(chunk).unwrap(); }
    assert_eq!(parse_response(&stream.finish().unwrap(), &mut execution::Trace::new().finish("running", None)).unwrap()["answer"], "ok");
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["text"], "正在思考，等待公开摘要…");
    let mut publish = |_: &Value| Ok(());
    let mut stream = Stream::new(&mut publish);
    assert_eq!(stream.feed(event(json!({"reasoning_content":"x".repeat(MAX_TEXT_BYTES+1)}),Value::Null).as_bytes()).unwrap_err(), TOO_LARGE);
    let mut stream = Stream::new(&mut publish);
    assert_eq!(stream.feed(event(json!({"content":"x".repeat(super::super::super::MAX_OUTPUT_BYTES+1)}),Value::Null).as_bytes()).unwrap_err(), TOO_LARGE);
}
