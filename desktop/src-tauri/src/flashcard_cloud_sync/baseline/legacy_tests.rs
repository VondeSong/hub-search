use super::*;
use crate::flashcard_authoring::{import_flashcard_values, resolve_flashcard_drafts_in_connection};
use crate::*;

fn fixture(label: &str) -> (std::path::PathBuf, Connection) {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../task-state/project-optimization-20261011/legacy-baseline-tests")
        .join(format!("{label}-{}", random_url_safe(8)));
    fs::create_dir_all(&root).unwrap();
    let db = root.join("craft-search.sqlite3");
    let c = open_database(&db).unwrap();
    super::super::ensure_journal(&c).unwrap();
    (db, c)
}
fn populated() -> Value {
    let (db, _) = fixture("source");
    import_flashcard_values(
        &db,
        "manual",
        "基线".into(),
        json!({"source":"manual"}),
        vec![
            json!({"question":"问题","answer":"答案"}),
            json!({"question":"收件箱","answer":"保留"}),
        ],
        true,
    )
    .unwrap();
    let mut c = open_database(&db).unwrap();
    let pending = local_flashcard_snapshot(&c).unwrap();
    let id = flashcard_sync_drafts::identity(&pending.drafts[0]).to_owned();
    let deck = ensure_flashcard_deck(&c, "基线").unwrap();
    resolve_flashcard_drafts_in_connection(&mut c, vec![id], true, Some(deck)).unwrap();
    c.execute_batch("INSERT INTO flashcard_deck_folders(id,name,sort_order,created_at,updated_at) VALUES('folder','文件夹',1,10,20);INSERT INTO metadata(key,value) VALUES('flashcard_daily_new_limit','20'),('flashcard_daily_new_limit_updated_at','50') ON CONFLICT(key) DO UPDATE SET value=excluded.value;").unwrap();
    record_flashcard_tombstone(&c, "card", "removed", 30).unwrap();
    flashcard_quality::merge(
        &c,
        &[json!({"id":"feedback","kind":"feedback","updatedAt":40,"snapshot":{"media":[]}})],
    )
    .unwrap();
    let card = local_flashcard_snapshot(&c).unwrap().cards[0].id.clone();
    let preview =
        serde_json::to_value(flashcard_scheduler::preview(&c, &card, 1000).unwrap()).unwrap();
    flashcard_scheduler::commit(
        &c,
        &card,
        3,
        Some(1000),
        preview["reviewKey"].as_str().unwrap(),
        1000,
    )
    .unwrap();
    serde_json::to_value(local_flashcard_snapshot(&c).unwrap()).unwrap()
}
fn rows(c: &Connection, ns: &str) -> Vec<(String, String, String)> {
    let mut q=c.prepare("SELECT field,identity,payload FROM flashcard_cloud_resource_records WHERE namespace=?1 ORDER BY field,identity").unwrap();
    let items = q
        .query_map([ns], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap();
    items.collect::<Result<_, _>>().unwrap()
}
fn put(c: &Connection, ns: &str, raw: &str, upload: bool) {
    if upload {
        c.execute("INSERT INTO flashcard_cloud_uploads(namespace,id,body,baseline,status) VALUES(?1,'legacy-upload',X'00',?2,'pending')",params![ns,raw]).unwrap();
    } else {
        c.execute(
            "INSERT INTO flashcard_cloud_baselines(namespace,payload) VALUES(?1,?2)",
            params![ns, raw],
        )
        .unwrap();
    }
}

#[test]
fn legacy_baseline_single_pass_matches_released_parser_for_eight_domains_defaults_and_duplicates() {
    let full = populated();
    let (mut drafts, mut minimal) = (full.clone(), full.clone());
    drafts["qualityRecords"] = json!([null,true,7,"任意旧质量JSON",{"id":"same","text":"first"},{"id":"same","text":"last"}]);
    minimal["version"] = json!(67);
    for field in [
        "folders",
        "drafts",
        "qualityRecords",
        "schedulerProfiles",
        "tombstones",
        "studySettings",
    ] {
        minimal.as_object_mut().unwrap().remove(field);
    }
    let mut duplicate = serde_json::to_string(&full).unwrap();
    duplicate.pop();
    duplicate.push_str(",\"cards\":[1],\"version\":\"bad later member\",\"studySettings\":\"bad later member\",\"unknown\":{\"body\":[1,2,3]}}");
    for (n, raw) in [
        serde_json::to_string(&full).unwrap(),
        serde_json::to_string(&drafts).unwrap(),
        serde_json::to_string(&minimal).unwrap(),
        duplicate,
    ]
    .into_iter()
    .enumerate()
    {
        for upload in [false, true] {
            let ns = format!("case-{n}-{upload}");
            let (_, reference) = fixture("reference");
            let (_, stream) = fixture("stream");
            put(&reference, &ns, &raw, upload);
            put(&stream, &ns, &raw, upload);
            let id = upload.then_some("legacy-upload");
            let old = atomic(&reference, "released_parser", || {
                import_legacy_reference(&reference, &ns, id)
            });
            let new = import_legacy(&stream, &ns, id);
            assert_eq!(new.is_ok(), old.is_ok(), "{ns}");
            assert_eq!(new.unwrap(), old.unwrap());
            assert_eq!(rows(&stream, &ns), rows(&reference, &ns));
        }
    }
}

#[test]
fn legacy_baseline_stream_preserves_prior_ack_and_pending_bytes_on_late_failure() {
    let base = populated();
    let mut late = base.clone();
    late["cards"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"bad-last-card"}));
    for (label, raw, reject) in [
        (
            "bad-tail",
            format!("{}x", serde_json::to_string(&base).unwrap()),
            false,
        ),
        (
            "normalize-late",
            serde_json::to_string(&late).unwrap(),
            false,
        ),
        ("ack-fault", serde_json::to_string(&base).unwrap(), true),
    ] {
        let (_, c) = fixture(label);
        let ns = label;
        let original = serde_json::to_string(&base).unwrap();
        put(&c, ns, &original, false);
        namespace(&c, ns).unwrap();
        let before = rows(&c, ns);
        let cutoff: i64 = c
            .query_row(
                "SELECT cutoff FROM flashcard_cloud_resource_baselines WHERE namespace=?1",
                [ns],
                |r| r.get(0),
            )
            .unwrap();
        put(&c, ns, &raw, true);
        if reject {
            c.execute_batch("CREATE TRIGGER reject_legacy_ack BEFORE INSERT ON flashcard_cloud_resource_records BEGIN SELECT RAISE(ABORT,'injected acknowledgment failure'); END;").unwrap();
        }
        assert!(import_legacy(&c, ns, Some("legacy-upload")).is_err());
        assert_eq!(rows(&c, ns), before);
        assert_eq!(
            c.query_row(
                "SELECT cutoff FROM flashcard_cloud_resource_baselines WHERE namespace=?1",
                [ns],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            cutoff
        );
        assert_eq!(
            c.query_row(
                "SELECT baseline FROM flashcard_cloud_uploads WHERE namespace=?1",
                [ns],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            raw
        );
        assert_eq!(
            c.query_row(
                "SELECT body FROM flashcard_cloud_uploads WHERE namespace=?1",
                [ns],
                |r| r.get::<_, Vec<u8>>(0)
            )
            .unwrap(),
            [0]
        );
    }
}

#[test]
fn legacy_baseline_valid_capacity_above_transport_limit_and_namespace_after_vacuum() {
    let mut value = populated();
    let original = value["cards"][0].clone();
    let mut cards = Vec::new();
    for n in 0..36 {
        let mut card = original.clone();
        card["id"] = json!(format!("large-card-{n}"));
        card["explanation"] = json!("旧合法正文".repeat(70_000));
        cards.push(card);
    }
    value["cards"] = Value::Array(cards);
    let raw = serde_json::to_string(&value).unwrap();
    assert!(raw.len() > FLASHCARD_SYNC_MAX_SNAPSHOT_BYTES);
    for upload in [false, true] {
        let (_, c) = fixture("large");
        put(&c, "large", &raw, upload);
        c.execute_batch("VACUUM;").unwrap();
        let version = import_legacy(&c, "large", upload.then_some("legacy-upload")).unwrap();
        assert_eq!(version, 4);
        assert_eq!(c.query_row("SELECT count(*) FROM flashcard_cloud_resource_records WHERE namespace='large' AND field='cards'",[],|r|r.get::<_,usize>(0)).unwrap(),36);
        let table = if upload {
            "flashcard_cloud_uploads"
        } else {
            "flashcard_cloud_baselines"
        };
        let field = if upload { "baseline" } else { "payload" };
        assert_eq!(
            c.query_row(
                &format!("SELECT {field} FROM {table} WHERE namespace='large'"),
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            raw
        );
    }
}

#[test]
fn legacy_baseline_database_accept_matches_complete_reference_with_new_and_existing_namespaces() {
    let value = populated();
    let snapshot: FlashcardSyncSnapshot = serde_json::from_value(value).unwrap();
    let (_, mut source) = fixture("database-source");
    merge_flashcard_snapshot(&mut source, &snapshot).unwrap();
    let canonical = local_flashcard_snapshot(&source).unwrap();
    for existing in [false, true] {
        let (_, mut expected) = fixture("database-expected");
        let (_, mut actual) = fixture("database-actual");
        merge_flashcard_snapshot(&mut expected, &canonical).unwrap();
        merge_flashcard_snapshot(&mut actual, &canonical).unwrap();
        if existing {
            let empty = serde_json::to_string(&records::empty(&source).unwrap()).unwrap();
            put(&expected, "accepted", &empty, false);
            put(&actual, "accepted", &empty, false);
            namespace(&expected, "accepted").unwrap();
            namespace(&actual, "accepted").unwrap();
            // A locally changed value must remain dirty after either accept path.
            for c in [&expected, &actual] {
                c.execute("UPDATE flashcards SET question='本地后续修改',updated_at=updated_at+100 WHERE id=?1",[&canonical.cards[0].id]).unwrap();
            }
        }
        super::super::maintenance_accept(&expected, "accepted", &[], &canonical).unwrap();
        super::super::maintenance_accept_database(&actual, "accepted", &source).unwrap();
        assert_eq!(rows(&actual, "accepted"), rows(&expected, "accepted"));
        let text: String = actual
            .query_row(
                "SELECT payload FROM flashcard_cloud_baselines WHERE namespace='accepted'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let released: FlashcardSyncSnapshot = serde_json::from_str(&text).unwrap();
        assert_eq!(released.version, 4);
        if !existing {
            assert_eq!(
                super::super::content_identity(&released).unwrap(),
                super::super::content_identity(&canonical).unwrap()
            );
        }
        assert_eq!(actual.query_row("SELECT typeof(payload) FROM flashcard_cloud_baselines WHERE namespace='accepted'",[],|r|r.get::<_,String>(0)).unwrap(),"text");
        if !existing {
            actual.execute_batch("VACUUM;").unwrap();
            assert_eq!(
                actual
                    .query_row(
                        "SELECT payload FROM flashcard_cloud_baselines WHERE namespace='accepted'",
                        [],
                        |r| r.get::<_, String>(0)
                    )
                    .unwrap(),
                text
            );
        }
    }
}

#[test]
fn legacy_baseline_database_accept_failure_rolls_back_text_records_and_scratch_together() {
    let snapshot: FlashcardSyncSnapshot = serde_json::from_value(populated()).unwrap();
    let (_, mut source) = fixture("accept-failure-source");
    merge_flashcard_snapshot(&mut source, &snapshot).unwrap();
    let (_, actual) = fixture("accept-failure-target");
    actual.execute_batch("CREATE TRIGGER reject_accept_record BEFORE INSERT ON flashcard_cloud_resource_records WHEN NEW.field='schedulerProfiles' BEGIN SELECT RAISE(ABORT,'accept fixture failure'); END;").unwrap();
    assert!(
        super::super::maintenance_accept_database(&actual, "failed", &source)
            .unwrap_err()
            .contains("accept fixture failure")
    );
    for table in [
        "flashcard_cloud_baselines",
        "flashcard_cloud_resource_baselines",
        "flashcard_cloud_resource_records",
    ] {
        assert_eq!(
            actual
                .query_row(
                    &format!("SELECT count(*) FROM {table} WHERE namespace='failed'"),
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }
    let scratch:bool=actual.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='flashcard_cloud_baseline_scratch')",[],|r|r.get(0)).unwrap();
    if scratch {
        assert_eq!(
            actual
                .query_row(
                    "SELECT count(*) FROM flashcard_cloud_baseline_scratch",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }
    actual
        .execute_batch("DROP TRIGGER reject_accept_record")
        .unwrap();
    super::super::maintenance_accept_database(&actual, "failed", &source).unwrap();
    assert!(
        actual
            .query_row(
                "SELECT count(*) FROM flashcard_cloud_resource_records WHERE namespace='failed'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap()
            > 0
    );
}
