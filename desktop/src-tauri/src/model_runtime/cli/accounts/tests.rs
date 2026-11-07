use super::*;

fn token(user: &str, workspace: &str, epoch: i64) -> String {
    let payload = json!({"sub":user,"exp":epoch,"https://api.openai.com/auth":{"chatgpt_account_id":workspace}});
    format!(
        "{}.{}.not-a-real-signature",
        URL_SAFE_NO_PAD.encode(r#"{"alg":"none","typ":"JWT"}"#),
        URL_SAFE_NO_PAD.encode(payload.to_string())
    )
}
fn sample(user: &str, workspace: &str) -> Account {
    account(
        &json!({"authMethod":"chatgpt","authToken":token(user,workspace,9999999999)}),
        &json!({"account":{"type":"chatgpt","email":"test@example.invalid","planType":"plus"}}),
    )
    .unwrap()
}
#[test]
fn distinct_users_and_workspaces_never_share_a_context_scope() {
    let a = sample("user-a", "workspace-a");
    let b = sample("user-b", "workspace-a");
    let c = sample("user-a", "workspace-b");
    assert_ne!(a.public["scopeId"], b.public["scopeId"]);
    assert_ne!(a.public["scopeId"], c.public["scopeId"]);
    assert_eq!(
        a.public["scopeId"],
        sample("user-a", "workspace-a").public["scopeId"]
    );
}
#[test]
fn only_masked_identity_leaves_the_native_boundary() {
    let a = sample("user-a", "workspace-a");
    let view = a.public.to_string();
    assert!(view.contains("t***@example.invalid"));
    for secret in [
        "test@example.invalid",
        "authToken",
        "accessToken",
        "refresh_token",
        "workspace-a",
        "user-a",
    ] {
        assert!(!view.contains(secret));
    }
    assert_eq!(a.login["type"], "chatgptAuthTokens");
    assert_eq!(a.login["accessToken"], token("user-a", "workspace-a", 9999999999));
}
#[test]
fn malformed_or_signed_out_identity_is_not_an_implicit_fallback() {
    for value in [
        json!({}),
        json!({"authMethod":"chatgpt","authToken":"bad"}),
        json!({"authMethod":"other","authToken":"SYNTHETIC"}),
    ] {
        assert!(account(&value, &json!({})).is_err());
    }
    assert!(account(
        &json!({"authMethod":"chatgpt","authToken":token("user","workspace",9999999999)}),
        &json!({"account":null})
    )
    .is_err());
    assert!(account(
        &json!({"authMethod":"chatgpt","authToken":token("user","workspace",1)}),
        &json!({"account":{"type":"chatgpt"}})
    )
    .is_err());
}
#[test]
fn profile_ids_cannot_escape_the_owned_directory() {
    let root = PathBuf::from("owned");
    for id in ["", "..", "../auth", "a/b", "a\\b", "C:", DESKTOP] {
        assert!(profile_home(&root, id).is_err());
    }
    assert_eq!(
        profile_home(&root, "valid-profile_1").unwrap(),
        root.join("codex-accounts/valid-profile_1")
    );
}
#[test]
fn authorizations_only_open_the_official_https_login_hosts() {
    for url in [
        "http://auth.openai.com/a",
        "https://evil.invalid/a",
        "https://auth.openai.com.evil.invalid/a",
        "https://user@auth.openai.com/a",
        "file:///auth",
    ] {
        assert!(!valid_auth_url(url));
    }
    assert!(valid_auth_url(
        "https://auth.openai.com/oauth/authorize?state=synthetic"
    ));
    assert!(valid_auth_url(
        "https://chatgpt.com/authorize?state=synthetic"
    ));
}
#[test]
fn registry_is_atomic_and_contains_no_credentials() {
    let root = std::env::temp_dir().join(format!(
        "hub-account-registry-{}",
        crate::random_url_safe(12)
    ));
    let mut registry = Registry::default();
    assert_eq!(load(&root).unwrap().selected, DESKTOP);
    registry.accounts.push(Profile {
        id: "profile-a".into(),
        label: "t***@example.invalid".into(),
        scope_id: "a".repeat(64),
        plan: "plus".into(),
        workspace_label: "工作区尾号 123456".into(),
    });
    registry.selected = "profile-a".into();
    save(&root, &registry).unwrap();
    assert_eq!(load(&root).unwrap().selected, "profile-a");
    let bytes = std::fs::read_to_string(root.join(REGISTRY_FILE)).unwrap();
    for secret in ["authToken", "accessToken", "refreshToken", "id_token"] {
        assert!(!bytes.contains(secret));
    }
    registry.selected = "unknown-profile".into();
    save(&root, &registry).unwrap();
    assert!(load(&root).is_err());
    std::fs::remove_file(root.join(REGISTRY_FILE)).unwrap();
    std::fs::remove_dir(root).unwrap();
}

#[test]
fn queued_operations_keep_the_account_selected_at_submission() {
    use crate::model_runtime::{new_runtime, Operation, Settings};
    let root = std::env::temp_dir().join(format!(
        "hub-codex-suite-account-queue-{}",
        crate::random_url_safe(12)
    ));
    let _cleanup = JobDir(root.clone());
    let mut registry = Registry::default();
    for id in ["account-a", "account-b"] {
        registry.accounts.push(Profile {
            id: id.into(),
            label: id.into(),
            scope_id: "a".repeat(64),
            plan: "plus".into(),
            workspace_label: String::new(),
        });
    }
    registry.selected = "account-a".into();
    save(&root, &registry).unwrap();
    let mut settings = Settings::default();
    settings.max_concurrent = 1;
    let mut runtime = new_runtime(settings);
    Arc::get_mut(&mut runtime).unwrap().root = Some(root.clone());
    let first = Operation::start_on_control(
        runtime.clone(),
        "agent-investigation",
        "first",
        Control::default(),
    )
    .unwrap();
    let next = runtime.clone();
    let (send, receive) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let operation =
            Operation::start_on_control(next, "agent-investigation", "queued", Control::default())
                .unwrap();
        send.send(operation.codex_account_selection().unwrap().to_owned())
            .unwrap();
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    while runtime.state.lock().unwrap().waiting.is_empty() {
        assert!(Instant::now() < deadline);
        std::thread::yield_now();
    }
    registry.selected = "account-b".into();
    save(&root, &registry).unwrap();
    drop(first);
    assert_eq!(
        receive.recv_timeout(Duration::from_secs(5)).unwrap(),
        "account-a"
    );
    worker.join().unwrap();
}

#[test]
#[ignore = "explicit installed Codex protocol check; synthetic credentials only; no threads or model calls"]
fn installed_account_protocol_uses_an_ephemeral_token_without_persisting_it() {
    let control = Control::bounded(Duration::from_secs(30));
    let exe = executable_control(false, &control).unwrap();
    let directory = std::env::temp_dir().join(format!(
        "hub-codex-suite-auth-protocol-{}",
        crate::random_url_safe(12)
    ));
    std::fs::create_dir(&directory).unwrap();
    let _cleanup = JobDir(directory.clone());
    let auth =
        json!({"auth_mode":"apikey","OPENAI_API_KEY":"SYNTHETIC_NO_NETWORK_KEY"}).to_string();
    std::fs::write(directory.join("auth.json"), &auth).unwrap();
    let mut command = Command::new(exe.path);
    command
        .args([
            "app-server",
            "--stdio",
            "-c",
            "cli_auth_credentials_store=\"file\"",
        ])
        .env("CODEX_HOME", &directory)
        .current_dir(&directory);
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("OPENAI_") || key == "CODEX_ACCESS_TOKEN" {
            command.env_remove(key);
        }
    }
    let process =
        CatalogProcess::start_control(command, Instant::now() + Duration::from_secs(30), &control)
            .unwrap();
    rpc(
        &process,
        1,
        "initialize",
        json!({"clientInfo":{"name":"hub_synthetic_auth_check","version":"1"},"capabilities":{"experimentalApi":true}}),
    )
    .unwrap();
    process.send(json!({"method":"initialized"})).unwrap();
    let original = rpc(
        &process,
        2,
        "getAuthStatus",
        json!({"includeToken":true,"refreshToken":false}),
    )
    .unwrap();
    assert_eq!(original["authMethod"], "apikey");
    assert_eq!(original["authToken"], "SYNTHETIC_NO_NETWORK_KEY");
    let access = token("synthetic-user", "synthetic-workspace", 9999999999);
    rpc(&process,3,"account/login/start",json!({"type":"chatgptAuthTokens","accessToken":access,"chatgptAccountId":"synthetic-workspace","chatgptPlanType":"plus"})).unwrap();
    let active = rpc(
        &process,
        4,
        "getAuthStatus",
        json!({"includeToken":true,"refreshToken":false}),
    )
    .unwrap();
    assert_eq!(active["authMethod"], "chatgptAuthTokens");
    assert_eq!(active["authToken"], access);
    assert_eq!(
        std::fs::read_to_string(directory.join("auth.json")).unwrap(),
        auth
    );
}
