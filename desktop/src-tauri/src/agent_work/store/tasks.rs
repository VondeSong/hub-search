//! Work-owned execution steps. Plans never remove user requirements or authorize actions.
use super::*;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

mod graph;
mod protocol;
pub(in crate::agent_work) use protocol::schema;
#[cfg(test)]
mod tests;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskSpec {
    task_id: String,
    parent_id: Option<String>,
    requirement_refs: Vec<String>,
    criterion: String,
    dependencies: Vec<String>,
    required_result: String,
    status: String,
    proof_ids: Vec<String>,
    review: String,
    blocker: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Evidence {
    goal_binding: Value,
    run_id: String,
    dependency_versions: BTreeMap<String, u64>,
    proof_versions: Vec<Value>,
    semantic_review: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Task {
    spec: TaskSpec,
    revision: u64,
    evidence: Option<Evidence>,
    needs_revalidation: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Tree {
    revision: u64,
    goal_binding: Value,
    tasks: BTreeMap<String, Task>,
    invalidations: Vec<Value>,
}

fn load_on(c: &Connection, work: &Work) -> Result<Tree, String> {
    match records_on(c, &work.id, "taskTree", 1)?.into_iter().next() {
        Some(value) => {
            serde_json::from_value(value["tree"].clone()).map_err(|_| "任务树记录损坏".into())
        }
        None => Ok(Tree {
            revision: 0,
            goal_binding: goal::binding_on(c, work)?,
            tasks: BTreeMap::new(),
            invalidations: vec![],
        }),
    }
}

fn public_on(c: &Connection, work: &Work, tree: &Tree) -> Result<Value, String> {
    let items: Vec<_> = tree
        .tasks
        .values()
        .map(|task| {
            let mut value = serde_json::to_value(&task.spec).expect("serializable task");
            value["revision"] = json!(task.revision);
            value["needsRevalidation"] = json!(task.needs_revalidation);
            value["completionEvidence"] = json!(task.evidence);
            value["semanticStatusSource"] = json!("modelTaskReview");
            value
        })
        .collect();
    Ok(
        json!({"schemaVersion":1,"revision":tree.revision,"goalBinding":tree.goal_binding,
        "sourceCommandId":goal::command_on(c,work)?,"tasks":items,"invalidations":tree.invalidations}),
    )
}

fn versions(tree: &Tree, id: &str) -> BTreeMap<String, u64> {
    graph::prerequisites(tree, id)
        .into_iter()
        .map(|id| {
            let revision = tree.tasks[&id].revision;
            (id, revision)
        })
        .collect()
}

fn ready(tree: &Tree, id: &str) -> bool {
    graph::prerequisites(tree, id)
        .iter()
        .all(|id| tree.tasks[id].spec.status == "done")
}

fn invalidate(tree: &mut Tree, id: &str, reason: &str) {
    let task = tree.tasks.get_mut(id).expect("validated task");
    let previous = task.revision;
    task.revision += 1;
    task.spec.status = "pending".into();
    task.needs_revalidation = Some(reason.into());
    // Keep the previous Evidence. A later successful check is a new snapshot;
    // earlier taskTree records remain immutable.
    tree.invalidations.push(json!({"taskId":id,"from":"done","to":"pending",
        "previousRevision":previous,"revision":task.revision,"reason":reason,"event":"needs_revalidation"}));
}

fn stale_reason(
    root: &Path,
    c: &Connection,
    work: &Work,
    tree: &Tree,
    id: &str,
    cache: &mut BTreeMap<String, Value>,
) -> Result<Option<&'static str>, String> {
    let task = &tree.tasks[id];
    if task.spec.status != "done" {
        return Ok(None);
    }
    let Some(evidence) = &task.evidence else {
        return Ok(Some("缺少历史完成证据，需要重新核对"));
    };
    if evidence.goal_binding != goal::binding_on(c, work)? {
        return Ok(Some("用户要求或授权已变化，需要重新核对"));
    }
    if !ready(tree, id) || evidence.dependency_versions != versions(tree, id) {
        return Ok(Some("依赖任务或子任务已变化，需要重新核对"));
    }
    if !evidence.proof_versions.is_empty() {
        if !cache.contains_key(&evidence.run_id) {
            cache.insert(
                evidence.run_id.clone(),
                goal::completion::proofs_on(root, c, work, &evidence.run_id).unwrap_or(json!([])),
            );
        }
        if !evidence.proof_versions.iter().all(|proof| {
            cache[&evidence.run_id]
                .as_array()
                .is_some_and(|ps| ps.contains(proof))
        }) {
            return Ok(Some("成果、来源或操作回执已变化，需要重新核对"));
        }
    }
    Ok(None)
}

fn project_on(root: &Path, c: &Connection, work: &Work) -> Result<(Tree, bool), String> {
    let mut tree = load_on(c, work)?;
    let order = graph::order(&tree)?;
    let binding = goal::binding_on(c, work)?;
    let goal_changed = tree.goal_binding != binding;
    let mut events = Vec::new();
    std::mem::swap(&mut events, &mut tree.invalidations);
    let mut cache = BTreeMap::new();
    for id in order {
        if let Some(reason) = stale_reason(root, c, work, &tree, &id, &mut cache)? {
            invalidate(&mut tree, &id, reason);
        }
    }
    let changed = goal_changed || !tree.invalidations.is_empty();
    if changed {
        tree.revision += 1;
        tree.goal_binding = binding;
    } else {
        tree.invalidations = events;
    }
    Ok((tree, changed))
}

fn save_on(
    c: &Connection,
    work: &Work,
    run: Option<&str>,
    tree: &Tree,
    origin: &str,
    operation: Option<(&str, &str)>,
) -> Result<(), String> {
    insert(
        c,
        &work.id,
        run,
        "taskTree",
        &json!({"schemaVersion":1,"tree":tree,"origin":origin,
        "sourceCommandId":goal::command_on(c,work)?,"operationId":operation.map(|v|v.0),"requestHash":operation.map(|v|v.1)}),
    )
}

pub(in crate::agent_work) fn revalidate_on(
    root: &Path,
    c: &Connection,
    work: &Work,
) -> Result<Value, String> {
    let (tree, changed) = project_on(root, c, work)?;
    if changed {
        save_on(c, work, None, &tree, "hostRevalidation", None)?;
    }
    public_on(c, work, &tree)
}

/// Fast read path avoids a write lock on every UI poll. If invalidated, the
/// writer rechecks against the latest state before recording the event.
pub(in crate::agent_work) fn refresh(root: &Path, id: &str) -> Result<(), String> {
    let changed = {
        let c = read(root)?;
        c.execute_batch("BEGIN DEFERRED")
            .map_err(|e| e.to_string())?;
        let work = load(&c, id)?;
        project_on(root, &c, &work)?.1
    };
    if changed {
        write(root, |c| {
            let work = load(c, id)?;
            revalidate_on(root, c, &work)?;
            Ok(())
        })?;
    }
    Ok(())
}

pub(in crate::agent_work) fn view_on(
    root: &Path,
    c: &Connection,
    work: &Work,
) -> Result<Value, String> {
    let (tree, _) = project_on(root, c, work)?;
    public_on(c, work, &tree)
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
        return Err("任务补丁超过容量，请分批调整步骤".into());
    }
    crate::model_runtime::validate_agent_tool(request, &schema())?;
    let decoded: protocol::Request =
        serde_json::from_value(request.clone()).map_err(|_| "任务补丁格式无效")?;
    if matches!(&decoded, protocol::Request::Read) {
        refresh(root, &work.id)?;
        let c = read(root)?;
        c.execute_batch("BEGIN DEFERRED")
            .map_err(|e| e.to_string())?;
        let current = goal::current_run_on(&c, work, run)?;
        return view_on(root, &c, &current);
    }
    let protocol::Request::Patch {
        operation_id,
        expected_goal_binding,
        expected_task_revision,
        source_command_id,
        upsert,
        remove,
    } = decoded
    else {
        unreachable!()
    };
    let hash = format!("{:x}", Sha256::digest(request.to_string().as_bytes()));
    write(root, |c| {
        control.check()?;
        let current = goal::current_run_on(c, work, run)?;
        let old:Option<String>=c.query_row("SELECT body_json FROM agent_records WHERE work_id=?1 AND kind='taskTree' AND json_extract(body_json,'$.operationId')=?2 ORDER BY rowid DESC LIMIT 1",params![work.id,operation_id],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        if let Some(raw) = old {
            let saved: Value = serde_json::from_str(&raw).map_err(|_| "任务操作回执损坏")?;
            if saved["requestHash"] != hash {
                return Err("任务操作身份与已保存内容冲突".into());
            }
            return Ok(
                json!({"replayed":true,"operationId":operation_id,"committedRevision":saved["tree"]["revision"],"state":revalidate_on(root,c,&current)?}),
            );
        }
        goal::ensure_binding_on(c, &current, &expected_goal_binding)?;
        if source_command_id != goal::command_on(c, &current)? {
            return Err("任务补丁必须绑定当前用户命令".into());
        }
        revalidate_on(root, c, &current)?;
        let mut tree = load_on(c, &current)?;
        if tree.revision != expected_task_revision {
            return Err(format!(
                "任务版本已改变，请读取当前第 {} 版后重试",
                tree.revision
            ));
        }
        let old_revision = tree.revision;
        tree.invalidations.clear();
        let sources = goal::completion::requirements_on(c, &current)?;
        let mut touched = BTreeSet::new();
        let mut done = BTreeSet::new();
        for id in &remove {
            if !touched.insert(id.clone()) || tree.tasks.remove(id).is_none() {
                return Err("删除的任务不存在或补丁重复修改同一任务".into());
            }
        }
        for spec in upsert {
            graph::check_spec(&spec, &sources)?;
            if !touched.insert(spec.task_id.clone()) {
                return Err("补丁重复修改同一任务".into());
            }
            if spec.status == "done" {
                done.insert(spec.task_id.clone());
            }
            let previous = tree.tasks.get(&spec.task_id);
            let task = Task {
                revision: previous.map_or(1, |t| t.revision + 1),
                evidence: previous.and_then(|t| t.evidence.clone()),
                needs_revalidation: previous.and_then(|t| t.needs_revalidation.clone()),
                spec,
            };
            tree.tasks.insert(task.spec.task_id.clone(), task);
        }
        if touched.is_empty() {
            return Err("任务补丁没有变更".into());
        }
        let order = graph::order(&tree)?;
        let proofs = goal::completion::proofs_on(root, c, &current, run)?;
        let mut cache = BTreeMap::new();
        for id in order {
            if done.contains(&id) {
                if !ready(&tree, &id) {
                    return Err("依赖任务或子任务尚未完成，不能将任务标为完成".into());
                }
                let spec = &tree.tasks[&id].spec;
                let proof_versions = goal::completion::resolve_proofs(
                    &proofs,
                    &spec.proof_ids,
                    &spec.required_result,
                    true,
                )?;
                let evidence = Evidence {
                    goal_binding: expected_goal_binding.clone(),
                    run_id: run.into(),
                    dependency_versions: versions(&tree, &id),
                    proof_versions,
                    semantic_review: spec.review.clone(),
                };
                let task = tree.tasks.get_mut(&id).unwrap();
                task.evidence = Some(evidence);
                task.needs_revalidation = None;
            } else if let Some(reason) = stale_reason(root, c, &current, &tree, &id, &mut cache)? {
                invalidate(&mut tree, &id, reason);
            }
        }
        tree.revision = old_revision + 1;
        tree.goal_binding = expected_goal_binding;
        // Leave room under the existing 64 KiB record limit for durable host
        // invalidations, including one reason/event per node.
        if serde_json::to_vec(&tree).map_err(|e| e.to_string())?.len() > 32_768 {
            return Err("任务树超过当前容量，请精简步骤或核对说明；已有任务未改变".into());
        }
        save_on(
            c,
            &current,
            Some(run),
            &tree,
            "modelTaskPatch",
            Some((&operation_id, &hash)),
        )?;
        control.check()?;
        Ok(
            json!({"replayed":false,"operationId":operation_id,"committedRevision":tree.revision,"state":public_on(c,&current,&tree)?}),
        )
    })
}
