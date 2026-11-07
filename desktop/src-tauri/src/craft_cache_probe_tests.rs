use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

// Operational acceptance of the normal renewal owner, deliberately separate
// from the read-only cache probe. No credential values are written to evidence.
#[test]
#[ignore = "requires explicit selected-library credential renewal authorization"]
fn live_recover_selected_craft_credential() {
    assert_eq!(
        std::env::var("HUB_LIVE_CRAFT_RECOVERY_CONFIRM").as_deref(),
        Ok("renew-existing-selected-library"),
        "explicit credential recovery gate is required"
    );
    assert!(!isolated_runtime::enabled());
    let root = PathBuf::from(
        std::env::var_os("HUB_LIVE_CRAFT_RECOVERY_ROOT").expect("dedicated root required"),
    );
    assert!(root.is_absolute() && root.join(".hub-isolated-runtime-v1").is_file());
    let library = std::env::var("HUB_LIVE_CRAFT_RECOVERY_LIBRARY").expect("exact library required");
    let document =
        std::env::var("HUB_LIVE_CRAFT_RECOVERY_DOCUMENT").expect("exact document required");
    let c = Connection::open_with_flags(
        root.join("craft-search.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let bound: bool = c
        .query_row(
            "SELECT (SELECT count(*) FROM libraries)=1 AND (SELECT count(*) FROM documents)=1
        AND EXISTS(SELECT 1 FROM libraries WHERE id=?1 AND provider='craft')
        AND EXISTS(SELECT 1 FROM documents WHERE space_id=?1 AND id=?2)",
            params![library, document],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        bound,
        "recovery must use the selected isolated page's Craft library"
    );
    drop(c);
    tauri::async_runtime::block_on(async {
        let mut credential = load_credential(&library)
            .map_err(|_| "REPAIR_CREDENTIAL_UNAVAILABLE")
            .unwrap();
        let fresh_before = credential_access_token_is_fresh(&credential);
        assert!(
            fresh_before || credential.refresh_token.is_some(),
            "REPAIR_REAUTH_REQUIRED"
        );
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(25))
            .build()
            .unwrap();
        let result = tokio::time::timeout(
            Duration::from_secs(60),
            restore_credential_access_token(&client, &library, &mut credential),
        )
        .await;
        let token = match result {
            Ok(Ok(token)) => token,
            Ok(Err(error)) => {
                let code =
                    if error.contains("400") || error.contains("401") || error.contains("403") {
                        "REPAIR_REFRESH_REJECTED"
                    } else {
                        "REPAIR_REFRESH_FAILED"
                    };
                panic!("{code}");
            }
            Err(_) => panic!("REPAIR_DEADLINE"),
        };
        let saved = load_credential(&library)
            .map_err(|_| "REPAIR_READBACK_FAILED")
            .unwrap();
        assert!(
            credential_access_token_is_fresh(&saved),
            "REPAIR_FRESHNESS_FAILED"
        );
        assert_eq!(
            saved.access_token.as_deref() == Some(token.as_str()),
            true,
            "REPAIR_PUBLICATION_FAILED"
        );
        println!(
            "{}",
            json!({"success":true,"freshBefore":fresh_before,"freshAfter":true,
            "existingRefreshOwner":true,"credentialExported":false,"personalDatabaseWritten":false,
            "cloudSourceWritten":false})
        );
    });
}

#[test]
#[ignore = "requires explicit single-page live schema inspection"]
fn live_inspect_selected_craft_attachment_metadata() {
    assert_eq!(
        std::env::var("HUB_LIVE_CRAFT_RECOVERY_CONFIRM").as_deref(),
        Ok("inspect-selected-page")
    );
    assert!(!isolated_runtime::enabled());
    let root = PathBuf::from(
        std::env::var_os("HUB_LIVE_CRAFT_RECOVERY_ROOT").expect("dedicated root required"),
    );
    assert!(root.is_absolute() && root.join(".hub-isolated-runtime-v1").is_file());
    let library = std::env::var("HUB_LIVE_CRAFT_RECOVERY_LIBRARY").expect("exact library required");
    let document =
        std::env::var("HUB_LIVE_CRAFT_RECOVERY_DOCUMENT").expect("exact document required");
    let c = Connection::open_with_flags(
        root.join("craft-search.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM documents WHERE space_id=?1 AND id=?2",
            params![library, document],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    let block: String = c.query_row("SELECT json_extract(metadata_json,'$.blockId') FROM source_items WHERE source_type='craft_attachment'", [], |r|r.get(0)).unwrap();
    drop(c);
    tauri::async_runtime::block_on(async {
        let saved = load_credential(&library)
            .map_err(|_| "INSPECT_CREDENTIAL_UNAVAILABLE")
            .unwrap();
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(25))
            .build()
            .unwrap();
        let budget = Arc::new(MetadataBudget {
            received: AtomicU64::new(0),
            maximum: MAX_METADATA,
        });
        let result = METADATA.scope(budget.clone(), tokio::time::timeout(Duration::from_secs(60), async {
            let connection = initialize_authenticated_connection(&client, &saved.mcp_url, fresh_token(&saved)?).await?;
            if connection.session.space_id != library { return Err("INSPECT_SCOPE".to_string()); }
            let pages = read_craft_block_pages(&client, &connection.session,
                &format!("blocks get {document} --depth -1 --format json --fetchMetadata"), 700).await?;
            let mut shapes = Vec::new();
            fn visit(value: &Value, block: &str, shapes: &mut Vec<Value>) {
                match value {
                    Value::Object(map) => {
                        if map.get("id").or_else(||map.get("blockId")).and_then(Value::as_str) == Some(block) {
                            let metadata_keys = map.get("metadata").and_then(Value::as_object).map(|v|v.keys().cloned().collect::<Vec<_>>());
                            let revision = map.get("metadata").and_then(|v|v.get("lastModifiedAt"));
                            shapes.push(json!({"keys":map.keys().collect::<Vec<_>>(),"blockType":map.get("type"),
                                "metadataKeys":metadata_keys,"revisionPresent":revision.is_some(),
                                "revisionType":revision.map(|v|if v.is_string(){"string"}else if v.is_number(){"number"}else{"other"}),
                                "hasMarkdown":map.get("markdown").is_some(),"hasUrl":map.get("url").is_some()}));
                        }
                        for child in map.values() { visit(child,block,shapes); }
                    }
                    Value::Array(items) => for item in items { visit(item,block,shapes); },
                    _ => {}
                }
            }
            let mut attachments = Vec::new();
            let mut remote_blob = None;
            for page in pages {
                let parsed = parse_tool_json(&page).unwrap_or(page);
                visit(&parsed, &block, &mut shapes);
                let discovered = discover_attachments_from_json(&parsed);
                if std::env::var("HUB_LIVE_CRAFT_INSPECT_ORIGINAL").as_deref() == Ok("one-get-3mib") {
                    for a in discovered.iter().filter(|a|a.block_id.as_deref()==Some(block.as_str())) {
                        if remote_blob.is_some() { return Err("INSPECT_ORIGINAL_SCOPE".into()); }
                        let store = BlobStore::open(&root.join("inspect-blobs"))?;
                        let blob = download_source_to_blob_with_limit(&client,&store,Url::parse(&a.url).map_err(|_|"INSPECT_URL")?,None,None,None,MAX_BLOBS).await.map_err(|_|"INSPECT_GET_FAILED")?;
                        let bytes = store.read(&blob.blob.hash)?;
                        let kind=if bytes.starts_with(b"\x89PNG"){"png"}else if bytes.starts_with(b"%PDF"){"pdf"}else if serde_json::from_slice::<Value>(&bytes).is_ok(){"json"}else{"other"};
                        remote_blob=Some(json!({"sha256":blob.blob.hash,"bytes":blob.blob.size,"mime":blob.mime_type,"kind":kind,"gets":1}));
                    }
                }
                attachments.extend(discovered.into_iter().map(|a|json!({
                    "exactBlock":a.block_id_exact,"matchesSelectedBlock":a.block_id.as_deref()==Some(block.as_str()),
                    "revisionPresent":a.resource_revision.is_some(),"size":a.size,"kind":a.link_kind})));
            }
            Ok::<_,String>(json!({"shapes":shapes,"attachments":attachments,"remoteBlob":remote_blob}))
        })).await;
        let mut safe = result
            .map_err(|_| "INSPECT_DEADLINE")
            .unwrap()
            .map_err(|_| "INSPECT_REMOTE_FAILED")
            .unwrap();
        safe["metadataBytes"] = json!(budget.received.load(Ordering::Relaxed));
        println!("{safe}");
    });
}

#[test]
fn attachment_traffic_probe_expired_or_unknown_token_cannot_use_refresh_credentials() {
    assert!(
        isolated_runtime::require_craft_probe("library", "doc").is_err(),
        "general isolated entry cannot read personal credentials"
    );
    let mut value = StoredCredential {
        mcp_url: "https://example.invalid/mcp".into(),
        resource: String::new(),
        token_endpoint: String::new(),
        client_id: String::new(),
        client_secret: None,
        refresh_token: Some("owned-unused-refresh".into()),
        access_token: Some("owned-access".into()),
        expires_at: Some(now_timestamp() - 1),
    };
    assert_eq!(fresh_token(&value).unwrap_err(), "PROBE_AUTH_NOT_FRESH");
    value.expires_at = None;
    assert_eq!(fresh_token(&value).unwrap_err(), "PROBE_AUTH_NOT_FRESH");
    value.expires_at = Some(now_timestamp() + 600);
    assert_eq!(fresh_token(&value).unwrap(), "owned-access");
    assert_eq!(
        safe_error("PROBE_FAKE secret-valued-url"),
        "PROBE_OPERATION_FAILED"
    );
}

struct Server {
    url: String,
    requests: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}

#[tokio::test]
async fn original_transfer_scope_limits_aggregate_bytes_and_requests_without_affecting_normal_downloads(
) {
    assert!(!requires_fresh_original());
    assert_eq!(
        attachment_get_limit(100 * MAX_BLOBS).unwrap(),
        100 * MAX_BLOBS
    );
    let denied = Arc::new(TransferBudget {
        allowed: false,
        gets: AtomicUsize::new(0),
        received: AtomicU64::new(0),
    });
    TRANSFERS
        .scope(denied.clone(), async {
            assert_eq!(
                attachment_get_limit(MAX_BLOBS).unwrap_err(),
                "PROBE_TRANSFER_LIMIT"
            );
        })
        .await;
    assert_eq!(denied.gets.load(Ordering::Relaxed), 0);
    let allowed = Arc::new(TransferBudget {
        allowed: true,
        gets: AtomicUsize::new(0),
        received: AtomicU64::new(0),
    });
    TRANSFERS
        .scope(allowed.clone(), async {
            assert!(requires_fresh_original());
            assert_eq!(attachment_get_limit(100 * MAX_BLOBS).unwrap(), MAX_BLOBS);
            attachment_bytes(100).unwrap();
            assert_eq!(attachment_get_limit(MAX_BLOBS).unwrap(), MAX_BLOBS - 100);
            assert_eq!(attachment_get_limit(MAX_BLOBS).unwrap(), MAX_BLOBS - 100);
            assert!(attachment_get_limit(MAX_BLOBS).is_err());
            assert!(attachment_bytes(MAX_BLOBS as usize).is_err());
        })
        .await;
    assert_eq!(allowed.gets.load(Ordering::Relaxed), 3);
    assert_eq!(
        attachment_get_limit(100 * MAX_BLOBS).unwrap(),
        100 * MAX_BLOBS
    );
}

#[test]
fn text_only_probe_accepts_zero_attachments_but_never_hides_an_uncached_attachment() {
    let root = std::env::temp_dir().join(format!("hub-text-probe-{}", random_url_safe(16)));
    fs::create_dir(&root).unwrap();
    let db = root.join("craft-search.sqlite3");
    let store = BlobStore::open(&root.join("blobs-v1")).unwrap();
    let c = open_database(&db).unwrap();
    c.execute("INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES('library','craft','Owned',1,1)", []).unwrap();
    drop(c);
    for with_attachment in [false, true] {
        let markdown = if with_attachment {
            "![Owned](https://r.craft.do/owned-image)"
        } else {
            "Owned note without attachments"
        }
        .to_string();
        let attachments = discover_attachments(&markdown);
        persist_document_batch(
            &db,
            &store,
            vec![IndexedDocument {
                space_id: "library".into(),
                id: "doc".into(),
                title: "Owned".into(),
                path: "Owned".into(),
                folder_id: None,
                content_hash: format!("{:x}", Sha256::digest(markdown.as_bytes())),
                markdown,
                modified_at: None,
                indexed_at: 1,
                attachments,
                block_hints: Vec::new(),
            }],
        )
        .unwrap();
        let actual = originals(&db, &store, "library", "doc");
        if with_attachment {
            assert_eq!(
                scoped_sources(&db, "library", "doc").unwrap().len(),
                1,
                "fresh reads keep the exact source inventory when bytes are missing"
            );
            assert_eq!(actual.unwrap_err(), "PROBE_ORIGINAL_MISSING");
        } else {
            assert!(actual.unwrap().is_empty());
        }
    }
    forget_initialized_database(&db);
    fs::remove_dir_all(root).unwrap();
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn server(chunked: bool) -> Server {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    let requests = Arc::new(AtomicUsize::new(0));
    let count = requests.clone();
    let task = tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            let mut input = Vec::new();
            let mut buffer = [0; 4096];
            let header_end = loop {
                let n = socket.read(&mut buffer).await.unwrap();
                if n == 0 {
                    break 0;
                }
                input.extend_from_slice(&buffer[..n]);
                if let Some(p) = input.windows(4).position(|v| v == b"\r\n\r\n") {
                    break p + 4;
                }
            };
            if header_end == 0 {
                continue;
            }
            let size = String::from_utf8_lossy(&input[..header_end])
                .lines()
                .find_map(|line| {
                    let (key, value) = line.split_once(':')?;
                    key.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or(0);
            while input.len() < header_end + size {
                let n = socket.read(&mut buffer).await.unwrap();
                if n == 0 {
                    break;
                }
                input.extend_from_slice(&buffer[..n]);
            }
            let request = count.fetch_add(1, Ordering::Relaxed) + 1;
            let body = if chunked {
                "x".repeat(1024)
            } else {
                json!({"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"owned page"}],"nextCursor":format!("cursor-{request}")}}).to_string()
            };
            let response = if chunked {
                format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{}\r\n0\r\n\r\n",body.len(),body)
            } else {
                format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body)
            };
            let _ = socket.write_all(response.as_bytes()).await;
        }
    });
    Server {
        url,
        requests,
        task,
    }
}
fn session(endpoint: String) -> McpSession {
    McpSession {
        space_id: "owned".into(),
        space_name: "Owned".into(),
        endpoint,
        access_token: "owned-fixture".into(),
        session_id: None,
        protocol_version: MCP_PROTOCOL_VERSION.into(),
        deep_link_template: None,
        rate_limiter: Arc::new(CraftRateLimiter::default()),
    }
}

// Real HTTP responses exercise the original MCP transport and retry owner.
async fn diagnostic_server(replies: Vec<(u16, &'static str, u64)>) -> Server {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    let requests = Arc::new(AtomicUsize::new(0));
    let count = requests.clone();
    let task = tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            let mut input = Vec::new();
            let mut buffer = [0; 4096];
            let header_end = loop {
                let n = socket.read(&mut buffer).await.unwrap_or(0);
                if n == 0 {
                    break 0;
                }
                input.extend_from_slice(&buffer[..n]);
                if let Some(p) = input.windows(4).position(|v| v == b"\r\n\r\n") {
                    break p + 4;
                }
            };
            if header_end == 0 {
                continue;
            }
            let size = String::from_utf8_lossy(&input[..header_end])
                .lines()
                .find_map(|line| {
                    let (key, value) = line.split_once(':')?;
                    key.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or(0);
            while input.len() < header_end + size {
                let n = socket.read(&mut buffer).await.unwrap_or(0);
                if n == 0 {
                    break;
                }
                input.extend_from_slice(&buffer[..n]);
            }
            let index = count.fetch_add(1, Ordering::Relaxed);
            let (status, body, delay) = replies[index.min(replies.len() - 1)];
            if delay > 0 {
                tokio::time::sleep(Duration::from_millis(delay)).await;
            }
            let response = format!("HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            let _ = socket.write_all(response.as_bytes()).await;
        }
    });
    Server {
        url,
        requests,
        task,
    }
}

#[tokio::test]
async fn mcp_read_recovers_actual_gateway_status_and_records_each_attempt() {
    let remote = diagnostic_server(vec![
        (502, "private gateway response", 0),
        (
            200,
            r#"{"result":{"content":[{"type":"text","text":"owned"}]}}"#,
            0,
        ),
    ])
    .await;
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    let trace = diagnostics::Trace::new();
    let value = diagnostics::TRACE
        .scope(
            trace.clone(),
            call_craft_read_raw(
                &client,
                &session(remote.url.clone()),
                "blocks get owned --format markdown",
                100,
            ),
        )
        .await;
    assert!(
        value.is_ok(),
        "a read-only 502 response must use the existing bounded recovery owner"
    );
    assert_eq!(remote.requests.load(Ordering::Relaxed), 2);
    let facts = trace.snapshot();
    assert_eq!(facts["requests"][0]["httpStatus"], 502);
    assert_eq!(facts["requests"][0]["outcome"], "httpError");
    assert_eq!(facts["requests"][1]["outcome"], "completed");
    assert!(!facts.to_string().contains("private gateway"));
}

#[tokio::test]
async fn mcp_probe_diagnostics_distinguish_http_parse_rpc_and_tool_without_payloads() {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    for (status, body, expected) in [
        (403, "secret https://private.invalid/token", "httpError"),
        (200, "malformed private response", "responseParse"),
        (
            200,
            r#"{"error":{"code":-1,"message":"private rpc message"}}"#,
            "rpcError",
        ),
        (
            200,
            r#"{"result":{"isError":true,"content":[{"text":"private tool message"}]}}"#,
            "toolError",
        ),
    ] {
        let remote = diagnostic_server(vec![(status, body, 0)]).await;
        let trace = diagnostics::Trace::new();
        let _ = diagnostics::TRACE.scope(trace.clone(), mcp_post(&client, &remote.url, "private bearer", None,
            MCP_PROTOCOL_VERSION, &json!({"method":"tools/call","id":100,"params":{"name":"craft_read","arguments":{"command":"blocks get private-note --format markdown"}}}))).await;
        let facts = trace.snapshot();
        assert_eq!(facts["requests"][0]["httpStatus"], status);
        assert_eq!(facts["requests"][0]["outcome"], expected);
        assert!(!facts.to_string().contains("private"));
    }
}

#[tokio::test]
async fn mcp_probe_deadlines_preserve_partial_rounds_and_distinguish_request_timeout() {
    for outer_deadline in [false, true] {
        let remote = diagnostic_server(vec![(200, "{}", 1000)]).await;
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_millis(if outer_deadline {
                2000
            } else {
                30
            }))
            .build()
            .unwrap();
        let trace = diagnostics::Trace::new();
        diagnostics::TRACE
            .scope(trace.clone(), async {
                diagnostics::completed_round();
                diagnostics::phase("fetchPage", 2);
                let payload = json!({"method":"tools/call","id":110});
                let request = mcp_post(
                    &client,
                    &remote.url,
                    "secret",
                    None,
                    MCP_PROTOCOL_VERSION,
                    &payload,
                );
                if outer_deadline {
                    assert!(tokio::time::timeout(Duration::from_millis(30), request)
                        .await
                        .is_err());
                } else {
                    assert!(request.await.is_err());
                }
            })
            .await;
        let facts = trace.snapshot();
        assert_eq!(facts["completedRounds"], 1);
        assert_eq!(facts["round"], 2);
        assert_eq!(
            facts["requests"][0]["outcome"],
            if outer_deadline {
                "interrupted"
            } else {
                "timeout"
            }
        );
        assert_eq!(remote.requests.load(Ordering::Relaxed), 1);
    }
}

#[tokio::test]
async fn mcp_recovery_never_uses_http_error_body_as_permission_to_replay() {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    let denied = diagnostic_server(vec![(401, "connection reset timeout", 0)]).await;
    assert!(
        call_craft_read_raw(&client, &session(denied.url.clone()), "connection info", 3)
            .await
            .is_err()
    );
    assert_eq!(
        denied.requests.load(Ordering::Relaxed),
        1,
        "HTTP status takes precedence over untrusted error text"
    );
    let write = diagnostic_server(vec![(502, "gateway", 0)]).await;
    assert!(call_craft_tool_raw(
        &client,
        &session(write.url.clone()),
        "craft_write",
        json!({"command":"blocks update owned --content changed"}),
        4
    )
    .await
    .is_err());
    assert_eq!(
        write.requests.load(Ordering::Relaxed),
        1,
        "a business write must never inherit read recovery"
    );
}

#[tokio::test]
async fn mcp_probe_observation_is_bounded_and_inactive_outside_its_task_scope() {
    let trace = diagnostics::Trace::new();
    drop(McpRequestObservation::begin(
        &json!({"method":"initialize"}),
    ));
    assert_eq!(trace.snapshot()["requestCount"], 0);
    diagnostics::TRACE
        .scope(trace.clone(), async {
            for _ in 0..70 {
                drop(McpRequestObservation::begin(
                    &json!({"method":"private-method","secret":"private-value"}),
                ));
            }
        })
        .await;
    let facts = trace.snapshot();
    assert_eq!(facts["requestCount"], 70);
    assert_eq!(facts["requests"].as_array().unwrap().len(), 64);
    assert_eq!(facts["requestsTruncated"], true);
    assert!(!facts.to_string().contains("private"));
}

#[tokio::test]
async fn attachment_traffic_probe_uses_actual_mcp_stream_limit_and_two_page_transport_cap() {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap();
    let large = server(true).await;
    let budget = Arc::new(MetadataBudget {
        received: AtomicU64::new(0),
        maximum: 128,
    });
    let result = METADATA
        .scope(
            budget.clone(),
            mcp_post(
                &client,
                &large.url,
                "owned-fixture",
                None,
                MCP_PROTOCOL_VERSION,
                &json!({"method":"initialize"}),
            ),
        )
        .await;
    assert_eq!(result.unwrap_err(), "PROBE_METADATA_LIMIT");
    assert_eq!(large.requests.load(Ordering::Relaxed), 1);
    let pages = server(false).await;
    let s = session(pages.url.clone());
    let budget = Arc::new(MetadataBudget {
        received: AtomicU64::new(0),
        maximum: MAX_METADATA,
    });
    let result = METADATA
        .scope(
            budget,
            read_craft_block_pages(&client, &s, "blocks get owned --format json", 1),
        )
        .await;
    assert_eq!(result.unwrap_err(), "PROBE_PAGE_LIMIT");
    assert_eq!(pages.requests.load(Ordering::Relaxed), 2);
    assert_eq!(
        page_limit(),
        1_000,
        "normal production pagination contract stays intact"
    );
}

#[tokio::test]
async fn attachment_traffic_probe_cache_miss_never_admits_an_attachment_get() {
    let root = std::env::temp_dir().join(format!("hub-cache-probe-worker-{}", random_url_safe(16)));
    fs::create_dir(&root).unwrap();
    let db = root.join("craft-search.sqlite3");
    let store = BlobStore::open(&root.join("blobs-v1")).unwrap();
    let remote = server(false).await;
    let c = open_database(&db).unwrap();
    c.execute("INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES('library','craft','Owned',1,1)",[]).unwrap();
    drop(c);
    let markdown = "![Owned](https://r.craft.do/cache-probe-fixture.png)".to_string();
    let attachments = discover_attachments(&markdown);
    persist_document_batch(
        &db,
        &store,
        vec![IndexedDocument {
            space_id: "library".into(),
            id: "doc".into(),
            title: "Owned".into(),
            path: "Owned".into(),
            folder_id: None,
            content_hash: format!("{:x}", Sha256::digest(markdown.as_bytes())),
            markdown,
            modified_at: None,
            indexed_at: 1,
            attachments,
            block_hints: Vec::new(),
        }],
    )
    .unwrap();
    let job = claim_enabled_attachment_jobs(&db, "download_source", 1)
        .unwrap()
        .remove(0);
    let blob = store.put(b"owned").unwrap();
    let path = store.path_for(&blob.hash).unwrap();
    persist_download_success(
        &db,
        &job,
        DownloadedSource {
            blob,
            mime_type: "image/png".into(),
        },
    )
    .unwrap();
    assert_eq!(
        originals(&db, &store, "library", "doc").unwrap().len(),
        1,
        "formal document source does not count as an attachment"
    );
    let current = scoped_sources(&db, "library", "doc").unwrap();
    let mut c = open_database(&db).unwrap();
    reschedule_on(&mut c, "library", "doc", &current).unwrap();
    reschedule_on(&mut c, "library", "doc", &current).unwrap();
    drop(c);
    fs::remove_file(path).unwrap();
    let job = claim_enabled_attachment_jobs(&db, "download_source", 1)
        .unwrap()
        .remove(0);
    assert_eq!(
        reschedule_on(&mut open_database(&db).unwrap(), "library", "doc", &current).unwrap_err(),
        "PROBE_QUEUE_BUSY"
    );
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    assert_eq!(
        cache_only_job(&db, &store, &job, &client)
            .await
            .unwrap_err(),
        "PROBE_CACHE_MISS"
    );
    assert_eq!(remote.requests.load(Ordering::Relaxed), 0);
    forget_initialized_database(&db);
    assert_eq!(root.parent(), Some(std::env::temp_dir().as_path()));
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn original_verification_reads_remote_bytes_even_when_same_url_has_a_valid_local_cache() {
    let root = std::env::temp_dir().join(format!("hub-original-proof-{}", random_url_safe(16)));
    fs::create_dir(&root).unwrap();
    let db = root.join("craft-search.sqlite3");
    let store = BlobStore::open(&root.join("blobs-v1")).unwrap();
    let remote = server(true).await;
    let c = open_database(&db).unwrap();
    c.execute("INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES('library','craft','Owned',1,1)",[]).unwrap();
    drop(c);
    let markdown = "![Owned](https://r.craft.do/stable-but-unversioned)".to_string();
    persist_document_batch(
        &db,
        &store,
        vec![IndexedDocument {
            space_id: "library".into(),
            id: "doc".into(),
            title: "Owned".into(),
            path: "Owned".into(),
            folder_id: None,
            content_hash: format!("{:x}", Sha256::digest(markdown.as_bytes())),
            attachments: discover_attachments(&markdown),
            markdown,
            modified_at: None,
            indexed_at: 1,
            block_hints: Vec::new(),
        }],
    )
    .unwrap();
    let sources = scoped_sources(&db, "library", "doc").unwrap();
    assert_eq!(
        originals(&db, &store, "library", "doc").unwrap_err(),
        "PROBE_ORIGINAL_MISSING"
    );
    reschedule_on(&mut open_database(&db).unwrap(), "library", "doc", &sources).unwrap();
    let job = claim_enabled_attachment_jobs(&db, "download_source", 1)
        .unwrap()
        .remove(0);
    let old = store.put(b"old cached bytes").unwrap();
    let old_hash = old.hash.clone();
    persist_download_success(
        &db,
        &job,
        DownloadedSource {
            blob: old,
            mime_type: "image/png".into(),
        },
    )
    .unwrap();
    // Fixture intent only: the original claimant and downloader must produce
    // the completion and version binding; no result rows are fabricated.
    open_database(&db).unwrap().execute("UPDATE index_jobs SET status='pending',next_attempt_at=0,worker_id=NULL,locked_at=NULL,lease_until=NULL WHERE id=?1",[job.id]).unwrap();
    let job = claim_enabled_attachment_jobs(&db, "download_source", 1)
        .unwrap()
        .remove(0);
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap();
    let budget = Arc::new(TransferBudget {
        allowed: true,
        gets: AtomicUsize::new(0),
        received: AtomicU64::new(0),
    });
    TRANSFERS
        .scope(
            budget.clone(),
            process_download_job(&db, &store, &job, &client, None, |_, _| {
                Ok(Url::parse(&remote.url).unwrap())
            }),
        )
        .await
        .unwrap();
    assert_eq!(remote.requests.load(Ordering::Relaxed), 1);
    assert_eq!(budget.gets.load(Ordering::Relaxed), 1);
    assert_eq!(budget.received.load(Ordering::Relaxed), 1024);
    let current = originals(&db, &store, "library", "doc").unwrap();
    assert_ne!(current[0].1, old_hash);
    assert_eq!(
        current[0].1,
        format!("{:x}", Sha256::digest(vec![b'x'; 1024]))
    );
    assert_eq!(
        attachment_evidence::input_on(&open_database(&db).unwrap(), "library", &job.source_id)
            .unwrap()
            .blob_hash,
        current[0].1
    );
    forget_initialized_database(&db);
    assert_eq!(root.parent(), Some(std::env::temp_dir().as_path()));
    fs::remove_dir_all(root).unwrap();
}
