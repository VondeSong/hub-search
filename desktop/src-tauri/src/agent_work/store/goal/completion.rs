//! Completion is a projection of user requirements and checked delivery facts.
//! Semantic interpretation remains explicitly model-authored, never a host fact.
use super::*;
use std::collections::HashSet;

pub(in crate::agent_work) const GUIDE: &str = "完成核对合同：report.completion 只能为 null 或仅含 goalBinding、items 的对象，不得添加 note、goalBindingNote 或其他字段。goalBinding 原样复制 conversation.goalState.goalBinding；items 的每项只含 requirementId、criterion、requiredResult、status、explanation、refs、supersededBy，逐字使用当前 requirements 的 requirementId 并覆盖全部有效要求。纯阅读、摘要、正文交付和只读约束使用 requiredResult=response，refs=[]；report.citations 中的 quoteId（eN:qN）是来源引文，不是完成凭证，不能放入 refs。chart/draft/action 的 refs 只能选择 conversation.goalState.proofs 中对应类型的真实 proofId，不能编造或以来源引文替代。未完成则如实标记 unfulfilled/blocked；notApplicable 仅用于较新用户命令明确替代的要求并填写 supersededBy。null 表示未评估，不代表已完成。";

pub(in crate::agent_work) fn example(goal: &Value) -> Value {
    json!({"goalBinding":goal["goalBinding"],"items":[{
        "requirementId":goal["requirements"][0]["requirementId"],
        "criterion":"本项需要交付的文字要求或只读约束", "requiredResult":"response",
        "status":"unfulfilled", "explanation":"根据实际交付说明满足情况，不能照抄示例结论",
        "refs":[],"supersededBy":null,
    }]})
}

pub(in crate::agent_work) const RESPONSE_DELIVERY_POLICY: &str = "hub_finish 的 accepted=true 表示已核验、等待最终发布。Hub 在所有最终发布检查通过后，以同一事务保存报告正文、引用、目标绑定和来源依赖到当前事项及交付历史，可重新打开。若在生成上限内已核验报告，随后仅提供方结束回合超时，可在原宿主总时限内继续最终发布检查；取消、过期、来源或预算失效均不得恢复发布。提供方超时和未知用量单独保留，发布成功不等于提供方正常完成或费用已结算。仅要求在当前事项留存回答并后续修订时，完成类型为 response，无需另建独立报告或外部保存动作；后续要求、来源或版本改变仍须重新核对。外部保存、修改源笔记、导入、独立制品及永久保存仍须相应能力和真实证据，本交付约定不能证明这些操作。";

/// Describes the existing publication owner; acceptance itself is not a write
/// receipt. Never convert a model-authored blocked item into satisfied here.
pub(in crate::agent_work) fn response_delivery_contract() -> Value {
    json!({"schemaVersion":1,"scope":"currentWork","submitTool":"hub_finish",
        "acceptedState":"validatedPendingPublication","publicationAtomic":true,
        "retention":"workConversationAndDeliveryHistory","completionResult":"response",
        "separateSaveToolRequired":false,"externalWriteReceipt":false,
        "policy":RESPONSE_DELIVERY_POLICY})
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Completion {
    goal_binding: Value,
    items: Vec<Item>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Item {
    requirement_id: String,
    criterion: String,
    required_result: String,
    status: String,
    explanation: String,
    refs: Vec<String>,
    superseded_by: Option<String>,
}

pub(in crate::agent_work) fn schema() -> Value {
    fn object(properties: Value) -> Value {
        let required: Vec<_> = properties.as_object().unwrap().keys().cloned().collect();
        json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
    }
    let string = json!({"type":"string","minLength":1,"maxLength":2000});
    let id = json!({"type":"string","minLength":1,"maxLength":180});
    let binding = object(
        json!({"schemaVersion":{"type":"integer","enum":[1]},"workId":id,
        "workRevision":{"type":"integer"},"authorizationVersion":{"type":"integer"},
        "commandWatermark":{"type":"integer"},"lastCommandId":{"type":["string","null"]}}),
    );
    let mut binding_v2 = binding.clone();
    binding_v2["properties"]["schemaVersion"] = json!({"type":"integer","enum":[2]});
    binding_v2["properties"]["goalRevision"] = json!({"type":"integer","minimum":1});
    binding_v2["required"]
        .as_array_mut()
        .unwrap()
        .push(json!("goalRevision"));
    let binding = json!({"anyOf":[binding,binding_v2]});
    let item = object(
        json!({"requirementId":{"type":"string","minLength":1,"maxLength":180,"description":"逐字复制当前 conversation.goalState.requirements 中的 requirementId。将同一要求拆为多项 criterion 时，每项继续使用同一个原始 requirementId；禁止添加序号或后缀、改写或新建 ID。"},"criterion":string,
        "requiredResult":{"type":"string","enum":["response","chart","file","draft","action"],"description":"response：正文或只读约束，refs 留空；chart：已核对并留存于当前事项的内部图表，包括在有效期内继续修订，不证明永久保留或外部写入；file：已实际生成并核验的本机文件，不证明外部保存或内容语义正确；draft：待确认草稿；action：保存到来源、导入等业务执行，必须引用实际操作回执。根据用户原意选择，不因类型冲突擅自更改要求。"},
        "status":{"type":"string","enum":["satisfied","unfulfilled","blocked","notApplicable"]},
        "explanation":string,"refs":{"type":"array","maxItems":16,"items":id},
        "supersededBy":{"type":["string","null"],"maxLength":180}}),
    );
    json!({"anyOf":[object(json!({"goalBinding":binding,"items":{"type":"array","maxItems":128,"items":item}})),{"type":"null"}],
        "description":"逐项覆盖 conversation.goalState.requirements。每条用户消息可拆成多个 criterion，必须包含其中全部有效要求。语义核对由模型负责；引用只能取 goalState.proofs 的 proofId。response 可无引用，chart/file/draft/action 必须有同类型真实证据。内部图表留存使用 chart；外部保存、导入等业务执行使用 action，不能用 chart、draft 或 response 代替。notApplicable 必须解释，并引用较新的用户命令作为 supersededBy。预算不足时如实列出 unfulfilled/blocked；null 表示尚未评估，绝不代表完成。"})
}

pub(in crate::agent_work) fn sources_on(c: &Connection, work: &Work) -> Result<Value, String> {
    let mut items =
        vec![json!({"requirementId":format!("{}-goal",work.id),"origin":"user","text":work.goal})];
    if !work.success_criteria.trim().is_empty() {
        items.push(json!({"requirementId":format!("{}-criteria",work.id),"origin":"user","text":work.success_criteria}));
    }
    let mut q = c.prepare("SELECT id,kind,body_json FROM agent_records WHERE work_id=?1 AND kind IN ('userMessage','userDecision','steering') ORDER BY rowid").map_err(|e|e.to_string())?;
    let rows = q
        .query_map([&work.id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (id, kind, raw) = row.map_err(|e| e.to_string())?;
        let body: Value = serde_json::from_str(&raw).map_err(|_| "用户要求记录损坏")?;
        // User-supplied material remains attributable without becoming a new command.
        if body["materialOnly"] == true
            || super::super::conversation::is_scope_confirmation(&kind, &body)
        {
            continue;
        }
        items.push(json!({"requirementId":id,"origin":"user","text":body["text"]}));
    }
    // Never truncate away an obligation to make a completion claim fit.
    if items.len() > 128 {
        return Err("要求数量超过核对容量，请保留当前成果并新建事项".into());
    }
    Ok(json!(items))
}

pub(in crate::agent_work) fn requirements_on(c: &Connection, work: &Work) -> Result<Value, String> {
    let mut sources = sources_on(c, work)?;
    sources
        .as_array_mut()
        .unwrap()
        .extend(revisions::requirements_on(c, work)?);
    if sources.as_array().unwrap().len() > 128 {
        return Err("要求与解释超过核对容量，请保留当前成果".into());
    }
    Ok(sources)
}

pub(in crate::agent_work) fn proofs_on(
    root: &Path,
    c: &Connection,
    work: &Work,
    run: &str,
) -> Result<Value, String> {
    let mut proofs = super::super::super::actions::completion_proofs_on(root, c, work)?;
    let refs = super::super::super::artifacts::run_references(c, work, run)?;
    // Each proof depends on its own checked artifact, not every chart used by
    // the run. Final publication still checks the entire delivery separately.
    let charts = super::super::super::artifacts::view_on(root, c, work)?;
    for reference in refs.as_array().into_iter().flatten() {
        let checked = charts.as_array().unwrap().iter().any(|chart| {
            chart["state"] == "checked"
                && chart["artifactId"] == reference["artifactId"]
                && chart["revision"] == reference["revision"]
                && chart["content"]["contentHash"] == reference["contentHash"]
                && chart["content"]["data"]["datasetRevision"] == reference["datasetRevision"]
        });
        if checked {
            let mut reference = reference.clone();
            reference.as_object_mut().unwrap().remove("inherited");
            let proof_id = format!(
                "chart:{:x}",
                Sha256::digest(reference.to_string().as_bytes())
            );
            proofs.push(json!({"proofId":proof_id,"kind":"chart","reference":reference}));
        }
    }
    for reference in super::super::super::analysis::references(root, work, None)?
        .as_array()
        .into_iter()
        .flatten()
    {
        let proof_id = format!(
            "file:{:x}",
            Sha256::digest(reference.to_string().as_bytes())
        );
        proofs.push(json!({"proofId":proof_id,"kind":"file","reference":reference,"meaning":"Actual files and unchanged input identities, not validation of every conclusion and not an external save receipt"}));
    }
    Ok(json!(proofs))
}

/// Shared exact-version proof gate for requirements and execution tasks.
pub(in crate::agent_work) fn resolve_proofs(
    proofs: &Value,
    ids: &[String],
    kind: &str,
    required: bool,
) -> Result<Vec<Value>, String> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for id in ids {
        if !seen.insert(id) {
            return Err("完成证据重复".into());
        }
        let proof = proofs
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["proofId"] == *id)
            .ok_or("完成证据不存在、已改变或未核验，请重新读取目标状态")?;
        if proof["kind"] != kind {
            let actual = proof["kind"].as_str().unwrap_or("unknown");
            let hint = match (kind, actual) {
                ("response", _) => "正文或只读约束使用 response 且 refs 留空；需要图表核对时另列 chart 条件，不要丢弃用户要求。",
                ("action", "chart") => "内部图表留存及继续修订属于 chart；外部保存或导入才属于 action，图表不能证明外部写入。请按用户原意核对。",
                ("action", "draft") => "预览不能证明已保存或导入；需要实际 action 回执，尚未执行时如实标为未完成。",
                _ => "请重新读取目标状态，按用户原意选择成果类型及同类型证据；不能改写用户要求来通过核验。",
            };
            return Err(format!(
                "成果类型不符合要求：要求 {kind}，证据 {actual}（{id}）。{hint}"
            ));
        }
        result.push(proof.clone());
    }
    if required && kind != "response" && ids.is_empty() {
        return Err("已满足的要求缺少真实成果或操作回执".into());
    }
    Ok(result)
}

pub(in crate::agent_work) fn context_on(
    root: &Path,
    c: &Connection,
    work: &Work,
) -> Result<Value, String> {
    let proofs = if let Some(run) = &work.active_run {
        proofs_on(root, c, work, run)?
    } else {
        json!([])
    };
    Ok(
        json!({"goalRevision":revisions::view_on(c,work)?,"taskTree":super::super::tasks::view_on(root,c,work)?,"goalBinding":binding_on(c,work)?,"requirements":requirements_on(c,work)?,"proofs":proofs,"responseDelivery":response_delivery_contract(),
        "semanticOwner":"model","policy":"保留每条原始用户要求。复合要求逐项拆成 criterion；修订只替代冲突部分，剩余要求继续有效。notApplicable 只用于被较新用户命令明确替代的部分。工具或模型不能自行撤销用户要求。"}),
    )
}

pub(in crate::agent_work) fn read_context(
    root: &Path,
    work: &Work,
    run: &str,
) -> Result<Value, String> {
    super::super::tasks::refresh(root, &work.id)?;
    let c = read(root)?;
    c.execute_batch("BEGIN DEFERRED")
        .map_err(|e| e.to_string())?;
    let current = current_run_on(&c, work, run)?;
    context_on(root, &c, &current)
}

pub(in crate::agent_work) fn evaluate(
    root: &Path,
    c: &Connection,
    work: &Work,
    run: &str,
    report: &runner::Report,
) -> Result<Value, String> {
    let requirements = requirements_on(c, work)?;
    let sources = requirements.as_array().unwrap();
    let raw = serde_json::to_value(report).map_err(|e| e.to_string())?;
    let mut evidence = Vec::new();
    let mut covered = HashSet::new();
    let mut criteria = HashSet::new();
    let mut proof_versions = Vec::new();
    if let Some(value) = raw.get("completion").filter(|v| !v.is_null()) {
        crate::model_runtime::validate_agent_tool(value, &schema())?;
        let completion: Completion =
            serde_json::from_value(value.clone()).map_err(|_| "目标核对格式无效")?;
        ensure_binding_on(c, work, &completion.goal_binding)?;
        let proofs = proofs_on(root, c, work, run)?;
        for item in completion.items {
            let index = sources
                .iter()
                .position(|r| r["requirementId"] == item.requirement_id)
                .ok_or("核对引用了不存在的用户要求")?;
            if item.criterion.trim().is_empty()
                || item.explanation.trim().is_empty()
                || !criteria.insert((item.requirement_id.clone(), item.criterion.clone()))
            {
                return Err("核对条件或说明为空，或同一条件重复".into());
            }
            if item.status == "notApplicable" {
                if sources[index]["origin"] == "modelInterpretation" {
                    return Err(
                        "有效解释条目不能在完成报告中撤销，请先提交有用户依据的目标修订".into(),
                    );
                }
                let newer = item
                    .superseded_by
                    .as_ref()
                    .and_then(|id| sources.iter().position(|r| r["requirementId"] == *id));
                if !newer.is_some_and(|n| {
                    n > index
                        && sources[n]["origin"] == "user"
                        && n >= if work.success_criteria.trim().is_empty() {
                            1
                        } else {
                            2
                        }
                }) {
                    return Err("撤销或替代要求必须引用较新的用户命令".into());
                }
            } else if item.superseded_by.is_some() {
                return Err("仅不适用的要求可声明替代命令".into());
            }
            for proof in resolve_proofs(
                &proofs,
                &item.refs,
                &item.required_result,
                item.status == "satisfied",
            )? {
                if !proof_versions.contains(&proof) {
                    proof_versions.push(proof);
                }
            }
            if item.status == "satisfied"
                && item.required_result == "response"
                && raw["summary"].as_str().is_none_or(|s| s.trim().is_empty())
            {
                return Err("回答要求缺少实际正文".into());
            }
            covered.insert(item.requirement_id.clone());
            evidence.push(serde_json::to_value(item).map_err(|e| e.to_string())?);
        }
    }
    for source in sources {
        if !covered.contains(source["requirementId"].as_str().unwrap()) {
            evidence.push(json!({"requirementId":source["requirementId"],"criterion":source["text"],"status":"unfulfilled","explanation":"尚未提供逐项完成核对","refs":[],"semanticSource":"hostCoverageCheck"}));
        }
    }
    let task_tree = super::super::tasks::view_on(root, c, work)?;
    let unfinished: Vec<_> = task_tree["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|t| !matches!(t["status"].as_str(), Some("done" | "cancelled")))
        .cloned()
        .collect();
    let interpretation = revisions::view_on(c, work)?;
    let unresolved = interpretation["unresolvedAmbiguities"].as_array().unwrap();
    let interpretation_ready = interpretation["state"] != "needsRevision" && unresolved.is_empty();
    let all_met = evidence
        .iter()
        .all(|e| matches!(e["status"].as_str(), Some("satisfied" | "notApplicable")));
    let any_met = evidence.iter().any(|e| e["status"] == "satisfied");
    let all_cancelled = evidence.iter().all(|e| e["status"] == "notApplicable");
    let fulfillment = if all_cancelled {
        "cancelled"
    } else if all_met
        && interpretation_ready
        && unfinished.is_empty()
        && report.status == "completed"
    {
        "fulfilled"
    } else if !unresolved.is_empty()
        || (!any_met && evidence.iter().any(|e| e["status"] == "blocked"))
    {
        "blocked"
    } else {
        "partial"
    };
    Ok(
        json!({"goalRevision":interpretation["revision"],"goalInterpretationState":interpretation["state"],"unresolvedAmbiguities":unresolved,"taskRevision":task_tree["revision"],"unfinishedTasks":unfinished,"requirements":requirements,"completionEvidence":evidence,"proofVersions":proof_versions,
        "workFulfillment":fulfillment,"semanticStatusSource":if raw["completion"].is_null() {"notProvided"} else {"modelRequirementReview"},"semanticChecks":if raw["completion"].is_null() {"notProvided"} else {"modelReported"},
        "deterministicChecks":"passed","coverageComplete":sources.iter().all(|r|covered.contains(r["requirementId"].as_str().unwrap()))}),
    )
}

pub(in crate::agent_work) fn projection_on(
    root: &Path,
    c: &Connection,
    work: &Work,
) -> Result<Value, String> {
    if work.state == "cancelled" {
        return Ok(
            json!({"workFulfillment":"cancelled","requirements":requirements_on(c,work)?,
            "completionEvidence":[],"reason":"用户已取消目标；已有成果和业务回执保留，取消不代表撤销"}),
        );
    }
    let saved = records_on(c, &work.id, "delivery", 1)?.into_iter().next();
    if work.report.is_some() {
        if let Some(saved) = saved.filter(|s| s["deliveryAssessment"]["schemaVersion"] == 2) {
            let assessment = &saved["deliveryAssessment"];
            // view has already checked report dependencies. Recheck proof versions,
            // including draft versions, which are not business receipts yet.
            let run: String = c.query_row("SELECT run_id FROM agent_records WHERE work_id=?1 AND kind='delivery' ORDER BY rowid DESC LIMIT 1",[&work.id],|r|r.get(0)).map_err(|e|e.to_string())?;
            let now = proofs_on(root, c, work, &run)?;
            let tasks = super::super::tasks::view_on(root, c, work)?;
            if assessment["taskRevision"].as_u64().unwrap_or(0)
                == tasks["revision"].as_u64().unwrap_or(0)
                && assessment["goalBinding"] == binding_on(c, work)?
                && assessment["proofVersions"]
                    .as_array()
                    .is_some_and(|ps| ps.iter().all(|p| now.as_array().unwrap().contains(p)))
            {
                return Ok(assessment.clone());
            }
        }
    }
    Ok(
        json!({"workFulfillment":"partial","requirements":requirements_on(c,work)?,"completionEvidence":[],
        "reason":if work.state=="investigating" {"正在核对当前目标"} else {"当前要求或成果尚未完成核对"}}),
    )
}
