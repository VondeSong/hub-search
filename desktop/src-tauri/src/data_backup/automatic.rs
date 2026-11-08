use super::*;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct AutoBackupConfig {
    pub enabled: bool,
    pub destination: String,
    pub interval_hours: u64,
    pub keep_count: u32,
    pub include_external_sources: bool,
    pub last_attempt_at: Option<i64>,
    pub last_success_at: Option<i64>,
    pub last_error: Option<String>,
}
impl Default for AutoBackupConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            destination: String::new(),
            interval_hours: 24,
            keep_count: 7,
            include_external_sources: false,
            last_attempt_at: None,
            last_success_at: None,
            last_error: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    dataset_id: String,
    operation_id: String,
    path: String,
    checksum: String,
    created_at: i64,
}

fn config_path(root: &Path) -> PathBuf {
    root.join(STATE).join("automatic.json")
}

fn config_lock(root: &Path) -> Result<fs::File, String> {
    let path = state_directory(root)?.join("automatic.lock");
    files::reject_links(&path)?;
    let mut options = fs::OpenOptions::new();
    options.write(true).read(true).create(true).truncate(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0);
    }
    let file = options
        .open(&path)
        .map_err(|e| format!("自动备份正在处理，请稍后重试：{e}"))?;
    #[cfg(not(windows))]
    crate::file_lock::try_lock(&file, false).map_err(|e| format!("自动备份正在处理：{e}"))?;
    Ok(file)
}

pub(crate) fn load_auto_config(root: &Path) -> Result<AutoBackupConfig, String> {
    let path = config_path(root);
    files::reject_links(&path)?;
    if !path.exists() {
        return Ok(AutoBackupConfig::default());
    }
    let mut config: AutoBackupConfig = files::read_json(&path)?;
    // Source vaults are independently moved by the user; Hub-owned Craft originals
    // are included regardless of this legacy field.
    config.include_external_sources = false;
    validate(&config)?;
    Ok(config)
}

fn validate(config: &AutoBackupConfig) -> Result<(), String> {
    if !(1..=720).contains(&config.interval_hours) {
        return Err("自动备份间隔应为 1 至 720 小时".into());
    }
    if !(1..=100).contains(&config.keep_count) {
        return Err("自动备份保留份数应为 1 至 100".into());
    }
    if config.enabled && config.destination.trim().is_empty() {
        return Err("请先选择自动备份目录".into());
    }
    Ok(())
}

pub(crate) fn save_auto_config(
    root: &Path,
    requested: &AutoBackupConfig,
) -> Result<AutoBackupConfig, String> {
    validate(requested)?;
    let root = files::existing_directory(root)?;
    let _lease = config_lock(&root)?;
    let mut config = requested.clone();
    if !config.destination.trim().is_empty() {
        let target = files::existing_directory(Path::new(&config.destination))?;
        if target.starts_with(&root) || root.starts_with(&target) {
            return Err("自动备份目录请选择数据目录外的独立文件夹".into());
        }
        config.destination = target.to_string_lossy().into();
    }
    // Runtime observations are owned by the scheduler, never by settings input.
    let current = load_auto_config(&root)?;
    config.last_attempt_at = current.last_attempt_at;
    config.last_success_at = current.last_success_at;
    config.last_error = current.last_error;
    files::replace_json(&config_path(&root), &config)?;
    load_auto_config(&root)
}

pub(crate) fn run_due(
    root: &Path,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(Progress),
) -> Result<Option<BackupSummary>, String> {
    // The OS lease covers claim, backup, receipt and retention. Repeated timers
    // and another process cannot execute the same due interval simultaneously.
    let quick = load_auto_config(root)?;
    if !quick.enabled {
        return Ok(None);
    }
    let _lease = config_lock(root)?;
    let mut config = load_auto_config(root)?;
    if !config.enabled
        || config
            .last_attempt_at
            .is_some_and(|last| now().saturating_sub(last) < (config.interval_hours * 3600) as i64)
    {
        return Ok(None);
    }
    config.last_attempt_at = Some(now());
    config.last_error = None;
    files::replace_json(&config_path(root), &config)?;
    let result: Result<BackupSummary, String> = (|| {
        let destination = files::existing_directory(Path::new(&config.destination))?;
        let identity = dataset_id(root)?;
        let name = format!("hub-auto-{identity}-{}-{}.hubbackup", now(), identifier());
        let options = BackupOptions {
            destination: destination.join(name).to_string_lossy().into(),
            include_external_sources: config.include_external_sources,
        };
        let mut summary = backup_kind(root, &options, true, cancel, progress)?;
        if !summary.complete {
            warning(
                &mut summary.warnings,
                "本次备份包含未收录或缺失的来源，已保留先前备份；本次文件不会参与自动轮换。".into(),
            );
            return Ok(summary);
        }
        // Publication has committed. Receipt/header/retention failures must
        // preserve the delivered path and cannot turn this into a failed backup.
        let retention: Result<(), String> = (|| {
            let header = archive::header(Path::new(&summary.path))?;
            let receipt = Receipt {
                dataset_id: identity.clone(),
                operation_id: header.operation_id,
                path: summary.path.clone(),
                checksum: summary.checksum.clone(),
                created_at: summary.created_at,
            };
            let receipts = state_directory(root)?.join("receipts");
            files::reject_links(&receipts)?;
            fs::create_dir_all(&receipts).map_err(io_error)?;
            files::write_new_json(
                &receipts.join(format!("{}.json", receipt.operation_id)),
                &receipt,
            )?;
            // No receipt means no rotation; earlier good copies remain intact.
            retain(
                &receipts,
                &destination,
                &identity,
                &receipt.operation_id,
                config.keep_count as usize,
                cancel,
            )
        })();
        if let Err(error) = retention {
            warning(
                &mut summary.warnings,
                format!("新备份已保存，轮换记录或旧备份保留未完成：{error}"),
            );
        }
        Ok(summary)
    })();
    match result {
        Ok(mut summary) => {
            config.last_success_at = Some(summary.created_at);
            config.last_error = None;
            if let Err(error) = files::replace_json(&config_path(root), &config) {
                warning(
                    &mut summary.warnings,
                    format!("自动备份已保存；调度记录保存失败：{error}"),
                );
            }
            Ok(Some(summary))
        }
        Err(error) => {
            config.last_error = Some(error.clone());
            if let Err(save) = files::replace_json(&config_path(root), &config) {
                return Err(format!("{error}；无法保存自动备份结果：{save}"));
            }
            Err(error)
        }
    }
}

fn retain(
    receipts: &Path,
    destination: &Path,
    dataset: &str,
    newest: &str,
    keep: usize,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let mut candidates = Vec::new();
    for item in fs::read_dir(receipts).map_err(io_error)? {
        checkpoint(cancel)?;
        let item = item.map_err(io_error)?;
        let path = item.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let receipt: Receipt = files::read_json(&path)?;
        if receipt.dataset_id != dataset {
            continue;
        }
        let target = PathBuf::from(&receipt.path);
        if !target.is_file() {
            continue;
        }
        files::reject_links(&target)?;
        let target = fs::canonicalize(&target).map_err(io_error)?;
        if target.parent() != Some(destination)
            || !target
                .file_name()
                .and_then(|s| s.to_str())
                .is_some_and(|name| {
                    name.starts_with(&format!("hub-auto-{dataset}-"))
                        && name.ends_with(".hubbackup")
                })
        {
            continue;
        }
        // A receipt alone is not ownership proof. Inspect full bytes, identity,
        // automatic marker and recorded checksum before any file is eligible.
        let (header, summary) = archive::read(&target, None, cancel, &mut |_| {})?;
        if !header.automatic
            || header.dataset_id != dataset
            || header.operation_id != receipt.operation_id
            || summary.checksum != receipt.checksum
        {
            return Err("自动备份记录与文件身份不一致，保留全部旧文件".into());
        }
        candidates.push((receipt, target, path));
    }
    // The just-published receipt is always newest even when timestamps tie or
    // the wall clock moved backwards. Never retire the backup just delivered.
    candidates.sort_by(|a, b| {
        (b.0.operation_id == newest)
            .cmp(&(a.0.operation_id == newest))
            .then_with(|| b.0.created_at.cmp(&a.0.created_at))
            .then_with(|| b.0.operation_id.cmp(&a.0.operation_id))
    });
    for (receipt, target, record) in candidates.into_iter().skip(keep) {
        checkpoint(cancel)?;
        files::reject_links(&target)?;
        // Reverify immediately before deletion; replacing a candidate after the
        // inventory must not let retention remove someone else's file.
        files::delete_verified(&target, |file| {
            let (header, summary) = archive::read_file(&target, file, None, cancel, &mut |_| {})?;
            if header.operation_id != receipt.operation_id || summary.checksum != receipt.checksum {
                return Err("自动备份在轮换前变化，已停止清理".into());
            }
            Ok(())
        })?;
        fs::remove_file(&record).map_err(io_error)?;
    }
    Ok(())
}
