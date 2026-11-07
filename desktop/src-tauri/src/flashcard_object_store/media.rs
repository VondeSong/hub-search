//! Streaming media transport uses the same OSS signature and immutable writes.
use super::*;
use crate::blob_store::BlobStore;
use std::path::Path;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct Identity {
    pub(crate) size: Option<u64>,
    pub(crate) sha256: Option<String>,
    pub(crate) etag: Option<String>,
}
impl Identity {
    pub(crate) fn matches(&self, hash: &str, size: u64) -> bool {
        self.size == Some(size) && self.sha256.as_deref() == Some(hash)
    }
    pub(crate) fn headers(headers: &reqwest::header::HeaderMap) -> Self {
        Self {
            size: headers
                .get(reqwest::header::CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse().ok()),
            sha256: headers
                .get("x-oss-meta-sha256")
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned),
            etag: headers
                .get(reqwest::header::ETAG)
                .and_then(|v| v.to_str().ok())
                .filter(|v| v.starts_with('"') && v.ends_with('"') && v.len() > 2)
                .map(str::to_owned),
        }
    }
    /// A fresh strong ETag and size bind the previously verified bytes to this version.
    pub(crate) fn same_version(&self, other: &Self) -> bool {
        self.size.is_some()
            && self.size == other.size
            && self.etag.is_some()
            && self.etag == other.etag
            && self.sha256 == other.sha256
    }
}

impl OssStore {
    pub(crate) async fn head_identity(&self, key: &str) -> Result<Option<Identity>, String> {
        let response = self
            .request(Method::HEAD, key, &[], false)?
            .send()
            .await
            .map_err(|_| "OSS 对象校验中断")?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(format!("OSS 对象查询失败：HTTP {}", response.status()));
        }
        Ok(Some(Identity::headers(response.headers())))
    }
    pub(crate) async fn verify_media_hash(
        &self,
        key: &str,
        hash: &str,
        size: u64,
    ) -> Result<bool, String> {
        Ok(self
            .verified_media_identity(key, hash, size)
            .await?
            .is_some())
    }
    pub(crate) async fn verified_media_identity(
        &self,
        key: &str,
        hash: &str,
        size: u64,
    ) -> Result<Option<Identity>, String> {
        crate::cloud_transfer_meter::mark();
        let mut response = self
            .request(Method::GET, key, &[], false)?
            .send()
            .await
            .map_err(|_| "OSS 下载中断；稍后可重试")?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(format!("OSS 下载失败：HTTP {}", response.status()));
        }
        if response.content_length().is_some_and(|n| n != size) {
            return Err("云端对象与内容身份不一致；已停止上传".into());
        }
        let mut identity = Identity::headers(response.headers());
        let mut digest = Sha256::new();
        let mut total = 0u64;
        while let Some(chunk) = response.chunk().await.map_err(|_| "云端对象下载中断")? {
            total = total
                .checked_add(chunk.len() as u64)
                .ok_or("附件长度溢出")?;
            crate::cloud_transfer_meter::downloaded(chunk.len());
            self.downloaded_bytes
                .fetch_add(chunk.len() as u64, std::sync::atomic::Ordering::Relaxed);
            if total > size {
                return Err("云端对象与内容身份不一致；已停止上传".into());
            }
            digest.update(&chunk);
        }
        if total != size || format!("{:x}", digest.finalize()) != hash {
            return Err("云端对象与内容身份不一致；已停止上传".into());
        }
        identity.size = Some(total);
        Ok(Some(identity))
    }
    pub(crate) async fn put_media_file(
        &self,
        key: &str,
        path: &Path,
        hash: &str,
        size: u64,
    ) -> Result<bool, String> {
        Ok(self
            .put_media_file_confirmed(key, path, hash, size)
            .await?
            .written())
    }
    pub(crate) async fn put_media_file_confirmed(
        &self,
        key: &str,
        path: &Path,
        hash: &str,
        size: u64,
    ) -> Result<WriteConfirmation, String> {
        crate::cloud_transfer_meter::mark();
        if size > crate::FLASHCARD_SYNC_MAX_MEDIA_BYTES {
            return Err("附件超过 250 MB 单文件限制".into());
        }
        if let Some(head) = self.head_identity(key).await? {
            if head.matches(hash, size) {
                return Ok(WriteConfirmation::ExistingMetadata(Some(head)));
            }
            if let Some(verified) = self.verified_media_identity(key, hash, size).await? {
                return Ok(WriteConfirmation::ExistingBytes(Some(verified)));
            }
        }
        let file = tokio::fs::File::open(path)
            .await
            .map_err(|e| e.to_string())?;
        if file.metadata().await.map_err(|e| e.to_string())?.len() != size {
            return Err("本地附件在传输前发生变化；记录已保留".into());
        }
        let counter = crate::cloud_transfer_meter::upload_counter();
        let stream = futures::stream::try_unfold((file, 0u64), move |(mut file, total)| {
            let counter = counter.clone();
            async move {
                let mut chunk = vec![0u8; 64 * 1024];
                let n = file.read(&mut chunk).await?;
                if n == 0 {
                    if total != size {
                        return Err(std::io::Error::other("local media changed"));
                    }
                    return Ok(None);
                }
                let next = total
                    .checked_add(n as u64)
                    .ok_or_else(|| std::io::Error::other("media size overflow"))?;
                if next > size {
                    return Err(std::io::Error::other("local media changed"));
                }
                chunk.truncate(n);
                counter(n)?;
                Ok(Some((chunk, (file, next))))
            }
        });
        let mut url = self.base.clone();
        url.set_path(key);
        let timestamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
        let headers = BTreeMap::from([
            ("x-oss-content-sha256".into(), "UNSIGNED-PAYLOAD".into()),
            ("x-oss-date".into(), timestamp.clone()),
            ("x-oss-forbid-overwrite".into(), "true".into()),
            ("x-oss-meta-sha256".into(), hash.to_owned()),
        ]);
        let auth = authorization(
            &self.config,
            &self.secret,
            "PUT",
            key,
            &[],
            &headers,
            &timestamp,
        );
        let mut request = self.client.put(url).header("Authorization", auth);
        for (k, v) in headers {
            request = request.header(k, v);
        }
        self.check_network(key)?;
        let response = request
            .header(reqwest::header::CONTENT_LENGTH, size)
            .body(reqwest::Body::wrap_stream(stream))
            .send()
            .await;
        let acceptable = response
            .as_ref()
            .is_ok_and(|r| r.status().is_success() || r.status() == StatusCode::CONFLICT);
        match self.verified_media_identity(key, hash, size).await {
            Ok(Some(identity)) => {
                self.uploaded_bytes
                    .fetch_add(size, std::sync::atomic::Ordering::Relaxed);
                Ok(WriteConfirmation::Written(Some(identity)))
            }
            _ if !acceptable => Err("OSS 上传未确认；记录已保留，恢复联网后可重试".into()),
            _ => Err("OSS 上传读回校验失败".into()),
        }
    }
    pub(crate) async fn get_media_blob(
        &self,
        key: &str,
        hash: &str,
        blobs: &BlobStore,
    ) -> Result<Option<u64>, String> {
        crate::cloud_transfer_meter::mark();
        let mut response = self
            .request(Method::GET, key, &[], false)?
            .send()
            .await
            .map_err(|_| "OSS 下载中断；稍后可重试")?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(format!("OSS 下载失败：HTTP {}", response.status()));
        }
        if response
            .content_length()
            .is_some_and(|n| n > crate::FLASHCARD_SYNC_MAX_MEDIA_BYTES)
        {
            return Err("附件超过 250 MB 单文件限制".into());
        }
        let staged = blobs.staging_path()?;
        let result = async {
            let mut file = tokio::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&staged)
                .await
                .map_err(|e| e.to_string())?;
            let mut digest = Sha256::new();
            let mut total = 0u64;
            while let Some(chunk) = response.chunk().await.map_err(|_| "云端对象下载中断")?
            {
                total = total
                    .checked_add(chunk.len() as u64)
                    .ok_or("附件长度溢出")?;
                crate::cloud_transfer_meter::downloaded(chunk.len());
                self.downloaded_bytes
                    .fetch_add(chunk.len() as u64, std::sync::atomic::Ordering::Relaxed);
                if total > crate::FLASHCARD_SYNC_MAX_MEDIA_BYTES {
                    return Err("附件超过 250 MB 单文件限制".into());
                }
                digest.update(&chunk);
                file.write_all(&chunk).await.map_err(|e| e.to_string())?;
            }
            if format!("{:x}", digest.finalize()) != hash {
                return Err("云端附件哈希不符；没有导入损坏附件".into());
            }
            file.sync_all().await.map_err(|e| e.to_string())?;
            drop(file);
            blobs.commit_staged(&staged, hash, total)?;
            Ok(Some(total))
        }
        .await;
        if result.is_err() {
            let _ = tokio::fs::remove_file(&staged).await;
        }
        result
    }
}
