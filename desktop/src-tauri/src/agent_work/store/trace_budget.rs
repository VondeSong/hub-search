//! Serialized SQLite payload quota, not a physical disk-space guarantee.
//! Same-Work managed runs use measured bytes rather than a run-count reset.
use super::*;
const DATA_BYTES: i64 = 20 * 1_048_576;
const CONTROL_BYTES: i64 = 262_144;
const RUN_RESERVATION: i64 = 1_048_576;

fn policy(c: &Connection, id: &str) -> Result<Option<Value>, String> {
    let mut q = c
        .prepare(
            "SELECT body_json FROM agent_records WHERE work_id=?1 AND kind='traceResourcePolicy'",
        )
        .map_err(|e| e.to_string())?;
    let values = q
        .query_map([id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    if values.len() > 1 {
        return Err("记录资源策略冲突".into());
    }
    let Some(raw) = values.first() else {
        return Ok(None);
    };
    let p: Value = serde_json::from_str(raw).map_err(|_| "记录资源策略损坏")?;
    if p["schemaVersion"] != 1
        || p["rootWorkId"] != id
        || p["dataBytes"] != DATA_BYTES
        || p["controlBytes"] != CONTROL_BYTES
        || p["runReservationBytes"] != RUN_RESERVATION
    {
        return Err("记录资源策略版本或上限不可用".into());
    }
    Ok(Some(p))
}
fn used(c: &Connection, id: &str) -> Result<i64, String> {
    c.query_row("SELECT (SELECT COALESCE(SUM(length(CAST(body_json AS BLOB))),0) FROM agent_records WHERE work_id=?1)+(SELECT COALESCE(SUM(length(CAST(usage_json AS BLOB))),0) FROM agent_runs WHERE work_id=?1)+(SELECT COALESCE(length(CAST(report_json AS BLOB)),0) FROM agent_works WHERE id=?1)",[id],|r|r.get(0)).map_err(|e|e.to_string())
}

pub(in crate::agent_work) fn managed_on(c: &Connection, id: &str) -> Result<bool, String> {
    if policy(c, id)?.is_none() {
        return Ok(false);
    }
    c.query_row("SELECT EXISTS(SELECT 1 FROM agent_records WHERE work_id=?1 AND kind='executionBudgetPolicy')",[id],|r|r.get(0)).map_err(|e|e.to_string())
}
pub(in crate::agent_work) fn initialize_on(c: &Connection, w: &Work) -> Result<(), String> {
    if policy(c, &w.id)?.is_some() {
        return Ok(());
    }
    insert(
        c,
        &w.id,
        None,
        "traceResourcePolicy",
        &json!({"schemaVersion":1,"rootWorkId":w.id,"dataBytes":DATA_BYTES,"controlBytes":CONTROL_BYTES,"runReservationBytes":RUN_RESERVATION,"origin":"existing twenty assistant Run serialized ceilings; saved actual native Run 93578 bytes","physicalDiskGuarantee":false}),
    )
}
pub(in crate::agent_work) fn admission_on(
    c: &Connection,
    id: &str,
    count: i64,
) -> Result<(), String> {
    if policy(c, id)?.is_none() {
        return if count < 20 {
            Ok(())
        } else {
            Err(
                "旧事项已达20次运行保护上限；历史保留，需先核验资源与累计预算，不能新建事项绕过"
                    .into(),
            )
        };
    }
    // A trace policy never authorizes a run on its own. The existing host
    // reservation must also be in the same claim/resume transaction.
    let managed:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_records WHERE work_id=?1 AND kind='executionBudgetPolicy')",[id],|r|r.get(0)).map_err(|e|e.to_string())?;
    if !managed {
        return Err("连续运行缺少累计执行预算根".into());
    }
    if used(c, id)?.saturating_add(RUN_RESERVATION) > DATA_BYTES {
        return Err("本事项记录资源不足，已停止新分析；旧成果和恢复信息保留".into());
    }
    Ok(())
}
pub(in crate::agent_work) fn insert_on(
    c: &Connection,
    id: &str,
    kind: &str,
    bytes: usize,
) -> Result<(), String> {
    if policy(c, id)?.is_none() {
        return Ok(());
    }
    let control = kind.starts_with("executionBudget")
        || kind.starts_with("providerBudget")
        || kind.starts_with("recoveryBudget")
        || kind.starts_with("lifecycle")
        || kind == "traceResourcePolicy";
    let ceiling = DATA_BYTES + if control { CONTROL_BYTES } else { 0 };
    if used(c, id)?.saturating_add(bytes as i64) > ceiling {
        return Err("事项记录配额不足；没有保存成功，已有成果和待核对状态保留".into());
    }
    Ok(())
}
pub(in crate::agent_work) fn view_on(
    c: &Connection,
    w: &Work,
    count: i64,
) -> Result<Value, String> {
    if policy(c, &w.id)?.is_none() {
        return Ok(json!({"state":"legacy","canAdmitRun":count<20,"runLimit":20}));
    }
    let size = used(c, &w.id)?;
    Ok(
        json!({"state":"managed","canAdmitRun":admission_on(c,&w.id,count).is_ok(),"runLimit":null,"storedPayloadBytes":size,"dataBytes":DATA_BYTES,"reservedControlBytes":CONTROL_BYTES,"nextRunReservationBytes":RUN_RESERVATION,"physicalDiskGuarantee":false}),
    )
}

pub(in crate::agent_work) fn report_on(
    c: &Connection,
    id: &str,
    bytes: usize,
) -> Result<(), String> {
    if policy(c, id)?.is_none() {
        return Ok(());
    }
    let old: i64 = c
        .query_row(
            "SELECT COALESCE(length(CAST(report_json AS BLOB)),0) FROM agent_works WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if used(c, id)?
        .saturating_sub(old)
        .saturating_add(bytes as i64)
        > DATA_BYTES
    {
        return Err("报告发布记录配额不足；旧交付保留，未发布成功".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests;
