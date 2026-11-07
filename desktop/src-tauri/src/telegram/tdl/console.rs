//! UTF-8 console bootstrap. A gated process is assigned to a private job before
//! it may launch tdl; cancellation closes the entire owned process group.
use super::*;
use windows::Win32::{
    Foundation::{CloseHandle, HANDLE},
    System::{JobObjects::*, Threading::*},
};
pub(super) struct Job(HANDLE);
unsafe impl Send for Job {}
impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}
pub(super) fn attach(pid: u32) -> Result<Job, String> {
    unsafe {
        let job = Job(CreateJobObjectW(None, None).map_err(|_| "无法保护登录进程")?);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as _,
            std::mem::size_of_val(&limits) as u32,
        )
        .map_err(|_| "无法设置登录进程的退出保护")?;
        let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid)
            .map_err(|_| "无法访问登录进程")?;
        let result = AssignProcessToJobObject(job.0, process);
        let _ = CloseHandle(process);
        result.map_err(|_| "无法隔离登录进程，请选择验证码登录")?;
        Ok(job)
    }
}
pub(super) fn prepare(command: &Command) -> Result<(Command, WorkDirectory, PathBuf), String> {
    let base = command
        .get_current_dir()
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let root = base.join(format!("console-{}", random_url_safe(8)));
    fs::create_dir(&root).map_err(|_| "无法准备登录控制台")?;
    let root = fs::canonicalize(root).map_err(|_| "无法访问登录控制台")?;
    let cleanup = WorkDirectory(root.clone());
    let config = root.join("command.json");
    let gate = root.join("start");
    let script = root.join("console.ps1");
    let json = json!({"program":command.get_program().to_string_lossy(),"args":command.get_args().map(|a|a.to_string_lossy()).collect::<Vec<_>>()});
    fs::write(
        &config,
        serde_json::to_vec(&json).map_err(|_| "无法准备登录参数")?,
    )
    .map_err(|_| "无法保存登录参数")?;
    let body = r#"param([string]$ConfigPath,[string]$GatePath)
$ErrorActionPreference='Stop'
$until=[DateTime]::UtcNow.AddSeconds(10)
while(-not [IO.File]::Exists($GatePath)){if([DateTime]::UtcNow -gt $until){exit 9}; Start-Sleep -Milliseconds 10}
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$cfg=[IO.File]::ReadAllText($ConfigPath,[Text.Encoding]::UTF8)|ConvertFrom-Json
$toolArgs=@($cfg.args|ForEach-Object{[string]$_})
& ([string]$cfg.program) @toolArgs
exit $LASTEXITCODE
"#;
    fs::write(script.clone(), body).map_err(|_| "无法准备 UTF-8 登录窗口")?;
    let mut bootstrap = Command::new("powershell.exe");
    bootstrap
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(script)
        .arg(config)
        .arg(&gate)
        .current_dir(&base);
    for (key, value) in command.get_envs() {
        if let Some(value) = value {
            bootstrap.env(key, value);
        } else {
            bootstrap.env_remove(key);
        }
    }
    Ok((bootstrap, cleanup, gate))
}
