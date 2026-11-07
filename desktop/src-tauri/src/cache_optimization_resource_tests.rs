use super::*;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, RwLock,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const FIRST_BYTES: &[u8] = b"\x89PNG\r\n\x1a\nresource-one";
const SECOND_BYTES: &[u8] = b"\x89PNG\r\n\x1a\nresource-two";
const RESOURCE_URL: &str = "https://r.craft.do/shared-resource";

struct Fixture {
    root: PathBuf,
    database: PathBuf,
    store: BlobStore,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("hub-resource-cache-{}", random_url_safe(16)));
        fs::create_dir_all(&root).unwrap();
        let database = root.join("craft-search.sqlite3");
        let store = BlobStore::open(&root.join("blobs")).unwrap();
        let fixture = Self {
            root,
            database,
            store,
        };
        fixture.add_library("space");
        fixture
    }

    fn add_library(&self, library: &str) {
        let connection = open_database(&self.database).unwrap();
        connection.execute("INSERT INTO spaces(id,name,mcp_url,added_at) VALUES(?1,?1,'https://example.test/mcp',1)", [library]).unwrap();
        connection.execute("INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES(?1,'craft',?1,1,1)", [library]).unwrap();
    }

    fn persist(&self, document: IndexedDocument) {
        persist_document_batch(&self.database, &self.store, vec![document]).unwrap();
    }

    fn claim(&self, count: usize) -> Vec<PipelineJob> {
        let jobs = claim_enabled_attachment_jobs(&self.database, "download_source", count).unwrap();
        assert_eq!(
            jobs.len(),
            count,
            "formal discovery must enqueue the expected independent sources"
        );
        jobs
    }

    async fn run(&self, job: &PipelineJob, server: &Server) {
        let target = server.url.clone();
        process_download_job(
            &self.database,
            &self.store,
            job,
            &server.client,
            None,
            move |metadata, provider| {
                attachment_url_from_metadata(metadata, provider)?;
                Ok(target)
            },
        )
        .await
        .unwrap();
    }

    fn assert_cached(&self, expected: usize) -> String {
        let connection = open_database(&self.database).unwrap();
        let (count,hashes,completed): (usize,usize,usize) = connection.query_row(
            "SELECT COUNT(*),COUNT(DISTINCT s.blob_hash),SUM(EXISTS(SELECT 1 FROM index_jobs j WHERE j.source_id=s.id AND j.job_type='download_source' AND j.status='completed')) FROM source_items s WHERE s.source_type='craft_attachment' AND s.blob_hash IS NOT NULL",
            [],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
        ).unwrap();
        assert_eq!(count, expected);
        assert_eq!(
            completed, expected,
            "each source must finish through the guarded formal commit"
        );
        assert_eq!(hashes, 1);
        connection.query_row("SELECT blob_hash FROM source_items WHERE source_type='craft_attachment' AND blob_hash IS NOT NULL LIMIT 1",[],|row|row.get(0)).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        forget_initialized_database(&self.database);
        fs::remove_dir_all(&self.root).unwrap();
    }
}

fn document(
    library: &str,
    id: &str,
    resources: &[(&str, &str, Option<&str>, Option<u64>)],
) -> IndexedDocument {
    let nodes: Vec<Value> = resources
        .iter()
        .map(|(block, url, revision, size)| {
            json!({
                "id":block,"type":"image","url":url,"fileName":"image.png",
                "fileSize":size,"metadata":{"lastModifiedAt":revision}
            })
        })
        .collect();
    let markdown = resources
        .iter()
        .map(|(_, url, _, _)| format!("![image.png]({url})"))
        .collect::<Vec<_>>()
        .join("\n");
    IndexedDocument {
        space_id: library.into(),
        id: id.into(),
        title: id.into(),
        path: id.into(),
        folder_id: None,
        content_hash: format!("{:x}", Sha256::digest(markdown.as_bytes())),
        markdown,
        modified_at: Some(10),
        indexed_at: now_timestamp(),
        attachments: discover_attachments_from_json(&json!({"content":nodes})),
        block_hints: Vec::new(),
    }
}

struct Server {
    url: Url,
    client: reqwest::Client,
    requests: Arc<AtomicUsize>,
    body: Arc<RwLock<Vec<u8>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Server {
    async fn new() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!(
            "http://{}/attachment",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let requests = Arc::new(AtomicUsize::new(0));
        let body = Arc::new(RwLock::new(FIRST_BYTES.to_vec()));
        let task_requests = requests.clone();
        let task_body = body.clone();
        let task = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let requests = task_requests.clone();
                let body = task_body.clone();
                tokio::spawn(async move {
                    let mut request = Vec::new();
                    let mut buffer = [0_u8; 1024];
                    while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                        let count = socket.read(&mut buffer).await.unwrap();
                        assert_ne!(count, 0);
                        request.extend_from_slice(&buffer[..count]);
                        assert!(request.len() <= 16384);
                    }
                    assert!(request.starts_with(b"GET /attachment HTTP/1.1\r\n"));
                    requests.fetch_add(1, Ordering::SeqCst);
                    let body = body.read().unwrap().clone();
                    // Keep the first GET in flight long enough for concurrent
                    // jobs to contend on the resource lease rather than luck.
                    tokio::time::sleep(Duration::from_millis(40)).await;
                    let header = format!("HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len());
                    socket.write_all(header.as_bytes()).await.unwrap();
                    socket.write_all(&body).await.unwrap();
                    socket.shutdown().await.unwrap();
                });
            }
        });
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        Self {
            url,
            client,
            requests,
            body,
            task,
        }
    }

    fn count(&self) -> usize {
        self.requests.load(Ordering::SeqCst)
    }
    fn set_body(&self, bytes: &[u8]) {
        *self.body.write().unwrap() = bytes.to_vec();
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[tokio::test]
async fn attachment_traffic_resource_sequential_blocks_fetch_once() {
    let fixture = Fixture::new();
    let server = Server::new().await;
    let size = Some(FIRST_BYTES.len() as u64);
    fixture.persist(document(
        "space",
        "page",
        &[("a", RESOURCE_URL, Some("v1"), size)],
    ));
    fixture.run(&fixture.claim(1).remove(0), &server).await;
    fixture.persist(document(
        "space",
        "page",
        &[
            ("a", RESOURCE_URL, Some("v1"), size),
            ("b", RESOURCE_URL, Some("v1"), size),
        ],
    ));
    fixture.run(&fixture.claim(1).remove(0), &server).await;
    assert_eq!(server.count(), 1);
    fixture.assert_cached(2);
}

#[tokio::test]
async fn attachment_traffic_resource_sequential_pages_fetch_once() {
    let fixture = Fixture::new();
    let server = Server::new().await;
    for page in ["first", "second"] {
        fixture.persist(document(
            "space",
            page,
            &[(
                "image",
                RESOURCE_URL,
                Some("v1"),
                Some(FIRST_BYTES.len() as u64),
            )],
        ));
        fixture.run(&fixture.claim(1).remove(0), &server).await;
    }
    assert_eq!(server.count(), 1);
    fixture.assert_cached(2);
}

#[tokio::test]
async fn attachment_traffic_resource_concurrent_blocks_fetch_once() {
    let fixture = Fixture::new();
    let server = Server::new().await;
    let size = Some(FIRST_BYTES.len() as u64);
    fixture.persist(document(
        "space",
        "page",
        &[
            ("a", RESOURCE_URL, Some("v1"), size),
            ("b", RESOURCE_URL, Some("v1"), size),
        ],
    ));
    let jobs = fixture.claim(2);
    tokio::join!(
        fixture.run(&jobs[0], &server),
        fixture.run(&jobs[1], &server)
    );
    assert_eq!(
        server.count(),
        1,
        "two independent running jobs must share one network producer"
    );
    fixture.assert_cached(2);
    assert_eq!(
        attachment_resource_cache::namespace_lock_entries(&fixture.database).unwrap(),
        0
    );
}

#[tokio::test]
async fn attachment_traffic_resource_known_and_unknown_size_share_inflight_request() {
    let fixture = Fixture::new();
    let server = Server::new().await;
    fixture.persist(document(
        "space",
        "page",
        &[
            ("a", RESOURCE_URL, Some("v1"), None),
            (
                "b",
                RESOURCE_URL,
                Some("v1"),
                Some(FIRST_BYTES.len() as u64),
            ),
        ],
    ));
    let jobs = fixture.claim(2);
    tokio::join!(
        fixture.run(&jobs[0], &server),
        fixture.run(&jobs[1], &server)
    );
    assert_eq!(
        server.count(),
        1,
        "unknown length cannot create a second lock for the same version"
    );
    fixture.assert_cached(2);
}

#[tokio::test]
async fn attachment_traffic_resource_same_source_locator_rotation_waits_for_current_bytes() {
    let fixture = Fixture::new();
    let server = Server::new().await;
    let size = Some(FIRST_BYTES.len() as u64);
    fixture.persist(document(
        "space",
        "page",
        &[("image", RESOURCE_URL, Some("v1"), size)],
    ));
    let job = fixture.claim(1).remove(0);
    let newer_url = "https://r.craft.do/shared-resource-moved";
    let second_producer = async {
        tokio::time::timeout(Duration::from_secs(2), async {
            while server.count() == 0 {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
        // Exact block/revision are unchanged, so this URL update keeps the
        // running owner and generation while the first GET is still in flight.
        fixture.persist(document(
            "space",
            "page",
            &[("image", newer_url, Some("v1"), size)],
        ));
        let target = server.url.clone();
        load_preview_attachment_resolving(
            &fixture.database,
            &fixture.store,
            PROVIDER_CRAFT,
            "space",
            "page",
            newer_url,
            &server.client,
            || Ok(None),
            false,
            move |capture| {
                attachment_url_from_metadata(&capture.metadata, &capture.provider)?;
                Ok(target)
            },
        )
        .await
        .unwrap()
    };
    let (_, preview) = tokio::join!(fixture.run(&job, &server), second_producer);
    assert_eq!(
        server.count(),
        1,
        "the new locator must wait on source identity and then reuse its own completed bytes"
    );
    assert_eq!(
        fixture.store.read(&preview.0.blob.hash).unwrap(),
        FIRST_BYTES
    );
    let metadata: String = open_database(&fixture.database)
        .unwrap()
        .query_row(
            "SELECT metadata_json FROM source_items WHERE id=?1",
            [job.source_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(attachment_download_cache::resource_generation(&metadata), 0);
    assert_eq!(
        attachment_resource_cache::namespace_lock_entries(&fixture.database).unwrap(),
        0
    );
}

#[tokio::test]
async fn attachment_traffic_resource_actual_size_mismatch_keeps_bounded_retry_backoff() {
    let fixture = Fixture::new();
    let server = Server::new().await;
    let expected_size = Some(FIRST_BYTES.len() as u64 + 1);
    fixture.persist(document(
        "space",
        "page",
        &[("image", RESOURCE_URL, Some("v1"), expected_size)],
    ));
    for attempt in 1..=INDEX_JOB_MAX_ATTEMPTS {
        let job = fixture.claim(1).remove(0);
        fixture.run(&job, &server).await;
        let (attempts,retry_at,error,blob): (i64,i64,Option<String>,Option<String>) = open_database(&fixture.database).unwrap().query_row(
            "SELECT j.attempts,j.next_attempt_at,j.last_error,s.blob_hash FROM index_jobs j JOIN source_items s ON s.id=j.source_id WHERE j.id=?1",
            [job.id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
        ).unwrap();
        assert_eq!(
            attempts, attempt,
            "size failure must consume an ordinary bounded attempt"
        );
        if attempt < INDEX_JOB_MAX_ATTEMPTS {
            assert!(retry_at > now_timestamp());
        } else {
            assert_eq!(retry_at, 0, "exhausted failures stop their retry clock");
        }
        assert!(error.unwrap().contains("实际大小"));
        assert!(
            blob.is_none(),
            "inconsistent bytes cannot become a source cache that scans repeatedly invalidate"
        );
        fixture.persist(document(
            "space",
            "page",
            &[("image", RESOURCE_URL, Some("v1"), expected_size)],
        ));
        assert!(
            claim_enabled_attachment_jobs(&fixture.database, "download_source", 1)
                .unwrap()
                .is_empty(),
            "an unchanged rescan preserves the retry deadline"
        );
        if attempt < INDEX_JOB_MAX_ATTEMPTS {
            // Advance only this fixture's due time instead of sleeping through
            // the durable exponential retry window; keep real claim attempts.
            open_database(&fixture.database)
                .unwrap()
                .execute(
                    "UPDATE index_jobs SET next_attempt_at=0 WHERE id=?1",
                    [job.id],
                )
                .unwrap();
        }
    }
    open_database(&fixture.database)
        .unwrap()
        .execute(
            "UPDATE index_jobs SET next_attempt_at=0 WHERE job_type='download_source'",
            [],
        )
        .unwrap();
    assert!(
        claim_enabled_attachment_jobs(&fixture.database, "download_source", 1)
            .unwrap()
            .is_empty()
    );
    assert_eq!(server.count(), INDEX_JOB_MAX_ATTEMPTS as usize);
}

#[tokio::test]
async fn attachment_traffic_resource_changed_revision_fetches_current_bytes() {
    let fixture = Fixture::new();
    let server = Server::new().await;
    let size = Some(FIRST_BYTES.len() as u64);
    fixture.persist(document(
        "space",
        "page",
        &[("image", RESOURCE_URL, Some("v1"), size)],
    ));
    fixture.run(&fixture.claim(1).remove(0), &server).await;
    let original = fixture.assert_cached(1);
    server.set_body(SECOND_BYTES);
    fixture.persist(document(
        "space",
        "page",
        &[("image", RESOURCE_URL, Some("v2"), size)],
    ));
    fixture.run(&fixture.claim(1).remove(0), &server).await;
    let updated = fixture.assert_cached(1);
    assert_eq!(server.count(), 2);
    assert_ne!(original, updated);
    assert_eq!(fixture.store.read(&updated).unwrap(), SECOND_BYTES);
}

#[tokio::test]
async fn attachment_traffic_resource_different_revisions_are_not_shared() {
    let fixture = Fixture::new();
    let server = Server::new().await;
    for (page, revision) in [("first", "v1"), ("second", "v2")] {
        fixture.persist(document(
            "space",
            page,
            &[(
                "image",
                RESOURCE_URL,
                Some(revision),
                Some(FIRST_BYTES.len() as u64),
            )],
        ));
        fixture.run(&fixture.claim(1).remove(0), &server).await;
    }
    assert_eq!(server.count(), 2);
}

#[tokio::test]
async fn attachment_traffic_resource_conflicting_size_is_not_shared() {
    let fixture = Fixture::new();
    let server = Server::new().await;
    fixture.persist(document(
        "space",
        "first",
        &[(
            "image",
            RESOURCE_URL,
            Some("v1"),
            Some(FIRST_BYTES.len() as u64),
        )],
    ));
    fixture.run(&fixture.claim(1).remove(0), &server).await;
    let bigger = [FIRST_BYTES, b"longer"].concat();
    server.set_body(&bigger);
    fixture.persist(document(
        "space",
        "second",
        &[("image", RESOURCE_URL, Some("v1"), Some(bigger.len() as u64))],
    ));
    fixture.run(&fixture.claim(1).remove(0), &server).await;
    let hash: String = open_database(&fixture.database).unwrap().query_row("SELECT blob_hash FROM source_items WHERE document_id='second' AND source_type='craft_attachment'",[],|row|row.get(0)).unwrap();
    assert_eq!(server.count(), 2);
    assert_eq!(fixture.store.read(&hash).unwrap(), bigger);
}

#[tokio::test]
async fn attachment_traffic_resource_signed_url_rotation_reuses_verified_bytes() {
    let fixture = Fixture::new();
    let server = Server::new().await;
    for (page, signature) in [("first", "old"), ("second", "renewed")] {
        let url = format!("{RESOURCE_URL}?X-Amz-Signature={signature}&X-Amz-Expires=900");
        fixture.persist(document(
            "space",
            page,
            &[("image", &url, None, Some(FIRST_BYTES.len() as u64))],
        ));
        fixture.run(&fixture.claim(1).remove(0), &server).await;
    }
    assert_eq!(server.count(), 1);
    fixture.assert_cached(2);
}

#[tokio::test]
async fn attachment_traffic_resource_unknown_query_changes_do_not_share_bytes() {
    let fixture = Fixture::new();
    let server = Server::new().await;
    for (page, token) in [("first", "one"), ("second", "two")] {
        let url = format!("{RESOURCE_URL}?token={token}");
        fixture.persist(document(
            "space",
            page,
            &[("image", &url, None, Some(FIRST_BYTES.len() as u64))],
        ));
        fixture.run(&fixture.claim(1).remove(0), &server).await;
    }
    assert_eq!(
        server.count(),
        2,
        "unknown query parameters may select different resources"
    );
}

#[tokio::test]
async fn attachment_traffic_resource_stale_cache_generation_is_not_shared() {
    let fixture = Fixture::new();
    let server = Server::new().await;
    let size = Some(FIRST_BYTES.len() as u64);
    fixture.persist(document(
        "space",
        "first",
        &[("image", RESOURCE_URL, Some("v1"), size)],
    ));
    fixture.run(&fixture.claim(1).remove(0), &server).await;
    // Preserve real downloaded bytes while moving source metadata to a new
    // generation, as a provider can do when keeping a local preview offline.
    open_database(&fixture.database).unwrap().execute("UPDATE source_items SET metadata_json=json_set(metadata_json,'$.resourceGeneration',1,'$.cachedResourceGeneration',0) WHERE document_id='first' AND source_type='craft_attachment'",[]).unwrap();
    fixture.persist(document(
        "space",
        "second",
        &[("image", RESOURCE_URL, Some("v1"), size)],
    ));
    fixture.run(&fixture.claim(1).remove(0), &server).await;
    assert_eq!(
        server.count(),
        2,
        "the previous generation's blob is not proof for a new source"
    );
}

#[tokio::test]
async fn attachment_traffic_resource_database_and_library_namespaces_are_isolated() {
    let first = Fixture::new();
    let second = Fixture::new();
    let server = Server::new().await;
    let size = Some(FIRST_BYTES.len() as u64);
    for fixture in [&first, &second] {
        fixture.persist(document(
            "space",
            "page",
            &[("image", RESOURCE_URL, Some("v1"), size)],
        ));
        fixture.run(&fixture.claim(1).remove(0), &server).await;
    }
    first.add_library("another");
    first.persist(document(
        "another",
        "page",
        &[("image", RESOURCE_URL, Some("v1"), size)],
    ));
    first.run(&first.claim(1).remove(0), &server).await;
    assert_eq!(
        server.count(),
        3,
        "sharing cannot cross a database or library boundary"
    );
    let metadata =
        json!({"remoteUrl":RESOURCE_URL,"resourceRevision":"v1","size":FIRST_BYTES.len()})
            .to_string();
    assert!(attachment_resource_cache::verified_resource(
        &first.database,
        &first.store,
        "space",
        PROVIDER_DIDA365,
        &metadata,
        None
    )
    .unwrap()
    .is_none());
}

#[tokio::test]
async fn attachment_traffic_resource_cancelled_waiter_releases_lock_registry() {
    let fixture = Fixture::new();
    let metadata = json!({"remoteUrl":RESOURCE_URL,"resourceRevision":"v1"}).to_string();
    let owner =
        attachment_resource_cache::acquire(&fixture.database, "space", PROVIDER_CRAFT, &metadata)
            .await
            .unwrap();
    let mut waiter = Box::pin(attachment_resource_cache::acquire(
        &fixture.database,
        "space",
        PROVIDER_CRAFT,
        &metadata,
    ));
    tokio::select! {
        result = &mut waiter => panic!("waiting caller acquired active lease: {}",result.is_ok()),
        _ = tokio::time::sleep(Duration::from_millis(10)) => {}
    }
    assert_eq!(
        attachment_resource_cache::namespace_lock_entries(&fixture.database).unwrap(),
        1
    );
    drop(waiter);
    drop(owner);
    assert_eq!(
        attachment_resource_cache::namespace_lock_entries(&fixture.database).unwrap(),
        0
    );
}

#[tokio::test]
async fn attachment_traffic_resource_bad_object_is_repaired_and_next_page_reuses_it() {
    let fixture = Fixture::new();
    let server = Server::new().await;
    let size = Some(FIRST_BYTES.len() as u64);
    fixture.persist(document(
        "space",
        "first",
        &[("image", RESOURCE_URL, Some("v1"), size)],
    ));
    fixture.run(&fixture.claim(1).remove(0), &server).await;
    let hash = fixture.assert_cached(1);
    fs::write(
        fixture.store.local_path_for(&hash).unwrap(),
        vec![0; FIRST_BYTES.len()],
    )
    .unwrap();
    fixture.persist(document(
        "space",
        "second",
        &[("image", RESOURCE_URL, Some("v1"), size)],
    ));
    fixture.run(&fixture.claim(1).remove(0), &server).await;
    assert_eq!(
        fixture.store.read(&hash).unwrap(),
        FIRST_BYTES,
        "correct staged bytes must replace an existing bad hash path"
    );
    fixture.persist(document(
        "space",
        "third",
        &[("image", RESOURCE_URL, Some("v1"), size)],
    ));
    fixture.run(&fixture.claim(1).remove(0), &server).await;
    assert_eq!(
        server.count(),
        2,
        "one repair request must end repeated corrupted-cache downloads"
    );
    fixture.assert_cached(3);
}

#[test]
fn attachment_traffic_resource_put_repairs_same_size_corruption() {
    let fixture = Fixture::new();
    let original = fixture.store.put(FIRST_BYTES).unwrap();
    fs::write(
        fixture.store.local_path_for(&original.hash).unwrap(),
        vec![0; FIRST_BYTES.len()],
    )
    .unwrap();
    let repaired = fixture.store.put(FIRST_BYTES).unwrap();
    assert_eq!(original.hash, repaired.hash);
    assert_eq!(fixture.store.read(&repaired.hash).unwrap(), FIRST_BYTES);
}

#[test]
fn attachment_traffic_resource_put_file_repairs_truncated_object() {
    let fixture = Fixture::new();
    let original = fixture.store.put(FIRST_BYTES).unwrap();
    fs::write(
        fixture.store.local_path_for(&original.hash).unwrap(),
        b"broken",
    )
    .unwrap();
    let source = fixture.root.join("input.png");
    fs::write(&source, FIRST_BYTES).unwrap();
    let repaired = fixture.store.put_file(&source, 1024).unwrap();
    assert_eq!(original.hash, repaired.hash);
    assert_eq!(fixture.store.read(&repaired.hash).unwrap(), FIRST_BYTES);
}

#[test]
fn attachment_traffic_resource_competing_staged_commits_repair_bad_target() {
    let fixture = Fixture::new();
    let original = fixture.store.put(FIRST_BYTES).unwrap();
    fs::write(
        fixture.store.local_path_for(&original.hash).unwrap(),
        vec![0; FIRST_BYTES.len()],
    )
    .unwrap();
    let barrier = Arc::new(std::sync::Barrier::new(2));
    std::thread::scope(|scope| {
        for _ in 0..2 {
            let store = fixture.store.clone();
            let hash = original.hash.clone();
            let barrier = barrier.clone();
            scope.spawn(move || {
                let staged = store.staging_path().unwrap();
                fs::write(&staged, FIRST_BYTES).unwrap();
                barrier.wait();
                store
                    .commit_staged(&staged, &hash, FIRST_BYTES.len() as u64)
                    .unwrap();
                assert!(!staged.exists());
            });
        }
    });
    assert_eq!(fixture.store.read(&original.hash).unwrap(), FIRST_BYTES);
}
