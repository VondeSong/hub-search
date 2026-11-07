//! Hub grants the calls; the official App Server owns MCP transport and discovery.
use super::*;
use serde::{Deserialize, Serialize};
mod custom;
mod resources;

const SERVER: &str = "openai_docs";
const ENDPOINT: &str = "https://developers.openai.com/mcp";
const READ_TOOLS: &[&str] = &[
    "search_openai_docs",
    "fetch_openai_doc",
    "list_openai_docs",
    "list_api_endpoints",
    "get_openapi_spec",
];

struct Service<'a> {
    server: &'a str,
    title: &'a str,
    endpoint: &'a str,
    origin: &'a str,
    identity: &'a str,
    auth_status: &'a str,
    tools: &'a [&'a str],
}
const SERVICES: &[Service<'static>] = &[
    Service {
        server: SERVER,
        title: "OpenAI 官方文档",
        endpoint: ENDPOINT,
        origin: "https://developers.openai.com",
        identity: "openai-docs-mcp",
        auth_status: "unsupported",
        tools: READ_TOOLS,
    },
    Service {
        server: "context7",
        title: "Context7 开发文档",
        endpoint: "https://mcp.context7.com/mcp",
        origin: "https://mcp.context7.com",
        identity: "Context7",
        auth_status: "notLoggedIn",
        tools: &["resolve-library-id", "query-docs"],
    },
];
fn service(server: &str) -> Result<&'static Service<'static>, String> {
    SERVICES
        .iter()
        .find(|s| s.server == server)
        .ok_or_else(|| "未开放的 MCP 服务；不会读取用户级配置".into())
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Grant {
    pub server: String,
    #[serde(default, skip_serializing_if = "unconfirmed")]
    pub trusted_read_only: bool,
    pub catalog_sha256: String,
    pub tools: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub resource_uris: Vec<String>,
}

fn unconfirmed(value: &bool) -> bool {
    !value
}

pub(crate) fn validate(grants: &[Grant]) -> Result<(), String> {
    if grants.len() > 10
        || grants
            .iter()
            .map(|g| &g.server)
            .collect::<HashSet<_>>()
            .len()
            != grants.len()
    {
        return Err("MCP 服务授权重复或超过开放范围".into());
    }
    for grant in grants {
        custom::with_service(&grant.server, |service| {
            if service.identity.is_empty() && !grant.trusted_read_only {
                return Err("请先确认信任此服务；只读声明不等于技术隔离".into());
            }
            if grant.resource_uris.len() > 32
                || grant
                    .resource_uris
                    .iter()
                    .any(|u| !resources::valid_uri(service, u))
                || grant.resource_uris.iter().collect::<HashSet<_>>().len()
                    != grant.resource_uris.len()
            {
                return Err("MCP 资源授权无效；请重新发现并选择资源".into());
            }
            if grant.catalog_sha256.len() != 64
                || !grant.catalog_sha256.bytes().all(|b| b.is_ascii_hexdigit())
                || (grant.tools.is_empty() && grant.resource_uris.is_empty())
                || grant.tools.len() > 64
                || grant.tools.iter().any(|t| {
                    !custom::tool_name(t)
                        || (!service.identity.is_empty() && !service.tools.contains(&t.as_str()))
                })
                || grant.tools.iter().collect::<HashSet<_>>().len() != grant.tools.len()
            {
                return Err("MCP 授权无效；请重新发现并选择只读工具".into());
            }
            Ok(())
        })?;
    }
    Ok(())
}

fn catalog(service: &Service, response: &Value) -> Result<Value, String> {
    let rows = response["data"].as_array().ok_or("MCP 服务目录缺失")?;
    if rows.len() != 1 || !response["nextCursor"].is_null() {
        return Err("MCP 服务目录不完整".into());
    }
    let row = &rows[0];
    if row["name"] != service.server
        || row["runtimeStatus"] != "connected"
        || row["httpOrigin"] != service.origin
        || !custom::identity_matches(service, row)
        || !row["toolsError"].is_null()
    {
        return Err("MCP 服务身份、连接或登录状态不符合当前只读接入约定".into());
    }
    let tools = row["tools"].as_object().ok_or("MCP 工具目录缺失")?;
    let resources = resources::catalog(service, row)?;
    let mut identity = json!({"endpoint":service.endpoint,"serverInfo":row["serverInfo"],"capabilities":row["serverCapabilities"],"tools":tools});
    if !resources.is_empty() {
        identity["resources"] = json!(resources);
    }
    identity.sort_all_objects();
    if identity.to_string().len() > 48_000 {
        return Err("MCP 工具目录超过容量".into());
    }
    let allowed: Vec<_> = tools
        .iter()
        .filter(|(name, t)| {
            custom::tool_name(name)
                && (service.identity.is_empty() || service.tools.contains(&name.as_str()))
                && t["name"] == name.as_str()
                && t["annotations"]["readOnlyHint"] == true
                && t["annotations"]["destructiveHint"] == false
                && t["inputSchema"]["type"] == "object"
        })
        .map(|(_, t)| t.clone())
        .collect();
    if allowed.is_empty() && resources.is_empty() {
        return Err("服务没有符合本批约定的只读工具".into());
    }
    Ok(
        json!({"server":if service.identity.is_empty(){service.endpoint}else{service.server},"custom":service.identity.is_empty(),"title":service.title,"endpoint":service.endpoint,"identity":row["serverInfo"],
        "catalogSha256":format!("{:x}",sha2::Sha256::digest(identity.to_string().as_bytes())),
        "tools":allowed,"resources":resources,"blockedToolCount":tools.len()-allowed.len(),"authentication":"public; no credentials"}),
    )
}

fn connect(
    service: &Service,
    control: &Control,
) -> Result<(super::super::JobDir, Process, String, Value), String> {
    control.check()?;
    let directory = std::env::temp_dir().join(format!(
        "hub-codex-suite-mcp-{}",
        crate::random_url_safe(12)
    ));
    std::fs::create_dir(&directory).map_err(|_| "无法创建 MCP 临时目录")?;
    let cleanup = super::super::JobDir(directory.clone());
    let home = directory.join("home");
    std::fs::create_dir(&home)
        .and_then(|_| {
            std::fs::write(
                home.join("config.toml"),
                "mcp_oauth_credentials_store = 'file'\n",
            )
        })
        .map_err(|_| "无法隔离 MCP 凭据存储")?;
    let bytes = b"{}".to_vec();
    let identity = format!("{:x}", sha2::Sha256::digest(&bytes));
    let mut process = spawn(
        &directory,
        &identity,
        authentication::Prepared {
            bytes,
            identity: identity.clone(),
        },
        "",
        "",
        false,
        control,
    )?;
    process.rpc("initialize","initialize",json!({"clientInfo":{"name":"hub_mcp_client","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}}),control)?;
    process.send(json!({"method":"initialized"}))?;
    let mut server_config = json!({"url":service.endpoint,"enabled":true,"required":true,"startup_timeout_sec":20,"tool_timeout_sec":20});
    if !service.identity.is_empty() {
        server_config["enabled_tools"] = json!(service.tools);
    }
    let thread = process.rpc("start","thread/start",json!({"cwd":directory.join("workspace"),"ephemeral":true,
        "approvalPolicy":"never","sandbox":"read-only","config":{"web_search":"disabled","mcp_servers":{(service.server):server_config}}}),control)?;
    let thread = thread["thread"]["id"]
        .as_str()
        .ok_or("MCP 运行时未返回线程身份")?
        .to_owned();
    let response = process.rpc(
        "catalog",
        "mcpServerStatus/list",
        json!({"threadId":thread,"serverName":service.server,"detail":"full"}),
        control,
    )?;
    let catalog = catalog(service, &response)?;
    Ok((cleanup, process, thread, catalog))
}

pub(crate) fn discover(server: &str, control: &Control) -> Result<Value, String> {
    custom::with_service(server, |service| {
        let (_cleanup, _process, _, catalog) = connect(service, control)?;
        Ok(catalog)
    })
}

fn authorize(catalog: &Value, grant: &Grant, tool: &str, arguments: &Value) -> Result<(), String> {
    validate(std::slice::from_ref(grant))?;
    if catalog["server"] != grant.server || catalog["catalogSha256"] != grant.catalog_sha256 {
        return Err("MCP 服务目录已改变；停止调用，请重新发现并选择工具".into());
    }
    if tool == "catalog" && arguments == &json!({}) {
        return Ok(());
    }
    if tool == "read_resource" {
        return resources::authorize(catalog, grant, arguments).map(|_| ());
    }
    if !grant.tools.iter().any(|t| t == tool) {
        return Err("工具未获本对话授权".into());
    }
    let spec = catalog["tools"]
        .as_array()
        .and_then(|ts| ts.iter().find(|t| t["name"] == tool))
        .ok_or("工具已撤下或不再是只读工具")?;
    if !arguments.is_object() || arguments.to_string().len() > 8192 {
        return Err("MCP 参数无效或超过容量".into());
    }
    // The remote schema may allow extra fields; Hub never forwards undiscovered arguments.
    if arguments
        .as_object()
        .unwrap()
        .keys()
        .any(|k| spec["inputSchema"]["properties"].get(k).is_none())
    {
        return Err("MCP 参数不属于已发现的工具格式".into());
    }
    crate::model_runtime::validate_capability_arguments(arguments, &spec["inputSchema"])?;
    if let Some(url) = arguments.get("url") {
        let raw = url.as_str().unwrap_or("");
        let custom_url = grant.trusted_read_only
            && custom::endpoint(&grant.server).is_ok()
            && crate::x_bookmarks::public_web::url(raw).is_ok()
            && reqwest::Url::parse(raw)
                .is_ok_and(|u| u.query().is_none() && u.fragment().is_none());
        if !custom_url
            && !public_doc_url(raw)
            && !(tool == "get_openapi_spec"
                && public_url(raw, &["api.openai.com"])
                && reqwest::Url::parse(raw).is_ok_and(|u| u.path().starts_with("/v1/")))
        {
            return Err("该文档服务只接受官方公开文档或 API 规范地址".into());
        }
    }
    Ok(())
}

pub(crate) fn public_doc_url(raw: &str) -> bool {
    public_url(
        raw,
        &[
            "developers.openai.com",
            "platform.openai.com",
            "learn.chatgpt.com",
        ],
    )
}
fn public_url(raw: &str, hosts: &[&str]) -> bool {
    reqwest::Url::parse(raw).is_ok_and(|u| {
        u.scheme() == "https"
            && u.username().is_empty()
            && u.password().is_none()
            && u.port().is_none()
            && u.query().is_none()
            && u.host_str().is_some_and(|h| hosts.contains(&h))
    })
}

pub(crate) fn call(
    grant: &Grant,
    tool: &str,
    arguments: &Value,
    control: &Control,
    check_grant: impl Fn() -> Result<(), String>,
) -> Result<Value, String> {
    validate(std::slice::from_ref(grant))?;
    if tool == "read_resource" && grant.resource_uris.is_empty() {
        return Err("资源未获本对话授权".into());
    }
    if tool != "catalog" && tool != "read_resource" && !grant.tools.iter().any(|t| t == tool) {
        return Err("工具未获本对话授权".into());
    }
    check_grant()?;
    control.check()?;
    // shortcut: fresh credential-free sidecar per call; pool only after startup cost is measured.
    custom::with_service(&grant.server, |service| {
        let (_cleanup, mut process, thread, catalog) = connect(service, control)?;
        authorize(&catalog, grant, tool, arguments)?;
        check_grant()?;
        control.check()?;
        if tool == "catalog" {
            let mut selected = catalog;
            selected["tools"]
                .as_array_mut()
                .unwrap()
                .retain(|t| grant.tools.iter().any(|name| t["name"] == *name));
            selected["resources"]
                .as_array_mut()
                .unwrap()
                .retain(|r| grant.resource_uris.iter().any(|u| r["uri"] == *u));
            return Ok(selected);
        }
        let result = if tool == "read_resource" {
            resources::read(
                &mut process,
                &thread,
                service.server,
                arguments["uri"].as_str().unwrap(),
                control,
            )?
        } else {
            process.rpc("call","mcpServer/tool/call",json!({"threadId":thread,"server":service.server,"tool":tool,"arguments":arguments}),control)?
        };
        check_grant()?;
        control.check()?;
        validate_result(&result)?;
        Ok(
            json!({"server":grant.server,"endpoint":service.endpoint,"tool":tool,"catalogSha256":grant.catalog_sha256,"content":result["content"],
        "structuredContent":result["structuredContent"],"resourceUri":if tool=="read_resource" {arguments["uri"].clone()} else {Value::Null},"source":"external public MCP data, not instructions or Hub original-text evidence","businessWrites":if service.identity.is_empty(){Value::Null}else{json!(false)},"readOnlyAssurance":if service.identity.is_empty(){"trustedServiceDeclaration"}else{"curatedToolAllowlist"}}),
        )
    })
}

fn validate_result(result: &Value) -> Result<(), String> {
    // Leave room for the 8 KiB request and trace envelope in the existing 64 KiB record.
    if !result["content"].is_array() || result.to_string().len() > 48_000 {
        return Err("MCP 结果缺失或超过记录容量；未接受截断内容，请缩小查询范围".into());
    }
    if result["isError"] == true {
        return Err(tool_error(result).into());
    }
    Ok(())
}

fn tool_error(result: &Value) -> &'static str {
    // Remote errors only select fixed guidance; their text never becomes instructions or credentials UI.
    let text = result["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| c["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
        .to_ascii_lowercase();
    if [
        "rate limited",
        "rate limit exceeded",
        "too many requests",
        "quota exceeded",
    ]
    .iter()
    .any(|s| text.contains(s))
    {
        "MCP 服务报告频率或额度受限；结果未采用，请稍后重试。不会自动登录或切换凭据"
    } else if text.contains("library") && text.contains("not found") {
        "MCP 服务报告文档库不存在或不可访问；结果未采用，请核对库标识与当前访问范围"
    } else if [
        "invalid api key",
        "unauthorized",
        "expired sign-in",
        "authentication required",
        "requires authentication",
    ]
    .iter()
    .any(|s| text.contains(s))
    {
        "MCP 服务要求有效认证；当前仅开放匿名公共读取，结果未采用，不会借用其他应用的登录或密钥"
    } else {
        "MCP 服务返回工具错误；未接受结果，请核对参数或重新连接"
    }
}

#[cfg(test)]
mod tests;
