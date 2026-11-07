//! Per-library polling plans. Manual sync and file watching keep their own admission.
use crate::{library_runtime, metadata_u64, now_timestamp, open_database, open_write_database};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const FAILURE_LIMIT: u64 = 3;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Args {
    action: String,
    library_id: String,
    minutes: Option<u64>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    library_id: String,
    minutes: Option<u64>,
    global_minutes: u64,
    effective_minutes: u64,
    next_sync_at: Option<i64>,
    stopped_after_failures: bool,
}
fn key(id: &str) -> String {
    format!("library_auto_sync_minutes:{id}")
}
fn read(c: &Connection, id: &str, now: i64) -> Result<Snapshot, String> {
    let last_sync: Option<i64> = c
        .query_row(
            "SELECT last_sync FROM libraries WHERE id=?1 AND enabled=1",
            [id],
            |r| r.get(0),
        )
        .map_err(|_| "找不到已启用的资料库")?;
    let minutes = c
        .query_row("SELECT value FROM metadata WHERE key=?1", [key(id)], |r| {
            r.get::<_, String>(0)
        })
        .optional()
        .map_err(|e| e.to_string())?
        .and_then(|v| v.parse::<u64>().ok())
        .map(|v| v.min(1440));
    let global_minutes = metadata_u64(c, "auto_sync_minutes", 15).min(1440);
    let effective_minutes = minutes.unwrap_or(global_minutes);
    let failures = metadata_u64(c, &format!("sync_consecutive_failures:{id}"), 0);
    let attempt = metadata_u64(c, &format!("library_auto_sync_attempt:{id}"), 0) as i64;
    let success = metadata_u64(c, &format!("sync_last_success:{id}"), 0) as i64;
    let reference = attempt.max(last_sync.unwrap_or(0)).max(success);
    let interval = (effective_minutes as i64) * 60;
    let delay = if failures > 0 {
        30_i64
            .saturating_mul(1_i64 << failures.min(3).saturating_sub(1))
            .min(interval)
    } else {
        interval
    };
    let stopped_after_failures = failures >= FAILURE_LIMIT;
    let next_sync_at = if effective_minutes == 0 || stopped_after_failures {
        None
    } else {
        Some(if reference == 0 {
            now
        } else {
            reference.saturating_add(delay)
        })
    };
    Ok(Snapshot {
        library_id: id.into(),
        minutes,
        global_minutes,
        effective_minutes,
        next_sync_at,
        stopped_after_failures,
    })
}
pub(crate) fn overview(
    c: &Connection,
    scope: Option<&str>,
) -> Result<(bool, i64, Option<i64>), String> {
    let mut q = c
        .prepare("SELECT id FROM libraries WHERE enabled=1 AND (?1 IS NULL OR id=?1)")
        .map_err(|e| e.to_string())?;
    let ids = q
        .query_map([scope], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let (mut enabled, mut failures, mut next) = (false, 0, None::<i64>);
    for id in ids {
        let id = id.map_err(|e| e.to_string())?;
        let plan = read(c, &id, now_timestamp())?;
        enabled |= plan.effective_minutes > 0;
        failures =
            failures.max(metadata_u64(c, &format!("sync_consecutive_failures:{id}"), 0) as i64);
        if let Some(at) = plan.next_sync_at {
            next = Some(next.map_or(at, |old| old.min(at)));
        }
    }
    Ok((enabled, failures, next))
}
pub(crate) fn claim(path: &PathBuf, id: &str) -> Result<bool, String> {
    let root = path.parent().ok_or("资料库目录不可用")?;
    if library_runtime::gate(root, id).is_err() {
        return Ok(false);
    }
    // Do not enqueue a second sync behind a live manual operation.
    if library_runtime::status(root, id)?.active_operations > 0 {
        return Ok(false);
    }
    let (mut c, _writer) = open_write_database(path)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let now = now_timestamp();
    if read(&tx, id, now)?.next_sync_at.is_none_or(|at| at > now) {
        return Ok(false);
    }
    tx.execute("INSERT INTO metadata(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![format!("library_auto_sync_attempt:{id}"),now.to_string()]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(true)
}
pub(crate) fn handle(path: &PathBuf, args: Args) -> Result<Snapshot, String> {
    match args.action.as_str() {
        "get" => read(&open_database(path)?, &args.library_id, now_timestamp()),
        "save" => {
            if args.minutes.is_some_and(|n| n > 1440) {
                return Err("同步间隔须为 0–1440 分钟，0 表示仅手动同步".into());
            }
            let (mut c, _writer) = open_write_database(path)?;
            let tx = c.transaction().map_err(|e| e.to_string())?;
            read(&tx, &args.library_id, now_timestamp())?;
            if let Some(minutes) = args.minutes {
                tx.execute("INSERT INTO metadata(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key(&args.library_id),minutes.to_string()]).map_err(|e|e.to_string())?;
            } else {
                tx.execute("DELETE FROM metadata WHERE key=?1", [key(&args.library_id)])
                    .map_err(|e| e.to_string())?;
            }
            let result = read(&tx, &args.library_id, now_timestamp())?;
            tx.commit().map_err(|e| e.to_string())?;
            Ok(result)
        }
        _ => Err("未知的同步频率操作".into()),
    }
}
#[tauri::command]
pub(crate) async fn library_sync_schedule(
    app: tauri::AppHandle,
    args: Args,
) -> Result<Snapshot, String> {
    let path = crate::database_path(&app)?;
    tokio::task::spawn_blocking(move || handle(&path, args))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn persisted_claims_are_independent_and_manual_recovery_restores_cadence() {
        let root =
            std::env::temp_dir().join(format!("hub-schedule-{}", crate::random_url_safe(12)));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("craft-search.sqlite3");
        let c = open_database(&path).unwrap();
        c.execute_batch("INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES('a','craft','A',1,1),('b','obsidian','B',1,1);").unwrap();
        assert!(claim(&path, "a").unwrap());
        assert!(!claim(&path, "a").unwrap());
        assert!(claim(&path, "b").unwrap());
        handle(
            &path,
            Args {
                action: "save".into(),
                library_id: "a".into(),
                minutes: Some(0),
            },
        )
        .unwrap();
        assert!(!claim(&path, "a").unwrap());
        assert_eq!(
            read(&c, "b", now_timestamp()).unwrap().effective_minutes,
            15
        );
        c.execute(
            "INSERT INTO metadata VALUES('sync_consecutive_failures:b','3')",
            [],
        )
        .unwrap();
        assert!(read(&c, "b", now_timestamp())
            .unwrap()
            .next_sync_at
            .is_none());
        c.execute(
            "UPDATE metadata SET value='0' WHERE key='sync_consecutive_failures:b'",
            [],
        )
        .unwrap();
        assert!(read(&c, "b", now_timestamp())
            .unwrap()
            .next_sync_at
            .is_some());
        assert!(handle(
            &path,
            Args {
                action: "save".into(),
                library_id: "a".into(),
                minutes: Some(1441)
            }
        )
        .is_err());
        drop(c);
        crate::forget_initialized_database(&path);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn independent_plans_inherit_zero_and_stop_after_three_failures() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE libraries(id TEXT,last_sync INTEGER,enabled INTEGER);CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);INSERT INTO libraries VALUES('a',1000,1),('b',1000,1);INSERT INTO metadata VALUES('auto_sync_minutes','15'),('library_auto_sync_minutes:a','5');").unwrap();
        assert_eq!(read(&c, "a", 1100).unwrap().next_sync_at, Some(1300));
        assert_eq!(read(&c, "b", 1100).unwrap().next_sync_at, Some(1900));
        c.execute("INSERT INTO metadata VALUES('auto_sync_minutes','0') ON CONFLICT(key) DO UPDATE SET value=excluded.value",[]).unwrap();
        assert!(read(&c, "b", 1100).unwrap().next_sync_at.is_none());
        assert_eq!(read(&c, "a", 1100).unwrap().effective_minutes, 5);
        c.execute_batch("INSERT INTO metadata VALUES('sync_consecutive_failures:a','3');")
            .unwrap();
        assert!(read(&c, "a", 1100).unwrap().stopped_after_failures);
        assert!(read(&c, "a", 1100).unwrap().next_sync_at.is_none());
    }
}
