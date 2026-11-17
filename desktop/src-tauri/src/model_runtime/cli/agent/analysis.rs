//! Offline Python execution under MXC, without inherited credentials.
use super::*;
fn workspace_limit(directory: &Path) -> Result<(), String> {
    let mut stack = vec![(directory.to_path_buf(), 0usize)];
    let mut count = 0usize;
    let mut total = 0u64;
    let output = directory.join("output");
    let mut output_bytes = 0u64;
    while let Some((dir, depth)) = stack.pop() {
        if depth > 16 {
            return Err("分析目录层级超过容量".into());
        }
        for entry in std::fs::read_dir(&dir).map_err(|_| "无法核对分析目录容量")? {
            let entry = entry.map_err(|_| "无法核对分析文件容量")?;
            count += 1;
            if count > 4096 {
                return Err("分析临时文件超过容量".into());
            }
            let path = entry.path();
            crate::craft_backup::reject_links(&path)?;
            let meta = match entry.metadata() {
                Ok(v) => v,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return Err("无法核对分析文件大小".into()),
            };
            if meta.is_dir() {
                stack.push((path, depth + 1));
            } else {
                total = total.saturating_add(meta.len());
                if path.starts_with(&output) {
                    output_bytes = output_bytes.saturating_add(meta.len());
                }
                if total > 192 * 1024 * 1024 || output_bytes > 50 * 1024 * 1024 {
                    return Err("分析文件超过磁盘容量，已停止执行，未接受超限产物".into());
                }
            }
        }
    }
    Ok(())
}
pub(crate) fn run(directory: &Path, runtime: &Path, control: &Control) -> Result<Value, String> {
    if !cfg!(windows) {
        return Err("当前平台没有受控Python执行端".into());
    }
    control.check()?;
    let home = directory.join("home");
    std::fs::create_dir(&home).map_err(|_| "无法创建分析策略目录")?;
    let runtime = runtime.canonicalize().map_err(|_| "分析运行时不存在")?;
    let normal = runtime
        .to_string_lossy()
        .trim_start_matches(r"\\?\")
        .replace('\\', "/");
    if normal.contains('\'') {
        return Err("分析运行时路径无效".into());
    }
    let mut config=format!("default_permissions = 'hub-analysis'\n[windows]\nsandbox = 'mxc'\n[permissions.hub-analysis.filesystem]\n':minimal' = 'read'\n':workspace_roots' = 'write'\n'{normal}' = 'read'\n");
    for file in [
        directory.join("inputs"),
        directory.join("previous"),
        directory.join("input.json"),
        directory.join("analysis.py"),
    ] {
        let path = file.to_string_lossy().replace('\\', "/");
        if path.contains('\'') {
            return Err("分析路径无效".into());
        }
        config.push_str(&format!("'{path}' = 'read'\n"));
    }
    let font =
        PathBuf::from(std::env::var_os("SystemRoot").ok_or("无法定位系统字体")?).join("Fonts");
    let fontpath = font.to_string_lossy().replace('\\', "/");
    if !fontpath.contains('\'') {
        config.push_str(&format!("'{fontpath}' = 'read'\n"));
    }
    config.push_str("[permissions.hub-analysis.network]\nenabled = false\n");
    std::fs::write(home.join("config.toml"), config).map_err(|_| "无法保存分析策略")?;
    let bytes = b"{}".to_vec();
    let identity = format!("{:x}", sha2::Sha256::digest(&bytes));
    let mut process = spawn(
        directory,
        &identity,
        authentication::Prepared {
            bytes,
            identity: identity.clone(),
        },
        "",
        "",
        false,
        control,
        Default::default(),
    )?;
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
            process.group.as_ref().ok_or("分析进程保护缺失")?.0,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as _,
            std::mem::size_of_val(&limits) as u32,
        )
        .map_err(|_| "无法限制分析资源")?;
    }
    process.rpc("initialize","initialize",json!({"clientInfo":{"name":"hub_analysis","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}}),control)?;
    process.send(json!({"method":"initialized"}))?;
    let mut env = serde_json::Map::new();
    for (key, _) in std::env::vars_os() {
        env.insert(key.to_string_lossy().into_owned(), Value::Null);
    }
    for key in ["SystemRoot", "WINDIR", "SystemDrive", "LOCALAPPDATA"] {
        if let Some(value) = std::env::var_os(key) {
            env.insert(key.into(), json!(value.to_string_lossy()));
        }
    }
    env.insert("TEMP".into(), json!(directory));
    env.insert("TMP".into(), json!(directory));
    env.insert("CODEX_HOME".into(), json!(home));
    env.insert("MPLCONFIGDIR".into(), json!(directory.join("matplotlib")));
    env.insert("MPLBACKEND".into(), json!("Agg"));
    env.insert("OPENBLAS_NUM_THREADS".into(), json!("1"));
    let inherited = control.clone();
    let owned_dir = directory.to_owned();
    let execution_control = control.clone().guarded(move || {
        inherited.check()?;
        workspace_limit(&owned_dir)
    });
    // command/exec waits for execution, unlike the short initialization RPCs.
    // Keep the 120-second process limit and allow its termination response to arrive.
    process.rpc_timeout = Duration::from_secs(130);
    let result=process.rpc("analysis","command/exec",json!({"command":[runtime.join("python.exe"),"-I","-X","utf8","-B","analysis.py"],"cwd":directory,"permissionProfile":"hub-analysis","env":env,"timeoutMs":120000,"outputBytesCap":65536}),&execution_control)?;
    control.check()?;
    let stdout = result["stdout"].as_str().ok_or("分析输出缺失")?;
    let stderr = result["stderr"].as_str().unwrap_or("");
    if result["exitCode"] != 0 {
        return Err(format!(
            "隔离分析失败或超时：{}",
            stderr.chars().take(1200).collect::<String>()
        ));
    }
    if stdout.len().saturating_add(stderr.len()) >= 65536 {
        return Err("分析输出达到容量，拒绝截断结果".into());
    }
    let output: Value = serde_json::from_str(stdout.trim())
        .map_err(|_| "分析必须输出完整JSON；文件请写入output目录")?;
    Ok(json!({"backend":"codex-mxc-python","output":output,"stderr":stderr,"exitCode":0}))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_disk_monitor_refuses_oversized_outputs() {
        let dir =
            std::env::temp_dir().join(format!("hub-analysis-disk-{}", crate::random_url_safe(12)));
        std::fs::create_dir_all(dir.join("output")).unwrap();
        let _cleanup = super::super::JobDir(dir.clone());
        std::fs::write(dir.join("output/a.csv"), b"a\n1\n").unwrap();
        workspace_limit(&dir).unwrap();
        std::fs::File::create(dir.join("output/b.csv"))
            .unwrap()
            .set_len(50 * 1024 * 1024 + 1)
            .unwrap();
        assert!(workspace_limit(&dir).unwrap_err().contains("磁盘容量"));
    }
}
