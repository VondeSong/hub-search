//! Explicit read-only projection. Never evaluated by status polling or model dispatch.
use super::*;
#[derive(Default)]
struct Extent {
    total: Option<usize>,
    ranges: Vec<(usize, usize)>,
    records: HashSet<String>,
}
fn merged(mut ranges: Vec<(usize, usize)>) -> Vec<(usize, usize)> {
    ranges.sort_unstable();
    let mut out: Vec<(usize, usize)> = Vec::new();
    for (start, end) in ranges {
        if let Some(last) = out.last_mut() {
            if start <= last.1 {
                last.1 = last.1.max(end);
                continue;
            }
        }
        out.push((start, end));
    }
    out
}
pub(in crate::agent_work) fn read_ui(root: &Path, args: &Value) -> Result<Value, String> {
    let id = crate::agent_work::text(args, "id", 150)?;
    let c = read(root)?;
    c.execute_batch("BEGIN DEFERRED")
        .map_err(|e| e.to_string())?;
    let w = load(&c, &id)?;
    if w.state == "revoked"
        || args["expectedWorkRevision"].as_i64() != Some(w.revision)
        || args["expectedAuthorizationVersion"].as_i64() != Some(w.authorization_version)
    {
        return Err("事项或授权已变化，请刷新后查看覆盖记录".into());
    }
    let manifest = w
        .grant
        .manifest
        .as_ref()
        .ok_or("当前事项没有固定材料清单")?;
    let reader = w.grant.reader(root)?;
    let (count,bytes):(i64,i64)=c.query_row("SELECT count(*),coalesce(sum(length(CAST(body_json AS BLOB))),0) FROM agent_records WHERE work_id=?1 AND kind IN ('toolResult','evidence')",[&id],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|e|e.to_string())?;
    if count > 4096 || bytes > 20 * 1024 * 1024 {
        return Err("覆盖核对超过4096条或20MiB容量，未返回部分统计".into());
    }
    let mut q=c.prepare("SELECT id,body_json FROM agent_records WHERE work_id=?1 AND kind IN ('toolResult','evidence') ORDER BY rowid").map_err(|e|e.to_string())?;
    let mut extents: HashMap<String, Extent> = manifest
        .members
        .iter()
        .map(|m| (serde_json::to_string(m).unwrap(), Extent::default()))
        .collect();
    let mut runs = HashSet::new();
    let mut unknown = 0usize;
    let mut failures = 0usize;
    let mut verified = 0usize;
    let mut trace_identity = Vec::new();
    for row in q
        .query_map([&id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?
    {
        let (record, text) = row.map_err(|e| e.to_string())?;
        let body: Value =
            serde_json::from_str(&text).map_err(|_| "覆盖记录损坏，未返回部分统计")?;
        trace_identity.push(json!([record, sha(&body)]));
        let Some(expected) = body["_hubTrace"]["sha256"].as_str() else {
            unknown += 1;
            continue;
        };
        let value = match load_raw(
            root,
            &c,
            &w,
            &record,
            expected,
            &mut HashSet::new(),
            &mut runs,
        ) {
            Ok(value) => value,
            Err(_) => {
                unknown += 1;
                continue;
            }
        };
        verified += 1;
        if !value["error"].is_null() {
            failures += 1;
        }
        let mut excerpts = vec![&value["excerpt"], &value["readEvidence"]];
        if let Some(reads) = value["reads"].as_array() {
            excerpts.extend(reads.iter().map(|v| &v["excerpt"]));
        }
        for value in excerpts.into_iter().filter(|v| !v.is_null()) {
            let source: EvidenceExcerpt =
                serde_json::from_value(value.clone()).map_err(|_| "读取区间记录损坏")?;
            let Some(extent) = extents
                .get_mut(&serde_json::to_string(&source.locator).map_err(|e| e.to_string())?)
            else {
                continue;
            };
            let total = reader.verified_extent_on(&c, &source)?;
            if extent.total.is_some_and(|old| old != total) {
                return Err("读取覆盖来源长度冲突，未合并统计".into());
            }
            extent.total = Some(total);
            extent.ranges.push((source.start_char, source.end_char));
            extent.records.insert(record.clone());
        }
    }
    let mut members = Vec::new();
    let mut complete = 0;
    let mut partial = 0;
    for locator in &manifest.members {
        let extent = extents
            .remove(&serde_json::to_string(locator).unwrap())
            .unwrap();
        let ranges = merged(extent.ranges);
        let covered: usize = ranges.iter().map(|(s, e)| e - s).sum();
        let state = match extent.total {
            Some(total) if covered == total => {
                complete += 1;
                "fullToolReturn"
            }
            Some(_) => {
                partial += 1;
                "partialToolReturn"
            }
            None => "noVerifiedReadReceipt",
        };
        members.push(json!({"locator":locator,"state":state,"coveredChars":covered,"totalChars":extent.total,"ranges":ranges,"receiptCount":extent.records.len(),"modelConsumed":null,"extracted":null}));
    }
    // Same DB read snapshot binds all records, source extents, Work and authority.
    // The manifest gate also rejects changed live library membership/version.
    manifest.verify(root)?;
    let identity = format!(
        "source-coverage-v1:{}",
        sha(
            &json!({"work":id,"revision":w.revision,"authorization":w.authorization_version,"grant":w.grant,"records":trace_identity})
        )
    );
    let offset = if let Some(cursor) = args.get("cursor") {
        let cursor = cursor.as_str().ok_or("覆盖游标无效")?;
        let (base, index) = cursor.rsplit_once(':').ok_or("覆盖游标无效")?;
        if base != identity {
            return Err("范围或读取记录已变化，请从首页重新核对".into());
        }
        index.parse::<usize>().map_err(|_| "覆盖游标无效")?
    } else {
        0
    };
    if offset > members.len() {
        return Err("覆盖游标超出范围".into());
    }
    let end = (offset + 20).min(members.len());
    let result = json!({"snapshot":identity,"workId":id,"workRevision":w.revision,"authorizationVersion":w.authorization_version,"totalMembers":members.len(),"fullToolReturnMembers":complete,"partialToolReturnMembers":partial,"noVerifiedReadReceiptMembers":members.len()-complete-partial,"verifiedOutcomeRecords":verified,"unverifiableOutcomeRecords":unknown,"failedOutcomeRecords":failures,"failureAttribution":"all verified tool errors; not per-member absence","modelConsumedMembers":null,"extractedMembers":null,"members":&members[offset..end],"nextCursor":if end<members.len(){Some(format!("{identity}:{end}"))}else{None},"meaning":"verified host-returned source ranges, Unicode scalar offsets; not provider receipt, comprehension, extraction, or remote completeness"});
    if result.to_string().len() > 48 * 1024 {
        return Err("覆盖页超过48KiB，未截断区间或成员".into());
    }
    Ok(result)
}
#[cfg(test)]
mod tests;
