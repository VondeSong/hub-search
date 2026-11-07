//! Snapshot comparison hashes serialize borrowed records into the hash stream.
//! Backup identity preserves the released struct field order. Content identity
//! preserves serde_json::Value's sorted map order, one record at a time.
use crate::flashcard_models::FlashcardSyncSnapshot;
use serde::{
    ser::{SerializeMap, SerializeSeq, SerializeStruct},
    Serialize, Serializer,
};
use sha2::{Digest, Sha256};
use std::io::{self, Write};

struct HashWriter(Sha256);
impl Write for HashWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn hash(value: &impl Serialize) -> Result<String, String> {
    let mut writer = HashWriter(Sha256::new());
    serde_json::to_writer(&mut writer, value).map_err(|e| e.to_string())?;
    Ok(format!("{:x}", writer.0.finalize()))
}
struct Backup<'a>(&'a FlashcardSyncSnapshot);
impl Serialize for Backup<'_> {
    fn serialize<S: Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        let s = self.0;
        let mut out = ser.serialize_struct("FlashcardSyncSnapshot", 12)?;
        out.serialize_field("version", &s.version)?;
        out.serialize_field("deviceId", &s.device_id)?;
        out.serialize_field("exportedAt", &0_i64)?;
        out.serialize_field("folders", &s.folders)?;
        out.serialize_field("tombstones", &s.tombstones)?;
        out.serialize_field("decks", &s.decks)?;
        out.serialize_field("cards", &s.cards)?;
        out.serialize_field("reviews", &s.reviews)?;
        out.serialize_field("studySettings", &s.study_settings)?;
        out.serialize_field("qualityRecords", &s.quality_records)?;
        out.serialize_field("drafts", &s.drafts)?;
        out.serialize_field("schedulerProfiles", &s.scheduler_profiles)?;
        out.end()
    }
}
struct CanonicalRecords<'a, T>(&'a [T]);
impl<T: Serialize> Serialize for CanonicalRecords<'_, T> {
    fn serialize<S: Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        let mut out = ser.serialize_seq(Some(self.0.len()))?;
        for record in self.0 {
            let value = serde_json::to_value(record).map_err(serde::ser::Error::custom)?;
            out.serialize_element(&value)?;
        }
        out.end()
    }
}
struct Content<'a>(&'a FlashcardSyncSnapshot);
impl Serialize for Content<'_> {
    fn serialize<S: Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        let s = self.0;
        let mut out = ser.serialize_map(Some(10))?;
        out.serialize_entry("cards", &CanonicalRecords(&s.cards))?;
        out.serialize_entry("decks", &CanonicalRecords(&s.decks))?;
        out.serialize_entry("drafts", &CanonicalRecords(&s.drafts))?;
        out.serialize_entry("folders", &CanonicalRecords(&s.folders))?;
        out.serialize_entry("qualityRecords", &s.quality_records)?;
        out.serialize_entry("reviews", &CanonicalRecords(&s.reviews))?;
        out.serialize_entry(
            "schedulerProfiles",
            &CanonicalRecords(&s.scheduler_profiles),
        )?;
        let settings =
            serde_json::to_value(&s.study_settings).map_err(serde::ser::Error::custom)?;
        out.serialize_entry("studySettings", &settings)?;
        out.serialize_entry("tombstones", &CanonicalRecords(&s.tombstones))?;
        out.serialize_entry("version", &s.version)?;
        out.end()
    }
}
pub(crate) fn backup(snapshot: &FlashcardSyncSnapshot) -> Result<String, String> {
    hash(&Backup(snapshot))
}
pub(crate) fn content(snapshot: &FlashcardSyncSnapshot) -> Result<String, String> {
    hash(&Content(snapshot))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{database::initialize_database, flashcard_snapshot::local_flashcard_snapshot};
    use std::path::PathBuf;
    #[test]
    fn streamed_identities_match_released_complete_serialization_and_all_tail_records() {
        let c = initialize_database(&PathBuf::from(":memory:")).unwrap();
        c.execute_batch("INSERT INTO flashcard_decks(id,name,created_at,updated_at) VALUES('root','Root',1,1),('child','Child',1,1); UPDATE flashcard_decks SET parent_deck_id='root' WHERE id='child';
            WITH RECURSIVE n(i) AS(SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<1200) INSERT INTO flashcards(id,deck_id,question,answer,created_at,updated_at,due_at) SELECT 'card-'||i,'child','Question '||i,'Answer',1,1,1 FROM n;").unwrap();
        let mut snapshot = local_flashcard_snapshot(&c).unwrap();
        snapshot.exported_at = 456;
        let mut legacy = snapshot.clone();
        legacy.exported_at = 0;
        assert_eq!(
            backup(&snapshot).unwrap(),
            format!("{:x}", Sha256::digest(serde_json::to_vec(&legacy).unwrap()))
        );
        let legacy = crate::flashcard_cloud_sync::content_identity(&snapshot).unwrap();
        assert_eq!(
            content(&snapshot).unwrap(),
            format!("{:x}", Sha256::digest(serde_json::to_vec(&legacy).unwrap()))
        );
        let before = content(&snapshot).unwrap();
        snapshot.device_id = "Another device".into();
        snapshot.exported_at += 1;
        assert_eq!(content(&snapshot).unwrap(), before);
        snapshot
            .cards
            .last_mut()
            .unwrap()
            .answer
            .push_str(" tail changed");
        assert_ne!(content(&snapshot).unwrap(), before);
    }
}
