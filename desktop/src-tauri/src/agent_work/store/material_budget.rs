//! A host-frozen, source-bound estimate for one concrete native task. Not authority or a new budget.
use super::*;
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::agent_work) struct ReadPlan {
    pub locator: EvidenceLocator,
    pub version: crate::source_evidence::EvidenceVersion,
    pub repetitions: usize,
    #[serde(default)]
    pub saved_result: Option<Value>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::agent_work) struct Plan {
    pub schema_version: u8,
    pub work_revision: i64,
    pub authorization_version: i64,
    pub request_bytes: usize,
    pub reads: Vec<ReadPlan>,
    pub working_state_round_trips: usize,
    pub working_state_extra_bytes: usize,
    pub goal_state_reads: usize,
    pub other_reply_bytes: usize,
    pub reserve_rule_restore: bool,
    pub basis: String,
}
pub(in crate::agent_work) fn load_on(c: &Connection, id: &str) -> Result<Option<Plan>, String> {
    let raw:Option<String>=c.query_row("SELECT body_json FROM agent_records WHERE work_id=?1 AND kind='nativeMaterialPlan' ORDER BY rowid DESC LIMIT 1",[id],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    raw.map(|v| serde_json::from_str(&v).map_err(|_| "材料余量计划损坏".into()))
        .transpose()
}
pub(in crate::agent_work) fn freeze(root: &Path, args: &Value) -> Result<Value, String> {
    let id = text(args, "id", 150)?;
    let p: Plan =
        serde_json::from_value(args["plan"].clone()).map_err(|_| "材料余量计划格式无效")?;
    // A plan may span two bounded datasets; these estimates never increase the Run's cumulative allowance.
    if p.schema_version != 1
        || p.request_bytes == 0
        || p.request_bytes > 3_145_728
        || p.reads.is_empty()
        || p.reads.len() > 64
        || p.reads
            .iter()
            .any(|r| r.repetitions == 0 || r.repetitions > 3)
        || p.working_state_round_trips > 4
        || p.goal_state_reads > 4
        || p.working_state_extra_bytes > 16384
        || p.other_reply_bytes > 262144
        || p.basis.trim().len() < 20
    {
        return Err("材料余量计划缺少有界步骤或估算依据".into());
    }
    write(root, |c| {
        let w = load(c, &id)?;
        if w.active_run.is_some()
            || w.state == "revoked"
            || p.work_revision != w.revision
            || p.authorization_version != w.authorization_version
        {
            return Err("事项或授权已变化，未冻结材料计划".into());
        }
        if !provider_budget::configured_on(c, &w)? {
            return Err("先固定同事项提供方额度，再登记材料余量计划".into());
        }
        let reader = w.grant.reader(root)?;
        for r in &p.reads {
            reader.read(&r.locator, 0, 1, Some(&r.version))?;
        }
        if let Some(old) = load_on(c, &id)? {
            let old = serde_json::to_value(old).unwrap();
            if old == serde_json::to_value(&p).unwrap() {
                return Ok(());
            }
            let expected: Plan = serde_json::from_value(args["expectedPlan"].clone())
                .map_err(|_| "更新材料计划须提供完整旧计划")?;
            if serde_json::to_value(expected).unwrap() != old {
                return Err("材料计划已经冻结；更新须核对完整旧计划，未覆盖历史".into());
            }
        }
        insert(c, &id, None, "nativeMaterialPlan", &json!(p))
    })?;
    super::super::status(root, &id)
}
