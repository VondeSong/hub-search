//! Flashcard editing, draft admission and source-grounded import ownership.
use crate::flashcard_models::*;
use crate::flashcard_store::{
    flashcard_by_id, flashcard_draft_from_row, mark_flashcard_sync_dirty,
    FLASHCARD_DRAFT_SELECT_FIELDS,
};
use crate::flashcard_validation::{
    flashcard_import_source_text, flashcard_import_text, normalize_flashcard_custom_fields,
    normalize_flashcard_editor_fields, normalize_flashcard_media, normalize_flashcard_tag_values,
};
use crate::{
    blob_store_for, database_path, flashcard_quality, flashcard_query, flashcard_sync_drafts,
    media_protocol_url, now_timestamp, open_database, open_write_database, random_url_safe,
    AppState,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};
use tauri::AppHandle;
use tauri::State;

pub(crate) fn read_flashcard_import_file(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("无法读取闪卡数据文件：{error}"))?;
    if !metadata.is_file() {
        return Err("选择的闪卡数据不是文件".to_string());
    }
    if metadata.len() > FLASHCARD_IMPORT_MAX_BYTES {
        return Err("闪卡数据文件不能超过 16 MB".to_string());
    }
    fs::read(path).map_err(|error| format!("无法读取闪卡数据文件：{error}"))
}

pub(crate) fn parse_flashcard_jsonl(bytes: &[u8]) -> Result<Vec<Value>, String> {
    let text =
        std::str::from_utf8(bytes).map_err(|_| "闪卡 JSONL 必须使用 UTF-8 编码".to_string())?;
    let mut values = Vec::new();
    for (index, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let value = serde_json::from_str::<Value>(line)
            .map_err(|error| format!("JSONL 第 {} 行无效：{error}", index + 1))?;
        if !value.is_object() {
            return Err(format!("JSONL 第 {} 行必须是 JSON 对象", index + 1));
        }
        values.push(value);
        if values.len() > FLASHCARD_IMPORT_MAX_CARDS + 1 {
            return Err("一次最多导入 5000 张闪卡".to_string());
        }
    }
    Ok(values)
}

pub(crate) fn validate_flashcard_manifest(manifest: &Value) -> Result<(), String> {
    if manifest.get("format").and_then(Value::as_str) != Some("hub-flashcards-v1") {
        return Err("不是 hub-flashcards-v1 闪卡数据包".to_string());
    }
    let version = manifest
        .get("version")
        .or_else(|| manifest.get("schemaVersion"))
        .and_then(|value| value.as_u64().or_else(|| value.as_str()?.parse().ok()))
        .unwrap_or(1);
    if version != 1 {
        return Err(format!("不支持闪卡数据版本 {version}"));
    }
    Ok(())
}

pub(crate) fn parse_flashcard_bundle(path: &Path) -> Result<(String, Value, Vec<Value>), String> {
    let bytes = read_flashcard_import_file(path)?;
    let is_jsonl = path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("jsonl"));
    let (manifest, mut cards) = if is_jsonl {
        let mut values = parse_flashcard_jsonl(&bytes)?;
        if values.is_empty() {
            return Err("闪卡 JSONL 文件是空的".to_string());
        }
        let manifest = values.remove(0);
        (manifest, values)
    } else {
        let manifest = serde_json::from_slice::<Value>(&bytes)
            .map_err(|error| format!("闪卡 JSON 无效：{error}"))?;
        let cards = manifest
            .get("cards")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        (manifest, cards)
    };
    validate_flashcard_manifest(&manifest)?;
    if cards.is_empty() {
        if let Some(cards_file) = manifest.get("cardsFile").and_then(Value::as_str) {
            let parent = path.parent().unwrap_or_else(|| Path::new("."));
            let base = parent
                .canonicalize()
                .map_err(|error| format!("无法定位数据包目录：{error}"))?;
            let candidate = parent.join(cards_file);
            let resolved = candidate
                .canonicalize()
                .map_err(|error| format!("无法读取 cardsFile：{error}"))?;
            if !resolved.starts_with(&base) {
                return Err("cardsFile 必须位于数据包目录内".to_string());
            }
            cards = parse_flashcard_jsonl(&read_flashcard_import_file(&resolved)?)?;
        }
    }
    if cards.is_empty() {
        return Err("数据包中没有闪卡".to_string());
    }
    if cards.len() > FLASHCARD_IMPORT_MAX_CARDS {
        return Err("一次最多导入 5000 张闪卡".to_string());
    }
    let deck_name = flashcard_import_text(&manifest, &["deckName", "deck_name"]);
    let deck_name = if deck_name.is_empty() {
        manifest
            .get("deck")
            .and_then(|deck| deck.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("Codex 闪卡")
            .trim()
            .to_string()
    } else {
        deck_name
    };
    let generation = manifest
        .get("generator")
        .or_else(|| manifest.get("generation"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    Ok((deck_name.chars().take(120).collect(), generation, cards))
}

pub(crate) fn flashcard_import_media(value: &Value) -> Value {
    normalize_flashcard_media(value.get("media"))
}

pub(crate) fn flashcard_import_tags(value: &Value) -> Value {
    let mut seen = HashSet::new();
    let tags = value
        .get("tags")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|tag| !tag.is_empty())
        .map(|tag| tag.chars().take(60).collect::<String>())
        .filter(|tag| seen.insert(tag.to_lowercase()))
        .take(20)
        .map(Value::String)
        .collect();
    Value::Array(tags)
}

pub(crate) fn flashcard_import_evidence(value: &Value) -> String {
    let direct = flashcard_import_text(value, &["evidenceText", "evidence_text"]);
    if !direct.is_empty() {
        return direct.chars().take(2_000).collect();
    }
    match value.get("evidence") {
        Some(Value::String(text)) => text.trim().chars().take(2_000).collect(),
        Some(evidence) => flashcard_import_text(evidence, &["text", "quote"])
            .chars()
            .take(2_000)
            .collect(),
        None => String::new(),
    }
}

pub(crate) fn flashcard_import_card_data(value: &Value, card_type: &str) -> Value {
    if let Some(data) = value
        .get("cardData")
        .or_else(|| value.get("card_data"))
        .filter(|data| data.is_object())
    {
        return data.clone();
    }
    match card_type {
        "multiple_choice" => json!({
            "options": value.get("options").cloned().unwrap_or_else(|| json!([])),
            "correctIndex": value.get("correctIndex").or_else(|| value.get("correct_index")).cloned().unwrap_or(Value::Null),
        }),
        "ordering" => json!({
            "items": value.get("items").cloned().unwrap_or_else(|| json!([])),
        }),
        "image_occlusion" => json!({
            "occlusions": value.get("occlusions").cloned().unwrap_or_else(|| json!([])),
        }),
        _ => json!({}),
    }
}

pub(crate) fn flashcard_draft_from_value(
    value: &Value,
    batch_id: &str,
    default_deck_name: &str,
    default_generation: &Value,
    timestamp: i64,
) -> Result<FlashcardDraft, String> {
    if !value.is_object() {
        return Err("卡片必须是 JSON 对象".to_string());
    }
    let question = flashcard_import_text(value, &["question", "front"]);
    let answer = flashcard_import_text(value, &["answer", "back"]);
    if question.chars().count() < 3 {
        return Err("问题至少需要 3 个字符".to_string());
    }
    if answer.is_empty() {
        return Err("答案不能为空".to_string());
    }
    if question.chars().count() > 1_000 || answer.chars().count() > 4_000 {
        return Err("问题或答案超过长度限制".to_string());
    }
    let card_type = flashcard_import_text(value, &["cardType", "card_type"]);
    let card_type = match card_type.as_str() {
        "" | "qa" => "qa".to_string(),
        "cloze" => "cloze".to_string(),
        "multiple_choice" => "multiple_choice".to_string(),
        "typed_answer" => "typed_answer".to_string(),
        "ordering" => "ordering".to_string(),
        "image_occlusion" => "image_occlusion".to_string(),
        _ => return Err(
            "cardType 必须是 qa、cloze、multiple_choice、typed_answer、ordering 或 image_occlusion"
                .to_string(),
        ),
    };
    let explanation = flashcard_import_text(value, &["explanation", "reason"]);
    let raw_card_data = flashcard_import_card_data(value, &card_type);
    let (question, answer, explanation, card_type, card_data) = normalize_flashcard_editor_fields(
        &question,
        &answer,
        &explanation,
        &card_type,
        Some(&raw_card_data),
    )?;
    let confidence = value.get("confidence").and_then(|item| {
        item.as_f64()
            .or_else(|| item.as_str().and_then(|text| text.parse().ok()))
    });
    if confidence.is_some_and(|score| !score.is_finite() || !(0.0..=1.0).contains(&score)) {
        return Err("confidence 必须在 0 到 1 之间".to_string());
    }
    let source_library_id =
        flashcard_import_source_text(value, &["sourceLibraryId", "source_library_id"]);
    let source_document_id =
        flashcard_import_source_text(value, &["sourceDocumentId", "source_document_id"]);
    let source_block_id =
        flashcard_import_source_text(value, &["sourceBlockId", "source_block_id"]);
    let source_hash = flashcard_import_source_text(value, &["sourceHash", "source_hash"]);
    let explicit_key = flashcard_import_text(value, &["idempotencyKey", "idempotency_key"]);
    let idempotency_key = if explicit_key.is_empty() {
        let canonical = format!(
            "{}\n{}\n{}\n{}",
            question.to_lowercase(),
            answer.to_lowercase(),
            source_library_id,
            source_document_id
        );
        format!("sha256:{:x}", Sha256::digest(canonical.as_bytes()))
    } else {
        explicit_key.chars().take(240).collect()
    };
    let deck_name = flashcard_import_text(value, &["deckName", "deck_name"]);
    let generation = value
        .get("generation")
        .cloned()
        .unwrap_or_else(|| default_generation.clone());
    let media = flashcard_import_media(value);
    if card_type == "image_occlusion"
        && !media.as_array().is_some_and(|items| {
            items.iter().any(|item| {
                item.get("mimeType")
                    .and_then(Value::as_str)
                    .is_some_and(|value| value.starts_with("image/"))
            })
        })
    {
        return Err("图片遮挡卡需要 media 中包含一张有效图片".to_string());
    }
    Ok(FlashcardDraft {
        id: format!("draft-{}", random_url_safe(14)),
        batch_id: batch_id.to_string(),
        deck_name: if deck_name.is_empty() {
            default_deck_name.to_string()
        } else {
            deck_name.chars().take(120).collect()
        },
        question,
        answer,
        explanation,
        card_type,
        card_data,
        source_library_id,
        source_document_id,
        source_block_id,
        source_title: flashcard_import_source_text(value, &["sourceTitle", "source_title"])
            .chars()
            .take(500)
            .collect(),
        source_path: flashcard_import_source_text(value, &["sourcePath", "source_path"])
            .chars()
            .take(2_000)
            .collect(),
        source_hash,
        media,
        tags: flashcard_import_tags(value),
        custom_fields: normalize_flashcard_custom_fields(value.get("customFields")),
        evidence: flashcard_import_evidence(value),
        confidence,
        generation,
        idempotency_key,
        created_at: timestamp,
    })
}

#[tauri::command]
pub(crate) fn list_flashcard_drafts(app: AppHandle) -> Result<Vec<FlashcardDraft>, String> {
    let connection = open_database(&database_path(&app)?)?;
    let mut statement = connection.prepare(&format!(
        "SELECT {FLASHCARD_DRAFT_SELECT_FIELDS} FROM flashcard_drafts WHERE status='pending' ORDER BY created_at DESC,id"
    )).map_err(|error| format!("无法准备闪卡收件箱：{error}"))?;
    let rows = statement
        .query_map([], flashcard_draft_from_row)
        .map_err(|error| format!("无法读取闪卡收件箱：{error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法收集闪卡草稿：{error}"))
}

pub(crate) fn import_flashcard_values(
    database: &PathBuf,
    source_label: &str,
    deck_name: String,
    generation: Value,
    values: Vec<Value>,
    allow_duplicate: bool,
) -> Result<FlashcardImportResult, String> {
    let (mut connection, _writer) = open_write_database(database)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开始导入闪卡：{error}"))?;
    let result = import_flashcard_values_on(
        &transaction,
        source_label,
        deck_name,
        generation,
        values,
        allow_duplicate,
    )?;
    transaction
        .commit()
        .map_err(|error| format!("无法提交闪卡导入：{error}"))?;
    Ok(result)
}

/// The same admission owner, inside a caller-owned transaction. Agent actions
/// can commit their authorization and receipt atomically with inbox drafts.
pub(crate) fn import_flashcard_values_on(
    transaction: &Connection,
    source_label: &str,
    deck_name: String,
    generation: Value,
    values: Vec<Value>,
    allow_duplicate: bool,
) -> Result<FlashcardImportResult, String> {
    if transaction.is_autocommit() {
        return Err("闪卡导入必须处于调用者事务内".into());
    }
    let timestamp = now_timestamp();
    let batch_id = format!("batch-{}", random_url_safe(14));
    let quality_required = matches!(
        source_label,
        "mcp://hub/submit_flashcard_drafts" | "agent://hub/flashcard-drafts"
    );
    let generation = if quality_required {
        flashcard_quality::submission_generation(&transaction, &generation, &values, &deck_name)?
    } else {
        generation
    };
    let mut imported = 0;
    let mut duplicates = 0;
    let mut invalid = 0;
    let mut errors = Vec::new();
    transaction.execute(
        "INSERT INTO flashcard_import_batches
           (id,format,source_path,deck_name,imported_at,total_count,valid_count,duplicate_count,invalid_count)
         VALUES (?1,'hub-flashcards-v1',?2,?3,?4,?5,0,0,0)",
        params![batch_id, source_label, deck_name, timestamp, values.len() as i64],
    ).map_err(|error| format!("无法创建闪卡导入批次：{error}"))?;
    for (index, value) in values.iter().enumerate() {
        let mut draft = match flashcard_draft_from_value(
            value,
            &batch_id,
            &deck_name,
            &generation,
            timestamp,
        ) {
            Ok(draft) => draft,
            Err(error) => {
                invalid += 1;
                if errors.len() < 20 {
                    errors.push(format!("第 {} 张：{error}", index + 1));
                }
                continue;
            }
        };
        if quality_required {
            // A per-card generation object cannot erase or forge the batch's reviewed context.
            if !draft.generation.is_object() {
                draft.generation = json!({});
            }
            if let Some(context) = generation.get("qualityContext") {
                draft.generation["qualityContext"] = context.clone();
            } else if let Some(object) = draft.generation.as_object_mut() {
                object.remove("qualityContext");
            }
        }
        let duplicate = transaction.query_row(
            "SELECT EXISTS(
               SELECT 1 FROM flashcards WHERE status IN ('active','suspended') AND question=?1 COLLATE NOCASE AND answer=?2 COLLATE NOCASE
               UNION ALL
               SELECT 1 FROM flashcard_drafts WHERE status='pending' AND (idempotency_key=?3 OR (question=?1 COLLATE NOCASE AND answer=?2 COLLATE NOCASE))
             )",
            params![draft.question, draft.answer, draft.idempotency_key],
            |row| row.get::<_, i64>(0),
        ).unwrap_or(0) != 0;
        if duplicate && !allow_duplicate {
            duplicates += 1;
            continue;
        }
        transaction.execute(
            "INSERT INTO flashcard_drafts
               (id,batch_id,deck_name,question,answer,explanation,card_type,source_library_id,source_document_id,
                source_block_id,source_title,source_path,source_hash,media_json,tags_json,evidence,confidence,
                generation_json,idempotency_key,status,created_at,updated_at,card_data_json,custom_fields_json)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,'pending',?20,?20,?21,?22)",
            params![draft.id, draft.batch_id, draft.deck_name, draft.question, draft.answer, draft.explanation,
                draft.card_type, draft.source_library_id, draft.source_document_id, draft.source_block_id,
                draft.source_title, draft.source_path, draft.source_hash, draft.media.to_string(), draft.tags.to_string(),
                draft.evidence, draft.confidence, draft.generation.to_string(), draft.idempotency_key, timestamp,
                draft.card_data.to_string(), draft.custom_fields.to_string()],
        ).map_err(|error| format!("无法写入闪卡草稿：{error}"))?;
        imported += 1;
    }
    transaction
        .execute(
            "UPDATE flashcard_import_batches
         SET valid_count=?1,duplicate_count=?2,invalid_count=?3 WHERE id=?4",
            params![imported as i64, duplicates as i64, invalid as i64, batch_id],
        )
        .map_err(|error| format!("无法记录闪卡导入结果：{error}"))?;
    if imported > 0 {
        mark_flashcard_sync_dirty(&transaction)?;
    }
    Ok(FlashcardImportResult {
        batch_id,
        total: values.len(),
        imported,
        duplicates,
        invalid,
        errors,
    })
}

#[tauri::command]
pub(crate) fn create_flashcard_draft(
    app: AppHandle,
    question: String,
    answer: String,
    explanation: String,
    card_type: String,
    card_data: Option<Value>,
    media: Option<Value>,
    source_title: Option<String>,
    source_path: Option<String>,
    tags: Option<Vec<String>>,
    custom_fields: Option<Value>,
) -> Result<FlashcardDraft, String> {
    let value = json!({
        "question": question, "answer": answer, "explanation": explanation,
        "cardType": card_type, "cardData": card_data.unwrap_or_else(|| json!({})),
        "media": media.unwrap_or_else(|| json!([])),
        "sourceTitle": source_title.unwrap_or_default(),
        "sourcePath": source_path.unwrap_or_default(),
        "tags": tags.unwrap_or_default(),
        "customFields": custom_fields.unwrap_or_else(|| json!({})),
    });
    let database = database_path(&app)?;
    let result = import_flashcard_values(
        &database,
        "manual",
        "收件箱".to_string(),
        json!({"source": "manual"}),
        vec![value],
        true,
    )?;
    if result.imported == 0 {
        return Err(result
            .errors
            .into_iter()
            .next()
            .unwrap_or_else(|| "收件箱已有相同的卡片".to_string()));
    }
    let connection = open_database(&database)?;
    connection.query_row(
        &format!("SELECT {FLASHCARD_DRAFT_SELECT_FIELDS} FROM flashcard_drafts WHERE batch_id=?1 LIMIT 1"),
        params![result.batch_id], flashcard_draft_from_row,
    ).map_err(|error| format!("无法读取新建的收件箱卡片：{error}"))
}

#[tauri::command]
pub(crate) fn import_flashcard_bundle(
    app: AppHandle,
    path: String,
) -> Result<FlashcardImportResult, String> {
    let source_path = PathBuf::from(path.trim());
    let (deck_name, generation, values) = parse_flashcard_bundle(&source_path)?;
    import_flashcard_values(
        &database_path(&app)?,
        &source_path.to_string_lossy(),
        deck_name,
        generation,
        values,
        false,
    )
}

#[tauri::command]
pub(crate) fn resolve_flashcard_drafts(
    app: AppHandle,
    draft_ids: Vec<String>,
    accept: bool,
    target_deck_id: Option<String>,
) -> Result<FlashcardDraftResolutionResult, String> {
    let (mut connection, _writer) = open_write_database(&database_path(&app)?)?;
    resolve_flashcard_drafts_in_connection(&mut connection, draft_ids, accept, target_deck_id)
}

pub(crate) fn resolve_flashcard_drafts_in_connection(
    connection: &mut Connection,
    draft_ids: Vec<String>,
    accept: bool,
    target_deck_id: Option<String>,
) -> Result<FlashcardDraftResolutionResult, String> {
    if draft_ids.is_empty() || draft_ids.len() > FLASHCARD_IMPORT_MAX_CARDS {
        return Err("没有选择需要处理的闪卡草稿".to_string());
    }
    let target_deck_id = if accept {
        Some(
            target_deck_id
                .filter(|id| !id.trim().is_empty())
                .ok_or("请先选择目标牌组")?,
        )
    } else {
        None
    };
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开始处理闪卡草稿：{error}"))?;
    if accept {
        if let Some(deck_id) = &target_deck_id {
            let exists: bool = transaction
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM flashcard_decks WHERE id=?1)",
                    params![deck_id],
                    |row| row.get(0),
                )
                .map_err(|error| format!("无法检查目标牌组：{error}"))?;
            if !exists {
                return Err("目标牌组不存在".to_string());
            }
        }
    }
    let timestamp = now_timestamp();
    let mut accepted = 0;
    let mut rejected = 0;
    let mut skipped = 0;
    let mut deck_ids = HashSet::new();
    for draft_id in draft_ids {
        let draft = transaction.query_row(
            &format!("SELECT {FLASHCARD_DRAFT_SELECT_FIELDS} FROM flashcard_drafts WHERE id=?1 AND status='pending'"),
            params![draft_id], flashcard_draft_from_row,
        ).optional().map_err(|error| format!("无法读取闪卡草稿：{error}"))?;
        let Some(draft) = draft else {
            skipped += 1;
            continue;
        };
        if !accept {
            transaction
                .execute(
                    "UPDATE flashcard_drafts SET status='rejected',updated_at=?1 WHERE id=?2",
                    params![timestamp, draft.id],
                )
                .map_err(|error| format!("无法拒绝闪卡草稿：{error}"))?;
            rejected += 1;
            continue;
        }
        let duplicate = transaction.query_row(
            "SELECT COUNT(*) FROM flashcards WHERE status IN ('active','suspended') AND question=?1 COLLATE NOCASE AND answer=?2 COLLATE NOCASE",
            params![draft.question, draft.answer], |row| row.get::<_, i64>(0),
        ).unwrap_or(0) > 0;
        if duplicate && draft.generation.get("source").and_then(Value::as_str) != Some("manual") {
            transaction
                .execute(
                    "UPDATE flashcard_drafts SET status='duplicate',updated_at=?1 WHERE id=?2",
                    params![timestamp, draft.id],
                )
                .map_err(|error| format!("无法标记重复闪卡：{error}"))?;
            skipped += 1;
            continue;
        }
        let deck_id = target_deck_id.as_ref().expect("已验证目标牌组").clone();
        let card_id = flashcard_sync_drafts::accepted_card_id(&draft.id);
        transaction.execute(
            "INSERT INTO flashcards
               (id,deck_id,question,answer,explanation,card_type,source_library_id,source_document_id,source_block_id,
                source_title,source_path,source_hash,media_json,status,created_at,updated_at,due_at,card_data_json,
                tags_json,evidence,confidence,generation_json,custom_fields_json)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,'active',?14,?14,?14,?15,?16,?17,?18,?19,?20)",
            params![card_id, deck_id, draft.question, draft.answer, draft.explanation, draft.card_type,
                draft.source_library_id, draft.source_document_id, draft.source_block_id, draft.source_title,
                draft.source_path, draft.source_hash, draft.media.to_string(), timestamp, draft.card_data.to_string(),
                draft.tags.to_string(), draft.evidence, draft.confidence, draft.generation.to_string(), draft.custom_fields.to_string()],
        ).map_err(|error| format!("无法接受闪卡草稿：{error}"))?;
        transaction
            .execute(
                "UPDATE flashcard_drafts SET status='accepted',updated_at=?1 WHERE id=?2",
                params![timestamp, draft.id],
            )
            .map_err(|error| format!("无法更新闪卡草稿状态：{error}"))?;
        transaction
            .execute(
                "UPDATE flashcard_decks SET updated_at=?1 WHERE id=?2",
                params![timestamp, deck_id],
            )
            .map_err(|error| format!("无法更新闪卡牌组：{error}"))?;
        deck_ids.insert(deck_id);
        accepted += 1;
    }
    if accepted > 0 || rejected > 0 || skipped > 0 {
        mark_flashcard_sync_dirty(&transaction)?;
    }
    transaction
        .commit()
        .map_err(|error| format!("无法提交闪卡草稿处理结果：{error}"))?;
    let mut deck_ids = deck_ids.into_iter().collect::<Vec<_>>();
    deck_ids.sort();
    Ok(FlashcardDraftResolutionResult {
        accepted,
        rejected,
        skipped,
        deck_ids,
    })
}

#[tauri::command]
pub(crate) fn delete_flashcard(app: AppHandle, card_id: String) -> Result<(), String> {
    let (connection, _writer) = open_write_database(&database_path(&app)?)?;
    let timestamp = now_timestamp();
    let deck_id = connection
        .query_row(
            "SELECT deck_id FROM flashcards WHERE id=?1 AND status IN ('active','suspended')",
            params![card_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("无法读取待删除闪卡：{error}"))?
        .ok_or_else(|| "闪卡不存在或已经删除".to_string())?;
    let changed = connection
        .execute(
            "UPDATE flashcards SET status='deleted',updated_at=?1 WHERE id=?2 AND status IN ('active','suspended')",
            params![timestamp, card_id],
        )
        .map_err(|error| format!("无法删除闪卡：{error}"))?;
    if changed == 0 {
        return Err("闪卡不存在或已经删除".to_string());
    }
    connection
        .execute(
            "UPDATE flashcard_decks SET updated_at=?1 WHERE id=?2",
            params![timestamp, deck_id],
        )
        .map_err(|error| format!("无法更新闪卡牌组：{error}"))?;
    mark_flashcard_sync_dirty(&connection)?;
    Ok(())
}

#[tauri::command]
pub(crate) fn bulk_update_flashcards(
    app: AppHandle,
    card_ids: Vec<String>,
    deck_id: Option<String>,
    tags: Option<Vec<String>>,
    custom_fields: Option<Value>,
) -> Result<usize, String> {
    let (mut connection, _writer) = open_write_database(&database_path(&app)?)?;
    flashcard_query::update_batch(
        &mut connection,
        &card_ids,
        deck_id,
        tags,
        custom_fields,
        now_timestamp(),
    )
}

#[tauri::command]
pub(crate) fn bulk_delete_flashcards(
    app: AppHandle,
    card_ids: Vec<String>,
) -> Result<usize, String> {
    let (mut connection, _writer) = open_write_database(&database_path(&app)?)?;
    flashcard_query::delete_batch(&mut connection, &card_ids, now_timestamp())
}

#[tauri::command]
pub(crate) fn import_flashcard_image(
    app: AppHandle,
    state: State<'_, AppState>,
    file_name: String,
    mime_type: String,
    data_base64: String,
) -> Result<Value, String> {
    const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;
    if data_base64.len() > (MAX_IMAGE_BYTES * 4 / 3) + 16_384 {
        return Err("图片不能超过 25 MB".to_string());
    }
    let bytes = STANDARD
        .decode(data_base64.trim())
        .map_err(|_| "图片数据不是有效的 Base64".to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err("图片为空或超过 25 MB".to_string());
    }
    let detected_mime = infer::get(&bytes)
        .map(|kind| kind.mime_type().to_string())
        .filter(|value| value.starts_with("image/"))
        .or_else(|| {
            matches!(
                mime_type.as_str(),
                "image/png" | "image/jpeg" | "image/webp" | "image/gif"
            )
            .then_some(mime_type)
        })
        .ok_or_else(|| "所选文件不是受支持的图片".to_string())?;
    let stored = blob_store_for(&app, &state)?.put(&bytes)?;
    Ok(json!({
        "title": file_name.trim().chars().take(200).collect::<String>(),
        "mimeType": detected_mime,
        "url": media_protocol_url(&stored.hash),
    }))
}

#[tauri::command]
pub(crate) fn create_flashcard(
    app: AppHandle,
    deck_id: String,
    question: String,
    answer: String,
    explanation: String,
    card_type: String,
    card_data: Option<Value>,
    media: Option<Value>,
    source_title: Option<String>,
    source_path: Option<String>,
    tags: Option<Vec<String>>,
    custom_fields: Option<Value>,
) -> Result<Flashcard, String> {
    let (question, answer, explanation, card_type, card_data) = normalize_flashcard_editor_fields(
        &question,
        &answer,
        &explanation,
        &card_type,
        card_data.as_ref(),
    )?;
    let media = normalize_flashcard_media(media.as_ref());
    let tags = normalize_flashcard_tag_values(tags);
    let custom_fields = normalize_flashcard_custom_fields(custom_fields.as_ref());
    if card_type == "image_occlusion"
        && !media.as_array().is_some_and(|items| {
            items.iter().any(|item| {
                item.get("mimeType")
                    .and_then(Value::as_str)
                    .is_some_and(|value| value.starts_with("image/"))
            })
        })
    {
        return Err("图片遮挡卡需要一张有效图片".to_string());
    }
    let source_title = source_title
        .unwrap_or_default()
        .trim()
        .chars()
        .take(500)
        .collect::<String>();
    let source_path = source_path
        .unwrap_or_default()
        .trim()
        .chars()
        .take(2_000)
        .collect::<String>();
    let (connection, _writer) = open_write_database(&database_path(&app)?)?;
    let deck_exists = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM flashcard_decks WHERE id=?1)",
            params![deck_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("无法检查目标牌组：{error}"))?
        != 0;
    if !deck_exists {
        return Err("目标牌组不存在".to_string());
    }
    let card_id = format!("card-{}", random_url_safe(14));
    let timestamp = now_timestamp();
    connection
        .execute(
            "INSERT INTO flashcards
               (id,deck_id,question,answer,explanation,card_type,source_title,source_path,media_json,status,created_at,updated_at,due_at,card_data_json,tags_json,custom_fields_json)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'active',?10,?10,?10,?11,?12,?13)",
            params![card_id, deck_id, question, answer, explanation, card_type, source_title, source_path, media.to_string(), timestamp, card_data.to_string(), tags.to_string(), custom_fields.to_string()],
        )
        .map_err(|error| format!("无法创建闪卡：{error}"))?;
    connection
        .execute(
            "UPDATE flashcard_decks SET updated_at=?1 WHERE id=?2",
            params![timestamp, deck_id],
        )
        .map_err(|error| format!("无法更新闪卡牌组：{error}"))?;
    mark_flashcard_sync_dirty(&connection)?;
    flashcard_by_id(&connection, &card_id)
}

#[tauri::command]
pub(crate) fn update_flashcard(
    app: AppHandle,
    card_id: String,
    question: String,
    answer: String,
    explanation: String,
    deck_id: Option<String>,
    card_type: Option<String>,
    card_data: Option<Value>,
    media: Option<Value>,
    source_title: Option<String>,
    source_path: Option<String>,
    tags: Option<Vec<String>>,
    custom_fields: Option<Value>,
) -> Result<Flashcard, String> {
    let (connection, _writer) = open_write_database(&database_path(&app)?)?;
    let existing = flashcard_by_id(&connection, &card_id)?;
    let deck_id = deck_id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| existing.deck_id.clone());
    let card_type = card_type.unwrap_or_else(|| existing.card_type.clone());
    let fallback_card_data = existing.card_data.clone();
    let (question, answer, explanation, card_type, card_data) = normalize_flashcard_editor_fields(
        &question,
        &answer,
        &explanation,
        &card_type,
        card_data.as_ref().or(Some(&fallback_card_data)),
    )?;
    let fallback_media = existing.media.clone();
    let media = normalize_flashcard_media(media.as_ref().or(Some(&fallback_media)));
    let tags = tags
        .map(|values| normalize_flashcard_tag_values(Some(values)))
        .unwrap_or_else(|| existing.tags.clone());
    let custom_fields = custom_fields
        .as_ref()
        .map(|value| normalize_flashcard_custom_fields(Some(value)))
        .unwrap_or_else(|| existing.custom_fields.clone());
    if card_type == "image_occlusion"
        && !media.as_array().is_some_and(|items| {
            items.iter().any(|item| {
                item.get("mimeType")
                    .and_then(Value::as_str)
                    .is_some_and(|value| value.starts_with("image/"))
            })
        })
    {
        return Err("图片遮挡卡需要一张有效图片".to_string());
    }
    let source_title = source_title
        .unwrap_or(existing.source_title)
        .trim()
        .chars()
        .take(500)
        .collect::<String>();
    let source_path = source_path
        .unwrap_or(existing.source_path)
        .trim()
        .chars()
        .take(2_000)
        .collect::<String>();
    let deck_exists = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM flashcard_decks WHERE id=?1)",
            params![deck_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("无法检查目标牌组：{error}"))?
        != 0;
    if !deck_exists {
        return Err("目标牌组不存在".to_string());
    }
    let timestamp = now_timestamp();
    let changed = connection.execute(
        "UPDATE flashcards
         SET deck_id=?1,question=?2,answer=?3,explanation=?4,card_type=?5,source_title=?6,source_path=?7,updated_at=?8,card_data_json=?9,media_json=?10,tags_json=?11,custom_fields_json=?12
         WHERE id=?13 AND status IN ('active','suspended')",
        params![deck_id, question, answer, explanation, card_type, source_title, source_path, timestamp, card_data.to_string(), media.to_string(), tags.to_string(), custom_fields.to_string(), card_id],
    ).map_err(|error| format!("无法更新闪卡：{error}"))?;
    if changed == 0 {
        return Err("闪卡不存在或已删除".to_string());
    }
    connection
        .execute(
            "UPDATE flashcard_decks SET updated_at=?1 WHERE id IN (?2,?3)",
            params![timestamp, existing.deck_id, deck_id],
        )
        .map_err(|error| format!("无法更新闪卡牌组：{error}"))?;
    mark_flashcard_sync_dirty(&connection)?;
    flashcard_by_id(&connection, &card_id)
}

#[tauri::command]
pub(crate) fn duplicate_flashcard(
    app: AppHandle,
    card_id: String,
    deck_id: Option<String>,
) -> Result<Flashcard, String> {
    let (connection, _writer) = open_write_database(&database_path(&app)?)?;
    let existing = flashcard_by_id(&connection, &card_id)?;
    let deck_id = deck_id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(existing.deck_id);
    let deck_exists = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM flashcard_decks WHERE id=?1)",
            params![deck_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("无法检查目标牌组：{error}"))?
        != 0;
    if !deck_exists {
        return Err("目标牌组不存在".to_string());
    }
    let duplicate_id = format!("card-{}", random_url_safe(14));
    let timestamp = now_timestamp();
    connection
        .execute(
            "INSERT INTO flashcards
               (id,deck_id,question,answer,explanation,card_type,source_library_id,source_document_id,source_block_id,
                source_title,source_path,source_hash,media_json,status,created_at,updated_at,due_at,card_data_json,
                tags_json,evidence,confidence,custom_fields_json,generation_json)
             SELECT ?1,?2,question,answer,explanation,card_type,source_library_id,source_document_id,source_block_id,
                    source_title,source_path,source_hash,media_json,'active',?3,?3,?3,card_data_json,
                    tags_json,evidence,confidence,custom_fields_json,generation_json
             FROM flashcards WHERE id=?4 AND status IN ('active','suspended')",
            params![duplicate_id, deck_id, timestamp, card_id],
        )
        .map_err(|error| format!("无法复制闪卡：{error}"))?;
    connection
        .execute(
            "UPDATE flashcard_decks SET updated_at=?1 WHERE id=?2",
            params![timestamp, deck_id],
        )
        .map_err(|error| format!("无法更新闪卡牌组：{error}"))?;
    mark_flashcard_sync_dirty(&connection)?;
    flashcard_by_id(&connection, &duplicate_id)
}

pub(crate) fn flashcard_source_excerpt(source: &str, max_chars: usize) -> String {
    let total = source.chars().count();
    if total <= max_chars {
        return source.to_string();
    }
    const MARKER: &str = "\n\n[中间较长内容已省略；以下为文档末尾]\n\n";
    let marker_chars = MARKER.chars().count();
    if max_chars <= marker_chars + 2 {
        return source.chars().take(max_chars).collect();
    }
    let available = max_chars - marker_chars;
    let head_chars = available * 2 / 3;
    let tail_chars = available - head_chars;
    let head = source.chars().take(head_chars).collect::<String>();
    let tail = source.chars().skip(total - tail_chars).collect::<String>();
    format!("{head}{MARKER}{tail}")
}

pub(crate) const FLASHCARD_IMPORT_MAX_BYTES: u64 = 16 * 1024 * 1024;

pub(crate) const FLASHCARD_IMPORT_MAX_CARDS: usize = 5_000;

/// Read the authoritative import and review records; counts are not guessed
/// from a model response. Missing drafts stay missing after sync or deletion.
pub(crate) fn draft_batch_receipt_on(c: &Connection, batch: &str) -> Result<Value, String> {
    let mut receipt=c.query_row("SELECT id,total_count,valid_count,duplicate_count,invalid_count FROM flashcard_import_batches WHERE id=?1",[batch],|r|Ok(json!({"batchId":r.get::<_,String>(0)?,"total":r.get::<_,i64>(1)?,"imported":r.get::<_,i64>(2)?,"duplicates":r.get::<_,i64>(3)?,"invalid":r.get::<_,i64>(4)?}))).optional().map_err(|e|e.to_string())?.ok_or("闪卡导入回执当前不存在")?;
    let mut q = c
        .prepare("SELECT id,status,updated_at FROM flashcard_drafts WHERE batch_id=?1 ORDER BY id")
        .map_err(|e| e.to_string())?;
    let drafts=q.query_map([batch],|r|Ok(json!({"id":r.get::<_,String>(0)?,"status":r.get::<_,String>(1)?,"updatedAt":r.get::<_,i64>(2)?}))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    receipt["drafts"] = json!(drafts);
    receipt["missingDrafts"] =
        json!((receipt["imported"].as_i64().unwrap_or(0) - drafts.len() as i64).max(0));
    Ok(receipt)
}
