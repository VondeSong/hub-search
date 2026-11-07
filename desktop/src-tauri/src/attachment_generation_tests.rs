use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const RESOURCE_URL: &str = "https://r.craft.do/generation-resource";

struct GenerationFixture {
    root: PathBuf,
    database: PathBuf,
    store: BlobStore,
}

impl GenerationFixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("hub-attachment-generation-{}", random_url_safe(16)));
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

    fn document(&self, url: &str, revision: &str) -> IndexedDocument {
        let markdown = format!("![image.png]({url})");
        let attachments = discover_attachments_from_json(&json!({
            "id": "image-block", "type": "image", "url": url,
            "fileName": "image.png", "fileSize": 4,
            "metadata": {"lastModifiedAt": revision}
        }));
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

    fn persist(&self, url: &str, revision: &str) {
        persist_document_batch(
            &self.database,
            &self.store,
            vec![self.document(url, revision)],
        )
        .unwrap();
    }

    fn refresh(&self, url: &str, revision: &str) {
        persist_attachment_refresh_batch(&self.database, &[self.document(url, revision)]).unwrap();
    }

    fn claim(&self) -> PipelineJob {
        let mut jobs = claim_enabled_attachment_jobs(&self.database, "download_source", 1).unwrap();
        assert_eq!(jobs.len(), 1);
        jobs.remove(0)
    }

    fn source(&self, source_id: &str) -> (String, Option<String>, String) {
        open_database(&self.database)
            .unwrap()
            .query_row(
                "SELECT status,blob_hash,metadata_json FROM source_items WHERE id=?1",
                [source_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap()
    }

    fn generation(&self, job: &PipelineJob) -> u64 {
        attachment_download_cache::resource_generation(&self.source(&job.source_id).2)
    }

    fn job_state(&self, job: &PipelineJob) -> (String, Option<String>, Option<String>) {
        open_database(&self.database)
            .unwrap()
            .query_row(
                "SELECT status,worker_id,last_error FROM index_jobs WHERE id=?1",
                [job.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap()
    }
}

impl Drop for GenerationFixture {
    fn drop(&mut self) {
        forget_initialized_database(&self.database);
        fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn craft_attachment_cache_old_success_cannot_publish_into_new_generation() {
    let fixture = GenerationFixture::new();
    fixture.persist(RESOURCE_URL, "version-1");
    let job = fixture.claim();
    let operation = begin_pipeline_operation(&fixture.database, &job, "download_source").unwrap();
    let old_generation = fixture.generation(&job);
    let old_blob = fixture.store.put(b"old1").unwrap();
    let old_hash = old_blob.hash.clone();
    fixture.refresh(RESOURCE_URL, "version-2");
    assert_ne!(fixture.generation(&job), old_generation);
    let result = persist_download_success_guarded(
        &fixture.database,
        &job,
        DownloadedSource {
            blob: old_blob,
            mime_type: "image/png".into(),
        },
        Some(&operation),
        Some(old_generation),
        false,
    );
    assert!(result.as_ref().unwrap_err().starts_with("CONTENT_POLICY:"));
    finish_pipeline_result(&fixture.database, &job, result).unwrap();
    let source = fixture.source(&job.source_id);
    assert_eq!(source.0, "discovered");
    assert!(source.1.is_none());
    assert_eq!(fixture.job_state(&job), ("pending".into(), None, None));
    let old_published: bool = open_database(&fixture.database)
        .unwrap()
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM blobs WHERE hash=?1)",
            [&old_hash],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        !old_published,
        "stale bytes cannot be published as the new resource"
    );
}

#[test]
fn craft_attachment_cache_old_url_failure_requeues_current_revision() {
    let fixture = GenerationFixture::new();
    fixture.persist(RESOURCE_URL, "version-1");
    let job = fixture.claim();
    let operation = begin_pipeline_operation(&fixture.database, &job, "download_source").unwrap();
    let generation = fixture.generation(&job);
    let current_url = "https://r.craft.do/rotated-resource";
    fixture.refresh(current_url, "version-1");
    assert_eq!(fixture.generation(&job), generation);
    let result = fail_pipeline_job_guarded(
        &fixture.database,
        &job,
        "HTTP_STATUS:404",
        true,
        Some(&operation),
        Some(generation),
        Some(RESOURCE_URL),
    );
    assert!(result.as_ref().unwrap_err().starts_with("CONTENT_POLICY:"));
    finish_pipeline_result(&fixture.database, &job, result).unwrap();
    let source = fixture.source(&job.source_id);
    assert_eq!(source.0, "discovered");
    assert_eq!(
        serde_json::from_str::<Value>(&source.2).unwrap()["remoteUrl"],
        current_url
    );
    assert_eq!(fixture.job_state(&job), ("pending".into(), None, None));
}

#[test]
fn craft_attachment_cache_old_owner_failure_cannot_change_current_source() {
    let fixture = GenerationFixture::new();
    fixture.persist(RESOURCE_URL, "version-1");
    let old_job = fixture.claim();
    let operation =
        begin_pipeline_operation(&fixture.database, &old_job, "download_source").unwrap();
    let generation = fixture.generation(&old_job);
    open_database(&fixture.database)
        .unwrap()
        .execute(
            "UPDATE index_jobs SET lease_until=0 WHERE id=?1",
            [old_job.id],
        )
        .unwrap();
    // The normal claim boundary recovers the expired lease and assigns a new owner.
    let current_job = fixture.claim();
    assert_eq!(current_job.id, old_job.id);
    assert_ne!(current_job.worker_id, old_job.worker_id);
    let before_source = fixture.source(&current_job.source_id);
    let before_job = fixture.job_state(&current_job);
    let result = fail_pipeline_job_guarded(
        &fixture.database,
        &old_job,
        "HTTP_STATUS:404",
        true,
        Some(&operation),
        Some(generation),
        Some(RESOURCE_URL),
    );
    assert!(result.as_ref().unwrap_err().starts_with("CONTENT_POLICY:"));
    finish_pipeline_result(&fixture.database, &old_job, result).unwrap();
    assert_eq!(fixture.source(&current_job.source_id), before_source);
    assert_eq!(fixture.job_state(&current_job), before_job);
}

struct LocalResourceServer {
    url: Url,
    requests: Arc<AtomicUsize>,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl LocalResourceServer {
    async fn start() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!(
            "http://{}/resource",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let requests = Arc::new(AtomicUsize::new(0));
        let count = requests.clone();
        let (stop, mut stopped) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            loop {
                let accepted = tokio::select! {
                    _ = &mut stopped => break,
                    accepted = listener.accept() => accepted,
                };
                let (mut stream, _) = accepted.unwrap();
                let mut request = Vec::new();
                while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                    let mut buffer = [0_u8; 1024];
                    let read = stream.read(&mut buffer).await.unwrap();
                    assert!(read > 0 && request.len() + read <= 8192);
                    request.extend_from_slice(&buffer[..read]);
                }
                assert!(request.starts_with(b"GET "));
                let index = count.fetch_add(1, Ordering::SeqCst);
                let body = if index == 0 { b"old1" } else { b"new2" };
                stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nContent-Type: image/png\r\nConnection: close\r\n\r\n").await.unwrap();
                stream.write_all(body).await.unwrap();
                stream.shutdown().await.unwrap();
            }
        });
        Self {
            url,
            requests,
            stop: Some(stop),
            task: Some(task),
        }
    }

    async fn finish(mut self) -> usize {
        self.stop.take().unwrap().send(()).unwrap();
        let mut task = self.task.take().unwrap();
        match tokio::time::timeout(Duration::from_secs(5), &mut task).await {
            Ok(result) => result.unwrap(),
            Err(_) => {
                task.abort();
                let _ = task.await;
                panic!("local attachment server did not stop");
            }
        }
        self.requests.load(Ordering::SeqCst)
    }
}

impl Drop for LocalResourceServer {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

#[tokio::test]
async fn craft_attachment_cache_local_get_replacement_downloads_only_new_generation() {
    let server = LocalResourceServer::start().await;
    let fixture = GenerationFixture::new();
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let mut hashes = Vec::new();
    let mut last_job = None;
    for revision in ["version-1", "version-2"] {
        if revision == "version-1" {
            fixture.persist(RESOURCE_URL, revision);
        } else {
            fixture.refresh(RESOURCE_URL, revision);
        }
        let job = fixture.claim();
        let operation =
            begin_pipeline_operation(&fixture.database, &job, "download_source").unwrap();
        let generation = fixture.generation(&job);
        let guard = attachment_download_cache::RequestGuard {
            path: &fixture.database,
            job: &job,
            generation: Some(generation),
        };
        // The transport alone receives the loopback test URL. Discovery and
        // persistence still consume the provider's normal structured resource.
        let downloaded = download_source_to_blob_guarded(
            &client,
            &fixture.store,
            server.url.clone(),
            None,
            Some(&operation),
            Some(&guard),
        )
        .await
        .unwrap();
        assert_eq!(downloaded.blob.size, 4);
        let hash = downloaded.blob.hash.clone();
        persist_download_success_guarded(
            &fixture.database,
            &job,
            downloaded,
            Some(&operation),
            Some(generation),
            false,
        )
        .unwrap();
        assert_eq!(
            fixture.source(&job.source_id).1.as_deref(),
            Some(hash.as_str())
        );
        hashes.push(hash);
        fixture.refresh(RESOURCE_URL, revision);
        assert!(
            claim_enabled_attachment_jobs(&fixture.database, "download_source", 10)
                .unwrap()
                .is_empty()
        );
        last_job = Some(job);
    }
    assert_ne!(
        hashes[0], hashes[1],
        "same-size replacement must publish new bytes"
    );
    assert_eq!(server.requests.load(Ordering::SeqCst), 2);
    let job = last_job.unwrap();
    let (_, _, metadata) = fixture.source(&job.source_id);
    let mut metadata: Value = serde_json::from_str(&metadata).unwrap();
    metadata["remoteUrl"] = json!("http://127.0.0.1:1/must-not-be-requested");
    let connection = open_database(&fixture.database).unwrap();
    connection
        .execute(
            "UPDATE source_items SET metadata_json=?1 WHERE id=?2",
            params![metadata.to_string(), job.source_id],
        )
        .unwrap();
    connection.execute("UPDATE index_jobs SET status='pending',next_attempt_at=0,worker_id=NULL,locked_at=NULL,lease_until=NULL WHERE id=?1", [job.id]).unwrap();
    drop(connection);
    assert_eq!(
        process_download_jobs(&fixture.database, &fixture.store, 1, None)
            .await
            .unwrap(),
        1
    );
    assert_eq!(fixture.job_state(&job), ("completed".into(), None, None));
    assert_eq!(
        fixture.source(&job.source_id).1.as_deref(),
        Some(hashes[1].as_str())
    );
    assert_eq!(
        server.finish().await,
        2,
        "a duplicate cached task must not issue another GET"
    );
}
