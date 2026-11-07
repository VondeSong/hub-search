//! Optional frozen provider admission, owned by the same durable Work ledger.
//! Reservations are estimates, never a claim about exact billing. Unknown or
//! interrupted consumption retains the reservation and any higher observation.
use super::*;
use std::collections::BTreeMap;
pub(in crate::agent_work) mod direct;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Tokens {
    input_tokens: u64,
    uncached_input_tokens: u64,
    output_tokens: u64,
}
impl Tokens {
    fn add(self, other: Self) -> Self {
        Self {
            input_tokens: self.input_tokens.saturating_add(other.input_tokens),
            uncached_input_tokens: self
                .uncached_input_tokens
                .saturating_add(other.uncached_input_tokens),
            output_tokens: self.output_tokens.saturating_add(other.output_tokens),
        }
    }
    fn max(self, other: Self) -> Self {
        Self {
            input_tokens: self.input_tokens.max(other.input_tokens),
            uncached_input_tokens: self.uncached_input_tokens.max(other.uncached_input_tokens),
            output_tokens: self.output_tokens.max(other.output_tokens),
        }
    }
    fn fits(self, limit: Self) -> bool {
        self.input_tokens <= limit.input_tokens
            && self.uncached_input_tokens <= limit.uncached_input_tokens
            && self.output_tokens <= limit.output_tokens
    }
    fn positive(self) -> bool {
        self.input_tokens > 0
            && self.uncached_input_tokens > 0
            && self.output_tokens > 0
            && self.uncached_input_tokens <= self.input_tokens
    }
    fn from_usage(value: &Value) -> Option<Self> {
        Some(Self {
            input_tokens: value["inputTokens"].as_u64()?,
            uncached_input_tokens: value["uncachedInputTokens"].as_u64()?,
            output_tokens: value["outputTokens"].as_u64()?,
        })
    }
}
fn facts(c: &Connection, id: &str, kind: &str) -> Result<Vec<Value>, String> {
    let mut q = c
        .prepare("SELECT body_json FROM agent_records WHERE work_id=?1 AND kind=?2 ORDER BY rowid")
        .map_err(|e| e.to_string())?;
    let rows = q
        .query_map(params![id, kind], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.map(|r| {
        serde_json::from_str(&r.map_err(|e| e.to_string())?)
            .map_err(|_| "提供方预算记录损坏".into())
    })
    .collect()
}
fn policy(c: &Connection, id: &str) -> Result<Option<Value>, String> {
    let values = facts(c, id, "providerBudgetPolicy")?;
    if values.len() > 1 {
        return Err("提供方预算根冲突".into());
    }
    let Some(mut p) = values.into_iter().next() else {
        return Ok(None);
    };
    if p["schemaVersion"] != 1 || p["rootWorkId"] != id {
        return Err("提供方预算版本或根身份不可用".into());
    }
    for field in ["limits", "perRun"] {
        parse(&p[field])?;
    }
    let mut ids = std::collections::HashSet::new();
    for amendment in facts(c, id, "providerBudgetExtension")? {
        let operation = amendment["operationId"]
            .as_str()
            .ok_or("预算追加身份缺失")?;
        let limits = parse(&amendment["limits"])?;
        if amendment["schemaVersion"] != 1
            || amendment["rootWorkId"] != id
            || !ids.insert(operation.to_string())
            || amendment["previousLimits"] != p["limits"]
            || !limits.positive()
            || !parse(&p["limits"])?.fits(limits)
            || amendment["limits"] == p["limits"]
        {
            return Err("预算追加记录链损坏".into());
        }
        p["limits"] = json!(limits);
    }
    Ok(Some(p))
}
fn parse(v: &Value) -> Result<Tokens, String> {
    serde_json::from_value(v.clone()).map_err(|_| "提供方Token额度字段损坏".into())
}

// Only a trusted host entry can freeze this policy; it is not a model tool.
// Extensions retain this policy and every original reservation.
pub(in crate::agent_work) fn freeze(root: &Path, args: &Value) -> Result<(), String> {
    let id = super::super::text(args, "id", 150)?;
    let limits = parse(&args["limits"])?;
    let per_run = parse(&args["perRun"])?;
    let unknown: BTreeMap<String, Tokens> =
        serde_json::from_value(args["unknownReservations"].clone())
            .map_err(|_| "缺少旧未知用量的保守预留".to_string())?;
    if !limits.positive() || !per_run.positive() || !per_run.fits(limits) {
        return Err("提供方额度必须为正且单轮不超过事项额度".into());
    }
    let scope = match args.get("analysisScope").and_then(Value::as_str) {
        None if args.get("analysisScope").is_none() => "nativeAgentOnly",
        Some("nativeAgentOnly") => "nativeAgentOnly",
        Some(direct::SCOPE) => direct::SCOPE,
        _ => return Err("不支持的分析预算范围".into()),
    };
    let mut request = json!({"limits":limits,"perRun":per_run,"unknownReservations":unknown});
    if scope != "nativeAgentOnly" {
        request["analysisScope"] = json!(scope);
    }
    write(root, |c| {
        if let Some(old) = policy(c, &id)? {
            return if old["request"] == request {
                Ok(())
            } else {
                Err("提供方额度已冻结，不能重置或覆盖".into())
            };
        }
        let w = load(c, &id)?;
        if w.active_run.is_some()
            || w.state == "revoked"
            || args["expectedAuthorizationVersion"]
                .as_i64()
                .is_some_and(|v| v != w.authorization_version)
            || args["expectedWorkRevision"].as_i64() != Some(w.revision)
        {
            return Err("请在运行停稳并刷新事项后冻结额度".into());
        }
        let mut q = c
            .prepare("SELECT id FROM agent_runs WHERE work_id=?1 ORDER BY rowid")
            .map_err(|e| e.to_string())?;
        let runs = q
            .query_map([&id], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let mut allocations = Vec::new();
        let mut supplied = std::collections::HashSet::new();
        let measurements = facts(c, &id, "nativeMeasurement")?;
        for run in runs {
            let values: Vec<&Value> = measurements.iter().filter(|v| v["runId"] == run).collect();
            // Older measurement records contain runId in their body. Only a
            // completed runtime with a complete delta releases an estimate.
            let measured = values
                .iter()
                .find(|v| v["runtimeSucceeded"] == true)
                .and_then(|v| Tokens::from_usage(&v["turnTokens"]));
            let invoked:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_records WHERE run_id=?1 AND kind IN ('nativeRuntime','modelExecution')) OR EXISTS(SELECT 1 FROM agent_runs WHERE id=?1 AND (COALESCE(json_extract(usage_json,'$.modelCalls'),0)>0 OR COALESCE(json_extract(usage_json,'$.agentSessions'),0)>0))",[&run],|r|r.get(0)).map_err(|e|e.to_string())?;
            let (charged, kind) = if let Some(actual) = measured {
                (actual, "measured")
            } else if !invoked {
                (Tokens::default(), "noProviderDispatch")
            } else {
                let estimate = unknown
                    .get(&run)
                    .copied()
                    .filter(|v| v.positive())
                    .ok_or("旧运行用量未知；必须保留正值预留，不能当作零")?;
                if values
                    .iter()
                    .filter_map(|v| Tokens::from_usage(&v["turnTokens"]))
                    .any(|v| !v.fits(estimate))
                {
                    return Err("旧用量预留低于已知观察，不能抹去消费".into());
                }
                supplied.insert(run.clone());
                (estimate, "reservedUnknown")
            };
            allocations.push(json!({"runId":run,"charged":charged,"kind":kind}));
        }
        if unknown.keys().any(|key| !supplied.contains(key)) {
            return Err("未知用量预留包含不匹配或已有完整计量的运行".into());
        }
        insert(
            c,
            &id,
            None,
            "providerBudgetPolicy",
            &json!({"schemaVersion":1,"rootWorkId":id,"request":request,"limits":limits,"perRun":per_run,"legacyAllocations":allocations,"scope":scope,"feesKnown":false}),
        )
    })
}
// Trusted host only: compare-and-append, never a model tool or a usage reset.
pub(in crate::agent_work) fn extend(root: &Path, args: &Value) -> Result<(), String> {
    let id = super::super::text(args, "id", 150)?;
    let operation = super::super::text(args, "operationId", 150)?;
    let reason = super::super::text(args, "reason", 2000)?;
    let limits = parse(&args["limits"])?;
    let previous = parse(&args["expectedLimits"])?;
    if !limits.positive() || !previous.fits(limits) || limits == previous {
        return Err("预算追加只能明确提高累计上限，不能降低或清零".into());
    }
    let record = json!({"schemaVersion":1,"rootWorkId":id,"operationId":operation,"reason":reason,"previousLimits":previous,"limits":limits,"workRevision":args["expectedWorkRevision"],"authorizationVersion":args["expectedAuthorizationVersion"]});
    write(root, |c| {
        let w = load(c, &id)?;
        if w.active_run.is_some()
            || w.state == "revoked"
            || record["workRevision"].as_i64() != Some(w.revision)
            || record["authorizationVersion"].as_i64() != Some(w.authorization_version)
        {
            return Err("事项正在运行或版本/授权已变化，未追加预算".into());
        }
        let p = policy(c, &id)?.ok_or("先冻结事项预算")?;
        if let Some(old) = facts(c, &id, "providerBudgetExtension")?
            .into_iter()
            .find(|v| v["operationId"] == operation)
        {
            return if old == record {
                Ok(())
            } else {
                Err("预算追加身份已用于不同决定".into())
            };
        }
        if p["limits"] != json!(previous) {
            return Err("预算上限已变化，请重新核对，未追加".into());
        }
        insert(c, &id, None, "providerBudgetExtension", &record)
    })
}

fn state(c: &Connection, id: &str, p: &Value) -> Result<(Tokens, Vec<String>), String> {
    let mut total = Tokens::default();
    let mut unknown = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for a in p["legacyAllocations"]
        .as_array()
        .ok_or("旧提供方预算分配损坏")?
    {
        let run = a["runId"].as_str().ok_or("旧预算运行身份缺失")?;
        if !seen.insert(run.to_string()) {
            return Err("提供方重复预算身份".into());
        }
        total = total.add(parse(&a["charged"])?);
        if a["kind"] == "reservedUnknown" {
            unknown.push(run.to_string());
        }
    }
    let settled = facts(c, id, "providerBudgetSettlement")?;
    let observed = facts(c, id, "providerBudgetObservation")?;
    for a in facts(c, id, "providerBudgetReservation")? {
        let run = a["runId"].as_str().ok_or("预算运行身份缺失")?;
        if a["schemaVersion"] != 1 || !seen.insert(run.to_string()) {
            return Err("提供方预算身份或版本冲突".into());
        }
        let matches: Vec<_> = settled.iter().filter(|s| s["runId"] == run).collect();
        if matches.len() > 1 {
            return Err("提供方重复结算".into());
        }
        let charged = if let Some(s) = matches.first() {
            parse(&s["charged"])?
        } else {
            unknown.push(run.to_string());
            observed
                .iter()
                .filter(|v| v["runId"] == run)
                .try_fold(parse(&a["reserved"])?, |acc, v| {
                    Ok::<_, String>(acc.max(parse(&v["observed"])?))
                })?
        };
        total = total.add(charged);
    }
    Ok((total, unknown))
}
pub(in crate::agent_work) fn reserve_on(c: &Connection, w: &Work, run: &str) -> Result<(), String> {
    let Some(p) = policy(c, &w.id)? else {
        return Ok(());
    };
    if facts(c, &w.id, "providerBudgetReservation")?
        .iter()
        .any(|v| v["runId"] == run)
    {
        return Ok(());
    }
    let (charged, _) = state(c, &w.id, &p)?;
    let desired = parse(&p["perRun"])?;
    if !charged.add(desired).fits(parse(&p["limits"])?) {
        return Err("本事项提供方Token累计额度不足；未启动模型，旧成果与未知用量保留".into());
    }
    insert(
        c,
        &w.id,
        None,
        "providerBudgetReservation",
        &json!({"schemaVersion":1,"runId":run,"reserved":desired}),
    )
}
// Advisory legacy preview; freeze re-reads all facts transactionally before accepting allocations.
fn legacy_preview(c: &Connection, id: &str) -> Result<Value, String> {
    let measurements = facts(c, id, "nativeMeasurement")?;
    let mut q = c
        .prepare("SELECT id FROM agent_runs WHERE work_id=?1 ORDER BY rowid")
        .map_err(|e| e.to_string())?;
    let runs = q
        .query_map([id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut measured = Tokens::default();
    let mut unknown = Vec::new();
    for run in runs {
        let values = measurements
            .iter()
            .filter(|m| m["runId"] == run)
            .collect::<Vec<_>>();
        if let Some(actual) = values
            .iter()
            .find(|v| v["runtimeSucceeded"] == true)
            .and_then(|v| Tokens::from_usage(&v["turnTokens"]))
        {
            measured = measured.add(actual);
            continue;
        }
        let invoked:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_records WHERE run_id=?1 AND kind IN ('nativeRuntime','modelExecution')) OR EXISTS(SELECT 1 FROM agent_runs WHERE id=?1 AND (COALESCE(json_extract(usage_json,'$.modelCalls'),0)>0 OR COALESCE(json_extract(usage_json,'$.agentSessions'),0)>0))",[&run],|r|r.get(0)).map_err(|e|e.to_string())?;
        if invoked {
            let lower = values
                .iter()
                .filter_map(|v| Tokens::from_usage(&v["turnTokens"]))
                .fold(Tokens::default(), Tokens::max);
            unknown.push(json!({"runId":run,"minimum":lower}));
        }
    }
    Ok(json!({"measured":measured,"unknownRuns":unknown}))
}
pub(in crate::agent_work) fn view_on(c: &Connection, w: &Work) -> Result<Value, String> {
    let Some(p) = policy(c, &w.id)? else {
        return Ok(
            json!({"state":"unconfigured","providerTokensBounded":false,"feesKnown":false,"legacy":legacy_preview(c,&w.id)?}),
        );
    };
    let (charged, unknown) = state(c, &w.id, &p)?;
    let eligible = charged.add(parse(&p["perRun"])?).fits(parse(&p["limits"])?);
    Ok(
        json!({"state":if eligible {"available"} else {"exhausted"},"rootWorkId":w.id,"limits":p["limits"],"perRun":p["perRun"],"chargedOrReserved":charged,"analysisScope":p["scope"],"unmeasuredRunIds":unknown,"canAdmitRun":eligible,"providerTokensBounded":true,"feesKnown":false,"scope":"estimated admission and observed stop; not provider-side absolute billing cap"}),
    )
}
pub(in crate::agent_work) fn configured(root: &Path, w: &Work) -> Result<bool, String> {
    configured_on(&read(root)?, w)
}
pub(in crate::agent_work) fn configured_on(c: &Connection, w: &Work) -> Result<bool, String> {
    Ok(policy(c, &w.id)?.is_some())
}

/// Called for live usage and final success. Partial/cancelled observations never
/// settle an attempt. Quota failure is persisted before stopping dispatch.
pub(in crate::agent_work) fn observe(
    root: &Path,
    w: &Work,
    run: &str,
    usage: &Value,
    complete: bool,
) -> Result<(), String> {
    write(root,|c|{
        let Some(p)=policy(c,&w.id)? else {return Ok(false)};
        let allocations=facts(c,&w.id,"providerBudgetReservation")?;
        let a=allocations.iter().find(|a|a["runId"]==run).ok_or("提供方派发缺少持久预算预留")?;
        let exact=Tokens::from_usage(usage);
        // Zero here is an unknown dimension's lower bound, always joined with
        // the full reservation. Partial numbers cannot settle an attempt.
        let partial=usage.get("knownLowerBounds").filter(|v|v.is_object()).unwrap_or(usage);
        let observed=exact.unwrap_or(Tokens {input_tokens:partial["inputTokens"].as_u64().unwrap_or(0),uncached_input_tokens:partial["uncachedInputTokens"].as_u64().unwrap_or(0),output_tokens:partial["outputTokens"].as_u64().unwrap_or(0)});
        let complete=complete && exact.is_some();
        if complete && facts(c,&w.id,"providerBudgetObservation")?.iter().filter(|v|v["runId"]==run).any(|v|parse(&v["observed"]).is_ok_and(|old|!old.fits(observed))) {return Err("提供方用量回退，保留原预留及更高观察，不结算".into());}
        let old=facts(c,&w.id,"providerBudgetSettlement")?;
        if let Some(s)=old.iter().find(|s|s["runId"]==run) {return if s["charged"]==json!(observed) {Ok(false)} else {Err("提供方已结算，不能改写计量".into())};}
        // Single immutable observation at completion/threshold, not one ledger
        // record per stream notification. Below-threshold partial values stay
        // conservatively covered by the full durable reservation.
        let exceeded=!observed.fits(parse(&a["reserved"])?);
        if complete || exceeded {
            insert(c,&w.id,None,"providerBudgetObservation",&json!({"schemaVersion":1,"runId":run,"observed":observed,"complete":complete,"exceeded":exceeded}))?;
            if complete {insert(c,&w.id,None,"providerBudgetSettlement",&json!({"schemaVersion":1,"runId":run,"charged":observed}))?;}
        }
        let (charged,_)=state(c,&w.id,&p)?;
        Ok(exceeded || !charged.fits(parse(&p["limits"])?))
    }).and_then(|exceeded|if exceeded {Err("提供方Token已达到冻结资源门；已保存用量并停止后续执行，旧成果保留".into())} else {Ok(())})
}

#[cfg(test)]
mod tests;

/// Only the already-admitted analysis Run may enter its native operation.
/// A fully reserved Work can have no capacity for another Run without losing
/// permission to spend this Run's own reservation. Standalone drafts stay denied.
pub(in crate::agent_work) fn check_active_reservation_on(
    c: &Connection,
    w: &Work,
) -> Result<(), String> {
    let Some(p) = policy(c, &w.id)? else {
        return Ok(());
    };
    let current = load(c, &w.id)?;
    let run = w
        .active_run
        .as_deref()
        .ok_or("分析入口缺少当前运行和持久预算预留")?;
    if current.state != "investigating"
        || current.active_run != w.active_run
        || current.revision != w.revision
        || current.authorization_version != w.authorization_version
        || p["rootWorkId"] != w.id
    {
        return Err("分析运行身份或授权已变化，未启动模型".into());
    }
    let reservations = facts(c, &w.id, "providerBudgetReservation")?;
    let matching = reservations
        .iter()
        .filter(|v| v["runId"] == run)
        .collect::<Vec<_>>();
    if matching.len() != 1
        || matching[0]["schemaVersion"] != 1
        || matching[0]["reserved"] != p["perRun"]
    {
        return Err("分析入口缺少匹配的持久预算预留，未启动模型".into());
    }
    if facts(c, &w.id, "providerBudgetSettlement")?
        .iter()
        .any(|v| v["runId"] == run)
        || facts(c, &w.id, "providerBudgetObservation")?
            .iter()
            .any(|v| v["runId"] == run && v["exceeded"] == true)
        || !state(c, &w.id, &p)?.0.fits(parse(&p["limits"])?)
    {
        return Err("当前分析的资源额度已耗尽或结算，未启动模型".into());
    }
    Ok(())
}

/// Preflight may prepare context but cannot start a provider or release an old reservation.
pub(in crate::agent_work) fn check_pending_admission_on(
    c: &Connection,
    w: &Work,
) -> Result<(), String> {
    let current = load(c, &w.id)?;
    if current.state != "investigating"
        || current.active_run != w.active_run
        || w.active_run.is_none()
        || current.revision != w.revision
        || current.authorization_version != w.authorization_version
    {
        return Err("预检运行身份或授权已变化".into());
    }
    let run = w.active_run.as_deref().unwrap();
    if facts(c, &w.id, "providerBudgetReservation")?
        .iter()
        .any(|v| v["runId"] == run)
    {
        return check_active_reservation_on(c, w);
    }
    let view = view_on(c, w)?;
    if view["state"] != "unconfigured" && view["canAdmitRun"] != true {
        return Err("提供方剩余额度不足，未启动模型，旧未知用量保留".into());
    }
    Ok(())
}
pub(in crate::agent_work) fn admit_after_preflight(
    root: &Path,
    w: &Work,
    run: &str,
) -> Result<(), String> {
    write(root, |c| {
        check_pending_admission_on(c, w)?;
        reserve_on(c, w, run)?;
        check_active_reservation_on(c, w)
    })
}

#[cfg(test)]
mod cn06;
