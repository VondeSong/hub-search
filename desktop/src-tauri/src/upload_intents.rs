//! A committed attempt survives an absent acknowledgement and a process restart.
//! Confirmed remote receipts are separate from an intent to send bytes.
use crate::*;
pub(crate) enum Admission {
    Send,
    Confirmed(String),
    Unconfirmed,
}

pub(crate) fn key(provider: &str, target: &str, owner: &str, bytes: &[u8]) -> String {
    encode_digest_hex(&Sha256::digest(
        serde_json::to_vec(&(
            provider,
            target,
            owner,
            encode_digest_hex(&Sha256::digest(bytes)),
        ))
        .unwrap(),
    ))
}
fn schema(c: &Connection) -> Result<(), String> {
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS attachment_upload_intents(
        work_key TEXT PRIMARY KEY,provider TEXT NOT NULL,remote_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('sending','confirmed','retryable')),
        updated_at INTEGER NOT NULL)",
    )
    .map_err(|e| e.to_string())
}
pub(crate) fn admit(
    path: &PathBuf,
    key: &str,
    provider: &str,
    id: &str,
) -> Result<Admission, String> {
    let (mut c, _writer) = open_write_database(path)?;
    schema(&c)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let prior: Option<(String, String)> = tx
        .query_row(
            "SELECT status,remote_id FROM attachment_upload_intents WHERE work_key=?1",
            [key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let admission = match prior {
        Some((status, id)) if status == "confirmed" => Admission::Confirmed(id),
        Some((status, _)) if status == "sending" => Admission::Unconfirmed,
        _ => {
            tx.execute("INSERT INTO attachment_upload_intents(work_key,provider,remote_id,status,updated_at) VALUES(?1,?2,?3,'sending',?4)
                ON CONFLICT(work_key) DO UPDATE SET status='sending',updated_at=excluded.updated_at",
                params![key,provider,id,now_timestamp()]).map_err(|e| e.to_string())?;
            Admission::Send
        }
    };
    tx.commit().map_err(|e| e.to_string())?;
    Ok(admission)
}
pub(crate) fn finish(path: &PathBuf, key: &str, id: &str) -> Result<(), String> {
    let (c, _writer) = open_write_database(path)?;
    c.execute("UPDATE attachment_upload_intents SET status='confirmed',remote_id=?2,updated_at=?3 WHERE work_key=?1",
        params![key,id,now_timestamp()]).map_err(|e| e.to_string())?;
    Ok(())
}
pub(crate) fn rejected(path: &PathBuf, key: &str, error: &str) -> Result<(), String> {
    // A disconnected request, 5xx or invalid reply may follow server acceptance.
    if !error.starts_with("UPLOAD_REJECTED:") {
        return Ok(());
    }
    let (c, _writer) = open_write_database(path)?;
    c.execute(
        "UPDATE attachment_upload_intents SET status='retryable',updated_at=?2 WHERE work_key=?1",
        params![key, now_timestamp()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
pub(crate) fn retire(c: &Connection, provider: &str, id: &str) -> Result<(), String> {
    schema(c)?;
    c.execute("UPDATE attachment_upload_intents SET status='retryable',updated_at=?3 WHERE provider=?1 AND remote_id=?2 AND status='confirmed'",
        params![provider,id,now_timestamp()]).map_err(|e| e.to_string())?;
    Ok(())
}
pub(crate) const PENDING: &str =
    "附件上传结果待核对：已保留上传意图，未重复传输。请核对远端附件后继续处理。";
