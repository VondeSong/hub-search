use super::*;
use crate::{
    database::initialize_database,
    flashcard_query::{self, Query},
    flashcard_snapshot::{self, local_flashcard_snapshot},
};
use serde_json::{json, Value};
use std::path::PathBuf;

fn database() -> Connection {
    let c = initialize_database(&PathBuf::from(":memory:")).unwrap();
    c.execute_batch("INSERT INTO flashcard_decks(id,name,created_at,updated_at) VALUES('root','Root',1,1),('child','Child',1,1),('grandchild','Grandchild',1,1),('other','Other',1,1);
        UPDATE flashcard_decks SET parent_deck_id='root' WHERE id='child'; UPDATE flashcard_decks SET parent_deck_id='child' WHERE id='grandchild';
        INSERT INTO metadata(key,value) VALUES('flashcard_daily_new_limit','0') ON CONFLICT(key) DO UPDATE SET value='0';
        INSERT INTO flashcards(id,deck_id,question,answer,created_at,updated_at,due_at) VALUES('direct','root','Root question','Answer',1,1,1),('tail','grandchild','Tail question','Answer',1,1,1),('unrelated','other','Other question','Answer',1,1,1);").unwrap();
    c
}
fn page(c: &Connection, q: &Query) -> Value {
    flashcard_query::read_page(c, "root", false, Some(q), 0, 60, None, 100, true).unwrap()
}

#[test]
fn legacy_schema_upgrade_is_transactional_repeatable_and_preserves_every_root() {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO metadata VALUES('schema_version','68');
        CREATE TABLE flashcard_decks(id TEXT PRIMARY KEY,name TEXT,folder_id TEXT,sort_order INTEGER,created_at INTEGER,updated_at INTEGER); INSERT INTO flashcard_decks VALUES('old','Old','folder',7,1,2);").unwrap();
    install_hierarchy(&c).unwrap();
    install_hierarchy(&c).unwrap();
    let old:(String,String,i64,i64)=c.query_row("SELECT parent_deck_id,folder_id,sort_order,updated_at FROM flashcard_decks WHERE id='old'",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
    assert_eq!(old, ("".into(), "folder".into(), 7, 2));
    assert_eq!(
        c.query_row(
            "SELECT value FROM metadata WHERE key='schema_version'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "69"
    );
}
#[test]
fn page_filter_counts_board_selection_and_review_share_descendant_scope_above_500() {
    let c = database();
    c.execute_batch("WITH RECURSIVE n(i) AS(SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<1200) INSERT INTO flashcards(id,deck_id,question,answer,created_at,updated_at,due_at,tags_json) SELECT 'child-'||i,'child','Child '||i,'Answer',1,1,1,'[\"child-tag\"]' FROM n;").unwrap();
    assert_eq!(page(&c, &Query::default())["total"], 1);
    let q = Query {
        include_subdecks: true,
        ..Query::default()
    };
    let first = page(&c, &q);
    assert_eq!(first["total"], 1203);
    assert_eq!(first["scopeTotal"], 1203);
    assert_eq!(first["stageCounts"]["new"], 1203);
    assert_eq!(first["items"].as_array().unwrap().len(), 60);
    let selection = flashcard_query::selection_ids(
        &c,
        "root",
        false,
        &q,
        0,
        2000,
        first["revision"].as_str(),
        100,
    )
    .unwrap();
    assert_eq!(selection["ids"].as_array().unwrap().len(), 1203);
    assert!(!selection["ids"]
        .as_array()
        .unwrap()
        .contains(&json!("unrelated")));
    assert_eq!(
        flashcard_query::review_plan_with_scope(&c, "root", 0, 100, true).unwrap()["sessionIds"]
            .as_array()
            .unwrap()
            .len(),
        1203
    );
    assert_eq!(
        flashcard_query::review_plan_with_scope(&c, "root", 0, 100, false).unwrap()
            ["eligibleCount"],
        1
    );
    assert_eq!(
        page(
            &c,
            &Query {
                include_subdecks: true,
                search: "Tail question".into(),
                ..Query::default()
            }
        )["items"][0]["id"],
        "tail"
    );
}
#[test]
fn create_and_reparent_are_atomic_prevent_cycles_and_invalidate_paging() {
    let mut c = database();
    let q = Query {
        include_subdecks: true,
        ..Query::default()
    };
    let first = page(&c, &q);
    assert!(set_parent(&mut c, "root", "grandchild").is_err());
    assert!(set_parent(&mut c, "child", "child").is_err());
    assert!(set_parent(&mut c, "child", "missing").is_err());
    assert_eq!(placement(&c, "child").unwrap().0, "root");
    let id = create_subdeck(&mut c, "New subdeck", "root").unwrap();
    assert_eq!(placement(&c, &id).unwrap().0, "root");
    assert!(create_subdeck(&mut c, "ROOT", "root").is_err());
    set_parent(&mut c, "child", "other").unwrap();
    assert_eq!(page(&c, &q)["total"], 1);
    assert!(flashcard_query::read_page(
        &c,
        "root",
        false,
        Some(&q),
        60,
        60,
        first["revision"].as_str(),
        100,
        false
    )
    .unwrap_err()
    .contains("FLASHCARD_LIST_CHANGED"));
}
#[test]
fn parent_removal_preserves_child_cards_and_records_direct_card_tombstones_in_sql() {
    let mut c = database();
    c.execute_batch("WITH RECURSIVE n(i) AS(SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<1200) INSERT INTO flashcards(id,deck_id,question,answer,created_at,updated_at,due_at) SELECT 'direct-'||i,'root','Question','Answer',1,1,1 FROM n;").unwrap();
    delete_flashcard_deck_in_connection(&mut c, "child", 20).unwrap();
    assert_eq!(placement(&c, "grandchild").unwrap().0, "root");
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM flashcards WHERE id='tail'", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    delete_flashcard_deck_in_connection(&mut c, "root", 21).unwrap();
    assert_eq!(placement(&c, "grandchild").unwrap().0, "");
    assert_eq!(c.query_row("SELECT COUNT(*) FROM flashcard_sync_tombstones WHERE entity_type='card' AND entity_id='direct'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM flashcard_sync_tombstones WHERE entity_type='card'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1202
    );
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM flashcards", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
}
#[test]
fn moving_a_parent_to_a_folder_preserves_hierarchy_and_marks_sync_dirty() {
    let mut c = database();
    c.execute_batch("INSERT INTO flashcard_deck_folders(id,name,sort_order,created_at,updated_at) VALUES('folder','Folder',0,1,1);").unwrap();
    move_flashcard_deck(&mut c, "child".into(), Some("folder".into()), None).unwrap();
    assert_eq!(
        placement(&c, "child").unwrap(),
        ("".into(), "folder".into())
    );
    assert_eq!(
        placement(&c, "grandchild").unwrap(),
        ("child".into(), "folder".into())
    );
    delete_flashcard_deck_folder_in_connection(&mut c, "folder", 30).unwrap();
    assert_eq!(
        placement(&c, "grandchild").unwrap(),
        ("child".into(), "".into())
    );
}
#[test]
fn unordered_snapshots_legacy_payloads_cycles_and_late_parent_name_aliases_preserve_cards() {
    let source = database();
    let snapshot = local_flashcard_snapshot(&source).unwrap();
    assert_eq!(snapshot.version, 5);
    let mut dest = initialize_database(&PathBuf::from(":memory:")).unwrap();
    let mut partial = snapshot.clone();
    partial.cards.clear();
    partial.decks.retain(|d| d.id == "child");
    flashcard_snapshot::merge_flashcard_snapshot(&mut dest, &partial).unwrap();
    assert_eq!(placement(&dest, "child").unwrap().0, "root"); // Late parent remains an unresolved stable ID.
    dest.execute_batch("INSERT INTO flashcard_decks(id,name,created_at,updated_at) VALUES('local-root','Root',1,1);").unwrap();
    flashcard_snapshot::merge_flashcard_snapshot(&mut dest, &snapshot).unwrap();
    assert_eq!(placement(&dest, "child").unwrap().0, "local-root");
    assert_eq!(
        dest.query_row("SELECT COUNT(*) FROM flashcards", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        3
    );
    let mut legacy = serde_json::to_value(&snapshot).unwrap();
    for deck in legacy["decks"].as_array_mut().unwrap() {
        deck.as_object_mut().unwrap().remove("parentDeckId");
    }
    legacy["version"] = json!(4);
    let decoded =
        crate::decode_flashcard_snapshot(&serde_json::to_vec(&legacy).unwrap(), "").unwrap();
    assert!(decoded
        .decks
        .iter()
        .all(|deck| deck.parent_deck_id.is_empty()));
    dest.execute_batch("UPDATE flashcard_decks SET parent_deck_id='grandchild' WHERE id='child'; UPDATE flashcard_decks SET parent_deck_id='child' WHERE id='grandchild';").unwrap();
    repair_merged_link(&dest, "child").unwrap();
    assert_eq!(placement(&dest, "child").unwrap().0, "");
}
#[test]
fn synced_parent_tombstone_promotes_children_and_converges_on_replay() {
    let mut c = database();
    let tombstone = crate::FlashcardSnapshotTombstone {
        entity_type: "deck".into(),
        entity_id: "root".into(),
        deleted_at: 20,
    };
    flashcard_snapshot::apply_flashcard_tombstone(&c, &tombstone).unwrap();
    flashcard_snapshot::apply_flashcard_tombstone(&c, &tombstone).unwrap();
    assert_eq!(placement(&c, "child").unwrap().0, "");
    assert_eq!(placement(&c, "grandchild").unwrap().0, "child");
    let original = local_flashcard_snapshot(&database()).unwrap();
    flashcard_snapshot::merge_flashcard_snapshot(&mut c, &original).unwrap();
    assert!(placement(&c, "root").is_err());
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM flashcards WHERE id='tail'", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn hierarchy_wire_marker_rejects_old_client_writes_and_retains_flat_compatibility() {
    let c = database();
    let mut snapshot = local_flashcard_snapshot(&c).unwrap();
    assert_eq!(snapshot.version, 5);
    crate::flashcard_scheduler::validate_snapshot(&snapshot).unwrap();
    snapshot.version = 4;
    assert!(crate::flashcard_scheduler::validate_snapshot(&snapshot)
        .unwrap_err()
        .contains("版本 5"));
    c.execute("UPDATE flashcard_decks SET parent_deck_id=''", [])
        .unwrap();
    assert_eq!(local_flashcard_snapshot(&c).unwrap().version, 4);
    assert_eq!(
        crate::flashcard_snapshot::records::content_hash(&c).unwrap(),
        crate::flashcard_snapshot::identity::content(&local_flashcard_snapshot(&c).unwrap())
            .unwrap()
    );
}

#[test]
fn out_of_order_parent_deletion_and_child_arrival_do_not_restore_deleted_edges() {
    let mut c = initialize_database(&PathBuf::from(":memory:")).unwrap();
    let remote = local_flashcard_snapshot(&database()).unwrap();
    let deleted = crate::FlashcardSnapshotTombstone {
        entity_type: "deck".into(),
        entity_id: "root".into(),
        deleted_at: 20,
    };
    flashcard_snapshot::apply_flashcard_tombstone(&c, &deleted).unwrap();
    flashcard_snapshot::merge_flashcard_snapshot(&mut c, &remote).unwrap();
    assert_eq!(placement(&c, "child").unwrap().0, "");
    assert_eq!(placement(&c, "grandchild").unwrap().0, "child");
    assert!(placement(&c, "root").is_err());
}

#[test]
fn repeated_parent_changes_advance_the_record_clock_and_reject_stale_replay() {
    let mut c = database();
    set_parent(&mut c, "child", "other").unwrap();
    let stale = local_flashcard_snapshot(&c).unwrap();
    let first: i64 = c
        .query_row(
            "SELECT updated_at FROM flashcard_decks WHERE id='child'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    set_parent(&mut c, "child", "").unwrap();
    let second: i64 = c
        .query_row(
            "SELECT updated_at FROM flashcard_decks WHERE id='child'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(second > first);
    flashcard_snapshot::merge_flashcard_snapshot(&mut c, &stale).unwrap();
    assert_eq!(placement(&c, "child").unwrap().0, "");
}
