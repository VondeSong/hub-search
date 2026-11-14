use super::*;
use crate::search_index::IndexRecord;
use lopdf::{dictionary, Document, Object, Stream};
use std::time::Instant;

struct Fixture {
    root: PathBuf,
    c: Connection,
    store: BlobStore,
    index: SearchIndex,
    source: PdfSource,
}
impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("hub-pdf-navigation-{}", crate::random_url_safe(10)));
        std::fs::create_dir_all(&root).unwrap();
        let mut doc = Document::with_version("1.5");
        let pages = doc.new_object_id();
        let content = doc.add_object(Stream::new(dictionary! {}, Vec::new()));
        let kids =
            (0..4)
                .map(|_| {
                    Object::Reference(doc.add_object(
                        dictionary! {"Type"=>"Page","Parent"=>pages,"Contents"=>content},
                    ))
                })
                .collect::<Vec<_>>();
        doc.objects.insert(pages,Object::Dictionary(dictionary!{"Type"=>"Pages","Kids"=>kids,"Count"=>4,"MediaBox"=>vec![0.into(),0.into(),595.into(),842.into()]}));
        let catalog = doc.add_object(dictionary! {"Type"=>"Catalog","Pages"=>pages});
        doc.trailer.set("Root", catalog);
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        let store = BlobStore::open(&root.join("blobs")).unwrap();
        let blob = store.put(&bytes).unwrap();
        let c = crate::open_database(&root.join("test.sqlite3")).unwrap();
        c.execute("INSERT INTO source_items(id,space_id,document_id,remote_id,source_type,title,mime_type,blob_hash,status,created_at,updated_at) VALUES('pdf','space','doc','remote','craft_attachment','Manual.pdf','application/pdf',?1,'downloaded',1,1)",params![blob.hash]).unwrap();
        let source = source_on(&c, &store, "attachment-meta:pdf").unwrap();
        let index = SearchIndex::open(&root.join("index")).unwrap();
        Self {
            root,
            c,
            store,
            index,
            source,
        }
    }
    fn chunk(&self, id: &str, page: i64, body: &str, version: Option<&str>) -> IndexRecord {
        self.c.execute("INSERT INTO content_items(id,space_id,document_id,block_id,content_type,heading,body,ordinal,source_hash,source_item_id,page_number,input_version) VALUES(?1,'space','doc',?1,'pdf_page','',?2,0,'chunk-hash','pdf',?3,?4)",params![id,body,page,version]).unwrap();
        IndexRecord {
            provider: "craft".into(),
            item_id: id.into(),
            document_key: "space:doc".into(),
            entity_key: "attachment:pdf".into(),
            space_id: "space".into(),
            document_id: "doc".into(),
            block_id: id.into(),
            content_type: "pdf_page".into(),
            source_item_id: "pdf".into(),
            source_title: "Manual.pdf".into(),
            page_number: page,
            title: "PDF parent".into(),
            heading: String::new(),
            aliases: String::new(),
            tags: String::new(),
            body: body.into(),
            path: String::new(),
            folder_id: String::new(),
            modified_at: 1,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn actual_file_pages_source_binding_and_range_are_authoritative() {
    let f = Fixture::new();
    assert_eq!(f.source.page_count, 4);
    f.chunk("page2", 2, "current", None);
    assert_eq!(
        source_on(&f.c, &f.store, "page2").unwrap().hash,
        f.source.hash
    );
    assert!(source_on(&f.c, &f.store, "nonexistent").is_err());
    assert!(validate_page(0, 4).is_err());
    assert!(validate_page(5, 4).is_err());
    assert_eq!(validate_page(4, 4).unwrap(), 4);
    f.c.execute("UPDATE source_items SET status='removed'", [])
        .unwrap();
    assert!(source_on(&f.c, &f.store, "attachment-meta:pdf").is_err());
}

#[test]
fn unreadable_pdf_keeps_available_text_with_an_explicit_unverified_page_count() {
    let f = Fixture::new();
    let bad = f.store.put(b"%PDF-1.4 invalid fixture").unwrap();
    f.c.execute("UPDATE source_items SET blob_hash=?1", params![bad.hash])
        .unwrap();
    f.chunk("legacy", 3, "available historical text", None);
    let source = source_on(&f.c, &f.store, "attachment-meta:pdf").unwrap();
    assert_eq!(source.page_count, 3);
    assert!(source
        .page_count_note
        .as_deref()
        .unwrap()
        .contains("无法核验"));
    assert_eq!(
        page_text_on(&f.c, &source, 3).unwrap().0,
        "available historical text"
    );
    assert!(page_link_on(&f.c, &f.store, "attachment-meta:pdf", 3).is_err());
}

#[test]
fn text_states_distinguish_stale_empty_missing_and_current_failures() {
    let f = Fixture::new();
    let v = f.source.input_version.as_deref();
    f.chunk("current", 1, "fresh text", v);
    f.chunk("stale", 1, "old text", Some("old"));
    f.chunk("empty", 2, "", v);
    f.chunk("stale-only", 3, "old", Some("old"));
    assert_eq!(
        page_text_on(&f.c, &f.source, 1).unwrap(),
        ("fresh text".into(), "pdf_native".into(), "indexed".into())
    );
    assert_eq!(page_text_on(&f.c, &f.source, 2).unwrap().2, "empty");
    assert_eq!(page_text_on(&f.c, &f.source, 3).unwrap().2, "stale");
    f.c.execute("INSERT INTO ocr_pages(source_item_id,page_number,status,updated_at,input_version) VALUES('pdf',4,'failed',1,'old')",[]).unwrap();
    assert_eq!(page_text_on(&f.c, &f.source, 4).unwrap().2, "not_extracted");
    f.c.execute("UPDATE ocr_pages SET input_version=?1", params![v])
        .unwrap();
    assert_eq!(page_text_on(&f.c, &f.source, 4).unwrap().2, "failed");
}

#[test]
fn hit_pages_exclude_stale_file_and_stale_index_bodies_and_report_legacy() {
    let f = Fixture::new();
    let v = f.source.input_version.as_deref();
    let current = f.chunk("current", 1, "signalneedle", v);
    let stale = f.chunk("stale", 2, "signalneedle", Some("old"));
    let mut delayed = f.chunk("delayed", 3, "replacement body", v);
    delayed.body = "signalneedle".into();
    let legacy = f.chunk("legacy", 4, "signalneedle", None);
    f.index
        .apply_changes(&[], &[current, stale, delayed, legacy])
        .unwrap();
    let result = search_pages_on(
        &f.c,
        &f.store,
        &f.index,
        "attachment-meta:pdf",
        "signalneedle",
    )
    .unwrap();
    assert_eq!(result.hit_pages, vec![1, 4]);
    assert_eq!(result.revision_status, "stale");
    f.c.execute(
        "DELETE FROM content_items WHERE id IN ('stale','delayed')",
        [],
    )
    .unwrap();
    let legacy = search_pages_on(
        &f.c,
        &f.store,
        &f.index,
        "attachment-meta:pdf",
        "signalneedle",
    )
    .unwrap();
    assert_eq!(legacy.revision_status, "legacy");
    assert_eq!(legacy.hit_pages, vec![1, 4]);
    assert!(
        search_pages_on(&f.c, &f.store, &f.index, "attachment-meta:pdf", "")
            .unwrap()
            .hit_pages
            .is_empty()
    );
}

#[test]
fn page_links_preserve_source_and_locally_edited_working_copies() {
    let f = Fixture::new();
    let original = f.store.path_for(&f.source.hash).unwrap();
    let first = page_link_on(&f.c, &f.store, "attachment-meta:pdf", 4).unwrap();
    let url = url::Url::parse(&first).unwrap();
    assert_eq!(url.fragment(), Some("page=4"));
    let copy = url.to_file_path().unwrap();
    assert_ne!(copy, original);
    assert_eq!(
        crate::craft_backup::hash_file(&copy).unwrap(),
        f.source.hash
    );
    std::fs::write(&copy, b"local edits").unwrap();
    let second = page_link_on(&f.c, &f.store, "attachment-meta:pdf", 1).unwrap();
    assert_ne!(first, second);
    assert_eq!(std::fs::read(&copy).unwrap(), b"local edits");
    assert!(second.contains("Manual-2.pdf"));
    assert_eq!(
        crate::craft_backup::hash_file(&original).unwrap(),
        f.source.hash
    );
    assert!(page_link_on(&f.c, &f.store, "attachment-meta:pdf", 5).is_err());
}

#[test]
#[ignore = "explicit read-only probe against daily DB/PDF/index; writes evidence only to the given output directory"]
fn live_pdf_navigation_probe() {
    let database =
        PathBuf::from(std::env::var_os("HUB_PDF_LIVE_DATABASE").expect("HUB_PDF_LIVE_DATABASE"));
    let output =
        PathBuf::from(std::env::var_os("HUB_PDF_LIVE_OUTPUT").expect("HUB_PDF_LIVE_OUTPUT"));
    let root = database.parent().unwrap();
    let c =
        Connection::open_with_flags(&database, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let store = BlobStore::open_existing(&root.join("blobs-v1"))
        .unwrap()
        .with_backup_index(database.clone());
    let generation: String = c
        .query_row(
            "SELECT relative_path FROM search_index_generations WHERE status='active'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let index =
        SearchIndex::open_existing(&root.join("tantivy-generations-v1").join(generation)).unwrap();
    let mut statement=c.prepare("SELECT s.id,MAX(ci.page_number) AS pages FROM source_items s JOIN content_items ci ON ci.source_item_id=s.id WHERE s.mime_type='application/pdf' AND ci.content_type IN ('pdf_page','pdf_ocr') AND s.status NOT IN ('removed','missing','unavailable') GROUP BY s.id ORDER BY pages DESC").unwrap();
    let ids = statement
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(ids.len() >= 2);
    std::fs::create_dir_all(&output).unwrap();
    let mut reports = Vec::new();
    for (position, id) in [ids.first().unwrap(), ids.last().unwrap()]
        .into_iter()
        .enumerate()
    {
        let result_id = format!("attachment-meta:{id}");
        let source = source_on(&c, &store, &result_id).unwrap();
        let original = store.path_for(&source.hash).unwrap();
        let before = crate::craft_backup::hash_file(&original).unwrap();
        assert_eq!(before, source.hash);
        let body:String=c.query_row("SELECT body FROM content_items WHERE source_item_id=?1 AND length(body)>20 ORDER BY page_number,ordinal LIMIT 1",params![id],|r|r.get(0)).unwrap();
        let query = body
            .split(|ch: char| !ch.is_ascii_alphabetic())
            .find(|word| word.len() >= 5)
            .map(str::to_string)
            .unwrap_or_else(|| {
                body.chars()
                    .collect::<Vec<_>>()
                    .windows(2)
                    .find(|pair| pair.iter().all(|ch| ('\u{4e00}'..='\u{9fff}').contains(ch)))
                    .unwrap()
                    .iter()
                    .collect()
            });
        let started = Instant::now();
        let hits = search_pages_on(&c, &store, &index, &result_id, &query).unwrap();
        let search_ms = started.elapsed().as_millis();
        assert!(
            !hits.hit_pages.is_empty(),
            "known current PDF body query must have page hits"
        );
        for page in &hits.hit_pages {
            let text = page_text_on(&c, &source, *page).unwrap().0;
            assert!(text.to_lowercase().contains(&query.to_lowercase()));
        }
        let mut render_ms = Vec::new();
        for page in [1, source.page_count] {
            let started = Instant::now();
            let bytes = crate::ocr::render_pdf_page_png(&original, page, 1600).unwrap();
            render_ms.push(started.elapsed().as_millis());
            assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
            let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
            let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
            assert!(width.max(height) <= 1600);
            std::fs::write(
                output.join(format!("sample-{position}-page-{page}.png")),
                bytes,
            )
            .unwrap();
        }
        assert!(validate_page(source.page_count + 1, source.page_count).is_err());
        assert_eq!(crate::craft_backup::hash_file(&original).unwrap(), before);
        reports.push(serde_json::json!({"sourceId":id,"pages":source.page_count,"query":query,"hitPages":hits.hit_pages,"revisionStatus":hits.revision_status,"searchMs":search_ms,"renderMs":render_ms,"sourceUnchanged":true}));
    }
    std::fs::write(
        output.join("live-pdf-navigation.json"),
        serde_json::to_vec_pretty(&reports).unwrap(),
    )
    .unwrap();
    println!(
        "live PDF navigation verified for {} daily PDF samples; evidence {}",
        reports.len(),
        output.display()
    );
}
