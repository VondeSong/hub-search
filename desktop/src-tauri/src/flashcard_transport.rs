//! Offline decoding of released flashcard snapshots and legacy encrypted backups.
use crate::flashcard_models::{FlashcardEncryptedEnvelope, FlashcardSyncSnapshot};
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{database::initialize_database, flashcard_snapshot::local_flashcard_snapshot};
    use std::path::PathBuf;
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
}
