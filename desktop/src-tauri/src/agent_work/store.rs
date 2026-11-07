use super::*;
pub(super) mod accepted_recovery;
pub(super) mod conversation;
pub(super) mod followups;
mod delivery;
mod delivery_read;
pub(super) mod execution_budget;
pub(super) mod goal;
pub(super) mod lifecycle;
pub(super) mod material_budget;
pub(super) mod materials;
pub(super) mod native_compaction;
pub(super) mod native_context;
pub(super) mod native_input;
pub(super) mod provider_budget;
pub(super) mod recovery_budget;
pub(super) mod report_continuation;
pub(super) mod tasks;
pub(super) mod tool_results;
pub(super) mod trace_budget;
pub(super) mod working_state;

pub(crate) fn migrate(c: &Connection) -> Result<(), String> {
    let result = (|| {
        c.execute_batch("SAVEPOINT agent_work_schema;
        CREATE TABLE IF NOT EXISTS agent_works (
            id TEXT PRIMARY KEY, goal TEXT NOT NULL, success_criteria TEXT NOT NULL,
            anchor_json TEXT NOT NULL, grant_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
            authorization_version INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL,
            active_run TEXT, report_json TEXT, updated_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS agent_works_anchor ON agent_works(anchor_json,updated_at);
        CREATE INDEX IF NOT EXISTS agent_works_recent ON agent_works(updated_at DESC,id);
        CREATE TABLE IF NOT EXISTS agent_runs (
            id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES agent_works(id),
            base_revision INTEGER NOT NULL, authorization_version INTEGER NOT NULL,
            state TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, error TEXT,
            usage_json TEXT NOT NULL DEFAULT '{}');
        CREATE INDEX IF NOT EXISTS agent_runs_work ON agent_runs(work_id,started_at);
        CREATE TABLE IF NOT EXISTS agent_records (
            id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES agent_works(id),
            run_id TEXT REFERENCES agent_runs(id), kind TEXT NOT NULL, body_json TEXT NOT NULL,
            created_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS agent_records_work ON agent_records(work_id,created_at);
        CREATE INDEX IF NOT EXISTS agent_records_run ON agent_records(run_id,kind);")?;
        super::actions::migrate(c)?;
        super::watch::migrate(c)?;
        // A retry may encounter already installed compatible tables. Do not let
        // IF NOT EXISTS silently accept a partial or unrelated table shape.
        super::topics::migrate(c)?;
        super::skills::migrate(c)?;
        for (table,columns) in [
        ("agent_works","id,goal,success_criteria,anchor_json,grant_json,revision,authorization_version,state,active_run,report_json,updated_at"),
        ("agent_runs","id,work_id,base_revision,authorization_version,state,started_at,finished_at,error,usage_json"),
        ("agent_records","id,work_id,run_id,kind,body_json,created_at"),
    ] {
        c.prepare(&format!("SELECT {columns} FROM {table} LIMIT 0"))?;
        let pk:String=c.query_row("SELECT COALESCE(group_concat(name,','),'') FROM pragma_table_info(?1) WHERE pk>0",[table],|r|r.get(0))?;
        if pk!="id" {return Err(rusqlite::Error::InvalidQuery);}
    }
        // The database owner advances the global schema only after every
        // feature migration succeeds. Retrying this owner must not downgrade it.
        c.execute_batch("RELEASE agent_work_schema;")
    })();
    result.map_err(|e| {
        let _ = c.execute_batch("ROLLBACK TO agent_work_schema; RELEASE agent_work_schema;");
        format!("调查记录迁移失败：{e}")
    })
}

pub(super) fn write<T>(
    root: &Path,
    apply: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    let (c, _writer) = crate::database::open_write_database(&root.join("craft-search.sqlite3"))?;
    let permit = crate::library_runtime::cached_read_permit(root)?;
    c.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| e.to_string())?;
    let result = apply(&c)?;
    permit.commit(|| c.execute_batch("COMMIT").map_err(|e| e.to_string()))?;
    Ok(result)
}
fn read(root: &Path) -> Result<Connection, String> {
    crate::source_evidence::open_read_database(root)
}
pub(super) fn review_trigger(root: &Path, run: &str) -> Result<Option<Value>, String> {
    let c = read(root)?;
    let raw:Option<String>=c.query_row("SELECT body_json FROM agent_records WHERE run_id=?1 AND kind='conditionTrigger' LIMIT 1",[run],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    raw.map(|raw| {
        if raw.len() > 4096 {
            return Err("复查触发记录过大".into());
        }
        let v: Value = serde_json::from_str(&raw).map_err(|_| "复查触发记录损坏")?;
        if v["readOnly"] != true || v["scope"] != "knownDependenciesOnly" {
            return Err("复查触发记录无效".into());
        }
        Ok(v)
    })
    .transpose()
}
fn encode(v: &impl Serialize) -> Result<String, String> {
    serde_json::to_string(v).map_err(|e| e.to_string())
}
pub(super) fn stamp() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
pub(super) fn load(c: &Connection, id: &str) -> Result<Work, String> {
    let raw = c.query_row("SELECT id,goal,success_criteria,anchor_json,grant_json,revision,authorization_version,state,active_run,report_json,updated_at FROM agent_works WHERE id=?1",[id],|r|Ok((
        r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,i64>(5)?,r.get::<_,i64>(6)?,r.get::<_,String>(7)?,r.get::<_,Option<String>>(8)?,r.get::<_,Option<String>>(9)?,r.get::<_,i64>(10)?
    ))).optional().map_err(|e|e.to_string())?.ok_or("调查不存在")?;
    let (action_target, action_target_identity) = if raw.3 == "null" {
        super::action_target::load_on(c, id, raw.6)?
    } else {
        (None, None)
    };
    Ok(Work {
        action_target,
        action_target_identity,
        id: raw.0,
        goal: raw.1,
        success_criteria: raw.2,
        anchor: serde_json::from_str(&raw.3).map_err(|_| "调查对象记录损坏")?,
        grant: serde_json::from_str(&raw.4).map_err(|_| "调查授权记录损坏")?,
        revision: raw.5,
        authorization_version: raw.6,
        state: raw.7,
        active_run: raw.8,
        report: raw
            .9
            .map(|s| serde_json::from_str(&s))
            .transpose()
            .map_err(|_| "调查结果记录损坏")?,
        updated_at: raw.10,
    })
}
pub(super) fn create(
    root: &Path,
    goal: String,
    success: String,
    anchor: impl Into<Option<EvidenceLocator>>,
    grant: Grant,
) -> Result<String, String> {
    write(root, |c| create_on(c, goal, success, anchor, grant))
}
// Topic creation uses the same insert inside its existing atomic transaction.
pub(super) fn create_on(
    c: &Connection,
    goal: String,
    success: String,
    anchor: impl Into<Option<EvidenceLocator>>,
    grant: Grant,
) -> Result<String, String> {
    let anchor = anchor.into();
    let id = format!("work-{}", crate::random_url_safe(18));
    let created_at = stamp();
    c.execute("INSERT INTO agent_works(id,goal,success_criteria,anchor_json,grant_json,state,updated_at) VALUES(?1,?2,?3,?4,?5,'ready',?6)",params![id,goal,success,encode(&anchor)?,encode(&grant)?,created_at]).map_err(|e|e.to_string())?;
    insert(c, &id, None, "conversationCreated", &json!({"createdAt":created_at}))?;
    Ok(id)
}
pub(super) fn list(
    root: &Path,
    anchor: Option<&EvidenceLocator>,
    before: Option<&Value>,
) -> Result<Value, String> {
    let scope = serde_json::to_value(anchor).map_err(|e| e.to_string())?;
    let cursor = before
        .filter(|value| !value.is_null())
        .map(|value| {
            let time = value["updatedAt"]
                .as_i64()
                .filter(|time| *time >= 0)
                .ok_or("历史对话游标无效")?;
            let id = value["id"]
                .as_str()
                .filter(|id| !id.is_empty() && id.len() <= 150)
                .ok_or("历史对话游标无效")?;
            if value.get("anchor") != Some(&scope) {
                return Err("历史对话范围已变化，请重新打开历史".to_string());
            }
            let pinned = value
                .get("pinned")
                .map(|v| v.as_bool().ok_or("历史对话游标无效"))
                .transpose()?
                .unwrap_or(false);
            Ok((time, id, pinned))
        })
        .transpose()?;
    let c = read(root)?;
    let mut q=c.prepare("WITH history AS (SELECT agent_works.*,COALESCE((SELECT body_json FROM agent_records p WHERE p.work_id=agent_works.id AND p.kind='historyPreference' ORDER BY rowid DESC LIMIT 1),'{}') AS preference FROM agent_works), visible AS (SELECT *,COALESCE(json_extract(preference,'$.pinned'),0) AS pinned FROM history WHERE COALESCE(json_extract(preference,'$.deleted'),0)=0) SELECT id,goal,state,updated_at,1+(SELECT COUNT(*) FROM agent_records r WHERE r.work_id=visible.id AND r.kind IN ('userMessage','userDecision','steering','delivery')),pinned FROM visible WHERE (?1='null' OR anchor_json=?1) AND (?2 IS NULL OR pinned<?4 OR (pinned=?4 AND (updated_at<?2 OR (updated_at=?2 AND id>?3)))) ORDER BY pinned DESC,updated_at DESC,id LIMIT 21").map_err(|e|e.to_string())?;
    let mut rows=q.query_map(params![encode(&anchor)?,cursor.map(|c|c.0),cursor.map(|c|c.1),cursor.map(|c|c.2)],|r|Ok(json!({"id":r.get::<_,String>(0)?,"goal":r.get::<_,String>(1)?,"state":r.get::<_,String>(2)?,"updatedAt":r.get::<_,i64>(3)?,"messageCount":r.get::<_,i64>(4)?,"pinned":r.get::<_,bool>(5)?}))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    let more = rows.len() > 20;
    rows.truncate(20);
    let next = if more {
        rows.last()
            .map(|row| json!({"updatedAt":row["updatedAt"],"id":row["id"],"pinned":row["pinned"],"anchor":scope}))
    } else {
        None
    };
    Ok(json!({"works":rows,"nextCursor":next}))
}
pub(super) fn history_preference(root: &Path, args: &Value) -> Result<Value, String> {
    let id = super::text(args, "id", 150)?;
    let pinned = args
        .get("pinned")
        .map(|v| v.as_bool().ok_or("置顶状态无效"))
        .transpose()?;
    let deleted = args
        .get("deleted")
        .map(|v| v.as_bool().ok_or("删除状态无效"))
        .transpose()?;
    if pinned.is_none() && deleted.is_none() {
        return Err("缺少历史操作".into());
    }
    write(root, |c| {
        let work = load(c, &id)?;
        let old:Option<String>=c.query_row("SELECT body_json FROM agent_records WHERE work_id=?1 AND kind='historyPreference' ORDER BY rowid DESC LIMIT 1",[&id],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        let old: Value = old
            .map(|v| serde_json::from_str(&v).map_err(|_| "历史偏好损坏"))
            .transpose()?
            .unwrap_or(json!({"pinned":false,"deleted":false}));
        let next = json!({"pinned":pinned.unwrap_or(old["pinned"]==true),"deleted":deleted.unwrap_or(old["deleted"]==true)});
        if next == old {
            return Ok(next);
        }
        if deleted == Some(true) {
            let unresolved:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_actions WHERE work_id=?1 AND state IN ('preparing','executing','unknown','reconciliation_required'))",[&id],|r|r.get(0)).map_err(|e|e.to_string())?;
            if work.active_run.is_some() || unresolved {
                return Err("请先结束运行并核对操作结果，再删除对话".into());
            }
            super::watch::pause_on(c, &id, "对话已从历史删除")?;
        }
        // History deletion keeps execution receipts and cumulative quotas intact.
        insert(c, &id, None, "historyPreference", &next)?;
        Ok(next)
    })
}
pub(super) fn reconcile(root: &Path, id: &str, live: Option<&str>) -> Result<(), String> {
    let c = read(root)?;
    let work = load(&c, id)?;
    if let Some(run) = work.active_run.as_deref().filter(|r| Some(*r) != live) {
        if super::ExternalWork::live_on(&c, &work, run)? {
            return Ok(());
        }
        write(root, |c| reconcile_on(c, id, run))?;
    }
    Ok(())
}
pub(super) fn reconcile_on(c: &Connection, id: &str, run: &str) -> Result<(), String> {
    c.execute("UPDATE agent_runs SET state='interrupted',finished_at=?2,error='应用或运行已中断，可以继续' WHERE id=?1 AND state='investigating'",params![run,stamp()]).map_err(|e|e.to_string())?;
    c.execute("UPDATE agent_works SET state='interrupted',active_run=NULL,updated_at=?3 WHERE id=?1 AND active_run=?2",params![id,run,stamp()]).map_err(|e|e.to_string())?;
    Ok(())
}
pub(super) fn claim(root: &Path, id: &str, run: &str) -> Result<Work, String> {
    write(root, |c| claim_on(c, id, run))
}
pub(super) fn claim_with_budget(
    root: &Path,
    id: &str,
    run: &str,
    budget: Budget,
) -> Result<Work, String> {
    claim_with_report(root, id, run, budget, None)
}
pub(super) fn claim_with_report(
    root: &Path,
    id: &str,
    run: &str,
    budget: Budget,
    report: Option<&Value>,
) -> Result<Work, String> {
    write(root, |c| {
        let work = claim_on(c, id, run)?;
        report_continuation::record_on(root, c, &work, run, report)?;
        execution_budget::reserve_on(c, &work, run, budget)?;
        Ok(work)
    })
}
pub(super) fn claim_on(c: &Connection, id: &str, run: &str) -> Result<Work, String> {
    let work = load(c, id)?;
    if work.active_run.is_some() {
        return Err("调查已经运行".into());
    }
    if lifecycle::held(&work.state) {
        return Err("工作已停止，请通过明确恢复入口继续".into());
    }
    if work.state == "revoked" {
        return Err("调查授权已撤回，请重新创建受托事项".into());
    }
    let count: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM agent_runs WHERE work_id=?1",
            [id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    trace_budget::admission_on(c, id, count)?;
    c.execute("INSERT INTO agent_runs(id,work_id,base_revision,authorization_version,state,started_at) VALUES(?1,?2,?3,?4,'investigating',?5)",params![run,id,work.revision,work.authorization_version,stamp()]).map_err(|e|e.to_string())?;
    c.execute("UPDATE agent_works SET state='investigating',active_run=?2,report_json=NULL,updated_at=?3 WHERE id=?1",params![id,run,stamp()]).map_err(|e|e.to_string())?;
    load(c, id)
}
pub(super) fn check_run(root: &Path, work: &Work, run: &str) -> Result<(), String> {
    let current = load(&read(root)?, &work.id)?;
    if current.revision != work.revision
        || current.authorization_version != work.authorization_version
        || current.active_run.as_deref() != Some(run)
    {
        return Err("调查依据或授权已改变".into());
    }
    Ok(())
}
pub(super) fn insert(
    c: &Connection,
    work: &str,
    run: Option<&str>,
    kind: &str,
    body: &Value,
) -> Result<(), String> {
    let encoded = encode(body)?;
    trace_budget::insert_on(c, work, kind, encoded.len())?;
    let record_limit = if matches!(kind, "nativeFinal" | "finishAcceptance" | "delivery") {
        524_288
    } else if kind == "libraryRules" {
        crate::knowledge_rules::MAX_GUIDANCE_BYTES
    } else {
        65_536
    };
    if encoded.len() > record_limit {
        if kind == "libraryRules" {
            return Err(format!(
                "知识库规则记录为 {} 字节，超过 {} 字节上限",
                encoded.len(),
                record_limit
            ));
        }
        return Err("单条调查记录过大".into());
    }
    if let Some(run) = run {
        let (count,bytes):(i64,i64)=c.query_row("SELECT COUNT(*),COALESCE(SUM(length(CAST(body_json AS BLOB))),0) FROM agent_records WHERE run_id=?1",[run],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|e|e.to_string())?;
        let assistant:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_records WHERE run_id=?1 AND kind='agentProtocol')",[run],|r|r.get(0)).map_err(|e|e.to_string())?;
        if count >= if assistant { 256 } else { 64 }
            || bytes + encoded.len() as i64 > if assistant { 1_048_576 } else { 262_144 }
        {
            return Err("本次调查记录预算已用尽".into());
        }
    }
    c.execute("INSERT INTO agent_records(id,work_id,run_id,kind,body_json,created_at) VALUES(?1,?2,?3,?4,?5,?6)",params![crate::random_url_safe(18),work,run,kind,encoded,stamp()]).map_err(|e|e.to_string())?;
    Ok(())
}
pub(super) fn record(root: &Path, run: &str, kind: &str, body: &Value) -> Result<(), String> {
    write(root, |c| {
        let work: String = c
            .query_row(
                "SELECT work_id FROM agent_runs WHERE id=?1 AND state='investigating'",
                [run],
                |r| r.get(0),
            )
            .map_err(|_| "调查已结束")?;
        let current = load(c, &work)?;
        if current.active_run.as_deref() != Some(run) {
            return Err("调查已由新的决定中断".into());
        }
        insert(c, &work, Some(run), kind, body)
    })
}
pub(super) fn stream(
    root: &Path,
    work: &Work,
    run: &str,
    value: &Value,
    control: &Control,
) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    let key = value["id"]
        .as_str()
        .filter(|v| !v.is_empty() && v.len() <= 256)
        .ok_or("过程消息身份无效")?;
    if !matches!(
        value["kind"].as_str(),
        Some("message" | "answer" | "reasoning" | "plan" | "webSearch" | "contextUsage")
    ) || value["text"].as_str().is_none_or(|s| s.len() > 32_768)
    {
        return Err("过程消息超出公开通道合同".into());
    }
    let id = format!("stream-{run}-{:x}", Sha256::digest(key.as_bytes()));
    let raw = encode(value)?;
    write(root, |c| {
        control.check()?;
        let current = load(c, &work.id)?;
        if current.active_run.as_deref() != Some(run)
            || current.authorization_version != work.authorization_version
            || current.revision != work.revision
        {
            return Err("过程消息所属运行已失效".into());
        }
        let old: Option<i64> = c
            .query_row(
                "SELECT length(CAST(body_json AS BLOB)) FROM agent_records WHERE id=?1",
                [&id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let (count,bytes):(i64,i64)=c.query_row("SELECT COUNT(*),COALESCE(SUM(length(CAST(body_json AS BLOB))),0) FROM agent_records WHERE run_id=?1",[run],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|e|e.to_string())?;
        if (old.is_none() && count >= 220) || bytes - old.unwrap_or(0) + raw.len() as i64 > 900_000
        {
            return Err("本轮过程记录预算已用尽".into());
        }
        let updated = current.updated_at.saturating_add(1).max(stamp());
        c.execute("INSERT INTO agent_records(id,work_id,run_id,kind,body_json,created_at) VALUES(?1,?2,?3,'agentStream',?4,?5) ON CONFLICT(id) DO UPDATE SET body_json=excluded.body_json,created_at=excluded.created_at",params![id,work.id,run,raw,updated]).map_err(|e|e.to_string())?;
        c.execute(
            "UPDATE agent_works SET updated_at=?2 WHERE id=?1",
            params![work.id, updated],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
}
pub(super) fn records(
    root: &Path,
    work: &str,
    kind: &str,
    limit: usize,
) -> Result<Vec<Value>, String> {
    let c = read(root)?;
    records_on(&c, work, kind, limit)
}
fn records_on(c: &Connection, work: &str, kind: &str, limit: usize) -> Result<Vec<Value>, String> {
    let mut q=c.prepare("SELECT body_json FROM agent_records WHERE work_id=?1 AND kind=?2 ORDER BY rowid DESC LIMIT ?3").map_err(|e|e.to_string())?;
    let rows = q
        .query_map(params![work, kind, limit.min(64)], |r| {
            r.get::<_, String>(0)
        })
        .map_err(|e| e.to_string())?
        .map(|s| serde_json::from_str(&s.map_err(|e| e.to_string())?).map_err(|e| e.to_string()))
        .collect();
    rows
}
pub(super) fn decision(root: &Path, id: &str, text: &str) -> Result<(), String> {
    write(root, |c| {
        let work = load(c, id)?;
        if work.state == "revoked" {
            return Err("该事项的授权已撤回".into());
        }
        let count: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM agent_records WHERE work_id=?1 AND kind='userDecision'",
                [id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if count >= 32 {
            return Err("已有 32 条用户决定，请新建下一项调查以保留完整上下文".into());
        }
        insert(
            c,
            id,
            None,
            "userDecision",
            &json!({"text":text,"author":"user","revision":work.revision+1,"confirmedAt":stamp()}),
        )?;
        c.execute("UPDATE agent_works SET revision=revision+1,state=CASE WHEN state IN ('paused','cancelled') THEN state ELSE 'interrupted' END,active_run=NULL,report_json=NULL,updated_at=?2 WHERE id=?1",params![id,stamp()]).map_err(|e|e.to_string())?;
        super::watch::pause_on(c, id, "已按新决定暂停自动复查，请重新启用")?;
        Ok(())
    })
}
pub(super) fn revoke(root: &Path, id: &str) -> Result<(), String> {
    write(root, |c| {
        load(c, id)?;
        c.execute("UPDATE agent_works SET revision=revision+1,authorization_version=authorization_version+1,state='revoked',grant_json=?2,report_json=NULL,active_run=NULL,updated_at=?3 WHERE id=?1",params![id,encode(&Grant::default())?,stamp()]).map_err(|e|e.to_string())?;
        super::watch::pause_on(c, id, "来源授权已撤回，自动复查已暂停")?;
        Ok(())
    })
}
pub(super) fn usage(root: &Path, run: &str, usage: &Value) -> Result<(), String> {
    write(root, |c| {
        c.execute(
            "UPDATE agent_runs SET usage_json=?2 WHERE id=?1",
            params![run, encode(usage)?],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
}
pub(super) fn publish(
    root: &Path,
    work: &Work,
    run: &str,
    report: &runner::Report,
    excerpts: &[EvidenceExcerpt],
    candidates: &[(EvidenceLocator, crate::source_evidence::EvidenceVersion)],
    action_receipts: &Value,
    material_reads: &Value,
    control: &Control,
) -> Result<(), String> {
    let reader = work.grant.reader(root)?;
    let publication_started = std::time::Instant::now();
    write(root, |c| {
        publish_on(
            root,
            c,
            work,
            run,
            report,
            excerpts,
            candidates,
            action_receipts,
            material_reads,
            control,
            &reader,
            false,
        )
    })?;
    super::ui_timing::publication(root, &work.id, run, publication_started);
    Ok(())
}

fn publish_on(
    root: &Path,
    c: &Connection,
    work: &Work,
    run: &str,
    report: &runner::Report,
    excerpts: &[EvidenceExcerpt],
    candidates: &[(EvidenceLocator, crate::source_evidence::EvidenceVersion)],
    action_receipts: &Value,
    material_reads: &Value,
    control: &Control,
    reader: &crate::source_evidence::EvidenceReader,
    recovering: bool,
) -> Result<(), String> {
    images::verify(root, c, &work.grant.images)?;
    control.check()?;
    let current = load(c, &work.id)?;
    if current.revision != work.revision
        || current.authorization_version != work.authorization_version
        || (!recovering && current.active_run.as_deref() != Some(run))
    {
        return Err("调查依据或授权已改变，结果未发布".into());
    }
    if recovering {
        accepted_recovery::eligible_on(c, &current, run, report)?;
    }
    super::watch::check_publication(root, c, work, run)?;
    super::topics::record_method_use(c, work, run)?;
    goal::ensure_received_on(c, run)?;
    reader.verify_in_transaction(c, excerpts)?;
    reader.verify_candidates_in_transaction(c, candidates)?;
    let material_reads = super::artifacts::delivery_dependencies(
        root,
        c,
        &current,
        run,
        report.status == "completed",
        material_reads,
    )?;
    crate::source_evidence::analysis::verify_in_transaction(&reader, c, &material_reads)?;
    if super::actions::receipts_on(c, &work.id)? != *action_receipts {
        return Err("业务回执或审核状态已改变，结果未发布".into());
    }
    let artifact_refs = super::artifacts::run_references(c, &current, run)?;
    let assessment = goal::assessment_on(root, c, &current, run, report, &artifact_refs)?;
    insert(
        c,
        &work.id,
        Some(run),
        "delivery",
        &json!({"report":report,"evidence":excerpts,"candidates":candidates,"actionReceipts":action_receipts,"materialReads":material_reads,"artifactRefs":artifact_refs,"goalBinding":assessment["goalBinding"],"deliveryAssessment":assessment}),
    )?;
    if !recovering {
        c.execute(
            "UPDATE agent_runs SET state=?2,finished_at=?3 WHERE id=?1",
            params![run, report.status, stamp()],
        )
        .map_err(|e| e.to_string())?;
    }
    trace_budget::report_on(c, &work.id, encode(report)?.len())?;
    c.execute(
        "UPDATE agent_works SET state=?2,report_json=?3,active_run=NULL,updated_at=?4 WHERE id=?1",
        params![work.id, report.status, encode(report)?, stamp()],
    )
    .map_err(|e| e.to_string())?;
    super::watch::published(root, c, work, run, excerpts, candidates, &report.status)?;
    control.check()?;
    Ok(())
}
pub(super) fn fail(root: &Path, work: &Work, run: &str, error: &str) -> Result<(), String> {
    let state = if error.contains("中断")
        || error.contains("时限")
        || error.contains("预算")
        || crate::model_runtime::is_retryable_model_error(error)
    {
        "interrupted"
    } else if error.contains("改变") || error.contains("授权") {
        "expired"
    } else {
        "failed"
    };
    // Only host-generated safe errors enter the UI; CLI stderr never does.
    let safe: String = error.chars().take(200).collect();
    write(root, |c| {
        c.execute("UPDATE agent_runs SET state=?2,error=?3,finished_at=?4 WHERE id=?1 AND state='investigating'",params![run,state,safe,stamp()]).map_err(|e|e.to_string())?;
        c.execute("UPDATE agent_works SET state=?3,active_run=NULL,report_json=NULL,updated_at=?4 WHERE id=?1 AND active_run=?2 AND revision=?5 AND authorization_version=?6",params![work.id,run,state,stamp(),work.revision,work.authorization_version]).map_err(|e|e.to_string())?;
        Ok(())
    })
}
// The source-save action uses the same authority and dependency checks as the
// current report reader. It never exports a historical or stale delivery.
pub(super) fn report_save_context_on(
    root: &Path,
    c: &Connection,
    work: &Work,
) -> Result<Value, String> {
    if work.active_run.is_some() || work.state == "revoked" {
        return Err("请先完成当前事项并核对来源，再准备保存报告".into());
    }
    let report = work.report.as_ref().ok_or("当前没有可保存的有效报告")?;
    let body = records_on(c, &work.id, "delivery", 1)?
        .into_iter()
        .next()
        .ok_or("报告交付记录缺失")?;
    let run: String = c.query_row("SELECT run_id FROM agent_records WHERE work_id=?1 AND kind='delivery' ORDER BY rowid DESC LIMIT 1", [&work.id], |r| r.get(0)).map_err(|e| e.to_string())?;
    let authorization = if work.anchor.is_none() {
        c.query_row(
            "SELECT authorization_version FROM agent_runs WHERE id=?1 AND work_id=?2",
            params![run, work.id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?
    } else {
        work.authorization_version
    };
    let report = serde_json::to_value(report).map_err(|e| e.to_string())?;
    if body["report"] != report {
        return Err("报告与当前交付身份不一致，请重新核对".into());
    }
    let (_, projection) =
        delivery_read::DeliveryRead::new(root, c, work).verify(work, &run, &body, authorization)?;
    if projection["state"] == "stale"
        || super::actions::receipts_on(c, &work.id)?
            != body.get("actionReceipts").cloned().unwrap_or(json!([]))
    {
        return Err("报告依据、成果或操作回执已变化，请重新核对后保存".into());
    }
    Ok(json!({"runId":run,"report":report,"evidence":body["evidence"]}))
}

pub(super) fn view(root: &Path, id: &str) -> Result<Value, String> {
    let projection_started = std::time::Instant::now();
    let mut projection_phases = Vec::with_capacity(16);
    macro_rules! phase {
        ($name:expr) => {
            projection_phases.push(json!({"phase":$name,"elapsedMs":projection_started.elapsed().as_secs_f64()*1000.0}));
        };
    }
    let permit = crate::library_runtime::cached_read_permit(root)?;
    phase!("readPermit");
    tasks::refresh(root, id)?;
    phase!("taskRefresh");
    let c = read(root)?;
    c.execute_batch("BEGIN DEFERRED")
        .map_err(|e| e.to_string())?;
    let mut work = load(&c, id)?;
    phase!("databaseSnapshot");
    let mut delivery_reads = delivery_read::DeliveryRead::new(root, &c, &work);
    let mut evidence = Vec::new();
    let mut validity = String::new();
    phase!("loadAndTaskRefresh");
    if work.report.is_some() {
        let delivery = records_on(&c, id, "delivery", 1)?
            .into_iter()
            .next()
            .ok_or("调查交付记录缺失")?;
        let saved: Vec<EvidenceExcerpt> =
            serde_json::from_value(delivery["evidence"].clone()).map_err(|_| "调查取证记录损坏")?;
        let _candidates: Vec<(EvidenceLocator, crate::source_evidence::EvidenceVersion)> =
            serde_json::from_value(delivery.get("candidates").cloned().unwrap_or(json!([])))
                .map_err(|_| "调查候选依赖记录损坏")?;
        let run: String = c.query_row("SELECT run_id FROM agent_records WHERE work_id=?1 AND kind='delivery' ORDER BY rowid DESC LIMIT 1",[id],|r|r.get(0)).map_err(|e|e.to_string())?;
        let authorization = if work.anchor.is_none() {
            c.query_row(
                "SELECT authorization_version FROM agent_runs WHERE id=?1 AND work_id=?2",
                params![run, work.id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?
        } else {
            work.authorization_version
        };
        if let Err(error) = delivery_reads
            .verify(&work, &run, &delivery, authorization)
            .and_then(|(_, projection)| {
                if projection["state"] == "stale" {
                    return Err(projection["reason"]
                        .as_str()
                        .unwrap_or("图表已修订，报告需重新核对")
                        .to_owned());
                }
                Ok(())
            })
            .and_then(|_| {
                if super::actions::receipts_on(&c, id)?
                    != delivery.get("actionReceipts").cloned().unwrap_or(json!([]))
                {
                    return Err("业务回执或审核状态已变化，请重新核对结论".into());
                }
                Ok(())
            })
        {
            validity = error;
            work.state = "expired".into();
            work.report = None;
        } else {
            evidence = saved;
        }
    }
    phase!("currentReport");
    let latest:Option<Value>=c.query_row("SELECT id,state,error,usage_json FROM agent_runs WHERE work_id=?1 ORDER BY started_at DESC,rowid DESC LIMIT 1",[id],|r|Ok(json!({"id":r.get::<_,String>(0)?,"state":r.get::<_,String>(1)?,"error":r.get::<_,Option<String>>(2)?,"usage":serde_json::from_str::<Value>(&r.get::<_,String>(3)?).unwrap_or(json!({}))}))).optional().map_err(|e|e.to_string())?;
    let mut model_selection = Value::Null;
    let mut model_executions = Vec::new();
    if let Some(run) = latest.as_ref().and_then(|v| v["id"].as_str()) {
        let mut q = c.prepare("SELECT kind,body_json FROM agent_records WHERE run_id=?1 AND kind IN ('modelSelection','modelExecution') ORDER BY rowid LIMIT 64").map_err(|e|e.to_string())?;
        let records = q
            .query_map([run], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        for record in records {
            let (kind, raw) = record.map_err(|e| e.to_string())?;
            let value: Value = serde_json::from_str(&raw).map_err(|_| "模型运行记录损坏")?;
            if kind == "modelSelection" {
                model_selection = value;
            } else {
                model_executions.push(value);
            }
        }
    }
    let decisions = records_on(&c, id, "userDecision", 32)?;
    let memory_use = if work.state == "revoked" {
        None
    } else if let Some(run) = latest.as_ref().and_then(|v| v["id"].as_str()) {
        let raw: Option<String> = c.query_row("SELECT body_json FROM agent_records WHERE run_id=?1 AND kind='sharedMemoryUse' ORDER BY rowid DESC LIMIT 1", [run], |r|r.get(0)).optional().map_err(|e|e.to_string())?;
        raw.map(|raw| {
            serde_json::from_str::<Value>(&raw).map_err(|_| "记忆使用记录损坏".to_string())
        })
        .transpose()?
    } else {
        None
    };
    let actions = super::actions::view_on(root, &c, &work)?;
    let watch = super::watch::view_on(&c, id)?;
    phase!("modelsActionsWatch");
    let (progress, history) =
        delivery::read_on(root, &c, &work, latest.as_ref(), &mut delivery_reads)?;
    phase!("progressHistory");
    let conversation = conversation::read_on_cached(&c, &work, &mut delivery_reads)?;
    phase!("conversation");
    let assistant_options = super::options::load_on(&c, id)?;
    let draft_request = super::response::view_on(&c, &work)?;
    let activity = super::activity::read_on(root, &c, &work)?;
    phase!("optionsActivity");
    let analysis_artifacts = super::artifacts::view_on(root, &c, &work)?;
    phase!("charts");
    let sleep_datasets = super::artifacts::sleep::view_on(root, &c, &work)?;
    phase!("datasets");
    let record_version: i64 = c
        .query_row(
            "SELECT COALESCE(MAX(created_at),0) FROM agent_records WHERE work_id=?1",
            [id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let lifecycle = lifecycle::view_on(&c, &work)?;
    let goal_revision = goal::revisions::view_on(&c, &work)?;
    let task_tree = tasks::view_on(root, &c, &work)?;
    let working_state = working_state::view_on(root,&c,&work).unwrap_or_else(|error|json!({"state":"unavailable","reason":error,"entries":[],"pendingTargets":[],"unresolvedQuestions":[],"grantsAuthority":false}));
    let goal_assessment = goal::completion::projection_on(root, &c, &work)?;
    let material_budget: Option<Value> = if let Some(run) =
        latest.as_ref().and_then(|v| v["id"].as_str())
    {
        c.query_row("SELECT body_json FROM agent_records WHERE work_id=?1 AND run_id=?2 AND kind='nativeMaterialUsage' ORDER BY rowid DESC LIMIT 1",params![id,run],|r|r.get::<_,String>(0)).optional().map_err(|e|e.to_string())?.map(|v|serde_json::from_str(&v).map_err(|_|"材料计量记录损坏")).transpose()?
    } else {
        None
    };
    phase!("goalTasksAssessment");
    let context_compaction = native_compaction::view_on(&c, &work)?;
    let native_context = native_context::view_on(&c, &work)?;
    c.execute_batch("COMMIT").map_err(|e| e.to_string())?;
    permit.checkpoint()?;
    phase!("commitAndPermit");
    let value = json!({"materialBudget":material_budget,"workingState":working_state,"lifecycle":lifecycle,"goalRevision":goal_revision,"taskTree":task_tree,"goalAssessment":goal_assessment,"work":work,"evidence":evidence,"decisions":decisions,"run":latest,"validity":validity,"progress":progress,"history":history,"conversation":conversation,"actions":actions,"watch":watch,"memoryUse":memory_use,"modelSelection":model_selection,"modelExecutions":model_executions,"assistantOptions":assistant_options,"draftRequest":draft_request,"activity":activity,"analysisArtifacts":analysis_artifacts,"sleepDatasets":sleep_datasets,"recordVersion":record_version,"nativeTiming":{"hostEpochMs":chrono::Utc::now().timestamp_millis(),"projectionMs":projection_started.elapsed().as_secs_f64()*1000.0,"phases":projection_phases},"sourceFreshness":"notVerifiedWithRemote"});
    let mut value = value;
    value["contextCompaction"] = context_compaction;
    value["nativeContext"] = native_context;
    value["nativeInputs"] = native_input::view_on(&c, &work)?;
    value["followups"] = followups::view_on(&c, &work)?;
    #[cfg(test)]
    let value = if std::env::var_os("HUB_V1_STATUS_PHASES").is_some() {
        let mut value = value;
        value["diagnosticProjectionPhases"] = value["nativeTiming"]["phases"].clone();
        value
    } else {
        value
    };
    Ok(value)
}
