//! Transient login transport for the pinned tdl terminal protocol. No terminal text,
//! QR modules or password are written to settings, collection events or logs.
use super::*;
use std::io::Write;
use std::sync::atomic::AtomicU64;

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LoginView {
    session_id: u64,
    active: bool,
    qr: Vec<String>,
    qr_at: i64,
    needs_password: bool,
    status: String,
}
struct Login {
    view: LoginView,
    writer: Option<Box<dyn Write + Send>>,
}
static LOGIN: std::sync::LazyLock<Mutex<Login>> = std::sync::LazyLock::new(|| {
    Mutex::new(Login {
        view: LoginView::default(),
        writer: None,
    })
});
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

pub(super) fn is_active(id: u64) -> bool {
    LOGIN
        .lock()
        .map(|s| s.view.active && s.view.session_id == id)
        .unwrap_or(false)
}
#[tauri::command]
pub(crate) fn get_telegram_tdl_login() -> LoginView {
    let mut view = LOGIN.lock().map(|s| s.view.clone()).unwrap_or_default();
    // The upstream protocol does not expose the server expiry timestamp. Hide the
    // image conservatively while waiting for the next upstream token, never extend it.
    if now_ms() - view.qr_at >= 25_000 {
        view.qr.clear();
    }
    view
}
#[tauri::command]
pub(crate) fn submit_telegram_tdl_password(
    session_id: u64,
    password: String,
) -> Result<(), String> {
    let mut secret = password.into_bytes();
    let result = (|| {
        if secret.is_empty() || secret.len() > 512 || secret.iter().any(|b| *b < 32 || *b == 127) {
            return Err("请输入有效的 Telegram 两步验证密码".into());
        }
        let mut login = LOGIN.lock().map_err(|_| "登录暂时不可用")?;
        if !login.view.active || login.view.session_id != session_id || !login.view.needs_password {
            return Err("本次密码输入已失效，请重新登录".into());
        }
        let writer = login.writer.as_mut().ok_or("登录已结束")?;
        writer
            .write_all(&secret)
            .and_then(|_| writer.write_all(b"\r"))
            .and_then(|_| writer.flush())
            .map_err(|_| "无法发送两步验证密码，请重新登录")?;
        login.view.needs_password = false;
        login.view.status = "正在验证 Telegram 账号…".into();
        Ok(())
    })();
    secret.fill(0);
    result
}
fn complete(id: u64, status: &str) {
    if let Ok(mut login) = LOGIN.lock() {
        if login.view.session_id == id {
            login.writer = None;
            login.view.active = false;
            login.view.qr.clear();
            login.view.needs_password = false;
            login.view.status = status.into();
        }
    }
}
fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn cursor_requested(bytes: &[u8], tail: &mut Vec<u8>) -> bool {
    tail.extend_from_slice(bytes);
    let requested = tail.windows(4).any(|v| v == b"\x1b[6n");
    if tail.len() > 3 {
        tail.drain(..tail.len() - 3);
    }
    requested
}

fn qr_wait_error(elapsed: Duration, received_login_prompt: bool) -> Option<&'static str> {
    (!received_login_prompt && elapsed >= Duration::from_secs(45))
        .then_some("45 秒内未取得二维码，请检查网络或当前代理，重新获取二维码，也可改用验证码登录")
}

// ToSmallString(false) emits inverted half-blocks: spaces encode two black
// modules, and solid blocks encode two white modules. Restore square modules,
// with the original four-module quiet zone and all three finder patterns.
fn qr_from_screen(screen: &vt100::Screen) -> Option<Vec<String>> {
    let (height, width) = screen.size();
    let cell = |r, c| screen.cell(r, c).map(|v| v.contents()).unwrap_or_default();
    for top in 0..height {
        for left in 0..width {
            if cell(top, left) != "█" || left > 0 && cell(top, left - 1) == "█" {
                continue;
            }
            let n = (left..width).take_while(|c| cell(top, *c) == "█").count();
            if !(29..=85).contains(&n)
                || (n - 29) % 4 != 0
                || top as usize + n.div_ceil(2) > height as usize
            {
                continue;
            }
            let mut matrix = vec![vec![false; n]; n];
            let mut valid = true;
            for y in 0..n.div_ceil(2) {
                for x in 0..n {
                    let bits = match cell(top + y as u16, left + x as u16).as_str() {
                        "" | " " => (true, true),
                        "█" => (false, false),
                        "▄" => (true, false),
                        "▀" => (false, true),
                        _ => {
                            valid = false;
                            (false, false)
                        }
                    };
                    matrix[y * 2][x] = bits.0;
                    if y * 2 + 1 < n {
                        matrix[y * 2 + 1][x] = bits.1;
                    }
                }
            }
            if !valid || !valid_qr_border(&matrix) {
                continue;
            }
            return Some(
                matrix
                    .iter()
                    .map(|r| r.iter().map(|v| if *v { '1' } else { '0' }).collect())
                    .collect(),
            );
        }
    }
    None
}
fn valid_qr_border(m: &[Vec<bool>]) -> bool {
    let n = m.len();
    if m.iter().enumerate().any(|(y, row)| {
        row.iter()
            .enumerate()
            .any(|(x, v)| (x < 4 || y < 4 || x >= n - 4 || y >= n - 4) && *v)
    }) {
        return false;
    }
    [(4, 4), (n - 11, 4), (4, n - 11)].iter().all(|(x, y)| {
        (0..7).all(|dy| {
            (0..7).all(|dx| {
                let expected = dx == 0
                    || dx == 6
                    || dy == 0
                    || dy == 6
                    || (2..=4).contains(&dx) && (2..=4).contains(&dy);
                m[y + dy][x + dx] == expected
            })
        })
    })
}
fn valid_login_qr(qr: &[String]) -> bool {
    use base64::Engine as _;
    let n = qr.len();
    let side = n * 4;
    let mut pixels = vec![255u8; side * side];
    for (y, row) in qr.iter().enumerate() {
        for (x, bit) in row.bytes().enumerate() {
            if bit == b'1' {
                for dy in 0..4 {
                    for dx in 0..4 {
                        pixels[(y * 4 + dy) * side + x * 4 + dx] = 0;
                    }
                }
            }
        }
    }
    let mut decoder = quircs::Quirc::default();
    decoder.identify(side, side, &pixels).any(|code| {
        let Ok(code) = code else {
            return false;
        };
        let Ok(decoded) = code.decode() else {
            return false;
        };
        let Ok(payload) = std::str::from_utf8(&decoded.payload) else {
            return false;
        };
        let Some(token) = payload.strip_prefix("tg://login?token=") else {
            return false;
        };
        // gotd v0.140.0 Token.URL() uses padded URL-safe base64. Accept the
        // protocol's padded and unpadded forms, not arbitrary query contents.
        (20..=512).contains(&token.len())
            && base64::engine::general_purpose::URL_SAFE
                .decode(token)
                .or_else(|_| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(token))
                .is_ok_and(|bytes| !bytes.is_empty())
    })
}
fn failure(screen: &vt100::Screen) -> &'static str {
    // Only stable error codes/known categories leave this boundary; never expose
    // arbitrary stdout, account identity, terminal echoes or auth URLs.
    let text = screen.contents();
    if text.contains("PASSWORD_HASH_INVALID") {
        "两步验证密码不正确，请重新登录"
    } else if text.contains("AUTH_TOKEN_EXPIRED") || text.contains("AUTH_TOKEN_INVALID") {
        "二维码已失效，请重新获取并扫描最新二维码"
    } else if text.contains("FLOOD_WAIT") {
        "Telegram 暂时限制登录次数，请稍后重试"
    } else if text.contains("proxy")
        || text.contains("dial tcp")
        || text.contains("timeout")
        || text.contains("deadline exceeded")
    {
        "Telegram 连接失败，请检查网络或 tdl 代理后重试"
    } else {
        "扫码登录未完成，请重新获取二维码，或改用验证码登录"
    }
}

#[cfg(windows)]
struct NativeLogin {
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    reader: Box<dyn std::io::Read + Send>,
    writer: Box<dyn Write + Send>,
    job: super::console::Job,
    bootstrap: WorkDirectory,
}
#[cfg(windows)]
fn spawn_login(command: &Command) -> Result<NativeLogin, String> {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    let (command, bootstrap, gate) = super::console::prepare(command)?;
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 80,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|_| "无法创建扫码登录，请使用 Windows 10 1809 或更高版本，或选择验证码登录")?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|_| "无法读取登录界面")?;
    let writer = pair.master.take_writer().map_err(|_| "无法准备登录输入")?;
    // Reuse the sole tdl path/argument/cwd producer, never create a shell command.
    let mut builder = CommandBuilder::new(command.get_program());
    builder.args(command.get_args());
    if let Some(cwd) = command.get_current_dir() {
        builder.cwd(cwd);
    }
    for (key, value) in command.get_envs() {
        if let Some(value) = value {
            builder.env(key, value);
        } else {
            builder.env_remove(key);
        }
    }
    let mut child = pair
        .slave
        .spawn_command(builder)
        .map_err(|_| "无法启动扫码登录，请检查 tdl 安装")?;
    drop(pair.slave);
    let job = match child
        .process_id()
        .ok_or("登录进程未启动")
        .and_then(|pid| super::console::attach(pid).map_err(|_| "无法保护登录进程"))
    {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error.into());
        }
    };
    fs::write(gate, "start").map_err(|_| "无法启动登录")?;
    Ok(NativeLogin {
        master: pair.master,
        child,
        reader,
        writer,
        job,
        bootstrap,
    })
}
#[cfg(windows)]
pub(super) fn launch(
    app: AppHandle,
    cfg: Inbox,
    command: Command,
    guard: tokio::sync::MutexGuard<'static, ()>,
) -> Result<String, String> {
    use std::io::Read;
    let NativeLogin {
        master,
        mut child,
        mut reader,
        writer,
        job,
        bootstrap,
    } = spawn_login(&command)?;
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    {
        let mut login = LOGIN.lock().map_err(|_| "无法打开扫码登录")?;
        *login = Login {
            view: LoginView {
                session_id: id,
                active: true,
                status: "正在连接 Telegram，获取二维码…".into(),
                ..Default::default()
            },
            writer: Some(writer),
        };
    }
    CANCEL.store(false, Ordering::Relaxed);
    progress("qrlogin", "请在 Hub 中扫描最新二维码", true);
    let (sender, receiver) = std::sync::mpsc::channel();
    let reading = std::thread::spawn(move || {
        let mut bytes = [0u8; 4096];
        loop {
            match reader.read(&mut bytes) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if sender.send(bytes[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    tauri::async_runtime::spawn(async move {
        let _guard = guard;
        let mut parser = vt100::Parser::new(80, 120, 0);
        let start = std::time::Instant::now();
        let mut last_data = std::time::Instant::now();
        let mut dirty = false;
        let mut prompted = false;
        let mut received_login_prompt = false;
        let mut total_bytes = 0usize;
        let mut query_tail = Vec::new();
        let result: Result<String, String> = loop {
            while let Ok(bytes) = receiver.try_recv() {
                total_bytes += bytes.len();
                parser.process(&bytes);
                // survey queries cursor position for interactive prompts. Answer
                // through the same private PTY input channel.
                if cursor_requested(&bytes, &mut query_tail) {
                    let (row, col) = parser.screen().cursor_position();
                    if let Ok(mut login) = LOGIN.lock() {
                        if login.view.session_id == id {
                            if let Some(writer) = login.writer.as_mut() {
                                let _ = write!(writer, "\x1b[{};{}R", row + 1, col + 1);
                                let _ = writer.flush();
                            }
                        }
                    }
                }
                last_data = std::time::Instant::now();
                dirty = true;
            }
            if dirty && last_data.elapsed() >= Duration::from_millis(150) {
                let screen = parser.screen();
                let needs_password = screen.contents().contains("Enter 2FA Password:");
                if let Ok(mut login) = LOGIN.lock() {
                    if login.view.session_id == id && login.view.active {
                        if needs_password {
                            received_login_prompt = true;
                            login.view.qr.clear();
                            if !prompted {
                                login.view.needs_password = true;
                                login.view.status = "需要 Telegram 两步验证密码".into();
                            }
                        } else if let Some(qr) =
                            qr_from_screen(screen).filter(|qr| valid_login_qr(qr))
                        {
                            received_login_prompt = true;
                            if login.view.qr != qr {
                                login.view.qr = qr;
                                login.view.qr_at = now_ms();
                                login.view.status = "请用手机 Telegram 扫描二维码".into();
                            }
                        } else {
                            login.view.qr.clear();
                        }
                    }
                }
                prompted = needs_password;
                dirty = false;
            }
            if CANCEL.load(Ordering::Relaxed)
                || start.elapsed() > Duration::from_secs(300)
                || total_bytes > 1_048_576
            {
                let _ = child.kill();
                let _ = child.wait();
                break Err(if CANCEL.load(Ordering::Relaxed) {
                    "Telegram 登录已取消"
                } else {
                    "登录等待超时，请检查网络或代理后重新登录"
                }
                .into());
            }
            if let Some(error) = qr_wait_error(start.elapsed(), received_login_prompt) {
                let _ = child.kill();
                let _ = child.wait();
                break Err(error.into());
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    // Drain final ConPTY output before interpreting known failures.
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    while let Ok(bytes) = receiver.try_recv() {
                        parser.process(&bytes);
                    }
                    break if status.success() {
                        Ok("Telegram 登录完成，正在核对账号…".into())
                    } else {
                        Err(failure(parser.screen()).into())
                    };
                }
                Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break Err("无法读取 Telegram 登录结果，请重试".into());
                }
                Ok(None) => {}
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        };
        complete(
            id,
            result.as_ref().map(String::as_str).unwrap_or_else(|e| e),
        );
        // Close pseudoconsole while the reader is still draining its output.
        drop(job);
        drop(master);
        drop(receiver);
        let _ = tauri::async_runtime::spawn_blocking(move || reading.join()).await;
        drop(bootstrap);
        let result = match result {
            Ok(_) => sync_inner(&app, &cfg, false).await,
            Err(error) => Err(error),
        };
        complete(
            id,
            result.as_ref().map(String::as_str).unwrap_or_else(|e| e),
        );
        finish(&app, &result);
        drop(_guard);
        queue_export(&app, true);
    });
    Ok("已在 Hub 中打开 Telegram 扫码登录".into())
}
#[cfg(not(windows))]
pub(super) fn launch(
    _app: AppHandle,
    _cfg: Inbox,
    _command: Command,
    _guard: tokio::sync::MutexGuard<'static, ()>,
) -> Result<String, String> {
    Err("请在 Windows 版 Hub 中登录 tdl".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn encoded_fixture(payload: &str) -> Vec<Vec<bool>> {
        let code =
            qrcode::QrCode::with_error_correction_level(payload.as_bytes(), qrcode::EcLevel::M)
                .unwrap();
        let size = code.width();
        let mut matrix = vec![vec![false; size + 8]; size + 8];
        for y in 0..size {
            for x in 0..size {
                matrix[y + 4][x + 4] = code[(x, y)] == qrcode::Color::Dark;
            }
        }
        matrix
    }
    fn fixture(n: usize) -> Vec<Vec<bool>> {
        let mut m = vec![vec![false; n]; n];
        for (x, y) in [(4, 4), (n - 11, 4), (4, n - 11)] {
            for dy in 0..7 {
                for dx in 0..7 {
                    m[y + dy][x + dx] = dx == 0
                        || dx == 6
                        || dy == 0
                        || dy == 6
                        || (2..=4).contains(&dx) && (2..=4).contains(&dy);
                }
            }
        }
        m[12][13] = true;
        m[13][13] = true;
        m[15][16] = true;
        m
    }
    fn small(m: &[Vec<bool>]) -> String {
        let n = m.len();
        let mut s = String::new();
        for y in (0..n).step_by(2) {
            for x in 0..n {
                s.push(
                    match (m[y][x], if y + 1 < n { m[y + 1][x] } else { true }) {
                        (true, true) => ' ',
                        (false, false) => '█',
                        (true, false) => '▄',
                        (false, true) => '▀',
                    },
                );
            }
            s.push_str("\r\n");
        }
        s
    }
    #[test]
    fn pinned_qr_half_blocks_reconstruct_square_modules_across_utf8_chunks() {
        let matrix = fixture(41);
        let mut parser = vt100::Parser::new(80, 120, 0);
        let data = format!(
            "Scan QR code with your Telegram app...\r\n{}\x1b[21A",
            small(&matrix)
        );
        for byte in data.as_bytes() {
            parser.process(&[*byte]);
        }
        let decoded = qr_from_screen(parser.screen()).unwrap();
        assert_eq!(
            decoded,
            matrix
                .iter()
                .map(|row| row
                    .iter()
                    .map(|v| if *v { '1' } else { '0' })
                    .collect::<String>())
                .collect::<Vec<_>>()
        );
        let changed = fixture(45);
        parser.process(b"\x1b[2J\x1b[H");
        parser.process(small(&changed).as_bytes());
        assert_eq!(qr_from_screen(parser.screen()).unwrap().len(), 45);
        parser.process(b"\x1b[2J\x1b[H? Enter 2FA Password: ");
        assert!(qr_from_screen(parser.screen()).is_none());
    }
    #[test]
    fn partial_qr_and_arbitrary_terminal_text_are_not_published() {
        let mut m = fixture(41);
        m[0][5] = true;
        let mut parser = vt100::Parser::new(80, 120, 0);
        parser.process(small(&m).as_bytes());
        assert!(qr_from_screen(parser.screen()).is_none());
        parser.process(
            b"\x1b[2J\x1b[Hpassword=PRIVATE sentinel \x1b[31mPASSWORD_HASH_INVALID\x1b[0m",
        );
        assert_eq!(failure(parser.screen()), "两步验证密码不正确，请重新登录");
        parser.process(b"\x1b[2J\x1b[Hunknown error PRIVATE sentinel");
        assert!(!failure(parser.screen()).contains("PRIVATE"));
    }
    #[test]
    fn reconstructed_qr_must_decode_to_the_telegram_login_protocol() {
        let matrix =
            encoded_fixture("tg://login?token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
        let mut parser = vt100::Parser::new(80, 120, 0);
        for byte in small(&matrix).as_bytes() {
            parser.process(&[*byte]);
        }
        let qr = qr_from_screen(parser.screen()).unwrap_or_else(|| {
            panic!(
                "synthetic fixture terminal: {:?}",
                parser.screen().contents()
            )
        });
        assert!(valid_login_qr(&qr));
        for token in [
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
        ] {
            let padded = encoded_fixture(&format!("tg://login?token={token}"));
            parser.process(b"\x1b[2J\x1b[H");
            parser.process(small(&padded).as_bytes());
            assert!(valid_login_qr(&qr_from_screen(parser.screen()).unwrap()));
        }
        for token in [
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=&extra=1",
            "AAAAAAAAAAAAAAAAAAAA===",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA!",
        ] {
            let invalid = encoded_fixture(&format!("tg://login?token={token}"));
            parser.process(b"\x1b[2J\x1b[H");
            parser.process(small(&invalid).as_bytes());
            assert!(!valid_login_qr(&qr_from_screen(parser.screen()).unwrap()));
        }
        let arbitrary = encoded_fixture("https://example.com/not-a-login");
        parser.process(b"\x1b[2J\x1b[H");
        parser.process(small(&arbitrary).as_bytes());
        assert!(!valid_login_qr(&qr_from_screen(parser.screen()).unwrap()));
        let pattern = fixture(41);
        parser.process(b"\x1b[2J\x1b[H");
        parser.process(small(&pattern).as_bytes());
        assert!(!valid_login_qr(&qr_from_screen(parser.screen()).unwrap()));
    }
    #[test]
    fn cursor_query_detection_is_independent_of_chunk_boundaries() {
        for split in 0..=4 {
            let mut tail = Vec::new();
            let bytes = b"\x1b[6n";
            let first = cursor_requested(&bytes[..split], &mut tail);
            let second = cursor_requested(&bytes[split..], &mut tail);
            assert!(first || second);
            assert!(!cursor_requested(b"ordinary output", &mut tail));
        }
    }
    #[test]
    fn initial_qr_wait_is_bounded_without_shortening_scan_or_2fa_time() {
        assert!(qr_wait_error(Duration::from_millis(44_999), false).is_none());
        assert!(qr_wait_error(Duration::from_secs(45), false).is_some());
        assert!(qr_wait_error(Duration::from_secs(300), true).is_none());
    }
    #[test]
    fn stale_or_nonprompt_password_submission_is_rejected() {
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        *LOGIN.lock().unwrap() = Login {
            view: LoginView {
                session_id: id,
                active: true,
                qr_at: now_ms() - 26_000,
                qr: vec!["100".into()],
                ..Default::default()
            },
            writer: Some(Box::new(Vec::<u8>::new())),
        };
        assert!(get_telegram_tdl_login().qr.is_empty());
        assert!(submit_telegram_tdl_password(id, "test-only".into()).is_err());
        LOGIN.lock().unwrap().view.needs_password = true;
        assert!(submit_telegram_tdl_password(id + 1, "test-only".into()).is_err());
        assert!(submit_telegram_tdl_password(id, "line\nbreak".into()).is_err());
        submit_telegram_tdl_password(id, "test-only".into()).unwrap();
        assert!(!get_telegram_tdl_login().needs_password);
        complete(id, "cancelled");
        assert!(!get_telegram_tdl_login().active);
        assert!(LOGIN.lock().unwrap().writer.is_none());
    }
    #[test]
    #[cfg(windows)]
    fn real_conpty_transports_unicode_and_closes_after_child_exit() {
        use std::io::Read;
        let mut cmd = Command::new("powershell.exe");
        use base64::Engine as _;
        let fixture =
            encoded_fixture("tg://login?token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
        let encoded = base64::engine::general_purpose::STANDARD.encode(small(&fixture).as_bytes());
        cmd.args(["-NoProfile", "-NonInteractive", "-Command"]);
        cmd.arg(format!("[Console]::Write([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded}')))"));
        let NativeLogin {
            master,
            mut child,
            mut reader,
            mut writer,
            job,
            bootstrap,
        } = spawn_login(&cmd).unwrap();
        let reading = std::thread::spawn(move || {
            let mut all = Vec::new();
            let mut bytes = [0u8; 4096];
            let mut tail = Vec::new();
            loop {
                let n = reader.read(&mut bytes).unwrap();
                if n == 0 {
                    break;
                }
                if cursor_requested(&bytes[..n], &mut tail) {
                    writer.write_all(b"\x1b[1;1R").unwrap();
                    writer.flush().unwrap();
                }
                all.extend_from_slice(&bytes[..n]);
            }
            all
        });
        let started = std::time::Instant::now();
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if started.elapsed() > Duration::from_secs(15) {
                child.kill().unwrap();
                break child.wait().unwrap();
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        drop(job);
        drop(master);
        let bytes = reading.join().unwrap();
        drop(bootstrap);
        assert!(status.success());
        let mut parser = vt100::Parser::new(80, 120, 0);
        parser.process(&bytes);
        let qr = qr_from_screen(parser.screen()).unwrap_or_else(|| {
            panic!(
                "synthetic fixture terminal: {:?}",
                parser.screen().contents()
            )
        });
        assert!(valid_login_qr(&qr));
        assert_eq!(qr.len(), fixture.len());
    }
    #[test]
    #[ignore = "explicit pinned-tool network probe; obtains anonymous QR tokens only, never authenticates"]
    #[cfg(windows)]
    fn pinned_tdl_generates_and_refreshes_qr_over_the_production_transport() {
        use std::io::Read;
        let executable = std::env::var("HUB_TEST_TDL_EXE").expect("set exact verified tdl path");
        assert_eq!(
            format!("{:x}", Sha256::digest(fs::read(&executable).unwrap())),
            "2c4057446d95fb0ebefe3ac6d81bf534b5b34363d01109c64aae1c3143cee56b"
        );
        let executable = fs::canonicalize(executable).unwrap();
        let root = std::env::temp_dir().join(format!("hub-tdl-qr-probe-{}", random_url_safe(8)));
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let _cleanup = WorkDirectory(root.clone());
        let mut cmd = Command::new(executable);
        cmd.current_dir(&root)
            .args(["--ns", "hub-qr-probe", "--storage"])
            .arg(format!("type=bolt,path={}", root.join("session").display()))
            .args([
                "--reconnect-timeout",
                "10s",
                "--disable-progress-ps",
                "login",
                "-T",
                "qr",
            ]);
        let proxy = selected_proxy("", windows_system_proxy_url());
        if !proxy.is_empty() {
            cmd.arg("--proxy").arg(proxy);
        }
        let NativeLogin {
            master,
            mut child,
            mut reader,
            mut writer,
            job,
            bootstrap,
        } = spawn_login(&cmd).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let reading = std::thread::spawn(move || {
            let mut bytes = [0u8; 4096];
            let mut tail = Vec::new();
            loop {
                match reader.read(&mut bytes) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if cursor_requested(&bytes[..n], &mut tail) {
                            let _ = writer.write_all(b"\x1b[1;1R");
                            let _ = writer.flush();
                        }
                        if tx.send(bytes[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        let started = std::time::Instant::now();
        let mut parser = vt100::Parser::new(80, 120, 0);
        let mut first = None;
        let mut last = std::time::Instant::now();
        let mut refreshed = false;
        while started.elapsed() < Duration::from_secs(75) {
            while let Ok(bytes) = rx.try_recv() {
                parser.process(&bytes);
                last = std::time::Instant::now();
            }
            if last.elapsed() > Duration::from_millis(200) {
                if let Some(qr) = qr_from_screen(parser.screen()).filter(|qr| valid_login_qr(qr)) {
                    if first.as_ref().is_some_and(|old| *old != qr) {
                        refreshed = true;
                        break;
                    }
                    if first.is_none() {
                        first = Some(qr);
                    }
                }
            }
            if child.try_wait().unwrap().is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = child.kill();
        let _ = child.wait();
        drop(job);
        drop(master);
        drop(rx);
        reading.join().unwrap();
        drop(bootstrap);
        // Never include the terminal buffer, token URL, QR pixels or session keys in diagnostics.
        assert!(
            first.is_some(),
            "tdl did not produce a decodable login QR within the bounded probe"
        );
        assert!(
            refreshed,
            "tdl did not refresh its QR within the bounded probe"
        );
    }
}
