//! Optional diagnostics from this thread's public tool outputs only.
use super::*;
use std::io::{BufRead, BufReader, Read};

impl Events {
    pub(in crate::model_runtime::cli::agent) fn diagnostics(
        &mut self,
        directory: &Path,
        path: Option<&str>,
        thread: &str,
        turn: &str,
    ) -> Vec<Value> {
        if !self
            .items
            .values()
            .any(|v| v["errorCount"].as_u64().unwrap_or(0) > 0)
        {
            return vec![];
        }
        // The runtime's optional path is not authority to read outside this isolated home.
        let Some(path) = path.and_then(|p| std::fs::canonicalize(p).ok()) else {
            return vec![];
        };
        let Ok(base) = std::fs::canonicalize(directory.join("home/sessions")) else {
            return vec![];
        };
        if !path.starts_with(base) {
            return vec![];
        }
        let Ok(file) = std::fs::File::open(path) else {
            return vec![];
        };
        const LIMIT: u64 = 32 * 1024 * 1024;
        if file.metadata().map_or(true, |m| m.len() > LIMIT) {
            return vec![];
        }
        self.read_diagnostics(BufReader::new(file.take(LIMIT)), thread, turn)
    }

    fn read_diagnostics(&mut self, reader: impl BufRead, thread: &str, turn: &str) -> Vec<Value> {
        let mut bound = false;
        let mut current = false;
        let mut updates = HashSet::new();
        for line in reader.split(b'\n') {
            let Ok(line) = line else {
                break;
            };
            if line.len() > 2 * 1024 * 1024 {
                continue;
            }
            let Ok(record) = serde_json::from_slice::<Value>(&line) else {
                continue;
            };
            let payload = &record["payload"];
            match record["type"].as_str() {
                Some("session_meta") => {
                    if payload["id"] != thread {
                        return vec![];
                    }
                    bound = true;
                }
                Some("turn_context") => current = payload["turn_id"] == turn,
                Some("response_item")
                    if bound && current && payload["type"] == "custom_tool_call_output" =>
                {
                    // No messages, reasoning items or encrypted fields enter the display path.
                    for block in payload["output"].as_array().into_iter().flatten() {
                        if block["type"] != "input_text" {
                            continue;
                        }
                        let Some(text) = block["text"].as_str() else {
                            continue;
                        };
                        for (id, event) in &mut self.items {
                            for error in event["errors"].as_array_mut().into_iter().flatten() {
                                if error.get("reason").is_some() {
                                    continue;
                                }
                                if let Some((url, reason)) =
                                    failure(text, error["refId"].as_str().unwrap_or_default())
                                {
                                    error["url"] = json!(url);
                                    error["reason"] = json!(reason);
                                    error["reasonSource"] = json!("publicToolOutput");
                                    updates.insert(id.clone());
                                }
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        let mut updates: Vec<_> = updates.into_iter().collect();
        updates.sort();
        updates
            .into_iter()
            .map(|id| self.items[&id].clone())
            .collect()
    }
}

fn failure(text: &str, reference: &str) -> Option<(String, &'static str)> {
    if reference.is_empty() {
        return None;
    }
    let marker = format!("Internal Error ()\n\u{e200}cite\u{e202}{reference}\u{e201}");
    let (_, rest) = text.split_once(&marker)?;
    // The public web result has its own bounded error block; never display arbitrary error text.
    let block = rest
        .split("--------------------------------------------------------------------------------")
        .next()?;
    let line = block
        .lines()
        .find_map(|s| s.strip_prefix("Failed to fetch "))?;
    let (url, reason) = line.rsplit_once(": ")?;
    let reason = match reason.trim() {
        "TimeoutError" => "访问超时",
        "(403) Forbidden" => "网站拒绝访问（403）",
        "(404) Not Found" => "页面不存在（404）",
        "(429) Too Many Requests" => "访问频率受限（429）",
        "(503) Service Unavailable" => "网站暂时不可用（503）",
        message
            if message.starts_with("(500) Redirected to ")
                && message
                    .ends_with(" which is not accessible via this tool. (non-retryable error)") =>
        {
            "重定向目标无法访问（500）"
        }
        _ => return None,
    };
    let url = crate::x_bookmarks::public_web::url(url).ok()?;
    Some((url.to_string(), reason))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn output(reference: &str, url: &str, reason: &str) -> String {
        format!("Internal Error ()\n\u{e200}cite\u{e202}{reference}\u{e201} [wordlim: 200] Source: open\nFailed to fetch {url}: {reason}")
    }
    fn events() -> Events {
        let mut events = Events::default();
        events.receive(&json!({"id":"batch","results":[{"type":"text_result","ref_id":"turn1view2","title":"Internal Error"}]}),true,Mode::Live,"turn").unwrap();
        events
    }
    fn log(thread: &str, turn: &str, text: &str) -> String {
        [json!({"type":"session_meta","payload":{"id":thread}}),
         json!({"type":"turn_context","payload":{"turn_id":turn}}),
         json!({"type":"response_item","payload":{"type":"reasoning","content":text}}),
         json!({"type":"response_item","payload":{"type":"custom_tool_call_output","output":[{"type":"input_text","text":text}]}})]
         .iter().map(Value::to_string).collect::<Vec<_>>().join("\n")
    }
    #[test]
    fn web_diagnostics_joins_only_known_errors_in_the_bound_thread_and_turn() {
        let text = output(
            "turn1view2",
            "https://www.repository.cam.ac.uk/items/a",
            "TimeoutError",
        );
        for (thread, turn) in [("other", "turn"), ("thread", "old")] {
            assert!(events()
                .read_diagnostics(log(thread, turn, &text).as_bytes(), "thread", "turn")
                .is_empty());
        }
        let mut events = events();
        let update =
            events.read_diagnostics(log("thread", "turn", &text).as_bytes(), "thread", "turn");
        assert_eq!(update.len(), 1);
        assert_eq!(update[0]["errors"][0]["reason"], "访问超时");
        assert_eq!(update[0]["errorCount"], 1);
        assert_eq!(update[0]["sourceRefs"], json!([]));
        assert!(events
            .read_diagnostics(log("thread", "turn", &text).as_bytes(), "thread", "turn")
            .is_empty());
        assert!(self::events()
            .read_diagnostics(
                log("thread", "turn", &text.replace("turn1view2", "different")).as_bytes(),
                "thread",
                "turn"
            )
            .is_empty());
    }
    #[test]
    fn web_diagnostics_rejects_private_urls_unknown_reasons_and_non_tool_messages() {
        for (url, reason) in [
            ("https://127.0.0.1/a", "TimeoutError"),
            ("https://u:password@example.org/a", "TimeoutError"),
            ("https://example.org/a", "PRIVATE ERROR BODY"),
        ] {
            assert!(failure(&output("turn1view2", url, reason), "turn1view2").is_none());
        }
        for reason in ["(403) Forbidden","(503) Service Unavailable","(500) Redirected to https://example.org/target which is not accessible via this tool. (non-retryable error)"] {
            assert!(failure(&output("turn1view2","https://example.org/a",reason),"turn1view2").is_some());
        }
        let log = log(
            "thread",
            "turn",
            &output("turn1view2", "https://example.org/a", "TimeoutError"),
        );
        let log = log.replace("custom_tool_call_output", "message");
        assert!(events()
            .read_diagnostics(log.as_bytes(), "thread", "turn")
            .is_empty());
    }
    #[test]
    fn web_diagnostics_uses_only_runtime_path_inside_isolated_sessions() {
        let root =
            std::env::temp_dir().join(format!("hub-web-diagnostics-{}", crate::random_url_safe(8)));
        std::fs::create_dir_all(root.join("home/sessions")).unwrap();
        let outside = root.join("outside.jsonl");
        let inside = root.join("home/sessions/current.jsonl");
        let data = log(
            "thread",
            "turn",
            &output("turn1view2", "https://example.org/a", "TimeoutError"),
        );
        std::fs::write(&outside, &data).unwrap();
        std::fs::write(&inside, &data).unwrap();
        assert!(events()
            .diagnostics(&root, None, "thread", "turn")
            .is_empty());
        assert!(events()
            .diagnostics(&root, outside.to_str(), "thread", "turn")
            .is_empty());
        assert_eq!(
            events()
                .diagnostics(&root, inside.to_str(), "thread", "turn")
                .len(),
            1
        );
        std::fs::remove_file(outside).unwrap();
        std::fs::remove_file(inside).unwrap();
        std::fs::remove_dir(root.join("home/sessions")).unwrap();
        std::fs::remove_dir(root.join("home")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}
