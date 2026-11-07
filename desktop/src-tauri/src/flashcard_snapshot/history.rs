//! SQL structural authority for one frozen cloud recovery batch.
//! The canonical data merger owns every business comparison and mutation.
use super::*;
use serde::de::DeserializeOwned;
use std::cell::{Cell, RefCell};

pub(crate) struct Context<'a> {
    namespace: &'a str,
    batch: &'a str,
    prepared_revision: Cell<i64>,
    owned_clears: RefCell<HashMap<String, (String, i64)>>,
}

impl Context<'_> {
    pub(crate) fn new<'a>(namespace: &'a str, batch: &'a str) -> Context<'a> {
        Context {
            namespace,
            batch,
            prepared_revision: Cell::new(0),
            owned_clears: RefCell::new(HashMap::new()),
        }
    }
    fn capture(&self, c: &Connection, remote: &FlashcardSyncSnapshot) -> Result<(), String> {
        self.prepared_revision.set(
            c.query_row(
                "SELECT revision FROM flashcard_cloud_revision_state WHERE id=1",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?,
        );
        let mut clears = self.owned_clears.borrow_mut();
        clears.clear();
        for card in &remote.cards {
            clears.insert(
                format!(
                    "\"card\":{}",
                    serde_json::to_string(&card.id).map_err(|e| e.to_string())?
                ),
                (card.id.clone(), card.updated_at),
            );
        }
        Ok(())
    }
    fn visit<T: DeserializeOwned>(
        &self,
        c: &Connection,
        field: &str,
        mut apply: impl FnMut(T) -> Result<(), String>,
    ) -> Result<(), String> {
        let mut q=c.prepare("SELECT payload FROM flashcard_cloud_recovery_structures WHERE namespace=?1 AND batch=?2 AND field=?3 ORDER BY identity").map_err(|e|e.to_string())?;
        let mut rows = q
            .query(params![self.namespace, self.batch, field])
            .map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let raw: String = row.get(0).map_err(|e| e.to_string())?;
            apply(serde_json::from_str(&raw).map_err(|e| format!("恢复结构格式无效：{e}"))?)?;
        }
        Ok(())
    }

    fn refresh_needed(&self, c: &Connection) -> Result<bool, String> {
        c.query_row("SELECT structural_revision<0 OR EXISTS(SELECT 1 FROM flashcard_cloud_entity_revisions WHERE revision>structural_revision AND field IN ('folders','decks','tombstones','schedulerProfiles','studySettings')) FROM flashcard_cloud_recovery_batches WHERE namespace=?1 AND batch=?2 AND structure_complete=1",params![self.namespace,self.batch],|r|r.get(0)).map_err(|e|e.to_string())
    }

    pub(crate) fn prepare(
        &self,
        c: &Connection,
        remote: &FlashcardSyncSnapshot,
    ) -> Result<(), String> {
        let refresh = self.refresh_needed(c)?;
        if refresh {
            self.visit::<flashcard_profiles::Profile>(c, "schedulerProfiles", |profile| {
                flashcard_profiles::merge(c, &[profile])
            })?;
        }
        // Preserve normal merger ordering and transactionality of this object's inbox.
        flashcard_sync_drafts::merge(c, &remote.drafts)?;
        if !refresh {
            return self.capture(c, remote);
        }
        self.visit::<FlashcardSnapshotTombstone>(c, "tombstones", |t| {
            apply_flashcard_tombstone(c, &t)
        })?;
        let study:Option<String>=c.query_row("SELECT payload FROM flashcard_cloud_recovery_structures WHERE namespace=?1 AND batch=?2 AND field='studySettings' AND identity='studySettings'",params![self.namespace,self.batch],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        let study: Option<FlashcardStudySettings> = study
            .map(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
            .transpose()?;
        merge_study_settings(c, study.as_ref())?;
        c.execute(
            "DELETE FROM flashcard_cloud_recovery_aliases WHERE namespace=?1 AND batch=?2",
            params![self.namespace, self.batch],
        )
        .map_err(|e| e.to_string())?;
        self.visit::<FlashcardSnapshotFolder>(c, "folders", |folder| {
            if let Some(id) = merge_folder(c, &folder)? {
                self.alias(c, "folders", &folder.id, &id)?;
            }
            Ok(())
        })?;
        self.visit::<FlashcardSnapshotDeck>(c, "decks", |deck| {
            let folder = self
                .lookup(c, "folders", &deck.folder_id)?
                .or(c
                    .query_row(
                        "SELECT id FROM flashcard_deck_folders WHERE id=?1",
                        [&deck.folder_id],
                        |r| r.get::<_, String>(0),
                    )
                    .optional()
                    .map_err(|e| e.to_string())?)
                .unwrap_or_default();
            if let Some(id) = merge_deck(c, &deck, &folder)? {
                self.alias(c, "decks", &deck.id, &id)?;
            }
            Ok(())
        })?;
        self.capture(c, remote)
    }

    fn alias(&self, c: &Connection, field: &str, remote: &str, local: &str) -> Result<(), String> {
        c.execute("INSERT INTO flashcard_cloud_recovery_aliases(namespace,batch,field,remote_id,local_id) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(namespace,batch,field,remote_id) DO UPDATE SET local_id=excluded.local_id",params![self.namespace,self.batch,field,remote,local]).map(|_|()).map_err(|e|e.to_string())
    }
    fn lookup(&self, c: &Connection, field: &str, remote: &str) -> Result<Option<String>, String> {
        c.query_row("SELECT local_id FROM flashcard_cloud_recovery_aliases WHERE namespace=?1 AND batch=?2 AND field=?3 AND remote_id=?4",params![self.namespace,self.batch,field,remote],|r|r.get(0)).optional().map_err(|e|e.to_string())
    }
    pub(crate) fn deck(&self, c: &Connection, remote: &str) -> Result<Option<String>, String> {
        self.lookup(c, "decks", remote)
    }

    pub(crate) fn remap_quality(&self, c: &Connection, value: &mut Value) -> Result<(), String> {
        if let Some(object) = value.as_object_mut() {
            for key in ["deckId", "scopeValue"] {
                if key == "scopeValue"
                    && object.get("scopeType").and_then(Value::as_str) != Some("deck")
                {
                    continue;
                }
                if let Some(remote) = object.get(key).and_then(Value::as_str) {
                    if let Some(local) = self.deck(c, remote)? {
                        object.insert(key.into(), Value::String(local));
                    }
                }
            }
            for child in object.values_mut() {
                self.remap_quality(c, child)?;
            }
        } else if let Some(array) = value.as_array_mut() {
            for child in array {
                self.remap_quality(c, child)?;
            }
        }
        Ok(())
    }

    pub(crate) fn finish(&self, c: &Connection) -> Result<(), String> {
        let prepared = self.prepared_revision.get();
        let mut unowned = false;
        let clears = self.owned_clears.borrow();
        let mut q=c.prepare("SELECT field,identity FROM flashcard_cloud_entity_revisions WHERE revision>?1 AND field IN ('folders','decks','tombstones','schedulerProfiles','studySettings')").map_err(|e|e.to_string())?;
        let mut rows = q.query([prepared]).map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let field: String = row.get(0).map_err(|e| e.to_string())?;
            let identity: String = row.get(1).map_err(|e| e.to_string())?;
            // The content merger may clear an older tombstone for its own card.
            // Other structural mutations, including SQL-trigger side effects,
            // must invalidate the next object's aliases and global authority.
            let owned = if field == "tombstones" {
                if let Some((id, updated)) = clears.get(&identity) {
                    let deleted:Option<i64>=c.query_row("SELECT clock_integer FROM flashcard_cloud_recovery_structures WHERE namespace=?1 AND batch=?2 AND field='tombstones' AND identity=?3",params![self.namespace,self.batch,format!("card:{id}")],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
                    deleted.is_none_or(|t| t < *updated)
                        && records::local(c, "tombstones", &identity)?.is_none()
                } else {
                    false
                }
            } else {
                false
            };
            if !owned {
                unowned = true;
                break;
            }
        }
        drop(rows);
        drop(q);
        let revision = if unowned {
            prepared
        } else {
            c.query_row(
                "SELECT revision FROM flashcard_cloud_revision_state WHERE id=1",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?
        };
        c.execute("UPDATE flashcard_cloud_recovery_batches SET structural_revision=?3 WHERE namespace=?1 AND batch=?2",params![self.namespace,self.batch,revision]).map(|_|()).map_err(|e|e.to_string())
    }
}
