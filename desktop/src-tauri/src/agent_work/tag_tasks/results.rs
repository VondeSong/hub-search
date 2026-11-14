//! Immutable full task results share the existing record and Run quotas.
use super::*;
use sha2::{Digest, Sha256};

fn digest(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

fn projection(result: &Value) -> Value {
    let mut value = result.clone();
    if let Some(object) = value.as_object_mut() {
        if let Some(candidates) = object.remove("candidates") {
            object.insert(
                "candidateCount".into(),
                json!(candidates.as_array().map_or(0, Vec::len)),
            );
        }
        if let Some(items) = object.get_mut("submitted").and_then(Value::as_array_mut) {
            for item in items {
                if let Some(object) = item.as_object_mut() {
                    // The Inbox opens this exact authoritative proposal identity.
                    object.remove("preview");
                }
            }
        }
    }
    value
}

pub(super) fn save(
    root: &Path,
    w: &Work,
    run: &str,
    body: &Value,
    kind: &str,
) -> Result<Value, String> {
    let raw = body["result"].to_string();
    let hash = digest(&raw);
    if body["runId"] != run
        || body["revision"] != w.revision
        || body["authorizationVersion"] != w.authorization_version
        || body["libraryIds"] != json!(w.grant.library_ids)
        || !matches!(kind, "tagTaskResult" | "tagTaskCheckpoint")
    {
        return Err("标签结果的任务、运行或资料范围身份不一致".into());
    }
    if raw.len() > 1_048_576 {
        return Err("标签结果超过本轮记录容量，完整业务建议及断点仍保留".into());
    }
    store::write(root, |c| {
        let current = store::load(c, &w.id)?;
        if current.active_run.as_deref() != Some(run)
            || current.revision != w.revision
            || current.authorization_version != w.authorization_version
        {
            return Err("标签结果所属运行或授权已失效".into());
        }
        let mut start = 0;
        let mut parts = 0;
        let existing: i64 = c.query_row("SELECT COUNT(*) FROM agent_records WHERE work_id=?1 AND run_id=?2 AND kind='tagTaskResultPart' AND json_extract(body_json,'$.snapshot')=?3",params![w.id,run,hash],|r|r.get(0)).map_err(|e|e.to_string())?;
        while start < raw.len() {
            let mut end = (start + 8000).min(raw.len());
            while !raw.is_char_boundary(end) {
                end -= 1;
            }
            if existing == 0 {
                store::insert(
                    c,
                    &w.id,
                    Some(run),
                    "tagTaskResultPart",
                    &json!({"snapshot":hash,"part":parts,"text":&raw[start..end]}),
                )?;
            }
            parts += 1;
            start = end;
        }
        let mut record = body.clone();
        record["result"] = projection(&body["result"]);
        record["resultSnapshot"] = json!({"schemaVersion":1,"sha256":hash,"utf8Bytes":raw.len(),"parts":parts,"kind":"tagTaskResultPart"});
        if existing > 0 {
            let mut old = record.clone();
            restore(c, &w.id, &mut old)?;
            if old["result"] != body["result"] {
                return Err("标签结果快照身份冲突".into());
            }
        }
        store::insert(c, &w.id, Some(run), kind, &record)?;
        Ok(record["resultSnapshot"].clone())
    })
}

fn restore(c: &Connection, work: &str, record: &mut Value) -> Result<(), String> {
    let reference = &record["resultSnapshot"];
    if reference.is_null() {
        return Ok(());
    } // Existing small inline results.
    let hash = reference["sha256"].as_str().ok_or("标签结果摘要缺失")?;
    let bytes = reference["utf8Bytes"].as_u64().ok_or("标签结果大小缺失")?;
    let count = reference["parts"].as_u64().ok_or("标签结果分片缺失")?;
    if reference["schemaVersion"] != 1 || bytes > 1_048_576 || count > 256 {
        return Err("标签结果快照超出可核对容量".into());
    }
    let mut query = c.prepare("SELECT body_json FROM agent_records WHERE work_id=?1 AND run_id=?2 AND kind='tagTaskResultPart' AND json_extract(body_json,'$.snapshot')=?3 ORDER BY json_extract(body_json,'$.part')").map_err(|e|e.to_string())?;
    let rows = query
        .query_map(
            params![
                work,
                record["runId"].as_str().ok_or("标签结果运行身份缺失")?,
                hash
            ],
            |r| r.get::<_, String>(0),
        )
        .map_err(|e| e.to_string())?;
    let mut raw = String::new();
    let mut seen = 0;
    for row in rows {
        let part: Value = serde_json::from_str(&row.map_err(|e| e.to_string())?)
            .map_err(|_| "标签结果分片损坏")?;
        if part["part"] != seen || seen >= count {
            return Err("标签结果分片身份不一致".into());
        }
        raw.push_str(part["text"].as_str().ok_or("标签结果分片正文损坏")?);
        if raw.len() as u64 > bytes {
            return Err("标签结果正文超出保存大小".into());
        }
        seen += 1;
    }
    if seen != count || raw.len() as u64 != bytes || digest(&raw) != hash {
        return Err("标签结果快照不完整或已变化；未用当前续查缓存替代".into());
    }
    record["result"] = serde_json::from_str(&raw).map_err(|_| "标签结果快照损坏")?;
    Ok(())
}

pub(super) fn records(root: &Path, work: &str, kind: &str) -> Result<Vec<Value>, String> {
    let mut rows = store::records(root, work, kind, 32)?;
    let c = crate::source_evidence::open_read_database(root)?;
    let w = store::load(&c, work)?;
    if w.state == "revoked" {
        return Ok(Vec::new());
    }
    rows.retain(|r| r["authorizationVersion"] == w.authorization_version);
    if !rows.is_empty() {
        w.grant.reader(root)?.catalog()?;
    }
    for row in &mut rows {
        restore(&c, work, row)?;
    }
    Ok(rows)
}

pub(super) fn model_view(body: &Value) -> Value {
    let mut value = body.clone();
    // Unreviewed retrieval snippets are not evidence already read by the model.
    if let Some(result) = value["result"].as_object_mut() {
        if let Some(candidates) = result.remove("candidates") {
            result.insert(
                "candidateCount".into(),
                json!(candidates.as_array().map_or(0, Vec::len)),
            );
            result.insert(
                "candidateDetails".into(),
                json!("完整候选清单保存在resultSnapshot；命中不代表已读或已判定"),
            );
        }
    }
    value
}

#[cfg(test)]
mod tests;
