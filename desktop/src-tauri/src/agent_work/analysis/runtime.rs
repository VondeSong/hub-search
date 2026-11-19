use super::*;
const SPEC: &str = include_str!("../../../../runtime/analysis/manifest.json");

fn verify_installation(
    directory: &Path,
    files: &[Value],
    control: &Control,
) -> Result<bool, String> {
    if files.is_empty() {
        return Ok(false);
    }
    // Keep every hash and link check, with bounded parallel reads of the
    // already-installed runtime. Each new execution checks it again.
    let workers = std::thread::available_parallelism().map_or(1, |n| n.get().min(4));
    std::thread::scope(|scope| {
        let handles: Vec<_> = files
            .chunks(files.len().div_ceil(workers))
            .map(|batch| {
                scope.spawn(move || -> Result<bool, String> {
                    for file in batch {
                        control.check()?;
                        let Some(name) = file["name"].as_str() else {
                            return Ok(false);
                        };
                        let relative = Path::new(name);
                        if relative.as_os_str().is_empty()
                            || relative.components().any(|component| {
                                !matches!(component, std::path::Component::Normal(_))
                            })
                        {
                            return Ok(false);
                        }
                        let path = directory.join(relative);
                        if crate::craft_backup::reject_links(&path).is_err()
                            || !crate::craft_backup::hash_file(&path)
                                .is_ok_and(|hash| file["sha256"] == hash)
                        {
                            return Ok(false);
                        }
                    }
                    Ok(true)
                })
            })
            .collect();
        let mut valid = true;
        for handle in handles {
            valid &= handle.join().map_err(|_| "分析环境完整性检查中断")??;
        }
        Ok(valid)
    })
}

pub(super) fn state(root: &Path) -> Value {
    let spec: Value = serde_json::from_str(SPEC).unwrap_or(Value::Null);
    let id = spec["id"].as_str().unwrap_or("unavailable");
    let dir = root.join("runtimes").join(id);
    let cached = dir.join("verified-files.json").is_file() && dir.join("python.exe").is_file();
    json!({"id":id,"manifestSha256":digest(SPEC.as_bytes()),"state":if cached{"cachedNeedsIntegrityVerification"}else{"needsPinnedPreparation"},"verification":"Full pinned file hashes are checked before every execution. Presence alone is not readiness."})
}
pub(super) fn prepare(root: &Path, control: &Control) -> Result<PathBuf, String> {
    if !cfg!(all(windows, target_arch = "x86_64")) {
        return Err("当前分析运行时仅支持Windows x64".into());
    }
    static INSTALL: Mutex<()> = Mutex::new(());
    let _guard = INSTALL
        .try_lock()
        .map_err(|_| "分析环境正在准备，请稍后重试；本轮尚未运行脚本")?;
    let spec: Value = serde_json::from_str(SPEC).map_err(|_| "分析环境清单损坏")?;
    let dir = root
        .join("runtimes")
        .join(spec["id"].as_str().ok_or("环境身份缺失")?);
    crate::craft_backup::reject_links(&dir)?;
    std::fs::create_dir_all(&dir).map_err(|_| "无法创建分析环境")?;
    let receipt = dir.join("verified-files.json");
    if receipt.is_file() {
        let saved: Value =
            serde_json::from_slice(&std::fs::read(&receipt).map_err(|_| "环境回执不可读")?)
                .map_err(|_| "环境回执损坏")?;
        if saved["manifestSha256"] == digest(SPEC.as_bytes()) {
            if let Some(files) = saved["files"].as_array() {
                if verify_installation(&dir, files, control)? {
                    return Ok(dir);
                }
            }
        }
        return Err(
            "分析环境文件已变化，完整性校验未通过；本轮未运行脚本，需修复固定运行环境后重试".into(),
        );
    }
    let mut files = std::collections::BTreeMap::new();
    for archive in spec["archives"].as_array().ok_or("环境下载清单无效")? {
        control.check()?;
        let url = archive["url"].as_str().ok_or("环境下载地址缺失")?;
        if !url.starts_with("https://www.python.org/ftp/python/")
            && !url.starts_with("https://files.pythonhosted.org/packages/")
        {
            return Err("环境下载源不受支持".into());
        }
        let data = tauri::async_runtime::block_on(async {
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(90))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| "无法准备环境下载")?;
            let mut response = client
                .get(url)
                .send()
                .await
                .map_err(|_| "分析环境下载失败")?
                .error_for_status()
                .map_err(|_| "分析环境下载被拒绝")?;
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| "分析环境下载中断")?
            {
                control.check()?;
                if bytes.len() + chunk.len() > 64 * 1024 * 1024 {
                    return Err("环境包超过容量".to_string());
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok::<_, String>(bytes)
        })?;
        if archive["sha256"] != digest(&data) {
            return Err("分析环境包哈希不符".into());
        }
        let target = dir.join(archive["target"].as_str().ok_or("环境目录缺失")?);
        let mut zip =
            zip::ZipArchive::new(std::io::Cursor::new(data)).map_err(|_| "环境包解压失败")?;
        let mut expanded = 0u64;
        for i in 0..zip.len() {
            control.check()?;
            let mut entry = zip.by_index(i).map_err(|_| "环境包内容损坏")?;
            let relative = entry.enclosed_name().ok_or("环境包路径非法")?.to_owned();
            if entry.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000) {
                return Err("环境包含链接".into());
            }
            expanded = expanded.saturating_add(entry.size());
            if expanded > 256 * 1024 * 1024 {
                return Err("环境解压超过容量".into());
            }
            let path = target.join(relative);
            crate::craft_backup::reject_links(&path)?;
            if entry.is_dir() {
                std::fs::create_dir_all(&path).map_err(|_| "无法创建环境子目录")?;
                continue;
            }
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|_| "无法创建环境目录")?;
            }
            let mut file = std::fs::File::create(&path).map_err(|_| "无法保存环境文件")?;
            std::io::copy(&mut entry, &mut file).map_err(|_| "环境解压写入失败")?;
            files.insert(
                path.strip_prefix(&dir)
                    .map_err(|_| "环境路径不在目录内")?
                    .to_string_lossy()
                    .replace('\\', "/"),
                crate::craft_backup::hash_file(&path)?,
            );
        }
    }
    let config = "python313.zip\n.\nLib/site-packages\nimport site\n";
    std::fs::write(dir.join("python313._pth"), config).map_err(|_| "无法配置独立Python环境")?;
    files.insert("python313._pth".into(), digest(config.as_bytes()));
    let files: Vec<_> = files
        .into_iter()
        .map(|(name, hash)| json!({"name":name,"sha256":hash}))
        .collect();
    std::fs::write(
        receipt,
        json!({"manifestSha256":digest(SPEC.as_bytes()),"files":files}).to_string(),
    )
    .map_err(|_| "无法保存环境回执")?;
    Ok(dir)
}
