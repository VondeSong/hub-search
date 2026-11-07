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
