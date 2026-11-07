//! Bring Hub-owned external originals into the selected data root before a move/copy.
//! Obsidian source vaults remain external. Original files are retained.
use super::*;
use serde_json::{json, Value};

fn path_state(database: &Path) -> Result<String, String> {
    let c = readonly(database)?;
    let mut hash = Sha256::new();
    for (table, sql) in [
        ("metadata", "SELECT key,value FROM metadata WHERE key LIKE 'craft_backup_config:%' OR key='collection_storage_v1' ORDER BY key"),
        ("libraries", "SELECT id,COALESCE(location,'') FROM libraries ORDER BY id"),
        ("blobs", "SELECT hash,CAST(size AS TEXT) FROM blobs ORDER BY hash"),
        ("craft_backup_files", "SELECT path,hash FROM craft_backup_files ORDER BY path,hash"),
        ("collection_saved_media", "SELECT DISTINCT path,'' FROM collection_saved_media WHERE path IS NOT NULL ORDER BY path"),
        ("collection_owned_assets", "SELECT DISTINCT path,'' FROM collection_owned_assets WHERE path IS NOT NULL ORDER BY path"),
        ("reading_media_outbox", "SELECT DISTINCT path,'' FROM reading_media_outbox WHERE path IS NOT NULL ORDER BY path"),
    ] {
        let exists:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",[table],|r|r.get(0)).map_err(|e|e.to_string())?;
        if !exists {continue;}
        let mut q=c.prepare(sql).map_err(|e|e.to_string())?;
        let rows=q.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(|e|e.to_string())?;
        hash.update(table.as_bytes());
        for row in rows { let (a,b)=row.map_err(|e|e.to_string())?; hash.update((a.len() as u64).to_le_bytes());hash.update(a.as_bytes());hash.update((b.len() as u64).to_le_bytes());hash.update(b.as_bytes()); }
    }
    Ok(format!("{:x}", hash.finalize()))
}

pub(crate) fn consolidate(
    root: &Path,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(Progress),
) -> Result<Value, String> {
    let root = files::existing_directory(root)?;
    let _maintenance = crate::data_portability::maintenance_lock(&root)?;
    let id = identifier();
    let mut run = consolidation_manifest::Run::begin(&root, &id)?;
    match consolidate_inner(&root, &id, &mut run, cancel, progress) {
        Ok(mut result) => {
            if run.finish("complete").is_err() {
                result["warnings"].as_array_mut().unwrap().push(json!(
                    "数据已收拢；文件归属清单终态未能保存，本次文件将保留。"
                ));
            }
            Ok(result)
        }
        Err(error) => {
            let terminal = if cancel.load(Ordering::Relaxed) {
                "cancelled"
            } else {
                "failed"
            };
            match run.finish(terminal) {
                Ok(()) => Err(error),
                Err(_) => Err(format!(
                    "{error}；文件归属清单终态未能保存，本次残留将保留。"
                )),
            }
        }
    }
}

fn consolidate_inner(
    root: &Path,
    id: &str,
    run: &mut consolidation_manifest::Run,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(Progress),
) -> Result<Value, String> {
    let database = root.join(DATABASE);
    let before = path_state(&database)?;
    let snapshot_path = state_directory(&root)?.join(format!("consolidate-{id}.sqlite3"));
    phase(progress, "snapshot");
    snapshot(&database, &snapshot_path, cancel)?;
    if before != path_state(&snapshot_path)? {
        return Err("整理开始时来源位置发生变化，请停止来源编辑后重试".into());
    }
    let legacy = legacy_media_paths::plan(&snapshot_path, &root, cancel)?;
    let mut inputs = Vec::new();
    let mut warnings = Vec::new();
    let mut complete = true;
    // These files already live inside the folder and a whole-folder copy keeps
    // them. Archive-only exclusions (WebView, indexes, unfinished exports) are
    // not missing-data warnings for this operation.
    files::collect_local(&root, &mut inputs, &mut Vec::new(), cancel)?;
    let mut dependencies = dependencies::discover(&snapshot_path, &root, false, &mut warnings)?;
    dependencies.retain(|d| d.kind == "craftBackup");
    if dependencies.iter().any(|d| !d.available) {
        complete = false;
    }
    dependencies::collect(&root, &mut dependencies, &mut inputs, &mut warnings, cancel)?;
    dependencies::check_references(
        &snapshot_path,
        &mut inputs,
        &mut dependencies,
        &mut warnings,
        &mut complete,
    )?;
    dependencies::collect_reading_assets(
        &snapshot_path,
        &mut inputs,
        &mut dependencies,
        &mut warnings,
        &mut complete,
        cancel,
        Some(&legacy),
    )?;
    let pending = {
        let c = readonly(&snapshot_path)?;
        let available: i64 = c.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('source_items','documents','libraries')",
            [], |r|r.get(0),
        ).map_err(|e|e.to_string())?;
        if available != 3 {
            Vec::new()
        } else {
            let mut q = c
                .prepare(
                    "SELECT l.provider,COUNT(*) FROM source_items s
                 JOIN libraries l ON l.id=s.space_id AND l.provider=s.provider
                 JOIN documents d ON d.space_id=s.space_id AND d.id=s.document_id
                 WHERE l.provider IN ('craft','dida365')
                   AND s.source_type IN ('craft_attachment','dida_attachment')
                   AND s.blob_hash IS NULL GROUP BY l.provider",
                )
                .map_err(|e| e.to_string())?;
            let rows = q
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            rows
        }
    };
    for (provider, count) in pending {
        complete = false;
        let name = if provider == "craft" {
            "Craft"
        } else {
            "滴答清单"
        };
        warning(&mut warnings, format!("{name} 尚有 {count} 条当前附件引用未登记本地副本；已保存的文件会收拢，但尚不能确认附件全部离线可读。"));
    }
    // A failed earlier preparation must never cause old partial files to be overwritten.
    let relocate = |relative: &str| {
        format!(
            "external-sources/prepared-{id}/{}",
            relative
                .strip_prefix("external-sources/")
                .unwrap_or(relative)
        )
    };
    for input in &mut inputs {
        if !input.source.starts_with(&root) && input.relative.starts_with("external-sources/") {
            input.relative = relocate(&input.relative);
        }
    }
    for dep in &mut dependencies {
        if !Path::new(&dep.source_path).starts_with(&root) {
            if let Some(relative) = dep
                .archive_path
                .as_mut()
                .filter(|p| p.starts_with("external-sources/"))
            {
                *relative = relocate(relative);
            }
        }
    }
    let bytes: u64 = inputs
        .iter()
        .filter(|i| !i.source.starts_with(&root))
        .map(|i| i.size)
        .sum();
    files::check_space(&root, bytes.saturating_add(16 * 1024 * 1024))?;
    let prepared_prefix = format!("external-sources/prepared-{id}/");
    let mut planned = vec![consolidation_manifest::ManifestFile {
        relative_path: format!("data-backup-v1/consolidate-{id}.sqlite3"),
        bytes: fs::metadata(&snapshot_path).map_err(io_error)?.len(),
        sha256: files::hash_file(&snapshot_path, cancel)?,
        anchor_id: None,
        anchor_suffix: None,
        created_by_run: true,
    }];
    for input in &mut inputs {
        if input.source.starts_with(root) || !input.relative.starts_with(&prepared_prefix) {
            continue;
        }
        let target = root.join(files::safe_relative(&input.relative)?);
        files::reject_links(&target)?;
        // Existing files are verified and reused below, but are never claimed.
        if target.exists() {
            continue;
        }
        let expected = match &input.expected_hash {
            Some(value) => value.clone(),
            None => files::hash_file(&input.source, cancel)?,
        };
        input.expected_hash = Some(expected.clone());
        let (dependency, suffix) = dependencies
            .iter()
            .filter(|dependency| dependency.kind == "craftBackup" && dependency.included)
            .filter_map(|dependency| {
                let prefix = format!("{}/", dependency.archive_path.as_deref()?);
                input
                    .relative
                    .strip_prefix(prefix.as_str())
                    .map(|suffix| (dependency, suffix))
            })
            .min_by_key(|(_, suffix)| suffix.len())
            .ok_or("整理文件缺少对应的 Craft 备份归属")?;
        planned.push(consolidation_manifest::ManifestFile {
            relative_path: input.relative.clone(),
            bytes: input.size,
            sha256: expected,
            anchor_id: Some(dependency.id.clone()),
            anchor_suffix: Some(suffix.into()),
            created_by_run: false,
        });
    }
    run.plan(planned)?;
    let mut copied = 0u64;
    let mut copied_bytes = 0u64;
    phase(progress, "collectOwnedFiles");
    for input in &inputs {
        checkpoint(cancel)?;
        if input.source.starts_with(&root) {
            continue;
        }
        let target = root.join(files::safe_relative(&input.relative)?);
        files::reject_links(&target)?;
        let expected = match &input.expected_hash {
            Some(value) => value.clone(),
            None => files::hash_file(&input.source, cancel)?,
        };
        if target.exists() {
            if fs::metadata(&target).map_err(io_error)?.len() != input.size
                || files::hash_file(&target, cancel)? != expected
            {
                return Err(format!(
                    "数据目录已有不同内容，未覆盖：{}",
                    target.display()
                ));
            }
            continue;
        }
        fs::create_dir_all(target.parent().ok_or("整理文件缺少父目录")?).map_err(io_error)?;
        files::reject_links(&target)?;
        let temporary = target.with_extension(format!("hub-copy-{id}.partial"));
        let mut source = files::open_stable(&input.source)?;
        let mut output = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(io_error)?;
        let written = std::io::copy(&mut source, &mut output).map_err(io_error)?;
        output.sync_all().map_err(io_error)?;
        drop(output);
        drop(source);
        if written != input.size || files::hash_file(&temporary, cancel)? != expected {
            return Err("整理后的文件校验未通过，原文件保留".into());
        }
        files::publish_new_file(&temporary, &target)?;
        if input.relative.starts_with(&prepared_prefix) {
            run.created(&input.relative);
        }
        copied += 1;
        copied_bytes += written;
        progress(Progress {
            phase: "collectOwnedFiles".into(),
            completed_bytes: copied_bytes,
            total_bytes: Some(bytes),
            completed_files: copied,
            total_files: None,
        });
    }
    dependencies::verify_external(&dependencies, &inputs, cancel)?;
    legacy.verify(&root, cancel)?;
    let mappings: Vec<PathMapping> = dependencies
        .iter()
        .filter(|d| d.included && !Path::new(&d.source_path).starts_with(&root))
        .filter_map(|d| {
            d.archive_path.as_ref().map(|relative| PathMapping {
                source_path: d.source_path.clone(),
                restored_path: root.join(relative).to_string_lossy().into(),
                kind: d.kind.clone(),
                id: d.id.clone(),
            })
        })
        .collect();
    let (mut c, _writer) = crate::open_write_database(&database)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    if before != path_state(&database)? {
        return Err("整理期间资料库或附件位置发生变化，原位置设置保留，请重试".into());
    }
    legacy.apply(&tx)?;
    crate::data_portability::apply_source_mappings(&tx, &mappings, false)?;
    tx.commit().map_err(|e| e.to_string())?;
    let result = json!({"root":root,"ready":complete,"copiedFiles":copied,"copiedBytes":copied_bytes,"warnings":warnings,"pathMappings":mappings,"obsidianOriginalsIncluded":false,"legacyMediaPaths":legacy.summary()});
    // Publication has happened: follow-up receipt errors must not hide the result.
    let mut result = result;
    if files::write_new_json(
        &state_directory(&root)?.join(format!("consolidate-{id}.json")),
        &result,
    )
    .is_err()
    {
        result["warnings"]
            .as_array_mut()
            .unwrap()
            .push(json!("数据已收拢；整理记录未能保存。"));
    }
    let _ = fs::remove_file(&snapshot_path);
    Ok(result)
}
