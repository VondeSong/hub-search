//! Exact chart dependencies owned by a delivery or a resumed model thread.
use super::*;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChartReference {
    artifact_id: String,
    revision: u64,
    content_hash: String,
    dataset_revision: String,
    #[serde(default)]
    inherited: bool,
}

fn parse(value: &Value) -> Result<Vec<ChartReference>, String> {
    let refs: Vec<ChartReference> =
        serde_json::from_value(value.clone()).map_err(|_| "图表版本依赖记录损坏")?;
    let mut ids = std::collections::HashSet::new();
    if refs.len() > 16
        || refs.iter().any(|r| {
            r.revision == 0
                || r.revision > 32
                || r.artifact_id.is_empty()
                || r.content_hash.len() != 64
                || r.dataset_revision.len() != 64
                || !ids.insert(&r.artifact_id)
        })
    {
        return Err("图表版本依赖记录无效".into());
    }
    Ok(refs)
}

fn reference(value: &Value, inherited: bool) -> Result<ChartReference, String> {
    serde_json::from_value(json!({"artifactId":value["artifactId"],"revision":value["revision"],
        "contentHash":value["contentHash"],"datasetRevision":value["data"]["datasetRevision"],"inherited":inherited}))
        .map_err(|_| "图表版本记录损坏".into())
}

pub(in crate::agent_work) fn run_references(
    c: &Connection,
    work: &Work,
    run: &str,
) -> Result<Value, String> {
    let mut query = c.prepare("SELECT kind,body_json FROM agent_records WHERE work_id=?1 AND run_id=?2 AND kind IN ('chartRevision','chartUse','chartValidation','chartContext') ORDER BY rowid")
        .map_err(|e| e.to_string())?;
    let rows = query
        .query_map(params![work.id, run], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut refs = std::collections::BTreeMap::new();
    for row in rows {
        let (kind, raw) = row.map_err(|e| e.to_string())?;
        let body: Value = serde_json::from_str(&raw).map_err(|_| "图表使用记录损坏")?;
        if kind == "chartContext" {
            for mut r in parse(&body["artifactRefs"])? {
                r.inherited = true;
                refs.insert(r.artifact_id.clone(), r);
            }
        } else {
            let id = body["artifactId"].as_str().ok_or("图表使用身份缺失")?;
            let revision = body["revision"].as_u64().ok_or("图表使用版本缺失")?;
            let value = find(c, &work.id, id, Some(revision))?;
            refs.insert(id.to_owned(), reference(&value, false)?);
        }
    }
    let value = json!(refs.into_values().collect::<Vec<_>>());
    parse(&value)?;
    Ok(value)
}

pub(in crate::agent_work) fn inspect_references(
    root: &Path,
    c: &Connection,
    work: &Work,
    refs: &Value,
) -> Result<Value, String> {
    let mut projected = Vec::new();
    let mut reasons = Vec::new();
    for r in parse(refs)? {
        let value = find(c, &work.id, &r.artifact_id, Some(r.revision))?;
        eligible(root, c, work, &value)?;
        if value["contentHash"] != r.content_hash
            || value["data"]["datasetRevision"] != r.dataset_revision
        {
            return Err("报告引用的图表内容已损坏，正文已隐藏".into());
        }
        let current = find(c, &work.id, &r.artifact_id, None)?;
        let current_revision = current["revision"].as_u64().ok_or("当前图表版本损坏")?;
        if !store::goal::chart_current_on(c, work, &value)? {
            reasons.push("图表对应的用户要求已更新".into());
        }
        if !sleep::current_on(c, work, &value["analysis"])? {
            reasons.push("主睡眠数据已纠正，图表尚未按新数据重新计算".into());
        }
        if current_revision != r.revision {
            reasons.push(format!(
                "回答使用图表第 {} 版，当前已到第 {} 版",
                r.revision, current_revision
            ));
        }
        projected.push(json!({"artifactId":r.artifact_id,"revision":r.revision,"currentRevision":current_revision,
            "contentHash":r.content_hash,"datasetRevision":r.dataset_revision}));
    }
    Ok(
        json!({"state":if reasons.is_empty(){"current"}else{"stale"},"references":projected,
        "reason":if reasons.is_empty(){String::new()}else{format!("{}；旧回答仅供历史查阅，需按新版重新生成并核对。",reasons.join("；"))}}),
    )
}

pub(in crate::agent_work) fn delivery_projection(
    root: &Path,
    c: &Connection,
    work: &Work,
    run: &str,
    delivery: &Value,
) -> Result<Value, String> {
    let refs = match delivery.get("artifactRefs") {
        Some(refs) => refs.clone(),
        // Pre-V1-C deliveries can be recovered only from their own durable tool receipts.
        None => run_references(c, work, run)?,
    };
    let parsed = parse(&refs)?;
    if let Some(materials) = delivery["materialReads"].as_object() {
        for (key, material) in materials
            .iter()
            .filter(|(key, _)| key.starts_with("chart:"))
        {
            let id = key.trim_start_matches("chart:");
            let r = parsed
                .iter()
                .find(|r| r.artifact_id == id)
                .ok_or("旧报告缺少图表版本证据，正文已隐藏")?;
            let value = find(c, &work.id, id, Some(r.revision))?;
            if material["snapshot"] != value["analysis"]["expectedSnapshot"]
                || material["arguments"] != value["analysis"]
            {
                return Err("报告图表版本与统计依赖不一致，正文已隐藏".into());
            }
        }
    }
    let mut projection = inspect_references(root, c, work, &refs)?;
    if let Some(refs) = delivery.get("fileArtifactRefs") {
        let files = super::super::analysis::inspect_references(root, work, refs)?;
        if files["state"] == "stale" {
            projection["state"] = json!("stale");
            projection["reason"] = files["reason"].clone();
        }
        projection["fileReferences"] = files["references"].clone();
    }
    let current_goal = store::goal::binding_on(c, work)?;
    let goal_changed = match delivery.get("goalBinding") {
        Some(binding) => *binding != current_goal,
        None => current_goal["commandWatermark"] != 0,
    };
    if goal_changed {
        projection["state"] = json!("stale");
        let previous = projection["reason"].as_str().unwrap_or_default();
        projection["reason"] = json!(format!(
            "用户要求已更新；新增或纠正的要求需要重新核对，旧回答仅供历史查阅。{previous}"
        ));
    }
    Ok(projection)
}

pub(in crate::agent_work) fn inherit_references(
    root: &Path,
    work: &Work,
    run: &str,
    refs: &Value,
    control: &Control,
) -> Result<(), String> {
    if parse(refs)?.is_empty() {
        return Ok(());
    }
    store::write(root, |c| {
        let current = check_current(c, work, run, control)?;
        if inspect_references(root, c, &current, refs)?["state"] != "current" {
            return Err("原生会话引用的图表已修订，请重建上下文".into());
        }
        insert(c, work, run, "chartContext", &json!({"artifactRefs":refs}))
    })
}
