//! Copy-and-switch migration. The old archive and vault are retained.
use crate::craft_backup::{self, BackupConfig};
use std::{
    fs,
    path::{Path, PathBuf},
};

fn copy_tree(source: &Path, target: &Path) -> Result<(), String> {
    craft_backup::reject_links(source)?;
    craft_backup::reject_links(target)?;
    fs::create_dir(target).map_err(|e| format!("迁移目标必须尚未存在：{e}"))?;
    for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = target.join(entry.file_name());
        craft_backup::reject_links(&from)?;
        if from.is_dir() {
            copy_tree(&from, &to)?;
        } else {
            fs::copy(&from, &to).map_err(|e| e.to_string())?;
            fs::OpenOptions::new()
                .write(true)
                .open(&to)
                .and_then(|f| f.sync_all())
                .map_err(|e| e.to_string())?;
            if craft_backup::hash_file(&from)? != craft_backup::hash_file(&to)? {
                return Err("迁移复制校验失败，原保存位置未改变".into());
            }
        }
    }
    Ok(())
}

pub fn migrate(
    config: &BackupConfig,
    destination: &Path,
) -> Result<(BackupConfig, PathBuf), String> {
    craft_backup::reject_links(destination)?;
    let destination = destination
        .canonicalize()
        .map_err(|_| "请选择存在的迁移父目录".to_string())?;
    let source_parent = Path::new(&config.destination)
        .canonicalize()
        .map_err(|_| "原备份位置不可用".to_string())?;
    if destination == source_parent
        || destination.starts_with(&source_parent.join(crate::craft_export::sanitize_component(
            &config.vault_name,
            "Craft",
        )))
    {
        return Err("迁移目录不能是原目录或原 Vault 内部".into());
    }
    let source = craft_backup::backup_root(&craft_backup::config_options(config))?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if destination.starts_with(&source) {
        return Err("迁移目录不能位于原始备份内部".into());
    }
    let mut updated = config.clone();
    updated.destination = destination.to_string_lossy().into();
    let target = craft_backup::backup_root(&craft_backup::config_options(&updated))?;
    let vault_name = crate::craft_export::sanitize_component(&config.vault_name, "Craft");
    let source_vault = source_parent.join(&vault_name);
    let target_vault = destination.join(&vault_name);
    if target.exists() || target_vault.exists() {
        return Err("新位置已有同名目录，请选择另一个父目录；原文件未修改".into());
    }
    let points = craft_backup::history(&source, &config.library_id)?;
    if !craft_backup::history_issues(&source, &config.library_id).is_empty() {
        return Err("原始备份有损坏的历史清单，未迁移；其它恢复点可分别恢复".into());
    }
    if points.is_empty() {
        return Err("尚无完整恢复点，先完成首次备份再迁移".into());
    }
    let store = crate::blob_store::BlobStore::open(&source.join("objects"))?;
    for snapshot in &points {
        if !craft_backup::verify_objects(&store, snapshot).valid {
            return Err("原备份核验失败，未迁移".into());
        }
    }
    copy_tree(&source, &target)?;
    if source_vault.is_dir() {
        copy_tree(&source_vault, &target_vault)?;
    }
    let migrated = crate::blob_store::BlobStore::open(&target.join("objects"))?;
    for snapshot in craft_backup::history(&target, &config.library_id)? {
        if !craft_backup::verify_objects(&migrated, &snapshot).valid {
            return Err("新位置核验失败，原保存位置未改变".into());
        }
    }
    Ok((updated, target))
}
