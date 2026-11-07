use super::*;

// These are the exact persistent user-data owners, not a blanket copy of the
// application root (which also contains secrets and machine/browser state).
const PORTABLE_DIRECTORIES: &[&str] = &[
    "blobs-v1",
    "collection-files",
    "external-sources",
    "flashcard-backups",
    "shared-memory",
];
const PORTABLE_FILES: &[&str] = &[
    "codex-suite-v1.json",
    "model-runtime-v1.json",
    "account-transfer.hubauth",
];

pub(super) fn archive_member(name: &str) -> bool {
    if name == DATABASE || PORTABLE_FILES.contains(&name) {
        return true;
    }
    if [
        "blobs-v1/",
        "collection-files/",
        "external-sources/",
        "shared-memory/",
    ]
    .iter()
    .any(|prefix| name.starts_with(prefix))
    {
        return true;
    }
    // The flashcard backup owner only publishes completed top-level .hubfc
    // files. Its imports, unfinished .partial files and other caches stay out.
    let parts: Vec<_> = name.split('/').collect();
    parts.len() == 2 && parts[0] == "flashcard-backups" && parts[1].ends_with(".hubfc")
}

pub(super) fn reject_links(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        let meta = match fs::symlink_metadata(ancestor) {
            Ok(value) => value,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(io_error(e)),
        };
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 {
                return Err(format!(
                    "数据操作不接受目录联接或重解析点：{}",
                    ancestor.display()
                ));
            }
        }
        if meta.file_type().is_symlink() {
            return Err(format!("数据操作不接受符号链接：{}", ancestor.display()));
        }
    }
    Ok(())
}

pub(super) fn existing_directory(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("请选择绝对目录".into());
    }
    reject_links(path)?;
    let canonical = fs::canonicalize(path).map_err(io_error)?;
    if !canonical.is_dir() {
        return Err("所选路径不是目录".into());
    }
    Ok(canonical)
}

pub(super) fn safe_relative(text: &str) -> Result<PathBuf, String> {
    if text.is_empty() || text.len() > 4096 || text.contains('\\') || text.starts_with('/') {
        return Err("备份包含无效路径".into());
    }
    for part in text.split('/') {
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with([' ', '.'])
            || part
                .chars()
                .any(|v| v.is_control() || ":<>\"|?*".contains(v))
        {
            return Err("备份包含不安全或跨平台不兼容路径".into());
        }
        let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (stem.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && stem.as_bytes()[3].is_ascii_digit())
        {
            return Err("备份路径使用系统保留名称".into());
        }
    }
    let path = PathBuf::from(text);
    if !path
        .components()
        .all(|part| matches!(part, std::path::Component::Normal(_)))
    {
        return Err("备份路径不能离开恢复目录".into());
    }
    Ok(path)
}

pub(super) fn new_target(path: &Path, allow_empty_directory: bool) -> Result<PathBuf, String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|v| matches!(v, std::path::Component::ParentDir))
    {
        return Err("请选择明确的绝对目标路径".into());
    }
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("目标名称无效")?;
    safe_relative(name)?;
    let parent = existing_directory(path.parent().ok_or("目标父目录不可用")?)?;
    let target = parent.join(name);
    reject_links(&target)?;
    if target.exists() {
        if !allow_empty_directory
            || !target.is_dir()
            || fs::read_dir(&target).map_err(io_error)?.next().is_some()
        {
            return Err("目标已经存在或非空；为保护数据，请选择新的文件或空目录".into());
        }
    }
    Ok(target)
}

pub(super) fn open_stable(path: &Path) -> Result<fs::File, String> {
    reject_links(path)?;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Readers may coexist; deny writes/deletes for the lifetime of this file.
        options.share_mode(1);
    }
    options
        .open(path)
        .map_err(|e| format!("无法稳定读取 {}（文件可能正在编辑）：{e}", path.display()))
}

pub(super) fn input(
    path: &Path,
    relative: String,
    expected_hash: Option<String>,
) -> Result<InputFile, String> {
    safe_relative(&relative)?;
    reject_links(path)?;
    let meta = fs::metadata(path).map_err(io_error)?;
    if !meta.is_file() {
        return Err("备份源不是普通文件".into());
    }
    Ok(InputFile {
        source: path.into(),
        relative,
        size: meta.len(),
        modified: meta.modified().ok(),
        expected_hash,
    })
}

pub(super) fn walk(
    root: &Path,
    directory: &Path,
    callback: &mut dyn FnMut(&Path, &fs::Metadata) -> Result<(), String>,
    warnings: &mut Vec<String>,
    cancel: &AtomicBool,
    strict: bool,
) -> Result<(), String> {
    let mut pending = vec![directory.to_path_buf()];
    let mut seen = 0usize;
    while let Some(directory) = pending.pop() {
        checkpoint(cancel)?;
        if let Err(error) = reject_links(&directory) {
            if strict || directory == root {
                return Err(error);
            }
            warning(
                warnings,
                format!("空间统计跳过 {}：{error}", directory.display()),
            );
            continue;
        }
        // Usage observes a live tree: WebView may retire a cache directory
        // after it was queued. Preserve partial totals with a path warning.
        // The selected root and every strict backup read still fail closed.
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if !strict && directory != root => {
                warning(
                    warnings,
                    format!("空间统计跳过 {}：{error}", directory.display()),
                );
                continue;
            }
            Err(error) => return Err(io_error(error)),
        };
        for entry in entries {
            checkpoint(cancel)?;
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) if !strict => {
                    warning(
                        warnings,
                        format!(
                            "空间统计无法读取 {} 中的目录项：{error}",
                            directory.display()
                        ),
                    );
                    continue;
                }
                Err(error) => return Err(io_error(error)),
            };
            let path = entry.path();
            seen += 1;
            if seen > MAX_FILES {
                return Err("目录超过 100 万个文件或子目录".into());
            }
            if !path.starts_with(root) {
                return Err("扫描目录超出所选根目录".into());
            }
            let checked = reject_links(&path);
            if let Err(error) = checked {
                if strict {
                    return Err(error);
                }
                warning(
                    warnings,
                    format!("空间统计跳过 {}：{error}", path.display()),
                );
                continue;
            }
            let meta = match fs::symlink_metadata(&path) {
                Ok(value) => value,
                Err(error) if !strict => {
                    warning(
                        warnings,
                        format!("空间统计跳过 {}：{error}", path.display()),
                    );
                    continue;
                }
                Err(e) => return Err(io_error(e)),
            };
            if meta.is_dir() {
                pending.push(path);
            } else if meta.is_file() {
                callback(&path, &meta)?;
            } else if strict {
                return Err(format!("无法备份非普通文件：{}", path.display()));
            }
        }
    }
    Ok(())
}

pub(super) fn collect_local(
    root: &Path,
    inputs: &mut Vec<InputFile>,
    warnings: &mut Vec<String>,
    cancel: &AtomicBool,
) -> Result<(), String> {
    for name in PORTABLE_FILES {
        let path = root.join(name);
        if path.exists() {
            inputs.push(input(
                &path,
                (*name).into(),
                Some(hash_file(&path, cancel)?),
            )?);
        }
    }
    for name in PORTABLE_DIRECTORIES.iter().copied() {
        let directory = root.join(name);
        if !directory.exists() {
            continue;
        }
        let mut skipped_flashcard_files = 0usize;
        walk(
            root,
            &directory,
            &mut |path, _| {
                let relative = path
                    .strip_prefix(root)
                    .map_err(|e| e.to_string())?
                    .to_str()
                    .ok_or("文件名不是有效 Unicode")?
                    .replace('\\', "/");
                if name == "flashcard-backups" && !archive_member(&relative) {
                    skipped_flashcard_files += 1;
                    return Ok(());
                }
                let expected = if name == "blobs-v1" {
                    let parts: Vec<_> = relative.split('/').collect();
                    if parts.len() != 3
                        || parts[1].len() != 2
                        || parts[2].len() != 64
                        || !parts[2].bytes().all(|b| b.is_ascii_hexdigit())
                        || &parts[2][..2] != parts[1]
                    {
                        return Ok(());
                    }
                    Some(parts[2].to_ascii_lowercase())
                } else {
                    Some(hash_file(path, cancel)?)
                };
                inputs.push(input(path, relative, expected)?);
                Ok(())
            },
            warnings,
            cancel,
            true,
        )?;
        if skipped_flashcard_files > 0 {
            warning(warnings,format!("未收录 {skipped_flashcard_files} 个未完成或非正式的闪卡备份文件；已完成的 .hubfc 恢复点已收录。"));
        }
    }
    for entry in fs::read_dir(root).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if [
            DATABASE,
            "blobs-v1",
            "collection-files",
            "external-sources",
            "flashcard-backups",
            "shared-memory",
            "codex-suite-v1.json",
            "model-runtime-v1.json",
            "account-transfer.hubauth",
            "craft-search.sqlite3-wal",
            "craft-search.sqlite3-shm",
            STATE,
        ]
        .contains(&name.as_str())
            || name.starts_with(".hub-")
        {
            continue;
        }
        warning(
            warnings,
            format!("未收录目录项：{name}（索引、日志、凭据、界面缓存和机器位置设置不随备份迁移）"),
        );
    }
    Ok(())
}

pub(super) fn hash_file(path: &Path, cancel: &AtomicBool) -> Result<String, String> {
    let mut input = open_stable(path)?;
    let before = input.metadata().map_err(io_error)?;
    let mut h = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        checkpoint(cancel)?;
        let n = input.read(&mut buffer).map_err(io_error)?;
        if n == 0 {
            break;
        }
        h.update(&buffer[..n]);
    }
    let after = input.metadata().map_err(io_error)?;
    if before.len() != after.len() || before.modified().ok() != after.modified().ok() {
        return Err(format!("读取期间文件变化：{}", path.display()));
    }
    Ok(format!("{:x}", h.finalize()))
}

pub(super) fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    let mut file = open_stable(path)?;
    if file.metadata().map_err(io_error)?.len() > 8 * 1024 * 1024 {
        return Err("备份设置文件过大".into());
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(io_error)?;
    serde_json::from_slice(&bytes).map_err(|e| format!("备份设置无法读取：{e}"))
}

pub(super) fn write_new_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    reject_links(path)?;
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(io_error)?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(io_error)
}

#[cfg(windows)]
fn move_file(source: &Path, target: &Path, replace: bool) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "Kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
    }
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), 8 | u32::from(replace)) } == 0 {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    Ok(())
}
#[cfg(not(windows))]
fn move_file(source: &Path, target: &Path, replace: bool) -> Result<(), String> {
    if replace {
        fs::rename(source, target).map_err(io_error)
    } else {
        fs::hard_link(source, target).map_err(io_error)?;
        fs::remove_file(source).map_err(io_error)
    }
}

pub(super) fn replace_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    reject_links(path)?;
    let temporary = path.with_extension(format!("{}.pending", identifier()));
    write_new_json(&temporary, value)?;
    move_file(&temporary, path, true)
}
pub(super) fn publish_new_file(source: &Path, target: &Path) -> Result<(), String> {
    reject_links(source)?;
    reject_links(target)?;
    move_file(source, target, false)
}
pub(super) fn publish_new_directory(source: &Path, target: &Path) -> Result<(), String> {
    reject_links(source)?;
    reject_links(target)?;
    if target.exists() {
        if !target.is_dir() || fs::read_dir(target).map_err(io_error)?.next().is_some() {
            return Err("恢复目标不再为空，已停止发布".into());
        }
        // Remove only the selected, verified empty directory; never recursive.
        fs::remove_dir(target).map_err(io_error)?;
    }
    #[cfg(windows)]
    {
        move_file(source, target, false)
    }
    #[cfg(not(windows))]
    {
        if target.exists() {
            return Err("恢复目标已存在".into());
        }
        fs::rename(source, target).map_err(io_error)
    }
}

pub(super) fn check_space(path: &Path, required: u64) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "Kernel32")]
        extern "system" {
            fn GetDiskFreeSpaceExW(
                directory: *const u16,
                available: *mut u64,
                total: *mut u64,
                free: *mut u64,
            ) -> i32;
        }
        let raw: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut available = 0;
        let mut total = 0;
        let mut free = 0;
        if unsafe { GetDiskFreeSpaceExW(raw.as_ptr(), &mut available, &mut total, &mut free) } == 0
        {
            return Err("无法确认目标剩余空间，未开始写入大文件".into());
        }
        if available < required {
            return Err(format!(
                "目标空间不足：至少需要 {required} 字节，可用 {available} 字节"
            ));
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (path, required);
    }
    Ok(())
}

/// Retention validates and deletes the very same open file identity. On Windows
/// the handle denies competing writers/deleters until disposition is committed.
pub(super) fn delete_verified(
    path: &Path,
    verify: impl FnOnce(fs::File) -> Result<(), String>,
) -> Result<(), String> {
    reject_links(path)?;
    #[cfg(windows)]
    {
        use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
        #[link(name = "Kernel32")]
        extern "system" {
            fn SetFileInformationByHandle(
                handle: *mut std::ffi::c_void,
                class: i32,
                data: *const std::ffi::c_void,
                length: u32,
            ) -> i32;
        }
        let file = fs::OpenOptions::new()
            .read(true)
            .access_mode(0x80000000 | 0x00010000)
            .share_mode(1)
            .open(path)
            .map_err(io_error)?;
        verify(file.try_clone().map_err(io_error)?)?;
        let delete: u8 = 1;
        if unsafe {
            SetFileInformationByHandle(
                file.as_raw_handle(),
                4,
                &delete as *const u8 as *const std::ffi::c_void,
                1,
            )
        } == 0
        {
            return Err(io_error(std::io::Error::last_os_error()));
        }
        drop(file);
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        let _ = verify;
        Err("当前平台不提供按文件身份删除，已保留旧自动备份".into())
    }
}
