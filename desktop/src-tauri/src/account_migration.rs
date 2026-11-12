//! User-selected Hub credentials, encrypted independently of Windows and the data archive.
//! Secret values never cross IPC. Import only addresses identities in the current profile.
use chacha20poly1305::{
    aead::{Aead, Payload},
    KeyInit, XChaCha20Poly1305, XNonce,
};
use pbkdf2::pbkdf2_hmac;
use rand::RngCore;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    path::Path,
};
use tauri::AppHandle;

const MAGIC: &[u8] = b"HUBAUTH1";
pub(crate) const FILE: &str = "account-transfer.hubauth";
const ITERATIONS: u32 = 600_000;
const MAX_BYTES: usize = 16 * 1024 * 1024;
const MAX_ENTRIES: usize = 2_048;

#[derive(Clone, Copy)]
enum Kind {
    OAuth,
    Raw,
    XRecipe,
}
#[derive(Clone)]
struct Spec {
    id: String,
    label: String,
    category: String,
    key: String,
    kind: Kind,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    id: String,
    value: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Bundle {
    version: u32,
    created_at: i64,
    records: Vec<Record>,
}

trait Store {
    fn get(&self, spec: &Spec) -> Result<Option<String>, String>;
    fn put(&self, spec: &Spec, value: &str) -> Result<(), String>;
    fn remove(&self, spec: &Spec) -> Result<(), String>;
}
struct NativeStore<'a>(&'a AppHandle);
impl Store for NativeStore<'_> {
    fn get(&self, spec: &Spec) -> Result<Option<String>, String> {
        match spec.kind {
            Kind::OAuth => crate::oauth_credentials::load(&crate::OAuthSecretStore, &spec.key),
            Kind::Raw => crate::stored_secret_get(self.0, &spec.key),
            Kind::XRecipe => crate::x_bookmarks::migration_read(self.0, &spec.key),
        }
        .map_err(|_| format!("无法读取“{}”的授权，请检查此连接后重试", spec.label))
    }
    fn put(&self, spec: &Spec, value: &str) -> Result<(), String> {
        match spec.kind {
            Kind::OAuth => {
                let _: crate::StoredCredential =
                    serde_json::from_str(value).map_err(|_| "授权包中的 OAuth 数据无效")?;
                let _guard = crate::OAUTH_CREDENTIAL_WRITE_LOCK
                    .lock()
                    .map_err(|_| "授权保存状态不可用")?;
                crate::oauth_credentials::save(&crate::OAuthSecretStore, &spec.key, value)
            }
            Kind::Raw => crate::stored_secret_set(self.0, &spec.key, value),
            Kind::XRecipe => crate::x_bookmarks::migration_write(self.0, &spec.key, value),
        }
        .map_err(|_| format!("无法写入“{}”的授权", spec.label))
    }
    fn remove(&self, spec: &Spec) -> Result<(), String> {
        match spec.kind {
            Kind::OAuth => crate::oauth_credentials::remove(&crate::OAuthSecretStore, &spec.key),
            Kind::Raw => {
                crate::stored_secret_delete(self.0, &spec.key);
                Ok(())
            }
            Kind::XRecipe => crate::x_bookmarks::migration_remove(self.0, &spec.key),
        }
    }
}

fn specs(root: &Path) -> Result<BTreeMap<String, Spec>, String> {
    let c = Connection::open_with_flags(
        root.join("craft-search.sqlite3"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|_| "无法读取当前资料库，请先打开或恢复 Hub 数据")?;
    let mut result = BTreeMap::new();
    let mut add = |id: String, label: String, category: &str, key: String, kind| {
        result.insert(
            id.clone(),
            Spec {
                id,
                label,
                category: category.into(),
                key,
                kind,
            },
        );
    };
    let mut q = c
        .prepare("SELECT id,name,provider FROM libraries ORDER BY name,id")
        .map_err(|_| "无法读取资料库列表")?;
    for row in q
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|_| "无法读取资料库列表")?
    {
        let (id, name, provider) = row.map_err(|_| "无法读取资料库标识")?;
        if provider != "obsidian" {
            add(
                format!("oauth:{id}"),
                format!("{name} · 账号授权"),
                "accounts",
                id.clone(),
                Kind::OAuth,
            );
        }
        if provider == "craft" {
            add(
                format!("api:{id}"),
                format!("{name} · Craft API 地址"),
                "accounts",
                crate::craft_api_credential_id(&id),
                Kind::Raw,
            );
            add(
                format!("api-key:{id}"),
                format!("{name} · Craft API 密钥"),
                "accounts",
                crate::craft_api_key_credential_id(&id),
                Kind::Raw,
            );
        }
    }
    let exists: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='feishu_authorizations')", [], |r| r.get(0)).map_err(|_| "无法检查账号列表")?;
    if exists {
        let mut q = c
            .prepare("SELECT id,name FROM feishu_authorizations ORDER BY id")
            .map_err(|_| "无法读取飞书账号")?;
        for row in q
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|_| "无法读取飞书账号")?
        {
            let (id, name) = row.map_err(|_| "无法读取飞书账号")?;
            add(
                format!("oauth:{id}"),
                format!("{name} · 飞书账号"),
                "accounts",
                id,
                Kind::OAuth,
            );
        }
    }
    for (key, label, category) in [
        ("hub-flashcard-oss-secret-v1", "OSS 访问密钥", "services"),
        ("hub-telegram-bot-token-v1", "Telegram Bot 令牌", "services"),
    ] {
        add(
            format!("secret:{key}"),
            label.into(),
            category,
            key.into(),
            Kind::Raw,
        );
    }
    for (key, label) in [
        ("bookmarks", "X 书签网页登录连接"),
        ("likes", "X 喜欢网页登录连接"),
    ] {
        add(
            format!("x:{key}"),
            label.into(),
            "webSessions",
            key.into(),
            Kind::XRecipe,
        );
    }
    Ok(result)
}

fn selected<'a>(
    specs: &'a BTreeMap<String, Spec>,
    ids: &[String],
) -> Result<Vec<&'a Spec>, String> {
    if ids.is_empty() || ids.len() > MAX_ENTRIES {
        return Err("请勾选需要迁移的授权或密码".into());
    }
    let mut seen = BTreeSet::new();
    ids.iter()
        .map(|id| {
            if !seen.insert(id) {
                return Err("迁移项目重复".into());
            }
            specs
                .get(id)
                .ok_or_else(|| "所选账号不属于当前 Hub 数据，请重新检查".into())
        })
        .collect()
}
fn password_check(password: &str) -> Result<(), String> {
    if password.chars().count() < 12 || password.len() > 1024 {
        return Err("请设置至少 12 个字符、至多 1024 字节的迁移密码".into());
    }
    Ok(())
}
fn validate(bundle: &Bundle) -> Result<(), String> {
    if bundle.version != 1 || bundle.records.is_empty() || bundle.records.len() > MAX_ENTRIES {
        return Err("授权包版本或项目数量无效".into());
    }
    let mut seen = BTreeSet::new();
    for record in &bundle.records {
        if record.id.len() > 512
            || record.value.len() > 2 * 1024 * 1024
            || record.value.is_empty()
            || !seen.insert(&record.id)
        {
            return Err("授权包包含重复或无效项目".into());
        }
    }
    Ok(())
}
fn seal(bundle: &Bundle, password: &str) -> Result<Vec<u8>, String> {
    password_check(password)?;
    validate(bundle)?;
    let plain = serde_json::to_vec(bundle).map_err(|_| "无法编码授权包")?;
    if plain.len() > MAX_BYTES - 128 {
        return Err("授权包超过大小限制".into());
    }
    let mut salt = [0; 24];
    let mut nonce = [0; 24];
    rand::thread_rng().fill_bytes(&mut salt);
    rand::thread_rng().fill_bytes(&mut nonce);
    let mut header = MAGIC.to_vec();
    header.extend_from_slice(&salt);
    header.extend_from_slice(&nonce);
    let mut key = [0; 32];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), &salt, ITERATIONS, &mut key);
    let encrypted = XChaCha20Poly1305::new((&key).into())
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &plain,
                aad: &header,
            },
        )
        .map_err(|_| "无法加密授权包")?;
    key.fill(0);
    header.extend_from_slice(&encrypted);
    Ok(header)
}
fn unseal(bytes: &[u8], password: &str) -> Result<Bundle, String> {
    let offset = MAGIC.len() + 48;
    if bytes.len() <= offset + 16 || bytes.len() > MAX_BYTES || !bytes.starts_with(MAGIC) {
        return Err("不是受支持的加密授权包，或文件不完整".into());
    }
    if password.len() > 1024 {
        return Err("迁移密码过长".into());
    }
    let mut key = [0; 32];
    pbkdf2_hmac::<Sha256>(
        password.as_bytes(),
        &bytes[MAGIC.len()..MAGIC.len() + 24],
        ITERATIONS,
        &mut key,
    );
    let plain = XChaCha20Poly1305::new((&key).into())
        .decrypt(
            XNonce::from_slice(&bytes[MAGIC.len() + 24..offset]),
            Payload {
                msg: &bytes[offset..],
                aad: &bytes[..offset],
            },
        )
        .map_err(|_| "密码不正确或授权包已损坏")?;
    key.fill(0);
    let bundle: Bundle = serde_json::from_slice(&plain).map_err(|_| "授权包内容无效")?;
    validate(&bundle)?;
    Ok(bundle)
}
fn read_bundle(path: &Path, password: &str) -> Result<Bundle, String> {
    crate::craft_backup::reject_links(path)?;
    let mut file = fs::File::open(path).map_err(|_| "无法读取授权包")?;
    if file.metadata().map_err(|_| "无法读取授权包大小")?.len() > MAX_BYTES as u64 {
        return Err("授权包超过 16 MB 限制".into());
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取授权包")?;
    unseal(&bytes, password)
}

pub(crate) fn catalog(app: &AppHandle, root: &Path) -> Result<Value, String> {
    let store = NativeStore(app);
    let mut entries = Vec::new();
    for spec in specs(root)?.values() {
        match store.get(spec) {
            Ok(value) => entries.push(json!({"id":spec.id,"label":spec.label,"category":spec.category,"available":value.is_some()})),
            Err(error) => entries.push(json!({"id":spec.id,"label":spec.label,"category":spec.category,"available":false,"error":error})),
        }
    }
    Ok(json!({"entries":entries,"hasProtectedCopy":root.join(FILE).is_file()}))
}
pub(crate) fn prepare(
    app: &AppHandle,
    root: &Path,
    ids: &[String],
    password: &str,
) -> Result<Value, String> {
    password_check(password)?;
    let destination = root.join(FILE);
    crate::craft_backup::reject_links(&destination)?;
    let specs = specs(root)?;
    let store = NativeStore(app);
    let bundle = collect(&specs, &store, ids)?;
    let bytes = seal(&bundle, password)?;
    crate::data_portability::atomic_write(&destination, &bytes)?;
    Ok(json!({"path":destination,"count":bundle.records.len(),"encrypted":true}))
}
pub(crate) fn remove_copy(root: &Path) -> Result<Value, String> {
    let path = root.join(FILE);
    crate::craft_backup::reject_links(&path)?;
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("无法移除目录中的授权迁移副本".into()),
    }
    Ok(json!({"removed":true}))
}
fn collect(
    specs: &BTreeMap<String, Spec>,
    store: &impl Store,
    ids: &[String],
) -> Result<Bundle, String> {
    let records = selected(specs, ids)?
        .into_iter()
        .map(|spec| {
            Ok(Record {
                id: spec.id.clone(),
                value: store
                    .get(spec)?
                    .ok_or_else(|| format!("“{}”没有已保存的授权", spec.label))?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(Bundle {
        version: 1,
        created_at: crate::now_timestamp(),
        records,
    })
}
pub(crate) fn inspect(
    app: &AppHandle,
    root: &Path,
    path: &Path,
    password: &str,
) -> Result<Value, String> {
    let bundle = read_bundle(path, password)?;
    let specs = specs(root)?;
    let store = NativeStore(app);
    let mut entries = Vec::new();
    for record in &bundle.records {
        if let Some(spec) = specs.get(&record.id) {
            entries.push(json!({"id":spec.id,"label":spec.label,"category":spec.category,"supported":true,"conflict":store.get(spec)?.is_some()}));
        } else {
            entries.push(json!({"id":record.id,"label":"当前数据中没有此账号，请先恢复原电脑的 Hub 数据","supported":false,"conflict":false}));
        }
    }
    Ok(json!({"createdAt":bundle.created_at,"entries":entries,"targetRoot":root}))
}
pub(crate) fn import(
    app: &AppHandle,
    root: &Path,
    path: &Path,
    password: &str,
    ids: &[String],
    overwrite: bool,
) -> Result<Value, String> {
    let bundle = read_bundle(path, password)?;
    let specs = specs(root)?;
    apply(&specs, &NativeStore(app), &bundle, ids, overwrite)
}
fn apply(
    specs: &BTreeMap<String, Spec>,
    store: &impl Store,
    bundle: &Bundle,
    ids: &[String],
    overwrite: bool,
) -> Result<Value, String> {
    validate(bundle)?;
    let chosen = selected(specs, ids)?;
    let records: BTreeMap<_, _> = bundle
        .records
        .iter()
        .map(|r| (r.id.as_str(), r.value.as_str()))
        .collect();
    // Validate the complete selection before any system credential is changed.
    for spec in &chosen {
        if !records.contains_key(spec.id.as_str()) {
            return Err("所选授权不在此授权包中".into());
        }
    }
    let previous_values = chosen
        .iter()
        .map(|spec| store.get(spec))
        .collect::<Result<Vec<_>, _>>()?;
    let mut results = Vec::new();
    for (spec, previous) in chosen.into_iter().zip(previous_values) {
        if previous.is_some() && !overwrite {
            results
                .push(json!({"label":spec.label,"status":"skipped","message":"保留本机已有授权"}));
            continue;
        }
        let value = records[spec.id.as_str()];
        let write = store.put(spec, value);
        if store.get(spec).ok().flatten().as_deref() == Some(value) {
            results.push(json!({"label":spec.label,"status":"imported"}));
            continue;
        }
        let rollback = match &previous {
            Some(old) => store.put(spec, old),
            None => store.remove(spec),
        };
        let preserved = rollback.is_ok() && store.get(spec).ok().flatten() == previous;
        let _ = write; // Do not include lower-level secret-store error payloads in IPC.
        results.push(json!({"label":spec.label,"status":"failed","message":if preserved {"写入失败，原状态已保留"} else {"写入未确认，请在连接设置中检查此账号"}}));
    }
    Ok(
        json!({"results":results,"warnings":["授权导入不会发起联网请求或开启自动同步；令牌过期后仍需重新授权。","可离线使用已恢复的正文和本地附件，未下载内容需在有网络的原电脑补齐。"]}),
    )
}

#[cfg(test)]
mod tests;
