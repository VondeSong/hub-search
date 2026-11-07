//! Isolated Codex CLI adapter; only suite admission invokes production generation.
#[cfg(test)]
use super::validate_selection;
use super::Control;
use crate::random_url_safe;
use serde_json::{json, Value};
use std::io::{BufRead, Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant};
pub(super) mod accounts;
pub(super) mod agent;
#[cfg(test)]
#[path = "process_probe.rs"]
mod process_probe;
pub(super) const GENERATION_TIMEOUT: &str = "Codex 生成超时，请重试。";

struct JobDir(PathBuf);
impl Drop for JobDir {
    fn drop(&mut self) {
        // Only remove this freshly-created, fixed-prefix job directory.
        if self.0.parent() == Some(std::env::temp_dir().as_path())
            && self
                .0
                .file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with("hub-codex-suite-"))
        {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

#[derive(Clone)]
struct CliExecutable {
    path: PathBuf,
    version: (u32, u32, u32),
}

pub(super) fn candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    // The desktop application includes its own official CLI. An older global
    // npm install must not shadow this newer catalog and execution engine.
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let desktop = PathBuf::from(local).join("OpenAI/Codex/bin");
        candidates.push(desktop.join("codex.exe"));
        if let Ok(entries) = std::fs::read_dir(desktop) {
            let mut installed: Vec<_> = entries
                .flatten()
                .filter_map(|entry| {
                    entry
                        .file_type()
                        .ok()?
                        .is_dir()
                        .then(|| entry.path().join("codex.exe"))
                })
                .collect();
            installed.sort();
            candidates.extend(installed.into_iter().take(16));
        }
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        let npm = PathBuf::from(appdata).join("npm/node_modules/@openai/codex");
        candidates.push(npm.join(
            "node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
        ));
        candidates.push(npm.join("vendor/x86_64-pc-windows-msvc/bin/codex.exe"));
    }
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(
            std::env::split_paths(&path)
                .map(|p| p.join(if cfg!(windows) { "codex.exe" } else { "codex" })),
        );
    }
    let mut unique = Vec::new();
    for path in candidates {
        if path.is_file() && !unique.contains(&path) {
            unique.push(path);
        }
    }
    unique.truncate(32);
    unique
}

fn parse_version(value: &str) -> Option<(u32, u32, u32)> {
    let version = value
        .trim()
        .strip_prefix("codex-cli ")?
        .split_whitespace()
        .next()?;
    let core = version.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let version = (
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    );
    parts.next().is_none().then_some(version)
}

fn choose_executable(
    candidates: Vec<PathBuf>,
    mut probe: impl FnMut(&std::path::Path) -> Option<(u32, u32, u32)>,
) -> Result<CliExecutable, String> {
    let mut selected: Option<CliExecutable> = None;
    for path in candidates {
        let Some(version) = probe(&path) else {
            continue;
        };
        if selected.as_ref().is_none_or(|old| version > old.version) {
            selected = Some(CliExecutable { path, version });
        }
    }
    selected.ok_or("未找到可用的 Codex CLI，请安装并运行 codex login 后重试。".into())
}

fn executable_control(refresh: bool, control: &Control) -> Result<CliExecutable, String> {
    static SELECTED: OnceLock<Mutex<Option<CliExecutable>>> = OnceLock::new();
    let lock = SELECTED.get_or_init(|| Mutex::new(None));
    let mut cached = loop {
        control.check()?;
        match lock.try_lock() {
            Ok(guard) => break guard,
            Err(std::sync::TryLockError::Poisoned(_)) => {
                return Err("Codex CLI 状态暂不可用。".into())
            }
            Err(std::sync::TryLockError::WouldBlock) => {
                std::thread::sleep(Duration::from_millis(20))
            }
        }
    };
    if !refresh {
        if let Some(selected) = cached.as_ref().filter(|selected| selected.path.is_file()) {
            return Ok(selected.clone());
        }
    }
    let deadline = control.deadline(Instant::now() + Duration::from_secs(8));
    let selection = choose_executable(candidates(), |path| {
        if Instant::now() >= deadline || control.check().is_err() {
            return None;
        }
        let mut command = Command::new(path);
        command.arg("--version");
        let bytes = bounded_output_control(
            command,
            deadline.min(Instant::now() + Duration::from_secs(2)),
            512,
            control,
        )
        .ok()?;
        parse_version(std::str::from_utf8(&bytes).ok()?)
    });
    control.check()?;
    let selected = selection?;
    *cached = Some(selected.clone());
    Ok(selected)
}

fn parse_models(models: &Value) -> Result<Value, String> {
    let models = models.as_array().ok_or("Codex 模型列表格式无效")?;
    let mut result = Vec::new();
    for model in models {
        // Client model/list is authoritative for picker visibility. In
        // particular, raw debug visibility can disagree for legacy models.
        if model["hidden"].as_bool() != Some(false) {
            continue;
        }
        let Some(id) = model["model"].as_str().filter(|id| valid_model_id(id)) else {
            continue;
        };
        if result.iter().any(|m: &Value| m["id"] == id) {
            continue;
        }
        let efforts: Vec<&str> = model["supportedReasoningEfforts"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|level| level["reasoningEffort"].as_str())
            .filter(|effort| valid_effort(effort))
            .collect();
        result.push(json!({"id":id,"name":model["displayName"].as_str().unwrap_or(id),
            "reasoningLevels":efforts,"defaultReasoning":model["defaultReasoningEffort"].as_str().filter(|e|efforts.contains(e))}));
        if let Some(description) = model["serviceTiers"]
            .as_array()
            .and_then(|tiers| tiers.iter().find(|tier| tier["id"] == "priority"))
            .and_then(|tier| tier["description"].as_str())
        {
            if let Some(entry) = result.last_mut() {
                entry["fastDescription"] = json!(description);
            }
        }
    }
    Ok(json!({"models":result}))
}

fn valid_model_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 120
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-._".contains(&b))
}

fn valid_effort(effort: &str) -> bool {
    matches!(
        effort,
        "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
    )
}

fn hidden_command(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
}

#[cfg(test)]
fn bounded_output(command: Command, deadline: Instant, limit: u64) -> Result<Vec<u8>, String> {
    bounded_output_control(command, deadline, limit, &Control::default())
}
fn bounded_output_control(
    mut command: Command,
    deadline: Instant,
    limit: u64,
    control: &Control,
) -> Result<Vec<u8>, String> {
    control.check()?;
    if Instant::now() >= deadline {
        return Err("读取 Codex 模型超时，请刷新后重试。".into());
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    hidden_command(&mut command);
    let mut child = command
        .spawn()
        .map_err(|_| "无法启动 Codex 模型读取进程。")?;
    let result = (|| {
        let stdout = child.stdout.take().ok_or("Codex 模型输出管道不可用。")?;
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut output = Vec::new();
            let result = stdout
                .take(limit + 1)
                .read_to_end(&mut output)
                .map_err(|_| "Codex 模型输出读取失败。".to_string())
                .and_then(|_| {
                    if output.len() as u64 > limit {
                        Err("Codex 模型列表过大。".into())
                    } else {
                        Ok(output)
                    }
                });
            let _ = tx.send(result);
        });
        loop {
            control.check()?;
            if Instant::now() >= deadline {
                return Err("读取 Codex 模型超时，请刷新后重试。".into());
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    if !status.success() {
                        return Err("读取 Codex 模型失败，请检查 CLI 后刷新。".into());
                    }
                    loop {
                        control.check()?;
                        if Instant::now() >= deadline {
                            return Err("Codex 模型输出读取超时。".into());
                        }
                        match rx.recv_timeout(Duration::from_millis(20)) {
                            Ok(result) => return result,
                            Err(mpsc::RecvTimeoutError::Timeout) => continue,
                            Err(_) => return Err("Codex 模型输出读取失败。".into()),
                        }
                    }
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(20)),
                Err(_) => return Err("Codex 模型进程状态读取失败。".into()),
            }
        }
    })();
    stop_child(&mut child);
    result
}

struct CatalogProcess {
    child: std::process::Child,
    #[cfg(windows)]
    group: Option<agent::ProcessGroup>,
    requests: mpsc::SyncSender<Value>,
    messages: mpsc::Receiver<Result<Value, String>>,
    deadline: Instant,
    control: Control,
}
impl Drop for CatalogProcess {
    fn drop(&mut self) {
        #[cfg(windows)]
        drop(self.group.take());
        stop_child(&mut self.child);
    }
}
impl CatalogProcess {
    #[cfg(test)]
    fn start(command: Command, deadline: Instant) -> Result<Self, String> {
        Self::start_control(command, deadline, &Control::default())
    }
    fn start_control(
        mut command: Command,
        deadline: Instant,
        control: &Control,
    ) -> Result<Self, String> {
        control.check()?;
        if Instant::now() >= deadline {
            return Err("读取 Codex 模型超时，请刷新后重试。".into());
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        hidden_command(&mut command);
        let mut child = command
            .spawn()
            .map_err(|_| "无法启动 Codex 模型读取进程。")?;
        #[cfg(windows)]
        let group = match agent::ProcessGroup::attach(child.id()) {
            Ok(group) => Some(group),
            Err(error) => {
                stop_child(&mut child);
                return Err(error);
            }
        };
        let Some(mut stdin) = child.stdin.take() else {
            stop_child(&mut child);
            return Err("Codex 模型输入管道不可用。".into());
        };
        let Some(stdout) = child.stdout.take() else {
            stop_child(&mut child);
            return Err("Codex 模型输出管道不可用。".into());
        };
        let (requests, pending) = mpsc::sync_channel::<Value>(1);
        let (tx, messages) = mpsc::channel();
        let errors = tx.clone();
        std::thread::spawn(move || {
            while let Ok(request) = pending.recv() {
                let mut bytes = request.to_string().into_bytes();
                bytes.push(b'\n');
                if stdin.write_all(&bytes).and_then(|_| stdin.flush()).is_err() {
                    let _ = errors.send(Err("Codex 模型请求发送失败。".into()));
                    break;
                }
            }
        });
        std::thread::spawn(move || {
            // Bound both total bytes and each message, including output without
            // a newline or an unexpected flood of protocol notifications.
            let mut reader = std::io::BufReader::new(stdout.take(4_000_001));
            let mut total = 0;
            loop {
                let mut line = Vec::new();
                match reader.read_until(b'\n', &mut line) {
                    Ok(0) => break,
                    Ok(size) => {
                        total += size;
                        let message = if total > 4_000_000 || size > 512_000 {
                            Err("Codex 模型列表过大。".into())
                        } else {
                            serde_json::from_slice(&line)
                                .map_err(|_| "Codex 模型协议格式无效。".into())
                        };
                        let failed = message.is_err();
                        if tx.send(message).is_err() || failed {
                            return;
                        }
                    }
                    Err(_) => {
                        let _ = tx.send(Err("Codex 模型输出读取失败。".into()));
                        return;
                    }
                }
            }
            let _ = tx.send(Err("Codex 模型读取进程已结束。".into()));
        });
        Ok(Self {
            child,
            requests,
            messages,
            deadline,
            control: control.clone(),
            #[cfg(windows)]
            group,
        })
    }

    fn send(&self, mut message: Value) -> Result<(), String> {
        loop {
            self.control.check()?;
            if Instant::now() >= self.deadline {
                return Err("读取 Codex 模型超时，请刷新后重试。".into());
            }
            match self.requests.try_send(message) {
                Ok(()) => return Ok(()),
                Err(mpsc::TrySendError::Full(pending)) => {
                    message = pending;
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(mpsc::TrySendError::Disconnected(_)) => {
                    return Err("Codex 模型请求发送失败。".into())
                }
            }
        }
    }

    fn response(&self, id: u64) -> Result<Value, String> {
        self.response_before(id, self.deadline)
    }
    fn response_before(&self, id: u64, deadline: Instant) -> Result<Value, String> {
        let mut notifications = 0;
        while notifications < 1024 {
            self.control.check()?;
            let remaining = deadline
                .min(self.deadline)
                .saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("读取 Codex 模型超时，请刷新后重试。".into());
            }
            let response = match self
                .messages
                .recv_timeout(remaining.min(Duration::from_millis(25)))
            {
                Ok(value) => value?,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => return Err("Codex 模型读取进程已结束。".into()),
            };
            notifications += 1;
            if response["id"] != id {
                continue;
            }
            if response.get("error").is_some() {
                // Provider messages and arbitrary subprocess data stay private.
                return Err("Codex 模型目录请求失败，请检查登录、CLI 版本后刷新。".into());
            }
            return response
                .get("result")
                .cloned()
                .ok_or("Codex 模型协议格式无效。".into());
        }
        Err("Codex 模型通知过多。".into())
    }
}

#[cfg(test)]
fn read_catalog(command: Command, deadline: Instant) -> Result<Value, String> {
    read_catalog_control(command, deadline, &Control::default())
}
fn read_catalog_control(
    command: Command,
    deadline: Instant,
    control: &Control,
) -> Result<Value, String> {
    let process = CatalogProcess::start_control(command, deadline, control)?;
    process.send(json!({"method":"initialize","id":1,"params":{"clientInfo":{"name":"hub_codex_suite","title":"Hub","version":env!("CARGO_PKG_VERSION")}}}))?;
    process.response(1)?;
    process.send(json!({"method":"initialized","params":{}}))?;
    let mut cursor: Option<String> = None;
    let mut seen = std::collections::HashSet::new();
    let mut models = Vec::new();
    for page in 0..32 {
        process.send(json!({"method":"model/list","id":page+2,"params":{"limit":100,"includeHidden":false,"cursor":cursor}}))?;
        let response = process.response(page + 2)?;
        let data = response["data"]
            .as_array()
            .ok_or("Codex 模型列表格式无效。")?;
        if data.len() > 100 || models.len() + data.len() > 2000 {
            return Err("Codex 模型列表过大。".into());
        }
        models.extend(data.iter().cloned());
        match response.get("nextCursor") {
            None | Some(Value::Null) => return Ok(Value::Array(models)),
            Some(Value::String(next))
                if !next.is_empty() && next.len() <= 1024 && seen.insert(next.clone()) =>
            {
                cursor = Some(next.clone())
            }
            _ => return Err("Codex 模型目录分页无效。".into()),
        }
    }
    Err("Codex 模型目录分页过多。".into())
}

fn enrich_fast_capabilities(parsed: &mut Value, selectable: &Value, raw: &Value) {
    for entry in parsed["models"].as_array_mut().into_iter().flatten() {
        let id = entry["id"].as_str().unwrap_or_default();
        // Explicit empty serviceTiers means unsupported. Only older RPC
        // versions that omit the field need same-binary raw metadata fallback.
        if selectable
            .as_array()
            .into_iter()
            .flatten()
            .find(|m| m["model"] == id)
            .is_some_and(|m| m.get("serviceTiers").is_some())
        {
            continue;
        }
        if let Some(description) = raw["models"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|m| m["slug"] == id)
            .and_then(|m| m["service_tiers"].as_array())
            .and_then(|tiers| tiers.iter().find(|tier| tier["id"] == "priority"))
            .and_then(|tier| tier["description"].as_str())
        {
            entry["fastDescription"] = json!(description);
        }
    }
}

fn optional_fast_enrichment(
    parsed: &mut Value,
    selectable: &Value,
    load: impl FnOnce() -> Result<Value, String>,
) {
    if selectable
        .as_array()
        .into_iter()
        .flatten()
        .any(|m| m["hidden"] == false && m.get("serviceTiers").is_none())
    {
        // Valid picker entries survive optional metadata failure. Missing
        // capabilities keep Fast disabled without guessing account access.
        if let Ok(raw) = load() {
            enrich_fast_capabilities(parsed, selectable, &raw);
        }
    }
}

#[cfg(test)]
pub(super) fn models() -> Result<Value, String> {
    models_control(&Control::default())
}
pub(super) fn models_control(control: &Control) -> Result<Value, String> {
    let deadline = control.deadline(Instant::now() + Duration::from_secs(20));
    // Catalog loads are already cached by the suite. A forced UI refresh also
    // discovers newly installed/upgraded CLIs; generation uses this selection.
    let exe = executable_control(true, control)?;
    let dir = JobDir(std::env::temp_dir().join(format!("hub-codex-suite-{}", random_url_safe(18))));
    std::fs::create_dir(&dir.0).map_err(|e| e.to_string())?;
    let mut cmd = Command::new(&exe.path);
    // exec ignores user config and uses the built-in OpenAI provider. Discovery
    // explicitly selects that provider and shares auth; app-server currently
    // has no --ignore-user-config option.
    cmd.args(["app-server", "--stdio", "-c", "model_provider=\"openai\""])
        .current_dir(&dir.0);
    let selectable = read_catalog_control(cmd, deadline, control)?;
    let mut parsed = parse_models(&selectable)?;
    optional_fast_enrichment(&mut parsed, &selectable, || {
        let mut raw_command = Command::new(&exe.path);
        raw_command
            .args(["debug", "models", "-c", "model_provider=\"openai\""])
            .current_dir(&dir.0);
        let raw = bounded_output_control(
            raw_command,
            deadline.min(Instant::now() + Duration::from_secs(3)),
            4_000_000,
            control,
        )?;
        let raw: Value = serde_json::from_slice(&raw).map_err(|_| "Codex 模型列表格式无效。")?;
        Ok(raw)
    });
    control.check()?;
    parsed["cliVersion"] = json!(format!(
        "{}.{}.{}",
        exe.version.0, exe.version.1, exe.version.2
    ));
    parsed["discovery"] = json!("app-server");
    Ok(parsed)
}

pub(super) fn validate_fast(catalog: &Value, model: &str, fast: bool) -> Result<(), String> {
    if fast
        && !catalog["models"].as_array().is_some_and(|models| {
            models
                .iter()
                .any(|m| m["id"] == model && m["fastDescription"].is_string())
        })
    {
        return Err("所选模型当前不支持 Fast，请关闭 Fast 或更换模型。".into());
    }
    Ok(())
}

fn configure_model(cmd: &mut Command, model: &str, effort: &str, fast: bool) {
    if !model.is_empty() {
        cmd.arg("--model").arg(model);
    }
    if !effort.is_empty() {
        cmd.arg("-c")
            .arg(format!("model_reasoning_effort={effort}"));
    }
    if fast {
        cmd.args(["-c", "service_tier=fast", "--enable", "fast_mode"]);
    }
}

#[cfg(test)]
pub(super) fn run(
    prompt: &str,
    schema_value: &Value,
    model: &str,
    effort: &str,
    fast: bool,
    images: &[PathBuf],
) -> Result<Value, String> {
    run_control(
        prompt,
        schema_value,
        model,
        effort,
        fast,
        images,
        &Control::default(),
    )
}
pub(super) fn run_control(
    prompt: &str,
    schema_value: &Value,
    model: &str,
    effort: &str,
    fast: bool,
    images: &[PathBuf],
    control: &Control,
) -> Result<Value, String> {
    let exe = executable_control(false, control)?;
    let dir = JobDir(std::env::temp_dir().join(format!("hub-codex-suite-{}", random_url_safe(18))));
    std::fs::create_dir(&dir.0).map_err(|e| e.to_string())?;
    let schema = dir.0.join("schema.json");
    let output = dir.0.join("result.json");
    std::fs::write(&schema, schema_value.to_string()).map_err(|e| e.to_string())?;
    let mut cmd = Command::new(exe.path);
    cmd.args([
        "exec",
        "--ignore-user-config",
        "--ephemeral",
        "--json",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--disable",
        "shell_tool",
        "--color",
        "never",
        "--output-schema",
    ])
    .arg(&schema)
    .arg("--output-last-message")
    .arg(&output)
    .arg("-")
    .current_dir(&dir.0)
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    configure_model(&mut cmd, model, effort, fast);
    if control.deadline.is_some() {
        configure_investigation(&mut cmd);
    }
    for path in images {
        cmd.arg("--image").arg(path);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    #[cfg(test)]
    let capture = if let Some(root) = std::env::var_os("HUB_CODEX_TEST_CAPTURE_ROOT") {
        let root =
            std::fs::canonicalize(PathBuf::from(root)).map_err(|_| "测试请求记录目录不存在")?;
        let temporary =
            std::fs::canonicalize(std::env::temp_dir()).map_err(|_| "测试临时根不可用")?;
        if !root.starts_with(&temporary) {
            return Err("测试请求记录必须位于隔离临时根".into());
        }
        let path = root.join(format!("{}.json", random_url_safe(18)));
        let record = json!({"prompt":prompt,"schema":schema_value,"model":model,"effort":effort,"cliPath":cmd.get_program().to_string_lossy(),"cliVersion":exe.version,
            "jobDirectory":dir.0,"arguments":cmd.get_args().map(|a|a.to_string_lossy().into_owned()).collect::<Vec<_>>()});
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .map_err(|e| e.to_string())?;
        file.write_all(record.to_string().as_bytes())
            .map_err(|e| e.to_string())?;
        Some(path)
    } else {
        None
    };
    // Preserve room for a bounded investigation to recover without extending
    // its total deadline. Existing domain callers keep their original limit.
    let execution = execute_control(cmd, prompt, control.generation_limit(), control);
    #[cfg(test)]
    if let Some(path) = capture {
        let mut record: Value =
            serde_json::from_slice(&std::fs::read(&path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        record["execution"] = json!({"ok":execution.is_ok(),"error":execution.as_ref().err(),"outputBytes":std::fs::metadata(&output).ok().map(|m|m.len())});
        std::fs::write(path, record.to_string()).map_err(|e| e.to_string())?;
    }
    let completed_output = execution?;
    control.check()?;
    if let Some(value) = completed_output {
        return Ok(value);
    }
    let metadata = std::fs::metadata(&output).map_err(|_| "Codex 未返回结果，请重试。")?;
    if metadata.len() > 40000 {
        return Err("Codex 返回内容过长，请重试。".into());
    }
    let raw = std::fs::read_to_string(output).map_err(|e| e.to_string())?;
    let value: Value = serde_json::from_str(&raw).map_err(|_| "Codex 返回格式无效，请重试。")?;
    Ok(value)
}

fn configure_investigation(cmd: &mut Command) {
    configure_investigation_mode(cmd, false);
}
fn configure_investigation_mode(cmd: &mut Command, native_tools: bool) {
    // An investigation's tools are host-dispatched JSON requests. Read-only
    // sandboxing alone still permits cached web search and connector reads.
    if !native_tools {
        cmd.args(["-c", "web_search=\"disabled\""]);
    }
    for feature in [
        "apps",
        "plugins",
        "remote_plugin",
        "hooks",
        "memories",
        "skill_search",
        "multi_agent",
        "multi_agent_v2",
        "computer_use",
        "browser_use",
        "browser_use_external",
        "in_app_browser",
        "image_generation",
        "view_image",
        "code_mode",
        "code_mode_host",
        "workspace_dependencies",
        "artifact",
        "goals",
        "tool_suggest",
        "skill_mcp_dependency_install",
        "unbounded_connection_retries",
    ] {
        if native_tools && feature == "code_mode_host" {
            continue;
        }
        cmd.arg("--disable").arg(feature);
    }
    cmd.args(["--enable", "skip_host_skill_discovery"]);
}

fn stop_child(child: &mut std::process::Child) {
    // This is the exact process created for this request, never a name-wide kill.
    let _ = child.kill();
    let _ = child.wait();
}
#[cfg(test)]
fn execute(cmd: Command, prompt: &str, timeout: Duration) -> Result<(), String> {
    execute_control(cmd, prompt, timeout, &Control::default()).map(|_| ())
}
fn execute_control(
    cmd: Command,
    prompt: &str,
    timeout: Duration,
    control: &Control,
) -> Result<Option<Value>, String> {
    let trace = super::execution::Trace::new();
    let mut exit_code = None;
    let result = execute_traced(cmd, prompt, timeout, control, &trace, &mut exit_code);
    let outcome = match &result {
        Ok(Some(_)) => "completedOutput",
        Ok(None) => "processSuccess",
        Err(error) if error == GENERATION_TIMEOUT => "callTimeout",
        Err(_) if control.cancelled.load(std::sync::atomic::Ordering::SeqCst) => "cancelled",
        Err(_) if control.remaining().is_some_and(|d| d.is_zero()) => "runDeadline",
        Err(_) => "failed",
    };
    control.record_execution(trace.finish(outcome, exit_code));
    result
}
fn execute_traced(
    mut cmd: Command,
    prompt: &str,
    timeout: Duration,
    control: &Control,
    trace: &super::execution::Trace,
    exit_code: &mut Option<i32>,
) -> Result<Option<Value>, String> {
    use std::sync::mpsc::{channel, TryRecvError};
    let started = Instant::now();
    control.check()?;
    #[cfg(test)]
    let probe = process_probe::Probe::start(&cmd);
    cmd.stdout(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|_| "无法启动 Codex，请检查 CLI 安装。")?;
    #[cfg(test)]
    if let Some(probe) = &probe {
        probe.spawned(child.id());
    }
    let Some(mut stdout) = child.stdout.take() else {
        stop_child(&mut child);
        return Err("Codex 进度管道不可用。".into());
    };
    let stream_trace = trace.clone();
    let (stream_tx, stream_rx) = channel();
    std::thread::spawn(move || {
        let mut buffer = [0u8; 4096];
        while let Ok(n) = stdout.read(&mut buffer) {
            if n == 0 {
                break;
            }
            stream_trace.stream(&buffer[..n]);
        }
        let _ = stream_tx.send(());
    });
    let Some(mut stderr) = child.stderr.take() else {
        stop_child(&mut child);
        return Err("Codex 诊断管道不可用。".into());
    };
    let (errors_tx, errors_rx) = channel();
    #[cfg(test)]
    let stderr_probe = probe.clone();
    let stderr_trace = trace.clone();
    std::thread::spawn(move || {
        let mut tail = Vec::new();
        let mut buffer = [0u8; 4096];
        while let Ok(n) = stderr.read(&mut buffer) {
            if n == 0 {
                break;
            }
            stderr_trace.stderr(n);
            #[cfg(test)]
            if let Some(probe) = &stderr_probe {
                probe.stderr(&buffer[..n]);
            }
            tail.extend_from_slice(&buffer[..n]);
            if tail.len() > 12000 {
                tail.drain(..tail.len() - 12000);
            }
        }
        #[cfg(test)]
        if let Some(probe) = &stderr_probe {
            probe.phase("stderrClosed");
        }
        let _ = errors_tx.send(String::from_utf8_lossy(&tail).into_owned());
    });
    let Some(mut stdin) = child.stdin.take() else {
        stop_child(&mut child);
        return Err("Codex 输入管道不可用。".into());
    };
    let input = prompt.as_bytes().to_vec();
    let (input_tx, input_rx) = channel();
    #[cfg(test)]
    let stdin_probe = probe.clone();
    let input_trace = trace.clone();
    std::thread::spawn(move || {
        let result = stdin.write_all(&input).map_err(|_| ());
        drop(stdin);
        if result.is_ok() {
            input_trace.input_sent();
        }
        #[cfg(test)]
        if let Some(probe) = &stdin_probe {
            probe.phase(if result.is_ok() {
                "stdinClosed"
            } else {
                "stdinFailed"
            });
        }
        let _ = input_tx.send(result);
    });
    let mut input_done = false;
    let status = loop {
        #[cfg(test)]
        if let Some(probe) = &probe {
            probe.flush(false);
        }
        if let Err(error) = control.check() {
            #[cfg(test)]
            if let Some(probe) = &probe {
                probe.phase("controlStopped");
            }
            stop_child(&mut child);
            return Err(error);
        }
        if !input_done {
            match input_rx.try_recv() {
                Ok(Ok(())) => input_done = true,
                Ok(Err(())) | Err(TryRecvError::Disconnected) => {
                    stop_child(&mut child);
                    let _ = errors_rx.recv_timeout(Duration::from_millis(500));
                    return Err("无法向 Codex 发送生成请求。".into());
                }
                Err(TryRecvError::Empty) => {}
            }
        }
        if input_done {
            if let Some(value) = trace.completed_output(started + timeout) {
                // Generation has completed. CLI teardown is not another model
                // phase and must not consume the investigation's remaining time.
                if let Err(error) = control.check() {
                    stop_child(&mut child);
                    return Err(error);
                }
                stop_child(&mut child);
                *exit_code = child.try_wait().ok().flatten().and_then(|s| s.code());
                #[cfg(test)]
                if let Some(probe) = &probe {
                    probe.phase("completedOutput");
                }
                return Ok(Some(value));
            }
        }
        if started.elapsed() >= timeout {
            #[cfg(test)]
            if let Some(probe) = &probe {
                probe.phase("callDeadline");
            }
            stop_child(&mut child);
            let _ = input_rx.recv_timeout(Duration::from_millis(500));
            let _ = errors_rx.recv_timeout(Duration::from_millis(500));
            let _ = stream_rx.recv_timeout(Duration::from_millis(200));
            return Err(GENERATION_TIMEOUT.into());
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                *exit_code = status.code();
                #[cfg(test)]
                if let Some(probe) = &probe {
                    probe.phase(if status.success() {
                        "childSuccess"
                    } else {
                        "childFailure"
                    });
                }
                break status;
            }
            Ok(None) => std::thread::sleep(
                Duration::from_millis(50).min(timeout.saturating_sub(started.elapsed())),
            ),
            Err(_) => {
                stop_child(&mut child);
                let _ = input_rx.recv_timeout(Duration::from_millis(500));
                let _ = errors_rx.recv_timeout(Duration::from_millis(500));
                return Err("Codex 进程异常，请重试。".into());
            }
        }
    };
    if !input_done
        && input_rx
            .recv_timeout(Duration::from_millis(500).min(timeout.saturating_sub(started.elapsed())))
            != Ok(Ok(()))
    {
        let _ = errors_rx.recv_timeout(Duration::from_millis(500));
        return Err("无法向 Codex 发送生成请求。".into());
    }
    let errors = errors_rx
        .recv_timeout(Duration::from_millis(500).min(timeout.saturating_sub(started.elapsed())))
        .unwrap_or_default();
    let _ = stream_rx
        .recv_timeout(Duration::from_millis(500).min(timeout.saturating_sub(started.elapsed())));
    if !status.success() {
        let category =
            super::execution::failure_category(&errors).or_else(|| trace.reported_error());
        return Err(match category {
            Some("authentication") => "Codex 登录失效，请运行 codex login 后重试。",
            Some("quota") => "Codex 使用额度暂不可用，请稍后重试。",
            Some("modelUnavailable") => "当前账号无法使用所选模型，请刷新模型列表或选择其他模型。",
            _ => "Codex 生成失败，请检查 CLI 登录与网络后重试。",
        }
        .into());
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[cfg(windows)]
    fn completed_json_is_returned_and_owned_process_stopped_without_waiting_for_cli_teardown() {
        let control = Control::bounded(Duration::from_secs(5));
        let mut cmd = Command::new("powershell.exe");
        cmd.args(["-NoProfile","-NonInteractive","-Command",r#"[void][Console]::In.ReadToEnd(); [Console]::Out.WriteLine('{"type":"item.completed","item":{"type":"agent_message","text":"{\"answer\":true}"}}'); [Console]::Out.WriteLine('{"type":"turn.completed"}'); [Console]::Out.Flush(); Start-Sleep -Seconds 30"#])
            .stdin(Stdio::piped()).stderr(Stdio::piped());
        hidden_command(&mut cmd);
        let started = Instant::now();
        let value = execute_control(cmd, "synthetic", Duration::from_secs(4), &control).unwrap();
        assert_eq!(value, Some(json!({"answer":true})));
        assert!(started.elapsed() < Duration::from_secs(3));
        let receipts = control.execution_receipts();
        assert_eq!(receipts[0].outcome, "completedOutput");
        assert!(
            receipts[0].exit_code.is_some(),
            "the exact owned process was stopped and reaped"
        );
    }
    #[test]
    #[cfg(windows)]
    fn structured_cli_failure_preserves_quota_classification_without_stderr_or_message_leak() {
        let mut cmd = Command::new("powershell.exe");
        cmd.args(["-NoProfile","-NonInteractive","-Command",
            "[void][Console]::In.ReadToEnd(); [Console]::Out.WriteLine('{\"type\":\"turn.failed\",\"error\":{\"message\":\"429 usage limit PRIVATE_TOKEN\"}}'); exit 1"])
            .stdin(Stdio::piped()).stderr(Stdio::piped());
        hidden_command(&mut cmd);
        let error = execute(cmd, "synthetic", Duration::from_secs(5)).unwrap_err();
        assert!(error.contains("额度"));
        assert!(!error.contains("PRIVATE_TOKEN"));
        assert!(!super::super::is_retryable_model_error(&error));
    }
    #[test]
    #[cfg(windows)]
    fn structured_progress_is_drained_and_timeout_preserves_only_lifecycle_facts() {
        let control = Control::bounded(Duration::from_secs(5));
        let mut cmd = Command::new("powershell.exe");
        cmd.args(["-NoProfile","-NonInteractive","-Command",
            "[void][Console]::In.ReadToEnd(); [Console]::Out.WriteLine('{\"type\":\"turn.started\"}'); [Console]::Out.WriteLine('{\"type\":\"item.completed\",\"item\":{\"text\":\"PRIVATE_TEXT\"}}'); [Console]::Out.Flush(); Start-Sleep -Seconds 30"])
            .stdin(Stdio::piped()).stderr(Stdio::piped());
        hidden_command(&mut cmd);
        let error =
            execute_control(cmd, "synthetic", Duration::from_secs(2), &control).unwrap_err();
        assert_eq!(error, GENERATION_TIMEOUT);
        let saved = control.execution_receipts();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].phase, "receivingItems");
        assert_eq!(saved[0].outcome, "callTimeout");
        assert!(!serde_json::to_string(&saved)
            .unwrap()
            .contains("PRIVATE_TEXT"));
    }
    #[test]
    #[cfg(windows)]
    fn cancellation_stops_the_owned_generation_process() {
        let control = Control::bounded(Duration::from_secs(5));
        let stop = control.clone();
        let canceller = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            stop.cancel();
        });
        let mut cmd = Command::new("powershell.exe");
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 30",
        ])
        .stdin(Stdio::piped())
        .stderr(Stdio::piped())
        .stdout(Stdio::null());
        hidden_command(&mut cmd);
        let start = Instant::now();
        assert!(execute_control(cmd, "", Duration::from_secs(30), &control)
            .unwrap_err()
            .contains("中断"));
        assert!(start.elapsed() < Duration::from_secs(3));
        canceller.join().unwrap();
    }
    #[test]
    #[ignore = "Explicit opt-in only: reads the installed CLI model catalog; creates no threads or turns"]
    fn installed_cli_catalog_read_only_probe() {
        let catalog = models().expect("Read-only installed CLI catalog probe failed");
        let visible = catalog["models"]
            .as_array()
            .expect("Normalized catalog array");
        assert!(
            !visible.is_empty(),
            "Installed CLI returned no selectable models"
        );
        let projected: Vec<_> = visible
            .iter()
            .map(|model| {
                json!({
                    "id":model["id"], "reasoningLevels":model["reasoningLevels"],
                    "fast":model["fastDescription"].is_string()
                })
            })
            .collect();
        println!(
            "{}",
            json!({"cliVersion":catalog["cliVersion"],"models":projected})
        );
        assert!(visible
            .iter()
            .all(|model| model["id"].as_str().is_some_and(valid_model_id)));
    }
    #[cfg(windows)]
    #[test]
    fn blocked_stdin_is_bounded_by_same_process_deadline() {
        use std::os::windows::process::CommandExt;
        let mut cmd = Command::new("powershell.exe");
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 30",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .creation_flags(0x08000000);
        let start = Instant::now();
        let error = execute(cmd, &"x".repeat(4_000_000), Duration::from_millis(250)).unwrap_err();
        assert!(error.contains("超时"));
        assert!(start.elapsed() < Duration::from_secs(4));
    }
    #[cfg(windows)]
    #[test]
    fn process_receives_complete_input_and_quota_stderr_is_sanitized() {
        use std::os::windows::process::CommandExt;
        let mut cmd = Command::new("powershell.exe");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", "[void][Console]::In.ReadToEnd(); [Console]::Error.Write('429 usage limit private-token'); exit 1"])
            .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped()).creation_flags(0x08000000);
        let error = execute(cmd, "local synthetic request", Duration::from_secs(5)).unwrap_err();
        assert!(error.contains("额度"));
        assert!(!error.contains("private-token"));
    }
    #[test]
    fn catalog_filters_hidden_invalid_and_duplicate_models() {
        let parsed = parse_models(&json!([{"model":"gpt-test","displayName":"Test","hidden":false},{"model":"gpt-test","hidden":false},{"model":"hidden","hidden":true},{"model":"--bad argument","hidden":false},{"model":"missing-hidden"}])).unwrap();
        assert_eq!(
            parsed["models"],
            json!([{"id":"gpt-test","name":"Test","reasoningLevels":[],"defaultReasoning":null}])
        );
        assert!(parse_models(&json!({})).is_err());
    }
    #[test]
    fn newest_verified_cli_wins_without_trusting_directory_names() {
        let desktop = PathBuf::from("desktop/hash/codex.exe");
        let npm = PathBuf::from("npm/codex.exe");
        let invalid = PathBuf::from("path/codex.exe");
        let selected = choose_executable(vec![invalid, npm.clone(), desktop.clone()], |path| {
            if path == npm {
                Some((0, 153, 4))
            } else if path == desktop {
                Some((0, 160, 1))
            } else {
                None
            }
        })
        .unwrap();
        assert_eq!(selected.path, desktop);
        assert_eq!(selected.version, (0, 160, 1));
        let tie = choose_executable(vec![PathBuf::from("desktop"), PathBuf::from("npm")], |_| {
            Some((1, 0, 0))
        })
        .unwrap();
        assert_eq!(tie.path, PathBuf::from("desktop"));
        assert!(choose_executable(vec![npm], |_| None).is_err());
        assert_eq!(parse_version("codex-cli 0.160.1\n"), Some((0, 160, 1)));
        assert_eq!(parse_version("codex-cli 0.160.1-beta.2"), Some((0, 160, 1)));
        assert!(parse_version("another-program 9.9.9").is_none());
        assert!(parse_version("codex-cli invalid").is_none());
    }
    #[test]
    fn selectable_rpc_models_are_not_removed_by_raw_catalog_visibility() {
        let ids = [
            "gpt-6.1-sol",
            "gpt-6-astra",
            "gpt-6-sol",
            "gpt-6-luna",
            "gpt-5.6-sol",
            "gpt-5.6-terra",
            "gpt-5.6-luna",
            "gpt-5.5",
        ];
        let selectable = json!(ids.iter().map(|id| json!({"model":id,"hidden":false,"supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"high"}]})).collect::<Vec<_>>());
        let mut parsed = parse_models(&selectable).unwrap();
        enrich_fast_capabilities(
            &mut parsed,
            &selectable,
            &json!({"models":[
                {"slug":"gpt-5.5","visibility":"hide","service_tiers":[{"id":"priority","description":"Fast metadata"}]},
                {"slug":"internal-model","visibility":"hide","service_tiers":[{"id":"priority","description":"internal"}]}
            ]}),
        );
        assert_eq!(parsed["models"].as_array().unwrap().len(), 8);
        assert_eq!(parsed["models"][7]["id"], "gpt-5.5");
        assert!(validate_selection(&parsed, "gpt-5.5", "high").is_ok());
        assert!(validate_fast(&parsed, "gpt-5.5", true).is_ok());
        assert!(validate_selection(&parsed, "internal-model", "").is_err());
        let explicit_none = json!([{"model":"gpt-5.5","hidden":false,"serviceTiers":[]}]);
        let mut parsed = parse_models(&explicit_none).unwrap();
        enrich_fast_capabilities(
            &mut parsed,
            &explicit_none,
            &json!({"models":[{"slug":"gpt-5.5","service_tiers":[{"id":"priority","description":"outdated"}]}]}),
        );
        assert!(validate_fast(&parsed, "gpt-5.5", true).is_err());
    }
    #[test]
    fn valid_rpc_catalog_survives_optional_fast_metadata_failure() {
        let selectable = json!([{"model":"gpt-test","hidden":false,
            "supportedReasoningEfforts":[{"reasoningEffort":"high"}]}]);
        let mut parsed = parse_models(&selectable).unwrap();
        optional_fast_enrichment(&mut parsed, &selectable, || {
            Err("metadata unsupported".into())
        });
        assert!(validate_selection(&parsed, "gpt-test", "high").is_ok());
        assert!(validate_fast(&parsed, "gpt-test", true).is_err());
        optional_fast_enrichment(&mut parsed, &selectable, || {
            Ok(json!({"invalid":"metadata"}))
        });
        assert_eq!(parsed["models"].as_array().unwrap().len(), 1);
        assert!(validate_fast(&parsed, "gpt-test", true).is_err());
    }
    #[cfg(windows)]
    fn fake_catalog(pages: &[Value]) -> Command {
        let mut script = String::from("$request = [Console]::In.ReadLine() | ConvertFrom-Json; if ($request.method -ne 'initialize') { exit 3 }; [Console]::Out.WriteLine('{\"id\":1,\"result\":{}}'); $ready = [Console]::In.ReadLine() | ConvertFrom-Json; if ($ready.method -ne 'initialized') { exit 4 }; ");
        for (index, page) in pages.iter().enumerate() {
            script.push_str("$request = [Console]::In.ReadLine() | ConvertFrom-Json; if ($request.method -ne 'model/list' -or $request.params.includeHidden -ne $false) { exit 5 }; ");
            if index > 0 {
                let expected = pages[index - 1]["nextCursor"]
                    .as_str()
                    .unwrap_or_default()
                    .replace('\'', "''");
                script.push_str(&format!(
                    "if ($request.params.cursor -ne '{expected}') {{ exit 6 }}; "
                ));
            }
            script.push_str(&format!(
                "[Console]::Out.WriteLine('{}'); ",
                json!({"id":index+2,"result":page})
                    .to_string()
                    .replace('\'', "''")
            ));
        }
        script.push_str("Start-Sleep -Seconds 30");
        let mut command = Command::new("powershell.exe");
        command.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
        command
    }
    #[cfg(windows)]
    #[test]
    fn catalog_rpc_paginates_and_stops_its_process_after_success() {
        let command = fake_catalog(&[
            json!({"data":[{"model":"gpt-one","hidden":false}],"nextCursor":"page-two"}),
            json!({"data":[{"model":"gpt-two","hidden":false}],"nextCursor":null}),
        ]);
        let started = Instant::now();
        let data = read_catalog(command, started + Duration::from_secs(5)).unwrap();
        assert_eq!(
            parse_models(&data).unwrap()["models"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert!(started.elapsed() < Duration::from_secs(4));
        let cycle = fake_catalog(&[
            json!({"data":[],"nextCursor":"repeat"}),
            json!({"data":[],"nextCursor":"repeat"}),
        ]);
        assert!(read_catalog(cycle, Instant::now() + Duration::from_secs(5))
            .unwrap_err()
            .contains("分页无效"));
    }
    #[cfg(windows)]
    #[test]
    fn catalog_rpc_deadline_protocol_errors_and_cleanup_are_bounded() {
        let mut silent = Command::new("powershell.exe");
        silent.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 30",
        ]);
        let started = Instant::now();
        assert!(read_catalog(silent, started + Duration::from_millis(250))
            .unwrap_err()
            .contains("超时"));
        assert!(started.elapsed() < Duration::from_secs(4));
        let mut error = Command::new("powershell.exe");
        error.args(["-NoProfile", "-NonInteractive", "-Command", "[void][Console]::In.ReadLine(); [Console]::Out.WriteLine('{\"id\":1,\"error\":{\"code\":-1,\"message\":\"private-token\"}}'); Start-Sleep -Seconds 30"]);
        let message = read_catalog(error, Instant::now() + Duration::from_secs(5)).unwrap_err();
        assert!(message.contains("请求失败"));
        assert!(!message.contains("private-token"));
        let mut oversized = Command::new("powershell.exe");
        oversized.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[Console]::Out.WriteLine('x' * 512001); Start-Sleep -Seconds 30",
        ]);
        assert!(
            read_catalog(oversized, Instant::now() + Duration::from_secs(5))
                .unwrap_err()
                .contains("过大")
        );
        let mut child_command = Command::new("powershell.exe");
        child_command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 30",
        ]);
        let process =
            CatalogProcess::start(child_command, Instant::now() + Duration::from_secs(5)).unwrap();
        let id = process.child.id();
        drop(process);
        let mut alive = Command::new("powershell.exe");
        alive.args(["-NoProfile", "-NonInteractive", "-Command", &format!("if (Get-Process -Id {id} -ErrorAction SilentlyContinue) {{ [Console]::Out.Write('alive') }}")]);
        assert!(
            bounded_output(alive, Instant::now() + Duration::from_secs(5), 512)
                .unwrap()
                .is_empty()
        );
    }
    #[test]
    fn model_selection_does_not_override_speed_or_reasoning() {
        let mut cmd = Command::new("codex");
        configure_model(&mut cmd, "gpt-test", "", false);
        assert_eq!(
            cmd.get_args().collect::<Vec<_>>(),
            vec!["--model", "gpt-test"]
        );
        let mut default = Command::new("codex");
        configure_model(&mut default, "", "", false);
        assert_eq!(default.get_args().count(), 0);
        let mut explicit = Command::new("codex");
        configure_model(&mut explicit, "gpt-test", "high", false);
        assert_eq!(
            explicit.get_args().collect::<Vec<_>>(),
            vec!["--model", "gpt-test", "-c", "model_reasoning_effort=high"]
        );
    }
    #[test]
    fn reasoning_selection_is_validated_per_model() {
        let catalog = parse_models(&json!([{"model":"gpt-test","hidden":false,"supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"high"}],"defaultReasoningEffort":"low"}])).unwrap();
        assert!(validate_selection(&catalog, "gpt-test", "high").is_ok());
        assert!(validate_selection(&catalog, "gpt-test", "ultra").is_err());
        assert!(validate_selection(&catalog, "", "high").is_err());
        assert!(validate_selection(&catalog, "gpt-test", "").is_ok());
        assert_eq!(
            catalog["models"][0]["reasoningLevels"],
            json!(["low", "high"])
        );
    }
    #[test]
    fn fast_selection_reaches_cli_and_requires_model_support() {
        let mut cmd = Command::new("codex");
        configure_model(&mut cmd, "gpt-test", "medium", true);
        let args: Vec<_> = cmd.get_args().collect();
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-c", "service_tier=fast"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--enable", "fast_mode"]));
        let catalog = parse_models(&json!([{"model":"gpt-test","hidden":false,"serviceTiers":[{"id":"priority","description":"2x speed, increased usage"}]}])).unwrap();
        assert!(validate_fast(&catalog, "gpt-test", true).is_ok());
        assert!(validate_fast(&catalog, "other", true).is_err());
        assert!(validate_fast(&catalog, "", true).is_err());
        assert!(validate_fast(&catalog, "", false).is_ok());
    }
}
