//! Exact rule and citation-catalog wire references. Full source outcomes remain immutable.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
const MIN_REFERENCE: usize = 1024;
const MAX_BASES: usize = 128;
#[derive(Clone)]
struct Base {
    value: Value,
    reference: Value,
    known: bool,
    generation: u64,
}
#[derive(Clone)]
pub(super) struct GuidanceRef {
    initial_view: Value,
    reference: Option<Value>,
    bases: Vec<Base>,
    generation: u64,
    pending: HashMap<String, Vec<usize>>,
}
fn hash(v: &Value) -> String {
    format!("{:x}", Sha256::digest(v.to_string().as_bytes()))
}

pub(in crate::agent_work::runner) fn project_request(material: Value) -> Value {
    // Direct calls have no retained context: references must resolve inside this request.
    let mut guidance = GuidanceRef::new(&material["knowledgeRules"]);
    guidance.project_initial(material)
}

impl GuidanceRef {
    fn resolve(&self, reference: &Value) -> Option<&Base> {
        self.bases
            .iter()
            .find(|b| {
                b.reference == *reference
                    || (b.reference["sha256"] == reference["sha256"]
                        && b.reference["utf8Bytes"] == reference["utf8Bytes"]
                        && b.reference["scope"] == reference["scope"]
                        && b.reference["ruleVersion"] == reference["ruleVersion"])
            })
            .filter(|b| reference["sha256"] == hash(&b.value))
    }

    pub(super) fn new(initial: &Value) -> Self {
        let mut s = Self {
            initial_view: Value::Null,
            reference: None,
            bases: Vec::new(),
            generation: 0,
            pending: HashMap::new(),
        };
        let mut local = HashSet::new();
        s.initial_view = s.rule(initial, "initialContext.knowledgeRules", true, &mut local);
        for i in local {
            s.bases[i].known = true;
        }
        s.reference = s
            .bases
            .iter()
            .find(|b| {
                b.value == *initial && b.reference["location"] == "initialContext.knowledgeRules"
            })
            .map(|b| b.reference.clone());
        s
    }
    pub(super) fn reference(&self) -> Option<&Value> {
        self.reference.as_ref()
    }
    pub(super) fn initial_view(&self) -> Value {
        self.initial_view.clone()
    }
    pub(super) fn binding(&self) -> Value {
        json!({"schemaVersion":2,"contextGeneration":self.generation.to_string(),"bases":self.bases.iter().filter(|b|b.known).map(|b|&b.reference).collect::<Vec<_>>(),"scope":"exact losslessly expandable rules/catalogs at declared payload locations; host retention alone is not model availability"})
    }
    pub(super) fn invalidate(&mut self) {
        self.generation = self.generation.saturating_add(1);
        for b in &mut self.bases {
            b.known = false;
        }
        self.pending.clear();
    }
    pub(super) fn sent(&mut self, call: &str) {
        if let Some(indices) = self.pending.remove(call) {
            for i in indices {
                if self.bases[i].generation == self.generation {
                    self.bases[i].known = true;
                }
            }
        }
    }
    fn rule(
        &mut self,
        value: &Value,
        location: &str,
        register: bool,
        local: &mut HashSet<usize>,
    ) -> Value {
        if let Some((_, base)) = self.bases.iter().enumerate().find(|(i, b)| {
            b.generation == self.generation && (b.known || local.contains(i)) && b.value == *value
        }) {
            return json!({"knowledgeRulesRef":base.reference});
        }
        let mut wire = value.clone();
        if let Some(a) = wire.as_array_mut() {
            for (i, v) in a.iter_mut().enumerate() {
                *v = self.rule(v, &format!("{location}/{i}"), register, local);
                if v.as_object()
                    .is_some_and(|m| m.len() == 1 && m.contains_key("knowledgeRulesRef"))
                {
                    *v = json!({"ruleValueRef":v["knowledgeRulesRef"]});
                }
            }
        } else if let Some(a) = wire.get_mut("entries").and_then(Value::as_array_mut) {
            for (i, v) in a.iter_mut().enumerate() {
                *v = self.rule(v, &format!("{location}/entries/{i}"), register, local);
                if v.as_object()
                    .is_some_and(|m| m.len() == 1 && m.contains_key("knowledgeRulesRef"))
                {
                    *v = json!({"ruleValueRef":v["knowledgeRulesRef"]});
                }
            }
        }
        // Keep aggregate bases full so a restarted context can resolve reordered entries.
        if register
            && value.to_string().len() >= MIN_REFERENCE
            && self.bases.len() < MAX_BASES
            && (wire == *value
                || !self
                    .bases
                    .iter()
                    .any(|b| b.value == *value && b.generation == self.generation))
        {
            let reference = json!({"schemaVersion":2,"location":location,"sha256":hash(value),"utf8Bytes":value.to_string().len(),"contextGeneration":self.generation.to_string(),"scope":value.get("scope").cloned().unwrap_or_else(||json!({"libraryId":value["libraryId"],"documentId":value["documentId"]})),"ruleVersion":value.get("version").or_else(||value.get("fingerprint")).cloned()});
            if wire == *value {
                local.insert(self.bases.len());
            }
            self.bases.push(Base {
                value: value.clone(),
                reference,
                known: false,
                generation: self.generation,
            });
        }
        wire
    }
    fn catalog(&mut self, value: Value, location: &str, local: &mut HashSet<usize>) -> Value {
        if let Some((_, base)) = self.bases.iter().enumerate().find(|(i, b)| {
            b.generation == self.generation && (b.known || local.contains(i)) && b.value == value
        }) {
            return json!({"quoteCatalogRef":base.reference});
        }
        if value.to_string().len() >= MIN_REFERENCE && self.bases.len() < MAX_BASES {
            let reference = json!({"schemaVersion":2,"location":location,"sha256":hash(&value),"utf8Bytes":value.to_string().len(),"contextGeneration":self.generation.to_string(),"scope":{"field":"quoteCatalog"},"ruleVersion":null});
            local.insert(self.bases.len());
            self.bases.push(Base {
                value: value.clone(),
                reference,
                known: false,
                generation: self.generation,
            });
        }
        value
    }
    fn walk(
        &mut self,
        value: &mut Value,
        location: &str,
        register: bool,
        local: &mut HashSet<usize>,
    ) {
        match value {
            Value::Array(a) => {
                for (i, v) in a.iter_mut().enumerate() {
                    self.walk(v, &format!("{location}/{i}"), register, local);
                }
            }
            Value::Object(o) => {
                if let Some(full) = o.remove("quoteCatalog") {
                    // An explicit reread is also the recovery path for an unseen citation catalog.
                    let projected = if o.get("quoteCatalogScope").and_then(Value::as_str)
                        == Some("currentRead")
                    {
                        full
                    } else {
                        self.catalog(full, &format!("{location}.quoteCatalog"), local)
                    };
                    if let Some(reference) = projected.get("quoteCatalogRef") {
                        o.insert("quoteCatalogRef".into(), reference.clone());
                    } else {
                        o.insert("quoteCatalog".into(), projected);
                    }
                }
                if let Some(full) = o.remove("knowledgeRules") {
                    let projected = self.rule(
                        &full,
                        &format!("{location}.knowledgeRules"),
                        register,
                        local,
                    );
                    if projected
                        .as_object()
                        .is_some_and(|v| v.len() == 1 && v.contains_key("knowledgeRulesRef"))
                    {
                        o.insert(
                            "knowledgeRulesRef".into(),
                            projected["knowledgeRulesRef"].clone(),
                        );
                    } else {
                        o.insert("knowledgeRules".into(), projected);
                    }
                }
                for (k, v) in o.iter_mut() {
                    if !matches!(
                        k.as_str(),
                        "knowledgeRules"
                            | "knowledgeRulesRef"
                            | "quoteCatalog"
                            | "quoteCatalogRef"
                            | "businessActionRecords"
                    ) {
                        self.walk(v, &format!("{location}.{k}"), register, local);
                    }
                }
            }
            _ => (),
        }
    }
    pub(super) fn project_initial(&mut self, mut material: Value) -> Value {
        material.as_object_mut().unwrap().remove("knowledgeRules");
        let mut local = HashSet::new();
        self.walk(&mut material, "initialContext", false, &mut local);
        for i in local {
            self.bases[i].known = true;
        }
        material["knowledgeRules"] = self.initial_view();
        material
    }
    pub(super) fn project_for(&mut self, mut output: Value, call: &str) -> Value {
        let mut local = HashSet::new();
        self.walk(&mut output, &format!("toolResult:{call}"), true, &mut local);
        self.pending
            .insert(call.into(), local.into_iter().collect());
        output
    }
    #[cfg(test)]
    pub(super) fn project(&self, output: Value) -> Value {
        self.clone().project_for(output, "test")
    }
    pub(super) fn restore_replay(&self, mut output: Value) -> Result<Value, String> {
        fn restore(s: &GuidanceRef, v: &mut Value) -> Result<(), String> {
            match v {
                Value::Array(a) => {
                    for v in a {
                        restore(s, v)?;
                    }
                }
                Value::Object(o) => {
                    if let Some(reference) = o.get("ruleValueRef") {
                        let base = s.resolve(reference).ok_or("规则条目引用指纹不匹配")?;
                        if o.len() != 1 {
                            return Err("规则条目引用格式损坏".into());
                        }
                        if !base.known
                            || base.generation != s.generation
                            || base.reference != *reference
                        {
                            *v = base.value.clone();
                        }
                        return Ok(());
                    }
                    for (key, field) in [
                        ("knowledgeRulesRef", "knowledgeRules"),
                        ("quoteCatalogRef", "quoteCatalog"),
                    ] {
                        if let Some(reference) = o.get(key) {
                            let base = s
                                .resolve(reference)
                                .ok_or("重复回执的规则基版无法核对，未重发工具或业务动作")?;
                            if !base.known
                                || base.generation != s.generation
                                || base.reference != *reference
                            {
                                let full = base.value.clone();
                                o.remove(key);
                                o.insert(field.into(), full);
                            }
                        }
                    }
                    for (k, v) in o.iter_mut() {
                        if !matches!(
                            k.as_str(),
                            "knowledgeRulesRef"
                                | "quoteCatalogRef"
                                | "quoteCatalog"
                                | "businessActionRecords"
                        ) {
                            restore(s, v)?;
                        }
                    }
                }
                _ => (),
            }
            Ok(())
        }
        restore(self, &mut output)?;
        Ok(output)
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_request_keeps_rules_and_latest_work_without_duplicate_rule_text() {
        let rules = json!({"libraryId":"engineering","documentId":"notes","fingerprint":"v1",
            "entries":[{"instructions":"Do not call a proposed move completed. ".repeat(500)}]});
        let material = json!({"knowledgeRules":[rules.clone()],
            "observations":[{"evidenceId":"e1","knowledgeRules":rules}],
            "conversation":{"currentRequest":"Keep two steps, not three.","messages":[{"role":"assistant","text":"The two steps are not executed."}]},
            "quoteCatalog":[{"quoteId":"e1:q1","text":"Original source words"}],
            "businessActionRecords":[{"state":"unknown"}],"capabilities":{"allowed":false}});
        let wire = project_request(material.clone());
        assert!(wire.to_string().len() + 10_000 < material.to_string().len());
        assert_eq!(wire["knowledgeRules"], material["knowledgeRules"]);
        assert_eq!(
            wire["observations"][0]["knowledgeRulesRef"]["location"],
            "initialContext.knowledgeRules/0"
        );
        for field in [
            "conversation",
            "quoteCatalog",
            "businessActionRecords",
            "capabilities",
        ] {
            assert_eq!(wire[field], material[field]);
        }
        let mut recovery = GuidanceRef::new(&material["knowledgeRules"]);
        recovery.invalidate();
        assert_eq!(recovery.restore_replay(wire.clone()).unwrap(), material);
        assert_eq!(project_request(material), wire);
    }

    #[test]
    fn direct_request_never_references_another_scope_or_a_previous_request_version() {
        let rule = |library: &str, version: i64| {
            json!({"libraryId":library,"documentId":"notes",
            "version":version,"entries":[{"scope":{"libraryId":library},"version":version,"instructions":"Keep source facts distinct from suggestions. ".repeat(50)}]})
        };
        let first = rule("engineering", 1);
        let next = rule("engineering", 2);
        let other = rule("another-project", 1);
        let _ = project_request(json!({"knowledgeRules":[first.clone()]}));
        let material = json!({"knowledgeRules":[next.clone()],"observations":[
            {"knowledgeRules":first},{"knowledgeRules":other},{"knowledgeRules":next}]});
        let wire = project_request(material.clone());
        assert_eq!(wire["knowledgeRules"], material["knowledgeRules"]);
        assert_eq!(wire["observations"][0], material["observations"][0]);
        assert_eq!(wire["observations"][1], material["observations"][1]);
        assert_eq!(
            wire["observations"][2]["knowledgeRulesRef"]["sha256"],
            hash(&next)
        );
    }

    #[test]
    fn direct_request_citation_references_resolve_in_the_same_request() {
        let catalog = json!([{"quoteId":"e1:q1","text":"Actual source words. ".repeat(100)}]);
        let material = json!({"knowledgeRules":[],"quoteCatalog":catalog,
            "observations":[{"quoteCatalog":catalog,"evidenceId":"e1"}],
            "sharedMemory":{"enabled":false},"sources":{"exactNotes":["selected-note"]}});
        let wire = project_request(material.clone());
        assert_eq!(wire["quoteCatalog"], material["quoteCatalog"]);
        assert_eq!(
            wire["observations"][0]["quoteCatalogRef"]["location"],
            "initialContext.quoteCatalog"
        );
        assert_eq!(wire["sharedMemory"], material["sharedMemory"]);
        assert_eq!(wire["sources"], material["sources"]);
        let mut recovery = GuidanceRef::new(&material["knowledgeRules"]);
        recovery.project_initial(material.clone());
        recovery.invalidate();
        assert_eq!(recovery.restore_replay(wire).unwrap(), material);
    }

    #[test]
    fn compaction_invalidates_reference_and_restores_cached_reply_without_reexecution() {
        let initial = json!({"libraryInstructions":["有效规则".repeat(400)]});
        let full = json!({"knowledgeRules":initial,"businessActionRecords":[{"state":"unknown"}],"quoteCatalog":[{"quoteId":"e1"}]});
        let mut rules = GuidanceRef::new(&initial);
        let projected = rules.project(full.clone());
        assert!(projected.get("knowledgeRulesRef").is_some());
        assert_eq!(rules.restore_replay(projected.clone()).unwrap(), projected);
        rules.invalidate();
        assert_eq!(rules.project(full.clone()), full);
        assert_eq!(rules.restore_replay(projected.clone()).unwrap(), full);
        let mut broken = projected;
        broken["knowledgeRulesRef"]["sha256"] = json!("different");
        assert!(rules.restore_replay(broken).is_err());
        assert!(GuidanceRef::new(&initial)
            .project(full)
            .get("knowledgeRulesRef")
            .is_some());
    }
    #[test]
    fn large_guidance_is_losslessly_referenced_and_changes_or_small_rules_stay_full() {
        let initial = json!({"libraryInstructions":[{"text":"中文规则".repeat(1000)}]});
        let rules = GuidanceRef::new(&initial);
        let old = json!({"knowledgeRules":initial,"quoteCatalog":[{"quoteId":"e1"}],"result":{"rows":[1,2]},"remainingToolSteps":17});
        let mut wire = rules.project(old.clone());
        assert!(wire.to_string().len() < old.to_string().len());
        assert_eq!(
            wire["knowledgeRulesRef"]["sha256"],
            rules.reference().unwrap()["sha256"]
        );
        wire.as_object_mut().unwrap().remove("knowledgeRulesRef");
        wire["knowledgeRules"] = initial;
        assert_eq!(wire, old);
        let changed = json!({"knowledgeRules":{"libraryInstructions":["changed"]},"result":7});
        assert_eq!(rules.project(changed.clone()), changed);
        let small = json!({"knowledgeRules":{"libraryInstructions":[]},"result":7});
        assert_eq!(
            GuidanceRef::new(&small["knowledgeRules"]).project(small.clone()),
            small
        );
    }
    #[test]
    fn measured_small_rule_overhead_is_referenced_without_changing_scope_or_text() {
        let rules = json!({"libraryInstructions":[{"scope":{"libraryId":"notes"},"text":"规则与授权必须保留。".repeat(70)}]});
        assert!(rules.to_string().len() >= 1024 && rules.to_string().len() < 8192);
        let reference = GuidanceRef::new(&rules);
        let original =
            json!({"result":{"actual":"原文"},"knowledgeRules":rules,"remainingToolSteps":5});
        let mut projected = reference.project(original.clone());
        assert!(projected.get("knowledgeRules").is_none());
        assert_eq!(
            projected["knowledgeRulesRef"]["location"],
            "initialContext.knowledgeRules"
        );
        projected
            .as_object_mut()
            .unwrap()
            .remove("knowledgeRulesRef");
        projected["knowledgeRules"] = rules;
        assert_eq!(projected, original);
    }
    #[test]
    #[ignore = "explicit saved C8 full frames only; no model"]
    fn saved_c8_full_rule_frames_round_trip_through_the_production_projection() {
        let path = std::env::var("HUB_C9_GUIDANCE_REPLAY").unwrap();
        let cases: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let mut referenced = 0;
        for case in cases.as_array().unwrap() {
            let rules = GuidanceRef::new(&case["initialRules"]);
            for original in case["frames"].as_array().unwrap() {
                let mut wire = rules.project(original.clone());
                if let Some(reference) = wire.as_object_mut().unwrap().remove("knowledgeRulesRef") {
                    assert_eq!(reference["sha256"], rules.reference().unwrap()["sha256"]);
                    wire["knowledgeRules"] = case["initialRules"].clone();
                    referenced += 1;
                }
                assert_eq!(
                    wire, *original,
                    "all source, result, quotes and rules retained"
                );
            }
        }
        assert!(referenced > 0);
    }
}

#[cfg(test)]
mod scoped_tests;
