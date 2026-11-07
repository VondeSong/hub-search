//! Reserve all remote libraries touched by an operation atomically: no A/B lock inversion.
use super::*;
use std::sync::{Arc, Mutex, OnceLock};

const CONCURRENT_SAVES: usize = 4;
static STATE: OnceLock<Arc<Mutex<Reservations>>> = OnceLock::new();
#[derive(Default)]
struct Reservations {
    active: usize,
    resources: HashSet<String>,
}
pub(crate) struct Permit {
    state: Arc<Mutex<Reservations>>,
    resources: Vec<String>,
}
impl Drop for Permit {
    fn drop(&mut self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.active -= 1;
        for resource in &self.resources {
            state.resources.remove(resource);
        }
        WORKER_WAKE.notify_one();
    }
}
fn reserve(state: &Arc<Mutex<Reservations>>, resources: Vec<String>) -> Option<Permit> {
    let mut live = state.lock().unwrap_or_else(|e| e.into_inner());
    if live.active >= CONCURRENT_SAVES || resources.iter().any(|r| live.resources.contains(r)) {
        return None;
    }
    live.active += 1;
    live.resources.extend(resources.iter().cloned());
    Some(Permit {
        state: state.clone(),
        resources,
    })
}
fn resource(c: &Connection, target: &str) -> Result<String, String> {
    // Registered Obsidian libraries and a configured vault can name the same directory.
    let base = storage::config(c)?;
    if target != "hub" {
        if let Ok(cfg) = target_config(c, target, &base) {
            if cfg.mode == "obsidian" && !cfg.vault_path.is_empty() {
                let path = fs::canonicalize(&cfg.vault_path).map_err(|e| e.to_string())?;
                return Ok(format!(
                    "vault:{}",
                    crate::library_location::path_key(&path)
                ));
            }
        }
    }
    Ok(format!("library:{target}"))
}
pub(super) fn try_acquire(c: &Connection, key: &str) -> Result<Option<Permit>, String> {
    let target: String = c
        .query_row(
            "SELECT target FROM collection_library_jobs WHERE item_key=?1",
            [key],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let mut resources = vec![format!("item:{key}")];
    if !target.is_empty() {
        resources.push(resource(c, &target)?);
    }
    let mut query = c
        .prepare("SELECT DISTINCT library_id FROM collection_remote_copies WHERE item_key=?1 AND EXISTS(SELECT 1 FROM collection_library_jobs j WHERE j.item_key=?1 AND j.action='delete')")
        .map_err(|e| e.to_string())?;
    for library in query
        .query_map([key], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
    {
        resources.push(resource(c, &library.map_err(|e| e.to_string())?)?);
    }
    resources.sort();
    resources.dedup();
    Ok(reserve(STATE.get_or_init(Default::default), resources))
}
/// Keep all independent copy workers away from both directory identities while
/// their persistent roots are being rebound. No remote work is awaited here.
pub(crate) fn try_relocation(old: &Path, new: &Path) -> Result<Permit, String> {
    let mut resources = vec![
        format!("vault:{}", crate::library_location::path_key(old)),
        format!("vault:{}", crate::library_location::path_key(new)),
    ];
    resources.sort();
    resources.dedup();
    reserve(STATE.get_or_init(Default::default), resources)
        .ok_or_else(|| "当前任务仍在保存资料库副本，结束后可重新定位文件夹".into())
}
pub(super) async fn acquire(app: &AppHandle, key: &str) -> Result<Permit, String> {
    loop {
        let permit = {
            let c = open_database(&database_path(app)?)?;
            try_acquire(&c, key)?
        };
        if let Some(permit) = permit {
            return Ok(permit);
        }
        // The worker also consumes notifications; a bounded wait prevents a lost wake-up.
        tokio::select! {
            _ = WORKER_WAKE.notified() => {},
            _ = tokio::time::sleep(Duration::from_millis(250)) => {},
        }
    }
}
pub(crate) async fn acquire_target(
    app: &AppHandle,
    key: &str,
    target: &str,
    guard: &crate::model_runtime::Control,
) -> Result<Permit, String> {
    loop {
        guard.check()?;
        let permit = {
            let c = open_database(&database_path(app)?)?;
            reserve_target(&c, key, target)?
        };
        if let Some(permit) = permit {
            return Ok(permit);
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}
fn reserve_target(c: &Connection, key: &str, target: &str) -> Result<Option<Permit>, String> {
    let mut resources = vec![format!("item:{key}"), resource(c, target)?];
    resources.sort();
    resources.dedup();
    Ok(reserve(STATE.get_or_init(Default::default), resources))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_preparation_and_normal_worker_share_the_same_resource_reservations() {
        let f = crate::source_evidence::tests::Fixture::new();
        f.c().execute("INSERT INTO collection_library_jobs(item_key,action,target) VALUES('controlled-test','move','craft')",[]).unwrap();
        let permit = reserve_target(&f.c(), "controlled-test", "craft")
            .unwrap()
            .unwrap();
        assert!(try_acquire(&f.c(), "controlled-test").unwrap().is_none());
        assert!(reserve_target(&f.c(), "another-controlled-test", "craft")
            .unwrap()
            .is_none());
        assert!(
            reserve_target(&f.c(), "independent-test", "independent-library")
                .unwrap()
                .is_some()
        );
        drop(permit);
        assert!(try_acquire(&f.c(), "controlled-test").unwrap().is_some());
    }
    #[test]
    fn independent_libraries_progress_while_conflicting_moves_wait() {
        let state = Arc::new(Mutex::new(Reservations::default()));
        let first = reserve(
            &state,
            vec!["item:1".into(), "craft:car".into(), "dida:main".into()],
        )
        .unwrap();
        assert!(reserve(
            &state,
            vec!["item:2".into(), "dida:main".into(), "craft:car".into()]
        )
        .is_none());
        assert!(reserve(&state, vec!["item:1".into(), "craft:other".into()]).is_none());
        let independent = reserve(&state, vec!["item:3".into(), "craft:main".into()]).unwrap();
        drop(first);
        assert!(reserve(
            &state,
            vec!["item:2".into(), "dida:main".into(), "craft:car".into()]
        )
        .is_some());
        drop(independent);
        assert_eq!(state.lock().unwrap().active, 0);
    }
    #[test]
    fn capacity_is_bounded_and_released_on_drop() {
        let state = Arc::new(Mutex::new(Reservations::default()));
        let mut permits = (0..CONCURRENT_SAVES)
            .map(|i| reserve(&state, vec![format!("library:{i}")]).unwrap())
            .collect::<Vec<_>>();
        assert!(reserve(&state, vec!["another".into()]).is_none());
        permits.pop();
        assert!(reserve(&state, vec!["another".into()]).is_some());
    }
}
