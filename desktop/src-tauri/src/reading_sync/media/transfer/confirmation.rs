//! A receipt records verified bytes, never an unverified HEAD assertion.
use super::*;
use crate::flashcard_object_store::Identity;

pub(super) fn schema(c: &Connection) -> Result<(), String> {
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS reading_media_object_receipts(
        namespace TEXT NOT NULL,object_key TEXT NOT NULL,hash TEXT NOT NULL,
        size INTEGER NOT NULL,identity TEXT,PRIMARY KEY(namespace,object_key));",
    )
    .map_err(|e| e.to_string())
}

pub(super) async fn put(
    db: &PathBuf,
    p: &Policy,
    budget: &Budget,
    remote: &dyn ReadingStore,
    ns: &str,
    key: &str,
    bytes: &[u8],
    force: bool,
) -> Result<(), String> {
    let digest = hash(bytes);
    let old: Option<String> = open_database(db)?
        .query_row(
            "SELECT identity FROM reading_media_object_receipts
         WHERE namespace=?1 AND object_key=?2 AND hash=?3 AND size=?4",
            params![ns, key, digest, bytes.len() as u64],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .flatten();
    if let Some(saved) = old
        .filter(|_| !force)
        .and_then(|v| serde_json::from_str::<Identity>(&v).ok())
    {
        if saved.etag.is_some() {
            check_network(remote, key)?;
            if remote
                .head_identity(key)
                .await?
                .is_some_and(|now| saved.same_version(&now))
            {
                return Ok(());
            }
        }
    }
    let proof = budget.put_confirmed(db, p, remote, key, bytes).await?;
    let identity = if matches!(proof, WriteConfirmation::ExistingMetadata(_)) {
        // First acquisition still verifies actual bytes. Later reuse needs a fresh version proof.
        let received = budget
            .get_with_identity(db, p, remote, key, bytes.len() + 1)
            .await?
            .ok_or("云端附件已缺失")?;
        if received.bytes != bytes {
            return Err("云端附件校验失败".into());
        }
        received.identity
    } else {
        proof.identity().cloned()
    };
    let (c, _writer) = open_write_database(db)?;
    let identity = identity
        .map(|v| serde_json::to_string(&v))
        .transpose()
        .map_err(|e| e.to_string())?;
    c.execute(
        "INSERT INTO reading_media_object_receipts(namespace,object_key,hash,size,identity)
        VALUES(?1,?2,?3,?4,?5) ON CONFLICT(namespace,object_key) DO UPDATE SET
        hash=excluded.hash,size=excluded.size,identity=excluded.identity",
        params![ns, key, digest, bytes.len() as u64, identity],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
