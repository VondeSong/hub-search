use super::*;

const CACHED_BYTES: &[u8] = b"verified attachment bytes";

struct Fixture {
    root: PathBuf,
    database: PathBuf,
    store: BlobStore,
    hash: String,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hub-download-cache-integrity-{}",
            random_url_safe(16)
        ));
        fs::create_dir_all(&root).unwrap();
        let database = root.join("craft-search.sqlite3");
        let store = BlobStore::open(&root.join("blobs")).unwrap();
        let connection = open_database(&database).unwrap();
        connection
            .execute(
                "INSERT INTO libraries(id,provider,name,enabled,added_at)
             VALUES('library','craft','Fixture',1,1)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO source_items(id,space_id,document_id,remote_id,source_type,
             title,mime_type,status,metadata_json,provider,created_at,updated_at)
             VALUES('source','library','doc','resource','craft_attachment',
             'Fixture','image/png','discovered',?1,'craft',1,1)",
                [json!({"remoteUrl":"https://r.craft.do/fixture",
                "linkKind":"image", "size":CACHED_BYTES.len(),
                "resourceGeneration":0})
                .to_string()],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO index_jobs(job_key,space_id,source_id,source_type,job_type,
             status,created_at,updated_at,provider) VALUES('download:source','library',
             'source','craft_attachment','download_source','pending',1,1,'craft')",
                [],
            )
            .unwrap();
        drop(connection);
        let job = claim_enabled_attachment_jobs(&database, "download_source", 1)
            .unwrap()
            .remove(0);
        let blob = store.put(CACHED_BYTES).unwrap();
        let hash = blob.hash.clone();
        persist_download_success(
            &database,
            &job,
            DownloadedSource {
                blob,
                mime_type: "image/png".into(),
            },
        )
        .unwrap();
        Self {
            root,
            database,
            store,
            hash,
        }
    }

    fn queued_operation(&self) -> (PipelineJob, library_runtime::Operation) {
        // Model queued work revisiting a cache that the production commit saved.
        open_database(&self.database)
            .unwrap()
            .execute(
                "UPDATE index_jobs SET status='pending',next_attempt_at=0,
             worker_id=NULL,locked_at=NULL,lease_until=NULL
             WHERE job_key='download:source'",
                [],
            )
            .unwrap();
        let job = claim_enabled_attachment_jobs(&self.database, "download_source", 1)
            .unwrap()
            .remove(0);
        let operation = begin_pipeline_operation(&self.database, &job, "download_source").unwrap();
        (job, operation)
    }

    fn cache_state(&self) -> (Option<String>, Option<String>, String) {
        open_database(&self.database)
            .unwrap()
            .query_row(
                "SELECT blob_hash,content_hash,status FROM source_items WHERE id='source'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap()
    }

    fn assert_released(&self, job: &PipelineJob, operation: &library_runtime::Operation) {
        assert!(attachment_download_cache::verified_source(
            &self.database,
            &self.store,
            job,
            operation,
        )
        .unwrap()
        .is_none());
        assert_eq!(self.cache_state(), (None, None, "discovered".into()));
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        forget_initialized_database(&self.database);
        fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn craft_attachment_cache_missing_file_releases_invalid_source_association() {
    let fixture = Fixture::new();
    fs::remove_file(fixture.store.local_path_for(&fixture.hash).unwrap()).unwrap();
    let (job, operation) = fixture.queued_operation();
    fixture.assert_released(&job, &operation);
}

#[test]
fn craft_attachment_cache_same_size_corruption_releases_invalid_source_association() {
    let fixture = Fixture::new();
    fs::write(
        fixture.store.local_path_for(&fixture.hash).unwrap(),
        vec![b'x'; CACHED_BYTES.len()],
    )
    .unwrap();
    let (job, operation) = fixture.queued_operation();
    fixture.assert_released(&job, &operation);
}

#[test]
fn craft_attachment_cache_declared_size_conflict_releases_invalid_source_association() {
    let fixture = Fixture::new();
    open_database(&fixture.database)
        .unwrap()
        .execute(
            "UPDATE source_items SET metadata_json=json_set(metadata_json,'$.size',?1)
         WHERE id='source'",
            [(CACHED_BYTES.len() + 1) as i64],
        )
        .unwrap();
    let (job, operation) = fixture.queued_operation();
    fixture.assert_released(&job, &operation);
}

#[test]
fn craft_attachment_cache_verified_bytes_do_not_need_a_resolvable_remote_url() {
    let fixture = Fixture::new();
    open_database(&fixture.database)
        .unwrap()
        .execute(
            "UPDATE source_items SET metadata_json=json_set(metadata_json,'$.remoteUrl',
         'invalid://must-not-be-requested') WHERE id='source'",
            [],
        )
        .unwrap();
    let before = fixture.cache_state();
    let (job, operation) = fixture.queued_operation();
    let (cached, generation) = attachment_download_cache::verified_source(
        &fixture.database,
        &fixture.store,
        &job,
        &operation,
    )
    .unwrap()
    .expect("verified local bytes must be reusable without URL resolution");
    assert_eq!(cached.blob.hash, fixture.hash);
    assert_eq!(cached.blob.size, CACHED_BYTES.len() as u64);
    assert_eq!(fixture.store.read(&cached.blob.hash).unwrap(), CACHED_BYTES);
    assert_eq!(generation, Some(0));
    assert_eq!(fixture.cache_state(), before);
}

#[test]
fn craft_attachment_cache_pause_or_cancel_preserves_source_association() {
    for control in ["pause", "cancel"] {
        let fixture = Fixture::new();
        let (job, operation) = fixture.queued_operation();
        let before = fixture.cache_state();
        fs::remove_file(fixture.store.local_path_for(&fixture.hash).unwrap()).unwrap();
        library_runtime::control(&fixture.root, "library", control).unwrap();
        let error = attachment_download_cache::verified_source(
            &fixture.database,
            &fixture.store,
            &job,
            &operation,
        )
        .err()
        .expect("control must stop cache cleanup");
        assert!(
            library_runtime::is_control_error(&error),
            "{control}: {error}"
        );
        assert_eq!(
            fixture.cache_state(),
            before,
            "{control} must not clear the interrupted source's blob association"
        );
    }
}
