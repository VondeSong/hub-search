//! Retries belong to one immutable manifest and survive repeated staging and restart.
use super::*;
pub(super) const MAX_ATTEMPTS: u64 = 6;

#[derive(Clone, Copy)]
pub(super) enum Admission {
    Quota,
    Cache,
    Type,
    Network,
}
tokio::task_local! {
    static WAITING: Arc<std::sync::Mutex<Option<Admission>>>;
}
// Record a denial at its actual producer. Unknown error text never implies waiting.
pub(super) fn wait(reason: Admission, message: impl Into<String>) -> String {
    let _ = WAITING.try_with(|value| {
        *value.lock().unwrap_or_else(|e| e.into_inner()) = Some(reason);
    });
    message.into()
}
pub(super) async fn track(
    future: impl std::future::Future<Output = Result<(), String>>,
) -> (Result<(), String>, bool) {
    let waiting = Arc::new(std::sync::Mutex::new(None));
    let result = WAITING.scope(waiting.clone(), future).await;
    let denied = waiting.lock().unwrap_or_else(|e| e.into_inner()).is_some();
    (result, denied)
}

pub(super) fn schema(c: &Connection) -> Result<(), String> {
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS reading_media_retries(
        namespace TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,
        attempts INTEGER NOT NULL,next_at INTEGER NOT NULL,PRIMARY KEY(namespace,kind,id));",
    )
    .map_err(|e| e.to_string())
}
pub(super) fn due(c: &Connection, ns: &str, kind: &str, id: &str) -> Result<bool, String> {
    c.query_row(
        "SELECT attempts<?4 AND next_at<=?5 FROM reading_media_retries
        WHERE namespace=?1 AND kind=?2 AND id=?3",
        params![ns, kind, id, MAX_ATTEMPTS, now_timestamp()],
        |r| r.get(0),
    )
    .optional()
    .map(|v| v.unwrap_or(true))
    .map_err(|e| e.to_string())
}
pub(super) fn clear(c: &Connection, ns: &str, kind: &str, id: &str) -> Result<(), String> {
    c.execute(
        "DELETE FROM reading_media_retries WHERE namespace=?1 AND kind=?2 AND id=?3",
        params![ns, kind, id],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}
pub(super) fn failed(
    db: &PathBuf,
    ns: &str,
    kind: &str,
    id: &str,
    waiting: bool,
) -> Result<bool, String> {
    let (c, _writer) = open_write_database(db)?;
    let attempts: u64 = c
        .query_row(
            "SELECT attempts FROM reading_media_retries
        WHERE namespace=?1 AND kind=?2 AND id=?3",
            params![ns, kind, id],
            |r| r.get::<_, u64>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or(0)
        .saturating_add(u64::from(!waiting));
    let delay = if waiting {
        60
    } else {
        60i64.saturating_mul(1i64 << attempts.min(6))
    };
    c.execute("INSERT INTO reading_media_retries VALUES(?1,?2,?3,?4,?5)
        ON CONFLICT(namespace,kind,id) DO UPDATE SET attempts=excluded.attempts,next_at=excluded.next_at",
        params![ns,kind,id,attempts,now_timestamp().saturating_add(delay)]).map_err(|e|e.to_string())?;
    Ok(attempts >= MAX_ATTEMPTS)
}
