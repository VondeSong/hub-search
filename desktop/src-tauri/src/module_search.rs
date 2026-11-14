//! Live projections keep module edits, sync receipts and deletion in the same database snapshot.
use crate::*;

pub(super) struct Scope {
    pub libraries: Vec<String>,
    pub global: bool,
    pub folders: Option<Vec<String>>,
    pub documents: Option<Vec<String>>,
    pub pages: Option<Vec<String>>,
    pub updated_after: Option<i64>,
}

fn exists(c: &Connection, table: &str) -> Result<bool, String> {
    c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [table],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

fn result(
    kind: &str,
    id: String,
    title: String,
    body: String,
    path: String,
    updated: i64,
    query: &str,
) -> IndexedSearchResult {
    let title_match = !query.is_empty() && title.to_lowercase().contains(&query.to_lowercase());
    let score = if title.to_lowercase() == query.to_lowercase() && !query.is_empty() {
        32.0
    } else if title_match {
        16.0
    } else {
        4.0
    };
    let name = if kind == "reading" {
        "阅读"
    } else {
        "闪卡"
    };
    let terms = if query.is_empty() {
        Vec::new()
    } else {
        vec![query.to_string()]
    };
    let snippet = if query.is_empty() {
        body.chars().take(240).collect()
    } else {
        let lower = body.to_lowercase();
        let start = lower
            .find(&query.to_lowercase())
            .map(|i| lower[..i].chars().count().saturating_sub(60))
            .unwrap_or(0);
        body.chars().skip(start).take(240).collect()
    };
    IndexedSearchResult {
        id: format!("{kind}:{id}:{:x}", sha2::Sha256::digest(body.as_bytes())),
        entity_key: format!("{kind}:{id}"),
        block_id: String::new(),
        document_id: id,
        content_type: kind.into(),
        source_item_id: None,
        source_type: kind.into(),
        source_title: Some(name.into()),
        page_number: None,
        score: Some(score),
        provider: "hub".into(),
        library_id: format!("@hub:{kind}"),
        library_name: name.into(),
        space_id: format!("@hub:{kind}"),
        space_name: name.into(),
        title: title.clone(),
        document_title: title,
        path,
        folder_id: None,
        modified_at: Some(updated),
        task_status: None,
        snippet,
        match_terms: terms,
        match_field: if title_match { "title" } else { "body" }.into(),
        match_count: 1,
        sub_matches: Vec::new(),
    }
}

pub(super) fn search(
    c: &Connection,
    query: &str,
    limit: usize,
    scope: &Scope,
    reading: bool,
    cards: bool,
    field: &str,
) -> Result<Vec<IndexedSearchResult>, String> {
    if !scope.global && scope.libraries.is_empty() {
        return Ok(Vec::new());
    }
    if !matches!(field, "all" | "title" | "title_heading") {
        return Ok(Vec::new());
    }
    // Use the same Unicode lowercase match as the rendered fields, once per SQL value.
    c.create_scalar_function(
        "hub_module_contains",
        2,
        rusqlite::functions::FunctionFlags::SQLITE_UTF8
            | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            let text: String = ctx.get(0)?;
            let query: String = ctx.get(1)?;
            Ok(text.to_lowercase().contains(&query))
        },
    )
    .map_err(|e| e.to_string())?;
    let query_lower = query.to_lowercase();
    let libraries = serde_json::to_string(&scope.libraries).map_err(|e| e.to_string())?;
    let folders = scope
        .folders
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|e| e.to_string())?;
    let documents = scope
        .documents
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|e| e.to_string())?;
    let pages = scope
        .pages
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|e| e.to_string())?;
    let mut hits = Vec::new();
    if cards && exists(c, "flashcards")? {
        let sql = "SELECT f.id,f.question,f.answer,f.explanation,d.name,
          CASE WHEN f.updated_at>100000000000 THEN f.updated_at/1000 ELSE f.updated_at END AS updated
          FROM flashcards f JOIN flashcard_decks d ON d.id=f.deck_id
          WHERE f.status IN ('active','suspended') AND (f.source_library_id IN (SELECT value FROM json_each(?2)) OR (?3 AND f.source_library_id=''))
          AND (?4 IS NULL OR EXISTS(SELECT 1 FROM documents n WHERE n.space_id=f.source_library_id AND n.id=f.source_document_id AND n.folder_id IN (SELECT value FROM json_each(?4))))
          AND (?5 IS NULL OR f.source_document_id IN (SELECT value FROM json_each(?5)))
          AND (?6 IS NULL OR f.source_block_id IN (SELECT value FROM json_each(?6)) OR f.source_document_id IN (SELECT value FROM json_each(?6)))
          AND (?7 IS NULL OR updated>=?7)
          AND (?1='' OR hub_module_contains(CASE WHEN ?9='all' THEN f.question||' '||f.answer||' '||f.explanation ELSE f.question END,?1))
          ORDER BY CASE WHEN ?1<>'' AND lower(f.question)=?1 THEN 2 ELSE hub_module_contains(f.question,?1) END DESC,updated DESC,f.id LIMIT ?8";
        let mut s = c.prepare(sql).map_err(|e| e.to_string())?;
        let rows = s
            .query_map(
                params![
                    query_lower,
                    libraries,
                    scope.global,
                    folders,
                    documents,
                    pages,
                    scope.updated_after,
                    limit as i64,
                    field
                ],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, i64>(5)?,
                    ))
                },
            )
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (id, question, answer, explanation, deck, updated) =
                row.map_err(|e| e.to_string())?;
            hits.push(result(
                "flashcard",
                id,
                question.clone(),
                format!("{question}\n\n{answer}\n\n{explanation}"),
                deck,
                updated,
                query,
            ));
        }
    }
    if reading && exists(c, "collection_x_items")? {
        let copies = crate::x_bookmarks::search_saved_copies(c)?;
        let sql=format!("WITH saved_copies AS ({copies}) SELECT t.item_key,t.post_json,t.collected_at,t.read_at
          FROM collection_x_items t
          WHERE COALESCE((SELECT state FROM collection_lifecycle WHERE item_key=t.item_key),'active')='active'
          AND COALESCE((SELECT status FROM collection_x_properties WHERE item_key=t.item_key),'unread')<>'abandoned'
          AND (?3 OR EXISTS(SELECT 1 FROM saved_copies s WHERE s.item_key=t.item_key AND s.library_id IN (SELECT value FROM json_each(?2))))
          AND ((?4 IS NULL AND ?5 IS NULL AND ?6 IS NULL) OR EXISTS(
            SELECT 1 FROM collection_remote_copies r JOIN documents n ON n.space_id=r.library_id AND (n.id=r.object_id OR n.id=r.parent_id)
            WHERE r.item_key=t.item_key AND r.verified=1 AND r.parent_id<>'attachment' AND r.library_id IN (SELECT value FROM json_each(?2))
            AND (?4 IS NULL OR n.folder_id IN (SELECT value FROM json_each(?4)))
            AND (?5 IS NULL OR n.id IN (SELECT value FROM json_each(?5)))
            AND (?6 IS NULL OR r.object_id IN (SELECT value FROM json_each(?6)) OR n.id IN (SELECT value FROM json_each(?6)))))
          AND (?7 IS NULL OR t.collected_at/1000>=?7)
          AND (?1='' OR EXISTS(SELECT 1 FROM json_tree(t.post_json) atom WHERE atom.type='text' AND hub_module_contains(atom.value,?1)))
          ORDER BY t.collected_at DESC,t.item_key");
        let mut s = c.prepare(&sql).map_err(|e| e.to_string())?;
        // Filter exact rendered fields before the result limit, so metadata-only matches never hide a later hit.
        let rows = s
            .query_map(
                params![
                    query_lower,
                    libraries,
                    scope.global,
                    folders,
                    documents,
                    pages,
                    scope.updated_after
                ],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, i64>(3)?,
                    ))
                },
            )
            .map_err(|e| e.to_string())?;
        let mut top = std::collections::BTreeMap::new();
        for row in rows {
            let (key, raw, at, read) = row.map_err(|e| e.to_string())?;
            let item = crate::collection_models::Item {
                key,
                post: serde_json::from_str(&raw).map_err(|_| "阅读内容损坏")?,
                collected_at: at,
                read: read > 0,
            };
            let title = crate::x_bookmarks::storage::display_title(&item);
            let body = crate::x_bookmarks::storage::render_task_content(&item);
            let text = if field == "all" {
                format!("{title}\n{body}")
            } else {
                title.clone()
            };
            if !query.is_empty() && !text.to_lowercase().contains(&query_lower) {
                continue;
            }
            let hit = result(
                "reading",
                item.key,
                title,
                body,
                "阅读资料".into(),
                at / 1000,
                query,
            );
            let rank = (
                std::cmp::Reverse(hit.score.unwrap_or(0.0) as u32),
                std::cmp::Reverse(at),
                hit.entity_key.clone(),
            );
            top.insert(rank, hit);
            if top.len() > limit {
                top.pop_last();
            }
            if query.is_empty() && top.len() == limit {
                break;
            }
        }
        hits.extend(top.into_values());
    }
    Ok(hits)
}

pub(super) fn finish(
    mut results: Vec<IndexedSearchResult>,
    limit: usize,
) -> Vec<IndexedSearchResult> {
    results.sort_by(|a, b| {
        b.score
            .unwrap_or(0.0)
            .total_cmp(&a.score.unwrap_or(0.0))
            .then_with(|| b.modified_at.cmp(&a.modified_at))
            .then_with(|| a.entity_key.cmp(&b.entity_key))
    });
    let mut seen = HashSet::new();
    results.retain(|r| seen.insert(r.entity_key.clone()));
    results.truncate(limit);
    results
}

pub(super) fn read_document(
    root: &Path,
    c: &Connection,
    kind: &str,
    id: &str,
) -> Result<String, String> {
    if id.is_empty() || id.len() > 2000 {
        return Err("搜索结果身份无效".into());
    }
    match kind {
        "flashcard" => {
            let (question,answer,explanation,library):(String,String,String,String)=c.query_row("SELECT question,answer,explanation,source_library_id FROM flashcards WHERE id=?1 AND status IN ('active','suspended') AND EXISTS(SELECT 1 FROM flashcard_decks d WHERE d.id=flashcards.deck_id)",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(|_|"这张闪卡已不存在，请重新搜索")?;
            let db = root.join("craft-search.sqlite3");
            if !library.is_empty()
                && (!visible_library_ids(&db, &c)?.contains(&library)
                    || hidden_library_ids(&db, &c)?.contains(&library))
            {
                return Err("闪卡来源不在当前可见范围，请重新搜索".into());
            }
            Ok(format!(
                "## 问题\n\n{question}\n\n## 答案\n\n{answer}\n\n## 解释\n\n{explanation}"
            ))
        }
        "reading" => {
            let entries = crate::x_bookmarks::evidence_entries(c, &[id.to_owned()], "", 1)?;
            let entry = entries
                .into_iter()
                .find(|e| e.state == "active" && e.status != "abandoned")
                .ok_or("这条阅读资料已移除或归档，请重新搜索")?;
            Ok(crate::x_bookmarks::storage::render_task_content(
                &entry.item,
            ))
        }
        _ => Err("搜索结果类型无效".into()),
    }
}
#[tauri::command]
pub(crate) async fn module_search_document(
    app: AppHandle,
    kind: String,
    id: String,
) -> Result<String, String> {
    let root = active_data_root(&app)?;
    tokio::task::spawn_blocking(move || {
        let _permit = library_runtime::cached_read_permit(&root)?;
        let c = source_evidence::open_read_database(&root)?;
        read_document(&root, &c, &kind, &id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn older_exact_reading_titles_survive_the_limit_and_json_escaping() {
        let f = source_evidence::tests::Fixture::new();
        f.reading("old", "needle");
        f.reading("new", "Other title\nneedle body");
        let c = f.c();
        c.execute(
            "UPDATE collection_x_items SET collected_at=3000 WHERE item_key='new'",
            [],
        )
        .unwrap();
        let hits = search(&c, "needle", 1, &scope(true), true, false, "all").unwrap();
        assert_eq!(hits[0].document_id, "old");
        f.reading("quoted", "hello \"world\" is quoted");
        assert_eq!(
            search(&c, "hello \"world\"", 10, &scope(true), true, false, "all")
                .unwrap()
                .len(),
            1
        );
    }
    #[test]
    fn body_versions_invalidate_previews_without_changing_entity_identity() {
        let f = source_evidence::tests::Fixture::new();
        let c = f.c();
        card(&c, "a", "notes", "first");
        let before = search(&c, "", 10, &scope(false), false, true, "all")
            .unwrap()
            .remove(0);
        assert!(read_document(&f.root, &c, "flashcard", "a")
            .unwrap()
            .contains("first"));
        c.execute(
            "UPDATE flashcards SET explanation='second' WHERE id='a'",
            [],
        )
        .unwrap();
        let after = search(&c, "", 10, &scope(false), false, true, "all")
            .unwrap()
            .remove(0);
        assert_eq!(before.entity_key, after.entity_key);
        assert_ne!(before.id, after.id);
        c.execute("UPDATE libraries SET enabled=0 WHERE id='notes'", [])
            .unwrap();
        assert!(read_document(&f.root, &c, "flashcard", "a").is_err());
    }
    #[test]
    #[ignore = "Explicit daily-data read-only verification; requires HUB_MODULE_SEARCH_REAL_ROOT"]
    fn real_daily_readonly() {
        let root = PathBuf::from(
            std::env::var("HUB_MODULE_SEARCH_REAL_ROOT")
                .expect("Set an explicit existing daily root"),
        );
        let db = root.join("craft-search.sqlite3");
        assert!(db.is_file());
        let c =
            Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        c.execute_batch("PRAGMA query_only=ON").unwrap();
        let hidden = hidden_library_ids(&db, &c).unwrap();
        let libraries = visible_library_ids(&db, &c)
            .unwrap()
            .into_iter()
            .filter(|id| !hidden.contains(id))
            .collect::<Vec<_>>();
        let scope = Scope {
            libraries,
            global: true,
            folders: None,
            documents: None,
            pages: None,
            updated_after: None,
        };
        let selected = serde_json::to_string(&scope.libraries).unwrap();
        let (id,question):(String,String)=c.query_row("SELECT id,question FROM flashcards WHERE length(trim(question))>0 AND (source_library_id='' OR source_library_id IN (SELECT value FROM json_each(?1))) ORDER BY updated_at DESC,id LIMIT 1",[selected],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        let query = question.trim().chars().take(60).collect::<String>();
        let start = std::time::Instant::now();
        let cards = search(&c, &query, 200, &scope, false, true, "all").unwrap();
        assert!(cards.iter().any(|r| r.document_id == id));
        let card_ms = start.elapsed().as_millis();
        assert!(read_document(&root, &c, "flashcard", &id)
            .unwrap()
            .contains(&question));
        let (key,raw):(String,String)=c.query_row("SELECT t.item_key,t.post_json FROM collection_x_items t WHERE COALESCE((SELECT state FROM collection_lifecycle WHERE item_key=t.item_key),'active')='active' AND COALESCE((SELECT status FROM collection_x_properties WHERE item_key=t.item_key),'unread')<>'abandoned' AND length(trim(json_extract(t.post_json,'$.text')))>0 ORDER BY collected_at DESC,item_key LIMIT 1",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        let post: crate::collection_models::Post = serde_json::from_str(&raw).unwrap();
        let query = post.text.trim().chars().take(60).collect::<String>();
        let start = std::time::Instant::now();
        let readings = search(&c, &query, 200, &scope, true, false, "all").unwrap();
        assert!(readings.iter().any(|r| r.document_id == key));
        let reading_ms = start.elapsed().as_millis();
        assert!(!read_document(&root, &c, "reading", &key)
            .unwrap()
            .is_empty());
        let card_count: i64 = c
            .query_row("SELECT count(*) FROM flashcards", [], |r| r.get(0))
            .unwrap();
        let reading_count: i64 = c
            .query_row("SELECT count(*) FROM collection_x_items", [], |r| r.get(0))
            .unwrap();
        eprintln!("Daily readonly: cards={card_count}, readings={reading_count}, card_query_ms={card_ms}, reading_query_ms={reading_ms}, exact targets and previews verified; no source content logged");
    }
    fn scope(global: bool) -> Scope {
        Scope {
            libraries: vec!["notes".into()],
            global,
            folders: None,
            documents: None,
            pages: None,
            updated_after: None,
        }
    }
    fn card(c: &Connection, id: &str, library: &str, explanation: &str) {
        c.execute("INSERT OR IGNORE INTO flashcard_decks(id,name,created_at,updated_at) VALUES('deck','知识',1,1)",[]).unwrap();
        c.execute("INSERT INTO flashcards(id,deck_id,question,answer,explanation,source_library_id,created_at,updated_at,due_at) VALUES(?1,'deck','可见问题','答案',?2,?3,1,1,1)",params![id,explanation,library]).unwrap();
    }
    #[test]
    fn card_fields_respect_scope_title_filter_and_native_identity() {
        let f = source_evidence::tests::Fixture::new();
        let c = f.c();
        card(&c, "a", "notes", "独特解释");
        card(&c, "b", "private", "独特解释");
        card(&c, "own", "", "独特解释");
        let global = search(&c, "独特解释", 20, &scope(true), false, true, "all").unwrap();
        assert_eq!(global.len(), 2);
        assert!(global
            .iter()
            .all(|r| r.provider == "hub" && r.content_type == "flashcard"));
        assert_eq!(
            search(&c, "独特解释", 20, &scope(false), false, true, "all")
                .unwrap()
                .len(),
            1
        );
        assert!(
            search(&c, "独特解释", 20, &scope(true), false, true, "title")
                .unwrap()
                .is_empty()
        );
        let mut empty = scope(false);
        empty.libraries.clear();
        assert!(search(&c, "", 20, &empty, true, true, "all")
            .unwrap()
            .is_empty());
    }
    #[test]
    fn module_changes_are_visible_without_index_rebuild_and_archives_stay_out() {
        let f = source_evidence::tests::Fixture::new();
        let c = f.c();
        card(&c, "a", "notes", "OldWord");
        f.reading("r", "OldWord 阅读正文");
        assert_eq!(
            search(&c, "OldWord", 20, &scope(true), true, true, "all")
                .unwrap()
                .len(),
            2
        );
        c.execute(
            "UPDATE flashcards SET explanation='NewWord',updated_at=2 WHERE id='a'",
            [],
        )
        .unwrap();
        c.execute("UPDATE collection_x_items SET post_json=replace(post_json,'OldWord','NewWord') WHERE item_key='r'",[]).unwrap();
        drop(c);
        let c = f.c();
        assert!(search(&c, "OldWord", 20, &scope(true), true, true, "all")
            .unwrap()
            .is_empty());
        assert_eq!(
            search(&c, "NewWord", 20, &scope(true), true, true, "all")
                .unwrap()
                .len(),
            2
        );
        c.execute(
            "INSERT INTO collection_lifecycle(item_key,state) VALUES('r','archived')",
            [],
        )
        .unwrap();
        c.execute("DELETE FROM flashcards WHERE id='a'", [])
            .unwrap();
        assert!(search(&c, "NewWord", 20, &scope(true), true, true, "all")
            .unwrap()
            .is_empty());
    }
    #[test]
    fn module_identity_deduplicates_within_each_type_and_limit_is_stable() {
        let make = |kind, id| {
            result(
                kind,
                id,
                String::from("标题"),
                String::from("正文"),
                String::new(),
                1,
                "",
            )
        };
        let hits = finish(
            vec![
                make("reading", "same".into()),
                make("flashcard", "same".into()),
                make("reading", "same".into()),
            ],
            10,
        );
        assert_eq!(hits.len(), 2);
        assert_ne!(hits[0].entity_key, hits[1].entity_key);
    }
    #[test]
    fn large_card_catalog_keeps_query_and_result_limit_in_the_database() {
        let f = source_evidence::tests::Fixture::new();
        let mut c = f.c();
        card(&c, "first", "notes", "needle");
        let tx = c.transaction().unwrap();
        {
            let mut insert=tx.prepare("INSERT INTO flashcards(id,deck_id,question,answer,explanation,source_library_id,created_at,updated_at,due_at) VALUES(?1,'deck','Bulk question','Answer',?2,'notes',1,1,1)").unwrap();
            for i in 0..10000 {
                insert
                    .execute(params![
                        format!("bulk-{i}"),
                        if i % 1000 == 0 { "needle" } else { "other" }
                    ])
                    .unwrap();
            }
        }
        tx.commit().unwrap();
        let hits = search(&c, "needle", 4, &scope(false), false, true, "all").unwrap();
        assert_eq!(hits.len(), 4);
        assert!(hits.iter().all(|r| r.snippet.contains("needle")));
    }
}
