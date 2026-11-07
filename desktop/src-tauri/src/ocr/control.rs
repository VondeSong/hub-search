//! Request ownership crosses the queue, caller, native process and shutdown.
use std::sync::{
    atomic::{AtomicBool, AtomicU32, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

pub(super) struct Control {
    cancelled: AtomicBool,
    deadline: Instant,
    pub(super) process: AtomicU32,
    pub(super) phase: AtomicU32,
}
impl Control {
    pub(super) fn new(timeout: Duration) -> Arc<Self> {
        Arc::new(Self {
            cancelled: AtomicBool::new(false),
            deadline: Instant::now() + timeout,
            process: AtomicU32::new(0),
            phase: AtomicU32::new(0),
        })
    }
    pub(super) fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }
    pub(super) fn checkpoint(&self) -> Result<(), String> {
        if self.cancelled.load(Ordering::Acquire) {
            Err("OCR_CANCELLED:识别已停止".into())
        } else if Instant::now() >= self.deadline {
            Err("OCR_TIMEOUT:本页识别超时，请重试或检查来源文件".into())
        } else {
            Ok(())
        }
    }
}
pub(super) struct CancelOnDrop(pub(super) Arc<Control>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}
