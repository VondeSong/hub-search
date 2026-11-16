//! Identity of the exact temporary credential snapshot, never provider attestation.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::{Path, PathBuf},
};

pub(super) struct Prepared {
    pub(super) bytes: Vec<u8>,
    pub(super) identity: String,
}
impl Prepared {
    fn decode(bytes: &[u8]) -> Result<Self, String> {
        let mut value: Value =
            serde_json::from_slice(bytes).map_err(|_| "Codex 登录状态格式不可用")?;
        if !value.is_object() {
            return Err("Codex 登录状态格式不可用".into());
        }
        // The installed Codex remains the refresh-token owner, as before.
        if value["tokens"].is_object() {
            value["tokens"]["refresh_token"] = json!("");
        }
        let bytes = serde_json::to_vec(&value).map_err(|_| "登录状态编码失败")?;
        let identity = format!("{:x}", Sha256::digest(&bytes));
        Ok(Self { bytes, identity })
    }
    pub(super) fn verify(&self, expected: &str) -> Result<(), String> {
        if expected != self.identity {
            return Err("Codex 登录凭据在上下文核验后发生变化；未启动提供方，请在同一事项重新开始，历史与预算保留".into());
        }
        Ok(())
    }
}
fn read(path: &Path) -> Result<Prepared, String> {
    let file = std::fs::File::open(path).map_err(|_| "请先在 Codex 登录，再使用持续 Agent 会话")?;
    let mut bytes = Vec::new();
    file.take(256 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取 Codex 登录状态")?;
    if bytes.len() > 256 * 1024 {
        return Err("Codex 登录状态格式不可用".into());
    }
    Prepared::decode(&bytes)
}
pub(super) fn current() -> Result<Prepared, String> {
    let home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .map(|p| PathBuf::from(p).join(".codex"))
        })
        .ok_or("无法定位 Codex 登录状态")?;
    read(&home.join("auth.json"))
}

pub(super) fn current_for(root: Option<&Path>, selected: Option<&str>) -> Result<Prepared, String> {
    let Some(root) = root else {
        return current();
    };
    let account = super::super::accounts::current_selected(root, selected)?;
    let value = if account.login["type"] == "apiKey" {
        json!({"auth_mode":"apikey","OPENAI_API_KEY":account.login["apiKey"]})
    } else {
        json!({"hubExternalLogin":account.login,"scopeId":account.public["scopeId"]})
    };
    Prepared::decode(&serde_json::to_vec(&value).map_err(|_| "无法准备 Codex 账号授权")?)
}

pub(super) fn snapshot(path: &Path, bytes: &[u8]) -> Result<std::fs::File, String> {
    use std::io::Write;
    let error = "无法提供 Agent 临时登录状态；文件被占用或路径不可用";
    if std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink() || !m.is_file()) {
        return Err(error.into());
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows::Win32::Storage::FileSystem::{FILE_FLAG_DELETE_ON_CLOSE, FILE_SHARE_READ};
        // Windows closes this non-inherited handle even when the host is forcibly terminated.
        options
            .custom_flags(FILE_FLAG_DELETE_ON_CLOSE.0)
            .share_mode(FILE_SHARE_READ.0);
    }
    let mut file = options.open(path).map_err(|_| error)?;
    file.write_all(bytes)
        .and_then(|_| file.flush())
        .map_err(|_| error)?;
    Ok(file)
}

#[cfg(all(test, windows))]
mod cleanup_tests;

#[cfg(test)]
mod tests {
    use super::*;
    fn fake(account: &str, access: &str, refresh: &str) -> Value {
        json!({"auth_mode":"chatgpt","tokens":{"account_id":account,"access_token":access,"refresh_token":refresh}})
    }
    fn prepared(value: &Value) -> Prepared {
        Prepared::decode(&serde_json::to_vec(value).unwrap()).unwrap()
    }
    #[test]
    fn identity_binds_only_the_exact_copied_snapshot_and_never_copies_refresh_owner() {
        let value = fake(
            "SYNTHETIC_ACCOUNT_A",
            "SYNTHETIC_ACCESS_A",
            "SYNTHETIC_REFRESH_A",
        );
        let p = prepared(&value);
        let copied: Value = serde_json::from_slice(&p.bytes).unwrap();
        assert_eq!(copied["tokens"]["refresh_token"], "");
        assert_eq!(
            copied["tokens"]["access_token"],
            value["tokens"]["access_token"]
        );
        assert_eq!(
            p.identity,
            prepared(&fake(
                "SYNTHETIC_ACCOUNT_A",
                "SYNTHETIC_ACCESS_A",
                "SYNTHETIC_REFRESH_B"
            ))
            .identity
        );
        for changed in [
            fake("SYNTHETIC_ACCOUNT_B", "SYNTHETIC_ACCESS_A", "r"),
            fake("SYNTHETIC_ACCOUNT_A", "SYNTHETIC_ACCESS_B", "r"),
            json!({"OPENAI_API_KEY":"SYNTHETIC_API_KEY"}),
        ] {
            assert!(prepared(&changed).verify(&p.identity).is_err());
        }
        assert!(p.verify(&p.identity).is_ok());
        assert!(p.verify("").is_err());
    }
    #[test]
    fn real_isolated_file_change_after_binding_refuses_and_leaves_source_untouched() {
        let dir =
            std::env::temp_dir().join(format!("hub-auth-epoch-{}", crate::random_url_safe(12)));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("auth.json");
        std::fs::write(
            &path,
            serde_json::to_vec(&fake("A", "SYNTHETIC_A", "r")).unwrap(),
        )
        .unwrap();
        let first = read(&path).unwrap();
        std::fs::write(
            &path,
            serde_json::to_vec(&fake("B", "SYNTHETIC_B", "r")).unwrap(),
        )
        .unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let mtime = std::fs::metadata(&path).unwrap().modified().unwrap();
        let runtime = dir.join("must-not-exist");
        let control = crate::model_runtime::Control::bounded(std::time::Duration::from_secs(1));
        let refused = super::super::spawn(
            &runtime,
            &first.identity,
            read(&path).unwrap(),
            "",
            "",
            false,
            &control,
            Default::default(),
        );
        let error = match refused {
            Ok(_) => panic!("changed credentials must not start a provider"),
            Err(error) => error,
        };
        assert!(error.contains("凭据"));
        assert!(!runtime.exists());
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), mtime);
        std::fs::write(&path, vec![b' '; 256 * 1024 + 1]).unwrap();
        assert!(read(&path).is_err());
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(&dir).unwrap();
    }
    #[test]
    fn malformed_credentials_are_rejected_without_echoing_content() {
        for raw in [b"[]".as_slice(), b"SYNTHETIC_INVALID_SECRET", b"null"] {
            let error = match Prepared::decode(raw) {
                Ok(_) => panic!("invalid fixture accepted"),
                Err(error) => error,
            };
            assert!(!error.contains("SYNTHETIC"));
        }
    }
}
