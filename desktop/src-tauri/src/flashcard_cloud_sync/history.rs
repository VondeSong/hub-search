//! Durable inventories and structural winners; one page or entity in memory.
use super::*;
use std::io::Write;

pub(super) fn schema(c: &Connection) -> Result<(), String> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS flashcard_cloud_recovery_batches(
        namespace TEXT PRIMARY KEY,batch TEXT NOT NULL UNIQUE,state TEXT NOT NULL DEFAULT 'listing',
        structure_complete INTEGER NOT NULL DEFAULT 0,context_present INTEGER NOT NULL DEFAULT 0,
        snapshot_version INTEGER NOT NULL DEFAULT 4,device_id TEXT NOT NULL DEFAULT '',exported_at INTEGER NOT NULL DEFAULT 0,
        structural_revision INTEGER NOT NULL DEFAULT -1,cache_bytes INTEGER NOT NULL DEFAULT 0,attempt TEXT NOT NULL DEFAULT '',
        compat_generation INTEGER NOT NULL DEFAULT 0,compat_len INTEGER NOT NULL DEFAULT 0,
        compat_keys_end INTEGER NOT NULL DEFAULT 0,compat_key_count INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS flashcard_cloud_recovery_control_generations(namespace TEXT PRIMARY KEY,generation INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS flashcard_cloud_recovery_buffers(id INTEGER PRIMARY KEY CHECK(id=1),body BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS flashcard_cloud_recovery_candidates(
        namespace TEXT NOT NULL,batch TEXT NOT NULL,id TEXT NOT NULL,validated INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(namespace,batch,id));
      CREATE INDEX IF NOT EXISTS flashcard_cloud_recovery_unvalidated ON flashcard_cloud_recovery_candidates(namespace,batch,validated,id);
      CREATE TABLE IF NOT EXISTS flashcard_cloud_recovery_tokens(
        namespace TEXT NOT NULL,batch TEXT NOT NULL,attempt TEXT NOT NULL,token TEXT NOT NULL,
        PRIMARY KEY(namespace,batch,attempt,token));
      CREATE TABLE IF NOT EXISTS flashcard_cloud_recovery_structures(
        namespace TEXT NOT NULL,batch TEXT NOT NULL,field TEXT NOT NULL,identity TEXT NOT NULL,
        clock_integer INTEGER NOT NULL,clock_minor INTEGER NOT NULL,clock_text TEXT NOT NULL,tie_bytes BLOB NOT NULL,payload TEXT NOT NULL,
        PRIMARY KEY(namespace,batch,field,identity));
      CREATE TABLE IF NOT EXISTS flashcard_cloud_recovery_aliases(
        namespace TEXT NOT NULL,batch TEXT NOT NULL,field TEXT NOT NULL,remote_id TEXT NOT NULL,local_id TEXT NOT NULL,
        PRIMARY KEY(namespace,batch,field,remote_id));
      CREATE TABLE IF NOT EXISTS flashcard_cloud_recovery_legacy_keys(namespace TEXT NOT NULL,batch TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(namespace,batch,id));").map_err(|e|e.to_string())?;
    for event in ["INSERT", "UPDATE", "DELETE"] {
        let prefix = if event == "DELETE" { "OLD" } else { "NEW" };
        c.execute_batch(&format!("CREATE TRIGGER IF NOT EXISTS flashcard_recovery_control_{event} AFTER {event} ON flashcard_cloud_recovery_control BEGIN
          SELECT CASE WHEN (SELECT generation FROM flashcard_cloud_recovery_control_generations WHERE namespace={prefix}.namespace)=9223372036854775807 THEN RAISE(ABORT,'Recovery generation exhausted') END;
          INSERT INTO flashcard_cloud_recovery_control_generations(namespace,generation) VALUES({prefix}.namespace,1) ON CONFLICT(namespace) DO UPDATE SET generation=generation+1; END;")).map_err(|e|e.to_string())?;
    }
    Ok(())
}

fn winner<T: Serialize>(
    c: &Connection,
    ns: &str,
    batch: &str,
    field: &str,
    id: &str,
    clock: i64,
    minor: i64,
    text: &str,
    value: &T,
) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    let payload = std::str::from_utf8(&bytes).map_err(|e| e.to_string())?;
    c.execute("INSERT INTO flashcard_cloud_recovery_structures(namespace,batch,field,identity,clock_integer,clock_minor,clock_text,tie_bytes,payload)
      VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(namespace,batch,field,identity) DO UPDATE SET
        clock_integer=excluded.clock_integer,clock_minor=excluded.clock_minor,clock_text=excluded.clock_text,tie_bytes=excluded.tie_bytes,payload=excluded.payload
      WHERE (excluded.clock_integer,excluded.clock_minor,excluded.clock_text,excluded.tie_bytes)>
            (clock_integer,clock_minor,clock_text,tie_bytes)",params![ns,batch,field,id,clock,minor,text,bytes,payload]).map(|_|()).map_err(|e|e.to_string())
}

pub(super) fn value(
    c: &Connection,
    ns: &str,
    batch: &str,
    field: &str,
    value: Value,
) -> Result<(), String> {
    macro_rules! typed {
        ($type:ty) => {
            serde_json::from_value::<$type>(value).map_err(|e| e.to_string())?
        };
    }
    match field {
        "folders" => {
            let v = typed!(FlashcardSnapshotFolder);
            winner(c, ns, batch, field, &v.id, v.updated_at, 0, "", &v)
        }
        "decks" => {
            let v = typed!(FlashcardSnapshotDeck);
            winner(c, ns, batch, field, &v.id, v.updated_at, 0, "", &v)
        }
        "tombstones" => {
            let v = typed!(FlashcardSnapshotTombstone);
            winner(
                c,
                ns,
                batch,
                field,
                &format!("{}:{}", v.entity_type, v.entity_id),
                v.deleted_at,
                0,
                "",
                &v,
            )
        }
        "schedulerProfiles" => {
            let v = typed!(flashcard_profiles::Profile);
            v.validate()?;
            winner(c, ns, batch, field, &v.id, 0, 0, &v.content_id()?, &v)
        }
        "studySettings" => {
            let v = typed!(FlashcardStudySettings);
            winner(
                c,
                ns,
                batch,
                field,
                field,
                v.updated_at,
                v.daily_new_limit,
                "",
                &v,
            )
        }
        _ => Err("恢复结构字段无效".into()),
    }
}

pub(super) fn absorb(
    c: &Connection,
    ns: &str,
    batch: &str,
    snapshot: &FlashcardSyncSnapshot,
) -> Result<(), String> {
    c.execute("UPDATE flashcard_cloud_recovery_batches SET snapshot_version=CASE WHEN context_present=0 THEN ?3 ELSE max(snapshot_version,?3) END,device_id=CASE WHEN context_present=0 THEN ?4 ELSE device_id END,exported_at=CASE WHEN context_present=0 THEN ?5 ELSE exported_at END,context_present=1 WHERE namespace=?1 AND batch=?2",params![ns,batch,snapshot.version,snapshot.device_id,snapshot.exported_at]).map_err(|e|e.to_string())?;
    macro_rules! items {
        ($field:literal,$values:expr) => {
            for v in $values {
                value(
                    c,
                    ns,
                    batch,
                    $field,
                    serde_json::to_value(v).map_err(|e| e.to_string())?,
                )?;
            }
        };
    }
    items!("folders", &snapshot.folders);
    items!("decks", &snapshot.decks);
    items!("tombstones", &snapshot.tombstones);
    items!("schedulerProfiles", &snapshot.scheduler_profiles);
    if let Some(settings) = &snapshot.study_settings {
        value(
            c,
            ns,
            batch,
            "studySettings",
            serde_json::to_value(settings).map_err(|e| e.to_string())?,
        )?;
    }
    Ok(())
}

pub(super) fn candidate(
    c: &Connection,
    ns: &str,
    batch: &str,
    id: &str,
    validated: bool,
) -> Result<bool, String> {
    c.execute("INSERT INTO flashcard_cloud_recovery_candidates(namespace,batch,id,validated) SELECT ?1,?2,?3,?4 WHERE NOT EXISTS(SELECT 1 FROM flashcard_cloud_applied WHERE namespace=?1 AND id=?3)
        ON CONFLICT(namespace,batch,id) DO UPDATE SET validated=excluded.validated WHERE excluded.validated>validated",params![ns,batch,id,validated]).map(|n|n==1).map_err(|e|e.to_string())
}

fn generation(c: &Connection, ns: &str) -> Result<i64, String> {
    c.query_row("SELECT coalesce((SELECT generation FROM flashcard_cloud_recovery_control_generations WHERE namespace=?1),0)",[ns],|r|r.get(0)).map_err(|e|e.to_string())
}

pub(super) fn begin(c: &mut Connection, ns: &str) -> Result<(String, bool), String> {
    schema(c)?;
    if let Some((batch,old_generation))=c.query_row("SELECT batch,compat_generation FROM flashcard_cloud_recovery_batches WHERE namespace=?1",[ns],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?))).optional().map_err(|e|e.to_string())? {
        if generation(c,ns)?!=old_generation {
            let tx=c.transaction().map_err(|e|e.to_string())?;
            legacy::migrate(&tx,ns,&batch)?;
            tx.execute("DELETE FROM flashcard_cloud_recovery_candidates WHERE namespace=?1 AND batch=?2 AND EXISTS(SELECT 1 FROM flashcard_cloud_applied a WHERE a.namespace=flashcard_cloud_recovery_candidates.namespace AND a.id=flashcard_cloud_recovery_candidates.id)",params![ns,batch]).map_err(|e|e.to_string())?;
            tx.execute("DELETE FROM flashcard_cloud_recovery WHERE namespace=?1 AND EXISTS(SELECT 1 FROM flashcard_cloud_applied a WHERE a.namespace=flashcard_cloud_recovery.namespace AND a.id=flashcard_cloud_recovery.id)",[ns]).map_err(|e|e.to_string())?;
            tx.execute("INSERT OR IGNORE INTO flashcard_cloud_recovery_candidates(namespace,batch,id) SELECT namespace,?2,id FROM flashcard_cloud_recovery r WHERE namespace=?1 AND NOT EXISTS(SELECT 1 FROM flashcard_cloud_applied a WHERE a.namespace=r.namespace AND a.id=r.id)",params![ns,batch]).map_err(|e|e.to_string())?;
            if next(&tx,ns,&batch,true,false)?.is_some() {tx.execute("UPDATE flashcard_cloud_recovery_batches SET state='listing',structure_complete=0,structural_revision=-1 WHERE namespace=?1 AND batch=?2",params![ns,batch]).map_err(|e|e.to_string())?;}
            tx.execute("UPDATE flashcard_cloud_recovery_batches SET cache_bytes=(SELECT coalesce(sum(length(body)),0) FROM flashcard_cloud_recovery WHERE namespace=?1),structural_revision=-1 WHERE namespace=?1 AND batch=?2",params![ns,batch]).map_err(|e|e.to_string())?;
            let ready:bool=tx.query_row("SELECT structure_complete=1 FROM flashcard_cloud_recovery_batches WHERE namespace=?1 AND batch=?2",params![ns,batch],|r|r.get(0)).map_err(|e|e.to_string())?;
            checkpoint(&tx,ns,&batch,ready)?;
            tx.commit().map_err(|e|e.to_string())?;
        }
        return Ok((batch,true));
    }
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let batch = random_url_safe(24);
    tx.execute(
        "INSERT INTO flashcard_cloud_recovery_batches(namespace,batch) VALUES(?1,?2)",
        params![ns, batch],
    )
    .map_err(|e| e.to_string())?;
    legacy::migrate(&tx, ns, &batch)?;
    tx.execute("INSERT OR IGNORE INTO flashcard_cloud_recovery_candidates(namespace,batch,id) SELECT namespace,?2,id FROM flashcard_cloud_recovery r WHERE namespace=?1 AND NOT EXISTS(SELECT 1 FROM flashcard_cloud_applied a WHERE a.namespace=r.namespace AND a.id=r.id)",params![ns,batch]).map_err(|e|e.to_string())?;
    tx.execute("DELETE FROM flashcard_cloud_recovery WHERE namespace=?1 AND EXISTS(SELECT 1 FROM flashcard_cloud_applied a WHERE a.namespace=flashcard_cloud_recovery.namespace AND a.id=flashcard_cloud_recovery.id)",[ns]).map_err(|e|e.to_string())?;
    tx.execute("UPDATE flashcard_cloud_recovery_batches SET cache_bytes=(SELECT coalesce(sum(length(body)),0) FROM flashcard_cloud_recovery WHERE namespace=?1) WHERE namespace=?1",[ns]).map_err(|e|e.to_string())?;
    checkpoint(&tx, ns, &batch, false)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok((batch, false))
}

pub(super) fn state(c: &Connection, ns: &str, batch: &str) -> Result<String, String> {
    c.query_row(
        "SELECT state FROM flashcard_cloud_recovery_batches WHERE namespace=?1 AND batch=?2",
        params![ns, batch],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

pub(super) async fn list(
    remote: &OssStore,
    database: &PathBuf,
    ns: &str,
    batch: &str,
) -> Result<(), String> {
    let attempt = random_url_safe(16);
    {
        let (c, _writer) = open_write_database(database)?;
        c.execute("UPDATE flashcard_cloud_recovery_batches SET attempt=?3 WHERE namespace=?1 AND batch=?2 AND state='listing'",params![ns,batch,attempt]).map_err(|e|e.to_string())?;
    }
    let mut token: Option<String> = None;
    loop {
        let page = remote.list_page("changes/", token.as_deref()).await?;
        let (mut c, _writer) = open_write_database(database)?;
        let tx = c.transaction().map_err(|e| e.to_string())?;
        let mut acquired = Vec::new();
        for id in page.keys {
            if candidate(&tx, ns, batch, &id, false)? {
                acquired.push(id);
            }
        }
        append_keys(&tx, ns, batch, &acquired)?;
        if let Some(next) = &page.next {
            let inserted=tx.execute("INSERT OR IGNORE INTO flashcard_cloud_recovery_tokens(namespace,batch,attempt,token) VALUES(?1,?2,?3,?4)",params![ns,batch,attempt,next]).map_err(|e|e.to_string())?;
            if inserted != 1 {
                tx.commit().map_err(|e| e.to_string())?;
                return Err("OSS 分页游标重复；恢复清单已保留".into());
            }
        } else {
            tx.execute("UPDATE flashcard_cloud_recovery_batches SET state='scanning' WHERE namespace=?1 AND batch=?2",params![ns,batch]).map_err(|e|e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        token = page.next;
        if token.is_none() {
            return Ok(());
        }
    }
}

pub(super) fn next(
    c: &Connection,
    ns: &str,
    batch: &str,
    unvalidated: bool,
    cached: bool,
) -> Result<Option<String>, String> {
    // Start the cached drain at the body-window index rather than repeatedly
    // scanning deferred candidates that have no body. Receipted candidates are
    // released in the object transaction, so ordinary drains start at the next
    // remaining identity instead of revisiting a growing committed prefix.
    let validation = if unvalidated {
        " AND r.validated=0"
    } else {
        ""
    };
    let sql = if cached {
        format!("SELECT b.id FROM flashcard_cloud_recovery b WHERE b.namespace=?1 AND EXISTS(SELECT 1 FROM flashcard_cloud_recovery_candidates r WHERE r.namespace=b.namespace AND r.id=b.id AND r.batch=?2{validation}) AND NOT EXISTS(SELECT 1 FROM flashcard_cloud_applied a WHERE a.namespace=b.namespace AND a.id=b.id) ORDER BY b.id LIMIT 1")
    } else {
        format!("SELECT r.id FROM flashcard_cloud_recovery_candidates r WHERE r.namespace=?1 AND r.batch=?2{validation} AND NOT EXISTS(SELECT 1 FROM flashcard_cloud_applied a WHERE a.namespace=r.namespace AND a.id=r.id) ORDER BY r.id LIMIT 1")
    };
    c.query_row(&sql, params![ns, batch], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())
}

pub(super) fn ready(c: &Connection, ns: &str, batch: &str) -> Result<(), String> {
    if next(c, ns, batch, true, false)?.is_some() {
        return Err("恢复清单尚未完整验证；原记录已保留".into());
    }
    c.execute("UPDATE flashcard_cloud_recovery_batches SET state='ready',structure_complete=1 WHERE namespace=?1 AND batch=?2",params![ns,batch]).map_err(|e|e.to_string())?;
    checkpoint(c, ns, batch, true)
}

struct Counter(usize);
impl Write for Counter {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0 = self
            .0
            .checked_add(b.len())
            .ok_or_else(|| std::io::Error::other("恢复结构长度溢出"))?;
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

struct Meter<'a, W: Write> {
    inner: &'a mut W,
    written: usize,
}
impl<W: Write> Write for Meter<'_, W> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let n = self.inner.write(bytes)?;
        self.written = self
            .written
            .checked_add(n)
            .ok_or_else(|| std::io::Error::other("恢复结构长度溢出"))?;
        Ok(n)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

fn envelope(
    c: &Connection,
    ns: &str,
    batch: &str,
    complete: bool,
    writer: &mut impl Write,
) -> Result<(usize, usize), String> {
    let mut measured = Meter {
        inner: writer,
        written: 0,
    };
    let w = &mut measured;
    let present:bool=c.query_row("SELECT context_present FROM flashcard_cloud_recovery_batches WHERE namespace=?1 AND batch=?2",params![ns,batch],|r|r.get(0)).map_err(|e|e.to_string())?;
    w.write_all(b"{\"format\":\"hub-flashcard-recovery-control\",\"version\":2,\"snapshot\":")
        .map_err(|e| e.to_string())?;
    if !present {
        w.write_all(b"null").map_err(|e| e.to_string())?;
    } else {
        let(version,device,exported):(i64,String,i64)=c.query_row("SELECT snapshot_version,device_id,exported_at FROM flashcard_cloud_recovery_batches WHERE namespace=?1 AND batch=?2",params![ns,batch],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|e|e.to_string())?;
        w.write_all(b"{\"version\":").map_err(|e| e.to_string())?;
        serde_json::to_writer(&mut *w, &version).map_err(|e| e.to_string())?;
        w.write_all(b",\"deviceId\":").map_err(|e| e.to_string())?;
        serde_json::to_writer(&mut *w, &device).map_err(|e| e.to_string())?;
        w.write_all(b",\"exportedAt\":")
            .map_err(|e| e.to_string())?;
        serde_json::to_writer(&mut *w, &exported).map_err(|e| e.to_string())?;
        for field in records::FIELDS {
            w.write_all(b",").map_err(|e| e.to_string())?;
            serde_json::to_writer(&mut *w, field).map_err(|e| e.to_string())?;
            w.write_all(b":[").map_err(|e| e.to_string())?;
            let mut q=c.prepare("SELECT payload FROM flashcard_cloud_recovery_structures WHERE namespace=?1 AND batch=?2 AND field=?3 ORDER BY identity").map_err(|e|e.to_string())?;
            let mut rows = q
                .query(params![ns, batch, field])
                .map_err(|e| e.to_string())?;
            let mut first = true;
            while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                let raw: String = row.get(0).map_err(|e| e.to_string())?;
                if !first {
                    w.write_all(b",").map_err(|e| e.to_string())?;
                }
                first = false;
                w.write_all(raw.as_bytes()).map_err(|e| e.to_string())?;
            }
            w.write_all(b"]").map_err(|e| e.to_string())?;
        }
        w.write_all(b",\"studySettings\":")
            .map_err(|e| e.to_string())?;
        let settings:Option<String>=c.query_row("SELECT payload FROM flashcard_cloud_recovery_structures WHERE namespace=?1 AND batch=?2 AND field='studySettings'",params![ns,batch],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        w.write_all(settings.as_deref().unwrap_or("null").as_bytes())
            .map_err(|e| e.to_string())?;
        w.write_all(b"}").map_err(|e| e.to_string())?;
    }
    w.write_all(b",\"keys\":[").map_err(|e| e.to_string())?;
    let mut q=c.prepare("SELECT id FROM flashcard_cloud_recovery_candidates WHERE namespace=?1 AND batch=?2 ORDER BY id").map_err(|e|e.to_string())?;
    let mut rows = q.query(params![ns, batch]).map_err(|e| e.to_string())?;
    let mut first = true;
    let mut key_count = 0;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let id: String = row.get(0).map_err(|e| e.to_string())?;
        if !first {
            w.write_all(b",").map_err(|e| e.to_string())?;
        }
        first = false;
        key_count += 1;
        serde_json::to_writer(&mut *w, &id).map_err(|e| e.to_string())?;
    }
    let keys_end = w.written;
    w.write_all(if complete {
        b"],\"complete\":true}"
    } else {
        b"],\"complete\":false}"
    })
    .map_err(|e| e.to_string())?;
    Ok((keys_end, key_count))
}

fn reserve(c: &Connection, ns: &str, logical: usize) -> Result<(i64, usize), String> {
    let geometric = logical
        .max(512)
        .checked_next_power_of_two()
        .unwrap_or(logical);
    let allocate = |capacity: usize| {
        c.execute("INSERT OR REPLACE INTO flashcard_cloud_recovery_control(namespace,body) VALUES(?1,zeroblob(?2))",params![ns,i64::try_from(capacity).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())
    };
    let capacity = match allocate(geometric) {
        Ok(_) => geometric,
        Err(_) if geometric != logical => {
            allocate(logical)?;
            logical
        }
        Err(error) => return Err(error),
    };
    Ok((c.last_insert_rowid(), capacity))
}

fn whitespace(w: &mut impl Write, mut remaining: usize) -> Result<(), String> {
    const PAD: [u8; 8192] = [b' '; 8192];
    while remaining > 0 {
        let n = remaining.min(PAD.len());
        w.write_all(&PAD[..n]).map_err(|e| e.to_string())?;
        remaining -= n;
    }
    Ok(())
}

pub(super) fn checkpoint(
    c: &Connection,
    ns: &str,
    batch: &str,
    complete: bool,
) -> Result<(), String> {
    let mut count = Counter(0);
    let (keys_end, key_count) = envelope(c, ns, batch, complete, &mut count)?;
    // This physical handle is used immediately by SQLite's BLOB API in this
    // transaction. It is never a persisted identity, ordering cursor or receipt.
    let (row, capacity) = reserve(c, ns, count.0)?;
    let mut blob = c
        .blob_open(
            "main",
            "flashcard_cloud_recovery_control",
            "body",
            row,
            false,
        )
        .map_err(|e| e.to_string())?;
    envelope(c, ns, batch, complete, &mut blob)?;
    whitespace(&mut blob, capacity - count.0)?;
    blob.close().map_err(|e| e.to_string())?;
    c.execute("UPDATE flashcard_cloud_recovery_batches SET compat_generation=?3,compat_len=?4,compat_keys_end=?5,compat_key_count=?6 WHERE namespace=?1 AND batch=?2",params![ns,batch,generation(c,ns)?,count.0 as i64,keys_end as i64,key_count as i64]).map(|_|()).map_err(|e|e.to_string())
}

fn append_keys(c: &Connection, ns: &str, batch: &str, keys: &[String]) -> Result<(), String> {
    use std::io::{Read, Seek, SeekFrom};
    if keys.is_empty() {
        return Ok(());
    }
    let(keys_end,old_count):(usize,usize)=c.query_row("SELECT compat_keys_end,compat_key_count FROM flashcard_cloud_recovery_batches WHERE namespace=?1 AND batch=?2",params![ns,batch],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|e|e.to_string())?;
    let mut suffix = Vec::new();
    let mut count = old_count;
    for key in keys {
        if count != 0 {
            suffix.push(b',');
        }
        serde_json::to_writer(&mut suffix, key).map_err(|e| e.to_string())?;
        count += 1;
    }
    let new_end = keys_end
        .checked_add(suffix.len())
        .ok_or("恢复清单长度溢出")?;
    suffix.extend_from_slice(b"],\"complete\":false}");
    let logical = keys_end
        .checked_add(suffix.len())
        .ok_or("恢复清单长度溢出")?;
    // This is another short-lived BLOB address, never a durable sequence.
    let row: i64 = c
        .query_row(
            "SELECT rowid FROM flashcard_cloud_recovery_control WHERE namespace=?1",
            [ns],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let capacity: usize = c
        .query_row(
            "SELECT length(body) FROM flashcard_cloud_recovery_control WHERE namespace=?1",
            [ns],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if logical <= capacity {
        let mut blob = c
            .blob_open(
                "main",
                "flashcard_cloud_recovery_control",
                "body",
                row,
                false,
            )
            .map_err(|e| e.to_string())?;
        blob.seek(SeekFrom::Start(keys_end as u64))
            .map_err(|e| e.to_string())?;
        blob.write_all(&suffix).map_err(|e| e.to_string())?;
        blob.close().map_err(|e| e.to_string())?;
        // BLOB writes do not invoke SQL triggers. Bump the small generation row
        // directly; updating the unchanged control row would copy its full BLOB.
        let next = generation(c, ns)?
            .checked_add(1)
            .ok_or("恢复清单计数已用尽")?;
        c.execute("INSERT INTO flashcard_cloud_recovery_control_generations(namespace,generation) VALUES(?1,?2) ON CONFLICT(namespace) DO UPDATE SET generation=excluded.generation",params![ns,next]).map_err(|e|e.to_string())?;
    } else {
        // Copy through an explicit-PK scratch BLOB, then replace the namespace
        // row. A SQL namespace rename would materialize the entire BLOB.
        c.execute("INSERT OR REPLACE INTO flashcard_cloud_recovery_buffers(id,body) VALUES(1,zeroblob(?1))",[keys_end as i64]).map_err(|e|e.to_string())?;
        let mut old = c
            .blob_open(
                "main",
                "flashcard_cloud_recovery_control",
                "body",
                row,
                true,
            )
            .map_err(|e| e.to_string())?;
        let mut saved = c
            .blob_open("main", "flashcard_cloud_recovery_buffers", "body", 1, false)
            .map_err(|e| e.to_string())?;
        let copied = std::io::copy(
            &mut std::io::Read::by_ref(&mut old).take(keys_end as u64),
            &mut saved,
        )
        .map_err(|e| e.to_string())?;
        if copied != keys_end as u64 {
            return Err("恢复清单追加前缀损坏；原记录已保留".into());
        }
        old.close().map_err(|e| e.to_string())?;
        saved.close().map_err(|e| e.to_string())?;
        let (new_row, new_capacity) = reserve(c, ns, logical)?;
        let mut saved = c
            .blob_open("main", "flashcard_cloud_recovery_buffers", "body", 1, true)
            .map_err(|e| e.to_string())?;
        let mut fresh = c
            .blob_open(
                "main",
                "flashcard_cloud_recovery_control",
                "body",
                new_row,
                false,
            )
            .map_err(|e| e.to_string())?;
        std::io::copy(&mut saved, &mut fresh).map_err(|e| e.to_string())?;
        fresh.write_all(&suffix).map_err(|e| e.to_string())?;
        whitespace(&mut fresh, new_capacity - logical)?;
        saved.close().map_err(|e| e.to_string())?;
        fresh.close().map_err(|e| e.to_string())?;
        c.execute(
            "DELETE FROM flashcard_cloud_recovery_buffers WHERE id=1",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    c.execute("UPDATE flashcard_cloud_recovery_batches SET compat_generation=?3,compat_len=?4,compat_keys_end=?5,compat_key_count=?6 WHERE namespace=?1 AND batch=?2",params![ns,batch,generation(c,ns)?,logical as i64,new_end as i64,count as i64]).map(|_|()).map_err(|e|e.to_string())
}

pub(super) fn complete(c: &Connection, ns: &str, batch: &str) -> Result<(), String> {
    if next(c, ns, batch, false, false)?.is_some()
        || c.query_row(
            "SELECT EXISTS(SELECT 1 FROM flashcard_cloud_recovery WHERE namespace=?1)",
            [ns],
            |r| r.get::<_, bool>(0),
        )
        .map_err(|e| e.to_string())?
    {
        return Err("恢复尚未完成；恢复清单已保留".into());
    }
    for table in [
        "flashcard_cloud_recovery_candidates",
        "flashcard_cloud_recovery_tokens",
        "flashcard_cloud_recovery_structures",
        "flashcard_cloud_recovery_aliases",
        "flashcard_cloud_recovery_legacy_keys",
        "flashcard_cloud_recovery_batches",
    ] {
        c.execute(
            &format!("DELETE FROM {table} WHERE namespace=?1 AND batch=?2"),
            params![ns, batch],
        )
        .map_err(|e| e.to_string())?;
    }
    c.execute(
        "DELETE FROM flashcard_cloud_recovery_control WHERE namespace=?1",
        [ns],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

mod legacy;
