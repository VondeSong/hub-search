//! The reading view follows committed changes to its local projections.
use super::{dida_reading, jobs, local_sources, properties, storage, RUNNING};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::Ordering;

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct Version {
    rows: String,
    properties: i64,
}

struct Stamp {
    version: Version,
    property_key: String,
    property_since: i64,
    auxiliary: i64,
}

fn track(c: &Connection, table: &str, columns: &[&str], auxiliary: bool) -> rusqlite::Result<()> {
    let changed = columns
        .iter()
        .map(|field| format!("OLD.{field} IS NOT NEW.{field}"))
        .collect::<Vec<_>>()
        .join(" OR ");
    let fields = columns.join(",");
    let change = if auxiliary {
        "rows=rows+1, auxiliary=auxiliary+1"
    } else {
        "rows=rows+1"
    };
    for (suffix, action) in [
        ("insert", "INSERT".into()),
        ("delete", "DELETE".into()),
        ("update", format!("UPDATE OF {fields}")),
    ] {
        let condition = if suffix == "update" {
            format!("WHEN {changed}")
        } else {
            String::new()
        };
        c.execute_batch(&format!(
            "CREATE TRIGGER IF NOT EXISTS reading_view_{table}_{suffix} AFTER {action} ON {table}
             {condition} BEGIN UPDATE reading_view_revision SET {change} WHERE id=1; END;"
        ))?;
    }
    Ok(())
}

pub(crate) fn install(c: &Connection) -> Result<(), String> {
    (|| -> rusqlite::Result<()> {
        let tx = c.unchecked_transaction()?;
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS reading_view_revision (
               id INTEGER PRIMARY KEY CHECK(id=1), epoch TEXT NOT NULL,
               rows INTEGER NOT NULL DEFAULT 0, properties INTEGER NOT NULL DEFAULT 0,
               property_key TEXT NOT NULL DEFAULT '', property_since INTEGER NOT NULL DEFAULT 0,
               auxiliary INTEGER NOT NULL DEFAULT 0
             );
             INSERT OR IGNORE INTO reading_view_revision(id,epoch) VALUES(1,lower(hex(randomblob(12))));",
        )?;
        for (table, fields, auxiliary) in [
            ("collection_x_items", &["item_key", "post_json", "content_hash", "collected_at"][..], false),
            ("collection_lifecycle", &["item_key", "state", "destination", "destination_name"], true),
            ("collection_roots", &["destination", "root"], true),
            ("collection_library_destinations", &["item_key", "target", "state", "selected"], true),
            ("collection_library_jobs", &["item_key", "action", "target", "phase", "error", "plan", "detail", "updated_at"], true),
            ("collection_library_pending", &["item_key", "action", "target", "phase", "error", "plan", "detail", "updated_at"], true),
            ("collection_remote_copies", &["item_key", "library_id", "parent_id", "verified"], false),
            ("collection_obsidian_exports", &["destination", "item_key", "media_pending"], false),
            ("collection_saved_media", &["item_key", "media_url", "path"], false),
            ("collection_x_outbox", &["item_key", "error"], false),
            ("collection_x_enrichment", &["item_key", "error"], false),
            ("libraries", &["id", "name", "provider", "enabled", "location"], true),
            ("reading_cloud_items", &["item_key"], false),
            ("reading_media_manifests", &["namespace", "item_key", "post_hash", "url", "body"], false),
            ("reading_media_evicted", &["hash"], false),
        ] {
            track(&tx, table, fields, auxiliary)?;
        }
        // A status save can update both tables. Consecutive changes to the
        // same item share a span, so the reader can still patch a single row.
        for (name, action, condition, key) in [
            ("properties_insert", "INSERT ON collection_x_properties", "", "NEW.item_key"),
            ("properties_delete", "DELETE ON collection_x_properties", "", "OLD.item_key"),
            ("properties_update", "UPDATE OF item_key,status,tags ON collection_x_properties", "WHEN OLD.item_key IS NOT NEW.item_key OR OLD.status IS NOT NEW.status OR OLD.tags IS NOT NEW.tags", "CASE WHEN OLD.item_key IS NEW.item_key THEN NEW.item_key ELSE '' END"),
            ("read_flag", "UPDATE OF read_at ON collection_x_items", "WHEN (OLD.read_at>0) IS NOT (NEW.read_at>0)", "NEW.item_key"),
        ] {
            tx.execute_batch(&format!(
                "CREATE TRIGGER IF NOT EXISTS reading_view_{name} AFTER {action} {condition} BEGIN
                 UPDATE reading_view_revision SET properties=properties+1,
                   property_since=CASE WHEN property_key=({key}) THEN property_since ELSE properties END,
                   property_key=({key}) WHERE id=1; END;"
            ))?;
        }
        for (event, row, guard) in [("INSERT", "NEW", ""), ("DELETE", "OLD", ""), ("UPDATE", "NEW", "AND OLD.value IS NOT NEW.value")] {
            tx.execute_batch(&format!(
                "CREATE TRIGGER IF NOT EXISTS reading_view_metadata_{event} AFTER {event} ON metadata
                 WHEN ({row}.key GLOB 'collection_*' OR {row}.key GLOB 'x_bookmarks_*'
                   OR {row}.key GLOB 'x_likes_*' OR {row}.key GLOB 'dida_reading_*'
                   OR {row}.key IN ('reading_media_policy','reading_source_cleanup')) {guard}
                 BEGIN UPDATE reading_view_revision SET auxiliary=auxiliary+1,
                   rows=rows+({row}.key IN ('collection_storage_v1','reading_media_policy')) WHERE id=1; END;"
            ))?;
        }
        tx.commit()
    })()
    .map_err(|error| format!("无法初始化阅读数据版本：{error}"))
}

fn stamp(c: &Connection) -> Result<Stamp, String> {
    c.query_row("SELECT epoch||':'||rows,properties,property_key,property_since,auxiliary FROM reading_view_revision WHERE id=1", [], |r| {
        Ok(Stamp {
            version: Version { rows: r.get(0)?, properties: r.get(1)? },
            property_key: r.get(2)?, property_since: r.get(3)?, auxiliary: r.get(4)?,
        })
    }).map_err(|error| format!("无法读取阅读数据版本：{error}"))
}

pub(super) fn version(c: &Connection) -> Result<Version, String> {
    Ok(stamp(c)?.version)
}

fn property_change(
    c: &Connection,
    stamp: &Stamp,
    known: Option<&Version>,
) -> Result<Option<Value>, String> {
    let Some(known) = known else {
        return Ok(None);
    };
    if known.rows != stamp.version.rows
        || known.properties >= stamp.version.properties
        || known.properties < stamp.property_since
        || stamp.property_key.is_empty()
    {
        return Ok(None);
    }
    let read: Option<bool> = c
        .query_row(
            "SELECT read_at>0 FROM collection_x_items WHERE item_key=?1",
            [&stamp.property_key],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(read) = read else {
        return Ok(None);
    };
    let (status, tags) = properties::load(c, &stamp.property_key, read)?;
    Ok(Some(
        json!({"key":stamp.property_key,"status":status,"tags":tags,"read":read}),
    ))
}

pub(super) fn changes(c: &Connection, known: Option<&Version>) -> Result<Value, String> {
    let stamp = stamp(c)?;
    let property = property_change(c, &stamp, known)?;
    Ok(
        json!({"version":stamp.version,"auxiliary":stamp.auxiliary,"property":property,
        "activity":{
          "sync":RUNNING.load(Ordering::Relaxed),"export":storage::exporting(),"job":jobs::snapshot(),
          "telegram":crate::telegram::running(),"dida":dida_reading::running(),
          "local":local_sources::running(),"tdl":crate::telegram::tdl::activity()
        }}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE libraries(id TEXT PRIMARY KEY,name TEXT,provider TEXT,enabled INTEGER,location TEXT);")
            .unwrap();
        storage::schema(&c).unwrap();
        install(&c).unwrap();
        c.execute_batch("INSERT INTO collection_x_items (item_key,account,post_json,content_hash,collected_at,captured_at)
            VALUES ('a','account','{}','a',1,1),('b','account','{}','b',2,2);")
            .unwrap();
        c
    }

    #[test]
    fn committed_status_writes_can_patch_one_item_but_two_items_need_a_page() {
        let c = database();
        let known = version(&c).unwrap();
        c.execute_batch(
            "BEGIN;
            INSERT INTO collection_x_properties VALUES ('a','read','[]');
            UPDATE collection_x_items SET read_at=1 WHERE item_key='a';
            COMMIT;",
        )
        .unwrap();
        assert_eq!(
            changes(&c, Some(&known)).unwrap()["property"],
            json!({
                "key":"a","status":"read","tags":[],"read":true
            })
        );
        assert!(changes(&c, Some(&version(&c).unwrap())).unwrap()["property"].is_null());
        c.execute_batch("INSERT INTO collection_x_properties VALUES ('b','in_progress','[]');")
            .unwrap();
        assert!(changes(&c, Some(&known)).unwrap()["property"].is_null());
        c.execute_batch("UPDATE collection_x_items SET post_json='new body' WHERE item_key='a';")
            .unwrap();
        assert!(version(&c).unwrap().rows != known.rows);
    }

    #[test]
    fn rolled_back_and_unrelated_writes_leave_the_view_current() {
        let c = database();
        let before = stamp(&c).unwrap();
        c.execute_batch(
            "BEGIN;
            UPDATE collection_x_items SET collected_at=42 WHERE item_key='a';
            UPDATE collection_x_items SET read_at=10 WHERE item_key='a';
            ROLLBACK;
            INSERT INTO metadata VALUES('unrelated','changed');
            UPDATE collection_x_items SET collected_at=collected_at WHERE item_key='a';",
        )
        .unwrap();
        assert!(version(&c).unwrap() == before.version);
        assert_eq!(stamp(&c).unwrap().auxiliary, before.auxiliary);
        c.execute_batch("INSERT INTO metadata VALUES('collection_export_status','complete');")
            .unwrap();
        let after = stamp(&c).unwrap();
        assert!(after.version == before.version);
        assert!(after.auxiliary > before.auxiliary);
    }
}
