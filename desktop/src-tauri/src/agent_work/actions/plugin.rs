//! First verified plugin write adapter: one GitHub Issue comment. Other
//! writes remain unavailable until they have an equally concrete receipt path.
use super::*;
use crate::model_runtime::mcp_services::{apps, Grant as ServiceGrant};
use std::collections::HashSet;

fn check_on(
    c: &Connection,
    w: &Work,
    grant: &ServiceGrant,
    action: Option<&Action>,
    idle: bool,
) -> Result<(), String> {
    if let Some(action) = action {
        let mut plan = action.payload.clone().ok_or("插件草稿缺失")?;
        plan.as_object_mut()
            .ok_or("插件草稿格式无效")?
            .remove("originRunId");
        if digest(&plan) != action.context_hash {
            return Err("插件草稿内容与准备时不一致".into());
        }
    }
    let current = store::load(c, &w.id)?;
    if current.state == "revoked"
        || store::lifecycle::held(&current.state)
        || current.revision != w.revision
        || current.authorization_version != w.authorization_version
        || (idle && current.active_run.is_some())
        || action.is_some_and(|a| {
            a.base_revision != current.revision
                || a.authorization_version != current.authorization_version
        })
    {
        return Err("插件动作所属对话、决定或授权已改变".into());
    }
    let options = options::load_on(c, &w.id)?;
    if options.materials_only() || !options.mcp_services.contains(grant) {
        return Err("插件工具授权已撤销或改变".into());
    }
    crate::model_runtime::mcp_services::validate(std::slice::from_ref(grant))
}

pub(in crate::agent_work) fn prepare(
    root: &Path,
    w: &Work,
    run: &str,
    selection: Option<&str>,
    grant: &ServiceGrant,
    args: &Value,
    control: &Control,
) -> Result<Value, String> {
    let c = crate::source_evidence::open_read_database(root)?;
    check_on(&c, w, grant, None, false)?;
    if w.active_run.as_deref() != Some(run) {
        return Err("插件草稿所属运行不匹配".into());
    }
    drop(c);
    let plan = apps::prepare_comment(root, selection, grant, args, control)?;
    control.check()?;
    let action = store::write(root, |c| {
        check_on(c, w, grant, None, false)?;
        let current = store::load(c, &w.id)?;
        if current.active_run.as_deref() != Some(run) {
            return Err("插件草稿所属运行已改变".into());
        }
        // Identical model retries reuse the same draft, including unknown and
        // verified actions; a new model call can never silently replay it.
        if let Some(old) = reusable_on(c, w, &digest(&plan))? {
            return Ok(old);
        }
        let count: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM agent_actions WHERE work_id=?1",
                [&w.id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if count >= 20 {
            return Err("本对话动作记录已满，请新建对话".into());
        }
        let id = format!("action-{}", crate::random_url_safe(18));
        let mut payload = plan.clone();
        payload["originRunId"] = json!(run);
        c.execute("INSERT INTO agent_actions(id,work_id,kind,base_revision,authorization_version,state,payload_json,context_hash,created_at,updated_at) VALUES(?1,?2,'pluginWrite',?3,?4,'prepared',?5,?6,?7,?7)",params![id,w.id,w.revision,w.authorization_version,payload.to_string(),digest(&plan),stamp()]).map_err(|e|e.to_string())?;
        store::insert(
            c,
            &w.id,
            Some(run),
            "agentDraft",
            &json!({"actionId":id,"kind":"pluginWrite","executed":false}),
        )?;
        Ok(id)
    })?;
    let saved = load(
        &crate::source_evidence::open_read_database(root)?,
        &w.id,
        &action,
    )?;
    Ok(
        json!({"actionId":action,"kind":"pluginWrite","state":saved.state,"prepared":saved.state=="prepared","executed":if saved.state=="verified" {json!(true)} else if saved.state=="prepared" {json!(false)} else {Value::Null},"targetUrl":plan["targetUrl"],"receipt":saved.receipt,"message":"相同内容沿用既有动作，不自动重复写入。prepared 只表示草稿待用户确认，unknown 只能核对已有评论，verified 以保存的回读回执为准。"}),
    )
}

fn reusable_on(c: &Connection, w: &Work, hash: &str) -> Result<Option<String>, String> {
    let old:Option<String>=c.query_row("SELECT id FROM agent_actions WHERE work_id=?1 AND kind='pluginWrite' AND context_hash=?2 ORDER BY rowid DESC LIMIT 1",params![w.id,hash],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    let Some(id) = old else { return Ok(None) };
    let a = load(c, &w.id, &id)?;
    if ["executing", "unknown", "verified"].contains(&a.state.as_str())
        || (a.state == "prepared"
            && a.base_revision == w.revision
            && a.authorization_version == w.authorization_version)
    {
        return Ok(Some(id));
    }
    // A never-dispatched draft may be prepared afresh for a new decision.
    // A dispatched or uncertain write above must retain its original identity.
    if a.state == "prepared" || a.state == "expired" {
        c.execute("UPDATE agent_actions SET state='expired',updated_at=?2 WHERE id=?1 AND state='prepared'",params![id,stamp()]).map_err(|e|e.to_string())?;
        return Ok(None);
    }
    Err("插件动作状态不可重新准备".into())
}

fn grant(a: &Action) -> Result<ServiceGrant, String> {
    serde_json::from_value(a.payload.as_ref().ok_or("插件草稿缺失")?["grant"].clone())
        .map_err(|_| "插件动作授权损坏".into())
}
pub(super) fn check_context(c: &Connection, w: &Work, a: &Action) -> Result<(), String> {
    check_on(c, w, &grant(a)?, Some(a), false)
}
pub(super) fn inspect(c: &Connection, w: &Work, a: &Action) -> Result<Value, String> {
    check_context(c, w, a)?;
    if a.state != "prepared" {
        return Err("插件动作已处理；请依据保存的动作状态与回执，不重新准备相同内容".into());
    }
    let payload = a.payload.as_ref().ok_or("插件草稿缺失")?;
    Ok(
        json!({"actionId":a.id,"kind":"pluginWrite","state":a.state,"prepared":true,"executed":false,"targetUrl":payload["targetUrl"],"targetTitle":payload["targetTitle"],"arguments":payload["arguments"],"message":"评论草稿已保存，须用户确认后才执行；不是已发布回执"}),
    )
}
pub(super) fn fact(a: &Action) -> Result<Value, String> {
    let receipt = a.receipt.as_ref().ok_or("已核验插件动作缺少回执")?;
    if receipt["verified"] != true || receipt["domain"] != "githubIssueComment" {
        return Err("插件动作回执尚未核验".into());
    }
    Ok(
        json!({"origin":"host","actionId":a.id,"kind":"pluginWrite","receipt":receipt,"verification":"saved remote readback at checkedAt, not a fresh remote query","goalCompleted":false}),
    )
}
pub(super) fn view(c: &Connection, w: &Work, a: &Action, v: &mut Value) -> Result<(), String> {
    if w.state == "revoked" || a.authorization_version != w.authorization_version {
        v["payload"] = Value::Null;
        v["confirmationToken"] = Value::Null;
        return Ok(());
    }

    if a.state == "prepared" {
        match grant(a).and_then(|g| check_on(c, w, &g, Some(a), false)) {
            Ok(()) => {
                if w.active_run.is_none() {
                    v["confirmationToken"] = json!(token(a));
                }
            }
            Err(error) => {
                v["state"] = json!("expired");
                v["payload"] = Value::Null;
                v["error"] = json!(error);
            }
        }
    }
    if a.state == "unknown" {
        v["confirmationToken"] = json!(token(a));
    }
    Ok(())
}

type LiveKey = (PathBuf, String);
fn live() -> &'static std::sync::Mutex<HashSet<LiveKey>> {
    static LIVE: std::sync::OnceLock<std::sync::Mutex<HashSet<LiveKey>>> =
        std::sync::OnceLock::new();
    LIVE.get_or_init(Default::default)
}
struct Running(LiveKey);
impl Drop for Running {
    fn drop(&mut self) {
        if let Ok(mut live) = live().lock() {
            live.remove(&self.0);
        }
    }
}
pub(super) fn reconcile(root: &Path, work: &str) -> Result<(), String> {
    let live = live().lock().map_err(|_| "插件运行状态不可用")?;
    let c = crate::source_evidence::open_read_database(root)?;
    let mut query=c.prepare("SELECT id FROM agent_actions WHERE work_id=?1 AND kind='pluginWrite' AND state='executing'").map_err(|e|e.to_string())?;
    let ids = query
        .query_map([work], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(query);
    drop(c);
    for id in ids {
        if !live.contains(&(root_key(root), id.clone())) {
            store::write(root, |c| {
                c.execute("UPDATE agent_actions SET state='unknown',error='执行已中断，可能已有远端写入；请核对结果，禁止自动重发',updated_at=?2 WHERE id=?1 AND state='executing'",params![id,stamp()]).map_err(|e|e.to_string())?;
                Ok(())
            })?;
        }
    }
    Ok(())
}

pub(in crate::agent_work) fn ui(root: &Path, args: &Value) -> Result<Value, String> {
    let work = text(args, "id", 150)?;
    let id = text(args, "actionId", 150)?;
    let confirmation = text(args, "confirmationToken", 100)?;
    let execute = args["action"] == "submitPluginWrite";
    let mut live = live().lock().map_err(|_| "插件运行状态不可用")?;
    let key = (root_key(root), id.clone());
    if live.contains(&key) {
        return Err("插件动作正在执行或核对，请等待结果".into());
    }
    let claimed = store::write(root, |c| {
        let a = load(c, &work, &id)?;
        if a.kind != "pluginWrite" || token(&a) != confirmation {
            return Err("插件动作确认与当前草稿不匹配".into());
        }
        if a.state == "verified" {
            return Ok(None);
        }
        if (execute && a.state != "prepared") || (!execute && a.state != "unknown") {
            return Err("此动作不可再次写入；结果未知时只能核对，不能重发".into());
        }
        let w = store::load(c, &work)?;
        let grant = grant(&a)?;
        check_on(c, &w, &grant, Some(&a), true)?;
        let mut receipt=a.receipt.clone().unwrap_or_else(||json!({"confirmedBy":"user","confirmedAt":stamp(),"writeDispatched":execute,"goalCompleted":false}));
        receipt["lastCheckAt"] = json!(stamp());
        c.execute("UPDATE agent_actions SET state='executing',receipt_json=?2,error=NULL,updated_at=?3 WHERE id=?1",params![id,receipt.to_string(),stamp()]).map_err(|e|e.to_string())?;
        Ok(Some((w, a, grant)))
    })?;
    let Some((w, a, grant)) = claimed else {
        drop(live);
        return status(root, &work);
    };
    live.insert(key.clone());
    drop(live);
    let running = Running(key);
    let control = Control::bounded(std::time::Duration::from_secs(120));
    let check = || {
        let c = crate::source_evidence::open_read_database(root)?;
        check_on(&c, &w, &grant, Some(&a), true)
    };
    let outcome = apps::comment_write(
        root,
        a.payload.as_ref().unwrap(),
        &id,
        execute,
        &control,
        check,
    );
    store::write(root, |c| {
        let mut receipt = load(c, &work, &id)?.receipt.unwrap_or_else(|| json!({}));
        if let Ok(result) = &outcome {
            for (key, value) in result.as_object().ok_or("插件回执格式无效")? {
                receipt[key] = value.clone();
            }
        }
        receipt["checkedAt"] = json!(stamp());
        match &outcome {
            Ok(_) => {
                c.execute("UPDATE agent_actions SET state='verified',receipt_json=?2,error=NULL,updated_at=?3 WHERE id=?1 AND state='executing'",params![id,receipt.to_string(),stamp()]).map_err(|e|e.to_string())?;
            }
            Err(error) => {
                c.execute("UPDATE agent_actions SET state='unknown',error=?2,updated_at=?3 WHERE id=?1 AND state='executing'",params![id,error.chars().take(300).collect::<String>(),stamp()]).map_err(|e|e.to_string())?;
            }
        }
        Ok(())
    })?;
    drop(running);
    // Unknown is a durable outcome, not a transport exception that invites a
    // caller to retry the original mutation.
    status(root, &work)
}

#[cfg(test)]
mod tests;
