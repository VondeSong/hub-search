//! One chronological projection of durable runtime facts. It never infers a
//! completed action from model commentary. Only public summary events enter it.
use super::*;
use std::collections::HashMap;

fn title(request: &Value, catalog: &mut Option<Value>) -> String {
    match request["operation"].as_str().unwrap_or_default() {
        "search" => format!(
            "搜索相关{}",
            match request["sourceKind"].as_str() {
                Some("task") => "任务",
                Some("reading") => "阅读材料",
                _ => "笔记",
            }
        ),
        "read" => "读取原文".into(),
        "analyzeFiles" => "分析数据并生成文件".into(),
        "fetchFile" => "获取公开资料文件".into(),
        "compute" => "运行计算脚本".into(),
        "goalState" => "核对任务状态（内部）".into(),
        "loadSkill" => "读取技能说明".into(),
        "toolSchema" => format!(
            "读取工具定义：{}",
            request["name"].as_str().unwrap_or("工具")
        ),
        "readSkillReference" => "读取技能参考资料".into(),
        "traceResult" => "查看已保存的工具结果".into(),
        "mcp"
            if request["server"]
                .as_str()
                .is_some_and(|s| s.starts_with("browser:")) =>
        {
            match request["tool"].as_str() {
                Some("catalog") => "核对浏览器工具",
                Some("browser_navigate") => "打开网页",
                Some("browser_snapshot") => "读取浏览器页面",
                Some("browser_click") => "点击网页元素",
                Some("browser_type") => "填写网页字段",
                Some("browser_tabs") => "管理浏览器标签",
                _ => "操作浏览器",
            }
            .into()
        }
        "mcp"
            if request["server"]
                .as_str()
                .is_some_and(|s| s.starts_with("app:")) =>
        {
            if request["tool"] == "catalog" {
                "核对已连接应用工具"
            } else if request["tool"] == "github.add_comment_to_issue" {
                "准备 GitHub 评论草稿"
            } else {
                "查询已连接应用"
            }
            .into()
        }
        "mcp" => if request["tool"] == "catalog" {
            "核对外部文档工具与资源"
        } else if request["tool"] == "read_resource" {
            "读取外部文档资源"
        } else {
            "查询外部文档"
        }
        .into(),
        "workingState" => "整理工作记录".into(),
        "capability" => catalog.get_or_insert_with(crate::hub_capabilities::catalog)["tools"]
            .as_array()
            .and_then(|tools| tools.iter().find(|t| t["name"] == request["name"]))
            .and_then(|tool| tool["annotations"]["title"].as_str())
            .unwrap_or("调用 Hub 工具")
            .to_string(),
        "draftContext" => if request["kind"] == "obsidianEdit" {
            "读取笔记修改所需的材料"
        } else {
            "读取制卡材料与要求"
        }
        .into(),
        "prepareDraft" => "准备并核验草稿".into(),
        "inspectDraft" => "检查草稿".into(),
        "importFlashcards" => "导入闪卡收件箱".into(),
        "prepareArchive" => "准备归档方案".into(),
        _ => "调用工具".into(),
    }
}
pub(super) fn read_on(root: &Path, c: &Connection, w: &Work) -> Result<Value, String> {
    if w.state == "revoked" {
        return Ok(json!([]));
    }
    let mut q=c.prepare("SELECT id,base_revision,state,started_at,finished_at,authorization_version FROM agent_runs WHERE work_id=?1 ORDER BY rowid DESC LIMIT 20").map_err(|e|e.to_string())?;
    let runs = q
        .query_map([&w.id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, Option<i64>>(4)?,
                r.get::<_, i64>(5)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    // Titles are static catalog metadata, not an authorization decision. Build
    // it once per projection; every evidence check below still runs afresh.
    let mut title_catalog = None;
    for (run, revision, state, started, finished, authorization) in runs.into_iter().rev() {
        if authorization != w.authorization_version {
            continue;
        }
        let mut query=c.prepare("SELECT rowid,kind,body_json,created_at,id FROM agent_records WHERE run_id=?1 AND kind IN ('nativeMeasurement','nativeRuntime','libraryRules','agentStream','activity','intent','toolCall','toolResult','evidence','selectedMaterialReadError','selectedDataRead','autoInboxReceipt','workingState','nativeContextLifecycle','nativeFinal','delivery','nativeImages') ORDER BY rowid LIMIT 4096").map_err(|e|e.to_string())?;
        let rows = query
            .query_map([&run], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut events: Vec<Value> = Vec::new();
        let mut steps = HashMap::new();
        let mut analyses = HashMap::new();
        let mut compressions = HashMap::<(String, String, String), usize>::new();
        // A run may have consumed a snapshot without quoting each source.
        // Its entire public body is bound to the grant at that revision, not
        // merely the excerpts which happened to become report citations.
        let historical_grant = store::materials::grant_at(c, w, revision);
        let mut valid = historical_grant
            .as_ref()
            .is_ok_and(|g| images::verify(root, c, &g.images).is_ok());
        let reader = historical_grant
            .unwrap_or_else(|_| w.grant.clone())
            .reader(root)?;
        let mut measurement = Value::Null;
        let mut runtime_capabilities = Value::Null;
        let mut has_delivery = false;
        for row in rows {
            let (sequence, kind, raw, time, record_id) = row.map_err(|e| e.to_string())?;
            let before_events = events.len();
            let body: Value = serde_json::from_str(&raw).map_err(|_| "助手活动记录损坏")?;
            match kind.as_str() {
                "nativeContextLifecycle" => {
                    if body["schemaVersion"]==1 && body["origin"]=="publicLifecycle" {
                        let key=(body["threadId"].as_str().unwrap_or_default().to_string(),body["turnId"].as_str().unwrap_or_default().to_string(),body["itemId"].as_str().unwrap_or_default().to_string());
                        if !key.0.is_empty() && !key.1.is_empty() && !key.2.is_empty() {
                            if let Some(event)=compression_event(sequence,time,&body,active_run(w,&run,&state)) {
                                if let Some(index)=compressions.get(&key).copied() {
                                    if events[index]["state"]!="completed" {
                                        let started=events[index]["createdAt"].clone();let order=events[index]["sequence"].clone();
                                        events[index]=event;events[index]["createdAt"]=started;events[index]["sequence"]=order;
                                    }
                                } else { compressions.insert(key,events.len()); events.push(event); }
                            }
                        }
                    }
                }
                "workingState" => events.push(json!({"id":sequence.to_string(),"kind":"context","state":"completed","origin":"hub-working-state","label":format!("已保存工作记录（第{}版）",body["revision"]),"createdAt":time,"finishedAt":time})),
                "nativeMeasurement" => measurement = body,
                "nativeRuntime" if body.get("nativeCapabilities").is_some() => runtime_capabilities = body,
                "libraryRules" => {
                    let mut seen = std::collections::HashSet::new();
                    if let Some(bundles) = body.as_array() {
                        for bundle in bundles {
                            for entry in bundle["entries"].as_array().into_iter().flatten() {
                                let source = entry["source"].as_str().unwrap_or_default();
                                if seen.insert(source.to_string()) {
                                    events.push(json!({"id":format!("rules-{sequence}-{}",events.len()),"kind":"context","state":"completed","origin":"hub-context",
                                        "label":"已加载知识库工作规则","detail":format!("{} · 版本 {}",source,entry["version"].as_str().unwrap_or_default().chars().take(12).collect::<String>()),"createdAt":time,"finishedAt":time}));
                                }
                            }
                        }
                    }
                }
                "nativeImages" => { events.push(json!({"id":sequence.to_string(),"kind":"context","state":"completed","label":format!("本轮已准备 {} 张授权原图；图片解读以模型答复为准",body["images"].as_array().map_or(0,Vec::len)),"createdAt":time})); }
                "nativeFinal" if state!="investigating" => {
                    if let Some(text)=body["text"].as_str().filter(|s|!s.trim().is_empty()) { events.push(json!({"id":sequence.to_string(),"kind":"unpublishedAnswer","state":"unverified","label":text,"createdAt":time})); }
                }
                "delivery" => { has_delivery = true; events.retain(|e|e["kind"]!="unpublishedAnswer"); }
                "agentStream" if body["kind"]=="contextUsage" => {},
                "agentStream" => {
                    if body["text"].as_str().is_some_and(|s| !s.trim().is_empty()) {
                        events.push(json!({"id":sequence.to_string(),"kind":body["kind"],"state":body["state"],"label":body["text"],"url":body["url"],"createdAt":time,"sequence":sequence,"updatedAt":body["updatedAt"],"finishedAt":body["finishedAt"],"operation":body["operation"],"detail":body["detail"],"agentIds":body["agentIds"],"agentStates":body["agentStates"],"origin":body["origin"].as_str().unwrap_or("codex-app-server"),
                            "truncated":body["truncated"]==true,"action":body["action"],"queries":body["queries"],"pattern":body["pattern"],"sourceRefs":body["sourceRefs"],"resultCount":body["resultCount"],"errorCount":body["errorCount"],"errors":body["errors"],"omittedSourceCount":body["omittedSourceCount"]}));
                    }
                }
                "activity" => {
                    let id = body["id"].as_str().unwrap_or_default().to_string();
                    if body["state"] == "running" {
                        analyses.insert(id, events.len());
                        events.push(json!({"id":sequence.to_string(),"kind":"status","state":"running","label":body["label"],"createdAt":time}));
                    } else if let Some(index) = analyses.remove(&id) {
                        events[index]["state"] = json!("completed");
                        events[index]["finishedAt"] = json!(time);
                    }
                }
                "intent" => {
                    if let Some(message) = body["message"].as_str().filter(|m| !m.trim().is_empty())
                    {
                        events.push(json!({"id":sequence.to_string(),"kind":"message","state":"completed","label":message,"createdAt":time}));
                    }
                }
                "toolCall" => {
                    let id = body["stepId"]
                        .as_str()
                        .map(str::to_string)
                        .unwrap_or_else(|| sequence.to_string());
                    steps.insert(id, events.len());
                    events.push(json!({"id":sequence.to_string(),"kind":"tool","state":"running","label":title(&body,&mut title_catalog),
                        "operation":body["operation"],"toolName":body.get("name").or_else(||body.get("tool")),"serviceId":body["server"],"detail":body["query"].as_str().map(|s|s.chars().take(200).collect::<String>()),"createdAt":time}));
                }
                "selectedMaterialReadError" => {
                    events.push(json!({"id":sequence.to_string(),"kind":"context","state":"failed","origin":"hub-context",
                        "label":"添加的资料未读入","detail":body["readError"],"createdAt":time,"finishedAt":time}));
                }
                "selectedDataRead" => {
                    let locator = serde_json::from_value::<EvidenceLocator>(body["locator"].clone());
                    if locator.is_ok_and(|locator| w.grant.contains(&locator)) {
                        let title = body["title"].as_str().unwrap_or("数据附件");
                        let read = body["read"] == true;
                        events.push(json!({"id":sequence.to_string(),"kind":"context","origin":"hub-context",
                            "state":if read {"completed"} else {"failed"},
                            "label":format!("{}「{title}」",if read {"已读取数据预览"} else {"未能读取数据"}),
                            "detail":body["readError"],"createdAt":time,"finishedAt":time}));
                    }
                }
                "toolResult" | "evidence" => {
                    // A stopped native call can persist its complete outcome
                    // before the separate presentation evidence is appended.
                    if body["_hubTrace"]["schemaVersion"]==1 && store::tool_results::verify_embedded_on(c,&reader,&body,&kind).is_err() {valid=false;}
                    if matches!(
                        body["request"]["name"].as_str(),
                        Some("hub_list_note_sources" | "hub_analyze_notes" | "hub_source_manifest")
                    ) && body["snapshot"].is_string()
                    {
                        let reads = json!({"activity":{"arguments":body["request"]["arguments"],"snapshot":body["snapshot"]}});
                        if crate::source_evidence::analysis::verify_in_transaction(
                            &reader, c, &reads,
                        )
                        .is_err()
                        {
                            valid = false;
                        }
                    }
                    let excerpt = if kind == "evidence" {
                        serde_json::from_value::<EvidenceExcerpt>(body["excerpt"].clone()).ok()
                    } else {
                        None
                    };
                    if let Some(source) = &excerpt {
                            if reader.verify_in_transaction(c, &[source.clone()]).is_err() {
                                valid = false;
                            }
                            if body["request"]["stepId"].is_null()
                                && !(crate::source_evidence::local_text::is_local(&source.locator)
                                    && super::analysis::attachment_format(&source.content).is_some())
                            {
                                events.push(json!({"id":sequence.to_string(),"kind":"context","state":"completed","origin":"hub-context",
                                    "label":if body["origin"] == "hostSelectedRead" {format!("{}「{}」",if source.truncated {"已读取部分资料"} else {"已读取资料"},source.title)} else {format!("已载入材料「{}」",source.title)},
                                    "detail":if body["origin"] == "hostSelectedRead" {json!(format!("已读取 {}–{} / {} 字符，模型自行判断是否采用",source.start_char,source.end_char,source.total_chars))} else {Value::Null},"createdAt":time,"finishedAt":time}));
                            }
                    }
                    if let Some(id) = body["request"]["stepId"].as_str() {
                        if let Some(index) = steps.remove(id) {
                            if body["_hubTrace"]["schemaVersion"]==1 {
                                events[index]["resultRef"]=json!({"recordId":record_id,"sha256":body["_hubTrace"]["sha256"],"utf8Bytes":body["_hubTrace"]["utf8Bytes"]});
                            }
                            events[index]["state"] = json!(if body["error"].is_string() {
                                "failed"
                            } else {
                                "completed"
                            });
                            events[index]["finishedAt"] = json!(time);
                            if body["request"]["operation"] == "read" && !body["error"].is_string() {
                                if let Some(source) = &excerpt {
                                    events[index]["readSpan"] = json!({
                                        "title": source.title,
                                        "start": source.start_char,
                                        "end": source.end_char,
                                        "total": source.total_chars,
                                    });
                                }
                            }
                            if body["serviceTitle"].is_string() {events[index]["serviceTitle"]=body["serviceTitle"].clone();}
                            if body["sourceRefs"].is_array() {events[index]["sourceRefs"]=body["sourceRefs"].clone();}
                            if body["browser"]["truncated"]==true {events[index]["truncated"]=json!(true);events[index]["detail"]=json!("页面快照超过容量，仅保留前段；可按元素 target 缩小范围继续读取。");}
                            if let Some(error) = body["error"].as_str() {
                                events[index]["detail"] = json!(error.chars().take(300).collect::<String>());
                            }
                            if body["analysisUnit"].is_string() {
                                events[index]["detail"] = json!(format!(
                                    "本地统计处理 {}/{} 份材料，{} 个{}；{}。",
                                    body["documentsAnalyzed"],
                                    body["documentsMatched"],
                                    body["totals"]["units"],
                                    if body["analysisUnit"] == "uniqueDatePerLibrary" {
                                        "记录日（每库内去重）"
                                    } else {
                                        "文档/页面"
                                    },
                                    if body["complete"] == true {
                                        "当前范围扫描完整"
                                    } else {
                                        "有来源未读取，统计不完整"
                                    }
                                ));
                            }
                            if matches!(
                                body["kind"].as_str(),
                                Some("skillInstructions" | "skillReference")
                            ) {
                                events[index]["kind"] = json!("skill");
                                let title = body["skill"]["title"].as_str().unwrap_or("技能");
                                events[index]["label"] =
                                    json!(if body["kind"] == "skillReference" {
                                        format!("已读取「{title}」参考资料")
                                    } else {
                                        format!("已读取「{title}」技能")
                                    });
                                let origin = if body["skill"]["origin"] == "builtin" {
                                    "Hub 内置"
                                } else {
                                    "用户技能"
                                };
                                let reference = body["kind"] == "skillReference";
                                let version: String = if reference {
                                    &body["version"]
                                } else {
                                    &body["skill"]["version"]
                                }
                                .as_str()
                                .unwrap_or_default()
                                .chars()
                                .take(12)
                                .collect();
                                events[index]["detail"] = json!(format!(
                                    "{origin} · 模型选择读取 · {} {version}{}",
                                    if reference {
                                        "参考版本"
                                    } else {
                                        "技能版本"
                                    },
                                    body["path"]
                                        .as_str()
                                        .map(|p| format!(" · {p}"))
                                        .unwrap_or_default()
                                ));
                            }
                            if let Some(action) = body["actionId"].as_str() {
                                events[index]["actionId"] = json!(action);
                                if body["request"]["operation"] == "importFlashcards"
                                    && body["imported"] == true
                                {
                                    let imported =
                                        body["receipt"]["result"]["imported"].as_u64().unwrap_or(0);
                                    events[index]["label"] =
                                        json!(if body["alreadyImported"] == true {
                                            format!("已核对 {imported} 张闪卡的收件箱回执")
                                        } else {
                                            format!("已导入 {imported} 张闪卡到收件箱")
                                        });
                                    events[index]["detail"]=json!("已依据本轮工具请求和对话授权核验；待审核，未进入正式复习。");
                                }
                                let inspecting = body["request"]["operation"] == "inspectDraft";
                                let label = match body["kind"].as_str() {
                                    Some("flashcardDrafts") => Some(format!(
                                        "{} {} 张闪卡草稿",
                                        if inspecting { "核对" } else { "已准备" },
                                        body["content"]["cards"].as_array().map_or(0, Vec::len)
                                    )),
                                    Some("obsidianEdit") => Some(
                                        if inspecting {
                                            "核对笔记修改草稿"
                                        } else {
                                            "已准备笔记修改草稿"
                                        }
                                        .to_string(),
                                    ),
                                    Some("archiveCopy") => Some(
                                        if inspecting {
                                            "核对归档方案"
                                        } else {
                                            "已准备归档方案"
                                        }
                                        .to_string(),
                                    ),
                                    _ => None,
                                };
                                if let Some(label) = label {
                                    events[index]["label"] = json!(label);
                                }
                                if let Some(summary) = body["content"]["summary"].as_str() {
                                    events[index]["detail"] =
                                        json!(summary.chars().take(240).collect::<String>());
                                }
                            }
                        }
                    }
                }
                "autoInboxReceipt" => {
                    let imported: u64 = body["receipts"]
                        .as_array()
                        .map(|items| {
                            items
                                .iter()
                                .filter_map(|item| item["result"]["imported"].as_u64())
                                .sum()
                        })
                        .unwrap_or(0);
                    events.push(json!({"id":sequence.to_string(),"kind":"tool","state":"completed","label":format!("已导入 {imported} 张卡片到收件箱"),"detail":"依据本对话的明确授权；待审核，未进入正式复习。","createdAt":time,"finishedAt":time}));
                }
                _ => (),
            }
            for event in events.iter_mut().skip(before_events) {
                event["sequence"] = json!(sequence);
            }
        }
        let active = w.active_run.as_deref() == Some(run.as_str()) && state == "investigating";
        let complete_unpublished = events.iter().any(|e| e["kind"] == "unpublishedAnswer");
        events.retain(|e| {
            e["kind"] != "answer" || active || (!has_delivery && !complete_unpublished)
        });
        for event in &mut events {
            if event["kind"] == "answer" && !active {
                event["kind"] = json!("unpublishedAnswer");
            }
            if event["state"] == "running" && !active {
                event["state"] = json!("interrupted");
            }
            if !active {
                if let Some(states) = event["agentStates"].as_object_mut() {
                    for state in states.values_mut() {
                        if matches!(state["status"].as_str(), Some("running" | "pendingInit")) {
                            state["status"] = json!("interrupted");
                        }
                    }
                }
            }
        }
        // Finished model waits are replaced by the public progress message or
        // resulting tool. The clock is measured; no fake progress is produced.
        events.retain(|e| e["kind"] != "status" || e["state"] == "running");
        if !valid {
            events.retain(|e| e["kind"] == "status");
        }
        let count = events
            .iter()
            .filter(|e| e["kind"] == "tool" || e["kind"] == "skill")
            .count();
        let native:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_records WHERE run_id=?1 AND kind='nativeRuntime')",[&run],|r|r.get(0)).map_err(|e|e.to_string())?;
        let can_steer = active && can_steer_on(c, &run)?;
        result.push(json!({"workId":w.id,"currentWorkRevision":w.revision,"authorizationVersion":w.authorization_version,"runId":run,"revision":revision,"state":state,"running":active,"startedAt":started,
            "finishedAt":finished,"capabilities":runtime_capabilities,"measurement":measurement,"steps":count,"events":events,"native":native,"canSteer":can_steer,"validity":if valid{""}else{"来源已变化，这轮的过程正文已隐藏"}}));
    }
    Ok(json!(result))
}

pub(super) fn can_steer_on(c: &Connection, run: &str) -> Result<bool, String> {
    c.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_runs WHERE id=?1 AND state='investigating')
         AND EXISTS(SELECT 1 FROM agent_records WHERE run_id=?1 AND kind='nativeRuntime')
         AND EXISTS(SELECT 1 FROM agent_records WHERE run_id=?1 AND kind='nativeTurn')",
        [run],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

fn active_run(w: &Work, run: &str, state: &str) -> bool {
    w.active_run.as_deref() == Some(run) && state == "investigating"
}
fn compression_event(sequence: i64, time: i64, body: &Value, active: bool) -> Option<Value> {
    let (state, label) = match body["state"].as_str()? {
        "completed" => ("completed", "原生上下文压缩已完成"),
        "started" if active => ("running", "原生上下文压缩已开始"),
        "started" => ("interrupted", "原生上下文压缩结果尚未确认"),
        _ => return None,
    };
    Some(
        json!({"id":format!("native-context-{sequence}"),"kind":"context","origin":"codex-context-lifecycle","state":state,"label":label,
      "detail":"仅记录服务返回的公开状态；不代表已保存工作笔记，不承诺用量或耗时收益。",
      "createdAt":time,"finishedAt":if state=="completed" {json!(time)} else {Value::Null}}),
    )
}
#[cfg(test)]
mod context_lifecycle_tests {
    use super::*;
    #[test]
    fn native_answer_preview_is_uncommitted_and_replaced_by_delivery() {
        use crate::agent_work::tests::{claim, create};
        use crate::source_evidence::tests::Fixture;
        let f = Fixture::new();
        f.note("notes", "current", "来源");
        let id = create(&f, false);
        let (w, r) = claim(&f, &id);
        store::stream(
            &f.root,
            &w,
            &r,
            &json!({"id":"a","kind":"answer","text":"正在写出的文字","state":"running","origin":"deepseek","truncated":true}),
            &crate::model_runtime::Control::default(),
        )
        .unwrap();
        let read = read_on(&f.root, &f.c(), &w).unwrap();
        assert_eq!(read[0]["events"][0]["kind"], "answer");
        assert_eq!(read[0]["events"][0]["origin"], "deepseek");
        assert_eq!(read[0]["events"][0]["truncated"], true);
        assert!(store::load(&f.c(), &id).unwrap().report.is_none());
        let mut stopped = w.clone();
        stopped.active_run = None;
        f.c()
            .execute(
                "UPDATE agent_runs SET state='interrupted' WHERE id=?1",
                [&r],
            )
            .unwrap();
        assert_eq!(
            read_on(&f.root, &f.c(), &stopped).unwrap()[0]["events"][0]["kind"],
            "unpublishedAnswer"
        );
        assert_eq!(
            read_on(&f.root, &f.c(), &stopped).unwrap()[0]["events"][0]["truncated"],
            true
        );
        f.c()
            .execute(
                "UPDATE agent_runs SET state='investigating' WHERE id=?1",
                [&r],
            )
            .unwrap();
        store::record(&f.root, &r, "nativeFinal", &json!({"text":"完整答复"})).unwrap();
        f.c()
            .execute(
                "UPDATE agent_runs SET state='interrupted' WHERE id=?1",
                [&r],
            )
            .unwrap();
        let read = read_on(&f.root, &f.c(), &stopped).unwrap();
        assert_eq!(read[0]["events"].as_array().unwrap().len(), 1);
        assert_eq!(read[0]["events"][0]["label"], "完整答复");
        f.c()
            .execute(
                "UPDATE agent_runs SET state='investigating' WHERE id=?1",
                [&r],
            )
            .unwrap();
        store::record(&f.root, &r, "delivery", &json!({})).unwrap();
        f.c()
            .execute(
                "UPDATE agent_runs SET state='needsDecision' WHERE id=?1",
                [&r],
            )
            .unwrap();
        assert!(read_on(&f.root, &f.c(), &stopped).unwrap()[0]["events"]
            .as_array()
            .unwrap()
            .is_empty());
        assert!(store::stream(
            &f.root,
            &stopped,
            &r,
            &json!({"id":"a","kind":"privateReasoning","text":"hidden","state":"running"}),
            &crate::model_runtime::Control::default()
        )
        .is_err());
    }
    #[test]
    fn persisted_lifecycle_collapses_duplicates_and_keeps_stopped_start_unknown() {
        use crate::agent_work::tests::{claim, create};
        use crate::source_evidence::tests::Fixture;
        let f = Fixture::new();
        f.note("notes", "current", "合成来源");
        let id = create(&f, false);
        let (w, r) = claim(&f, &id);
        let initial = serde_json::to_value(&w).unwrap();
        let mut event = json!({"schemaVersion":1,"origin":"publicLifecycle","threadId":"own","turnId":"compression","itemId":"item","state":"started"});
        store::record(&f.root, &r, "nativeContextLifecycle", &event).unwrap();
        let read = read_on(&f.root, &f.c(), &w).unwrap();
        assert_eq!(read[0]["events"][0]["state"], "running");
        let mut inactive = w.clone();
        inactive.active_run = None;
        let read = read_on(&f.root, &f.c(), &inactive).unwrap();
        assert_eq!(read[0]["events"][0]["state"], "interrupted");
        event["state"] = json!("completed");
        store::record(&f.root, &r, "nativeContextLifecycle", &event).unwrap();
        event["state"] = json!("started");
        store::record(&f.root, &r, "nativeContextLifecycle", &event).unwrap();
        let read = read_on(&f.root, &f.c(), &inactive).unwrap();
        assert_eq!(read[0]["events"].as_array().unwrap().len(), 1);
        assert_eq!(read[0]["events"][0]["state"], "completed");
        assert_eq!(
            serde_json::to_value(store::load(&f.c(), &w.id).unwrap()).unwrap(),
            initial
        );
        assert_eq!(
            f.c()
                .query_row("SELECT count(*) FROM agent_actions", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn lifecycle_projection_never_promotes_start_or_request_to_completion() {
        assert!(compression_event(1, 1, &json!({"state":"requested"}), false).is_none());
        let unfinished = compression_event(1, 1, &json!({"state":"started"}), false).unwrap();
        assert_eq!(unfinished["state"], "interrupted");
        assert!(unfinished["finishedAt"].is_null());
        assert!(unfinished["label"].as_str().unwrap().contains("尚未确认"));
        assert_eq!(
            compression_event(1, 1, &json!({"state":"started"}), true).unwrap()["state"],
            "running"
        );
        assert_eq!(
            compression_event(2, 2, &json!({"state":"completed"}), false).unwrap()["finishedAt"],
            2
        );
    }
}
