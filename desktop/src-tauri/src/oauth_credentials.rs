//! OAuth payload publication. A reader sees one immutable generation, never mixed chunks.
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const LEGACY_PREFIX: &str = "hub-credential-chunks:v1:";
const PREFIX: &str = "hub-credential-chunks:v2:";
const UNITS: usize = 1_000;
const MAX_CHUNKS: usize = 1_024;

pub(crate) trait SecretStore {
    fn get(&self, id: &str) -> Result<Option<String>, String>;
    fn set(&self, id: &str, value: &str) -> Result<(), String>;
    fn delete(&self, id: &str) -> Result<(), String>;
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Index {
    generation: String,
    count: usize,
    sha256: String,
}

fn index(raw: &str) -> Result<Option<Index>, String> {
    let Some(json) = raw.strip_prefix(PREFIX) else {
        return Ok(None);
    };
    let value: Index = serde_json::from_str(json).map_err(|_| "OAuth 凭据索引损坏")?;
    if value.count == 0
        || value.count > MAX_CHUNKS
        || value.generation.len() != 32
        || !value.generation.bytes().all(|v| v.is_ascii_hexdigit())
        || value.sha256.len() != 64
        || !value.sha256.bytes().all(|v| v.is_ascii_hexdigit())
    {
        return Err("OAuth 凭据索引无效".into());
    }
    Ok(Some(value))
}

fn chunk_id(id: &str, generation: &str, position: usize) -> String {
    format!("{id}:generation:{generation}:chunk:{position}")
}

pub(crate) fn split_payload(payload: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut part = String::new();
    let mut units = 0;
    for character in payload.chars() {
        let size = character.len_utf16();
        if units + size > UNITS && !part.is_empty() {
            parts.push(std::mem::take(&mut part));
            units = 0;
        }
        part.push(character);
        units += size;
    }
    if !part.is_empty() {
        parts.push(part);
    }
    parts
}

fn obsolete(store: &impl SecretStore, id: &str, raw: &str) {
    if let Ok(Some(old)) = index(raw) {
        for n in 0..old.count {
            let _ = store.delete(&chunk_id(id, &old.generation, n));
        }
    } else if let Some(count) = raw
        .strip_prefix(LEGACY_PREFIX)
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|n| *n <= MAX_CHUNKS)
    {
        for n in 0..count {
            let _ = store.delete(&format!("{id}:chunk:{n}"));
        }
    }
}

pub(crate) fn save(store: &impl SecretStore, id: &str, payload: &str) -> Result<(), String> {
    // Fail before touching the old generation if its state cannot be read.
    let previous = store.get(id)?;
    let parts = split_payload(payload);
    if parts.is_empty() || parts.len() > MAX_CHUNKS {
        return Err("OAuth 凭据大小无效".into());
    }
    let mut random = [0; 16];
    rand::thread_rng().fill_bytes(&mut random);
    let generation = random
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let next = Index {
        generation,
        count: parts.len(),
        sha256: format!("{:x}", Sha256::digest(payload.as_bytes())),
    };
    let pointer = format!(
        "{PREFIX}{}",
        serde_json::to_string(&next).map_err(|_| "无法编码 OAuth 凭据索引")?
    );
    for (n, part) in parts.iter().enumerate() {
        let key = chunk_id(id, &next.generation, n);
        if let Err(error) = store.set(&key, part).and_then(|_| {
            if store.get(&key)?.as_deref() != Some(part.as_str()) {
                return Err("OAuth 凭据分片读回失败".into());
            }
            Ok(())
        }) {
            // Only unpublished generation IDs are eligible for cleanup.
            for position in 0..=n {
                let _ = store.delete(&chunk_id(id, &next.generation, position));
            }
            return Err(error);
        }
    }
    if let Err(error) = store.set(id, &pointer) {
        match store.get(id) {
            Ok(Some(current)) if current == pointer => {} // lost acknowledgement after publication
            Ok(_) => {
                obsolete(store, id, &pointer);
                return Err(error);
            }
            Err(_) => return Err(error), // unknown physical outcome: preserve both generations
        }
    }
    if let Some(previous) = previous {
        obsolete(store, id, &previous);
    }
    Ok(())
}

pub(crate) fn load(store: &impl SecretStore, id: &str) -> Result<Option<String>, String> {
    for _ in 0..4 {
        let Some(pointer) = store.get(id)? else {
            return Ok(None);
        };
        let read = (|| {
            let mut result = String::new();
            if let Some(value) = index(&pointer)? {
                for n in 0..value.count {
                    result.push_str(
                        &store
                            .get(&chunk_id(id, &value.generation, n))?
                            .ok_or("OAuth 凭据分片缺失")?,
                    );
                }
                if format!("{:x}", Sha256::digest(result.as_bytes())) != value.sha256 {
                    return Err("OAuth 凭据内容校验失败".into());
                }
            } else if let Some(raw) = pointer.strip_prefix(LEGACY_PREFIX) {
                let count = raw
                    .parse::<usize>()
                    .ok()
                    .filter(|n| *n > 0 && *n <= MAX_CHUNKS)
                    .ok_or("旧 OAuth 凭据索引无效")?;
                for n in 0..count {
                    result.push_str(
                        &store
                            .get(&format!("{id}:chunk:{n}"))?
                            .ok_or("旧 OAuth 凭据分片缺失")?,
                    );
                }
            } else {
                result = pointer.clone();
            }
            Ok(result)
        })();
        // Retired chunks may disappear after publication; retry the new pointer.
        if store.get(id)?.as_deref() != Some(pointer.as_str()) {
            continue;
        }
        return read.map(Some);
    }
    Err("OAuth 凭据正在更新，请重试".into())
}

pub(crate) fn remove(store: &impl SecretStore, id: &str) -> Result<(), String> {
    let previous = store.get(id)?;
    store.delete(id)?;
    if let Some(previous) = previous {
        obsolete(store, id, &previous);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        cell::{Cell, RefCell},
        collections::HashMap,
    };
    #[derive(Default)]
    struct Memory {
        data: RefCell<HashMap<String, String>>,
        calls: Cell<usize>,
        fail: Cell<Option<usize>>,
        lose_ack: Cell<bool>,
    }
    impl SecretStore for Memory {
        fn get(&self, id: &str) -> Result<Option<String>, String> {
            Ok(self.data.borrow().get(id).cloned())
        }
        fn set(&self, id: &str, value: &str) -> Result<(), String> {
            let n = self.calls.get();
            self.calls.set(n + 1);
            if self.fail.get() == Some(n) {
                return Err("injected storage failure".into());
            }
            self.data.borrow_mut().insert(id.into(), value.into());
            if id == "account" && self.lose_ack.replace(false) {
                return Err("lost acknowledgement".into());
            }
            Ok(())
        }
        fn delete(&self, id: &str) -> Result<(), String> {
            self.data.borrow_mut().remove(id);
            Ok(())
        }
    }
    #[test]
    fn shared_unicode_chunks_preserve_payload_and_utf16_store_limit() {
        let payload = format!("{}🦀{}", "字".repeat(999), "é🦀".repeat(700));
        let chunks = split_payload(&payload);
        assert_eq!(chunks.concat(), payload);
        assert!(chunks
            .iter()
            .all(|part| part.encode_utf16().count() <= UNITS));
        assert_eq!(chunks[0].encode_utf16().count(), 999);
    }
    #[test]
    fn credential_publication_failures_preserve_complete_previous_generation() {
        for failure in 0..4 {
            let store = Memory::default();
            let previous = "previous🦀".repeat(300);
            save(&store, "account", &previous).unwrap();
            store.calls.set(0);
            store.fail.set(Some(failure));
            assert!(save(&store, "account", &"next🦀".repeat(400)).is_err());
            assert_eq!(load(&store, "account").unwrap().unwrap(), previous);
        }
    }
    #[test]
    fn credential_publication_recovers_lost_ack_and_reads_legacy_chunks() {
        let store = Memory::default();
        store
            .data
            .borrow_mut()
            .insert("account".into(), format!("{LEGACY_PREFIX}2"));
        store
            .data
            .borrow_mut()
            .insert("account:chunk:0".into(), "legacy ".into());
        store
            .data
            .borrow_mut()
            .insert("account:chunk:1".into(), "credential".into());
        assert_eq!(
            load(&store, "account").unwrap().unwrap(),
            "legacy credential"
        );
        store.lose_ack.set(true);
        save(&store, "account", "next credential").unwrap();
        assert_eq!(load(&store, "account").unwrap().unwrap(), "next credential");
        assert!(!store.data.borrow().contains_key("account:chunk:0"));
        remove(&store, "account").unwrap();
        assert!(store.data.borrow().is_empty());
    }
    #[test]
    fn unpublished_interruption_does_not_change_reader_and_corruption_is_rejected() {
        let store = Memory::default();
        save(&store, "account", &"old".repeat(600)).unwrap();
        let before = load(&store, "account").unwrap();
        store
            .set("account:generation:unpublished:chunk:0", "interrupted")
            .unwrap();
        assert_eq!(load(&store, "account").unwrap(), before);
        let pointer = store.get("account").unwrap().unwrap();
        let value = index(&pointer).unwrap().unwrap();
        store
            .set(&chunk_id("account", &value.generation, 0), "corrupt")
            .unwrap();
        assert!(load(&store, "account").is_err());
    }
}
