//! One explicitly issued Work capability, for an independently owned MCP client.
//! This first lane only reads saved work and submits a checked report.
use super::*;
use rusqlite::OptionalExtension;
use std::path::PathBuf;

pub(crate) struct WorkSession {
    root: PathBuf,
    work: Work,
    run: String,
    context: Context,
    specs: Value,
    ledger: bytes::Ledger,
    view: view::View,
    guidance: guidance::GuidanceRef,
    catalog: Value,
    finished: bool,
    sequence: u64,
    pending: Option<Value>,
}
fn hash(v: &str) -> String {
    format!("{:x}", Sha256::digest(v.as_bytes()))
}
fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn instructions() -> String {
    format!("{INSTRUCTIONS}\n本会话由用户显式授权，仅核对保存成果并补报告。先调用hub_workContext取得真实目标与原文。不重新提取、重算、修改记录，不执行业务写入；hub_finish经Hub事务校验后发布到原事项。外部客户端用量未核实时保持原预留。")
}

impl WorkSession {
    pub(crate) fn prepare(root: &Path, args: &Value) -> Result<Value, String> {
        if args["purpose"] != "finishSavedReport" {
            return Err("外部会话仅支持核对保存成果并补交报告".into());
        }
        let id = text(args, "id", 150)?;
        let run = format!("run-{}", crate::random_url_safe(18));
        let token = crate::random_url_safe(32);
        let expires = now() + 120_000;
        let mut budget = assistant::budget_for_work(root, &id, "quick")?;
        budget.model_calls = 1;
        budget.output_repair_calls = 0;
        budget.seconds = 120;
        budget.model_call_seconds = 90;
        let work = store::write(root, |c| {
            let w = store::load(c, &id)?;
            if args["expectedWorkRevision"] != w.revision
                || args["expectedAuthorizationVersion"] != w.authorization_version
                || w.report.as_ref().is_some_and(|r| r.status == "completed")
            {
                return Err("事项版本已变化或报告已完成，未建立外部会话".into());
            }
            let saved:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_records WHERE work_id=?1 AND kind='workingState')",[&id],|r|r.get(0)).map_err(|e|e.to_string())?;
            if !saved {
                return Err("本入口需要已保存的工作记录，不能替代首次分析".into());
            }
            let w = store::claim_on(c, &id, &run)?;
            store::execution_budget::reserve_on(c, &w, &run, budget)?;
            store::insert(
                c,
                &id,
                Some(&run),
                "agentProtocol",
                &json!({"version":1,"transport":"independentClientMcp","purpose":"finishSavedReport"}),
            )?;
            store::insert(
                c,
                &id,
                Some(&run),
                "externalReportLease",
                &json!({"schemaVersion":1,"tokenHash":hash(&token),"expiresAt":expires,"workRevision":w.revision,"authorizationVersion":w.authorization_version,"budget":budget}),
            )?;
            store::insert(c, &id, Some(&run), "budget", &json!(budget))?;
            Ok(w)
        })?;
        Ok(
            json!({"workId":work.id,"runId":run,"expiresAt":expires,"purpose":"finishSavedReport",
            "prompt":"通过本次Hub MCP会话补交已保存工作的报告。先调用hub_workContext，按其中的真实用户要求、固定方法、原文、已有数据及工作记录核对并调用hub_finish；不要重新抽取、重算或改写记录，不调用其它MCP或文件/终端工具。最终确认保存后简短结束。",
            "mcpServer":{"command":std::env::current_exe().map_err(|_|"无法核对运行程序")?,"args":["--mcp","--data-dir",root],"env":{"HUB_EXTERNAL_WORK_TOKEN":token},"enabled":true,"required":true,"startup_timeout_sec":20,"tool_timeout_sec":100}}),
        )
    }

    pub(in crate::agent_work) fn live_on(
        c: &rusqlite::Connection,
        w: &Work,
        run: &str,
    ) -> Result<bool, String> {
        let raw:Option<String>=c.query_row("SELECT body_json FROM agent_records WHERE run_id=?1 AND kind='externalReportLease' ORDER BY rowid DESC LIMIT 1",[run],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        let Some(raw) = raw else { return Ok(false) };
        let v: Value = serde_json::from_str(&raw).map_err(|_| "外部会话身份损坏")?;
        Ok(v["schemaVersion"] == 1
            && v["expiresAt"].as_i64().is_some_and(|t| t > now())
            && v["workRevision"] == w.revision
            && v["authorizationVersion"] == w.authorization_version)
    }

    pub(crate) fn open(root: &Path, token: &str) -> Result<Self, String> {
        if token.len() != 43 {
            return Err("外部会话能力身份无效".into());
        }
        let (work, run, budget, expires) = store::write(root, |c| {
            let (id,run,raw):(String,String,String)=c.query_row("SELECT work_id,run_id,body_json FROM agent_records WHERE kind='externalReportLease' AND json_extract(body_json,'$.tokenHash')=?1",[hash(token)],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|_|"外部会话能力不存在")?;
            let w = store::load(c, &id)?;
            let v: Value = serde_json::from_str(&raw).map_err(|_| "外部会话能力损坏")?;
            if w.active_run.as_deref() != Some(&run) || !Self::live_on(c, &w, &run)? {
                return Err("外部会话已失效，原成果保留".into());
            }
            let consumed:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_records WHERE run_id=?1 AND kind='externalReportLeaseClaimed')",[&run],|r|r.get(0)).map_err(|e|e.to_string())?;
            if consumed {
                return Err("外部会话已连接，不能重复使用能力身份".into());
            }
            store::insert(
                c,
                &id,
                Some(&run),
                "externalReportLeaseClaimed",
                &json!({"processId":std::process::id(),"claimedAt":now()}),
            )?;
            let b: Budget =
                serde_json::from_value(v["budget"].clone()).map_err(|_| "外部会话预算损坏")?;
            Ok((
                w,
                run,
                b,
                v["expiresAt"].as_i64().ok_or("外部会话时限缺失")?,
            ))
        })?;
        let control = Control::bounded(Duration::from_millis(
            ((expires - now()).max(1) as u64).min(budget.model_call_seconds * 1000),
        ));
        let permit = crate::library_runtime::cached_read_permit(root)?;
        let control = control.guarded(move || permit.checkpoint());
        let opened: Result<_, String> = (|| {
            let mut context = Context {
                reader: work.grant.reader(root)?.controlled(control.clone()),
                excerpts: Vec::new(),
                entities: HashSet::new(),
                observations: Vec::new(),
                usage: Usage::default(),
                control: control.clone(),
                budget,
                candidates: Vec::new(),
                search_read_available: false,
                skills: Some(
                    crate::hub_capabilities::Session::new(root, Some(work.grant.scope()?))?
                        .controlled(control.clone()),
                ),
                skill_request: work.goal.clone(),
            };
            super::super::super::topics::attach_runtime(root, &work, &run, &mut context.skills)?;
            let catalog = context.reader.catalog()?;
            if let Some(anchor) = &work.anchor {
                let e = context
                    .reader
                    .read(anchor, 0, budget.body_chars.min(20_000), None)?;
                let e = context.remember(e)?;
                store::record(root, &run, "evidence", &e)?;
            }
            let mut specs = tools(context.skills.as_ref())?;
            specs.as_array_mut().unwrap().retain(|v| {
                matches!(
                    v["name"].as_str(),
                    Some(
                        "hub_loadSkill"
                            | "hub_readSkillReference"
                            | "hub_read_note"
                            | "hub_read_analysis_snapshot"
                            | "hub_sleepDataset"
                            | "hub_chart"
                            | "hub_workingState"
                            | "hub_goalState"
                            | "hub_finish"
                    )
                )
            });
            for spec in specs.as_array_mut().unwrap() {
                if matches!(
                    spec["name"].as_str(),
                    Some("hub_sleepDataset" | "hub_chart" | "hub_workingState")
                ) {
                    if let Some(variants) =
                        spec["inputSchema"]["properties"]["request"]["anyOf"].as_array_mut()
                    {
                        variants.retain(|v| {
                            v["properties"]["action"]["enum"]
                                .as_array()
                                .is_some_and(|a| a.iter().all(|v| v == "read"))
                        });
                    }
                }
            }
            specs.as_array_mut().unwrap().insert(0,json!({"name":"hub_workContext","description":"读取本次获准事项的真实目标、完整已读锚点原文、出处编号和已有成果入口。sleepDatasets/charts给出当前可读的既有成果身份及修订，读取时使用其中的身份，不猜ID或新建成果。现有数据/工作记录应复用；仅核对并补报告，不增加授权。","inputSchema":{"type":"object","properties":{},"additionalProperties":false}}));
            specs=json!(specs.as_array().unwrap().iter().map(|v|json!({"name":v["name"],"description":v["description"],"inputSchema":v["inputSchema"]})).collect::<Vec<_>>());
            let ledger = bytes::Ledger::new(
                "",
                &json!({}),
                &specs,
                &instructions(),
                budget.request_bytes,
            );
            ledger.check()?;
            let mut guidance =
                guidance::GuidanceRef::new(&context.skills.as_ref().unwrap().guidance());
            guidance.invalidate();
            let session = assistant::Session {
                root,
                work: &work,
                run: &run,
                control: &control,
                operation: None,
                selection: Value::Null,
                app: None,
            };
            let estimate = preflight::evaluate(&context, &session, &guidance, &ledger, &json!([]))?;
            let estimate = preflight::mcp_setup(
                estimate,
                ledger.total(),
                ledger.limit,
                crate::model_runtime::agent_mcp_startup_bytes(&specs, &instructions())?,
            );
            store::record(root, &run, "externalMaterialPreflight", &estimate)?;
            preflight::enforce(&estimate)?;
            store::provider_budget::admit_after_preflight(root, &work, &run)?;
            store::record(
                root,
                &run,
                "nativeRuntime",
                &json!({"runtime":"external-client-work-mcp","modelStartedByHost":false,"providerOwnership":"independentClient","protocol":1}),
            )?;
            let skills = context.skills.as_ref().unwrap();
            store::record(
                root,
                &run,
                "skillCatalog",
                &json!({"catalog":skills.metadata(),"fingerprint":skills.fingerprint()}),
            )?;
            store::record(root, &run, "libraryRules", &skills.guidance())?;
            Ok((context, specs, ledger, guidance, catalog))
        })();
        match opened {
            Ok((context, specs, ledger, guidance, catalog)) => Ok(Self {
                root: root.into(),
                work,
                run,
                context,
                specs,
                ledger,
                view: Default::default(),
                guidance,
                catalog,
                finished: false,
                sequence: 0,
                pending: None,
            }),
            Err(error) => {
                let _ = store::fail(root, &work, &run, &error);
                Err(error)
            }
        }
    }

    pub(crate) fn scope(&self) -> Result<crate::source_evidence::EvidenceScope, String> {
        self.work.grant.scope()
    }
    pub(crate) fn tools(&self) -> Value {
        json!({"tools":self.specs})
    }
    pub(crate) fn instructions(&self) -> String {
        instructions()
    }

    fn check(&self) -> Result<(), String> {
        self.context.control.check()?;
        store::check_run(&self.root, &self.work, &self.run)?;
        self.context.skills.as_ref().unwrap().verify()?;
        if self.context.reader.catalog()? != self.catalog {
            return Err("来源资格已变化".into());
        }
        self.context
            .reader
            .verify_bundle(&self.context.excerpts, &self.context.candidates)
    }
    pub(crate) fn call(&mut self, name: &str, args: &Value) -> Result<Value, String> {
        self.check()?;
        if self.pending.is_some() {
            return Err("前一工具回执尚未完成发送".into());
        }
        let spec = self
            .specs
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["name"] == name)
            .ok_or("工具不属于本事项授权")?;
        crate::model_runtime::validate_agent_tool(args, &spec["inputSchema"])?;
        if self.context.usage.tool_steps >= self.context.budget.tool_steps {
            return Err("外部会话工具步骤预算已用尽".into());
        }
        self.sequence += 1;
        let call = format!("external-{}", self.sequence);
        if name == "hub_finish" {
            self.ledger.check()?;
            let normalized = assistant::normalize(
                json!({"rationale":"","requests":[],"report":args}),
                &json!(quotes::catalog(&self.context.excerpts)),
            )?;
            let report: Report =
                serde_json::from_value(normalized["report"].clone()).map_err(|_| "报告格式无效")?;
            validate(&report, &self.context.excerpts)?;
            let binding = store::goal::for_run(&self.root, &self.work, &self.run)?;
            let assessment =
                store::goal::accept_report(&self.root, &self.work, &self.run, &report, &binding)?;
            self.context.skills.as_ref().unwrap().verify()?;
            store::usage(&self.root, &self.run, &self.context.usage())?;
            store::publish(
                &self.root,
                &self.work,
                &self.run,
                &report,
                &self.context.excerpts,
                &self.context.candidates,
                &actions::receipts(&self.root, &self.work.id)?,
                &self.context.skills.as_ref().unwrap().material_reads(),
                &self.context.control,
            )?;
            self.finished = true;
            return Ok(
                json!({"accepted":true,"published":true,"workFulfillment":assessment["workFulfillment"],"providerUsageSettled":false}),
            );
        }
        let raw = if name == "hub_workContext" {
            self.context.usage.tool_steps += 1;
            store::record(
                &self.root,
                &self.run,
                "toolCall",
                &json!({"operation":"workContext","stepId":call}),
            )?;
            let mut context = json!({"conversation":store::conversation::context(&self.root,&self.work)?,"readEvidence":self.context.excerpts,"sleepDatasets":artifacts::sleep::manifest_on(&self.root,&crate::source_evidence::open_read_database(&self.root)?,&self.work)?,"charts":artifacts::manifest_on(&self.root,&crate::source_evidence::open_read_database(&self.root)?,&self.work)?,"goalState":store::goal::completion::read_context(&self.root,&self.work,&self.run)?,"executionPurpose":"finishSavedReport; reuse data and record; no re-extraction, recalculation or actions"});
            if crate::agent_work::skills::mcp_sharing_enabled(&self.root).unwrap_or(false) {
                context["method"] = self.context.skills.as_ref().unwrap().metadata();
            }
            context
        } else {
            if matches!(name, "hub_sleepDataset" | "hub_chart" | "hub_workingState")
                && args["request"]["action"] != "read"
            {
                return Err("外部报告会话只允许读取现有成果".into());
            }
            let value = json!({"tool":name,"callId":call,"arguments":args});
            let tool = arguments::decode(
                &self.root,
                &self.run,
                &self.specs,
                &value,
                &mut self.context.usage.tool_steps,
                self.context.budget.tool_steps,
            )?
            .map_err(|v| v.to_string())?;
            let mut request = json!(tool);
            request["stepId"] = json!(call);
            store::record(&self.root, &self.run, "toolCall", &request)?;
            let result = match tool {
                Tool::Search { .. }
                | Tool::Read { .. }
                | Tool::LoadSkill { .. }
                | Tool::ReadSkillReference { .. }
                | Tool::Capability { .. } => self.context.dispatch(tool),
                tool => {
                    self.context.usage.tool_steps += 1;
                    assistant::Session {
                        root: &self.root,
                        work: &self.work,
                        run: &self.run,
                        control: &self.context.control,
                        operation: None,
                        selection: Value::Null,
                        app: None,
                    }
                    .dispatch_for_capture(tool)
                }
            };
            let raw = result.unwrap_or_else(|e| json!({"error":e,"origin":"host"}));
            let reference =
                store::tool_results::capture(&self.root, &self.work.id, &self.run, &request, &raw)?;
            json!({"result":raw,"toolResultRef":reference})
        };
        let raw = if name == "hub_workContext" {
            let reference = store::tool_results::capture(
                &self.root,
                &self.work.id,
                &self.run,
                &json!({"operation":"workContext","stepId":call}),
                &raw,
            )?;
            json!({"result":raw,"toolResultRef":reference})
        } else {
            raw
        };
        let output = json!({"result":raw,"quoteCatalog":quotes::catalog(&self.context.excerpts),"knowledgeRules":self.context.skills.as_ref().unwrap().guidance(),"businessActionRecords":[],"remainingToolSteps":self.context.budget.tool_steps.saturating_sub(self.context.usage.tool_steps)});
        let wire = self.guidance.project_for(output.clone(), &call);
        self.ledger.tool(&output, &wire);
        self.ledger.check()?;
        self.context.usage.request_bytes = self.ledger.total();
        store::usage(&self.root, &self.run, &self.context.usage())?;
        store::record(
            &self.root,
            &self.run,
            "nativeMaterialUsage",
            &self.ledger.snapshot("externalToolReturn"),
        )?;
        self.view
            .prepare(&self.root, &self.work, &self.run, &call, &wire, false)?;
        self.pending = Some(
            json!({"callId":call,"outputSha256":hash(&wire.to_string()),"outputUtf8Bytes":wire.to_string().len(),"transport":"mcpStdio"}),
        );
        Ok(wire)
    }
    pub(crate) fn flushed(&mut self) -> Result<(), String> {
        if let Some(event) = self.pending.take() {
            self.view.sent(&self.root, &self.run, &event)?;
            self.guidance.sent(event["callId"].as_str().unwrap());
        }
        Ok(())
    }
    pub(crate) fn checkpoint(&self) -> Result<(), String> {
        if self.finished {
            self.context.control.check()
        } else {
            self.check()
        }
    }
    pub(crate) fn outgoing(&mut self, request: &Value, response: &Value) -> Result<(), String> {
        if self.finished {
            return Ok(());
        } // Preserve the existing finish-ack exclusion.
        if request["method"] == "initialize" {
            store::record(
                &self.root,
                &self.run,
                "externalClient",
                &json!({"transport":"mcpStdio","declaredName":request["params"]["clientInfo"]["name"].as_str().unwrap_or("").chars().take(256).collect::<String>(),"declaredVersion":request["params"]["clientInfo"]["version"].as_str().unwrap_or("").chars().take(256).collect::<String>(),"identityProof":"one-use host-issued Work capability; clientInfo is self-declared"}),
            )?;
        }
        let counted = match request["method"].as_str() {
            Some("initialize") => self.ledger.instructions,
            Some("tools/list") => self.ledger.tools,
            Some("tools/call") => self
                .pending
                .as_ref()
                .and_then(|v| v["outputUtf8Bytes"].as_u64())
                .unwrap_or(0) as usize,
            _ => 0,
        };
        let bytes = response.to_string().len() + 1;
        if bytes > 524288 {
            return Err("外部MCP响应超过单帧容量".into());
        }
        self.ledger.protocol = self
            .ledger
            .protocol
            .checked_add(bytes.saturating_sub(counted))
            .ok_or("MCP计量溢出")?;
        self.context.usage.request_bytes = self.ledger.total();
        store::record(
            &self.root,
            &self.run,
            "nativeMaterialUsage",
            &self.ledger.snapshot("externalMcpFraming"),
        )?;
        store::usage(&self.root, &self.run, &self.context.usage())?;
        self.ledger.check()
    }
}
impl Drop for WorkSession {
    fn drop(&mut self) {
        if !self.finished {
            let _ = store::fail(
                &self.root,
                &self.work,
                &self.run,
                "外部报告会话结束，未完成发布；原成果和用量预留保留",
            );
        }
    }
}

#[cfg(test)]
mod tests;
