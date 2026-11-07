//! The host owns source words. Models select a quote from the current read
//! ledger; durable reports keep the existing evidenceId + exact quote contract.
use crate::model_runtime::MAX_OUTPUT_BYTES;
use crate::source_evidence::EvidenceExcerpt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Choice {
    quote_id: String,
    evidence_id: String,
    text: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Selection {
    quote_id: String,
}

pub(super) fn catalog(excerpts: &[EvidenceExcerpt]) -> Vec<Choice> {
    let mut choices = Vec::new();
    for (index, excerpt) in excerpts.iter().enumerate() {
        let evidence_id = format!("e{}", index + 1);
        let mut ordinal = 0;
        for line in excerpt.content.lines() {
            let mut remaining = line.trim();
            while !remaining.is_empty() {
                let end = remaining
                    .char_indices()
                    .nth(240)
                    .map_or(remaining.len(), |(i, _)| i);
                let text = remaining[..end].trim();
                if !text.is_empty() {
                    ordinal += 1;
                    choices.push(Choice {
                        quote_id: format!("{evidence_id}:q{ordinal}"),
                        evidence_id: evidence_id.clone(),
                        text: text.into(),
                    });
                }
                remaining = remaining[end..].trim_start();
            }
        }
    }
    choices
}

pub(super) fn observations(values: &[Value]) -> Vec<Value> {
    fn project(value: &mut Value) {
        match value {
            Value::Object(object) => {
                if object.contains_key("evidenceId") {
                    if let Some(excerpt) = object.get_mut("excerpt").and_then(Value::as_object_mut)
                    {
                        excerpt.remove("content");
                    }
                }
                for value in object.values_mut() {
                    project(value);
                }
            }
            Value::Array(array) => {
                for value in array {
                    project(value);
                }
            }
            _ => (),
        }
    }
    let mut projected = values.to_vec();
    for value in &mut projected {
        project(value);
    }
    projected
}

pub(super) fn resolve(mut response: Value, catalog: &[Choice]) -> Result<Value, String> {
    let mut expanded_bytes = response.to_string().len();
    let too_large = || "引用展开后超过调查容量，请减少引用数量。".to_string();
    if expanded_bytes > MAX_OUTPUT_BYTES {
        return Err(too_large());
    }
    if let Some(report) = response.get_mut("report").filter(|v| !v.is_null()) {
        for section in ["findings", "nextSteps"] {
            if let Some(items) = report.get_mut(section).and_then(Value::as_array_mut) {
                for (i, item) in items.iter_mut().enumerate() {
                    if let Some(citations) = item.get_mut("citations").and_then(Value::as_array_mut)
                    {
                        for (j, citation) in citations.iter_mut().enumerate() {
                            let path = format!("{section}[{i}].citations[{j}].quoteId");
                            let selection: Selection = serde_json::from_value(citation.clone())
                                .map_err(|_| format!("引用必须选择宿主提供的原文编号：{path}"))?;
                            let choice = catalog
                                .iter()
                                .find(|c| c.quote_id == selection.quote_id)
                                .ok_or_else(|| format!("引用选择不存在于本轮已读原文：{path}"))?;
                            let resolved =
                                json!({"evidenceId":choice.evidence_id,"quote":choice.text});
                            expanded_bytes = expanded_bytes - citation.to_string().len()
                                + resolved.to_string().len();
                            if expanded_bytes > MAX_OUTPUT_BYTES {
                                return Err(too_large());
                            }
                            *citation = resolved;
                        }
                    }
                }
            }
        }
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source_evidence::{tests::Fixture, EvidenceLocator, EvidenceReader, EvidenceScope};
    fn excerpt(text: &str) -> (Fixture, EvidenceExcerpt) {
        let f = Fixture::new();
        f.note("notes", "current", text);
        let locator: EvidenceLocator = serde_json::from_value(
            json!({"kind":"note","libraryId":"notes","documentId":"current","pageId":null}),
        )
        .unwrap();
        let reader = EvidenceReader::new(
            &f.root,
            EvidenceScope::new(vec!["notes".into()], vec![]).unwrap(),
        );
        let read = reader.read(&locator, 0, 6000, None).unwrap();
        (f, read)
    }
    #[test]
    fn compact_selections_cannot_expand_past_the_shared_output_budget() {
        let (_f, read) = excerpt(&"中".repeat(240));
        let choices = catalog(&[read]);
        for count in [50, 100] {
            let response = json!({"report":{"findings":[{"citations":vec![json!({"quoteId":"e1:q1"});count]}],"nextSteps":[]}});
            assert!(response.to_string().len() < MAX_OUTPUT_BYTES);
            let result = resolve(response, &choices);
            if count == 50 {
                assert!(result.unwrap().to_string().len() <= MAX_OUTPUT_BYTES);
            } else {
                assert_eq!(
                    result.unwrap_err(),
                    "引用展开后超过调查容量，请减少引用数量。"
                );
            }
        }
    }
    #[test]
    fn selected_quotes_keep_source_markdown_unicode_and_durable_shape_exactly() {
        let text = format!(
            "采购**独立件号**，保留 _原始_ 文件。\n{}尾部",
            "😀".repeat(243)
        );
        let (_f, read) = excerpt(&text);
        let choices = catalog(&[read.clone()]);
        assert_eq!(choices.len(), 3);
        for choice in &choices {
            assert!(read.content.contains(&choice.text));
            assert!(choice.text.chars().count() <= 240);
        }
        let response = json!({"report":{"findings":[{"citations":[{"quoteId":choices[0].quote_id}]}],"nextSteps":[]}});
        let resolved = resolve(response, &choices).unwrap();
        assert_eq!(
            resolved["report"]["findings"][0]["citations"][0],
            json!({"evidenceId":"e1","quote":"采购**独立件号**，保留 _原始_ 文件。"})
        );
        let projected = observations(&[json!({"anchor":{"evidenceId":"e1","excerpt":read}})]);
        assert!(projected[0]["anchor"]["excerpt"].get("content").is_none());
        assert_eq!(read.content, text);
    }
    #[test]
    fn unknown_unread_ids_and_model_supplied_quote_words_are_rejected() {
        let (_f, read) = excerpt("仅此原文可选");
        let choices = catalog(&[read]);
        for citation in [
            json!({"quoteId":"e99:q1"}),
            json!({"quoteId":"e1:q999"}),
            json!({"quoteId":"e1:q1","quote":"篡改原文"}),
            json!({"evidenceId":"e1","quote":"仅此原文可选"}),
        ] {
            let response = json!({"report":{"findings":[{"citations":[citation]}],"nextSteps":[]}});
            let error = resolve(response, &choices).unwrap_err();
            assert!(error.contains("findings[0].citations[0].quoteId"));
        }
    }
}
