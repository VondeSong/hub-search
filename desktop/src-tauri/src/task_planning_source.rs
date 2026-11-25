//! Explicit task reads and user-confirmed source actions share the normal adapters.
use super::*;
mod create;
mod notes;
mod workbench;

fn eligible(task: &UnifiedTaskItem) -> bool {
    !task.is_project && !task.completed && task.status == "open" && !task.source_id.is_empty()
}

async fn selected(app: &AppHandle, ids: &[String]) -> Result<Vec<UnifiedTaskItem>, String> {
    if ids.is_empty() || ids.len() > 32 || ids.iter().collect::<HashSet<_>>().len() != ids.len() {
        return Err("请选择 1–32 条不同的原任务".into());
    }
    let tasks = list_unified_tasks(app.clone()).await?.tasks;
    ids.iter()
        .map(|id| {
            tasks
                .iter()
                .find(|t| &t.id == id && eligible(t))
                .cloned()
                .ok_or_else(|| "原任务已完成、移除或不可用，请重新选择".into())
        })
        .collect()
}

fn parse_dida(raw: &Value, project: &str, source: &str) -> Result<DidaTask, String> {
    let mut tasks = Vec::new();
    collect_dida_tasks(raw, project, &mut tasks);
    tasks
        .into_iter()
        .find(|t| t.id == source && !t.kind.eq_ignore_ascii_case("NOTE"))
        .ok_or_else(|| "没有读到目标原任务；本地快照未被当作最新来源".into())
}

async fn read_dida(
    client: &reqwest::Client,
    session: &McpSession,
    source: &str,
    project: &str,
) -> Result<DidaTask, String> {
    let result = call_mcp_tool_raw(
        client,
        session,
        "get_task_by_id",
        json!({"task_id":source}),
        95_000_001,
    )
    .await?;
    parse_dida(&tool_result_json(&result), project, source)
}

async fn refresh_one(
    app: &AppHandle,
    state: &State<'_, AppState>,
    task: &UnifiedTaskItem,
) -> Result<(), String> {
    let path = database_path(app)?;
    let root = path.parent().ok_or("资料库目录不可用")?;
    let admission = library_runtime::admission(root, &task.library_id)?;
    let _guard = admission
        .try_lock()
        .map_err(|_| "来源正在同步，本次保留缓存，可稍后重试")?;
    let op = library_runtime::begin(root, &task.library_id, "核对本轮任务资料")?;
    let session = dida_task_status::ready_session(app, state, &task.library_id).await?;
    let client = task_sync_http_client_with_timeout(Duration::from_secs(12))?;
    match task.provider.as_str() {
        PROVIDER_DIDA365 => {
            let project: String = open_database(&path)?
                .query_row(
                    "SELECT project_id FROM dida_tasks WHERE library_id=?1 AND task_id=?2",
                    params![task.library_id, task.source_id],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            let fresh = read_dida(&client, &session, &task.source_id, &project).await?;
            dida_task_refresh::persist_changed(
                &path,
                &task.library_id,
                vec![fresh],
                None,
                None,
                None,
                &op,
            )?;
        }
        PROVIDER_CRAFT if !task.source_id.contains(":line:") => {
            daily_task_status::refresh_source_document(
                &path,
                &blob_store_for(app, state)?,
                &client,
                &session,
                task,
                95_010_000,
                &op,
            )
            .await?;
        }
        _ => return Err("此来源本轮使用本地索引，未执行远端核对".into()),
    }
    Ok(())
}

async fn refresh(
    app: &AppHandle,
    state: &State<'_, AppState>,
    ids: &[String],
) -> Result<Value, String> {
    let tasks = selected(app, ids).await?;
    let mut receipts = Vec::new();
    let started = Instant::now();
    for task in tasks {
        let remaining = Duration::from_secs(40).saturating_sub(started.elapsed());
        let cached = task.provider == PROVIDER_OBSIDIAN || task.source_id.contains(":line:");
        let result = if cached {
            Err("此来源本轮使用本地索引，未执行远端核对".into())
        } else if remaining.is_zero() {
            Err("本轮来源核对已超时，保留原缓存".into())
        } else {
            tokio::time::timeout(remaining, refresh_one(app, state, &task))
                .await
                .unwrap_or_else(|_| Err("来源核对超时，保留原缓存".into()))
        };
        receipts.push(
            json!({"taskId":task.id,"provider":task.provider,"libraryName":task.library_name,
            "state":if result.is_ok(){"confirmed"}else if cached{"cached"}else{"failed"},
            "checkedAt":now_timestamp(),"indexedAt":task.indexed_at,"error":result.err()}),
        );
    }
    let _ = app.emit("task-list-updated", json!({"reason":"planning-read"}));
    Ok(json!({"receipts":receipts,"coverage":"selected-tasks","inventoryComplete":false}))
}

#[tauri::command]
pub(super) async fn task_planning_source(
    app: AppHandle,
    state: State<'_, AppState>,
    args: Value,
) -> Result<Value, String> {
    match args["action"].as_str().unwrap_or_default() {
        "refresh" => {
            let ids: Vec<String> =
                serde_json::from_value(args["taskIds"].clone()).map_err(|_| "任务范围无效")?;
            refresh(&app, &state, &ids).await
        }
        "prepareNote" | "prepareFields" | "listFields" | "submitNote" | "inspectNote" | "listNotes" => {
            notes::dispatch(&app, &state, &args).await
        }
        "createTask" => create::dispatch(&app, &state, &args).await,
        "workbenchModel" | "workbenchPassages" => workbench::dispatch(&app, args).await,
        _ => Err("未知任务来源操作".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn task_reads_never_accept_another_id_or_note_as_the_target() {
        let note = json!({"id":"one","title":"Reference","kind":"NOTE","status":0});
        assert!(parse_dida(&note, "inbox", "one").is_err());
        let task = json!({"id":"two","projectId":"inbox","title":"Action","content":"Facts","kind":"TEXT","status":0});
        assert!(parse_dida(&task, "inbox", "one").is_err());
        assert_eq!(parse_dida(&task, "inbox", "two").unwrap().id, "two");
    }
    #[test]
    fn task_projection_excludes_notes_without_deleting_material_and_tracks_body_revisions() {
        let root =
            std::env::temp_dir().join(format!("hub-planning-projection-{}", random_url_safe(12)));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("test.sqlite3");
        let mut c = open_database(&path).unwrap();
        c.execute("INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES('fixture','dida365','Fixture',1,1)",[]).unwrap();
        let tx = c.transaction().unwrap();
        for (id, kind) in [("action", "TEXT"), ("reference", "NOTE")] {
            let raw = json!({"id":id,"projectId":"inbox","title":id,"content":"Before","kind":kind,"status":0,"priority":5,"tags":["下一步"]});
            let mut tasks = Vec::new();
            collect_dida_tasks(&raw, "inbox", &mut tasks);
            upsert_dida_task(&tx, "fixture", "Inbox", &tasks[0], 1).unwrap();
        }
        tx.commit().unwrap();
        let rows = unified_task_read::load(&c, None).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].source_id, "action");
        assert_eq!(rows[0].priority, Some(5));
        assert_eq!(rows[0].tags, vec!["下一步"]);
        let old = rows[0].content_revision.clone();
        c.execute("UPDATE dida_tasks SET content='Changed',raw_json=json_set(raw_json,'$.content','Changed') WHERE task_id='action'",[]).unwrap();
        assert_ne!(
            unified_task_read::load(&c, None).unwrap()[0].content_revision,
            old
        );
        assert_eq!(
            c.query_row(
                "SELECT COUNT(*) FROM documents WHERE id='reference'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        drop(c);
        forget_initialized_database(&path);
        fs::remove_dir_all(root).unwrap();
    }
}
