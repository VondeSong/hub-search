//! Existing mobile secret format, with durable atomic replacement and no delete fallback.
use chacha20poly1305::{aead::Aead, KeyInit, XChaCha20Poly1305, XNonce};
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};
const MAGIC: &[u8] = b"HUBSECRET1";

fn key(root: &Path) -> Result<[u8; 32], String> {
    fs::create_dir_all(root).map_err(|e| format!("无法创建移动端凭据目录：{e}"))?;
    let path = root.join(".master-key");
    match fs::read(&path) {
        Ok(bytes) => {
            return bytes
                .try_into()
                .map_err(|_| "移动端凭据主密钥长度无效".into())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("无法读取移动端凭据主密钥：{e}")),
    }
    let mut key = [0; 32];
    rand::thread_rng().fill_bytes(&mut key);
    match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut file) => {
            file.write_all(&key)
                .and_then(|_| file.sync_all())
                .map_err(|e| format!("无法保存移动端凭据主密钥：{e}"))?;
            Ok(key)
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => fs::read(path)
            .map_err(|e| e.to_string())?
            .try_into()
            .map_err(|_| "移动端凭据主密钥长度无效".into()),
        Err(e) => Err(format!("无法创建移动端凭据主密钥：{e}")),
    }
}
fn path(root: &Path, id: &str) -> PathBuf {
    root.join(format!("{:x}.secret", Sha256::digest(id.as_bytes())))
}
pub(crate) fn get(root: &Path, id: &str) -> Result<Option<String>, String> {
    let bytes = match fs::read(path(root, id)) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("无法读取移动端凭据：{e}")),
    };
    let offset = MAGIC.len() + 24;
    if !bytes.starts_with(MAGIC) || bytes.len() <= offset {
        return Err("移动端凭据文件格式无效".into());
    }
    let key = key(root)?;
    let plain = XChaCha20Poly1305::new((&key).into())
        .decrypt(
            XNonce::from_slice(&bytes[MAGIC.len()..offset]),
            &bytes[offset..],
        )
        .map_err(|_| "无法解密移动端凭据")?;
    String::from_utf8(plain)
        .map(Some)
        .map_err(|_| "移动端凭据文本编码无效".into())
}
pub(crate) fn set(root: &Path, id: &str, value: &str) -> Result<(), String> {
    let key = key(root)?;
    let mut nonce = [0; 24];
    rand::thread_rng().fill_bytes(&mut nonce);
    let bytes = XChaCha20Poly1305::new((&key).into())
        .encrypt(XNonce::from_slice(&nonce), value.as_bytes())
        .map_err(|_| "无法加密移动端凭据")?;
    let temporary = root.join(format!(
        ".{:016x}.secret.tmp",
        rand::thread_rng().next_u64()
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        file.write_all(MAGIC)
            .and_then(|_| file.write_all(&nonce))
            .and_then(|_| file.write_all(&bytes))
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        drop(file);
        fs::rename(&temporary, path(root, id))
            .map_err(|e| format!("无法提交移动端凭据；原凭据仍保留：{e}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}
pub(crate) fn delete(root: &Path, id: &str) -> Result<(), String> {
    match fs::remove_file(path(root, id)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Store(PathBuf);
    impl crate::oauth_credentials::SecretStore for Store {
        fn get(&self, id: &str) -> Result<Option<String>, String> {
            get(&self.0, id)
        }
        fn set(&self, id: &str, value: &str) -> Result<(), String> {
            set(&self.0, id, value)
        }
        fn delete(&self, id: &str) -> Result<(), String> {
            delete(&self.0, id)
        }
    }
    #[test]
    fn mobile_oauth_payload_survives_reopening_and_rotation_in_encrypted_store() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../artifacts/performance-audit-20261011/mobile-secrets-tests")
            .join(format!("{:016x}", rand::thread_rng().next_u64()));
        let original = "synthetic-credential🦀".repeat(300);
        crate::oauth_credentials::save(&Store(root.clone()), "oauth-account", &original).unwrap();
        assert_eq!(
            crate::oauth_credentials::load(&Store(root.clone()), "oauth-account")
                .unwrap()
                .unwrap(),
            original
        );
        crate::oauth_credentials::save(
            &Store(root.clone()),
            "oauth-account",
            "rotated synthetic credential",
        )
        .unwrap();
        assert_eq!(
            crate::oauth_credentials::load(&Store(root.clone()), "oauth-account")
                .unwrap()
                .unwrap(),
            "rotated synthetic credential"
        );
        for entry in fs::read_dir(&root).unwrap() {
            let bytes = fs::read(entry.unwrap().path()).unwrap();
            assert!(!bytes.windows(b"synthetic".len()).any(|s| s == b"synthetic"));
        }
        crate::oauth_credentials::remove(&Store(root.clone()), "oauth-account").unwrap();
        assert!(
            crate::oauth_credentials::load(&Store(root), "oauth-account")
                .unwrap()
                .is_none()
        );
    }
}
