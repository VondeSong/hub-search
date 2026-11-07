//! Committed input dirtiness and per-namespace staging cursors. The wire record
//! and immutable pending upload body stay owned by reading_sync.
use rusqlite::{params, Connection};

pub(crate) fn install(c: &Connection) -> Result<(), String> {
    let installed: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM metadata WHERE key='reading_incremental_v1' AND value='1')",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    if installed {
        let count:i64=c.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND (name GLOB 'reading_input_*' OR name GLOB 'reading_output_*')",[],|r|r.get(0)).map_err(|e|e.to_string())?;
        let revision: i64 = c
            .query_row(
                "SELECT revision FROM reading_revision_state WHERE id=1",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if count != 12 || revision < 0 {
            return Err("阅读变更跟踪结构损坏，原内容已保留".into());
        }
        return Ok(());
    }
    c.execute_batch("SAVEPOINT reading_incremental_install")
        .map_err(|e| e.to_string())?;
    let result = (|| {
        c.execute_batch("CREATE TABLE reading_input_dirty(item_key TEXT PRIMARY KEY);
          CREATE TABLE reading_revision_state(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL CHECK(revision>=0));
          INSERT INTO reading_revision_state VALUES(1,0);
          CREATE TABLE reading_record_revisions(item_key TEXT PRIMARY KEY,revision INTEGER NOT NULL CHECK(revision>=0));
          CREATE INDEX reading_record_changed_keys ON reading_record_revisions(revision,item_key);
          CREATE TABLE reading_stage_cursors(namespace TEXT PRIMARY KEY,revision INTEGER NOT NULL CHECK(revision>=0));
          INSERT INTO reading_input_dirty SELECT item_key FROM collection_x_items UNION SELECT item_key FROM collection_lifecycle WHERE state IN ('deleted','deleting') UNION SELECT item_key FROM reading_sync_records;
          INSERT INTO reading_record_revisions SELECT item_key,0 FROM reading_sync_records;").map_err(|e|e.to_string())?;
        for (table,fields,changed) in [
            ("collection_x_items","item_key,post_json,collected_at,read_at","OLD.item_key IS NOT NEW.item_key OR OLD.post_json IS NOT NEW.post_json OR OLD.collected_at IS NOT NEW.collected_at OR OLD.read_at IS NOT NEW.read_at"),
            ("collection_x_properties","item_key,status,tags","OLD.item_key IS NOT NEW.item_key OR OLD.status IS NOT NEW.status OR OLD.tags IS NOT NEW.tags"),
            ("collection_lifecycle","item_key,state","OLD.item_key IS NOT NEW.item_key OR OLD.state IS NOT NEW.state"),
        ] {
            c.execute_batch(&format!("CREATE TRIGGER reading_input_{table}_insert AFTER INSERT ON {table} BEGIN INSERT INTO reading_input_dirty(item_key) SELECT NEW.item_key WHERE NOT EXISTS(SELECT 1 FROM reading_input_dirty WHERE item_key=NEW.item_key); END;
              CREATE TRIGGER reading_input_{table}_delete AFTER DELETE ON {table} BEGIN INSERT INTO reading_input_dirty(item_key) SELECT OLD.item_key WHERE NOT EXISTS(SELECT 1 FROM reading_input_dirty WHERE item_key=OLD.item_key); END;
              CREATE TRIGGER reading_input_{table}_update AFTER UPDATE OF {fields} ON {table} WHEN {changed} BEGIN INSERT INTO reading_input_dirty(item_key) SELECT OLD.item_key WHERE NOT EXISTS(SELECT 1 FROM reading_input_dirty WHERE item_key=OLD.item_key); INSERT INTO reading_input_dirty(item_key) SELECT NEW.item_key WHERE NOT EXISTS(SELECT 1 FROM reading_input_dirty WHERE item_key=NEW.item_key); END;")).map_err(|e|e.to_string())?;
        }
        for (event, prefix, when) in [
            ("INSERT", "NEW", ""),
            ("DELETE", "OLD", ""),
            (
                "UPDATE",
                "NEW",
                "WHEN OLD.body IS NOT NEW.body OR OLD.item_key IS NOT NEW.item_key",
            ),
        ] {
            let old = if event == "UPDATE" {
                "INSERT INTO reading_input_dirty(item_key) SELECT OLD.item_key WHERE NOT EXISTS(SELECT 1 FROM reading_input_dirty WHERE item_key=OLD.item_key); INSERT INTO reading_record_revisions VALUES(OLD.item_key,(SELECT revision FROM reading_revision_state WHERE id=1)) ON CONFLICT(item_key) DO UPDATE SET revision=excluded.revision;"
            } else {
                ""
            };
            c.execute_batch(&format!("CREATE TRIGGER reading_output_{event} AFTER {event} ON reading_sync_records {when} BEGIN
              SELECT CASE WHEN (SELECT revision FROM reading_revision_state WHERE id=1)=9223372036854775807 THEN RAISE(ABORT,'reading revision exhausted') END;
              UPDATE reading_revision_state SET revision=revision+1 WHERE id=1;
              INSERT INTO reading_input_dirty(item_key) SELECT {prefix}.item_key WHERE NOT EXISTS(SELECT 1 FROM reading_input_dirty WHERE item_key={prefix}.item_key);
              INSERT INTO reading_record_revisions VALUES({prefix}.item_key,(SELECT revision FROM reading_revision_state WHERE id=1)) ON CONFLICT(item_key) DO UPDATE SET revision=excluded.revision;
              {old} END;")).map_err(|e|e.to_string())?;
        }
        c.execute(
            "INSERT INTO metadata(key,value) VALUES('reading_incremental_v1','1')",
            [],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })();
    match result {
        Ok(()) => c
            .execute_batch("RELEASE reading_incremental_install")
            .map_err(|e| e.to_string()),
        Err(e) => {
            c.execute_batch(
                "ROLLBACK TO reading_incremental_install; RELEASE reading_incremental_install",
            )
            .map_err(|e| e.to_string())?;
            Err(e)
        }
    }
}

pub(super) fn capture_dirty(c: &Connection, device: &str) -> Result<(), String> {
    let mut after = String::new();
    loop {
        let key: Option<String> = c
            .query_row(
                "SELECT MIN(item_key) FROM reading_input_dirty WHERE item_key>?1",
                [&after],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let Some(key) = key else { break };
        super::capture_one(c, device, &key)?;
        c.execute("DELETE FROM reading_input_dirty WHERE item_key=?1", [&key])
            .map_err(|e| e.to_string())?;
        after = key;
    }
    Ok(())
}

pub(super) fn visit_changes(
    c: &Connection,
    namespace: &str,
    mut visit: impl FnMut(super::Record) -> Result<(), String>,
) -> Result<(), String> {
    use rusqlite::OptionalExtension;
    let revision: i64 = c
        .query_row(
            "SELECT revision FROM reading_revision_state WHERE id=1",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let cursor: Option<i64> = c
        .query_row(
            "SELECT revision FROM reading_stage_cursors WHERE namespace=?1",
            [namespace],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if cursor.is_some_and(|v| v > revision || v < 0) {
        return Err("阅读同步游标损坏，待上传内容已保留".into());
    }
    let sql = if cursor.is_some() {
        "SELECT r.body FROM reading_record_revisions v JOIN reading_sync_records r ON r.item_key=v.item_key WHERE v.revision>?1 AND v.revision<=?2 ORDER BY v.revision,v.item_key"
    } else {
        "SELECT r.body FROM reading_record_revisions v JOIN reading_sync_records r ON r.item_key=v.item_key WHERE ?1 IS NULL AND v.revision<=?2 ORDER BY v.revision,v.item_key"
    };
    let mut q = c.prepare(sql).map_err(|e| e.to_string())?;
    let rows = q
        .query_map(params![cursor, revision], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let raw = row.map_err(|e| e.to_string())?;
        visit(serde_json::from_str(&raw).map_err(|e| format!("阅读同步记录损坏：{e}"))?)?;
    }
    drop(q);
    c.execute("INSERT INTO reading_stage_cursors VALUES(?1,?2) ON CONFLICT(namespace) DO UPDATE SET revision=excluded.revision",params![namespace,revision]).map_err(|e|e.to_string())?;
    Ok(())
}
