//! Local chat ownership gates provider history transfer; it grants no business writes.
use super::*;

fn needs_consent(previous: Option<&str>, current: &str, legacy: bool) -> bool {
    previous.map_or(legacy, |previous| previous != current)
}
pub(super) fn pin(root: &Path, args: &Value) -> Result<(), String> {
    let Some(scope) = args["codexScopeId"].as_str() else {
        return Ok(());
    };
    if scope.len() != 64 || !scope.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Codex 账号身份无效，请刷新账号".into());
    }
    let id = args["id"].as_str().ok_or("请选择对话")?;
    store::write(root, |c| {
        store::load(c, id)?;
        let previous: Option<String>=c.query_row("SELECT json_extract(body_json,'$.scopeId') FROM agent_records WHERE work_id=?1 AND kind='codexAccountBinding' ORDER BY rowid DESC LIMIT 1",[id],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        let legacy: bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_records WHERE work_id=?1 AND kind='nativeSession')",[id],|r|r.get(0)).map_err(|e|e.to_string())?;
        if needs_consent(previous.as_deref(), scope, legacy) {
            return Err(
                "请确认账号后继续：旧对话历史尚未授权给当前账号，请确认共享历史或新建对话".into(),
            );
        }
        if previous.is_none() {
            store::insert(
                c,
                id,
                None,
                "codexAccountBinding",
                &json!({"scopeId":scope,"historyShared":false,"requestBound":true}),
            )?;
        }
        Ok(())
    })
}
pub(super) fn check(
    root: &Path,
    work: &str,
    run: &str,
    scope: &str,
    legacy: bool,
) -> Result<(), String> {
    let previous = store::records(root, work, "codexAccountBinding", 1)?
        .into_iter()
        .next();
    if needs_consent(
        previous.as_ref().and_then(|v| v["scopeId"].as_str()),
        scope,
        legacy,
    ) {
        return Err("请确认账号后继续：这段对话属于其他账号或尚未绑定账号。可切回原账号、新建对话，或明确允许当前账号读取本对话历史；未发送给新账号".into());
    }
    if previous.is_none() {
        store::record(
            root,
            run,
            "codexAccountBinding",
            &json!({"scopeId":scope,"historyShared":false}),
        )?;
    }
    Ok(())
}
pub(super) fn authorize(root: &Path, args: &Value) -> Result<Value, String> {
    let id = args["id"]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 200)
        .ok_or("请选择对话")?;
    let expected = args["scopeId"].as_str().ok_or("请先读取当前账号")?;
    let account = crate::model_runtime::codex_account(root)?;
    if account["scopeId"] != expected {
        return Err("当前账号已变化，请刷新账号后重新确认".into());
    }
    store::write(root, |c| {
        let work = store::load(c, id)?;
        if work.active_run.is_some() {
            return Err("本轮仍在生成，请在结束后确认账号".into());
        }
        store::insert(
            c,
            id,
            None,
            "codexAccountBinding",
            &json!({"scopeId":expected,"historyShared":true,"userConfirmed":true}),
        )
    })?;
    Ok(json!({"authorized":true,"scopeId":expected}))
}

#[test]
fn cross_account_or_legacy_history_requires_explicit_consent() {
    assert!(!needs_consent(None, "account-a", false));
    assert!(needs_consent(None, "account-a", true));
    assert!(!needs_consent(Some("account-a"), "account-a", true));
    assert!(needs_consent(Some("account-a"), "account-b", true));
}

#[test]
fn a_queued_chat_stays_bound_to_its_original_account_in_the_database() {
    let fixture = crate::source_evidence::tests::Fixture::new();
    fixture.note("notes", "current", "Synthetic account binding fixture");
    let id = super::tests::create(&fixture, false);
    let a = "a".repeat(64);
    let b = "b".repeat(64);
    pin(&fixture.root, &json!({"id":id,"codexScopeId":a})).unwrap();
    pin(&fixture.root, &json!({"id":id,"codexScopeId":a})).unwrap();
    assert!(pin(&fixture.root, &json!({"id":id,"codexScopeId":b}))
        .unwrap_err()
        .contains("请确认账号"));
    assert!(check(&fixture.root, &id, "must-not-start", &b, false)
        .unwrap_err()
        .contains("未发送给新账号"));
    let records = store::records(&fixture.root, &id, "codexAccountBinding", 10).unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["scopeId"], a);
}
