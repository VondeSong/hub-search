//! Stored conversation discovery and reversible history preferences.
//! This module has no model, source-reader or desktop runtime dependencies.
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

pub(super) fn list_on(
    c: &Connection,
    anchor: &str,
    before: Option<&Value>,
    query: Option<&Value>,
    archived: Option<&Value>,
) -> Result<Value, String> {
    // Keep the owner's exact serialized locator for the indexed SQL match.
    // A Value round-trip could reorder keys in existing anchor_json strings.
    let scope: Value = serde_json::from_str(anchor).map_err(|_| "历史对话来源无效")?;
    let query = query
        .filter(|value| !value.is_null())
        .map(|value| value.as_str().ok_or("对话搜索条件无效"))
        .transpose()?
        .unwrap_or("")
        .trim();
    if query.chars().count() > 200 {
        return Err("对话标题搜索最多 200 个字符".into());
    }
    let archived = archived
        .filter(|value| !value.is_null())
        .map(|value| value.as_bool().ok_or("归档筛选无效"))
        .transpose()?
        .unwrap_or(false);
    let cursor = before
        .filter(|value| !value.is_null())
        .map(|value| {
            let time = value["updatedAt"]
                .as_i64()
                .filter(|time| *time >= 0)
                .ok_or("历史对话游标无效")?;
            let id = value["id"]
                .as_str()
                .filter(|id| !id.is_empty() && id.len() <= 150)
                .ok_or("历史对话游标无效")?;
            if value.get("anchor") != Some(&scope) {
                return Err("历史对话范围已变化，请重新打开历史".to_string());
            }
            // Old cursors remain valid only for the original, unfiltered list.
            let cursor_query = value
                .get("query")
                .map(|value| value.as_str().ok_or("历史对话游标无效"))
                .transpose()?
                .unwrap_or("");
            let cursor_archived = value
                .get("archived")
                .map(|value| value.as_bool().ok_or("历史对话游标无效"))
                .transpose()?
                .unwrap_or(false);
            if cursor_query != query || cursor_archived != archived {
                return Err("历史对话筛选已变化，请重新搜索".to_string());
            }
            let pinned = value
                .get("pinned")
                .map(|v| v.as_bool().ok_or("历史对话游标无效"))
                .transpose()?
                .unwrap_or(false);
            Ok((time, id, pinned))
        })
        .transpose()?;
    // Filter the complete stored history before keyset pagination. Search is
    // deliberately limited to titles; withdrawn answer bodies are not read.
    let mut q = c
        .prepare(
            "WITH history AS (
            SELECT agent_works.*, COALESCE((
                SELECT body_json FROM agent_records p
                WHERE p.work_id=agent_works.id AND p.kind='historyPreference'
                ORDER BY rowid DESC LIMIT 1
            ),'{}') AS preference FROM agent_works
        ), visible AS (
            SELECT *, COALESCE(json_extract(preference,'$.pinned'),0) AS pinned,
                COALESCE(json_extract(preference,'$.archived'),0) AS archived
            FROM history WHERE COALESCE(json_extract(preference,'$.deleted'),0)=0
        ), matching AS (
            SELECT *, CASE WHEN ?5 THEN 0 ELSE pinned END AS sort_pinned
            FROM visible WHERE (?1='null' OR anchor_json=?1) AND archived=?5
                AND (?6='' OR instr(lower(goal),lower(?6))>0)
        )
        SELECT id,goal,state,updated_at,
            1+(SELECT COUNT(*) FROM agent_records r WHERE r.work_id=matching.id
               AND r.kind IN ('userMessage','userDecision','steering','delivery')),
            pinned,archived
        FROM matching
        WHERE (?2 IS NULL OR sort_pinned<?4 OR (sort_pinned=?4
            AND (updated_at<?2 OR (updated_at=?2 AND id>?3))))
        ORDER BY sort_pinned DESC,updated_at DESC,id LIMIT 21",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = q
        .query_map(
            params![
                anchor,
                cursor.map(|c| c.0),
                cursor.map(|c| c.1),
                cursor.map(|c| c.2),
                archived,
                query
            ],
            |r| {
                Ok(
                    json!({"id":r.get::<_,String>(0)?,"goal":r.get::<_,String>(1)?,
            "state":r.get::<_,String>(2)?,"updatedAt":r.get::<_,i64>(3)?,
            "messageCount":r.get::<_,i64>(4)?,"pinned":r.get::<_,bool>(5)?,
            "archived":r.get::<_,bool>(6)?}),
                )
            },
        )
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let more = rows.len() > 20;
    rows.truncate(20);
    let next = if more {
        rows.last().map(|row| {
            json!({"updatedAt":row["updatedAt"],"id":row["id"],
                "pinned":!archived && row["pinned"]==true,"anchor":scope,
                "query":query,"archived":archived})
        })
    } else {
        None
    };
    Ok(json!({"works":rows,"nextCursor":next,"query":query,"archived":archived}))
}
#[derive(Debug, Default)]
pub(super) struct HistoryChange {
    pub(super) pinned: Option<bool>,
    pub(super) deleted: Option<bool>,
    pub(super) archived: Option<bool>,
}

pub(super) fn change(args: &Value) -> Result<HistoryChange, String> {
    let boolean = |key: &str, error: &str| {
        args.get(key)
            .map(|value| value.as_bool().ok_or_else(|| error.to_string()))
            .transpose()
    };
    let change = HistoryChange {
        pinned: boolean("pinned", "置顶状态无效")?,
        deleted: boolean("deleted", "删除状态无效")?,
        archived: boolean("archived", "归档状态无效")?,
    };
    if change.pinned.is_none() && change.deleted.is_none() && change.archived.is_none() {
        return Err("缺少历史操作".into());
    }
    Ok(change)
}

// The owner retains its transaction, business-state checks and append-only
// record writer. Reopening the history reads this same durable preference.
pub(super) fn preference_on(
    c: &Connection,
    id: &str,
    change: &HistoryChange,
    append: impl FnOnce(&Value) -> Result<(), String>,
) -> Result<Value, String> {
    let old: Option<String> = c
        .query_row(
            "SELECT body_json FROM agent_records WHERE work_id=?1 AND kind='historyPreference'
         ORDER BY rowid DESC LIMIT 1",
            [id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let old: Value = old
        .map(|value| serde_json::from_str(&value).map_err(|_| "历史偏好损坏"))
        .transpose()?
        .unwrap_or(json!({}));
    let old = json!({"pinned":old["pinned"]==true,"deleted":old["deleted"]==true,
        "archived":old["archived"]==true});
    let next = json!({"pinned":change.pinned.unwrap_or(old["pinned"]==true),
        "deleted":change.deleted.unwrap_or(old["deleted"]==true),
        "archived":change.archived.unwrap_or(old["archived"]==true)});
    if next != old {
        append(&next)?;
    }
    Ok(next)
}

#[cfg(test)]
#[path = "history_tests.rs"]
mod tests;
