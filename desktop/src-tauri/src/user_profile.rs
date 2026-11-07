//! Portable personal preferences. The database owns values; the webview only holds a mirror.
use crate::{database_path, metadata_string, open_write_database};
use rand::RngCore;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path};
use tauri::AppHandle;

const INITIALIZED: &str = "user_profile_initialized_v1";
const ID: &str = "user_profile_id_v1";
const MAX_VALUE_BYTES: usize = 8 * 1024 * 1024;
const MAX_BATCH_BYTES: usize = 16 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UserProfileSnapshot {
    context_id: String,
    initialized: bool,
    values: BTreeMap<String, String>,
}

#[derive(Clone, Deserialize)]
pub(crate) struct UserProfileChange {
    key: String,
    value: Option<String>,
}

pub(crate) fn ensure_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS user_profile_values (
            key TEXT PRIMARY KEY, value TEXT NOT NULL
        );",
        )
        .map_err(|error| format!("无法初始化个人数据：{error}"))?;
    if metadata_string(connection, ID).is_empty() {
        let mut bytes = [0_u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        let id = format!("{:x}", Sha256::digest(bytes));
        connection
            .execute(
                "INSERT OR IGNORE INTO metadata(key,value) VALUES (?1,?2)",
                params![ID, id],
            )
            .map_err(|error| format!("无法保存个人数据身份：{error}"))?;
    }
    Ok(())
}

/// Opening/restoring another data directory must never absorb this machine's old webview values.
pub(crate) fn seal_legacy_import(connection: &Connection) -> Result<(), String> {
    ensure_schema(connection)?;
    connection
        .execute(
            "INSERT OR REPLACE INTO metadata(key,value) VALUES (?1,'1')",
            [INITIALIZED],
        )
        .map_err(|error| format!("无法确认个人数据迁移状态：{error}"))?;
    Ok(())
}

fn context_id(connection: &Connection, path: &Path) -> String {
    let identity = format!(
        "{}\n{}",
        crate::library_location::path_key(path),
        metadata_string(connection, ID)
    );
    format!("{:x}", Sha256::digest(identity.as_bytes()))
}

fn snapshot(connection: &Connection, path: &Path) -> Result<UserProfileSnapshot, String> {
    let mut statement = connection
        .prepare("SELECT key,value FROM user_profile_values ORDER BY key")
        .map_err(|error| format!("无法读取个人数据：{error}"))?;
    let values = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("无法读取个人数据：{error}"))?
        .collect::<Result<BTreeMap<_, _>, _>>()
        .map_err(|error| format!("无法读取个人数据：{error}"))?;
    Ok(UserProfileSnapshot {
        context_id: context_id(connection, path),
        initialized: metadata_string(connection, INITIALIZED) == "1",
        values,
    })
}

fn validate_context(connection: &Connection, path: &Path, expected: &str) -> Result<(), String> {
    if expected.is_empty() || context_id(connection, path) != expected {
        return Err("资料库已变化，个人数据尚未保存。请返回原资料库后重试。".into());
    }
    Ok(())
}

fn validate_changes(changes: &[UserProfileChange]) -> Result<(), String> {
    if changes.len() > 4096 {
        return Err("个人数据项目过多，未保存本次修改".into());
    }
    let mut bytes = 0usize;
    for change in changes {
        let key = &change.key;
        if key.len() > 1024
            || !(key.starts_with("hub.")
                || key.starts_with("hub-")
                || key.starts_with("craft-search-"))
        {
            return Err("个人数据键无效，未保存本次修改".into());
        }
        let size = change.value.as_ref().map_or(0, String::len);
        if size > MAX_VALUE_BYTES {
            return Err("单项个人数据超过 8 MB，未保存本次修改".into());
        }
        bytes += key.len() + size;
        if bytes > MAX_BATCH_BYTES {
            return Err("本次个人数据超过 16 MB，未保存本次修改".into());
        }
    }
    Ok(())
}

fn apply_changes(
    connection: &Connection,
    changes: &[UserProfileChange],
    import: bool,
) -> Result<(), String> {
    for change in changes {
        if let Some(value) = &change.value {
            let sql = if import {
                "INSERT OR IGNORE INTO user_profile_values(key,value) VALUES (?1,?2)"
            } else {
                "INSERT INTO user_profile_values(key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
            };
            connection
                .execute(sql, params![change.key, value])
                .map_err(|error| format!("无法保存个人数据：{error}"))?;
        } else if !import {
            connection
                .execute(
                    "DELETE FROM user_profile_values WHERE key=?1",
                    [&change.key],
                )
                .map_err(|error| format!("无法移除个人数据：{error}"))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn load_user_profile(app: AppHandle) -> Result<UserProfileSnapshot, String> {
    let path = database_path(&app)?;
    tokio::task::spawn_blocking(move || {
        let (connection, _writer) = open_write_database(&path)?;
        ensure_schema(&connection)?;
        snapshot(&connection, &path)
    })
    .await
    .map_err(|error| format!("个人数据读取任务失败：{error}"))?
}

#[tauri::command]
pub(crate) async fn import_legacy_user_profile(
    app: AppHandle,
    context_id: String,
    changes: Vec<UserProfileChange>,
) -> Result<UserProfileSnapshot, String> {
    validate_changes(&changes)?;
    let path = database_path(&app)?;
    tokio::task::spawn_blocking(move || {
        let (mut connection, _writer) = open_write_database(&path)?;
        ensure_schema(&connection)?;
        validate_context(&connection, &path, &context_id)?;
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始个人数据迁移：{error}"))?;
        if metadata_string(&transaction, INITIALIZED) != "1" {
            apply_changes(&transaction, &changes, true)?;
            seal_legacy_import(&transaction)?;
        }
        transaction
            .commit()
            .map_err(|error| format!("无法完成个人数据迁移：{error}"))?;
        snapshot(&connection, &path)
    })
    .await
    .map_err(|error| format!("个人数据迁移任务失败：{error}"))?
}

#[tauri::command]
pub(crate) async fn save_user_profile_changes(
    app: AppHandle,
    context_id: String,
    changes: Vec<UserProfileChange>,
) -> Result<(), String> {
    validate_changes(&changes)?;
    let path = database_path(&app)?;
    tokio::task::spawn_blocking(move || {
        let (mut connection, _writer) = open_write_database(&path)?;
        validate_context(&connection, &path, &context_id)?;
        if metadata_string(&connection, INITIALIZED) != "1" {
            return Err("个人数据尚未加载，请重新打开应用".into());
        }
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始个人数据保存：{error}"))?;
        apply_changes(&transaction, &changes, false)?;
        transaction
            .commit()
            .map_err(|error| format!("个人数据尚未保存：{error}"))
    })
    .await
    .map_err(|error| format!("个人数据保存任务失败：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)")
            .unwrap();
        ensure_schema(&connection).unwrap();
        connection
    }
    #[test]
    fn imported_values_are_portable_and_relocation_invalidates_old_context() {
        let connection = database();
        let old = context_id(&connection, Path::new("old/profile.db"));
        apply_changes(
            &connection,
            &[UserProfileChange {
                key: "hub.favorites".into(),
                value: Some("[1]".into()),
            }],
            true,
        )
        .unwrap();
        seal_legacy_import(&connection).unwrap();
        assert_eq!(
            snapshot(&connection, Path::new("new/profile.db"))
                .unwrap()
                .values["hub.favorites"],
            "[1]"
        );
        assert!(validate_context(&connection, Path::new("new/profile.db"), &old).is_err());
    }
    #[test]
    fn failed_transaction_keeps_existing_values_and_import_preserves_target() {
        let mut connection = database();
        let change = |value: &str| UserProfileChange {
            key: "craft-search-history-v1".into(),
            value: Some(value.into()),
        };
        apply_changes(&connection, &[change("target")], false).unwrap();
        apply_changes(&connection, &[change("legacy")], true).unwrap();
        {
            let tx = connection.transaction().unwrap();
            apply_changes(&tx, &[change("uncommitted")], false).unwrap();
        }
        assert_eq!(
            snapshot(&connection, Path::new("profile.db"))
                .unwrap()
                .values["craft-search-history-v1"],
            "target"
        );
        assert!(validate_changes(&[UserProfileChange {
            key: "other-app".into(),
            value: None
        }])
        .is_err());
    }
}
