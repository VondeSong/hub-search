//! Immutable builtin method bytes; persistence and authority remain with the Work owner.
use super::*;
use std::sync::OnceLock;

pub(super) fn tool_contract_version() -> &'static str {
    static VERSION: OnceLock<String> = OnceLock::new();
    VERSION.get_or_init(|| {
        hash(
            &json!({
                "shared":crate::hub_capabilities::catalog(),
                "host":crate::agent_work::assistant::schema(crate::agent_work::runner::schema())
            })
            .to_string(),
        )
    })
}

// Only this description-only resource extension is backward-compatible; other schema changes still reject.
pub(super) fn compatible_contract(version: &Value) -> bool {
    if version == tool_contract_version() {
        return true;
    }
    let mut shared = crate::hub_capabilities::catalog();
    for tool in shared["tools"].as_array_mut().unwrap() {
        if tool["name"] == "hub_readSkillReference" {
            let old = json!("读取已加载技能 references/ 内的文字参考；不执行脚本。");
            tool["description"] = old.clone();
            tool["annotations"]["title"] = old;
        }
    }
    let previous=hash(&json!({"shared":shared,"host":crate::agent_work::assistant::schema(crate::agent_work::runner::schema())}).to_string());
    version.as_str() == Some(previous.as_str())
}

fn reference_path(path: &str) -> bool {
    path.starts_with("references/")
        && !path.contains('\\')
        && Path::new(path)
            .components()
            .all(|p| matches!(p, Component::Normal(_)))
        && ["md", "txt", "json", "yaml", "yml", "csv"].contains(
            &Path::new(path)
                .extension()
                .and_then(|p| p.to_str())
                .unwrap_or_default(),
        )
}

pub(super) fn snapshot(catalog: &Catalog, name: &str) -> Result<Value, String> {
    catalog.verify()?;
    if let Some(pin) = &catalog.pinned {
        if pin["content"]["name"] == name {
            return Ok(pin.clone());
        }
    }
    let skill = catalog.skills.get(name).ok_or("方法不存在")?;
    if skill.package.is_some() {
        let saved = catalog.registered.get(name).ok_or("登记方法固定字节缺失")?;
        restore(catalog, saved)?;
        if !skill.unavailable.is_empty() {
            return Err(skill.unavailable.join("；"));
        }
        return Ok(saved.clone());
    }
    if skill.directory.is_some() {
        return Err("首批专题只支持固定内置方法，用户技能包尚未接入版本保存".into());
    }
    if !skill.unavailable.is_empty() {
        return Err(skill.unavailable.join("；"));
    }
    let document = BUILTINS
        .iter()
        .find(|text| parse(text, "", None).is_ok_and(|s| s.name == name))
        .ok_or("内置方法正文不可用")?;
    let mut files = BTreeMap::from([("SKILL.md".to_string(), (*document).to_string())]);
    for (owner, path, content) in BUILTIN_REFERENCES {
        if *owner == name {
            files.insert((*path).into(), (*content).into());
        }
    }
    let content = json!({"schemaVersion":1,"origin":"builtin","name":name,"toolContractVersion":tool_contract_version(),"files":files});
    let value = json!({"id":format!("method-{}",hash(&content.to_string())),"content":content});
    restore(catalog, &value)?;
    Ok(value)
}

pub(super) fn restore(catalog: &Catalog, value: &Value) -> Result<Skill, String> {
    // Same existing record ceiling; never truncate a method into apparent completeness.
    if value.to_string().len() > 65_536 || value.as_object().is_none_or(|v| v.len() != 2) {
        return Err("固定方法内容超限或身份无效".into());
    }
    let content = &value["content"];
    if content["schemaVersion"] == 2 {
        if !compatible_contract(&content["toolContractVersion"]) {
            return Err("固定方法所用工具合同已变化，旧内容仍保留，不能静默沿用".into());
        }
        return packages::restore(catalog, value);
    }
    if content.as_object().is_none_or(|v| v.len() != 5)
        || content["schemaVersion"] != 1
        || content["origin"] != "builtin"
        || value["id"] != format!("method-{}", hash(&content.to_string()))
    {
        return Err("固定方法内容与版本指纹不匹配，未使用替代内容".into());
    }
    if !compatible_contract(&content["toolContractVersion"]) {
        return Err("固定方法所用工具合同已变化，旧内容仍保留，不能静默沿用".into());
    }
    let name = content["name"].as_str().ok_or("固定方法名称缺失")?;
    if !catalog
        .skills
        .get(name)
        .is_some_and(|s| s.directory.is_none() && s.package.is_none())
    {
        return Err("原内置方法已不可用，不能借旧快照恢复已移除的方法".into());
    }
    let files = content["files"]
        .as_object()
        .ok_or("固定方法缺少正文与资源")?;
    if files.is_empty() || files.len() > 33 {
        return Err("固定方法资源数量无效".into());
    }
    for (path, value) in files {
        let text = value.as_str().ok_or("固定方法资源不是文字")?;
        if path == "SKILL.md" {
            if text.len() > MAX_DOCUMENT {
                return Err("固定方法正文超限".into());
            }
        } else if !reference_path(path) || text.len() > MAX_REFERENCE {
            return Err("固定方法参考路径或大小无效".into());
        }
    }
    let document = files
        .get("SKILL.md")
        .and_then(Value::as_str)
        .ok_or("固定方法缺少完整 SKILL.md")?;
    let skill = parse(document, "", None)?;
    if skill.name != name {
        return Err("固定方法名称与正文不一致".into());
    }
    Ok(skill)
}

#[cfg(test)]
mod tests;
