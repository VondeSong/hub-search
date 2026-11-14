//! The conversation host supplies the scope and the already admitted model call.
use super::*;
pub(crate) fn run(
    root: &Path,
    args: &Value,
    ask: &mut dyn FnMut(&str, &Value) -> Result<Value, String>,
) -> Result<Value, String> {
    let mut input = args.clone();
    let ids = input["libraryIds"]
        .as_array()
        .filter(|ids| !ids.is_empty())
        .ok_or("标签任务需要明确选择可检索资料库；核心页面不会自动授权所在库")?;
    if ids.len() > 100 {
        return Err("本轮资料库过多".into());
    }
    let tag = normalized_tag_argument(&input, "tag")?;
    let current = tag_assignment::definition(root, &json!({"tag":tag}))?;
    if input["expectedVersion"].as_i64()
        != Some(current["definition"]["version"].as_i64().unwrap_or(0))
    {
        return Err("标签定义已变化，请查看最新定义后重新发送".into());
    }
    let mut definition = current["definition"]["definition"].clone();
    match input["task"].as_str() {
        Some("definition") => {
            if definition.is_null() {
                definition = json!({"description":"","include":"","exclude":""});
            }
            definition["libraryIds"] = input["libraryIds"].clone();
            input["currentInput"] = definition;
            tag_assignment::generate::generate_with(root, &input, ask)
        }
        Some("missing") => {
            input["currentInput"] = definition;
            tag_assignment::discover::run_with(root, &input, |p, s, _, _, _| ask(p, s))
        }
        Some("relations") => {
            if input["compareTag"] == input["tag"] {
                return Err("请选择两个不同的标签，或清除比较对象以自动寻找候选".into());
            }
            tag_governance_generate::run_with(root, &input, &mut |p, s, _, _, _| ask(p, s))
        }
        _ => Err("标签任务类型无效".into()),
    }
}

pub(crate) fn definition(root: &Path, args: &Value) -> Result<Value, String> {
    tag_assignment::definition(root, args)
}

pub(crate) fn discovery_checkpoint(root: &Path, args: &Value) -> Result<Value, String> {
    let current = definition(root, args)?;
    let saved = &current["definition"];
    let checkpoint = tag_assignment::discover::status(root, args)?;
    let allowed = saved["definition"]["libraryIds"]
        .as_array()
        .ok_or("定义范围无效")?;
    let selected = args["libraryIds"].as_array().ok_or("本轮资料库范围无效")?;
    let scope: Vec<_> = selected
        .iter()
        .filter(|id| allowed.contains(id))
        .cloned()
        .collect();
    if checkpoint.is_null()
        || checkpoint["stale"] == true
        || scope.is_empty()
        || saved["version"] != args["expectedVersion"]
        || checkpoint["definitionVersion"] != args["expectedVersion"]
        || checkpoint["libraryIds"] != json!(scope)
    {
        return Err("没有可继续的清单，或定义及资料范围已改变".into());
    }
    Ok(checkpoint)
}
pub(crate) fn catalog(root: &Path, args: &Value) -> Result<Value, String> {
    hub_tag_catalog(root, args)
}

pub(crate) fn saved_relation_proposals(root: &Path, result: &Value) -> Result<Value, String> {
    let ids: Vec<_> = result["submitted"]
        .as_array()
        .ok_or("关系任务结果缺失")?
        .iter()
        .map(|p| p["proposalId"].as_str().ok_or("关系建议身份缺失"))
        .collect::<Result<_, _>>()?;
    if ids.is_empty() {
        return Ok(json!({"proposals":[]}));
    }
    if ids.len() > 2 {
        return Err("关系任务超出原批次容量".into());
    }
    let saved = hub_list_tag_governance_proposals(root, &json!({"proposalIds":ids,"limit":2}))?;
    if saved["count"].as_u64() != Some(ids.len() as u64) {
        return Err("任务关联的关系建议已不可完整回读".into());
    }
    Ok(saved)
}
pub(crate) fn materials(
    root: &Path,
    args: &Value,
    libraries: &[String],
    notes: &Value,
) -> Result<Value, String> {
    let tags: Vec<String> =
        serde_json::from_value(args["tags"].clone()).map_err(|_| "标签列表无效")?;
    if tags.is_empty()
        || tags.len() > 16
        || tags.iter().any(|s| s.trim().is_empty() || s.len() > 200)
    {
        return Err("请选择 1 至 16 个标签".into());
    }
    let tags: Vec<String> = tags
        .into_iter()
        .map(|t| t.to_lowercase())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let c = open_database(&hub_mcp_database(root)?)?;
    let sql=format!("{HUB_TAG_ENTITIES_CTE}, matches AS (SELECT library_id,document_id,page_id FROM all_tags t WHERE provider IN ('craft','obsidian') AND normalized_tag IN (SELECT value FROM json_each(?1)) AND (library_id IN (SELECT value FROM json_each(?2)) OR EXISTS(SELECT 1 FROM json_each(?3) n WHERE json_extract(n.value,'$.libraryId')=t.library_id AND json_extract(n.value,'$.documentId')=t.document_id AND (json_extract(n.value,'$.pageId') IS NULL OR json_extract(n.value,'$.pageId')=t.page_id))) GROUP BY library_id,document_id,page_id HAVING COUNT(DISTINCT normalized_tag)>=?4) SELECT m.library_id,m.document_id,m.page_id,d.title,d.path,l.name,l.provider FROM matches m JOIN documents d ON d.space_id=m.library_id AND d.id=m.document_id JOIN libraries l ON l.id=m.library_id WHERE l.enabled=1 ORDER BY d.title,m.library_id,m.page_id LIMIT 50");
    let mut q = c.prepare(&sql).map_err(|e| e.to_string())?;
    let rows=q.query_map(params![json!(tags).to_string(),json!(libraries).to_string(),notes.to_string(),if args["matchAll"]==true{tags.len()}else{1}],|r|{let provider:String=r.get(6)?;let page:String=r.get(2)?;Ok(json!({"locator":{"kind":"note","libraryId":r.get::<_,String>(0)?,"documentId":r.get::<_,String>(1)?,"pageId":if provider=="craft"&&!page.is_empty(){Some(page)}else{None}},"title":r.get::<_,String>(3)?,"path":r.get::<_,String>(4)?,"libraryName":r.get::<_,String>(5)?}))}).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    Ok(
        json!({"materials":rows,"coverage":"仅返回当前范围内最多 50 份关联页面，选择后才作为核心材料加入"}),
    )
}
