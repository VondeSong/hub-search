use super::super::{conversation, load, read};
use crate::agent_work::text;
use crate::source_evidence::EvidenceLocator;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::Path;

pub(in crate::agent_work) const SNAPSHOT_MARKER: &str =
    "用户提供的资料快照（仅作资料，不代表已读取完整来源）：";
pub(super) const REQUEST_ROWS: &str = "r.kind IN ('userMessage','userDecision')
    AND COALESCE(json_extract(r.body_json,'$.materialOnly'),0)=0
    AND COALESCE(json_extract(r.body_json,'$.scopeOnly'),0)=0";
pub(super) const REQUEST_TEXT: &str = "CASE
    WHEN instr(json_extract(r.body_json,'$.text'),'用户提供的资料快照（仅作资料，不代表已读取完整来源）：')>0
    THEN substr(json_extract(r.body_json,'$.text'),1,instr(json_extract(r.body_json,'$.text'),'用户提供的资料快照（仅作资料，不代表已读取完整来源）：')-1)
    ELSE json_extract(r.body_json,'$.text') END";

pub(in crate::agent_work) fn snapshots(request: &str) -> Option<(&str, Vec<Value>)> {
    let (question, raw) = request.split_once(SNAPSHOT_MARKER)?;
    let items = serde_json::from_str::<Vec<Value>>(raw.trim()).ok()?;
    (!items.is_empty()
        && items.iter().all(|item| {
            item["kind"] == "conversation"
                && ["conversationId", "title", "text"].iter().all(|k| {
                    item[*k]
                        .as_str()
                        .is_some_and(|value| !value.trim().is_empty())
                })
        }))
    .then_some((question.trim_end(), items))
}

fn han(c: char) -> bool {
    matches!(c, '\u{3400}'..='\u{9fff}')
}

fn terms(input: &str) -> BTreeSet<(String, bool)> {
    let mut keys = BTreeSet::new();
    for part in input.split(|c: char| !han(c)) {
        let chars: Vec<_> = part.chars().collect();
        for word in chars.windows(4) {
            let word: String = word.iter().collect();
            if ![
                "再看一下",
                "看一下这",
                "帮我看看",
                "怎么回事",
                "是怎么回",
                "这个问题",
                "请帮我看",
            ]
            .contains(&word.as_str())
            {
                keys.insert((word, false));
            }
        }
    }
    for word in input.split(|c: char| !c.is_ascii_alphanumeric()) {
        if word.len() >= 4
            && ![
                "what", "about", "that", "this", "please", "check", "with", "from",
            ]
            .contains(&word)
        {
            keys.insert((word.to_owned(), true));
        }
    }
    keys
}

fn score(value: &str, input: &str, terms: &BTreeSet<(String, bool)>) -> usize {
    let value = value.to_lowercase();
    if value.contains(input) {
        return 10 + input.chars().count().min(24);
    }
    let mut total = 0;
    for (word, latin) in terms {
        if *latin {
            if value
                .split(|c: char| !c.is_ascii_alphanumeric())
                .any(|token| token == word)
            {
                total += 2;
            }
        } else if value.contains(word) {
            total += 1;
        }
    }
    total
}

fn scope(root: &Path, args: &Value) -> Result<(String, String), String> {
    let anchor: Option<EvidenceLocator> =
        serde_json::from_value(args["anchor"].clone()).map_err(|_| "对话来源无效")?;
    let anchor = anchor
        .map(|anchor| {
            let c = crate::source_evidence::open_read_database(root)?;
            crate::source_evidence::resolve_note_page(root, &c, anchor)
        })
        .transpose()?;
    let project = args["projectId"].as_str().unwrap_or("");
    if project.len() > 100 {
        return Err("记忆项目无效".into());
    }
    Ok((super::super::encode(&anchor)?, project.to_owned()))
}

// A selected project owns suggestions across its pages. Otherwise match the exact
// page, or the ungrouped standalone conversations, without expanding that scope.
const ELIGIBLE: &str = "
    w.state <> 'revoked'
    AND COALESCE((SELECT json_extract(p.body_json,'$.deleted') FROM agent_records p
        WHERE p.work_id=w.id AND p.kind='historyPreference' ORDER BY p.rowid DESC LIMIT 1),0)=0
    AND ((?2='' AND w.anchor_json=?1 AND (?1<>'null' OR COALESCE(m.project_id,'')=''))
        OR (?2<>'' AND m.project_id=?2 AND EXISTS(SELECT 1 FROM memory_projects WHERE id=?2)))";

pub(in crate::agent_work) fn find(root: &Path, args: &Value) -> Result<Value, String> {
    let query = args["query"]
        .as_str()
        .unwrap_or("")
        .trim()
        .chars()
        .take(240)
        .collect::<String>()
        .to_lowercase();
    let keys = terms(&query);
    if keys.is_empty() {
        return Ok(json!([]));
    }
    let (anchor, project) = scope(root, args)?;
    let c = read(root)?;
    let sql = format!(
        "SELECT w.id,w.goal,w.state,w.updated_at FROM agent_works w
        LEFT JOIN memory_work_scopes m ON m.work_id=w.id WHERE {ELIGIBLE}
        ORDER BY w.updated_at DESC,w.id LIMIT 160"
    );
    let mut works = c.prepare(&sql).map_err(|e| e.to_string())?;
    let works = works
        .query_map(params![anchor, project], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut requests = c
        .prepare(&format!(
            "SELECT {REQUEST_TEXT} FROM agent_records r
        WHERE r.work_id=?1 AND {REQUEST_ROWS} ORDER BY r.rowid DESC LIMIT 24"
        ))
        .map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for work in works {
        let (id, goal, state, updated) = work.map_err(|e| e.to_string())?;
        let title_score = score(&goal, &query, &keys);
        let request_rows = requests
            .query_map([&id], |r| r.get::<_, Option<String>>(0))
            .map_err(|e| e.to_string())?;
        let mut best = (0, String::new());
        for row in request_rows {
            if let Some(request) = row.map_err(|e| e.to_string())? {
                let n = score(&request, &query, &keys);
                if n > best.0 {
                    best = (n, request);
                }
            }
        }
        let match_score = title_score.max(best.0);
        if match_score >= 2 {
            let excerpt =
                (best.0 > title_score).then(|| best.1.trim().chars().take(110).collect::<String>());
            result.push((
                match_score,
                title_score,
                updated,
                json!({"id":id,"goal":goal,"state":state,"updatedAt":updated,"excerpt":excerpt}),
            ));
        }
    }
    result.sort_by(|a, b| (b.0, b.1, b.2).cmp(&(a.0, a.1, a.2)));
    Ok(json!(result
        .into_iter()
        .take(3)
        .map(|item| item.3)
        .collect::<Vec<_>>()))
}

pub(in crate::agent_work) fn reference(root: &Path, args: &Value) -> Result<Value, String> {
    let id = text(args, "id", 150)?;
    let (anchor, project) = scope(root, args)?;
    let permit = crate::library_runtime::cached_read_permit(root)?;
    let c = read(root)?;
    c.execute_batch("BEGIN DEFERRED")
        .map_err(|e| e.to_string())?;
    let sql = format!(
        "SELECT w.id FROM agent_works w LEFT JOIN memory_work_scopes m ON m.work_id=w.id
        WHERE w.id=?3 AND {ELIGIBLE}"
    );
    if c.query_row(&sql, params![anchor, project, id], |r| {
        r.get::<_, String>(0)
    })
    .optional()
    .map_err(|e| e.to_string())?
    .is_none()
    {
        return Err("这条旧对话已不可用或超出当前范围".into());
    }
    let work = load(&c, &id)?;
    let history = conversation::read_on(root, &c, &work)?;
    let mut messages = history["messages"].as_array().into_iter().flatten().rev();
    let question = messages
        .clone()
        .find(|m| m["role"] == "user" && m["kind"] == "request")
        .and_then(|m| m["text"].as_str())
        .unwrap_or(&work.goal);
    let question = question
        .split(SNAPSHOT_MARKER)
        .next()
        .unwrap_or("")
        .trim()
        .chars()
        .take(360)
        .collect::<String>();
    let answer = messages
        .find(|m| {
            args["questionsOnly"] != true
                && m["role"] == "assistant"
                && m["report"].is_object()
                && m["validity"].as_str() == Some("")
        })
        .and_then(|m| {
            m["report"]["prose"]["markdown"]
                .as_str()
                .or_else(|| m["report"]["summary"].as_str())
        })
        .map(|text| text.trim().chars().take(900).collect::<String>())
        .unwrap_or_default();
    let title = work
        .goal
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(120)
        .collect::<String>();
    c.execute_batch("COMMIT").map_err(|e| e.to_string())?;
    permit.checkpoint()?;
    Ok(
        json!({"title":title,"text":format!("旧对话摘录（仅作历史参考）\n提问：{question}\n{answer}")}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_work::{store, Grant};
    use crate::source_evidence::tests::Fixture;

    #[test]
    fn related_history_is_scoped_and_matches_user_questions_without_material_snapshots() {
        let f = Fixture::new();
        let c = f.c();
        let make = |title: &str| {
            store::create_on(&c, title.into(), String::new(), None, Grant::default()).unwrap()
        };
        let other = make("检查重复发送附件");
        let correct = make("查看工作台");
        let deleted = make("反复重复发送附件");
        let revoked = make("之前重复发送附件");
        c.execute("INSERT INTO memory_projects VALUES('other','Other')", [])
            .unwrap();
        c.execute(
            "INSERT INTO memory_work_scopes VALUES(?1,'other',0)",
            [&other],
        )
        .unwrap();
        c.execute(
            "UPDATE agent_works SET state='revoked' WHERE id=?1",
            [&revoked],
        )
        .unwrap();
        store::insert(
            &c,
            &deleted,
            None,
            "historyPreference",
            &json!({"deleted":true}),
        )
        .unwrap();
        store::insert(
            &c,
            &correct,
            None,
            "userMessage",
            &json!({"text":format!("图片会重复发送附件吗？\n{SNAPSHOT_MARKER}\n会议附件原文")}),
        )
        .unwrap();
        let args = json!({"query":"再看一下重复发送附件怎么办"});
        let matches = find(&f.root, &args).unwrap();
        assert_eq!(matches.as_array().unwrap().len(), 1);
        assert_eq!(matches[0]["id"], correct);
        assert_eq!(matches[0]["excerpt"], "图片会重复发送附件吗？");
        assert!(find(&f.root, &json!({"query":"会议附件原文"}))
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty());
        let manual =
            super::super::list_on(&c, "null", None, Some(&json!("重复发送附件")), None).unwrap();
        assert!(manual["works"]
            .as_array()
            .unwrap()
            .iter()
            .any(|w| w["id"] == correct));
        let extract = reference(&f.root, &json!({"id":correct})).unwrap();
        assert!(extract["text"]
            .as_str()
            .unwrap()
            .contains("图片会重复发送附件吗"));
        assert!(!extract["text"].as_str().unwrap().contains("会议附件原文"));
        for id in [other, deleted, revoked] {
            assert!(reference(&f.root, &json!({"id":id})).is_err());
        }
    }

    #[test]
    fn conversation_reference_binds_to_the_original_message_without_a_second_user_bubble() {
        let f = Fixture::new();
        let c = f.c();
        let title = "请沿用参考结论";
        let id = store::create_on(&c, title.into(), String::new(), None, Grant::default()).unwrap();
        let attached = json!([{"kind":"conversation","conversationId":"old","title":"已核对的旧对话","text":"一段历史参考。"}]);
        let text = format!("{title}\n\n{SNAPSHOT_MARKER}\n{attached}");
        let change = |text: &str| json!({"text":text,"clientMessageId":"ref","expectedRevision":1,"initialRequest":true});
        assert!(conversation::message(
            &f.root,
            &id,
            &change(&text.replace(title, "一个不同的问题"))
        )
        .is_err());
        conversation::message(&f.root, &id, &change(&text)).unwrap();
        conversation::message(&f.root, &id, &change(&text)).unwrap();
        let work = store::load(&c, &id).unwrap();
        let result = conversation::read_on(&f.root, &c, &work).unwrap();
        let messages = result["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["text"], text);
        assert_eq!(
            messages[0]["displayText"],
            format!("{title}\n\n引用旧对话 · 已核对的旧对话")
        );
    }
}
