//! Read-only intake from the configured reading vault. Files remain owned by Obsidian.
use super::*;
use std::collections::BTreeMap;
mod markdown;
mod schedule;
mod store;
#[cfg(test)]
mod tests;

const STATUS: &str = "collection_local_sources_status_v1";
const BATCH: usize = 64;

pub(super) fn original_layout(relative: &str) -> bool {
    (relative.starts_with("X/") || relative.starts_with("Telegram/"))
        && !["X/书签/", "X/喜欢/", "Telegram/收集/"]
            .iter()
            .any(|folder| relative.starts_with(folder))
}

pub(crate) fn schema(c: &Connection) -> Result<(), String> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS collection_local_source_items(item_key TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS collection_local_source_files(
        destination TEXT NOT NULL,relative_path TEXT NOT NULL,item_key TEXT NOT NULL DEFAULT '',
        file_hash TEXT NOT NULL DEFAULT '',fingerprint TEXT NOT NULL DEFAULT '',identity TEXT NOT NULL DEFAULT '',
        dependencies TEXT NOT NULL DEFAULT '[]',error TEXT NOT NULL DEFAULT '',checked_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(destination,relative_path));
      CREATE INDEX IF NOT EXISTS collection_local_source_fingerprint ON collection_local_source_files(fingerprint);
      CREATE INDEX IF NOT EXISTS collection_local_source_identity ON collection_local_source_files(identity);
      CREATE TABLE IF NOT EXISTS collection_local_source_assets(
        path TEXT PRIMARY KEY,stamp TEXT NOT NULL,digest TEXT NOT NULL);")
        .map_err(|e| e.to_string())
}

pub(crate) fn owns(c: &Connection, key: &str) -> Result<bool, String> {
    c.query_row(
        "SELECT EXISTS(SELECT 1 FROM collection_local_source_items WHERE item_key=?1)",
        [key],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

pub(crate) fn status(c: &Connection) -> Value {
    let mut value: Value =
        serde_json::from_str(&metadata_string(c, STATUS)).unwrap_or_else(|_| json!({}));
    value["running"] = json!(schedule::running());
    value
}
pub(crate) fn wake() {
    schedule::wake();
}
pub(crate) fn start(app: AppHandle) {
    schedule::start(app);
}

#[tauri::command]
pub(crate) async fn check_local_reading_sources(app: AppHandle) -> Result<Outcome, String> {
    schedule::check(app).await
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Outcome {
    pub changed: usize,
    pub remaining: usize,
    pub errors: usize,
    pub files: usize,
}

fn walk(root: &Path, folder: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    if !folder.exists() {
        return Ok(());
    }
    let resolved = folder.canonicalize().map_err(|e| e.to_string())?;
    if !resolved.starts_with(root)
        || fs::symlink_metadata(folder)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
    {
        return Ok(());
    }
    for entry in fs::read_dir(folder).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_symlink() || entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        if kind.is_dir() {
            walk(root, &entry.path(), files)?;
        } else if kind.is_file() {
            files.push(entry.path());
        }
    }
    Ok(())
}

pub(crate) fn scan(c: &mut Connection) -> Result<Outcome, String> {
    let cfg = storage::config(c)?;
    if cfg.mode != "obsidian" || cfg.vault_path.trim().is_empty() {
        return Ok(Outcome::default());
    }
    let root = Path::new(&cfg.vault_path)
        .canonicalize()
        .map_err(|_| "本地素材接入：保存库目录不可用，原阅读状态保留")?;
    let destination = library::register_root(c, &root)?;
    let mut all = Vec::new();
    for folder in ["X", "Telegram", "99_Meta/assets"] {
        walk(&root, &root.join(folder), &mut all)?;
    }
    all.sort();
    let mut lookup: HashMap<String, Vec<PathBuf>> = HashMap::new();
    for path in &all {
        if let Some(name) = path.file_name() {
            lookup
                .entry(name.to_string_lossy().to_lowercase())
                .or_default()
                .push(path.clone());
        }
    }
    let mut notes: Vec<_> = all
        .iter()
        .filter(|p| {
            p.extension()
                .and_then(|s| s.to_str())
                .is_some_and(|s| s.eq_ignore_ascii_case("md"))
                && p.strip_prefix(&root)
                    .is_ok_and(|p| p.starts_with("X") || p.starts_with("Telegram"))
        })
        .collect();
    // Oldest attempts first: malformed inputs and continuous arrivals cannot starve the tail.
    let mut attempts = BTreeMap::new();
    {
        let mut q = c.prepare("SELECT relative_path,checked_at FROM collection_local_source_files WHERE destination=?1").map_err(|e| e.to_string())?;
        for row in q
            .query_map([&destination], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
            })
            .map_err(|e| e.to_string())?
        {
            let (path, stamp) = row.map_err(|e| e.to_string())?;
            attempts.insert(path, stamp);
        }
    }
    notes.sort_by_key(|p| {
        (
            attempts.get(&relative(&root, p)).copied().unwrap_or(0),
            relative(&root, p),
        )
    });
    let mut result = Outcome {
        files: notes.len(),
        ..Default::default()
    };
    let mut handled = 0;
    for path in notes {
        let relative = relative(&root, path);
        if ["AGENTS.md", "_index.md", "SKILL.md"]
            .iter()
            .any(|name| path.file_name().is_some_and(|s| s == *name))
        {
            continue;
        }
        // Hub already owns these projections and their media. Do not read/hash their
        // videos again or feed an export back into intake.
        if store::hub_export(c, &root, &relative)? {
            continue;
        }
        if markdown::unchanged(c, &destination, &relative, path, &root)? {
            continue;
        }
        if handled == BATCH {
            result.remaining += 1;
            continue;
        }
        handled += 1;
        match markdown::parse(c, &root, path, &lookup) {
            Ok(note) => {
                result.changed += store::apply(c, &root, &destination, &relative, &note)?;
            }
            Err(error) => {
                c.execute("INSERT INTO collection_local_source_files(destination,relative_path,error,checked_at) VALUES(?1,?2,?3,?4) ON CONFLICT(destination,relative_path) DO UPDATE SET error=excluded.error,checked_at=excluded.checked_at",params![destination,relative,error,chrono::Utc::now().timestamp_millis()]).map_err(|e| e.to_string())?;
            }
        }
    }
    result.errors = c
        .query_row(
            "SELECT count(*) FROM collection_local_source_files WHERE destination=?1 AND error<>''",
            [&destination],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    meta(c, STATUS, &json!({"lastCheckedAt":now_timestamp(),"files":result.files,"remaining":result.remaining,"errors":result.errors,"changed":result.changed,"root":crate::sources::display_local_path(&root)}).to_string())?;
    Ok(result)
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}
