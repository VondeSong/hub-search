//! Complete structured outcomes are facts; bounded model/UI text is a view.
//! A stopped execution may finish recording its admitted call, never dispatch.
use super::*;
pub(in crate::agent_work) mod coverage;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

fn sha(v: &Value) -> String {
    format!("{:x}", Sha256::digest(v.to_string().as_bytes()))
}

pub(in crate::agent_work) fn request_reference(request: &Value) -> Value {
    let mut reference = request.clone();
    if reference["operation"] == "sleepDataset" {
        if let Some(rows) = reference["request"]
            .as_object_mut()
            .and_then(|r| r.remove("rows"))
        {
            reference["rowSubmission"] = json!({"count":rows.as_array().unwrap().len(),"recordKind":"toolCall","stepId":request["stepId"]});
        }
    }
    reference
}

pub(in crate::agent_work) fn raw(body: &Value) -> Result<Value, String> {
    let meta = &body["_hubTrace"];
    if meta["contentDeleted"] == true {
        return Err(
            "原方法读取内容已按明确删除要求移除，不能回读或恢复全文；原身份与计量仍保留".into(),
        );
    }
    if meta["schemaVersion"] != 1 {
        return Err("旧记录没有完整且可核对的原始结果，不能补造全文".into());
    }
    let value = if meta["wrapped"] == true {
        body["value"].clone()
    } else {
        let mut value = body.clone();
        let object = value.as_object_mut().ok_or("原始结果表示损坏")?;
        object.remove("request");
        object.remove("_hubTrace");
        for (key, v) in meta["reservedFields"]
            .as_object()
            .ok_or("原始结果保留字段损坏")?
        {
            object.insert(key.clone(), v.clone());
        }
        value
    };
    if meta["sha256"] != sha(&value) || meta["utf8Bytes"] != value.to_string().len() {
        return Err("原始结果内容或摘要已变化，未返回正文".into());
    }
    Ok(value)
}

pub(in crate::agent_work) fn capture(
    root: &Path,
    work: &str,
    run: &str,
    request: &Value,
    result: &Value,
) -> Result<Value, String> {
    let call = request["stepId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("工具调用身份缺失")?;
    write(root, |c| {
        let (owner, revision, authorization): (String, i64, i64) = c
            .query_row(
                "SELECT work_id,base_revision,authorization_version FROM agent_runs WHERE id=?1",
                [run],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(|_| "工具结果的运行身份不存在")?;
        if owner != work {
            return Err("工具结果不属于当前事项".into());
        }
        let admitted:String=c.query_row("SELECT body_json FROM agent_records WHERE work_id=?1 AND run_id=?2 AND kind='toolCall' AND json_extract(body_json,'$.stepId')=?3 ORDER BY rowid DESC LIMIT 1",params![work,run,call],|r|r.get(0)).map_err(|_|"没有已持久接收的工具调用，不登记结果")?;
        if serde_json::from_str::<Value>(&admitted).map_err(|_| "工具调用记录损坏")? != *request
        {
            return Err("工具调用身份与原请求不一致".into());
        }
        let existing:Option<(String,String)>=c.query_row("SELECT id,body_json FROM agent_records WHERE work_id=?1 AND run_id=?2 AND kind IN ('toolResult','evidence') AND json_extract(body_json,'$._hubTrace.callId')=?3 ORDER BY rowid LIMIT 1",params![work,run,call],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e|e.to_string())?;
        if let Some((id, body)) = existing {
            let body: Value = serde_json::from_str(&body).map_err(|_| "原始结果记录损坏")?;
            if raw(&body)? != *result {
                return Err("同一工具调用已有不同结果，保留原事实并停止".into());
            }
            return Ok(
                json!({"recordId":id,"runId":run,"sha256":sha(result),"utf8Bytes":result.to_string().len()}),
            );
        }
        let current = load(c, work)?;
        let mut reserved = serde_json::Map::new();
        if let Some(object) = result.as_object() {
            for key in ["request", "_hubTrace"] {
                if let Some(v) = object.get(key) {
                    reserved.insert(key.into(), v.clone());
                }
            }
        }
        let mut body = if result.is_object() {
            result.clone()
        } else {
            json!({"value":result})
        };
        body["request"] = request_reference(request);
        body["_hubTrace"] = json!({"schemaVersion":1,"callId":call,"sha256":sha(result),"utf8Bytes":result.to_string().len(),"wrapped":!result.is_object(),"reservedFields":reserved,
            "workRevision":revision,"authorizationVersion":authorization,"late":current.active_run.as_deref()!=Some(run)});
        let kind = if result.get("evidenceId").is_some() {
            "evidence"
        } else {
            "toolResult"
        };
        insert(c, work, Some(run), kind, &body)?;
        let id:String=c.query_row("SELECT id FROM agent_records WHERE work_id=?1 AND run_id=?2 AND json_extract(body_json,'$._hubTrace.callId')=?3 ORDER BY rowid DESC LIMIT 1",params![work,run,call],|r|r.get(0)).map_err(|e|e.to_string())?;
        Ok(
            json!({"recordId":id,"runId":run,"sha256":sha(result),"utf8Bytes":result.to_string().len()}),
        )
    })
}

pub(in crate::agent_work) fn verify_embedded_on(
    c: &Connection,
    reader: &crate::source_evidence::EvidenceReader,
    body: &Value,
    kind: &str,
) -> Result<(), String> {
    let mut excerpts = vec![&body["readEvidence"]];
    if kind == "evidence" {
        excerpts.push(&body["excerpt"]);
    }
    if let Some(reads) = body["reads"].as_array() {
        excerpts.extend(reads.iter().map(|v| &v["excerpt"]));
    }
    for value in excerpts {
        if !value.is_null() {
            let source: EvidenceExcerpt =
                serde_json::from_value(value.clone()).map_err(|_| "历史结果来源证据损坏")?;
            reader.verify_in_transaction(c, &[source])?;
        }
    }
    Ok(())
}

fn verify_run(
    root: &Path,
    c: &Connection,
    w: &Work,
    run: &str,
    revision: i64,
    authorization: i64,
) -> Result<(), String> {
    if authorization != w.authorization_version {
        return Err("历史结果授权已失效".into());
    }
    let reader = super::materials::grant_at(c, w, revision)?.reader(root)?;
    let mut q=c.prepare("SELECT kind,body_json FROM agent_records WHERE work_id=?1 AND run_id=?2 AND kind IN ('toolResult','evidence') ORDER BY rowid LIMIT 257").map_err(|e|e.to_string())?;
    let rows = q
        .query_map(params![w.id, run], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    if rows.len() > 256 {
        return Err("历史结果超出当前可核对容量".into());
    }
    for (kind, text) in rows {
        let body: Value = serde_json::from_str(&text).map_err(|_| "历史工具记录损坏")?;
        if matches!(
            body["request"]["name"].as_str(),
            Some(
                "hub_list_note_sources"
                    | "hub_analyze_notes"
                    | "hub_source_manifest"
                    | "hub_create_analysis_snapshot"
                    | "hub_read_analysis_snapshot"
            )
        ) && body["snapshot"].is_string()
        {
            crate::source_evidence::analysis::verify_in_transaction(
                &reader,
                c,
                &json!({"trace":{"arguments":body["request"]["arguments"],"snapshot":body["snapshot"]}}),
            )?;
        }
        verify_embedded_on(c, &reader, &body, &kind)?;
    }
    Ok(())
}

fn load_raw(
    root: &Path,
    c: &Connection,
    w: &Work,
    id: &str,
    expected: &str,
    seen: &mut HashSet<String>,
    verified_runs: &mut HashSet<String>,
) -> Result<Value, String> {
    if seen.len() >= 8 || !seen.insert(id.to_owned()) {
        return Err("历史结果引用循环或超过核对深度".into());
    }
    let (text,run,revision,authorization):(String,String,i64,i64)=c.query_row("SELECT r.body_json,r.run_id,u.base_revision,u.authorization_version FROM agent_records r JOIN agent_runs u ON u.id=r.run_id WHERE r.id=?1 AND r.work_id=?2 AND r.kind IN ('toolResult','evidence')",params![id,w.id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(|_|"历史结果不存在或不属于当前事项")?;
    let body: Value = serde_json::from_str(&text).map_err(|_| "历史结果记录损坏")?;
    if body["_hubTrace"]["sha256"] != expected {
        return Err("历史结果摘要不匹配，未返回正文".into());
    }
    let value = raw(&body)?;
    crate::agent_work::artifacts::sleep::verify_batch_summary_on(root, c, w, &value)?;
    if !verified_runs.contains(&run) {
        verify_run(root, c, w, &run, revision, authorization)?;
        verified_runs.insert(run.clone());
    }
    // Reloading a reload result must retain the original dependency gate.
    // Otherwise a nested string could bypass a later source withdrawal.
    if body["request"]["operation"] == "traceResult" {
        let request = &body["request"];
        load_raw(
            root,
            c,
            w,
            request["recordId"].as_str().ok_or("历史结果引用身份损坏")?,
            request["expectedSha256"]
                .as_str()
                .ok_or("历史结果引用摘要损坏")?,
            seen,
            verified_runs,
        )?;
    }
    Ok(value)
}

/// One snapshot owns these caches. Never reuse a successful authorization or
/// source-version check after returning to the caller or across transactions.
#[derive(Default)]
pub(in crate::agent_work) struct ReferenceChecks {
    runs: HashSet<String>,
    sources: HashMap<String, Value>,
    references: HashMap<(String, String), Result<Value, String>>,
}
impl ReferenceChecks {
    pub(in crate::agent_work) fn describe(
        &mut self,
        root: &Path,
        c: &Connection,
        w: &Work,
        id: &str,
        expected: &str,
    ) -> Result<Value, String> {
        let key = (id.to_owned(), expected.to_owned());
        if let Some(value) = self.references.get(&key) {
            return value.clone();
        }
        let value = self.describe_uncached(root, c, w, id, expected);
        self.references.insert(key, value.clone());
        value
    }
    fn describe_uncached(
        &mut self,
        root: &Path,
        c: &Connection,
        w: &Work,
        id: &str,
        expected: &str,
    ) -> Result<Value, String> {
        let value = load_raw(
            root,
            c,
            w,
            id,
            expected,
            &mut HashSet::new(),
            &mut self.runs,
        )?;
        let (run,revision,authorization):(String,i64,i64)=c.query_row("SELECT u.id,u.base_revision,u.authorization_version FROM agent_records r JOIN agent_runs u ON u.id=r.run_id WHERE r.id=?1 AND r.work_id=?2",params![id,w.id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|e|e.to_string())?;
        if !self.sources.contains_key(&run) {
            let mut source_versions = Vec::new();
            let mut seen = HashSet::new();
            let mut q=c.prepare("SELECT body_json FROM agent_records WHERE work_id=?1 AND run_id=?2 AND kind IN ('toolResult','evidence') ORDER BY rowid LIMIT 256").map_err(|e|e.to_string())?;
            for row in q
                .query_map(params![w.id, run], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?
            {
                let body: Value = serde_json::from_str(&row.map_err(|e| e.to_string())?)
                    .map_err(|_| "工具依赖记录损坏")?;
                let mut excerpts = vec![&body["excerpt"], &body["readEvidence"]];
                if let Some(reads) = body["reads"].as_array() {
                    excerpts.extend(reads.iter().map(|v| &v["excerpt"]));
                }
                for excerpt in excerpts {
                    if !excerpt.is_null() {
                        let source: EvidenceExcerpt = serde_json::from_value(excerpt.clone())
                            .map_err(|_| "工具来源版本损坏")?;
                        let descriptor = json!({"locator":source.locator,"version":source.version,"startChar":source.start_char,"endChar":source.end_char});
                        if seen.insert(descriptor.to_string()) {
                            source_versions.push(descriptor);
                        }
                    }
                }
                if body["snapshot"].is_string()
                    && matches!(
                        body["request"]["name"].as_str(),
                        Some(
                            "hub_list_note_sources"
                                | "hub_analyze_notes"
                                | "hub_source_manifest"
                                | "hub_create_analysis_snapshot"
                                | "hub_read_analysis_snapshot"
                        )
                    )
                {
                    let descriptor = json!({"snapshot":body["snapshot"],"arguments":body["request"]["arguments"]});
                    if seen.insert(descriptor.to_string()) {
                        source_versions.push(descriptor);
                    }
                }
            }
            self.sources.insert(run.clone(), json!(source_versions));
        }
        Ok(
            json!({"recordId":id,"sha256":expected,"runId":run,"workRevision":revision,"authorizationVersion":authorization,
            "utf8Bytes":value.to_string().len(),"sourceRevisions":self.sources[&run],"scopeFingerprint":sha(&json!(super::materials::grant_at(c,w,revision)?)),
            "dependencyValidation":"known recorded sources of the original Run; not semantic validation of a working note"}),
        )
    }
}

pub(in crate::agent_work) fn read_for_work(
    root: &Path,
    work: &Work,
    id: &str,
    expected: &str,
    start: usize,
    limit: usize,
) -> Result<Value, String> {
    if id.is_empty()
        || id.len() > 150
        || expected.len() != 64
        || !expected.bytes().all(|c| c.is_ascii_hexdigit())
        || !(1..=4000).contains(&limit)
    {
        return Err("历史结果身份或范围参数无效".into());
    }
    let c = read(root)?;
    c.execute_batch("BEGIN DEFERRED")
        .map_err(|e| e.to_string())?;
    let current = load(&c, &work.id)?;
    if current.state == "revoked"
        || current.revision != work.revision
        || current.authorization_version != work.authorization_version
    {
        return Err("事项或授权已变化，未返回历史正文".into());
    }
    let value = load_raw(
        root,
        &c,
        &current,
        id,
        expected,
        &mut HashSet::new(),
        &mut HashSet::new(),
    )?;
    let source_preview = value["excerpt"]["content"].as_str().map(|content| json!({
        "title":value["excerpt"]["title"],"content":content.chars().take(4000).collect::<String>(),
        "totalChars":content.chars().count(),"truncated":content.chars().count()>4000
    }));
    let method_preview = if value["kind"] == "skillInstructions" {
        value["instructions"].as_str().map(|content| json!({
            "title":value["skill"]["title"], "content":content.chars().take(4000).collect::<String>(),
            "totalChars":content.chars().count(), "truncated":content.chars().count()>4000
        }))
    } else { None };
    let text = value.to_string();
    let total = text.chars().count();
    if start > total {
        return Err("历史结果读取位置超出范围".into());
    }
    let end = start.saturating_add(limit).min(total);
    let content = text
        .chars()
        .skip(start)
        .take(end - start)
        .collect::<String>();
    Ok(
        json!({"kind":"historicalToolResult","recordId":id,"sha256":expected,"content":content,"startChar":start,"endChar":end,"totalChars":total,"nextStartChar":if end<total{Some(end)}else{None},
        "sourcePreview":source_preview,"methodPreview":method_preview,"historical":true,"currentEvidence":false,"policy":"历史工具结果仅用于恢复过程；当前事实与引用须重新取证。读取不会重发原操作。"}),
    )
}

/// Cached transport replies retain the same historical dependency boundary as
/// an explicit reload. This verifies facts only; it never reruns the tool.
pub(in crate::agent_work) fn verify_for_replay(
    root: &Path,
    work: &Work,
    run: &str,
    call: &str,
    reference: &Value,
) -> Result<(), String> {
    let id = reference["recordId"]
        .as_str()
        .ok_or("重复回执缺少完整结果身份")?;
    let expected = reference["sha256"].as_str().ok_or("重复回执缺少结果摘要")?;
    let c = read(root)?;
    c.execute_batch("BEGIN DEFERRED")
        .map_err(|e| e.to_string())?;
    let current = load(&c, &work.id)?;
    if current.state == "revoked"
        || current.revision != work.revision
        || current.authorization_version != work.authorization_version
    {
        return Err("事项或授权已变化，重复回执未发送".into());
    }
    let owner:(String,String)=c.query_row(
        "SELECT run_id,json_extract(body_json,'$._hubTrace.callId') FROM agent_records WHERE id=?1 AND work_id=?2 AND kind IN ('toolResult','evidence')",
        params![id,work.id],|r|Ok((r.get(0)?,r.get(1)?)),
    ).map_err(|_|"重复回执没有可核对的完整结果")?;
    if owner.0 != run || owner.1 != call {
        return Err("重复回执与原运行或调用不匹配".into());
    }
    load_raw(
        root,
        &c,
        &current,
        id,
        expected,
        &mut HashSet::new(),
        &mut HashSet::new(),
    )?;
    Ok(())
}

pub(in crate::agent_work) fn read_ui(root: &Path, args: &Value) -> Result<Value, String> {
    let id = super::super::text(args, "id", 150)?;
    let w = load(&read(root)?, &id)?;
    if args["expectedWorkRevision"].as_i64() != Some(w.revision)
        || args["expectedAuthorizationVersion"].as_i64() != Some(w.authorization_version)
    {
        return Err("事项或授权状态已变化，请刷新后重读".into());
    }
    read_for_work(
        root,
        &w,
        args["recordId"].as_str().ok_or("历史结果身份缺失")?,
        args["expectedSha256"].as_str().ok_or("历史结果摘要缺失")?,
        args["startChar"]
            .as_u64()
            .and_then(|v| usize::try_from(v).ok())
            .ok_or("历史结果位置无效")?,
        args["maxChars"]
            .as_u64()
            .and_then(|v| usize::try_from(v).ok())
            .ok_or("历史结果范围无效")?,
    )
}

#[cfg(test)]
mod tests;

/// Read a captured source result for a host estimate; never redispatch it.
pub(in crate::agent_work) fn for_material_estimate(
    root: &Path,
    w: &Work,
    reference: &Value,
) -> Result<Value, String> {
    let c = read(root)?;
    load_raw(
        root,
        &c,
        w,
        reference["recordId"].as_str().ok_or("估算回执身份缺失")?,
        reference["sha256"].as_str().ok_or("估算回执摘要缺失")?,
        &mut HashSet::new(),
        &mut HashSet::new(),
    )
}
