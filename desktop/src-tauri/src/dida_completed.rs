//! Recently completed tasks share the normal provider snapshot. The daily view
//! never performs its own provider requests or guesses a completion timestamp.
use crate::{collect_dida_tasks, DidaTask};
use chrono::{DateTime, Duration, FixedOffset};
use serde_json::{json, Value};
use std::collections::HashMap;

pub(super) fn search_arguments(now: DateTime<FixedOffset>) -> Value {
    let day = now.date_naive();
    let start = (day - Duration::days(30))
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_local_timezone(*now.offset())
        .single()
        .unwrap();
    let end = (day + Duration::days(1))
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_local_timezone(*now.offset())
        .single()
        .unwrap();
    json!({"search":{"startDate":start.to_rfc3339(),"endDate":end.to_rfc3339()}})
}

pub(super) fn merge_snapshot(
    tasks: &mut Vec<DidaTask>,
    result: &Value,
    cached: &HashMap<String, Value>,
) -> usize {
    let mut completed = Vec::new();
    collect_dida_tasks(result, "inbox", &mut completed);
    let mut merged = 0;
    for mut task in completed.into_iter().filter(|task| task.status == 2) {
        // The completed endpoint may omit immutable creation metadata that
        // was already observed through the active-task endpoint.
        let previous = tasks
            .iter()
            .find(|previous| previous.id == task.id)
            .map(|previous| &previous.raw)
            .or_else(|| cached.get(&task.id));
        if let (Some(previous), Some(raw)) = (previous, task.raw.as_object_mut()) {
            for key in ["createdTime", "created_time", "createdAt", "created_at"] {
                if !raw.contains_key(key) {
                    if let Some(value) = previous.get(key).filter(|value| value.is_string()) {
                        raw.insert(key.into(), value.clone());
                    }
                }
            }
            task.created_time = crate::value_string(
                &task.raw,
                &["createdTime", "created_time", "createdAt", "created_at"],
            );
        }
        if let Some(index) = tasks.iter().position(|previous| previous.id == task.id) {
            tasks[index] = task;
        } else {
            tasks.push(task);
        }
        merged += 1;
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_uses_local_calendar_midnights_across_month_boundaries() {
        let now = DateTime::parse_from_rfc3339("2026-10-13T21:30:00+08:00").unwrap();
        let args = search_arguments(now);
        assert_eq!(args["search"]["startDate"], "2026-09-13T00:00:00+08:00");
        assert_eq!(args["search"]["endDate"], "2026-10-14T00:00:00+08:00");
    }

    #[test]
    fn completion_before_first_sync_enters_the_shared_snapshot_with_real_date() {
        let mut tasks = Vec::new();
        let completed = json!({"result":[{"id":"completed-before-sync","title":"Done",
            "projectId":"inbox12345","status":2,"completedTime":"2026-10-13T20:12:16+0800"}]});
        assert_eq!(merge_snapshot(&mut tasks, &completed, &HashMap::new()), 1);
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].project_id, "inbox");
        let dates = crate::task_dates::dida_dates(&tasks[0].raw, true, None);
        assert_eq!(
            dates.completed_at.as_deref(),
            Some("2026-10-13T20:12:16+08:00")
        );
        assert!(dates.created_at.is_none());
    }

    #[test]
    fn completion_replaces_active_copy_without_losing_known_creation_or_duplicates() {
        let mut tasks = Vec::new();
        collect_dida_tasks(
            &json!({"id":"known","title":"Active","projectId":"work","status":0,
            "createdTime":"2026-10-10T09:00:00+0800"}),
            "work",
            &mut tasks,
        );
        let completed = json!([{"id":"known","title":"Done","projectId":"work","status":2,
            "completedTime":"2026-10-13T20:12:16+0800"}]);
        merge_snapshot(&mut tasks, &completed, &HashMap::new());
        merge_snapshot(&mut tasks, &completed, &HashMap::new());
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].status, 2);
        assert_eq!(
            tasks[0].created_time.as_deref(),
            Some("2026-10-10T09:00:00+0800")
        );
    }

    #[test]
    fn cached_creation_survives_and_unknown_completion_dates_are_never_invented() {
        let cached = HashMap::from([(
            "cached".into(),
            json!({"createdTime":"2026-10-01T09:00:00+0800"}),
        )]);
        let mut tasks = Vec::new();
        merge_snapshot(
            &mut tasks,
            &json!([{"id":"cached","title":"Done","projectId":"work","status":2},
            {"id":"open","title":"Open","projectId":"work","status":0}]),
            &cached,
        );
        assert_eq!(tasks.len(), 1);
        let dates = crate::task_dates::dida_dates(&tasks[0].raw, true, None);
        assert_eq!(
            dates.created_at.as_deref(),
            Some("2026-10-01T09:00:00+08:00")
        );
        assert!(dates.completed_at.is_none());
    }

    #[test]
    fn discovered_completion_persists_through_the_normal_task_storage_boundary() {
        let path = std::env::temp_dir().join(format!(
            "hub-dida-completed-{}.sqlite3",
            crate::random_url_safe(12)
        ));
        let mut connection = crate::open_database(&path).unwrap();
        connection.execute("INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES('dida-test','dida365','Test',1,1)", []).unwrap();
        let mut tasks = Vec::new();
        merge_snapshot(
            &mut tasks,
            &json!([{"id":"completed-before-sync","title":"Done","projectId":"inbox",
            "status":2,"completedTime":"2026-10-13T20:12:16+0800"}]),
            &HashMap::new(),
        );
        let tx = connection.transaction().unwrap();
        crate::upsert_dida_task(&tx, "dida-test", "Inbox", &tasks[0], 100).unwrap();
        tx.commit().unwrap();
        let (status, at, raw): (i64, Option<String>, String) = connection.query_row(
            "SELECT status,completed_at,raw_json FROM dida_tasks WHERE task_id='completed-before-sync'", [],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).unwrap();
        let dates = crate::task_dates::dida_dates(
            &serde_json::from_str(&raw).unwrap(),
            status == 2,
            at.as_deref(),
        );
        assert_eq!(status, 2);
        assert_eq!(
            dates.completed_at.as_deref(),
            Some("2026-10-13T20:12:16+08:00")
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM documents WHERE space_id='dida-test'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        drop(connection);
        std::fs::remove_file(path).unwrap();
    }
}
