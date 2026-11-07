use super::*;

struct Fixture {
    base: PathBuf,
    database: PathBuf,
    old: PathBuf,
    destination: String,
}

impl Fixture {
    fn new() -> Self {
        let base =
            std::env::temp_dir().join(format!("hub-reading-vault-{}", crate::random_url_safe(12)));
        let old = base.join("ZhiHu");
        fs::create_dir_all(old.join("X/书签")).unwrap();
        let note =
            "---\n地址: \"https://x.com/example/status/123\"\n状态: \"待读\"\n---\n\nOriginal text";
        fs::write(old.join("X/书签/note.md"), note).unwrap();
        fs::write(old.join("image.png"), b"original media").unwrap();
        let database = base.join("craft-search.sqlite3");
        let c = crate::open_database(&database).unwrap();
        schema(&c).unwrap();
        let destination = library::register_root(&c, &old.canonicalize().unwrap()).unwrap();
        meta(&c, CONFIG, &json!({"mode":"obsidian","vaultPath":crate::sources::display_local_path(&old),"downloadMedia":true,"autoSyncMinutes":30}).to_string()).unwrap();
        c.execute("INSERT INTO collection_x_items(item_key,account,post_json,content_hash,collected_at,captured_at) VALUES('item','fixture',?1,'input',1,1)", [json!({"url":"https://x.com/example/status/123"}).to_string()]).unwrap();
        c.execute("INSERT INTO collection_obsidian_exports(destination,item_key,relative_path,file_hash,input_hash) VALUES(?1,'item','X/书签/note.md',?2,'input')", params![destination, hash(note.as_bytes())]).unwrap();
        c.execute(
            "INSERT INTO collection_owned_assets(item_key,path) VALUES('item',?1)",
            [old.join("image.png").to_string_lossy()],
        )
        .unwrap();
        c.execute("INSERT INTO collection_saved_media(item_key,media_url,path) VALUES('item','https://example.test/image.png',?1)", [old.join("image.png").to_string_lossy()]).unwrap();
        c.execute(
            "INSERT INTO collection_lifecycle(item_key,destination) VALUES('item',?1)",
            [format!("vault:{destination}")],
        )
        .unwrap();
        c.execute("INSERT INTO collection_library_destinations(item_key,target,state) VALUES('item',?1,'saved')", [format!("vault:{destination}")]).unwrap();
        Self {
            base,
            database,
            old,
            destination,
        }
    }

    fn moved(&self, name: &str) -> PathBuf {
        let new = self.base.join(name);
        fs::rename(&self.old, &new).unwrap();
        new
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

#[test]
fn reading_vault_relocation_keeps_unregistered_copy_identity_and_media() {
    let fixture = Fixture::new();
    let new = fixture.moved("Sources");
    let mut c = crate::open_database(&fixture.database).unwrap();
    let info = information(&c).unwrap();
    assert_eq!(info["rootExists"], false);
    assert_eq!(info["candidates"].as_array().unwrap().len(), 1);
    assert_eq!(info["candidates"][0]["name"], "Sources");
    relocate_unregistered(&mut c, &fixture.old.to_string_lossy(), &new).unwrap();
    assert_eq!(
        crate::library_location::path_key(Path::new(&config(&c).unwrap().vault_path)),
        crate::library_location::path_key(&new)
    );
    assert_eq!(
        library::register_root(&c, &new.canonicalize().unwrap()).unwrap(),
        fixture.destination
    );
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM collection_obsidian_exports",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    assert_eq!(
        c.query_row(
            "SELECT target FROM collection_library_destinations WHERE item_key='item'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        format!("vault:{}", fixture.destination)
    );
    for table in ["collection_owned_assets", "collection_saved_media"] {
        let path = c
            .query_row(
                &format!("SELECT path FROM {table} WHERE item_key='item'"),
                [],
                |r| r.get::<_, String>(0),
            )
            .unwrap();
        assert_eq!(
            crate::library_location::path_key(Path::new(&path)),
            crate::library_location::path_key(&new.join("image.png"))
        );
        assert_eq!(fs::read(&path).unwrap(), b"original media");
    }
    library::record_saved(&c, "item", &new.canonicalize().unwrap()).unwrap();
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM collection_library_destinations WHERE item_key='item'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    assert!(new.join("X/书签/note.md").is_file());
    assert_eq!(information(&c).unwrap()["rootExists"], true);
}

#[test]
fn reading_vault_manual_edits_match_immutable_origin_and_stay_untouched() {
    let fixture = Fixture::new();
    let new = fixture.moved("Edited Sources");
    let edited = "---\n地址: \"https://x.com/example/status/123\"\n状态: \"已读\"\n标签: [我的标签]\n---\n\nMy manual changes";
    fs::write(new.join("X/书签/note.md"), edited).unwrap();
    let mut c = crate::open_database(&fixture.database).unwrap();
    relocate_unregistered(&mut c, &fixture.old.to_string_lossy(), &new).unwrap();
    assert_eq!(
        fs::read_to_string(new.join("X/书签/note.md")).unwrap(),
        edited
    );
    assert_ne!(
        c.query_row(
            "SELECT file_hash FROM collection_obsidian_exports",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        hash(edited.as_bytes())
    );
}

#[test]
fn reading_vault_rejects_same_filename_unrelated_source_and_stale_settings() {
    let fixture = Fixture::new();
    let new = fixture.moved("Sources");
    let wrong = fixture.base.join("Wrong");
    fs::create_dir_all(wrong.join("X/书签")).unwrap();
    fs::write(
        wrong.join("X/书签/note.md"),
        "---\n地址: \"https://x.com/other/status/999\"\n---\nDifferent note",
    )
    .unwrap();
    let mut c = crate::open_database(&fixture.database).unwrap();
    assert!(
        relocate_unregistered(&mut c, &fixture.old.to_string_lossy(), &wrong)
            .unwrap_err()
            .contains("匹配")
    );
    assert_eq!(
        config(&c).unwrap().vault_path,
        crate::sources::display_local_path(&fixture.old)
    );
    assert!(
        relocate_unregistered(&mut c, &fixture.base.join("stale").to_string_lossy(), &new)
            .unwrap_err()
            .contains("已被更改")
    );
    assert!(information(&c).unwrap()["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .all(|candidate| candidate["name"] != "Wrong"));
}

#[test]
fn reading_vault_ambiguous_candidates_require_selection_and_do_not_rebind() {
    let fixture = Fixture::new();
    let new = fixture.moved("Sources");
    let copy = fixture.base.join("Sources Copy");
    fs::create_dir_all(copy.join("X/书签")).unwrap();
    fs::copy(new.join("X/书签/note.md"), copy.join("X/书签/note.md")).unwrap();
    let c = crate::open_database(&fixture.database).unwrap();
    assert_eq!(
        information(&c).unwrap()["candidates"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        config(&c).unwrap().vault_path,
        crate::sources::display_local_path(&fixture.old)
    );
    let root = c
        .query_row(
            "SELECT root FROM collection_roots WHERE destination=?1",
            [&fixture.destination],
            |r| r.get::<_, String>(0),
        )
        .unwrap();
    assert_eq!(
        crate::library_location::path_key(Path::new(&root)),
        crate::library_location::path_key(&fixture.old)
    );
}

#[test]
fn reading_vault_occupied_target_and_database_failure_leave_all_receipts_intact() {
    let fixture = Fixture::new();
    let new = fixture.moved("Sources");
    let mut c = crate::open_database(&fixture.database).unwrap();
    c.execute("INSERT INTO libraries(id,provider,name,location,enabled,added_at) VALUES('another','obsidian','another',?1,1,1)", [crate::sources::display_local_path(&new)]).unwrap();
    assert!(
        relocate_unregistered(&mut c, &fixture.old.to_string_lossy(), &new)
            .unwrap_err()
            .contains("另一个")
    );
    c.execute("DELETE FROM libraries WHERE id='another'", [])
        .unwrap();
    c.execute_batch("CREATE TRIGGER prevent_root_update BEFORE UPDATE ON metadata WHEN OLD.key='collection_storage_v1' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
    assert!(relocate_unregistered(&mut c, &fixture.old.to_string_lossy(), &new).is_err());
    assert_eq!(
        config(&c).unwrap().vault_path,
        crate::sources::display_local_path(&fixture.old)
    );
    let saved = c
        .query_row(
            "SELECT root FROM collection_roots WHERE destination=?1",
            [&fixture.destination],
            |r| r.get::<_, String>(0),
        )
        .unwrap();
    assert_eq!(
        crate::library_location::path_key(Path::new(&saved)),
        crate::library_location::path_key(&fixture.old)
    );
    let asset = c
        .query_row("SELECT path FROM collection_saved_media", [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap();
    assert_eq!(
        crate::library_location::path_key(Path::new(&asset)),
        crate::library_location::path_key(&fixture.old.join("image.png"))
    );
}

#[test]
fn reading_vault_offline_default_can_be_changed_without_redirecting_saved_items() {
    let fixture = Fixture::new();
    fixture.moved("Sources");
    let c = crate::open_database(&fixture.database).unwrap();
    c.execute("INSERT INTO collection_x_items(item_key,account,post_json,content_hash,collected_at,captured_at) VALUES('not-yet-exported','fixture','{}','input',1,1)", []).unwrap();
    library::pin_defaults(&c, &config(&c).unwrap()).unwrap();
    assert_eq!(
        c.query_row(
            "SELECT destination FROM collection_lifecycle WHERE item_key='item'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        format!("vault:{}", fixture.destination)
    );
    assert_eq!(
        c.query_row(
            "SELECT destination FROM collection_lifecycle WHERE item_key='not-yet-exported'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        format!("vault:{}", fixture.destination)
    );
}
