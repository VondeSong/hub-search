//! Status-only user intents. Existing task_sync_events is the durable outbox;
//! library admission serializes this writer with ordinary provider snapshots.
use super::*;

const ACTION: &str = "direct_task_status";

/// Restore only this provider's saved authorization after an offline startup,
/// and renew expiring tokens without waiting for a broad library sync.
pub(super) async fn ready_session(
    app: &AppHandle,
    state: &State<'_, AppState>,
    library: &str,
) -> Result<McpSession, String> {
    let cached = session_for_space(state, library);
    if isolated_runtime::enabled() {
        return cached;
    }
    let usable = |session: &McpSession| {
        load_credential(library)
            .map(|credential| {
                credential
                    .expires_at
                    .is_none_or(|at| at > now_timestamp() + 15)
                    && credential
                        .access_token
                        .as_deref()
                        .is_none_or(|token| token == session.access_token)
            })
            .unwrap_or(true)
    };
    if let Ok(session) = &cached {
        if usable(session) {
            return Ok(session.clone());
        }
    }
    let _restore = state.connection_restore_guard.lock().await;
    if let Ok(session) = session_for_space(state, library) {
        if usable(&session) {
            return Ok(session);
        }
    }
    let path = database_path(app)?;
    let (name,provider) = open_database(&path)?
        .query_row(
            "SELECT name,provider FROM libraries WHERE id=?1 AND provider IN ('craft','dida365') AND enabled=1",
            [library],
            |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)),
        )
        .map_err(|_| "任务资料库已关闭或移除")?;
    library_runtime::exists_gate(path.parent().ok_or("资料库目录不可用")?, library)?;
    if provider == PROVIDER_CRAFT {
        refresh_craft_session(library, state).await?;
        session_for_space(state, library)
    } else {
        restore_dida_session(&task_sync_http_client()?, state, library, &name).await
    }
}

pub(super) fn invalidate_authorization(
    state: &State<'_, AppState>,
    library: &str,
    used_token: Option<&str>,
    error: &str,
) {
    let error = error.to_ascii_lowercase();
    if !(error.contains("unauthorized")
        || error.contains("invalid_token")
        || error.contains("http 401"))
    {
        return;
    }
    if let Ok(mut sessions) = state.sessions.lock() {
        if sessions
            .get(library)
            .is_some_and(|session| used_token == Some(session.access_token.as_str()))
        {
            sessions.remove(library);
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StatusMutation {
    pub operation_id: i64,
    pub state: String,
    pub target_status: String,
    pub error: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Intent {
    task_id: String,
    library_id: String,
    source_id: String,
    status: String,
    expected_status: String,
    // Immutable source identity and transition baseline survive restarts.
    account: String,
    baseline_completion: Option<String>,
    sent: bool,
    remote_confirmed: bool,
    #[serde(default)]
    rebase_after_previous_write: bool,
    next_attempt_at: i64,
    mirror: Option<CraftTarget>,
    #[serde(default)]
    automatic: bool,
}

#[derive(Clone, Serialize, Deserialize)]
struct CraftTarget {
    library_id: String,
    source_id: String,
    document_id: String,
    #[serde(default)]
    modified_at: Option<i64>,
}

fn account(connection: &Connection, library: &str) -> Result<String, String> {
    let raw: Option<String> = connection
        .query_row(
            "SELECT metadata_json FROM libraries WHERE id=?1 AND enabled=1 AND provider='dida365'",
            [library],
            |r| r.get(0),
        )
        .map_err(|_| "滴答资料库已关闭或移除".to_string())?;
    let value: Value = raw
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    Ok(
        value_string(&value["preference"], &["userId", "id", "accountId"])
            .unwrap_or_else(|| format!("library:{library}")),
    )
}

fn local_task(connection: &Connection, library: &str, source: &str) -> Result<DidaTask, String> {
    let (project, raw): (String, String) = connection
        .query_row(
            "SELECT project_id,raw_json FROM dida_tasks WHERE library_id=?1 AND task_id=?2",
            params![library, source],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| "滴答源任务已不存在，请刷新".to_string())?;
    parse_task(
        &serde_json::from_str(&raw).map_err(|_| "滴答任务快照无效")?,
        &project,
        source,
    )
}

fn parse_task(raw: &Value, project: &str, source: &str) -> Result<DidaTask, String> {
    let mut tasks = Vec::new();
    collect_dida_tasks(raw, project, &mut tasks);
    tasks
        .into_iter()
        .find(|task| task.id == source)
        .ok_or_else(|| "没有取得目标滴答任务，未确认状态".into())
}

fn recurring(task: &DidaTask) -> bool {
    value_string(&task.raw, &["repeatFlag", "repeat_flag"])
        .is_some_and(|rule| !rule.trim().is_empty())
}

pub(super) fn blocked_reason(raw: &Value) -> Option<String> {
    value_string(raw, &["repeatFlag", "repeat_flag"])
        .filter(|rule| !rule.trim().is_empty())
        .map(|_| "循环任务请在滴答中修改，完成记录会自动同步".into())
}

/// Craft is still the preview source for linked rows. Resolve the actual Dida
/// binding, and freeze the allowed status-only mirror in this user intent.
pub(super) fn accepts(path: &PathBuf, task: &UnifiedTaskItem) -> Result<bool, String> {
    if task.provider == PROVIDER_DIDA365 {
        return Ok(true);
    }
    if task.provider != PROVIDER_CRAFT || task.sync_state != "linked" {
        return Ok(false);
    }
    let c = open_database(path)?;
    let allowed: bool = c
        .query_row(
            "SELECT enabled=1 AND craft_to_dida=1 FROM task_sync_settings WHERE id=1",
            [],
            |r| r.get(0),
        )
        .unwrap_or(false);
    Ok(allowed && c.query_row(
        "SELECT EXISTS(SELECT 1 FROM unified_task_bindings WHERE hub_task_id=?1 AND provider='dida365')",
        [&task.id], |r| r.get::<_, bool>(0),
    ).map_err(|e| e.to_string())?)
}

fn accept(path: &PathBuf, task: &UnifiedTaskItem, status: &str) -> Result<i64, String> {
    let (mut c, _writer) = open_write_database(path)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let target = if task.provider == PROVIDER_DIDA365 {
        (task.library_id.clone(), task.source_id.clone())
    } else {
        tx.query_row("SELECT library_id,source_id FROM unified_task_bindings WHERE hub_task_id=?1 AND provider='dida365'",
            [&task.id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|_| "滴答任务关联已变化".to_string())?
    };
    let source = local_task(&tx, &target.0, &target.1)?;
    if recurring(&source) {
        return Err("循环任务请在滴答中修改，完成记录会自动同步".into());
    }
    if dida_display_task_status(source.status) != task.status {
        return Err("两端任务状态不同，请先刷新核对".into());
    }
    let existing: Option<(i64, String, String)> = tx.query_row(
        "SELECT id,payload_json,status FROM task_sync_events WHERE action=?1 AND hub_task_id=?2 AND status IN ('pending','failed') ORDER BY id DESC LIMIT 1",
        params![ACTION, task.id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)),
    ).optional().map_err(|e| e.to_string())?;
    let mut rebase_after_previous_write = false;
    if let Some((id, raw, state)) = &existing {
        let intent: Intent = serde_json::from_str(raw).map_err(|_| "待同步操作无效")?;
        if intent.library_id != target.0
            || intent.source_id != target.1
            || intent.account != account(&tx, &target.0)?
        {
            return Err("任务来源关联或账号已变化，请刷新核对".into());
        }
        if intent.status == status && state == "pending" {
            return Ok(*id);
        }
        // The global status writer is held before accepting this replacement.
        // A previous wire write may have succeeded without a readable receipt;
        // the newly requested target must first read and rebase on that result.
        rebase_after_previous_write =
            intent.rebase_after_previous_write || (intent.sent && !intent.remote_confirmed);
    }
    let mirror_allowed: bool = tx.query_row(
        "SELECT enabled=1 AND CASE WHEN ?1='craft' THEN craft_to_dida=1 ELSE dida_to_craft=1 END FROM task_sync_settings WHERE id=1",
        [&task.provider], |r| r.get(0),
    ).unwrap_or(false);
    let mirror = if mirror_allowed {
        tx.query_row("SELECT b.library_id,b.source_id,b.document_id,t.modified_at FROM unified_task_bindings b JOIN libraries l ON l.id=b.library_id LEFT JOIN craft_task_blocks t ON t.space_id=b.library_id AND t.block_id=b.source_id AND t.document_id=b.document_id WHERE b.hub_task_id=?1 AND b.provider='craft' AND l.enabled=1",
            [&task.id], |r| Ok(CraftTarget {library_id:r.get(0)?,source_id:r.get(1)?,document_id:r.get(2)?,modified_at:r.get(3)?}))
            .optional().map_err(|e| e.to_string())?
    } else {
        None
    };
    if mirror.as_ref().is_some_and(|m| {
        !valid_craft_block_id(&m.source_id) || !valid_craft_block_id(&m.document_id)
    }) {
        return Err("关联的 Craft 任务不是可修改的原生任务".into());
    }
    let intent = Intent {
        task_id: task.id.clone(),
        library_id: target.0.clone(),
        source_id: target.1,
        status: status.into(),
        expected_status: task.status.clone(),
        account: account(&tx, &target.0)?,
        baseline_completion: source.completed_time,
        sent: false,
        remote_confirmed: false,
        rebase_after_previous_write,
        next_attempt_at: 0,
        mirror,
        automatic: false,
    };
    let now = now_timestamp();
    if let Some((id, _, _)) = existing {
        tx.execute("UPDATE task_sync_events SET status='resolved',updated_at=?2,last_error='已被最新状态操作替换' WHERE id=?1", params![id,now]).map_err(|e|e.to_string())?;
    }
    tx.execute("UPDATE task_sync_events SET status='resolved',updated_at=?2 WHERE action='direct_task_status' AND hub_task_id=?1 AND status='failed'", params![task.id,now]).map_err(|e|e.to_string())?;
    tx.execute("INSERT INTO task_sync_events(hub_task_id,origin_provider,target_provider,action,status,payload_json,idempotency_key,created_at,updated_at) VALUES(?1,'hub','dida365',?2,'pending',?3,?4,?5,?5)",
        params![task.id,ACTION,serde_json::to_string(&intent).map_err(|e|e.to_string())?,format!("direct-status:{}",random_url_safe(24)),now])
        .map_err(|e|format!("无法保存任务状态操作：{e}"))?;
    let id = tx.last_insert_rowid();
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

fn save_intent(
    path: &PathBuf,
    id: i64,
    intent: &Intent,
    state: &str,
    error: Option<&str>,
) -> Result<(), String> {
    let (c, _writer) = open_write_database(path)?;
    c.execute("UPDATE task_sync_events SET payload_json=?2,status=?3,updated_at=?4,last_error=?5 WHERE id=?1 AND action='direct_task_status'",
        params![id,serde_json::to_string(intent).map_err(|e|e.to_string())?,state,now_timestamp(),error.map(|e|e.chars().take(300).collect::<String>())])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Source-side status changes use the same outbox and only an already-bound
/// native Craft task. They never create tasks or enable synchronization.
pub(super) fn enqueue_observed(
    c: &Connection,
    library: &str,
    task: &DidaTask,
) -> Result<bool, String> {
    if !matches!(task.status, 0 | 2) {
        return Ok(false);
    }
    let allowed: bool = c
        .query_row(
            "SELECT enabled=1 AND dida_to_craft=1 FROM task_sync_settings WHERE id=1",
            [],
            |r| r.get(0),
        )
        .unwrap_or(false);
    if !allowed {
        return Ok(false);
    }
    let target:Option<(String,CraftTarget,bool)>=c.query_row(
        "SELECT d.hub_task_id,b.library_id,b.source_id,b.document_id,t.modified_at,t.completed FROM unified_task_bindings d JOIN unified_task_bindings b ON b.hub_task_id=d.hub_task_id AND b.provider='craft' JOIN libraries l ON l.id=b.library_id AND l.enabled=1 JOIN craft_task_blocks t ON t.space_id=b.library_id AND t.block_id=b.source_id AND t.document_id=b.document_id WHERE d.provider='dida365' AND d.library_id=?1 AND d.source_id=?2",
        params![library,task.id],|r|Ok((r.get(0)?,CraftTarget{library_id:r.get(1)?,source_id:r.get(2)?,document_id:r.get(3)?,modified_at:r.get(4)?},r.get::<_,i64>(5)?!=0))).optional().map_err(|e|e.to_string())?;
    let Some((hub, mirror, completed)) = target else {
        return Ok(false);
    };
    if !valid_craft_block_id(&mirror.source_id) || !valid_craft_block_id(&mirror.document_id) {
        return Ok(false);
    }
    if completed == (task.status == 2) {
        return c.execute("UPDATE task_sync_events SET status='resolved',updated_at=?2,last_error=NULL WHERE hub_task_id=?1 AND action='direct_task_status' AND origin_provider='dida365' AND status IN ('pending','failed')",params![hub,now_timestamp()]).map(|n|n>0).map_err(|e|e.to_string());
    }
    let blocked:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM task_sync_events WHERE hub_task_id=?1 AND ((action='direct_task_status' AND status='pending') OR (action='conflict' AND status='review')))",[&hub],|r|r.get(0)).map_err(|e|e.to_string())?;
    if blocked {
        return Ok(false);
    }
    let previous:Option<String>=c.query_row("SELECT payload_json FROM task_sync_events WHERE hub_task_id=?1 AND action='direct_task_status' AND origin_provider='dida365' AND status='failed' ORDER BY id DESC LIMIT 1",[&hub],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    if previous
        .as_deref()
        .and_then(|s| serde_json::from_str::<Intent>(s).ok())
        .is_some_and(|old| {
            old.status == dida_display_task_status(task.status)
                && old.baseline_completion == task.completed_time
        })
    {
        return Ok(false);
    }
    let intent = Intent {
        task_id: hub.clone(),
        library_id: library.into(),
        source_id: task.id.clone(),
        status: dida_display_task_status(task.status).into(),
        expected_status: dida_display_task_status(task.status).into(),
        account: account(c, library)?,
        baseline_completion: task.completed_time.clone(),
        sent: false,
        remote_confirmed: true,
        rebase_after_previous_write: false,
        next_attempt_at: 0,
        mirror: Some(mirror),
        automatic: true,
    };
    c.execute("INSERT INTO task_sync_events(hub_task_id,origin_provider,target_provider,action,status,payload_json,idempotency_key,created_at,updated_at) VALUES(?1,'dida365','craft','direct_task_status','pending',?2,?3,?4,?4)",params![hub,serde_json::to_string(&intent).map_err(|e|e.to_string())?,format!("source-status:{}",random_url_safe(24)),now_timestamp()]).map_err(|e|e.to_string())?;
    Ok(true)
}

pub(super) fn has_pending(path: &PathBuf, hub: &str) -> Result<bool, String> {
    open_database(path)?.query_row("SELECT EXISTS(SELECT 1 FROM task_sync_events WHERE action='direct_task_status' AND hub_task_id=?1 AND status='pending')",
        [hub], |r| r.get(0)).map_err(|e| e.to_string())
}

pub(super) fn decorate(c: &Connection, tasks: &mut [UnifiedTaskItem]) -> Result<(), String> {
    // Read the outbox once, rather than issuing one event query per task.
    let mut latest = HashMap::new();
    {
        let mut statement = c.prepare("SELECT hub_task_id,id,status,payload_json,last_error FROM task_sync_events WHERE action='direct_task_status' ORDER BY id").map_err(|e|e.to_string())?;
        let rows = statement
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, Option<String>>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (hub, id, state, raw, error) = row.map_err(|e| e.to_string())?;
            latest.insert(hub, (id, state, raw, error));
        }
    }
    for task in tasks {
        let row = latest.remove(&task.id);
        if let Some((id, state, raw, error)) = row {
            let intent: Intent = serde_json::from_str(&raw).map_err(|_| "任务状态操作记录无效")?;
            if matches!(state.as_str(), "pending" | "failed") && intent.remote_confirmed {
                // Confirmed Dida state remains visible while the permitted
                // Craft mirror waits. Never infer a state from a queued intent.
                if let Ok(source) = local_task(c, &intent.library_id, &intent.source_id) {
                    task.completed = source.status == 2;
                    task.status = dida_display_task_status(source.status).into();
                    task_dates::apply_source_dates(
                        task,
                        task_dates::dida_dates(
                            &source.raw,
                            source.status == 2,
                            source.completed_time.as_deref(),
                        ),
                    );
                }
            }
            if state != "resolved" || intent.remote_confirmed {
                task.status_mutation = Some(StatusMutation {
                    operation_id: id,
                    state: if state == "resolved" {
                        "confirmed".into()
                    } else {
                        state
                    },
                    target_status: intent.status,
                    error,
                });
            }
        }
    }
    Ok(())
}

fn transition_action(task: &DidaTask, intent: &Intent) -> Result<bool, String> {
    if recurring(task) {
        return Err("循环任务请在滴答中修改，未重复提交完成操作".into());
    }
    let state = dida_display_task_status(task.status);
    if state == intent.status {
        return Ok(false);
    }
    if state != intent.expected_status || task.completed_time != intent.baseline_completion {
        return Err("任务来源状态已变化，已停止旧操作，请刷新核对".into());
    }
    Ok(true)
}

fn write_arguments(task: &DidaTask, completed: bool) -> (&'static str, Value) {
    // The remote inbox account suffix is preserved in write requests.
    let project = value_string(&task.raw, &["projectId", "project_id"])
        .unwrap_or_else(|| task.project_id.clone());
    if completed {
        (
            "complete_task",
            json!({"project_id":project,"task_id":task.id}),
        )
    } else {
        let mut body = json!({"id":task.id,"projectId":project,"status":0});
        if let Some(etag) = value_string(&task.raw, &["etag"]) {
            body["etag"] = json!(etag);
        }
        ("update_task", json!({"task_id":task.id,"task":body}))
    }
}

async fn read_remote(
    client: &reqwest::Client,
    session: &McpSession,
    cached: &DidaTask,
    request: u64,
) -> Result<DidaTask, String> {
    let result = call_mcp_tool_raw(
        client,
        session,
        "get_task_by_id",
        json!({"task_id":cached.id}),
        request,
    )
    .await?;
    parse_task(&tool_result_json(&result), &cached.project_id, &cached.id)
}

async fn apply_remote(
    path: &PathBuf,
    id: i64,
    intent: &mut Intent,
    op: &library_runtime::Operation,
    client: &reqwest::Client,
    session: &McpSession,
) -> Result<(), String> {
    let cached = local_task(&open_database(path)?, &intent.library_id, &intent.source_id)?;
    op.phase("reading", "确认滴答源任务状态")?;
    let fresh = read_remote(client, session, &cached, 92_000_000 + id as u64 * 10).await?;
    if intent.rebase_after_previous_write {
        if recurring(&fresh) || !matches!(fresh.status, 0 | 2) {
            return Err("任务来源状态已变化，请在原应用确认".into());
        }
        intent.expected_status = dida_display_task_status(fresh.status).into();
        intent.baseline_completion = fresh.completed_time.clone();
        intent.rebase_after_previous_write = false;
        save_intent(path, id, intent, "pending", None)?;
        // Retain the observed completion history even if reopening clears the
        // provider's completedTime field in the next response.
        dida_task_refresh::persist_changed(
            path,
            &intent.library_id,
            vec![fresh.clone()],
            None,
            None,
            None,
            op,
        )?;
    }
    match transition_action(&fresh, intent) {
        Err(error) => {
            dida_task_refresh::persist_changed(
                path,
                &intent.library_id,
                vec![fresh],
                None,
                None,
                None,
                op,
            )?;
            return Err(error);
        }
        Ok(false) => {
            intent.baseline_completion = fresh.completed_time.clone();
            intent.remote_confirmed = true;
            return persist_confirmed(path, &fresh, id, intent, op);
        }
        Ok(true) => {}
    }
    op.checkpoint()?;
    intent.sent = true;
    save_intent(path, id, intent, "pending", None)?;
    op.phase("writing", "提交这一条任务的状态")?;
    let (tool, args) = write_arguments(&fresh, intent.status == "completed");
    let write =
        call_dida_write_tool_raw_once(client, session, tool, args, 92_000_001 + id as u64 * 10)
            .await;
    if let Err(error) = &write {
        if dida_rate_limit_error(error) {
            // Return promptly with the saved intent. Read current state after
            // cooldown before any subsequent attempt, including a restart.
            return Err(error.clone());
        }
    }
    op.phase("reading", "核对滴答提交结果")?;
    for attempt in 0..3 {
        match read_remote(
            client,
            session,
            &fresh,
            92_000_002 + id as u64 * 10 + attempt,
        )
        .await
        {
            Ok(task) if dida_display_task_status(task.status) == intent.status => {
                intent.baseline_completion = task.completed_time.clone();
                intent.remote_confirmed = true;
                return persist_confirmed(path, &task, id, intent, op);
            }
            Ok(_) => {}
            Err(error) => return Err(write.err().unwrap_or(error)),
        }
    }
    Err(write
        .err()
        .unwrap_or_else(|| "滴答状态尚未确认，操作已保存，稍后继续核对".into()))
}

fn persist_confirmed(
    path: &PathBuf,
    task: &DidaTask,
    id: i64,
    intent: &Intent,
    operation: &library_runtime::Operation,
) -> Result<(), String> {
    let (mut c, _writer) = open_write_database(path)?;
    let name = c
        .query_row(
            "SELECT name FROM dida_projects WHERE library_id=?1 AND project_id=?2",
            params![intent.library_id, task.project_id],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| task.project_id.clone());
    let tx = c.transaction().map_err(|e| e.to_string())?;
    operation.commit(|| {
        upsert_dida_task(&tx,&intent.library_id,&name,task,now_timestamp())?;
        tx.execute("UPDATE task_sync_events SET payload_json=?2,status=?3,updated_at=?4,last_error=NULL WHERE id=?1",
            params![id,serde_json::to_string(intent).map_err(|e|e.to_string())?,if intent.mirror.is_some(){"pending"}else{"resolved"},now_timestamp()]).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e|e.to_string())
    })
}

async fn mirror_craft(
    app: &AppHandle,
    state: &State<'_, AppState>,
    intent: &Intent,
) -> Result<(), String> {
    let Some(target) = &intent.mirror else {
        return Ok(());
    };
    let path = database_path(app)?;
    let root = path.parent().ok_or("资料库目录不可用")?;
    let op = library_runtime::begin(root, &target.library_id, "同步关联任务状态")?;
    let admission = library_runtime::admission(root, &target.library_id)?;
    let _guard = admission.lock().await;
    op.checkpoint()?;
    let binding: bool=open_database(&path)?.query_row("SELECT EXISTS(SELECT 1 FROM unified_task_bindings WHERE hub_task_id=?1 AND provider='craft' AND library_id=?2 AND source_id=?3 AND document_id=?4)",params![intent.task_id,target.library_id,target.source_id,target.document_id],|r|r.get(0)).map_err(|e|e.to_string())?;
    if !binding {
        return Err("关联任务身份已变化，已停止旧操作，请刷新核对".into());
    }
    let task = UnifiedTaskItem {
        provider: PROVIDER_CRAFT.into(),
        library_id: target.library_id.clone(),
        source_id: target.source_id.clone(),
        document_id: target.document_id.clone(),
        ..Default::default()
    };
    let client = task_sync_http_client()?;
    let session = ready_session(app, state, &target.library_id).await?;
    let blob = blob_store_for(app, state)?;
    let actual = |path: &PathBuf| -> Result<(bool, Option<i64>), String> {
        open_database(path)?.query_row("SELECT completed,modified_at FROM craft_task_blocks WHERE space_id=?1 AND document_id=?2 AND block_id=?3",params![target.library_id,target.document_id,target.source_id],|r|Ok((r.get::<_,i64>(0)?!=0,r.get::<_,Option<i64>>(1)?))).map_err(|_|"关联的 Craft 原生任务已不存在".into())
    };
    daily_task_status::refresh_source_document(
        &path, &blob, &client, &session, &task, 93_000_000, &op,
    )
    .await?;
    let desired = intent.status == "completed";
    let (completed, modified_at) = actual(&path)?;
    if completed == desired {
        return Ok(());
    }
    if target
        .modified_at
        .zip(modified_at)
        .is_some_and(|(old, fresh)| old != fresh)
    {
        return Err("Craft 关联任务已变化，已停止旧操作，请刷新核对".into());
    }
    op.checkpoint()?;
    let write = call_craft_tool_raw(
        &client,
        &session,
        "craft_write",
        json!({"command":daily_task_status::status_command(&target.source_id,desired)}),
        93_030_000,
    )
    .await;
    for attempt in 0..3 {
        daily_task_status::refresh_source_document(
            &path,
            &blob,
            &client,
            &session,
            &task,
            93_040_000 + attempt * 30_000,
            &op,
        )
        .await?;
        if actual(&path)?.0 == desired {
            return Ok(());
        }
    }
    Err(write
        .err()
        .unwrap_or_else(|| "Craft 状态尚未确认，滴答结果已保留，稍后重试关联同步".into()))
}

async fn execute(app: &AppHandle, state: &State<'_, AppState>, id: i64) -> Result<(), String> {
    let path = database_path(app)?;
    let (raw,attempts):(String,i64)=open_database(&path)?.query_row("SELECT payload_json,attempts FROM task_sync_events WHERE id=?1 AND action='direct_task_status' AND status='pending'",[id],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|e|e.to_string())?;
    let mut intent: Intent = serde_json::from_str(&raw).map_err(|_| "任务状态操作记录无效")?;
    let root = path.parent().ok_or("资料库目录不可用")?;
    let mut used_token = None;
    let mut primary_phase = true;
    let result = async {
        if account(&open_database(&path)?, &intent.library_id)? != intent.account {
            return Err("滴答连接账号已变化，已停止旧操作，请刷新核对".into());
        }
        let c = open_database(&path)?;
        let bound: Option<String> = c.query_row("SELECT hub_task_id FROM unified_task_bindings WHERE provider='dida365' AND library_id=?1 AND source_id=?2",params![intent.library_id,intent.source_id],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        if bound.is_some_and(|hub|hub!=intent.task_id) { return Err("滴答任务关联已变化，已停止旧操作，请刷新核对".into()); }
        drop(c);
        if !intent.remote_confirmed {
            let op = library_runtime::begin(root, &intent.library_id, "修改滴答任务状态")?;
            op.phase("queued", "等待当前滴答操作完成")?;
            let admission = library_runtime::admission(root, &intent.library_id)?;
            let _guard = admission.lock().await;
            op.checkpoint()?;
            let session = ready_session(app,state,&intent.library_id).await?;
            used_token = Some(session.access_token.clone());
            let client = task_sync_http_client()?;
            apply_remote(&path, id, &mut intent, &op, &client, &session).await?;
        }
        if intent.mirror.is_some() {
            // A completed primary phase is not permission to replay a stale
            // mirror after restart: the user may have reopened Dida meanwhile.
            let admission = library_runtime::admission(root, &intent.library_id)?;
            let _guard = admission.lock().await;
            let cached = local_task(&open_database(&path)?, &intent.library_id, &intent.source_id)?;
            let session = ready_session(app,state,&intent.library_id).await?;
            used_token = Some(session.access_token.clone());
            let op = library_runtime::begin(root, &intent.library_id, "核对关联任务状态")?;
            let fresh = read_remote(&task_sync_http_client()?, &session, &cached, 92_900_000+id as u64).await?;
            if dida_display_task_status(fresh.status) != intent.status || fresh.completed_time != intent.baseline_completion {
                dida_task_refresh::persist_changed(&path,&intent.library_id,vec![fresh],None,None,None,&op)?;
                if intent.automatic {
                    intent.remote_confirmed = false;
                    return save_intent(&path,id,&intent,"resolved",None);
                }
                return Err("滴答状态已变化，已停止旧关联操作，请刷新核对".into());
            }
        }
        primary_phase = false;
        mirror_craft(app, state, &intent).await?;
        save_intent(&path, id, &intent, "resolved", None)
    }
    .await;
    if let Err(error) = &result {
        if primary_phase {
            invalidate_authorization(state, &intent.library_id, used_token.as_deref(), error);
        }
        let permanent = error.contains("已变化")
            || error.contains("循环任务")
            || error.contains("已不存在")
            || error.contains("已关闭或移除")
            || attempts >= 7;
        let paused = library_runtime::is_control_error(error);
        intent.next_attempt_at = now_timestamp()
            + if paused || dida_rate_limit_error(error) {
                60
            } else {
                5_i64 * 2_i64.pow((attempts as u32).min(6))
            };
        let message = if intent.remote_confirmed {
            format!("滴答已确认，关联同步待处理：{error}")
        } else {
            error.clone()
        };
        save_intent(
            &path,
            id,
            &intent,
            if permanent && !paused {
                "failed"
            } else {
                "pending"
            },
            Some(&message),
        )?;
        let (c, _writer) = open_write_database(&path)?;
        if !paused {
            c.execute(
                "UPDATE task_sync_events SET attempts=attempts+1 WHERE id=?1",
                [id],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    let _ = app.emit("task-list-updated", json!({"taskId":intent.task_id}));
    result
}

pub(super) async fn set_status(
    app: AppHandle,
    task: UnifiedTaskItem,
    status: String,
    state: State<'_, AppState>,
) -> Result<UnifiedTaskItem, String> {
    let path = database_path(&app)?;
    let _guard = state.dida_status_guard.lock().await;
    let fresh = list_unified_tasks(app.clone())
        .await?
        .tasks
        .into_iter()
        .find(|current| current.id == task.id)
        .ok_or("任务已不存在，请刷新核对")?;
    if fresh.provider != task.provider
        || fresh.library_id != task.library_id
        || fresh.source_id != task.source_id
        || fresh.document_id != task.document_id
    {
        return Err("任务来源关联已变化，请刷新核对".into());
    }
    daily_task_status::validate_target(&fresh, &status, &fresh.status)?;
    let id = accept(&path, &fresh, &status)?;
    let _ = app.emit("task-list-updated", json!({"taskId":task.id}));
    let _ = execute(&app, &state, id).await;
    // Pending/failed is a durable visible outcome, never a false confirmation.
    list_unified_tasks(app)
        .await?
        .tasks
        .into_iter()
        .find(|t| t.id == task.id)
        .ok_or_else(|| "状态操作已保存，但任务视图已变化，请刷新".into())
}

pub(super) async fn drain(app: &AppHandle, state: &State<'_, AppState>) -> Result<usize, String> {
    let path = database_path(app)?;
    let ids = {
        let c = open_database(&path)?;
        let mut s=c.prepare("SELECT id FROM task_sync_events WHERE action='direct_task_status' AND status='pending' AND COALESCE(json_extract(payload_json,'$.nextAttemptAt'),0)<=?1 ORDER BY id LIMIT 8").map_err(|e|e.to_string())?;
        let rows = s
            .query_map([now_timestamp()], |r| r.get::<_, i64>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    let mut attempted = 0;
    for id in &ids {
        let Ok(_guard) = state.dida_status_guard.try_lock() else {
            break;
        };
        let _ = execute(app, state, *id).await;
        attempted += 1;
    }
    Ok(attempted)
}

#[cfg(test)]
mod tests;
