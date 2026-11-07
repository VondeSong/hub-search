//! Direct text analysis shares the existing Work reservation; no separate budget root.
use super::*;
use sha2::Digest;

pub(in crate::agent_work) const SCOPE: &str = "nativeAndDeepSeekAnalysisV1";
pub(in crate::agent_work) fn enabled_on(c: &Connection, w: &Work) -> Result<bool, String> {
    Ok(policy(c, &w.id)?.is_some_and(|p| p["scope"] == SCOPE))
}
pub(in crate::agent_work) fn enabled(root: &Path, w: &Work) -> Result<bool, String> {
    enabled_on(&read(root)?, w)
}
fn active(c: &Connection, w: &Work, run: &str) -> Result<Value, String> {
    if !enabled_on(c, w)?
        || w.active_run.as_deref() != Some(run)
        || super::super::material_budget::load_on(c, &w.id)?.is_some()
    {
        return Err("当前冻结合同不支持直连分析或原生材料计划，未发送请求".into());
    }
    check_active_reservation_on(c, w)?;
    policy(c, &w.id)?.ok_or("缺少直连分析预算".into())
}
struct Ledger {
    charged: Tokens,
    observed: Tokens,
    complete: bool,
    invalid_or_exceeded: bool,
    request_bytes: usize,
}
fn ledger(c: &Connection, w: &Work, run: &str) -> Result<Ledger, String> {
    let calls: Vec<Value> = facts(c, &w.id, "providerCallBudget")?
        .into_iter()
        .filter(|v| v["runId"] == run)
        .collect();
    let receipts = facts(c, &w.id, "modelExecution")?;
    let mut result = Ledger {
        charged: Tokens::default(),
        observed: Tokens::default(),
        complete: !calls.is_empty(),
        invalid_or_exceeded: false,
        request_bytes: 0,
    };
    let mut ids = std::collections::HashSet::new();
    for call in calls {
        let id = call["callId"].as_str().ok_or("直连请求身份缺失")?;
        if call["schemaVersion"] != 1 || !ids.insert(id.to_string()) {
            return Err("直连请求身份重复或版本不匹配".into());
        }
        let reserved = parse(&call["reserved"])?;
        result.request_bytes = result.request_bytes.saturating_add(
            call["requestBytes"]
                .as_u64()
                .ok_or("直连请求字节计量缺失")? as usize,
        );
        let matches: Vec<_> = receipts
            .iter()
            .filter(|v| v["budgetCallId"] == id)
            .collect();
        if matches.len() > 1 {
            return Err("直连请求出现重复用量回执，保留预留".into());
        }
        let mut complete = false;
        let mut observed = Tokens::default();
        if let Some(receipt) = matches.first() {
            if receipt["provider"] != "deepseek" || receipt["budgetRunId"] != run {
                return Err("直连用量回执归属不匹配".into());
            }
            observed = Tokens {
                input_tokens: receipt["inputTokens"].as_u64().unwrap_or(0),
                uncached_input_tokens: receipt["uncachedInputTokens"].as_u64().unwrap_or(0),
                output_tokens: receipt["outputTokens"].as_u64().unwrap_or(0),
            };
            let consistent = match (
                receipt["inputTokens"].as_u64(),
                receipt["outputTokens"].as_u64(),
                receipt["cachedInputTokens"].as_u64(),
                receipt["uncachedInputTokens"].as_u64(),
            ) {
                (Some(input), Some(output), Some(hit), Some(miss)) => {
                    let valid = hit.checked_add(miss) == Some(input)
                        && receipt["totalTokens"]
                            .as_u64()
                            .is_none_or(|t| input.checked_add(output) == Some(t));
                    result.invalid_or_exceeded |= !valid;
                    valid
                }
                _ => false,
            };
            complete = receipt["usageComplete"] == true && consistent;
            result.invalid_or_exceeded |= !observed.fits(reserved);
        }
        result.complete &= complete;
        result.observed = result.observed.add(observed);
        result.charged = result.charged.add(if complete {
            observed
        } else {
            reserved.max(observed)
        });
    }
    Ok(result)
}
pub(in crate::agent_work) struct Progress {
    pub usage: Value,
    pub complete: bool,
    pub invalid_or_exceeded: bool,
    pub request_bytes: usize,
}
pub(in crate::agent_work) fn progress(
    root: &Path,
    w: &Work,
    run: &str,
) -> Result<Progress, String> {
    let l = ledger(&read(root)?, w, run)?;
    Ok(Progress {
        usage: json!({"inputTokens":l.observed.input_tokens,
        "uncachedInputTokens":if l.complete {json!(l.observed.uncached_input_tokens)} else {Value::Null},
        "outputTokens":l.observed.output_tokens,"usageCompleteness":if l.complete {"recorded"} else {"incomplete"},
        "knownLowerBounds":json!({"inputTokens":l.observed.input_tokens,"uncachedInputTokens":l.observed.uncached_input_tokens,"outputTokens":l.observed.output_tokens})}),
        complete: l.complete,
        invalid_or_exceeded: l.invalid_or_exceeded,
        request_bytes: l.request_bytes,
    })
}

// Output failure does not make a complete provider usage receipt unknown.
pub(in crate::agent_work) fn settle_terminal(
    root: &Path,
    w: &Work,
    run: &str,
) -> Result<(), String> {
    if !enabled(root, w)? {
        return Ok(());
    }
    let p = progress(root, w, run)?;
    super::observe(root, w, run, &p.usage, p.complete && !p.invalid_or_exceeded)
}

// Reconcile old failed direct Runs before a new admission, using saved receipts only.
pub(in crate::agent_work) fn reconcile_terminal(root: &Path, id: &str) -> Result<(), String> {
    let c = read(root)?;
    let w = load(&c, id)?;
    if !enabled_on(&c, &w)? {
        return Ok(());
    }
    let mut q=c.prepare("SELECT id FROM agent_runs WHERE work_id=?1 AND state='failed' AND NOT EXISTS(SELECT 1 FROM agent_records r WHERE r.work_id=?1 AND r.kind='providerBudgetSettlement' AND json_extract(r.body_json,'$.runId')=agent_runs.id)").map_err(|e|e.to_string())?;
    let runs = q
        .query_map([id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(q);
    drop(c);
    for run in runs {
        let p = progress(root, &w, &run)?;
        if p.complete && !p.invalid_or_exceeded {
            super::observe(root, &w, &run, &p.usage, true)?;
        }
    }
    Ok(())
}
pub(in crate::agent_work) fn output_remaining(
    root: &Path,
    w: &Work,
    run: &str,
) -> Result<u64, String> {
    let c = read(root)?;
    let p = active(&c, w, run)?;
    let l = ledger(&c, w, run)?;
    if l.invalid_or_exceeded {
        return Err("直连用量无效或已超请求预留，未发送后续请求".into());
    }
    let remaining = parse(&p["perRun"])?
        .output_tokens
        .saturating_sub(l.charged.output_tokens)
        .min(8192);
    if remaining == 0 {
        return Err("本轮输出额度不足，旧未知用量保留，未发送后续请求".into());
    }
    Ok(remaining)
}
pub(in crate::agent_work) fn reserve(
    root: &Path,
    w: &Work,
    run: &str,
    call: &str,
    body: &Value,
    request_limit: usize,
) -> Result<(), String> {
    let bytes = serde_json::to_vec(body).map_err(|_| "无法计量直连请求")?;
    let output = body["max_tokens"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= 8192)
        .ok_or("缺少有界输出上限")?;
    if body["stream"] != false
        || !body["messages"][1]["content"].is_string()
        || bytes.len() > 196_608
    {
        return Err("本次直连文本合同不覆盖该载荷或图片，未发送请求".into());
    }
    let reserved = Tokens {
        input_tokens: bytes.len() as u64,
        uncached_input_tokens: bytes.len() as u64,
        output_tokens: output,
    };
    write(root, |c| {
        let p = active(c, w, run)?;
        if facts(c, &w.id, "providerCallBudget")?
            .iter()
            .any(|v| v["callId"] == call)
        {
            return Err("直连请求身份已经使用，不能再次发送".into());
        }
        let l = ledger(c, w, run)?;
        if l.invalid_or_exceeded
            || !l.charged.add(reserved).fits(parse(&p["perRun"])?)
            || l.request_bytes.saturating_add(bytes.len()) > request_limit
        {
            return Err("直连请求预计无法装入本轮剩余额度，未发送请求，旧预留与成果保留".into());
        }
        insert(
            c,
            &w.id,
            None,
            "providerCallBudget",
            &json!({"schemaVersion":1,"runId":run,
            "callId":call,"workRevision":w.revision,"authorizationVersion":w.authorization_version,
            "provider":"deepseek","model":body["model"],"requestBytes":bytes.len(),
            "requestSha256":format!("{:x}",sha2::Sha256::digest(&bytes)),"reserved":reserved,
            "basis":"actual serialized text JSON bytes as conservative token estimate plus provider output cap; not an absolute provider billing guarantee"}),
        )
    })
}

// A stopped Run may receive accounting facts, never new execution eligibility.
pub(in crate::agent_work) fn receipt(
    root: &Path,
    w: &Work,
    run: &str,
    call: &str,
    value: &Value,
) -> Result<(), String> {
    write(root, |c| {
        let owner: String = c
            .query_row("SELECT work_id FROM agent_runs WHERE id=?1", [run], |r| {
                r.get(0)
            })
            .map_err(|_| "用量回执运行缺失")?;
        if owner != w.id
            || !facts(c, &w.id, "providerCallBudget")?
                .iter()
                .any(|v| v["callId"] == call && v["runId"] == run)
        {
            return Err("用量回执没有对应的持久请求准入".into());
        }
        if facts(c, &w.id, "modelExecution")?
            .iter()
            .any(|v| v["budgetCallId"] == call)
        {
            return Err("同一请求的用量回执已保存，不能重复累计".into());
        }
        let mut raw = value.clone();
        raw["budgetCallId"] = json!(call);
        raw["budgetRunId"] = json!(run);
        insert(c, &w.id, Some(run), "modelExecution", &raw)
    })
}

#[cfg(test)]
mod tests;
