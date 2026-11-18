//! Device-binding-specific read cache. Never converts a cached read into a delivery receipt.
use super::*;
use std::path::{Path, PathBuf};

fn directory(root: &Path, config: &Config) -> PathBuf {
    root.join("cloud-agents-cache")
        .join(config_view(config)["binding"].as_str().unwrap())
}
fn path(root: &Path, config: &Config, key: &str) -> PathBuf {
    directory(root, config).join(format!("{:x}.json", Sha256::digest(key.as_bytes())))
}
pub(super) fn put(root: &Path, config: &Config, key: &str, data: &Value) -> Result<(), String> {
    let dir = directory(root, config);
    crate::craft_backup::reject_links(&dir)?;
    std::fs::create_dir_all(&dir).map_err(|_| "无法准备云端离线缓存")?;
    let target = path(root, config, key);
    crate::craft_backup::reject_links(&target)?;
    let value = json!({"data":data,"savedAt":chrono::Utc::now().timestamp_millis()});
    let bytes = serde_json::to_vec(&value).map_err(|_| "缓存格式无效")?;
    if bytes.len() > MAX_RESPONSE {
        return Err("单份离线缓存过大".into());
    }
    let mut entries = std::fs::read_dir(&dir)
        .map_err(|_| "无法检查缓存容量")?
        .filter_map(Result::ok)
        .filter(|v| v.path() != target)
        .filter_map(|v| {
            v.metadata()
                .ok()
                .map(|m| (v.path(), m.modified().ok(), m.len()))
        })
        .collect::<Vec<_>>();
    entries.sort_by_key(|v| v.1);
    let mut total = entries.iter().map(|v| v.2).sum::<u64>() + bytes.len() as u64;
    let count = entries.len();
    for (index, (p, _, size)) in entries.into_iter().enumerate() {
        if total <= 64 * 1024 * 1024 && count - index < 64 {
            break;
        }
        crate::craft_backup::reject_links(&p)?;
        std::fs::remove_file(p).map_err(|_| "无法清理旧离线缓存")?;
        total = total.saturating_sub(size);
    }
    crate::data_portability::atomic_write(&target, &bytes)
}
pub(super) fn get(root: &Path, config: &Config, key: &str) -> Result<Value, String> {
    let p = path(root, config, key);
    crate::craft_backup::reject_links(&p)?;
    if std::fs::metadata(&p)
        .map_err(|_| "此内容尚未在本机读取，请连接云端后重试")?
        .len()
        > MAX_RESPONSE as u64
    {
        return Err("离线缓存超出限制".into());
    }
    let saved: Value = serde_json::from_slice(&std::fs::read(p).map_err(|_| "离线缓存不可读")?)
        .map_err(|_| "离线缓存已损坏，请联网重新读取")?;
    let mut data = saved["data"].clone();
    if !data.is_object() || !saved["savedAt"].is_i64() {
        return Err("离线缓存结构无效，请联网重新读取".into());
    }
    data["cached"] = json!(true);
    data["cachedAt"] = saved["savedAt"].clone();
    Ok(data)
}
pub(super) fn remove(root: &Path, config: &Config, key: &str) -> Result<(), String> {
    let p = path(root, config, key);
    crate::craft_backup::reject_links(&p)?;
    if p.exists() {
        std::fs::remove_file(p).map_err(|_| "无法清理旧缓存")?;
    }
    Ok(())
}
pub(super) fn clear(root: &Path, config: &Config) -> Result<(), String> {
    let dir = directory(root, config);
    crate::craft_backup::reject_links(&dir)?;
    if !dir.exists() {
        return Ok(());
    }
    for file in std::fs::read_dir(dir).map_err(|_| "无法读取缓存目录")? {
        let file = file.map_err(|_| "缓存条目不可读")?;
        crate::craft_backup::reject_links(&file.path())?;
        std::fs::remove_file(file.path()).map_err(|_| "无法清除离线缓存")?;
    }
    Ok(())
}
pub(super) async fn read(root: &Path, config: &Config, url: &str) -> Result<Value, String> {
    match request(config, Method::GET, url, None, false).await {
        Ok(mut value) => {
            // An already fetched server result is still useful if the cache disk is full.
            if let Err(error) = put(root, config, url, &value) {
                value["cacheWarning"] = json!(error);
            }
            Ok(value)
        }
        Err(RequestFailure::Transport(_)) | Err(RequestFailure::Http(500..=599, _)) => {
            get(root, config, url)
        }
        Err(RequestFailure::Http(401 | 403, error)) => {
            let warning = clear(root, config).err();
            Ok(
                json!({"accessDenied":true,"error":error,"cacheWarning":warning,"threads":[],"thread":null}),
            )
        }
        Err(error) => {
            remove(root, config, url)?;
            Err(error.into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cache_is_bound_atomic_and_explicitly_stale() {
        let temp = crate::source_evidence::tests::Fixture::new();
        let one = Config {
            endpoint: "https://example.com/".into(),
            token: "first".into(),
        };
        let two = Config {
            endpoint: one.endpoint.clone(),
            token: "second".into(),
        };
        put(
            &temp.root,
            &one,
            "/v1/threads",
            &json!({"threads":[{"id":"original"}]}),
        )
        .unwrap();
        assert!(get(&temp.root, &two, "/v1/threads").is_err());
        let saved = get(&temp.root, &one, "/v1/threads").unwrap();
        assert_eq!(saved["cached"], true);
        assert_eq!(saved["threads"][0]["id"], "original");
        clear(&temp.root, &one).unwrap();
        assert!(get(&temp.root, &one, "/v1/threads").is_err());
    }
}
