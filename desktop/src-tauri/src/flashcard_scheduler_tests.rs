use super::*;
use crate::flashcard_store::flashcard_by_id;
use crate::flashcard_study::legacy_scheduled_flashcard_values;
use std::ops::{Deref, DerefMut};

#[test]
#[ignore = "需要显式指定日常真实库，仅只读核对当前排程"]
fn real_schedules_match_production_replay_readonly() {
    let path = std::env::var("HUB_FLASHCARD_ACCEPTANCE_DB").expect("缺少只读验收库");
    let c = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("无法只读打开日常库");
    c.execute_batch("PRAGMA query_only=ON; BEGIN;").unwrap();
    let ids = c
        .prepare("SELECT id FROM flashcards ORDER BY id")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(!ids.is_empty(), "真实库没有卡片，不能算作排程验收");
    let mut replayed = 0;
    let mut fsrs = 0;
    let mut previews = 0;
    let mut mismatches = Vec::new();
    for id in &ids {
        let card = flashcard_by_id(&c, id).unwrap();
        if let Some(expected) = derived(&c, id).unwrap() {
            replayed += 1;
            fsrs += usize::from(expected.adopted);
            let raw: String = c
                .query_row(
                    "SELECT fsrs_state_json FROM flashcards WHERE id=?1",
                    [id],
                    |r| r.get(0),
                )
                .unwrap();
            let state = if raw.is_empty() {
                Value::Null
            } else {
                serde_json::from_str(&raw).unwrap()
            };
            let expected_state = if expected.adopted {
                serde_json::from_str::<Value>(&encode(&expected.state).unwrap()).unwrap()
            } else {
                Value::Null
            };
            let same = [
                card.due_at == expected.due,
                card.interval_days == expected.interval,
                card.ease == expected.ease,
                card.repetitions == expected.repetitions,
                card.lapses == expected.lapses,
                state == expected_state,
            ];
            if same.iter().any(|equal| !equal) {
                // Report only identity hashes and fields, never personal card text.
                mismatches.push(json!({"cardSha256": format!("{:x}", Sha256::digest(id.as_bytes())), "equal": same}));
            }
        }
        if card.status == "active" {
            let result = preview(&c, id, now_timestamp()).unwrap();
            assert_eq!(result.choices.len(), 4);
            previews += 1;
        }
    }
    let changes: i64 = c
        .query_row("SELECT total_changes()", [], |r| r.get(0))
        .unwrap();
    assert_eq!(changes, 0, "只读核对不应写入真实卡片或评分");
    assert!(fsrs > 0, "没有可重算的真实FSRS卡片");
    println!(
        "readonly_schedule_audit={}",
        json!({"cards": ids.len(), "replayed": replayed, "fsrsCards": fsrs, "activePreviews": previews, "writes": changes, "mismatches": mismatches})
    );
    assert!(mismatches.is_empty(), "当前缓存排程与生产重算不一致");
    c.execute_batch("ROLLBACK;").unwrap();
}

struct Db {
    connection: Option<Connection>,
    path: PathBuf,
}
impl Db {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("hub-fsrs-{}.sqlite3", random_url_safe(12)));
        let c = open_database(&path).unwrap();
        c.execute("INSERT INTO flashcard_decks(id,name,created_at,updated_at) VALUES('deck','FSRS',10,10)", []).unwrap();
        c.execute(
            "INSERT INTO flashcards(id,deck_id,question,answer,created_at,updated_at,due_at)
            VALUES('card','deck','Question','Answer',10,10,10)",
            [],
        )
        .unwrap();
        Self {
            connection: Some(c),
            path,
        }
    }
    fn snapshot(&self) -> FlashcardSyncSnapshot {
        local_flashcard_snapshot(self).unwrap()
    }
    fn card(&self) -> Flashcard {
        flashcard_by_id(self, "card").unwrap()
    }
    fn rate(&self, rating: i64, at: i64) -> FlashcardReviewResult {
        let p = preview(self, "card", at).unwrap();
        commit(self, "card", rating, Some(1000), &p.review_key, at).unwrap()
    }
    fn projection(&self) -> (i64, f64, i64, i64, String) {
        self.query_row("SELECT due_at,interval_days,repetitions,lapses,fsrs_state_json FROM flashcards WHERE id='card'",[],
            |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).unwrap()
    }
    fn legacy_review(&self, id: &str, rating: i64, at: i64) {
        let card = self.card();
        let n = legacy_scheduled_flashcard_values(
            rating,
            card.interval_days,
            card.ease,
            card.repetitions,
            card.lapses,
            at,
        );
        self.execute("INSERT INTO flashcard_reviews(id,card_id,rating,reviewed_at,previous_due_at,next_due_at,
            previous_interval_days,next_interval_days,previous_ease,previous_repetitions,previous_lapses)
            VALUES(?1,'card',?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![id,rating,at,card.due_at,n.0,card.interval_days,n.1,card.ease,card.repetitions,card.lapses]).unwrap();
        recompute(self, "card").unwrap();
    }
}
impl Deref for Db {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        self.connection.as_ref().unwrap()
    }
}
impl DerefMut for Db {
    fn deref_mut(&mut self) -> &mut Connection {
        self.connection.as_mut().unwrap()
    }
}
impl Drop for Db {
    fn drop(&mut self) {
        drop(self.connection.take());
        forget_initialized_database(&self.path);
        for path in [
            self.path.clone(),
            PathBuf::from(format!("{}-wal", self.path.display())),
            PathBuf::from(format!("{}-shm", self.path.display())),
        ] {
            let _ = fs::remove_file(path);
        }
    }
}

#[test]
fn fsrs_preview_commit_and_replay_share_the_same_intervals() {
    for rating in 1..=4 {
        let db = Db::new();
        let before = db.projection();
        let p = preview(&db, "card", 1000).unwrap();
        assert_eq!(
            p.choices
                .iter()
                .map(|c| c.interval_seconds)
                .collect::<Vec<_>>(),
            vec![600, DAY, 2 * DAY, 8 * DAY]
        );
        assert_eq!(
            db.projection(),
            before,
            "preview must not reschedule old or new cards"
        );
        let result = commit(&db, "card", rating, None, &p.review_key, 1000).unwrap();
        assert_eq!(
            result.card.due_at - 1000,
            p.choices[(rating - 1) as usize].interval_seconds
        );
        let saved = db.projection();
        recompute(&db, "card").unwrap();
        assert_eq!(db.projection(), saved);
        let snapshot = db.snapshot();
        assert_eq!(snapshot.version, 4);
        assert_eq!(snapshot.reviews[0].scheduler_version, 1);
        assert!(decode(&snapshot.cards[0].fsrs_state_json)
            .unwrap()
            .memory
            .is_some());
    }
}

#[test]
fn fsrs_schema_upgrade_preserves_old_due_dates_and_history() {
    let mut db = Db::new();
    db.legacy_review("old", 3, 1000);
    let before = db.projection();
    db.execute_batch(
        "DROP TRIGGER flashcard_reviews_append_event;
        ALTER TABLE flashcards DROP COLUMN fsrs_state_json;
        ALTER TABLE flashcard_reviews DROP COLUMN scheduler_version;
        ALTER TABLE flashcard_reviews DROP COLUMN previous_fsrs_state_json;
        UPDATE metadata SET value='66' WHERE key='schema_version';",
    )
    .unwrap();
    drop(db.connection.take());
    forget_initialized_database(&db.path);
    db.connection = Some(open_database(&db.path).unwrap());
    assert_eq!(db.projection(), before);
    assert_eq!(db.snapshot().reviews.len(), 1);
    assert_eq!(db.snapshot().reviews[0].scheduler_version, 0);
    let raw = db.snapshot().cards[0].fsrs_state_json.clone();
    preview(&db, "card", 1000 + DAY).unwrap();
    assert_eq!(db.snapshot().cards[0].fsrs_state_json, raw);
}

#[test]
fn fsrs_legacy_history_and_first_fsrs_undo_restore_exact_schedule() {
    let db = Db::new();
    db.legacy_review("old-1", 3, 1000);
    db.legacy_review("old-2", 2, 1000 + DAY);
    // Preserve a user's pre-existing due date even if it differs from replay.
    db.execute(
        "UPDATE flashcards SET due_at=due_at+7200 WHERE id='card'",
        [],
    )
    .unwrap();
    let before = db.card();
    let result = db.rate(3, 1000 + 3 * DAY);
    let saved = db.projection();
    recompute(&db, "card").unwrap();
    assert_eq!(db.projection(), saved);
    restore(&db, &result.review_id, 1000 + 3 * DAY + 1).unwrap();
    let undone = db.card();
    assert_eq!(
        (
            undone.due_at,
            undone.interval_days,
            undone.ease,
            undone.repetitions,
            undone.lapses
        ),
        (
            before.due_at,
            before.interval_days,
            before.ease,
            before.repetitions,
            before.lapses
        )
    );
    assert_eq!(db.snapshot().reviews.len(), 3);
    assert_eq!(events(&db, "card").unwrap().len(), 2);
}

#[test]
fn fsrs_imported_card_without_history_keeps_its_initial_memory_on_replay() {
    let db = Db::new();
    db.execute(
        "UPDATE flashcards SET due_at=?1,interval_days=12,repetitions=4,ease=2.3 WHERE id='card'",
        [20 * DAY],
    )
    .unwrap();
    let before = db.card();
    let result = db.rate(3, 20 * DAY);
    let saved = db.projection();
    recompute(&db, "card").unwrap();
    assert_eq!(db.projection(), saved);
    restore(&db, &result.review_id, 20 * DAY + 1).unwrap();
    assert_eq!(db.card().due_at, before.due_at);
    assert_eq!(db.card().repetitions, 4);
}

#[test]
fn fsrs_elapsed_time_late_reviews_and_same_day_reviews_use_the_model() {
    let db = Db::new();
    db.rate(3, 1000);
    let initial = load(&db, &db.card()).unwrap();
    let same = next(&initial, 3, 1600).unwrap();
    let late = next(&initial, 3, 1000 + 30 * DAY).unwrap();
    assert!(late.interval > same.interval);
    assert_ne!(
        late.state.memory.unwrap().stability,
        same.state.memory.unwrap().stability
    );
    db.rate(1, 1000); // Even same-second clicks get a stable event order.
    db.rate(3, 1000);
    let saved = db.projection();
    recompute(&db, "card").unwrap();
    assert_eq!(db.projection(), saved);
    let e = events(&db, "card").unwrap();
    assert_eq!(
        e.iter().map(|r| r.reviewed_at).collect::<Vec<_>>(),
        vec![1000, 1001, 1002]
    );
}

#[test]
fn fsrs_stale_preview_and_invalid_rating_do_not_write() {
    let db = Db::new();
    let old = preview(&db, "card", 1000).unwrap();
    db.rate(3, 1000);
    let saved = db.projection();
    assert!(commit(&db, "card", 4, None, &old.review_key, 1001).is_err());
    let p = preview(&db, "card", 1001).unwrap();
    assert!(commit(&db, "card", 5, None, &p.review_key, 1001).is_err());
    assert_eq!(db.projection(), saved);
    assert_eq!(db.snapshot().reviews.len(), 1);
    assert!(preview(&db, "card", 900).is_err());
    let p = preview(&db, "card", 1000 + DAY - 1).unwrap();
    assert!(commit(&db, "card", 3, None, &p.review_key, 1000 + DAY).is_err());
}

#[test]
fn fsrs_presented_guard_rejects_same_second_remote_content_before_issue() {
    let mut db = Db::new();
    let presented = db.card();
    let mut remote = db.snapshot();
    // Use the formal producer's deterministic same-second merge winner, rather
    // than mutating the expected presentation or relying on a timestamp bump.
    remote.cards[0].question = "Z remote question".into();
    remote.cards[0].answer = "Remote answer".into();
    assert_eq!(merge_flashcard_snapshot(&mut db, &remote).unwrap().0, 1);
    assert_eq!(db.card().updated_at, presented.updated_at);
    assert_ne!(db.card().question, presented.question);
    let saved = serde_json::to_value(db.snapshot()).unwrap();
    let error = preview_presented(&db, "card", &presented, 1000)
        .err()
        .expect("a stale question must not receive a review key");
    assert!(error.contains("卡片内容或复习状态已变化"));
    assert_eq!(serde_json::to_value(db.snapshot()).unwrap(), saved);
    assert!(events(&db, "card").unwrap().is_empty());

    let fresh = db.card();
    // Exercise the complete IPC payload codec used by the required argument.
    let fresh = serde_json::from_value::<Flashcard>(serde_json::to_value(fresh).unwrap()).unwrap();
    let p = preview_presented(&db, "card", &fresh, 1000).unwrap();
    commit(&db, "card", 3, None, &p.review_key, 1000).unwrap();
    assert_eq!(events(&db, "card").unwrap().len(), 1);
}

#[test]
fn fsrs_presented_guard_keeps_commit_guard_after_remote_edit() {
    let mut db = Db::new();
    let presented = db.card();
    let p = preview_presented(&db, "card", &presented, 1000).unwrap();
    let mut remote = db.snapshot();
    remote.cards[0].question = "Z edited after preview".into();
    assert_eq!(merge_flashcard_snapshot(&mut db, &remote).unwrap().0, 1);
    assert_eq!(db.card().updated_at, presented.updated_at);
    let saved = serde_json::to_value(db.snapshot()).unwrap();
    let error = commit(&db, "card", 3, None, &p.review_key, 1000)
        .err()
        .expect("an issued key must not accept an answer to replaced content");
    assert!(error.contains("复习计划已变化"));
    assert_eq!(serde_json::to_value(db.snapshot()).unwrap(), saved);
    assert!(events(&db, "card").unwrap().is_empty());
    let fresh = db.card();
    assert!(preview_presented(&db, "card", &fresh, 1000).is_ok());
}

#[test]
fn fsrs_presented_guard_accepts_original_content_after_producer_rollback() {
    let db = Db::new();
    let presented = db.card();
    let saved = serde_json::to_value(db.snapshot()).unwrap();
    let mut remote = db.snapshot();
    remote.cards[0].question = "Z rolled back remote question".into();
    let tx = db.unchecked_transaction().unwrap();
    assert_eq!(
        merge_flashcard_snapshot_in_transaction(&tx, &remote)
            .unwrap()
            .0,
        1
    );
    assert_ne!(
        flashcard_by_id(&tx, "card").unwrap().question,
        presented.question
    );
    tx.rollback().unwrap();
    assert_eq!(serde_json::to_value(db.snapshot()).unwrap(), saved);
    let p = preview_presented(&db, "card", &presented, 1000).unwrap();
    commit(&db, "card", 3, None, &p.review_key, 1000).unwrap();
    assert_eq!(events(&db, "card").unwrap().len(), 1);
}

#[test]
fn fsrs_two_devices_converge_after_concurrent_reviews_and_repeated_sync() {
    let mut a = Db::new();
    let mut b = Db::new();
    a.rate(3, 1000);
    merge_flashcard_snapshot(&mut b, &a.snapshot()).unwrap();
    a.rate(2, 1000 + 3 * DAY);
    b.rate(4, 1000 + 3 * DAY);
    let sa = a.snapshot();
    let sb = b.snapshot();
    merge_flashcard_snapshot(&mut a, &sb).unwrap();
    merge_flashcard_snapshot(&mut b, &sa).unwrap();
    assert_eq!(a.projection(), b.projection());
    let saved = a.projection();
    assert_eq!(
        merge_flashcard_snapshot(&mut a, &b.snapshot()).unwrap().1,
        0
    );
    assert_eq!(a.projection(), saved);
    assert_eq!(a.snapshot().reviews.len(), 3);
}

#[test]
fn fsrs_remote_undo_of_first_review_does_not_seed_from_deleted_memory() {
    let mut a = Db::new();
    let mut b = Db::new();
    let first = a.rate(4, 1000);
    merge_flashcard_snapshot(&mut b, &a.snapshot()).unwrap();
    b.rate(3, 1000 + 2 * DAY);
    restore(&a, &first.review_id, 1000 + 3 * DAY).unwrap();
    record_flashcard_tombstone(&a, "review", &first.review_id, 1000 + 3 * DAY).unwrap();
    let undone = a.snapshot();
    merge_flashcard_snapshot(&mut b, &undone).unwrap();
    assert_eq!(b.card().repetitions, 1);
    assert_eq!(b.card().interval_days, 2.0);
    assert_eq!(b.snapshot().reviews.len(), 2);
    assert_eq!(events(&b, "card").unwrap().len(), 1);
    merge_flashcard_snapshot(&mut a, &b.snapshot()).unwrap();
    assert_eq!(a.projection(), b.projection());
}

#[test]
fn fsrs_old_content_update_cannot_downgrade_an_adopted_schedule() {
    let mut db = Db::new();
    let mut legacy = db.snapshot();
    legacy.version = 2;
    db.rate(3, 1000);
    let saved = db.projection();
    legacy.cards[0].question = "Edited on an old device".into();
    legacy.cards[0].updated_at = 2000;
    merge_flashcard_snapshot(&mut db, &legacy).unwrap();
    assert_eq!(db.card().question, "Edited on an old device");
    assert_eq!(db.projection(), saved);
}

#[test]
fn fsrs_unknown_or_corrupt_remote_state_is_rejected_atomically() {
    let mut db = Db::new();
    db.rate(3, 1000);
    let original = db.snapshot();
    let saved = db.projection();
    for invalid in ["version", "memory", "event", "protocol"] {
        let mut remote = original.clone();
        remote.cards[0].question = "Must not be written".into();
        remote.cards[0].updated_at = 9999;
        match invalid {
            "version" => {
                remote.cards[0].fsrs_state_json = remote.cards[0]
                    .fsrs_state_json
                    .replace("\"version\":1", "\"version\":99")
            }
            "memory" => remote.cards[0].fsrs_state_json = "{}".into(),
            "event" => remote.reviews[0].scheduler_version = 99,
            _ => remote.version = 99,
        }
        assert!(merge_flashcard_snapshot(&mut db, &remote).is_err());
        assert_eq!(db.projection(), saved);
        assert_eq!(db.card().question, "Question");
    }
}

#[test]
fn fsrs_deleting_all_reviews_in_either_order_restores_the_original_card() {
    for first_to_last in [true, false] {
        let db = Db::new();
        let first = db.rate(4, 1000);
        let second = db.rate(3, 1000 + DAY);
        let order = if first_to_last {
            [first.review_id, second.review_id]
        } else {
            [second.review_id, first.review_id]
        };
        for id in order {
            restore(&db, &id, 1000 + 2 * DAY).unwrap();
        }
        assert_eq!(
            (db.card().due_at, db.card().repetitions, db.card().lapses),
            (10, 0, 0)
        );
        assert!(load(&db, &db.card()).unwrap().state.memory.is_none());
        assert_eq!(db.snapshot().reviews.len(), 2);
        assert!(events(&db, "card").unwrap().is_empty());
        let p = preview(&db, "card", 1000 + 3 * DAY).unwrap();
        assert_eq!(p.choices[2].interval_seconds, 2 * DAY);
    }
}

#[test]
fn fsrs_failed_migration_rolls_back_columns_and_can_be_retried() {
    let mut db = Db::new();
    db.execute_batch(
        "DROP TRIGGER flashcard_reviews_append_event;
        ALTER TABLE flashcards DROP COLUMN fsrs_state_json;
        ALTER TABLE flashcard_reviews DROP COLUMN scheduler_version;
        ALTER TABLE flashcard_reviews DROP COLUMN previous_fsrs_state_json;
        UPDATE metadata SET value='66' WHERE key='schema_version';
        CREATE TRIGGER reject_fsrs_version BEFORE UPDATE ON metadata WHEN NEW.key='schema_version'
        BEGIN SELECT RAISE(ABORT,'injected migration failure'); END;",
    )
    .unwrap();
    assert!(migrate(&mut db).is_err());
    let exists: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('flashcards') WHERE name='fsrs_state_json')",[],|r|r.get(0)).unwrap();
    assert!(!exists);
    assert_eq!(metadata_u64(&db, "schema_version", 0), 66);
    db.execute_batch("DROP TRIGGER reject_fsrs_version;")
        .unwrap();
    migrate(&mut db).unwrap();
    assert_eq!(db.card().due_at, 10);
    assert_eq!(metadata_u64(&db, "schema_version", 0), 67);
}

#[test]
fn fsrs_event_log_survives_undo_restart_and_cache_corruption() {
    let mut db = Db::new();
    let first = db.rate(3, 1000);
    let second = db.rate(4, 1000 + DAY);
    restore(&db, &second.review_id, 1000 + 2 * DAY).unwrap();
    assert_eq!(db.snapshot().reviews.len(), 2);
    assert_eq!(events(&db, "card").unwrap().len(), 1);
    assert_eq!(db.card().due_at, first.card.due_at);
    db.execute("UPDATE flashcards SET due_at=999999999,interval_days=999,repetitions=999,fsrs_state_json='' WHERE id='card'",[]).unwrap();
    db.execute("DELETE FROM flashcard_reviews WHERE card_id='card'", [])
        .unwrap();
    drop(db.connection.take());
    forget_initialized_database(&db.path);
    db.connection = Some(open_database(&db.path).unwrap());
    recompute(&db, "card").unwrap();
    assert_eq!(
        (db.card().due_at, db.card().repetitions),
        (first.card.due_at, 1)
    );
    assert_eq!(db.snapshot().reviews.len(), 2);
    assert_eq!(events(&db, "card").unwrap().len(), 1);
    assert!(db
        .execute("DELETE FROM flashcard_review_events", [])
        .is_err());
    assert!(db
        .execute("UPDATE flashcard_review_events SET reviewed_at=0", [])
        .is_err());
}

#[test]
fn fsrs_orphan_event_arrives_before_its_card_and_is_later_projected() {
    let source = Db::new();
    let mut target = Db::new();
    let reviewed = source.rate(3, 1000);
    let mut delta = source.snapshot();
    let mut cards = delta.clone();
    delta.cards.clear();
    delta.decks.clear();
    cards.reviews.clear();
    target
        .execute("DELETE FROM flashcards WHERE id='card'", [])
        .unwrap();
    assert_eq!(merge_flashcard_snapshot(&mut target, &delta).unwrap().1, 1);
    assert_eq!(target.snapshot().reviews.len(), 1);
    assert_eq!(
        target
            .query_row("SELECT COUNT(*) FROM flashcard_reviews", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    merge_flashcard_snapshot(&mut target, &cards).unwrap();
    assert_eq!(target.card().due_at, reviewed.card.due_at);
    assert_eq!(
        target
            .query_row("SELECT COUNT(*) FROM flashcard_reviews", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn fsrs_duplicate_event_identity_conflict_cannot_overwrite_any_local_data() {
    let mut db = Db::new();
    db.rate(3, 1000);
    let before = db.projection();
    let mut conflicting = db.snapshot();
    conflicting.reviews[0].rating = 4;
    conflicting.cards[0].question = "conflicting content".into();
    conflicting.cards[0].updated_at = 99999;
    assert!(merge_flashcard_snapshot(&mut db, &conflicting)
        .unwrap_err()
        .contains("同一身份不同内容"));
    assert_eq!(db.projection(), before);
    assert_eq!(db.card().question, "Question");
    assert_eq!(db.snapshot().reviews[0].rating, 3);
    let mut doubled = db.snapshot().reviews;
    doubled.push(conflicting.reviews[0].clone());
    assert!(flashcard_review_log::compact(&mut doubled).is_err());
    assert_eq!(doubled.len(), 2);
}

#[test]
fn fsrs_stale_card_cache_never_wins_over_the_review_log() {
    let mut db = Db::new();
    db.rate(3, 1000);
    let before = db.projection();
    let mut delta = db.snapshot();
    delta.reviews.clear();
    delta.cards[0].updated_at = 999999;
    delta.cards[0].due_at = 999999999;
    delta.cards[0].interval_days = 999.0;
    delta.cards[0].repetitions = 999;
    merge_flashcard_snapshot(&mut db, &delta).unwrap();
    assert_eq!(db.projection(), before);
    let mut legacy = delta;
    legacy.version = 2;
    legacy.cards[0].fsrs_state_json.clear();
    legacy.cards[0].updated_at += 1;
    merge_flashcard_snapshot(&mut db, &legacy).unwrap();
    assert_eq!(db.projection(), before);
    db.execute("UPDATE flashcards SET updated_at=2000000,due_at=999999999,question='new local content' WHERE id='card'",[]).unwrap();
    merge_flashcard_snapshot(&mut db, &legacy).unwrap();
    assert_eq!(db.projection(), before);
    assert_eq!(db.card().question, "new local content");
}

#[test]
fn fsrs_synced_profile_is_used_for_replay_preview_and_the_next_event() {
    let source = Db::new();
    let mut target = Db::new();
    source.rate(3, 1000);
    let mut remote = source.snapshot();
    let mut profile = flashcard_profiles::default_profile();
    profile.desired_retention = 0.8;
    profile.parameters[2] = 3.5;
    profile.id = profile.content_id().unwrap();
    remote.scheduler_profiles.push(profile.clone());
    remote.reviews[0].scheduler_profile_id = profile.id.clone();
    merge_flashcard_snapshot(&mut target, &remote).unwrap();
    let expected = profile
        .model()
        .unwrap()
        .next_states(None, 0.8, 0)
        .unwrap()
        .good
        .interval
        .round()
        .max(1.0) as f64;
    assert_eq!(target.card().interval_days, expected);
    assert_ne!(target.card().interval_days, source.card().interval_days);
    assert_eq!(
        preview(&target, "card", 1000 + DAY)
            .unwrap()
            .desired_retention,
        0.8
    );
    drop(target.connection.take());
    forget_initialized_database(&target.path);
    target.connection = Some(open_database(&target.path).unwrap());
    target.rate(3, 1000 + DAY);
    assert_eq!(
        target.snapshot().reviews[1].scheduler_profile_id,
        profile.id
    );
    assert_eq!(
        flashcard_profiles::get(&target, &profile.id).unwrap(),
        profile
    );
    let mut tampered = target.snapshot();
    tampered.scheduler_profiles[0].desired_retention = 0.99;
    assert!(merge_flashcard_snapshot(&mut target, &tampered).is_err());
}

#[test]
fn fsrs_undo_before_event_arrival_and_older_clock_cannot_resurrect_review() {
    let source = Db::new();
    let mut target = Db::new();
    let result = source.rate(3, 1000);
    let facts = source.snapshot();
    let mut undone = facts.clone();
    undone.reviews.clear();
    undone.tombstones.push(FlashcardSnapshotTombstone {
        entity_type: "review".into(),
        entity_id: result.review_id,
        deleted_at: 900,
    });
    merge_flashcard_snapshot(&mut target, &undone).unwrap();
    merge_flashcard_snapshot(&mut target, &facts).unwrap();
    assert_eq!(target.snapshot().reviews.len(), 1);
    assert!(events(&target, "card").unwrap().is_empty());
    assert_eq!((target.card().due_at, target.card().repetitions), (10, 0));
}

#[test]
fn fsrs_default_profile_identity_is_frozen_and_survives_wire_roundtrip() {
    let profile = flashcard_profiles::default_profile();
    assert_eq!(
        profile.id,
        "fsrs-profile-v1-62ce2be525955d2746a0f42b33edbf6b51201c91d28231abd206aaa936fc3d80"
    );
    let wire = serde_json::to_string(&profile).unwrap();
    let received: flashcard_profiles::Profile = serde_json::from_str(&wire).unwrap();
    received.validate().unwrap();
    assert_eq!(received, profile);
}

#[test]
fn fsrs_v67_upgrade_archives_existing_fsrs_events_and_rolls_back_on_failure() {
    let mut db = Db::new();
    let result = db.rate(3, 1000);
    let mut old_state: Value =
        serde_json::from_str(&db.snapshot().cards[0].fsrs_state_json).unwrap();
    old_state.as_object_mut().unwrap().remove("profileId");
    let mut old_previous: Value =
        serde_json::from_str(&db.snapshot().reviews[0].previous_fsrs_state_json).unwrap();
    old_previous.as_object_mut().unwrap().remove("profileId");
    db.execute_batch("DROP TRIGGER flashcard_reviews_append_event;
        DROP TABLE flashcard_review_events; DROP TABLE flashcard_scheduler_profiles;
        ALTER TABLE flashcard_reviews DROP COLUMN scheduler_profile_id;
        UPDATE metadata SET value='67' WHERE key='schema_version';
        CREATE TRIGGER reject_v68 BEFORE UPDATE ON metadata WHEN NEW.key='schema_version' AND NEW.value='68'
        BEGIN SELECT RAISE(ABORT,'injected v68 failure'); END;").unwrap();
    db.execute(
        "UPDATE flashcards SET fsrs_state_json=?1 WHERE id='card'",
        [old_state.to_string()],
    )
    .unwrap();
    db.execute(
        "UPDATE flashcard_reviews SET previous_fsrs_state_json=?1",
        [old_previous.to_string()],
    )
    .unwrap();
    assert!(flashcard_review_log::migrate(&mut db).is_err());
    assert_eq!(metadata_u64(&db, "schema_version", 0), 67);
    assert_eq!(db.query_row("SELECT COUNT(*) FROM sqlite_master WHERE name IN ('flashcard_review_events','flashcard_scheduler_profiles')",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    assert_eq!(db.card().due_at, result.card.due_at);
    db.execute_batch("DROP TRIGGER reject_v68;").unwrap();
    drop(db.connection.take());
    forget_initialized_database(&db.path);
    db.connection = Some(open_database(&db.path).unwrap());
    assert_eq!(
        metadata_u64(&db, "schema_version", 0),
        crate::database::DATABASE_SCHEMA_VERSION as u64
    );
    let snapshot = db.snapshot();
    assert_eq!(snapshot.cards[0].due_at, result.card.due_at);
    assert_eq!(snapshot.reviews.len(), 1);
    assert_eq!(
        snapshot.reviews[0].scheduler_profile_id,
        flashcard_profiles::default_id()
    );
    assert_eq!(snapshot.scheduler_profiles.len(), 1);
    restore(&db, &result.review_id, 2000).unwrap();
    assert_eq!(db.card().due_at, 10);
    assert_eq!(db.snapshot().reviews.len(), 1);
    assert!(events(&db, "card").unwrap().is_empty());
}

#[test]
fn fsrs_soft_deleted_card_keeps_the_same_history_statistics_on_both_devices() {
    let a = Db::new();
    let mut b = Db::new();
    a.rate(3, 1000);
    a.execute(
        "UPDATE flashcards SET status='deleted',updated_at=2000 WHERE id='card'",
        [],
    )
    .unwrap();
    merge_flashcard_snapshot(&mut b, &a.snapshot()).unwrap();
    for db in [&a, &b] {
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM flashcard_reviews", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(db.snapshot().reviews.len(), 1);
    }
}
