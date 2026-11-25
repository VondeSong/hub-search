//! Independent, bounded Dida discovery. Same storage and task projection as
//! full library sync; no journal-specific requests and no pretend webhook.
use super::*;
use std::sync::{atomic::AtomicBool, LazyLock};

static STARTED: AtomicBool = AtomicBool::new(false);
static REQUESTED: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));
static WAKE: AtomicBool = AtomicBool::new(false);

fn meta(c: &Connection, key: &str, value: &str) -> Result<(), String> {
    c.execute("INSERT INTO metadata(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,value]).map_err(|e|e.to_string())?;
    Ok(())
}

/// Overlap handles late arrivals; a long offline gap drains in successive
/// bounded windows. Advance only to the successfully read window's end.
pub(super) fn completed_window(now: i64, cursor: Option<i64>) -> (Value, i64) {
    let cursor = cursor.filter(|at| *at > 0 && *at <= now);
    let start = cursor.map(|at| at - 2 * 86400).unwrap_or(now - 30 * 86400);
    let end = if cursor.is_some() {
        (start + 14 * 86400).min(now + 86400)
    } else {
        now + 86400
    };
    let date = |at| {
        chrono::DateTime::from_timestamp(at, 0)
            .unwrap()
            .to_rfc3339()
    };
    (
        json!({"search":{"startDate":date(start),"endDate":date(end)}}),
        end.min(now),
    )
}

pub(super) fn persist_changed(
    path: &PathBuf,
    library: &str,
    tasks: Vec<DidaTask>,
    cursor: Option<i64>,
    project_next: Option<&str>,
    task_next: Option<&str>,
    operation: &library_runtime::Operation,
) -> Result<usize, String> {
    let (mut c, _writer) = open_write_database(path)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let inbox_project = {
        let mut projects = tx
            .prepare("SELECT project_id FROM dida_projects WHERE library_id=?1 ORDER BY length(project_id),project_id")
            .map_err(|e| e.to_string())?;
        let ids = projects
            .query_map([library], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        ids.into_iter().find(|id| is_dida_inbox_project_id(id))
    };
    let mut changed = 0;
    operation.commit(|| {
        for mut task in tasks {
            // Task details use an account inbox alias; keep the library's list identity.
            if is_dida_inbox_project_id(&task.project_id) {
                if let Some(project) = &inbox_project {
                    task.project_id = project.clone();
                }
            }
            let previous: Option<(String, String)> = tx
                .query_row(
                    "SELECT raw_json,project_id FROM dida_tasks WHERE library_id=?1 AND task_id=?2",
                    params![library, task.id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            let previous_raw = previous.as_ref().map(|(raw, _)| raw.as_str());
            if let Some(raw) = previous_raw.and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            {
                // Preserve omitted immutable/source fields, but explicit nulls
                // remain authoritative. Reparse through the normal adapter.
                if let (Some(old), Some(new)) = (raw.as_object(), task.raw.as_object_mut()) {
                    for (key, value) in old {
                        if !new.contains_key(key) {
                            new.insert(key.clone(), value.clone());
                        }
                    }
                }
                let mut parsed = Vec::new();
                collect_dida_tasks(&task.raw, &task.project_id, &mut parsed);
                if let Some(reparsed) = parsed.into_iter().find(|t| t.id == task.id) {
                    task = reparsed;
                }
                let old_modified = value_string(&raw, &["modifiedTime", "modified_time"]);
                if parse_remote_timestamp(old_modified.as_deref())
                    .zip(dida_task_modified_at(&task))
                    .is_some_and(|(old, new)| old > new)
                {
                    continue;
                }
            }
            if previous_raw
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
                .as_ref()
                == Some(&task.raw)
                && previous
                    .as_ref()
                    .is_some_and(|(_, project)| project == &task.project_id)
            {
                continue;
            }
            let name = tx
                .query_row(
                    "SELECT name FROM dida_projects WHERE library_id=?1 AND project_id=?2",
                    params![library, task.project_id],
                    |r| r.get::<_, String>(0),
                )
                .optional()
                .map_err(|e| e.to_string())?
                .unwrap_or_else(|| task.project_id.clone());
            upsert_dida_task(&tx, library, &name, &task, now_timestamp())?;
            changed += 1;
        }
        if let Some(cursor) = cursor {
            meta(
                &tx,
                &format!("dida_fast_completed:{library}"),
                &cursor.to_string(),
            )?;
        }
        if let Some(next) = project_next {
            meta(&tx, &format!("dida_fast_project:{library}"), next)?;
        }
        if let Some(next) = task_next {
            meta(&tx, &format!("dida_fast_task:{library}"), next)?;
        }
        tx.commit().map_err(|e| e.to_string())
    })?;
    Ok(changed)
}

async fn refresh_library(
    app: &AppHandle,
    state: &State<'_, AppState>,
    library: &str,
    requested: &HashSet<String>,
    inventory: bool,
) -> Result<usize, String> {
    let path = database_path(app)?;
    let root = path.parent().ok_or("资料库目录不可用")?;
    let admission = library_runtime::admission(root, library)?;
    // A full provider run already refreshes this library. Polls never queue
    // ahead of interactive status writers or overlap an old snapshot commit.
    let Ok(_guard) = admission.try_lock() else {
        return Err("滴答正在同步，稍后继续检查".into());
    };
    let op = library_runtime::begin(root, library, "检查滴答任务变化")?;
    let session = dida_task_status::ready_session(app, state, library).await?;
    let client = task_sync_http_client_with_timeout(Duration::from_secs(12))?;
    let (sources, project, cursor, task_next) = {
        let c = open_database(&path)?;
        let mut sources = BTreeSet::new();
        for id in requested {
            let target:Option<String>=c.query_row("SELECT source_id FROM unified_task_bindings WHERE hub_task_id=?1 AND provider='dida365' AND library_id=?2",params![id,library],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
            if let Some(target) = target {
                sources.insert(target);
            } else {
                let mut s = c
                    .prepare("SELECT task_id FROM dida_tasks WHERE library_id=?1")
                    .map_err(|e| e.to_string())?;
                let ids = s
                    .query_map([library], |r| r.get::<_, String>(0))
                    .map_err(|e| e.to_string())?;
                for source in ids {
                    let source = source.map_err(|e| e.to_string())?;
                    if unified_task_id(PROVIDER_DIDA365, library, &source) == *id {
                        sources.insert(source);
                        break;
                    }
                }
            }
        }
        let after = metadata_string(&c, &format!("dida_fast_task:{library}"));
        let mut s=c.prepare("SELECT task_id FROM dida_tasks WHERE library_id=?1 AND task_id>?2 ORDER BY task_id LIMIT 3").map_err(|e|e.to_string())?;
        let rows = s
            .query_map(params![library, after], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let next = rows.last().cloned().unwrap_or_default();
        sources.extend(rows);
        let after = metadata_string(&c, &format!("dida_fast_project:{library}"));
        let project:Option<String>=c.query_row("SELECT project_id FROM dida_projects WHERE library_id=?1 AND project_id>?2 ORDER BY project_id LIMIT 1",params![library,after],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        let cursor = metadata_string(&c, &format!("dida_fast_completed:{library}"))
            .parse()
            .ok();
        (sources, project, cursor, next)
    };
    let mut tasks = Vec::new();
    let mut completed_cursor = None;
    if inventory {
        let (args, next) = completed_window(now_timestamp(), cursor);
        op.checkpoint()?;
        let result = call_mcp_tool_raw(
            &client,
            &session,
            "list_completed_tasks_by_date",
            args,
            94_000_000,
        )
        .await?;
        let mut done = Vec::new();
        collect_dida_tasks(&tool_result_json(&result), "inbox", &mut done);
        // Verify a completed row against current state before replacing an
        // existing active row (recurrence/reopen and delayed list results).
        let c = open_database(&path)?;
        for task in done.into_iter().filter(|t| t.status == 2) {
            let current: Option<(i64, String)> = c
                .query_row(
                    "SELECT status,raw_json FROM dida_tasks WHERE library_id=?1 AND task_id=?2",
                    params![library, task.id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if current.as_ref().is_some_and(|(status, raw)| {
                *status == 0
                    && serde_json::from_str::<Value>(raw)
                        .ok()
                        .as_ref()
                        .is_some_and(|v| {
                            value_string(v, &["repeatFlag"]).is_some_and(|s| !s.is_empty())
                                || value_string(v, &["completedTime", "completed_time"])
                                    .as_deref()
                                    .and_then(task_dates::valid_date)
                                    .zip(
                                        task.completed_time
                                            .as_deref()
                                            .and_then(task_dates::valid_date),
                                    )
                                    .is_some_and(|(old, incoming)| old == incoming)
                        })
            }) {
                // Capture the occurrence receipt independently of current state.
                if let Some(at) = task
                    .completed_time
                    .as_deref()
                    .and_then(task_dates::valid_date)
                {
                    let (c, _writer) = open_write_database(&path)?;
                    op.commit(||c.execute("INSERT OR IGNORE INTO task_activity(provider,library_id,source_id,at,state,origin,reopened) VALUES('dida365',?1,?2,?3,'completed','source',1)",params![library,task.id,at]).map_err(|e|e.to_string()))?;
                }
            } else {
                tasks.push(task);
            }
        }
        completed_cursor = Some(next);
        if let Some(project) = &project {
            op.checkpoint()?;
            let result = call_mcp_tool_raw(
                &client,
                &session,
                "get_project_with_undone_tasks",
                json!({"project_id":project}),
                94_000_001,
            )
            .await?;
            let mut active = Vec::new();
            collect_dida_tasks(&tool_result_json(&result), project, &mut active);
            // A more recent active inventory wins over the completed query.
            for task in active {
                tasks.retain(|t| t.id != task.id);
                tasks.push(task);
            }
        }
    }
    for (i, source) in sources.into_iter().take(8).enumerate() {
        op.checkpoint()?;
        let result = match call_mcp_tool_raw(
            &client,
            &session,
            "get_task_by_id",
            json!({"task_id":source}),
            94_000_010 + i as u64,
        )
        .await
        {
            Ok(result) => result,
            Err(error) if dida_lookup_error_confirms_missing(&error) => continue,
            Err(error) => return Err(error),
        };
        let mut direct = Vec::new();
        collect_dida_tasks(&tool_result_json(&result), "inbox", &mut direct);
        if let Some(task) = direct.into_iter().find(|t| t.id == source) {
            tasks.retain(|t| t.id != source);
            tasks.push(task);
        }
    }
    op.checkpoint()?;
    persist_changed(
        &path,
        library,
        tasks,
        completed_cursor,
        inventory.then_some(project.as_deref().unwrap_or("")),
        Some(&task_next),
        &op,
    )
}

pub(super) async fn refresh(
    app: &AppHandle,
    state: &State<'_, AppState>,
    inventory: bool,
) -> Result<usize, String> {
    let Ok(_guard) = state.dida_refresh_guard.try_lock() else {
        return Ok(0);
    };
    let path = database_path(app)?;
    let ids = {
        let c = open_database(&path)?;
        let mut s = c
            .prepare("SELECT id FROM libraries WHERE provider='dida365' AND enabled=1 ORDER BY id")
            .map_err(|e| e.to_string())?;
        let rows = s
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    let requested = REQUESTED
        .lock()
        .map_err(|_| "任务刷新队列不可用")?
        .iter()
        .take(5)
        .cloned()
        .collect::<HashSet<_>>();
    let mut changed = 0;
    let mut success = true;
    for library in ids {
        let previous_token = session_for_space(state, &library)
            .ok()
            .map(|session| session.access_token);
        match refresh_library(app, state, &library, &requested, inventory).await {
            Ok(count) => changed += count,
            Err(error) => {
                dida_task_status::invalidate_authorization(
                    state,
                    &library,
                    previous_token.as_deref(),
                    &error,
                );
                success = false;
            }
        }
    }
    if success {
        let mut queue = REQUESTED.lock().map_err(|_| "任务刷新队列不可用")?;
        for id in requested {
            queue.remove(&id);
        }
        if !queue.is_empty() {
            WAKE.store(true, Ordering::Release);
        }
    }
    if changed > 0 {
        let _ = app.emit("task-list-updated", json!({"changed":changed}));
    }
    Ok(changed)
}

#[tauri::command]
pub(super) async fn refresh_unified_task_sources(
    app: AppHandle,
    task_ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let mut queue = REQUESTED.lock().map_err(|_| "任务刷新队列不可用")?;
        for id in task_ids.into_iter().take(8) {
            if queue.len() < 32 {
                queue.insert(id);
            }
        }
    }
    WAKE.store(true, Ordering::Release);
    // Focus/preview reads return immediately. The single worker owns remote
    // discovery, while UI reads continue to use the existing local snapshot.
    let _ = (&app, &state);
    Ok(())
}

pub(super) fn start(app: AppHandle) {
    if STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        if !background_workers::wait(Duration::from_secs(12)).await {
            return;
        }
        let mut last = Instant::now() - Duration::from_secs(300);
        let mut last_wake = Instant::now() - Duration::from_secs(30);
        while background_workers::running() {
            let state = app.state::<AppState>();
            let _ = dida_task_status::drain(&app, &state).await;
            let foreground = app
                .get_webview_window("main")
                .and_then(|w| w.is_focused().ok())
                .unwrap_or(false);
            let cadence = if foreground { 45 } else { 180 };
            let due = last.elapsed() >= Duration::from_secs(cadence);
            let wake =
                WAKE.load(Ordering::Acquire) && last_wake.elapsed() >= Duration::from_secs(10);
            if due || wake {
                WAKE.store(false, Ordering::Release);
                let _ = refresh(&app, &state, due || wake).await;
                last = Instant::now();
                last_wake = Instant::now();
            }
            if !background_workers::wait(Duration::from_secs(5)).await {
                break;
            }
        }
    });
}

#[cfg(test)]
mod tests;
