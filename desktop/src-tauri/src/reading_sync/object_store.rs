//! One content-addressed reading transport contract for OSS and WebDAV.
use super::*;
use crate::flashcard_object_store::{
    Identity, ObjectBytes, OssConfig, OssStore, WriteConfirmation,
};
use futures::future::BoxFuture;
use reqwest::{Client, Method, StatusCode};
use url::Url;

#[derive(Clone, Debug, Default)]
pub(crate) struct InventoryPage {
    pub keys: Vec<String>,
    /// Logical relative child directories, independent of a provider's base prefix.
    pub directories: Vec<String>,
    pub next: Option<String>,
}

pub(crate) trait Store: Send + Sync {
    fn key(&self, relative: &str) -> String;
    fn check_network(&self, key: &str) -> Result<(), String>;
    fn head_size<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<Option<u64>, String>>;
    fn get<'a>(
        &'a self,
        key: &'a str,
        max: usize,
    ) -> BoxFuture<'a, Result<Option<Vec<u8>>, String>>;
    fn inventory_page<'a>(
        &'a self,
        relative: &'a str,
        continuation: Option<&'a str>,
    ) -> BoxFuture<'a, Result<InventoryPage, String>>;
    #[cfg(test)]
    fn list<'a>(&'a self, relative: &'a str) -> BoxFuture<'a, Result<Vec<String>, String>>;
    fn put_verified<'a>(
        &'a self,
        key: &'a str,
        bytes: &'a [u8],
    ) -> BoxFuture<'a, Result<bool, String>>;
    fn head_identity<'a>(
        &'a self,
        _key: &'a str,
    ) -> BoxFuture<'a, Result<Option<Identity>, String>> {
        Box::pin(async { Ok(None) })
    }
    fn get_with_identity<'a>(
        &'a self,
        key: &'a str,
        max: usize,
    ) -> BoxFuture<'a, Result<Option<ObjectBytes>, String>> {
        Box::pin(async move {
            Ok(self.get(key, max).await?.map(|bytes| ObjectBytes {
                bytes,
                identity: None,
            }))
        })
    }
    fn put_confirmed<'a>(
        &'a self,
        key: &'a str,
        bytes: &'a [u8],
    ) -> BoxFuture<'a, Result<WriteConfirmation, String>> {
        Box::pin(async move {
            Ok(if self.put_verified(key, bytes).await? {
                WriteConfirmation::Written(None)
            } else {
                WriteConfirmation::ExistingMetadata(None)
            })
        })
    }
    fn delete_exact<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<(), String>>;
}
impl<T: Store + ?Sized> Store for Box<T> {
    fn head_identity<'a>(
        &'a self,
        key: &'a str,
    ) -> BoxFuture<'a, Result<Option<Identity>, String>> {
        (**self).head_identity(key)
    }
    fn get_with_identity<'a>(
        &'a self,
        key: &'a str,
        max: usize,
    ) -> BoxFuture<'a, Result<Option<ObjectBytes>, String>> {
        (**self).get_with_identity(key, max)
    }
    fn put_confirmed<'a>(
        &'a self,
        key: &'a str,
        bytes: &'a [u8],
    ) -> BoxFuture<'a, Result<WriteConfirmation, String>> {
        (**self).put_confirmed(key, bytes)
    }
    fn key(&self, relative: &str) -> String {
        (**self).key(relative)
    }
    fn check_network(&self, key: &str) -> Result<(), String> {
        (**self).check_network(key)
    }
    fn head_size<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<Option<u64>, String>> {
        (**self).head_size(key)
    }
    fn get<'a>(
        &'a self,
        key: &'a str,
        max: usize,
    ) -> BoxFuture<'a, Result<Option<Vec<u8>>, String>> {
        (**self).get(key, max)
    }
    #[cfg(test)]
    fn list<'a>(&'a self, relative: &'a str) -> BoxFuture<'a, Result<Vec<String>, String>> {
        (**self).list(relative)
    }
    fn inventory_page<'a>(
        &'a self,
        relative: &'a str,
        continuation: Option<&'a str>,
    ) -> BoxFuture<'a, Result<InventoryPage, String>> {
        (**self).inventory_page(relative, continuation)
    }
    fn put_verified<'a>(
        &'a self,
        key: &'a str,
        bytes: &'a [u8],
    ) -> BoxFuture<'a, Result<bool, String>> {
        (**self).put_verified(key, bytes)
    }
    fn delete_exact<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<(), String>> {
        (**self).delete_exact(key)
    }
}
impl Store for OssStore {
    fn head_identity<'a>(
        &'a self,
        key: &'a str,
    ) -> BoxFuture<'a, Result<Option<Identity>, String>> {
        Box::pin(OssStore::head_identity(self, key))
    }
    fn get_with_identity<'a>(
        &'a self,
        key: &'a str,
        max: usize,
    ) -> BoxFuture<'a, Result<Option<ObjectBytes>, String>> {
        Box::pin(OssStore::get_with_identity(self, key, max))
    }
    fn put_confirmed<'a>(
        &'a self,
        key: &'a str,
        bytes: &'a [u8],
    ) -> BoxFuture<'a, Result<WriteConfirmation, String>> {
        Box::pin(OssStore::put_confirmed(self, key, bytes))
    }
    fn key(&self, relative: &str) -> String {
        OssStore::key(self, relative)
    }
    fn check_network(&self, key: &str) -> Result<(), String> {
        OssStore::check_network(self, key)
    }
    fn head_size<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<Option<u64>, String>> {
        Box::pin(OssStore::head_size(self, key))
    }
    fn get<'a>(
        &'a self,
        key: &'a str,
        max: usize,
    ) -> BoxFuture<'a, Result<Option<Vec<u8>>, String>> {
        Box::pin(OssStore::get(self, key, max))
    }
    #[cfg(test)]
    fn list<'a>(&'a self, relative: &'a str) -> BoxFuture<'a, Result<Vec<String>, String>> {
        Box::pin(OssStore::list(self, relative))
    }
    fn inventory_page<'a>(
        &'a self,
        relative: &'a str,
        continuation: Option<&'a str>,
    ) -> BoxFuture<'a, Result<InventoryPage, String>> {
        Box::pin(async move {
            let page = OssStore::list_page(self, relative, continuation).await?;
            Ok(InventoryPage {
                keys: page.keys,
                directories: Vec::new(),
                next: page.next,
            })
        })
    }
    fn put_verified<'a>(
        &'a self,
        key: &'a str,
        bytes: &'a [u8],
    ) -> BoxFuture<'a, Result<bool, String>> {
        Box::pin(OssStore::put_verified(self, key, bytes))
    }
    fn delete_exact<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(OssStore::delete_exact(self, key))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "provider", rename_all = "camelCase")]
pub(crate) enum Configuration {
    Oss { config: OssConfig },
    Webdav { url: String, username: String },
}
impl Configuration {
    pub(crate) fn namespace(&self) -> String {
        match self {
            Self::Oss { config } => config.namespace(),
            Self::Webdav { url, username } => format!(
                "webdav:{}",
                hash(&serde_json::to_vec(&(url, username)).unwrap_or_default())
            ),
        }
    }
}
pub(crate) fn configuration_for(c: &Connection, provider: &str) -> Result<Configuration, String> {
    match provider {
        "oss" => Ok(Configuration::Oss {
            config: flashcard_cloud_sync::config(c)?.normalized()?,
        }),
        "webdav" => {
            let url = normalize_flashcard_webdav_url(&metadata_string(c, "flashcard_webdav_url"))?;
            if url.is_empty() {
                return Err("尚未配置 WebDAV 同步目录".into());
            }
            let parsed = Url::parse(&url).map_err(|_| "WebDAV 地址无效")?;
            if !parsed.username().is_empty() || parsed.password().is_some() {
                return Err("WebDAV 地址不能包含账号密码，请使用独立账号字段".into());
            }
            Ok(Configuration::Webdav {
                url,
                username: metadata_string(c, "flashcard_webdav_username"),
            })
        }
        _ => Err("不支持的同步服务".into()),
    }
}
pub(crate) fn configuration(c: &Connection) -> Result<Configuration, String> {
    configuration_for(c, &flashcard_cloud_sync::provider(c))
}
pub(crate) fn namespace(c: &Connection) -> Result<String, String> {
    Ok(configuration(c)?.namespace())
}
pub(crate) fn store(app: &AppHandle, c: &Connection) -> Result<Box<dyn Store>, String> {
    configured_store(app, c, &configuration(c)?, None)
}
pub(crate) fn configured_store(
    app: &AppHandle,
    c: &Connection,
    config: &Configuration,
    secret: Option<String>,
) -> Result<Box<dyn Store>, String> {
    let mode = crate::cloud_network::policy(c)?;
    let network_guard = crate::cloud_network::guard(app.clone(), mode);
    let guard: Guard = Arc::new(move || network_guard().map_err(super::media::admission_wait));
    match config {
        Configuration::Oss { config } => {
            let secret = match secret {
                Some(s) => s,
                None => stored_secret_get(app, "hub-flashcard-oss-secret-v1")?.unwrap_or_default(),
            };
            let remote = OssStore::new(config.clone(), secret)?;
            let prefix = remote.key("reading/");
            Ok(Box::new(remote.with_network_guard(prefix, guard)))
        }
        Configuration::Webdav { url, username } => {
            let password = match secret {
                Some(s) => s,
                None => stored_secret_get(app, FLASHCARD_WEBDAV_CREDENTIAL_ID)?.unwrap_or_default(),
            };
            Ok(Box::new(
                WebdavStore::new(url, username.clone(), password)?.with_network_guard(guard),
            ))
        }
    }
}
type Guard = Arc<dyn Fn() -> Result<(), String> + Send + Sync>;
pub(crate) struct WebdavStore {
    base: Url,
    username: String,
    password: String,
    client: Client,
    guard: Option<Guard>,
}
impl WebdavStore {
    pub(crate) fn new(url: &str, username: String, password: String) -> Result<Self, String> {
        let normalized = normalize_flashcard_webdav_url(url)?;
        if normalized.is_empty() {
            return Err("尚未配置 WebDAV 同步目录".into());
        }
        let base = Url::parse(&normalized).map_err(|_| "WebDAV 地址无效")?;
        if !base.username().is_empty() || base.password().is_some() {
            return Err("WebDAV 地址不能包含账号密码".into());
        }
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(180))
            .build()
            .map_err(|_| "无法创建 WebDAV 客户端")?;
        Ok(Self {
            base,
            username,
            password,
            client,
            guard: None,
        })
    }
    pub(crate) fn with_network_guard(mut self, guard: Guard) -> Self {
        self.guard = Some(guard);
        self
    }
    fn request(&self, method: Method, key: &str) -> Result<reqwest::RequestBuilder, String> {
        validate_key(key, true)?;
        self.check_network(key)?;
        let url = self.base.join(key).map_err(|_| "WebDAV 对象地址无效")?;
        Ok(webdav_request(
            &self.client,
            method,
            url,
            &self.username,
            &self.password,
        ))
    }
    async fn directories(&self, key: &str) -> Result<(), String> {
        self.check_network(key)?;
        let response = webdav_request(
            &self.client,
            Method::from_bytes(b"MKCOL").map_err(|_| "WebDAV 方法无效")?,
            self.base.clone(),
            &self.username,
            &self.password,
        )
        .send()
        .await
        .map_err(|_| "WebDAV 同步目录准备中断")?;
        if !response.status().is_success() && response.status() != StatusCode::METHOD_NOT_ALLOWED {
            return Err(format!(
                "WebDAV 同步目录准备失败：HTTP {}",
                response.status()
            ));
        }
        let parts: Vec<_> = key.trim_end_matches('/').split('/').collect();
        for end in 1..parts.len() {
            self.check_network(key)?;
            let directory = format!("{}/", parts[..end].join("/"));
            let response = self
                .request(
                    Method::from_bytes(b"MKCOL").map_err(|_| "WebDAV 方法无效")?,
                    &directory,
                )?
                .send()
                .await
                .map_err(|_| "WebDAV 目录准备中断")?;
            if !response.status().is_success()
                && response.status() != StatusCode::METHOD_NOT_ALLOWED
            {
                return Err(format!("WebDAV 目录准备失败：HTTP {}", response.status()));
            }
        }
        Ok(())
    }
    async fn read(&self, key: &str, max: usize) -> Result<Option<Vec<u8>>, String> {
        Ok(self.read_with_identity(key, max).await?.map(|v| v.bytes))
    }
    async fn read_with_identity(
        &self,
        key: &str,
        max: usize,
    ) -> Result<Option<ObjectBytes>, String> {
        crate::cloud_transfer_meter::mark();
        let response = self
            .request(Method::GET, key)?
            .send()
            .await
            .map_err(|_| "WebDAV 下载中断，请重试")?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(format!("WebDAV 下载失败：HTTP {}", response.status()));
        }
        let identity = Identity::headers(response.headers());
        Ok(Some(ObjectBytes {
            bytes: bounded(response, max).await?,
            identity: Some(identity),
        }))
    }
    async fn put(&self, key: &str, bytes: &[u8]) -> Result<bool, String> {
        Ok(self.confirm(key, bytes).await?.written())
    }
    async fn confirm(&self, key: &str, bytes: &[u8]) -> Result<WriteConfirmation, String> {
        crate::cloud_transfer_meter::mark();
        validate_key(key, false)?;
        if let Some(existing) = self
            .read_with_identity(key, bytes.len().saturating_add(1))
            .await?
        {
            return if existing.bytes == bytes {
                Ok(WriteConfirmation::ExistingBytes(existing.identity))
            } else {
                Err("目标云对象与内容身份不一致，未覆盖".into())
            };
        }
        self.directories(key).await?;
        let response = self
            .request(Method::PUT, key)?
            .header("If-None-Match", "*")
            .header("Content-Type", "application/octet-stream")
            .header(reqwest::header::CONTENT_LENGTH, bytes.len())
            .body(crate::cloud_transfer_meter::body(bytes))
            .send()
            .await;
        let acceptable = response
            .as_ref()
            .is_ok_and(|r| r.status().is_success() || matches!(r.status().as_u16(), 409 | 412));
        match self
            .read_with_identity(key, bytes.len().saturating_add(1))
            .await?
        {
            Some(actual) if actual.bytes == bytes => {
                Ok(WriteConfirmation::Written(actual.identity))
            }
            _ if !acceptable => Err("WebDAV 上传未确认，待同步记录保留".into()),
            _ => Err("WebDAV 上传读回校验失败".into()),
        }
    }
    async fn identity(&self, key: &str) -> Result<Option<Identity>, String> {
        let response = self
            .request(Method::HEAD, key)?
            .send()
            .await
            .map_err(|_| "WebDAV 对象身份读取中断")?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(format!(
                "WebDAV 对象身份读取失败：HTTP {}",
                response.status()
            ));
        }
        Ok(Some(Identity::headers(response.headers())))
    }
    async fn listing_page(
        &self,
        relative: &str,
        continuation: Option<&str>,
    ) -> Result<InventoryPage, String> {
        if continuation.is_some() {
            return Err("WebDAV 当前目录不支持分页游标".into());
        }
        let directory = self.key(relative);
        validate_key(&directory, true)?;
        let mut page = InventoryPage::default();
        let response=self.request(Method::from_bytes(b"PROPFIND").map_err(|_|"WebDAV 方法无效")?,&directory)?.header("Depth","1").header("Content-Type","application/xml").body("<?xml version=\"1.0\"?><d:propfind xmlns:d=\"DAV:\"><d:prop><d:resourcetype/></d:prop></d:propfind>").send().await.map_err(|_|"WebDAV 列表读取中断")?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(page);
        }
        if response.status().as_u16() != 207 {
            return Err(format!("WebDAV 列表读取失败：HTTP {}", response.status()));
        }
        let bytes = bounded(response, 8 * 1024 * 1024).await?;
        for entry in parse_listing(&bytes)? {
            let url = self
                .base
                .join(&entry.href)
                .map_err(|_| "WebDAV 列表地址无效")?;
            if url.origin() != self.base.origin()
                || url.query().is_some()
                || url.fragment().is_some()
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err("WebDAV 返回同步目录之外的地址".into());
            }
            let path = url
                .path()
                .strip_prefix(self.base.path())
                .ok_or("WebDAV 返回同步目录之外的对象")?
                .to_string();
            validate_key(&path, true)?;
            if path.trim_end_matches('/') == directory.trim_end_matches('/') {
                continue;
            }
            if !path.starts_with(&directory) {
                return Err("WebDAV 列表对象越过请求目录".into());
            }
            let child = path
                .strip_prefix(&directory)
                .ok_or("WebDAV 列表边界无效")?
                .trim_end_matches('/');
            if child.contains('/') || child.is_empty() {
                return Err("WebDAV 未遵守有界目录读取，已停止".into());
            }
            if entry.collection {
                let logical = path
                    .strip_prefix(&self.key(""))
                    .ok_or("WebDAV 目录越过同步范围")?;
                page.directories
                    .push(format!("{}/", logical.trim_end_matches('/')));
            } else {
                page.keys.push(path);
            }
        }
        Ok(page)
    }
    // Aggregate traversal is retained solely for legacy transport differential tests.
    #[cfg(test)]
    async fn listing(&self, relative: &str) -> Result<Vec<String>, String> {
        let mut queue = std::collections::VecDeque::from([relative.to_string()]);
        let mut visited = std::collections::BTreeSet::new();
        let mut files = std::collections::BTreeSet::new();
        while let Some(directory) = queue.pop_front() {
            if !visited.insert(directory.clone()) {
                return Err("WebDAV 列表包含重复目录，未跳过记录".into());
            }
            let page = self.listing_page(&directory, None).await?;
            queue.extend(page.directories);
            files.extend(page.keys);
        }
        Ok(files.into_iter().collect())
    }
    async fn delete(&self, key: &str) -> Result<(), String> {
        validate_key(key, false)?;
        let response = self
            .request(Method::DELETE, key)?
            .send()
            .await
            .map_err(|_| "WebDAV 精确清理中断")?;
        if !response.status().is_success() && response.status() != StatusCode::NOT_FOUND {
            return Err(format!("WebDAV 精确清理失败：HTTP {}", response.status()));
        }
        if self.read(key, 0).await?.is_some() {
            return Err("WebDAV 对象清理尚未确认".into());
        }
        Ok(())
    }
}
impl Store for WebdavStore {
    fn head_identity<'a>(
        &'a self,
        key: &'a str,
    ) -> BoxFuture<'a, Result<Option<Identity>, String>> {
        Box::pin(self.identity(key))
    }
    fn get_with_identity<'a>(
        &'a self,
        key: &'a str,
        max: usize,
    ) -> BoxFuture<'a, Result<Option<ObjectBytes>, String>> {
        Box::pin(self.read_with_identity(key, max))
    }
    fn put_confirmed<'a>(
        &'a self,
        key: &'a str,
        bytes: &'a [u8],
    ) -> BoxFuture<'a, Result<WriteConfirmation, String>> {
        Box::pin(self.confirm(key, bytes))
    }
    fn key(&self, relative: &str) -> String {
        format!("v2/{relative}")
    }
    fn check_network(&self, key: &str) -> Result<(), String> {
        if key.starts_with("v2/reading/") {
            if let Some(g) = &self.guard {
                return g();
            }
        }
        Ok(())
    }
    fn head_size<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<Option<u64>, String>> {
        Box::pin(async move {
            let response = self
                .request(Method::HEAD, key)?
                .send()
                .await
                .map_err(|_| "WebDAV 对象大小读取中断")?;
            if response.status() == StatusCode::NOT_FOUND {
                return Ok(None);
            }
            if !response.status().is_success() {
                return Err(format!(
                    "WebDAV 对象大小读取失败：HTTP {}",
                    response.status()
                ));
            }
            Ok(Some(
                response
                    .headers()
                    .get(reqwest::header::CONTENT_LENGTH)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok())
                    .ok_or("WebDAV 未返回可确认的对象大小")?,
            ))
        })
    }
    fn get<'a>(
        &'a self,
        key: &'a str,
        max: usize,
    ) -> BoxFuture<'a, Result<Option<Vec<u8>>, String>> {
        Box::pin(self.read(key, max))
    }
    #[cfg(test)]
    fn list<'a>(&'a self, relative: &'a str) -> BoxFuture<'a, Result<Vec<String>, String>> {
        Box::pin(self.listing(relative))
    }
    fn inventory_page<'a>(
        &'a self,
        relative: &'a str,
        continuation: Option<&'a str>,
    ) -> BoxFuture<'a, Result<InventoryPage, String>> {
        Box::pin(self.listing_page(relative, continuation))
    }
    fn put_verified<'a>(
        &'a self,
        key: &'a str,
        bytes: &'a [u8],
    ) -> BoxFuture<'a, Result<bool, String>> {
        Box::pin(self.put(key, bytes))
    }
    fn delete_exact<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(self.delete(key))
    }
}
fn validate_key(key: &str, directory: bool) -> Result<(), String> {
    if !key.starts_with("v2/")
        || key.len() > 1024
        || (!directory && key.ends_with('/'))
        || key.trim_end_matches('/').split('/').any(|v| {
            v.is_empty()
                || matches!(v, "." | "..")
                || !v
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
        })
    {
        return Err("云对象必须位于明确的同步目录内".into());
    }
    Ok(())
}
async fn bounded(mut response: reqwest::Response, max: usize) -> Result<Vec<u8>, String> {
    if response.content_length().is_some_and(|v| v > max as u64) {
        return Err("云对象超过大小上限".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "云对象读取中断")? {
        crate::cloud_transfer_meter::downloaded(chunk.len());
        if bytes.len().saturating_add(chunk.len()) > max {
            return Err("云对象超过大小上限".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
struct Listing {
    href: String,
    collection: bool,
}
fn parse_listing(bytes: &[u8]) -> Result<Vec<Listing>, String> {
    use quick_xml::events::Event;
    let mut reader = quick_xml::Reader::from_reader(bytes);
    let mut root = false;
    let mut current: Option<Listing> = None;
    let mut statuses = Vec::new();
    let mut output = Vec::new();
    loop {
        match reader.read_event().map_err(|_| "WebDAV 列表 XML 无效")? {
            Event::Start(e) => match e.local_name().as_ref() {
                b"multistatus" => root = true,
                b"response" => {
                    if current.is_some() {
                        return Err("WebDAV 列表嵌套响应无效".into());
                    }
                    current = Some(Listing {
                        href: String::new(),
                        collection: false,
                    });
                    statuses.clear();
                }
                b"href" | b"status" => {
                    let local = e.local_name().as_ref().to_vec();
                    let raw = reader
                        .read_text(e.name())
                        .map_err(|_| "WebDAV 列表字段无效")?;
                    let decoded = raw.decode().map_err(|_| "WebDAV 列表编码无效")?;
                    let text = quick_xml::escape::unescape(&decoded)
                        .map_err(|_| "WebDAV 列表转义无效")?
                        .into_owned();
                    if let Some(entry) = &mut current {
                        if local == b"href" {
                            if !entry.href.is_empty() {
                                return Err("WebDAV 列表重复地址".into());
                            }
                            entry.href = text;
                        } else {
                            statuses.push(text);
                        }
                    }
                }
                b"collection" => {
                    if let Some(entry) = &mut current {
                        entry.collection = true;
                    }
                }
                _ => {}
            },
            Event::Empty(e) if e.local_name().as_ref() == b"collection" => {
                if let Some(entry) = &mut current {
                    entry.collection = true;
                }
            }
            Event::End(e) if e.local_name().as_ref() == b"response" => {
                let entry = current.take().ok_or("WebDAV 列表响应缺失")?;
                if entry.href.is_empty()
                    || statuses.is_empty()
                    || statuses
                        .iter()
                        .any(|v| v.split_whitespace().nth(1) != Some("200"))
                {
                    return Err("WebDAV 列表包含未确认对象，不将其视为空目录".into());
                }
                output.push(entry);
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if !root || current.is_some() {
        return Err("WebDAV 列表缺少完整响应".into());
    }
    Ok(output)
}

#[cfg(test)]
pub(crate) mod tests;
