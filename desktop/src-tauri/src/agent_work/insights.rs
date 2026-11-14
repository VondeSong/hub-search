//! Fixed deliveries are the source of candidates, never the mutable latest report.
use super::*;
use sha2::{Digest, Sha256};

#[cfg(all(test, windows))]
mod live;
mod recall;
pub(super) mod review;
mod state;
#[cfg(test)]
mod tests;
pub(crate) use state::{migrate, quarantine_restored};

fn digest(raw: &str) -> String {
    format!("{:x}", Sha256::digest(raw.as_bytes()))
}

fn work_on(c: &Connection, id: &str) -> Result<Work, String> {
    let work = store::load(c, id)?;
    if work.state == "revoked" {
        return Err("该事项的来源授权已撤回，不能读取洞察候选".into());
    }
    Ok(work)
}

fn current_reader(root: &Path, work: &Work) -> Result<EvidenceReader, String> {
    // Saved findings use the exact current grants. A collection's changed
    // inventory must not invalidate an independently unchanged member.
    Ok(EvidenceReader::new(root, work.grant.scope()?))
}

/// Both endpoints run in one source snapshot; a candidate has no saved identity yet.
pub(super) fn ui(root: &Path, args: &Value) -> Result<Value, String> {
    if args["action"]
        .as_str()
        .is_some_and(|a| a.starts_with("insightReview"))
    {
        return review::ui(root, args);
    }
    if matches!(
        args["action"].as_str(),
        Some("insightRecall" | "insightRecallSource")
    ) {
        return recall::ui(root, args);
    }
    if !matches!(
        args["action"].as_str(),
        Some("insightCandidates" | "insightDeliveries")
    ) {
        return state::ui(root, args);
    }
    let id = text(args, "id", 150)?;
    let permit = crate::library_runtime::cached_read_permit(root)?;
    let c = crate::source_evidence::open_read_database(root)?;
    c.execute_batch("BEGIN").map_err(|e| e.to_string())?;
    let work = work_on(&c, &id)?;
    let result = match args["action"].as_str() {
        Some("insightDeliveries") => deliveries_on(&c, &work, args),
        Some("insightCandidates") => {
            let record = text(args, "deliveryRecordId", 150)?;
            candidates_on(root, &c, &work, &record)
        }
        _ => Err("未知洞察读取操作".into()),
    }?;
    c.execute_batch("COMMIT").map_err(|e| e.to_string())?;
    let current = work_on(&c, &id)?;
    if current.authorization_version != work.authorization_version {
        return Err("读取期间授权已改变，请重新核对".into());
    }
    permit.checkpoint()?;
    Ok(result)
}

fn deliveries_on(c: &Connection, work: &Work, args: &Value) -> Result<Value, String> {
    let before = args["beforeRecordId"]
        .as_str()
        .map(|id| {
            c.query_row(
                "SELECT rowid FROM agent_records WHERE id=?1 AND work_id=?2 AND kind='delivery'",
                params![id, work.id],
                |r| r.get::<_, i64>(0),
            )
            .map_err(|_| "成果分页位置已失效".to_string())
        })
        .transpose()?;
    let mut q = c.prepare("SELECT r.id,r.run_id,r.body_json,r.created_at FROM agent_records r JOIN agent_runs u ON u.id=r.run_id AND u.work_id=r.work_id WHERE r.work_id=?1 AND r.kind='delivery' AND (?2 IS NULL OR r.rowid<?2) ORDER BY r.rowid DESC LIMIT 51").map_err(|e|e.to_string())?;
    let rows = q
        .query_map(params![work.id, before], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut items = Vec::new();
    for row in rows {
        let (id, run, raw, at) = row.map_err(|e| e.to_string())?;
        if raw.len() > 524_288 {
            return Err("固定交付记录超过读取上限".into());
        }
        let body: Value = serde_json::from_str(&raw).map_err(|_| "固定交付记录损坏")?;
        items.push(json!({"deliveryRecordId":id,"runId":run,"deliveryHash":digest(&raw),"generatedAt":at,
            "findingCount":body["report"]["findings"].as_array().map_or(0,Vec::len),"status":body["report"]["status"]}));
    }
    let has_more = items.len() > 50;
    items.truncate(50);
    Ok(
        json!({"workId":work.id,"nextBeforeRecordId":if has_more{items.last().map(|v|v["deliveryRecordId"].clone())}else{None},"items":items,"hasMore":has_more}),
    )
}

fn candidates_on(root: &Path, c: &Connection, work: &Work, record: &str) -> Result<Value, String> {
    let (raw, run, generated, authorization): (String,String,i64,i64) = c.query_row(
        "SELECT r.body_json,r.run_id,r.created_at,u.authorization_version FROM agent_records r JOIN agent_runs u ON u.id=r.run_id AND u.work_id=r.work_id WHERE r.id=?1 AND r.work_id=?2 AND r.kind='delivery'",
        params![record,work.id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))
        .optional().map_err(|e|e.to_string())?.ok_or("交付不存在或不属于当前事项")?;
    if raw.len() > 524_288 || authorization < 1 || authorization > work.authorization_version {
        return Err("固定交付身份无效或超过读取上限".into());
    }
    let body: Value = serde_json::from_str(&raw).map_err(|_| "固定交付记录损坏")?;
    let origin = json!({"workId":work.id,"runId":run,"deliveryRecordId":record,"deliveryHash":digest(&raw),"generatedAt":generated});
    let findings = body["report"]["findings"].as_array();
    if body["report"]["status"] != "completed" || findings.is_none_or(Vec::is_empty) {
        return Ok(
            json!({"origin":origin,"candidates":[],"reason":"当前成果没有可提取的已发布结构化发现；可继续查看原回答"}),
        );
    }
    let findings = findings.unwrap();
    if findings.len() > 12 {
        return Err("固定交付发现数量超出合同上限".into());
    }
    let reader = current_reader(root, work)?;
    let evidence: Vec<EvidenceExcerpt> =
        serde_json::from_value(body["evidence"].clone()).map_err(|_| "固定交付的取证记录损坏")?;
    let complex_context = body
        .get("materialReads")
        .is_some_and(|v| !v.is_null() && v != &json!([]) && v != &json!({}))
        || body
            .get("artifactRefs")
            .is_some_and(|v| !v.is_null() && v != &json!([]) && v != &json!({}));
    // Backgrounds cannot be guessed from the report's global evidence inventory.
    let memory: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM agent_records WHERE run_id=?1 AND (kind IN ('topicMethodUse','nativeImages') OR (kind='libraryRules' AND (json_type(body_json)!='array' OR EXISTS(SELECT 1 FROM json_each(body_json) WHERE COALESCE(json_array_length(value,'$.entries'),1)>0))) OR (kind='sharedMemoryUse' AND COALESCE(json_array_length(body_json,'$.items'),1)>0) OR (kind='toolResult' AND (json_extract(body_json,'$.kind')='skillInstructions' OR json_extract(body_json,'$.value.kind')='skillInstructions'))))",[&run],|r|r.get(0)).map_err(|e|e.to_string())?;
    let image_context = !work.grant.images.is_empty();
    let mut candidates = Vec::new();
    for (index, finding) in findings.iter().enumerate() {
        let pointer = format!("/report/findings/{index}");
        let checked = (|| {
            if complex_context || memory || image_context {
                return Err("该成果含尚未接入的背景或派生材料，需先确认单条依赖".to_string());
            }
            let text = finding["text"]
                .as_str()
                .filter(|s| !s.trim().is_empty() && s.chars().count() <= 6000)
                .ok_or("发现正文为空或超出容量")?;
            let review = if let Some(id) = finding["reviewRef"].as_str() {
                let v = review::binding(c, work, id)?;
                review::verify_dependencies(root, c, work, &v)?;
                if v["text"] != text {
                    return Err("发现文字与回顾依赖不符".into());
                }
                Some(v)
            } else {
                None
            };
            let citations = finding["citations"]
                .as_array()
                .filter(|v| (review.is_some() || !v.is_empty()) && v.len() <= 40)
                .ok_or("发现缺少可核对的直接依据")?;
            let mut sources = Vec::new();
            for citation in citations {
                let number = citation["evidenceId"]
                    .as_str()
                    .and_then(|s| s.strip_prefix('e'))
                    .and_then(|s| s.parse::<usize>().ok())
                    .filter(|n| *n > 0)
                    .ok_or("引用身份无效")?;
                let excerpt = evidence.get(number - 1).ok_or("引用不属于该固定交付")?;
                if !matches!(
                    excerpt.locator,
                    EvidenceLocator::Note { .. }
                        | EvidenceLocator::Task { .. }
                        | EvidenceLocator::Reading { .. }
                ) {
                    return Err("该证据类型尚未接入洞察候选".into());
                }
                let quote = citation["quote"]
                    .as_str()
                    .filter(|s| !s.trim().is_empty() && excerpt.content.contains(s))
                    .ok_or("引文不在实际读取的原文中")?;
                reader
                    .verify_in_transaction(c, std::slice::from_ref(excerpt))
                    .map_err(|_| "来源已变化、删除或当前不可访问；候选内容已隐藏")?;
                sources.push(
                    json!({"evidenceId":citation["evidenceId"],"quote":quote,"excerpt":excerpt}),
                );
            }
            if let Some(v) = &review {
                for d in v["dependencies"]
                    .as_array()
                    .ok_or("回顾依赖损坏")?
                    .iter()
                    .filter(|d| d["kind"] == "source")
                {
                    if !sources.contains(d) {
                        sources.push(d.clone());
                    }
                }
            }
            Ok::<_, String>(
                json!({"findingPointer":pointer,"text":text,"sourceCitations":sources,"reviewDependency":review,"eligibility":"verifiedSources","requiresDependencyConfirmation":true}),
            )
        })();
        candidates.push(match checked {
            Ok(candidate) => candidate,
            Err(reason) => {
                json!({"findingPointer":pointer,"eligibility":"unavailable","reason":reason})
            }
        });
    }
    let context_options=evidence.iter().enumerate().filter(|(_,e)|matches!(e.locator,EvidenceLocator::Note{..}|EvidenceLocator::Task{..}|EvidenceLocator::Reading{..}) && reader.verify_in_transaction(c,std::slice::from_ref(*e)).is_ok()).map(|(index,e)|json!({"evidenceId":format!("e{}",index+1),"title":e.title,"locator":e.locator,"version":e.version})).collect::<Vec<_>>();
    Ok(json!({"origin":origin,"candidates":candidates,"contextOptions":context_options}))
}
