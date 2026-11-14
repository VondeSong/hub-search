//! Explicit, ignored read-only measurements of production functions; never starts an app.
use crate::*;
use rusqlite::OpenFlags;
use std::time::Instant;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    root: PathBuf,
    output: PathBuf,
    queries: Vec<Case>,
    previews: Vec<Preview>,
    rounds: usize,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    id: String,
    query: String,
    #[serde(default = "all")]
    field: String,
    library: Option<String>,
}
fn all() -> String {
    "all".into()
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Preview {
    id: String,
    library: String,
    document: String,
    page: Option<String>,
}

fn digest(value: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(value.as_ref()))
}
fn elapsed(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}
fn record<T: Serialize>(
    rows: &mut Vec<Value>,
    case: &str,
    stage: &str,
    round: usize,
    started: Instant,
    result: &T,
    count: usize,
) {
    let ms = elapsed(started);
    rows.push(json!({"case":case,"stage":stage,"round":round,"ms":ms,
        "count":count,"resultSha256":digest(serde_json::to_vec(result).unwrap())}));
}

#[test]
#[ignore = "requires explicit HUB_PERF_INPUT; reads daily data without migration or app startup"]
fn daily_readonly_baseline() {
    let config = std::env::var_os("HUB_PERF_INPUT").expect("HUB_PERF_INPUT required");
    let bytes = std::fs::read(config).unwrap();
    assert!(bytes.len() < 64 * 1024);
    let input: Input = serde_json::from_slice(&bytes).unwrap();
    assert!((1..=10).contains(&input.rounds));
    assert!((1..=8).contains(&input.queries.len()));
    assert!(input.previews.len() <= 4);
    let root = input.root.canonicalize().unwrap();
    let output_parent = input.output.parent().unwrap().canonicalize().unwrap();
    assert!(
        !output_parent.starts_with(&root),
        "evidence must be outside daily data"
    );
    assert!(!input.output.exists(), "never replace earlier evidence");
    let started = Instant::now();
    let c = Connection::open_with_flags(
        root.join("craft-search.sqlite3"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    c.execute_batch("PRAGMA query_only=ON; PRAGMA busy_timeout=3000; BEGIN;")
        .unwrap();
    assert_eq!(
        c.query_row("PRAGMA query_only", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    let database_open_ms = elapsed(started);
    let schema: String = c
        .query_row(
            "SELECT value FROM metadata WHERE key='schema_version'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        schema,
        crate::database::DATABASE_SCHEMA_VERSION.to_string(),
        "do not migrate a benchmark source"
    );
    let (generation, relative, version): (String, String, i64) = c.query_row(
        "SELECT id,relative_path,schema_version FROM search_index_generations WHERE status='active'", [],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
    assert_eq!(version, SEARCH_INDEX_SCHEMA_VERSION);
    let index_path = safe_generation_path(&root.join("tantivy-generations-v1"), &relative)
        .unwrap()
        .canonicalize()
        .unwrap();
    assert!(index_path.starts_with(&root));
    let meta_before = digest(std::fs::read(index_path.join("meta.json")).unwrap());
    let started = Instant::now();
    let index = search_index::SearchIndex::open_existing(&index_path).unwrap();
    let index_open_ms = elapsed(started);
    let visible = visible_library_ids(&root.join("craft-search.sqlite3"), &c).unwrap();
    let mut rows = Vec::new();
    for round in 0..input.rounds {
        for case in &input.queries {
            assert!(case.query.chars().count() <= 128);
            let libraries = case
                .library
                .as_ref()
                .map(|id| {
                    assert!(
                        visible.contains(id),
                        "benchmark must obey current visibility"
                    );
                    vec![id.clone()]
                })
                .unwrap_or_else(|| visible.clone());
            let scope = module_search::Scope {
                libraries: libraries.clone(),
                global: case.library.is_none(),
                folders: None,
                documents: None,
                pages: None,
                updated_after: None,
            };
            for (name, limit) in [("lexical50", 50), ("lexicalFacet2000", 2000)] {
                let started = Instant::now();
                let queries = if case.field == "tag" && !case.query.is_empty() {
                    internal_tag_search_family(&c, &case.query.to_lowercase()).unwrap()
                } else {
                    vec![case.query.clone()]
                };
                let mut hits = Vec::new();
                for query in queries {
                    hits.extend(
                        index
                            .search_in_folders(
                                &query,
                                limit,
                                Some(&libraries),
                                None,
                                None,
                                None,
                                None,
                                true,
                                true,
                                true,
                                true,
                                true,
                                &case.field,
                            )
                            .unwrap(),
                    );
                }
                let count = hits.len();
                // Content digests stay private; no source text is emitted.
                let projection = hits
                    .iter()
                    .map(|h| (&h.entity_key, &h.item_id, &h.match_field, &h.body))
                    .collect::<Vec<_>>();
                record(
                    &mut rows,
                    &case.id,
                    name,
                    round,
                    started,
                    &projection,
                    count,
                );
            }
            for (name, limit, reading, cards) in [
                ("reading50", 50, true, false),
                ("cards50", 50, false, true),
                ("moduleFacets2000", 2000, true, true),
            ] {
                let started = Instant::now();
                let hits = module_search::search(
                    &c,
                    &case.query,
                    limit,
                    &scope,
                    reading,
                    cards,
                    &case.field,
                )
                .unwrap();
                record(&mut rows, &case.id, name, round, started, &hits, hits.len());
            }
        }
        for preview in &input.previews {
            assert!(visible.contains(&preview.library));
            let started = Instant::now();
            let (body, provider): (String, String) = c
                .query_row(
                    "SELECT markdown,provider FROM documents WHERE space_id=?1 AND id=?2",
                    params![preview.library, preview.document],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            record(
                &mut rows,
                &preview.id,
                "previewSql",
                round,
                started,
                &body,
                body.len(),
            );
            assert!(
                !body.is_empty(),
                "blob previews require a separate explicit case"
            );
            let started = Instant::now();
            let rendered = if provider == PROVIDER_CRAFT {
                craft_page_preview(
                    &body,
                    &preview.document,
                    preview.page.as_deref().unwrap_or(&preview.document),
                )
            } else {
                body
            };
            record(
                &mut rows,
                &preview.id,
                "previewParser",
                round,
                started,
                &rendered,
                rendered.len(),
            );
        }
    }
    assert_eq!(
        meta_before,
        digest(std::fs::read(index_path.join("meta.json")).unwrap()),
        "index changed during measurement"
    );
    let output = json!({"format":"hub-readonly-performance-v1","sourceConfigSha256":digest(bytes),
        "databaseSchema":schema,"generationSha256":digest(generation),"indexMetaSha256":meta_before,
        "databaseOpenMs":database_open_ms,"indexOpenMs":index_open_ms,"rows":rows,
        "cache":"new process/reader, followed by reused reader; OS cache is not flushed",
        "coverage":"production engine/module/parser segments, excludes IPC/rendering/facet metadata aggregation"});
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&input.output)
        .unwrap();
    file.write_all(&serde_json::to_vec_pretty(&output).unwrap())
        .unwrap();
    c.execute_batch("ROLLBACK;").unwrap();
}
