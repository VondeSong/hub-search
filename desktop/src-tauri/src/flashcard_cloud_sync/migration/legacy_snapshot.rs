//! WebDAV's released mutable snapshot is a bounded protocol object, not a history inventory.
use super::*;
use crate::flashcard_snapshot::records;
use serde::ser::{SerializeMap, SerializeSeq};
use std::io::Write;
struct Limited(Vec<u8>);
impl Write for Limited {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        if self.0.len().saturating_add(b.len()) > FLASHCARD_SYNC_MAX_SNAPSHOT_BYTES {
            return Err(std::io::Error::other("闪卡迁移快照超过 32 MB"));
        }
        self.0.extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
struct Domain<'a> {
    c: &'a Connection,
    field: &'a str,
}
impl Serialize for Domain<'_> {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut sequence = s.serialize_seq(None)?;
        records::visit(self.c, self.field, |record| {
            sequence
                .serialize_element(&record)
                .map_err(|e| e.to_string())
        })
        .map_err(serde::ser::Error::custom)?;
        sequence.end()
    }
}
struct Snapshot<'a> {
    c: &'a Connection,
    header: Value,
}
impl Serialize for Snapshot<'_> {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let fields = self
            .header
            .as_object()
            .ok_or_else(|| serde::ser::Error::custom("迁移快照头无效"))?;
        let mut object = s.serialize_map(Some(fields.len()))?;
        for (field, value) in fields {
            if records::FIELDS.contains(&field.as_str()) {
                object.serialize_entry(field, &Domain { c: self.c, field })?;
            } else {
                object.serialize_entry(field, value)?;
            }
        }
        object.end()
    }
}
pub(super) fn read(c: &Connection) -> Result<(FlashcardSyncSnapshot, Vec<u8>, String), String> {
    let mut empty = records::empty(c)?;
    empty.study_settings = records::study(c);
    let mut bytes = Limited(Vec::new());
    serde_json::to_writer(
        &mut bytes,
        &Snapshot {
            c,
            header: serde_json::to_value(empty).map_err(|e| e.to_string())?,
        },
    )
    .map_err(|e| e.to_string())?;
    let snapshot: FlashcardSyncSnapshot =
        serde_json::from_slice(&bytes.0).map_err(|e| e.to_string())?;
    flashcard_scheduler::validate_snapshot(&snapshot)?;
    Ok((snapshot, bytes.0, records::content_hash(c)?))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mutable_webdav_protocol_snapshot_matches_canonical_content_and_rejects_over_limit_before_full_materialization(
    ) {
        let c = initialize_database(&PathBuf::from(":memory:")).unwrap();
        c.execute(
            "INSERT INTO flashcard_decks(id,name,created_at,updated_at) VALUES('deck','Deck',1,1)",
            [],
        )
        .unwrap();
        c.execute("INSERT INTO flashcards(id,deck_id,question,answer,created_at,updated_at,due_at) VALUES('card','deck','Question','Answer',1,1,1)",[]).unwrap();
        let (snapshot, bytes, hash) = read(&c).unwrap();
        assert_eq!(
            content_identity(&snapshot).unwrap(),
            content_identity(&local_flashcard_snapshot(&c).unwrap()).unwrap()
        );
        assert_eq!(
            hash,
            hash_bytes(&serde_json::to_vec(&content_identity(&snapshot).unwrap()).unwrap())
        );
        assert!(serde_json::from_slice::<FlashcardSyncSnapshot>(&bytes).is_ok());
        // One formally stored record may exceed the legacy protocol budget. No whole-domain
        // vectors are collected before the streaming writer rejects the wire object.
        c.execute(
            "UPDATE flashcards SET answer=replace(hex(zeroblob(?1)),'00','xx')",
            [FLASHCARD_SYNC_MAX_SNAPSHOT_BYTES / 2],
        )
        .unwrap();
        assert!(read(&c).unwrap_err().contains("32 MB"));
    }
}
