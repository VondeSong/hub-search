//! Public provider observations only; not a token ledger or a second compaction controller.
use super::*;
fn number(v: &Value) -> Option<u64> {
    v.as_u64().filter(|n| *n <= 9_007_199_254_740_991)
}
fn snapshot(usage: &Value) -> Value {
    let window = number(&usage["modelContextWindow"]).filter(|n| *n > 0);
    let last = number(&usage["last"]["totalTokens"]);
    let percent = window
        .zip(last)
        .map(|(w, n)| ((n as u128) * 100 / (w as u128)).min(100) as u64);
    json!({"id":"native-context-usage","kind":"contextUsage","text":"","state":if last.is_some(){"reported"}else{"unknown"},"windowTokens":window,"lastTokens":last,"threadTotalTokens":number(&usage["total"]["totalTokens"]),"usedPercent":percent,"nearLimit":percent.map(|p|p>=80),"basis":"last provider usage / reported model window; observation, not exact live occupancy or automatic compaction threshold","automaticCompactionOwner":"codex","budgetReset":false})
}
pub(in crate::agent_work) fn observe(
    root: &Path,
    w: &Work,
    run: &str,
    usage: &Value,
    control: &Control,
) -> Result<(), String> {
    stream(root, w, run, &snapshot(usage), control)
}
pub(in crate::agent_work) fn invalidate(
    root: &Path,
    w: &Work,
    run: &str,
    control: &Control,
) -> Result<(), String> {
    let mut value = snapshot(&Value::Null);
    value["state"] = json!("awaitingUsage");
    stream(root, w, run, &value, control)
}
pub(super) fn view_on(c: &Connection, w: &Work) -> Result<Value, String> {
    if w.state == "revoked" {
        return Ok(Value::Null);
    }
    let latest:Option<(String,i64,i64)>=c.query_row("SELECT id,base_revision,authorization_version FROM agent_runs WHERE work_id=?1 ORDER BY rowid DESC LIMIT 1",[&w.id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|e|e.to_string())?;
    let Some((run, revision, authorization)) = latest else {
        return Ok(snapshot(&Value::Null));
    };
    let raw:Option<String>=c.query_row("SELECT body_json FROM agent_records WHERE work_id=?1 AND run_id=?2 AND kind='agentStream' AND json_extract(body_json,'$.kind')='contextUsage' ORDER BY rowid DESC LIMIT 1",params![w.id,run],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    let mut value = raw
        .map(|s| serde_json::from_str::<Value>(&s).map_err(|_| "原生上下文状态损坏"))
        .transpose()?
        .unwrap_or_else(|| snapshot(&Value::Null));
    value["runId"] = json!(run);
    value["previousRevision"] =
        json!(revision != w.revision || authorization != w.authorization_version);
    value["running"] = json!(w.active_run.as_deref() == Some(run.as_str()));
    Ok(value)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cn06_context_uses_last_not_lifetime_and_missing_never_means_zero() {
        let s = snapshot(
            &json!({"modelContextWindow":1000,"last":{"totalTokens":800},"total":{"totalTokens":900000}}),
        );
        assert_eq!(s["usedPercent"], 80);
        assert_eq!(s["nearLimit"], true);
        for v in [
            json!({}),
            json!({"modelContextWindow":0,"last":{"totalTokens":null}}),
            json!({"modelContextWindow":-1,"last":{"totalTokens":-1}}),
        ] {
            assert!(snapshot(&v)["usedPercent"].is_null());
            assert!(snapshot(&v)["lastTokens"].is_null());
        }
    }
    #[test]
    fn cn06_context_persists_bounded_invalidates_compaction_and_rejects_late_updates() {
        let f = crate::source_evidence::tests::Fixture::new();
        f.note("notes", "current", "来源");
        let id = crate::agent_work::tests::create(&f, false);
        let (w, run) = crate::agent_work::tests::claim(&f, &id);
        let ctl = Control::default();
        for n in 1..20 {
            observe(&f.root,&w,&run,&json!({"modelContextWindow":100,"last":{"totalTokens":n},"total":{"totalTokens":n*100}}),&ctl).unwrap();
        }
        assert_eq!(
            f.c()
                .query_row(
                    "SELECT count(*) FROM agent_records WHERE run_id=?1 AND kind='agentStream'",
                    [&run],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(view_on(&f.c(), &w).unwrap()["lastTokens"], 19);
        invalidate(&f.root, &w, &run, &ctl).unwrap();
        let v = view_on(&f.c(), &w).unwrap();
        assert_eq!(v["state"], "awaitingUsage");
        assert!(v["usedPercent"].is_null());
        observe(&f.root, &w, &run, &json!({"last":{"totalTokens":5}}), &ctl).unwrap();
        store::fail(&f.root, &w, &run, "停止").unwrap();
        assert!(observe(&f.root, &w, &run, &json!({}), &ctl).is_err());
        let current = load(&f.c(), &id).unwrap();
        assert_eq!(view_on(&f.c(), &current).unwrap()["lastTokens"], 5);
        store::revoke(&f.root, &id).unwrap();
        assert!(view_on(&f.c(), &load(&f.c(), &id).unwrap())
            .unwrap()
            .is_null());
    }
}
