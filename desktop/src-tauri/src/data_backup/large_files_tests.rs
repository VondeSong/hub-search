use super::*;
struct Fixture {
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("task-state/lfi")
            .join(identifier());
        fs::create_dir_all(root.join("collection-files")).unwrap();
        let root = root.canonicalize().unwrap();
        let c = Connection::open(root.join(DATABASE)).unwrap();
        c.execute_batch("CREATE TABLE collection_x_items(item_key TEXT PRIMARY KEY,post_json TEXT);CREATE TABLE collection_saved_media(item_key TEXT,media_url TEXT,path TEXT);").unwrap();
        Self { root }
    }
    fn file(&self, name: &str, n: usize) -> PathBuf {
        let p = self.root.join("collection-files").join(name);
        fs::write(&p, vec![1u8; n]).unwrap();
        p
    }
    fn list(&self, extra: Value) -> Value {
        let mut args = json!({"category":"reading","minimumBytes":0});
        for (k, v) in extra.as_object().unwrap() {
            args[k] = v.clone();
        }
        list(&self.root, &args, &AtomicBool::new(false)).unwrap()
    }
}
#[test]
fn real_inventory_sorts_before_pagination_and_does_not_write() {
    let f = Fixture::new();
    for i in 1..=55 {
        f.file(&format!("video-{i:02}.mp4"), i);
    }
    let before = fs::read(f.root.join(DATABASE)).unwrap();
    let first = f.list(json!({}));
    let next = f.list(json!({"page":1}));
    assert_eq!(first["totalFiles"], 55);
    assert_eq!(first["entries"].as_array().unwrap().len(), 50);
    assert_eq!(first["entries"][0]["bytes"], 55);
    assert_eq!(next["entries"][0]["bytes"], 5);
    assert_eq!(next["entries"].as_array().unwrap().len(), 5);
    assert_eq!(first["totalBytes"], 1540);
    assert_eq!(fs::read(f.root.join(DATABASE)).unwrap(), before);
    assert_eq!(
        fs::read(f.root.join("collection-files/video-55.mp4")).unwrap(),
        vec![1u8; 55]
    );
}
#[test]
fn titles_are_joined_only_by_recorded_path_and_filters_keep_unicode() {
    let f = Fixture::new();
    let p = f.file("large.mp4", 120);
    f.file("other.pdf", 80);
    let c = Connection::open(f.root.join(DATABASE)).unwrap();
    c.execute(
        "INSERT INTO collection_x_items VALUES('key',?1)",
        [json!({"title":"我的视频资料"}).to_string()],
    )
    .unwrap();
    c.execute(
        "INSERT INTO collection_saved_media VALUES('key','fixture:one',?1)",
        [crate::sources::display_local_path(&p)],
    )
    .unwrap();
    drop(c);
    let v = f.list(json!({"kind":"video","query":"视频","minimumBytes":100}));
    assert_eq!(v["totalFiles"], 1);
    assert_eq!(v["entries"][0]["titles"][0], "我的视频资料");
    assert_eq!(v["entries"][0]["referenceCount"], 1);
    assert_eq!(
        f.list(json!({"kind":"pdf","query":"视频"}))["totalFiles"],
        0
    );
    assert_eq!(f.list(json!({"minimumBytes":121}))["totalFiles"], 0);
}
#[test]
fn blob_files_show_document_title_and_detect_binary_media_type() {
    let f = Fixture::new();
    let digest = "a".repeat(64);
    let parent = f.root.join("blobs-v1/aa");
    fs::create_dir_all(&parent).unwrap();
    fs::write(parent.join(&digest), b"%PDF-1.7\nfixture").unwrap();
    let c = Connection::open(f.root.join(DATABASE)).unwrap();
    c.execute_batch("CREATE TABLE documents(space_id TEXT,id TEXT,title TEXT);CREATE TABLE source_items(space_id TEXT,document_id TEXT,blob_hash TEXT);INSERT INTO documents VALUES('space','doc','Cloud document');").unwrap();
    c.execute(
        "INSERT INTO source_items VALUES('space','doc',?1)",
        [digest],
    )
    .unwrap();
    drop(c);
    let v = f.list(json!({"category":"attachments","kind":"pdf"}));
    assert_eq!(v["totalFiles"], 1);
    assert_eq!(v["entries"][0]["titles"][0], "Cloud document");
}
#[test]
fn reveal_accepts_only_existing_files_in_the_selected_root() {
    let f = Fixture::new();
    let p = f.file("real.mp4", 12);
    assert_eq!(
        checked_path(&f.root, "collection-files/real.mp4").unwrap(),
        p
    );
    for value in [
        "../other",
        "collection-files/../craft-search.sqlite3",
        "C:/other",
        r"collection-files\real.mp4",
        "/collection-files/real.mp4",
        "collection-files",
        "collection-files/missing.mp4",
    ] {
        assert!(checked_path(&f.root, value).is_err(), "{value}");
    }
}
#[test]
fn category_totals_use_the_same_owner_as_the_storage_overview() {
    let f = Fixture::new();
    f.file("one.pdf", 128);
    f.file("two.mp4", 256);
    let inventory = f.list(json!({}));
    let usage = super::super::usage(&f.root).unwrap();
    let reading = usage.categories.iter().find(|v| v.id == "reading").unwrap();
    assert_eq!(
        inventory["totalBytes"].as_u64().unwrap(),
        reading.logical_bytes
    );
    assert_eq!(inventory["totalFiles"].as_u64().unwrap(), reading.files);
}
#[test]
fn cancellation_and_unknown_type_fail_without_side_effects() {
    let f = Fixture::new();
    let p = f.file("keep.mp4", 8);
    assert!(list(&f.root, &json!({}), &AtomicBool::new(true)).is_err());
    assert!(list(
        &f.root,
        &json!({"kind":"unsupported"}),
        &AtomicBool::new(false)
    )
    .is_err());
    assert_eq!(fs::read(p).unwrap(), vec![1u8; 8]);
}
