//! A separate credential-free MXC process; never changes the Agent's tool sandbox.
use super::*;

pub(crate) fn run(material: &Value, script: &str, control: &Control) -> Result<Value, String> {
    if !cfg!(windows) {
        return Err("当前平台未接入受控计算".into());
    }
    control.check()?;
    let mut input = vec![0xef, 0xbb, 0xbf];
    input.extend(serde_json::to_vec(material).map_err(|_| "计算材料编码失败")?);
    if input.len() > 131072 || script.is_empty() || script.len() > 16000 {
        return Err("计算输入或脚本超过容量".into());
    }
    let directory = std::env::temp_dir().join(format!(
        "hub-codex-suite-compute-{}",
        crate::random_url_safe(12)
    ));
    std::fs::create_dir(&directory).map_err(|_| "无法创建隔离计算目录")?;
    let _cleanup = super::super::JobDir(directory.clone());
    let home = directory.join("home");
    let workspace = directory.join("workspace");
    std::fs::create_dir(&home)
        .and_then(|_| std::fs::create_dir(&workspace))
        .map_err(|_| "无法准备计算目录")?;
    let input_path = workspace.join("input.json");
    std::fs::write(&input_path, &input).map_err(|_| "无法准备计算材料")?;
    let path = input_path.to_string_lossy().replace('\\', "/");
    let config=format!("default_permissions = 'hub-compute'\n[windows]\nsandbox = 'mxc'\n[permissions.hub-compute.filesystem]\n':minimal' = 'read'\n':workspace_roots' = 'write'\n'{path}' = 'read'\n[permissions.hub-compute.network]\nenabled = false\n");
    std::fs::write(home.join("config.toml"), config).map_err(|_| "无法准备计算策略")?;
    let mut process = spawn_isolated_command(&directory, "hub-compute", control)?;
    #[cfg(windows)]
    unsafe {
        use windows::Win32::System::JobObjects::*;
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            | JOB_OBJECT_LIMIT_JOB_MEMORY
            | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
        limits.JobMemoryLimit = 2 * 1024 * 1024 * 1024;
        limits.BasicLimitInformation.ActiveProcessLimit = 8;
        SetInformationJobObject(
            process.group.as_ref().ok_or("计算进程保护缺失")?.0,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as _,
            std::mem::size_of_val(&limits) as u32,
        )
        .map_err(|_| "无法限制计算资源")?;
    }
    let env = isolated_command_env(&workspace, &home)?;
    let shell = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .ok_or("无法定位系统运行时")?
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let result=process.rpc("compute","command/exec",json!({"command":[shell,"-NoProfile","-NonInteractive","-Command",format!("$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding\n{script}")],"cwd":workspace,"permissionProfile":"hub-compute","env":env,"timeoutMs":20000,"outputBytesCap":16384}),control)?;
    control.check()?;
    if std::fs::read(&input_path).map_err(|_| "计算输入已损坏")? != input {
        return Err("计算输入被修改，拒绝结果".into());
    }
    if result["exitCode"] != 0 {
        return Err("隔离计算失败或超时，未接受结果".into());
    }
    let stdout = result["stdout"].as_str().ok_or("计算输出缺失")?;
    if stdout.len() >= 16384 || result["stderr"].as_str().unwrap_or("").len() >= 16384 {
        return Err("计算输出达到容量，拒绝截断结果".into());
    }
    let output: Value = serde_json::from_str(stdout.trim_start_matches('\u{feff}'))
        .map_err(|_| "计算必须输出完整JSON")?;
    Ok(
        json!({"output":output,"backend":"codex-mxc","inputSha256":format!("{:x}",sha2::Sha256::digest(input)),"scriptSha256":format!("{:x}",sha2::Sha256::digest(script.as_bytes())),"source":"authorized excerpt copies; computed values are not quotations","businessWrites":false}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cn07b_rejects_oversize_and_cancelled_before_process() {
        assert!(run(&json!("x".repeat(131073)), "{}", &Control::default()).is_err());
        assert!(run(&Value::Null, "", &Control::default()).is_err());
        let control = Control::default();
        control.cancel();
        assert!(run(&json!([]), "{}", &control).is_err());
    }
    #[test]
    #[ignore = "explicit local MXC production entry; no model or original library"]
    fn cn07b_installed_mxc_compute_and_readonly_input() {
        let path = std::env::var("HUB_CN07B_REPORT").expect("explicit report path");
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(Path::new(&path).with_extension("started"))
            .unwrap();
        let material = json!({"values":[1,2,3,4,100],"label":"中文"});
        let result=run(&material,"$data=Get-Content input.json -Raw|ConvertFrom-Json;$v=@($data.values|Sort-Object);$blocked=$false;try{[IO.File]::WriteAllText((Join-Path (Get-Location) 'input.json'),'BAD')}catch{$blocked=$true};@{p50=$v[2];p95=$v[4];label=$data.label;inputWriteBlocked=$blocked}|ConvertTo-Json -Compress",&Control::bounded(Duration::from_secs(30)));
        std::fs::write(
            path,
            serde_json::to_vec_pretty(&json!({"result":result})).unwrap(),
        )
        .unwrap();
        let v = result.unwrap();
        assert_eq!(v["output"]["p50"], 3);
        assert_eq!(v["output"]["p95"], 100);
        assert_eq!(v["output"]["label"], "中文");
        assert_eq!(v["output"]["inputWriteBlocked"], true);
    }
    #[test]
    #[ignore = "explicit local MXC cancellation; no model"]
    fn cn07b_installed_compute_cancellation() {
        let control = Control::bounded(Duration::from_secs(15));
        let cancel = control.clone();
        let worker = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(3));
            cancel.cancel();
        });
        let start = Instant::now();
        let result = run(&json!([]), "Start-Sleep -Seconds 15; '{}'", &control);
        let elapsed = start.elapsed();
        worker.join().unwrap();
        assert_eq!(result.unwrap_err(), "调查已中断，可以稍后继续。");
        assert!(elapsed >= Duration::from_secs(3) && elapsed < Duration::from_secs(10));
    }
}
