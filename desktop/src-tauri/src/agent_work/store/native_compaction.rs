//! An explicit host request, consumed once inside the existing admitted Run.
use super::*;
#[cfg(test)]
mod actual;
// Manual continuation qualified on CLI 0.166.0-alpha.5.1 (2026-11-01); old failures remain recorded.
// Codex owns automatic compaction; Hub only schedules explicit manual requests.
const QUALIFIED: bool = true;

fn latest(c: &Connection, id: &str, kind: &str) -> Result<Option<Value>, String> {
    let raw:Option<String>=c.query_row("SELECT body_json FROM agent_records WHERE work_id=?1 AND kind=?2 ORDER BY rowid DESC LIMIT 1",params![id,kind],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    raw.map(|v| serde_json::from_str(&v).map_err(|_| "上下文整理记录损坏".into()))
        .transpose()
}
pub(in crate::agent_work) fn request(root: &Path, args: &Value) -> Result<Value, String> {
    if !cfg!(test) && !QUALIFIED {
        return Err("当前环境的整理后续跑尚未验证，请继续普通分析".into());
    }
    let id = text(args, "id", 150)?;
    let operation = text(args, "operationId", 150)?;
    write(root, |c| {
        let w = load(c, &id)?;
        if w.active_run.is_some()
            || w.state == "revoked"
            || args["expectedWorkRevision"] != w.revision
            || args["expectedAuthorizationVersion"] != w.authorization_version
        {
            return Err("事项或授权已变化，未安排上下文整理".into());
        }
        let session = latest(c, &id, "nativeSession")?.ok_or("没有可恢复的原生会话")?;
        if session["threadId"].as_str().is_none_or(str::is_empty)
            || !session["tokenUsage"]["total"].is_object()
        {
            return Err("原生会话身份或累计用量基线不完整，不能整理".into());
        }
        let plan = json!({"operationId":operation,"workRevision":w.revision,"authorizationVersion":w.authorization_version,"session":session});
        let existing:Option<String>=c.query_row("SELECT body_json FROM agent_records WHERE work_id=?1 AND kind='nativeCompactionRequest' AND json_extract(body_json,'$.operationId')=?2",params![id,operation],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        if let Some(old) = existing {
            if serde_json::from_str::<Value>(&old).map_err(|_| "整理请求损坏")? != plan {
                return Err("整理请求身份已用于不同会话".into());
            }
            return Ok(());
        }
        if provider_budget::view_on(c, &w)?["canAdmitRun"] != true {
            return Err("本事项剩余额度不足，未安排上下文整理".into());
        }
        if let Some(old) = latest(c, &id, "nativeCompactionRequest")? {
            if !consumed(c, &id, &old)? {
                return Err("已有待执行的上下文整理请求".into());
            }
        }
        insert(c, &id, None, "nativeCompactionRequest", &plan)
    })?;
    super::super::status(root, &id)
}
fn consumed(c: &Connection, id: &str, plan: &Value) -> Result<bool, String> {
    c.query_row("SELECT EXISTS(SELECT 1 FROM agent_records WHERE work_id=?1 AND kind='nativeCompactionAttempt' AND json_extract(body_json,'$.operationId')=?2)",params![id,plan["operationId"].as_str()],|r|r.get(0)).map_err(|e|e.to_string())
}
pub(in crate::agent_work) fn cancel(root: &Path, args: &Value) -> Result<Value, String> {
    let id = text(args, "id", 150)?;
    let operation = text(args, "operationId", 150)?;
    write(root, |c| {
        let w = load(c, &id)?;
        if w.active_run.is_some() {
            return Err("请先停止本轮，再取消整理安排".into());
        }
        let plan = latest(c, &id, "nativeCompactionRequest")?.ok_or("没有整理请求")?;
        if plan["operationId"] != operation {
            return Err("整理请求已变化，未取消".into());
        }
        if consumed(c, &id, &plan)? {
            return Ok(());
        }
        insert(
            c,
            &id,
            None,
            "nativeCompactionAttempt",
            &json!({"operationId":operation,"state":"cancelled","providerDispatched":false,"budgetReset":false}),
        )
    })?;
    super::super::status(root, &id)
}
pub(in crate::agent_work) fn view_on(c: &Connection, w: &Work) -> Result<Value, String> {
    let plan = latest(c, &w.id, "nativeCompactionRequest")?;
    let pending = plan
        .as_ref()
        .map(|v| consumed(c, &w.id, v).map(|done| !done))
        .transpose()?
        .unwrap_or(false);
    let session = latest(c, &w.id, "nativeSession")?;
    let can_request = (cfg!(test) || QUALIFIED)
        && !pending
        && w.active_run.is_none()
        && w.state != "revoked"
        && session.as_ref().is_some_and(|s| {
            s["threadId"].as_str().is_some_and(|v| !v.is_empty())
                && s["tokenUsage"]["total"].is_object()
        })
        && provider_budget::view_on(c, w)?["canAdmitRun"] == true;
    Ok(
        json!({"canRequest":can_request,"pending":pending,"operationId":plan.as_ref().map(|v|&v["operationId"]),"latestLifecycle":latest(c,&w.id,"nativeContextLifecycle")?,"meaning":"request/acknowledgement is not provider completion; no budget reset"}),
    )
}
pub(in crate::agent_work) fn pending(
    root: &Path,
    w: &Work,
    session: Option<&Value>,
) -> Result<Option<Value>, String> {
    let c = crate::source_evidence::open_read_database(root)?;
    let Some(plan) = latest(&c, &w.id, "nativeCompactionRequest")? else {
        return Ok(None);
    };
    if consumed(&c, &w.id, &plan)? {
        return Ok(None);
    }
    if plan["workRevision"] != w.revision
        || plan["authorizationVersion"] != w.authorization_version
        || session != Some(&plan["session"])
    {
        return Err("整理请求对应的会话、来源或授权已变化，请重新核对后继续".into());
    }
    Ok(Some(plan))
}
pub(in crate::agent_work) fn admit(
    root: &Path,
    w: &Work,
    run: &str,
    plan: &Value,
) -> Result<(), String> {
    write(root, |c| {
        let current = load(c, &w.id)?;
        if current.active_run.as_deref() != Some(run)
            || current.revision != w.revision
            || current.authorization_version != w.authorization_version
            || current.state != "investigating"
        {
            return Err("上下文整理运行身份已变化".into());
        }
        provider_budget::check_active_reservation_on(c, &current)?;
        if latest(c, &w.id, "nativeCompactionRequest")?.as_ref() != Some(plan)
            || consumed(c, &w.id, plan)?
        {
            return Err("上下文整理请求已消费或改变".into());
        }
        insert(
            c,
            &w.id,
            Some(run),
            "nativeCompactionAttempt",
            &json!({"operationId":plan["operationId"],"threadId":plan["session"]["threadId"],"state":"dispatchPending","budgetReset":false}),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_work::tests::create;
    use crate::source_evidence::tests::Fixture;
    #[test]
    fn request_is_source_bound_once_only_and_keeps_old_budget() {
        let f = Fixture::new();
        f.note("notes", "current", "合成来源");
        let id = create(&f, true);
        super::super::provider_budget::freeze(&f.root,&json!({"id":id,"expectedWorkRevision":1,"limits":{"inputTokens":100,"uncachedInputTokens":60,"outputTokens":20},"perRun":{"inputTokens":40,"uncachedInputTokens":20,"outputTokens":8},"unknownReservations":{}})).unwrap();
        let w = super::super::claim(&f.root, &id, "first").unwrap();
        let session = json!({"threadId":"synthetic","fingerprint":"v1","tokenUsage":{"total":{"inputTokens":10,"cachedInputTokens":5,"outputTokens":1}}});
        super::super::record(&f.root, "first", "nativeSession", &session).unwrap();
        super::super::fail(&f.root, &w, "first", "合成停止").unwrap();
        let args = json!({"id":id,"operationId":"compact1","expectedWorkRevision":1,"expectedAuthorizationVersion":1});
        request(&f.root, &args).unwrap();
        request(&f.root, &args).unwrap();
        let w =
            super::super::claim_with_budget(&f.root, &id, "second", Budget::mode("quick").unwrap())
                .unwrap();
        assert!(pending(&f.root, &w, None).is_err());
        let plan = pending(&f.root, &w, Some(&session)).unwrap().unwrap();
        admit(&f.root, &w, "second", &plan).unwrap();
        assert!(pending(&f.root, &w, Some(&session)).unwrap().is_none());
        assert!(admit(&f.root, &w, "second", &plan).is_err());
        let view = super::super::provider_budget::view_on(&f.c(), &w).unwrap();
        assert_eq!(view["limits"]["inputTokens"], 100);
        assert!(view["chargedOrReserved"]["inputTokens"].as_u64().unwrap() > 0);
    }
    #[test]
    fn obsolete_request_can_be_cancelled_without_a_provider_or_run() {
        let f = Fixture::new();
        f.note("notes", "current", "合成来源");
        let id = create(&f, true);
        let w = load(&f.c(), &id).unwrap();
        let plan = json!({"operationId":"old","workRevision":w.revision,"authorizationVersion":w.authorization_version,"session":{"threadId":"old"}});
        write(&f.root, |c| {
            insert(c, &id, None, "nativeCompactionRequest", &plan)
        })
        .unwrap();
        assert!(pending(&f.root, &w, None).is_err());
        assert_eq!(view_on(&f.c(), &w).unwrap()["pending"], true);
        assert!(cancel(&f.root, &json!({"id":id,"operationId":"wrong"})).is_err());
        cancel(&f.root, &json!({"id":id,"operationId":"old"})).unwrap();
        cancel(&f.root, &json!({"id":id,"operationId":"old"})).unwrap();
        assert!(pending(&f.root, &w, None).unwrap().is_none());
        assert_eq!(
            f.c()
                .query_row(
                    "SELECT count(*) FROM agent_runs WHERE work_id=?1",
                    [id],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }
}
