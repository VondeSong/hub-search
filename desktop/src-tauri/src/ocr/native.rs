use super::pool::{Failure, Pool};
use super::{
    control::{CancelOnDrop, Control},
    process::Managed,
    worker,
};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};

pub(super) enum Job {
    Image(PathBuf),
    Pdf {
        path: PathBuf,
        hash: Option<String>,
        page: u32,
    },
}
#[derive(Default)]
struct Native {
    process: Option<Managed>,
}
#[cfg(test)]
static ENGINES: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
#[cfg(test)]
static PDF_LOADS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
impl Native {
    fn run(&mut self, job: Job, control: &Arc<Control>) -> Result<String, String> {
        control.checkpoint()?;
        if self.process.is_none() {
            self.process = Some(Managed::start()?);
        }
        let job = match job {
            Job::Image(path) => worker::Job::Image { path },
            Job::Pdf { path, hash, page } => worker::Job::Pdf { path, hash, page },
        };
        let (text, engines, loads) = self
            .process
            .as_mut()
            .ok_or("OCR_PROCESS:识别进程不可用")?
            .run(job, control)?;
        #[cfg(test)]
        {
            ENGINES.fetch_add(engines, Ordering::SeqCst);
            PDF_LOADS.fetch_add(loads, Ordering::SeqCst);
        }
        #[cfg(not(test))]
        let _ = (engines, loads);
        Ok(text)
    }
}
static POOL: OnceLock<Result<Pool<Job, String>, String>> = OnceLock::new();
static INIT: Mutex<()> = Mutex::new(());
static CLOSED: AtomicBool = AtomicBool::new(false);
fn pool() -> Result<&'static Pool<Job, String>, String> {
    let _init = INIT
        .lock()
        .map_err(|_| "OCR_POOL_CLOSED:OCR 执行器不可用")?;
    if CLOSED.load(Ordering::Acquire) {
        return Err("OCR_POOL_CLOSED:应用正在退出".into());
    }
    POOL.get_or_init(|| {
        Pool::start_controlled(2, 2, Duration::from_secs(60), Native::default, Native::run)
    })
    .as_ref()
    .map_err(Clone::clone)
}
fn affinity(job: &Job) -> Option<usize> {
    match job {
        Job::Pdf {
            hash: Some(hash), ..
        } => hash.as_bytes().first().map(|v| usize::from(*v)),
        _ => None,
    }
}
fn failure(error: Failure) -> String {
    match error {
        Failure::Busy => "OCR_POOL_BUSY:OCR 执行队列已满，请稍后重试".into(),
        Failure::Closed => "OCR_POOL_CLOSED:应用正在退出".into(),
        Failure::Producer(error) => error,
        Failure::Panicked => "OCR 原生生产者异常退出；本次识别失败".into(),
        Failure::ReplyLost => "OCR 执行结果通道中断；本次识别失败".into(),
    }
}
pub(super) async fn execute(job: Job) -> Result<String, String> {
    let lane = affinity(&job);
    let control = Control::new(Duration::from_secs(240));
    let _cancel = CancelOnDrop(Arc::clone(&control));
    let result = pool()?
        .submit_controlled(job, lane, control)
        .map_err(failure)?;
    result
        .await
        .map_err(|_| failure(Failure::ReplyLost))?
        .map_err(failure)
}
pub(super) async fn execute_controlled(
    job: Job,
    operation: &crate::library_runtime::Operation,
) -> Result<String, String> {
    operation.checkpoint()?;
    let control = Control::new(Duration::from_secs(240));
    let _cancel = CancelOnDrop(Arc::clone(&control));
    let lane = affinity(&job);
    let mut result = pool()?
        .submit_controlled(job, lane, Arc::clone(&control))
        .map_err(failure)?;
    let mut stopped = None;
    loop {
        tokio::select! {
            reply = &mut result => {
                if let Some(error) = stopped { return Err(error); }
                operation.checkpoint()?;
                return reply.map_err(|_| failure(Failure::ReplyLost))?.map_err(failure);
            }
            _ = tokio::time::sleep(Duration::from_millis(25)), if stopped.is_none() => {
                if let Err(error) = operation.checkpoint() { stopped = Some(error); control.cancel(); }
            }
        }
    }
}
pub(super) fn execute_blocking(job: Job) -> Result<String, String> {
    let lane = affinity(&job);
    pool()?
        .submit(job, lane)
        .map_err(failure)?
        .blocking_recv()
        .map_err(|_| failure(Failure::ReplyLost))?
        .map_err(failure)
}
pub(super) fn shutdown() {
    let _init = INIT.lock().unwrap_or_else(|e| e.into_inner());
    CLOSED.store(true, Ordering::Release);
    if let Some(Ok(pool)) = POOL.get() {
        pool.shutdown();
    }
}

#[cfg(test)]
pub(super) fn counters() -> (usize, usize) {
    (
        ENGINES.load(Ordering::SeqCst),
        PDF_LOADS.load(Ordering::SeqCst),
    )
}
