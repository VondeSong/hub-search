//! Runs in a GUI process: a console-subsystem test cannot reproduce this bug.
//! Only synthetic Unicode and input are used; this does not log in to Telegram.
#![windows_subsystem = "windows"]

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde_json::json;
use std::{
    fs,
    io::{Read, Write},
    path::PathBuf,
    process::Command,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

// Reuse the production UTF-8 bootstrap and private process-group cleanup.
#[path = "../../../src/telegram/tdl/console.rs"]
mod console;

fn random_url_safe(_: usize) -> String {
    format!(
        "{:x}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    )
}
struct WorkDirectory(PathBuf);
impl Drop for WorkDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn run() -> Result<serde_json::Value, String> {
    let root = std::env::temp_dir().join(format!("hub-tdl-gui-test-{}", random_url_safe(8)));
    fs::create_dir(&root).map_err(|_| "fixture directory")?;
    let _cleanup = WorkDirectory(root.clone());
    let script = root.join("synthetic.ps1");
    let body = r#"$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::WriteLine('TERMINAL_READY▀▄█中文')
$line=[Console]::ReadLine()
if($line -ceq '输入🟦'){[Console]::WriteLine('INPUT_OK');exit 0}
exit 3
"#;
    let mut script_bytes = vec![0xEF, 0xBB, 0xBF]; // Windows PowerShell script encoding.
    script_bytes.extend_from_slice(body.as_bytes());
    fs::write(&script, script_bytes).map_err(|_| "fixture script")?;
    let mut direct = Command::new("powershell.exe");
    direct
        .current_dir(&root)
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(script);
    let (command, bootstrap, gate) = console::prepare(&direct)?;
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 80,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|_| "create GUI terminal")?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|_| "terminal reader")?;
    let mut writer = pair.master.take_writer().map_err(|_| "terminal writer")?;
    let mut builder = CommandBuilder::new(command.get_program());
    builder.args(command.get_args());
    builder.cwd(command.get_current_dir().unwrap());
    let mut child = pair
        .slave
        .spawn_command(builder)
        .map_err(|_| "fixture child")?;
    drop(pair.slave);
    let job = console::attach(child.process_id().ok_or("fixture pid")?)?;
    fs::write(gate, "start").map_err(|_| "fixture gate")?;
    let (tx, rx) = std::sync::mpsc::channel();
    let reading = std::thread::spawn(move || {
        let mut buffer = [0u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(buffer[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let start = Instant::now();
    let mut output = Vec::new();
    let mut sent = false;
    let mut child_success = false;
    while start.elapsed() < Duration::from_secs(10) {
        while let Ok(data) = rx.try_recv() {
            output.extend_from_slice(&data);
        }
        if !sent && String::from_utf8_lossy(&output).contains("TERMINAL_READY") {
            sent = writer
                .write_all("输入🟦\r".as_bytes())
                .and_then(|_| writer.flush())
                .is_ok();
        }
        if let Some(status) = child.try_wait().map_err(|_| "fixture wait")? {
            child_success = status.success();
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = child.kill();
    let _ = child.wait();
    drop(writer);
    drop(job);
    // The reader must remain active while ClosePseudoConsole drains output.
    drop(pair.master);
    reading.join().map_err(|_| "fixture reader join")?;
    while let Ok(data) = rx.try_recv() {
        output.extend_from_slice(&data);
    }
    drop(bootstrap);
    let text = String::from_utf8_lossy(&output);
    Ok(json!({
        "ready": text.contains("TERMINAL_READY"),
        "unicodeOutput": text.contains("▀▄█中文"),
        "inputAccepted": text.contains("INPUT_OK"),
        "childSuccess": child_success,
        "closed": true,
    }))
}

fn main() {
    let output = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .expect("result path");
    let result = run().unwrap_or_else(|error| json!({"error": error, "closed": false}));
    fs::write(output, serde_json::to_vec(&result).unwrap()).expect("result file");
}
