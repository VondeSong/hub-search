//! Fixed owner threads keep at most one native child each. Cancellation destroys
//! the exact native process, waits for it, then joins its pipe reader.
use super::{
    control::Control,
    worker::{self, Job, Request, Response},
};
use std::io::{BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{atomic::Ordering, mpsc, Arc};
use std::thread::JoinHandle;
use std::time::Duration;
use windows::Win32::{
    Foundation::{CloseHandle, HANDLE},
    System::{JobObjects::*, Threading::*},
};

struct ProcessGroup(HANDLE);
unsafe impl Send for ProcessGroup {}
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}
fn attach(pid: u32) -> Result<ProcessGroup, String> {
    unsafe {
        let group =
            ProcessGroup(CreateJobObjectW(None, None).map_err(|_| "OCR_PROCESS:无法保护识别进程")?);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            group.0,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as _,
            std::mem::size_of_val(&limits) as u32,
        )
        .map_err(|_| "OCR_PROCESS:无法设置识别进程退出保护")?;
        let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid)
            .map_err(|_| "OCR_PROCESS:无法访问识别进程")?;
        let result = AssignProcessToJobObject(group.0, process);
        let _ = CloseHandle(process);
        result.map_err(|_| "OCR_PROCESS:无法登记识别进程所有权")?;
        Ok(group)
    }
}
pub(super) struct Managed {
    child: Child,
    input: Option<ChildStdin>,
    replies: Option<mpsc::Receiver<Result<Response, String>>>,
    reader: Option<JoinHandle<()>>,
    group: Option<ProcessGroup>,
    next: u64,
}
impl Managed {
    pub(super) fn start() -> Result<Self, String> {
        Self::start_with("native")
    }
    fn start_with(mode: &str) -> Result<Self, String> {
        use std::os::windows::process::CommandExt;
        let mut command =
            Command::new(std::env::current_exe().map_err(|_| "OCR_PROCESS:无法定位识别程序")?);
        #[cfg(not(test))]
        {
            let _ = mode;
            command.arg("--internal-ocr-worker");
        }
        #[cfg(test)]
        command
            .args([
                "--exact",
                "ocr::tests::native_subprocess_worker_entry",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("HUB_OCR_TEST_CHILD", mode);
        command
            .creation_flags(0x08000000)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = command
            .spawn()
            .map_err(|_| "OCR_PROCESS:无法启动识别进程")?;
        let group = match attach(child.id()) {
            Ok(group) => group,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let input = child.stdin.take().ok_or("OCR_PROCESS:识别输入通道缺失")?;
        let output = child.stdout.take().ok_or("OCR_PROCESS:识别输出通道缺失")?;
        let (sender, replies) = mpsc::sync_channel(2);
        let reader = match std::thread::Builder::new()
            .name("hub-ocr-pipe".into())
            .spawn(move || {
                let mut output = BufReader::new(output);
                loop {
                    let result = worker::read_frame(&mut output).and_then(|bytes| {
                        let bytes = bytes.ok_or("OCR_PROCESS:识别进程已退出，结果未完成")?;
                        // The test harness emits its own lines; production emits only protocol frames.
                        let Some(start) = bytes
                            .windows(worker::PREFIX.len())
                            .position(|value| value == worker::PREFIX.as_bytes())
                        else {
                            #[cfg(test)]
                            {
                                return Ok(None);
                            }
                            #[cfg(not(test))]
                            {
                                return Err("OCR_PROTOCOL:识别进程返回未知消息".into());
                            }
                        };
                        serde_json::from_slice::<Response>(&bytes[start + worker::PREFIX.len()..])
                            .map(Some)
                            .map_err(|_| "OCR_PROTOCOL:识别进程返回无效消息".into())
                    });
                    match result {
                        Ok(None) => continue,
                        Ok(Some(value)) => {
                            if sender.send(Ok(value)).is_err() {
                                break;
                            }
                        }
                        Err(error) => {
                            let _ = sender.send(Err(error));
                            break;
                        }
                    }
                }
            }) {
            Ok(reader) => reader,
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("OCR_PROCESS:无法启动识别管道读取器".into());
            }
        };
        let mut managed = Self {
            child,
            input: Some(input),
            replies: Some(replies),
            reader: Some(reader),
            group: Some(group),
            next: 0,
        };
        let control = Control::new(Duration::from_secs(15));
        match managed.recv(&control)? {
            Response::Ready { pid } if pid == managed.child.id() => Ok(managed),
            _ => Err("OCR_PROTOCOL:识别进程就绪身份不符".into()),
        }
    }
    fn recv(&mut self, control: &Arc<Control>) -> Result<Response, String> {
        loop {
            control.checkpoint()?;
            match self
                .replies
                .as_ref()
                .ok_or("OCR_PROCESS:识别进程已关闭")?
                .recv_timeout(Duration::from_millis(25))
            {
                Ok(result) => return result,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if let Some(status) = self
                        .child
                        .try_wait()
                        .map_err(|_| "OCR_PROCESS:无法读取识别进程状态")?
                    {
                        return Err(format!("OCR_PROCESS:识别进程异常结束（{status}）"));
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("OCR_PROCESS:识别结果通道已关闭".into())
                }
            }
        }
    }
    pub(super) fn run(
        &mut self,
        job: Job,
        control: &Arc<Control>,
    ) -> Result<(String, usize, usize), String> {
        control.checkpoint()?;
        self.next = self
            .next
            .checked_add(1)
            .ok_or("OCR_PROTOCOL:识别请求序列耗尽")?;
        let id = self.next;
        let mut request = serde_json::to_vec(&Request { id, job })
            .map_err(|_| "OCR_PROTOCOL:无法编码识别请求")?;
        if request.len() + 1 > worker::MAX_FRAME {
            return Err("OCR_PROTOCOL:识别路径请求过大".into());
        }
        request.push(b'\n');
        control.process.store(self.child.id(), Ordering::Release);
        self.input
            .as_mut()
            .ok_or("OCR_PROCESS:识别输入通道已关闭")?
            .write_all(&request)
            .map_err(|_| "OCR_PROCESS:无法传递识别请求")?;
        let mut text = String::new();
        let mut parts = 0;
        let mut started = false;
        loop {
            match self.recv(control)? {
                Response::Started { id: response_id } if response_id == id && !started => {
                    started = true;
                    control.phase.store(1, Ordering::Release);
                }
                Response::Text {
                    id: response_id,
                    part,
                    text: chunk,
                } if response_id == id && started && part == parts => {
                    // Frame size is bounded; the legal OCR text is delivered in full.
                    text.try_reserve(chunk.len())
                        .map_err(|_| "OCR_MEMORY:无法保存识别文字")?;
                    text.push_str(&chunk);
                    parts += 1;
                }
                Response::Complete {
                    id: response_id,
                    bytes,
                    parts: count,
                    engines,
                    pdf_loads,
                } if response_id == id && started && count == parts && bytes == text.len() => {
                    control.checkpoint()?;
                    return Ok((text, engines, pdf_loads));
                }
                Response::Failed {
                    id: response_id,
                    error,
                } if response_id == id && started => return Err(error),
                _ => return Err("OCR_PROTOCOL:识别结果身份、顺序或完整性不符".into()),
            }
        }
    }
    fn stop(&mut self) {
        self.input.take();
        // Closing the private job also covers parent shutdown and descendants.
        self.group.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.replies.take();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}
impl Drop for Managed {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hung_native_process_is_cancelled_reaped_and_next_owner_can_start() {
        let mut child = Managed::start_with("hang").unwrap();
        let pid = child.child.id();
        let control = Control::new(Duration::from_secs(10));
        let observed = Arc::clone(&control);
        let canceller = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            while observed.phase.load(Ordering::Acquire) == 0
                && std::time::Instant::now() < deadline
            {
                std::thread::sleep(Duration::from_millis(2));
            }
            assert_eq!(observed.phase.load(Ordering::Acquire), 1);
            observed.cancel();
        });
        let at = std::time::Instant::now();
        assert!(child
            .run(
                Job::Image {
                    path: "unused-test-input".into()
                },
                &control
            )
            .unwrap_err()
            .starts_with("OCR_CANCELLED:"));
        canceller.join().unwrap();
        child.stop();
        assert!(child.child.try_wait().unwrap().is_some());
        assert!(child.reader.is_none() && child.replies.is_none());
        assert!(
            at.elapsed() < Duration::from_secs(3),
            "an unresponsive producer must not block shutdown"
        );
        let next = Managed::start_with("native").unwrap();
        assert_ne!(next.child.id(), pid);
        drop(next);
    }
    #[test]
    fn hung_native_process_times_out_without_leaving_its_pipe_reader() {
        let mut child = Managed::start_with("hang").unwrap();
        let control = Control::new(Duration::from_millis(150));
        assert!(child
            .run(
                Job::Image {
                    path: "unused-test-input".into()
                },
                &control
            )
            .unwrap_err()
            .starts_with("OCR_TIMEOUT:"));
        child.stop();
        assert!(child.child.try_wait().unwrap().is_some());
        assert!(child.reader.is_none());
    }

    #[test]
    fn chunked_native_text_is_complete_and_wrong_order_never_becomes_success() {
        let mut child = Managed::start_with("chunked").unwrap();
        let control = Control::new(Duration::from_secs(10));
        let (text, _, _) = child
            .run(
                Job::Image {
                    path: "unused-test-input".into(),
                },
                &control,
            )
            .unwrap();
        assert_eq!(text, "OCR 中文 page text\n".repeat(50_000));
        assert!(
            text.len() > worker::MAX_FRAME,
            "whole valid text must not inherit the per-frame limit"
        );
        child.stop();
        assert!(child.child.try_wait().unwrap().is_some());
        let mut faulty = Managed::start_with("out-of-order").unwrap();
        assert!(faulty
            .run(
                Job::Image {
                    path: "unused-test-input".into()
                },
                &Control::new(Duration::from_secs(10))
            )
            .unwrap_err()
            .starts_with("OCR_PROTOCOL:"));
        faulty.stop();
        assert!(faulty.child.try_wait().unwrap().is_some());
    }

    #[test]
    fn pool_shutdown_cancels_running_and_queued_native_work_and_joins_the_child() {
        use super::super::pool::{Failure, Pool};
        let pool = Pool::start_controlled(
            1,
            1,
            Duration::from_secs(60),
            || Managed::start_with("hang").unwrap(),
            |child, job, control| child.run(job, control).map(|(text, _, _)| text),
        )
        .unwrap();
        let active = Control::new(Duration::from_secs(240));
        let first = pool
            .submit_controlled(
                Job::Image {
                    path: "unused-test-input".into(),
                },
                None,
                Arc::clone(&active),
            )
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while active.phase.load(Ordering::Acquire) == 0 && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(active.phase.load(Ordering::Acquire), 1);
        let queued = Control::new(Duration::from_secs(240));
        let second = pool
            .submit_controlled(
                Job::Image {
                    path: "unused-test-input".into(),
                },
                None,
                Arc::clone(&queued),
            )
            .unwrap();
        let pid = active.process.load(Ordering::Acquire);
        assert!(pid > 0);
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).unwrap() };
        let at = std::time::Instant::now();
        pool.shutdown();
        assert!(at.elapsed() < Duration::from_secs(3));
        for reply in [first, second] {
            assert!(
                matches!(reply.blocking_recv().unwrap(), Err(Failure::Producer(error)) if error.starts_with("OCR_CANCELLED:"))
            );
        }
        assert_eq!(queued.phase.load(Ordering::Acquire), 0);
        // An owned process handle reports termination even if PID numbers recycle.
        unsafe {
            let mut code = 0;
            GetExitCodeProcess(handle, &mut code).unwrap();
            let _ = CloseHandle(handle);
            assert_ne!(code, 259);
        }
    }
}
