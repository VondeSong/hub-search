//! Durable toolCall keeps the complete submission; result need not echo its rows.
use serde_json::{json, Value};

pub(super) fn attach_request(mut result: Value, request: &Value) -> Value {
    if !result.is_object() {
        result = json!({"value":result});
    }
    result["request"] = crate::agent_work::store::tool_results::request_reference(request);
    result
}

pub(super) fn model_view(raw: &Value) -> Value {
    let mut result = raw.clone();
    if let Some(error) = raw["error"].as_str() {
        result["error"] = json!(error.chars().take(300).collect::<String>());
    }
    if raw["output"]["backend"] == "codex-mxc-python" {
        project_analysis_output(raw, &mut result["output"]);
    }
    result
}

// Positions match hub_traceResult's character offsets in compact JSON.
fn member_start(value: &Value, name: &str) -> Option<usize> {
    let mut start = 1;
    for (key, field) in value.as_object()? {
        start += json!(key).to_string().chars().count() + 1;
        if key == name {
            return Some(start);
        }
        start += field.to_string().chars().count() + 1;
    }
    None
}

fn project_analysis_output(raw: &Value, output: &mut Value) {
    const INLINE_BYTES: usize = 48 * 1024;
    if output.to_string().len() <= INLINE_BYTES {
        return;
    }
    let Some(result_start) = member_start(raw, "output")
        .zip(member_start(output, "output"))
        .map(|(outer, inner)| outer + inner)
    else {
        return;
    };
    let mut shown = serde_json::Map::new();
    let mut omitted = 0usize;
    let mut ranges = Vec::new();
    let mut remaining = INLINE_BYTES / 2;
    if let Some(fields) = output["output"].as_object() {
        let mut start = result_start + 1;
        for (key, value) in fields {
            let encoded_key = json!(key).to_string();
            let encoded_value = value.to_string();
            start += encoded_key.chars().count() + 1;
            let end = start + encoded_value.chars().count();
            let bytes = encoded_key.len() + encoded_value.len() + 2;
            if bytes <= remaining {
                shown.insert(key.clone(), value.clone());
                remaining -= bytes;
            } else {
                omitted += 1;
                if ranges.len() < 12 {
                    ranges.push(json!({
                        "field": key.chars().take(120).collect::<String>(),
                        "startChar": start,
                        "endChar": end
                    }));
                }
            }
            start = end + 1;
        }
    } else {
        ranges.push(json!({"startChar":result_start,"endChar":result_start + output["output"].to_string().chars().count()}));
    }
    output["outputProjection"] = json!({
        "omittedFieldCount": output["output"].is_object().then_some(omitted),
        "omittedRanges": ranges,
        "fullResultAvailable": true,
        "meaning": "已展示的统计字段是完整值。足以回答时直接交付。确需某个省略字段时，按该字段的 startChar 和 endChar 用 toolResultRef 分段读取；无需扫描整份结果或重跑。"
    });
    output["output"] = if output["output"].is_object() {
        Value::Object(shown)
    } else {
        Value::Null
    };
    output["stderr"] = json!(output["stderr"]
        .as_str()
        .unwrap_or("")
        .chars()
        .take(300)
        .collect::<String>());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn large_analysis_result_keeps_exact_trace_and_returns_small_complete_fields() {
        let raw = json!({"output":{"backend":"codex-mxc-python","exitCode":0,
            "output":{"allRows":"项".repeat(25_000),"files":1877,"range":"A7:J2470"}}});
        let projected = model_view(&raw);
        assert_eq!(
            projected["output"]["output"],
            json!({"files":1877,"range":"A7:J2470"})
        );
        assert_eq!(
            projected["output"]["outputProjection"]["omittedFieldCount"],
            1
        );
        let range = &projected["output"]["outputProjection"]["omittedRanges"][0];
        let start = range["startChar"].as_u64().unwrap() as usize;
        let end = range["endChar"].as_u64().unwrap() as usize;
        assert_eq!(range["field"], "allRows");
        assert_eq!(
            raw.to_string()
                .chars()
                .skip(start)
                .take(end - start)
                .collect::<String>(),
            raw["output"]["output"]["allRows"].to_string()
        );
        assert!(raw["output"]["output"]["allRows"].is_string());
        let request = json!({"operation":"analyzeFiles","script":"print('{}')","stepId":"step"});
        let projected = attach_request(projected, &request);
        assert_eq!(projected["request"]["stepId"], "step");
        assert!(projected["request"].get("script").is_none());
    }

    #[test]
    fn trace_result_error_model_view_is_bounded_without_mutating_full_fact() {
        let raw = json!({"error":"真实🙂".repeat(500),"origin":"host","preserve":{"all":true}});
        let projected = model_view(&raw);
        assert_eq!(projected["error"].as_str().unwrap().chars().count(), 300);
        assert_eq!(raw["error"].as_str().unwrap().chars().count(), 1500);
        assert_eq!(projected["preserve"], raw["preserve"]);
    }

    #[test]
    fn only_submitted_sleep_rows_are_referenced_and_full_result_is_retained() {
        let request = json!({"operation":"sleepDataset","request":{"action":"create","operationId":"op","rows":[{"source":"exact raw source","normalizedValue":null}]},"stepId":"step"});
        for outcome in [
            json!({"content":{"rows":[{"source":"exact raw source","normalizedValue":null}]},"revision":1}),
            json!({"error":"actual host rejection","origin":"host"}),
        ] {
            let result = attach_request(outcome.clone(), &request);
            let mut actual = result.clone();
            actual.as_object_mut().unwrap().remove("request");
            assert_eq!(actual, outcome);
            assert!(result["request"]["request"].get("rows").is_none());
            assert_eq!(result["request"]["request"]["operationId"], "op");
            assert_eq!(
                result["request"]["rowSubmission"],
                json!({"count":1,"recordKind":"toolCall","stepId":"step"})
            );
            assert_eq!(request["request"]["rows"].as_array().unwrap().len(), 1);
        }
    }

    #[test]
    fn non_row_operations_and_read_requests_keep_their_exact_previous_shape() {
        for request in [
            json!({"operation":"capability","name":"hub_read_analysis_snapshot","arguments":{"expectedSnapshot":"snapshot","itemIndex":0},"stepId":"read"}),
            json!({"operation":"sleepDataset","request":{"action":"read","datasetId":"dataset"},"stepId":"read"}),
            json!({"operation":"search","query":"actual query","sourceKind":"note","stepId":"search"}),
        ] {
            assert_eq!(
                attach_request(json!({"actual":true}), &request),
                json!({"actual":true,"request":request})
            );
        }
    }
}
