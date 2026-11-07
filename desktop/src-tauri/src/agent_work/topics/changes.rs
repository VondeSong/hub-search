//! Read-only comparison of saved bindings with current local source metadata.
use super::*;
use std::collections::BTreeMap;
#[cfg(test)]
mod tests;

fn enabled(c: &Connection, library: &str) -> Result<(), String> {
    let allowed:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM libraries WHERE id=?1 AND enabled=1 AND provider='obsidian')",[library],|r|r.get(0)).map_err(|e|e.to_string())?;
    if allowed {
        Ok(())
    } else {
        Err("来源资料库不可用，未继续检查材料".into())
    }
}
fn notes(root: &Path, c: &Connection, config: &Value, month: &str) -> Result<Vec<Value>, String> {
    if config["sourceRule"]["periodDirectory"].as_str().is_none() {
        return Ok(entry::period_scope(root, c, config, month)?.2);
    }
    if config["schemaVersion"] != 2 {
        return Err("月份规则版本不兼容".into());
    }
    enabled(
        c,
        config["sourceRule"]["anchor"]["libraryId"]
            .as_str()
            .ok_or("专题资料库无效")?,
    )?;
    let selection = entry::period_selection(config, month)?;
    let mut page = source_scope::preview(root, &json!({"selection":selection}))?;
    let snapshot = page["snapshot"].clone();
    let mut result = Vec::new();
    loop {
        if page["snapshot"] != snapshot {
            return Err("检查期间成员或版本已变化，请重新核对".into());
        }
        for item in page["members"].as_array().ok_or("成员元数据缺失")? {
            result.push(json!({"locator":item["locator"],"title":item["title"],"sourcePath":item["path"],"version":item["sourceRevision"]}));
        }
        if result.len() > 5000 || json!(result).to_string().len() > 65536 {
            return Err("完整变化检查超过容量，未截断材料；请缩小目录".into());
        }
        if page["nextCursor"].is_null() {
            break;
        }
        page = source_scope::preview(
            root,
            &json!({"selection":selection,"cursor":page["nextCursor"]}),
        )?;
    }
    Ok(result)
}
fn indexed(values: &[Value]) -> Result<BTreeMap<String, Value>, String> {
    let mut result = BTreeMap::new();
    for item in values {
        let locator: EvidenceLocator = serde_json::from_value(item["locator"].clone())
            .map_err(|_| "变化记录的来源身份无效")?;
        if result
            .insert(json!(locator).to_string(), item.clone())
            .is_some()
        {
            return Err("变化记录含重复来源身份".into());
        }
    }
    Ok(result)
}
fn source_changes(before: Option<&Vec<Value>>, current: &[Value]) -> Result<Value, String> {
    let Some(before) = before else {
        return Ok(
            json!({"status":"unverified","beforeCount":null,"currentCount":current.len(),"added":null,"removed":null,"changed":null,"uncomparable":null,"reason":"旧绑定没有完整成员版本，不能把当前成员冒充旧基版"}),
        );
    };
    let old = indexed(before)?;
    let new = indexed(current)?;
    let added = new.keys().filter(|key| !old.contains_key(*key)).count();
    let removed = old.keys().filter(|key| !new.contains_key(*key)).count();
    let mut changed = 0;
    let mut unknown = 0;
    for (key, previous) in &old {
        let Some(now) = new.get(key) else {
            continue;
        };
        let a = &previous["version"];
        let b = &now["version"];
        if a.is_null()
            || b.is_null()
            || a.is_array() != b.is_array()
            || a.is_object() != b.is_object()
            || (a.is_object() && a["kind"] != b["kind"])
        {
            unknown += 1;
            continue;
        }
        if a != b
            || previous["sourcePath"] != now["sourcePath"]
            || previous["title"] != now["title"]
        {
            changed += 1;
        }
    }
    Ok(
        json!({"status":if unknown==0{"compared"}else{"partlyUnverified"},"beforeCount":old.len(),"currentCount":new.len(),"added":added,"removed":removed,"changed":changed,"uncomparable":unknown}),
    )
}
pub(super) fn inspect(root: &Path, args: &Value) -> Result<Value, String> {
    let id = text(args, "topicId", 100)?;
    let work_id = text(args, "workId", 150)?;
    let c = crate::source_evidence::open_read_database(root)?;
    let topic = latest(&c, &id)?;
    if topic["revision"] != expected(args, "expectedRevision")? {
        return Err("专题配置已变化，请重新读取设置".into());
    }
    let month: String = c
        .query_row(
            "SELECT period FROM agent_topic_works WHERE topic_id=?1 AND work_id=?2",
            params![id, work_id],
            |r| r.get(0),
        )
        .map_err(|_| "该工作不属于当前专题")?;
    let w = store::load(&c, &work_id)?;
    if w.state == "revoked" {
        return Err("来源授权已撤回，未继续检查".into());
    }
    if w.revision != expected(args, "expectedWorkRevision")?
        || w.authorization_version != expected(args, "expectedAuthorizationVersion")?
    {
        return Err("原工作或授权已变化，请重新核对当前状态".into());
    }
    if !w.grant.reading_item_keys.is_empty()
        || !w.grant.sources.is_empty()
        || !w.grant.images.is_empty()
        || !w.grant.attachment_library_ids.is_empty()
    {
        return Err("变化检查仅支持既有Obsidian笔记范围".into());
    }
    for library in &w.grant.library_ids {
        enabled(&c, library)?;
    }
    for note in w
        .grant
        .notes
        .iter()
        .chain(w.grant.manifest.iter().flat_map(|m| m.members.iter()))
    {
        let EvidenceLocator::Note { library_id, .. } = note else {
            return Err("变化检查仅支持笔记".into());
        };
        enabled(&c, library_id)?;
    }
    let actual:Option<(String,String)>=c.query_row("SELECT run_id,body_json FROM agent_records WHERE work_id=?1 AND kind='topicRunBinding' ORDER BY rowid DESC LIMIT 1",[&work_id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e|e.to_string())?;
    let (baseline, run, origin) = if let Some((run, raw)) = actual {
        (Some(decode(&raw)?), Some(run), "actualRunBinding")
    } else {
        (
            version_on(&c, &w)?.map(|(binding, _)| binding),
            None,
            "workBindingOnlyOrLegacy",
        )
    };
    if let Some(b) = &baseline {
        if b["topicId"] != id
            || b["authorizationVersion"] != w.authorization_version
            || b["scopeFingerprint"] != source_rule(&w)["scopeFingerprint"]
        {
            return Err("旧绑定与当前专题或授权范围不同，请先在原工作核对；未重新授权".into());
        }
    }
    let current = notes(root, &c, &topic["config"], &month)?;
    let sources = source_changes(
        baseline
            .as_ref()
            .and_then(|b| b["scopeConfirmation"]["members"].as_array()),
        &current,
    )?;
    let method = method_on(&c, topic["methodVersion"].as_str().ok_or("当前方法缺失")?)?;
    let mut catalog = skills::Catalog::discover(root)?;
    let compatible = catalog.pin_version(&method);
    let old_config = baseline
        .as_ref()
        .map(|b| {
            c.query_row(
                "SELECT config_json FROM agent_topic_revisions WHERE topic_id=?1 AND revision=?2",
                params![id, b["configRevision"].as_i64().ok_or("旧配置版本缺失")?],
                |r| r.get::<_, String>(0),
            )
            .map_err(|e| e.to_string())
            .and_then(|raw| decode(&raw))
        })
        .transpose()?;
    let mut parameters = topic["config"]["parameters"].clone();
    parameters["period"] = json!(month);
    let method_changed = baseline
        .as_ref()
        .map(|b| b["methodVersion"] != topic["methodVersion"]);
    let parameters_changed = baseline.as_ref().map(|b| {
        b["parameters"] != parameters || b["defaultQuestion"] != topic["config"]["defaultQuestion"]
    });
    let rule_changed = old_config
        .as_ref()
        .map(|old| old["sourceRule"] != topic["config"]["sourceRule"]);
    let old_model:Option<Value>=run.as_ref().map(|run|c.query_row("SELECT body_json FROM agent_records WHERE work_id=?1 AND run_id=?2 AND kind='modelSelection' ORDER BY rowid DESC LIMIT 1",params![work_id,run],|r|r.get::<_,String>(0)).optional().map_err(|e|e.to_string()).and_then(|raw|raw.map(|raw|decode(&raw)).transpose())).transpose()?.flatten();
    let settings =
        crate::model_runtime::selected_settings(root, options::load_on(&c, &work_id)?.model)?;
    let now_model = json!({"provider":settings.provider,"model":settings.model,"reasoningEffort":settings.reasoning_effort,"fast":settings.fast});
    let model_changed = old_model.as_ref().map(|old| {
        ["provider", "model", "reasoningEffort", "fast"]
            .iter()
            .any(|key| old[key] != now_model[key])
    });
    let method_use:Option<Value>=run.as_ref().map(|run|c.query_row("SELECT body_json FROM agent_records WHERE run_id=?1 AND kind='topicMethodUse' ORDER BY rowid DESC LIMIT 1",[run],|r|r.get::<_,String>(0)).optional().map_err(|e|e.to_string()).and_then(|raw|raw.map(|raw|decode(&raw)).transpose())).transpose()?.flatten();
    let has_changes = ["added", "removed", "changed"]
        .iter()
        .any(|key| sources[key].as_u64().unwrap_or(0) > 0)
        || [
            method_changed,
            parameters_changed,
            rule_changed,
            model_changed,
        ]
        .contains(&Some(true));
    let complete = sources["status"] == "compared"
        && [
            method_changed,
            parameters_changed,
            rule_changed,
            model_changed,
        ]
        .iter()
        .all(Option::is_some)
        && compatible.is_ok();
    let result = json!({"schemaVersion":1,"topicId":id,"topicRevision":topic["revision"],"workId":work_id,"workRevision":w.revision,"authorizationVersion":w.authorization_version,"period":month,
        "state":if has_changes{"changed"}else if complete{"unchanged"}else{"unverified"},"sources":sources,"currentMembers":current,
        "baseline":{"origin":origin,"runId":run,"configRevision":baseline.as_ref().map(|b|&b["configRevision"]),"methodVersion":baseline.as_ref().map(|b|&b["methodVersion"]),"methodUse":method_use},
        "selectedMethod":topic["methodVersion"],"methodChanged":method_changed,"parametersChanged":parameters_changed,"sourceRuleChanged":rule_changed,"requestedModelChanged":model_changed,"previousRequestedModel":old_model,"currentRequestedModel":now_model,"actualServedModel":"unknown","methodCompatible":compatible.is_ok(),"methodUnavailableReason":compatible.err(),
        "sourceFreshness":"current authorized local cache, not remote verification","effects":"read-only; no grant, model dispatch, budget reset, recompute or publication; source differences are version observations, not a causal explanation of report numbers"});
    let final_work = store::load(&c, &work_id)?;
    if final_work.revision != w.revision
        || final_work.authorization_version != w.authorization_version
        || final_work.state == "revoked"
        || latest(&c, &id)?["revision"] != topic["revision"]
    {
        return Err("检查期间工作、授权或专题已变化，请重新核对；未采用旧结果".into());
    }
    if result.to_string().len() > 65536 {
        return Err("完整变化说明超过64KiB，未截断显示；请缩小目录".into());
    }
    Ok(result)
}
