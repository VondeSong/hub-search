//! Shared output gate for both adapters. Domain owners still verify evidence
//! and enforce their stricter business contracts before committing anything.
use serde_json::Value;
const INVALID: &str = "模型返回格式不符合要求，未提交结果，请重试。";
pub(super) fn is_rejection(error: &str) -> bool {
    error == INVALID || error.starts_with(&format!("{INVALID} ["))
}
struct Violation {
    path: String,
    rule: &'static str,
}
fn violation(path: &str, rule: &'static str) -> Violation {
    Violation {
        path: path.into(),
        rule,
    }
}
pub(super) fn validate_arguments(value: &Value, schema: &Value) -> Result<(), String> {
    check(value, schema, 0, "$").map_err(|e| format!("工具参数不符合要求 [{}: {}]", e.path, e.rule))
}
pub(super) fn validate(value: &Value, schema: &Value) -> Result<(), String> {
    if value.to_string().len() > super::MAX_OUTPUT_BYTES {
        return Err("模型返回内容过长，未提交结果。".into());
    }
    check(value, schema, 0, "$").map_err(|e| format!("{INVALID} [{}: {}]", e.path, e.rule))
}
fn check(v: &Value, s: &Value, depth: usize, path: &str) -> Result<(), Violation> {
    if depth > 48 {
        return Err(violation(path, "depth"));
    }
    if let Some(options) = s.get("enum").and_then(Value::as_array) {
        if !options.contains(v) {
            return Err(violation(path, "enum"));
        }
    }
    if let Some(expected) = s.get("const") {
        if expected != v {
            return Err(violation(path, "const"));
        }
    }
    for (name, exact) in [("anyOf", false), ("oneOf", true)] {
        if let Some(options) = s.get(name).and_then(Value::as_array) {
            let results: Vec<_> = options
                .iter()
                .map(|s| check(v, s, depth + 1, path))
                .collect();
            let matches = results.iter().filter(|r| r.is_ok()).count();
            if matches == 0 || (exact && matches != 1) {
                // Only schema-owned paths and rule names leave this gate. A
                // nullable branch must not hide a useful nested field failure.
                return Err(results
                    .into_iter()
                    .filter_map(Result::err)
                    .max_by_key(|e| e.path.len())
                    .unwrap_or_else(|| violation(path, name)));
            }
        }
    }
    let matches_type = |t: &str| match t {
        "object" => v.is_object(),
        "array" => v.is_array(),
        "string" => v.is_string(),
        "integer" => v.is_i64() || v.is_u64(),
        "number" => v.is_number(),
        "boolean" => v.is_boolean(),
        "null" => v.is_null(),
        _ => false,
    };
    if let Some(t) = s.get("type") {
        let ok = if let Some(t) = t.as_str() {
            matches_type(t)
        } else {
            t.as_array()
                .is_some_and(|a| a.iter().any(|t| t.as_str().is_some_and(matches_type)))
        };
        if !ok {
            return Err(violation(path, "type"));
        }
    }
    if let Some(object) = v.as_object() {
        if let Some(required) = s["required"].as_array() {
            for name in required {
                let name = name.as_str().ok_or_else(|| violation(path, "required"))?;
                if !object.contains_key(name) {
                    return Err(violation(&format!("{path}.{name}"), "required"));
                }
            }
        }
        for (key, value) in object {
            if let Some(property) = s["properties"].get(key) {
                check(value, property, depth + 1, &format!("{path}.{key}"))?;
            } else if s["additionalProperties"] == false {
                return Err(violation(path, "additionalProperties"));
            }
        }
    }
    if let Some(items) = v.as_array() {
        if s["minItems"]
            .as_u64()
            .is_some_and(|n| items.len() < (n as usize))
            || s["maxItems"]
                .as_u64()
                .is_some_and(|n| items.len() > (n as usize))
        {
            return Err(violation(path, "itemsLimit"));
        }
        if let Some(item_schema) = s.get("items") {
            for (index, item) in items.iter().enumerate() {
                check(item, item_schema, depth + 1, &format!("{path}[{index}]"))?;
            }
        }
    }
    if let Some(text) = v.as_str() {
        let len = text.chars().count() as u64;
        if s["minLength"].as_u64().is_some_and(|n| len < n)
            || s["maxLength"].as_u64().is_some_and(|n| len > n)
        {
            return Err(violation(path, "length"));
        }
    }
    if let Some(number) = v.as_f64() {
        if s["minimum"].as_f64().is_some_and(|n| number < n)
            || s["maximum"].as_f64().is_some_and(|n| number > n)
        {
            return Err(violation(path, "range"));
        }
    }
    Ok(())
}
#[test]
fn output_diagnostics_identify_schema_fields_without_echoing_values_or_unknown_keys() {
    use serde_json::json;
    let schema = json!({"type":"object","required":["report"],"additionalProperties":false,"properties":{"report":{"anyOf":[{"type":"object","required":["questions"],"additionalProperties":false,"properties":{"questions":{"type":"array","items":{"type":"string"}}}},{"type":"null"}]}}});
    let bad = json!({"report":{"questions":"PRIVATE_VALUE"}});
    let error = validate(&bad, &schema).unwrap_err();
    assert!(is_rejection(&error));
    assert!(error.contains("$.report.questions: type"));
    assert!(!error.contains("PRIVATE_VALUE"));
    let error = validate(
        &json!({"report":null,"PRIVATE_KEY":"PRIVATE_VALUE"}),
        &schema,
    )
    .unwrap_err();
    assert!(error.contains("$: additionalProperties"));
    assert!(!error.contains("PRIVATE_"));
    assert!(validate(&json!({"report":null}), &schema).is_ok());
    assert!(validate(&json!({"report":{"questions":[]}}), &schema).is_ok());
}
#[test]
fn shared_gate_rejects_wrong_types_unknown_fields_missing_and_invalid_enum() {
    use serde_json::json;
    let s = json!({"type":"object","required":["kind","items"],"additionalProperties":false,"properties":{"kind":{"enum":["read","finish"]},"items":{"type":"array","items":{"type":"string"},"maxItems":2}}});
    assert!(validate(&json!({"kind":"read","items":[]}), &s).is_ok());
    for v in [
        json!({"kind":"write","items":[]}),
        json!({"kind":"read"}),
        json!({"kind":"read","items":[false]}),
        json!({"kind":"read","items":[],"extra":true}),
    ] {
        assert!(validate(&v, &s).is_err());
    }
}
