use crate::flashcard_models::{FlashcardDateCount, FlashcardStudyExperience};
use crate::flashcard_study_settings::extra_new_allowance;
use rusqlite::{params, Connection};

pub(super) fn read_experience(
    connection: &Connection,
    now: i64,
) -> Result<FlashcardStudyExperience, String> {
    let (timed_review_count, average_review_ms) = connection.query_row(
        "SELECT COUNT(*),AVG(elapsed_ms) FROM flashcard_reviews WHERE reviewed_at>=?1 AND reviewed_at<=?2 AND elapsed_ms>0 AND elapsed_ms<=300000",
        params![now-30*86400,now], |row| Ok((row.get(0)?,row.get(1)?)),
    ).map_err(|error| error.to_string())?;
    let next_due_at = connection.query_row(
        "SELECT MIN(due_at) FROM flashcards WHERE status='active' AND (repetitions>0 OR lapses>0) AND due_at>?1", [now], |row| row.get(0),
    ).map_err(|error| error.to_string())?;
    let mut statement = connection.prepare(
        "SELECT date(due_at,'unixepoch','localtime'),COUNT(*) FROM flashcards WHERE status='active' AND (repetitions>0 OR lapses>0) AND due_at>?1 AND date(due_at,'unixepoch','localtime')<date(?1,'unixepoch','localtime','+7 days') GROUP BY date(due_at,'unixepoch','localtime') ORDER BY due_at",
    ).map_err(|error| error.to_string())?;
    let future_due = statement
        .query_map([now], |row| {
            Ok(FlashcardDateCount {
                date: row.get(0)?,
                count: row.get(1)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let study_day = connection
        .query_row("SELECT date(?1,'unixepoch','localtime')", [now], |row| {
            row.get(0)
        })
        .map_err(|error| error.to_string())?;
    Ok(FlashcardStudyExperience {
        timed_review_count,
        average_review_ms,
        next_due_at,
        future_due,
        study_day,
        extra_new_allowance: extra_new_allowance(connection, now)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flashcard_study_settings::{
        effective_daily_limit, grant_extra_new_cards, read_flashcard_study_settings,
    };

    fn database() -> Connection {
        let connection = crate::initialize_database(&std::path::PathBuf::from(":memory:")).unwrap();
        connection
            .execute(
                "INSERT INTO flashcard_decks(id,name,created_at,updated_at) VALUES('a','A',1,1)",
                [],
            )
            .unwrap();
        for i in 0..8 {
            connection.execute("INSERT INTO flashcards(id,deck_id,question,answer,created_at,updated_at,due_at) VALUES(?1,'a','Question','Answer',1,1,1)", [format!("card-{i}")]).unwrap();
        }
        connection.execute("INSERT INTO metadata(key,value) VALUES('flashcard_daily_new_limit','5') ON CONFLICT(key) DO UPDATE SET value='5'", []).unwrap();
        connection
    }

    fn grant(connection: &mut Connection, target: i64, now: i64) -> Result<(), String> {
        let day = crate::flashcard_study_settings::study_day(connection, now)?;
        grant_extra_new_cards(connection, target, now, &day)
    }

    #[test]
    fn stale_day_request_is_rejected_without_granting_or_changing_preferences() {
        let mut c = database();
        let now = crate::now_timestamp();
        let stale_day = crate::flashcard_study_settings::study_day(&c, now - 86400).unwrap();
        let before = c.total_changes();
        assert!(grant_extra_new_cards(&mut c, 5, now, &stale_day)
            .unwrap_err()
            .contains("日期已变更"));
        assert_eq!(c.total_changes(), before);
        assert_eq!(extra_new_allowance(&c, now).unwrap(), 0);
        assert_eq!(read_flashcard_study_settings(&c).daily_new_limit, 5);
    }

    #[test]
    fn temporary_allowance_is_capped_idempotent_local_and_expires_without_changing_preferences() {
        let mut c = database();
        let now = crate::now_timestamp();
        grant(&mut c, 5, now).unwrap();
        assert_eq!(extra_new_allowance(&c, now).unwrap(), 3); // Only three beyond the regular quota are waiting.
        grant(&mut c, 3, now).unwrap();
        assert_eq!(effective_daily_limit(&c, now).unwrap(), 8);
        assert_eq!(extra_new_allowance(&c, now + 86400).unwrap(), 0);
        assert_eq!(effective_daily_limit(&c, now + 86400).unwrap(), 5);
        assert_eq!(read_flashcard_study_settings(&c).daily_new_limit, 5);
        assert_eq!(read_flashcard_study_settings(&c).updated_at, 0);
        assert!(grant(&mut c, 9, now).is_err());
        assert!(grant(&mut c, -1, now).is_err());
    }

    #[test]
    fn unlimited_or_no_waiting_cards_cannot_create_phantom_extra_quota() {
        let mut c = database();
        let now = crate::now_timestamp();
        c.execute(
            "UPDATE metadata SET value='0' WHERE key='flashcard_daily_new_limit'",
            [],
        )
        .unwrap();
        assert!(grant(&mut c, 1, now).is_err());
        c.execute(
            "UPDATE metadata SET value='50' WHERE key='flashcard_daily_new_limit'",
            [],
        )
        .unwrap();
        grant(&mut c, 5, now).unwrap();
        assert_eq!(extra_new_allowance(&c, now).unwrap(), 0);
    }

    #[test]
    fn review_plan_uses_shared_effective_quota_and_expiry() {
        let mut c = database();
        let now = crate::now_timestamp();
        grant(&mut c, 3, now).unwrap();
        let today =
            crate::flashcard_query::review_plan_details(&c, "a", 2, now, false, true).unwrap();
        assert_eq!(today["sessionCount"], 2);
        assert_eq!(today["eligibleCount"], 8);
        assert_eq!(today["newWaiting"], 0);
        let tomorrow =
            crate::flashcard_query::review_plan_details(&c, "a", 0, now + 86400, false, true)
                .unwrap();
        assert_eq!(tomorrow["eligibleCount"], 5);
        assert_eq!(tomorrow["newWaiting"], 3);
    }

    #[test]
    fn insight_reads_real_timing_and_only_active_learned_known_due_dates() {
        let c = database();
        let now = crate::now_timestamp();
        c.execute(
            "UPDATE flashcards SET repetitions=1,due_at=?1 WHERE id='card-0'",
            [now + 60],
        )
        .unwrap();
        c.execute(
            "UPDATE flashcards SET status='suspended',repetitions=1,due_at=?1 WHERE id='card-1'",
            [now + 10],
        )
        .unwrap();
        c.execute(
            "UPDATE flashcards SET due_at=?1 WHERE id='card-2'",
            [now + 20],
        )
        .unwrap();
        c.execute(
            "UPDATE flashcards SET repetitions=1,due_at=?1 WHERE id='card-3'",
            [now + 10 * 86400],
        )
        .unwrap();
        for (i, elapsed, when) in [
            (0, 20000, now),
            (1, 40000, now),
            (2, 0, now),
            (3, 300001, now),
            (4, 50000, now - 31 * 86400),
        ] {
            c.execute("INSERT INTO flashcard_reviews(id,card_id,rating,reviewed_at,previous_due_at,next_due_at,previous_interval_days,next_interval_days,elapsed_ms) VALUES(?1,'card-0',3,?2,1,2,0,1,?3)",params![format!("r-{i}"),when,elapsed]).unwrap();
        }
        let before = c.total_changes();
        let value = read_experience(&c, now).unwrap();
        assert_eq!(value.timed_review_count, 2);
        assert_eq!(value.average_review_ms, Some(30000.0));
        assert_eq!(value.next_due_at, Some(now + 60));
        assert_eq!(value.future_due.iter().map(|day| day.count).sum::<i64>(), 1);
        assert_eq!(c.total_changes(), before);
    }
}
