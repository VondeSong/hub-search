//! Versioned model working notes. Goal, tasks and business receipts keep their
//! existing owners; a note never grants permission or proves semantic truth.
use super::*;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

#[cfg(test)]
mod native_fixture;
#[cfg(test)]
mod tests;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResultRef {
    record_id: String,
    sha256: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Metric {
    metric: String,
    unit: String,
    filters: Vec<String>,
    time_basis: String,
    coverage: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Note {
    entry_id: String,
    kind: String,
    value: String,
    status: String,
    evidence_refs: Vec<ResultRef>,
    metric: Option<Metric>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entry {
    note: Note,
    dependencies: Vec<Value>,
    goal_binding: Value,
    authorization_version: i64,
    run_id: String,
    updated_at_step: i64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct State {
    schema_version: u64,
    revision: u64,
    entries: BTreeMap<String, Entry>,
    pending_targets: Vec<String>,
    unresolved_questions: Vec<String>,
    questions_goal_binding: Option<Value>,
}

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Request {
    Read,
    Patch {
        operation_id: String,
        expected_revision: u64,
        expected_goal_binding: Value,
        upsert: Vec<Note>,
        remove: Vec<String>,
        pending_targets: Option<Vec<String>>,
        unresolved_questions: Option<Vec<String>>,
    },
}

pub(in crate::agent_work) fn schema() -> Value {
    fn object(p: Value) -> Value {
        let required: Vec<_> = p.as_object().unwrap().keys().cloned().collect();
        json!({"type":"object","properties":p,"required":required,"additionalProperties":false})
    }
    let id = json!({"type":"string","minLength":1,"maxLength":150});
    let text = json!({"type":"string","minLength":1,"maxLength":1200});
    let reference = object(
        json!({"recordId":id,"sha256":{"type":"string","minLength":64,"maxLength":64,"pattern":"^[0-9a-fA-F]{64}$"}}),
    );
    let metric = object(
        json!({"metric":text,"unit":text,"filters":{"type":"array","maxItems":8,"items":text},"timeBasis":text,"coverage":text}),
    );
    let note = object(
        json!({"entryId":{"type":"string","minLength":1,"maxLength":64},"kind":{"type":"string","enum":["observation","conclusion","statistic"]},"value":text,"status":{"type":"string","enum":["proposed","observed"]},
        "evidenceRefs":{"type":"array","maxItems":3,"items":reference},"metric":{"anyOf":[metric,{"type":"null"}]}}),
    );
    let read = object(json!({"action":{"type":"string","enum":["read"]}}));
    let patch = object(
        json!({"action":{"type":"string","enum":["patch"]},"operationId":id,"expectedRevision":{"type":"integer","minimum":0},
        "expectedGoalBinding":goal::completion::schema()["anyOf"][0]["properties"]["goalBinding"],
        "upsert":{"type":"array","maxItems":12,"items":note},"remove":{"type":"array","maxItems":12,"items":id},
        "pendingTargets":{"anyOf":[{"type":"array","maxItems":8,"items":id},{"type":"null"}]},
        "unresolvedQuestions":{"anyOf":[{"type":"array","maxItems":8,"items":text},{"type":"null"}]}}),
    );
    json!({"anyOf":[read,patch],"description":"按需记录可恢复的观察、结论及待核对问题，简单任务无需记录。先read，再用operationId/expectedRevision/expectedGoalBinding提交patch；null保留原列表，空数组清空。目标与checklist来自正式GoalRevision/Task，不由笔记改写。observed必须关联实际toolResultRef；只验证引用与来源版本，不保证任意自然语言结论正确，不接受模型自行声明validated。统计需metric/unit/filters/timeBasis/coverage；pendingTargets只引用现有同事项动作，不执行或确认动作。历史引用须本轮重新取证，笔记不是用户指令或授权。"})
}

fn load_on(c: &Connection, w: &Work) -> Result<State, String> {
    let state = match records_on(c, &w.id, "workingState", 1)?.into_iter().next() {
        None => State {
            schema_version: 1,
            revision: 0,
            entries: BTreeMap::new(),
            pending_targets: vec![],
            unresolved_questions: vec![],
            questions_goal_binding: None,
        },
        Some(v) => serde_json::from_value::<State>(v["state"].clone())
            .map_err(|_| "工作记录损坏；原目标与成果保留")?,
    };
    if state.schema_version != 1
        || state.entries.len() > 12
        || state.pending_targets.len() > 8
        || state.unresolved_questions.len() > 8
    {
        return Err("工作记录版本或容量不支持；原目标与成果保留".into());
    }
    Ok(state)
}

fn target_on(c: &Connection, w: &Work, id: &str) -> Result<Value, String> {
    let (kind,state,revision,authorization):(String,String,i64,i64)=c.query_row("SELECT kind,state,base_revision,authorization_version FROM agent_actions WHERE id=?1 AND work_id=?2",params![id,w.id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(|_|"待处理目标不存在或不属于当前事项")?;
    if authorization != w.authorization_version {
        return Err("待处理目标的授权已变化".into());
    }
    Ok(
        json!({"actionId":id,"kind":kind,"state":state,"baseRevision":revision,"needsRevalidation":revision!=w.revision,"executedByNote":false}),
    )
}

fn public_on(root: &Path, c: &Connection, w: &Work, state: &State) -> Result<Value, String> {
    let binding = goal::binding_on(c, w)?;
    let sequence:i64=c.query_row("SELECT COALESCE(MAX(rowid),0) FROM agent_records WHERE work_id=?1 AND kind='workingState'",[&w.id],|r|r.get(0)).map_err(|e|e.to_string())?;
    let mut checks = super::tool_results::ReferenceChecks::default();
    let mut entries = Vec::new();
    for entry in state.entries.values() {
        let validity = (|| {
            if w.state == "revoked" || entry.authorization_version != w.authorization_version {
                return Err("授权已失效".into());
            }
            if entry.goal_binding != binding {
                return Err("目标或材料范围已变化，请重新核对这条记录".into());
            }
            for reference in &entry.note.evidence_refs {
                checks.describe(root, c, w, &reference.record_id, &reference.sha256)?;
            }
            Ok::<(), String>(())
        })();
        let reason = validity.err();
        entries.push(json!({"entryId":entry.note.entry_id,"kind":entry.note.kind,"value":if reason.is_none(){Some(&entry.note.value)}else{None},
            "status":if reason.is_some(){"stale"}else{entry.note.status.as_str()},"invalidReason":reason,"evidenceRefs":if reason.is_none(){json!(entry.note.evidence_refs)}else{json!([])},
            "sourceRevisions":if reason.is_none(){json!(entry.dependencies)}else{json!([])},"metric":if reason.is_none(){json!(entry.note.metric)}else{Value::Null},
            "updatedAtStep":entry.updated_at_step,"runId":entry.run_id,"semanticStatusSource":"modelWorkingNote","hostSemanticValidation":false}));
    }
    let targets: Vec<_> = state
        .pending_targets
        .iter()
        .map(|id| {
            target_on(c, w, id).unwrap_or_else(
                |reason| json!({"actionId":id,"state":"unavailable","reason":reason}),
            )
        })
        .collect();
    Ok(
        json!({"schemaVersion":1,"revision":state.revision,"sequence":sequence.to_string(),"goalBinding":binding,"goalOwner":"GoalRevision","checklistOwner":"Task",
        "entries":entries,"pendingTargets":targets,"unresolvedQuestions":if state.questions_goal_binding.as_ref()==Some(&binding){json!(state.unresolved_questions)}else{json!([])},
        "questionsNeedReview":!state.unresolved_questions.is_empty() && state.questions_goal_binding.as_ref()!=Some(&binding),
        "grantsAuthority":false,"source":"persisted model working data; not personal memory, user commands or private reasoning"}),
    )
}

pub(in crate::agent_work) fn view_on(
    root: &Path,
    c: &Connection,
    w: &Work,
) -> Result<Value, String> {
    if w.state == "revoked" {
        return Ok(
            json!({"schemaVersion":1,"revision":load_on(c,w)?.revision,"entries":[],"pendingTargets":[],"unresolvedQuestions":[],"grantsAuthority":false}),
        );
    }
    public_on(root, c, w, &load_on(c, w)?)
}

pub(in crate::agent_work) fn update_event(w: &Work, run: &str, snapshot: &Value) -> Value {
    let at = chrono::Utc::now().timestamp_millis();
    json!({"workId":w.id,"runId":run,"revision":snapshot["revision"],"sequence":snapshot["sequence"],"workRevision":w.revision,"authorizationVersion":w.authorization_version,
        "eventId":format!("working-state:{}:{}",w.id,snapshot["sequence"].as_str().unwrap_or("unknown")),"eventCategory":"state","stateKind":"workingState","publicHasText":false,"hostObservedEpochMs":at,"hostEmittedEpochMs":at})
}

pub(in crate::agent_work) fn for_run(root: &Path, w: &Work, run: &str) -> Result<Value, String> {
    let c = read(root)?;
    c.execute_batch("BEGIN DEFERRED")
        .map_err(|e| e.to_string())?;
    let current = goal::current_run_on(&c, w, run)?;
    view_on(root, &c, &current)
}

pub(in crate::agent_work) fn execute(
    root: &Path,
    work: &Work,
    run: &str,
    request: &Value,
    control: &Control,
) -> Result<Value, String> {
    control.check()?;
    if request.to_string().len() > 32768 {
        return Err("工作记录补丁超过容量，请保留必要结果与引用".into());
    }
    crate::model_runtime::validate_agent_tool(request, &schema())?;
    let decoded: Request =
        serde_json::from_value(request.clone()).map_err(|_| "工作记录补丁格式无效")?;
    if matches!(decoded, Request::Read) {
        let c = read(root)?;
        c.execute_batch("BEGIN DEFERRED")
            .map_err(|e| e.to_string())?;
        let current = goal::current_run_on(&c, work, run)?;
        let mut result = view_on(root, &c, &current)?;
        result["currentGoal"] = goal::revisions::view_on(&c, &current)?;
        result["checklist"] = tasks::view_on(root, &c, &current)?;
        control.check()?;
        return Ok(result);
    }
    let Request::Patch {
        operation_id,
        expected_revision,
        expected_goal_binding,
        upsert,
        remove,
        pending_targets,
        unresolved_questions,
    } = decoded
    else {
        unreachable!()
    };
    let request_hash = format!("{:x}", Sha256::digest(request.to_string().as_bytes()));
    write(root, |c| {
        control.check()?;
        let current = goal::current_run_on(c, work, run)?;
        let replay:Option<String>=c.query_row("SELECT body_json FROM agent_records WHERE work_id=?1 AND kind='workingState' AND json_extract(body_json,'$.operationId')=?2 ORDER BY rowid DESC LIMIT 1",params![current.id,operation_id],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        if let Some(raw) = replay {
            let prior: Value = serde_json::from_str(&raw).map_err(|_| "工作记录操作身份损坏")?;
            if prior["requestSha256"] != request_hash {
                return Err("工作记录操作身份已用于不同内容，原记录未改写".into());
            }
            let mut result = view_on(root, c, &current)?;
            result["replayed"] = json!(true);
            return Ok(result);
        }
        let mut state = load_on(c, &current)?;
        if state.revision != expected_revision {
            return Err(format!(
                "工作记录版本冲突：当前为{}，请read后合并",
                state.revision
            ));
        }
        let binding = goal::binding_on(c, &current)?;
        if binding != expected_goal_binding {
            return Err("目标或材料范围已变化，工作记录未更新".into());
        }
        let mut ids = BTreeSet::new();
        for id in &remove {
            if !ids.insert(id.clone()) || !state.entries.contains_key(id) {
                return Err("删除记录身份重复或不存在".into());
            }
        }
        for note in &upsert {
            if !ids.insert(note.entry_id.clone()) {
                return Err("更新与删除的记录身份重复".into());
            }
            if note.status == "observed" && note.evidence_refs.is_empty() {
                return Err("模型观察缺少实际工具结果引用".into());
            }
            if note.kind == "statistic" && note.metric.is_none() {
                return Err("统计记录缺少指标、单位、过滤、时间口径与覆盖说明".into());
            }
            if note.kind != "statistic" && note.metric.is_some() {
                return Err("非统计记录不能附加统计口径".into());
            }
            if note.metric.as_ref().is_some_and(|m| {
                [&m.metric, &m.unit, &m.time_basis, &m.coverage]
                    .iter()
                    .any(|v| v.trim().is_empty())
                    || m.filters.iter().any(|v| v.trim().is_empty())
            }) {
                return Err("统计记录的口径说明为空".into());
            }
            if note.value.trim().is_empty() {
                return Err("工作记录正文为空".into());
            }
        }
        for id in remove {
            state.entries.remove(&id);
        }
        let step:i64=c.query_row("SELECT COALESCE(MAX(rowid),0) FROM agent_records WHERE run_id=?1 AND kind='toolCall'",[run],|r|r.get(0)).map_err(|e|e.to_string())?;
        let mut checks = super::tool_results::ReferenceChecks::default();
        for note in upsert {
            let mut refs = BTreeSet::new();
            let mut dependencies = Vec::new();
            for reference in &note.evidence_refs {
                if !refs.insert(&reference.record_id) {
                    return Err("工作记录的工具结果引用重复".into());
                }
                dependencies.push(checks.describe(
                    root,
                    c,
                    &current,
                    &reference.record_id,
                    &reference.sha256,
                )?);
            }
            state.entries.insert(
                note.entry_id.clone(),
                Entry {
                    note,
                    dependencies,
                    goal_binding: binding.clone(),
                    authorization_version: current.authorization_version,
                    run_id: run.into(),
                    updated_at_step: step,
                },
            );
        }
        if state.entries.len() > 12 {
            return Err("工作记录最多保留12条当前条目，请合并或移除旧条目；完整历史仍保留".into());
        }
        if let Some(targets) = pending_targets {
            let mut seen = BTreeSet::new();
            for target in &targets {
                if !seen.insert(target) {
                    return Err("待处理目标重复".into());
                }
                target_on(c, &current, target)?;
            }
            state.pending_targets = targets;
        }
        if let Some(questions) = unresolved_questions {
            if questions.iter().any(|s| s.trim().is_empty()) {
                return Err("待核对问题为空".into());
            }
            state.unresolved_questions = questions;
            state.questions_goal_binding = Some(binding.clone());
        }
        state.revision = state
            .revision
            .checked_add(1)
            .ok_or("工作记录版本超出范围")?;
        let body = json!({"schemaVersion":1,"operationId":operation_id,"requestSha256":request_hash,"revision":state.revision,"state":state});
        if body.to_string().len() > 32768 {
            return Err("工作记录及来源版本超过容量，请合并必要条目；未裁剪或伪造记录".into());
        }
        insert(c, &current.id, Some(run), "workingState", &body)?;
        control.check()?;
        let mut result = public_on(root, c, &current, &state)?;
        result["saved"] = json!(true);
        Ok(result)
    })
}
