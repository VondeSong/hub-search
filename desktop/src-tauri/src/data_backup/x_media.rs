//! Explicit offline repair: relink verified X originals before removing any Hub copy.
//! Original vault files are never written. Unknown and shared files are retained.
use super::*;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};

const MARKER: &str = "hub_x_obsidian_media_v2";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pair {
    cached: PathBuf,
    original: PathBuf,
    bytes: u64,
    sha256: String,
    #[serde(default)]
    from_x_lookup: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    version: u32,
    root: PathBuf,
    files: Vec<Pair>,
    warnings: Vec<String>,
    #[serde(skip)]
    locks: Vec<fs::File>,
}

fn key(path: &Path) -> String {
    crate::library_location::path_key(path)
}
fn table(c: &Connection, name: &str) -> Result<bool, String> {
    c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [name],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}
fn x_asset(path: &Path, vault: &Path) -> bool {
    path.starts_with(vault.join("99_Meta/assets/X_assets")) || path.starts_with(vault.join("X"))
}
fn vault_asset(path: &Path, vault: &Path) -> bool {
    x_asset(path, vault) || path.starts_with(vault.join("99_Meta/assets"))
}

fn propose(
    cached: PathBuf,
    original: PathBuf,
    root: &Path,
    vault: &Path,
    proposed: &mut BTreeMap<String, (PathBuf, PathBuf, bool)>,
) -> Result<(), String> {
    let cached = if cached.is_absolute() {
        cached
    } else {
        return Ok(());
    };
    // The only removable owners are the reading attachment directories.
    if !(cached.starts_with(root.join("collection-files"))
        || cached.starts_with(root.join("reading-media-v1")))
    {
        return Ok(());
    }
    if !x_asset(&original, vault) || (!cached.is_file() && expected_hash(&cached).is_none()) {
        return Ok(());
    }
    files::reject_links(&cached)?;
    files::reject_links(&original)?;
    proposed
        .entry(key(&cached))
        .or_insert((cached, original, false));
    Ok(())
}

fn expected_hash(cached: &Path) -> Option<String> {
    let digest = if cached.parent()?.parent()?.file_name()?.to_str()? == "recovered-assets" {
        cached.parent()?.file_name()?.to_str()?
    } else {
        cached.file_stem()?.to_str()?
    };
    (digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| digest.to_ascii_lowercase())
}

fn cached_path(path: PathBuf, root: &Path) -> Result<PathBuf, String> {
    match path.canonicalize() {
        Ok(path) => return Ok(path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(io_error(e)),
    }
    // A restored snapshot can refer to an already removed copy with a plain
    // Windows spelling. Normalize its root before checking the recorded hash.
    if key(&path).starts_with(&format!("{}/", key(root))) {
        let display = crate::sources::display_local_path(&path).replace('\\', "/");
        let root_display = crate::sources::display_local_path(root).replace('\\', "/");
        let suffix = display
            .split('/')
            .skip(root_display.split('/').count())
            .collect::<Vec<_>>()
            .join("/");
        return Ok(root.join(files::safe_relative(&suffix)?));
    }
    Ok(path)
}

fn plan(root: &Path) -> Result<Receipt, String> {
    let c = readonly(&root.join(DATABASE))?;
    let vault = media_policy::x_vault(&c)?;
    let mut proposed = BTreeMap::new();
    // Read-only local intake already has exact attachment content receipts for
    // manually managed X/media files, whose names are not URL hashes.
    let mut originals = HashMap::new();
    if table(&c, "collection_local_source_assets")? {
        let mut q = c
            .prepare("SELECT path,digest FROM collection_local_source_assets")
            .map_err(|e| e.to_string())?;
        for row in q
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?
        {
            let (path, digest) = row.map_err(|e| e.to_string())?;
            if let Ok(path) = Path::new(&path).canonicalize() {
                if vault_asset(&path, &vault) {
                    originals.insert(digest, path);
                }
            }
        }
    }
    let marker: Option<String> = c
        .query_row(
            "SELECT value FROM metadata WHERE key='hub_owned_data_v1'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(raw) = marker {
        let marker: Value =
            serde_json::from_str(&raw).map_err(|_| "旧收拢记录损坏，未清理任何文件")?;
        if let Some(mappings) = marker["summary"]["pathMappings"].as_array() {
            for mapping in mappings {
                let (Some(source), Some(restored)) = (
                    mapping["sourcePath"].as_str(),
                    mapping["restoredPath"].as_str(),
                ) else {
                    continue;
                };
                let restored =
                    crate::sources::display_local_path(Path::new(restored)).replace('\\', "/");
                let Some(at) = restored.find("/collection-files/") else {
                    continue;
                };
                let suffix = &restored[at + 1..];
                let cached = root.join(files::safe_relative(suffix)?);
                let source = PathBuf::from(source);
                if let Ok(original) = source.canonicalize() {
                    propose(cached, original, root, &vault, &mut proposed)?;
                }
            }
        }
    }
    // Newer retained objects may not occur in the old migration receipt.
    if table(&c, "collection_saved_media")? {
        let mut q = c
            .prepare(&format!(
                "SELECT item_key,media_url,path FROM collection_saved_media WHERE {}",
                media_policy::x_sql("item_key")
            ))
            .map_err(|e| e.to_string())?;
        let rows = q
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (_, url, path) = row.map_err(|e| e.to_string())?;
            let cached = cached_path(PathBuf::from(path), root)?;
            if !cached.starts_with(root) {
                continue;
            }
            if let Some(name) = cached.file_name() {
                propose(
                    cached.clone(),
                    vault.join("99_Meta/assets/X_assets").join(name),
                    root,
                    &vault,
                    &mut proposed,
                )?;
            }
            if let Some(ext) = cached.extension().and_then(|v| v.to_str()) {
                let original = vault
                    .join("99_Meta/assets/X_assets")
                    .join(format!("{:x}.{ext}", Sha256::digest(url.as_bytes())));
                if original.is_file() {
                    // Prefer an existing URL-identity original over a nonexistent content-name candidate.
                    proposed.insert(key(&cached), (cached.clone(), original, true));
                }
            }
            let digest = if cached
                .parent()
                .and_then(|p| p.parent())
                .and_then(|p| p.file_name())
                .and_then(|v| v.to_str())
                == Some("recovered-assets")
            {
                cached
                    .parent()
                    .and_then(|p| p.file_name())
                    .and_then(|v| v.to_str())
            } else {
                cached.file_stem().and_then(|v| v.to_str())
            };
            if let Some(original) = digest.and_then(|hash| originals.get(hash)) {
                proposed.insert(key(&cached), (cached, original.clone(), true));
            }
        }
    }
    drop(c);
    let mut result = Receipt {
        version: 1,
        root: root.to_path_buf(),
        files: Vec::new(),
        warnings: Vec::new(),
        locks: Vec::new(),
    };
    let cancel = AtomicBool::new(false);
    let mut checked = HashMap::<PathBuf, (u64, String)>::new();
    for (_, (cached, original, from_x_lookup)) in proposed {
        if !original.is_file() {
            warning(
                &mut result.warnings,
                format!("Obsidian 原件未找到，Hub 副本保留：{}", cached.display()),
            );
            continue;
        }
        if !cached.is_file() {
            let original_lock = files::open_stable(&original)?;
            let digest = files::hash_file(&original, &cancel)?;
            if expected_hash(&cached).as_deref() == Some(digest.as_str()) {
                result.files.push(Pair {
                    cached,
                    original,
                    bytes: original_lock.metadata().map_err(io_error)?.len(),
                    sha256: digest,
                    from_x_lookup,
                });
                result.locks.push(original_lock);
            }
            continue;
        }
        let mut identities = Vec::new();
        for path in [&cached, &original] {
            files::reject_links(path)?;
            if let Some(identity) = checked.get(path) {
                identities.push(identity.clone());
                continue;
            }
            let handle = files::open_stable(path)?;
            let size = handle.metadata().map_err(io_error)?.len();
            let digest = files::hash_file(path, &cancel)?;
            checked.insert(path.clone(), (size, digest.clone()));
            identities.push((size, digest));
            result.locks.push(handle);
        }
        if identities[0] != identities[1] {
            warning(
                &mut result.warnings,
                format!("两处附件内容不同，Hub 副本保留：{}", cached.display()),
            );
            continue;
        }
        result.files.push(Pair {
            cached,
            original,
            bytes: identities[0].0,
            sha256: identities[0].1.clone(),
            from_x_lookup,
        });
    }
    Ok(result)
}

fn summary(receipt: &Receipt) -> Value {
    json!({"verifiedDuplicateFiles":receipt.files.len(),"duplicateLogicalBytes":receipt.files.iter().map(|p|p.bytes).sum::<u64>(),
        "warnings":receipt.warnings,"obsidianOriginalsModified":false})
}

pub(crate) fn preview(root: &Path) -> Result<Value, String> {
    let root = files::existing_directory(root)?;
    Ok(summary(&plan(&root)?))
}

pub(crate) fn repair(root: &Path) -> Result<Value, String> {
    let root = files::existing_directory(root)?;
    let _session = crate::data_portability::exclusive_session(&root)?;
    let _maintenance = crate::data_portability::maintenance_lock(&root)?;
    repair_inner(&root)
}

// Caller already holds startup session admission. Never delete on upgrade.
pub(super) fn initialize_references(root: &Path) -> Result<(), String> {
    let c = readonly(&root.join(DATABASE))?;
    if !table(&c, "collection_saved_media")? {
        return Ok(());
    }
    let marked: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM metadata WHERE key=?1)",
            [MARKER],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if marked || media_policy::x_vault(&c).is_err() {
        return Ok(());
    }
    let mut q = c
        .prepare(&format!(
            "SELECT path FROM collection_saved_media WHERE {}",
            media_policy::x_sql("item_key")
        ))
        .map_err(|e| e.to_string())?;
    let rows = q
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let needs_repair = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?
        .iter()
        .any(|p| key(Path::new(p)).starts_with(&format!("{}/", key(root))));
    drop(q);
    drop(c);
    if needs_repair {
        let _maintenance = crate::data_portability::maintenance_lock(root)?;
        repair_inner(root)?;
    }
    Ok(())
}

fn repair_inner(root: &Path) -> Result<Value, String> {
    if schema_version(&readonly(&root.join(DATABASE))?)? != crate::database::DATABASE_SCHEMA_VERSION
    {
        return Err("请先用当前版本升级数据目录，再修复 X 附件引用".into());
    }
    let plan = plan(root)?;
    let receipt = state_directory(&root)?.join(format!("x-obsidian-{}.json", identifier()));
    files::write_new_json(&receipt, &plan)?;
    let backup = receipt.with_extension("before.sqlite3");
    snapshot(&root.join(DATABASE), &backup, &AtomicBool::new(false))?;
    let mut c = Connection::open_with_flags(root.join(DATABASE), OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|e| e.to_string())?;
    let tx = c
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let mut saved = 0;
    let mut outbox = 0;
    let mut ownership = 0;
    let replacements: HashMap<_, _> = plan
        .files
        .iter()
        .map(|pair| (key(&pair.cached), pair))
        .collect();
    // Scan each reference owner once, preserving the stable local_seq identities.
    for name in [
        "collection_saved_media",
        "collection_owned_assets",
        "reading_media_outbox",
    ] {
        if !table(&tx, name)? {
            continue;
        }
        let field = if name == "reading_media_outbox" {
            "COALESCE(CASE WHEN json_valid(body) THEN json_extract(body,'$.key') END,'')"
        } else {
            "item_key"
        };
        let filter = media_policy::x_sql(field);
        let sql = format!("SELECT rowid,path FROM {name} WHERE {filter}");
        let rows = {
            let mut q = tx.prepare(&sql).map_err(|e| e.to_string())?;
            let rows = q
                .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        for (rowid, path) in rows {
            let Some(pair) = replacements.get(&key(Path::new(&path))) else {
                continue;
            };
            if name == "collection_owned_assets" {
                ownership += tx
                    .execute(
                        "DELETE FROM collection_owned_assets WHERE rowid=?1 AND path=?2",
                        params![rowid, path],
                    )
                    .map_err(|e| e.to_string())?;
            } else {
                let changed = tx
                    .execute(
                        &format!("UPDATE {name} SET path=?1 WHERE rowid=?2 AND path=?3"),
                        params![pair.original.to_string_lossy(), rowid, path],
                    )
                    .map_err(|e| e.to_string())?;
                if name == "collection_saved_media" {
                    saved += changed;
                } else {
                    outbox += changed;
                }
            }
        }
    }
    // External X originals must never remain in Hub's deletion ownership table.
    let vault = media_policy::x_vault(&tx)?;
    if table(&tx, "collection_owned_assets")? {
        let rows = {
            let mut q = tx
                .prepare(&format!(
                    "SELECT rowid,path FROM collection_owned_assets WHERE {}",
                    media_policy::x_sql("item_key")
                ))
                .map_err(|e| e.to_string())?;
            let rows = q
                .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        for (rowid, path) in rows {
            if vault_asset(Path::new(&path), &vault) && Path::new(&path).is_file() {
                ownership += tx
                    .execute(
                        "DELETE FROM collection_owned_assets WHERE rowid=?1",
                        [rowid],
                    )
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    tx.execute("INSERT INTO metadata(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![MARKER,receipt.to_string_lossy()]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    let mut value = summary(&plan);
    value["relinkedSavedMedia"] = json!(saved);
    value["relinkedOutbox"] = json!(outbox);
    value["releasedOwnershipRows"] = json!(ownership);
    value["receipt"] = json!(receipt);
    value["databaseBackup"] = json!(backup);
    Ok(value)
}

fn concrete_references(c: &Connection) -> Result<BTreeSet<String>, String> {
    let mut paths = BTreeSet::new();
    for name in [
        "collection_saved_media",
        "collection_owned_assets",
        "reading_media_outbox",
        "craft_backup_files",
    ] {
        if !table(c, name)? {
            continue;
        }
        let mut q = c
            .prepare(&format!(
                "SELECT DISTINCT path FROM {name} WHERE path IS NOT NULL AND path<>''"
            ))
            .map_err(|e| e.to_string())?;
        for row in q
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
        {
            paths.insert(key(Path::new(&row.map_err(|e| e.to_string())?)));
        }
    }
    for (name, column) in [
        ("documents", "path"),
        ("flashcards", "source_path"),
        ("flashcard_drafts", "source_path"),
        ("flashcard_import_batches", "source_path"),
        ("collection_local_source_assets", "path"),
        ("flashcard_cloud_media_local_verifications", "path"),
    ] {
        if !table(c, name)? {
            continue;
        }
        let has_column: bool = c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name=?2)",
                params![name, column],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !has_column {
            continue;
        }
        let mut q = c
            .prepare(&format!(
                "SELECT DISTINCT {column} FROM {name} WHERE {column} IS NOT NULL AND {column}<>''"
            ))
            .map_err(|e| e.to_string())?;
        for row in q
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
        {
            paths.insert(key(Path::new(&row.map_err(|e| e.to_string())?)));
        }
    }
    Ok(paths)
}

pub(crate) fn cleanup(root: &Path) -> Result<Value, String> {
    let root = files::existing_directory(root)?;
    let _session = crate::data_portability::exclusive_session(&root)?;
    let _maintenance = crate::data_portability::maintenance_lock(&root)?;
    let c = readonly(&root.join(DATABASE))?;
    let receipt: String = c
        .query_row("SELECT value FROM metadata WHERE key=?1", [MARKER], |r| {
            r.get(0)
        })
        .map_err(|_| "请先修复并提交 X 附件引用")?;
    let receipt = PathBuf::from(receipt);
    files::reject_links(&receipt)?;
    if !receipt.starts_with(state_directory(&root)?) {
        return Err("X 修复回执不属于当前数据目录".into());
    }
    let plan: Receipt = serde_json::from_slice(&fs::read(&receipt).map_err(io_error)?)
        .map_err(|_| "X 修复回执损坏")?;
    if plan.version != 1 || key(&plan.root) != key(&root) {
        return Err("X 修复回执身份不一致".into());
    }
    let vault = media_policy::x_vault(&c)?;
    let refs = concrete_references(&c)?;
    let mut deleted = 0;
    let mut bytes = 0;
    let mut retained = Vec::new();
    let mut absent = 0;
    for pair in &plan.files {
        if !pair.cached.is_file() {
            absent += 1;
            continue;
        }
        if !(pair.cached.starts_with(root.join("collection-files"))
            || pair.cached.starts_with(root.join("reading-media-v1")))
            || !(x_asset(&pair.original, &vault)
                || (pair.from_x_lookup && vault_asset(&pair.original, &vault)))
            || refs.contains(&key(&pair.cached))
        {
            retained.push(pair.cached.clone());
            continue;
        }
        files::reject_links(&pair.cached)?;
        files::reject_links(&pair.original)?;
        match delete_duplicate_copy(&pair.cached, &pair.original, pair.bytes, &pair.sha256) {
            Ok(()) => {
                deleted += 1;
                bytes += pair.bytes;
            }
            Err(_) => retained.push(pair.cached.clone()),
        }
    }
    let result = json!({"deletedFiles":deleted,"deletedLogicalBytes":bytes,"alreadyAbsent":absent,
        "retainedFiles":retained,"receipt":receipt,"obsidianOriginalsModified":false});
    files::write_new_json(
        &receipt.with_extension(format!("cleanup-{}.json", identifier())),
        &result,
    )?;
    Ok(result)
}

#[cfg(test)]
mod tests;
