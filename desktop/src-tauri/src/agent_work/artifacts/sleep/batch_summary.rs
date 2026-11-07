//! Rebuildable summary of explicit persisted dataset revisions. No new ledger.
use super::*;
use std::collections::HashSet;
pub(super) fn summarize(
    root: &Path,
    c: &Connection,
    work: &Work,
    request: &Value,
    control: &Control,
) -> Result<Value, String> {
    let current = store::load(c, &work.id)?;
    if current.revision != work.revision
        || current.authorization_version != work.authorization_version
        || current.state == "revoked"
    {
        return Err("事项或授权已变化，未汇总旧数据".into());
    }
    let manifest = work
        .grant
        .manifest
        .as_ref()
        .ok_or("分批覆盖需要当前事项的固定材料清单")?;
    let host = serde_json::to_value(manifest).map_err(|e| e.to_string())?;
    let reader = work.grant.reader(root)?;
    let mut selection = host["selection"].clone();
    selection["limit"] = json!(1);
    let parent = analysis::execute(&reader, "hub_source_manifest", &selection)?;
    if parent["totalMembers"].as_u64() != Some(manifest.members.len() as u64) {
        return Err("当前固定清单与分批母范围不一致".into());
    }
    let allowed = manifest
        .members
        .iter()
        .map(|m| json!(m).to_string())
        .collect::<HashSet<_>>();
    let references = request["datasets"]
        .as_array()
        .ok_or("需要明确分批数据集版本")?;
    if !(1..=8).contains(&references.len()) {
        return Err("一次分批核对需要1至8个数据集".into());
    }
    let mut dataset_ids = HashSet::new();
    let mut members = HashSet::new();
    let mut row_members = HashSet::new();
    let mut events = HashSet::new();
    let mut method: Option<Value> = None;
    let mut timezone: Option<String> = None;
    let mut groups: BTreeMap<String, (f64, Vec<Value>)> = BTreeMap::new();
    let mut datasets = Vec::new();
    let mut row_count = 0usize;
    let mut accepted = 0usize;
    let mut excluded = 0usize;
    let mut value_kinds: BTreeMap<String, usize> = BTreeMap::new();
    for reference in references {
        control.check()?;
        let id = reference["datasetId"].as_str().ok_or("数据集身份无效")?;
        if !dataset_ids.insert(id.to_owned()) {
            return Err("同一数据集不能重复作为分批输入".into());
        }
        let revision = reference["revision"]
            .as_u64()
            .filter(|n| (1..=32).contains(n))
            .ok_or("数据集修订无效")?;
        let value = find_dataset(c, work, id, Some(revision))?;
        eligible_dataset(root, c, work, &value)?;
        if find_dataset(c, work, id, None)?["revision"] != revision {
            return Err("分批数据集已修订，请显式引用最新版本，未挑选旧成功结果".into());
        }
        let policy = json!([
            value["methodRef"],
            value["inclusionRule"],
            value["dateRule"],
            value["parserVersion"],
            value["metric"],
            value["unit"]
        ]);
        if method.as_ref().is_some_and(|old| old != &policy) {
            return Err("分批方法、归日或指标合同不同，不能合并".into());
        }
        method = Some(policy);
        let descriptor = &value["inputSet"]["manifestBatch"];
        if descriptor["expectedManifest"] != parent["snapshot"]
            || descriptor["totalMembers"] != parent["totalMembers"]
        {
            return Err("数据集不是当前固定清单的同一版本分批输入".into());
        }
        let listed = analysis::execute(
            &reader,
            "hub_list_note_sources",
            &json!({"expectedSnapshot":value["snapshot"],"limit":32}),
        )?;
        let notes = listed["notes"].as_array().ok_or("分批材料清单无效")?;
        if notes.len() > 32
            || notes.len() as u64 != listed["total"].as_u64().unwrap_or(u64::MAX)
            || descriptor["actualMembers"].as_u64() != Some(notes.len() as u64)
            || !listed["nextOffset"].is_null()
        {
            return Err("分批材料清单不完整，未返回部分汇总".into());
        }
        for note in notes {
            let key = note["locator"].to_string();
            if !allowed.contains(&key) {
                return Err("分批输入含固定清单外材料".into());
            }
            if !members.insert(key) {
                return Err("分批材料发生重叠，未重复计数或静默选择".into());
            }
        }
        for row in value["rows"].as_array().ok_or("分批行损坏")? {
            row_count += 1;
            *value_kinds
                .entry(
                    row["valueKind"]
                        .as_str()
                        .ok_or("分批值分类损坏")?
                        .to_owned(),
                )
                .or_default() += 1;
            for evidence in row["evidenceRefs"].as_array().ok_or("分批出处损坏")? {
                let index = evidence["itemIndex"].as_u64().ok_or("分批出处编号损坏")? as usize;
                row_members
                    .insert(notes.get(index).ok_or("分批出处超出材料")?["locator"].to_string());
            }
            if row["reviewState"] != "accepted_for_analysis" {
                excluded += 1;
                continue;
            }
            accepted += 1;
            let event = row["eventRef"].as_str().ok_or("分批接受值缺少事件身份")?;
            if !events.insert(event.to_owned()) {
                return Err("分批接受值含重复事件身份，未双计或自动选择".into());
            }
            let zone = row["timezone"].as_str().ok_or("分批时区损坏")?;
            if timezone.as_deref().is_some_and(|old| old != zone) {
                return Err("分批接受值不能混用时区".into());
            }
            timezone = Some(zone.to_owned());
            let day = chrono::NaiveDate::parse_from_str(
                row["eventDate"].as_str().ok_or("分批事件日期缺失")?,
                "%Y-%m-%d",
            )
            .map_err(|_| "分批事件日期损坏")?;
            let number = row["normalizedValue"]
                .as_f64()
                .filter(|n| n.is_finite() && (0.0..=24.0).contains(n))
                .ok_or("分批接受值损坏")?;
            let group = groups.entry(day.format("%Y-%m").to_string()).or_default();
            group.0 += number;
            group.1.push(
                json!({"datasetId":id,"revision":revision,"rowId":row["rowId"],"eventRef":event}),
            );
        }
        datasets.push(json!({"datasetId":id,"revision":revision,"snapshot":value["snapshot"],"contentHash":value["contentHash"],"goalBinding":value["goalBinding"],"manifestBatch":descriptor}));
    }
    let partition_complete = members.len() == allowed.len();
    let statistics=groups.into_iter().map(|(month,(sum,lineage))|json!({"month":month,"meanHours":sum/lineage.len() as f64,"sumHours":sum,"sampleCount":lineage.len(),"lineage":lineage})).collect::<Vec<_>>();
    let goal = store::goal::binding_on(c, work)?;
    let mut result = json!({"kind":"sleepDatasetBatchSummary","schemaVersion":1,"workId":work.id,"goalBinding":goal,"manifest":parent["snapshot"],"datasets":datasets,
  "material":{"fixedMembers":allowed.len(),"datasetInputMembers":members.len(),"notRepresentedMembers":allowed.len()-members.len(),"partitionComplete":partition_complete,"membersWithRows":row_members.len(),"membersWithoutRows":members.len()-row_members.len(),"basis":"disjoint source inputs of persisted current dataset revisions; not exhaustive semantic extraction"},
  "rows":{"total":row_count,"acceptedExact":accepted,"excluded":excluded,"valueKinds":value_kinds},"statistics":statistics,"statisticScope":"accepted exact recorded events of the explicitly referenced datasets; missing members/events are not imputed zero",
  "modelConsumedMembers":null,"semanticExtractionComplete":null,"remoteCompleteness":null,"meaning":"source partition coverage and attributed accepted values; does not certify every source event was found or current goal satisfied"});
    result["summaryIdentity"] = json!(digest(&result));
    if result.to_string().len() > 48000 {
        return Err("分批汇总超过48000字节，未截断出处或成员统计".into());
    }
    work.grant.reader(root)?;
    control.check()?;
    Ok(result)
}

// Replaying a recorded computation must revalidate its actual inputs, not just
// the raw-result SHA. Historical records themselves remain immutable.
pub(super) fn verify_saved(
    root: &Path,
    c: &Connection,
    work: &Work,
    value: &Value,
) -> Result<(), String> {
    if value["kind"] != "sleepDatasetBatchSummary" {
        return Ok(());
    }
    let mut body = value.clone();
    body.as_object_mut()
        .ok_or("分批汇总格式损坏")?
        .remove("summaryIdentity");
    if value["summaryIdentity"] != digest(&body) || value["workId"] != work.id {
        return Err("分批汇总身份或内容已改变".into());
    }
    let manifest = work
        .grant
        .manifest
        .as_ref()
        .ok_or("分批汇总的固定范围已失效")?;
    let host = serde_json::to_value(manifest).map_err(|e| e.to_string())?;
    let mut selection = host["selection"].clone();
    selection["limit"] = json!(1);
    if analysis::execute(&work.grant.reader(root)?, "hub_source_manifest", &selection)?["snapshot"]
        != value["manifest"]
    {
        return Err("分批汇总母清单已改变".into());
    }
    let references = value["datasets"]
        .as_array()
        .filter(|refs| (1..=8).contains(&refs.len()))
        .ok_or("分批汇总依赖损坏")?;
    for reference in references {
        let id = reference["datasetId"].as_str().ok_or("分批数据身份损坏")?;
        let saved = find_dataset(c, work, id, None)?;
        eligible_dataset(root, c, work, &saved)?;
        if saved["revision"] != reference["revision"]
            || saved["contentHash"] != reference["contentHash"]
            || saved["snapshot"] != reference["snapshot"]
        {
            return Err("分批数据集已修订，旧汇总保留为历史，不能重送为当前计算".into());
        }
    }
    Ok(())
}
