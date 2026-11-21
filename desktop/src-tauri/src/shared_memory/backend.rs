//! Restricted local Basic Memory transport. No model can call its management tools.
use super::*;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RuntimeConfig {
    pub python: PathBuf,
    pub model_cache: PathBuf,
}

pub(super) trait Backend {
    fn write(&mut self, revision: &str, body: &str) -> Result<(), String>;
    fn ready(&mut self, revision: &str) -> Result<bool, String>;
    fn search(&mut self, query: &str, allowed: &[String]) -> Result<Vec<String>, String>;
    fn delete(&mut self, revision: &str) -> Result<(), String>;
}

pub(super) struct BasicMemory {
    child: Child,
    input: Option<ChildStdin>,
    replies: Option<mpsc::Receiver<Result<Value, String>>>,
    reader: Option<std::thread::JoinHandle<()>>,
    next: u64,
    deadline: Instant,
    control: Option<crate::model_runtime::Control>,
    #[cfg(windows)]
    group: Option<Job>,
}

#[cfg(windows)]
pub(super) struct Job(windows::Win32::Foundation::HANDLE);
#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.0);
        }
    }
}
#[cfg(windows)]
pub(super) fn attach(pid: u32) -> Result<Job, String> {
    use windows::Win32::{
        Foundation::CloseHandle,
        System::{JobObjects::*, Threading::*},
    };
    unsafe {
        let group = Job(CreateJobObjectW(None, None).map_err(|e| e.to_string())?);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            group.0,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as _,
            std::mem::size_of_val(&limits) as u32,
        )
        .map_err(|e| e.to_string())?;
        let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid)
            .map_err(|e| e.to_string())?;
        let result = AssignProcessToJobObject(group.0, process);
        let _ = CloseHandle(process);
        result.map_err(|e| e.to_string())?;
        Ok(group)
    }
}

pub(super) fn config(root: &Path) -> Result<RuntimeConfig, String> {
    if runtime::archive_path()?.is_file() || !cfg!(debug_assertions) {
        return runtime::ensure(root);
    }
    // Legacy manual bindings are available only in development/integration
    // builds. Packaged releases always resolve their own verified resources.
    let path = root.join("memory-runtime-v1.json");
    safe_path(&path)?;
    let bytes = fs::read(path).map_err(|_| "请先连接本地 Basic Memory 运行环境")?;
    if bytes.len() > 8192 {
        return Err("记忆运行配置过大".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "记忆运行配置无效".into())
}

pub(super) fn preview(root: &Path) -> Result<(), String> {
    if runtime::archive_path()?.is_file() || !cfg!(debug_assertions) {
        runtime::prepared(root)
    } else {
        config(root).map(|_| ())
    }
}

impl BasicMemory {
    pub(super) fn start(root: &Path, cfg: &RuntimeConfig) -> Result<Self, String> {
        Self::start_controlled(root, cfg, None)
    }
    pub(super) fn start_controlled(
        root: &Path,
        cfg: &RuntimeConfig,
        control: Option<&crate::model_runtime::Control>,
    ) -> Result<Self, String> {
        if let Some(control) = control {
            control.check()?;
        }
        if !cfg.python.is_absolute()
            || !cfg.python.is_file()
            || !cfg.model_cache.is_absolute()
            || !cfg.model_cache.is_dir()
        {
            return Err("本地记忆运行环境或中文模型目录不可用".into());
        }
        safe_path(&cfg.python)?;
        safe_path(&cfg.model_cache)?;
        let canonical = fs::canonicalize(root).map_err(|e| e.to_string())?;
        // SQLAlchemy/SQLite cannot consume the Win32 extended prefix as a URI.
        // Keep the resolved identity but normalize its external representation.
        let root = PathBuf::from(crate::display_local_path(&canonical));
        // A moved/restored profile gets a fresh derived index. Absolute project
        // paths from the old machine never become authoritative.
        let key = hash(crate::display_local_path(&root).as_bytes());
        let cache = root.join("cache/shared-memory-bm").join(&key[..16]);
        let notes = root.join("shared-memory/notes");
        for path in [&cache, &notes] {
            safe_path(path)?;
            fs::create_dir_all(path).map_err(|e| e.to_string())?;
        }
        let settings = json!({
            "projects":{"hub":{"path":crate::display_local_path(&notes),"mode":"local"}},
            "default_project":"hub", "auto_update":false, "cloud_promo_opt_out":true,
            "logfire_enabled":false, "logfire_send_to_logfire":false,
            "index_changes":false, "semantic_search_enabled":true,
            "semantic_embedding_model":"BAAI/bge-small-zh-v1.5",
            "semantic_embedding_dimensions":512, "semantic_embedding_threads":2,
            "semantic_embedding_sync_batch_size":32,
            "semantic_embedding_cache_dir":cfg.model_cache,
            "reranker_enabled":false
        });
        fs::write(
            cache.join("config.json"),
            serde_json::to_vec_pretty(&settings).unwrap(),
        )
        .map_err(|e| e.to_string())?;
        let preparing =
            !cache.join("hub-index-ready-v1").is_file() || !cache.join("memory.db").is_file();
        let mut command = Command::new(&cfg.python);
        command
            .args(["-I", "-B", "-X", "utf8", "-c", include_str!("bootstrap.py")])
            .current_dir(&root)
            .env_clear();
        for name in [
            "SYSTEMROOT",
            "WINDIR",
            "PATH",
            "TEMP",
            "TMP",
            "COMSPEC",
            "PATHEXT",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
            "PROGRAMDATA",
        ] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        command
            .env("BASIC_MEMORY_CONFIG_DIR", &cache)
            .env("BASIC_MEMORY_HOME", &notes)
            .env("BASIC_MEMORY_FORCE_LOCAL", "true")
            .env("BASIC_MEMORY_AUTO_UPDATE", "false")
            .env("BASIC_MEMORY_NO_PROMOS", "1")
            .env("BASIC_MEMORY_LOGFIRE_ENABLED", "false")
            .env("BASIC_MEMORY_LOGFIRE_SEND_TO_LOGFIRE", "false")
            .env("FASTMCP_CHECK_FOR_UPDATES", "off")
            .env("FASTMCP_SHOW_SERVER_BANNER", "false")
            .env("HF_HUB_OFFLINE", "1")
            .env("TRANSFORMERS_OFFLINE", "1")
            .env("FASTEMBED_CACHE_PATH", &cfg.model_cache)
            .env("PYTHONIOENCODING", "utf-8")
            .env("PYTHONUTF8", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let child = command.spawn().map_err(|_| "无法启动 Basic Memory")?;
        let mut service = Self {
            child,
            input: None,
            replies: None,
            reader: None,
            next: 0,
            deadline: Instant::now() + Duration::from_secs(if preparing { 120 } else { 60 }),
            control: control.cloned(),
            #[cfg(windows)]
            group: None,
        };
        #[cfg(windows)]
        {
            service.group = Some(attach(service.child.id())?);
        }
        service.input = service.child.stdin.take();
        let output = service.child.stdout.take().ok_or("记忆输出通道缺失")?;
        let (sender, receiver) = mpsc::sync_channel(8);
        service.replies = Some(receiver);
        service.reader = Some(
            std::thread::Builder::new()
                .name("hub-memory-mcp".into())
                .spawn(move || {
                    let mut output = BufReader::new(output);
                    loop {
                        let mut line = Vec::new();
                        let result = output.by_ref().take(1_048_577).read_until(b'\n', &mut line);
                        let message = match result {
                            Ok(0) => Err("Basic Memory 已退出".into()),
                            Ok(_) if line.len() > 1_048_576 => Err("记忆服务消息过大".into()),
                            Ok(_) => serde_json::from_slice::<Value>(&line)
                                .map_err(|_| "记忆服务协议无效".into()),
                            Err(_) => Err("记忆服务读取失败".into()),
                        };
                        let failed = message.is_err();
                        if sender.send(message).is_err() || failed {
                            break;
                        }
                    }
                })
                .map_err(|e| e.to_string())?,
        );
        service.rpc(
            "initialize",
            json!({"protocolVersion":"2025-06-18","capabilities":{},
            "clientInfo":{"name":"hub-shared-memory","version":"1"}}),
        )?;
        service.send(&json!({"jsonrpc":"2.0","method":"notifications/initialized"}))?;
        let catalog = service.rpc("tools/list", json!({}))?;
        for name in ["write_note", "read_note", "search_notes", "delete_note"] {
            if !catalog["tools"]
                .as_array()
                .is_some_and(|tools| tools.iter().any(|t| t["name"] == name))
            {
                return Err(format!("记忆服务缺少所需能力：{name}"));
            }
        }
        service.deadline = Instant::now() + Duration::from_secs(60);
        Ok(service)
    }
    fn send(&mut self, value: &Value) -> Result<(), String> {
        let input = self.input.as_mut().ok_or("记忆输入已关闭")?;
        writeln!(input, "{value}")
            .and_then(|_| input.flush())
            .map_err(|_| "记忆服务写入失败".into())
    }
    fn rpc(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.next += 1;
        let id = self.next;
        self.send(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))?;
        loop {
            if let Some(control) = &self.control {
                control.check()?;
            }
            let remaining = self
                .deadline
                .checked_duration_since(Instant::now())
                .ok_or("记忆服务操作超时；待处理版本可以重试")?;
            let response = match self
                .replies
                .as_ref()
                .ok_or("记忆服务已关闭")?
                .recv_timeout(remaining.min(Duration::from_millis(100)))
            {
                Ok(value) => value?,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => return Err("记忆服务操作中断".into()),
            };
            if response["id"] != id {
                continue;
            }
            if response.get("error").is_some() {
                return Err("Basic Memory 拒绝了操作".into());
            }
            return response
                .get("result")
                .cloned()
                .ok_or("记忆服务缺少结果".into());
        }
    }
    fn call(&mut self, name: &str, arguments: Value) -> Result<Value, String> {
        let result = self.rpc("tools/call", json!({"name":name,"arguments":arguments}))?;
        if result["isError"] == true {
            return Err(format!("Basic Memory {name} 未完成"));
        }
        if result["structuredContent"].is_object() {
            return Ok(result["structuredContent"].clone());
        }
        let text = result["content"]
            .as_array()
            .and_then(|v| v.iter().find(|c| c["type"] == "text"))
            .and_then(|v| v["text"].as_str())
            .ok_or("记忆服务未返回内容")?;
        Ok(serde_json::from_str(text).unwrap_or_else(|_| json!({"text":text})))
    }
    fn find(&mut self, query: &str, kind: &str) -> Result<Vec<String>, String> {
        self.find_scoped(query, kind, None)
    }
    fn find_scoped(
        &mut self,
        query: &str,
        kind: &str,
        allowed: Option<&[String]>,
    ) -> Result<Vec<String>, String> {
        let mut args = json!({"project":"hub","search_all_projects":false,"query":query,"search_type":kind,"entity_types":["entity"],"page_size":100,"min_similarity":0.0,"output_format":"json"});
        if let Some(ids) = allowed {
            args["metadata_filters"] = json!({"permalink":{"$in":ids}});
        }
        let result = self.call("search_notes", args)?;
        let result = result.get("result").unwrap_or(&result);
        let rows = result["results"]
            .as_array()
            .ok_or("Basic Memory 检索尚不可用")?;
        Ok(rows
            .iter()
            .filter_map(|v| v["permalink"].as_str())
            .map(str::to_owned)
            .collect())
    }
}
impl Backend for BasicMemory {
    fn write(&mut self, revision: &str, body: &str) -> Result<(), String> {
        self.call(
            "write_note",
            json!({"title":revision,"content":format!("---\npermalink: {revision}\n---\n\n{body}"),
            "directory":"","project":"hub","overwrite":false,"output_format":"json"}),
        )?;
        Ok(())
    }
    fn ready(&mut self, revision: &str) -> Result<bool, String> {
        if !self
            .find(revision, "permalink")?
            .iter()
            .any(|s| s == revision)
        {
            return Ok(false);
        }
        Ok(self.find(revision, "vector")?.iter().any(|s| s == revision))
    }
    fn search(&mut self, query: &str, allowed: &[String]) -> Result<Vec<String>, String> {
        self.find_scoped(query, "vector", Some(allowed))
    }
    fn delete(&mut self, revision: &str) -> Result<(), String> {
        self.call("delete_note",json!({"identifier":revision,"project":"hub","is_directory":false,"output_format":"json"}))?;
        Ok(())
    }
}
impl Drop for BasicMemory {
    fn drop(&mut self) {
        self.input.take();
        // Give the normal lifespan shutdown a bounded chance to drain accepted
        // writes before killing the owned process group.
        let until = Instant::now() + Duration::from_secs(3);
        while Instant::now() < until {
            if self.child.try_wait().ok().flatten().is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        #[cfg(windows)]
        {
            self.group.take();
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.replies.take();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}
