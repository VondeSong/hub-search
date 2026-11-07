use super::*;

#[test]
fn exact_task_projection_and_metadata_hints_keep_unrelated_bodies_out() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    let f = Fixture::new();
    f.note("craft", "doc", "父页");
    f.c().execute_batch("INSERT INTO craft_task_blocks(space_id,document_id,block_id,title,completed,source_hash,content) VALUES('craft','doc','one','检查配合条件',0,'one','合法内容'),('craft','doc','secret','不相关','0','secret','PRIVATE_SENTINEL');").unwrap();
    let locator = EvidenceLocator::Task {
        library_id: "craft".into(),
        source_id: "one".into(),
    };
    let reader = EvidenceReader::new(
        &f.root,
        EvidenceScope::new(vec![], vec![])
            .unwrap()
            .with_sources(vec![locator.clone()])
            .unwrap(),
    );
    let excerpt = reader.read(&locator, 0, 20_000, None).unwrap();
    assert!(excerpt.content.contains("合法内容"));
    assert!(!excerpt.content.contains("PRIVATE_SENTINEL"));
    assert!(reader
        .read(
            &EvidenceLocator::Task {
                library_id: "craft".into(),
                source_id: "secret".into()
            },
            0,
            100,
            None
        )
        .is_err());
    let c = f.c();
    c.authorizer(Some(|ctx: AuthContext<'_>| match ctx.action {
        AuthAction::Read {
            column_name: "markdown" | "body" | "raw_json" | "content" | "description",
            ..
        } => Authorization::Deny,
        _ => Authorization::Allow,
    }));
    let first = reader
        .change_hints_in_transaction(&c, &[locator.clone()])
        .unwrap();
    f.c()
        .execute(
            "UPDATE craft_task_blocks SET content='新说明' WHERE block_id='one'",
            [],
        )
        .unwrap();
    assert_ne!(
        first,
        reader
            .change_hints_in_transaction(&c, &[locator.clone()])
            .unwrap()
    );
    assert!(!reader
        .change_hints_in_transaction(&c, &[locator])
        .unwrap()
        .to_string()
        .contains("新说明"));
    assert_eq!(
        f.c()
            .query_row::<i64, _, _>("SELECT COUNT(*) FROM task_activity", [], |r| r.get(0))
            .unwrap(),
        0
    );
}

#[test]
fn qualified_attachment_ranges_bind_input_and_text_and_legacy_chunks_stay_uncitable() {
    let f = Fixture::new();
    let (job, input) = crate::attachment_evidence::tests::seed(&f, "pdf-evidence", "输入");
    crate::attachment_evidence::tests::produce(&f, &job, &input, "工艺要求：先测量，再加工。");
    let chunk: String = f
        .c()
        .query_row(
            "SELECT id FROM content_items WHERE source_item_id='pdf-evidence'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let locator = EvidenceLocator::Attachment {
        library_id: "notes".into(),
        document_id: "attachment-doc".into(),
        source_item_id: "pdf-evidence".into(),
        chunk_id: chunk.clone(),
        page_number: Some(1),
    };
    let legacy = EvidenceReader::new(
        &f.root,
        EvidenceScope::new(vec!["notes".into()], vec![]).unwrap(),
    );
    assert!(legacy.read(&locator, 0, 100, None).is_err()); // Old whole-library grants never expand silently.
    let reader = EvidenceReader::new(
        &f.root,
        EvidenceScope::new(vec![], vec![])
            .unwrap()
            .with_sources(vec![locator.clone()])
            .unwrap(),
    );
    let excerpt = reader.read(&locator, 5, 4, None).unwrap();
    assert_eq!(excerpt.content, "先测量，");
    assert!(excerpt.truncated);
    assert_eq!(excerpt.facts["wholeAttachmentRead"], false);
    reader.verify(&excerpt).unwrap();
    f.c()
        .execute(
            "UPDATE content_items SET body='不匹配的新文字' WHERE id=?1",
            [&chunk],
        )
        .unwrap();
    assert!(reader.verify(&excerpt).is_err());
    f.c()
        .execute(
            "UPDATE content_items SET input_version=NULL WHERE id=?1",
            [&chunk],
        )
        .unwrap();
    assert!(reader.read(&locator, 0, 100, None).is_err());
    let hint = reader.change_hints(&[locator]).unwrap();
    assert_eq!(hint[0]["available"], true);
    assert_eq!(hint[0]["ready"], false);
}

#[test]
fn selected_project_keeps_authoritative_child_completion_and_excludes_other_tasks() {
    let f = Fixture::new();
    f.note("craft", "project", "项目");
    f.c()
        .execute(
            "UPDATE documents SET title='工艺 #项目',provider='craft' WHERE id='project'",
            [],
        )
        .unwrap();
    f.c().execute_batch("INSERT INTO craft_task_blocks(space_id,document_id,block_id,parent_page_id,title,completed,source_hash) VALUES('craft','project','child','project','核对',0,'a');").unwrap();
    let source = craft_project_source_id("project");
    let rows =
        unified_task_read::load_selected(&f.c(), &[("craft".into(), source.clone())]).unwrap();
    assert_eq!(rows.len(), 1);
    assert!(rows[0].is_project);
    assert!(!rows[0].completed);
    f.c()
        .execute(
            "UPDATE craft_task_blocks SET completed=1 WHERE block_id='child'",
            [],
        )
        .unwrap();
    assert!(
        unified_task_read::load_selected(&f.c(), &[("craft".into(), source)]).unwrap()[0].completed
    );
}

#[test]
fn change_hints_are_scoped_metadata_even_when_body_reads_are_denied() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    let f = Fixture::new();
    f.note("notes", "one", "正文不应进入监测器");
    f.note("private", "secret", "SENSITIVE");
    let locator = EvidenceLocator::Note {
        library_id: "notes".into(),
        document_id: "one".into(),
        page_id: None,
    };
    let reader = EvidenceReader::new(
        &f.root,
        EvidenceScope::new(vec![], vec![])
            .unwrap()
            .with_notes(vec![locator.clone()])
            .unwrap(),
    );
    let c = f.c();
    c.authorizer(Some(|ctx: AuthContext<'_>| match ctx.action {
        AuthAction::Read {
            column_name: "markdown" | "post_json",
            ..
        } => Authorization::Deny,
        _ => Authorization::Allow,
    }));
    let first = reader
        .change_hints_in_transaction(&c, &[locator.clone()])
        .unwrap();
    assert_eq!(first[0]["available"], true);
    assert!(!first.to_string().contains("正文"));
    let secret = EvidenceLocator::Note {
        library_id: "private".into(),
        document_id: "secret".into(),
        page_id: None,
    };
    assert!(reader.change_hints_in_transaction(&c, &[secret]).is_err());
    c.execute(
        "UPDATE documents SET content_hash='changed' WHERE id='one'",
        [],
    )
    .unwrap();
    assert_ne!(
        first,
        reader.change_hints_in_transaction(&c, &[locator]).unwrap()
    );
}

#[test]
fn reading_change_hints_track_state_without_deserializing_post_content() {
    let f = Fixture::new();
    f.reading("one", "阅读正文");
    let locator = EvidenceLocator::Reading {
        item_key: "one".into(),
    };
    let reader = f.reader(&[], &["one"]);
    let first = reader.change_hints(&[locator.clone()]).unwrap();
    f.c().execute("UPDATE collection_x_items SET post_json='{broken',read_version=read_version+1 WHERE item_key='one'",[]).unwrap();
    let changed = reader.change_hints(&[locator.clone()]).unwrap();
    assert_ne!(first, changed);
    assert!(reader.read(&locator, 0, 100, None).is_err()); // A hint never certifies readable evidence.
    f.c()
        .execute(
            "INSERT INTO collection_lifecycle(item_key,state) VALUES('one','removed')",
            [],
        )
        .unwrap();
    assert_eq!(
        reader.change_hints(&[locator]).unwrap()[0]["available"],
        false
    );
}

pub(crate) struct Fixture {
    pub(crate) root: PathBuf,
}
impl Fixture {
    pub(crate) fn new() -> Self {
        let root = std::env::temp_dir().join(format!("hub-evidence-{}", random_url_safe(10)));
        fs::create_dir_all(&root).unwrap();
        let f = Self { root };
        f.c()
            .execute_batch(
                "INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES
            ('notes','obsidian','Notes',1,1),('private','obsidian','Private',1,1),
            ('craft','craft','Craft',1,1),('dida','dida365','Dida',1,1)",
            )
            .unwrap();
        f
    }
    pub(crate) fn c(&self) -> Connection {
        open_database(&self.root.join("craft-search.sqlite3")).unwrap()
    }
    pub(crate) fn note(&self, library: &str, id: &str, body: &str) {
        let document = LocalMarkdownDocument {
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
        let mut c = self.c();
        let tx = c.transaction().unwrap();
        upsert_obsidian_document(&tx, library, &document, 1).unwrap();
        tx.commit().unwrap();
    }
    pub(crate) fn index(&self) {
        let mut c = self.c();
        let records = search_index_runtime::collect_index_records(&c, None).unwrap();
        let index_root = self.root.join("tantivy-generations-v1");
        search_index_runtime::build_and_activate_search_generation(&mut c, &index_root, |index| {
            index.rebuild(&records)?;
            Ok(records.len())
        })
        .unwrap();
    }
    fn reader(&self, libraries: &[&str], readings: &[&str]) -> EvidenceReader {
        EvidenceReader::new(
            &self.root,
            EvidenceScope::new(
                libraries.iter().map(|s| s.to_string()).collect(),
                readings.iter().map(|s| s.to_string()).collect(),
            )
            .unwrap(),
        )
    }
    pub(crate) fn reading(&self, key: &str, text: &str) {
        let post = collection_models::Post {
            id: key.into(),
            text: text.into(),
            author_name: "Author".into(),
            author_handle: "author".into(),
            url: format!("https://example.com/{key}"),
            source: "telegram".into(),
            ..Default::default()
        };
        let raw = serde_json::to_string(&post).unwrap();
        self.c().execute("INSERT INTO collection_x_items(item_key,account,post_json,content_hash,collected_at,captured_at)
            VALUES(?1,'fixture',?2,?3,1,1)",params![key,raw,format!("{:x}",Sha256::digest(raw.as_bytes()))]).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        assert_eq!(self.root.parent(), Some(std::env::temp_dir().as_path()));
        assert!(self
            .root
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("hub-evidence-"));
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn note_locator(library: &str, document: &str) -> EvidenceLocator {
    EvidenceLocator::Note {
        library_id: library.into(),
        document_id: document.into(),
        page_id: None,
    }
}

#[test]
fn production_search_read_followup_and_verification_preserve_scope_and_unicode_ranges() {
    let f = Fixture::new();
    f.note(
        "notes",
        "current",
        "# 转换验证\n明确条件：😀坐标单位必须一致。\n历史决定请见旧决定。",
    );
    f.note(
        "notes",
        "old-decision",
        "# 旧决定\n转换验证必须检查毫米单位，不扩展范围。",
    );
    f.note("private", "secret", "# 转换验证\n不得进入本次上下文。");
    f.index();
    let reader = f.reader(&["notes"], &[]);
    let found = reader.search(EvidenceKind::Note, "转换验证", 20).unwrap();
    assert_eq!(found.candidates.len(), 2);
    assert!(!serde_json::to_string(&found).unwrap().contains("secret"));
    let first = &found.candidates[0];
    let excerpt = reader
        .read(&first.locator, 2, 7, Some(&first.version))
        .unwrap();
    let whole = reader
        .read(&first.locator, 0, 20_000, Some(&first.version))
        .unwrap();
    assert_eq!(
        excerpt.content,
        whole.content.chars().skip(2).take(7).collect::<String>()
    );
    assert_eq!(excerpt.end_char, 9);
    assert!(excerpt.truncated);
    reader.verify(&excerpt).unwrap();
    let next = reader
        .read(&first.locator, excerpt.end_char, 5, Some(&first.version))
        .unwrap();
    assert_eq!(next.start_char, 9);
    let followup = reader.search(EvidenceKind::Note, "旧决定", 20).unwrap();
    assert!(followup
        .candidates
        .iter()
        .any(|c| c.title == "old-decision"));
    let wire = serde_json::to_value(excerpt).unwrap();
    assert_eq!(wire["locator"]["libraryId"], "notes");
    assert_eq!(wire["version"]["kind"], "document");
    assert!(reader
        .read(&note_locator("private", "secret"), 0, 100, None)
        .is_err());
    assert!(!found.exhaustive);
}

#[test]
fn old_index_candidates_are_rehydrated_from_current_authoritative_text() {
    let f = Fixture::new();
    f.note("notes", "decision", "# OldMarker\n旧结论。");
    f.index();
    let reader = f.reader(&["notes"], &[]);
    let before = reader
        .read(&note_locator("notes", "decision"), 0, 100, None)
        .unwrap();
    f.note("notes", "decision", "# NewMarker\n已修正的结论。");
    assert!(reader.verify(&before).unwrap_err().contains("版本"));
    let candidates = reader.search(EvidenceKind::Note, "OldMarker", 10).unwrap();
    assert_eq!(candidates.candidates.len(), 1);
    assert!(candidates.candidates[0].snippet.contains("已修正"));
    assert!(!candidates.candidates[0].snippet.contains("旧结论"));
    f.c()
        .execute(
            "DELETE FROM documents WHERE space_id='notes' AND id='decision'",
            [],
        )
        .unwrap();
    let missing = reader.search(EvidenceKind::Note, "OldMarker", 10).unwrap();
    assert!(missing.candidates.is_empty());
    assert_eq!(missing.unavailable_candidates, 1);
}

#[test]
fn absent_storage_is_not_created_and_read_connection_cannot_write() {
    let f = Fixture::new();
    let absent = f.root.join("absent");
    assert!(open_read_database(&absent).is_err());
    assert!(SearchIndex::open_existing(&absent).is_err());
    assert!(BlobStore::open_existing(&absent).is_err());
    assert!(!absent.exists());
    let c = open_read_database(&f.root).unwrap();
    assert!(c.execute("UPDATE libraries SET enabled=0", []).is_err());
    assert_eq!(c.total_changes(), 0);
    assert!(f
        .reader(&[], &[])
        .search(EvidenceKind::Note, "anything", 10)
        .unwrap()
        .candidates
        .is_empty());
}

#[test]
fn disabled_removed_and_mid_read_control_changes_reject_old_access_but_pause_allows_cache() {
    let f = Fixture::new();
    f.note("notes", "one", "仍可读取的缓存。");
    let reader = f.reader(&["notes"], &[]);
    let locator = note_locator("notes", "one");
    let excerpt = reader.read(&locator, 0, 100, None).unwrap();
    library_runtime::control(&f.root, "notes", "pause").unwrap();
    reader.verify(&excerpt).unwrap();
    let error = reader
        .in_snapshot(|_, _| {
            library_runtime::control(&f.root, "notes", "resume")?;
            Ok(())
        })
        .unwrap_err();
    assert!(error.contains("状态已改变"));
    f.c()
        .execute("UPDATE libraries SET enabled=0 WHERE id='notes'", [])
        .unwrap();
    assert!(reader.verify(&excerpt).is_err());
    f.c()
        .execute("UPDATE libraries SET enabled=1 WHERE id='notes'", [])
        .unwrap();
    library_runtime::control(&f.root, "notes", "remove").unwrap();
    assert!(reader.verify(&excerpt).is_err());
    assert_eq!(reader.catalog().unwrap()["unavailableLibraries"], 1);
}

#[test]
fn craft_empty_and_missing_pages_never_widen_to_parent_content() {
    let f = Fixture::new();
    let body = "父级私有上下文\n<page id=\"empty\">\n<content>\n</content>\n</page>\n<page id=\"child\">\n<content>\n  子页面证据\n</content>\n</page>";
    f.c().execute("INSERT INTO documents(space_id,id,title,path,markdown,indexed_at,content_hash,provider)
        VALUES('craft','doc','Root','Root',?1,1,'hash','craft')",[body]).unwrap();
    let reader = f.reader(&["craft"], &[]);
    let page = |id: &str| EvidenceLocator::Note {
        library_id: "craft".into(),
        document_id: "doc".into(),
        page_id: Some(id.into()),
    };
    assert!(reader
        .read(&page("empty"), 0, 100, None)
        .unwrap()
        .content
        .is_empty());
    let child = reader.read(&page("child"), 0, 100, None).unwrap();
    assert_eq!(child.content, "子页面证据");
    assert!(reader.read(&page("missing"), 0, 100, None).is_err());
    // Keep the existing UI fallback contract.
    assert_eq!(craft_page_preview(body, "doc", "missing"), body);
}

#[test]
fn markdown_line_identity_expires_when_production_document_changes_without_task_edits() {
    let f = Fixture::new();
    f.note("notes", "tasks", "# Tasks\n- [ ] 检查单位\n");
    let reader = f.reader(&["notes"], &[]);
    let result = reader.search(EvidenceKind::Task, "检查单位", 10).unwrap();
    assert_eq!(result.candidates.len(), 1);
    let c = &result.candidates[0];
    let excerpt = reader
        .read(&c.locator, 0, 20_000, Some(&c.version))
        .unwrap();
    f.note(
        "notes",
        "tasks",
        "新增说明\n# Tasks\n- [ ] 另一件事情\n- [ ] 检查单位\n",
    );
    assert!(reader.verify(&excerpt).is_err());
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM task_activity", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn task_sources_are_filtered_before_binding_and_evidence_reads_never_capture_history() {
    let f = Fixture::new();
    f.c().execute_batch("INSERT INTO documents(space_id,id,title,path,markdown,indexed_at,content_hash,provider)
        VALUES('craft','doc','Allowed project','Root','Task',1,'hash','craft');
        INSERT INTO craft_task_blocks(space_id,document_id,block_id,title,completed,deadline_date,source_hash)
        VALUES('craft','doc','block','检查单位',1,'2026-10-20','hash');
        INSERT INTO dida_projects(library_id,project_id,name,raw_json,synced_at) VALUES('dida','project','SECRET PROJECT','{}',1);
        INSERT INTO unified_task_bindings(hub_task_id,provider,library_id,source_id,last_seen_at)
        VALUES('hub-one','craft','craft','block',1),('hub-one','dida365','dida','task',1);").unwrap();
    let raw = json!({"id":"task","projectId":"project","title":"SECRET TITLE","content":"SECRET BODY","status":2,"dueDate":"2030-01-01T12:00:00+08:00","completedTime":"2026-10-01T10:00:00+08:00"});
    let mut parsed = Vec::new();
    collect_dida_tasks(&raw, "project", &mut parsed);
    assert_eq!(parsed.len(), 1);
    let mut c = f.c();
    let tx = c.transaction().unwrap();
    upsert_dida_task(&tx, "dida", "SECRET PROJECT", &parsed[0], 1).unwrap();
    tx.commit().unwrap();
    let limited = f.reader(&["craft"], &[]);
    let found = limited.search(EvidenceKind::Task, "检查单位", 10).unwrap();
    let excerpt = limited
        .read(&found.candidates[0].locator, 0, 20_000, None)
        .unwrap();
    let limited_json = serde_json::to_string(&excerpt).unwrap();
    assert!(!limited_json.contains("SECRET"));
    assert!(!limited_json.contains("2030"));
    assert_eq!(excerpt.facts["sources"].as_array().unwrap().len(), 1);
    let all = f.reader(&["craft", "dida"], &[]);
    let found = all.search(EvidenceKind::Task, "检查单位", 10).unwrap();
    assert_eq!(found.candidates.len(), 1);
    let excerpt = all
        .read(&found.candidates[0].locator, 0, 20_000, None)
        .unwrap();
    assert_eq!(excerpt.facts["sources"].as_array().unwrap().len(), 2);
    assert!(excerpt.content.contains("SECRET BODY"));
    let before = excerpt.version.clone();
    c.execute("UPDATE dida_tasks SET last_seen_at=last_seen_at+100", [])
        .unwrap();
    assert_eq!(
        all.read(&excerpt.locator, 0, 20_000, None).unwrap().version,
        before
    );
    c.execute("UPDATE dida_tasks SET content='changed body'", [])
        .unwrap();
    assert!(all.verify(&excerpt).is_err());
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM task_activity", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    // The original UI producer still gets both source rows and can explicitly
    // capture history; extracting it did not remove that existing behavior.
    let ui_tasks = unified_task_read::load(&c, None).unwrap();
    task_dates::capture_source_history(&c, &ui_tasks).unwrap();
    assert!(
        c.query_row("SELECT COUNT(*) FROM task_activity", [], |r| r
            .get::<_, i64>(0))
            .unwrap()
            > 0
    );
}

#[test]
fn reading_uses_selected_identity_and_original_renderer_and_tracks_state_versions() {
    let f = Fixture::new();
    f.reading("selected", "转换验证 😀 原始正文");
    f.reading("unselected", "转换验证 SECRET");
    let reader = f.reader(&["notes"], &["selected"]);
    let found = reader
        .search(EvidenceKind::Reading, "转换验证", 10)
        .unwrap();
    assert_eq!(found.candidates.len(), 1);
    let excerpt = reader
        .read(&found.candidates[0].locator, 0, 20_000, None)
        .unwrap();
    let entry = x_bookmarks::evidence_entries(&f.c(), &["selected".into()], "", 1)
        .unwrap()
        .remove(0);
    assert_eq!(
        excerpt.content,
        x_bookmarks::storage::render_task_content(&entry.item)
    );
    assert!(!serde_json::to_string(&found).unwrap().contains("SECRET"));
    assert!(reader
        .read(
            &EvidenceLocator::Reading {
                item_key: "unselected".into()
            },
            0,
            100,
            None
        )
        .is_err());
    let without_reading = f.reader(&["notes"], &[]);
    assert!(without_reading
        .read(&excerpt.locator, 0, 100, None)
        .is_err());
    let mut c = f.c();
    x_bookmarks::properties::save_local(&mut c, "selected", "read", &["units".into()]).unwrap();
    assert!(reader.verify(&excerpt).is_err());
    let after = reader.read(&excerpt.locator, 0, 100, None).unwrap();
    assert_eq!(after.facts["status"], "read");
    c.execute(
        "INSERT INTO collection_lifecycle(item_key,state,revision) VALUES('selected','archived',1)",
        [],
    )
    .unwrap();
    assert!(reader.verify(&after).is_err());
    assert_eq!(
        reader.read(&after.locator, 0, 100, None).unwrap().facts["state"],
        "archived"
    );
    c.execute(
        "UPDATE collection_lifecycle SET state='deleted',revision=2 WHERE item_key='selected'",
        [],
    )
    .unwrap();
    assert!(reader.read(&after.locator, 0, 100, None).is_err());
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM collection_x_outbox", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn read_limits_do_not_duplicate_full_task_body_in_metadata_and_unknown_locators_are_rejected() {
    let f = Fixture::new();
    f.note("notes", "task", "- [ ] 一个必须核对的任务\n");
    let reader = f.reader(&["notes"], &[]);
    let found = reader.search(EvidenceKind::Task, "必须核对", 10).unwrap();
    let excerpt = reader
        .read(&found.candidates[0].locator, 0, 2, None)
        .unwrap();
    assert_eq!(excerpt.content.chars().count(), 2);
    assert!(excerpt.facts.get("sourceFacts").is_none());
    assert!(reader.read(&excerpt.locator, 0, 0, None).is_err());
    assert!(reader.read(&excerpt.locator, 0, 20_001, None).is_err());
    assert!(reader.read(&excerpt.locator, usize::MAX, 10, None).is_err());
    assert!(serde_json::from_value::<EvidenceLocator>(json!({"kind":"note","libraryId":"notes","documentId":"task","pageId":null,"sql":"SELECT *"})).is_err());
}

#[test]
fn empty_scope_and_unverifiable_attachment_do_not_become_implicit_library_access() {
    let f = Fixture::new();
    f.note("notes", "doc", "正文");
    let empty = f.reader(&[], &[]);
    assert_eq!(empty.catalog().unwrap()["libraries"], json!([]));
    assert!(empty
        .read(&note_locator("notes", "doc"), 0, 100, None)
        .is_err());
    assert!(EvidenceScope::new(vec![" ".into()], vec![]).is_err());
    let attachment = EvidenceLocator::Attachment {
        library_id: "notes".into(),
        document_id: "doc".into(),
        source_item_id: "pdf".into(),
        chunk_id: "pdf:p1:0".into(),
        page_number: Some(1),
    };
    assert!(f
        .reader(&["notes"], &[])
        .read(&attachment, 0, 100, None)
        .unwrap_err()
        .contains("授权"));
}

#[test]
fn project_metadata_is_scoped_before_rows_are_projected() {
    let f = Fixture::new();
    f.c().execute_batch("INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES('outside','craft','Outside',1,1);
        INSERT INTO documents(space_id,id,title,path,markdown,indexed_at,modified_at,content_hash,provider)
        VALUES('outside','doc','Outside project','Root','text',1,'invalid cached timestamp','hash','craft')").unwrap();
    // The out-of-scope cache row cannot even be deserialized as a project.
    // A post-query filter would fail before returning this empty result.
    assert!(load_craft_project_pages(&f.c()).is_err());
    assert!(f
        .reader(&["craft"], &[])
        .search(EvidenceKind::Task, "anything", 10)
        .unwrap()
        .candidates
        .is_empty());
}
