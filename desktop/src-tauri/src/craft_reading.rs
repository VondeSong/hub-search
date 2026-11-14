//! Explicitly incomplete reading exports. These never publish a recovery point.
use crate::{
    blob_store::BlobStore,
    craft_backup::{self, BackupConfig, BackupIssue, Snapshot},
    craft_export::{self, CraftVaultExportOptions, CraftVaultExportSummary},
};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path};

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReadingHistory {
    pub attempts: Vec<AttemptInfo>,
    pub vault_path: Option<String>,
    pub vault_exists: bool,
    pub generated_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttemptInfo {
    pub id: String,
    pub library_id: String,
    pub library_name: String,
    pub started_at: i64,
    pub documents: usize,
    pub issues: usize,
}

fn archive_identity(root: &Path) -> Result<String, String> {
    craft_backup::reject_links(&root.join("archive.json"))?;
    let marker: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join("archive.json")).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    marker["libraryId"]
        .as_str()
        .map(str::to_owned)
        .ok_or("备份资料库身份缺失".into())
}

pub fn load_attempt(root: &Path, id: &str, library_id: &str) -> Result<Snapshot, String> {
    if id.is_empty() || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') {
        return Err("采集编号无效".into());
    }
    if archive_identity(root)? != library_id {
        return Err("采集不属于该资料库".into());
    }
    let path = root.join("attempts").join(format!("{id}.json"));
    craft_backup::reject_links(&path)?;
    let snapshot: Snapshot = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if snapshot.id != id
        || snapshot.library_id != library_id
        || snapshot.version != 1
        || snapshot.status != "partial"
        || snapshot.finished_at.is_none()
    {
        return Err("只支持已结束、身份一致的未完成采集；它不是完整恢复点".into());
    }
    Ok(snapshot)
}

pub fn history(
    root: Option<&Path>,
    library_id: &str,
    config: Option<&BackupConfig>,
) -> ReadingHistory {
    let mut result = ReadingHistory::default();
    if let Some(config) = config {
        let vault = Path::new(&config.destination).join(&config.vault_name);
        result.vault_exists = vault.join(".hub-export/manifest.json").is_file();
        result.generated_at = fs::read(vault.join(".hub-export/manifest.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
            .and_then(|v| v["generatedAt"].as_i64());
        result.vault_path = Some(vault.to_string_lossy().into());
    }
    if let Some(root) = root {
        if let Ok(entries) = fs::read_dir(root.join("attempts")) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|v| v.to_str()) != Some("json") {
                    continue;
                }
                let Some(id) = path.file_stem().and_then(|v| v.to_str()) else {
                    continue;
                };
                if let Ok(s) = load_attempt(root, id, library_id) {
                    result.attempts.push(AttemptInfo {
                        id: s.id,
                        library_id: s.library_id,
                        library_name: s.library_name,
                        started_at: s.started_at,
                        documents: s.documents.len(),
                        issues: s.issues.len(),
                    });
                }
            }
        }
    }
    result.attempts.sort_by(|a, b| {
        b.started_at
            .cmp(&a.started_at)
            .then_with(|| b.id.cmp(&a.id))
    });
    result
}

fn verified_object(store: &BlobStore, hash: &str) -> Result<Vec<u8>, String> {
    fs::read(verified_path(store, hash)?).map_err(|e| e.to_string())
}

fn verified_path(store: &BlobStore, hash: &str) -> Result<std::path::PathBuf, String> {
    let path = store.path_for(hash)?;
    craft_backup::reject_links(&path)?;
    if craft_backup::hash_file(&path)? != hash {
        return Err("原始对象哈希不一致".into());
    }
    Ok(path)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadingMarker {
    library_id: String,
    attempt_id: String,
    incomplete: bool,
}

pub async fn export_attempt(
    root: &Path,
    id: &str,
    library_id: &str,
    parent: &Path,
) -> Result<CraftVaultExportSummary, String> {
    let snapshot = load_attempt(root, id, library_id)?;
    let store = BlobStore::open_existing(&root.join("objects"))?;
    let parent = parent.canonicalize().map_err(|e| e.to_string())?;
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    if parent.starts_with(&root) || root.starts_with(&parent) {
        return Err("阅读副本位置不能包含或位于原始备份中".into());
    }
    let name = craft_export::sanitize_component(
        &format!(
            "{} - 阅读副本（有缺项） - {}",
            snapshot.library_name, snapshot.id
        ),
        "Craft 阅读副本",
    );
    let vault = parent.join(&name);
    craft_backup::reject_links(&vault)?;
    let marker_path = vault.join(".hub-export/reading-source.json");
    craft_backup::reject_links(&marker_path)?;
    if vault.exists() {
        let marker: ReadingMarker = fs::read(&marker_path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .ok_or("目标已存在且不是同一阅读副本，请另选位置；未覆盖任何文件")?;
        if !marker.incomplete || marker.library_id != library_id || marker.attempt_id != id {
            return Err("目标不属于同一阅读副本，未覆盖任何文件".into());
        }
    }
    let mut usable = snapshot.clone();
    let mut issues = snapshot.issues.clone();
    usable.documents.retain(|d| {
        let valid = verified_object(&store, &d.markdown_hash)
            .and_then(|b| String::from_utf8(b).map_err(|e| e.to_string()))
            .is_ok()
            && verified_object(&store, &d.structure_hash)
                .and_then(|b| {
                    serde_json::from_slice::<serde_json::Value>(&b).map_err(|e| e.to_string())
                })
                .is_ok();
        if !valid {
            issues.push(BackupIssue {
                object_id: d.id.clone(),
                category: "reading_document".into(),
                message: format!("页面「{}」正文或结构未通过校验，未生成占位页", d.title),
            });
        }
        valid
    });
    if usable.documents.is_empty() {
        return Err("没有可校验的正文，未生成阅读副本".into());
    }
    for asset in &mut usable.attachments {
        let valid = asset.object_hash.as_ref().is_some_and(|h| {
            verified_path(&store, h).is_ok()
                && store
                    .path_for(h)
                    .is_ok_and(|p| craft_backup::validate_original_content(&p, true).is_ok())
        });
        if !valid {
            asset.object_hash = None;
        }
    }
    usable.supplemental_objects.retain(|key, hash| {
        let valid = verified_object(&store, hash).is_ok();
        if !valid {
            issues.push(BackupIssue {
                object_id: key.clone(),
                category: "reading_supplement".into(),
                message: "补充结构对象不可用，未生成替代内容".into(),
            });
        }
        valid
    });
    let (store, documents, attachments) = craft_backup::saved_source(store, &usable)?;
    fs::create_dir_all(vault.join(".hub-export")).map_err(|e| e.to_string())?;
    if !marker_path.exists() {
        fs::write(
            &marker_path,
            serde_json::to_vec(&ReadingMarker {
                library_id: library_id.into(),
                attempt_id: id.into(),
                incomplete: true,
            })
            .map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
    }
    let mut summary = craft_export::export_craft_vault(
        None,
        snapshot.library_name.clone(),
        documents,
        attachments,
        &store,
        CraftVaultExportOptions {
            library_id: library_id.into(),
            destination: parent.to_string_lossy().into(),
            vault_name: Some(name),
            include_images: true,
            include_videos: true,
            include_other_attachments: true,
            export_daily_notes: true,
            create_obsidian_config: true,
            backup_interval_minutes: 0,
            replica_destination: None,
        },
    )
    .await?;
    // Missing whiteboard assets must not prevent reading otherwise verified text.
    usable.attachments.retain(|a| a.object_hash.is_some());
    craft_backup::export_supplements(&vault, &store, &usable)?;
    summary.backup_root = root.to_string_lossy().into();
    summary.snapshot_id = id.into();
    summary.backup_complete = false;
    summary.external_references = snapshot.external_references.len();
    summary.issues.extend(issues);
    let report = vault.join(".hub-export/reading-report.json");
    craft_backup::reject_links(&report)?;
    let mut report_value = serde_json::to_value(&summary).map_err(|e| e.to_string())?;
    add_resource_gaps(&snapshot, &mut report_value);
    fs::write(
        report,
        serde_json::to_vec_pretty(&report_value).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let notice = vault.join("请先阅读 - 这不是完整备份.md");
    craft_backup::reject_links(&notice)?;
    if !notice.exists() {
        fs::write(&notice,format!("# 阅读副本（有缺项）\n\n这不是完整备份或成功恢复点。仅包含已通过哈希校验的正文和可用原件；未获取的页面、附件与元数据不保证完整。\n\n采集编号：{}；采集日期：{}。\n\n正文附近的缺项提示与 .hub-export/reading-report.json 可用于核对。来源备份、正常 Vault 和自动备份设置均未改变。\n\n集合只保留静态内容和原始资料；白板需要 Excalidraw，不能承诺完整编辑或恢复 Craft 布局。\n{}",id,chrono::DateTime::from_timestamp(snapshot.started_at,0).map(|d|d.to_rfc3339()).unwrap_or_default(),readable_gaps(&report_value))).map_err(|e|e.to_string())?;
    }
    Ok(summary)
}

fn readable_gaps(report: &serde_json::Value) -> String {
    let plain = |v: &serde_json::Value| {
        v.as_str()
            .unwrap_or("未命名")
            .replace(['\r', '\n', '`'], " ")
    };
    let mut text = "\n## 首次生成时的缺项清单\n\n此清单便于直接阅读；重复生成保留此说明的本地修改，最新机器报告另存于 .hub-export/reading-report.json。\n\n".to_string();
    if let Some(resources) = report["unavailableResources"].as_array() {
        for resource in resources {
            text.push_str(&format!(
                "- 附件 `{}`；原页 `{}`；资源 ID `{}`。\n",
                plain(&resource["title"]),
                plain(&resource["documentTitle"]),
                plain(&resource["id"])
            ));
        }
    }
    text.push_str("\n## 首次生成时的链接核对\n\n");
    if let Some(issues) = report["issues"].as_array() {
        for issue in issues.iter().filter(|i| i["category"] == "vault_link") {
            text.push_str(&format!("- `{}`\n", plain(&issue["message"])));
        }
    }
    text
}

fn add_resource_gaps(snapshot: &Snapshot, report: &mut serde_json::Value) {
    use std::collections::BTreeMap;
    // Raw capture issues remain available as evidence. The reading checklist
    // groups the failed resource once, with the affected source page.
    let mut resources = BTreeMap::new();
    for asset in &snapshot.attachments {
        let failed = report["issues"].as_array().is_some_and(|issues| {
            issues
                .iter()
                .any(|i| i["category"] == "vault_attachment" && i["objectId"] == asset.id)
        });
        if failed {
            let page = snapshot
                .documents
                .iter()
                .find(|d| d.id == asset.document_id);
            resources.entry(asset.id.clone()).or_insert_with(|| {
                serde_json::json!({
                    "id":asset.id,"title":asset.title,"documentId":asset.document_id,
                    "documentTitle":page.map(|d|d.title.as_str()),"offlineAvailable":false
                })
            });
        }
    }
    report["unavailableResources"] = serde_json::Value::Array(resources.into_values().collect());
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn sample() -> (std::path::PathBuf, Snapshot) {
        let root = std::env::temp_dir().join(format!("hub-reading-{:016x}", rand::random::<u64>()));
        fs::create_dir_all(root.join("archive/attempts")).unwrap();
        let archive = root.join("archive");
        fs::write(archive.join("archive.json"), r#"{"libraryId":"space"}"#).unwrap();
        let store = BlobStore::open(&archive.join("objects")).unwrap();
        let markdown = store
            .put("# 真实标题\n\n[附件](https://r.craft.do/missing)\n".as_bytes())
            .unwrap()
            .hash;
        let structure = store.put(br#"{"id":"doc","type":"page"}"#).unwrap().hash;
        let snapshot = Snapshot {
            version: 1,
            id: "attempt-1".into(),
            library_id: "space".into(),
            library_name: "测试".into(),
            started_at: 1794700000,
            finished_at: Some(1794700001),
            status: "partial".into(),
            inventory_hash: None,
            folders_hash: None,
            connection_hash: None,
            documents: vec![craft_backup::SnapshotDocument {
                id: "doc".into(),
                raw_document_id: Some("raw".into()),
                title: "真实标题".into(),
                folder_path: String::new(),
                location: "documents".into(),
                modified_at: Some(1794700000),
                markdown_hash: markdown,
                structure_hash: structure,
                block_ids: vec![],
            }],
            attachments: vec![craft_backup::SnapshotAttachment {
                id: "asset".into(),
                document_id: "doc".into(),
                title: "missing.png".into(),
                mime_type: "image/png".into(),
                remote_url: "https://r.craft.do/missing".into(),
                link_kind: "image".into(),
                expected_bytes: None,
                resource_revision: None,
                remote_etag: None,
                object_hash: None,
                bytes: None,
            }],
            external_references: vec![],
            supplemental_objects: BTreeMap::new(),
            issues: vec![],
            limitations: vec![],
        };
        fs::write(
            archive.join("attempts/attempt-1.json"),
            serde_json::to_vec(&snapshot).unwrap(),
        )
        .unwrap();
        fs::create_dir(root.join("exports")).unwrap();
        (root, snapshot)
    }

    #[tokio::test]
    async fn partial_copy_preserves_recovery_gate_edits_and_is_replayable() {
        let (root, snapshot) = sample();
        let archive = root.join("archive");
        let parent = root.join("exports");
        assert!(craft_backup::snapshot_source(&archive, &snapshot).is_err());
        let first = export_attempt(&archive, &snapshot.id, "space", &parent)
            .await
            .unwrap();
        assert!(!first.backup_complete);
        assert_eq!(first.failed_attachments, 1);
        let vault = Path::new(&first.destination);
        let report: serde_json::Value = serde_json::from_slice(
            &fs::read(vault.join(".hub-export/reading-report.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(report["unavailableResources"].as_array().unwrap().len(), 1);
        assert_eq!(
            report["unavailableResources"][0]["documentTitle"],
            "真实标题"
        );
        assert!(
            fs::read_to_string(vault.join("请先阅读 - 这不是完整备份.md"))
                .unwrap()
                .contains("原页 `真实标题`")
        );
        let note = vault.join("真实标题.md");
        let original = fs::read_to_string(&note).unwrap();
        assert!(original.contains("附件未保存本地原件"));
        assert!(!original.contains("craft_id:"));
        assert!(original.contains("modified: 2026-"));
        assert!(!archive.join("snapshots").exists());
        let second = export_attempt(&archive, &snapshot.id, "space", &parent)
            .await
            .unwrap();
        assert_eq!(second.skipped_documents, 1);
        assert_eq!(second.conflicts, 0);
        fs::write(&note, "用户修改").unwrap();
        fs::write(
            vault.join(".obsidian/app.json"),
            r#"{"showInlineTitle":true,"custom":1}"#,
        )
        .unwrap();
        let third = export_attempt(&archive, &snapshot.id, "space", &parent)
            .await
            .unwrap();
        assert_eq!(third.conflicts, 1);
        assert_eq!(fs::read_to_string(note).unwrap(), "用户修改");
        assert_eq!(
            fs::read_to_string(vault.join(".obsidian/app.json")).unwrap(),
            r#"{"showInlineTitle":true,"custom":1}"#
        );
        assert!(load_attempt(&archive, "../attempt-1", "space").is_err());
        assert!(load_attempt(&archive, &snapshot.id, "foreign").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn corrupted_body_is_not_exported_and_missing_vault_is_explicit() {
        let (root, snapshot) = sample();
        let archive = root.join("archive");
        let parent = root.join("exports");
        let store = BlobStore::open_existing(&archive.join("objects")).unwrap();
        fs::write(
            store
                .path_for(&snapshot.documents[0].markdown_hash)
                .unwrap(),
            "损坏",
        )
        .unwrap();
        assert!(export_attempt(&archive, &snapshot.id, "space", &parent)
            .await
            .unwrap_err()
            .contains("没有可校验"));
        assert_eq!(fs::read_dir(parent).unwrap().count(), 0);
        let configured = BackupConfig {
            library_id: "space".into(),
            destination: root.to_string_lossy().into(),
            vault_name: "missing".into(),
            interval_minutes: 0,
            replica_destination: None,
            last_attempt_at: 0,
            last_success_at: None,
            last_error: None,
        };
        let state = history(Some(&archive), "space", Some(&configured));
        assert!(!state.vault_exists);
        assert!(state.generated_at.is_none());
        assert_eq!(state.attempts.len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn existing_unmanaged_destination_and_backup_parent_are_rejected() {
        let (root, snapshot) = sample();
        let parent = root.join("exports");
        let archive = root.join("archive");
        let target = parent.join(craft_export::sanitize_component(
            &format!(
                "{} - 阅读副本（有缺项） - {}",
                snapshot.library_name, snapshot.id
            ),
            "Craft 阅读副本",
        ));
        fs::create_dir(&target).unwrap();
        fs::write(target.join("用户文件.md"), "保留").unwrap();
        assert!(export_attempt(&archive, &snapshot.id, "space", &parent)
            .await
            .unwrap_err()
            .contains("目标已存在"));
        assert_eq!(
            fs::read_to_string(target.join("用户文件.md")).unwrap(),
            "保留"
        );
        assert!(export_attempt(&archive, &snapshot.id, "space", &archive)
            .await
            .unwrap_err()
            .contains("原始备份"));
        fs::remove_dir_all(root).unwrap();
    }

    /// Opt-in: normal production conversion from existing personal backups,
    /// with changes confined to a newly designated derived export directory.
    #[tokio::test]
    #[ignore]
    async fn real_saved_reading_roundtrip() {
        let root =
            std::path::PathBuf::from(std::env::var_os("HUB_CRAFT_READING_ROOT").expect("root"));
        let parent = std::path::PathBuf::from(
            std::env::var_os("HUB_CRAFT_READING_DESTINATION").expect("new export parent"),
        );
        let library = archive_identity(&root).unwrap();
        let attempt = history(Some(&root), &library, None)
            .attempts
            .into_iter()
            .next()
            .expect("partial attempt");
        let original =
            craft_backup::hash_file(&root.join("attempts").join(format!("{}.json", attempt.id)))
                .unwrap();
        let first = export_attempt(&root, &attempt.id, &library, &parent)
            .await
            .unwrap();
        assert!(!first.backup_complete);
        assert_eq!(first.exported_documents, attempt.documents);
        let vault = Path::new(&first.destination);
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(vault.join(".hub-export/manifest.json")).unwrap())
                .unwrap();
        let docs = manifest["documents"].as_object().unwrap();
        let hashes = docs
            .values()
            .map(|e| {
                let p = vault.join(e["path"].as_str().unwrap());
                (p.clone(), craft_backup::hash_file(&p).unwrap())
            })
            .collect::<Vec<_>>();
        let attachments = manifest["attachments"].as_object().unwrap();
        for entry in attachments.values() {
            assert_eq!(
                craft_backup::hash_file(&vault.join(entry["path"].as_str().unwrap())).unwrap(),
                entry["exportedHash"].as_str().unwrap()
            );
        }
        let second = export_attempt(&root, &attempt.id, &library, &parent)
            .await
            .unwrap();
        assert_eq!(second.conflicts, 0);
        assert_eq!(second.skipped_documents, attempt.documents);
        for (p, h) in &hashes {
            assert_eq!(craft_backup::hash_file(p).unwrap(), *h);
        }
        if let Some(entry) = attachments.values().next() {
            let path = vault.join(entry["path"].as_str().unwrap());
            fs::remove_file(&path).unwrap();
            export_attempt(&root, &attempt.id, &library, &parent)
                .await
                .unwrap();
            assert_eq!(
                craft_backup::hash_file(&path).unwrap(),
                entry["exportedHash"].as_str().unwrap()
            );
        }
        let note = &hashes[0].0;
        let body = fs::read_to_string(note).unwrap();
        fs::write(
            note,
            format!("{body}\n\n阅读副本验收附注：本地修改必须保留。\n"),
        )
        .unwrap();
        let edited = craft_backup::hash_file(note).unwrap();
        let third = export_attempt(&root, &attempt.id, &library, &parent)
            .await
            .unwrap();
        assert!(third.conflicts >= 1);
        assert_eq!(craft_backup::hash_file(note).unwrap(), edited);
        assert_eq!(
            craft_backup::hash_file(&root.join("attempts").join(format!("{}.json", attempt.id)))
                .unwrap(),
            original
        );
        println!(
            "READING_EVIDENCE {}",
            serde_json::to_string(&first).unwrap()
        );
    }

    #[tokio::test]
    #[ignore]
    async fn real_complete_reading_roundtrip() {
        let root =
            std::path::PathBuf::from(std::env::var_os("HUB_CRAFT_READING_ROOT").expect("root"));
        let parent = std::path::PathBuf::from(
            std::env::var_os("HUB_CRAFT_READING_DESTINATION").expect("new export parent"),
        );
        let library = archive_identity(&root).unwrap();
        let snapshot = craft_backup::history(&root, &library)
            .unwrap()
            .into_iter()
            .next()
            .expect("complete snapshot");
        let (store, docs, assets) = craft_backup::snapshot_source(&root, &snapshot).unwrap();
        let options = CraftVaultExportOptions {
            library_id: library,
            destination: parent.to_string_lossy().into(),
            vault_name: Some(format!("{} - 完整点阅读验收", snapshot.library_name)),
            include_images: true,
            include_videos: true,
            include_other_attachments: true,
            export_daily_notes: true,
            create_obsidian_config: true,
            backup_interval_minutes: 0,
            replica_destination: None,
        };
        let first = craft_export::export_craft_vault(
            None,
            snapshot.library_name.clone(),
            docs.clone(),
            assets.clone(),
            &store,
            options.clone(),
        )
        .await
        .unwrap();
        craft_backup::export_supplements(Path::new(&first.destination), &store, &snapshot).unwrap();
        assert_eq!(first.failed_attachments, 0);
        assert_eq!(first.exported_documents, snapshot.documents.len());
        let second = craft_export::export_craft_vault(
            None,
            snapshot.library_name,
            docs,
            assets,
            &store,
            options,
        )
        .await
        .unwrap();
        assert_eq!(second.conflicts, 0);
        assert_eq!(second.skipped_documents, snapshot.documents.len());
        println!(
            "COMPLETE_READING_EVIDENCE {}",
            serde_json::to_string(&first).unwrap()
        );
    }
}
