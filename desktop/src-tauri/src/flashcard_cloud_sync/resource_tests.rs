//! Real SQL producers and immutable transport exercise the resource boundaries.
use super::*;
use crate::flashcard_authoring::{import_flashcard_values, resolve_flashcard_drafts_in_connection};
use crate::flashcard_store::flashcard_by_id;
use crate::flashcard_store::FLASHCARD_DRAFT_SELECT_FIELDS;
use rusqlite::hooks::{AuthAction, AuthContext, Authorization};

fn resource_device(label: &str) -> (PathBuf, BlobStore) {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../task-state/project-optimization-20261011/cloud-resource-tests")
        .join(format!("{label}-{}", random_url_safe(8)));
    fs::create_dir_all(&root).unwrap();
    (
        root.join("craft-search.sqlite3"),
        BlobStore::open(&root.join("blobs-v1")).unwrap(),
    )
}

fn populated(label: &str) -> (PathBuf, BlobStore, String) {
    let (db, blobs) = resource_device(label);
    import_flashcard_values(&db,"manual","资源合同".into(),json!({"source":"manual"}),vec![
        json!({"question":"资源读取边界？","answer":"逐记录","explanation":"保留全部内容","tags":["资源"],"evidence":"合成测试"}),
        json!({"question":"保留收件箱？","answer":"保留"}),
    ],true).unwrap();
    let mut c = open_database(&db).unwrap();
    let snapshot = local_flashcard_snapshot(&c).unwrap();
    let draft = flashcard_sync_drafts::identity(&snapshot.drafts[0]).to_string();
    let deck = ensure_flashcard_deck(&c, "资源合同").unwrap();
    resolve_flashcard_drafts_in_connection(&mut c, vec![draft], true, Some(deck)).unwrap();
    let card = local_flashcard_snapshot(&c).unwrap().cards[0].id.clone();
    c.execute("INSERT INTO flashcard_deck_folders(id,name,sort_order,created_at,updated_at) VALUES('resource-folder','资源文件夹',2,10,10)",[]).unwrap();
    record_flashcard_tombstone(&c, "card", "resource-removed", 20).unwrap();
    flashcard_quality::merge(&c,&[json!({"id":"resource-feedback","kind":"feedback","updatedAt":30,"comment":"正式质量 producer","snapshot":{"media":[]},"before":{"media":[]}})]).unwrap();
    let preview =
        serde_json::to_value(flashcard_scheduler::preview(&c, &card, 1000).unwrap()).unwrap();
    flashcard_scheduler::commit(
        &c,
        &card,
        3,
        Some(1000),
        preview["reviewKey"].as_str().unwrap(),
        1000,
    )
    .unwrap();
    drop(c);
    (db, blobs, card)
}

fn next(c: &Connection, ns: &str) -> (String, Vec<u8>) {
    c.query_row("SELECT id,body FROM flashcard_cloud_uploads WHERE namespace=?1 AND status='pending' ORDER BY local_seq LIMIT 1",[ns],|r|Ok((r.get(0)?,r.get(1)?))).unwrap()
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum PreservedCell {
    Null,
    Integer(i64),
    Real(u64),
    Text(Vec<u8>),
    Blob(Vec<u8>),
}

// Compare each SQLite value directly, including non-UTF8 TEXT and duplicate
// rows. The assertion is independent of the maintenance owner's digest code.
fn preserved_database(
    c: &Connection,
) -> std::collections::BTreeMap<String, Vec<Vec<PreservedCell>>> {
    let mut names = c
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .unwrap();
    let names = names
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let mut result = std::collections::BTreeMap::new();
    let objects = "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name";
    for (name, sql) in std::iter::once(("@schema".to_string(), objects.to_string())).chain(
        names.into_iter().map(|name| {
            let sql = format!("SELECT * FROM \"{}\"", name.replace('"', "\"\""));
            (name, sql)
        }),
    ) {
        let mut q = c.prepare(&sql).unwrap();
        let width = q.column_count();
        let mut rows = q.query([]).unwrap();
        let mut values = Vec::new();
        while let Some(row) = rows.next().unwrap() {
            let cells = (0..width)
                .map(|index| match row.get_ref(index).unwrap() {
                    rusqlite::types::ValueRef::Null => PreservedCell::Null,
                    rusqlite::types::ValueRef::Integer(v) => PreservedCell::Integer(v),
                    rusqlite::types::ValueRef::Real(v) => PreservedCell::Real(v.to_bits()),
                    rusqlite::types::ValueRef::Text(v) => PreservedCell::Text(v.to_vec()),
                    rusqlite::types::ValueRef::Blob(v) => PreservedCell::Blob(v.to_vec()),
                })
                .collect::<Vec<_>>();
            values.push(cells);
        }
        values.sort();
        result.insert(name, values);
    }
    result
}

#[tokio::test]
async fn resource_physical_compaction_preserves_partial_cloud_owners_without_granting_authority() {
    use crate::reading_sync::object_store::Configuration;
    use std::sync::atomic::AtomicBool;
    let source_server = server().await;
    let source = store(&source_server);
    let target_server = server().await;
    let mut target_config = config();
    target_config.prefix = "PhysicalTarget".into();
    let target = OssStore::new(target_config.clone(), "synthetic-test-secret".into())
        .unwrap()
        .with_test_endpoint(target_server.url.clone());
    let (db, blobs, card) = populated("physical-partial");
    let ns = config().namespace();
    let original_media = blobs
        .put(b"\x89PNG\r\n\x1a\nphysical-original")
        .unwrap()
        .hash;
    {
        let c = open_database(&db).unwrap();
        meta(&c, "cloud_sync_enabled", "1").unwrap();
        c.execute("UPDATE flashcards SET media_json=?1 WHERE id=?2", params![json!([{"url":format!("http://craft-media.localhost/{original_media}"),"mimeType":"image/png"}]).to_string(), card]).unwrap();
    }
    // Formal successful producers establish actual old baselines and receipts.
    sync_database(&source, &db, &blobs, &ns, false, false)
        .await
        .unwrap();
    let new_media = blobs
        .put(b"\x89PNG\r\n\x1a\nphysical-unconfirmed")
        .unwrap()
        .hash;
    {
        let c = open_database(&db).unwrap();
        c.execute("UPDATE flashcards SET media_json=?1,explanation='物理整理期间必须保留' WHERE id=?2", params![json!([{"url":format!("http://craft-media.localhost/{new_media}"),"mimeType":"image/png"}]).to_string(), card]).unwrap();
    }
    source_server.state.lock().unwrap().deny_media = true;
    assert!(sync_database(&source, &db, &blobs, &ns, false, false)
        .await
        .is_err());
    source_server.state.lock().unwrap().deny_media = false;
    {
        let c = open_database(&db).unwrap();
        c.execute(
            "UPDATE flashcards SET explanation='新的冻结正文也必须保留' WHERE id=?1",
            [&card],
        )
        .unwrap();
        stage(&c, &ns, false).unwrap();
    }
    target_server.state.lock().unwrap().deny_put = true;
    assert!(migration::copy(
        &db,
        &source,
        &target,
        &Configuration::Oss { config: config() },
        &Configuration::Oss {
            config: target_config
        },
        true
    )
    .await
    .is_err());

    // A real failed second provider page retains an incomplete epoch. It cannot
    // become maintenance/copy authority merely because its file was compacted.
    let listing_server = server().await;
    listing_server.state.lock().unwrap().virtual_list_count = Some(1001);
    listing_server.state.lock().unwrap().fail_list_page = Some(2);
    let listing_remote = store(&listing_server);
    assert!(crate::cloud_inventory::acquire(
        &db,
        &listing_remote,
        &ns,
        "physical-partial",
        "reading/v1/changes/"
    )
    .await
    .is_err());
    let mut c = open_database(&db).unwrap();
    let (batch, _) = history::begin(&mut c, &ns).unwrap();
    let unconfirmed = "f".repeat(64);
    assert!(history::candidate(&c, &ns, &batch, &unconfirmed, false).unwrap());
    let (maintenance_listing, maintenance_key) =
        crate::cloud_maintenance::tests::seed_physical_partial(&c, &ns);
    let epoch: String = c.query_row("SELECT epoch FROM cloud_inventory_runs WHERE namespace=?1 AND scope='physical-partial' AND state='listing'", [&ns], |r| r.get(0)).unwrap();
    let assert_partial = |c: &Connection| {
        assert!(
            crate::cloud_inventory::load(c, &ns, "physical-partial", &epoch)
                .unwrap()
                .ensure_complete(c)
                .is_err()
        );
        assert_eq!(
            c.query_row(
                "SELECT count(*) FROM cloud_inventory_objects WHERE namespace=?1 AND epoch=?2",
                params![ns, epoch],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1000
        );
        assert_eq!(c.query_row("SELECT state='listing' AND structure_complete=0 FROM flashcard_cloud_recovery_batches WHERE namespace=?1 AND batch=?2", params![ns,batch], |r| r.get::<_, bool>(0)).unwrap(), true);
        assert_eq!(c.query_row("SELECT validated FROM flashcard_cloud_recovery_candidates WHERE namespace=?1 AND batch=?2 AND id=?3", params![ns,batch,unconfirmed], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(
            c.query_row(
                "SELECT count(*) FROM flashcard_cloud_media_queue WHERE namespace=?1 AND hash=?2",
                params![ns, new_media],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(c.query_row("SELECT count(*) FROM flashcard_cloud_media_candidates WHERE namespace=?1 AND hash=?2 AND state='pending'", params![ns,new_media], |r| r.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(c.query_row("SELECT count(*) FROM flashcard_cloud_media_receipts WHERE namespace=?1 AND hash=?2", params![ns,new_media], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(c.query_row("SELECT count(*) FROM flashcard_cloud_media_receipts WHERE namespace=?1 AND hash=?2", params![ns,original_media], |r| r.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(
            c.query_row(
                "SELECT count(*) FROM cloud_migration_runs WHERE state='partial'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert!(
            c.query_row("SELECT count(*) FROM cloud_migration_payloads", [], |r| r
                .get::<_, i64>(
                0
            ))
            .unwrap()
                > 0
        );
        assert!(c.query_row("SELECT count(*) FROM flashcard_cloud_uploads WHERE namespace=?1 AND status='pending'", [&ns], |r| r.get::<_, i64>(0)).unwrap() > 0);
        crate::cloud_maintenance::tests::assert_physical_partial(
            c,
            &ns,
            &maintenance_listing,
            &maintenance_key,
        );
    };
    assert_partial(&c);
    c.execute_batch("CREATE TABLE future_partial_work(id TEXT PRIMARY KEY,integer_value INTEGER,real_value REAL,text_value TEXT,blob_value BLOB,null_value); INSERT INTO future_partial_work VALUES('unknown-retained',7,-0.25,CAST(x'00ff61' AS TEXT),x'00ff80',NULL);
        CREATE TABLE physical_padding(payload BLOB); INSERT INTO physical_padding VALUES(zeroblob(4194304)); DROP TABLE physical_padding;
        PRAGMA user_version=731; PRAGMA application_id=917; PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
    let before = preserved_database(&c);
    drop(c);
    let root = fs::canonicalize(db.parent().unwrap()).unwrap();
    let before_bytes = fs::metadata(&db).unwrap().len();
    let media_bytes = [
        fs::read(blobs.path_for(&original_media).unwrap()).unwrap(),
        fs::read(blobs.path_for(&new_media).unwrap()).unwrap(),
    ];
    crate::local_database_maintenance::request(&root).unwrap();
    let result =
        crate::local_database_maintenance::process_pending(&root, Arc::new(AtomicBool::new(false)))
            .unwrap()
            .unwrap();
    assert_eq!(result.phase, "complete");
    assert!(
        result.after_bytes < before_bytes,
        "the formal owner must physically reclaim pages"
    );
    assert_eq!(fs::metadata(&db).unwrap().len(), result.after_bytes);
    let c = Connection::open(&db).unwrap();
    assert_eq!(preserved_database(&c), before);
    assert_partial(&c);
    assert_eq!(
        c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        731
    );
    assert_eq!(
        c.query_row("PRAGMA application_id", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        917
    );
    drop(c);
    let backup = Connection::open_with_flags(
        &result.backup_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    assert_eq!(preserved_database(&backup), before);
    assert_partial(&backup);
    assert_eq!(
        fs::read(blobs.path_for(&original_media).unwrap()).unwrap(),
        media_bytes[0]
    );
    assert_eq!(
        fs::read(blobs.path_for(&new_media).unwrap()).unwrap(),
        media_bytes[1]
    );
}

#[test]
fn resource_streamed_content_hash_matches_complete_canonical_identity_across_all_domains() {
    let (empty, _) = resource_device("hash-empty");
    let (full, _, _) = populated("hash-full");
    for db in [empty, full] {
        let c = open_database(&db).unwrap();
        for settings in [false, true] {
            if settings {
                c.execute_batch("INSERT INTO metadata(key,value) VALUES('flashcard_daily_new_limit','50'),('flashcard_daily_new_limit_updated_at','100') ON CONFLICT(key) DO UPDATE SET value=excluded.value;").unwrap();
            }
            let reference = content_identity(&local_flashcard_snapshot(&c).unwrap()).unwrap();
            let expected = format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(&reference).unwrap())
            );
            assert_eq!(records::content_hash(&c).unwrap(), expected);
        }
    }
}

fn restore_v67_shape(c: &Connection) {
    c.execute_batch(
        "DROP TRIGGER flashcard_reviews_append_event;
        DROP TABLE flashcard_review_events; DROP TABLE flashcard_scheduler_profiles;
        ALTER TABLE flashcard_reviews DROP COLUMN scheduler_profile_id;
        UPDATE metadata SET value='67' WHERE key='schema_version';",
    )
    .unwrap();
}

#[tokio::test]
async fn resource_rebuilt_review_tracking_preserves_cutoff_and_marks_missing_identities() {
    let server = server().await;
    let remote = store(&server);
    let (db, blobs, _) = populated("rebuild-ledger");
    let ns = config().namespace();
    {
        let c = open_database(&db).unwrap();
        let mut orphan = local_flashcard_snapshot(&c).unwrap().reviews[0].clone();
        orphan.id = "rebuilt-orphan".into();
        orphan.card_id = "never-projected-orphan".into();
        flashcard_review_log::append(&c, &orphan).unwrap();
    }
    sync_database(&remote, &db, &blobs, &ns, false, false)
        .await
        .unwrap();
    let mut c = open_database(&db).unwrap();
    let acknowledged = baseline::snapshot_for_test(&c, &ns).unwrap();
    let acknowledged = serde_json::to_value(&acknowledged).unwrap();
    let acknowledged_rows = |c: &Connection| {
        let mut query = c.prepare("SELECT field,identity,payload FROM flashcard_cloud_resource_records WHERE namespace=?1 ORDER BY field,identity").unwrap();
        query
            .query_map([&ns], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    };
    let exact_acknowledged = acknowledged_rows(&c);
    let cutoff: i64 = c
        .query_row(
            "SELECT cutoff FROM flashcard_cloud_resource_baselines WHERE namespace=?1",
            [&ns],
            |r| r.get(0),
        )
        .unwrap();
    restore_v67_shape(&c);
    let before: i64 = c
        .query_row(
            "SELECT revision FROM flashcard_cloud_revision_state WHERE id=1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    flashcard_review_log::migrate(&mut c).unwrap();
    ensure_tracking(&c).unwrap();
    let after: i64 = c
        .query_row(
            "SELECT revision FROM flashcard_cloud_revision_state WHERE id=1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(after, before + 1);
    assert_eq!(
        c.query_row(
            "SELECT cutoff FROM flashcard_cloud_resource_baselines WHERE namespace=?1",
            [&ns],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        cutoff
    );
    let revisions: Vec<i64> = {
        let mut q=c.prepare("SELECT revision FROM flashcard_cloud_entity_revisions WHERE field IN ('reviews','schedulerProfiles')").unwrap();
        q.query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    assert!(!revisions.is_empty());
    assert!(revisions.iter().all(|r| *r == after && *r > cutoff));
    assert_eq!(c.query_row("SELECT revision FROM flashcard_cloud_entity_revisions WHERE field='reviews' AND identity=?1",[serde_json::to_string("rebuilt-orphan").unwrap()],|r|r.get::<_,i64>(0)).unwrap(),after);
    assert!(flashcard_review_log::get(&c, "rebuilt-orphan")
        .unwrap()
        .is_none());
    // Reconstruction does not invent a receipt for the missing immutable fact.
    let retained = serde_json::to_value(baseline::snapshot_for_test(&c, &ns).unwrap()).unwrap();
    for field in records::FIELDS {
        assert_eq!(retained[field], acknowledged[field], "ack {field}");
    }
    assert_eq!(acknowledged_rows(&c), exact_acknowledged);
}

#[tokio::test]
async fn resource_rebuilt_review_tracking_rolls_back_with_the_domain_migration() {
    let server = server().await;
    let remote = store(&server);
    let (db, blobs, _) = populated("rebuild-rollback");
    let ns = config().namespace();
    sync_database(&remote, &db, &blobs, &ns, false, false)
        .await
        .unwrap();
    let mut c = open_database(&db).unwrap();
    restore_v67_shape(&c);
    let before: i64 = c
        .query_row(
            "SELECT revision FROM flashcard_cloud_revision_state WHERE id=1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let rows = |c: &Connection| {
        let mut q=c.prepare("SELECT field,identity,revision FROM flashcard_cloud_entity_revisions ORDER BY field,identity").unwrap();
        q.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
    };
    let ledger = rows(&c);
    let cutoff: i64 = c
        .query_row(
            "SELECT cutoff FROM flashcard_cloud_resource_baselines WHERE namespace=?1",
            [&ns],
            |r| r.get(0),
        )
        .unwrap();
    c.execute_batch("CREATE TRIGGER reject_resource_v68 BEFORE UPDATE ON metadata WHEN NEW.key='schema_version' AND NEW.value='68' BEGIN SELECT RAISE(ABORT,'injected resource migration failure'); END;").unwrap();
    assert!(flashcard_review_log::migrate(&mut c).is_err());
    assert_eq!(
        c.query_row(
            "SELECT revision FROM flashcard_cloud_revision_state WHERE id=1",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        before
    );
    assert_eq!(rows(&c), ledger);
    assert_eq!(
        c.query_row(
            "SELECT cutoff FROM flashcard_cloud_resource_baselines WHERE namespace=?1",
            [&ns],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        cutoff
    );
    assert_eq!(c.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('flashcard_review_events','flashcard_scheduler_profiles')",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    assert_eq!(c.query_row("SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name GLOB 'flashcard_resource_*'",[],|r|r.get::<_,i64>(0)).unwrap(),21);
    c.execute_batch("DROP TRIGGER reject_resource_v68;")
        .unwrap();
    drop(c);
    forget_initialized_database(&db);
    let c = open_database(&db).unwrap();
    ensure_tracking(&c).unwrap();
    assert_eq!(
        c.query_row(
            "SELECT revision FROM flashcard_cloud_revision_state WHERE id=1",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        before + 1
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM flashcard_review_events", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn resource_intact_table_missing_tracker_is_not_repaired_by_review_migration() {
    let (db, _, _) = populated("intact-tracker-corruption");
    let mut c = open_database(&db).unwrap();
    c.execute_batch("DROP TRIGGER flashcard_resource_reviews_INSERT;")
        .unwrap();
    assert!(ensure_tracking(&c).is_err());
    assert!(flashcard_review_log::migrate(&mut c).is_err());
    assert_eq!(c.query_row("SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name='flashcard_resource_reviews_INSERT'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
}

fn records_by_identity(field: &str, items: &Value) -> BTreeMap<String, Value> {
    items
        .as_array()
        .unwrap()
        .iter()
        .map(|value| (records::identity(field, value), value.clone()))
        .collect()
}

#[tokio::test]
async fn resource_wire_and_acknowledgments_cover_all_eight_formal_domains() {
    let server = server().await;
    let remote = store(&server);
    let (db, blobs, card) = populated("all-domains");
    let ns = config().namespace();
    let c = open_database(&db).unwrap();
    let expected = serde_json::to_value(local_flashcard_snapshot(&c).unwrap()).unwrap();
    assert_eq!(expected["cards"][0]["id"], card);
    for field in records::FIELDS {
        assert!(!expected[field].as_array().unwrap().is_empty(), "{field}");
    }
    drop(c);
    let result = sync_database(&remote, &db, &blobs, &ns, true, false)
        .await
        .unwrap();
    assert_eq!(result.cloud_report.unwrap().uploaded_changes, 1);
    let c = open_database(&db).unwrap();
    let acknowledged = serde_json::to_value(baseline::snapshot_for_test(&c, &ns).unwrap()).unwrap();
    let wire = server
        .state
        .lock()
        .unwrap()
        .files
        .values()
        .find_map(|(body, _)| serde_json::from_slice::<Change>(body).ok())
        .unwrap();
    let wire = serde_json::to_value(wire.snapshot).unwrap();
    for field in records::FIELDS {
        assert_eq!(
            records_by_identity(field, &wire[field]),
            records_by_identity(field, &expected[field]),
            "wire {field}"
        );
        assert_eq!(
            records_by_identity(field, &acknowledged[field]),
            records_by_identity(field, &expected[field]),
            "ack {field}"
        );
    }
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM flashcard_cloud_frozen_records",
            [],
            |r| r.get::<_, usize>(0)
        )
        .unwrap(),
        0
    );
}

#[tokio::test]
async fn resource_noop_stage_does_not_read_card_draft_or_review_bodies() {
    let server = server().await;
    let remote = store(&server);
    let (db, blobs, card) = populated("no-op-cost");
    let ns = config().namespace();
    {
        let c = open_database(&db).unwrap();
        for n in 0..40 {
            c.execute("INSERT INTO flashcards(id,deck_id,question,answer,created_at,updated_at,due_at) SELECT ?1,deck_id,?2,'保留',10,10,10 FROM flashcards WHERE id=?3",params![format!("unrelated-{n}"),"x".repeat(64*1024),card]).unwrap();
        }
    }
    sync_database(&remote, &db, &blobs, &ns, false, false)
        .await
        .unwrap();
    let c = open_database(&db).unwrap();
    let denied = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = denied.clone();
    c.authorizer(Some(move |context: AuthContext<'_>| {
        if let AuthAction::Read {
            table_name,
            column_name,
        } = context.action
        {
            if (matches!(table_name, "flashcards" | "flashcard_drafts")
                && matches!(
                    column_name,
                    "question" | "answer" | "explanation" | "card_data_json"
                ))
                || (table_name == "flashcard_review_events" && column_name == "payload_json")
            {
                observed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                return Authorization::Deny;
            }
        }
        Authorization::Allow
    }));
    stage(&c, &ns, false).unwrap();
    assert_eq!(denied.load(std::sync::atomic::Ordering::SeqCst), 0);
    assert!(
        local_flashcard_snapshot(&c).is_err(),
        "the actual full snapshot must be rejected by the same probe"
    );
    assert!(denied.load(std::sync::atomic::Ordering::SeqCst) > 0);
    c.authorizer(None::<fn(AuthContext<'_>) -> Authorization>);
    assert_eq!(pending_count(&db), 0);
}

#[tokio::test]
async fn resource_equal_clock_edit_and_later_edit_survive_frozen_confirmation() {
    let server = server().await;
    let remote = store(&server);
    let (db, blobs, card) = populated("late-edit");
    let ns = config().namespace();
    sync_database(&remote, &db, &blobs, &ns, false, false)
        .await
        .unwrap();
    {
        let c = open_database(&db).unwrap();
        c.execute(
            "UPDATE flashcards SET question='冻结的同秒修改' WHERE id=?1",
            [&card],
        )
        .unwrap();
        stage(&c, &ns, false).unwrap();
        let (_, body) = next(&c, &ns);
        let change: Change = serde_json::from_slice(&body).unwrap();
        assert!(!change.checkpoint);
        assert_eq!(change.snapshot.cards.len(), 1);
        assert_eq!(change.snapshot.cards[0].question, "冻结的同秒修改");
        assert!(change.snapshot.reviews.is_empty());
        assert!(change.snapshot.drafts.is_empty());
        c.execute(
            "UPDATE flashcards SET question='传输等待期间再次修改' WHERE id=?1",
            [&card],
        )
        .unwrap();
        assert_eq!(next(&c, &ns).1, body);
    }
    let report = sync_database(&remote, &db, &blobs, &ns, false, false)
        .await
        .unwrap()
        .cloud_report
        .unwrap();
    assert_eq!(report.uploaded_changes, 2);
    let c = open_database(&db).unwrap();
    assert_eq!(
        baseline::snapshot_for_test(&c, &ns)
            .unwrap()
            .cards
            .iter()
            .find(|v| v.id == card)
            .unwrap()
            .question,
        "传输等待期间再次修改"
    );
    assert_eq!(pending_count(&db), 0);
}

#[tokio::test]
async fn resource_receipt_failure_rolls_back_ack_and_retains_frozen_retry_after_reopen() {
    let server = server().await;
    let remote = store(&server);
    let (db, blobs, card) = populated("ack-rollback");
    let ns = config().namespace();
    sync_database(&remote, &db, &blobs, &ns, false, false)
        .await
        .unwrap();
    let previous = {
        let c = open_database(&db).unwrap();
        baseline::snapshot_for_test(&c, &ns).unwrap().cards[0]
            .question
            .clone()
    };
    {
        let c = open_database(&db).unwrap();
        c.execute(
            "UPDATE flashcards SET question='待确认修改' WHERE id=?1",
            [&card],
        )
        .unwrap();
        c.execute_batch("CREATE TRIGGER reject_resource_receipt BEFORE INSERT ON flashcard_cloud_applied BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END;").unwrap();
    }
    assert!(sync_database(&remote, &db, &blobs, &ns, false, false)
        .await
        .is_err());
    {
        let c = open_database(&db).unwrap();
        assert_eq!(
            baseline::snapshot_for_test(&c, &ns).unwrap().cards[0].question,
            previous
        );
        assert_eq!(pending_count(&db), 1);
        assert_eq!(
            c.query_row(
                "SELECT count(*) FROM flashcard_cloud_frozen_uploads",
                [],
                |r| r.get::<_, usize>(0)
            )
            .unwrap(),
            1
        );
        c.execute_batch("DROP TRIGGER reject_resource_receipt")
            .unwrap();
    }
    forget_initialized_database(&db);
    let report = sync_database(&remote, &db, &blobs, &ns, false, false)
        .await
        .unwrap()
        .cloud_report
        .unwrap();
    assert_eq!(
        report.uploaded_changes, 0,
        "already verified immutable transport is not duplicated"
    );
    let c = open_database(&db).unwrap();
    assert_eq!(
        baseline::snapshot_for_test(&c, &ns).unwrap().cards[0].question,
        "待确认修改"
    );
    assert_eq!(pending_count(&db), 0);
}

#[tokio::test]
async fn resource_old_reader_completion_reconciles_exact_frozen_values_before_later_edit() {
    let server = server().await;
    let remote = store(&server);
    let (db, blobs, card) = populated("old-reader");
    let ns = config().namespace();
    sync_database(&remote, &db, &blobs, &ns, false, false)
        .await
        .unwrap();
    let (id, body, compatibility) = {
        let c = open_database(&db).unwrap();
        c.execute(
            "UPDATE flashcards SET question='新队列冻结值' WHERE id=?1",
            [&card],
        )
        .unwrap();
        stage(&c, &ns, false).unwrap();
        let (id, body) = next(&c, &ns);
        let compatibility: String = c
            .query_row(
                "SELECT baseline FROM flashcard_cloud_uploads WHERE namespace=?1 AND id=?2",
                params![ns, id],
                |r| r.get(0),
            )
            .unwrap();
        let valid: FlashcardSyncSnapshot = serde_json::from_str(&compatibility).unwrap();
        assert_ne!(valid.cards[0].question, "新队列冻结值");
        c.execute(
            "UPDATE flashcards SET question='旧客户端发送期间的新修改' WHERE id=?1",
            [&card],
        )
        .unwrap();
        (id, body, compatibility)
    };
    remote
        .put_verified(&remote.key(&format!("changes/{id}")), &body)
        .await
        .unwrap();
    {
        // Execute the released reader's confirmation algorithm with the actual
        // new producer body and its intact, deliberately stale compatibility DTO.
        let mut c = open_database(&db).unwrap();
        let tx = c.transaction().unwrap();
        tx.execute("UPDATE flashcard_cloud_uploads SET status='complete',body=X'',baseline='' WHERE namespace=?1 AND id=?2",params![ns,id]).unwrap();
        tx.execute("INSERT INTO flashcard_cloud_baselines(namespace,payload) VALUES(?1,?2) ON CONFLICT(namespace) DO UPDATE SET payload=excluded.payload",params![ns,compatibility]).unwrap();
        tx.execute(
            "INSERT OR IGNORE INTO flashcard_cloud_applied(namespace,id) VALUES(?1,?2)",
            params![ns, remote.key(&format!("changes/{id}"))],
        )
        .unwrap();
        tx.commit().unwrap();
    }
    forget_initialized_database(&db);
    let report = sync_database(&remote, &db, &blobs, &ns, false, false)
        .await
        .unwrap()
        .cloud_report
        .unwrap();
    assert_eq!(report.uploaded_changes, 1);
    let c = open_database(&db).unwrap();
    assert_eq!(
        baseline::snapshot_for_test(&c, &ns).unwrap().cards[0].question,
        "旧客户端发送期间的新修改"
    );
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM flashcard_cloud_frozen_uploads",
            [],
            |r| r.get::<_, usize>(0)
        )
        .unwrap(),
        0
    );
    let old: FlashcardSyncSnapshot =
        serde_json::from_str(&metadata_legacy_payload(&c, &ns)).unwrap();
    assert!(
        difference(&local_flashcard_snapshot(&c).unwrap(), Some(&old))
            .unwrap()
            .is_some(),
        "released reader can safely perform redundant idempotent retransmission"
    );
}

fn metadata_legacy_payload(c: &Connection, ns: &str) -> String {
    c.query_row(
        "SELECT payload FROM flashcard_cloud_baselines WHERE namespace=?1",
        [ns],
        |r| r.get(0),
    )
    .unwrap()
}

#[test]
fn resource_valid_legacy_baseline_over_wire_limit_migrates_and_stages_small_delta() {
    let (db, _, card) = populated("large-legacy");
    let ns = config().namespace();
    let c = open_database(&db).unwrap();
    for n in 0..115 {
        c.execute("INSERT INTO flashcards(id,deck_id,question,answer,created_at,updated_at,due_at) SELECT ?1,deck_id,?2,'保留',10,10,10 FROM flashcards WHERE id=?3",params![format!("large-old-{n}"),"x".repeat(300*1024),card]).unwrap();
    }
    ensure_journal(&c).unwrap();
    let legacy = serde_json::to_string(&local_flashcard_snapshot(&c).unwrap()).unwrap();
    assert!(legacy.len() > FLASHCARD_SYNC_MAX_SNAPSHOT_BYTES);
    c.execute(
        "INSERT INTO flashcard_cloud_baselines(namespace,payload) VALUES(?1,?2)",
        params![ns, legacy],
    )
    .unwrap();
    stage(&c, &ns, false).unwrap();
    assert_eq!(pending_count(&db), 0);
    c.execute(
        "UPDATE flashcards SET answer='只有这一条改变' WHERE id='large-old-114'",
        [],
    )
    .unwrap();
    stage(&c, &ns, false).unwrap();
    let (id, body) = next(&c, &ns);
    let change: Change = serde_json::from_slice(&body).unwrap();
    assert!(!change.checkpoint);
    assert_eq!(change.snapshot.cards.len(), 1);
    assert_eq!(change.snapshot.cards[0].id, "large-old-114");
    assert!(body.len() < FLASHCARD_SYNC_MAX_SNAPSHOT_BYTES);
    let copied: String = c
        .query_row(
            "SELECT baseline FROM flashcard_cloud_uploads WHERE namespace=?1 AND id=?2",
            params![ns, id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(copied, legacy);
    assert_eq!(
        serde_json::from_str::<FlashcardSyncSnapshot>(&copied)
            .unwrap()
            .cards
            .len(),
        116
    );
}

#[test]
fn resource_invalid_legacy_migration_rolls_back_every_record_and_preserves_payload() {
    let (db, _, _) = populated("invalid-legacy");
    let ns = config().namespace();
    let c = open_database(&db).unwrap();
    ensure_journal(&c).unwrap();
    let mut legacy = serde_json::to_value(local_flashcard_snapshot(&c).unwrap()).unwrap();
    legacy["cards"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"bad-last","question":"missing required card fields"}));
    let payload = legacy.to_string();
    c.execute(
        "INSERT INTO flashcard_cloud_baselines(namespace,payload) VALUES(?1,?2)",
        params![ns, payload],
    )
    .unwrap();
    assert!(stage(&c, &ns, false).is_err());
    assert_eq!(metadata_legacy_payload(&c, &ns), payload);
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM flashcard_cloud_resource_records WHERE namespace=?1",
            [&ns],
            |r| r.get::<_, usize>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM flashcard_cloud_resource_baselines WHERE namespace=?1",
            [&ns],
            |r| r.get::<_, usize>(0)
        )
        .unwrap(),
        0
    );
}

#[tokio::test]
async fn resource_legacy_multi_pending_queue_drains_in_sequence_and_retains_failed_suffix() {
    let server = server().await;
    let remote = store(&server);
    let (db, blobs, card) = populated("legacy-queue");
    let ns = config().namespace();
    let mut ids = Vec::new();
    {
        let c = open_database(&db).unwrap();
        ensure_journal(&c).unwrap();
        for n in 0..3 {
            c.execute(
                "UPDATE flashcards SET question=?1 WHERE id=?2",
                params![format!("旧队列第{n}对象"), card],
            )
            .unwrap();
            let current = local_flashcard_snapshot(&c).unwrap();
            let body = serde_json::to_vec(&Change {
                format: "hub-flashcard-changes".into(),
                version: 4,
                checkpoint: true,
                snapshot: current.clone(),
            })
            .unwrap();
            let id = format!("{}-{:x}.json", current.device_id, Sha256::digest(&body));
            c.execute("INSERT INTO flashcard_cloud_uploads(namespace,id,body,baseline,status) VALUES(?1,?2,?3,?4,'pending')",params![ns,id,body,serde_json::to_string(&current).unwrap()]).unwrap();
            ids.push(id);
        }
        c.execute_batch("CREATE TABLE resource_upload_order(id TEXT);CREATE TRIGGER resource_completed_order AFTER UPDATE OF status ON flashcard_cloud_uploads WHEN NEW.status='complete' AND OLD.status='pending' BEGIN INSERT INTO resource_upload_order VALUES(NEW.id); END;").unwrap();
        c.execute_batch(&format!("CREATE TRIGGER resource_fail_second BEFORE INSERT ON flashcard_cloud_applied WHEN NEW.id='{}' BEGIN SELECT RAISE(ABORT,'injected second receipt');END;",remote.key(&format!("changes/{}",ids[1])))).unwrap();
    }
    assert!(sync_database(&remote, &db, &blobs, &ns, false, false)
        .await
        .is_err());
    {
        let c = open_database(&db).unwrap();
        assert_eq!(pending_count(&db), 2);
        assert_eq!(next(&c, &ns).0, ids[1]);
        c.execute_batch("DROP TRIGGER resource_fail_second")
            .unwrap();
    }
    forget_initialized_database(&db);
    let report = sync_database(&remote, &db, &blobs, &ns, false, false)
        .await
        .unwrap()
        .cloud_report
        .unwrap();
    assert_eq!(
        report.uploaded_changes, 1,
        "only the unuploaded suffix object needs a new immutable write"
    );
    let c = open_database(&db).unwrap();
    let mut q = c
        .prepare("SELECT id FROM resource_upload_order ORDER BY rowid")
        .unwrap();
    let actual = q
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(actual, ids);
    assert_eq!(pending_count(&db), 0);
    assert_eq!(
        baseline::snapshot_for_test(&c, &ns).unwrap().cards[0].question,
        "旧队列第2对象"
    );
}

#[test]
fn resource_checkpoint_overflow_preserves_all_source_rows_and_rolls_back_frozen_state() {
    let (db, _, card) = populated("overflow");
    let ns = config().namespace();
    let c = open_database(&db).unwrap();
    for n in 0..70 {
        c.execute("INSERT INTO flashcards(id,deck_id,question,answer,created_at,updated_at,due_at) SELECT ?1,deck_id,?2,'保留',10,10,10 FROM flashcards WHERE id=?3",params![format!("over-{n}"),"x".repeat(500*1024),card]).unwrap();
    }
    for _ in 0..2 {
        assert!(stage(&c, &ns, true).unwrap_err().contains("32 MB"));
        assert_eq!(
            c.query_row("SELECT count(*) FROM flashcards", [], |r| r
                .get::<_, usize>(0))
                .unwrap(),
            71
        );
        assert_eq!(
            c.query_row("SELECT count(*) FROM flashcard_cloud_uploads", [], |r| {
                r.get::<_, usize>(0)
            })
            .unwrap(),
            0
        );
        assert_eq!(
            c.query_row(
                "SELECT count(*) FROM flashcard_cloud_frozen_records",
                [],
                |r| r.get::<_, usize>(0)
            )
            .unwrap(),
            0
        );
    }
}

#[test]
fn resource_draft_compare_reads_only_the_requested_identity() {
    use rusqlite::functions::FunctionFlags;
    let (db, _) = resource_device("draft-subset");
    import_flashcard_values(
        &db,
        "manual",
        "收件箱".into(),
        json!({"source":"manual"}),
        (0..12)
            .map(|n| json!({"question":format!("问题{n}"),"answer":"保留"}))
            .collect(),
        true,
    )
    .unwrap();
    let c = open_database(&db).unwrap();
    let incoming = flashcard_sync_drafts::snapshot(&c).unwrap()[7].clone();
    let read_ids = Arc::new(Mutex::new(Vec::<String>::new()));
    let observed = read_ids.clone();
    c.create_scalar_function(
        "resource_draft_question",
        2,
        FunctionFlags::SQLITE_UTF8,
        move |ctx| {
            observed.lock().unwrap().push(ctx.get::<String>(1)?);
            ctx.get::<String>(0)
        },
    )
    .unwrap();
    let columns = FLASHCARD_DRAFT_SELECT_FIELDS.replace(
        "question,",
        "resource_draft_question(question,id) AS question,",
    );
    c.execute_batch(&format!("CREATE TEMP VIEW flashcard_drafts AS SELECT {columns},status,updated_at FROM main.flashcard_drafts;")).unwrap();
    flashcard_sync_drafts::merge(&c, &[incoming.clone()]).unwrap();
    assert_eq!(
        *read_ids.lock().unwrap(),
        vec![flashcard_sync_drafts::identity(&incoming).to_string()]
    );
}

#[test]
fn resource_merge_snapshot_reads_only_remote_card_identities() {
    use rusqlite::functions::FunctionFlags;
    let (db, _, card) = populated("merge-subset");
    let c = open_database(&db).unwrap();
    for n in 0..24 {
        c.execute("INSERT INTO flashcards(id,deck_id,question,answer,created_at,updated_at,due_at) SELECT ?1,deck_id,?2,'保留',10,10,10 FROM flashcards WHERE id=?3",params![format!("merge-unrelated-{n}"),"x".repeat(64*1024),card]).unwrap();
    }
    let mut remote = records::empty(&c).unwrap();
    remote.cards = local_flashcard_snapshot(&c)
        .unwrap()
        .cards
        .into_iter()
        .filter(|v| v.id == card)
        .collect();
    let read_ids = Arc::new(Mutex::new(Vec::<String>::new()));
    let observed = read_ids.clone();
    c.create_scalar_function(
        "resource_card_question",
        2,
        FunctionFlags::SQLITE_UTF8,
        move |ctx| {
            observed.lock().unwrap().push(ctx.get::<String>(1)?);
            ctx.get::<String>(0)
        },
    )
    .unwrap();
    let columns="id,deck_id,resource_card_question(question,id) AS question,answer,explanation,card_type,source_library_id,source_document_id,source_block_id,source_title,source_path,source_hash,media_json,status,created_at,updated_at,due_at,interval_days,ease,repetitions,lapses,card_data_json,tags_json,evidence,confidence,custom_fields_json,generation_json,fsrs_state_json";
    c.execute_batch(&format!(
        "CREATE TEMP VIEW flashcards AS SELECT {columns} FROM main.flashcards;"
    ))
    .unwrap();
    let selected = records::cards_for_merge(&c, &remote.cards).unwrap();
    assert_eq!(selected.len(), 1);
    assert_eq!(selected[0].id, card);
    assert_eq!(*read_ids.lock().unwrap(), vec![card]);
}

#[test]
fn resource_revision_overflow_and_rolled_back_writes_preserve_original_projection() {
    let (db, _, card) = populated("revision-rollback");
    let mut c = open_database(&db).unwrap();
    let initial: i64 = c
        .query_row(
            "SELECT revision FROM flashcard_cloud_revision_state WHERE id=1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let previous = flashcard_by_id(&c, &card).unwrap().question;
    let tx = c.transaction().unwrap();
    tx.execute(
        "UPDATE flashcards SET question='事务内修改' WHERE id=?1",
        [&card],
    )
    .unwrap();
    assert!(
        tx.query_row(
            "SELECT revision FROM flashcard_cloud_revision_state WHERE id=1",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap()
            > initial
    );
    tx.rollback().unwrap();
    assert_eq!(
        c.query_row(
            "SELECT revision FROM flashcard_cloud_revision_state WHERE id=1",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        initial
    );
    assert_eq!(flashcard_by_id(&c, &card).unwrap().question, previous);
    c.execute(
        "UPDATE flashcard_cloud_revision_state SET revision=?1 WHERE id=1",
        [i64::MAX],
    )
    .unwrap();
    assert!(c
        .execute(
            "UPDATE flashcards SET question='不可遗失的溢出修改' WHERE id=?1",
            [&card]
        )
        .is_err());
    assert_eq!(flashcard_by_id(&c, &card).unwrap().question, previous);
    assert_eq!(
        c.query_row(
            "SELECT revision FROM flashcard_cloud_revision_state WHERE id=1",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        i64::MAX
    );
}

#[test]
fn resource_media_index_preserves_all_sources_and_only_refreshes_changed_references() {
    let (db, blobs, card) = populated("media-index");
    let mut c = open_database(&db).unwrap();
    let png = blobs.put(b"\x89PNG\r\n\x1a\nresource-png").unwrap().hash;
    let svg=blobs.put(br#"<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>"#).unwrap().hash;
    let audio = blobs
        .put(b"RIFF\x10\0\0\0WAVEfmt resource-audio")
        .unwrap()
        .hash;
    let before = blobs.put(b"resource-before-text").unwrap().hash;
    c.execute(
        "UPDATE flashcards SET media_json=?1 WHERE id=?2",
        params![
            json!([{"url":format!("http://craft-media.localhost/{png}"),"mimeType":"image/png"}])
                .to_string(),
            card
        ],
    )
    .unwrap();
    let draft: String = c
        .query_row(
            "SELECT id FROM flashcard_drafts WHERE status='accepted' ORDER BY id LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    c.execute(
        "UPDATE flashcard_drafts SET media_json=?1 WHERE id=?2",
        params![
            json!([{"url":format!("hub-media://localhost/{svg}"),"mimeType":"image/svg+xml"}])
                .to_string(),
            draft
        ],
    )
    .unwrap();
    flashcard_quality::merge(&c,&[json!({"id":"resource-feedback","kind":"feedback","updatedAt":40,"snapshot":{"media":[{"url":format!("craft-media://localhost/{audio}"),"mimeType":"audio/wav"}]},"before":{"media":[{"url":format!("http://craft-media.localhost/{before}"),"mimeType":"text/plain"}]}})]).unwrap();
    let expected = flashcard_snapshot_media_hashes(&local_flashcard_snapshot(&c).unwrap());
    assert_eq!(media_index::hashes(&c).unwrap(), expected);
    for hash in [&png, &svg, &audio, &before] {
        assert!(expected.contains(hash));
    }
    media_index::register_local(&c, &blobs, None).unwrap();
    assert_eq!(
        c.query_row("SELECT mime_type FROM blobs WHERE hash=?1", [&svg], |r| {
            r.get::<_, String>(0)
        })
        .unwrap(),
        "image/svg+xml"
    );
    let bad = blobs.put(b"not an SVG document").unwrap().hash;
    flashcard_quality::merge(&c,&[json!({"id":"resource-feedback","kind":"feedback","updatedAt":50,"snapshot":{"media":[{"url":format!("craft-media://localhost/{audio}"),"mimeType":"audio/wav"}]},"before":{"media":[{"url":format!("http://craft-media.localhost/{bad}"),"mimeType":"image/svg+xml"}]}})]).unwrap();
    c.authorizer(Some(|context: AuthContext<'_>| {
        if matches!(
            context.action,
            AuthAction::Read {
                table_name: "flashcards" | "flashcard_drafts",
                column_name: "media_json" | "question" | "answer"
            }
        ) {
            Authorization::Deny
        } else {
            Authorization::Allow
        }
    }));
    assert!(media_index::references(&c, &png).unwrap());
    media_index::register_local(&c, &blobs, Some(&png)).unwrap();
    c.authorizer(None::<fn(AuthContext<'_>) -> Authorization>);
    assert!(
        media_index::register_local(&c, &blobs, None).is_err(),
        "unrelated malformed SVG is still validated during all-media work"
    );
    let previous = media_index::hashes(&c).unwrap();
    let tx = c.transaction().unwrap();
    tx.execute("UPDATE flashcards SET media_json='[]' WHERE id=?1", [&card])
        .unwrap();
    assert!(!media_index::hashes(&tx).unwrap().contains(&png));
    tx.rollback().unwrap();
    assert_eq!(media_index::hashes(&c).unwrap(), previous);
}
