use super::*;

struct Fixture {
    root: PathBuf,
    db: PathBuf,
    store: BlobStore,
}
impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("hub-attachment-traffic-{}", random_url_safe(12)));
        fs::create_dir_all(&root).unwrap();
        let db = root.join("craft-search.sqlite3");
        let c = open_database(&db).unwrap();
        c.execute("INSERT INTO spaces(id,name,mcp_url,added_at) VALUES('space','Space','https://example.test/mcp',1)",[]).unwrap();
        c.execute("INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES('space','craft','Space',1,1)",[]).unwrap();
        Self {
            store: BlobStore::open(&root.join("blobs")).unwrap(),
            root,
            db,
        }
    }
    fn doc(&self, url: &str, exact: bool, revision: Option<&str>) -> IndexedDocument {
        let markdown = format!("![image.png]({url})");
        IndexedDocument {
            space_id: "space".into(),
            id: "doc".into(),
            title: "Document".into(),
            path: "Document".into(),
            folder_id: None,
            content_hash: format!("{:x}", Sha256::digest(markdown.as_bytes())),
            markdown: markdown.clone(),
            modified_at: None,
            indexed_at: now_timestamp(),
            attachments: if exact {
                discover_attachments_from_json(
                    &json!({"id":"image-block","type":"image","url":url,"fileName":"image.png","fileSize":4,"metadata":{"lastModifiedAt":revision}}),
                )
            } else {
                discover_attachments(&markdown)
            },
            block_hints: Vec::new(),
        }
    }
    fn persist(&self, doc: IndexedDocument) {
        persist_document_batch(&self.db, &self.store, vec![doc]).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        forget_initialized_database(&self.db);
        fs::remove_dir_all(&self.root).unwrap();
    }
}

async fn representation_server(
    responses: Vec<String>,
) -> (Url, tokio::task::JoinHandle<Vec<String>>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target = Url::parse(&format!(
        "http://{}/representation",
        listener.local_addr().unwrap()
    ))
    .unwrap();
    let handle = tokio::spawn(async move {
        let mut requests = Vec::new();
        for response in responses {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0; 1024];
            while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                let n = socket.read(&mut chunk).await.unwrap();
                assert!(n > 0 && request.len() < 16_384);
                request.extend_from_slice(&chunk[..n]);
            }
            requests.push(String::from_utf8(request).unwrap().to_ascii_lowercase());
            socket.write_all(response.as_bytes()).await.unwrap();
        }
        requests
    });
    (target, handle)
}
fn representation_ok(body: &str, tag: &str) -> String {
    format!("HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nETag: {tag}\r\nConnection: close\r\n\r\n{body}",body.len())
}
fn representation_not_modified(tag: Option<&str>) -> String {
    format!(
        "HTTP/1.1 304 Not Modified\r\n{}Connection: close\r\n\r\n",
        tag.map(|t| format!("ETag: {t}\r\n")).unwrap_or_default()
    )
}
async fn representation_job(f: &Fixture, target: &Url) -> PipelineJob {
    let job = claim_enabled_attachment_jobs(&f.db, "download_source", 1)
        .unwrap()
        .remove(0);
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap();
    process_download_job(&f.db, &f.store, &job, &client, None, |_, _| {
        Ok(target.clone())
    })
    .await
    .unwrap();
    assert_eq!(
        open_database(&f.db)
            .unwrap()
            .query_row("SELECT status FROM index_jobs WHERE id=?1", [job.id], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "completed"
    );
    job
}
fn representation_metadata(f: &Fixture) -> Value {
    let raw: String = open_database(&f.db)
        .unwrap()
        .query_row(
            "SELECT metadata_json FROM source_items WHERE source_type='craft_attachment'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    serde_json::from_str(&raw).unwrap()
}

#[tokio::test]
async fn attachment_revalidation_restart_rotating_locator_reuses_only_origin_confirmed_verified_bytes(
) {
    let f = Fixture::new();
    let (target, server) = representation_server(vec![
        representation_ok("test", "\"v1\""),
        representation_not_modified(Some("\"v1\"")),
        representation_ok("next", "\"v2\""),
    ])
    .await;
    f.persist(f.doc("https://r.craft.do/first-opaque-locator", true, None));
    let first = representation_job(&f, &target).await;
    let hash = format!("{:x}", Sha256::digest(b"test"));
    let path = f.store.path_for(&hash).unwrap();
    let modified = fs::metadata(&path).unwrap().modified().unwrap();
    let input =
        attachment_evidence::input_on(&open_database(&f.db).unwrap(), "space", &first.source_id)
            .unwrap();
    forget_initialized_database(&f.db);
    f.persist(f.doc("https://r.craft.do/second-opaque-locator", true, None));
    assert!(
        attachment_evidence::input_on(&open_database(&f.db).unwrap(), "space", &first.source_id)
            .is_err(),
        "old proof must not keep an unverified new locator readable"
    );
    representation_job(&f, &target).await;
    let metadata = representation_metadata(&f);
    assert_eq!(metadata["resourceGeneration"], 1);
    assert_eq!(metadata["cachedResourceGeneration"], 1);
    assert_eq!(metadata["lastRepresentationCheck"]["kind"], "notModified");
    assert_eq!(metadata["lastRepresentationCheck"]["bodyBytes"], 0);
    assert_eq!(metadata["lastRepresentationCheck"]["blobReused"], true);
    assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), modified);
    assert_eq!(
        attachment_evidence::input_on(&open_database(&f.db).unwrap(), "space", &first.source_id)
            .unwrap()
            .version,
        input.version
    );
    f.persist(f.doc("https://r.craft.do/third-opaque-locator", true, None));
    representation_job(&f, &target).await;
    let metadata = representation_metadata(&f);
    assert_eq!(metadata["lastRepresentationCheck"]["kind"], "downloaded");
    assert_eq!(metadata["lastRepresentationCheck"]["blobReused"], false);
    assert_eq!(
        metadata["lastRepresentationCheck"]["blobHash"],
        format!("{:x}", Sha256::digest(b"next"))
    );
    let requests = server.await.unwrap();
    assert!(!requests[0].contains("if-none-match"));
    assert!(requests[1].contains("if-none-match: \"v1\""));
    assert!(requests[2].contains("if-none-match: \"v1\""));
}

#[tokio::test]
async fn attachment_revalidation_missing_weak_or_wrong_validator_and_resource_never_bind_304() {
    for case in ["missing", "weak", "different-tag", "different-resource"] {
        let f = Fixture::new();
        let tag = match case {
            "missing" => None,
            "weak" => Some("W/\"v1\""),
            "different-tag" => Some("\"v2\""),
            _ => Some("\"v1\""),
        };
        let (target, server) = representation_server(vec![
            representation_ok("test", "\"v1\""),
            representation_not_modified(tag),
            representation_ok("next", "\"v2\""),
        ])
        .await;
        f.persist(f.doc("https://r.craft.do/first", true, None));
        representation_job(&f, &target).await;
        f.persist(f.doc("https://r.craft.do/rotated", true, None));
        let mut next = target.clone();
        if case == "different-resource" {
            next.set_path("/another-resource");
        }
        representation_job(&f, &next).await;
        let metadata = representation_metadata(&f);
        assert_eq!(
            metadata["lastRepresentationCheck"]["kind"], "downloaded",
            "{case}"
        );
        assert_eq!(
            metadata["lastRepresentationCheck"]["blobHash"],
            format!("{:x}", Sha256::digest(b"next")),
            "{case}"
        );
        let requests = server.await.unwrap();
        assert!(requests[1].contains("if-none-match"), "{case}");
        assert!(!requests[2].contains("if-none-match"), "{case}");
    }
}

#[tokio::test]
async fn attachment_revalidation_no_store_missing_proof_corruption_or_revision_change_requires_full_body(
) {
    for case in [
        "no-store",
        "missing-proof",
        "corrupt",
        "revision",
        "other-source",
    ] {
        let f = Fixture::new();
        let mut first = representation_ok("test", "\"v1\"");
        if case == "no-store" {
            first = first.replacen(
                "Connection:",
                "Cache-Control: no-store, no-cache\r\nConnection:",
                1,
            );
        }
        let (target, server) =
            representation_server(vec![first, representation_ok("test", "\"v1\"")]).await;
        f.persist(f.doc("https://r.craft.do/first", true, None));
        let job = representation_job(&f, &target).await;
        if case == "missing-proof" {
            open_database(&f.db).unwrap().execute("UPDATE source_items SET metadata_json=json_remove(metadata_json,'$.httpRepresentationProof') WHERE id=?1",[&job.source_id]).unwrap();
        }
        if case == "other-source" {
            open_database(&f.db).unwrap().execute("UPDATE source_items SET metadata_json=json_set(metadata_json,'$.httpRepresentationProof.source','foreign') WHERE id=?1",[&job.source_id]).unwrap();
        }
        if case == "corrupt" {
            fs::write(
                f.store
                    .path_for(&format!("{:x}", Sha256::digest(b"test")))
                    .unwrap(),
                b"xxxx",
            )
            .unwrap();
        }
        f.persist(f.doc(
            "https://r.craft.do/rotated",
            true,
            if case == "revision" { Some("v2") } else { None },
        ));
        representation_job(&f, &target).await;
        let requests = server.await.unwrap();
        assert!(!requests[1].contains("if-none-match"), "{case}");
        assert_eq!(
            representation_metadata(&f)["lastRepresentationCheck"]["kind"],
            "downloaded"
        );
        assert_eq!(
            f.store
                .read(&format!("{:x}", Sha256::digest(b"test")))
                .unwrap(),
            b"test"
        );
    }
}

#[tokio::test]
async fn attachment_revalidation_unversioned_no_validator_compares_fresh_body_and_preserves_local_blob(
) {
    let f = Fixture::new();
    let response = representation_ok("test", "\"unused\"").replace("ETag: \"unused\"\r\n", "");
    let (target, server) = representation_server(vec![response.clone(), response]).await;
    f.persist(f.doc("https://r.craft.do/first", true, None));
    representation_job(&f, &target).await;
    let hash = format!("{:x}", Sha256::digest(b"test"));
    let modified = fs::metadata(f.store.path_for(&hash).unwrap())
        .unwrap()
        .modified()
        .unwrap();
    forget_initialized_database(&f.db);
    f.persist(f.doc("https://r.craft.do/rotated", true, None));
    representation_job(&f, &target).await;
    let metadata = representation_metadata(&f);
    assert_eq!(metadata["lastRepresentationCheck"]["bodyBytes"], 4);
    assert_eq!(metadata["lastRepresentationCheck"]["blobReused"], true);
    assert_eq!(
        fs::metadata(f.store.path_for(&hash).unwrap())
            .unwrap()
            .modified()
            .unwrap(),
        modified
    );
    assert!(!server.await.unwrap()[1].contains("if-none-match"));
}

#[tokio::test]
async fn attachment_revalidation_late_304_cannot_publish_after_source_generation_changes() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let f = Fixture::new();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target = Url::parse(&format!(
        "http://{}/representation",
        listener.local_addr().unwrap()
    ))
    .unwrap();
    let db = f.db.clone();
    let store = f.store.clone();
    let mut newer = Some(f.doc("https://r.craft.do/newest", true, None));
    let server = tokio::spawn(async move {
        for round in 0..2 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let n = socket.read(&mut request).await.unwrap();
            assert!(n > 0);
            let response = if round == 0 {
                representation_ok("test", "\"v1\"")
            } else {
                assert!(String::from_utf8_lossy(&request[..n]).contains("if-none-match"));
                persist_document_batch(&db, &store, vec![newer.take().unwrap()]).unwrap();
                representation_not_modified(Some("\"v1\""))
            };
            socket.write_all(response.as_bytes()).await.unwrap();
        }
    });
    f.persist(f.doc("https://r.craft.do/first", true, None));
    representation_job(&f, &target).await;
    f.persist(f.doc("https://r.craft.do/second", true, None));
    let job = claim_enabled_attachment_jobs(&f.db, "download_source", 1)
        .unwrap()
        .remove(0);
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap();
    process_download_job(&f.db, &f.store, &job, &client, None, |_, _| {
        Ok(target.clone())
    })
    .await
    .unwrap();
    server.await.unwrap();
    let c = open_database(&f.db).unwrap();
    assert!(attachment_evidence::input_on(&c, "space", &job.source_id).is_err());
    let metadata = representation_metadata(&f);
    assert_eq!(metadata["resourceGeneration"], 2);
    assert_ne!(metadata["cachedResourceGeneration"], 2);
    assert_ne!(metadata["lastRepresentationCheck"]["generation"], 2);
}

#[tokio::test]
async fn attachment_traffic_actual_type_is_preserved_and_reuses_downloaded_bytes() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let f = Fixture::new();
    let url = "https://r.craft.do/policy-response";
    f.persist(f.doc(url, true, Some("v1")));
    let job = claim_enabled_attachment_jobs(&f.db, "download_source", 1)
        .unwrap()
        .remove(0);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target = Url::parse(&format!("http://{}/file", listener.local_addr().unwrap())).unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0; 4096];
        let n = stream.read(&mut request).await.unwrap();
        assert!(std::str::from_utf8(&request[..n])
            .unwrap()
            .starts_with("GET "));
        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 4\r\nConnection: close\r\n\r\ntext").await.unwrap();
    });
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    process_download_job(
        &f.db,
        &f.store,
        &job,
        &client,
        None,
        |metadata, provider| {
            attachment_url_from_metadata(metadata, provider)?;
            Ok(target)
        },
    )
    .await
    .unwrap();
    server.await.unwrap();
    let hash = format!("{:x}", Sha256::digest(b"text"));
    let c = open_database(&f.db).unwrap();
    let state: (String, String, String) = c
        .query_row(
            "SELECT status,mime_type,blob_hash FROM source_items WHERE id=?1",
            [&job.source_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    // The original policy always preserves Craft originals. Optional text/OCR
    // processing does not turn a successfully stored ordinary file into deferred.
    assert_eq!(state, ("stored".into(), "text/plain".into(), hash));
    assert_eq!(
        c.query_row("SELECT status FROM index_jobs WHERE id=?1", [job.id], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "completed"
    );
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM index_jobs WHERE source_id=?1 AND job_type!='download_source'",
            [&job.source_id],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    drop(c);
    f.persist(f.doc(url, true, Some("v1")));
    assert!(claim_enabled_attachment_jobs(&f.db, "download_source", 1)
        .unwrap()
        .is_empty());
    open_database(&f.db)
        .unwrap()
        .execute(
            "UPDATE index_jobs SET status='pending',next_attempt_at=0 WHERE id=?1",
            [job.id],
        )
        .unwrap();
    let cached_job = claim_enabled_attachment_jobs(&f.db, "download_source", 1)
        .unwrap()
        .remove(0);
    process_download_job(&f.db, &f.store, &cached_job, &client, None, |_, _| {
        Err("cache reuse must precede network resolution".into())
    })
    .await
    .unwrap();
}

#[test]
fn attachment_traffic_promoted_url_identity_cannot_collide_with_new_reference() {
    let f = Fixture::new();
    let a = "https://r.craft.do/location-a";
    let c = "https://r.craft.do/location-c";
    f.persist(f.doc(a, false, None));
    let old_id = open_database(&f.db)
        .unwrap()
        .query_row(
            "SELECT id FROM source_items WHERE source_type='craft_attachment'",
            [],
            |r| r.get::<_, String>(0),
        )
        .unwrap();
    f.persist(f.doc(a, true, Some("same")));
    f.persist(f.doc(c, true, Some("same")));
    let mut next = f.doc(c, true, Some("same"));
    next.attachments
        .extend(discover_attachments(&format!("![old.png]({a})")));
    f.persist(next);
    let conn = open_database(&f.db).unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM source_items WHERE source_type='craft_attachment'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        2
    );
    assert_eq!(
        conn.query_row(
            "SELECT json_extract(metadata_json,'$.remoteUrl') FROM source_items WHERE id=?1",
            [old_id],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        c
    );
    let ids: Vec<String> = conn
        .prepare("SELECT id FROM source_items WHERE source_type='craft_attachment' ORDER BY id")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    drop(conn);
    let mut repeated = f.doc(c, true, Some("same"));
    repeated
        .attachments
        .extend(discover_attachments(&format!("![old.png]({a})")));
    f.persist(repeated);
    let conn = open_database(&f.db).unwrap();
    let after: Vec<String> = conn
        .prepare("SELECT id FROM source_items WHERE source_type='craft_attachment' ORDER BY id")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        ids, after,
        "new URL reference must retain the allocated identity on later scans"
    );
}

#[tokio::test]
async fn attachment_traffic_text_skip_keeps_attachment_revision_and_existing_text_index() {
    let f = Fixture::new();
    let url = "https://r.craft.do/metadata-only";
    f.persist(f.doc(url, true, Some("v1")));
    let job = claim_enabled_attachment_jobs(&f.db, "download_source", 1)
        .unwrap()
        .remove(0);
    persist_download_success(
        &f.db,
        &job,
        DownloadedSource {
            blob: f.store.put(b"text").unwrap(),
            mime_type: "image/png".into(),
        },
    )
    .unwrap();
    let before_hash = open_database(&f.db)
        .unwrap()
        .query_row("SELECT content_hash FROM documents", [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap();
    let operation = Arc::new(library_runtime::begin(&f.root, "space", "sync").unwrap());
    let update = classify_craft_document_fetch(Some(&before_hash), f.doc(url, true, Some("v2")));
    let CraftFetchedDocument::AttachmentsOnly(document) = update else {
        panic!("same Markdown must retain the freshly discovered attachments")
    };
    let mut batch = vec![document];
    flush_craft_attachment_refresh(&f.db, &mut batch, &operation)
        .await
        .unwrap();
    assert!(batch.is_empty());
    let c = open_database(&f.db).unwrap();
    assert_eq!(
        c.query_row("SELECT content_hash FROM documents", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        before_hash
    );
    let row:(String,i64,bool)=c.query_row("SELECT json_extract(metadata_json,'$.resourceRevision'),json_extract(metadata_json,'$.resourceGeneration'),blob_hash IS NULL FROM source_items WHERE id=?1",[job.source_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
    assert_eq!(row, ("v2".into(), 1, true));
    let mut changed = f.doc(url, true, Some("v2"));
    changed.markdown.push_str("\nchanged body");
    changed.content_hash = format!("{:x}", Sha256::digest(changed.markdown.as_bytes()));
    assert!(matches!(
        classify_craft_document_fetch(Some(&before_hash), changed),
        CraftFetchedDocument::Content(_)
    ));
}
