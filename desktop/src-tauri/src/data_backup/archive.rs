//! Version 1 framing: magic, header length/JSON, file frames, count footer, SHA256.
//! Integers are little endian. A file frame is 1/path-length/size/path/content/hash.
//! The footer is 0/file-count/content-bytes; the final hash covers all earlier bytes.
use super::*;
use std::collections::BTreeSet;

const MAGIC: &[u8; 8] = b"HUBDATA1";
const MAX_HEADER: u32 = 8 * 1024 * 1024;

struct Output {
    file: fs::File,
    digest: Sha256,
}
impl Output {
    fn put(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.file.write_all(bytes).map_err(io_error)?;
        self.digest.update(bytes);
        Ok(())
    }
}
struct Input {
    file: fs::File,
    digest: Sha256,
}
impl Input {
    fn get(&mut self, bytes: &mut [u8]) -> Result<(), String> {
        self.file
            .read_exact(bytes)
            .map_err(|e| format!("备份已截断或无法读取：{e}"))?;
        self.digest.update(&*bytes);
        Ok(())
    }
    fn u32(&mut self) -> Result<u32, String> {
        let mut bytes = [0; 4];
        self.get(&mut bytes)?;
        Ok(u32::from_le_bytes(bytes))
    }
    fn u64(&mut self) -> Result<u64, String> {
        let mut bytes = [0; 8];
        self.get(&mut bytes)?;
        Ok(u64::from_le_bytes(bytes))
    }
}

fn valid_header(header: &Header) -> Result<(), String> {
    if header.version != 1 {
        return Err("不支持此整库备份版本".into());
    }
    if header.dataset_id.len() != 32
        || !header.dataset_id.bytes().all(|v| v.is_ascii_hexdigit())
        || header.operation_id.len() != 32
        || !header.operation_id.bytes().all(|v| v.is_ascii_hexdigit())
    {
        return Err("备份身份信息无效".into());
    }
    if header.files == 0 || header.files > MAX_FILES as u64 || header.bytes > MAX_BYTES {
        return Err("备份清单数量或体积超出上限".into());
    }
    if header.schema_version < 5 || header.schema_version > crate::database::DATABASE_SCHEMA_VERSION
    {
        return Err("备份来自不受支持的数据库版本，请使用兼容版本的 Hub".into());
    }
    for dependency in &header.dependencies {
        if dependency.included && dependency.archive_path.is_none() {
            return Err("备份依赖清单缺少恢复位置".into());
        }
        if let Some(path) = &dependency.archive_path {
            files::safe_relative(path)?;
            if !path.starts_with("external-sources/")
                && !path.starts_with("collection-files/")
                && !path.starts_with("blobs-v1/")
            {
                return Err("备份依赖恢复位置无效".into());
            }
        }
    }
    Ok(())
}

fn read_header(input: &mut Input) -> Result<Header, String> {
    let mut magic = [0; 8];
    input.get(&mut magic)?;
    if &magic != MAGIC {
        return Err("不是 Hub 整库备份文件".into());
    }
    let size = input.u32()?;
    if size == 0 || size > MAX_HEADER {
        return Err("备份清单过大或无效".into());
    }
    let mut bytes = vec![0; size as usize];
    input.get(&mut bytes)?;
    let header: Header =
        serde_json::from_slice(&bytes).map_err(|e| format!("备份清单损坏：{e}"))?;
    valid_header(&header)?;
    Ok(header)
}

pub(super) fn header(path: &Path) -> Result<Header, String> {
    read_header(&mut Input {
        file: files::open_stable(path)?,
        digest: Sha256::new(),
    })
}

pub(super) fn write(
    path: &Path,
    header: &Header,
    inputs: &[InputFile],
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(Progress),
) -> Result<(), String> {
    checkpoint(cancel)?;
    valid_header(header)?;
    files::reject_links(path)?;
    let mut output = Output {
        file: fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(io_error)?,
        digest: Sha256::new(),
    };
    let raw = serde_json::to_vec(header).map_err(|e| e.to_string())?;
    if raw.len() > MAX_HEADER as usize {
        return Err("备份清单超过 8 MiB".into());
    }
    output.put(MAGIC)?;
    output.put(&(raw.len() as u32).to_le_bytes())?;
    output.put(&raw)?;
    let mut copied = 0;
    let mut count = 0;
    let mut buffer = [0; 64 * 1024];
    let mut seen = BTreeSet::new();
    let mut last_emit = Instant::now();
    for entry in inputs {
        checkpoint(cancel)?;
        files::safe_relative(&entry.relative)?;
        if !seen.insert(entry.relative.to_lowercase()) {
            return Err("备份源出现大小写冲突或重复文件路径".into());
        }
        let mut source = files::open_stable(&entry.source)?;
        let before = source.metadata().map_err(io_error)?;
        if before.len() != entry.size || before.modified().ok() != entry.modified {
            return Err(format!(
                "备份期间源文件发生变化：{}",
                entry.source.display()
            ));
        }
        output.put(&[1])?;
        output.put(&(entry.relative.len() as u32).to_le_bytes())?;
        output.put(&entry.size.to_le_bytes())?;
        output.put(entry.relative.as_bytes())?;
        let mut remaining = entry.size;
        let mut digest = Sha256::new();
        while remaining > 0 {
            checkpoint(cancel)?;
            let length = remaining.min(buffer.len() as u64) as usize;
            source.read_exact(&mut buffer[..length]).map_err(io_error)?;
            output.put(&buffer[..length])?;
            digest.update(&buffer[..length]);
            remaining -= length as u64;
            copied += length as u64;
            if last_emit.elapsed() >= Duration::from_millis(150) {
                progress(Progress {
                    phase: "archive".into(),
                    completed_bytes: copied,
                    total_bytes: Some(header.bytes),
                    completed_files: count,
                    total_files: Some(header.files),
                });
                last_emit = Instant::now();
            }
        }
        let mut extra = [0];
        if source.read(&mut extra).map_err(io_error)? != 0 {
            return Err("源文件在备份时增长，已停止".into());
        }
        let after = source.metadata().map_err(io_error)?;
        if before.len() != after.len() || before.modified().ok() != after.modified().ok() {
            return Err("源文件在备份时变化，已停止".into());
        }
        let hash = digest.finalize();
        if entry
            .expected_hash
            .as_ref()
            .is_some_and(|expected| !expected.eq_ignore_ascii_case(&format!("{hash:x}")))
        {
            return Err(format!("附件或源文件的 SHA256 不一致：{}", entry.relative));
        }
        output.put(hash.as_slice())?;
        count += 1;
    }
    if count != header.files || copied != header.bytes {
        return Err("备份文件数量与清单不一致".into());
    }
    output.put(&[0])?;
    output.put(&count.to_le_bytes())?;
    output.put(&copied.to_le_bytes())?;
    let digest = output.digest.finalize();
    output
        .file
        .write_all(digest.as_slice())
        .and_then(|_| output.file.sync_all())
        .map_err(io_error)
}

pub(super) fn read(
    path: &Path,
    destination: Option<&Path>,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(Progress),
) -> Result<(Header, BackupSummary), String> {
    read_file(
        path,
        files::open_stable(path)?,
        destination,
        cancel,
        progress,
    )
}

pub(super) fn read_file(
    path: &Path,
    file: fs::File,
    destination: Option<&Path>,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(Progress),
) -> Result<(Header, BackupSummary), String> {
    checkpoint(cancel)?;
    let mut input = Input {
        file,
        digest: Sha256::new(),
    };
    let archive_bytes = input.file.metadata().map_err(io_error)?.len();
    if archive_bytes > MAX_BYTES.saturating_add(8 * 1024 * 1024 * 1024) {
        return Err("备份文件超过体积上限".into());
    }
    let header = read_header(&mut input)?;
    let mut total = 0u64;
    let mut count = 0u64;
    let mut database_seen = false;
    let mut seen = BTreeSet::new();
    let mut buffer = [0; 64 * 1024];
    let mut last_emit = Instant::now();
    loop {
        checkpoint(cancel)?;
        let mut marker = [0];
        input.get(&mut marker)?;
        if marker[0] == 0 {
            break;
        }
        if marker[0] != 1 || count >= header.files {
            return Err("备份文件帧或数量无效".into());
        }
        let path_length = input.u32()?;
        let size = input.u64()?;
        if path_length == 0 || path_length > 4096 || size > header.bytes.saturating_sub(total) {
            return Err("备份文件路径或长度无效".into());
        }
        let mut raw = vec![0; path_length as usize];
        input.get(&mut raw)?;
        let name = String::from_utf8(raw).map_err(|_| "备份文件名不是有效 UTF-8")?;
        let relative = files::safe_relative(&name)?;
        if !files::archive_member(&name) {
            return Err("备份含不受支持的文件位置".into());
        }
        if !seen.insert(name.to_lowercase()) {
            return Err("备份含重复或大小写冲突的路径".into());
        }
        if name == DATABASE {
            database_seen = true;
        }
        let mut output = if let Some(root) = destination {
            let file = root.join(&relative);
            files::reject_links(&file)?;
            fs::create_dir_all(file.parent().ok_or("恢复文件目录无效")?).map_err(io_error)?;
            files::reject_links(&file)?;
            Some(
                fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&file)
                    .map_err(io_error)?,
            )
        } else {
            None
        };
        let mut remaining = size;
        let mut digest = Sha256::new();
        while remaining > 0 {
            checkpoint(cancel)?;
            let length = remaining.min(buffer.len() as u64) as usize;
            input.get(&mut buffer[..length])?;
            digest.update(&buffer[..length]);
            if let Some(file) = output.as_mut() {
                file.write_all(&buffer[..length]).map_err(io_error)?;
            }
            remaining -= length as u64;
            total += length as u64;
            if last_emit.elapsed() >= Duration::from_millis(150) {
                progress(Progress {
                    phase: if destination.is_some() {
                        "restore"
                    } else {
                        "verify"
                    }
                    .into(),
                    completed_bytes: total,
                    total_bytes: Some(header.bytes),
                    completed_files: count,
                    total_files: Some(header.files),
                });
                last_emit = Instant::now();
            }
        }
        let digest = digest.finalize();
        let mut expected = [0; 32];
        input.get(&mut expected)?;
        if digest.as_slice() != expected {
            return Err(format!("备份附件校验失败：{name}"));
        }
        if name.starts_with("blobs-v1/") {
            let parts: Vec<_> = name.split('/').collect();
            let actual = format!("{digest:x}");
            if parts.len() != 3 || parts[1] != &actual[..2] || parts[2] != actual {
                return Err("备份附件内容与寻址哈希不一致".into());
            }
        }
        if let Some(file) = output {
            file.sync_all().map_err(io_error)?;
        }
        count += 1;
    }
    if input.u64()? != count
        || input.u64()? != total
        || count != header.files
        || total != header.bytes
        || !database_seen
    {
        return Err("备份数量、长度或数据库清单不一致".into());
    }
    let digest = input.digest.finalize();
    let mut expected = [0; 32];
    input.file.read_exact(&mut expected).map_err(io_error)?;
    if digest.as_slice() != expected {
        return Err("整库备份 SHA256 校验失败".into());
    }
    let mut extra = [0];
    if input.file.read(&mut extra).map_err(io_error)? != 0 {
        return Err("备份末尾存在未声明内容".into());
    }
    let summary = BackupSummary {
        path: path.to_string_lossy().into(),
        dataset_id: header.dataset_id.clone(),
        created_at: header.created_at,
        app_version: header.app_version.clone(),
        schema_version: header.schema_version,
        files: count,
        bytes: total,
        archive_bytes,
        checksum: format!("{digest:x}"),
        complete: header.complete,
        dependencies: header.dependencies.clone(),
        warnings: header.warnings.clone(),
    };
    Ok((header, summary))
}
