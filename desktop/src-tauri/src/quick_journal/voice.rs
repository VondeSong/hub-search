use super::*;

#[tauri::command]
pub(crate) async fn quick_journal_voice(
    app: AppHandle,
    action: String,
    token: Option<String>,
    offset: Option<u64>,
) -> Result<Value, String> {
    if ![
        "start",
        "pause",
        "resume",
        "stop",
        "status",
        "read",
        "chunk",
        "releaseChunks",
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
                json!({"action":action,"token":token.unwrap_or_default(),"offset":offset.unwrap_or(0)}),
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
        let _ = (app, token, offset);
        Err("请在 Android 客户端使用原生录音".into())
    }
}

#[tauri::command]
pub(crate) fn quick_journal_voice_draft(
    app: AppHandle,
    value: Option<String>,
    record_id: Option<String>,
) -> Result<String, String> {
    let (c, _guard) = open_write_database(&database_path(&app)?)?;
    if let Some(record_id) = record_id {
        if value.is_some() || !format::hex_id(&record_id, 32) {
            return Err("录音记录身份无效".into());
        }
        let value = metadata_string(&c, &format!("quick_journal_voice_transcripts:{record_id}"));
        return Ok(if value.is_empty() { "[]".into() } else { value });
    }
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
            if let Some(transcripts) = parsed.get("transcripts") {
                if !transcripts.is_array() {
                    return Err("转写结果格式无效".into());
                }
                meta(
                    &c,
                    &format!("quick_journal_voice_transcripts:{}", record.id),
                    &transcripts.to_string(),
                )?;
            }
        }
        meta(&c, "quick_journal_voice_draft", &value)?;
    }
    Ok(metadata_string(&c, "quick_journal_voice_draft"))
}

#[tauri::command]
pub(crate) fn quick_journal_audio(app: AppHandle, hash: String) -> Result<String, String> {
    let bytes = transcription_audio(&app, &hash)?;
    let mime = infer::get(&bytes).ok_or("音频格式暂不支持")?.mime_type();
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

pub(crate) fn transcription_audio(app: &AppHandle, hash: &str) -> Result<Vec<u8>, String> {
    let path = asset(&database_path(app)?, hash)?;
    if fs::metadata(&path).map_err(|_| "原音不在本机")?.len() > MAX_ATTACHMENT as u64 {
        return Err("原音超过附件限制".into());
    }
    let bytes = fs::read(path).map_err(|_| "原音不在本机")?;
    let kind = infer::get(&bytes).ok_or("音频格式暂不支持")?;
    let mime = kind.mime_type();
    if !mime.starts_with("audio/") && !["video/mp4", "video/webm"].contains(&mime) {
        return Err("不是可播放音频".into());
    }
    if digest(&bytes) != hash {
        return Err("原音校验失败，请重新同步附件。".into());
    }
    Ok(bytes)
}
