//! Cancellation authority is independent of the database writer. Only an
//! accepted operation can be cancelled; publication and cancellation share a
//! short final commit barrier.
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, OnceLock};

const CANCELLED: &str = "BACKUP_CANCELLED:备份操作已取消，原数据未修改";
#[derive(Default)]
struct Status {
    cancelled: bool,
    committed: bool,
}
pub(super) struct Token {
    state: Mutex<Status>,
    on_cancel: Mutex<Option<Arc<dyn Fn() -> Result<(), String> + Send + Sync>>>,
}
impl Token {
    fn checkpoint(&self) -> Result<(), String> {
        if self
            .state
            .lock()
            .map_err(|_| "备份控制状态不可用")?
            .cancelled
        {
            Err(CANCELLED.into())
        } else {
            Ok(())
        }
    }
    fn cancel(&self) -> Result<bool, String> {
        {
            let mut state = self.state.lock().map_err(|_| "备份控制状态不可用")?;
            if state.committed {
                return Ok(false);
            }
            state.cancelled = true;
        }
        let hook = self
            .on_cancel
            .lock()
            .map_err(|_| "备份控制状态不可用")?
            .clone();
        if let Some(hook) = hook {
            hook()?;
        }
        Ok(true)
    }
    fn commit<T>(
        &self,
        terminal: bool,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let mut state = self.state.lock().map_err(|_| "备份控制状态不可用")?;
        if state.cancelled {
            return Err(CANCELLED.into());
        }
        let result = action()?;
        if terminal {
            state.committed = true;
        }
        Ok(result)
    }
}
#[derive(Default)]
struct RegistryState {
    closed: bool,
    active: HashMap<(PathBuf, String), Arc<Token>>,
}
#[derive(Default)]
struct Registry {
    state: Mutex<RegistryState>,
    released: Condvar,
}
fn registry() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(Default::default)
}
fn root_key(root: &Path) -> Result<PathBuf, String> {
    Ok(PathBuf::from(crate::display_local_path(
        &root.canonicalize().map_err(|_| "备份数据目录不可用")?,
    )))
}
fn id_key(root: &Path, id: &str) -> Result<(PathBuf, String), String> {
    if id.is_empty()
        || id.len() > 64
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Err("备份操作标识无效".into());
    }
    Ok((root_key(root)?, id.into()))
}
pub(super) struct Operation {
    key: (PathBuf, String),
    token: Arc<Token>,
}
pub(super) fn begin(root: &Path, id: &str) -> Result<Operation, String> {
    let key = id_key(root, id)?;
    let mut state = registry().state.lock().map_err(|_| "备份控制状态不可用")?;
    if state.closed {
        return Err("BACKUP_CLOSED:应用正在退出".into());
    }
    if state.active.contains_key(&key) {
        return Err("备份操作标识已在使用".into());
    }
    if state.active.len() >= 4 {
        return Err("备份操作已达到并发上限，请等待正在执行的操作".into());
    }
    let token = Arc::new(Token {
        state: Mutex::new(Status::default()),
        on_cancel: Mutex::new(None),
    });
    state.active.insert(key.clone(), Arc::clone(&token));
    Ok(Operation { key, token })
}
pub(super) fn cancel(root: &Path, id: &str) -> Result<bool, String> {
    let key = id_key(root, id)?;
    let state = registry().state.lock().map_err(|_| "备份控制状态不可用")?;
    state
        .active
        .get(&key)
        .map(|token| token.cancel())
        .unwrap_or(Ok(false))
}
thread_local! { static CURRENT: RefCell<Option<Arc<Token>>> = const { RefCell::new(None) }; }
struct Scope(Option<Arc<Token>>);
impl Drop for Scope {
    fn drop(&mut self) {
        CURRENT.with(|current| *current.borrow_mut() = self.0.take());
    }
}
impl Operation {
    #[cfg(target_os = "android")]
    pub(super) fn on_cancel(
        &self,
        hook: impl Fn() -> Result<(), String> + Send + Sync + 'static,
    ) -> Result<(), String> {
        let hook: Arc<dyn Fn() -> Result<(), String> + Send + Sync> = Arc::new(hook);
        *self
            .token
            .on_cancel
            .lock()
            .map_err(|_| "备份控制状态不可用")? = Some(Arc::clone(&hook));
        if self
            .token
            .state
            .lock()
            .map_err(|_| "备份控制状态不可用")?
            .cancelled
        {
            hook()?;
        }
        Ok(())
    }
    pub(super) fn run<T>(self, action: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        let previous = CURRENT.with(|current| current.replace(Some(Arc::clone(&self.token))));
        let _scope = Scope(previous);
        checkpoint()?;
        let result = action();
        // A provider stream may fail because cancellation closed it. Preserve
        // the cancellation outcome instead of surfacing its incidental IO error.
        checkpoint()?;
        let result = result?;
        // Read-only commands have no earlier publication boundary.
        commit(true, || Ok(result))
    }
}
impl Drop for Operation {
    fn drop(&mut self) {
        let mut state = registry()
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if state
            .active
            .get(&self.key)
            .is_some_and(|value| Arc::ptr_eq(value, &self.token))
        {
            state.active.remove(&self.key);
        }
        registry().released.notify_all();
    }
}
pub(super) fn checkpoint() -> Result<(), String> {
    CURRENT.with(|current| {
        current
            .borrow()
            .as_ref()
            .map(|token| token.checkpoint())
            .unwrap_or(Ok(()))
    })
}
pub(super) fn commit<T>(
    terminal: bool,
    action: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    CURRENT.with(|current| match current.borrow().as_ref() {
        Some(token) => token.commit(terminal, action),
        None => action(),
    })
}
pub(super) fn shutdown() {
    let mut state = registry()
        .state
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    state.closed = true;
    for token in state.active.values() {
        let _ = token.cancel();
    }
    while !state.active.is_empty() {
        state = registry()
            .released
            .wait(state)
            .unwrap_or_else(|error| error.into_inner());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_and_final_publication_have_one_authoritative_outcome() {
        let cancelled = Token {
            state: Mutex::new(Status::default()),
            on_cancel: Mutex::new(None),
        };
        assert!(cancelled.cancel().unwrap());
        assert!(cancelled
            .commit(true, || Ok(()))
            .unwrap_err()
            .starts_with("BACKUP_CANCELLED:"));
        let committed = Token {
            state: Mutex::new(Status::default()),
            on_cancel: Mutex::new(None),
        };
        committed.commit(true, || Ok(())).unwrap();
        assert!(!committed.cancel().unwrap());
        assert!(committed.checkpoint().is_ok());
        let intermediate = Token {
            state: Mutex::new(Status::default()),
            on_cancel: Mutex::new(None),
        };
        intermediate.commit(false, || Ok(())).unwrap();
        assert!(
            intermediate.cancel().unwrap(),
            "a recovery safety snapshot is not the recovery commit"
        );
    }
}
