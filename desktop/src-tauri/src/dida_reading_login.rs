//! Current, read-only login feedback for the reading inbox. Historical import
//! errors stay intact; an accepted status response never grants a delete permit.
use super::*;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadingLoginStatus {
    connected: bool,
    account_matched: bool,
    checked_at: i64,
    login_window_open: bool,
    state: &'static str,
    message: String,
}

fn verify_accounts(c: &Connection, libraries: &[String], identity: &Value) -> Result<bool, String> {
    if libraries.is_empty() {
        return Err("尚未连接可用的滴答资料库，请先在设置中连接滴答清单".into());
    }
    let mut all_matched = true;
    for library in libraries {
        all_matched &= x_bookmarks::dida_reading::verify_login_identity(c, library, identity)?;
    }
    Ok(all_matched)
}

async fn verify_candidates<Check, CheckFuture>(
    candidates: Vec<(String, usize)>,
    mut check: Check,
    verify_account: impl Fn(&Value) -> Result<bool, String>,
) -> Result<bool, (&'static str, String)>
where
    Check: FnMut(String) -> CheckFuture,
    CheckFuture: std::future::Future<Output = Result<Value, DidaWebLoginError>>,
{
    let mut rejected = None;
    for (cookie, _) in candidates {
        match check(cookie).await {
            Ok(identity) if dida_web_login_identity_valid(&identity) => {
                return verify_account(&identity).map_err(|message| ("account-mismatch", message));
            }
            Ok(_) => {
                return Err((
                    "unverified",
                    "滴答网页登录返回的账号身份不完整，请完成登录后重新检查".into(),
                ))
            }
            Err(DidaWebLoginError::Authentication(status)) => rejected = Some(status),
            Err(DidaWebLoginError::Other(message)) => {
                return Err(("service-unavailable", message.into()))
            }
        }
    }
    Err((
        "authentication",
        rejected
            .map(|status| format!("滴答网页登录未通过（{status}）；原项已保留"))
            .unwrap_or_else(|| "尚未检测到滴答网页登录，请在登录窗口完成登录后检查".into()),
    ))
}

#[tauri::command]
pub(crate) async fn get_dida_reading_login_status(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ReadingLoginStatus, String> {
    let result = async {
        let connected = state.sessions.lock().map_err(|_| ("service-unavailable", "滴答授权会话暂不可用".to_string()))?.keys().cloned().collect::<HashSet<_>>();
        let path = database_path(&app).map_err(|error| ("service-unavailable", error))?;
        let c = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|_| ("service-unavailable", "滴答资料库账号绑定暂不可读取".to_string()))?;
        let libraries = {
            let mut query = c.prepare("SELECT id FROM libraries WHERE provider='dida365' AND enabled=1 ORDER BY id").map_err(|_| ("service-unavailable", "滴答资料库暂不可读取".to_string()))?;
            let ids = query.query_map([], |r| r.get::<_, String>(0)).map_err(|_| ("service-unavailable", "滴答资料库暂不可读取".to_string()))?.collect::<Result<Vec<_>, _>>().map_err(|_| ("service-unavailable", "滴答资料库暂不可读取".to_string()))?;
            ids.into_iter().filter(|id| connected.contains(id)).collect::<Vec<_>>()
        };
        if libraries.is_empty() {
            return Err(("unverified", "尚未连接可用的滴答资料库，请先在设置中连接滴答清单".into()));
        }
        drop(c);
        let candidates = dida_attachment_cookie_candidates(&app).map_err(|message| ("authentication", message))?;
        let client = reqwest::Client::builder()
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0")
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::none())
            .build().map_err(|_| ("service-unavailable", "滴答网页登录检查暂不可用".to_string()))?;
        verify_candidates(candidates, |cookie| check_dida_web_login_candidate(client.clone(), cookie), |identity| {
            let c = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|_| "滴答资料库账号绑定暂不可读取".to_string())?;
            verify_accounts(&c, &libraries, identity)
        }).await
    }.await;
    let (connected, account_matched, state, message) = match result {
        Ok(true) => (true, true, "verified", "滴答网页登录已通过服务器验证，且与已连接资料库的账号绑定一致。历史失败条目需重新同步核验。".to_string()),
        Ok(false) => (true, false, "verified", "滴答网页登录已通过服务器验证；首次连接的资料库账号仍待同步核验，原项会继续保留。".to_string()),
        Err((state, message)) => (false, false, state, message),
    };
    Ok(ReadingLoginStatus {
        connected,
        account_matched,
        checked_at: now_timestamp(),
        login_window_open: app
            .get_webview_window(DIDA_ATTACHMENT_LOGIN_WINDOW)
            .is_some(),
        state,
        message,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE libraries(id TEXT PRIMARY KEY,metadata_json TEXT);CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);INSERT INTO libraries VALUES('reading','{}');").unwrap();
        c
    }
    fn identity() -> Value {
        json!({"userId":"account-one","inboxId":"inbox123"})
    }

    #[test]
    fn reading_login_verifies_retained_inbox_binding_without_writes_or_replacing_it() {
        let c = fixture();
        c.execute(
            "INSERT INTO metadata VALUES('dida_reading_account:reading:library:reading',?1)",
            [format!("{:x}", Sha256::digest(b"inbox123"))],
        )
        .unwrap();
        let before = c.total_changes();
        assert!(verify_accounts(&c, &["reading".into()], &identity()).unwrap());
        assert!(verify_accounts(
            &c,
            &["reading".into()],
            &json!({"userId":"account-two","inboxId":"inbox456"})
        )
        .is_err());
        assert_eq!(c.total_changes(), before);
    }

    #[test]
    fn reading_login_first_unbound_account_is_not_reported_as_matching_mcp() {
        let c = fixture();
        assert!(!verify_accounts(&c, &["reading".into()], &identity()).unwrap());
        c.execute(
            "UPDATE libraries SET metadata_json=?1",
            [json!({"preference":{"userId":"account-two"}}).to_string()],
        )
        .unwrap();
        assert!(verify_accounts(&c, &["reading".into()], &identity()).is_err());
        assert!(verify_accounts(&c, &[], &identity()).is_err());
    }

    #[tokio::test]
    async fn reading_login_retries_only_rejected_sessions_and_checks_bound_account_before_success()
    {
        let mut calls = Vec::new();
        let result = verify_candidates(
            vec![("stale".into(), 1), ("current".into(), 1)],
            |cookie| {
                calls.push(cookie.clone());
                std::future::ready(if cookie == "stale" {
                    Err(DidaWebLoginError::Authentication(401))
                } else {
                    Ok(identity())
                })
            },
            |_| Ok(true),
        )
        .await
        .unwrap();
        assert!(result);
        assert_eq!(calls, ["stale", "current"]);
        let mismatch = verify_candidates(
            vec![("one".into(), 1), ("two".into(), 1)],
            |_| std::future::ready(Ok(identity())),
            |_| Err("账号不一致".into()),
        )
        .await
        .unwrap_err();
        assert_eq!(mismatch, ("account-mismatch", "账号不一致".into()));
    }

    #[tokio::test]
    async fn reading_login_network_failure_is_distinct_from_rejected_authentication_and_no_cookie_leaks(
    ) {
        let mut calls = 0;
        let error = verify_candidates(
            vec![("first-secret".into(), 1), ("second-secret".into(), 1)],
            |_| {
                calls += 1;
                std::future::ready(Err(DidaWebLoginError::Other("网络暂不可用")))
            },
            |_| Ok(true),
        )
        .await
        .unwrap_err();
        assert_eq!(calls, 1);
        assert_eq!(error, ("service-unavailable", "网络暂不可用".into()));
        let rejected = verify_candidates(
            vec![("secret".into(), 1)],
            |_| std::future::ready(Err(DidaWebLoginError::Authentication(401))),
            |_| Ok(true),
        )
        .await
        .unwrap_err();
        assert_eq!(rejected.0, "authentication");
        assert!(!rejected.1.contains("secret"));
    }
}
