use super::*;

#[tauri::command]
pub(crate) async fn quick_journal_voice(
    app: AppHandle,
    action: String,
    token: Option<String>,
) -> Result<Value, String> {
    if ![
        "start",
        "pause",
        "resume",
        "stop",
        "status",
        "read",
        "acknowledge",
    ]
    .contains(&action.as_str())
    {
        return Err("录音操作无效".into());
    }
    #[cfg(target_os = "android")]
    {
        let result: Value = app
            .state::<AndroidSourceOpener>()
            .0
            .run_mobile_plugin(
                "journalVoice",
                json!({"action":action,"token":token.unwrap_or_default()}),
            )
            .map_err(|e| e.to_string())?;
        if action == "read" {
            let attachment = stage_quick_journal_attachment(
                app,
                result["name"].as_str().ok_or("缺少录音名称")?.to_owned(),
                result["content"].as_str().ok_or("缺少录音内容")?.to_owned(),
            )?;
            return serde_json::to_value(attachment).map_err(|e| e.to_string());
        }
        Ok(result)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, token);
        Err("请在 Android 客户端使用原生录音".into())
    }
}

#[tauri::command]
pub(crate) fn quick_journal_voice_draft(
    app: AppHandle,
    value: Option<String>,
) -> Result<String, String> {
    let (c, _guard) = open_write_database(&database_path(&app)?)?;
    if let Some(value) = value {
        if value.len() > 200_000 {
            return Err("语音草稿过大".into());
        }
        if !value.is_empty() {
            let parsed: Value = serde_json::from_str(&value).map_err(|_| "语音草稿格式无效")?;
            let record: Record =
                serde_json::from_value(parsed["record"].clone()).map_err(|_| "语音记录格式无效")?;
            if !format::hex_id(&record.id, 32)
                || !format::valid_date(&record.date)
                || record.attachments.len() > 9
                || record.text.len() > format::MAX_TEXT
            {
                return Err("语音记录身份或内容无效".into());
            }
        }
        meta(&c, "quick_journal_voice_draft", &value)?;
    }
    Ok(metadata_string(&c, "quick_journal_voice_draft"))
}

#[tauri::command]
pub(crate) fn quick_journal_audio(app: AppHandle, hash: String) -> Result<String, String> {
    let path = asset(&database_path(&app)?, &hash)?;
    if fs::metadata(&path).map_err(|_| "原音不在本机")?.len() > MAX_ATTACHMENT as u64 {
        return Err("原音超过附件限制".into());
    }
    let bytes = fs::read(path).map_err(|_| "原音不在本机")?;
    let kind = infer::get(&bytes).ok_or("音频格式暂不支持")?;
    let mime = kind.mime_type();
    if !mime.starts_with("audio/") && !["video/mp4", "video/webm"].contains(&mime) {
        return Err("不是可播放音频".into());
    }
    use base64::Engine;
    Ok(format!(
        "data:{};base64,{}",
        if mime == "video/mp4" {
            "audio/mp4"
        } else {
            mime
        },
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}
