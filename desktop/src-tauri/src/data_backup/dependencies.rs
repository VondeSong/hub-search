use super::*;
use std::collections::BTreeSet;

fn table(c: &Connection, name: &str) -> Result<bool, String> {
    c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [name],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

fn dependency(id: String, kind: &str, name: String, source: PathBuf, include: bool) -> Dependency {
    let available = files::reject_links(&source).is_ok() && source.is_dir();
    let source = fs::canonicalize(&source).unwrap_or(source);
    Dependency {
        id,
        kind: kind.into(),
        name,
        source_path: source.to_string_lossy().into(),
        included: include && available,
        archive_path: None,
        available,
    }
}

pub(super) fn discover(
    database: &Path,
    root: &Path,
    include: bool,
    warnings: &mut Vec<String>,
) -> Result<Vec<Dependency>, String> {
    let c = readonly(database)?;
    let mut result = Vec::new();
    if table(&c, "libraries")? {
        let mut q = c.prepare("SELECT id,name,location FROM libraries WHERE provider='obsidian' AND location IS NOT NULL AND trim(location)<>'' ORDER BY id").map_err(|e| e.to_string())?;
        let rows = q
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (id, name, path) = row.map_err(|e| e.to_string())?;
            result.push(dependency(
                id,
                "obsidian",
                name,
                PathBuf::from(path),
                include,
            ));
        }
    }
    let mut q = c.prepare("SELECT key,value FROM metadata WHERE key LIKE 'craft_backup_config:%' OR key='collection_storage_v1' ORDER BY key").map_err(|e| e.to_string())?;
    let rows = q
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (key, raw) = row.map_err(|e| e.to_string())?;
        let value: serde_json::Value =
            serde_json::from_str(&raw).map_err(|_| format!("外部数据位置设置损坏：{key}"))?;
        if key.starts_with("craft_backup_config:") {
            let destination = value["destination"]
                .as_str()
                .ok_or("Craft 备份缺少目标目录")?;
            let name = value["vaultName"]
                .as_str()
                .ok_or("Craft 备份缺少 Vault 名称")?;
            let source = Path::new(destination).join(format!(
                "{} - 备份",
                crate::craft_export::sanitize_component(name, "Craft")
            ));
            // Craft archives are Hub-owned state; they always travel with Hub.
            result.push(dependency(key, "craftBackup", name.into(), source, true));
        } else if value["mode"].as_str() == Some("obsidian") {
            if let Some(path) = value["vaultPath"].as_str().filter(|s| !s.trim().is_empty()) {
                result.push(dependency(
                    key,
                    "reading",
                    "阅读资料目录".into(),
                    PathBuf::from(path),
                    include,
                ));
            }
        }
    }
    for item in &mut result {
        // Restored source folders are now owned by the selected data root and
        // are already part of collect_local, even when external capture is off.
        if item.available {
            if let Ok(relative) = Path::new(&item.source_path).strip_prefix(root) {
                let relative = relative.to_string_lossy().replace('\\', "/");
                if relative.starts_with("external-sources/")
                    || relative.starts_with("collection-files/")
                {
                    item.included = true;
                    item.archive_path = Some(relative);
                }
            }
        }
        if matches!(item.kind.as_str(), "obsidian" | "reading") && !item.included {
            // Independently managed Obsidian vaults are reattached by the user.
            continue;
        }
        if !item.available {
            warning(
                warnings,
                format!("外部来源当前不可用：{}（{}）", item.name, item.source_path),
            );
        } else if !item.included {
            warning(
                warnings,
                format!(
                    "未包含外部来源原目录：{}（{}）",
                    item.name, item.source_path
                ),
            );
        }
    }
    Ok(result)
}

pub(super) fn collect(
    root: &Path,
    dependencies: &mut [Dependency],
    inputs: &mut Vec<InputFile>,
    warnings: &mut Vec<String>,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let mut selected: BTreeMap<PathBuf, String> = BTreeMap::new();
    // Parents first: a Vault also used for reading is copied only once.
    let mut order: Vec<usize> = (0..dependencies.len()).collect();
    order.sort_by_key(|i| {
        Path::new(&dependencies[*i].source_path)
            .components()
            .count()
    });
    for index in order {
        let dependency = &mut dependencies[index];
        if !dependency.included {
            continue;
        }
        let source = files::existing_directory(Path::new(&dependency.source_path))?;
        if source == root || root.starts_with(&source) {
            return Err(format!(
                "外部来源不能包含 Hub 数据目录：{}",
                source.display()
            ));
        }
        if let Some((parent, relative)) = selected
            .iter()
            .find(|(parent, _)| source.starts_with(parent))
        {
            let suffix = source
                .strip_prefix(parent)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            dependency.archive_path = Some(if suffix.is_empty() {
                relative.clone()
            } else {
                format!("{relative}/{suffix}")
            });
            continue;
        }
        if source.starts_with(root) {
            let relative = source
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            if relative.starts_with("external-sources/")
                || relative.starts_with("collection-files/")
            {
                dependency.archive_path = Some(relative.clone());
                selected.insert(source, relative);
                continue;
            }
        }
        let digest = format!("{:x}", Sha256::digest(dependency.source_path.as_bytes()));
        let name = source
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or("外部目录名称无效")?;
        files::safe_relative(name)?;
        let relative = format!("external-sources/{}/{name}", &digest[..24]);
        files::walk(
            &source,
            &source,
            &mut |path, _| {
                checkpoint(cancel)?;
                let suffix = path
                    .strip_prefix(&source)
                    .map_err(|e| e.to_string())?
                    .to_str()
                    .ok_or("外部文件名不是有效 Unicode")?
                    .replace('\\', "/");
                let hash = files::hash_file(path, cancel)?;
                inputs.push(files::input(
                    path,
                    format!("{relative}/{suffix}"),
                    Some(hash),
                )?);
                Ok(())
            },
            warnings,
            cancel,
            true,
        )?;
        dependency.archive_path = Some(relative.clone());
        selected.insert(source, relative);
    }
    Ok(())
}

/// Ensure every registered cached object is present. Craft backup originals are
/// materialized at their content-addressed local path so restored reads are local.
pub(super) fn check_references(
    database: &Path,
    inputs: &mut Vec<InputFile>,
    dependencies: &mut Vec<Dependency>,
    warnings: &mut Vec<String>,
    complete: &mut bool,
) -> Result<(), String> {
    let c = readonly(database)?;
    if !table(&c, "blobs")? {
        return Ok(());
    }
    let backups = table(&c, "craft_backup_files")?;
    let mut present: BTreeSet<String> = inputs
        .iter()
        .map(|file| file.relative.to_lowercase())
        .collect();
    let sizes: BTreeMap<_, _> = inputs
        .iter()
        .map(|file| (file.relative.to_lowercase(), file.size))
        .collect();
    let mut q = c
        .prepare("SELECT hash,size FROM blobs ORDER BY hash")
        .map_err(|e| e.to_string())?;
    let rows = q
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, u64>(1)?)))
        .map_err(|e| e.to_string())?;
    let mut missing = 0u64;
    for row in rows {
        let (hash, size) = row.map_err(|e| e.to_string())?;
        if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("数据库含无效附件哈希，无法备份".into());
        }
        let hash = hash.to_ascii_lowercase();
        let relative = format!("blobs-v1/{}/{hash}", &hash[..2]);
        if present.contains(&relative) {
            if sizes.get(&relative).is_some_and(|value| *value != size) {
                return Err(format!("附件大小与数据库不一致：{hash}"));
            }
            continue;
        }
        let path: Option<String> = if backups {
            // An exact hash may have multiple archived copies; select a readable
            // existing candidate, then archive::write checks its SHA256.
            let mut lookup = c
                .prepare(
                    "SELECT path FROM craft_backup_files WHERE hash=?1 AND size=?2 ORDER BY path",
                )
                .map_err(|e| e.to_string())?;
            let candidates = lookup
                .query_map(rusqlite::params![hash, size], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            let mut found = None;
            for candidate in candidates {
                let candidate = candidate.map_err(|e| e.to_string())?;
                let path = Path::new(&candidate);
                if files::reject_links(path).is_ok() && path.is_file() {
                    found = Some(candidate);
                    break;
                }
            }
            found
        } else {
            None
        };
        if let Some(path) = path {
            let input = files::input(Path::new(&path), relative.clone(), Some(hash.clone()))?;
            if input.size != size {
                return Err(format!("外部附件大小与数据库不一致：{hash}"));
            }
            inputs.push(input);
            present.insert(relative.clone());
            dependencies.push(Dependency {
                id: hash,
                kind: "externalAttachment".into(),
                name: "Craft 引用附件".into(),
                source_path: path,
                included: true,
                archive_path: Some(relative),
                available: true,
            });
        } else {
            missing += 1;
            *complete = false;
            warning(warnings, format!("未找到已登记的本地附件：{hash}"));
        }
    }
    if missing > 0 {
        warning(
            warnings,
            format!("共 {missing} 个附件未包含；恢复后仍需从来源重新取得。"),
        );
    }
    Ok(())
}

pub(super) fn verify_external(
    dependencies: &[Dependency],
    inputs: &[InputFile],
    cancel: &AtomicBool,
) -> Result<(), String> {
    let mut verified = BTreeSet::new();
    let by_relative: BTreeMap<_, _> = inputs
        .iter()
        .map(|item| (item.relative.as_str(), item))
        .collect();
    for dependency in dependencies.iter().filter(|d| d.included) {
        checkpoint(cancel)?;
        let source = PathBuf::from(&dependency.source_path);
        if !verified.insert(source.clone()) {
            continue;
        }
        let prefix = dependency
            .archive_path
            .as_deref()
            .ok_or("外部来源缺少备份位置")?;
        if dependency.kind == "externalAttachment" {
            let item = by_relative.get(prefix).ok_or("附件未进入备份清单")?;
            // A previous preparation may already have materialized this exact
            // target. collect_local then owns the input without a saved hash.
            // Compare both real files rather than treating that as a change.
            let expected = match &item.expected_hash {
                Some(hash) => hash.clone(),
                None => files::hash_file(&item.source, cancel)?,
            };
            if expected != files::hash_file(&source, cancel)? {
                return Err("外部附件在备份期间变化".into());
            }
            continue;
        }
        let mut actual = BTreeSet::new();
        files::walk(
            &source,
            &source,
            &mut |path, _| {
                let suffix = path
                    .strip_prefix(&source)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .replace('\\', "/");
                let relative = format!("{prefix}/{suffix}");
                actual.insert(relative.clone());
                let item = by_relative
                    .get(relative.as_str())
                    .ok_or("外部目录在备份期间新增了文件，请停止来源编辑后重试")?;
                let current = files::hash_file(path, cancel)?;
                if item
                    .expected_hash
                    .as_ref()
                    .is_some_and(|hash| hash != &current)
                {
                    return Err(format!("外部来源在备份期间变化：{}", path.display()));
                }
                Ok(())
            },
            &mut Vec::new(),
            cancel,
            true,
        )?;
        let expected: BTreeSet<_> = inputs
            .iter()
            .filter(|v| v.relative.starts_with(&format!("{prefix}/")))
            .map(|v| v.relative.clone())
            .collect();
        if actual != expected {
            return Err("外部目录在备份期间新增或删除了文件，请停止来源编辑后重试".into());
        }
    }
    Ok(())
}

pub(super) fn collect_reading_assets(
    database: &Path,
    inputs: &mut Vec<InputFile>,
    dependencies: &mut Vec<Dependency>,
    warnings: &mut Vec<String>,
    complete: &mut bool,
    cancel: &AtomicBool,
    legacy: Option<&legacy_media_paths::Plan>,
) -> Result<(), String> {
    let c = readonly(database)?;
    let path_key = |path: &Path| crate::library_location::path_key(path);
    let mut present: BTreeSet<_> = inputs.iter().map(|item| path_key(&item.source)).collect();
    let mut archived: BTreeSet<_> = inputs.iter().map(|item| item.relative.clone()).collect();
    for table_name in [
        "collection_saved_media",
        "collection_owned_assets",
        "reading_media_outbox",
    ] {
        if !table(&c, table_name)? {
            continue;
        }
        let has_path: bool = c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name='path')",
                [table_name],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !has_path {
            continue;
        }
        let external_source = if table_name != "reading_media_outbox"
            && table(&c, "collection_local_source_items")?
        {
            " AND NOT EXISTS(SELECT 1 FROM collection_local_source_items local WHERE local.item_key=media.item_key)"
        } else {
            ""
        };
        let mut statement = c
            .prepare(&format!(
                "SELECT DISTINCT path FROM \"{table_name}\" media WHERE path IS NOT NULL AND path<>''{external_source}{}", media_policy::external_clause(table_name)
            ))
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for row in rows {
            checkpoint(cancel)?;
            let original = row.map_err(|e| e.to_string())?;
            if table_name == "reading_media_outbox"
                && legacy.is_some_and(|plan| plan.ignore_outbox_path(&original))
            {
                continue;
            }
            let path = PathBuf::from(&original);
            if !path.is_absolute() {
                continue;
            }
            if present.contains(&path_key(&path)) {
                continue;
            }
            if !path.is_file() {
                *complete = false;
                warning(warnings, format!("未找到阅读附件：{original}"));
                continue;
            }
            files::reject_links(&path)?;
            let hash = files::hash_file(&path, cancel)?;
            let name = path
                .file_name()
                .and_then(|v| v.to_str())
                .ok_or("阅读附件名称无效")?;
            files::safe_relative(name)?;
            let relative = format!("collection-files/recovered-assets/{hash}/{name}");
            if let Some(existing) = inputs.iter().find(|input| input.relative == relative) {
                let expected = existing
                    .expected_hash
                    .clone()
                    .map(Ok)
                    .unwrap_or_else(|| files::hash_file(&existing.source, cancel))?;
                if expected != hash || existing.size != fs::metadata(&path).map_err(io_error)?.len()
                {
                    return Err(
                        "数据目录内已有附件副本与原件不一致，引用未更改；请保留原件进行恢复".into(),
                    );
                }
            }
            if archived.insert(relative.clone()) {
                if inputs.len() >= MAX_FILES {
                    return Err("备份超过文件数量上限".into());
                }
                inputs.push(files::input(&path, relative.clone(), Some(hash.clone()))?);
            }
            present.insert(path_key(&path));
            dependencies.push(Dependency {
                id: format!("{:x}", Sha256::digest(original.as_bytes())),
                kind: "externalAttachment".into(),
                name: "阅读附件".into(),
                source_path: original,
                included: true,
                archive_path: Some(relative),
                available: true,
            });
        }
    }
    Ok(())
}
