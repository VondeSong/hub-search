//! Rebind a saved reading vault without copying files or replacing copy receipts.
use super::*;
use std::collections::HashMap;
use std::io::Read;
use std::path::Component;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const MAX_SAMPLES: usize = 64;
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_SIBLINGS: usize = 64;
const MAX_CANDIDATES: usize = 8;
const MAX_CHECK_BYTES: u64 = 16 * 1024 * 1024;
type CandidateCache = HashMap<String, (Instant, Value)>;
static CANDIDATES: OnceLock<Mutex<CandidateCache>> = OnceLock::new();

struct Evidence {
    relative: String,
    hash: String,
    source_address: Option<String>,
}

fn source_address(markdown: &str) -> Option<String> {
    let mut lines = markdown.trim_start_matches('\u{feff}').lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    for line in lines.take(128) {
        if line.trim() == "---" {
            break;
        }
        if let Some(value) = line.strip_prefix("地址:") {
            let value = value.trim();
            let address = serde_json::from_str::<String>(value)
                .unwrap_or_else(|_| value.trim_matches('\'').to_string());
            if address.starts_with("https://") || address.starts_with("http://") {
                return Some(address);
            }
        }
    }
    None
}

fn evidence(c: &Connection, old: &Path, id: Option<&str>) -> Result<Vec<Evidence>, String> {
    let old_key = crate::library_location::path_key(old);
    let mut roots = c
        .prepare("SELECT destination,root FROM collection_roots")
        .map_err(|e| e.to_string())?;
    let destinations = roots
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut samples = Vec::new();
    for (destination, root) in destinations {
        if crate::library_location::path_key(Path::new(&root)) != old_key {
            continue;
        }
        let mut q = c.prepare("SELECT e.relative_path,e.file_hash,CASE WHEN json_valid(i.post_json) THEN json_extract(i.post_json,'$.url') ELSE NULL END FROM collection_obsidian_exports e LEFT JOIN collection_x_items i ON i.item_key=e.item_key WHERE e.destination=?1 AND e.file_hash<>'' ORDER BY e.relative_path LIMIT ?2").map_err(|e| e.to_string())?;
        for row in q
            .query_map(params![destination, MAX_SAMPLES as i64], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?
        {
            let (relative, hash, source_address) = row.map_err(|e| e.to_string())?;
            let source_address = source_address.filter(|address| !address.is_empty());
            samples.push(Evidence {
                relative,
                hash,
                source_address,
            });
            if samples.len() == MAX_SAMPLES {
                break;
            }
        }
        if samples.len() == MAX_SAMPLES {
            break;
        }
    }
    if let Some(id) = id {
        let mut q = c.prepare("SELECT path,content_hash,substr(markdown,1,32768) FROM documents WHERE space_id=?1 AND provider='obsidian' ORDER BY path LIMIT ?2").map_err(|e| e.to_string())?;
        for row in q
            .query_map(params![id, MAX_SAMPLES as i64], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?
        {
            let (relative, hash, markdown) = row.map_err(|e| e.to_string())?;
            samples.push(Evidence {
                relative,
                hash,
                source_address: source_address(&markdown),
            });
        }
    }
    Ok(samples)
}

fn matches_evidence(root: &Path, samples: &[Evidence], bytes_left: &mut u64) -> bool {
    samples.iter().any(|sample| {
        let relative = Path::new(&sample.relative);
        if relative.as_os_str().is_empty()
            || !relative
                .components()
                .all(|part| matches!(part, Component::Normal(_)))
        {
            return false;
        }
        let Ok(path) = root.join(relative).canonicalize() else {
            return false;
        };
        if !path.starts_with(root) {
            return false;
        }
        let Ok(file) = fs::File::open(path) else {
            return false;
        };
        let Ok(metadata) = file.metadata() else {
            return false;
        };
        if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES || metadata.len() > *bytes_left {
            return false;
        }
        *bytes_left = bytes_left.saturating_sub(metadata.len());
        let mut bytes = Vec::new();
        if file
            .take(MAX_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .is_err()
            || bytes.len() as u64 > MAX_FILE_BYTES
        {
            return false;
        }
        if !sample.hash.is_empty() && hash(&bytes) == sample.hash {
            return true;
        }
        // The export's immutable origin survives user edits to its text, tags,
        // title and reading status. A same-named unrelated note is insufficient.
        sample.source_address.as_ref().is_some_and(|expected| {
            std::str::from_utf8(&bytes)
                .ok()
                .and_then(source_address)
                .as_ref()
                == Some(expected)
        })
    })
}

pub(crate) fn verify_same_vault(
    c: &Connection,
    old: &Path,
    id: Option<&str>,
    root: &Path,
) -> Result<(), String> {
    if crate::library_location::path_key(old) == crate::library_location::path_key(root) {
        return Ok(());
    }
    let samples = evidence(c, old, id)?;
    let mut bytes_left = MAX_CHECK_BYTES;
    if !samples.is_empty() && !matches_evidence(root, &samples, &mut bytes_left) {
        return Err(
            "所选文件夹中未找到与原库匹配的笔记或来源记录，请选择改名或移动后的同一个库".into(),
        );
    }
    Ok(())
}

pub(crate) fn ensure_unoccupied(
    c: &Connection,
    old: &Path,
    id: Option<&str>,
    root: &Path,
) -> Result<(), String> {
    if crate::library_location::obsidian_id_at(c, root)?
        .as_deref()
        .is_some_and(|owner| Some(owner) != id)
    {
        return Err("这个文件夹已属于另一个资料库，请选择改名或移动后的原库".into());
    }
    let mut q = c
        .prepare("SELECT root FROM collection_roots")
        .map_err(|e| e.to_string())?;
    let target_key = crate::library_location::path_key(root);
    let old_key = crate::library_location::path_key(old);
    for row in q
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
    {
        let saved = row.map_err(|e| e.to_string())?;
        let key = crate::library_location::path_key(Path::new(&saved));
        if key == target_key && key != old_key {
            return Err("这个文件夹已有另一份保存记录，请选择改名或移动后的原库".into());
        }
    }
    Ok(())
}

pub(crate) fn current_library(c: &Connection, expected: &str) -> Result<Option<String>, String> {
    let cfg = config(c)?;
    if cfg.mode != "obsidian"
        || crate::library_location::path_key(Path::new(&cfg.vault_path))
            != crate::library_location::path_key(Path::new(expected))
    {
        return Err("保存位置已被更改，请重新打开设置后再定位文件夹".into());
    }
    crate::library_location::obsidian_id_at(c, Path::new(&cfg.vault_path))
}

pub(crate) fn relocate_unregistered(
    c: &mut Connection,
    expected: &str,
    target: &Path,
) -> Result<String, String> {
    let root = target
        .canonicalize()
        .map_err(|e| format!("无法访问所选文件夹：{e}"))?;
    if !root.is_dir() {
        return Err("请选择 Obsidian 库的根文件夹".into());
    }
    let tx = c.transaction().map_err(|e| e.to_string())?;
    if current_library(&tx, expected)?.is_some() {
        return Err("此保存目录已加入资料库，请重新打开设置后再定位".into());
    }
    let old = Path::new(expected);
    ensure_unoccupied(&tx, old, None, &root)?;
    verify_same_vault(&tx, old, None, &root)?;
    // Establish a destination even if the configured vault had no completed
    // exports yet. Every subsequent write resolves through the same receipt.
    library::register_root(&tx, old)?;
    library::relocate_root(&tx, old, &root)?;
    library::refresh_names(&tx)?;
    tx.commit()
        .map_err(|e| format!("无法保存资料库的新位置：{e}"))?;
    Ok(crate::sources::display_local_path(&root))
}

pub(crate) fn information(c: &Connection) -> Result<Value, String> {
    let cfg = config(c)?;
    if cfg.mode != "obsidian"
        || cfg.vault_path.trim().is_empty()
        || Path::new(&cfg.vault_path).is_dir()
    {
        return Ok(json!({"rootExists":true,"candidates":[]}));
    }
    let key = format!("{}\n{}", c.path().unwrap_or(""), cfg.vault_path);
    let cache = CANDIDATES.get_or_init(Default::default);
    if let Some((at, value)) = cache
        .lock()
        .map_err(|_| "保存目录检查状态不可用")?
        .get(&key)
    {
        if at.elapsed() < Duration::from_secs(60) {
            return Ok(value.clone());
        }
    }
    let value = scan_candidates(c, Path::new(&cfg.vault_path))?;
    let mut cache = cache.lock().map_err(|_| "保存目录检查状态不可用")?;
    cache.retain(|_, (at, _)| at.elapsed() < Duration::from_secs(60));
    if cache.len() >= 8 {
        cache.clear();
    }
    cache.insert(key, (Instant::now(), value.clone()));
    Ok(value)
}

fn scan_candidates(c: &Connection, old: &Path) -> Result<Value, String> {
    let id = crate::library_location::obsidian_id_at(c, old)?;
    let samples = evidence(c, old, id.as_deref())?;
    let mut candidates = Vec::new();
    let mut bytes_left = MAX_CHECK_BYTES;
    if !samples.is_empty() {
        if let Some(parent) = old.parent().filter(|parent| parent.is_dir()) {
            if let Ok(entries) = fs::read_dir(parent) {
                for entry in entries.take(MAX_SIBLINGS).flatten() {
                    // Never traverse a shortcut, symlink or a whole drive tree.
                    if !entry
                        .file_type()
                        .is_ok_and(|kind| kind.is_dir() && !kind.is_symlink())
                    {
                        continue;
                    }
                    let Ok(root) = entry.path().canonicalize() else {
                        continue;
                    };
                    if ensure_unoccupied(c, old, id.as_deref(), &root).is_ok()
                        && matches_evidence(&root, &samples, &mut bytes_left)
                    {
                        candidates.push(json!({"path":crate::sources::display_local_path(&root),"name":crate::sources::obsidian_vault_name(&root)}));
                        if candidates.len() == MAX_CANDIDATES {
                            break;
                        }
                    }
                }
            }
        }
    }
    candidates.sort_by(|left, right| left["path"].as_str().cmp(&right["path"].as_str()));
    Ok(json!({"rootExists":false,"candidates":candidates}))
}

#[cfg(test)]
mod tests;
