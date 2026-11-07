//! Optional, pinned tdl adapter. MTProto account sessions are separate from Bot API tokens.
//! Only the paired owner's outgoing messages in this bot's private chat are imported.
use super::*;
use std::process::{Command, Stdio};
#[cfg(windows)]
mod console;
pub(crate) mod login;

const VERSION: &str = "0.20.4";
const ZIP_HASH: &str = "3f219779c07a4be628c34491b9910c18a3b0a0ca0b0aa4f283bb83ab33b007c8";
const CONFIG: &str = "collection_telegram_tdl_v1";
static LOCK: AsyncMutex<()> = AsyncMutex::const_new(());
static CANCEL: AtomicBool = AtomicBool::new(false);
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    running: bool,
    phase: String,
    status: String,
    bytes: u64,
}
static PROGRESS: std::sync::LazyLock<Mutex<Progress>> =
    std::sync::LazyLock::new(|| Mutex::new(Progress::default()));
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Settings {
    enabled: bool,
    bot_id: i64,
    user_id: i64,
    last_success: i64,
    proxy: String,
    status: String,
}
fn settings(c: &Connection) -> Result<Settings, String> {
    let body = metadata_string(c, CONFIG);
    if body.is_empty() {
        Ok(Settings::default())
    } else {
        serde_json::from_str(&body).map_err(|_| "tdl 设置损坏".into())
    }
}
fn save_settings(c: &Connection, cfg: &Settings) -> Result<(), String> {
    c.execute("INSERT INTO metadata(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![CONFIG,serde_json::to_string(cfg).map_err(|e|e.to_string())?]).map(|_|()).map_err(|e|e.to_string())
}
fn invalidate_identity(c: &Connection) -> Result<(), String> {
    let mut cfg = settings(c)?;
    cfg.last_success = 0;
    cfg.enabled = false;
    cfg.status = "Telegram 账号待重新验证".into();
    save_settings(c, &cfg)
}
fn progress(phase: &str, status: &str, running: bool) {
    if let Ok(mut p) = PROGRESS.lock() {
        p.phase = phase.into();
        p.status = status.into();
        p.running = running;
        p.bytes = 0;
    }
}
pub(crate) fn schema(c: &Connection) -> Result<(), String> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS collection_telegram_tdl_messages(
        bot_id INTEGER NOT NULL,user_id INTEGER NOT NULL,message_id INTEGER NOT NULL,item_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,message_json TEXT NOT NULL,PRIMARY KEY(bot_id,user_id,message_id));
        CREATE INDEX IF NOT EXISTS collection_telegram_tdl_fingerprint ON collection_telegram_tdl_messages(bot_id,user_id,fingerprint);
        CREATE TABLE IF NOT EXISTS collection_telegram_tdl_media(media_url TEXT PRIMARY KEY,bot_id INTEGER NOT NULL,user_id INTEGER NOT NULL,message_id INTEGER NOT NULL,size INTEGER NOT NULL);")
        .map_err(|e|e.to_string())
}
fn tool_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = active_data_root(app)?
        .join("tools")
        .join("tdl")
        .join(VERSION);
    fs::create_dir_all(&root).map_err(|_| "无法创建 tdl 工具目录")?;
    fs::canonicalize(root).map_err(|_| "无法访问 tdl 工具目录".into())
}
fn executable(app: &AppHandle) -> Result<PathBuf, String> {
    let path = tool_root(app)?.join("tdl.exe");
    if !path.is_file() {
        return Err("请先安装 tdl".into());
    }
    let identity = fs::read_to_string(path.with_extension("sha256"))
        .map_err(|_| "tdl 安装不完整，请重新安装")?;
    let bytes = fs::read(&path).map_err(|_| "无法读取 tdl")?;
    if identity.trim() != format!("{:x}", Sha256::digest(&bytes)) {
        return Err("tdl 文件已变化，请重新安装官方版本".into());
    }
    Ok(path)
}
fn session_root(app: &AppHandle, cfg: &Inbox) -> Result<PathBuf, String> {
    let base = fs::canonicalize(active_data_root(app)?).map_err(|_| "无法访问 Hub 数据目录")?;
    let root = base
        .join("telegram-tdl")
        .join(format!("{}-{}", cfg.bot_id, cfg.user_id));
    fs::create_dir_all(&root).map_err(|_| "无法创建 Telegram 会话目录")?;
    let root = fs::canonicalize(root).map_err(|_| "无法访问 Telegram 会话目录")?;
    if !root.starts_with(&base) {
        return Err("Telegram 会话目录超出 Hub 数据目录".into());
    }
    if root.to_string_lossy().contains(',') {
        return Err("tdl 会话目录不能包含逗号，请调整 Hub 数据目录".into());
    }
    #[cfg(windows)]
    if !root.join(".private-session").is_file() {
        // MTProto sessions authorize the personal account; restrict inheritance before tdl writes one.
        let script=format!("$ErrorActionPreference='Stop'; $p={}; $acl=[Security.AccessControl.DirectorySecurity]::new(); $acl.SetAccessRuleProtection($true,$false); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.SetAccessRule($rule); [IO.Directory]::SetAccessControl($p,$acl)",ps_literal(&root));
        let mut process = Command::new("powershell.exe");
        process
            .args(["-NoProfile", "-NonInteractive", "-Command"])
            .arg(script)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        hidden(&mut process);
        if !process
            .status()
            .map_err(|_| "无法保护 Telegram 登录会话")?
            .success()
        {
            return Err("无法保护 Telegram 登录会话".into());
        }
        fs::write(root.join(".private-session"), "owner-only")
            .map_err(|_| "无法保存会话保护设置")?;
    }
    Ok(root)
}
pub(crate) fn state(app: &AppHandle, c: &Connection) -> Result<Value, String> {
    let cfg = settings(c)?;
    let effective_proxy = selected_proxy(&cfg.proxy, windows_system_proxy_url());
    let inbox = inbox(c)?;
    let p = PROGRESS.lock().map(|p| p.clone()).unwrap_or_default();
    let installed = tool_root(app)?.join("tdl.exe").is_file();
    Ok(
        json!({"installed":installed,"version":VERSION,"enabled":cfg.enabled,"ready":cfg.bot_id==inbox.bot_id&&cfg.user_id==inbox.user_id&&cfg.last_success>0,
        "running":p.running,"phase":p.phase,"status":if p.running||!p.status.is_empty(){p.status}else{cfg.status},"bytes":p.bytes,"proxyInherited":cfg.proxy.is_empty()&&!effective_proxy.is_empty(),"effectiveProxy":effective_proxy,"proxy":cfg.proxy}),
    )
}
fn paired(app: &AppHandle) -> Result<Inbox, String> {
    let (c, _writer) = open_write_database(&database_path(app)?)?;
    let cfg = inbox(&c)?;
    if !cfg.enabled || cfg.bot_id <= 0 || cfg.user_id <= 0 {
        return Err("请先连接机器人并确认你的 Telegram 账号".into());
    }
    Ok(cfg)
}
fn hidden(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
}
fn command(app: &AppHandle, cfg: &Inbox) -> Result<Command, String> {
    let root = session_root(app, cfg)?;
    let (c, _writer) = open_write_database(&database_path(app)?)?;
    let settings = settings(&c)?;
    let mut command = Command::new(executable(app)?);
    command
        .current_dir(&root)
        .arg("--ns")
        .arg("hub")
        .arg("--storage")
        .arg(format!("type=bolt,path={}", root.join("session").display()))
        .arg("--reconnect-timeout")
        .arg("30s")
        .arg("--disable-progress-ps");
    let proxy = selected_proxy(&settings.proxy, windows_system_proxy_url());
    if !proxy.is_empty() {
        command.arg("--proxy").arg(proxy);
    }
    Ok(command)
}
fn selected_proxy(manual: &str, system: Option<String>) -> String {
    if !manual.is_empty() {
        return manual.into();
    }
    system
        .filter(|s| {
            Url::parse(s).is_ok_and(|u| {
                matches!(u.scheme(), "http" | "https" | "socks5")
                    && u.username().is_empty()
                    && u.password().is_none()
            })
        })
        .unwrap_or_default()
}
async fn wait_process(
    mut command: Command,
    timeout: Duration,
    watch: Option<&Path>,
) -> Result<(), String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hidden(&mut command);
    let mut child = command
        .spawn()
        .map_err(|_| "无法启动 tdl，请检查工具安装")?;
    let start = std::time::Instant::now();
    loop {
        if CANCEL.load(Ordering::Relaxed) || start.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(if CANCEL.load(Ordering::Relaxed) {
                "tdl 已暂停；已完成的内容保留，可重试"
            } else {
                "tdl 操作超时；请检查网络、代理和 Telegram 登录后重试"
            }
            .into());
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                return if status.success() {
                    Ok(())
                } else {
                    Err("tdl 未完成，请检查 Telegram 登录和代理后重试；已保存的内容保留".into())
                }
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("无法读取 tdl 运行结果".into());
            }
            Ok(None) => {}
        }
        if let Some(path) = watch {
            if let Ok(m) = fs::metadata(path) {
                if let Ok(mut p) = PROGRESS.lock() {
                    p.bytes = m.len();
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}
fn ps_literal(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "''"))
}

#[tauri::command]
pub(crate) async fn install_telegram_tdl(app: AppHandle) -> Result<String, String> {
    #[cfg(not(all(windows, target_arch = "x86_64")))]
    {
        let _ = app;
        return Err("tdl 自动安装目前支持 Windows x64".into());
    }
    #[cfg(all(windows, target_arch = "x86_64"))]
    {
        let _guard = LOCK.try_lock().map_err(|_| "tdl 正在运行，请稍后重试")?;
        CANCEL.store(false, Ordering::Relaxed);
        progress("installing", "正在下载并校验官方 tdl 0.20.4", true);
        let result = install_inner(&app).await;
        progress(
            "",
            result
                .as_ref()
                .map(|_| "tdl 已安装；请登录发送消息的 Telegram 账号")
                .unwrap_or_else(|e| e),
            false,
        );
        result.map(|_| "tdl 已安装，请登录 Telegram 账号".into())
    }
}
#[cfg(all(windows, target_arch = "x86_64"))]
async fn install_inner(app: &AppHandle) -> Result<(), String> {
    let root = tool_root(app)?;
    let work = root.join(format!("install-{}", random_url_safe(8)));
    fs::create_dir(&work).map_err(|_| "无法准备 tdl 安装")?;
    let cleanup = WorkDirectory(work.clone());
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|_| "无法初始化 tdl 下载")?;
    let mut response = client
        .get("https://github.com/iyear/tdl/releases/download/v0.20.4/tdl_Windows_64bit.zip")
        .send()
        .await
        .map_err(|_| "无法下载 tdl，请检查网络后重试")?;
    if !response.status().is_success() {
        return Err("tdl 官方下载暂不可用，请稍后重试".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "tdl 下载中断")? {
        if CANCEL.load(Ordering::Relaxed) {
            return Err("tdl 安装已取消".into());
        }
        if bytes.len() + chunk.len() > 32 * 1024 * 1024 {
            return Err("tdl 安装包大小异常".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if format!("{:x}", Sha256::digest(&bytes)) != ZIP_HASH {
        return Err("tdl 安装包校验失败，未运行下载的文件".into());
    }
    let zip = work.join("tdl.zip");
    fs::write(&zip, bytes).map_err(|_| "无法保存 tdl 安装包")?;
    // Extract only the pinned executable and license; archive paths never become destinations.
    let script=format!("$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead({}); try {{ foreach($name in @('tdl.exe','LICENSE')) {{ $entry=$z.Entries | Where-Object {{ $_.FullName -eq $name }}; if(!$entry) {{ throw 'missing entry' }}; [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,[IO.Path]::Combine({},$name),$false) }} }} finally {{ $z.Dispose() }}",ps_literal(&zip),ps_literal(&work));
    let mut extract = Command::new("powershell.exe");
    extract
        .args(["-NoProfile", "-NonInteractive", "-Command"])
        .arg(script);
    wait_process(extract, Duration::from_secs(60), None).await?;
    let exe = work.join("tdl.exe");
    let mut probe = Command::new(&exe);
    probe.args(["chat", "export", "--help"]);
    wait_process(probe, Duration::from_secs(10), None).await?;
    let identity = format!(
        "{:x}",
        Sha256::digest(fs::read(&exe).map_err(|_| "tdl 安装不完整")?)
    );
    fs::copy(exe, root.join("tdl.exe")).map_err(|_| "无法保存 tdl 工具")?;
    fs::copy(work.join("LICENSE"), root.join("LICENSE")).map_err(|_| "无法保存 tdl 许可证")?;
    fs::write(root.join("tdl.sha256"), identity).map_err(|_| "无法保存 tdl 校验记录")?;
    drop(cleanup);
    Ok(())
}
struct WorkDirectory(PathBuf);
impl Drop for WorkDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[tauri::command]
pub(crate) fn save_telegram_tdl(
    app: AppHandle,
    enabled: bool,
    proxy: String,
) -> Result<String, String> {
    let _guard = LOCK
        .try_lock()
        .map_err(|_| "tdl 正在运行，本轮结束后可修改设置")?;
    let proxy = proxy.trim().to_string();
    if !proxy.is_empty() {
        let url = Url::parse(&proxy)
            .map_err(|_| "代理格式应为 socks5://127.0.0.1:端口 或 http://127.0.0.1:端口")?;
        if !matches!(url.scheme(), "http" | "https" | "socks5")
            || url.username() != ""
            || url.password().is_some()
            || url.host_str().is_none()
            || url.port().is_none()
            || url.path() != "" && url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("请填写带端口、不含账号密码的 HTTP 或 SOCKS5 代理".into());
        }
    }
    let (c, _writer) = open_write_database(&database_path(&app)?)?;
    let mut cfg = settings(&c)?;
    cfg.enabled = enabled;
    cfg.proxy = proxy;
    save_settings(&c, &cfg)?;
    Ok("tdl 设置已保存".into())
}
#[tauri::command]
pub(crate) async fn login_telegram_tdl(
    app: AppHandle,
    method: String,
    replace: Option<u64>,
) -> Result<String, String> {
    if !matches!(method.as_str(), "qr" | "code") {
        return Err("请选择扫码或验证码登录".into());
    }
    let guard = if let Some(id) = replace {
        if method != "qr" || !login::is_active(id) {
            return Err("本次扫码登录已结束，请重新登录".into());
        }
        CANCEL.store(true, Ordering::Relaxed);
        tokio::time::timeout(Duration::from_secs(5), LOCK.lock())
            .await
            .map_err(|_| "正在结束上次登录，请稍后重试")?
    } else {
        LOCK.try_lock().map_err(|_| "tdl 正在运行，请稍后重试")?
    };
    let cfg = paired(&app)?;
    {
        let (c, _writer) = open_write_database(&database_path(&app)?)?;
        // A new login may replace the account session. Never reuse the previous verification or time cursor.
        invalidate_identity(&c)?;
    }
    let mut command = command(&app, &cfg)?;
    command.args(["login", "-T", &method]);
    if method == "qr" {
        return login::launch(app, cfg, command, guard);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x00000010);
    }
    #[cfg(not(windows))]
    {
        return Err("请在 Windows 版 Hub 中登录 tdl".into());
    }
    let child = command.spawn().map_err(|_| "无法打开 Telegram 登录窗口")?;
    CANCEL.store(false, Ordering::Relaxed);
    progress(
        "login",
        "请在新打开的登录窗口中完成 Telegram 登录；Hub 不读取验证码或密码",
        true,
    );
    tauri::async_runtime::spawn(async move {
        let _guard = guard;
        let mut child = child;
        let started = std::time::Instant::now();
        let result = loop {
            if CANCEL.load(Ordering::Relaxed) || started.elapsed() > Duration::from_secs(300) {
                let _ = child.kill();
                let _ = child.wait();
                break Err(if CANCEL.load(Ordering::Relaxed) {
                    "Telegram 登录已取消"
                } else {
                    "登录等待超时，请重新登录"
                }
                .into());
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    break if status.success() {
                        sync_inner(&app, &cfg, false).await
                    } else {
                        Err("验证码登录未完成；请检查登录窗口提示、网络或代理后重试".into())
                    }
                }
                Err(_) => break Err("无法读取 Telegram 登录结果".into()),
                Ok(None) => {}
            }
            tokio::time::sleep(Duration::from_millis(400)).await;
        };
        finish(&app, &result);
        drop(_guard);
        queue_export(&app, true);
    });
    Ok("已打开 Telegram 登录窗口；请登录与机器人绑定的账号".into())
}
#[tauri::command]
pub(crate) async fn sync_telegram_tdl(app: AppHandle) -> Result<String, String> {
    let cfg = paired(&app)?;
    executable(&app)?;
    let guard = LOCK.try_lock().map_err(|_| "tdl 正在运行，请稍后重试")?;
    CANCEL.store(false, Ordering::Relaxed);
    progress(
        "history",
        "正在补取机器人会话历史；已收集内容可继续编辑",
        true,
    );
    launch(app, cfg, true, guard);
    Ok("已开始补取 Telegram 历史，附件会继续在后台下载".into())
}
fn launch(app: AppHandle, cfg: Inbox, all: bool, guard: tokio::sync::MutexGuard<'static, ()>) {
    tauri::async_runtime::spawn(async move {
        let _guard = guard;
        let result = sync_inner(&app, &cfg, all).await;
        finish(&app, &result);
        drop(_guard);
        queue_export(&app, true);
    });
}
pub(crate) fn launch_if_ready(app: &AppHandle) {
    let Ok(cfg) = paired(app) else {
        return;
    };
    let ready = (|| -> Result<bool, String> {
        let (c, _writer) = open_write_database(&database_path(app)?)?;
        let s = settings(&c)?;
        Ok(s.enabled && s.last_success > 0 && s.bot_id == cfg.bot_id && s.user_id == cfg.user_id)
    })()
    .unwrap_or(false);
    if !ready {
        return;
    }
    let Ok(guard) = LOCK.try_lock() else {
        return;
    };
    CANCEL.store(false, Ordering::Relaxed);
    progress("history", "正在检查 Telegram 历史与大附件", true);
    launch(app.clone(), cfg, false, guard);
}
pub(crate) fn cancel() {
    CANCEL.store(true, Ordering::Relaxed);
}
#[tauri::command]
pub(crate) fn cancel_telegram_tdl(app: AppHandle) -> String {
    let downloading = PROGRESS
        .lock()
        .map(|p| p.running && p.phase == "download")
        .unwrap_or(false);
    cancel();
    if downloading {
        crate::x_bookmarks::cancel_x_bookmark_sync(app);
    }
    "正在暂停 tdl，已完成的内容保留".into()
}
fn finish(app: &AppHandle, result: &Result<String, String>) {
    let status = result.as_ref().map(String::as_str).unwrap_or_else(|e| e);
    progress("", status, false);
    if let Ok(path) = database_path(app) {
        if let Ok((c, _writer)) = open_write_database(&path) {
            if let Ok(mut s) = settings(&c) {
                s.status = status.into();
                let _ = save_settings(&c, &s);
            }
        }
    }
    let _ = app.emit("collections-updated", json!({"source":"telegram"}));
}
async fn sync_inner(app: &AppHandle, cfg: &Inbox, all: bool) -> Result<String, String> {
    let root = session_root(app, cfg)?;
    let work = root.join(format!("history-{}", random_url_safe(8)));
    fs::create_dir(&work).map_err(|_| "无法准备 Telegram 历史读取")?;
    let _cleanup = WorkDirectory(work.clone());
    let output = work.join("messages.json");
    let mut command = command(app, cfg)?;
    command
        .args(["chat", "export", "-c"])
        .arg(&cfg.username)
        .args(["--all", "--with-content", "--raw", "--filter"])
        .arg(format!("FromID == {}", cfg.user_id))
        .arg("-o")
        .arg(&output);
    if !all {
        let (c, _writer) = open_write_database(&database_path(app)?)?;
        let last = settings(&c)?.last_success;
        if last > 0 {
            command.args(["-T", "time", "-i"]).arg(format!(
                "{},{}",
                last.saturating_sub(120),
                now_timestamp()
            ));
        } else {
            command.args(["-T", "last", "-i", "100"]);
        }
    }
    wait_process(command, Duration::from_secs(1800), Some(&output)).await?;
    if fs::metadata(&output)
        .map_err(|_| "tdl 未生成历史数据")?
        .len()
        > 256 * 1024 * 1024
    {
        return Err("本轮历史数据过大，未导入，请分批补取".into());
    }
    let export: Value =
        serde_json::from_slice(&fs::read(output).map_err(|_| "无法读取 tdl 历史数据")?)
            .map_err(|_| "tdl 历史数据不完整，未推进位置")?;
    let (stats, identity) = {
        let (mut c, _writer) = open_write_database(&database_path(app)?)?;
        schema(&c)?;
        let current = inbox(&c)?;
        if current.bot_id != cfg.bot_id || current.user_id != cfg.user_id || !current.enabled {
            return Err("机器人连接已变化，本轮历史未导入，请重试".into());
        }
        import(&mut c, cfg, &export, now_timestamp())?
    };
    let (c, _writer) = open_write_database(&database_path(app)?)?;
    let mut s = settings(&c)?;
    // A real outgoing message (including the pairing message) proves the account identity.
    if identity {
        let first_login = s.last_success == 0 || s.bot_id != cfg.bot_id || s.user_id != cfg.user_id;
        s.bot_id = cfg.bot_id;
        s.user_id = cfg.user_id;
        s.last_success = now_timestamp();
        if first_login {
            s.enabled = true;
        }
        save_settings(&c, &s)?;
    }
    if s.last_success == 0 {
        return Err("未找到绑定账号发给机器人的消息，请确认登录同一账号后重试".into());
    }
    Ok(format!(
        "Telegram 历史补取结束 · 新增 {} 条 · 更新 {} 条；附件等待后台保存",
        stats.added, stats.changed
    ))
}

fn number(v: &Value, key: &str) -> i64 {
    v[key].as_i64().unwrap_or(0)
}
fn normalized(cfg: &Inbox, entry: &Value) -> Result<Option<Value>, String> {
    let raw = &entry["raw"];
    let id = number(entry, "id");
    if id <= 0 || number(raw, "ID") != id || number(raw, "Date") <= 0 {
        return Err("tdl 消息缺少有效身份或时间".into());
    }
    if raw["Out"] != true
        || raw.pointer("/FromID/UserID").and_then(Value::as_i64) != Some(cfg.user_id)
        || raw.pointer("/PeerID/UserID").and_then(Value::as_i64) != Some(cfg.bot_id)
    {
        return Ok(None);
    }
    let text = raw["Message"].as_str().ok_or("tdl 消息缺少正文")?;
    let mut m = json!({"message_id":id,"date":raw["Date"],"from":{"id":cfg.user_id,"first_name":"我"},"chat":{"id":cfg.user_id,"type":"private"},"text":text});
    let group = number(raw, "GroupedID");
    if group != 0 {
        m["media_group_id"] = json!(group.to_string());
    }
    let mut entities = vec![];
    for e in raw["Entities"].as_array().into_iter().flatten() {
        if let Some(url) = e["URL"].as_str() {
            entities.push(
                json!({"type":"text_link","url":url,"offset":e["Offset"],"length":e["Length"]}),
            );
        }
    }
    for capture in regex::Regex::new(r"https?://[^\s<>]+")
        .unwrap()
        .find_iter(text)
    {
        entities.push(json!({"type":"text_link","url":capture.as_str().trim_end_matches(['.',',','。','，',')']),"offset":0,"length":0}));
    }
    m["entities"] = json!(entities);
    let fwd = &raw["FwdFrom"];
    if fwd.is_object() && number(fwd, "Date") > 0 {
        let from = fwd["FromName"]
            .as_str()
            .filter(|s| !s.is_empty())
            .or_else(|| fwd["PostAuthor"].as_str().filter(|s| !s.is_empty()))
            .map(str::to_string)
            .unwrap_or_else(|| {
                format!(
                    "Telegram 来源 {}",
                    fwd["FromID"]["UserID"]
                        .as_i64()
                        .or_else(|| fwd["FromID"]["ChannelID"].as_i64())
                        .unwrap_or(0)
                )
            });
        m["forward_origin"] =
            json!({"type":"hidden_user","sender_user_name":from,"date":fwd["Date"]});
    }
    let photo = &raw["Media"]["Photo"];
    let doc = &raw["Media"]["Document"];
    let file = entry["file"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or("附件.bin");
    let fid = format!("tdl_{}_{}", cfg.user_id, id);
    if number(photo, "ID") != 0 {
        let size = photo["Sizes"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|p| {
                number(p, "Size").max(
                    p["Sizes"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_i64)
                        .max()
                        .unwrap_or(0),
                )
            })
            .max()
            .unwrap_or(0);
        m["photo"] =
            json!([{"file_id":fid,"file_name":file,"file_size":size,"width":1,"height":1}]);
    } else if number(doc, "ID") != 0 {
        let mime = doc["MimeType"].as_str().unwrap_or("");
        let field = if mime.starts_with("video/") {
            "video"
        } else if mime.starts_with("audio/") {
            "audio"
        } else {
            "document"
        };
        m[field] = json!({"file_id":fid,"file_name":file,"file_size":doc["Size"]});
    }
    Ok(Some(m))
}
pub(crate) fn fingerprint(m: &Value) -> String {
    let text = m
        .get("text")
        .or_else(|| m.get("caption"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let media = if let Some(p) = m["photo"]
        .as_array()
        .and_then(|a| a.iter().max_by_key(|p| number(p, "file_size")))
    {
        json!(["photo", p["file_size"]])
    } else {
        [
            "video",
            "animation",
            "video_note",
            "audio",
            "voice",
            "document",
            "sticker",
        ]
        .into_iter()
        .find_map(|field| {
            m.get(field)
                .filter(|v| v.is_object())
                .map(|v| json!([field, v["file_size"]]))
        })
        .unwrap_or(Value::Null)
    };
    format!(
        "{:x}",
        Sha256::digest(
            json!([m["date"], text, media, m["media_group_id"]])
                .to_string()
                .as_bytes()
        )
    )
}
fn bot_match(c: &Connection, cfg: &Inbox, m: &Value) -> Result<Option<(String, Value)>, String> {
    let mut q=c.prepare("SELECT item_key,message_json FROM collection_telegram_messages WHERE bot_id=?1 AND chat_id=?2 AND json_extract(message_json,'$.date')=?3").map_err(|e|e.to_string())?;
    let rows = q
        .query_map(params![cfg.bot_id, cfg.user_id, m["date"].as_i64()], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let wanted = fingerprint(m);
    let matches = rows
        .into_iter()
        .filter_map(|(key, body)| {
            serde_json::from_str::<Value>(&body)
                .ok()
                .filter(|m| fingerprint(m) == wanted)
                .map(|m| (key, m))
        })
        .collect::<Vec<_>>();
    // Ambiguous same-second copies stay separate rather than discarding an intentional duplicate.
    Ok(if matches.len() == 1 {
        matches.into_iter().next()
    } else {
        None
    })
}
pub(super) fn key_for_bot(
    c: &Connection,
    cfg: &Inbox,
    message: &Value,
    default: &str,
) -> Result<String, String> {
    schema(c)?;
    let previous:Option<String>=c.query_row("SELECT item_key FROM collection_telegram_messages WHERE bot_id=?1 AND chat_id=?2 AND message_id=?3",params![cfg.bot_id,cfg.user_id,message["message_id"].as_i64()],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    if let Some(key) = previous {
        return Ok(key);
    }
    let fingerprint = fingerprint(message);
    let mut q=c.prepare("SELECT DISTINCT item_key FROM collection_telegram_tdl_messages WHERE bot_id=?1 AND user_id=?2 AND fingerprint=?3").map_err(|e|e.to_string())?;
    let rows = q
        .query_map(params![cfg.bot_id, cfg.user_id, fingerprint], |r| {
            r.get::<_, String>(0)
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(if rows.len() == 1 {
        rows[0].clone()
    } else if rows.is_empty() {
        crate::x_bookmarks::library::deleted_counterpart(
            c,
            cfg.bot_id,
            cfg.user_id,
            message,
            "bot",
        )?
        .unwrap_or_else(|| default.into())
    } else {
        default.into()
    })
}
fn map_media(c: &Connection, cfg: &Inbox, id: i64, m: &Value) -> Result<(), String> {
    let post = normalize_message(cfg, m)?;
    let size = [
        "video",
        "animation",
        "video_note",
        "audio",
        "voice",
        "document",
        "sticker",
    ]
    .into_iter()
    .find_map(|f| {
        m.get(f)
            .filter(|v| v.is_object())
            .map(|v| number(v, "file_size"))
    })
    .unwrap_or_else(|| {
        m["photo"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|v| number(v, "file_size"))
            .max()
            .unwrap_or(0)
    });
    for asset in post.media {
        c.execute("INSERT INTO collection_telegram_tdl_media(media_url,bot_id,user_id,message_id,size) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(media_url) DO UPDATE SET bot_id=excluded.bot_id,user_id=excluded.user_id,message_id=excluded.message_id,size=excluded.size",params![asset.url,cfg.bot_id,cfg.user_id,id,size]).map_err(|e|e.to_string())?;
    }
    Ok(())
}
pub(super) fn attach_bot(
    c: &Connection,
    cfg: &Inbox,
    key: &str,
    message: &Value,
) -> Result<(), String> {
    let fingerprint = fingerprint(message);
    let id:Option<i64>=c.query_row("SELECT message_id FROM collection_telegram_tdl_messages WHERE item_key=?1 AND (fingerprint=?2 OR json_extract(message_json,'$._tdl_bot_message_id')=?3)",params![key,fingerprint,message["message_id"].as_i64()],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    if let Some(id) = id {
        map_media(c, cfg, id, message)?;
        let mut m = message.clone();
        m["_tdl_bot_message_id"] = message["message_id"].clone();
        c.execute("UPDATE collection_telegram_tdl_messages SET message_json=?4,fingerprint=?5 WHERE bot_id=?1 AND user_id=?2 AND message_id=?3",params![cfg.bot_id,cfg.user_id,id,m.to_string(),fingerprint]).map_err(|e|e.to_string())?;
    }
    Ok(())
}
pub(crate) fn messages_for_key(c: &Connection, key: &str) -> Result<Vec<Value>, String> {
    let mut q=c.prepare("SELECT message_json FROM collection_telegram_messages WHERE item_key=?1 ORDER BY message_id").map_err(|e|e.to_string())?;
    let bodies = q
        .query_map([key], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut messages = bodies
        .into_iter()
        .map(|s| serde_json::from_str::<Value>(&s).map_err(|_| "Telegram 消息数据损坏"))
        .collect::<Result<Vec<_>, _>>()?;
    let mut q=c.prepare("SELECT message_json FROM collection_telegram_tdl_messages WHERE item_key=?1 ORDER BY message_id").map_err(|e|e.to_string())?;
    let bodies = q
        .query_map([key], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    for body in bodies {
        let m: Value = serde_json::from_str(&body).map_err(|_| "Telegram 历史数据损坏")?;
        let bot_id = m["_tdl_bot_message_id"].as_i64().unwrap_or(0);
        if bot_id > 0
            && messages
                .iter()
                .any(|bot| bot["message_id"].as_i64() == Some(bot_id))
        {
            continue;
        }
        messages.push(m);
    }
    messages.sort_by_key(|m| (number(m, "date"), number(m, "message_id")));
    Ok(messages)
}
fn import(
    c: &mut Connection,
    cfg: &Inbox,
    export: &Value,
    now: i64,
) -> Result<(Stats, bool), String> {
    if number(export, "id") != cfg.bot_id {
        return Err("tdl 导出的会话不是当前机器人，未导入".into());
    }
    let entries = export["messages"]
        .as_array()
        .ok_or("tdl 导出缺少消息列表")?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let mut keys = std::collections::BTreeSet::new();
    let mut identity = false;
    for entry in entries {
        let Some(mut m) = normalized(cfg, entry)? else {
            continue;
        };
        identity = true;
        if m["text"].as_str().is_some_and(|s| s.starts_with("/start")) {
            continue;
        }
        let id = number(entry, "id");
        if crate::x_bookmarks::library::blocked_message(&tx, cfg.bot_id, cfg.user_id, id, "tdl")? {
            continue;
        }
        let fingerprint = fingerprint(&m);
        let existing:Option<(String,Option<i64>)>=tx.query_row("SELECT item_key,json_extract(message_json,'$._tdl_bot_message_id') FROM collection_telegram_tdl_messages WHERE bot_id=?1 AND user_id=?2 AND message_id=?3",params![cfg.bot_id,cfg.user_id,id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e|e.to_string())?;
        let known_bot: Option<String> = if let Some((_, Some(bot_id))) = &existing {
            tx.query_row("SELECT message_json FROM collection_telegram_messages WHERE bot_id=?1 AND chat_id=?2 AND message_id=?3",params![cfg.bot_id,cfg.user_id,bot_id],|r|r.get(0)).optional().map_err(|e|e.to_string())?
        } else {
            None
        };
        let matched = if let Some(body) = known_bot {
            let bot = serde_json::from_str(&body).map_err(|_| "Telegram 消息数据损坏")?;
            Some((existing.as_ref().unwrap().0.clone(), bot))
        } else {
            bot_match(&tx, cfg, &m)?
        };
        let deleted = if existing.is_none() && matched.is_none() {
            crate::x_bookmarks::library::deleted_counterpart(
                &tx,
                cfg.bot_id,
                cfg.user_id,
                &m,
                "tdl",
            )?
        } else {
            None
        };
        let key = existing
            .map(|v| v.0)
            .or_else(|| matched.as_ref().map(|v| v.0.clone()))
            .or(deleted)
            .unwrap_or_else(|| {
                if let Some(group) = m["media_group_id"].as_str() {
                    format!("telegram:{}:{}:album:{}", cfg.bot_id, cfg.user_id, group)
                } else {
                    format!("telegram-tdl:{}:{}:{}", cfg.bot_id, cfg.user_id, id)
                }
            });
        if crate::x_bookmarks::library::blocked(&tx, &key)? {
            continue;
        }
        if let Some((_, bot)) = matched {
            m = bot;
            m["_tdl_bot_message_id"] = m["message_id"].clone();
        }
        map_media(&tx, cfg, id, &m)?;
        tx.execute("INSERT INTO collection_telegram_tdl_messages(bot_id,user_id,message_id,item_key,fingerprint,message_json) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(bot_id,user_id,message_id) DO UPDATE SET fingerprint=excluded.fingerprint,message_json=excluded.message_json",params![cfg.bot_id,cfg.user_id,id,key,fingerprint,m.to_string()]).map_err(|e|e.to_string())?;
        keys.insert(key);
    }
    let mut stats = Stats::default();
    for key in keys {
        let messages = messages_for_key(&tx, &key)?;
        let post = normalize_album(cfg, &messages)?;
        let body = serde_json::to_string(&post).map_err(|e| e.to_string())?;
        let digest = format!("{:x}", Sha256::digest(body.as_bytes()));
        let previous: Option<String> = tx
            .query_row(
                "SELECT content_hash FROM collection_x_items WHERE item_key=?1",
                [&key],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if previous.as_deref() == Some(&digest) {
            continue;
        }
        tx.execute("INSERT INTO collection_x_items(item_key,account,post_json,content_hash,collected_at,captured_at) VALUES(?1,?2,?3,?4,?5,?5) ON CONFLICT(item_key) DO UPDATE SET post_json=excluded.post_json,content_hash=excluded.content_hash,captured_at=excluded.captured_at",params![key,cfg.bot_id.to_string(),body,digest,now*1000]).map_err(|e|e.to_string())?;
        if previous.is_none() {
            stats.added += 1
        } else {
            stats.changed += 1
        }
    }
    // Media aliases can make a previously oversized Bot API attachment downloadable even without body changes.
    tx.execute("INSERT INTO metadata(key,value) VALUES('telegram_export_pending',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[chrono::Utc::now().timestamp_nanos_opt().unwrap_or(now*1_000_000_000).to_string()]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok((stats, identity))
}
pub(crate) async fn download(app: &AppHandle, url: &str, path: &Path) -> Result<bool, String> {
    let cfg = paired(app)?;
    let row: Option<(i64, i64, i64, i64)> = {
        let (c, _writer) = open_write_database(&database_path(app)?)?;
        schema(&c)?;
        c.query_row("SELECT bot_id,user_id,message_id,size FROM collection_telegram_tdl_media WHERE media_url=?1",[url],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(|e|e.to_string())?
    };
    let Some((bot, user, id, size)) = row else {
        return Ok(false);
    };
    if bot != cfg.bot_id || user != cfg.user_id {
        return Err("附件所属 Telegram 账号与当前连接不一致".into());
    }
    let authenticated = {
        let (c, _writer) = open_write_database(&database_path(app)?)?;
        let s = settings(&c)?;
        s.last_success > 0 && s.bot_id == cfg.bot_id && s.user_id == cfg.user_id
    };
    if !authenticated {
        return Ok(false);
    }
    let _guard = LOCK
        .try_lock()
        .map_err(|_| "tdl 正在补历史，附件将在下一轮重试")?;
    CANCEL.store(false, Ordering::Relaxed);
    progress("download", "正在通过 tdl 下载 Telegram 附件", true);
    let result: Result<bool, String> = async {
        // A staging directory beside the final asset avoids copying a multi-GB file or changing destination mid-run.
        let parent = path.parent().ok_or("附件目录不可用")?;
        // Fetch this one message's media identity before letting --continue use
        // retained pieces. Message IDs and file length alone don't prove a revision.
        let check = parent.join(format!("tdl-check-{}", random_url_safe(10)));
        fs::create_dir(&check).map_err(|_| "无法准备附件核验")?;
        let _check_cleanup = WorkDirectory(check.clone());
        let metadata = check.join("message.json");
        let mut verify = command(app, &cfg)?;
        verify
            .args(["chat", "export", "-c"])
            .arg(&cfg.username)
            .args(["-T", "id", "-i"])
            .arg(format!("{id},{}", id.saturating_add(1)))
            .args(["--all", "--with-content", "--raw", "--filter"])
            .arg(format!("ID == {id} && FromID == {}", cfg.user_id))
            .arg("-o")
            .arg(&metadata);
        wait_process(verify, Duration::from_secs(60), Some(&metadata)).await?;
        if fs::metadata(&metadata)
            .map_err(|_| "附件元数据未返回")?
            .len()
            > 1024 * 1024
        {
            return Err("附件元数据过大，未开始下载".into());
        }
        let current: Value =
            serde_json::from_slice(&fs::read(metadata).map_err(|_| "附件元数据读取失败")?)
                .map_err(|_| "附件元数据无效")?;
        let (revision, remote_size) = download_revision(&current, bot, user, id)?;
        if size > 0 && remote_size != size as u64 {
            return Err("Telegram 原附件已变化，请先同步来源".into());
        }
        let partial = crate::partial_download::Partial::open(
            path,
            &format!("tdl:{bot}:{user}:{id}:{url}:{revision}"),
            Some(remote_size),
        )?;
        partial.budget(
            remote_size.saturating_sub(
                fs::metadata(partial.root.join(format!("{id}.tmp")))
                    .map(|m| m.len())
                    .unwrap_or(0),
            ),
        )?;
        let work = partial.root.clone();
        let input = work.join("input.json");
        fs::write(
            &input,
            json!({"id":bot,"messages":[{"id":id,"type":"message"}]}).to_string(),
        )
        .map_err(|_| "无法准备 tdl 下载任务")?;
        let mut command = command(app, &cfg)?;
        command
            .args(["dl", "-f"])
            .arg(&input)
            .arg("-d")
            .arg(&work)
            .args([
                "--template",
                "{{ .MessageID }}",
                "--skip-same",
                "--continue",
                "--threads",
                "4",
                "--limit",
                "1",
            ]);
        let file = work.join(id.to_string());
        let result = wait_process(
            command,
            Duration::from_secs(14400),
            Some(&work.join(format!("{id}.tmp"))),
        )
        .await;
        result?;
        let actual =
            fs::metadata(&file).map_err(|_| "tdl 未生成完整附件（消息可能已删除），保留原链接")?;
        if actual.len() != remote_size {
            return Err("tdl 附件大小不完整，未标为已下载".into());
        }
        fs::hard_link(&file, path).map_err(|_| "无法保存 tdl 附件，请检查文件夹和可用空间")?;
        partial.discard()?;
        Ok(true)
    }
    .await;
    progress(
        "",
        result
            .as_ref()
            .map(|_| "Telegram 附件已保存")
            .unwrap_or_else(|e| e),
        false,
    );
    result
}

fn download_revision(
    export: &Value,
    bot: i64,
    user: i64,
    id: i64,
) -> Result<(String, u64), String> {
    if number(export, "id") != bot {
        return Err("Telegram 附件会话不匹配".into());
    }
    let message = export["messages"]
        .as_array()
        .and_then(|messages| messages.iter().find(|m| number(m, "id") == id))
        .ok_or("Telegram 原消息已移除，未复用分片")?;
    let raw = &message["raw"];
    if number(&raw["FromID"], "UserID") != user {
        return Err("Telegram 附件账号不匹配".into());
    }
    let doc = &raw["Media"]["Document"];
    let photo = &raw["Media"]["Photo"];
    let (identity, size) = if number(doc, "ID") != 0 {
        (
            json!(["document", doc["ID"], doc["Size"], doc["MimeType"]]),
            number(doc, "Size") as u64,
        )
    } else if number(photo, "ID") != 0 {
        let size = photo["Sizes"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|v| {
                number(v, "Size").max(
                    v["Sizes"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_i64)
                        .max()
                        .unwrap_or(0),
                )
            })
            .max()
            .unwrap_or(0);
        (json!(["photo", photo["ID"], photo["Sizes"]]), size as u64)
    } else {
        return Err("Telegram 原附件身份无法核验，未复用分片".into());
    };
    if size == 0 {
        return Err("Telegram 原附件长度无法核验".into());
    }
    Ok((
        format!("{:x}", Sha256::digest(identity.to_string().as_bytes())),
        size,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn network_tdl_resume_identity_changes_with_file_revision_not_message_title() {
        let mut export = json!({"id":7,"messages":[{"id":9,"raw":{"FromID":{"UserID":42},"Media":{"Document":{"ID":99,"Size":10,"MimeType":"application/pdf"}},"Message":"old title"}}]});
        let first = download_revision(&export, 7, 42, 9).unwrap();
        export["messages"][0]["raw"]["Message"] = json!("new title");
        assert_eq!(download_revision(&export, 7, 42, 9).unwrap(), first);
        export["messages"][0]["raw"]["Media"]["Document"]["ID"] = json!(100);
        assert_ne!(download_revision(&export, 7, 42, 9).unwrap(), first);
        assert!(download_revision(&export, 7, 43, 9).is_err());
    }
    #[cfg(windows)]
    #[tokio::test]
    async fn network_tdl_process_timeout_preserves_same_owned_staging_for_resume() {
        let f = crate::network_traffic_tests::Fixture::new(PROVIDER_CRAFT);
        let destination = f.root.join("complete.bin");
        let stage = crate::partial_download::Partial::open(
            &destination,
            "tdl:account:message:revision",
            Some(10),
        )
        .unwrap();
        let piece = stage.root.join("9.tmp");
        CANCEL.store(false, Ordering::Relaxed);
        let mut command = Command::new("powershell.exe");
        command
            .args(["-NoProfile", "-NonInteractive", "-Command"])
            .arg(format!(
                "[IO.File]::WriteAllText({},'12345'); Start-Sleep -Seconds 10",
                ps_literal(&piece)
            ));
        assert!(wait_process(command, Duration::from_secs(2), Some(&piece))
            .await
            .is_err());
        let original = stage.root.clone();
        drop(stage);
        let resumed = crate::partial_download::Partial::open(
            &destination,
            "tdl:account:message:revision",
            Some(10),
        )
        .unwrap();
        assert_eq!(resumed.root, original);
        assert_eq!(fs::read(&piece).unwrap(), b"12345");
        let mut command = Command::new("powershell.exe");
        command
            .args(["-NoProfile", "-NonInteractive", "-Command"])
            .arg(format!(
                "[IO.File]::AppendAllText({},'67890')",
                ps_literal(&piece)
            ));
        wait_process(command, Duration::from_secs(10), Some(&piece))
            .await
            .unwrap();
        assert_eq!(fs::metadata(&piece).unwrap().len(), 10);
        fs::hard_link(&piece, &destination).unwrap();
        resumed.discard().unwrap();
        assert_eq!(fs::read(destination).unwrap(), b"1234567890");
        assert!(!original.exists());
    }
    fn cfg() -> Inbox {
        Inbox {
            bot_id: 7,
            user_id: 42,
            username: "test_bot".into(),
            enabled: true,
            ..Default::default()
        }
    }
    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);")
            .unwrap();
        super::super::schema(&c).unwrap();
        c
    }
    fn message(id: i64, text: &str) -> Value {
        json!({"id":id,"type":"message","file":"","date":100,"text":text,"raw":{"ID":id,"Date":100,"Out":true,"FromID":{"UserID":42},"PeerID":{"UserID":7},"Message":text}})
    }
    fn export(entries: Vec<Value>) -> Value {
        json!({"id":7,"messages":entries})
    }
    fn bot_message(id: i64, date: i64, text: &str) -> Value {
        json!({"message_id":id,"date":date,"chat":{"id":42,"type":"private"},"from":{"id":42,"first_name":"Collector"},"text":text})
    }
    fn delete_collection(c: &Connection, key: &str) {
        c.execute("INSERT INTO collection_lifecycle(item_key,state) VALUES(?1,'deleting') ON CONFLICT(item_key) DO UPDATE SET state='deleting'",[key]).unwrap();
        crate::x_bookmarks::library::remember_messages(c, key).unwrap();
        crate::x_bookmarks::library::purge_body(c, key).unwrap();
    }
    #[test]
    fn deleted_bot_content_cannot_return_with_a_different_tdl_message_id() {
        let mut c = db();
        let mut settings = cfg();
        super::super::persist_updates(
            &mut c,
            &mut settings,
            &[json!({"update_id":1,"message":bot_message(19,100,"old content")})],
            200,
        )
        .unwrap();
        let key: String = c
            .query_row(
                "SELECT item_key FROM collection_telegram_messages",
                [],
                |r| r.get(0),
            )
            .unwrap();
        delete_collection(&c, &key);
        let (stats, _) = import(
            &mut c,
            &settings,
            &export(vec![message(900, "old content")]),
            300,
        )
        .unwrap();
        assert_eq!(stats.added, 0);
        assert_eq!(
            c.query_row("SELECT count(*) FROM collection_x_items", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        // A new message in the same API remains an intentional new collection.
        let stats = super::super::persist_updates(
            &mut c,
            &mut settings,
            &[json!({"update_id":2,"message":bot_message(20,100,"old content")})],
            400,
        )
        .unwrap();
        assert_eq!(stats.added, 1);
    }
    #[test]
    fn deleted_history_content_cannot_return_in_later_bot_delivery() {
        let mut c = db();
        let mut settings = cfg();
        import(
            &mut c,
            &settings,
            &export(vec![message(9, "old content")]),
            200,
        )
        .unwrap();
        let key: String = c
            .query_row(
                "SELECT item_key FROM collection_telegram_tdl_messages",
                [],
                |r| r.get(0),
            )
            .unwrap();
        delete_collection(&c, &key);
        let stats = super::super::persist_updates(
            &mut c,
            &mut settings,
            &[json!({"update_id":1,"message":bot_message(500,100,"old content")})],
            300,
        )
        .unwrap();
        assert_eq!(stats.added, 0);
        assert_eq!(
            c.query_row("SELECT count(*) FROM collection_x_items", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        let stats = super::super::persist_updates(
            &mut c,
            &mut settings,
            &[json!({"update_id":2,"message":bot_message(501,101,"old content")})],
            400,
        )
        .unwrap();
        assert_eq!(stats.added, 1);
    }
    #[test]
    fn rejects_wrong_chat_account_and_incoming_bot_messages() {
        let mut c = db();
        let mut wrong = message(8, "wrong");
        wrong["raw"]["FromID"]["UserID"] = json!(999);
        let mut incoming = message(9, "bot response");
        incoming["raw"]["Out"] = json!(false);
        let (stats, identity) =
            import(&mut c, &cfg(), &export(vec![wrong, incoming]), 200).unwrap();
        assert_eq!(stats.added, 0);
        assert!(!identity);
        let wrong_chat = json!({"id":999,"messages":[message(1,"wrong chat")]});
        assert!(import(&mut c, &cfg(), &wrong_chat, 200).is_err());
        assert_eq!(
            c.query_row("SELECT count(*) FROM collection_x_items", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn relogin_requires_new_identity_verification_and_preserves_proxy() {
        let c = db();
        save_settings(
            &c,
            &Settings {
                enabled: true,
                bot_id: 7,
                user_id: 42,
                last_success: 100,
                proxy: "socks5://127.0.0.1:7890".into(),
                ..Default::default()
            },
        )
        .unwrap();
        invalidate_identity(&c).unwrap();
        let settings = settings(&c).unwrap();
        assert!(!settings.enabled);
        assert_eq!(settings.last_success, 0);
        assert_eq!(settings.proxy, "socks5://127.0.0.1:7890");
    }
    #[test]
    fn uses_the_existing_system_proxy_without_overriding_explicit_tdl_settings() {
        let system = Some("http://127.0.0.1:7897".into());
        assert_eq!(selected_proxy("", system.clone()), "http://127.0.0.1:7897");
        assert_eq!(
            selected_proxy("socks5://127.0.0.1:1080", system),
            "socks5://127.0.0.1:1080"
        );
        assert!(selected_proxy("", Some("http://user:secret@proxy:80".into())).is_empty());
        assert!(selected_proxy("", None).is_empty());
    }
    #[test]
    fn history_is_idempotent_preserves_properties_and_merges_later_bot_delivery() {
        let mut c = db();
        let settings = cfg();
        let e = export(vec![message(100, "历史笔记 https://example.com/article")]);
        let (first, identity) = import(&mut c, &settings, &e, 200).unwrap();
        assert!(identity);
        assert_eq!(first.added, 1);
        let key = "telegram-tdl:7:42:100";
        c.execute(
            "UPDATE collection_x_items SET read_at=999,read_version=4 WHERE item_key=?1",
            [key],
        )
        .unwrap();
        c.execute(
            "INSERT INTO collection_x_properties VALUES(?1,'read','[\"保留\"]')",
            [key],
        )
        .unwrap();
        let (second, _) = import(&mut c, &settings, &e, 300).unwrap();
        assert_eq!(second.added + second.changed, 0);
        let mut cfg = settings;
        let bot = json!({"update_id":1,"message":{"message_id":5,"date":100,"from":{"id":42,"first_name":"Owner"},"chat":{"id":42,"type":"private"},"text":"历史笔记 https://example.com/article"}});
        persist_updates(&mut c, &mut cfg, &[bot], 400).unwrap();
        let row: (i64, i64) = c
            .query_row(
                "SELECT collected_at,read_at FROM collection_x_items WHERE item_key=?1",
                [key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(row, (200000, 999));
        assert_eq!(
            c.query_row(
                "SELECT status,tags FROM collection_x_properties WHERE item_key=?1",
                [key],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            )
            .unwrap(),
            ("read".into(), "[\"保留\"]".into())
        );
        assert_eq!(
            c.query_row("SELECT count(*) FROM collection_x_items", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        let item: Post = serde_json::from_str(
            &c.query_row(
                "SELECT post_json FROM collection_x_items WHERE item_key=?1",
                [key],
                |r| r.get::<_, String>(0),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(item.source, "telegram");
    }
    #[test]
    fn bot_history_reconciliation_uses_identity_not_mtproto_message_number() {
        let mut c = db();
        let mut cfg = cfg();
        persist_updates(&mut c,&mut cfg,&[json!({"update_id":1,"message":{"message_id":3,"date":100,"from":{"id":42,"first_name":"Owner"},"chat":{"id":42,"type":"private"},"text":"same content","document":{"file_id":"BOTFILE","file_name":"report.pdf","file_size":30000000}}})],200).unwrap();
        let mut mt = message(987, "same content");
        mt["file"] = json!("report.pdf");
        mt["raw"]["Media"] =
            json!({"Document":{"ID":123,"Size":30000000,"MimeType":"application/pdf"}});
        let (stats, _) = import(&mut c, &cfg, &export(vec![mt]), 300).unwrap();
        assert_eq!(stats.added, 0);
        let key: String = c
            .query_row(
                "SELECT item_key FROM collection_telegram_tdl_messages",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(key, "telegram:7:42:3");
        let (id,size):(i64,i64)=c.query_row("SELECT message_id,size FROM collection_telegram_tdl_media WHERE media_url LIKE '%BOTFILE%'",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert_eq!((id, size), (987, 30000000));
        assert_eq!(
            c.query_row("SELECT count(*) FROM collection_x_items", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    #[test]
    fn albums_text_links_and_forwarded_origin_share_one_page() {
        let mut c = db();
        let cfg = cfg();
        let mut a = message(1, "相册说明");
        let mut b = message(2, "");
        for m in [&mut a, &mut b] {
            m["raw"]["GroupedID"] = json!(77);
            m["file"] = json!("photo.jpg");
            m["raw"]["Media"] = json!({"Photo":{"ID":m["id"],"Sizes":[{"Size":30}]}});
        }
        a["raw"]["FwdFrom"] = json!({"Date":90,"FromName":"原作者"});
        a["raw"]["Entities"] = json!([{"URL":"https://example.com","Offset":0,"Length":2}]);
        let (stats, _) = import(&mut c, &cfg, &export(vec![b, a]), 200).unwrap();
        assert_eq!(stats.added, 1);
        let post: Post = serde_json::from_str(
            &c.query_row("SELECT post_json FROM collection_x_items", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
        )
        .unwrap();
        assert_eq!(post.media.len(), 2);
        assert_eq!(post.author_name, "原作者");
        assert!(post.links.contains(&"https://example.com".to_string()));
        assert!(post.text.starts_with("相册说明"));
    }
    #[test]
    fn a_partial_bot_album_and_later_edit_preserve_history_members() {
        let mut c = db();
        let mut cfg = cfg();
        let (mut a, mut b) = (message(101, "原相册"), message(102, ""));
        for m in [&mut a, &mut b] {
            m["raw"]["GroupedID"] = json!(77);
            m["file"] = json!("photo.jpg");
            m["raw"]["Media"] = json!({"Photo":{"ID":m["id"],"Sizes":[{"Size":30}]}});
        }
        let original = export(vec![a, b]);
        import(&mut c, &cfg, &original, 200).unwrap();
        let mut bot = json!({"update_id":1,"message":{"message_id":5,"date":100,"media_group_id":"77","caption":"原相册","from":{"id":42,"first_name":"Owner"},"chat":{"id":42,"type":"private"},"photo":[{"file_id":"ALBUMFILE","file_size":30}]}});
        persist_updates(&mut c, &mut cfg, &[bot.clone()], 300).unwrap();
        bot["update_id"] = json!(2);
        bot["edited_message"] = bot["message"].clone();
        bot.as_object_mut().unwrap().remove("message");
        bot["edited_message"]["caption"] = json!("最新相册");
        persist_updates(&mut c, &mut cfg, &[bot], 400).unwrap();
        import(&mut c, &cfg, &original, 500).unwrap();
        assert_eq!(
            c.query_row("SELECT count(*) FROM collection_x_items", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        let post: Post = serde_json::from_str(
            &c.query_row("SELECT post_json FROM collection_x_items", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
        )
        .unwrap();
        assert_eq!(post.media.len(), 2);
        assert!(post.text.starts_with("最新相册"));
    }
    #[test]
    fn malformed_batch_rolls_back_and_pairing_command_is_not_archived() {
        let mut c = db();
        let cfg = cfg();
        let mut bad = message(2, "broken");
        bad["raw"]["ID"] = json!(3);
        assert!(import(&mut c, &cfg, &export(vec![message(1, "good"), bad]), 200).is_err());
        assert_eq!(
            c.query_row("SELECT count(*) FROM collection_x_items", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        let (stats, identity) = import(
            &mut c,
            &cfg,
            &export(vec![message(5, "/start hub_pair")]),
            200,
        )
        .unwrap();
        assert!(identity);
        assert_eq!(stats.added, 0);
    }
    #[tokio::test]
    async fn process_failure_and_cancellation_are_not_success() {
        #[cfg(windows)]
        {
            CANCEL.store(false, Ordering::Relaxed);
            let mut failed = Command::new("cmd.exe");
            failed.args(["/c", "exit", "7"]);
            assert!(wait_process(failed, Duration::from_secs(10), None)
                .await
                .is_err());
            CANCEL.store(true, Ordering::Relaxed);
            let mut cancelled = Command::new("cmd.exe");
            cancelled.args(["/c", "exit", "0"]);
            assert!(wait_process(cancelled, Duration::from_secs(10), None)
                .await
                .unwrap_err()
                .contains("暂停"));
            CANCEL.store(false, Ordering::Relaxed);
        }
    }
}
