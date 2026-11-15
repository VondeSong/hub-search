use super::*;

#[test]
#[ignore = "explicit read-only check of daily OS originals; never writes notes"]
fn live_daily_note_snapshot_and_unchanged_compose() {
    let database =
        Path::new("C:/Users/yongs/AppData/Roaming/com.craftsearch.desktop/craft-search.sqlite3");
    let c =
        Connection::open_with_flags(database, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let mut query = c.prepare("SELECT l.id,d.id FROM libraries l JOIN documents d ON d.space_id=l.id WHERE l.enabled=1 AND l.provider='obsidian' AND d.provider='obsidian' AND length(d.markdown) BETWEEN 500 AND 4000 AND d.path NOT LIKE '%验收%' AND d.path NOT LIKE '%测试%' ORDER BY d.path LIMIT 2").unwrap();
    let rows = query
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .unwrap();
    let mut checked = 0;
    for row in rows {
        let (library, document) = row.unwrap();
        let before = snapshot(&c, &library, &document).unwrap();
        assert!(before.utf8);
        let (_, body) = split(&before.before).unwrap();
        let composed = compose(&before, body).unwrap();
        assert_eq!(
            composed, before.before,
            "unchanged compose must retain original properties and line endings"
        );
        assert_eq!(
            STANDARD.decode(&before.raw_base64).unwrap(),
            before.before.as_bytes()
        );
        let after = snapshot(&c, &library, &document).unwrap();
        assert_eq!(before.hash, after.hash);
        assert_eq!(before.file_identity, after.file_identity);
        checked += 1;
    }
    assert_eq!(checked, 2, "two existing daily notes required");
    println!("two real note snapshots and unchanged-body round trips passed; no note written");
}

pub(crate) struct Fixture {
    pub root: PathBuf,
    pub vault: PathBuf,
}
impl Fixture {
    pub(crate) fn new() -> Self {
        let parent = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.local/hbm04-tests");
        fs::create_dir_all(&parent).unwrap();
        let root = parent.join(crate::random_url_safe(12));
        let vault = root.join("vault");
        fs::create_dir_all(&vault).unwrap();
        let f = Self { root, vault };
        f.c().execute("INSERT INTO libraries(id,provider,name,location,enabled,added_at) VALUES('notes','obsidian','隔离笔记',?1,1,1)",[f.vault.to_string_lossy().as_ref()]).unwrap();
        f
    }
    pub(crate) fn c(&self) -> Connection {
        crate::open_database(&self.root.join("craft-search.sqlite3")).unwrap()
    }
    pub(crate) fn seed(&self, path: &str, text: &str) -> String {
        let file = self.vault.join(path);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, text).unwrap();
        let doc = crate::read_markdown_document_with_exclusions(&self.vault, &file, &[]).unwrap();
        let mut c = self.c();
        let tx = c.transaction().unwrap();
        crate::upsert_obsidian_document(&tx, "notes", &doc, 1).unwrap();
        tx.commit().unwrap();
        doc.id
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let parent = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.local/hbm04-tests");
        assert_eq!(self.root.parent(), Some(parent.as_path()));
        let _ = fs::remove_dir_all(&self.root);
    }
}
#[test]
fn real_snapshot_and_composition_preserve_bom_frontmatter_and_crlf() {
    let f = Fixture::new();
    let text = "\u{feff}---\r\naliases: [原别名]\r\n---\r\n原文\r\n";
    let id = f.seed("目录/笔记.md", text);
    let base = snapshot(&f.c(), "notes", &id).unwrap();
    assert_eq!(base.before, text);
    assert_eq!(
        compose(&base, "新正文\n").unwrap(),
        "\u{feff}---\r\naliases: [原别名]\r\n---\r\n新正文\r\n"
    );
    assert!(compose(&base, "").is_err());
    assert_eq!(snapshot(&f.c(), "notes", &id).unwrap().hash, base.hash);
    let id = f.seed("short.md", "---\r\naliases: []\r\n---\r\n无末尾换行");
    let base = snapshot(&f.c(), "notes", &id).unwrap();
    assert!(compose(&base, "新正文\n第二行")
        .unwrap()
        .ends_with("新正文\r\n第二行"));
}
#[test]
fn exclusive_file_and_directory_guards_block_concurrent_writes_and_replacement() {
    let f = Fixture::new();
    let id = f.seed("目录/笔记.md", "原文");
    let base = snapshot(&f.c(), "notes", &id).unwrap();
    let mut note = LockedNote::open(&f.c(), &base).unwrap();
    assert!(fs::write(f.vault.join("目录/笔记.md"), "外部修改").is_err());
    assert!(fs::rename(f.vault.join("目录"), f.vault.join("已移动")).is_err());
    note.write("新正文").unwrap();
    drop(note);
    assert_eq!(
        fs::read_to_string(f.vault.join("目录/笔记.md")).unwrap(),
        "新正文"
    );
}
#[test]
fn changed_deleted_moved_and_same_bytes_replacement_are_rejected() {
    let f = Fixture::new();
    let id = f.seed("note.md", "原文");
    let base = snapshot(&f.c(), "notes", &id).unwrap();
    let file = f.vault.join("note.md");
    fs::write(&file, "外部新内容").unwrap();
    assert!(LockedNote::open(&f.c(), &base).is_err());
    fs::rename(&file, f.vault.join("moved.md")).unwrap();
    assert!(LockedNote::open(&f.c(), &base).is_err());
    fs::write(&file, "原文").unwrap();
    assert!(LockedNote::open(&f.c(), &base).is_err());
    fs::remove_file(&file).unwrap();
    assert!(snapshot(&f.c(), "notes", &id).is_err());
}
#[test]
fn path_policy_rejects_internal_excluded_escape_and_hardlinked_files() {
    let f = Fixture::new();
    let id = f.seed("note.md", "原文");
    let internal = f.seed(".obsidian/config.md", "不能编辑");
    assert!(snapshot(&f.c(), "notes", &internal).is_err());
    fs::hard_link(f.vault.join("note.md"), f.root.join("other.md")).unwrap();
    assert!(snapshot(&f.c(), "notes", &id).is_err());
    let other = f.seed("other.md", "其他");
    f.c()
        .execute(
            "UPDATE documents SET path='../outside.md' WHERE id=?1",
            [&other],
        )
        .unwrap();
    assert!(snapshot(&f.c(), "notes", &other).is_err());
    f.c().execute("UPDATE libraries SET enabled=0", []).unwrap();
    assert!(snapshot(&f.c(), "notes", &id).is_err());
}
#[test]
fn invalid_utf8_is_preserved_for_explicit_recovery_but_never_sent_to_model() {
    let f = Fixture::new();
    let id = f.seed("note.md", "原文");
    fs::write(f.vault.join("note.md"), [0xe4, 0xb8]).unwrap();
    let base = snapshot(&f.c(), "notes", &id).unwrap();
    assert!(!base.utf8);
    assert_eq!(STANDARD.decode(&base.raw_base64).unwrap(), [0xe4, 0xb8]);
    assert!(compose(&base, "新内容").is_err());
}
