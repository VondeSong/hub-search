use super::*;

pub(super) fn endpoint(raw: &str) -> Result<reqwest::Url, String> {
    let url = crate::x_bookmarks::public_web::url(raw)?;
    if raw.len() > 2048
        || url.query().is_some()
        || reqwest::Url::parse(raw).is_ok_and(|u| u.fragment().is_some())
        || url.as_str() != raw
    {
        return Err("MCP 地址须为规范 HTTPS 地址，不能含登录信息、查询参数或片段".into());
    }
    if SERVICES.iter().any(|s| s.endpoint == raw) {
        return Err("该地址已有预设服务，请使用原入口".into());
    }
    Ok(url)
}
pub(super) fn with_service<T>(
    server: &str,
    use_service: impl FnOnce(&Service) -> Result<T, String>,
) -> Result<T, String> {
    if let Ok(service) = service(server) {
        return use_service(service);
    }
    let url = endpoint(server)?;
    let origin = url.origin().ascii_serialization();
    let name = format!("hub_remote_{:x}", sha2::Sha256::digest(server.as_bytes()));
    let custom = Service {
        server: &name,
        title: "自定义远程服务",
        endpoint: server,
        origin: &origin,
        identity: "",
        auth_status: "",
        tools: &[],
    };
    use_service(&custom)
}
pub(super) fn tool_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && !matches!(name, "catalog" | "read_resource")
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}
pub(super) fn identity_matches(service: &Service, row: &Value) -> bool {
    if !service.identity.is_empty() {
        return row["serverInfo"]["name"] == service.identity
            && row["authStatus"] == service.auth_status;
    }
    row["serverInfo"]["name"]
        .as_str()
        .is_some_and(|s| !s.is_empty() && s.len() <= 256)
        && matches!(
            row["authStatus"].as_str(),
            Some("unsupported" | "notLoggedIn")
        )
}
#[cfg(test)]
mod tests;
