use super::*;
use crate::{blob_store::BlobStore, discover_attachments_from_json, IndexedDocument};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Component, Path},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const URL: &str = "https://r.craft.do/failure-fixture";
const BYTES: &[u8] = b"\x89PNG\r\n\x1a\nfixture-bytes";

struct Fixture {
    root: PathBuf,
    database: PathBuf,
    store: BlobStore,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hub-attachment-failures-{}",
            crate::random_url_safe(16)
        ));
        fs::create_dir_all(&root).unwrap();
        let database = root.join("craft-search.sqlite3");
        let c = open_database(&database).unwrap();
        c.execute("INSERT INTO spaces(id,name,mcp_url,added_at) VALUES('space','附件失败验证','https://example.test/mcp',1)",[]).unwrap();
        c.execute("INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES('space','craft','附件失败验证',1,1)",[]).unwrap();
        let store = BlobStore::open(&root.join("blobs")).unwrap();
        Self {
            root,
            database,
            store,
        }
    }
    fn persist(&self, id: &str, url: &str, revision: &str) {
        let markdown = format!("![测试附件.png]({url})");
        let doc = IndexedDocument {
            space_id: "space".into(),
            id: id.into(),
            title: format!("附件验证 {id}"),
            path: id.into(),
            folder_id: None,
            content_hash: format!("{:x}", Sha256::digest(markdown.as_bytes())),
            markdown,
            modified_at: Some(10),
            indexed_at: now_timestamp(),
            attachments: discover_attachments_from_json(
                &serde_json::json!({"id":"attachment","type":"image","fileName":"测试附件.png","fileSize":BYTES.len(),"url":url,"metadata":{"lastModifiedAt":revision}}),
            ),
            block_hints: Vec::new(),
        };
        crate::persist_document_batch(&self.database, &self.store, vec![doc]).unwrap();
    }
    fn capture(&self, id: &str, url: &str) -> crate::PreviewDownloadCapture {
        crate::read_preview_download_capture(
            &self.database,
            crate::PROVIDER_CRAFT,
            "space",
            id,
            url,
            None,
        )
        .unwrap()
    }
    fn page(&self, status: &str) -> Page {
        handle(
            &self.database,
            Args {
                status: status.into(),
                ..Default::default()
            },
        )
        .unwrap()
    }
    fn action(&self, action: &str, status: &str, item: &Item) -> Page {
        handle(
            &self.database,
            Args {
                action: action.into(),
                status: status.into(),
                items: vec![target(item)],
                ..Default::default()
            },
        )
        .unwrap()
    }
    async fn preview(
        &self,
        id: &str,
        url: &str,
        server: &Server,
    ) -> Result<(crate::DownloadedSource, String), String> {
        let destination = server.url.clone();
        crate::load_preview_attachment_resolving(
            &self.database,
            &self.store,
            crate::PROVIDER_CRAFT,
            "space",
            id,
            url,
            &server.client,
            || Ok(None),
            false,
            move |capture| {
                crate::attachment_url_from_metadata(&capture.metadata, &capture.provider)?;
                Ok(destination)
            },
        )
        .await
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        crate::forget_initialized_database(&self.database);
        fs::remove_dir_all(&self.root).unwrap();
    }
}
fn target(item: &Item) -> Target {
    Target {
        job_id: item.job_id,
        source_id: item.source_id.clone(),
        resource_generation: item.resource_generation,
        updated_at: item.updated_at,
        status: item.status.clone(),
    }
}

struct Server {
    url: url::Url,
    client: reqwest::Client,
    requests: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}
impl Server {
    async fn new(status: u16) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url =
            url::Url::parse(&format!("http://{}/file", listener.local_addr().unwrap())).unwrap();
        let requests = Arc::new(AtomicUsize::new(0));
        let counter = requests.clone();
        let task = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut buffer = [0_u8; 2048];
                while !request.windows(4).any(|v| v == b"\r\n\r\n") {
                    let count = socket.read(&mut buffer).await.unwrap();
                    assert_ne!(count, 0);
                    request.extend_from_slice(&buffer[..count]);
                    assert!(request.len() < 16384);
                }
                assert!(request.starts_with(b"GET /file HTTP/1.1"));
                counter.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                let body = if status == 200 {
                    BYTES
                } else {
                    b"https://r.craft.do/private?signature=dummy Cookie=dummy".as_slice()
                };
                let header=format!("HTTP/1.1 {status} {}\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",if status==200 {"OK"} else {"Failure"},body.len());
                socket.write_all(header.as_bytes()).await.unwrap();
                socket.write_all(body).await.unwrap();
                socket.shutdown().await.unwrap();
            }
        });
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap();
        Self {
            url,
            client,
            requests,
            task,
        }
    }
    fn count(&self) -> usize {
        self.requests.load(Ordering::SeqCst)
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[tokio::test]
async fn attachment_download_failures_native_fixture_from_real_preview_producer() {
    let fixture = Fixture::new();
    let server = Server::new(404).await;
    fixture.persist("doc", URL, "v1");
    let error = fixture.preview("doc", URL, &server).await.unwrap_err();
    assert!(error.contains("404"));
    assert!(!error.contains("signature") && !error.contains("Cookie"));
    let failed = fixture.page("failed");
    assert_eq!(failed.total, 1);
    assert_eq!(failed.items[0].issue_state, "unavailable");
    let skipped = fixture.action("skip", "failed", &failed.items[0]);
    assert_eq!(skipped.changed, 1);
    assert_eq!(skipped.skipped_count, 1);
    fixture.persist("doc", URL, "v1");
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let blocked = crate::load_preview_attachment_resolving(
        &fixture.database,
        &fixture.store,
        crate::PROVIDER_CRAFT,
        "space",
        "doc",
        URL,
        &client,
        || panic!("skip must not ask for credentials"),
        false,
        |_| panic!("skip must not reach transport"),
    )
    .await
    .unwrap_err();
    assert!(blocked.starts_with("CONTENT_POLICY:"));
    assert_eq!(server.count(), 1);
    let skipped = fixture.page("dismissed");
    let retried = fixture.action("retry", "dismissed", &skipped.items[0]);
    assert_eq!(retried.changed, 1);
    assert_eq!(
        fixture.page("failed").total,
        0,
        "a requeued operation is not a completed download or permanent failure"
    );
    fixture.preview("doc", URL, &server).await.unwrap_err();
    assert_eq!(server.count(), 2);
    let failed = fixture.page("failed");
    assert_eq!(failed.total, 1);
    export_native_fixture(&fixture, &failed);
}

#[tokio::test]
async fn attachment_download_failures_pending_backoff_is_visible_without_another_get() {
    let fixture = Fixture::new();
    let server = Server::new(503).await;
    fixture.persist("doc", URL, "v1");
    fixture.preview("doc", URL, &server).await.unwrap_err();
    let page = fixture.page("failed");
    assert_eq!(page.items[0].issue_state, "scheduled");
    assert_eq!(page.items[0].status, "pending");
    assert!(page.items[0].next_attempt_at.unwrap() > now_timestamp());
    fixture.preview("doc", URL, &server).await.unwrap_err();
    assert_eq!(server.count(), 1);
    fixture.action("retry", "failed", &page.items[0]);
    fixture.preview("doc", URL, &server).await.unwrap_err();
    assert_eq!(server.count(), 2);
}

#[tokio::test]
async fn attachment_download_failures_running_owner_is_preserved_and_actions_are_rejected() {
    let fixture = Fixture::new();
    let server = Server::new(503).await;
    fixture.persist("doc", URL, "v1");
    let job = crate::claim_enabled_attachment_jobs(&fixture.database, "download_source", 1)
        .unwrap()
        .remove(0);
    let before: (String, i64, i64, i64) = open_database(&fixture.database)
        .unwrap()
        .query_row(
            "SELECT worker_id,attempts,locked_at,lease_until FROM index_jobs WHERE id=?1",
            [job.id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();
    fixture.preview("doc", URL, &server).await.unwrap_err();
    let page = fixture.page("failed");
    assert_eq!(page.items[0].issue_state, "retrying");
    assert!(!page.items[0].can_retry && !page.items[0].can_skip);
    assert_eq!(fixture.action("skip", "failed", &page.items[0]).changed, 0);
    assert_eq!(fixture.action("retry", "failed", &page.items[0]).changed, 0);
    let after: (String, i64, i64, i64) = open_database(&fixture.database)
        .unwrap()
        .query_row(
            "SELECT worker_id,attempts,locked_at,lease_until FROM index_jobs WHERE id=?1",
            [job.id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();
    assert_eq!(after, before);
}

#[tokio::test]
async fn attachment_download_failures_stale_generation_and_page_targets_do_not_mutate_siblings() {
    let fixture = Fixture::new();
    let server = Server::new(404).await;
    for id in ["a", "b"] {
        let url = format!("{URL}/{id}");
        fixture.persist(id, &url, "v1");
        fixture.preview(id, &url, &server).await.unwrap_err();
    }
    let page = handle(
        &fixture.database,
        Args {
            limit: 1,
            ..Default::default()
        },
    )
    .unwrap();
    let selected = target(&page.items[0]);
    let result = handle(
        &fixture.database,
        Args {
            action: "skip".into(),
            limit: 1,
            offset: 1,
            items: vec![selected.clone()],
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(
        result.changed, 0,
        "off-page identities cannot expand a bounded action"
    );
    let mut stale = selected.clone();
    stale.resource_generation += 1;
    assert_eq!(
        handle(
            &fixture.database,
            Args {
                action: "skip".into(),
                limit: 1,
                items: vec![stale],
                ..Default::default()
            }
        )
        .unwrap()
        .changed,
        0
    );
    assert_eq!(
        handle(
            &fixture.database,
            Args {
                action: "skip".into(),
                limit: 1,
                items: vec![selected],
                ..Default::default()
            }
        )
        .unwrap()
        .changed,
        1
    );
    assert_eq!(fixture.page("failed").total, 1);
    assert_eq!(fixture.page("dismissed").total, 1);
}

#[tokio::test]
async fn attachment_download_failures_skip_survives_signed_refresh_and_true_revision_reopens() {
    let fixture = Fixture::new();
    let server = Server::new(404).await;
    let old = format!("{URL}?X-Amz-Signature=one");
    fixture.persist("doc", &old, "v1");
    fixture.preview("doc", &old, &server).await.unwrap_err();
    fixture.action("skip", "failed", &fixture.page("failed").items[0]);
    let renewed = format!("{URL}?X-Amz-Signature=two");
    fixture.persist("doc", &renewed, "v1");
    assert_eq!(fixture.page("dismissed").total, 1);
    assert!(
        crate::claim_enabled_attachment_jobs(&fixture.database, "download_source", 1)
            .unwrap()
            .is_empty()
    );
    let mut connection = open_database(&fixture.database).unwrap();
    crate::library_policy::supplement(&mut connection, "space").unwrap();
    assert!(
        crate::claim_enabled_attachment_jobs(&fixture.database, "download_source", 1)
            .unwrap()
            .is_empty()
    );
    fixture.persist("doc", &renewed, "v2");
    assert_eq!(fixture.page("dismissed").total, 0);
    assert_eq!(
        crate::claim_enabled_attachment_jobs(&fixture.database, "download_source", 1)
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn attachment_download_failures_legacy_unknown_skip_holds_until_explicit_retry() {
    let fixture = Fixture::new();
    let server = Server::new(404).await;
    fixture.persist("doc", URL, "v1");
    fixture.preview("doc", URL, &server).await.unwrap_err();
    let page = fixture.page("failed");
    open_database(&fixture.database)
        .unwrap()
        .execute(
            "UPDATE index_jobs SET status='dismissed',payload=NULL WHERE id=?1",
            [page.items[0].job_id],
        )
        .unwrap();
    fixture.persist("doc", URL, "v1");
    assert_eq!(fixture.page("dismissed").total, 1);
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    crate::load_preview_attachment_resolving(
        &fixture.database,
        &fixture.store,
        crate::PROVIDER_CRAFT,
        "space",
        "doc",
        URL,
        &client,
        || panic!("legacy skip cannot reopen credentials"),
        false,
        |_| panic!("legacy skip cannot reopen GET"),
    )
    .await
    .unwrap_err();
    let skipped = fixture.page("dismissed");
    assert_eq!(
        fixture
            .action("retry", "dismissed", &skipped.items[0])
            .changed,
        1
    );
    assert_eq!(
        crate::claim_enabled_attachment_jobs(&fixture.database, "download_source", 1)
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn attachment_download_failures_late_address_failure_cannot_poison_current_source() {
    let fixture = Fixture::new();
    fixture.persist("doc", URL, "v1");
    let capture = fixture.capture("doc", URL);
    let moved = "https://r.craft.do/failure-fixture-moved";
    fixture.persist("doc", moved, "v1");
    record_preview_failure(&capture, "HTTP_STATUS:404 Not Found").unwrap();
    assert_eq!(fixture.page("failed").total, 0);
    assert_eq!(
        fixture.capture("doc", moved).generation(),
        capture.generation()
    );
}

#[tokio::test]
async fn attachment_download_failures_cached_skip_preview_and_retry_preserve_completed_relations() {
    let fixture = Fixture::new();
    let success = Server::new(200).await;
    let missing = Server::new(404).await;
    fixture.persist("first", URL, "v1");
    let job = crate::claim_enabled_attachment_jobs(&fixture.database, "download_source", 1)
        .unwrap()
        .remove(0);
    let destination = success.url.clone();
    crate::process_download_job(
        &fixture.database,
        &fixture.store,
        &job,
        &success.client,
        None,
        move |_, _| Ok(destination),
    )
    .await
    .unwrap();
    let capture = fixture.capture("first", URL);
    let hash = capture.blob_hash.clone().unwrap();
    // Complete through the real OCR commit owner so the result carries the
    // current input proof; a bare legacy status is intentionally not reusable.
    let c = open_database(&fixture.database).unwrap();
    c.execute("UPDATE libraries SET metadata_json='{\"contentPolicy\":{\"imageOcr\":true}}' WHERE id='space'", []).unwrap();
    let input = crate::attachment_evidence::input_on(&c, "space", &capture.source_id).unwrap();
    drop(c);
    let ocr = crate::claim_enabled_attachment_jobs(&fixture.database, "ocr_page", 1)
        .unwrap()
        .remove(0);
    crate::persist_ocr_page_controlled(
        &fixture.database,
        &fixture.store,
        &ocr,
        1,
        "existing result".into(),
        None,
        Some(&input),
    )
    .unwrap();
    fs::write(
        fixture.store.local_path_for(&hash).unwrap(),
        vec![0; BYTES.len()],
    )
    .unwrap();
    fixture.preview("first", URL, &missing).await.unwrap_err();
    fixture.persist("second", URL, "v1");
    fixture.preview("second", URL, &success).await.unwrap();
    assert_eq!(fixture.store.read(&hash).unwrap(), BYTES);
    let second = crate::claim_enabled_attachment_jobs(&fixture.database, "download_source", 1)
        .unwrap()
        .remove(0);
    assert_eq!(second.source_id, fixture.capture("second", URL).source_id);
    crate::process_download_job(
        &fixture.database,
        &fixture.store,
        &second,
        &success.client,
        None,
        |_, _| panic!("second source already has verified bytes"),
    )
    .await
    .unwrap();
    let page = fixture.page("failed");
    let first = page
        .items
        .iter()
        .find(|row| row.document_id == "first")
        .unwrap();
    fixture.action("skip", "failed", first);
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    crate::load_preview_attachment_resolving(
        &fixture.database,
        &fixture.store,
        crate::PROVIDER_CRAFT,
        "space",
        "first",
        URL,
        &client,
        || panic!("cached skip needs no credentials"),
        false,
        |_| panic!("cached skip needs no GET"),
    )
    .await
    .unwrap();
    let before: Vec<(String, String)> = open_database(&fixture.database)
        .unwrap()
        .prepare("SELECT id,status FROM extractions WHERE source_item_id=?1 ORDER BY id")
        .unwrap()
        .query_map([&capture.source_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let page = fixture.page("dismissed");
    let first = page
        .items
        .iter()
        .find(|row| row.document_id == "first")
        .unwrap();
    fixture.action("retry", "dismissed", first);
    let job = crate::claim_enabled_attachment_jobs(&fixture.database, "download_source", 1)
        .unwrap()
        .remove(0);
    assert_eq!(job.source_id, capture.source_id);
    crate::process_download_job(
        &fixture.database,
        &fixture.store,
        &job,
        &client,
        None,
        |_, _| panic!("explicit retry must reuse verified bytes"),
    )
    .await
    .unwrap();
    let after: Vec<(String, String)> = open_database(&fixture.database)
        .unwrap()
        .prepare("SELECT id,status FROM extractions WHERE source_item_id=?1 ORDER BY id")
        .unwrap()
        .query_map([&capture.source_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(after, before);
    assert_eq!(success.count(), 2);
    assert_eq!(missing.count(), 1);
}

#[tokio::test]
async fn attachment_download_failures_successful_cache_read_retires_terminal_error_and_resumes_local_pipeline(
) {
    let fixture = Fixture::new();
    let missing = Server::new(404).await;
    let success = Server::new(200).await;
    fixture.persist("failed", URL, "v1");
    fixture.preview("failed", URL, &missing).await.unwrap_err();
    assert_eq!(fixture.page("failed").items[0].status, "completed");
    fixture.persist("repair", URL, "v1");
    fixture.preview("repair", URL, &success).await.unwrap();
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    crate::load_preview_attachment_resolving(
        &fixture.database,
        &fixture.store,
        crate::PROVIDER_CRAFT,
        "space",
        "failed",
        URL,
        &client,
        || panic!("shared cache recovery needs no credentials"),
        false,
        |_| panic!("shared cache recovery must not GET"),
    )
    .await
    .unwrap();
    assert_eq!(fixture.page("failed").total, 0);
    assert_eq!(missing.count(), 1);
    assert_eq!(success.count(), 1);
    let c = open_database(&fixture.database).unwrap();
    let capture = fixture.capture("failed", URL);
    let state:(String,Option<String>,i64,i64)=c.query_row("SELECT status,last_error,attempts,next_attempt_at FROM index_jobs WHERE source_id=?1 AND job_type='download_source'",
      [&capture.source_id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).unwrap();
    assert_eq!(state, ("pending".into(), None, 0, 0));
    let jobs =
        crate::claim_enabled_attachment_jobs(&fixture.database, "download_source", 2).unwrap();
    assert_eq!(jobs.len(), 2);
    for job in jobs {
        crate::process_download_job(
            &fixture.database,
            &fixture.store,
            &job,
            &client,
            None,
            |_, _| panic!("local pipeline cannot redownload verified bytes"),
        )
        .await
        .unwrap();
    }
    assert_eq!(
        c.query_row(
            "SELECT status FROM index_jobs WHERE source_id=?1 AND job_type='download_source'",
            [&capture.source_id],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        "completed"
    );
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM extractions WHERE source_item_id=?1",
            [&capture.source_id],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    crate::load_preview_attachment_resolving(
        &fixture.database,
        &fixture.store,
        crate::PROVIDER_CRAFT,
        "space",
        "failed",
        URL,
        &client,
        || panic!("successful completed cache needs no credentials"),
        false,
        |_| panic!("successful completed cache must not GET"),
    )
    .await
    .unwrap();
    assert_eq!(
        c.query_row(
            "SELECT status FROM index_jobs WHERE source_id=?1 AND job_type='download_source'",
            [&capture.source_id],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        "completed",
        "successful completion must not reopen on preview"
    );
}

#[tokio::test]
async fn attachment_download_failures_legacy_bulk_exclusion_and_skip_marker_use_the_formal_job() {
    let fixture = Fixture::new();
    let failure = Server::new(503).await;
    fixture.persist("doc", URL, "v1");
    for _ in 0..crate::INDEX_JOB_MAX_ATTEMPTS {
        fixture.preview("doc", URL, &failure).await.unwrap_err();
        open_database(&fixture.database).unwrap().execute("UPDATE index_jobs SET next_attempt_at=0 WHERE job_type='download_source' AND status='pending'",[]).unwrap();
    }
    assert_eq!(failure.count(), crate::INDEX_JOB_MAX_ATTEMPTS as usize);
    assert_eq!(fixture.page("failed").items[0].status, "failed");
    assert_eq!(
        crate::retry_failed_index_jobs(&fixture.database, None, true).unwrap(),
        0
    );
    assert_eq!(
        crate::dismiss_failed_index_jobs(&fixture.database, None, true).unwrap(),
        0
    );
    assert_eq!(
        crate::dismiss_failed_index_jobs(&fixture.database, None, false).unwrap(),
        1
    );
    let skipped = fixture.page("dismissed");
    assert_eq!(skipped.total, 1);
    let marker:i64=open_database(&fixture.database).unwrap().query_row("SELECT json_extract(payload,'$.downloadSkippedGeneration') FROM index_jobs WHERE id=?1",
      [skipped.items[0].job_id],|row|row.get(0)).unwrap();
    assert_eq!(marker, skipped.items[0].resource_generation as i64);
    assert_eq!(
        crate::retry_failed_index_jobs(&fixture.database, None, false).unwrap(),
        0,
        "the legacy retry cannot reopen dismissed jobs"
    );
    fixture.persist("doc", URL, "v1");
    assert_eq!(fixture.page("dismissed").total, 1);
    assert_eq!(
        fixture
            .action("retry", "dismissed", &fixture.page("dismissed").items[0])
            .changed,
        1
    );
}

#[test]
fn attachment_download_failures_redaction_and_legacy_version_contract() {
    for secret in [
        "https://r.craft.do/path?X-Amz-Signature=secret",
        "Cookie: private",
        "Authorization: Bearer private",
        "token=private",
    ] {
        let clean = public_error(secret);
        assert!(!clean.contains("secret") && !clean.contains("private"));
    }
    assert!(skip_value("dismissed", None, 9));
    assert!(skip_value(
        "dismissed",
        Some(r#"{"resourceGeneration":9}"#),
        9
    ));
    assert!(!skip_value(
        "dismissed",
        Some(r#"{"resourceGeneration":8}"#),
        9
    ));
    assert!(!skip_value(
        "pending",
        Some(r#"{"downloadSkippedGeneration":8}"#),
        9
    ));
}

fn export_native_fixture(fixture: &Fixture, page: &Page) {
    let Some(requested) = std::env::var_os("HUB_ATTACHMENT_FAILURE_FIXTURE_ROOT") else {
        return;
    };
    let requested = PathBuf::from(requested);
    let task_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("task-state")
        .canonicalize()
        .unwrap();
    let expected_parent = requested.parent().unwrap().canonicalize().unwrap();
    assert_eq!(expected_parent.parent().unwrap(), task_root);
    assert!(
        requested.is_absolute()
            && !requested
                .components()
                .any(|c| matches!(c, Component::ParentDir))
    );
    assert_eq!(requested.file_name().unwrap(), "failure-owned-runtime");
    assert_eq!(
        requested.parent().unwrap().canonicalize().unwrap(),
        expected_parent
    );
    assert!(
        !requested.exists(),
        "a native fixture is only published into its new task-owned root"
    );
    for ancestor in requested.ancestors().skip(1) {
        let metadata = fs::symlink_metadata(ancestor).unwrap();
        assert!(metadata.is_dir() && !metadata.file_type().is_symlink());
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            assert_eq!(metadata.file_attributes() & 0x400, 0);
        }
    }
    let root = crate::isolated_runtime::prepare_test_root(requested).unwrap();
    assert_eq!(
        root.parent().unwrap().canonicalize().unwrap(),
        expected_parent
    );
    let (connection, _writer) = open_write_database(&fixture.database).unwrap();
    connection
        .execute(
            "VACUUM INTO ?1",
            [root.join("craft-search.sqlite3").to_string_lossy().as_ref()],
        )
        .unwrap();
    let mut q = connection
        .prepare("SELECT hash FROM blobs ORDER BY hash")
        .unwrap();
    let hashes = q
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    for hash in hashes {
        let original = fixture.store.local_path_for(&hash).unwrap();
        if !original.is_file() {
            continue;
        }
        let target = root.join("blobs").join(&hash[..2]).join(&hash);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::copy(original, target).unwrap();
    }
    let summary = serde_json::json!({"schema":"hub-attachment-failure-fixture/v1","ready":true,"backgroundWorkers":false,
      "failedCount":page.failed_count,"skippedCount":page.skipped_count,"issues":page.items.iter().map(|item|serde_json::json!({
        "jobId":item.job_id,"sourceId":item.source_id,"resourceGeneration":item.resource_generation,"status":item.status,
        "issueState":item.issue_state,"error":item.error})).collect::<Vec<_>>()});
    fs::write(
        root.join("fixture-summary.json"),
        serde_json::to_vec_pretty(&summary).unwrap(),
    )
    .unwrap();
}
