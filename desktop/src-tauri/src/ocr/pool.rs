//! Bounded admission and drain/join ownership for thread-local native resources.
use super::control::Control;
use std::{
    sync::{mpsc, Arc, Mutex, Weak},
    thread,
    time::Duration,
};
use tokio::sync::oneshot;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Failure {
    Busy,
    Closed,
    Producer(String),
    Panicked,
    ReplyLost,
}
struct Request<J, R> {
    job: J,
    control: Arc<Control>,
    reply: oneshot::Sender<Result<R, Failure>>,
}
struct State<J, R> {
    senders: Option<Vec<mpsc::SyncSender<Request<J, R>>>>,
    threads: Vec<thread::JoinHandle<()>>,
    next: usize,
    controls: Vec<Weak<Control>>,
}
pub(super) struct Pool<J, R> {
    state: Mutex<State<J, R>>,
    closing: Mutex<()>,
}
impl<J: Send + 'static, R: Send + 'static> Pool<J, R> {
    pub(super) fn start<S: 'static>(
        workers: usize,
        capacity: usize,
        idle: Duration,
        initialize: impl Fn() -> S + Send + Sync + 'static,
        process: impl Fn(&mut S, J) -> Result<R, String> + Send + Sync + 'static,
    ) -> Result<Self, String> {
        Self::start_controlled(workers, capacity, idle, initialize, move |state, job, _| {
            process(state, job)
        })
    }
    pub(super) fn start_controlled<S: 'static>(
        workers: usize,
        capacity: usize,
        idle: Duration,
        initialize: impl Fn() -> S + Send + Sync + 'static,
        process: impl Fn(&mut S, J, &Arc<Control>) -> Result<R, String> + Send + Sync + 'static,
    ) -> Result<Self, String> {
        if workers == 0 {
            return Err("OCR 执行器至少需要一个工作线程".into());
        }
        let initialize = Arc::new(initialize);
        let process = Arc::new(process);
        let mut senders = Vec::new();
        let mut threads = Vec::new();
        for number in 0..workers {
            let (sender, receiver) = mpsc::sync_channel::<Request<J, R>>(capacity);
            let initialize = Arc::clone(&initialize);
            let process = Arc::clone(&process);
            match thread::Builder::new()
                .name(format!("hub-ocr-{number}"))
                .spawn(move || {
                    // S is constructed, used, reset and dropped on this native owner thread.
                    let mut native = None;
                    loop {
                        match receiver.recv_timeout(idle) {
                            Ok(request) => {
                                if let Err(error) = request.control.checkpoint() {
                                    let _ = request.reply.send(Err(Failure::Producer(error)));
                                    continue;
                                }
                                let result =
                                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                        process(
                                            native.get_or_insert_with(|| initialize()),
                                            request.job,
                                            &request.control,
                                        )
                                    }));
                                let result = match result {
                                    Ok(Ok(value)) => Ok(value),
                                    Ok(Err(error)) => {
                                        native = None;
                                        Err(Failure::Producer(error))
                                    }
                                    Err(_) => {
                                        native = None;
                                        Err(Failure::Panicked)
                                    }
                                };
                                // A canceled consumer does not abandon the physical producer.
                                let _ = request.reply.send(result);
                            }
                            Err(mpsc::RecvTimeoutError::Timeout) => native = None,
                            Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        }
                    }
                }) {
                Ok(handle) => {
                    senders.push(sender);
                    threads.push(handle);
                }
                Err(error) => {
                    drop(sender);
                    drop(senders);
                    for handle in threads {
                        let _ = handle.join();
                    }
                    return Err(format!("无法启动 OCR 执行线程：{error}"));
                }
            }
        }
        Ok(Self {
            state: Mutex::new(State {
                senders: Some(senders),
                threads,
                next: 0,
                controls: Vec::new(),
            }),
            closing: Mutex::new(()),
        })
    }
    pub(super) fn submit(
        &self,
        job: J,
        affinity: Option<usize>,
    ) -> Result<oneshot::Receiver<Result<R, Failure>>, Failure> {
        self.submit_controlled(job, affinity, Control::new(Duration::from_secs(240)))
    }
    pub(super) fn submit_controlled(
        &self,
        job: J,
        affinity: Option<usize>,
        control: Arc<Control>,
    ) -> Result<oneshot::Receiver<Result<R, Failure>>, Failure> {
        let (reply, result) = oneshot::channel();
        let mut state = self.state.lock().map_err(|_| Failure::Closed)?;
        let senders = state.senders.as_ref().ok_or(Failure::Closed)?;
        let count = senders.len();
        let number = affinity.unwrap_or(state.next) % count;
        match senders[number].try_send(Request {
            job,
            reply,
            control: Arc::clone(&control),
        }) {
            Ok(()) => {
                state.next = (number + 1) % count;
                state.controls.retain(|control| control.strong_count() > 0);
                state.controls.push(Arc::downgrade(&control));
                Ok(result)
            }
            Err(mpsc::TrySendError::Full(_)) => Err(Failure::Busy),
            Err(mpsc::TrySendError::Disconnected(_)) => Err(Failure::Closed),
        }
    }
    pub(super) fn shutdown(&self) {
        let _closing = self.closing.lock().unwrap_or_else(|e| e.into_inner());
        let handles = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.senders.take(); // stop admission, then drain accepted messages
            for control in state
                .controls
                .drain(..)
                .filter_map(|control| control.upgrade())
            {
                control.cancel();
            }
            std::mem::take(&mut state.threads)
        };
        for handle in handles {
            let _ = handle.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    #[tokio::test]
    async fn bounded_admission_drains_typed_results_and_refuses_after_close() {
        let (started, started_rx) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let release_rx = Mutex::new(release_rx);
        let pool = Arc::new(
            Pool::start(
                1,
                1,
                Duration::from_secs(60),
                || (),
                move |_, job| {
                    if job == 1 {
                        started.send(()).unwrap();
                        release_rx.lock().unwrap().recv().unwrap();
                    }
                    Ok(job)
                },
            )
            .unwrap(),
        );
        let first = pool.submit(1, None).unwrap();
        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let second = pool.submit(2, None).unwrap();
        assert!(matches!(pool.submit(3, None), Err(Failure::Busy)));
        let closing_pool = Arc::clone(&pool);
        let closing = thread::spawn(move || closing_pool.shutdown());
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while !matches!(pool.submit(3, None), Err(Failure::Closed))
            && std::time::Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(2));
        }
        assert!(matches!(pool.submit(3, None), Err(Failure::Closed)));
        release.send(()).unwrap();
        closing.join().unwrap();
        assert_eq!(first.await.unwrap().unwrap(), 1);
        assert!(
            matches!(second.await.unwrap(), Err(Failure::Producer(error)) if error.starts_with("OCR_CANCELLED:"))
        );
        assert!(matches!(pool.submit(4, None), Err(Failure::Closed)));
    }
    #[tokio::test]
    async fn native_state_reuses_then_releases_on_idle_failure_and_panic() {
        struct Native(Arc<AtomicUsize>);
        impl Drop for Native {
            fn drop(&mut self) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }
        let created = Arc::new(AtomicUsize::new(0));
        let released = Arc::new(AtomicUsize::new(0));
        let init_count = Arc::clone(&created);
        let drops = Arc::clone(&released);
        let pool = Pool::start(
            1,
            2,
            Duration::from_millis(30),
            move || {
                init_count.fetch_add(1, Ordering::SeqCst);
                Native(Arc::clone(&drops))
            },
            |_, job| match job {
                0 => Err("injected producer failure".into()),
                9 => panic!("injected native panic"),
                _ => Ok(job),
            },
        )
        .unwrap();
        for job in [1, 2] {
            assert_eq!(pool.submit(job, None).unwrap().await.unwrap().unwrap(), job);
        }
        assert_eq!(created.load(Ordering::SeqCst), 1);
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while released.load(Ordering::SeqCst) == 0 && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(released.load(Ordering::SeqCst), 1);
        assert!(matches!(
            pool.submit(0, None).unwrap().await.unwrap(),
            Err(Failure::Producer(_))
        ));
        assert_eq!(pool.submit(3, None).unwrap().await.unwrap().unwrap(), 3);
        assert!(matches!(
            pool.submit(9, None).unwrap().await.unwrap(),
            Err(Failure::Panicked)
        ));
        assert_eq!(pool.submit(4, None).unwrap().await.unwrap().unwrap(), 4);
        pool.shutdown();
        assert_eq!(
            created.load(Ordering::SeqCst),
            released.load(Ordering::SeqCst)
        );
    }
}
