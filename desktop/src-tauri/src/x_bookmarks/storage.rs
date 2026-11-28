//! Device-local preferences and a replayable projection into an Obsidian vault.
use super::*;
use std::io::Write;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
pub(crate) mod relocation;
mod titles;
tokio::task_local! { static INDEPENDENT_EXPORT: bool; }
fn cancelled() -> bool {
    CANCEL.load(Ordering::Relaxed) && !INDEPENDENT_EXPORT.try_with(|value| *value).unwrap_or(false)
}

#[tauri::command]
pub(crate) async fn discard_partial_media_downloads(app: AppHandle) -> Result<String, String> {
    // Pausing is separate. Explicit discard waits until the export owner is idle.
    let _guard = SYNC_LOCK
        .try_lock()
        .map_err(|_| "请先暂停附件保存，等待当前下载结束后再清理")?;
    let c = open_database(&database_path(&app)?)?;
    let mut query = c
        .prepare("SELECT root FROM collection_roots")
        .map_err(|e| e.to_string())?;
    let roots = query
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut count = 0;
    for root in roots {
        for directory in ["X_assets", "Telegram_assets", "Dida_assets"] {
            count += crate::partial_download::clear(
                &Path::new(&root).join("99_Meta/assets").join(directory),
            )?;
        }
    }
    Ok(format!("已取消并清理 {count} 个未完成下载；完整附件保留"))
}

pub(crate) fn display_title(item: &Item) -> String {
    titles::display_title(item)
}

pub(super) fn migrate_titles(app: &AppHandle) -> Result<(), String> {
    titles::migrate(app)
}

const CONFIG: &str = "collection_storage_v1";
const ASSETS: &str = "99_Meta/assets/X_assets";
static DOWNLOADED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static EXPORTING: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct StorageConfig {
    pub(crate) mode: String,
    pub(crate) vault_path: String,
    pub(super) download_media: bool,
    pub(crate) auto_sync_minutes: u32,
    pub(crate) local_sources_minutes: u32,
}
impl Default for StorageConfig {
    fn default() -> Self {
        Self {
            mode: "database".into(),
            vault_path: String::new(),
            download_media: true,
            auto_sync_minutes: 30,
            local_sources_minutes: 0,
        }
    }
}
pub(crate) fn schema(c: &Connection) -> Result<(), String> {
    super::schema(c)?;
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS collection_obsidian_exports(
        destination TEXT NOT NULL, item_key TEXT NOT NULL, relative_path TEXT NOT NULL,
        file_hash TEXT NOT NULL, input_hash TEXT NOT NULL, media_pending INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(destination,item_key));
        CREATE TABLE IF NOT EXISTS collection_saved_media(
            item_key TEXT NOT NULL, media_url TEXT NOT NULL, path TEXT NOT NULL,
            PRIMARY KEY(item_key,media_url));",
    )
    .map_err(|e| e.to_string())?;
    crate::local_database_maintenance::ensure_sequences(
        c,
        &["collection_obsidian_exports", "collection_saved_media"],
    )
}
pub(crate) fn config(c: &Connection) -> Result<StorageConfig, String> {
    let value = metadata_string(c, CONFIG);
    if value.is_empty() {
        Ok(StorageConfig::default())
    } else {
        serde_json::from_str(&value).map_err(|_| "保存位置设置损坏，请重新设置".into())
    }
}
pub(super) fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub(super) fn relocate_vault_preferences(
    c: &Connection,
    old: &Path,
    new: &Path,
) -> Result<(), String> {
    let mut cfg = config(c)?;
    if cfg.mode == "obsidian"
        && crate::library_location::path_key(Path::new(&cfg.vault_path))
            == crate::library_location::path_key(old)
    {
        cfg.vault_path = crate::sources::display_local_path(new);
        meta(
            c,
            CONFIG,
            &serde_json::to_string(&cfg).map_err(|e| e.to_string())?,
        )?;
    }
    Ok(())
}

fn validate_intervals(config: &StorageConfig) -> Result<(), String> {
    if config.auto_sync_minutes != 0 && !(5..=1440).contains(&config.auto_sync_minutes) {
        return Err("自动同步间隔需为 5–1440 分钟；0 表示仅手动".into());
    }
    if config.local_sources_minutes != 0 && !(5..=1440).contains(&config.local_sources_minutes) {
        return Err("本地素材检查间隔需为 5–1440 分钟；0 表示仅手动".into());
    }
    Ok(())
}
fn validate(config: &StorageConfig) -> Result<Option<PathBuf>, String> {
    validate_intervals(config)?;
    if !matches!(config.mode.as_str(), "database" | "obsidian") {
        return Err("请选择本地数据库或 Obsidian".into());
    }
    if config.mode == "database" {
        return Ok(None);
    }
    let root = Path::new(config.vault_path.trim());
    if !root.is_absolute() || !root.is_dir() {
        return Err("请选择已存在的 Obsidian 库根目录".into());
    }
    let root = fs::canonicalize(root).map_err(|_| "无法访问所选库目录")?;
    for relative in [
        "X/书签",
        "X/喜欢",
        "Telegram/收集",
        "滴答/稍后读",
        ASSETS,
        "99_Meta/assets/Telegram_assets",
        "99_Meta/assets/Dida_assets",
    ] {
        safe_path(&root, relative, true)?;
    }
    Ok(Some(root))
}

// Resolve each existing component before creating a descendant; reject junction/symlink escapes.
fn safe_path(root: &Path, relative: &str, directory: bool) -> Result<PathBuf, String> {
    let parts: Vec<_> = relative.split('/').collect();
    if parts.is_empty()
        || parts.iter().any(|p| {
            p.is_empty()
                || *p == "."
                || *p == ".."
                || p.contains(['\\', ':'])
                || p.ends_with([' ', '.'])
        })
    {
        return Err("库内路径无效".into());
    }
    let mut path = root.to_path_buf();
    for (index, part) in parts.iter().enumerate() {
        path.push(part);
        let must_be_dir = directory || index + 1 < parts.len();
        if fs::symlink_metadata(&path).is_ok() {
            let resolved = fs::canonicalize(&path).map_err(|_| "库内路径不可访问")?;
            if !resolved.starts_with(root) {
                return Err("库内路径指向库外，已停止写入".into());
            }
            if must_be_dir && !resolved.is_dir() {
                return Err("目标文件夹被同名文件占用".into());
            }
            if !must_be_dir && !resolved.is_file() {
                return Err("目标页面不是普通文件".into());
            }
        } else if must_be_dir {
            fs::create_dir(&path).map_err(|e| format!("无法创建库内文件夹：{e}"))?;
        }
    }
    Ok(path)
}
fn quoted(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into())
}
fn published(value: &str) -> String {
    chrono::DateTime::parse_from_str(value, "%a %b %d %H:%M:%S %z %Y")
        .or_else(|_| chrono::DateTime::parse_from_rfc3339(value))
        .map(|v| {
            v.with_timezone(&chrono::Local)
                .format("%Y-%m-%dT%H:%M:%S")
                .to_string()
        })
        .unwrap_or_default()
}
fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\\', "\\\\")
        .replace('[', "\\[")
        .replace(']', "\\]")
        .replace('*', "\\*")
        .replace('_', "\\_")
        .replace('`', "\\`")
        .replace('#', "\\#")
        .replace('!', "\\!")
}
pub(crate) fn render(item: &Item, media: &[Option<String>]) -> String {
    let post = &item.post;
    let created = chrono::DateTime::from_timestamp_millis(item.collected_at)
        .map(|v| {
            v.with_timezone(&chrono::Local)
                .format("%Y-%m-%dT%H:%M:%S")
                .to_string()
        })
        .unwrap_or_default();
    let author = if post.author_handle.is_empty() {
        post.author_name.clone()
    } else {
        format!("{} (@{})", post.author_name, post.author_handle)
    };
    let mut text = format!("---\n喜欢: {}\n标签: []\n状态: {}\n发布时间: {}\n作者: {}\n地址: {}\n创建日期: {}\n---\n\n# {}\n\n{}\n",
        post.liked || post.source == "likes", quoted(if item.read {"已读"} else {"待读"}),
        quoted(&published(&post.published_at)), quoted(&author), quoted(&post.url), quoted(&created), escape(&display_title(item)), "");
    text.push_str(&render_content(item, media));
    text
}

pub(crate) fn render_task_content(item: &Item) -> String {
    let mut text = String::new();
    if item.post.thread.is_empty() {
        text.push_str(&format!(
            "{} · {}\n\n",
            escape(&format!(
                "{} @{}",
                item.post.author_name, item.post.author_handle
            )),
            published(&item.post.published_at).replace('T', " ")
        ));
    }
    text.push_str(&render_content(
        item,
        &vec![None; threads::assets(&item.post).len()],
    ));
    text
}

fn render_content(item: &Item, media: &[Option<String>]) -> String {
    let post = &item.post;
    let mut text = String::new();
    let paths: HashMap<String, Option<String>> = threads::assets(post)
        .iter()
        .zip(media)
        .map(|(asset, path)| (asset.url.clone(), path.clone()))
        .collect();
    let parts = threads::parts(post);
    let mut embedded = HashSet::new();
    for (index, part) in parts.iter().enumerate() {
        if !post.thread.is_empty() {
            text.push_str(&format!(
                "{}[{}](<{}>) · {}\n\n",
                if index > 0 { "\n## " } else { "" },
                escape(&format!("{} @{}", part.author_name, part.author_handle)),
                part.url,
                published(&part.published_at).replace('T', " ")
            ));
            if !part.reply_to_id.is_empty() && part.reply_to_id != post.id {
                let parent = if !part.reply_to_handle.is_empty() {
                    format!("@{}", part.reply_to_handle)
                } else {
                    parts
                        .iter()
                        .find(|parent| parent.id == part.reply_to_id)
                        .map(|parent| parent.author_name.clone())
                        .unwrap_or_else(|| "原帖".into())
                };
                text.push_str(&format!(
                    "[回复 {}](<https://x.com/i/status/{}>)\n\n",
                    escape(&parent),
                    part.reply_to_id
                ));
            }
        }
        text.push_str(&render_body(part, &paths, &mut embedded));
    }
    let pending = matches!(post.thread_status.as_str(), "pending" | "partial")
        || (post.thread_format < 2 && post.reply_count > 0);
    if !post.thread.is_empty() || pending || post.thread_status == "limited" {
        text.push_str(&format!(
            "\n---\n\n已获取 {} 条回复 · X 显示 {} 条\n",
            post.thread.len(),
            post.reply_count
        ));
        if pending {
            text.push_str("\n回复尚待补全，可更新内容或在下次同步继续。\n");
        }
        if post.thread_status == "limited" {
            text.push_str(&format!(
                "\n{}，可更新内容重试。\n",
                if post.thread_error.is_empty() {
                    "X 本次未返回更多可访问的回复"
                } else {
                    &post.thread_error
                }
            ));
        }
    }
    text.push_str(&format!(
        "\n[打开{}](<{}>)\n",
        if post.source == "dida" {
            " 滴答来源"
        } else if post.source == "telegram" {
            " Telegram 来源"
        } else {
            " X 原文"
        },
        post.url.replace('>', "%3E")
    ));
    text
}

fn render_body(
    post: &Post,
    paths: &HashMap<String, Option<String>>,
    embedded: &mut HashSet<String>,
) -> String {
    let mut text = String::new();
    if let Some(origin) = &post.origin {
        text.push_str(&format!(
            "转发自 {}{}\n\n",
            escape(&origin.name),
            if origin.url.is_empty() {
                String::new()
            } else {
                format!(" · [原始消息](<{}>)", origin.url.replace('>', "%3E"))
            }
        ));
    }
    text.push_str(&format!("{}\n", escape(&post.text)));
    let media = post
        .media
        .iter()
        .filter(|asset| {
            embedded.insert(if asset.url.is_empty() {
                asset.preview_url.clone()
            } else {
                asset.url.clone()
            })
        })
        .collect::<Vec<_>>();
    if !media.is_empty() && post.quote.is_some() {
        text.push_str("\n**本帖附件**\n");
    }
    for asset in media {
        if let Some(Some(path)) = paths.get(&asset.url) {
            text.push_str(&format!("\n![[{path}]]\n"));
        } else if let Some(url) = safe_url(&asset.url) {
            text.push_str(&format!(
                "\n[{} · 原始链接](<{}>)\n",
                if asset.kind == "photo" {
                    "图片"
                } else {
                    "视频"
                },
                url.replace('>', "%3E")
            ));
        } else {
            text.push_str("\n媒体未返回可下载地址，请查看原文。\n");
        }
    }
    for link in &post.links {
        if let Some(url) = safe_url(link) {
            if !post.text.contains(&url) {
                text.push_str(&format!("\n[外部链接](<{}>)\n", url.replace('>', "%3E")));
            }
        }
    }
    if let Some(quote) = &post.quote {
        let body = format!(
            "**引用原帖 · {} @{}** · [原帖](<{}>) · {}\n\n{}",
            escape(&quote.author_name),
            escape(&quote.author_handle),
            quote.url,
            published(&quote.published_at).replace('T', " "),
            render_body(quote, paths, embedded)
        );
        text.push_str(&format!("\n> {}\n", body.trim_end().replace('\n', "\n> ")));
    } else if !post.quoted_text.is_empty() {
        text.push_str(&format!(
            "\n> {}\n",
            escape(&post.quoted_text).replace('\n', "\n> ")
        ));
    } else if !post.quote_id.is_empty() {
        text.push_str(&format!(
            "\n[引用原帖](<https://x.com/i/status/{}>) · 引用内容暂不可用\n",
            post.quote_id
        ));
    }
    if post.content_status == "partial" {
        text.push_str("\n正文可能不完整，请打开原文查看长文章。\n");
    }
    text
}

struct TempFile(PathBuf);
impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
fn write_note(path: &Path, text: &str, expected: Option<&str>) -> Result<bool, String> {
    if path.exists() {
        let current = fs::read(path).map_err(|_| "无法读取已有页面")?;
        if current == text.as_bytes() {
            return Ok(true);
        }
        if expected != Some(hash(&current).as_str()) {
            return Ok(false);
        }
    } else if expected.is_some() {
        // A user may have moved/deleted a note. Recreating at its stable path is intentional on retry.
    }
    let temp = TempFile(path.with_extension(format!("{}.tmp", random_url_safe(12))));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp.0)
        .map_err(|e| e.to_string())?;
    file.write_all(text.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    drop(file);
    // Check again after preparation so edits made during a download are never overwritten.
    if path.exists() && expected != Some(hash(&fs::read(path).map_err(|e| e.to_string())?).as_str())
    {
        return Ok(false);
    }
    if !path.exists() {
        fs::hard_link(&temp.0, path).map_err(|e| format!("无法创建页面：{e}"))?;
    } else {
        fs::rename(&temp.0, path).map_err(|e| format!("无法更新页面：{e}"))?;
    }
    Ok(true)
}
pub(crate) fn commit_note(
    c: &Connection,
    path: &Path,
    text: &str,
    expected: Option<&str>,
    destination: &str,
    key: &str,
    relative: &str,
    input: &str,
    media_pending: bool,
) -> Result<bool, String> {
    let written = write_note(path, text, expected)?;
    if written {
        c.execute("INSERT INTO collection_obsidian_exports(destination,item_key,relative_path,file_hash,input_hash,media_pending) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(destination,item_key) DO UPDATE SET relative_path=excluded.relative_path,file_hash=excluded.file_hash,input_hash=excluded.input_hash,media_pending=excluded.media_pending",params![destination,key,relative,hash(text.as_bytes()),input,media_pending]).map_err(|e|e.to_string())?;
    }
    Ok(written)
}
fn asset_url(value: &str) -> Option<Url> {
    let url = Url::parse(value).ok()?;
    (url.scheme() == "https"
        && matches!(url.host_str(), Some("pbs.twimg.com" | "video.twimg.com"))
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none())
    .then_some(url)
}
async fn download(
    app: &AppHandle,
    client: &reqwest::Client,
    root: &Path,
    media: &Media,
    cached: Option<&Path>,
    used: &mut u64,
) -> Result<String, String> {
    if media.url.starts_with("dida:") {
        let (name, blob_hash) =
            super::dida_reading::local_asset(&open_database(&database_path(app)?)?, &media.url)?;
        let extension = Path::new(&name)
            .extension()
            .and_then(|e| e.to_str())
            .filter(|e| {
                !e.is_empty() && e.len() <= 16 && e.bytes().all(|b| b.is_ascii_alphanumeric())
            })
            .unwrap_or("bin");
        let relative = format!(
            "99_Meta/assets/Dida_assets/{}-{}.{}",
            hash(media.url.as_bytes()),
            blob_hash,
            extension
        );
        let path = safe_path(root, &relative, false)?;
        if path.is_file() && fs::metadata(&path).is_ok_and(|m| m.len() > 0) {
            return Ok(relative);
        }
        let source = if let Some(cached) = cached.filter(|p| p.is_file()) {
            cached.to_path_buf()
        } else {
            blob_store_for(app, &app.state::<AppState>())?.path_for(&blob_hash)?
        };
        // Dida originals also include documents and audio. The existing bounded
        // local copy routine's general-file mode preserves them byte for byte.
        if copy_completed_asset(&source, &path, true).await? {
            return Ok(relative);
        }
        return Err("滴答原附件本地复制未完成".into());
    }
    if media.url.starts_with("telegram:") {
        let relative = format!(
            "99_Meta/assets/Telegram_assets/{}.{}",
            hash(media.url.as_bytes()),
            crate::telegram::media_extension(media)
        );
        let path = safe_path(root, &relative, false)?;
        if path.exists() {
            if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 0 {
                return Ok(relative);
            }
            return Err("同名附件为空，请移走后重试".into());
        }
        if let Some(cached) = cached.filter(|p| p.is_file()) {
            if copy_completed_asset(cached, &path, true).await? {
                return Ok(relative);
            }
        }
        let cloud = if media.url.contains("/tdl_") {
            Err("历史附件通过 tdl 下载".into())
        } else {
            let partial = crate::partial_download::Partial::open(&path, &media.url, None)?;
            let resume = partial
                .validator()
                .map(|v| (partial.length(), v.to_string()))
                .filter(|(n, _)| *n > 0);
            crate::telegram::download_response(app, client, &media.url, resume).await
        };
        match cloud {
            Ok(response) => save_response(response, &path, &media.url, used, true).await?,
            Err(cloud_error) => {
                if !crate::telegram::tdl::download(app, &media.url, &path).await? {
                    return Err(format!(
                        "{cloud_error}；可在 Telegram 历史与大附件中登录 tdl 并补取历史"
                    ));
                }
                let size = fs::metadata(&path).map_err(|_| "无法读取 tdl 附件")?.len();
                *used = used.saturating_add(size);
                DOWNLOADED.store(*used, Ordering::Relaxed);
                jobs::bytes(size, *used);
            }
        }
        return Ok(relative);
    }
    let url = asset_url(&media.url).ok_or("该媒体没有受支持的直链")?;
    let extension = if media.kind == "photo" {
        url.query_pairs()
            .find(|(k, _)| k == "format")
            .map(|(_, v)| v.into_owned())
            .or_else(|| {
                Path::new(url.path())
                    .extension()
                    .and_then(|v| v.to_str())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "jpg".into())
    } else {
        "mp4".into()
    };
    if !matches!(
        extension.as_str(),
        "jpg" | "jpeg" | "png" | "webp" | "gif" | "mp4"
    ) {
        return Err("不支持此媒体格式".into());
    }
    let relative = format!("{ASSETS}/{}.{}", hash(url.as_str().as_bytes()), extension);
    let path = safe_path(root, &relative, false)?;
    if path.exists() {
        if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 0 {
            return Ok(relative);
        }
        return Err("同名附件为空，请移走后重试".into());
    }
    if let Some(cached) = cached.filter(|p| p.is_file()) {
        if copy_completed_asset(cached, &path, false).await? {
            return Ok(relative);
        }
    }
    // Media requests deliberately carry no X session headers. Never follow a redirect with credentials.
    let partial = crate::partial_download::Partial::open(&path, &media.url, None)?;
    let mut request = client.get(url);
    if let Some(validator) = partial.validator().filter(|_| partial.length() > 0) {
        request = request
            .header("Range", format!("bytes={}-", partial.length()))
            .header("If-Range", validator);
    }
    let response = request.send().await.map_err(|_| "媒体连接失败")?;
    if !response.status().is_success() {
        return Err(format!("媒体 HTTP {}", response.status().as_u16()));
    }
    save_response(response, &path, &media.url, used, false).await?;
    Ok(relative)
}
// Reuse completed downloads when the user changes the save destination.
// Bounded buffers and a temporary destination also cover multi-gigabyte local copies.
async fn copy_completed_asset(
    source: &Path,
    destination: &Path,
    telegram: bool,
) -> Result<bool, String> {
    let mut input = tokio::fs::File::open(source)
        .await
        .map_err(|_| "无法读取已下载附件")?;
    let mut prefix = vec![0u8; 8192];
    let size = input
        .read(&mut prefix)
        .await
        .map_err(|_| "无法读取已下载附件")?;
    let mime = infer::get(&prefix[..size])
        .map(|t| t.mime_type())
        .unwrap_or("");
    if size == 0 || (!telegram && !(mime.starts_with("image/") || mime == "video/mp4")) {
        return Ok(false);
    }
    let temp = TempFile(destination.with_extension(format!("{}.part", random_url_safe(12))));
    let mut output = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp.0)
        .await
        .map_err(|e| e.to_string())?;
    output
        .write_all(&prefix[..size])
        .await
        .map_err(|_| "附件复制失败，请检查可用空间")?;
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        if cancelled() {
            return Err("已暂停本地复制".into());
        }
        library::control::checkpoint()?;
        let size = input
            .read(&mut buffer)
            .await
            .map_err(|_| "本地附件读取中断")?;
        if size == 0 {
            break;
        }
        output
            .write_all(&buffer[..size])
            .await
            .map_err(|_| "附件复制失败，请检查可用空间")?;
    }
    output.sync_all().await.map_err(|e| e.to_string())?;
    drop(output);
    library::control::commit(|| {
        fs::hard_link(&temp.0, destination).map_err(|e| format!("无法保存复制的附件：{e}"))
    })?;
    Ok(true)
}
async fn save_response(
    mut response: reqwest::Response,
    path: &Path,
    identity: &str,
    used: &mut u64,
    telegram: bool,
) -> Result<(), String> {
    let mut partial = crate::partial_download::Partial::open(path, identity, None)?;
    let etag = response
        .headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .filter(|s| s.starts_with('"') && s.ends_with('"') && !s.starts_with("W/"))
        .map(str::to_owned);
    let mut range_total = None;
    let offset = if response.status() == reqwest::StatusCode::PARTIAL_CONTENT {
        let offset = partial.length();
        let range = response
            .headers()
            .get("content-range")
            .and_then(|v| v.to_str().ok())
            .ok_or("续传响应缺少字节范围，已保留分片")?;
        let tuple = range
            .strip_prefix("bytes ")
            .and_then(|v| v.split_once('/'))
            .and_then(|(part, total)| {
                part.split_once('-').and_then(|(start, end)| {
                    Some((
                        start.parse::<u64>().ok()?,
                        end.parse::<u64>().ok()?,
                        total.parse::<u64>().ok()?,
                    ))
                })
            });
        if offset == 0
            || tuple.is_none_or(|(start, end, total)| {
                start != offset
                    || end.checked_add(1) != Some(total)
                    || response
                        .content_length()
                        .is_some_and(|n| n != total.saturating_sub(offset))
            })
            || etag.as_deref() != partial.validator()
            || etag.is_none()
        {
            return Err("续传响应的范围或版本不匹配，未拼接分片".into());
        }
        range_total = tuple.map(|(_, _, total)| total);
        offset
    } else if response.status() == reqwest::StatusCode::OK {
        0
    } else {
        return Err("媒体服务器未返回可保存的内容".into());
    };
    let expected =
        range_total.or_else(|| response.content_length().map(|n| n.saturating_add(offset)));
    partial.budget(response.content_length().unwrap_or(0))?;
    if offset == 0 {
        partial.reset()?;
    }
    partial.set_validator(etag)?;
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(offset == 0)
        .append(offset > 0)
        .open(partial.data())
        .await
        .map_err(|e| e.to_string())?;
    jobs::media(response.content_length());
    let mut total = offset;
    let mut checkpointed = offset;
    let mut hasher = Sha256::new();
    if offset > 0 {
        let mut original = tokio::fs::File::open(partial.data())
            .await
            .map_err(|e| e.to_string())?;
        // This buffer survives an await. Keep it off the coroutine frame: the
        // complete desktop archive chain nests several material-preparation
        // futures and must fit the Windows worker stack even before polling.
        let mut buffer = vec![0u8; 65536];
        loop {
            let n = original
                .read(&mut buffer)
                .await
                .map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            hasher.update(&buffer[..n]);
        }
    }
    let mut signature = if offset > 0 {
        let mut input = tokio::fs::File::open(partial.data())
            .await
            .map_err(|e| e.to_string())?;
        let mut prefix = vec![0; 8192];
        let n = input.read(&mut prefix).await.map_err(|e| e.to_string())?;
        prefix.truncate(n);
        prefix
    } else {
        Vec::new()
    };
    loop {
        if cancelled() {
            return Err("已暂停下载".into());
        }
        library::control::checkpoint()?;
        let mut pending = Box::pin(response.chunk());
        let chunk = loop {
            tokio::select! {
                chunk = &mut pending => break chunk.map_err(|_| "媒体下载中断，保留原链接，可重试")?,
                _ = tokio::time::sleep(Duration::from_millis(250)) => {
                    if cancelled() { return Err("已暂停下载，续传数据已保留".into()) }
                    library::control::checkpoint()?;
                }
            }
        };
        let Some(chunk) = chunk else {
            break;
        };
        partial.budget(chunk.len() as u64)?;
        total = total.saturating_add(chunk.len() as u64);
        *used = used.saturating_add(chunk.len() as u64);
        DOWNLOADED.store(*used, Ordering::Relaxed);
        jobs::bytes(total, *used);
        if signature.len() < 8192 {
            signature.extend_from_slice(&chunk[..chunk.len().min(8192 - signature.len())]);
        }
        library::control::checkpoint()?;
        file.write_all(&chunk)
            .await
            .map_err(|_| "附件写入失败，请检查可用空间")?;
        hasher.update(&chunk);
        if checkpointed == offset || total.saturating_sub(checkpointed) >= 4 * 1024 * 1024 {
            file.sync_all().await.map_err(|e| e.to_string())?;
            partial.checkpoint(total, format!("{:x}", hasher.clone().finalize()))?;
            checkpointed = total;
        }
    }
    let mime = infer::get(&signature).map(|t| t.mime_type()).unwrap_or("");
    if expected.is_some_and(|n| n != total) {
        return Err("媒体长度不完整，已保留续传数据".into());
    }
    if total == 0 || (!telegram && !(mime.starts_with("image/") || mime == "video/mp4")) {
        drop(file);
        partial.discard()?;
        return Err("媒体内容不是可识别的图片或 MP4".into());
    }
    file.sync_all().await.map_err(|e| e.to_string())?;
    drop(file);
    // create-without-overwrite: another writer may have created the same attachment.
    library::control::commit(|| {
        fs::hard_link(partial.data(), &path).map_err(|e| format!("无法保存附件：{e}"))
    })?;
    partial.discard()?;
    Ok(())
}

struct Row {
    item: Item,
    input: String,
}
fn rows(c: &Connection, only: Option<&str>, cfg: &StorageConfig) -> Result<Vec<Row>, String> {
    let mut statement = c.prepare("SELECT item_key,post_json,collected_at,read_at,read_version,content_hash FROM collection_x_items WHERE (?1 IS NULL OR item_key=?1) AND (?1 IS NOT NULL OR NOT EXISTS(SELECT 1 FROM collection_local_source_items p WHERE p.item_key=collection_x_items.item_key)) AND (?1 IS NOT NULL OR NOT EXISTS(SELECT 1 FROM reading_cloud_passive p WHERE p.item_key=collection_x_items.item_key)) ORDER BY collected_at DESC,item_key").map_err(|e|e.to_string())?;
    let iter = statement
        .query_map([only], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, String>(5)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    // Scheduling changes do not invalidate already generated notes.
    let cfg_hash =
        json!({"mode":cfg.mode,"vaultPath":cfg.vault_path,"downloadMedia":cfg.download_media,"noteFormat":4})
            .to_string();
    let mut result = Vec::new();
    for row in iter {
        let (key, body, collected_at, read_at, version, content) =
            row.map_err(|e| e.to_string())?;
        result.push(Row {
            item: Item {
                key,
                post: serde_json::from_str(&body).map_err(|_| "收藏内容损坏")?,
                collected_at,
                read: read_at > 0,
            },
            input: hash(format!("{content}:{version}:{cfg_hash}").as_bytes()),
        });
    }
    Ok(result)
}

#[cfg(test)]
#[test]
fn reading_sync_passive_items_require_an_explicit_export_request() {
    let mut c = Connection::open_in_memory().unwrap();
    c.execute_batch("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)")
        .unwrap();
    super::reading_sync_test_import(
        &mut c,
        Post {
            id: "passive".into(),
            ..Post::default()
        },
    );
    let key = "x:test-account:passive";
    assert_eq!(rows(&c, None, &StorageConfig::default()).unwrap().len(), 1);
    c.execute("INSERT INTO reading_cloud_passive VALUES(?1)", [key])
        .unwrap();
    assert!(rows(&c, None, &StorageConfig::default())
        .unwrap()
        .is_empty());
    assert_eq!(
        rows(&c, Some(key), &StorageConfig::default())
            .unwrap()
            .len(),
        1
    );
}
fn status(app: &AppHandle, message: &str) -> Result<(), String> {
    let (c, _writer) = open_write_database(&database_path(app)?)?;
    jobs::update(|p| p.message = message.into());
    meta(&c, "collection_export_status", message)
}

pub(super) async fn export(app: &AppHandle, only: Option<&str>) -> Result<String, String> {
    EXPORTING.store(true, Ordering::Relaxed);
    DOWNLOADED.store(0, Ordering::Relaxed);
    let result = export_inner(app, only).await;
    EXPORTING.store(false, Ordering::Relaxed);
    let _ = status(
        app,
        result
            .as_ref()
            .map(String::as_str)
            .unwrap_or_else(|e| e.as_str()),
    );
    result
}
// Update only owned frontmatter; no job, HTTP request, or attachment work.
pub(super) fn update_properties(app: &AppHandle, key: &str) -> Result<String, String> {
    let (c, _writer) = open_write_database(&database_path(app)?)?;
    schema(&c)?;
    if library::blocked(&c, key)? {
        return Ok(String::new());
    }
    let cfg = library::effective_config(&c, key, &config(&c)?)?;
    if cfg.mode != "obsidian" {
        return Ok(String::new());
    }
    if let Err(error) =
        crate::library_runtime::obsidian_gate(&active_data_root(app)?, Path::new(&cfg.vault_path))
    {
        if crate::library_runtime::is_control_error(&error) {
            return Ok("；资料库已暂停，本地页面将在继续后更新".into());
        }
        return Err(error);
    }
    let root = validate(&cfg)?.ok_or("Obsidian 目录不可用")?;
    let destination = library::register_root(&c, &root)?;
    let record:Option<(String,String)>=c.query_row("SELECT relative_path,file_hash FROM collection_obsidian_exports WHERE destination=?1 AND item_key=?2",params![destination,key],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e|e.to_string())?;
    let Some((relative, expected)) = record else {
        return Ok("；将在下次同步写入 Obsidian".into());
    };
    let path = safe_path(&root, &relative, false)?;
    let current = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if hash(current.as_bytes()) != expected {
        return Ok("；保留 Obsidian 中的手动修改".into());
    }
    let (status, tags) = super::properties::load(&c, key, false)?;
    let text = replace_properties(&current, &status, &tags)?;
    if write_note(&path, &text, Some(&expected))? {
        c.execute("UPDATE collection_obsidian_exports SET file_hash=?3 WHERE destination=?1 AND item_key=?2",params![destination,key,hash(text.as_bytes())]).map_err(|e|e.to_string())?;
    }
    Ok(String::new())
}
fn replace_properties(current: &str, status: &str, tags: &[String]) -> Result<String, String> {
    let Some(end) = current
        .strip_prefix("---\n")
        .and_then(|s| s.find("\n---").map(|i| i + 4))
    else {
        return Err("页面属性格式已更改，保留原文件".into());
    };
    let header = current[..end]
        .lines()
        .map(|line| {
            if line.starts_with("标签:") {
                format!("标签: {}", json!(tags))
            } else if line.starts_with("状态:") {
                format!("状态: {}", json!(super::properties::label(status)))
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    Ok(format!("{header}{}", &current[end..]))
}

pub(super) async fn export_one(
    app: &AppHandle,
    key: &str,
    cfg: StorageConfig,
) -> Result<String, String> {
    INDEPENDENT_EXPORT
        .scope(true, export_inner_config(app, Some(key), Some(cfg)))
        .await
}
async fn export_inner(app: &AppHandle, only: Option<&str>) -> Result<String, String> {
    export_inner_config(app, only, None).await
}
async fn export_inner_config(
    app: &AppHandle,
    only: Option<&str>,
    override_config: Option<StorageConfig>,
) -> Result<String, String> {
    let cfg = match &override_config {
        Some(cfg) => cfg.clone(),
        None => config(&open_database(&database_path(app)?)?)?,
    };
    if cfg.mode == "obsidian" {
        library::control::vault_scope(
            app,
            &cfg.vault_path,
            export_inner_config_uncontrolled(app, only, override_config),
        )
        .await
    } else {
        export_inner_config_uncontrolled(app, only, override_config).await
    }
}
async fn export_inner_config_uncontrolled(
    app: &AppHandle,
    only: Option<&str>,
    override_config: Option<StorageConfig>,
) -> Result<String, String> {
    let (cfg, pending) = {
        let (c, _writer) = open_write_database(&database_path(app)?)?;
        schema(&c)?;
        super::schema(&c)?;
        let cfg = override_config.clone().unwrap_or(config(&c)?);
        let pending = rows(&c, only, &cfg)?;
        (cfg, pending)
    };
    let default_obsidian = cfg.mode == "obsidian";
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| "无法初始化附件下载")?;
    let (mut saved, mut unchanged, mut protected, mut skipped, mut failed, mut used) =
        (0, 0, 0, 0, 0, 0u64);
    let total = pending.len();
    jobs::update(|p| {
        p.phase = "saving".into();
        p.processed = 0;
        p.total = total;
        p.file_bytes = 0;
        p.file_total = None;
    });
    let mut last_error = String::new();
    let mut processed = 0;
    for (index, row) in pending.iter().enumerate() {
        library::control::checkpoint()?;
        if cancelled() {
            break;
        }
        processed = index;
        jobs::update(|p| {
            p.processed = index;
            p.file_bytes = 0;
            p.file_total = None;
        });
        let item = &row.item;
        // Release between items: migrations need not wait for an entire sync/network cycle.
        let cfg = {
            let (c, _writer) = open_write_database(&database_path(app)?)?;
            if library::blocked(&c, &item.key)? {
                continue;
            }
            let cleaning:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM collection_library_jobs WHERE item_key=?1 AND action='move' AND phase='cleanup')",[&item.key],|r|r.get(0)).map_err(|e|e.to_string())?;
            if override_config.is_none() && cleaning {
                continue;
            }
            if override_config.is_none() {
                match library::effective_config(&c, &item.key, &cfg) {
                    Ok(cfg) => cfg,
                    Err(error) => {
                        last_error = error;
                        failed += 1;
                        processed += 1;
                        continue;
                    }
                }
            } else {
                cfg.clone()
            }
        };
        if crate::data_backup::media_policy::is_x(&item.key) {
            let c = open_database(&database_path(app)?)?;
            if cfg.mode != "obsidian" || crate::data_backup::media_policy::x_vault(&c).is_err() {
                last_error = "X 原件和附件只保存到 Obsidian，请先选择可用的 Obsidian 保存库".into();
                failed += 1;
                processed += 1;
                continue;
            }
        }
        let vault = match validate(&cfg) {
            Ok(vault) => vault,
            Err(error) => {
                last_error = error;
                failed += 1;
                processed += 1;
                continue;
            }
        };
        let root = if let Some(vault) = vault {
            vault
        } else {
            let local = active_data_root(app)?.join("collection-files");
            fs::create_dir_all(&local).map_err(|e| e.to_string())?;
            fs::canonicalize(local).map_err(|e| e.to_string())?
        };
        let obsidian = cfg.mode == "obsidian";
        let label = if obsidian { "Obsidian" } else { "本地附件" };
        let destination = {
            let (c, _writer) = open_write_database(&database_path(app)?)?;
            library::register_root(&c, &root)?
        };
        {
            let c = open_database(&database_path(app)?)?;
            let original:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM collection_local_source_files WHERE destination=?1 AND item_key=?2)",params![destination,item.key],|r|r.get(0)).map_err(|e|e.to_string())?;
            if original {
                unchanged += 1;
                processed += 1;
                continue;
            }
        }
        let input = hash(
            format!(
                "{}:{}",
                row.input,
                serde_json::to_string(&cfg).map_err(|e| e.to_string())?
            )
            .as_bytes(),
        );
        status(
            app,
            &format!(
                "正在保存 {label} · {}/{} · 已下载 {} MB（大视频可能需要较长时间）",
                index + 1,
                total,
                used / 1024 / 1024
            ),
        )?;
        let previous: Option<(String, String, String, i64)> = {
            let (c, _writer) = open_write_database(&database_path(app)?)?;
            c.query_row("SELECT relative_path,file_hash,input_hash,media_pending FROM collection_obsidian_exports WHERE destination=?1 AND item_key=?2",params![destination,item.key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(|e|e.to_string())?
        };
        if item.post.id.is_empty()
            || (item.post.source != "dida" && !item.post.id.bytes().all(|b| b.is_ascii_digit()))
        {
            failed += 1;
            processed += 1;
            continue;
        }
        let relative = if obsidian {
            let (c, _writer) = open_write_database(&database_path(app)?)?;
            titles::relative_path(
                &c,
                &root,
                &destination,
                item,
                previous.as_ref().map(|v| v.0.as_str()),
            )?
        } else {
            String::new()
        };
        let path = if obsidian {
            safe_path(&root, &relative, false)?
        } else {
            root.join("unused")
        };
        let current = if path.exists() {
            Some(hash(&fs::read(&path).map_err(|e| e.to_string())?))
        } else {
            None
        };
        if previous
            .as_ref()
            .is_some_and(|v| current.as_deref().is_some_and(|h| h != v.1))
        {
            protected += 1;
            processed += 1;
            continue;
        }
        let attachments_exist = if cfg.download_media && !threads::assets(&item.post).is_empty() {
            let (c, _writer) = open_write_database(&database_path(app)?)?;
            threads::assets(&item.post).iter().all(|media| {
                c.query_row(
                    "SELECT path FROM collection_saved_media WHERE item_key=?1 AND media_url=?2",
                    params![item.key, media.url],
                    |r| r.get::<_, String>(0),
                )
                .ok()
                .is_some_and(|path| {
                    Path::new(&path).starts_with(&root)
                        && fs::metadata(path).is_ok_and(|m| m.is_file() && m.len() > 0)
                })
            })
        } else {
            true
        };
        if previous
            .as_ref()
            .is_some_and(|v| current.is_some() && v.2 == input && v.3 == 0 && attachments_exist)
        {
            if override_config.is_none() {
                let (c, _writer) = open_write_database(&database_path(app)?)?;
                library::record_saved(&c, &item.key, &root)?;
            }
            unchanged += 1;
            processed += 1;
            continue;
        }
        let mut local = Vec::new();
        let mut media_pending = false;
        for media in threads::assets(&item.post) {
            library::control::checkpoint()?;
            // Telegram thumbnails can remain usable even when the original exceeds cloud limits.
            if cfg.download_media && media.preview_url.starts_with("telegram:") {
                let thumbnail = Media {
                    kind: "photo".into(),
                    url: media.preview_url.clone(),
                    preview_url: String::new(),
                };
                if let Ok(relative) =
                    download(app, &client, &root, &thumbnail, None, &mut used).await
                {
                    let absolute = safe_path(&root, &relative, false)?;
                    let (c, _writer) = open_write_database(&database_path(app)?)?;
                    library::track_asset(&c, &item.key, &absolute)?;
                    record_saved_media(&c, &item.key, &thumbnail.url, &absolute)?;
                }
            }
            let path = if cfg.download_media {
                let cached: Option<PathBuf> = {
                    let (c, _writer) = open_write_database(&database_path(app)?)?;
                    c.query_row("SELECT path FROM collection_saved_media WHERE media_url=?1 ORDER BY item_key=?2 DESC LIMIT 1",params![media.url,item.key],|r|r.get::<_,String>(0)).optional().map_err(|e|e.to_string())?.map(PathBuf::from)
                };
                match download(app, &client, &root, media, cached.as_deref(), &mut used).await {
                    Ok(path) => {
                        let absolute = safe_path(&root, &path, false)?;
                        let (c, _writer) = open_write_database(&database_path(app)?)?;
                        library::track_asset(&c, &item.key, &absolute)?;
                        record_saved_media(&c, &item.key, &media.url, &absolute)?;
                        Some(path)
                    }
                    Err(error) => {
                        if crate::library_runtime::is_control_error(&error) {
                            return Err(error);
                        }
                        last_error = error;
                        media_pending = true;
                        skipped += 1;
                        None
                    }
                }
            } else {
                None
            };
            local.push(path);
        }
        if cancelled() {
            break;
        }
        if !obsidian {
            processed += 1;
            saved += 1;
            continue;
        }
        processed += 1;
        let text = render(item, &local);
        let (reading_status, tags) = {
            let (c, _writer) = open_write_database(&database_path(app)?)?;
            super::properties::load(&c, &item.key, item.read)?
        };
        let text = text
            .replacen("标签: []", &format!("标签: {}", json!(tags)), 1)
            .replacen(
                &format!("状态: {}", quoted(if item.read { "已读" } else { "待读" })),
                &format!(
                    "状态: {}",
                    quoted(super::properties::label(&reading_status))
                ),
                1,
            );
        // Serialize only the final file/mapping commit with deletion, never network I/O.
        let _files_guard = library::FILES_LOCK.lock().await;
        let (c, _writer) = open_write_database(&database_path(app)?)?;
        if library::blocked(&c, &item.key)? {
            continue;
        }
        match library::control::commit(|| {
            let written = commit_note(
                &c,
                &path,
                &text,
                previous.as_ref().map(|v| v.1.as_str()),
                &destination,
                &item.key,
                &relative,
                &input,
                media_pending,
            )?;
            if written {
                if override_config.is_none() {
                    library::record_saved(&c, &item.key, &root)?;
                }
            }
            Ok(written)
        }) {
            Ok(true) => saved += 1,
            Ok(false) => protected += 1,
            Err(error) => {
                if crate::library_runtime::is_control_error(&error) {
                    return Err(error);
                }
                last_error = error;
                failed += 1;
            }
        }
    }
    jobs::update(|p| p.processed = processed);
    let remaining = total.saturating_sub(processed);
    Ok(format!("{} · 本轮处理 {processed}/{total} 条 · 尚未处理 {remaining} 条 · 保存 {saved} 条 · 无变化 {unchanged} 页 · 保留手动修改/同名页面 {protected} 页 · 本轮附件待重试 {skipped} 个 · 写入失败 {failed} 页{}",
        if cancelled() {"已暂停"} else if default_obsidian {"页面保存结束"} else {"本地附件保存结束"},
        if skipped > 0 || failed > 0 {format!("；{last_error}，可点击补写 / 重试")} else {String::new()}))
}

#[tauri::command]
pub(crate) async fn get_collection_storage(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || get_collection_storage_blocking(app))
        .await
        .map_err(|e| e.to_string())?
}
pub(super) fn exporting() -> bool {
    EXPORTING.load(Ordering::Relaxed)
}

pub(crate) fn get_collection_storage_blocking(app: AppHandle) -> Result<Value, String> {
    let c = open_database(&database_path(&app)?)?;
    Ok(
        json!({"config":config(&c)?,"localSources":super::local_sources::status(&c),"vaultRelocation":relocation::information(&c)?,"running":EXPORTING.load(Ordering::Relaxed),"downloadedBytes":DOWNLOADED.load(Ordering::Relaxed),"status":metadata_string(&c,"collection_export_status"),"job":jobs::snapshot(),"telegramRunning":crate::telegram::running(),"didaRunning":super::dida_reading::running(),"tdl":crate::telegram::tdl::state(&app,&c)?}),
    )
}
#[tauri::command]
pub(crate) async fn save_collection_storage(
    app: AppHandle,
    config: StorageConfig,
) -> Result<String, String> {
    if cfg!(mobile) {
        return Err("请在桌面端管理资料库副本".into());
    }
    validate_intervals(&config)?;
    let guard = SYNC_LOCK.try_lock().ok();
    if guard.is_none() {
        let (c, _writer) = open_write_database(&database_path(&app)?)?;
        let current = self::config(&c)?;
        if current.mode != config.mode
            || current.vault_path != config.vault_path
            || current.download_media != config.download_media
        {
            return Err("当前任务仍在写入，结束后可切换保存位置；同步频率可随时修改".into());
        }
        meta(
            &c,
            CONFIG,
            &serde_json::to_string(&config).map_err(|e| e.to_string())?,
        )?;
        super::local_sources::wake();
        return Ok("同步频率已保存；当前任务继续运行".into());
    }
    let preferences_only;
    {
        let (mut c, _writer) = open_write_database(&database_path(&app)?)?;
        schema(&c)?;
        let tx = c.transaction().map_err(|e| e.to_string())?;
        let old = self::config(&tx)?;
        preferences_only = old.mode == config.mode
            && old.vault_path == config.vault_path
            && old.download_media == config.download_media;
        if !preferences_only {
            validate(&config)?;
        }
        if old.mode != config.mode || old.vault_path != config.vault_path {
            library::pin_defaults(&tx, &old)?;
        }
        meta(
            &tx,
            CONFIG,
            &serde_json::to_string(&config).map_err(|e| e.to_string())?,
        )?;
        tx.commit().map_err(|e| e.to_string())?;
    }
    super::local_sources::wake();
    if preferences_only {
        return Ok("同步频率已保存".into());
    }
    jobs::launch_export(app, None, guard.unwrap());
    Ok("设置已保存，内容正在后台补写".into())
}
#[tauri::command]
pub(crate) async fn export_collections_to_obsidian(app: AppHandle) -> Result<String, String> {
    if cfg!(mobile) {
        return Err("请在桌面端管理资料库副本".into());
    }
    let _guard = SYNC_LOCK
        .try_lock()
        .map_err(|_| "请先暂停同步或等待写入结束")?;
    jobs::launch_export(app, None, _guard);
    Ok("已开始后台补写".into())
}

#[tauri::command]
pub(crate) async fn open_collection_attachment(
    app: AppHandle,
    key: String,
    url: String,
) -> Result<(), String> {
    crate::reading_sync::media::ensure(&app, &key, &url).await?;
    let path: String = {
        let (c, _writer) = open_write_database(&database_path(&app)?)?;
        schema(&c)?;
        c.query_row(
            "SELECT path FROM collection_saved_media WHERE item_key=?1 AND media_url=?2",
            params![key, url],
            |r| r.get(0),
        )
        .map_err(|_| "附件尚未下载")?
    };
    let extension = Path::new(&path)
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("");
    if !matches!(
        extension,
        "jpg"
            | "jpeg"
            | "png"
            | "gif"
            | "webp"
            | "mp4"
            | "mp3"
            | "m4a"
            | "ogg"
            | "wav"
            | "flac"
            | "pdf"
            | "txt"
            | "md"
            | "zip"
            | "docx"
            | "xlsx"
            | "pptx"
            | "webm"
            | "mov"
    ) || !Path::new(&path).is_file()
    {
        return Err("本地附件不存在或格式不受支持，请重试下载".into());
    }
    tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| e.to_string())
}

// Resolve only recorded downloads; callers cannot supply an arbitrary local path.
pub(crate) fn collection_media_path(app: &AppHandle, id: i64) -> Result<PathBuf, String> {
    let c = open_database(&database_path(app)?)?;
    recorded_media_path(&c, id)
}
pub(crate) fn record_saved_media(
    c: &Connection,
    key: &str,
    url: &str,
    path: &Path,
) -> Result<(), String> {
    let path = crate::data_backup::media_policy::retain(c, key, url, path)?;
    c.execute("INSERT INTO collection_saved_media(item_key,media_url,path) VALUES(?1,?2,?3) ON CONFLICT(item_key,media_url) DO UPDATE SET path=excluded.path",params![key,url,path.to_string_lossy()]).map(|_|()).map_err(|e|e.to_string())
}
pub(crate) fn recorded_media_path(c: &Connection, id: i64) -> Result<PathBuf, String> {
    let path: String = c
        .query_row(
            "SELECT path FROM collection_saved_media WHERE local_seq=?1",
            params![id],
            |r| r.get(0),
        )
        .map_err(|_| "附件尚未下载")?;
    let path = PathBuf::from(path);
    let mut file = std::fs::File::open(&path).map_err(|_| "本地附件已移动或不存在，请重试下载")?;
    let mut signature = [0u8; 8192];
    let n = std::io::Read::read(&mut file, &mut signature).map_err(|e| e.to_string())?;
    if !infer::get(&signature[..n]).is_some_and(|kind| {
        kind.mime_type().starts_with("image/")
            || kind.mime_type().starts_with("video/")
            || kind.mime_type().starts_with("audio/")
            || kind.mime_type() == "application/ogg"
    }) {
        return Err("本地附件不是受支持的图片、视频或音频".into());
    }
    Ok(path)
}

#[tauri::command]
pub(crate) async fn collection_media_preview(
    app: AppHandle,
    key: String,
    url: String,
) -> Result<MarkdownMediaPreview, String> {
    crate::reading_sync::media::ensure(&app, &key, &url).await?;
    let c = open_database(&database_path(&app)?)?;
    let id: i64 = c
        .query_row(
            "SELECT local_seq FROM collection_saved_media WHERE item_key=?1 AND media_url=?2",
            params![key, url],
            |r| r.get(0),
        )
        .map_err(|_| "附件尚未下载，可点击补写与重试附件")?;
    let path = collection_media_path(&app, id)?;
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut signature = [0u8; 8192];
    let n = std::io::Read::read(&mut file, &mut signature).map_err(|e| e.to_string())?;
    let mime = infer::get(&signature[..n])
        .ok_or("无法识别附件格式")?
        .mime_type();
    Ok(MarkdownMediaPreview {
        source: media_protocol_url(&format!("collection/{id}")),
        mime_type: mime.into(),
        media_type: if mime.starts_with("video/") {
            "video"
        } else if mime.starts_with("audio/") || mime == "application/ogg" {
            "audio"
        } else {
            "image"
        }
        .into(),
    })
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod property_update_tests {
    use super::*;
    #[test]
    fn updates_only_frontmatter() {
        let input = "---\n标签: []\n状态: \"待读\"\n---\n\n标签: 正文不要改\n![[video.mp4]]\n";
        let updated = replace_properties(input, "in_progress", &["阅读".into()]).unwrap();
        assert!(updated.contains("状态: \"进行中\""));
        assert!(updated.ends_with("---\n\n标签: 正文不要改\n![[video.mp4]]\n"));
    }
}
