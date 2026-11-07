//! Application payload accounting; transport hand-off is not a provider billing receipt.
use std::sync::{Arc, Mutex};
#[derive(Default)]
struct State {
    upload: u64,
    download: u64,
    observed: bool,
    closed: bool,
}
#[derive(Default)]
pub(crate) struct Meter {
    state: Mutex<State>,
}
impl Meter {
    fn with<T>(&self, f: impl FnOnce(&mut State) -> T) -> T {
        f(&mut self.state.lock().unwrap_or_else(|e| e.into_inner()))
    }
    pub(crate) fn fallback(&self, upload: u64, download: u64) {
        self.with(|s| {
            if !s.observed {
                s.upload = upload;
                s.download = download;
            }
        });
    }
    pub(crate) fn finish(&self) -> (u64, u64) {
        self.with(|s| {
            s.closed = true;
            (s.upload, s.download)
        })
    }
}
tokio::task_local! { pub(crate) static ACTIVE: Arc<Meter>; }
pub(crate) fn active() -> bool {
    ACTIVE.try_with(|_| ()).is_ok()
}
pub(crate) fn mark() {
    let _ = ACTIVE.try_with(|m| m.with(|s| s.observed = true));
}
pub(crate) fn downloaded(bytes: usize) {
    let _ = ACTIVE.try_with(|m| {
        m.with(|s| {
            s.download = s.download.saturating_add(bytes as u64);
        })
    });
}
// Capture the task owner before handing a body stream to the HTTP transport.
// Its later polls can occur outside the task-local scope.
pub(crate) fn upload_counter(
) -> impl Fn(usize) -> Result<(), std::io::Error> + Clone + Send + Sync + 'static {
    let meter = ACTIVE.try_with(Arc::clone).ok();
    move |bytes| {
        let Some(meter) = &meter else {
            return Ok(());
        };
        meter.with(|state| {
            if state.closed {
                return Err(std::io::Error::other("transfer cancelled"));
            }
            state.observed = true;
            state.upload = state.upload.saturating_add(bytes as u64);
            Ok(())
        })
    }
}
pub(crate) fn body(bytes: &[u8]) -> reqwest::Body {
    if !active() {
        return bytes.to_vec().into();
    }
    let count = upload_counter();
    let chunks: Vec<Vec<u8>> = bytes.chunks(16 * 1024).map(|v| v.to_vec()).collect();
    use futures::StreamExt;
    reqwest::Body::wrap_stream(futures::stream::iter(chunks).map(move |chunk| {
        count(chunk.len())?;
        Ok::<_, std::io::Error>(chunk)
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn captured_upload_owner_counts_outside_scope_and_refuses_after_finish() {
        let meter = Arc::new(Meter::default());
        let count = ACTIVE
            .scope(Arc::clone(&meter), async { upload_counter() })
            .await;
        assert!(!active());
        count(17).unwrap();
        count.clone()(23).unwrap();
        meter.fallback(999, 999);
        assert_eq!(meter.finish(), (40, 0));
        assert!(count(100).is_err());
        assert_eq!(meter.finish(), (40, 0));
        upload_counter()(7).unwrap();
    }
}
