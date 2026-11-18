use super::*;
use std::path::Path;

fn hash(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}
fn manifest_hash(manifest: &Value) -> String {
    hash(manifest.to_string().as_bytes())
}
fn identity(config: &Config, manifest: &Value) -> String {
    let digest = hash(
        format!(
            "hub-handoff-v1\n{}\n{}",
            config_view(config)["binding"],
            manifest_hash(manifest)
        )
        .as_bytes(),
    );
    format!(
        "{}-{}-{}-{}-{}",
        &digest[..8],
        &digest[8..12],
        &digest[12..16],
        &digest[16..20],
        &digest[20..32]
    )
}
fn field<'a>(args: &'a Value, name: &str) -> Result<&'a str, String> {
    args[name].as_str().ok_or_else(|| format!("缺少 {name}"))
}
fn file_hash(value: &str) -> Result<&str, String> {
    if value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        Ok(value)
    } else {
        Err("成果哈希无效".into())
    }
}
fn guard(root: &Path, args: &Value, expected: &str) -> Result<(), String> {
    let prepared = crate::agent_work::prepare_analysis_handoff(root, args)?;
    if manifest_hash(&prepared.manifest) != expected {
        return Err("交接内容或来源版本已变化，请重新预览确认".into());
    }
    Ok(())
}

pub(super) async fn run(app: &AppHandle, config: &Config, args: Value) -> Result<Value, String> {
    let root = crate::active_data_root(app)?;
    match field(&args, "op")? {
        "drafts" => request(config, Method::GET, "/v1/handoffs", None, false)
            .await
            .map_err(Into::into),
        "preview" | "send" => {
            let prepared = crate::agent_work::prepare_analysis_handoff(&root, &args)?;
            let sha = manifest_hash(&prepared.manifest);
            let identity = identity(config, &prepared.manifest);
            if args["op"] == "preview" {
                return Ok(
                    json!({"manifest":prepared.manifest,"manifestSha256":sha,"id":identity,"endpoint":config.endpoint}),
                );
            }
            if args["confirm"] != true
                || args["expectedSha256"] != sha
                || args["expectedId"] != identity
                || args["expectedEndpoint"] != config.endpoint
            {
                return Err("内容或目标连接已变化，请重新预览并确认这一版交接".into());
            }
            let capabilities = request(config, Method::GET, "/v1/threads", None, false).await?;
            if capabilities["handoffs"] != true {
                return Err("当前个人云端尚不支持文件交接，请先更新网关".into());
            }
            let base = format!("/v1/handoffs/{identity}");
            let receipt = request(
                config,
                Method::POST,
                &base,
                Some(json!({"manifest":prepared.manifest})),
                false,
            )
            .await?;
            if receipt["handoff"]["id"] != identity {
                return Err("云端返回了不匹配的交接编号".into());
            }
            if receipt["handoff"]["state"] == "uploading" {
                for (file, data) in prepared.files {
                    if let Err(error) = guard(&root, &args, &sha) {
                        let _ = request(
                            config,
                            Method::POST,
                            &format!("{base}/withdraw"),
                            Some(json!({"confirm":true})),
                            false,
                        )
                        .await;
                        return Err(error);
                    }
                    if receipt["handoff"]["missing"]
                        .as_array()
                        .is_some_and(|a| a.contains(&file["sha256"]))
                    {
                        request(
                            config,
                            Method::POST,
                            &format!(
                                "{base}/files/{}",
                                file["sha256"].as_str().ok_or("缺少文件哈希")?
                            ),
                            Some(json!({"data":STANDARD.encode(data)})),
                            false,
                        )
                        .await?;
                    }
                }
                if let Err(error) = guard(&root, &args, &sha) {
                    let _ = request(
                        config,
                        Method::POST,
                        &format!("{base}/withdraw"),
                        Some(json!({"confirm":true})),
                        false,
                    )
                    .await;
                    return Err(error);
                }
            }
            let receipt = request(
                config,
                Method::POST,
                &format!("{base}/commit"),
                Some(json!({"confirm":true})),
                false,
            )
            .await?;
            if receipt["handoff"]["id"] != identity
                || receipt["handoff"]["state"] != "published"
                || manifest_hash(&receipt["handoff"]["manifest"]) != sha
            {
                return Err("云端交接结果未核对成功，请沿用原选择重试".into());
            }
            crate::agent_work::record_analysis_handoff(&root, &args, &receipt)?;
            Ok(receipt)
        }
        "file" => file(app, config, &args).await,
        "withdraw" => {
            let thread = id(field(&args, "thread")?)?;
            if args["confirm"] != true {
                return Err("请明确确认撤回云端交接".into());
            }
            let value = request(
                config,
                Method::POST,
                &format!("/v1/handoffs/{thread}/withdraw"),
                Some(json!({"confirm":true})),
                false,
            )
            .await?;
            cache::remove(&root, config, &format!("/v1/threads/{thread}"))?;
            Ok(value)
        }
        _ => Err("未知交接操作".into()),
    }
}

async fn file(app: &AppHandle, config: &Config, args: &Value) -> Result<Value, String> {
    let root = crate::active_data_root(app)?;
    let thread = id(field(args, "thread")?)?;
    let sha = file_hash(field(args, "sha256")?)?;
    let url = format!("/v1/threads/{thread}");
    let snapshot = if args["mode"] == "status" {
        cache::get(&root, config, &url)?
    } else {
        cache::read(&root, config, &url).await?
    };
    if snapshot["accessDenied"] == true {
        return Err("设备访问已撤销，云端离线缓存已清除".into());
    }
    let handoff = &snapshot["thread"]["handoff"];
    if handoff["state"] != "published" {
        return Err("交接未发布或已撤回，不能取回这份成果".into());
    }
    let meta = handoff["manifest"]["files"]
        .as_array()
        .and_then(|a| {
            a.iter()
                .find(|f| f["sha256"] == sha && f["name"] == args["name"])
        })
        .ok_or("文件不在交接清单中")?;
    let bytes = meta["bytes"]
        .as_u64()
        .filter(|b| *b > 0 && *b <= 10 * 1024 * 1024)
        .ok_or("成果大小无效")?;
    let name = meta["name"]
        .as_str()
        .filter(|n| !n.is_empty() && !n.contains(['/', '\\', ':', '\0']) && n.len() <= 200)
        .ok_or("成果文件名无效")?;
    let blob = crate::blob_store::BlobStore::open(&root.join("blobs-v1"))?;
    let local = blob.path_for(sha)?;
    let available = local.is_file()
        && std::fs::metadata(&local)
            .map_err(|_| "本机文件不可读")?
            .len()
            == bytes
        && crate::craft_backup::hash_file(&local)? == sha;
    if args["mode"] == "status" && !available {
        return Ok(
            json!({"state":"notDownloaded","name":name,"sha256":sha,"offline":snapshot["cached"]==true}),
        );
    }
    if !available {
        if snapshot["cached"] == true {
            return Err("这份文件还没下载到本机，请连接个人云端后取回".into());
        }
        let downloaded = request(
            config,
            Method::GET,
            &format!("/v1/handoffs/{thread}/files/{sha}"),
            None,
            false,
        )
        .await?;
        let raw = downloaded["data"]
            .as_str()
            .filter(|s| s.len() <= ((10 * 1024 * 1024 + 2) / 3) * 4)
            .ok_or("云端文件内容无效")?;
        let data = STANDARD.decode(raw).map_err(|_| "云端文件编码无效")?;
        if data.len() as u64 != bytes
            || hash(&data) != sha
            || downloaded["sha256"] != sha
            || downloaded["bytes"] != bytes
        {
            return Err("云端文件大小或哈希不符，未保存".into());
        }
        let saved = blob.put(&data)?;
        if saved.hash != sha {
            return Err("本机文件回读校验失败".into());
        }
    }
    let offline = snapshot["cached"] == true;
    match args["mode"].as_str().unwrap_or("download") {
        "download" => Ok(
            json!({"state":"downloaded","name":name,"sha256":sha,"bytes":bytes,"offline":offline}),
        ),
        "export" | "status" => export(app, config, args, meta, &local, offline),
        _ => Err("未知文件操作".into()),
    }
}

fn export(
    app: &AppHandle,
    config: &Config,
    args: &Value,
    meta: &Value,
    local: &Path,
    offline: bool,
) -> Result<Value, String> {
    let name = meta["name"].as_str().ok_or("文件名缺失")?;
    let sha = meta["sha256"].as_str().ok_or("文件哈希缺失")?;
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let root = crate::active_data_root(app)?;
        let key = format!("export:{}:{sha}:{name}", args["thread"]);
        let state = app.state::<crate::AndroidSourceOpener>();
        let plugin = &state.0;
        if args["mode"] == "status" {
            if let Ok(saved) = cache::get(&root, config, &key) {
                if let Some(token) = saved["token"].as_str() {
                    let status = plugin
                        .run_mobile_plugin::<Value>(
                            "attachmentExportStatus",
                            json!({"token":token}),
                        )
                        .map_err(|e| e.to_string())?;
                    if status["state"] == "verified"
                        && (status["sha256"] != sha
                            || status["bytes"] != meta["bytes"]
                            || status["name"] != name)
                    {
                        return Err("系统保存回执与所选文件不一致".into());
                    }
                    return Ok(status);
                }
            }
            return Ok(json!({"state":"downloaded","name":name,"sha256":sha,"offline":offline}));
        }
        let mime = match meta["type"].as_str().unwrap_or("") {
            "md" => "text/markdown",
            "csv" => "text/csv",
            "json" => "application/json",
            "pdf" => "application/pdf",
            "png" => "image/png",
            "svg" => "image/svg+xml",
            "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            _ => "application/octet-stream",
        };
        let prepared=plugin.run_mobile_plugin::<Value>("prepareAttachmentExport",json!({"sourcePath":local.to_string_lossy(),"hash":sha,"fileName":name,"mimeType":mime})).map_err(|e|e.to_string())?;
        let token = prepared["token"].as_str().ok_or("原生保存记录缺失")?;
        cache::put(&root, config, &key, &json!({"token":token}))?;
        plugin
            .run_mobile_plugin::<()>("openFlashcardBackupExport", json!({"token":token}))
            .map_err(|e| e.to_string())?;
        return Ok(json!({"state":"saveDialogOpened","name":name,"sha256":sha,"offline":offline}));
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = config;
        if args["mode"] == "status" {
            return Ok(json!({"state":"downloaded","name":name,"sha256":sha,"offline":offline}));
        }
        let destination = std::path::PathBuf::from(field(args, "destination")?);
        let parent = destination.parent().ok_or("保存目录无效")?;
        crate::craft_backup::reject_links(parent)?;
        if !destination.is_absolute()
            || destination
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
            || destination.extension() != Path::new(name).extension()
        {
            return Err("请选择保留原扩展名的完整保存路径".into());
        }
        let parent = parent.canonicalize().map_err(|_| "保存目录不存在")?;
        if parent.starts_with(
            crate::active_data_root(app)?
                .canonicalize()
                .map_err(|_| "数据目录不可读")?,
        ) {
            return Err("请选择 Hub 数据目录之外的位置".into());
        }
        let target = parent.join(destination.file_name().ok_or("保存文件名无效")?);
        crate::craft_backup::reject_links(&target)?;
        if target.exists() {
            if crate::craft_backup::hash_file(&target)? != sha {
                return Err("目标已有其他内容，未覆盖，请换一个文件名".into());
            }
        } else {
            use std::io::Write;
            let data = std::fs::read(local).map_err(|_| "本机成果不可读")?;
            if hash(&data) != sha {
                return Err("本机成果已变化，未保存".into());
            }
            let mut output = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
                .map_err(|_| "无法创建保存副本，未覆盖已有文件")?;
            output
                .write_all(&data)
                .and_then(|_| output.sync_all())
                .map_err(|_| "写入结果未确认，请检查目标文件")?;
        }
        if crate::craft_backup::hash_file(&target)? != sha {
            return Err("保存回读校验失败".into());
        }
        Ok(
            json!({"state":"verified","name":name,"sha256":sha,"bytes":meta["bytes"],"offline":offline}),
        )
    }
}
