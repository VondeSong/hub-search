//! Original files own note content. Snapshots are immutable proposals/backups.
//! Windows holds the file and ancestor directories against writes/replacement
//! for the entire comparison + write; the caller durably journals first.
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
};

const MAX_BYTES: u64 = 48_000;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Snapshot {
    pub library_id: String,
    pub document_id: String,
    pub relative_path: String,
    pub vault: String,
    pub file_identity: String,
    pub hash: String,
    pub before: String,
    pub raw_base64: String,
    pub utf8: bool,
}
pub(crate) fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(crate) fn path(
    c: &Connection,
    library: &str,
    document: &str,
) -> Result<(PathBuf, PathBuf, String), String> {
    let (location, relative):(String,String)=c.query_row("SELECT l.location,d.path FROM libraries l JOIN documents d ON d.space_id=l.id WHERE l.id=?1 AND d.id=?2 AND l.provider='obsidian' AND d.provider='obsidian' AND l.enabled=1",params![library,document],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|_|"Obsidian 笔记或资料库已不可用")?;
    let rel = Path::new(&relative);
    if rel.components().any(|p| !matches!(p, Component::Normal(_)))
        || rel
            .extension()
            .and_then(|x| x.to_str())
            .is_none_or(|x| !x.eq_ignore_ascii_case("md"))
        || crate::obsidian_document_id(&relative) != document
        || rel
            .components()
            .any(|p| crate::sources::should_ignore_directory(&p.as_os_str().to_string_lossy()))
        || crate::obsidian_path_is_excluded(&relative, &crate::library_excluded_paths(c, library)?)
    {
        return Err("笔记不在允许编辑的文件范围内".into());
    }
    let root = Path::new(&location)
        .canonicalize()
        .map_err(|_| "Obsidian 库已移动或不可访问")?;
    let mut current = root.clone();
    for part in rel.components() {
        current.push(part);
        let m = fs::symlink_metadata(&current)
            .map_err(|_| "笔记或所在文件夹已移动或删除，请重新定位")?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if m.file_attributes() & 0x400 != 0 {
                return Err("不能通过符号链接或目录联接编辑笔记".into());
            }
        }
        if m.file_type().is_symlink() {
            return Err("不能通过符号链接编辑笔记".into());
        }
    }
    let file = current.canonicalize().map_err(|_| "笔记路径不可访问")?;
    if !file.starts_with(&root) || !file.is_file() {
        return Err("笔记文件已离开资料库".into());
    }
    Ok((root, file, relative))
}
#[cfg(windows)]
pub(crate) fn identity(file: &File) -> Result<String, String> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::{
        Foundation::HANDLE,
        Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION},
    };
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info) }
        .map_err(|_| "无法核对笔记文件身份")?;
    if info.nNumberOfLinks != 1 {
        return Err("含硬链接的文件暂不支持受控编辑".into());
    }
    Ok(format!(
        "{:08x}:{:08x}{:08x}",
        info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow
    ))
}
#[cfg(not(windows))]
pub(crate) fn identity(_: &File) -> Result<String, String> {
    Err("当前平台尚未提供受控笔记写入".into())
}

fn read(file: &mut File) -> Result<Vec<u8>, String> {
    if file.metadata().map_err(|_| "无法核对笔记大小")?.len() > MAX_BYTES {
        return Err("本次仅支持不超过 48 KB 的笔记，请缩小笔记后再编辑".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取笔记原文件")?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("笔记大小在读取时发生变化".into());
    }
    Ok(bytes)
}
pub(crate) fn snapshot(c: &Connection, library: &str, document: &str) -> Result<Snapshot, String> {
    let (root, file, relative) = path(c, library, document)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1);
    }
    let mut f = options
        .open(file)
        .map_err(|_| "笔记正被其他程序写入，请稍后重试")?;
    let id = identity(&f)?;
    let bytes = read(&mut f)?;
    Ok(Snapshot {
        library_id: library.into(),
        document_id: document.into(),
        relative_path: relative,
        vault: crate::display_local_path(&root),
        file_identity: id,
        hash: hash(&bytes),
        before: String::from_utf8_lossy(&bytes).into(),
        raw_base64: STANDARD.encode(&bytes),
        utf8: std::str::from_utf8(&bytes).is_ok(),
    })
}
pub(crate) struct LockedNote {
    file: File,
    _directories: Vec<File>,
}
impl LockedNote {
    pub(crate) fn open(c: &Connection, base: &Snapshot) -> Result<Self, String> {
        #[cfg(not(windows))]
        {
            let _ = (c, base);
            return Err("当前平台尚未提供受控笔记写入".into());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            let (root, file, relative) = path(c, &base.library_id, &base.document_id)?;
            if crate::display_local_path(&root) != base.vault || relative != base.relative_path {
                return Err("资料库或笔记位置已变化，请重新预览".into());
            }
            let mut directories = Vec::new();
            let mut dir = root.clone();
            directories.push(
                OpenOptions::new()
                    .read(true)
                    .share_mode(1)
                    .custom_flags(0x02000000)
                    .open(&dir)
                    .map_err(|_| "无法锁定资料库位置")?,
            );
            if let Some(parent) = Path::new(&relative).parent() {
                for component in parent.components() {
                    dir.push(component);
                    directories.push(
                        OpenOptions::new()
                            .read(true)
                            .share_mode(1)
                            .custom_flags(0x02000000)
                            .open(&dir)
                            .map_err(|_| "无法锁定笔记所在目录")?,
                    );
                }
            }
            let mut f = OpenOptions::new()
                .read(true)
                .write(true)
                .share_mode(0)
                .open(file)
                .map_err(|_| "笔记正在被其他程序使用，请关闭该文件的占用后重试")?;
            if identity(&f)? != base.file_identity || hash(&read(&mut f)?) != base.hash {
                return Err("原笔记已变化或被替换；草稿已保留，请重新准备修改".into());
            }
            Ok(Self {
                file: f,
                _directories: directories,
            })
        }
    }
    /// Caller has committed an executing record with original bytes and draft.
    /// A crash can leave partial bytes; restart observes them and offers a new
    /// explicitly confirmed restore proposal, never an automatic overwrite.
    pub(crate) fn write(&mut self, after: &str) -> Result<(), String> {
        if after.len() as u64 > MAX_BYTES {
            return Err("修改后的笔记超过 48 KB".into());
        }
        self.file
            .seek(SeekFrom::Start(0))
            .and_then(|_| self.file.write_all(after.as_bytes()))
            .and_then(|_| self.file.set_len(after.len() as u64))
            .and_then(|_| self.file.sync_all())
            .map_err(|_| "写入未完整确认，写前副本和草稿已保留，请核对结果")?;
        self.file
            .seek(SeekFrom::Start(0))
            .map_err(|_| "写入后无法回读")?;
        if read(&mut self.file)? != after.as_bytes() {
            return Err("写入后回读不一致，请核对结果".into());
        }
        Ok(())
    }
}
pub(crate) fn split(text: &str) -> Result<(&str, &str), String> {
    let bom = usize::from(text.starts_with('\u{feff}')) * 3;
    let plain = &text[bom..];
    if !plain.starts_with("---\n") && !plain.starts_with("---\r\n") {
        return Ok((&text[..bom], plain));
    }
    let mut end = bom;
    for (i, line) in plain.split_inclusive('\n').enumerate() {
        end += line.len();
        if i > 0 && matches!(line.trim_end_matches(['\r', '\n']), "---" | "...") {
            return Ok((&text[..end], &text[end..]));
        }
    }
    Err("笔记 frontmatter 没有结束标记，请先修正后再编辑".into())
}
pub(crate) fn compose(base: &Snapshot, body: &str) -> Result<String, String> {
    if !base.utf8 {
        return Err("原文件不是有效 UTF-8，仅可核对或恢复写前版本".into());
    }
    if body.trim().is_empty() || body.chars().count() > 12_000 {
        return Err("修改正文需为 1–12000 个字符".into());
    }
    let (prefix, _) = split(&base.before)?;
    let crlf = base.before.contains("\r\n");
    if crlf && base.before.replace("\r\n", "").contains('\n') {
        return Err("笔记使用混合换行，请先统一后再生成修改".into());
    }
    let normalized = body.replace("\r\n", "\n");
    let result = format!(
        "{prefix}{}",
        if crlf {
            normalized.replace('\n', "\r\n")
        } else {
            normalized
        }
    );
    if result.len() as u64 > MAX_BYTES {
        return Err("修改后的笔记超过 48 KB".into());
    }
    Ok(result)
}

#[cfg(all(test, windows))]
pub(crate) mod tests;
