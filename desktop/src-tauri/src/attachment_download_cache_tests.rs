use super::*;

#[tokio::test]
async fn craft_attachment_cache_download_worker_reuses_verified_blob_before_url_resolution() {
    let root = std::env::temp_dir().join(format!("hub-download-cache-{}", random_url_safe(16)));
    fs::create_dir_all(&root).unwrap();
    let path = root.join("craft-search.sqlite3");
    let store = BlobStore::open(&root.join("blobs")).unwrap();
    let blob = store.put(b"already downloaded attachment").unwrap();
    {
        let c = open_database(&path).unwrap();
        c.execute("INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES('library','craft','Library',1,1)", []).unwrap();
        c.execute("INSERT INTO blobs(hash,size,mime_type,relative_path,created_at,verified_at) VALUES(?1,?2,'image/png',?3,1,1)", params![blob.hash,blob.size,blob.relative_path]).unwrap();
        // An invalid network address ensures a regression fails locally before
        // opening a connection, rather than spending real Craft/VPS traffic.
        c.execute("INSERT INTO source_items(id,space_id,document_id,remote_id,source_type,title,mime_type,status,blob_hash,metadata_json,provider,created_at,updated_at) VALUES('source','library','doc','resource','craft_attachment','Image','image/png','ready',?1,?2,'craft',1,1)", params![blob.hash,json!({"remoteUrl":"http://127.0.0.1:1/must-not-be-requested","size":blob.size,"resourceGeneration":0}).to_string()]).unwrap();
        c.execute("INSERT INTO index_jobs(job_key,space_id,source_id,source_type,job_type,status,created_at,updated_at,provider) VALUES('download:source','library','source','craft_attachment','download_source','pending',1,1,'craft')", []).unwrap();
    }
    let result = process_download_jobs(&path, &store, 1, None).await;
    let c = open_database(&path).unwrap();
    let (status,error,source_status):(String,Option<String>,String) = c.query_row("SELECT j.status,j.last_error,s.status FROM index_jobs j JOIN source_items s ON s.id=j.source_id WHERE j.job_key='download:source'",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
    drop(c);
    forget_initialized_database(&path);
    fs::remove_dir_all(&root).unwrap();
    assert_eq!(result.unwrap(), 1);
    assert_eq!(status, "completed");
    assert_eq!(
        error, None,
        "a valid cache must finish without resolving or requesting the remote URL"
    );
    assert_eq!(source_status, "ready");
}
