//! Private anonymous-pipe protocol; this entry never creates a Tauri application.
use super::*;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, Read, Write};
use std::path::PathBuf;

pub(super) const PREFIX: &str = "HUB_OCR/1 ";
pub(super) const MAX_FRAME: usize = 512 * 1024;
const TEXT_CHUNK: usize = 64 * 1024;
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(super) enum Job {
    Image {
        path: PathBuf,
    },
    Pdf {
        path: PathBuf,
        hash: Option<String>,
        page: u32,
    },
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Request {
    pub(super) id: u64,
    pub(super) job: Job,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(super) enum Response {
    Ready {
        pid: u32,
    },
    Started {
        id: u64,
    },
    Text {
        id: u64,
        part: u64,
        text: String,
    },
    Complete {
        id: u64,
        bytes: usize,
        parts: u64,
        engines: usize,
        pdf_loads: usize,
    },
    Failed {
        id: u64,
        error: String,
    },
}
pub(super) fn read_frame(reader: &mut impl BufRead) -> Result<Option<Vec<u8>>, String> {
    let mut bytes = Vec::new();
    let count = reader
        .take((MAX_FRAME + 1) as u64)
        .read_until(b'\n', &mut bytes)
        .map_err(|_| "OCR_PROTOCOL:无法读取识别进程消息")?;
    if count == 0 {
        return Ok(None);
    }
    if count > MAX_FRAME || !bytes.ends_with(b"\n") {
        return Err("OCR_PROTOCOL:识别进程消息超过单帧上限或未完整送达".into());
    }
    Ok(Some(bytes))
}
pub(super) fn send(response: &Response) -> Result<(), String> {
    let json = serde_json::to_vec(response).map_err(|_| "OCR_PROTOCOL:无法编码识别进程消息")?;
    if json.len() + PREFIX.len() + 1 > MAX_FRAME {
        return Err("OCR_PROTOCOL:识别进程消息过大".into());
    }
    let mut stdout = std::io::stdout().lock();
    stdout
        .write_all(PREFIX.as_bytes())
        .and_then(|_| stdout.write_all(&json))
        .and_then(|_| stdout.write_all(b"\n"))
        .and_then(|_| stdout.flush())
        .map_err(|_| "OCR_PROTOCOL:无法发送识别进程消息".into())
}
#[derive(Default)]
struct Native {
    engine: Option<OcrEngine>,
    document: Option<(String, PathBuf, PdfDocument)>,
    engines: usize,
    pdf_loads: usize,
}
impl Native {
    fn run(&mut self, job: Job) -> Result<String, String> {
        if self.engine.is_none() {
            self.engine = Some(ocr_engine()?);
            self.engines += 1;
        }
        let engine = self.engine.as_ref().ok_or("Windows OCR 不可用")?;
        match job {
            Job::Image { path } => recognize_image_with(engine, &path),
            Job::Pdf { path, hash, page } => {
                let document = if let Some(hash) = hash {
                    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
                        return Err("PDF 内容身份无效".into());
                    }
                    if self
                        .document
                        .as_ref()
                        .is_none_or(|(old, old_path, _)| old != &hash || old_path != &path)
                    {
                        self.document = None;
                        self.document = Some((hash, path.clone(), self.load_pdf(&path)?));
                    }
                    self.document.as_ref().ok_or("PDF 会话不可用")?.2.clone()
                } else {
                    self.document = None;
                    self.load_pdf(&path)?
                };
                recognize_pdf_document(engine, &document, page)
            }
        }
    }
    fn load_pdf(&self, path: &Path) -> Result<PdfDocument, String> {
        let file = storage_file(path)?;
        PdfDocument::LoadFromFileAsync(&file)
            .map_err(|e| windows_error("无法打开扫描型 PDF", e))?
            .get()
            .map_err(|e| windows_error("无法读取扫描型 PDF", e))
    }
}
pub(super) fn run_stdio() -> Result<(), String> {
    let mut input = std::io::stdin().lock();
    send(&Response::Ready {
        pid: std::process::id(),
    })?;
    let mut native = Native::default();
    let mut last_id = 0;
    while let Some(bytes) = read_frame(&mut input)? {
        let request: Request =
            serde_json::from_slice(&bytes).map_err(|_| "OCR_PROTOCOL:识别请求无效")?;
        if request.id <= last_id {
            return Err("OCR_PROTOCOL:识别请求身份重复或倒序".into());
        }
        last_id = request.id;
        send(&Response::Started { id: request.id })?;
        let previous = (native.engines, native.pdf_loads);
        let is_pdf = matches!(request.job, Job::Pdf { .. });
        let cached = native
            .document
            .as_ref()
            .map(|(hash, path, _)| (hash.clone(), path.clone()));
        let was_cached = match &request.job {
            Job::Pdf {
                path,
                hash: Some(hash),
                ..
            } => cached
                .as_ref()
                .is_some_and(|(old, old_path)| old == hash && old_path == path),
            _ => false,
        };
        match native.run(request.job) {
            Ok(text) => {
                if is_pdf && !was_cached {
                    native.pdf_loads += 1;
                }
                let mut rest = text.as_str();
                let mut part = 0;
                while !rest.is_empty() {
                    let mut end = rest.len().min(TEXT_CHUNK);
                    while !rest.is_char_boundary(end) {
                        end -= 1;
                    }
                    send(&Response::Text {
                        id: request.id,
                        part,
                        text: rest[..end].into(),
                    })?;
                    rest = &rest[end..];
                    part += 1;
                }
                send(&Response::Complete {
                    id: request.id,
                    bytes: text.len(),
                    parts: part,
                    engines: native.engines - previous.0,
                    pdf_loads: native.pdf_loads - previous.1,
                })?;
            }
            Err(error) => {
                // Failed WinRT state is never reused, including its immutable PDF session.
                native = Native::default();
                send(&Response::Failed {
                    id: request.id,
                    error,
                })?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
pub(super) fn run_test_entry() {
    match std::env::var("HUB_OCR_TEST_CHILD").as_deref() {
        Ok("native") => run_stdio().unwrap(),
        Ok("hang") => {
            send(&Response::Ready {
                pid: std::process::id(),
            })
            .unwrap();
            let bytes = read_frame(&mut std::io::stdin().lock()).unwrap().unwrap();
            let request: Request = serde_json::from_slice(&bytes).unwrap();
            send(&Response::Started { id: request.id }).unwrap();
            // Represents a native call that ignores cooperative cancellation.
            loop {
                std::thread::park();
            }
        }
        Ok("chunked") | Ok("out-of-order") => {
            send(&Response::Ready {
                pid: std::process::id(),
            })
            .unwrap();
            let bytes = read_frame(&mut std::io::stdin().lock()).unwrap().unwrap();
            let request: Request = serde_json::from_slice(&bytes).unwrap();
            send(&Response::Started { id: request.id }).unwrap();
            if std::env::var("HUB_OCR_TEST_CHILD").as_deref() == Ok("out-of-order") {
                send(&Response::Text {
                    id: request.id,
                    part: 1,
                    text: "wrong order".into(),
                })
                .unwrap();
            } else {
                let text = "OCR 中文 page text\n".repeat(50_000);
                let mut rest = text.as_str();
                let mut part = 0;
                while !rest.is_empty() {
                    let mut end = rest.len().min(TEXT_CHUNK);
                    while !rest.is_char_boundary(end) {
                        end -= 1;
                    }
                    send(&Response::Text {
                        id: request.id,
                        part,
                        text: rest[..end].into(),
                    })
                    .unwrap();
                    part += 1;
                    rest = &rest[end..];
                }
                send(&Response::Complete {
                    id: request.id,
                    bytes: text.len(),
                    parts: part,
                    engines: 0,
                    pdf_loads: 0,
                })
                .unwrap();
            }
        }
        _ => {}
    }
}
