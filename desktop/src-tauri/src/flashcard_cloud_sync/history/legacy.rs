//! Released control formats migrate without materializing their history arrays.
use super::*;
use serde::de::{DeserializeSeed, Error, IgnoredAny, MapAccess, SeqAccess, Visitor};
use std::cell::RefCell;
use std::fmt;

struct Source<'a> {
    c: &'a Connection,
    ns: &'a str,
    batch: &'a str,
    failure: RefCell<Option<String>>,
}

impl Source<'_> {
    fn attempt(&self, operation: impl FnOnce() -> Result<(), String>) {
        if self.failure.borrow().is_none() {
            if let Err(error) = operation() {
                *self.failure.borrow_mut() = Some(error);
            }
        }
    }
}

fn blank(version: i64) -> FlashcardSyncSnapshot {
    FlashcardSyncSnapshot {
        version,
        device_id: String::new(),
        exported_at: 0,
        folders: Vec::new(),
        decks: Vec::new(),
        cards: Vec::new(),
        reviews: Vec::new(),
        tombstones: Vec::new(),
        drafts: Vec::new(),
        quality_records: Vec::new(),
        scheduler_profiles: Vec::new(),
        study_settings: None,
    }
}

struct Items<'a> {
    source: &'a Source<'a>,
    field: &'a str,
}
impl<'de> DeserializeSeed<'de> for Items<'_> {
    type Value = bool;
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<bool, D::Error> {
        d.deserialize_seq(self)
    }
}
impl<'de> Visitor<'de> for Items<'_> {
    type Value = bool;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("snapshot record array")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<bool, A::Error> {
        let mut missing_profile = false;
        while let Some(v) = seq.next_element::<Value>()? {
            match self.field {
                "folders" => {
                    let value: FlashcardSnapshotFolder =
                        serde_json::from_value(v).map_err(A::Error::custom)?;
                    self.source.attempt(|| {
                        super::winner(
                            self.source.c,
                            self.source.ns,
                            self.source.batch,
                            self.field,
                            &value.id,
                            value.updated_at,
                            0,
                            "",
                            &value,
                        )
                    });
                }
                "decks" => {
                    let value: FlashcardSnapshotDeck =
                        serde_json::from_value(v).map_err(A::Error::custom)?;
                    self.source.attempt(|| {
                        super::winner(
                            self.source.c,
                            self.source.ns,
                            self.source.batch,
                            self.field,
                            &value.id,
                            value.updated_at,
                            0,
                            "",
                            &value,
                        )
                    });
                }
                "tombstones" => {
                    let value: FlashcardSnapshotTombstone =
                        serde_json::from_value(v).map_err(A::Error::custom)?;
                    self.source.attempt(|| {
                        super::winner(
                            self.source.c,
                            self.source.ns,
                            self.source.batch,
                            self.field,
                            &format!("{}:{}", value.entity_type, value.entity_id),
                            value.deleted_at,
                            0,
                            "",
                            &value,
                        )
                    });
                }
                "schedulerProfiles" => {
                    let p: flashcard_profiles::Profile =
                        serde_json::from_value(v).map_err(A::Error::custom)?;
                    self.source.attempt(|| {
                        p.validate()?;
                        super::winner(
                            self.source.c,
                            self.source.ns,
                            self.source.batch,
                            self.field,
                            &p.id,
                            0,
                            0,
                            &p.content_id()?,
                            &p,
                        )
                    });
                }
                "cards" => {
                    let card: FlashcardSnapshotCard =
                        serde_json::from_value(v).map_err(A::Error::custom)?;
                    let mut snapshot = blank(1);
                    snapshot.cards.push(card);
                    self.source
                        .attempt(|| flashcard_scheduler::validate_snapshot(&snapshot));
                }
                "reviews" => {
                    let review: FlashcardSnapshotReview =
                        serde_json::from_value(v).map_err(A::Error::custom)?;
                    missing_profile |=
                        review.scheduler_version == 1 && review.scheduler_profile_id.is_empty();
                    let mut snapshot = blank(1);
                    snapshot.reviews.push(review);
                    self.source
                        .attempt(|| flashcard_scheduler::validate_snapshot(&snapshot));
                }
                "drafts" => {
                    let _: flashcard_sync_drafts::SnapshotDraft =
                        serde_json::from_value(v).map_err(A::Error::custom)?;
                }
                "qualityRecords" => {}
                _ => return Err(A::Error::custom("恢复结构字段无效")),
            }
        }
        Ok(missing_profile)
    }
}

struct Keys<'a>(&'a Source<'a>);
impl<'de> DeserializeSeed<'de> for Keys<'_> {
    type Value = ();
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_seq(self)
    }
}
impl<'de> Visitor<'de> for Keys<'_> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("immutable object identities")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        while let Some(id) = seq.next_element::<String>()? {
            self.0.attempt(|| {super::candidate(self.0.c, self.0.ns, self.0.batch, &id, false)?;
            self.0.c.execute("INSERT OR IGNORE INTO flashcard_cloud_recovery_legacy_keys(namespace,batch,id) VALUES(?1,?2,?3)",params![self.0.ns,self.0.batch,id]).map(|_|()).map_err(|e|e.to_string())});
        }
        Ok(())
    }
}

struct Snapshot<'a>(&'a Source<'a>);
impl<'de> DeserializeSeed<'de> for Snapshot<'_> {
    type Value = ();
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_map(self)
    }
}
impl<'de> Visitor<'de> for Snapshot<'_> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("released flashcard snapshot")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        let mut seen = 0u16;
        let mut version = None;
        let mut device = None;
        let mut exported = None;
        let mut missing_profile = false;
        while let Some(field) = map.next_key::<String>()? {
            let bit = match field.as_str() {
                "version" => 0,
                "deviceId" => 1,
                "exportedAt" => 2,
                "studySettings" => 3,
                _ => match records::FIELDS.iter().position(|f| *f == field) {
                    Some(i) => i + 4,
                    None => {
                        map.next_value::<IgnoredAny>()?;
                        continue;
                    }
                },
            };
            if seen & (1 << bit) != 0 {
                return Err(A::Error::custom("duplicate snapshot field"));
            }
            seen |= 1 << bit;
            match field.as_str() {
                "version" => version = Some(map.next_value::<i64>()?),
                "deviceId" => device = Some(map.next_value::<String>()?),
                "exportedAt" => exported = Some(map.next_value::<i64>()?),
                "studySettings" => {
                    if let Some(value) = map.next_value::<Option<FlashcardStudySettings>>()? {
                        self.0.attempt(|| {
                            super::winner(
                                self.0.c,
                                self.0.ns,
                                self.0.batch,
                                &field,
                                &field,
                                value.updated_at,
                                value.daily_new_limit,
                                "",
                                &value,
                            )
                        });
                    }
                }
                _ => {
                    missing_profile |= map.next_value_seed(Items {
                        source: self.0,
                        field: &field,
                    })?
                }
            }
        }
        let version = version.ok_or_else(|| A::Error::custom("missing snapshot version"))?;
        let device = device.ok_or_else(|| A::Error::custom("missing snapshot deviceId"))?;
        let exported = exported.ok_or_else(|| A::Error::custom("missing snapshot exportedAt"))?;
        for required in ["decks", "cards", "reviews"] {
            let bit = records::FIELDS.iter().position(|f| *f == required).unwrap() + 4;
            if seen & (1 << bit) == 0 {
                return Err(A::Error::custom(format!("missing snapshot {required}")));
            }
        }
        if !(1..=4).contains(&version) || (version >= 4 && missing_profile) {
            self.0.attempt(|| Err("恢复结构的算法协议无效".into()));
        }
        self.0.attempt(||self.0.c.execute("UPDATE flashcard_cloud_recovery_batches SET snapshot_version=CASE WHEN context_present=0 THEN ?3 ELSE max(snapshot_version,?3) END,device_id=CASE WHEN context_present=0 THEN ?4 ELSE device_id END,exported_at=CASE WHEN context_present=0 THEN ?5 ELSE exported_at END,context_present=1 WHERE namespace=?1 AND batch=?2",params![self.0.ns,self.0.batch,version,device,exported]).map(|_|()).map_err(|e|e.to_string()));
        Ok(())
    }
}

struct OptionalSnapshot<'a>(&'a Source<'a>);
impl<'de> DeserializeSeed<'de> for OptionalSnapshot<'_> {
    type Value = bool;
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<bool, D::Error> {
        d.deserialize_option(self)
    }
}
impl<'de> Visitor<'de> for OptionalSnapshot<'_> {
    type Value = bool;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("optional snapshot")
    }
    fn visit_none<E: Error>(self) -> Result<bool, E> {
        Ok(false)
    }
    fn visit_unit<E: Error>(self) -> Result<bool, E> {
        Ok(false)
    }
    fn visit_some<D: serde::Deserializer<'de>>(self, d: D) -> Result<bool, D::Error> {
        Snapshot(self.0).deserialize(d).map(|_| true)
    }
}

struct Control<'a>(&'a Source<'a>);
impl<'de> DeserializeSeed<'de> for Control<'_> {
    type Value = ();
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_map(self)
    }
}
impl<'de> Visitor<'de> for Control<'_> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("released recovery envelope")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        let mut format = None;
        let mut version = None;
        let mut complete = false;
        let mut snapshot = false;
        let mut seen = 0u8;
        while let Some(key) = map.next_key::<String>()? {
            let bit = match key.as_str() {
                "format" => 0,
                "version" => 1,
                "snapshot" => 2,
                "keys" => 3,
                "complete" => 4,
                _ => {
                    map.next_value::<IgnoredAny>()?;
                    continue;
                }
            };
            if seen & (1 << bit) != 0 {
                return Err(A::Error::custom("duplicate control field"));
            }
            seen |= 1 << bit;
            match key.as_str() {
                "format" => format = Some(map.next_value::<String>()?),
                "version" => version = Some(map.next_value::<u32>()?),
                "snapshot" => snapshot = map.next_value_seed(OptionalSnapshot(self.0))?,
                "keys" => map.next_value_seed(Keys(self.0))?,
                "complete" => complete = map.next_value::<bool>()?,
                _ => unreachable!(),
            }
        }
        let format = format.ok_or_else(|| A::Error::custom("missing control format"))?;
        let version = version.ok_or_else(|| A::Error::custom("missing control version"))?;
        if seen & (1 << 3) == 0 {
            return Err(A::Error::custom("missing control keys"));
        }
        if format != "hub-flashcard-recovery-control" || !matches!(version, 1 | 2) {
            self.0.attempt(|| Err("恢复结构暂存版本不支持".into()));
        }
        complete |= version == 1;
        if complete && !snapshot {
            self.0.attempt(|| Err("完整恢复结构暂存为空".into()));
        }
        if complete {
            self.0.attempt(||self.0.c.execute("UPDATE flashcard_cloud_recovery_candidates SET validated=1 WHERE namespace=?1 AND batch=?2 AND EXISTS(SELECT 1 FROM flashcard_cloud_recovery_legacy_keys k WHERE k.namespace=flashcard_cloud_recovery_candidates.namespace AND k.batch=flashcard_cloud_recovery_candidates.batch AND k.id=flashcard_cloud_recovery_candidates.id)",params![self.0.ns,self.0.batch]).map(|_|()).map_err(|e|e.to_string()));
        }
        self.0.attempt(|| {
            self.0
            .c
            .execute(
                "DELETE FROM flashcard_cloud_recovery_legacy_keys WHERE namespace=?1 AND batch=?2",
                params![self.0.ns, self.0.batch],
            )
            .map(|_|()).map_err(|e|e.to_string())
        });
        Ok(())
    }
}

pub(super) fn migrate(c: &Connection, ns: &str, batch: &str) -> Result<(), String> {
    // The row handle is only a live SQLite BLOB address. Namespace remains the
    // durable key, and a later VACUUM cannot invalidate a persisted cursor.
    let row: Option<i64> = c
        .query_row(
            "SELECT rowid FROM flashcard_cloud_recovery_control WHERE namespace=?1",
            [ns],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(row) = row else {
        return Ok(());
    };
    for envelope in [true, false] {
        c.execute_batch("SAVEPOINT flashcard_recovery_legacy")
            .map_err(|e| e.to_string())?;
        let parsed = (|| {
            let blob = c
                .blob_open(
                    "main",
                    "flashcard_cloud_recovery_control",
                    "body",
                    row,
                    true,
                )
                .map_err(|e| (e.to_string(), false))?;
            let source = Source {
                c,
                ns,
                batch,
                failure: RefCell::new(None),
            };
            let mut de = serde_json::Deserializer::from_reader(std::io::BufReader::new(blob));
            let result = if envelope {
                Control(&source).deserialize(&mut de)
            } else {
                Snapshot(&source).deserialize(&mut de)
            };
            // Match released untagged DTO selection before applying semantics:
            // an unknown nested snapshot must not invalidate a legal bare DTO.
            result
                .and_then(|_| de.end())
                .map_err(|e| (e.to_string(), false))?;
            let failure = source.failure.borrow_mut().take();
            failure.map_or(Ok(()), |error| Err((error, true)))
        })();
        match parsed {
            Ok(()) => {
                c.execute_batch("RELEASE flashcard_recovery_legacy")
                    .map_err(|e| e.to_string())?;
                return Ok(());
            }
            Err((error, valid_shape)) => {
                c.execute_batch(
                    "ROLLBACK TO flashcard_recovery_legacy; RELEASE flashcard_recovery_legacy",
                )
                .map_err(|e| e.to_string())?;
                if !envelope || valid_shape {
                    return Err(format!("恢复结构暂存损坏；原记录已保留：{error}"));
                }
            }
        }
    }
    Err("恢复结构暂存损坏；原记录已保留".into())
}
