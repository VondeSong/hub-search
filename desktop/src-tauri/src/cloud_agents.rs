use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{Client, Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{sync::OnceLock, time::Duration};
use tauri::AppHandle;

const CREDENTIAL: &str = "hub-cloud-agents-v1";
const MAX_RESPONSE: usize = 28 * 1024 * 1024;
mod materials;

#[derive(Deserialize, Serialize)]
struct Config {
    endpoint: String,
    token: String,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub(crate) enum Action {
    Materials {
        kind: String,
        query: String,
        offset: u32,
    },
    Material {
        selection: Value,
    },
    AnswerNote {
        thread: String,
        turn: String,
        date: String,
    },
    Config,
    SkillVersions,
    PrepareSkill {
        version: String,
        paths: Vec<String>,
    },
    Connect {
        endpoint: String,
        token: String,
    },
    List {
        #[serde(default)]
        query: String,
    },
    Update {
        thread: String,
        title: Option<String>,
        archived: Option<bool>,
    },
    Read {
        thread: String,
        before: Option<u64>,
        #[serde(default)]
        missing: bool,
    },
    Send {
        thread: String,
        turn: String,
        message: Value,
    },
    Stop {
        thread: String,
        turn: String,
    },
    Attachment {
        id: String,
    },
}

fn endpoint(value: &str) -> Result<Url, String> {
    let url = Url::parse(value.trim()).map_err(|_| "VPS 地址格式无效。")?;
    let loopback = match url.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        _ => false,
    };
    if !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host().is_none()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("请输入 HTTPS 服务地址，例如 https://agents.example.com。".into());
    }
    Ok(url)
}

fn id(value: &str) -> Result<&str, String> {
    if value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        })
    {
        Ok(value)
    } else {
        Err("云端会话或消息编号无效。".into())
    }
}

fn config_view(config: &Config) -> Value {
    let binding = Sha256::digest(format!("{}\n{}", config.endpoint, config.token).as_bytes());
    json!({"endpoint":config.endpoint,"binding":format!("{binding:x}")})
}

enum RequestFailure {
    Http(u16, String),
    Transport(String),
}

impl From<RequestFailure> for String {
    fn from(error: RequestFailure) -> Self {
        match error {
            RequestFailure::Http(_, message) | RequestFailure::Transport(message) => message,
        }
    }
}

fn delivery_receipt(turn: &str, result: Result<Value, RequestFailure>) -> Value {
    match result {
        Ok(receipt) if receipt["id"].as_str() == Some(turn) => {
            json!({"delivery":"accepted","id":turn})
        }
        Err(RequestFailure::Http(status, error))
            if (400..500).contains(&status) && !matches!(status, 408 | 499) =>
        {
            json!({"delivery":"rejected","error":error})
        }
        _ => json!({"delivery":"unknown"}),
    }
}

async fn request(
    config: &Config,
    method: Method,
    path: &str,
    body: Option<Value>,
    image: bool,
) -> Result<Value, RequestFailure> {
    static CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();
    let client = CLIENT
        .get_or_init(|| {
            Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(6))
                .timeout(Duration::from_secs(45))
                .build()
                .map_err(|_| "无法启动云端 Agents 网络连接。".into())
        })
        .as_ref()
        .map_err(|message| RequestFailure::Transport(message.clone()))?;
    let url = endpoint(&config.endpoint)
        .map_err(RequestFailure::Transport)?
        .join(path)
        .map_err(|_| RequestFailure::Transport("云端请求地址无效。".into()))?;
    let mut call = client.request(method, url).bearer_auth(&config.token);
    if let Some(body) = body {
        if body["attachments"]
            .as_array()
            .is_some_and(|images| !images.is_empty())
        {
            call = call.timeout(Duration::from_secs(180));
        }
        call = call.json(&body);
    }
    let mut response = call.send().await.map_err(|error| {
        RequestFailure::Transport(if error.is_timeout() {
            "等待个人云端回应超时。".into()
        } else {
            "暂时无法连接个人云端。".into()
        })
    })?;
    let status = response.status();
    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let limit = if image { 4 * 1024 * 1024 } else { MAX_RESPONSE };
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| RequestFailure::Transport("接收云端回应时连接中断。".into()))?
    {
        if bytes.len() + chunk.len() > limit {
            return Err(RequestFailure::Transport("VPS 返回内容超出限制。".into()));
        }
        bytes.extend_from_slice(&chunk);
    }
    if !status.is_success() {
        let fallback = format!("VPS 请求失败（HTTP {}）。", status.as_u16());
        let error = serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|value| {
                value["error"]
                    .as_str()
                    .map(|message| message.chars().take(240).collect::<String>())
            });
        return Err(RequestFailure::Http(
            status.as_u16(),
            error.unwrap_or(fallback),
        ));
    }
    if image {
        if !matches!(mime.as_str(), "image/jpeg" | "image/png" | "image/webp") {
            return Err(RequestFailure::Transport(
                "VPS 返回了无法预览的附件类型。".into(),
            ));
        }
        return Ok(json!({"url":format!("data:{mime};base64,{}",STANDARD.encode(bytes))}));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| RequestFailure::Transport("VPS 返回格式无效，请检查服务地址。".into()))
}

#[tauri::command]
pub(crate) async fn cloud_agents(app: AppHandle, action: Action) -> Result<Value, String> {
    let current = || -> Result<Option<Config>, String> {
        crate::stored_secret_get(&app, CREDENTIAL)?
            .map(|value| {
                serde_json::from_str(&value).map_err(|_| "保存的 VPS 连接无效，请重新连接。".into())
            })
            .transpose()
    };
    match action {
        Action::Materials {
            kind,
            query,
            offset,
        } => materials::list(&crate::active_data_root(&app)?, &kind, &query, offset),
        Action::Material { selection } => {
            materials::prepare(&crate::active_data_root(&app)?, selection)
        }
        Action::Config => Ok(current()?.as_ref().map(config_view).unwrap_or(Value::Null)),
        Action::SkillVersions => {
            crate::agent_work::skills::cloud_skill_versions(&crate::active_data_root(&app)?)
        }
        Action::PrepareSkill { version, paths } => crate::agent_work::skills::cloud_skill_payload(
            &crate::active_data_root(&app)?,
            &version,
            &paths,
        ),
        Action::Connect {
            endpoint: raw,
            token,
        } => {
            let token = token.trim();
            if token.len() != 43
                || !token
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            {
                return Err("设备密钥格式无效。".into());
            }
            let config = Config {
                endpoint: endpoint(&raw)?.to_string(),
                token: token.to_owned(),
            };
            let check = request(&config, Method::GET, "/v1/threads", None, false).await?;
            if !check["threads"].is_array() || !check["account"].is_object() {
                return Err("此地址没有返回 Hub Agents 服务信息。".into());
            }
            crate::stored_secret_set(
                &app,
                CREDENTIAL,
                &serde_json::to_string(&config).map_err(|e| e.to_string())?,
            )?;
            Ok(config_view(&config))
        }
        action => {
            let config = current()?.ok_or("请先连接 VPS。")?;
            let missing = matches!(&action, Action::Read { missing: true, .. });
            let (method, path, body, image) = match action {
                Action::AnswerNote { thread, turn, date } => (
                    Method::POST,
                    format!("/v1/threads/{}/turns/{}/note", id(&thread)?, id(&turn)?),
                    Some(json!({"date":date})),
                    false,
                ),
                Action::List { query } => {
                    if query.chars().count() > 200 {
                        return Err("搜索内容最多 200 个字符。".into());
                    }
                    let query = url::form_urlencoded::Serializer::new(String::new())
                        .append_pair("q", &query)
                        .finish();
                    (Method::GET, format!("/v1/threads?{query}"), None, false)
                }
                Action::Update {
                    thread,
                    title,
                    archived,
                } => {
                    let mut changes = serde_json::Map::new();
                    if let Some(title) = title {
                        changes.insert("title".into(), json!(title));
                    }
                    if let Some(archived) = archived {
                        changes.insert("archived".into(), json!(archived));
                    }
                    (
                        Method::POST,
                        format!("/v1/threads/{}/metadata", id(&thread)?),
                        Some(Value::Object(changes)),
                        false,
                    )
                }
                Action::Read { thread, before, .. } => (
                    Method::GET,
                    format!(
                        "/v1/threads/{}{}",
                        id(&thread)?,
                        before
                            .map(|value| format!("?before={value}"))
                            .unwrap_or_default()
                    ),
                    None,
                    false,
                ),
                Action::Send {
                    thread,
                    turn,
                    message,
                } => {
                    if message.get("material").is_some() || message.get("skill").is_some() {
                        let capabilities =
                            request(&config, Method::GET, "/v1/threads", None, false).await?;
                        if message.get("material").is_some() && capabilities["materials"] != true {
                            return Ok(
                                json!({"delivery":"rejected","error":"当前 VPS 尚不支持资料快照，请更新服务后重试。"}),
                            );
                        }
                        if message.get("skill").is_some() && capabilities["skillPackages"] != true {
                            return Ok(
                                json!({"delivery":"rejected","error":"当前 VPS 网关不支持固定技能，请更新网关后重试。"}),
                            );
                        }
                    }
                    let result = request(
                        &config,
                        Method::POST,
                        &format!("/v1/threads/{}/turns/{}", id(&thread)?, id(&turn)?),
                        Some(message),
                        false,
                    )
                    .await;
                    return Ok(delivery_receipt(&turn, result));
                }
                Action::Stop { thread, turn } => (
                    Method::POST,
                    format!("/v1/threads/{}/turns/{}/stop", id(&thread)?, id(&turn)?),
                    None,
                    false,
                ),
                Action::Attachment { id: value } => (
                    Method::GET,
                    format!("/v1/attachments/{}", id(&value)?),
                    None,
                    true,
                ),
                _ => unreachable!(),
            };
            match request(&config, method, &path, body, image).await {
                Err(RequestFailure::Http(404, _)) if missing => Ok(json!({"thread":null})),
                result => result.map_err(Into::into),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_protects_device_tokens() {
        assert!(endpoint("https://agents.example.com:9443").is_ok());
        assert!(endpoint("http://127.0.0.1:8787").is_ok());
        for invalid in [
            "http://agents.example.com",
            "https://user@agents.example.com",
            "https://agents.example.com/foo",
            "https://agents.example.com/?token=x",
            "file:///tmp",
        ] {
            assert!(endpoint(invalid).is_err(), "{invalid}");
        }
        assert!(id("../attachments").is_err());
    }

    #[test]
    fn delivery_requires_its_own_receipt_or_a_confirmed_rejection() {
        for failure in [
            Err(RequestFailure::Transport("connection closed".into())),
            Err(RequestFailure::Http(504, "gateway timeout".into())),
            Err(RequestFailure::Http(408, "timeout".into())),
            Ok(json!({"id":"other-turn"})),
        ] {
            assert_eq!(delivery_receipt("turn", failure)["delivery"], "unknown");
        }
        assert_eq!(
            delivery_receipt("turn", Ok(json!({"id":"turn"})))["delivery"],
            "accepted"
        );
        assert_eq!(
            delivery_receipt("turn", Err(RequestFailure::Http(413, "too large".into())))
                ["delivery"],
            "rejected"
        );
    }
}
