use super::*;

fn identity() -> Value {
    json!({"userId":"test-account","inboxId":"inbox123"})
}

#[test]
fn dida_web_cookie_candidates_require_one_unambiguous_session_without_exposing_tokens() {
    assert!(
        dida_web_cookie_candidate(vec![("other".into(), "value".into())])
            .unwrap()
            .is_none()
    );
    let candidate = dida_web_cookie_candidate(vec![
        ("t".into(), "test-session".into()),
        ("locale".into(), "zh_CN".into()),
    ])
    .unwrap()
    .unwrap();
    assert_eq!(candidate, ("t=test-session; locale=zh_CN".into(), 2));
    let duplicate = dida_web_cookie_candidate(vec![
        ("t".into(), String::new()),
        ("t".into(), "test-session".into()),
        ("T".into(), "test-session".into()),
        ("locale".into(), "zh_CN".into()),
    ])
    .unwrap()
    .unwrap();
    assert_eq!(duplicate, candidate);
    let error = dida_web_cookie_candidate(vec![
        ("t".into(), "test-first-secret".into()),
        ("t".into(), "test-other-secret".into()),
    ])
    .unwrap_err();
    assert!(!error.contains("test-first-secret"));
    assert!(!error.contains("test-other-secret"));
}

#[tokio::test]
async fn dida_web_login_checks_server_and_recovers_from_a_rejected_store() {
    let mut calls = Vec::new();
    let count = verify_dida_web_login_candidates(
        vec![
            ("test-stale".into(), 2),
            ("test-current".into(), 4),
            ("unused".into(), 1),
        ],
        |cookie| {
            calls.push(cookie.clone());
            std::future::ready(if cookie == "test-stale" {
                Err(DidaWebLoginError::Authentication(401))
            } else {
                Ok(identity())
            })
        },
    )
    .await
    .unwrap();
    assert_eq!(count, 4);
    assert_eq!(calls, ["test-stale", "test-current"]);
}

#[tokio::test]
async fn dida_web_login_rejected_credentials_never_report_available_or_leak_tokens() {
    let mut calls = 0;
    let error = verify_dida_web_login_candidates(
        vec![
            ("test-first-secret".into(), 1),
            ("test-other-secret".into(), 1),
        ],
        |_| {
            calls += 1;
            std::future::ready(Err(DidaWebLoginError::Authentication(403)))
        },
    )
    .await
    .unwrap_err();
    assert_eq!(calls, 2);
    assert!(error.contains("403"));
    assert!(!error.contains("test-first-secret"));
    assert!(!error.contains("test-other-secret"));
}

#[tokio::test]
async fn dida_web_login_network_failures_do_not_silently_switch_accounts() {
    let mut calls = 0;
    let error = verify_dida_web_login_candidates(
        vec![("test-first".into(), 1), ("test-second".into(), 1)],
        |_| {
            calls += 1;
            std::future::ready(Err(DidaWebLoginError::Other("服务暂时不可用")))
        },
    )
    .await
    .unwrap_err();
    assert_eq!(calls, 1);
    assert_eq!(error, "服务暂时不可用");
}

#[tokio::test]
async fn dida_web_login_incomplete_or_wrapped_identity_stops_before_other_sessions() {
    for invalid in [
        Value::Null,
        json!({"result":identity()}),
        json!({"userId":"test-account"}),
        json!({"userId":"test-account","inboxId":"inbox"}),
        json!({"userId":"test-account","inboxId":"other123"}),
        json!({"userId":"test/account","inboxId":"inbox123"}),
    ] {
        let mut calls = 0;
        let result = verify_dida_web_login_candidates(
            vec![("test-first".into(), 1), ("test-second".into(), 1)],
            |_| {
                calls += 1;
                std::future::ready(Ok(invalid.clone()))
            },
        )
        .await;
        assert!(result.is_err());
        assert_eq!(calls, 1);
    }
}

#[test]
fn dida_web_login_success_status_with_login_html_is_not_an_authenticated_identity() {
    assert!(decode_dida_web_login_body(b"<!DOCTYPE html><title>Sign in</title>").is_err());
    let decoded = decode_dida_web_login_body(br#"{"error":"unauthorized"}"#)
        .ok()
        .unwrap();
    assert!(!dida_web_login_identity_valid(&decoded));
    assert!(dida_web_login_identity_valid(&identity()));
}
