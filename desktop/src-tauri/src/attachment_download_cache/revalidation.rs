//! HTTP observations belong to the original download/commit boundary. An old
//! proof is only a candidate, never permission to publish a current binding.
use crate::{
    attachment_resource_cache, blob_store::BlobStore, library_runtime, DownloadedSource,
    PipelineJob,
};
use reqwest::{header, Response};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Proof {
    version: u32,
    library: String,
    source: String,
    block: String,
    generation: u64,
    revision: Option<String>,
    hash: String,
    size: u64,
    mime: String,
    target: String,
    etag: Option<String>,
}

pub(crate) struct Candidate {
    proof: Proof,
}

pub(crate) struct Observation {
    target: String,
    etag: Option<String>,
    pub(crate) not_modified: bool,
    pub(crate) body_bytes: u64,
    pub(crate) blob_reused: bool,
}

pub(crate) struct Transfer {
    pub(crate) downloaded: DownloadedSource,
    pub(crate) observation: Observation,
}

fn strong_tag(value: &str) -> bool {
    let bytes = value.as_bytes();
    (2..=512).contains(&bytes.len())
        && bytes[0] == b'"'
        && bytes[bytes.len() - 1] == b'"'
        && bytes[1..bytes.len() - 1]
            .iter()
            .all(|b| *b == 0x21 || (0x23..=0x7e).contains(b))
}

fn target(url: &url::Url) -> String {
    // Keep representation query parameters, remove only known signing fields.
    format!(
        "{:x}",
        Sha256::digest(crate::craft_attachment_resource_locator(url.as_str()).as_bytes())
    )
}

impl Observation {
    pub(crate) fn response(response: &Response) -> Self {
        let h = response.headers();
        let identity = h
            .get(header::CONTENT_ENCODING)
            .is_none_or(|v| v == "identity");
        let vary_safe = h.get(header::VARY).is_none_or(|v| {
            v.to_str().is_ok_and(|s| {
                s.split(',')
                    .all(|name| name.trim().eq_ignore_ascii_case("accept-encoding"))
            })
        });
        let no_store = h.get(header::CACHE_CONTROL).is_some_and(|v| {
            v.to_str().is_ok_and(|s| {
                s.split(',')
                    .any(|part| part.trim().eq_ignore_ascii_case("no-store"))
            })
        });
        let etag = (identity && vary_safe && !no_store)
            .then(|| {
                h.get(header::ETAG)
                    .and_then(|v| v.to_str().ok())
                    .filter(|s| strong_tag(s))
                    .map(str::to_owned)
            })
            .flatten();
        Self {
            target: target(response.url()),
            etag,
            not_modified: false,
            body_bytes: 0,
            blob_reused: false,
        }
    }
}

pub(crate) fn candidate(
    store: &BlobStore,
    job: &PipelineJob,
    metadata: &str,
    provider: &str,
    operation: &library_runtime::Operation,
) -> Result<Option<Candidate>, String> {
    if provider != crate::PROVIDER_CRAFT {
        return Ok(None);
    }
    let Ok(value) = serde_json::from_str::<Value>(metadata) else {
        return Ok(None);
    };
    let Some(raw) = value.get("httpRepresentationProof") else {
        return Ok(None);
    };
    let Ok(proof) = serde_json::from_value::<Proof>(raw.clone()) else {
        return Ok(None);
    };
    let revision = value.get("resourceRevision").and_then(Value::as_str);
    if proof.version != 1
        || proof.library != job.space_id
        || proof.source != job.source_id
        || value.get("discoveryVersion").and_then(Value::as_u64) != Some(2)
        || value.get("blockId").and_then(Value::as_str) != Some(proof.block.as_str())
        || value
            .get("cachedResourceGeneration")
            .and_then(Value::as_u64)
            != Some(proof.generation)
        || proof.generation > super::resource_generation(metadata)
        || revision != proof.revision.as_deref()
        || value
            .get("size")
            .and_then(Value::as_u64)
            .is_some_and(|size| size != proof.size)
        || proof.size == 0
        || proof.size > crate::MAX_ATTACHMENT_BYTES
        || proof.hash.len() != 64
        || !proof
            .hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || proof.target.len() != 64
        || proof.mime.is_empty()
        || !proof.etag.as_deref().is_some_and(strong_tag)
    {
        return Ok(None);
    }
    if attachment_resource_cache::verified_blob(
        store,
        &proof.hash,
        proof.size,
        &proof.mime,
        Some(operation),
    )?
    .is_none()
    {
        return Ok(None);
    }
    Ok(Some(Candidate { proof }))
}

impl Candidate {
    pub(crate) fn tag(&self) -> &str {
        self.proof.etag.as_deref().unwrap()
    }
    pub(crate) fn accepts(&self, response: &Response, observation: &Observation) -> bool {
        response.status() == reqwest::StatusCode::NOT_MODIFIED
            && observation.target == self.proof.target
            && observation.etag.as_deref() == Some(self.tag())
            && response
                .headers()
                .get(header::CONTENT_LENGTH)
                .is_none_or(|v| {
                    v.to_str().ok().and_then(|s| s.parse::<u64>().ok()) == Some(self.proof.size)
                })
    }
    pub(crate) fn verified(
        &self,
        store: &BlobStore,
        operation: Option<&library_runtime::Operation>,
    ) -> Result<Option<DownloadedSource>, String> {
        attachment_resource_cache::verified_blob(
            store,
            &self.proof.hash,
            self.proof.size,
            &self.proof.mime,
            operation,
        )
    }
}

/// Called inside the same guarded source/Blob transaction as the byte binding.
pub(crate) fn bind_on(
    c: &Connection,
    job: &PipelineJob,
    downloaded: &DownloadedSource,
    observation: &Observation,
) -> Result<(), String> {
    let (provider, raw): (String, Option<String>) = c
        .query_row(
            "SELECT provider,metadata_json FROM source_items WHERE id=?1 AND space_id=?2",
            params![job.source_id, job.space_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| "无法核对附件 HTTP 证明所属来源".to_string())?;
    if provider != crate::PROVIDER_CRAFT {
        return Ok(());
    }
    let mut metadata: Value = serde_json::from_str(raw.as_deref().unwrap_or("{}"))
        .map_err(|_| "附件 HTTP 证明元数据无效".to_string())?;
    let generation = metadata
        .get("resourceGeneration")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    // URL-only discovery has no durable exact source identity for this proof.
    if metadata.get("discoveryVersion").and_then(Value::as_u64) == Some(2) {
        if let Some(block) = metadata.get("blockId").and_then(Value::as_str) {
            let proof = Proof {
                version: 1,
                library: job.space_id.clone(),
                source: job.source_id.clone(),
                block: block.into(),
                generation,
                revision: metadata
                    .get("resourceRevision")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                hash: downloaded.blob.hash.clone(),
                size: downloaded.blob.size,
                mime: downloaded.mime_type.clone(),
                target: observation.target.clone(),
                etag: observation.etag.clone(),
            };
            metadata["httpRepresentationProof"] =
                serde_json::to_value(proof).map_err(|_| "无法生成附件 HTTP 证明")?;
        }
    }
    metadata["lastRepresentationCheck"] = json!({"version":1,"kind":if observation.not_modified {"notModified"} else {"downloaded"},
        "generation":generation,"blobHash":downloaded.blob.hash,"size":downloaded.blob.size,
        "bodyBytes":observation.body_bytes,"blobReused":observation.blob_reused,"checkedAt":crate::now_timestamp()});
    c.execute(
        "UPDATE source_items SET metadata_json=?1 WHERE id=?2 AND space_id=?3",
        params![metadata.to_string(), job.source_id, job.space_id],
    )
    .map_err(|_| "无法提交附件 HTTP 证明".to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_bounded_strong_entity_tags_are_eligible() {
        for v in ["\"v1\"", "\"\""] {
            assert!(strong_tag(v));
        }
        for v in ["v1", "W/\"v1\"", "\"v\n1\"", "\"a\"b\"", "\"a b\""] {
            assert!(!strong_tag(v));
        }
        assert!(!strong_tag(&format!("\"{}\"", "x".repeat(512))));
    }
}
