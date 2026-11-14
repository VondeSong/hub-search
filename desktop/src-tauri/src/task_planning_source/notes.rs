use super::*;

fn table(c: &Connection) -> Result<(), String> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS task_planning_actions(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,library_id TEXT NOT NULL,source_id TEXT NOT NULL,state TEXT NOT NULL,payload_json TEXT NOT NULL,error TEXT,updated_at INTEGER NOT NULL);")
        .map_err(|e|e.to_string())
}
fn read(c: &Connection, id: &str) -> Result<Value, String> {
    c.query_row(
        "SELECT payload_json,state,error,updated_at FROM task_planning_actions WHERE id=?1",
        [id],
        |r| {
            let raw: String = r.get(0)?;
            let mut v: Value =
                serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
            v["id"] = json!(id);
            v["state"] = json!(r.get::<_, String>(1)?);
            v["error"] = json!(r.get::<_, Option<String>>(2)?);
            v["updatedAt"] = json!(r.get::<_, i64>(3)?);
            Ok(v)
        },
    )
    .map_err(|_| "建议写入记录不存在或损坏，请重新准备".into())
}
fn public(v: &Value) -> Value {
    json!({"id":v["id"],"state":v["state"],"taskId":v["taskId"],"libraryName":v["libraryName"],
        "sourceId":v["sourceId"],"title":v["before"]["title"],"before":v["before"]["content"].as_str().unwrap_or_default(),
        "after":v["after"],"error":v["error"],"updatedAt":v["updatedAt"]})
}
fn mark(path: &PathBuf, id: &str, state: &str, error: Option<&str>) -> Result<Value, String> {
    let (c, _writer) = open_write_database(path)?;
    c.execute(
        "UPDATE task_planning_actions SET state=?2,error=?3,updated_at=?4 WHERE id=?1",
        params![id, state, error, now_timestamp()],
    )
    .map_err(|e| e.to_string())?;
    read(&c, id)
}
fn strarg<'a>(v: &'a Value, k: &str) -> Result<&'a str, String> {
    v[k].as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("缺少操作字段：{k}"))
}
fn append(before: &str, note: &str) -> Result<String, String> {
    if note.trim().is_empty() || note.len() > 12_000 || before.len() + note.len() > 200_000 {
        return Err("建议为空或超过来源正文长度限制".into());
    }
    Ok(format!(
        "{before}{}Hub 建议\n{}",
        if before.is_empty() { "" } else { "\n\n---\n" },
        note.trim()
    ))
}
fn arguments(source: &str, before: &Value, after: &str) -> Value {
    // The MCP partial-update contract preserves omitted fields; null can clear them.
    let mut task = json!({"id":source,"projectId":before["projectId"],"content":after});
    if let Some(etag) = before.get("etag") {
        task["etag"] = etag.clone();
    }
    json!({"task_id":source,"task":task})
}
fn source_revision(task: &DidaTask) -> Value {
    json!([
        task.id,
        task.project_id,
        task.title,
        task.content,
        task.description,
        task.kind,
        task.status,
        task.priority,
        task.start_date,
        task.due_date,
        task.tags,
        task.items,
        task.attachments,
        task.modified_time,
        task.raw["isAllDay"],
        task.raw["timeZone"],
        task.raw["parentId"],
        task.raw["reminders"],
        task.raw["repeatFlag"],
        task.raw["etag"]
    ])
}
fn source_snapshot(task: &DidaTask) -> Value {
    let mut raw = task.raw.clone();
    if !raw["projectId"].is_string() {
        raw["projectId"] = json!(task.project_id);
    }
    raw
}
fn validate_note_source(task: &DidaTask) -> Result<(), String> {
    if task.status != 0
        || !task.kind.eq_ignore_ascii_case("TEXT")
        || dida_task_status::blocked_reason(&task.raw).is_some()
    {
        return Err("仅支持未完成的普通文字任务；清单、循环或已完成任务请在滴答中修改".into());
    }
    if !task.raw["etag"]
        .as_str()
        .is_some_and(|v| !v.trim().is_empty())
    {
        return Err(
            "滴答未提供有效版本标识，无法保护并发修改；请保留 Hub 建议或在原应用修改".into(),
        );
    }
    Ok(())
}
fn target(path: &PathBuf, task: &UnifiedTaskItem) -> Result<(String, String, String), String> {
    let c = open_database(path)?;
    let refs = serde_json::to_value(&task.source_refs).map_err(|e| e.to_string())?;
    let r = refs
        .as_array()
        .and_then(|refs| refs.iter().find(|r| r["provider"] == PROVIDER_DIDA365))
        .ok_or("此任务没有已核实的滴答原任务，请在原应用修改")?;
    let library = strarg(r, "libraryId")?;
    let source = strarg(r, "sourceId")?;
    c.query_row("SELECT t.library_id,t.task_id,l.name FROM dida_tasks t JOIN libraries l ON l.id=t.library_id WHERE t.library_id=?1 AND t.task_id=?2 AND l.enabled=1 AND l.provider='dida365'",params![library,source],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))
        .map_err(|_|"滴答来源已关闭、移除或失去关联".into())
}
async fn prepare(
    app: &AppHandle,
    state: &State<'_, AppState>,
    args: &Value,
) -> Result<Value, String> {
    let task_id = strarg(args, "taskId")?.to_owned();
    let task = selected(app, &[task_id.clone()]).await?.remove(0);
    if task.content_revision != strarg(args, "contentRevision")? {
        return Err("分析后原任务已变化，请重新分析".into());
    }
    let note = strarg(args, "text")?;
    let work = strarg(args, "workId")?;
    let path = database_path(app)?;
    let (library, source, name) = target(&path, &task)?;
    let id = format!(
        "{:x}",
        Sha256::digest(
            json!([work, task_id, library, source, note])
                .to_string()
                .as_bytes()
        )
    );
    {
        let (c, _writer) = open_write_database(&path)?;
        table(&c)?;
        if let Ok(v) = read(&c, &id) {
            return Ok(public(&v));
        }
        let unresolved:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM task_planning_actions WHERE library_id=?1 AND source_id=?2 AND state IN ('writing','unknown'))",params![library,source],|r|r.get(0)).map_err(|e|e.to_string())?;
        if unresolved {
            return Err("此原任务还有结果未知的写入，请先核对原操作，未重复提交".into());
        }
    }
    let root = path.parent().ok_or("资料库目录不可用")?;
    let admission = library_runtime::admission(root, &library)?;
    let _guard = admission
        .try_lock()
        .map_err(|_| "滴答正在同步，请稍后准备写入")?;
    let op = library_runtime::begin(root, &library, "预览任务建议写入")?;
    let session = dida_task_status::ready_session(app, state, &library).await?;
    let client = task_sync_http_client_with_timeout(Duration::from_secs(12))?;
    let cached: String = open_database(&path)?
        .query_row(
            "SELECT raw_json FROM dida_tasks WHERE library_id=?1 AND task_id=?2",
            params![library, source],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let cached = parse_dida(
        &serde_json::from_str(&cached).map_err(|_| "原任务快照损坏")?,
        "inbox",
        &source,
    )?;
    let before = read_dida(&client, &session, &source, "inbox").await?;
    if source_revision(&cached) != source_revision(&before) {
        return Err("分析后滴答原任务已变化；请先核对来源并重新分析，未准备覆盖旧记录".into());
    }
    validate_note_source(&before)?;
    let after = append(&before.content, note)?;
    let raw = source_snapshot(&before);
    let value = json!({"id":id,"taskId":task_id,"libraryId":library,"libraryName":name,"sourceId":source,"before":raw,"after":after,"workId":work});
    op.checkpoint()?;
    let (c, _writer) = open_write_database(&path)?;
    c.execute("INSERT OR IGNORE INTO task_planning_actions(id,task_id,library_id,source_id,state,payload_json,updated_at) VALUES(?1,?2,?3,?4,'prepared',?5,?6)",params![id,task_id,library,source,value.to_string(),now_timestamp()]).map_err(|e|e.to_string())?;
    Ok(public(&read(&c, &id)?))
}
fn claim(c: &Connection, id: &str) -> Result<bool, String> {
    c.execute("UPDATE task_planning_actions SET state='writing',error=NULL,updated_at=?2 WHERE id=?1 AND state IN ('prepared','retryable') AND NOT EXISTS(SELECT 1 FROM task_planning_actions other WHERE other.id<>?1 AND other.library_id=task_planning_actions.library_id AND other.source_id=task_planning_actions.source_id AND other.state IN ('writing','unknown'))",params![id,now_timestamp()]).map(|n|n==1).map_err(|e|e.to_string())
}
fn reconciliation(action: &Value, remote: &DidaTask) -> &'static str {
    let preserved = [
        "projectId",
        "title",
        "desc",
        "description",
        "kind",
        "status",
        "priority",
        "tags",
        "items",
        "parentId",
        "startDate",
        "dueDate",
        "isAllDay",
        "timeZone",
        "repeatFlag",
        "reminders",
        "columnId",
        "progress",
        "isFloating",
        "repeatFrom",
        "sortOrder",
    ]
    .iter()
    .all(|field| {
        action["before"].get(*field).is_none_or(|before| {
            let actual = remote.raw.get(*field).unwrap_or(&Value::Null);
            let empty = |v: &Value| v.is_null() || v.as_array().is_some_and(Vec::is_empty);
            remote.raw.get(*field) == Some(before)
                || (["tags", "items", "reminders"].contains(field)
                    && empty(before)
                    && empty(actual))
        })
    });
    if remote.content == action["after"].as_str().unwrap_or_default() && preserved {
        "confirmed"
    } else if source_snapshot(remote) == action["before"] {
        "retryable"
    } else {
        "unknown"
    }
}
async fn submit(
    app: &AppHandle,
    state: &State<'_, AppState>,
    args: &Value,
    inspect: bool,
) -> Result<Value, String> {
    let id = strarg(args, "id")?;
    let path = database_path(app)?;
    let v = {
        let (c, _writer) = open_write_database(&path)?;
        table(&c)?;
        read(&c, id)?
    };
    if inspect && v["state"] == "prepared" {
        return Ok(public(&v));
    }
    if v["state"] == "confirmed" && v["error"].is_null() {
        return Ok(public(&v));
    }
    let task = list_unified_tasks(app.clone())
        .await?
        .tasks
        .into_iter()
        .find(|t| Some(t.id.as_str()) == v["taskId"].as_str())
        .ok_or("原任务不再可用，请在滴答核对原操作")?;
    let (library, source, _) = target(&path, &task)?;
    if v["libraryId"] != library || v["sourceId"] != source {
        return Err("原任务关联已变化，未执行来源写入".into());
    }
    let root = path.parent().ok_or("资料库目录不可用")?;
    let admission = library_runtime::admission(root, &library)?;
    let _guard = admission
        .try_lock()
        .map_err(|_| "滴答正在同步，请稍后核对")?;
    let op = library_runtime::begin(root, &library, "确认任务建议写入")?;
    let session = dida_task_status::ready_session(app, state, &library).await?;
    let client = task_sync_http_client_with_timeout(Duration::from_secs(12))?;
    let remote = read_dida(
        &client,
        &session,
        &source,
        strarg(&v["before"], "projectId")?,
    )
    .await?;
    let mut write_error = None;
    if !inspect && (v["state"] == "prepared" || v["state"] == "retryable") {
        let baseline = source_snapshot(&remote);
        if reconciliation(&v, &remote) == "confirmed" {
            let error = dida_task_refresh::persist_changed(
                &path,
                &library,
                vec![remote.clone()],
                None,
                None,
                None,
                &op,
            )
            .err()
            .map(|e| format!("来源已确认，本地刷新待重试：{e}"));
            let result = mark(&path, id, "confirmed", error.as_deref())?;
            let _ = app.emit("task-list-updated", json!({"taskId":task.id}));
            return Ok(public(&result));
        }
        if baseline != v["before"] {
            return Ok(public(&mark(
                &path,
                id,
                "conflict",
                Some("原任务在预览后已变化；未覆盖来源，请重新读取并分析"),
            )?));
        }
        validate_note_source(&remote)?;
        op.checkpoint()?;
        let claimed = {
            let (c, _writer) = open_write_database(&path)?;
            claim(&c, id)?
        };
        if !claimed {
            return Err("此任务已有提交或结果未知的操作，未重复写入；请核对来源操作记录".into());
        }
        write_error = call_dida_write_tool_raw_once(
            &client,
            &session,
            "update_task",
            arguments(&source, &baseline, strarg(&v, "after")?),
            95_100_001,
        )
        .await
        .err();
    } else if !inspect && v["state"] != "confirmed" {
        return Ok(public(&v));
    }
    let confirmed = read_dida(
        &client,
        &session,
        &source,
        strarg(&v["before"], "projectId")?,
    )
    .await;
    let (phase, error) = match confirmed {
        Ok(task) if reconciliation(&v, &task) == "confirmed" => {
            let cache = dida_task_refresh::persist_changed(
                &path,
                &library,
                vec![task],
                None,
                None,
                None,
                &op,
            );
            (
                "confirmed",
                cache
                    .err()
                    .map(|e| format!("来源已回读确认，本地刷新尚未完成：{e}")),
            )
        }
        Ok(task) if inspect && reconciliation(&v, &task) == "retryable" => (
            "retryable",
            Some(
                "来源仍为预览前原文；可以再次确认同一变更。目标正文固定，重试不会重复追加。".into(),
            ),
        ),
        Ok(_) => (
            "unknown",
            Some(write_error.unwrap_or_else(|| {
                "来源尚未返回预览中的正文；结果未知，仅核对，不重复写入".into()
            })),
        ),
        Err(e) => (
            "unknown",
            Some(format!(
                "写入结果未知，回读失败：{e}；请核对原操作，未自动重发"
            )),
        ),
    };
    let result = mark(&path, id, phase, error.as_deref())?;
    let _ = app.emit(
        "task-list-updated",
        json!({"taskId":task.id,"reason":"planning-source-note"}),
    );
    Ok(public(&result))
}
pub(super) async fn dispatch(
    app: &AppHandle,
    state: &State<'_, AppState>,
    args: &Value,
) -> Result<Value, String> {
    match args["action"].as_str().unwrap_or_default() {
        "listNotes" => {
            let ids: Vec<String> =
                serde_json::from_value(args["taskIds"].clone()).map_err(|_| "任务范围无效")?;
            if ids.is_empty() || ids.len() > 32 {
                return Err("来源记录查询需要 1–32 条原任务".into());
            }
            let current = list_unified_tasks(app.clone()).await?.tasks;
            if ids.iter().any(|id| !current.iter().any(|t| &t.id == id)) {
                return Err("原任务已不在可见范围".into());
            }
            let path = database_path(app)?;
            let (c, _writer) = open_write_database(&path)?;
            table(&c)?;
            let mut q=c.prepare("SELECT id FROM task_planning_actions WHERE task_id IN (SELECT value FROM json_each(?1)) ORDER BY updated_at DESC LIMIT 32").map_err(|e|e.to_string())?;
            let ids = q
                .query_map([json!(ids).to_string()], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            Ok(json!(ids
                .iter()
                .map(|id| read(&c, id).map(|v| public(&v)))
                .collect::<Result<Vec<_>, _>>()?))
        }
        "prepareNote" => prepare(app, state, args).await,
        "submitNote" => submit(app, state, args, false).await,
        "inspectNote" => submit(app, state, args, true).await,
        _ => Err("未知建议写入操作".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn note_writes_require_an_editable_task_and_a_source_version() {
        let mut raw = json!({"id":"versioned","projectId":"inbox","title":"Action","content":"Preserve","kind":"TEXT","status":0});
        for etag in [Value::Null, json!(""), json!(" ")] {
            raw["etag"] = etag;
            assert!(
                validate_note_source(&parse_dida(&raw, "inbox", "versioned").unwrap()).is_err()
            );
        }
        raw["etag"] = json!("source-version");
        assert!(validate_note_source(&parse_dida(&raw, "inbox", "versioned").unwrap()).is_ok());
        for (field, value) in [("kind", json!("CHECKLIST")), ("status", json!(2))] {
            let mut changed = raw.clone();
            changed[field] = value;
            assert!(
                validate_note_source(&parse_dida(&changed, "inbox", "versioned").unwrap()).is_err()
            );
        }
    }
    #[tokio::test]
    #[ignore = "requires an explicitly owned temporary task and saved native authorization"]
    async fn live_owned_planning_note_roundtrip() {
        let source = std::env::var("HUB_OWNED_PLANNING_TASK_ID").expect("owned task required");
        let library =
            std::env::var("HUB_OWNED_PLANNING_LIBRARY_ID").expect("native library required");
        assert!(source.len() == 24 && source.bytes().all(|b| b.is_ascii_hexdigit()));
        let client = task_sync_http_client().unwrap();
        let mut credential = load_credential(&library).expect("native authorization required");
        assert_eq!(
            Url::parse(&credential.mcp_url).unwrap().host_str(),
            Some("mcp.dida365.com")
        );
        let token = restore_credential_access_token(&client, &library, &mut credential)
            .await
            .unwrap();
        save_credential(&library, &credential).unwrap();
        let transport = initialize_mcp_transport(
            &client,
            &credential.mcp_url,
            token,
            DIDA_MCP_PROTOCOL_VERSION,
        )
        .await
        .unwrap();
        let session = transport.session;
        let original = read_dida(&client, &session, &source, "inbox")
            .await
            .unwrap();
        assert!(original.title.starts_with("Hub 任务流程验收 "));
        assert_eq!(original.content,"Owned Hub task-planning acceptance fixture. Preserve this original text, priority, dates and status.");
        assert_eq!(original.status, 0);
        assert_eq!(original.priority, 5);
        let after = append(
            &original.content,
            "Verify the original task text, priority, dates and status before completion.",
        )
        .unwrap();
        call_dida_write_tool_raw_once(
            &client,
            &session,
            "update_task",
            arguments(&source, &original.raw, &after),
            95_200_001,
        )
        .await
        .unwrap();
        let written = read_dida(&client, &session, &source, &original.project_id)
            .await
            .unwrap();
        let confirmed =
            reconciliation(&json!({"before":original.raw,"after":after}), &written) == "confirmed";
        // Restore only this owned fixture and only after recognizing our exact append.
        assert_eq!(written.content, after);
        call_dida_write_tool_raw_once(
            &client,
            &session,
            "update_task",
            arguments(&source, &written.raw, &original.content),
            95_200_002,
        )
        .await
        .unwrap();
        let restored = read_dida(&client, &session, &source, &original.project_id)
            .await
            .unwrap();
        assert_eq!(
            reconciliation(
                &json!({"before":original.raw,"after":original.content}),
                &restored
            ),
            "confirmed"
        );
        assert!(
            confirmed,
            "non-content source fields changed; fixture body has been restored"
        );
        if let Ok(output) = std::env::var("HUB_OWNED_PLANNING_RECEIPT") {
            fs::write(output,json!({"nativeWriteConfirmed":true,"originalBodyRestored":true,"priorityDatesStatusPreserved":true,"taskId":source}).to_string()).unwrap();
        }
    }
    #[test]
    fn note_preview_preserves_original_bytes_and_write_is_content_only() {
        let before = "Original text\n  ";
        let after = append(before, "Next step").unwrap();
        assert!(after.starts_with(before));
        let args = arguments(
            "task",
            &json!({"projectId":"inbox-account","etag":"v2","title":"Preserve","dueDate":"2026-11-14","status":0}),
            &after,
        );
        assert_eq!(args["task"]["projectId"], "inbox-account");
        assert_eq!(args["task"]["etag"], "v2");
        assert!(args["task"].get("title").is_none());
        assert!(args["task"].get("dueDate").is_none());
        assert!(args["task"].get("status").is_none());
    }
    #[test]
    fn repeated_and_concurrent_confirmation_never_claims_a_second_write() {
        let c = Connection::open_in_memory().unwrap();
        table(&c).unwrap();
        for id in ["one", "two"] {
            c.execute("INSERT INTO task_planning_actions VALUES(?1,'task','library','source','prepared','{}',NULL,1)",[id]).unwrap();
        }
        assert!(claim(&c, "one").unwrap());
        assert!(!claim(&c, "one").unwrap());
        assert!(!claim(&c, "two").unwrap());
        c.execute(
            "UPDATE task_planning_actions SET state='unknown' WHERE id='one'",
            [],
        )
        .unwrap();
        assert!(!claim(&c, "two").unwrap());
        let task = parse_dida(
            &json!({"id":"source","title":"Task","content":"kept","status":0}),
            "inbox",
            "source",
        )
        .unwrap();
        assert_eq!(
            reconciliation(&json!({"after":"different"}), &task),
            "unknown"
        );
        assert_eq!(reconciliation(&json!({"after":"kept"}), &task), "confirmed");
        assert_eq!(
            reconciliation(
                &json!({"before":source_snapshot(&task),"after":"new"}),
                &task
            ),
            "retryable"
        );
    }
}
