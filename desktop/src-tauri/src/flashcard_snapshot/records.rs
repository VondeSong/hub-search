//! One canonical row mapper shared by full export and incremental cloud consumers.
use crate::flashcard_store::FLASHCARD_DRAFT_SELECT_FIELDS;
use crate::flashcard_study_settings::read_flashcard_study_settings;

use crate::{
    flashcard_profiles, flashcard_review_log, flashcard_sync_drafts, now_timestamp,
    FlashcardSnapshotCard, FlashcardSnapshotDeck, FlashcardSnapshotFolder, FlashcardSnapshotReview,
    FlashcardSnapshotTombstone, FlashcardStudySettings, FlashcardSyncSnapshot,
};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use std::collections::HashSet;

pub(crate) const FIELDS: [&str; 8] = [
    "folders",
    "tombstones",
    "decks",
    "cards",
    "reviews",
    "qualityRecords",
    "drafts",
    "schedulerProfiles",
];
pub(crate) const TABLES: [(&str, &str); 8] = [
    ("folders", "flashcard_deck_folders"),
    ("tombstones", "flashcard_sync_tombstones"),
    ("decks", "flashcard_decks"),
    ("cards", "flashcards"),
    ("reviews", "flashcard_review_events"),
    ("qualityRecords", "flashcard_quality_records"),
    ("drafts", "flashcard_drafts"),
    ("schedulerProfiles", "flashcard_scheduler_profiles"),
];
const CARD_COLUMNS: &str = "id,deck_id,question,answer,explanation,card_type,source_library_id,source_document_id,source_block_id,source_title,source_path,source_hash,media_json,status,created_at,updated_at,due_at,interval_days,ease,repetitions,lapses,card_data_json,tags_json,evidence,confidence,custom_fields_json,generation_json,fsrs_state_json";

pub(crate) fn identity(field: &str, value: &Value) -> String {
    if field == "tombstones" {
        format!("{}:{}", value["entityType"], value["entityId"])
    } else {
        value["id"].to_string()
    }
}

/// Version 5 marks hierarchy-bearing data, so released clients fail safely instead
/// of dropping parent edges during their next write. Flat data keeps version 4.
pub(crate) fn wire_version(c: &Connection) -> Result<i64, String> {
    let hierarchy: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM flashcard_decks WHERE parent_deck_id>'')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(if hierarchy { 5 } else { 4 })
}
pub(crate) fn empty(c: &Connection) -> Result<FlashcardSyncSnapshot, String> {
    Ok(FlashcardSyncSnapshot {
        version: wire_version(c)?,
        device_id: super::flashcard_sync_device_id(c)?,
        exported_at: now_timestamp(),
        folders: Vec::new(),
        tombstones: Vec::new(),
        decks: Vec::new(),
        cards: Vec::new(),
        reviews: Vec::new(),
        quality_records: Vec::new(),
        drafts: Vec::new(),
        scheduler_profiles: Vec::new(),
        study_settings: None,
    })
}

pub(crate) fn study(c: &Connection) -> Option<FlashcardStudySettings> {
    let value = read_flashcard_study_settings(c);
    (value.updated_at > 0).then_some(value)
}

pub(crate) fn card_from_row(row: &Row<'_>) -> rusqlite::Result<FlashcardSnapshotCard> {
    Ok(FlashcardSnapshotCard {
        id: row.get(0)?,
        deck_id: row.get(1)?,
        question: row.get(2)?,
        answer: row.get(3)?,
        explanation: row.get(4)?,
        card_type: row.get(5)?,
        card_data_json: row.get(21)?,
        source_library_id: row.get(6)?,
        source_document_id: row.get(7)?,
        source_block_id: row.get(8)?,
        source_title: row.get(9)?,
        source_path: row.get(10)?,
        source_hash: row.get(11)?,
        media_json: row.get(12)?,
        tags_json: row.get(22)?,
        evidence: row.get(23)?,
        confidence: row.get(24)?,
        custom_fields_json: row.get(25)?,
        generation_json: row.get(26)?,
        fsrs_state_json: row.get(27)?,
        status: row.get(13)?,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
        due_at: row.get(16)?,
        interval_days: row.get(17)?,
        ease: row.get(18)?,
        repetitions: row.get(19)?,
        lapses: row.get(20)?,
    })
}

fn value<T: Serialize>(item: T) -> rusqlite::Result<Value> {
    serde_json::to_value(item).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}

fn parsed<T: DeserializeOwned>(raw: &str) -> rusqlite::Result<T> {
    serde_json::from_str(raw).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}

fn row_value(field: &str, row: &Row<'_>) -> rusqlite::Result<Value> {
    match field {
        "folders" => value(FlashcardSnapshotFolder {
            id: row.get(0)?,
            name: row.get(1)?,
            sort_order: row.get(2)?,
            created_at: row.get(3)?,
            updated_at: row.get(4)?,
        }),
        "decks" => value(FlashcardSnapshotDeck {
            parent_deck_id: row.get(6)?,
            id: row.get(0)?,
            name: row.get(1)?,
            folder_id: row.get(2)?,
            sort_order: row.get(3)?,
            created_at: row.get(4)?,
            updated_at: row.get(5)?,
        }),
        "tombstones" => value(FlashcardSnapshotTombstone {
            entity_type: row.get(0)?,
            entity_id: row.get(1)?,
            deleted_at: row.get(2)?,
        }),
        "cards" => value(card_from_row(row)?),
        "drafts" => value(flashcard_sync_drafts::from_row(row)?),
        "reviews" => {
            let raw: String = row.get(0)?;
            value(flashcard_review_log::normalize(&parsed::<
                FlashcardSnapshotReview,
            >(&raw)?))
        }
        "schedulerProfiles" => value(parsed::<flashcard_profiles::Profile>(
            &row.get::<_, String>(0)?,
        )?),
        "qualityRecords" => parsed(&row.get::<_, String>(0)?),
        _ => Err(rusqlite::Error::InvalidParameterName(field.into())),
    }
}

fn select(field: &str) -> Result<(String, &'static str), String> {
    Ok(match field {
        "folders" => (
            "SELECT id,name,sort_order,created_at,updated_at FROM flashcard_deck_folders".into(),
            "id",
        ),
        "decks" => (
            "SELECT id,name,folder_id,sort_order,created_at,updated_at,parent_deck_id FROM flashcard_decks".into(),
            "id",
        ),
        "tombstones" => (
            "SELECT entity_type,entity_id,deleted_at FROM flashcard_sync_tombstones".into(),
            "entity_type,entity_id",
        ),
        "cards" => (format!("SELECT {CARD_COLUMNS} FROM flashcards"), "id"),
        "reviews" => (
            "SELECT payload_json FROM flashcard_review_events".into(),
            "reviewed_at,id",
        ),
        "drafts" => (
            format!(
                "SELECT {FLASHCARD_DRAFT_SELECT_FIELDS},status,updated_at FROM flashcard_drafts"
            ),
            "id",
        ),
        "qualityRecords" => (
            "SELECT payload_json FROM flashcard_quality_records".into(),
            "id",
        ),
        "schedulerProfiles" => (
            "SELECT payload_json FROM flashcard_scheduler_profiles".into(),
            "id",
        ),
        _ => return Err("同步记录域无效".into()),
    })
}

pub(crate) fn visit(
    c: &Connection,
    field: &str,
    mut consumer: impl FnMut(Value) -> Result<(), String>,
) -> Result<(), String> {
    let (query, order) = select(field)?;
    let mut statement = c
        .prepare(&format!("{query} ORDER BY {order}"))
        .map_err(|e| e.to_string())?;
    let mut rows = statement.query([]).map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        consumer(row_value(field, row).map_err(|e| e.to_string())?)?;
    }
    Ok(())
}

pub(crate) fn local(c: &Connection, field: &str, key: &str) -> Result<Option<Value>, String> {
    if field == "studySettings" {
        return serde_json::to_value(study(c))
            .map(Some)
            .map_err(|e| e.to_string());
    }
    let (query, _) = select(field)?;
    if field == "tombstones" {
        let mut values = serde_json::Deserializer::from_str(key).into_iter::<String>();
        let kind = values
            .next()
            .ok_or("删除状态身份无效")?
            .map_err(|e| e.to_string())?;
        let offset = values.byte_offset();
        let rest = key
            .get(offset..)
            .and_then(|v| v.strip_prefix(':'))
            .ok_or("删除状态身份无效")?;
        let id: String = serde_json::from_str(rest).map_err(|e| e.to_string())?;
        c.query_row(
            &format!("{query} WHERE entity_type=?1 AND entity_id=?2"),
            params![kind, id],
            |row| row_value(field, row),
        )
        .optional()
        .map_err(|e| e.to_string())
    } else {
        let id: String = serde_json::from_str(key).map_err(|e| e.to_string())?;
        c.query_row(&format!("{query} WHERE id=?1"), [id], |row| {
            row_value(field, row)
        })
        .optional()
        .map_err(|e| e.to_string())
    }
}

pub(crate) fn normalize(field: &str, item: Value) -> Result<Value, String> {
    fn normalized<T: DeserializeOwned + Serialize>(value: Value) -> Result<Value, String> {
        serde_json::from_value::<T>(value)
            .and_then(serde_json::to_value)
            .map_err(|e| e.to_string())
    }
    match field {
        "folders" => normalized::<FlashcardSnapshotFolder>(item),
        "decks" => normalized::<FlashcardSnapshotDeck>(item),
        "cards" => normalized::<FlashcardSnapshotCard>(item),
        "reviews" => normalized::<FlashcardSnapshotReview>(item),
        "tombstones" => normalized::<FlashcardSnapshotTombstone>(item),
        "drafts" => normalized::<flashcard_sync_drafts::SnapshotDraft>(item),
        "schedulerProfiles" => normalized::<flashcard_profiles::Profile>(item),
        "qualityRecords" => Ok(item),
        "studySettings" => normalized::<Option<FlashcardStudySettings>>(item),
        _ => Err("同步记录域无效".into()),
    }
}

fn append(snapshot: &mut FlashcardSyncSnapshot, field: &str, value: Value) -> Result<(), String> {
    match field {
        "folders" => snapshot
            .folders
            .push(serde_json::from_value(value).map_err(|e| e.to_string())?),
        "decks" => snapshot
            .decks
            .push(serde_json::from_value(value).map_err(|e| e.to_string())?),
        "tombstones" => snapshot
            .tombstones
            .push(serde_json::from_value(value).map_err(|e| e.to_string())?),
        "cards" => snapshot
            .cards
            .push(serde_json::from_value(value).map_err(|e| e.to_string())?),
        "reviews" => snapshot
            .reviews
            .push(serde_json::from_value(value).map_err(|e| e.to_string())?),
        "drafts" => snapshot
            .drafts
            .push(serde_json::from_value(value).map_err(|e| e.to_string())?),
        "schedulerProfiles" => snapshot
            .scheduler_profiles
            .push(serde_json::from_value(value).map_err(|e| e.to_string())?),
        "qualityRecords" => snapshot.quality_records.push(value),
        _ => return Err("同步记录域无效".into()),
    }
    Ok(())
}

pub(crate) fn snapshot(c: &Connection) -> Result<FlashcardSyncSnapshot, String> {
    let mut result = empty(c)?;
    for field in FIELDS {
        visit(c, field, |value| append(&mut result, field, value))?;
    }
    result.study_settings = study(c);
    Ok(result)
}

pub(crate) fn cards_for_merge(
    c: &Connection,
    cards: &[FlashcardSnapshotCard],
) -> Result<Vec<FlashcardSnapshotCard>, String> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for card in cards {
        if !seen.insert(card.id.as_str()) {
            continue;
        }
        if let Some(value) = local(
            c,
            "cards",
            &serde_json::to_string(&card.id).map_err(|e| e.to_string())?,
        )? {
            result.push(serde_json::from_value(value).map_err(|e| e.to_string())?);
        }
    }
    Ok(result)
}

/// Hash the canonical content identity without a complete snapshot or JSON tree.
pub(crate) fn content_hash(c: &Connection) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use std::io::Write;
    struct Sink(Sha256);
    impl Write for Sink {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.update(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    // Use the configured serde_json Map order, matching to_value(snapshot)
    // whether its feature-unified map uses sorted or insertion order.
    let mut keys = serde_json::Map::new();
    for field in [
        "version",
        "folders",
        "tombstones",
        "decks",
        "cards",
        "reviews",
        "studySettings",
        "qualityRecords",
        "drafts",
        "schedulerProfiles",
    ] {
        keys.insert(field.into(), Value::Null);
    }
    let mut sink = Sink(Sha256::new());
    sink.write_all(b"{").map_err(|e| e.to_string())?;
    let mut first = true;
    for field in keys.keys() {
        if !first {
            sink.write_all(b",").map_err(|e| e.to_string())?;
        }
        first = false;
        serde_json::to_writer(&mut sink, field).map_err(|e| e.to_string())?;
        sink.write_all(b":").map_err(|e| e.to_string())?;
        match field.as_str() {
            "version" => {
                serde_json::to_writer(&mut sink, &wire_version(c)?).map_err(|e| e.to_string())?
            }
            "studySettings" => {
                serde_json::to_writer(&mut sink, &study(c)).map_err(|e| e.to_string())?
            }
            _ => {
                sink.write_all(b"[").map_err(|e| e.to_string())?;
                let mut first = true;
                visit(c, field, |value| {
                    if !first {
                        sink.write_all(b",").map_err(|e| e.to_string())?;
                    }
                    first = false;
                    serde_json::to_writer(&mut sink, &value).map_err(|e| e.to_string())
                })?;
                sink.write_all(b"]").map_err(|e| e.to_string())?;
            }
        }
    }
    sink.write_all(b"}").map_err(|e| e.to_string())?;
    Ok(format!("{:x}", sink.0.finalize()))
}

pub(crate) fn visit_media(
    c: &Connection,
    mut consumer: impl FnMut(&Value) -> Result<(), String>,
) -> Result<(), String> {
    for query in [
        "SELECT media_json FROM flashcard_drafts ORDER BY id",
        "SELECT media_json FROM flashcards ORDER BY id",
        "SELECT json_extract(payload_json,'$.snapshot.media') FROM flashcard_quality_records WHERE json_valid(payload_json) ORDER BY id",
        "SELECT json_extract(payload_json,'$.before.media') FROM flashcard_quality_records WHERE json_valid(payload_json) ORDER BY id",
    ] {
        let mut statement=c.prepare(query).map_err(|e|e.to_string())?;
        let mut rows=statement.query([]).map_err(|e|e.to_string())?;
        while let Some(row)=rows.next().map_err(|e|e.to_string())? {
            if let Some(raw)=row.get::<_,Option<String>>(0).map_err(|e|e.to_string())? {
                if let Ok(items)=serde_json::from_str::<Vec<Value>>(&raw) {
                    for item in items { consumer(&item)?; }
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn media_record(
    c: &Connection,
    field: &str,
    key: &str,
    mut consumer: impl FnMut(&Value) -> Result<(), String>,
) -> Result<(), String> {
    let id: String = serde_json::from_str(key).map_err(|e| e.to_string())?;
    let query=match field {
        "cards"=>"SELECT media_json,NULL FROM flashcards WHERE id=?1",
        "drafts"=>"SELECT media_json,NULL FROM flashcard_drafts WHERE id=?1",
        "qualityRecords"=>"SELECT json_extract(payload_json,'$.snapshot.media'),json_extract(payload_json,'$.before.media') FROM flashcard_quality_records WHERE id=?1",
        _=>return Err("附件引用记录域无效".into()),
    };
    let row: Option<(Option<String>, Option<String>)> = c
        .query_row(query, [id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some((first, second)) = row {
        for raw in [first, second].into_iter().flatten() {
            if let Ok(items) = serde_json::from_str::<Vec<Value>>(&raw) {
                for item in items {
                    consumer(&item)?;
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn media_hash(item: &Value) -> Option<String> {
    let hash = item
        .get("url")?
        .as_str()?
        .rsplit('/')
        .next()?
        .to_ascii_lowercase();
    (hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit())).then_some(hash)
}

#[cfg(test)]
pub(crate) fn media_hashes(c: &Connection) -> Result<HashSet<String>, String> {
    let mut hashes = HashSet::new();
    visit_media(c, |item| {
        if let Some(hash) = media_hash(item) {
            hashes.insert(hash);
        }
        Ok(())
    })?;
    Ok(hashes)
}

pub(crate) fn references_media(c: &Connection, wanted: &str) -> Result<bool, String> {
    let mut found = false;
    visit_media(c, |item| {
        found |= media_hash(item).as_deref() == Some(wanted);
        Ok(())
    })?;
    Ok(found)
}
