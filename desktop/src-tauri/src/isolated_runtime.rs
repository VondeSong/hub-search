//! Explicit production-entry isolation for local integration checks.
//! No flag means the existing user runtime. Invalid isolation never falls back to it.
use chacha20poly1305::{aead::Aead, KeyInit, XChaCha20Poly1305, XNonce};
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::{
    ffi::OsString,
    fs::{self, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
    sync::OnceLock,
};

const FLAG: &str = "--isolated-data-root";
const WORKERS_FLAG: &str = "--isolated-background-workers";
const PROBE_LIBRARY: &str = "--isolated-craft-probe-library";
const PROBE_DOCUMENT: &str = "--isolated-craft-probe-document";
const MARKER: &str = ".hub-isolated-runtime-v1";
const MARKER_CONTENT: &[u8] = b"Hub isolated runtime v1\n";
const MAGIC: &[u8] = b"HUBISOLATEDSECRET1";
static RUNTIME: OnceLock<Option<Runtime>> = OnceLock::new();

struct Runtime {
    root: PathBuf,
    automatic_workers: bool,
    craft_probe: Option<CraftProbeScope>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CraftProbeScope {
    pub library_id: String,
    pub document_id: String,
}
fn probe_scope(
    arguments: &[OsString],
    root: Option<&Path>,
    workers: bool,
) -> Result<Option<CraftProbeScope>, String> {
    let mut values = [None, None];
    for (slot, flag) in [PROBE_LIBRARY, PROBE_DOCUMENT].iter().enumerate() {
        for (i, arg) in arguments.iter().enumerate() {
            let arg = arg.to_string_lossy();
            let value = if arg == *flag {
                Some(
                    arguments
                        .get(i + 1)
                        .ok_or("单页验证缺少范围")?
                        .to_string_lossy()
                        .into_owned(),
                )
            } else {
                arg.strip_prefix(&format!("{flag}=")).map(str::to_owned)
            };
            if let Some(value) = value {
                if values[slot].replace(value).is_some() {
                    return Err("单页验证范围重复".into());
                }
            }
        }
    }
    if values.iter().all(Option::is_none) {
        return Ok(None);
    }
    let [Some(library_id), Some(document_id)] = values else {
        return Err("单页验证必须同时绑定资料库和页面".into());
    };
    if workers
        || root.is_none_or(|r| !r.is_dir())
        || library_id.is_empty()
        || library_id.len() > 200
        || !library_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_:".contains(&b))
        || document_id.len() != 36
        || !document_id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
    {
        return Err("单页验证只允许已存在的隔离目录、一个准确页面和关闭的后台任务".into());
    }
    Ok(Some(CraftProbeScope {
        library_id,
        document_id,
    }))
}

fn parse_workers(arguments: &[OsString], root: Option<&Path>) -> Result<bool, String> {
    let count = arguments
        .iter()
        .filter(|value| *value == WORKERS_FLAG)
        .count();
    if count > 1 || (count > 0 && root.is_none()) {
        return Err("后台联调选项必须与一个明确的隔离数据目录组合，且不能重复".into());
    }
    Ok(count == 1)
}

fn parse(arguments: &[OsString]) -> Result<Option<PathBuf>, String> {
    if arguments.iter().any(|arg| {
        let value = arg.to_string_lossy();
        value == "--data-dir" || value.starts_with("--data-dir=")
    }) {
        return Err(
            "--data-dir 仅供 MCP 模式；GUI 隔离启动请使用 --isolated-data-root，未打开默认用户数据"
                .into(),
        );
    }
    let mut result = None;
    let mut index = 0;
    while index < arguments.len() {
        let argument = arguments[index].to_string_lossy();
        let value = if argument == FLAG {
            index += 1;
            Some(
                arguments
                    .get(index)
                    .ok_or("隔离启动参数缺少数据目录")?
                    .clone(),
            )
        } else {
            argument
                .strip_prefix(&format!("{FLAG}="))
                .map(OsString::from)
        };
        if let Some(value) = value {
            if result.is_some() {
                return Err("隔离启动参数重复，未启动应用".into());
            }
            let path = PathBuf::from(value);
            if path.as_os_str().is_empty()
                || !path.is_absolute()
                || path.file_name().is_none()
                || path
                    .components()
                    .any(|part| matches!(part, Component::ParentDir))
            {
                return Err("隔离数据目录必须是明确的绝对子目录，不能使用根目录或上级跳转".into());
            }
            result = Some(path);
        }
        index += 1;
    }
    Ok(result)
}

fn ordinary_directory(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if metadata.file_attributes() & 0x400 != 0 {
                        return Err("隔离数据目录不能经过重解析点".into());
                    }
                }
                if !metadata.is_dir() || metadata.file_type().is_symlink() {
                    return Err("隔离数据目录必须经过普通目录".into());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("无法核对隔离数据目录".into()),
        }
    }
    Ok(())
}

impl Runtime {
    fn prepare(root: PathBuf) -> Result<Self, String> {
        ordinary_directory(&root)?;
        if root.exists() {
            if !root.is_dir() {
                return Err("隔离数据位置不是目录".into());
            }
            let marker = root.join(MARKER);
            if marker.exists() {
                if fs::read(marker).map_err(|_| "无法读取隔离目录标记")? != MARKER_CONTENT
                {
                    return Err("隔离目录标记无效，未读取任何应用数据".into());
                }
            } else if fs::read_dir(&root)
                .map_err(|_| "无法检查隔离目录")?
                .next()
                .is_some()
            {
                return Err("隔离目录已有未登记内容，请选择新的空目录".into());
            }
        }
        fs::create_dir_all(&root).map_err(|_| "无法创建隔离数据目录")?;
        let marker = root.join(MARKER);
        if !marker.exists() {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(marker)
                .map_err(|_| "无法建立隔离目录标记")?;
            file.write_all(MARKER_CONTENT)
                .and_then(|_| file.sync_all())
                .map_err(|_| "无法保存隔离目录标记")?;
        }
        Ok(Self {
            root: fs::canonicalize(root).map_err(|_| "无法解析隔离数据目录")?,
            automatic_workers: false,
            craft_probe: None,
        })
    }

    #[cfg(windows)]
    fn prepare_webview_data_directory(&self) -> Result<PathBuf, String> {
        let directory = self.root.join("webview-v1").join("main");
        ordinary_directory(&directory)?;
        fs::create_dir_all(&directory).map_err(|_| "无法创建隔离浏览器数据目录")?;
        ordinary_directory(&directory)?;
        let directory = fs::canonicalize(directory).map_err(|_| "无法解析隔离浏览器数据目录")?;
        if !directory.starts_with(&self.root) {
            return Err("隔离浏览器数据目录不能位于隔离目录外".into());
        }
        Ok(directory)
    }

    fn secret_path(&self, id: &str) -> PathBuf {
        self.root
            .join("isolated-secrets-v1")
            .join(format!("{:x}.secret", Sha256::digest(id.as_bytes())))
    }

    fn key(&self) -> Result<[u8; 32], String> {
        let directory = self.root.join("isolated-secrets-v1");
        fs::create_dir_all(&directory).map_err(|_| "无法创建隔离凭据目录")?;
        let path = directory.join(".master-key");
        if let Ok(bytes) = fs::read(&path) {
            return bytes.try_into().map_err(|_| "隔离凭据密钥无效".into());
        }
        let mut key = [0; 32];
        rand::thread_rng().fill_bytes(&mut key);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => file
                .write_all(&key)
                .and_then(|_| file.sync_all())
                .map(|_| key)
                .map_err(|_| "无法保存隔离凭据密钥".into()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => fs::read(path)
                .map_err(|_| "无法读取隔离凭据密钥")?
                .try_into()
                .map_err(|_| "隔离凭据密钥无效".into()),
            Err(_) => Err("无法创建隔离凭据密钥".into()),
        }
    }

    fn get(&self, id: &str) -> Result<Option<String>, String> {
        let bytes = match fs::read(self.secret_path(id)) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("无法读取隔离凭据".into()),
        };
        let start = MAGIC.len();
        if !bytes.starts_with(MAGIC) || bytes.len() <= start + 24 {
            return Err("隔离凭据文件无效".into());
        }
        let key = self.key()?;
        let plaintext = XChaCha20Poly1305::new((&key).into())
            .decrypt(
                XNonce::from_slice(&bytes[start..start + 24]),
                &bytes[start + 24..],
            )
            .map_err(|_| "隔离凭据校验失败")?;
        String::from_utf8(plaintext)
            .map(Some)
            .map_err(|_| "隔离凭据文本无效".into())
    }

    fn set(&self, id: &str, value: &str) -> Result<(), String> {
        let key = self.key()?;
        let mut nonce = [0; 24];
        rand::thread_rng().fill_bytes(&mut nonce);
        let encrypted = XChaCha20Poly1305::new((&key).into())
            .encrypt(XNonce::from_slice(&nonce), value.as_bytes())
            .map_err(|_| "无法加密隔离凭据")?;
        let path = self.secret_path(id);
        let temporary = path.with_extension(format!("{}.tmp", super::random_url_safe(8)));
        let mut bytes = MAGIC.to_vec();
        bytes.extend_from_slice(&nonce);
        bytes.extend(encrypted);
        fs::write(&temporary, bytes).map_err(|_| "无法写入隔离凭据")?;
        if let Err(error) = fs::rename(&temporary, &path).or_else(|_| {
            if path.exists() {
                fs::remove_file(&path)?;
            }
            fs::rename(&temporary, &path)
        }) {
            let _ = fs::remove_file(temporary);
            return Err(format!("无法提交隔离凭据：{error}"));
        }
        Ok(())
    }
}

#[cfg(test)]
pub(crate) fn prepare_test_root(root: PathBuf) -> Result<PathBuf, String> {
    Runtime::prepare(root).map(|runtime| runtime.root)
}

pub(crate) fn initialize() -> Result<(), String> {
    let arguments: Vec<_> = std::env::args_os().skip(1).collect();
    let root = parse(&arguments)?;
    crate::background_workers::configure_manual_session(&arguments, root.is_some())?;
    let automatic_workers = parse_workers(&arguments, root.as_deref())?;
    let craft_probe = probe_scope(&arguments, root.as_deref(), automatic_workers)?;
    let runtime = root.map(Runtime::prepare).transpose()?.map(|mut runtime| {
        runtime.automatic_workers = automatic_workers;
        runtime.craft_probe = craft_probe;
        runtime
    });
    #[cfg(windows)]
    let webview_directory = runtime
        .as_ref()
        .map(Runtime::prepare_webview_data_directory)
        .transpose()?;
    RUNTIME.set(runtime).map_err(|_| "隔离运行已初始化")?;
    #[cfg(windows)]
    if let Some(directory) = webview_directory {
        // The pinned Tauri config conversion drops data_directory. WebView2's
        // process-local override also contains auxiliary WebViews and replaces
        // an inherited override before any browser environment is constructed.
        // Rust permits environment mutation on Windows; normal mode never sets it.
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", directory);
    }
    Ok(())
}
pub(crate) fn root() -> Option<&'static Path> {
    RUNTIME
        .get()
        .and_then(Option::as_ref)
        .map(|runtime| runtime.root.as_path())
}
pub(crate) fn enabled() -> bool {
    root().is_some()
}
pub(crate) fn automatic_workers_enabled() -> bool {
    !crate::background_workers::manual_session()
        && (!enabled() || runtime().is_ok_and(|runtime| runtime.automatic_workers))
}
pub(crate) fn craft_probe_scope() -> Option<&'static CraftProbeScope> {
    RUNTIME
        .get()
        .and_then(Option::as_ref)
        .filter(|r| !r.automatic_workers)
        .and_then(|r| r.craft_probe.as_ref())
}
pub(crate) fn require_craft_probe(library: &str, document: &str) -> Result<(), String> {
    let scope = craft_probe_scope().ok_or("PROBE_SCOPE_REQUIRED")?;
    let root = root().ok_or("PROBE_SCOPE_REQUIRED")?;
    ordinary_directory(root)?;
    if scope.library_id != library
        || scope.document_id != document
        || fs::read(root.join(MARKER)).ok().as_deref() != Some(MARKER_CONTENT)
    {
        return Err("PROBE_SCOPE_MISMATCH".into());
    }
    Ok(())
}
fn runtime() -> Result<&'static Runtime, String> {
    RUNTIME
        .get()
        .and_then(Option::as_ref)
        .ok_or_else(|| "未启用隔离运行".into())
}
pub(crate) fn secret_get(id: &str) -> Result<Option<String>, String> {
    runtime()?.get(id)
}
pub(crate) fn secret_set(id: &str, value: &str) -> Result<(), String> {
    runtime()?.set(id, value)
}
pub(crate) fn secret_delete(id: &str) {
    if let Ok(runtime) = runtime() {
        let _ = fs::remove_file(runtime.secret_path(id));
    }
}

#[tauri::command]
pub(crate) fn get_isolated_runtime_status() -> serde_json::Value {
    serde_json::json!({
        "enabled":enabled(),
        "processId":std::process::id(),
        "version":env!("CARGO_PKG_VERSION"),
        "dataRoot":root().map(|root|root.to_string_lossy().into_owned()),
        "automaticWorkersStarted":crate::background_workers::started(),
        "personalCredentialAccess":!enabled() || craft_probe_scope().is_some(),
        "craftProbeCredentialScope":craft_probe_scope(),
        "globalRegistration":!enabled()
    })
}

/// Called by the embedded frontend after its first real Tauri invoke.
/// Only safe success projections are retained; getter payloads never enter the receipt.
#[tauri::command]
pub(crate) fn record_isolated_frontend_ready(app: tauri::AppHandle) -> Result<(), String> {
    let runtime = runtime()?; // Refuse a normal profile before touching any database or getter.
    ordinary_directory(&runtime.root)?;
    if fs::read(runtime.root.join(MARKER)).map_err(|_| "隔离目录标记不可读取")? != MARKER_CONTENT
    {
        return Err("隔离目录所有权标记无效，未记录联调结果".into());
    }
    let cloud_policy = crate::cloud_sync::get_cloud_sync_policy(app.clone()).is_ok();
    let reading_status = crate::reading_sync::get_reading_sync_status(app.clone()).is_ok();
    let media_policy = crate::reading_sync::media::get_reading_media_policy(app.clone()).is_ok();
    let source_cleanup =
        crate::x_bookmarks::dida_reading::source_recovery::get_reading_source_cleanup(app.clone())
            .is_ok();
    let receipt = serde_json::json!({
        "format":"hub-isolated-startup", "formatVersion":1,
        "processId":std::process::id(),
        "packageVersion":app.package_info().version.to_string(),
        "compiledVersion":env!("CARGO_PKG_VERSION"),
        "observedAt":chrono::Utc::now().to_rfc3339(),
        "isolated":true, "frontendReady":true,
        "automaticWorkersStarted":crate::background_workers::started(),
        "personalCredentialAccess":craft_probe_scope().is_some(),
        "craftProbeCredentialScope":craft_probe_scope(),
        "globalRegistration":false,
        "getterChecks":{
            "cloudSyncPolicy":cloud_policy,
            "readingSyncStatus":reading_status,
            "readingMediaPolicy":media_policy,
            "readingSourceCleanup":source_cleanup
        },
        "ready":cloud_policy && reading_status && media_policy && source_cleanup
    });
    let path = runtime.root.join("integration-startup.json");
    if let Ok(metadata) = fs::symlink_metadata(&path) {
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err("联调回执位置不能是重解析点".into());
            }
        }
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err("联调回执位置必须是隔离目录内的普通文件".into());
        }
    }
    let temporary = runtime.root.join(format!(
        "integration-startup-{}.tmp",
        super::random_url_safe(8)
    ));
    let bytes = serde_json::to_vec_pretty(&receipt).map_err(|_| "无法生成联调回执")?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| "无法创建隔离联调回执")?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "无法保存隔离联调回执")?;
    drop(file);
    if fs::rename(&temporary, &path).is_err() {
        if path.exists() {
            fs::remove_file(&path).map_err(|_| "无法更新隔离联调回执")?;
        }
        fs::rename(&temporary, &path).map_err(|_| "无法提交隔离联调回执")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn attachment_traffic_probe_scope_rejects_general_isolation_and_wide_or_worker_scopes() {
        let root = std::env::temp_dir().join(format!(
            "hub-probe-scope-{}",
            super::super::random_url_safe(12)
        ));
        fs::create_dir(&root).unwrap();
        let args = [
            PROBE_LIBRARY,
            "library",
            PROBE_DOCUMENT,
            "11111111-1111-1111-1111-111111111111",
        ]
        .map(OsString::from);
        assert!(probe_scope(&[], Some(&root), false).unwrap().is_none());
        assert!(probe_scope(&args, None, false).is_err());
        assert!(probe_scope(&args, Some(&root), true).is_err());
        assert!(probe_scope(&args, Some(&root), false).unwrap().is_some());
        let mut wide = args.to_vec();
        wide[3] = OsString::from("*");
        assert!(probe_scope(&wide, Some(&root), false).is_err());
        let mut duplicate = args.to_vec();
        duplicate.extend_from_slice(&args);
        assert!(probe_scope(&duplicate, Some(&root), false).is_err());
        fs::remove_dir(&root).unwrap();
    }
    fn fixture() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join(".local/cloud-completion-20261007/runtime-tests")
            .join(format!("isolated-{}", super::super::random_url_safe(10)))
    }
    #[test]
    fn automatic_workers_require_one_explicit_owned_root_option() {
        let root = fixture();
        assert!(!parse_workers(&[], Some(&root)).unwrap());
        assert!(parse_workers(&[OsString::from(WORKERS_FLAG)], Some(&root)).unwrap());
        assert!(parse_workers(&[OsString::from(WORKERS_FLAG)], None).is_err());
        assert!(parse_workers(
            &[OsString::from(WORKERS_FLAG), OsString::from(WORKERS_FLAG)],
            Some(&root)
        )
        .is_err());
    }
    #[test]
    fn explicit_arguments_never_fall_back_on_invalid_or_ambiguous_roots() {
        assert_eq!(parse(&[]).unwrap(), None);
        for args in [
            vec![FLAG],
            vec![FLAG, "relative"],
            vec![FLAG, ""],
            vec!["--isolated-data-root="],
            vec![FLAG, "--other-flag"],
        ] {
            assert!(parse(&args.into_iter().map(OsString::from).collect::<Vec<_>>()).is_err());
        }
        let root = fixture();
        let args = [OsString::from(FLAG), root.clone().into_os_string()];
        assert_eq!(parse(&args).unwrap(), Some(root.clone()));
        let args = [
            args[0].clone(),
            args[1].clone(),
            args[0].clone(),
            args[1].clone(),
        ];
        assert!(parse(&args).is_err());
    }

    #[test]
    fn gui_rejects_mcp_data_dir_before_selecting_any_runtime() {
        for args in [
            vec!["--data-dir", "D:/controlled"],
            vec!["--data-dir=D:/controlled"],
            vec![
                "--isolated-data-root",
                "D:/controlled",
                "--data-dir",
                "D:/other",
            ],
        ] {
            let args = args.into_iter().map(OsString::from).collect::<Vec<_>>();
            assert!(parse(&args).unwrap_err().contains("未打开默认用户数据"));
        }
        assert_eq!(parse(&[]).unwrap(), None);
    }
    #[test]
    fn foreign_existing_data_is_refused_and_owned_isolated_credentials_survive_restart() {
        let root = fixture();
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("foreign.sqlite3"), b"protected fixture").unwrap();
        assert!(Runtime::prepare(root.clone()).is_err());
        assert_eq!(
            fs::read(root.join("foreign.sqlite3")).unwrap(),
            b"protected fixture"
        );
        fs::remove_file(root.join("foreign.sqlite3")).unwrap();
        let runtime = Runtime::prepare(root.clone()).unwrap();
        assert_eq!(runtime.get("existing-personal-id").unwrap(), None);
        runtime
            .set("existing-personal-id", "isolated fixture value")
            .unwrap();
        let bytes = fs::read(runtime.secret_path("existing-personal-id")).unwrap();
        assert!(!bytes
            .windows(22)
            .any(|part| part == b"isolated fixture value"));
        let restarted = Runtime::prepare(root.clone()).unwrap();
        assert_eq!(
            restarted.get("existing-personal-id").unwrap().as_deref(),
            Some("isolated fixture value")
        );
        let mut damaged = bytes;
        *damaged.last_mut().unwrap() ^= 1;
        fs::write(runtime.secret_path("existing-personal-id"), damaged).unwrap();
        assert!(restarted.get("existing-personal-id").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn browser_data_is_prepared_inside_the_owned_root_and_survives_restart() {
        let root = fixture();
        let runtime = Runtime::prepare(root.clone()).unwrap();
        let browser = runtime.prepare_webview_data_directory().unwrap();
        assert_eq!(browser, runtime.root.join("webview-v1").join("main"));
        assert!(browser.is_dir());
        let state = browser.join("browser-state-fixture");
        fs::write(&state, b"owned browser state").unwrap();
        let restarted = Runtime::prepare(root.clone()).unwrap();
        assert_eq!(restarted.prepare_webview_data_directory().unwrap(), browser);
        assert_eq!(fs::read(&state).unwrap(), b"owned browser state");
        assert_eq!(fs::read(root.join(MARKER)).unwrap(), MARKER_CONTENT);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn browser_subtree_refuses_a_foreign_file_without_overwriting_it() {
        let root = fixture();
        let runtime = Runtime::prepare(root.clone()).unwrap();
        let obstruction = root.join("webview-v1");
        fs::write(&obstruction, b"protected fixture").unwrap();
        assert!(runtime.prepare_webview_data_directory().is_err());
        assert_eq!(fs::read(&obstruction).unwrap(), b"protected fixture");
        assert!(!root.join("webview-v1/main").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
