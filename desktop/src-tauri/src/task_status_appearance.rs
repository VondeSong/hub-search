//! Display preference only: task completion variants share the current accent.
use rusqlite::{params, Connection};

const KEY: &str = "task_status_style";

pub(super) fn read(connection: &Connection) -> String {
    let style = connection
        .query_row("SELECT value FROM metadata WHERE key=?1", [KEY], |row| {
            row.get::<_, String>(0)
        })
        .ok();
    if style.as_deref() == Some("outline") {
        "outline"
    } else {
        "filled"
    }
    .into()
}

pub(super) fn save(connection: &Connection, style: Option<&str>) -> Result<(), String> {
    let Some(style) = style else {
        return Ok(());
    };
    if !matches!(style, "filled" | "outline") {
        return Err("任务状态样式无效".into());
    }
    connection.execute("INSERT INTO metadata(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![KEY,style])
        .map(|_| ()).map_err(|error| format!("无法保存任务状态样式：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn appearance_defaults_persists_and_preserves_older_clients() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT)", [])
            .unwrap();
        assert_eq!(read(&connection), "filled");
        save(&connection, Some("outline")).unwrap();
        assert_eq!(read(&connection), "outline");
        save(&connection, None).unwrap();
        assert_eq!(read(&connection), "outline");
        assert!(save(&connection, Some("unknown")).is_err());
        assert_eq!(read(&connection), "outline");
        save(&connection, Some("filled")).unwrap();
        assert_eq!(read(&connection), "filled");
    }
}
