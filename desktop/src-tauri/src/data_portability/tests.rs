use super::*;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "hub-portability-test-{}",
            crate::random_url_safe(16)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn database(&self) -> Connection {
        let c = Connection::open(self.0.join("craft-search.sqlite3")).unwrap();
        c.execute_batch("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE libraries(id TEXT PRIMARY KEY); CREATE TABLE documents(id TEXT PRIMARY KEY);").unwrap();
        c.execute(
            "INSERT INTO metadata VALUES ('schema_version',?1)",
            [DATABASE_SCHEMA_VERSION.to_string()],
        )
        .unwrap();
        c
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn directory_check_rejects_future_or_damaged_databases_without_upgrade() {
    let f = Fixture::new();
    let c = f.database();
    assert_eq!(verify_database(&f.0).unwrap(), DATABASE_SCHEMA_VERSION);
    c.execute(
        "UPDATE metadata SET value=?1",
        [(DATABASE_SCHEMA_VERSION + 1).to_string()],
    )
    .unwrap();
    assert!(verify_database(&f.0).unwrap_err().contains("兼容版本"));
    assert_eq!(
        c.query_row("SELECT value FROM metadata", [], |r| r.get::<_, String>(0))
            .unwrap(),
        (DATABASE_SCHEMA_VERSION + 1).to_string()
    );
    drop(c);
    fs::write(f.0.join("craft-search.sqlite3"), b"not a database").unwrap();
    assert!(verify_database(&f.0).is_err());
}

#[test]
fn directory_tokens_expire_when_wal_changes() {
    let f = Fixture::new();
    let c = f.database();
    c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
        .unwrap();
    let cancel = AtomicBool::new(false);
    let token = remember(f.0.clone(), fingerprint(&f.0, true, &cancel).unwrap(), true).unwrap();
    assert!(checked_token(&token, true, &cancel).is_ok());
    c.execute("INSERT INTO documents VALUES ('changed')", [])
        .unwrap();
    assert!(checked_token(&token, true, &cancel).is_err());
    assert!(checked_token(&token, false, &cancel).is_err());
}

#[test]
fn session_leases_block_movement_and_maintenance_excludes_other_maintenance() {
    let f = Fixture::new();
    let first = session_lease(&f.0).unwrap();
    let second = session_lease(&f.0).unwrap();
    assert!(exclusive_session(&f.0).is_err());
    let maintenance = maintenance_lock(&f.0).unwrap();
    assert!(maintenance_lock(&f.0).is_err());
    drop(maintenance);
    drop(first);
    drop(second);
    let exclusive = exclusive_session(&f.0).unwrap();
    assert!(session_lease(&f.0).is_err());
    drop(exclusive);
    assert!(maintenance_lock(&f.0).is_ok());
}

#[test]
fn copied_storage_is_verified_and_original_retained() {
    let source = Fixture::new();
    let target = Fixture::new();
    fs::create_dir(source.0.join("nested")).unwrap();
    fs::write(source.0.join("nested/notes"), b"portable profile").unwrap();
    fs::write(source.0.join(SESSION_LOCK), b"lock is not profile data").unwrap();
    let (files, bytes) = crate::copy_storage_tree(&source.0, &target.0).unwrap();
    assert_eq!((files, bytes), (1, 16));
    assert_eq!(
        fs::read(target.0.join("nested/notes")).unwrap(),
        b"portable profile"
    );
    assert!(source.0.join("nested/notes").is_file());
    assert!(!target.0.join(SESSION_LOCK).exists());
    assert!(crate::copy_storage_tree(&source.0, &target.0).is_err());
}

#[test]
fn atomic_settings_replace_preserves_valid_json() {
    let f = Fixture::new();
    let path = f.0.join("settings.json");
    atomic_write(&path, b"{\"version\":1}").unwrap();
    atomic_write(&path, b"{\"version\":2}").unwrap();
    let value: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert_eq!(value["version"], 2);
    assert_eq!(fs::read_dir(&f.0).unwrap().count(), 1);
}
