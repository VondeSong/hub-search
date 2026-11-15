//! Local files retain their own source identity and share the attachment text pipeline.
use crate::*;
use std::io::Read;

const PROVIDER: &str = "files";
const MAX_FILE: u64 = 64 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Args {
    action: String,
    path: Option<String>,
    name: Option<String>,
    recursive: Option<bool>,
    start_now: Option<bool>,
}

struct Entry {
    path: PathBuf,
    relative: String,
    mime: &'static str,
}
struct Scan {
    root: PathBuf,
    entries: Vec<Entry>,
    ignored: usize,
}

fn mime(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "txt" => Some("text/plain"),
        "docx" => Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        _ => None,
    }
}

fn scan(
    path: &Path,
    recursive: bool,
    checkpoint: &impl Fn() -> Result<(), String>,
) -> Result<Scan, String> {
    if !path.is_absolute() {
        return Err("请输入文件夹完整路径".into());
    }
    let root = path
        .canonicalize()
        .map_err(|e| format!("无法打开文件夹：{e}"))?;
    if !root.is_dir() {
        return Err("所选路径不是文件夹".into());
    }
    let mut result = Scan {
        root: root.clone(),
        entries: Vec::new(),
        ignored: 0,
    };
    let mut pending = vec![(root.clone(), 0usize)];
    let mut visited = HashSet::new();
    let started = Instant::now();
    let mut count = 0;
    while let Some((directory, depth)) = pending.pop() {
        checkpoint()?;
        let canonical = directory
            .canonicalize()
            .map_err(|e| format!("无法检查子目录：{e}"))?;
        if !canonical.starts_with(&root) || !visited.insert(canonical.clone()) {
            continue;
        }
        for item in fs::read_dir(&canonical)
            .map_err(|e| format!("无法完整读取目录，未执行删除核对：{e}"))?
        {
            checkpoint()?;
            count += 1;
            if count > 10_000 || started.elapsed() > Duration::from_secs(30) {
                return Err("文件夹超过首批扫描上限（1万项或30秒），请选择更小的目录".into());
            }
            let item = item.map_err(|e| format!("目录读取不完整：{e}"))?;
            let kind = item.file_type().map_err(|e| e.to_string())?;
            if kind.is_symlink() {
                result.ignored += 1;
                continue;
            }
            let path = item.path();
            if kind.is_dir() {
                let name = item.file_name();
                if matches!(
                    name.to_str(),
                    Some(".git" | ".obsidian" | ".trash" | ".basic-memory" | "node_modules")
                ) {
                    continue;
                }
                if recursive {
                    if depth >= 32 {
                        return Err("子目录超过32层，请缩小读取范围".into());
                    }
                    pending.push((path, depth + 1));
                }
            } else if kind.is_file() {
                if let Some(mime) = mime(&path) {
                    let canonical = path.canonicalize().map_err(|e| e.to_string())?;
                    if !canonical.starts_with(&root) {
                        result.ignored += 1;
                        continue;
                    }
                    let relative = canonical
                        .strip_prefix(&root)
                        .map_err(|_| "文件不在所选目录")?
                        .to_str()
                        .ok_or("文件路径编码不受支持")?
                        .replace('\\', "/");
                    result.entries.push(Entry {
                        path: canonical,
                        relative,
                        mime,
                    });
                } else {
                    result.ignored += 1;
                }
            }
        }
    }
    result.entries.sort_by(|a, b| a.relative.cmp(&b.relative));
    Ok(result)
}

fn check_overlap(c: &Connection, root: &Path) -> Result<(), String> {
    let mut stmt=c.prepare("SELECT name,location FROM libraries WHERE enabled=1 AND provider IN ('obsidian','files') AND location IS NOT NULL").map_err(|e|e.to_string())?;
    for row in stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?
    {
        let (name, path) = row.map_err(|e| e.to_string())?;
        if let Ok(existing) = Path::new(&path).canonicalize() {
            if root.starts_with(&existing) || existing.starts_with(root) {
                return Err(format!(
                    "此目录与已接入的“{name}”重叠，请直接使用已有资料库"
                ));
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn local_file_sources(app: AppHandle, args: Args) -> Result<Value, String> {
    if args.action == "capabilities" {
        return Ok(
            json!({"enabled":cfg!(feature="experimental-local-file-text"),"formats":["txt","docx"]}),
        );
    }
    if !cfg!(feature = "experimental-local-file-text") {
        return Err("当前客户端未启用实验性本地文件接入".into());
    }
    if !matches!(args.action.as_str(), "inspect" | "add") {
        return Err("不支持的本地文件操作".into());
    }
    let path = PathBuf::from(args.path.as_deref().unwrap_or("").trim());
    let recursive = args.recursive.unwrap_or(true);
    let database = database_path(&app)?;
    let add = args.action == "add";
    let start_now = args.start_now.unwrap_or(false);
    let (value,id,epoch)=tokio::task::spawn_blocking(move || {
        let found=scan(&path,recursive,&||Ok(()))?;
        let (c,_writer)=open_write_database(&database)?;
        check_overlap(&c,&found.root)?;
        let location=display_local_path(&found.root);
        let id=format!("files:{:x}",Sha256::digest(location.to_lowercase().as_bytes()));
        let mut value=json!({"path":location,"supported":found.entries.len(),"ignored":found.ignored,"recursive":recursive,"libraryId":id});
        let mut epoch=0;
        if add {
            let name=args.name.as_deref().unwrap_or("").trim();
            if name.is_empty() || name.chars().count()>80 { return Err("资料库名称需要1至80个字符".into()); }
            if found.entries.is_empty() { return Err("此范围没有可接入的TXT或DOCX文件".into()); }
            epoch=prepare_library_add(&database,&id)?;
            c.execute("INSERT INTO libraries(id,provider,name,location,enabled,added_at,metadata_json) VALUES (?1,'files',?2,?3,1,?4,?5)",params![id,name,location,now_timestamp(),json!({"recursive":recursive}).to_string()]).map_err(|e|format!("无法登记本地文件夹：{e}"))?;
            value["added"]=json!(true);
        }
        Ok::<_,String>((value,id,epoch))
    }).await.map_err(|e|e.to_string())??;
    if add {
        let policy = library_policy::Overrides {
            other_download: Some(true),
            ..Default::default()
        };
        finish_library_add(
            &app,
            &id,
            epoch,
            Some(LibraryAddOptions {
                start_now,
                content_policy: Some(policy),
            }),
        )
        .await?;
        let _ = app.emit("library-registry-updated", ());
    }
    Ok(value)
}

fn read_entry(root: &Path, entry: &Entry) -> Result<Vec<u8>, String> {
    let canonical = entry.path.canonicalize().map_err(|e| e.to_string())?;
    if !canonical.starts_with(root) {
        return Err("文件已移出接入目录".into());
    }
    let file = fs::File::open(&canonical).map_err(|e| e.to_string())?;
    let before = file.metadata().map_err(|e| e.to_string())?;
    if before.len() > MAX_FILE {
        return Err("文件超过64 MiB提取上限".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_FILE + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let after = fs::metadata(&canonical).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_FILE
        || before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
    {
        return Err("读取期间文件已变化，请重新更新资料库".into());
    }
    Ok(bytes)
}

pub(crate) fn sync(
    database: &PathBuf,
    library: &str,
    root: &Path,
    store: &BlobStore,
    operation: &library_runtime::Operation,
) -> Result<SyncSummary, String> {
    operation.phase("reading", "读取本地文件夹")?;
    let c = open_database(database)?;
    let metadata: String = c
        .query_row(
            "SELECT metadata_json FROM libraries WHERE id=?1 AND provider='files' AND enabled=1",
            [library],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let recursive = serde_json::from_str::<Value>(&metadata)
        .ok()
        .and_then(|v| v["recursive"].as_bool())
        .unwrap_or(true);
    let existing = {
        let mut q = c
            .prepare("SELECT id,content_hash FROM documents WHERE space_id=?1 AND provider='files'")
            .map_err(|e| e.to_string())?;
        let rows = q
            .query_map([library], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<HashMap<_, _>, _>>()
            .map_err(|e| e.to_string())?
    };
    drop(c);
    // A complete enumeration is required before removing any stale cached entry.
    let found = scan(root, recursive, &|| operation.checkpoint())?;
    let mut seen = HashSet::new();
    let mut bytes_read = 0u64;
    let (mut indexed, mut skipped, mut failed) = (0, 0, 0);
    for entry in found.entries {
        operation.checkpoint()?;
        let id = format!("{library}:{:x}", Sha256::digest(entry.relative.as_bytes()));
        seen.insert(id.clone());
        let outcome = read_entry(&found.root, &entry).and_then(|bytes| {
            bytes_read = bytes_read.saturating_add(bytes.len() as u64);
            if bytes_read > 512 * 1024 * 1024 {
                return Err("本轮读取超过512 MiB，请选择更小目录".into());
            }
            store.put(&bytes)
        });
        if bytes_read > 512 * 1024 * 1024 {
            return Err(
                "本轮读取超过512 MiB，已保留完成部分且未执行删除核对。请选择更小目录".into(),
            );
        }
        let (hash, size, relative, error) = match outcome {
            Ok(blob) => (
                Some(blob.hash),
                blob.size as i64,
                Some(blob.relative_path),
                None,
            ),
            Err(e) => {
                failed += 1;
                (None, 0, None, Some(e))
            }
        };
        let title = entry
            .path
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or("文件名编码不受支持")?;
        let now = now_timestamp();
        let modified = fs::metadata(&entry.path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|v| v.as_secs() as i64)
            .unwrap_or(0);
        let source = format!("local-file:{id}");
        let folder = entry.relative.rsplit_once('/').map(|(path, _)| path);
        let folder_id = folder.map(|path| obsidian_folder_id(library, path));
        let (mut c, _writer) = open_write_database(database)?;
        let tx = c
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        if let (Some(hash), Some(relative)) = (&hash, &relative) {
            tx.execute("INSERT INTO blobs(hash,size,mime_type,relative_path,created_at,verified_at) VALUES(?1,?2,?3,?4,?5,?5) ON CONFLICT(hash) DO NOTHING",params![hash,size,entry.mime,relative,now]).map_err(|e|e.to_string())?;
        }
        if let (Some(path), Some(folder_id)) = (folder, &folder_id) {
            tx.execute("INSERT INTO folders(space_id,id,name,path,provider) VALUES(?1,?2,?3,?3,'files') ON CONFLICT(space_id,id) DO UPDATE SET name=excluded.name,path=excluded.path",params![library,folder_id,path]).map_err(|e|e.to_string())?;
        }
        tx.execute("INSERT INTO documents(space_id,id,title,path,markdown,modified_at,indexed_at,content_hash,missing_syncs,provider) VALUES(?1,?2,?3,?4,'',?7,?5,?6,0,'files') ON CONFLICT(space_id,id) DO UPDATE SET title=excluded.title,path=excluded.path,indexed_at=excluded.indexed_at,modified_at=excluded.modified_at,content_hash=excluded.content_hash,missing_syncs=0",params![library,id,title,entry.relative,now,hash.as_deref().unwrap_or(""),modified]).map_err(|e|e.to_string())?;
        tx.execute(
            "UPDATE documents SET folder_id=?1 WHERE space_id=?2 AND id=?3",
            params![folder_id, library, id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO source_items(id,space_id,document_id,remote_id,source_type,title,mime_type,content_hash,blob_hash,status,metadata_json,created_at,updated_at,last_seen_at,missing_syncs,provider) VALUES(?1,?2,?3,?4,'local_file',?5,?6,?7,?7,?8,?9,?10,?10,?10,0,'files') ON CONFLICT(space_id,remote_id,source_type) DO UPDATE SET title=excluded.title,content_hash=excluded.content_hash,blob_hash=excluded.blob_hash,status=excluded.status,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at,last_seen_at=excluded.last_seen_at,missing_syncs=0",params![source,library,id,entry.relative,title,entry.mime,hash,if error.is_some(){"unavailable"}else{"stored"},json!({"localRelativePath":entry.relative,"readError":error,"size":size}).to_string(),now]).map_err(|e|e.to_string())?;
        if hash.as_ref().is_some_and(|h| existing.get(&id) == Some(h)) {
            skipped += 1;
        } else {
            tx.execute("DELETE FROM index_jobs WHERE space_id=?1 AND source_id=?2 AND job_type='extract_file'",params![library,source]).map_err(|e|e.to_string())?;
            tx.execute(
                "DELETE FROM content_items WHERE space_id=?1 AND document_id=?2",
                params![library, id],
            )
            .map_err(|e| e.to_string())?;
            tx.execute("INSERT INTO index_jobs(job_key,space_id,source_id,source_type,job_type,status,priority,created_at,updated_at,provider) VALUES(?1,?2,?3,'document','upsert_lexical','pending',20,?4,?4,'files') ON CONFLICT(job_key) DO UPDATE SET job_type='upsert_lexical',status='pending',attempts=0,updated_at=excluded.updated_at,worker_id=NULL,locked_at=NULL,lease_until=NULL,next_attempt_at=0,last_error=NULL",params![format!("lexical:{library}:{id}"),library,id,now]).map_err(|e|e.to_string())?;
            indexed += 1;
        }
        operation.commit(|| tx.commit().map_err(|e| e.to_string()))?;
    }
    let deleted = existing
        .keys()
        .filter(|id| !seen.contains(*id))
        .collect::<Vec<_>>();
    for id in &deleted {
        let (mut c, _writer) = open_write_database(database)?;
        let tx = c
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        delete_local_document(&tx, library, id, now_timestamp(), PROVIDER)?;
        operation.commit(|| tx.commit().map_err(|e| e.to_string()))?;
    }
    let (c, _writer) = open_write_database(database)?;
    operation.commit(|| {
        c.execute("DELETE FROM folders WHERE space_id=?1 AND provider='files' AND NOT EXISTS(SELECT 1 FROM documents d WHERE d.space_id=folders.space_id AND d.folder_id=folders.id)",[library]).map_err(|e|e.to_string())?;
        c.execute(
            "UPDATE libraries SET last_sync=?1 WHERE id=?2",
            params![now_timestamp(), library],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    })?;
    Ok(SyncSummary {
        indexed,
        skipped,
        deleted: deleted.len(),
        failed,
    })
}

pub(crate) fn original_url(
    c: &Connection,
    library: &str,
    document: &str,
) -> Result<String, String> {
    let (root,relative):(String,String)=c.query_row("SELECT l.location,d.path FROM libraries l JOIN documents d ON d.space_id=l.id WHERE l.id=?1 AND d.id=?2 AND l.provider='files' AND l.enabled=1",params![library,document],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|e|e.to_string())?;
    let root = Path::new(&root).canonicalize().map_err(|e| e.to_string())?;
    let file = root
        .join(relative)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !file.starts_with(root) || !file.is_file() {
        return Err("原文件不在接入目录内".into());
    }
    Url::from_file_path(file)
        .map(|u| u.to_string())
        .map_err(|_| "无法生成原文件链接".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn relative_paths_and_unimplemented_formats_are_rejected() {
        assert!(scan(Path::new("relative"), true, &|| Ok(())).is_err());
        assert!(mime(Path::new("sheet.xlsx")).is_none());
        assert!(mime(Path::new("note.TXT")).is_some());
        assert_eq!(
            library_policy::capabilities("files").other_download,
            cfg!(feature = "experimental-local-file-text")
        );
    }
    #[test]
    #[ignore = "explicit read-only inventory of the actual selected directory"]
    fn live_selected_directory_is_readable_without_source_changes() {
        let path = std::env::var_os("HUB_LIBRARY35_REAL_DIRECTORY")
            .expect("必须明确指定现有真实目录；不创建样例文件夹");
        let scan = scan(Path::new(&path), false, &|| Ok(())).unwrap();
        assert_eq!(scan.entries.len(), 3);
        println!(
            "real directory inventory: {} supported files, {} unsupported or linked entries",
            scan.entries.len(),
            scan.ignored
        );
        for entry in &scan.entries {
            let bytes = read_entry(&scan.root, entry).unwrap();
            let before = Sha256::digest(&bytes);
            let text = crate::file_text::extract(&bytes, entry.mime).unwrap();
            assert!(!text.trim().is_empty());
            assert_eq!(before, Sha256::digest(fs::read(&entry.path).unwrap()));
        }
    }
}
