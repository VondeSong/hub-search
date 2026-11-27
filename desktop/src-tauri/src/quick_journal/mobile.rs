use super::*;
#[tauri::command]
pub(crate) async fn focus_quick_journal_editor(
    app: AppHandle,
    visible: Option<bool>,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    return app
        .state::<AndroidSourceOpener>()
        .0
        .run_mobile_plugin(
            "focusJournalEditor",
            json!({ "visible": visible.unwrap_or(true) }),
        )
        .map_err(|e| e.to_string());
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, visible);
        Ok(())
    }
}

#[tauri::command]
pub(crate) async fn add_quick_journal_tile(app: AppHandle) -> Result<Value, String> {
    #[cfg(target_os = "android")]
    return app
        .state::<AndroidSourceOpener>()
        .0
        .run_mobile_plugin("requestJournalTile", json!({}))
        .map_err(|e| e.to_string());
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("控制中心入口只在 Android 提供".into())
    }
}
#[tauri::command]
pub(crate) async fn journal_mobile_action(app: AppHandle) -> Result<Value, String> {
    #[cfg(target_os = "android")]
    return app
        .state::<AndroidSourceOpener>()
        .0
        .run_mobile_plugin("consumeJournalAction", json!({}))
        .map_err(|e| e.to_string());
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(json!({}))
    }
}
#[tauri::command]
pub(crate) async fn share_quick_journal(app: AppHandle, text: String) -> Result<(), String> {
    if text.len() > format::MAX_TEXT {
        return Err("分享正文超过限制".into());
    }
    #[cfg(target_os = "android")]
    return app
        .state::<AndroidSourceOpener>()
        .0
        .run_mobile_plugin("shareJournal", json!({"text":text}))
        .map_err(|e| e.to_string());
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, text);
        Err("请在手机端使用系统分享，电脑端可复制正文".into())
    }
}
