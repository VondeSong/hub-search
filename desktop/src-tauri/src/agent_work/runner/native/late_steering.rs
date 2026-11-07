//! At most one same-Run handoff for real input after provider completion.
use super::*;
pub(super) fn pending(
    root: &Path,
    work: &Work,
    run: &str,
    delivered: &HashSet<String>,
) -> Result<Vec<Value>, String> {
    store::check_run(root, work, run)?;
    let mut records = store::records(root, &work.id, "steering", 32)?;
    records.reverse();
    let mut messages = Vec::new();
    for message in records.into_iter().filter(|m| m["runId"] == run) {
        let id = message["clientMessageId"]
            .as_str()
            .ok_or("追加消息身份缺失")?;
        if !delivered.contains(id) {
            messages.push(message);
        }
    }
    Ok(messages)
}
pub(super) fn next(
    root: &Path,
    work: &Work,
    run: &str,
    delivered: &HashSet<String>,
    used: &mut bool,
) -> Result<Option<Vec<Value>>, String> {
    let messages = pending(root, work, run, delivered)?;
    if messages.is_empty() {
        return Ok(None);
    }
    if *used {
        return Err("追加要求已保存，本轮交付恢复次数已用尽，请继续完成".into());
    }
    *used = true;
    Ok(Some(messages))
}
#[cfg(test)]
mod tests;
