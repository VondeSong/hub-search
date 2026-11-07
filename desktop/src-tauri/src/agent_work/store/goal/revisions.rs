//! Model interpretations of durable user commands. Never an authorization writer.
use super::*;
use std::collections::BTreeSet;
mod protocol;
mod validation;
pub(in crate::agent_work) use protocol::schema;
#[cfg(test)]
mod tests;

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Grounded {
    text: String,
    source_refs: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Clause {
    item_id: String,
    kind: String,
    text: String,
    source_refs: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Content {
    effective_goal: Grounded,
    items: Vec<Clause>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Retirement {
    item_id: String,
    source_command_id: String,
    reason: String,
    replacement_ids: Vec<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Revision {
    schema_version: u32,
    work_id: String,
    revision: u64,
    user_binding: Value,
    scope_revision: i64,
    supersedes: Option<u64>,
    source_command_id: String,
    source_refs: Vec<String>,
    content: Content,
    retirements: Vec<Retirement>,
    rationale: String,
}

fn load_on(c: &Connection, work: &Work, revision: Option<u64>) -> Result<Option<Revision>, String> {
    let raw:Option<String>=c.query_row("SELECT body_json FROM agent_records WHERE work_id=?1 AND kind='goalRevision' AND (?2 IS NULL OR json_extract(body_json,'$.revision')=?2) ORDER BY rowid DESC LIMIT 1",params![work.id,revision],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    raw.map(|s| {
        let saved: Revision = serde_json::from_str(&s).map_err(|_| "目标解释记录损坏")?;
        if saved.schema_version != 1 || saved.work_id != work.id || saved.revision == 0 {
            return Err("目标解释版本或事项身份无效".into());
        }
        Ok(saved)
    })
    .transpose()
}
pub(in crate::agent_work) fn number_on(c: &Connection, work: &Work) -> Result<u64, String> {
    Ok(load_on(c, work, None)?.map_or(0, |r| r.revision))
}
pub(in crate::agent_work) fn view_on(c: &Connection, work: &Work) -> Result<Value, String> {
    project_on(c, work, None)
}
fn project_on(c: &Connection, work: &Work, requested: Option<u64>) -> Result<Value, String> {
    let saved = load_on(c, work, requested)?;
    if requested.is_some() && saved.is_none() {
        return Err("目标解释版本不存在于当前事项".into());
    }
    let sources = completion::sources_on(c, work)?;
    let Some(saved) = saved else {
        return Ok(
            json!({"schemaVersion":1,"revision":0,"state":"notInterpreted",
        "goalBinding":binding_on(c,work)?,"sourceCommandId":command_on(c,work)?,"sources":sources,
        "effectiveGoal":null,"constraints":[],"acceptanceCriteria":[],"unresolvedAmbiguities":[],"history":[]}),
        );
    };
    let latest = number_on(c, work)?;
    let state = if saved.revision != latest {
        "historical"
    } else if saved.user_binding != user_binding_on(c, work)? {
        "needsRevision"
    } else {
        "current"
    };
    let select = |kind: &str| {
        saved
            .content
            .items
            .iter()
            .filter(|i| i.kind == kind)
            .cloned()
            .collect::<Vec<_>>()
    };
    let history:Vec<_>=records_on(c,&work.id,"goalRevision",8)?.into_iter().map(|r|json!({"revision":r["revision"],"supersedes":r["supersedes"],"rationale":r["rationale"]})).collect();
    Ok(
        json!({"schemaVersion":1,"workId":work.id,"revision":saved.revision,"currentRevision":latest,"state":state,
        "goalBinding":binding_on(c,work)?,"userBinding":saved.user_binding,"scopeRevision":saved.scope_revision,
        "sourceCommandId":command_on(c,work)?,"interpretedCommandId":saved.source_command_id,
        "sourceRefs":saved.source_refs,"sources":sources,"effectiveGoal":saved.content.effective_goal,
        "constraints":select("constraint"),"acceptanceCriteria":select("acceptanceCriterion"),"unresolvedAmbiguities":select("ambiguity"),
        "supersedes":saved.supersedes,"retirements":saved.retirements,"rationale":saved.rationale,"history":history,
        "semanticStatusSource":"modelInterpretation","authority":"userCommands","grantsAuthority":false}),
    )
}

pub(in crate::agent_work) fn requirements_on(
    c: &Connection,
    work: &Work,
) -> Result<Vec<Value>, String> {
    let Some(saved) = load_on(c, work, None)? else {
        return Ok(vec![]);
    };
    let mut result = vec![
        json!({"requirementId":format!("{}:goal:effective",work.id),"origin":"modelInterpretation","text":saved.content.effective_goal.text,"sourceRefs":saved.content.effective_goal.source_refs}),
    ];
    result.extend(saved.content.items.iter().map(|i|json!({"requirementId":format!("{}:goal:{}",work.id,i.item_id),"origin":"modelInterpretation","kind":i.kind,"text":i.text,"sourceRefs":i.source_refs})));
    Ok(result)
}

pub(in crate::agent_work) fn execute(
    root: &Path,
    work: &Work,
    run: &str,
    request: &Value,
    control: &Control,
) -> Result<Value, String> {
    control.check()?;
    if request.to_string().len() > 32_768 {
        return Err("目标解释补丁超过容量".into());
    }
    crate::model_runtime::validate_agent_tool(request, &schema())?;
    let decoded: protocol::Request =
        serde_json::from_value(request.clone()).map_err(|_| "目标解释格式无效")?;
    if let protocol::Request::Read { revision } = &decoded {
        let c = read(root)?;
        c.execute_batch("BEGIN DEFERRED")
            .map_err(|e| e.to_string())?;
        let current = current_run_on(&c, work, run)?;
        return project_on(&c, &current, *revision);
    }
    let protocol::Request::Revise {
        operation_id,
        expected_goal_binding,
        expected_goal_revision,
        source_command_id,
        content,
        retirements,
        rationale,
    } = decoded
    else {
        unreachable!()
    };
    let hash = format!("{:x}", Sha256::digest(request.to_string().as_bytes()));
    write(root, |c| {
        control.check()?;
        let current = current_run_on(c, work, run)?;
        let prior:Option<String>=c.query_row("SELECT body_json FROM agent_records WHERE work_id=?1 AND kind='goalRevisionOperation' AND json_extract(body_json,'$.operationId')=?2 ORDER BY rowid DESC LIMIT 1",params![work.id,operation_id],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        if let Some(raw) = prior {
            let receipt: Value = serde_json::from_str(&raw).map_err(|_| "目标修订回执损坏")?;
            if receipt["requestHash"] != hash {
                return Err("目标修订操作身份与已保存内容冲突".into());
            }
            return Ok(json!({"replayed":true,"receipt":receipt,"state":view_on(c,&current)?}));
        }
        ensure_binding_on(c, &current, &expected_goal_binding)?;
        let old = load_on(c, &current, None)?;
        let old_number = old.as_ref().map_or(0, |r| r.revision);
        if old_number != expected_goal_revision {
            return Err("目标解释版本已改变，请重读后修订".into());
        }
        if command_on(c, &current)? != source_command_id {
            return Err("目标解释必须绑定当前用户命令".into());
        }
        let sources = completion::sources_on(c, &current)?;
        let refs = validation::check(
            c,
            &current,
            old.as_ref(),
            &content,
            &retirements,
            &sources,
            &source_command_id,
        )?;
        if rationale.trim().is_empty() {
            return Err("目标修订需要说明解释或替代理由".into());
        }
        let user_binding = user_binding_on(c, &current)?;
        let unchanged = old
            .as_ref()
            .is_some_and(|r| r.content == content && r.user_binding == user_binding)
            && retirements.is_empty();
        let revision = if unchanged {
            old_number
        } else {
            old_number + 1
        };
        if !unchanged {
            let saved = Revision {
                schema_version: 1,
                work_id: work.id.clone(),
                revision,
                user_binding,
                scope_revision: current.authorization_version,
                supersedes: old.as_ref().map(|r| r.revision),
                source_command_id: source_command_id.clone(),
                source_refs: refs,
                content,
                retirements,
                rationale,
            };
            let value = serde_json::to_value(saved).map_err(|e| e.to_string())?;
            if value.to_string().len() > 32_768 {
                return Err("目标解释快照超过容量".into());
            }
            insert(c, &work.id, Some(run), "goalRevision", &value)?;
            super::super::tasks::revalidate_on(root, c, &current)?;
        }
        let receipt = json!({"operationId":operation_id,"requestHash":hash,"committedRevision":revision,"changed":!unchanged,"sourceCommandId":source_command_id});
        insert(c, &work.id, Some(run), "goalRevisionOperation", &receipt)?;
        control.check()?;
        Ok(json!({"replayed":false,"receipt":receipt,"state":view_on(c,&current)?}))
    })
}
