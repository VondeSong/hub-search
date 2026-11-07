//! Bounded model projection; the full live inventory remains with the host.
use serde_json::{json, Value};
use std::collections::BTreeSet;

const BYTES: usize = 24 * 1024;
fn terms(text: &str) -> BTreeSet<String> {
    let lower = text.to_lowercase();
    let mut out = lower
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| s.len() >= 3)
        .map(str::to_owned)
        .collect::<BTreeSet<_>>();
    let chars = lower.chars().collect::<Vec<_>>();
    for pair in chars.windows(2) {
        if pair.iter().all(|c| ('\u{3400}'..='\u{9fff}').contains(c)) {
            out.insert(pair.iter().collect());
        }
    }
    out
}
pub(super) fn dida(context: &Value, source: &str) -> Result<Value, String> {
    let lists = context["lists"].as_array().ok_or("滴答清单上下文缺失")?;
    let query = terms(source);
    let mut candidates = Vec::new();
    let mut total = 0;
    let projected = lists
        .iter()
        .enumerate()
        .map(|(index, list)| {
            let tasks = list["tasks"].as_array().map(Vec::as_slice).unwrap_or(&[]);
            total += list["taskCount"].as_u64().unwrap_or(tasks.len() as u64);
            for task in tasks {
                let title = terms(task["title"].as_str().unwrap_or(""));
                let body = terms(task["content"].as_str().unwrap_or(""));
                let score =
                    query.intersection(&title).count() * 3 + query.intersection(&body).count();
                if score > 0 {
                    candidates.push((score, index, task.clone()));
                }
            }
            json!({"id":list["id"],"name":list["name"],"tasks":[]})
        })
        .collect::<Vec<_>>();
    let mut out = json!({"lists":projected,"existingTags":context["existingTags"],"scope":{"totalTasks":total,"shownTasks":0,"partial":total>0,"policy":"相关候选；未列出不代表不存在，不得宣称已完成全量去重"}});
    if out.to_string().len() > BYTES {
        return Err("滴答清单和标签目录超过上下文预算，请缩小连接范围".into());
    }
    candidates.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then(a.1.cmp(&b.1))
            .then(a.2["id"].as_str().cmp(&b.2["id"].as_str()))
    });
    let mut shown = 0;
    for (_, index, task) in candidates.into_iter().take(40) {
        out["lists"][index]["tasks"]
            .as_array_mut()
            .unwrap()
            .push(task);
        out["scope"]["shownTasks"] = json!(shown + 1);
        if out.to_string().len() > BYTES {
            out["lists"][index]["tasks"].as_array_mut().unwrap().pop();
            out["scope"]["shownTasks"] = json!(shown);
            continue;
        }
        shown += 1;
    }
    out["scope"]["partial"] = json!(shown < total);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn real_sized_inventory_is_bounded_relevant_and_honest_about_coverage() {
        let mut tasks = (0..150).map(|i|json!({"id":format!("task-{i}"),"title":"无关采购","content":"采购".repeat(250)})).collect::<Vec<_>>();
        tasks.push(
            json!({"id":"psychology","title":"人本主义心理学","content":"意识经验与自我实现"}),
        );
        let full = json!({"lists":[{"id":"real-list","name":"学习","taskCount":220,"tasks":tasks}],"existingTags":["心理学"]});
        let out = dida(&full, "人本主义心理学与自我实现").unwrap();
        assert!(out.to_string().len() <= BYTES);
        assert_eq!(out["lists"][0]["id"], "real-list");
        assert_eq!(out["lists"][0]["tasks"].as_array().unwrap().len(), 1);
        assert_eq!(out["lists"][0]["tasks"][0]["id"], "psychology");
        assert_eq!(out["scope"]["totalTasks"], 220);
        assert_eq!(out["scope"]["partial"], true);
        assert_eq!(out["existingTags"], full["existingTags"]);
        assert_eq!(full["lists"][0]["tasks"].as_array().unwrap().len(), 151);
        assert!(dida(&json!({"lists":[],"existingTags":["a".repeat(BYTES)]}), "x").is_err());
    }
}
