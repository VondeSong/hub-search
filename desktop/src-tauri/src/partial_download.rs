//! Download-owned, bounded staging beside the destination. Pauses retain data;
//! completion, explicit discard and seven-day expiry remove only marked objects.
use crate::*;
pub(crate) const BUDGET: u64 = 64 * 1024 * 1024 * 1024;
const TTL: i64 = 7 * 24 * 3600;
const PREFIX: &str = ".hub-partial-";
#[derive(Serialize, Deserialize)]
struct Manifest {
    owner: String,
    touched: i64,
    expected: Option<u64>,
    validator: Option<String>,
    #[serde(default)]
    verified_length: u64,
    #[serde(default)]
    partial_hash: String,
}
pub(crate) struct Partial {
    pub(crate) root: PathBuf,
    manifest: Manifest,
}
pub(crate) fn clear(parent: &Path) -> Result<usize, String> {
    if !parent.is_dir() {
        return Ok(0);
    }
    let mut count = 0;
    for entry in fs::read_dir(parent).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if let Some(m) = manifest(&entry.path()) {
            remove_owned(&entry.path(), &m.owner)?;
            count += 1;
        }
    }
    Ok(count)
}
fn manifest(root: &Path) -> Option<Manifest> {
    if fs::symlink_metadata(root).ok()?.file_type().is_symlink() {
        return None;
    }
    if fs::metadata(root.join("owner.json")).ok()?.len() > 8192 {
        return None;
    }
    let bytes = fs::read(root.join("owner.json")).ok()?;
    if bytes.len() > 8192 {
        return None;
    }
    let value: Manifest = serde_json::from_slice(&bytes).ok()?;
    (root.file_name()?.to_str()? == format!("{PREFIX}{}", value.owner)
        && value.owner.len() == 64
        && value.owner.bytes().all(|b| b.is_ascii_hexdigit()))
    .then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn network_partial_owner_expiry_budget_and_corruption_are_bounded() {
        let f = crate::network_traffic_tests::Fixture::new(PROVIDER_CRAFT);
        let destination = f.root.join("partial.bin");
        let mut stage = Partial::open(&destination, "one", None).unwrap();
        fs::write(stage.data(), b"trusted").unwrap();
        stage
            .checkpoint(7, format!("{:x}", Sha256::digest(b"trusted")))
            .unwrap();
        stage.set_validator(Some("\"etag\"".into())).unwrap();
        assert!(stage.budget(BUDGET).is_err());
        fs::write(stage.data(), b"corrupt").unwrap();
        drop(stage);
        let mut repaired = Partial::open(&destination, "one", None).unwrap();
        assert_eq!(repaired.length(), 0);
        assert!(repaired.validator().is_none());
        repaired.manifest.touched = now_timestamp() - TTL - 1;
        fs::write(
            repaired.root.join("owner.json"),
            serde_json::to_vec(&repaired.manifest).unwrap(),
        )
        .unwrap();
        let expired = repaired.root.clone();
        drop(repaired);
        let unknown = f.root.join(".hub-partial-unowned");
        fs::create_dir(&unknown).unwrap();
        fs::write(unknown.join("keep"), b"user").unwrap();
        let fresh = Partial::open(&destination, "two", None).unwrap();
        assert!(!expired.exists());
        assert!(unknown.join("keep").is_file());
        fresh.discard().unwrap();
    }
}
fn usage(parent: &Path) -> Result<u64, String> {
    let mut total = 0u64;
    for entry in fs::read_dir(parent).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if manifest(&entry.path()).is_none() {
            continue;
        }
        for file in fs::read_dir(entry.path()).map_err(|e| e.to_string())? {
            let meta = file
                .map_err(|e| e.to_string())?
                .metadata()
                .map_err(|e| e.to_string())?;
            if meta.is_file() {
                total = total.saturating_add(meta.len().saturating_add(65535) / 65536 * 65536);
            }
        }
    }
    Ok(total)
}
fn remove_owned(root: &Path, owner: &str) -> Result<(), String> {
    if manifest(root).is_none_or(|m| m.owner != owner) {
        return Err("续传目录所有权无法核验，未清理".into());
    }
    // Never follow a link or recurse into an unexpected child directory.
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if !kind.is_file() || kind.is_symlink() {
            return Err("续传目录含未知对象，未清理".into());
        }
    }
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        fs::remove_file(entry.map_err(|e| e.to_string())?.path()).map_err(|e| e.to_string())?;
    }
    fs::remove_dir(root).map_err(|e| e.to_string())
}
impl Partial {
    pub(crate) fn open(
        destination: &Path,
        identity: &str,
        expected: Option<u64>,
    ) -> Result<Self, String> {
        let parent = destination
            .parent()
            .ok_or("附件目录不可用")?
            .canonicalize()
            .map_err(|e| e.to_string())?;
        for entry in fs::read_dir(&parent).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if let Some(m) = manifest(&entry.path()) {
                if now_timestamp().saturating_sub(m.touched) > TTL {
                    remove_owned(&entry.path(), &m.owner)?;
                }
            }
        }
        let owner = encode_digest_hex(&Sha256::digest(identity.as_bytes()));
        let root = parent.join(format!("{PREFIX}{owner}"));
        let prior = if root.exists() {
            Some(manifest(&root).ok_or("续传目录所有权无法核验")?)
        } else {
            None
        };
        if usage(&parent)? > BUDGET {
            return Err("未完成附件已达 64 GB 保留预算，请清理或完成已有下载".into());
        }
        if let Some(m) = &prior {
            if m.owner != owner || m.expected != expected {
                return Err("续传资源身份已变化".into());
            }
        }
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let mut stage = Self {
            root,
            manifest: prior.unwrap_or(Manifest {
                owner,
                touched: now_timestamp(),
                expected,
                validator: None,
                verified_length: 0,
                partial_hash: String::new(),
            }),
        };
        if stage.data().exists() {
            use std::io::Read;
            let mut file = fs::File::open(stage.data()).map_err(|e| e.to_string())?;
            let mut remaining = stage.manifest.verified_length;
            let mut hash = Sha256::new();
            let mut buffer = [0u8; 65536];
            while remaining > 0 {
                let n = file
                    .read(&mut buffer[..remaining.min(65536) as usize])
                    .map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                hash.update(&buffer[..n]);
                remaining -= n as u64;
            }
            if remaining != 0 || format!("{:x}", hash.finalize()) != stage.manifest.partial_hash {
                stage.manifest.verified_length = 0;
                stage.manifest.validator = None;
            }
            drop(file);
            fs::OpenOptions::new()
                .write(true)
                .open(stage.data())
                .map_err(|e| e.to_string())?
                .set_len(stage.manifest.verified_length)
                .map_err(|e| e.to_string())?;
        }
        stage.persist()?;
        Ok(stage)
    }
    fn persist(&mut self) -> Result<(), String> {
        self.manifest.touched = now_timestamp();
        let temporary = self.root.join("owner.next");
        fs::write(
            &temporary,
            serde_json::to_vec(&self.manifest).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        fs::rename(temporary, self.root.join("owner.json")).map_err(|e| e.to_string())
    }
    pub(crate) fn data(&self) -> PathBuf {
        self.root.join("body.part")
    }
    pub(crate) fn length(&self) -> u64 {
        fs::metadata(self.data()).map(|m| m.len()).unwrap_or(0)
    }
    pub(crate) fn validator(&self) -> Option<&str> {
        self.manifest.validator.as_deref()
    }
    pub(crate) fn set_validator(&mut self, validator: Option<String>) -> Result<(), String> {
        self.manifest.validator = validator;
        self.persist()
    }
    pub(crate) fn checkpoint(&mut self, length: u64, hash: String) -> Result<(), String> {
        self.manifest.verified_length = length;
        self.manifest.partial_hash = hash;
        self.persist()
    }
    pub(crate) fn reset(&mut self) -> Result<(), String> {
        if self.data().exists() {
            fs::OpenOptions::new()
                .write(true)
                .open(self.data())
                .map_err(|e| e.to_string())?
                .set_len(0)
                .map_err(|e| e.to_string())?;
        }
        self.checkpoint(0, format!("{:x}", Sha256::digest([])))
    }
    pub(crate) fn budget(&self, growth: u64) -> Result<(), String> {
        if usage(self.root.parent().ok_or("续传目录不可用")?)?.saturating_add(growth) > BUDGET
        {
            return Err("未完成附件已达 64 GB 保留预算，已保留续传数据".into());
        }
        #[cfg(windows)]
        if crate::local_database_maintenance::available_space(&self.root)?
            < growth.saturating_add(64 * 1024 * 1024)
        {
            return Err("附件目录剩余空间不足，已保留续传数据".into());
        }
        Ok(())
    }
    pub(crate) fn discard(self) -> Result<(), String> {
        remove_owned(&self.root, &self.manifest.owner)
    }
}
