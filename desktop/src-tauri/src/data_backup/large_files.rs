//! Read-only size inventory. No deletion, download or account access.
use super::*;
use serde_json::{json, Value};
use std::collections::BTreeSet;

fn table(c: &Connection, name: &str) -> Result<bool, String> {
    c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [name],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}
fn owners(root: &Path) -> Result<BTreeMap<String, BTreeMap<String, String>>, String> {
    let c = readonly(&root.join(DATABASE))?;
    c.execute_batch("BEGIN").map_err(|e| e.to_string())?;
    let mut result = BTreeMap::<String, BTreeMap<String, String>>::new();
    let mut titles = BTreeMap::new();
    if table(&c, "collection_x_items")? {
        let mut q = c
            .prepare("SELECT item_key,post_json FROM collection_x_items")
            .map_err(|e| e.to_string())?;
        for row in q
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?
        {
            let (key, raw) = row.map_err(|e| e.to_string())?;
            let v: Value =
                serde_json::from_str(&raw).map_err(|_| "阅读内容记录损坏，无法匹配附件标题")?;
            let title = v["title"]
                .as_str()
                .filter(|s| !s.is_empty())
                .or_else(|| v["article"]["title"].as_str())
                .or_else(|| v["text"].as_str())
                .unwrap_or("");
            titles.insert(
                key,
                title
                    .lines()
                    .next()
                    .unwrap_or("")
                    .chars()
                    .take(180)
                    .collect::<String>(),
            );
        }
    }
    if table(&c, "collection_saved_media")? {
        let mut q = c
            .prepare("SELECT item_key,path FROM collection_saved_media")
            .map_err(|e| e.to_string())?;
        for row in q
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?
        {
            let (key, path) = row.map_err(|e| e.to_string())?;
            result
                .entry(crate::library_location::path_key(Path::new(&path)))
                .or_default()
                .insert(key.clone(), titles.get(&key).cloned().unwrap_or_default());
        }
    }
    if table(&c, "source_items")? && table(&c, "documents")? {
        let mut q=c.prepare("SELECT DISTINCT s.blob_hash,d.space_id||':'||d.id,d.title FROM source_items s JOIN documents d ON d.space_id=s.space_id AND d.id=s.document_id WHERE s.blob_hash IS NOT NULL").map_err(|e|e.to_string())?;
        for row in q
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?
        {
            let (hash, id, title) = row.map_err(|e| e.to_string())?;
            if hash.len() != 64 || !hash.bytes().all(|v| v.is_ascii_hexdigit()) {
                continue;
            }
            result
                .entry(crate::library_location::path_key(
                    &root.join("blobs-v1").join(&hash[..2]).join(hash),
                ))
                .or_default()
                .insert(id, title.chars().take(180).collect());
        }
    }
    Ok(result)
}
fn kind(path: &Path, category: &str) -> &'static str {
    let ext = path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match ext.as_str() {
        "mp4" | "webm" | "mov" | "mkv" | "avi" => return "video",
        "pdf" => return "pdf",
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "avif" | "heic" | "svg" => return "image",
        "" if matches!(category, "attachments" | "reading") => {
            let mut bytes = [0u8; 8192];
            fs::File::open(path)
                .ok()
                .and_then(|mut f| f.read(&mut bytes).ok())
                .and_then(|n| infer::get(&bytes[..n]))
        }
        _ => None,
    };
    match mime.map(|v| v.mime_type()) {
        Some(v) if v.starts_with("video/") => "video",
        Some(v) if v.starts_with("image/") => "image",
        Some("application/pdf") => "pdf",
        _ => "other",
    }
}
pub(crate) fn list(root: &Path, args: &Value, cancel: &AtomicBool) -> Result<Value, String> {
    let root = files::existing_directory(root)?;
    let category = args["category"].as_str().unwrap_or("all");
    let filter = args["kind"].as_str().unwrap_or("all");
    if !["all", "video", "pdf", "image", "other"].contains(&filter) {
        return Err("文件类型无效".into());
    }
    let query = args["query"]
        .as_str()
        .unwrap_or("")
        .chars()
        .take(200)
        .collect::<String>()
        .to_lowercase();
    let minimum = args["minimumBytes"].as_u64().unwrap_or(50 * 1024 * 1024);
    let page = args["page"].as_u64().unwrap_or(0).min(1_000_000);
    let owners = owners(&root)?;
    let mut entries = Vec::new();
    let mut warnings = Vec::new();
    let mut scanned = 0u64;
    files::walk(
        &root,
        &root,
        &mut |path, meta| {
            scanned += 1;
            let relative = path.strip_prefix(&root).map_err(|e| e.to_string())?;
            let (id, label, _) = usage_category(relative);
            if (category != "all" && category != id) || meta.len() < minimum {
                return Ok(());
            }
            let kind = kind(path, id);
            if filter != "all" && filter != kind {
                return Ok(());
            }
            let associations = owners.get(&crate::library_location::path_key(path));
            let titles: BTreeSet<String> = associations
                .into_iter()
                .flat_map(|v| v.values())
                .filter(|v| !v.is_empty())
                .cloned()
                .collect();
            let relative = relative.to_string_lossy().replace('\\', "/");
            if !query.is_empty()
                && !relative.to_lowercase().contains(&query)
                && !titles.iter().any(|v| v.to_lowercase().contains(&query))
            {
                return Ok(());
            }
            entries.push(json!({"relativePath":relative,"name":path.file_name().unwrap_or_default().to_string_lossy(),"bytes":meta.len(),"category":id,"categoryLabel":label,"kind":kind,"titles":titles.iter().take(8).collect::<Vec<_>>(),"referenceCount":associations.map_or(0,|v|v.len())}));
            Ok(())
        },
        &mut warnings,
        cancel,
        false,
    )?;
    entries.sort_by(|a, b| {
        b["bytes"]
            .as_u64()
            .cmp(&a["bytes"].as_u64())
            .then_with(|| a["relativePath"].as_str().cmp(&b["relativePath"].as_str()))
    });
    let count = entries.len();
    let bytes = entries
        .iter()
        .map(|v| v["bytes"].as_u64().unwrap_or(0))
        .sum::<u64>();
    Ok(
        json!({"entries":entries.into_iter().skip(page as usize*50).take(50).collect::<Vec<_>>(),"totalFiles":count,"totalBytes":bytes,"page":page,"pageSize":50,"scannedFiles":scanned,"warnings":warnings,"readOnly":true}),
    )
}
pub(crate) fn checked_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let root = files::existing_directory(root)?;
    if relative.is_empty()
        || relative.contains(['\\', ':'])
        || !Path::new(relative)
            .components()
            .all(|v| matches!(v, std::path::Component::Normal(_)))
    {
        return Err("文件位置无效".into());
    }
    let path = root.join(relative);
    files::reject_links(&path)?;
    let path = path
        .canonicalize()
        .map_err(|_| "文件已移动或不存在，请刷新列表")?;
    if !path.starts_with(&root) || !path.is_file() {
        return Err("文件不在当前 Hub 数据目录内".into());
    }
    Ok(path)
}
#[cfg(test)]
#[path = "large_files_tests.rs"]
mod tests;
