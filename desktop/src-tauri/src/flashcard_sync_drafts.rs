//! Inbox wire contract and monotonic resolution; shared by every sync provider.
use super::*;
use crate::flashcard_authoring::{import_flashcard_values, resolve_flashcard_drafts_in_connection};
use crate::flashcard_store::flashcard_draft_from_row;
use crate::flashcard_store::FLASHCARD_DRAFT_SELECT_FIELDS;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SnapshotDraft {
    #[serde(flatten)]
    draft: FlashcardDraft,
    status: String,
    updated_at: i64,
}

pub(super) fn identity(item: &SnapshotDraft) -> &str {
    &item.draft.id
}
pub(super) fn precedence(item: &SnapshotDraft) -> Result<(u8, i64), String> {
    Ok((rank(&item.status)?, item.updated_at))
}

pub(super) fn snapshot(connection: &Connection) -> Result<Vec<SnapshotDraft>, String> {
    let mut query = connection
        .prepare(&format!(
        "SELECT {FLASHCARD_DRAFT_SELECT_FIELDS},status,updated_at FROM flashcard_drafts ORDER BY id"
    ))
        .map_err(|e| format!("无法读取收件箱同步状态：{e}"))?;
    let rows = query
        .query_map([], |row| from_row(row))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub(crate) fn from_row(row: &Row<'_>) -> rusqlite::Result<SnapshotDraft> {
    Ok(SnapshotDraft {
        draft: flashcard_draft_from_row(row)?,
        status: row.get(22)?,
        updated_at: row.get(23)?,
    })
}

pub(crate) fn get(connection: &Connection, id: &str) -> Result<Option<SnapshotDraft>, String> {
    connection.query_row(
        &format!("SELECT {FLASHCARD_DRAFT_SELECT_FIELDS},status,updated_at FROM flashcard_drafts WHERE id=?1"),
        [id], from_row,
    ).optional().map_err(|e| e.to_string())
}

fn rank(status: &str) -> Result<u8, String> {
    match status {
        "pending" => Ok(0),
        "duplicate" => Ok(1),
        "rejected" => Ok(2),
        "accepted" => Ok(3),
        _ => Err("远端收件箱状态无效".into()),
    }
}

pub(super) fn accepted_card_id(draft_id: &str) -> String {
    format!("card-draft-{:x}", Sha256::digest(draft_id.as_bytes()))
}

pub(super) fn merge(connection: &Connection, drafts: &[SnapshotDraft]) -> Result<(), String> {
    let mut local_items = HashMap::new();
    for item in drafts {
        if !local_items.contains_key(identity(item)) {
            if let Some(local) = get(connection, identity(item))? {
                local_items.insert(local.draft.id.clone(), local);
            }
        }
    }
    for item in drafts {
        let draft = &item.draft;
        let incoming_rank = rank(&item.status)?;
        if draft.id.is_empty() || draft.id.len() > 240 || draft.batch_id.is_empty() {
            return Err("远端收件箱身份无效".into());
        }
        if let Some(local) = local_items.get(&draft.id) {
            let local_rank = rank(&local.status)?;
            // Resolution is irreversible through sync; an offline pending copy never resurrects.
            if local_rank > incoming_rank
                || (local_rank == incoming_rank
                    && (local.updated_at > item.updated_at
                        || (local.updated_at == item.updated_at
                            && serde_json::to_vec(local).map_err(|e| e.to_string())?
                                >= serde_json::to_vec(item).map_err(|e| e.to_string())?)))
            {
                continue;
            }
        }
        connection.execute(
            "INSERT OR IGNORE INTO flashcard_import_batches
             (id,format,source_path,deck_name,imported_at,total_count,valid_count,duplicate_count,invalid_count)
             VALUES (?1,'hub-flashcards-v1','cloud-sync',?2,?3,0,0,0,0)",
            params![draft.batch_id,draft.deck_name,draft.created_at]
        ).map_err(|e| format!("无法合并收件箱批次：{e}"))?;
        connection.execute(
            "INSERT INTO flashcard_drafts
             (id,batch_id,deck_name,question,answer,explanation,card_type,source_library_id,source_document_id,
              source_block_id,source_title,source_path,source_hash,media_json,tags_json,evidence,confidence,
              generation_json,idempotency_key,status,created_at,updated_at,card_data_json,custom_fields_json)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24)
             ON CONFLICT(id) DO UPDATE SET question=excluded.question,answer=excluded.answer,
              explanation=excluded.explanation,card_type=excluded.card_type,media_json=excluded.media_json,
              tags_json=excluded.tags_json,evidence=excluded.evidence,confidence=excluded.confidence,
              generation_json=excluded.generation_json,status=excluded.status,updated_at=excluded.updated_at,
              deck_name=excluded.deck_name,source_library_id=excluded.source_library_id,source_document_id=excluded.source_document_id,
              source_block_id=excluded.source_block_id,source_title=excluded.source_title,source_path=excluded.source_path,source_hash=excluded.source_hash,
              idempotency_key=excluded.idempotency_key,
              card_data_json=excluded.card_data_json,custom_fields_json=excluded.custom_fields_json",
            params![draft.id,draft.batch_id,draft.deck_name,draft.question,draft.answer,draft.explanation,
                draft.card_type,draft.source_library_id,draft.source_document_id,draft.source_block_id,
                draft.source_title,draft.source_path,draft.source_hash,draft.media.to_string(),draft.tags.to_string(),
                draft.evidence,draft.confidence,draft.generation.to_string(),draft.idempotency_key,item.status,
                draft.created_at,item.updated_at,draft.card_data.to_string(),draft.custom_fields.to_string()]
        ).map_err(|e| format!("无法合并收件箱：{e}"))?;
        local_items.insert(draft.id.clone(), item.clone());
    }
    Ok(())
}

pub(super) fn media(drafts: &[SnapshotDraft]) -> Vec<&Value> {
    drafts
        .iter()
        // Resolved drafts still travel in snapshots and full backups. Their
        // attachment references must remain downloadable on a new device.
        .flat_map(|d| d.draft.media.as_array().into_iter().flatten())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn database(label: &str) -> PathBuf {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../artifacts/cloud-sync-20261002/rust-cases")
            .join(format!("{label}-{}", random_url_safe(8)));
        fs::create_dir_all(&root).unwrap();
        root.join("craft-search.sqlite3")
    }
    #[test]
    fn offline_acceptance_on_two_devices_converges_to_one_card_and_cannot_resurrect() {
        let a = database("draft-a");
        let b = database("draft-b");
        let result = import_flashcard_values(
            &a,
            "manual",
            "收件箱".into(),
            json!({"source":"manual"}),
            vec![json!({"question":"连接器为什么需要防呆？","answer":"避免错误插接"})],
            true,
        )
        .unwrap();
        assert_eq!(result.imported, 1);
        let mut ca = open_database(&a).unwrap();
        let mut cb = open_database(&b).unwrap();
        let pending = local_flashcard_snapshot(&ca).unwrap();
        assert_eq!(pending.drafts.len(), 1);
        let id = pending.drafts[0].draft.id.clone();
        merge_flashcard_snapshot(&mut cb, &pending).unwrap();
        let da = ensure_flashcard_deck(&ca, "A").unwrap();
        let db = ensure_flashcard_deck(&cb, "B").unwrap();
        resolve_flashcard_drafts_in_connection(&mut ca, vec![id.clone()], true, Some(da)).unwrap();
        resolve_flashcard_drafts_in_connection(&mut cb, vec![id.clone()], true, Some(db)).unwrap();
        let sa = local_flashcard_snapshot(&ca).unwrap();
        let sb = local_flashcard_snapshot(&cb).unwrap();
        merge_flashcard_snapshot(&mut ca, &sb).unwrap();
        merge_flashcard_snapshot(&mut cb, &sa).unwrap();
        let sa = local_flashcard_snapshot(&ca).unwrap();
        let sb = local_flashcard_snapshot(&cb).unwrap();
        assert_eq!(sa.cards.len(), 1);
        assert_eq!(sb.cards.len(), 1);
        assert_eq!(sa.cards[0].id, accepted_card_id(&id));
        assert_eq!(
            serde_json::to_value(&sa.cards).unwrap(),
            serde_json::to_value(&sb.cards).unwrap()
        );
        merge_flashcard_snapshot(&mut ca, &pending).unwrap();
        assert_eq!(snapshot(&ca).unwrap()[0].status, "accepted");
        drop(ca);
        let reopened = open_database(&a).unwrap();
        assert_eq!(snapshot(&reopened).unwrap()[0].status, "accepted");
        assert!(metadata_bool(&reopened, "flashcard_sync_dirty", false));
    }
    #[test]
    fn draft_wire_roundtrip_carries_attachment_and_rejection() {
        let a = database("draft-media");
        let b = database("draft-media-remote");
        let hash = "a".repeat(64);
        import_flashcard_values(&a,"manual","收件箱".into(),json!({"source":"manual"}),vec![json!({"question":"图中是什么？","answer":"插接器","media":[{"url":format!("http://craft-media.localhost/{hash}"),"mimeType":"image/png","title":"参考图"}]})],true).unwrap();
        let mut c = open_database(&a).unwrap();
        let before = local_flashcard_snapshot(&c).unwrap();
        assert!(flashcard_snapshot_media_hashes(&before).contains(&hash));
        let wire = serde_json::to_vec(&before).unwrap();
        let decoded: FlashcardSyncSnapshot = serde_json::from_slice(&wire).unwrap();
        let mut target = open_database(&b).unwrap();
        merge_flashcard_snapshot(&mut target, &decoded).unwrap();
        let id = decoded.drafts[0].draft.id.clone();
        resolve_flashcard_drafts_in_connection(&mut c, vec![id], false, None).unwrap();
        merge_flashcard_snapshot(&mut target, &local_flashcard_snapshot(&c).unwrap()).unwrap();
        merge_flashcard_snapshot(&mut target, &decoded).unwrap();
        assert_eq!(snapshot(&target).unwrap()[0].status, "rejected");
        assert!(
            flashcard_snapshot_media_hashes(&local_flashcard_snapshot(&target).unwrap())
                .contains(&hash),
            "Rejected draft history still requires its original attachment for full recovery"
        );
        assert!(metadata_bool(&c, "flashcard_sync_dirty", false));
    }
}
