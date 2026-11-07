//! Canonical flashcard data snapshots, tombstones and transactional merge ownership.
use crate::flashcard_study_settings::read_flashcard_study_settings;

use crate::{
    ensure_flashcard_deck, flashcard_profiles, flashcard_quality, flashcard_review_log,
    flashcard_scheduler, flashcard_sync_drafts, metadata_string, random_url_safe,
    FlashcardSnapshotDeck, FlashcardSnapshotFolder, FlashcardSnapshotTombstone,
    FlashcardStudySettings, FlashcardSyncSnapshot,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
pub(crate) mod history;
pub(crate) mod identity;
pub(crate) mod records;

pub(crate) fn flashcard_sync_device_id(connection: &Connection) -> Result<String, String> {
    let stored = metadata_string(connection, "flashcard_sync_device_id");
    if !stored.trim().is_empty() {
        return Ok(stored);
    }
    let id = format!("device-{}", random_url_safe(16));
    connection
        .execute(
            "INSERT INTO metadata (key,value) VALUES ('flashcard_sync_device_id',?1)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![id],
        )
        .map_err(|error| format!("无法保存闪卡同步设备 ID：{error}"))?;
    Ok(id)
}

pub(crate) fn local_flashcard_snapshot(
    connection: &Connection,
) -> Result<FlashcardSyncSnapshot, String> {
    records::snapshot(connection)
}

pub(crate) fn recompute_flashcard_schedule(
    connection: &Connection,
    card_id: &str,
) -> Result<(), String> {
    flashcard_scheduler::recompute(connection, card_id)
}

pub(crate) fn flashcard_tombstone_deleted_at(
    connection: &Connection,
    entity_type: &str,
    entity_id: &str,
) -> Result<Option<i64>, String> {
    connection
        .query_row(
            "SELECT deleted_at FROM flashcard_sync_tombstones
             WHERE entity_type=?1 AND entity_id=?2",
            params![entity_type, entity_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| format!("无法读取闪卡删除状态：{error}"))
}

pub(crate) fn clear_older_flashcard_tombstone(
    connection: &Connection,
    entity_type: &str,
    entity_id: &str,
    updated_at: i64,
) -> Result<bool, String> {
    let Some(deleted_at) = flashcard_tombstone_deleted_at(connection, entity_type, entity_id)?
    else {
        return Ok(true);
    };
    if deleted_at >= updated_at {
        return Ok(false);
    }
    connection
        .execute(
            "DELETE FROM flashcard_sync_tombstones
             WHERE entity_type=?1 AND entity_id=?2 AND deleted_at<?3",
            params![entity_type, entity_id, updated_at],
        )
        .map_err(|error| format!("无法清除过期闪卡删除状态：{error}"))?;
    Ok(true)
}

pub(crate) fn apply_flashcard_tombstone(
    connection: &Connection,
    tombstone: &FlashcardSnapshotTombstone,
) -> Result<(), String> {
    if tombstone.entity_id.trim().is_empty()
        || !matches!(
            tombstone.entity_type.as_str(),
            "folder" | "deck" | "card" | "review"
        )
    {
        return Ok(());
    }
    let local_updated_at = match tombstone.entity_type.as_str() {
        "folder" => connection
            .query_row(
                "SELECT updated_at FROM flashcard_deck_folders WHERE id=?1",
                params![tombstone.entity_id],
                |row| row.get::<_, i64>(0),
            )
            .optional(),
        "deck" => connection
            .query_row(
                "SELECT updated_at FROM flashcard_decks WHERE id=?1",
                params![tombstone.entity_id],
                |row| row.get::<_, i64>(0),
            )
            .optional(),
        "card" => connection
            .query_row(
                "SELECT updated_at FROM flashcards WHERE id=?1",
                params![tombstone.entity_id],
                |row| row.get::<_, i64>(0),
            )
            .optional(),
        "review" => connection
            .query_row(
                "SELECT reviewed_at FROM flashcard_reviews WHERE id=?1",
                params![tombstone.entity_id],
                |row| row.get::<_, i64>(0),
            )
            .optional(),
        _ => unreachable!(),
    }
    .map_err(|error| format!("无法比较闪卡删除状态：{error}"))?;
    if tombstone.entity_type != "review"
        && local_updated_at.is_some_and(|updated_at| updated_at > tombstone.deleted_at)
    {
        return Ok(());
    }
    record_flashcard_tombstone(
        connection,
        &tombstone.entity_type,
        &tombstone.entity_id,
        tombstone.deleted_at,
    )?;
    match tombstone.entity_type.as_str() {
        "folder" => {
            connection
                .execute(
                    "UPDATE flashcard_decks SET folder_id='',updated_at=MAX(updated_at,?1)
                     WHERE folder_id=?2",
                    params![tombstone.deleted_at, tombstone.entity_id],
                )
                .map_err(|error| format!("无法同步已删除文件夹内牌组：{error}"))?;
            connection
                .execute(
                    "DELETE FROM flashcard_deck_folders WHERE id=?1",
                    params![tombstone.entity_id],
                )
                .map_err(|error| format!("无法同步删除文件夹：{error}"))?;
        }
        "deck" => {
            crate::flashcard_decks::promote_children(
                connection,
                &tombstone.entity_id,
                tombstone.deleted_at,
            )?;
            connection
                .execute(
                    "DELETE FROM flashcard_reviews
                     WHERE card_id IN (SELECT id FROM flashcards WHERE deck_id=?1)",
                    params![tombstone.entity_id],
                )
                .map_err(|error| format!("无法同步删除牌组复习记录：{error}"))?;
            connection
                .execute(
                    "DELETE FROM flashcards WHERE deck_id=?1",
                    params![tombstone.entity_id],
                )
                .map_err(|error| format!("无法同步删除牌组卡片：{error}"))?;
            connection
                .execute(
                    "DELETE FROM flashcard_decks WHERE id=?1",
                    params![tombstone.entity_id],
                )
                .map_err(|error| format!("无法同步删除牌组：{error}"))?;
        }
        "card" => {
            connection
                .execute(
                    "DELETE FROM flashcard_reviews WHERE card_id=?1",
                    params![tombstone.entity_id],
                )
                .map_err(|error| format!("无法同步删除闪卡复习记录：{error}"))?;
            connection
                .execute(
                    "DELETE FROM flashcards WHERE id=?1",
                    params![tombstone.entity_id],
                )
                .map_err(|error| format!("无法同步删除闪卡：{error}"))?;
        }
        "review" => {
            restore_flashcard_after_review_delete(
                connection,
                &tombstone.entity_id,
                tombstone.deleted_at,
            )?;
        }
        _ => unreachable!(),
    }
    Ok(())
}

pub(crate) fn merge_flashcard_snapshot(
    connection: &mut Connection,
    remote: &FlashcardSyncSnapshot,
) -> Result<(usize, usize), String> {
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    let result = merge_flashcard_snapshot_in_transaction(&transaction, remote)?;
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(result)
}

fn merge_study_settings(
    c: &Connection,
    incoming: Option<&FlashcardStudySettings>,
) -> Result<(), String> {
    if let Some(remote) = incoming {
        let local = read_flashcard_study_settings(c);
        if (remote.updated_at, remote.daily_new_limit) > (local.updated_at, local.daily_new_limit)
            && matches!(remote.daily_new_limit, 0 | 5 | 10 | 20 | 50)
        {
            for (key, value) in [
                ("flashcard_daily_new_limit", remote.daily_new_limit),
                ("flashcard_daily_new_limit_updated_at", remote.updated_at),
            ] {
                c.execute("INSERT INTO metadata(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,value.to_string()]).map_err(|e|e.to_string())?;
            }
        }
    }
    Ok(())
}

fn merge_folder(
    c: &Connection,
    folder: &FlashcardSnapshotFolder,
) -> Result<Option<String>, String> {
    if !clear_older_flashcard_tombstone(c, "folder", &folder.id, folder.updated_at)? {
        return Ok(None);
    }
    let updated: Option<i64> = c
        .query_row(
            "SELECT updated_at FROM flashcard_deck_folders WHERE id=?1",
            [&folder.id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(updated) = updated {
        let wins = if folder.updated_at == updated {
            let value = records::local(
                c,
                "folders",
                &serde_json::to_string(&folder.id).map_err(|e| e.to_string())?,
            )?
            .ok_or("本地文件夹比较记录缺失")?;
            let local: FlashcardSnapshotFolder =
                serde_json::from_value(value).map_err(|e| e.to_string())?;
            serde_json::to_vec(&local).map_err(|e| e.to_string())?
                < serde_json::to_vec(folder).map_err(|e| e.to_string())?
        } else {
            folder.updated_at > updated
        };
        if wins {
            c.execute(
                "UPDATE flashcard_deck_folders SET name=?1,sort_order=?2,updated_at=?3 WHERE id=?4",
                params![folder.name, folder.sort_order, folder.updated_at, folder.id],
            )
            .map_err(|e| e.to_string())?;
        }
        return Ok(Some(folder.id.clone()));
    }
    if let Some(existing) = c
        .query_row(
            "SELECT id FROM flashcard_deck_folders WHERE name=?1 COLLATE NOCASE",
            [&folder.name],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
    {
        return Ok(Some(existing));
    }
    c.execute("INSERT INTO flashcard_deck_folders(id,name,sort_order,created_at,updated_at) VALUES(?1,?2,?3,?4,?5)",params![folder.id,folder.name,folder.sort_order,folder.created_at,folder.updated_at]).map_err(|e|e.to_string())?;
    Ok(Some(folder.id.clone()))
}

fn merge_deck(
    c: &Connection,
    deck: &FlashcardSnapshotDeck,
    folder_id: &str,
) -> Result<Option<String>, String> {
    if !clear_older_flashcard_tombstone(c, "deck", &deck.id, deck.updated_at)? {
        return Ok(None);
    }
    let mut candidate = deck.clone();
    candidate.folder_id = folder_id.to_string();
    let updated: Option<i64> = c
        .query_row(
            "SELECT updated_at FROM flashcard_decks WHERE id=?1",
            [&deck.id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(updated) = updated {
        let wins = if deck.updated_at == updated {
            let value = records::local(
                c,
                "decks",
                &serde_json::to_string(&deck.id).map_err(|e| e.to_string())?,
            )?
            .ok_or("本地牌组比较记录缺失")?;
            let local: FlashcardSnapshotDeck =
                serde_json::from_value(value).map_err(|e| e.to_string())?;
            serde_json::to_vec(&local).map_err(|e| e.to_string())?
                < serde_json::to_vec(&candidate).map_err(|e| e.to_string())?
        } else {
            deck.updated_at > updated
        };
        if wins {
            let conflict:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM flashcard_decks WHERE name=?1 COLLATE NOCASE AND id<>?2)",params![deck.name,deck.id],|r|r.get(0)).map_err(|e|e.to_string())?;
            if !conflict {
                c.execute("UPDATE flashcard_decks SET name=?1,folder_id=?2,sort_order=?3,updated_at=?4,parent_deck_id=?6 WHERE id=?5",params![deck.name,folder_id,deck.sort_order,deck.updated_at,deck.id,deck.parent_deck_id]).map_err(|e|e.to_string())?;
            }
        }
        return Ok(Some(deck.id.clone()));
    }
    if let Some(existing) = c
        .query_row(
            "SELECT id FROM flashcard_decks WHERE name=?1 COLLATE NOCASE",
            [&deck.name],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
    {
        c.execute("INSERT INTO flashcard_deck_aliases(remote_id,local_id) VALUES(?1,?2) ON CONFLICT(remote_id) DO UPDATE SET local_id=excluded.local_id",params![deck.id,existing]).map_err(|e|e.to_string())?;
        c.execute(
            "UPDATE flashcard_decks SET parent_deck_id=?1 WHERE parent_deck_id=?2",
            params![existing, deck.id],
        )
        .map_err(|e| e.to_string())?;
        return Ok(Some(existing));
    }
    c.execute("INSERT INTO flashcard_decks(id,name,folder_id,sort_order,created_at,updated_at,parent_deck_id) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![deck.id,deck.name,folder_id,deck.sort_order,deck.created_at,deck.updated_at,deck.parent_deck_id]).map_err(|e|e.to_string())?;
    Ok(Some(deck.id.clone()))
}

pub(crate) fn merge_flashcard_snapshot_in_transaction(
    transaction: &Connection,
    remote: &FlashcardSyncSnapshot,
) -> Result<(usize, usize), String> {
    merge_with_context(transaction, remote, None)
}

pub(crate) fn merge_recovery_snapshot(
    transaction: &Connection,
    remote: &FlashcardSyncSnapshot,
    context: &history::Context<'_>,
) -> Result<(usize, usize), String> {
    merge_with_context(transaction, remote, Some(context))
}

fn merge_with_context(
    transaction: &Connection,
    remote: &FlashcardSyncSnapshot,
    context: Option<&history::Context<'_>>,
) -> Result<(usize, usize), String> {
    flashcard_scheduler::validate_snapshot(remote)?;
    if remote.folders.len() > 10_000
        || remote.drafts.len() > 200_000
        || remote.tombstones.len() > 200_000
        || remote.decks.len() > 10_000
        || remote.cards.len() > 200_000
        || remote.reviews.len() > 2_000_000
    {
        return Err("远端闪卡快照超过安全数量限制".to_string());
    }
    if let Some(context) = context {
        context.prepare(transaction, remote)?;
    } else {
        flashcard_profiles::merge(&transaction, &remote.scheduler_profiles)?;
        flashcard_sync_drafts::merge(&transaction, &remote.drafts)?;
        for tombstone in &remote.tombstones {
            apply_flashcard_tombstone(&transaction, tombstone)?;
        }
    }
    // Deletion/undo handlers can change schedules and deck timestamps. Compare with their committed projection.
    let mut local_cards: HashMap<_, _> = records::cards_for_merge(transaction, &remote.cards)?
        .into_iter()
        .map(|card| {
            (
                card.id.clone(),
                serde_json::to_vec(&card).unwrap_or_default(),
            )
        })
        .collect();
    let mut deck_ids = HashMap::new();
    if context.is_none() {
        merge_study_settings(transaction, remote.study_settings.as_ref())?;
        let mut folder_ids = HashMap::new();
        for folder in &remote.folders {
            if let Some(local_id) = merge_folder(transaction, folder)? {
                folder_ids.insert(folder.id.clone(), local_id);
            }
        }
        for deck in &remote.decks {
            let folder_id = if let Some(id) = folder_ids.get(&deck.folder_id) {
                id.clone()
            } else {
                transaction
                    .query_row(
                        "SELECT id FROM flashcard_deck_folders WHERE id=?1",
                        [&deck.folder_id],
                        |r| r.get::<_, String>(0),
                    )
                    .optional()
                    .map_err(|e| e.to_string())?
                    .unwrap_or_default()
            };
            if let Some(local_id) = merge_deck(transaction, deck, &folder_id)? {
                deck_ids.insert(deck.id.clone(), local_id);
            }
        }
    }
    if context.is_none() {
        for deck in &remote.decks {
            // Only the record actually written by this merge owns its parent edge.
            transaction.execute("UPDATE flashcard_decks SET parent_deck_id=CASE WHEN EXISTS(SELECT 1 FROM flashcard_decks parent WHERE parent.id=flashcard_decks.parent_deck_id) THEN parent_deck_id ELSE COALESCE((SELECT local_id FROM flashcard_deck_aliases WHERE remote_id=parent_deck_id),parent_deck_id) END WHERE id=?1 AND updated_at=?2",params![deck.id,deck.updated_at]).map_err(|e|e.to_string())?;
            crate::flashcard_decks::repair_merged_link(transaction, &deck.id)?;
        }
    }
    let mut quality_records = remote.quality_records.clone();
    for record in &mut quality_records {
        if let Some(context) = context {
            context.remap_quality(transaction, record)?;
        } else {
            flashcard_quality::remap_decks(record, &deck_ids);
        }
    }
    flashcard_quality::merge(&transaction, &quality_records)?;
    let mut fallback_deck = String::new();
    let mut downloaded_cards = 0;
    let mut affected_cards = HashSet::new();
    for card in &remote.cards {
        // Content may lose its timestamp comparison while its review facts
        // still need to rebuild a missing or stale local projection.
        affected_cards.insert(card.id.clone());
        if !clear_older_flashcard_tombstone(&transaction, "card", &card.id, card.updated_at)? {
            continue;
        }
        if flashcard_tombstone_deleted_at(&transaction, "deck", &card.deck_id)?
            .is_some_and(|deleted_at| deleted_at >= card.updated_at)
        {
            continue;
        }
        let contextual_deck = context
            .map(|context| context.deck(transaction, &card.deck_id))
            .transpose()?
            .flatten();
        let deck_id = if let Some(deck_id) = contextual_deck {
            deck_id
        } else if let Some(deck_id) = deck_ids.get(&card.deck_id) {
            deck_id.clone()
        } else if let Some(id) = transaction
            .query_row(
                "SELECT id FROM flashcard_decks WHERE id=?1",
                params![card.deck_id],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
        {
            id
        } else {
            if fallback_deck.is_empty() {
                fallback_deck = ensure_flashcard_deck(&transaction, "同步闪卡")?;
            }
            fallback_deck.clone()
        };
        let local_updated = transaction
            .query_row(
                "SELECT updated_at FROM flashcards WHERE id=?1",
                params![card.id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|error| format!("无法检查远端闪卡：{error}"))?;
        let mut candidate = card.clone();
        candidate.deck_id = deck_id.clone();
        flashcard_scheduler::protect_schedule(&transaction, &mut candidate)?;
        let candidate_bytes = serde_json::to_vec(&candidate).map_err(|e| e.to_string())?;
        if local_updated.is_some_and(|value| {
            value > card.updated_at
                || (value == card.updated_at
                    && local_cards
                        .get(&card.id)
                        .is_some_and(|bytes| bytes >= &candidate_bytes))
        }) {
            continue;
        }
        let card = &candidate;
        transaction.execute(
            "INSERT INTO flashcards
               (id,deck_id,question,answer,explanation,card_type,source_library_id,source_document_id,source_block_id,
                source_title,source_path,source_hash,media_json,status,created_at,updated_at,due_at,interval_days,ease,repetitions,lapses,card_data_json,
                tags_json,evidence,confidence,custom_fields_json,generation_json,fsrs_state_json)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28)
             ON CONFLICT(id) DO UPDATE SET deck_id=excluded.deck_id,question=excluded.question,answer=excluded.answer,
               explanation=excluded.explanation,card_type=excluded.card_type,source_library_id=excluded.source_library_id,
               source_document_id=excluded.source_document_id,source_block_id=excluded.source_block_id,source_title=excluded.source_title,
               source_path=excluded.source_path,source_hash=excluded.source_hash,media_json=excluded.media_json,status=excluded.status,
               created_at=excluded.created_at,updated_at=excluded.updated_at,due_at=excluded.due_at,interval_days=excluded.interval_days,ease=excluded.ease,
               repetitions=excluded.repetitions,lapses=excluded.lapses,card_data_json=excluded.card_data_json,
               tags_json=excluded.tags_json,evidence=excluded.evidence,confidence=excluded.confidence,
               custom_fields_json=excluded.custom_fields_json,generation_json=excluded.generation_json,fsrs_state_json=excluded.fsrs_state_json",
            params![card.id, deck_id, card.question, card.answer, card.explanation, card.card_type, card.source_library_id,
                card.source_document_id, card.source_block_id, card.source_title, card.source_path, card.source_hash, card.media_json,
                card.status, card.created_at, card.updated_at, card.due_at, card.interval_days, card.ease, card.repetitions, card.lapses,
                card.card_data_json, card.tags_json, card.evidence, card.confidence, card.custom_fields_json, card.generation_json, card.fsrs_state_json],
        ).map_err(|error| format!("无法合并远端闪卡：{error}"))?;
        local_cards.insert(card.id.clone(), candidate_bytes);
        downloaded_cards += 1;
    }
    let mut merged_reviews = 0;
    for review in &remote.reviews {
        if flashcard_review_log::append(&transaction, review)? {
            merged_reviews += 1;
        }
        affected_cards.insert(review.card_id.clone());
    }
    for card_id in affected_cards {
        recompute_flashcard_schedule(&transaction, &card_id)?;
    }
    if let Some(context) = context {
        context.finish(transaction)?;
    }
    Ok((downloaded_cards, merged_reviews))
}

pub(crate) fn flashcard_snapshot_media_hashes(snapshot: &FlashcardSyncSnapshot) -> HashSet<String> {
    let mut hashes = HashSet::new();
    for item in flashcard_sync_drafts::media(&snapshot.drafts) {
        if let Some(url) = item["url"].as_str() {
            let hash = url
                .rsplit('/')
                .next()
                .unwrap_or_default()
                .to_ascii_lowercase();
            if hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()) {
                hashes.insert(hash);
            }
        }
    }
    for card in &snapshot.cards {
        let Ok(items) = serde_json::from_str::<Vec<Value>>(&card.media_json) else {
            continue;
        };
        for item in items {
            let Some(url) = item.get("url").and_then(Value::as_str) else {
                continue;
            };
            let hash = url
                .rsplit('/')
                .next()
                .unwrap_or_default()
                .to_ascii_lowercase();
            if hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                hashes.insert(hash);
            }
        }
    }
    for record in &snapshot.quality_records {
        for item in [&record["snapshot"], &record["before"]]
            .into_iter()
            .flat_map(|card| card["media"].as_array().into_iter().flatten())
        {
            if let Some(url) = item["url"].as_str() {
                let hash = url
                    .rsplit('/')
                    .next()
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                if hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()) {
                    hashes.insert(hash);
                }
            }
        }
    }

    hashes
}

pub(crate) use crate::flashcard_store::record_flashcard_tombstone;

pub(crate) fn restore_flashcard_after_review_delete(
    connection: &Connection,
    review_id: &str,
    changed_at: i64,
) -> Result<Option<String>, String> {
    flashcard_scheduler::restore(connection, review_id, changed_at)
}
