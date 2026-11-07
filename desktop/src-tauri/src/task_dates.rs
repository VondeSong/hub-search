//! Task-level dates and confirmed Hub activity. Import time is never task history.
use super::*;
use chrono::{DateTime, Datelike, FixedOffset, NaiveDate, SecondsFormat};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct TaskCompletionEvent {
    pub at: String,
    pub source: String,
    pub reopened: bool,
}

#[derive(Default)]
pub(super) struct TaskDates {
    pub title: Option<String>,
    pub created_at: Option<String>,
    pub completed_at: Option<String>,
    pub scheduled_at: Option<String>,
    pub start_at: Option<String>,
    pub due_at: Option<String>,
    pub reminder_at: Vec<String>,
    pub completion_history: Vec<TaskCompletionEvent>,
}

pub(super) fn install_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS task_activity (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           provider TEXT NOT NULL,
           library_id TEXT NOT NULL,
           source_id TEXT NOT NULL,
           at TEXT NOT NULL,
           state TEXT NOT NULL CHECK(state IN ('open','completed')),
           origin TEXT NOT NULL CHECK(origin IN ('hub','source')),
           reopened INTEGER NOT NULL DEFAULT 0 CHECK(reopened IN (0,1))
         );
         CREATE INDEX IF NOT EXISTS task_activity_source
           ON task_activity(provider,library_id,source_id,id);",
        )
        .map_err(|error| format!("无法初始化任务完成记录：{error}"))?;
    let legacy_sql: String = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='task_activity'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if legacy_sql.contains("CHECK(origin='hub')") {
        connection.execute_batch("BEGIN IMMEDIATE;
            ALTER TABLE task_activity RENAME TO task_activity_legacy;
            CREATE TABLE task_activity (
              id INTEGER PRIMARY KEY AUTOINCREMENT,provider TEXT NOT NULL,library_id TEXT NOT NULL,
              source_id TEXT NOT NULL,at TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('open','completed')),
              origin TEXT NOT NULL CHECK(origin IN ('hub','source')),
              reopened INTEGER NOT NULL DEFAULT 0 CHECK(reopened IN (0,1)));
            INSERT INTO task_activity(id,provider,library_id,source_id,at,state,origin)
              SELECT id,provider,library_id,source_id,at,state,origin FROM task_activity_legacy;
            DROP TABLE task_activity_legacy;
            COMMIT;").map_err(|error| format!("无法保留旧任务完成记录：{error}"))?;
    }
    connection.execute_batch("CREATE INDEX IF NOT EXISTS task_activity_source ON task_activity(provider,library_id,source_id,id);
        CREATE UNIQUE INDEX IF NOT EXISTS task_activity_receipt ON task_activity(provider,library_id,source_id,at,state,origin);").map_err(|error| format!("无法初始化任务完成回执：{error}"))?;
    let has_created: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('craft_task_blocks') WHERE name='created_at')",[],|row| row.get(0)).map_err(|error| error.to_string())?;
    let has_craft: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='craft_task_blocks')",[],|row| row.get(0)).map_err(|error| error.to_string())?;
    if has_craft && !has_created {
        connection
            .execute_batch("ALTER TABLE craft_task_blocks ADD COLUMN created_at TEXT;")
            .map_err(|error| format!("无法初始化 Craft 任务创建时间：{error}"))?;
    }
    Ok(())
}

/// Explicit civil dates stay civil. Zoned timestamps retain their real offset.
/// Naive timestamps and numeric import/index timestamps are deliberately absent.
pub(super) fn valid_date(value: &str) -> Option<String> {
    let value = value.trim();
    if value.len() == 10
        && value.as_bytes().get(4) == Some(&b'-')
        && value.as_bytes().get(7) == Some(&b'-')
    {
        let date = NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()?;
        return (date.year() > 0 && date.format("%Y-%m-%d").to_string() == value)
            .then(|| value.to_string());
    }
    let date = DateTime::parse_from_rfc3339(value)
        .or_else(|_| DateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f%z"))
        .ok()?;
    (date.timestamp() > 0).then(|| date.to_rfc3339_opts(SecondsFormat::AutoSi, false))
}

fn source_date(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str).and_then(valid_date))
}

pub(super) fn dida_dates(
    raw: &Value,
    completed: bool,
    stored_completed: Option<&str>,
) -> TaskDates {
    let created_at = source_date(
        raw,
        &["createdTime", "created_time", "createdAt", "created_at"],
    );
    let source_completion = stored_completed
        .and_then(valid_date)
        .or_else(|| source_date(raw, &["completedTime", "completed_time"]));
    let completed_at = completed.then(|| source_completion.clone()).flatten();
    let completion_history = source_completion
        .map(|at| {
            vec![TaskCompletionEvent {
                at,
                source: "source".into(),
                reopened: !completed,
            }]
        })
        .unwrap_or_default();
    let mut reminder_at = Vec::new();
    for reminder in raw
        .get("reminders")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(trigger) = reminder.as_str() else {
            continue;
        };
        if let Some(at) = dida_reminder_at(raw, trigger) {
            if !reminder_at.contains(&at) {
                reminder_at.push(at);
            }
        }
    }
    reminder_at.sort();
    TaskDates {
        created_at,
        completed_at,
        reminder_at,
        completion_history,
        ..TaskDates::default()
    }
}

/// TickTick's official CLI specifies RFC-style TRIGGER relative to START/END.
/// Calendar-month/year offsets and timezone-less reference dates are ambiguous,
/// so they are not converted into a guessed reminder day.
fn dida_reminder_at(raw: &Value, trigger: &str) -> Option<String> {
    let (header, duration) = trigger.split_once(':')?;
    let keys: &[&str] = match header {
        "TRIGGER" | "TRIGGER;RELATED=START" => &["startDate", "start_date"],
        "TRIGGER;RELATED=END" => &["dueDate", "due_date"],
        _ => return None,
    };
    let base = source_date(raw, keys)?;
    let base: DateTime<FixedOffset> = DateTime::parse_from_rfc3339(&base).ok()?;
    let seconds = duration_seconds(duration)?;
    let at = base.checked_add_signed(chrono::Duration::try_seconds(seconds)?)?;
    (at.timestamp() > 0).then(|| at.to_rfc3339_opts(SecondsFormat::AutoSi, false))
}

fn duration_seconds(value: &str) -> Option<i64> {
    let (sign, value) = if let Some(value) = value.strip_prefix('-') {
        (-1_i64, value)
    } else {
        (1, value)
    };
    let value = value.strip_prefix('P')?;
    let mut total = 0_i64;
    let mut number = String::new();
    let mut time = false;
    let mut seen = HashSet::new();
    let mut last_rank = 0;
    for character in value.chars() {
        if character.is_ascii_digit() {
            number.push(character);
            continue;
        }
        if character == 'T' && !time && number.is_empty() {
            time = true;
            continue;
        }
        let amount = number.parse::<i64>().ok()?;
        number.clear();
        let (factor, rank) = match (time, character) {
            (false, 'W') => (604_800, 1),
            (false, 'D') => (86_400, 2),
            (true, 'H') => (3_600, 3),
            (true, 'M') => (60, 4),
            (true, 'S') => (1, 5),
            _ => return None,
        };
        if !seen.insert((time, character)) || rank <= last_rank {
            return None;
        }
        last_rank = rank;
        total = total.checked_add(amount.checked_mul(factor)?)?;
    }
    if !number.is_empty() || seen.is_empty() || value.ends_with('T') {
        return None;
    }
    total.checked_mul(sign)
}

/// Explicit Obsidian Tasks emoji and Dataview fields only; no filename/mtime inference.
pub(super) fn obsidian_dates(title: &str, completed: bool) -> TaskDates {
    let mut dates = TaskDates::default();
    let mut spans: Vec<(usize, usize)> = Vec::new();
    let bytes = title.as_bytes();
    let mut code = false;
    let mut index = 0;
    while index < title.len() {
        let character = title[index..].chars().next().unwrap();
        if character == '`' {
            code = !code;
            index += 1;
            continue;
        }
        if code {
            index += character.len_utf8();
            continue;
        }
        let emoji_field = match character {
            '➕' => Some("created"),
            '✅' => Some("completion"),
            '📅' | '🗓' => Some("due"),
            '⏳' => Some("scheduled"),
            '🛫' => Some("start"),
            _ => None,
        };
        if let Some(field) = emoji_field {
            let prefix = character.len_utf8();
            let tail = title[index + prefix..]
                .trim_start_matches('\u{fe0f}')
                .trim_start();
            let start = title.len() - tail.len();
            if tail.len() >= 10 && tail.is_char_boundary(10) {
                let candidate = &tail[..10];
                let boundary = tail[10..].chars().next().is_none_or(|next| {
                    next.is_whitespace()
                        || matches!(next, '[' | '(' | '#' | '➕' | '✅' | '📅' | '⏳' | '🛫')
                });
                if boundary {
                    if let Some(date) = valid_date(candidate) {
                        assign_date(&mut dates, field, date);
                        spans.push((index, start + 10));
                        index = start + 10;
                        continue;
                    }
                }
            }
        }
        if matches!(character, '[' | '(') {
            let end_char = if character == '[' { ']' } else { ')' };
            if let Some(length) = title[index + 1..].find(end_char) {
                let end = index + 1 + length;
                if let Some((field, value)) = title[index + 1..end].split_once("::") {
                    let field = field.trim();
                    if matches!(
                        field,
                        "created" | "completion" | "due" | "scheduled" | "start"
                    ) {
                        if let Some(date) = valid_date(value) {
                            assign_date(&mut dates, field, date);
                            spans.push((index, end + 1));
                            index = end + 1;
                            continue;
                        }
                    }
                }
            }
        }
        index += if bytes[index].is_ascii() {
            1
        } else {
            character.len_utf8()
        };
    }
    if let Some(at) = dates.completed_at.as_ref().filter(|at| !at.is_empty()) {
        dates.completion_history.push(TaskCompletionEvent {
            at: at.clone(),
            source: "source".into(),
            reopened: !completed,
        });
    }
    if !completed {
        dates.completed_at = None;
    }
    if !spans.is_empty() {
        let mut clean = String::new();
        let mut previous = 0;
        for (start, end) in spans {
            clean.push_str(&title[previous..start]);
            previous = end;
        }
        clean.push_str(&title[previous..]);
        dates.title = Some(clean.split_whitespace().collect::<Vec<_>>().join(" "));
    }
    dates
}

fn assign_date(dates: &mut TaskDates, field: &str, date: String) {
    let target = match field {
        "created" => &mut dates.created_at,
        "completion" => &mut dates.completed_at,
        "due" => &mut dates.due_at,
        "scheduled" => &mut dates.scheduled_at,
        "start" => &mut dates.start_at,
        _ => return,
    };
    // Conflicting annotations remain unknown instead of choosing the first date.
    match target {
        Some(existing) if *existing != date => {
            *target = Some(String::new());
        }
        None => {
            *target = Some(date);
        }
        _ => {}
    }
}

pub(super) fn apply_source_dates(task: &mut UnifiedTaskItem, dates: TaskDates) {
    if let Some(title) = dates.title.filter(|title| !title.is_empty()) {
        task.title = clean_task_display_title(&title);
    }
    let nonempty = |date: Option<String>| date.filter(|date| !date.is_empty());
    task.created_at = nonempty(dates.created_at);
    task.completed_at = nonempty(dates.completed_at);
    task.created_time_source = task.created_at.as_ref().map(|_| "source".to_string());
    task.completed_time_source = task.completed_at.as_ref().map(|_| "source".to_string());
    task.scheduled_at = nonempty(dates.scheduled_at);
    if let Some(date) = nonempty(dates.start_at) {
        task.start_at = Some(date);
    }
    if let Some(date) = nonempty(dates.due_at) {
        task.due_at = Some(date);
    }
    task.reminder_at = dates.reminder_at;
    task.completion_history.extend(dates.completion_history);
}

pub(super) fn record_confirmed_transition(
    connection: &Connection,
    previous: &UnifiedTaskItem,
    confirmed: &UnifiedTaskItem,
    at: &str,
) -> Result<bool, String> {
    if previous.provider != confirmed.provider
        || previous.library_id != confirmed.library_id
        || previous.source_id != confirmed.source_id
        || previous.is_project
        || confirmed.is_project
        || previous.source_id.contains(":line:")
        || !matches!(previous.status.as_str(), "open" | "completed")
        || !matches!(confirmed.status.as_str(), "open" | "completed")
        || confirmed.completed != (confirmed.status == "completed")
    {
        return Err("无法确认任务完成记录的来源".into());
    }
    if previous.status == confirmed.status {
        return Ok(false);
    }
    let at = valid_date(at)
        .filter(|value| value.len() > 10)
        .ok_or("任务完成记录时间无效")?;
    connection.execute(
        "INSERT INTO task_activity(provider,library_id,source_id,at,state,origin) VALUES(?1,?2,?3,?4,?5,'hub')",
        params![confirmed.provider,confirmed.library_id,confirmed.source_id,at,confirmed.status],
    ).map_err(|error| format!("源任务状态已确认，但无法保存完成记录：{error}"))?;
    Ok(true)
}

/// Receipts retain only explicit source completion dates. Observing an open
/// stable task marks existing receipts reopened without inventing a reopen time.
/// Positional Markdown locators are deliberately excluded from durable history.
pub(super) fn capture_source_history(
    connection: &Connection,
    tasks: &[UnifiedTaskItem],
) -> Result<(), String> {
    let stable = tasks
        .iter()
        .filter(|task| {
            !task.is_project
                && !task.source_id.contains(":line:")
                && matches!(task.provider.as_str(), PROVIDER_CRAFT | PROVIDER_DIDA365)
        })
        .collect::<Vec<_>>();
    if stable.is_empty() {
        return Ok(());
    }
    let _writer = database::lock_database_writer()?;
    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| format!("无法保存源任务完成记录：{error}"))?;
    {
        let mut insert = transaction.prepare("INSERT OR IGNORE INTO task_activity(provider,library_id,source_id,at,state,origin,reopened) VALUES(?1,?2,?3,?4,'completed','source',?5)")
            .map_err(|error| error.to_string())?;
        let mut reopen = transaction.prepare("UPDATE task_activity SET reopened=1 WHERE provider=?1 AND library_id=?2 AND source_id=?3 AND state='completed' AND reopened=0")
            .map_err(|error| error.to_string())?;
        for task in stable {
            for event in task
                .completion_history
                .iter()
                .filter(|event| event.source == "source")
            {
                if let Some(at) = valid_date(&event.at) {
                    insert
                        .execute(params![
                            task.provider,
                            task.library_id,
                            task.source_id,
                            at,
                            event.reopened as i64
                        ])
                        .map_err(|error| format!("无法保存源任务完成日期：{error}"))?;
                }
            }
            if task.status == "open" {
                reopen
                    .execute(params![task.provider, task.library_id, task.source_id])
                    .map_err(|error| format!("无法保留任务重开状态：{error}"))?;
            }
        }
    }
    transaction
        .commit()
        .map_err(|error| format!("无法提交源任务完成记录：{error}"))
}

pub(super) fn attach_hub_history(
    connection: &Connection,
    tasks: &mut [UnifiedTaskItem],
) -> Result<(), String> {
    let mut statement = connection
        .prepare("SELECT provider,library_id,source_id,at,state,origin,reopened FROM task_activity ORDER BY id")
        .map_err(|error| format!("无法读取任务完成记录：{error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, i64>(6)? != 0,
            ))
        })
        .map_err(|error| format!("任务完成记录查询失败：{error}"))?;
    let mut histories: HashMap<(String, String, String), Vec<(String, String, String, bool)>> =
        HashMap::new();
    for row in rows {
        let (provider, library, source, at, state, origin, reopened) =
            row.map_err(|error| error.to_string())?;
        if valid_date(&at).is_some() {
            histories
                .entry((provider, library, source))
                .or_default()
                .push((at, state, origin, reopened));
        }
    }
    for task in tasks {
        let Some(events) = histories.get(&(
            task.provider.clone(),
            task.library_id.clone(),
            task.source_id.clone(),
        )) else {
            continue;
        };
        let mut hub_completions = Vec::new();
        for (at, state, origin, reopened) in events {
            if state == "completed" {
                hub_completions.push(TaskCompletionEvent {
                    at: at.clone(),
                    source: origin.clone(),
                    reopened: *reopened,
                });
            } else {
                for event in &mut hub_completions {
                    event.reopened = true;
                }
            }
        }
        if task.completed_at.is_none() && task.status == "completed" {
            if let Some((at, _, origin, _)) =
                events.last().filter(|(_, state, origin, reopened)| {
                    state == "completed" && origin == "hub" && !reopened
                })
            {
                task.completed_at = Some(at.clone());
                task.completed_time_source = Some(origin.clone());
            }
        }
        // Keep every verified receipt. Source timestamps remain authoritative
        // for completedAt, while history deduplicates equal instants below.
        if task.status == "open" {
            for event in &mut hub_completions {
                event.reopened = true;
            }
        }
        task.completion_history.extend(hub_completions);
        normalize_history(&mut task.completion_history);
    }
    Ok(())
}

fn normalize_history(history: &mut Vec<TaskCompletionEvent>) {
    fn key(event: &TaskCompletionEvent) -> String {
        DateTime::parse_from_rfc3339(&event.at)
            .map(|date| {
                date.with_timezone(&chrono::Utc)
                    .to_rfc3339_opts(SecondsFormat::Millis, true)
            })
            .unwrap_or_else(|_| event.at.clone())
    }
    history.sort_by(|a, b| key(a).cmp(&key(b)).then_with(|| b.source.cmp(&a.source)));
    history.dedup_by(|a, b| {
        if key(a) == key(b) {
            b.reopened |= a.reopened;
            true
        } else {
            false
        }
    });
}

/// Called after stable source identities have been bound, before linked rows are
/// collapsed. All verified source dates and receipts remain on the single row.
pub(super) fn merge_linked_dates(tasks: &mut [UnifiedTaskItem]) {
    let mut dates_by_id: HashMap<
        String,
        (
            Option<(String, String)>,
            Option<(String, String)>,
            Vec<String>,
            Vec<TaskCompletionEvent>,
        ),
    > = HashMap::new();
    for task in tasks.iter().filter(|task| task.sync_state != "unlinked") {
        let dates = dates_by_id.entry(task.id.clone()).or_default();
        for (target, at, source) in [
            (&mut dates.0, &task.created_at, &task.created_time_source),
            (
                &mut dates.1,
                &task.completed_at,
                &task.completed_time_source,
            ),
        ] {
            if let (Some(at), Some(source)) = (at, source) {
                if target.is_none()
                    || (source == "source"
                        && target.as_ref().is_some_and(|(_, source)| source == "hub"))
                {
                    *target = Some((at.clone(), source.clone()));
                }
            }
        }
        for at in &task.reminder_at {
            if !dates.2.contains(at) {
                dates.2.push(at.clone());
            }
        }
        dates.3.extend(task.completion_history.clone());
    }
    for task in tasks
        .iter_mut()
        .filter(|task| task.sync_state != "unlinked")
    {
        if let Some((created, completed, reminders, history)) = dates_by_id.get(&task.id) {
            if task.created_at.is_none() {
                if let Some((at, source)) = created {
                    task.created_at = Some(at.clone());
                    task.created_time_source = Some(source.clone());
                }
            }
            if task.status == "completed" {
                if let Some((at, source)) = completed {
                    task.completed_at = Some(at.clone());
                    task.completed_time_source = Some(source.clone());
                }
            } else {
                task.completed_at = None;
                task.completed_time_source = None;
            }
            task.reminder_at = reminders.clone();
            task.completion_history = history.clone();
            normalize_history(&mut task.completion_history);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn task_dates_are_explicit_valid_civil_or_zoned_values() {
        assert_eq!(valid_date("2026-10-13").as_deref(), Some("2026-10-13"));
        assert_eq!(
            valid_date("2026-10-13T08:30:00.000+0800").as_deref(),
            Some("2026-10-13T08:30:00+08:00")
        );
        for invalid in [
            "2026-02-30",
            "2026-10-13T08:30:00",
            "0",
            "-1",
            "1760000000000",
            "",
        ] {
            assert!(valid_date(invalid).is_none(), "{invalid}");
        }
    }
    #[test]
    fn dida_created_and_completed_use_task_dates_never_modified_import_times() {
        let raw = json!({"createdTime":"2026-10-12T23:30:00+0000","completedTime":"2026-10-13T00:30:00+0000","modifiedTime":"2026-10-14T00:00:00Z"});
        let dates = dida_dates(&raw, true, None);
        assert_eq!(
            dates.created_at.as_deref(),
            Some("2026-10-12T23:30:00+00:00")
        );
        assert_eq!(
            dates.completed_at.as_deref(),
            Some("2026-10-13T00:30:00+00:00")
        );
        assert!(dida_dates(&raw, false, None).completed_at.is_none());
        let old = dida_dates(
            &json!({"status":2,"modifiedTime":"2026-10-13T00:00:00Z"}),
            true,
            Some("0"),
        );
        assert!(old.created_at.is_none() && old.completed_at.is_none());
    }
    #[test]
    fn dida_reminders_resolve_only_known_triggers_against_exact_reference() {
        let raw = json!({"startDate":"2026-10-14T00:15:00+0800","dueDate":"2026-10-15T01:00:00+0800","reminders":["TRIGGER:-PT30M","TRIGGER;RELATED=END:-P1D","TRIGGER:-P1M","TRIGGER:PT0S","TRIGGER:-PT30M",{},"TRIGGER:PT1H2H","TRIGGER:P999999999999D","TRIGGER:P999999999999999999999999999D"]});
        assert_eq!(
            dida_dates(&raw, false, None).reminder_at,
            vec![
                "2026-10-13T23:45:00+08:00",
                "2026-10-14T00:15:00+08:00",
                "2026-10-14T01:00:00+08:00"
            ]
        );
        assert!(dida_dates(
            &json!({"startDate":"2026-10-14","reminders":["TRIGGER:-PT30M"]}),
            false,
            None
        )
        .reminder_at
        .is_empty());
        assert!(dida_dates(
            &json!({"dueDate":"2026-10-14T08:00:00Z","reminders":["TRIGGER:-PT30M"]}),
            false,
            None
        )
        .reminder_at
        .is_empty());
    }
    #[test]
    fn obsidian_task_annotations_supply_distinct_dates_and_preserve_title() {
        let dates = obsidian_dates(
            "写方案 ➕ 2026-10-11 🛫 2026-10-12 ⏳ 2026-10-13 📅 2026-10-15 ✅ 2026-10-14 #工作",
            true,
        );
        assert_eq!(dates.title.as_deref(), Some("写方案 #工作"));
        assert_eq!(dates.created_at.as_deref(), Some("2026-10-11"));
        assert_eq!(dates.start_at.as_deref(), Some("2026-10-12"));
        assert_eq!(dates.scheduled_at.as_deref(), Some("2026-10-13"));
        assert_eq!(dates.due_at.as_deref(), Some("2026-10-15"));
        assert_eq!(dates.completed_at.as_deref(), Some("2026-10-14"));
        let fields = obsidian_dates(
            "审阅 [created:: 2026-10-12] (scheduled:: 2026-10-13) [completion:: 2026-10-14]",
            true,
        );
        assert_eq!(fields.title.as_deref(), Some("审阅"));
        assert_eq!(fields.created_at.as_deref(), Some("2026-10-12"));
        assert_eq!(fields.scheduled_at.as_deref(), Some("2026-10-13"));
        assert_eq!(fields.completed_at.as_deref(), Some("2026-10-14"));
    }
    #[test]
    fn obsidian_invalid_literal_or_conflicting_annotations_never_infer_dates() {
        let dates = obsidian_dates(
            "例子 `📅 2026-10-13` ➕ 2026-02-30 [created:: today]",
            false,
        );
        assert!(dates.created_at.is_none() && dates.due_at.is_none());
        assert!(dates.title.is_none());
        let mut task = fixture_task();
        apply_source_dates(
            &mut task,
            obsidian_dates("同一任务 📅 2026-10-13 [due:: 2026-10-14]", false),
        );
        assert!(task.due_at.is_none());
        assert!(obsidian_dates("已重开 ✅ 2026-10-13", false)
            .completed_at
            .is_none());
    }

    #[test]
    fn markdown_task_pipeline_reads_original_annotations_without_file_time_inference() {
        let markdown = "- [ ] 日期只是代码 `📅 2026-10-13`\n- [ ] **真实任务** ➕ 2026-10-12 ⏳ 2026-10-13 📅 2026-10-15\n- [x] 完成任务 ✅ 2026-10-13\n- [x] 没有完成日期\n- [ ] 重开的任务 ✅ 2026-10-13";
        let tasks = markdown_tasks(
            PROVIDER_OBSIDIAN,
            "vault",
            "Vault",
            "daily.md",
            "Daily",
            "daily.md",
            markdown,
            Some(1_760_000_000),
        );
        assert_eq!(tasks.len(), 5);
        assert!(tasks[0].due_at.is_none() && tasks[0].created_at.is_none());
        assert_eq!(tasks[1].title, "真实任务");
        assert_eq!(tasks[1].scheduled_at.as_deref(), Some("2026-10-13"));
        assert_eq!(tasks[1].due_at.as_deref(), Some("2026-10-15"));
        assert_eq!(tasks[2].completed_at.as_deref(), Some("2026-10-13"));
        assert!(tasks[3].completed_at.is_none() && tasks[3].completion_history.is_empty());
        assert!(tasks[4].completed_at.is_none());
        assert!(tasks[4].completion_history[0].reopened);
        let shifted = markdown_tasks(
            PROVIDER_OBSIDIAN,
            "vault",
            "Vault",
            "daily.md",
            "Daily",
            "daily.md",
            &format!("Heading\n{markdown}"),
            Some(1_780_000_000),
        );
        assert_ne!(tasks[1].source_id, shifted[1].source_id);
        assert_eq!(tasks[1].created_at, shifted[1].created_at);
        assert!(shifted[0].created_at.is_none());
    }

    #[test]
    fn task_activity_schema_and_receipts_survive_database_reopen_with_scope_isolation() {
        let path = tests_path();
        let connection = open_database(&path).unwrap();
        let initial = fixture_task();
        let mut completed = initial.clone();
        completed.status = "completed".into();
        completed.completed = true;
        record_confirmed_transition(
            &connection,
            &initial,
            &completed,
            "2026-10-13T09:00:00+08:00",
        )
        .unwrap();
        install_schema(&connection).unwrap();
        drop(connection);
        database::forget_initialized_database(&path);
        let connection = open_database(&path).unwrap();
        let mut unrelated = completed.clone();
        unrelated.library_id = "other-library".into();
        let mut tasks = vec![completed, unrelated];
        attach_hub_history(&connection, &mut tasks).unwrap();
        assert_eq!(tasks[0].completion_history.len(), 1);
        assert!(tasks[1].completed_at.is_none() && tasks[1].completion_history.is_empty());
        assert_eq!(
            connection
                .query_row(
                    "SELECT value FROM metadata WHERE key='schema_version'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            crate::DATABASE_SCHEMA_VERSION.to_string()
        );
        drop(connection);
        database::forget_initialized_database(&path);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    fn tests_path() -> PathBuf {
        std::env::temp_dir().join(format!(
            "hub-task-dates-{}-{}.sqlite3",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn craft_task_created_metadata_is_block_local_and_survives_native_indexing() {
        let parsed = json!({"id":"document-one","type":"page","markdown":"Page","metadata":{"createdAt":"2026-01-01T00:00:00Z"},"content":[
            {"id":"task-new","type":"text","markdown":"New task","listStyle":"task","taskInfo":{"state":"todo","scheduleDate":"2026-10-14"},"metadata":{"createdAt":"2026-10-13T09:00:00+08:00"}},
            {"id":"task-unknown","type":"text","markdown":"No creation metadata","listStyle":"task","taskInfo":{"state":"done"}},
            {"id":"task-invalid","type":"text","markdown":"Invalid date","listStyle":"task","taskInfo":{"state":"todo"},"metadata":{"createdAt":"2026-02-30"}}
        ]});
        let hints = structured_block_hints(&parsed);
        assert_eq!(
            hints
                .iter()
                .find(|hint| hint.id == "task-new")
                .unwrap()
                .task_created_at
                .as_deref(),
            Some("2026-10-13T09:00:00+08:00")
        );
        assert!(hints
            .iter()
            .find(|hint| hint.id == "task-unknown")
            .unwrap()
            .task_created_at
            .is_none());
        assert!(hints
            .iter()
            .find(|hint| hint.id == "task-invalid")
            .unwrap()
            .task_created_at
            .is_none());
        let root = tests_path().with_extension("fixture");
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("index.sqlite3");
        let store = BlobStore::open(&root.join("blobs")).unwrap();
        let document = IndexedDocument {
            space_id: "library".into(),
            id: "document-one".into(),
            title: "Page".into(),
            path: "Page".into(),
            folder_id: None,
            modified_at: Some(1_790_000_000),
            indexed_at: 1_790_000_100,
            content_hash: "fixture-hash".into(),
            markdown: "- [ ] New task\n- [x] No creation metadata\n- [ ] Invalid date".into(),
            attachments: vec![],
            block_hints: hints,
        };
        persist_document_batch_controlled(&path, &store, vec![document], None).unwrap();
        let connection = open_database(&path).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT created_at FROM craft_task_blocks WHERE block_id='task-new'",
                    [],
                    |row| row.get::<_, Option<String>>(0)
                )
                .unwrap()
                .as_deref(),
            Some("2026-10-13T09:00:00+08:00")
        );
        assert!(connection
            .query_row(
                "SELECT created_at FROM craft_task_blocks WHERE block_id='task-unknown'",
                [],
                |row| row.get::<_, Option<String>>(0)
            )
            .unwrap()
            .is_none());
        drop(connection);
        drop(store);
        database::forget_initialized_database(&path);
        assert!(
            root.starts_with(std::env::temp_dir())
                && root
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("hub-task-dates-")
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn source_completion_receipts_are_idempotent_and_survive_source_reopen_without_import_dates() {
        let connection = Connection::open_in_memory().unwrap();
        install_schema(&connection).unwrap();
        let mut task = fixture_task();
        task.provider = PROVIDER_DIDA365.into();
        task.status = "completed".into();
        task.completed = true;
        apply_source_dates(
            &mut task,
            dida_dates(
                &json!({"completedTime":"2026-10-13T10:00:00+08:00"}),
                true,
                None,
            ),
        );
        capture_source_history(&connection, std::slice::from_ref(&task)).unwrap();
        capture_source_history(&connection, std::slice::from_ref(&task)).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM task_activity", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        let mut reopened = fixture_task();
        reopened.provider = PROVIDER_DIDA365.into();
        capture_source_history(&connection, std::slice::from_ref(&reopened)).unwrap();
        attach_hub_history(&connection, std::slice::from_mut(&mut reopened)).unwrap();
        assert!(reopened.completed_at.is_none());
        assert_eq!(reopened.completion_history.len(), 1);
        assert_eq!(reopened.completion_history[0].source, "source");
        assert!(reopened.completion_history[0].reopened);
        let mut unknown = fixture_task();
        unknown.provider = PROVIDER_DIDA365.into();
        unknown.source_id = "imported-old-completed".into();
        unknown.status = "completed".into();
        unknown.completed = true;
        capture_source_history(&connection, std::slice::from_ref(&unknown)).unwrap();
        attach_hub_history(&connection, std::slice::from_mut(&mut unknown)).unwrap();
        assert!(unknown.completed_at.is_none() && unknown.completion_history.is_empty());
        let mut unstable = task;
        unstable.provider = PROVIDER_OBSIDIAN.into();
        unstable.source_id = "daily.md:line:2".into();
        capture_source_history(&connection, std::slice::from_ref(&unstable)).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM task_activity", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    fn fixture_task() -> UnifiedTaskItem {
        UnifiedTaskItem {
            id: "craft-task".into(),
            provider: PROVIDER_CRAFT.into(),
            library_id: "library".into(),
            source_id: "task-block".into(),
            title: "task".into(),
            status: "open".into(),
            ..UnifiedTaskItem::default()
        }
    }
    #[test]
    fn confirmed_completion_reopen_history_survives_refresh_and_unknown_import_does_not_gain_today()
    {
        let connection = Connection::open_in_memory().unwrap();
        install_schema(&connection).unwrap();
        let initial = fixture_task();
        let mut completed = initial.clone();
        completed.status = "completed".into();
        completed.completed = true;
        let mut imported = completed.clone();
        attach_hub_history(&connection, std::slice::from_mut(&mut imported)).unwrap();
        assert!(imported.completed_at.is_none() && imported.completion_history.is_empty());
        assert!(record_confirmed_transition(
            &connection,
            &initial,
            &completed,
            "2026-10-13T09:00:00+08:00"
        )
        .unwrap());
        assert!(!record_confirmed_transition(
            &connection,
            &completed,
            &completed,
            "2026-10-13T09:00:01+08:00"
        )
        .unwrap());
        attach_hub_history(&connection, std::slice::from_mut(&mut completed)).unwrap();
        assert_eq!(
            completed.completed_at.as_deref(),
            Some("2026-10-13T09:00:00+08:00")
        );
        assert_eq!(completed.completed_time_source.as_deref(), Some("hub"));
        let reopened = initial.clone();
        assert!(record_confirmed_transition(
            &connection,
            &completed,
            &reopened,
            "2026-10-14T10:00:00+08:00"
        )
        .unwrap());
        let mut reopened = initial.clone();
        attach_hub_history(&connection, std::slice::from_mut(&mut reopened)).unwrap();
        assert!(reopened.completed_at.is_none());
        assert_eq!(reopened.completion_history.len(), 1);
        assert!(reopened.completion_history[0].reopened);
        let mut changed = completed.clone();
        changed.source_id = "another-block".into();
        assert!(record_confirmed_transition(
            &connection,
            &initial,
            &changed,
            "2026-10-13T09:00:00+08:00"
        )
        .is_err());
    }
    #[test]
    fn linked_identity_merges_real_source_dates_and_verified_hub_history_once() {
        let mut craft = fixture_task();
        craft.id = "shared-hub-task".into();
        craft.sync_state = "linked".into();
        craft.status = "completed".into();
        craft.completed = true;
        craft.completion_history.push(TaskCompletionEvent {
            at: "2026-10-10T09:00:00+08:00".into(),
            source: "hub".into(),
            reopened: true,
        });
        let mut dida = craft.clone();
        dida.provider = PROVIDER_DIDA365.into();
        dida.source_id = "remote-task".into();
        dida.completion_history.clear();
        apply_source_dates(
            &mut dida,
            dida_dates(
                &json!({"createdTime":"2026-10-01T09:00:00+0800","completedTime":"2026-10-13T09:00:00+0800"}),
                true,
                None,
            ),
        );
        let mut tasks = vec![craft, dida];
        merge_linked_dates(&mut tasks);
        assert_eq!(
            tasks[0].created_at.as_deref(),
            Some("2026-10-01T09:00:00+08:00")
        );
        assert_eq!(
            tasks[0].completed_at.as_deref(),
            Some("2026-10-13T09:00:00+08:00")
        );
        assert_eq!(tasks[0].completion_history.len(), 2);
        assert_eq!(tasks[0].completion_history, tasks[1].completion_history);
    }

    #[test]
    fn completion_receipts_deduplicate_the_same_instant_across_offsets_and_prefer_source() {
        let mut events = vec![
            TaskCompletionEvent {
                at: "2026-10-13T01:00:00Z".into(),
                source: "hub".into(),
                reopened: true,
            },
            TaskCompletionEvent {
                at: "2026-10-13T09:00:00+08:00".into(),
                source: "source".into(),
                reopened: false,
            },
            TaskCompletionEvent {
                at: "2026-10-13T10:00:00+08:00".into(),
                source: "hub".into(),
                reopened: false,
            },
        ];
        normalize_history(&mut events);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].source, "source");
        assert!(events[0].reopened);
        assert!(!events[1].reopened);
    }
}
