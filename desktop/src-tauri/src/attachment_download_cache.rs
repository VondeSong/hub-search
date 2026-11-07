//! Download admission uses verified bytes and the currently claimed resource generation.
use crate::{
    blob_store::BlobStore, library_runtime, open_database, open_write_database, DownloadedSource,
    PipelineJob, StoredBlob,
};
use rusqlite::{params, OptionalExtension};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{io::Read, path::PathBuf};

pub(crate) mod revalidation;

pub(crate) fn resource_generation(metadata: &str) -> u64 {
    serde_json::from_str::<Value>(metadata)
        .ok()
        .and_then(|value| value.get("resourceGeneration").and_then(Value::as_u64))
        .unwrap_or(0)
}

pub(crate) struct RequestGuard<'a> {
    pub path: &'a PathBuf,
    pub job: &'a PipelineJob,
    pub generation: Option<u64>,
}

pub(crate) trait DownloadCheckpoint: Send + Sync {
    fn checkpoint(&self) -> Result<(), String>;
}

impl DownloadCheckpoint for RequestGuard<'_> {
    fn checkpoint(&self) -> Result<(), String> {
        RequestGuard::checkpoint(self)
    }
}

impl RequestGuard<'_> {
    pub(crate) fn checkpoint(&self) -> Result<(), String> {
        let connection = open_database(self.path)?;
        let metadata: Option<String> = connection
            .query_row(
                "SELECT s.metadata_json FROM index_jobs j JOIN source_items s ON s.id=j.source_id
             WHERE j.id=?1 AND j.status='running' AND j.worker_id=?2",
                params![self.job.id, self.job.worker_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("无法核对附件下载版本：{error}"))?
            .flatten();
        let metadata = metadata.ok_or("CONTENT_POLICY:附件下载任务已更新")?;
        if self
            .generation
            .is_some_and(|expected| resource_generation(&metadata) != expected)
        {
            return Err("CONTENT_POLICY:附件资源已有新版本，旧下载已让出".into());
        }
        crate::attachment_download_failures::require_transfer(
            &connection,
            &self.job.source_id,
            &metadata,
        )?;
        Ok(())
    }
}

/// Only queued work is checked here. A scan does not reread every cached file.
/// The commit side checks this same generation and hash again under the writer.
pub(crate) fn verified_source(
    path: &PathBuf,
    store: &BlobStore,
    job: &PipelineJob,
    operation: &library_runtime::Operation,
) -> Result<Option<(DownloadedSource, Option<u64>)>, String> {
    let connection = open_database(path)?;
    let row = connection
        .query_row(
            "SELECT s.blob_hash,b.size,COALESCE(s.mime_type,b.mime_type,''),
                COALESCE(s.metadata_json,'{}'),s.provider
         FROM source_items s JOIN blobs b ON b.hash=s.blob_hash WHERE s.id=?1",
            params![job.source_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, u64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("无法检查附件缓存：{error}"))?;
    drop(connection);
    let Some((hash, size, mime_type, metadata, provider)) = row else {
        return Ok(None);
    };
    let expected_size = serde_json::from_str::<Value>(&metadata)
        .ok()
        .and_then(|value| value.get("size").and_then(Value::as_u64));
    let generation = matches!(
        provider.as_str(),
        crate::PROVIDER_CRAFT | crate::PROVIDER_DIDA365
    )
    .then(|| resource_generation(&metadata));
    let verified = (|| -> Result<bool, String> {
        if size == 0 || expected_size.is_some_and(|expected| expected != size) {
            return Ok(false);
        }
        let mut file =
            std::fs::File::open(store.path_for(&hash)?).map_err(|error| error.to_string())?;
        if file.metadata().map_err(|error| error.to_string())?.len() != size {
            return Ok(false);
        }
        let mut digest = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            operation.checkpoint()?;
            let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            digest.update(&buffer[..read]);
        }
        Ok(format!("{:x}", digest.finalize()) == hash)
    })();
    let verified = match verified {
        Ok(value) => value,
        Err(error) if library_runtime::is_control_error(&error) => return Err(error),
        Err(_) => false,
    };
    if !verified {
        let (connection, _writer) = open_write_database(path)?;
        operation.checkpoint()?;
        let current: Option<String> = connection.query_row(
            "SELECT s.metadata_json FROM source_items s JOIN index_jobs j ON j.source_id=s.id
             WHERE s.id=?1 AND s.blob_hash=?2 AND j.id=?3 AND j.status='running' AND j.worker_id=?4",
            params![job.source_id,hash,job.id,job.worker_id],|row|row.get(0),
        ).optional().map_err(|error|format!("无法核对失效附件缓存：{error}"))?.flatten();
        if current.as_deref().is_some_and(|metadata| {
            generation.is_none_or(|expected| resource_generation(metadata) == expected)
        }) {
            operation.commit(||connection.execute(
                "UPDATE source_items SET blob_hash=NULL,content_hash=NULL,status='discovered' WHERE id=?1 AND blob_hash=?2",
                params![job.source_id,hash],
            ).map(|_|()).map_err(|error|format!("无法让出失效附件缓存：{error}")))?;
        }
        return Ok(None);
    }
    Ok(Some((
        DownloadedSource {
            blob: StoredBlob {
                relative_path: format!("{}/{hash}", &hash[..2]),
                hash,
                size,
            },
            mime_type,
        },
        generation,
    )))
}
