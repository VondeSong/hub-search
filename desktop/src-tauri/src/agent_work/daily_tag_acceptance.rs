//! Explicit daily-library acceptance through the production conversation host.
use super::*;
use sha2::{Digest, Sha256};

fn protected_state(root: &Path) -> Value {
    let c = Connection::open_with_flags(
        root.join("craft-search.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let mut state = serde_json::Map::new();
    for table in [
        "tag_assignment_definitions",
        "hub_content_tags",
        "tag_taxonomy_relations",
        "tag_source_writebacks",
    ] {
        let mut query = c
            .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
            .unwrap();
        let columns = query.column_count();
        let mut rows = query.query([]).unwrap();
        let mut hash = Sha256::new();
        let mut count = 0;
        while let Some(row) = rows.next().unwrap() {
            for column in 0..columns {
                hash.update(format!("{:?}\n", row.get_ref(column).unwrap()).as_bytes());
            }
            count += 1;
        }
        state.insert(
            table.into(),
            json!({"rows":count,"sha256":format!("{:x}",hash.finalize())}),
        );
    }
    state.into()
}

#[test]
#[ignore = "explicit existing daily data and real model; creates only Work, unconfirmed drafts and pending suggestions"]
fn live_unified_tag_scenarios() {
    let config: Value = serde_json::from_slice(
        &std::fs::read(
            std::env::var_os("HUB_DAILY_TAG_CONFIG").expect("explicit daily tag config required"),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(config["format"], "hub-daily-tag-v1");
    let root = PathBuf::from(config["dataRoot"].as_str().unwrap());
    let out = PathBuf::from(config["evidenceDir"].as_str().unwrap());
    assert!(root.join("craft-search.sqlite3").is_file() && out.is_dir());
    std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(out.join("started"))
        .unwrap();
    let save = |name: &str, value: &Value| {
        std::fs::write(
            out.join(format!("{name}.json")),
            serde_json::to_vec_pretty(value).unwrap(),
        )
        .unwrap();
    };
    let before = protected_state(&root);
    save("protected-before", &before);
    let progress_dir = root.join("assignment-discovery-progress");
    let existing_progress: Vec<_> = std::fs::read_dir(&progress_dir)
        .into_iter()
        .flatten()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .filter(|path| {
            path.file_name().and_then(|name| name.to_str())
                != config["mutableCheckpointFile"].as_str()
        })
        .map(|path| {
            let hash = Sha256::digest(std::fs::read(&path).unwrap());
            (path, format!("{hash:x}"))
        })
        .collect();
    let created = if let Some(id) = config["existingWorkId"].as_str() {
        let view = ui(&root, &json!({"action":"status","id":id})).unwrap();
        assert!(!view["runActive"].as_bool().unwrap_or(true));
        assert_eq!(view["work"]["grant"]["libraryIds"], config["libraryIds"]);
        view
    } else {
        ui(&root, &json!({"action":"create","goal":config["goal"],"successCriteria":"","anchor":null,"grant":Grant::default()})).unwrap()
    };
    let id = created["work"]["id"].as_str().unwrap();
    if config["existingWorkId"].is_null() {
        ui(&root, &json!({"action":"replaceResearchScope","id":id,"expectedRevision":created["work"]["revision"],"expectedAuthorizationVersion":created["work"]["authorizationVersion"],"grant":{"libraryIds":config["libraryIds"],"notes":[],"readingItemKeys":[]}})).unwrap();
        options::configure(&root, &json!({"id":id,"options":{"model":config["model"],"researchPolicy":"materials-only","webSearch":"disabled","autoFlashcardInbox":false}})).unwrap();
    }
    save(
        "work-created",
        &ui(&root, &json!({"action":"status","id":id})).unwrap(),
    );
    let mut previous_task = Value::Null;
    if config["existingWorkId"].is_string()
        && config["steps"][0]["intent"]["task"] == "missing"
        && config["steps"][0]["intent"]["resume"] == true
    {
        let intent = &config["steps"][0]["intent"];
        assert_eq!(intent["task"], "missing");
        assert_eq!(intent["resume"], true);
        previous_task=crate::hub_mcp::agent_tags::discovery_checkpoint(&root,
            &json!({"tag":intent["tag"],"expectedVersion":intent["expectedVersion"],"libraryIds":config["libraryIds"]})).unwrap();
        save("resumed-checkpoint-before", &previous_task);
    }
    let mut failures = Vec::new();
    let steps = config["steps"].as_array().unwrap();
    assert!(!steps.is_empty());
    for step in steps {
        let name = step["id"].as_str().unwrap();
        assert!(name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
        if step["onlyIfRemaining"] == true
            && previous_task["remainingCount"].as_u64().unwrap_or(0) == 0
        {
            save(
                name,
                &json!({"skipped":true,"reason":"previous batch has no remaining candidates","previousResult":previous_task}),
            );
            continue;
        }
        let current = ui(&root, &json!({"action":"status","id":id})).unwrap();
        let messaged = if step["reuseCurrentRevision"] == true {
            assert_eq!(current["work"]["revision"], config["expectedRevision"]);
            let old = tag_tasks::records(&root, id)
                .unwrap()
                .into_iter()
                .find(|r| {
                    r["revision"] == current["work"]["revision"] && r["intent"] == step["intent"]
                })
                .expect("same-revision recovery must reuse the actual saved task");
            previous_task = old["result"].clone();
            save("reused-task-before", &old);
            current
        } else {
            let view=ui(&root, &json!({"action":"message","id":id,"expectedRevision":current["work"]["revision"],"clientMessageId":format!("daily-tags-{name}"),"text":step["question"]})).unwrap();
            ui(&root, &json!({"action":"configureTagTask","id":id,"expectedRevision":view["work"]["revision"],"intent":step["intent"]})).unwrap();
            view
        };
        let mode = if messaged["lifecycle"]["executionModes"]["deep"] == true {
            "deep"
        } else {
            "quick"
        };
        let started = std::time::Instant::now();
        let result = ui(&root, &json!({"action":"respond","id":id,"mode":mode}));
        let view = ui(&root, &json!({"action":"status","id":id})).unwrap();
        let mut records = serde_json::Map::new();
        for kind in [
            "tagTaskResult",
            "tagTaskCheckpoint",
            "tagTaskResultPart",
            "modelExecution",
            "nativeMeasurement",
            "nativeRuntime",
            "nativeSession",
            "modelCallFailure",
            "outputRejected",
            "toolCall",
            "toolResult",
        ] {
            records.insert(
                kind.into(),
                json!(store::records(&root, id, kind, 200).unwrap()),
            );
        }
        let after = protected_state(&root);
        save(
            name,
            &json!({"workId":id,"name":name,"result":result,"elapsedMs":started.elapsed().as_millis(),"view":view,"records":records,"protectedAfter":after}),
        );
        assert_eq!(
            before, after,
            "formal definitions, approvals and source-write receipts must remain unchanged"
        );
        for (path, hash) in &existing_progress {
            assert_eq!(
                format!("{:x}", Sha256::digest(std::fs::read(path).unwrap())),
                *hash,
                "existing discovery checkpoint changed"
            );
        }
        if let Err(error) = result {
            failures.push(format!("{name}: {error}"));
            break;
        }
        assert_eq!(view["work"]["id"], id);
        assert_eq!(view["work"]["grant"]["libraryIds"], config["libraryIds"]);
        assert!(view["actions"]["items"].as_array().unwrap().is_empty());
        let revision = view["work"]["revision"].as_i64().unwrap();
        let task = tag_tasks::records(&root, id)
            .unwrap()
            .into_iter()
            .find(|record| record["revision"].as_i64() == Some(revision))
            .expect("task result must belong to this conversational turn");
        assert_eq!(task["intent"], step["intent"]);
        if step["reuseCurrentRevision"] == true {
            assert_eq!(
                task["result"], previous_task,
                "summarizing again must not regenerate the business task"
            );
            assert_eq!(
                view["run"]["usage"]["modelCalls"], 0,
                "saved domain result must not call the structured model again"
            );
        }
        if step["intent"]["task"] == "missing" {
            let next = task["result"]["processedCount"].as_u64().unwrap_or(0);
            let prior = if step["intent"]["resume"] == true {
                previous_task["processedCount"].as_u64().unwrap_or(0)
            } else {
                0
            };
            assert!(
                next >= prior && next - prior <= 5,
                "each batch must stay within five candidates"
            );
            let old_ids: Vec<_> = previous_task["submitted"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|v| v["proposalId"].clone())
                .collect();
            let ids: Vec<_> = task["result"]["submitted"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v["proposalId"].clone())
                .collect();
            assert!(
                ids.starts_with(&old_ids),
                "resume must preserve prior authoritative suggestion identities"
            );
            assert_eq!(
                ids.iter().collect::<std::collections::HashSet<_>>().len(),
                ids.len(),
                "resume must not duplicate suggestions"
            );
        }
        previous_task = task["result"].clone();
    }
    save("protected-after", &protected_state(&root));
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
