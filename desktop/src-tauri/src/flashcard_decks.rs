//! Deck hierarchy, folder placement and transactional deck mutations.
//! This owner operates on a caller-owned connection and never opens an application database.
use crate::flashcard_store::{mark_flashcard_sync_dirty, record_flashcard_tombstone};
use crate::{now_timestamp, random_url_safe};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[cfg(test)]
#[path = "flashcard_decks_tests.rs"]
mod tests;

/// The recursive set contains deck IDs only. UNION makes malformed legacy graphs
/// terminate and prevents counting a card more than once.
pub(crate) fn card_scope(include_subdecks: bool) -> &'static str {
    if include_subdecks {
        "deck_id IN (WITH RECURSIVE subtree(id) AS (SELECT id FROM flashcard_decks WHERE id=?1 UNION SELECT d.id FROM flashcard_decks d JOIN subtree s ON d.parent_deck_id=s.id) SELECT id FROM subtree)"
    } else {
        "deck_id=?1"
    }
}

pub(crate) fn install_hierarchy(c: &Connection) -> Result<(), String> {
    let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
    let installed: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('flashcard_decks') WHERE name='parent_deck_id')", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    if !installed {
        tx.execute_batch(
            "ALTER TABLE flashcard_decks ADD COLUMN parent_deck_id TEXT NOT NULL DEFAULT '';",
        )
        .map_err(|e| e.to_string())?;
    }
    tx.execute_batch("CREATE INDEX IF NOT EXISTS flashcard_decks_parent_order ON flashcard_decks(parent_deck_id,sort_order,id);
        CREATE TABLE IF NOT EXISTS flashcard_deck_aliases(remote_id TEXT PRIMARY KEY,local_id TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS flashcard_deck_aliases_local ON flashcard_deck_aliases(local_id);
        INSERT OR IGNORE INTO metadata(key,value) VALUES('flashcard_list_revision','0');
        CREATE TRIGGER IF NOT EXISTS flashcard_hierarchy_inserted AFTER INSERT ON flashcard_decks
        BEGIN UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='flashcard_list_revision'; END;
        CREATE TRIGGER IF NOT EXISTS flashcard_hierarchy_deleted AFTER DELETE ON flashcard_decks
        BEGIN UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='flashcard_list_revision'; END;
        CREATE TRIGGER IF NOT EXISTS flashcard_hierarchy_updated AFTER UPDATE OF parent_deck_id ON flashcard_decks
        WHEN OLD.parent_deck_id IS NOT NEW.parent_deck_id
        BEGIN UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='flashcard_list_revision'; END;
        UPDATE metadata SET value='69' WHERE key='schema_version' AND CAST(value AS INTEGER)<69;"
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

fn placement(c: &Connection, deck: &str) -> Result<(String, String), String> {
    c.query_row(
        "SELECT parent_deck_id,folder_id FROM flashcard_decks WHERE id=?1",
        [deck],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "牌组不存在".into())
}

fn validate_parent(c: &Connection, deck: &str, parent: &str) -> Result<(), String> {
    if parent.is_empty() {
        return Ok(());
    }
    placement(c, parent)?;
    let cycle: bool = c.query_row("WITH RECURSIVE ancestors(id) AS (SELECT ?1 UNION SELECT d.parent_deck_id FROM flashcard_decks d JOIN ancestors a ON d.id=a.id WHERE d.parent_deck_id<>'') SELECT EXISTS(SELECT 1 FROM ancestors WHERE id=?2)", params![parent,deck], |r| r.get(0)).map_err(|e| e.to_string())?;
    if cycle {
        return Err("不能将牌组移到自身或其子牌组中".into());
    }
    Ok(())
}

pub(crate) fn create_subdeck(
    c: &mut Connection,
    name: &str,
    parent: &str,
) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err("牌组名称应为 1–80 个字符".into());
    }
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let (_, folder) = placement(&tx, parent)?;
    let exists: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM flashcard_decks WHERE name=?1 COLLATE NOCASE)",
            [name],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if exists {
        return Err("已存在同名牌组".into());
    }
    let id = ensure_flashcard_deck(&tx, name)?;
    let order: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(sort_order),-1)+1 FROM flashcard_decks WHERE parent_deck_id=?1",
            [parent],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE flashcard_decks SET parent_deck_id=?1,folder_id=?2,sort_order=?3 WHERE id=?4",
        params![parent, folder, order, id],
    )
    .map_err(|e| e.to_string())?;
    mark_flashcard_sync_dirty(&tx)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

pub(crate) fn set_parent(c: &mut Connection, deck: &str, parent: &str) -> Result<(), String> {
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let (old_parent, old_folder) = placement(&tx, deck)?;
    validate_parent(&tx, deck, parent)?;
    if old_parent == parent {
        return Ok(());
    }
    let folder = if parent.is_empty() {
        old_folder
    } else {
        placement(&tx, parent)?.1
    };
    let order:i64=tx.query_row("SELECT COALESCE(MAX(sort_order),-1)+1 FROM flashcard_decks WHERE parent_deck_id=?1 AND folder_id=?2",params![parent,folder],|r|r.get(0)).map_err(|e|e.to_string())?;
    let now = now_timestamp();
    tx.execute("UPDATE flashcard_decks SET parent_deck_id=?1,folder_id=?2,sort_order=?3,updated_at=MAX(updated_at+1,?4) WHERE id=?5",params![parent,folder,order,now,deck]).map_err(|e|e.to_string())?;
    update_subtree_folder(&tx, deck, &folder, now)?;
    mark_flashcard_sync_dirty(&tx)?;
    tx.commit().map_err(|e| e.to_string())
}

fn update_subtree_folder(c: &Connection, deck: &str, folder: &str, now: i64) -> Result<(), String> {
    c.execute("WITH RECURSIVE subtree(id) AS (SELECT ?1 UNION SELECT d.id FROM flashcard_decks d JOIN subtree s ON d.parent_deck_id=s.id) UPDATE flashcard_decks SET folder_id=?2,updated_at=MAX(updated_at+1,?3) WHERE id IN (SELECT id FROM subtree) AND folder_id<>?2",params![deck,folder,now]).map_err(|e|e.to_string())?;
    Ok(())
}

/// Removing a parent deletes only its own cards. Descendant IDs/cards/reviews survive.
pub(crate) fn promote_children(c: &Connection, deck: &str, timestamp: i64) -> Result<(), String> {
    let Some((parent, folder)) = c
        .query_row(
            "SELECT parent_deck_id,folder_id FROM flashcard_decks WHERE id=?1",
            [deck],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
    else {
        c.execute("UPDATE flashcard_decks SET parent_deck_id='',updated_at=MAX(updated_at+1,?2) WHERE parent_deck_id=?1",params![deck,timestamp]).map_err(|e|e.to_string())?;
        return Ok(());
    };
    c.execute("UPDATE flashcard_decks SET parent_deck_id=?1,folder_id=?2,sort_order=sort_order+(SELECT COALESCE(MAX(sort_order),-1)+1 FROM flashcard_decks WHERE parent_deck_id=?1 AND folder_id=?2),updated_at=MAX(updated_at+1,?3) WHERE parent_deck_id=?4",params![parent,folder,timestamp,deck]).map_err(|e|e.to_string())?;
    Ok(())
}

/// Cloud records can arrive before their parent. Preserve unresolved stable IDs;
/// only a complete observed cycle is broken, at its deterministic smallest ID.
pub(crate) fn repair_merged_link(c: &Connection, deck: &str) -> Result<(), String> {
    c.execute("UPDATE flashcard_decks SET parent_deck_id='' WHERE id=?1 AND EXISTS(SELECT 1 FROM flashcard_sync_tombstones t WHERE t.entity_type='deck' AND t.entity_id=parent_deck_id AND t.deleted_at>=updated_at) AND NOT EXISTS(SELECT 1 FROM flashcard_decks parent WHERE parent.id=flashcard_decks.parent_deck_id)",[deck]).map_err(|e|e.to_string())?;
    let mut order = Vec::<String>::new();
    let mut positions = std::collections::HashMap::new();
    let mut current = deck.to_owned();
    while !current.is_empty() {
        if let Some(start) = positions.get(&current).copied() {
            let root = order[start..].iter().min().ok_or("牌组环为空")?;
            c.execute(
                "UPDATE flashcard_decks SET parent_deck_id='' WHERE id=?1",
                [root],
            )
            .map_err(|e| e.to_string())?;
            break;
        }
        positions.insert(current.clone(), order.len());
        order.push(current.clone());
        current = c
            .query_row(
                "SELECT parent_deck_id FROM flashcard_decks WHERE id=?1",
                [&current],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or_default();
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FlashcardDeckSummary {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) folder_id: String,
    pub(crate) sort_order: i64,
    pub(crate) parent_deck_id: String,
    pub(crate) card_count: i64,
    pub(crate) due_count: i64,
    pub(crate) new_count: i64,
    pub(crate) suspended_count: i64,
    pub(crate) updated_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FlashcardDeckFolderSummary {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) sort_order: i64,
    pub(crate) updated_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FlashcardSnapshotDeck {
    pub(crate) id: String,
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) folder_id: String,
    #[serde(default)]
    pub(crate) sort_order: i64,
    #[serde(default)]
    pub(crate) parent_deck_id: String,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
}

pub(crate) fn ensure_flashcard_deck(
    connection: &Connection,
    requested_name: &str,
) -> Result<String, String> {
    let name = requested_name.trim().chars().take(120).collect::<String>();
    let name = if name.is_empty() {
        "默认牌组".to_string()
    } else {
        name
    };
    if let Some(id) = connection
        .query_row(
            "SELECT id FROM flashcard_decks WHERE name=?1 COLLATE NOCASE",
            params![name],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("无法查找闪卡牌组：{error}"))?
    {
        return Ok(id);
    }
    let id = format!("deck-{}", random_url_safe(12));
    let timestamp = now_timestamp();
    connection
        .execute(
            "INSERT INTO flashcard_decks (id,name,created_at,updated_at) VALUES (?1,?2,?3,?3)",
            params![id, name, timestamp],
        )
        .map_err(|error| format!("无法创建闪卡牌组：{error}"))?;
    Ok(id)
}

pub(crate) fn list_flashcard_decks(
    connection: &Connection,
) -> Result<Vec<FlashcardDeckSummary>, String> {
    let now = now_timestamp();
    let mut statement = connection
        .prepare(
            "SELECT d.id,d.name,d.folder_id,d.sort_order,
                    COUNT(c.id),
                    COALESCE(SUM(CASE WHEN c.status='active' AND c.due_at<=?1 THEN 1 ELSE 0 END),0),
                    COALESCE(SUM(CASE WHEN c.status='active' AND c.repetitions=0 AND c.lapses=0 THEN 1 ELSE 0 END),0),
                    d.updated_at,
                    COALESCE(SUM(CASE WHEN c.status='suspended' THEN 1 ELSE 0 END),0),d.parent_deck_id
             FROM flashcard_decks d
             LEFT JOIN flashcards c ON c.deck_id=d.id AND c.status IN ('active','suspended')
             GROUP BY d.id,d.name,d.folder_id,d.sort_order,d.updated_at
             ORDER BY d.folder_id,d.sort_order,d.name COLLATE NOCASE",
        )
        .map_err(|error| format!("无法准备闪卡牌组列表：{error}"))?;
    let rows = statement
        .query_map(params![now], |row| {
            Ok(FlashcardDeckSummary {
                id: row.get(0)?,
                name: row.get(1)?,
                folder_id: row.get(2)?,
                sort_order: row.get(3)?,
                card_count: row.get(4)?,
                due_count: row.get(5)?,
                new_count: row.get(6)?,
                updated_at: row.get(7)?,
                suspended_count: row.get(8)?,
                parent_deck_id: row.get(9)?,
            })
        })
        .map_err(|error| format!("无法读取闪卡牌组：{error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法收集闪卡牌组：{error}"))
}

pub(crate) fn list_flashcard_deck_folders(
    connection: &Connection,
) -> Result<Vec<FlashcardDeckFolderSummary>, String> {
    let mut statement = connection
        .prepare("SELECT id,name,sort_order,updated_at FROM flashcard_deck_folders ORDER BY sort_order,name COLLATE NOCASE")
        .map_err(|error| format!("无法准备闪卡文件夹列表：{error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(FlashcardDeckFolderSummary {
                id: row.get(0)?,
                name: row.get(1)?,
                sort_order: row.get(2)?,
                updated_at: row.get(3)?,
            })
        })
        .map_err(|error| format!("无法读取闪卡文件夹：{error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法收集闪卡文件夹：{error}"))
}

pub(crate) fn create_flashcard_deck(
    connection: &mut Connection,
    name: String,
) -> Result<String, String> {
    create_flashcard_deck_in_connection(connection, &name)
}

pub(crate) fn create_flashcard_deck_in_connection(
    connection: &mut Connection,
    name: &str,
) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err("牌组名称应为 1～80 个字符".to_string());
    }
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开始创建牌组：{error}"))?;
    let exists: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM flashcard_decks WHERE name=?1 COLLATE NOCASE)",
            params![name],
            |row| row.get(0),
        )
        .map_err(|error| format!("无法检查牌组名称：{error}"))?;
    if exists {
        return Err("已存在同名牌组".to_string());
    }
    let id = ensure_flashcard_deck(&transaction, name)?;
    mark_flashcard_sync_dirty(&transaction)?;
    transaction
        .commit()
        .map_err(|error| format!("无法保存新牌组：{error}"))?;
    Ok(id)
}

pub(crate) fn create_flashcard_deck_folder(
    connection: &Connection,
    name: String,
) -> Result<FlashcardDeckFolderSummary, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err("文件夹名称应为 1～80 个字符".to_string());
    }
    let id = format!("folder-{}", random_url_safe(12));
    let timestamp = now_timestamp();
    let sort_order = connection
        .query_row(
            "SELECT COALESCE(MAX(sort_order),-1)+1 FROM flashcard_deck_folders",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("无法计算文件夹顺序：{error}"))?;
    connection.execute(
        "INSERT INTO flashcard_deck_folders(id,name,sort_order,created_at,updated_at) VALUES (?1,?2,?3,?4,?4)",
        params![id,name,sort_order,timestamp],
    ).map_err(|error| if error.to_string().contains("UNIQUE") { "已存在同名文件夹".to_string() } else { format!("无法创建闪卡文件夹：{error}") })?;
    Ok(FlashcardDeckFolderSummary {
        id,
        name: name.to_string(),
        sort_order,
        updated_at: timestamp,
    })
}

pub(crate) fn rename_flashcard_deck(
    connection: &Connection,
    deck_id: String,
    name: String,
) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err("牌组名称应为 1～80 个字符".to_string());
    }
    let changed = connection
        .execute(
            "UPDATE flashcard_decks SET name=?1,updated_at=MAX(updated_at+1,?2) WHERE id=?3",
            params![name, now_timestamp(), deck_id],
        )
        .map_err(|error| {
            if error.to_string().contains("UNIQUE") {
                "已存在同名牌组".to_string()
            } else {
                format!("无法重命名牌组：{error}")
            }
        })?;
    if changed == 0 {
        return Err("牌组不存在".to_string());
    }
    mark_flashcard_sync_dirty(connection)?;
    Ok(())
}

pub(crate) fn rename_flashcard_deck_folder(
    connection: &Connection,
    folder_id: String,
    name: String,
) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err("文件夹名称应为 1～80 个字符".to_string());
    }
    let changed = connection
        .execute(
            "UPDATE flashcard_deck_folders SET name=?1,updated_at=MAX(updated_at+1,?2) WHERE id=?3",
            params![name, now_timestamp(), folder_id],
        )
        .map_err(|error| {
            if error.to_string().contains("UNIQUE") {
                "已存在同名文件夹".to_string()
            } else {
                format!("无法重命名文件夹：{error}")
            }
        })?;
    if changed == 0 {
        return Err("文件夹不存在".to_string());
    }
    mark_flashcard_sync_dirty(connection)?;
    Ok(())
}

pub(crate) fn pin_flashcard_deck_folder(
    connection: &mut Connection,
    folder_id: String,
) -> Result<(), String> {
    let timestamp = now_timestamp();
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开始置顶文件夹：{error}"))?;
    let mut ids = {
        let mut statement = transaction.prepare("SELECT id FROM flashcard_deck_folders WHERE id<>?1 ORDER BY sort_order,name COLLATE NOCASE")
            .map_err(|error| format!("无法读取文件夹顺序：{error}"))?;
        let rows = statement
            .query_map(params![folder_id], |row| row.get::<_, String>(0))
            .map_err(|error| format!("无法读取文件夹顺序：{error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("无法读取文件夹顺序：{error}"))?;
        rows
    };
    let exists = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM flashcard_deck_folders WHERE id=?1)",
            params![folder_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| format!("无法检查文件夹：{error}"))?;
    if !exists {
        return Err("文件夹不存在".to_string());
    }
    ids.insert(0, folder_id);
    for (sort_order, id) in ids.iter().enumerate() {
        transaction
            .execute(
                "UPDATE flashcard_deck_folders SET sort_order=?1,updated_at=?2 WHERE id=?3",
                params![sort_order as i64, timestamp, id],
            )
            .map_err(|error| format!("无法保存文件夹顺序：{error}"))?;
    }
    mark_flashcard_sync_dirty(&transaction)?;
    transaction
        .commit()
        .map_err(|error| format!("无法完成文件夹置顶：{error}"))?;
    Ok(())
}

pub(crate) fn delete_flashcard_deck_folder_in_connection(
    connection: &mut Connection,
    folder_id: &str,
    timestamp: i64,
) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开始删除文件夹：{error}"))?;
    let exists = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM flashcard_deck_folders WHERE id=?1)",
            params![folder_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| format!("无法检查文件夹：{error}"))?;
    if !exists {
        return Err("文件夹不存在".to_string());
    }
    record_flashcard_tombstone(&transaction, "folder", folder_id, timestamp)?;
    transaction
        .execute(
            "DELETE FROM flashcard_deck_folders WHERE id=?1",
            params![folder_id],
        )
        .map_err(|error| format!("无法删除文件夹：{error}"))?;
    let root_start = transaction
        .query_row(
            "SELECT COALESCE(MAX(sort_order),-1)+1 FROM flashcard_decks WHERE folder_id=''",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("无法计算根目录顺序：{error}"))?;
    let moved_ids = {
        let mut statement = transaction
            .prepare(
                "SELECT id FROM flashcard_decks WHERE folder_id=?1 ORDER BY sort_order,name COLLATE NOCASE",
            )
            .map_err(|error| format!("无法读取文件夹内牌组：{error}"))?;
        let rows = statement
            .query_map(params![folder_id], |row| row.get::<_, String>(0))
            .map_err(|error| format!("无法读取文件夹内牌组：{error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("无法收集文件夹内牌组：{error}"))?;
        rows
    };
    for (index, id) in moved_ids.iter().enumerate() {
        transaction
            .execute(
                "UPDATE flashcard_decks SET folder_id='',sort_order=?1,updated_at=MAX(updated_at+1,?2) WHERE id=?3",
                params![root_start + index as i64, timestamp, id],
            )
            .map_err(|error| format!("无法移出文件夹内牌组：{error}"))?;
    }
    mark_flashcard_sync_dirty(&transaction)?;
    transaction
        .commit()
        .map_err(|error| format!("无法完成文件夹删除：{error}"))?;
    Ok(())
}

pub(crate) fn delete_flashcard_deck_in_connection(
    connection: &mut Connection,
    deck_id: &str,
    timestamp: i64,
) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开始删除牌组：{error}"))?;
    let exists = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM flashcard_decks WHERE id=?1)",
            params![deck_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| format!("无法检查牌组：{error}"))?;
    if !exists {
        return Err("牌组不存在".to_string());
    }
    let previous: i64 = transaction
        .query_row(
            "SELECT updated_at FROM flashcard_decks WHERE id=?1",
            [deck_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let timestamp = timestamp.max(previous.saturating_add(1));
    promote_children(&transaction, deck_id, timestamp)?;
    record_flashcard_tombstone(&transaction, "deck", deck_id, timestamp)?;
    // No Vec of all card IDs: preserve every tombstone inside the same transaction.
    transaction.execute("INSERT INTO flashcard_sync_tombstones(entity_type,entity_id,deleted_at)
        SELECT 'card',id,?2 FROM flashcards WHERE deck_id=?1
        ON CONFLICT(entity_type,entity_id) DO UPDATE SET deleted_at=MAX(deleted_at,excluded.deleted_at)",
        params![deck_id,timestamp]).map_err(|e|e.to_string())?;
    transaction
        .execute(
            "DELETE FROM flashcard_reviews WHERE card_id IN (SELECT id FROM flashcards WHERE deck_id=?1)",
            params![deck_id],
        )
        .map_err(|error| format!("无法删除牌组复习记录：{error}"))?;
    transaction
        .execute("DELETE FROM flashcards WHERE deck_id=?1", params![deck_id])
        .map_err(|error| format!("无法删除牌组内闪卡：{error}"))?;
    transaction
        .execute("DELETE FROM flashcard_decks WHERE id=?1", params![deck_id])
        .map_err(|error| format!("无法删除牌组：{error}"))?;
    mark_flashcard_sync_dirty(&transaction)?;
    transaction
        .commit()
        .map_err(|error| format!("无法完成牌组删除：{error}"))?;
    Ok(())
}

pub(crate) fn delete_flashcard_deck_folder(
    connection: &mut Connection,
    folder_id: String,
) -> Result<(), String> {
    delete_flashcard_deck_folder_in_connection(connection, &folder_id, now_timestamp())
}

pub(crate) fn delete_flashcard_deck(
    connection: &mut Connection,
    deck_id: String,
) -> Result<(), String> {
    delete_flashcard_deck_in_connection(connection, &deck_id, now_timestamp())
}

pub(crate) fn move_flashcard_deck(
    connection: &mut Connection,
    deck_id: String,
    folder_id: Option<String>,
    before_deck_id: Option<String>,
) -> Result<(), String> {
    let folder_id = folder_id.unwrap_or_default();
    if !folder_id.is_empty() {
        let exists = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM flashcard_deck_folders WHERE id=?1)",
                params![folder_id],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|error| format!("无法检查目标文件夹：{error}"))?;
        if !exists {
            return Err("目标文件夹不存在".to_string());
        }
    }
    let timestamp = now_timestamp();
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开始移动牌组：{error}"))?;
    let exists = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM flashcard_decks WHERE id=?1)",
            params![deck_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| format!("无法检查牌组：{error}"))?;
    if !exists {
        return Err("牌组不存在".to_string());
    }
    let parent = if let Some(before) = before_deck_id.as_deref() {
        let (parent, before_folder) = placement(&transaction, before)?;
        if before_folder != folder_id {
            return Err("排序目标不在目标文件夹中".into());
        }
        parent
    } else {
        String::new()
    };
    validate_parent(&transaction, &deck_id, &parent)?;
    transaction
        .execute(
            "UPDATE flashcard_decks SET parent_deck_id=?1 WHERE id=?2",
            params![parent, deck_id],
        )
        .map_err(|e| e.to_string())?;
    update_subtree_folder(&transaction, &deck_id, &folder_id, timestamp)?;
    let mut ordered_ids = {
        let mut statement = transaction.prepare(
            "SELECT id FROM flashcard_decks WHERE folder_id=?1 AND id<>?2 AND parent_deck_id=?3 ORDER BY sort_order,name COLLATE NOCASE",
        ).map_err(|error| format!("无法读取牌组顺序：{error}"))?;
        let rows = statement
            .query_map(params![folder_id, deck_id, parent], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|error| format!("无法读取牌组顺序：{error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("无法读取牌组顺序：{error}"))?
    };
    let insert_at = before_deck_id
        .as_deref()
        .and_then(|before_id| ordered_ids.iter().position(|id| id == before_id))
        .unwrap_or(ordered_ids.len());
    ordered_ids.insert(insert_at, deck_id.clone());
    for (sort_order, ordered_id) in ordered_ids.iter().enumerate() {
        transaction
            .execute(
                "UPDATE flashcard_decks SET folder_id=?1,sort_order=?2,updated_at=MAX(updated_at+1,?3) WHERE id=?4",
                params![folder_id, sort_order as i64, timestamp, ordered_id],
            )
            .map_err(|error| format!("无法保存牌组顺序：{error}"))?;
    }
    mark_flashcard_sync_dirty(&transaction)?;
    transaction
        .commit()
        .map_err(|error| format!("无法完成牌组移动：{error}"))?;
    Ok(())
}
