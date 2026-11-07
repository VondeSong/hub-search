use super::*;
use crate::{fs, library_runtime, AppState};
use std::path::PathBuf;
use std::time::{Duration, Instant};

fn fixture() -> (PathBuf, PathBuf, PathBuf, String) {
    let base = std::env::temp_dir().join(format!(
        "hub-library-location-{}",
        crate::random_url_safe(12)
    ));
    let old = base.join("Old");
    fs::create_dir_all(&old).unwrap();
    fs::write(old.join("note.md"), "# Original\nkept content").unwrap();
    let db = base.join("craft-search.sqlite3");
    let c = crate::open_database(&db).unwrap();
    let id = sources::obsidian_library_id(&old).unwrap();
    c.execute("INSERT INTO libraries(id,provider,name,location,enabled,added_at,metadata_json) VALUES(?1,'obsidian','My Alias',?2,1,1,'{\"displayNameCustomized\":1,\"excludedPaths\":[\"Archive\"]}')", params![id,sources::display_local_path(&old)]).unwrap();
    crate::x_bookmarks::library::register_root(&c, &old.canonicalize().unwrap()).unwrap();
    drop(c);
    crate::sync_obsidian_library_database(&db, &id, &old).unwrap();
    (base, db, old, id)
}

#[test]
fn renamed_vault_preserves_identity_copies_and_receives_real_file_events() {
    let (base, db, old, id) = fixture();
    let c = crate::open_database(&db).unwrap();
    let old_destination =
        crate::x_bookmarks::library::register_root(&c, &old.canonicalize().unwrap()).unwrap();
    c.execute(
        "INSERT INTO metadata(key,value) VALUES('collection_storage_v1',?1)",
        [
            serde_json::json!({"mode":"obsidian","vaultPath":sources::display_local_path(&old)})
                .to_string(),
        ],
    )
    .unwrap();
    c.execute(
        "INSERT INTO collection_owned_assets(item_key,path) VALUES('item',?1)",
        [old.join("media.png").to_string_lossy()],
    )
    .unwrap();
    c.execute(
        "INSERT INTO collection_owned_assets(item_key,path) VALUES('other',?1)",
        [base.join("Old-copy/media.png").to_string_lossy()],
    )
    .unwrap();
    c.execute("INSERT INTO collection_obsidian_exports(destination,item_key,relative_path,file_hash,input_hash) VALUES(?1,'item','note.md','kept','input')", [&old_destination]).unwrap();
    drop(c);
    let state = AppState::default();
    crate::register_obsidian_watcher(&state, &id, &old).unwrap();
    let new = base.join("LifeOS");
    fs::rename(&old, &new).unwrap();
    crate::relocate_obsidian_runtime(&db, &id, &new, &state).unwrap();
    let c = crate::open_database(&db).unwrap();
    assert_eq!(obsidian_id_at(&c, &new).unwrap(), Some(id.clone()));
    assert_ne!(sources::obsidian_library_id(&new).unwrap(), id);
    assert_eq!(vault_name(&c, &id).unwrap(), "LifeOS");
    assert_eq!(
        c.query_row("SELECT name FROM libraries WHERE id=?1", [&id], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "My Alias"
    );
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM documents WHERE space_id=?1",
            [&id],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    assert_eq!(
        crate::x_bookmarks::library::register_root(&c, &new.canonicalize().unwrap()).unwrap(),
        old_destination
    );
    let saved_root: String = c
        .query_row(
            "SELECT root FROM collection_roots WHERE destination=?1",
            [&old_destination],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(path_key(Path::new(&saved_root)), path_key(&new));
    let asset: String = c
        .query_row(
            "SELECT path FROM collection_owned_assets WHERE item_key='item'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        path_key(Path::new(&asset)),
        path_key(&new.join("media.png"))
    );
    let other: String = c
        .query_row(
            "SELECT path FROM collection_owned_assets WHERE item_key='other'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        path_key(Path::new(&other)),
        path_key(&base.join("Old-copy/media.png"))
    );
    let pref: String = c.query_row("SELECT json_extract(value,'$.vaultPath') FROM metadata WHERE key='collection_storage_v1'", [], |r| r.get(0)).unwrap();
    assert_eq!(path_key(Path::new(&pref)), path_key(&new));
    drop(c);
    fs::write(new.join("note.md"), "# Original\nchanged after move").unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if state
            .obsidian_changes
            .lock()
            .unwrap()
            .get(&id)
            .is_some_and(|q| {
                q.paths
                    .iter()
                    .any(|p| path_key(p) == path_key(&new.join("note.md")))
            })
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "new directory changes never reached the original library"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
    crate::sync_obsidian_library_database(&db, &id, &new).unwrap();
    let c = crate::open_database(&db).unwrap();
    let body: String = c
        .query_row(
            "SELECT markdown FROM documents WHERE space_id=?1",
            [&id],
            |r| r.get(0),
        )
        .unwrap();
    assert!(body.contains("changed after move"));
    drop(c);
    drop(state);
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn invalid_location_and_active_work_leave_the_original_path_intact() {
    let (base, db, old, id) = fixture();
    let wrong = base.join("Unrelated");
    fs::create_dir(&wrong).unwrap();
    let state = AppState::default();
    crate::register_obsidian_watcher(&state, &id, &old).unwrap();
    assert!(crate::relocate_obsidian_runtime(&db, &id, &wrong, &state).is_err());
    assert!(state.obsidian_watchers.lock().unwrap().contains_key(&id));
    let new = base.join("New");
    fs::create_dir(&new).unwrap();
    fs::copy(old.join("note.md"), new.join("note.md")).unwrap();
    let operation = library_runtime::begin(&base, &id, "existing work").unwrap();
    assert!(crate::relocate_obsidian_runtime(&db, &id, &new, &state)
        .unwrap_err()
        .contains("暂停"));
    drop(operation);
    let c = crate::open_database(&db).unwrap();
    let location: String = c
        .query_row("SELECT location FROM libraries WHERE id=?1", [&id], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(path_key(Path::new(&location)), path_key(&old));
    assert_eq!(obsidian_id_at(&c, &old).unwrap(), Some(id));
    drop(c);
    drop(state);
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn storage_failure_rolls_back_all_paths_and_does_not_replace_the_watcher() {
    let (base, db, old, id) = fixture();
    let new = base.join("New");
    fs::create_dir(&new).unwrap();
    fs::copy(old.join("note.md"), new.join("note.md")).unwrap();
    let c = crate::open_database(&db).unwrap();
    c.execute(
        "INSERT INTO metadata(key,value) VALUES('collection_storage_v1','invalid-json')",
        [],
    )
    .unwrap();
    drop(c);
    let state = AppState::default();
    crate::register_obsidian_watcher(&state, &id, &old).unwrap();
    assert!(crate::relocate_obsidian_runtime(&db, &id, &new, &state).is_err());
    let c = crate::open_database(&db).unwrap();
    assert_eq!(obsidian_id_at(&c, &old).unwrap(), Some(id));
    let saved: String = c
        .query_row("SELECT root FROM collection_roots LIMIT 1", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(path_key(Path::new(&saved)), path_key(&old));
    drop(c);
    drop(state);
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn occupied_directory_is_rejected_and_paused_library_stays_paused() {
    let (base, db, old, id) = fixture();
    let new = base.join("New");
    fs::create_dir(&new).unwrap();
    fs::copy(old.join("note.md"), new.join("note.md")).unwrap();
    let c = crate::open_database(&db).unwrap();
    c.execute("INSERT INTO libraries(id,provider,name,location,enabled,added_at) VALUES('other','obsidian','other',?1,1,2)", [sources::display_local_path(&new)]).unwrap();
    drop(c);
    let state = AppState::default();
    assert!(crate::relocate_obsidian_runtime(&db, &id, &new, &state)
        .unwrap_err()
        .contains("另一个"));
    let c = crate::open_database(&db).unwrap();
    c.execute("DELETE FROM libraries WHERE id='other'", [])
        .unwrap();
    drop(c);
    library_runtime::control(&base, &id, "pause").unwrap();
    crate::relocate_obsidian_runtime(&db, &id, &new, &state).unwrap();
    assert_eq!(library_runtime::status(&base, &id).unwrap().state, "paused");
    drop(state);
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn craft_remote_rename_keeps_identity_and_preserves_custom_names() {
    let (base, db, _, _) = fixture();
    let mut c = crate::open_database(&db).unwrap();
    c.execute("INSERT INTO spaces(id,name,mcp_url,added_at) VALUES('craft-id','Main','https://example.test/mcp',1)", []).unwrap();
    c.execute("INSERT INTO libraries(id,provider,name,enabled,added_at,metadata_json) VALUES('craft-id','craft','Main',1,1,'{}')", []).unwrap();
    assert_eq!(
        refresh_craft_name(&mut c, "craft-id", "Archive").unwrap(),
        "Archive"
    );
    c.execute("UPDATE libraries SET name='My Custom Name',metadata_json='{\"displayNameCustomized\":1}' WHERE id='craft-id'", []).unwrap();
    assert_eq!(
        refresh_craft_name(&mut c, "craft-id", "Remote Renamed Again").unwrap(),
        "My Custom Name"
    );
    let (id, name): (String, String) = c
        .query_row("SELECT id,name FROM spaces WHERE id='craft-id'", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!((id.as_str(), name.as_str()), ("craft-id", "My Custom Name"));
    drop(c);
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn relocation_rejects_unrelated_same_named_note_and_reading_write_conflicts() {
    let (base, db, old, id) = fixture();
    let new = base.join("New");
    fs::create_dir(&new).unwrap();
    fs::write(
        new.join("note.md"),
        "# Unrelated\nA different library's note",
    )
    .unwrap();
    let state = AppState::default();
    assert!(crate::relocate_obsidian_runtime(&db, &id, &new, &state)
        .unwrap_err()
        .contains("匹配"));
    fs::copy(old.join("note.md"), new.join("note.md")).unwrap();
    let collection = crate::x_bookmarks::SYNC_LOCK.try_lock().unwrap();
    assert!(crate::relocate_obsidian_runtime(&db, &id, &new, &state)
        .unwrap_err()
        .contains("仍在写入"));
    drop(collection);
    let copy = crate::x_bookmarks::library::try_relocation(&old, &new).unwrap();
    assert!(crate::relocate_obsidian_runtime(&db, &id, &new, &state)
        .unwrap_err()
        .contains("副本"));
    drop(copy);
    let c = crate::open_database(&db).unwrap();
    assert_eq!(obsidian_id_at(&c, &old).unwrap(), Some(id));
    drop(c);
    drop(state);
    fs::remove_dir_all(base).unwrap();
}
