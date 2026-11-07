//! Collection copies share the same per-library admission and durable stop barrier.
use super::*;
use std::future::Future;
use std::sync::Arc;

struct Context {
    id: String,
    operation: crate::library_runtime::Operation,
}
tokio::task_local! { static CURRENT: Arc<Context>; }
tokio::task_local! { static AGENT: crate::model_runtime::Control; }
pub(crate) async fn agent_scope<T>(
    control: crate::model_runtime::Control,
    future: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    control.check()?;
    AGENT.scope(control, future).await
}

fn target_id(app: &AppHandle, target: &str) -> Result<Option<String>, String> {
    let root = active_data_root(app)?;
    if target == "hub" || target.is_empty() {
        return Ok(None);
    }
    if let Some(hash) = target.strip_prefix("vault:") {
        let c = open_database(&database_path(app)?)?;
        let path: String = c
            .query_row(
                "SELECT root FROM collection_roots WHERE destination=?1",
                [hash],
                |r| r.get(0),
            )
            .map_err(|_| "保存目录尚未识别")?;
        return crate::library_runtime::obsidian_gate(&root, Path::new(&path));
    }
    crate::library_runtime::gate(&root, target)?;
    Ok(Some(target.to_string()))
}
pub(in crate::x_bookmarks) fn gate_target(app: &AppHandle, target: &str) -> Result<(), String> {
    target_id(app, target).map(|_| ())
}
pub(in crate::x_bookmarks) fn outgoing_enabled(
    app: &AppHandle,
    target: &str,
    provider: &str,
) -> Result<bool, String> {
    let Some(id) = target_id(app, target)? else {
        return Ok(true);
    };
    crate::library_policy::outgoing_enabled(&active_data_root(app)?, &id, provider)
}
pub(in crate::x_bookmarks) async fn scope<T>(
    app: &AppHandle,
    target: &str,
    future: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    let Some(id) = target_id(app, target)? else {
        return future.await;
    };
    if CURRENT
        .try_with(|context| context.id == id)
        .unwrap_or(false)
    {
        checkpoint()?;
        return future.await;
    }
    let root = active_data_root(app)?;
    let admission = crate::library_runtime::admission(&root, &id)?;
    let operation = crate::library_runtime::begin(&root, &id, "保存收藏副本")?;
    operation.phase("queued", "等待该资料库完成当前操作")?;
    let waiting = admission.lock_owned();
    tokio::pin!(waiting);
    let _guard = loop {
        tokio::select! {
            guard = &mut waiting => break guard,
            _ = tokio::time::sleep(Duration::from_millis(250)) => operation.checkpoint()?,
        }
    };
    operation.phase("collection", "保存收藏副本")?;
    let context = Arc::new(Context { id, operation });
    let result = CURRENT.scope(context.clone(), future).await;
    if let Err(error) = &result {
        context.operation.failed(error);
    }
    result
}
pub(in crate::x_bookmarks) async fn vault_scope<T>(
    app: &AppHandle,
    vault: &str,
    future: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    let Some(id) =
        crate::library_runtime::obsidian_gate(&active_data_root(app)?, Path::new(vault))?
    else {
        return future.await;
    };
    scope(app, &id, future).await
}
pub(in crate::x_bookmarks) fn checkpoint() -> Result<(), String> {
    AGENT.try_with(|guard| guard.check()).unwrap_or(Ok(()))?;
    CURRENT
        .try_with(|context| context.operation.checkpoint())
        .unwrap_or(Ok(()))
}
pub(in crate::x_bookmarks) fn phase(phase: &str, detail: &str) -> Result<(), String> {
    CURRENT
        .try_with(|context| context.operation.phase(phase, detail))
        .unwrap_or(Ok(()))
}
pub(in crate::x_bookmarks) fn commit<T>(
    write: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    AGENT.try_with(|guard| guard.check()).unwrap_or(Ok(()))?;
    let context = CURRENT.try_with(Arc::clone).ok();
    match context {
        Some(context) => context.operation.commit(write),
        None => write(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn agent_cancel_stops_subsequent_domain_checkpoints_and_commits() {
        let guard = crate::model_runtime::Control::default();
        let cancel = guard.clone();
        agent_scope(guard, async {
            checkpoint()?;
            cancel.cancel();
            let mut changed = false;
            assert!(checkpoint().is_err());
            assert!(commit(|| {
                changed = true;
                Ok(())
            })
            .is_err());
            assert!(!changed);
            Ok(())
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn library_management_collection_late_commit_stays_stopped_after_resume() {
        let root = std::env::temp_dir().join(format!(
            "hub-collection-control-{}",
            crate::random_url_safe(12)
        ));
        fs::create_dir_all(&root).unwrap();
        let operation = crate::library_runtime::begin(&root, "fixture", "复制").unwrap();
        let context = Arc::new(Context {
            id: "fixture".into(),
            operation,
        });
        CURRENT
            .scope(context, async {
                crate::library_runtime::control(&root, "fixture", "pause").unwrap();
                crate::library_runtime::control(&root, "fixture", "resume").unwrap();
                let mut written = false;
                assert!(commit(|| {
                    written = true;
                    Ok(())
                })
                .is_err());
                assert!(!written);
                assert!(checkpoint().is_err());
            })
            .await;
        fs::remove_dir_all(root).unwrap();
    }
}
