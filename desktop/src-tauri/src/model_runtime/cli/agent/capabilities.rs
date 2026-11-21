//! Explicit per-conversation grants. No user config, credentials or source paths
//! are inherited by the native workspace. Business writes remain Hub callbacks.
use super::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeCapabilities {
    #[serde(default)]
    pub workspace: bool,
    #[serde(default)]
    pub multi_agent: bool,
}
impl NativeCapabilities {
    pub(crate) fn workspace_file(
        workspace: &Path,
        path: &Path,
    ) -> Result<std::path::PathBuf, String> {
        let workspace = std::fs::canonicalize(workspace).map_err(|_| "工作区不可用")?;
        let resolved =
            std::fs::canonicalize(workspace.join(path)).map_err(|_| "工作区文件不可用")?;
        if !resolved.starts_with(&workspace) || !resolved.is_file() {
            return Err("文件不在当前授权工作区".into());
        }
        Ok(resolved)
    }

    pub(crate) fn disabled(&self) -> bool {
        !self.workspace && !self.multi_agent
    }
    pub(crate) fn validate(&self, external_mcp: bool, frozen_budget: bool) -> Result<(), String> {
        if self.disabled() {
            return Ok(());
        }
        if !cfg!(windows) {
            return Err("当前平台尚未验证原生工作区隔离".into());
        }
        if !self.workspace {
            return Err("子代理需要本对话的独立工作区授权".into());
        }
        if external_mcp {
            return Err("原生工作区暂不与替代 MCP 通道组合；请选择 Hub 内置连接".into());
        }
        if self.multi_agent && frozen_budget {
            return Err("当前冻结额度尚不能完整计量原生子代理；未启动运行".into());
        }
        Ok(())
    }
    pub(crate) fn configure(&self, directory: &Path) -> Result<(), String> {
        if self.disabled() {
            let path = directory.join("home/config.toml");
            if path.exists() {
                std::fs::write(path, "").map_err(|_| "无法撤销原生工作区策略")?;
            }
            return Ok(());
        }
        self.validate(false, false)?;
        let home = directory.join("home");
        std::fs::create_dir_all(&home).map_err(|_| "无法准备原生工作区策略")?;
        // Read access is minimal, not the workspace-write profile's broad disk
        // reads. Fail closed if this installed runtime cannot enforce MXC.
        std::fs::write(home.join("config.toml"), "default_permissions = 'hub-workspace'\n[windows]\nsandbox = 'mxc'\n[permissions.hub-workspace.filesystem]\n':minimal' = 'read'\n':workspace_roots' = 'write'\n[permissions.hub-workspace.network]\nenabled = false\n").map_err(|_| "无法保存原生工作区策略".into())
    }
    pub(crate) fn thread_config(&self, params: &mut Value) {
        if self.disabled() {
            return;
        }
        params.as_object_mut().unwrap().remove("sandbox");
        params["permissions"] = json!("hub-workspace");
        for (key, enabled) in [
            ("shell_tool", true),
            ("unified_exec", true),
            ("view_image", true),
            ("multi_agent", self.multi_agent),
            ("multi_agent_v2", false),
        ] {
            params["config"][format!("features.{key}")] = json!(enabled);
        }
        params["config"]["agents.max_threads"] = json!(2);
        params["config"]["agents.max_depth"] = json!(1);
        params["config"]["shell_environment_policy.inherit"] = json!("none");
        params["config"]["shell_environment_policy.include_only"] =
            json!(["SystemRoot", "WINDIR", "SystemDrive", "COMSPEC", "PATHEXT"]);
        let workspace = params["cwd"].clone();
        let mut environment = serde_json::Map::new();
        for key in ["SYSTEMROOT", "WINDIR", "SystemDrive", "COMSPEC", "PATHEXT"] {
            if let Ok(value) = std::env::var(key) {
                environment.insert(key.into(), json!(value));
            }
        }
        environment.insert("TEMP".into(), workspace.clone());
        environment.insert("TMP".into(), workspace);
        params["config"]["shell_environment_policy.set"] = json!(environment);
        let guide = "\n原生工作区：仅此对话的独立目录可读写，网络关闭，不开放原资料库、宿主配置或凭据。可运行脚本和管理工作区文件；依赖安装仅能使用工作区已有的离线材料。Hub 原文须通过已授权 Hub 工具读取；原生文件修改不是来源写回、归档或业务保存回执。最终答复须区分工作区产物和已核验业务成果。子代理仅协助工作区任务，不能调用 Hub 业务工具或请求扩大权限；在返回最终答复前等待或关闭所有子代理。";
        let instructions = params["developerInstructions"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        params["developerInstructions"] = json!(format!("{instructions}{guide}"));
    }
}

/// Only typed public items cross into Hub's durable timeline. Raw reasoning,
/// arbitrary plugin payloads and unknown protocol fields are never projected.
pub(super) fn activity(item: &Value, completed: bool) -> Option<Value> {
    if item["type"] == "subAgentActivity" {
        let child = item["agentThreadId"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 150)?;
        let (state, label) = match item["kind"].as_str() {
            Some("completed") => ("completed", "子代理已完成"),
            Some("interrupted") => ("interrupted", "子代理已中断"),
            _ => ("running", "子代理处理工作区任务"),
        };
        return Some(
            json!({"id":format!("native-agent-{child}"),"kind":"tool","operation":"delegate","text":label,"state":state,"origin":"codex-native","agentIds":[child],"agentStates":{(child):{"status":state}},"agentPath":item["agentPath"].as_str().unwrap_or_default().chars().take(150).collect::<String>()}),
        );
    }
    let key = item["id"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 256)?;
    let (operation, label) = match item["type"].as_str()? {
        "commandExecution" => ("command", "运行工作区命令"),
        "fileChange" => ("edit", "编辑工作区文件"),
        "imageView" => (
            "viewImage",
            if completed {
                "已查看 1 张图像"
            } else {
                "查看图像"
            },
        ),
        "collabAgentToolCall" => (
            "delegate",
            match item["tool"].as_str() {
                Some("spawnAgent") => "委派子代理",
                Some("wait") => "等待子代理",
                Some("closeAgent") => "关闭子代理",
                _ => "协调子代理",
            },
        ),
        _ => return None,
    };
    let state = match item["status"].as_str() {
        Some("failed" | "declined") => "failed",
        Some("interrupted") => "interrupted",
        _ if completed => "completed",
        _ => "running",
    };
    let detail = if operation == "command" {
        let command = item["command"].as_str().unwrap_or_default();
        let exit = item["exitCode"]
            .as_i64()
            .map(|v| format!("\n退出码 {v}"))
            .unwrap_or_default();
        format!("{}{exit}", command.chars().take(2000).collect::<String>())
    } else if operation == "edit" {
        item["changes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v["path"].as_str())
            .take(20)
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        String::new()
    };
    let mut event = json!({"id":format!("native-{key}"),"kind":"tool","operation":operation,"text":label,"detail":detail,"state":state,"origin":"codex-native"});
    if operation == "command" {
        if let Some(exit_code) = item["exitCode"].as_i64() {
            event["exitCode"] = json!(exit_code);
        }
    }
    if operation == "delegate" {
        event["agentIds"] = json!(item["receiverThreadIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|s| s.len() <= 150)
            .take(8)
            .collect::<Vec<_>>());
        let states: serde_json::Map<String, Value> = item["agentsStates"]
            .as_object()
            .into_iter()
            .flatten()
            .take(8)
            .filter(|(id, _)| id.len() <= 150)
            .map(|(id, state)| {
                (
                    id.clone(),
                    json!({"status":state["status"].as_str().unwrap_or("unknown")}),
                )
            })
            .collect();
        if completed
            && states
                .values()
                .any(|s| matches!(s["status"].as_str(), Some("errored" | "notFound")))
        {
            event["state"] = json!("failed");
        }
        event["agentStates"] = json!(states);
    }
    Some(event)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn grants_fail_closed_and_never_use_broad_workspace_sandbox() {
        let grant = NativeCapabilities {
            workspace: true,
            multi_agent: true,
        };
        assert!(grant.validate(false, true).is_err());
        assert!(grant.validate(true, false).is_err());
        assert!(NativeCapabilities {
            workspace: false,
            multi_agent: true
        }
        .validate(false, false)
        .is_err());
        let mut params = json!({"sandbox":"read-only","cwd":"workspace","developerInstructions":"Hub","config":{}});
        grant.thread_config(&mut params);
        assert!(params.get("sandbox").is_none());
        assert_eq!(params["permissions"], "hub-workspace");
        assert_eq!(params["config"]["agents.max_depth"], 1);
        assert_eq!(params["config"]["shell_environment_policy.inherit"], "none");
    }
    #[test]
    fn public_native_events_preserve_failure_and_agent_identity() {
        let child=activity(&json!({"id":"activity","type":"subAgentActivity","kind":"completed","agentThreadId":"actual-child","agentPath":"/root/review"}),true).unwrap();
        assert_eq!(child["agentIds"][0], "actual-child");
        assert_eq!(child["state"], "completed");
        let e=activity(&json!({"id":"cmd","type":"commandExecution","command":"exit 9","exitCode":9,"status":"failed"}),true).unwrap();
        assert_eq!(e["state"], "failed");
        assert_eq!(e["operation"], "command");
        assert_eq!(e["exitCode"], 9);
        let e=activity(&json!({"id":"a","type":"collabAgentToolCall","receiverThreadIds":["child"],"agentsStates":{"child":{"status":"errored"}}}),true).unwrap();
        assert_eq!(e["agentIds"][0], "child");
        assert!(activity(
            &json!({"id":"r","type":"reasoning","content":["private"]}),
            true
        )
        .is_none());
    }

    #[test]
    #[ignore = "explicit installed Codex native workspace acceptance; uses actual project document, model quota"]
    fn installed_native_workspace_and_delegation() {
        let report = std::env::var("HUB_NATIVE_ACCEPTANCE_REPORT").expect("explicit report path");
        let directory = std::env::temp_dir().join(format!(
            "hub-codex-suite-native-{}",
            crate::random_url_safe(12)
        ));
        std::fs::create_dir_all(directory.join("workspace")).unwrap();
        let _cleanup = super::super::super::JobDir(directory.clone());
        let source =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/AGENT_RESPONSIBILITIES.md");
        std::fs::copy(
            &source,
            directory.join("workspace/AGENT_RESPONSIBILITIES.md"),
        )
        .unwrap();
        let mut events = Vec::new();
        let identity = authentication_identity().unwrap();
        let result = run(Request {
            directory:&directory,authentication_identity:&identity,auth_root:None,auth_selection:None,
            thread:None,instructions:"请核对工作区内实际的 AGENT_RESPONSIBILITIES.md，给出模型与宿主职责的中文摘要。必须先运行一个原生命令读取文档并统计标题数量，保存 responsibilities-summary.md。再委派一个子代理独立核对职责边界，等待其结束后汇总。不得读取工作区外的文件；不得联网。若工具不可用，如实报告。",
            input:"执行上述职责文档核对，实际运行命令、保存摘要，并完成一次子代理复核。",image_input:&[],tools:json!([]),compact_before_turn:false,external_mcp:false,web_search:web::Mode::Disabled,
            native_capabilities:NativeCapabilities{workspace:true,multi_agent:true},
        },"","high",false,&Control::bounded(Duration::from_secs(240)),|kind,value|{
            if kind=="event" || kind=="childUsage" || kind=="finalMessage" {events.push(json!({"kind":kind,"value":value}));}
            Ok(if kind=="poll" {json!([])}else{Value::Null})
        });
        let saved = directory
            .join("workspace/responsibilities-summary.md")
            .is_file();
        let evidence = json!({"result":result,"events":events,"artifactExists":saved});
        std::fs::write(report, serde_json::to_vec_pretty(&evidence).unwrap()).unwrap();
        assert!(result.is_ok(), "{result:?}");
        assert!(saved, "model did not produce requested workspace artifact");
        assert!(events
            .iter()
            .any(|v| v["value"]["operation"] == "command" && v["value"]["state"] == "completed"));
        assert!(events
            .iter()
            .any(|v| v["value"]["operation"] == "delegate" && v["value"]["state"] == "completed"));
        assert!(
            events.iter().any(|v| v["value"]["agentIds"]
                .as_array()
                .is_some_and(|ids| !ids.is_empty())),
            "subagent identity was not observed"
        );
    }
}
