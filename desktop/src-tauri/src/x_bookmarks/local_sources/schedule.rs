//! Intake scheduling is independent of remote collection and vault export.
use super::*;

const ATTEMPT: &str = "collection_local_sources_attempt_v1";
static ACTIVE: AtomicBool = AtomicBool::new(false);
static WAKE: tokio::sync::Notify = tokio::sync::Notify::const_new();

pub(super) fn running() -> bool {
    ACTIVE.load(Ordering::Acquire)
}
pub(super) fn wake() {
    WAKE.notify_one();
}
struct Permit {
    notify: bool,
}
impl Permit {
    fn acquire(notify: bool) -> Option<Self> {
        ACTIVE
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| Self { notify })
    }
}
impl Drop for Permit {
    fn drop(&mut self) {
        ACTIVE.store(false, Ordering::Release);
        if self.notify {
            wake();
        }
    }
}

pub(super) fn delay(c: &Connection, cfg: &storage::StorageConfig, now: i64) -> Option<Duration> {
    if cfg.mode != "obsidian"
        || cfg.vault_path.trim().is_empty()
        || !(5..=1440).contains(&cfg.local_sources_minutes)
    {
        return None;
    }
    let previous: Value = serde_json::from_str(&metadata_string(c, ATTEMPT)).unwrap_or_default();
    let same_root = previous["root"].as_str().is_some_and(|root| {
        crate::library_location::path_key(Path::new(root))
            == crate::library_location::path_key(Path::new(&cfg.vault_path))
    });
    let at = previous["at"].as_i64().unwrap_or(0);
    if !same_root || at <= 0 || at > now {
        return Some(Duration::ZERO);
    }
    let seconds = i64::from(cfg.local_sources_minutes) * 60;
    Some(Duration::from_secs((seconds - (now - at)).max(0) as u64))
}

// Recheck saved preferences at each batch boundary, including a switch to manual.
pub(super) fn batch(
    c: &mut Connection,
    expected: &storage::StorageConfig,
    automatic: bool,
    first: bool,
) -> Result<Option<Outcome>, String> {
    let cfg = storage::config(c)?;
    if cfg.mode != "obsidian" || cfg.vault_path.trim().is_empty() {
        return if automatic {
            Ok(None)
        } else {
            Err("请先保存 Obsidian 库位置，再检查本地素材".into())
        };
    }
    if crate::library_location::path_key(Path::new(&cfg.vault_path))
        != crate::library_location::path_key(Path::new(&expected.vault_path))
        || automatic && cfg.local_sources_minutes == 0
    {
        return Ok(None);
    }
    if first {
        meta(
            c,
            ATTEMPT,
            &json!({"root":cfg.vault_path,"at":now_timestamp()}).to_string(),
        )?;
    }
    match scan(c) {
        Ok(value) => Ok(Some(value)),
        Err(error) => {
            let mut status = status(c);
            status["error"] = json!(error);
            status["root"] = json!(cfg.vault_path);
            status["lastCheckedAt"] = json!(now_timestamp());
            meta(c, STATUS, &status.to_string())?;
            Err(error)
        }
    }
}

async fn run(app: AppHandle, _permit: Permit, automatic: bool) -> Result<Outcome, String> {
    let worker = app.clone();
    let expected = tokio::task::spawn_blocking(move || {
        let c = open_database(&database_path(&worker)?)?;
        storage::config(&c)
    })
    .await
    .map_err(|e| e.to_string())??;
    let mut total = Outcome::default();
    let mut first = true;
    loop {
        let worker = app.clone();
        let cfg = expected.clone();
        let value = tokio::task::spawn_blocking(move || {
            let (mut c, _writer) = open_write_database(&database_path(&worker)?)?;
            storage::schema(&c)?;
            batch(&mut c, &cfg, automatic, first)
        })
        .await
        .map_err(|e| e.to_string())??;
        let Some(value) = value else {
            break;
        };
        if value.changed > 0 {
            let _ = app.emit("collections-updated", json!({"source":"local"}));
        }
        total.changed += value.changed;
        total.files = value.files;
        total.errors = value.errors;
        total.remaining = value.remaining;
        if value.remaining == 0 || !crate::background_workers::wait(Duration::from_secs(1)).await {
            break;
        }
        first = false;
    }
    // Count the interval from the end of a completed pass, so a large backfill
    // does not immediately start another pass. Errors were throttled at entry.
    if total.remaining == 0 {
        let worker = app.clone();
        let root = expected.vault_path;
        tokio::task::spawn_blocking(move || {
            let (c, _writer) = open_write_database(&database_path(&worker)?)?;
            meta(
                &c,
                ATTEMPT,
                &json!({"root":root,"at":now_timestamp()}).to_string(),
            )
        })
        .await
        .map_err(|e| e.to_string())??;
    }
    Ok(total)
}

pub(super) async fn check(app: AppHandle) -> Result<Outcome, String> {
    if cfg!(mobile) {
        return Err("请在桌面端检查本地素材".into());
    }
    let permit = Permit::acquire(true).ok_or("本地素材正在检查，请等待本轮结束")?;
    run(app, permit, false).await
}

pub(super) fn start(app: AppHandle) {
    if cfg!(mobile) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        while crate::background_workers::running() {
            let worker = app.clone();
            let next = tokio::task::spawn_blocking(move || {
                let c = open_database(&database_path(&worker)?)?;
                let cfg = storage::config(&c)?;
                Ok::<_, String>(delay(&c, &cfg, now_timestamp()))
            })
            .await;
            let next = match next {
                Ok(Ok(value)) => value,
                _ => Some(Duration::from_secs(60)),
            };
            if next == Some(Duration::ZERO) {
                if let Some(permit) = Permit::acquire(false) {
                    if run(app.clone(), permit, true).await.is_ok() {
                        continue;
                    }
                    // If database access failed before the attempt could be saved,
                    // avoid an error loop. Config saves can wake this wait early.
                }
            }
            let duration = if next == Some(Duration::ZERO) {
                Duration::from_secs(60)
            } else {
                next.unwrap_or(Duration::from_secs(86400))
            };
            tokio::select! {
                alive = crate::background_workers::wait(duration) => { if !alive { break; } },
                _ = WAKE.notified() => {},
            }
        }
    });
}
