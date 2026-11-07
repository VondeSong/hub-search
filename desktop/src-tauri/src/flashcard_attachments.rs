use super::*;

pub(super) const MAX_BYTES: usize = 64 * 1024 * 1024;

fn media_hash(url: &str) -> Result<&str, String> {
    let hash = url
        .strip_prefix("http://craft-media.localhost/")
        .or_else(|| url.strip_prefix("craft-media://localhost/"))
        .or_else(|| url.strip_prefix("hub-media://localhost/"))
        .ok_or("请先将附件导入本地存储")?;
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("附件地址无效".into());
    }
    Ok(hash)
}

#[tauri::command]
pub(super) fn save_flashcard_attachment(
    app: AppHandle,
    url: String,
    destination: String,
    file_name: Option<String>,
    mime_type: Option<String>,
) -> Result<(), String> {
    let hash = media_hash(&url)?;
    #[cfg(target_os = "android")]
    if destination.is_empty() {
        let root = active_data_root(&app)?;
        let source = BlobStore::open(&root.join("blobs-v1"))?
            .path_for(hash)?
            .canonicalize()
            .map_err(|e| format!("无法读取附件：{e}"))?;
        // Native code persists and verifies a streaming snapshot before SAF opens.
        // The bridge carries metadata and a local path, never the binary payload.
        return app
            .state::<AndroidSourceOpener>()
            .0
            .run_mobile_plugin::<()>(
                "exportFlashcardAttachment",
                json!({"sourcePath":source.to_string_lossy(),"hash":hash.to_ascii_lowercase(),
                "fileName":file_name.unwrap_or_else(|| "附件".into()),
                "mimeType":mime_type.unwrap_or_else(|| "application/octet-stream".into())}),
            )
            .map_err(|e| format!("无法准备附件导出：{e}"));
    }
    #[cfg(target_os = "android")]
    if destination.starts_with("content://") {
        return Err("请使用附件保存按钮打开系统保存对话框".into());
    }
    #[cfg(not(target_os = "android"))]
    let _ = (file_name, mime_type);
    let target = Path::new(&destination);
    if !target.is_absolute() {
        return Err("保存位置必须是绝对路径".into());
    }
    let root = active_data_root(&app)?;
    let parent = target
        .parent()
        .ok_or("保存位置无效")?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if parent.starts_with(root.canonicalize().map_err(|e| e.to_string())?) {
        return Err("请选择 Hub 数据目录以外的保存位置".into());
    }
    let store = BlobStore::open(&root.join("blobs-v1"))?;
    fs::copy(store.path_for(hash)?, target).map_err(|e| e.to_string())?;
    Ok(())
}

pub(super) fn store(
    root: &Path,
    name: &str,
    declared: &str,
    bytes: &[u8],
    placement: &str,
) -> Result<Value, String> {
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err("附件为空或超过 64 MB".into());
    }
    if !matches!(placement, "question" | "answer" | "explanation") {
        return Err("placement 必须为 question、answer 或 explanation".into());
    }
    let name = name.rsplit(['/', '\\']).next().unwrap_or("附件").trim();
    if name.is_empty() {
        return Err("fileName 不能为空".into());
    }
    let extension = Path::new(name)
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let detected = infer::get(bytes).map(|v| match v.mime_type() {
        "audio/x-wav" => "audio/wav",
        other => other,
    });
    let mime = if extension == "svg" || declared == "image/svg+xml" {
        let svg = std::str::from_utf8(bytes).map_err(|_| "SVG 编码无效")?;
        hub_mcp::validate_flashcard_svg(svg)?;
        "image/svg+xml"
    } else {
        match extension.as_str() {
            "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "txt" | "md" | "csv" | "json" if std::str::from_utf8(bytes).is_ok() => "text/plain",
            _ => detected.unwrap_or("application/octet-stream"),
        }
    };
    let stored = BlobStore::open(&root.join("blobs-v1"))?.put(bytes)?;
    let connection = open_database(&root.join("craft-search.sqlite3"))?;
    connection.execute("INSERT INTO blobs(hash,size,mime_type,relative_path,created_at,verified_at) VALUES (?1,?2,?3,?4,?5,?5) ON CONFLICT(hash) DO UPDATE SET mime_type=excluded.mime_type,verified_at=excluded.verified_at",params![stored.hash,stored.size as i64,mime,stored.relative_path,now_timestamp()]).map_err(|e|e.to_string())?;
    Ok(
        json!({"title":name.chars().take(200).collect::<String>(),"mimeType":mime,"url":media_protocol_url(&stored.hash),"placement":placement,"byteSize":stored.size}),
    )
}

pub(super) fn import(root: &Path, args: &Value) -> Result<Value, String> {
    let path = args
        .get("filePath")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let encoded = args
        .get("dataBase64")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    if path.is_some() == encoded.is_some() {
        return Err("filePath 与 dataBase64 必须且只能提供一个".into());
    }
    let bytes = if let Some(path) = path {
        let path = Path::new(path);
        if !path.is_absolute() {
            return Err("filePath 必须是绝对路径".into());
        }
        let file = fs::File::open(path).map_err(|e| format!("无法读取附件：{e}"))?;
        if !file.metadata().map_err(|e| e.to_string())?.is_file() {
            return Err("请选择文件".into());
        }
        let mut bytes = Vec::new();
        std::io::Read::take(file, (MAX_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        bytes
    } else {
        let raw = encoded.unwrap();
        if raw.len() > (MAX_BYTES * 4 / 3) + 4 {
            return Err("附件超过 64 MB".into());
        }
        STANDARD
            .decode(raw)
            .map_err(|_| "dataBase64 不是有效的 Base64")?
    };
    let name = args
        .get("fileName")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or_else(|| path.and_then(|p| Path::new(p).file_name()?.to_str()))
        .ok_or("Base64 导入需要 fileName")?;
    let media = store(
        root,
        name,
        args.get("mimeType").and_then(Value::as_str).unwrap_or(""),
        &bytes,
        args.get("placement")
            .and_then(Value::as_str)
            .unwrap_or("answer"),
    )?;
    Ok(
        json!({"mediaId":format!("attachment:{}",media["url"].as_str().unwrap().rsplit('/').next().unwrap()),"media":media,"byteSize":bytes.len()}),
    )
}

#[tauri::command]
pub(super) fn import_flashcard_attachment(
    app: AppHandle,
    file_name: String,
    mime_type: String,
    data_base64: String,
    placement: Option<String>,
) -> Result<Value, String> {
    let result = import(
        &active_data_root(&app)?,
        &json!({"fileName":file_name,"mimeType":mime_type,"dataBase64":data_base64,"placement":placement.unwrap_or_else(||"answer".into())}),
    )?;
    Ok(result["media"].clone())
}

#[tauri::command]
pub(super) fn open_flashcard_attachment(
    app: AppHandle,
    url: String,
    file_name: String,
) -> Result<(), String> {
    let hash = url
        .strip_prefix("http://craft-media.localhost/")
        .or_else(|| url.strip_prefix("craft-media://localhost/"))
        .or_else(|| url.strip_prefix("hub-media://localhost/"))
        .ok_or("请先将附件导入本地存储")?;
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("附件地址无效".into());
    }
    let name = craft_export::sanitize_component(&file_name, "附件");
    let extension = Path::new(&name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(
        extension.as_str(),
        "pdf"
            | "doc"
            | "docx"
            | "xls"
            | "xlsx"
            | "ppt"
            | "pptx"
            | "odt"
            | "ods"
            | "odp"
            | "rtf"
            | "txt"
            | "md"
            | "csv"
            | "json"
            | "zip"
            | "7z"
            | "rar"
            | "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "svg"
            | "mp3"
            | "wav"
            | "ogg"
            | "m4a"
            | "flac"
            | "mp4"
            | "webm"
            | "mov"
    ) {
        return Err("此文件类型不支持直接打开，请从附件存储目录取出文件".into());
    }
    let root = active_data_root(&app)?;
    let store = BlobStore::open(&root.join("blobs-v1"))?;
    let source = store.path_for(hash)?;
    let folder = root.join("opened-attachments");
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let target = folder.join(format!("{}-{}", &hash[..12], name));
    fs::copy(source, &target).map_err(|e| e.to_string())?;
    tauri_plugin_opener::open_path(target, None::<&str>).map_err(|e| e.to_string())
}
