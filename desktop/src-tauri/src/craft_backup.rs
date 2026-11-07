//! Durable Craft archives. Objects and snapshots live in a user-selected root,
//! never in the disposable search cache. A snapshot is committed only after all
//! its required objects have been read back and verified.
use crate::blob_store::BlobStore;
use crate::craft_export::{
    CraftVaultExportOptions, CraftVaultExportProgress, ExportAttachment, ExportDocument,
};
use crate::{
    call_craft_read_raw, craft_cli_quote, now_timestamp, parse_document_listing,
    parse_named_listing, parse_tool_json, read_craft_block_pages as read_craft_block_pages_once,
    tool_result_text, without_next_page_instruction, McpSession,
};
use futures::StreamExt;
use rand::RngCore;
use reqwest::Client;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;
use url::Url;

const VERSION: u32 = 1;
const MAX_ASSET_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const CONFIG_PREFIX: &str = "craft_backup_config:";

#[path = "craft_backup_cache.rs"]
mod cache;

async fn read_craft_block_pages(
    client: &Client,
    session: &McpSession,
    command: &str,
    request_id: u64,
) -> Result<Vec<Value>, String> {
    for attempt in 0..3 {
        match read_craft_block_pages_once(client, session, command, request_id).await {
            Ok(pages) => return Ok(pages),
            Err(error)
                if attempt < 2
                    && [
                        "502 Bad Gateway",
                        "503 Service Unavailable",
                        "504 Gateway Timeout",
                        "429 Too Many Requests",
                    ]
                    .iter()
                    .any(|status| error.contains(status)) =>
            {
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupConfig {
    pub library_id: String,
    pub destination: String,
    pub vault_name: String,
    pub interval_minutes: u64,
    pub replica_destination: Option<String>,
    pub last_attempt_at: i64,
    pub last_success_at: Option<i64>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupIssue {
    pub object_id: String,
    pub category: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotDocument {
    pub id: String,
    pub raw_document_id: Option<String>,
    pub title: String,
    pub folder_path: String,
    pub location: String,
    pub modified_at: Option<i64>,
    pub markdown_hash: String,
    pub structure_hash: String,
    pub block_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotAttachment {
    pub id: String,
    pub document_id: String,
    pub title: String,
    pub mime_type: String,
    pub remote_url: String,
    pub link_kind: String,
    pub expected_bytes: Option<u64>,
    #[serde(default)]
    pub resource_revision: Option<String>,
    #[serde(default)]
    pub remote_etag: Option<String>,
    pub object_hash: Option<String>,
    pub bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub version: u32,
    pub id: String,
    pub library_id: String,
    pub library_name: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub status: String,
    pub inventory_hash: Option<String>,
    pub folders_hash: Option<String>,
    pub connection_hash: Option<String>,
    pub documents: Vec<SnapshotDocument>,
    pub attachments: Vec<SnapshotAttachment>,
    #[serde(default)]
    pub external_references: Vec<SnapshotAttachment>,
    pub supplemental_objects: BTreeMap<String, String>,
    pub issues: Vec<BackupIssue>,
    pub limitations: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupHistory {
    pub config: Option<BackupConfig>,
    pub backup_root: Option<String>,
    pub snapshots: Vec<Snapshot>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verification {
    pub snapshot_id: String,
    pub valid: bool,
    pub checked_objects: usize,
    pub issues: Vec<BackupIssue>,
}

fn hash_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn hash_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|_| "无法打开备份文件".to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| "无法读取备份文件".to_string())?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn write_json_new(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    if path.exists() {
        return Err("备份记录已存在，拒绝覆盖".into());
    }
    let temporary = path.with_extension(format!("pending-{:016x}", rand::thread_rng().next_u64()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| format!("无法创建备份记录：{error}"))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| error.to_string())?;
    drop(file);
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

pub fn backup_root(options: &CraftVaultExportOptions) -> Result<PathBuf, String> {
    let parent = fs::canonicalize(options.destination.trim())
        .map_err(|_| "请先选择一个存在的备份保存目录".to_string())?;
    let name = options
        .vault_name
        .as_deref()
        .filter(|name| !name.trim().is_empty())
        .ok_or_else(|| "完整备份需要独立的 Vault 名称".to_string())?;
    Ok(parent.join(format!(
        "{} - 备份",
        crate::craft_export::sanitize_component(name, "Craft")
    )))
}

fn open_archive(root: &Path, library_id: &str) -> Result<BlobStore, String> {
    reject_links(root)?;
    fs::create_dir_all(root).map_err(|error| format!("无法创建备份目录：{error}"))?;
    let marker = root.join("archive.json");
    if marker.exists() {
        let value: Value =
            serde_json::from_slice(&fs::read(&marker).map_err(|error| error.to_string())?)
                .map_err(|_| "备份目录标识已损坏".to_string())?;
        if value["version"] != VERSION || value["libraryId"].as_str() != Some(library_id) {
            return Err("该备份目录属于另一个资料库或不支持的备份版本".to_string());
        }
    } else {
        if fs::read_dir(root)
            .map_err(|error| error.to_string())?
            .next()
            .is_some()
        {
            return Err("请选择空目录或本资料库原有的备份目录".to_string());
        }
        write_json_new(
            &marker,
            &json!({"version": VERSION, "libraryId": library_id}),
        )?;
    }
    for name in ["snapshots", "attempts", "objects"] {
        reject_links(&root.join(name))?;
        fs::create_dir_all(root.join(name)).map_err(|error| error.to_string())?;
    }
    BlobStore::open(&root.join("objects"))
}

pub fn reject_links(path: &Path) -> Result<(), String> {
    let mut current = path;
    loop {
        if let Ok(metadata) = fs::symlink_metadata(current) {
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if metadata.file_attributes() & 0x400 != 0 {
                    return Err("备份和恢复目录不能包含符号链接或目录联接".to_string());
                }
            }
            if metadata.file_type().is_symlink() {
                return Err("备份目录不能包含符号链接".to_string());
            }
        }
        let Some(parent) = current.parent() else {
            break;
        };
        current = parent;
    }
    Ok(())
}

fn issue(snapshot: &mut Snapshot, id: &str, category: &str, message: impl Into<String>) {
    let message = message
        .into()
        .split_whitespace()
        .map(|word| {
            if word.contains("https://") || word.contains("http://") {
                "[服务地址已隐藏]"
            } else {
                word
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    snapshot.issues.push(BackupIssue {
        object_id: id.to_string(),
        category: category.to_string(),
        message,
    });
}

fn put_json(store: &BlobStore, value: &impl Serialize) -> Result<String, String> {
    let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    let blob = store.put(&bytes)?;
    if hash_file(&store.path_for(&blob.hash)?)? != blob.hash {
        return Err("原始数据校验失败".to_string());
    }
    Ok(blob.hash)
}

fn parsed_pages(pages: Vec<Value>) -> Result<Vec<Value>, String> {
    pages
        .into_iter()
        .map(|page| {
            parse_tool_json(&page)
                .ok_or_else(|| "Craft 结构化响应不能解析，已停止完整性确认".to_string())
        })
        .collect()
}

fn block_ids(value: &Value, result: &mut BTreeSet<String>) {
    match value {
        Value::Object(map) => {
            if map.get("type").and_then(Value::as_str).is_some() {
                if let Some(id) = map.get("id").and_then(Value::as_str) {
                    result.insert(id.to_string());
                }
            }
            for child in map.values() {
                block_ids(child, result);
            }
        }
        Value::Array(items) => {
            for item in items {
                block_ids(item, result);
            }
        }
        _ => {}
    }
}

fn collect_resources(
    value: &Value,
    document_id: &str,
    resources: &mut BTreeMap<String, SnapshotAttachment>,
    specials: &mut BTreeSet<(String, String)>,
    unknown: &mut BTreeSet<String>,
) {
    match value {
        Value::Object(map) => {
            let kind = map.get("type").and_then(Value::as_str).unwrap_or_default();
            let id = map.get("id").and_then(Value::as_str).unwrap_or(document_id);
            if matches!(kind, "collection" | "whiteboard") {
                specials.insert((kind.to_string(), id.to_string()));
            }
            if !kind.is_empty()
                && !matches!(
                    kind,
                    "text"
                        | "page"
                        | "collectionItem"
                        | "image"
                        | "video"
                        | "file"
                        | "drawing"
                        | "whiteboard"
                        | "table"
                        | "collection"
                        | "code"
                        | "richUrl"
                        | "line"
                        | "comment"
                        | "rectangle"
                        | "ellipse"
                        | "diamond"
                        | "arrow"
                        | "freedraw"
                        | "frame"
                        | "embeddable"
                )
                && map.contains_key("id")
                && (map.contains_key("metadata")
                    || map.contains_key("markdown")
                    || map.contains_key("content")
                    || map.contains_key("url"))
            {
                unknown.insert(kind.to_string());
            }
            if matches!(kind, "image" | "video" | "file" | "drawing" | "whiteboard") {
                if let Some(url) = map
                    .get("url")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                {
                    let resource_id = if map.contains_key("id") {
                        format!("{document_id}:{id}:original")
                    } else {
                        format!(
                            "{document_id}:styling:{}",
                            &hash_bytes(url.as_bytes())[..16]
                        )
                    };
                    resources
                        .entry(resource_id.clone())
                        .or_insert(SnapshotAttachment {
                            id: resource_id,
                            document_id: document_id.to_string(),
                            title: map
                                .get("fileName")
                                .or_else(|| map.get("altText"))
                                .and_then(Value::as_str)
                                .filter(|value| !value.is_empty())
                                .unwrap_or(kind)
                                .to_string(),
                            mime_type: map
                                .get("mimeType")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                            remote_url: url.to_string(),
                            link_kind: if kind == "whiteboard" {
                                "image".into()
                            } else {
                                kind.to_string()
                            },
                            expected_bytes: map.get("fileSize").and_then(Value::as_u64),
                            resource_revision: crate::attachments::discover_attachments_from_json(
                                value,
                            )
                            .into_iter()
                            .find(|asset| asset.url == url && asset.block_id.as_deref() == Some(id))
                            .and_then(|asset| asset.resource_revision),
                            remote_etag: None,
                            object_hash: None,
                            bytes: None,
                        });
                } else if !map.contains_key("fileId")
                    && kind != "whiteboard"
                    && !(kind == "image"
                        && !map.contains_key("id")
                        && map
                            .get("image")
                            .and_then(|image| image.get("imageUrl"))
                            .and_then(Value::as_str)
                            .is_some_and(|url| allowed_asset_url(url)))
                {
                    unknown.insert(format!("{kind}:missing-url"));
                }
            }
            // Page styling can reference covers and background images without a
            // media block. Preserve those files as part of the same archive.
            for key in ["coverImage", "backgroundImage", "previewImageUrl"] {
                if let Some(url) = map
                    .get(key)
                    .and_then(Value::as_str)
                    .filter(|value| value.starts_with("https://"))
                {
                    let resource_id = format!("{document_id}:{id}:{key}");
                    resources
                        .entry(resource_id.clone())
                        .or_insert(SnapshotAttachment {
                            id: resource_id,
                            document_id: document_id.to_string(),
                            title: key.to_string(),
                            mime_type: "image/unknown".to_string(),
                            remote_url: url.to_string(),
                            link_kind: "image".to_string(),
                            expected_bytes: None,
                            resource_revision: None,
                            remote_etag: None,
                            object_hash: None,
                            bytes: None,
                        });
                }
            }
            for child in map.values() {
                collect_resources(child, document_id, resources, specials, unknown);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_resources(item, document_id, resources, specials, unknown);
            }
        }
        Value::String(text) => {
            // Styling/backdrops can contain serialized JSON. Plain resource
            // addresses also occur in cover and preview metadata.
            if text.starts_with('{') || text.starts_with('[') {
                if let Ok(parsed) = serde_json::from_str::<Value>(text) {
                    collect_resources(&parsed, document_id, resources, specials, unknown);
                }
            } else if Url::parse(text).ok().is_some_and(|url| {
                url.scheme() == "https"
                    && matches!(
                        url.host_str(),
                        Some(
                            "r.craft.do"
                                | "res.craft.do"
                                | "assets.craft.do"
                                | "images.unsplash.com"
                        )
                    )
            }) && !resources.values().any(|asset| asset.remote_url == *text)
            {
                let id = format!(
                    "{document_id}:resource:{}",
                    &hash_bytes(text.as_bytes())[..16]
                );
                resources.insert(
                    id.clone(),
                    SnapshotAttachment {
                        id,
                        document_id: document_id.into(),
                        title: "resource".into(),
                        mime_type: String::new(),
                        remote_url: text.clone(),
                        link_kind: "file".into(),
                        expected_bytes: None,
                        resource_revision: None,
                        remote_etag: None,
                        object_hash: None,
                        bytes: None,
                    },
                );
            }
        }
        _ => {}
    }
}

async fn inventory(
    client: &Client,
    session: &McpSession,
) -> Result<
    (
        BTreeMap<String, crate::RemoteDocument>,
        BTreeMap<String, String>,
        Vec<Value>,
    ),
    String,
> {
    let mut documents = BTreeMap::new();
    let mut locations = BTreeMap::new();
    let mut raw = Vec::new();
    for (index, location) in ["all", "unsorted", "templates", "daily_notes", "trash"]
        .iter()
        .enumerate()
    {
        let command = if *location == "all" {
            "documents list --metadata".to_string()
        } else {
            format!("documents list --location {location} --metadata")
        };
        let pages =
            read_craft_block_pages(client, session, &command, 20_000_000 + index as u64 * 1000)
                .await?;
        for page in pages {
            let text = tool_result_text(&page);
            let entries = parse_document_listing(&text);
            if entries.is_empty() && !text.contains("No documents found") {
                return Err(format!(
                    "无法确认 {location} 文档清单完整，已保留原有恢复点"
                ));
            }
            for entry in entries {
                if *location != "all" {
                    locations.insert(entry.id.clone(), location.to_string());
                }
                documents.insert(entry.id.clone(), entry);
            }
            raw.push(json!({"location": location, "response": page}));
        }
    }
    Ok((documents, locations, raw))
}

fn inventory_identity(
    documents: &BTreeMap<String, crate::RemoteDocument>,
    locations: &BTreeMap<String, String>,
) -> Value {
    Value::Array(documents.values().map(|doc| json!({"id":doc.id,"title":doc.title,"modifiedAt":doc.modified_at,"location":locations.get(&doc.id)})).collect())
}

fn folder_listing(text: &str) -> Vec<(String, String)> {
    let normalized = text
        .lines()
        .map(|line| {
            line.trim_start()
                .trim_start_matches(['*', '-'])
                .trim_start()
        })
        .collect::<Vec<_>>()
        .join("\n");
    parse_named_listing(&normalized)
        .into_iter()
        .map(|(id, name)| {
            let name = name
                .rsplit_once(" (")
                .filter(|(_, suffix)| suffix.ends_with("docs)") || suffix.ends_with("documents)"))
                .map(|(title, _)| title.to_string())
                .unwrap_or(name);
            (id, name)
        })
        .collect()
}

pub async fn capture(
    app: Option<&AppHandle>,
    client: &Client,
    session: &McpSession,
    root: &Path,
    library_id: &str,
    library_name: &str,
    force_full: bool,
) -> Result<Snapshot, String> {
    let store = open_archive(root, library_id)?;
    let id = format!(
        "{}-{:016x}",
        chrono::Utc::now().format("%Y%m%dT%H%M%SZ"),
        rand::thread_rng().next_u64()
    );
    let mut snapshot = Snapshot {
        version: VERSION,
        id: id.clone(),
        library_id: library_id.to_string(),
        library_name: library_name.to_string(),
        started_at: now_timestamp(),
        finished_at: None,
        status: "running".to_string(),
        inventory_hash: None,
        folders_hash: None,
        connection_hash: None,
        documents: Vec::new(),
        attachments: Vec::new(),
        external_references: Vec::new(),
        supplemental_objects: BTreeMap::new(),
        issues: Vec::new(),
        limitations: vec![
            "覆盖当前连接可访问的数据；不是 Craft 历史版本、权限和协作状态的系统镜像".to_string(),
            "外部网页、第三方嵌入和不可访问的数据不属于已完整保存的内容".to_string(),
            "采集期间持续变化的云端资料不提供全空间同一时刻的事务快照".to_string(),
        ],
    };
    write_json_new(
        &root.join("attempts").join(format!("{id}.running.json")),
        &snapshot,
    )?;
    let outcome = capture_inner(
        app,
        client,
        session,
        &store,
        root,
        &mut snapshot,
        force_full,
    )
    .await;
    if let Err(error) = outcome {
        issue(&mut snapshot, "space", "capture", error);
    }
    snapshot.finished_at = Some(now_timestamp());
    let verification = verify_objects(&store, &snapshot);
    snapshot.issues.extend(verification.issues);
    snapshot.status = if snapshot.issues.is_empty() {
        "complete"
    } else {
        "partial"
    }
    .to_string();
    // Persist partial attempts separately; they never become a recovery point.
    let directory = if snapshot.status == "complete" {
        "snapshots"
    } else {
        "attempts"
    };
    write_report(root, &snapshot)?;
    write_json_new(&root.join(directory).join(format!("{id}.json")), &snapshot)?;
    fs::remove_file(root.join("attempts").join(format!("{id}.running.json")))
        .map_err(|e| e.to_string())?;
    Ok(snapshot)
}

async fn capture_inner(
    app: Option<&AppHandle>,
    client: &Client,
    session: &McpSession,
    store: &BlobStore,
    root: &Path,
    snapshot: &mut Snapshot,
    force_full: bool,
) -> Result<(), String> {
    let previous_assets = if force_full {
        Vec::new()
    } else {
        cache::previous_assets(root, store, &snapshot.library_id)?
    };
    let indexed = if let Some(app) = app {
        let database = crate::database_path(app)?;
        let indexed_store =
            BlobStore::open(&crate::blob_store_path(app)?)?.with_backup_index(database.clone());
        Some((database, indexed_store))
    } else {
        None
    };
    let connection = call_craft_read_raw(client, session, "connection info", 20_100_000).await?;
    snapshot.connection_hash = Some(put_json(store, &connection)?);
    let folders = read_craft_block_pages(client, session, "folders list", 20_101_000).await?;
    snapshot.folders_hash = Some(put_json(store, &folders)?);
    let mut folder_paths = BTreeMap::new();
    for page in &folders {
        let text = tool_result_text(page);
        let listed = folder_listing(&text);
        if listed.is_empty() && !text.contains("No folders") && !text.contains("0 folders") {
            return Err("无法解析文件夹清单，未确认空间备份完整".into());
        }
        for (id, name) in listed {
            let entries = read_craft_block_pages(
                client,
                session,
                &format!(
                    "documents list --folder {} --metadata",
                    craft_cli_quote(&id)
                ),
                20_102_000,
            )
            .await?;
            for page in entries {
                for doc in parse_document_listing(&tool_result_text(&page)) {
                    folder_paths.insert(doc.id, name.clone());
                }
            }
        }
    }
    let (documents, locations, raw_inventory) = inventory(client, session).await?;
    snapshot.inventory_hash = Some(put_json(store, &raw_inventory)?);
    let initial_identity = inventory_identity(&documents, &locations);
    let asset_client = backup_client()?;
    for (position, document) in documents.values().enumerate() {
        progress(
            app,
            snapshot,
            "capture",
            position,
            documents.len(),
            &document.title,
        );
        // Refresh structure and supplemental metadata, then reuse only
        // originals whose own revision or remote validator still agrees.
        let document_result = capture_document_cached(
            client,
            &asset_client,
            session,
            store,
            snapshot,
            document,
            folder_paths.get(&document.id).cloned().unwrap_or_default(),
            locations
                .get(&document.id)
                .cloned()
                .unwrap_or_else(|| "documents".to_string()),
            &previous_assets,
            indexed.as_ref().map(|(database, store)| (database, store)),
            force_full,
        )
        .await;
        if let Err(error) = document_result {
            issue(snapshot, &document.id, "document", error);
        }
    }
    let (after, after_locations, _) = inventory(client, session).await?;
    if initial_identity != inventory_identity(&after, &after_locations) {
        issue(
            snapshot,
            "space",
            "changed_during_capture",
            "采集期间文档清单或修改时间发生变化，请重新备份；上一恢复点保持可用",
        );
    }
    if snapshot.documents.len() != documents.len() {
        issue(
            snapshot,
            "space",
            "inventory",
            "保存的页面数与完整文档清单不一致",
        );
    }
    let folders_after = read_craft_block_pages(client, session, "folders list", 20_109_000).await?;
    if folders.iter().map(tool_result_text).collect::<Vec<_>>()
        != folders_after
            .iter()
            .map(tool_result_text)
            .collect::<Vec<_>>()
    {
        issue(
            snapshot,
            "space",
            "changed_folders",
            "采集期间文件夹结构发生变化，请重新备份",
        );
    }
    Ok(())
}

async fn capture_document(
    client: &Client,
    asset_client: &Client,
    session: &McpSession,
    store: &BlobStore,
    snapshot: &mut Snapshot,
    document: &crate::RemoteDocument,
    folder_path: String,
    location: String,
) -> Result<(), String> {
    capture_document_cached(
        client,
        asset_client,
        session,
        store,
        snapshot,
        document,
        folder_path,
        location,
        &[],
        None,
        false,
    )
    .await
}

async fn capture_document_cached(
    client: &Client,
    asset_client: &Client,
    session: &McpSession,
    store: &BlobStore,
    snapshot: &mut Snapshot,
    document: &crate::RemoteDocument,
    folder_path: String,
    location: String,
    previous_assets: &[SnapshotAttachment],
    database: Option<(&PathBuf, &BlobStore)>,
    force_full: bool,
) -> Result<(), String> {
    let structure = parsed_pages(
        read_craft_block_pages(
            client,
            session,
            &format!(
                "blocks get {} --depth -1 --format json --fetchMetadata",
                craft_cli_quote(&document.id)
            ),
            21_000_000,
        )
        .await?,
    )?;
    let mut ids = BTreeSet::new();
    let mut resources = BTreeMap::new();
    let mut specials = BTreeSet::new();
    let mut unknown = BTreeSet::new();
    for tree in &structure {
        block_ids(tree, &mut ids);
        collect_resources(
            tree,
            &document.id,
            &mut resources,
            &mut specials,
            &mut unknown,
        );
    }
    if !ids.contains(&document.id) {
        return Err("结构化内容没有被请求的根块，不能确认页面完整".to_string());
    }
    let markdown_pages = read_craft_block_pages(
        client,
        session,
        &format!(
            "blocks get {} --depth -1 --format markdown --fetchMetadata",
            craft_cli_quote(&document.id)
        ),
        22_000_000,
    )
    .await?;
    let markdown = markdown_pages
        .iter()
        .map(tool_result_text)
        .map(|text| without_next_page_instruction(&text))
        .collect::<Vec<_>>()
        .join("\n\n");
    for resource in crate::attachments::discover_attachments(&markdown) {
        if resources
            .values()
            .any(|asset| asset.remote_url == resource.url)
        {
            continue;
        }
        let id = format!(
            "{}:markdown:{}",
            document.id,
            &hash_bytes(resource.url.as_bytes())[..16]
        );
        resources.insert(
            id.clone(),
            SnapshotAttachment {
                id,
                document_id: document.id.clone(),
                title: resource.title,
                mime_type: resource.mime_hint.unwrap_or_default(),
                remote_url: resource.url,
                link_kind: resource.link_kind,
                expected_bytes: resource.size,
                resource_revision: resource.resource_revision,
                remote_etag: None,
                object_hash: None,
                bytes: None,
            },
        );
    }
    let mut processed = BTreeSet::new();
    while let Some((kind, id)) = specials.iter().next().cloned() {
        specials.remove(&(kind.clone(), id.clone()));
        if !processed.insert((kind.clone(), id.clone())) {
            continue;
        }
        let commands = if kind == "whiteboard" {
            vec![(
                "whiteboard",
                format!(
                    "whiteboards elements get --whiteboard {}",
                    craft_cli_quote(&id)
                ),
            )]
        } else {
            vec![
                (
                    "schema",
                    format!("collections schema --collection {}", craft_cli_quote(&id)),
                ),
                (
                    "items",
                    format!(
                        "collections items-get --collection {} --depth -1 --page-size 200",
                        craft_cli_quote(&id)
                    ),
                ),
                (
                    "views",
                    format!(
                        "collections views-list --collection {} --format json",
                        craft_cli_quote(&id)
                    ),
                ),
            ]
        };
        for (part, command) in commands {
            match read_craft_block_pages(client, session, &command, 23_000_000).await {
                Ok(pages) => {
                    let key = format!("{}:{kind}:{id}:{part}", document.id);
                    snapshot
                        .supplemental_objects
                        .insert(key, put_json(store, &pages)?);
                    for page in pages {
                        if let Some(parsed) = parse_tool_json(&page) {
                            collect_resources(
                                &parsed,
                                &document.id,
                                &mut resources,
                                &mut specials,
                                &mut unknown,
                            );
                            // Excalidraw assets may use URLs or embedded data URLs.
                            if kind == "whiteboard" {
                                collect_whiteboard_assets(
                                    &parsed,
                                    &document.id,
                                    &id,
                                    &mut resources,
                                );
                            }
                        }
                        for asset in
                            crate::attachments::discover_attachments(&tool_result_text(&page))
                        {
                            if resources.values().any(|old| old.remote_url == asset.url) {
                                continue;
                            }
                            let key = format!(
                                "{}:{id}:{}",
                                document.id,
                                &hash_bytes(asset.url.as_bytes())[..16]
                            );
                            resources.insert(
                                key.clone(),
                                SnapshotAttachment {
                                    id: key,
                                    document_id: document.id.clone(),
                                    title: asset.title,
                                    mime_type: asset.mime_hint.unwrap_or_default(),
                                    remote_url: asset.url,
                                    link_kind: asset.link_kind,
                                    expected_bytes: asset.size,
                                    resource_revision: asset.resource_revision,
                                    remote_etag: None,
                                    object_hash: None,
                                    bytes: None,
                                },
                            );
                        }
                    }
                }
                Err(_) => issue(
                    snapshot,
                    &id,
                    part,
                    format!("无法完整读取 {kind} 的 {part} 数据"),
                ),
            }
        }
    }
    for kind in unknown {
        issue(
            snapshot,
            &document.id,
            "unsupported_block",
            format!("原始内容已保存，但块类型 {kind} 的关联资源尚不能确认完整"),
        );
    }
    snapshot.documents.push(SnapshotDocument {
        id: document.id.clone(),
        raw_document_id: document.raw_document_id.clone(),
        title: document.title.clone(),
        folder_path,
        location,
        modified_at: document.modified_at,
        markdown_hash: store.put(markdown.as_bytes())?.hash,
        structure_hash: put_json(store, &structure)?,
        block_ids: ids.into_iter().collect(),
    });
    for mut asset in resources.into_values() {
        if external_service_reference(&asset.remote_url) {
            snapshot.external_references.push(asset);
            continue;
        }
        let cached = match cache::reuse_current(store, &asset, &snapshot.attachments) {
            Some(current) => Some(current),
            None => {
                cache::reuse(
                    asset_client,
                    store,
                    &asset,
                    previous_assets.iter(),
                    if force_full { None } else { database },
                    &snapshot.library_id,
                )
                .await?
            }
        };
        let mut result = match cached {
            Some(value) => Ok(value),
            None => download_asset_with_receipt(asset_client, store, &asset).await,
        };
        for _ in 0..2 {
            if result.is_ok() {
                break;
            }
            let transient = result.as_ref().err().is_some_and(|message| {
                message.contains("请求失败")
                    || message.contains("下载中断")
                    || message.contains("HTTP 5")
                    || message.contains("HTTP 429")
            });
            if !transient {
                break;
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
            result = download_asset_with_receipt(asset_client, store, &asset).await;
        }
        match result {
            Ok((hash, bytes, etag)) => {
                asset.object_hash = Some(hash);
                asset.bytes = Some(bytes);
                asset.remote_etag = etag;
            }
            Err(error) => issue(snapshot, &asset.id, "attachment", error),
        }
        snapshot.attachments.push(asset);
    }
    Ok(())
}

fn collect_whiteboard_assets(
    value: &Value,
    document_id: &str,
    whiteboard_id: &str,
    resources: &mut BTreeMap<String, SnapshotAttachment>,
) {
    for key in ["assets", "files"] {
        if let Some(assets) = value.get(key).and_then(Value::as_object) {
            for (asset_id, asset) in assets {
                let url = asset
                    .get("url")
                    .or_else(|| asset.get("dataURL"))
                    .and_then(Value::as_str);
                if let Some(url) = url {
                    let id = format!("{document_id}:{whiteboard_id}:{asset_id}");
                    resources.entry(id.clone()).or_insert(SnapshotAttachment {
                        id,
                        document_id: document_id.to_string(),
                        title: format!("whiteboard-{asset_id}"),
                        mime_type: asset
                            .get("mimeType")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        remote_url: url.to_string(),
                        link_kind: "image".to_string(),
                        expected_bytes: None,
                        resource_revision: None,
                        remote_etag: None,
                        object_hash: None,
                        bytes: None,
                    });
                }
            }
        }
    }
}

fn allowed_asset_url(value: &str) -> bool {
    Url::parse(value).ok().is_some_and(|url| {
        url.scheme() == "https"
            && url.username().is_empty()
            && url.password().is_none()
            && url.host_str().is_some_and(|host| {
                host == "craft.do" || host.ends_with(".craft.do") || host == "images.unsplash.com"
            })
    })
}

fn external_service_reference(value: &str) -> bool {
    !allowed_asset_url(value)
        && Url::parse(value)
            .ok()
            .is_some_and(|url| url.scheme() == "https" && url.host_str().is_some())
}

fn requires_nonempty_original(asset: &SnapshotAttachment) -> bool {
    let extension = Path::new(&asset.title)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(asset.link_kind.as_str(), "image" | "video" | "audio")
        || asset.mime_type.starts_with("image/")
        || asset.mime_type.starts_with("video/")
        || asset.mime_type.starts_with("audio/")
        || matches!(
            extension.as_str(),
            "doc"
                | "docx"
                | "xls"
                | "xlsx"
                | "ppt"
                | "pptx"
                | "pdf"
                | "zip"
                | "png"
                | "jpg"
                | "jpeg"
                | "mp4"
                | "mov"
        )
}

fn validate_original(path: &Path, asset: &SnapshotAttachment) -> Result<(), String> {
    validate_original_content(path, requires_nonempty_original(asset))
}

pub(crate) fn validate_original_content(
    path: &Path,
    requires_nonempty: bool,
) -> Result<(), String> {
    let mut file = fs::File::open(path).map_err(|_| "无法读取附件原件".to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() == 0 && requires_nonempty {
        return Err("附件原件为 0 字节，内容未成功保存，不能作为完整备份".into());
    }
    let mut head = [0; 256];
    let count = file.read(&mut head).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&head[..count])
        .trim_start()
        .to_ascii_lowercase();
    if requires_nonempty && (text.starts_with("<!doctype html") || text.starts_with("<html")) {
        return Err("附件下载返回网页，未获得附件原件".into());
    }
    if head[..count].starts_with(b"\xff\xd8\xff") {
        validate_jpeg(&mut file)?;
    }
    Ok(())
}

fn validate_jpeg(file: &mut fs::File) -> Result<(), String> {
    let invalid = || "JPEG 原件结构损坏或不完整，不能作为完整备份".to_string();
    file.seek(SeekFrom::Start(2)).map_err(|_| invalid())?;
    let mut frame = false;
    let mut scan = false;
    for _ in 0..1024 {
        let mut marker = [0; 2];
        file.read_exact(&mut marker).map_err(|_| invalid())?;
        if marker[0] != 255 {
            return Err(invalid());
        }
        while marker[1] == 255 {
            file.read_exact(&mut marker[1..]).map_err(|_| invalid())?;
        }
        let code = marker[1];
        if code == 0xd9 || code == 0 {
            return Err(invalid());
        }
        if matches!(code, 0x01 | 0xd0..=0xd8) {
            continue;
        }
        let mut length = [0; 2];
        file.read_exact(&mut length).map_err(|_| invalid())?;
        let length = u16::from_be_bytes(length);
        if length < 2 {
            return Err(invalid());
        }
        frame |= matches!(code, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf);
        file.seek(SeekFrom::Current(i64::from(length - 2)))
            .map_err(|_| invalid())?;
        if code == 0xda {
            scan = true;
            break;
        }
    }
    if !frame || !scan {
        return Err(invalid());
    }
    let size = file.metadata().map_err(|_| invalid())?.len();
    let tail_len = size.min(65536);
    file.seek(SeekFrom::End(-(tail_len as i64)))
        .map_err(|_| invalid())?;
    let mut tail = Vec::with_capacity(tail_len as usize);
    file.read_to_end(&mut tail).map_err(|_| invalid())?;
    if !tail.windows(2).any(|pair| pair == b"\xff\xd9") {
        return Err(invalid());
    }
    Ok(())
}

async fn download_asset(
    client: &Client,
    store: &BlobStore,
    asset: &SnapshotAttachment,
) -> Result<(String, u64), String> {
    download_asset_with_receipt(client, store, asset)
        .await
        .map(|(hash, size, _)| (hash, size))
}

async fn download_asset_with_receipt(
    client: &Client,
    store: &BlobStore,
    asset: &SnapshotAttachment,
) -> Result<(String, u64, Option<String>), String> {
    if asset.remote_url.starts_with("data:") {
        use base64::Engine;
        let (header, data) = asset
            .remote_url
            .split_once(',')
            .ok_or_else(|| "白板内嵌素材地址无效".to_string())?;
        if !header.ends_with(";base64") || data.len() as u64 > MAX_ASSET_BYTES {
            return Err("白板素材格式或大小不受支持".to_string());
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|_| "白板素材解码失败".to_string())?;
        if bytes.is_empty() && requires_nonempty_original(asset) {
            return Err("附件原件为空，不能作为已完成备份".into());
        }
        let blob = store.put(&bytes)?;
        validate_original(&store.path_for(&blob.hash)?, asset)?;
        return Ok((blob.hash, blob.size, None));
    }
    if !allowed_asset_url(&asset.remote_url) {
        return Err("关联资源不在 Craft HTTPS 域名内，未作为已完整备份的附件保存".to_string());
    }
    let staged = store.staging_path()?;
    let result = async {
        let response = client
            .get(&asset.remote_url)
            .send()
            .await
            .map_err(|_| "附件请求失败".to_string())?;
        if !response.status().is_success() {
            return Err(format!(
                "附件下载返回 HTTP {}；下次备份会重新读取资源地址",
                response.status()
            ));
        }
        let etag = cache::strong_etag(response.headers());
        if response
            .content_length()
            .is_some_and(|size| size > MAX_ASSET_BYTES)
        {
            return Err("附件超过 4 GB 单文件上限".to_string());
        }
        let mut file = tokio::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&staged)
            .await
            .map_err(|_| "无法创建附件暂存文件".to_string())?;
        let mut stream = response.bytes_stream();
        let mut bytes = 0_u64;
        let mut digest = Sha256::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| "附件下载中断".to_string())?;
            bytes = bytes.saturating_add(chunk.len() as u64);
            if bytes > MAX_ASSET_BYTES {
                return Err("附件超过 4 GB 单文件上限".to_string());
            }
            digest.update(&chunk);
            file.write_all(&chunk)
                .await
                .map_err(|_| "附件写入失败".to_string())?;
        }
        if asset
            .expected_bytes
            .is_some_and(|expected| expected != bytes)
        {
            return Err("附件字节数与 Craft 元数据不一致".to_string());
        }
        file.sync_all()
            .await
            .map_err(|_| "附件落盘失败".to_string())?;
        drop(file);
        validate_original(&staged, asset)?;
        let hash = format!("{:x}", digest.finalize());
        let blob = store.commit_staged(&staged, &hash, bytes)?;
        if hash_file(&store.path_for(&hash)?)? != hash {
            return Err("附件落盘校验失败".to_string());
        }
        Ok((blob.hash, blob.size, etag))
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&staged).await;
    }
    result
}

pub fn backup_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(900))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 8 {
                attempt.error("重定向过多")
            } else if allowed_asset_url(attempt.url().as_str()) {
                attempt.follow()
            } else {
                attempt.error("附件重定向超出允许范围")
            }
        }))
        .build()
        .map_err(|error| error.to_string())
}

fn progress(
    app: Option<&AppHandle>,
    snapshot: &Snapshot,
    phase: &str,
    completed: usize,
    total: usize,
    current: &str,
) {
    if let Some(app) = app {
        let _ = app.emit(
            "craft-vault-export-progress",
            CraftVaultExportProgress {
                library_id: snapshot.library_id.clone(),
                phase: phase.to_string(),
                completed,
                total,
                current: current.to_string(),
            },
        );
    }
}

pub fn verify_objects(store: &BlobStore, snapshot: &Snapshot) -> Verification {
    let mut issues = Vec::new();
    let mut hashes = BTreeSet::new();
    for hash in [
        &snapshot.inventory_hash,
        &snapshot.folders_hash,
        &snapshot.connection_hash,
    ] {
        if let Some(hash) = hash {
            hashes.insert(hash.clone());
        } else {
            issues.push(BackupIssue {
                object_id: "space".to_string(),
                category: "missing_inventory".to_string(),
                message: "缺少空间、文件夹或完整文档清单".to_string(),
            });
        }
    }
    for document in &snapshot.documents {
        hashes.insert(document.markdown_hash.clone());
        hashes.insert(document.structure_hash.clone());
        let structure = store
            .path_for(&document.structure_hash)
            .and_then(|path| fs::read(path).map_err(|e| e.to_string()))
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).map_err(|e| e.to_string()));
        let mut complete = false;
        if let Ok(structure) = structure {
            let mut required = BTreeMap::new();
            let mut ids = BTreeSet::new();
            let mut special = BTreeSet::new();
            let mut unknown = BTreeSet::new();
            block_ids(&structure, &mut ids);
            collect_resources(
                &structure,
                &document.id,
                &mut required,
                &mut special,
                &mut unknown,
            );
            complete = ids.contains(&document.id)
                && unknown.is_empty()
                && required.values().all(|asset| {
                    if external_service_reference(&asset.remote_url) {
                        return snapshot.external_references.iter().any(|saved| {
                            saved.document_id == document.id && saved.remote_url == asset.remote_url
                        });
                    }
                    snapshot.attachments.iter().any(|saved| {
                        saved.document_id == document.id
                            && saved.remote_url == asset.remote_url
                            && saved.object_hash.is_some()
                    })
                });
            for (kind, id) in special {
                let parts: &[&str] = if kind == "whiteboard" {
                    &["whiteboard"]
                } else {
                    &["schema", "items", "views"]
                };
                complete &= parts.iter().all(|part| {
                    snapshot
                        .supplemental_objects
                        .contains_key(&format!("{}:{kind}:{id}:{part}", document.id))
                });
            }
        }
        if !complete {
            issues.push(BackupIssue {
                object_id: document.id.clone(),
                category: "resource_inventory".into(),
                message: "页面原始结构、关联附件或集合/白板清单不完整".into(),
            });
        }
    }
    if let Some(hash) = &snapshot.inventory_hash {
        let expected = store
            .path_for(hash)
            .and_then(|p| fs::read(p).map_err(|e| e.to_string()))
            .and_then(|bytes| {
                serde_json::from_slice::<Vec<Value>>(&bytes).map_err(|e| e.to_string())
            })
            .map(|pages| {
                pages
                    .iter()
                    .flat_map(|page| parse_document_listing(&tool_result_text(&page["response"])))
                    .map(|doc| doc.id)
                    .collect::<BTreeSet<_>>()
            });
        let actual = snapshot
            .documents
            .iter()
            .map(|doc| doc.id.clone())
            .collect::<BTreeSet<_>>();
        if expected.as_ref().is_err()
            || expected.is_ok_and(|ids| ids != actual)
            || actual.len() != snapshot.documents.len()
        {
            issues.push(BackupIssue {
                object_id: "space".into(),
                category: "inventory".into(),
                message: "恢复点页面清单与原始空间清单不一致".into(),
            });
        }
    }
    for asset in &snapshot.attachments {
        if let Some(hash) = &asset.object_hash {
            hashes.insert(hash.clone());
            if let Err(message) = store
                .path_for(hash)
                .and_then(|path| validate_original(&path, asset))
            {
                issues.push(BackupIssue {
                    object_id: asset.id.clone(),
                    category: "attachment_content".into(),
                    message,
                });
            }
        } else {
            issues.push(BackupIssue {
                object_id: asset.id.clone(),
                category: "missing_attachment".to_string(),
                message: "附件原件尚未保存".to_string(),
            });
        }
    }
    hashes.extend(snapshot.supplemental_objects.values().cloned());
    for hash in &hashes {
        let valid = store
            .path_for(hash)
            .and_then(|path| {
                reject_links(&path)?;
                hash_file(&path)
            })
            .is_ok_and(|actual| actual == *hash);
        if !valid {
            issues.push(BackupIssue {
                object_id: hash.clone(),
                category: "integrity".to_string(),
                message: "备份对象缺失或校验值不一致".to_string(),
            });
        }
    }
    Verification {
        snapshot_id: snapshot.id.clone(),
        valid: issues.is_empty(),
        checked_objects: hashes.len(),
        issues,
    }
}

pub fn load_snapshot(root: &Path, id: &str, library_id: &str) -> Result<Snapshot, String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("恢复点身份无效".to_string());
    }
    reject_links(root)?;
    let path = root.join("snapshots").join(format!("{id}.json"));
    reject_links(&path)?;
    let snapshot: Snapshot =
        serde_json::from_slice(&fs::read(&path).map_err(|_| "找不到恢复点".to_string())?)
            .map_err(|_| "恢复点清单损坏".to_string())?;
    if snapshot.id != id
        || snapshot.version != VERSION
        || snapshot.library_id != library_id
        || snapshot.status != "complete"
    {
        return Err("该恢复点版本、资料库或完整性状态无效".to_string());
    }
    if snapshot
        .attachments
        .iter()
        .any(|asset| asset.bytes == Some(0) && requires_nonempty_original(asset))
    {
        return Err("恢复点包含 0 字节附件原件，不能作为完整备份恢复".into());
    }
    Ok(snapshot)
}

pub fn history(root: &Path, library_id: &str) -> Result<Vec<Snapshot>, String> {
    reject_links(root)?;
    if !root.join("snapshots").exists() {
        return Ok(Vec::new());
    }
    let mut snapshots = Vec::new();
    for entry in fs::read_dir(root.join("snapshots")).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let id = path
            .file_stem()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "恢复点文件名无效".to_string())?;
        if let Ok(snapshot) = load_snapshot(root, id, library_id) {
            snapshots.push(snapshot);
        }
    }
    snapshots.sort_by(|left, right| {
        right
            .started_at
            .cmp(&left.started_at)
            .then_with(|| right.id.cmp(&left.id))
    });
    Ok(snapshots)
}

pub fn history_issues(root: &Path, library_id: &str) -> Vec<String> {
    let Ok(entries) = fs::read_dir(root.join("snapshots")) else {
        return Vec::new();
    };
    entries
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            if path.extension().and_then(|v| v.to_str()) != Some("json") {
                return None;
            }
            let id = path.file_stem()?.to_str()?;
            load_snapshot(root, id, library_id)
                .err()
                .map(|error| format!("恢复点 {id} 已排除：{error}；其它恢复点仍可核验恢复"))
        })
        .collect()
}

fn reference_blocks(value: &Value, blocks: &mut Vec<(String, String)>) {
    match value {
        Value::Object(map) => {
            if let (Some(id), Some(text)) = (
                map.get("id").and_then(Value::as_str),
                map.get("markdown").and_then(Value::as_str),
            ) {
                if map.contains_key("type") {
                    blocks.push((id.to_string(), text.to_string()));
                }
            }
            for value in map.values() {
                reference_blocks(value, blocks);
            }
        }
        Value::Array(values) => {
            for value in values {
                reference_blocks(value, blocks);
            }
        }
        _ => {}
    }
}

pub fn snapshot_source(
    root: &Path,
    snapshot: &Snapshot,
) -> Result<(BlobStore, Vec<ExportDocument>, Vec<ExportAttachment>), String> {
    let store = BlobStore::open(&root.join("objects"))?;
    let verified = verify_objects(&store, snapshot);
    if !verified.valid {
        return Err("备份校验失败，已停止恢复；请查看核验报告".to_string());
    }
    saved_source(store, snapshot)
}

fn saved_source(
    store: BlobStore,
    snapshot: &Snapshot,
) -> Result<(BlobStore, Vec<ExportDocument>, Vec<ExportAttachment>), String> {
    let documents = snapshot
        .documents
        .iter()
        .map(|doc| {
            let markdown = fs::read_to_string(store.path_for(&doc.markdown_hash)?)
                .map_err(|error| error.to_string())?;
            let folder_path = match doc.location.as_str() {
                "trash" => format!("回收站/{}", doc.folder_path),
                "templates" => format!("模板/{}", doc.folder_path),
                _ => doc.folder_path.clone(),
            };
            Ok(ExportDocument {
                id: doc.id.clone(),
                title: doc.title.clone(),
                folder_path,
                markdown,
                modified_at: doc.modified_at,
                content_hash: doc.markdown_hash.clone(),
                raw_document_id: doc.raw_document_id.clone(),
                block_markdown: {
                    let tree: Value = serde_json::from_slice(
                        &fs::read(store.path_for(&doc.structure_hash)?)
                            .map_err(|e| e.to_string())?,
                    )
                    .map_err(|e| e.to_string())?;
                    let mut blocks = Vec::new();
                    reference_blocks(&tree, &mut blocks);
                    blocks.retain(|(id, _)| id != &doc.id);
                    blocks
                },
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let attachments = snapshot
        .attachments
        .iter()
        .map(|asset| ExportAttachment {
            id: asset.id.clone(),
            document_id: asset.document_id.clone(),
            title: asset.title.clone(),
            mime_type: asset.mime_type.clone(),
            blob_hash: asset.object_hash.clone(),
            remote_url: Some(asset.remote_url.clone()),
            link_kind: asset.link_kind.clone(),
        })
        .collect();
    Ok((store, documents, attachments))
}

/// Include the original structure, metadata and supplemental data in the
/// readable vault too. These files are derived from the verified archive only.
pub fn export_supplements(
    vault: &Path,
    store: &BlobStore,
    snapshot: &Snapshot,
) -> Result<(), String> {
    let directory = vault.join("Craft 原始资料").join(&snapshot.id);
    reject_links(&directory)?;
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let write = |name: &str, bytes: &[u8]| -> Result<(), String> {
        let path = directory.join(name);
        reject_links(&path)?;
        if path.exists() {
            if hash_file(&path)? != hash_bytes(bytes) {
                return Err("Vault 中的原始资料已有本地修改，未覆盖；可恢复到新目录".into());
            }
            return Ok(());
        }
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .map_err(|e| e.to_string())?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())
    };
    write(
        "snapshot.json",
        &serde_json::to_vec_pretty(snapshot).map_err(|e| e.to_string())?,
    )?;
    let mut index = format!("# Craft 原始资料\n\n恢复点：{}\n\n页面正文与附件位于 Vault 中；这里保留页面结构、评论等返回的元数据，以及集合和白板原始信息。历史版本和权限未包含。\n\n", snapshot.id);
    for doc in &snapshot.documents {
        let name = format!("{}.json", hash_bytes(doc.id.as_bytes()));
        write(
            &name,
            &fs::read(store.path_for(&doc.structure_hash)?).map_err(|e| e.to_string())?,
        )?;
        index.push_str(&format!(
            "- {}： [页面原始结构]({name})\n",
            doc.title.replace(['\n', '\r'], " ")
        ));
    }
    for (key, hash) in &snapshot.supplemental_objects {
        let stem = hash_bytes(key.as_bytes());
        let bytes = fs::read(store.path_for(hash)?).map_err(|e| e.to_string())?;
        write(&format!("{stem}.json"), &bytes)?;
        index.push_str(&format!("- {key}：[原始数据]({stem}.json)"));
        let pages: Vec<Value> = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        let text = pages
            .iter()
            .map(tool_result_text)
            .map(|s| without_next_page_instruction(&s))
            .collect::<Vec<_>>()
            .join("\n\n");
        write(&format!("{stem}.md"), text.as_bytes())?;
        index.push_str(&format!(" / [阅读]({stem}.md)"));
        if key.contains(":whiteboard:") {
            if let Some(parsed) = pages.first().and_then(parse_tool_json) {
                let mut files = parsed
                    .get("assets")
                    .or_else(|| parsed.get("files"))
                    .cloned()
                    .unwrap_or(json!({}));
                if let Some(assets) = files.as_object_mut() {
                    for (id, value) in assets.iter_mut() {
                        if let Some(asset) = snapshot
                            .attachments
                            .iter()
                            .find(|a| a.id.ends_with(&format!(":{id}")))
                        {
                            let bytes = fs::read(
                                store
                                    .path_for(asset.object_hash.as_ref().ok_or("白板素材缺失")?)?,
                            )
                            .map_err(|e| e.to_string())?;
                            use base64::Engine;
                            *value = json!({"id": id,"mimeType":asset.mime_type,"dataURL":format!("data:{};base64,{}",asset.mime_type,base64::engine::general_purpose::STANDARD.encode(bytes)),"created":snapshot.started_at * 1000});
                        }
                    }
                }
                let drawing = json!({"type":"excalidraw","version":2,"source":"Craft backup","elements":parsed["elements"],"appState":parsed["appState"],"files":files});
                write(
                    &format!("{stem}.excalidraw"),
                    &serde_json::to_vec(&drawing).map_err(|e| e.to_string())?,
                )?;
                index.push_str(&format!(" / [可编辑白板]({stem}.excalidraw)"));
            }
        }
        index.push('\n');
    }
    write("阅读说明.md", index.as_bytes())
}

fn write_report(root: &Path, snapshot: &Snapshot) -> Result<(), String> {
    let mut report = format!(
        "# Craft 备份报告\n\n恢复点：{}\n\n状态：{}\n\n页面：{}；附件：{}\n\n",
        snapshot.id,
        snapshot.status,
        snapshot.documents.len(),
        snapshot.attachments.len()
    );
    for limit in &snapshot.limitations {
        report.push_str(&format!("- {limit}\n"));
    }
    if !snapshot.external_references.is_empty() {
        report.push_str(&format!("\n## 外部服务引用\n\n{} 项 HTTPS 外部引用仅保存原始地址；不是 Craft 托管的附件原件，不包含对应外部网页或服务资料。\n", snapshot.external_references.len()));
        for reference in &snapshot.external_references {
            report.push_str(&format!(
                "- {} / {}：{}\n",
                reference.document_id,
                reference.title,
                Url::parse(&reference.remote_url)
                    .ok()
                    .and_then(|u| u.host_str().map(str::to_string))
                    .unwrap_or_default()
            ));
        }
    }
    if !snapshot.issues.is_empty() {
        report.push_str("\n## 未完成项目\n\n");
        for issue in &snapshot.issues {
            report.push_str(&format!(
                "- {} / {}：{}\n",
                issue.category, issue.object_id, issue.message
            ));
        }
    }
    let path = root
        .join("attempts")
        .join(format!("{}.report.md", snapshot.id));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    file.write_all(report.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|error| error.to_string())
}

pub fn save_config(database: &Path, config: &BackupConfig) -> Result<(), String> {
    if !matches!(config.interval_minutes, 0 | 60 | 360 | 1440) {
        return Err("自动备份间隔不受支持".to_string());
    }
    let (connection, _writer) = crate::open_write_database(&database.to_path_buf())?;
    connection.execute("INSERT INTO metadata(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![format!("{CONFIG_PREFIX}{}", config.library_id), serde_json::to_string(config).map_err(|error| error.to_string())?]).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn configs(database: &Path) -> Result<Vec<BackupConfig>, String> {
    let connection = Connection::open(database).map_err(|error| error.to_string())?;
    let mut statement = connection
        .prepare("SELECT value FROM metadata WHERE key LIKE 'craft_backup_config:%'")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    rows.map(|row| {
        serde_json::from_str(&row.map_err(|error| error.to_string())?)
            .map_err(|error| format!("备份设置损坏：{error}"))
    })
    .collect()
}

pub fn config_options(config: &BackupConfig) -> CraftVaultExportOptions {
    CraftVaultExportOptions {
        library_id: config.library_id.clone(),
        destination: config.destination.clone(),
        vault_name: Some(config.vault_name.clone()),
        include_images: true,
        include_videos: true,
        include_other_attachments: true,
        export_daily_notes: true,
        create_obsidian_config: true,
        backup_interval_minutes: config.interval_minutes,
        replica_destination: config.replica_destination.clone(),
    }
}

/// Regular manual backups use the same configuration as the scheduler. Only
/// initial setup may supply a new location, name, interval or replica location.
pub fn saved_backup_options(
    database: &Path,
    initial: CraftVaultExportOptions,
) -> Result<CraftVaultExportOptions, String> {
    Ok(
        match configs(database)?
            .into_iter()
            .find(|c| c.library_id == initial.library_id)
        {
            Some(config) => config_options(&config),
            None => initial,
        },
    )
}

/// Primary originals follow the active database. Optional second backups and
/// explicit Obsidian exports remain independent copies.
pub(crate) fn managed_options(
    database: &Path,
    mut options: CraftVaultExportOptions,
) -> Result<CraftVaultExportOptions, String> {
    let parent = crate::data_backup::managed_craft_parent(
        database,
        &options.library_id,
        &options.destination,
    )?;
    options.destination = parent.to_string_lossy().into();
    options.include_images = true;
    options.include_videos = true;
    options.include_other_attachments = true;
    Ok(options)
}

pub fn due(config: &BackupConfig, now: i64) -> bool {
    config.interval_minutes > 0
        && now.saturating_sub(config.last_attempt_at) >= config.interval_minutes as i64 * 60
}

pub fn replicate(root: &Path, destination: &Path, snapshot: &Snapshot) -> Result<String, String> {
    if !history_issues(root, &snapshot.library_id).is_empty() {
        return Err("原始备份存在损坏的历史清单，未确认第二份副本完整".into());
    }
    reject_links(destination)?;
    let parent = destination
        .canonicalize()
        .map_err(|_| "第二份备份目录不存在".to_string())?;
    let source = root.canonicalize().map_err(|error| error.to_string())?;
    let target = parent.join(format!(
        "Craft-{}",
        &hash_bytes(snapshot.library_id.as_bytes())[..16]
    ));
    if parent.starts_with(&source) || source.starts_with(&parent) {
        return Err("第二份备份目录不能与原备份目录重叠".to_string());
    }
    let target_store = open_archive(&target, &snapshot.library_id)?;
    let source_store = BlobStore::open(&root.join("objects"))?;
    let mut points = history(root, &snapshot.library_id)?;
    if !points.iter().any(|point| point.id == snapshot.id) {
        points.push(snapshot.clone());
    }
    for snapshot in &points {
        if !verify_objects(&source_store, snapshot).valid {
            return Err("原备份校验失败，未确认第二份副本完整".into());
        }
        for hash in referenced_hashes(snapshot) {
            let target_path = target_store.path_for(&hash)?;
            if target_path.exists() && hash_file(&target_path)? == hash {
                continue;
            }
            let blob = target_store.put_file(&source_store.path_for(&hash)?, MAX_ASSET_BYTES)?;
            if blob.hash != hash {
                return Err("第二份备份复制校验失败".into());
            }
        }
        if !verify_objects(&target_store, snapshot).valid {
            return Err("第二份备份内容核验失败".into());
        }
        let manifest = target
            .join("snapshots")
            .join(format!("{}.json", snapshot.id));
        if !manifest.exists() {
            write_json_new(&manifest, snapshot)?;
        } else if serde_json::to_value(load_snapshot(&target, &snapshot.id, &snapshot.library_id)?)
            .map_err(|e| e.to_string())?
            != serde_json::to_value(snapshot).map_err(|e| e.to_string())?
        {
            return Err("第二份备份已有同名但不同内容的快照".into());
        }
    }
    Ok(target.to_string_lossy().to_string())
}

fn referenced_hashes(snapshot: &Snapshot) -> BTreeSet<String> {
    let mut hashes = BTreeSet::new();
    hashes.extend(
        [
            &snapshot.inventory_hash,
            &snapshot.folders_hash,
            &snapshot.connection_hash,
        ]
        .into_iter()
        .flatten()
        .cloned(),
    );
    for doc in &snapshot.documents {
        hashes.insert(doc.markdown_hash.clone());
        hashes.insert(doc.structure_hash.clone());
    }
    hashes.extend(
        snapshot
            .attachments
            .iter()
            .filter_map(|asset| asset.object_hash.clone()),
    );
    hashes.extend(snapshot.supplemental_objects.values().cloned());
    hashes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialized_image_backdrops_require_saved_resources_without_false_missing_url() {
        let backdrop = json!({"type":"image","size":"full","image":{"imageUrl":"https://res.craft.do/assets/page-backgrounds/example.png"}});
        let mut resources = BTreeMap::new();
        let mut specials = BTreeSet::new();
        let mut unknown = BTreeSet::new();
        collect_resources(
            &Value::String(backdrop.to_string()),
            "doc",
            &mut resources,
            &mut specials,
            &mut unknown,
        );
        assert!(unknown.is_empty());
        assert_eq!(resources.len(), 1);
        assert_eq!(
            resources.values().next().unwrap().remote_url,
            "https://res.craft.do/assets/page-backgrounds/example.png"
        );
        collect_resources(&Value::String(json!({"type":"image","image":{"imageUrl":"https://images.unsplash.com/photo-example?q=80"}}).to_string()), "doc", &mut resources, &mut specials, &mut unknown);
        assert!(unknown.is_empty());
        assert_eq!(resources.len(), 2);
        collect_resources(
            &json!({"type":"image","id":"broken"}),
            "doc",
            &mut resources,
            &mut specials,
            &mut unknown,
        );
        assert!(unknown.contains("image:missing-url"));
    }

    fn directory() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "hub-backup-test-{:016x}",
            rand::thread_rng().next_u64()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn manual_backup_preserves_persisted_configuration() {
        let dir = directory();
        let database = dir.join("settings.sqlite3");
        let connection = Connection::open(&database).unwrap();
        connection
            .execute(
                "CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
                [],
            )
            .unwrap();
        let config = BackupConfig {
            library_id: "space".into(),
            destination: "D:/existing".into(),
            vault_name: "Custom Vault".into(),
            interval_minutes: 360,
            replica_destination: Some("E:/replica".into()),
            last_attempt_at: 1,
            last_success_at: Some(1),
            last_error: None,
        };
        let value = serde_json::to_string(&config).unwrap();
        connection
            .execute(
                "INSERT INTO metadata VALUES (?1, ?2)",
                params!["craft_backup_config:space", value],
            )
            .unwrap();
        let mut stale_form = config_options(&config);
        stale_form.destination = "D:/wrong".into();
        stale_form.vault_name = Some("Wrong Name".into());
        stale_form.backup_interval_minutes = 1440;
        stale_form.replica_destination = None;
        let resolved = saved_backup_options(&database, stale_form).unwrap();
        assert_eq!(resolved.destination, config.destination);
        assert_eq!(
            resolved.vault_name.as_deref(),
            Some(config.vault_name.as_str())
        );
        assert_eq!(resolved.backup_interval_minutes, config.interval_minutes);
        assert_eq!(resolved.replica_destination, config.replica_destination);
        let after: String = connection
            .query_row(
                "SELECT value FROM metadata WHERE key=?1",
                ["craft_backup_config:space"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(after, value);
        let mut initial = config_options(&config);
        initial.library_id = "new-space".into();
        initial.destination = "F:/initial".into();
        assert_eq!(
            saved_backup_options(&database, initial)
                .unwrap()
                .destination,
            "F:/initial"
        );
        drop(connection);
        fs::remove_file(database).unwrap();
        fs::remove_dir(dir).unwrap();
    }

    fn complete_snapshot(store: &BlobStore) -> Snapshot {
        let data = store.put(b"original").unwrap().hash;
        Snapshot {
            version: VERSION,
            id: "test-001".to_string(),
            library_id: "space".to_string(),
            library_name: "Test".to_string(),
            started_at: 1,
            finished_at: Some(2),
            status: "complete".to_string(),
            inventory_hash: Some(put_json(store, &json!([{"location":"all","response":{"content":[{"type":"text","text":"<doc> Note"}]}}])).unwrap()),
            folders_hash: Some(data.clone()),
            connection_hash: Some(data.clone()),
            documents: vec![SnapshotDocument {
                id: "doc".to_string(),
                raw_document_id: None,
                title: "Note".to_string(),
                folder_path: String::new(),
                location: "documents".to_string(),
                modified_at: Some(1),
                markdown_hash: data.clone(),
                structure_hash: put_json(store, &json!([{"type":"page","id":"doc","markdown":"original"}])).unwrap(),
                block_ids: vec!["doc".to_string()],
            }],
            attachments: vec![SnapshotAttachment {
                id: "asset".to_string(),
                document_id: "doc".to_string(),
                title: "archive.zip".to_string(),
                mime_type: "application/zip".to_string(),
                remote_url: "https://r.craft.do/asset".to_string(),
                link_kind: "file".to_string(),
                expected_bytes: Some(8),
                resource_revision: None,
                remote_etag: None,
                object_hash: Some(data),
                bytes: Some(8),
            }],
            supplemental_objects: BTreeMap::new(),
            external_references: Vec::new(),
            issues: Vec::new(),
            limitations: Vec::new(),
        }
    }

    #[test]
    fn empty_original_and_html_response_cannot_pass_hash_verification() {
        let root = directory();
        let store = open_archive(&root.join("archive"), "space").unwrap();
        let mut snapshot = complete_snapshot(&store);
        snapshot.attachments[0].title = "document.docx".into();
        snapshot.attachments[0].object_hash = Some(store.put(b"").unwrap().hash);
        snapshot.attachments[0].bytes = Some(0);
        assert!(verify_objects(&store, &snapshot)
            .issues
            .iter()
            .any(|i| i.category == "attachment_content"));
        let archive = root.join("archive");
        fs::create_dir_all(archive.join("snapshots")).unwrap();
        write_json_new(&archive.join("snapshots/test-001.json"), &snapshot).unwrap();
        assert!(history(&archive, "space").unwrap().is_empty());
        assert!(history_issues(&archive, "space")[0].contains("0 字节"));
        snapshot.attachments[0].object_hash = Some(
            store
                .put(b"<!doctype html><html>Access denied</html>")
                .unwrap()
                .hash,
        );
        assert!(verify_objects(&store, &snapshot)
            .issues
            .iter()
            .any(|i| i.category == "attachment_content"));
        snapshot.attachments[0].object_hash = Some(
            store
                .put(b"\xff\xd8\xff\xdb\x00\x43truncated")
                .unwrap()
                .hash,
        );
        assert!(verify_objects(&store, &snapshot)
            .issues
            .iter()
            .any(|i| i.message.contains("JPEG")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore]
    fn diagnose_empty_originals_live() {
        let parent = PathBuf::from(std::env::var_os("HUB_MEDIA_ARCHIVES_PARENT").unwrap());
        tauri::async_runtime::block_on(async {
            for name in ["Car", "Main"] {
                let root = parent.join(format!("{name} - Craft - 备份"));
                let sub = if name == "Car" {
                    "snapshots"
                } else {
                    "attempts"
                };
                let path = fs::read_dir(root.join(sub))
                    .unwrap()
                    .filter_map(Result::ok)
                    .map(|e| e.path())
                    .filter(|p| p.extension().is_some_and(|e| e == "json"))
                    .max_by_key(|p| p.metadata().unwrap().modified().unwrap())
                    .unwrap();
                let snapshot: Snapshot = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
                let client = backup_client().unwrap();
                let mut credential = crate::load_credential(&snapshot.library_id).unwrap();
                let token = crate::restore_credential_access_token(
                    &client,
                    &snapshot.library_id,
                    &mut credential,
                )
                .await
                .unwrap();
                crate::save_credential(&snapshot.library_id, &credential).unwrap();
                let connection =
                    crate::initialize_authenticated_connection(&client, &credential.mcp_url, token)
                        .await
                        .unwrap();
                let store = BlobStore::open(&root.join("objects")).unwrap();
                let mut reports = Vec::new();
                for old in snapshot.attachments.iter().filter(|a| {
                    a.object_hash
                        .as_ref()
                        .and_then(|hash| store.path_for(hash).ok())
                        .is_some_and(|path| validate_original(&path, a).is_err())
                }) {
                    let command = format!(
                        "blocks get {} --depth -1 --format json --fetchMetadata",
                        craft_cli_quote(&old.document_id)
                    );
                    let pages =
                        read_craft_block_pages(&client, &connection.session, &command, 31_000_000)
                            .await
                            .unwrap();
                    let mut resources = BTreeMap::new();
                    for page in pages {
                        if let Some(value) = parse_tool_json(&page) {
                            collect_resources(
                                &value,
                                &old.document_id,
                                &mut resources,
                                &mut BTreeSet::new(),
                                &mut BTreeSet::new(),
                            );
                        }
                    }
                    let current = resources.get(&old.id);
                    let result = match current {
                        Some(asset) => download_asset(&client, &store, asset).await,
                        None => Err("当前页面没有提供该附件原件地址".into()),
                    };
                    let report = match result {
                        Ok((hash, bytes)) => {
                            json!({"id":old.id,"title":old.title,"recoveredHash":hash,"bytes":bytes})
                        }
                        Err(message) => {
                            json!({"id":old.id,"title":old.title,"savedBytes":old.bytes,"issue":message})
                        }
                    };
                    println!("{name}: {}", report);
                    reports.push(report);
                }
                fs::write(
                    root.join("附件原件重新核查.json"),
                    serde_json::to_vec_pretty(&reports).unwrap(),
                )
                .unwrap();
            }
        });
    }

    #[test]
    #[ignore]
    fn repair_existing_reading_vault_formats() {
        let parent = PathBuf::from(std::env::var_os("HUB_MEDIA_ARCHIVES_PARENT").unwrap());
        let report_name =
            std::env::var("HUB_REPAIR_REPORT").unwrap_or_else(|_| "附件格式修复报告.json".into());
        let mut reports = Vec::new();
        for name in ["Car", "xv", "Main"] {
            if std::env::var("HUB_MEDIA_SPACE").is_ok_and(|selected| selected != name) {
                continue;
            }
            let root = parent.join(format!("{name} - Craft - 备份"));
            let sub = if name == "Main" {
                "attempts"
            } else {
                "snapshots"
            };
            let path = fs::read_dir(root.join(sub))
                .unwrap()
                .filter_map(Result::ok)
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|e| e == "json"))
                .max_by_key(|p| p.metadata().unwrap().modified().unwrap())
                .unwrap();
            let snapshot: Snapshot = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
            let store = BlobStore::open(&root.join("objects")).unwrap();
            for hash in referenced_hashes(&snapshot) {
                assert_eq!(hash_file(&store.path_for(&hash).unwrap()).unwrap(), hash);
            }
            let (store, documents, attachments) = saved_source(store, &snapshot).unwrap();
            let mut vaults = if name == "Main" {
                vec![parent
                    .join("未完成阅读副本")
                    .join(format!("Main - 未完成阅读副本 - {}", snapshot.id))]
            } else {
                vec![
                    parent.join(format!("{name} - Craft")),
                    parent
                        .join("离线恢复验收")
                        .join(format!("{name} - 离线恢复验收")),
                ]
            };
            for vault in vaults.drain(..) {
                assert!(vault.join(".hub-export/manifest.json").is_file());
                let options = CraftVaultExportOptions {
                    library_id: snapshot.library_id.clone(),
                    destination: vault.to_string_lossy().into(),
                    vault_name: None,
                    include_images: true,
                    include_videos: true,
                    include_other_attachments: true,
                    export_daily_notes: true,
                    create_obsidian_config: true,
                    backup_interval_minutes: 0,
                    replica_destination: None,
                };
                let mut summary =
                    tauri::async_runtime::block_on(crate::craft_export::export_craft_vault(
                        None,
                        snapshot.library_name.clone(),
                        documents.clone(),
                        attachments.clone(),
                        &store,
                        options,
                    ))
                    .unwrap();
                summary.backup_complete =
                    snapshot.status == "complete" && verify_objects(&store, &snapshot).valid;
                summary.backup_root = root.to_string_lossy().into();
                summary.snapshot_id = snapshot.id.clone();
                fs::write(
                    vault.join(&report_name),
                    serde_json::to_vec_pretty(&summary).unwrap(),
                )
                .unwrap();
                if !summary.backup_complete {
                    fs::write(vault.join("请先阅读 - 完整性待补齐.md"), "# 完整性待补齐\n\n本库可阅读已保存内容，但不能视为完整备份。附件内容复核发现原件缺失或空文件。请查看附件格式修复报告.json和原始备份目录中的附件原件重新核查.json。\n").unwrap();
                }
                println!(
                    "{}: {} updated documents, {} updated attachments, {} unavailable, {} conflicts, complete {}",
                    vault.display(),
                    summary.exported_documents,
                    summary.exported_attachments,
                    summary.failed_attachments,
                    summary.conflicts,
                    summary.backup_complete
                );
                reports.push(summary);
            }
        }
        fs::write(
            parent.join(if report_name == "附件格式修复报告.json" {
                "附件格式与内容复核.json"
            } else {
                &report_name
            }),
            serde_json::to_vec_pretty(&reports).unwrap(),
        )
        .unwrap();
    }

    #[test]
    #[ignore]
    fn invalidate_failed_media_backup_status() {
        let database = PathBuf::from(std::env::var_os("HUB_MEDIA_DATABASE").unwrap());
        for mut config in configs(&database).unwrap() {
            let root = backup_root(&config_options(&config)).unwrap();
            if config.last_success_at.is_some()
                && history(&root, &config.library_id).unwrap().is_empty()
            {
                config.last_success_at = None;
                config.last_error = Some("附件内容复核发现空原件，原恢复点已排除；阅读副本可用，但备份未完整。请查看附件格式修复报告。".into());
                save_config(&database, &config).unwrap();
                println!("Invalid complete status corrected: {}", config.vault_name);
            }
        }
    }

    #[test]
    fn corrupted_and_missing_attachments_block_offline_restore() {
        let root = directory();
        let store = open_archive(&root.join("archive"), "space").unwrap();
        let snapshot = complete_snapshot(&store);
        assert!(verify_objects(&store, &snapshot).valid);
        fs::write(
            store
                .path_for(snapshot.attachments[0].object_hash.as_ref().unwrap())
                .unwrap(),
            b"damaged",
        )
        .unwrap();
        assert!(!verify_objects(&store, &snapshot).valid);
        assert!(snapshot_source(&root.join("archive"), &snapshot).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn damaged_manifest_does_not_hide_other_valid_recovery_points() {
        let root = directory();
        let archive = root.join("archive");
        let store = open_archive(&archive, "space").unwrap();
        write_json_new(
            &archive.join("snapshots/test-001.json"),
            &complete_snapshot(&store),
        )
        .unwrap();
        fs::write(archive.join("snapshots/broken.json"), b"{broken").unwrap();
        assert_eq!(history(&archive, "space").unwrap().len(), 1);
        assert_eq!(history_issues(&archive, "space").len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn snapshot_replica_and_offline_source_survive_original_deletion() {
        let root = directory();
        let archive = root.join("original");
        let store = open_archive(&archive, "space").unwrap();
        let snapshot = complete_snapshot(&store);
        write_json_new(&archive.join("snapshots/test-001.json"), &snapshot).unwrap();
        let second = root.join("second");
        fs::create_dir(&second).unwrap();
        let target = replicate(&archive, &second, &snapshot).unwrap();
        fs::remove_dir_all(&archive).unwrap();
        let recovered = load_snapshot(Path::new(&target), "test-001", "space").unwrap();
        let (_, documents, attachments) = snapshot_source(Path::new(&target), &recovered).unwrap();
        assert_eq!(documents[0].markdown, "original");
        assert_eq!(attachments[0].title, "archive.zip");
        assert!(load_snapshot(Path::new(&target), "../escape", "space").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn resources_include_non_searchable_files_and_video() {
        let value = json!({"type":"page","id":"doc","content":[{"type":"file","id":"zip","url":"https://r.craft.do/a","fileName":"archive.zip"},{"type":"video","id":"video","url":"https://r.craft.do/b"}]});
        let mut resources = BTreeMap::new();
        collect_resources(
            &value,
            "doc",
            &mut resources,
            &mut BTreeSet::new(),
            &mut BTreeSet::new(),
        );
        assert_eq!(resources.len(), 2);
        assert!(!allowed_asset_url("https://evilcraft.do/file"));
        assert!(!allowed_asset_url("http://r.craft.do/file"));
        assert!(allowed_asset_url(
            "https://images.unsplash.com/photo-example"
        ));
        assert!(!external_service_reference(
            "https://images.unsplash.com/photo-example"
        ));
        let mut unknown = BTreeSet::new();
        collect_resources(
            &json!({"id":"view","type":"gallery","filters":[]}),
            "doc",
            &mut resources,
            &mut BTreeSet::new(),
            &mut unknown,
        );
        assert!(
            unknown.is_empty(),
            "collection view is not an unsupported block"
        );
    }

    #[test]
    fn external_service_reference_is_explicit_and_missing_native_resource_blocks_completion() {
        let root = directory();
        let store = open_archive(&root.join("archive"), "space").unwrap();
        let mut snapshot = complete_snapshot(&store);
        snapshot.documents[0].structure_hash = put_json(&store, &json!([{"type":"page","id":"doc","content":[{"type":"image","id":"external","url":"https://my-ichery.feishu.cn/wiki/example"}]}])).unwrap();
        assert!(!verify_objects(&store, &snapshot).valid);
        snapshot.external_references.push(SnapshotAttachment {
            id: "external".into(),
            document_id: "doc".into(),
            title: "external page".into(),
            mime_type: String::new(),
            remote_url: "https://my-ichery.feishu.cn/wiki/example".into(),
            link_kind: "image".into(),
            expected_bytes: None,
            resource_revision: None,
            remote_etag: None,
            object_hash: None,
            bytes: None,
        });
        assert!(verify_objects(&store, &snapshot).valid);
        snapshot.documents[0].structure_hash = put_json(&store, &json!([{"type":"page","id":"doc","content":[{"type":"image","id":"missing","url":"https://r.craft.do/missing"}]}])).unwrap();
        assert!(!verify_objects(&store, &snapshot).valid);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn incomplete_inventory_and_foreign_identity_cannot_be_recovery_points() {
        let root = directory();
        let archive = root.join("archive");
        let store = open_archive(&archive, "space").unwrap();
        let mut snapshot = complete_snapshot(&store);
        snapshot.documents.clear();
        assert!(!verify_objects(&store, &snapshot).valid);
        snapshot.status = "partial".into();
        write_json_new(&archive.join("attempts/test-001.json"), &snapshot).unwrap();
        assert!(history(&archive, "space").unwrap().is_empty());
        assert!(open_archive(&archive, "another-space").is_err());
        assert_eq!(
            folder_listing("* <abc> Folder (2 docs)"),
            vec![("abc".into(), "Folder".into())]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn migration_preserves_all_recovery_points_and_original_vault() {
        let root = directory();
        let old = root.join("old");
        let new = root.join("new");
        fs::create_dir_all(&old).unwrap();
        fs::create_dir_all(&new).unwrap();
        let config = BackupConfig {
            library_id: "space".into(),
            destination: old.to_string_lossy().into(),
            vault_name: "Vault".into(),
            interval_minutes: 1440,
            replica_destination: None,
            last_attempt_at: 1,
            last_success_at: Some(2),
            last_error: None,
        };
        let source = backup_root(&config_options(&config)).unwrap();
        let store = open_archive(&source, "space").unwrap();
        let snapshot = complete_snapshot(&store);
        write_json_new(&source.join("snapshots/test-001.json"), &snapshot).unwrap();
        fs::create_dir(old.join("Vault")).unwrap();
        fs::write(old.join("Vault/local.md"), "my edit").unwrap();
        let (updated, target) = crate::craft_backup_migration::migrate(&config, &new).unwrap();
        assert_eq!(
            updated.destination,
            new.canonicalize().unwrap().to_string_lossy()
        );
        assert_eq!(
            fs::read_to_string(new.join("Vault/local.md")).unwrap(),
            "my edit"
        );
        assert!(snapshot_source(
            &target,
            &load_snapshot(&target, "test-001", "space").unwrap()
        )
        .is_ok());
        assert!(source.exists());
        assert!(old.join("Vault/local.md").exists());
        assert!(crate::craft_backup_migration::migrate(&config, &new).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn offline_restore_exports_original_attachment_and_preserves_local_edit() {
        let root = directory();
        let archive = root.join("archive");
        let store = open_archive(&archive, "space").unwrap();
        let mut snapshot = complete_snapshot(&store);
        snapshot.documents[0].markdown_hash = store
            .put(b"Note\n\n[archive](https://r.craft.do/asset)")
            .unwrap()
            .hash;
        let (store, documents, attachments) = snapshot_source(&archive, &snapshot).unwrap();
        let options = CraftVaultExportOptions {
            library_id: "space".into(),
            destination: root.to_string_lossy().into(),
            vault_name: Some("Vault".into()),
            include_images: true,
            include_videos: true,
            include_other_attachments: true,
            export_daily_notes: true,
            create_obsidian_config: true,
            backup_interval_minutes: 0,
            replica_destination: None,
        };
        let result = crate::craft_export::export_craft_vault(
            None,
            "Test".into(),
            documents.clone(),
            attachments.clone(),
            &store,
            options.clone(),
        )
        .await
        .unwrap();
        export_supplements(Path::new(&result.destination), &store, &snapshot).unwrap();
        let vault = Path::new(&result.destination);
        let text = fs::read_to_string(vault.join("Note.md")).unwrap();
        assert!(!text.contains("https://r.craft.do/asset"));
        assert_eq!(
            fs::read(vault.join("attachments/archive.zip")).unwrap(),
            b"original"
        );
        fs::write(vault.join("Note.md"), "my local edit").unwrap();
        let result = crate::craft_export::export_craft_vault(
            None,
            "Test".into(),
            documents,
            attachments,
            &store,
            options,
        )
        .await
        .unwrap();
        assert!(result.conflicts > 0);
        assert_eq!(
            fs::read_to_string(vault.join("Note.md")).unwrap(),
            "my local edit"
        );
        assert!(vault.join("Note - Craft 更新 1.md").exists());
        fs::remove_dir_all(root).unwrap();
    }

    /// Resume a fully saved attempt whose only problem is document drift.
    /// Rereads changed pages and all their resources, then rechecks the whole inventory.
    #[test]
    #[ignore]
    fn resume_document_drift_attempt() {
        let database = PathBuf::from(
            std::env::var_os("HUB_BACKUP_DATABASE").expect("Set HUB_BACKUP_DATABASE"),
        );
        let id = std::env::var("HUB_BACKUP_SPACE").expect("Set HUB_BACKUP_SPACE");
        let mut config = configs(&database)
            .unwrap()
            .into_iter()
            .find(|c| c.library_id == id)
            .unwrap();
        let options = config_options(&config);
        let root = backup_root(&options).unwrap();
        let mut snapshot = fs::read_dir(root.join("attempts"))
            .unwrap()
            .filter_map(|entry| {
                let point: Snapshot =
                    serde_json::from_slice(&fs::read(entry.ok()?.path()).ok()?).ok()?;
                (point.status == "partial").then_some(point)
            })
            .max_by_key(|point| point.finished_at)
            .unwrap();
        assert!(!snapshot.issues.is_empty());
        assert!(
            snapshot
                .issues
                .iter()
                .all(|issue| issue.category == "changed_during_capture"),
            "Only document drift can be resumed by this acceptance entry"
        );
        let store = BlobStore::open(&root.join("objects")).unwrap();
        assert!(
            verify_objects(&store, &snapshot).valid,
            "Original attempt has resource/inventory gaps"
        );
        let old_id = snapshot.id.clone();
        snapshot.id = format!(
            "{}-{:016x}",
            chrono::Utc::now().format("%Y%m%dT%H%M%SZ"),
            rand::thread_rng().next_u64()
        );
        snapshot.issues.clear();
        snapshot.status = "running".into();
        snapshot.finished_at = None;
        snapshot.limitations.push(format!(
            "续采自 {old_id}；保留原采集起始时间，变化页面及其原件已重新读取，完成后复查全空间清单"
        ));
        tauri::async_runtime::block_on(async {
            let client = Client::builder()
                .timeout(Duration::from_secs(180))
                .build()
                .unwrap();
            let asset_client = backup_client().unwrap();
            let mut credential = crate::load_credential(&id).unwrap();
            let token = crate::restore_credential_access_token(&client, &id, &mut credential)
                .await
                .unwrap();
            crate::save_credential(&id, &credential).unwrap();
            let authenticated =
                crate::initialize_authenticated_connection(&client, &credential.mcp_url, token)
                    .await
                    .unwrap();
            assert_eq!(authenticated.session.space_id, id);
            let session = &authenticated.session;
            let (current, locations, raw) = inventory(&client, session).await.unwrap();
            assert_eq!(
                current.len(),
                snapshot.documents.len(),
                "Document membership changed; perform a new full backup"
            );
            assert!(
                snapshot
                    .documents
                    .iter()
                    .all(|doc| current.contains_key(&doc.id)),
                "Document membership changed"
            );
            let folder_pages = read_craft_block_pages(&client, session, "folders list", 29_100_000)
                .await
                .unwrap();
            let prior_folders: Vec<Value> = serde_json::from_slice(
                &fs::read(
                    store
                        .path_for(snapshot.folders_hash.as_ref().unwrap())
                        .unwrap(),
                )
                .unwrap(),
            )
            .unwrap();
            assert_eq!(
                prior_folders
                    .iter()
                    .map(tool_result_text)
                    .collect::<Vec<_>>(),
                folder_pages
                    .iter()
                    .map(tool_result_text)
                    .collect::<Vec<_>>(),
                "Folder structure changed"
            );
            snapshot.inventory_hash = Some(put_json(&store, &raw).unwrap());
            let changed: Vec<_> = snapshot
                .documents
                .iter()
                .filter(|doc| {
                    let remote = &current[&doc.id];
                    remote.title != doc.title
                        || remote.modified_at != doc.modified_at
                        || locations
                            .get(&doc.id)
                            .map(String::as_str)
                            .unwrap_or("documents")
                            != doc.location
                })
                .cloned()
                .collect();
            println!("Rereading {} changed documents", changed.len());
            for doc in changed {
                snapshot.documents.retain(|old| old.id != doc.id);
                snapshot.attachments.retain(|old| old.document_id != doc.id);
                snapshot
                    .external_references
                    .retain(|old| old.document_id != doc.id);
                snapshot
                    .supplemental_objects
                    .retain(|key, _| !key.starts_with(&format!("{}:", doc.id)));
                capture_document(
                    &client,
                    &asset_client,
                    session,
                    &store,
                    &mut snapshot,
                    &current[&doc.id],
                    doc.folder_path,
                    locations
                        .get(&doc.id)
                        .cloned()
                        .unwrap_or_else(|| "documents".into()),
                )
                .await
                .unwrap();
            }
            let (after, after_locations, _) = inventory(&client, session).await.unwrap();
            assert_eq!(
                inventory_identity(&current, &locations),
                inventory_identity(&after, &after_locations),
                "Documents changed again during repair"
            );
            let after_folders =
                read_craft_block_pages(&client, session, "folders list", 29_101_000)
                    .await
                    .unwrap();
            assert_eq!(
                folder_pages
                    .iter()
                    .map(tool_result_text)
                    .collect::<Vec<_>>(),
                after_folders
                    .iter()
                    .map(tool_result_text)
                    .collect::<Vec<_>>(),
                "Folders changed during repair"
            );
            let verification = verify_objects(&store, &snapshot);
            snapshot.issues.extend(verification.issues);
            assert!(
                snapshot.issues.is_empty(),
                "Repaired attempt still has missing resources"
            );
            snapshot.status = "complete".into();
            snapshot.finished_at = Some(now_timestamp());
            write_report(&root, &snapshot).unwrap();
            write_json_new(
                &root.join("snapshots").join(format!("{}.json", snapshot.id)),
                &snapshot,
            )
            .unwrap();
            config.last_success_at = snapshot.finished_at;
            config.last_error = None;
            let (source, documents, attachments) = snapshot_source(&root, &snapshot).unwrap();
            let summary = crate::craft_export::export_craft_vault(
                None,
                snapshot.library_name.clone(),
                documents,
                attachments,
                &source,
                options,
            )
            .await
            .unwrap();
            export_supplements(Path::new(&summary.destination), &source, &snapshot).unwrap();
            if !summary.issues.is_empty() {
                config.last_error = Some("原始备份已完成，阅读副本有链接项目待处理".into());
            }
            save_config(&database, &config).unwrap();
            println!("Verified resumed recovery point: {} / {} documents / {} originals / {} Vault issues",snapshot.id,snapshot.documents.len(),snapshot.attachments.len(),summary.issues.len());
        });
    }

    /// Preserve usable reading material from an incomplete attempt in a clearly
    /// separate folder. Never promotes a partial attempt to a recovery point.
    #[test]
    #[ignore]
    fn export_partial_attempt_for_review() {
        let root = PathBuf::from(
            std::env::var_os("HUB_PARTIAL_BACKUP_ROOT").expect("Set HUB_PARTIAL_BACKUP_ROOT"),
        );
        let destination = PathBuf::from(
            std::env::var_os("HUB_PARTIAL_REVIEW_DESTINATION")
                .expect("Set HUB_PARTIAL_REVIEW_DESTINATION"),
        );
        let snapshot = fs::read_dir(root.join("attempts"))
            .unwrap()
            .filter_map(|entry| {
                let path = entry.ok()?.path();
                let point: Snapshot = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
                (point.status == "partial").then_some(point)
            })
            .max_by_key(|point| point.finished_at)
            .expect("No partial attempt");
        let store = BlobStore::open(&root.join("objects")).unwrap();
        for hash in referenced_hashes(&snapshot) {
            assert_eq!(
                hash_file(&store.path_for(&hash).unwrap()).unwrap(),
                hash,
                "Damaged saved object"
            );
        }
        let mut documents = Vec::new();
        for doc in &snapshot.documents {
            let tree: Value = serde_json::from_slice(
                &fs::read(store.path_for(&doc.structure_hash).unwrap()).unwrap(),
            )
            .unwrap();
            let mut blocks = Vec::new();
            reference_blocks(&tree, &mut blocks);
            blocks.retain(|(id, _)| id != &doc.id);
            documents.push(ExportDocument {
                id: doc.id.clone(),
                title: doc.title.clone(),
                folder_path: match doc.location.as_str() {
                    "trash" => format!("回收站/{}", doc.folder_path),
                    "templates" => format!("模板/{}", doc.folder_path),
                    _ => doc.folder_path.clone(),
                },
                markdown: fs::read_to_string(store.path_for(&doc.markdown_hash).unwrap()).unwrap(),
                modified_at: doc.modified_at,
                content_hash: doc.markdown_hash.clone(),
                raw_document_id: doc.raw_document_id.clone(),
                block_markdown: blocks,
            });
        }
        let attachments = snapshot
            .attachments
            .iter()
            .map(|asset| ExportAttachment {
                id: asset.id.clone(),
                document_id: asset.document_id.clone(),
                title: asset.title.clone(),
                mime_type: asset.mime_type.clone(),
                blob_hash: asset.object_hash.clone(),
                remote_url: Some(asset.remote_url.clone()),
                link_kind: asset.link_kind.clone(),
            })
            .collect();
        let vault_name = format!(
            "{} - 未完成阅读副本 - {}",
            snapshot.library_name, snapshot.id
        );
        let vault = destination.join(&vault_name);
        assert!(!vault.exists(), "Refuse overwriting a review folder");
        fs::create_dir_all(&vault).unwrap();
        write_json_new(&vault.join("采集未完成.json"), &snapshot).unwrap();
        fs::write(vault.join("请先阅读 - 这不是完整备份.md"), format!("# 采集未完成\n\n本库仅用于阅读已保存的内容，不能当作完整备份或成功恢复点。原始采集 {} 存在 {} 项未完成记录，详见采集未完成.json。缺失附件和未读取的页面仍需补齐。已保存的文件已逐一核验哈希。本目录没有替代正常 Vault，也没有修改原始快照。\n", snapshot.id,snapshot.issues.len())).unwrap();
        let options = CraftVaultExportOptions {
            library_id: snapshot.library_id.clone(),
            destination: destination.to_string_lossy().into(),
            vault_name: Some(vault_name),
            include_images: true,
            include_videos: true,
            include_other_attachments: true,
            export_daily_notes: true,
            create_obsidian_config: true,
            backup_interval_minutes: 0,
            replica_destination: None,
        };
        let mut summary = tauri::async_runtime::block_on(crate::craft_export::export_craft_vault(
            None,
            snapshot.library_name.clone(),
            documents,
            attachments,
            &store,
            options,
        ))
        .unwrap();
        summary.backup_complete = false;
        summary.snapshot_id = snapshot.id.clone();
        summary.backup_root = root.to_string_lossy().into();
        summary.issues.extend(snapshot.issues.clone());
        export_supplements(&vault, &store, &snapshot).unwrap();
        write_json_new(&vault.join("未完成阅读副本报告.json"), &summary).unwrap();
        assert!(!summary.backup_complete);
        assert!(!summary.issues.is_empty());
        println!("Partial reading copy saved; NOT a complete backup: {} / {} documents / {} saved assets / {} unavailable assets",snapshot.library_name,summary.exported_documents,summary.exported_attachments,summary.failed_attachments);
    }

    /// Targeted read-only diagnosis through a stored connection; never prints credentials.
    #[test]
    #[ignore]
    fn probe_stored_connection_resource() {
        let id = std::env::var("HUB_BACKUP_SPACE").expect("Set HUB_BACKUP_SPACE");
        let command =
            std::env::var("HUB_BACKUP_PROBE_COMMAND").expect("Set HUB_BACKUP_PROBE_COMMAND");
        tauri::async_runtime::block_on(async {
            let client = Client::builder()
                .timeout(Duration::from_secs(180))
                .build()
                .unwrap();
            let mut credential = crate::load_credential(&id).unwrap();
            let token = crate::restore_credential_access_token(&client, &id, &mut credential)
                .await
                .unwrap();
            crate::save_credential(&id, &credential).unwrap();
            let authenticated =
                crate::initialize_authenticated_connection(&client, &credential.mcp_url, token)
                    .await
                    .unwrap();
            assert_eq!(authenticated.session.space_id, id);
            let pages =
                read_craft_block_pages(&client, &authenticated.session, &command, 29_000_000)
                    .await
                    .unwrap();
            for page in pages {
                if let Some(value) = parse_tool_json(&page) {
                    fn inspect(value: &Value) {
                        match value {
                            Value::Object(map) => {
                                if map.get("type").and_then(Value::as_str) == Some("file") {
                                    println!(
                                        "Resource: {} / uploaded {:?} / URL available {}",
                                        map.get("fileName")
                                            .and_then(Value::as_str)
                                            .unwrap_or("file"),
                                        map.get("uploaded"),
                                        map.get("url")
                                            .and_then(Value::as_str)
                                            .is_some_and(|url| !url.is_empty())
                                    );
                                }
                                for child in map.values() {
                                    inspect(child);
                                }
                            }
                            Value::Array(items) => {
                                for item in items {
                                    inspect(item);
                                }
                            }
                            _ => {}
                        }
                    }
                    inspect(&value);
                }
            }
        });
    }

    /// Real-data offline recovery drill. No sessions, credentials or network client.
    #[test]
    #[ignore]
    fn offline_restore_existing_archives() {
        let parent = PathBuf::from(
            std::env::var_os("HUB_OFFLINE_ARCHIVES_PARENT")
                .expect("Set HUB_OFFLINE_ARCHIVES_PARENT"),
        );
        let destination = PathBuf::from(
            std::env::var_os("HUB_OFFLINE_RESTORE_DESTINATION")
                .expect("Set HUB_OFFLINE_RESTORE_DESTINATION"),
        );
        let mut restored = 0;
        for entry in fs::read_dir(&parent).unwrap() {
            let root = entry.unwrap().path();
            if !root.join("archive.json").is_file() {
                continue;
            }
            let marker: Value =
                serde_json::from_slice(&fs::read(root.join("archive.json")).unwrap()).unwrap();
            let library_id = marker["libraryId"].as_str().unwrap();
            let Some(snapshot) = history(&root, library_id)
                .unwrap()
                .into_iter()
                .max_by_key(|point| point.finished_at)
            else {
                continue;
            };
            let vault_name = format!("{} - 离线恢复验收", snapshot.library_name);
            if destination.join(&vault_name).exists() {
                continue;
            }
            let (store, documents, attachments) = snapshot_source(&root, &snapshot).unwrap();
            let options = CraftVaultExportOptions {
                library_id: library_id.into(),
                destination: destination.to_string_lossy().into(),
                vault_name: Some(vault_name),
                include_images: true,
                include_videos: true,
                include_other_attachments: true,
                export_daily_notes: true,
                create_obsidian_config: true,
                backup_interval_minutes: 0,
                replica_destination: None,
            };
            let summary = tauri::async_runtime::block_on(crate::craft_export::export_craft_vault(
                None,
                snapshot.library_name.clone(),
                documents,
                attachments,
                &store,
                options,
            ))
            .unwrap();
            export_supplements(Path::new(&summary.destination), &store, &snapshot).unwrap();
            write_json_new(
                &Path::new(&summary.destination).join("离线恢复验收.json"),
                &json!({"snapshot":snapshot.id,"networkUsed":false,"summary":summary}),
            )
            .unwrap();
            assert_eq!(summary.failed_attachments, 0);
            assert_eq!(summary.exported_documents, snapshot.documents.len());
            assert_eq!(summary.exported_attachments, snapshot.attachments.len());
            assert!(
                summary.issues.is_empty(),
                "Offline Vault has unresolved items"
            );
            println!(
                "Offline recovery verified: {} / {} documents / {} assets",
                snapshot.library_name, summary.exported_documents, summary.exported_attachments
            );
            restored += 1;
        }
        assert!(restored > 0, "No new archive was restored");
    }

    /// Explicit operational acceptance entry. Never runs with ordinary tests.
    /// Uses Windows credential storage; credentials are never printed/exported.
    #[test]
    #[ignore]
    fn live_full_backup_from_stored_connections() {
        let database = PathBuf::from(
            std::env::var_os("HUB_BACKUP_DATABASE").expect("Set HUB_BACKUP_DATABASE"),
        );
        let parent = PathBuf::from(
            std::env::var_os("HUB_BACKUP_DESTINATION").expect("Set HUB_BACKUP_DESTINATION"),
        );
        fs::create_dir_all(&parent).unwrap();
        let libraries = {
            let connection = Connection::open(&database).unwrap();
            let mut statement = connection.prepare("SELECT id,name FROM libraries WHERE provider='craft' AND enabled=1 ORDER BY name").unwrap();
            let rows = statement
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .unwrap();
            rows.collect::<Result<Vec<_>, _>>().unwrap()
        };
        let (connection, _writer) = crate::open_write_database(&database).unwrap();
        connection.execute("INSERT INTO metadata(key,value) VALUES('craft_backup_default_parent',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![parent.to_string_lossy()]).unwrap();
        drop(connection);
        drop(_writer);
        tauri::async_runtime::block_on(async move {
            let client = Client::builder()
                .timeout(Duration::from_secs(180))
                .build()
                .unwrap();
            let mut incomplete = 0;
            for (id, name) in libraries {
                if let Ok(selected) = std::env::var("HUB_BACKUP_SPACE") {
                    if selected != id {
                        continue;
                    }
                }
                println!("Starting full backup: {name}");
                let mut config = BackupConfig {
                    library_id: id.clone(),
                    destination: parent.to_string_lossy().into(),
                    vault_name: format!("{name} - Craft"),
                    interval_minutes: 1440,
                    replica_destination: None,
                    last_attempt_at: now_timestamp(),
                    last_success_at: None,
                    last_error: Some("首次备份尚未完成".into()),
                };
                save_config(&database, &config).unwrap();
                let operation = async {
                    let mut credential =
                        crate::load_credential(&id).map_err(|_| "连接凭据不可用".to_string())?;
                    let token =
                        crate::restore_credential_access_token(&client, &id, &mut credential)
                            .await
                            .map_err(|_| "连接授权恢复失败".to_string())?;
                    crate::save_credential(&id, &credential)
                        .map_err(|_| "连接授权保存失败".to_string())?;
                    let authenticated = crate::initialize_authenticated_connection(
                        &client,
                        &credential.mcp_url,
                        token,
                    )
                    .await
                    .map_err(|_| "Craft 连接初始化失败".to_string())?;
                    if authenticated.session.space_id != id {
                        return Err("Craft 连接空间身份不一致".into());
                    }
                    let options = config_options(&config);
                    let root = backup_root(&options)?;
                    let snapshot = capture(
                        None,
                        &client,
                        &authenticated.session,
                        &root,
                        &id,
                        &name,
                        true,
                    )
                    .await?;
                    println!(
                        "Captured {name}: {} pages, {} assets, status {}, {} issues",
                        snapshot.documents.len(),
                        snapshot.attachments.len(),
                        snapshot.status,
                        snapshot.issues.len()
                    );
                    if snapshot.status != "complete" {
                        return Err(format!(
                            "首次备份未完整，请查看 {}/attempts/{}.report.md",
                            root.display(),
                            snapshot.id
                        ));
                    }
                    config.last_success_at = snapshot.finished_at;
                    let (store, documents, attachments) = snapshot_source(&root, &snapshot)?;
                    let summary = crate::craft_export::export_craft_vault(
                        None,
                        name.clone(),
                        documents,
                        attachments,
                        &store,
                        options,
                    )
                    .await?;
                    export_supplements(Path::new(&summary.destination), &store, &snapshot)?;
                    if !summary.issues.is_empty() {
                        return Err("原始备份已完成，但 Vault 有项目待处理".into());
                    }
                    println!("Verified recovery point {name}: {}", snapshot.id);
                    Ok::<(), String>(())
                }
                .await;
                match operation {
                    Ok(()) => {
                        config.last_success_at = Some(now_timestamp());
                        config.last_error = None;
                    }
                    Err(error) => {
                        incomplete += 1;
                        config.last_error = Some(error);
                        println!("Backup requires attention: {name}");
                    }
                }
                save_config(&database, &config).unwrap();
            }
            assert_eq!(
                incomplete, 0,
                "One or more spaces have incomplete backups; see saved reports/settings"
            );
        });
    }
}
