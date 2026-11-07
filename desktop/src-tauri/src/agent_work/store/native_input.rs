//! Durable input requests reuse Run records and the existing user-message recovery chain.
use super::*;

fn turn_on(c: &Connection, run: &str) -> Result<Value, String> {
    let raw: Option<String> = c.query_row("SELECT body_json FROM agent_records WHERE run_id=?1 AND kind='nativeTurn' ORDER BY rowid DESC LIMIT 1", [run], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
    raw.map(|s| serde_json::from_str(&s).map_err(|_| "原生轮次记录损坏".into()))
        .unwrap_or(Ok(Value::Null))
}
fn live(c: &Connection, work: &Work, run: &str, request: &Value) -> Result<(), String> {
    let current = load(c, &work.id)?;
    let turn = turn_on(c, run)?;
    if current.state != "investigating"
        || current.active_run.as_deref() != Some(run)
        || current.revision != work.revision
        || current.authorization_version != work.authorization_version
        || request["threadId"] != turn["threadId"]
        || request["turnId"] != turn["turnId"]
    {
        return Err("问题所属轮次已结束或授权已改变；请在新消息中补充".into());
    }
    Ok(())
}
fn request_on(c: &Connection, work: &str, run: &str, key: &str) -> Result<Value, String> {
    let raw: String = c.query_row("SELECT body_json FROM agent_records WHERE work_id=?1 AND run_id=?2 AND kind='nativeUserInput' AND json_extract(body_json,'$.key')=?3 ORDER BY rowid DESC LIMIT 1",params![work,run,key],|r|r.get(0)).map_err(|_|"问题不存在或不属于当前对话")?;
    serde_json::from_str(&raw).map_err(|_| "问题记录损坏".into())
}
fn state_on(c: &Connection, run: &str, key: &str, kind: &str) -> Result<Value, String> {
    let raw: Option<String> = c.query_row("SELECT body_json FROM agent_records WHERE run_id=?1 AND kind='nativeInputState' AND json_extract(body_json,'$.key')=?2 AND (?3='' OR json_extract(body_json,'$.state')=?3) ORDER BY rowid DESC LIMIT 1",params![run,key,kind],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    raw.map(|s| serde_json::from_str(&s).map_err(|_| "问题状态损坏".into()))
        .unwrap_or(Ok(json!({"state":"pending"})))
}

pub(in crate::agent_work) fn requested(
    root: &Path,
    work: &Work,
    run: &str,
    value: &Value,
) -> Result<(), String> {
    write(root, |c| {
        live(c, work, run, value)?;
        let key = super::super::text(value, "key", 64)?;
        let exists:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_records WHERE work_id=?1 AND run_id=?2 AND kind='nativeUserInput' AND json_extract(body_json,'$.key')=?3)",params![work.id,run,key],|r|r.get(0)).map_err(|e|e.to_string())?;
        if exists {
            let old = request_on(c, &work.id, run, &key)?;
            let mut saved = old;
            for field in ["runId", "revision", "authorizationVersion"] {
                saved.as_object_mut().unwrap().remove(field);
            }
            return if &saved == value {
                Ok(())
            } else {
                Err("同一问题身份对应不同内容".into())
            };
        }
        let count: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM agent_records WHERE run_id=?1 AND kind='nativeUserInput'",
                [run],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if count >= 8 {
            return Err("本轮提问数量已达上限".into());
        }
        let mut body = value.clone();
        body["runId"] = json!(run);
        body["revision"] = json!(work.revision);
        body["authorizationVersion"] = json!(work.authorization_version);
        insert(c, &work.id, Some(run), "nativeUserInput", &body)
    })
}

pub(in crate::agent_work) fn respond(root: &Path, args: &Value) -> Result<bool, String> {
    let id = super::super::text(args, "id", 150)?;
    let run = super::super::text(args, "runId", 150)?;
    let key = super::super::text(args, "key", 64)?;
    write(root, |c| {
        let work = load(c, &id)?;
        let request = request_on(c, &id, &run, &key)?;
        if request["delivery"] == "async" {
            return respond_async_on(root, c, &work, &run, &key, &request, args);
        }
        if args["expectedRevision"] != work.revision
            || args["expectedAuthorizationVersion"] != work.authorization_version
        {
            return Err("对话或授权已改变，请刷新后回答".into());
        }
        live(c, &work, &run, &request)?;
        let cancel = args["cancel"].as_bool().ok_or("回答操作无效")?;
        let (response, text) =
            crate::model_runtime::agent_interaction::answer(&request, &args["answers"], cancel)?;
        let previous = state_on(c, &run, &key, "answered")?;
        if previous["state"] == "answered" {
            return if previous["response"] == response {
                Ok(false)
            } else {
                Err("该问题已经提交了不同的回答".into())
            };
        }
        if state_on(c, &run, &key, "")?["state"] != "pending" {
            return Err("该问题已经关闭，请在新消息中补充".into());
        }
        if records_on(c, &id, "steering", 32)?.len() >= 32 {
            return Err("本对话追加要求已达容量，请先完成当前工作".into());
        }
        let message = json!({"text":text,"clientMessageId":format!("native-input-{key}"),"runId":run,"revision":work.revision,"author":"user","nativeInputKey":key});
        insert(c, &id, Some(&run), "steering", &message)?;
        insert(
            c,
            &id,
            Some(&run),
            "nativeInputState",
            &json!({"key":key,"state":"answered","response":response,"message":message}),
        )?;
        Ok(false)
    })
}

fn respond_async_on(
    root: &Path,
    c: &Connection,
    work: &Work,
    run: &str,
    key: &str,
    request: &Value,
    args: &Value,
) -> Result<bool, String> {
    if work.state == "revoked"
        || request["authorizationVersion"] != work.authorization_version
        || args["expectedAuthorizationVersion"] != work.authorization_version
    {
        return Err("问题授权已改变，请刷新后再回答".into());
    }
    let cancel = args["cancel"].as_bool().ok_or("回答操作无效")?;
    let (response, text) =
        crate::model_runtime::agent_interaction::answer(request, &args["answers"], cancel)?;
    let previous = state_on(c, run, key, "answered")?;
    if previous["state"] == "answered" {
        return if previous["response"] == response {
            Ok(false)
        } else {
            Err("该问题已经提交了不同的回答".into())
        };
    }
    let latest: String = c
        .query_row(
            "SELECT id FROM agent_runs WHERE work_id=?1 ORDER BY rowid DESC LIMIT 1",
            [&work.id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if latest != run
        || request["revision"] != work.revision
        || args["expectedRevision"] != work.revision
        || request["threadId"] != turn_on(c, run)?["threadId"]
        || request["turnId"] != turn_on(c, run)?["turnId"]
    {
        return Err("问题所属对话已改变，请发送新的补充消息".into());
    }
    let message = json!({"text":text,"clientMessageId":format!("async-input-{key}"),"runId":run,"expectedRevision":work.revision});
    let start_new = work.active_run.is_none();
    if start_new {
        super::conversation::message_on(root, c, &work.id, &message)?;
    } else {
        super::conversation::steer_on(c, &work.id, &message)?;
    }
    insert(
        c,
        &work.id,
        Some(run),
        "nativeInputState",
        &json!({"key":key,"state":"answered","response":response,"message":message}),
    )?;
    Ok(start_new)
}

pub(in crate::agent_work) fn update(
    root: &Path,
    work: &Work,
    run: &str,
    value: &Value,
) -> Result<(), String> {
    let key = super::super::text(value, "key", 64)?;
    let state = value["state"]
        .as_str()
        .filter(|s| matches!(*s, "sent" | "resolved"))
        .ok_or("问题状态无效")?;
    write(root, |c| {
        let request = request_on(c, &work.id, run, &key)?;
        live(c, work, run, &request)?;
        let previous = state_on(c, run, &key, "")?;
        if previous["state"] == state || previous["state"] == "resolved" {
            return Ok(());
        }
        if state == "sent" && previous["state"] != "answered" {
            return Err("问题尚未保存回答".into());
        }
        insert(
            c,
            &work.id,
            Some(run),
            "nativeInputState",
            &json!({"key":key,"state":state}),
        )
    })
}

// A server-request reply has its own lifecycle, never a turn/steer acceptance ACK.
pub(super) fn resolved_answer_on(
    c: &Connection,
    work: &str,
    run: &str,
    message: &Value,
) -> Result<bool, String> {
    let Some(key) = message.get("nativeInputKey").and_then(Value::as_str) else {
        return Ok(false);
    };
    let request = request_on(c, work, run, key)?;
    let current = load(c, work)?;
    if current.state == "revoked"
        || request["runId"] != run
        || message["runId"] != run
        || request["revision"] != current.revision
        || request["authorizationVersion"] != current.authorization_version
    {
        return Ok(false);
    }
    let turn_exists:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_records WHERE work_id=?1 AND run_id=?2 AND kind='nativeTurn' AND json_extract(body_json,'$.threadId')=?3 AND json_extract(body_json,'$.turnId')=?4)",
        params![work,run,request["threadId"].as_str(),request["turnId"].as_str()],|r|r.get(0)).map_err(|e|e.to_string())?;
    let answered = state_on(c, run, key, "answered")?;
    Ok(turn_exists
        && answered["message"] == *message
        && answered["state"] == "answered"
        && state_on(c, run, key, "sent")?["state"] == "sent"
        && state_on(c, run, key, "")?["state"] == "resolved")
}

pub(in crate::agent_work) fn ready(
    root: &Path,
    work: &Work,
    run: &str,
    turn: &Value,
) -> Result<Value, String> {
    let c = read(root)?;
    let mut q=c.prepare("SELECT body_json FROM agent_records WHERE run_id=?1 AND kind='nativeUserInput' ORDER BY rowid").map_err(|e|e.to_string())?;
    let rows = q
        .query_map([run], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for raw in rows {
        let request: Value =
            serde_json::from_str(&raw.map_err(|e| e.to_string())?).map_err(|_| "问题记录损坏")?;
        if request["delivery"] == "async" {
            continue;
        }
        if request["threadId"] != turn["threadId"] || request["turnId"] != turn["turnId"] {
            continue;
        }
        live(&c, work, run, &request)?;
        let state = state_on(&c, run, request["key"].as_str().ok_or("问题身份缺失")?, "")?;
        if state["state"] == "answered" {
            result.push(state);
        }
    }
    Ok(json!(result))
}

pub(super) fn view_on(c: &Connection, work: &Work) -> Result<Value, String> {
    if work.state == "revoked" {
        return Ok(json!([]));
    }
    let run: Option<String> = c
        .query_row(
            "SELECT id FROM agent_runs WHERE work_id=?1 ORDER BY rowid DESC LIMIT 1",
            [&work.id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(run) = run else {
        return Ok(json!([]));
    };
    let turn = turn_on(c, &run)?;
    let mut q=c.prepare("SELECT body_json FROM agent_records WHERE run_id=?1 AND kind='nativeUserInput' ORDER BY rowid LIMIT 8").map_err(|e|e.to_string())?;
    let rows = q
        .query_map([&run], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for raw in rows {
        let mut request: Value =
            serde_json::from_str(&raw.map_err(|e| e.to_string())?).map_err(|_| "问题记录损坏")?;
        if request["authorizationVersion"] != work.authorization_version {
            continue;
        }
        let state = state_on(c, &run, request["key"].as_str().ok_or("问题身份缺失")?, "")?;
        request["state"] = if request["delivery"] == "async" {
            if state["state"] == "answered" {
                json!("answered")
            } else if request["revision"] == work.revision
                && request["turnId"] == turn["turnId"]
                && request["threadId"] == turn["threadId"]
            {
                json!("pending")
            } else {
                json!("closed")
            }
        } else if work.state != "investigating"
            || work.active_run.as_deref() != Some(&run)
            || request["turnId"] != turn["turnId"]
            || request["threadId"] != turn["threadId"]
        {
            json!("closed")
        } else {
            state["state"].clone()
        };
        result.push(request);
    }
    Ok(json!(result))
}

#[cfg(test)]
mod tests;
