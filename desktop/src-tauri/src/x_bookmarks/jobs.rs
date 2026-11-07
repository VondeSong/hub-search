//! App-owned work continues after a webview switches pages or unmounts.
use super::*;

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Progress {
    pub id: i64,
    pub running: bool,
    pub phase: String,
    pub source: String,
    pub processed: usize,
    pub total: usize,
    pub downloaded_bytes: u64,
    pub file_bytes: u64,
    pub file_total: Option<u64>,
    pub message: String,
    pub outcome: String,
}
static PROGRESS: std::sync::LazyLock<Mutex<Progress>> =
    std::sync::LazyLock::new(|| Mutex::new(Progress::default()));
pub(super) fn update(f: impl FnOnce(&mut Progress)) {
    if let Ok(mut p) = PROGRESS.lock() {
        f(&mut p);
    }
}
pub(super) fn snapshot() -> Progress {
    PROGRESS.lock().map(|p| p.clone()).unwrap_or_default()
}
pub(super) fn begin(phase: &str, source: &str) {
    CANCEL.store(false, Ordering::Relaxed);
    update(|p| {
        *p = Progress {
            id: chrono::Utc::now().timestamp_millis(),
            running: true,
            phase: phase.into(),
            source: source.into(),
            ..Default::default()
        }
    });
}
pub(super) fn finish(result: &Result<String, String>) {
    update(|p| {
        p.running = false;
        p.outcome = if CANCEL.load(Ordering::Relaxed) {
            "paused"
        } else if result.is_err() {
            "failed"
        } else {
            "completed"
        }
        .into();
        p.message = result
            .as_ref()
            .map(String::as_str)
            .unwrap_or_else(|e| e.as_str())
            .into();
        p.file_bytes = 0;
        p.file_total = None;
    });
}
pub(super) fn media(total: Option<u64>) {
    update(|p| {
        p.file_bytes = 0;
        p.file_total = total;
    });
}
pub(super) fn bytes(file: u64, downloaded: u64) {
    update(|p| {
        p.file_bytes = file;
        p.downloaded_bytes = downloaded;
    });
}

pub(super) fn launch_export(
    app: AppHandle,
    only: Option<String>,
    guard: tokio::sync::MutexGuard<'static, ()>,
) {
    begin("saving", "");
    tauri::async_runtime::spawn(async move {
        let _guard = guard;
        let result = storage::export(&app, only.as_deref()).await;
        finish(&result);
    });
}
pub(super) fn launch_sync(
    app: AppHandle,
    source: Source,
    restart: bool,
    guard: tokio::sync::MutexGuard<'static, ()>,
) {
    begin("fetching", source.name());
    RUNNING.store(true, Ordering::Relaxed);
    tauri::async_runtime::spawn(async move {
        let _guard = guard;
        let result = complete_sync(&app, source, restart).await;
        RUNNING.store(false, Ordering::Relaxed);
        finish(&result);
    });
}
pub(super) fn launch_all(app: AppHandle, guard: tokio::sync::MutexGuard<'static, ()>) {
    begin("fetching", "all");
    RUNNING.store(true, Ordering::Relaxed);
    tauri::async_runtime::spawn(async move {
        let _guard = guard;
        let mut messages = Vec::new();
        let mut failed = false;
        for source in [Source::Bookmarks, Source::Likes] {
            if CANCEL.load(Ordering::Relaxed) {
                break;
            }
            match stored_secret_get(&app, source.secret()) {
                Ok(Some(_)) => {
                    update(|p| {
                        p.phase = "fetching".into();
                        p.source = source.name().into();
                    });
                    let result = complete_sync(&app, source, true).await;
                    failed |= result.is_err();
                    messages.push(format!(
                        "{}：{}",
                        if source == Source::Likes {
                            "X 喜欢"
                        } else {
                            "X 书签"
                        },
                        result.unwrap_or_else(|e| e)
                    ));
                }
                Ok(None) => {}
                Err(e) => {
                    failed = true;
                    messages.push(e);
                }
            }
        }
        if messages.is_empty() {
            failed = true;
            messages.push("请先连接 X".into());
        }
        RUNNING.store(false, Ordering::Relaxed);
        let message = messages.join("\n");
        finish(&if failed { Err(message) } else { Ok(message) });
    });
}
pub(super) fn is_due(
    now: i64,
    last: i64,
    minutes: u32,
    retry: i64,
    paused: i64,
    blocked: bool,
) -> bool {
    minutes > 0
        && last > 0
        && now >= last.saturating_add(i64::from(minutes) * 60)
        && now >= retry
        && now >= paused
        && !blocked
}
pub(crate) fn start_scheduler(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Ok(path) = database_path(&app) {
            if let Ok((c, _writer)) = open_write_database(&path) {
                for key in [
                    "collection_export_status",
                    "x_bookmarks_status",
                    "x_likes_status",
                ] {
                    if metadata_string(&c, key).starts_with("正在") {
                        let _ = meta(
                            &c,
                            key,
                            "上次操作已中断，可继续同步或补写；已完成的内容保留",
                        );
                    }
                }
            }
        }
        {
            let _guard = SYNC_LOCK.lock().await;
            let _ = storage::migrate_titles(&app);
        }
        while crate::background_workers::running() {
            if !crate::background_workers::wait(Duration::from_secs(15)).await {
                break;
            }
            let Ok(guard) = SYNC_LOCK.try_lock() else {
                continue;
            };
            // Local property updates never trigger a source fetch or media download.
            let _ = properties::flush_local(&app);
            let candidate = (|| -> Result<Option<Source>, String> {
                let (c, _writer) = open_write_database(&database_path(&app)?)?;
                schema(&c)?;
                let interval = storage::config(&c)?.auto_sync_minutes;
                if interval == 0 {
                    return Ok(None);
                }
                let now = now_timestamp();
                let paused = metadata_string(&c, "collection_auto_pause_until")
                    .parse()
                    .unwrap_or(0);
                let mut due = Vec::new();
                for source in [Source::Bookmarks, Source::Likes] {
                    if stored_secret_get(&app, source.secret())?.is_none() {
                        continue;
                    }
                    let last = metadata_string(&c, &source.key("last_attempt"))
                        .parse()
                        .unwrap_or(0);
                    if last == 0 {
                        meta(&c, &source.key("last_attempt"), &now.to_string())?;
                        continue;
                    }
                    let retry = metadata_string(&c, &source.key("retry_after"))
                        .parse()
                        .unwrap_or(0);
                    let blocked = metadata_string(&c, &source.key("auto_blocked")) == "1";
                    if is_due(now, last, interval, retry, paused, blocked) {
                        due.push((last, source));
                    }
                }
                due.sort_by_key(|(last, _)| *last);
                Ok(due.first().map(|(_, source)| *source))
            })()
            .ok()
            .flatten();
            if let Some(source) = candidate {
                launch_sync(app.clone(), source, true, guard);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn interval_respects_disabled_cooldown_pause_and_auth() {
        assert!(is_due(2800, 1000, 30, 0, 0, false));
        assert!(!is_due(2799, 1000, 30, 0, 0, false));
        assert!(!is_due(5000, 1000, 0, 0, 0, false));
        assert!(!is_due(5000, 0, 30, 0, 0, false));
        assert!(!is_due(5000, 1000, 30, 5100, 0, false));
        assert!(!is_due(5000, 1000, 30, 0, 5100, false));
        assert!(!is_due(5000, 1000, 30, 0, 0, true));
    }
}
