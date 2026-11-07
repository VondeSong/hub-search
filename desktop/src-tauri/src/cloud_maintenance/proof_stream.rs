//! The released proof stays one bounded JSON object; its manifest is consumed item by item.
use super::checkpoint::Replacement;
use super::*;
use serde::de::{DeserializeSeed, MapAccess, SeqAccess, Visitor};
use std::io::{BufReader, Read, Write};
#[cfg(test)]
mod tests;

pub(super) struct HashWriter(pub Sha256);
impl Write for HashWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
impl HashWriter {
    pub(super) fn new() -> Self {
        Self(Sha256::new())
    }
    pub(super) fn finish(self) -> String {
        format!("{:x}", self.0.finalize())
    }
}
struct Bounded(Vec<u8>);
impl Write for Bounded {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) > ROUND_BYTES {
            return Err(std::io::Error::other("检查点索引超过大小上限，历史仍保留"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn output(w: &mut impl Write, value: &impl Serialize) -> Result<(), String> {
    serde_json::to_writer(w, value).map_err(|e| e.to_string())
}
fn bytes(w: &mut impl Write, value: &[u8]) -> Result<(), String> {
    w.write_all(value).map_err(|e| e.to_string())
}

pub(super) fn build(c: &Connection, ns: &str, id: &str, device: &str) -> Result<String, String> {
    let mut coverage = HashWriter::new();
    bytes(&mut coverage, b"[")?;
    let mut count = 0usize;
    let mut q=c.prepare("SELECT key,body FROM cloud_maintenance_objects WHERE namespace=?1 AND run=?2 AND replacement=0 ORDER BY key").map_err(|e|e.to_string())?;
    let mut rows = q.query(params![ns, id]).map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let key: String = row.get(0).map_err(|e| e.to_string())?;
        let body: Vec<u8> = row.get(1).map_err(|e| e.to_string())?;
        if count > 0 {
            bytes(&mut coverage, b",")?;
        }
        output(&mut coverage, &(key, digest(&body)))?;
        count = count.checked_add(1).ok_or("覆盖对象计数溢出")?;
    }
    drop(rows);
    drop(q);
    bytes(&mut coverage, b"]")?;
    let mut w = Bounded(Vec::new());
    bytes(&mut w, b"{\"format\":1,\"generation\":")?;
    output(&mut w, &id)?;
    bytes(&mut w, b",\"namespaceHash\":")?;
    output(&mut w, &digest(ns.as_bytes()))?;
    bytes(&mut w, b",\"device\":")?;
    output(&mut w, &device)?;
    bytes(&mut w, b",\"createdAt\":")?;
    output(&mut w, &now_timestamp())?;
    bytes(&mut w, b",\"coveredHash\":")?;
    output(&mut w, &coverage.finish())?;
    bytes(&mut w, b",\"coveredObjects\":")?;
    output(&mut w, &count)?;
    bytes(&mut w, b",\"replacements\":[")?;
    let mut q=c.prepare("SELECT key,kind,body FROM cloud_maintenance_objects WHERE namespace=?1 AND run=?2 AND replacement=1 ORDER BY kind,key").map_err(|e|e.to_string())?;
    let mut rows = q.query(params![ns, id]).map_err(|e| e.to_string())?;
    let mut replacements = 0usize;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        if replacements == MAX_OBJECTS {
            return Err("检查点证明超过单个证明对象的安全上限".into());
        }
        let body: Vec<u8> = row.get(2).map_err(|e| e.to_string())?;
        let item = Replacement {
            key: row.get(0).map_err(|e| e.to_string())?,
            kind: row.get(1).map_err(|e| e.to_string())?,
            hash: digest(&body),
        };
        if replacements > 0 {
            bytes(&mut w, b",")?;
        }
        output(&mut w, &item)?;
        replacements += 1;
    }
    if replacements == 0 {
        return Err("检查点证明没有替代对象".into());
    }
    bytes(&mut w, b"]}")?;
    String::from_utf8(w.0).map_err(|e| e.to_string())
}

struct Replacements<'a, F> {
    action: &'a mut F,
}
impl<'de, F: FnMut(&Replacement) -> Result<(), String>> DeserializeSeed<'de>
    for Replacements<'_, F>
{
    type Value = usize;
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<usize, D::Error> {
        d.deserialize_seq(self)
    }
}
impl<'de, F: FnMut(&Replacement) -> Result<(), String>> Visitor<'de> for Replacements<'_, F> {
    type Value = usize;
    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("a bounded replacement manifest")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<usize, A::Error> {
        let mut count = 0usize;
        while let Some(item) = seq.next_element::<Replacement>()? {
            if count == MAX_OBJECTS {
                return Err(serde::de::Error::custom("单个检查点证明超过安全上限"));
            }
            (self.action)(&item).map_err(serde::de::Error::custom)?;
            count += 1;
        }
        if count == 0 {
            return Err(serde::de::Error::custom("检查点证明没有替代对象"));
        }
        Ok(count)
    }
}
struct Manifest<'a, F> {
    ns: &'a str,
    id: &'a str,
    action: &'a mut F,
}
impl<'de, F: FnMut(&Replacement) -> Result<(), String>> DeserializeSeed<'de> for Manifest<'_, F> {
    type Value = ();
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_map(self)
    }
}
impl<'de, F: FnMut(&Replacement) -> Result<(), String>> Visitor<'de> for Manifest<'_, F> {
    type Value = ();
    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("a complete checkpoint proof")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        let mut seen = 0u16;
        let mut format = 0u32;
        let mut generation = String::new();
        let mut namespace = String::new();
        let mut covered = String::new();
        while let Some(key) = map.next_key::<String>()? {
            let bit = match key.as_str() {
                "format" => 1,
                "generation" => 2,
                "namespaceHash" => 4,
                "device" => 8,
                "createdAt" => 16,
                "coveredHash" => 32,
                "coveredObjects" => 64,
                "replacements" => 128,
                _ => return Err(serde::de::Error::custom("检查点证明包含未知字段")),
            };
            if seen & bit != 0 {
                return Err(serde::de::Error::custom("检查点证明包含重复字段"));
            }
            seen |= bit;
            match bit {
                1 => format = map.next_value()?,
                2 => generation = map.next_value()?,
                4 => namespace = map.next_value()?,
                8 => {
                    let _: String = map.next_value()?;
                }
                16 => {
                    let _: i64 = map.next_value()?;
                }
                32 => covered = map.next_value()?,
                64 => {
                    let _: usize = map.next_value()?;
                }
                128 => {
                    map.next_value_seed(Replacements {
                        action: &mut *self.action,
                    })?;
                }
                _ => unreachable!(),
            }
        }
        if seen != 255
            || format != 1
            || generation != self.id
            || namespace != digest(self.ns.as_bytes())
            || !valid_hash(&generation)
            || !valid_hash(&covered)
        {
            return Err(serde::de::Error::custom("检查点证明无效"));
        }
        Ok(())
    }
}
fn identity(c: &Connection, ns: &str, id: &str) -> Result<i64, String> {
    let (row,size,kind):(i64,i64,String)=c.query_row("SELECT rowid,length(CAST(proof AS BLOB)),typeof(proof) FROM cloud_maintenance_runs WHERE namespace=?1 AND id=?2",params![ns,id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|e|e.to_string())?;
    if size <= 0 || size as u64 > ROUND_BYTES as u64 || kind != "text" {
        return Err("检查点证明尚未准备好或超过安全大小".into());
    }
    Ok(row)
}
pub(super) fn each(
    c: &Connection,
    ns: &str,
    id: &str,
    mut action: impl FnMut(&Replacement) -> Result<(), String>,
) -> Result<(), String> {
    let row = identity(c, ns, id)?;
    let blob = c
        .blob_open("main", "cloud_maintenance_runs", "proof", row, true)
        .map_err(|e| e.to_string())?;
    let mut d = serde_json::Deserializer::from_reader(BufReader::new(blob));
    Manifest {
        ns,
        id,
        action: &mut action,
    }
    .deserialize(&mut d)
    .map_err(|e| e.to_string())?;
    d.end().map_err(|e| e.to_string())
}
pub(super) fn body(c: &Connection, ns: &str, id: &str) -> Result<Vec<u8>, String> {
    each(c, ns, id, |_| Ok(()))?;
    let row = identity(c, ns, id)?;
    let mut blob = c
        .blob_open("main", "cloud_maintenance_runs", "proof", row, true)
        .map_err(|e| e.to_string())?;
    let mut body = Vec::new();
    blob.read_to_end(&mut body).map_err(|e| e.to_string())?;
    Ok(body)
}
