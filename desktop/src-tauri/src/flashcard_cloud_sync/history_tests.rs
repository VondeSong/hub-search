//! Production paging, structural authority and released-reader compatibility.
use crate::flashcard_authoring::import_flashcard_values;
use crate::flashcard_store::flashcard_by_id;
use crate::flashcard_study_settings::read_flashcard_study_settings;

use super::*;
use crate::flashcard_cloud_sync::tests::{server, store};

fn fixture(label: &str) -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../task-state/project-optimization-20261011/cloud-history-tests")
        .join(format!("{label}-{}", random_url_safe(8)));
    fs::create_dir_all(&root).unwrap();
    let db = root.join("craft-search.sqlite3");
    ensure_journal(&open_database(&db).unwrap()).unwrap();
    db
}
fn snapshot(db: &PathBuf) -> FlashcardSyncSnapshot {
    let c = open_database(db).unwrap();
    c.execute_batch("INSERT INTO flashcard_deck_folders(id,name,sort_order,created_at,updated_at) VALUES('remote-folder','同名文件夹',1,10,10);
        INSERT INTO flashcard_decks(id,name,folder_id,created_at,updated_at) VALUES('remote-deck','恢复','remote-folder',10,10);
        INSERT INTO flashcards(id,deck_id,question,answer,media_json,status,created_at,updated_at,due_at) VALUES('remote-card','remote-deck','问题','答案','[]','active',10,10,10);").unwrap();
    local_flashcard_snapshot(&c).unwrap()
}
async fn upload(
    remote: &OssStore,
    label: &str,
    snapshot: FlashcardSyncSnapshot,
) -> (String, Vec<u8>) {
    let bytes = serde_json::to_vec(&Change {
        format: "hub-flashcard-changes".into(),
        version: 4,
        checkpoint: true,
        snapshot,
    })
    .unwrap();
    let id = remote.key(&format!(
        "changes/{label}-{:x}.json",
        Sha256::digest(&bytes)
    ));
    remote.put_verified(&id, &bytes).await.unwrap();
    (id, bytes)
}
fn begin(db: &PathBuf, ns: &str) -> String {
    let mut c = open_database(db).unwrap();
    history::begin(&mut c, ns).unwrap().0
}
fn ready(db: &PathBuf, ns: &str, batch: &str, objects: &[(String, Vec<u8>)]) {
    let mut c = open_database(db).unwrap();
    let tx = c.transaction().unwrap();
    for (id, bytes) in objects {
        let incoming = decode(id, bytes).unwrap().snapshot;
        history::candidate(&tx, ns, batch, id, false).unwrap();
        stage(&tx, ns, id, bytes, MAX_STAGED).unwrap();
        history::absorb(&tx, ns, batch, &incoming).unwrap();
        tx.execute("UPDATE flashcard_cloud_recovery_candidates SET validated=1 WHERE namespace=?1 AND batch=?2 AND id=?3",params![ns,batch,id]).unwrap();
    }
    tx.execute("UPDATE flashcard_cloud_recovery_batches SET cache_bytes=(SELECT coalesce(sum(length(body)),0) FROM flashcard_cloud_recovery WHERE namespace=?1) WHERE namespace=?1 AND batch=?2",params![ns,batch]).unwrap();
    history::ready(&tx, ns, batch).unwrap();
    tx.commit().unwrap();
}
fn count(c: &Connection, table: &str) -> i64 {
    c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}
fn virtual_key(remote: &OssStore, index: usize) -> String {
    remote.key(&format!(
        "changes/virtual-{index:06}-{}.json",
        "a".repeat(64)
    ))
}
fn projection(c: &Connection) -> Value {
    let value = serde_json::to_value(local_flashcard_snapshot(c).unwrap()).unwrap();
    let mut result = serde_json::Map::new();
    for field in records::FIELDS {
        result.insert(field.into(), value[field].clone());
    }
    result.insert("studySettings".into(), value["studySettings"].clone());
    Value::Object(result)
}

#[tokio::test]
async fn history_provider_over_two_hundred_thousand_keys_freezes_sql_and_appends_valid_legacy_control(
) {
    let server = server().await;
    let remote = store(&server);
    server.state.lock().unwrap().virtual_list_count = Some(200_001);
    let db = fixture("provider-200001");
    let ns = "provider-200001";
    let batch = begin(&db, ns);
    {
        let c = open_database(&db).unwrap();
        c.execute_batch("CREATE TABLE control_capacity_probe(bytes INTEGER);
        CREATE TRIGGER control_capacity_insert AFTER INSERT ON flashcard_cloud_recovery_control BEGIN INSERT INTO control_capacity_probe VALUES(length(NEW.body)); END;").unwrap();
    }
    history::list(&remote, &db, ns, &batch).await.unwrap();
    let c = open_database(&db).unwrap();
    assert_eq!(count(&c, "flashcard_cloud_recovery_candidates"), 200_001);
    assert_eq!(history::state(&c, ns, &batch).unwrap(), "scanning");
    assert_eq!(server.state.lock().unwrap().list_pages, 201);
    let old = control(&c, ns).unwrap().unwrap();
    assert_eq!(old.keys.len(), 200_001);
    assert!(!old.complete);
    assert!(old.snapshot.is_none());
    let(logical,capacity,sum,grows):(i64,i64,i64,i64)=c.query_row("SELECT compat_len,(SELECT length(body) FROM flashcard_cloud_recovery_control WHERE namespace=?1),(SELECT sum(bytes) FROM control_capacity_probe),(SELECT count(*) FROM control_capacity_probe) FROM flashcard_cloud_recovery_batches WHERE namespace=?1",[ns],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
    assert!(capacity >= logical && capacity < logical * 2);
    assert!(
        grows < 20,
        "geometric growth, not a full rewrite per page: {grows}"
    );
    assert!(
        sum < capacity * 2,
        "geometric allocation sum: {sum}/{capacity}"
    );
    assert_eq!(count(&c, "flashcard_cloud_recovery_buffers"), 0);
    let before: Vec<u8> = c
        .query_row(
            "SELECT body FROM flashcard_cloud_recovery_control WHERE namespace=?1",
            [ns],
            |r| r.get(0),
        )
        .unwrap();
    c.execute_batch("VACUUM;").unwrap();
    let after: Vec<u8> = c
        .query_row(
            "SELECT body FROM flashcard_cloud_recovery_control WHERE namespace=?1",
            [ns],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(before, after);
    assert_eq!(control(&c, ns).unwrap().unwrap().keys.len(), 200_001);
}

#[tokio::test]
async fn history_listing_failure_keeps_every_acquired_key_visible_to_released_reader_and_resume() {
    let server = server().await;
    let remote = store(&server);
    {
        let mut s = server.state.lock().unwrap();
        s.virtual_list_count = Some(2001);
        s.fail_list_page = Some(2);
    }
    let db = fixture("listing-prefix");
    let ns = "listing-prefix";
    let batch = begin(&db, ns);
    assert!(history::list(&remote, &db, ns, &batch).await.is_err());
    {
        let c = open_database(&db).unwrap();
        assert_eq!(count(&c, "flashcard_cloud_recovery_candidates"), 1000);
        assert_eq!(control(&c, ns).unwrap().unwrap().keys.len(), 1000);
        assert!(!control(&c, ns).unwrap().unwrap().complete);
        assert_eq!(count(&c, "flashcard_cloud_applied"), 0);
    }
    {
        let mut s = server.state.lock().unwrap();
        s.fail_list_page = None;
        s.virtual_list_count = Some(500);
    }
    forget_initialized_database(&db);
    assert_eq!(begin(&db, ns), batch);
    history::list(&remote, &db, ns, &batch).await.unwrap();
    let c = open_database(&db).unwrap();
    assert_eq!(count(&c, "flashcard_cloud_recovery_candidates"), 1000);
    assert!(control(&c, ns)
        .unwrap()
        .unwrap()
        .keys
        .contains(&virtual_key(&remote, 900)));
    assert!(run(
        &remote,
        &db,
        ns,
        &batch,
        &mut CloudReport::default(),
        MAX_STAGED
    )
    .await
    .unwrap_err()
    .contains("变更已消失"));
    assert_eq!(count(&c, "flashcards"), 0);
    assert_eq!(count(&c, "flashcard_cloud_applied"), 0);
}

#[tokio::test]
async fn history_repeated_provider_token_stops_with_the_valid_acquired_manifest() {
    let server = server().await;
    let remote = store(&server);
    {
        let mut s = server.state.lock().unwrap();
        s.virtual_list_count = Some(3000);
        s.repeat_list_token = true;
    }
    let db = fixture("token-repeat");
    let ns = "token-repeat";
    let batch = begin(&db, ns);
    assert!(history::list(&remote, &db, ns, &batch)
        .await
        .unwrap_err()
        .contains("游标重复"));
    let c = open_database(&db).unwrap();
    assert_eq!(count(&c, "flashcard_cloud_recovery_candidates"), 1000);
    assert_eq!(control(&c, ns).unwrap().unwrap().keys.len(), 1000);
    assert_eq!(count(&c, "flashcard_cloud_recovery_tokens"), 1);
    assert_eq!(history::state(&c, ns, &batch).unwrap(), "listing");
}

#[tokio::test]
async fn history_large_applied_log_uses_indexed_membership_and_only_freezes_the_unapplied_tail() {
    let server = server().await;
    let remote = store(&server);
    server.state.lock().unwrap().virtual_list_count = Some(200_001);
    let db = fixture("applied-membership");
    let ns = "applied-membership";
    {
        let mut c = open_database(&db).unwrap();
        let tx = c.transaction().unwrap();
        {
            let mut insert = tx
                .prepare("INSERT INTO flashcard_cloud_applied(namespace,id) VALUES(?1,?2)")
                .unwrap();
            for n in 0..200_000 {
                insert
                    .execute(params![ns, virtual_key(&remote, n)])
                    .unwrap();
            }
        }
        tx.commit().unwrap();
    }
    let batch = begin(&db, ns);
    history::list(&remote, &db, ns, &batch).await.unwrap();
    let c = open_database(&db).unwrap();
    assert_eq!(count(&c, "flashcard_cloud_recovery_candidates"), 1);
    assert_eq!(
        history::next(&c, ns, &batch, true, false).unwrap(),
        Some(virtual_key(&remote, 200_000))
    );
    let plan: Vec<String> = {
        let mut q=c.prepare("EXPLAIN QUERY PLAN SELECT r.id FROM flashcard_cloud_recovery_candidates r WHERE r.namespace=?1 AND r.batch=?2 AND NOT EXISTS(SELECT 1 FROM flashcard_cloud_applied a WHERE a.namespace=r.namespace AND a.id=r.id) ORDER BY r.id LIMIT 1").unwrap();
        let rows = q.query_map(params![ns, batch], |r| r.get(3)).unwrap();
        rows.collect::<Result<_, _>>().unwrap()
    };
    assert!(
        plan.iter()
            .any(|p| p.contains("SEARCH a") && p.contains("namespace=? AND id=?")),
        "{plan:?}"
    );
    assert!(run(
        &remote,
        &db,
        ns,
        &batch,
        &mut CloudReport::default(),
        MAX_STAGED
    )
    .await
    .is_err());
    assert_eq!(server.state.lock().unwrap().gets.len(), 1);
    assert_eq!(count(&c, "flashcard_cloud_applied"), 200_000);
}

#[tokio::test]
async fn history_legal_individual_snapshots_recover_structural_union_above_the_old_synthetic_limit()
{
    let server = server().await;
    let remote = store(&server);
    let source = fixture("union-source");
    let base = snapshot(&source);
    for n in 0..2 {
        let mut next = base.clone();
        next.cards[0].id = format!("union-card-{n}");
        next.folders = (0..6000)
            .map(|i| FlashcardSnapshotFolder {
                id: format!("folder-{n}-{i:05}"),
                name: format!("文件夹 {n}-{i}"),
                sort_order: i,
                created_at: 10,
                updated_at: 10,
            })
            .collect();
        next.decks[0].folder_id = next.folders[0].id.clone();
        upload(&remote, &format!("union-{n}"), next).await;
    }
    let target = fixture("union-target");
    recover_from_store(&remote, &target, "union", &mut CloudReport::default())
        .await
        .unwrap();
    let c = open_database(&target).unwrap();
    assert_eq!(count(&c, "flashcard_deck_folders"), 12_000);
    assert_eq!(count(&c, "flashcards"), 2);
    assert_eq!(count(&c, "flashcard_cloud_applied"), 2);
    assert_eq!(count(&c, "flashcard_cloud_recovery_batches"), 0);
}

#[tokio::test]
async fn history_typed_byte_winners_and_quality_remap_match_the_reference_merger() {
    let server = server().await;
    let remote = store(&server);
    let source = fixture("tie-source");
    let mut a = snapshot(&source);
    a.folders[0].name = "a".into();
    a.folders[0].created_at = 999;
    a.decks[0].name = "a".into();
    a.decks[0].created_at = 999;
    a.study_settings = Some(FlashcardStudySettings {
        daily_new_limit: 5,
        updated_at: 10,
    });
    let mut b = a.clone();
    b.folders[0].name = "z".into();
    b.folders[0].created_at = 1;
    b.decks[0].name = "z".into();
    b.decks[0].created_at = 1;
    b.cards[0].id = "second-card".into();
    b.study_settings = Some(FlashcardStudySettings {
        daily_new_limit: 50,
        updated_at: 10,
    });
    b.quality_records = vec![
        json!({"id":"history-rule","kind":"rule","text":"保留事实","scopeType":"deck","scopeValue":"remote-deck","updatedAt":10}),
    ];
    let objects = vec![
        upload(&remote, "a-tie", a.clone()).await,
        upload(&remote, "b-tie", b.clone()).await,
    ];
    let db = fixture("tie-target");
    let reference = fixture("tie-reference");
    let ns = "tie";
    let batch = begin(&db, ns);
    ready(&db, ns, &batch, &objects);
    let context = control(&open_database(&db).unwrap(), ns)
        .unwrap()
        .unwrap()
        .snapshot
        .unwrap();
    let mut expected = a.clone();
    expected.cards.clear();
    expected.reviews.clear();
    expected.drafts.clear();
    expected.quality_records.clear();
    expected.folders.extend(b.folders.clone());
    expected.decks.extend(b.decks.clone());
    compact(&mut expected).unwrap();
    assert_eq!(
        serde_json::to_vec(&context.folders).unwrap(),
        serde_json::to_vec(&expected.folders).unwrap()
    );
    assert_eq!(context.study_settings.unwrap().daily_new_limit, 50);
    for (id, bytes) in &objects {
        apply_one(&db, ns, &batch, id).unwrap();
        let mut incoming = decode(id, bytes).unwrap().snapshot;
        incoming.folders = context.folders.clone();
        incoming.decks = context.decks.clone();
        incoming.tombstones = context.tombstones.clone();
        incoming.scheduler_profiles = context.scheduler_profiles.clone();
        incoming.study_settings = Some(FlashcardStudySettings {
            daily_new_limit: 50,
            updated_at: 10,
        });
        let mut c = open_database(&reference).unwrap();
        merge_flashcard_snapshot(&mut c, &incoming).unwrap();
    }
    assert_eq!(
        projection(&open_database(&db).unwrap()),
        projection(&open_database(&reference).unwrap())
    );
}

#[tokio::test]
async fn history_alias_refreshes_after_local_rename_and_skips_unchanged_global_bodies() {
    use rusqlite::functions::FunctionFlags;
    let server = server().await;
    let remote = store(&server);
    let source = fixture("alias-source");
    let a = snapshot(&source);
    let mut b = a.clone();
    b.cards[0].id = "second-alias-card".into();
    let objects = vec![
        upload(&remote, "a-alias", a.clone()).await,
        upload(&remote, "b-alias", b.clone()).await,
    ];
    let target = fixture("alias-target");
    let reference = fixture("alias-reference");
    for db in [&target, &reference] {
        open_database(db).unwrap().execute_batch("INSERT INTO flashcard_deck_folders(id,name,sort_order,created_at,updated_at) VALUES('local-folder','同名文件夹',1,10,10);INSERT INTO flashcard_decks(id,name,folder_id,created_at,updated_at) VALUES('local-deck','恢复','local-folder',10,10);").unwrap();
    }
    let ns = "alias";
    let batch = begin(&target, ns);
    ready(&target, ns, &batch, &objects);
    apply_one(&target, ns, &batch, &objects[0].0).unwrap();
    {
        let mut c = open_database(&reference).unwrap();
        merge_flashcard_snapshot(&mut c, &a).unwrap();
    }
    assert_eq!(
        flashcard_by_id(&open_database(&target).unwrap(), "remote-card")
            .unwrap()
            .deck_id,
        "local-deck"
    );
    // Probe the actual production context and card-only mapper on its connection.
    {
        let mut c = open_database(&target).unwrap();
        let seen = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed = seen.clone();
        c.create_scalar_function(
            "history_folder_read",
            1,
            FunctionFlags::SQLITE_UTF8,
            move |ctx| {
                observed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                ctx.get::<String>(0)
            },
        )
        .unwrap();
        c.execute_batch("CREATE TEMP VIEW flashcard_deck_folders AS SELECT id,history_folder_read(name) AS name,sort_order,created_at,updated_at FROM main.flashcard_deck_folders;").unwrap();
        let tx = c.transaction().unwrap();
        let context = crate::flashcard_snapshot::history::Context::new(ns, &batch);
        crate::flashcard_snapshot::merge_recovery_snapshot(&tx, &a, &context).unwrap();
        tx.rollback().unwrap();
        assert_eq!(seen.load(std::sync::atomic::Ordering::SeqCst), 0);
        merge_flashcard_snapshot(&mut c, &a).unwrap();
        assert!(
            seen.load(std::sync::atomic::Ordering::SeqCst) > 0,
            "positive reference probe"
        );
    }
    for db in [&target, &reference] {
        open_database(db)
            .unwrap()
            .execute(
                "UPDATE flashcard_decks SET name='本地改名',updated_at=20 WHERE id='local-deck'",
                [],
            )
            .unwrap();
    }
    apply_one(&target, ns, &batch, &objects[1].0).unwrap();
    {
        let mut c = open_database(&reference).unwrap();
        merge_flashcard_snapshot(&mut c, &b).unwrap();
    }
    assert_eq!(
        flashcard_by_id(&open_database(&target).unwrap(), "second-alias-card")
            .unwrap()
            .deck_id,
        "remote-deck"
    );
    assert_eq!(
        projection(&open_database(&target).unwrap()),
        projection(&open_database(&reference).unwrap())
    );
}

#[tokio::test]
async fn history_first_domain_failure_rolls_back_structure_draft_profile_alias_and_cursor_together()
{
    let server = server().await;
    let remote = store(&server);
    let source = fixture("atomic-source");
    import_flashcard_values(
        &source,
        "manual",
        "恢复".into(),
        json!({"source":"manual"}),
        vec![json!({"question":"保留收件箱事务","answer":"完整回滚"})],
        true,
    )
    .unwrap();
    let mut incoming = snapshot(&source);
    let mut profile = flashcard_profiles::default_profile();
    profile.desired_retention = 0.85;
    profile.id = profile.content_id().unwrap();
    incoming.scheduler_profiles.push(profile.clone());
    incoming.study_settings = Some(FlashcardStudySettings {
        daily_new_limit: 20,
        updated_at: 30,
    });
    let object = upload(&remote, "atomic", incoming).await;
    let db = fixture("atomic-target");
    let ns = "atomic";
    let batch = begin(&db, ns);
    ready(&db, ns, &batch, &[object.clone()]);
    {
        open_database(&db).unwrap().execute_batch("CREATE TRIGGER reject_history_card BEFORE INSERT ON flashcards BEGIN SELECT RAISE(ABORT,'injected first domain failure'); END;").unwrap();
    }
    assert!(apply_one(&db, ns, &batch, &object.0).is_err());
    let c = open_database(&db).unwrap();
    for table in [
        "flashcards",
        "flashcard_decks",
        "flashcard_deck_folders",
        "flashcard_drafts",
        "flashcard_import_batches",
        "flashcard_cloud_applied",
        "flashcard_cloud_recovery_aliases",
    ] {
        assert_eq!(count(&c, table), 0, "{table}");
    }
    assert_eq!(count(&c, "flashcard_scheduler_profiles"), 1);
    assert_eq!(read_flashcard_study_settings(&c).updated_at, 0);
    assert_eq!(
        c.query_row(
            "SELECT structural_revision FROM flashcard_cloud_recovery_batches WHERE namespace=?1",
            [ns],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        -1
    );
    assert_eq!(body(&c, ns, &object.0).unwrap(), object.1);
    c.execute_batch("DROP TRIGGER reject_history_card;")
        .unwrap();
    drop(c);
    forget_initialized_database(&db);
    recover_from_store(&remote, &db, ns, &mut CloudReport::default())
        .await
        .unwrap();
    let c = open_database(&db).unwrap();
    assert_eq!(count(&c, "flashcard_drafts"), 1);
    assert_eq!(count(&c, "flashcard_scheduler_profiles"), 2);
    assert_eq!(count(&c, "flashcards"), 1);
    assert_eq!(count(&c, "flashcard_cloud_applied"), 1);
    assert_eq!(count(&c, "flashcard_cloud_recovery_batches"), 0);
}

#[tokio::test]
async fn history_released_control_completion_only_authorizes_its_exact_keys_and_corruption_rolls_back_import(
) {
    let server = server().await;
    let remote = store(&server);
    let source = fixture("old-control-source");
    let snapshot = snapshot(&source);
    let first = upload(&remote, "a-old", snapshot.clone()).await;
    let second = upload(&remote, "b-old", snapshot.clone()).await;
    let db = fixture("old-control-target");
    let ns = "old-control";
    let batch = begin(&db, ns);
    {
        let c = open_database(&db).unwrap();
        history::candidate(&c, ns, &batch, &first.0, false).unwrap();
        history::candidate(&c, ns, &batch, &second.0, false).unwrap();
        stage(&c, ns, &first.0, &first.1, MAX_STAGED).unwrap();
        let raw = serde_json::to_vec(&Control {
            format: "hub-flashcard-recovery-control".into(),
            version: 2,
            snapshot: Some(structural(snapshot)),
            keys: vec![first.0.clone()],
            complete: true,
        })
        .unwrap();
        c.execute(
            "UPDATE flashcard_cloud_recovery_control SET body=?2 WHERE namespace=?1",
            params![ns, raw],
        )
        .unwrap();
    }
    assert_eq!(begin(&db, ns), batch);
    let mut c = open_database(&db).unwrap();
    assert!(c.query_row("SELECT validated=1 FROM flashcard_cloud_recovery_candidates WHERE namespace=?1 AND batch=?2 AND id=?3",params![ns,batch,first.0],|r|r.get::<_,bool>(0)).unwrap());
    assert!(!c.query_row("SELECT validated=1 FROM flashcard_cloud_recovery_candidates WHERE namespace=?1 AND batch=?2 AND id=?3",params![ns,batch,second.0],|r|r.get::<_,bool>(0)).unwrap());
    assert_eq!(history::state(&c, ns, &batch).unwrap(), "listing");
    assert!(apply_one(&db, ns, &batch, &first.0).is_err());
    assert_eq!(count(&c, "flashcards"), 0);
    let structures = count(&c, "flashcard_cloud_recovery_structures");
    c.execute(
        "UPDATE flashcard_cloud_recovery_control SET body=?2 WHERE namespace=?1",
        params![ns, b"{bad".as_slice()],
    )
    .unwrap();
    assert!(history::begin(&mut c, ns).is_err());
    assert_eq!(count(&c, "flashcard_cloud_recovery_structures"), structures);
    assert_eq!(body(&c, ns, &first.0).unwrap(), first.1);
    assert_eq!(
        c.query_row(
            "SELECT body FROM flashcard_cloud_recovery_control WHERE namespace=?1",
            [ns],
            |r| r.get::<_, Vec<u8>>(0)
        )
        .unwrap(),
        b"{bad"
    );
}

#[tokio::test]
async fn history_invalid_individual_structural_quantity_never_grants_partial_import_authority() {
    let server = server().await;
    let remote = store(&server);
    let source = fixture("invalid-count-source");
    let a = snapshot(&source);
    let mut b = a.clone();
    b.folders = (0..10001)
        .map(|i| FlashcardSnapshotFolder {
            id: format!("invalid-folder-{i}"),
            name: format!("无效 {i}"),
            sort_order: i,
            created_at: 10,
            updated_at: 10,
        })
        .collect();
    upload(&remote, "a-valid", a).await;
    upload(&remote, "b-invalid", b).await;
    let db = fixture("invalid-count-target");
    let ns = "invalid-count";
    assert!(
        recover_from_store(&remote, &db, ns, &mut CloudReport::default())
            .await
            .unwrap_err()
            .contains("安全数量限制")
    );
    let c = open_database(&db).unwrap();
    assert_eq!(count(&c, "flashcards"), 0);
    assert_eq!(count(&c, "flashcard_deck_folders"), 0);
    assert_eq!(count(&c, "flashcard_cloud_applied"), 0);
    assert_eq!(count(&c, "flashcard_cloud_recovery_candidates"), 2);
    assert!(!control(&c, ns).unwrap().unwrap().complete);
    assert_eq!(count(&c, "flashcard_cloud_recovery"), 1);
}

#[test]
fn history_streams_released_bare_v1_v2_formats_without_extending_their_authority() {
    let source = fixture("legacy-shapes-source");
    let incoming = structural(snapshot(&source));
    for (label, version, complete) in [
        ("bare", 0, false),
        ("v1", 1, false),
        ("v2-incomplete", 2, false),
        ("v2-complete", 2, true),
    ] {
        let db = fixture(&format!("legacy-{label}"));
        let mut c = open_database(&db).unwrap();
        let raw = if version == 0 {
            serde_json::to_vec(&incoming).unwrap()
        } else {
            serde_json::to_vec(&Control {
                format: "hub-flashcard-recovery-control".into(),
                version,
                snapshot: Some(incoming.clone()),
                keys: vec!["first-legacy-key".into(), "second-legacy-key".into()],
                complete,
            })
            .unwrap()
        };
        c.execute(
            "INSERT INTO flashcard_cloud_recovery_control(namespace,body) VALUES(?1,?2)",
            params![label, raw],
        )
        .unwrap();
        let (batch, existed) = history::begin(&mut c, label).unwrap();
        assert!(!existed);
        assert_eq!(
            count(&c, "flashcard_cloud_recovery_structures"),
            3,
            "{label}"
        );
        assert_eq!(count(&c, "flashcards"), 0);
        assert_eq!(history::state(&c, label, &batch).unwrap(), "listing");
        let authorized:i64=c.query_row("SELECT count(*) FROM flashcard_cloud_recovery_candidates WHERE namespace=?1 AND validated=1",[label],|r|r.get(0)).unwrap();
        assert_eq!(
            authorized,
            if version == 1 || complete { 2 } else { 0 },
            "{label}"
        );
        let old = control(&c, label).unwrap().unwrap();
        assert!(!old.complete);
        assert_eq!(old.keys.len(), if version == 0 { 0 } else { 2 });
        assert_eq!(
            serde_json::to_vec(&old.snapshot.unwrap().folders).unwrap(),
            serde_json::to_vec(&incoming.folders).unwrap()
        );
        assert_eq!(count(&c, "flashcard_cloud_recovery_legacy_keys"), 0);
    }
}

#[test]
fn history_legacy_shape_selection_matches_released_reader_before_nested_semantics() {
    let source = fixture("legacy-unknown-source");
    let incoming = structural(snapshot(&source));
    let mut nested = incoming.clone();
    nested.scheduler_profiles[0].desired_retention = 2.0;
    for (label, both_shape, malformed_nested, accept) in [
        ("bare-unknown", false, false, true),
        ("both-semantic", true, false, false),
        ("both-shape", true, true, true),
    ] {
        let db = fixture(label);
        let mut c = open_database(&db).unwrap();
        let mut value = serde_json::to_value(&incoming).unwrap();
        let mut child = serde_json::to_value(&nested).unwrap();
        if malformed_nested {
            child["folders"] = json!([1]);
        }
        value["snapshot"] = child;
        if both_shape {
            value["format"] = json!("hub-flashcard-recovery-control");
            value["keys"] = json!(["legacy-key"]);
            value["complete"] = json!(true);
        }
        let raw = serde_json::to_vec(&value).unwrap();
        c.execute(
            "INSERT INTO flashcard_cloud_recovery_control(namespace,body) VALUES(?1,?2)",
            params![label, raw],
        )
        .unwrap();
        assert_eq!(
            control(&c, label).is_ok(),
            accept,
            "released shape selection {label}"
        );
        let result = history::begin(&mut c, label);
        assert_eq!(result.is_ok(), accept, "streamed shape selection {label}");
        if accept {
            assert_eq!(count(&c, "flashcard_cloud_recovery_structures"), 3);
            assert_eq!(count(&c, "flashcard_cloud_recovery_candidates"), 0);
        } else {
            assert_eq!(count(&c, "flashcard_cloud_recovery_batches"), 0);
            assert_eq!(
                c.query_row(
                    "SELECT body FROM flashcard_cloud_recovery_control WHERE namespace=?1",
                    [label],
                    |r| r.get::<_, Vec<u8>>(0)
                )
                .unwrap(),
                raw
            );
        }
        assert_eq!(count(&c, "flashcards"), 0);
    }
}

#[test]
fn history_streams_legal_legacy_control_above_transport_size_and_preserves_malformed_tail() {
    let source = fixture("legacy-large-source");
    let incoming = structural(snapshot(&source));
    // Released local control has no transport-object size restriction. Produce
    // its long manifest in the fixture only; the formal migration reads a BLOB.
    let mut raw = Vec::new();
    raw.extend_from_slice(
        b"{\"format\":\"hub-flashcard-recovery-control\",\"version\":2,\"snapshot\":",
    );
    serde_json::to_writer(&mut raw, &incoming).unwrap();
    raw.extend_from_slice(b",\"keys\":[");
    let suffix = "x".repeat(510);
    for i in 0..70_000 {
        if i != 0 {
            raw.push(b',');
        }
        serde_json::to_writer(&mut raw, &format!("changes/{i:06}-{suffix}.json")).unwrap();
    }
    raw.extend_from_slice(b"],\"complete\":true}");
    assert!(raw.len() > FLASHCARD_SYNC_MAX_SNAPSHOT_BYTES);
    let bad = fixture("legacy-large-bad");
    let mut c = open_database(&bad).unwrap();
    let truncated = &raw[..raw.len() - 1];
    c.execute(
        "INSERT INTO flashcard_cloud_recovery_control(namespace,body) VALUES('bad',?1)",
        [truncated],
    )
    .unwrap();
    assert!(history::begin(&mut c, "bad").is_err());
    for table in [
        "flashcard_cloud_recovery_batches",
        "flashcard_cloud_recovery_candidates",
        "flashcard_cloud_recovery_structures",
    ] {
        assert_eq!(count(&c, table), 0, "{table}");
    }
    assert_eq!(
        c.query_row(
            "SELECT body FROM flashcard_cloud_recovery_control WHERE namespace='bad'",
            [],
            |r| r.get::<_, Vec<u8>>(0)
        )
        .unwrap(),
        truncated
    );
    let good = fixture("legacy-large-good");
    let mut c = open_database(&good).unwrap();
    c.execute(
        "INSERT INTO flashcard_cloud_recovery_control(namespace,body) VALUES('good',?1)",
        [raw.as_slice()],
    )
    .unwrap();
    let (batch, _) = history::begin(&mut c, "good").unwrap();
    assert_eq!(count(&c, "flashcard_cloud_recovery_candidates"), 70_000);
    assert!(history::next(&c, "good", &batch, true, false)
        .unwrap()
        .is_none());
    assert_eq!(control(&c, "good").unwrap().unwrap().keys.len(), 70_000);
    assert_eq!(count(&c, "flashcards"), 0);
    assert_eq!(count(&c, "flashcard_cloud_applied"), 0);
}

#[tokio::test]
async fn history_body_side_effect_invalidates_the_next_objects_structural_aliases() {
    let server = server().await;
    let remote = store(&server);
    let source = fixture("side-effect-source");
    let a = snapshot(&source);
    let mut b = a.clone();
    b.cards[0].id = "second-side-effect-card".into();
    let objects = vec![
        upload(&remote, "a-side-effect", a.clone()).await,
        upload(&remote, "b-side-effect", b.clone()).await,
    ];
    let target = fixture("side-effect-target");
    let reference = fixture("side-effect-reference");
    for db in [&target, &reference] {
        open_database(db).unwrap().execute_batch("INSERT INTO flashcard_deck_folders(id,name,sort_order,created_at,updated_at) VALUES('local-folder','同名文件夹',1,10,10);INSERT INTO flashcard_decks(id,name,folder_id,created_at,updated_at) VALUES('local-deck','恢复','local-folder',10,10);
        CREATE TRIGGER rename_side_effect AFTER INSERT ON flashcards WHEN NEW.id='remote-card' BEGIN UPDATE flashcard_decks SET name='触发器改名',updated_at=20 WHERE id='local-deck'; END;").unwrap();
    }
    let ns = "side-effect";
    let batch = begin(&target, ns);
    ready(&target, ns, &batch, &objects);
    for ((id, _), incoming) in objects.iter().zip([&a, &b]) {
        apply_one(&target, ns, &batch, id).unwrap();
        let mut c = open_database(&reference).unwrap();
        merge_flashcard_snapshot(&mut c, incoming).unwrap();
    }
    assert_eq!(
        flashcard_by_id(&open_database(&target).unwrap(), "second-side-effect-card")
            .unwrap()
            .deck_id,
        "remote-deck"
    );
    assert_eq!(
        projection(&open_database(&target).unwrap()),
        projection(&open_database(&reference).unwrap())
    );
}
