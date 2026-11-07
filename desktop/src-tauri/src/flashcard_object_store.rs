//! Private OSS transport. No shared-object compare-and-swap is assumed.
use hmac::{Hmac, Mac};
use reqwest::{Client, Method, StatusCode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use url::Url;
mod media;
pub(crate) use media::Identity;

pub(crate) struct ObjectBytes {
    pub bytes: Vec<u8>,
    pub identity: Option<Identity>,
}

/// Distinguishes a byte-level confirmation from an identity asserted by HEAD.
pub(crate) enum WriteConfirmation {
    Written(Option<Identity>),
    ExistingBytes(Option<Identity>),
    ExistingMetadata(Option<Identity>),
}
impl WriteConfirmation {
    pub(crate) fn written(&self) -> bool {
        matches!(self, Self::Written(_))
    }
    pub(crate) fn identity(&self) -> Option<&Identity> {
        match self {
            Self::Written(v) | Self::ExistingBytes(v) | Self::ExistingMetadata(v) => v.as_ref(),
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OssConfig {
    pub bucket: String,
    pub region: String,
    pub prefix: String,
    pub access_key_id: String,
}

impl OssConfig {
    pub fn normalized(mut self) -> Result<Self, String> {
        self.bucket = self.bucket.trim().into();
        self.region = self.region.trim().into();
        self.prefix = self.prefix.trim().trim_matches('/').into();
        self.access_key_id = self.access_key_id.trim().into();
        let valid = |s: &str| {
            !s.is_empty()
                && s.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        };
        if !valid(&self.bucket)
            || !(3..=63).contains(&self.bucket.len())
            || !valid(&self.region)
            || self.bucket.starts_with('-')
            || self.bucket.ends_with('-')
        {
            return Err("请输入有效的 Bucket 名称和地域（如 cn-hangzhou）".into());
        }
        if self.prefix.is_empty() {
            self.prefix = "HubFlashcards".into();
        }
        if self.prefix.len() > 180
            || self
                .prefix
                .split('/')
                .any(|s| s.is_empty() || matches!(s, "." | ".."))
            || !self
                .prefix
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'/'))
        {
            return Err("同步目录只能包含英文字母、数字、横线、下划线和斜杠".into());
        }
        if self.access_key_id.is_empty()
            || !self
                .access_key_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric())
        {
            return Err("请输入有效的 AccessKey ID".into());
        }
        Ok(self)
    }
    pub fn namespace(&self) -> String {
        format!("oss://{}/{}/{}", self.region, self.bucket, self.prefix)
    }
}

fn encode(value: &str, slash: bool) -> String {
    let mut output = String::new();
    for b in value.bytes() {
        if b.is_ascii_alphanumeric()
            || matches!(b, b'-' | b'_' | b'.' | b'~')
            || (slash && b == b'/')
        {
            output.push(b as char);
        } else {
            output.push_str(&format!("%{b:02X}"));
        }
    }
    output
}

fn mac(key: &[u8], value: &str) -> Vec<u8> {
    let mut h = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC accepts arbitrary keys");
    h.update(value.as_bytes());
    h.finalize().into_bytes().to_vec()
}

fn authorization(
    config: &OssConfig,
    secret: &str,
    method: &str,
    key: &str,
    query: &[(String, String)],
    headers: &BTreeMap<String, String>,
    timestamp: &str,
) -> String {
    let mut query: Vec<_> = query
        .iter()
        .map(|(k, v)| (encode(k, false), encode(v, false)))
        .collect();
    query.sort();
    let canonical_query = query
        .into_iter()
        .map(|(k, v)| if v.is_empty() { k } else { format!("{k}={v}") })
        .collect::<Vec<_>>()
        .join("&");
    let canonical_headers = headers
        .iter()
        .map(|(k, v)| format!("{k}:{}\n", v.trim()))
        .collect::<String>();
    let canonical = format!(
        "{method}\n/{}\n{canonical_query}\n{canonical_headers}\n\nUNSIGNED-PAYLOAD",
        encode(&format!("{}/{}", config.bucket, key), true)
    );
    let date = &timestamp[..8];
    let scope = format!("{date}/{}/oss/aliyun_v4_request", config.region);
    let string_to_sign = format!(
        "OSS4-HMAC-SHA256\n{timestamp}\n{scope}\n{:x}",
        Sha256::digest(canonical.as_bytes())
    );
    let mut signing_key = mac(format!("aliyun_v4{secret}").as_bytes(), date);
    for part in [&config.region, "oss", "aliyun_v4_request"] {
        signing_key = mac(&signing_key, part);
    }
    let signature = mac(&signing_key, &string_to_sign)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    format!(
        "OSS4-HMAC-SHA256 Credential={}/{scope}, Signature={signature}",
        config.access_key_id
    )
}

pub(crate) struct OssStore {
    config: OssConfig,
    secret: String,
    client: Client,
    base: Url,
    uploaded_bytes: std::sync::atomic::AtomicU64,
    downloaded_bytes: std::sync::atomic::AtomicU64,
    network_guard: Option<(
        String,
        std::sync::Arc<dyn Fn() -> Result<(), String> + Send + Sync>,
    )>,
}

/// A single provider page. Durable consumers own token witnesses and inventory.
pub(crate) struct ObjectPage {
    pub(crate) keys: Vec<String>,
    pub(crate) next: Option<String>,
}

impl OssStore {
    pub fn new(config: OssConfig, secret: String) -> Result<Self, String> {
        let config = config.normalized()?;
        if secret.is_empty() {
            return Err("尚未安全保存 OSS AccessKey Secret".into());
        }
        let base = Url::parse(&format!(
            "https://{}.oss-{}.aliyuncs.com/",
            config.bucket, config.region
        ))
        .map_err(|_| "OSS 地址无效")?;
        // Never forward authorization through a redirect or expose signed request URLs in errors.
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(180))
            .build()
            .map_err(|_| "无法创建 OSS 客户端")?;
        Ok(Self {
            config,
            secret,
            client,
            base,
            uploaded_bytes: 0.into(),
            downloaded_bytes: 0.into(),
            network_guard: None,
        })
    }
    fn request(
        &self,
        method: Method,
        key: &str,
        query: &[(String, String)],
        immutable: bool,
    ) -> Result<reqwest::RequestBuilder, String> {
        self.check_network(key)?;
        for (name, value) in query {
            if name == "prefix" {
                self.check_network(value)?;
            }
        }
        let mut url = self.base.clone();
        url.set_path(key);
        if !query.is_empty() {
            url.query_pairs_mut()
                .extend_pairs(query.iter().map(|(k, v)| (k.as_str(), v.as_str())));
        }
        let timestamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
        let mut headers = BTreeMap::from([
            ("x-oss-content-sha256".into(), "UNSIGNED-PAYLOAD".into()),
            ("x-oss-date".into(), timestamp.clone()),
        ]);
        if immutable {
            headers.insert("x-oss-forbid-overwrite".into(), "true".into());
        }
        let auth = authorization(
            &self.config,
            &self.secret,
            method.as_str(),
            key,
            query,
            &headers,
            &timestamp,
        );
        let mut request = self
            .client
            .request(method, url)
            .header("Authorization", auth);
        for (k, v) in headers {
            request = request.header(k, v);
        }
        Ok(request)
    }
    pub fn key(&self, relative: &str) -> String {
        format!("{}/v2/{relative}", self.config.prefix)
    }
    pub(crate) fn with_network_guard(
        mut self,
        prefix: String,
        guard: std::sync::Arc<dyn Fn() -> Result<(), String> + Send + Sync>,
    ) -> Self {
        self.network_guard = Some((prefix, guard));
        self
    }
    pub(crate) fn check_network(&self, key: &str) -> Result<(), String> {
        if let Some((prefix, guard)) = &self.network_guard {
            if key.starts_with(prefix) {
                guard()?;
            }
        }
        Ok(())
    }
    pub fn transferred(&self) -> (u64, u64) {
        use std::sync::atomic::Ordering::Relaxed;
        (
            self.uploaded_bytes.load(Relaxed),
            self.downloaded_bytes.load(Relaxed),
        )
    }
    /// Explicit maintenance only. A concrete object is required; normal sync never calls this.
    pub(crate) async fn delete_exact(&self, key: &str) -> Result<(), String> {
        let root = self.key("");
        let relative = key.strip_prefix(&root).ok_or("清理对象不属于当前云空间")?;
        if relative.is_empty()
            || relative.ends_with('/')
            || relative.split('/').any(|v| {
                v.is_empty()
                    || matches!(v, "." | "..")
                    || !v
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
            })
        {
            return Err("只允许清理同步目录中的精确对象".into());
        }
        let response = self
            .request(Method::DELETE, key, &[], false)?
            .send()
            .await
            .map_err(|_| "OSS 精确清理中断")?;
        if !response.status().is_success() && response.status() != StatusCode::NOT_FOUND {
            return Err(format!("OSS 精确清理失败：HTTP {}", response.status()));
        }
        if self.get(key, 0).await?.is_some() {
            return Err("OSS 对象清理尚未确认".into());
        }
        Ok(())
    }
    pub(crate) async fn head_size(&self, key: &str) -> Result<Option<u64>, String> {
        let response = self
            .request(Method::HEAD, key, &[], false)?
            .send()
            .await
            .map_err(|_| "OSS 对象大小读取中断")?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(format!("OSS 对象大小读取失败：HTTP {}", response.status()));
        }
        Ok(Some(
            response
                .headers()
                .get(reqwest::header::CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
                .ok_or("OSS 未返回可确认的对象大小")?,
        ))
    }
    #[cfg(test)]
    pub(crate) fn with_test_endpoint(mut self, base: Url) -> Self {
        assert_eq!(base.host_str(), Some("127.0.0.1"));
        // Loopback fixtures must not depend on the workstation's external proxy.
        self.client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(180))
            .build()
            .expect("local OSS test client");
        self.base = base;
        self
    }
    pub async fn get(&self, key: &str, max: usize) -> Result<Option<Vec<u8>>, String> {
        Ok(self.get_with_identity(key, max).await?.map(|v| v.bytes))
    }
    pub(crate) async fn get_with_identity(
        &self,
        key: &str,
        max: usize,
    ) -> Result<Option<ObjectBytes>, String> {
        crate::cloud_transfer_meter::mark();
        let response = self
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
        let identity = Identity::headers(response.headers());
        let bytes = bounded_body(response, max).await?;
        self.downloaded_bytes
            .fetch_add(bytes.len() as u64, std::sync::atomic::Ordering::Relaxed);
        Ok(Some(ObjectBytes {
            bytes,
            identity: Some(identity),
        }))
    }
    pub async fn put_verified(&self, key: &str, bytes: &[u8]) -> Result<bool, String> {
        Ok(self.put_confirmed(key, bytes).await?.written())
    }
    pub(crate) async fn put_confirmed(
        &self,
        key: &str,
        bytes: &[u8],
    ) -> Result<WriteConfirmation, String> {
        crate::cloud_transfer_meter::mark();
        let expected = format!("{:x}", Sha256::digest(bytes));
        let head = self
            .request(Method::HEAD, key, &[], false)?
            .send()
            .await
            .map_err(|_| "OSS 对象校验中断")?;
        if head.status().is_success()
            && head
                .headers()
                .get("x-oss-meta-sha256")
                .and_then(|v| v.to_str().ok())
                == Some(expected.as_str())
            // HEAD has an empty body; the header describes the stored object's length.
            && head
                .headers()
                .get(reqwest::header::CONTENT_LENGTH)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok())
                == Some(bytes.len() as u64)
        {
            return Ok(WriteConfirmation::ExistingMetadata(Some(
                Identity::headers(head.headers()),
            )));
        }
        if !head.status().is_success() && head.status() != StatusCode::NOT_FOUND {
            return Err(format!("OSS 对象查询失败：HTTP {}", head.status()));
        }
        if let Some(existing) = self
            .get_with_identity(key, bytes.len().saturating_add(1))
            .await?
        {
            if existing.bytes == bytes {
                return Ok(WriteConfirmation::ExistingBytes(existing.identity));
            }
            return Err("云端对象与内容身份不一致；已停止上传".into());
        }
        // The metadata participates in the signature along with forbid-overwrite.
        let mut url = self.base.clone();
        url.set_path(key);
        let timestamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
        let headers = BTreeMap::from([
            ("x-oss-content-sha256".into(), "UNSIGNED-PAYLOAD".into()),
            ("x-oss-date".into(), timestamp.clone()),
            ("x-oss-forbid-overwrite".into(), "true".into()),
            ("x-oss-meta-sha256".into(), expected),
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
        // Uploads use a separate signed builder; the network may have changed after HEAD/GET.
        self.check_network(key)?;
        let result = request
            .header(reqwest::header::CONTENT_LENGTH, bytes.len())
            .body(crate::cloud_transfer_meter::body(bytes))
            .send()
            .await;
        let acceptable = result
            .as_ref()
            .is_ok_and(|r| r.status().is_success() || r.status() == StatusCode::CONFLICT);
        // A lost acknowledgement may follow a successful PUT. Read authoritative bytes before retry.
        match self
            .get_with_identity(key, bytes.len().saturating_add(1))
            .await?
        {
            Some(existing) if existing.bytes == bytes => {
                self.uploaded_bytes
                    .fetch_add(bytes.len() as u64, std::sync::atomic::Ordering::Relaxed);
                Ok(WriteConfirmation::Written(existing.identity))
            }
            _ if !acceptable => Err("OSS 上传未确认；记录已保留，恢复联网后可重试".into()),
            _ => Err("OSS 上传读回校验失败".into()),
        }
    }
    pub(crate) async fn list_page(
        &self,
        relative: &str,
        continuation: Option<&str>,
    ) -> Result<ObjectPage, String> {
        let prefix = self.key(relative);
        let mut query = vec![
            ("list-type".into(), "2".into()),
            ("prefix".into(), prefix.clone()),
            ("max-keys".into(), "1000".into()),
        ];
        if let Some(token) = continuation.filter(|v| !v.is_empty()) {
            query.push(("continuation-token".into(), token.to_string()));
        }
        let response = self
            .request(Method::GET, "", &query, false)?
            .send()
            .await
            .map_err(|_| "OSS 对象列表读取中断")?;
        if !response.status().is_success() {
            return Err(format!("OSS 列表读取失败：HTTP {}", response.status()));
        }
        let body = bounded_body(response, 8 * 1024 * 1024).await?;
        self.downloaded_bytes
            .fetch_add(body.len() as u64, std::sync::atomic::Ordering::Relaxed);
        let page = parse_page(&body)?;
        if page.keys.iter().any(|key| !key.starts_with(&prefix)) {
            return Err("OSS 返回了同步目录之外的对象".into());
        }
        if page.truncated && page.token.is_empty() {
            return Err("OSS 分页游标无效；未跳过未读取的记录".into());
        }
        Ok(ObjectPage {
            keys: page.keys,
            next: page.truncated.then_some(page.token),
        })
    }
    /// Legacy differential fixtures retain the aggregate API; production uses SQL page sinks.
    #[cfg(test)]
    pub async fn list(&self, relative: &str) -> Result<Vec<String>, String> {
        let mut token = String::new();
        let mut output = Vec::new();
        let mut tokens = std::collections::HashSet::new();
        loop {
            let page = self
                .list_page(relative, (!token.is_empty()).then_some(token.as_str()))
                .await?;
            output.extend(page.keys);
            if output.len() > 200_000 {
                return Err("同步变更记录超过本阶段上限，请联系维护者归并历史".into());
            }
            let Some(next) = page.next else {
                break;
            };
            if !tokens.insert(next.clone()) {
                return Err("OSS 分页游标无效；未跳过未读取的记录".into());
            }
            token = next;
        }
        output.sort();
        output.dedup();
        Ok(output)
    }
}

async fn bounded_body(mut response: reqwest::Response, max: usize) -> Result<Vec<u8>, String> {
    if response.content_length().is_some_and(|n| n > max as u64) {
        return Err("云端对象超过安全大小限制".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "云端对象下载中断")? {
        crate::cloud_transfer_meter::downloaded(chunk.len());
        if bytes.len().saturating_add(chunk.len()) > max {
            return Err("云端对象超过安全大小限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

struct Page {
    keys: Vec<String>,
    truncated: bool,
    token: String,
}
fn parse_page(bytes: &[u8]) -> Result<Page, String> {
    use quick_xml::events::Event;
    let mut reader = quick_xml::Reader::from_reader(bytes);
    let mut page = Page {
        keys: vec![],
        truncated: false,
        token: String::new(),
    };
    let mut root = false;
    let mut seen_truncated = false;
    loop {
        match reader.read_event().map_err(|_| "OSS 返回的列表格式无效")? {
            Event::Start(e) if e.name().as_ref() == b"ListBucketResult" => root = true,
            Event::Start(e)
                if matches!(
                    e.name().as_ref(),
                    b"Key" | b"IsTruncated" | b"NextContinuationToken"
                ) =>
            {
                let name = e.name();
                let value = reader.read_text(name).map_err(|_| "OSS 列表字段无效")?;
                let value = value.decode().map_err(|_| "OSS 列表编码无效")?;
                let value = quick_xml::escape::unescape(&value)
                    .map_err(|_| "OSS 列表转义无效")?
                    .into_owned();
                match name.as_ref() {
                    b"Key" => page.keys.push(value),
                    b"NextContinuationToken" => page.token = value,
                    _ => {
                        if !matches!(value.as_str(), "true" | "false") {
                            return Err("OSS 分页状态无效".into());
                        }
                        page.truncated = value == "true";
                        seen_truncated = true;
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if !root || !seen_truncated {
        return Err("OSS 列表缺少必需分页状态".into());
    }
    Ok(page)
}

#[cfg(test)]
#[path = "flashcard_object_store_http_tests.rs"]
mod http_tests;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn oss_v4_matches_aliyun_official_sdk_fixed_vector() {
        // Public synthetic credentials/vector from aliyun's Python SDK TestSignerV4.test_auth_header.
        // https://github.com/aliyun/alibabacloud-oss-python-sdk-v2/blob/master/tests/unit/signer/test_v4.py
        let c = OssConfig {
            bucket: "bucket".into(),
            region: "cn-hangzhou".into(),
            prefix: "HubFlashcards".into(),
            access_key_id: "ak".into(),
        };
        let headers = BTreeMap::from([
            ("content-type".into(), "text/plain".into()),
            ("x-oss-head1".into(), "value".into()),
            ("x-oss-content-sha256".into(), "UNSIGNED-PAYLOAD".into()),
            ("x-oss-date".into(), "20231216T162057Z".into()),
        ]);
        let query = vec![
            ("param1".into(), "value1".into()),
            ("+param1".into(), "value3".into()),
            ("|param1".into(), "value4".into()),
            ("+param2".into(), "".into()),
            ("|param2".into(), "".into()),
            ("param2".into(), "".into()),
        ];
        assert!(authorization(
            &c,
            "sk",
            "PUT",
            "1234+-/123/1.txt",
            &query,
            &headers,
            "20231216T162057Z"
        )
        .ends_with("Signature=e21d18daa82167720f9b1047ae7e7f1ce7cb77a31e8203a7d5f4624fa0284afe"));
    }
    #[test]
    fn oss_listing_preserves_escaped_keys_and_rejects_missing_pagination() {
        let page=parse_page(b"<ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>a&amp;b</Key></Contents><NextContinuationToken>x&amp;y</NextContinuationToken></ListBucketResult>").unwrap();
        assert_eq!(page.keys, vec!["a&b"]);
        assert!(page.truncated);
        assert_eq!(page.token, "x&y");
        assert!(parse_page(b"<ListBucketResult/>").is_err());
        assert!(parse_page(
            b"<ListBucketResult><IsTruncated>maybe</IsTruncated></ListBucketResult>"
        )
        .is_err());
    }
    #[test]
    fn oss_canonical_encoding_and_namespace_are_unambiguous() {
        assert_eq!(encode("中 文/+", false), "%E4%B8%AD%20%E6%96%87%2F%2B");
        assert_eq!(encode("a/b", true), "a/b");
        let c = OssConfig {
            bucket: "my-bucket".into(),
            region: "cn-hangzhou".into(),
            prefix: "../private".into(),
            access_key_id: "EXAMPLE".into(),
        };
        assert!(c.clone().normalized().is_err());
        let mut c = c;
        c.prefix = "HubFlashcards".into();
        assert_eq!(
            c.normalized().unwrap().namespace(),
            "oss://cn-hangzhou/my-bucket/HubFlashcards"
        );
    }
}
