//! Default-off admission for the real OAuth and frontend cold-start restore check.
//! This module cannot restore a session from the probe command or enumerate tasks.
use super::*;
use std::os::windows::fs::MetadataExt;

const MANIFEST: &str = "dida-oauth-integration-v1.json";
const RECEIPT: &str = "dida-oauth-startup-v1.json";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    format: String,
    format_version: u8,
    run_id: String,
    library_id: Option<String>,
}

struct Admission {
    run_id: String,
    library_id: String,
    library_name: String,
}

fn official_endpoint(value: &str) -> bool {
    Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str() == Some("mcp.dida365.com")
            && url.port().is_none()
            && url.username().is_empty()
            && url.password().is_none()
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none()
    })
}

impl Manifest {
    fn validate(&self) -> Result<(), String> {
        let valid_library = self.library_id.as_deref().is_none_or(|id| {
            id.strip_prefix("dida365:").is_some_and(|suffix| {
                suffix.len() == 16
                    && suffix
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            })
        });
        if self.format != "hub-dida-oauth-integration"
            || self.format_version != 1
            || self.run_id.len() != 32
            || !self.run_id.bytes().all(|byte| byte.is_ascii_hexdigit())
            || !valid_library
        {
            return Err("独立滴答 OAuth 授权清单无效".into());
        }
        Ok(())
    }
}

fn ordinary_path(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata)
                if metadata.file_attributes() & 0x400 != 0 || metadata.file_type().is_symlink() =>
            {
                return Err("滴答 OAuth 联调路径不能经过重解析点".into());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("无法核对滴答 OAuth 联调路径".into()),
        }
    }
    Ok(())
}

fn small_file(path: &Path) -> Result<Vec<u8>, String> {
    ordinary_path(path)?;
    let metadata = fs::symlink_metadata(path).map_err(|_| "缺少滴答 OAuth 联调文件")?;
    if !metadata.is_file() || metadata.len() > 8 * 1024 {
        return Err("滴答 OAuth 联调文件必须是有界普通文件".into());
    }
    fs::read(path).map_err(|_| "无法读取滴答 OAuth 联调文件".into())
}

fn admitted_library(c: &Connection, manifest: Manifest) -> Result<Option<Admission>, String> {
    manifest.validate()?;
    let count: i64 = c
        .query_row("SELECT COUNT(*) FROM libraries", [], |row| row.get(0))
        .map_err(|_| "无法核对独立滴答资料库数量")?;
    let Some(library_id) = manifest.library_id else {
        if count != 0 {
            return Err("未绑定 OAuth 的独立目录必须没有资料库".into());
        }
        return Ok(None);
    };
    if count != 1 {
        return Err("滴答 OAuth 联调只允许唯一的独立资料库".into());
    }
    let (provider, enabled, location, name): (String, i64, String, String) = c
        .query_row(
            "SELECT provider,enabled,location,name FROM libraries WHERE id=?1",
            [&library_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|_| "OAuth 清单未指向本目录的资料库")?;
    if provider != PROVIDER_DIDA365 || enabled != 1 || !official_endpoint(&location) {
        return Err("OAuth 联调资料库必须是已启用的官方滴答直连".into());
    }
    Ok(Some(Admission {
        run_id: manifest.run_id,
        library_id,
        library_name: name,
    }))
}

fn admission_at(root: &Path, database: &Path) -> Result<Option<Admission>, String> {
    let manifest_path = root.join(MANIFEST);
    match fs::symlink_metadata(&manifest_path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("无法检查滴答 OAuth 联调授权清单".into()),
        Ok(_) => {}
    }
    ordinary_path(root)?;
    if small_file(&root.join(".hub-isolated-runtime-v1"))? != b"Hub isolated runtime v1\n" {
        return Err("独立运行所有权标记无效".into());
    }
    if database.parent() != Some(root) {
        return Err("滴答 OAuth 联调数据库不属于独立目录".into());
    }
    for path in [
        database.to_path_buf(),
        database.with_extension("sqlite3-wal"),
        database.with_extension("sqlite3-shm"),
        root.join("isolated-secrets-v1"),
    ] {
        ordinary_path(&path)?;
    }
    let manifest = serde_json::from_slice(&small_file(&manifest_path)?)
        .map_err(|_| "独立滴答 OAuth 清单格式无效")?;
    admitted_library(&open_database(&database.to_path_buf())?, manifest)
}

fn record_startup(
    root: &Path,
    admission: &Admission,
    before: bool,
    after: bool,
) -> Result<(), String> {
    let path = root.join(RECEIPT);
    ordinary_path(&path)?;
    let mut attempts = Vec::new();
    if path.exists() {
        let previous: Value = serde_json::from_slice(&small_file(&path)?)
            .map_err(|_| "滴答 OAuth 启动回执格式无效")?;
        if previous["processId"].as_u64() == Some(u64::from(std::process::id()))
            && previous["runId"].as_str() == Some(admission.run_id.as_str())
        {
            attempts = previous["attempts"].as_array().cloned().unwrap_or_default();
        }
    }
    if attempts.len() >= 16 {
        return Err("滴答 OAuth 启动回执次数超过限制".into());
    }
    attempts.push(json!({"connectedBefore":before,"connectedAfter":after}));
    let receipt = json!({
        "format":"hub-dida-oauth-startup", "formatVersion":1,
        "processId":std::process::id(), "runId":admission.run_id,
        "libraryId":admission.library_id, "entry":"restore_connections",
        "sharedDidaRestoreHelper":true, "attempts":attempts
    });
    let temporary = root.join(format!("dida-oauth-startup-{}.tmp", random_url_safe(8)));
    ordinary_path(&temporary)?;
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(&receipt).map_err(|_| "无法生成滴答 OAuth 启动回执")?,
    )
    .map_err(|_| "无法保存滴答 OAuth 启动回执")?;
    if path.exists() {
        small_file(&path)?;
        fs::remove_file(&path).map_err(|_| "无法替换滴答 OAuth 启动回执")?;
    }
    fs::rename(&temporary, &path).map_err(|_| "无法提交滴答 OAuth 启动回执".into())
}

/// Called only from the existing restore_connections command, after its isolation check.
pub(crate) async fn restore_from_startup(
    app: &AppHandle,
    state: &AppState,
) -> Result<Vec<SpaceSummary>, String> {
    let root = isolated_runtime::root().ok_or("滴答 OAuth 联调仅限独立运行")?;
    let Some(admission) = admission_at(root, &database_path(app)?)? else {
        return Ok(Vec::new());
    };
    let _guard = state.connection_restore_guard.lock().await;
    let connected = || {
        state
            .sessions
            .lock()
            .is_ok_and(|sessions| sessions.contains_key(&admission.library_id))
    };
    let before = connected();
    let client = reqwest::Client::builder()
        .user_agent(concat!("Craft-Search/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| "滴答 OAuth 联调 HTTP 客户端初始化失败")?;
    restore_dida_connections(
        &client,
        state,
        root,
        vec![(admission.library_id.clone(), admission.library_name.clone())],
    )
    .await;
    record_startup(root, &admission, before, connected())?;
    Ok(Vec::new())
}

#[tauri::command]
pub(crate) async fn probe_dida_oauth_integration(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let root = isolated_runtime::root().ok_or("滴答 OAuth 联调仅限独立运行")?;
    let admission =
        admission_at(root, &database_path(&app)?)?.ok_or("尚未绑定独立滴答 OAuth 资料库")?;
    let session = state
        .sessions
        .lock()
        .map_err(|_| "滴答连接状态不可用")?
        .get(&admission.library_id)
        .cloned()
        .ok_or("滴答会话尚未由授权或启动恢复建立")?;
    if session.space_id != admission.library_id || !official_endpoint(&session.endpoint) {
        return Err("当前会话不是本轮官方滴答直连".into());
    }
    let client = reqwest::Client::builder()
        .user_agent(concat!("Craft-Search/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| "滴答 OAuth 联调 HTTP 客户端初始化失败")?;
    let result = call_mcp_tool_raw(&client, &session, "get_user_preference", json!({}), 19_101)
        .await
        .map_err(|_| "滴答授权只读验证失败，未导出服务响应")?;
    if !parse_tool_json(&result).is_some_and(|value| value.is_object()) {
        return Err("滴答偏好只读响应未返回结构化对象，未导出服务响应".into());
    }
    Ok(json!({"libraryId":admission.library_id,"connected":true,"preferenceReadSucceeded":true}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(library: Option<&str>) -> Manifest {
        Manifest {
            format: "hub-dida-oauth-integration".into(),
            format_version: 1,
            run_id: "0123456789abcdef0123456789abcdef".into(),
            library_id: library.map(str::to_string),
        }
    }

    fn database() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE libraries(id TEXT PRIMARY KEY,provider TEXT,enabled INTEGER,location TEXT,name TEXT);").unwrap();
        c
    }

    fn insert(c: &Connection, id: &str, provider: &str, enabled: i64, endpoint: &str) {
        c.execute(
            "INSERT INTO libraries VALUES(?1,?2,?3,?4,'owned test')",
            params![id, provider, enabled, endpoint],
        )
        .unwrap();
    }

    #[test]
    fn unbound_manifest_cannot_restore_an_existing_library() {
        let c = database();
        assert!(admitted_library(&c, manifest(None)).unwrap().is_none());
        insert(
            &c,
            "dida365:abcdefghijklmnop",
            "dida365",
            1,
            "https://mcp.dida365.com",
        );
        assert!(admitted_library(&c, manifest(None)).is_err());
    }

    #[test]
    fn only_one_bound_enabled_official_dida_library_is_admitted() {
        let id = "dida365:abcdefghijklmnop";
        for (provider, enabled, endpoint) in [
            ("craft", 1, "https://mcp.dida365.com"),
            ("dida365", 0, "https://mcp.dida365.com"),
            ("dida365", 1, "http://127.0.0.1:1234/mcp"),
            ("dida365", 1, "https://mcp.dida365.com/other"),
        ] {
            let c = database();
            insert(&c, id, provider, enabled, endpoint);
            assert!(admitted_library(&c, manifest(Some(id))).is_err());
        }
        let c = database();
        insert(&c, id, "dida365", 1, "https://mcp.dida365.com/");
        assert_eq!(
            admitted_library(&c, manifest(Some(id)))
                .unwrap()
                .unwrap()
                .library_id,
            id
        );
        assert!(admitted_library(&c, manifest(Some("dida365:qrstuvwxyzABCDEF"))).is_err());
        insert(&c, "other", "craft", 0, "https://example.com");
        assert!(admitted_library(&c, manifest(Some(id))).is_err());
    }

    #[test]
    fn oauth_manifest_rejects_bridge_identity_and_unknown_fields() {
        let mut value = serde_json::json!({"format":"hub-dida-oauth-integration","formatVersion":1,
            "runId":"0123456789abcdef0123456789abcdef","libraryId":"integration-dida-source:bridge"});
        assert!(serde_json::from_value::<Manifest>(value.clone())
            .unwrap()
            .validate()
            .is_err());
        value["libraryId"] = json!("dida365:abcdefghijklmnop");
        value["projectId"] = json!("old-r5-project");
        assert!(serde_json::from_value::<Manifest>(value).is_err());
        let mut invalid = manifest(None);
        invalid.run_id = "../other".into();
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn official_endpoint_rejects_credentials_paths_and_other_hosts() {
        for value in [
            "http://mcp.dida365.com",
            "https://mcp.dida365.com.evil.test",
            "https://user@mcp.dida365.com",
            "https://mcp.dida365.com/?token=unsafe",
            "https://mcp.dida365.com/#fragment",
            "https://mcp.dida365.com:8443",
        ] {
            assert!(!official_endpoint(value));
        }
        assert!(official_endpoint("https://mcp.dida365.com"));
    }

    #[test]
    fn missing_manifest_keeps_isolated_restore_disabled() {
        let root =
            std::env::temp_dir().join(format!("hub-oauth-no-manifest-{}", random_url_safe(12)));
        assert!(admission_at(&root, &root.join("hub.sqlite3"))
            .unwrap()
            .is_none());
        assert!(!root.exists());
    }

    #[test]
    fn owned_marker_database_scope_and_plain_manifest_are_required() {
        let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join(".local/sync-closure-20261008/oauth-scope-tests");
        let root = base.join(random_url_safe(12));
        fs::create_dir_all(&root).unwrap();
        let path = root.join(MANIFEST);
        fs::write(&path, br#"{"format":"hub-dida-oauth-integration","formatVersion":1,"runId":"0123456789abcdef0123456789abcdef","libraryId":null}"#).unwrap();
        let database = root.join("hub.sqlite3");
        assert!(admission_at(&root, &database).is_err());
        fs::write(root.join(".hub-isolated-runtime-v1"), b"foreign marker").unwrap();
        assert!(admission_at(&root, &database).is_err());
        fs::write(
            root.join(".hub-isolated-runtime-v1"),
            b"Hub isolated runtime v1\n",
        )
        .unwrap();
        assert!(admission_at(&root, &base.join("other.sqlite3")).is_err());
        fs::write(&path, vec![b' '; 8193]).unwrap();
        assert!(admission_at(&root, &database).is_err());
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(admission_at(&root, &database).is_err());
        assert!(!database.exists());
        assert!(root
            .canonicalize()
            .unwrap()
            .starts_with(base.canonicalize().unwrap()));
        fs::remove_dir_all(root).unwrap();
    }
}
