use super::*;

// These are task-owned synthetic databases. Failed fixtures are retained so a
// rollback assertion can be inspected without touching an installed Hub root.
struct Fixture {
    root: PathBuf,
}
impl Fixture {
    fn new(label: &str) -> Self {
        let base = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("task-state/project-optimization-20261011/database-maintenance-tests");
        fs::create_dir_all(&base).unwrap();
        let mut nonce = [0u8; 8];
        rand::thread_rng().fill_bytes(&mut nonce);
        let root = base.join(format!("{label}-{:x}", u64::from_le_bytes(nonce)));
        fs::create_dir(&root).unwrap();
        Self {
            root: fs::canonicalize(root).unwrap(),
        }
    }
    fn path(&self) -> PathBuf {
        self.root.join(DATABASE)
    }
    fn legacy(&self) -> Connection {
        let c = Connection::open(self.path()).unwrap();
        c.execute_batch("PRAGMA foreign_keys=ON;
            CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE owners(id TEXT PRIMARY KEY);
            INSERT INTO owners VALUES('kept');
            CREATE TABLE business_changes(id INTEGER PRIMARY KEY,kind TEXT NOT NULL);
            CREATE TABLE collection_saved_media(item_key TEXT NOT NULL REFERENCES owners(id),media_url TEXT NOT NULL,path TEXT NOT NULL,PRIMARY KEY(item_key,media_url));
            CREATE TRIGGER business_media_insert AFTER INSERT ON collection_saved_media BEGIN INSERT INTO business_changes(kind) VALUES('insert'); END;
            CREATE TRIGGER business_media_path AFTER UPDATE OF path ON collection_saved_media BEGIN INSERT INTO business_changes(kind) VALUES('path'); END;
            INSERT INTO collection_saved_media(rowid,item_key,media_url,path) VALUES(3,'kept','original','original.png'),(17,'kept','preview','preview.png');
            CREATE TABLE padding(id INTEGER PRIMARY KEY,payload BLOB NOT NULL);
            INSERT INTO padding(payload) VALUES(zeroblob(1048576)); DELETE FROM padding;
            PRAGMA user_version=68; PRAGMA application_id=713;").unwrap();
        c
    }
    fn request(&self) -> Status {
        request(&self.root).unwrap()
    }
}
fn cancelled() -> Arc<AtomicBool> {
    Arc::new(AtomicBool::new(false))
}
fn sequence(c: &Connection, url: &str) -> i64 {
    c.query_row(
        "SELECT local_seq FROM collection_saved_media WHERE media_url=?1",
        [url],
        |r| r.get(0),
    )
    .unwrap()
}

#[test]
fn local_sequence_standalone_owner_creates_metadata_and_retains_high_water() {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch("CREATE TABLE collection_saved_media(item_key TEXT NOT NULL,media_url TEXT NOT NULL,path TEXT NOT NULL,PRIMARY KEY(item_key,media_url)); INSERT INTO collection_saved_media(rowid,item_key,media_url,path) VALUES(27,'kept','original','original.png');").unwrap();
    ensure_sequences(&c, &["collection_saved_media"]).unwrap();
    let columns: Vec<(String, String, i64, i64)> = {
        let mut q = c
            .prepare(
                "SELECT name,type,\"notnull\",pk FROM pragma_table_info('metadata') ORDER BY cid",
            )
            .unwrap();
        q.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    assert_eq!(
        columns,
        vec![
            ("key".into(), "TEXT".into(), 0, 1),
            ("value".into(), "TEXT".into(), 1, 0)
        ]
    );
    assert_eq!(sequence(&c, "original"), 27);
    c.execute("DELETE FROM collection_saved_media", []).unwrap();
    ensure_sequences(&c, &["collection_saved_media"]).unwrap();
    c.execute("INSERT INTO collection_saved_media(item_key,media_url,path) VALUES('kept','next','next.png')", []).unwrap();
    assert_eq!(sequence(&c, "next"), 28);
}

#[test]
fn local_sequence_standalone_metadata_rolls_back_on_error_and_owner_rollback() {
    let mut c = Connection::open_in_memory().unwrap();
    c.execute_batch("CREATE TABLE collection_saved_media(item_key TEXT NOT NULL,media_url TEXT NOT NULL,path TEXT NOT NULL,PRIMARY KEY(item_key,media_url));").unwrap();
    let absent = |c: &Connection| {
        assert!(!c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='metadata')",
                [],
                |r| r.get::<_, bool>(0)
            )
            .unwrap());
        assert!(!c.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('collection_saved_media') WHERE name='local_seq')", [], |r| r.get::<_, bool>(0)).unwrap());
        assert_eq!(
            c.query_row(
                "SELECT count(*) FROM sqlite_master WHERE name GLOB 'hub_local_seq_*'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    };
    assert!(ensure_sequences(&c, &["collection_saved_media", "unapproved_table"]).is_err());
    absent(&c);
    {
        let tx = c.transaction().unwrap();
        ensure_sequences(&tx, &["collection_saved_media"]).unwrap();
        tx.rollback().unwrap();
    }
    absent(&c);
    c.execute_batch("ALTER TABLE collection_saved_media ADD COLUMN local_seq TEXT")
        .unwrap();
    assert!(ensure_sequences(&c, &["collection_saved_media"]).is_err());
    assert!(!c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='metadata')",
            [],
            |r| r.get::<_, bool>(0)
        )
        .unwrap());
    assert_eq!(
        c.query_row(
            "SELECT type FROM pragma_table_info('collection_saved_media') WHERE name='local_seq'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "TEXT"
    );
}

#[test]
fn local_sequences_preserve_primary_foreign_keys_and_business_triggers() {
    let f = Fixture::new("constraints");
    let c = f.legacy();
    ensure_sequences(&c, &["collection_saved_media"]).unwrap();
    assert_eq!((sequence(&c, "original"), sequence(&c, "preview")), (3, 17));
    assert!(c.execute("INSERT INTO collection_saved_media(item_key,media_url,path) VALUES('missing','bad','bad')",[]).is_err());
    assert!(c.execute("INSERT INTO collection_saved_media(item_key,media_url,path) VALUES('kept','original','duplicate')",[]).is_err());
    c.execute("INSERT INTO collection_saved_media(item_key,media_url,path) VALUES('kept','later','later.png')",[]).unwrap();
    assert_eq!(sequence(&c, "later"), 18);
    c.execute(
        "UPDATE collection_saved_media SET path='new.png' WHERE media_url='original'",
        [],
    )
    .unwrap();
    assert_eq!(sequence(&c, "original"), 3);
    let changes: (i64,i64) = c.query_row("SELECT count(*) FILTER(WHERE kind='insert'),count(*) FILTER(WHERE kind='path') FROM business_changes",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
    assert_eq!(changes, (3, 1));
    integrity(&c).unwrap();
}

#[test]
fn local_sequence_high_water_survives_delete_vacuum_reopen_and_rollback() {
    let f = Fixture::new("high-water");
    let mut c = f.legacy();
    ensure_sequences(&c, &["collection_saved_media"]).unwrap();
    c.execute(
        "DELETE FROM collection_saved_media WHERE media_url='preview'",
        [],
    )
    .unwrap();
    {
        let tx = c.transaction().unwrap();
        tx.execute("INSERT INTO collection_saved_media(item_key,media_url,path) VALUES('kept','rolled-back','x')",[]).unwrap();
        assert_eq!(sequence(&tx, "rolled-back"), 18);
        tx.rollback().unwrap();
    }
    c.execute_batch("VACUUM").unwrap();
    drop(c);
    let c = Connection::open(f.path()).unwrap();
    ensure_sequences(&c, &["collection_saved_media"]).unwrap();
    c.execute("INSERT INTO collection_saved_media(item_key,media_url,path) VALUES('kept','after-reopen','x')",[]).unwrap();
    assert_eq!(sequence(&c, "after-reopen"), 18);
    assert_eq!(sequence(&c, "original"), 3);
    assert!(c
        .execute(
            "UPDATE collection_saved_media SET local_seq=4 WHERE media_url='original'",
            []
        )
        .is_err());
    assert!(c
        .execute(
            "UPDATE collection_saved_media SET local_seq=NULL WHERE media_url='original'",
            []
        )
        .is_err());
    assert!(c.execute("INSERT INTO collection_saved_media(item_key,media_url,path,local_seq) VALUES('kept','explicit','x',17)",[]).is_err());
}

#[test]
fn local_sequence_upsert_is_stable_and_exhaustion_fails_without_insertion() {
    let f = Fixture::new("upsert");
    let c = f.legacy();
    ensure_sequences(&c, &["collection_saved_media"]).unwrap();
    let replacement = f.root.join("replacement.png");
    fs::write(&replacement, b"replacement original bytes").unwrap();
    crate::x_bookmarks::storage::record_saved_media(&c, "kept", "original", &replacement).unwrap();
    assert_eq!(sequence(&c, "original"), 3);
    assert_eq!(
        c.query_row(
            "SELECT value FROM metadata WHERE key='local_sequence:collection_saved_media'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "17"
    );
    c.execute("UPDATE metadata SET value='9223372036854775807' WHERE key='local_sequence:collection_saved_media'",[]).unwrap();
    assert!(c.execute("INSERT INTO collection_saved_media(item_key,media_url,path) VALUES('kept','overflow','x')",[]).is_err());
    assert_eq!(
        c.query_row("SELECT count(*) FROM collection_saved_media", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
}

#[test]
fn local_sequence_installation_is_atomic_inside_owner_transaction() {
    let f = Fixture::new("savepoint");
    let mut c = f.legacy();
    let tx = c.transaction().unwrap();
    tx.execute("UPDATE owners SET id=id", []).unwrap();
    assert!(ensure_sequences(&tx, &["collection_saved_media", "unapproved_table"]).is_err());
    assert!(!tx.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('collection_saved_media') WHERE name='local_seq')",[],|r|r.get::<_,bool>(0)).unwrap());
    tx.execute(
        "INSERT INTO metadata VALUES('owner-transaction','kept')",
        [],
    )
    .unwrap();
    tx.commit().unwrap();
    assert_eq!(
        c.query_row(
            "SELECT value FROM metadata WHERE key='owner-transaction'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "kept"
    );
}

#[test]
fn local_sequence_installed_marker_does_not_hide_corrupt_protection() {
    for corruption in [
        "DROP TRIGGER hub_local_seq_collection_saved_media_assigned",
        "DROP INDEX hub_local_seq_collection_saved_media",
        "DELETE FROM metadata WHERE key='local_sequence:collection_saved_media'",
        "UPDATE metadata SET value='not-a-sequence' WHERE key='local_sequence:collection_saved_media'",
    ] {
        let f = Fixture::new("corrupt-marker"); let c = f.legacy();
        ensure_sequences(&c,&["collection_saved_media"]).unwrap();
        c.execute_batch(corruption).unwrap();
        assert!(ensure_sequences(&c,&["collection_saved_media"]).is_err(),"{corruption}");
    }
}

#[test]
fn local_sequence_all_registered_cursor_tables_survive_physical_rowid_renumbering() {
    let f = Fixture::new("all-sequences");
    let c = Connection::open(f.path()).unwrap();
    c.execute_batch("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)")
        .unwrap();
    for table in SEQUENCE_TABLES {
        c.execute_batch(&format!("CREATE TABLE {}(business_key TEXT NOT NULL PRIMARY KEY,payload BLOB NOT NULL); INSERT INTO {}(rowid,business_key,payload) VALUES(4,'old',x'0102'),(27,'latest',x'0304')",quoted(table),quoted(table))).unwrap();
    }
    ensure_sequences(&c, SEQUENCE_TABLES).unwrap();
    // An indexed table may retain rowids through VACUUM. Force relocation so
    // this test proves the published identity does not depend on that detail.
    for table in SEQUENCE_TABLES {
        c.execute(
            &format!("UPDATE {} SET rowid=rowid+100000", quoted(table)),
            [],
        )
        .unwrap();
    }
    c.execute_batch("VACUUM").unwrap();
    for table in SEQUENCE_TABLES {
        let values: (i64, i64) = c
            .query_row(
                &format!(
                    "SELECT local_seq,rowid FROM {} WHERE business_key='latest'",
                    quoted(table)
                ),
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(values.0, 27, "{table}");
        assert_ne!(
            values.1, 27,
            "fixture must actually renumber the hidden rowid for {table}"
        );
        c.execute(
            &format!("DELETE FROM {} WHERE business_key='latest'", quoted(table)),
            [],
        )
        .unwrap();
        c.execute(
            &format!(
                "INSERT INTO {}(business_key,payload) VALUES('new',x'05')",
                quoted(table)
            ),
            [],
        )
        .unwrap();
        let next: i64 = c
            .query_row(
                &format!(
                    "SELECT local_seq FROM {} WHERE business_key='new'",
                    quoted(table)
                ),
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(next, 28, "{table}");
    }
}

#[cfg(windows)]
#[test]
fn local_database_preview_is_read_only_and_pending_request_can_be_cancelled() {
    let f = Fixture::new("preview");
    drop(f.legacy());
    let before = hash_path(&f.path()).unwrap();
    let info = preview(&f.root).unwrap();
    assert!(info.free_pages > 0 && info.reclaimable_bytes > 0);
    assert_eq!(
        info.required_free_bytes,
        info.database_bytes * 3 + 16 * 1024 * 1024
    );
    let pending = f.request();
    assert_eq!(pending.phase, "requested");
    assert!(request(&f.root).is_err());
    assert_eq!(cancel_request(&f.root).unwrap().phase, "cancelled");
    assert_eq!(
        process_with(&f.root, cancelled(), Some(u64::MAX), |_, _| Ok(()))
            .unwrap()
            .unwrap()
            .phase,
        "cancelled"
    );
    assert_eq!(hash_path(&f.path()).unwrap(), before);
    assert!(!Path::new(&pending.backup_path).exists());
}

#[cfg(windows)]
#[test]
fn local_database_compaction_preserves_formal_media_consumers_and_rollback_copy() {
    let f = Fixture::new("formal-media");
    let c = crate::open_database(&f.path()).unwrap();
    crate::x_bookmarks::storage::schema(&c).unwrap();
    // Actual saved-media producer and URL consumer, including the thumbnail URL.
    let png=base64::Engine::decode(&base64::engine::general_purpose::STANDARD,"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE+0AAAAASUVORK5CYII=").unwrap();
    let original = f.root.join("original.png");
    let thumbnail = f.root.join("thumbnail.png");
    fs::write(&original, &png).unwrap();
    fs::write(&thumbnail, &png).unwrap();
    crate::x_bookmarks::storage::record_saved_media(
        &c,
        "synthetic",
        "https://example.invalid/original",
        &original,
    )
    .unwrap();
    crate::x_bookmarks::storage::record_saved_media(
        &c,
        "synthetic",
        "https://example.invalid/thumbnail",
        &thumbnail,
    )
    .unwrap();
    let original_id = sequence(&c, "https://example.invalid/original");
    let thumbnail_id = sequence(&c, "https://example.invalid/thumbnail");
    c.execute_batch("CREATE TABLE task_padding(id INTEGER PRIMARY KEY,payload BLOB); INSERT INTO task_padding(payload) VALUES(zeroblob(1048576)); DELETE FROM task_padding").unwrap();
    let expected = digest(&c, &AtomicBool::new(false)).unwrap();
    drop(c);
    f.request();
    let result = process_with(&f.root, cancelled(), Some(u64::MAX), |_, _| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(result.phase, "complete", "{}", result.error);
    assert!(result.after_bytes < result.before_bytes);
    let reopened = crate::open_database(&f.path()).unwrap();
    assert_eq!(
        digest(&reopened, &AtomicBool::new(false)).unwrap(),
        expected
    );
    assert_eq!(
        crate::x_bookmarks::storage::recorded_media_path(&reopened, original_id).unwrap(),
        original
    );
    assert_eq!(
        crate::x_bookmarks::storage::recorded_media_path(&reopened, thumbnail_id).unwrap(),
        thumbnail
    );
    assert_eq!(
        fs::read(
            crate::x_bookmarks::storage::recorded_media_path(&reopened, thumbnail_id).unwrap()
        )
        .unwrap(),
        png
    );
    assert!(Path::new(&result.original_path).is_file() && Path::new(&result.backup_path).is_file());
    assert_eq!(
        result.source_sha256,
        hash_path(Path::new(&result.original_path)).unwrap()
    );
}

#[cfg(windows)]
#[test]
fn local_database_compaction_migrates_legacy_media_without_losing_schema_or_rows() {
    let f = Fixture::new("legacy-compaction");
    let c = f.legacy();
    let old = digest(&c, &AtomicBool::new(false)).unwrap();
    drop(c);
    f.request();
    let result = process_with(&f.root, cancelled(), Some(u64::MAX), |_, _| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(result.phase, "complete", "{}", result.error);
    let backup = readonly(Path::new(&result.backup_path)).unwrap();
    assert_eq!(digest(&backup, &AtomicBool::new(false)).unwrap(), old);
    let c = Connection::open(f.path()).unwrap();
    c.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    ensure_sequences(&c, &["collection_saved_media"]).unwrap();
    assert_eq!((sequence(&c, "original"), sequence(&c, "preview")), (3, 17));
    assert_eq!(
        c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        68
    );
    assert_eq!(
        c.query_row("PRAGMA application_id", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        713
    );
    c.execute(
        "INSERT INTO collection_saved_media(item_key,media_url,path) VALUES('kept','new','x')",
        [],
    )
    .unwrap();
    assert_eq!(sequence(&c, "new"), 18);
    assert!(c.execute("INSERT INTO collection_saved_media(item_key,media_url,path) VALUES('missing','bad','x')",[]).is_err());
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM business_changes WHERE kind='insert'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        3
    );
}

#[cfg(windows)]
#[test]
fn local_database_cancellation_and_faults_preserve_source_at_every_switch_boundary() {
    for checkpoint_name in [
        "before-open",
        "backup-step",
        "before-vacuum",
        "before-swap",
        "after-retire",
        "after-install",
    ] {
        for cancel in [false, true] {
            let f = Fixture::new("boundary");
            let c = f.legacy();
            let before = digest(&c, &AtomicBool::new(false)).unwrap();
            drop(c);
            f.request();
            let flag = cancelled();
            let signal = flag.clone();
            let result = process_with(&f.root, flag, Some(u64::MAX), |name, _| {
                if name == checkpoint_name {
                    if cancel {
                        signal.store(true, Ordering::Relaxed);
                        Ok(())
                    } else {
                        Err(format!("synthetic {name} fault"))
                    }
                } else {
                    Ok(())
                }
            })
            .unwrap()
            .unwrap();
            assert_eq!(
                result.phase,
                if cancel { "cancelled" } else { "failed" },
                "{checkpoint_name}: {}",
                result.error
            );
            let reopened = readonly(&f.path()).unwrap();
            integrity(&reopened).unwrap();
            assert_eq!(
                digest(&reopened, &AtomicBool::new(false)).unwrap(),
                before,
                "{checkpoint_name}"
            );
            assert!(f.path().is_file());
        }
    }
}

#[cfg(windows)]
#[test]
fn local_database_rejects_concurrent_open_owner_and_changed_source_before_swap() {
    let f = Fixture::new("open-owner");
    let c = f.legacy();
    f.request();
    let result = process_with(&f.root, cancelled(), Some(u64::MAX), |_, _| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(result.phase, "failed");
    assert_eq!(sequence_column_count(&c), 0);
    drop(c);
    let f = Fixture::new("changed-source");
    drop(f.legacy());
    f.request();
    let db = f.path();
    let result = process_with(&f.root, cancelled(), Some(u64::MAX), |name, _| {
        if name == "before-file-ownership" {
            let c = Connection::open(&db).unwrap();
            c.execute(
                "INSERT INTO metadata VALUES('concurrent-writer','keep-new-value')",
                [],
            )
            .unwrap();
        }
        Ok(())
    })
    .unwrap()
    .unwrap();
    assert_eq!(result.phase, "failed");
    assert!(result.error.contains("已变化"));
    let c = readonly(&f.path()).unwrap();
    assert_eq!(
        c.query_row(
            "SELECT value FROM metadata WHERE key='concurrent-writer'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "keep-new-value"
    );
    assert!(!Path::new(&result.original_path).exists());
}

#[cfg(windows)]
#[test]
fn local_database_sparse_source_crossing_pending_byte_compacts_after_sqlite_releases_lock() {
    use std::io::{Read, Seek, SeekFrom};
    use std::os::windows::{ffi::OsStrExt, io::AsRawHandle};

    #[link(name = "Kernel32")]
    extern "system" {
        fn DeviceIoControl(
            device: *mut std::ffi::c_void,
            control: u32,
            input: *mut std::ffi::c_void,
            input_bytes: u32,
            output: *mut std::ffi::c_void,
            output_bytes: u32,
            returned_bytes: *mut u32,
            overlapped: *mut std::ffi::c_void,
        ) -> i32;
        fn GetCompressedFileSizeW(name: *const u16, high: *mut u32) -> u32;
    }
    fn allocated_bytes(path: &Path) -> u64 {
        let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut high = 0u32;
        let low = unsafe { GetCompressedFileSizeW(name.as_ptr(), &mut high) };
        assert_ne!(low, u32::MAX, "{}", std::io::Error::last_os_error());
        (u64::from(high) << 32) | u64::from(low)
    }

    const PENDING_BYTE: u64 = 0x4000_0000;
    const MAX_ALLOCATED_BYTES: u64 = 64 * 1024 * 1024;
    let base = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("task-state/data-management-20261016/test-fixtures");
    crate::craft_backup::reject_links(&base).unwrap();
    fs::create_dir_all(&base).unwrap();
    let base = base.canonicalize().unwrap();
    let root = base.join(format!(
        "database-pending-byte-{}",
        crate::random_url_safe(12)
    ));
    fs::create_dir(&root).unwrap();
    let f = Fixture {
        root: root.canonicalize().unwrap(),
    };
    let c = f.legacy();
    ensure_sequences(&c, SEQUENCE_TABLES).unwrap();
    let expected = digest(&c, &AtomicBool::new(false)).unwrap();
    let pages: u64 = c
        .query_row("PRAGMA page_count", [], |row| row.get(0))
        .unwrap();
    let page_size: u64 = c
        .query_row("PRAGMA page_size", [], |row| row.get(0))
        .unwrap();
    assert!(pages * page_size < MAX_ALLOCATED_BYTES);
    drop(c);

    // SQLite's valid header still declares the small database. The sparse tail
    // exercises a whole-file read across its Windows lock bytes without making
    // Backup API or VACUUM materialize a gigabyte of artificial database pages.
    let source = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(f.path())
        .unwrap();
    let mut returned = 0u32;
    let sparse = unsafe {
        DeviceIoControl(
            source.as_raw_handle(),
            0x0009_00c4, // FSCTL_SET_SPARSE
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            0,
            &mut returned,
            std::ptr::null_mut(),
        )
    };
    assert_ne!(sparse, 0, "{}", std::io::Error::last_os_error());
    source.set_len(PENDING_BYTE + 65_536).unwrap();
    source.sync_all().unwrap();
    drop(source);
    assert!(fs::metadata(f.path()).unwrap().len() > PENDING_BYTE);
    assert!(allocated_bytes(&f.path()) < MAX_ALLOCATED_BYTES);

    let locked = Connection::open(f.path()).unwrap();
    assert_eq!(
        locked
            .query_row("PRAGMA page_count", [], |row| row.get::<_, u64>(0))
            .unwrap(),
        pages
    );
    integrity(&locked).unwrap();
    assert_eq!(digest(&locked, &AtomicBool::new(false)).unwrap(), expected);
    locked
        .execute_batch(
            "PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE; COMMIT;",
        )
        .unwrap();
    let mut raw = fs::File::open(f.path()).unwrap();
    raw.seek(SeekFrom::Start(PENDING_BYTE + 2)).unwrap();
    let error = raw.read(&mut [0u8; 1]).unwrap_err();
    assert_eq!(
        error.raw_os_error(),
        Some(33),
        "the real SQLite lock must reproduce ERROR_LOCK_VIOLATION: {error}"
    );
    drop(raw);
    drop(locked);
    let mut raw = fs::File::open(f.path()).unwrap();
    raw.seek(SeekFrom::Start(PENDING_BYTE + 2)).unwrap();
    assert_eq!(raw.read(&mut [0u8; 1]).unwrap(), 1);
    drop(raw);

    f.request();
    let mut reached_ownership = false;
    let result = process_with(&f.root, cancelled(), Some(u64::MAX), |stage, _| {
        if stage == "before-file-ownership" {
            reached_ownership = true;
            assert!(
                fs::metadata(f.path()).unwrap().len() > PENDING_BYTE,
                "SQLite must not truncate the sparse tail before the regression boundary"
            );
        }
        Ok(())
    })
    .unwrap()
    .unwrap();
    assert!(reached_ownership);
    assert_eq!(result.phase, "complete", "{}", result.error);
    assert!(fs::metadata(&result.original_path).unwrap().len() > PENDING_BYTE);
    assert!(allocated_bytes(Path::new(&result.original_path)) < MAX_ALLOCATED_BYTES);
    assert!(fs::metadata(&result.backup_path).unwrap().len() < MAX_ALLOCATED_BYTES);
    assert!(fs::metadata(f.path()).unwrap().len() < MAX_ALLOCATED_BYTES);
    let reopened = readonly(&f.path()).unwrap();
    integrity(&reopened).unwrap();
    assert_eq!(
        digest(&reopened, &AtomicBool::new(false)).unwrap(),
        expected
    );
    assert_eq!(
        (
            sequence(&reopened, "original"),
            sequence(&reopened, "preview")
        ),
        (3, 17)
    );
    drop(reopened);

    // Success-only cleanup stays inside this task's exact synthetic fixture root.
    crate::craft_backup::reject_links(&f.root).unwrap();
    assert_eq!(f.root.parent(), Some(base.as_path()));
    fs::remove_dir_all(&f.root).unwrap();
}

fn sequence_column_count(c: &Connection) -> i64 {
    c.query_row(
        "SELECT count(*) FROM pragma_table_info('collection_saved_media') WHERE name='local_seq'",
        [],
        |r| r.get(0),
    )
    .unwrap()
}

#[cfg(windows)]
#[test]
fn local_database_crash_recovery_restores_retired_source_or_accepts_verified_candidate() {
    for installed in [false, true] {
        let f = Fixture::new("crash-recovery");
        drop(f.legacy());
        let mut state = f.request();
        let original = PathBuf::from(&state.original_path);
        fs::rename(f.path(), &original).unwrap();
        state.source_sha256 = hash_path(&original).unwrap();
        if installed {
            fs::copy(&original, f.path()).unwrap();
            state.candidate_sha256 = hash_path(&f.path()).unwrap();
        }
        state.phase = if installed {
            "replaced"
        } else {
            "original-retired"
        }
        .into();
        save(&pointer(&f.root), &state).unwrap();
        let recovered = process_with(&f.root, cancelled(), Some(u64::MAX), |_, _| {
            panic!("recovery must not launch another compaction")
        })
        .unwrap()
        .unwrap();
        assert_eq!(
            recovered.phase,
            if installed { "complete" } else { "failed" }
        );
        integrity(&readonly(&f.path()).unwrap()).unwrap();
        assert_eq!(status(&f.root).unwrap().unwrap().phase, recovered.phase);
    }
}

#[cfg(windows)]
#[test]
fn local_database_recovery_rejects_modified_original_without_overwriting_candidate_or_backup() {
    for installed in [false, true] {
        let f = Fixture::new("corrupt-original");
        drop(f.legacy());
        let mut state = f.request();
        let original = PathBuf::from(&state.original_path);
        fs::rename(f.path(), &original).unwrap();
        state.source_sha256 = hash_path(&original).unwrap();
        fs::copy(&original, &state.backup_path).unwrap();
        if installed {
            fs::copy(&original, f.path()).unwrap();
            state.candidate_sha256 = hash_path(&f.path()).unwrap();
        }
        let c = Connection::open(&original).unwrap();
        c.execute(
            "INSERT INTO metadata VALUES('unexpected-write','reject-this-copy')",
            [],
        )
        .unwrap();
        drop(c);
        state.phase = if installed {
            "replaced"
        } else {
            "original-retired"
        }
        .into();
        save(&pointer(&f.root), &state).unwrap();
        let error = process_with(&f.root, cancelled(), Some(u64::MAX), |_, _| {
            panic!("recovery must not execute a new run")
        })
        .unwrap_err();
        assert!(error.contains("回退源库身份已变化"));
        assert_eq!(
            hash_path(Path::new(&state.backup_path)).unwrap(),
            state.source_sha256
        );
        assert_eq!(f.path().exists(), installed);
        if installed {
            assert_eq!(hash_path(&f.path()).unwrap(), state.candidate_sha256);
        }
        assert_eq!(status(&f.root).unwrap().unwrap().phase, state.phase);
    }
}

#[cfg(windows)]
#[test]
fn local_database_insufficient_space_keeps_source_and_never_creates_backup() {
    let f = Fixture::new("low-space");
    drop(f.legacy());
    let before = hash_path(&f.path()).unwrap();
    let state = f.request();
    let result = process_with(&f.root, cancelled(), Some(0), |_, _| {
        panic!("low space must reject before work")
    })
    .unwrap()
    .unwrap();
    assert_eq!(result.phase, "failed");
    assert!(result.error.contains("空间不足"));
    assert_eq!(hash_path(&f.path()).unwrap(), before);
    assert!(!Path::new(&state.backup_path).exists());
}

#[cfg(windows)]
#[test]
fn local_database_pointer_identity_failure_never_uses_unapproved_root() {
    let f = Fixture::new("pointer");
    drop(f.legacy());
    let mut state = f.request();
    state.id = "../../unapproved".into();
    save(&pointer(&f.root), &state).unwrap();
    assert!(status(&f.root).is_err());
    assert!(process_with(&f.root, cancelled(), Some(u64::MAX), |_, _| Ok(())).is_err());
}

#[cfg(windows)]
#[test]
fn local_database_active_cancel_marker_reaches_formal_offline_owner() {
    let f = Fixture::new("active-cancel");
    let c = f.legacy();
    c.execute(
        "INSERT INTO padding(payload) VALUES(zeroblob(16777216))",
        [],
    )
    .unwrap();
    drop(c);
    f.request();
    // A bounded live payload gives the separate cancel caller an observation
    // window while the formal owner is verifying the actual source snapshot.
    let root = f.root.clone();
    let owner = std::thread::spawn(move || process_pending(&root, cancelled()));
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    while status(&f.root).unwrap().unwrap().phase == "requested" {
        assert!(
            std::time::Instant::now() < deadline,
            "offline owner did not start"
        );
        std::thread::park_timeout(Duration::from_millis(5));
    }
    let requested = cancel_request(&f.root).unwrap();
    assert_eq!(requested.phase, "preparing");
    assert!(f
        .root
        .join(DIRECTORY)
        .join(&requested.id)
        .join("cancel.requested")
        .is_file());
    let result = owner.join().unwrap().unwrap().unwrap();
    assert_eq!(result.phase, "cancelled", "{}", result.error);
    let c = readonly(&f.path()).unwrap();
    assert_eq!(sequence_column_count(&c), 0);
    assert_eq!(status(&f.root).unwrap().unwrap().phase, "cancelled");
}

#[cfg(windows)]
#[test]
fn local_database_second_offline_owner_cannot_override_active_phase() {
    let f = Fixture::new("duplicate-owner");
    drop(f.legacy());
    let state = f.request();
    let (_, run) = owned_run(&f.root, &state).unwrap();
    let _owner = maintenance_owner(&run).unwrap();
    assert!(
        process_with(&f.root, cancelled(), Some(u64::MAX), |_, _| panic!(
            "second owner must not execute"
        ))
        .is_err()
    );
    assert_eq!(status(&f.root).unwrap().unwrap().phase, "requested");
    assert!(!Path::new(&state.backup_path).exists());
    let result = cancel_request(&f.root).unwrap();
    assert_eq!(
        result.phase, "requested",
        "active owner retains phase publication"
    );
    assert!(run.join("cancel.requested").is_file());
}
