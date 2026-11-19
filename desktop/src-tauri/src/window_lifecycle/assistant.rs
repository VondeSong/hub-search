use super::{WindowState, WindowVisibility, PROFILE_EXIT_REQUEST};
use tauri::{
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window,
    WindowEvent,
};
use windows::Win32::{
    Foundation::HWND,
    UI::WindowsAndMessaging::{GetForegroundWindow, IsWindow, SetForegroundWindow},
};

pub(super) const LABEL: &str = "quick-assistant";

pub(super) fn toggle(app: &AppHandle) {
    let result = show_or_hide(app);
    if let Err(error) = result {
        eprintln!("Hub 助手窗口不可用：{error}");
    }
}

fn show_or_hide(app: &AppHandle) -> Result<(), String> {
    if PROFILE_EXIT_REQUEST
        .lock()
        .map_err(|_| "退出状态不可用")?
        .is_some()
    {
        return Ok(());
    }
    let foreground = unsafe { GetForegroundWindow() };
    let window = match app.get_webview_window(LABEL) {
        Some(window) => window,
        None => WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
            .title("Hub 助手")
            .inner_size(690.0, 720.0)
            .min_inner_size(380.0, 460.0)
            .visible(false)
            .focused(false)
            .center()
            .skip_taskbar(true)
            .drag_and_drop(false)
            .build()
            .map_err(|error| error.to_string())?,
    };

    if window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false) {
        return hide(&window);
    }
    let state = app.state::<WindowState>();
    if let Ok(mut saved) = state.assistant_return.lock() {
        let own_handle = window.hwnd().map(|handle| handle.0 as isize).unwrap_or(0);
        if foreground.0 as isize != own_handle {
            *saved = foreground.0 as isize;
        }
    }
    window
        .show()
        .and_then(|_| window.unminimize())
        .and_then(|_| window.set_focus())
        .map_err(|error| error.to_string())?;
    let _ = visibility(&window);
    let _ = app.emit_to(LABEL, "hub:quick-assistant-shown", ());
    Ok(())
}

fn hide(window: &WebviewWindow) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let was_foreground = unsafe { GetForegroundWindow() }.0 as isize == hwnd.0 as isize;
    window.hide().map_err(|error| error.to_string())?;
    let _ = visibility(window);
    let state = window.app_handle().state::<WindowState>();
    let saved = state
        .assistant_return
        .lock()
        .map(|mut value| std::mem::take(&mut *value))
        .unwrap_or(0);
    if was_foreground && saved != 0 {
        let target = HWND(saved as _);
        if unsafe { IsWindow(Some(target)) }.as_bool() {
            let _ = unsafe { SetForegroundWindow(target) };
        }
    }
    Ok(())
}

pub(super) fn visibility(window: &WebviewWindow) -> Result<WindowVisibility, String> {
    let app = window.app_handle();
    let state = app.state::<WindowState>();
    let visible = window.is_visible().map_err(|error| error.to_string())?;
    let minimized = window.is_minimized().map_err(|error| error.to_string())?;
    let (snapshot, changed) = state
        .assistant_visibility
        .lock()
        .map_err(|_| "助手窗口状态不可用")?
        .update(
            visible,
            minimized,
            !state.closed.load(std::sync::atomic::Ordering::Acquire),
        );
    if changed {
        let _ = app.emit_to(LABEL, "hub-window-visibility", &snapshot);
    }
    Ok(snapshot)
}

#[tauri::command]
pub(crate) async fn dismiss_assistant_window(window: WebviewWindow) -> Result<(), String> {
    if window.label() != LABEL {
        return Err("独立助手窗口不存在".into());
    }
    let target = window.clone();
    let (send, reply) = tokio::sync::oneshot::channel();
    window
        .run_on_main_thread(move || {
            let _ = send.send(hide(&target));
        })
        .map_err(|error| error.to_string())?;
    reply.await.map_err(|_| "助手窗口关闭请求中断")?
}

pub(super) fn handle_event(window: &Window, event: &WindowEvent) {
    if let Some(assistant) = window.app_handle().get_webview_window(LABEL) {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = hide(&assistant);
        } else if matches!(event, WindowEvent::Focused(_) | WindowEvent::Resized(_)) {
            let _ = visibility(&assistant);
        }
    }
}
