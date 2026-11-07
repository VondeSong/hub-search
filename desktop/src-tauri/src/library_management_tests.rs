use super::*;

fn fixture() -> (PathBuf, PathBuf, Connection) {
    let root = std::env::temp_dir().join(format!("hub-library-management-{}", random_url_safe(16)));
    fs::create_dir_all(&root).unwrap();
    let path = root.join("craft-search.sqlite3");
    let c = open_database(&path).unwrap();
    for id in ["paused", "live"] {
        c.execute("INSERT INTO spaces(id,name,mcp_url,added_at) VALUES(?1,?1,'https://example.test/mcp',1)",[id]).unwrap();
        c.execute(
            "INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES(?1,'craft',?1,1,1)",
            [id],
        )
        .unwrap();
        c.execute("INSERT INTO documents(space_id,id,title,path,markdown,indexed_at,content_hash) VALUES(?1,'doc','title','path','source text',1,'hash')",[id]).unwrap();
        c.execute("INSERT INTO content_items(id,space_id,document_id,block_id,content_type,heading,body,ordinal,source_hash) VALUES(?1||':0',?1,'doc','doc','markdown_section','heading','source text',0,'hash')",[id]).unwrap();
        c.execute("INSERT INTO index_jobs(job_key,space_id,source_id,source_type,job_type,status,priority,created_at,updated_at) VALUES(?1||':job',?1,'doc','document','upsert_lexical','pending',?2,1,1)",params![id,if id=="paused" {100} else {1}]).unwrap();
    }
    (root, path, c)
}

#[test]
fn library_management_paused_index_jobs_do_not_consume_attempts_or_block_another_library() {
    let (root, _, mut c) = fixture();
    let old = library_runtime::begin(&root, "paused", "in progress").unwrap();
    library_runtime::control(&root, "paused", "pause").unwrap();
    assert_eq!(
        library_runtime::status(&root, "paused").unwrap().state,
        "pausing"
    );
    let batch = claim_index_batch(&mut c, false, "fixture-worker").unwrap();
    assert_eq!(batch.job_spaces, vec![(batch.job_ids[0], "live".into())]);
    assert!(batch.records.iter().all(|record| record.space_id == "live"));
    let (state, attempts): (String, i64) = c
        .query_row(
            "SELECT status,attempts FROM index_jobs WHERE space_id='paused'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!((state.as_str(), attempts), ("pending", 0));
    complete_index_jobs(&c, &batch.job_ids, "fixture-worker").unwrap();
    library_runtime::control(&root, "paused", "resume").unwrap();
    assert!(old.checkpoint().is_err());
    let resumed = claim_index_batch(&mut c, false, "resumed-worker").unwrap();
    assert_eq!(resumed.records.len(), 1);
    assert_eq!(resumed.records[0].space_id, "paused");
    drop(old);
    drop(c);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn library_management_removed_cache_is_preserved_but_cannot_rebuild_search_records() {
    let (root, _, mut c) = fixture();
    let original = root.join("original.md");
    fs::write(&original, "original").unwrap();
    library_runtime::control(&root, "paused", "remove").unwrap();
    // The persisted barrier hides it even before background database cleanup finishes.
    let records = collect_index_records(&c, None).unwrap();
    assert!(!records.is_empty());
    assert!(records.iter().all(|record| record.space_id == "live"));
    c.execute("UPDATE libraries SET enabled=0 WHERE id='paused'", [])
        .unwrap();
    assert!(collect_index_records(&c, None)
        .unwrap()
        .iter()
        .all(|record| record.space_id == "live"));
    let cached: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM documents WHERE space_id='paused'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(cached, 1);
    assert_eq!(fs::read_to_string(original).unwrap(), "original");
    library_runtime::control(&root, "live", "remove").unwrap();
    let empty = claim_index_batch(&mut c, true, "removed-only").unwrap();
    assert!(empty.records.is_empty());
    assert!(
        !empty.rebuild,
        "removed cache must not trigger an endless empty rebuild"
    );
    drop(c);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn library_management_paused_body_backfill_resumes_without_losing_cached_documents() {
    let (root, path, c) = fixture();
    drop(c);
    let store = BlobStore::open(&root.join("blobs")).unwrap();
    library_runtime::control(&root, "paused", "pause").unwrap();
    assert_eq!(backfill_document_blobs(&path, &store, 1).unwrap(), 1);
    let c = open_database(&path).unwrap();
    let (paused,live):(Option<String>,Option<String>)=c.query_row("SELECT (SELECT blob_hash FROM documents WHERE space_id='paused'),(SELECT blob_hash FROM documents WHERE space_id='live')",[],|row|Ok((row.get(0)?,row.get(1)?))).unwrap();
    assert!(paused.is_none());
    assert!(live.is_some());
    drop(c);
    library_runtime::control(&root, "paused", "resume").unwrap();
    assert_eq!(backfill_document_blobs(&path, &store, 1).unwrap(), 1);
    assert_eq!(backfill_document_blobs(&path, &store, 1).unwrap(), 0);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn library_management_default_obsidian_uses_registered_library_pause() {
    let (root, _, c) = fixture();
    let vault = root.join("vault");
    fs::create_dir_all(&vault).unwrap();
    c.execute("INSERT INTO libraries(id,provider,name,location,enabled,added_at) VALUES('vault','obsidian','Vault',?1,1,1)",[vault.to_string_lossy().as_ref()]).unwrap();
    let default_config=json!({"mode":"obsidian","vaultPath":vault.to_string_lossy(),"downloadMedia":true,"autoSyncMinutes":30}).to_string();
    c.execute(
        "INSERT INTO metadata(key,value) VALUES('collection_storage_v1',?1)",
        [&default_config],
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(x_bookmarks::storage::config(&c).unwrap()).unwrap()["vaultPath"],
        vault.to_string_lossy().as_ref()
    );
    assert_eq!(
        library_runtime::obsidian_gate(&root, &vault).unwrap(),
        Some("vault".into())
    );
    library_runtime::control(&root, "vault", "pause").unwrap();
    assert!(library_runtime::obsidian_gate(&root, &vault).is_err());
    library_runtime::control(&root, "vault", "resume").unwrap();
    assert!(library_runtime::obsidian_gate(&root, &vault).is_ok());
    library_runtime::control(&root, "vault", "remove").unwrap();
    assert_eq!(metadata_string(&c, "collection_storage_v1"), default_config);
    drop(c);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn library_management_paused_attachment_discovery_does_not_starve_active_library() {
    let (root, path, c) = fixture();
    c.execute(
        "UPDATE documents SET markdown='![image](https://example.test/image.jpg)'",
        [],
    )
    .unwrap();
    drop(c);
    library_runtime::control(&root, "paused", "pause").unwrap();
    assert_eq!(backfill_attachment_discovery(&path, 1).unwrap(), 1);
    let c = open_database(&path).unwrap();
    let (paused,live):(Option<String>,Option<String>)=c.query_row("SELECT (SELECT attachment_scan_hash FROM documents WHERE space_id='paused'),(SELECT attachment_scan_hash FROM documents WHERE space_id='live')",[],|row|Ok((row.get(0)?,row.get(1)?))).unwrap();
    assert!(paused.is_none());
    assert_eq!(live.as_deref(), Some("hash"));
    drop(c);
    library_runtime::control(&root, "paused", "resume").unwrap();
    assert_eq!(backfill_attachment_discovery(&path, 1).unwrap(), 1);
    assert_eq!(backfill_attachment_discovery(&path, 1).unwrap(), 0);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn library_management_index_claim_keeps_original_epoch_until_completion() {
    let (root, _, mut c) = fixture();
    library_runtime::control(&root, "paused", "pause").unwrap();
    let batch = claim_index_batch(&mut c, false, "accepted-worker").unwrap();
    library_runtime::control(&root, "live", "pause").unwrap();
    library_runtime::control(&root, "live", "resume").unwrap();
    let result = batch.operations["live"]
        .commit(|| complete_index_jobs(&c, &batch.job_ids, "accepted-worker"));
    assert!(library_runtime::is_control_error(&result.unwrap_err()));
    let state: String = c
        .query_row(
            "SELECT status FROM index_jobs WHERE space_id='live'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        state, "running",
        "old worker must not mark its result complete after pause/resume"
    );
    drop(batch);
    drop(c);
    fs::remove_dir_all(root).unwrap();
}
