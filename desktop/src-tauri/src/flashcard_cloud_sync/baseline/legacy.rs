//! One-pass read-only migration of complete released TEXT baseline snapshots.
use super::*;
use serde::de::{DeserializeSeed, Error, IgnoredAny, MapAccess, SeqAccess, Visitor};
use std::fmt;

struct Source<'a> {
    c: &'a Connection,
    ns: &'a str,
}
struct Items<'a> {
    source: &'a Source<'a>,
    field: &'a str,
}
impl<'de> DeserializeSeed<'de> for Items<'_> {
    type Value = ();
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_seq(self)
    }
}
impl<'de> Visitor<'de> for Items<'_> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("released baseline record array")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut rows: A) -> Result<(), A::Error> {
        while let Some(value) = rows.next_element::<Value>()? {
            let value = records::normalize(self.field, value).map_err(A::Error::custom)?;
            acknowledge(
                self.source.c,
                self.source.ns,
                self.field,
                &records::identity(self.field, &value),
                &value.to_string(),
            )
            .map_err(A::Error::custom)?;
        }
        Ok(())
    }
}
struct Snapshot<'a>(&'a Source<'a>);
impl<'de> DeserializeSeed<'de> for Snapshot<'_> {
    type Value = i64;
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<i64, D::Error> {
        d.deserialize_map(self)
    }
}
impl<'de> Visitor<'de> for Snapshot<'_> {
    type Value = i64;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("released baseline snapshot")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<i64, A::Error> {
        let mut seen = 0u16;
        let mut version = None;
        let mut study = false;
        while let Some(field) = map.next_key::<String>()? {
            let bit = match field.as_str() {
                "version" => 0,
                "deviceId" => 1,
                "exportedAt" => 2,
                "studySettings" => 3,
                _ => match records::FIELDS.iter().position(|v| *v == field) {
                    Some(i) => i + 4,
                    None => {
                        map.next_value::<IgnoredAny>()?;
                        continue;
                    }
                },
            };
            // SQLite json_extract/json_each used the first matching member in
            // the released importer. Later duplicates must retain that policy.
            if seen & (1 << bit) != 0 {
                map.next_value::<IgnoredAny>()?;
                continue;
            }
            seen |= 1 << bit;
            match field.as_str() {
                "version" => version = Some(map.next_value::<i64>()?),
                "deviceId" => {
                    map.next_value::<String>()?;
                }
                "exportedAt" => {
                    map.next_value::<i64>()?;
                }
                "studySettings" => {
                    let value = records::normalize("studySettings", map.next_value::<Value>()?)
                        .map_err(A::Error::custom)?;
                    acknowledge(
                        self.0.c,
                        self.0.ns,
                        "studySettings",
                        "studySettings",
                        &value.to_string(),
                    )
                    .map_err(A::Error::custom)?;
                    study = true;
                }
                _ => map.next_value_seed(Items {
                    source: self.0,
                    field: &field,
                })?,
            }
        }
        if seen & 7 != 7 {
            return Err(A::Error::custom("missing baseline identity header"));
        }
        for field in ["decks", "cards", "reviews"] {
            let bit = records::FIELDS.iter().position(|v| *v == field).unwrap() + 4;
            if seen & (1 << bit) == 0 {
                return Err(A::Error::custom(format!("missing baseline {field}")));
            }
        }
        if !study {
            let value =
                records::normalize("studySettings", Value::Null).map_err(A::Error::custom)?;
            acknowledge(
                self.0.c,
                self.0.ns,
                "studySettings",
                "studySettings",
                &value.to_string(),
            )
            .map_err(A::Error::custom)?;
        }
        version.ok_or_else(|| A::Error::custom("missing baseline version"))
    }
}

pub(super) fn import(c: &Connection, ns: &str, upload: Option<&str>) -> Result<i64, String> {
    let (table, column, sql) = if upload.is_some() {
        ("flashcard_cloud_uploads","baseline","SELECT rowid,typeof(baseline) FROM flashcard_cloud_uploads WHERE namespace=?1 AND id=?2")
    } else {
        ("flashcard_cloud_baselines","payload","SELECT rowid,typeof(payload) FROM flashcard_cloud_baselines WHERE namespace=?1 AND (?2 IS NULL)")
    };
    // This transaction-local row address is used only by SQLite's BLOB API;
    // namespace/upload ID remain the persisted identity before and after VACUUM.
    let (row, kind): (i64, String) = c
        .query_row(sql, params![ns, upload], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|_| "本机同步基线损坏，原记录已保留")?;
    if kind != "text" {
        return Err("本机同步基线损坏，原记录已保留".into());
    }
    c.execute(
        "DELETE FROM flashcard_cloud_resource_records WHERE namespace=?1",
        [ns],
    )
    .map_err(|e| e.to_string())?;
    let blob = c
        .blob_open("main", table, column, row, true)
        .map_err(|e| e.to_string())?;
    let source = Source { c, ns };
    let mut de = serde_json::Deserializer::from_reader(std::io::BufReader::new(blob));
    let version = Snapshot(&source)
        .deserialize(&mut de)
        .map_err(|e| format!("本机同步基线损坏，原记录已保留：{e}"))?;
    de.end()
        .map_err(|e| format!("本机同步基线损坏，原记录已保留：{e}"))?;
    Ok(version)
}
