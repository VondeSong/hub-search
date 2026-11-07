//! Pure flashcard field validation shared by authoring and bulk updates.
use serde_json::{json, Value};
use std::collections::HashSet;

pub(crate) fn normalize_flashcard_editor_fields(
    question: &str,
    answer: &str,
    explanation: &str,
    card_type: &str,
    card_data: Option<&Value>,
) -> Result<(String, String, String, String, Value), String> {
    let question = question.trim().chars().take(1_000).collect::<String>();
    let answer = answer.trim().chars().take(4_000).collect::<String>();
    let explanation = explanation.trim().chars().take(2_000).collect::<String>();
    if question.chars().count() < 3 || answer.is_empty() {
        return Err("问题至少需要 3 个字符，答案不能为空".to_string());
    }
    let card_type = match card_type.trim() {
        "" | "qa" => "qa".to_string(),
        "cloze" => "cloze".to_string(),
        "multiple_choice" => "multiple_choice".to_string(),
        "typed_answer" => "typed_answer".to_string(),
        "ordering" => "ordering".to_string(),
        "image_occlusion" => "image_occlusion".to_string(),
        _ => return Err("不支持的闪卡类型".to_string()),
    };
    let data = card_data.and_then(Value::as_object);
    let (answer, card_data) = match card_type.as_str() {
        "multiple_choice" => {
            let options = data
                .and_then(|data| data.get("options"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| value.chars().take(500).collect::<String>())
                .take(8)
                .collect::<Vec<_>>();
            let unique = options
                .iter()
                .map(|value| value.to_lowercase())
                .collect::<HashSet<_>>();
            if options.len() < 2 || unique.len() != options.len() {
                return Err("选择题需要 2–8 个不重复的选项".to_string());
            }
            let correct_index = data
                .and_then(|data| data.get("correctIndex"))
                .and_then(Value::as_u64)
                .map(|value| value as usize)
                .or_else(|| options.iter().position(|option| option == &answer))
                .ok_or_else(|| "选择题需要指定正确选项".to_string())?;
            if correct_index >= options.len() {
                return Err("选择题的正确选项超出范围".to_string());
            }
            (
                options[correct_index].clone(),
                json!({ "options": options, "correctIndex": correct_index }),
            )
        }
        "ordering" => {
            let structured_items = data
                .and_then(|data| data.get("items"))
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(|value| value.chars().take(500).collect::<String>())
                        .take(20)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let items = if structured_items.len() >= 2 {
                structured_items
            } else {
                answer
                    .lines()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(|value| value.to_string())
                    .take(20)
                    .collect()
            };
            if items.len() < 2 {
                return Err("排序卡至少需要 2 个排序项，每行填写一项".to_string());
            }
            (items.join("\n"), json!({ "items": items }))
        }
        "image_occlusion" => {
            let mut occlusions = Vec::new();
            for item in data
                .and_then(|data| data.get("occlusions"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .take(64)
            {
                let Some(object) = item.as_object() else {
                    continue;
                };
                let Some(x) = object.get("x").and_then(Value::as_f64) else {
                    continue;
                };
                let Some(y) = object.get("y").and_then(Value::as_f64) else {
                    continue;
                };
                let Some(width) = object.get("width").and_then(Value::as_f64) else {
                    continue;
                };
                let Some(height) = object.get("height").and_then(Value::as_f64) else {
                    continue;
                };
                if ![x, y, width, height].iter().all(|value| value.is_finite())
                    || x < 0.0
                    || y < 0.0
                    || width < 0.01
                    || height < 0.01
                    || x + width > 1.001
                    || y + height > 1.001
                {
                    continue;
                }
                let label = object
                    .get("label")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .chars()
                    .take(120)
                    .collect::<String>();
                occlusions.push(if label.is_empty() {
                    json!({ "x": x, "y": y, "width": width, "height": height })
                } else {
                    json!({ "x": x, "y": y, "width": width, "height": height, "label": label })
                });
            }
            if occlusions.is_empty() {
                return Err("图片遮挡卡至少需要一个有效遮挡区域".to_string());
            }
            (answer, json!({ "occlusions": occlusions }))
        }
        _ => (answer, json!({})),
    };
    Ok((question, answer, explanation, card_type, card_data))
}

pub(crate) fn normalize_flashcard_custom_fields(value: Option<&Value>) -> Value {
    let mut normalized = serde_json::Map::new();
    for (key, value) in value
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .take(20)
    {
        let key = key.trim().chars().take(60).collect::<String>();
        if key.is_empty() {
            continue;
        }
        let value = match value {
            Value::String(text) => Value::String(text.trim().chars().take(500).collect()),
            Value::Number(_) | Value::Bool(_) => value.clone(),
            _ => continue,
        };
        normalized.insert(key, value);
    }
    Value::Object(normalized)
}

pub(crate) fn normalize_flashcard_tag_values(tags: Option<Vec<String>>) -> Value {
    let mut seen = HashSet::new();
    Value::Array(
        tags.unwrap_or_default()
            .into_iter()
            .map(|tag| tag.trim().chars().take(60).collect::<String>())
            .filter(|tag| !tag.is_empty() && seen.insert(tag.to_lowercase()))
            .take(20)
            .map(Value::String)
            .collect(),
    )
}

pub(crate) fn normalize_flashcard_media(media: Option<&Value>) -> Value {
    let items = media.and_then(Value::as_array).into_iter().flatten()
        .take(8)
        .filter_map(|item| {
            let url = flashcard_import_text(item, &["url"]);
            let allowed = url.starts_with("https://") || url.starts_with("http://")
                || url.starts_with("data:") || url.starts_with("hub-media://")
                || url.starts_with("craft-media://");
            if !allowed || url.chars().count() > 8_000 {
                return None;
            }
            let placement = match flashcard_import_text(item, &["placement"]).as_str() {
                "question" => "question",
                "explanation" => "explanation",
                _ => "answer",
            };
            Some(json!({
                "title": flashcard_import_text(item, &["title"]).chars().take(200).collect::<String>(),
                "mimeType": flashcard_import_text(item, &["mimeType", "mime_type"]).chars().take(120).collect::<String>(),
                "url": url,
                "placement": placement,
                "byteSize": item.get("byteSize").and_then(Value::as_u64),
            }))
        })
        .collect::<Vec<_>>();
    Value::Array(items)
}

pub(crate) fn flashcard_import_text(value: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .unwrap_or_default()
        .trim()
        .to_string()
}

pub(crate) fn flashcard_import_source_text(value: &Value, keys: &[&str]) -> String {
    let direct = flashcard_import_text(value, keys);
    if !direct.is_empty() {
        return direct;
    }
    value
        .get("source")
        .map(|source| flashcard_import_text(source, keys))
        .unwrap_or_default()
}
