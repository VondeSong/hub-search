use super::*;
use rusqlite::params;
use serde_json::json;

pub(in crate::data_backup) const PNG: &[u8] =
    b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0synthetic-pixel";

pub(crate) struct Fixture {
    pub root: PathBuf,
    pub vault: PathBuf,
    pub db: PathBuf,
}
impl Fixture {
    pub fn new() -> Self {
        let base = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("task-state/xod")
            .join(identifier());
        let root = base.join("profile");
        let vault = base.join("vault");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(vault.join("99_Meta/assets/X_assets")).unwrap();
        let root = root.canonicalize().unwrap();
        let vault = vault.canonicalize().unwrap();
        let db = root.join(DATABASE);
        let c = crate::open_database(&db).unwrap();
        crate::x_bookmarks::storage::schema(&c).unwrap();
        c.execute(
            "INSERT INTO metadata(key,value) VALUES('collection_storage_v1',?1)",
            [json!({"mode":"obsidian","vaultPath":vault,"downloadMedia":true}).to_string()],
        )
        .unwrap();
        Self { root, vault, db }
    }
    pub fn c(&self) -> Connection {
        crate::open_database(&self.db).unwrap()
    }
}

#[test]
fn telegram_cloud_cache_keeps_cache_ownership_while_dida_and_external_originals_are_retained() {
    let f = Fixture::new();
    let database = PathBuf::from(crate::sources::display_local_path(&f.db));
    let cache = database.parent().unwrap().join("reading-media-v1");
    fs::create_dir(&cache).unwrap();
    let source = cache.join("original.png");
    fs::write(&source, PNG).unwrap();
    let c = Connection::open(&database).unwrap();
    crate::x_bookmarks::storage::record_saved_media(
        &c,
        "telegram:fixture:one",
        "fixture:cache",
        &source,
    )
    .unwrap();
    let path: String = c
        .query_row(
            "SELECT path FROM collection_saved_media WHERE item_key='telegram:fixture:one'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(PathBuf::from(path), source);
    crate::x_bookmarks::storage::record_saved_media(&c, "dida:one", "fixture:cache", &source)
        .unwrap();
    let path: String = c
        .query_row(
            "SELECT path FROM collection_saved_media WHERE item_key='dida:one'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(Path::new(&path).starts_with(f.root.join("collection-files")));
    assert_eq!(fs::read(path).unwrap(), PNG);
    let outside = f.vault.join("telegram-original.png");
    fs::write(&outside, PNG).unwrap();
    crate::x_bookmarks::storage::record_saved_media(
        &c,
        "telegram:fixture:two",
        "fixture:source",
        &outside,
    )
    .unwrap();
    let path: String = c
        .query_row(
            "SELECT path FROM collection_saved_media WHERE item_key='telegram:fixture:two'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(Path::new(&path).starts_with(f.root.join("collection-files")));
    assert_eq!(fs::read(outside).unwrap(), PNG);
}

#[test]
fn x_and_likes_use_existing_vault_files_without_hub_copy_or_deletion_ownership() {
    let f = Fixture::new();
    let path = f.vault.join("99_Meta/assets/X_assets/original.png");
    fs::write(&path, PNG).unwrap();
    let c = f.c();
    for key in ["x:account:123", "x-likes:account:123", "obsidian:x:legacy"] {
        crate::x_bookmarks::library::track_asset(&c, key, &path).unwrap();
        crate::x_bookmarks::storage::record_saved_media(&c, key, "fixture:one", &path).unwrap();
        let saved: String = c
            .query_row(
                "SELECT path FROM collection_saved_media WHERE item_key=?1",
                [key],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(Path::new(&saved), path);
    }
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM collection_owned_assets", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert!(!f.root.join("collection-files").exists());
    assert_eq!(fs::read(path).unwrap(), PNG);
}

#[test]
fn unavailable_or_hub_nested_vault_blocks_x_and_preserves_previous_lookup() {
    let f = Fixture::new();
    let c = f.c();
    let path = f.vault.join("99_Meta/assets/X_assets/one.png");
    fs::write(&path, PNG).unwrap();
    crate::x_bookmarks::storage::record_saved_media(&c, "x:a:1", "fixture:one", &path).unwrap();
    for cfg in [
        json!({"mode":"database"}),
        json!({"mode":"obsidian","vaultPath":f.root}),
        json!({"mode":"obsidian","vaultPath":f.vault.join("missing")}),
    ] {
        c.execute(
            "UPDATE metadata SET value=?1 WHERE key='collection_storage_v1'",
            [cfg.to_string()],
        )
        .unwrap();
        assert!(
            crate::x_bookmarks::storage::record_saved_media(&c, "x:a:1", "fixture:one", &path)
                .is_err()
        );
        let saved: String = c
            .query_row(
                "SELECT path FROM collection_saved_media WHERE item_key='x:a:1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(Path::new(&saved), path);
    }
    assert!(!f.root.join("collection-files").exists());
}

#[test]
fn cloud_bytes_and_old_cache_reuse_publish_only_in_vault_and_never_overwrite_originals() {
    let f = Fixture::new();
    let c = f.c();
    let published = save_x_bytes(&c, "fixture:cloud", PNG).unwrap();
    assert!(published.starts_with(&f.vault));
    assert_eq!(save_x_bytes(&c, "fixture:cloud", PNG).unwrap(), published);
    assert!(save_x_bytes(&c, "fixture:cloud", &[PNG, b"changed"].concat()).is_err());
    assert_eq!(fs::read(&published).unwrap(), PNG);
    let old = f.root.join("old-cache.png");
    fs::write(&old, PNG).unwrap();
    let reused = retain(&c, "x:a:1", "fixture:cloud", &old).unwrap();
    assert_eq!(reused, published);
    assert!(!f.root.join("collection-files").exists());
    let dida = retain(&c, "dida:one", "fixture:dida", &published).unwrap();
    assert!(dida.starts_with(&f.root));
}

#[test]
fn archives_and_startup_collect_dida_but_exclude_external_x_and_x_upload_receipts() {
    let f = Fixture::new();
    let c = f.c();
    let x = f.vault.join("99_Meta/assets/X_assets/x.png");
    fs::write(&x, PNG).unwrap();
    let dida = f.vault.join("dida.png");
    fs::write(&dida, PNG).unwrap();
    for (key, path) in [("x:a:1", &x), ("dida:one", &dida)] {
        c.execute(
            "INSERT INTO collection_saved_media(item_key,media_url,path) VALUES(?1,?1,?2)",
            params![key, path.to_string_lossy()],
        )
        .unwrap();
        c.execute(
            "INSERT INTO reading_media_outbox(namespace,id,body,path) VALUES('test',?1,?2,?3)",
            params![
                key,
                json!({"key":key,"format":1,"state":"ready"})
                    .to_string()
                    .into_bytes(),
                path.to_string_lossy()
            ],
        )
        .unwrap();
    }
    drop(c);
    let mut inputs = Vec::new();
    let mut dependencies = Vec::new();
    let mut warnings = Vec::new();
    let mut complete = true;
    super::super::dependencies::collect_reading_assets(
        &f.db,
        &mut inputs,
        &mut dependencies,
        &mut warnings,
        &mut complete,
        &AtomicBool::new(false),
        None,
    )
    .unwrap();
    assert!(inputs.iter().any(|v| v.source == dida));
    assert!(!inputs.iter().any(|v| v.source == x));
    initialize_owned_data(&f.root).unwrap();
    let c = f.c();
    let saved: String = c
        .query_row(
            "SELECT path FROM collection_saved_media WHERE item_key='x:a:1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(Path::new(&saved), x);
    assert_eq!(fs::read(x).unwrap(), PNG);
}
