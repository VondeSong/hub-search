use super::*;

struct TestDatabase {
    path: PathBuf,
}

impl TestDatabase {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir()
            .join(format!("hub-task-inbox-{name}-{}", random_url_safe(8)))
            .with_extension("sqlite3");
        drop(open_database(&path).expect("initialize current database schema"));
        Self { path }
    }
}

impl Drop for TestDatabase {
    fn drop(&mut self) {
        forget_initialized_database(&self.path);
        let _ = std::fs::remove_file(&self.path);
        let _ = std::fs::remove_file(self.path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(self.path.with_extension("sqlite3-shm"));
    }
}

fn add_library(connection: &Connection, id: &str, provider: &str, enabled: bool) {
    connection
        .execute(
            "INSERT INTO libraries (id,provider,name,enabled,added_at)
             VALUES (?1,?2,?1,?3,1)",
            params![id, provider, enabled as i64],
        )
        .unwrap();
}

fn add_project(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    name: &str,
    kind: &str,
    closed: bool,
) {
    connection
        .execute(
            "INSERT INTO dida_projects
               (library_id,project_id,name,kind,closed,raw_json,synced_at)
             VALUES (?1,?2,?3,?4,?5,'{}',1)",
            params![library_id, project_id, name, kind, closed as i64],
        )
        .unwrap();
}

fn sync_record(provider: &str, library_id: &str, source_id: &str) -> TaskSyncRecord {
    TaskSyncRecord {
        provider: provider.into(),
        library_id: library_id.into(),
        source_space_name: provider.into(),
        source_id: source_id.into(),
        parent_source_id: String::new(),
        document_id: source_id.into(),
        parent_page_id: String::new(),
        raw_document_id: String::new(),
        title: format!("任务 {source_id}"),
        completed: false,
        start_at: String::new(),
        due_at: String::new(),
        is_all_day: true,
        time_zone: "Asia/Shanghai".into(),
        schedule_date: String::new(),
        deadline_date: String::new(),
        project_id: String::new(),
        content: String::new(),
        description: String::new(),
        tags: Vec::new(),
        is_project_page: false,
    }
}

#[test]
fn inbox_resolution_uses_selected_account_and_ignores_closed_and_ordinary_lists() {
    let database = TestDatabase::new("selected-account");
    let connection = open_database(&database.path).unwrap();
    add_library(&connection, "selected", PROVIDER_DIDA365, true);
    add_library(&connection, "other", PROVIDER_DIDA365, true);
    add_project(&connection, "other", "inbox", "收件箱", "INBOX", false);
    add_project(&connection, "selected", "inbox", "收件箱", "INBOX", true);
    add_project(
        &connection,
        "selected",
        "craft-list",
        "Craft",
        "TASK",
        false,
    );
    // The display name alone must not turn an ordinary list into the inbox.
    add_project(
        &connection,
        "selected",
        "renamed-list",
        "收件箱",
        "TASK",
        false,
    );
    add_project(
        &connection,
        "selected",
        "inbox123456789",
        "Inbox",
        "",
        false,
    );

    assert_eq!(
        task_sync_inbox_project_id(&connection, "selected").unwrap(),
        "inbox123456789"
    );
    assert_eq!(
        task_sync_inbox_project_id(&connection, "other").unwrap(),
        "inbox"
    );
}

#[test]
fn inbox_resolution_prefers_canonical_alias_and_accepts_explicit_inbox_kind() {
    let database = TestDatabase::new("inbox-aliases");
    let connection = open_database(&database.path).unwrap();
    add_library(&connection, "dida", PROVIDER_DIDA365, true);
    add_project(&connection, "dida", "inbox123456789", "Inbox", "", false);
    add_project(&connection, "dida", "inbox", "收件箱", "INBOX", false);

    assert_eq!(
        task_sync_inbox_project_id(&connection, "dida").unwrap(),
        "inbox"
    );

    connection
        .execute("DELETE FROM dida_projects WHERE library_id='dida'", [])
        .unwrap();
    add_project(
        &connection,
        "dida",
        "account-inbox-id",
        "收件箱",
        "INBOX",
        false,
    );
    assert_eq!(
        task_sync_inbox_project_id(&connection, "dida").unwrap(),
        "account-inbox-id"
    );
}

#[test]
fn inbox_resolution_rejects_disabled_wrong_provider_and_unavailable_accounts() {
    let database = TestDatabase::new("unavailable-account");
    let connection = open_database(&database.path).unwrap();
    add_library(&connection, "disabled", PROVIDER_DIDA365, false);
    add_library(&connection, "craft", PROVIDER_CRAFT, true);
    add_library(&connection, "ordinary-only", PROVIDER_DIDA365, true);
    add_project(&connection, "disabled", "inbox", "收件箱", "INBOX", false);
    add_project(&connection, "craft", "inbox", "收件箱", "INBOX", false);
    add_project(
        &connection,
        "ordinary-only",
        "craft-list",
        "Craft",
        "TASK",
        false,
    );

    for library_id in ["disabled", "craft", "ordinary-only", "missing"] {
        assert!(
            task_sync_inbox_project_id(&connection, library_id).is_err(),
            "{library_id} must not provide a usable Dida inbox"
        );
    }
}

#[test]
fn reconfiguring_legacy_craft_destination_uses_inbox_and_keeps_existing_binding() {
    let database = TestDatabase::new("legacy-configuration");
    let connection = open_database(&database.path).unwrap();
    add_library(&connection, "craft", PROVIDER_CRAFT, true);
    add_library(&connection, "dida", PROVIDER_DIDA365, true);
    add_project(&connection, "dida", "craft-list", "Craft", "TASK", false);
    add_project(
        &connection,
        "dida",
        "inbox123456789",
        "收件箱",
        "INBOX",
        false,
    );
    connection
        .execute(
            "UPDATE task_sync_settings SET enabled=1,dida_library_id='dida',
               dida_project_id='craft-list' WHERE id=1",
            [],
        )
        .unwrap();
    drop(connection);

    let craft = sync_record(PROVIDER_CRAFT, "craft", "craft-parent");
    save_new_task_sync_pair(&database.path, &craft, "dida", "dida-parent").unwrap();
    let before = load_task_sync_pairs(&database.path).unwrap();
    assert_eq!(before.len(), 1);

    configure_task_sync_database(&database.path, true, "dida").unwrap();

    let connection = open_database(&database.path).unwrap();
    let settings: (i64, String, String) = connection
        .query_row(
            "SELECT enabled,dida_library_id,dida_project_id
             FROM task_sync_settings WHERE id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(settings, (1, "dida".into(), "inbox123456789".into()));
    let after = load_task_sync_pairs(&database.path).unwrap();
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].hub_task_id, before[0].hub_task_id);
    assert_eq!(after[0].craft_source_id, "craft-parent");
    assert_eq!(after[0].dida_library_id, "dida");
    assert_eq!(after[0].dida_source_id, "dida-parent");
}

#[test]
fn new_root_task_uses_inbox_even_when_other_records_are_in_custom_lists() {
    let mut other_task = sync_record(PROVIDER_DIDA365, "dida", "other-task");
    other_task.project_id = "custom-list".into();

    assert_eq!(
        task_sync_new_dida_project_id(&[other_task], "dida", "inbox123456789", None).unwrap(),
        "inbox123456789"
    );
}

#[test]
fn new_child_follows_moved_parent_and_ignores_same_id_in_another_account() {
    let mut other_account_parent = sync_record(PROVIDER_DIDA365, "other", "parent");
    other_account_parent.project_id = "wrong-list".into();
    let mut parent = sync_record(PROVIDER_DIDA365, "dida", "parent");
    parent.project_id = "custom-list-after-move".into();

    assert_eq!(
        task_sync_new_dida_project_id(
            &[other_account_parent, parent],
            "dida",
            "inbox",
            Some("parent"),
        )
        .unwrap(),
        "custom-list-after-move"
    );
}

#[test]
fn new_child_waits_when_parent_record_account_provider_or_project_is_invalid() {
    let mut wrong_account = sync_record(PROVIDER_DIDA365, "other", "parent");
    wrong_account.project_id = "custom-list".into();
    let mut wrong_provider = sync_record(PROVIDER_CRAFT, "dida", "parent");
    wrong_provider.project_id = "custom-list".into();
    let empty_project = sync_record(PROVIDER_DIDA365, "dida", "parent");
    let mut whitespace_project = empty_project.clone();
    whitespace_project.project_id = "  ".into();

    for records in [
        Vec::new(),
        vec![wrong_account],
        vec![wrong_provider],
        vec![empty_project],
        vec![whitespace_project],
    ] {
        assert!(
            task_sync_new_dida_project_id(&records, "dida", "inbox", Some("parent")).is_err(),
            "unconfirmed parents must not flatten children into the inbox"
        );
    }
}

#[test]
fn new_child_can_follow_parent_created_earlier_in_the_same_sync_run() {
    let mut records = Vec::new();
    assert!(task_sync_new_dida_project_id(&records, "dida", "inbox", Some("new-parent")).is_err());

    let mut newly_created_parent = sync_record(PROVIDER_DIDA365, "dida", "new-parent");
    newly_created_parent.project_id = "inbox123456789".into();
    records.push(newly_created_parent);

    assert_eq!(
        task_sync_new_dida_project_id(&records, "dida", "inbox", Some("new-parent")).unwrap(),
        "inbox123456789"
    );
}

#[test]
fn moving_persisted_task_keeps_binding_and_routes_new_children_to_current_list() {
    let database = TestDatabase::new("persisted-move");
    let (mut connection, writer) = open_write_database(&database.path).unwrap();
    add_library(&connection, "craft", PROVIDER_CRAFT, true);
    add_library(&connection, "dida", PROVIDER_DIDA365, true);
    let mut tasks = Vec::new();
    collect_dida_tasks(
        &json!({
            "id": "dida-parent",
            "projectId": "inbox",
            "title": "保持关联的项目",
            "content": "Craft 来源",
            "status": 0
        }),
        "inbox",
        &mut tasks,
    );
    assert_eq!(tasks.len(), 1);
    let transaction = connection.transaction().unwrap();
    upsert_dida_task(&transaction, "dida", "收件箱", &tasks[0], 1).unwrap();
    transaction.commit().unwrap();
    drop(connection);
    drop(writer);

    let craft = sync_record(PROVIDER_CRAFT, "craft", "craft-parent");
    save_new_task_sync_pair(&database.path, &craft, "dida", "dida-parent").unwrap();
    let before = load_task_sync_pairs(&database.path).unwrap();
    assert_eq!(before.len(), 1);
    let connection = open_database(&database.path).unwrap();
    assert_eq!(
        connection
            .execute(
                "UPDATE dida_tasks SET project_id='next-actions'
                 WHERE library_id='dida' AND task_id='dida-parent'",
                [],
            )
            .unwrap(),
        1
    );
    drop(connection);

    let after = load_task_sync_pairs(&database.path).unwrap();
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].hub_task_id, before[0].hub_task_id);
    assert_eq!(after[0].craft_source_id, "craft-parent");
    assert_eq!(after[0].dida_source_id, "dida-parent");
    let records = load_task_sync_records(&database.path).unwrap();
    let parent = records
        .iter()
        .find(|record| {
            record.provider == PROVIDER_DIDA365
                && record.library_id == after[0].dida_library_id
                && record.source_id == after[0].dida_source_id
        })
        .expect("moved parent remains visible to sync by its stable task identity");
    assert_eq!(parent.project_id, "next-actions");
    assert_eq!(
        task_sync_new_dida_project_id(&records, "dida", "inbox", Some(&after[0].dida_source_id))
            .unwrap(),
        "next-actions"
    );
}

#[test]
fn existing_child_moved_alone_keeps_root_position_in_its_new_list() {
    let mut parent = sync_record(PROVIDER_DIDA365, "dida", "original-parent");
    parent.project_id = "inbox".into();
    let mut child = sync_record(PROVIDER_DIDA365, "dida", "child");
    child.project_id = "next-actions".into();

    assert_eq!(
        task_sync_existing_dida_parent_id(
            &[parent, child.clone()],
            &child,
            Some("original-parent".into()),
        ),
        None,
        "metadata repair must not move an individually moved child back under a parent in another list"
    );
}

#[test]
fn existing_child_in_same_list_keeps_craft_parent_binding() {
    let mut parent = sync_record(PROVIDER_DIDA365, "dida", "original-parent");
    parent.project_id = "next-actions".into();
    let mut child = sync_record(PROVIDER_DIDA365, "dida", "child");
    child.project_id = "next-actions".into();

    assert_eq!(
        task_sync_existing_dida_parent_id(
            &[parent, child.clone()],
            &child,
            Some("original-parent".into()),
        ),
        Some("original-parent".into())
    );
}

#[test]
fn existing_child_moved_under_another_parent_keeps_current_dida_relationship() {
    let mut original_parent = sync_record(PROVIDER_DIDA365, "dida", "original-parent");
    original_parent.project_id = "inbox".into();
    let mut destination_parent = sync_record(PROVIDER_DIDA365, "dida", "destination-parent");
    destination_parent.project_id = "next-actions".into();
    let mut child = sync_record(PROVIDER_DIDA365, "dida", "child");
    child.project_id = "next-actions".into();
    child.parent_source_id = "destination-parent".into();

    assert_eq!(
        task_sync_existing_dida_parent_id(
            &[original_parent, destination_parent, child.clone()],
            &child,
            Some("original-parent".into()),
        ),
        Some("destination-parent".into())
    );
}

async fn start_parent_readback_mcp(result: Value) -> (McpSession, tokio::task::JoinHandle<Value>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let session = McpSession {
        space_id: "dida".into(),
        space_name: "隔离测试账户".into(),
        endpoint: format!("http://{}/mcp", listener.local_addr().unwrap()),
        access_token: "isolated-test-token".into(),
        session_id: None,
        protocol_version: "2025-03-26".into(),
        deep_link_template: None,
        rate_limiter: Arc::new(CraftRateLimiter::default()),
    };
    let server = tokio::spawn(async move {
        let (mut stream, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
            .await
            .expect("local MCP readback must arrive")
            .unwrap();
        let mut request = Vec::new();
        let mut chunk = [0_u8; 4096];
        let header_end = loop {
            let read = stream.read(&mut chunk).await.unwrap();
            assert!(read > 0, "request ended before its headers");
            request.extend_from_slice(&chunk[..read]);
            if let Some(position) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                break position + 4;
            }
            assert!(request.len() < 64 * 1024);
        };
        let headers = String::from_utf8_lossy(&request[..header_end]);
        let content_length = headers
            .split("\r\n")
            .filter_map(|line| line.split_once(':'))
            .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
            .map(|(_, value)| value.trim().parse::<usize>().unwrap())
            .expect("JSON MCP request has a content length");
        while request.len() < header_end + content_length {
            let read = stream.read(&mut chunk).await.unwrap();
            assert!(read > 0, "request ended before its JSON body");
            request.extend_from_slice(&chunk[..read]);
        }
        let request_json: Value =
            serde_json::from_slice(&request[header_end..header_end + content_length]).unwrap();
        assert_eq!(request_json["method"], "tools/call");
        assert_eq!(request_json["params"]["name"], "get_task_by_id");
        assert_eq!(
            request_json["params"]["arguments"]["task_id"],
            "dida-parent"
        );
        let response = json!({
            "jsonrpc": "2.0",
            "id": request_json["id"],
            "result": result,
        })
        .to_string();
        let headers = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            response.len()
        );
        stream.write_all(headers.as_bytes()).await.unwrap();
        stream.write_all(response.as_bytes()).await.unwrap();
        stream.shutdown().await.unwrap();
        request_json
    });
    (session, server)
}

fn seed_completed_readback_parent(database: &TestDatabase) -> TaskSyncRecord {
    let connection = open_database(&database.path).unwrap();
    add_library(&connection, "dida", PROVIDER_DIDA365, true);
    add_project(&connection, "dida", "inbox", "收件箱", "INBOX", false);
    add_project(&connection, "dida", "next-actions", "下一步", "TASK", false);
    drop(connection);
    let mut tasks = Vec::new();
    collect_dida_tasks(
        &json!({
            "id": "dida-parent",
            "projectId": "inbox",
            "title": "已完成父任务",
            "content": "Craft 来源",
            "status": 2,
        }),
        "inbox",
        &mut tasks,
    );
    assert_eq!(tasks.len(), 1);
    persist_direct_dida_task(&database.path, "dida", &tasks[0]).unwrap();
    let parent = load_task_sync_records(&database.path)
        .unwrap()
        .into_iter()
        .find(|record| record.provider == PROVIDER_DIDA365 && record.source_id == "dida-parent")
        .unwrap();
    assert!(parent.completed);
    parent
}

#[tokio::test]
async fn completed_parent_readback_persists_new_list_and_routes_new_child_there() {
    let database = TestDatabase::new("completed-parent-readback");
    let cached_parent = seed_completed_readback_parent(&database);
    let result = json!({
        "content": [{
            "type": "text",
            "text": json!({
                "id": "dida-parent",
                "projectId": "next-actions",
                "title": "已完成父任务",
                "content": "Craft 来源",
                "status": 2,
            }).to_string(),
        }],
    });
    let (session, server) = start_parent_readback_mcp(result).await;
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();

    let refreshed =
        task_sync_refresh_creation_parent(&database.path, &client, &session, &cached_parent, 90001)
            .await
            .unwrap();
    server.await.unwrap();

    assert!(refreshed.completed);
    assert_eq!(refreshed.project_id, "next-actions");
    let records = load_task_sync_records(&database.path).unwrap();
    assert_eq!(
        task_sync_new_dida_project_id(&records, "dida", "inbox", Some("dida-parent")).unwrap(),
        "next-actions"
    );
    let connection = open_database(&database.path).unwrap();
    let persisted: (String, i64) = connection
        .query_row(
            "SELECT project_id,status FROM dida_tasks
             WHERE library_id='dida' AND task_id='dida-parent'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(persisted, ("next-actions".into(), 2));
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM dida_tasks", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1,
        "readback only updates the existing parent"
    );
}

#[tokio::test]
async fn completed_parent_empty_readback_fails_without_changing_cached_position_or_creating_tasks()
{
    let database = TestDatabase::new("completed-parent-empty-readback");
    let cached_parent = seed_completed_readback_parent(&database);
    let (session, server) = start_parent_readback_mcp(json!({
        "content": [{"type": "text", "text": ""}],
    }))
    .await;
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();

    let result =
        task_sync_refresh_creation_parent(&database.path, &client, &session, &cached_parent, 90002)
            .await;
    server.await.unwrap();
    assert!(
        result.is_err(),
        "an empty remote read cannot confirm the parent list"
    );

    let connection = open_database(&database.path).unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT project_id FROM dida_tasks WHERE library_id='dida' AND task_id='dida-parent'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
        "inbox"
    );
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM dida_tasks", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1,
        "failed parent confirmation must not create another task"
    );
}

#[tokio::test]
async fn completed_parent_readback_without_project_id_cannot_confirm_cached_list() {
    let database = TestDatabase::new("completed-parent-missing-project");
    let cached_parent = seed_completed_readback_parent(&database);
    let (session, server) = start_parent_readback_mcp(json!({
        "content": [{
            "type": "text",
            "text": json!({
                "id": "dida-parent",
                "title": "已完成父任务",
                "content": "Craft 来源",
                "status": 2,
            }).to_string(),
        }],
    }))
    .await;
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();

    let result =
        task_sync_refresh_creation_parent(&database.path, &client, &session, &cached_parent, 90003)
            .await;
    server.await.unwrap();
    assert!(
        result.is_err(),
        "a matching task ID without a remote list ID must not confirm the stale cached list"
    );

    let connection = open_database(&database.path).unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT project_id FROM dida_tasks WHERE library_id='dida' AND task_id='dida-parent'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
        "inbox"
    );
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM dida_tasks", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
}
