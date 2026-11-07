//! Codex drafts never replace the user-confirmed assignment definition.
use super::*;

pub(super) fn read(c: &Connection, tag: &str) -> Result<Option<Value>, String> {
    c.query_row("SELECT id,base_version,definition_json FROM tag_assignment_definition_drafts WHERE tag=?1 ORDER BY id DESC LIMIT 1", [tag], |r| {
        let raw: String = r.get(2)?;
        Ok(json!({"id":r.get::<_,i64>(0)?,"baseVersion":r.get::<_,i64>(1)?,"definition":serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null)}))
    }).optional().map_err(|e|e.to_string())
}

pub(in crate::hub_mcp) fn submit(root: &Path, args: &Value) -> Result<Value, String> {
    let tag = normalized_tag_argument(args, "tag")?;
    let key = text_field(args, "idempotencyKey", 1, 240)?;
    let expected = args["expectedVersion"]
        .as_i64()
        .filter(|v| *v >= 0)
        .ok_or("缺少定义版本")?;
    let d = json!({"description":text_field(&args["definition"],"description",1,2000)?,
        "include":text_field(&args["definition"],"include",1,2000)?,
        "exclude":text_field(&args["definition"],"exclude",0,2000)?});
    let hash = digest(&json!({"tag":tag,"version":expected,"definition":d}));
    let mut c = open_database(&hub_mcp_database(root)?)?;
    let tx = c
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let prior: Option<(i64, String)> = tx
        .query_row(
            "SELECT id,request_hash FROM tag_assignment_definition_drafts WHERE request_key=?1",
            [&key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some((id, old_hash)) = prior {
        if old_hash != hash {
            return Err("幂等键已用于不同草稿".into());
        }
        return Ok(json!({"draftId":id,"saved":true,"confirmed":false}));
    }
    let exists: bool = tx.query_row(&format!("{HUB_TAG_ENTITIES_CTE} SELECT EXISTS(SELECT 1 FROM all_tags WHERE normalized_tag=?1)"),[&tag],|r|r.get(0)).map_err(|e|e.to_string())?;
    if !exists {
        return Err("标签已不存在，请刷新标签目录".into());
    }
    let current = read_definition(&tx, &tag)?
        .and_then(|v| v["version"].as_i64())
        .unwrap_or(0);
    if expected != current {
        return Err("标签定义已变化，请重新读取后生成草稿".into());
    }
    tx.execute("INSERT INTO tag_assignment_definition_drafts(tag,base_version,definition_json,request_key,request_hash) VALUES (?1,?2,?3,?4,?5)",params![tag,expected,d.to_string(),key,hash]).map_err(|e|e.to_string())?;
    let id = tx.last_insert_rowid();
    tx.commit().map_err(|e| e.to_string())?;
    Ok(json!({"draftId":id,"saved":true,"confirmed":false}))
}
