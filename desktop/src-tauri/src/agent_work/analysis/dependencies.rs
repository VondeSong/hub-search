//! File artifacts depend on the inputs actually passed to their execution.
use super::*;
use std::collections::{BTreeSet, HashMap};

pub(super) fn id(meta: &Value) -> String {
    if meta["locator"].is_object() {
        format!("local:{}", digest(meta["locator"].to_string().as_bytes()))
    } else {
        format!("public:{}", meta["id"].as_str().unwrap_or_default())
    }
}

pub(super) fn select(
    root: &Path,
    work: &Work,
    selected: Option<&[String]>,
) -> Result<Vec<(String, PathBuf, Value)>, String> {
    if work.state == "revoked" {
        return Err("本对话授权已撤回".into());
    }
    if selected.is_some_and(|ids| {
        ids.is_empty() || ids.len() > 8 || ids.iter().collect::<BTreeSet<_>>().len() != ids.len()
    }) {
        return Err("请明确选择1至8个不同的分析输入".into());
    }
    let mut grant = work.grant.clone();
    if let Some(ids) = selected {
        grant
            .notes
            .retain(|locator| ids.contains(&id(&json!({"locator":locator}))));
    }
    let mut values = selected_inputs(root, &grant)?;
    let public_ids = selected.map(|ids| {
        ids.iter()
            .filter_map(|id| id.strip_prefix("public:").map(str::to_owned))
            .collect::<Vec<_>>()
    });
    for (ext, path, meta) in files::data_inputs_selected(root, work, public_ids.as_deref())? {
        values.push((format!("input-{}.{}", values.len() + 1, ext), path, meta));
    }
    if values.len() > 8 {
        return Err("每项分析最多8个文件，请缩小范围".into());
    }
    for (_, _, meta) in &mut values {
        meta["inputId"] = json!(id(meta));
    }
    if selected.is_some_and(|ids| {
        ids.iter()
            .any(|id| !values.iter().any(|(_, _, meta)| meta["inputId"] == *id))
    }) {
        return Err("所选分析输入已变化、撤回或不属于本对话".into());
    }
    Ok(values)
}

pub(super) struct Verifier<'a> {
    root: &'a Path,
    work: &'a Work,
    checked: HashMap<String, Result<Value, String>>,
}
impl<'a> Verifier<'a> {
    pub(super) fn new(root: &'a Path, work: &'a Work) -> Self {
        Self {
            root,
            work,
            checked: HashMap::new(),
        }
    }
    pub(super) fn verify(&mut self, receipt: &Value) -> Result<(), String> {
        if self.work.state == "revoked" {
            return Err("本对话授权已撤回".into());
        }
        let Some(saved) = receipt.get("inputs").and_then(Value::as_array) else {
            // Historical receipts without an input manifest retain their conservative guard.
            if receipt["authorizationVersion"] != self.work.authorization_version {
                return Err("旧成果缺少逐文件依赖，授权变化后需重新分析".into());
            }
            return inputs(self.root, self.work).map(|_| ());
        };
        if saved.is_empty() || saved.len() > 8 {
            return Err("成果输入依赖清单无效".into());
        }
        for old in saved {
            let key = id(old);
            let current = self
                .checked
                .entry(key.clone())
                .or_insert_with(|| {
                    select(self.root, self.work, Some(&[key])).and_then(|values| {
                        values
                            .into_iter()
                            .next()
                            .map(|(_, _, meta)| meta)
                            .ok_or_else(|| "成果输入已不在当前授权中".into())
                    })
                })
                .as_ref()
                .map_err(Clone::clone)?;
            if current["sha256"] != old["sha256"] || current["source"] != old["source"] {
                return Err("成果所用输入版本已变化，需仅重算受影响成果".into());
            }
        }
        Ok(())
    }
}

pub(super) fn catalog(root: &Path, work: &Work) -> Vec<Value> {
    if work.state == "revoked" {
        return vec![];
    }
    let mut result = Vec::new();
    for locator in &work.grant.notes {
        if !crate::source_evidence::local_text::is_local(locator) {
            continue;
        }
        let Ok(Some(meta)) =
            crate::source_evidence::local_text::selected_file_manifest(root, locator)
        else {
            continue;
        };
        if !is_file_manifest(&meta) {
            continue;
        }
        let key = id(&json!({"locator":locator}));
        let check = select(root, work, Some(&[key.clone()]));
        result.push(json!({"inputId":key,"title":meta["title"],"sha256":meta["sha256"],"bytes":meta["bytes"],"sourceFolder":meta["sourceFolder"],"available":check.is_ok(),"unavailableReason":check.err(),"originalAttachment":meta["format"] == ORIGINAL_MARKER}));
    }
    for receipt in store::records(root, &work.id, "publicFileAcquisition", 64).unwrap_or_default() {
        let file = &receipt["file"];
        if !matches!(file["extension"].as_str(), Some("csv" | "xlsx" | "json")) {
            continue;
        }
        let key = id(file);
        if result.iter().any(|v| v["inputId"] == key) {
            continue;
        }
        let check = select(root, work, Some(&[key.clone()]));
        result.push(json!({"inputId":key,"title":file["title"],"sha256":file["sha256"],"available":check.is_ok(),"unavailableReason":check.err()}));
    }
    result
}
