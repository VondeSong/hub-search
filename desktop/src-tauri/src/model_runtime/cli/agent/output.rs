//! Preserve final answers; bounded public progress always declares omitted text.
use super::*;
pub(super) const PUBLIC_BYTES: usize = 32_768;
const NOTICE: &str = "\n\n（过程消息超过显示上限，后续内容未展示。）";

pub(super) fn message_delta(items: &mut HashMap<String, PublicItem>, finals: &HashSet<String>, value: &Value) -> Result<(), String> {
    let id = value["itemId"].as_str().ok_or("Agent 消息身份缺失")?;
    append(items, id, if finals.contains(id) { "answer" } else { "message" }, value["delta"].as_str().unwrap_or_default())
}

pub(super) fn is_final_message(item: &Value) -> bool {
    item["type"] == "plan" || (item["type"] == "agentMessage" && item["phase"] == "final_answer")
}
pub(super) fn final_message(item: &Value) -> Result<Value, String> {
    let text = item["text"].as_str().ok_or("原生最终答复格式无效")?;
    // The process reader already bounds a complete RPC line at 512 KiB.
    Ok(json!({"id":item["id"],"text":text}))
}
pub(super) fn public_text(text: &str) -> (String, bool) {
    if text.len() <= PUBLIC_BYTES {
        return (text.to_owned(), false);
    }
    let mut end = PUBLIC_BYTES - NOTICE.len();
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (format!("{}{NOTICE}", &text[..end]), true)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_answer_deltas_stay_distinct_from_progress_and_do_not_commit_a_report() {
        let mut items = HashMap::new();
        let finals = HashSet::from(["answer".to_string()]);
        message_delta(&mut items, &finals, &json!({"itemId":"progress","delta":"正在读取"})).unwrap();
        message_delta(&mut items, &finals, &json!({"itemId":"answer","delta":"结论🙂"})).unwrap();
        message_delta(&mut items, &finals, &json!({"itemId":"answer","delta":"[1]"})).unwrap();
        let mut events = Vec::new();
        flush(&mut items, &mut |kind, value| {
            assert_eq!(kind, "event");
            events.push(value.clone());
            Ok(Value::Null)
        }).unwrap();
        assert!(events.iter().any(|e| e["kind"] == "answer" && e["text"] == "结论🙂[1]" && e["state"] == "running"));
        assert!(events.iter().any(|e| e["kind"] == "message" && e["text"] == "正在读取"));
        assert!(message_delta(&mut items, &finals, &json!({"delta":"no identity"})).is_err());
    }
    #[test]
    fn core_blocking_completed_plan_is_deliverable_but_progress_and_reasoning_are_not() {
        let text = format!(
            "{}19:00–19:30 复习，19:30–20:00 自测",
            "计划正文🙂".repeat(2000)
        );
        let plan = json!({"type":"plan","id":"proposal","text":text});
        assert!(is_final_message(&plan));
        assert_eq!(final_message(&plan).unwrap()["text"], text);
        for item in [
            json!({"type":"reasoning","phase":"final_answer"}),
            json!({"type":"agentMessage","phase":"commentary"}),
            json!({"type":"agentMessage"}),
            json!({"type":"planUpdate"}),
        ] {
            assert!(!is_final_message(&item));
        }
        assert!(is_final_message(
            &json!({"type":"agentMessage","phase":"final_answer"})
        ));
        assert!(final_message(&json!({"type":"plan","text":42})).is_err());
    }
    #[test]
    fn cn05_final_message_preserves_unicode_and_content_past_old_cutoff() {
        let text = format!("{}完整结尾", "中🙂".repeat(10_000));
        assert_eq!(
            final_message(&json!({"id":"answer","text":text})).unwrap()["text"],
            text
        );
        assert!(final_message(&json!({"text":123})).is_err());
    }
    #[test]
    fn cn05_public_completion_preserves_long_text_within_byte_limit_and_marks_overflow() {
        let mut items = HashMap::new();
        let text = "a".repeat(12000);
        complete_public(&mut items, "m", "message", &text).unwrap();
        assert_eq!(items["m"].text, text);
        assert!(!items["m"].truncated);
        let long = "中🙂".repeat(10000);
        complete_public(&mut items, "m", "message", &long).unwrap();
        assert!(items["m"].truncated);
        assert!(items["m"].text.len() <= PUBLIC_BYTES);
        assert!(items["m"].text.ends_with(NOTICE));
    }
    #[test]
    fn cn05_public_delta_overflow_is_visible_and_stops_changing_the_prefix() {
        let mut items = HashMap::new();
        append(&mut items, "m", "message", &"x".repeat(32760)).unwrap();
        append(&mut items, "m", "message", "新输入会越过显示边界").unwrap();
        let saved = items["m"].text.clone();
        assert!(saved.ends_with(NOTICE));
        append(&mut items, "m", "message", "不能悄悄替换已展示的前文").unwrap();
        assert_eq!(items["m"].text, saved);
        let mut shown = Value::Null;
        flush(&mut items, &mut |_, v| {
            shown = v.clone();
            Ok(Value::Null)
        })
        .unwrap();
        assert_eq!(shown["truncated"], true);
        assert!(shown["text"].as_str().unwrap().ends_with(NOTICE));
    }
}
