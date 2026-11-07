//! Native secret boundary. Never serialize, debug-print or return a secret.
use std::path::Path;
const KEY: &str = "model-provider:deepseek:api-key:v1";

fn entry() -> Result<keyring::Entry, String> {
    crate::credential_entry(KEY).map_err(|_| "无法访问系统模型凭据库。".into())
}
pub(super) fn get() -> Result<Option<String>, String> {
    if crate::isolated_runtime::enabled() {
        return crate::isolated_runtime::secret_get(KEY);
    }
    match entry()?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("无法读取 DeepSeek 凭据，请在模型设置中重新保存。".into()),
    }
}
pub(super) fn save(value: &str) -> Result<(), String> {
    let value = value.trim();
    if !valid(value) {
        return Err("DeepSeek 密钥格式无效。".into());
    }
    if crate::isolated_runtime::enabled() {
        return crate::isolated_runtime::secret_set(KEY, value);
    }
    entry()?
        .set_password(value)
        .map_err(|_| "无法保存 DeepSeek 密钥，原凭据已保留。".into())
}
fn valid(value: &str) -> bool {
    value.starts_with("sk-")
        && (20..=256).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
}
pub(super) fn import(path: &Path) -> Result<(), String> {
    let metadata = std::fs::metadata(path).map_err(|_| "无法读取密钥文件。")?;
    if !metadata.is_file() || metadata.len() > 16_384 {
        return Err("密钥文件格式无效。".into());
    }
    let raw = std::fs::read_to_string(path).map_err(|_| "密钥文件须为 UTF-8 文本。")?;
    let values: Vec<_> = raw
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_')
        .filter(|v| valid(v))
        .collect();
    if values.len() != 1 {
        return Err("密钥文件必须包含且仅包含一个 DeepSeek 密钥。".into());
    }
    save(values[0])
}

#[test]
fn invalid_secrets_are_rejected_before_system_storage() {
    for secret in [
        "",
        "sk-short",
        "sk-a\r\nAuthorization: other",
        "Bearer sk-private",
    ] {
        assert!(!valid(secret));
    }
}
