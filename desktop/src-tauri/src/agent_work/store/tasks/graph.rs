use super::*;

pub(super) fn check_spec(spec: &TaskSpec, sources: &Value) -> Result<(), String> {
    if spec.task_id.is_empty()
        || !spec
            .task_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("任务身份只接受字母、数字、连字符和下划线".into());
    }
    if spec.criterion.trim().is_empty() || spec.requirement_refs.is_empty() {
        return Err("任务必须有验收条件和原始要求引用".into());
    }
    let mut seen = BTreeSet::new();
    for id in &spec.requirement_refs {
        if !seen.insert(id)
            || !sources
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["requirementId"] == *id)
        {
            return Err("任务要求引用不存在或重复".into());
        }
    }
    if spec.dependencies.iter().collect::<BTreeSet<_>>().len() != spec.dependencies.len() {
        return Err("任务依赖不能重复".into());
    }
    if spec.status == "done" && spec.review.trim().is_empty() {
        return Err("完成任务必须提供语义核对说明".into());
    }
    if matches!(spec.status.as_str(), "blocked" | "waiting_decision")
        && spec.blocker.as_ref().is_none_or(|s| s.trim().is_empty())
    {
        return Err("受阻或等待决定的任务必须说明条件".into());
    }
    Ok(())
}

pub(super) fn prerequisites(tree: &Tree, id: &str) -> BTreeSet<String> {
    let mut dependencies: BTreeSet<_> = tree.tasks[id].spec.dependencies.iter().cloned().collect();
    for (child, task) in &tree.tasks {
        if task.spec.parent_id.as_deref() == Some(id) && task.spec.status != "cancelled" {
            dependencies.insert(child.clone());
        }
    }
    dependencies
}

/// Both parent/child completion and explicit dependencies participate in cycle
/// detection, including cancelled nodes so reopening cannot activate a cycle.
pub(super) fn order(tree: &Tree) -> Result<Vec<String>, String> {
    if tree.tasks.len() > 64 {
        return Err("任务树最多包含 64 个步骤".into());
    }
    let mut edges: BTreeMap<String, BTreeSet<String>> = tree
        .tasks
        .iter()
        .map(|(id, t)| (id.clone(), t.spec.dependencies.iter().cloned().collect()))
        .collect();
    for (id, task) in &tree.tasks {
        if let Some(parent) = &task.spec.parent_id {
            edges
                .get_mut(parent)
                .ok_or("父任务不存在")?
                .insert(id.clone());
        }
        for dependency in &task.spec.dependencies {
            if !tree.tasks.contains_key(dependency) {
                return Err("依赖任务不存在，不能删除仍被引用的任务".into());
            }
        }
    }
    fn visit(
        id: &str,
        edges: &BTreeMap<String, BTreeSet<String>>,
        active: &mut BTreeSet<String>,
        seen: &mut BTreeSet<String>,
        result: &mut Vec<String>,
        depth: usize,
    ) -> Result<(), String> {
        if active.contains(id) {
            return Err("任务父子关系或依赖形成循环".into());
        }
        if depth > 64 {
            return Err("任务关系超过容量".into());
        }
        if seen.contains(id) {
            return Ok(());
        }
        active.insert(id.into());
        for dependency in &edges[id] {
            visit(dependency, edges, active, seen, result, depth + 1)?;
        }
        active.remove(id);
        seen.insert(id.into());
        result.push(id.into());
        Ok(())
    }
    let mut active = BTreeSet::new();
    let mut seen = BTreeSet::new();
    let mut result = Vec::new();
    for id in tree.tasks.keys() {
        visit(id, &edges, &mut active, &mut seen, &mut result, 0)?;
    }
    Ok(result)
}
