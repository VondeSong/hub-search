//! Durable facts are independent of cards and of the active review projection.
//! Deleting/undoing a review removes it from the projection, never this log.
use super::*;

fn event_json(prefix: &str) -> String {
    let fields = [
        ("id", "id"),
        ("cardId", "card_id"),
        ("rating", "rating"),
        ("reviewedAt", "reviewed_at"),
        ("previousDueAt", "previous_due_at"),
        ("nextDueAt", "next_due_at"),
        ("previousIntervalDays", "previous_interval_days"),
        ("nextIntervalDays", "next_interval_days"),
        ("elapsedMs", "elapsed_ms"),
        ("previousEase", "previous_ease"),
        ("previousRepetitions", "previous_repetitions"),
        ("previousLapses", "previous_lapses"),
        ("schedulerVersion", "scheduler_version"),
        ("previousFsrsStateJson", "previous_fsrs_state_json"),
        ("schedulerProfileId", "scheduler_profile_id"),
    ];
    format!(
        "json_object({})",
        fields
            .iter()
            .map(|(key, col)| format!("'{key}',{prefix}{col}"))
            .collect::<Vec<_>>()
            .join(",")
    )
}

pub(super) fn migrate(c: &mut Connection) -> Result<(), String> {
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let rebuilt_profiles:bool=tx.query_row("SELECT NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='flashcard_scheduler_profiles')",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    let rebuilt_reviews:bool=tx.query_row("SELECT NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='flashcard_review_events')",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    flashcard_profiles::ensure(&tx)?;
    let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('flashcard_reviews') WHERE name='scheduler_profile_id')",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    if !exists {
        tx.execute_batch("ALTER TABLE flashcard_reviews ADD COLUMN scheduler_profile_id TEXT NOT NULL DEFAULT '';").map_err(|e|e.to_string())?;
    }
    tx.execute("UPDATE flashcard_reviews SET scheduler_profile_id=?1 WHERE scheduler_version=1 AND scheduler_profile_id=''",[flashcard_profiles::default_id()]).map_err(|e|e.to_string())?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS flashcard_review_events(id TEXT PRIMARY KEY,card_id TEXT NOT NULL,reviewed_at INTEGER NOT NULL,payload_json TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS flashcard_review_events_card ON flashcard_review_events(card_id,reviewed_at,id);
        CREATE TRIGGER IF NOT EXISTS flashcard_review_events_no_update BEFORE UPDATE ON flashcard_review_events
        BEGIN SELECT RAISE(ABORT,'Review events are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS flashcard_review_events_no_delete BEFORE DELETE ON flashcard_review_events
        BEGIN SELECT RAISE(ABORT,'Review events are immutable'); END;").map_err(|e|e.to_string())?;
    tx.execute_batch(&format!("INSERT OR IGNORE INTO flashcard_review_events(id,card_id,reviewed_at,payload_json)
        SELECT id,card_id,reviewed_at,{} FROM flashcard_reviews;
        CREATE TRIGGER IF NOT EXISTS flashcard_reviews_append_event AFTER INSERT ON flashcard_reviews
        BEGIN INSERT OR IGNORE INTO flashcard_review_events(id,card_id,reviewed_at,payload_json)
            VALUES(NEW.id,NEW.card_id,NEW.reviewed_at,{}); END;",event_json(""),event_json("NEW."))).map_err(|e|e.to_string())?;
    crate::flashcard_cloud_sync::rebuilt_review_tables(&tx, rebuilt_reviews, rebuilt_profiles)?;
    tx.execute_batch("INSERT INTO metadata(key,value) VALUES('schema_version','68') ON CONFLICT(key) DO UPDATE SET value=excluded.value;").map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

pub(super) fn normalize(event: &FlashcardSnapshotReview) -> FlashcardSnapshotReview {
    let mut event = event.clone();
    if event.scheduler_version == 1 && event.scheduler_profile_id.is_empty() {
        event.scheduler_profile_id = flashcard_profiles::default_id();
    }
    event
}
fn same(a: &FlashcardSnapshotReview, b: &FlashcardSnapshotReview) -> Result<bool, String> {
    Ok(
        serde_json::to_value(normalize(a)).map_err(|e| e.to_string())?
            == serde_json::to_value(normalize(b)).map_err(|e| e.to_string())?,
    )
}
fn parse(raw: &str) -> Result<FlashcardSnapshotReview, String> {
    serde_json::from_str(raw)
        .map(|r: FlashcardSnapshotReview| normalize(&r))
        .map_err(|e| format!("复习事件记录无效：{e}"))
}

pub(super) fn get(c: &Connection, id: &str) -> Result<Option<FlashcardSnapshotReview>, String> {
    let raw: Option<String> = c
        .query_row(
            "SELECT payload_json FROM flashcard_review_events WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    raw.as_deref().map(parse).transpose()
}

pub(super) fn append(c: &Connection, event: &FlashcardSnapshotReview) -> Result<bool, String> {
    let event = normalize(event);
    if event.id.is_empty()
        || event.card_id.is_empty()
        || !(1..=4).contains(&event.rating)
        || event.reviewed_at < 0
    {
        return Err("复习事件身份、评分或时间无效；没有跳过该事件".into());
    }
    if event.scheduler_version == 1 {
        flashcard_profiles::get(c, &event.scheduler_profile_id)?;
    }
    if let Some(old) = get(c, &event.id)? {
        if !same(&old, &event)? {
            return Err(format!(
                "复习事件 {} 出现同一身份不同内容，原记录和云端记录均已保留",
                event.id
            ));
        }
        return Ok(false);
    }
    c.execute("INSERT INTO flashcard_review_events(id,card_id,reviewed_at,payload_json) VALUES(?1,?2,?3,?4)",
        params![event.id,event.card_id,event.reviewed_at,serde_json::to_string(&event).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
    Ok(true)
}

pub(super) fn read(
    c: &Connection,
    card_id: Option<&str>,
    active_only: bool,
) -> Result<Vec<FlashcardSnapshotReview>, String> {
    let mut q=c.prepare("SELECT e.payload_json FROM flashcard_review_events e
        WHERE (?1 IS NULL OR e.card_id=?1) AND (?2=0 OR NOT EXISTS(
            SELECT 1 FROM flashcard_sync_tombstones t WHERE t.entity_type='review' AND t.entity_id=e.id))
        ORDER BY e.reviewed_at,e.id").map_err(|e|e.to_string())?;
    let rows = q
        .query_map(params![card_id, active_only], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.map(|r| r.map_err(|e| e.to_string()).and_then(|s| parse(&s)))
        .collect()
}

pub(super) fn project(c: &Connection, card_id: &str) -> Result<(), String> {
    // Soft-deleted cards retain their historical statistics, just as the
    // local delete command does. Missing cards wait for their card record.
    let exists: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM flashcards WHERE id=?1)",
            [card_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    c.execute("DELETE FROM flashcard_reviews WHERE card_id=?1", [card_id])
        .map_err(|e| e.to_string())?;
    if exists {
        for event in read(c, Some(card_id), true)? {
            insert_active(c, &event)?;
        }
    }
    Ok(())
}

pub(super) fn insert_active(c: &Connection, event: &FlashcardSnapshotReview) -> Result<(), String> {
    // append is the authority; the trigger also covers legacy producer paths.
    append(c, event)?;
    c.execute("INSERT OR IGNORE INTO flashcard_reviews(id,card_id,rating,reviewed_at,previous_due_at,next_due_at,
        previous_interval_days,next_interval_days,elapsed_ms,previous_ease,previous_repetitions,previous_lapses,
        scheduler_version,previous_fsrs_state_json,scheduler_profile_id)
        VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
        params![event.id,event.card_id,event.rating,event.reviewed_at,event.previous_due_at,event.next_due_at,
            event.previous_interval_days,event.next_interval_days,event.elapsed_ms,event.previous_ease,event.previous_repetitions,
            event.previous_lapses,event.scheduler_version,event.previous_fsrs_state_json,event.scheduler_profile_id]).map_err(|e|e.to_string())?;
    Ok(())
}

pub(super) fn compact(events: &mut Vec<FlashcardSnapshotReview>) -> Result<(), String> {
    let mut unique = std::collections::BTreeMap::new();
    for event in events.iter() {
        let event = normalize(event);
        if let Some(old) = unique.get(&event.id) {
            if !same(old, &event)? {
                return Err(format!(
                    "云端复习事件 {} 身份冲突；没有丢弃任一版本",
                    event.id
                ));
            }
        } else {
            unique.insert(event.id.clone(), event);
        }
    }
    *events = unique.into_values().collect();
    Ok(())
}
