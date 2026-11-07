//! Durable shared flashcard revision and deletion facts.
use crate::flashcard_models::{Flashcard, FlashcardDraft};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::json;

pub(crate) fn mark_flashcard_sync_dirty(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO metadata (key,value) VALUES ('flashcard_sync_dirty','1')
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [],
        )
        .map_err(|error| format!("无法标记闪卡同步状态：{error}"))?;
    connection.execute("INSERT INTO metadata(key,value) VALUES('flashcard_sync_revision','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1",[]).map_err(|e|e.to_string())?;
    Ok(())
}

pub(crate) fn record_flashcard_tombstone(
    connection: &Connection,
    entity_type: &str,
    entity_id: &str,
    deleted_at: i64,
) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO flashcard_sync_tombstones(entity_type,entity_id,deleted_at)
             VALUES (?1,?2,?3)
             ON CONFLICT(entity_type,entity_id) DO UPDATE SET
               deleted_at=MAX(deleted_at,excluded.deleted_at)",
            params![entity_type, entity_id, deleted_at],
        )
        .map_err(|error| format!("无法记录闪卡删除状态：{error}"))?;
    Ok(())
}

pub(crate) fn install_flashcard_list_revision(connection: &Connection) -> Result<(), String> {
    // Card writes and source_changed dependencies invalidate pages in the same
    // transaction. Source lookups reuse flashcards_source's two-column prefix.
    let transaction = connection
        .unchecked_transaction()
        .map_err(|e| e.to_string())?;
    transaction.execute_batch(
        "INSERT OR IGNORE INTO metadata(key,value) VALUES('flashcard_list_revision','0');
         CREATE TRIGGER IF NOT EXISTS flashcard_list_inserted AFTER INSERT ON flashcards
         BEGIN
           UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='flashcard_list_revision';
         END;
         CREATE TRIGGER IF NOT EXISTS flashcard_list_updated AFTER UPDATE ON flashcards
         BEGIN
           UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='flashcard_list_revision';
         END;
         CREATE TRIGGER IF NOT EXISTS flashcard_list_deleted AFTER DELETE ON flashcards
         BEGIN
           UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='flashcard_list_revision';
         END;
         CREATE TRIGGER IF NOT EXISTS flashcard_source_inserted AFTER INSERT ON documents
         WHEN EXISTS(SELECT 1 FROM flashcards WHERE source_library_id=NEW.space_id AND source_document_id=NEW.id AND status IN ('active','suspended'))
         BEGIN
           UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='flashcard_list_revision';
         END;
         CREATE TRIGGER IF NOT EXISTS flashcard_source_updated AFTER UPDATE OF space_id,id,content_hash ON documents
         WHEN (OLD.space_id IS NOT NEW.space_id OR OLD.id IS NOT NEW.id OR OLD.content_hash IS NOT NEW.content_hash)
           AND (EXISTS(SELECT 1 FROM flashcards WHERE source_library_id=OLD.space_id AND source_document_id=OLD.id AND status IN ('active','suspended'))
             OR EXISTS(SELECT 1 FROM flashcards WHERE source_library_id=NEW.space_id AND source_document_id=NEW.id AND status IN ('active','suspended')))
         BEGIN
           UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='flashcard_list_revision';
         END;
         CREATE TRIGGER IF NOT EXISTS flashcard_source_deleted AFTER DELETE ON documents
         WHEN EXISTS(SELECT 1 FROM flashcards WHERE source_library_id=OLD.space_id AND source_document_id=OLD.id AND status IN ('active','suspended'))
         BEGIN
           UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='flashcard_list_revision';
         END;"
    ).map_err(|error| format!("无法初始化闪卡列表版本：{error}"))?;
    transaction.commit().map_err(|e| e.to_string())
}

pub(crate) fn flashcard_from_row(row: &Row<'_>) -> rusqlite::Result<Flashcard> {
    let media_json = row.get::<_, String>(12)?;
    Ok(Flashcard {
        id: row.get(0)?,
        deck_id: row.get(1)?,
        question: row.get(2)?,
        answer: row.get(3)?,
        explanation: row.get(4)?,
        card_type: row.get(5)?,
        card_data: serde_json::from_str(&row.get::<_, String>(21)?).unwrap_or_else(|_| json!({})),
        source_library_id: row.get(6)?,
        source_document_id: row.get(7)?,
        source_block_id: row.get(8)?,
        source_title: row.get(9)?,
        source_path: row.get(10)?,
        source_hash: row.get(11)?,
        media: serde_json::from_str(&media_json).unwrap_or_else(|_| json!([])),
        created_at: row.get(13)?,
        updated_at: row.get(14)?,
        due_at: row.get(15)?,
        interval_days: row.get(16)?,
        ease: row.get(17)?,
        repetitions: row.get(18)?,
        lapses: row.get(19)?,
        status: row.get(27)?,
        source_changed: row.get::<_, i64>(20)? != 0,
        tags: serde_json::from_str(&row.get::<_, String>(22)?).unwrap_or_else(|_| json!([])),
        evidence: row.get(23)?,
        confidence: row.get(24)?,
        custom_fields: serde_json::from_str(&row.get::<_, String>(25)?)
            .unwrap_or_else(|_| json!({})),
        generation: serde_json::from_str(&row.get::<_, String>(26)?).unwrap_or_else(|_| json!({})),
    })
}

pub(crate) fn flashcard_by_id(connection: &Connection, card_id: &str) -> Result<Flashcard, String> {
    connection
        .query_row(
            &format!(
                "SELECT {FLASHCARD_SELECT_FIELDS} FROM flashcards WHERE id=?1 AND status IN ('active','suspended')"
            ),
            params![card_id],
            flashcard_from_row,
        )
        .optional()
        .map_err(|error| format!("无法读取闪卡：{error}"))?
        .ok_or_else(|| "闪卡不存在或已删除".to_string())
}

pub(crate) fn read_flashcards_by_ids(
    connection: &Connection,
    card_ids: &[String],
) -> Result<Vec<Flashcard>, String> {
    if card_ids.len() > 200 {
        return Err("每次最多读取 200 张闪卡".into());
    }
    if card_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = vec!["?"; card_ids.len()].join(",");
    let mut statement = connection.prepare(&format!("SELECT {FLASHCARD_SELECT_FIELDS} FROM flashcards WHERE id IN ({placeholders}) AND status IN ('active','suspended')")).map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(
            rusqlite::params_from_iter(card_ids.iter()),
            flashcard_from_row,
        )
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub(crate) const FLASHCARD_SELECT_FIELDS: &str =
    "id,deck_id,question,answer,explanation,card_type,source_library_id,source_document_id,source_block_id,source_title,source_path,source_hash,media_json,created_at,updated_at,due_at,interval_days,ease,repetitions,lapses,
     CASE WHEN source_document_id<>'' AND EXISTS (
       SELECT 1 FROM documents d WHERE d.space_id=flashcards.source_library_id AND d.id=flashcards.source_document_id
         AND d.content_hash<>flashcards.source_hash
     ) THEN 1 ELSE 0 END,card_data_json,tags_json,evidence,confidence,custom_fields_json,generation_json,status";

pub(crate) fn flashcard_draft_from_row(row: &Row<'_>) -> rusqlite::Result<FlashcardDraft> {
    let media_json: String = row.get(13)?;
    let tags_json: String = row.get(14)?;
    let generation_json: String = row.get(17)?;
    Ok(FlashcardDraft {
        id: row.get(0)?,
        batch_id: row.get(1)?,
        deck_name: row.get(2)?,
        question: row.get(3)?,
        answer: row.get(4)?,
        explanation: row.get(5)?,
        card_type: row.get(6)?,
        card_data: serde_json::from_str(&row.get::<_, String>(20)?).unwrap_or_else(|_| json!({})),
        source_library_id: row.get(7)?,
        source_document_id: row.get(8)?,
        source_block_id: row.get(9)?,
        source_title: row.get(10)?,
        source_path: row.get(11)?,
        source_hash: row.get(12)?,
        media: serde_json::from_str(&media_json).unwrap_or_else(|_| json!([])),
        tags: serde_json::from_str(&tags_json).unwrap_or_else(|_| json!([])),
        custom_fields: serde_json::from_str(&row.get::<_, String>(21)?)
            .unwrap_or_else(|_| json!({})),
        evidence: row.get(15)?,
        confidence: row.get(16)?,
        generation: serde_json::from_str(&generation_json).unwrap_or_else(|_| json!({})),
        idempotency_key: row.get(18)?,
        created_at: row.get(19)?,
    })
}

pub(crate) const FLASHCARD_DRAFT_SELECT_FIELDS: &str =
    "id,batch_id,deck_name,question,answer,explanation,card_type,source_library_id,source_document_id,source_block_id,source_title,source_path,source_hash,media_json,tags_json,evidence,confidence,generation_json,idempotency_key,created_at,card_data_json,custom_fields_json";
