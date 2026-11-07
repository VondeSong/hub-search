use super::*;
use crate::flashcard_store::flashcard_by_id;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "hub-backup-test-{:016x}",
            rand::thread_rng().next_u64()
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn database(&self) -> Connection {
        open_database(&self.0.join("craft-search.sqlite3")).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn rate(c: &Connection, rating: i64, at: i64) -> String {
    let preview =
        serde_json::to_value(flashcard_scheduler::preview(c, "card-backup", at).unwrap()).unwrap();
    flashcard_scheduler::commit(
        c,
        "card-backup",
        rating,
        Some(250),
        preview["reviewKey"].as_str().unwrap(),
        at,
    )
    .unwrap()
    .review_id
}

fn seed(f: &Fixture) -> Connection {
    let c = f.database();
    c.execute_batch("INSERT INTO flashcard_decks(id,name,created_at,updated_at) VALUES('deck-backup','恢复验收',10,10);
        INSERT INTO flashcards(id,deck_id,question,answer,media_json,status,created_at,updated_at,due_at)
        VALUES('card-backup','deck-backup','离线保存？','先保存事件，再重算状态','[]','active',10,10,10);
        INSERT INTO metadata(key,value) VALUES('flashcard_daily_new_limit','20'),('flashcard_daily_new_limit_updated_at','100');").unwrap();
    let media = flashcard_attachments::store(
        &f.0,
        "验证附件.txt",
        "text/plain",
        "可恢复的附件原始字节".as_bytes(),
        "answer",
    )
    .unwrap();
    c.execute(
        "UPDATE flashcards SET media_json=?1 WHERE id='card-backup'",
        [serde_json::to_string(&vec![media]).unwrap()],
    )
    .unwrap();
    let mut profile = flashcard_profiles::default_profile();
    profile.desired_retention = 0.85;
    profile.id = profile.content_id().unwrap();
    flashcard_profiles::merge(&c, &[profile]).unwrap();
    rate(&c, 3, 1000);
    let undone = rate(&c, 2, 2000);
    flashcard_scheduler::restore(&c, &undone, 2010).unwrap();
    c
}

fn state(c: &Connection) -> Value {
    let s = local_flashcard_snapshot(c).unwrap();
    json!({"cards":s.cards,"reviews":s.reviews,"profiles":s.scheduler_profiles,"tombstones":s.tombstones,"settings":s.study_settings,"drafts":s.drafts,"quality":s.quality_records})
}

#[test]
fn hierarchy_archive_restores_parent_edges_and_child_review_history() {
    let source = Fixture::new();
    let mut c = seed(&source);
    let parent =
        crate::flashcard_decks::create_flashcard_deck_in_connection(&mut c, "Parent backup")
            .unwrap();
    crate::flashcard_decks::set_parent(&mut c, "deck-backup", &parent).unwrap();
    let expected = state(&c);
    let archive = create(&mut c, &source.0, "hierarchy").unwrap();
    let target = Fixture::new();
    let mut destination = target.database();
    restore(
        &mut destination,
        &target.0,
        Path::new(&archive.path),
        &archive.checksum,
    )
    .unwrap();
    assert_eq!(
        destination
            .query_row(
                "SELECT parent_deck_id FROM flashcard_decks WHERE id='deck-backup'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        parent
    );
    assert_eq!(state(&destination), expected);
    assert_eq!(local_flashcard_snapshot(&destination).unwrap().version, 5);
}

#[test]
fn archive_restores_attachments_events_parameters_after_restart_and_can_review_and_undo() {
    let source = Fixture::new();
    let mut c = seed(&source);
    let expected = state(&c);
    let backup = create(&mut c, &source.0, "backup").unwrap();
    assert_eq!(
        (
            backup.cards,
            backup.reviews,
            backup.attachments,
            backup.profiles
        ),
        (1, 2, 1, 2)
    );
    let target = Fixture::new();
    let mut restored = target.database();
    let result = restore(
        &mut restored,
        &target.0,
        Path::new(&backup.path),
        &backup.checksum,
    )
    .unwrap();
    assert!(Path::new(result["safetyBackup"]["path"].as_str().unwrap()).exists());
    assert_eq!(state(&restored), expected);
    let (hashes, _) = references(&local_flashcard_snapshot(&restored).unwrap()).unwrap();
    for hash in hashes {
        assert_eq!(
            BlobStore::open(&target.0.join("blobs-v1"))
                .unwrap()
                .read(&hash)
                .unwrap(),
            "可恢复的附件原始字节".as_bytes()
        );
    }
    drop(restored);
    restored = target.database();
    assert_eq!(state(&restored), expected);
    let event = rate(&restored, 4, 5000);
    let newer = state(&restored);
    restore(
        &mut restored,
        &target.0,
        Path::new(&backup.path),
        &backup.checksum,
    )
    .unwrap();
    assert_eq!(
        state(&restored),
        newer,
        "Old backup must never erase newer events"
    );
    flashcard_scheduler::restore(&restored, &event, 5010).unwrap();
    assert_eq!(
        local_flashcard_snapshot(&restored).unwrap().reviews.len(),
        3
    );
    assert_eq!(
        flashcard_by_id(&restored, "card-backup").unwrap().due_at,
        expected["cards"][0]["dueAt"].as_i64().unwrap()
    );
}

#[test]
fn corrupt_truncated_changed_and_missing_attachments_are_rejected_without_database_changes() {
    let source = Fixture::new();
    let mut c = seed(&source);
    let backup = create(&mut c, &source.0, "backup").unwrap();
    let target = Fixture::new();
    let mut dst = seed(&target);
    let before = state(&dst);
    let bytes = fs::read(&backup.path).unwrap();
    for damaged in [
        bytes[..bytes.len() - 1].to_vec(),
        {
            let mut b = bytes.clone();
            let n = b.len() - 1;
            b[n] ^= 1;
            b
        },
        {
            let mut b = bytes.clone();
            b[50] ^= 1;
            b
        },
    ] {
        let path = target.0.join("damaged.hubfc");
        fs::write(&path, damaged).unwrap();
        assert!(restore(&mut dst, &target.0, &path, &backup.checksum).is_err());
        assert_eq!(state(&dst), before);
    }
    assert!(restore(
        &mut dst,
        &target.0,
        Path::new(&backup.path),
        "wrong-preview-checksum"
    )
    .is_err());
    let (hashes, _) = references(&local_flashcard_snapshot(&c).unwrap()).unwrap();
    let blob = BlobStore::open(&source.0.join("blobs-v1"))
        .unwrap()
        .path_for(hashes.first().unwrap())
        .unwrap();
    fs::remove_file(blob).unwrap();
    assert!(create(&mut c, &source.0, "missing")
        .unwrap_err()
        .contains("尚未下载"));
    assert_eq!(state(&dst), before);
}

#[test]
fn semantic_merge_failure_rolls_back_and_keeps_a_recoverable_safety_backup() {
    let source = Fixture::new();
    let mut c = seed(&source);
    let backup = create(&mut c, &source.0, "backup").unwrap();
    let target = Fixture::new();
    let mut dst = target.database();
    // Force an actual storage failure after profile/deck insertion, not a mock merge.
    dst.execute_batch("CREATE TRIGGER reject_test_card BEFORE INSERT ON flashcards BEGIN SELECT RAISE(ABORT,'test write failure'); END;").unwrap();
    let before = state(&dst);
    assert!(restore(
        &mut dst,
        &target.0,
        Path::new(&backup.path),
        &backup.checksum
    )
    .is_err());
    assert_eq!(state(&dst), before);
    let paths: Vec<_> = fs::read_dir(target.0.join("flashcard-backups"))
        .unwrap()
        .map(|p| p.unwrap().path())
        .collect();
    assert_eq!(paths.len(), 1);
    inspect(&mut fs::File::open(&paths[0]).unwrap()).unwrap();
}

#[test]
fn unsupported_algorithm_and_incomplete_manifest_fail_before_restore() {
    let source = Fixture::new();
    let mut c = seed(&source);
    let backup = create(&mut c, &source.0, "backup").unwrap();
    let mut archive = inspect(&mut fs::File::open(&backup.path).unwrap()).unwrap();
    archive.manifest.snapshot.scheduler_profiles[0].engine_version = "future/unknown".into();
    assert!(flashcard_scheduler::validate_snapshot(&archive.manifest.snapshot).is_err());
    archive.manifest.snapshot.scheduler_profiles = flashcard_profiles::snapshot(&c).unwrap();
    archive.manifest.attachments.clear();
    let json = serde_json::to_vec(&archive.manifest).unwrap();
    let path = source.0.join("incomplete.hubfc");
    let mut f = fs::File::create(&path).unwrap();
    f.write_all(MAGIC).unwrap();
    f.write_all(&(json.len() as u64).to_le_bytes()).unwrap();
    f.write_all(&Sha256::digest(&json)).unwrap();
    f.write_all(&json).unwrap();
    drop(f);
    assert!(inspect(&mut fs::File::open(path).unwrap()).is_err());
}

#[test]
fn damaged_history_is_isolated_and_valid_archives_remain_selectable() {
    let root = Fixture::new();
    let mut c = seed(&root);
    let good = create(&mut c, &root.0, "good").unwrap();
    let bad = root.0.join("flashcard-backups/damaged.hubfc");
    fs::write(&bad, b"truncated archive").unwrap();
    let history = list_history(&root.0).unwrap();
    assert_eq!(history.items.len(), 1);
    assert_eq!(history.items[0].path, good.path);
    assert_eq!(history.issues.len(), 1);
    assert_eq!(PathBuf::from(&history.issues[0].path), bad);
    assert!(bad.exists());
}

#[test]
fn backup_io_releases_writer_and_retains_snapshot_and_open_media_after_unlink() {
    let root = Fixture::new();
    let c = seed(&root);
    let expected = state(&c);
    let hashes = references(&local_flashcard_snapshot(&c).unwrap())
        .unwrap()
        .0;
    let blob = BlobStore::open(&root.0.join("blobs-v1"))
        .unwrap()
        .path_for(hashes.first().unwrap())
        .unwrap();
    drop(c);
    let database = root.0.join("craft-search.sqlite3");
    let backup = create_database_after_snapshot(&database, &root.0, "unlinked", || {
        // This must acquire the same formal writer admission while backup IO is pending.
        let (c, _writer) = open_write_database(&database).unwrap();
        rate(&c, 4, 5000);
        fs::remove_file(&blob).unwrap();
    })
    .unwrap();
    let archive = inspect(&mut fs::File::open(&backup.path).unwrap()).unwrap();
    let imported = Fixture::new();
    let mut dst = imported.database();
    merge_flashcard_snapshot(&mut dst, &archive.manifest.snapshot).unwrap();
    assert_eq!(state(&dst), expected);
    assert_eq!(archive.manifest.snapshot.reviews.len(), 2);
    assert_eq!(
        local_flashcard_snapshot(&open_database(&database).unwrap())
            .unwrap()
            .reviews
            .len(),
        3
    );
}

#[test]
fn restore_detects_writes_during_safety_archive_io_and_keeps_new_review() {
    let source = Fixture::new();
    let mut c = seed(&source);
    let backup = create(&mut c, &source.0, "backup").unwrap();
    let target = Fixture::new();
    let mut dst = seed(&target);
    let database = target.0.join("craft-search.sqlite3");
    let error = restore_after_safety(
        &mut dst,
        &target.0,
        Path::new(&backup.path),
        &backup.checksum,
        || {
            let (c, _writer) = open_write_database(&database).unwrap();
            rate(&c, 4, 5000);
        },
    )
    .unwrap_err();
    assert!(error.contains("本机闪卡发生变化"));
    assert_eq!(local_flashcard_snapshot(&dst).unwrap().reviews.len(), 3);
    assert_eq!(list_history(&target.0).unwrap().items.len(), 1);
}

#[test]
fn cancellation_after_snapshot_releases_writer_and_publishes_no_archive() {
    let root = Fixture::new();
    let c = seed(&root);
    let before = state(&c);
    drop(c);
    let database = root.0.join("craft-search.sqlite3");
    let operation = operation::begin(&root.0, "cancel-backup-snapshot").unwrap();
    let error = operation
        .run(|| {
            create_database_after_snapshot(&database, &root.0, "cancelled", || {
                let (_connection, _writer) = open_write_database(&database).unwrap();
                assert!(operation::cancel(&root.0, "cancel-backup-snapshot").unwrap());
            })
        })
        .unwrap_err();
    assert!(error.starts_with("BACKUP_CANCELLED:"));
    assert_eq!(state(&root.database()), before);
    assert!(!root.0.join("flashcard-backups").exists());
    assert!(!operation::cancel(&root.0, "cancel-backup-snapshot").unwrap());
    operation::begin(&root.0, "cancel-backup-snapshot")
        .unwrap()
        .run(|| Ok(()))
        .unwrap();
}

#[test]
fn cancellation_during_streaming_stops_before_the_next_output_chunk_and_is_root_scoped() {
    struct CancellingRead<'a> {
        root: &'a Path,
        reads: usize,
    }
    impl Read for CancellingRead<'_> {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            self.reads += 1;
            if self.reads == 2 {
                assert!(operation::cancel(self.root, "cancel-stream").unwrap());
            }
            buffer.fill(17);
            Ok(buffer.len())
        }
    }
    let root = Fixture::new();
    let other = Fixture::new();
    let operation = operation::begin(&root.0, "cancel-stream").unwrap();
    assert!(!operation::cancel(&other.0, "cancel-stream").unwrap());
    let mut reader = CancellingRead {
        root: &root.0,
        reads: 0,
    };
    let path = root.0.join("owned-output.partial");
    let mut output = fs::File::create(&path).unwrap();
    let error = operation
        .run(|| digest_reader(&mut reader, MAX_ARCHIVE, Some(&mut output)))
        .unwrap_err();
    assert!(error.starts_with("BACKUP_CANCELLED:"));
    assert_eq!(reader.reads, 2);
    assert_eq!(output.metadata().unwrap().len(), 64 * 1024);
}

#[test]
fn cancellation_after_recovery_safety_snapshot_keeps_original_database_and_valid_safety_file() {
    let source = Fixture::new();
    let mut c = seed(&source);
    let backup = create(&mut c, &source.0, "backup").unwrap();
    let target = Fixture::new();
    let mut dst = target.database();
    let before = state(&dst);
    let operation = operation::begin(&target.0, "cancel-recovery").unwrap();
    let error = operation
        .run(|| {
            restore_after_safety(
                &mut dst,
                &target.0,
                Path::new(&backup.path),
                &backup.checksum,
                || {
                    assert!(operation::cancel(&target.0, "cancel-recovery").unwrap());
                },
            )
        })
        .unwrap_err();
    assert!(error.starts_with("BACKUP_CANCELLED:"));
    assert_eq!(state(&dst), before);
    let history = list_history(&target.0).unwrap();
    assert_eq!(history.items.len(), 1);
    assert!(Path::new(&history.items[0].path)
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("before-restore-"));
    assert!(history.issues.is_empty());
}

/// Run only with an explicitly prepared private copy, never the live database.
#[test]
#[ignore]
fn real_database_copy_roundtrip() {
    let root =
        PathBuf::from(std::env::var("HUB_BACKUP_ACCEPTANCE_ROOT").expect("isolated copy required"));
    assert!(root.join("ISOLATED_BACKUP_TEST").is_file());
    let mut source = open_database(&root.join("craft-search.sqlite3")).unwrap();
    let backup = create(&mut source, &root, "backup").unwrap();
    let expected = state(&source);
    let target = root.join("restored");
    fs::create_dir_all(&target).unwrap();
    let database = target.join("craft-search.sqlite3");
    assert!(!database.exists());
    let mut dst = open_database(&database).unwrap();
    restore(&mut dst, &target, Path::new(&backup.path), &backup.checksum).unwrap();
    drop(dst);
    let mut dst = open_database(&database).unwrap();
    assert!(
        state(&dst) == expected,
        "Restored private database state differs; inspect locally without logging card content"
    );
    restore(&mut dst, &target, Path::new(&backup.path), &backup.checksum).unwrap();
    assert!(
        state(&dst) == expected,
        "Repeated private restore changed state"
    );
    for hash in references(&local_flashcard_snapshot(&dst).unwrap())
        .unwrap()
        .0
    {
        let a = BlobStore::open(&root.join("blobs-v1"))
            .unwrap()
            .read(&hash)
            .unwrap();
        let b = BlobStore::open(&target.join("blobs-v1"))
            .unwrap()
            .read(&hash)
            .unwrap();
        assert!(a == b, "Restored attachment bytes differ");
    }
    println!("Restored and reopened: {} cards, {} immutable events, {} attachments, {} profiles; repeat restore preserved state.",backup.cards,backup.reviews,backup.attachments,backup.profiles);
}
