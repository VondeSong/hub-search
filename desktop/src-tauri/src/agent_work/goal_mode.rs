//! Explicit multi-round goal execution reuses the normal work owner, permits and evidence.
use super::*;
use std::collections::BTreeSet;

const MAX_PASSES: u32 = 3;
pub(super) const DELIVERY_GUIDANCE: &str = "目标模式：如果本轮已经交付阶段结果，且剩余工作可以用现有资料和授权继续，请调用 hub_finish，设置 status=completed，waitCondition=null，并在 completion.items 把余项标为 unfulfilled。这里的 completed 指本轮交付已完成。只在确实必须等待外部事件时用 waiting，例如资料尚未收到；如果需要用户选择，用 needsDecision，并在完成核对中标明 blocked。‘留到下一个自动轮次’属于可继续工作，应按阶段交付。";

pub(super) struct Pass {
    revision: i64,
    authorization: i64,
    index: u32,
    previous_run: Option<String>,
}

impl Pass {
    pub(super) fn context(&self) -> Value {
        json!({"round": self.index, "maximumRounds": MAX_PASSES, "previousRunId": self.previous_run})
    }

    pub(super) fn claim(
        &self,
        root: &Path,
        id: &str,
        run: &str,
        budget: Budget,
    ) -> Result<Work, String> {
        store::write(root, |c| {
            let current = store::load(c, id)?;
            if current.revision != self.revision
                || current.authorization_version != self.authorization
            {
                return Err("目标或资料授权已变化，请核对后继续".into());
            }
            if let Some(previous) = &self.previous_run {
                if current.state != "completed" {
                    return Err("目标已暂停或进入其他阶段，请查看当前进展".into());
                }
                let latest: Option<String> = c.query_row(
                    "SELECT id FROM agent_runs WHERE work_id=?1 ORDER BY started_at DESC, rowid DESC LIMIT 1",
                    [id], |row| row.get(0)
                ).optional().map_err(|error| error.to_string())?;
                if latest.as_ref() != Some(previous) {
                    return Err("已有更新的执行，请查看该任务".into());
                }
            }
            let work = store::claim_on(c, id, run)?;
            store::execution_budget::reserve_on(c, &work, run, budget)?;
            store::insert(c, id, Some(run), "goalModePass", &self.context())?;
            Ok(work)
        })
    }
}

pub(super) fn context(root: &Path, work: &Work, run: &str) -> Result<Option<Value>, String> {
    let c = crate::source_evidence::open_read_database(root)?;
    context_on(&c, &work.id, run)
}

fn context_on(c: &Connection, id: &str, run: &str) -> Result<Option<Value>, String> {
    let raw = c.query_row(
        "SELECT body_json FROM agent_records WHERE work_id=?1 AND run_id=?2 AND kind='goalModePass' LIMIT 1",
        params![id, run], |r| r.get::<_, String>(0)
    ).optional().map_err(|error| error.to_string())?;
    raw.map(|v| serde_json::from_str(&v).map_err(|_| "目标模式记录无效".into()))
        .transpose()
}

pub(super) fn view_on(c: &Connection, work: &Work, run: &str) -> Result<Option<Value>, String> {
    let Some(mut result) = context_on(c, &work.id, run)? else {
        return Ok(None);
    };
    let stopped = c.query_row(
        "SELECT json_extract(body_json,'$.reason') FROM agent_records WHERE work_id=?1 AND run_id=?2 AND kind='goalModeStopped' ORDER BY rowid DESC LIMIT 1",
        params![work.id, run], |row| row.get::<_, String>(0)
    ).optional().map_err(|error| error.to_string())?;
    result["stopReason"] = json!(stopped);
    Ok(Some(result))
}

fn remaining(view: &Value) -> Option<&[Value]> {
    let goal = &view["goalAssessment"];
    let items = goal["completionEvidence"].as_array()?;
    (view["work"]["state"] == "completed"
        && goal["workFulfillment"] == "partial"
        && goal["semanticStatusSource"] == "modelRequirementReview"
        && items.iter().any(|item| item["status"] == "unfulfilled")
        && !items.iter().any(|item| item["status"] == "blocked"))
    .then_some(items.as_slice())
}

pub(super) fn drive(
    root: &Path,
    id: &str,
    budget: Budget,
    app: Option<&tauri::AppHandle>,
    args: Option<&Value>,
) -> Result<Value, String> {
    if args.is_some_and(|v| v.get("reportContinuation").is_some()) {
        return Err("请先结束当前报告接续，再启动目标模式".into());
    }
    if let Some(resume) = args.filter(|value| value["action"] == "resume") {
        if store::lifecycle::resume_replayed(root, id, resume)? {
            return super::status(root, id);
        }
    }
    let work = store::load(&crate::source_evidence::open_read_database(root)?, id)?;
    let mut pass = Pass {
        revision: work.revision,
        authorization: work.authorization_version,
        index: 1,
        previous_run: None,
    };
    let mut satisfied = BTreeSet::new();
    loop {
        let view = super::run_once_app(
            root,
            id,
            budget,
            true,
            app,
            (pass.index == 1).then_some(args).flatten(),
            Some(&pass),
        )?;
        let Some(items) = remaining(&view) else {
            return Ok(view);
        };
        let current: BTreeSet<_> = items
            .iter()
            .filter(|item| item["status"] == "satisfied")
            .filter_map(|item| item["requirementId"].as_str().map(str::to_owned))
            .collect();
        let Some(run) = view["run"]["id"].as_str() else {
            return Ok(view);
        };
        if pass.index >= MAX_PASSES || (pass.index > 1 && current.is_subset(&satisfied)) {
            store::record(
                root,
                run,
                "goalModeStopped",
                &json!({"reason":
                if pass.index >= MAX_PASSES {"达到本次自动推进轮数"} else {"未确认新增的已满足条件"}}),
            )?;
            return super::status(root, id);
        }
        satisfied.extend(current);
        pass.previous_run = Some(run.into());
        pass.index += 1;
    }
}
