//! Explicitly scoped production IPC verification; never a second synchronization engine.
use super::*;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize};
mod diagnostics;
pub(crate) use diagnostics::Request as McpRequestObservation;

const MAX_METADATA: u64 = 4 * 1024 * 1024;
const MAX_BLOBS: u64 = 3 * 1024 * 1024;
static STARTED: AtomicBool = AtomicBool::new(false);
struct MetadataBudget {
    received: AtomicU64,
    maximum: u64,
}
tokio::task_local! { static METADATA: Arc<MetadataBudget>; }
struct TransferBudget {
    allowed: bool,
    gets: AtomicUsize,
    received: AtomicU64,
}
tokio::task_local! { static TRANSFERS: Arc<TransferBudget>; }
tokio::task_local! { static REVALIDATE: bool; }
pub(crate) fn requires_fresh_original() -> bool {
    TRANSFERS.try_with(|budget| budget.allowed).unwrap_or(false)
}
pub(crate) fn allows_conditional_revalidation() -> bool {
    !requires_fresh_original() || REVALIDATE.try_with(|enabled| *enabled).unwrap_or(false)
}
// The original streaming downloader owns these observations. A cache resolver
// invocation or file size is not evidence that a network GET happened.
pub(crate) fn attachment_get_limit(maximum: u64) -> Result<u64, String> {
    let Ok(budget) = TRANSFERS.try_with(Arc::clone) else {
        return Ok(maximum);
    };
    let remaining = MAX_BLOBS.saturating_sub(budget.received.load(Ordering::Relaxed));
    if !budget.allowed || remaining == 0 {
        return Err("PROBE_TRANSFER_LIMIT".into());
    }
    budget
        .gets
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
            (n < 3).then_some(n + 1)
        })
        .map_err(|_| "PROBE_TRANSFER_LIMIT")?;
    Ok(maximum.min(remaining))
}
pub(crate) fn attachment_bytes(n: usize) -> Result<(), String> {
    if let Ok(budget) = TRANSFERS.try_with(Arc::clone) {
        let total = budget
            .received
            .fetch_add(n as u64, Ordering::Relaxed)
            .saturating_add(n as u64);
        if total > MAX_BLOBS {
            return Err("PROBE_TRANSFER_LIMIT".into());
        }
    }
    Ok(())
}
pub(crate) fn limited() -> bool {
    METADATA.try_with(|_| ()).is_ok()
}
pub(crate) fn page_limit() -> u64 {
    if limited() {
        2
    } else {
        1_000
    }
}

// The scoped operation additionally accounts aggregate metadata across retries.
pub(crate) async fn response_text(mut response: reqwest::Response) -> Result<String, String> {
    let Ok(budget) = METADATA.try_with(Arc::clone) else {
        if !response.status().is_success() {
            return Ok(crate::http_body::diagnostic(response).await);
        }
        return crate::http_body::text(response, crate::http_body::MCP_BYTES).await;
    };
    let remaining = budget
        .maximum
        .saturating_sub(budget.received.load(Ordering::Relaxed));
    if response
        .content_length()
        .is_some_and(|size| size > remaining)
    {
        return Err("PROBE_METADATA_LIMIT".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "PROBE_METADATA_READ_FAILED")?
    {
        let total = budget
            .received
            .fetch_add(chunk.len() as u64, Ordering::Relaxed)
            .saturating_add(chunk.len() as u64);
        if total > budget.maximum {
            return Err("PROBE_METADATA_LIMIT".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| "PROBE_METADATA_ENCODING".into())
}

struct ScopedCredentialReader<'a> {
    library: &'a str,
    document: &'a str,
}
impl oauth_credentials::SecretStore for ScopedCredentialReader<'_> {
    fn get(&self, id: &str) -> Result<Option<String>, String> {
        isolated_runtime::require_craft_probe(self.library, self.document)?;
        // oauth_credentials::load owns chunk validation and generation/hash verification.
        if id != self.library
            && !id.starts_with(&format!("{}:generation:", self.library))
            && !id.starts_with(&format!("{}:chunk:", self.library))
        {
            return Err("PROBE_CREDENTIAL_SCOPE".into());
        }
        #[cfg(windows)]
        {
            match personal_credential_entry(id)?.get_password() {
                Ok(value) => Ok(Some(value)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(_) => Err("PROBE_CREDENTIAL_UNAVAILABLE".into()),
            }
        }
        #[cfg(not(windows))]
        {
            Err("PROBE_WINDOWS_REQUIRED".into())
        }
    }
    fn set(&self, _: &str, _: &str) -> Result<(), String> {
        Err("PROBE_CREDENTIAL_READ_ONLY".into())
    }
    fn delete(&self, _: &str) -> Result<(), String> {
        Err("PROBE_CREDENTIAL_READ_ONLY".into())
    }
}
fn fresh_token(credential: &StoredCredential) -> Result<String, String> {
    if !credential_access_token_is_fresh(credential) {
        return Err("PROBE_AUTH_NOT_FRESH".into());
    }
    credential
        .access_token
        .clone()
        .ok_or_else(|| "PROBE_AUTH_NOT_FRESH".into())
}
fn credential(library: &str, document: &str) -> Result<StoredCredential, String> {
    let raw = oauth_credentials::load(&ScopedCredentialReader { library, document }, library)?
        .ok_or("PROBE_CREDENTIAL_UNAVAILABLE")?;
    let credential: StoredCredential =
        serde_json::from_str(&raw).map_err(|_| "PROBE_CREDENTIAL_INVALID")?;
    fresh_token(&credential)?;
    Ok(credential)
}

fn scoped_sources(db: &PathBuf, library: &str, document: &str) -> Result<Vec<String>, String> {
    let c = open_database(db)?;
    let counts: (u64,u64,u64) = c.query_row("SELECT (SELECT count(*) FROM libraries),
        (SELECT count(*) FROM documents), (SELECT count(*) FROM source_items WHERE source_type='craft_attachment')", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|_| "PROBE_INVENTORY_INVALID")?;
    // A text-only page is a valid single-page trial. An attachment source with
    // missing bytes must still fail below; it cannot become an empty inventory.
    if counts.0 != 1 || counts.1 != 1 || counts.2 > 3 {
        return Err("PROBE_INVENTORY_LIMIT".into());
    }
    let foreign: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM source_items WHERE space_id!=?1 OR document_id!=?2
        OR source_type NOT IN ('craft_attachment','craft_document')) OR (SELECT count(*) FROM source_items WHERE source_type='craft_document')>1
        OR NOT EXISTS(SELECT 1 FROM libraries WHERE id=?1 AND provider='craft')
        OR NOT EXISTS(SELECT 1 FROM documents WHERE space_id=?1 AND id=?2)",
        params![library,document], |r| r.get(0)).map_err(|_| "PROBE_INVENTORY_INVALID")?;
    if foreign {
        return Err("PROBE_INVENTORY_SCOPE".into());
    }
    let mut q = c.prepare("SELECT id FROM source_items WHERE space_id=?1 AND document_id=?2 AND provider='craft' AND source_type='craft_attachment' ORDER BY id").map_err(|_|"PROBE_INVENTORY_INVALID")?;
    let ids = q
        .query_map(params![library, document], |r| r.get::<_, String>(0))
        .map_err(|_| "PROBE_INVENTORY_INVALID")?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "PROBE_INVENTORY_INVALID")?;
    if ids.len() as u64 != counts.2 {
        return Err("PROBE_INVENTORY_SCOPE".into());
    }
    Ok(ids)
}
fn originals(
    db: &PathBuf,
    store: &BlobStore,
    library: &str,
    document: &str,
) -> Result<Vec<(String, String, u64)>, String> {
    let ids = scoped_sources(db, library, document)?;
    let c = open_database(db)?;
    let mut q = c.prepare("SELECT s.id,s.blob_hash,b.size FROM source_items s JOIN blobs b ON b.hash=s.blob_hash
        WHERE s.space_id=?1 AND s.document_id=?2 AND s.provider='craft' AND s.source_type='craft_attachment' ORDER BY s.id").map_err(|_| "PROBE_INVENTORY_INVALID")?;
    let rows = q
        .query_map(params![library, document], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, u64>(2)?,
            ))
        })
        .map_err(|_| "PROBE_INVENTORY_INVALID")?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "PROBE_INVENTORY_INVALID")?;
    if rows.len() != ids.len() {
        return Err("PROBE_ORIGINAL_MISSING".into());
    }
    if rows.iter().any(|v| v.2 == 0) || rows.iter().map(|v| v.2).sum::<u64>() > MAX_BLOBS {
        return Err("PROBE_INVENTORY_LIMIT".into());
    }
    for (_, hash, size) in &rows {
        let path = store.path_for(hash).map_err(|_| "PROBE_ORIGINAL_INVALID")?;
        if fs::metadata(path)
            .map_err(|_| "PROBE_ORIGINAL_MISSING")?
            .len()
            != *size
        {
            return Err("PROBE_ORIGINAL_INVALID".into());
        }
        let bytes = store.read(hash).map_err(|_| "PROBE_ORIGINAL_MISSING")?;
        if bytes.len() as u64 != *size || format!("{:x}", Sha256::digest(&bytes)) != *hash {
            return Err("PROBE_ORIGINAL_INVALID".into());
        }
    }
    Ok(rows)
}

// Only an explicitly owned isolated profile may reschedule these exact originals.
// The real claimant and worker commit completion; this seam never certifies success.
fn reschedule(
    db: &PathBuf,
    library: &str,
    document: &str,
    sources: &[String],
) -> Result<(), String> {
    isolated_runtime::require_craft_probe(library, document)?;
    let (mut c, _writer) = open_write_database(db)?;
    reschedule_on(&mut c, library, document, sources)
}
fn reschedule_on(
    c: &mut Connection,
    library: &str,
    document: &str,
    sources: &[String],
) -> Result<(), String> {
    let tx = c.transaction().map_err(|_| "PROBE_QUEUE_FAILED")?;
    for id in sources {
        let n = tx.execute("INSERT INTO index_jobs(job_key,space_id,source_id,source_type,job_type,status,priority,created_at,updated_at)
            SELECT 'download:'||id,space_id,id,source_type,'download_source','pending',30,?4,?4 FROM source_items
            WHERE id=?1 AND space_id=?2 AND document_id=?3
            ON CONFLICT(job_key) DO UPDATE SET status='pending',updated_at=excluded.updated_at,next_attempt_at=0,
            worker_id=NULL,locked_at=NULL,lease_until=NULL WHERE index_jobs.status IN ('completed','done')",
            params![id,library,document,now_timestamp()]).map_err(|_| "PROBE_QUEUE_FAILED")?;
        if n != 1 {
            // A real discovery may already have queued this exact download.
            // Keep that intent intact; never steal a claimed or leased job.
            let pending: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM index_jobs j JOIN source_items s ON s.id=j.source_id
                WHERE j.job_key='download:'||?1 AND j.source_id=?1 AND j.space_id=?2 AND s.document_id=?3
                AND j.job_type='download_source' AND j.status='pending' AND j.worker_id IS NULL
                AND j.locked_at IS NULL AND COALESCE(j.lease_until,0)=0)",
                params![id,library,document], |r|r.get(0)).map_err(|_|"PROBE_QUEUE_FAILED")?;
            if !pending {
                return Err("PROBE_QUEUE_BUSY".into());
            }
        }
    }
    tx.commit().map_err(|_| "PROBE_QUEUE_FAILED".into())
}
async fn cache_only_job(
    db: &PathBuf,
    store: &BlobStore,
    job: &PipelineJob,
    client: &reqwest::Client,
) -> Result<(), String> {
    let resolutions = AtomicUsize::new(0);
    process_download_job(db, store, job, client, None, |_, _| {
        resolutions.fetch_add(1, Ordering::Relaxed);
        Err("PROBE_CACHE_MISS".into())
    })
    .await?;
    if resolutions.load(Ordering::Relaxed) != 0 {
        return Err("PROBE_CACHE_MISS".into());
    }
    let done: bool = open_database(db)?
        .query_row(
            "SELECT status IN ('completed','done') FROM index_jobs WHERE id=?1",
            [job.id],
            |r| r.get(0),
        )
        .map_err(|_| "PROBE_QUEUE_FAILED")?;
    if !done {
        return Err("PROBE_CACHE_NOT_COMPLETED".into());
    }
    Ok(())
}

async fn controlled<T>(
    operation: &library_runtime::Operation,
    future: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    tokio::pin!(future);
    let mut tick = tokio::time::interval(Duration::from_millis(250));
    loop {
        tokio::select! {
            result = &mut future => return result,
            _ = tick.tick() => operation.checkpoint().map_err(|_| "PROBE_CANCELLED")?,
        }
    }
}

async fn run(
    app: &AppHandle,
    library: &str,
    document: &str,
    allow_original_download: bool,
) -> Result<Value, String> {
    isolated_runtime::require_craft_probe(library, document)?;
    let db = database_path(app)?;
    let store = BlobStore::open(&blob_store_path(app)?)?;
    let before = scoped_sources(&db, library, document)?;
    // A fresh read may repair missing proof, but missing proof must never be
    // accepted by the cache-only mode or replaced with invented hashes.
    let mut verified = if allow_original_download {
        Vec::new()
    } else {
        originals(&db, &store, library, document)?
    };
    let operation = Arc::new(library_runtime::begin(
        isolated_runtime::root().ok_or("PROBE_SCOPE_REQUIRED")?,
        library,
        "单页缓存验证",
    )?);
    diagnostics::phase("credential", 0);
    let saved = credential(library, document)?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| "PROBE_CLIENT_FAILED")?;
    let download_client = allow_original_download
        .then(attachment_http_client)
        .transpose()
        .map_err(|_| "PROBE_CLIENT_FAILED")?;
    diagnostics::phase("connect", 0);
    let connection = controlled(
        &operation,
        initialize_authenticated_connection(&client, &saved.mcp_url, fresh_token(&saved)?),
    )
    .await?;
    if connection.session.space_id != library {
        return Err("PROBE_SESSION_SCOPE".into());
    }
    let mut rounds = Vec::new();
    for round in 0..2 {
        diagnostics::phase("fetchPage", round + 1);
        operation.checkpoint()?;
        operation.phase("fetching", "读取指定 Craft 页面")?;
        let candidate = open_database(&db)?.query_row("SELECT title,path,folder_id,modified_at,content_hash FROM documents WHERE space_id=?1 AND id=?2",
            params![library,document], |r| Ok(PendingDocumentFetch { request_id: 100+round*10, id:document.into(),
                title:r.get(0)?,path:r.get(1)?,folder_id:r.get(2)?,modified_at:r.get(3)?,unchanged_hash:r.get(4)? })).map_err(|_| "PROBE_DOCUMENT_MISSING")?;
        let fetched = controlled(
            &operation,
            fetch_craft_document(
                &client,
                &connection.session,
                library.into(),
                candidate,
                true,
            ),
        )
        .await?;
        let (content, doc) = match fetched {
            CraftFetchedDocument::Content(d) => (true, d),
            CraftFetchedDocument::AttachmentsOnly(d) => (false, d),
        };
        if doc.attachments.len() > 3 {
            return Err("PROBE_ATTACHMENT_LIMIT".into());
        }
        let hash = doc.content_hash.clone();
        diagnostics::phase("persistPage", round + 1);
        if content {
            persist_document_batch_controlled(&db, &store, vec![doc], Some(&operation))?;
        } else {
            flush_craft_attachment_refresh(&db, &mut vec![doc], &operation).await?;
        }
        diagnostics::phase("discoverAttachments", round + 1);
        backfill_attachment_discovery(&db, 1)?;
        if !allow_original_download && originals(&db, &store, library, document)? != verified {
            return Err("PROBE_ORIGINAL_CHANGED".into());
        }
        diagnostics::phase("scheduleAttachments", round + 1);
        reschedule(&db, library, document, &before)?;
        operation.phase("downloading", "核验既有附件缓存")?;
        let jobs = claim_enabled_attachment_jobs(&db, "download_source", 3)?;
        if jobs.len() != before.len()
            || jobs
                .iter()
                .any(|j| j.space_id != library || !before.contains(&j.source_id))
        {
            return Err("PROBE_JOB_SCOPE".into());
        }
        for job in jobs {
            diagnostics::phase("verifyAttachment", round + 1);
            operation.checkpoint()?;
            if allow_original_download {
                process_download_job(
                    &db,
                    &store,
                    &job,
                    download_client.as_ref().ok_or("PROBE_CLIENT_FAILED")?,
                    None,
                    attachment_url_from_metadata,
                )
                .await?;
            } else {
                cache_only_job(&db, &store, &job, &client).await?;
            }
        }
        diagnostics::phase("verifyOriginals", round + 1);
        let current = originals(&db, &store, library, document)?;
        if current.iter().map(|v| &v.0).ne(before.iter()) {
            return Err("PROBE_INVENTORY_SCOPE".into());
        }
        if round == 0 && allow_original_download {
            verified = current.clone();
        }
        if current != verified {
            return Err("PROBE_ORIGINAL_CHANGED".into());
        }
        // Completion must have been committed by the original owner against
        // the current resource generation, including a same-byte re-download.
        let c = open_database(&db)?;
        diagnostics::phase("verifyBinding", round + 1);
        let mut checks = Vec::new();
        for (id, hash, _) in &current {
            let metadata: String = c
                .query_row(
                    "SELECT metadata_json FROM source_items WHERE id=?1",
                    [id],
                    |r| r.get(0),
                )
                .map_err(|_| "PROBE_ORIGINAL_INVALID")?;
            let metadata: Value =
                serde_json::from_str(&metadata).map_err(|_| "PROBE_ORIGINAL_INVALID")?;
            if metadata["cachedResourceGeneration"].as_u64()
                != Some(metadata["resourceGeneration"].as_u64().unwrap_or(0))
                || attachment_evidence::input_on(&c, library, id)?.blob_hash != *hash
            {
                return Err("PROBE_ORIGINAL_INVALID".into());
            }
            if allow_original_download {
                let check = &metadata["lastRepresentationCheck"];
                if check["generation"].as_u64() != metadata["resourceGeneration"].as_u64()
                    || check["blobHash"].as_str() != Some(hash.as_str())
                    || !matches!(check["kind"].as_str(), Some("downloaded" | "notModified"))
                {
                    return Err("PROBE_ORIGINAL_INVALID".into());
                }
                checks.push(check.clone());
            }
        }
        rounds.push(json!({"round":round+1,"contentChanged":content,"contentHash":hash,"cachedAttachments":current.len(),"originalHashes":current.iter().map(|v|&v.1).collect::<Vec<_>>(),"currentGenerationVerified":true,"representationChecks":checks}));
        diagnostics::completed_round();
    }
    diagnostics::phase("completed", 2);
    drop(operation);
    Ok(
        json!({"rounds":rounds,"originalHashes":verified.iter().map(|b|&b.1).collect::<Vec<_>>(),
        "success":true,"originalBytes":verified.iter().map(|b|b.2).sum::<u64>(),"originalVersionsVerified":true,"credentialRefreshed":false,"personalDataWritten":false}),
    )
}

fn safe_error(error: &str) -> &str {
    match error {
        "PROBE_METADATA_LIMIT"
        | "PROBE_METADATA_READ_FAILED"
        | "PROBE_METADATA_ENCODING"
        | "PROBE_TRANSFER_LIMIT"
        | "PROBE_PAGE_LIMIT"
        | "PROBE_SCOPE_REQUIRED"
        | "PROBE_SCOPE_MISMATCH"
        | "PROBE_CREDENTIAL_SCOPE"
        | "PROBE_CREDENTIAL_UNAVAILABLE"
        | "PROBE_WINDOWS_REQUIRED"
        | "PROBE_CREDENTIAL_INVALID"
        | "PROBE_AUTH_NOT_FRESH"
        | "PROBE_INVENTORY_INVALID"
        | "PROBE_INVENTORY_LIMIT"
        | "PROBE_INVENTORY_SCOPE"
        | "PROBE_ORIGINAL_MISSING"
        | "PROBE_ORIGINAL_INVALID"
        | "PROBE_QUEUE_FAILED"
        | "PROBE_QUEUE_BUSY"
        | "PROBE_CACHE_MISS"
        | "PROBE_CACHE_NOT_COMPLETED"
        | "PROBE_CLIENT_FAILED"
        | "PROBE_SESSION_SCOPE"
        | "PROBE_DOCUMENT_MISSING"
        | "PROBE_ATTACHMENT_LIMIT"
        | "PROBE_ORIGINAL_CHANGED"
        | "PROBE_JOB_SCOPE"
        | "PROBE_CANCELLED" => error,
        _ => "PROBE_OPERATION_FAILED",
    }
}

#[tauri::command]
pub(crate) async fn verify_isolated_craft_cache(
    app: AppHandle,
    library_id: String,
    document_id: String,
    allow_original_download: Option<bool>,
    revalidate_originals: Option<bool>,
) -> Result<Value, String> {
    isolated_runtime::require_craft_probe(&library_id, &document_id)?;
    let revalidate_originals = revalidate_originals.unwrap_or(false);
    if revalidate_originals && allow_original_download.unwrap_or(false) {
        return Err("PROBE_MODE_CONFLICT".into());
    }
    if STARTED.swap(true, Ordering::AcqRel) {
        return Err("PROBE_ALREADY_STARTED".into());
    }
    let budget = Arc::new(MetadataBudget {
        received: AtomicU64::new(0),
        maximum: MAX_METADATA,
    });
    let allow_original_download = allow_original_download.unwrap_or(false) || revalidate_originals;
    let transfers = Arc::new(TransferBudget {
        allowed: allow_original_download,
        gets: AtomicUsize::new(0),
        received: AtomicU64::new(0),
    });
    let trace = diagnostics::Trace::new();
    let result = diagnostics::TRACE
        .scope(
            trace.clone(),
            METADATA.scope(
                budget.clone(),
                TRANSFERS.scope(
                    transfers.clone(),
                    REVALIDATE.scope(
                        revalidate_originals,
                        tokio::time::timeout(
                            Duration::from_secs(120),
                            run(&app, &library_id, &document_id, allow_original_download),
                        ),
                    ),
                ),
            ),
        )
        .await;
    let mut value = match result {
        Ok(Ok(mut value)) => {
            value["metadataBytes"] = json!(budget.received.load(Ordering::Relaxed));
            value
        }
        Ok(Err(error)) => {
            json!({"success":false,"failureCode":safe_error(&error),"metadataBytes":budget.received.load(Ordering::Relaxed)})
        }
        Err(_) => {
            json!({"success":false,"failureCode":"PROBE_DEADLINE","metadataBytes":budget.received.load(Ordering::Relaxed)})
        }
    };
    value["attachmentGets"] = json!(transfers.gets.load(Ordering::Relaxed));
    value["attachmentBytes"] = json!(transfers.received.load(Ordering::Relaxed));
    value["originalDownloadAllowed"] = json!(allow_original_download);
    value["cacheRevalidationAllowed"] = json!(revalidate_originals);
    value["diagnostics"] = trace.snapshot();
    // Preserve the actual producer receipt independently of startup files and
    // the frontend display. Only this CLI-bound isolated profile can reach it.
    value["scope"] = json!({"libraryId":library_id,"documentId":document_id});
    value["processId"] = json!(std::process::id());
    value["receiptVersion"] = json!(2);
    let receipt_id = random_url_safe(12);
    value["receiptId"] = json!(receipt_id);
    let path = isolated_runtime::root()
        .ok_or("PROBE_SCOPE_REQUIRED")?
        .join(format!("integration-craft-probe-{receipt_id}.json"));
    let file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| "PROBE_RECEIPT_FAILED")?;
    serde_json::to_writer(file, &value).map_err(|_| "PROBE_RECEIPT_FAILED")?;
    Ok(value)
}

#[cfg(test)]
#[path = "craft_cache_probe_tests.rs"]
mod tests;
