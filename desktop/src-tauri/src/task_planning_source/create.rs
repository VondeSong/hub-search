use super::*;

fn ensure_table(c: &Connection) -> Result<(), String> {
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS task_planning_actions(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,library_id TEXT NOT NULL,source_id TEXT NOT NULL,state TEXT NOT NULL,payload_json TEXT NOT NULL,error TEXT,updated_at INTEGER NOT NULL);",
    )
    .map_err(|e| e.to_string())
}

fn read_receipt(c: &Connection, id: &str) -> Result<Value, String> {
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
    .map_err(|_| "新建任务回执不存在或已损坏".into())
}

fn strarg<'a>(v: &'a Value, k: &str) -> Result<&'a str, String> {
    v[k].as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("缺少操作字段：{k}"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CreateTarget {
    library_id: String,
    library_name: String,
    project_id: String,
    project_name: String,
}

fn resolve_target(
    c: &Connection,
    requested_library_id: Option<&str>,
    requested_project_id: Option<&str>,
) -> Result<CreateTarget, String> {
    let (library_id, library_name) = if let Some(lib_id) = requested_library_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        c.query_row(
            "SELECT id, name FROM libraries WHERE id=?1 AND provider='dida365' AND enabled=1",
            [lib_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "所选来源不是已启用的滴答清单资料库，未自动改投".to_string())?
    } else {
        let mut stmt = c
            .prepare("SELECT id, name FROM libraries WHERE provider='dida365' AND enabled=1 ORDER BY added_at, id")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        match rows.len() {
            0 => return Err("尚未启用可写入的滴答清单资料库".into()),
            1 => rows.into_iter().next().unwrap(),
            _ => return Err("存在多个已启用的滴答清单资料库，请明确选择写入目标".into()),
        }
    };

    let (project_id, project_name) = if let Some(proj_id) = requested_project_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let raw_name: String = c
            .query_row(
                "SELECT name FROM dida_projects WHERE library_id=?1 AND project_id=?2 AND closed=0",
                params![library_id, proj_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "目标滴答清单项目不可用，请刷新滴答资料库或改用收件箱".to_string())?;
        (proj_id.to_string(), dida_project_display_name(&raw_name))
    } else {
        let inbox_id = task_sync_inbox_project_id(c, &library_id)?;
        (inbox_id, "收件箱".to_string())
    };

    Ok(CreateTarget {
        library_id,
        library_name,
        project_id,
        project_name,
    })
}

fn validate_priority(args: &Value) -> Result<i64, String> {
    let priority = args.get("priority").and_then(Value::as_i64).unwrap_or(0);
    if !matches!(priority, 0 | 1 | 3 | 5) {
        return Err("滴答优先级无效，仅支持 0/1/3/5".into());
    }
    Ok(priority)
}

fn build_create_payload(target: &CreateTarget, title: &str, priority: i64) -> Value {
    json!({
        "projectId": target.project_id,
        "title": title,
        "content": "",
        "kind": "TEXT",
        "status": 0,
        "priority": priority,
    })
}

enum ClaimOutcome {
    Claimed,
    Existing(Value),
}

fn claim_create_action(
    c: &Connection,
    action_id: &str,
    target: &CreateTarget,
    title: &str,
    priority: i64,
) -> Result<ClaimOutcome, String> {
    ensure_table(c)?;
    if let Ok(existing) = read_receipt(c, action_id) {
        return Ok(ClaimOutcome::Existing(existing));
    }
    let payload = json!({
        "kind": "createTask",
        "id": action_id,
        "libraryId": target.library_id,
        "libraryName": target.library_name,
        "projectId": target.project_id,
        "projectName": target.project_name,
        "title": title,
        "priority": priority,
        "taskId": "",
        "sourceId": "",
    });
    let inserted = c
        .execute(
            "INSERT OR IGNORE INTO task_planning_actions(id,task_id,library_id,source_id,state,payload_json,updated_at) VALUES(?1,'',?2,'','writing',?3,?4)",
            params![action_id, target.library_id, payload.to_string(), now_timestamp()],
        )
        .map_err(|e| e.to_string())?;
    if inserted == 0 {
        return Ok(ClaimOutcome::Existing(read_receipt(c, action_id)?));
    }
    Ok(ClaimOutcome::Claimed)
}

fn finalize_receipt(
    path: &PathBuf,
    action_id: &str,
    state: &str,
    task_id: &str,
    source_id: &str,
    payload: &Value,
    error: Option<&str>,
) -> Result<Value, String> {
    let (c, _writer) = open_write_database(path)?;
    ensure_table(&c)?;
    c.execute(
        "UPDATE task_planning_actions SET task_id=?2,source_id=?3,state=?4,payload_json=?5,error=?6,updated_at=?7 WHERE id=?1",
        params![
            action_id,
            task_id,
            source_id,
            state,
            payload.to_string(),
            error,
            now_timestamp()
        ],
    )
    .map_err(|e| e.to_string())?;
    read_receipt(&c, action_id)
}

pub(super) async fn dispatch(
    app: &AppHandle,
    state: &State<'_, AppState>,
    args: &Value,
) -> Result<Value, String> {
    let request_id = strarg(args, "requestId")?;
    if request_id.len() > 128 {
        return Err("请求标识过长".into());
    }
    let title = strarg(args, "title")?;
    if title.chars().count() > 500 {
        return Err("任务标题超过 500 字符限制".into());
    }
    let priority = validate_priority(args)?;
    let action_id = format!("create:{request_id}");
    let path = database_path(app)?;

    let target = {
        let c = open_database(&path)?;
        resolve_target(&c, args["libraryId"].as_str(), args["projectId"].as_str())?
    };

    // Idempotency / duplicate-submit check before acquiring remote session.
    let known = {
        let (c, _writer) = open_write_database(&path)?;
        match claim_create_action(&c, &action_id, &target, title, priority)? {
            ClaimOutcome::Claimed => None,
            ClaimOutcome::Existing(existing) => {
                if existing["libraryId"] != target.library_id
                    || existing["projectId"] != target.project_id
                    || existing["title"] != title
                    || existing["priority"] != priority
                {
                    return Err("原请求已绑定其他任务参数".into());
                }
                if existing["state"] == "unknown"
                    && existing["sourceId"].as_str().is_some_and(|v| !v.is_empty())
                {
                    Some(existing)
                } else {
                    return Ok(existing);
                }
            }
        }
    };

    let base_payload = json!({
        "kind": "createTask",
        "id": action_id,
        "libraryId": target.library_id,
        "libraryName": target.library_name,
        "projectId": target.project_id,
        "projectName": target.project_name,
        "title": title,
        "priority": priority,
        "taskId": "",
        "sourceId": "",
    });

    // A repeated call with a known remote identity only reads the existing task.
    // Preserve the unknown receipt if reconnection fails before readback.
    let known_id = known.as_ref().and_then(|r| r["sourceId"].as_str());
    let before_send_failure = |msg: &str| match known.as_ref() {
        Some(existing) => {
            let mut receipt = existing.clone();
            receipt["error"] = json!(msg);
            Ok(receipt)
        }
        None => finalize_receipt(
            &path,
            &action_id,
            "failed",
            "",
            "",
            &base_payload,
            Some(msg),
        ),
    };
    let Some(root) = path.parent() else {
        return before_send_failure("资料库目录不可用");
    };
    let admission = match library_runtime::admission(root, &target.library_id) {
        Ok(v) => v,
        Err(e) => return before_send_failure(&e),
    };
    let _guard = match admission.try_lock() {
        Ok(v) => v,
        Err(_) => return before_send_failure("滴答正在同步，请稍后核对或重试"),
    };
    let op = match library_runtime::begin(root, &target.library_id, "新建或核对滴答任务") {
        Ok(v) => v,
        Err(e) => return before_send_failure(&e),
    };
    let session = match dida_task_status::ready_session(app, state, &target.library_id).await {
        Ok(v) => v,
        Err(e) => return before_send_failure(&e),
    };
    let client = match task_sync_http_client_with_timeout(Duration::from_secs(12)) {
        Ok(v) => v,
        Err(e) => return before_send_failure(&e),
    };

    let remote_id = if let Some(id) = known_id {
        id.to_owned()
    } else {
        let task_payload = build_create_payload(&target, title, priority);
        // Single-attempt write: never auto-retry create_task on transport ambiguity to avoid duplicate remote tasks.
        let result = match call_dida_write_tool_raw_once(
            &client,
            &session,
            "create_task",
            json!({"task": task_payload}),
            95_200_001,
        )
        .await
        {
            Ok(r) => r,
            Err(err) => {
                let msg = format!("滴答新建结果未知（未自动重试以避免重复创建）：{err}");
                return finalize_receipt(
                    &path,
                    &action_id,
                    "unknown",
                    "",
                    "",
                    &base_payload,
                    Some(&msg),
                );
            }
        };

        let parsed = tool_result_json(&result);
        let Some(remote_id) = find_nested_string(&parsed, &["id", "taskId", "task_id"]) else {
            let msg = "滴答返回了响应但缺少远端任务 ID，结果未知，未重复创建";
            return finalize_receipt(
                &path,
                &action_id,
                "unknown",
                "",
                "",
                &base_payload,
                Some(msg),
            );
        };

        remote_id
    };
    let mut pending_payload = base_payload.clone();
    pending_payload["sourceId"] = json!(remote_id);
    finalize_receipt(
        &path,
        &action_id,
        "unknown",
        "",
        &remote_id,
        &pending_payload,
        Some("已收到任务身份，等待读取滴答原任务"),
    )?;
    let fresh = match read_dida(&client, &session, &remote_id, &target.project_id).await {
        Ok(task) if task.project_id == target.project_id && task.title == title => task,
        Ok(_) => {
            return finalize_receipt(
                &path,
                &action_id,
                "unknown",
                "",
                &remote_id,
                &pending_payload,
                Some("滴答当前标题或清单与请求不一致，需要核对原任务"),
            )
        }
        Err(error) => {
            return finalize_receipt(
                &path,
                &action_id,
                "unknown",
                "",
                &remote_id,
                &pending_payload,
                Some(&error),
            )
        }
    };

    let cache_error = dida_task_refresh::persist_changed(
        &path,
        &target.library_id,
        vec![fresh.clone()],
        None,
        None,
        None,
        &op,
    )
    .err()
    .map(|e| format!("已在滴答创建任务，但本地缓存刷新待重试：{e}"));

    let hub_task_id = unified_task_id(PROVIDER_DIDA365, &target.library_id, &remote_id);
    let unified_task = open_database(&path)
        .ok()
        .and_then(|c| unified_task_read::load(&c, None).ok())
        .and_then(|rows| rows.into_iter().find(|t| t.id == hub_task_id));

    let task_json = match unified_task {
        Some(item) => serde_json::to_value(item).unwrap_or(Value::Null),
        None => json!({
            "id": hub_task_id,
            "provider": PROVIDER_DIDA365,
            "libraryId": target.library_id,
            "libraryName": target.library_name,
            "sourceId": remote_id,
            "parentTaskId": "",
            "parentPageId": "",
            "documentId": remote_id,
            "documentTitle": target.project_name,
            "title": fresh.title,
            "completed": false,
            "status": "open",
            "priority": fresh.priority,
            "isAllDay": true,
            "path": format!("{}/{}", target.library_name, target.project_name),
            "depth": 0,
            "isProject": false,
            "collectionId": target.project_id,
            "linkedProviders": [PROVIDER_DIDA365],
            "syncState": "unlinked",
        }),
    };

    let confirmed_payload = json!({
        "kind": "createTask",
        "id": action_id,
        "libraryId": target.library_id,
        "libraryName": target.library_name,
        "projectId": target.project_id,
        "projectName": target.project_name,
        "title": fresh.title,
        "priority": fresh.priority,
        "taskId": hub_task_id,
        "sourceId": remote_id,
        "task": task_json,
    });

    let receipt = finalize_receipt(
        &path,
        &action_id,
        "confirmed",
        &hub_task_id,
        &remote_id,
        &confirmed_payload,
        cache_error.as_deref(),
    )?;
    let _ = app.emit(
        "task-list-updated",
        json!({"reason": "quick-create", "taskId": hub_task_id}),
    );
    Ok(receipt)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_db() -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("hub-task-create-{}", random_url_safe(12)));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("test.sqlite3");
        let c = open_database(&path).unwrap();
        c.execute(
            "INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES('lib-dida','dida365','滴答个人',1,1)",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES('lib-craft','craft','Craft Car',1,2)",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO dida_projects(library_id,project_id,name,kind,closed,sort_order,raw_json,synced_at) VALUES('lib-dida','inbox10086','inbox','INBOX',0,0,'{}',1)",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO dida_projects(library_id,project_id,name,kind,closed,sort_order,raw_json,synced_at) VALUES('lib-dida','proj-eng','🚀 工程研发','TASK',0,1,'{}',1)",
            [],
        )
        .unwrap();
        drop(c);
        (root, path)
    }

    #[test]
    fn resolves_real_dida_inbox_and_project_and_rejects_non_dida_without_redirect() {
        let (root, path) = setup_db();
        let c = open_database(&path).unwrap();

        let inbox = resolve_target(&c, None, None).unwrap();
        assert_eq!(inbox.library_id, "lib-dida");
        assert_eq!(inbox.project_id, "inbox10086");
        assert_eq!(inbox.project_name, "收件箱");

        let proj = resolve_target(&c, Some("lib-dida"), Some("proj-eng")).unwrap();
        assert_eq!(proj.project_id, "proj-eng");
        assert_eq!(proj.project_name, "工程研发");

        // Non-writable Craft library MUST be rejected, never silently redirected to Dida.
        assert!(resolve_target(&c, Some("lib-craft"), None).is_err());
        // Unknown project in Dida MUST be rejected, never silently redirected to inbox.
        assert!(resolve_target(&c, Some("lib-dida"), Some("non-existent")).is_err());

        drop(c);
        forget_initialized_database(&path);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn claim_and_finalize_receipt_prevents_duplicate_creation_on_unknown_or_confirmed() {
        let (root, path) = setup_db();
        let c = open_database(&path).unwrap();
        let target = resolve_target(&c, Some("lib-dida"), None).unwrap();

        let first = claim_create_action(&c, "create:req-1", &target, "核对线束", 5).unwrap();
        assert!(matches!(first, ClaimOutcome::Claimed));

        // Duplicate submit while writing returns existing writing receipt without claiming again.
        let dup = claim_create_action(&c, "create:req-1", &target, "核对线束", 5).unwrap();
        match dup {
            ClaimOutcome::Existing(v) => assert_eq!(v["state"], "writing"),
            ClaimOutcome::Claimed => panic!("duplicate request must not claim twice"),
        }
        drop(c);

        // Transition to unknown -> duplicate submit still returns unknown receipt cleanly.
        let unknown = finalize_receipt(
            &path,
            "create:req-1",
            "unknown",
            "",
            "",
            &json!({"title": "核对线束", "priority": 5}),
            Some("网络超时"),
        )
        .unwrap();
        assert_eq!(unknown["state"], "unknown");
        assert_eq!(unknown["error"], "网络超时");

        let c2 = open_database(&path).unwrap();
        let dup_unknown = claim_create_action(&c2, "create:req-1", &target, "核对线束", 5).unwrap();
        match dup_unknown {
            ClaimOutcome::Existing(v) => {
                assert_eq!(v["state"], "unknown");
                assert_eq!(v["error"], "网络超时");
            }
            ClaimOutcome::Claimed => panic!("unknown request must not re-claim"),
        }
        drop(c2);

        // Build payload respects !高 -> priority 5.
        let payload = build_create_payload(&target, "核对线束", 5);
        assert_eq!(payload["priority"], 5);
        assert_eq!(payload["projectId"], "inbox10086");
        assert_eq!(validate_priority(&json!({"priority": 5})).unwrap(), 5);
        assert!(validate_priority(&json!({"priority": 9})).is_err());

        forget_initialized_database(&path);
        fs::remove_dir_all(root).unwrap();
    }
}
