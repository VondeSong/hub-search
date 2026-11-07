//! Relink local upload receipts by their exact content identity, never by filename.
//! Original vaults are not opened or moved; only owned cached files are read.
use super::*;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Change {
    namespace: String,
    id: String,
    old_path: String,
    new_path: String,
    original_sequence: i64,
    body_checksum: String,
    expected_hash: Option<String>,
    expected_bytes: Option<u64>,
    #[serde(skip)]
    original_body: String,
}

#[derive(Default)]
pub(super) struct Plan {
    changes: Vec<Change>,
    pub unresolved: usize,
    ignored: BTreeSet<String>,
}

fn key(path: &Path) -> String {
    let value = crate::sources::display_local_path(path).replace('\\', "/");
    #[cfg(windows)]
    let value = value.to_lowercase();
    value.trim_end_matches('/').to_string()
}

fn inside(path: &Path, root: &Path) -> bool {
    let path = key(path);
    !path.split('/').any(|part| part == "..") && path.starts_with(&format!("{}/", key(root)))
}

fn owned_cache(path: &Path, root: &Path) -> bool {
    inside(path, &root.join("collection-files")) || inside(path, &root.join("blobs-v1"))
}

fn valid_candidate(
    path: &Path,
    root: &Path,
    hash: &str,
    size: u64,
    cancel: &AtomicBool,
    checked: &mut HashMap<PathBuf, (u64, String)>,
) -> Result<bool, String> {
    checkpoint(cancel)?;
    if !owned_cache(path, root) || files::reject_links(path).is_err() || !path.is_file() {
        return Ok(false);
    }
    let actual_size = fs::metadata(path).map_err(io_error)?.len();
    if actual_size != size {
        return Ok(false);
    }
    let actual =
        if let Some((cached_size, digest)) = checked.get(path).filter(|(n, _)| *n == actual_size) {
            let _ = cached_size;
            digest.clone()
        } else {
            let digest = files::hash_file(path, cancel)?;
            checked.insert(path.to_path_buf(), (actual_size, digest.clone()));
            digest
        };
    Ok(actual.eq_ignore_ascii_case(hash))
}

impl Plan {
    pub fn ignore_outbox_path(&self, path: &str) -> bool {
        self.ignored.contains(path)
    }
    pub fn changed(&self) -> usize {
        self.changes.len()
    }
    pub fn summary(&self) -> Value {
        let cleared = self
            .changes
            .iter()
            .filter(|change| change.new_path.is_empty())
            .count();
        json!({"relinked":self.changes.len()-cleared,"clearedSkippedPaths":cleared,
            "unresolved":self.unresolved,"originalVaultsModified":false})
    }
    pub fn verify(&self, root: &Path, cancel: &AtomicBool) -> Result<(), String> {
        let mut checked = HashMap::new();
        for change in &self.changes {
            if let (Some(hash), Some(size)) = (&change.expected_hash, change.expected_bytes) {
                if !valid_candidate(
                    Path::new(&change.new_path),
                    root,
                    hash,
                    size,
                    cancel,
                    &mut checked,
                )? {
                    return Err("用于重连的本地副本发生变化，旧上传路径保留".into());
                }
            }
        }
        Ok(())
    }
    pub fn apply(&self, connection: &Connection) -> Result<(), String> {
        for change in &self.changes {
            let affected = connection
                .execute(
                    "UPDATE reading_media_outbox SET path=?1 WHERE namespace=?2 AND id=?3
                 AND path=?4 AND CAST(body AS TEXT)=?5 AND local_seq=?6",
                    params![
                        change.new_path,
                        change.namespace,
                        change.id,
                        change.old_path,
                        change.original_body,
                        change.original_sequence
                    ],
                )
                .map_err(|error| format!("无法重连旧附件上传路径：{error}"))?;
            if affected != 1 {
                return Err("附件上传记录已变化，未覆盖较新的记录".into());
            }
        }
        Ok(())
    }
}

pub(super) fn plan(database: &Path, root: &Path, cancel: &AtomicBool) -> Result<Plan, String> {
    let c = readonly(database)?;
    let columns = c
        .prepare("SELECT name FROM pragma_table_info('reading_media_outbox')")
        .map_err(|e| e.to_string())?
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<BTreeSet<_>, _>>()
        .map_err(|error| error.to_string())?;
    if !["namespace", "id", "body", "path", "local_seq"]
        .iter()
        .all(|name| columns.contains(*name))
    {
        return Ok(Plan::default());
    }
    let has_saved: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='collection_saved_media')",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    let rows = {
        let mut q=c.prepare("SELECT namespace,id,CAST(body AS TEXT),path,local_seq FROM reading_media_outbox WHERE path IS NOT NULL AND path<>'' ORDER BY namespace,id").map_err(|e|e.to_string())?;
        let rows = q
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    let mut result = Plan::default();
    let mut states = BTreeMap::<String, (usize, usize)>::new();
    let mut checked = HashMap::new();
    for (namespace, id, body, old_path, sequence) in rows {
        checkpoint(cancel)?;
        if inside(Path::new(&old_path), root)
            && files::reject_links(Path::new(&old_path)).is_ok()
            && Path::new(&old_path).is_file()
        {
            continue;
        }
        let counts = states.entry(old_path.clone()).or_default();
        counts.0 += 1;
        let Ok(value) = serde_json::from_str::<Value>(&body) else {
            result.unresolved += 1;
            continue;
        };
        if media_policy::is_x(value["key"].as_str().unwrap_or("")) {
            continue;
        }
        if value["format"].as_u64() != Some(1) {
            result.unresolved += 1;
            continue;
        }
        let state = value["state"].as_str().unwrap_or("");
        let mut target = None;
        let mut expected = None;
        let mut expected_size = None;
        if state == "skipped" {
            // A skipped manifest publishes metadata only. Its source bytes stay
            // in saved_media; the stale upload pathname is not needed.
            target = Some(String::new());
        } else if state == "ready" {
            let hash = value["hash"].as_str().unwrap_or("").to_ascii_lowercase();
            if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
                result.unresolved += 1;
                continue;
            }
            let Some(size) = value["size"].as_u64().filter(|n| *n > 0) else {
                result.unresolved += 1;
                continue;
            };
            let mut candidates = Vec::new();
            if has_saved {
                let saved:Option<String>=c.query_row("SELECT path FROM collection_saved_media WHERE item_key=?1 AND media_url=?2",
                    params![value["key"].as_str().unwrap_or(""),value["url"].as_str().unwrap_or("")],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
                if let Some(path) = saved {
                    candidates.push(PathBuf::from(path));
                }
            }
            let directory = root.join("collection-files/recovered-assets").join(&hash);
            if files::reject_links(&directory).is_ok() && directory.is_dir() {
                for entry in fs::read_dir(directory).map_err(io_error)? {
                    candidates.push(entry.map_err(io_error)?.path());
                }
            }
            candidates.push(root.join("blobs-v1").join(&hash[..2]).join(&hash));
            for candidate in candidates {
                if valid_candidate(&candidate, root, &hash, size, cancel, &mut checked)? {
                    target = Some(crate::sources::display_local_path(&candidate));
                    expected = Some(hash.clone());
                    expected_size = Some(size);
                    break;
                }
            }
        }
        if let Some(new_path) = target {
            counts.1 += 1;
            result.changes.push(Change {
                namespace,
                id,
                old_path,
                new_path,
                original_sequence: sequence,
                body_checksum: format!("{:x}", Sha256::digest(body.as_bytes())),
                expected_hash: expected,
                expected_bytes: expected_size,
                original_body: body,
            });
        } else {
            result.unresolved += 1;
        }
    }
    result.ignored = states
        .into_iter()
        .filter(|(_, counts)| counts.0 == counts.1)
        .map(|(path, _)| path)
        .collect();
    Ok(result)
}

pub(crate) fn preview_legacy_media_paths(root: &Path) -> Result<Value, String> {
    let root = files::existing_directory(root)?;
    let c = readonly(&root.join(DATABASE))?;
    if schema_version(&c)? != crate::database::DATABASE_SCHEMA_VERSION {
        return Err("请先用当前版本打开并升级数据目录".into());
    }
    drop(c);
    Ok(plan(&root.join(DATABASE), &root, &AtomicBool::new(false))?.summary())
}

pub(crate) fn repair_legacy_media_paths(root: &Path) -> Result<Value, String> {
    let root = files::existing_directory(root)?;
    let _session = crate::data_portability::exclusive_session(&root)?;
    let _maintenance = crate::data_portability::maintenance_lock(&root)?;
    let c = readonly(&root.join(DATABASE))?;
    if schema_version(&c)? != crate::database::DATABASE_SCHEMA_VERSION {
        return Err("请先用当前版本打开并升级数据目录".into());
    }
    drop(c);
    let cancel = AtomicBool::new(false);
    let plan = plan(&root.join(DATABASE), &root, &cancel)?;
    plan.verify(&root, &cancel)?;
    let mut summary = plan.summary();
    if plan.changed() == 0 {
        return Ok(summary);
    }
    let id = identifier();
    let receipt = state_directory(&root)?.join(format!("legacy-media-paths-{id}.json"));
    files::write_new_json(
        &receipt,
        &json!({"operation":"relinkLegacyMediaPaths","state":"prepared",
        "root":root,"changes":plan.changes,"summary":summary}),
    )?;
    let mut c = Connection::open_with_flags(root.join(DATABASE), OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|e| e.to_string())?;
    c.busy_timeout(Duration::from_millis(1500))
        .map_err(|e| e.to_string())?;
    let tx = c
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    plan.apply(&tx)?;
    tx.commit().map_err(|e| e.to_string())?;
    summary["receipt"] = json!(receipt);
    if files::replace_json(
        &receipt,
        &json!({"operation":"relinkLegacyMediaPaths","state":"committed",
        "root":root,"changes":plan.changes,"summary":summary}),
    )
    .is_err()
    {
        summary["warning"] = json!("路径已修复；请保留原始 prepared 记录供复核。");
    }
    Ok(summary)
}
