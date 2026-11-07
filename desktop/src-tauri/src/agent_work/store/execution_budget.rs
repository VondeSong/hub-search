//! Host execution quota belongs to the Work. Provider tokens/fees are separate
//! observations: an absent receipt never becomes a measured zero here.
use super::*;
use std::collections::BTreeMap;

type Counters = BTreeMap<String, u64>;

fn planned(value: &Value) -> Result<Counters, String> {
    let n = |key: &str| {
        value[key]
            .as_u64()
            .ok_or("执行预算字段不可核对".to_string())
    };
    Ok([
        (
            "modelCalls",
            n("modelCalls")?
                .saturating_add(n("outputRepairCalls")?)
                .saturating_add(1),
        ),
        ("modelRetries", 1),
        ("outputRepairs", n("outputRepairCalls")?),
        // The native owner permits one initial turn and one late-command turn.
        ("agentSessions", 2),
        ("toolSteps", n("toolSteps")?),
        ("requestBytes", n("requestBytes")?),
        ("bodyChars", n("bodyChars")?),
        ("entitiesRead", n("entities")?),
        ("summaries", n("summaries")?),
        ("elapsedMs", n("seconds")?.saturating_mul(1000)),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect())
}

fn ceiling() -> Counters {
    // No larger than the existing maximum of twenty deep-mode runs. Persist
    // this policy once; a later mode, restart or app version cannot enlarge it.
    planned(&json!(super::super::assistant::budget("deep").unwrap()))
        .unwrap()
        .into_iter()
        .map(|(k, v)| (k, v.saturating_mul(20)))
        .collect()
}

fn facts(c: &Connection, work: &str, kind: &str) -> Result<Vec<Value>, String> {
    let mut q = c
        .prepare("SELECT body_json FROM agent_records WHERE work_id=?1 AND kind=?2 ORDER BY rowid")
        .map_err(|e| e.to_string())?;
    let result = q
        .query_map(params![work, kind], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .map(|r| {
            serde_json::from_str(&r.map_err(|e| e.to_string())?)
                .map_err(|_| "执行预算记录损坏".into())
        })
        .collect();
    result
}

fn legacy(c: &Connection, work: &str, exclude: Option<&str>) -> Result<Vec<Value>, String> {
    let fallback = planned(&json!(super::super::assistant::budget("deep")?))?;
    let mut q=c.prepare("SELECT u.id,u.usage_json,(SELECT r.body_json FROM agent_records r WHERE r.run_id=u.id AND r.kind='budget' ORDER BY r.rowid LIMIT 1) FROM agent_runs u WHERE u.work_id=?1 ORDER BY u.rowid").map_err(|e|e.to_string())?;
    let mut result = Vec::new();
    for row in q
        .query_map([work], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?
    {
        let (run, usage, old) = row.map_err(|e| e.to_string())?;
        if Some(run.as_str()) == exclude {
            continue;
        }
        let mut charged = old
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| planned(&v).ok())
            .unwrap_or_else(|| fallback.clone());
        // Old usage may be an intermediate checkpoint. Keep the full saved
        // reservation and any higher known observation, never only the latter.
        let observed: Value = serde_json::from_str(&usage).map_err(|_| "旧运行用量损坏")?;
        for (key, number) in &mut charged {
            *number = (*number).max(observed[key].as_u64().unwrap_or(0));
        }
        result.push(json!({"runId":run,"reserved":charged,"legacy":true,"reason":"no durable final host settlement; conservative reservation retained"}));
    }
    Ok(result)
}

struct State {
    limits: Counters,
    allocations: Vec<Value>,
    settlements: Vec<Value>,
    charged: Counters,
}
fn state_on(c: &Connection, work: &str, exclude: Option<&str>) -> Result<State, String> {
    let policies = facts(c, work, "executionBudgetPolicy")?;
    if policies.len() > 1 {
        return Err("执行预算根存在冲突".into());
    }
    let (limits, mut allocations) = if let Some(p) = policies.first() {
        if p["schemaVersion"] != 1 || p["rootWorkId"] != work {
            return Err("执行预算版本或事项身份不可用".into());
        }
        (
            serde_json::from_value::<Counters>(p["limits"].clone())
                .map_err(|_| "执行预算上限损坏")?,
            p["legacyReservations"]
                .as_array()
                .ok_or("旧预算预留损坏")?
                .clone(),
        )
    } else {
        (ceiling(), legacy(c, work, exclude)?)
    };
    allocations.extend(facts(c, work, "executionBudgetReservation")?);
    let settlements = facts(c, work, "executionBudgetSettlement")?;
    let mut charged = Counters::new();
    let mut seen = std::collections::HashSet::new();
    for a in &allocations {
        let run = a["runId"].as_str().ok_or("预算尝试身份损坏")?;
        if !seen.insert(run) {
            return Err("预算尝试存在重复预留".into());
        }
        let settled: Vec<_> = settlements.iter().filter(|s| s["runId"] == run).collect();
        if settled.len() > 1 {
            return Err("预算尝试存在重复结算".into());
        }
        let counters = settled
            .first()
            .map(|s| &s["charged"])
            .unwrap_or(&a["reserved"]);
        let values: Counters =
            serde_json::from_value(counters.clone()).map_err(|_| "预算计量损坏")?;
        if limits.keys().any(|k| !values.contains_key(k)) {
            return Err("执行预算维度不完整".into());
        }
        for (k, v) in values {
            let total = charged.entry(k).or_default();
            *total = total.saturating_add(v);
        }
    }
    Ok(State {
        limits,
        allocations,
        settlements,
        charged,
    })
}

fn admits(state: &State, desired: &Counters) -> bool {
    desired.iter().all(|(k, v)| {
        state
            .charged
            .get(k)
            .copied()
            .unwrap_or(0)
            .saturating_add(*v)
            <= state.limits.get(k).copied().unwrap_or(0)
    })
}

pub(in crate::agent_work) fn reserve_on(
    c: &Connection,
    w: &Work,
    run: &str,
    budget: Budget,
) -> Result<(), String> {
    super::trace_budget::initialize_on(c, w)?;
    if super::material_budget::load_on(c, &w.id)?.is_some() {
        super::provider_budget::check_pending_admission_on(c, w)?;
    } else {
        super::provider_budget::reserve_on(c, w, run)?;
    }
    let desired = planned(&json!(budget))?;
    let existing = facts(c, &w.id, "executionBudgetReservation")?;
    if let Some(old) = existing.iter().find(|v| v["runId"] == run) {
        return if old["reserved"] == json!(desired) {
            Ok(())
        } else {
            Err("执行预算尝试身份已用于不同上限".into())
        };
    }
    if w.active_run.as_deref() != Some(run) {
        return Err("只能为当前运行预留执行预算".into());
    }
    let state = state_on(c, &w.id, Some(run))?;
    if !admits(&state, &desired) {
        return Err("本事项累计执行预算不足；历史和待核对结果仍可查看，不会启动新分析".into());
    }
    if facts(c, &w.id, "executionBudgetPolicy")?.is_empty() {
        insert(
            c,
            &w.id,
            None,
            "executionBudgetPolicy",
            &json!({"schemaVersion":1,"rootWorkId":w.id,"origin":"existingTwentyDeepRunCeiling","limits":state.limits,"legacyReservations":state.allocations,"providerTokensOrFeesBounded":false}),
        )?;
    }
    insert(
        c,
        &w.id,
        None,
        "executionBudgetReservation",
        &json!({"schemaVersion":1,"runId":run,"reserved":desired,"createdAt":stamp()}),
    )
}

pub(in crate::agent_work) fn settle(
    root: &Path,
    w: &Work,
    run: &str,
    usage: &Value,
) -> Result<(), String> {
    write(root, |c| {
        if facts(c, &w.id, "executionBudgetReservation")?.is_empty() {
            return Ok(());
        }
        let state = state_on(c, &w.id, None)?;
        let Some(allocation) = state
            .allocations
            .iter()
            .find(|a| a["runId"] == run && a["legacy"] != true)
        else {
            return Ok(());
        };
        let reserved: Counters = serde_json::from_value(allocation["reserved"].clone())
            .map_err(|_| "执行预算预留损坏")?;
        let mut actual = Counters::new();
        for key in reserved.keys() {
            let number = if key == "agentSessions" && usage.get(key).is_none() {
                0
            } else {
                usage[key]
                    .as_u64()
                    .ok_or("最终宿主用量不完整，执行预留继续保留")?
            };
            actual.insert(key.clone(), number);
        }
        if let Some(old) = state.settlements.iter().find(|s| s["runId"] == run) {
            return if old["charged"] == json!(actual) {
                Ok(())
            } else {
                Err("执行预算已结算，不能改写旧用量".into())
            };
        }
        let overrun = actual
            .iter()
            .any(|(k, v)| *v > reserved.get(k).copied().unwrap_or(0));
        c.execute(
            "UPDATE agent_runs SET usage_json=?2 WHERE id=?1 AND work_id=?3",
            params![run, encode(usage)?, w.id],
        )
        .map_err(|e| e.to_string())?;
        insert(
            c,
            &w.id,
            None,
            "executionBudgetSettlement",
            &json!({"schemaVersion":1,"runId":run,"charged":actual,"reservationOverrun":overrun,"providerTokensOrFeesBounded":false,"settledAt":stamp()}),
        )
    })
}

// A saved-report publication has no provider call. Charge its bounded host work
// without changing any original Run reservation or settlement.
pub(super) fn reserve_delivery_on(c: &Connection, w: &Work, run: &str) -> Result<(), String> {
    let key = format!("accepted-report:{run}");
    let state = state_on(c, &w.id, None)?;
    if state.allocations.iter().any(|a| a["runId"] == key) {
        return Err("本报告的恢复尝试已使用；保留结果，不自动重复核验".into());
    }
    let mut desired: Counters = state.limits.keys().map(|k| (k.clone(), 0)).collect();
    desired.insert("elapsedMs".into(), 30_000);
    desired.insert("bodyChars".into(), 262_144);
    if !admits(&state, &desired) {
        return Err("同事项宿主恢复预算不足，未发布报告".into());
    }
    trace_budget::initialize_on(c, w)?;
    if facts(c, &w.id, "executionBudgetPolicy")?.is_empty() {
        insert(
            c,
            &w.id,
            None,
            "executionBudgetPolicy",
            &json!({"schemaVersion":1,"rootWorkId":w.id,"origin":"existingTwentyDeepRunCeiling","limits":state.limits,"legacyReservations":state.allocations,"providerTokensOrFeesBounded":false}),
        )?;
    }
    insert(
        c,
        &w.id,
        None,
        "executionBudgetReservation",
        &json!({"schemaVersion":1,"runId":key,"reserved":desired,"createdAt":stamp(),"scope":"savedReportVerificationOnly","originRunId":run}),
    )
}

pub(in crate::agent_work) fn view_on(c: &Connection, w: &Work) -> Result<Value, String> {
    let state = state_on(c, &w.id, None)?;
    // Advisory projection uses the exact reservation arithmetic and public mode
    // budgets. The transaction in reserve_on remains the authoritative gate.
    let mut modes = serde_json::Map::new();
    let plan = super::material_budget::load_on(c, &w.id)?;
    for mode in ["quick", "deep"] {
        let admitted = match super::super::assistant::budget_for_plan(mode, plan.as_ref()) {
            Ok(budget) => admits(&state, &planned(&json!(budget))?),
            Err(_) => false,
        };
        modes.insert(mode.into(), json!(admitted));
    }
    let remaining: Counters = state
        .limits
        .iter()
        .map(|(k, v)| {
            (
                k.clone(),
                v.saturating_sub(state.charged.get(k).copied().unwrap_or(0)),
            )
        })
        .collect();
    let unsettled: Vec<_> = state
        .allocations
        .iter()
        .filter(|a| !state.settlements.iter().any(|s| s["runId"] == a["runId"]))
        .map(|a| a["runId"].clone())
        .collect();
    Ok(
        json!({"schemaVersion":1,"rootWorkId":w.id,"limits":state.limits,"chargedOrReserved":state.charged,"remaining":remaining,
        "unsettledRunIds":unsettled,"canAdmitModes":modes,"providerTokensOrFeesBounded":false,"scope":"host execution counters; provider token/fee usage and recovery quota are separate",
        "exhausted":state.limits.iter().any(|(key,limit)|*limit>0 && remaining.get(key)==Some(&0))}),
    )
}

#[cfg(test)]
mod tests;
