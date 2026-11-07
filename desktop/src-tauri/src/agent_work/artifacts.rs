//! Work-owned, immutable chart revisions. Numeric data is always produced by
//! the authorized analysis service, never supplied by the model or the UI.
use super::*;
use crate::source_evidence::analysis;
use sha2::{Digest, Sha256};

mod deliveries;
pub(super) mod sleep;
pub(super) use deliveries::{
    delivery_projection, inherit_references, inspect_references, run_references,
};

#[cfg(test)]
mod tests;

fn object(properties: Value) -> Value {
    let required: Vec<_> = properties.as_object().unwrap().keys().cloned().collect();
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}

pub(super) fn schema() -> Value {
    let text = json!({"type":"string","minLength":1,"maxLength":160});
    let id = json!({"type":"string","minLength":1,"maxLength":100});
    let revision = json!({"type":"integer","minimum":1,"maximum":32});
    let spec = object(json!({
        "title":text,"mark":{"type":"string","enum":["bar","line"]},
        "metric":{"type":"string","enum":["units","characters","occurrences","matchingUnits","sleep_duration_hours"]},
        "term":{"type":["string","null"],"maxLength":100},
        "sort":{"type":"string","enum":["groupAsc","groupDesc","valueAsc","valueDesc"]}
    }));
    // Reuse the existing analysis contract, including its unknown-field policy.
    let mut input = crate::hub_capabilities::catalog()["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "hub_analyze_notes")
        .unwrap()["inputSchema"]
        .clone();
    input["required"] = json!(["expectedSnapshot"]);
    input["properties"]["expectedSnapshot"]["minLength"] = json!(1);
    let input = json!({"anyOf":[input,sleep::binding_schema()]});
    json!({"anyOf":[
        object(json!({"action":{"type":"string","enum":["create"]},"operationId":id,"analysis":input,"spec":spec})),
        object(json!({"action":{"type":"string","enum":["patch"]},"operationId":id,"artifactId":id,"expectedRevision":revision,"spec":{"anyOf":[spec,{"type":"null"}]},"analysis":{"anyOf":[input,{"type":"null"}]},"reason":text})),
        object(json!({"action":{"type":"string","enum":["read","validate"]},"artifactId":id,"revision":revision}))
    ]})
}

fn digest(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}

fn records(c: &Connection, work: &str, kind: &str) -> Result<Vec<Value>, String> {
    let mut q = c
        .prepare("SELECT body_json FROM agent_records WHERE work_id=?1 AND kind=?2 ORDER BY rowid")
        .map_err(|e| e.to_string())?;
    let result = q
        .query_map(params![work, kind], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .map(|r| {
            serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|_| "图表记录损坏".into())
        })
        .collect();
    result
}

fn find(c: &Connection, work: &str, id: &str, revision: Option<u64>) -> Result<Value, String> {
    records(c, work, "chartRevision")?
        .into_iter()
        .rev()
        .find(|v| v["artifactId"] == id && revision.is_none_or(|r| v["revision"] == r))
        .ok_or_else(|| "图表或指定版本不存在于当前事项".into())
}

fn eligible(root: &Path, c: &Connection, work: &Work, value: &Value) -> Result<(), String> {
    if value["contentHash"]
        != digest(&json!({"spec":value["spec"],"analysis":value["analysis"],"data":value["data"]}))
    {
        return Err("图表内容校验失败".into());
    }
    if work.state == "revoked" || value["authorizationVersion"] != work.authorization_version {
        return Err("图表授权已改变".into());
    }
    sleep::verify_binding(root, c, work, &value["analysis"])?;
    let reader = store::materials::grant_at(
        c,
        work,
        value["goalRevision"].as_i64().ok_or("图表事项版本缺失")?,
    )?
    .reader(root)?;
    analysis::verify_in_transaction(
        &reader,
        c,
        &json!({"chart":{
            "snapshot":value["analysis"]["expectedSnapshot"],"arguments":value["analysis"]
        }}),
    )
}

fn rows(stats: &Value, spec: &Value) -> Result<(Vec<Value>, String), String> {
    let metric = spec["metric"].as_str().ok_or("图表指标缺失")?;
    let term = spec["term"].as_str();
    if matches!(metric, "units" | "characters") && !spec["term"].is_null() {
        return Err("记录数或字符数不接受关键词字段".into());
    }
    let dated = stats["analysisUnit"] == "uniqueDatePerLibrary";
    let unit = match metric {
        "units" => {
            if dated {
                "记录天数（各库分别计数）"
            } else {
                "材料数"
            }
        }
        "characters" => "Unicode 字符数",
        "occurrences" => "文字提及次数",
        "matchingUnits" => {
            if dated {
                "提及天数（各库分别计数）"
            } else {
                "提及材料数"
            }
        }
        _ => return Err("不支持的图表指标".into()),
    };
    let mut result = Vec::new();
    let groups = stats["groups"].as_array().ok_or("统计分组缺失")?;
    for group in groups {
        let counts = &group["counts"];
        let number = if matches!(metric, "occurrences" | "matchingUnits") {
            let term = term
                .filter(|s| !s.is_empty())
                .ok_or("提及指标需要指定已统计关键词")?;
            counts["terms"]
                .as_array()
                .and_then(|terms| terms.iter().find(|t| t["term"] == term))
                .and_then(|t| t[metric].as_u64())
                .ok_or("关键词不在统计结果中")?
        } else {
            counts[metric].as_u64().ok_or("统计数值无效")?
        };
        if number > 9_007_199_254_740_991 {
            return Err("数值超出图表精确整数范围".into());
        }
        result.push(json!({"group":group["group"],"value":number}));
    }
    if result.is_empty() {
        return Err("没有可绘制的统计分组".into());
    }
    result.sort_by(|a, b| {
        let group = a["group"].as_str().cmp(&b["group"].as_str());
        match spec["sort"].as_str() {
            Some("groupDesc") => group.reverse(),
            Some("valueAsc") => a["value"].as_u64().cmp(&b["value"].as_u64()).then(group),
            Some("valueDesc") => b["value"].as_u64().cmp(&a["value"].as_u64()).then(group),
            _ => group,
        }
    });
    Ok((result, unit.into()))
}

fn compute(
    root: &Path,
    work: &Work,
    input: &Value,
    spec: &Value,
    control: &Control,
) -> Result<Value, String> {
    if !input["expectedSnapshot"]
        .as_str()
        .is_some_and(|id| id.starts_with("analysis-v1:"))
    {
        return Err("图表需要先通过 hub_create_analysis_snapshot 固定分析输入".into());
    }
    if spec["title"].as_str().is_none_or(|s| s.trim().is_empty()) {
        return Err("图表标题不能为空".into());
    }
    if input["source"] == "sleepDataset" {
        let data = sleep::compute(root, work, input, spec, control)?;
        if data.to_string().len() > 48_000 {
            return Err("图表数据超过当前有界成果容量".into());
        }
        return Ok(data);
    }
    let reader = work.grant.reader(root)?.controlled(control.clone());
    let stats = analysis::execute(&reader, "hub_analyze_notes", input)?;
    if stats["complete"] != true || stats["groupsTruncated"] != false {
        return Err("统计包含缺失正文或分组截断，请缩小范围或补齐材料后重建输入".into());
    }
    let (data, unit) = rows(&stats, spec)?;
    let value = json!({"datasetRevision":digest(&json!({"analysis":input,"statistics":stats})),
        "statistics":stats,"rows":data,"unit":unit});
    if value.to_string().len() > 48_000 {
        return Err("图表数据超过当前有界成果容量".into());
    }
    Ok(value)
}

fn check_current(
    c: &Connection,
    work: &Work,
    run: &str,
    control: &Control,
) -> Result<Work, String> {
    control.check()?;
    let current = store::load(c, &work.id)?;
    let running: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM agent_runs WHERE id=?1 AND work_id=?2 AND state='investigating')",
        params![run, work.id], |r| r.get(0)).map_err(|e| e.to_string())?;
    if !running
        || current.state == "revoked"
        || current.active_run.as_deref() != Some(run)
        || current.revision != work.revision
        || current.authorization_version != work.authorization_version
    {
        return Err("图表所属运行或授权已改变".into());
    }
    Ok(current)
}

fn insert(c: &Connection, work: &Work, run: &str, kind: &str, value: &Value) -> Result<(), String> {
    store::insert(c, &work.id, Some(run), kind, value)?;
    // The view's existing revision gate must observe even same-millisecond edits.
    let stamp: i64 = c
        .query_row(
            "SELECT COALESCE(MAX(created_at),0)+1 FROM agent_records WHERE work_id=?1",
            [&work.id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    c.execute(
        "UPDATE agent_records SET created_at=?1 WHERE rowid=last_insert_rowid()",
        [stamp],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn inspection(root: &Path, c: &Connection, work: &Work, value: Value) -> Result<Value, String> {
    eligible(root, c, work, &value)?;
    let latest = find(
        c,
        &work.id,
        value["artifactId"].as_str().ok_or("图表身份损坏")?,
        None,
    )?;
    let receipt = records(c, &work.id, "chartValidation")?
        .into_iter()
        .rev()
        .find(|r| {
            r["artifactId"] == value["artifactId"]
                && r["revision"] == value["revision"]
                && r["contentHash"] == value["contentHash"]
        });
    let stale = !store::goal::chart_current_on(c, work, &value)?
        || !sleep::current_on(c, work, &value["analysis"])?;
    let state = if stale {
        "stale"
    } else if receipt.as_ref().is_some_and(|r| r["status"] == "passed") {
        "checked"
    } else {
        "draft"
    };
    Ok(
        json!({"artifactId":value["artifactId"],"revision":value["revision"],"currentRevision":latest["revision"],
        "state":state,"content":value,"validation":receipt,"visualCheck":"unavailable","published":false}),
    )
}

// UI reads persisted revisions without starting or resuming a model run. Read
// the grant and content in one database snapshot, using the same eligibility
// checks as the model-facing reader; never fall back to the latest revision.
pub(super) fn reopen(root: &Path, args: &Value) -> Result<Value, String> {
    let id = text(args, "id", 150)?;
    let artifact = text(args, "artifactId", 100)?;
    let revision = args["revision"]
        .as_u64()
        .filter(|n| (1..=32).contains(n))
        .ok_or("图表版本无效")?;
    let mut c = crate::source_evidence::open_read_database(root)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let work = store::load(&tx, &id)?;
    let value = find(&tx, &id, &artifact, Some(revision))?;
    if args["action"] == "artifactSource" {
        eligible(root, &tx, &work, &value)?;
        let row_id = text(args, "rowId", 180)?;
        let index = args["evidenceIndex"].as_u64().ok_or("出处编号无效")?;
        let evidence = value["data"]["extractionDataset"]["rows"]
            .as_array()
            .and_then(|rows| rows.iter().find(|row| row["rowId"] == row_id))
            .and_then(|row| row["evidenceRefs"].as_array())
            .and_then(|refs| usize::try_from(index).ok().and_then(|i| refs.get(i)))
            .ok_or("此图表版本中不存在指定出处")?;
        let start = evidence["start"].as_u64().ok_or("出处区间损坏")?;
        let end = evidence["end"]
            .as_u64()
            .filter(|end| *end >= start)
            .ok_or("出处区间损坏")?;
        let context_start = start.saturating_sub(160);
        let mut result = analysis::execute(
            &store::materials::grant_at(
                &tx,
                &work,
                value["goalRevision"].as_i64().ok_or("图表事项版本缺失")?,
            )?
            .reader(root)?,
            "hub_read_analysis_snapshot",
            &json!({"expectedSnapshot":value["analysis"]["expectedSnapshot"],
                "itemIndex":evidence["itemIndex"],"start":context_start,
                "limit":end.saturating_sub(context_start).saturating_add(160).min(8000)}),
        )?;
        result["evidence"] = evidence.clone();
        result["artifactId"] = json!(artifact);
        result["revision"] = json!(revision);
        return Ok(result);
    }
    inspection(root, &tx, &work, value)
}

pub(super) fn execute(
    root: &Path,
    work: &Work,
    run: &str,
    request: &Value,
    control: &Control,
) -> Result<Value, String> {
    crate::model_runtime::validate_agent_tool(request, &schema())?;
    store::check_run(root, work, run)?;
    control.check()?;
    let action = request["action"].as_str().ok_or("图表动作缺失")?;
    let goal_binding = store::goal::for_run(root, work, run)?;
    let c = crate::source_evidence::open_read_database(root)?;
    if action == "read" {
        let value = find(
            &c,
            &work.id,
            request["artifactId"].as_str().unwrap(),
            request["revision"].as_u64(),
        )?;
        drop(c);
        return store::write(root, |c| {
            let current = check_current(c, work, run, control)?;
            let result = inspection(root, c, &current, value)?;
            insert(
                c,
                work,
                run,
                "chartUse",
                &json!({"artifactId":request["artifactId"],"revision":request["revision"]}),
            )?;
            Ok(result)
        });
    }
    if action == "validate" {
        let value = find(
            &c,
            &work.id,
            request["artifactId"].as_str().unwrap(),
            request["revision"].as_u64(),
        )?;
        eligible(root, &c, work, &value)?;
        let computed = compute(root, work, &value["analysis"], &value["spec"], control)?;
        let passed = computed == value["data"];
        let receipt = json!({"receiptId":format!("chart-check-{}",crate::random_url_safe(12)),"artifactId":value["artifactId"],"revision":value["revision"],
            "contentHash":value["contentHash"],"validatorVersion":"literal-chart-v1","checkKind":"structureAndNumbers",
            "status":if passed {"passed"}else{"failed"},"findings":if passed {json!([])}else{json!(["保存数据与固定输入重新计算结果不一致"])},
            "visualCheck":"unavailable","checkedAt":chrono::Utc::now().timestamp_millis()});
        drop(c);
        return store::write(root, |c| {
            let current = check_current(c, work, run, control)?;
            store::goal::ensure_binding_on(c, &current, &goal_binding)?;
            eligible(root, c, &current, &value)?;
            let latest = find(c, &work.id, request["artifactId"].as_str().unwrap(), None)?;
            if latest["revision"] != value["revision"]
                || !store::goal::chart_current_on(c, &current, &value)?
                || !sleep::current_on(c, &current, &value["analysis"])?
            {
                return Err("只能检查符合当前要求的最新图表修订".into());
            }
            insert(c, work, run, "chartValidation", &receipt)?;
            inspection(root, c, &current, value)
        });
    }
    let request_hash = digest(request);
    let previous = if action == "patch" {
        Some(find(
            &c,
            &work.id,
            request["artifactId"].as_str().unwrap(),
            None,
        )?)
    } else {
        None
    };
    let input = if request["analysis"].is_null() {
        previous.as_ref().ok_or("缺少分析输入")?["analysis"].clone()
    } else {
        request["analysis"].clone()
    };
    let spec = if request["spec"].is_null() {
        previous.as_ref().ok_or("缺少图表规格")?["spec"].clone()
    } else {
        request["spec"].clone()
    };
    // Retry checks happen before recomputation or the expected-revision gate.
    if let Some(old) = records(&c, &work.id, "chartRevision")?
        .into_iter()
        .find(|v| v["operationId"] == request["operationId"])
    {
        if old["requestHash"] != request_hash {
            return Err("operationId 已用于不同的图表请求".into());
        }
        return inspection(root, &c, work, old);
    }
    if let Some(old) = &previous {
        if request["analysis"].is_null() || request["spec"].is_null() {
            eligible(root, &c, work, old)?;
        }
        if old["revision"] != request["expectedRevision"] {
            return Err("图表版本冲突，请读取最新版本后修改".into());
        }
    }
    let data = compute(root, work, &input, &spec, control)?;
    let revision = previous
        .as_ref()
        .map_or(1, |v| v["revision"].as_u64().unwrap_or(32) + 1);
    let id = previous
        .as_ref()
        .map(|v| v["artifactId"].as_str().unwrap().to_owned())
        .unwrap_or_else(|| format!("chart-{}", crate::random_url_safe(18)));
    let content_hash = digest(&json!({"spec":spec,"analysis":input,"data":data}));
    let value = json!({"artifactId":id,"workId":work.id,"runId":run,"revision":revision,"baseRevision":previous.as_ref().map(|v| v["revision"].clone()),
        "operationId":request["operationId"],"requestHash":request_hash,"specVersion":1,"spec":spec,"analysis":input,"data":data,
        "contentHash":content_hash,"goalRevision":work.revision,"goalBinding":goal_binding,"authorizationVersion":work.authorization_version,
        "changeSummary":request.get("reason").cloned().unwrap_or(json!("创建图表")),"createdAt":chrono::Utc::now().timestamp_millis()});
    drop(c);
    store::write(root, |c| {
        let current = check_current(c, work, run, control)?;
        store::goal::ensure_binding_on(c, &current, &goal_binding)?;
        eligible(root, c, &current, &value)?;
        if !sleep::current_on(c, &current, &value["analysis"])? {
            return Err("睡眠数据集已修订，请重新计算".into());
        }
        let all = records(c, &work.id, "chartRevision")?;
        if let Some(old) = all
            .iter()
            .find(|v| v["operationId"] == request["operationId"])
        {
            if old["requestHash"] != request_hash {
                return Err("operationId 已用于不同请求".into());
            }
            return inspection(root, c, &current, old.clone());
        }
        if let Some(old) = &previous {
            if request["analysis"].is_null() || request["spec"].is_null() {
                eligible(root, c, &current, old)?;
            }
            if find(c, &work.id, &id, None)?["revision"] != request["expectedRevision"] {
                return Err("图表版本冲突，请读取最新版本后修改".into());
            }
        } else if all.iter().filter(|v| v["revision"] == 1).count() >= 16 {
            return Err("本事项图表数量已达 16 项上限".into());
        }
        if revision > 32 {
            return Err("此图表修订已达当前 32 版上限".into());
        }
        insert(c, work, run, "chartRevision", &value)?;
        inspection(root, c, &current, value)
    })
}

pub(super) fn view_on(root: &Path, c: &Connection, work: &Work) -> Result<Value, String> {
    if work.state == "revoked" {
        return Ok(json!([]));
    }
    let mut latest = std::collections::BTreeMap::new();
    for value in records(c, &work.id, "chartRevision")? {
        let id = value["artifactId"]
            .as_str()
            .ok_or("图表身份损坏")?
            .to_owned();
        latest.insert(id, value);
    }
    let mut result = Vec::new();
    for (id, value) in latest {
        let revision = value["revision"].clone();
        result.push(inspection(root,c,work,value).unwrap_or_else(|_|json!({"artifactId":id,"revision":revision,"state":"unavailable","message":"图表依据已到期、不可用或授权已改变，请重新建立分析输入。"})));
    }
    Ok(json!(result))
}

pub(super) fn manifest_on(root: &Path, c: &Connection, work: &Work) -> Result<Value, String> {
    Ok(json!(view_on(root, c, work)?
        .as_array()
        .ok_or("图表目录无效")?
        .iter()
        .map(|v| json!({
            "artifactId":v["artifactId"],"revision":v["revision"],"state":v["state"],
            "title":v["content"]["spec"]["title"],"contentHash":v["content"]["contentHash"]
        }))
        .collect::<Vec<_>>()))
}

pub(super) fn delivery_dependencies(
    root: &Path,
    c: &Connection,
    work: &Work,
    run: &str,
    completed: bool,
    materials: &Value,
) -> Result<Value, String> {
    let mut result = if materials.is_null() {
        serde_json::Map::new()
    } else {
        materials.as_object().ok_or("材料依赖记录无效")?.clone()
    };
    let refs = run_references(c, work, run)?;
    for reference in refs.as_array().ok_or("图表依赖记录无效")? {
        let id = reference["artifactId"].as_str().ok_or("图表依赖身份缺失")?;
        let value = find(c, &work.id, id, reference["revision"].as_u64())?;
        let inspected = inspection(root, c, work, value.clone())?;
        let checked = inspected["state"] == "checked";
        if completed && (!checked || inspected["currentRevision"] != value["revision"]) {
            return Err(
                "本轮图表尚未核对当前版本，请先读取/修订并调用 chart validate，或交付准确未完成项"
                    .into(),
            );
        }
        result.insert(
            format!("chart:{id}"),
            json!({"snapshot":value["analysis"]["expectedSnapshot"],"arguments":value["analysis"]}),
        );
    }
    if result.len() > 16 {
        return Err("图表与正文材料依赖超过当前容量".into());
    }
    Ok(json!(result))
}
