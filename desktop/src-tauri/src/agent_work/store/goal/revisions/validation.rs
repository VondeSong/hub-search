use super::*;
pub(super) fn check(
    c: &Connection,
    work: &Work,
    old: Option<&Revision>,
    content: &Content,
    retirements: &[Retirement],
    sources: &Value,
    command: &str,
) -> Result<Vec<String>, String> {
    let sources = sources.as_array().ok_or("用户要求目录无效")?;
    if sources.len() + content.items.len() + 1 > 128 {
        return Err("解释及原始要求超过完成核对容量".into());
    }
    let position = |id: &str| sources.iter().position(|r| r["requirementId"] == id);
    let mut refs = BTreeSet::new();
    let mut grounded = |text: &str, ids: &[String]| -> Result<(), String> {
        if text.trim().is_empty() || ids.is_empty() {
            return Err("解释必须包含正文及原始用户来源".into());
        }
        let mut seen = BTreeSet::new();
        for id in ids {
            if position(id).is_none() || !seen.insert(id) {
                return Err("解释来源不存在或重复，不能引用材料或工具输出作为用户指令".into());
            }
            refs.insert(id.clone());
        }
        Ok(())
    };
    grounded(
        &content.effective_goal.text,
        &content.effective_goal.source_refs,
    )?;
    let mut ids = BTreeSet::new();
    for item in &content.items {
        if item.item_id == "effective"
            || !item
                .item_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            || !ids.insert(&item.item_id)
        {
            return Err("解释条目身份无效或重复".into());
        }
        grounded(&item.text, &item.source_refs)?;
        if let Some(previous) =
            old.and_then(|o| o.content.items.iter().find(|v| v.item_id == item.item_id))
        {
            if previous != item {
                return Err("旧解释条目不能原地改写；请用新身份和用户替代依据修订".into());
            }
        } else {
            let existed:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_records r,json_each(r.body_json,'$.content.items') i WHERE r.work_id=?1 AND r.kind='goalRevision' AND json_extract(i.value,'$.itemId')=?2)",params![work.id,item.item_id],|r|r.get(0)).map_err(|e|e.to_string())?;
            if existed {
                return Err("已退出的解释身份不能复用".into());
            }
        }
    }
    let mut retired = BTreeSet::new();
    for change in retirements {
        let previous = old
            .and_then(|o| o.content.items.iter().find(|v| v.item_id == change.item_id))
            .ok_or("退出的解释条目不存在")?;
        if ids.contains(&change.item_id)
            || !retired.insert(&change.item_id)
            || change.reason.trim().is_empty()
        {
            return Err("退出条目重复、仍在当前解释中或缺少理由".into());
        }
        let next = position(&change.source_command_id).ok_or("替代依据必须来自真实用户命令")?;
        let original_count = if work.success_criteria.trim().is_empty() {
            1
        } else {
            2
        };
        if next < original_count
            || previous
                .source_refs
                .iter()
                .any(|id| position(id).is_none_or(|p| p >= next))
        {
            return Err("替代或取消必须引用比旧条目更新的用户命令".into());
        }
        let mut replacements = BTreeSet::new();
        for id in &change.replacement_ids {
            let replacement = content
                .items
                .iter()
                .find(|v| v.item_id == *id)
                .ok_or("替代条目不存在于新解释")?;
            if !replacements.insert(id)
                || !replacement.source_refs.contains(&change.source_command_id)
            {
                return Err("替代条目必须绑定对应用户命令且不得重复".into());
            }
        }
        refs.insert(change.source_command_id.clone());
    }
    if old.is_some_and(|r| {
        r.content
            .items
            .iter()
            .any(|i| !ids.contains(&i.item_id) && !retired.contains(&i.item_id))
    }) {
        return Err("不能省略仍有效的约束、验收条件或歧义；需要用户替代依据".into());
    }
    if !refs.contains(command) {
        return Err("解释必须覆盖当前用户命令来源".into());
    }
    Ok(refs.into_iter().collect())
}
