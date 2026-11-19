//! Durable toolCall keeps the complete submission; result need not echo its rows.
use serde_json::{json, Value};

pub(super) fn attach_request(mut result: Value, request: &Value) -> Value {
    if !result.is_object() {
        result = json!({"value":result});
    }
    let mut reference = crate::agent_work::store::tool_results::request_reference(request);
    if reference["operation"] == "analyzeFiles" {
        // The exact script is already in the tool call and durable trace.
        if let Some(fields) = reference.as_object_mut() {
            fields.remove("script");
        }
    }
    result["request"] = reference;
    result
}

pub(super) fn model_view(raw: &Value) -> Value {
    let mut result = raw.clone();
    if let Some(error) = raw["error"].as_str() {
        result["error"] = json!(error.chars().take(300).collect::<String>());
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

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
