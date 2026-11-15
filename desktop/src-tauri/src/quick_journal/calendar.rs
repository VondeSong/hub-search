//! Calendar capture uses the existing durable journal queue and explicit Dida transport.
use super::*;

fn draft_key(slot: Option<&str>) -> Result<String, String> {
    match slot {
        None => Ok("quick_journal_draft".into()),
        Some(day) if format::valid_date(day) => Ok(format!("quick_journal_draft:{day}")),
        Some(key)
            if key
                .strip_prefix("edit:")
                .is_some_and(|id| format::hex_id(id, 32)) =>
        {
            Ok(format!("quick_journal_draft:{key}"))
        }
        _ => Err("日历草稿日期无效".into()),
    }
}
pub(super) fn key(slot: Option<&str>) -> Result<String, String> {
    draft_key(slot)
}

/// Hide only locally represented record blocks in the separate source-document card.
pub(crate) fn source_body(markdown: &str, known: &HashSet<String>) -> String {
    if known.is_empty() || format::blocks(markdown).is_err() {
        return markdown.into();
    }
    let mut pending = None;
    let mut ranges = Vec::new();
    for (event, range) in pulldown_cmark::Parser::new(markdown).into_offset_iter() {
        let pulldown_cmark::Event::Html(html) = event else {
            continue;
        };
        let parts: Vec<_> = html.split_whitespace().collect();
        if parts.len() != 5 || parts[1] != "hub-journal:v1" {
            continue;
        }
        if parts[2] == "begin" && known.contains(parts[3]) {
            pending = Some((parts[3].to_string(), range.start));
        }
        if parts[2] == "end" && pending.as_ref().is_some_and(|(id, _)| id == parts[3]) {
            let (_, start) = pending.take().unwrap();
            ranges.push(start..range.end);
        }
    }
    let mut body = markdown.to_string();
    for range in ranges.into_iter().rev() {
        body.replace_range(range, "");
    }
    body
}
pub(crate) fn known_records(c: &Connection) -> Result<HashMap<String, HashSet<String>>, String> {
    let exists:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='quick_journal_records')",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    let mut result: HashMap<String, HashSet<String>> = HashMap::new();
    if !exists {
        return Ok(result);
    }
    let mut query = c
        .prepare("SELECT id,library_id FROM quick_journal_records WHERE applied=1")
        .map_err(|e| e.to_string())?;
    for row in query
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?
    {
        let (id, library) = row.map_err(|e| e.to_string())?;
        result.entry(library).or_default().insert(id);
    }
    Ok(result)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
struct CaptureTask {
    title: String,
    completed: bool,
}
fn split(text: &str) -> (String, Vec<CaptureTask>) {
    let pattern = regex::Regex::new(r"^ {0,3}[-*+]\s+\[([ xX])\](?:[ \t]+(.*))?$").unwrap();
    let mut lines = Vec::new();
    let mut tasks = Vec::new();
    let mut fence: Option<(char, usize)> = None;
    for line in text.lines() {
        let trimmed = line.trim_start_matches(' ');
        let boundary = (line.len() - trimmed.len() <= 3)
            .then_some(trimmed)
            .and_then(|trimmed| trimmed.chars().next())
            .filter(|c| *c == '`' || *c == '~')
            .map(|c| (c, trimmed.chars().take_while(|v| *v == c).count()))
            .filter(|(_, n)| *n >= 3);
        if let Some((c, n)) = fence {
            if boundary.is_some_and(|(next, len)| {
                next == c && len >= n && trimmed.trim().chars().all(|v| v == c)
            }) {
                fence = None;
            }
            lines.push(line);
            continue;
        }
        if let Some(boundary) = boundary {
            fence = Some(boundary);
            lines.push(line);
            continue;
        }
        if let Some(found) = pattern.captures(line) {
            if let Some(title) = found
                .get(2)
                .map(|v| v.as_str().trim())
                .filter(|v| !v.is_empty())
            {
                tasks.push(CaptureTask {
                    title: title.into(),
                    completed: &found[1] != " ",
                });
            }
        } else {
            lines.push(line);
        }
    }
    (lines.join("\n").trim().into(), tasks)
}

fn bind_capture(c: &Connection, id: &str, intent: &str) -> Result<(), String> {
    let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT OR IGNORE INTO journal_calendar_captures(id,intent) VALUES(?1,?2)",
        params![id, intent],
    )
    .map_err(|e| e.to_string())?;
    let old: String = tx
        .query_row(
            "SELECT intent FROM journal_calendar_captures WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if old != intent {
        return Err("此草稿已提交过不同内容，请先核对原保存结果；原草稿保留".into());
    }
    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn journal_task_destinations(
    app: AppHandle,
    library_id: String,
) -> Result<Value, String> {
    crate::x_bookmarks::library::conversion::answer_target(&app, &library_id, "dida365", None).await
}

#[tauri::command]
pub(crate) async fn capture_calendar_journal(
    app: AppHandle,
    record: Record,
    library_id: Option<String>,
    project_id: Option<String>,
) -> Result<Value, String> {
    record.validate()?;
    let (text, tasks) = split(&record.text);
    if text.is_empty() && tasks.is_empty() && record.attachments.is_empty() {
        return Err("请填写日志正文或任务内容".into());
    }
    if tasks.len() > 50 {
        return Err("每次最多创建 50 条任务，请分次提交".into());
    }
    let db = database_path(&app)?;
    let library = library_id.unwrap_or_default();
    let project = project_id.unwrap_or_default();
    let remote = if tasks.is_empty() {
        Value::Null
    } else {
        if library.is_empty() || project.is_empty() {
            return Err("请选择滴答资料库和清单".into());
        }
        let target =
            crate::x_bookmarks::library::conversion::answer_target(&app, &library, "dida365", None)
                .await?;
        if !target["projects"]
            .as_array()
            .is_some_and(|values| values.iter().any(|p| p["id"] == project))
        {
            return Err("所选清单已不可用".into());
        }
        target
    };
    let _lock = LOCK.lock().await;
    // An immutable intent survives acknowledgement loss and prevents duplicate remote creates.
    let identity=serde_json::to_string(&json!({"record":record,"library":library,"project":project,"connection":remote["connection"]})).map_err(|e|e.to_string())?;
    {
        let (c, _guard) = open_write_database(&db)?;
        c.execute_batch("CREATE TABLE IF NOT EXISTS journal_calendar_captures(id TEXT PRIMARY KEY,intent TEXT NOT NULL);CREATE TABLE IF NOT EXISTS journal_calendar_tasks(id TEXT PRIMARY KEY,state TEXT NOT NULL,plan TEXT NOT NULL,object_id TEXT NOT NULL DEFAULT '',receipt TEXT NOT NULL DEFAULT '');").map_err(|e|e.to_string())?;
        bind_capture(&c, &record.id, &identity)?;
    }
    if !text.is_empty() || !record.attachments.is_empty() {
        let mut journal = record.clone();
        journal.text = text;
        enqueue(&db, &journal)?;
        apply_local(&db)?;
    }
    drop(_lock);
    for (index, task) in tasks.iter().enumerate() {
        let id = format!("{}:{index}", record.id);
        let plan = json!({"libraryId":library,"provider":"dida365","mode":"task","title":task.title,"text":"","projectId":project,"remote":remote,"journalDate":record.date,"completed":task.completed});
        let existing = {
            let (c, _guard) = open_write_database(&db)?;
            c.query_row(
                "SELECT state,object_id,plan FROM journal_calendar_tasks WHERE id=?1",
                [&id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| e.to_string())?
        };
        if let Some((state, object, saved)) = existing {
            if state == "verified" {
                continue;
            }
            if object.is_empty() {
                return Err(
                    "滴答上次创建结果尚未确认，请先核对目标清单；未再次创建，草稿保留".into(),
                );
            }
            let saved: Value = serde_json::from_str(&saved).map_err(|e| e.to_string())?;
            crate::x_bookmarks::library::conversion::inspect_answer(&app, &saved, &object).await?;
            let (c, _guard) = open_write_database(&db)?;
            c.execute(
                "UPDATE journal_calendar_tasks SET state='verified' WHERE id=?1",
                [&id],
            )
            .map_err(|e| e.to_string())?;
            continue;
        }
        {
            let (c, _guard) = open_write_database(&db)?;
            c.execute(
                "INSERT INTO journal_calendar_tasks(id,state,plan) VALUES(?1,'unknown',?2)",
                params![id, plan.to_string()],
            )
            .map_err(|e| e.to_string())?;
        }
        let receipt = crate::x_bookmarks::library::conversion::save_answer(
            &app,
            &plan,
            crate::model_runtime::Control::default(),
            |object| {
                let (c, _guard) = open_write_database(&db)?;
                c.execute(
                    "UPDATE journal_calendar_tasks SET object_id=?2 WHERE id=?1",
                    params![id, object],
                )
                .map_err(|e| e.to_string())?;
                Ok(())
            },
        )
        .await
        .map_err(|e| {
            format!("日志已保留；任务创建待核对：{e}。重试会先核对已知结果，不重复创建。")
        })?;
        {
            let (c, _guard) = open_write_database(&db)?;
            c.execute(
                "UPDATE journal_calendar_tasks SET state='verified',receipt=?2 WHERE id=?1",
                params![id, receipt.to_string()],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(json!({"id":record.id,"warning":null,"tasks":tasks.len()}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn journal_source_card_does_not_repeat_known_records_or_strip_fenced_examples() {
        let id = "a".repeat(32);
        let r = Record {
            version: 1,
            id: id.clone(),
            date: "2026-11-15".into(),
            text: "记录正文".into(),
            attachments: vec![],
        };
        let marker = r.markdown("assets");
        let markdown = format!("# 2026-11-15\n\n保留来源正文\n\n{marker}");
        let known = HashSet::from([id]);
        let body = source_body(&markdown, &known);
        assert!(body.contains("保留来源正文"));
        assert!(!body.contains("记录正文"));
        let example = format!("```html\n{marker}```");
        assert_eq!(source_body(&example, &known), example);
        assert_eq!(source_body(&markdown, &HashSet::new()), markdown);
    }

    #[test]
    fn journal_capture_replay_cannot_replace_a_saved_intent() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE journal_calendar_captures(id TEXT PRIMARY KEY,intent TEXT NOT NULL)",
        )
        .unwrap();
        bind_capture(&c, "record", "original").unwrap();
        bind_capture(&c, "record", "original").unwrap();
        assert!(bind_capture(&c, "record", "different").is_err());
        let saved: String = c
            .query_row(
                "SELECT intent FROM journal_calendar_captures WHERE id='record'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(saved, "original");
    }

    #[test]
    fn mixed_capture_keeps_fenced_checklists_and_routes_real_tasks() {
        let (text, tasks) = split("日志\n- [ ] 办事\n```md\n- [ ] 示例\n```\n- [x] 已做");
        assert_eq!(
            tasks,
            vec![
                CaptureTask {
                    title: "办事".into(),
                    completed: false
                },
                CaptureTask {
                    title: "已做".into(),
                    completed: true
                }
            ]
        );
        assert!(text.contains("- [ ] 示例"));
        assert!(!text.contains("办事"));
        assert!(draft_key(Some("2026-02-30")).is_err());
        assert!(draft_key(Some("../2026-11-15")).is_err());
        assert_eq!(draft_key(None).unwrap(), "quick_journal_draft");
    }
}
