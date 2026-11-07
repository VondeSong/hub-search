use super::*;
use crate::source_evidence::tests::Fixture;

#[test]
fn completed_ocr_is_reused_only_for_the_current_input_and_cached_downloads_requeue_stale_pages() {
    for change_bytes in [false, true] {
        let f = Fixture::new();
        seed(&f, "image-revision", "image input A");
        let c = f.c();
        c.execute(
            "UPDATE source_items SET mime_type='image/png' WHERE id='image-revision'",
            [],
        )
        .unwrap();
        let first = input_on(&c, "notes", "image-revision").unwrap();
        let store = BlobStore::open(&f.root.join("blobs-v1")).unwrap();
        let database = f.root.join("craft-search.sqlite3");
        let queue = || {
            let tx = c.unchecked_transaction().unwrap();
            queue_ocr_pages(&tx, "notes", "image-revision", 1, &[1], 2).unwrap();
            tx.commit().unwrap();
        };
        let ocr_state = || {
            c.query_row::<String, _, _>("SELECT status FROM index_jobs WHERE source_id='image-revision' AND job_type='ocr_page'", [], |r|r.get(0)).unwrap()
        };
        let produce = |input: &Input, text: &str| {
            c.execute("UPDATE index_jobs SET status='running',worker_id='ocr-revision-worker' WHERE source_id='image-revision' AND job_type='ocr_page'",[]).unwrap();
            let id = c.query_row("SELECT id FROM index_jobs WHERE source_id='image-revision' AND job_type='ocr_page'",[],|r|r.get(0)).unwrap();
            let job = PipelineJob {
                id,
                space_id: "notes".into(),
                source_id: "image-revision".into(),
                worker_id: "ocr-revision-worker".into(),
                payload: None,
            };
            persist_ocr_page_controlled(&database, &store, &job, 1, text.into(), None, Some(input))
                .unwrap();
        };
        queue();
        produce(&first, "clearance limit 12 mm");
        queue();
        assert_eq!(
            ocr_state(),
            "completed",
            "unchanged input must not run OCR twice"
        );
        if change_bytes {
            let next = store.put(b"image input B").unwrap();
            c.execute(
                "UPDATE source_items SET blob_hash=?1,content_hash=?1 WHERE id='image-revision'",
                [next.hash],
            )
            .unwrap();
        } else {
            c.execute(
                "UPDATE source_items SET modified_at=2 WHERE id='image-revision'",
                [],
            )
            .unwrap();
        }
        let current = input_on(&c, "notes", "image-revision").unwrap();
        assert_ne!(first.version, current.version);
        c.execute("INSERT INTO index_jobs(job_key,space_id,source_id,source_type,job_type,status,worker_id,created_at,updated_at) VALUES('revision-download','notes','image-revision','file','download_source','running','download-revision-worker',1,1)",[]).unwrap();
        let download = PipelineJob {
            id: c.last_insert_rowid(),
            space_id: "notes".into(),
            source_id: "image-revision".into(),
            worker_id: "download-revision-worker".into(),
            payload: None,
        };
        let blob = store.put(&store.read(&current.blob_hash).unwrap()).unwrap();
        persist_download_success_guarded(
            &database,
            &download,
            DownloadedSource {
                blob,
                mime_type: "image/png".into(),
            },
            None,
            None,
            true,
        )
        .unwrap();
        assert_eq!(
            ocr_state(),
            "pending",
            "an old completed page is not a current extraction"
        );
        assert_eq!(
            c.query_row::<String, _, _>(
                "SELECT status FROM ocr_pages WHERE source_item_id='image-revision'",
                [],
                |r| r.get(0)
            )
            .unwrap(),
            "pending"
        );
        produce(&current, "clearance limit 7 mm");
        queue();
        assert_eq!(ocr_state(), "completed");
        let (body,version):(String,String)=c.query_row("SELECT body,input_version FROM content_items WHERE source_item_id='image-revision'",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert_eq!(body, "clearance limit 7 mm");
        assert_eq!(version, current.version);
    }
}

#[test]
fn mixed_ocr_lineage_requires_every_native_and_ocr_contribution() {
    for native_bound in [false, true] {
        let f = Fixture::new();
        let (job, input) = seed(&f, "mixed-pdf", "输入 PDF");
        let database = f.root.join("craft-search.sqlite3");
        let store = BlobStore::open(&f.root.join("blobs-v1")).unwrap();
        persist_pdf_extraction_controlled(
            &database,
            &store,
            &job,
            vec!["原生第一页".into(), String::new()],
            None,
            if native_bound { Some(&input) } else { None },
        )
        .unwrap();
        let c = f.c();
        let tx = c.unchecked_transaction().unwrap();
        queue_ocr_pages(&tx, "notes", "mixed-pdf", 2, &[2], 2).unwrap();
        tx.commit().unwrap();
        c.execute("UPDATE index_jobs SET status='running',worker_id='ocr-worker' WHERE source_id='mixed-pdf' AND job_type='ocr_page'",[]).unwrap();
        let id: i64 = c
            .query_row(
                "SELECT id FROM index_jobs WHERE source_id='mixed-pdf' AND job_type='ocr_page'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let ocr = PipelineJob {
            id,
            space_id: "notes".into(),
            source_id: "mixed-pdf".into(),
            worker_id: "ocr-worker".into(),
            payload: None,
        };
        persist_ocr_page_controlled(
            &database,
            &store,
            &ocr,
            2,
            "第二页 OCR 文字".into(),
            None,
            Some(&input),
        )
        .unwrap();
        let counts:(i64,i64)=c.query_row("SELECT COUNT(*),COALESCE(SUM(input_version IS NOT NULL),0) FROM content_items WHERE source_item_id='mixed-pdf'",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert!(counts.0 >= 2);
        assert_eq!(counts.1, if native_bound { counts.0 } else { 0 });
    }
}

#[test]
fn stale_worker_releases_only_the_cache_for_its_captured_input() {
    let f = Fixture::new();
    let (_, input) = seed(&f, "cache-source", "原输入");
    let c = f.c();
    let other = "f".repeat(64);
    for hash in [&input.blob_hash, &other] {
        c.execute("INSERT INTO extraction_cache(blob_hash,extractor,extractor_version,page_number,status,created_at,updated_at) VALUES(?1,'pdf_native','1',0,'running',1,1)",[hash]).unwrap();
    }
    c.execute(
        "UPDATE source_items SET blob_hash=?1 WHERE id='cache-source'",
        [&other],
    )
    .unwrap();
    fail_source_cache(
        &f.root.join("craft-search.sqlite3"),
        "cache-source",
        "pdf_native",
        "1",
        0,
        "旧任务已让出",
        Some(&input.blob_hash),
    )
    .unwrap();
    assert_eq!(
        c.query_row::<String, _, _>(
            "SELECT status FROM extraction_cache WHERE blob_hash=?1",
            [&input.blob_hash],
            |r| r.get(0)
        )
        .unwrap(),
        "failed"
    );
    assert_eq!(
        c.query_row::<String, _, _>(
            "SELECT status FROM extraction_cache WHERE blob_hash=?1",
            [&other],
            |r| r.get(0)
        )
        .unwrap(),
        "running"
    );
}
pub(crate) fn seed(f: &Fixture, source: &str, text: &str) -> (PipelineJob, Input) {
    f.note("notes", "attachment-doc", "附件所属页面");
    let store = BlobStore::open(&f.root.join("blobs-v1")).unwrap();
    let blob = store.put(format!("input-file:{text}").as_bytes()).unwrap();
    let c = f.c();
    c.execute("INSERT INTO source_items(id,space_id,document_id,remote_id,source_type,title,mime_type,blob_hash,content_hash,status,created_at,updated_at,provider) VALUES(?1,'notes','attachment-doc',?1,'file','工艺附件','application/pdf',?2,?2,'downloaded',1,1,'obsidian')",params![source,blob.hash]).unwrap();
    c.execute("INSERT INTO extractions(id,source_item_id,extractor,extractor_version,status,created_at,updated_at) VALUES(?1,?1,'pdf_native','1','pending',1,1)",[source]).unwrap();
    c.execute("INSERT INTO index_jobs(job_key,space_id,source_id,source_type,job_type,status,worker_id,created_at,updated_at) VALUES(?1,'notes',?1,'file','extract_pdf','running','lineage-worker',1,1)",[source]).unwrap();
    let job = PipelineJob {
        id: c.last_insert_rowid(),
        space_id: "notes".into(),
        source_id: source.into(),
        worker_id: "lineage-worker".into(),
        payload: None,
    };
    let input = input_on(&c, "notes", source).unwrap();
    (job, input)
}
pub(crate) fn produce(f: &Fixture, job: &PipelineJob, input: &Input, text: &str) {
    let store = BlobStore::open(&f.root.join("blobs-v1")).unwrap();
    persist_pdf_extraction_controlled(
        &f.root.join("craft-search.sqlite3"),
        &store,
        job,
        vec![text.into()],
        None,
        Some(input),
    )
    .unwrap();
}
#[test]
fn input_lineage_is_recorded_by_original_pdf_producer_and_rejects_inflight_changes() {
    let f = Fixture::new();
    let (job, input) = seed(&f, "pdf", "测量上限为十毫米");
    produce(&f, &job, &input, "测量上限为十毫米");
    let c = f.c();
    let version: String = c
        .query_row(
            "SELECT input_version FROM content_items WHERE source_item_id='pdf'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(version, input.version);
    c.execute("UPDATE source_items SET modified_at=2 WHERE id='pdf'", [])
        .unwrap();
    let store = BlobStore::open(&f.root.join("blobs-v1")).unwrap();
    let before: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM content_items WHERE source_item_id='pdf'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(persist_pdf_extraction_controlled(
        &f.root.join("craft-search.sqlite3"),
        &store,
        &job,
        vec!["不应写入的旧提取".into()],
        None,
        Some(&input)
    )
    .unwrap_err()
    .starts_with("CONTENT_POLICY:"));
    assert_eq!(
        before,
        c.query_row::<i64, _, _>(
            "SELECT COUNT(*) FROM content_items WHERE source_item_id='pdf'",
            [],
            |r| r.get(0)
        )
        .unwrap()
    );
    assert_eq!(
        c.query_row::<String, _, _>(
            "SELECT body FROM content_items WHERE source_item_id='pdf'",
            [],
            |r| r.get(0)
        )
        .unwrap(),
        "测量上限为十毫米"
    );
}
#[test]
fn native_binding_never_upgrades_old_ocr_chunks_and_migration_never_invents_proof() {
    let f = Fixture::new();
    let (job, input) = seed(&f, "pdf", "资料");
    let c = f.c();
    c.execute("INSERT INTO content_items(id,space_id,document_id,block_id,content_type,heading,body,ordinal,source_hash,source_item_id,page_number,provider) VALUES('old-ocr','notes','attachment-doc','old-ocr','pdf_ocr','old','legacy',0,'hash','pdf',2,'obsidian')",[]).unwrap();
    produce(&f, &job, &input, "当前原生文字");
    assert!(c
        .query_row::<Option<String>, _, _>(
            "SELECT input_version FROM content_items WHERE id='old-ocr'",
            [],
            |r| r.get(0)
        )
        .unwrap()
        .is_none());
    migrate(&c).unwrap();
    assert!(c
        .query_row::<Option<String>, _, _>(
            "SELECT input_version FROM content_items WHERE id='old-ocr'",
            [],
            |r| r.get(0)
        )
        .unwrap()
        .is_none());
}
#[test]
fn task_revision_covers_body_and_raw_dates_but_ignores_sync_timestamps() {
    let f = Fixture::new();
    let c = f.c();
    c.execute("INSERT INTO dida_tasks(library_id,task_id,project_id,title,raw_json,last_seen_at) VALUES('dida','one','project','任务','{}',1)",[]).unwrap();
    let revision = || {
        c.query_row::<i64, _, _>(
            "SELECT evidence_revision FROM dida_tasks WHERE task_id='one'",
            [],
            |r| r.get(0),
        )
        .unwrap()
    };
    c.execute(
        "UPDATE dida_tasks SET last_seen_at=2,raw_json='{\"modifiedTime\":2}'",
        [],
    )
    .unwrap();
    assert_eq!(revision(), 0);
    c.execute("UPDATE dida_tasks SET content='更新正文'", [])
        .unwrap();
    assert_eq!(revision(), 1);
    c.execute("UPDATE dida_tasks SET raw_json='{\"isAllDay\":false}'", [])
        .unwrap();
    assert_eq!(revision(), 2);
    c.execute("UPDATE dida_tasks SET raw_json='{broken'", [])
        .unwrap();
    assert_eq!(revision(), 3);
}
