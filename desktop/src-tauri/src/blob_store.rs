use rand::RngCore;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

fn file_matches_blob(path: &Path, hash: &str, size: u64) -> Result<bool, String> {
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("无法核验已有 Blob：{error}")),
    };
    if file
        .metadata()
        .map_err(|error| format!("无法读取已有 Blob 信息：{error}"))?
        .len()
        != size
    {
        return Ok(false);
    }
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("无法核验已有 Blob 内容：{error}"))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()).eq_ignore_ascii_case(hash))
}

#[cfg(windows)]
fn replace_file_atomically(staged: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "Kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
    }
    let wide_path = |path: &Path| -> std::io::Result<Vec<u16>> {
        let parent = path.parent().ok_or(std::io::ErrorKind::InvalidInput)?;
        let name = path.file_name().ok_or(std::io::ErrorKind::InvalidInput)?;
        // Verbatim parents support long paths without resolving a final symlink being replaced.
        Ok(fs::canonicalize(parent)?
            .join(name)
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect())
    };
    let staged = wide_path(staged)?;
    let target = wide_path(target)?;
    // Both paths are local BlobStore paths. Replacement is atomic on the same
    // filesystem and never exposes a deleted or partially rewritten object.
    if unsafe { MoveFileExW(staged.as_ptr(), target.as_ptr(), 0x1 | 0x8) } == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file_atomically(staged: &Path, target: &Path) -> std::io::Result<()> {
    fs::rename(staged, target)
}

fn publish_blob(staged: &Path, target: &Path, hash: &str, size: u64) -> Result<(), String> {
    if file_matches_blob(target, hash, size)? {
        let _ = fs::remove_file(staged);
        return Ok(());
    }
    if let Err(error) = replace_file_atomically(staged, target) {
        // A competing producer can already have repaired this exact object.
        // Mere existence must never discard the verified replacement bytes.
        if file_matches_blob(target, hash, size)? {
            let _ = fs::remove_file(staged);
            return Ok(());
        }
        let _ = fs::remove_file(staged);
        return Err(format!("无法提交 Blob 文件：{error}"));
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub struct StoredBlob {
    pub hash: String,
    pub size: u64,
    pub relative_path: String,
}

#[derive(Clone)]
pub struct BlobStore {
    root: PathBuf,
    backup_index: Option<PathBuf>,
}

impl BlobStore {
    /// Open cached content without creating a store during a read-only request.
    pub fn open_existing(root: &Path) -> Result<Self, String> {
        if !root.is_dir() {
            return Err("Blob 仓库尚未就绪".to_string());
        }
        Ok(Self {
            root: root.to_path_buf(),
            backup_index: None,
        })
    }

    pub fn open(root: &Path) -> Result<Self, String> {
        fs::create_dir_all(root).map_err(|error| format!("无法创建 Blob 仓库：{error}"))?;
        Ok(Self {
            root: root.to_path_buf(),
            backup_index: None,
        })
    }

    pub fn root_path(&self) -> &Path {
        &self.root
    }

    pub fn with_backup_index(mut self, database: PathBuf) -> Self {
        self.backup_index = Some(database);
        self
    }

    pub fn put(&self, bytes: &[u8]) -> Result<StoredBlob, String> {
        let hash = format!("{:x}", Sha256::digest(bytes));
        let prefix = &hash[..2];
        let directory = self.root.join(prefix);
        fs::create_dir_all(&directory)
            .map_err(|error| format!("无法创建 Blob 分片目录：{error}"))?;
        let target = directory.join(&hash);
        let relative_path = format!("{prefix}/{hash}");
        if file_matches_blob(&target, &hash, bytes.len() as u64)? {
            return Ok(StoredBlob {
                hash,
                size: bytes.len() as u64,
                relative_path,
            });
        }

        let mut random = rand::thread_rng();
        let temporary = loop {
            let candidate = directory.join(format!(".{hash}.{:016x}.tmp", random.next_u64()));
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&candidate)
            {
                Ok(mut file) => {
                    file.write_all(bytes)
                        .map_err(|error| format!("无法写入 Blob 临时文件：{error}"))?;
                    file.sync_all()
                        .map_err(|error| format!("无法同步 Blob 临时文件：{error}"))?;
                    break candidate;
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(format!("无法创建 Blob 临时文件：{error}")),
            }
        };

        publish_blob(&temporary, &target, &hash, bytes.len() as u64)?;
        Ok(StoredBlob {
            hash,
            size: bytes.len() as u64,
            relative_path,
        })
    }

    pub fn put_file(&self, source: &Path, max_bytes: u64) -> Result<StoredBlob, String> {
        let metadata =
            fs::metadata(source).map_err(|error| format!("无法读取本地附件信息：{error}"))?;
        if !metadata.is_file() {
            return Err("本地附件路径不是文件".to_string());
        }
        if metadata.len() > max_bytes {
            return Err(format!("本地附件超过 {} MB 上限", max_bytes / 1024 / 1024));
        }
        let staged = self.staging_path()?;
        let outcome = (|| {
            let mut input =
                fs::File::open(source).map_err(|error| format!("无法打开本地附件：{error}"))?;
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&staged)
                .map_err(|error| format!("无法创建附件暂存文件：{error}"))?;
            let mut hasher = Sha256::new();
            let mut total = 0_u64;
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                let read = input
                    .read(&mut buffer)
                    .map_err(|error| format!("无法读取本地附件：{error}"))?;
                if read == 0 {
                    break;
                }
                total = total.saturating_add(read as u64);
                if total > max_bytes {
                    return Err(format!("本地附件超过 {} MB 上限", max_bytes / 1024 / 1024));
                }
                hasher.update(&buffer[..read]);
                output
                    .write_all(&buffer[..read])
                    .map_err(|error| format!("无法写入附件暂存文件：{error}"))?;
            }
            output
                .sync_all()
                .map_err(|error| format!("无法同步附件暂存文件：{error}"))?;
            drop(output);
            let hash = format!("{:x}", hasher.finalize());
            self.commit_staged(&staged, &hash, total)
        })();
        if outcome.is_err() {
            let _ = fs::remove_file(&staged);
        }
        outcome
    }

    pub fn staging_path(&self) -> Result<PathBuf, String> {
        let directory = self.root.join("incoming");
        fs::create_dir_all(&directory)
            .map_err(|error| format!("无法创建 Blob 暂存目录：{error}"))?;
        Ok(directory.join(format!(
            ".download-{:016x}.tmp",
            rand::thread_rng().next_u64()
        )))
    }

    pub fn commit_staged(
        &self,
        staged: &Path,
        hash: &str,
        size: u64,
    ) -> Result<StoredBlob, String> {
        if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("Blob 哈希格式无效".to_string());
        }
        let incoming = self.root.join("incoming");
        if staged.parent() != Some(incoming.as_path()) {
            return Err("Blob 暂存文件不在允许的目录内".to_string());
        }
        let prefix = &hash[..2];
        let directory = self.root.join(prefix);
        fs::create_dir_all(&directory)
            .map_err(|error| format!("无法创建 Blob 分片目录：{error}"))?;
        let target = directory.join(hash);
        let relative_path = format!("{prefix}/{hash}");
        publish_blob(staged, &target, hash, size)?;
        Ok(StoredBlob {
            hash: hash.to_string(),
            size,
            relative_path,
        })
    }

    pub fn path_for(&self, hash: &str) -> Result<PathBuf, String> {
        let local = self.local_path_for(hash)?;
        if let Some(database) = &self.backup_index {
            if let Some(path) = crate::craft_backup_resources::file_for(database, hash)? {
                return Ok(path);
            }
        }
        Ok(local)
    }

    /// Writes and cache cleanup must never follow external backup references.
    pub fn local_path_for(&self, hash: &str) -> Result<PathBuf, String> {
        if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("Blob 哈希格式无效".to_string());
        }
        Ok(self.root.join(&hash[..2]).join(hash))
    }

    pub fn read(&self, hash: &str) -> Result<Vec<u8>, String> {
        fs::read(self.path_for(hash)?).map_err(|error| format!("无法读取 Blob：{error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn long_paths_publish_stream_and_repair_blobs() {
        use std::os::windows::ffi::OsStrExt;
        let root = std::env::temp_dir().join(format!(
            "craft-search-blob-long-path-test-{}",
            rand::thread_rng().next_u64()
        ));
        let mut directory = root.clone();
        while directory.as_os_str().encode_wide().count() < 280 {
            directory.push("long-attachment-path");
        }
        fs::create_dir_all(directory.join("nested")).unwrap();
        let store = BlobStore::open(&directory.join("nested/../blobs-v1")).unwrap();
        let bytes = b"verified long-path attachment";
        let first = store.put(bytes).unwrap();
        assert_eq!(store.read(&first.hash).unwrap(), bytes);
        fs::write(store.path_for(&first.hash).unwrap(), b"corrupt").unwrap();
        assert_eq!(store.put(bytes).unwrap().hash, first.hash);
        assert_eq!(store.read(&first.hash).unwrap(), bytes);
        let source = root.join("source.txt");
        fs::write(&source, b"streamed long-path attachment").unwrap();
        let streamed = store.put_file(&source, 1024).unwrap();
        assert_eq!(
            store.read(&streamed.hash).unwrap(),
            fs::read(source).unwrap()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn identical_content_is_stored_once_and_can_be_read() {
        let root = std::env::temp_dir().join(format!(
            "craft-search-blob-test-{}",
            rand::thread_rng().next_u64()
        ));
        let store = BlobStore::open(&root).unwrap();
        let first = store.put("相同正文".as_bytes()).unwrap();
        let second = store.put("相同正文".as_bytes()).unwrap();
        assert_eq!(first.hash, second.hash);
        assert_eq!(first.relative_path, second.relative_path);
        assert_eq!(store.read(&first.hash).unwrap(), "相同正文".as_bytes());
        let files = std::fs::read_dir(root.join(&first.hash[..2]))
            .unwrap()
            .count();
        assert_eq!(files, 1);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn local_files_are_streamed_with_size_limits_and_deduplicated() {
        let root = std::env::temp_dir().join(format!(
            "craft-search-blob-file-test-{}",
            rand::thread_rng().next_u64()
        ));
        let source = root.with_extension("source");
        std::fs::write(&source, b"local attachment bytes").unwrap();
        let store = BlobStore::open(&root).unwrap();

        let first = store.put_file(&source, 1024).unwrap();
        let second = store.put_file(&source, 1024).unwrap();
        assert_eq!(first.hash, second.hash);
        assert_eq!(store.read(&first.hash).unwrap(), b"local attachment bytes");
        assert!(store.put_file(&source, 4).is_err());

        let _ = std::fs::remove_file(source);
        let _ = std::fs::remove_dir_all(root);
    }
}
