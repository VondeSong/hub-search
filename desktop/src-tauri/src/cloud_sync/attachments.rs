//! Device-local attachment admission; never changes remote identity or deletes files.
use super::*;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Selection {
    pub image: bool,
    pub video: bool,
    pub pdf: bool,
    pub other: bool,
    pub max_mb: u64,
}
impl Selection {
    pub(crate) fn all(max_mb: u64) -> Self {
        Self {
            image: true,
            video: true,
            pdf: true,
            other: true,
            max_mb,
        }
    }
    pub(crate) fn allows(&self, mime: &str, name: &str, size: u64) -> bool {
        let ext = Path::new(name)
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let selected = if mime.starts_with("image/")
            || matches!(
                ext.as_str(),
                "png" | "jpg" | "jpeg" | "gif" | "webp" | "heic" | "avif" | "svg"
            ) {
            self.image
        } else if mime.starts_with("video/")
            || matches!(ext.as_str(), "mp4" | "mov" | "webm" | "mkv" | "avi")
        {
            self.video
        } else if mime == "application/pdf" || ext == "pdf" {
            self.pdf
        } else {
            self.other
        };
        selected && size <= self.max_mb * 1024 * 1024
    }
    pub(crate) fn any(&self) -> bool {
        self.image || self.video || self.pdf || self.other
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Directions {
    pub upload: Selection,
    pub download: Selection,
}
pub(crate) fn limit(module: &str) -> Result<u64, String> {
    match module {
        "flashcards" => Ok(250),
        "reading" => Ok(100),
        "quick" => Ok(20),
        _ => Err("同步模块无效".into()),
    }
}
pub(crate) fn explicit(c: &Connection, module: &str) -> Result<Option<Directions>, String> {
    let raw = metadata_string(c, &format!("cloud_attachments_{module}_v1"));
    if raw.is_empty() {
        return Ok(None);
    }
    let p: Directions = serde_json::from_str(&raw).map_err(|_| "附件策略损坏，原配置保留")?;
    validate(module, &p)?;
    Ok(Some(p))
}
fn validate(module: &str, p: &Directions) -> Result<(), String> {
    let max = limit(module)?;
    for s in [&p.upload, &p.download] {
        if !(1..=max).contains(&s.max_mb) {
            return Err(format!("单附件上限须为 1–{max} MB"));
        }
    }
    Ok(())
}
pub(crate) fn policy(c: &Connection, module: &str) -> Result<Directions, String> {
    if let Some(p) = explicit(c, module)? {
        return Ok(p);
    }
    let max = limit(module)?;
    let mut p = Directions {
        upload: Selection::all(max),
        download: Selection::all(max),
    };
    if module == "reading" {
        let raw = metadata_string(c, "reading_media_policy");
        let old: Value = if raw.is_empty() {
            json!({})
        } else {
            serde_json::from_str(&raw).map_err(|_| "阅读附件旧配置损坏")?
        };
        if old["enabled"].as_bool() != Some(true) {
            p.upload = Selection {
                image: false,
                video: false,
                pdf: false,
                other: false,
                max_mb: max,
            };
        }
        // Preserve the old automatic image/PDF subset and its tighter size limit.
        p.download = Selection {
            image: old["enabled"].as_bool() == Some(true) && old["download"] == "all",
            pdf: old["enabled"].as_bool() == Some(true) && old["download"] == "all",
            video: false,
            other: false,
            max_mb: old["imageMb"]
                .as_u64()
                .unwrap_or(10)
                .min(old["documentMb"].as_u64().unwrap_or(20))
                .clamp(1, max),
        };
        // Legacy automatic uploads supported images/PDF only.
        p.upload.video = false;
        p.upload.other = false;
        p.upload.max_mb = old["imageMb"]
            .as_u64()
            .unwrap_or(10)
            .min(old["documentMb"].as_u64().unwrap_or(20))
            .clamp(1, max);
    } else if module == "flashcards"
        && metadata_string(c, "flashcard_cloud_media_policy") == "onDemand"
    {
        p.download = Selection {
            image: false,
            video: false,
            pdf: false,
            other: false,
            max_mb: max,
        };
    }
    Ok(p)
}
pub(crate) fn media_types(value: &Value) -> HashMap<String, String> {
    fn collect(v: &Value, out: &mut HashMap<String, String>) {
        match v {
            Value::Object(o) => {
                if let (Some(url), Some(mime)) = (
                    o.get("url").and_then(Value::as_str),
                    o.get("mimeType").and_then(Value::as_str),
                ) {
                    if let Some(hash) = url
                        .rsplit('/')
                        .next()
                        .filter(|h| h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit()))
                    {
                        out.insert(hash.into(), mime.into());
                    }
                }
                for child in o.values() {
                    collect(child, out)
                }
            }
            Value::Array(a) => {
                for child in a {
                    collect(child, out)
                }
            }
            Value::String(raw) if raw.starts_with('[') || raw.starts_with('{') => {
                if let Ok(child) = serde_json::from_str::<Value>(raw) {
                    collect(&child, out)
                }
            }
            _ => {}
        }
    }
    let mut out = HashMap::new();
    collect(value, &mut out);
    out
}
#[tauri::command]
pub(crate) fn get_cloud_attachment_policies(app: AppHandle) -> Result<Value, String> {
    let c = open_database(&database_path(&app)?)?;
    Ok(
        json!({"flashcards":policy(&c,"flashcards")?,"reading":policy(&c,"reading")?,"quick":policy(&c,"quick")?}),
    )
}
#[tauri::command]
pub(crate) async fn update_cloud_attachment_policy(
    app: AppHandle,
    module: String,
    settings: Directions,
) -> Result<Directions, String> {
    validate(&module, &settings)?;
    let _flash = FLASHCARD_SYNC_LOCK.lock().await;
    let _reading = reading_sync::LOCK.lock().await;
    let _quick = quick_journal::LOCK.lock().await;
    let (c, _writer) = open_write_database(&database_path(&app)?)?;
    c.execute("INSERT INTO metadata(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![format!("cloud_attachments_{module}_v1"),serde_json::to_string(&settings).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
    Ok(settings)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn types_size_and_legacy_are_independent() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)")
            .unwrap();
        c.execute(
            "INSERT INTO metadata VALUES('flashcard_cloud_media_policy','onDemand')",
            [],
        )
        .unwrap();
        let p = policy(&c, "flashcards").unwrap();
        assert!(!p.download.any());
        assert!(p.upload.any());
        let p = Selection {
            image: true,
            video: false,
            pdf: true,
            other: false,
            max_mb: 2,
        };
        assert!(p.allows("image/png", "", 2 * 1024 * 1024));
        assert!(!p.allows("image/png", "", 2 * 1024 * 1024 + 1));
        assert!(!p.allows("video/mp4", "", 1));
        assert!(!p.allows("audio/wav", "", 1));
        assert!(validate(
            "quick",
            &Directions {
                upload: Selection::all(21),
                download: p
            }
        )
        .is_err());
    }
}
