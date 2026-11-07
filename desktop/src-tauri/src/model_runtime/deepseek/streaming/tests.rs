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
    assert_eq!(stream.feed(&vec![b'x';2*1024*1024+1]).unwrap_err(),TOO_LARGE);
}
