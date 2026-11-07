//! Native argument admission: retain rejected input before returning feedback.
use super::*;

#[cfg(test)]
mod tests;

// Leave headroom below the existing 64 KiB record limit. Oversized inputs are
// identified, never silently truncated into an apparently replayable request.
const MAX_DIAGNOSTIC_BYTES: usize = 48_000;
const ROW_SUBMISSION_POLICY: &str = "create/revise 的每行均须显式提供 schema 的全部 required 字段；revise 不合并缺失字段。date/hours 不是别名，不由宿主转换或补出处。请按完整行重新组织候选；已读完首次候选时可直接完整 create，无需空建。";

// Recovery diagnostics only: derive field issues from the unchanged schema.
// Bound repeated rows and unknown names; never normalize or fill model input.
fn sleep_row_issues(args: &Value, schema: &Value) -> Option<Value> {
    let request = args.get("request")?;
    let action = request.get("action")?;
    let variant = schema["properties"]["request"]["anyOf"]
        .as_array()?
        .iter()
        .find(|v| {
            v["properties"]["action"]["enum"]
                .as_array()
                .is_some_and(|values| values.contains(action))
        })?;
    let row = &variant["properties"]["rows"]["items"];
    let properties = row["properties"].as_object()?;
    let required = row["required"].as_array()?;
    let issues = request.get("rows")?.as_array()?.iter().enumerate().filter_map(|(index, value)| {
        let fields = value.as_object()?;
        let missing: Vec<_> = required.iter().filter_map(Value::as_str).filter(|key| !fields.contains_key(*key)).collect();
        let unknown: Vec<_> = fields.keys().filter(|key| !properties.contains_key(*key)).collect();
        if missing.is_empty() && unknown.is_empty() { return None; }
        let shown: Vec<_> = unknown.iter().filter(|key| key.len() <= 80).take(8).copied().collect();
        Some(json!({"rowIndex":index,"missingRequiredFields":missing,"unknownFields":shown,"unknownFieldCount":unknown.len()}))
    }).take(4).collect::<Vec<_>>();
    (!issues.is_empty()).then(|| json!(issues))
}

pub(super) fn decode(
    root: &Path,
    run: &str,
    specs: &Value,
    call: &Value,
    used_steps: &mut usize,
    max_steps: usize,
) -> Result<Result<Tool, Value>, String> {
    if *used_steps >= max_steps {
        return Err("工具步骤预算已用尽，已有成果已保留".into());
    }
    let name = call["tool"].as_str().ok_or("工具名称缺失")?;
    let args = &call["arguments"];
    let spec = specs.as_array().unwrap().iter().find(|s| s["name"] == name);
    let decoded = (|| {
        let operation = name.strip_prefix("hub_").ok_or("未知 Hub 工具")?;
        crate::model_runtime::validate_agent_tool(
            args,
            &spec.ok_or("未知 Hub 工具")?["inputSchema"],
        )?;
        let mut input = args.clone();
        input["operation"] = json!(operation);
        if crate::hub_capabilities::catalog()["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["name"] == name)
            && !matches!(operation, "loadSkill" | "readSkillReference")
        {
            input = json!({"operation":"capability","name":name,"arguments":args});
        }
        serde_json::from_value::<Tool>(input).map_err(|_| "工具参数无效".to_string())
    })();
    match decoded {
        Ok(tool) => Ok(Ok(tool)),
        Err(error) => {
            let schema = spec
                .map(|s| s["inputSchema"].clone())
                .unwrap_or(Value::Null);
            let raw = args.to_string();
            let mut record = json!({"category":"toolArguments","callId":call["callId"],"tool":name,
                "arguments":args,"argumentsUtf8Bytes":raw.len(),"argumentsSha256":format!("{:x}",Sha256::digest(raw.as_bytes())),"argumentsOmitted":false,
                "inputSchema":schema,"schemaSha256":format!("{:x}",Sha256::digest(schema.to_string().as_bytes())),"schemaOmitted":false,"error":error});
            if record.to_string().len() > MAX_DIAGNOSTIC_BYTES {
                record["arguments"] = Value::Null;
                record["argumentsOmitted"] = json!(true);
            }
            if record.to_string().len() > MAX_DIAGNOSTIC_BYTES {
                record["inputSchema"] = Value::Null;
                record["schemaOmitted"] = json!(true);
            }
            if record.to_string().len() > MAX_DIAGNOSTIC_BYTES {
                return Err("工具拒绝记录超过容量，已有成果已保留".into());
            }
            // Persist the exact optional recovery details within the original
            // record limit. If they do not fit, retain the original feedback.
            if name == "hub_sleepDataset"
                && record["schemaOmitted"] == false
                && record["argumentsOmitted"] == false
            {
                if let Some(issues) = sleep_row_issues(args, &schema) {
                    let mut detailed = record.clone();
                    detailed["rowIssues"] = issues;
                    detailed["rowIssueLimit"] = json!(4);
                    detailed["rowSubmissionPolicy"] = json!(ROW_SUBMISSION_POLICY);
                    if detailed.to_string().len() <= MAX_DIAGNOSTIC_BYTES {
                        record = detailed;
                    }
                }
            }
            // Preserve the original gate error; failure to persist stops the
            // Run instead of returning a recovery hint with no durable evidence.
            store::record(root, run, "toolRejected", &record)?;
            *used_steps += 1;
            let mut feedback = json!({"error":error,"remainingToolSteps":max_steps-*used_steps});
            feedback["category"] = json!("toolArguments");
            feedback["toolExecuted"] = json!(false);
            feedback["retryPerformed"] = json!(false);
            feedback["recoveryOptions"] = if spec.is_some() {
                json!([{"tool":"hub_toolSchema","arguments":{"name":name},"description":"按需查看本轮工具完整参数格式，修正后自行决定是否重试"}])
            } else {
                json!([])
            };
            if schema.to_string().len() <= 4096 && !schema.is_null() {
                feedback["expectedInputSchema"] = schema.clone();
            }
            if name == "hub_sleepDataset" && record["schemaOmitted"] == false {
                for key in ["rowIssues", "rowIssueLimit", "rowSubmissionPolicy"] {
                    if let Some(value) = record.get(key) {
                        feedback[key] = value.clone();
                    }
                }
                feedback["expectedInputSchema"] = schema;
            }
            Ok(Err(feedback))
        }
    }
}
