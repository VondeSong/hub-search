use super::*;

const PRESERVED_REASON: &str = "用户选择保留两边内容，已结束自动清理";

// Earlier versions recorded the decision only in the receipt. On upgrade,
// retire their matching reading warnings too. A single UPDATE is atomic and
// participates in the caller's initialization transaction when there is one.
// The enrichment table is created after reading receipts on a fresh database.
pub(super) fn retire_preserved_warnings(c: &Connection) -> Result<(), String> {
    let exists = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='collection_x_enrichment')",
        [], |r| r.get::<_, bool>(0),
    ).map_err(|e| e.to_string())?;
    if !exists {
        return Ok(());
    }
    c.execute(
        "UPDATE collection_x_enrichment SET error=''
         WHERE signature='dida-reading' AND error<>''
         AND EXISTS(SELECT 1 FROM collection_dida_reading r
                    WHERE r.item_key=collection_x_enrichment.item_key AND r.delete_state='preserved')",
        [],
    ).map(|_| ()).map_err(|e| e.to_string())
}

pub(super) fn list(c: &Connection) -> Result<Value, String> {
    let mut q = c.prepare(
        "SELECT item_key,raw_json,snapshot_hash,error,delete_state,updated_at,project_id,task_id
         FROM collection_dida_reading WHERE delete_state IN ('pending','verified','preserved')
         ORDER BY updated_at DESC"
    ).map_err(|e| e.to_string())?;
    let rows = q
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, String>(7)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut items = Vec::new();
    for row in rows {
        let (key, raw, snapshot, error, state, updated, project, task) =
            row.map_err(|e| e.to_string())?;
        let raw: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
        let source_url = if valid_id(&project) && valid_id(&task) {
            dida_task_url(&project, &task)
        } else {
            String::new()
        };
        items.push(json!({"key":key,"title":raw.get("title").and_then(Value::as_str).unwrap_or("滴答稍后读"),
            "sourceUrl":source_url,"snapshot":snapshot,"error":error,"reasonKind":retained_reason_kind(&error),
            "state":state,"updatedAt":updated}));
    }
    Ok(Value::Array(items))
}

// Ending a retained item's cleanup authorizes no deletion. Keep its audit
// receipt and both copies, and use compare-and-set to reject stale decisions.
pub(super) fn resolve(
    c: &Connection,
    key: &str,
    snapshot: &str,
    error: &str,
    updated: i64,
    preserve: bool,
) -> Result<(), String> {
    let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
    let changed = tx
        .execute(
            "UPDATE collection_dida_reading SET delete_state=?1,error=?2,updated_at=?3
         WHERE item_key=?4 AND snapshot_hash=?5 AND error=?6 AND updated_at=?7
         AND ((?1='preserved' AND delete_state IN ('pending','verified'))
           OR (?1='pending' AND delete_state IN ('pending','verified','preserved')))",
            params![
                if preserve { "preserved" } else { "pending" },
                if preserve {
                    PRESERVED_REASON
                } else {
                    "用户要求重新读取检查"
                },
                now_timestamp(),
                key,
                snapshot,
                error,
                updated
            ],
        )
        .map_err(|e| e.to_string())?;
    if changed != 1 {
        return Err("这条内容的处理状态已变化，请刷新后重新选择".into());
    }
    // Enrichment is also presented by the reading list and operation records.
    // A successful decision retires this source's old warning atomically with
    // its receipt, without touching a different provider's enrichment result.
    tx.execute(
        "UPDATE collection_x_enrichment SET error='' WHERE item_key=?1 AND signature='dida-reading'",
        [key],
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn list_dida_reading_resolutions(app: AppHandle) -> Result<Value, String> {
    let c = open_database(&database_path(&app)?)?;
    list(&c)
}

#[tauri::command]
pub(crate) async fn resolve_dida_reading(
    app: AppHandle,
    key: String,
    snapshot: String,
    error: String,
    updated_at: i64,
    preserve: bool,
) -> Result<(), String> {
    let _guard = crate::reading_sync::LOCK.lock().await;
    let _decision = DECISION_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (c, _writer) = open_write_database(&database_path(&app)?)?;
    if running() {
        return Err("滴答正在同步，请等本轮结束后再选择处理方式".into());
    }
    resolve(&c, &key, &snapshot, &error, updated_at, preserve)
}
