//! Account selection is Hub-local. Official Codex owns login and renewable secrets.
use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

const DESKTOP: &str = "desktop";
const REGISTRY_FILE: &str = "codex-accounts-v1.json";
static REGISTRY: Mutex<()> = Mutex::new(());
static LOGIN: Mutex<Option<Login>> = Mutex::new(None);
static ACCOUNT_READ: Mutex<()> = Mutex::new(());

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Profile {
    id: String,
    label: String,
    scope_id: String,
    plan: String,
    #[serde(default)]
    workspace_label: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Registry {
    schema_version: u8,
    selected: String,
    accounts: Vec<Profile>,
}
impl Default for Registry {
    fn default() -> Self {
        Self {
            schema_version: 1,
            selected: DESKTOP.into(),
            accounts: vec![],
        }
    }
}
struct Login {
    root: PathBuf,
    id: String,
    cancel: Arc<AtomicBool>,
    view: Value,
}
pub(crate) struct Account {
    pub(crate) public: Value,
    pub(crate) login: Value,
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
}
fn load(root: &Path) -> Result<Registry, String> {
    let path = root.join(REGISTRY_FILE);
    if !path.exists() {
        return Ok(Registry::default());
    }
    let bytes = std::fs::read(path).map_err(|_| "无法读取 Codex 账号设置")?;
    if bytes.len() > 65536 {
        return Err("Codex 账号设置过大".into());
    }
    let value: Registry = serde_json::from_slice(&bytes).map_err(|_| "Codex 账号设置格式无效")?;
    if value.schema_version != 1
        || value.accounts.len() > 32
        || !valid_id(&value.selected)
        || value.accounts.iter().any(|p| {
            !valid_id(&p.id)
                || p.label.len() > 320
                || p.scope_id.len() != 64
                || p.plan.len() > 80
                || p.workspace_label.len() > 100
        })
        || value
            .accounts
            .iter()
            .map(|p| &p.id)
            .collect::<std::collections::HashSet<_>>()
            .len()
            != value.accounts.len()
        || (value.selected != DESKTOP && !value.accounts.iter().any(|p| p.id == value.selected))
    {
        return Err("Codex 账号设置无效，请恢复设置文件后重试".into());
    }
    Ok(value)
}
fn save(root: &Path, value: &Registry) -> Result<(), String> {
    std::fs::create_dir_all(root).map_err(|_| "无法保存 Codex 账号设置")?;
    let path = root.join(format!(
        ".codex-accounts-{}.tmp",
        crate::random_url_safe(12)
    ));
    let result = (|| {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)?;
        file.write_all(&serde_json::to_vec(value)?)?;
        file.sync_all()?;
        std::fs::rename(&path, root.join(REGISTRY_FILE))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(path);
        return Err("无法保存 Codex 账号选择，原设置已保留".into());
    }
    Ok(())
}
fn profile_home(root: &Path, id: &str) -> Result<PathBuf, String> {
    if id == DESKTOP || !valid_id(id) {
        return Err("Codex 账号身份无效".into());
    }
    Ok(root.join("codex-accounts").join(id))
}
fn process(root: &Path, selected: &str, timeout: Duration) -> Result<CatalogProcess, String> {
    let control = Control::bounded(timeout);
    let exe = executable_control(false, &control)?;
    let mut command = Command::new(exe.path);
    command
        .args(["app-server", "--stdio", "-c", "model_provider=\"openai\""])
        .env_remove("OPENAI_API_KEY")
        .env_remove("CODEX_ACCESS_TOKEN");
    if selected != DESKTOP {
        let home = profile_home(root, selected)?;
        std::fs::create_dir_all(&home).map_err(|_| "无法建立 Codex 账号目录")?;
        command.env("CODEX_HOME", &home).current_dir(&home).args([
            "-c",
            "cli_auth_credentials_store=\"keyring\"",
            "-c",
            "model_provider=\"openai\"",
        ]);
        // A Hub profile must not inherit an API key from the launching shell.
        command
            .env_remove("OPENAI_API_KEY")
            .env_remove("CODEX_ACCESS_TOKEN");
    }
    let process = CatalogProcess::start_control(command, Instant::now() + timeout, &control)?;
    let initial_deadline = Instant::now() + Duration::from_secs(25);
    process.send(json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"hub_account_manager","title":"Hub","version":env!("CARGO_PKG_VERSION")}}}))?;
    process.response_before(1, initial_deadline)?;
    process.send(json!({"method":"initialized"}))?;
    Ok(process)
}
fn rpc(process: &CatalogProcess, id: u64, method: &str, params: Value) -> Result<Value, String> {
    process.send(json!({"id":id,"method":method,"params":params}))?;
    process
        .response_before(id, Instant::now() + Duration::from_secs(25))
        .map_err(|_| "Codex 账号请求失败，请检查登录状态和 CLI 版本".into())
}
fn mask_email(email: &str) -> String {
    let Some((name, domain)) = email.split_once('@') else {
        return "ChatGPT 账号".into();
    };
    if email.len() > 320 || name.is_empty() || domain.is_empty() {
        return "ChatGPT 账号".into();
    }
    format!("{}***@{}", name.chars().next().unwrap(), domain)
}
fn claims(token: &str) -> Result<Value, String> {
    let part = token
        .split('.')
        .nth(1)
        .filter(|s| s.len() <= 65536)
        .ok_or("Codex 未提供可识别的账号身份")?;
    let bytes = URL_SAFE_NO_PAD
        .decode(part.trim_end_matches('='))
        .map_err(|_| "Codex 账号身份格式不可用")?;
    serde_json::from_slice(&bytes).map_err(|_| "Codex 账号身份格式不可用".into())
}
fn account(status: &Value, info: &Value) -> Result<Account, String> {
    let token = status["authToken"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 65536)
        .ok_or("当前 Codex 未登录，请在桌面应用登录或添加账号")?;
    let mode = status["authMethod"].as_str().unwrap_or("");
    if mode == "apikey" {
        return Ok(Account {
            public: json!({"scopeId":format!("{:x}",Sha256::digest(token.as_bytes())),"label":"API 密钥","kind":"apiKey","plan":""}),
            login: json!({"type":"apiKey","apiKey":token}),
        });
    }
    if !matches!(mode, "chatgpt" | "chatgptAuthTokens") || info["account"]["type"] != "chatgpt" {
        return Err("当前 Codex 登录方式暂不支持账号选择".into());
    }
    let value = claims(token)?;
    if value["exp"]
        .as_i64()
        .is_some_and(|exp| exp <= chrono::Utc::now().timestamp())
    {
        return Err("Codex 登录已过期，请在桌面应用刷新登录，或在 Hub 重新添加该账号".into());
    }
    let auth = &value["https://api.openai.com/auth"];
    let workspace = auth["chatgpt_account_id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("Codex 未报告工作区身份")?;
    let user = auth["chatgpt_user_id"]
        .as_str()
        .or_else(|| value["sub"].as_str())
        .filter(|s| !s.is_empty())
        .ok_or("Codex 未报告用户身份")?;
    let scope = format!(
        "{:x}",
        Sha256::digest(json!([user, workspace]).to_string().as_bytes())
    );
    let label = mask_email(info["account"]["email"].as_str().unwrap_or(""));
    let plan = info["account"]["planType"].as_str().unwrap_or("");
    let workspace_label = format!(
        "工作区尾号 {}",
        workspace
            .chars()
            .rev()
            .take(6)
            .collect::<String>()
            .chars()
            .rev()
            .collect::<String>()
    );
    Ok(Account {
        public: json!({"scopeId":scope,"label":label,"kind":"chatgpt","plan":plan,"workspaceLabel":workspace_label}),
        login: json!({"type":"chatgptAuthTokens","accessToken":token,"chatgptAccountId":workspace,"chatgptPlanType":if plan.is_empty(){Value::Null}else{json!(plan)}}),
    })
}
fn inspect(root: &Path, selected: &str) -> Result<Account, String> {
    let _refresh_owner = ACCOUNT_READ.lock().map_err(|_| "账号认证繁忙，请重试")?;
    let process = process(root, selected, Duration::from_secs(60))?;
    // This official desktop RPC returns the chosen store's token only to native memory.
    let mut status = rpc(
        &process,
        2,
        "getAuthStatus",
        json!({"includeToken":true,"refreshToken":false}),
    )?;
    if selected != DESKTOP
        && status["authToken"]
            .as_str()
            .and_then(|t| claims(t).ok())
            .and_then(|v| v["exp"].as_i64())
            .is_some_and(|exp| exp <= chrono::Utc::now().timestamp() + 60)
    {
        status = rpc(
            &process,
            3,
            "getAuthStatus",
            json!({"includeToken":true,"refreshToken":true}),
        )?;
    }
    let info = rpc(&process, 4, "account/read", json!({"refreshToken":false}))?;
    account(&status, &info)
}
pub(crate) fn current(root: &Path) -> Result<Account, String> {
    current_selected(root, None)
}
pub(crate) fn current_selected(root: &Path, selected: Option<&str>) -> Result<Account, String> {
    let mut registry = {
        let _lock = REGISTRY.lock().map_err(|_| "账号设置繁忙")?;
        load(root)?
    };
    if let Some(selected) = selected {
        if selected != DESKTOP && !registry.accounts.iter().any(|p| p.id == selected) {
            return Err("请求绑定的 Codex 账号已被移除，未改用其他账号".into());
        }
        registry.selected = selected.into();
    }
    inspect_selected(root, &registry)
}
fn inspect_selected(root: &Path, registry: &Registry) -> Result<Account, String> {
    let value = inspect(root, &registry.selected)?;
    if registry.selected != DESKTOP {
        let saved = registry
            .accounts
            .iter()
            .find(|p| p.id == registry.selected)
            .ok_or("所选 Codex 账号不可用")?;
        if value.public["scopeId"] != saved.scope_id {
            return Err("所选 Codex 账号身份已改变，请重新登录；未改用其他账号".into());
        }
    }
    Ok(value)
}
pub(crate) fn selected(root: &Path) -> Result<String, String> {
    let _lock = REGISTRY.lock().map_err(|_| "账号设置繁忙")?;
    Ok(load(root)?.selected)
}
fn status(root: &Path) -> Result<Value, String> {
    let registry = {
        let _lock = REGISTRY.lock().map_err(|_| "账号设置繁忙")?;
        load(root)?
    };
    let (current, error) = match inspect_selected(root, &registry) {
        Ok(a) => (a.public, None),
        Err(e) => (Value::Null, Some(e)),
    };
    let login = LOGIN
        .lock()
        .map_err(|_| "登录状态繁忙")?
        .as_ref()
        .filter(|p| p.root == root)
        .map(|p| p.view.clone());
    Ok(
        json!({"selected":registry.selected,"accounts":registry.accounts,"current":current,"error":error,"login":login}),
    )
}
fn valid_auth_url(value: &str) -> bool {
    url::Url::parse(value).is_ok_and(|u| {
        u.scheme() == "https"
            && matches!(u.host_str(), Some("auth.openai.com" | "chatgpt.com"))
            && u.username().is_empty()
            && u.password().is_none()
    })
}
fn start_login(root: &Path) -> Result<Value, String> {
    let mut slot = LOGIN.lock().map_err(|_| "登录状态繁忙")?;
    if slot.as_ref().is_some_and(|p| p.view["state"] == "pending") {
        return Err("已有账号正在登录，请先完成或取消".into());
    }
    {
        let _lock = REGISTRY.lock().map_err(|_| "账号设置繁忙")?;
        if load(root)?.accounts.len() >= 32 {
            return Err("已达到 32 个账号的保存上限".into());
        }
    }
    let id = crate::random_url_safe(24);
    let process = process(root, &id, Duration::from_secs(900))?;
    let response = rpc(
        &process,
        2,
        "account/login/start",
        json!({"type":"chatgpt"}),
    )?;
    let provider_id = response["loginId"]
        .as_str()
        .filter(|s| s.len() <= 200)
        .ok_or("Codex 未返回登录身份")?
        .to_owned();
    let auth_url = response["authUrl"]
        .as_str()
        .filter(|url| valid_auth_url(url))
        .ok_or("Codex 未返回受支持的官方登录地址")?
        .to_owned();
    let cancel = Arc::new(AtomicBool::new(false));
    let view = json!({"id":id,"state":"pending","authUrl":auth_url});
    *slot = Some(Login {
        root: root.to_path_buf(),
        id: id.clone(),
        cancel: cancel.clone(),
        view: view.clone(),
    });
    let root = root.to_path_buf();
    std::thread::spawn(move || {
        let result = finish_login(&process, &root, &id, &provider_id, &cancel);
        if result.is_err() {
            let _ = rpc(&process, 99, "account/logout", json!({}));
        }
        if let Ok(mut slot) = LOGIN.lock() {
            if let Some(pending) = slot.as_mut().filter(|p| p.root == root && p.id == id) {
                pending.view = match result {
                    Ok(profile) => json!({"id":id,"state":"completed","profile":profile}),
                    Err(error) => {
                        json!({"id":id,"state":if cancel.load(Ordering::SeqCst){"cancelled"}else{"failed"},"error":error})
                    }
                };
            }
        }
    });
    Ok(view)
}
fn finish_login(
    process: &CatalogProcess,
    root: &Path,
    id: &str,
    provider_id: &str,
    cancel: &AtomicBool,
) -> Result<Profile, String> {
    loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = rpc(
                process,
                5,
                "account/login/cancel",
                json!({"loginId":provider_id}),
            );
            return Err("已取消登录".into());
        }
        if Instant::now() >= process.deadline {
            return Err("登录已超时，请重新添加账号".into());
        }
        match process.messages.recv_timeout(Duration::from_millis(250)) {
            Ok(Ok(event))
                if event["method"] == "account/login/completed"
                    && event["params"]["loginId"] == provider_id =>
            {
                if event["params"]["success"] != true {
                    return Err("Codex 登录未完成，请重新添加账号".into());
                }
                break;
            }
            Ok(Err(_)) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("Codex 登录进程已结束，请重试".into())
            }
            _ => {}
        }
    }
    let token = rpc(
        process,
        6,
        "getAuthStatus",
        json!({"includeToken":true,"refreshToken":false}),
    )?;
    let info = rpc(process, 7, "account/read", json!({"refreshToken":false}))?;
    let account = account(&token, &info)?;
    if account.public["kind"] != "chatgpt" {
        return Err("请使用 ChatGPT 账号完成授权".into());
    }
    let profile = Profile {
        id: id.into(),
        label: account.public["label"].as_str().unwrap().into(),
        scope_id: account.public["scopeId"].as_str().unwrap().into(),
        plan: account.public["plan"].as_str().unwrap_or("").into(),
        workspace_label: account.public["workspaceLabel"]
            .as_str()
            .unwrap_or("")
            .into(),
    };
    let _lock = REGISTRY.lock().map_err(|_| "账号设置繁忙")?;
    if cancel.load(Ordering::SeqCst) {
        return Err("已取消登录".into());
    }
    let mut registry = load(root)?;
    registry.accounts.push(profile.clone());
    save(root, &registry)?;
    Ok(profile)
}
pub(crate) fn ui(root: &Path, args: &Value) -> Result<Value, String> {
    match args["action"].as_str().unwrap_or("") {
        "codexAccounts" => status(root),
        "startCodexLogin" => start_login(root),
        "cancelCodexLogin" => {
            let slot = LOGIN.lock().map_err(|_| "登录状态繁忙")?;
            let pending = slot
                .as_ref()
                .filter(|p| p.root == root && p.view["state"] == "pending" && p.id == args["id"])
                .ok_or("该登录请求已经结束")?;
            pending.cancel.store(true, Ordering::SeqCst);
            Ok(json!({"requested":true}))
        }
        "selectCodexAccount" => {
            let selected = args["id"].as_str().ok_or("请选择 Codex 账号")?;
            let _lock = REGISTRY.lock().map_err(|_| "账号设置繁忙")?;
            let mut registry = load(root)?;
            if selected != DESKTOP && !registry.accounts.iter().any(|p| p.id == selected) {
                return Err("所选 Codex 账号不存在".into());
            }
            registry.selected = selected.into();
            save(root, &registry)?;
            Ok(json!({"selected":selected}))
        }
        "removeCodexAccount" => {
            let id = args["id"].as_str().ok_or("请选择要移除的账号")?;
            // Keep selection and logout atomic: another window must not select a profile being removed.
            let _lock = REGISTRY.lock().map_err(|_| "账号设置繁忙")?;
            let mut registry = load(root)?;
            if registry.selected == id {
                return Err("请先切换到其他账号，再移除此账号".into());
            }
            if !registry.accounts.iter().any(|p| p.id == id) {
                return Err("该账号不存在".into());
            }
            let process = process(root, id, Duration::from_secs(45))?;
            rpc(&process, 2, "account/logout", json!({}))?;
            registry.accounts.retain(|p| p.id != id);
            save(root, &registry)?;
            Ok(json!({"removed":id}))
        }
        _ => Err("不支持的 Codex 账号操作".into()),
    }
}

#[cfg(test)]
mod tests;
