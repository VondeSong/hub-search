//! User-issued, finite read-only continuation. The existing background lifetime
//! calls tick; the Suite owns priority/admission and the existing runner owns AI.
use super::*;
use crate::source_evidence::EvidenceVersion;
mod catalog;
const INTERVAL: i64 = 60_000;
const WEEK: i64 = 7 * 24 * 60 * 60 * 1000;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Condition {
    format: u32,
    enabled: bool,
    generation: String,
    revision: i64,
    authorization_version: i64,
    on_change: bool,
    due_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    repeat_days: Option<u32>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    scan_libraries: bool,
    expires_at: i64,
    remaining: u32,
    notify: bool,
    dependencies: Vec<EvidenceLocator>,
    baseline: Value,
    running: Option<String>,
    message: String,
}
fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
pub(super) fn migrate(c: &Connection) -> rusqlite::Result<()> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS agent_watch_conditions(work_id TEXT PRIMARY KEY REFERENCES agent_works(id),enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),next_check_at INTEGER NOT NULL,body_json TEXT NOT NULL); CREATE INDEX IF NOT EXISTS agent_watch_due ON agent_watch_conditions(enabled,next_check_at); CREATE INDEX IF NOT EXISTS agent_condition_budget ON agent_records(created_at) WHERE kind='conditionTrigger';")?;
    catalog::prepare(c)?;
    c.prepare(
        "SELECT work_id,enabled,next_check_at,body_json FROM agent_watch_conditions LIMIT 0",
    )?;
    let pk:String=c.query_row("SELECT COALESCE(group_concat(name,','),'') FROM pragma_table_info('agent_watch_conditions') WHERE pk>0",[],|r|r.get(0))?;
    if pk != "work_id" {
        return Err(rusqlite::Error::InvalidQuery);
    }
    Ok(())
}
fn load(c: &Connection, id: &str) -> Result<Option<Condition>, String> {
    let raw: Option<(bool, String)> = c
        .query_row(
            "SELECT enabled,body_json FROM agent_watch_conditions WHERE work_id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    raw.map(|(enabled, raw)| {
        if raw.len() > 65536 {
            return Err("复查条件记录过大".into());
        }
        let v: Condition = serde_json::from_str(&raw).map_err(|_| "复查条件损坏，请重新设置")?;
        if v.format != 1
            || v.enabled != enabled
            || v.remaining > 3
            || !matches!(v.repeat_days, None | Some(1 | 7))
            || v.dependencies.is_empty()
            || v.dependencies.len() > 64
        {
            return Err("复查条件不符合当前边界".into());
        }
        Ok(v)
    })
    .transpose()
}
fn save(c: &Connection, id: &str, v: &Condition, next: i64) -> Result<(), String> {
    let raw = serde_json::to_string(v).map_err(|e| e.to_string())?;
    if raw.len() > 65536 {
        return Err("复查条件超过保存预算".into());
    }
    c.execute("INSERT INTO agent_watch_conditions(work_id,enabled,next_check_at,body_json) VALUES(?1,?2,?3,?4) ON CONFLICT(work_id) DO UPDATE SET enabled=excluded.enabled,next_check_at=excluded.next_check_at,body_json=excluded.body_json",params![id,v.enabled,next,raw]).map_err(|e|e.to_string())?;
    Ok(())
}
pub(super) fn view_on(c: &Connection, id: &str) -> Result<Value, String> {
    Ok(match load(c, id) {
        Err(_) => json!({"enabled":false,"message":"复查条件不可用，未继续运行；请重新设置"}),
        Ok(None) => json!(null),
        Ok(Some(v)) => {
            json!({"enabled":v.enabled,"onChange":v.on_change,"dueAt":v.due_at,"repeatDays":v.repeat_days,"scanLibraries":v.scan_libraries,"executionHost":"desktop","expiresAt":v.expires_at,"remaining":v.remaining,"notify":v.notify,"running":v.running,"message":v.message})
        }
    })
}
pub(super) fn pause_on(c: &Connection, id: &str, message: &str) -> Result<Option<String>, String> {
    let loaded = match load(c, id) {
        Ok(v) => v,
        Err(_) => {
            c.execute(
                "UPDATE agent_watch_conditions SET enabled=0 WHERE work_id=?1",
                [id],
            )
            .map_err(|e| e.to_string())?;
            return Ok(None);
        }
    };
    let Some(mut v) = loaded else {
        return Ok(None);
    };
    let running = v.running.clone();
    v.enabled = false;
    v.running = None;
    v.message = message.into();
    save(c, id, &v, now() + INTERVAL)?;
    Ok(running)
}
pub(super) fn pause(root: &Path, id: &str, message: &str) -> Result<Option<String>, String> {
    store::write(root, |c| pause_on(c, id, message))
}
fn dependencies(
    work: &Work,
    evidence: &[EvidenceExcerpt],
    candidates: &[(EvidenceLocator, EvidenceVersion)],
) -> Result<Vec<EvidenceLocator>, String> {
    let mut values = work.anchor.iter().cloned().collect::<Vec<_>>();
    values.extend(evidence.iter().map(|e| e.locator.clone()));
    values.extend(candidates.iter().map(|e| e.0.clone()));
    normalize_dependencies(work, values)
}
fn normalize_dependencies(
    work: &Work,
    mut values: Vec<EvidenceLocator>,
) -> Result<Vec<EvidenceLocator>, String> {
    let mut seen = std::collections::HashSet::new();
    values.retain(|v| seen.insert(serde_json::to_string(v).unwrap_or_default()));
    if values.len() > 64
        || values
            .iter()
            .filter(|v| matches!(v, EvidenceLocator::Note { .. }))
            .count()
            > 32
        || values.iter().any(|v| !work.grant.contains(v))
    {
        return Err("自动复查最多支持 32 篇笔记及 64 个已授权的总依赖".into());
    }
    Ok(values)
}
fn sample_on(
    root: &Path,
    c: &Connection,
    work: &Work,
    deps: &[EvidenceLocator],
) -> Result<Value, String> {
    let hints = work
        .grant
        .reader(root)?
        .change_hints_in_transaction(c, deps)?;
    if hints
        .as_array()
        .is_none_or(|v| v.iter().any(|h| h["available"] != true))
    {
        return Err("相关来源已不可用，自动复查已暂停，请核对授权与资料状态".into());
    }
    Ok(json!({"sources":hints,"receipts":actions::receipt_hints_on(c,&work.id)?}))
}
pub(super) fn configure(root: &Path, args: &Value) -> Result<(), String> {
    let id = text(args, "id", 150)?;
    if args["confirmed"] != true {
        return Err("请明确启用有界的自动复查".into());
    }
    let change = args["onChange"].as_bool().unwrap_or(false);
    let due = args["dueAt"].as_i64();
    let repeat_days = match args.get("repeatDays").filter(|v| !v.is_null()) {
        None => None,
        Some(value) if matches!(value.as_u64(), Some(1 | 7)) => {
            value.as_u64().map(|days| days as u32)
        }
        Some(_) => return Err("复查周期仅支持每天或每周".into()),
    };
    if repeat_days.is_some() && (due.is_none() || change) {
        return Err("定时复查需要首次运行时间，请单独选择定时触发".into());
    }
    let scan_libraries = args["scanLibraries"] == true;
    if scan_libraries && repeat_days.is_none() {
        return Err("检查资料库新增内容需要设置每天或每周定时复查".into());
    }
    let stamp = now();
    if (!change && due.is_none()) || due.is_some_and(|d| d < stamp + 10_000 || d > stamp + WEEK) {
        return Err("请选择来源变化或未来 10 秒至 7 天内的复查时间".into());
    }
    if store::view(root, &id)?["work"]["report"].is_null() {
        return Err("请先完成并核对一轮调查，再按其实际依赖启用复查".into());
    }
    store::write(root, |c| {
        let work = store::load(c, &id)?;
        if work.state == "revoked" || work.active_run.is_some() {
            return Err("事项正在运行或授权已撤回".into());
        }
        let acting:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_actions WHERE work_id=?1 AND state IN ('preparing','executing'))",[&id],|r|r.get(0)).map_err(|e|e.to_string())?;
        if acting {
            return Err("请等待当前业务动作结束后设置复查".into());
        }
        let count: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM agent_watch_conditions WHERE enabled=1 AND work_id<>?1",
                [&id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if count >= 10 {
            return Err("最多同时启用 10 项自动复查".into());
        }
        let raw:String=c.query_row("SELECT body_json FROM agent_records WHERE work_id=?1 AND kind='delivery' ORDER BY rowid DESC LIMIT 1",[&id],|r|r.get(0)).map_err(|_|"缺少已核验调查交付")?;
        let delivered: Value = serde_json::from_str(&raw).map_err(|_| "调查交付记录损坏")?;
        let excerpts: Vec<EvidenceExcerpt> =
            serde_json::from_value(delivered["evidence"].clone()).map_err(|_| "调查依赖损坏")?;
        let candidates: Vec<(EvidenceLocator, EvidenceVersion)> =
            serde_json::from_value(delivered["candidates"].clone())
                .map_err(|_| "调查候选依赖损坏")?;
        // Revalidate again under the same writer transaction as this delegation.
        let reader = work.grant.reader(root)?;
        reader.verify_in_transaction(c, &excerpts)?;
        reader.verify_candidates_in_transaction(c, &candidates)?;
        if actions::receipts_on(c, &id)? != delivered["actionReceipts"] {
            return Err("业务回执已变化，请先继续调查".into());
        }
        let deps =
            reader.expand_task_dependencies(c, dependencies(&work, &excerpts, &candidates)?)?;
        let deps = normalize_dependencies(&work, deps)?;
        let baseline = sample_on(root, c, &work, &deps)?;
        let previous = load(c, &id)?.filter(|condition| {
            condition.enabled
                && condition.revision == work.revision
                && condition.authorization_version == work.authorization_version
                && condition.repeat_days.is_some()
        });
        if scan_libraries {
            if work.grant.library_ids.is_empty() || work.grant.manifest.is_some() {
                return Err("请在当前事项明确选择可持续复查的资料库".into());
            }
            if !previous
                .as_ref()
                .is_some_and(|condition| condition.scan_libraries)
            {
                catalog::capture(root, c, &work)?;
            }
        }
        let condition = Condition {
            format: 1,
            enabled: true,
            generation: crate::random_url_safe(18),
            revision: work.revision,
            authorization_version: work.authorization_version,
            on_change: change,
            due_at: due,
            repeat_days,
            scan_libraries,
            expires_at: match (due, repeat_days) {
                (Some(first), Some(days)) => first + 3 * i64::from(days) * (WEEK / 7),
                _ => stamp + WEEK,
            },
            remaining: previous.as_ref().map_or(3, |condition| condition.remaining),
            notify: args["notify"].as_bool().unwrap_or(false),
            dependencies: deps,
            baseline,
            running: None,
            message: if repeat_days.is_some() {
                "定时复查已启用，Hub 运行时最多完成 3 轮"
            } else {
                "已启用；最多自动复查 3 轮，7 天后到期"
            }
            .into(),
        };
        save(c, &id, &condition, stamp)
    })
}
fn narrowed(work: &Work, deps: &[EvidenceLocator]) -> Work {
    let mut w = work.clone();
    w.grant = Grant::default();
    for v in deps {
        match v {
            EvidenceLocator::Note { .. } => w.grant.notes.push(v.clone()),
            EvidenceLocator::Reading { item_key } => {
                w.grant.reading_item_keys.push(item_key.clone())
            }
            EvidenceLocator::Task { .. } | EvidenceLocator::Attachment { .. } => {
                w.grant.sources.push(v.clone())
            }
        }
    }
    w
}
fn eligible(c: &Connection, work: &Work, v: &Condition, stamp: i64) -> Result<(), String> {
    if !v.enabled
        || v.remaining == 0
        || stamp >= v.expires_at
        || v.revision != work.revision
        || v.authorization_version != work.authorization_version
        || work.state == "revoked"
    {
        return Err("自动复查已到期、预算用尽或委托已改变，请重新启用".into());
    }
    let count: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM agent_records WHERE kind='conditionTrigger' AND created_at>=?1",
            [stamp - 24 * 60 * 60 * 1000],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if count >= 10 {
        return Err("过去 24 小时已自动复查 10 轮，已暂停；可手动继续".into());
    }
    Ok(())
}
pub(super) fn published(
    root: &Path,
    c: &Connection,
    work: &Work,
    run: &str,
    excerpts: &[EvidenceExcerpt],
    candidates: &[(EvidenceLocator, EvidenceVersion)],
    state: &str,
) -> Result<(), String> {
    let Some(mut v) = load(c, &work.id)? else {
        return Ok(());
    };
    if !v.enabled || v.running.as_deref() != Some(run) {
        return Ok(());
    }
    // Only observations verified in this delivery may advance their baseline.
    // An unread dependency can change while the model is generating a report.
    let original = store::load(c, &work.id)?;
    if v.scan_libraries && state == "completed" {
        if let Some(changes) = scheduled_delta_on(c, run)? {
            catalog::advance(root, c, &original, &changes)?;
        }
    }
    let reader = original.grant.reader(root)?;
    let observed =
        reader.expand_task_dependencies(c, dependencies(&original, excerpts, candidates)?)?;
    let mut deps = observed.clone();
    // Keep unchanged dependencies watched even when this run only re-read the
    // changed subset. A wake-up is not permission to forget older dependencies.
    deps.extend(v.dependencies.clone());
    let deps = original
        .grant
        .reader(root)?
        .expand_task_dependencies(c, normalize_dependencies(&original, deps)?)?;
    let deps = normalize_dependencies(&original, deps)?;
    let mut sample = sample_on(root, c, &original, &deps)?;
    let old = v.baseline["sources"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    for current in sample["sources"].as_array_mut().into_iter().flatten() {
        if !observed
            .iter()
            .any(|locator| serde_json::to_value(locator).ok().as_ref() == Some(&current["locator"]))
        {
            if let Some(previous) = old
                .iter()
                .find(|hint| hint["locator"] == current["locator"])
            {
                *current = previous.clone();
            }
        }
    }
    v.baseline = sample;
    v.dependencies = deps;
    v.running = None;
    v.enabled = (v.on_change || v.due_at.is_some()) && v.remaining > 0 && state != "needsDecision";
    v.message = if state == "needsDecision" {
        "自动复查已完成；需要你的决定，已暂停"
    } else if v.enabled && v.repeat_days.is_some() {
        "本次报告已保存，等待下次定时复查"
    } else if v.enabled {
        "自动复查已完成，等待下一次相关变化"
    } else {
        "自动复查已完成，本次约定已结束"
    }
    .into();
    save(c, &work.id, &v, now() + INTERVAL)
}
pub(super) fn tick(root: &Path) -> Result<Option<Value>, String> {
    let c = crate::source_evidence::open_read_database(root)?;
    let mut q=c.prepare("SELECT work_id,body_json FROM agent_watch_conditions WHERE enabled=1 AND next_check_at<=?1 ORDER BY next_check_at,work_id LIMIT 4").map_err(|e|e.to_string())?;
    let ids = q
        .query_map([now()], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(q);
    drop(c);
    for (id, expected) in ids {
        let result = one(root, &id);
        match result {
            Ok(Some(notice)) => return Ok(Some(notice)),
            Ok(None) => (),
            Err(error) => {
                // Corrupt/failing conditions fail closed, independently of other work.
                let _ = store::write(root, |c| {
                    let current: Option<String> = c
                        .query_row(
                            "SELECT body_json FROM agent_watch_conditions WHERE work_id=?1",
                            [&id],
                            |r| r.get(0),
                        )
                        .optional()
                        .map_err(|e| e.to_string())?;
                    if current.as_deref() == Some(expected.as_str()) {
                        pause_on(c, &id, &error)?;
                    }
                    Ok(())
                });
            }
        }
    }
    Ok(None)
}
fn one(root: &Path, id: &str) -> Result<Option<Value>, String> {
    let live = active()
        .lock()
        .map_err(|_| "调查运行状态不可用")?
        .get(&(root_key(root), id.into()))
        .map(|a| a.run_id.clone());
    let (v, work, event) = store::write(root, |c| {
        let mut v = load(c, id)?.ok_or("复查条件不存在")?;
        let work = store::load(c, id)?;
        if v.running.is_some() {
            // A restart may retain a running claim. Status/claim reconciliation
            // keeps progress, but never silently runs it again.
            if live != v.running {
                if let Some(run) = v.running.as_deref() {
                    store::reconcile_on(c, id, run)?;
                }
                v.enabled = false;
                v.running = None;
                v.message = "上次自动复查已中断，已暂停；已有进展保留".into();
            }
            save(c, id, &v, now() + INTERVAL)?;
            return Ok((v, work, None));
        }
        eligible(c, &work, &v, now())?;
        let acting:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_actions WHERE work_id=?1 AND state IN ('preparing','executing'))",[id],|r|r.get(0)).map_err(|e|e.to_string())?;
        if work.active_run.is_some() || acting {
            save(c, id, &v, now() + INTERVAL)?;
            return Ok((v, work, None));
        }
        let sample = sample_on(root, c, &work, &v.dependencies)?;
        let old = v.baseline["sources"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        for current in sample["sources"].as_array().into_iter().flatten() {
            if let Some(previous) = old.iter().find(|h| h["locator"] == current["locator"]) {
                if current["locator"]["kind"] == "task"
                    && (current["bindingIdentity"] != previous["bindingIdentity"]
                        || current["lineIdentity"] != previous["lineIdentity"])
                {
                    v.enabled = false;
                    v.message = "任务对应关系或行号身份已改变，已暂停；请重新核对来源".into();
                    save(c, id, &v, now() + INTERVAL)?;
                    return Ok((v, work, None));
                }
            }
        }
        if sample["sources"]
            .as_array()
            .is_some_and(|v| v.iter().any(|h| h["ready"] == false))
        {
            v.message = "附件正在等待当前版本的可核验提取，未调用模型".into();
            save(c, id, &v, now() + INTERVAL)?;
            return Ok((v, work, None));
        }
        let timed = v.due_at.filter(|d| *d <= now());
        let changed = v.on_change && sample != v.baseline;
        let event = if timed.is_some() || changed {
            let library_delta = if timed.is_some() && v.scan_libraries {
                Some(catalog::delta(root, c, &work)?)
            } else {
                None
            };
            Some(
                json!({"reason":if timed.is_some() {"agreedReview"} else {"knownDependencyChanged"},"scheduledAt":timed,"metadataOnly":true,"sample":sample,"libraryDelta":library_delta}),
            )
        } else {
            None
        };
        save(c, id, &v, now() + INTERVAL)?;
        Ok((v, work, event))
    })?;
    let Some(event) = event else {
        return Ok(None);
    };
    let budget = Budget::mode("quick")?;
    let permit = crate::library_runtime::cached_read_permit(root)?;
    let duration = Duration::from_millis(
        (v.expires_at - now()).clamp(1, (budget.seconds * 1000) as i64) as u64,
    );
    let control = Control::bounded(duration)
        .with_generation_ceiling(Duration::from_secs(budget.model_call_seconds))
        .guarded(move || {
            permit.checkpoint()?;
            if !crate::background_workers::running() {
                return Err("应用正在退出，已停止自动复查".into());
            }
            Ok(())
        });
    let Some(operation) = Operation::try_start_background_selected(
        root,
        control.clone(),
        options::load(root, id)?.model,
    )?
    else {
        return Ok(None);
    };
    let run = format!("run-{}", crate::random_url_safe(18));
    let key = (root_key(root), id.into());
    let mut map = active().lock().map_err(|_| "调查运行状态不可用")?;
    if map.contains_key(&key) {
        return Ok(None);
    }
    let claimed = store::write(root, |c| {
        if v.scan_libraries && catalog::delta(root, c, &work)? != event["libraryDelta"] {
            return Ok(None);
        }
        claim_on(c, id, &run, &v, &event).map(Some)
    })?;
    let Some(claimed) = claimed else {
        return Ok(None);
    };
    map.insert(
        key.clone(),
        Active {
            run_id: run.clone(),
            control: control.clone(),
            is_action: false,
        },
    );
    drop(map);
    let running = Running(key);
    let mut focused = affected(&claimed, &v, &event);
    for value in event["libraryDelta"]["changes"]
        .as_array()
        .into_iter()
        .flatten()
    {
        if value["kind"] != "missing" {
            let locator: EvidenceLocator = serde_json::from_value(value["locator"].clone())
                .map_err(|_| "定时复查的资料定位无效")?;
            if !focused.contains(&locator) {
                focused.push(locator);
            }
        }
    }
    let result = execute_investigation(
        root,
        &narrowed(&claimed, &focused),
        &run,
        &control,
        budget,
        &operation,
    );
    if let Err(error) = &result {
        store::fail(root, &claimed, &run, error)?;
        store::write(root, |c| {
            if load(c, id)?.is_some_and(|current| {
                current.generation == v.generation
                    && current.running.as_deref() == Some(run.as_str())
            }) {
                pause_on(
                    c,
                    id,
                    "本次自动复查中断或失败，已暂停；可查看进展并手动继续",
                )?;
            }
            Ok(())
        })?;
    }
    drop(running);
    let c = crate::source_evidence::open_read_database(root)?;
    let latest = load(&c, id)?.ok_or("复查条件不存在")?;
    Ok(if v.notify && latest.generation == v.generation {
        Some(
            json!({"workId":id,"eventId":format!("{}:{run}",v.generation),"message":latest.message,"tone":if result.is_ok(){"success"}else{"warning"},"goal":work.goal.chars().take(60).collect::<String>()}),
        )
    } else {
        None
    })
}
fn claim_on(
    c: &Connection,
    id: &str,
    run: &str,
    v: &Condition,
    event: &Value,
) -> Result<Work, String> {
    let mut current = load(c, id)?.ok_or("复查条件不存在")?;
    let work = store::load(c, id)?;
    eligible(c, &work, &current, now())?;
    if current.generation != v.generation || current.running.is_some() {
        return Err("复查约定已改变".into());
    }
    let timed = event["reason"] == "agreedReview";
    if timed
        && event.get("scheduledAt").is_some()
        && event["scheduledAt"].as_i64() != current.due_at
    {
        return Err("本次定时复查已处理".into());
    }
    let scheduled_at = current.due_at.filter(|_| timed);
    let work = store::claim_on(c, id, &run)?;
    store::execution_budget::reserve_on(c, &work, run, Budget::mode("quick")?)?;
    current.remaining -= 1;
    current.running = Some(run.into());
    current.message = "正在按约定复查已知来源".into();
    if timed {
        current.due_at = match (scheduled_at, current.repeat_days) {
            (Some(slot), Some(days)) if current.remaining != 0 => {
                let interval = i64::from(days) * (WEEK / 7);
                let next = slot + ((now() - slot).max(0) / interval + 1) * interval;
                (next < current.expires_at).then_some(next)
            }
            _ => None,
        };
    }
    save(c, id, &current, now() + INTERVAL)?;
    store::insert(
        c,
        id,
        Some(&run),
        "conditionTrigger",
        &json!({"reason":event["reason"],"scheduledAt":scheduled_at,"generation":current.generation,"dependencyCount":current.dependencies.len(),"scope":if current.scan_libraries {"authorizedLibraryDelta"} else {"knownDependenciesOnly"},"libraryDelta":event["libraryDelta"],"readOnly":true}),
    )?;
    Ok(work)
}

fn scheduled_delta_on(c: &Connection, run: &str) -> Result<Option<Value>, String> {
    Ok(store::review_trigger_on(c, run)?.and_then(|record| {
        record
            .get("libraryDelta")
            .filter(|delta| delta.is_object())
            .cloned()
    }))
}

fn affected(work: &Work, v: &Condition, event: &Value) -> Vec<EvidenceLocator> {
    if event["reason"] == "agreedReview" || event["sample"]["receipts"] != v.baseline["receipts"] {
        return v.dependencies.clone();
    }
    let old = v.baseline["sources"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut locators = work.anchor.iter().cloned().collect::<Vec<_>>();
    for current in event["sample"]["sources"].as_array().into_iter().flatten() {
        if !old.contains(current) {
            if let Ok(locator) = serde_json::from_value(current["locator"].clone()) {
                if !locators.contains(&locator) {
                    locators.push(locator);
                }
            }
            if current["locator"]["kind"] == "task" && !current["bindingIdentity"].is_null() {
                for peer in old.iter().filter(|h| {
                    h["locator"]["kind"] == "task"
                        && h["bindingIdentity"] == current["bindingIdentity"]
                }) {
                    if let Ok(locator) = serde_json::from_value(peer["locator"].clone()) {
                        if !locators.contains(&locator) {
                            locators.push(locator);
                        }
                    }
                }
            }
        }
    }
    locators
}
pub(super) fn check_publication(
    root: &Path,
    c: &Connection,
    work: &Work,
    run: &str,
) -> Result<(), String> {
    let trigger:Option<String>=c.query_row("SELECT body_json FROM agent_records WHERE run_id=?1 AND kind='conditionTrigger' LIMIT 1",[run],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    if let Some(trigger) = trigger {
        let trigger: Value = serde_json::from_str(&trigger).map_err(|_| "复查触发记录损坏")?;
        let v = load(c, &work.id)?.ok_or("复查约定已移除")?;
        if !v.enabled
            || now() >= v.expires_at
            || v.running.as_deref() != Some(run)
            || trigger["generation"] != v.generation
            || work.revision != v.revision
            || work.authorization_version != v.authorization_version
        {
            return Err("自动复查已暂停或约定已改变，结果未发布".into());
        }
        // Use the original authorization to notice a new authorized bound peer,
        // even when this run intentionally read only the changed exact sources.
        let original = store::load(c, &work.id)?;
        let current = sample_on(root, c, &original, &v.dependencies)?;
        for hint in current["sources"].as_array().into_iter().flatten() {
            if hint["locator"]["kind"] != "task" {
                continue;
            }
            if let Some(previous) = v.baseline["sources"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|h| h["locator"] == hint["locator"])
            {
                if hint["bindingIdentity"] != previous["bindingIdentity"]
                    || hint["lineIdentity"] != previous["lineIdentity"]
                {
                    return Err("任务对应关系或行号身份已改变，结果未发布；请重新核对来源".into());
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
