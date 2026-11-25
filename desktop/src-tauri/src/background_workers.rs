//! Owns automatic scheduling and the process lifetime shared by domain dispatchers.
use crate::{
    backfill_attachment_discovery, backfill_document_blobs, backfill_ocr_pipeline, blob_store_for,
    claim_flashcard_auto_sync_due, cleanup_due, cleanup_local_storage, craft_backup,
    craft_backup_resources, database_path, flashcard_quality, flush_content_pipeline,
    flush_index_jobs, flush_obsidian_watch_changes, isolated_runtime, library_runtime,
    now_timestamp, reading_sync, refresh_obsidian_watchers, run_craft_backup,
    schedule_library_remove, search_index_root, sync_due_libraries, telegram, x_bookmarks,
    AppState,
};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    LazyLock,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::watch;

const STARTUP_GRACE: Duration = Duration::from_secs(12);
static LIFETIME: LazyLock<Lifetime> = LazyLock::new(Lifetime::default);
static STARTED: AtomicBool = AtomicBool::new(false);
static FLASHCARD_TICKS: AtomicU64 = AtomicU64::new(0);
static INDEX_TICKS: AtomicU64 = AtomicU64::new(0);
static PIPELINE_TICKS: AtomicU64 = AtomicU64::new(0);
static MANUAL_SESSION: AtomicBool = AtomicBool::new(false);

// An explicit startup choice for recovery and real-data acceptance. It does not
// change stored preferences, source authorization, credentials or manual actions.
fn parse_manual_session(arguments: &[std::ffi::OsString], isolated: bool) -> Result<bool, String> {
    let mut requested = false;
    for argument in arguments {
        if argument == "--manual-session" {
            if requested || isolated {
                return Err("手动会话参数不可重复，也不能与隔离运行混用".into());
            }
            requested = true;
        } else if argument.to_string_lossy().starts_with("--manual-session=") {
            return Err("手动会话参数不接受附加值".into());
        }
    }
    Ok(requested)
}
pub(crate) fn configure_manual_session(
    arguments: &[std::ffi::OsString],
    isolated: bool,
) -> Result<(), String> {
    MANUAL_SESSION.store(
        parse_manual_session(arguments, isolated)?,
        Ordering::Release,
    );
    Ok(())
}
pub(crate) fn manual_session() -> bool {
    MANUAL_SESSION.load(Ordering::Acquire)
}

struct Lifetime {
    stop: watch::Sender<bool>,
}
impl Default for Lifetime {
    fn default() -> Self {
        Self {
            stop: watch::channel(false).0,
        }
    }
}
impl Lifetime {
    fn running(&self) -> bool {
        !*self.stop.borrow()
    }
    fn shutdown(&self) {
        self.stop.send_replace(true);
    }
    async fn wait(&self, duration: Duration) -> bool {
        let mut stop = self.stop.subscribe();
        if *stop.borrow() {
            return false;
        }
        tokio::select! {
            _ = tokio::time::sleep(duration) => self.running(),
            _ = stop.changed() => false,
        }
    }
}
pub(crate) fn running() -> bool {
    LIFETIME.running()
}
pub(crate) async fn wait(duration: Duration) -> bool {
    LIFETIME.wait(duration).await
}
pub(crate) fn shutdown() {
    LIFETIME.shutdown();
}
pub(crate) fn started() -> bool {
    STARTED.load(Ordering::Acquire)
}
#[tauri::command]
pub(crate) fn background_worker_status() -> Value {
    json!({ "started":started(), "stopping":!running(), "manualSession":manual_session(),
        "flashcardTicks":FLASHCARD_TICKS.load(Ordering::Relaxed),
        "indexTicks":INDEX_TICKS.load(Ordering::Relaxed),
        "pipelineTicks":PIPELINE_TICKS.load(Ordering::Relaxed) })
}
pub(crate) fn historical_backfill_delay(completed: Option<usize>) -> Duration {
    if completed == Some(0) {
        Duration::from_secs(15 * 60)
    } else {
        Duration::from_secs(30)
    }
}
pub(crate) fn start(app: AppHandle) {
    if !isolated_runtime::automatic_workers_enabled()
        || !running()
        || STARTED.swap(true, Ordering::AcqRel)
    {
        return;
    }
    x_bookmarks::start_scheduler(app.clone());
    crate::data_portability::start_scheduler(app.clone());
    x_bookmarks::local_sources::start(app.clone());
    crate::dida_task_refresh::start(app.clone());
    reading_sync::start_scheduler(app.clone());
    crate::quick_journal::start_scheduler(app.clone());
    x_bookmarks::library::start_worker(app.clone());
    telegram::start_scheduler(app.clone());
    let condition_app = app.clone();
    tauri::async_runtime::spawn(async move {
        if !wait(STARTUP_GRACE).await {
            return;
        }
        while running() {
            if let Ok(root) = crate::active_data_root(&condition_app) {
                if let Ok(Ok(Some(notice))) =
                    tokio::task::spawn_blocking(move || crate::agent_work::condition_tick(&root))
                        .await
                {
                    let _ = condition_app.emit("agent-condition-notice", notice);
                }
            }
            if !wait(Duration::from_secs(30)).await {
                break;
            }
        }
    });
    // Keep flashcard transport independent from slow library indexing/sync.
    let flashcard_app = app.clone();
    tauri::async_runtime::spawn(async move {
        while running() {
            FLASHCARD_TICKS.fetch_add(1, Ordering::Relaxed);
            let _ =
                flashcard_quality::sync_flashcard_quality_if_enabled(flashcard_app.clone()).await;
            if !wait(Duration::from_secs(5)).await {
                break;
            }
        }
    });
    // Text changes do not wait behind PDF/OCR, downloads or remote sync.
    let index_app = app.clone();
    tauri::async_runtime::spawn(async move {
        while running() {
            INDEX_TICKS.fetch_add(1, Ordering::Relaxed);
            let state = index_app.state::<AppState>();
            let _ = flush_index_jobs(&index_app, &state).await;
            if !wait(Duration::from_secs(3)).await {
                break;
            }
        }
    });
    let worker_app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Leave the first window and first search request a startup head start.
        if !wait(STARTUP_GRACE).await {
            return;
        }
        if let Ok(database) = database_path(&worker_app) {
            if let Some(root) = database.parent() {
                if let Ok(statuses) = library_runtime::statuses(root) {
                    for status in statuses
                        .into_iter()
                        .filter(|status| status.state == "removing")
                    {
                        schedule_library_remove(
                            worker_app.clone(),
                            database.clone(),
                            status.library_id,
                        );
                    }
                }
            }
        }
        if let Ok(database) = database_path(&worker_app) {
            let _ =
                tokio::task::spawn_blocking(move || craft_backup_resources::reconcile(&database))
                    .await;
        }
        let mut first_maintenance = true;
        let mut last_maintenance = Instant::now();
        let mut next_backfill = Instant::now();
        {
            let state = worker_app.state::<AppState>();
            let _ = refresh_obsidian_watchers(&worker_app, &state);
        }
        while running() {
            PIPELINE_TICKS.fetch_add(1, Ordering::Relaxed);
            let state = worker_app.state::<AppState>();
            if first_maintenance || last_maintenance.elapsed() >= Duration::from_secs(30) {
                if Instant::now() >= next_backfill {
                    if let (Ok(path), Ok(blob_store)) = (
                        database_path(&worker_app),
                        blob_store_for(&worker_app, &state),
                    ) {
                        let result = tokio::task::spawn_blocking(move || {
                            let not_applicable =
                                crate::attachment_queue::reconcile_ocr_types(&path)?;
                            let cached_downloads =
                                crate::attachment_queue::reconcile(&path, &blob_store)?;
                            let blobs = backfill_document_blobs(&path, &blob_store, 50)?;
                            let attachments = backfill_attachment_discovery(&path, 50)?;
                            let ocr = backfill_ocr_pipeline(&path, 8)?;
                            Ok::<usize, String>(
                                not_applicable + cached_downloads + blobs + attachments + ocr,
                            )
                        })
                        .await;
                        next_backfill = Instant::now()
                            + historical_backfill_delay(result.ok().and_then(Result::ok));
                    }
                }
                let _ = sync_due_libraries(worker_app.clone(), state.clone()).await;
                if let (Ok(database), Ok(blob_store), Ok(index_root)) = (
                    database_path(&worker_app),
                    blob_store_for(&worker_app, &state),
                    search_index_root(&worker_app),
                ) {
                    if cleanup_due(&database).unwrap_or(false) {
                        let _ = tokio::task::spawn_blocking(move || {
                            cleanup_local_storage(&database, &blob_store, &index_root)
                        })
                        .await;
                    }
                }
                if let Ok(database) = database_path(&worker_app) {
                    if let Ok(configs) = craft_backup::configs(&database) {
                        for config in configs {
                            if craft_backup::due(&config, now_timestamp())
                                && database.parent().is_some_and(|root| {
                                    library_runtime::gate(root, &config.library_id).is_ok()
                                })
                            {
                                // Use the same lock as manual capture and source sync.
                                // Persisted last_attempt prevents a failed run spinning.
                                let _guard = state.sync_guard.lock().await;
                                if let Err(error) = run_craft_backup(
                                    &worker_app,
                                    &state,
                                    craft_backup::config_options(&config),
                                    true,
                                )
                                .await
                                {
                                    let mut failed = config.clone();
                                    failed.last_attempt_at = now_timestamp();
                                    failed.last_error = Some(error);
                                    let _ = craft_backup::save_config(&database, &failed);
                                    let _ = worker_app.emit(
                                        "craft-backup-updated",
                                        json!({"libraryId":failed.library_id,"success":false}),
                                    );
                                }
                            }
                        }
                    }
                }
                first_maintenance = false;
                last_maintenance = Instant::now();
            }
            let watched = flush_obsidian_watch_changes(&worker_app, &state)
                .await
                .unwrap_or(0);
            let processed = flush_content_pipeline(&worker_app, &state)
                .await
                .unwrap_or(0);
            if !wait(if watched > 0 || processed > 0 {
                Duration::from_millis(500)
            } else {
                Duration::from_secs(3)
            })
            .await
            {
                break;
            }
        }
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn manual_session_is_explicit_nonpersistent_and_never_expands_isolated_access() {
        let args = |items: &[&str]| {
            items
                .iter()
                .map(|s| std::ffi::OsString::from(*s))
                .collect::<Vec<_>>()
        };
        assert!(!parse_manual_session(&args(&[]), false).unwrap());
        assert!(!parse_manual_session(&args(&[]), true).unwrap());
        assert!(parse_manual_session(&args(&["--manual-session"]), false).unwrap());
        assert!(parse_manual_session(&args(&["--manual-session"]), true).is_err());
        assert!(
            parse_manual_session(&args(&["--manual-session", "--manual-session"]), false).is_err()
        );
        assert!(parse_manual_session(&args(&["--manual-session=true"]), false).is_err());
    }
    #[tokio::test]
    async fn shutdown_wakes_registered_waiters_and_blocks_later_admission() {
        let lifetime = std::sync::Arc::new(Lifetime::default());
        let worker = lifetime.clone();
        let waiting = tokio::spawn(async move { worker.wait(Duration::from_secs(60)).await });
        tokio::task::yield_now().await;
        lifetime.shutdown();
        assert!(!tokio::time::timeout(Duration::from_secs(1), waiting)
            .await
            .unwrap()
            .unwrap());
        assert!(!lifetime.running());
        assert!(!lifetime.wait(Duration::from_secs(60)).await);
    }
    #[tokio::test]
    async fn normal_cadence_completes_without_stopping_the_owner() {
        let lifetime = Lifetime::default();
        assert!(lifetime.wait(Duration::from_millis(1)).await);
        assert!(lifetime.running());
        assert_eq!(historical_backfill_delay(Some(0)), Duration::from_secs(900));
        assert_eq!(historical_backfill_delay(Some(1)), Duration::from_secs(30));
        assert_eq!(historical_backfill_delay(None), Duration::from_secs(30));
    }
}
