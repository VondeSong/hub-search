use super::release_index_claim;
use super::{
    build_and_activate_guarded, claim_index_batch, complete_index_jobs, flush_index_jobs_budgeted,
    open_or_create_active_search_index, IndexRebuildSnapshot, INDEX_JOB_BATCH_SIZE,
};
use crate::{
    blob_store::BlobStore, forget_initialized_database, library_runtime, open_database,
    persist_document_batch, random_url_safe, IndexedDocument,
};
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf, time::Duration};

fn fixture(count: usize) -> (PathBuf, PathBuf, Connection, BlobStore) {
    let root = std::env::temp_dir().join(format!("hub-index-owner-{}", random_url_safe(16)));
    fs::create_dir_all(&root).unwrap();
    let path = root.join("craft-search.sqlite3");
    let c = open_database(&path).unwrap();
    c.execute("INSERT INTO spaces(id,name,mcp_url,added_at) VALUES('scope','Scope','https://example.test',1)", []).unwrap();
    c.execute("INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES('scope','craft','Scope',1,1)", []).unwrap();
    let blobs = BlobStore::open(&root.join("blobs")).unwrap();
    persist_document_batch(
        &path,
        &blobs,
        (0..count)
            .map(|n| {
                let body = format!("boundedrebuild item {n}");
                IndexedDocument {
                    space_id: "scope".into(),
                    id: format!("doc-{n}"),
                    title: format!("Document {n}"),
                    path: "test".into(),
                    folder_id: None,
                    content_hash: format!("{:x}", Sha256::digest(body.as_bytes())),
                    markdown: body,
                    modified_at: Some(1),
                    indexed_at: 1,
                    attachments: vec![],
                    block_hints: vec![],
                }
            })
            .collect(),
    )
    .unwrap();
    (root, path, c, blobs)
}

#[test]
fn commit_recovery_rebuilds_and_publishes_real_pending_content() {
    let (root, path, mut c, blobs) = fixture(3);
    let index_root = root.join("index");
    let snapshot = IndexRebuildSnapshot::open(&c).unwrap();
    let index = snapshot.activate(&mut c, &index_root).unwrap();
    drop(snapshot);
    let old_dir = index.directory().to_path_buf();
    index
        .fail_next_commit
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let replacement =
        flush_index_jobs_budgeted(&path, index.clone(), &index_root, 1, Duration::from_secs(5))
            .unwrap()
            .expect("commit failure must publish replacement");
    assert_ne!(replacement.directory(), old_dir);
    assert!(
        old_dir.join("meta.json").exists(),
        "failed generation must be preserved"
    );
    assert_eq!(
        replacement
            .search(
                "boundedrebuild",
                10,
                None,
                None,
                None,
                true,
                true,
                true,
                true
            )
            .unwrap()
            .len(),
        3
    );
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM index_jobs WHERE status!='completed'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    let diagnostic:String=c.query_row("SELECT last_error FROM search_index_generations WHERE status='retired' AND last_error IS NOT NULL",[],|r|r.get(0)).unwrap();
    assert!(
        diagnostic.contains("commit-recovery-attempted:")
            && diagnostic.contains("PermissionDenied")
            && diagnostic.contains("directory=")
    );
    drop(replacement);
    drop(index);
    drop(blobs);
    drop(c);
    forget_initialized_database(&path);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn commit_recovery_persisted_attempt_prevents_another_generation() {
    let cancelled = super::recovery_failure("original failure", "资料库操作已停止：paused".into());
    assert!(library_runtime::is_control_error(&cancelled));
    let (root, path, mut c, blobs) = fixture(1);
    let index_root = root.join("index");
    let index = open_or_create_active_search_index(&mut c, &index_root).unwrap();
    c.execute("UPDATE search_index_generations SET last_error='commit-recovery-attempted: previous failure' WHERE status='active'",[]).unwrap();
    assert!(super::recover_commit_failure(
        &mut c,
        &index_root,
        &index,
        "无法提交 Tantivy 索引：test"
    )
    .err()
    .unwrap()
    .contains("停止自动重建"));
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM search_index_generations", [], |r| r
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        1
    );
    drop(index);
    drop(blobs);
    drop(c);
    forget_initialized_database(&path);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn commit_recovery_stale_generation_cannot_publish() {
    let (root, path, mut c, blobs) = fixture(1);
    let index_root = root.join("index");
    let initial = open_or_create_active_search_index(&mut c, &index_root).unwrap();
    let old: String = c
        .query_row(
            "SELECT id FROM search_index_generations WHERE status='active'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let mut snapshot = IndexRebuildSnapshot::open(&c).unwrap();
    snapshot.visibility.expected_generation = Some(old);
    let newer = super::create_empty_search_generation(&mut c, &index_root).unwrap();
    assert!(snapshot
        .activate(&mut c, &index_root)
        .err()
        .unwrap()
        .contains("活动代际已改变"));
    let current: String = c
        .query_row(
            "SELECT relative_path FROM search_index_generations WHERE status='active'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(index_root.join(current), newer.directory());
    drop(snapshot);
    drop(newer);
    drop(initial);
    drop(blobs);
    drop(c);
    forget_initialized_database(&path);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn full_rebuild_bounds_job_metadata_and_drains_real_producer_jobs_without_loss() {
    let total = INDEX_JOB_BATCH_SIZE + 3;
    let (root, path, mut c, blobs) = fixture(total);
    let index_root = root.join("index");
    let initial = open_or_create_active_search_index(&mut c, &index_root).unwrap();
    let batch = claim_index_batch(&mut c, true, "bounded-rebuild").unwrap();
    assert!(batch.rebuild && batch.records.is_empty());
    assert_eq!(batch.job_ids.len(), INDEX_JOB_BATCH_SIZE);
    assert_eq!(batch.job_spaces.len(), INDEX_JOB_BATCH_SIZE);
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM index_jobs WHERE status='pending' AND job_type='upsert_lexical'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        3
    );
    let rebuilt = batch
        .rebuild_snapshot
        .as_ref()
        .unwrap()
        .activate(&mut c, &index_root)
        .unwrap();
    assert_eq!(rebuilt.num_docs(), total as u64);
    complete_index_jobs(&c, &batch.job_ids, "bounded-rebuild").unwrap();
    drop(batch);
    flush_index_jobs_budgeted(
        &path,
        rebuilt.clone(),
        &index_root,
        2,
        Duration::from_secs(30),
    )
    .unwrap();
    assert_eq!(c.query_row("SELECT COUNT(*) FROM index_jobs WHERE job_type='upsert_lexical' AND status='completed'", [], |r| r.get::<_,i64>(0)).unwrap(),total as i64);
    assert_eq!(rebuilt.num_docs(), total as u64);
    drop(rebuilt);
    drop(initial);
    drop(blobs);
    drop(c);
    forget_initialized_database(&path);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn stale_generation_cannot_replace_active_index_after_control_or_membership_changes() {
    for action in ["remove", "pause-resume", "disable"] {
        let (root, path, mut c, blobs) = fixture(1);
        let index_root = root.join("index");
        let initial = open_or_create_active_search_index(&mut c, &index_root).unwrap();
        let active: String = c
            .query_row(
                "SELECT id FROM search_index_generations WHERE status='active'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let snapshot = IndexRebuildSnapshot::open(&c).unwrap();
        let result =
            build_and_activate_guarded(&mut c, &index_root, &snapshot.visibility, |index| {
                let count = snapshot.rebuild(index)?;
                match action {
                    "remove" => {
                        library_runtime::control(&root, "scope", "remove")?;
                    }
                    "pause-resume" => {
                        library_runtime::control(&root, "scope", "pause")?;
                        library_runtime::control(&root, "scope", "resume")?;
                    }
                    _ => {
                        let change = open_database(&path)?;
                        change
                            .execute("UPDATE libraries SET enabled=0 WHERE id='scope'", [])
                            .map_err(|e| e.to_string())?;
                    }
                }
                Ok(count)
            });
        assert!(
            result
                .as_ref()
                .is_err_and(|e| library_runtime::is_control_error(e)),
            "{action}"
        );
        assert_eq!(
            c.query_row(
                "SELECT id FROM search_index_generations WHERE status='active'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            active
        );
        assert_eq!(
            c.query_row(
                "SELECT COUNT(*) FROM search_index_generations WHERE status='failed' AND id<>?1",
                params![active],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        drop(snapshot);
        drop(initial);
        drop(blobs);
        drop(c);
        forget_initialized_database(&path);
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn already_paused_library_cache_remains_searchable_in_a_valid_rebuild() {
    let (root, path, mut c, blobs) = fixture(1);
    library_runtime::control(&root, "scope", "pause").unwrap();
    let snapshot = IndexRebuildSnapshot::open(&c).unwrap();
    let rebuilt = snapshot.activate(&mut c, &root.join("index")).unwrap();
    assert_eq!(rebuilt.num_docs(), 1);
    assert_eq!(
        rebuilt
            .search(
                "boundedrebuild",
                10,
                None,
                None,
                None,
                true,
                true,
                true,
                true
            )
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        library_runtime::status(&root, "scope").unwrap().state,
        "paused"
    );
    drop(rebuilt);
    drop(snapshot);
    drop(blobs);
    drop(c);
    forget_initialized_database(&path);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn cancelling_index_claim_preserves_later_producer_and_retry_budget() {
    let (root, path, mut c, blobs) = fixture(1);
    let batch = claim_index_batch(&mut c, false, "old-claim").unwrap();
    assert_eq!(batch.job_ids.len(), 1);
    // A real later document producer owns the same persistent job identity.
    let body = "later committed text";
    persist_document_batch(
        &path,
        &blobs,
        vec![IndexedDocument {
            space_id: "scope".into(),
            id: "doc-0".into(),
            title: "New".into(),
            path: "test".into(),
            folder_id: None,
            markdown: body.into(),
            content_hash: format!("{:x}", Sha256::digest(body.as_bytes())),
            modified_at: Some(2),
            indexed_at: 2,
            attachments: vec![],
            block_hints: vec![],
        }],
    )
    .unwrap();
    let before: (String, i64, Option<String>) = c
        .query_row(
            "SELECT status,attempts,worker_id FROM index_jobs WHERE id=?1",
            params![batch.job_ids[0]],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    release_index_claim(&c, &batch.job_ids, "old-claim").unwrap();
    let after: (String, i64, Option<String>) = c
        .query_row(
            "SELECT status,attempts,worker_id FROM index_jobs WHERE id=?1",
            params![batch.job_ids[0]],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(before, after);
    assert_eq!(after.0, "pending");
    drop(batch);
    let new = claim_index_batch(&mut c, false, "new-claim").unwrap();
    assert_eq!(new.records[0].body, body);
    library_runtime::control(&root, "scope", "pause").unwrap();
    release_index_claim(&c, &new.job_ids, "new-claim").unwrap();
    assert_eq!(
        c.query_row(
            "SELECT attempts FROM index_jobs WHERE id=?1",
            params![new.job_ids[0]],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    drop(new);
    drop(blobs);
    drop(c);
    forget_initialized_database(&path);
    fs::remove_dir_all(root).unwrap();
}
