use super::*;
const URL: &str = "https://docs.example.org/mcp";
fn response(s: &Service) -> Value {
    json!({"data":[{"name":s.server,"runtimeStatus":"connected","httpOrigin":s.origin,"serverInfo":{"name":"Example","version":"1"},"authStatus":"unsupported","tools":{
        "lookup":{"name":"lookup","inputSchema":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]},"annotations":{"readOnlyHint":true,"destructiveHint":false}},
        "write":{"name":"write","inputSchema":{"type":"object"},"annotations":{"readOnlyHint":false,"destructiveHint":true}},
        "unknown":{"name":"unknown","inputSchema":{"type":"object"}},
        "catalog":{"name":"catalog","inputSchema":{"type":"object"},"annotations":{"readOnlyHint":true,"destructiveHint":false}}
    }}],"nextCursor":null})
}
fn grant(c: &Value) -> Grant {
    Grant {
        server: URL.into(),
        trusted_read_only: true,
        catalog_sha256: c["catalogSha256"].as_str().unwrap().into(),
        tools: vec!["lookup".into()],
        app_binding: None,
        resource_uris: vec![],
    }
}
#[test]
fn custom_mcp_endpoint_and_trust_are_explicit() {
    endpoint(URL).unwrap();
    for bad in [
        "http://docs.example.org/mcp",
        "https://127.0.0.1/mcp",
        "https://localhost/mcp",
        "https://docs.internal/mcp",
        "https://user:secret@docs.example.org/mcp",
        "https://docs.example.org:8443/mcp",
        "https://docs.example.org/mcp?token=no",
        "https://docs.example.org/mcp#x",
        "https://DOCS.example.org/mcp",
        ENDPOINT,
    ] {
        assert!(endpoint(bad).is_err(), "{bad}");
    }
    with_service(URL, |s| {
        assert!(s.server.starts_with("hub_remote_"));
        assert_eq!(s.origin, "https://docs.example.org");
        let c = catalog(s, &response(s))?;
        let mut g = grant(&c);
        validate(&[g.clone()])?;
        g.trusted_read_only = false;
        assert!(validate(&[g]).is_err());
        Ok(())
    })
    .unwrap();
    for name in [
        "",
        "catalog",
        "read_resource",
        "../../secret",
        "tool name",
        "工具",
    ] {
        assert!(!tool_name(name));
    }
}
#[test]
fn custom_mcp_selection_catalog_changes_and_revocation_fail_closed() {
    with_service(URL, |s| {
        let r = response(s);
        let c = catalog(s, &r)?;
        let g = grant(&c);
        assert_eq!(c["server"], URL);
        assert_eq!(c["blockedToolCount"], 3);
        assert_eq!(c["tools"].as_array().unwrap().len(), 1);
        authorize(&c, &g, "lookup", &json!({"query":"public docs"}))?;
        for (tool, args) in [
            ("write", json!({})),
            ("lookup", json!({"query":"public","secret":"no"})),
            ("lookup", json!({})),
        ] {
            assert!(authorize(&c, &g, tool, &args).is_err());
        }
        for pointer in [
            "/data/0/serverInfo/version",
            "/data/0/tools/lookup/description",
        ] {
            let mut changed = r.clone();
            if pointer.ends_with("description") {
                changed["data"][0]["tools"]["lookup"]["description"] = json!("changed");
            } else {
                *changed.pointer_mut(pointer).unwrap() = json!("changed");
            }
            assert!(authorize(
                &catalog(s, &changed)?,
                &g,
                "lookup",
                &json!({"query":"public"})
            )
            .is_err());
        }
        let mut changed = r.clone();
        changed["data"][0]["tools"]["lookup"]["annotations"]["readOnlyHint"] = json!(false);
        assert!(catalog(s, &changed).is_err());
        for (key, value) in [
            ("authStatus", "loggedIn"),
            ("httpOrigin", "https://elsewhere.example"),
            ("name", "wrong"),
        ] {
            let mut changed = r.clone();
            changed["data"][0][key] = json!(value);
            assert!(catalog(s, &changed).is_err());
        }
        assert_eq!(
            call(
                &g,
                "lookup",
                &json!({"query":"public"}),
                &Control::default(),
                || Err("revoked-custom".into())
            )
            .unwrap_err(),
            "revoked-custom"
        );
        assert_eq!(serde_json::from_value::<Grant>(json!(g)).unwrap(), g);
        Ok(())
    })
    .unwrap();
}
#[test]
#[ignore = "explicit new custom endpoint through official runtime; no model or personal credentials"]
fn custom_mcp_native_remote_roundtrip() {
    let endpoint = std::env::var("HUB_CUSTOM_MCP_ENDPOINT").unwrap();
    let path = std::env::var("HUB_CUSTOM_MCP_REPORT").unwrap();
    let tool = std::env::var("HUB_CUSTOM_MCP_TOOL").unwrap();
    let args: Value =
        serde_json::from_str(&std::env::var("HUB_CUSTOM_MCP_ARGUMENTS").unwrap()).unwrap();
    let control = Control::bounded(Duration::from_secs(90));
    let discovered = discover(&endpoint, &control);
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&json!({"discovery":discovered})).unwrap(),
    )
    .unwrap();
    let c = discovered.unwrap();
    let g = Grant {
        server: endpoint,
        trusted_read_only: true,
        catalog_sha256: c["catalogSha256"].as_str().unwrap().into(),
        tools: vec![tool.clone()],
        app_binding: None,
        resource_uris: vec![],
    };
    let result = call(&g, &tool, &args, &control, || Ok(()));
    std::fs::write(
        path,
        serde_json::to_vec_pretty(&json!({"catalog":c,"grant":g,"result":result})).unwrap(),
    )
    .unwrap();
    let result = result.unwrap();
    assert_eq!(result["readOnlyAssurance"], "trustedServiceDeclaration");
    assert!(result["businessWrites"].is_null());
    assert!(!result["content"].as_array().unwrap().is_empty());
}
