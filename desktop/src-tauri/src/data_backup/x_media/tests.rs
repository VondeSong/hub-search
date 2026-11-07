use super::super::media_policy::tests::{Fixture, PNG};
use super::*;

fn seed(f: &Fixture, shared: bool) -> (PathBuf, PathBuf) {
    let original = f.vault.join("99_Meta/assets/X_assets/original.png");
    fs::write(&original, PNG).unwrap();
    let cached = f
        .root
        .join("collection-files/recovered-assets")
        .join(format!("{:x}", Sha256::digest(PNG)))
        .join("original.png");
    fs::create_dir_all(cached.parent().unwrap()).unwrap();
    fs::write(&cached, PNG).unwrap();
    let c = f.c();
    c.execute("INSERT INTO collection_saved_media(item_key,media_url,path) VALUES('x:a:1','fixture:one',?1)",[cached.to_string_lossy()]).unwrap();
    c.execute(
        "INSERT INTO collection_owned_assets(item_key,path) VALUES('x:a:1',?1)",
        [cached.to_string_lossy()],
    )
    .unwrap();
    c.execute("INSERT INTO collection_x_items(item_key,account,post_json,content_hash,collected_at,captured_at,read_at,read_version) VALUES('x:a:1','fixture','{}','body',1,1,23,7)",[]).unwrap();
    c.execute("INSERT INTO collection_x_properties(item_key,status,tags) VALUES('x:a:1','in_progress','[\"keep\"]')",[]).unwrap();
    c.execute(
        "INSERT INTO reading_media_outbox(namespace,id,body,path) VALUES('fixture','one',?1,?2)",
        params![
            json!({"key":"x:a:1","state":"ready","format":1})
                .to_string()
                .into_bytes(),
            cached.to_string_lossy()
        ],
    )
    .unwrap();
    c.execute("INSERT INTO metadata(key,value) VALUES('hub_owned_data_v1',?1)",[json!({"version":1,"summary":{"pathMappings":[{"sourcePath":original,"restoredPath":cached}]}}).to_string()]).unwrap();
    if shared {
        c.execute("INSERT INTO collection_saved_media(item_key,media_url,path) VALUES('dida:shared','fixture:shared',?1)",[cached.to_string_lossy()]).unwrap();
    }
    (cached, original)
}

#[test]
fn repair_commits_real_lookups_before_cleanup_preserving_sequences_body_and_reading_state() {
    let f = Fixture::new();
    let (cached, original) = seed(&f, false);
    let c = f.c();
    let seq: i64 = c
        .query_row(
            "SELECT local_seq FROM collection_saved_media WHERE item_key='x:a:1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let outseq: i64 = c
        .query_row("SELECT local_seq FROM reading_media_outbox", [], |r| {
            r.get(0)
        })
        .unwrap();
    drop(c);
    assert!(cleanup(&f.root).is_err());
    let fixed = repair(&f.root).unwrap();
    assert_eq!(fixed["relinkedSavedMedia"], 1);
    assert!(cached.is_file());
    let c = f.c();
    let resolved = crate::x_bookmarks::storage::recorded_media_path(&c, seq).unwrap();
    assert_eq!(resolved, original);
    assert_eq!(fs::read(resolved).unwrap(), PNG);
    assert_eq!(
        c.query_row("SELECT local_seq FROM reading_media_outbox", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        outseq
    );
    assert_eq!(
        c.query_row("SELECT path FROM reading_media_outbox", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        original.to_string_lossy()
    );
    assert_eq!(
        c.query_row(
            "SELECT read_at||':'||read_version FROM collection_x_items",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "23:7"
    );
    assert_eq!(
        c.query_row(
            "SELECT status||':'||tags FROM collection_x_properties",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "in_progress:[\"keep\"]"
    );
    drop(c);
    assert_eq!(cleanup(&f.root).unwrap()["deletedFiles"], 1);
    assert!(!cached.exists());
    assert_eq!(fs::read(original).unwrap(), PNG);
    assert_eq!(cleanup(&f.root).unwrap()["alreadyAbsent"], 1);
}

#[test]
fn shared_and_changed_keepers_and_unique_files_are_retained() {
    let f = Fixture::new();
    let (cached, original) = seed(&f, true);
    let unique = f.root.join("collection-files/unique-722.bin");
    fs::write(&unique, vec![3; 722]).unwrap();
    repair(&f.root).unwrap();
    assert_eq!(cleanup(&f.root).unwrap()["deletedFiles"], 0);
    assert!(cached.is_file());
    f.c()
        .execute(
            "DELETE FROM collection_saved_media WHERE item_key='dida:shared'",
            [],
        )
        .unwrap();
    fs::write(&original, b"edited original").unwrap();
    assert_eq!(cleanup(&f.root).unwrap()["deletedFiles"], 0);
    assert_eq!(fs::read(cached).unwrap(), PNG);
    assert_eq!(fs::read(unique).unwrap(), vec![3; 722]);
}

#[test]
fn missing_or_different_obsidian_original_never_relinks_or_deletes_hub_bytes() {
    let f = Fixture::new();
    let (cached, original) = seed(&f, false);
    fs::write(&original, b"different").unwrap();
    assert_eq!(repair(&f.root).unwrap()["relinkedSavedMedia"], 0);
    assert_eq!(cleanup(&f.root).unwrap()["deletedFiles"], 0);
    assert_eq!(fs::read(&cached).unwrap(), PNG);
    fs::remove_file(original).unwrap();
    assert_eq!(repair(&f.root).unwrap()["relinkedSavedMedia"], 0);
    assert!(cached.exists());
}

#[test]
fn active_session_prevents_reference_changes_and_cleanup() {
    let f = Fixture::new();
    let (cached, _) = seed(&f, false);
    let _session = crate::data_portability::exclusive_session(&f.root).unwrap();
    assert!(repair(&f.root).is_err());
    assert!(cleanup(&f.root).is_err());
    assert!(cached.is_file());
}

#[test]
fn local_intake_content_receipt_restores_original_x_media_paths_without_changing_vault() {
    let f = Fixture::new();
    let (cached, old) = seed(&f, false);
    let original = f.vault.join("X/media/photos/original.png");
    fs::create_dir_all(original.parent().unwrap()).unwrap();
    fs::rename(old, &original).unwrap();
    let digest = format!("{:x}", Sha256::digest(PNG));
    let canonical_cache = cached.clone();
    let c = f.c();
    c.execute("DELETE FROM metadata WHERE key='hub_owned_data_v1'", [])
        .unwrap();
    c.execute(
        "INSERT INTO collection_local_source_assets(path,stamp,digest) VALUES(?1,'unchanged',?2)",
        params![original.to_string_lossy(), digest],
    )
    .unwrap();
    for table in [
        "collection_saved_media",
        "collection_owned_assets",
        "reading_media_outbox",
    ] {
        c.execute(
            &format!("UPDATE {table} SET path=?1"),
            [canonical_cache.to_string_lossy()],
        )
        .unwrap();
    }
    drop(c);
    assert_eq!(repair(&f.root).unwrap()["relinkedSavedMedia"], 1);
    assert_eq!(cleanup(&f.root).unwrap()["deletedFiles"], 1);
    assert_eq!(fs::read(original).unwrap(), PNG);
}

#[test]
fn startup_can_relink_a_restored_snapshot_after_the_duplicate_was_already_removed() {
    let f = Fixture::new();
    let (cached, original) = seed(&f, false);
    let c = f.c();
    let plain = crate::sources::display_local_path(&cached);
    for table in [
        "collection_saved_media",
        "collection_owned_assets",
        "reading_media_outbox",
    ] {
        c.execute(&format!("UPDATE {table} SET path=?1"), [&plain])
            .unwrap();
    }
    c.execute("DELETE FROM metadata WHERE key='hub_owned_data_v1'", [])
        .unwrap();
    drop(c);
    fs::remove_file(&cached).unwrap();
    initialize_owned_data(&f.root).unwrap();
    let c = f.c();
    let id: i64 = c
        .query_row(
            "SELECT local_seq FROM collection_saved_media WHERE item_key='x:a:1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        crate::x_bookmarks::storage::recorded_media_path(&c, id).unwrap(),
        original
    );
    assert!(!cached.exists());
    assert_eq!(fs::read(original).unwrap(), PNG);
}

#[test]
fn plain_windows_paths_and_legacy_obsidian_x_identity_use_the_same_verified_repair() {
    let f = Fixture::new();
    let (cached, old_original) = seed(&f, false);
    let c = f.c();
    let original = f.vault.join("99_Meta/assets/legacy-clip.png");
    fs::rename(old_original, &original).unwrap();
    c.execute(
        "INSERT INTO collection_local_source_assets(path,stamp,digest) VALUES(?1,'unchanged',?2)",
        params![
            original.to_string_lossy(),
            format!("{:x}", Sha256::digest(PNG))
        ],
    )
    .unwrap();
    let plain = crate::sources::display_local_path(&cached);
    for table in ["collection_saved_media", "collection_owned_assets"] {
        c.execute(
            &format!("UPDATE {table} SET path=?1,item_key='obsidian:x:legacy'"),
            [&plain],
        )
        .unwrap();
    }
    c.execute("UPDATE reading_media_outbox SET path=?1,body=json_set(CAST(body AS TEXT),'$.key','obsidian:x:legacy')",[&plain]).unwrap();
    c.execute("DELETE FROM metadata WHERE key='hub_owned_data_v1'", [])
        .unwrap();
    drop(c);
    assert_eq!(repair(&f.root).unwrap()["relinkedSavedMedia"], 1);
    assert_eq!(cleanup(&f.root).unwrap()["deletedFiles"], 1);
    let path: String = f
        .c()
        .query_row("SELECT path FROM collection_saved_media", [], |r| r.get(0))
        .unwrap();
    assert_eq!(Path::new(&path), original);
}
