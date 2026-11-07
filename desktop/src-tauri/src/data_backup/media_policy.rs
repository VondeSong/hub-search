//! Attachment ownership follows its source, not the optional export destination.
use super::*;

pub(crate) fn is_x(key: &str) -> bool {
    key.starts_with("x:") || key.starts_with("x-likes:") || key.starts_with("obsidian:x:")
}

pub(super) fn x_sql(field: &str) -> String {
    format!("({field} LIKE 'x:%' OR {field} LIKE 'x-likes:%' OR {field} LIKE 'obsidian:x:%')")
}

// Both archive discovery and startup adoption use this same exclusion.
pub(super) fn external_clause(table: &str) -> String {
    let field = if table == "reading_media_outbox" {
        "COALESCE(CASE WHEN json_valid(media.body) THEN json_extract(media.body,'$.key') END,'')"
    } else {
        "media.item_key"
    };
    format!(" AND NOT {}", x_sql(field))
}

pub(crate) fn x_vault(c: &Connection) -> Result<PathBuf, String> {
    let cfg = crate::x_bookmarks::storage::config(c)?;
    if cfg.mode != "obsidian" || cfg.vault_path.trim().is_empty() {
        return Err("X 原件和附件只保存到 Obsidian，请先选择 Obsidian 保存库".into());
    }
    let vault = files::existing_directory(Path::new(&cfg.vault_path))
        .map_err(|_| "Obsidian 保存库不可访问，X 附件未改存到 Hub")?;
    if let Some(db) = c.path().filter(|v| !v.is_empty()) {
        let root = files::existing_directory(Path::new(db).parent().ok_or("数据库缺少目录")?)?;
        if vault.starts_with(&root) || root.starts_with(&vault) {
            return Err("X 保存库必须是 Hub 数据目录之外的 Obsidian 库".into());
        }
    }
    Ok(vault)
}

fn target(c: &Connection, url: &str, extension: &str) -> Result<PathBuf, String> {
    let root = x_vault(c)?;
    let path = root
        .join("99_Meta/assets/X_assets")
        .join(format!("{:x}.{extension}", Sha256::digest(url.as_bytes())));
    files::reject_links(&path)?;
    Ok(path)
}

pub(crate) fn save_x_bytes(c: &Connection, url: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let kind = infer::get(bytes).ok_or("无法识别 X 附件格式")?;
    let target = target(c, url, kind.extension())?;
    let digest = format!("{:x}", Sha256::digest(bytes));
    if target.exists() {
        if fs::metadata(&target).map_err(io_error)?.len() == bytes.len() as u64
            && files::hash_file(&target, &AtomicBool::new(false))? == digest
        {
            return Ok(target);
        }
        return Err("Obsidian 中的同名附件内容不同，原件未覆盖".into());
    }
    files::check_space(
        target
            .parent()
            .ok_or("附件缺少目录")?
            .ancestors()
            .find(|p| p.is_dir())
            .ok_or("保存库不可用")?,
        bytes.len() as u64 + 16 * 1024 * 1024,
    )?;
    fs::create_dir_all(target.parent().unwrap()).map_err(io_error)?;
    files::reject_links(&target)?;
    let temporary = target.with_extension(format!("{}.partial", identifier()));
    let result = (|| {
        let mut output = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(io_error)?;
        output.write_all(bytes).map_err(io_error)?;
        output.sync_all().map_err(io_error)?;
        drop(output);
        files::publish_new_file(&temporary, &target)?;
        Ok(target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub(crate) fn retain(
    c: &Connection,
    key: &str,
    url: &str,
    source: &Path,
) -> Result<PathBuf, String> {
    if !is_x(key) {
        // Telegram's optional cloud reading copy keeps its existing cache
        // lifecycle. Source downloads and Craft/Dida originals remain durable.
        if key.starts_with("telegram:") {
            if let Some(database) = c.path().filter(|path| !path.is_empty()) {
                let data_root = Path::new(database).parent().ok_or("数据库缺少数据目录")?;
                let root = files::existing_directory(data_root)?;
                files::reject_links(source)?;
                let source = source.canonicalize().map_err(io_error)?;
                if source.parent() == Some(root.join("reading-media-v1").as_path()) {
                    // Canonical paths prove containment; the cache owner uses
                    // its database-relative path spelling on Windows.
                    return Ok(data_root
                        .join("reading-media-v1")
                        .join(source.file_name().ok_or("缓存文件名无效")?));
                }
            }
        }
        return retain_media(c, source);
    }
    let vault = x_vault(c)?;
    files::reject_links(source)?;
    let source = source.canonicalize().map_err(io_error)?;
    if source.starts_with(&vault) {
        return Ok(source);
    }
    // Explicit additional Obsidian exports may target another registered vault.
    let db_root = c
        .path()
        .and_then(|p| Path::new(p).parent())
        .and_then(|p| p.canonicalize().ok());
    if db_root
        .as_ref()
        .is_none_or(|root| !source.starts_with(root))
    {
        // The root boundary is checked component-by-component, not with SQL LIKE.
        let mut q = c
            .prepare("SELECT root FROM collection_roots")
            .map_err(|e| e.to_string())?;
        for row in q
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
        {
            let root = PathBuf::from(row.map_err(|e| e.to_string())?);
            if let Ok(root) = files::existing_directory(&root) {
                if source.starts_with(&root)
                    && db_root.as_ref().is_none_or(|db| !root.starts_with(db))
                {
                    return Ok(source);
                }
            }
        }
    }
    // Reusing a legacy cloud cache is allowed, but its durable lookup belongs to the vault.
    use std::io::{Seek, SeekFrom};
    let mut input = files::open_stable(&source)?;
    let size = input.metadata().map_err(io_error)?.len();
    let mut signature = [0u8; 8192];
    let n = input.read(&mut signature).map_err(io_error)?;
    let kind = infer::get(&signature[..n]).ok_or("无法识别 X 附件格式")?;
    let target = target(c, url, kind.extension())?;
    let digest = files::hash_file(&source, &AtomicBool::new(false))?;
    if target.exists() {
        if fs::metadata(&target).map_err(io_error)?.len() == size
            && files::hash_file(&target, &AtomicBool::new(false))? == digest
        {
            return Ok(target);
        }
        return Err("Obsidian 中的同名附件内容不同，原件未覆盖".into());
    }
    files::check_space(&vault, size.saturating_add(16 * 1024 * 1024))?;
    fs::create_dir_all(target.parent().unwrap()).map_err(io_error)?;
    files::reject_links(&target)?;
    let temporary = target.with_extension(format!("{}.partial", identifier()));
    let result = (|| {
        input.seek(SeekFrom::Start(0)).map_err(io_error)?;
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(io_error)?;
        let copied = std::io::copy(&mut input, &mut output).map_err(io_error)?;
        output.sync_all().map_err(io_error)?;
        drop(output);
        if copied != size || files::hash_file(&temporary, &AtomicBool::new(false))? != digest {
            return Err("X 附件副本校验失败，引用保留".into());
        }
        files::publish_new_file(&temporary, &target)?;
        Ok(target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
pub(crate) mod tests;
