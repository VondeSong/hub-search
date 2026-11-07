//! Finite post-failure file verification, separate from model execution quota.
//! An attempt is charged before touching the source; unknown outcomes retain it.
use super::*;
use std::collections::BTreeMap;

const WORK_CHECKS: usize = 80;
const ACTION_CHECKS: usize = 4;

fn facts(c: &Connection, id: &str, kind: &str) -> Result<Vec<Value>, String> {
    let mut q = c
        .prepare("SELECT body_json FROM agent_records WHERE work_id=?1 AND kind=?2 ORDER BY rowid")
        .map_err(|e| e.to_string())?;
    let result = q
        .query_map(params![id, kind], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .map(|r| {
            serde_json::from_str(&r.map_err(|e| e.to_string())?)
                .map_err(|_| "核验额度记录损坏".into())
        })
        .collect();
    result
}

fn state_on(c: &Connection, w: &Work) -> Result<(bool, usize, BTreeMap<String, usize>), String> {
    let policies = facts(c, &w.id, "recoveryBudgetPolicy")?;
    if policies.len() > 1
        || policies.first().is_some_and(|p| {
            p["schemaVersion"] != 1
                || p["rootWorkId"] != w.id
                || p["workChecks"] != WORK_CHECKS
                || p["actionChecks"] != ACTION_CHECKS
        })
    {
        return Err("核验额度版本或上限不可用；旧回执保留，未开始新核验".into());
    }
    let attempts = facts(c, &w.id, "recoveryBudgetAttempt")?;
    let mut per_action = BTreeMap::new();
    for a in &attempts {
        if a["schemaVersion"] != 1 || a["rootWorkId"] != w.id {
            return Err("核验尝试的版本或事项身份不可用".into());
        }
        let id = a["actionId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("核验动作身份不可用")?;
        *per_action.entry(id.to_owned()).or_insert(0) += 1;
    }
    if policies.is_empty() && !attempts.is_empty() {
        return Err("核验尝试缺少持久额度根".into());
    }
    Ok((!policies.is_empty(), attempts.len(), per_action))
}

pub(in crate::agent_work) fn view_on(c: &Connection, w: &Work) -> Result<Value, String> {
    let (_, used, per_action) = state_on(c, w)?;
    Ok(
        json!({"schemaVersion":1,"rootWorkId":w.id,"state":if used>=WORK_CHECKS {"exhausted"}else{"available"},
        "attemptsUsed":used,"workChecks":WORK_CHECKS,"actionChecks":ACTION_CHECKS,"perAction":per_action,
        "scope":"post-failure Obsidian file/index verification; no model or source-write permission"}),
    )
}

pub(in crate::agent_work) fn reserve(
    root: &Path,
    w: &Work,
    action: &str,
    origin: &str,
) -> Result<(), String> {
    if !matches!(origin, "automatic" | "user") {
        return Err("未知核验入口".into());
    }
    write(root, |c| {
        let current = load(c, &w.id)?;
        if current.state == "revoked"
            || current.authorization_version != w.authorization_version
            || current.action_target_identity != w.action_target_identity
            || !current.action_target_authorized()
        {
            return Err("核验授权已变化，未读取原文件".into());
        }
        let eligible:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_actions WHERE id=?1 AND work_id=?2 AND kind='obsidianEdit' AND receipt_json IS NOT NULL)",params![action,w.id],|r|r.get(0)).map_err(|e|e.to_string())?;
        if !eligible {
            return Err("没有属于本事项的待核对写入回执".into());
        }
        let (configured, used, per_action) = state_on(c, &current)?;
        if used >= WORK_CHECKS || per_action.get(action).copied().unwrap_or(0) >= ACTION_CHECKS {
            return Err("核验额度已用尽；保留上次状态与回执，未再次执行保存核验或索引更新".into());
        }
        if !configured {
            insert(
                c,
                &w.id,
                None,
                "recoveryBudgetPolicy",
                &json!({"schemaVersion":1,"rootWorkId":w.id,"workChecks":WORK_CHECKS,"actionChecks":ACTION_CHECKS,"origin":"existing20ActionCeilingFourPostFailureChecksEach"}),
            )?;
        }
        insert(
            c,
            &w.id,
            None,
            "recoveryBudgetAttempt",
            &json!({"schemaVersion":1,"rootWorkId":w.id,"actionId":action,"origin":origin,
            "workRevision":current.revision,"authorizationVersion":current.authorization_version,"startedAt":stamp(),"outcomeOwner":"agent_actions; this entry only reserves one verification attempt"}),
        )
    })
}
