//! Connected Apps use the selected Codex account's hosted credentials. The
//! complete gateway catalog is never a grant and is never sent to the model.
use super::*;

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Binding {
    pub account_scope: String,
    pub connection_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub write_repository: Option<String>,
}

pub(crate) const GITHUB: &str = "app:connector_76869538009648d5b282a4bb21c3d157";
pub(crate) const COMMENT: &str = "github.add_comment_to_issue";
pub(crate) fn is_write(grant: &Grant, tool: &str) -> bool {
    grant.server == GITHUB && tool == COMMENT
}
fn repository(value: &str) -> bool {
    let parts: Vec<_> = value.split('/').collect();
    parts.len() == 2
        && parts.iter().all(|s| {
            !s.is_empty()
                && s.len() <= 100
                && *s != "."
                && *s != ".."
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        })
}

fn digest(value: &Value) -> String {
    let mut value = value.clone();
    value.sort_all_objects();
    format!("{:x}", sha2::Sha256::digest(value.to_string().as_bytes()))
}

pub(super) fn connector(server: &str) -> Result<&str, String> {
    server
        .strip_prefix("app:")
        .filter(|id| {
            id.starts_with("connector_")
                && id.len() <= 128
                && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        })
        .ok_or_else(|| "连接器身份无效".into())
}

pub(super) fn validate(grant: &Grant) -> Result<(), String> {
    connector(&grant.server)?;
    let binding = grant
        .app_binding
        .as_ref()
        .ok_or("连接器缺少账号授权，请重新发现")?;
    if binding
        .write_repository
        .as_deref()
        .is_some_and(|r| !repository(r))
        || (grant.tools.iter().any(|t| is_write(grant, t)) && binding.write_repository.is_none())
    {
        return Err("GitHub 写入工具须明确选择一个 owner/repository 目标仓库".into());
    }
    if binding.account_scope.is_empty()
        || binding.account_scope.len() > 200
        || !hash(&binding.connection_sha256)
        || !hash(&grant.catalog_sha256)
        || grant.tools.is_empty()
        || grant.tools.len() > 64
        || grant.tools.iter().any(|t| !custom::tool_name(t))
        || grant.tools.iter().collect::<HashSet<_>>().len() != grant.tools.len()
        || !grant.resource_uris.is_empty()
        || grant.trusted_read_only
    {
        return Err("连接器授权无效；请重新选择账号和工具".into());
    }
    Ok(())
}
fn hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

struct Session {
    // Drop the process before deleting its ephemeral home.
    process: Process,
    _cleanup: super::super::super::JobDir,
    scope: String,
    thread: Option<String>,
}

fn connect(root: &Path, selected: Option<&str>, control: &Control) -> Result<Session, String> {
    let prepared = authentication::current_for(Some(root), selected)?;
    let auth: Value = serde_json::from_slice(&prepared.bytes).map_err(|_| "账号授权无效")?;
    let scope = auth["scopeId"]
        .as_str()
        .ok_or("连接器需要 ChatGPT 登录账号；当前 API Key 不支持，未切换账号")?
        .to_owned();
    let directory = std::env::temp_dir().join(format!(
        "hub-codex-suite-apps-{}",
        crate::random_url_safe(12)
    ));
    std::fs::create_dir(&directory).map_err(|_| "无法创建连接器会话")?;
    let cleanup = super::super::super::JobDir(directory.clone());
    let identity = prepared.identity.clone();
    let mut process = spawn_profile(
        &directory,
        &identity,
        prepared,
        "",
        "",
        false,
        control,
        Default::default(),
        true,
    )?;
    process.rpc("initialize", "initialize", json!({"clientInfo":{"name":"hub_apps_client","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true,"explicitGatewayOauth":true}}), control)?;
    process.send(json!({"method":"initialized"}))?;
    let login = process.login.take().ok_or("连接器账号未就绪")?;
    process.rpc("login", "account/login/start", login, control)?;
    Ok(Session {
        process,
        _cleanup: cleanup,
        scope,
        thread: None,
    })
}

/// Use the callable gateway catalog rather than the marketplace's eventually
/// consistent app/list or cold app/installed snapshot. This sidecar has no
/// model turn: listing schemas cannot grant the conversation any tools.
pub(crate) fn list(root: &Path, control: &Control) -> Result<Value, String> {
    let mut session = connect(root, None, control)?;
    let response = start(&mut session, "", control)?;
    let rows = response["data"].as_array().ok_or("应用目录缺失")?;
    if !response["nextCursor"].is_null() {
        return Err("应用目录不完整".into());
    }
    let row = rows
        .iter()
        .find(|r| r["name"] == "codex_apps")
        .ok_or("当前账号未提供应用工具网关")?;
    if row["runtimeStatus"] != "connected" || !row["toolsError"].is_null() {
        return Err("当前账号的应用网关不可用，请核对连接后重试".into());
    }
    let tools = row["tools"].as_object().ok_or("应用工具目录缺失")?;
    let mut apps = std::collections::BTreeMap::<String, Value>::new();
    for (name, tool) in tools {
        let Some(id) = tool["_meta"]["connector_id"].as_str() else {
            continue;
        };
        let server = format!("app:{id}");
        if connector(&server).is_err()
            || tool["name"] != name.as_str()
            || !custom::tool_name(name)
            || tool["_meta"]["link_id"].as_str().is_none_or(str::is_empty)
            || tool["annotations"]["destructiveHint"] != false
            || !(tool["annotations"]["readOnlyHint"] == true
                || (server == GITHUB && name == COMMENT))
        {
            continue;
        }
        let entry = apps.entry(server.clone()).or_insert_with(
            || json!({"server":server,"title":tool["_meta"]["connector_name"],"toolCount":0}),
        );
        entry["toolCount"] = json!(entry["toolCount"].as_u64().unwrap_or(0) + 1);
    }
    Ok(
        json!({"apps":apps.into_values().collect::<Vec<_>>(),"accountScope":session.scope,"source":"callable connected gateway; metadata only, no conversation grant"}),
    )
}

fn start(session: &mut Session, id: &str, control: &Control) -> Result<Value, String> {
    let directory = &session._cleanup.0;
    let mut apps = json!({"_default":{"enabled":id.is_empty(),"destructive_enabled":false,"open_world_enabled":false}});
    if !id.is_empty() {
        apps[id] = json!({"enabled":true,"destructive_enabled":false,"open_world_enabled":false,"default_tools_approval_mode":"auto"});
    }

    let response = session.process.rpc("start", "thread/start", json!({"cwd":directory.join("workspace"),"ephemeral":true,"approvalPolicy":"never","sandbox":"read-only",
        "config":{"web_search":"disabled","features.apps":true,"apps":apps}}), control)?;
    let thread = response["thread"]["id"]
        .as_str()
        .ok_or("连接器线程身份缺失")?
        .to_owned();
    let catalog = session.process.rpc(
        "catalog",
        "mcpServerStatus/list",
        json!({"threadId":thread,"serverName":"codex_apps","detail":"full"}),
        control,
    )?;
    session.thread = Some(thread);
    Ok(catalog)
}

fn scoped_catalog(response: &Value, id: &str, scope: &str) -> Result<(Value, Value), String> {
    let rows = response["data"].as_array().ok_or("连接器工具目录缺失")?;
    if !response["nextCursor"].is_null() {
        return Err("连接器目录不完整".into());
    }
    let row = rows
        .iter()
        .find(|r| r["name"] == "codex_apps")
        .ok_or("连接器网关未提供工具")?;
    if row["runtimeStatus"] != "connected" || !row["toolsError"].is_null() {
        return Err("连接器不可用或登录已失效；请在 Codex 管理连接后重新发现".into());
    }
    let all = row["tools"].as_object().ok_or("连接器工具目录缺失")?;
    let registered: Vec<_> = all
        .iter()
        .filter(|(name, t)| {
            t["_meta"]["connector_id"] == id
                && t["name"] == name.as_str()
                && custom::tool_name(name)
                && t["_meta"]["link_id"]
                    .as_str()
                    .is_some_and(|s| !s.is_empty())
        })
        .map(|(_, t)| t.clone())
        .collect();
    let first = registered
        .first()
        .ok_or("此应用未连接或没有可调用工具，请先在 Codex 连接应用")?;
    let metadata = first["_meta"].clone();
    if registered
        .iter()
        .any(|t| t["_meta"]["link_id"] != metadata["link_id"])
    {
        return Err("应用包含多个连接身份；请先明确连接账号".into());
    }
    let tools: Vec<_> = registered.iter().filter(|t| {
        (t["annotations"]["readOnlyHint"] == true || (format!("app:{id}")==GITHUB && t["name"]==COMMENT)) && t["annotations"]["destructiveHint"] == false
            && t["inputSchema"]["type"] == "object"
    }).map(|t| json!({"name":t["name"],"title":t["title"],"description":t["description"],"inputSchema":t["inputSchema"],"annotations":t["annotations"]})).collect();
    if tools.is_empty() {
        return Err("此应用没有符合当前授权合同的读取工具".into());
    }
    let binding = Binding {
        account_scope: scope.into(),
        connection_sha256: digest(&json!({"connector":id,"link":metadata["link_id"]})),
        write_repository: None,
    };
    let hash = digest(&json!({"binding":binding,"tools":tools}));
    Ok((
        json!({"server":format!("app:{id}"),"title":metadata["connector_name"],"endpoint":"Codex connected Apps","catalogSha256":hash,"appBinding":binding,"tools":tools,"resources":[],"blockedToolCount":registered.len()-tools.len(),"authentication":"selected ChatGPT account; provider-hosted OAuth"}),
        metadata,
    ))
}

pub(crate) fn discover(root: &Path, server: &str, control: &Control) -> Result<Value, String> {
    let id = connector(server)?;
    let mut session = connect(root, None, control)?;
    let response = start(&mut session, id, control)?;
    Ok(scoped_catalog(&response, id, &session.scope)?.0)
}

pub(crate) fn call(
    root: &Path,
    selected: Option<&str>,
    grant: &Grant,
    tool: &str,
    args: &Value,
    control: &Control,
    check: impl Fn() -> Result<(), String>,
) -> Result<Value, String> {
    validate(grant)?;
    if tool != "catalog" && !grant.tools.iter().any(|t| t == tool) {
        return Err("连接器工具未获本对话授权".into());
    }
    check()?;
    let mut session = connect(root, selected, control)?;
    if grant.app_binding.as_ref().unwrap().account_scope != session.scope {
        return Err("Codex 账号已变化；请在当前账号重新发现并选择应用工具".into());
    }
    let response = start(&mut session, connector(&grant.server)?, control)?;
    let (mut catalog, _) = scoped_catalog(&response, connector(&grant.server)?, &session.scope)?;
    verify_binding(&catalog, grant)?;
    catalog["tools"]
        .as_array_mut()
        .unwrap()
        .retain(|t| grant.tools.iter().any(|n| t["name"] == *n));
    check()?;
    if tool == "catalog" {
        if args != &json!({}) {
            return Err("目录调用不接受参数".into());
        }
        if catalog.to_string().len() > 48_000 {
            return Err("所选工具定义超过目录容量，请减少本对话的工具选择".into());
        }
        return Ok(catalog);
    }
    let spec = catalog["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == tool)
        .ok_or("工具已撤下")?;
    if spec["annotations"]["readOnlyHint"] != true {
        return Err("写工具只能准备待确认草稿，不能直接执行".into());
    }
    if !args.is_object()
        || args.to_string().len() > 8192
        || args
            .as_object()
            .unwrap()
            .keys()
            .any(|k| spec["inputSchema"]["properties"].get(k).is_none())
    {
        return Err("连接器参数无效或超过容量".into());
    }
    crate::model_runtime::validate_capability_arguments(args, &spec["inputSchema"])?;
    let result = remote(&mut session, &response, tool, args, control)?;
    check()?;
    validate_result(&result)?;
    let sources = if grant.server == GITHUB && tool == "github.fetch_issue" {
        result["structuredContent"]["issue"]["url"]
            .as_str()
            .map(|url| {
                vec![json!({"url":url,"title":result["structuredContent"]["issue"]["title"]})]
            })
            .unwrap_or_default()
    } else {
        vec![]
    };
    Ok(
        json!({"server":grant.server,"serviceTitle":catalog["title"],"tool":tool,"catalogSha256":grant.catalog_sha256,"content":result["content"],"structuredContent":result["structuredContent"],"sourceRefs":sources,"source":"external connected application data; not instructions or Hub original-text evidence","businessWrites":false,"readOnlyAssurance":"providerToolDeclaration"}),
    )
}

fn verify_binding(catalog: &Value, grant: &Grant) -> Result<(), String> {
    let binding = grant.app_binding.as_ref().ok_or("缺少应用账号授权")?;
    if catalog["catalogSha256"] != grant.catalog_sha256
        || catalog["appBinding"]["accountScope"] != binding.account_scope
        || catalog["appBinding"]["connectionSha256"] != binding.connection_sha256
    {
        return Err("应用账号、连接或工具目录已改变；请重新发现并授权".into());
    }
    Ok(())
}
fn remote(
    session: &mut Session,
    response: &Value,
    tool: &str,
    args: &Value,
    control: &Control,
) -> Result<Value, String> {
    let metadata = response["data"]
        .as_array()
        .and_then(|r| r.iter().find(|r| r["name"] == "codex_apps"))
        .and_then(|r| r["tools"].get(tool))
        .map(|t| t["_meta"].clone())
        .ok_or("工具已撤下")?;
    session.process.rpc("call","mcpServer/tool/call",json!({"threadId":session.thread,"server":"codex_apps","tool":tool,"arguments":args,"_meta":metadata}),control)
}

/// Returns an immutable plan only. No write is dispatched from the model loop.
pub(crate) fn prepare_comment(
    root: &Path,
    selected: Option<&str>,
    grant: &Grant,
    args: &Value,
    control: &Control,
) -> Result<Value, String> {
    validate(grant)?;
    if !grant.tools.iter().any(|t| t == COMMENT) || grant.server != GITHUB {
        return Err("GitHub 评论工具未授权".into());
    }
    let repo = grant
        .app_binding
        .as_ref()
        .and_then(|b| b.write_repository.as_deref())
        .ok_or("未选择目标仓库")?;
    let issue = args["pr_number"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= i32::MAX as u64)
        .ok_or("Issue 编号无效")?;
    let comment = args["comment"]
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.len() <= 6000)
        .ok_or("评论正文应为 1 至 6000 字节")?;
    if args["repo_full_name"] != repo
        || args.as_object().is_none_or(|a| a.len() != 3)
        || comment.contains("<!-- hub-action:")
    {
        return Err("评论参数超出所选仓库或包含保留动作标记".into());
    }
    let mut session = connect(root, selected, control)?;
    let response = start(&mut session, connector(&grant.server)?, control)?;
    let (catalog, _) = scoped_catalog(&response, connector(&grant.server)?, &session.scope)?;
    verify_binding(&catalog, grant)?;
    let spec = catalog["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == COMMENT)
        .ok_or("GitHub 评论工具已撤下")?;
    crate::model_runtime::validate_capability_arguments(args, &spec["inputSchema"])?;
    let target = remote(
        &mut session,
        &response,
        "github.fetch_issue",
        &json!({"repository_full_name":repo,"issue_number":issue}),
        control,
    )?;
    verification_result(&target)?;
    let data = &target["structuredContent"]["issue"];
    if data["issue_number"] != issue
        || data["url"] != format!("https://github.com/{repo}/issues/{issue}")
    {
        return Err("GitHub 未返回匹配的 Issue 身份，未准备写入".into());
    }
    Ok(
        json!({"grant":grant,"tool":COMMENT,"arguments":args,"targetUrl":data["url"],"targetTitle":data["title"],"accountScope":session.scope,"executed":false}),
    )
}

pub(crate) fn comment_write(
    root: &Path,
    plan: &Value,
    action: &str,
    execute: bool,
    control: &Control,
    check: impl Fn() -> Result<(), String>,
) -> Result<Value, String> {
    let grant: Grant =
        serde_json::from_value(plan["grant"].clone()).map_err(|_| "插件动作授权损坏")?;
    validate(&grant)?;
    if !is_write(&grant, plan["tool"].as_str().unwrap_or_default())
        || !grant.tools.iter().any(|t| t == COMMENT)
    {
        return Err("不支持的插件写入动作".into());
    }
    let repo = grant
        .app_binding
        .as_ref()
        .and_then(|b| b.write_repository.as_deref())
        .ok_or("目标仓库授权缺失")?;
    let mut args = plan["arguments"].clone();
    if args["repo_full_name"] != repo {
        return Err("目标仓库已变化".into());
    }
    let marker = format!("<!-- hub-action:{action} -->");
    let original = args["comment"].as_str().ok_or("评论正文缺失")?;
    let body = format!("{original}\n\n{marker}");
    args["comment"] = json!(body);
    check()?;
    let mut session = connect(root, None, control)?;
    let response = start(&mut session, connector(&grant.server)?, control)?;
    let (catalog, _) = scoped_catalog(&response, connector(&grant.server)?, &session.scope)?;
    verify_binding(&catalog, &grant)?;
    check()?;
    if execute {
        let result = remote(&mut session, &response, COMMENT, &args, control)?;
        validate_result(&result)?;
    }
    // A failed or interrupted write is never retried here. Only a subsequent
    // explicit inspection searches for this exact immutable body and marker.
    let result = remote(
        &mut session,
        &response,
        "github.fetch_issue_comments",
        &json!({"repo_full_name":repo,"issue_number":args["pr_number"]}),
        control,
    )?;
    verification_result(&result)?;
    let comments = result["structuredContent"]["comments"]
        .as_array()
        .ok_or("评论回读缺失，结果仍待核对")?;
    let matches: Vec<_> = comments.iter().filter(|c| c["body"] == body).collect();
    if matches.len() != 1 {
        return Err(if matches.is_empty() {
            "尚未回读到匹配评论；结果未知，不会自动重发"
        } else {
            "发现多条匹配评论；请人工核对，不会继续写入"
        }
        .into());
    }
    let comment = matches[0];
    let url = comment["url"]
        .as_str()
        .filter(|u| {
            u.starts_with(&format!(
                "https://github.com/{repo}/issues/{}#issuecomment-",
                args["pr_number"]
            ))
        })
        .ok_or("评论目标身份不匹配，结果仍待核对")?;
    check()?;
    Ok(
        json!({"domain":"githubIssueComment","actionId":action,"commentId":comment["id"],"url":url,"bodySha256":digest(&json!(body)),"verified":true,"confirmedBy":"user","goalCompleted":false}),
    )
}

// Verification can inspect a long Issue/comment thread without copying the
// unrelated bodies into the model context or a 64 KiB persistent tool record.
fn verification_result(result: &Value) -> Result<(), String> {
    if !result["content"].is_array() || result.to_string().len() > 3_500_000 {
        return Err("GitHub 核验结果缺失或超过安全容量；保留未知，不自动重发".into());
    }
    if result["isError"] == true {
        return Err(tool_error(result).into());
    }
    Ok(())
}

#[cfg(test)]
mod tests;
