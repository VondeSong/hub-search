//! Feature-only admission for two explicitly created real Dida integration tasks.
//! The normal application has neither this module nor these invoke commands.
use super::*;

const MANIFEST: &str = "dida-source-integration-v1.json";
const PROJECT: &str = "6ac7703cebcf7c000000048b";
const TASKS: [&str; 2] = ["6ac77040ebcf7c0000000494", "6ac77062ebcf7c00000004ae"];
const NAME: &str = "滴答来源隔离联调";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    format: String,
    format_version: u8,
    run_id: String,
    account_id: String,
    project_id: String,
    task_ids: Vec<String>,
}

impl Manifest {
    fn validate(&self) -> Result<(), String> {
        let tasks = self
            .task_ids
            .iter()
            .map(String::as_str)
            .collect::<BTreeSet<_>>();
        if self.format != "hub-dida-source-integration"
            || self.format_version != 1
            || !valid_id(&self.run_id)
            || !valid_id(&self.account_id)
            || self.project_id != PROJECT
            || self.task_ids.len() != TASKS.len()
            || tasks != TASKS.into_iter().collect()
        {
            return Err("隔离滴答授权清单与本轮两条新建任务不一致".into());
        }
        Ok(())
    }

    fn library(&self) -> String {
        format!("integration-dida-source:{}", self.run_id)
    }

    fn metadata(&self) -> String {
        json!({
            "preference":{"accountId":self.account_id},
            "integration":{"formatVersion":1,"runId":self.run_id,
                "projectId":self.project_id,"taskIds":self.task_ids}
        })
        .to_string()
    }
}

/// Check only the explicit owned paths; never inspect another browser profile.
fn ordinary_path(path: &Path) -> Result<(), String> {
    use std::os::windows::fs::MetadataExt;
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) if metadata.file_attributes() & 0x400 != 0 => {
                return Err("隔离联调路径不能经过重解析点".into());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("无法核对隔离联调路径".into()),
        }
    }
    Ok(())
}

fn authorized(app: &AppHandle) -> Result<(PathBuf, PathBuf, Manifest), String> {
    let root = crate::isolated_runtime::root().ok_or("滴答联调入口仅限显式隔离运行")?;
    ordinary_path(root)?;
    if fs::read(root.join(".hub-isolated-runtime-v1")).map_err(|_| "隔离目录所有权标记不可读取")?
        != b"Hub isolated runtime v1\n"
    {
        return Err("隔离目录所有权标记无效".into());
    }
    let manifest_path = root.join(MANIFEST);
    ordinary_path(&manifest_path)?;
    let info = fs::symlink_metadata(&manifest_path).map_err(|_| "缺少隔离滴答授权清单")?;
    if !info.is_file() || info.len() > 16 * 1024 {
        return Err("隔离滴答授权清单无效或过大".into());
    }
    let manifest: Manifest =
        serde_json::from_slice(&fs::read(&manifest_path).map_err(|_| "无法读取隔离滴答授权清单")?)
            .map_err(|_| "隔离滴答授权清单格式无效")?;
    manifest.validate()?;
    let path = database_path(app)?;
    if path.parent() != Some(root) {
        return Err("滴答联调数据库不属于本隔离目录".into());
    }
    for owned in [
        path.clone(),
        path.with_extension("sqlite3-wal"),
        path.with_extension("sqlite3-shm"),
        root.join("blobs-v1"),
    ] {
        ordinary_path(&owned)?;
    }
    Ok((root.to_path_buf(), path, manifest))
}

fn endpoint(value: &str) -> Result<String, String> {
    let url = url::Url::parse(value).map_err(|_| "滴答联调桥地址无效")?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none_or(|port| port == 0)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("滴答联调桥仅允许带明确端口的 HTTP 127.0.0.1 地址".into());
    }
    Ok(url.into())
}

fn verify_library(c: &Connection, manifest: &Manifest) -> Result<(), String> {
    let actual: (String, i64, String) = c
        .query_row(
            "SELECT provider,enabled,COALESCE(metadata_json,'') FROM libraries WHERE id=?1",
            [manifest.library()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|_| "请先初始化本轮隔离滴答资料库")?;
    if actual != (PROVIDER_DIDA365.into(), 0, manifest.metadata()) {
        return Err("隔离滴答资料库身份或停用状态已变化".into());
    }
    Ok(())
}

fn verify_storage_scope(c: &Connection, root: &Path) -> Result<(), String> {
    let cfg = storage::config(c)?;
    if cfg.mode == "database" {
        return Ok(());
    }
    if cfg.mode == "obsidian" {
        let path = Path::new(&cfg.vault_path);
        ordinary_path(path)?;
        if fs::canonicalize(path)
            .ok()
            .is_some_and(|path| path.starts_with(root))
        {
            return Ok(());
        }
    }
    Err("滴答联调保存位置必须位于本隔离目录".into())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Prepared {
    library_id: String,
    database_path: String,
    account_hash: String,
    project_id: String,
    task_ids: Vec<String>,
    library_enabled: bool,
}

#[tauri::command]
pub(crate) fn prepare_dida_source_integration(app: AppHandle) -> Result<Prepared, String> {
    let (root, path, manifest) = authorized(&app)?;
    let library = manifest.library();
    let operation = library_runtime::begin(&root, &library, "初始化滴答来源隔离联调")?;
    let (c, _writer) = open_write_database(&path)?;
    storage::schema(&c)?;
    schema(&c)?;
    verify_storage_scope(&c, &root)?;
    operation.commit(|| {
        c.execute(
            "INSERT INTO libraries(id,provider,name,location,enabled,added_at,last_sync,metadata_json)
             VALUES(?1,?2,?3,NULL,0,?4,NULL,?5) ON CONFLICT(id) DO NOTHING",
            params![library, PROVIDER_DIDA365, NAME, now_timestamp(), manifest.metadata()],
        )
        .map_err(|_| "无法建立隔离滴答资料库")?;
        verify_library(&c, &manifest)
    })?;
    Ok(Prepared {
        library_id: library,
        database_path: crate::display_local_path(&path),
        account_hash: storage::hash(manifest.account_id.as_bytes()),
        project_id: manifest.project_id,
        task_ids: manifest.task_ids,
        library_enabled: false,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReceiptSummary {
    item_key: String,
    snapshot_hash: String,
    post_hash: String,
    local_verified: bool,
    delete_state: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunReport {
    processed: bool,
    receipt: Option<ReceiptSummary>,
    error: Option<String>,
}

#[tauri::command]
pub(crate) async fn run_dida_source_integration(
    app: AppHandle,
    state: State<'_, AppState>,
    endpoint_url: String,
    admission_token: String,
    task_id: String,
) -> Result<RunReport, String> {
    let (root, path, manifest) = authorized(&app)?;
    if !manifest.task_ids.contains(&task_id) {
        return Err("此任务不属于本轮两条新建滴答联调任务".into());
    }
    let endpoint = endpoint(&endpoint_url)?;
    if !(32..=512).contains(&admission_token.len())
        || !admission_token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Err("滴答联调桥临时令牌无效".into());
    }
    let library = manifest.library();
    let admission = library_runtime::admission(&root, &library)?;
    let _admission = admission.lock().await;
    let operation = Arc::new(library_runtime::begin(
        &root,
        &library,
        "处理指定滴答联调任务",
    )?);
    checkpoint(&app, &operation)?;
    {
        let c = open_database(&path)?;
        verify_library(&c, &manifest)?;
        verify_storage_scope(&c, &root)?;
    }
    let session = McpSession {
        space_id: library.clone(),
        space_name: NAME.into(),
        endpoint,
        access_token: admission_token.clone(),
        session_id: None,
        protocol_version: "2025-03-26".into(),
        deep_link_template: None,
        rate_limiter: Arc::new(CraftRateLimiter::default()),
    };
    // No session cache, OAuth credential store, project enumeration, or broad sync.
    let _running = Running::begin();
    let result = process(
        &app,
        &state,
        &library,
        NAME,
        &session,
        &task_id,
        &manifest.project_id,
        &operation,
    )
    .await;
    let (processed, error) = match result {
        Ok(processed) => (processed, None),
        Err(error) => {
            let error = error
                .replace(&admission_token, "[redacted]")
                .chars()
                .take(1000)
                .collect::<String>();
            operation.failed(&error);
            let (c, _writer) = open_write_database(&path)?;
            if let Some(record) = receipt(&c, &library, &task_id)? {
                operation.commit(|| outcome(&c, &record.key, "pending", &error))?;
            }
            (false, Some(error))
        }
    };
    let record = receipt(&open_database(&path)?, &library, &task_id)?.map(|r| ReceiptSummary {
        item_key: r.key,
        snapshot_hash: r.snapshot,
        post_hash: r.post_hash,
        local_verified: r.verified,
        delete_state: r.state,
    });
    Ok(RunReport {
        processed,
        receipt: record,
        error,
    })
}
