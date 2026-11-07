use super::*;
use serde_json::{json, Value};

const PNG: &[u8] =
    b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0synthetic-pixel";

struct Fixture {
    base: PathBuf,
    root: PathBuf,
    database: PathBuf,
}
impl Fixture {
    fn new(name: &str) -> Self {
        let parent = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("task-state/ods");
        fs::create_dir_all(&parent).unwrap();
        let base = parent.join(format!("{name}-{}", identifier()));
        let root = base.join("profile");
        fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let base = base.canonicalize().unwrap();
        let database = root.join(DATABASE);
        let c = crate::open_database(&database).unwrap();
        crate::x_bookmarks::storage::schema(&c).unwrap();
        drop(c);
        Self {
            base,
            root,
            database,
        }
    }
    fn c(&self) -> Connection {
        crate::open_database(&self.database).unwrap()
    }
    fn source(&self, name: &str) -> PathBuf {
        let directory = self.base.join("external-export");
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join(name);
        fs::write(&path, PNG).unwrap();
        path
    }
    fn recorded(c: &Connection, key: &str) -> PathBuf {
        let sequence: i64 = c
            .query_row(
                "SELECT local_seq FROM collection_saved_media WHERE item_key=?1",
                [key],
                |r| r.get(0),
            )
            .unwrap();
        crate::x_bookmarks::storage::recorded_media_path(c, sequence).unwrap()
    }
}

#[test]
fn export_lookup_owns_verified_root_copy_and_reuses_identical_bytes() {
    let f = Fixture::new("export");
    let source = f.source("first.png");
    let c = f.c();
    crate::x_bookmarks::storage::record_saved_media(&c, "dida:one", "fixture:one", &source)
        .unwrap();
    let first = Fixture::recorded(&c, "dida:one");
    assert!(first.starts_with(&f.root));
    assert_eq!(fs::read(&first).unwrap(), PNG);
    let renamed = f.source("second.dat");
    crate::x_bookmarks::storage::record_saved_media(&c, "dida:two", "fixture:two", &renamed)
        .unwrap();
    assert_eq!(Fixture::recorded(&c, "dida:two"), first);
    assert_eq!(fs::read(source).unwrap(), PNG);
    assert_eq!(fs::read(renamed).unwrap(), PNG);
}

#[test]
fn retained_documents_keep_the_type_required_by_native_attachment_opening() {
    let f = Fixture::new("documents");
    let c = f.c();
    for (name, bytes, extension) in [
        ("manual.PDF", b"%PDF-1.7\nfixture".as_slice(), "pdf"),
        (
            "document.docx",
            b"PK\x03\x04office-fixture".as_slice(),
            "docx",
        ),
        ("sheet.xlsx", b"PK\x03\x04office-fixture".as_slice(), "xlsx"),
        ("notes.txt", b"plain text fixture".as_slice(), "txt"),
    ] {
        let source = f.source(name);
        fs::write(&source, bytes).unwrap();
        crate::x_bookmarks::storage::record_saved_media(&c, name, "fixture:document", &source)
            .unwrap();
        let saved: String = c
            .query_row(
                "SELECT path FROM collection_saved_media WHERE item_key=?1",
                [name],
                |r| r.get(0),
            )
            .unwrap();
        let retained = PathBuf::from(saved);
        assert!(retained.starts_with(&f.root));
        assert_eq!(retained.extension().unwrap(), extension);
        assert_eq!(fs::read(retained).unwrap(), bytes);
        assert_eq!(fs::read(source).unwrap(), bytes);
    }
}

#[test]
fn missing_or_conflicting_input_never_replaces_the_saved_lookup() {
    let f = Fixture::new("failed");
    let c = f.c();
    let source = f.source("one.png");
    crate::x_bookmarks::storage::record_saved_media(&c, "dida:one", "fixture:one", &source)
        .unwrap();
    let before = Fixture::recorded(&c, "dida:one");
    assert!(crate::x_bookmarks::storage::record_saved_media(
        &c,
        "dida:one",
        "fixture:one",
        &f.base.join("missing.png")
    )
    .is_err());
    assert_eq!(Fixture::recorded(&c, "dida:one"), before);
    let other = f.source("other.png");
    fs::write(&other, [PNG, b"different"].concat()).unwrap();
    let retained = retain_media(&c, &other).unwrap();
    fs::write(&retained, b"corrupt").unwrap();
    assert!(
        crate::x_bookmarks::storage::record_saved_media(&c, "dida:one", "fixture:one", &other)
            .is_err()
    );
    assert_eq!(Fixture::recorded(&c, "dida:one"), before);
    assert_eq!(fs::read(before).unwrap(), PNG);
}

#[test]
fn a_reading_cache_download_becomes_a_durable_original() {
    let f = Fixture::new("cache");
    let directory = f.root.join("reading-media-v1");
    fs::create_dir(&directory).unwrap();
    let source = directory.join("cached.png");
    fs::write(&source, PNG).unwrap();
    let c = f.c();
    crate::x_bookmarks::storage::record_saved_media(&c, "dida:one", "fixture:one", &source)
        .unwrap();
    let retained = Fixture::recorded(&c, "dida:one");
    assert!(retained.starts_with(f.root.join("collection-files")));
    fs::rename(directory, f.base.join("evicted-cache")).unwrap();
    assert_eq!(fs::read(Fixture::recorded(&c, "dida:one")).unwrap(), PNG);
}

fn copy_tree(source: &Path, target: &Path) {
    fs::create_dir(target).unwrap();
    for entry in fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let to = target.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &to);
        } else {
            fs::copy(entry.path(), to).unwrap();
        }
    }
}

#[test]
fn startup_adopts_legacy_media_and_copied_root_reads_offline_without_old_paths() {
    let f = Fixture::new("startup");
    let source = f.source("legacy.png");
    let vault = f.base.join("original-obsidian");
    fs::create_dir(&vault).unwrap();
    fs::write(vault.join("keep.md"), b"original vault stays unchanged").unwrap();
    let c = f.c();
    // The old exporter wrote this external pathname directly (0.16.284).
    c.execute("INSERT INTO collection_saved_media(item_key,media_url,path) VALUES('dida:legacy','fixture:one',?1)", [source.to_string_lossy()]).unwrap();
    c.execute("INSERT INTO libraries(id,provider,name,enabled,added_at,location) VALUES('obs','obsidian','Original',1,1,?1)", [vault.to_string_lossy()]).unwrap();
    c.execute("INSERT INTO metadata(key,value) VALUES('hub_data_root',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [crate::sources::display_local_path(&f.root)]).unwrap();
    drop(c);
    initialize_owned_data(&f.root).unwrap();
    let c = f.c();
    let retained = Fixture::recorded(&c, "dida:legacy");
    assert!(retained.canonicalize().unwrap().starts_with(&f.root));
    let marker: String = c
        .query_row(
            "SELECT value FROM metadata WHERE key='hub_owned_data_v1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    drop(c);
    initialize_owned_data(&f.root).unwrap();
    let c = f.c();
    assert_eq!(
        c.query_row(
            "SELECT value FROM metadata WHERE key='hub_owned_data_v1'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        marker
    );
    drop(c);
    let copied = f.base.join("copied-profile");
    copy_tree(&f.root, &copied);
    fs::rename(&source, source.with_extension("unavailable")).unwrap();
    fs::rename(&f.root, f.base.join("old-profile-unavailable")).unwrap();
    crate::data_portability::prepare_opened_root(&copied, false).unwrap();
    initialize_owned_data(&copied).unwrap();
    let c = crate::open_database(&copied.join(DATABASE)).unwrap();
    let path = Fixture::recorded(&c, "dida:legacy");
    assert!(path
        .canonicalize()
        .unwrap()
        .starts_with(copied.canonicalize().unwrap()));
    assert_eq!(fs::read(path).unwrap(), PNG);
    assert_eq!(
        c.query_row("SELECT location FROM libraries WHERE id='obs'", [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap(),
        vault.to_string_lossy()
    );
    assert_eq!(
        fs::read(vault.join("keep.md")).unwrap(),
        b"original vault stays unchanged"
    );
}

#[test]
fn craft_initial_and_saved_options_keep_originals_under_the_current_root() {
    let f = Fixture::new("craft");
    let external = f.base.join("external-backup");
    fs::create_dir(&external).unwrap();
    let options: crate::craft_export::CraftVaultExportOptions = serde_json::from_value(json!({
        "libraryId":"craft:fixture","destination":external,"vaultName":"Fixture",
        "includeImages":false,"includeVideos":false,"includeOtherAttachments":false
    }))
    .unwrap();
    let owned = crate::craft_backup::managed_options(&f.database, options).unwrap();
    assert!(Path::new(&owned.destination).starts_with(&f.root));
    assert!(owned.include_images && owned.include_videos && owned.include_other_attachments);
    assert_eq!(fs::read_dir(&external).unwrap().count(), 0);
    let prepared = f.root.join("external-sources/prepared-existing/space");
    fs::create_dir_all(&prepared).unwrap();
    let again =
        managed_craft_parent(&f.database, "craft:fixture", prepared.to_str().unwrap()).unwrap();
    assert_eq!(again, prepared.canonicalize().unwrap());
}

#[test]
fn independent_obsidian_intake_is_not_consolidated_or_moved() {
    let f = Fixture::new("obsidian");
    let source = f.source("original.png");
    let c = f.c();
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS collection_local_source_items(item_key TEXT PRIMARY KEY);
        INSERT INTO collection_local_source_items(item_key) VALUES('local:obsidian');",
    )
    .unwrap();
    c.execute("INSERT INTO collection_saved_media(item_key,media_url,path) VALUES('local:obsidian','fixture:one',?1)", [source.to_string_lossy()]).unwrap();
    drop(c);
    initialize_owned_data(&f.root).unwrap();
    let c = f.c();
    assert_eq!(Fixture::recorded(&c, "local:obsidian"), source);
    assert!(!f.root.join("collection-files/recovered-assets").exists());
    let marker: String = c
        .query_row(
            "SELECT value FROM metadata WHERE key='hub_owned_data_v1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let value: Value = serde_json::from_str(&marker).unwrap();
    assert_eq!(value["summary"]["copiedFiles"], 0);
}
