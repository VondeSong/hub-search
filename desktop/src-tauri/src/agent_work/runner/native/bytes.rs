//! Mutually exclusive UTF-8 byte accounting at the existing Hub charge boundary.
use serde_json::{json, Value};
#[derive(Clone, Default)]
pub(super) struct Ledger {
    pub initial: usize,
    pub tools: usize,
    pub instructions: usize,
    pub full_rules: usize,
    pub references: usize,
    pub business: usize,
    pub protocol: usize,
    pub image_raw: usize,
    pub image_wire: usize,
    pub limit: usize,
    pub avoided: usize,
}
fn references(v: &Value) -> usize {
    match v {
        Value::Array(a) => a.iter().map(references).sum(),
        Value::Object(o) => o
            .iter()
            .map(|(k, v)| {
                if matches!(k.as_str(), "knowledgeRulesRef" | "ruleValueRef") {
                    v.to_string().len()
                } else {
                    references(v)
                }
            })
            .sum(),
        _ => 0,
    }
}
pub(super) fn rules(v: &Value) -> (usize, usize) {
    let mut full = 0;
    let mut refs = 0;
    match v {
        Value::Array(a) => {
            for v in a {
                let (f, r) = rules(v);
                full += f;
                refs += r;
            }
        }
        Value::Object(o) => {
            for (k, v) in o {
                if k == "knowledgeRules" {
                    let r = references(v);
                    full += v.to_string().len() - r;
                    refs += r;
                } else if matches!(k.as_str(), "knowledgeRulesRef" | "ruleValueRef") {
                    refs += v.to_string().len();
                } else if !matches!(k.as_str(), "quoteCatalog" | "businessActionRecords") {
                    let (f, r) = rules(v);
                    full += f;
                    refs += r;
                }
            }
        }
        _ => (),
    }
    (full, refs)
}
impl Ledger {
    pub(super) fn new(
        input: &str,
        material: &Value,
        tools: &Value,
        instructions: &str,
        limit: usize,
    ) -> Self {
        let (f, r) = rules(material);
        Self {
            initial: input.len() - f - r,
            tools: tools.to_string().len(),
            instructions: instructions.len(),
            full_rules: f,
            references: r,
            limit,
            ..Self::default()
        }
    }
    pub(super) fn total(&self) -> usize {
        self.initial
            + self.tools
            + self.instructions
            + self.full_rules
            + self.references
            + self.business
            + self.protocol
            + self.image_wire
    }
    pub(super) fn tool(&mut self, full: &Value, wire: &Value) {
        let (f, r) = rules(wire);
        let n = wire.to_string().len();
        self.full_rules += f;
        self.references += r;
        self.business += n - f - r;
        self.avoided += full.to_string().len().saturating_sub(n);
    }
    pub(super) fn images(&mut self, raw: usize, wire: usize) {
        self.image_raw += raw;
        self.image_wire += wire;
    }
    pub(super) fn text(&mut self, text: &str) {
        self.initial += text.len();
    }
    pub(super) fn check(&self) -> Result<(), String> {
        if self.total() > self.limit {
            Err(format!(
                "Agent 材料预算已用尽，成果已保留（累计 {} 字节，上限 {} 字节）",
                self.total(),
                self.limit
            ))
        } else {
            Ok(())
        }
    }
    pub(super) fn snapshot(&self, phase: &str) -> Value {
        json!({"schemaVersion":1,"phase":phase,"initialTaskAndOtherBytes":self.initial,"toolDefinitionsBytes":self.tools,"instructionBytes":self.instructions,"fullRulesBytes":self.full_rules,"ruleReferenceBytes":self.references,"toolBusinessBytes":self.business,"protocolEnvelopeBytes":self.protocol,"imageRawBytes":self.image_raw,"imageWireBytes":self.image_wire,"imageAccounting":"inline encoded image bytes charged once per submitted turn; raw bytes diagnostic only","chargedBytes":self.total(),"limitBytes":self.limit,"remainingBytes":self.limit.saturating_sub(self.total()),"overrunBytes":self.total().saturating_sub(self.limit),"avoidedRuleBytes":self.avoided,"singlePayloadLimitBytes":196608,"providerTokens":null,"scope":"mutually exclusive UTF-8 categories; JSON field names and delimiters belong to their surrounding initial/business bytes; avoidedRuleBytes is diagnostic, never added to total; provider tokens are separate","unchangedExclusions":"inbound model report/patch arguments and finish acknowledgement were not part of this existing requestBytes counter; provider output tokens remain independently bounded"})
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disjoint_categories_and_exact_boundary() {
        let v = json!({"knowledgeRules":[{"rules":"全文","entry":{"ruleValueRef":{"sha256":"known"}}}],"result":{"knowledgeRules":{"instructions":"全文"},"content":"原文"},"quoteCatalog":["原句"],"businessActionRecords":[{"state":"unknown"}]});
        let input = format!("请求{}", v);
        let mut l = Ledger::new(&input, &v, &json!([]), "指令", 99999);
        assert_eq!(l.total(), input.len() + 2 + "指令".len());
        l.tool(&v, &v);
        let n = l.total();
        l.limit = n;
        assert!(l.check().is_ok());
        l.limit = n - 1;
        assert!(l.check().is_err());
        assert_eq!(l.snapshot("stop")["overrunBytes"], 1);
        assert!(l.references > 0 && l.full_rules > 0);
    }
    #[test]
    fn five_hundred_kib_is_a_cumulative_contract_not_a_single_payload_or_reset() {
        let rules = json!({"libraryId":"synthetic","instructions":"scoped rule ".repeat(200)});
        let material = json!({"knowledgeRules":rules});
        let input = material.to_string();
        let mut ledger = Ledger::new(&input, &material, &json!([]), "instructions", 500 * 1024);
        let mut guidance = super::super::guidance::GuidanceRef::new(&rules);
        let raw = json!({"knowledgeRules":rules,"result":{"content":"x".repeat(48*1024)},"quoteCatalog":[]});
        for n in 0..10 {
            let call = format!("call{n}");
            let wire = guidance.project_for(raw.clone(), &call);
            assert!(wire.to_string().len() < 65536);
            ledger.tool(&raw, &wire);
            guidance.sent(&call);
        }
        assert!(ledger.check().is_ok());
        let charged = ledger.total();
        guidance.invalidate();
        assert_eq!(ledger.total(), charged);
        let recovery = guidance.project_for(raw.clone(), "after-compaction");
        ledger.tool(&raw, &recovery);
        assert!(ledger.check().is_err());
        assert!(ledger.total() > 500 * 1024);
        assert_eq!(ledger.snapshot("stop")["singlePayloadLimitBytes"], 196608);
    }
    #[test]
    fn mcp_framing_is_part_of_the_same_cumulative_hard_limit() {
        let mut v = Ledger::new("", &json!({}), &json!([]), "", 32);
        v.protocol = 30;
        assert_eq!(v.total(), 32);
        assert!(v.check().is_ok());
        v.protocol += 1;
        assert!(v.check().is_err());
        assert_eq!(v.snapshot("mcp")["protocolEnvelopeBytes"], 31);
    }
}

#[cfg(test)]
#[test]
fn cn05b_image_wire_bytes_are_charged_per_turn_and_raw_is_diagnostic() {
    let mut l = Ledger::new("text", &json!({}), &json!([]), "", 500);
    let base = l.total();
    l.images(30, 40);
    assert_eq!(l.total(), base + 40);
    assert_eq!(l.snapshot("beforeProvider")["imageRawBytes"], 30);
    l.images(30, 40);
    assert_eq!(l.total(), base + 80);
    l.limit = l.total() - 1;
    assert!(l.check().is_err());
}
