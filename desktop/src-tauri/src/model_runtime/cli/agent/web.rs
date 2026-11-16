//! Public web lifecycle and bounded result metadata; never page bodies or opaque payloads.
use super::*;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
mod diagnostics;

#[derive(Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Mode {
    #[default]
    Disabled,
    Cached,
    Live,
}
impl Mode {
    pub(crate) fn disabled(&self) -> bool {
        *self == Self::Disabled
    }
}

#[derive(Default)]
pub(super) struct Events {
    items: HashMap<String, Value>,
}
impl Events {
    pub(super) fn receive(
        &mut self,
        item: &Value,
        completed: bool,
        mode: Mode,
        turn: &str,
    ) -> Result<Option<Value>, String> {
        if mode.disabled() {
            return Err("当前对话未开启联网，却收到联网事件；本轮停止".into());
        }
        let key = item["id"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 256)
            .ok_or("联网事件身份无效")?;
        let id = format!(
            "web-{:x}",
            Sha256::digest(format!("{turn}\0{key}").as_bytes())
        );
        if self
            .items
            .get(&id)
            .is_some_and(|v| v["state"] == "completed")
        {
            return Ok(None);
        }
        if !self.items.contains_key(&id) && self.items.len() >= 64 {
            if let Some(old) = self
                .items
                .iter()
                .find(|(_, v)| v["state"] == "completed")
                .map(|(key, _)| key.clone())
            {
                self.items.remove(&old);
            }
        }
        if !self.items.contains_key(&id) && self.items.len() >= 64 {
            let finished = self
                .items
                .iter()
                .find(|(_, event)| event["state"] == "completed")
                .map(|(key, _)| key.clone());
            if let Some(key) = finished {
                self.items.remove(&key);
            } else {
                return Err("同时进行的联网事件超过容量，已有记录保留".into());
            }
        }
        let action = match item["action"]["type"].as_str() {
            Some("search") => "search",
            Some("openPage") => "openPage",
            Some("findInPage") => "findInPage",
            _ => "other",
        };
        let url = item["action"]["url"]
            .as_str()
            .and_then(|s| crate::x_bookmarks::public_web::url(s).ok())
            .map(|u| u.to_string());
        let mut queries: Vec<&str> = item["action"]["queries"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .collect();
        if queries.is_empty() && action == "search" {
            if let Some(query) = item["action"]["query"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .or_else(|| item["query"].as_str().filter(|s| !s.trim().is_empty()))
            {
                queries.push(query);
            }
        }
        if queries.len() > 32
            || queries.iter().map(|s| s.len()).sum::<usize>() > 4096
            || queries
                .iter()
                .any(|s| s.chars().any(|c| c.is_control() && c != '\n'))
        {
            return Err("联网检索词超出公开记录合同".into());
        }
        let pattern = public_text(&item["action"]["pattern"], 500);
        let text = match action {
            "search" if !queries.is_empty() => format!("搜索网页 · {} 条查询", queries.len()),
            "search" => "搜索网页".into(),
            "openPage" => "访问网页".into(),
            "findInPage" => "在网页内查找".into(),
            _ => "查阅网页资料".into(),
        };
        let mut event = json!({"id":id,"kind":"webSearch","text":text,"state":if completed {"completed"} else {"running"},"action":action,"url":url,"mode":mode,"queries":queries,"pattern":pattern});
        if completed {
            // Result shapes may evolve. Only known text-result metadata is admitted.
            if let Some(results) = item["results"].as_array() {
                let mut sources = Vec::new();
                let mut errors = 0;
                let mut failures = Vec::new();
                let mut bytes = 0;
                let mut omitted = 0;
                for result in results {
                    if result["type"] != "text_result" {
                        continue;
                    }
                    if result["title"] == "Internal Error" {
                        errors += 1;
                        if failures.len() < 64 {
                            if let Some(id) = result["ref_id"].as_str().filter(|s| {
                                !s.is_empty()
                                    && s.len() <= 128
                                    && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
                            }) {
                                failures.push(json!({"refId":id}));
                            }
                        }
                        continue;
                    }
                    let Some(url) = result["url"]
                        .as_str()
                        .and_then(|s| crate::x_bookmarks::public_web::url(s).ok())
                    else {
                        continue;
                    };
                    let source =
                        json!({"url":url.to_string(),"title":public_text(&result["title"],200)});
                    let size = source.to_string().len();
                    if sources.len() >= 64 || bytes + size > 16_384 {
                        omitted += 1;
                        continue;
                    }
                    bytes += size;
                    sources.push(source);
                }
                event["sourceRefs"] = json!(sources);
                event["resultCount"] = json!(results.len());
                event["errorCount"] = json!(errors);
                event["errors"] = json!(failures);
                event["omittedSourceCount"] = json!(omitted);
            }
        }
        if self.items.get(&id) == Some(&event) {
            return Ok(None);
        }
        self.items.insert(id, event.clone());
        Ok(Some(event))
    }
}

fn public_text(value: &Value, limit: usize) -> Option<String> {
    value
        .as_str()
        .map(|s| {
            s.chars()
                .filter(|c| !c.is_control())
                .take(limit)
                .collect::<String>()
        })
        .filter(|s| !s.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn completed_web_items_do_not_end_an_authorized_long_turn() {
        let mut events = Events::default();
        for n in 0..70 {
            assert!(events.receive(&json!({"id":format!("web-{n}"),"action":{"type":"search","query":"actual task"}}),true,Mode::Live,"turn").unwrap().is_some());
        }
        assert!(events.items.len() <= 64);
    }
    #[test]
    fn web_activity_real_batch_metadata_preserves_errors_sources_and_find_pattern() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("fixtures/trump-web-events.json")).unwrap();
        let mut events = Events::default();
        let batch = events
            .receive(&cases[0], true, Mode::Live, "turn")
            .unwrap()
            .unwrap();
        assert_eq!(batch["text"], "查阅网页资料");
        assert_eq!(batch["resultCount"], 6);
        assert_eq!(batch["errorCount"], 1);
        assert!(batch["sourceRefs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["url"] == "https://www.archives.gov/electoral-college/2016"));
        let pdf = events
            .receive(&cases[1], true, Mode::Live, "turn")
            .unwrap()
            .unwrap();
        assert_eq!(pdf["state"], "completed");
        assert_eq!(pdf["errorCount"], 1);
        assert!(
            !pdf["sourceRefs"]
                .as_array()
                .unwrap()
                .iter()
                .any(|s| s["url"] == pdf["url"]),
            "failed PDF request must not become a returned source"
        );
        let find = events
            .receive(&cases[2], true, Mode::Live, "turn")
            .unwrap()
            .unwrap();
        assert_eq!(find["pattern"], "65,853,514");
        assert!(find["url"].is_null());
        assert_eq!(find["sourceRefs"].as_array().unwrap().len(), 3);
        assert!(!find.to_string().contains("未提供可展示"));
    }

    #[test]
    fn web_activity_metadata_is_bounded_allowlisted_and_keeps_queries_separate() {
        let safe = json!({"type":"text_result","url":"https://example.org/a","title":"Example","snippet":"PRIVATE_BODY","unknown":"PRIVATE_BODY"});
        let mut results = vec![safe; 100];
        results.push(
            json!({"type":"unknown","url":"https://ignored.example/","title":"PRIVATE_BODY"}),
        );
        results.push(json!({"type":"text_result","url":"https://u:password@example.org/","title":"PRIVATE_BODY"}));
        results
            .push(json!({"type":"text_result","url":"https://127.0.0.1/","title":"PRIVATE_BODY"}));
        let mut events = Events::default();
        let item = json!({"id":"batch","action":{"type":"search","queries":["first query","second query"]},"results":results});
        let event = events
            .receive(&item, true, Mode::Live, "turn")
            .unwrap()
            .unwrap();
        assert_eq!(event["queries"], json!(["first query", "second query"]));
        assert_eq!(event["text"], "搜索网页 · 2 条查询");
        assert_eq!(event["sourceRefs"].as_array().unwrap().len(), 64);
        assert_eq!(event["omittedSourceCount"], 36);
        assert!(!event.to_string().contains("PRIVATE_BODY"));
        assert!(!event.to_string().contains("password"));
        assert!(event.get("results").is_none());
        assert!(events
            .receive(&item, true, Mode::Live, "turn")
            .unwrap()
            .is_none());
    }

    #[test]
    fn cn04_web_events_deduplicate_preserve_turn_and_exclude_opaque_payloads() {
        let item = json!({"id":"one","type":"webSearch","query":"Rust 文档","action":{"type":"openPage","url":"https://example.org/a"},"results":[{"secret":"must not store"}]});
        let mut events = Events::default();
        assert!(events.receive(&item, false, Mode::Disabled, "t1").is_err());
        let started = events
            .receive(&item, false, Mode::Live, "t1")
            .unwrap()
            .unwrap();
        assert!(started.get("results").is_none());
        assert!(events
            .receive(&item, false, Mode::Live, "t1")
            .unwrap()
            .is_none());
        let done = events
            .receive(&item, true, Mode::Live, "t1")
            .unwrap()
            .unwrap();
        assert_eq!(started["id"], done["id"]);
        assert_eq!(done["state"], "completed");
        assert!(events
            .receive(&item, false, Mode::Live, "t1")
            .unwrap()
            .is_none());
        assert_ne!(
            done["id"],
            events
                .receive(&item, true, Mode::Cached, "t2")
                .unwrap()
                .unwrap()["id"]
        );
        let unsafe_item = json!({"id":"two","action":{"type":"openPage","url":"https://u:password@example.org/a"}});
        assert!(!events
            .receive(&unsafe_item, true, Mode::Live, "t1")
            .unwrap()
            .unwrap()
            .to_string()
            .contains("password"));
    }
}

#[cfg(test)]
#[test]
fn cn04_web_modes_reach_start_resume_and_legacy_short_tasks_stay_off() {
    for mode in [Mode::Disabled, Mode::Cached, Mode::Live] {
        for thread in [None, Some("existing")] {
            let request = Request {
                directory: Path::new("isolated"),
                authentication_identity: "unused",
                auth_root: None,
                auth_selection: None,
                thread,
                instructions: "Hub scope",
                image_input: &[],
                input: "unused",
                tools: json!([]),
                compact_before_turn: false,
                external_mcp: false,
                web_search: mode,
                native_capabilities: Default::default(),
            };
            let params = thread_params(&request, "selected");
            assert_eq!(params["config"]["web_search"], json!(mode));
            assert_eq!(params["sandbox"], "read-only");
            assert!(params.get("baseInstructions").is_none());
        }
    }
    for native in [false, true] {
        let mut command = Command::new("unused");
        configure_investigation_mode(&mut command, native);
        assert_eq!(
            command.get_args().any(|a| a == "web_search=\"disabled\""),
            !native
        );
    }
}
