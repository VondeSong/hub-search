//! Hub model settings, budgets and the single bounded FIFO admission owner.
//! Records contain host labels and safe errors, never prompts or source content.
#[cfg(test)]
mod acceptance;
mod cli;
pub(crate) use cli::agent::compute::run as controlled_compute;
pub(crate) use cli::agent::interaction as agent_interaction;
pub(crate) use cli::agent::services as mcp_services;
pub(crate) use cli::agent::web as agent_web;
pub(crate) use cli::agent::Request as AgentRequest;
pub(crate) fn agent_authentication(
    root: &Path,
    selected: Option<&str>,
) -> Result<(String, String), String> {
    cli::agent::authentication_for(root, selected)
}
pub(crate) fn codex_account(root: &Path) -> Result<Value, String> {
    Ok(cli::accounts::current(root)?.public)
}
pub fn run_agent_mcp_stdio() -> Result<(), String> {
    cli::agent::mcp::stdio()
}
pub(crate) fn agent_mcp_startup_bytes(tools: &Value, instructions: &str) -> Result<usize, String> {
    cli::agent::mcp::startup_bytes(tools, instructions)
}
pub(crate) fn validate_agent_tool(value: &Value, contract: &Value) -> Result<(), String> {
    schema::validate(value, contract)
}

/// External capability inputs obey the tool's domain limits. Model output
/// budgets belong to the provider adapter and must not narrow an MCP contract.
pub(crate) fn validate_capability_arguments(value: &Value, contract: &Value) -> Result<(), String> {
    schema::validate_arguments(value, contract)
}
mod credentials;
mod deepseek;
mod execution;
mod schema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
pub(crate) const MAX_OUTPUT_BYTES: usize = 40_000;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub(crate) struct Settings {
    pub provider: String,
    pub model: String,
    pub reasoning_effort: String,
    pub fast: bool,
    pub max_concurrent: usize,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            provider: "codex".into(),
            model: String::new(),
            reasoning_effort: String::new(),
            fast: false,
            max_concurrent: 2,
        }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SavedSettings {
    schema_version: u32,
    settings: Settings,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    at: u64,
    message: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Job {
    id: String,
    workflow: String,
    label: String,
    state: &'static str,
    provider: String,
    model: String,
    reasoning_effort: String,
    fast: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    finished_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    context: Option<String>,
    progress: Vec<Progress>,
    executions: Vec<execution::Receipt>,
    usage: Usage,
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Usage {
    calls: u64,
    calls_with_tokens: u64,
    input_tokens: u64,
    output_tokens: u64,
    total_tokens: u64,
}
struct State {
    settings: Settings,
    jobs: VecDeque<Job>,
    waiting: VecDeque<String>,
    active: usize,
    next_id: u64,
    revision: u64,
    background: Option<(String, Control)>,
    controls: HashMap<String, Control>,
}
struct Runtime {
    root: Option<PathBuf>,
    state: Mutex<State>,
    changed: Condvar,
}
fn time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
/// One host-owned budget spans admission, discovery and every model call.
#[derive(Clone)]
pub(crate) struct Control {
    deadline: Option<Instant>,
    cancelled: Arc<AtomicBool>,
    started: Instant,
    guard: Option<Arc<dyn Fn() -> Result<(), String> + Send + Sync>>,
    generation_ceiling: Option<Duration>,
    executions: Arc<Mutex<Vec<execution::Receipt>>>,
    usage: Arc<Mutex<Usage>>,
}
impl Default for Control {
    fn default() -> Self {
        Self {
            deadline: None,
            cancelled: Arc::new(AtomicBool::new(false)),
            started: Instant::now(),
            guard: None,
            generation_ceiling: None,
            executions: Default::default(),
            usage: Default::default(),
        }
    }
}
impl Control {
    pub(crate) fn execution_receipts(&self) -> Vec<execution::Receipt> {
        self.executions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    fn record_execution(&self, receipt: execution::Receipt) {
        let mut usage = self.usage.lock().unwrap_or_else(|e| e.into_inner());
        usage.calls += 1;
        usage.input_tokens = usage
            .input_tokens
            .saturating_add(receipt.input_tokens.unwrap_or(0));
        usage.output_tokens = usage
            .output_tokens
            .saturating_add(receipt.output_tokens.unwrap_or(0));
        usage.total_tokens = usage
            .total_tokens
            .saturating_add(receipt.total_tokens.unwrap_or(0));
        if receipt.total_tokens.is_some() {
            usage.calls_with_tokens += 1;
        }
        drop(usage);
        let mut receipts = self.executions.lock().unwrap_or_else(|e| e.into_inner());
        if receipts.len() < 12 {
            receipts.push(receipt);
        }
    }
    pub(crate) fn with_generation_ceiling(mut self, ceiling: Duration) -> Self {
        self.generation_ceiling = Some(ceiling.max(Duration::from_secs(1)));
        self
    }
    fn generation_limit(&self) -> Duration {
        let legacy = Duration::from_secs(if self.deadline.is_some() { 90 } else { 240 });
        self.generation_ceiling
            .map_or(legacy, |limit| limit.min(legacy))
    }
    fn native_turn_control(&self) -> Self {
        let deadline = Instant::now()
            + self
                .generation_ceiling
                .unwrap_or_else(|| self.generation_limit());
        let inherited = self.guard.clone();
        let mut child = self.clone();
        child.guard = Some(Arc::new(move || {
            if Instant::now() >= deadline {
                return Err(cli::GENERATION_TIMEOUT.into());
            }
            if let Some(guard) = &inherited {
                guard()?;
            }
            Ok(())
        }));
        child
    }
    pub(crate) fn guarded(
        mut self,
        guard: impl Fn() -> Result<(), String> + Send + Sync + 'static,
    ) -> Self {
        self.guard = Some(Arc::new(guard));
        self
    }
    pub(crate) fn bounded(duration: Duration) -> Self {
        Self {
            deadline: Some(Instant::now() + duration),
            ..Self::default()
        }
    }
    pub(crate) fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }
    pub(crate) fn elapsed(&self) -> Duration {
        self.started.elapsed()
    }
    pub(crate) fn remaining(&self) -> Option<Duration> {
        self.deadline
            .map(|d| d.saturating_duration_since(Instant::now()))
    }
    pub(crate) fn check(&self) -> Result<(), String> {
        if self.cancelled.load(Ordering::SeqCst) {
            return Err("调查已中断，可以稍后继续。".into());
        }
        if self.deadline.is_some_and(|d| Instant::now() >= d) {
            return Err("调查总时限已用尽，可以稍后继续。".into());
        }
        if let Some(guard) = &self.guard {
            guard()?;
        }
        Ok(())
    }
    pub(super) fn deadline(&self, fallback: Instant) -> Instant {
        self.deadline.map_or(fallback, |d| d.min(fallback))
    }
}
/// This fixed adapter error is host-owned. Model content and arbitrary CLI
/// stderr must never grant a retry or change a source/action permission.
pub(crate) fn is_retryable_model_error(error: &str) -> bool {
    error == cli::GENERATION_TIMEOUT || error == deepseek::GENERATION_TIMEOUT
}
#[derive(Default)]
struct CatalogCache(Mutex<Option<(Instant, Value)>>);
impl CatalogCache {
    #[cfg(test)]
    fn load(
        &self,
        force: bool,
        loader: impl FnOnce() -> Result<Value, String>,
    ) -> Result<Value, String> {
        self.load_control(force, &Control::default(), loader)
    }
    fn load_control(
        &self,
        force: bool,
        control: &Control,
        loader: impl FnOnce() -> Result<Value, String>,
    ) -> Result<Value, String> {
        let requested = Instant::now();
        // This dedicated catalog lock makes refresh single-flight; job/settings
        // state locks stay free for status polling and admission changes.
        let mut cache = loop {
            control.check()?;
            match self.0.try_lock() {
                Ok(guard) => break guard,
                Err(std::sync::TryLockError::Poisoned(e)) => break e.into_inner(),
                Err(std::sync::TryLockError::WouldBlock) => {
                    std::thread::sleep(Duration::from_millis(20))
                }
            }
        };
        if let Some((saved, value)) = cache.as_ref() {
            if saved.elapsed() < Duration::from_secs(120) && (!force || *saved >= requested) {
                return Ok(value.clone());
            }
        }
        match loader() {
            Ok(value) => {
                *cache = Some((Instant::now(), value.clone()));
                Ok(value)
            }
            Err(error) => {
                *cache = None;
                Err(error)
            }
        }
    }
}
fn catalog(force: bool) -> Result<Value, String> {
    catalog_control(force, &Control::default())
}
fn catalog_control(force: bool, control: &Control) -> Result<Value, String> {
    static CACHE: OnceLock<CatalogCache> = OnceLock::new();
    CACHE
        .get_or_init(Default::default)
        .load_control(force, control, || cli::models_control(control))
}
fn provider_catalog(provider: &str, force: bool, control: &Control) -> Result<Value, String> {
    match provider {
        "codex" => catalog_control(force, control),
        "deepseek" => deepseek::models(force, control),
        _ => Err("模型提供方不受支持。".into()),
    }
}
pub(crate) fn models_for(root: &Path) -> Result<Value, String> {
    let runtime = runtime(root)?;
    let provider = runtime
        .state
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .settings
        .provider
        .clone();
    provider_catalog(&provider, true, &Control::bounded(Duration::from_secs(30)))
}
pub(crate) fn models() -> Result<Value, String> {
    catalog(true)
}
pub(crate) fn check_settings(settings: &Settings) -> Result<(), String> {
    basic_validate(settings)?;
    let control = Control::bounded(Duration::from_secs(30));
    let catalog = provider_catalog(&settings.provider, false, &control)?;
    validate_selection(&catalog, &settings.model, &settings.reasoning_effort)?;
    validate_fast(&catalog, &settings.model, settings.fast)
}
pub(crate) fn validate_selection(catalog: &Value, model: &str, effort: &str) -> Result<(), String> {
    if model.is_empty() {
        return if effort.is_empty() {
            Ok(())
        } else {
            Err("请先选择模型，再指定推理强度。".into())
        };
    }
    let selected = catalog["models"]
        .as_array()
        .and_then(|models| models.iter().find(|m| m["id"] == model))
        .filter(|_| {
            !model.is_empty()
                && model.len() <= 120
                && model
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-._".contains(&b))
        })
        .ok_or("所选模型不在当前提供方模型列表中，请刷新后重新选择。")?;
    if !effort.is_empty()
        && (!matches!(
            effort,
            "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
        ) || !selected["reasoningLevels"]
            .as_array()
            .is_some_and(|levels| levels.iter().any(|v| v == effort)))
    {
        return Err("所选模型不支持此推理强度，请刷新后重新选择。".into());
    }
    Ok(())
}

pub(crate) fn validate_fast(catalog: &Value, model: &str, fast: bool) -> Result<(), String> {
    cli::validate_fast(catalog, model, fast)
}
pub(crate) fn generator(selection: &Value, workflow: &str) -> Value {
    let mut value = json!({"agent":"hub","provider":selection["provider"].as_str().unwrap_or("codex"),"workflow":workflow});
    if let Some(model) = selection["model"].as_str().filter(|v| !v.is_empty()) {
        value["model"] = json!(model);
    }
    value
}
#[cfg(test)]
pub(crate) fn test_run_structured(
    prompt: &str,
    schema: &Value,
    model: &str,
    effort: &str,
    fast: bool,
) -> Result<Value, String> {
    cli::run(prompt, schema, model, effort, fast, &[])
}
fn basic_validate(settings: &Settings) -> Result<(), String> {
    if !matches!(settings.provider.as_str(), "codex" | "deepseek") {
        return Err("模型提供方不受支持。".into());
    }
    if settings.provider == "deepseek" && (settings.model.is_empty() || settings.fast) {
        return Err("DeepSeek 需要选择模型，且不支持 Codex Fast 参数。".into());
    }
    if !(1..=4).contains(&settings.max_concurrent) {
        return Err("Hub 模型并发数量只能设置为 1–4。".into());
    }
    if settings.model.len() > 120 || settings.reasoning_effort.len() > 20 {
        return Err("模型设置格式无效。".into());
    }
    Ok(())
}
fn read_settings(root: &Path) -> Result<Settings, String> {
    let current = root.join("model-runtime-v1.json");
    let file = if current.exists() {
        current
    } else {
        root.join("codex-suite-v1.json")
    };
    if !file.exists() {
        return Ok(Settings::default());
    }
    let bytes = std::fs::read(&file).map_err(|_| "无法读取 模型运行设置。")?;
    if bytes.len() > 4096 {
        return Err("模型运行设置文件过大。".into());
    }
    let saved: SavedSettings =
        serde_json::from_slice(&bytes).map_err(|_| "模型运行设置格式无效。")?;
    if !matches!(saved.schema_version, 1 | 2) {
        return Err("模型运行设置版本不受支持。".into());
    }
    basic_validate(&saved.settings)?;
    Ok(saved.settings)
}
fn new_runtime(settings: Settings) -> Arc<Runtime> {
    Arc::new(Runtime {
        root: None,
        state: Mutex::new(State {
            settings,
            jobs: VecDeque::new(),
            waiting: VecDeque::new(),
            active: 0,
            next_id: 0,
            revision: 1,
            background: None,
            controls: HashMap::new(),
        }),
        changed: Condvar::new(),
    })
}
fn runtime(root: &Path) -> Result<Arc<Runtime>, String> {
    static RUNTIMES: OnceLock<Mutex<HashMap<PathBuf, Arc<Runtime>>>> = OnceLock::new();
    let mut all = RUNTIMES
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(found) = all.get(root) {
        return Ok(found.clone());
    }
    let mut value = new_runtime(read_settings(root)?);
    if let Some(runtime) = Arc::get_mut(&mut value) {
        runtime.root = Some(root.to_path_buf());
    }
    all.insert(root.to_path_buf(), value.clone());
    Ok(value)
}
pub(crate) fn selected_settings(
    root: &Path,
    selection: Option<Settings>,
) -> Result<Settings, String> {
    if let Some(settings) = selection {
        return Ok(settings);
    }
    let runtime = runtime(root)?;
    let state = runtime.state.lock().unwrap_or_else(|e| e.into_inner());
    Ok(state.settings.clone())
}
pub(crate) fn native_agent_provider(provider: &str) -> bool {
    provider == "codex"
}
fn snapshot(runtime: &Runtime) -> Value {
    let state = runtime.state.lock().unwrap_or_else(|e| e.into_inner());
    json!({"settings":state.settings,"jobs":state.jobs,"revision":state.revision})
}
fn save_with_catalog(
    root: &Path,
    runtime: &Runtime,
    settings: Settings,
    catalog: &Value,
) -> Result<Value, String> {
    basic_validate(&settings)?;
    validate_selection(catalog, &settings.model, &settings.reasoning_effort)?;
    validate_fast(catalog, &settings.model, settings.fast)?;
    let mut state = runtime.state.lock().unwrap_or_else(|e| e.into_inner());
    std::fs::create_dir_all(root).map_err(|_| "无法保存模型运行设置。")?;
    let temporary = root.join(format!(".model-runtime-{}.tmp", crate::random_url_safe(12)));
    let saved = SavedSettings {
        schema_version: 2,
        settings: settings.clone(),
    };
    let bytes = serde_json::to_vec_pretty(&saved).map_err(|_| "无法保存模型运行设置。")?;
    let result = (|| {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        std::fs::rename(&temporary, root.join("model-runtime-v1.json"))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
        return Err("无法保存模型运行设置，原设置已保留。".into());
    }
    state.settings = settings;
    state.revision += 1;
    drop(state);
    runtime.changed.notify_all();
    Ok(snapshot(runtime))
}
pub(crate) fn ui(root: &Path, args: &Value) -> Result<Value, String> {
    if args.to_string().len() > 32_768 {
        return Err("模型设置请求过大。".into());
    }
    match args["action"].as_str().unwrap_or("get") {
        "codexAccounts" | "startCodexLogin" | "cancelCodexLogin" | "selectCodexAccount"
        | "removeCodexAccount" => cli::accounts::ui(root, args),
        "models" => {
            let provider = if let Some(provider) = args["provider"].as_str() {
                provider.to_string()
            } else {
                runtime(root)?
                    .state
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .settings
                    .provider
                    .clone()
            };
            provider_catalog(&provider, true, &Control::bounded(Duration::from_secs(30)))
        }
        "credentialStatus" => Ok(json!({"deepseekConfigured":credentials::get()?.is_some()})),
        "cancel" => {
            let runtime = runtime(root)?;
            let id = args["id"].as_str().ok_or("请选择要停止的模型请求。")?;
            let state = runtime.state.lock().unwrap_or_else(|e| e.into_inner());
            let control = state.controls.get(id).ok_or("该模型请求已经结束。")?;
            control.cancel();
            drop(state);
            runtime.changed.notify_all();
            Ok(snapshot(&runtime))
        }
        "setCredential" => {
            credentials::save(args["apiKey"].as_str().ok_or("请输入 DeepSeek API 密钥")?)?;
            deepseek::invalidate_catalog();
            Ok(json!({"deepseekConfigured":true}))
        }
        "importCredential" => {
            credentials::import(Path::new(args["path"].as_str().ok_or("请选择密钥文件")?))?;
            deepseek::invalidate_catalog();
            Ok(json!({"deepseekConfigured":true}))
        }
        "get" | "status" => {
            let runtime = runtime(root)?;
            Ok(snapshot(runtime.as_ref()))
        }
        "save" => {
            let settings: Settings = serde_json::from_value(args["settings"].clone())
                .map_err(|_| "模型运行设置格式无效。")?;
            basic_validate(&settings)?;
            let catalog = if settings.model.is_empty() {
                json!({})
            } else {
                provider_catalog(
                    &settings.provider,
                    false,
                    &Control::bounded(Duration::from_secs(30)),
                )?
            };
            let runtime = runtime(root)?;
            save_with_catalog(root, runtime.as_ref(), settings, &catalog)
        }
        _ => Err("未知模型运行操作。".into()),
    }
}
fn prune(state: &mut State) {
    while state
        .jobs
        .iter()
        .filter(|j| matches!(j.state, "succeeded" | "failed" | "cancelled"))
        .count()
        > 30
    {
        if let Some(index) = state
            .jobs
            .iter()
            .position(|j| matches!(j.state, "succeeded" | "failed" | "cancelled"))
        {
            state.jobs.remove(index);
        }
    }
}
pub(crate) fn is_output_contract_error(error: &str) -> bool {
    schema::is_rejection(error) || deepseek::is_output_rejection(error)
}
fn safe_error(provider: &str, error: &str) -> String {
    if let Some(message) = deepseek::safe_error(error) {
        return message.into();
    }
    if error.starts_with("模型返回") {
        return "模型输出未通过格式核验，未提交结果。".into();
    }
    if error.starts_with("引用") || error.starts_with("事实发现") {
        return "调查结果未通过引文核验，未提交结果。".into();
    }
    if provider == "deepseek" {
        return "DeepSeek 处理失败，请查看对应功能的处理记录。".into();
    }
    if error.contains("登录") || error.contains("authentication") {
        "Codex 登录已失效，请重新登录。"
    } else if error.contains("额度") || error.contains("429") {
        "Codex 使用额度暂不可用。"
    } else if error.contains("超时") {
        "Codex 处理超时，请重试。"
    } else if error.contains("模型") || error.contains("推理强度") || error.contains("Fast") {
        "当前 Codex 模型设置不可用，请检查套件设置。"
    } else {
        "Codex 处理失败，请查看对应功能的处理记录。"
    }
    .into()
}
#[derive(Clone)]
struct ModelError {
    message: String,
    recoverable: bool,
    later_response_received: bool,
}
pub(crate) struct Operation {
    codex_account: Option<String>,
    runtime: Arc<Runtime>,
    id: String,
    settings: Settings,
    done: AtomicBool,
    model_error: Mutex<Option<ModelError>>,
    control: Control,
    call_gate: Mutex<()>,
}
impl Operation {
    pub(crate) fn codex_account_selection(&self) -> Option<&str> {
        self.codex_account.as_deref()
    }
    pub(crate) fn record_agent_completion(&self, usage: &Value) -> Value {
        let mut receipt = execution::Trace::new().finish("completedOutput", None);
        receipt.phase = "agentTurn";
        receipt.elapsed_ms = self.control.elapsed().as_millis() as u64;
        receipt.model = (!self.settings.model.is_empty()).then(|| self.settings.model.clone());
        receipt.input_tokens = usage["inputTokens"].as_u64();
        receipt.output_tokens = usage["outputTokens"].as_u64();
        receipt.total_tokens = usage["totalTokens"].as_u64();
        self.control.record_execution(receipt.clone());
        json!(receipt)
    }
    pub(crate) fn native_agent(&self) -> bool {
        native_agent_provider(&self.settings.provider)
    }

    pub(crate) fn run_agent(
        &self,
        request: AgentRequest<'_>,
        host: impl FnMut(&str, &Value) -> Result<Value, String>,
    ) -> Result<Value, String> {
        if !self.native_agent() || self.done.load(Ordering::SeqCst) {
            return Err("持续 Agent 会话当前不可用".into());
        }
        // Admission belongs to this Operation for the entire native turn.
        // Tool owners may use the same Operation for a distinct domain call;
        // never hold call_gate across a callback into those owners.
        self.ask_with(|| {
            let control = self.control.native_turn_control();
            cli::agent::run(
                request,
                &self.settings.model,
                &self.settings.reasoning_effort,
                self.settings.fast,
                &control,
                host,
            )
        })
    }
    pub fn start(root: &Path, workflow: &str, label: &str) -> Result<Self, String> {
        Self::start_control(root, workflow, label, Control::default())
    }
    pub(crate) fn start_control(
        root: &Path,
        workflow: &str,
        label: &str,
        control: Control,
    ) -> Result<Self, String> {
        control.check()?;
        let operation = Self::start_on_control(runtime(root)?, workflow, label, control)?;
        operation.validate()
    }
    /// A conversation may choose a model while the shared runtime continues to
    /// own queue admission, cancellation and concurrency. Never save this choice
    /// into global settings or accept a caller supplied concurrency limit.
    pub(crate) fn start_selected(
        root: &Path,
        workflow: &str,
        label: &str,
        control: Control,
        selection: Option<Settings>,
    ) -> Result<Self, String> {
        Self::start_on_selected(runtime(root)?, workflow, label, control, false, selection)?
            .ok_or("模型请求准入失败".to_string())?
            .validate()
    }
    /// Background work never queues. A manual arrival cancels its shared
    /// control, then follows the existing FIFO and concurrency limit.
    pub(crate) fn try_start_background(
        root: &Path,
        control: Control,
    ) -> Result<Option<Self>, String> {
        Self::start_on_mode(
            runtime(root)?,
            "agent-condition",
            "按约定复查事项",
            control,
            true,
        )?
        .map(Self::validate)
        .transpose()
    }
    pub(crate) fn try_start_background_selected(
        root: &Path,
        control: Control,
        selection: Option<Settings>,
    ) -> Result<Option<Self>, String> {
        Self::start_on_selected(
            runtime(root)?,
            "agent-condition",
            "按约定复查事项",
            control,
            true,
            selection,
        )?
        .map(Self::validate)
        .transpose()
    }
    fn validate(self) -> Result<Self, String> {
        let operation = self;
        let validation = (|| {
            basic_validate(&operation.settings)?;
            let catalog = if operation.settings.model.is_empty() {
                json!({})
            } else {
                provider_catalog(&operation.settings.provider, false, &operation.control)?
            };
            validate_selection(
                &catalog,
                &operation.settings.model,
                &operation.settings.reasoning_effort,
            )?;
            validate_fast(&catalog, &operation.settings.model, operation.settings.fast)?;
            operation.control.check()
        })();
        if let Err(error) = validation {
            operation.finish::<()>(&Err(error.clone()));
            return Err(error);
        }
        Ok(operation)
    }
    #[cfg(test)]
    fn start_on(runtime: Arc<Runtime>, workflow: &str, label: &str) -> Result<Self, String> {
        Self::start_on_control(runtime, workflow, label, Control::default())
    }
    fn start_on_control(
        runtime: Arc<Runtime>,
        workflow: &str,
        label: &str,
        control: Control,
    ) -> Result<Self, String> {
        Self::start_on_mode(runtime, workflow, label, control, false)?
            .ok_or("模型请求准入失败".into())
    }
    fn start_on_mode(
        runtime: Arc<Runtime>,
        workflow: &str,
        label: &str,
        control: Control,
        background: bool,
    ) -> Result<Option<Self>, String> {
        Self::start_on_selected(runtime, workflow, label, control, background, None)
    }
    fn start_on_selected(
        runtime: Arc<Runtime>,
        workflow: &str,
        label: &str,
        control: Control,
        background: bool,
        selection: Option<Settings>,
    ) -> Result<Option<Self>, String> {
        control.check()?;
        let mut state = runtime.state.lock().unwrap_or_else(|e| e.into_inner());
        if background && (state.active != 0 || !state.waiting.is_empty()) {
            return Ok(None);
        }
        if !background {
            if let Some((_, active)) = &state.background {
                active.cancel();
            }
        }
        if state.waiting.len() >= 64 {
            return Err("模型请求等待队列已满，请稍候。".into());
        }
        state.next_id += 1;
        let id = format!("model-{}-{}", time_ms(), state.next_id);
        let mut settings = selection.unwrap_or_else(|| state.settings.clone());
        settings.max_concurrent = state.settings.max_concurrent;
        let codex_account = if native_agent_provider(&settings.provider) {
            runtime
                .root
                .as_deref()
                .map(cli::accounts::selected)
                .transpose()?
        } else {
            None
        };
        state.jobs.push_back(Job {
            id: id.clone(),
            workflow: workflow.into(),
            label: label.into(),
            state: "queued",
            provider: settings.provider.clone(),
            model: settings.model.clone(),
            reasoning_effort: settings.reasoning_effort.clone(),
            fast: settings.fast,
            started_at: None,
            finished_at: None,
            error: None,
            context: None,
            progress: Vec::new(),
            executions: Vec::new(),
            usage: Usage::default(),
        });
        state.waiting.push_back(id.clone());
        state.controls.insert(id.clone(), control.clone());
        state.revision += 1;
        loop {
            if let Err(error) = control.check() {
                state.waiting.retain(|ticket| ticket != &id);
                state.controls.remove(&id);
                if let Some(job) = state.jobs.iter_mut().find(|j| j.id == id) {
                    job.state = if control.cancelled.load(Ordering::SeqCst) {
                        "cancelled"
                    } else {
                        "failed"
                    };
                    job.error = Some(error.clone());
                    job.finished_at = Some(time_ms());
                }
                state.revision += 1;
                prune(&mut state);
                drop(state);
                runtime.changed.notify_all();
                return Err(error);
            }
            if state.active < state.settings.max_concurrent && state.waiting.front() == Some(&id) {
                break;
            }
            state = runtime
                .changed
                .wait_timeout(state, Duration::from_millis(25))
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
        state.waiting.pop_front();
        state.active += 1;
        if background {
            state.background = Some((id.clone(), control.clone()));
        }
        if let Some(job) = state.jobs.iter_mut().find(|j| j.id == id) {
            job.state = "running";
            job.started_at = Some(time_ms());
        }
        state.revision += 1;
        drop(state);
        runtime.changed.notify_all();
        Ok(Some(Self {
            codex_account,
            runtime,
            id,
            settings,
            done: AtomicBool::new(false),
            model_error: Mutex::new(None),
            control,
            call_gate: Mutex::new(()),
        }))
    }
    /// A caller's old per-feature settings can never override this operation snapshot.
    pub(crate) fn context(&self, value: &str) {
        let mut state = self.runtime.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(job) = state.jobs.iter_mut().find(|job| job.id == self.id) {
            job.context = Some(value.chars().take(200).collect());
            state.revision += 1;
        }
    }
    // Only application-authored checkpoints; never store prompts or model scratchpads.
    pub(crate) fn progress(&self, message: &str) {
        let mut state = self.runtime.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(job) = state
            .jobs
            .iter_mut()
            .find(|job| job.id == self.id && job.state == "running")
        {
            if job.progress.len() >= 96 {
                job.progress.remove(0);
            }
            job.progress.push(Progress {
                at: time_ms(),
                message: message.chars().take(240).collect(),
            });
            state.revision += 1;
        }
    }
    pub fn arguments(&self, args: &Value) -> Value {
        let mut args = args.clone();
        args["model"] = json!(self.settings.model);
        args["provider"] = json!(self.settings.provider);
        args["reasoningEffort"] = json!(self.settings.reasoning_effort);
        args["fast"] = json!(self.settings.fast);
        args
    }
    pub fn ask(&self, prompt: &str, schema: &Value, images: &[PathBuf]) -> Result<Value, String> {
        self.ask_stream(prompt, schema, images, &mut |_| Ok(()))
    }
    pub(crate) fn ask_stream(
        &self,
        prompt: &str,
        schema: &Value,
        images: &[PathBuf],
        publish: &mut dyn FnMut(&Value) -> Result<(), String>,
    ) -> Result<Value, String> {
        self.ask_admitted(prompt, schema, images, None, &mut |_| Ok(()), publish)
    }
    pub(crate) fn ask_direct(
        &self,
        prompt: &str,
        schema: &Value,
        output_limit: u64,
        admit: &mut dyn FnMut(&Value) -> Result<(), String>,
        publish: &mut dyn FnMut(&Value) -> Result<(), String>,
    ) -> Result<Value, String> {
        if self.settings.provider != "deepseek" {
            return Err("直连预算入口不支持当前提供方".into());
        }
        self.ask_admitted(prompt, schema, &[], Some(output_limit), admit, publish)
    }
    fn ask_admitted(
        &self,
        prompt: &str,
        schema: &Value,
        images: &[PathBuf],
        output_limit: Option<u64>,
        admit: &mut dyn FnMut(&Value) -> Result<(), String>,
        publish: &mut dyn FnMut(&Value) -> Result<(), String>,
    ) -> Result<Value, String> {
        if self.done.load(Ordering::SeqCst) {
            return Err("模型请求已经结束，未发起新调用。".into());
        }
        if prompt.len() + schema.to_string().len() > 512 * 1024 {
            return Err("模型输入超过 512 KiB，请缩小材料。".into());
        }
        let _call = loop {
            self.control.check()?;
            match self.call_gate.try_lock() {
                Ok(v) => break v,
                Err(std::sync::TryLockError::Poisoned(e)) => break e.into_inner(),
                Err(_) => std::thread::sleep(Duration::from_millis(10)),
            }
        };
        if self.done.load(Ordering::SeqCst) {
            return Err("模型请求已经结束，未发起新调用。".into());
        }
        self.ask_with(|| {
            self.control.check()?;
            let result = if self.settings.provider == "deepseek" {
                deepseek::run_admitted(
                    prompt,
                    schema,
                    &self.settings,
                    images,
                    &self.control,
                    output_limit,
                    admit,
                    publish,
                )
            } else {
                cli::run_control(
                    prompt,
                    schema,
                    &self.settings.model,
                    &self.settings.reasoning_effort,
                    self.settings.fast,
                    images,
                    &self.control,
                )
            };
            let value = result?;
            self.control.check()?;
            schema::validate(&value, schema)?;
            #[cfg(test)]
            if let Some(directory) = std::env::var_os("HUB_MODEL_ACCEPTANCE_CAPTURE") {
                let directory = PathBuf::from(directory);
                if !directory.is_dir() {
                    return Err("验收响应目录不存在".into());
                }
                let path =
                    directory.join(format!("{}-{}.json", self.id, crate::random_url_safe(8)));
                std::fs::write(
                    path,
                    serde_json::to_vec_pretty(
                        &json!({"selection":self.arguments(&json!({})),"result":value}),
                    )
                    .map_err(|_| "无法记录验收响应")?,
                )
                .map_err(|_| "无法记录验收响应")?;
            }
            Ok(value)
        })
    }
    fn ask_with(&self, run: impl FnOnce() -> Result<Value, String>) -> Result<Value, String> {
        let result = run();
        let mut remembered = self.model_error.lock().unwrap_or_else(|e| e.into_inner());
        if let Err(error) = &result {
            *remembered = Some(ModelError {
                message: safe_error(&self.settings.provider, error),
                recoverable: is_retryable_model_error(error) || is_output_contract_error(error),
                later_response_received: false,
            });
        } else if let Some(error) = remembered.as_mut() {
            error.later_response_received = true;
        }
        drop(remembered);
        result
    }
    /// Only the investigation's verified terminal delivery can acknowledge an
    /// explicitly corrected output or timeout. Other workflows retain sticky failures.
    pub(crate) fn finish_recovered<T>(&self, result: &Result<T, String>) {
        if result.is_ok() {
            let mut error = self.model_error.lock().unwrap_or_else(|e| e.into_inner());
            if error
                .as_ref()
                .is_some_and(|e| e.recoverable && e.later_response_received)
            {
                *error = None;
            }
        }
        self.finish(result);
    }
    pub fn finish<T>(&self, result: &Result<T, String>) {
        if self.done.swap(true, Ordering::SeqCst) {
            return;
        }
        let model_error = self
            .model_error
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|e| e.message.clone());
        let error = result
            .as_ref()
            .err()
            .map(|error| safe_error(&self.settings.provider, error))
            .or(model_error);
        let mut state = self.runtime.state.lock().unwrap_or_else(|e| e.into_inner());
        state.active = state.active.saturating_sub(1);
        state.controls.remove(&self.id);
        if state
            .background
            .as_ref()
            .is_some_and(|(id, _)| id == &self.id)
        {
            state.background = None;
        }
        if let Some(job) = state.jobs.iter_mut().find(|j| j.id == self.id) {
            let cancelled = self.control.cancelled.load(Ordering::SeqCst) && result.is_err();
            job.state = if cancelled {
                "cancelled"
            } else if error.is_none() {
                "succeeded"
            } else {
                "failed"
            };
            job.finished_at = Some(time_ms());
            job.error = if cancelled {
                Some("已按要求停止。".into())
            } else {
                error
            };
            job.executions = self.control.execution_receipts();
            job.usage = self
                .control
                .usage
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
        }
        state.revision += 1;
        prune(&mut state);
        drop(state);
        self.runtime.changed.notify_all();
    }
}
impl Drop for Operation {
    fn drop(&mut self) {
        self.finish::<()>(&Err("模型处理已中断。".into()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn progress_is_isolated_bounded_and_stops_after_finish() {
        let runtime = new_runtime(Settings::default());
        let operation = Operation::start_on(runtime.clone(), "tag-definition", "生成定义").unwrap();
        operation.context("方法");
        for _ in 0..100 {
            operation.progress("正在核对选定资料");
        }
        let view = snapshot(&runtime);
        assert_eq!(view["jobs"][0]["context"], "方法");
        assert_eq!(view["jobs"][0]["progress"].as_array().unwrap().len(), 96);
        let other = Operation::start_on(runtime.clone(), "other", "其他任务").unwrap();
        assert_eq!(snapshot(&runtime)["jobs"][1]["progress"], json!([]));
        other.finish(&Ok::<_, String>(()));
        operation.finish(&Err::<(), _>("核验未通过".to_string()));
        operation.progress("不能追加");
        let view = snapshot(&runtime);
        assert_eq!(view["jobs"][0]["state"], "failed");
        assert_eq!(view["jobs"][0]["progress"].as_array().unwrap().len(), 96);
    }
    #[test]
    fn conversation_selection_changes_only_its_own_snapshot_and_keeps_global_admission() {
        let global = Settings {
            model: "global-model".into(),
            max_concurrent: 1,
            ..Settings::default()
        };
        let runtime = new_runtime(global.clone());
        let selected = Settings {
            provider: "deepseek".into(),
            model: "conversation-model".into(),
            max_concurrent: 64,
            ..Settings::default()
        };
        let op = Operation::start_on_selected(
            runtime.clone(),
            "agent-investigation",
            "对话选择",
            Control::default(),
            false,
            Some(selected),
        )
        .unwrap()
        .unwrap();
        assert_eq!(op.arguments(&json!({}))["model"], "conversation-model");
        assert_eq!(op.settings.max_concurrent, 1);
        assert_eq!(runtime.state.lock().unwrap().settings, global);
        assert!(Operation::start_on_selected(
            runtime.clone(),
            "agent-condition",
            "后台复查",
            Control::default(),
            true,
            None
        )
        .unwrap()
        .is_none());
        op.finish(&Ok::<_, String>(()));
        let next = Operation::start_on(runtime, "other", "另一个工作").unwrap();
        assert_eq!(next.arguments(&json!({}))["model"], "global-model");
    }
    #[test]
    fn providers_share_one_fifo_and_cancel_only_the_selected_job() {
        let runtime = new_runtime(Settings {
            max_concurrent: 1,
            ..Settings::default()
        });
        let first = Operation::start_on(runtime.clone(), "codex-test", "已有请求").unwrap();
        runtime.state.lock().unwrap().settings = Settings {
            provider: "deepseek".into(),
            model: "deepseek-flash".into(),
            max_concurrent: 1,
            ..Settings::default()
        };
        let queued = runtime.clone();
        let control = Control::bounded(Duration::from_secs(2));
        let stop = control.clone();
        let next = std::thread::spawn(move || {
            Operation::start_on_control(queued, "deepseek-test", "等待请求", control)
                .map(|op| op.arguments(&json!({})))
        });
        let until = Instant::now() + Duration::from_secs(1);
        while snapshot(&runtime)["jobs"].as_array().unwrap().len() < 2 {
            assert!(Instant::now() < until);
            std::thread::yield_now();
        }
        let view = snapshot(&runtime);
        assert_eq!(view["jobs"][0]["provider"], "codex");
        assert_eq!(view["jobs"][1]["provider"], "deepseek");
        assert_eq!(view["jobs"][1]["state"], "queued");
        stop.cancel();
        assert!(next.join().unwrap().is_err());
        assert_eq!(snapshot(&runtime)["jobs"][1]["state"], "cancelled");
        assert_eq!(snapshot(&runtime)["jobs"][0]["state"], "running");
        first.finish(&Ok::<_, String>(()));
        let last = Operation::start_on(runtime.clone(), "deepseek-test", "后续请求").unwrap();
        assert_eq!(last.arguments(&json!({}))["provider"], "deepseek");
        last.finish(&Ok::<_, String>(()));
        assert_eq!(runtime.state.lock().unwrap().active, 0);
        assert!(runtime.state.lock().unwrap().controls.is_empty());
    }
    #[test]
    fn quick_investigation_reserves_retry_room_without_changing_legacy_limits() {
        let control = Control::bounded(Duration::from_secs(120))
            .with_generation_ceiling(Duration::from_secs(75));
        assert!(
            control
                .remaining()
                .unwrap()
                .saturating_sub(control.generation_limit())
                > Duration::from_secs(30)
        );
        assert_eq!(
            Control::default().generation_limit(),
            Duration::from_secs(240)
        );
        assert_eq!(
            Control::bounded(Duration::from_secs(600)).generation_limit(),
            Duration::from_secs(90)
        );
        assert_eq!(
            Control::bounded(Duration::from_secs(120))
                .with_generation_ceiling(Duration::from_secs(999))
                .generation_limit(),
            Duration::from_secs(90)
        );
    }
    #[test]
    fn native_turn_ceiling_preserves_host_budget_guard_and_cancellation() {
        let mut parent = Control::bounded(Duration::from_secs(5));
        parent.generation_ceiling = Some(Duration::from_millis(1));
        let child = parent.native_turn_control();
        std::thread::sleep(Duration::from_millis(5));
        assert_eq!(child.check().unwrap_err(), cli::GENERATION_TIMEOUT);
        assert!(parent.check().is_ok());
        let parent = Control::bounded(Duration::from_secs(2)).guarded(|| Err("来源已撤回".into()));
        assert_eq!(
            parent.native_turn_control().check().unwrap_err(),
            "来源已撤回"
        );
        let parent = Control::bounded(Duration::from_secs(2));
        let child = parent.native_turn_control();
        parent.cancel();
        assert!(child.check().unwrap_err().contains("中断"));
        let mut parent = Control::bounded(Duration::from_secs(2));
        parent.deadline = Some(Instant::now() - Duration::from_millis(1));
        assert!(parent
            .native_turn_control()
            .check()
            .unwrap_err()
            .contains("总时限"));
    }
    #[test]
    fn background_never_queues_and_manual_arrival_preempts_with_both_concurrency_limits() {
        for limit in [1, 2] {
            let runtime = new_runtime(Settings {
                max_concurrent: limit,
                ..Settings::default()
            });
            let control = Control::bounded(Duration::from_secs(2));
            let background = Operation::start_on_mode(
                runtime.clone(),
                "background",
                "复查",
                control.clone(),
                true,
            )
            .unwrap()
            .unwrap();
            assert!(Operation::start_on_mode(
                runtime.clone(),
                "background",
                "第二项",
                Control::default(),
                true
            )
            .unwrap()
            .is_none());
            let (tx, rx) = std::sync::mpsc::channel();
            let manual_runtime = runtime.clone();
            let manual = std::thread::spawn(move || {
                let op = Operation::start_on(manual_runtime, "manual", "手工").unwrap();
                tx.send(()).unwrap();
                op
            });
            let deadline = Instant::now() + Duration::from_secs(1);
            while control.check().is_ok() {
                assert!(Instant::now() < deadline);
                std::thread::yield_now();
            }
            background.finish(&Err::<(), String>("已让出".into()));
            rx.recv_timeout(Duration::from_secs(1)).unwrap();
            let op = manual.join().unwrap();
            assert!(Operation::start_on_mode(
                runtime.clone(),
                "background",
                "仍不抢占",
                Control::default(),
                true
            )
            .unwrap()
            .is_none());
            assert!(runtime.state.lock().unwrap().waiting.is_empty());
            drop(op);
            assert_eq!(runtime.state.lock().unwrap().active, 0);
        }
    }
    #[test]
    fn cancelled_or_expired_admission_removes_only_its_own_ticket() {
        let runtime = new_runtime(Settings {
            max_concurrent: 1,
            ..Settings::default()
        });
        let first = Operation::start_on(runtime.clone(), "existing", "保持运行").unwrap();
        for cancel in [false, true] {
            let control = Control::bounded(Duration::from_millis(100));
            let stop = control.clone();
            let queued = runtime.clone();
            let join = std::thread::spawn(move || {
                Operation::start_on_control(queued, "agent-investigation", "等待调查", control)
                    .map(|_| ())
            });
            if cancel {
                std::thread::sleep(Duration::from_millis(30));
                stop.cancel();
            }
            assert!(join.join().unwrap().is_err());
            let state = runtime.state.lock().unwrap();
            assert_eq!(state.active, 1);
            assert!(state.waiting.is_empty());
            assert_eq!(state.jobs.front().unwrap().state, "running");
        }
        first.finish(&Ok::<_, String>(()));
        let next = Operation::start_on(runtime.clone(), "next", "下一项").unwrap();
        assert_eq!(runtime.state.lock().unwrap().active, 1);
        drop(next);
    }
    #[test]
    fn cancellation_and_deadline_also_bound_waiting_for_catalog_owner() {
        let cache = Arc::new(CatalogCache::default());
        let held = cache.0.lock().unwrap();
        let waiting = cache.clone();
        let join = std::thread::spawn(move || {
            waiting.load_control(false, &Control::bounded(Duration::from_millis(60)), || {
                panic!("must not load")
            })
        });
        assert!(join.join().unwrap().is_err());
        drop(held);
        assert!(cache.load(false, || Ok(json!({"models":[]}))).is_ok());
    }
    fn catalog() -> Value {
        json!({"models":[{"id":"test-model","reasoningLevels":["low","high"],"fastDescription":"2x"}]})
    }
    #[test]
    fn catalog_cache_reuses_valid_result_refreshes_explicitly_and_never_keeps_failure() {
        let cache = CatalogCache::default();
        let calls = std::cell::Cell::new(0);
        let loader = || {
            calls.set(calls.get() + 1);
            Ok(json!({"models":[],"call":calls.get()}))
        };
        let first = cache.load(false, loader).unwrap();
        assert_eq!(cache.load(false, loader).unwrap(), first);
        assert_eq!(calls.get(), 1);
        assert_eq!(cache.load(true, loader).unwrap()["call"], 2);
        assert!(cache.load(true, || Err("read failed".into())).is_err());
        assert_eq!(cache.load(false, loader).unwrap()["call"], 3);
    }
    #[test]
    fn catalog_loader_is_single_flight_across_workflows() {
        let cache = Arc::new(CatalogCache::default());
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let first_cache = cache.clone();
        let first_calls = calls.clone();
        let first = std::thread::spawn(move || {
            first_cache.load(false, || {
                first_calls.fetch_add(1, Ordering::SeqCst);
                started_tx.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(2)).unwrap();
                Ok(json!({"models":[]}))
            })
        });
        started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let second_cache = cache.clone();
        let second_calls = calls.clone();
        let second = std::thread::spawn(move || {
            second_cache.load(false, || {
                second_calls.fetch_add(1, Ordering::SeqCst);
                Ok(json!({"models":[]}))
            })
        });
        release_tx.send(()).unwrap();
        assert_eq!(
            first.join().unwrap().unwrap(),
            second.join().unwrap().unwrap()
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn caught_model_failure_cannot_be_reported_as_success() {
        let runtime = new_runtime(Settings::default());
        let operation =
            Operation::start_on(runtime.clone(), "tag-content-scan", "逐篇检查").unwrap();
        let failure = operation.ask_with(|| Err("Codex 生成超时，secret.example".into()));
        let report: Result<Value, String> =
            Ok(json!({"errors":[failure.unwrap_err()],"submitted":[]}));
        operation.finish(&report);
        let jobs = snapshot(&runtime);
        assert_eq!(jobs["jobs"][0]["state"], "failed");
        assert_eq!(jobs["jobs"][0]["error"], "Codex 处理超时，请重试。");
        assert!(!jobs.to_string().contains("secret.example"));
    }
    #[test]
    fn deepseek_domain_failure_never_becomes_a_codex_error_or_echoes_private_input() {
        let runtime = new_runtime(Settings {
            provider: "deepseek".into(),
            ..Settings::default()
        });
        let operation =
            Operation::start_on(runtime.clone(), "agent-investigation", "调查").unwrap();
        operation.finish::<()>(&Err("引用原文未出现在实际读取范围 PRIVATE_SOURCE".into()));
        let view = snapshot(&runtime);
        assert_eq!(view["jobs"][0]["provider"], "deepseek");
        assert_eq!(
            view["jobs"][0]["error"],
            "调查结果未通过引文核验，未提交结果。"
        );
        assert!(!view.to_string().contains("Codex"));
        assert!(!view.to_string().contains("PRIVATE_SOURCE"));
        assert_eq!(
            safe_error("deepseek", "未知领域错误 PRIVATE"),
            "DeepSeek 处理失败，请查看对应功能的处理记录。"
        );
    }
    #[test]
    fn only_verified_investigation_delivery_can_acknowledge_a_corrected_output_failure() {
        for (later, delivered, legacy) in [
            (true, true, false),
            (false, true, false),
            (true, false, false),
            (true, true, true),
        ] {
            let runtime = new_runtime(Settings {
                provider: "deepseek".into(),
                ..Settings::default()
            });
            let operation =
                Operation::start_on(runtime.clone(), "agent-investigation", "调查").unwrap();
            let error =
                schema::validate(&json!({}), &json!({"type":"object","required":["report"]}))
                    .unwrap_err();
            assert!(operation.ask_with(|| Err(error)).is_err());
            if later {
                operation
                    .ask_with(|| Ok(json!({"candidate":true})))
                    .unwrap();
            }
            let result: Result<(), String> = if delivered {
                Ok(())
            } else {
                Err("引用原文未出现在实际读取范围".into())
            };
            if legacy {
                operation.finish(&result);
            } else {
                operation.finish_recovered(&result);
            }
            assert_eq!(
                snapshot(&runtime)["jobs"][0]["state"],
                if later && delivered && !legacy {
                    "succeeded"
                } else {
                    "failed"
                }
            );
        }
    }
    #[test]
    fn explicit_cancellation_is_a_distinct_terminal_state() {
        let runtime = new_runtime(Settings::default());
        let operation =
            Operation::start_on(runtime.clone(), "agent-investigation", "调查").unwrap();
        operation.control.cancel();
        let interrupted: Result<(), String> = Err("调查已中断，可以稍后继续。".into());
        operation.finish_recovered(&interrupted);
        assert_eq!(snapshot(&runtime)["jobs"][0]["state"], "cancelled");
        assert_eq!(runtime.state.lock().unwrap().active, 0);
    }
    #[test]
    fn verified_recovery_requires_a_later_response_and_only_acknowledges_call_timeouts() {
        for case in ["recovered", "no-response", "quota", "delivery-invalid"] {
            let runtime = new_runtime(Settings::default());
            let operation =
                Operation::start_on(runtime.clone(), "agent-investigation", "调查").unwrap();
            let error = if case == "quota" {
                "Codex 使用额度暂不可用，请稍后重试。"
            } else {
                cli::GENERATION_TIMEOUT
            };
            assert!(operation.ask_with(|| Err(error.into())).is_err());
            if case != "no-response" {
                operation
                    .ask_with(|| Ok(json!({"verified":"candidate"})))
                    .unwrap();
            }
            let delivery: Result<(), String> = if case == "delivery-invalid" {
                Err("引用未通过核验".into())
            } else {
                Ok(())
            };
            operation.finish_recovered(&delivery);
            let view = snapshot(&runtime);
            assert_eq!(
                view["jobs"][0]["state"],
                if case == "recovered" {
                    "succeeded"
                } else {
                    "failed"
                },
                "{case}"
            );
            assert_eq!(runtime.state.lock().unwrap().active, 0);
        }
        assert!(!is_retryable_model_error(
            "模型正文说：Codex 生成超时，请重试。"
        ));
    }
    #[test]
    fn finished_plan_releases_admission_and_remote_error_cannot_rewrite_its_result() {
        let runtime = new_runtime(Settings {
            max_concurrent: 1,
            ..Settings::default()
        });
        let operation =
            Operation::start_on(runtime.clone(), "collection-craft-archive", "生成归档方案")
                .unwrap();
        operation.finish(&Ok::<_, String>(()));
        assert_eq!(runtime.state.lock().unwrap().active, 0);
        operation.finish::<()>(&Err("Craft 附件上传失败".into()));
        assert_eq!(snapshot(&runtime)["jobs"][0]["state"], "succeeded");
        let next = Operation::start_on(runtime.clone(), "tag-definition", "生成定义").unwrap();
        drop(next);
    }
    #[test]
    fn operation_ignores_legacy_selection_and_keeps_snapshot_after_save() {
        let dir = std::env::temp_dir().join(format!(
            "hub-codex-suite-test-{}",
            crate::random_url_safe(12)
        ));
        let runtime = new_runtime(Settings::default());
        let original = Settings {
            provider: "codex".into(),
            model: "test-model".into(),
            reasoning_effort: "high".into(),
            fast: true,
            max_concurrent: 1,
        };
        save_with_catalog(&dir, &runtime, original.clone(), &catalog()).unwrap();
        let operation = Operation::start_on(runtime.clone(), "test", "测试").unwrap();
        let args = operation.arguments(
            &json!({"model":"injected","reasoningEffort":"ultra","fast":false,"tag":"keep"}),
        );
        assert_eq!(args["model"], "test-model");
        assert_eq!(args["reasoningEffort"], "high");
        assert_eq!(args["fast"], true);
        assert_eq!(args["tag"], "keep");
        save_with_catalog(&dir, &runtime, Settings::default(), &json!({})).unwrap();
        assert_eq!(operation.settings, original);
        assert_eq!(read_settings(&dir).unwrap(), Settings::default());
        operation.finish(&Ok::<_, String>(()));
        let next = Operation::start_on(runtime.clone(), "test", "测试").unwrap();
        assert_eq!(next.settings, Settings::default());
        drop(next);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn admission_waits_fifo_and_failure_releases_slot_and_redacts_error() {
        let runtime = new_runtime(Settings {
            max_concurrent: 1,
            ..Settings::default()
        });
        let first = Operation::start_on(runtime.clone(), "first", "首项").unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        let second_runtime = runtime.clone();
        let second = std::thread::spawn(move || {
            let operation = Operation::start_on(second_runtime, "second", "次项").unwrap();
            sender.send(operation.id.clone()).unwrap();
            operation.finish(&Ok::<_, String>(()));
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            if snapshot(&runtime)["jobs"].as_array().unwrap().len() == 2 {
                break;
            }
            assert!(std::time::Instant::now() < deadline);
            std::thread::yield_now();
        }
        let pending = snapshot(&runtime);
        assert_eq!(pending["jobs"][1]["state"], "queued");
        assert!(receiver.try_recv().is_err());
        first.finish::<()>(&Err("private token https://secret.example/path".into()));
        receiver
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        second.join().unwrap();
        let result = snapshot(&runtime);
        assert_eq!(result["jobs"][0]["state"], "failed");
        assert_eq!(result["jobs"][1]["state"], "succeeded");
        assert!(!result.to_string().contains("secret.example"));
    }
    #[test]
    fn settings_reject_invalid_limits_unsupported_model_effort_and_fast() {
        for max_concurrent in [0, 5] {
            assert!(basic_validate(&Settings {
                max_concurrent,
                ..Settings::default()
            })
            .is_err());
        }
        let dir = std::env::temp_dir().join(format!(
            "hub-codex-suite-test-{}",
            crate::random_url_safe(12)
        ));
        let runtime = new_runtime(Settings::default());
        for settings in [
            Settings {
                model: "other".into(),
                ..Settings::default()
            },
            Settings {
                model: "test-model".into(),
                reasoning_effort: "ultra".into(),
                ..Settings::default()
            },
            Settings {
                fast: true,
                ..Settings::default()
            },
        ] {
            assert!(save_with_catalog(&dir, &runtime, settings, &catalog()).is_err());
        }
        assert!(!dir.exists());
        assert_eq!(snapshot(&runtime)["settings"]["model"], "");
    }
    #[test]
    fn abandoned_operations_release_and_terminal_history_is_bounded() {
        let runtime = new_runtime(Settings::default());
        for _ in 0..40 {
            drop(Operation::start_on(runtime.clone(), "test", "测试").unwrap());
        }
        let state = snapshot(&runtime);
        assert_eq!(state["jobs"].as_array().unwrap().len(), 30);
        assert!(state["jobs"]
            .as_array()
            .unwrap()
            .iter()
            .all(|j| j["state"] == "failed" && j["finishedAt"].is_number()));
        assert_eq!(runtime.state.lock().unwrap().active, 0);
    }
}
