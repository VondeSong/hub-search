use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const URL: &str = "https://r.craft.do/preview-resource";
const DIDA_SOURCE: &str = "0123456789abcdef01234567/photo.png";

struct PreviewFixture {
    root: PathBuf,
    database: PathBuf,
    store: BlobStore,
}

impl PreviewFixture {
    fn new(provider: &str) -> Self {
        let root = std::env::temp_dir().join(format!("hub-preview-cache-{}", random_url_safe(16)));
        fs::create_dir_all(&root).unwrap();
        let database = root.join("craft-search.sqlite3");
        let connection = open_database(&database).unwrap();
        connection.execute("INSERT INTO spaces(id,name,mcp_url,added_at) VALUES('space','Space','https://example.test/mcp',1)",[]).unwrap();
        connection.execute("INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES('space',?1,'Space',1,1)",[provider]).unwrap();
        connection.execute("INSERT INTO documents(space_id,id,title,path,markdown,indexed_at,content_hash,provider) VALUES('space','doc','Doc','Doc','body',1,'body',?1)",[provider]).unwrap();
        Self {
            store: BlobStore::open(&root.join("blobs")).unwrap(),
            root,
            database,
        }
    }

    fn craft(&self, url: &str, revision: &str) {
        let markdown = format!("![image.png]({url})");
        let document = IndexedDocument {
            space_id: "space".into(),
            id: "doc".into(),
            title: "Doc".into(),
            path: "Doc".into(),
            folder_id: None,
            content_hash: format!("{:x}", Sha256::digest(markdown.as_bytes())),
            markdown,
            modified_at: Some(1),
            indexed_at: now_timestamp(),
            attachments: discover_attachments_from_json(
                &json!({"id":"image-block","type":"image","url":url,
                "fileName":"image.png","fileSize":4,"metadata":{"lastModifiedAt":revision}}),
            ),
            block_hints: Vec::new(),
        };
        persist_document_batch(&self.database, &self.store, vec![document]).unwrap();
    }

    fn capture(&self, provider: &str, source: &str) -> PreviewDownloadCapture {
        read_preview_download_capture(&self.database, provider, "space", "doc", source, None)
            .unwrap()
    }

    fn source(&self, id: &str) -> (Option<String>, String) {
        open_database(&self.database)
            .unwrap()
            .query_row(
                "SELECT blob_hash,metadata_json FROM source_items WHERE id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap()
    }

    fn dida(&self, project: &str) {
        let task = DidaTask {
            id: "doc".into(),
            project_id: project.into(),
            title: "Doc".into(),
            content: format!("![photo]({DIDA_SOURCE})"),
            description: String::new(),
            kind: "TEXT".into(),
            status: 0,
            priority: 0,
            start_date: None,
            due_date: None,
            created_time: None,
            modified_time: None,
            completed_time: None,
            time_zone: None,
            column_id: None,
            column_name: None,
            parent_id: None,
            tags: Vec::new(),
            items: Vec::new(),
            attachments: Vec::new(),
            raw: json!({}),
        };
        let (mut connection, _writer) = open_write_database(&self.database).unwrap();
        let transaction = connection.transaction().unwrap();
        upsert_dida_attachments(&transaction, "space", &task, now_timestamp()).unwrap();
        transaction.commit().unwrap();
    }
}

impl Drop for PreviewFixture {
    fn drop(&mut self) {
        forget_initialized_database(&self.database);
        fs::remove_dir_all(&self.root).unwrap();
    }
}

#[tokio::test]
async fn craft_attachment_cache_preview_late_success_cannot_publish_new_generation() {
    let fixture = PreviewFixture::new(PROVIDER_CRAFT);
    fixture.craft(URL, "v1");
    let (capture, _source_lease, lease) =
        acquire_preview_download_capture(&fixture.database, PROVIDER_CRAFT, "space", "doc", URL)
            .await
            .unwrap();
    let old = DownloadedSource {
        blob: fixture.store.put(b"old1").unwrap(),
        mime_type: "image/png".into(),
    };
    fixture.craft(URL, "v2");
    assert!(
        attachment_download_cache::DownloadCheckpoint::checkpoint(&capture)
            .unwrap_err()
            .starts_with("CONTENT_POLICY:")
    );
    assert!(
        persist_preview_media_download(&fixture.database, &capture, &lease, &old)
            .unwrap_err()
            .starts_with("CONTENT_POLICY:")
    );
    assert!(fixture.source(&capture.source_id).0.is_none());
    let published: bool = open_database(&fixture.database)
        .unwrap()
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM blobs WHERE hash=?1)",
            [&old.blob.hash],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        !published,
        "a stale preview must not bind or publish old bytes"
    );
}

#[tokio::test]
async fn craft_attachment_cache_preview_same_revision_url_rotation_keeps_completed_bytes() {
    let fixture = PreviewFixture::new(PROVIDER_CRAFT);
    fixture.craft(URL, "v1");
    let (capture, _source_lease, lease) =
        acquire_preview_download_capture(&fixture.database, PROVIDER_CRAFT, "space", "doc", URL)
            .await
            .unwrap();
    let downloaded = DownloadedSource {
        blob: fixture.store.put(b"old1").unwrap(),
        mime_type: "image/png".into(),
    };
    fixture.craft("https://r.craft.do/rotated-preview-url", "v1");
    let current = fixture.source(&capture.source_id);
    assert_eq!(
        attachment_download_cache::resource_generation(&current.1),
        capture.generation()
    );
    attachment_download_cache::DownloadCheckpoint::checkpoint(&capture).unwrap();
    persist_preview_media_download(&fixture.database, &capture, &lease, &downloaded).unwrap();
    let (hash, metadata) = fixture.source(&capture.source_id);
    assert_eq!(hash.as_deref(), Some(downloaded.blob.hash.as_str()));
    let metadata: Value = serde_json::from_str(&metadata).unwrap();
    assert_eq!(
        metadata["cachedResourceGeneration"].as_u64(),
        Some(capture.generation())
    );
}

#[tokio::test]
async fn craft_attachment_cache_old_signed_url_opens_current_source_cache_without_get() {
    let fixture = PreviewFixture::new(PROVIDER_CRAFT);
    let old_url =
        "https://r.craft.do/preview-signed?variant=thumb&X-Amz-Signature=old&X-Amz-Expires=1";
    let new_url =
        "https://r.craft.do/preview-signed?variant=thumb&X-Amz-Signature=new&X-Amz-Expires=2";
    fixture.craft(old_url, "v1");
    let old = fixture.capture(PROVIDER_CRAFT, old_url);
    let lease = attachment_resource_cache::acquire(
        &fixture.database,
        "space",
        PROVIDER_CRAFT,
        &old.metadata,
    )
    .await
    .unwrap();
    let downloaded = DownloadedSource {
        blob: fixture.store.put(b"old1").unwrap(),
        mime_type: "image/png".into(),
    };
    persist_preview_media_download(&fixture.database, &old, &lease, &downloaded).unwrap();
    drop(lease);
    fixture.craft(new_url, "v1");
    let current = fixture.capture(PROVIDER_CRAFT, old_url);
    assert_eq!(current.source_id, old.source_id);
    assert_eq!(current.generation(), old.generation());
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    // Both a first-open request and a repeated open use the Markdown's old
    // signature while consuming the exact current registered cache.
    for _ in 0..2 {
        let (cached, _) = load_preview_attachment_resolving(
            &fixture.database,
            &fixture.store,
            PROVIDER_CRAFT,
            "space",
            "doc",
            old_url,
            &client,
            || panic!("a signed URL refresh must not need credentials for cached bytes"),
            false,
            |_| panic!("a signed URL refresh must not make another GET for cached bytes"),
        )
        .await
        .unwrap();
        assert_eq!(cached.blob.hash, downloaded.blob.hash);
    }
    let metadata: Value = serde_json::from_str(&fixture.source(&old.source_id).1).unwrap();
    assert_eq!(metadata["remoteUrl"].as_str(), Some(new_url));
}

#[tokio::test]
async fn craft_attachment_cache_semantic_url_change_is_not_a_preview_locator_match() {
    let fixture = PreviewFixture::new(PROVIDER_CRAFT);
    fixture.craft(
        "https://r.craft.do/preview-signed?variant=thumb&X-Amz-Signature=new",
        "v1",
    );
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let result = load_preview_attachment_resolving(
        &fixture.database,
        &fixture.store,
        PROVIDER_CRAFT,
        "space",
        "doc",
        "https://r.craft.do/preview-signed?variant=full&X-Amz-Signature=old",
        &client,
        || panic!("different semantic parameters must not acquire credentials"),
        false,
        |_| panic!("different semantic parameters must not reach transport"),
    )
    .await;
    assert!(result.is_err());
    assert!(fixture
        .capture(
            PROVIDER_CRAFT,
            "https://r.craft.do/preview-signed?variant=thumb&X-Amz-Signature=new"
        )
        .blob_hash
        .is_none());
}

#[tokio::test]
async fn craft_attachment_cache_ambiguous_preview_locator_does_not_choose_an_exact_block() {
    let fixture = PreviewFixture::new(PROVIDER_CRAFT);
    let current_url = "https://r.craft.do/preview-signed?X-Amz-Signature=new";
    fixture.craft(current_url, "v1");
    let known = fixture.capture(PROVIDER_CRAFT, current_url);
    let mut sibling: Value = serde_json::from_str(&known.metadata).unwrap();
    sibling["blockId"] = json!("image-two");
    open_database(&fixture.database).unwrap().execute(
        "INSERT INTO source_items(id,space_id,document_id,remote_id,source_type,title,mime_type,status,metadata_json,created_at,updated_at,provider)
         VALUES('sibling','space','doc','sibling','craft_attachment','sibling','image/png','discovered',?1,1,1,'craft')",
        [sibling.to_string()],
    ).unwrap();
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let result = load_preview_attachment_resolving(
        &fixture.database,
        &fixture.store,
        PROVIDER_CRAFT,
        "space",
        "doc",
        "https://r.craft.do/preview-signed?X-Amz-Signature=old",
        &client,
        || panic!("ambiguous source must not acquire credentials"),
        false,
        |_| panic!("ambiguous source must not reach transport"),
    )
    .await;
    assert!(result.err().unwrap().contains("多个附件"));
    assert!(fixture.source(&known.source_id).0.is_none());
    assert!(fixture.source("sibling").0.is_none());
}

#[tokio::test]
async fn craft_attachment_cache_preview_learns_known_size_without_restarting_same_generation() {
    let fixture = PreviewFixture::new(PROVIDER_CRAFT);
    fixture.craft(URL, "v1");
    // Discovery represents an unknown file size as JSON null. Learning its
    // actual size does not change this attachment's byte generation.
    open_database(&fixture.database)
        .unwrap()
        .execute(
            "UPDATE source_items SET metadata_json=json_set(metadata_json,'$.size',NULL)",
            [],
        )
        .unwrap();
    let (capture, _source_lease, lease) =
        acquire_preview_download_capture(&fixture.database, PROVIDER_CRAFT, "space", "doc", URL)
            .await
            .unwrap();
    assert!(serde_json::from_str::<Value>(&capture.metadata).unwrap()["size"].is_null());
    let downloaded = DownloadedSource {
        blob: fixture.store.put(b"old1").unwrap(),
        mime_type: "image/png".into(),
    };
    fixture.craft(URL, "v1");
    let current = fixture.source(&capture.source_id);
    assert_eq!(
        serde_json::from_str::<Value>(&current.1).unwrap()["size"].as_u64(),
        Some(4)
    );
    assert_eq!(
        attachment_download_cache::resource_generation(&current.1),
        capture.generation()
    );
    attachment_download_cache::DownloadCheckpoint::checkpoint(&capture).unwrap();
    persist_preview_media_download(&fixture.database, &capture, &lease, &downloaded).unwrap();
    assert_eq!(
        fixture.source(&capture.source_id).0.as_deref(),
        Some(downloaded.blob.hash.as_str())
    );
}

#[tokio::test]
async fn craft_attachment_cache_preview_rejects_wrong_length_before_binding() {
    let fixture = PreviewFixture::new(PROVIDER_CRAFT);
    fixture.craft(URL, "v1");
    let (capture, _source_lease, lease) =
        acquire_preview_download_capture(&fixture.database, PROVIDER_CRAFT, "space", "doc", URL)
            .await
            .unwrap();
    let downloaded = DownloadedSource {
        blob: fixture.store.put(b"bad").unwrap(),
        mime_type: "image/png".into(),
    };
    let error = persist_preview_media_download(&fixture.database, &capture, &lease, &downloaded)
        .unwrap_err();
    assert!(
        !error.starts_with("CONTENT_POLICY:"),
        "a length mismatch is a bounded failure, not a generation restart"
    );
    assert!(fixture.source(&capture.source_id).0.is_none());
}

#[tokio::test]
async fn craft_attachment_cache_dida_move_preserves_running_owner_and_rejects_late_bytes() {
    let fixture = PreviewFixture::new(PROVIDER_DIDA365);
    fixture.dida("project-one");
    let capture = fixture.capture(PROVIDER_DIDA365, DIDA_SOURCE);
    let connection = open_database(&fixture.database).unwrap();
    connection.execute("UPDATE index_jobs SET status='running',worker_id='owner',locked_at=12,lease_until=999999,attempts=3",[]).unwrap();
    let lease = attachment_resource_cache::acquire(
        &fixture.database,
        "space",
        PROVIDER_DIDA365,
        &capture.metadata,
    )
    .await
    .unwrap();
    fixture.dida("project-two");
    let state: (String, String, i64, i64, i64) = connection
        .query_row(
            "SELECT status,worker_id,locked_at,lease_until,attempts FROM index_jobs",
            [],
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
    assert_eq!(state, ("running".into(), "owner".into(), 12, 999999, 3));
    assert_eq!(
        attachment_download_cache::resource_generation(&fixture.source(&capture.source_id).1),
        capture.generation() + 1
    );
    let downloaded = DownloadedSource {
        blob: fixture.store.put(b"old1").unwrap(),
        mime_type: "image/png".into(),
    };
    assert!(
        persist_preview_media_download(&fixture.database, &capture, &lease, &downloaded)
            .unwrap_err()
            .starts_with("CONTENT_POLICY:")
    );
    assert!(fixture.source(&capture.source_id).0.is_none());
}

#[tokio::test]
async fn craft_attachment_cache_dida_move_reuses_same_attachment_bytes_and_refreshes_marker() {
    let fixture = PreviewFixture::new(PROVIDER_DIDA365);
    fixture.dida("project-one");
    let old = fixture.capture(PROVIDER_DIDA365, DIDA_SOURCE);
    let downloaded = DownloadedSource {
        blob: fixture.store.put(b"old1").unwrap(),
        mime_type: "image/png".into(),
    };
    let lease = attachment_resource_cache::acquire(
        &fixture.database,
        "space",
        PROVIDER_DIDA365,
        &old.metadata,
    )
    .await
    .unwrap();
    persist_preview_media_download(&fixture.database, &old, &lease, &downloaded).unwrap();
    drop(lease);
    fixture.dida("project-two");
    let changed = fixture.capture(PROVIDER_DIDA365, DIDA_SOURCE);
    assert_eq!(
        changed.blob_hash.as_deref(),
        Some(downloaded.blob.hash.as_str())
    );
    assert_eq!(changed.generation(), old.generation() + 1);
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let (cached, _) = load_preview_attachment_resolving(
        &fixture.database,
        &fixture.store,
        PROVIDER_DIDA365,
        "space",
        "doc",
        DIDA_SOURCE,
        &client,
        || panic!("same attachment cache must not need a web session"),
        true,
        |_| panic!("project moves preserve valid bytes and must not request another URL"),
    )
    .await
    .unwrap();
    assert_eq!(cached.blob.hash, downloaded.blob.hash);
    let metadata: Value = serde_json::from_str(&fixture.source(&old.source_id).1).unwrap();
    assert_eq!(
        metadata["cachedResourceGeneration"].as_u64(),
        Some(changed.generation())
    );
    fixture.dida("project-two");
    let unchanged: Value = serde_json::from_str(&fixture.source(&old.source_id).1).unwrap();
    assert_eq!(
        unchanged["cachedResourceGeneration"].as_u64(),
        Some(changed.generation()),
        "an unchanged sync must preserve the verified byte generation marker"
    );
}

#[tokio::test]
async fn craft_attachment_cache_preview_targets_one_source_and_keeps_running_work() {
    let fixture = PreviewFixture::new(PROVIDER_CRAFT);
    fixture.craft(URL, "v1");
    let capture = fixture.capture(PROVIDER_CRAFT, URL);
    let c = open_database(&fixture.database).unwrap();
    c.execute("INSERT INTO source_items(id,space_id,document_id,remote_id,source_type,title,mime_type,status,metadata_json,created_at,updated_at,provider) VALUES('sibling','space','doc','sibling','craft_attachment','sibling','video/mp4','discovered',?1,1,1,'craft')",[&capture.metadata]).unwrap();
    c.execute("INSERT INTO index_jobs(job_key,space_id,source_id,source_type,job_type,status,created_at,updated_at,worker_id) VALUES('sibling','space','sibling','craft_attachment','download_source','pending',1,1,'sibling-owner')",[]).unwrap();
    c.execute(
        "UPDATE index_jobs SET status='running',worker_id='owner' WHERE source_id=?1",
        [&capture.source_id],
    )
    .unwrap();
    let lease = attachment_resource_cache::acquire(
        &fixture.database,
        "space",
        PROVIDER_CRAFT,
        &capture.metadata,
    )
    .await
    .unwrap();
    let downloaded = DownloadedSource {
        blob: fixture.store.put(b"old1").unwrap(),
        mime_type: "video/mp4".into(),
    };
    persist_preview_media_download(&fixture.database, &capture, &lease, &downloaded).unwrap();
    assert_eq!(
        fixture.source(&capture.source_id).0.as_deref(),
        Some(downloaded.blob.hash.as_str())
    );
    assert!(
        fixture.source("sibling").0.is_none(),
        "sharing a URL does not authorize overwriting another source"
    );
    let state: (String, String) = c
        .query_row(
            "SELECT status,worker_id FROM index_jobs WHERE source_id=?1",
            [&capture.source_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(state, ("running".into(), "owner".into()));
    assert_eq!(
        c.query_row(
            "SELECT status FROM index_jobs WHERE source_id='sibling'",
            [],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        "pending"
    );
}

#[tokio::test]
async fn craft_attachment_cache_unregistered_preview_does_not_request_or_change_known_source() {
    let fixture = PreviewFixture::new(PROVIDER_CRAFT);
    fixture.craft(URL, "v1");
    let known = fixture.capture(PROVIDER_CRAFT, URL);
    let before = fixture.source(&known.source_id);
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let result = load_preview_attachment_resolving(
        &fixture.database,
        &fixture.store,
        PROVIDER_CRAFT,
        "space",
        "doc",
        "https://r.craft.do/unregistered",
        &client,
        || panic!("unregistered source must not request a web session"),
        false,
        |_| panic!("unregistered source must not reach the download transport"),
    )
    .await;
    assert!(result.is_err());
    assert_eq!(fixture.source(&known.source_id), before);
}

#[tokio::test]
async fn craft_attachment_cache_registered_video_requires_activation_before_transport() {
    let fixture = PreviewFixture::new(PROVIDER_CRAFT);
    fixture.craft(URL, "v1");
    open_database(&fixture.database)
        .unwrap()
        .execute(
            "UPDATE source_items SET mime_type='video/mp4',title='video.mp4'",
            [],
        )
        .unwrap();
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let result = load_preview_attachment_resolving(
        &fixture.database,
        &fixture.store,
        PROVIDER_CRAFT,
        "space",
        "doc",
        URL,
        &client,
        || panic!("passive video must not load credentials"),
        false,
        |_| panic!("passive video must not reach the download transport"),
    )
    .await;
    assert_eq!(result.err().as_deref(), Some("VIDEO_REQUIRES_ACTIVATION"));
    assert!(fixture.capture(PROVIDER_CRAFT, URL).blob_hash.is_none());
}

struct PreviewServer {
    url: Url,
    requests: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}

impl PreviewServer {
    async fn start() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!(
            "http://{}/preview",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let requests = Arc::new(AtomicUsize::new(0));
        let count = requests.clone();
        let task = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                    let mut buffer = [0_u8; 1024];
                    let read = stream.read(&mut buffer).await.unwrap();
                    assert!(read > 0 && request.len() + read <= 8192);
                    request.extend_from_slice(&buffer[..read]);
                }
                assert!(request.starts_with(b"GET "));
                count.fetch_add(1, Ordering::SeqCst);
                stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nContent-Type: image/png\r\nConnection: close\r\n\r\nold1").await.unwrap();
                stream.shutdown().await.unwrap();
            }
        });
        Self {
            url,
            requests,
            task,
        }
    }
}

impl Drop for PreviewServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[tokio::test]
async fn craft_attachment_cache_simultaneous_native_previews_issue_one_real_get() {
    let fixture = PreviewFixture::new(PROVIDER_CRAFT);
    fixture.craft(URL, "v1");
    let server = PreviewServer::start().await;
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    // Only the URL resolver is replaced: the real consumer still captures the
    // source, acquires both leases, verifies cache, streams bytes and commits.
    let first = load_preview_attachment_resolving(
        &fixture.database,
        &fixture.store,
        PROVIDER_CRAFT,
        "space",
        "doc",
        URL,
        &client,
        || Ok(None),
        false,
        |_| Ok(server.url.clone()),
    );
    let second = load_preview_attachment_resolving(
        &fixture.database,
        &fixture.store,
        PROVIDER_CRAFT,
        "space",
        "doc",
        URL,
        &client,
        || Ok(None),
        false,
        |_| Ok(server.url.clone()),
    );
    let (one, two) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(first, second)
    })
    .await
    .unwrap();
    let one = one.unwrap().0;
    let two = two.unwrap().0;
    assert_eq!(one.blob.hash, two.blob.hash);
    assert_eq!(server.requests.load(Ordering::SeqCst), 1);
    let repeated = load_preview_attachment_resolving(
        &fixture.database,
        &fixture.store,
        PROVIDER_CRAFT,
        "space",
        "doc",
        URL,
        &client,
        || panic!("cached native preview does not need credentials"),
        false,
        |_| panic!("cached native preview must not issue another GET"),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(repeated.blob.hash, one.blob.hash);
    assert_eq!(server.requests.load(Ordering::SeqCst), 1);
}
