//! Released WebDAV flashcard wire decoding, bounded intake and legacy crypto migration.
use crate::{
    error_chain,
    flashcard_models::{FlashcardEncryptedEnvelope, FlashcardSyncSettings, FlashcardSyncSnapshot},
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use pbkdf2::pbkdf2_hmac;
use rand::RngCore;
use serde::Deserialize;
use serde_json::Value;
use sha2::Sha256;
use url::Url;

pub(crate) const FLASHCARD_SYNC_MAX_SNAPSHOT_BYTES: usize = 32 * 1024 * 1024;
pub(crate) const FLASHCARD_SYNC_KDF_ITERATIONS: u32 = 200_000;
pub(crate) const FLASHCARD_MEDIA_MAGIC: &[u8] = b"HUBMEDIA1";

pub(crate) fn derive_flashcard_sync_key(secret: &str, salt: &[u8], iterations: u32) -> [u8; 32] {
    let mut key = [0_u8; 32];
    pbkdf2_hmac::<Sha256>(secret.as_bytes(), salt, iterations, &mut key);
    key
}

#[cfg(test)]
pub(crate) fn encrypt_flashcard_snapshot(
    snapshot: &FlashcardSyncSnapshot,
    secret: &str,
) -> Result<Vec<u8>, String> {
    let plaintext =
        serde_json::to_vec(snapshot).map_err(|error| format!("无法编码闪卡同步快照：{error}"))?;
    let mut salt = [0_u8; 16];
    let mut nonce = [0_u8; 24];
    rand::thread_rng().fill_bytes(&mut salt);
    rand::thread_rng().fill_bytes(&mut nonce);
    let key = derive_flashcard_sync_key(secret, &salt, FLASHCARD_SYNC_KDF_ITERATIONS);
    let cipher = XChaCha20Poly1305::new((&key).into());
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), plaintext.as_ref())
        .map_err(|_| "无法加密闪卡同步快照".to_string())?;
    serde_json::to_vec(&FlashcardEncryptedEnvelope {
        format: "hub-flashcards-encrypted-v1".to_string(),
        kdf: "pbkdf2-sha256".to_string(),
        iterations: FLASHCARD_SYNC_KDF_ITERATIONS,
        salt: STANDARD.encode(salt),
        nonce: STANDARD.encode(nonce),
        ciphertext: STANDARD.encode(ciphertext),
    })
    .map_err(|error| format!("无法编码加密闪卡快照：{error}"))
}

pub(crate) fn decode_flashcard_snapshot(
    bytes: &[u8],
    secret: &str,
) -> Result<FlashcardSyncSnapshot, String> {
    #[derive(Deserialize)]
    struct Format {
        #[serde(default)]
        format: Option<Value>,
    }
    // Ignored fields are parsed without constructing a second full JSON tree.
    let format: Format =
        serde_json::from_slice(bytes).map_err(|error| format!("远端闪卡快照格式无效：{error}"))?;
    if format.format.as_ref().and_then(Value::as_str) != Some("hub-flashcards-encrypted-v1") {
        return serde_json::from_slice(bytes)
            .map_err(|error| format!("远端闪卡快照格式无效：{error}"));
    }
    if secret.is_empty() {
        return Err("远端闪卡仍是旧版加密格式，但本设备没有可用于迁移的旧口令".to_string());
    }
    let envelope = serde_json::from_slice::<FlashcardEncryptedEnvelope>(bytes)
        .map_err(|error| format!("远端加密快照格式无效：{error}"))?;
    if envelope.kdf != "pbkdf2-sha256" || !(100_000..=1_000_000).contains(&envelope.iterations) {
        return Err("远端闪卡使用了不支持的加密参数".to_string());
    }
    let salt = STANDARD
        .decode(envelope.salt)
        .map_err(|_| "远端闪卡加密盐无效".to_string())?;
    let nonce = STANDARD
        .decode(envelope.nonce)
        .map_err(|_| "远端闪卡加密 nonce 无效".to_string())?;
    let ciphertext = STANDARD
        .decode(envelope.ciphertext)
        .map_err(|_| "远端闪卡密文无效".to_string())?;
    if salt.len() != 16 || nonce.len() != 24 {
        return Err("远端闪卡加密参数长度无效".to_string());
    }
    let key = derive_flashcard_sync_key(secret, &salt, envelope.iterations);
    let cipher = XChaCha20Poly1305::new((&key).into());
    let plaintext = cipher
        .decrypt(XNonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| "无法解密远端闪卡；请确认两台设备使用完全相同的加密口令".to_string())?;
    serde_json::from_slice(&plaintext).map_err(|error| format!("解密后的闪卡快照无效：{error}"))
}

#[cfg(test)]
pub(crate) fn encrypt_flashcard_media(bytes: &[u8], secret: &str) -> Result<Vec<u8>, String> {
    if secret.is_empty() {
        return Ok(bytes.to_vec());
    }
    let key = derive_flashcard_sync_key(
        secret,
        b"hub-flashcards-media-e1",
        FLASHCARD_SYNC_KDF_ITERATIONS,
    );
    let cipher = XChaCha20Poly1305::new((&key).into());
    let mut nonce = [0_u8; 24];
    rand::thread_rng().fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), bytes)
        .map_err(|_| "无法加密闪卡媒体".to_string())?;
    let mut output =
        Vec::with_capacity(FLASHCARD_MEDIA_MAGIC.len() + nonce.len() + ciphertext.len());
    output.extend_from_slice(FLASHCARD_MEDIA_MAGIC);
    output.extend_from_slice(&nonce);
    output.extend_from_slice(&ciphertext);
    Ok(output)
}

pub(crate) fn decrypt_flashcard_media(bytes: &[u8], secret: &str) -> Result<Vec<u8>, String> {
    if !bytes.starts_with(FLASHCARD_MEDIA_MAGIC) {
        return Ok(bytes.to_vec());
    }
    if secret.is_empty() {
        return Err("远端闪卡媒体仍是旧版加密格式，但本设备没有可用于迁移的旧口令".to_string());
    }
    let nonce_start = FLASHCARD_MEDIA_MAGIC.len();
    let ciphertext_start = nonce_start + 24;
    if bytes.len() <= ciphertext_start {
        return Err("远端闪卡媒体密文不完整".to_string());
    }
    let key = derive_flashcard_sync_key(
        secret,
        b"hub-flashcards-media-e1",
        FLASHCARD_SYNC_KDF_ITERATIONS,
    );
    XChaCha20Poly1305::new((&key).into())
        .decrypt(
            XNonce::from_slice(&bytes[nonce_start..ciphertext_start]),
            &bytes[ciphertext_start..],
        )
        .map_err(|_| "无法解密远端闪卡媒体；请检查加密口令".to_string())
}

pub(crate) fn webdav_request(
    client: &reqwest::Client,
    method: reqwest::Method,
    url: Url,
    username: &str,
    password: &str,
) -> reqwest::RequestBuilder {
    let request = client.request(method, url);
    if username.is_empty() && password.is_empty() {
        request
    } else {
        request.basic_auth(username, Some(password))
    }
}

pub(crate) async fn read_remote_flashcard_snapshot(
    client: &reqwest::Client,
    url: Url,
    settings: &FlashcardSyncSettings,
    password: &str,
    encryption_key: &str,
) -> Result<(Option<FlashcardSyncSnapshot>, Option<String>), String> {
    read_snapshot(client, url, settings, password, encryption_key, None).await
}

fn cache_key(url: &Url, settings: &FlashcardSyncSettings, password: &str) -> String {
    use sha2::Digest;
    format!(
        "flashcard_webdav_cache:{:x}",
        Sha256::digest(serde_json::to_vec(&(url.as_str(), &settings.username, password)).unwrap())
    )
}

pub(crate) fn store_snapshot_cache(
    database: &std::path::PathBuf,
    url: &Url,
    settings: &FlashcardSyncSettings,
    password: &str,
    snapshot: &FlashcardSyncSnapshot,
    etag: Option<&str>,
) -> Result<(), String> {
    use sha2::Digest;
    let body = serde_json::to_string(snapshot).map_err(|e| e.to_string())?;
    let value = serde_json::json!({"etag":etag,"body":body,"sha256":format!("{:x}",Sha256::digest(body.as_bytes()))}).to_string();
    let (c, _writer) = crate::open_write_database(database)?;
    c.execute("INSERT INTO metadata(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        rusqlite::params![cache_key(url, settings, password), value]).map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) async fn read_snapshot(
    client: &reqwest::Client,
    url: Url,
    settings: &FlashcardSyncSettings,
    password: &str,
    encryption_key: &str,
    database: Option<&std::path::PathBuf>,
) -> Result<(Option<FlashcardSyncSnapshot>, Option<String>), String> {
    use rusqlite::OptionalExtension;
    use sha2::Digest;
    let cached = database.and_then(|db| {
        let raw: Option<String> = crate::open_database(db)
            .ok()?
            .query_row(
                "SELECT value FROM metadata WHERE key=?1",
                [cache_key(&url, settings, password)],
                |r| r.get(0),
            )
            .optional()
            .ok()?;
        let value: Value = serde_json::from_str(&raw?).ok()?;
        let body = value["body"].as_str()?;
        if value["sha256"].as_str()? != format!("{:x}", Sha256::digest(body.as_bytes())) {
            return None;
        }
        let snapshot: FlashcardSyncSnapshot = serde_json::from_str(body).ok()?;
        let etag = value["etag"].as_str()?.to_owned();
        if etag.is_empty() {
            return None;
        }
        Some((snapshot, etag))
    });
    let mut request = webdav_request(
        client,
        reqwest::Method::GET,
        url.clone(),
        &settings.username,
        password,
    );
    if let Some((_, etag)) = &cached {
        request = request.header("If-None-Match", etag);
    }
    let mut response = request
        .send()
        .await
        .map_err(|error| format!("无法下载远端闪卡：{}", error_chain(&error)))?;
    if response.status() == reqwest::StatusCode::NOT_MODIFIED {
        let (snapshot, etag) = cached.ok_or("远端返回未变化，但本机缺少可信快照")?;
        return Ok((Some(snapshot), Some(etag)));
    }
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok((None, None));
    }
    let status = response.status();
    if !status.is_success() {
        return Err(format!("无法下载远端闪卡：HTTP {status}"));
    }
    let etag = response
        .headers()
        .get("etag")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    if response
        .content_length()
        .is_some_and(|length| length > FLASHCARD_SYNC_MAX_SNAPSHOT_BYTES as u64)
    {
        return Err("远端闪卡快照超过 32 MB 安全限制".to_string());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("无法读取远端闪卡：{}", error_chain(&error)))?
    {
        if chunk.len() > FLASHCARD_SYNC_MAX_SNAPSHOT_BYTES.saturating_sub(bytes.len()) {
            return Err("远端闪卡快照超过 32 MB 安全限制".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    let snapshot = decode_flashcard_snapshot(&bytes, encryption_key)?;
    if let Some(db) = database {
        store_snapshot_cache(db, &url, settings, password, &snapshot, etag.as_deref())?;
    }
    Ok((Some(snapshot), etag))
}

pub(crate) fn same_domain(
    a: &FlashcardSyncSnapshot,
    b: &FlashcardSyncSnapshot,
) -> Result<bool, String> {
    fn domain(snapshot: &FlashcardSyncSnapshot) -> Result<Value, String> {
        let mut value = serde_json::to_value(snapshot).map_err(|e| e.to_string())?;
        let map = value.as_object_mut().ok_or("闪卡快照无效")?;
        map.remove("exportedAt");
        map.remove("deviceId");
        // These top-level arrays are sets of domain records; SQL row order isn't a change.
        for child in map.values_mut() {
            if let Some(items) = child.as_array_mut() {
                items.sort_by_cached_key(Value::to_string);
            }
        }
        Ok(value)
    }
    Ok(domain(a)? == domain(b)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{database::initialize_database, flashcard_snapshot::local_flashcard_snapshot};
    use std::path::PathBuf;
    use std::{
        io::{Read, Write},
        net::TcpListener,
    };
    fn settings() -> FlashcardSyncSettings {
        FlashcardSyncSettings {
            url: String::new(),
            username: String::new(),
            has_password: false,
            auto_sync: false,
            configured: false,
            last_sync_at: None,
            last_error: String::new(),
        }
    }
    #[test]
    fn plaintext_decoder_preserves_unknown_format_metadata_and_tail_cards() {
        let c = initialize_database(&PathBuf::from(":memory:")).unwrap();
        c.execute_batch("INSERT INTO flashcard_decks(id,name,created_at,updated_at) VALUES('deck','Deck',1,1);
          INSERT INTO flashcards(id,deck_id,question,answer,created_at,updated_at,due_at) VALUES('tail','deck','Tail question','Answer',1,1,1);").unwrap();
        let mut value = serde_json::to_value(local_flashcard_snapshot(&c).unwrap()).unwrap();
        value["format"] = serde_json::json!({"ignored":true});
        let result = decode_flashcard_snapshot(&serde_json::to_vec(&value).unwrap(), "").unwrap();
        assert_eq!(result.cards[0].id, "tail");
        assert!(decode_flashcard_snapshot(b"{broken", "").is_err());
    }
    #[tokio::test]
    async fn streaming_webdav_keeps_exact_32_mib_capacity_and_rejects_chunked_overflow() {
        let c = initialize_database(&PathBuf::from(":memory:")).unwrap();
        let mut valid = serde_json::to_vec(&local_flashcard_snapshot(&c).unwrap()).unwrap();
        valid.resize(FLASHCARD_SYNC_MAX_SNAPSHOT_BYTES, b' ');
        for overflow in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let body = if overflow {
                vec![b' '; FLASHCARD_SYNC_MAX_SNAPSHOT_BYTES + 1]
            } else {
                valid.clone()
            };
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .unwrap();
                socket
                    .set_write_timeout(Some(std::time::Duration::from_secs(10)))
                    .unwrap();
                let mut request = [0u8; 4096];
                socket.read(&mut request).unwrap();
                socket.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nETag: fixture\r\nConnection: close\r\n\r\n").unwrap();
                for chunk in body.chunks(8192) {
                    if write!(socket, "{:x}\r\n", chunk.len())
                        .and_then(|_| socket.write_all(chunk))
                        .and_then(|_| socket.write_all(b"\r\n"))
                        .is_err()
                    {
                        break;
                    }
                }
                let _ = socket.write_all(b"0\r\n\r\n");
            });
            let client = reqwest::Client::builder()
                .no_proxy()
                .timeout(std::time::Duration::from_secs(15))
                .build()
                .unwrap();
            let result = read_remote_flashcard_snapshot(
                &client,
                Url::parse(&format!("http://127.0.0.1:{port}/snapshot")).unwrap(),
                &settings(),
                "",
                "",
            )
            .await;
            server.join().unwrap();
            if overflow {
                assert!(result.unwrap_err().contains("32 MB"));
            } else {
                let (snapshot, etag) = result.unwrap();
                assert_eq!(snapshot.unwrap().version, 4);
                assert_eq!(etag.as_deref(), Some("fixture"));
            }
        }
    }
}
