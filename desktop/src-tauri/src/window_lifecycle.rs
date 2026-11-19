//! The native owner of main-window state, geometry, tray and hotkey lifetime.
use super::{
    database_path, isolated_runtime, metadata_bool, metadata_string, open_database,
    open_write_database,
};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
#[cfg(windows)]
use std::{
    sync::{atomic::AtomicU32, mpsc, Arc},
    thread::JoinHandle,
    time::Duration,
};
#[cfg(desktop)]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tauri::{AppHandle, Emitter, Manager};
#[cfg(all(desktop, not(windows)))]
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

#[cfg(windows)]
pub(super) mod assistant;

const DEFAULT_TOGGLE_SHORTCUT: &str = "Ctrl+Shift+K";
struct ProfileExitRequest {
    id: String,
    restart: bool,
    windows: std::collections::BTreeSet<String>,
}
static PROFILE_EXIT_REQUEST: Mutex<Option<ProfileExitRequest>> = Mutex::new(None);
static PROFILE_EXIT_CONFIRMED: AtomicBool = AtomicBool::new(false);

#[cfg(windows)]
pub(super) fn quit_requested(
    arguments: impl IntoIterator<Item = impl AsRef<std::ffi::OsStr>>,
) -> bool {
    let mut arguments = arguments.into_iter();
    arguments.next().is_some_and(|arg| arg.as_ref() == "--quit") && arguments.next().is_none()
}

pub(crate) fn request_profile_exit(app: &AppHandle) {
    request_profile_shutdown(app, false);
}

pub(crate) fn request_profile_restart(app: &AppHandle) {
    request_profile_shutdown(app, true);
}

fn request_profile_shutdown(app: &AppHandle, restart: bool) {
    let Ok(mut pending) = PROFILE_EXIT_REQUEST.lock() else {
        return;
    };
    let request = pending.get_or_insert_with(|| ProfileExitRequest {
        id: crate::random_url_safe(24),
        restart,
        windows: app
            .webview_windows()
            .into_keys()
            .filter(|label| label == "main" || label == "quick-assistant")
            .collect(),
    });
    request.restart |= restart;
    let request_id = request.id.clone();
    drop(pending);
    #[cfg(desktop)]
    show_main_window(app);
    let _ = app.emit(
        "hub:flush-user-profile-before-exit",
        serde_json::json!({"requestId":request_id}),
    );
}

pub(crate) fn profile_exit_confirmed() -> bool {
    PROFILE_EXIT_CONFIRMED.load(Ordering::Acquire)
}

#[tauri::command]
pub(crate) fn user_profile_exit_ready(
    window: tauri::WebviewWindow,
) -> Result<serde_json::Value, String> {
    let pending = PROFILE_EXIT_REQUEST
        .lock()
        .map_err(|_| "退出保存状态不可用")?;
    Ok(
        serde_json::json!({"requestId":pending.as_ref().filter(|request| request.windows.contains(window.label())).map(|request|&request.id)}),
    )
}

#[tauri::command]
pub(crate) fn confirm_user_profile_exit(
    app: AppHandle,
    window: tauri::WebviewWindow,
    request_id: String,
) -> Result<(), String> {
    let mut pending = PROFILE_EXIT_REQUEST
        .lock()
        .map_err(|_| "退出保存状态不可用")?;
    let request = pending
        .as_mut()
        .filter(|request| request.id == request_id)
        .ok_or("退出请求已失效")?;
    request.windows.remove(window.label());
    if !request.windows.is_empty() {
        return Ok(());
    }
    let restart = request.restart;
    *pending = None;
    PROFILE_EXIT_CONFIRMED.store(true, Ordering::Release);
    drop(pending);
    if restart {
        app.restart();
    } else {
        // Let the last native Destroyed event end the loop. Sending RequestExit
        // as well can stop the pump before queued native destruction finishes.
        let windows = app.webview_windows();
        if isolated_runtime::enabled() {
            eprintln!(
                "hub_exit phase=profile_flushed destroy_count={}",
                windows.len()
            );
        }
        for window in windows.values() {
            window
                .destroy()
                .map_err(|error| format!("退出时销毁窗口失败：{error}"))?;
        }
        if windows.is_empty() {
            app.exit(0);
        }
    }
    Ok(())
}
#[cfg(windows)]
const NATIVE_TOGGLE_HOTKEY_ID: i32 = 0x4842;
#[cfg(windows)]
const NATIVE_ASSISTANT_HOTKEY_ID: i32 = 0x4843;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WindowVisibility {
    // Decimal strings preserve monotonicity beyond JavaScript's integer range.
    revision: String,
    visible: bool,
    minimized: bool,
    foreground: bool,
}
struct VisibilityState {
    revision: u64,
    visible: bool,
    minimized: bool,
    foreground: bool,
}
impl Default for VisibilityState {
    fn default() -> Self {
        Self {
            revision: 0,
            visible: false,
            minimized: false,
            foreground: true,
        }
    }
}
impl VisibilityState {
    fn update(
        &mut self,
        visible: bool,
        minimized: bool,
        foreground: bool,
    ) -> (WindowVisibility, bool) {
        let changed =
            (self.visible, self.minimized, self.foreground) != (visible, minimized, foreground);
        if changed {
            self.revision = self
                .revision
                .checked_add(1)
                .expect("window visibility revision exhausted");
            self.visible = visible;
            self.minimized = minimized;
            self.foreground = foreground;
        }
        (
            WindowVisibility {
                revision: self.revision.to_string(),
                visible,
                minimized,
                foreground,
            },
            changed,
        )
    }
}
#[derive(Default)]
pub(super) struct WindowState {
    visibility: Mutex<VisibilityState>,
    closed: AtomicBool,
    #[cfg(windows)]
    native_hotkey: Mutex<Option<NativeHotkeyThread>>,
    #[cfg(windows)]
    assistant_return: Mutex<isize>,
    #[cfg(windows)]
    assistant_visibility: Mutex<VisibilityState>,
}
#[cfg(windows)]
struct NativeHotkeyThread {
    thread_id: u32,
    handle: Option<JoinHandle<()>>,
    cancelled: Arc<AtomicBool>,
}

fn refresh_visibility(app: &AppHandle) -> Result<WindowVisibility, String> {
    let state = app.try_state::<WindowState>().ok_or("窗口状态尚未初始化")?;
    let window = app.get_webview_window("main").ok_or("主窗口不存在")?;
    let mut current = state.visibility.lock().map_err(|_| "窗口状态不可用")?;
    let foreground = current.foreground && !state.closed.load(Ordering::Acquire);
    #[cfg(desktop)]
    let (visible, minimized) = (
        window
            .is_visible()
            .map_err(|error| format!("无法读取窗口状态：{error}"))?
            && foreground,
        window
            .is_minimized()
            .map_err(|error| format!("无法读取窗口状态：{error}"))?,
    );
    #[cfg(mobile)]
    let (visible, minimized) = {
        let _ = window;
        (foreground, false)
    };
    let (snapshot, changed) = current.update(visible, minimized, foreground);
    drop(current);
    if changed {
        let _ = app.emit_to("main", "hub-window-visibility", &snapshot);
    }
    Ok(snapshot)
}

#[tauri::command]
pub(super) fn get_window_visibility(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<WindowVisibility, String> {
    #[cfg(windows)]
    if window.label() == assistant::LABEL {
        return assistant::visibility(&window);
    }
    let _ = window;
    refresh_visibility(&app)
}

#[tauri::command]
pub(super) fn show_window(app: AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let window = app.get_webview_window("main").ok_or("主窗口不存在")?;
        window
            .show()
            .map_err(|error| format!("无法显示窗口：{error}"))?;
        window
            .unminimize()
            .map_err(|error| format!("无法恢复窗口：{error}"))?;
        recover_window_frame(&window);
        window
            .set_focus()
            .map_err(|error| format!("无法激活窗口：{error}"))?;
        refresh_visibility(&app)?;
        let _ = app.emit("hub-window-shown", ());
        Ok(())
    }
    #[cfg(mobile)]
    {
        let _ = app;
        Err("移动端窗口由系统管理".into())
    }
}

pub(super) fn handle_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    #[cfg(windows)]
    if window.label() == assistant::LABEL {
        assistant::handle_event(window, event);
        return;
    }
    if window.label() != "main" {
        return;
    }
    let app = window.app_handle();
    if isolated_runtime::enabled() && matches!(event, tauri::WindowEvent::Destroyed) {
        eprintln!("hub_exit phase=main_window_destroyed");
    }
    #[cfg(target_os = "android")]
    if let tauri::WindowEvent::Resumed | tauri::WindowEvent::Suspended = event {
        let foreground = matches!(event, tauri::WindowEvent::Resumed);
        if let Some(state) = app.try_state::<WindowState>() {
            if let Ok(mut visibility) = state.visibility.lock() {
                visibility.foreground = foreground;
            }
        }
        super::reading_sync::set_foreground(foreground);
    }
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        if isolated_runtime::enabled() && !profile_exit_confirmed() {
            // Keep the WebView alive until it acknowledges its pending profile writes.
            api.prevent_close();
            request_profile_exit(app);
        } else if !isolated_runtime::enabled() {
            api.prevent_close();
            let _ = window.hide();
        }
    }
    // Minimize changes are host facts even when WebView document.hidden stays false.
    let _ = refresh_visibility(app);
}

pub(super) fn shutdown(app: &AppHandle) {
    if isolated_runtime::enabled() {
        eprintln!(
            "hub_exit phase=event_loop_exit profile_confirmed={}",
            profile_exit_confirmed()
        );
    }
    let Some(state) = app.try_state::<WindowState>() else {
        return;
    };
    state.closed.store(true, Ordering::Release);
    #[cfg(windows)]
    stop_native_hotkey(app);
    #[cfg(all(desktop, not(windows)))]
    let _ = app.global_shortcut().unregister_all();
    let _ = refresh_visibility(app);
}

fn metadata_i32(connection: &Connection, key: &str) -> Option<i32> {
    connection
        .query_row(
            "SELECT value FROM metadata WHERE key=?1",
            params![key],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|value| value.parse::<i32>().ok())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WindowFrame {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

fn normalized_window_frame_with_minimum(
    frame: WindowFrame,
    monitors: &[WindowFrame],
    minimum_width: u32,
    minimum_height: u32,
) -> WindowFrame {
    let overlap_area = |monitor: &WindowFrame| {
        let left = i64::from(frame.x).max(i64::from(monitor.x));
        let top = i64::from(frame.y).max(i64::from(monitor.y));
        let right = (i64::from(frame.x) + i64::from(frame.width))
            .min(i64::from(monitor.x) + i64::from(monitor.width));
        let bottom = (i64::from(frame.y) + i64::from(frame.height))
            .min(i64::from(monitor.y) + i64::from(monitor.height));
        (right - left).max(0) * (bottom - top).max(0)
    };
    let Some(mut monitor) = monitors.first() else {
        return frame;
    };
    let mut best_overlap = overlap_area(monitor);
    for candidate in monitors.iter().skip(1) {
        let overlap = overlap_area(candidate);
        if overlap > best_overlap {
            monitor = candidate;
            best_overlap = overlap;
        }
    }

    let max_width = monitor.width.saturating_sub(24).max(320);
    let max_height = monitor.height.saturating_sub(24).max(240);
    let width = frame.width.clamp(minimum_width.min(max_width), max_width);
    let height = frame
        .height
        .clamp(minimum_height.min(max_height), max_height);
    let max_x = i64::from(monitor.x) + i64::from(monitor.width.saturating_sub(width));
    let max_y = i64::from(monitor.y) + i64::from(monitor.height.saturating_sub(height));
    let x = i64::from(frame.x)
        .clamp(i64::from(monitor.x), max_x)
        .try_into()
        .unwrap_or(monitor.x);
    let y = i64::from(frame.y)
        .clamp(i64::from(monitor.y), max_y)
        .try_into()
        .unwrap_or(monitor.y);
    WindowFrame {
        x,
        y,
        width,
        height,
    }
}

fn normalized_window_frame(frame: WindowFrame, monitors: &[WindowFrame]) -> WindowFrame {
    normalized_window_frame_with_minimum(frame, monitors, 760, 560)
}

fn available_monitor_frames(window: &tauri::WebviewWindow) -> Vec<WindowFrame> {
    let mut monitors = Vec::new();
    if let Ok(Some(primary)) = window.primary_monitor() {
        monitors.push(WindowFrame {
            x: primary.position().x,
            y: primary.position().y,
            width: primary.size().width,
            height: primary.size().height,
        });
    }
    if let Ok(available) = window.available_monitors() {
        for monitor in available {
            let frame = WindowFrame {
                x: monitor.position().x,
                y: monitor.position().y,
                width: monitor.size().width,
                height: monitor.size().height,
            };
            if !monitors.contains(&frame) {
                monitors.push(frame);
            }
        }
    }
    monitors
}

fn recover_window_frame(window: &tauri::WebviewWindow) {
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let current = WindowFrame {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    };
    let recovered = normalized_window_frame(current, &available_monitor_frames(window));
    if recovered.width != current.width || recovered.height != current.height {
        let _ = window.set_size(tauri::PhysicalSize::new(recovered.width, recovered.height));
    }
    if recovered.x != current.x || recovered.y != current.y {
        let _ = window.set_position(tauri::PhysicalPosition::new(recovered.x, recovered.y));
    }
}

fn restore_window_position(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Some((x, y, width, height)) = database_path(app)
        .ok()
        .and_then(|path| open_database(&path).ok())
        .filter(|connection| metadata_bool(connection, "remember_window_position", true))
        .and_then(|connection| {
            Some((
                metadata_i32(&connection, "window_position_x")?,
                metadata_i32(&connection, "window_position_y")?,
                metadata_i32(&connection, "window_width")
                    .unwrap_or(1040)
                    .max(760) as u32,
                metadata_i32(&connection, "window_height")
                    .unwrap_or(720)
                    .max(560) as u32,
            ))
        })
    else {
        return;
    };
    let frame = normalized_window_frame(
        WindowFrame {
            x,
            y,
            width,
            height,
        },
        &available_monitor_frames(&window),
    );
    let _ = window.set_size(tauri::PhysicalSize::new(frame.width, frame.height));
    let _ = window.set_position(tauri::PhysicalPosition::new(frame.x, frame.y));
}

pub(super) fn configured_toggle_shortcut(connection: &Connection) -> String {
    let shortcut = metadata_string(connection, "toggle_shortcut");
    if shortcut.trim().is_empty() {
        DEFAULT_TOGGLE_SHORTCUT.to_string()
    } else {
        shortcut
    }
}

#[tauri::command]
pub(super) fn hide_window(app: AppHandle) -> Result<(), String> {
    app.get_webview_window("main")
        .ok_or("主窗口不存在")?
        .hide()
        .map_err(|error| format!("无法隐藏窗口：{error}"))?;
    let _ = refresh_visibility(&app);
    Ok(())
}

#[tauri::command]
pub(super) async fn save_window_state(
    app: AppHandle,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    results_pane_percent: f64,
) -> Result<(), String> {
    let path = database_path(&app)?;
    tokio::task::spawn_blocking(move || {
        let (mut connection, _writer) = open_write_database(&path)?;
        if !metadata_bool(&connection, "remember_window_position", true) {
            return Ok(());
        }
        if !results_pane_percent.is_finite() {
            return Err("窗口比例无效".into());
        }
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法保存窗口状态：{error}"))?;
        for (key, value) in [
            ("window_position_x", x.to_string()),
            ("window_position_y", y.to_string()),
            ("window_width", width.max(760).to_string()),
            ("window_height", height.max(560).to_string()),
            (
                "results_pane_percent",
                results_pane_percent.clamp(25.0, 75.0).to_string(),
            ),
        ] {
            transaction
                .execute(
                    "INSERT INTO metadata (key, value) VALUES (?1, ?2)
                     ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    params![key, value],
                )
                .map_err(|error| format!("无法保存窗口状态：{error}"))?;
        }
        transaction
            .commit()
            .map_err(|error| format!("无法保存窗口状态：{error}"))?;
        Ok(())
    })
    .await
    .map_err(|error| format!("保存窗口状态任务失败：{error}"))?
}

#[cfg(desktop)]
pub(super) fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        recover_window_frame(&window);
        let _ = window.set_focus();
        let _ = refresh_visibility(app);
        let _ = app.emit("hub-window-shown", ());
    }
}

#[cfg(desktop)]
fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_minimized().unwrap_or(false) || !window.is_visible().unwrap_or(false) {
            show_main_window(app);
        } else {
            let _ = hide_window(app.clone());
        }
    }
}

#[cfg(windows)]
fn parse_native_hotkey(shortcut: &str) -> Result<(u32, u32), String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, MOD_WIN,
    };

    let parts = shortcut
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if parts.is_empty() {
        return Err("快捷键不能为空".to_string());
    }
    let mut modifiers = MOD_NOREPEAT.0;
    for modifier in &parts[..parts.len() - 1] {
        match modifier.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => modifiers |= MOD_CONTROL.0,
            "alt" => modifiers |= MOD_ALT.0,
            "shift" => modifiers |= MOD_SHIFT.0,
            "super" | "win" | "meta" => modifiers |= MOD_WIN.0,
            _ => return Err(format!("不支持的快捷键修饰键：{modifier}")),
        }
    }
    if modifiers == MOD_NOREPEAT.0
        && !is_standalone_function_key(parts.last().copied().unwrap_or_default())
    {
        return Err("普通按键必须包含 Ctrl、Alt、Shift 或 Win；F1–F24 可单独使用".to_string());
    }
    let key = parts
        .last()
        .copied()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let vk = if key.len() == 1 {
        let byte = key.as_bytes()[0];
        if byte.is_ascii_alphanumeric() {
            byte as u32
        } else {
            return Err(format!("不支持的快捷键按键：{key}"));
        }
    } else if key == "SPACE" {
        0x20
    } else if let Some(number) = key
        .strip_prefix('F')
        .and_then(|value| value.parse::<u32>().ok())
    {
        if (1..=24).contains(&number) {
            0x70 + number - 1
        } else {
            return Err(format!("不支持的功能键：{key}"));
        }
    } else {
        return Err(format!("不支持的快捷键按键：{key}"));
    };
    Ok((modifiers, vk))
}

#[cfg(windows)]
impl NativeHotkeyThread {
    fn stop(mut self) {
        use windows::Win32::{
            Foundation::{LPARAM, WPARAM},
            UI::WindowsAndMessaging::{PostThreadMessageW, WM_QUIT},
        };
        self.cancelled.store(true, Ordering::Release);
        unsafe {
            let _ = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}
#[cfg(windows)]
fn stop_native_hotkey(app: &AppHandle) {
    let state = app.state::<WindowState>();
    let registration = state
        .native_hotkey
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .take();
    if let Some(registration) = registration {
        registration.stop();
    }
}

#[cfg(windows)]
fn native_hotkey_error(shortcut: &str, error: &windows::core::Error) -> String {
    if error.code().0 as u32 == 0x80070581 {
        format!("快捷键 {shortcut} 已被其他程序占用，请先在该程序中取消绑定，或选择其他快捷键")
    } else {
        format!("Windows 无法注册快捷键 {shortcut}：{error}")
    }
}

#[cfg(windows)]
fn register_global_shortcuts(app: &AppHandle, toggle_shortcut: &str) -> Result<(), String> {
    use windows::Win32::{
        Foundation::{LPARAM, WPARAM},
        System::Threading::GetCurrentThreadId,
        UI::{
            Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey, HOT_KEY_MODIFIERS},
            WindowsAndMessaging::{
                GetMessageW, PeekMessageW, PostThreadMessageW, MSG, PM_NOREMOVE, WM_HOTKEY, WM_QUIT,
            },
        },
    };
    let (toggle_modifiers, toggle_vk) = parse_native_hotkey(toggle_shortcut)?;
    let state = app.state::<WindowState>();
    let mut registration = state
        .native_hotkey
        .lock()
        .map_err(|_| "快捷键监听状态不可用")?;
    if state.closed.load(Ordering::Acquire) {
        return Err("应用正在退出".into());
    }
    if let Some(previous) = registration.take() {
        previous.stop();
    }
    let app_handle = app.clone();
    let toggle_label = toggle_shortcut.to_string();
    let cancelled = Arc::new(AtomicBool::new(false));
    let control = cancelled.clone();
    let created_thread_id = Arc::new(AtomicU32::new(0));
    let producer_thread_id = created_thread_id.clone();
    let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<u32, String>>(1);
    let thread = std::thread::Builder::new()
        .name("hub-global-hotkey".into())
        .spawn(move || {
            let thread_id = unsafe { GetCurrentThreadId() };
            let mut message = MSG::default();
            unsafe {
                let _ = PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE);
            }
            producer_thread_id.store(thread_id, Ordering::Release);
            if control.load(Ordering::Acquire) {
                return;
            }
            if let Err(error) = unsafe {
                RegisterHotKey(
                    None,
                    NATIVE_TOGGLE_HOTKEY_ID,
                    HOT_KEY_MODIFIERS(toggle_modifiers),
                    toggle_vk,
                )
            } {
                let _ = ready_tx.send(Err(native_hotkey_error(&toggle_label, &error)));
                return;
            }
            let assistant_registered = ["Ctrl+Alt+J", "Ctrl+Alt+F9"].into_iter().any(|shortcut| {
                let Ok((modifiers, key)) = parse_native_hotkey(shortcut) else {
                    return false;
                };
                unsafe {
                    RegisterHotKey(
                        None,
                        NATIVE_ASSISTANT_HOTKEY_ID,
                        HOT_KEY_MODIFIERS(modifiers),
                        key,
                    )
                    .is_ok()
                }
            });
            if ready_tx.send(Ok(thread_id)).is_ok() && !control.load(Ordering::Acquire) {
                loop {
                    let result = unsafe { GetMessageW(&mut message, None, 0, 0) };
                    if result.0 <= 0 || control.load(Ordering::Acquire) {
                        break;
                    }
                    let hotkey = message.wParam.0 as i32;
                    if message.message == WM_HOTKEY
                        && matches!(hotkey, NATIVE_TOGGLE_HOTKEY_ID | NATIVE_ASSISTANT_HOTKEY_ID)
                    {
                        // Scheduling avoids joining a producer waiting on the UI thread during shutdown.
                        let target = app_handle.clone();
                        let active = control.clone();
                        let _ = app_handle.run_on_main_thread(move || {
                            if !active.load(Ordering::Acquire) {
                                if hotkey == NATIVE_ASSISTANT_HOTKEY_ID {
                                    assistant::toggle(&target);
                                } else {
                                    toggle_main_window(&target);
                                }
                            }
                        });
                    }
                }
            }
            unsafe {
                let _ = UnregisterHotKey(None, NATIVE_TOGGLE_HOTKEY_ID);
                if assistant_registered {
                    let _ = UnregisterHotKey(None, NATIVE_ASSISTANT_HOTKEY_ID);
                }
            }
        })
        .map_err(|error| format!("无法启动 Windows 快捷键监听：{error}"))?;
    let thread_id = match ready_rx.recv_timeout(Duration::from_secs(2)) {
        Ok(Ok(id)) => id,
        result => {
            cancelled.store(true, Ordering::Release);
            let id = created_thread_id.load(Ordering::Acquire);
            if id != 0 {
                unsafe {
                    let _ = PostThreadMessageW(id, WM_QUIT, WPARAM(0), LPARAM(0));
                }
            }
            drop(ready_rx);
            let _ = thread.join();
            return Err(match result {
                Ok(Err(error)) => error,
                _ => "Windows 快捷键监听启动超时".into(),
            });
        }
    };
    *registration = Some(NativeHotkeyThread {
        thread_id,
        handle: Some(thread),
        cancelled,
    });
    Ok(())
}

#[cfg(all(desktop, not(windows)))]
fn register_global_shortcuts(app: &AppHandle, toggle_shortcut: &str) -> Result<(), String> {
    app.global_shortcut()
        .unregister_all()
        .map_err(|error| format!("无法释放原快捷键：{error}"))?;
    app.global_shortcut()
        .on_shortcut(toggle_shortcut, |app, _, event| {
            if event.state == ShortcutState::Pressed {
                toggle_main_window(app);
            }
        })
        .map_err(|error| format!("无法注册应用唤醒快捷键“{toggle_shortcut}”：{error}"))?;
    Ok(())
}

#[cfg(mobile)]
fn register_global_shortcuts(_app: &AppHandle, _toggle_shortcut: &str) -> Result<(), String> {
    Err("移动端不支持全局快捷键".to_string())
}

fn persist_global_shortcut(app: &AppHandle, key: &str, shortcut: &str) -> Result<(), String> {
    let path = database_path(app)?;
    let (connection, _writer) = open_write_database(&path)?;
    connection
        .execute(
            "INSERT INTO metadata (key,value) VALUES (?1,?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, shortcut],
        )
        .map_err(|error| format!("无法保存全局快捷键：{error}"))?;
    Ok(())
}

fn activate_global_shortcuts(app: &AppHandle, preferred_toggle: &str) -> Result<String, String> {
    if isolated_runtime::enabled() {
        return Err("隔离联调运行不注册全局快捷键".into());
    }
    let toggle_candidates = [preferred_toggle, DEFAULT_TOGGLE_SHORTCUT, "Ctrl+Alt+K"];
    let mut errors = Vec::new();
    for toggle in toggle_candidates {
        if toggle.trim().is_empty() {
            continue;
        }
        match register_global_shortcuts(app, toggle) {
            Ok(()) => return Ok(toggle.to_string()),
            Err(error) => errors.push(error),
        }
    }
    Err(errors.join("；"))
}

fn is_standalone_function_key(key: &str) -> bool {
    let key = key.to_ascii_uppercase();
    (1..=24).any(|number| key == format!("F{number}"))
}

fn validate_global_shortcut(shortcut: &str) -> Result<String, String> {
    let shortcut = shortcut.trim().to_string();
    if is_standalone_function_key(&shortcut) {
        return Ok(shortcut.to_ascii_uppercase());
    }
    if shortcut.is_empty() || !shortcut.contains('+') {
        return Err("普通按键必须包含 Ctrl、Alt、Shift 或 Win；F1–F24 可单独使用".to_string());
    }
    Ok(shortcut)
}

#[tauri::command]
pub(super) fn update_toggle_shortcut(app: AppHandle, shortcut: String) -> Result<String, String> {
    #[cfg(mobile)]
    {
        let _ = app;
        let _ = shortcut;
        return Err("移动端不支持全局快捷键".to_string());
    }
    #[cfg(desktop)]
    {
        let shortcut = validate_global_shortcut(&shortcut)?;
        let path = database_path(&app)?;
        let previous_toggle = open_database(&path)
            .map(|connection| configured_toggle_shortcut(&connection))
            .unwrap_or_else(|_| DEFAULT_TOGGLE_SHORTCUT.to_string());
        if let Err(error) = register_global_shortcuts(&app, &shortcut) {
            let _ = register_global_shortcuts(&app, &previous_toggle);
            return Err(format!("{error}；原快捷键仍然有效"));
        }
        if let Err(error) = persist_global_shortcut(&app, "toggle_shortcut", &shortcut) {
            let _ = register_global_shortcuts(&app, &previous_toggle);
            return Err(error);
        }
        Ok(shortcut)
    }
}

pub(super) fn initialize(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    restore_window_position(app.handle());
    if std::env::args_os().any(|argument| argument == "--autostart-hidden") {
        let _ = hide_window(app.handle().clone());
    }
    let _ = refresh_visibility(app.handle());
    #[cfg(desktop)]
    if !isolated_runtime::enabled() {
        let configured_toggle = database_path(app.handle())
            .ok()
            .and_then(|path| open_database(&path).ok())
            .map(|connection| configured_toggle_shortcut(&connection))
            .unwrap_or_else(|| DEFAULT_TOGGLE_SHORTCUT.to_string());
        if let Ok(active_toggle) = activate_global_shortcuts(app.handle(), &configured_toggle) {
            if !active_toggle.eq_ignore_ascii_case(&configured_toggle) {
                let _ = persist_global_shortcut(app.handle(), "toggle_shortcut", &active_toggle);
            }
        }
        let show_item = MenuItem::with_id(app, "show", "显示 Hub", true, None::<&str>)?;
        let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
        #[cfg(windows)]
        let assistant_item =
            MenuItem::with_id(app, "assistant", "打开 Hub 助手", true, None::<&str>)?;
        #[cfg(windows)]
        let menu = Menu::with_items(app, &[&show_item, &assistant_item, &quit_item])?;
        #[cfg(not(windows))]
        let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
        TrayIconBuilder::new()
            .icon(app.default_window_icon().ok_or("应用图标不可用")?.clone())
            .tooltip("Hub")
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_menu_event(|app, event| match event.id.as_ref() {
                "show" => show_main_window(app),
                "quit" => request_profile_exit(app),
                #[cfg(windows)]
                "assistant" => assistant::toggle(app),
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    show_main_window(tray.app_handle());
                }
            })
            .build(app)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    fn quit_requires_the_standalone_flag() {
        assert!(quit_requested(["--quit"]));
        assert!(!quit_requested(["--quit", "--manual-session"]));
        assert!(!quit_requested(["hub://open/--quit"]));
        assert!(!quit_requested(std::iter::empty::<&str>()));
    }

    #[test]
    fn global_shortcut_allows_standalone_function_keys() {
        for number in 1..=24 {
            let key = format!("F{number}");
            assert_eq!(validate_global_shortcut(&key).unwrap(), key);
        }
        assert_eq!(validate_global_shortcut(" f9 ").unwrap(), "F9");
        assert_eq!(validate_global_shortcut("Ctrl+F9").unwrap(), "Ctrl+F9");
        for key in ["", "A", "9", "Space", "F0", "F25", "F01"] {
            assert!(validate_global_shortcut(key).is_err(), "{key}");
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn global_shortcut_native_function_key_mapping() {
        use windows::Win32::UI::Input::KeyboardAndMouse::{MOD_CONTROL, MOD_NOREPEAT};
        for number in 1..=24 {
            assert_eq!(
                parse_native_hotkey(&format!("F{number}")).unwrap(),
                (MOD_NOREPEAT.0, 0x70 + number - 1)
            );
        }
        assert_eq!(
            parse_native_hotkey("Ctrl+F9").unwrap(),
            (MOD_NOREPEAT.0 | MOD_CONTROL.0, 0x78)
        );
        assert!(parse_native_hotkey("Ctrl+Alt+Space").is_ok());
        for key in ["", "A", "9", "Space", "F0", "F25", "F01"] {
            assert!(parse_native_hotkey(key).is_err(), "{key}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn global_shortcut_conflict_message_names_the_key() {
        let error =
            windows::core::Error::from_hresult(windows::core::HRESULT(0x80070581u32 as i32));
        let message = native_hotkey_error("F9", &error);
        assert!(message.contains("F9"));
        assert!(message.contains("已被其他程序占用"));
    }

    #[test]
    fn corrupted_minimized_window_frame_returns_to_the_primary_monitor() {
        let primary = WindowFrame {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        };
        let secondary = WindowFrame {
            x: 1920,
            y: 0,
            width: 2560,
            height: 1440,
        };
        assert_eq!(
            normalized_window_frame(
                WindowFrame {
                    x: -32000,
                    y: -32000,
                    width: 760,
                    height: 560,
                },
                &[primary, secondary],
            ),
            WindowFrame {
                x: 0,
                y: 0,
                width: 760,
                height: 560,
            }
        );
    }

    #[test]
    fn oversized_window_frame_is_clamped_inside_its_monitor() {
        assert_eq!(
            normalized_window_frame(
                WindowFrame {
                    x: 2000,
                    y: -100,
                    width: 5000,
                    height: 3000,
                },
                &[WindowFrame {
                    x: 1920,
                    y: 0,
                    width: 1920,
                    height: 1080,
                }],
            ),
            WindowFrame {
                x: 1944,
                y: 0,
                width: 1896,
                height: 1056,
            }
        );
    }
    #[test]
    fn visibility_revisions_cover_host_hide_minimize_suspend_and_restore() {
        let mut state = VisibilityState::default();
        let (shown, changed) = state.update(true, false, true);
        assert!(changed);
        assert_eq!(shown.revision, "1");
        let (same, changed) = state.update(true, false, true);
        assert!(!changed);
        assert_eq!(same.revision, "1");
        let (hidden, _) = state.update(false, false, true);
        let (minimized, _) = state.update(true, true, true);
        let (suspended, _) = state.update(false, false, false);
        let (restored, _) = state.update(true, false, true);
        assert_eq!(
            [
                hidden.revision,
                minimized.revision,
                suspended.revision,
                restored.revision
            ],
            ["2", "3", "4", "5"]
        );
    }
    #[test]
    fn visibility_revision_serialization_preserves_large_integer_order() {
        let mut state = VisibilityState {
            revision: 9_007_199_254_740_993,
            ..Default::default()
        };
        let (snapshot, _) = state.update(true, false, true);
        let value = serde_json::to_value(snapshot).unwrap();
        assert_eq!(value["revision"], "9007199254740994");
        assert_eq!(value["visible"], true);
        assert_eq!(value["minimized"], false);
    }
}
