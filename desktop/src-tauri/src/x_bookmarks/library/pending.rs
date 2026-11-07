//! One active writer per item; preserve blocked plans by target so other copies can advance.
use super::*;
const COLUMNS: &str =
    "item_key,action,target,phase,error,plan,updated_at,goal,cleanup_force,detail";
pub(super) fn schema(c: &Connection) -> Result<(), String> {
    c.execute_batch(&format!("CREATE TABLE IF NOT EXISTS collection_library_pending AS SELECT {COLUMNS} FROM collection_library_jobs WHERE 0; CREATE UNIQUE INDEX IF NOT EXISTS collection_pending_target ON collection_library_pending(item_key,target);")).map_err(|e| e.to_string())
}
pub(super) fn yield_blocked(c: &Connection) -> Result<(), String> {
    let condition = "action='move' AND inflight=0 AND (phase IN ('partial','failed','unknown','needs_review') OR error<>'') AND phase NOT IN ('planning','writing','saving','cancelled') AND NOT EXISTS(SELECT 1 FROM collection_library_destinations d WHERE d.item_key=collection_library_jobs.item_key AND d.target=collection_library_jobs.target AND d.selected=0) AND EXISTS(SELECT 1 FROM collection_library_destinations d WHERE d.item_key=collection_library_jobs.item_key AND d.target<>collection_library_jobs.target AND d.state='queued' AND d.selected=1)";
    c.execute(&format!("INSERT OR REPLACE INTO collection_library_pending({COLUMNS}) SELECT {COLUMNS} FROM collection_library_jobs WHERE {condition}"),[]).map_err(|e|e.to_string())?;
    c.execute(&format!("INSERT INTO collection_library_destinations(item_key,target,state) SELECT item_key,target,'blocked' FROM collection_library_jobs WHERE {condition} ON CONFLICT(item_key,target) DO UPDATE SET state='blocked'"),[]).map_err(|e|e.to_string())?;
    c.execute(
        &format!("DELETE FROM collection_library_jobs WHERE {condition}"),
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
pub(super) fn request_retry(c: &Connection, key: &str, target: &str) -> Result<(), String> {
    // A click requests the retained plan, not a second creation. Unknown writes
    // still require reconciliation through the existing review UI.
    c.execute("UPDATE collection_library_destinations SET state='queued' WHERE item_key=?1 AND target=?2 AND selected=1 AND state='blocked'",params![key,target]).map_err(|e| e.to_string())?;
    Ok(())
}
pub(super) fn retain_cancelled(c: &Connection, key: &str, target: &str) -> Result<(), String> {
    c.execute(&format!("INSERT OR REPLACE INTO collection_library_pending({COLUMNS}) SELECT {COLUMNS} FROM collection_library_jobs WHERE item_key=?1 AND target=?2 AND action='move' AND phase<>'cancelled'"),params![key,target]).map_err(|e|e.to_string())?;
    c.execute("UPDATE collection_library_pending SET phase=CASE WHEN phase IN ('writing','saving','cleanup') THEN 'unknown' WHEN phase='planning' THEN CASE WHEN plan<>'' THEN 'needs_review' ELSE 'queued' END ELSE phase END,error=CASE WHEN phase IN ('writing','saving','cleanup') THEN '取消选择时正在写入；重新选择后请先核对已有副本，避免重复创建' ELSE error END WHERE item_key=?1 AND target=?2",params![key,target]).map_err(|e|e.to_string())?;
    Ok(())
}
pub(super) fn restore_requested(c: &Connection) -> Result<(), String> {
    c.execute("UPDATE collection_library_jobs SET (phase,error,plan,updated_at,goal,cleanup_force,detail)=(SELECT phase,error,plan,updated_at,goal,cleanup_force,detail FROM collection_library_pending p WHERE p.item_key=collection_library_jobs.item_key AND p.target=collection_library_jobs.target) WHERE phase='queued' AND plan='' AND EXISTS(SELECT 1 FROM collection_library_pending p WHERE p.item_key=collection_library_jobs.item_key AND p.target=collection_library_jobs.target) AND NOT EXISTS(SELECT 1 FROM collection_library_destinations d WHERE d.item_key=collection_library_jobs.item_key AND d.target=collection_library_jobs.target AND d.selected=0)",[]).map_err(|e|e.to_string())?;
    c.execute("DELETE FROM collection_library_pending WHERE EXISTS(SELECT 1 FROM collection_library_jobs j WHERE j.item_key=collection_library_pending.item_key AND j.target=collection_library_pending.target AND j.phase<>'cancelled') AND NOT EXISTS(SELECT 1 FROM collection_library_destinations d WHERE d.item_key=collection_library_pending.item_key AND d.target=collection_library_pending.target AND d.selected=0)",[]).map_err(|e|e.to_string())?;
    Ok(())
}
