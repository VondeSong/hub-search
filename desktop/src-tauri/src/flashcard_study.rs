//! Flashcard study settings, status projections and review command orchestration.
use crate::flashcard_models::*;
use crate::flashcard_snapshot::restore_flashcard_after_review_delete;
use crate::flashcard_store::{
    flashcard_by_id, flashcard_from_row, mark_flashcard_sync_dirty, read_flashcards_by_ids,
    FLASHCARD_SELECT_FIELDS,
};
use crate::flashcard_study_settings::{flashcard_new_studied_today, read_flashcard_study_settings};
use crate::{
    database_path, flashcard_query, flashcard_scheduler, now_timestamp, open_database,
    open_write_database, record_flashcard_tombstone,
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::collections::HashSet;
use tauri::AppHandle;

#[path = "flashcard_study_experience.rs"]
mod experience;

#[tauri::command]
pub(crate) fn get_flashcard_study_settings(
    app: AppHandle,
) -> Result<FlashcardStudySettings, String> {
    let connection = open_database(&database_path(&app)?)?;
    Ok(read_flashcard_study_settings(&connection))
}

#[tauri::command]
pub(crate) fn update_flashcard_study_settings(
    app: AppHandle,
    daily_new_limit: i64,
    extra_new_count: Option<i64>,
    extra_new_day: Option<String>,
) -> Result<FlashcardStudySettings, String> {
    if !matches!(daily_new_limit, 0 | 5 | 10 | 20 | 50) {
        return Err("每日新卡额度只能设为不限、5、10、20 或 50 张".to_string());
    }
    let (mut connection, _writer) = open_write_database(&database_path(&app)?)?;
    let current = read_flashcard_study_settings(&connection);
    if let Some(target) = extra_new_count {
        if current.daily_new_limit != daily_new_limit {
            return Err("每日偏好已变更，请刷新后重试临时额度".into());
        }
        crate::flashcard_study_settings::grant_extra_new_cards(
            &mut connection,
            target,
            now_timestamp(),
            extra_new_day
                .as_deref()
                .ok_or("请刷新今日计划后再增加临时额度")?,
        )?;
        return Ok(current);
    }
    if current.daily_new_limit == daily_new_limit {
        return Ok(current);
    }
    let updated_at = chrono::Utc::now()
        .timestamp_millis()
        .max(current.updated_at + 1);
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开始更新闪卡学习设置：{error}"))?;
    for (key, value) in [
        ("flashcard_daily_new_limit", daily_new_limit),
        ("flashcard_daily_new_limit_updated_at", updated_at),
    ] {
        transaction
            .execute(
                "INSERT INTO metadata(key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![key, value.to_string()],
            )
            .map_err(|error| format!("无法保存闪卡学习设置：{error}"))?;
    }
    mark_flashcard_sync_dirty(&transaction)?;
    transaction
        .commit()
        .map_err(|error| format!("无法提交闪卡学习设置：{error}"))?;
    Ok(FlashcardStudySettings {
        daily_new_limit,
        updated_at,
    })
}

#[tauri::command]
pub(crate) fn get_flashcard_dashboard_stats(
    app: AppHandle,
) -> Result<FlashcardDashboardStats, String> {
    let connection = open_database(&database_path(&app)?)?;
    let now = now_timestamp();
    let (total_cards, due_cards, new_due_cards, new_cards, learning_cards, mastered_cards, suspended_cards) = connection
        .query_row(
            "SELECT COUNT(*),
                    COALESCE(SUM(CASE WHEN status='active' AND due_at<=?1 THEN 1 ELSE 0 END),0),
                    COALESCE(SUM(CASE WHEN status='active' AND repetitions=0 AND lapses=0 AND due_at<=?1 THEN 1 ELSE 0 END),0),
                    COALESCE(SUM(CASE WHEN status='active' AND repetitions=0 AND lapses=0 THEN 1 ELSE 0 END),0),
                    COALESCE(SUM(CASE WHEN status='active' AND (repetitions=0 AND lapses>0 OR repetitions>0 AND interval_days<21) THEN 1 ELSE 0 END),0),
                    COALESCE(SUM(CASE WHEN status='active' AND repetitions>0 AND interval_days>=21 THEN 1 ELSE 0 END),0),
                    COALESCE(SUM(CASE WHEN status='suspended' THEN 1 ELSE 0 END),0)
             FROM flashcards WHERE status IN ('active','suspended')",
            params![now],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .map_err(|error| format!("无法读取闪卡统计：{error}"))?;
    let new_studied_today = flashcard_new_studied_today(&connection)?;
    let (total_reviews, reviewed_today, retained_reviews) = connection
        .query_row(
            "SELECT COUNT(*),
                    COALESCE(SUM(CASE WHEN date(reviewed_at,'unixepoch','localtime')=date('now','localtime') THEN 1 ELSE 0 END),0),
                    COALESCE(SUM(CASE WHEN rating>=3 THEN 1 ELSE 0 END),0)
             FROM flashcard_reviews",
            [],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?)),
        )
        .map_err(|error| format!("无法读取复习统计：{error}"))?;
    let mut rating_counts = [0_i64; 4];
    {
        let mut statement = connection
            .prepare("SELECT rating,COUNT(*) FROM flashcard_reviews GROUP BY rating")
            .map_err(|error| format!("无法准备评分统计：{error}"))?;
        let rows = statement
            .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))
            .map_err(|error| format!("无法读取评分统计：{error}"))?;
        for row in rows {
            let (rating, count) = row.map_err(|error| format!("无法收集评分统计：{error}"))?;
            if (1..=4).contains(&rating) {
                rating_counts[(rating - 1) as usize] = count;
            }
        }
    }
    let daily_activity = {
        let since = now - 370 * 86_400;
        let mut statement = connection
            .prepare(
                "SELECT date(reviewed_at,'unixepoch','localtime'),COUNT(*)
                 FROM flashcard_reviews WHERE reviewed_at>=?1
                 GROUP BY date(reviewed_at,'unixepoch','localtime') ORDER BY reviewed_at",
            )
            .map_err(|error| format!("无法准备每日复习统计：{error}"))?;
        let rows = statement
            .query_map(params![since], |row| {
                Ok(FlashcardDateCount {
                    date: row.get(0)?,
                    count: row.get(1)?,
                })
            })
            .map_err(|error| format!("无法读取每日复习统计：{error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("无法收集每日复习统计：{error}"))?
    };
    Ok(FlashcardDashboardStats {
        total_cards,
        due_cards,
        new_due_cards,
        new_cards,
        learning_cards,
        mastered_cards,
        suspended_cards,
        new_studied_today,
        total_reviews,
        reviewed_today,
        retention_rate: if total_reviews > 0 {
            retained_reviews as f64 / total_reviews as f64
        } else {
            0.0
        },
        rating_counts,
        daily_activity,
        experience: experience::read_experience(&connection, now)?,
    })
}

#[tauri::command]
pub(crate) fn list_flashcards_page(
    app: AppHandle,
    deck_id: Option<String>,
    due_only: Option<bool>,
    offset: usize,
    limit: usize,
    revision: Option<String>,
    as_of: Option<i64>,
    query: Option<flashcard_query::Query>,
    include_metadata: Option<bool>,
) -> Result<Value, String> {
    let connection = open_database(&database_path(&app)?)?;
    flashcard_query::read_page(
        &connection,
        deck_id.as_deref().unwrap_or(""),
        due_only.unwrap_or(false),
        query.as_ref(),
        offset,
        limit,
        revision.as_deref(),
        as_of.unwrap_or_else(now_timestamp),
        include_metadata.unwrap_or(false),
    )
}

#[tauri::command]
pub(crate) fn list_flashcard_selection_ids(
    app: AppHandle,
    deck_id: Option<String>,
    due_only: Option<bool>,
    query: flashcard_query::Query,
    offset: usize,
    limit: usize,
    revision: Option<String>,
    as_of: Option<i64>,
) -> Result<Value, String> {
    let connection = open_database(&database_path(&app)?)?;
    flashcard_query::selection_ids(
        &connection,
        deck_id.as_deref().unwrap_or(""),
        due_only.unwrap_or(false),
        &query,
        offset,
        limit,
        revision.as_deref(),
        as_of.unwrap_or_else(now_timestamp),
    )
}

#[tauri::command]
pub(crate) fn flashcard_review_plan(
    app: AppHandle,
    deck_id: Option<String>,
    session_limit: usize,
    as_of: Option<i64>,
    include_subdecks: Option<bool>,
    include_session_ids: Option<bool>,
) -> Result<Value, String> {
    let connection = open_database(&database_path(&app)?)?;
    flashcard_query::review_plan_details(
        &connection,
        deck_id.as_deref().unwrap_or(""),
        session_limit,
        as_of.unwrap_or_else(now_timestamp),
        include_subdecks.unwrap_or(false),
        include_session_ids.unwrap_or(true),
    )
}

#[tauri::command]
pub(crate) fn list_flashcards(
    app: AppHandle,
    deck_id: Option<String>,
    due_only: Option<bool>,
) -> Result<Vec<Flashcard>, String> {
    let connection = open_database(&database_path(&app)?)?;
    let deck_id = deck_id.unwrap_or_default();
    let due_only = due_only.unwrap_or(false);
    let now = now_timestamp();
    let sql = format!(
        "SELECT {FLASHCARD_SELECT_FIELDS} FROM flashcards
         WHERE (status='active' OR (?2=0 AND status='suspended'))
           AND (?1='' OR deck_id=?1) AND (?2=0 OR due_at<=?3)
         ORDER BY CASE WHEN due_at<=?3 THEN 0 ELSE 1 END,due_at,created_at DESC LIMIT 1000"
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("无法准备闪卡列表：{error}"))?;
    let rows = statement
        .query_map(
            params![deck_id, if due_only { 1 } else { 0 }, now],
            flashcard_from_row,
        )
        .map_err(|error| format!("无法读取闪卡列表：{error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法收集闪卡列表：{error}"))
}

#[tauri::command]
pub(crate) fn flashcard_quality_report(
    app: AppHandle,
    deck_id: Option<String>,
) -> Result<Value, String> {
    let connection = open_database(&database_path(&app)?)?;
    let deck_id = deck_id.unwrap_or_default();
    let mut statement = connection
        .prepare(
            "SELECT question,answer,card_type,source_library_id,source_document_id,source_title,source_path,confidence
             FROM flashcards WHERE status IN ('active','suspended') AND (?1='' OR deck_id=?1)",
        )
        .map_err(|error| format!("无法准备闪卡质量报告：{error}"))?;
    let rows = statement
        .query_map(params![deck_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, Option<f64>>(7)?,
            ))
        })
        .map_err(|error| format!("无法读取闪卡质量报告：{error}"))?;
    let mut total = 0usize;
    let mut source_covered = 0usize;
    let mut low_confidence = 0usize;
    let mut unknown_confidence = 0usize;
    let mut unique_cards = HashSet::new();
    let mut sources = HashSet::new();
    let mut type_distribution = serde_json::Map::new();
    for row in rows {
        let (
            question,
            answer,
            card_type,
            library_id,
            document_id,
            source_title,
            source_path,
            confidence,
        ) = row.map_err(|error| format!("无法解析闪卡质量报告：{error}"))?;
        total += 1;
        let has_source =
            !document_id.is_empty() || !source_title.is_empty() || !source_path.is_empty();
        if has_source {
            source_covered += 1;
            sources.insert(format!("{library_id}\n{document_id}\n{source_path}"));
        }
        match confidence {
            Some(value) if value < 0.7 => low_confidence += 1,
            None => unknown_confidence += 1,
            _ => {}
        }
        let normalized = format!(
            "{}\n{}",
            question
                .to_lowercase()
                .split_whitespace()
                .collect::<String>(),
            answer.to_lowercase().split_whitespace().collect::<String>()
        );
        unique_cards.insert(normalized);
        let count = type_distribution.entry(card_type).or_insert(json!(0));
        *count = json!(count.as_u64().unwrap_or(0) + 1);
    }
    let duplicates = total.saturating_sub(unique_cards.len());
    Ok(json!({
        "totalCards": total,
        "sourceCoveredCards": source_covered,
        "sourceCoverage": if total == 0 { 0.0 } else { source_covered as f64 / total as f64 },
        "sourceCount": sources.len(),
        "duplicateCards": duplicates,
        "duplicateRate": if total == 0 { 0.0 } else { duplicates as f64 / total as f64 },
        "lowConfidenceCards": low_confidence,
        "unknownConfidenceCards": unknown_confidence,
        "cardTypeDistribution": type_distribution,
    }))
}

#[tauri::command]
pub(crate) fn set_flashcard_stage(
    app: AppHandle,
    card_id: String,
    stage: String,
) -> Result<Flashcard, String> {
    let (connection, _writer) = open_write_database(&database_path(&app)?)?;
    let existing = flashcard_by_id(&connection, &card_id)?;
    let now = now_timestamp();
    if stage == "suspended" || stage == "resume" {
        let status = if stage == "suspended" {
            "suspended"
        } else {
            "active"
        };
        connection
            .execute(
                "UPDATE flashcards SET status=?1,updated_at=?2 WHERE id=?3 AND status IN ('active','suspended')",
                params![status, now, card_id],
            )
            .map_err(|error| format!("无法更新闪卡暂停状态：{error}"))?;
        connection
            .execute(
                "UPDATE flashcard_decks SET updated_at=?1 WHERE id=?2",
                params![now, existing.deck_id],
            )
            .map_err(|error| format!("无法更新闪卡牌组：{error}"))?;
        mark_flashcard_sync_dirty(&connection)?;
        return flashcard_by_id(&connection, &card_id);
    }
    let (due_at, interval_days, repetitions) = match stage.as_str() {
        "new" => (now, 0.0, 0),
        "due" => (
            now,
            existing.interval_days.max(1.0),
            existing.repetitions.max(1),
        ),
        "learning" => (now + 86_400, 1.0, existing.repetitions.max(1)),
        "mastered" => (
            now + 30 * 86_400,
            existing.interval_days.max(30.0),
            existing.repetitions.max(3),
        ),
        _ => return Err("不支持的学习状态".to_string()),
    };
    connection
        .execute(
            "UPDATE flashcards SET status='active',due_at=?1,interval_days=?2,repetitions=?3,lapses=?4,updated_at=?5 WHERE id=?6 AND status IN ('active','suspended')",
            params![due_at, interval_days, repetitions, if stage == "new" { 0 } else { existing.lapses }, now, card_id],
        )
        .map_err(|error| format!("无法更新闪卡状态：{error}"))?;
    connection
        .execute(
            "UPDATE flashcard_decks SET updated_at=?1 WHERE id=?2",
            params![now, existing.deck_id],
        )
        .map_err(|error| format!("无法更新闪卡牌组：{error}"))?;
    mark_flashcard_sync_dirty(&connection)?;
    flashcard_by_id(&connection, &card_id)
}

pub(crate) fn legacy_scheduled_flashcard_values(
    rating: i64,
    interval_days: f64,
    ease: f64,
    repetitions: i64,
    lapses: i64,
    now: i64,
) -> (i64, f64, f64, i64, i64) {
    match rating {
        1 => (now + 10 * 60, 0.0, (ease - 0.2).max(1.3), 0, lapses + 1),
        2 => {
            let interval = if interval_days < 1.0 {
                1.0
            } else {
                (interval_days * 1.2).max(1.0)
            };
            (
                now + (interval * 86_400.0).round() as i64,
                interval,
                (ease - 0.15).max(1.3),
                repetitions + 1,
                lapses,
            )
        }
        4 => {
            let interval = if repetitions == 0 {
                4.0
            } else {
                (interval_days.max(1.0) * ease * 1.3).max(4.0)
            };
            (
                now + (interval * 86_400.0).round() as i64,
                interval,
                (ease + 0.15).min(3.2),
                repetitions + 1,
                lapses,
            )
        }
        _ => {
            let interval = if repetitions == 0 {
                1.0
            } else if repetitions == 1 {
                3.0
            } else {
                (interval_days.max(1.0) * ease).max(1.0)
            };
            (
                now + (interval * 86_400.0).round() as i64,
                interval,
                ease,
                repetitions + 1,
                lapses,
            )
        }
    }
}

#[tauri::command]
pub(crate) fn review_flashcard(
    app: AppHandle,
    card_id: String,
    rating: i64,
    elapsed_ms: Option<i64>,
    expected_review_key: String,
) -> Result<FlashcardReviewResult, String> {
    if !(1..=4).contains(&rating) {
        return Err("复习评分必须在 1 到 4 之间".to_string());
    }
    let (connection, _writer) = open_write_database(&database_path(&app)?)?;
    let current = flashcard_by_id(&connection, &card_id)?;
    if current.status != "active" {
        return Err("这张闪卡已暂停学习，请先恢复".to_string());
    }
    if current.repetitions == 0 && current.lapses == 0 {
        let daily_limit =
            crate::flashcard_study_settings::effective_daily_limit(&connection, now_timestamp())?;
        if daily_limit > 0 && flashcard_new_studied_today(&connection)? >= daily_limit {
            let started_today = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM flashcard_reviews
                     WHERE card_id=?1 AND date(reviewed_at,'unixepoch','localtime')=date('now','localtime')
                       AND previous_repetitions=0 AND previous_lapses=0)",
                    params![card_id],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(|error| format!("无法检查新卡学习额度：{error}"))?;
            if !started_today {
                return Err("今日新卡额度已用完，请明天继续或调整每日新卡额度".to_string());
            }
        }
    }
    flashcard_scheduler::commit(
        &connection,
        &card_id,
        rating,
        elapsed_ms,
        &expected_review_key,
        now_timestamp(),
    )
}

#[tauri::command]
pub(crate) fn undo_flashcard_review(
    app: AppHandle,
    card_id: String,
    review_id: String,
) -> Result<Flashcard, String> {
    let (mut connection, _writer) = open_write_database(&database_path(&app)?)?;
    let latest = connection
        .query_row(
            "SELECT id FROM flashcard_reviews WHERE card_id=?1 ORDER BY reviewed_at DESC,id DESC LIMIT 1",
            params![card_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("无法检查最近一次评分：{error}"))?;
    if latest.as_deref() != Some(review_id.as_str()) {
        return Err("只能撤销这张卡片最近一次保存的评分".to_string());
    }
    let now = now_timestamp();
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开始撤销评分：{error}"))?;
    let restored_card_id = restore_flashcard_after_review_delete(&transaction, &review_id, now)?
        .ok_or_else(|| "这条评分已不存在，可能已在其他设备撤销".to_string())?;
    if restored_card_id != card_id {
        return Err("评分记录与当前卡片不匹配".to_string());
    }
    record_flashcard_tombstone(&transaction, "review", &review_id, now)?;
    mark_flashcard_sync_dirty(&transaction)?;
    transaction
        .commit()
        .map_err(|error| format!("无法提交评分撤销：{error}"))?;
    flashcard_by_id(&connection, &card_id)
}

#[tauri::command]
pub(crate) fn get_flashcards_by_ids(
    app: AppHandle,
    card_ids: Vec<String>,
) -> Result<Vec<Flashcard>, String> {
    let connection = open_database(&database_path(&app)?)?;
    read_flashcards_by_ids(&connection, &card_ids)
}
