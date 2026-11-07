use super::*;
pub(super) fn peer_override(bridge: &Bridge) -> Result<Option<Value>, String> {
    let Some(path) = std::env::var_os("HUB_C3_TEST_PEER") else {
        return Ok(None);
    };
    let desktop = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let path = Path::new(&path).canonicalize().map_err(|e| e.to_string())?;
    let allowed = [
        (
            "artifacts/architecture-v5-skill-lifecycle-20261028/candidate-freeze.json",
            "0.16.355",
            "abc9302e43560639fd96715b81c4a50482c1049c291bd1f37d8be9fae26bee96",
        ),
        (
            "artifacts/architecture-v5-report-entry-20261028/candidate-freeze.json",
            "0.16.356",
            "4bd35cdc6d9be9641d670378b16a1a1d651c736575c4c6e77052c1a19c3594ee",
        ),
        (
            "artifacts/architecture-v5-manual-skill-20261028/candidate-freeze.json",
            "0.16.357",
            "0f36e744d70c272e620282dd4a383e2e95d30897adf77f41d6564701c836df6b",
        ),
    ];
    let mut matched = false;
    for (file, version, hash) in allowed {
        let freeze: Value =
            serde_json::from_slice(&std::fs::read(desktop.join(file)).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        let fixed = Path::new(
            freeze["binary"]["path"]
                .as_str()
                .ok_or("missing frozen peer")?,
        )
        .canonicalize()
        .map_err(|e| e.to_string())?;
        if path == fixed
            && freeze["version"] == version
            && freeze["databaseVersion"] == 83
            && freeze["binary"]["sha256"] == hash
            && format!(
                "{:x}",
                sha2::Sha256::digest(std::fs::read(&path).map_err(|e| e.to_string())?)
            ) == hash
        {
            matched = true;
            break;
        }
    }
    if !matched {
        return Err("C3 test peer is not an explicitly frozen355/356/357".into());
    }
    struct Restore(std::ffi::OsString);
    impl Drop for Restore {
        fn drop(&mut self) {
            std::env::set_var("HUB_C3_TEST_PEER", &self.0);
        }
    }
    let _restore = Restore(path.clone().into_os_string());
    std::env::remove_var("HUB_C3_TEST_PEER");
    let mut config = bridge.config()?;
    config["hub_run"]["command"] = json!(path);
    Ok(Some(config))
}
#[test]
fn c3_peer_override_is_test_only_and_accepts_only_the_frozen_binary() {
    assert!(std::env::var_os("HUB_C3_TEST_PEER").is_none());
    let c = Control::bounded(Duration::from_secs(5));
    let b = Bridge::new(&spec(), "", &c).unwrap();
    assert!(peer_override(&b).unwrap().is_none());
    let desktop = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let freeze: Value = serde_json::from_slice(
        &std::fs::read(
            desktop
                .join("artifacts/architecture-v5-skill-lifecycle-20261028/candidate-freeze.json"),
        )
        .unwrap(),
    )
    .unwrap();
    let path = freeze["binary"]["path"].as_str().unwrap();
    std::env::set_var("HUB_C3_TEST_PEER", path);
    let value = peer_override(&b).unwrap().unwrap();
    assert_eq!(
        Path::new(value["hub_run"]["command"].as_str().unwrap())
            .canonicalize()
            .unwrap(),
        Path::new(path).canonicalize().unwrap()
    );
    assert!(std::env::var_os("HUB_C3_TEST_PEER").is_some());
    let newer: Value = serde_json::from_slice(
        &std::fs::read(
            desktop.join("artifacts/architecture-v5-report-entry-20261028/candidate-freeze.json"),
        )
        .unwrap(),
    )
    .unwrap();
    std::env::set_var(
        "HUB_C3_TEST_PEER",
        newer["binary"]["path"].as_str().unwrap(),
    );
    assert!(peer_override(&b).unwrap().is_some());
    let repaired: Value = serde_json::from_slice(
        &std::fs::read(
            desktop.join("artifacts/architecture-v5-manual-skill-20261028/candidate-freeze.json"),
        )
        .unwrap(),
    )
    .unwrap();
    std::env::set_var(
        "HUB_C3_TEST_PEER",
        repaired["binary"]["path"].as_str().unwrap(),
    );
    assert!(peer_override(&b).unwrap().is_some());
    std::env::set_var("HUB_C3_TEST_PEER", std::env::current_exe().unwrap());
    assert!(peer_override(&b).is_err());
    std::env::remove_var("HUB_C3_TEST_PEER");
}
fn spec() -> Value {
    json!([{"name":"hub_read","description":"controlled read","inputSchema":{"type":"object"}}])
}
fn call(id: u64, args: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":"hub_read","arguments":args}})
}
#[test]
fn mcp_exact_tool_set_replay_and_confirmed_stdout_flush_share_the_native_callback() {
    let control = Control::bounded(Duration::from_secs(5));
    let mut bridge = Bridge::new(&spec(), "controlled instructions", &control).unwrap();
    let mut events = Vec::new();
    let mut host = |kind: &str, v: &Value| {
        events.push((kind.to_string(), v.clone()));
        Ok(if kind == "tool" {
            json!({"result":"有出处的受控回执"})
        } else if kind == "toolReplay" {
            v["result"].clone()
        } else {
            Value::Null
        })
    };
    assert!(bridge
        .handle(&call(4, json!({"limit":1})), &mut host)
        .is_err());
    bridge.enable();
    let first = bridge
        .handle(&call(4, json!({"limit":1})), &mut host)
        .unwrap();
    let again = bridge
        .handle(&call(4, json!({"limit":1})), &mut host)
        .unwrap();
    assert_eq!(first, again);
    assert!(bridge
        .handle(&call(4, json!({"limit":2})), &mut host)
        .is_err());
    let mut foreign = call(5, json!({}));
    foreign["params"]["name"] = json!("arbitraryUiWrite");
    assert!(bridge.handle(&foreign, &mut host).is_err());
    let mut receipt = json!({"jsonrpc":"2.0","method":"notifications/hubResponseFlushed","params":{"id":4,"sha256":"wrong","utf8Bytes":0}});
    assert!(bridge.handle(&receipt, &mut host).is_err());
    receipt["params"]["sha256"] = json!(format!(
        "{:x}",
        sha2::Sha256::digest(first.to_string().as_bytes())
    ));
    receipt["params"]["utf8Bytes"] = json!(first.to_string().len());
    bridge.handle(&receipt, &mut host).unwrap();
    drop(host);
    assert_eq!(events.iter().filter(|(k, _)| k == "tool").count(), 1);
    assert_eq!(events.iter().filter(|(k, _)| k == "toolReplay").count(), 1);
    let sent = &events
        .iter()
        .find(|(k, _)| k == "toolResponseSent")
        .unwrap()
        .1;
    assert_eq!(sent["transport"], "mcpStdio");
    assert!(!bridge.deliveries.contains_key("4"));
    assert!(events
        .iter()
        .filter(|(k, _)| k == "transportBytes")
        .all(|(_, v)| v["bytes"].as_u64().unwrap() > 0));
}
#[test]
fn mcp_setup_is_exact_and_never_dispatches_a_business_action() {
    let control = Control::bounded(Duration::from_secs(5));
    let mut bridge = Bridge::new(&spec(), "bounded setup", &control).unwrap();
    let mut counts = 0;
    let mut host = |kind: &str, _: &Value| {
        assert_eq!(kind, "transportBytes");
        counts += 1;
        Ok(Value::Null)
    };
    let value = bridge
        .handle(
            &json!({"jsonrpc":"2.0","id":"tools","method":"tools/list"}),
            &mut host,
        )
        .unwrap();
    assert_eq!(value["result"]["tools"][0]["name"], "hub_read");
    assert_eq!(
        value["result"]["tools"][0]["inputSchema"],
        spec()[0]["inputSchema"]
    );
    let init = bridge
        .handle(
            &json!({"jsonrpc":"2.0","id":1,"method":"initialize"}),
            &mut host,
        )
        .unwrap();
    assert_eq!(init["result"]["instructions"], "bounded setup");
    assert_eq!(counts, 2);
}
#[test]
fn mcp_real_loopback_auth_failure_and_cancel_cannot_dispatch_or_hang_shutdown() {
    let control = Control::bounded(Duration::from_secs(5));
    let mut bridge = Bridge::new(&spec(), "", &control).unwrap();
    let mut stream = TcpStream::connect(&bridge.address).unwrap();
    send(
        &mut stream,
        &json!({"secret":"wrong","request":call(1,json!({}))}),
    )
    .unwrap();
    let until = Instant::now() + Duration::from_secs(2);
    let error = loop {
        match bridge.poll(&mut |_, _| panic!("not authorized")) {
            Err(e) => break e,
            Ok(()) => {
                assert!(Instant::now() < until);
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    };
    assert!(error.contains("身份"));
    drop(bridge);
    let control = Control::bounded(Duration::from_secs(5));
    let bridge = Bridge::new(&spec(), "", &control).unwrap();
    let _socket = TcpStream::connect(&bridge.address).unwrap();
    let start = Instant::now();
    control.cancel();
    drop(bridge);
    assert!(start.elapsed() < Duration::from_secs(1));
}
#[test]
fn mcp_frame_bounds_and_protocol_budget_rejection_prevent_a_sent_receipt() {
    let control = Control::bounded(Duration::from_secs(5));
    let stop = AtomicBool::new(false);
    assert!(line(
        &mut std::io::Cursor::new(vec![b'x'; LIMIT + 1]),
        &control,
        &stop
    )
    .is_err());
    assert!(line(&mut std::io::Cursor::new(b"{bad}\n"), &control, &stop).is_err());
    assert!(line(
        &mut std::io::Cursor::new(b"{\"jsonrpc\":\"2.0\"}"),
        &control,
        &stop
    )
    .is_err());
    let mut b = Bridge::new(&spec(), "", &control).unwrap();
    b.enable();
    let mut calls = 0;
    let result = b.handle(&call(2, json!({})), &mut |kind, _| {
        if kind == "tool" {
            calls += 1;
            Ok(json!({"data":"stored before stop"}))
        } else if kind == "transportBytes" {
            Err("same cumulative budget exhausted".into())
        } else {
            panic!("must not acknowledge a failed send")
        }
    });
    assert!(result.unwrap_err().contains("budget exhausted"));
    assert_eq!(calls, 1);
}
#[test]
fn mcp_cannot_resume_an_old_thread_before_any_process_or_provider_call() {
    let c = Control::bounded(Duration::from_secs(5));
    let error = super::super::run(
        Request {
            directory: Path::new("does-not-exist"),
            authentication_identity: "transport-must-reject-before-authentication",
            auth_root: None,
            auth_selection: None,
            thread: Some("old-thread"),
            instructions: "",
            image_input: &[],
            input: "",
            tools: spec(),
            compact_before_turn: false,
            external_mcp: true,
            web_search: Default::default(),
        },
        "",
        "",
        false,
        &c,
        |_, _| panic!("no callback before denial"),
    )
    .unwrap_err();
    assert!(error.contains("新上下文"));
}
#[test]
fn mcp_real_loopback_returns_exact_protocol_results_and_records_no_implicit_model_or_database_work()
{
    let c = Control::bounded(Duration::from_secs(5));
    let mut b = Bridge::new(&spec(), "local only", &c).unwrap();
    b.enable();
    let addr = b.address.clone();
    let key = b.secret.clone();
    let (tx, rx) = mpsc::sync_channel(1);
    let (release, wait) = mpsc::sync_channel(1);
    let worker = std::thread::spawn(move || {
        let mut s = TcpStream::connect(addr).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let mut r = BufReader::new(s.try_clone().unwrap());
        send(
            &mut s,
            &json!({"secret":key,"request":call(7,json!({"scope":"frozen"}))}),
        )
        .unwrap();
        let value = line(
            &mut r,
            &Control::bounded(Duration::from_secs(3)),
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
        tx.send(value).unwrap();
        wait.recv_timeout(Duration::from_secs(2)).unwrap();
    });
    let until = Instant::now() + Duration::from_secs(3);
    let mut calls = 0;
    let result = loop {
        if let Ok(value) = rx.try_recv() {
            break value;
        }
        b.poll(&mut |kind, v| {
            if kind == "tool" {
                calls += 1;
                assert_eq!(v["arguments"]["scope"], "frozen");
                Ok(json!({"retained":true}))
            } else {
                assert_eq!(kind, "transportBytes");
                Ok(Value::Null)
            }
        })
        .unwrap();
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(5));
    };
    release.send(()).unwrap();
    worker.join().unwrap();
    assert_eq!(result["id"], 7);
    assert_eq!(
        serde_json::from_str::<Value>(result["result"]["content"][0]["text"].as_str().unwrap())
            .unwrap(),
        json!({"retained":true})
    );
    assert_eq!(calls, 1);
}

#[test]
fn mcp_setup_estimate_uses_the_actual_serializers_and_keeps_protocol_and_instructions_visible() {
    let c = Control::bounded(Duration::from_secs(5));
    let tools = spec();
    let instruction = "合成指令\\\"";
    let estimate = startup_bytes(&tools, instruction).unwrap();
    for id in [json!(1), json!("i".repeat(126))] {
        let mut b = Bridge::new(&tools, instruction, &c).unwrap();
        let (mut total, mut repeat) = (0, 0);
        for method in ["initialize", "tools/list"] {
            let response = b
                .handle(
                    &json!({"jsonrpc":"2.0","id":id,"method":method}),
                    &mut |kind, v| {
                        assert_eq!(kind, "transportBytes");
                        total += v["bytes"].as_u64().unwrap() as usize;
                        repeat += v["instructionBytes"].as_u64().unwrap_or(0) as usize;
                        Ok(Value::Null)
                    },
                )
                .unwrap();
            if method == "initialize" {
                assert_eq!(
                    response["result"]["protocolVersion"],
                    crate::MCP_PROTOCOL_VERSION
                );
            }
        }
        assert_eq!(repeat, instruction.len());
        assert!(estimate >= total);
        if id.is_string() {
            assert_eq!(estimate, total);
        }
    }
}
