//! Durable, bounded-memory replay of immutable cloud history.
use super::*;
use crate::flashcard_store::flashcard_by_id;
const MAX_STAGED: u64 = 2 * 1024 * 1024 * 1024;

pub(super) fn decode(id: &str, body: &[u8]) -> Result<Change, String> {
    if body.len() > FLASHCARD_SYNC_MAX_SNAPSHOT_BYTES
        || !id.ends_with(&format!("-{:x}.json", Sha256::digest(body)))
    {
        return Err("云端变更内容身份不符".into());
    }
    let change: Change = serde_json::from_slice(body).map_err(|_| "云端变更格式无效")?;
    if !matches!(change.version, 2 | 3 | 4) || change.format != "hub-flashcard-changes" {
        return Err("云端同步协议版本不支持".into());
    }
    flashcard_scheduler::validate_snapshot(&change.snapshot)?;
    if change.snapshot.folders.len() > 10_000
        || change.snapshot.decks.len() > 10_000
        || change.snapshot.tombstones.len() > 200_000
        || change.snapshot.drafts.len() > 200_000
        || change.snapshot.cards.len() > 200_000
        || change.snapshot.reviews.len() > 2_000_000
    {
        return Err("远端闪卡快照超过安全数量限制".into());
    }
    Ok(change)
}

fn cached(c: &Connection, ns: &str, id: &str) -> Result<bool, String> {
    c.query_row(
        "SELECT EXISTS(SELECT 1 FROM flashcard_cloud_recovery WHERE namespace=?1 AND id=?2)",
        params![ns, id],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

#[cfg(test)]
fn stage(c: &Connection, ns: &str, id: &str, body: &[u8], budget: u64) -> Result<bool, String> {
    decode(id, body)?;
    if cached(c, ns, id)? {
        return Ok(true);
    }
    if body.len() as u64 > budget {
        return Err("单个恢复对象超过暂存窗口；原记录已保留".into());
    }
    let bytes: u64 = c
        .query_row(
            "SELECT coalesce(sum(length(body)),0) FROM flashcard_cloud_recovery WHERE namespace=?1",
            [ns],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if bytes.saturating_add(body.len() as u64) > budget {
        // Full staging must not prevent replay of an arbitrarily long journal.
        // The validated structural pass may continue without retaining this body.
        return Ok(false);
    }
    c.execute(
        "INSERT OR IGNORE INTO flashcard_cloud_recovery(namespace,id,body) VALUES(?1,?2,?3)",
        params![ns, id, body],
    )
    .map_err(|e| e.to_string())?;
    Ok(true)
}

fn body(c: &Connection, ns: &str, id: &str) -> Result<Vec<u8>, String> {
    c.query_row(
        "SELECT body FROM flashcard_cloud_recovery WHERE namespace=?1 AND id=?2",
        params![ns, id],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

fn retain(
    c: &Connection,
    ns: &str,
    batch: &str,
    id: &str,
    body: &[u8],
    budget: u64,
) -> Result<bool, String> {
    if cached(c, ns, id)? {
        return Ok(true);
    }
    if body.len() as u64 > budget {
        return Err("单个恢复对象超过暂存窗口；原记录已保留".into());
    }
    let current:u64=c.query_row("SELECT cache_bytes FROM flashcard_cloud_recovery_batches WHERE namespace=?1 AND batch=?2",params![ns,batch],|r|r.get(0)).map_err(|e|e.to_string())?;
    if current.saturating_add(body.len() as u64) > budget {
        return Ok(false);
    }
    let inserted = c
        .execute(
            "INSERT OR IGNORE INTO flashcard_cloud_recovery(namespace,id,body) VALUES(?1,?2,?3)",
            params![ns, id, body],
        )
        .map_err(|e| e.to_string())?;
    if inserted == 1 {
        c.execute("UPDATE flashcard_cloud_recovery_batches SET cache_bytes=cache_bytes+?3 WHERE namespace=?1 AND batch=?2",params![ns,batch,body.len() as i64]).map_err(|e|e.to_string())?;
    }
    Ok(true)
}

fn apply_one(
    database: &PathBuf,
    ns: &str,
    batch: &str,
    id: &str,
) -> Result<(usize, usize), String> {
    let (mut c, _writer) = open_write_database(database)?;
    let bytes = body(&c, ns, id)?;
    let incoming = decode(id, &bytes)?.snapshot;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let validated:bool=tx.query_row("SELECT structure_complete=1 AND EXISTS(SELECT 1 FROM flashcard_cloud_recovery_candidates WHERE namespace=?1 AND batch=?2 AND id=?3 AND validated=1) FROM flashcard_cloud_recovery_batches WHERE namespace=?1 AND batch=?2",params![ns,batch,id],|r|r.get(0)).map_err(|e|e.to_string())?;
    if !validated {
        return Err("恢复对象尚无完整验证授权；原记录已保留".into());
    }
    let context = crate::flashcard_snapshot::history::Context::new(ns, batch);
    let result = crate::flashcard_snapshot::merge_recovery_snapshot(&tx, &incoming, &context)?;
    baseline::namespace(&tx, ns)?;
    macro_rules! absorb {
        ($field:literal,$items:expr) => {
            for item in $items {
                baseline::absorb_record(
                    &tx,
                    ns,
                    $field,
                    serde_json::to_value(item).map_err(|e| e.to_string())?,
                )?;
            }
        };
    }
    absorb!("folders", &incoming.folders);
    absorb!("decks", &incoming.decks);
    absorb!("schedulerProfiles", &incoming.scheduler_profiles);
    absorb!("tombstones", &incoming.tombstones);
    absorb!("cards", &incoming.cards);
    absorb!("reviews", &incoming.reviews);
    absorb!("drafts", &incoming.drafts);
    absorb!("qualityRecords", &incoming.quality_records);
    if let Some(settings) = &incoming.study_settings {
        baseline::absorb_record(
            &tx,
            ns,
            "studySettings",
            serde_json::to_value(settings).map_err(|e| e.to_string())?,
        )?;
    }
    tx.execute(
        "INSERT OR IGNORE INTO flashcard_cloud_applied(namespace,id) VALUES(?1,?2)",
        params![ns, id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM flashcard_cloud_recovery WHERE namespace=?1 AND id=?2",
        params![ns, id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM flashcard_cloud_recovery_candidates WHERE namespace=?1 AND batch=?2 AND id=?3",
        params![ns, batch, id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("UPDATE flashcard_cloud_recovery_batches SET state='replaying',cache_bytes=cache_bytes-?3 WHERE namespace=?1 AND batch=?2",params![ns,batch,bytes.len() as i64]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(result)
}

async fn run(
    remote: &OssStore,
    database: &PathBuf,
    ns: &str,
    batch: &str,
    report: &mut CloudReport,
    budget: u64,
) -> Result<(usize, usize), String> {
    let budget = budget.min(MAX_STAGED);
    if history::state(&open_database(database)?, ns, batch)? == "scanning" {
        loop {
            let next = history::next(&open_database(database)?, ns, batch, true, false)?;
            let Some(id) = next else {
                break;
            };
            let retained = {
                let c = open_database(database)?;
                if cached(&c, ns, &id)? {
                    Some(body(&c, ns, &id)?)
                } else {
                    None
                }
            };
            let bytes = match retained {
                Some(bytes) => bytes,
                None => {
                    let bytes = remote
                        .get(&id, FLASHCARD_SYNC_MAX_SNAPSHOT_BYTES)
                        .await?
                        .ok_or("列出的同步变更已消失；没有跳过未读取的变更")?;
                    report.downloaded_bytes += bytes.len() as u64;
                    report.downloaded_changes += 1;
                    bytes
                }
            };
            let snapshot = decode(&id, &bytes)?.snapshot;
            let (mut c, _writer) = open_write_database(database)?;
            let tx = c.transaction().map_err(|e| e.to_string())?;
            retain(&tx, ns, batch, &id, &bytes, budget)?;
            history::absorb(&tx, ns, batch, &snapshot)?;
            tx.execute("UPDATE flashcard_cloud_recovery_candidates SET validated=1 WHERE namespace=?1 AND batch=?2 AND id=?3",params![ns,batch,id]).map_err(|e|e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
        }
        let (mut c, _writer) = open_write_database(database)?;
        let tx = c.transaction().map_err(|e| e.to_string())?;
        if history::next(&tx, ns, batch, false, false)?.is_none() {
            history::complete(&tx, ns, batch)?;
            tx.commit().map_err(|e| e.to_string())?;
            return Ok((0, 0));
        }
        history::ready(&tx, ns, batch)?;
        tx.commit().map_err(|e| e.to_string())?;
    }
    let mut counts = (0, 0);
    loop {
        let next = history::next(&open_database(database)?, ns, batch, false, true)?;
        let Some(id) = next else {
            break;
        };
        let result = apply_one(database, ns, batch, &id)?;
        counts.0 += result.0;
        counts.1 += result.1;
    }
    loop {
        let next = history::next(&open_database(database)?, ns, batch, false, false)?;
        let Some(id) = next else {
            break;
        };
        let bytes = remote
            .get(&id, FLASHCARD_SYNC_MAX_SNAPSHOT_BYTES)
            .await?
            .ok_or("待恢复的同步变更已消失；恢复清单和已提交记录已保留")?;
        report.downloaded_bytes += bytes.len() as u64;
        decode(&id, &bytes)?;
        {
            let (mut c, _writer) = open_write_database(database)?;
            let tx = c.transaction().map_err(|e| e.to_string())?;
            if !retain(&tx, ns, batch, &id, &bytes, budget)? {
                return Err("恢复正文窗口未释放；恢复清单已保留".into());
            }
            tx.commit().map_err(|e| e.to_string())?;
        }
        let result = apply_one(database, ns, batch, &id)?;
        counts.0 += result.0;
        counts.1 += result.1;
    }
    let (mut c, _writer) = open_write_database(database)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    history::complete(&tx, ns, batch)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(counts)
}

pub(super) async fn recover_from_store(
    remote: &OssStore,
    database: &PathBuf,
    ns: &str,
    report: &mut CloudReport,
) -> Result<(usize, usize), String> {
    let mut counts = (0, 0);
    // A resumed ready batch keeps its original authority. Finish it, then take
    // one fresh provider inventory so current visible additions are included.
    for pass in 0..2 {
        let (batch, existing) = {
            let (mut c, _writer) = open_write_database(database)?;
            history::begin(&mut c, ns)?
        };
        let listing = history::state(&open_database(database)?, ns, &batch)? == "listing";
        if listing {
            history::list(remote, database, ns, &batch).await?;
        }
        let result = run(remote, database, ns, &batch, report, MAX_STAGED).await?;
        counts.0 += result.0;
        counts.1 += result.1;
        if !existing || listing || pass == 1 {
            break;
        }
    }
    Ok(counts)
}

#[cfg(test)]
async fn recover(
    remote: &OssStore,
    database: &PathBuf,
    ns: &str,
    keys: Vec<String>,
    report: &mut CloudReport,
) -> Result<(usize, usize), String> {
    recover_with_budget(remote, database, ns, keys, report, MAX_STAGED).await
}

#[cfg(test)]
async fn recover_with_budget(
    remote: &OssStore,
    database: &PathBuf,
    ns: &str,
    keys: Vec<String>,
    report: &mut CloudReport,
    budget: u64,
) -> Result<(usize, usize), String> {
    let (batch, _existing) = {
        let (mut c, _writer) = open_write_database(database)?;
        history::begin(&mut c, ns)?
    };
    if history::state(&open_database(database)?, ns, &batch)? == "listing" {
        let (mut c, _writer) = open_write_database(database)?;
        let tx = c.transaction().map_err(|e| e.to_string())?;
        for key in keys {
            history::candidate(&tx, ns, &batch, &key, false)?;
        }
        tx.execute("UPDATE flashcard_cloud_recovery_batches SET state='scanning' WHERE namespace=?1 AND batch=?2",params![ns,batch]).map_err(|e|e.to_string())?;
        history::checkpoint(&tx, ns, &batch, false)?;
        tx.commit().map_err(|e| e.to_string())?;
    }
    run(remote, database, ns, &batch, report, budget).await
}

#[cfg(test)]
fn apply_pending(
    database: &PathBuf,
    ns: &str,
    context: &FlashcardSyncSnapshot,
) -> Result<(usize, usize), String> {
    let (batch, _existing) = {
        let (mut c, _writer) = open_write_database(database)?;
        history::begin(&mut c, ns)?
    };
    {
        let (mut c, _writer) = open_write_database(database)?;
        let tx = c.transaction().map_err(|e| e.to_string())?;
        history::absorb(&tx, ns, &batch, context)?;
        tx.execute("UPDATE flashcard_cloud_recovery_candidates SET validated=1 WHERE namespace=?1 AND batch=?2",params![ns,batch]).map_err(|e|e.to_string())?;
        tx.execute("UPDATE flashcard_cloud_recovery_batches SET state='ready',structure_complete=1 WHERE namespace=?1 AND batch=?2",params![ns,batch]).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
    }
    let mut counts = (0, 0);
    while let Some(id) = history::next(&open_database(database)?, ns, &batch, false, true)? {
        let result = apply_one(database, ns, &batch, &id)?;
        counts.0 += result.0;
        counts.1 += result.1;
    }
    Ok(counts)
}

#[cfg(test)]
fn structural(mut snapshot: FlashcardSyncSnapshot) -> FlashcardSyncSnapshot {
    snapshot.cards.clear();
    snapshot.reviews.clear();
    snapshot.drafts.clear();
    snapshot.quality_records.clear();
    snapshot
}

#[cfg(test)]
#[derive(Serialize, Deserialize)]
struct Control {
    format: String,
    version: u32,
    snapshot: Option<FlashcardSyncSnapshot>,
    keys: Vec<String>,
    #[serde(default)]
    complete: bool,
}

#[cfg(test)]
#[derive(Deserialize)]
#[serde(untagged)]
enum StoredControl {
    Current(Control),
    Legacy(FlashcardSyncSnapshot),
}

#[cfg(test)]
fn control(c: &Connection, ns: &str) -> Result<Option<Control>, String> {
    let raw: Option<Vec<u8>> = c
        .query_row(
            "SELECT body FROM flashcard_cloud_recovery_control WHERE namespace=?1",
            [ns],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    raw.map(|raw| {
        let stored: StoredControl = serde_json::from_slice(&raw)
            .map_err(|_| "恢复结构暂存损坏；原记录已保留".to_string())?;
        let mut value = match stored {
            StoredControl::Current(value) => value,
            StoredControl::Legacy(snapshot) => Control {
                format: "hub-flashcard-recovery-control".into(),
                version: 2,
                snapshot: Some(snapshot),
                keys: Vec::new(),
                complete: false,
            },
        };
        if value.format != "hub-flashcard-recovery-control" || !matches!(value.version, 1 | 2) {
            return Err("恢复结构暂存版本不支持；原记录已保留".into());
        }
        if value.version == 1 {
            // The first envelope was published only after a full structural scan.
            value.version = 2;
            value.complete = true;
        }
        if value.complete && value.snapshot.is_none() {
            return Err("完整恢复结构暂存为空；原记录已保留".into());
        }
        if let Some(snapshot) = &value.snapshot {
            flashcard_scheduler::validate_snapshot(snapshot)?;
        }
        Ok(value)
    })
    .transpose()
}

#[cfg(test)]
fn pending(c: &Connection, ns: &str) -> Result<Vec<String>, String> {
    let mut q = c
        .prepare("SELECT id FROM flashcard_cloud_recovery WHERE namespace=?1 ORDER BY id")
        .map_err(|e| e.to_string())?;
    let rows = q
        .query_map([ns], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
fn applied(c: &Connection, ns: &str) -> Result<HashSet<String>, String> {
    let mut q = c
        .prepare("SELECT id FROM flashcard_cloud_applied WHERE namespace=?1")
        .map_err(|e| e.to_string())?;
    let rows = q
        .query_map([ns], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<HashSet<_>, _>>()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
#[path = "history_tests.rs"]
mod history_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flashcard_cloud_sync::tests::{server, store};
    fn fixture(label: &str) -> (PathBuf, BlobStore) {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../artifacts/performance-audit-20261011/recovery-tests")
            .join(format!("{label}-{}", random_url_safe(8)));
        fs::create_dir_all(&root).unwrap();
        (
            root.join("craft-search.sqlite3"),
            BlobStore::open(&root.join("blobs-v1")).unwrap(),
        )
    }
    fn snapshot(db: &PathBuf) -> FlashcardSyncSnapshot {
        let c = open_database(db).unwrap();
        c.execute_batch("INSERT INTO flashcard_decks(id,name,created_at,updated_at) VALUES('recovery-deck','恢复',10,10);
            INSERT INTO flashcards(id,deck_id,question,answer,media_json,status,created_at,updated_at,due_at) VALUES('recovery-card','recovery-deck','恢复问题','答案','[]','active',10,10,10);").unwrap();
        local_flashcard_snapshot(&c).unwrap()
    }
    async fn upload(remote: &OssStore, label: &str, snapshot: FlashcardSyncSnapshot) -> String {
        let bytes = serde_json::to_vec(&Change {
            format: "hub-flashcard-changes".into(),
            version: 4,
            checkpoint: true,
            snapshot,
        })
        .unwrap();
        let id = remote.key(&format!(
            "changes/{label}-{:x}.json",
            Sha256::digest(&bytes)
        ));
        remote.put_verified(&id, &bytes).await.unwrap();
        id
    }
    fn reviewed_snapshot(db: &PathBuf) -> (FlashcardSyncSnapshot, i64) {
        let c = open_database(db).unwrap();
        let preview =
            serde_json::to_value(flashcard_scheduler::preview(&c, "recovery-card", 1000).unwrap())
                .unwrap();
        let result = flashcard_scheduler::commit(
            &c,
            "recovery-card",
            3,
            Some(1000),
            preview["reviewKey"].as_str().unwrap(),
            1000,
        )
        .unwrap();
        (local_flashcard_snapshot(&c).unwrap(), result.card.due_at)
    }
    fn prepare(db: &PathBuf) {
        ensure_journal(&open_database(db).unwrap()).unwrap();
    }

    #[tokio::test]
    async fn recovery_drains_journal_larger_than_injected_budget_and_projects_early_event() {
        let server = server().await;
        let remote = store(&server);
        let (source, _) = fixture("window-source");
        let (target, _) = fixture("window-target");
        let base = snapshot(&source);
        let (reviewed, expected_due) = reviewed_snapshot(&source);
        let mut event = reviewed.clone();
        event.cards.clear();
        event.decks.clear();
        let event_id = upload(&remote, "a-event", event).await;
        let mut card = reviewed;
        card.reviews.clear();
        let card_id = upload(&remote, "b-card", card).await;
        let mut keys = vec![event_id.clone(), card_id];
        for n in 0..4 {
            let mut next = base.clone();
            next.cards[0].id = format!("window-card-{n}");
            next.cards[0].question = "x".repeat(8192);
            keys.push(upload(&remote, &format!("c-extra-{n}"), next).await);
        }
        let budget = {
            let state = server.state.lock().unwrap();
            let sizes = keys
                .iter()
                .map(|key| state.files[key].0.len() as u64)
                .collect::<Vec<_>>();
            let budget = sizes.iter().copied().max().unwrap();
            assert!(sizes.iter().sum::<u64>() > budget * 3);
            budget
        };
        prepare(&target);
        {
            let c = open_database(&target).unwrap();
            // Verify the actual durable producer never overfills this budget,
            // rather than asserting against its own reported accounting.
            c.execute_batch(&format!("CREATE TABLE recovery_window_probe(bytes INTEGER);
                CREATE TRIGGER recovery_window_limit BEFORE INSERT ON flashcard_cloud_recovery
                  WHEN (SELECT coalesce(sum(length(body)),0) FROM flashcard_cloud_recovery WHERE namespace=NEW.namespace)+length(NEW.body)>{budget}
                  BEGIN SELECT RAISE(ABORT,'injected staging capacity'); END;
                CREATE TRIGGER recovery_window_peak AFTER INSERT ON flashcard_cloud_recovery
                  BEGIN INSERT INTO recovery_window_probe SELECT sum(length(body)) FROM flashcard_cloud_recovery WHERE namespace=NEW.namespace; END;
                CREATE TABLE recovery_event_probe(card_exists INTEGER);
                CREATE TRIGGER recovery_event_before_card AFTER INSERT ON flashcard_review_events
                  BEGIN INSERT INTO recovery_event_probe SELECT count(*) FROM flashcards WHERE id=NEW.card_id; END;")).unwrap();
        }
        let mut report = CloudReport::default();
        let counts = recover_with_budget(
            &remote,
            &target,
            "window",
            keys.clone(),
            &mut report,
            budget,
        )
        .await
        .unwrap();
        assert_eq!(counts.1, 1);
        assert_eq!(report.downloaded_changes, keys.len());
        let c = open_database(&target).unwrap();
        assert!(pending(&c, "window").unwrap().is_empty());
        assert!(control(&c, "window").unwrap().is_none());
        assert_eq!(applied(&c, "window").unwrap().len(), keys.len());
        assert_eq!(local_flashcard_snapshot(&c).unwrap().reviews.len(), 1);
        assert_eq!(
            flashcard_by_id(&c, "recovery-card").unwrap().due_at,
            expected_due
        );
        assert_eq!(
            c.query_row("SELECT count(*) FROM flashcard_reviews", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            c.query_row("SELECT card_exists FROM recovery_event_probe", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert!(
            c.query_row("SELECT max(bytes) FROM recovery_window_probe", [], |r| r
                .get::<_, u64>(0))
                .unwrap()
                <= budget
        );
        assert_eq!(
            c.query_row("SELECT count(*) FROM recovery_window_probe", [], |r| r
                .get::<_, usize>(0))
                .unwrap(),
            keys.len()
        );
        assert!(keys.iter().any(|key| server
            .state
            .lock()
            .unwrap()
            .gets
            .get(key)
            .copied()
            .unwrap_or(0)
            >= 2));
    }

    #[tokio::test]
    async fn recovery_committed_event_prefix_survives_later_card_failure_without_duplicate() {
        let server = server().await;
        let remote = store(&server);
        let (source, _) = fixture("prefix-source");
        let (target, _) = fixture("prefix-target");
        snapshot(&source);
        let (reviewed, expected_due) = reviewed_snapshot(&source);
        let mut event = reviewed.clone();
        event.cards.clear();
        event.decks.clear();
        let first = upload(&remote, "a-event", event).await;
        let mut card = reviewed;
        card.reviews.clear();
        let second = upload(&remote, "b-card", card).await;
        prepare(&target);
        {
            let c = open_database(&target).unwrap();
            c.execute_batch("CREATE TRIGGER reject_later_card BEFORE INSERT ON flashcards
                WHEN NEW.id='recovery-card' BEGIN SELECT RAISE(ABORT,'injected later object failure'); END;").unwrap();
        }
        let keys = vec![first.clone(), second.clone()];
        assert!(recover(
            &remote,
            &target,
            "prefix",
            keys.clone(),
            &mut CloudReport::default()
        )
        .await
        .is_err());
        let fetched = server.state.lock().unwrap().gets.clone();
        {
            let c = open_database(&target).unwrap();
            assert!(applied(&c, "prefix").unwrap().contains(&first));
            assert!(!applied(&c, "prefix").unwrap().contains(&second));
            assert!(!cached(&c, "prefix", &first).unwrap());
            assert!(cached(&c, "prefix", &second).unwrap());
            assert_eq!(local_flashcard_snapshot(&c).unwrap().reviews.len(), 1);
            assert_eq!(
                c.query_row("SELECT count(*) FROM flashcard_reviews", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            assert_eq!(control(&c, "prefix").unwrap().unwrap().keys, keys);
            c.execute_batch("DROP TRIGGER reject_later_card").unwrap();
        }
        forget_initialized_database(&target);
        recover(
            &remote,
            &target,
            "prefix",
            keys,
            &mut CloudReport::default(),
        )
        .await
        .unwrap();
        assert_eq!(server.state.lock().unwrap().gets, fetched);
        let c = open_database(&target).unwrap();
        assert_eq!(local_flashcard_snapshot(&c).unwrap().reviews.len(), 1);
        assert_eq!(
            c.query_row("SELECT count(*) FROM flashcard_review_events", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            c.query_row("SELECT count(*) FROM flashcard_reviews", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            flashcard_by_id(&c, "recovery-card").unwrap().due_at,
            expected_due
        );
        assert!(control(&c, "prefix").unwrap().is_none());
    }

    #[tokio::test]
    async fn recovery_manifest_keeps_missing_deferred_object_visible_after_restart() {
        let server = server().await;
        let remote = store(&server);
        let (source, _) = fixture("manifest-source");
        let (target, _) = fixture("manifest-target");
        let snapshot = snapshot(&source);
        let first = upload(&remote, "a-first", snapshot.clone()).await;
        let mut later = snapshot.clone();
        later.cards[0].id = "deferred-card".into();
        let second = upload(&remote, "b-deferred", later).await;
        prepare(&target);
        let context = structural(snapshot);
        {
            let (c, _writer) = open_write_database(&target).unwrap();
            let state = server.state.lock().unwrap();
            assert!(stage(&c, "manifest", &first, &state.files[&first].0, MAX_STAGED).unwrap());
            // Model interruption after the full control checkpoint and a
            // committed body window, before the next deferred body's download.
            let envelope = serde_json::to_vec(&Control {
                format: "hub-flashcard-recovery-control".into(),
                version: 2,
                snapshot: Some(context.clone()),
                keys: vec![first.clone(), second.clone()],
                complete: true,
            })
            .unwrap();
            c.execute("INSERT INTO flashcard_cloud_recovery_control(namespace,body) VALUES('manifest',?1)", [envelope]).unwrap();
        }
        apply_pending(&target, "manifest", &context).unwrap();
        server.state.lock().unwrap().files.remove(&second);
        forget_initialized_database(&target);
        let keys = remote.list("changes/").await.unwrap();
        let error = recover(
            &remote,
            &target,
            "manifest",
            keys,
            &mut CloudReport::default(),
        )
        .await
        .unwrap_err();
        assert!(error.contains("变更已消失"));
        let c = open_database(&target).unwrap();
        assert!(applied(&c, "manifest").unwrap().contains(&first));
        assert!(!applied(&c, "manifest").unwrap().contains(&second));
        assert!(control(&c, "manifest")
            .unwrap()
            .unwrap()
            .keys
            .contains(&second));
        assert!(flashcard_by_id(&c, "recovery-card").is_ok());
        assert!(flashcard_by_id(&c, "deferred-card").is_err());
    }

    #[tokio::test]
    async fn recovery_first_pass_interruption_preserves_frozen_ids_without_import_authority() {
        let server = server().await;
        let remote = store(&server);
        let (source, _) = fixture("scan-source");
        let (target, _) = fixture("scan-target");
        let base = snapshot(&source);
        let mut keys = Vec::new();
        for label in ['a', 'b', 'c'] {
            let mut next = base.clone();
            next.cards[0].id = format!("scan-card-{label}");
            keys.push(upload(&remote, &format!("{label}-scan"), next).await);
        }
        let budget = server
            .state
            .lock()
            .unwrap()
            .files
            .values()
            .map(|item| item.0.len() as u64)
            .max()
            .unwrap();
        prepare(&target);
        // The third object disappears after list has frozen it. The first body
        // fits, the second must defer, and the interrupted structural pass has
        // not yet earned authority to import either body.
        server.state.lock().unwrap().files.remove(&keys[2]);
        let error = recover_with_budget(
            &remote,
            &target,
            "scan",
            keys.clone(),
            &mut CloudReport::default(),
            budget,
        )
        .await
        .unwrap_err();
        assert!(error.contains("变更已消失"));
        {
            let c = open_database(&target).unwrap();
            let saved = control(&c, "scan").unwrap().unwrap();
            assert_eq!(saved.keys, keys);
            assert!(!saved.complete);
            assert!(saved.snapshot.is_none());
            assert!(cached(&c, "scan", &keys[0]).unwrap());
            assert!(!cached(&c, "scan", &keys[1]).unwrap());
            assert!(applied(&c, "scan").unwrap().is_empty());
            assert!(local_flashcard_snapshot(&c).unwrap().cards.is_empty());
        }
        // A later remote list also omits the already validated deferred object.
        // The durable candidate list must still surface that missing identity.
        server.state.lock().unwrap().files.remove(&keys[1]);
        forget_initialized_database(&target);
        let visible = remote.list("changes/").await.unwrap();
        assert_eq!(visible, vec![keys[0].clone()]);
        assert!(recover_with_budget(
            &remote,
            &target,
            "scan",
            visible,
            &mut CloudReport::default(),
            budget
        )
        .await
        .unwrap_err()
        .contains("变更已消失"));
        let c = open_database(&target).unwrap();
        let saved = control(&c, "scan").unwrap().unwrap();
        assert_eq!(saved.keys, keys);
        assert!(!saved.complete);
        assert!(applied(&c, "scan").unwrap().is_empty());
        assert!(local_flashcard_snapshot(&c).unwrap().cards.is_empty());
    }

    #[test]
    fn recovery_control_reads_bare_and_complete_v1_snapshots_without_promoting_incomplete_state() {
        let (source, _) = fixture("control-source");
        let (target, _) = fixture("control-target");
        let context = structural(snapshot(&source));
        prepare(&target);
        let c = open_database(&target).unwrap();
        for (payload, complete) in [
            (serde_json::to_vec(&context).unwrap(), false),
            (
                serde_json::to_vec(&json!({
                    "format":"hub-flashcard-recovery-control", "version":1,
                    "snapshot":context, "keys":["owned-candidate"],
                }))
                .unwrap(),
                true,
            ),
        ] {
            c.execute(
                "INSERT INTO flashcard_cloud_recovery_control(namespace,body) VALUES('old',?1)
                ON CONFLICT(namespace) DO UPDATE SET body=excluded.body",
                [payload],
            )
            .unwrap();
            let saved = control(&c, "old").unwrap().unwrap();
            assert_eq!(saved.version, 2);
            assert_eq!(saved.complete, complete);
            assert!(saved.snapshot.is_some());
        }
    }
    #[tokio::test]
    async fn recovery_downloads_over_128mb_without_all_history_in_memory() {
        let server = server().await;
        let remote = store(&server);
        let (source, _) = fixture("large-source");
        let (target, blobs) = fixture("large-target");
        let mut snapshot = snapshot(&source);
        snapshot.cards[0].question = "x".repeat(9 * 1024 * 1024);
        for n in 0..15 {
            snapshot.exported_at = 100 + n;
            upload(&remote, &format!("history-{n:02}"), snapshot.clone()).await;
        }
        let namespace = "large-recovery";
        let result = sync_database(&remote, &target, &blobs, namespace, false, false)
            .await
            .unwrap();
        assert!(result.cloud_report.unwrap().downloaded_bytes > 128 * 1024 * 1024);
        let c = open_database(&target).unwrap();
        assert_eq!(local_flashcard_snapshot(&c).unwrap().cards.len(), 1);
        assert_eq!(
            c.query_row("SELECT count(*) FROM flashcard_cloud_recovery", [], |r| r
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            0
        );
        assert_eq!(
            c.query_row(
                "SELECT count(*) FROM flashcard_cloud_recovery_control",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }
    #[tokio::test]
    async fn recovery_failed_domain_commit_retains_download_and_resumes_after_reopen() {
        let server = server().await;
        let remote = store(&server);
        let (source, _) = fixture("restart-source");
        let (target, blobs) = fixture("restart-target");
        let id = upload(&remote, "a-source", snapshot(&source)).await;
        let c = open_database(&target).unwrap();
        c.execute_batch("CREATE TRIGGER reject_recovery_card BEFORE INSERT ON flashcards BEGIN SELECT RAISE(ABORT,'injected write failure'); END;").unwrap();
        drop(c);
        assert!(
            sync_database(&remote, &target, &blobs, "restart", false, false)
                .await
                .is_err()
        );
        let fetched = server
            .state
            .lock()
            .unwrap()
            .gets
            .get(&id)
            .copied()
            .unwrap_or(0);
        let c = open_database(&target).unwrap();
        assert!(cached(&c, "restart", &id).unwrap());
        assert!(local_flashcard_snapshot(&c).unwrap().cards.is_empty());
        assert_eq!(
            c.query_row(
                "SELECT count(*) FROM flashcard_cloud_applied WHERE namespace='restart' AND id=?1",
                [&id],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        c.execute_batch("DROP TRIGGER reject_recovery_card")
            .unwrap();
        drop(c);
        sync_database(&remote, &target, &blobs, "restart", false, false)
            .await
            .unwrap();
        assert_eq!(
            server
                .state
                .lock()
                .unwrap()
                .gets
                .get(&id)
                .copied()
                .unwrap_or(0),
            fetched
        );
        let c = open_database(&target).unwrap();
        assert_eq!(local_flashcard_snapshot(&c).unwrap().cards.len(), 1);
        assert!(!cached(&c, "restart", &id).unwrap());
    }
}
