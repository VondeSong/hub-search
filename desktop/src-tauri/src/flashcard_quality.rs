use super::*;
#[cfg(test)]
use crate::flashcard_authoring::import_flashcard_values;
use crate::flashcard_store::flashcard_draft_from_row;
use crate::flashcard_store::{flashcard_by_id, flashcard_from_row};
use crate::flashcard_store::{FLASHCARD_DRAFT_SELECT_FIELDS, FLASHCARD_SELECT_FIELDS};
use crate::flashcard_validation::normalize_flashcard_editor_fields;
use crate::flashcard_validation::{flashcard_import_source_text, flashcard_import_text};
use sha2::{Digest, Sha256};

pub(super) fn migrate(connection: &mut Connection) -> Result<(), String> {
    let tx = connection.transaction().map_err(|e| e.to_string())?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS flashcard_quality_records(id TEXT PRIMARY KEY,kind TEXT NOT NULL,payload_json TEXT NOT NULL,updated_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS flashcard_quality_kind ON flashcard_quality_records(kind,updated_at);
        INSERT INTO metadata(key,value) VALUES('schema_version','66') ON CONFLICT(key) DO UPDATE SET value=excluded.value;").map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}
fn timestamp() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("").trim()
}
pub(super) fn records(c: &Connection) -> Result<Vec<Value>, String> {
    let mut q = c
        .prepare("SELECT payload_json FROM flashcard_quality_records ORDER BY id")
        .map_err(|e| e.to_string())?;
    let rows = q
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.map(|r| {
        r.map_err(|e| e.to_string())
            .and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
    })
    .collect()
}
fn write_record(c: &Connection, v: &Value) -> Result<(), String> {
    let body = v.to_string();
    c.execute("INSERT INTO flashcard_quality_records(id,kind,payload_json,updated_at) VALUES(?1,?2,?3,?4)
      ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at
      WHERE excluded.updated_at>flashcard_quality_records.updated_at OR (excluded.updated_at=flashcard_quality_records.updated_at AND excluded.payload_json>flashcard_quality_records.payload_json)",params![text(v,"id"),text(v,"kind"),body,v["updatedAt"].as_i64().unwrap_or(0)]).map_err(|e|e.to_string())?;
    Ok(())
}
fn current_record(c: &Connection, id: &str) -> Result<Option<Value>, String> {
    let body: Option<String> = c
        .query_row(
            "SELECT payload_json FROM flashcard_quality_records WHERE id=?1",
            params![id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    body.map(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
        .transpose()
}
fn version_id(v: &Value) -> String {
    format!("history-{:x}", Sha256::digest(v.to_string().as_bytes()))
}
fn archive_version(c: &Connection, v: &Value) -> Result<String, String> {
    let id = version_id(v);
    let mut history = v.clone();
    history["recordId"] = v["id"].clone();
    history["recordKind"] = v["kind"].clone();
    history["kind"] = json!("history");
    history["historyType"] = json!("version");
    history["id"] = json!(id);
    write_record(c, &history)?;
    Ok(id)
}
fn incoming_wins(old: &Value, incoming: &Value) -> bool {
    let old_at = old["updatedAt"].as_i64().unwrap_or(0);
    let new_at = incoming["updatedAt"].as_i64().unwrap_or(0);
    new_at > old_at || (new_at == old_at && incoming.to_string() > old.to_string())
}
fn put(c: &Connection, v: &Value) -> Result<(), String> {
    if matches!(text(v, "kind"), "feedback" | "rule") {
        if let Some(old) = current_record(c, text(v, "id"))? {
            if old["kind"] != v["kind"] {
                return Err("质量记录类型不一致".into());
            }
            if old != *v && incoming_wins(&old, v) {
                archive_version(c, &old)?;
            }
        }
    }
    write_record(c, v)
}
pub(super) fn merge(c: &Connection, items: &[Value]) -> Result<(), String> {
    if items.len() > 100_000 {
        return Err("质量记录过多".into());
    }
    for v in items {
        if !matches!(
            text(v, "kind"),
            "rule" | "feedback" | "history" | "request" | "proposal"
        ) || text(v, "id").is_empty()
            || text(v, "id").len() > 200
            || v.to_string().len() > 2_000_000
            || v["updatedAt"].as_i64().unwrap_or(0) <= 0
        {
            return Err("远端质量记录格式无效".into());
        }
        if text(v, "kind") == "rule" {
            validate_rule(v)?;
        }
        if matches!(text(v, "kind"), "feedback" | "rule") {
            if let Some(old) = current_record(c, text(v, "id"))? {
                if old["kind"] != v["kind"] {
                    return Err("远端质量记录类型不一致".into());
                }
                if old != *v {
                    let old_id = archive_version(c, &old)?;
                    let new_id = archive_version(c, v)?;
                    let (kept, other) = if incoming_wins(&old, v) {
                        (&new_id, &old_id)
                    } else {
                        (&old_id, &new_id)
                    };
                    let mut pair = [old_id.as_str(), new_id.as_str()];
                    pair.sort();
                    let merge_id = format!(
                        "history-merge-{:x}",
                        Sha256::digest(serde_json::to_vec(&pair).map_err(|e| e.to_string())?)
                    );
                    write_record(
                        c,
                        &json!({"id":merge_id,"kind":"history","historyType":"sync-merge","recordId":v["id"],"recordKind":v["kind"],"keptVersionId":kept,"otherVersionId":other,"updatedAt":old["updatedAt"].as_i64().unwrap_or(0).max(v["updatedAt"].as_i64().unwrap_or(0))}),
                    )?;
                }
            }
        }
        put(c, v)?;
    }
    Ok(())
}
fn load(c: &Connection, id: &str) -> Result<Value, String> {
    let body: String = c
        .query_row(
            "SELECT payload_json FROM flashcard_quality_records WHERE id=?1",
            params![id],
            |r| r.get(0),
        )
        .map_err(|_| "记录不存在".to_string())?;
    serde_json::from_str(&body).map_err(|e| e.to_string())
}
fn revision(items: &[Value]) -> String {
    let rules: Vec<_> = items
        .iter()
        .filter(|v| {
            text(v, "kind") == "rule"
                || (text(v, "kind") == "feedback" && v["excludeTarget"] == true)
        })
        .collect();
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&rules).unwrap_or_default())
    )
}
fn validate_rule(v: &Value) -> Result<(), String> {
    if text(v, "text").is_empty() || text(v, "text").chars().count() > 4000 {
        return Err("规则内容必填，最多 4000 字".into());
    }
    if !matches!(text(v, "scopeType"), "global" | "deck" | "topic") {
        return Err("规则范围无效".into());
    }
    if text(v, "scopeType") != "global" && text(v, "scopeValue").is_empty() {
        return Err("请选择牌组或填写主题".into());
    }
    if v.to_string().len() > 30_000 {
        return Err("规则内容过长".into());
    }
    Ok(())
}
fn save_rule(c: &Connection, input: &Value, feedback_id: &str) -> Result<Value, String> {
    validate_rule(input)?;
    let id = if text(input, "id").is_empty() {
        format!("rule-{}", random_url_safe(14))
    } else {
        text(input, "id").to_string()
    };
    let old = if text(input, "id").is_empty() {
        None
    } else {
        Some(load(c, &id)?)
    };
    if let Some(old) = &old {
        if old["kind"] != "rule" || old["updatedAt"] != input["updatedAt"] {
            return Err("规则已被修改，请刷新后重试".into());
        }
    }
    let mut v = input.clone();
    v["id"] = json!(id);
    v["kind"] = json!("rule");
    v["updatedAt"] = json!(timestamp().max(
        old.as_ref()
            .and_then(|v| v["updatedAt"].as_i64())
            .unwrap_or(0)
            + 1
    ));
    v["enabled"] = json!(input["enabled"].as_bool().unwrap_or(true));
    v["author"] = json!("user");
    if !feedback_id.is_empty() {
        v["feedbackId"] = json!(feedback_id);
    }
    put(c, &v)?;
    mark_flashcard_sync_dirty(c)?;
    Ok(v)
}
pub(super) fn context(c: &Connection, args: &Value) -> Result<Value, String> {
    let items = records(c)?;
    let goal = text(args, "learningGoal").to_lowercase();
    let topics: Vec<String> = args["topics"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|s| s.trim().to_lowercase())
        .collect();
    let applies = |v: &Value| match text(v, "scopeType") {
        "deck" => text(v, "scopeValue") == text(args, "deckId") && !text(args, "deckId").is_empty(),
        "topic" => topics.contains(&text(v, "scopeValue").to_lowercase()),
        _ => true,
    };
    let mut rules: Vec<Value> = items
        .iter()
        .filter(|v| {
            text(v, "kind") == "rule"
                && v["enabled"] == true
                && applies(v)
                && (text(v, "learningGoal").is_empty()
                    || goal.contains(&text(v, "learningGoal").to_lowercase()))
        })
        .cloned()
        .collect();
    rules.sort_by_key(|v| match text(v, "scopeType") {
        "deck" => 0,
        "topic" => 1,
        _ => 2,
    });
    let relevant = |v: &Value| {
        let card = &v["snapshot"];
        (!text(args, "deckId").is_empty() && text(card, "deckId") == text(args, "deckId"))
            || args["documentIds"].as_array().is_some_and(|ids| {
                ids.iter().any(|id| {
                    id.as_str() == Some(text(card, "sourceDocumentId"))
                        && !text(card, "sourceDocumentId").is_empty()
                })
            })
            || card["tags"].as_array().is_some_and(|tags| {
                tags.iter()
                    .filter_map(Value::as_str)
                    .any(|tag| topics.contains(&tag.to_lowercase()))
            })
    };
    let mut feedback: Vec<Value> = items
        .iter()
        .filter(|v| v["kind"] == "feedback" && relevant(v))
        .cloned()
        .collect();
    feedback.sort_by_key(|v| std::cmp::Reverse(v["updatedAt"].as_i64().unwrap_or(0)));
    let feedback_total = feedback.len();
    feedback.truncate(40);
    Ok(
        json!({"revision":revision(&items),"rules":rules,"feedback":feedback,"feedbackTotal":feedback_total,"feedbackTruncated":feedback_total>40,"scope":args,"guidance":"仅生效规则是长期偏好；反馈中的原话、卡片和来源为证据。当前明确学习目标优先，具体范围优先；事实依据不能被偏好覆盖。报告按偏好排除的目标，不得作为遗漏或完整覆盖。可用 ruleApplications 说明采用或按例外处理的理由；例外必须有本次明确请求和规则条件支持，且不会取消单卡排除标记。"}),
    )
}
pub(super) fn validate_submission(
    c: &Connection,
    ctx: Option<&Value>,
    cards: &[Value],
    deck_name: &str,
) -> Result<(), String> {
    for card in cards {
        let override_name = flashcard_import_text(card, &["deckName", "deck_name"]);
        if !override_name.is_empty() && override_name != deck_name {
            return Err("单张卡片的牌组与本批目标不同，请按牌组分别读取偏好并提交".into());
        }
    }
    let all = records(c)?;
    let active = all
        .iter()
        .any(|v| v["kind"] == "rule" && v["enabled"] == true);
    if active || ctx.is_some() {
        let ctx = ctx.ok_or("请先调用 hub_get_flashcard_quality_context，再提交 qualityContext")?;
        if text(ctx, "revision") != revision(&all) {
            return Err("制卡偏好已变化，请重新读取并检查卡片".into());
        }
        if text(&ctx["scope"], "learningGoal").is_empty() {
            return Err("qualityContext.scope.learningGoal 必填".into());
        }
        let actual_scope = submission_scope(c, ctx, cards, deck_name)?;
        let expected = context(c, &actual_scope)?;
        for rule in expected["rules"].as_array().unwrap() {
            if !ctx["ruleIds"]
                .as_array()
                .is_some_and(|ids| ids.contains(&rule["id"]))
            {
                return Err("qualityContext.ruleIds 未包含全部适用规则，请检查后重试".into());
            }
        }
        if let Some(applications) = ctx.get("ruleApplications") {
            let applications = applications.as_array().ok_or("规则处理说明格式无效")?;
            if applications.len() > 1000 {
                return Err("规则处理说明过多".into());
            }
            let mut seen = HashSet::new();
            for application in applications {
                let rule_id = text(application, "ruleId");
                if !expected["rules"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|r| text(r, "id") == rule_id)
                    || !seen.insert(rule_id)
                    || !matches!(text(application, "decision"), "applied" | "exception")
                    || text(application, "reason").is_empty()
                    || text(application, "reason").chars().count() > 2000
                {
                    return Err(
                        "规则处理说明需引用适用规则、说明采用或例外理由，且每条规则只说明一次"
                            .into(),
                    );
                }
            }
        }
    }
    for card in cards {
        for feedback in all
            .iter()
            .filter(|v| v["kind"] == "feedback" && v["excludeTarget"] == true)
        {
            let old = &feedback["snapshot"];
            let same_key = !text(old, "idempotencyKey").is_empty()
                && text(old, "idempotencyKey") == text(card, "idempotencyKey");
            let document =
                flashcard_import_source_text(card, &["sourceDocumentId", "source_document_id"]);
            let library =
                flashcard_import_source_text(card, &["sourceLibraryId", "source_library_id"]);
            let path = flashcard_import_source_text(card, &["sourcePath", "source_path"]);
            // IDs are authoritative when available on both sides. Local PDF imports have only a path.
            let same_source = if !text(old, "sourceDocumentId").is_empty() && !document.is_empty() {
                text(old, "sourceDocumentId") == document && text(old, "sourceLibraryId") == library
            } else {
                !path.is_empty()
                    && !text(old, "sourcePath").is_empty()
                    && exclusion_source_path(text(old, "sourcePath"))
                        == exclusion_source_path(&path)
            };
            if same_key || (same_source && text(old, "question") == text(card, "question")) {
                return Err(format!(
                    "该记忆目标已被用户排除（反馈 {}），请改写记忆目标或先由用户取消排除",
                    text(feedback, "id")
                ));
            }
        }
    }
    Ok(())
}
fn exclusion_source_path(path: &str) -> String {
    let path = path.trim();
    let bytes = path.as_bytes();
    let windows = (bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\'))
        || path.starts_with("\\\\");
    if !windows {
        return path.to_owned();
    }
    let mut normalized = String::new();
    let mut separator = false;
    for ch in path.chars() {
        if matches!(ch, '/' | '\\') {
            if !separator {
                normalized.push('/');
            }
            separator = true;
        } else {
            normalized.extend(ch.to_lowercase());
            separator = false;
        }
    }
    normalized
}
fn submission_scope(
    c: &Connection,
    ctx: &Value,
    cards: &[Value],
    deck_name: &str,
) -> Result<Value, String> {
    let mut scope = ctx["scope"].clone();
    let mut statement = c
        .prepare("SELECT id FROM flashcard_decks WHERE name=?1")
        .map_err(|e| e.to_string())?;
    let deck_ids = statement
        .query_map(params![deck_name], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    if deck_ids.len() > 1 {
        return Err("目标牌组名称重复，请先使用唯一的牌组名称".into());
    }
    let actual_deck = deck_ids.first().map(String::as_str).unwrap_or("");
    if !text(&ctx["scope"], "deckId").is_empty() && text(&ctx["scope"], "deckId") != actual_deck {
        return Err("制卡偏好的牌组与实际目标不一致，请重新读取目标牌组的偏好".into());
    }
    scope["deckId"] = json!(actual_deck);
    let mut topics = ctx["scope"]["topics"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    for card in cards {
        for tag in card["tags"].as_array().into_iter().flatten() {
            if tag.is_string() && !topics.contains(tag) {
                topics.push(tag.clone());
            }
        }
    }
    scope["topics"] = json!(topics);
    Ok(scope)
}
pub(super) fn submission_generation(
    c: &Connection,
    generation: &Value,
    cards: &[Value],
    deck_name: &str,
) -> Result<Value, String> {
    validate_submission(c, generation.get("qualityContext"), cards, deck_name)?;
    let mut generation = generation.clone();
    if let Some(ctx) = generation.get("qualityContext") {
        let actual = context(c, &submission_scope(c, ctx, cards, deck_name)?)?;
        let mut rules = actual["rules"].as_array().cloned().unwrap_or_default();
        for rule in &mut rules {
            if text(rule, "scopeType") == "deck" {
                let label: String = c
                    .query_row(
                        "SELECT name FROM flashcard_decks WHERE id=?1",
                        params![text(rule, "scopeValue")],
                        |r| r.get(0),
                    )
                    .map_err(|e| e.to_string())?;
                rule["scopeLabel"] = json!(label);
            }
        }
        // Capture the reviewed rule text at the same transaction as the imported draft.
        generation["qualityContext"]["ruleSnapshots"] = json!(rules);
    }
    Ok(generation)
}
fn document(items: &[Value]) -> String {
    let mut out = String::from(
        "# 闪卡质量与制卡偏好\n\n由 Hub 记录生成；在 Hub 中编辑规则后重新导出。\n\n## 生效规则\n",
    );
    for v in items
        .iter()
        .filter(|v| v["kind"] == "rule" && v["enabled"] == true)
    {
        out.push_str(&format!("\n### {}\n\n范围：{} {}\n\n目标：{}\n\n{}\n\n例外：{}\n\n正例：{}\n\n反例：{}\n\n规则编号：{}\n",text(v,"title"),text(v,"scopeType"),text(v,"scopeValue"),text(v,"learningGoal"),text(v,"text"),text(v,"exceptions"),text(v,"positiveExample"),text(v,"negativeExample"),text(v,"id")));
    }
    out.push_str("\n## 反馈记录\n");
    for v in items.iter().rev().filter(|v| v["kind"] == "feedback") {
        out.push_str(&format!("\n### {}\n\n类型：{} · 状态：{}\n\n反馈：{}\n\n原问题：{}\n\n原答案：{}\n\n来源：{}\n\n处理：{}\n",text(v,"id"),text(v,"reason"),text(v,"status"),text(v,"comment"),text(&v["snapshot"],"question"),text(&v["snapshot"],"answer"),text(&v["snapshot"],"sourceTitle"),text(v,"action")));
    }
    out.push_str("\n## 修改与同步历史\n\n不同版本会保留以供核对；同步仍采用较新的更新时间，同一时刻按稳定排序选择。\n");
    for v in items.iter().filter(|v| v["kind"] == "history") {
        // A sync archives both sides, including the version that remains current.
        // Keep that snapshot in storage but do not present it as an old version.
        if text(v, "historyType") != "sync-merge"
            && items.iter().any(|current| {
                text(current, "id") == text(v, "recordId")
                    && text(current, "kind") == text(v, "recordKind")
                    && version_id(current) == text(v, "id")
            })
        {
            continue;
        }
        if text(v, "historyType") == "sync-merge" {
            out.push_str(&format!(
                "\n- {}：同步发现不同版本；采用 {}，另一版本 {} 保留供核对。\n",
                text(v, "recordId"),
                text(v, "keptVersionId"),
                text(v, "otherVersionId")
            ));
        } else if text(v, "recordKind") == "feedback" {
            out.push_str(&format!(
                "\n### 反馈旧版本 {}\n\n版本时间：{}\n\n反馈：{}\n\n状态：{} · 避免重复：{}\n",
                text(v, "recordId"),
                v["updatedAt"],
                text(v, "comment"),
                text(v, "status"),
                v["excludeTarget"]
            ));
        } else {
            out.push_str(&format!("\n### 规则旧版本 {}\n\n版本时间：{}\n\n{}\n\n范围：{} {}\n\n目标：{}\n\n例外：{}\n\n启用：{}\n",text(v,"recordId"),v["updatedAt"],text(v,"text"),text(v,"scopeType"),text(v,"scopeValue"),text(v,"learningGoal"),text(v,"exceptions"),v["enabled"]));
        }
    }
    out
}
fn quality_sync_status(c: &Connection) -> Value {
    json!({
        "enabled": cloud_sync::automatic(c)
            && flashcard_cloud_sync::configured(c),
        "pending": metadata_bool(c, "flashcard_sync_dirty", false),
        "error": metadata_string(c, "flashcard_sync_last_error"),
        "lastSuccess": metadata_u64(c, "flashcard_sync_last_success", 0),
        "running": FLASHCARD_SYNC_LOCK.try_lock().is_err()
    })
}
#[tauri::command]
pub(super) fn get_flashcard_quality(app: AppHandle) -> Result<Value, String> {
    let c = open_database(&database_path(&app)?)?;
    let items = records(&c)?;
    Ok(
        json!({"records":items,"document":document(&items),"revision":revision(&items),"sync":quality_sync_status(&c)}),
    )
}
#[tauri::command]
pub(super) fn save_flashcard_quality_rule(app: AppHandle, rule: Value) -> Result<Value, String> {
    let (mut c, _guard) = open_write_database(&database_path(&app)?)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let v = save_rule(&tx, &rule, "")?;
    tx.commit().map_err(|e| e.to_string())?;
    schedule_sync(&app);
    Ok(v)
}
#[tauri::command]
pub(super) fn submit_flashcard_feedback(app: AppHandle, input: Value) -> Result<Value, String> {
    let (mut c, _guard) = open_write_database(&database_path(&app)?)?;
    let value = feedback(&mut c, input)?;
    schedule_sync(&app);
    Ok(value)
}
fn feedback(c: &mut Connection, input: Value) -> Result<Value, String> {
    let tx = c.transaction().map_err(|e| e.to_string())?;
    if !matches!(
        text(&input, "reason"),
        "low-value"
            | "goal-mismatch"
            | "incorrect"
            | "ambiguous"
            | "compound"
            | "duplicate"
            | "media"
            | "positive"
    ) {
        return Err("反馈类型无效".into());
    }
    if text(&input, "comment").chars().count() > 4000 {
        return Err("反馈最多 4000 字".into());
    }
    let id = text(&input, "cardId");
    let draft = input["draft"] == true;
    let snapshot = if draft {
        let card=tx.query_row(&format!("SELECT {FLASHCARD_DRAFT_SELECT_FIELDS} FROM flashcard_drafts WHERE id=?1 AND status='pending'"),params![id],flashcard_draft_from_row).map_err(|e|e.to_string())?;
        serde_json::to_value(card).map_err(|e| e.to_string())?
    } else {
        serde_json::to_value(flashcard_by_id(&tx, id)?).map_err(|e| e.to_string())?
    };
    let action = text(&input, "action");
    if !matches!(action, "record" | "pause" | "edit") {
        return Err("反馈操作无效".into());
    }
    if action == "pause" {
        if draft {
            return Err("收件箱卡片尚未进入复习，无需暂停".into());
        }
        tx.execute(
            "UPDATE flashcards SET status='suspended',updated_at=MAX(updated_at+1,?2) WHERE id=?1",
            params![id, now_timestamp()],
        )
        .map_err(|e| e.to_string())?;
    }
    let feedback_id = format!("feedback-{}", random_url_safe(14));
    let v = json!({"id":feedback_id,"kind":"feedback","cardId":id,"draft":draft,"snapshot":snapshot,"reason":text(&input,"reason"),"comment":text(&input,"comment"),"action":action,"excludeTarget":input["excludeTarget"].as_bool().unwrap_or(false),"status":"open","createdAt":timestamp(),"updatedAt":timestamp()});
    put(&tx, &v)?;
    if input["rule"].is_object() {
        save_rule(&tx, &input["rule"], &feedback_id)?;
    }
    mark_flashcard_sync_dirty(&tx)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(v)
}
#[tauri::command]
pub(super) fn update_flashcard_feedback(
    app: AppHandle,
    id: String,
    expected_updated_at: i64,
    status: String,
    exclude_target: bool,
) -> Result<(), String> {
    if !matches!(status.as_str(), "open" | "resolved") {
        return Err("反馈状态无效".into());
    }
    let (mut c, _guard) = open_write_database(&database_path(&app)?)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let mut v = load(&tx, &id)?;
    if v["kind"] != "feedback" || v["updatedAt"].as_i64() != Some(expected_updated_at) {
        return Err("反馈已变化，请刷新后重试".into());
    }
    v["status"] = json!(status);
    v["excludeTarget"] = json!(exclude_target);
    v["updatedAt"] = json!(timestamp().max(expected_updated_at + 1));
    put(&tx, &v)?;
    mark_flashcard_sync_dirty(&tx)?;
    tx.commit().map_err(|e| e.to_string())?;
    schedule_sync(&app);
    Ok(())
}
#[tauri::command]
pub(super) fn export_flashcard_quality(app: AppHandle, destination: String) -> Result<(), String> {
    let c = open_database(&database_path(&app)?)?;
    let content = document(&records(&c)?);
    #[cfg(target_os = "android")]
    if destination.is_empty() {
        // Persist the document before opening another activity. The Android save flow
        // can finish after process death without a surviving WebView/Rust callback.
        return app
            .state::<AndroidSourceOpener>()
            .0
            .run_mobile_plugin::<()>("exportQualityDocument", json!({"content":content}))
            .map_err(|e| format!("无法准备质量文档：{e}"));
    }
    #[cfg(target_os = "android")]
    if destination.starts_with("content://") {
        return app
            .state::<AndroidSourceOpener>()
            .0
            .run_mobile_plugin::<()>(
                "writeQualityDocument",
                json!({"uri":destination,"content":content}),
            )
            .map_err(|e| format!("无法保存质量文档：{e}"));
    }
    let path = Path::new(&destination);
    if !path.is_absolute() || path.extension().and_then(|s| s.to_str()) != Some("md") {
        return Err("请选择 .md 文档保存位置".into());
    }
    fs::write(path, content).map_err(|e| e.to_string())
}

fn card_snapshot(c: &Connection, card: &Flashcard) -> Result<Value, String> {
    let mut value = serde_json::to_value(card).map_err(|e| e.to_string())?;
    let current: Option<String> = c
        .query_row(
            "SELECT content_hash FROM documents WHERE space_id=?1 AND id=?2",
            params![card.source_library_id, card.source_document_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    value["sourceRevision"] = json!(current);
    Ok(value)
}
fn card_fingerprint(card: &Value) -> String {
    let fields = json!({"question":card["question"],"answer":card["answer"],"explanation":card["explanation"],"cardType":card["cardType"],"cardData":card["cardData"],"media":card["media"],"sourceHash":card["sourceHash"],"deckId":card["deckId"],"sourceLibraryId":card["sourceLibraryId"],"sourceDocumentId":card["sourceDocumentId"],"sourceBlockId":card["sourceBlockId"],"tags":card["tags"],"evidence":card["evidence"],"sourceChanged":card["sourceChanged"],"sourceRevision":card["sourceRevision"]});
    format!("{:x}", Sha256::digest(fields.to_string().as_bytes()))
}
fn affected(c: &Connection, request: &Value) -> Result<Vec<Value>, String> {
    let rule = if text(request, "ruleId").is_empty() {
        None
    } else {
        Some(load(c, text(request, "ruleId"))?)
    };
    let mut q=c.prepare(&format!("SELECT {FLASHCARD_SELECT_FIELDS} FROM flashcards WHERE status IN ('active','suspended') ORDER BY id")).map_err(|e|e.to_string())?;
    let rows = q
        .query_map([], flashcard_from_row)
        .map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for row in rows {
        let card = card_snapshot(c, &row.map_err(|e| e.to_string())?)?;
        if !text(request, "deckId").is_empty() && text(request, "deckId") != text(&card, "deckId") {
            continue;
        }
        if let Some(rule) = &rule {
            if text(rule, "scopeType") == "deck"
                && text(rule, "scopeValue") != text(&card, "deckId")
            {
                continue;
            }
            if text(rule, "scopeType") == "topic"
                && !card["tags"].as_array().is_some_and(|tags| {
                    tags.iter().any(|tag| {
                        tag.as_str()
                            .is_some_and(|t| t.eq_ignore_ascii_case(text(rule, "scopeValue")))
                    })
                })
            {
                continue;
            }
        }
        result.push(card);
    }
    Ok(result)
}
#[tauri::command]
pub(super) fn create_flashcard_quality_request(
    app: AppHandle,
    input: Value,
) -> Result<Value, String> {
    let (c, _guard) = open_write_database(&database_path(&app)?)?;
    if !matches!(text(&input, "task"), "summarize" | "audit") {
        return Err("整理任务类型无效".into());
    }
    if !text(&input, "ruleId").is_empty() {
        let r = load(&c, text(&input, "ruleId"))?;
        if r["kind"] != "rule" {
            return Err("规则不存在".into());
        }
    }
    let v = json!({"id":format!("request-{}",random_url_safe(14)),"kind":"request","task":text(&input,"task"),"deckId":text(&input,"deckId"),"ruleId":text(&input,"ruleId"),"learningGoal":text(&input,"learningGoal"),"status":"pending","updatedAt":timestamp()});
    put(&c, &v)?;
    mark_flashcard_sync_dirty(&c)?;
    schedule_sync(&app);
    Ok(v)
}
pub(super) fn work(c: &Connection, args: &Value) -> Result<Value, String> {
    let all = records(c)?;
    if text(args, "requestId").is_empty() {
        return Ok(
            json!({"requests":all.iter().filter(|v|v["kind"]=="request" && v["status"]=="pending").collect::<Vec<_>>()}),
        );
    }
    let request = load(c, text(args, "requestId"))?;
    if request["kind"] != "request" {
        return Err("整理请求不存在".into());
    }
    let cards = if request["task"] == "audit" {
        affected(c, &request)?
    } else {
        vec![]
    };
    let offset = args["offset"].as_u64().unwrap_or(0) as usize;
    let page: Vec<Value> = cards
        .iter()
        .skip(offset)
        .take(40)
        .map(|v| json!({"card":v,"fingerprint":card_fingerprint(v)}))
        .collect();
    let feedback: Vec<Value> = all
        .iter()
        .filter(|v| {
            v["kind"] == "feedback"
                && (text(&request, "deckId").is_empty()
                    || text(&v["snapshot"], "deckId") == text(&request, "deckId"))
        })
        .cloned()
        .collect();
    let mut groups = BTreeMap::<String, usize>::new();
    for f in &feedback {
        *groups
            .entry(format!(
                "{} / {}",
                text(f, "reason"),
                text(&f["snapshot"], "deckId")
            ))
            .or_default() += 1;
    }
    let feedback_page: Vec<_> = feedback.iter().skip(offset).take(40).collect();
    let total = if request["task"] == "audit" {
        cards.len().max(feedback.len())
    } else {
        feedback.len()
    };
    Ok(
        json!({"request":request,"revision":revision(&all),"rules":all.iter().filter(|v|v["kind"]=="rule" && v["enabled"]==true).collect::<Vec<_>>(),"feedback":feedback_page,"feedbackGroups":groups,"cards":page,"candidateCount":cards.len(),"feedbackCount":feedback.len(),"offset":offset,"nextOffset":if offset+40<total{Some(offset+40)}else{None},"guidance":"这些卡片仅在规则适用范围内，并非已判定违规。结合原始来源检查事实，反馈原话不是全局规则。提出 rule 或 rewrite 建议；只能保存待确认建议，不能直接启用规则或修改卡片。"}),
    )
}
pub(super) fn propose(c: &Connection, args: &Value) -> Result<Value, String> {
    let request = load(c, text(args, "requestId"))?;
    if request["kind"] != "request" {
        return Err("整理请求不存在".into());
    }
    let rev = revision(&records(c)?);
    if text(args, "revision") != rev {
        return Err("规则已更新，请重新读取整理任务".into());
    }
    let suggestions = args["proposals"].as_array().ok_or("proposals 必须是数组")?;
    if suggestions.len() > 100 {
        return Err("每次最多提交 100 条建议".into());
    }
    let eligible = affected(c, &request)?;
    let mut out = Vec::new();
    for item in suggestions {
        if text(item, "reason").is_empty() {
            return Err("建议需要说明依据".into());
        }
        let mut v = item.clone();
        match text(item, "type") {
            "rule" => {
                validate_rule(&item["rule"])?;
                if !text(&item["rule"], "id").is_empty() {
                    return Err("AI 规则建议只能创建新规则；合并或修改已有规则请由用户编辑".into());
                }
                let ids = item["feedbackIds"]
                    .as_array()
                    .filter(|ids| !ids.is_empty())
                    .ok_or("规则建议至少需要一条真实反馈")?;
                for id in ids {
                    let f = load(c, id.as_str().ok_or("feedbackIds 无效")?)?;
                    if f["kind"] != "feedback" {
                        return Err("反馈不存在".into());
                    }
                    if !text(&request, "deckId").is_empty()
                        && text(&f["snapshot"], "deckId") != text(&request, "deckId")
                    {
                        return Err("反馈超出当前整理范围".into());
                    }
                }
            }
            "rewrite" => {
                let id = text(item, "cardId");
                let card = eligible
                    .iter()
                    .find(|v| text(v, "id") == id)
                    .ok_or("改写卡片超出整理范围或已删除")?;
                if text(item, "fingerprint") != card_fingerprint(card) {
                    return Err("卡片内容已变化，请重新读取后改写".into());
                }
                if text(item, "evidence").is_empty() {
                    return Err("改写建议需提供来源依据".into());
                }
                let after = &item["after"];
                let (q, a, e, t, d) = normalize_flashcard_editor_fields(
                    text(after, "question"),
                    text(after, "answer"),
                    text(after, "explanation"),
                    text(after, "cardType"),
                    Some(&after["cardData"]),
                )?;
                // Rewrites retain the original media/source; unsupported spatial edits need the full editor.
                if t == "image_occlusion" && card["cardType"] != "image_occlusion" {
                    return Err("请在卡片编辑器中创建新的遮挡图".into());
                }
                v["before"] = card.clone();
                v["after"] =
                    json!({"question":q,"answer":a,"explanation":e,"cardType":t,"cardData":d});
            }
            _ => return Err("建议类型只能为 rule 或 rewrite".into()),
        }
        let id = format!(
            "proposal-{:x}",
            Sha256::digest(format!("{}:{}", text(&request, "id"), item).as_bytes())
        );
        if let Ok(existing) = load(c, &id) {
            out.push(existing);
            continue;
        }
        v["id"] = json!(id);
        v["kind"] = json!("proposal");
        v["requestId"] = request["id"].clone();
        v["status"] = json!("pending");
        v["revision"] = json!(rev);
        v["baseRuleIds"] = json!(records(c)?
            .iter()
            .filter(|r| r["kind"] == "rule")
            .map(|r| r["id"].clone())
            .collect::<Vec<_>>());
        v["updatedAt"] = json!(timestamp());
        put(c, &v)?;
        out.push(v);
    }
    if args["complete"] == true {
        let mut done = request;
        done["status"] = json!("completed");
        done["summary"] = json!(text(args, "summary"));
        done["updatedAt"] = json!(timestamp());
        put(c, &done)?;
    }
    mark_flashcard_sync_dirty(c)?;
    Ok(json!({"proposals":out,"status":"awaiting-user-review"}))
}
fn resolve(
    c: &mut Connection,
    id: &str,
    expected: i64,
    accept: bool,
    schedule: &str,
) -> Result<Value, String> {
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let mut proposal = load(&tx, id)?;
    if proposal["kind"] != "proposal"
        || proposal["status"] != "pending"
        || proposal["updatedAt"].as_i64() != Some(expected)
    {
        return Err("建议已变化或已处理，请刷新".into());
    }
    if accept {
        let all = records(&tx)?;
        let mut baseline = all.clone();
        if proposal["type"] == "rule" {
            let sibling_ids: Vec<_> = all
                .iter()
                .filter(|v| {
                    v["kind"] == "proposal"
                        && v["requestId"] == proposal["requestId"]
                        && v["status"] == "accepted"
                        && v["type"] == "rule"
                })
                .map(|v| v["resultRuleId"].clone())
                .collect();
            // Accept siblings from one reviewed batch without ignoring subsequent user edits.
            baseline.retain(|r| {
                !(r["kind"] == "rule"
                    && sibling_ids.contains(&r["id"])
                    && !proposal["baseRuleIds"]
                        .as_array()
                        .is_some_and(|ids| ids.contains(&r["id"]))
                    && all
                        .iter()
                        .any(|v| v["resultRuleId"] == r["id"] && v["acceptedRule"] == *r))
            });
        }
        if text(&proposal, "revision") != revision(&baseline) {
            return Err("规则已变化，请重新整理后接受建议".into());
        }
        if proposal["type"] == "rule" {
            let r = save_rule(&tx, &proposal["rule"], "")?;
            proposal["resultRuleId"] = r["id"].clone();
            proposal["acceptedRule"] = r;
        } else {
            let card = flashcard_by_id(&tx, text(&proposal, "cardId"))?;
            let current = card_snapshot(&tx, &card)?;
            if card_fingerprint(&current) != text(&proposal, "fingerprint") {
                return Err("原卡片或来源已变化，请重新核对并生成改写建议".into());
            }
            let a = &proposal["after"];
            if !matches!(schedule, "keep" | "new") {
                return Err("请选择保留进度或保存为新卡重新学习".into());
            }
            let target = if schedule == "new" {
                let new_id = format!("card-{}", random_url_safe(14));
                tx.execute("INSERT INTO flashcards(id,deck_id,question,answer,explanation,card_type,card_data_json,media_json,source_library_id,source_document_id,source_block_id,source_title,source_path,source_hash,tags_json,created_at,updated_at,due_at,status,generation_json,evidence,confidence,custom_fields_json) SELECT ?1,deck_id,question,answer,explanation,card_type,card_data_json,media_json,source_library_id,source_document_id,source_block_id,source_title,source_path,source_hash,tags_json,?2,?2,?2,'active',generation_json,evidence,confidence,custom_fields_json FROM flashcards WHERE id=?3",params![new_id,now_timestamp(),card.id]).map_err(|e|e.to_string())?;
                new_id
            } else {
                card.id.clone()
            };
            tx.execute("UPDATE flashcards SET question=?2,answer=?3,explanation=?4,card_type=?5,card_data_json=?6,updated_at=MAX(updated_at+1,?7),evidence=?8,source_hash=?9 WHERE id=?1",params![target,text(a,"question"),text(a,"answer"),text(a,"explanation"),text(a,"cardType"),a["cardData"].to_string(),now_timestamp(),text(&proposal,"evidence"),current["sourceRevision"].as_str().unwrap_or(&card.source_hash)]).map_err(|e|e.to_string())?;
            tx.execute(
                "UPDATE flashcard_decks SET updated_at=?2 WHERE id=?1",
                params![card.deck_id, now_timestamp()],
            )
            .map_err(|e| e.to_string())?;
            proposal["resultCardId"] = json!(target);
            proposal["schedule"] = json!(schedule);
        }
    }
    proposal["status"] = json!(if accept { "accepted" } else { "rejected" });
    proposal["updatedAt"] = json!(timestamp().max(expected + 1));
    put(&tx, &proposal)?;
    mark_flashcard_sync_dirty(&tx)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(proposal)
}
#[tauri::command]
pub(super) fn resolve_flashcard_quality_proposal(
    app: AppHandle,
    id: String,
    expected_updated_at: i64,
    accept: bool,
    schedule: String,
) -> Result<Value, String> {
    let (mut c, _guard) = open_write_database(&database_path(&app)?)?;
    let value = resolve(&mut c, &id, expected_updated_at, accept, &schedule)?;
    schedule_sync(&app);
    Ok(value)
}
#[tauri::command]
pub(super) fn preview_flashcard_quality_impact(
    app: AppHandle,
    rule_id: String,
    deck_id: Option<String>,
) -> Result<Value, String> {
    let c = open_database(&database_path(&app)?)?;
    let cards = affected(&c, &json!({"ruleId":rule_id,"deckId":deck_id}))?;
    Ok(
        json!({"count":cards.len(),"cards":cards.iter().take(30).map(|v|json!({"id":v["id"],"question":v["question"],"deckId":v["deckId"]})).collect::<Vec<_>>(),"note":"仅按适用范围列出候选，不代表这些卡片违反规则；AI 复核仍须核对原文。"}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quality_sync_status_uses_active_provider() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO metadata(key,value) VALUES
                ('flashcard_cloud_provider','oss'),
                ('flashcard_sync_auto','1'),
                ('flashcard_sync_dirty','1'),
                ('flashcard_sync_last_error','Retry pending'),
                ('flashcard_sync_last_success','17');",
        )
        .unwrap();
        let configure = |value: &Value| {
            c.execute(
                "INSERT INTO metadata(key,value) VALUES('flashcard_oss_config',?1)
                    ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![value.to_string()],
            )
            .unwrap();
        };
        let mut oss = json!({
            "bucket":"quality-test",
            "region":"cn-shanghai",
            "prefix":"HubFlashcards",
            "accessKeyId":"TestAccessKey"
        });
        configure(&oss);
        let status = quality_sync_status(&c);
        assert_eq!(status["enabled"], true, "OSS does not require a WebDAV URL");
        assert_eq!(status["pending"], true);
        assert_eq!(status["error"], "Retry pending");
        assert_eq!(status["lastSuccess"], 17);
        assert!(status["running"].is_boolean());

        c.execute(
            "INSERT INTO metadata(key,value) VALUES('flashcard_webdav_url','https://legacy.example/dav')",
            [],
        )
        .unwrap();
        oss["bucket"] = json!("INVALID_BUCKET");
        configure(&oss);
        assert_eq!(
            quality_sync_status(&c)["enabled"],
            false,
            "A legacy WebDAV URL cannot enable an invalid active OSS configuration"
        );

        oss["bucket"] = json!("quality-test");
        configure(&oss);
        c.execute(
            "UPDATE metadata SET value='0' WHERE key='flashcard_sync_auto'",
            [],
        )
        .unwrap();
        assert_eq!(quality_sync_status(&c)["enabled"], false);

        c.execute_batch(
            "UPDATE metadata SET value='1' WHERE key='flashcard_sync_auto';
            UPDATE metadata SET value='webdav' WHERE key='flashcard_cloud_provider';",
        )
        .unwrap();
        assert_eq!(quality_sync_status(&c)["enabled"], true);
        c.execute(
            "UPDATE metadata SET value=' ' WHERE key='flashcard_webdav_url'",
            [],
        )
        .unwrap();
        assert_eq!(quality_sync_status(&c)["enabled"], false);
    }
    fn database() -> (PathBuf, Connection) {
        let p = std::env::temp_dir().join(format!("quality-test-{}.sqlite3", random_url_safe(12)));
        let c = open_database(&p).unwrap();
        c.execute_batch("INSERT INTO flashcard_decks(id,name,created_at,updated_at) VALUES('deck','Engineering',1,1);
          INSERT INTO flashcards(id,deck_id,question,answer,card_type,created_at,updated_at,due_at,source_library_id,source_document_id) VALUES('card','deck','Configuration value?','42','qa',1,1,100,'lib','doc');").unwrap();
        (p, c)
    }
    fn rule() -> Value {
        json!({"title":"Principles","text":"Prefer reasons over environment-specific values","scopeType":"deck","scopeValue":"deck","learningGoal":"principles","enabled":true})
    }
    fn request(c: &Connection) -> Value {
        let r = json!({"id":"request-test","kind":"request","task":"audit","deckId":"deck","status":"pending","updatedAt":timestamp()});
        put(c, &r).unwrap();
        r
    }
    fn rewrite(c: &Connection) -> Value {
        let w = work(c, &json!({"requestId":"request-test"})).unwrap();
        json!({"requestId":"request-test","revision":w["revision"],"proposals":[{"type":"rewrite","cardId":"card","fingerprint":w["cards"][0]["fingerprint"],"reason":"Test the principle","evidence":"Source section explains the reason","after":{"question":"Why use this configuration?","answer":"To isolate environments","explanation":"Values vary by deployment","cardType":"qa","cardData":{}}}]})
    }
    #[test]
    fn quality_proposals_require_acceptance_and_preserve_progress() {
        let (_p, mut c) = database();
        request(&c);
        c.execute(
            "UPDATE flashcards SET repetitions=5,lapses=2 WHERE id='card'",
            [],
        )
        .unwrap();
        let args = rewrite(&c);
        let result = propose(&c, &args).unwrap();
        let p = &result["proposals"][0];
        assert_eq!(
            flashcard_by_id(&c, "card").unwrap().question,
            "Configuration value?"
        );
        assert_eq!(propose(&c, &args).unwrap()["proposals"][0]["id"], p["id"]);
        let accepted = resolve(
            &mut c,
            text(p, "id"),
            p["updatedAt"].as_i64().unwrap(),
            true,
            "keep",
        )
        .unwrap();
        assert_eq!(accepted["status"], "accepted");
        let card = flashcard_by_id(&c, "card").unwrap();
        assert_eq!(card.repetitions, 5);
        assert_eq!(card.lapses, 2);
        assert_eq!(card.due_at, 100);
        assert_eq!(card.question, "Why use this configuration?");
        assert!(resolve(
            &mut c,
            text(p, "id"),
            p["updatedAt"].as_i64().unwrap(),
            true,
            "keep"
        )
        .is_err());
    }
    #[test]
    fn quality_new_card_and_stale_rewrite() {
        let (_p, mut c) = database();
        request(&c);
        let args = rewrite(&c);
        let result = propose(&c, &args).unwrap();
        let p = &result["proposals"][0];
        let accepted = resolve(
            &mut c,
            text(p, "id"),
            p["updatedAt"].as_i64().unwrap(),
            true,
            "new",
        )
        .unwrap();
        assert_eq!(
            flashcard_by_id(&c, "card").unwrap().question,
            "Configuration value?"
        );
        assert_eq!(
            flashcard_by_id(&c, text(&accepted, "resultCardId"))
                .unwrap()
                .question,
            "Why use this configuration?"
        );
        let mut changed = args;
        changed["proposals"][0]["reason"] = json!("Another revision");
        let p = propose(&c, &changed).unwrap()["proposals"][0].clone();
        c.execute(
            "UPDATE flashcards SET answer='different' WHERE id='card'",
            [],
        )
        .unwrap();
        assert!(resolve(
            &mut c,
            text(&p, "id"),
            p["updatedAt"].as_i64().unwrap(),
            true,
            "keep"
        )
        .is_err());
        assert_eq!(load(&c, text(&p, "id")).unwrap()["status"], "pending");
        assert!(propose(&c, &changed).is_err());
    }
    #[test]
    fn quality_source_revision_changes_invalidate_old_advice() {
        let (_p, mut c) = database();
        request(&c);
        c.execute("INSERT INTO documents(space_id,id,title,path,markdown,indexed_at,content_hash) VALUES('lib','doc','Source','source.md','Current source',1,'revision-a')",[]).unwrap();
        let result = propose(&c, &rewrite(&c)).unwrap();
        let p = &result["proposals"][0];
        c.execute(
            "UPDATE documents SET content_hash='revision-b' WHERE id='doc'",
            [],
        )
        .unwrap();
        assert!(resolve(
            &mut c,
            text(p, "id"),
            p["updatedAt"].as_i64().unwrap(),
            true,
            "keep"
        )
        .is_err());
        let fresh = propose(&c, &rewrite(&c)).unwrap();
        let p = &fresh["proposals"][0];
        resolve(
            &mut c,
            text(p, "id"),
            p["updatedAt"].as_i64().unwrap(),
            true,
            "keep",
        )
        .unwrap();
        let card = flashcard_by_id(&c, "card").unwrap();
        assert_eq!(card.source_hash, "revision-b");
        assert!(!card.source_changed);
        assert_eq!(card.due_at, 100);
    }
    #[test]
    fn quality_sibling_rules_and_atomic_batch() {
        let (_p, mut c) = database();
        request(&c);
        let f = feedback(
            &mut c,
            json!({"cardId":"card","reason":"low-value","action":"record"}),
        )
        .unwrap();
        let mut second = rule();
        second["text"] = json!("Prefer causal explanations");
        let args = json!({"requestId":"request-test","revision":revision(&records(&c).unwrap()),"proposals":[{"type":"rule","reason":"User preference","feedbackIds":[f["id"]],"rule":rule()},{"type":"rule","reason":"Another preference","feedbackIds":[f["id"]],"rule":second}]});
        let result = propose(&c, &args).unwrap();
        assert!(!records(&c).unwrap().iter().any(|v| v["kind"] == "rule"));
        for p in result["proposals"].as_array().unwrap() {
            resolve(
                &mut c,
                text(p, "id"),
                p["updatedAt"].as_i64().unwrap(),
                true,
                "keep",
            )
            .unwrap();
        }
        assert_eq!(
            records(&c)
                .unwrap()
                .iter()
                .filter(|v| v["kind"] == "rule")
                .count(),
            2
        );
        let before = records(&c).unwrap().len();
        let tx = c.transaction().unwrap();
        let mut args = rewrite(&tx);
        args["proposals"]
            .as_array_mut()
            .unwrap()
            .push(json!({"type":"unknown","reason":"invalid"}));
        assert!(propose(&tx, &args).is_err());
        drop(tx);
        assert_eq!(records(&c).unwrap().len(), before);
    }
    #[test]
    fn quality_rule_boundaries_and_exception_receipts() {
        let (_p, c) = database();
        let mut input = rule();
        input["exceptions"] = json!("Explicit identifier memorization is allowed");
        let r = save_rule(&c, &input, "").unwrap();
        for scope in [
            json!({"deckId":"other","learningGoal":"principles"}),
            json!({"deckId":"deck","learningGoal":"memorize identifiers"}),
        ] {
            assert!(context(&c, &scope).unwrap()["rules"]
                .as_array()
                .unwrap()
                .is_empty());
        }
        let scope = json!({"deckId":"deck","learningGoal":"principles with explicit identifier memorization"});
        let ctx = context(&c, &scope).unwrap();
        assert_eq!(ctx["rules"][0]["exceptions"], input["exceptions"]);
        let receipt = json!({"revision":ctx["revision"],"scope":scope,"ruleIds":[r["id"]],"ruleApplications":[{"ruleId":r["id"],"decision":"exception","reason":"The current user request explicitly asks to memorize the identifier."}]});
        assert!(validate_submission(&c, Some(&receipt), &[], "Engineering").is_ok());
        let generation =
            submission_generation(&c, &json!({"qualityContext":receipt}), &[], "Engineering")
                .unwrap();
        assert_eq!(
            generation["qualityContext"]["ruleSnapshots"][0]["text"],
            r["text"]
        );
        assert_eq!(
            generation["qualityContext"]["ruleSnapshots"][0]["scopeLabel"],
            "Engineering"
        );
        assert_eq!(
            generation["qualityContext"]["ruleApplications"][0]["decision"],
            "exception"
        );
        let mut bad = receipt.clone();
        bad["ruleApplications"][0]["reason"] = json!("");
        assert!(validate_submission(&c, Some(&bad), &[], "Engineering").is_err());
        bad = receipt;
        bad["ruleApplications"][0]["ruleId"] = json!("unrelated-rule");
        assert!(validate_submission(&c, Some(&bad), &[], "Engineering").is_err());
    }
    #[test]
    fn quality_rule_exception_does_not_cancel_an_explicit_card_exclusion() {
        let (_p, mut c) = database();
        save_rule(&c, &rule(), "").unwrap();
        feedback(
            &mut c,
            json!({"cardId":"card","reason":"low-value","action":"record","excludeTarget":true}),
        )
        .unwrap();
        let scope = json!({"deckId":"deck","learningGoal":"memorize identifiers"});
        let ctx = context(&c, &scope).unwrap();
        assert_eq!(ctx["rules"], json!([]));
        let receipt = json!({"revision":ctx["revision"],"scope":scope,"ruleIds":[]});
        let cards = vec![
            json!({"question":"Configuration value?","answer":"42","source":{"sourceLibraryId":"lib","sourceDocumentId":"doc"}}),
        ];
        assert!(
            validate_submission(&c, Some(&receipt), &cards, "Engineering")
                .unwrap_err()
                .contains("已被用户排除")
        );
    }
    #[test]
    fn quality_local_pdf_exclusion_uses_source_identity_and_import_aliases() {
        let (_p, mut c) = database();
        c.execute("UPDATE flashcards SET source_library_id='', source_document_id='', source_path=?1 WHERE id='card'",
            params![r"D:\\Downloads\\客户气泡图\\SOP.pdf"]).unwrap();
        feedback(
            &mut c,
            json!({"cardId":"card","reason":"low-value","action":"record","excludeTarget":true}),
        )
        .unwrap();
        for source in [
            json!({"sourcePath":"d:/Downloads/客户气泡图/SOP.pdf"}),
            json!({"source_path":r"D:\Downloads\客户气泡图\SOP.pdf"}),
        ] {
            let card = json!({"question":"Configuration value?","answer":"42","source":source});
            assert!(validate_submission(&c, None, &[card], "Engineering")
                .unwrap_err()
                .contains("已被用户排除"));
        }
        for path in ["D:/Other/SOP.pdf", "https://example.com/SOP.pdf"] {
            assert!(validate_submission(
                &c,
                None,
                &[json!({"question":"Configuration value?","sourcePath":path})],
                "Engineering"
            )
            .is_ok());
        }
        assert!(validate_submission(&c, None, &[json!({"question":"Different target?","sourcePath":"D:/Downloads/客户气泡图/SOP.pdf"})], "Engineering").is_ok());
        assert_ne!(
            exclusion_source_path("https://example.com/Case.pdf"),
            exclusion_source_path("https://example.com/case.pdf")
        );
        assert_ne!(
            exclusion_source_path("/data/Case.pdf"),
            exclusion_source_path("/data/case.pdf")
        );
        // Known, different document IDs must not be overridden by a shared display path.
        c.execute("UPDATE flashcards SET source_library_id='lib',source_document_id='doc' WHERE id='card'", []).unwrap();
        feedback(
            &mut c,
            json!({"cardId":"card","reason":"low-value","action":"record","excludeTarget":true}),
        )
        .unwrap();
        // Remove the first path-only feedback from this isolated test database.
        c.execute("DELETE FROM flashcard_quality_records WHERE json_extract(payload_json,'$.snapshot.sourceDocumentId')=''", []).unwrap();
        assert!(validate_submission(&c, None, &[json!({"question":"Configuration value?","sourcePath":"D:/Downloads/客户气泡图/SOP.pdf","source_document_id":"other","source_library_id":"lib"})], "Engineering").is_ok());
        assert!(validate_submission(&c, None, &[json!({"question":"Configuration value?","source_document_id":"doc","source_library_id":"lib"})], "Engineering").is_err());
    }
    #[test]
    fn quality_import_captures_rules_and_prevents_per_card_context_override() {
        let (p, c) = database();
        let r = save_rule(&c, &rule(), "").unwrap();
        let scope = json!({"deckId":"deck","learningGoal":"principles"});
        let ctx = context(&c, &scope).unwrap();
        let receipt = json!({"revision":ctx["revision"],"scope":scope,"ruleIds":[r["id"]],"excludedTargets":[{"recallTarget":"arbitrary configuration value","reason":"lookup only","ruleId":r["id"]}]});
        let result = import_flashcard_values(&p, "mcp://hub/submit_flashcard_drafts", "Engineering".into(), json!({"qualityContext":receipt}), vec![json!({"question":"Why separate project values from durable principles?","answer":"Project values can vary.","generation":{"qualityContext":{"ruleSnapshots":[{"text":"Forged rule"}]}}})], false).unwrap();
        assert_eq!(result.imported, 1);
        let draft = c.query_row(&format!("SELECT {FLASHCARD_DRAFT_SELECT_FIELDS} FROM flashcard_drafts WHERE batch_id=?1"), params![result.batch_id], flashcard_draft_from_row).unwrap();
        assert_eq!(
            draft.generation["qualityContext"]["ruleSnapshots"][0]["text"],
            r["text"]
        );
        assert_eq!(
            draft.generation["qualityContext"]["excludedTargets"],
            receipt["excludedTargets"]
        );
        let mut changed = r.clone();
        changed["text"] = json!("Changed after the draft was submitted");
        save_rule(&c, &changed, "").unwrap();
        let stored: String = c
            .query_row(
                "SELECT generation_json FROM flashcard_drafts WHERE id=?1",
                params![draft.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&stored).unwrap()["qualityContext"]["ruleSnapshots"][0]
                ["text"],
            r["text"]
        );
        assert_eq!(flashcard_by_id(&c, "card").unwrap().due_at, 100);
    }
    #[test]
    fn quality_sync_preserves_both_versions_and_replays_without_growth() {
        let (_a, mut mobile) = database();
        let (_b, mut windows) = database();
        let original = feedback(&mut mobile, json!({"cardId":"card","reason":"low-value","comment":"Learning preference","action":"record"})).unwrap();
        merge_flashcard_snapshot(&mut windows, &local_flashcard_snapshot(&mobile).unwrap())
            .unwrap();
        let mut mobile_version = original.clone();
        mobile_version["excludeTarget"] = json!(true);
        mobile_version["updatedAt"] = json!(original["updatedAt"].as_i64().unwrap() + 10);
        put(&mobile, &mobile_version).unwrap();
        let mut windows_version = original.clone();
        windows_version["status"] = json!("resolved");
        windows_version["updatedAt"] = json!(original["updatedAt"].as_i64().unwrap() + 20);
        put(&windows, &windows_version).unwrap();
        let old_wire = serde_json::to_vec(&local_flashcard_snapshot(&mobile).unwrap()).unwrap();
        let remote: FlashcardSyncSnapshot = serde_json::from_slice(&old_wire).unwrap();
        merge_flashcard_snapshot(&mut windows, &remote).unwrap();
        assert_eq!(
            load(&windows, text(&original, "id")).unwrap(),
            windows_version
        );
        let kept_history = load(&windows, &version_id(&mobile_version)).unwrap();
        assert_eq!(kept_history["excludeTarget"], true);
        assert_eq!(kept_history["status"], "open");
        let after = records(&windows).unwrap();
        merge_flashcard_snapshot(&mut windows, &remote).unwrap();
        assert_eq!(records(&windows).unwrap(), after);
        let wire = serde_json::to_vec(&local_flashcard_snapshot(&windows).unwrap()).unwrap();
        merge_flashcard_snapshot(&mut mobile, &serde_json::from_slice(&wire).unwrap()).unwrap();
        assert_eq!(
            load(&mobile, text(&original, "id")).unwrap(),
            windows_version
        );
        assert_eq!(records(&mobile).unwrap(), after);
        let exported = document(&after);
        assert!(exported.contains("同步发现不同版本"));
        assert!(exported.contains(&format!("版本时间：{}", mobile_version["updatedAt"])));
        assert!(exported.contains(&format!("版本时间：{}", original["updatedAt"])));
        assert!(!exported.contains(&format!("版本时间：{}", windows_version["updatedAt"])));
        assert_eq!(flashcard_by_id(&mobile, "card").unwrap().due_at, 100);
    }
    #[test]
    fn quality_sync_equal_time_is_deterministic_and_failed_merge_rolls_back_history() {
        let (_a, mut a) = database();
        let (_b, mut b) = database();
        let initial = feedback(
            &mut a,
            json!({"cardId":"card","reason":"low-value","action":"record"}),
        )
        .unwrap();
        merge_flashcard_snapshot(&mut b, &local_flashcard_snapshot(&a).unwrap()).unwrap();
        let mut one = initial.clone();
        one["comment"] = json!("A");
        let mut two = initial.clone();
        two["comment"] = json!("B");
        one["updatedAt"] = json!(initial["updatedAt"].as_i64().unwrap() + 1);
        two["updatedAt"] = one["updatedAt"].clone();
        put(&a, &one).unwrap();
        put(&b, &two).unwrap();
        let sa = local_flashcard_snapshot(&a).unwrap();
        let sb = local_flashcard_snapshot(&b).unwrap();
        merge_flashcard_snapshot(&mut a, &sb).unwrap();
        merge_flashcard_snapshot(&mut b, &sa).unwrap();
        assert_eq!(records(&a).unwrap(), records(&b).unwrap());
        let before = records(&a).unwrap();
        let mut invalid = local_flashcard_snapshot(&b).unwrap();
        let mut next = two;
        next["updatedAt"] = json!(timestamp() + 100);
        next["comment"] = json!("Not committed");
        invalid.quality_records = vec![next, json!({"kind":"invalid"})];
        assert!(merge_flashcard_snapshot(&mut a, &invalid).is_err());
        assert_eq!(records(&a).unwrap(), before);
    }
    #[test]
    fn quality_scope_and_stale_submission() {
        let (_p, c) = database();
        let r = save_rule(&c, &rule(), "").unwrap();
        let args = json!({"deckId":"deck","learningGoal":"learn principles"});
        let ctx = context(&c, &args).unwrap();
        assert_eq!(ctx["rules"].as_array().unwrap().len(), 1);
        assert_eq!(
            context(&c, &json!({"deckId":"other","learningGoal":"principles"})).unwrap()["rules"],
            json!([])
        );
        let submitted = json!({"revision":ctx["revision"],"scope":args,"ruleIds":[r["id"]]});
        assert!(validate_submission(&c, Some(&submitted), &[], "Engineering").is_ok());
        let mut changed = r;
        changed["text"] = json!("Revised preference");
        save_rule(&c, &changed, "").unwrap();
        assert!(validate_submission(&c, Some(&submitted), &[], "Engineering").is_err());
    }
    #[test]
    fn quality_actual_destination_and_tags_cannot_skip_rules() {
        let (_p, c) = database();
        let deck_rule = save_rule(&c, &rule(), "").unwrap();
        let mut topic_rule = rule();
        topic_rule["scopeType"] = json!("topic");
        topic_rule["scopeValue"] = json!("engineering");
        let topic_rule = save_rule(&c, &topic_rule, "").unwrap();
        let scope = json!({"learningGoal":"learn principles"});
        let ctx = context(&c, &scope).unwrap();
        let mut submitted = json!({"revision":ctx["revision"],"scope":scope,"ruleIds":[]});
        assert!(validate_submission(&c, Some(&submitted), &[], "Engineering").is_err());
        submitted["ruleIds"] = json!([deck_rule["id"]]);
        assert!(validate_submission(&c, Some(&submitted), &[], "Engineering").is_ok());
        let cards = vec![json!({"question":"Why?","tags":["Engineering"]})];
        assert!(validate_submission(&c, Some(&submitted), &cards, "Engineering").is_err());
        submitted["ruleIds"] = json!([deck_rule["id"], topic_rule["id"]]);
        assert!(validate_submission(&c, Some(&submitted), &cards, "Engineering").is_ok());
        let override_cards = vec![json!({"question":"Why?","deck_name":"Other"})];
        assert!(validate_submission(&c, Some(&submitted), &override_cards, "Engineering").is_err());
        submitted["scope"]["deckId"] = json!("other");
        assert!(validate_submission(&c, Some(&submitted), &cards, "Engineering").is_err());
    }
    #[test]
    fn quality_feedback_atomic_and_preserves_schedule() {
        let (_p, mut c) = database();
        let bad = json!({"cardId":"card","reason":"low-value","action":"pause","rule":{"text":""}});
        assert!(feedback(&mut c, bad).is_err());
        assert_eq!(flashcard_by_id(&c, "card").unwrap().status, "active");
        assert!(records(&c).unwrap().is_empty());
        let v=feedback(&mut c,json!({"cardId":"card","reason":"low-value","comment":"Lookup only","action":"pause","excludeTarget":true,"rule":rule()})).unwrap();
        let card = flashcard_by_id(&c, "card").unwrap();
        assert_eq!(card.status, "suspended");
        assert_eq!(card.due_at, 100);
        assert_eq!(card.repetitions, 0);
        assert_eq!(v["snapshot"]["answer"], "42");
        c.execute("DELETE FROM flashcards WHERE id='card'", [])
            .unwrap();
        assert_eq!(
            load(&c, text(&v, "id")).unwrap()["snapshot"]["question"],
            "Configuration value?"
        );
    }
    #[test]
    fn quality_upgrade_reopen_and_sync() {
        let (p, mut c) = database();
        let r = save_rule(&c, &rule(), "").unwrap();
        c.execute(
            "UPDATE metadata SET value='65' WHERE key='schema_version'",
            [],
        )
        .unwrap();
        drop(c);
        forget_initialized_database(&p);
        c = open_database(&p).unwrap();
        assert_eq!(
            metadata_u64(&c, "schema_version", 0),
            DATABASE_SCHEMA_VERSION as u64
        );
        assert_eq!(records(&c).unwrap().len(), 1);
        let snapshot = local_flashcard_snapshot(&c).unwrap();
        let (_other, mut d) = database();
        merge_flashcard_snapshot(&mut d, &snapshot).unwrap();
        assert_eq!(load(&d, text(&r, "id")).unwrap()["text"], r["text"]);
        let mut disabled = r;
        disabled["enabled"] = json!(false);
        save_rule(&c, &disabled, "").unwrap();
        let newer = local_flashcard_snapshot(&c).unwrap();
        merge_flashcard_snapshot(&mut d, &newer).unwrap();
        merge_flashcard_snapshot(&mut d, &snapshot).unwrap();
        assert_eq!(
            context(&d, &json!({"deckId":"deck","learningGoal":"principles"})).unwrap()["rules"],
            json!([])
        );
    }
    #[test]
    fn mobile_feedback_round_trips_to_windows_and_back() {
        let (_a, mut mobile) = database();
        let (_b, mut windows) = database();
        let f=feedback(&mut mobile,json!({"cardId":"card","reason":"low-value","comment":"Learn the principle","action":"pause","excludeTarget":true,"rule":rule()})).unwrap();
        let wire = serde_json::to_vec(&local_flashcard_snapshot(&mobile).unwrap()).unwrap();
        let remote: FlashcardSyncSnapshot = serde_json::from_slice(&wire).unwrap();
        merge_flashcard_snapshot(&mut windows, &remote).unwrap();
        assert_eq!(
            load(&windows, text(&f, "id")).unwrap()["snapshot"],
            f["snapshot"]
        );
        assert_eq!(
            flashcard_by_id(&windows, "card").unwrap().status,
            "suspended"
        );
        assert_eq!(
            context(
                &windows,
                &json!({"deckId":"deck","learningGoal":"principles"})
            )
            .unwrap()["rules"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let mut resolved = load(&windows, text(&f, "id")).unwrap();
        resolved["status"] = json!("resolved");
        resolved["updatedAt"] = json!(f["updatedAt"].as_i64().unwrap() + 1);
        put(&windows, &resolved).unwrap();
        merge_flashcard_snapshot(&mut mobile, &local_flashcard_snapshot(&windows).unwrap())
            .unwrap();
        merge_flashcard_snapshot(&mut mobile, &remote).unwrap();
        assert_eq!(load(&mobile, text(&f, "id")).unwrap()["status"], "resolved");
        assert_eq!(
            records(&mobile)
                .unwrap()
                .iter()
                .filter(|v| v["kind"] == "feedback")
                .count(),
            1
        );
    }
    #[test]
    fn feedback_saved_during_upload_remains_pending() {
        let (_p, mut c) = database();
        mark_flashcard_sync_dirty(&c).unwrap();
        let uploaded = metadata_u64(&c, "flashcard_sync_revision", 0);
        c.execute(
            "INSERT INTO metadata(key,value) VALUES('flashcard_sync_upload_revision',?1)",
            params![uploaded.to_string()],
        )
        .unwrap();
        feedback(
            &mut c,
            json!({"cardId":"card","reason":"low-value","action":"record"}),
        )
        .unwrap();
        let result = Ok(FlashcardSyncSummary {
            cloud_report: None,
            uploaded_cards: 1,
            downloaded_cards: 0,
            merged_reviews: 0,
            uploaded_media: 0,
            downloaded_media: 0,
            conflict_retries: 0,
            completed_at: 100,
        });
        record_flashcard_sync_result_in_connection(&c, 99, &result).unwrap();
        assert!(metadata_bool(&c, "flashcard_sync_dirty", false));
        c.execute(
            "UPDATE metadata SET value=?1 WHERE key='flashcard_sync_upload_revision'",
            params![metadata_u64(&c, "flashcard_sync_revision", 0).to_string()],
        )
        .unwrap();
        record_flashcard_sync_result_in_connection(&c, 100, &result).unwrap();
        assert!(!metadata_bool(&c, "flashcard_sync_dirty", true));
    }
}

// Decks with the same name may have different IDs on another device.
pub(super) fn remap_decks(value: &mut Value, ids: &HashMap<String, String>) {
    if let Some(object) = value.as_object_mut() {
        for key in ["deckId", "scopeValue"] {
            if key == "scopeValue"
                && object.get("scopeType").and_then(Value::as_str) != Some("deck")
            {
                continue;
            }
            if let Some(mapped) = object
                .get(key)
                .and_then(Value::as_str)
                .and_then(|id| ids.get(id))
                .cloned()
            {
                object.insert(key.into(), json!(mapped));
            }
        }
        for child in object.values_mut() {
            remap_decks(child, ids);
        }
    } else if let Some(array) = value.as_array_mut() {
        for child in array {
            remap_decks(child, ids);
        }
    }
}

#[tauri::command]
pub(super) async fn sync_flashcard_quality_if_enabled(app: AppHandle) -> Result<Value, String> {
    let settings = get_flashcard_sync_settings(app.clone())?;
    if !settings.configured || !settings.auto_sync {
        return Ok(json!({"state":"local"}));
    }
    // Concurrent callers share the active upload; durable dirty state schedules a follow-up.
    let Ok(_request) = QUALITY_SYNC_REQUEST.try_lock() else {
        return Ok(json!({"state":"syncing"}));
    };
    {
        let c = open_database(&database_path(&app)?)?;
        if !cloud_sync::automatic(&c) {
            return Ok(json!({"state":"local"}));
        }
        if FLASHCARD_SYNC_LOCK.try_lock().is_err() {
            return Ok(json!({"state":"syncing"}));
        }
    }
    if !claim_flashcard_auto_sync_due(&database_path(&app)?)? {
        return Ok(json!({"state":"scheduled"}));
    }
    run_flashcard_sync(app, true).await?;
    Ok(json!({"state":"synced"}))
}
static QUALITY_SYNC_REQUEST: AsyncMutex<()> = AsyncMutex::const_new(());

fn schedule_sync(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = sync_flashcard_quality_if_enabled(app).await;
    });
}
