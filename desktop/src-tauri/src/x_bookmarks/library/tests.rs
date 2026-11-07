use super::*;
#[test]
fn controlled_archive_plans_are_never_promoted_or_claimed_by_automatic_workers() {
    let c = database();
    seed(&c, "agent");
    seed(&c, "legacy");
    let legacy = json!({"status":"planned","provider":"craft","title":"Archive","tasks":[]});
    let mut controlled = legacy.clone();
    controlled["agentActionId"] = json!("confirmed-action");
    for (key, plan) in [("agent", &controlled), ("legacy", &legacy)] {
        c.execute("INSERT INTO collection_library_jobs(item_key,action,target,phase,plan,error) VALUES(?1,'move','craft','needs_review',?2,'')",params![key,plan.to_string()]).unwrap();
    }
    assert_eq!(queue_automatic_saves(&c).unwrap(), 1);
    assert_eq!(
        c.query_row(
            "SELECT phase FROM collection_library_jobs WHERE item_key='agent'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "needs_review"
    );
    assert!(claim_dispatch(&c, "legacy", "move", "craft", true).unwrap());
    c.execute(
        "UPDATE collection_library_jobs SET phase='ready' WHERE item_key='agent'",
        [],
    )
    .unwrap();
    assert!(!claim_dispatch(&c, "agent", "move", "craft", true).unwrap());
    assert!(claim_dispatch(&c, "agent", "move", "craft", false).unwrap());
}
struct Vault(PathBuf);
impl Vault {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("hub-collection-lifecycle-{}", random_url_safe(16)));
        fs::create_dir_all(&path).unwrap();
        Self(fs::canonicalize(path).unwrap())
    }
}

#[test]
fn relocation_cleanup_preview_keeps_the_stable_destination_of_the_selected_copy() {
    let c = database();
    seed(&c, "one");
    let original = Vault::new();
    let renamed = Vault::new();
    let other = Vault::new();
    let destination = register_root(&c, &original.0).unwrap();
    let other_destination = register_root(&c, &other.0).unwrap();
    for receipt in [&destination, &other_destination] {
        c.execute("INSERT INTO collection_obsidian_exports(destination,item_key,relative_path,file_hash,input_hash) VALUES(?1,'one','note.md','original','input')", [receipt]).unwrap();
    }
    let tx = c.unchecked_transaction().unwrap();
    relocate_root(&tx, &original.0, &renamed.0).unwrap();
    tx.commit().unwrap();
    let keep =
        collection_cleanup_keep_destination(&c, Some(&format!("vault:{destination}"))).unwrap();
    assert_eq!(keep, Some(destination.clone()));
    assert_ne!(
        keep.as_ref().unwrap(),
        &storage::hash(renamed.0.to_string_lossy().as_bytes())
    );
    let listed = c.prepare("SELECT destination FROM collection_obsidian_exports WHERE item_key='one' AND (?1 IS NULL OR destination<>?1)").unwrap().query_map([keep], |row| row.get::<_, String>(0)).unwrap().collect::<Result<Vec<_>, _>>().unwrap();
    assert_eq!(listed, [other_destination]);
    assert_eq!(
        collection_cleanup_keep_destination(&c, Some("hub")).unwrap(),
        None
    );
    assert_eq!(collection_cleanup_keep_destination(&c, None).unwrap(), None);
}
impl Drop for Vault {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn database() -> Connection {
    let c = super::super::tests::database();
    storage::schema(&c).unwrap();
    c
}
fn seed(c: &Connection, key: &str) {
    let post = parse_page(&super::super::tests::response(vec![
        super::super::tests::entry(super::super::tests::tweet("123")),
    ]))
    .unwrap()
    .posts
    .remove(0);
    c.execute("INSERT INTO collection_x_items(item_key,account,post_json,content_hash,collected_at,captured_at) VALUES(?1,'123',?2,'test',1,1)",params![key,serde_json::to_string(&post).unwrap()]).unwrap();
}
#[test]
fn operation_records_identify_retained_plans_without_changing_their_state() {
    let c = database();
    seed(&c, "one");
    c.execute("INSERT INTO collection_library_jobs(item_key,action,target,phase,error,plan,updated_at) VALUES('one','move','removed-library','cancelled','cancelled receipt',?1,20)", [json!({"title":"Plan title","libraryName":"Craft Main"}).to_string()]).unwrap();
    c.execute(
        "INSERT INTO collection_roots(destination,root) VALUES('vault-hash','C:/Notes/My Vault')",
        [],
    )
    .unwrap();
    c.execute("INSERT INTO collection_library_pending(item_key,action,target,phase,error,plan,updated_at,goal,cleanup_force,detail) VALUES('one','move','vault:vault-hash','partial','retained error','',10,'',0,'')", []).unwrap();
    let before = c.total_changes();
    let records = stored_operations(&c).unwrap();
    assert_eq!(records.len(), 2);
    assert_eq!(records[0]["phase"], "cancelled");
    assert_eq!(records[0]["error"], "cancelled receipt");
    assert_eq!(records[0]["targetName"], "Craft Main");
    assert_eq!(records[0]["updatedAt"], 20);
    assert!(!records[0]["itemTitle"].as_str().unwrap().is_empty());
    assert_eq!(records[1]["phase"], "partial");
    assert_eq!(records[1]["parked"], true);
    assert_eq!(records[1]["error"], "retained error");
    assert_eq!(records[1]["targetName"], "Obsidian · My Vault");
    assert_eq!(records[1]["updatedAt"], 10);
    assert_eq!(c.total_changes(), before);
}
#[test]
fn deselect_saved_destination_preserves_receipts_assets_and_reattaches_without_creation() {
    let c = database();
    seed(&c, "one");
    let vault = Vault::new();
    let file = vault.0.join("original.mp4");
    fs::write(&file, b"original").unwrap();
    track_asset(&c, "one", &file).unwrap();
    queue_library_move(&c, "one", "craft").unwrap();
    c.execute("INSERT INTO collection_remote_copies(item_key,library_id,provider,object_id,parent_id,verified) VALUES('one','craft','craft','page','date:2026-10-07',1)",[]).unwrap();
    complete_copy(&c, "one", "craft").unwrap();
    c.execute(
        "INSERT INTO collection_lifecycle(item_key,destination) VALUES('one','craft')",
        [],
    )
    .unwrap();
    selection::remove(&c, "one", "craft").unwrap();
    let mut row = json!({});
    decorate(&c, "one", &mut row).unwrap();
    assert_eq!(row["storageLocations"].as_array().unwrap().len(), 1);
    assert_eq!(row["storageLocations"][0]["kind"], "hub");
    assert!(row["operation"].is_null());
    assert_eq!(
        c.query_row("SELECT count(*) FROM collection_remote_copies", [], |r| r
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        1
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM collection_owned_assets", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(fs::read(&file).unwrap(), b"original");
    queue_library_move(&c, "one", "craft").unwrap();
    assert_eq!(
        c.query_row(
            "SELECT selected FROM collection_library_destinations WHERE target='craft'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM collection_library_jobs", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
#[test]
fn deselect_queued_destination_keeps_its_exact_plan_and_advances_another_selected_target() {
    let c = database();
    seed(&c, "one");
    queue_library_move(&c, "one", "first").unwrap();
    c.execute("UPDATE collection_library_jobs SET phase='ready',plan='retained-plan',goal='retained-goal',detail='retained-detail',cleanup_force=1",[]).unwrap();
    queue_library_move(&c, "one", "second").unwrap();
    selection::remove(&c, "one", "first").unwrap();
    assert_eq!(
        c.query_row("SELECT target FROM collection_library_jobs", [], |r| r
            .get::<_, String>(
            0
        ))
        .unwrap(),
        "second"
    );
    let retained:(String,String,String,i64)=c.query_row("SELECT plan,goal,detail,cleanup_force FROM collection_library_pending WHERE target='first'",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
    assert_eq!(
        retained,
        (
            "retained-plan".into(),
            "retained-goal".into(),
            "retained-detail".into(),
            1
        )
    );
    queue_library_move(&c, "one", "first").unwrap();
    complete_copy(&c, "one", "second").unwrap();
    assert_eq!(
        c.query_row(
            "SELECT target,phase,plan FROM collection_library_jobs",
            [],
            |r| Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?
            ))
        )
        .unwrap(),
        ("first".into(), "ready".into(), "retained-plan".into())
    );
}
#[test]
fn deselect_parked_blocked_destination_hides_attention_but_preserves_its_plan() {
    let c = database();
    seed(&c, "one");
    queue_library_move(&c, "one", "blocked").unwrap();
    c.execute("UPDATE collection_library_jobs SET phase='partial',error='retry attachments',plan='original-plan'",[]).unwrap();
    queue_library_move(&c, "one", "other").unwrap();
    complete_copy(&c, "one", "other").unwrap();
    assert_eq!(attention_operations(&c, "one").unwrap().len(), 1);
    selection::remove(&c, "one", "blocked").unwrap();
    assert!(attention_operations(&c, "one").unwrap().is_empty());
    assert_eq!(
        super::super::query::navigation_counts(&c, Some("all")).unwrap()["needsAttention"],
        0
    );
    assert_eq!(
        c.query_row(
            "SELECT plan FROM collection_library_pending WHERE target='blocked'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "original-plan"
    );
    queue_library_move(&c, "one", "blocked").unwrap();
    assert_eq!(
        c.query_row(
            "SELECT phase FROM collection_library_jobs WHERE target='blocked'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "partial"
    );
    assert_eq!(attention_operations(&c, "one").unwrap().len(), 1);
}
#[test]
fn deselect_inflight_write_defers_dispatch_and_reattaches_as_unknown_without_late_commit() {
    let c = database();
    seed(&c, "one");
    queue_library_move(&c, "one", "first").unwrap();
    assert!(claim_dispatch(&c, "one", "move", "first", true).unwrap());
    c.execute(
        "UPDATE collection_library_jobs SET phase='writing',plan='original-plan'",
        [],
    )
    .unwrap();
    queue_library_move(&c, "one", "second").unwrap();
    selection::remove(&c, "one", "first").unwrap();
    assert_eq!(
        c.query_row(
            "SELECT target,phase,inflight FROM collection_library_jobs",
            [],
            |r| Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?
            ))
        )
        .unwrap(),
        ("first".into(), "cancelled".into(), 1)
    );
    assert!(complete_copy(&c, "one", "first").is_err());
    assert_eq!(
        c.query_row(
            "SELECT selected FROM collection_library_destinations WHERE target='first'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    queue_library_move(&c, "one", "first").unwrap();
    assert!(!claim_dispatch(&c, "one", "move", "first", false).unwrap());
    release_dispatch(&c, "one", "first").unwrap();
    assert_eq!(
        c.query_row(
            "SELECT target,phase,plan FROM collection_library_jobs",
            [],
            |r| Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?
            ))
        )
        .unwrap(),
        ("first".into(), "unknown".into(), "original-plan".into())
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM collection_remote_copies", [], |r| r
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        0
    );
}
#[test]
fn deselect_default_root_rejects_aliases_and_offline_paths_without_a_network_request() {
    let c = database();
    seed(&c, "one");
    assert!(selection::remove(&c, "one", "hub").is_err());
    assert!(selection::remove(&c, "one", "default").is_err());
    c.execute_batch("CREATE TABLE libraries(id TEXT,provider TEXT,enabled INTEGER,location TEXT,name TEXT); INSERT INTO libraries VALUES('alias','obsidian',0,'d:/Offline/Notes/','Alias'),('removed','craft',0,NULL,'Removed');").unwrap();
    configure_default(&c, "obsidian", r"D:\Offline\Notes");
    assert!(selection::remove(&c, "one", "alias").is_err());
    c.execute(
        "INSERT INTO collection_roots(destination,root) VALUES('root-hash','d:/offline/notes/')",
        [],
    )
    .unwrap();
    assert!(selection::remove(&c, "one", "vault:root-hash").is_err());
    queue_library_move(&c, "one", "removed").unwrap();
    selection::remove(&c, "one", "removed").unwrap();
    assert_eq!(
        c.query_row(
            "SELECT selected FROM collection_library_destinations WHERE target='removed'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}
#[test]
fn deselect_migration_keeps_legacy_destinations_selected_and_retains_late_local_receipts() {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch("CREATE TABLE collection_library_destinations(item_key TEXT,target TEXT,state TEXT,PRIMARY KEY(item_key,target)); INSERT INTO collection_library_destinations VALUES('legacy','craft','saved');").unwrap();
    schema(&c).unwrap();
    assert_eq!(
        c.query_row(
            "SELECT selected FROM collection_library_destinations",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    let c = database();
    seed(&c, "one");
    let vault = Vault::new();
    c.execute_batch(
        "CREATE TABLE libraries(id TEXT,provider TEXT,enabled INTEGER,location TEXT,name TEXT);",
    )
    .unwrap();
    c.execute(
        "INSERT INTO libraries VALUES('other-vault','obsidian',1,?1,'Other')",
        [vault.0.to_string_lossy()],
    )
    .unwrap();
    queue_library_move(&c, "one", "other-vault").unwrap();
    selection::remove(&c, "one", "other-vault").unwrap();
    record_saved(&c, "one", &vault.0).unwrap();
    let mut row = json!({});
    decorate(&c, "one", &mut row).unwrap();
    assert_eq!(row["storageLocations"].as_array().unwrap().len(), 1);
    assert!(row["destinationId"].is_null());
    assert_eq!(
        c.query_row(
            "SELECT state,selected FROM collection_library_destinations WHERE target='other-vault'",
            [],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        )
        .unwrap(),
        ("saved".into(), 0)
    );
}
#[test]
fn deselect_vault_clears_both_hash_and_library_aliases_without_late_badge_revival() {
    let c = database();
    seed(&c, "one");
    let vault = Vault::new();
    c.execute_batch(
        "CREATE TABLE libraries(id TEXT,provider TEXT,enabled INTEGER,location TEXT,name TEXT);",
    )
    .unwrap();
    c.execute(
        "INSERT INTO libraries VALUES('library','obsidian',1,?1,'Other')",
        [vault.0.to_string_lossy()],
    )
    .unwrap();
    let hash = register_root(&c, &vault.0).unwrap();
    let target = format!("vault:{hash}");
    c.execute("INSERT INTO collection_library_destinations(item_key,target,state) VALUES('one','library','saved'),('one',?1,'saved')",[&target]).unwrap();
    c.execute(
        "INSERT INTO collection_lifecycle(item_key,destination) VALUES('one',?1)",
        [&target],
    )
    .unwrap();
    selection::remove(&c, "one", "library").unwrap();
    record_saved(&c, "one", &vault.0).unwrap();
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM collection_library_destinations WHERE selected=1",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    let mut row = json!({});
    decorate(&c, "one", &mut row).unwrap();
    assert_eq!(row["storageLocations"].as_array().unwrap().len(), 1);
    assert!(row["destinationId"].is_null());
}
#[test]
fn blocked_copy_keeps_its_plan_while_three_other_targets_complete() {
    let c = database();
    seed(&c, "one");
    queue_library_move(&c, "one", "old-craft").unwrap();
    c.execute("UPDATE collection_library_jobs SET phase='partial',error='source changed',plan='retained-plan'",[]).unwrap();
    for target in ["dida", "main", "xv"] {
        queue_library_move(&c, "one", target).unwrap();
    }
    assert_eq!(
        c.query_row("SELECT target FROM collection_library_jobs", [], |r| r
            .get::<_, String>(
            0
        ))
        .unwrap(),
        "dida"
    );
    assert_eq!(
        c.query_row("SELECT plan FROM collection_library_pending", [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap(),
        "retained-plan"
    );
    for target in ["dida", "main", "xv"] {
        complete_copy(&c, "one", target).unwrap();
    }
    assert_eq!(
        c.query_row("SELECT count(*) FROM collection_library_jobs", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        c.query_row(
            "SELECT state FROM collection_library_destinations WHERE target='old-craft'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "blocked"
    );
    queue_library_move(&c, "one", "old-craft").unwrap();
    assert_eq!(
        c.query_row("SELECT plan FROM collection_library_jobs", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "retained-plan"
    );
    assert_eq!(
        c.query_row("SELECT phase FROM collection_library_jobs", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "partial"
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM collection_library_pending", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
#[test]
fn native_windows_path_and_configured_path_are_one_location() {
    assert_eq!(
        normalized_vault_path(r"\\?\D:\Notes\ZhiHu"),
        normalized_vault_path("d:/notes/zhihu/")
    );
    assert_ne!(
        normalized_vault_path("D:/Notes/a"),
        normalized_vault_path("D:/Notes/ab")
    );
}
#[test]
fn multiple_copy_requests_survive_reopen_and_keep_existing_pages() {
    let vault = Vault::new();
    let db = vault.0.join("copies.sqlite");
    let c = Connection::open(&db).unwrap();
    storage::schema(&c).unwrap();
    fs::write(vault.0.join("original.md"), "original with user edits").unwrap();
    fs::write(vault.0.join("original.mp4"), "original video").unwrap();
    queue_library_move(&c, "item", "craft-main").unwrap();
    queue_library_move(&c, "item", "dida").unwrap();
    queue_library_move(&c, "item", "craft-main").unwrap();
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM collection_library_destinations",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        2
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM collection_library_jobs", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    c.execute("INSERT INTO collection_remote_copies(item_key,library_id,provider,object_id,verified) VALUES('item','craft-main','craft','existing-page',1)", []).unwrap();
    complete_copy(&c, "item", "craft-main").unwrap();
    drop(c);
    let c = Connection::open(&db).unwrap();
    schema(&c).unwrap();
    assert_eq!(
        c.query_row("SELECT target FROM collection_library_jobs", [], |r| r
            .get::<_, String>(
            0
        ))
        .unwrap(),
        "dida"
    );
    complete_copy(&c, "item", "dida").unwrap();
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM collection_library_destinations WHERE state='saved'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        2
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM collection_remote_copies", [], |r| r
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        1
    );
    assert_eq!(
        fs::read_to_string(vault.0.join("original.md")).unwrap(),
        "original with user edits"
    );
    assert!(vault.0.join("original.mp4").exists());
}
#[test]
fn multiple_copy_projection_keeps_the_default_and_both_targets() {
    let c = database();
    seed(&c, "one");
    c.execute_batch("CREATE TABLE libraries(id TEXT,provider TEXT,enabled INTEGER,location TEXT,name TEXT); INSERT INTO libraries VALUES('craft','craft',1,NULL,'Main'),('dida','dida365',1,NULL,'Tasks');").unwrap();
    queue_library_move(&c, "one", "craft").unwrap();
    queue_library_move(&c, "one", "dida").unwrap();
    complete_copy(&c, "one", "craft").unwrap();
    let mut row = json!({});
    decorate(&c, "one", &mut row).unwrap();
    assert_eq!(row["storageLocations"][0]["kind"], "hub");
    assert_eq!(row["destinationIds"], json!(["craft", "dida"]));
    assert_eq!(row["storageLocations"][1]["copyState"], "saved");
    assert_eq!(row["storageLocations"][2]["copyState"], "queued");
}
#[test]
fn a_default_export_does_not_invalidate_an_existing_vault_attachment_copy() {
    let c = database();
    let first = Vault::new();
    let second = Vault::new();
    for vault in [&first, &second] {
        register_root(&c, &vault.0).unwrap();
        fs::create_dir_all(vault.0.join("99_Meta/assets/X_assets")).unwrap();
    }
    let relative = "99_Meta/assets/X_assets/hashed-source.jpg";
    let original = first.0.join(relative);
    let copy = second.0.join(relative);
    fs::write(&original, b"image").unwrap();
    fs::write(&copy, b"image").unwrap();
    assert!(!saved_asset_at(&c, "one", &original, &second.0).unwrap());
    track_asset(&c, "one", &copy).unwrap();
    assert!(saved_asset_at(&c, "one", &original, &second.0).unwrap());
    fs::write(&copy, b"").unwrap();
    assert!(!saved_asset_at(&c, "one", &original, &second.0).unwrap());
}
#[test]
fn remote_save_revision_change_preserves_original_until_reconciled() {
    let c = database();
    seed(&c, "changing");
    c.execute("INSERT INTO collection_library_jobs(item_key,action,target,phase,plan) VALUES('changing','move','craft','cleanup',?1)", [json!({"revision":"test"}).to_string()]).unwrap();
    assert!(conversion::verify_source_revision(&c, "changing").is_ok());
    c.execute(
        "UPDATE collection_x_items SET content_hash='updated' WHERE item_key='changing'",
        [],
    )
    .unwrap();
    assert!(conversion::verify_source_revision(&c, "changing")
        .unwrap_err()
        .contains("已保留原副本"));
}
#[test]
fn batch_reference_scan_preserves_referenced_files_and_unknown_roots() {
    let vault = Vault::new();
    let relatives = vec![
        "99_Meta/assets/X_assets/first.jpg".to_string(),
        "99_Meta/assets/X_assets/second.jpg".to_string(),
        "99_Meta/assets/X_assets/unreferenced.jpg".to_string(),
    ];
    fs::write(
        vault.0.join("note.md"),
        format!("![]({})\n![[second.jpg]]", relatives[0]),
    )
    .unwrap();
    let references = referenced_assets(&vault.0, &relatives);
    assert_eq!(references.len(), 2);
    assert!(references.contains(&relatives[0]));
    assert!(references.contains(&relatives[1]));
    assert!(!references.contains(&relatives[2]));
    assert_eq!(
        referenced_assets(&vault.0.join("offline"), &relatives).len(),
        3
    );
}
#[test]
fn authorized_craft_and_reference_records_enter_automatic_saving() {
    let c = database();
    let reference = json!({"provider":"dida365","status":"planned","tasks":[{"kind":"reference"}]});
    let cases = [
        (
            "reference",
            "move",
            "needs_review",
            "",
            reference.to_string(),
        ),
        (
            "action",
            "move",
            "needs_review",
            "",
            json!({"provider":"dida365","status":"planned","tasks":[{"kind":"action"}]})
                .to_string(),
        ),
        (
            "craft",
            "move",
            "needs_review",
            "",
            json!({"provider":"craft","status":"planned","tasks":[{"kind":"reference"}]})
                .to_string(),
        ),
        (
            "blocked",
            "move",
            "needs_review",
            "",
            json!({"provider":"dida365","status":"needs_input","tasks":[]}).to_string(),
        ),
        (
            "craft-input",
            "move",
            "needs_review",
            "",
            json!({"provider":"craft","status":"needs_input"}).to_string(),
        ),
        (
            "craft-cancelled",
            "move",
            "cancelled",
            "",
            json!({"provider":"craft","status":"planned"}).to_string(),
        ),
        (
            "craft-unknown",
            "move",
            "unknown",
            "",
            json!({"provider":"craft","status":"planned"}).to_string(),
        ),
        (
            "craft-error",
            "move",
            "needs_review",
            "实际连接失败",
            json!({"provider":"craft","status":"planned"}).to_string(),
        ),
        ("malformed", "move", "needs_review", "", "not json".into()),
        ("partial", "move", "partial", "", reference.to_string()),
        ("cancelled", "move", "cancelled", "", reference.to_string()),
        ("unknown", "move", "unknown", "", reference.to_string()),
        (
            "failed",
            "move",
            "needs_review",
            "需要登录",
            reference.to_string(),
        ),
        (
            "delete",
            "delete",
            "needs_review",
            "",
            reference.to_string(),
        ),
    ];
    for (key, action, phase, error, plan) in &cases {
        c.execute("INSERT INTO collection_library_jobs(item_key,action,target,phase,error,plan) VALUES(?1,?2,'tasks',?3,?4,?5)",params![key,action,phase,error,plan]).unwrap();
    }
    assert_eq!(queue_automatic_saves(&c).unwrap(), 2);
    assert_eq!(queue_automatic_saves(&c).unwrap(), 0);
    for (key, _, phase, _, _) in &cases {
        let actual: String = c
            .query_row(
                "SELECT phase FROM collection_library_jobs WHERE item_key=?1",
                [key],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            actual,
            if matches!(*key, "reference" | "craft") {
                "ready"
            } else {
                phase
            }
        );
    }
}
#[test]
fn video_archive_upgrade_replans_only_unwritten_craft_records() {
    let c = database();
    let old_plan =
        json!({"provider":"craft","status":"needs_input","reason":"视频未读取"}).to_string();
    for (key, phase, error, plan) in [
        ("old-review", "needs_review", "", old_plan.clone()),
        ("old-ready", "ready", "", json!({"provider":"craft","status":"planned"}).to_string()),
        ("with-copy", "needs_review", "", old_plan.clone()),
        ("unknown", "unknown", "", old_plan.clone()),
        ("partial", "partial", "", old_plan.clone()),
        ("cancelled", "cancelled", "", old_plan.clone()),
        ("failed", "needs_review", "真实接口错误", old_plan.clone()),
        ("new-policy", "ready", "", json!({"provider":"craft","status":"planned","archivePolicyVersion":"video-upload-only-daily-v1"}).to_string()),
        ("dida", "needs_review", "", json!({"provider":"dida365","status":"needs_input"}).to_string()),
    ] {
        c.execute("INSERT INTO collection_library_jobs(item_key,action,target,phase,error,plan) VALUES(?1,'move','car',?2,?3,?4)", params![key,phase,error,plan]).unwrap();
    }
    c.execute("INSERT INTO collection_remote_copies(item_key,library_id,provider,object_id,parent_id) VALUES('with-copy','car','craft','owned-page','date:2026-10-06')", []).unwrap();
    assert_eq!(upgrade_unwritten_craft_plans(&c).unwrap(), 2);
    assert_eq!(upgrade_unwritten_craft_plans(&c).unwrap(), 0);
    for (key, phase) in [
        ("old-review", "queued"),
        ("old-ready", "queued"),
        ("with-copy", "needs_review"),
        ("unknown", "unknown"),
        ("partial", "partial"),
        ("cancelled", "cancelled"),
        ("failed", "needs_review"),
        ("new-policy", "ready"),
        ("dida", "needs_review"),
    ] {
        assert_eq!(
            c.query_row(
                "SELECT phase FROM collection_library_jobs WHERE item_key=?1",
                [key],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            phase
        );
    }
    assert_eq!(
        c.query_row(
            "SELECT object_id FROM collection_remote_copies WHERE item_key='with-copy'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "owned-page"
    );
}
fn configure_default(c: &Connection, mode: &str, path: &str) {
    meta(
        c,
        "collection_storage_v1",
        &json!({"mode":mode,"vaultPath":path,"downloadMedia":true,"autoSyncMinutes":30})
            .to_string(),
    )
    .unwrap();
}
#[test]
fn unregistered_default_obsidian_is_described_without_a_false_hub_or_library_icon() {
    let c = database();
    seed(&c, "one");
    configure_default(&c, "obsidian", "D:\\Notes\\ZhiHu");
    let mut row = json!({});
    decorate(&c, "one", &mut row).unwrap();
    assert!(row["destinationId"].is_null());
    assert_eq!(row["storageLocation"]["kind"], "obsidian");
    assert_eq!(row["storageLocation"]["name"], "ZhiHu");
    assert_eq!(row["storageLocation"]["path"], "D:\\Notes\\ZhiHu");
    assert_eq!(row["storageLocation"]["isDefault"], true);
}
#[test]
fn explicit_hub_and_saved_vault_remain_correct_after_the_default_changes() {
    let c = database();
    seed(&c, "one");
    let vault = Vault::new();
    let hash = register_root(&c, &vault.0).unwrap();
    c.execute(
        "INSERT INTO collection_obsidian_exports(destination,item_key,relative_path,file_hash,input_hash,media_pending) VALUES(?1,'one','note.md','hash','input',0)",
        [&hash],
    )
    .unwrap();
    configure_default(&c, "database", "");
    let mut row = json!({});
    decorate(&c, "one", &mut row).unwrap();
    assert_eq!(row["storageLocation"]["kind"], "obsidian");
    assert_eq!(row["storageLocation"]["isDefault"], false);
    assert!(row["destinationId"].is_null());
    c.execute(
        "INSERT INTO collection_lifecycle(item_key,destination) VALUES('one','hub')",
        [],
    )
    .unwrap();
    configure_default(&c, "obsidian", "D:\\Notes\\OtherVault");
    decorate(&c, "one", &mut row).unwrap();
    assert_eq!(row["storageLocation"]["kind"], "hub");
    assert_eq!(row["storageLocation"]["isDefault"], false);
    c.execute(
        "UPDATE collection_lifecycle SET destination=?1 WHERE item_key='one'",
        [format!("vault:{hash}")],
    )
    .unwrap();
    decorate(&c, "one", &mut row).unwrap();
    assert_eq!(
        row["storageLocation"]["path"],
        vault.0.to_string_lossy().as_ref()
    );
}
#[test]
fn default_obsidian_selection_resolves_to_the_same_vault_then_its_registered_library() {
    let c = database();
    let vault = Vault::new();
    configure_default(&c, "obsidian", &vault.0.to_string_lossy());
    let target = resolve_move_target(&c, "default").unwrap();
    assert!(target.starts_with("vault:"));
    let effective = target_config(&c, &target, &storage::config(&c).unwrap()).unwrap();
    assert_eq!(effective.mode, "obsidian");
    assert_eq!(fs::canonicalize(effective.vault_path).unwrap(), vault.0);
    c.execute_batch(
        "CREATE TABLE libraries(id TEXT,provider TEXT,enabled INTEGER,location TEXT,name TEXT)",
    )
    .unwrap();
    let alias = format!(
        "{}/",
        vault
            .0
            .to_string_lossy()
            .replace('\\', "/")
            .replace("//?/", "")
            .to_uppercase()
    );
    c.execute(
        "INSERT INTO libraries VALUES('main','obsidian',1,?1,'Main')",
        [alias],
    )
    .unwrap();
    assert_eq!(resolve_move_target(&c, "default").unwrap(), "main");
    let row = storage_location(&c, "one", Some(&target), true).unwrap();
    assert_eq!(row["libraryId"], "main");
    assert_eq!(row["name"], "Main");
    configure_default(&c, "database", "");
    assert_eq!(resolve_move_target(&c, "default").unwrap(), "hub");
    assert_eq!(resolve_move_target(&c, "main").unwrap(), "main");
}
#[test]
fn only_actual_attachment_auth_failures_expose_the_login_action() {
    let mut authentication = json!({"error":"DIDA_ATTACHMENT_LOGIN_REQUIRED:滴答会话已失效"});
    operation_error(&mut authentication);
    assert_eq!(authentication["attachmentLoginRequired"], true);
    assert_eq!(authentication["error"], "滴答会话已失效");
    for error in [
        "",
        "附件超限",
        "滴答附件会话检查失败（HTTP 503），请稍后重试",
    ] {
        let mut other = json!({"error":error});
        operation_error(&mut other);
        assert_eq!(other["attachmentLoginRequired"], false);
        assert_eq!(other["error"], error);
    }
}
fn count(c: &Connection, status: &str) -> (i64, i64, i64) {
    let (a, b, m, _) = query_collection_items(
        c,
        "".into(),
        false,
        0,
        Some("all".into()),
        Some(status.into()),
        None,
        None,
        None,
        None,
    )
    .unwrap();
    (a, b, m)
}
#[test]
fn archive_is_separate_and_preserves_reading_status() {
    let c = database();
    seed(&c, "one");
    seed(&c, "two");
    c.execute(
        "INSERT INTO collection_x_properties VALUES('one','in_progress','[\"a\"]')",
        [],
    )
    .unwrap();
    c.execute(
        "INSERT INTO collection_lifecycle(item_key,state) VALUES('one','archived')",
        [],
    )
    .unwrap();
    assert_eq!(count(&c, "all"), (1, 1, 1));
    assert_eq!(count(&c, "archived"), (1, 1, 1));
    assert_eq!(
        properties::load(&c, "one", false).unwrap(),
        ("in_progress".into(), vec!["a".into()])
    );
    c.execute(
        "UPDATE collection_lifecycle SET state='active' WHERE item_key='one'",
        [],
    )
    .unwrap();
    assert_eq!(count(&c, "all").0, 2);
}
#[test]
fn a_deleted_x_item_cannot_be_resurrected_by_import() {
    let mut c = database();
    c.execute(
        "INSERT INTO collection_lifecycle(item_key,state) VALUES('x:123:123','deleted')",
        [],
    )
    .unwrap();
    let page = parse_page(&super::super::tests::response(vec![
        super::super::tests::entry(super::super::tests::tweet("123")),
    ]))
    .unwrap();
    assert_eq!(persist_page(&mut c, "123", &page, 1).unwrap(), 0);
    assert_eq!(count(&c, "all").0, 0);
}
#[test]
fn deleting_is_hidden_before_cleanup_finishes() {
    let c = database();
    seed(&c, "one");
    c.execute(
        "INSERT INTO collection_lifecycle(item_key,state) VALUES('one','deleting')",
        [],
    )
    .unwrap();
    assert!(blocked(&c, "one").unwrap());
    assert_eq!(count(&c, "all"), (0, 0, 0));
}
#[test]
fn cleanup_rejects_paths_outside_the_vault() {
    let vault = Vault::new();
    for path in [
        "../other.md",
        "/outside.md",
        "C:/outside.md",
        "folder\\outside.md",
    ] {
        assert!(owned_path(&vault.0, path).is_err());
    }
    let missing = owned_path(&vault.0, "missing/file.md").unwrap();
    assert!(!missing.parent().unwrap().exists());
}
#[test]
fn deletion_cleans_owned_note_but_keeps_shared_assets() {
    let c = database();
    let vault = Vault::new();
    let root = &vault.0;
    fs::create_dir_all(root.join("99_Meta/assets/X_assets")).unwrap();
    fs::write(root.join("own.md"), "note").unwrap();
    let asset = root.join("99_Meta/assets/X_assets/shared.jpg");
    fs::write(&asset, b"image").unwrap();
    let destination = register_root(&c, root).unwrap();
    c.execute(
        "INSERT INTO collection_obsidian_exports(destination,item_key,relative_path,file_hash,input_hash,media_pending) VALUES(?1,'one','own.md','hash','input',0)",
        [destination],
    )
    .unwrap();
    track_asset(&c, "one", &asset).unwrap();
    track_asset(&c, "two", &asset).unwrap();
    c.execute(
        "INSERT INTO collection_lifecycle(item_key,state) VALUES('one','deleting')",
        [],
    )
    .unwrap();
    cleanup_notes(&c, "one", None).unwrap();
    cleanup_assets(&c, "one", None).unwrap();
    assert!(!root.join("own.md").exists());
    assert!(asset.exists());
    cleanup_assets(&c, "two", None).unwrap();
    assert!(!asset.exists());
}
#[test]
fn references_in_other_notes_protect_the_last_owned_attachment() {
    let c = database();
    let vault = Vault::new();
    fs::create_dir_all(vault.0.join("99_Meta/assets/X_assets")).unwrap();
    let path = vault.0.join("99_Meta/assets/X_assets/shared.jpg");
    fs::write(&path, b"image").unwrap();
    fs::write(vault.0.join("reference.md"), "![[shared.jpg]]").unwrap();
    register_root(&c, &vault.0).unwrap();
    track_asset(&c, "one", &path).unwrap();
    cleanup_assets(&c, "one", None).unwrap();
    assert!(path.exists());
}
#[test]
fn migration_preserves_old_manual_edits_and_the_new_copy() {
    let c = database();
    let old = Vault::new();
    let new = Vault::new();
    fs::write(old.0.join("note.md"), "user edit").unwrap();
    fs::write(new.0.join("note.md"), "new copy").unwrap();
    let from = register_root(&c, &old.0).unwrap();
    let to = register_root(&c, &new.0).unwrap();
    c.execute(
        "INSERT INTO collection_obsidian_exports(destination,item_key,relative_path,file_hash,input_hash,media_pending) VALUES(?1,'one','note.md',?2,'input',0)",
        params![from, storage::hash(b"original")],
    )
    .unwrap();
    c.execute(
        "INSERT INTO collection_obsidian_exports(destination,item_key,relative_path,file_hash,input_hash,media_pending) VALUES(?1,'one','note.md',?2,'input',0)",
        params![to, storage::hash(b"new copy")],
    )
    .unwrap();
    assert!(cleanup_notes(&c, "one", Some(&to)).is_err());
    assert!(old.0.join("note.md").exists());
    assert!(new.0.join("note.md").exists());
}
#[test]
fn message_tombstones_survive_payload_cleanup() {
    let c = database();
    c.execute_batch("CREATE TABLE collection_telegram_messages(bot_id INTEGER,chat_id INTEGER,message_id INTEGER,item_key TEXT,message_json TEXT);INSERT INTO collection_telegram_messages VALUES(1,2,3,'one','private payload');").unwrap();
    remember_messages(&c, "one").unwrap();
    c.execute("DELETE FROM collection_telegram_messages", [])
        .unwrap();
    assert!(blocked_message(&c, 1, 2, 3, "bot").unwrap());
    assert!(!blocked_message(&c, 1, 2, 4, "bot").unwrap());
}
#[test]
fn additional_copies_do_not_override_the_local_default() {
    let c = database();
    seed(&c, "one");
    pin_defaults(&c, &storage::StorageConfig::default()).unwrap();
    let mut base = storage::StorageConfig::default();
    base.mode = "obsidian".into();
    base.vault_path = "new location".into();
    assert_eq!(effective_config(&c, "one", &base).unwrap().mode, "obsidian");
}

#[test]
fn incomplete_target_assets_prevent_migration_cleanup() {
    let c = database();
    let old = Vault::new();
    let new = Vault::new();
    let mut post = Post::default();
    post.media.push(Media {
        kind: "photo".into(),
        url: "https://example.com/image.jpg".into(),
        preview_url: String::new(),
    });
    let old_asset = old.0.join("image.jpg");
    fs::write(&old_asset, b"image").unwrap();
    c.execute(
        "INSERT INTO collection_saved_media(item_key,media_url,path) VALUES('one',?1,?2)",
        params![post.media[0].url, old_asset.to_string_lossy()],
    )
    .unwrap();
    assert!(verify_assets(&c, "one", &post, &new.0).is_err());
    assert!(old_asset.exists());
    let new_asset = new.0.join("image.jpg");
    fs::write(&new_asset, b"image").unwrap();
    c.execute(
        "UPDATE collection_saved_media SET path=?1",
        [new_asset.to_string_lossy()],
    )
    .unwrap();
    assert!(verify_assets(&c, "one", &post, &new.0).is_ok());
    fs::write(&new_asset, b"").unwrap();
    assert!(verify_assets(&c, "one", &post, &new.0).is_err());
}

#[test]
fn adding_an_existing_vault_to_libraries_exposes_its_icon_and_name() {
    let c = database();
    let vault = Vault::new();
    seed(&c, "one");
    let hash = register_root(&c, &vault.0).unwrap();
    c.execute(
        "INSERT INTO collection_obsidian_exports(destination,item_key,relative_path,file_hash,input_hash,media_pending) VALUES(?1,'one','note.md','hash','input',0)",
        [hash],
    )
    .unwrap();
    record_saved(&c, "one", &vault.0).unwrap();
    let mut value = json!({});
    decorate(&c, "one", &mut value).unwrap();
    assert!(value["destinationId"].is_null());
    c.execute_batch(
        "CREATE TABLE libraries(id TEXT,provider TEXT,enabled INTEGER,location TEXT,name TEXT)",
    )
    .unwrap();
    c.execute(
        "INSERT INTO libraries VALUES('library','obsidian',1,?1,'资料库')",
        [vault
            .0
            .to_string_lossy()
            .replace(char::from(92), "/")
            .to_uppercase()],
    )
    .unwrap();
    refresh_names(&c).unwrap();
    decorate(&c, "one", &mut value).unwrap();
    assert_eq!(value["destinationId"], "library");
    let name: String = c
        .query_row(
            "SELECT destination_name FROM collection_lifecycle WHERE item_key='one'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(name, "资料库");
    c.execute("UPDATE collection_lifecycle SET destination='hub'", [])
        .unwrap();
    refresh_names(&c).unwrap();
    decorate(&c, "one", &mut value).unwrap();
    assert!(value["destinationId"].is_null());
}

#[test]
fn message_tombstone_schema_upgrade_keeps_existing_deletions() {
    let c = database();
    c.execute_batch("DROP TABLE collection_message_tombstones; CREATE TABLE collection_message_tombstones(bot_id INTEGER,user_id INTEGER,message_id INTEGER,channel TEXT,item_key TEXT,PRIMARY KEY(bot_id,user_id,message_id,channel)); INSERT INTO collection_message_tombstones VALUES(1,2,3,'bot','deleted');").unwrap();
    schema(&c).unwrap();
    assert!(blocked_message(&c, 1, 2, 3, "bot").unwrap());
    let fingerprint: String = c
        .query_row(
            "SELECT fingerprint FROM collection_message_tombstones",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(fingerprint.is_empty());
}
