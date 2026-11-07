//! One owner for packaged runtime resolution, integrity, preparation and repair.
//! Everything here is derived. Markdown and the Hub database are never touched.
use super::*;
use backend::RuntimeConfig;
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{Read, Write},
    process::{Command, Stdio},
    sync::OnceLock,
    time::{Duration, Instant},
};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Descriptor {
    schema_version: u32,
    platform: String,
    python: String,
    basic_memory: String,
    id: String,
    archive_sha256: String,
    archive_bytes: u64,
    expanded_bytes: u64,
    files: usize,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema_version: u32,
    platform: String,
    python: String,
    basic_memory: String,
    model: String,
    model_snapshot: String,
    files: BTreeMap<String, FileEntry>,
    expanded_bytes: u64,
}
#[derive(Deserialize)]
struct FileEntry {
    bytes: u64,
    sha256: String,
}
static VERIFIED: OnceLock<Mutex<BTreeSet<PathBuf>>> = OnceLock::new();
static INSTALL: OnceLock<Mutex<()>> = OnceLock::new();
const DESCRIPTOR: &str = include_str!("../../../assets/shared-memory-runtime.json");
const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;

pub(super) fn archive_path() -> Result<PathBuf, String> {
    Ok(std::env::current_exe()
        .map_err(|_| "无法定位 Hub 安装目录")?
        .parent()
        .ok_or("无法定位 Hub 安装目录")?
        .join("memory-runtime.zip"))
}
fn descriptor() -> Result<Descriptor, String> {
    let value: Descriptor = serde_json::from_str(DESCRIPTOR).map_err(|_| "内置记忆组件清单无效")?;
    if value.schema_version != 1
        || value.platform != "windows-x64"
        || value.python != "3.12.12"
        || value.basic_memory != "0.23.2"
        || value.id.len() != 64
        || !value.id.bytes().all(|b| b.is_ascii_hexdigit())
        || value.expanded_bytes > MAX_BYTES
    {
        return Err("内置记忆组件版本不匹配，请重新安装 Hub".into());
    }
    Ok(value)
}
fn file_hash(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|_| "记忆组件文件不可读")?;
    let mut digest = sha2::Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = file.read(&mut buffer).map_err(|_| "记忆组件校验失败")?;
        if n == 0 {
            break;
        }
        digest.update(&buffer[..n]);
    }
    Ok(format!("{:x}", digest.finalize()))
}
fn relative(name: &str) -> Result<PathBuf, String> {
    if name.is_empty()
        || name.contains(['\\', ':', '\0'])
        || name
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
    {
        return Err("记忆组件包含非法路径".into());
    }
    let path = PathBuf::from(name);
    if path
        .components()
        .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err("记忆组件路径越界".into());
    }
    Ok(path)
}
fn manifest(bytes: &[u8], expected: &Descriptor) -> Result<Manifest, String> {
    if bytes.len() > 8_000_000 || hash(bytes) != expected.id {
        return Err("记忆组件清单校验失败".into());
    }
    let value: Manifest = serde_json::from_slice(bytes).map_err(|_| "记忆组件清单损坏")?;
    if value.schema_version != 1
        || value.platform != expected.platform
        || value.python != expected.python
        || value.basic_memory != expected.basic_memory
        || value.files.len() != expected.files
        || value.expanded_bytes != expected.expanded_bytes
        || value.files.values().map(|v| v.bytes).sum::<u64>() != value.expanded_bytes
        || value.model != "BAAI/bge-small-zh-v1.5"
        || value.model_snapshot != "46fbe35fd4374a00fee7de77dfddaeb6dd6a2c59"
    {
        return Err("记忆组件内容与版本不匹配".into());
    }
    for (name, row) in &value.files {
        relative(name)?;
        if row.bytes > MAX_BYTES || row.sha256.len() != 64 {
            return Err("记忆组件大小无效".into());
        }
    }
    Ok(value)
}
fn disk_files(
    root: &Path,
    current: &Path,
    output: &mut BTreeMap<String, u64>,
) -> Result<(), String> {
    // The caller checks the root ancestry once. Check each descendant once as
    // it is discovered, instead of restatting every ancestor for every file.
    for entry in fs::read_dir(current).map_err(|_| "无法检查记忆组件目录")? {
        let entry = entry.map_err(|_| "无法检查记忆组件目录")?;
        let path = entry.path();
        let metadata = entry.metadata().map_err(|_| "无法检查记忆组件文件")?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err("记忆组件不接受目录联接".into());
            }
        }
        if metadata.file_type().is_symlink() {
            return Err("记忆组件不接受符号链接".into());
        }
        if metadata.is_dir() {
            disk_files(root, &path, output)?;
        } else {
            output.insert(
                path.strip_prefix(root)
                    .map_err(|_| "记忆组件路径越界")?
                    .to_string_lossy()
                    .replace('\\', "/"),
                metadata.len(),
            );
        }
    }
    Ok(())
}
fn verify_installed(target: &Path, expected: &Descriptor) -> Result<(), String> {
    safe_path(target)?;
    let bytes = fs::read(target.join("manifest.json")).map_err(|_| "记忆组件尚未准备")?;
    let manifest = manifest(&bytes, expected)?;
    let mut actual = BTreeMap::new();
    disk_files(target, target, &mut actual)?;
    let mut wanted: BTreeMap<String, u64> = manifest
        .files
        .iter()
        .map(|(name, row)| (name.clone(), row.bytes))
        .collect();
    wanted.insert("manifest.json".into(), bytes.len() as u64);
    wanted.insert(".hub-runtime-ready".into(), expected.id.len() as u64);
    if actual != wanted
        || fs::read_to_string(target.join(".hub-runtime-ready"))
            .ok()
            .as_deref()
            != Some(&expected.id)
    {
        return Err("记忆组件不完整，需要修复".into());
    }
    for (name, row) in &manifest.files {
        let path = target.join(relative(name)?);
        if file_hash(&path)? != row.sha256 {
            return Err("记忆组件校验失败，需要修复".into());
        }
    }
    Ok(())
}
#[cfg(windows)]
fn free_space(root: &Path) -> Result<u64, String> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetDiskFreeSpaceExW(
            path: *const u16,
            available: *mut u64,
            total: *mut u64,
            free: *mut u64,
        ) -> i32;
    }
    let path: Vec<u16> = root.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut available = 0u64;
    if unsafe {
        GetDiskFreeSpaceExW(
            path.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err("无法检查记忆组件所需空间".into());
    }
    Ok(available)
}
#[cfg(not(windows))]
fn free_space(_: &Path) -> Result<u64, String> {
    Err("当前组件包仅适用于 Windows x64".into())
}
fn probe(target: &Path) -> Result<(), String> {
    let python = target.join("python/python.exe");
    let mut command = Command::new(&python);
    command
        .args([
            "-I",
            "-B",
            "-X",
            "utf8",
            "-c",
            include_str!("runtime_probe.py"),
        ])
        .arg(target.join("models"))
        .env_clear()
        .current_dir(target)
        .env("PATH", python.parent().unwrap())
        .env("HF_HUB_OFFLINE", "1")
        .env("TRANSFORMERS_OFFLINE", "1")
        .env("HF_HUB_DISABLE_TELEMETRY", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for name in ["SYSTEMROOT", "WINDIR", "TEMP", "TMP"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "内置记忆组件无法启动，请尝试修复")?;
    #[cfg(windows)]
    let _group = match backend::attach(child.id()) {
        Ok(group) => group,
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("无法管理内置记忆组件进程".into());
        }
    };
    let deadline = Instant::now() + Duration::from_secs(60);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("内置记忆组件准备超时，请重试".into());
            }
        }
    };
    let mut reply = String::new();
    child
        .stdout
        .take()
        .ok_or("记忆组件未返回结果")?
        .take(8192)
        .read_to_string(&mut reply)
        .map_err(|_| "记忆组件结果不可读")?;
    let mut diagnostic = String::new();
    if let Some(stderr) = child.stderr.take() {
        let _ = stderr.take(8192).read_to_string(&mut diagnostic);
    }
    if !status.success() || serde_json::from_str::<Value>(reply.trim()).is_err() {
        let detail = diagnostic.replace(&target.to_string_lossy().to_string(), "<runtime>");
        let _ = fs::write(
            target.parent().unwrap().join("last-prepare-error.json"),
            serde_json::to_vec(
                &json!({"phase":"capabilityProbe","exitCode":status.code(),"detail":detail}),
            )
            .unwrap(),
        );
    }
    let reply: Value =
        serde_json::from_str(reply.trim()).map_err(|_| "内置记忆组件未通过离线检查，请尝试修复")?;
    if !status.success()
        || reply["dimensions"] != 512
        || reply["basicMemory"] != "0.23.2"
        || reply["offline"] != true
    {
        return Err("内置记忆组件功能检查未通过，请尝试修复".into());
    }
    Ok(())
}
fn remove_owned(path: &Path, owner: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    safe_path(path)?;
    if fs::canonicalize(path)
        .map_err(|_| "组件目录不可读")?
        .parent()
        != Some(
            fs::canonicalize(owner)
                .map_err(|_| "组件根不可读")?
                .as_path(),
        )
    {
        return Err("组件目录所有权核验失败".into());
    }
    let mut files = BTreeMap::new();
    disk_files(path, path, &mut files)?;
    fs::remove_dir_all(path).map_err(|_| "旧组件仍在使用，请关闭其他 Hub 窗口后重试".into())
}
fn extract(archive: &Path, staging: &Path, expected: &Descriptor) -> Result<(), String> {
    if fs::metadata(archive)
        .map_err(|_| "Hub 安装组件缺失，请重新运行安装程序")?
        .len()
        != expected.archive_bytes
        || file_hash(archive)? != expected.archive_sha256
    {
        return Err("Hub 安装组件损坏，请重新运行安装程序".into());
    }
    let file = fs::File::open(archive).map_err(|_| "Hub 安装组件不可读")?;
    let mut bundle = zip::ZipArchive::new(file).map_err(|_| "Hub 安装组件无效")?;
    let mut bytes = Vec::new();
    bundle
        .by_name("manifest.json")
        .map_err(|_| "组件清单缺失")?
        .take(8_000_001)
        .read_to_end(&mut bytes)
        .map_err(|_| "组件清单不可读")?;
    let manifest = manifest(&bytes, expected)?;
    if bundle.len() != manifest.files.len() + 1 {
        return Err("组件文件集合不匹配".into());
    }
    let real_staging = fs::canonicalize(staging).map_err(|_| "无法核对组件准备目录")?;
    let prefix = crate::display_local_path(&real_staging)
        .encode_utf16()
        .count()
        + 1;
    let suffix = manifest
        .files
        .keys()
        .filter(|name| {
            name.starts_with("models/")
                || name.ends_with(".pyd")
                || name.ends_with(".dll")
                || name.ends_with(".exe")
        })
        .map(|name| name.encode_utf16().count())
        .max()
        .unwrap_or(0);
    if prefix + suffix > 250 {
        return Err("数据目录过深，无法加载内置记忆。请在存储设置中选择较短的数据目录".into());
    }
    let mut seen = BTreeSet::new();
    let mut prepared_directories = BTreeSet::new();
    for i in 0..bundle.len() {
        let mut item = bundle.by_index(i).map_err(|_| "组件文件不可读")?;
        let name = item.name().to_owned();
        let relative = relative(&name)?;
        if !seen.insert(name.clone())
            || (name != "manifest.json" && !manifest.files.contains_key(&name))
            || item
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("组件包含未知文件或链接".into());
        }
        let limit = if name == "manifest.json" {
            bytes.len() as u64
        } else {
            manifest.files[&name].bytes
        };
        if item.size() != limit {
            return Err("组件文件大小不匹配".into());
        }
        let path = staging.join(relative);
        let parent = path.parent().unwrap();
        if prepared_directories.insert(parent.to_path_buf()) {
            safe_path(parent)?;
            fs::create_dir_all(parent).map_err(|_| "无法准备记忆组件目录")?;
        }
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|_| "无法写入记忆组件")?;
        let mut reader = item.by_ref().take(limit + 1);
        let mut digest = sha2::Sha256::new();
        let mut copied = 0u64;
        let mut buffer = [0u8; 65536];
        loop {
            let count = reader.read(&mut buffer).map_err(|_| "记忆组件读取失败")?;
            if count == 0 {
                break;
            }
            output
                .write_all(&buffer[..count])
                .map_err(|_| "记忆组件写入失败")?;
            digest.update(&buffer[..count]);
            copied += count as u64;
        }
        if copied != limit {
            return Err("记忆组件写入不完整".into());
        }
        output.flush().map_err(|_| "记忆组件写入失败")?;
        if name != "manifest.json"
            && format!("{:x}", digest.finalize()) != manifest.files[&name].sha256
        {
            return Err("记忆组件校验失败".into());
        }
    }
    probe(staging)?;
    fs::write(staging.join(".hub-runtime-ready"), &expected.id)
        .map_err(|_| "无法保存组件准备结果")?;
    Ok(())
}
pub(super) fn ensure(root: &Path) -> Result<RuntimeConfig, String> {
    ensure_from(root, &archive_path()?)
}
pub(super) fn ensure_from(root: &Path, archive: &Path) -> Result<RuntimeConfig, String> {
    let canonical = fs::canonicalize(root).map_err(|_| "本地数据目录不可用")?;
    let normalized = PathBuf::from(crate::display_local_path(&canonical));
    let root = normalized.as_path();
    let expected = descriptor()?;
    let owner = root.join("cache/memory");
    safe_path(&owner)?;
    let target = owner.join(&expected.id[..16]);
    let verified = VERIFIED.get_or_init(|| Mutex::new(BTreeSet::new()));
    if !verified
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains(&target)
    {
        let _guard = INSTALL
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        fs::create_dir_all(&owner).map_err(|_| "无法准备本地记忆目录")?;
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(false);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(0);
        }
        let lock_path = owner.join(".install-lock");
        safe_path(&lock_path)?;
        let _lease = options
            .open(lock_path)
            .map_err(|_| "另一项记忆组件准备正在进行，请稍后重试")?;
        if verify_installed(&target, &expected).is_err() {
            if free_space(&owner)? < expected.expanded_bytes + 1024 * 1024 * 1024 {
                return Err("准备本地记忆需要更多磁盘空间".into());
            }
            let staging = owner.join(format!("{}.installing", &expected.id[..16]));
            let replaced = owner.join(format!("{}.replaced", &expected.id[..16]));
            remove_owned(&staging, &owner)?;
            fs::create_dir(&staging).map_err(|_| "无法创建记忆组件准备目录")?;
            if let Err(error) = extract(archive, &staging, &expected) {
                let _ = remove_owned(&staging, &owner);
                return Err(error);
            }
            remove_owned(&replaced, &owner)?;
            if target.exists() {
                fs::rename(&target, &replaced).map_err(|_| "旧组件仍在使用，请重启 Hub 后修复")?;
            }
            fs::rename(&staging, &target).map_err(|_| "无法启用本地记忆组件")?;
            remove_owned(&replaced, &owner)?;
        }
        verified
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(target.clone());
    }
    Ok(RuntimeConfig {
        python: target.join("python/python.exe"),
        model_cache: target.join("models"),
    })
}
pub(super) fn repair(root: &Path) -> Result<(), String> {
    forget_verification(root);
    ensure(root).map(|_| ())
}
pub(super) fn forget_verification(root: &Path) {
    let normalized = fs::canonicalize(root)
        .ok()
        .map(|p| PathBuf::from(crate::display_local_path(&p)));
    let root = normalized.as_deref().unwrap_or(root);
    if let Some(verified) = VERIFIED.get() {
        verified
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|p| !p.starts_with(root));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn package_paths_cannot_escape_or_alias_the_runtime_root() {
        for name in [
            "../notes", "/notes", "C:/notes", "a/../b", "a\\b", "a//b", "./x", "", "a\0b",
        ] {
            assert!(relative(name).is_err(), "{name:?}");
        }
        assert_eq!(
            relative("python/Lib/site-packages/basic_memory/__init__.py").unwrap(),
            PathBuf::from("python/Lib/site-packages/basic_memory/__init__.py")
        );
    }
    #[test]
    fn checked_in_descriptor_matches_the_supported_runtime_contract() {
        let value = descriptor().unwrap();
        assert!(value.files > 100);
        assert!(value.archive_bytes > 1_000_000);
        assert!(value.expanded_bytes < MAX_BYTES);
    }
}
