//! Experimental native baseline. No memory tables enter the production schema.
use super::*;
use crate::source_evidence::tests::Fixture;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::time::Instant;

#[test]
#[ignore = "HBM-00 opt-in: indexes the frozen Hub-plan corpus in an isolated real Hub DB and writes a benchmark receipt"]
fn native_sqlite_tantivy_memory_selection() {
    let started = Instant::now();
    let corpus_path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../qa/memory-selection/corpus.json");
    let corpus_bytes = std::fs::read(corpus_path).unwrap();
    let corpus: Value = serde_json::from_slice(&corpus_bytes).unwrap();
    // Optional experiment input changes only queries, never corpus authority,
    // permissions, production search, or the original first-round receipt.
    let query_bytes =
        std::env::var_os("HUB_MEMORY_SELECTION_QUERIES").map(|path| std::fs::read(path).unwrap());
    let query_variant: Option<Value> = query_bytes
        .as_ref()
        .map(|bytes| serde_json::from_slice(bytes).unwrap());
    let questions = query_variant.as_ref().unwrap_or(&corpus)["queries"]
        .as_array()
        .unwrap();
    assert_eq!(questions.len(), 60);
    let f = Fixture::new();
    f.c().execute_batch("INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES ('hub','obsidian','Hub selection corpus',1,1),('other','obsidian','Other project',1,1); CREATE TABLE hbm_experiment_manifest(id TEXT PRIMARY KEY,project TEXT NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL);").unwrap();
    let mut manifest = HashMap::new();
    for record in corpus["records"].as_array().unwrap() {
        let id = record["id"].as_str().unwrap();
        let project = record["project"].as_str().unwrap();
        let body = format!(
            "# {}\n{}",
            record["title"].as_str().unwrap(),
            record["content"].as_str().unwrap()
        );
        f.note(project, id, &body);
        f.c()
            .execute(
                "UPDATE documents SET title=?2 WHERE space_id=?3 AND id=?1",
                params![id, record["title"].as_str().unwrap(), project],
            )
            .unwrap();
        f.c()
            .execute(
                "INSERT INTO hbm_experiment_manifest(id,project,status,body) VALUES(?1,?2,?3,?4)",
                params![id, project, record["status"].as_str().unwrap(), body],
            )
            .unwrap();
        manifest.insert(id.to_owned(), record.clone());
    }
    f.index();
    let initialized_ms = started.elapsed().as_millis();
    let mut results = Vec::new();
    for question in questions {
        let project = question["project"].as_str().unwrap();
        let reader = EvidenceReader::new(
            &f.root,
            EvidenceScope::new(vec![project.into()], vec![]).unwrap(),
        );
        let began = Instant::now();
        let query_text = question["query"].as_str().unwrap();
        // Empty keyword extraction must abstain, not turn into browse-all.
        if query_text.trim().is_empty() {
            results.push(json!({"id":question["id"],"ids":[],"rawCandidates":0,"elapsedMs":0.0}));
            continue;
        }
        let found = reader.search(EvidenceKind::Note, query_text, 20).unwrap();
        let mut ids = Vec::new();
        let mut seen = HashSet::new();
        for candidate in &found.candidates {
            let EvidenceLocator::Note { document_id, .. } = &candidate.locator else {
                continue;
            };
            let Some(record) = manifest.get(document_id) else {
                continue;
            };
            if record["status"] != "confirmed"
                || record["project"] != project
                || !seen.insert(document_id.clone())
            {
                continue;
            }
            let excerpt = reader
                .read(&candidate.locator, 0, 3000, Some(&candidate.version))
                .unwrap();
            if excerpt.content
                != format!(
                    "# {}\n{}",
                    record["title"].as_str().unwrap(),
                    record["content"].as_str().unwrap()
                )
            {
                continue;
            }
            ids.push(document_id.clone());
            if ids.len() == 5 {
                break;
            }
        }
        results.push(json!({"id":question["id"],"ids":ids,"rawCandidates":found.candidates.len(),"elapsedMs":began.elapsed().as_secs_f64()*1000.0}));
    }
    let report = json!({"format":"hub-memory-selection-native-v1","backend":"Hub SQLite + production Tantivy/EvidenceReader","corpusSha256":format!("{:x}",Sha256::digest(&corpus_bytes)),"queryVariant":query_variant.as_ref().and_then(|v|v["variant"].as_str()),"querySha256":query_bytes.as_ref().map(|bytes|format!("{:x}",Sha256::digest(bytes))),"initializeAndIndexMs":initialized_ms,"results":results,"elapsedMs":started.elapsed().as_millis(),"productionMemorySchemaChanged":false});
    let destination = std::env::var_os("HUB_MEMORY_SELECTION_NATIVE_REPORT")
        .expect("HUB_MEMORY_SELECTION_NATIVE_REPORT is required");
    std::fs::write(&destination, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    println!(
        "HBM-00 native receipt: {} queries; report {}",
        results.len(),
        PathBuf::from(destination).display()
    );
    assert_eq!(results.len(), 60);
}

/// HBM-00 only: common exact passages, no validation labels in the native process.
/// The existing 60-question baseline above remains unchanged.
#[test]
#[ignore = "HBM-00 opt-in: shared passage representation through real Hub SQLite/Tantivy/EvidenceReader"]
fn native_sqlite_tantivy_passage_parity() {
    let began = Instant::now();
    let path = std::env::var_os("HUB_MEMORY_PARITY_INPUT").expect("isolated input required");
    let input = std::fs::read(path).unwrap();
    let data: Value = serde_json::from_slice(&input).unwrap();
    assert_eq!(data["format"], "hbm-parity-native-input-v1");
    let f = Fixture::new();
    for project in data["projects"].as_array().unwrap() {
        let id = project.as_str().unwrap();
        f.c().execute("INSERT OR IGNORE INTO libraries(id,provider,name,enabled,added_at) VALUES(?1,'obsidian',?1,1,1)", [id]).unwrap();
    }
    let mut passages = HashMap::new();
    let mut c = f.c();
    let tx = c.transaction().unwrap();
    for p in data["passages"].as_array().unwrap() {
        let id = p["id"].as_str().unwrap();
        let body = p["text"].as_str().unwrap();
        // Same production producer and row values as Fixture::note, in one
        // import transaction. Avoid reopening/migrating the DB twice per passage.
        let document = crate::LocalMarkdownDocument {
            id: id.into(),
            title: id.into(),
            relative_path: format!("{id}.md"),
            folder_path: None,
            markdown: body.into(),
            modified_at: 1,
            content_hash: format!("{:x}", Sha256::digest(body.as_bytes())),
            aliases: vec![],
            tags: vec![],
            attachments: vec![],
        };
        crate::upsert_obsidian_document(&tx, p["project"].as_str().unwrap(), &document, 1).unwrap();
        tx.execute(
            "UPDATE documents SET title=?2 WHERE id=?1 AND space_id=?3",
            params![
                id,
                p["title"].as_str().unwrap(),
                p["project"].as_str().unwrap()
            ],
        )
        .unwrap();
        assert!(passages.insert(id.to_string(), p).is_none());
    }
    tx.commit().unwrap();
    drop(c);
    f.index();
    let index_ms = began.elapsed().as_secs_f64() * 1000.0;
    let mut results = Vec::new();
    for q in data["queries"].as_array().unwrap() {
        let started = Instant::now();
        let project = q["project"].as_str().unwrap();
        let query = q["lexicalQuery"].as_str().unwrap();
        let reader = EvidenceReader::new(
            &f.root,
            EvidenceScope::new(vec![project.into()], vec![]).unwrap(),
        );
        let mut ids = Vec::new();
        let mut excluded = Vec::new();
        let mut raw = 0;
        if !query.trim().is_empty() {
            let found = reader.search(EvidenceKind::Note, query, 50).unwrap();
            raw = found.candidates.len();
            for candidate in &found.candidates {
                let EvidenceLocator::Note { document_id, .. } = &candidate.locator else {
                    panic!("non-note result")
                };
                let p = passages.get(document_id).expect("unknown passage");
                if p["project"] != project || p["status"] != "confirmed" {
                    excluded.push(document_id.clone());
                    continue;
                }
                let excerpt = reader
                    .read(&candidate.locator, 0, 3000, Some(&candidate.version))
                    .unwrap();
                assert_eq!(
                    excerpt.content,
                    p["text"].as_str().unwrap(),
                    "passage identity or truncation"
                );
                ids.push(document_id.clone());
            }
        }
        results.push(json!({"id":q["id"],"ids":ids,"excluded":excluded,
            "rawCandidates":raw,"elapsedMs":started.elapsed().as_secs_f64()*1000.0}));
    }
    let report = json!({"format":"hbm-parity-hub-lexical-v1","backend":"Actual Hub SQLite/Tantivy/EvidenceReader",
        "inputSha256":format!("{:x}",Sha256::digest(&input)),"indexMs":index_ms,
        "passages":passages.len(),"results":results,"totalMs":began.elapsed().as_secs_f64()*1000.0,
        "fixtureRoot":f.root,"productionMemorySchemaChanged":false});
    let output = std::env::var_os("HUB_MEMORY_PARITY_OUTPUT").expect("isolated output required");
    use std::io::Write;
    let mut stream = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output)
        .unwrap();
    stream
        .write_all(&serde_json::to_vec_pretty(&report).unwrap())
        .unwrap();
    println!(
        "HBM-00 passage parity: {} passages, {} queries",
        passages.len(),
        results.len()
    );
}
