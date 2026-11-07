use super::*;

struct Fixture {
    root: PathBuf,
    database: PathBuf,
    store: BlobStore,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hub-craft-attachment-cache-{}",
            random_url_safe(16)
        ));
        fs::create_dir_all(&root).unwrap();
        let database = root.join("craft-search.sqlite3");
        let connection = open_database(&database).unwrap();
        connection.execute("INSERT INTO spaces(id,name,mcp_url,added_at) VALUES('space','Space','https://example.test/mcp',1)", []).unwrap();
        connection.execute("INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES('space','craft','Space',1,1)", []).unwrap();
        let store = BlobStore::open(&root.join("blobs")).unwrap();
        Self {
            root,
            database,
            store,
        }
    }

    fn persist(&self, document: IndexedDocument) {
        persist_document_batch(&self.database, &self.store, vec![document]).unwrap();
    }

    fn refresh(&self, document: &IndexedDocument) {
        persist_attachment_refresh_batch(&self.database, std::slice::from_ref(document)).unwrap();
    }

    fn source(&self) -> (String, String, Option<String>, String) {
        open_database(&self.database).unwrap().query_row(
            "SELECT id,remote_id,blob_hash,metadata_json FROM source_items WHERE space_id='space' AND document_id='doc' AND source_type='craft_attachment'",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        ).unwrap()
    }

    fn cache(&self) -> String {
        let job = claim_enabled_attachment_jobs(&self.database, "download_source", 1)
            .unwrap()
            .into_iter()
            .next()
            .expect("discovery must enqueue a download");
        let blob = self.store.put(b"test").unwrap();
        let hash = blob.hash.clone();
        persist_download_success(
            &self.database,
            &job,
            DownloadedSource {
                blob,
                mime_type: "image/png".into(),
            },
        )
        .unwrap();
        hash
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        forget_initialized_database(&self.database);
        fs::remove_dir_all(&self.root).unwrap();
    }
}

fn document(url: &str, exact: bool, revision: Option<&str>) -> IndexedDocument {
    let markdown = format!("![image.png]({url})");
    let attachments = if exact {
        discover_attachments_from_json(&json!({
            "id": "image-block", "type": "image", "url": url,
            "fileName": "image.png", "fileSize": 4,
            "metadata": { "lastModifiedAt": revision }
        }))
    } else {
        discover_attachments(&markdown)
    };
    IndexedDocument {
        space_id: "space".into(),
        id: "doc".into(),
        title: "Document".into(),
        path: "Document".into(),
        folder_id: None,
        content_hash: format!("{:x}", Sha256::digest(markdown.as_bytes())),
        markdown,
        modified_at: Some(10),
        indexed_at: now_timestamp(),
        attachments,
        block_hints: Vec::new(),
    }
}

#[test]
fn craft_attachment_cache_scan_marker_tracks_current_generation() {
    let fixture = Fixture::new();
    fixture.persist(document("https://r.craft.do/original", true, None));
    let (hash, scan): (String, Option<String>) = open_database(&fixture.database).unwrap()
        .query_row("SELECT content_hash,attachment_scan_hash FROM documents WHERE space_id='space' AND id='doc'", [], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
    assert_eq!(
        scan.as_deref(),
        Some(hash.as_str()),
        "fresh structured discovery must mark this exact document generation"
    );
    assert_eq!(
        backfill_attachment_discovery(&fixture.database, 50).unwrap(),
        0
    );
    assert!(fixture.source().1.contains(":block:image-block"));
    fixture.persist(document("https://r.craft.do/changed", true, None));
    assert_eq!(
        backfill_attachment_discovery(&fixture.database, 50).unwrap(),
        0,
        "changed documents must not be rediscovered as less precise Markdown sources"
    );
}

#[test]
fn craft_attachment_cache_legacy_url_promotes_without_losing_cache_or_relations() {
    let fixture = Fixture::new();
    fixture.persist(document("https://r.craft.do/original", false, None));
    let hash = fixture.cache();
    let original = fixture.source();
    let before: (i64, i64, i64) = open_database(&fixture.database).unwrap().query_row(
        "SELECT (SELECT COUNT(*) FROM extractions WHERE source_item_id=?1),(SELECT COUNT(*) FROM ocr_pages WHERE source_item_id=?1),(SELECT COUNT(*) FROM index_jobs WHERE source_id=?1)",
        [&original.0], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    ).unwrap();
    assert!(before.0 > 0 && before.1 > 0 && before.2 > 0);
    fixture.refresh(&document(
        "https://r.craft.do/original",
        true,
        Some("2026-10-13T12:00:00Z"),
    ));
    let promoted = fixture.source();
    assert_eq!(
        promoted.0, original.0,
        "identity promotion must preserve source references and in-flight workers"
    );
    assert!(promoted.1.contains(":block:image-block"));
    assert_eq!(promoted.2.as_deref(), Some(hash.as_str()));
    let after: (i64, i64, i64) = open_database(&fixture.database).unwrap().query_row(
        "SELECT (SELECT COUNT(*) FROM extractions WHERE source_item_id=?1),(SELECT COUNT(*) FROM ocr_pages WHERE source_item_id=?1),(SELECT COUNT(*) FROM index_jobs WHERE source_id=?1)",
        [&promoted.0], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    ).unwrap();
    assert_eq!(after, before);
    assert!(
        claim_enabled_attachment_jobs(&fixture.database, "download_source", 10)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn craft_attachment_cache_markdown_fallback_does_not_downgrade_exact_identity() {
    let fixture = Fixture::new();
    fixture.persist(document(
        "https://r.craft.do/original",
        true,
        Some("2026-10-13T12:00:00Z"),
    ));
    let hash = fixture.cache();
    let original = fixture.source();
    fixture.refresh(&document("https://r.craft.do/original", false, None));
    let fallback = fixture.source();
    assert_eq!(fallback.0, original.0);
    assert_eq!(fallback.1, original.1);
    assert_eq!(fallback.2.as_deref(), Some(hash.as_str()));
    let metadata: Value = serde_json::from_str(&fallback.3).unwrap();
    assert_eq!(metadata["discoveryVersion"], 2);
    assert!(
        claim_enabled_attachment_jobs(&fixture.database, "download_source", 10)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn craft_attachment_cache_rescan_preserves_running_download_owner() {
    let fixture = Fixture::new();
    let first = document("https://r.craft.do/original", true, None);
    fixture.persist(document("https://r.craft.do/original", true, None));
    let job = claim_enabled_attachment_jobs(&fixture.database, "download_source", 1)
        .unwrap()
        .remove(0);
    let before: (String, i64, Option<String>, Option<i64>, Option<i64>) = open_database(
        &fixture.database,
    )
    .unwrap()
    .query_row(
        "SELECT status,attempts,worker_id,locked_at,lease_until FROM index_jobs WHERE id=?1",
        [job.id],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        },
    )
    .unwrap();
    fixture.refresh(&first);
    let after: (String, i64, Option<String>, Option<i64>, Option<i64>) = open_database(
        &fixture.database,
    )
    .unwrap()
    .query_row(
        "SELECT status,attempts,worker_id,locked_at,lease_until FROM index_jobs WHERE id=?1",
        [job.id],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        },
    )
    .unwrap();
    assert_eq!(after, before);
    assert!(
        claim_enabled_attachment_jobs(&fixture.database, "download_source", 10)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn craft_attachment_cache_rescan_preserves_retry_backoff() {
    let fixture = Fixture::new();
    let first = document("https://r.craft.do/original", true, None);
    fixture.persist(document("https://r.craft.do/original", true, None));
    let job = claim_enabled_attachment_jobs(&fixture.database, "download_source", 1)
        .unwrap()
        .remove(0);
    fail_pipeline_job(
        &fixture.database,
        &job,
        "transient connection failure",
        false,
    )
    .unwrap();
    let before: (String, i64, i64, Option<String>) = open_database(&fixture.database)
        .unwrap()
        .query_row(
            "SELECT status,attempts,next_attempt_at,last_error FROM index_jobs WHERE id=?1",
            [job.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    fixture.refresh(&first);
    let after: (String, i64, i64, Option<String>) = open_database(&fixture.database)
        .unwrap()
        .query_row(
            "SELECT status,attempts,next_attempt_at,last_error FROM index_jobs WHERE id=?1",
            [job.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(after, before);
    assert!(
        claim_enabled_attachment_jobs(&fixture.database, "download_source", 10)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn craft_attachment_cache_same_block_same_size_replacement_invalidates_cache() {
    let fixture = Fixture::new();
    fixture.persist(document("https://r.craft.do/original", true, None));
    fixture.cache();
    let original_id = fixture.source().0;
    fixture.refresh(&document("https://r.craft.do/replacement", true, None));
    let replaced = fixture.source();
    assert_eq!(replaced.0, original_id);
    assert!(
        replaced.2.is_none(),
        "same block and size do not prove unchanged attachment bytes"
    );
    let connection = open_database(&fixture.database).unwrap();
    let derived: i64 = connection.query_row(
        "SELECT (SELECT COUNT(*) FROM extractions WHERE source_item_id=?1)+(SELECT COUNT(*) FROM ocr_pages WHERE source_item_id=?1)",
        [&replaced.0], |row| row.get(0)
    ).unwrap();
    assert_eq!(
        derived, 0,
        "replacement cannot retain previous image OCR or extraction state"
    );
    assert_eq!(
        claim_enabled_attachment_jobs(&fixture.database, "download_source", 10)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn craft_attachment_cache_same_revision_url_rotation_reuses_original() {
    let fixture = Fixture::new();
    fixture.persist(document(
        "https://r.craft.do/original",
        true,
        Some("revision-1"),
    ));
    let hash = fixture.cache();
    let original = fixture.source();
    fixture.refresh(&document(
        "https://r.craft.do/rotated-address",
        true,
        Some("revision-1"),
    ));
    let rotated = fixture.source();
    assert_eq!(rotated.0, original.0);
    assert_eq!(rotated.2.as_deref(), Some(hash.as_str()));
    let metadata: Value = serde_json::from_str(&rotated.3).unwrap();
    assert_eq!(metadata["resourceGeneration"], 0);
    assert_eq!(metadata["remoteUrl"], "https://r.craft.do/rotated-address");
    assert!(
        claim_enabled_attachment_jobs(&fixture.database, "download_source", 10)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn craft_attachment_cache_changed_revision_same_url_and_size_invalidates_original() {
    let fixture = Fixture::new();
    fixture.persist(document(
        "https://r.craft.do/original",
        true,
        Some("revision-1"),
    ));
    fixture.cache();
    let original = fixture.source();
    fixture.refresh(&document(
        "https://r.craft.do/original",
        true,
        Some("revision-2"),
    ));
    let replaced = fixture.source();
    assert_eq!(replaced.0, original.0);
    assert!(replaced.2.is_none());
    let metadata: Value = serde_json::from_str(&replaced.3).unwrap();
    assert_eq!(metadata["resourceGeneration"], 1);
    assert_eq!(metadata["resourceRevision"], "revision-2");
    assert_eq!(
        claim_enabled_attachment_jobs(&fixture.database, "download_source", 10)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn craft_attachment_cache_signed_query_rotation_without_revision_reuses_original() {
    let fixture = Fixture::new();
    fixture.persist(document(
        "https://r.craft.do/original?Signature=old&Expires=100&version=1",
        true,
        None,
    ));
    let hash = fixture.cache();
    fixture.refresh(&document(
        "https://r.craft.do/original?version=1&Expires=200&Signature=new",
        true,
        None,
    ));
    let rotated = fixture.source();
    assert_eq!(rotated.2.as_deref(), Some(hash.as_str()));
    assert_eq!(
        serde_json::from_str::<Value>(&rotated.3).unwrap()["resourceGeneration"],
        0
    );
    assert!(
        claim_enabled_attachment_jobs(&fixture.database, "download_source", 10)
            .unwrap()
            .is_empty()
    );
    fixture.refresh(&document(
        "https://r.craft.do/original?version=2&Expires=200&Signature=new",
        true,
        None,
    ));
    assert!(
        fixture.source().2.is_none(),
        "semantic query changes must not be stripped as authentication"
    );
}

#[test]
fn craft_attachment_cache_renewed_terminal_address_retries_without_changing_generation() {
    let fixture = Fixture::new();
    fixture.persist(document(
        "https://r.craft.do/original?Signature=old&Expires=100",
        true,
        None,
    ));
    let job = claim_enabled_attachment_jobs(&fixture.database, "download_source", 1)
        .unwrap()
        .remove(0);
    fail_pipeline_job(&fixture.database, &job, "HTTP_STATUS:404", true).unwrap();
    fixture.refresh(&document(
        "https://r.craft.do/original?Signature=new&Expires=200",
        true,
        None,
    ));
    let renewed = fixture.source();
    assert_eq!(
        serde_json::from_str::<Value>(&renewed.3).unwrap()["resourceGeneration"],
        0
    );
    let retried = claim_enabled_attachment_jobs(&fixture.database, "download_source", 10).unwrap();
    assert_eq!(retried.len(), 1);
    assert_eq!(retried[0].id, job.id);
}

#[test]
fn craft_attachment_cache_url_only_signed_rotation_keeps_cached_source() {
    let fixture = Fixture::new();
    fixture.persist(document(
        "https://r.craft.do/original?Signature=old&Expires=100",
        false,
        None,
    ));
    let hash = fixture.cache();
    let original = fixture.source();
    fixture.refresh(&document(
        "https://r.craft.do/original?Expires=200&Signature=new",
        false,
        None,
    ));
    let rotated = fixture.source();
    assert_eq!(rotated.0, original.0);
    assert_eq!(rotated.2.as_deref(), Some(hash.as_str()));
    assert!(
        claim_enabled_attachment_jobs(&fixture.database, "download_source", 10)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn craft_attachment_cache_distinct_blocks_keep_independent_sources_for_shared_file() {
    let fixture = Fixture::new();
    let mut shared = document("https://r.craft.do/original", true, Some("revision-1"));
    shared.attachments = discover_attachments_from_json(&json!({ "blocks": [
        { "id": "image-one", "type": "image", "url": "https://r.craft.do/original", "fileName": "image.png", "fileSize": 4, "metadata": { "lastModifiedAt": "revision-1" } },
        { "id": "image-two", "type": "image", "url": "https://r.craft.do/original", "fileName": "image.png", "fileSize": 4, "metadata": { "lastModifiedAt": "revision-1" } }
    ] }));
    fixture.persist(shared);
    let connection = open_database(&fixture.database).unwrap();
    let sources: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM source_items WHERE source_type='craft_attachment'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        sources, 2,
        "distinct blocks are separate sources even when embedding identical bytes"
    );
    drop(connection);
    let first_hash = fixture.cache();
    assert_eq!(fixture.cache(), first_hash);
    fixture.refresh(&document("https://r.craft.do/original", false, None));
    let connection = open_database(&fixture.database).unwrap();
    let (sources, distinct_blobs): (i64, i64) = connection.query_row(
        "SELECT COUNT(*),COUNT(DISTINCT blob_hash) FROM source_items WHERE source_type='craft_attachment'",
        [], |row| Ok((row.get(0)?, row.get(1)?))
    ).unwrap();
    assert_eq!(
        (sources, distinct_blobs),
        (2, 1),
        "a less precise fallback cannot merge exact source relationships"
    );
}

#[test]
fn craft_attachment_cache_filename_extension_rename_keeps_revision_cache() {
    let fixture = Fixture::new();
    fixture.persist(document(
        "https://r.craft.do/original",
        true,
        Some("revision-1"),
    ));
    let hash = fixture.cache();
    let mut renamed = document("https://r.craft.do/original", true, Some("revision-1"));
    renamed.attachments = discover_attachments_from_json(&json!({
        "id": "image-block", "type": "image", "url": "https://r.craft.do/original",
        "fileName": "renamed.jpg", "fileSize": 4,
        "metadata": { "lastModifiedAt": "revision-1" }
    }));
    fixture.refresh(&renamed);
    let source = fixture.source();
    assert_eq!(source.2.as_deref(), Some(hash.as_str()));
    assert_eq!(
        serde_json::from_str::<Value>(&source.3).unwrap()["resourceGeneration"],
        0
    );
    let mime: String = open_database(&fixture.database)
        .unwrap()
        .query_row(
            "SELECT mime_type FROM source_items WHERE id=?1",
            [&source.0],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        mime, "image/png",
        "the cached byte MIME remains authoritative after a filename rename"
    );
    assert!(
        claim_enabled_attachment_jobs(&fixture.database, "download_source", 10)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn craft_attachment_cache_new_size_conflicts_with_cached_bytes_when_old_metadata_omits_size() {
    let fixture = Fixture::new();
    fixture.persist(document(
        "https://r.craft.do/original",
        true,
        Some("revision-1"),
    ));
    fixture.cache();
    let original = fixture.source();
    // Older Craft nodes may omit fileSize. Keep the formally downloaded blob
    // descriptor as the authoritative byte count for that historical state.
    let mut metadata: Value = serde_json::from_str(&original.3).unwrap();
    metadata.as_object_mut().unwrap().remove("size");
    open_database(&fixture.database)
        .unwrap()
        .execute(
            "UPDATE source_items SET metadata_json=?1 WHERE id=?2",
            params![metadata.to_string(), original.0],
        )
        .unwrap();
    let mut resized = document("https://r.craft.do/original", true, Some("revision-1"));
    resized.attachments = discover_attachments_from_json(&json!({
        "id": "image-block", "type": "image", "url": "https://r.craft.do/original",
        "fileName": "image.png", "fileSize": 8,
        "metadata": { "lastModifiedAt": "revision-1" }
    }));
    fixture.refresh(&resized);
    let replaced = fixture.source();
    assert!(
        replaced.2.is_none(),
        "new provider size must be compared with the cached byte descriptor"
    );
    assert_eq!(
        serde_json::from_str::<Value>(&replaced.3).unwrap()["resourceGeneration"],
        1
    );
    assert_eq!(
        claim_enabled_attachment_jobs(&fixture.database, "download_source", 10)
            .unwrap()
            .len(),
        1
    );
}
