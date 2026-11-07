//! One in-flight producer and verified byte reuse for a provider resource.
//! Callers keep the lease through their guarded source commit; source IDs and
//! their local generation counters do not identify the shared resource.
use crate::{blob_store::BlobStore, library_runtime, open_database, DownloadedSource, StoredBlob};
use rusqlite::params;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::Read,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock, Weak},
};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

#[derive(Clone, Eq, Hash, PartialEq)]
enum LockKind {
    Resource,
    Source,
}

#[derive(Clone, Eq, Hash, PartialEq)]
struct ResourceKey {
    kind: LockKind,
    database: PathBuf,
    library: String,
    provider: String,
    locator: String,
    revision: Option<String>,
    size: Option<u64>,
}

impl ResourceKey {
    fn from_metadata(
        database: PathBuf,
        library: &str,
        provider: &str,
        metadata: &str,
    ) -> Result<Self, String> {
        let value: Value =
            serde_json::from_str(metadata).map_err(|_| "附件共享缓存元数据无效".to_string())?;
        let url = value
            .get("remoteUrl")
            .and_then(Value::as_str)
            .filter(|url| !url.is_empty())
            .ok_or("附件共享缓存元数据缺少资源地址")?;
        // Native media tokens are case-sensitive identifiers, not web hosts.
        let locator = if provider == crate::PROVIDER_FEISHU {
            url.to_string()
        } else {
            crate::craft_attachment_resource_locator(url)
        };
        Ok(Self {
            kind: LockKind::Resource,
            database,
            library: library.into(),
            provider: provider.into(),
            locator,
            revision: value
                .get("resourceRevision")
                .and_then(Value::as_str)
                .filter(|revision| !revision.is_empty())
                .map(str::to_owned),
            size: value.get("size").and_then(Value::as_u64),
        })
    }
}

type LockTable = HashMap<ResourceKey, Weak<AsyncMutex<()>>>;

fn lock_table() -> &'static Mutex<LockTable> {
    static TABLE: OnceLock<Mutex<LockTable>> = OnceLock::new();
    TABLE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn database_namespace(path: &PathBuf) -> Result<PathBuf, String> {
    let path = path
        .canonicalize()
        .map_err(|_| "无法确定附件缓存数据库身份".to_string())?;
    #[cfg(windows)]
    let path = PathBuf::from(path.to_string_lossy().to_ascii_lowercase());
    Ok(path)
}

pub(crate) struct ResourceLease {
    key: ResourceKey,
    guard: Option<OwnedMutexGuard<()>>,
}

pub(crate) struct SourceLease {
    _lease: ResourceLease,
}

impl ResourceLease {
    pub(crate) fn matches_metadata(
        &self,
        library: &str,
        provider: &str,
        metadata: &str,
    ) -> Result<bool, String> {
        Ok(self.key
            == ResourceKey::from_metadata(self.key.database.clone(), library, provider, metadata)?)
    }
}

impl Drop for ResourceLease {
    fn drop(&mut self) {
        // Release the strong reference before reclaiming dead keys. Waiting
        // callers retain their own Arc, so an active resource never gets a
        // second mutex while another caller is queued for the existing one.
        drop(self.guard.take());
        if let Ok(mut table) = lock_table().lock() {
            table.retain(|_, lock| lock.strong_count() != 0);
        }
    }
}

pub(crate) async fn acquire(
    database: &PathBuf,
    library: &str,
    provider: &str,
    metadata: &str,
) -> Result<ResourceLease, String> {
    let key =
        ResourceKey::from_metadata(database_namespace(database)?, library, provider, metadata)?;
    acquire_key(key).await
}

/// Producers acquire a source lease before a resource lease, and keep both
/// through their guarded commit. This also serializes one stable Craft block
/// whose provider URL rotates without changing its resource revision.
pub(crate) async fn acquire_source(
    database: &PathBuf,
    library: &str,
    provider: &str,
    source_id: &str,
) -> Result<SourceLease, String> {
    let key = ResourceKey {
        kind: LockKind::Source,
        database: database_namespace(database)?,
        library: library.into(),
        provider: provider.into(),
        locator: source_id.into(),
        revision: None,
        size: None,
    };
    Ok(SourceLease {
        _lease: acquire_key(key).await?,
    })
}

async fn acquire_key(key: ResourceKey) -> Result<ResourceLease, String> {
    // An omitted length is compatible with a known length. Serialize both
    // callers on the same locator/revision; capture size separately in `key`
    // so a caller still notices source metadata changes while waiting.
    let mut lock_key = key.clone();
    lock_key.size = None;
    let lock = {
        let mut table = lock_table()
            .lock()
            .map_err(|_| "附件共享缓存锁状态不可用".to_string())?;
        table.retain(|_, lock| lock.strong_count() != 0);
        if let Some(lock) = table.get(&lock_key).and_then(Weak::upgrade) {
            lock
        } else {
            let lock = Arc::new(AsyncMutex::new(()));
            table.insert(lock_key, Arc::downgrade(&lock));
            lock
        }
    };
    let guard = lock.lock_owned().await;
    Ok(ResourceLease {
        key,
        guard: Some(guard),
    })
}

/// Read-only cache lookup; download producers hold the matching resource lease
/// around lookup, network access and guarded source commit. A candidate must
/// agree on provider, library, resource locator and revision; declared lengths
/// must also agree with the actual verified blob descriptor. A source-local
/// generation never makes another source's cached bytes current by itself.
pub(crate) fn verified_resource(
    database: &PathBuf,
    store: &BlobStore,
    library: &str,
    provider: &str,
    metadata: &str,
    operation: Option<&library_runtime::Operation>,
) -> Result<Option<DownloadedSource>, String> {
    let key =
        ResourceKey::from_metadata(database_namespace(database)?, library, provider, metadata)?;
    let connection = open_database(database)?;
    let mut statement = connection.prepare(
        "SELECT s.metadata_json,b.hash,b.size,COALESCE(NULLIF(b.mime_type,''),s.mime_type,'application/octet-stream')
         FROM source_items s JOIN blobs b ON b.hash=s.blob_hash
         WHERE s.space_id=?1 AND s.provider=?2 AND s.metadata_json IS NOT NULL
         ORDER BY s.updated_at DESC,s.id",
    ).map_err(|error| format!("无法准备共享附件缓存查询：{error}"))?;
    let rows = statement
        .query_map(params![library, provider], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, u64>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|error| format!("无法读取共享附件缓存：{error}"))?;
    let rows = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法读取共享附件缓存记录：{error}"))?;
    drop(statement);
    drop(connection);
    for (candidate_metadata, hash, size, mime_type) in rows {
        if let Some(operation) = operation {
            operation.checkpoint()?;
        }
        let Ok(candidate) = ResourceKey::from_metadata(
            key.database.clone(),
            library,
            provider,
            &candidate_metadata,
        ) else {
            continue;
        };
        if matches!(provider, crate::PROVIDER_CRAFT | crate::PROVIDER_DIDA365) {
            let value: Value = serde_json::from_str(&candidate_metadata)
                .map_err(|_| "附件共享缓存元数据无效".to_string())?;
            let generation = value
                .get("resourceGeneration")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let cached_generation = value
                .get("cachedResourceGeneration")
                .and_then(Value::as_u64);
            if cached_generation.map_or(generation != 0, |cached| cached != generation) {
                continue;
            }
        }
        if candidate.locator != key.locator
            || candidate.revision != key.revision
            || size == 0
            || key.size.is_some_and(|expected| expected != size)
            || candidate.size.is_some_and(|expected| expected != size)
        {
            continue;
        }
        if let Some(verified) = verified_blob(store, &hash, size, &mime_type, operation)? {
            return Ok(Some(verified));
        }
    }
    Ok(None)
}

pub(crate) fn verified_blob(
    store: &BlobStore,
    hash: &str,
    size: u64,
    mime_type: &str,
    operation: Option<&library_runtime::Operation>,
) -> Result<Option<DownloadedSource>, String> {
    let valid = (|| -> Result<bool, String> {
        if size == 0 {
            return Ok(false);
        }
        let mut file =
            std::fs::File::open(store.path_for(hash)?).map_err(|error| error.to_string())?;
        if file.metadata().map_err(|error| error.to_string())?.len() != size {
            return Ok(false);
        }
        let mut digest = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            if let Some(operation) = operation {
                operation.checkpoint()?;
            }
            let count = file.read(&mut buffer).map_err(|error| error.to_string())?;
            if count == 0 {
                break;
            }
            digest.update(&buffer[..count]);
        }
        Ok(format!("{:x}", digest.finalize()) == hash)
    })();
    match valid {
        Err(error) if library_runtime::is_control_error(&error) => Err(error),
        Ok(true) => Ok(Some(DownloadedSource {
            blob: StoredBlob {
                relative_path: format!("{}/{hash}", &hash[..2]),
                hash: hash.into(),
                size,
            },
            mime_type: mime_type.into(),
        })),
        _ => Ok(None),
    }
}

#[cfg(test)]
pub(crate) fn namespace_lock_entries(database: &PathBuf) -> Result<usize, String> {
    let namespace = database_namespace(database)?;
    Ok(lock_table()
        .lock()
        .map_err(|_| "附件共享缓存锁状态不可用".to_string())?
        .keys()
        .filter(|key| key.database == namespace)
        .count())
}
