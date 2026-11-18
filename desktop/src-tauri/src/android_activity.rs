//! Android owns Activity lifetime; the Rust application can outlive its main WebView.
#[derive(Default)]
struct ActivityState {
    activity: Option<i32>,
    webview: Option<i32>,
}

impl ActivityState {
    fn created(&mut self, id: i32) {
        self.activity = Some(id);
    }
    fn webview_ready(&mut self, id: i32) {
        if self.activity == Some(id) {
            self.webview = Some(id);
        }
    }
    fn destroyed(&mut self, id: i32) {
        if self.activity == Some(id) {
            self.activity = None;
        }
    }
    fn webview_cleanup_finished(&mut self, id: i32) {
        if self.webview == Some(id) {
            self.webview = None;
        }
    }
    fn needs_window(&self) -> bool {
        self.activity.is_some() && self.webview.is_none()
    }
}

#[cfg(target_os = "android")]
mod runtime {
    use super::ActivityState;
    use jni::{objects::JObject, sys::jint, JNIEnv};
    use std::sync::{Mutex, OnceLock};
    use tauri::{AppHandle, Manager};

    static APP: OnceLock<AppHandle> = OnceLock::new();
    static STATE: Mutex<ActivityState> = Mutex::new(ActivityState {
        activity: None,
        webview: None,
    });

    pub(crate) fn initialize(app: &AppHandle) {
        // Initial construction remains owned by Tauri. Only later Activity replacements restore.
        let _ = APP.set(app.clone());
    }

    pub(crate) fn restore_if_needed() {
        let Some(app) = APP.get() else { return };
        let owner = app.clone();
        if let Err(error) = app.run_on_main_thread(move || {
            let needed = STATE
                .lock()
                .map(|state| state.needs_window())
                .unwrap_or(false);
            if !needed || owner.get_webview_window("main").is_some() {
                return;
            }
            let Some(config) = owner
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
            else {
                eprintln!("hub_activity phase=restore_failed reason=missing_main_config");
                return;
            };
            match tauri::WebviewWindowBuilder::from_config(&owner, config)
                .and_then(|builder| builder.build())
            {
                Ok(_) => eprintln!("hub_activity phase=main_window_restored"),
                Err(error) => eprintln!("hub_activity phase=restore_failed error={error}"),
            }
        }) {
            eprintln!("hub_activity phase=dispatch_failed error={error}");
        }
    }

    #[no_mangle]
    pub extern "system" fn Java_com_craftsearch_desktop_MainActivity_activityLifecycle(
        _env: JNIEnv,
        _activity: JObject,
        id: jint,
        stage: jint,
    ) {
        let Ok(mut state) = STATE.lock() else { return };
        match stage {
            1 => state.created(id),
            2 => state.webview_ready(id),
            3 => state.destroyed(id),
            4 => state.webview_cleanup_finished(id),
            _ => return,
        }
        eprintln!(
            "hub_activity phase={stage} instance={id} needs_window={}",
            state.needs_window()
        );
        drop(state);
        if stage == 1 || stage == 4 {
            restore_if_needed();
        }
    }
}

#[cfg(target_os = "android")]
pub(crate) use runtime::{initialize, restore_if_needed};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replacement_waits_until_old_webview_callbacks_are_removed() {
        let mut state = ActivityState::default();
        state.created(10);
        state.webview_ready(10);
        assert!(!state.needs_window());
        state.created(20);
        state.destroyed(10);
        assert!(!state.needs_window());
        state.webview_cleanup_finished(10);
        assert!(state.needs_window());
        state.webview_ready(10);
        assert!(state.needs_window());
        state.webview_ready(20);
        state.destroyed(10);
        state.webview_cleanup_finished(10);
        assert!(!state.needs_window());
    }

    #[test]
    fn destroy_before_replacement_waits_for_a_live_activity() {
        let mut state = ActivityState::default();
        state.created(10);
        state.webview_ready(10);
        state.destroyed(10);
        assert!(!state.needs_window());
        state.webview_cleanup_finished(10);
        state.created(20);
        assert!(state.needs_window());
        state.destroyed(20);
        assert!(!state.needs_window());
    }

    #[test]
    fn old_cleanup_does_not_clear_a_webview_rebound_on_configuration_change() {
        let mut state = ActivityState::default();
        state.created(10);
        state.webview_ready(10);
        state.destroyed(10);
        state.created(20);
        state.webview_ready(20);
        state.webview_cleanup_finished(10);
        assert!(!state.needs_window());
    }
}
