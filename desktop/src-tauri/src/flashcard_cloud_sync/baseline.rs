//! Canonical per-entity acknowledgments and transactionally frozen upload values.
use super::{records, Connection, FlashcardSyncSnapshot, OptionalExtension, Value};
use crate::{now_timestamp, random_url_safe, FLASHCARD_SYNC_MAX_SNAPSHOT_BYTES};
use rusqlite::params;
use sha2::{Digest, Sha256};
use std::io::{self, Write};

fn atomic<T>(
    c: &Connection,
    name: &str,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    c.execute_batch(&format!("SAVEPOINT {name}"))
        .map_err(|e| e.to_string())?;
    match operation() {
        Ok(value) => {
            c.execute_batch(&format!("RELEASE {name}"))
                .map_err(|e| e.to_string())?;
            Ok(value)
        }
        Err(error) => {
            c.execute_batch(&format!("ROLLBACK TO {name}; RELEASE {name}"))
                .map_err(|e| format!("{error}; 无法回退同步状态：{e}"))?;
            Err(error)
        }
    }
}

fn install_record_triggers(c: &Connection, field: &str, table: &str) -> Result<(), String> {
    for (event, prefix) in [("INSERT", "NEW"), ("UPDATE", "NEW"), ("DELETE", "OLD")] {
        let key = if field == "tombstones" {
            format!("json_quote({prefix}.entity_type)||':'||json_quote({prefix}.entity_id)")
        } else {
            format!("json_quote({prefix}.id)")
        };
        let old = if field == "tombstones" {
            "json_quote(OLD.entity_type)||':'||json_quote(OLD.entity_id)".to_string()
        } else {
            "json_quote(OLD.id)".to_string()
        };
        let old_update = if event == "UPDATE" {
            format!("INSERT INTO flashcard_cloud_entity_revisions(field,identity,revision) VALUES('{field}',{old},(SELECT revision FROM flashcard_cloud_revision_state WHERE id=1)) ON CONFLICT(field,identity) DO UPDATE SET revision=excluded.revision;")
        } else {
            String::new()
        };
        c.execute_batch(&format!("CREATE TRIGGER IF NOT EXISTS flashcard_resource_{field}_{event} AFTER {event} ON {table}
          BEGIN SELECT CASE WHEN (SELECT revision FROM flashcard_cloud_revision_state WHERE id=1)=9223372036854775807 THEN RAISE(ABORT,'Flashcard revision exhausted') END;
            UPDATE flashcard_cloud_revision_state SET revision=revision+1 WHERE id=1;
            INSERT INTO flashcard_cloud_entity_revisions(field,identity,revision) VALUES('{field}',{key},(SELECT revision FROM flashcard_cloud_revision_state WHERE id=1)) ON CONFLICT(field,identity) DO UPDATE SET revision=excluded.revision;
            {old_update} END;")).map_err(|e|e.to_string())?;
    }
    Ok(())
}

/// Only the domain migration that actually recreated these tables may call this.
/// Its surrounding transaction owns the rebuilt rows and this tracking repair.
pub(crate) fn rebuilt_review_tables(
    c: &Connection,
    reviews: bool,
    profiles: bool,
) -> Result<(), String> {
    let installed:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM metadata WHERE key='flashcard_cloud_resource_revision_v1' AND value='1')",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    if !installed {
        return Ok(());
    }
    atomic(c, "flashcard_resource_rebuild", || {
        for (field, table, rebuilt) in [
            ("reviews", "flashcard_review_events", reviews),
            (
                "schedulerProfiles",
                "flashcard_scheduler_profiles",
                profiles,
            ),
        ] {
            if rebuilt {
                install_record_triggers(c, field, table)?;
            }
        }
        // A missing protection on any intact table is still an error.
        ensure_tracking(c)?;
        if !reviews && !profiles {
            return Ok(());
        }
        let before: i64 = c
            .query_row(
                "SELECT revision FROM flashcard_cloud_revision_state WHERE id=1",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let next = before
            .checked_add(1)
            .ok_or("同步逐记录计数已用尽；原记录已保留")?;
        c.execute(
            "UPDATE flashcard_cloud_revision_state SET revision=?1 WHERE id=1",
            [next],
        )
        .map_err(|e| e.to_string())?;
        for (field, table, rebuilt) in [
            ("reviews", "flashcard_review_events", reviews),
            (
                "schedulerProfiles",
                "flashcard_scheduler_profiles",
                profiles,
            ),
        ] {
            if !rebuilt {
                continue;
            }
            // Include identities that disappeared while the old table was absent.
            c.execute(
                "UPDATE flashcard_cloud_entity_revisions SET revision=?2 WHERE field=?1",
                params![field, next],
            )
            .map_err(|e| e.to_string())?;
            c.execute(&format!("INSERT INTO flashcard_cloud_entity_revisions(field,identity,revision) SELECT ?1,json_quote(id),?2 FROM {table} WHERE true ON CONFLICT(field,identity) DO UPDATE SET revision=excluded.revision"),params![field,next]).map_err(|e|e.to_string())?;
        }
        Ok(())
    })
}

pub(crate) fn ensure_tracking(c: &Connection) -> Result<(), String> {
    atomic(c, "flashcard_resource_install", || {
        c.execute_batch("CREATE TABLE IF NOT EXISTS flashcard_cloud_revision_state(
            id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL CHECK(revision>=0));
          CREATE TABLE IF NOT EXISTS flashcard_cloud_entity_revisions(
            field TEXT NOT NULL,identity TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(field,identity));
          CREATE INDEX IF NOT EXISTS flashcard_cloud_changed_entities ON flashcard_cloud_entity_revisions(field,revision,identity);
          CREATE TABLE IF NOT EXISTS flashcard_cloud_resource_baselines(
            namespace TEXT PRIMARY KEY,version INTEGER NOT NULL,cutoff INTEGER NOT NULL,initialized INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS flashcard_cloud_resource_records(
            namespace TEXT NOT NULL,field TEXT NOT NULL,identity TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(namespace,field,identity));
          CREATE TABLE IF NOT EXISTS flashcard_cloud_frozen_uploads(
            namespace TEXT NOT NULL,id TEXT NOT NULL,cutoff INTEGER NOT NULL,version INTEGER NOT NULL,full INTEGER NOT NULL,PRIMARY KEY(namespace,id));
          CREATE TABLE IF NOT EXISTS flashcard_cloud_frozen_records(
            namespace TEXT NOT NULL,upload_id TEXT NOT NULL,field TEXT NOT NULL,identity TEXT NOT NULL,payload TEXT NOT NULL,
            PRIMARY KEY(namespace,upload_id,field,identity));").map_err(|e|e.to_string())?;
        let installed:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM metadata WHERE key='flashcard_cloud_resource_revision_v1' AND value='1')",[],|r|r.get(0)).map_err(|e|e.to_string())?;
        if installed {
            let count:i64=c.query_row("SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name GLOB 'flashcard_resource_*'",[],|r|r.get(0)).map_err(|e|e.to_string())?;
            let state: Option<i64> = c
                .query_row(
                    "SELECT revision FROM flashcard_cloud_revision_state WHERE id=1",
                    [],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if count != 27 || state.is_none_or(|n| n < 0) {
                return Err("同步逐记录追踪保护损坏；原记录已保留".into());
            }
            return Ok(());
        }
        c.execute(
            "INSERT OR IGNORE INTO flashcard_cloud_revision_state(id,revision) VALUES(1,0)",
            [],
        )
        .map_err(|e| e.to_string())?;
        for (field, table) in records::TABLES {
            let identity = if field == "tombstones" {
                "json_quote(entity_type)||':'||json_quote(entity_id)".into()
            } else {
                "json_quote(id)".to_string()
            };
            c.execute(&format!("INSERT OR IGNORE INTO flashcard_cloud_entity_revisions(field,identity,revision) SELECT ?1,{identity},0 FROM {table}"),[field]).map_err(|e|e.to_string())?;
            install_record_triggers(c, field, table)?;
        }
        c.execute("INSERT OR IGNORE INTO flashcard_cloud_entity_revisions(field,identity,revision) VALUES('studySettings','studySettings',0)",[]).map_err(|e|e.to_string())?;
        for (event, prefix) in [("INSERT", "NEW"), ("UPDATE", "NEW"), ("DELETE", "OLD")] {
            let condition = if event == "UPDATE" {
                "NEW.key IN ('flashcard_daily_new_limit','flashcard_daily_new_limit_updated_at') OR OLD.key IN ('flashcard_daily_new_limit','flashcard_daily_new_limit_updated_at')".to_string()
            } else {
                format!("{prefix}.key IN ('flashcard_daily_new_limit','flashcard_daily_new_limit_updated_at')")
            };
            c.execute_batch(&format!("CREATE TRIGGER IF NOT EXISTS flashcard_resource_study_{event} AFTER {event} ON metadata WHEN {condition}
              BEGIN SELECT CASE WHEN (SELECT revision FROM flashcard_cloud_revision_state WHERE id=1)=9223372036854775807 THEN RAISE(ABORT,'Flashcard revision exhausted') END;
                UPDATE flashcard_cloud_revision_state SET revision=revision+1 WHERE id=1;
                INSERT INTO flashcard_cloud_entity_revisions(field,identity,revision) VALUES('studySettings','studySettings',(SELECT revision FROM flashcard_cloud_revision_state WHERE id=1)) ON CONFLICT(field,identity) DO UPDATE SET revision=excluded.revision;
              END;")).map_err(|e|e.to_string())?;
        }
        c.execute("INSERT INTO metadata(key,value) VALUES('flashcard_cloud_resource_revision_v1','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value",[]).map_err(|e|e.to_string())?;
        Ok(())
    })
}

#[cfg(test)]
fn source_query(upload: Option<&str>) -> &'static str {
    if upload.is_some() {
        "SELECT baseline FROM flashcard_cloud_uploads WHERE namespace=?1 AND id=?2"
    } else {
        "SELECT payload FROM flashcard_cloud_baselines WHERE namespace=?1 AND (?2 IS NULL)"
    }
}

fn import_legacy(c: &Connection, ns: &str, upload: Option<&str>) -> Result<i64, String> {
    atomic(c, "flashcard_baseline_reader", || {
        legacy::import(c, ns, upload)
    })
}

// Retained as the released SQL parser's differential reference in tests only.
#[cfg(test)]
fn import_legacy_reference(c: &Connection, ns: &str, upload: Option<&str>) -> Result<i64, String> {
    let source = source_query(upload);
    // SQLite may retain the large TEXT in its JSON parser during this one-time
    // migration; no full baseline String or Value crosses into Rust.
    let header=format!("SELECT json_valid(payload),json_type(payload,'$.version'),json_extract(payload,'$.version'),json_type(payload,'$.deviceId'),json_type(payload,'$.exportedAt') FROM (SELECT ({source}) AS payload)");
    let (valid, version_type, version, device_type, exported_type): (
        bool,
        Option<String>,
        Option<i64>,
        Option<String>,
        Option<String>,
    ) = c
        .query_row(&header, params![ns, upload], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })
        .map_err(|_| "本机同步基线损坏，原记录已保留".to_string())?;
    if !valid
        || version_type.as_deref() != Some("integer")
        || device_type.as_deref() != Some("text")
        || exported_type.as_deref() != Some("integer")
    {
        return Err("本机同步基线损坏，原记录已保留".into());
    }
    c.execute(
        "DELETE FROM flashcard_cloud_resource_records WHERE namespace=?1",
        [ns],
    )
    .map_err(|e| e.to_string())?;
    for field in records::FIELDS {
        let path = format!("$.{field}");
        let kind: Option<String> = c
            .query_row(
                &format!("SELECT json_type(({source}),?3)"),
                params![ns, upload, path],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if kind.as_deref() != Some("array")
            && !(kind.is_none() && !matches!(field, "decks" | "cards" | "reviews"))
        {
            return Err("本机同步基线字段损坏，原记录已保留".into());
        }
        let mut query = c
            .prepare(&format!("SELECT CASE type WHEN 'object' THEN value WHEN 'array' THEN value WHEN 'null' THEN 'null' WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' ELSE json_quote(value) END FROM json_each(({source}),?3)"))
            .map_err(|e| e.to_string())?;
        let mut rows = query
            .query(params![ns, upload, path])
            .map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let raw: String = row.get(0).map_err(|e| e.to_string())?;
            let value = records::normalize(
                field,
                serde_json::from_str(&raw).map_err(|e| e.to_string())?,
            )?;
            acknowledge(
                c,
                ns,
                field,
                &records::identity(field, &value),
                &value.to_string(),
            )?;
        }
    }
    let settings: Option<String> = c
        .query_row(
            &format!("SELECT json_extract(({source}),'$.studySettings')"),
            params![ns, upload],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let settings = records::normalize(
        "studySettings",
        settings
            .map(|v| serde_json::from_str(&v))
            .transpose()
            .map_err(|e| e.to_string())?
            .unwrap_or(Value::Null),
    )?;
    acknowledge(
        c,
        ns,
        "studySettings",
        "studySettings",
        &settings.to_string(),
    )?;
    Ok(version.ok_or("本机同步基线版本损坏")?)
}

mod legacy;
#[cfg(test)]
#[path = "baseline/legacy_tests.rs"]
mod legacy_tests;

pub(super) fn namespace(c: &Connection, ns: &str) -> Result<(), String> {
    ensure_tracking(c)?;
    atomic(c, "flashcard_baseline_migration", || {
        let exists:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM flashcard_cloud_resource_baselines WHERE namespace=?1)",[ns],|r|r.get(0)).map_err(|e|e.to_string())?;
        if exists {
            return Ok(());
        }
        let legacy: bool = c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM flashcard_cloud_baselines WHERE namespace=?1)",
                [ns],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let version = if legacy {
            import_legacy(c, ns, None)?
        } else {
            4
        };
        c.execute("INSERT INTO flashcard_cloud_resource_baselines(namespace,version,cutoff,initialized) VALUES(?1,?2,-1,?3)",params![ns,version,legacy]).map_err(|e|e.to_string())?;
        Ok(())
    })
}

fn acknowledge(
    c: &Connection,
    ns: &str,
    field: &str,
    identity: &str,
    payload: &str,
) -> Result<(), String> {
    c.execute("INSERT INTO flashcard_cloud_resource_records(namespace,field,identity,payload) VALUES(?1,?2,?3,?4) ON CONFLICT(namespace,field,identity) DO UPDATE SET payload=excluded.payload",params![ns,field,identity,payload]).map_err(|e|e.to_string())?;
    Ok(())
}

struct BoundedWriter(Vec<u8>);
impl Write for BoundedWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) > FLASHCARD_SYNC_MAX_SNAPSHOT_BYTES {
            return Err(io::Error::other("同步变更超过 32 MB 上限"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn raw(w: &mut BoundedWriter, bytes: &[u8]) -> Result<(), String> {
    w.write_all(bytes).map_err(|e| e.to_string())
}
fn json(w: &mut BoundedWriter, value: &impl serde::Serialize) -> Result<(), String> {
    serde_json::to_writer(w, value).map_err(|e| e.to_string())
}

fn render(
    c: &Connection,
    ns: &str,
    token: &str,
    cutoff: i64,
    full: bool,
) -> Result<(Vec<u8>, bool), String> {
    let (version,confirmed,initialized):(i64,i64,bool)=c.query_row("SELECT version,cutoff,initialized FROM flashcard_cloud_resource_baselines WHERE namespace=?1",[ns],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|e|e.to_string())?;
    let wire_version = records::wire_version(c)?;
    let mut changed = version != wire_version || !initialized;
    let mut wire = BoundedWriter(Vec::new());
    raw(
        &mut wire,
        b"{\"format\":\"hub-flashcard-changes\",\"version\":4,\"checkpoint\":",
    )?;
    json(&mut wire, &full)?;
    raw(&mut wire, b",\"snapshot\":{\"version\":")?;
    json(&mut wire, &wire_version)?;
    raw(&mut wire, b",\"deviceId\":")?;
    json(
        &mut wire,
        &crate::flashcard_snapshot::flashcard_sync_device_id(c)?,
    )?;
    raw(&mut wire, b",\"exportedAt\":")?;
    json(&mut wire, &now_timestamp())?;
    for field in records::FIELDS {
        raw(&mut wire, b",")?;
        json(&mut wire, &field)?;
        raw(&mut wire, b":[")?;
        let mut first = true;
        let mut emit = |value: Value| -> Result<(), String> {
            let identity = records::identity(field, &value);
            let payload = value.to_string();
            let old:Option<String>=c.query_row("SELECT payload FROM flashcard_cloud_resource_records WHERE namespace=?1 AND field=?2 AND identity=?3",params![ns,field,identity],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
            let differs = old.as_deref() != Some(payload.as_str());
            changed |= differs;
            if full || differs {
                if !first {
                    raw(&mut wire, b",")?;
                }
                first = false;
                json(&mut wire, &value)?;
                c.execute("INSERT INTO flashcard_cloud_frozen_records(namespace,upload_id,field,identity,payload) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(namespace,upload_id,field,identity) DO UPDATE SET payload=excluded.payload",params![ns,token,field,identity,payload]).map_err(|e|e.to_string())?;
            }
            Ok(())
        };
        if full {
            records::visit(c, field, &mut emit)?;
        } else {
            let mut query=c.prepare("SELECT identity FROM flashcard_cloud_entity_revisions WHERE field=?1 AND revision>?2 AND revision<=?3 ORDER BY identity").map_err(|e|e.to_string())?;
            let mut rows = query
                .query(params![field, confirmed, cutoff])
                .map_err(|e| e.to_string())?;
            while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                let key: String = row.get(0).map_err(|e| e.to_string())?;
                if let Some(value) = records::local(c, field, &key)? {
                    emit(value)?;
                }
            }
        }
        raw(&mut wire, b"]")?;
    }
    let study_dirty:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM flashcard_cloud_entity_revisions WHERE field='studySettings' AND revision>?1 AND revision<=?2)",params![confirmed,cutoff],|r|r.get(0)).map_err(|e|e.to_string())?;
    let mut settings = Value::Null;
    if full || study_dirty {
        let current = serde_json::to_value(records::study(c)).map_err(|e| e.to_string())?;
        let payload = current.to_string();
        let old:Option<String>=c.query_row("SELECT payload FROM flashcard_cloud_resource_records WHERE namespace=?1 AND field='studySettings' AND identity='studySettings'",[ns],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        let differs = old.as_deref() != Some(payload.as_str());
        changed |= differs;
        if full || differs {
            settings = current;
            c.execute("INSERT INTO flashcard_cloud_frozen_records(namespace,upload_id,field,identity,payload) VALUES(?1,?2,'studySettings','studySettings',?3)",params![ns,token,payload]).map_err(|e|e.to_string())?;
        }
    }
    raw(&mut wire, b",\"studySettings\":")?;
    json(&mut wire, &settings)?;
    raw(&mut wire, b"}}")?;
    Ok((wire.0, changed))
}

pub(super) fn stage(c: &Connection, ns: &str, force: bool) -> Result<(), String> {
    namespace(c, ns)?;
    atomic(c, "flashcard_resource_stage", || {
        c.execute("UPDATE flashcard_cloud_uploads SET body=X'',baseline='' WHERE namespace=?1 AND status='complete' AND (length(body)>0 OR length(baseline)>0)",[ns]).map_err(|e|e.to_string())?;
        let pending:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM flashcard_cloud_uploads WHERE namespace=?1 AND status='pending')",[ns],|r|r.get(0)).map_err(|e|e.to_string())?;
        if pending {
            return Ok(());
        }
        let cutoff: i64 = c
            .query_row(
                "SELECT revision FROM flashcard_cloud_revision_state WHERE id=1",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let count:i64=c.query_row("SELECT count(*) FROM flashcard_cloud_uploads WHERE namespace=?1 AND status='complete'",[ns],|r|r.get(0)).map_err(|e|e.to_string())?;
        let initialized: bool = c
            .query_row(
                "SELECT initialized FROM flashcard_cloud_resource_baselines WHERE namespace=?1",
                [ns],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let full = force || !initialized || (count > 0 && count % 50 == 0);
        let token = format!("stage-{}", random_url_safe(16));
        let (mut body, changed) = render(c, ns, &token, cutoff, false)?;
        if !force && !changed {
            c.execute(
                "UPDATE flashcard_cloud_resource_baselines SET cutoff=?2 WHERE namespace=?1",
                params![ns, cutoff],
            )
            .map_err(|e| e.to_string())?;
            return Ok(());
        }
        if full {
            c.execute(
                "DELETE FROM flashcard_cloud_frozen_records WHERE namespace=?1 AND upload_id=?2",
                params![ns, token],
            )
            .map_err(|e| e.to_string())?;
            body = render(c, ns, &token, cutoff, true)?.0;
        }
        let id = format!(
            "{}-{:x}.json",
            crate::flashcard_snapshot::flashcard_sync_device_id(c)?,
            Sha256::digest(&body)
        );
        // Keep both old columns valid for the released desktop reader. The full
        // compatibility baseline is copied in SQLite, never allocated in Rust.
        c.execute("INSERT OR IGNORE INTO flashcard_cloud_baselines(namespace,payload) SELECT ?1,json_extract(CAST(?2 AS TEXT),'$.snapshot')",params![ns,body]).map_err(|e|e.to_string())?;
        c.execute("INSERT OR IGNORE INTO flashcard_cloud_uploads(namespace,id,body,baseline,status) SELECT ?1,?2,?3,payload,'pending' FROM flashcard_cloud_baselines WHERE namespace=?1",params![ns,id,body]).map_err(|e|e.to_string())?;
        c.execute("UPDATE flashcard_cloud_frozen_records SET upload_id=?3 WHERE namespace=?1 AND upload_id=?2",params![ns,token,id]).map_err(|e|e.to_string())?;
        c.execute("INSERT INTO flashcard_cloud_frozen_uploads(namespace,id,cutoff,version,full) VALUES(?1,?2,?3,?4,?5)",params![ns,id,cutoff,records::wire_version(c)?,full]).map_err(|e|e.to_string())?;
        Ok(())
    })
}

pub(super) fn confirm(c: &Connection, ns: &str, id: &str) -> Result<(), String> {
    namespace(c, ns)?;
    let frozen:Option<(i64,i64,bool)>=c.query_row("SELECT cutoff,version,full FROM flashcard_cloud_frozen_uploads WHERE namespace=?1 AND id=?2",params![ns,id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|e|e.to_string())?;
    if let Some((cutoff, version, full)) = frozen {
        if full {
            c.execute(
                "DELETE FROM flashcard_cloud_resource_records WHERE namespace=?1",
                [ns],
            )
            .map_err(|e| e.to_string())?;
        }
        c.execute("INSERT INTO flashcard_cloud_resource_records(namespace,field,identity,payload) SELECT namespace,field,identity,payload FROM flashcard_cloud_frozen_records WHERE namespace=?1 AND upload_id=?2 ON CONFLICT(namespace,field,identity) DO UPDATE SET payload=excluded.payload",params![ns,id]).map_err(|e|e.to_string())?;
        c.execute("UPDATE flashcard_cloud_resource_baselines SET cutoff=max(cutoff,?2),version=?3,initialized=1 WHERE namespace=?1",params![ns,cutoff,version]).map_err(|e|e.to_string())?;
        c.execute(
            "DELETE FROM flashcard_cloud_frozen_records WHERE namespace=?1 AND upload_id=?2",
            params![ns, id],
        )
        .map_err(|e| e.to_string())?;
        c.execute(
            "DELETE FROM flashcard_cloud_frozen_uploads WHERE namespace=?1 AND id=?2",
            params![ns, id],
        )
        .map_err(|e| e.to_string())?;
    } else {
        let version = import_legacy(c, ns, Some(id))?;
        c.execute("UPDATE flashcard_cloud_resource_baselines SET cutoff=-1,version=?2,initialized=1 WHERE namespace=?1",params![ns,version]).map_err(|e|e.to_string())?;
    }
    Ok(())
}

pub(super) fn reconcile(
    c: &Connection,
    ns: &str,
    key: impl Fn(&str) -> String,
) -> Result<(), String> {
    namespace(c, ns)?;
    loop {
        let id:Option<String>=c.query_row("SELECT u.id FROM flashcard_cloud_uploads u JOIN flashcard_cloud_frozen_uploads f ON f.namespace=u.namespace AND f.id=u.id WHERE u.namespace=?1 AND u.status='complete' ORDER BY u.local_seq LIMIT 1",[ns],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        let Some(id) = id else {
            break;
        };
        let received: bool = c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM flashcard_cloud_applied WHERE namespace=?1 AND id=?2)",
                params![ns, key(&id)],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !received {
            return Err("已完成同步对象缺少正式确认，冻结记录已保留".into());
        }
        atomic(c, "flashcard_old_reader_confirm", || confirm(c, ns, &id))?;
    }
    Ok(())
}

pub(super) fn absorb_record(
    c: &Connection,
    ns: &str,
    field: &str,
    value: Value,
) -> Result<(), String> {
    if field == "qualityRecords" && value.get("id").and_then(Value::as_str).is_none() {
        // The old wire permits arbitrary quality JSON. Its domain merge ignores
        // unidentified entries, so acknowledgment must not turn them into errors.
        return Ok(());
    }
    let identity = if field == "studySettings" {
        "studySettings".into()
    } else {
        records::identity(field, &value)
    };
    if records::local(c, field, &identity)?.as_ref() == Some(&value) {
        acknowledge(c, ns, field, &identity, &value.to_string())?;
    }
    Ok(())
}

pub(super) fn absorb(
    c: &Connection,
    ns: &str,
    remote: &FlashcardSyncSnapshot,
) -> Result<(), String> {
    namespace(c, ns)?;
    let initialized: bool = c
        .query_row(
            "SELECT initialized FROM flashcard_cloud_resource_baselines WHERE namespace=?1",
            [ns],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !initialized {
        return Ok(());
    }
    macro_rules! records {
        ($field:literal,$items:expr) => {
            for item in $items {
                absorb_record(
                    c,
                    ns,
                    $field,
                    serde_json::to_value(item).map_err(|e| e.to_string())?,
                )?;
            }
        };
    }
    records!("folders", &remote.folders);
    records!("decks", &remote.decks);
    records!("cards", &remote.cards);
    records!("tombstones", &remote.tombstones);
    records!("reviews", &remote.reviews);
    records!("drafts", &remote.drafts);
    records!("qualityRecords", &remote.quality_records);
    records!("schedulerProfiles", &remote.scheduler_profiles);
    if let Some(settings) = &remote.study_settings {
        absorb_record(
            c,
            ns,
            "studySettings",
            serde_json::to_value(settings).map_err(|e| e.to_string())?,
        )?;
    }
    Ok(())
}

struct CountWriter(usize);
impl Write for CountWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0 = self
            .0
            .checked_add(bytes.len())
            .ok_or_else(|| io::Error::other("baseline size overflow"))?;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn write_database_snapshot(
    source: &Connection,
    header: &FlashcardSyncSnapshot,
    mut writer: impl Write,
) -> Result<(), String> {
    writer
        .write_all(b"{\"version\":")
        .map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut writer, &header.version).map_err(|e| e.to_string())?;
    writer
        .write_all(b",\"deviceId\":")
        .map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut writer, &header.device_id).map_err(|e| e.to_string())?;
    writer
        .write_all(b",\"exportedAt\":")
        .map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut writer, &header.exported_at).map_err(|e| e.to_string())?;
    for field in records::FIELDS {
        writer.write_all(b",").map_err(|e| e.to_string())?;
        serde_json::to_writer(&mut writer, field).map_err(|e| e.to_string())?;
        writer.write_all(b":[").map_err(|e| e.to_string())?;
        let mut first = true;
        records::visit(source, field, &mut |value| {
            if !first {
                writer.write_all(b",").map_err(|e| e.to_string())?;
            }
            first = false;
            serde_json::to_writer(&mut writer, &value).map_err(|e| e.to_string())
        })?;
        writer.write_all(b"]").map_err(|e| e.to_string())?;
    }
    writer
        .write_all(b",\"studySettings\":")
        .map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut writer, &records::study(source)).map_err(|e| e.to_string())?;
    writer.write_all(b"}").map_err(|e| e.to_string())
}

/// Accept a frozen maintenance scratch database without allocating its snapshot.
/// Source reads share one savepoint; target legacy TEXT, acknowledgments and any
/// caller-owned applied-key INSERT are all covered by the caller's transaction.
pub(super) fn accept_database(c: &Connection, ns: &str, source: &Connection) -> Result<(), String> {
    atomic(c, "flashcard_accept_database", || {
        atomic(source, "flashcard_accept_source", || {
            let exists: bool = c
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM flashcard_cloud_baselines WHERE namespace=?1)",
                    [ns],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            if !exists {
                let header = records::empty(source)?;
                let mut length = CountWriter(0);
                write_database_snapshot(source, &header, &mut length)?;
                let length = i32::try_from(length.0).map_err(|_| "本机基线超过 SQLite 单值容量")?;
                c.execute_batch("CREATE TABLE IF NOT EXISTS flashcard_cloud_baseline_scratch(namespace TEXT PRIMARY KEY,payload BLOB NOT NULL)").map_err(|e|e.to_string())?;
                c.execute(
                    "INSERT INTO flashcard_cloud_baseline_scratch(namespace,payload) VALUES(?1,?2)",
                    params![ns, rusqlite::blob::ZeroBlob(length)],
                )
                .map_err(|e| e.to_string())?;
                // This physical row handle exists only for the immediate SQLite BLOB
                // write. Namespace is the persistent key and survives VACUUM.
                let handle = c.last_insert_rowid();
                let mut blob = c
                    .blob_open(
                        "main",
                        "flashcard_cloud_baseline_scratch",
                        "payload",
                        handle,
                        false,
                    )
                    .map_err(|e| e.to_string())?;
                write_database_snapshot(source, &header, &mut blob)?;
                drop(blob);
                c.execute("INSERT INTO flashcard_cloud_baselines(namespace,payload) SELECT namespace,CAST(payload AS TEXT) FROM flashcard_cloud_baseline_scratch WHERE namespace=?1",[ns]).map_err(|e|e.to_string())?;
                c.execute(
                    "DELETE FROM flashcard_cloud_baseline_scratch WHERE namespace=?1",
                    [ns],
                )
                .map_err(|e| e.to_string())?;
            }
            namespace(c, ns)?;
            let initialized: bool = c
                .query_row(
                    "SELECT initialized FROM flashcard_cloud_resource_baselines WHERE namespace=?1",
                    [ns],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            if initialized {
                for field in records::FIELDS {
                    records::visit(source, field, &mut |value| {
                        absorb_record(c, ns, field, value)
                    })?;
                }
                if let Some(settings) = records::study(source) {
                    absorb_record(
                        c,
                        ns,
                        "studySettings",
                        serde_json::to_value(settings).map_err(|e| e.to_string())?,
                    )?;
                }
            }
            Ok(())
        })
    })
}

#[cfg(test)]
pub(super) fn snapshot_for_test(c: &Connection, ns: &str) -> Result<FlashcardSyncSnapshot, String> {
    let mut snapshot = serde_json::to_value(records::empty(c)?).map_err(|e| e.to_string())?;
    for field in records::FIELDS {
        let mut query=c.prepare("SELECT payload FROM flashcard_cloud_resource_records WHERE namespace=?1 AND field=?2 ORDER BY identity").map_err(|e|e.to_string())?;
        let rows = query
            .query_map(params![ns, field], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let values = rows
            .map(|row| {
                serde_json::from_str::<Value>(&row.map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        snapshot[field] = Value::Array(values);
    }
    let settings:Option<String>=c.query_row("SELECT payload FROM flashcard_cloud_resource_records WHERE namespace=?1 AND field='studySettings' AND identity='studySettings'",[ns],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    snapshot["studySettings"] = settings
        .map(|v| serde_json::from_str(&v))
        .transpose()
        .map_err(|e| e.to_string())?
        .unwrap_or(Value::Null);
    snapshot["version"] = Value::from(
        c.query_row(
            "SELECT version FROM flashcard_cloud_resource_baselines WHERE namespace=?1",
            [ns],
            |r| r.get::<_, i64>(0),
        )
        .map_err(|e| e.to_string())?,
    );
    serde_json::from_value(snapshot).map_err(|e| e.to_string())
}

#[cfg(test)]
mod hierarchy_tests {
    use super::*;
    use std::path::PathBuf;
    #[test]
    fn formal_cloud_upload_and_ack_preserve_hierarchy_marker_without_repeated_full_uploads() {
        let mut c = crate::database::initialize_database(&PathBuf::from(":memory:")).unwrap();
        super::super::ensure_journal(&c).unwrap();
        let root =
            crate::flashcard_decks::create_flashcard_deck_in_connection(&mut c, "Parent").unwrap();
        let child = crate::flashcard_decks::create_subdeck(&mut c, "Child", &root).unwrap();
        stage(&c, "hierarchy-test", false).unwrap();
        let (id,body):(String,Vec<u8>)=c.query_row("SELECT id,body FROM flashcard_cloud_uploads WHERE namespace='hierarchy-test' AND status='pending'",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        let change = super::super::recovery::decode(&id, &body).unwrap();
        assert_eq!(change.snapshot.version, 5);
        assert_eq!(
            change
                .snapshot
                .decks
                .iter()
                .find(|d| d.id == child)
                .unwrap()
                .parent_deck_id,
            root
        );
        confirm(&c, "hierarchy-test", &id).unwrap();
        c.execute("UPDATE flashcard_cloud_uploads SET status='complete' WHERE namespace='hierarchy-test' AND id=?1",[id]).unwrap();
        stage(&c, "hierarchy-test", false).unwrap();
        assert_eq!(c.query_row("SELECT COUNT(*) FROM flashcard_cloud_uploads WHERE namespace='hierarchy-test' AND status='pending'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        assert_eq!(snapshot_for_test(&c, "hierarchy-test").unwrap().version, 5);
        let destination = crate::database::initialize_database(&PathBuf::from(":memory:")).unwrap();
        super::super::ensure_journal(&destination).unwrap();
        accept_database(&destination, "hierarchy-maintenance", &c).unwrap();
        assert_eq!(
            snapshot_for_test(&destination, "hierarchy-maintenance")
                .unwrap()
                .decks
                .iter()
                .find(|d| d.id == child)
                .unwrap()
                .parent_deck_id,
            root
        );
    }
}
