//! Exploratory measurements, never completion authority or a UX pass verdict.
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::time::Instant;

pub(super) fn parts(value: &Value) -> Value {
    Value::Object(
        value
            .as_object()
            .into_iter()
            .flatten()
            .map(|(key, value)| (key.clone(), json!(value.to_string().len())))
            .collect(),
    )
}

pub(super) fn fingerprints(value: &Value) -> Value {
    Value::Object(
        value
            .as_object()
            .into_iter()
            .flatten()
            .map(|(key, value)| {
                (
                    key.clone(),
                    json!(format!(
                        "{:x}",
                        Sha256::digest(value.to_string().as_bytes())
                    )),
                )
            })
            .collect(),
    )
}

// `total` is thread cumulative; `last` describes the last provider request,
// not this Hub turn. Unknown baselines and counter regressions stay unknown.
pub(super) fn token_delta(current: &Value, previous: Option<&Value>, resumed: bool) -> Value {
    let mut fields = Map::new();
    for key in [
        "inputTokens",
        "cachedInputTokens",
        "outputTokens",
        "totalTokens",
        "reasoningOutputTokens",
    ] {
        let before = if resumed {
            previous.and_then(|v| v["total"][key].as_u64())
        } else {
            Some(0)
        };
        let delta = current["total"][key]
            .as_u64()
            .zip(before)
            .and_then(|(a, b)| a.checked_sub(b));
        fields.insert(key.into(), json!(delta));
    }
    let uncached = fields["inputTokens"]
        .as_u64()
        .zip(fields["cachedInputTokens"].as_u64())
        .and_then(|(total, cached)| total.checked_sub(cached));
    fields.insert("uncachedInputTokens".into(), json!(uncached));
    Value::Object(fields)
}

pub(super) struct Measurement {
    start: Instant,
    initial: Value,
    tools: Vec<Value>,
    omitted_tools: usize,
    repeated: BTreeMap<String, Value>,
    seen: HashSet<(String, String)>,
    provider: Map<String, Value>,
    first_feedback: Option<u128>,
    event_count: usize,
    event_ms: u128,
}

impl Measurement {
    pub(super) fn new(input: &str, material: &Value, tools: &Value, instructions: &str) -> Self {
        Self {
            start: Instant::now(),
            initial: json!({"inputUtf8Bytes":input.len(),
            "materialUtf8Bytes":material.to_string().len(), "materialValueUtf8Bytes":parts(material),
            "toolSchemaUtf8Bytes":tools.to_string().len(), "instructionUtf8Bytes":instructions.len(),
            "scope":"Hub payloads before adapter wrapping; field values exclude JSON keys and delimiters"}),
            tools: Vec::new(),
            omitted_tools: 0,
            repeated: BTreeMap::new(),
            seen: HashSet::new(),
            provider: Map::new(),
            first_feedback: None,
            event_count: 0,
            event_ms: 0,
        }
    }

    pub(super) fn observe(
        &mut self,
        kind: &str,
        request: &Value,
        result: &Result<Value, String>,
        started: Instant,
    ) {
        let at = started.duration_since(self.start).as_millis();
        let elapsed = started.elapsed().as_millis();
        if kind == "timing" {
            if let Some(stage) = request["stage"].as_str().filter(|s| {
                matches!(
                    *s,
                    "processReady"
                        | "protocolReady"
                        | "threadReady"
                        | "inputSent"
                        | "firstEventObserved"
                        | "completed"
                )
            }) {
                let value = json!({"adapter":request,"hostObservedMs":at});
                if stage == "completed" {
                    self.provider.insert(stage.into(), value);
                } else {
                    self.provider.entry(stage).or_insert(value);
                }
            }
        }
        // A real tool request or nonempty public message/summary is feedback;
        // fixed activity labels and empty completion markers are excluded.
        if kind == "tool"
            || (kind == "event"
                && request["text"]
                    .as_str()
                    .is_some_and(|s| !s.trim().is_empty()))
        {
            self.first_feedback.get_or_insert(at);
        }
        if kind == "event" {
            self.event_count += 1;
            self.event_ms += elapsed;
        }
        if kind != "tool" {
            return;
        }
        if self.tools.len() >= 128 {
            self.omitted_tools += 1;
            return;
        }
        let output = result.as_ref().ok();
        for key in ["quoteCatalog", "businessActionRecords", "knowledgeRules"] {
            if let Some(value) = output.and_then(|v| v.get(key)) {
                let serialized = value.to_string();
                let hash = format!("{:x}", Sha256::digest(serialized.as_bytes()));
                let duplicate = self.seen.contains(&(key.into(), hash.clone()));
                self.seen.insert((key.into(), hash)); // At most 3 * 128 entries.
                let entry = self.repeated.entry(key.into()).or_insert(
                    json!({"count":0,"utf8Bytes":0,"repeatedCount":0,"repeatedUtf8Bytes":0}),
                );
                for (field, amount) in [
                    ("count", 1),
                    ("utf8Bytes", serialized.len() as u64),
                    ("repeatedCount", u64::from(duplicate)),
                    (
                        "repeatedUtf8Bytes",
                        if duplicate {
                            serialized.len() as u64
                        } else {
                            0
                        },
                    ),
                ] {
                    entry[field] = json!(entry[field].as_u64().unwrap_or(0) + amount);
                }
            }
        }
        self.tools.push(json!({"callId":request["callId"],"tool":request["tool"],"hostStartMs":at,
            "hostHandlingMs":elapsed,"queueMs":null,"executionOnlyMs":null,
            "outcome":if result.is_err(){"hostError"}else if output.is_some_and(|v|v.get("error").is_some() || v["accepted"]==false){"rejected"}else{"returned"},
            "outputUtf8Bytes":output.map(|v|v.to_string().len()), "outputValueUtf8Bytes":output.map(parts)}));
    }

    pub(super) fn finish(
        &self,
        work: &str,
        run: &str,
        reuse: Value,
        usage: &Value,
        previous: Option<&Value>,
        resumed: bool,
        succeeded: bool,
    ) -> Value {
        let mut value = json!({"schemaVersion":1,"workId":work,"runId":run,"clock":"host-process Instant since context prepared, before provider invocation",
            "runtimeReturnedMs":self.start.elapsed().as_millis(),"runtimeSucceeded":succeeded,
            "phase":"before final host publication", "firstFeedbackHostMs":self.first_feedback,
            "uiSubmitMs":null,"uiAcceptMs":null,"uiFirstFeedbackMs":null,"uiUsefulMs":null,"uiDoneMs":null,
            "publishCommitMs":null,"uiRenderMs":null,"initialContext":self.initial,
            "tools":self.tools,"omittedTools":self.omitted_tools,"repeatedToolFields":self.repeated,
            "publicEventHandling":{"count":self.event_count,"totalMs":self.event_ms,"scope":"stream persistence plus notify; not UI visibility"},
            "provider":self.provider,"reuse":reuse,"providerUsageTotal":usage["total"],
            "providerUsageLastRequest":usage["last"],"turnTokens":token_delta(usage,previous,resumed),
            "tokenScope":"thread cumulative delta with same-thread baseline, or total for a new thread",
            "cost":null,"formalGatePassed":false});
        while value.to_string().len() > 48_000 {
            if value["tools"].as_array_mut().unwrap().pop().is_none() {
                break;
            }
            value["omittedTools"] = json!(value["omittedTools"].as_u64().unwrap() + 1);
        }
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn measurement_survives_real_store_and_activity_projection() {
        use crate::agent_work::{store, Grant};
        use crate::source_evidence::EvidenceLocator;
        let f = crate::obsidian_edit::tests::Fixture::new();
        let doc = f.seed("Measurement.md", "合成材料");
        let anchor = EvidenceLocator::Note {
            library_id: "notes".into(),
            document_id: doc,
            page_id: None,
        };
        let id = store::create(
            &f.root,
            "测量".into(),
            "只读".into(),
            anchor.clone(),
            Grant {
                notes: vec![anchor],
                ..Default::default()
            },
        )
        .unwrap();
        store::claim(&f.root, &id, "measurement-run").unwrap();
        let mut m = Measurement::new("合成", &json!({}), &json!([]), "");
        for (stage, ms) in [
            ("processReady", 10),
            ("protocolReady", 30),
            ("threadReady", 50),
        ] {
            m.observe(
                "timing",
                &json!({"stage":stage,"elapsedMs":ms}),
                &Ok(Value::Null),
                Instant::now(),
            );
            m.observe(
                "timing",
                &json!({"stage":stage,"elapsedMs":999}),
                &Ok(Value::Null),
                Instant::now(),
            );
        }
        let report = m.finish(
            &id,
            "measurement-run",
            json!({"reason":"noPreviousSession"}),
            &Value::Null,
            None,
            false,
            false,
        );
        store::record(&f.root, "measurement-run", "nativeMeasurement", &report).unwrap();
        let view = store::view(&f.root, &id).unwrap();
        assert_eq!(view["activity"][0]["measurement"], report);
        assert!(view["activity"][0]["measurement"]["turnTokens"]["inputTokens"].is_null());
        assert_eq!(
            report["provider"]["processReady"]["adapter"]["elapsedMs"],
            10
        );
        assert_eq!(
            report["provider"]["protocolReady"]["adapter"]["elapsedMs"],
            30
        );
        assert_eq!(
            report["provider"]["threadReady"]["adapter"]["elapsedMs"],
            50
        );
        assert!(report["firstFeedbackHostMs"].is_null());
        assert!(report["provider"].get("inputSent").is_none());
    }
    #[test]
    fn token_measurement_preserves_unknown_baselines_and_counter_regressions() {
        let usage = json!({"total":{"inputTokens":100,"cachedInputTokens":60,"outputTokens":8},"last":{"inputTokens":12}});
        assert_eq!(token_delta(&usage, None, false)["uncachedInputTokens"], 40);
        assert!(token_delta(&usage, None, true)["inputTokens"].is_null());
        let prior = json!({"total":{"inputTokens":70,"cachedInputTokens":50,"outputTokens":10}});
        let delta = token_delta(&usage, Some(&prior), true);
        assert_eq!(delta["inputTokens"], 30);
        assert_eq!(delta["uncachedInputTokens"], 20);
        assert!(delta["outputTokens"].is_null());
        assert!(
            token_delta(&json!({"total":{"inputTokens":5}}), None, false)["cachedInputTokens"]
                .is_null()
        );
    }
    #[test]
    fn measurement_counts_utf8_repeated_payloads_and_excludes_empty_feedback() {
        let mut m = Measurement::new("中文", &json!({"source":"中文"}), &json!([]), "规则");
        m.observe(
            "event",
            &json!({"text":""}),
            &Ok(Value::Null),
            Instant::now(),
        );
        assert!(m.first_feedback.is_none());
        for _ in 0..2 {
            m.observe(
                "tool",
                &json!({"tool":"hub_read","callId":"a"}),
                &Ok(json!({"quoteCatalog":["中文"]})),
                Instant::now(),
            );
        }
        let report = m.finish("w", "r", json!({}), &Value::Null, None, false, true);
        assert_eq!(report["initialContext"]["inputUtf8Bytes"], 6);
        assert_eq!(
            report["repeatedToolFields"]["quoteCatalog"]["repeatedCount"],
            1
        );
        assert_eq!(
            report["repeatedToolFields"]["quoteCatalog"]["repeatedUtf8Bytes"],
            10
        );
        assert!(report["uiDoneMs"].is_null());
        assert!(!report["firstFeedbackHostMs"].is_null());
        for _ in 0..130 {
            m.observe("tool", &json!({}), &Err("cancelled".into()), Instant::now());
        }
        assert_eq!(m.tools.len(), 128);
        assert_eq!(m.omitted_tools, 4);
    }
}

#[cfg(test)]
#[test]
fn cn06b_resumed_observation_subtracts_baseline_and_keeps_partial_measurement() {
    let previous = json!({"total":{"inputTokens":34686,"cachedInputTokens":0,"outputTokens":171,"totalTokens":34857,"reasoningOutputTokens":37}});
    let current = json!({"total":{"inputTokens":204786,"cachedInputTokens":146816,"outputTokens":929,"totalTokens":205715},"last":{"inputTokens":59000,"totalTokens":59500}});
    let delta = token_delta(&current, Some(&previous), true);
    assert_eq!(delta["inputTokens"], 170100);
    assert_eq!(delta["uncachedInputTokens"], 23284);
    assert_eq!(delta["outputTokens"], 758);
    let m = Measurement::new("", &json!({}), &json!([]), "");
    let report = m.finish(
        "work",
        "failed-run",
        json!({}),
        &current,
        Some(&previous),
        true,
        false,
    );
    assert_eq!(report["turnTokens"], delta);
    assert_eq!(report["providerUsageTotal"]["inputTokens"], 204786);
    assert_eq!(
        token_delta(&current, Some(&current), true)["inputTokens"],
        0
    );
    assert!(
        token_delta(&json!({"total":{"inputTokens":20}}), Some(&current), true)["inputTokens"]
            .is_null()
    );
}
