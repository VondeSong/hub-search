//! Web links are provider/model provenance, never Hub original-text evidence.
use super::*;

fn source_key(raw: &str) -> String {
    let Ok(mut url) = crate::x_bookmarks::public_web::url(raw) else {
        return raw.to_owned();
    };
    // Normalize path parentheses only; decoding separators or queries can merge different resources.
    let path = url.path().replace('(', "%28").replace(')', "%29");
    url.set_path(&path);
    url.to_string()
}

fn returned_source(url: &str, accessed: &HashSet<String>) -> bool {
    let key = source_key(url);
    accessed.iter().any(|seen| source_key(seen) == key)
}

// Inline links survive native delivery even when a redirect is not exposed by the provider.
// Returned source metadata proves discovery, not successful full-text reading.
pub(super) fn from_markdown(markdown: &str, accessed: &HashSet<String>) -> Vec<Value> {
    use pulldown_cmark::{Event, Parser, Tag, TagEnd};
    let mut sources = Vec::new();
    let mut known = HashSet::new();
    let mut current: Option<(String, String)> = None;
    for event in Parser::new(markdown) {
        match event {
            Event::Start(Tag::Link { dest_url, .. }) => {
                current = Some((dest_url.into_string(), String::new()))
            }
            Event::Text(text) | Event::Code(text) => {
                if let Some((_, title)) = &mut current {
                    title.push_str(&text);
                }
            }
            Event::End(TagEnd::Link) => {
                if let Some((url, title)) = current.take() {
                    let Ok(url) = crate::x_bookmarks::public_web::url(&url) else {
                        continue;
                    };
                    let url = url.to_string();
                    if !known.insert(url.clone()) {
                        continue;
                    }
                    let label = if title.trim().is_empty() {
                        url.as_str()
                    } else {
                        title.trim()
                    };
                    let title: String = label
                        .chars()
                        .filter(|c| !c.is_control())
                        .take(200)
                        .collect();
                    if title.is_empty() {
                        continue;
                    }
                    sources.push(json!({"url":url,"title":title,"provenance":if returned_source(&url, accessed){"providerResult"}else{"modelReference"}}));
                    if sources.len() == 20 {
                        break;
                    }
                }
            }
            _ => (),
        }
    }
    sources
}

pub(super) fn observe(
    event: &Value,
    accessed: &mut HashSet<String>,
    accepted: &mut Option<Report>,
    accepted_after: &mut Option<std::time::Duration>,
) {
    if event["kind"] != "webSearch" {
        return;
    }
    // New provider material after hub_finish needs a new checked delivery, like any Hub tool read.
    *accepted = None;
    *accepted_after = None;
    if event["state"] == "completed" {
        for source in event["sourceRefs"].as_array().into_iter().flatten() {
            if let Some(url) = source["url"]
                .as_str()
                .and_then(|s| crate::x_bookmarks::public_web::url(s).ok())
            {
                accessed.insert(url.to_string());
            }
        }
    }
}
pub(super) fn schema() -> Value {
    json!({"type":"array","maxItems":20,"items":{"type":"object","additionalProperties":false,"required":["url","title"],"properties":{"url":{"type":"string","maxLength":4096},"title":{"type":"string","minLength":1,"maxLength":200}}}})
}
pub(super) fn normalize(
    arguments: &Value,
    mode: crate::model_runtime::agent_web::Mode,
    accessed: &HashSet<String>,
) -> Result<(Value, Vec<Value>), String> {
    let mut answer = arguments.clone();
    let raw = answer
        .as_object_mut()
        .ok_or("交付格式无效")?
        .remove("webSources")
        .unwrap_or(json!([]));
    let rows = raw.as_array().ok_or("网页来源格式无效")?;
    if rows.len() > 20 || (!rows.is_empty() && mode.disabled()) {
        return Err("当前联网范围不允许这些网页来源".into());
    }
    let mut sources = Vec::new();
    let mut known = HashSet::new();
    for row in rows {
        let fields = row.as_object().ok_or("网页来源格式无效")?;
        if fields.len() != 2 || !fields.contains_key("url") || !fields.contains_key("title") {
            return Err("网页来源只接受标题和链接，读取状态由宿主记录".into());
        }
        let title = row["title"]
            .as_str()
            .filter(|s| {
                !s.trim().is_empty() && s.chars().count() <= 200 && !s.chars().any(char::is_control)
            })
            .ok_or("网页来源标题无效")?;
        let url =
            crate::x_bookmarks::public_web::url(row["url"].as_str().ok_or("网页来源缺少链接")?)?
                .to_string();
        if known.insert(url.clone()) {
            sources.push(json!({"url":url,"title":title,"provenance":if returned_source(&url, accessed){"providerResult"}else{"modelReference"}}));
        }
    }
    Ok((answer, sources))
}
pub(in crate::agent_work) fn validate(sources: &[Value]) -> Result<(), String> {
    if sources.len() > 20 {
        return Err("网页来源超过容量".into());
    }
    for row in sources {
        crate::x_bookmarks::public_web::url(row["url"].as_str().ok_or("网页来源链接无效")?)?;
        if !matches!(
            row["provenance"].as_str(),
            Some("providerAccess" | "providerResult" | "modelReference")
        ) || row["title"]
            .as_str()
            .is_none_or(|s| s.trim().is_empty() || s.chars().count() > 200)
        {
            return Err("网页来源记录无效".into());
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encoded_path_parentheses_match_without_decoding_resource_separators() {
        let seen =
            HashSet::from(["https://fr.wikisource.org/wiki/Mémoires_(1842)/Lettre".to_owned()]);
        let encoded = "https://fr.wikisource.org/wiki/M%C3%A9moires_%281842%29/Lettre";
        assert!(returned_source(encoded, &seen));
        let markdown = format!("[Lettre]({encoded})");
        assert_eq!(
            from_markdown(&markdown, &seen)[0]["provenance"],
            "providerResult"
        );
        let (_, sources) = normalize(
            &json!({"webSources":[{"url":encoded,"title":"Lettre"}]}),
            crate::model_runtime::agent_web::Mode::Live,
            &seen,
        )
        .unwrap();
        assert_eq!(sources[0]["provenance"], "providerResult");
        // The five mismatches in the Napoleon conversation must classify identically in both directions.
        for (volume, chapter) in [(2, "10"), (2, "06"), (1, "06"), (1, "15"), (2, "03")] {
            let citation = format!("https://fr.wikisource.org/wiki/M%C3%A9morial_de_Sainte-H%C3%A9l%C3%A8ne_(1842)/Tome_{volume}/Chapitre_{chapter}");
            let returned = citation.replace("(1842)", "%281842%29");
            assert!(returned_source(
                &citation,
                &HashSet::from([returned.clone()])
            ));
            assert!(returned_source(
                &returned,
                &HashSet::from([citation.clone()])
            ));
            assert_eq!(
                from_markdown(&format!("[Source]({citation})"), &HashSet::from([returned]))[0]
                    ["provenance"],
                "providerResult"
            );
        }
        for (left, right) in [
            ("https://example.org/a%2Fb", "https://example.org/a/b"),
            ("https://example.org/a?q=%26x", "https://example.org/a?q=&x"),
            (
                "https://example.org/a?q=%281842%29",
                "https://example.org/a?q=(1842)",
            ),
            ("https://example.org/A", "https://example.org/a"),
            ("https://example.org/a", "https://other.org/a"),
        ] {
            assert!(!returned_source(left, &HashSet::from([right.to_owned()])));
        }
    }
    #[test]
    fn web_activity_returned_sources_match_batch_links_without_claiming_full_text() {
        let mut seen = HashSet::new();
        let mut accepted = None;
        let mut after = None;
        let event = json!({"kind":"webSearch","state":"completed","action":"other","errorCount":1,"sourceRefs":[
            {"url":"https://www.archives.gov/electoral-college/2016","title":"2016 Results"},
            {"url":"https://127.0.0.1/private","title":"Unsafe"}
        ]});
        observe(&event, &mut seen, &mut accepted, &mut after);
        assert_eq!(seen.len(), 1);
        let args = json!({"webSources":[
            {"url":"https://www.archives.gov/electoral-college/2016#results","title":"Results"},
            {"url":"https://example.org/unmatched","title":"Unmatched"}
        ]});
        let (_, sources) =
            normalize(&args, crate::model_runtime::agent_web::Mode::Live, &seen).unwrap();
        assert_eq!(sources[0]["provenance"], "providerResult");
        assert_eq!(sources[1]["provenance"], "modelReference");
        validate(&sources).unwrap();
        assert!(normalize(&json!({"webSources":[{"url":"https://example.org/a","title":"Forged","provenance":"providerResult"}]}),crate::model_runtime::agent_web::Mode::Live,&seen).is_err());
    }
    #[test]
    fn native_web_link_metadata_preserves_redirect_references_without_forged_access() {
        let seen = HashSet::from(["https://developers.openai.com/codex/app-server/".to_owned()]);
        let text = "根据 [OpenAI 官方文档的 Core primitives](https://learn.chatgpt.com/docs/app-server#core-primitives)，三者是包含关系。\n[已访问](https://developers.openai.com/codex/app-server/#section)\n[重复](https://learn.chatgpt.com/docs/app-server)\n`[代码](https://code.example.org/)`\n[私网](https://127.0.0.1/)\n![图片](https://image.example.org/a.png)";
        let sources = from_markdown(text, &seen);
        assert_eq!(sources.len(), 2);
        assert_eq!(sources[0]["title"], "OpenAI 官方文档的 Core primitives");
        assert_eq!(sources[0]["provenance"], "modelReference");
        assert_eq!(sources[1]["provenance"], "providerResult");
        validate(&sources).unwrap();
        assert_eq!(
            from_markdown("[未联网时的参考](https://example.org/)", &HashSet::new())[0]
                ["provenance"],
            "modelReference"
        );
    }
    #[test]
    fn cn04_web_sources_never_become_original_evidence_and_reject_forged_access() {
        use crate::model_runtime::agent_web::Mode;
        let args = json!({"markdown":"依据[官方文章](https://example.org/a)","webSources":[{"url":"https://example.org/a#part","title":"官方文章"},{"url":"https://example.org/b","title":"相关页面"}]});
        let seen = HashSet::from(["https://example.org/a".to_owned()]);
        let (answer, sources) = normalize(&args, Mode::Live, &seen).unwrap();
        assert!(answer.get("webSources").is_none());
        assert_eq!(sources[0]["provenance"], "providerResult");
        assert_eq!(sources[1]["provenance"], "modelReference");
        assert!(sources.iter().all(|s| s.get("quote").is_none()));
        validate(&sources).unwrap();
        assert!(normalize(&args, Mode::Disabled, &seen).is_err());
        for url in [
            "https://127.0.0.1/a",
            "javascript:alert(1)",
            "https://u:secret@example.org/a",
        ] {
            assert!(normalize(
                &json!({"webSources":[{"url":url,"title":"bad"}]}),
                Mode::Cached,
                &seen
            )
            .is_err());
        }
        assert!(normalize(&json!({"webSources":[{"url":"https://example.org/a","title":"forged","provenance":"providerAccess"}]}),Mode::Live,&seen).is_err());
    }
}

#[cfg(test)]
#[test]
fn cn04_web_report_and_activity_survive_storage_without_grant_expansion() {
    let f = crate::source_evidence::tests::Fixture::new();
    f.note("notes", "current", "Local source");
    let id = crate::agent_work::tests::create(&f, false);
    let (work, run) = crate::agent_work::tests::claim(&f, &id);
    let grant = json!(work.grant);
    for state in ["running", "completed"] {
        store::stream(&f.root,&work,&run,&json!({"id":"web-1","kind":"webSearch","state":state,"text":"在网页内查找","action":"findInPage","pattern":"65,853,514","queries":[],"url":"https://example.org/a","sourceRefs":[{"url":"https://example.org/a","title":"Results"}],"resultCount":2,"errorCount":1}),&Control::default()).unwrap();
    }
    let activities = crate::agent_work::activity::read_on(&f.root, &f.c(), &work).unwrap();
    let events: Vec<_> = activities[0]["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["kind"] == "webSearch")
        .collect();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["state"], "completed");
    assert_eq!(events[0]["url"], "https://example.org/a");
    assert_eq!(events[0]["pattern"], "65,853,514");
    assert_eq!(events[0]["sourceRefs"][0]["title"], "Results");
    assert_eq!(events[0]["resultCount"], 2);
    assert_eq!(events[0]["errorCount"], 1);
    let source =
        json!({"url":"https://example.org/a","title":"Official","provenance":"modelReference"});
    let report:Report=serde_json::from_value(json!({"status":"completed","summary":"网页信息","findings":[],"nextSteps":[],"questions":[],"limitations":[],"waitCondition":"","prose":{"markdown":"参考[文章](https://example.org/a)","citations":[],"webSources":[source]}})).unwrap();
    super::super::validate(&report, &[]).unwrap();
    store::publish(
        &f.root,
        &work,
        &run,
        &report,
        &[],
        &[],
        &json!([]),
        &Value::Null,
        &Control::default(),
    )
    .unwrap();
    let reopened = store::view(&f.root, &id).unwrap();
    assert_eq!(reopened["work"]["report"]["prose"]["webSources"][0], source);
    assert_eq!(json!(store::load(&f.c(), &id).unwrap().grant), grant);
    let tool_specs = tools(None).unwrap();
    let finish = tool_specs.as_array().unwrap().last().unwrap();
    assert_eq!(
        finish["inputSchema"]["properties"]["webSources"]["maxItems"],
        20
    );
    assert!(!finish["inputSchema"]["required"]
        .as_array()
        .unwrap()
        .contains(&json!("webSources")));
}

#[cfg(test)]
#[test]
fn cn04_new_web_material_invalidates_previously_accepted_delivery() {
    let report:Report=serde_json::from_value(json!({"status":"completed","summary":"旧答复","findings":[],"nextSteps":[],"questions":[],"limitations":[],"waitCondition":""})).unwrap();
    let mut accepted = Some(report);
    let mut after = Some(std::time::Duration::from_secs(1));
    let mut accessed = HashSet::new();
    observe(
        &json!({"kind":"reasoning"}),
        &mut accessed,
        &mut accepted,
        &mut after,
    );
    assert!(accepted.is_some());
    observe(
        &json!({"kind":"webSearch","state":"running","action":"openPage","url":"https://example.org/a"}),
        &mut accessed,
        &mut accepted,
        &mut after,
    );
    assert!(accepted.is_none());
    assert!(after.is_none());
    assert!(accessed.is_empty());
    observe(
        &json!({"kind":"webSearch","state":"completed","action":"openPage","url":"https://example.org/a"}),
        &mut accessed,
        &mut accepted,
        &mut after,
    );
    assert!(
        accessed.is_empty(),
        "a completed access attempt is not a returned source"
    );
}
