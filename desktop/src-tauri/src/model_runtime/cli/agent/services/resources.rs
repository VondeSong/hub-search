use super::*;

// Only exact public HTTPS resources are admitted; templates and tool-returned links grant nothing.
pub(super) fn valid_uri(service: &Service, uri: &str) -> bool {
    uri.len() <= 2048
        && reqwest::Url::parse(uri).is_ok_and(|u| {
            u.fragment().is_none()
                && (public_url(
                    uri,
                    &[reqwest::Url::parse(service.origin)
                        .unwrap()
                        .host_str()
                        .unwrap()],
                ) || (service.server == SERVER && public_doc_url(uri)))
        })
}

pub(super) fn catalog(service: &Service, row: &Value) -> Result<Vec<Value>, String> {
    let Some(rows) = row.get("resources").and_then(Value::as_array) else {
        if row.get("resources").is_some() {
            return Err("MCP 资源目录格式无效".into());
        }
        return Ok(vec![]);
    };
    if rows.len() > 64
        || rows
            .iter()
            .map(|r| r["uri"].as_str())
            .collect::<HashSet<_>>()
            .len()
            != rows.len()
    {
        return Err("MCP 资源目录重复或超过容量".into());
    }
    Ok(rows
        .iter()
        .filter(|r| {
            r["uri"].as_str().is_some_and(|u| valid_uri(service, u))
                && r["name"]
                    .as_str()
                    .is_some_and(|n| !n.is_empty() && n.len() <= 512)
                && text_mime(&r["mimeType"])
        })
        .map(|r| json!({"uri":r["uri"],"name":r["name"],"mimeType":r["mimeType"]}))
        .collect())
}

fn text_mime(value: &Value) -> bool {
    value.is_null()
        || value
            .as_str()
            .is_some_and(|m| matches!(m, "text/plain" | "text/markdown" | "application/json"))
}

pub(super) fn authorize(catalog: &Value, grant: &Grant, args: &Value) -> Result<String, String> {
    let uri = args["uri"].as_str().ok_or("请指定已选择资源的完整 URI")?;
    if args.as_object().is_none_or(|o| o.len() != 1)
        || !grant.resource_uris.iter().any(|u| u == uri)
        || !catalog["resources"]
            .as_array()
            .is_some_and(|rs| rs.iter().any(|r| r["uri"] == uri))
    {
        return Err("资源未获本对话授权或已从目录撤下".into());
    }
    Ok(uri.into())
}

pub(super) fn read(
    process: &mut Process,
    thread: &str,
    server: &str,
    uri: &str,
    control: &Control,
) -> Result<Value, String> {
    let raw = process.rpc(
        "resource",
        "mcpServer/resource/read",
        json!({"threadId":thread,"server":server,"uri":uri}),
        control,
    )?;
    content(&raw, uri)
}

pub(super) fn content(raw: &Value, uri: &str) -> Result<Value, String> {
    let rows = raw["contents"]
        .as_array()
        .filter(|rs| !rs.is_empty())
        .ok_or("MCP 资源没有返回完整文本")?;
    if raw.to_string().len() > 48_000
        || rows.iter().any(|r| {
            r["uri"] != uri
                || !r["text"].is_string()
                || r.get("blob").is_some()
                || !text_mime(&r["mimeType"])
        })
    {
        return Err("MCP 资源身份、文本类型或容量不符合授权；未采用内容".into());
    }
    Ok(
        json!({"content":rows.iter().map(|r|json!({"type":"text","text":r["text"]})).collect::<Vec<_>>() }),
    )
}
