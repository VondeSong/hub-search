//! A bounded partition of a version-bound metadata manifest, never a new grant.
use super::*;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Batch {
    selection: Value,
    expected_manifest: String,
    offset: usize,
    count: usize,
}
pub(super) fn select(
    reader: &EvidenceReader,
    c: &Connection,
    visible: &[String],
    request: &Value,
) -> Result<(Vec<Source>, Value), String> {
    let batch: Batch =
        serde_json::from_value(request.clone()).map_err(|_| "固定清单分批参数无效")?;
    if !(1..=32).contains(&batch.count) || batch.offset > 5000 {
        return Err("每批固定材料需要1至32份，起点不得超过5000".into());
    }
    let selection = batch.selection.as_object().ok_or("分批清单需要明确筛选")?;
    if !selection.contains_key("libraryId")
        || selection
            .keys()
            .any(|k| !["libraryId", "directory", "dateFrom", "dateTo"].contains(&k.as_str()))
    {
        return Err("分批清单筛选字段无效".into());
    }
    let mut args = batch.selection.clone();
    args["limit"] = json!(batch.count);
    args["cursor"] = json!(format!("{}:{}", batch.expected_manifest, batch.offset));
    let page = super::super::source_manifest::page_on(reader, c, visible, &args)?;
    if page["snapshot"] != batch.expected_manifest {
        return Err("固定清单身份不匹配，未捕获分批输入".into());
    }
    let members = page["members"].as_array().ok_or("固定清单成员无效")?;
    if members.is_empty() {
        return Err("分批区间没有材料，未创建空快照".into());
    }
    let all = sources(reader, c, visible, &batch.selection)?;
    let mut selected = Vec::new();
    for member in members {
        let item = all
            .iter()
            .find(|s| json!(s.locator) == member["locator"])
            .ok_or("分批成员已不在当前授权中")?;
        selected.push(item.clone());
    }
    Ok((
        selected,
        json!({"selection":batch.selection,"expectedManifest":batch.expected_manifest,"offset":batch.offset,"count":batch.count,"actualMembers":members.len(),"totalMembers":page["totalMembers"]}),
    ))
}
