//! One content-addressed reading transport contract for OSS.
use super::*;
use crate::flashcard_object_store::{
    Identity, ObjectBytes, OssConfig, OssStore, WriteConfirmation,
};
use futures::future::BoxFuture;

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
}
impl Configuration {
    pub(crate) fn namespace(&self) -> String {
        match self {
            Self::Oss { config } => config.namespace(),
        }
    }
}
pub(crate) fn configuration_for(c: &Connection, provider: &str) -> Result<Configuration, String> {
    match provider {
        "oss" => Ok(Configuration::Oss {
            config: flashcard_cloud_sync::config(c)?.normalized()?,
        }),
        _ => Err("旧 WebDAV 同步已停用，请配置阿里云 OSS；本机内容与旧云端文件保留".into()),
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
    configured_module_store(app, c, config, secret, "reading/")
}

pub(crate) fn configured_module_store(
    app: &AppHandle,
    c: &Connection,
    config: &Configuration,
    secret: Option<String>,
    module: &str,
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
            let prefix = remote.key(module);
            Ok(Box::new(remote.with_network_guard(prefix, guard)))
        }
    }
}
type Guard = Arc<dyn Fn() -> Result<(), String> + Send + Sync>;

#[cfg(test)]
pub(crate) mod tests;
