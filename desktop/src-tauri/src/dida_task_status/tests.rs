use super::*;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

struct Fixture {
    root: PathBuf,
    path: PathBuf,
    task: UnifiedTaskItem,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("hub-status-{}", random_url_safe(12)));
        fs::create_dir(&root).unwrap();
        let path = root.join("test.sqlite3");
        let mut c = open_database(&path).unwrap();
        c.execute("INSERT INTO libraries(id,provider,name,enabled,added_at,metadata_json) VALUES('dida-test','dida365','Test',1,1,?1)",[json!({"preference":{"userId":"test-account"}}).to_string()]).unwrap();
        let source=parse_task(&json!({"id":"task-test","projectId":"inbox101","title":"Keep title","content":"Keep body","status":0,"priority":3,"etag":"fresh","startDate":"2026-10-13T00:00:00+0800","dueDate":"2026-10-15T00:00:00+0800","createdTime":"2026-10-10T09:00:00+0800"}),"inbox","task-test").unwrap();
        let tx = c.transaction().unwrap();
        upsert_dida_task(&tx, "dida-test", "Inbox", &source, 1).unwrap();
        tx.commit().unwrap();
        let task = UnifiedTaskItem {
            id: unified_task_id(PROVIDER_DIDA365, "dida-test", "task-test"),
            provider: PROVIDER_DIDA365.into(),
            library_id: "dida-test".into(),
            source_id: "task-test".into(),
            document_id: "task-test".into(),
            status: "open".into(),
            ..Default::default()
        };
        Self { root, path, task }
    }
    fn intent(&self, id: i64) -> Intent {
        let c = open_database(&self.path).unwrap();
        let raw: String = c
            .query_row(
                "SELECT payload_json FROM task_sync_events WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        serde_json::from_str(&raw).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        forget_initialized_database(&self.path);
        let _ = fs::remove_dir_all(&self.root);
    }
}

struct Server {
    session: McpSession,
    requests: Arc<Mutex<Vec<Value>>>,
    state: Arc<Mutex<Value>>,
    fail_read: Arc<std::sync::atomic::AtomicBool>,
    rate_limit_then_reopen: Arc<std::sync::atomic::AtomicBool>,
    worker: tokio::task::JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.worker.abort();
    }
}
async fn server(path: PathBuf) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/mcp", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
    let seen = requests.clone();
    let state = Arc::new(Mutex::new(
        local_task(&open_database(&path).unwrap(), "dida-test", "task-test")
            .unwrap()
            .raw,
    ));
    let data = state.clone();
    let fail_read = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let fail = fail_read.clone();
    let rate_limit_then_reopen = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let rate_limit = rate_limit_then_reopen.clone();
    let worker = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let mut chunk = [0; 4096];
            let header_end = loop {
                let n = stream.read(&mut chunk).await.unwrap();
                if n == 0 {
                    return;
                }
                bytes.extend_from_slice(&chunk[..n]);
                if let Some(i) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    break i + 4;
                }
            };
            let length = String::from_utf8_lossy(&bytes[..header_end])
                .lines()
                .find_map(|l| {
                    l.split_once(':')
                        .filter(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                        .map(|(_, v)| v.trim().parse::<usize>().unwrap())
                })
                .unwrap();
            while bytes.len() < header_end + length {
                let n = stream.read(&mut chunk).await.unwrap();
                bytes.extend_from_slice(&chunk[..n]);
            }
            let request: Value =
                serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap();
            let name = request["params"]["name"].as_str().unwrap();
            seen.lock().unwrap().push(request.clone());
            let body={
                let mut task=data.lock().unwrap();
                let limited = (name=="complete_task" || name=="update_task") && rate_limit.swap(false, Ordering::Relaxed);
                if limited {
                    // Another device completed then reopened during the retry gap.
                    task["status"]=json!(0);
                    task["completedTime"]=json!("2026-10-14T00:01:00+0800");
                    task["etag"]=json!("external-reopen");
                } else if name=="complete_task" || name=="update_task" {
                    // Durable intent is already marked sent before the wire write.
                    let raw:String=open_database(&path).unwrap().query_row("SELECT payload_json FROM task_sync_events WHERE action='direct_task_status' AND status='pending' ORDER BY id DESC LIMIT 1",[],|r|r.get(0)).unwrap();
                    assert!(serde_json::from_str::<Intent>(&raw).unwrap().sent);
                    task["status"]=json!(if name=="complete_task"{2}else{0});
                    if name=="complete_task"{task["completedTime"]=json!("2026-10-13T23:59:58+0800");}
                    task["etag"]=json!("confirmed");
                }
                if limited {json!({"jsonrpc":"2.0","id":request["id"],"result":{"isError":true,"content":[{"type":"text","text":"HTTP 429 rate limit"}]}})}
                else if name=="get_task_by_id" && fail.load(Ordering::Relaxed) {json!({"jsonrpc":"2.0","id":request["id"],"result":{"isError":true,"content":[{"type":"text","text":"temporary offline"}]}})}
                else {json!({"jsonrpc":"2.0","id":request["id"],"result":{"content":[{"type":"text","text":task.to_string()}]}})}
            }.to_string();
            let response=format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
            let _ = stream.write_all(response.as_bytes()).await;
        }
    });
    Server {
        session: McpSession {
            space_id: "dida-test".into(),
            space_name: "Test".into(),
            endpoint,
            access_token: "fixture-only".into(),
            session_id: None,
            protocol_version: "2024-11-05".into(),
            deep_link_template: None,
            rate_limiter: Arc::new(CraftRateLimiter::default()),
        },
        requests,
        state,
        fail_read,
        rate_limit_then_reopen,
        worker,
    }
}

#[tokio::test]
async fn rate_limit_returns_to_outbox_before_retry_and_rechecks_external_reopen() {
    let f = Fixture::new();
    let s = server(f.path.clone()).await;
    s.rate_limit_then_reopen.store(true, Ordering::Relaxed);
    let id = accept(&f.path, &f.task, "completed").unwrap();
    let mut intent = f.intent(id);
    let op = library_runtime::begin(&f.root, "dida-test", "limited").unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(4),
        apply_remote(
            &f.path,
            id,
            &mut intent,
            &op,
            &reqwest::Client::new(),
            &s.session,
        ),
    )
    .await
    .expect("a rate-limited write must return to the durable queue promptly");
    assert!(dida_rate_limit_error(&result.unwrap_err()));
    assert!(f.intent(id).sent && !f.intent(id).remote_confirmed);
    assert!(has_pending(&f.path, &f.task.id).unwrap());
    // The production scheduler waits for cooldown; a fresh session here lets
    // this fixture verify the subsequent read without waiting a real minute.
    let session = McpSession {
        rate_limiter: Arc::new(CraftRateLimiter::default()),
        ..s.session.clone()
    };
    let mut recovered = f.intent(id);
    let error = apply_remote(
        &f.path,
        id,
        &mut recovered,
        &op,
        &reqwest::Client::new(),
        &session,
    )
    .await
    .unwrap_err();
    assert!(error.contains("已变化"));
    assert_eq!(
        s.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r["params"]["name"] == "complete_task")
            .count(),
        1
    );
    assert_eq!(
        local_task(&open_database(&f.path).unwrap(), "dida-test", "task-test")
            .unwrap()
            .status,
        0
    );
}

#[tokio::test]
async fn status_only_transport_confirms_and_persists_completion_then_reopen() {
    let f = Fixture::new();
    let s = server(f.path.clone()).await;
    let client = reqwest::Client::new();
    let id = accept(&f.path, &f.task, "completed").unwrap();
    let mut intent = f.intent(id);
    let op = library_runtime::begin(&f.root, "dida-test", "test").unwrap();
    apply_remote(&f.path, id, &mut intent, &op, &client, &s.session)
        .await
        .unwrap();
    assert!(intent.remote_confirmed);
    assert!(!has_pending(&f.path, &f.task.id).unwrap());
    let task = local_task(&open_database(&f.path).unwrap(), "dida-test", "task-test").unwrap();
    assert_eq!(task.status, 2);
    assert_eq!(task.title, "Keep title");
    assert_eq!(task.content, "Keep body");
    assert_eq!(task.priority, 3);
    assert_eq!(
        task.completed_time.as_deref(),
        Some("2026-10-13T23:59:58+0800")
    );
    let date = task_dates::dida_dates(&task.raw, true, task.completed_time.as_deref())
        .completed_at
        .unwrap();
    assert!(date.starts_with("2026-10-13"));
    let mut done = f.task.clone();
    done.status = "completed".into();
    done.completed = true;
    let reopen = accept(&f.path, &done, "open").unwrap();
    let mut intent = f.intent(reopen);
    apply_remote(&f.path, reopen, &mut intent, &op, &client, &s.session)
        .await
        .unwrap();
    let task = local_task(&open_database(&f.path).unwrap(), "dida-test", "task-test").unwrap();
    assert_eq!(task.status, 0);
    assert!(
        task_dates::dida_dates(&task.raw, false, task.completed_time.as_deref()).completion_history
            [0]
        .reopened
    );
    let requests = s.requests.lock().unwrap();
    let writes = requests
        .iter()
        .filter(|r| r["params"]["name"] != "get_task_by_id")
        .collect::<Vec<_>>();
    assert_eq!(writes.len(), 2);
    assert_eq!(
        writes[0]["params"]["arguments"],
        json!({"project_id":"inbox101","task_id":"task-test"})
    );
    assert_eq!(
        writes[1]["params"]["arguments"],
        json!({"task_id":"task-test","task":{"id":"task-test","projectId":"inbox101","status":0,"etag":"confirmed"}})
    );
}

#[tokio::test]
async fn restart_after_uncertain_write_reads_before_replay_and_accepts_already_done() {
    let f = Fixture::new();
    let s = server(f.path.clone()).await;
    let id = accept(&f.path, &f.task, "completed").unwrap();
    let mut intent = f.intent(id);
    intent.sent = true;
    save_intent(&f.path, id, &intent, "pending", Some("offline")).unwrap();
    s.state.lock().unwrap()["status"] = json!(2);
    s.state.lock().unwrap()["completedTime"] = json!("2026-10-13T23:59:58+0800");
    // Reloading the intent simulates losing all in-memory operation state.
    let mut recovered = f.intent(id);
    let op = library_runtime::begin(&f.root, "dida-test", "recover").unwrap();
    apply_remote(
        &f.path,
        id,
        &mut recovered,
        &op,
        &reqwest::Client::new(),
        &s.session,
    )
    .await
    .unwrap();
    assert!(recovered.remote_confirmed);
    assert_eq!(s.requests.lock().unwrap().len(), 1);
    assert_eq!(
        s.requests.lock().unwrap()[0]["params"]["name"],
        "get_task_by_id"
    );
}

#[tokio::test]
async fn offline_before_read_keeps_durable_pending_and_source_unmodified() {
    let f = Fixture::new();
    let s = server(f.path.clone()).await;
    s.fail_read.store(true, Ordering::Relaxed);
    let id = accept(&f.path, &f.task, "completed").unwrap();
    let mut intent = f.intent(id);
    let op = library_runtime::begin(&f.root, "dida-test", "offline").unwrap();
    assert!(apply_remote(
        &f.path,
        id,
        &mut intent,
        &op,
        &reqwest::Client::new(),
        &s.session
    )
    .await
    .is_err());
    assert!(has_pending(&f.path, &f.task.id).unwrap());
    assert!(!f.intent(id).sent);
    assert_eq!(
        local_task(&open_database(&f.path).unwrap(), "dida-test", "task-test")
            .unwrap()
            .status,
        0
    );
}

#[test]
fn duplicate_intent_and_recurring_safety_do_not_create_extra_operations() {
    let f = Fixture::new();
    let id = accept(&f.path, &f.task, "completed").unwrap();
    assert_eq!(accept(&f.path, &f.task, "completed").unwrap(), id);
    let mut task = local_task(&open_database(&f.path).unwrap(), "dida-test", "task-test").unwrap();
    task.raw["repeatFlag"] = json!("RRULE:FREQ=DAILY");
    let intent = f.intent(id);
    assert!(transition_action(&task, &intent).is_err());
    task.raw["repeatFlag"] = Value::Null;
    task.completed_time = Some("2026-10-14T00:01:00+0800".into());
    let mut sent = intent;
    sent.sent = true;
    assert!(transition_action(&task, &sent).is_err());
}

#[test]
fn latest_pending_target_replaces_unsent_operations_without_inventing_completion() {
    let f = Fixture::new();
    let first = accept(&f.path, &f.task, "completed").unwrap();
    let last = accept(&f.path, &f.task, "open").unwrap();
    assert_ne!(first, last);
    assert_eq!(f.intent(last).status, "open");
    assert!(!f.intent(last).rebase_after_previous_write);
    let c = open_database(&f.path).unwrap();
    assert_eq!(
        c.query_row(
            "SELECT status FROM task_sync_events WHERE id=?1",
            [first],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        "resolved"
    );
    assert_eq!(c.query_row("SELECT COUNT(*) FROM task_sync_events WHERE action='direct_task_status' AND status='pending'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    let mut tasks = vec![f.task.clone()];
    decorate(&c, &mut tasks).unwrap();
    assert_eq!(
        tasks[0].status_mutation.as_ref().unwrap().target_status,
        "open"
    );
    assert_eq!(tasks[0].status, "open");
    assert!(tasks[0].completed_at.is_none());
}

#[tokio::test]
async fn reopening_after_an_uncertain_completion_rebases_and_survives_restart() {
    let f = Fixture::new();
    let s = server(f.path.clone()).await;
    let first = accept(&f.path, &f.task, "completed").unwrap();
    let mut previous = f.intent(first);
    previous.sent = true;
    save_intent(
        &f.path,
        first,
        &previous,
        "pending",
        Some("readback offline"),
    )
    .unwrap();
    s.state.lock().unwrap()["status"] = json!(2);
    s.state.lock().unwrap()["completedTime"] = json!("2026-10-13T23:59:58+0800");
    let last = accept(&f.path, &f.task, "open").unwrap();
    assert!(f.intent(last).rebase_after_previous_write);
    // Reload the only remaining pending intent as a restarted worker would.
    let mut recovered = f.intent(last);
    let op = library_runtime::begin(&f.root, "dida-test", "latest-target").unwrap();
    apply_remote(
        &f.path,
        last,
        &mut recovered,
        &op,
        &reqwest::Client::new(),
        &s.session,
    )
    .await
    .unwrap();
    let saved = local_task(&open_database(&f.path).unwrap(), "dida-test", "task-test").unwrap();
    assert_eq!(saved.status, 0);
    assert_eq!(saved.title, "Keep title");
    assert_eq!(saved.content, "Keep body");
    assert!(!has_pending(&f.path, &f.task.id).unwrap());
    assert!(!recovered.rebase_after_previous_write);
    let requests = s.requests.lock().unwrap();
    assert_eq!(
        requests
            .iter()
            .filter(|r| r["params"]["name"] == "complete_task")
            .count(),
        0
    );
    assert_eq!(
        requests
            .iter()
            .filter(|r| r["params"]["name"] == "update_task")
            .count(),
        1
    );
}

#[test]
fn replacing_a_terminal_uncertain_write_keeps_the_rebase_until_confirmation() {
    let f = Fixture::new();
    let first = accept(&f.path, &f.task, "completed").unwrap();
    let mut previous = f.intent(first);
    previous.sent = true;
    save_intent(
        &f.path,
        first,
        &previous,
        "failed",
        Some("unconfirmed after retries"),
    )
    .unwrap();
    let last = accept(&f.path, &f.task, "open").unwrap();
    assert!(f.intent(last).rebase_after_previous_write);
    assert_ne!(last, first);
    let final_target = accept(&f.path, &f.task, "completed").unwrap();
    assert!(f.intent(final_target).rebase_after_previous_write);
    assert_eq!(f.intent(final_target).status, "completed");
}

#[test]
fn pending_projection_is_visible_without_inventing_completion() {
    let f = Fixture::new();
    let id = accept(&f.path, &f.task, "completed").unwrap();
    let c = open_database(&f.path).unwrap();
    let mut tasks = vec![f.task.clone()];
    decorate(&c, &mut tasks).unwrap();
    assert_eq!(tasks[0].status, "open");
    assert_eq!(tasks[0].status_mutation.as_ref().unwrap().state, "pending");
    assert_eq!(tasks[0].status_mutation.as_ref().unwrap().operation_id, id);
    assert!(tasks[0].completed_at.is_none());
}

#[test]
fn bound_status_intent_resolves_dida_identity_and_respects_sync_direction() {
    let f = Fixture::new();
    let c = open_database(&f.path).unwrap();
    c.execute("INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES('craft-test','craft','Craft',1,1)",[]).unwrap();
    c.execute("INSERT INTO unified_task_bindings(hub_task_id,provider,library_id,source_id,document_id,source_hash,last_seen_at) VALUES(?1,'dida365','dida-test','task-test','task-test','unchanged-baseline',1)",[&f.task.id]).unwrap();
    c.execute("INSERT INTO unified_task_bindings(hub_task_id,provider,library_id,source_id,document_id,source_hash,last_seen_at) VALUES(?1,'craft','craft-test','block-test','doc-test','unchanged-baseline',1)",[&f.task.id]).unwrap();
    let mut craft = f.task.clone();
    craft.provider = "craft".into();
    craft.library_id = "craft-test".into();
    craft.source_id = "block-test".into();
    craft.document_id = "doc-test".into();
    craft.sync_state = "linked".into();
    assert!(!accepts(&f.path, &craft).unwrap());
    c.execute(
        "UPDATE task_sync_settings SET enabled=1,craft_to_dida=1,dida_to_craft=0 WHERE id=1",
        [],
    )
    .unwrap();
    assert!(accepts(&f.path, &craft).unwrap());
    let id = accept(&f.path, &craft, "completed").unwrap();
    let intent = f.intent(id);
    assert_eq!(intent.library_id, "dida-test");
    assert_eq!(intent.source_id, "task-test");
    assert_eq!(intent.mirror.unwrap().source_id, "block-test");
    // Direct status edits never advance full content synchronization baselines.
    assert_eq!(c.query_row("SELECT source_hash FROM unified_task_bindings WHERE hub_task_id=?1 AND provider='dida365'",[&f.task.id],|r|r.get::<_,String>(0)).unwrap(),"unchanged-baseline");
}

#[test]
fn workbench_completion_updates_dida_even_when_a_craft_binding_exists() {
    let f = Fixture::new();
    let c = open_database(&f.path).unwrap();
    c.execute("INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES('craft-test','craft','Craft',1,1)",[]).unwrap();
    c.execute("INSERT INTO craft_task_blocks(space_id,document_id,block_id,title,completed,source_hash,modified_at) VALUES('craft-test','doc-test','block-test','Keep title',0,'original',10)",[]).unwrap();
    c.execute("INSERT INTO unified_task_bindings(hub_task_id,provider,library_id,source_id,document_id,source_hash,last_seen_at) VALUES(?1,'dida365','dida-test','task-test','task-test','original',1)",[&f.task.id]).unwrap();
    c.execute("INSERT INTO unified_task_bindings(hub_task_id,provider,library_id,source_id,document_id,source_hash,last_seen_at) VALUES(?1,'craft','craft-test','block-test','doc-test','original',1)",[&f.task.id]).unwrap();
    c.execute(
        "UPDATE task_sync_settings SET enabled=1,dida_to_craft=1 WHERE id=1",
        [],
    )
    .unwrap();
    let requested = accept(&f.path, &f.task, "completed").unwrap();
    assert!(f.intent(requested).mirror.is_none());
}

/// Explicitly selected integration check; only an already-created, owned task
/// with this marker is eligible. Credentials stay inside the native store.
#[tokio::test]
#[ignore = "requires an owned temporary task and saved Dida authorization"]
async fn live_owned_task_status_roundtrip_and_completion_inventory() {
    let source_id = std::env::var("HUB_OWNED_STATUS_TASK_ID").expect("owned task required");
    let title = std::env::var("HUB_OWNED_STATUS_TASK_TITLE").expect("exact owned title required");
    let library =
        std::env::var("HUB_OWNED_STATUS_LIBRARY_ID").expect("saved authorization required");
    assert!(source_id.len() == 24 && source_id.bytes().all(|b| b.is_ascii_hexdigit()));
    assert!(title.starts_with("Hub 状态验收 "));
    let client = task_sync_http_client().unwrap();
    let mut credential = load_credential(&library).expect("saved native authorization unavailable");
    assert_eq!(
        Url::parse(&credential.mcp_url).unwrap().host_str(),
        Some("mcp.dida365.com")
    );
    let token = restore_credential_access_token(&client, &library, &mut credential)
        .await
        .expect("native token restore failed");
    save_credential(&library, &credential).expect("save rotated credential");
    let mut authenticated = initialize_mcp_transport(
        &client,
        &credential.mcp_url,
        token,
        DIDA_MCP_PROTOCOL_VERSION,
    )
    .await
    .expect("native Dida transport initialization failed");
    authenticated.session.space_id = "dida-test".into();
    let remote = call_mcp_tool_raw(
        &client,
        &authenticated.session,
        "get_task_by_id",
        json!({"task_id":source_id}),
        95_000_000,
    )
    .await
    .expect("owned source read failed");
    let source = parse_task(&tool_result_json(&remote), "inbox", &source_id).unwrap();
    assert_eq!(source.title, title);
    assert_eq!(
        source.content,
        "Owned Hub status acceptance fixture. Preserve title, body, priority and dates."
    );
    assert!(matches!(source.status, 0 | 2));
    assert!(blocked_reason(&source.raw).is_none());
    let f = Fixture::new();
    let (mut c, _writer) = open_write_database(&f.path).unwrap();
    let tx = c.transaction().unwrap();
    upsert_dida_task(&tx, "dida-test", "Inbox", &source, now_timestamp()).unwrap();
    tx.commit().unwrap();
    drop(c);
    drop(_writer);
    let task = UnifiedTaskItem {
        id: unified_task_id(PROVIDER_DIDA365, "dida-test", &source_id),
        source_id: source_id.clone(),
        document_id: source_id.clone(),
        ..f.task.clone()
    };
    let op = library_runtime::begin(&f.root, "dida-test", "owned-live-status").unwrap();
    // Dida returns [] on creation and null after completion for empty tags;
    // compare their actual set, while retaining exact nonempty properties.
    let preserved = |raw: &Value| json!({"title":raw["title"],"content":raw["content"],"priority":raw["priority"],"startDate":raw["startDate"],"dueDate":raw["dueDate"],"isAllDay":raw["isAllDay"],"timeZone":raw["timeZone"],"reminders":raw["reminders"],"tags":raw["tags"].as_array().cloned().unwrap_or_default()});
    let before = preserved(&source.raw);
    let mut confirmations = Vec::new();
    for status in ["open", "completed", "open", "completed"] {
        let current =
            local_task(&open_database(&f.path).unwrap(), "dida-test", &source_id).unwrap();
        let mut displayed = task.clone();
        displayed.status = dida_display_task_status(current.status).into();
        displayed.completed = current.status == 2;
        let id = accept(&f.path, &displayed, status).unwrap();
        let mut intent = f.intent(id);
        apply_remote(
            &f.path,
            id,
            &mut intent,
            &op,
            &client,
            &authenticated.session,
        )
        .await
        .expect("native single-task status path failed");
        assert!(intent.remote_confirmed);
        let actual = local_task(&open_database(&f.path).unwrap(), "dida-test", &source_id).unwrap();
        assert_eq!(dida_display_task_status(actual.status), status);
        assert_eq!(preserved(&actual.raw), before);
        confirmations.push(json!({"status":status,"completedAt":task_dates::dida_dates(&actual.raw,actual.status==2,actual.completed_time.as_deref()).completed_at}));
    }
    let (args, _) = dida_task_refresh::completed_window(now_timestamp(), None);
    let inventory = call_mcp_tool_raw(
        &client,
        &authenticated.session,
        "list_completed_tasks_by_date",
        args,
        95_000_001,
    )
    .await
    .expect("real completion inventory failed");
    let mut rows = Vec::new();
    collect_dida_tasks(&tool_result_json(&inventory), "inbox", &mut rows);
    assert!(
        rows.iter()
            .any(|t| t.id == source_id && t.status == 2 && t.completed_time.is_some()),
        "actual completed task must appear in the independent refresh endpoint"
    );
    let report = json!({"provider":"real official Dida MCP through native Hub transport","sourceId":source_id,"confirmations":confirmations,"nonStatusFieldsPreserved":true,"completedInventoryContainsTask":true,"personalDatabaseWrites":false});
    let output = PathBuf::from(
        std::env::var("HUB_OWNED_STATUS_REPORT").expect("owned evidence path required"),
    );
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output)
        .unwrap();
    use std::io::Write;
    file.write_all(serde_json::to_string_pretty(&report).unwrap().as_bytes())
        .unwrap();
}
