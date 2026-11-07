//! HBM-00 only: real Hub producers/readers plus experimental vectors in the same
//! SQLite transaction. This module is absent from production builds.
use super::*;
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};

struct Embed {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}
impl Embed {
    fn start() -> Self {
        let mut command = Command::new(std::env::var_os("HBM_EMBED_EXE").unwrap());
        command
            .arg(std::env::var_os("HBM_EMBED_MODEL").unwrap())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().unwrap();
        let input = child.stdin.take().unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        output.read_line(&mut line).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&line).unwrap()["event"],
            "ready"
        );
        Self {
            child,
            input,
            output,
        }
    }
    fn vectors(&mut self, texts: &[String]) -> Vec<Vec<f32>> {
        let mut result = Vec::new();
        for batch in texts.chunks(64) {
            writeln!(self.input, "{}", json!({"id":"embed","texts":batch})).unwrap();
            self.input.flush().unwrap();
            let mut line = String::new();
            self.output.read_line(&mut line).unwrap();
            let v: Value = serde_json::from_str(&line).unwrap();
            let rows: Vec<Vec<f32>> = serde_json::from_value(v["vectors"].clone()).unwrap();
            assert_eq!(rows.len(), batch.len());
            result.extend(rows);
        }
        result
    }
}
impl Drop for Embed {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn hash(s: &str) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))
}
fn flush(root: &PathBuf, c: &mut Connection) {
    let path = root.join("craft-search.sqlite3");
    let index_root = root.join("tantivy-generations-v1");
    let index =
        crate::search_index_runtime::open_or_create_active_search_index(c, &index_root).unwrap();
    crate::search_index_runtime::flush_index_jobs_budgeted(
        &path,
        index,
        &index_root,
        100,
        Duration::from_secs(5),
    )
    .unwrap();
}
fn reply(v: Value) {
    println!("HBMJSON {v}");
    std::io::stdout().flush().unwrap();
}
fn crash_gate(q: &Value, phase: &str) {
    if q["crashAt"].as_str() == Some(phase) {
        reply(json!({"event":"crash_gate","phase":phase}));
        // The isolated controller must terminate this process without unwinding.
        loop {
            std::thread::park();
        }
    }
}

#[test]
#[ignore = "HBM-00 owned lifecycle RPC; explicit isolated root and Rust model required"]
fn native_lifecycle_rpc() {
    let root = PathBuf::from(std::env::var_os("HBM_LIFECYCLE_ROOT").unwrap());
    assert!(root.is_absolute());
    assert!(root
        .components()
        .any(|p| p.as_os_str() == "lifecycle-20261018"));
    std::fs::create_dir_all(&root).unwrap();
    let mut c = crate::open_database(&root.join("craft-search.sqlite3")).unwrap();
    c.execute_batch("CREATE TABLE IF NOT EXISTS hbm_vectors(project TEXT NOT NULL,id TEXT NOT NULL,ordinal INTEGER NOT NULL,body TEXT NOT NULL,vector BLOB NOT NULL,PRIMARY KEY(project,id,ordinal));").unwrap();
    for project in ["left", "right"] {
        c.execute("INSERT OR IGNORE INTO libraries(id,provider,name,enabled,added_at) VALUES(?1,'obsidian',?1,1,1)", [project]).unwrap();
    }
    let mut embed = Embed::start();
    flush(&root, &mut c);
    reply(
        json!({"event":"ready","embeddingPid":embed.child.id(),"productionMemorySchemaChanged":false}),
    );
    for line in std::io::stdin().lock().lines() {
        let line = line.unwrap();
        assert!(line.len() <= 4 * 1024 * 1024);
        let q: Value = serde_json::from_str(&line).unwrap();
        let begin = Instant::now();
        let op = q["op"].as_str().unwrap();
        if op == "close" {
            reply(json!({"ok":true}));
            break;
        }
        let project = q["project"].as_str().unwrap_or("left");
        assert!(["left", "right"].contains(&project));
        let id = q["id"].as_str().unwrap_or("");
        if matches!(op, "write" | "delete") {
            assert!(
                id.starts_with("hbm-op-")
                    && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            );
            let body = q["body"].as_str().unwrap_or("");
            let chunks: Vec<String> = if op == "write" {
                serde_json::from_value(q["chunks"].clone()).unwrap()
            } else {
                vec![]
            };
            let vectors = if chunks.is_empty() {
                vec![]
            } else {
                embed.vectors(&chunks)
            };
            let embedding_ms = begin.elapsed().as_secs_f64() * 1000.;
            let tx = c.transaction().unwrap();
            if op == "write" {
                let document = crate::LocalMarkdownDocument {
                    id: id.into(),
                    title: id.into(),
                    relative_path: format!("{id}.md"),
                    folder_path: None,
                    markdown: body.into(),
                    modified_at: crate::now_timestamp(),
                    content_hash: hash(body),
                    aliases: vec![],
                    tags: vec![],
                    attachments: vec![],
                };
                crate::upsert_obsidian_document(&tx, project, &document, crate::now_timestamp())
                    .unwrap();
            } else {
                crate::delete_obsidian_document(&tx, project, id, crate::now_timestamp()).unwrap();
            }
            tx.execute(
                "DELETE FROM hbm_vectors WHERE project=?1 AND id=?2",
                params![project, id],
            )
            .unwrap();
            for (i, (text, vector)) in chunks.iter().zip(vectors).enumerate() {
                let bytes: Vec<u8> = vector.into_iter().flat_map(f32::to_le_bytes).collect();
                tx.execute(
                    "INSERT INTO hbm_vectors VALUES(?1,?2,?3,?4,?5)",
                    params![project, id, i as i64, text, bytes],
                )
                .unwrap();
            }
            crash_gate(&q, "before_commit");
            tx.commit().unwrap();
            crash_gate(&q, "after_commit");
            // ACK is emitted at the durable SQLite commit, before lexical readiness.
            reply(
                json!({"event":"ack","ackMs":begin.elapsed().as_secs_f64()*1000.,"embeddingMs":embedding_ms}),
            );
            crash_gate(&q, "after_ack");
            flush(&root, &mut c);
            reply(json!({"ok":true,"fullMs":begin.elapsed().as_secs_f64()*1000.}));
        } else if op == "state" {
            let reader = EvidenceReader::new(
                &root,
                EvidenceScope::new(vec!["left".into(), "right".into()], vec![]).unwrap(),
            );
            let mut s=c.prepare("SELECT space_id,id FROM documents WHERE provider='obsidian' ORDER BY space_id,id").unwrap();
            let ids: Vec<(String, String)> = s
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap()
                .map(Result::unwrap)
                .collect();
            let mut notes = Vec::new();
            for (p, id) in ids {
                let locator = EvidenceLocator::Note {
                    library_id: p.clone(),
                    document_id: id.clone(),
                    page_id: None,
                };
                let excerpt = reader.read(&locator, 0, 20000, None).unwrap();
                assert!(
                    !excerpt.truncated,
                    "Whole-note fixture exceeds actual reader limit"
                );
                notes.push(json!({"project":p,"id":id,"body":excerpt.content}));
            }
            let mut s = c
                .prepare(
                    "SELECT project,id,ordinal,body FROM hbm_vectors ORDER BY project,id,ordinal",
                )
                .unwrap();
            let chunks:Vec<Value>=s.query_map([],|r|Ok(json!({"project":r.get::<_,String>(0)?,"id":r.get::<_,String>(1)?,"ordinal":r.get::<_,i64>(2)?,"body":r.get::<_,String>(3)?}))).unwrap().map(Result::unwrap).collect();
            reply(json!({"notes":notes,"chunks":chunks}));
        } else if op == "search" {
            let query = q["query"].as_str().unwrap();
            let vector = embed.vectors(&[query.into()]).remove(0);
            let mut s = c
                .prepare("SELECT id,vector FROM hbm_vectors WHERE project=?1")
                .unwrap();
            let rows: Vec<(String, Vec<u8>)> = s
                .query_map([project], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap()
                .map(Result::unwrap)
                .collect();
            let mut passage_scores = Vec::new();
            for (id, bytes) in rows {
                let v: Vec<f32> = bytes
                    .chunks_exact(4)
                    .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
                    .collect();
                assert_eq!(v.len(), vector.len());
                let score: f32 = v.iter().zip(&vector).map(|(a, b)| a * b).sum();
                passage_scores.push((id, score));
            }
            passage_scores.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
            passage_scores.truncate(500); // Per-project K; BM applies its project filter after global K.
            let mut ranked = std::collections::HashMap::<String, f32>::new();
            for (id, score) in passage_scores {
                ranked
                    .entry(id)
                    .and_modify(|old| *old = old.max(score))
                    .or_insert(score);
            }
            let mut ranked: Vec<_> = ranked.into_iter().collect();
            ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
            ranked.truncate(50);
            let reader = EvidenceReader::new(
                &root,
                EvidenceScope::new(vec![project.into()], vec![]).unwrap(),
            );
            let lexical = reader
                .search(
                    EvidenceKind::Note,
                    q["lexical"].as_str().unwrap_or(query),
                    50,
                )
                .unwrap();
            let ids: Vec<_> = lexical
                .candidates
                .iter()
                .filter_map(|r| {
                    if let EvidenceLocator::Note { document_id, .. } = &r.locator {
                        Some(document_id.clone())
                    } else {
                        None
                    }
                })
                .collect();
            reply(
                json!({"vectorIds":ranked.iter().map(|r|&r.0).collect::<Vec<_>>(),"lexicalIds":ids}),
            );
        } else {
            panic!("unsupported operation");
        }
    }
    c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
}
