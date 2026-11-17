use super::*;
#[test]
fn browser_scopes_are_explicit_public_origins_and_never_script_or_file_tools() {
    for server in [
        "browser:",
        "browser:http://example.com",
        "browser:https://localhost",
        "browser:https://127.0.0.1",
        "browser:https://example.com/path",
        "browser:https://example.com?key=x",
        "browser:https://a.example|https://a.example",
    ] {
        assert!(origins(server).is_err(), "{server}");
    }
    let mut grant = Grant {
        server: "browser:https://developers.openai.com".into(),
        catalog_sha256: "a".repeat(64),
        tools: vec!["browser_snapshot".into()],
        trusted_read_only: false,
        resource_uris: vec![],
        app_binding: None,
    };
    validate(&grant).unwrap();
    for tool in [
        "browser_evaluate",
        "browser_run_code",
        "browser_file_upload",
        "browser_install",
        "browser_network_request",
    ] {
        grant.tools = vec![tool.into()];
        assert!(validate(&grant).is_err());
    }
}
#[test]
#[ignore = "requires explicit daily data root and existing Edge/Chrome; reads a URL already present in a real daily note"]
fn issue14_native_browser_real_daily_source() {
    let root = PathBuf::from(
        std::env::var_os("HUB_NATIVE_ACCEPTANCE_ROOT").expect("explicit daily data root"),
    );
    let c = crate::source_evidence::open_read_database(&root).unwrap();
    let markdown:String=c.query_row("SELECT markdown FROM documents WHERE markdown LIKE '%https://developers.openai.com/plugins/concepts/skills%' LIMIT 1",[],|r|r.get(0)).expect("actual daily-library source, no synthetic content");
    let url = "https://developers.openai.com/plugins/concepts/skills";
    assert!(markdown.contains(url));
    drop(c);
    let control = Control::bounded(Duration::from_secs(180));
    prepare(&root, &control).unwrap();
    let server = "browser:https://developers.openai.com";
    let catalog = discover(&root, server, &control).unwrap();
    let grant = Grant {
        server: server.into(),
        catalog_sha256: catalog["catalogSha256"].as_str().unwrap().into(),
        tools: TOOLS.iter().map(|s| s.to_string()).collect(),
        trusted_read_only: false,
        resource_uris: vec![],
        app_binding: None,
    };
    let mut runtime = super::super::Runtime::default();
    runtime
        .call(
            &root,
            None,
            &grant,
            "browser_navigate",
            &json!({"url":url}),
            &control,
            || Ok(()),
        )
        .unwrap();
    let snapshot = runtime
        .call(
            &root,
            None,
            &grant,
            "browser_snapshot",
            &json!({}),
            &control,
            || Ok(()),
        )
        .unwrap();
    let text = snapshot["content"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|c| c["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(text.contains("Skills"));
    assert!(text.contains("[ref="));
    assert_eq!(snapshot["sourceRefs"][0]["url"], url);
    // An authorized open tab without a snapshot must not become read evidence.
    runtime
        .call(
            &root,
            None,
            &grant,
            "browser_tabs",
            &json!({"action":"new"}),
            &control,
            || Ok(()),
        )
        .unwrap();
    runtime
        .call(
            &root,
            None,
            &grant,
            "browser_navigate",
            &json!({"url":"https://developers.openai.com/plugins"}),
            &control,
            || Ok(()),
        )
        .unwrap();
    let second = runtime
        .call(
            &root,
            None,
            &grant,
            "browser_snapshot",
            &json!({}),
            &control,
            || Ok(()),
        )
        .unwrap();
    assert_eq!(second["sourceRefs"].as_array().unwrap().len(), 1);
    assert_ne!(second["sourceRefs"][0]["url"], url);
    runtime
        .call(
            &root,
            None,
            &grant,
            "browser_tabs",
            &json!({"action":"select","index":0}),
            &control,
            || Ok(()),
        )
        .unwrap();
    // Use an observed accessibility ref, not a guessed selector or test page.
    let line = text
        .lines()
        .find(|l| l.contains("link \"Overview\"") && l.contains("[ref="))
        .expect("real documentation navigation link");
    let target = line
        .split("[ref=")
        .nth(1)
        .unwrap()
        .split(']')
        .next()
        .unwrap();
    let clicked = runtime
        .call(
            &root,
            None,
            &grant,
            "browser_click",
            &json!({"target":target}),
            &control,
            || Ok(()),
        )
        .unwrap();
    assert!(clicked.to_string().contains("developers.openai.com"));
    let stale = runtime
        .call(
            &root,
            None,
            &grant,
            "browser_click",
            &json!({"target":"e999999"}),
            &control,
            || Ok(()),
        )
        .unwrap();
    assert!(stale["error"].is_string());
    assert!(runtime
        .call(
            &root,
            None,
            &grant,
            "browser_snapshot",
            &json!({}),
            &control,
            || Ok(())
        )
        .is_ok());
    assert!(runtime
        .call(
            &root,
            None,
            &grant,
            "browser_navigate",
            &json!({"url":"https://github.com"}),
            &control,
            || Ok(())
        )
        .is_err());
    assert!(runtime
        .call(
            &root,
            None,
            &grant,
            "browser_evaluate",
            &json!({"function":"() => document.cookie"}),
            &control,
            || Ok(())
        )
        .is_err());
    assert!(runtime
        .call(
            &root,
            None,
            &grant,
            "browser_snapshot",
            &json!({"filename":"C:/outside.txt"}),
            &control,
            || Ok(())
        )
        .is_err());
    assert!(runtime
        .call(
            &root,
            None,
            &grant,
            "browser_snapshot",
            &json!({}),
            &control,
            || Err("revoked-browser-grant".into())
        )
        .unwrap_err()
        .contains("revoked-browser-grant"));
    drop(runtime);
    println!("real daily source: navigation, inline snapshot, observed-ref click, exact scope, script/file denial, revocation and run-owned shutdown verified");
}
