//! Direct user-requested status changes, routed to the native source writer.
use super::*;

pub(super) fn validate_target(
    task: &UnifiedTaskItem,
    status: &str,
    expected_status: &str,
) -> Result<(), String> {
    if !matches!(status, "open" | "completed") || !matches!(expected_status, "open" | "completed") {
        return Err("任务状态无效".into());
    }
    if !matches!(task.provider.as_str(), PROVIDER_CRAFT | PROVIDER_DIDA365)
        || task.is_project
        || task.source_id.is_empty()
        || task.source_id.contains(":line:")
        || (task.provider == PROVIDER_CRAFT
            && (!valid_craft_block_id(&task.source_id) || !valid_craft_block_id(&task.document_id)))
    {
        return Err("请在原应用中修改这类任务的完成状态".into());
    }
    if task.sync_state == "conflict" {
        return Err("此任务存在同步冲突，请先在任务界面处理".into());
    }
    if task.status != expected_status {
        return Err("任务状态已变化，请刷新后重试".into());
    }
    Ok(())
}

pub(super) fn status_command(source_id: &str, completed: bool) -> String {
    // Same status-only tasks update syntax already used by the controlled
    // Craft sync writer; titles, dates, parentage and details are untouched.
    format!(
        "tasks update --task {} --state {}",
        craft_cli_quote(source_id),
        if completed { "done" } else { "todo" }
    )
}

fn validate_identity(
    task: &UnifiedTaskItem,
    library_id: &str,
    document_id: &str,
    source_id: &str,
) -> Result<(), String> {
    if task.library_id != library_id
        || task.document_id != document_id
        || task.source_id != source_id
    {
        return Err("任务的来源关联已变化，请刷新后重试".into());
    }
    Ok(())
}

fn validate_same_source(
    expected: &UnifiedTaskItem,
    current: &UnifiedTaskItem,
) -> Result<(), String> {
    if expected.id != current.id || expected.provider != current.provider {
        return Err("任务的来源关联已变化，请刷新后重试".into());
    }
    validate_identity(
        current,
        &expected.library_id,
        &expected.document_id,
        &expected.source_id,
    )
}

async fn current_task(app: &AppHandle, task_id: &str) -> Result<UnifiedTaskItem, String> {
    list_unified_tasks(app.clone())
        .await?
        .tasks
        .into_iter()
        .find(|task| task.id == task_id)
        .ok_or_else(|| "任务已不存在，请刷新后重试".into())
}

fn native_task_state(hints: &[StructuredBlockHint], source_id: &str) -> Result<bool, String> {
    let states = hints
        .iter()
        .filter(|hint| hint.id == source_id)
        .filter_map(|hint| hint.task_completed)
        .collect::<Vec<_>>();
    let Some(&state) = states.first() else {
        return Err("无法确认源任务的完成状态，请在原应用确认".into());
    };
    if states.iter().any(|candidate| *candidate != state) {
        return Err("源任务状态在读取期间发生变化，请刷新后重试".into());
    }
    Ok(state)
}

pub(super) async fn refresh_source_document(
    path: &PathBuf,
    blob_store: &BlobStore,
    client: &reqwest::Client,
    session: &McpSession,
    task: &UnifiedTaskItem,
    request_base: u64,
    operation: &library_runtime::Operation,
) -> Result<(), String> {
    operation.checkpoint()?;
    let metadata = {
        let connection = open_database(path)?;
        connection.query_row(
            "SELECT title,path,folder_id,modified_at FROM documents WHERE provider='craft' AND space_id=?1 AND id=?2",
            params![task.library_id, task.document_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, Option<i64>>(3)?)),
        ).map_err(|_| "任务的源文档已不存在".to_string())?
    };
    let structured_pages = read_craft_block_pages(
        client,
        session,
        &format!(
            "blocks get --id {} --depth -1 --format json --fetchMetadata",
            craft_cli_quote(&task.document_id)
        ),
        request_base,
    )
    .await?;
    let candidates = HashSet::from([task.source_id.to_ascii_lowercase()]);
    if !matched_craft_document_task_ids(&structured_pages, &task.document_id, &candidates)?
        .contains(&task.source_id.to_ascii_lowercase())
    {
        return Err("任务已从源文档移除，请在原应用确认".into());
    }
    let mut hints = Vec::new();
    let mut attachments = Vec::new();
    let mut seen_urls = HashSet::new();
    for page in &structured_pages {
        let parsed = parse_tool_json(page).ok_or("任务源文档没有返回有效的区块数据")?;
        hints.extend(structured_block_hints(&parsed));
        for attachment in discover_attachments_from_json(&parsed) {
            if seen_urls.insert(attachment.url.clone()) {
                attachments.push(attachment);
            }
        }
    }
    native_task_state(&hints, &task.source_id)?;
    let markdown_pages = read_craft_block_pages(
        client,
        session,
        &format!(
            "blocks get --id {} --depth -1 --format markdown",
            craft_cli_quote(&task.document_id)
        ),
        request_base + 10_000,
    )
    .await?;
    let markdown = markdown_pages
        .iter()
        .map(tool_result_text)
        .map(|text| without_next_page_instruction(&text))
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    if attachments.is_empty() {
        attachments = discover_attachments(&markdown);
    }
    let content_hash = format!("{:x}", Sha256::digest(markdown.as_bytes()));
    let document = IndexedDocument {
        space_id: task.library_id.clone(),
        id: task.document_id.clone(),
        title: metadata.0,
        path: metadata.1,
        folder_id: metadata.2,
        modified_at: metadata.3,
        indexed_at: now_timestamp(),
        content_hash,
        markdown,
        attachments,
        block_hints: hints,
    };
    operation.checkpoint()?;
    persist_document_batch_controlled(path, blob_store, vec![document], Some(operation))
}

#[tauri::command]
pub(super) async fn set_unified_task_status(
    app: AppHandle,
    task_id: String,
    status: String,
    expected_status: String,
    expected_library_id: String,
    expected_document_id: String,
    expected_source_id: String,
    state: State<'_, AppState>,
) -> Result<UnifiedTaskItem, String> {
    let initial = current_task(&app, &task_id).await?;
    // Reject unsupported or stale requests before acquiring any remote writer.
    validate_target(&initial, &status, &expected_status)?;
    validate_identity(
        &initial,
        &expected_library_id,
        &expected_document_id,
        &expected_source_id,
    )?;
    let path = database_path(&app)?;
    if dida_task_status::accepts(&path, &initial)? {
        return dida_task_status::set_status(app, initial, status, state).await;
    }
    let root = path.parent().ok_or("资料库目录不可用")?;
    let operation = Arc::new(library_runtime::begin(
        root,
        &initial.library_id,
        "修改任务完成状态",
    )?);
    let result = async {
        let admission = library_runtime::admission(root, &initial.library_id)?;
        operation.phase("queued", "等待资料库的当前操作完成")?;
        let waiting = admission.lock();
        tokio::pin!(waiting);
        let _guard = loop {
            operation.checkpoint()?;
            tokio::select! {
                guard = &mut waiting => break guard,
                _ = tokio::time::sleep(Duration::from_millis(250)) => {},
            }
        };
        let task = current_task(&app, &task_id).await?;
        validate_same_source(&initial, &task)?;
        validate_target(&task, &status, &expected_status)?;
        let session = session_for_space(&state, &task.library_id)?;
        let client = task_sync_http_client()?;
        let tools = craft_tool_names(&client, &session, 91_000_000).await?;
        if !tools.contains("craft_write") {
            return Err("此 Craft 连接没有写入权限，请在原应用修改任务状态".into());
        }
        let blob_store = blob_store_for(&app, &state)?;
        operation.phase("reading", "正在确认源任务的当前状态")?;
        refresh_source_document(
            &path,
            &blob_store,
            &client,
            &session,
            &task,
            91_010_000,
            &operation,
        )
        .await?;
        let fresh = current_task(&app, &task_id).await?;
        validate_same_source(&initial, &fresh)?;
        validate_target(&fresh, &status, &expected_status)?;
        if fresh.status == status {
            return Ok(fresh);
        }
        operation.checkpoint()?;
        operation.phase("writing", "正在修改源任务的完成状态")?;
        let write = call_craft_tool_raw(
            &client,
            &session,
            "craft_write",
            json!({"command": status_command(&fresh.source_id, status == "completed")}),
            91_030_000,
        )
        .await;
        operation.phase("reading", "正在回读源任务的完成状态")?;
        for attempt in 0..3_u64 {
            refresh_source_document(
                &path,
                &blob_store,
                &client,
                &session,
                &fresh,
                91_040_000 + attempt * 30_000,
                &operation,
            )
            .await?;
            let confirmed = current_task(&app, &task_id).await?;
            validate_same_source(&initial, &confirmed)?;
            if confirmed.status == status {
                validate_target(&confirmed, &status, &status)?;
                let (connection, _writer) = open_write_database(&path)?;
                task_dates::record_confirmed_transition(
                    &connection,
                    &fresh,
                    &confirmed,
                    &chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                )?;
                drop(_writer);
                drop(connection);
                let updated = current_task(&app, &task_id).await?;
                validate_same_source(&initial, &updated)?;
                validate_target(&updated, &status, &status)?;
                return Ok(updated);
            }
            if attempt < 2 {
                tokio::time::sleep(Duration::from_millis(150)).await;
            }
        }
        Err(write
            .err()
            .unwrap_or_else(|| "源任务状态尚未确认，请刷新或在原应用确认".into()))
    }
    .await;
    if let Err(error) = &result {
        operation.failed(error);
    }
    drop(operation);
    if let Ok(snapshot) = library_runtime::status(root, &initial.library_id) {
        let _ = app.emit("library-runtime-updated", snapshot);
    }
    let _ = app.emit(
        "library-registry-updated",
        json!({"libraryId": initial.library_id}),
    );
    if let Ok(task) = &result {
        let _ = app.emit(
            "task-list-updated",
            json!({"taskId": task.id, "libraryId": task.library_id}),
        );
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn task() -> UnifiedTaskItem {
        UnifiedTaskItem {
            collection_id: String::new(),
            id: "fixture-task".into(),
            provider: PROVIDER_CRAFT.into(),
            library_id: "fixture".into(),
            library_name: "Fixture".into(),
            source_id: "task-1".into(),
            parent_task_id: String::new(),
            parent_page_id: "page-1".into(),
            document_id: "doc-1".into(),
            document_title: "Journal".into(),
            title: "Title preserved".into(),
            completed: false,
            status: "open".into(),
            is_all_day: true,
            start_at: None,
            due_at: None,
            modified_at: None,
            path: String::new(),
            depth: 0,
            is_project: false,
            linked_providers: vec![PROVIDER_CRAFT.into()],
            sync_state: "unlinked".into(),
            ..UnifiedTaskItem::default()
        }
    }
    #[test]
    fn daily_task_status_rejects_stale_state_and_unsupported_targets_before_write() {
        let original = task();
        assert!(validate_target(&original, "completed", "open").is_ok());
        assert!(validate_target(&original, "open", "completed").is_err());
        for provider in [PROVIDER_OBSIDIAN, PROVIDER_FEISHU] {
            let mut other = original.clone();
            other.provider = provider.into();
            assert!(validate_target(&other, "completed", "open").is_err());
        }
        let mut project = original.clone();
        project.is_project = true;
        assert!(validate_target(&project, "completed", "open").is_err());
        let mut synthetic = original.clone();
        synthetic.source_id = "doc-1:line:3".into();
        assert!(validate_target(&synthetic, "completed", "open").is_err());
        let mut conflict = original.clone();
        conflict.sync_state = "conflict".into();
        assert!(validate_target(&conflict, "completed", "open").is_err());
        assert!(validate_target(&original, "cancelled", "open").is_err());
    }
    #[test]
    fn daily_task_status_payload_changes_only_completion() {
        assert_eq!(
            status_command("task-1", true),
            "tasks update --task \"task-1\" --state done"
        );
        assert_eq!(
            status_command("task-1", false),
            "tasks update --task \"task-1\" --state todo"
        );
        assert!(craft_tool_call_is_retry_safe(
            "craft_write",
            &json!({"command": status_command("task-1", true)})
        ));
    }

    #[test]
    fn daily_task_status_rejects_changed_source_identity() {
        let original = task();
        assert!(validate_identity(&original, "fixture", "doc-1", "task-1").is_ok());
        assert!(validate_identity(&original, "other-library", "doc-1", "task-1").is_err());
        assert!(validate_identity(&original, "fixture", "other-document", "task-1").is_err());
        assert!(validate_identity(&original, "fixture", "doc-1", "other-source").is_err());
        assert!(validate_same_source(&original, &original).is_ok());
        for field in ["provider", "library", "document", "source", "hub-id"] {
            let mut rebound = original.clone();
            match field {
                "provider" => rebound.provider = PROVIDER_DIDA365.into(),
                "library" => rebound.library_id = "other-library".into(),
                "document" => rebound.document_id = "other-document".into(),
                "source" => rebound.source_id = "other-source".into(),
                _ => rebound.id = "other-hub-id".into(),
            }
            assert!(
                validate_same_source(&original, &rebound).is_err(),
                "field={field}"
            );
        }
    }

    #[test]
    fn daily_task_status_readback_requires_real_native_state() {
        let hints = structured_block_hints(&json!({"id":"doc-1","type":"page","content":[
            {"id":"task-open","type":"text","markdown":"Keep title","listStyle":"task","taskInfo":{"state":"todo"}},
            {"id":"task-done","type":"text","markdown":"Keep detail","listStyle":{"type":"todo","state":"checked"}},
            {"id":"plain","type":"text","markdown":"ordinary paragraph"}
        ]}));
        assert_eq!(native_task_state(&hints, "task-open").unwrap(), false);
        assert_eq!(native_task_state(&hints, "task-done").unwrap(), true);
        assert!(native_task_state(&hints, "plain").is_err());
        assert!(native_task_state(&hints, "missing").is_err());
        let mut changed = hints.clone();
        let mut duplicate = changed
            .iter()
            .find(|hint| hint.id == "task-open")
            .unwrap()
            .clone();
        duplicate.task_completed = Some(true);
        changed.push(duplicate);
        assert!(native_task_state(&changed, "task-open").is_err());
    }
}
