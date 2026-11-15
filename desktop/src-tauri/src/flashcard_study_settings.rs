//! Shared study quota reads; no browser, command, snapshot or review orchestration dependency.
use crate::{flashcard_models::FlashcardStudySettings, metadata_string};
use rusqlite::Connection;

pub(crate) fn read_flashcard_study_settings(connection: &Connection) -> FlashcardStudySettings {
    FlashcardStudySettings {
        daily_new_limit: metadata_string(connection, "flashcard_daily_new_limit")
            .parse::<i64>()
            .ok()
            .filter(|value| matches!(value, 0 | 5 | 10 | 20 | 50))
            .unwrap_or(10),
        updated_at: metadata_string(connection, "flashcard_daily_new_limit_updated_at")
            .parse::<i64>()
            .unwrap_or(0),
    }
}

pub(crate) fn flashcard_new_studied_today(connection: &Connection) -> Result<i64, String> {
    connection
        .query_row(
            "SELECT COUNT(DISTINCT r.card_id) FROM flashcard_reviews r
             WHERE date(r.reviewed_at,'unixepoch','localtime')=date('now','localtime')
               AND ((r.previous_repetitions=0 AND r.previous_lapses=0)
                 OR (r.previous_repetitions IS NULL AND NOT EXISTS (
                   SELECT 1 FROM flashcard_reviews older WHERE older.card_id=r.card_id
                     AND (older.reviewed_at<r.reviewed_at OR
                       (older.reviewed_at=r.reviewed_at AND older.id<r.id)))))",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("无法读取今日新卡学习数：{error}"))
}

// Temporary allowance is device-local and never enters synced study preferences.
pub(crate) fn study_day(connection: &Connection, now: i64) -> Result<String, String> {
    connection
        .query_row("SELECT date(?1,'unixepoch','localtime')", [now], |row| {
            row.get(0)
        })
        .map_err(|error| error.to_string())
}

pub(crate) fn extra_new_allowance(connection: &Connection, now: i64) -> Result<i64, String> {
    let day = study_day(connection, now)?;
    if metadata_string(connection, "flashcard_extra_new_day") != day {
        return Ok(0);
    }
    Ok(metadata_string(connection, "flashcard_extra_new_count")
        .parse::<i64>()
        .unwrap_or(0)
        .max(0))
}

pub(crate) fn effective_daily_limit(connection: &Connection, now: i64) -> Result<i64, String> {
    let limit = read_flashcard_study_settings(connection).daily_new_limit;
    Ok(if limit == 0 {
        0
    } else {
        limit.saturating_add(extra_new_allowance(connection, now)?)
    })
}

pub(crate) fn grant_extra_new_cards(
    connection: &mut Connection,
    target: i64,
    now: i64,
    expected_day: &str,
) -> Result<(), String> {
    let tx = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let day = study_day(&tx, now)?;
    if expected_day != day {
        return Err("学习日期已变更，请刷新今日计划后再增加临时额度".into());
    }
    let current = extra_new_allowance(&tx, now)?;
    if target < 0 || target > current.saturating_add(5) {
        return Err("每次最多临时增加 5 张新卡".into());
    }
    if target <= current {
        return Ok(());
    } // A replay must not grant the same request twice.
    let limit = effective_daily_limit(&tx, now)?;
    if limit == 0 {
        return Err("每日新卡不限时无需增加临时额度".into());
    }
    let waiting: i64 = tx.query_row("SELECT COUNT(*) FROM flashcards WHERE status='active' AND repetitions=0 AND lapses=0 AND due_at<=?1", [now], |row| row.get(0)).map_err(|error| error.to_string())?;
    let allowance = (limit - flashcard_new_studied_today(&tx)?).max(0);
    let granted = current.saturating_add((target - current).min((waiting - allowance).max(0)));
    for (key, value) in [
        ("flashcard_extra_new_day", day),
        ("flashcard_extra_new_count", granted.to_string()),
    ] {
        tx.execute("INSERT INTO metadata(key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", rusqlite::params![key,value]).map_err(|error| error.to_string())?;
    }
    tx.commit().map_err(|error| error.to_string())
}
