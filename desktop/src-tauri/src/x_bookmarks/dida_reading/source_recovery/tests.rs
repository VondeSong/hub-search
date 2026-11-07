//! Producer/consumer evidence uses the real Dida importer, reading merge and signed OSS HTTP.
//! Local fixture files are originals; a cloud receipt is never manufactured by a test.
use super::*;
use crate::flashcard_cloud_sync::tests::{server, store};
use crate::flashcard_object_store::{OssConfig, OssStore};
use base64::Engine as _;
use tokio::net::TcpListener;

const LIBRARY: &str = "source-recovery-fixture";
const ACCOUNT: &str = "isolated-account";

struct Device {
    root: PathBuf,
    db: PathBuf,
    operation: Arc<library_runtime::Operation>,
}
impl Device {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("hub-source-recovery-test-{}", random_url_safe(12)));
        fs::create_dir_all(&root).unwrap();
        let db = root.join("hub.sqlite3");
        let c = open_database(&db).unwrap();
        storage::schema(&c).unwrap();
        super::super::schema(&c).unwrap();
        c.execute("INSERT INTO libraries(id,provider,name,enabled,added_at,metadata_json) VALUES(?1,'dida365','隔离来源恢复',1,1,?2)", params![LIBRARY,json!({"preference":{"userId":ACCOUNT}}).to_string()]).unwrap();
        let config = OssConfig {
            bucket: "test-bucket".into(),
            region: "cn-hangzhou".into(),
            prefix: "HubFlashcards".into(),
            access_key_id: "EXAMPLE".into(),
        };
        meta(
            &c,
            "flashcard_oss_config",
            &serde_json::to_string(&config).unwrap(),
        )
        .unwrap();
        for (key, value) in [
            ("cloud_sync_enabled", "1"),
            ("cloud_sync_reading", "1"),
            ("cloud_sync_auto", "0"),
            ("flashcard_cloud_provider", "oss"),
            ("reading_source_cleanup", "1"),
            ("reading_media_policy", "{\"enabled\":true}"),
        ] {
            meta(&c, key, value).unwrap();
        }
        let operation =
            Arc::new(library_runtime::begin(&root, LIBRARY, "隔离来源恢复测试").unwrap());
        Self {
            root,
            db,
            operation,
        }
    }
    fn c(&self) -> Connection {
        open_database(&self.db).unwrap()
    }
    fn namespace(&self) -> String {
        object_store::namespace(&self.c()).unwrap()
    }
    fn import(&self, task: &DidaTask, originals: &[Vec<u8>]) -> Receipt {
        let assets = refs(task).unwrap();
        assert_eq!(assets.len(), originals.len());
        let mut c = self.c();
        let record = commit_import(
            &mut c,
            LIBRARY,
            "隔离来源恢复",
            ACCOUNT,
            task,
            &assets,
            &self.operation,
        )
        .unwrap();
        for (index, (asset, bytes)) in assets.iter().zip(originals).enumerate() {
            let path = self.root.join(format!("original-{index}.png"));
            fs::write(&path, bytes).unwrap();
            let hash = file_hash(&path).unwrap();
            let mime = infer::get(bytes).unwrap().mime_type();
            let url = media_url(LIBRARY, &task.id, asset);
            let tx = c.transaction().unwrap();
            tx.execute("INSERT INTO collection_dida_reading_assets(item_key,media_url,blob_hash,file_name,mime_type,size,snapshot_hash) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![record.key,url,hash,asset.file_name,mime,bytes.len() as u64,record.snapshot]).unwrap();
            storage::record_saved_media(&tx, &record.key, &url, &path).unwrap();
            self.operation
                .commit(|| tx.commit().map_err(|e| e.to_string()))
                .unwrap();
        }
        // The production local verification must pass before the same guarded transition.
        let mut cfg = storage::StorageConfig::default();
        cfg.download_media = true;
        verify_local(&c, &record, &cfg).unwrap();
        self.operation.commit(|| c.execute("UPDATE collection_dida_reading SET local_verified=1,delete_state='verified',error='' WHERE item_key=?1 AND snapshot_hash=?2 AND post_hash=?3",params![record.key,record.snapshot,record.post_hash]).map(|_|()).map_err(|e|e.to_string())).unwrap();
        receipt(&c, LIBRARY, &task.id).unwrap().unwrap()
    }
    async fn publish(&self, remote: &OssStore) {
        let ns = self.namespace();
        crate::reading_sync::sync_database(&self.db, remote, &ns, "source-producer")
            .await
            .unwrap();
        crate::reading_sync::media::sync(&self.db, remote, &ns, "source-producer")
            .await
            .unwrap();
    }
    fn state(&self, key: &str) -> String {
        self.c().query_row("SELECT state FROM reading_source_recovery_receipts WHERE namespace=?1 AND item_key=?2",params![self.namespace(),key],|r|r.get(0)).unwrap()
    }
}
impl Drop for Device {
    fn drop(&mut self) {
        forget_initialized_database(&self.db);
        assert_eq!(self.root.parent(), Some(std::env::temp_dir().as_path()));
        assert!(self
            .root
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("hub-source-recovery-test-"));
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn source(attachments: usize) -> DidaTask {
    let raw = json!({
        "id":"source-task", "projectId":"source-project", "title":"完整来源资料",
        "content":"原始正文与[文章地址](https://example.invalid/article)", "desc":"原始附注",
        "kind":"NOTE", "tags":["稍后读","保留的来源标签"], "status":0,
        "items":[{"id":"check-one","title":"完整检查项","status":1}], "childIds":[],
        "attachments":(0..attachments).map(|i|json!({
            "id":format!("{i:024x}"), "name":format!("source-{i}.png"), "fileType":"image/png"
        })).collect::<Vec<_>>(),
        "createdTime":"2026-10-07T09:00:00.000+0000",
        "modifiedTime":"2026-10-07T09:30:00.000+0000",
        "unknownFutureField":{"retained":[1,"original",true]}
    });
    parse(raw)
}
fn parse(raw: Value) -> DidaTask {
    let mut tasks = Vec::new();
    collect_dida_tasks(&raw, "source-project", &mut tasks);
    tasks.remove(0)
}
fn png() -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE+0AAAAASUVORK5CYII=").unwrap()
}
fn source_key(remote: &OssStore, scope: &Scope) -> String {
    remote.key(&format!("reading/source-v1/{}.json", scope.envelope_hash))
}
async fn assert_no_unscoped_delete(d: &Device) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let session = McpSession {
        space_id: LIBRARY.into(),
        space_name: "隔离来源恢复".into(),
        endpoint: format!("http://{}", listener.local_addr().unwrap()),
        access_token: "isolated-test-token".into(),
        session_id: None,
        protocol_version: "2025-03-26".into(),
        rate_limiter: Arc::new(CraftRateLimiter::default()),
        deep_link_template: None,
    };
    let result = DELETE_CONTROL
        .scope(
            (d.db.clone(), d.operation.clone()),
            call_dida_write_tool_raw(
                &reqwest::Client::new(),
                &session,
                "delete_task",
                json!({"task_id":"source-task","project_id":"source-project"}),
                74003,
            ),
        )
        .await;
    let error = result.expect_err("historical/partial proof must not reach the writer");
    assert!(error.contains("滴答原项已保留"), "{error}");
    assert!(
        tokio::time::timeout(Duration::from_millis(25), listener.accept())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn source_recovery_real_import_restores_raw_envelope_and_only_fresh_success_mints_permit() {
    let s = server().await;
    let remote = store(&s);
    let d = Device::new();
    let task = source(1);
    let bytes = png();
    let record = d.import(&task, &[bytes.clone()]);
    let imported: String = d
        .c()
        .query_row(
            "SELECT post_json FROM collection_x_items WHERE item_key=?1",
            [&record.key],
            |r| r.get(0),
        )
        .unwrap();
    let imported: Post = serde_json::from_str(&imported).unwrap();
    assert_eq!(imported.content_status, "full"); // Exercise the existing Dida producer contract.
    d.publish(&remote).await;
    let scope = build(&d.c(), &record.key).unwrap();
    let transferred = remote.transferred();
    let permit = authorize_remote(&d.db, &remote, &record.key).await.unwrap();
    validate_permit(&d.c(), &permit).unwrap();
    assert_eq!(d.state(&record.key), "complete");
    assert!(remote.transferred().1 > transferred.1 + scope.envelope.len() as u64);
    let key = source_key(&remote, &scope);
    let actual = remote.get(&key, 2 * 1024 * 1024).await.unwrap().unwrap();
    assert_eq!(actual, scope.envelope);
    let envelope: Envelope = serde_json::from_slice(&actual).unwrap();
    assert_eq!(envelope.source_snapshot, task.raw);
    assert_eq!(envelope.snapshot_hash, record.snapshot);
    assert_eq!(envelope.post_hash, record.post_hash);
    assert_eq!(envelope.originals.len(), 1);
    assert_eq!(envelope.originals[0].hash, storage::hash(&bytes));
    assert_eq!(envelope.originals[0].size, bytes.len() as u64);
    assert_eq!(envelope.originals[0].mime, "image/png");
    assert_eq!(
        envelope.originals[0].url,
        media_url(LIBRARY, &task.id, &refs(&task).unwrap()[0])
    );
    assert_no_unscoped_delete(&d).await; // A genuine completed history still grants no writer scope.
    let mut expired = permit.clone();
    expired.created = Instant::now()
        .checked_sub(Duration::from_secs(181))
        .unwrap();
    assert!(validate_permit(&d.c(), &expired).is_err());
}

#[tokio::test]
async fn source_recovery_source_cloud_policy_body_tag_and_inventory_changes_reject_live_permit() {
    let s = server().await;
    let remote = store(&s);
    let d = Device::new();
    let task = source(1);
    let record = d.import(&task, &[png()]);
    d.publish(&remote).await;
    let permit = authorize_remote(&d.db, &remote, &record.key).await.unwrap();
    for (key, replacement) in [
        ("reading_source_cleanup", "0"),
        ("cloud_sync_enabled", "0"),
        ("cloud_sync_reading", "0"),
        ("reading_media_policy", "{\"enabled\":false}"),
        ("reading_cloud_network", "{\"mode\":\"wifiOnly\"}"),
        ("flashcard_cloud_provider", "webdav"),
    ] {
        let old = metadata_string(&d.c(), key);
        meta(&d.c(), key, replacement).unwrap();
        assert!(validate_permit(&d.c(), &permit).is_err(), "changed {key}");
        meta(&d.c(), key, &old).unwrap();
        validate_permit(&d.c(), &permit).unwrap();
    }
    let config = metadata_string(&d.c(), "flashcard_oss_config");
    let mut changed: Value = serde_json::from_str(&config).unwrap();
    changed["prefix"] = json!("DifferentIsolatedNamespace");
    meta(&d.c(), "flashcard_oss_config", &changed.to_string()).unwrap();
    assert!(validate_permit(&d.c(), &permit).is_err());
    meta(&d.c(), "flashcard_oss_config", &config).unwrap();
    for (mutation, restore) in [
        (
            "UPDATE collection_dida_reading SET account_id='different-account'",
            format!("UPDATE collection_dida_reading SET account_id='{ACCOUNT}'"),
        ),
        (
            "UPDATE collection_dida_reading SET project_id='different-project'",
            "UPDATE collection_dida_reading SET project_id='source-project'".into(),
        ),
        (
            "UPDATE collection_dida_reading SET local_verified=0",
            "UPDATE collection_dida_reading SET local_verified=1".into(),
        ),
        (
            "UPDATE collection_dida_reading_assets SET size=size+1",
            "UPDATE collection_dida_reading_assets SET size=size-1".into(),
        ),
    ] {
        d.c().execute_batch(mutation).unwrap();
        assert!(
            validate_permit(&d.c(), &permit).is_err(),
            "changed {mutation}"
        );
        d.c().execute_batch(&restore).unwrap();
        validate_permit(&d.c(), &permit).unwrap();
    }
    let library_metadata: String = d
        .c()
        .query_row(
            "SELECT metadata_json FROM libraries WHERE id=?1",
            [LIBRARY],
            |r| r.get(0),
        )
        .unwrap();
    d.c()
        .execute(
            "UPDATE libraries SET metadata_json=?2 WHERE id=?1",
            params![
                LIBRARY,
                json!({"preference":{"userId":"different-source-account"}}).to_string()
            ],
        )
        .unwrap();
    assert!(validate_permit(&d.c(), &permit).is_err());
    d.c()
        .execute(
            "UPDATE libraries SET metadata_json=?2 WHERE id=?1",
            params![LIBRARY, library_metadata],
        )
        .unwrap();
    validate_permit(&d.c(), &permit).unwrap();
    for (table, column, replacement) in [
        (
            "collection_x_properties",
            "tags",
            json!(["尚未同步的新标签"]).to_string(),
        ),
        ("collection_x_items", "post_json", {
            let mut p: Value = serde_json::from_str(
                &d.c()
                    .query_row(
                        "SELECT post_json FROM collection_x_items WHERE item_key=?1",
                        [&record.key],
                        |r| r.get::<_, String>(0),
                    )
                    .unwrap(),
            )
            .unwrap();
            p["text"] = json!("本地正文已修改");
            p.to_string()
        }),
        ("collection_dida_reading", "raw_json", {
            let mut raw = task.raw.clone();
            raw["tags"] = json!([]);
            raw.to_string()
        }),
    ] {
        let sql = format!("SELECT {column} FROM {table} WHERE item_key=?1");
        let old: String = d.c().query_row(&sql, [&record.key], |r| r.get(0)).unwrap();
        let sql = format!("UPDATE {table} SET {column}=?2 WHERE item_key=?1");
        d.c()
            .execute(&sql, params![record.key, replacement])
            .unwrap();
        assert!(
            validate_permit(&d.c(), &permit).is_err(),
            "changed {table}.{column}"
        );
        d.c().execute(&sql, params![record.key, old]).unwrap();
        validate_permit(&d.c(), &permit).unwrap();
    }
}

#[tokio::test]
async fn source_recovery_missing_corrupt_body_or_original_and_failed_envelope_never_authorize_delete(
) {
    let s = server().await;
    let remote = store(&s);
    let d = Device::new();
    let task = source(2);
    let mut second = png();
    second.extend_from_slice(b"distinct isolated original");
    let record = d.import(&task, &[png(), second]);
    d.publish(&remote).await;
    let permit = authorize_remote(&d.db, &remote, &record.key).await.unwrap();
    let scope = build(&d.c(), &record.key).unwrap();
    let body_id: String = d
        .c()
        .query_row(
            "SELECT id FROM reading_sync_uploaded WHERE namespace=?1 AND item_key=?2",
            params![d.namespace(), record.key],
            |r| r.get(0),
        )
        .unwrap();
    let body_key = remote.key(&format!("reading/v1/changes/{body_id}.json"));
    let blob_key = remote.key(&format!("reading/media-v1/blobs/{}", storage::hash(&png())));
    let manifest: String = d.c().query_row("SELECT body FROM reading_media_manifests WHERE namespace=?1 AND item_key=?2 ORDER BY url LIMIT 1",params![d.namespace(),record.key],|r|r.get(0)).unwrap();
    let manifest_key = remote.key(&format!(
        "reading/media-v1/manifests/{}.json",
        storage::hash(manifest.as_bytes())
    ));
    let source_key = source_key(&remote, &scope);
    for key in [&body_key, &blob_key, &manifest_key] {
        let original = s.state.lock().unwrap().files.remove(key).unwrap();
        assert!(authorize_remote(&d.db, &remote, &record.key).await.is_err());
        assert_eq!(d.state(&record.key), "partial");
        let verified: usize = d.c().query_row("SELECT json_extract(report,'$.verified') FROM reading_recovery_runs WHERE namespace=?1 AND item_key=?2",params![d.namespace(),record.key],|r|r.get(0)).unwrap();
        assert_eq!(verified, if key == &body_key { 0 } else { 1 });
        assert!(validate_permit(&d.c(), &permit).is_err());
        assert_no_unscoped_delete(&d).await;
        s.state.lock().unwrap().files.insert(key.clone(), original);
    }
    let original = s.state.lock().unwrap().files.remove(&source_key).unwrap();
    s.state.lock().unwrap().deny_put = true;
    assert!(authorize_remote(&d.db, &remote, &record.key).await.is_err());
    assert_eq!(d.state(&record.key), "partial");
    assert_no_unscoped_delete(&d).await;
    s.state.lock().unwrap().deny_put = false;
    s.state
        .lock()
        .unwrap()
        .files
        .insert(source_key.clone(), original.clone());
    // HEAD still advertises the trusted original hash: explicit source GET must catch corruption.
    s.state
        .lock()
        .unwrap()
        .files
        .get_mut(&source_key)
        .unwrap()
        .0[0] ^= 1;
    assert!(authorize_remote(&d.db, &remote, &record.key).await.is_err());
    assert_eq!(d.state(&record.key), "partial");
    assert_no_unscoped_delete(&d).await;
    s.state.lock().unwrap().files.insert(source_key, original);
    s.state.lock().unwrap().corrupt = true;
    assert!(authorize_remote(&d.db, &remote, &record.key).await.is_err());
    assert_eq!(d.state(&record.key), "partial");
    assert_no_unscoped_delete(&d).await;
    s.state.lock().unwrap().corrupt = false;
    let fresh = authorize_remote(&d.db, &remote, &record.key).await.unwrap();
    validate_permit(&d.c(), &fresh).unwrap();
}

#[tokio::test]
async fn source_recovery_skipped_large_original_is_not_complete_cloud_inventory() {
    let s = server().await;
    let remote = store(&s);
    let d = Device::new();
    let task = source(1);
    let mut bytes = png();
    bytes.resize(11 * 1024 * 1024, 0);
    let record = d.import(&task, &[bytes]);
    d.publish(&remote).await;
    assert!(build(&d.c(), &record.key).is_err());
    assert!(authorize_remote(&d.db, &remote, &record.key).await.is_err());
    assert!(!s
        .state
        .lock()
        .unwrap()
        .files
        .keys()
        .any(|key| key.contains("/reading/source-v1/")));
    assert_no_unscoped_delete(&d).await;
}

#[tokio::test]
async fn source_recovery_unknown_children_or_attachment_inventory_stays_preserved() {
    let s = server().await;
    let remote = store(&s);
    let d = Device::new();
    let task = source(0);
    let record = d.import(&task, &[]);
    d.publish(&remote).await;
    for field in [
        "childIds",
        "child_ids",
        "children",
        "childTasks",
        "child_tasks",
        "attachments",
    ] {
        for value in [
            Value::Null,
            json!("unknown"),
            json!({"unknown":true}),
            json!(["unmigrated-child"]),
        ] {
            let mut changed = task.raw.clone();
            if field == "child_ids" {
                changed.as_object_mut().unwrap().remove("childIds");
            }
            changed[field] = value;
            let raw = changed.to_string();
            if field != "attachments" {
                let changed_task = parse(changed.clone());
                let matching = Receipt {
                    snapshot: snapshot(&changed_task),
                    ..record.clone()
                };
                assert!(
                    can_delete(&matching, &changed_task).is_err(),
                    "writer unknown {field}"
                );
            }
            d.c().execute("UPDATE collection_dida_reading SET raw_json=?2,snapshot_hash=?3 WHERE item_key=?1",params![record.key,raw,storage::hash(raw.as_bytes())]).unwrap();
            assert!(build(&d.c(), &record.key).is_err(), "unknown {field}");
            assert!(authorize_remote(&d.db, &remote, &record.key).await.is_err());
            assert_no_unscoped_delete(&d).await;
            d.c().execute("UPDATE collection_dida_reading SET raw_json=?2,snapshot_hash=?3 WHERE item_key=?1",params![record.key,task.raw.to_string(),record.snapshot]).unwrap();
        }
    }
    for conflicting in [Value::Null, json!(["unmigrated-child"])] {
        let mut raw = task.raw.clone();
        raw["child_ids"] = conflicting;
        let raw = raw.to_string();
        d.c()
            .execute(
                "UPDATE collection_dida_reading SET raw_json=?2,snapshot_hash=?3 WHERE item_key=?1",
                params![record.key, raw, storage::hash(raw.as_bytes())],
            )
            .unwrap();
        assert!(
            build(&d.c(), &record.key).is_err(),
            "conflicting child aliases must fail closed"
        );
        assert!(authorize_remote(&d.db, &remote, &record.key).await.is_err());
        assert_no_unscoped_delete(&d).await;
    }
    // Exercise the production recursive parser, rather than only scalar inventory errors.
    // A parent's empty ID list cannot overrule another supported child container.
    for field in ["children", "childTasks", "child_tasks"] {
        let mut changed = task.raw.clone();
        changed[field] = json!([{
            "id":"unmigrated-child", "projectId":"source-project", "title":"子任务原件",
            "content":"未逐项迁移", "tags":["稍后读"], "childIds":[],
            "attachments":[{"id":"0123456789abcdef01234567","name":"child.pdf","fileType":"application/pdf"}]
        }]);
        let mut parsed = Vec::new();
        collect_dida_tasks(&changed, "source-project", &mut parsed);
        assert_eq!(parsed.len(), 2, "formal parser must see {field}");
        let parent = parsed.iter().find(|value| value.id == task.id).unwrap();
        let matching = Receipt {
            snapshot: snapshot(parent),
            ..record.clone()
        };
        assert!(
            can_delete(&matching, parent).is_err(),
            "writer nonempty {field}"
        );
        let raw = changed.to_string();
        d.c()
            .execute(
                "UPDATE collection_dida_reading SET raw_json=?2,snapshot_hash=?3 WHERE item_key=?1",
                params![record.key, raw, storage::hash(raw.as_bytes())],
            )
            .unwrap();
        assert!(
            build(&d.c(), &record.key).is_err(),
            "source receipt nonempty {field}"
        );
        assert!(authorize_remote(&d.db, &remote, &record.key).await.is_err());
        let envelope = Envelope {
            format: "hub-reading-source-receipt".into(),
            version: 1,
            key: record.key.clone(),
            snapshot_hash: storage::hash(raw.as_bytes()),
            post_hash: record.post_hash.clone(),
            source_snapshot: changed,
            originals: Vec::new(),
        };
        assert!(
            migration_inventory(&serde_json::to_vec(&envelope).unwrap()).is_err(),
            "migration nonempty {field}"
        );
        assert_no_unscoped_delete(&d).await;
    }
    let mut empty = task.raw.clone();
    for field in [
        "childIds",
        "child_ids",
        "children",
        "childTasks",
        "child_tasks",
    ] {
        empty[field] = json!([]);
    }
    let empty_task = parse(empty.clone());
    let matching = Receipt {
        snapshot: snapshot(&empty_task),
        ..record.clone()
    };
    can_delete(&matching, &empty_task).unwrap();
    let raw = empty.to_string();
    d.c()
        .execute(
            "UPDATE collection_dida_reading SET raw_json=?2,snapshot_hash=?3 WHERE item_key=?1",
            params![record.key, raw, storage::hash(raw.as_bytes())],
        )
        .unwrap();
    build(&d.c(), &record.key).unwrap();
    empty["data"] = json!([{ "id":"unexpected-second-task", "projectId":"source-project", "title":"第二任务", "content":"不可默默略过", "attachments":[], "childIds":[] }]);
    let mut parsed = Vec::new();
    collect_dida_tasks(&empty, "source-project", &mut parsed);
    assert_eq!(parsed.len(), 2);
    let raw = empty.to_string();
    d.c()
        .execute(
            "UPDATE collection_dida_reading SET raw_json=?2,snapshot_hash=?3 WHERE item_key=?1",
            params![record.key, raw, storage::hash(raw.as_bytes())],
        )
        .unwrap();
    assert!(build(&d.c(), &record.key)
        .err()
        .unwrap()
        .contains("唯一任务"));
}

#[tokio::test]
async fn source_recovery_oversize_raw_source_is_preserved_even_when_readable_body_was_uploaded() {
    let s = server().await;
    let remote = store(&s);
    let d = Device::new();
    let mut raw = source(0).raw;
    raw["largeFutureMetadata"] = json!("x".repeat(2 * 1024 * 1024));
    let task = parse(raw);
    let record = d.import(&task, &[]);
    d.publish(&remote).await;
    assert!(build(&d.c(), &record.key).err().unwrap().contains("2 MB"));
    assert!(authorize_remote(&d.db, &remote, &record.key).await.is_err());
    assert!(!s
        .state
        .lock()
        .unwrap()
        .files
        .keys()
        .any(|key| key.contains("/reading/source-v1/")));
    assert_no_unscoped_delete(&d).await;
}
