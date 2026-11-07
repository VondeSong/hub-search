//! Rebase only owned path fields; never rewrite note text, IDs, URLs or event history.
use super::*;
use rusqlite::params;

fn table_exists(c: &Connection, table: &str) -> Result<bool, String> {
    c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [table],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}
fn relocate_value(value: &str, old: &Path, new: &Path) -> Option<String> {
    let value = crate::sources::display_local_path(Path::new(value)).replace('\\', "/");
    let old = crate::sources::display_local_path(old).replace('\\', "/");
    let prefix = old.trim_end_matches('/');
    #[cfg(windows)]
    let matches = value.eq_ignore_ascii_case(prefix)
        || value
            .to_lowercase()
            .starts_with(&format!("{}/", prefix.to_lowercase()));
    #[cfg(not(windows))]
    let matches = value == prefix || value.starts_with(&format!("{prefix}/"));
    if !matches {
        return None;
    }
    let suffix = value.get(prefix.len()..)?.trim_start_matches('/');
    if suffix.split('/').any(|component| component == "..") {
        return None;
    }
    let relocated = if suffix.is_empty() {
        new.to_path_buf()
    } else {
        new.join(suffix)
    };
    Some(crate::sources::display_local_path(&relocated))
}
fn remap_column(
    c: &Connection,
    table: &str,
    column: &str,
    old: &Path,
    new: &Path,
) -> Result<(), String> {
    if !table_exists(c, table)? {
        return Ok(());
    }
    let sql = format!("SELECT rowid,\"{column}\" FROM \"{table}\" WHERE \"{column}\" IS NOT NULL");
    let mut q = c.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = q
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(q);
    for (id, value) in rows {
        if let Some(value) = relocate_value(&value, old, new) {
            if table == "collection_owned_assets" && column == "path" {
                // Windows aliases can describe the same owned file twice. A
                // rebase makes their association keys identical; retain that
                // association once instead of aborting the entire migration.
                c.execute(
                    "DELETE FROM collection_owned_assets WHERE rowid=?2 AND EXISTS(
                       SELECT 1 FROM collection_owned_assets other
                       WHERE other.item_key=collection_owned_assets.item_key
                         AND other.path=?1 AND other.rowid<>?2)",
                    params![value, id],
                )
                .map_err(|e| e.to_string())?;
            }
            if table == "craft_backup_files" && column == "path" {
                // Normal and extended Windows paths can register the same
                // original. Keep its newest cache stamp at the rebased key;
                // registrations for other content hashes remain independent.
                c.execute(
                    "UPDATE craft_backup_files SET (size,mtime,mime_type)=(
                       SELECT size,mtime,mime_type FROM craft_backup_files incoming WHERE incoming.rowid=?2)
                     WHERE path=?1 AND rowid<>?2
                       AND hash=(SELECT hash FROM craft_backup_files WHERE rowid=?2)
                       AND CAST(mtime AS INTEGER)<(SELECT CAST(mtime AS INTEGER) FROM craft_backup_files WHERE rowid=?2)",
                    params![value, id],
                ).map_err(|e|e.to_string())?;
                c.execute(
                    "DELETE FROM craft_backup_files WHERE rowid=?2 AND EXISTS(
                       SELECT 1 FROM craft_backup_files other
                       WHERE other.hash=craft_backup_files.hash AND other.path=?1 AND other.rowid<>?2)",
                    params![value, id],
                ).map_err(|e|e.to_string())?;
            }
            c.execute(
                &format!("UPDATE \"{table}\" SET \"{column}\"=?1 WHERE rowid=?2"),
                params![value, id],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
pub(crate) fn remap_paths(c: &Connection, old: &Path, new: &Path) -> Result<(), String> {
    for (table, column) in [
        ("libraries", "location"),
        ("collection_roots", "root"),
        ("collection_owned_assets", "path"),
        ("collection_saved_media", "path"),
        ("reading_media_outbox", "path"),
        ("craft_backup_files", "path"),
    ] {
        remap_column(c, table, column, old, new)?;
    }
    let mut q=c.prepare("SELECT key,value FROM metadata WHERE key='collection_storage_v1' OR key LIKE 'craft_backup_config:%'").map_err(|e|e.to_string())?;
    let rows = q
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(q);
    for (key, raw) in rows {
        let mut value: Value =
            serde_json::from_str(&raw).map_err(|e| format!("保存位置配置损坏：{e}"))?;
        let mut changed = false;
        for field in ["vaultPath", "destination", "replicaDestination"] {
            if let Some(updated) = value[field]
                .as_str()
                .and_then(|v| relocate_value(v, old, new))
            {
                value[field] = json!(updated);
                changed = true;
            }
        }
        if changed {
            c.execute(
                "UPDATE metadata SET value=?1 WHERE key=?2",
                params![value.to_string(), key],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
pub(crate) fn prepare_opened_root(root: &Path, imported: bool) -> Result<(), String> {
    resume_restore(root)?;
    let path = root.join("craft-search.sqlite3");
    let (mut c, _writer) = crate::open_write_database(&path)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    prepare_connection(&tx, root, imported, None)?;
    tx.commit().map_err(|e| e.to_string())
}

fn prepare_connection(
    c: &Connection,
    root: &Path,
    imported: bool,
    installation_id: Option<&str>,
) -> Result<(), String> {
    let old: Option<String> = c
        .query_row(
            "SELECT value FROM metadata WHERE key='hub_data_root'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(old) = old.as_deref() {
        if !old.is_empty()
            && crate::library_location::path_key(Path::new(old))
                != crate::library_location::path_key(root)
        {
            remap_paths(c, Path::new(old), root)?;
        }
    }
    c.execute("INSERT INTO metadata(key,value) VALUES('hub_data_root',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[crate::sources::display_local_path(root)]).map_err(|e|e.to_string())?;
    if let Some(id) = installation_id {
        c.execute("INSERT INTO metadata(key,value) VALUES('hub_installation_id',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[id]).map_err(|e|e.to_string())?;
    }
    if imported {
        crate::user_profile::seal_legacy_import(c)?;
        // Existing immutable review events keep their original author. Only future
        // events use a fresh device identity after another copy is adopted.
        c.execute(
            "DELETE FROM metadata WHERE key='flashcard_sync_device_id'",
            [],
        )
        .map_err(|e| e.to_string())?;
        for key in ["cloud_sync_auto", "flashcard_sync_auto"] {
            c.execute("INSERT INTO metadata(key,value) VALUES(?1,'0') ON CONFLICT(key) DO UPDATE SET value=excluded.value",[key]).map_err(|e|e.to_string())?;
        }
    }
    Ok(())
}

fn initialize_connection_host(
    c: &Connection,
    root: &Path,
    installation_id: &str,
) -> Result<(), String> {
    let old_root = crate::metadata_string(c, "hub_data_root");
    let old_host = crate::metadata_string(c, "hub_installation_id");
    let transferred = (!old_root.is_empty()
        && crate::library_location::path_key(Path::new(&old_root))
            != crate::library_location::path_key(root))
        || (!old_host.is_empty() && old_host != installation_id);
    prepare_connection(c, root, transferred, Some(installation_id))
}

pub(super) fn initialize_root_host(root: &Path, installation_id: &str) -> Result<(), String> {
    resume_restore(root)?;
    let (mut c, _writer) = crate::open_write_database(&root.join("craft-search.sqlite3"))?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    initialize_connection_host(&tx, root, installation_id)?;
    tx.commit().map_err(|e| e.to_string())
}

fn apply_restore_mappings(
    c: &Connection,
    mappings: &[data_backup::PathMapping],
) -> Result<(), String> {
    apply_source_mappings(c, mappings, true)
}
pub(crate) fn apply_source_mappings(
    c: &Connection,
    mappings: &[data_backup::PathMapping],
    clear_replica: bool,
) -> Result<(), String> {
    let mut ordered: Vec<_> = mappings.iter().collect();
    ordered.sort_by_key(|mapping| {
        (
            mapping.kind == "dataRoot",
            std::cmp::Reverse(
                mapping
                    .source_path
                    .replace('\\', "/")
                    .split('/')
                    .filter(|part| !part.is_empty())
                    .count(),
            ),
        )
    });
    for mapping in ordered {
        remap_paths(
            c,
            Path::new(&mapping.source_path),
            Path::new(&mapping.restored_path),
        )?;
    }
    // A Craft config stores the parent of "<name> - 备份", while its dependency
    // identifies that child directory. A generic prefix rebase cannot update it.
    for mapping in mappings
        .iter()
        .filter(|mapping| mapping.kind == "craftBackup")
    {
        if !mapping.id.starts_with("craft_backup_config:") {
            return Err("Craft 备份映射身份无效".into());
        }
        let raw: String = c
            .query_row(
                "SELECT value FROM metadata WHERE key=?1",
                [&mapping.id],
                |r| r.get(0),
            )
            .map_err(|_| "Craft 备份映射没有对应设置")?;
        let mut config: crate::craft_backup::BackupConfig =
            serde_json::from_str(&raw).map_err(|e| format!("Craft 备份设置损坏：{e}"))?;
        if mapping.id != format!("craft_backup_config:{}", config.library_id) {
            return Err("Craft 备份映射与资料库不匹配".into());
        }
        let restored = Path::new(&mapping.restored_path);
        let expected = format!(
            "{} - 备份",
            crate::craft_export::sanitize_component(&config.vault_name, "Craft")
        );
        if restored.file_name().and_then(|name| name.to_str()) != Some(expected.as_str()) {
            return Err("恢复的 Craft 备份文件夹名称不匹配".into());
        }
        config.destination = crate::sources::display_local_path(
            restored.parent().ok_or("恢复的 Craft 备份目录缺少父目录")?,
        );
        if clear_replica {
            config.replica_destination = None;
        }
        c.execute(
            "UPDATE metadata SET value=?1 WHERE key=?2",
            params![
                serde_json::to_string(&config).map_err(|e| e.to_string())?,
                mapping.id
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(super) fn completed_restore_warnings(warnings: &[String]) -> Vec<String> {
    let done = "路径映射已应用并核验；自动云同步已暂停，请核对账号和资料库后手动恢复。";
    let device = "后续复习使用新的设备身份；已有复习与同步历史保留原作者。";
    let mut result: Vec<_> = warnings
        .iter()
        .filter(|warning| {
            !warning.contains("打开前需由换机检查应用路径映射")
                && !warning.contains("换机后需为后续云同步生成新的设备身份")
                && warning.as_str() != done
                && warning.as_str() != device
        })
        .cloned()
        .collect();
    result.push(done.into());
    result.push(device.into());
    result
}

const RESTORE_MAPPING_MARKER: &str = "hub_restore_path_mappings_v1";
fn mapping_identity(mappings: &[data_backup::PathMapping]) -> Result<String, String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(mappings).map_err(|e| e.to_string())?)
    ))
}
fn normalized_restore_mappings(
    root: &Path,
    mappings: &[data_backup::PathMapping],
) -> Result<Vec<data_backup::PathMapping>, String> {
    let original = mappings
        .iter()
        .find(|mapping| mapping.kind == "dataRoot")
        .ok_or("恢复映射缺少数据根")?;
    if mappings
        .iter()
        .filter(|mapping| mapping.kind == "dataRoot")
        .count()
        != 1
    {
        return Err("恢复映射有重复数据根".into());
    }
    mappings
        .iter()
        .map(|mapping| {
            let mut normalized = mapping.clone();
            normalized.restored_path = relocate_value(
                &mapping.restored_path,
                Path::new(&original.restored_path),
                root,
            )
            .ok_or("恢复映射的目标不在恢复目录内")?;
            Ok(normalized)
        })
        .collect()
}
fn read_restore_report(root: &Path) -> Result<Value, String> {
    let report = root.join("data-backup-v1/restore-report.json");
    crate::craft_backup::reject_links(&report)?;
    if fs::metadata(&report)
        .map_err(|e| format!("无法读取恢复报告：{e}"))?
        .len()
        > 16 * 1024 * 1024
    {
        return Err("恢复报告过大，无法继续打开".into());
    }
    serde_json::from_slice(&fs::read(&report).map_err(|e| format!("无法读取恢复报告：{e}"))?)
        .map_err(|e| format!("恢复报告损坏：{e}"))
}
fn resume_restore(root: &Path) -> Result<(), String> {
    let mapping_file = root.join("data-backup-v1/restore-path-mappings.json");
    if !mapping_file.exists() {
        return Ok(());
    }
    crate::craft_backup::reject_links(&mapping_file)?;
    if fs::metadata(&mapping_file)
        .map_err(|e| e.to_string())?
        .len()
        > 16 * 1024 * 1024
    {
        return Err("恢复路径映射过大，无法继续打开".into());
    }
    let mappings: Vec<data_backup::PathMapping> =
        serde_json::from_slice(&fs::read(&mapping_file).map_err(|e| e.to_string())?)
            .map_err(|e| format!("恢复路径映射损坏：{e}"))?;
    let c = crate::open_database(&root.join("craft-search.sqlite3"))?;
    let recorded = crate::metadata_string(&c, RESTORE_MAPPING_MARKER);
    let expected = mapping_identity(&mappings)?;
    drop(c);
    if !recorded.is_empty() {
        if recorded != expected {
            return Err("已提交的恢复路径映射被改变，未继续打开资料库".into());
        }
        let report = read_restore_report(root)?;
        // The transaction can commit before verification/report persistence fails.
        // A marker alone must not let a later open bypass that unfinished step.
        if report["pathMappingsApplied"].as_bool() == Some(true)
            && report["pathMappingsIdentity"].as_str() == Some(expected.as_str())
        {
            return Ok(());
        }
    }
    finish_restore(root, &mappings)
}

fn apply_restore_once(
    c: &Connection,
    root: &Path,
    mappings: &[data_backup::PathMapping],
) -> Result<Vec<data_backup::PathMapping>, String> {
    let identity = mapping_identity(mappings)?;
    let recorded = crate::metadata_string(c, RESTORE_MAPPING_MARKER);
    let normalized = normalized_restore_mappings(root, mappings)?;
    if recorded.is_empty() {
        apply_restore_mappings(c, &normalized)?;
        prepare_connection(c, root, true, None)?;
        c.execute(
            "INSERT INTO metadata(key,value) VALUES(?1,?2)",
            params![RESTORE_MAPPING_MARKER, identity],
        )
        .map_err(|e| e.to_string())?;
    } else if recorded != identity {
        return Err("恢复映射与已提交状态不匹配".into());
    }
    Ok(normalized)
}
pub(super) fn finish_restore(
    root: &Path,
    mappings: &[data_backup::PathMapping],
) -> Result<(), String> {
    let path = root.join("craft-search.sqlite3");
    let (mut c, _writer) = crate::open_write_database(&path)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let normalized = apply_restore_once(&tx, root, mappings)?;
    tx.commit().map_err(|e| e.to_string())?;
    drop(c);
    drop(_writer);
    super::verify_database(root)?;
    let report = root.join("data-backup-v1/restore-report.json");
    let mut value = read_restore_report(root)?;
    let warnings: Vec<String> = serde_json::from_value(value["warnings"].clone())
        .map_err(|e| format!("恢复报告警告格式无效：{e}"))?;
    value["warnings"] = json!(completed_restore_warnings(&warnings));
    value["destination"] = json!(crate::sources::display_local_path(root));
    value["pathMappings"] = json!(normalized);
    value["pathMappingsApplied"] = json!(true);
    value["pathMappingsIdentity"] = json!(mapping_identity(mappings)?);
    value["verifiedAt"] = json!(crate::now_timestamp());
    super::atomic_write(
        &report,
        &serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?,
    )?;
    Ok(())
}

pub(super) async fn relocate_dependency(app: AppHandle, args: &Value) -> Result<Value, String> {
    let id = super::required(args, "id")?.to_string();
    let root = crate::active_data_root(&app)?;
    let dependency = data_backup::dependencies(&root)?
        .into_iter()
        .find(|d| d.id == id)
        .ok_or("来源清单已变化，请刷新后再试")?;
    let path = super::required(args, "path")?.to_string();
    if dependency.kind == "obsidian" {
        // Dependency IDs are transport identities; library ownership comes from
        // the authoritative source path, not an ID string prefix assumption.
        let c = crate::open_database(&root.join("craft-search.sqlite3"))?;
        let library =
            crate::library_location::obsidian_id_at(&c, Path::new(&dependency.source_path))?
                .ok_or("找不到此 Obsidian 资料库")?;
        drop(c);
        return Ok(json!(
            crate::relocate_obsidian_library(app, library, path).await?
        ));
    }
    if dependency.kind == "reading" {
        return Ok(json!(
            crate::relocate_collection_vault(app, dependency.source_path, path).await?
        ));
    }
    if dependency.kind != "craftBackup" {
        return Err("此附件位置请在对应资料库设置中重新连接。".into());
    }
    let app_for_work = app.clone();
    let result=tokio::task::spawn_blocking(move || -> Result<Value,String> {
        let _maintenance=super::maintenance_lock(&root)?;
        let state=app_for_work.state::<crate::AppState>();
        let _sync=state.sync_guard.try_lock().map_err(|_|"资料库仍在同步，请稍后重新定位")?;
        let mut target=Path::new(&path).canonicalize().map_err(|e|format!("无法访问所选备份目录：{e}"))?;
        crate::craft_backup::reject_links(&target)?;
        let old=PathBuf::from(&dependency.source_path);
        let configs=crate::craft_backup::configs(&root.join("craft-search.sqlite3"))?;
        let config=configs.into_iter().find(|cfg| {
            let configured=Path::new(&cfg.destination).join(format!("{} - 备份",crate::craft_export::sanitize_component(&cfg.vault_name,"Craft")));
            format!("craft_backup_config:{}",cfg.library_id)==dependency.id && crate::library_location::path_key(&configured)==crate::library_location::path_key(&old)
        }).ok_or("备份设置已经变化，请刷新")?;
        let history=crate::craft_backup::history(&target,&config.library_id)?;
        if history.is_empty() { return Err("所选目录没有属于此 Craft 空间的恢复点。请选择原始备份目录。".into()); }
        let store=crate::blob_store::BlobStore::open(&target.join("objects"))?;
        for snapshot in &history { if !crate::craft_backup::verify_objects(&store,snapshot).valid { return Err("所选备份有缺失或损坏的原件，未更改设置".into()); } }
        let expected=old.file_name().ok_or("原备份目录无效")?;
        if target.file_name()!=Some(expected) { return Err("请保留原始备份文件夹名称，以便关联同级阅读库。".into()); }
        if !target.starts_with(&root) {
            let mut source_config = config.clone();
            source_config.destination = crate::sources::display_local_path(target.parent().ok_or("备份没有父目录")?);
            let parent = data_backup::managed_craft_parent(&root.join("craft-search.sqlite3"),
                &format!("reconnect:{}:{}", config.library_id, crate::random_url_safe(16)), "")?;
            let (_, owned) = crate::craft_backup_migration::migrate(&source_config, &parent)?;
            target = owned;
        }
        let (mut c,_writer)=crate::open_write_database(&root.join("craft-search.sqlite3"))?;
        let tx=c.transaction().map_err(|e|e.to_string())?;
        remap_paths(&tx,&old,&target)?;
        let mut updated=config.clone();
        updated.destination=crate::sources::display_local_path(target.parent().ok_or("备份没有父目录")?);
        updated.replica_destination=None;
        let key=format!("craft_backup_config:{}",config.library_id);
        tx.execute("UPDATE metadata SET value=?1 WHERE key=?2",params![serde_json::to_string(&updated).map_err(|e|e.to_string())?,key]).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e|e.to_string())?;
        Ok(json!({"location":target,"warning":"请同时核对同级 Obsidian 阅读库及第二份备份的位置。"}))
    }).await.map_err(|e|e.to_string())??;
    let _ = app.emit("library-registry-updated", json!({"dependencyId":id}));
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE libraries(id TEXT PRIMARY KEY,location TEXT);
            CREATE TABLE documents(id TEXT PRIMARY KEY,markdown TEXT);
            CREATE TABLE collection_saved_media(item_key TEXT,path TEXT);
            CREATE TABLE flashcard_reviews(id TEXT PRIMARY KEY,device_id TEXT);
            INSERT INTO metadata VALUES('cloud_sync_auto','1'),('flashcard_sync_auto','1'),('flashcard_sync_device_id','source-device');").unwrap();
        crate::user_profile::ensure_schema(&c).unwrap();
        c.execute(
            "INSERT INTO user_profile_values VALUES('hub.favorite','preserved')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO flashcard_reviews VALUES('review','source-device')",
            [],
        )
        .unwrap();
        c
    }
    #[test]
    fn path_rebase_is_component_bounded_and_preserves_unrelated_content() {
        let old = Path::new("D:/Old/Data");
        let new = Path::new("E:/Moved");
        assert!(relocate_value("D:/Old/Database/a", old, new).is_none());
        assert!(relocate_value("https://host/D:/Old/Data/a", old, new).is_none());
        assert!(relocate_value("D:/Old/Data/../outside", old, new).is_none());
        for source in ["D:/Old/Data", "D:/Old/Data/"] {
            assert_eq!(
                relocate_value(source, old, new).unwrap().replace('\\', "/"),
                "E:/Moved"
            );
        }
        assert_eq!(
            relocate_value("D:/Old/Data/collection-files/a.png", old, new)
                .unwrap()
                .replace('\\', "/"),
            "E:/Moved/collection-files/a.png"
        );
    }
    #[test]
    fn first_upgrade_preserves_legacy_import_but_new_host_at_same_path_is_sealed_and_paused() {
        let c = fixture();
        let root = Path::new("D:/Data");
        initialize_connection_host(&c, root, "original-host").unwrap();
        assert_eq!(
            crate::metadata_string(&c, "user_profile_initialized_v1"),
            ""
        );
        assert_eq!(crate::metadata_string(&c, "cloud_sync_auto"), "1");
        initialize_connection_host(&c, root, "original-host").unwrap();
        assert_eq!(
            crate::metadata_string(&c, "flashcard_sync_device_id"),
            "source-device"
        );
        initialize_connection_host(&c, root, "new-host").unwrap();
        assert_eq!(
            crate::metadata_string(&c, "hub_installation_id"),
            "new-host"
        );
        assert_eq!(
            crate::metadata_string(&c, "user_profile_initialized_v1"),
            "1"
        );
        assert_eq!(crate::metadata_string(&c, "cloud_sync_auto"), "0");
        assert_eq!(crate::metadata_string(&c, "flashcard_sync_auto"), "0");
        assert_eq!(crate::metadata_string(&c, "flashcard_sync_device_id"), "");
        assert_eq!(
            c.query_row(
                "SELECT value FROM user_profile_values WHERE key='hub.favorite'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "preserved"
        );
        assert_eq!(
            c.query_row("SELECT device_id FROM flashcard_reviews", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "source-device"
        );
    }
    #[test]
    fn copied_root_merges_backup_path_aliases_without_losing_distinct_hashes() {
        let c = fixture();
        c.execute_batch("CREATE TABLE craft_backup_files(hash TEXT NOT NULL,path TEXT NOT NULL,size INTEGER NOT NULL,mtime TEXT NOT NULL,mime_type TEXT NOT NULL,PRIMARY KEY(hash,path))").unwrap();
        let old = Path::new("D:/Data");
        let new = Path::new("E:/Moved");
        initialize_connection_host(&c, old, "same-host").unwrap();
        for (hash, path, mtime) in [
            ("same", "D:/Data/backups/image.png", "100"),
            ("same", r"\\?\D:\Data\backups\image.png", "200"),
            ("different", "D:/Data/backups/image.png", "300"),
        ] {
            c.execute("INSERT INTO craft_backup_files(hash,path,size,mtime,mime_type) VALUES(?1,?2,7,?3,'image/png')", params![hash,path,mtime]).unwrap();
        }
        prepare_connection(&c, new, false, None).unwrap();
        let registered: Vec<(String, String, String)> = c
            .prepare("SELECT hash,path,mtime FROM craft_backup_files ORDER BY hash")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let expected = crate::sources::display_local_path(&new.join("backups/image.png"));
        assert_eq!(
            registered,
            vec![
                ("different".into(), expected.clone(), "300".into()),
                ("same".into(), expected, "200".into())
            ]
        );
        prepare_connection(&c, new, false, None).unwrap();
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM craft_backup_files", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(crate::metadata_string(&c, "cloud_sync_auto"), "1");
    }
    #[test]
    fn copied_root_rebases_only_owned_paths_and_explicit_same_host_move_keeps_sync_policy() {
        let c = fixture();
        let old = Path::new("D:/Data");
        let new = Path::new("E:/Moved");
        initialize_connection_host(&c, old, "same-host").unwrap();
        c.execute("INSERT INTO libraries VALUES('vault','D:/Data/notes')", [])
            .unwrap();
        c.execute(
            "INSERT INTO documents VALUES('note','D:/Data/notes is prose')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO collection_saved_media VALUES('item','D:/Data/collection-files/a.png')",
            [],
        )
        .unwrap();
        prepare_connection(&c, new, false, None).unwrap();
        initialize_connection_host(&c, new, "same-host").unwrap();
        assert_eq!(crate::metadata_string(&c, "cloud_sync_auto"), "1");
        assert_eq!(
            crate::metadata_string(&c, "flashcard_sync_device_id"),
            "source-device"
        );
        assert_eq!(
            c.query_row("SELECT location FROM libraries", [], |r| r
                .get::<_, String>(0))
                .unwrap()
                .replace('\\', "/"),
            "E:/Moved/notes"
        );
        assert_eq!(
            c.query_row("SELECT markdown FROM documents", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "D:/Data/notes is prose"
        );
        initialize_connection_host(&c, Path::new("F:/Copied"), "same-host").unwrap();
        assert_eq!(crate::metadata_string(&c, "cloud_sync_auto"), "0");
        assert_eq!(
            c.query_row("SELECT path FROM collection_saved_media", [], |r| r
                .get::<_, String>(0))
                .unwrap()
                .replace('\\', "/"),
            "F:/Copied/collection-files/a.png"
        );
    }
    #[test]
    fn restored_craft_dependency_rebases_parent_without_requiring_original_disk() {
        let c = fixture();
        let config = crate::craft_backup::BackupConfig {
            library_id: "craft-library".into(),
            destination: "Z:/unavailable".into(),
            vault_name: "Archive".into(),
            interval_minutes: 60,
            replica_destination: Some("Y:/old-replica".into()),
            last_attempt_at: 0,
            last_success_at: None,
            last_error: None,
        };
        c.execute(
            "INSERT INTO metadata VALUES('craft_backup_config:craft-library',?1)",
            [serde_json::to_string(&config).unwrap()],
        )
        .unwrap();
        apply_restore_mappings(
            &c,
            &[data_backup::PathMapping {
                source_path: "Z:/unavailable/Archive - 备份".into(),
                restored_path: "E:/Restore/external-sources/id/Archive - 备份".into(),
                kind: "craftBackup".into(),
                id: "craft_backup_config:craft-library".into(),
            }],
        )
        .unwrap();
        let updated: crate::craft_backup::BackupConfig = serde_json::from_str(
            &crate::metadata_string(&c, "craft_backup_config:craft-library"),
        )
        .unwrap();
        assert_eq!(
            updated.destination.replace('\\', "/"),
            "E:/Restore/external-sources/id"
        );
        assert!(updated.replica_destination.is_none());
        prepare_connection(&c, Path::new("E:/Restore"), true, None).unwrap();
        assert_eq!(crate::metadata_string(&c, "flashcard_sync_auto"), "0");
        assert_eq!(
            crate::metadata_string(&c, "user_profile_initialized_v1"),
            "1"
        );
    }
    #[test]
    fn restore_maps_specific_sources_before_parents_and_survives_retry() {
        let mut c = fixture();
        c.execute("INSERT INTO libraries VALUES('vault','D:/Data/notes')", [])
            .unwrap();
        c.execute(
            "INSERT INTO collection_saved_media VALUES('item','D:/Data/notes/assets/a.png')",
            [],
        )
        .unwrap();
        let mappings = vec![
            data_backup::PathMapping {
                source_path: "D:/Data".into(),
                restored_path: "E:/Restore".into(),
                kind: "dataRoot".into(),
                id: "dataRoot".into(),
            },
            data_backup::PathMapping {
                source_path: "D:/Data/notes".into(),
                restored_path: "E:/Restore/external-sources/vault".into(),
                kind: "obsidian".into(),
                id: "vault".into(),
            },
            data_backup::PathMapping {
                source_path: "D:/Data/notes/assets".into(),
                restored_path: "E:/Restore/external-sources/assets".into(),
                kind: "externalAttachment".into(),
                id: "media".into(),
            },
        ];
        {
            let tx = c.transaction().unwrap();
            // A prepared restore may be moved before it is first opened.
            apply_restore_once(&tx, Path::new("F:/Moved"), &mappings).unwrap();
            tx.commit().unwrap();
        }
        assert_eq!(
            c.query_row("SELECT location FROM libraries", [], |r| r
                .get::<_, String>(0))
                .unwrap()
                .replace('\\', "/"),
            "F:/Moved/external-sources/vault"
        );
        assert_eq!(
            c.query_row("SELECT path FROM collection_saved_media", [], |r| r
                .get::<_, String>(0))
                .unwrap()
                .replace('\\', "/"),
            "F:/Moved/external-sources/assets/a.png"
        );
        c.execute(
            "UPDATE metadata SET value='1' WHERE key='cloud_sync_auto'",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO metadata VALUES('flashcard_sync_device_id','new-device')",
            [],
        )
        .unwrap();
        let identity = crate::metadata_string(&c, RESTORE_MAPPING_MARKER);
        apply_restore_once(&c, Path::new("F:/Moved"), &mappings).unwrap();
        assert_eq!(crate::metadata_string(&c, RESTORE_MAPPING_MARKER), identity);
        assert_eq!(crate::metadata_string(&c, "cloud_sync_auto"), "1");
        assert_eq!(
            crate::metadata_string(&c, "flashcard_sync_device_id"),
            "new-device"
        );
        assert_eq!(
            c.query_row("SELECT value FROM user_profile_values", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "preserved"
        );
        let mut changed = mappings.clone();
        changed[1].restored_path = "E:/Restore/changed".into();
        assert!(apply_restore_once(&c, Path::new("F:/Moved"), &changed).is_err());
    }
    #[test]
    fn failed_restore_transaction_rolls_back_paths_and_its_marker() {
        let mut c = fixture();
        c.execute("INSERT INTO libraries VALUES('vault','D:/Data/notes')", [])
            .unwrap();
        let mappings = vec![
            data_backup::PathMapping {
                source_path: "D:/Data".into(),
                restored_path: "E:/Restore".into(),
                kind: "dataRoot".into(),
                id: "dataRoot".into(),
            },
            data_backup::PathMapping {
                source_path: "Z:/Backup".into(),
                restored_path: "E:/Restore/external-sources/Backup".into(),
                kind: "craftBackup".into(),
                id: "craft_backup_config:missing".into(),
            },
        ];
        {
            let tx = c.transaction().unwrap();
            assert!(apply_restore_once(&tx, Path::new("E:/Restore"), &mappings).is_err());
        }
        assert_eq!(
            c.query_row("SELECT location FROM libraries", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "D:/Data/notes"
        );
        assert_eq!(crate::metadata_string(&c, RESTORE_MAPPING_MARKER), "");
        assert_eq!(
            crate::metadata_string(&c, "user_profile_initialized_v1"),
            ""
        );
        assert_eq!(crate::metadata_string(&c, "cloud_sync_auto"), "1");
    }
    #[test]
    fn full_database_open_finishes_pending_restore_and_resolves_real_source_files() {
        let base =
            std::env::temp_dir().join(format!("hub-restore-paths-{}", crate::random_url_safe(12)));
        let root = base.join("Restored");
        let old_root = base.join("OldData");
        let old_vault = base.join("OldSources/Vault");
        let vault = root.join("external-sources/vault/Vault");
        let old_backup = base.join("OldBackups/Archive - 备份");
        let backup = root.join("external-sources/craft/Archive - 备份");
        fs::create_dir_all(&vault).unwrap();
        fs::create_dir_all(&backup).unwrap();
        fs::create_dir_all(root.join("collection-files")).unwrap();
        // Small recognizable image, used only in this temporary fixture.
        let image=b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff\x21\xf9\x04\x00\x00\x00\x00\x00\x2c\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02\x44\x01\x00\x3b";
        let markdown = "# Kept note\n![[asset.gif]]\n";
        fs::write(vault.join("note.md"), markdown).unwrap();
        fs::write(vault.join("asset.gif"), image).unwrap();
        fs::write(backup.join("original.gif"), image).unwrap();
        fs::write(root.join("collection-files/owned.gif"), image).unwrap();
        let database = root.join("craft-search.sqlite3");
        let c = crate::open_database(&database).unwrap();
        crate::craft_backup_resources::schema(&c).unwrap();
        crate::reading_sync::schema(&c).unwrap();
        c.execute("INSERT INTO libraries(id,provider,name,location,enabled,added_at) VALUES('vault','obsidian','Vault',?1,1,1)",[vault.to_string_lossy()]).unwrap();
        drop(c);
        crate::sync_obsidian_library_database(&database, "vault", &vault).unwrap();
        let c = crate::open_database(&database).unwrap();
        c.execute(
            "UPDATE libraries SET location=?1 WHERE id='vault'",
            [old_vault.to_string_lossy()],
        )
        .unwrap();
        for (key, value) in [
            ("hub_data_root", old_root.to_string_lossy().into_owned()),
            ("hub_installation_id", "old-host".into()),
            ("cloud_sync_auto", "1".into()),
            ("flashcard_sync_auto", "1".into()),
            ("flashcard_sync_device_id", "old-device".into()),
        ] {
            c.execute("INSERT INTO metadata(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,value]).unwrap();
        }
        c.execute(
            "INSERT INTO user_profile_values(key,value) VALUES('hub.favorite','kept')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO collection_roots(destination,root) VALUES('stable-reading-id',?1)",
            [old_vault.to_string_lossy()],
        )
        .unwrap();
        c.execute(
            "INSERT INTO collection_owned_assets(item_key,path) VALUES('owned',?1)",
            [old_root
                .join("collection-files/owned.gif")
                .to_string_lossy()],
        )
        .unwrap();
        let media_url = url::Url::from_file_path(old_vault.join("asset.gif"))
            .unwrap()
            .to_string();
        c.execute(
            "INSERT INTO collection_saved_media(item_key,media_url,path) VALUES('reading',?1,?2)",
            params![media_url, old_vault.join("asset.gif").to_string_lossy()],
        )
        .unwrap();
        let media_id: i64 = c
            .query_row(
                "SELECT local_seq FROM collection_saved_media WHERE item_key='reading'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        c.execute("INSERT INTO reading_media_outbox(namespace,id,body,path) VALUES('fixture','pending',X'00',?1)",[old_vault.join("asset.gif").to_string_lossy()]).unwrap();
        c.execute("INSERT INTO craft_backup_files(hash,path,size,mtime,mime_type) VALUES('fixture-hash',?1,?2,'fixture','image/gif')",params![old_backup.join("original.gif").to_string_lossy(),image.len() as i64]).unwrap();
        c.execute(
            "INSERT INTO metadata(key,value) VALUES('collection_storage_v1',?1)",
            [json!({"mode":"obsidian","vaultPath":old_vault}).to_string()],
        )
        .unwrap();
        let config = crate::craft_backup::BackupConfig {
            library_id: "craft".into(),
            destination: base.join("OldBackups").to_string_lossy().into(),
            vault_name: "Archive".into(),
            interval_minutes: 60,
            replica_destination: Some(base.join("OldReplica").to_string_lossy().into()),
            last_attempt_at: 0,
            last_success_at: None,
            last_error: None,
        };
        c.execute(
            "INSERT INTO metadata(key,value) VALUES('craft_backup_config:craft',?1)",
            [serde_json::to_string(&config).unwrap()],
        )
        .unwrap();
        drop(c);
        let mappings = vec![
            data_backup::PathMapping {
                source_path: old_root.to_string_lossy().into(),
                restored_path: root.to_string_lossy().into(),
                kind: "dataRoot".into(),
                id: "dataRoot".into(),
            },
            data_backup::PathMapping {
                source_path: old_vault.to_string_lossy().into(),
                restored_path: vault.to_string_lossy().into(),
                kind: "obsidian".into(),
                id: "vault".into(),
            },
            data_backup::PathMapping {
                source_path: old_backup.to_string_lossy().into(),
                restored_path: backup.to_string_lossy().into(),
                kind: "craftBackup".into(),
                id: "craft_backup_config:craft".into(),
            },
        ];
        let state = root.join("data-backup-v1");
        fs::create_dir(&state).unwrap();
        fs::write(
            state.join("restore-path-mappings.json"),
            serde_json::to_vec(&mappings).unwrap(),
        )
        .unwrap();
        // Force a report failure after the database transaction commits. Opening
        // the library must keep retrying preparation rather than bypassing it.
        fs::write(state.join("restore-report.json"), br#"{"warnings":false}"#).unwrap();
        assert!(finish_restore(&root, &mappings).is_err());
        assert!(prepare_opened_root(&root, true).is_err());
        fs::write(state.join("restore-report.json"), br#"{"warnings":[]}"#).unwrap();
        prepare_opened_root(&root, true).unwrap();
        initialize_root_host(&root, "new-host").unwrap();
        let c = crate::open_database(&database).unwrap();
        assert_eq!(crate::metadata_string(&c, "cloud_sync_auto"), "0");
        assert_eq!(crate::metadata_string(&c, "flashcard_sync_auto"), "0");
        assert_eq!(
            crate::metadata_string(&c, "hub_installation_id"),
            "new-host"
        );
        assert_eq!(
            c.query_row(
                "SELECT value FROM user_profile_values WHERE key='hub.favorite'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "kept"
        );
        let (location,relative,body):(String,String,String)=c.query_row("SELECT l.location,d.path,d.markdown FROM documents d JOIN libraries l ON l.id=d.space_id WHERE l.id='vault'",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
        assert_eq!(
            fs::read_to_string(Path::new(&location).join(relative)).unwrap(),
            markdown
        );
        assert_eq!(body, markdown);
        let attachment:String=c.query_row("SELECT json_extract(metadata_json,'$.localRelativePath') FROM source_items WHERE provider='obsidian' AND source_type='obsidian_attachment' LIMIT 1",[],|r|r.get(0)).unwrap();
        assert_eq!(
            fs::read(Path::new(&location).join(attachment)).unwrap(),
            image
        );
        let open_link = crate::sources::obsidian_open_url(
            &crate::library_location::vault_name(&c, "vault").unwrap(),
            "note.md",
        )
        .unwrap();
        assert!(open_link.contains("vault=Vault"));
        assert_eq!(
            crate::x_bookmarks::storage::recorded_media_path(&c, media_id).unwrap(),
            vault.join("asset.gif")
        );
        assert_eq!(
            c.query_row(
                "SELECT media_url FROM collection_saved_media WHERE local_seq=?1",
                [media_id],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            media_url
        );
        for (table, column) in [
            ("collection_owned_assets", "path"),
            ("reading_media_outbox", "path"),
            ("craft_backup_files", "path"),
        ] {
            let path: String = c
                .query_row(&format!("SELECT {column} FROM {table} LIMIT 1"), [], |r| {
                    r.get(0)
                })
                .unwrap();
            assert_eq!(fs::read(path).unwrap(), image);
        }
        let saved_root: String = c
            .query_row(
                "SELECT root FROM collection_roots WHERE destination='stable-reading-id'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(PathBuf::from(saved_root), vault);
        let report = read_restore_report(&root).unwrap();
        assert_eq!(report["pathMappingsApplied"], true);
        assert_eq!(
            report["pathMappingsIdentity"].as_str(),
            Some(mapping_identity(&mappings).unwrap().as_str())
        );
        drop(c);
        crate::database::forget_initialized_database(&database);
        assert!(base.starts_with(std::env::temp_dir()));
        fs::remove_dir_all(base).unwrap();
    }
}
