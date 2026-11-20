use super::*;
fn tool(name: &str, id: &str, link: &str, read: bool) -> Value {
    json!({"name":name,"description":"tool","_meta":{"connector_id":id,"link_id":link,"connector_name":"GitHub"},"inputSchema":{"type":"object","properties":{}},"annotations":{"readOnlyHint":read,"destructiveHint":false}})
}
fn response() -> Value {
    json!({"data":[{"name":"codex_apps","runtimeStatus":"connected","toolsError":null,"tools":{"github.fetch_issue":tool("github.fetch_issue","connector_git","one",true),"other.secret":tool("other.secret","connector_other","other-account",true),"github.write":tool("github.write","connector_git","one",false)}}],"nextCursor":null})
}
#[test]
fn gateway_catalog_is_not_a_grant_and_changes_in_connection_or_account_invalidate_it() {
    let response = response();
    let (catalog, _) = scoped_catalog(&response, "connector_git", "account-a").unwrap();
    assert_eq!(catalog["tools"].as_array().unwrap().len(), 1);
    assert!(!catalog.to_string().contains("other.secret"));
    assert!(!catalog.to_string().contains("other-account"));
    let grant = Grant {
        server: "app:connector_git".into(),
        catalog_sha256: catalog["catalogSha256"].as_str().unwrap().into(),
        tools: vec!["github.fetch_issue".into()],
        trusted_read_only: false,
        resource_uris: vec![],
        app_binding: Some(serde_json::from_value(catalog["appBinding"].clone()).unwrap()),
    };
    verify_binding(&catalog, &grant).unwrap();
    assert!(verify_binding(
        &scoped_catalog(&response, "connector_git", "account-b")
            .unwrap()
            .0,
        &grant
    )
    .is_err());
    let mut changed = response.clone();
    changed["data"][0]["tools"]["github.fetch_issue"]["_meta"]["link_id"] = json!("new-link");
    assert!(scoped_catalog(&changed, "connector_git", "account-a").is_err());
    let mut crossed = grant.clone();
    crossed.server = "https://example.com/mcp".into();
    assert!(super::super::validate(&[crossed]).is_err());
}
#[test]
fn only_the_verified_github_write_adapter_can_be_selected_and_needs_a_repository() {
    let id = connector(GITHUB).unwrap();
    let mut response = response();
    response["data"][0]["tools"] = json!({"github.add_comment_to_issue":tool(COMMENT,id,"one",false),"github.delete_repository":tool("github.delete_repository",id,"one",false)});
    let (catalog, _) = scoped_catalog(&response, id, "account").unwrap();
    assert_eq!(catalog["tools"].as_array().unwrap().len(), 1);
    let mut grant = Grant {
        server: GITHUB.into(),
        catalog_sha256: catalog["catalogSha256"].as_str().unwrap().into(),
        tools: vec![COMMENT.into()],
        trusted_read_only: false,
        resource_uris: vec![],
        app_binding: Some(serde_json::from_value(catalog["appBinding"].clone()).unwrap()),
    };
    assert!(validate(&grant).is_err());
    grant.app_binding.as_mut().unwrap().write_repository = Some("VondeSong/hub-search".into());
    validate(&grant).unwrap();
    verify_binding(&catalog, &grant).unwrap();
    grant.app_binding.as_mut().unwrap().write_repository = Some("../repo".into());
    assert!(validate(&grant).is_err());
}

#[test]
fn long_comment_threads_are_host_verification_data_and_do_not_expand_model_results() {
    let result = json!({"content":[{"type":"text","text":"Action completed."}],"structuredContent":{"comments":[{"body":"existing project progress\n".repeat(5000)}]},"isError":false});
    verification_result(&result).unwrap();
    assert!(super::super::validate_result(&result).is_err());
    let mut failed = result;
    failed["isError"] = json!(true);
    assert!(verification_result(&failed).is_err());
}

#[test]
fn comment_readback_requires_one_marker_with_exact_content_and_identity() {
    let repo = "VondeSong/hub-search";
    let marker = "<!-- hub-action:action-1 -->";
    let body = format!("验收记录\n\n{marker}");
    let comment = json!({"id":42,"url":format!("https://github.com/{repo}/issues/58#issuecomment-42"),"body":body});
    let verify = |comments| {
        verified_comment_receipt(
            &json!({"content":[],"structuredContent":{"comments":comments}}),
            repo,
            58,
            "action-1",
            marker,
            &body,
        )
    };
    assert_eq!(verify(vec![comment.clone()]).unwrap()["commentId"], 42);
    let mut edited = comment.clone();
    edited["body"] = json!(format!("其他正文\n\n{marker}"));
    assert!(verify(vec![edited.clone()]).unwrap_err().contains("正文"));
    assert!(verify(vec![comment.clone(), edited])
        .unwrap_err()
        .contains("相同动作标记"));
    let mut mismatched = comment.clone();
    mismatched["id"] = json!(43);
    assert!(verify(vec![mismatched]).unwrap_err().contains("身份"));
    let mut missing_id = comment;
    missing_id["id"] = Value::Null;
    assert!(verify(vec![missing_id]).unwrap_err().contains("有效编号"));
    assert!(verify(vec![]).unwrap_err().contains("结果未知"));
}

#[test]
#[ignore = "explicit daily root and existing verified action; uses the production read-only GitHub recovery path"]
fn real_github_comment_readback_reuses_verified_action_identity() {
    let root =
        PathBuf::from(std::env::var_os("HUB_NATIVE_ACCEPTANCE_ROOT").expect("daily data root"));
    let action = std::env::var("HUB_EXISTING_PLUGIN_ACTION").expect("existing verified action");
    let read = || {
        let c = crate::source_evidence::open_read_database(&root).unwrap();
        c.query_row(
            "SELECT payload_json,receipt_json FROM agent_actions WHERE id=?1 AND kind='pluginWrite' AND state='verified'",
            [&action],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        ).unwrap()
    };
    let (plan_text, receipt_text) = read();
    let plan: Value = serde_json::from_str(&plan_text).unwrap();
    let old: Value = serde_json::from_str(&receipt_text).unwrap();
    let result = comment_write(
        &root,
        &plan,
        &action,
        false,
        &Control::bounded(Duration::from_secs(120)),
        || Ok(()),
    )
    .unwrap();
    for field in ["actionId", "commentId", "url", "bodySha256", "verified"] {
        assert_eq!(result[field], old[field], "{field}");
    }
    assert_eq!(read(), (plan_text, receipt_text));
    println!(
        "Production GitHub readback confirmed one unchanged remote comment: {}",
        result["commentId"]
    );
}

#[test]
#[ignore = "requires explicit HUB_NATIVE_ACCEPTANCE_ROOT; reads current connected GitHub and the real project Issue, writes no sources"]
fn issue14_native_connected_apps_real_read() {
    let root = PathBuf::from(
        std::env::var_os("HUB_NATIVE_ACCEPTANCE_ROOT").expect("explicit daily data root"),
    );
    let control = Control::bounded(Duration::from_secs(120));
    let apps = list(&root, &control).unwrap();
    assert!(apps["apps"]
        .as_array()
        .unwrap()
        .iter()
        .any(|a| a["server"] == GITHUB));
    let catalog = discover(&root, GITHUB, &control).unwrap();
    let grant = Grant {
        server: GITHUB.into(),
        catalog_sha256: catalog["catalogSha256"].as_str().unwrap().into(),
        tools: vec!["github.fetch_issue".into()],
        trusted_read_only: false,
        resource_uris: vec![],
        app_binding: Some(serde_json::from_value(catalog["appBinding"].clone()).unwrap()),
    };
    let result = call(
        &root,
        None,
        &grant,
        "github.fetch_issue",
        &json!({"repository_full_name":"VondeSong/hub-search","issue_number":56}),
        &control,
        || Ok(()),
    )
    .unwrap();
    assert_eq!(result["structuredContent"]["issue"]["issue_number"], 56);
    assert_eq!(result["businessWrites"], false);
    assert!(call(
        &root,
        None,
        &grant,
        "github.add_comment_to_issue",
        &json!({}),
        &control,
        || Ok(())
    )
    .is_err());
    println!("real connected Apps: selected account, selected GitHub, Issue #56 verified; unselected write rejected");
}
