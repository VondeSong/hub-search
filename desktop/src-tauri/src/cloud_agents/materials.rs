use crate::*;
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Key {
    kind: String,
    id: String,
    library_id: Option<String>,
}

pub(super) fn list(root: &Path, kind: &str, query: &str, offset: u32) -> Result<Value, String> {
    if !matches!(kind, "document" | "journal") || query.chars().count() > 200 || offset > 10000 {
        return Err("资料查找范围无效".into());
    }
    let _permit = library_runtime::cached_read_permit(root)?;
    let c = source_evidence::open_read_database(root)?;
    if kind == "journal" && !c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='quick_journal_records')",[],|r|r.get::<_,bool>(0)).map_err(|e|e.to_string())? {
        return Ok(json!({"items":[],"more":false}));
    }
    let sql = if kind == "document" {
        "SELECT d.id,d.space_id,d.title,l.name,length(d.markdown),substr(d.markdown,1,140) FROM documents d JOIN libraries l ON l.id=d.space_id WHERE l.enabled=1 AND length(trim(d.markdown))>0 AND (instr(lower(d.title),lower(?1))>0 OR instr(lower(d.markdown),lower(?1))>0) ORDER BY d.title,d.space_id,d.id LIMIT 21 OFFSET ?2"
    } else {
        "SELECT id,NULL,substr(json_extract(payload,'$.text'),1,60),json_extract(payload,'$.date'),length(json_extract(payload,'$.text')),substr(json_extract(payload,'$.text'),1,140) FROM quick_journal_records WHERE instr(lower(json_extract(payload,'$.text')),lower(?1))>0 ORDER BY seq DESC LIMIT 21 OFFSET ?2"
    };
    let mut s = c.prepare(sql).map_err(|e| e.to_string())?;
    let rows = s.query_map(params![query.trim(), offset], |r| {
        let key = Key { kind: kind.into(), id: r.get(0)?, library_id: r.get(1)? };
        Ok(json!({"key":key,"title":r.get::<_,String>(2)?,"source":r.get::<_,String>(3)?,"chars":r.get::<_,i64>(4)?,"preview":r.get::<_,String>(5)?}))
    }).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    Ok(json!({"items":rows.iter().take(20).collect::<Vec<_>>(),"more":rows.len()>20}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_selection_rechecks_library_and_rejects_oversize_without_truncation() {
        let f = crate::source_evidence::tests::Fixture::new();
        f.note("notes", "current", "Source text");
        let selection = json!({"kind":"document","id":"current","libraryId":"notes"});
        let snapshot = prepare(&f.root, selection.clone()).unwrap();
        assert_eq!(snapshot["text"], "Source text");
        assert_eq!(
            snapshot["sha256"],
            format!("{:x}", Sha256::digest(b"Source text"))
        );
        f.c()
            .execute("UPDATE libraries SET enabled=0 WHERE id='notes'", [])
            .unwrap();
        assert!(prepare(&f.root, selection.clone()).is_err());
        assert!(list(&f.root, "document", "Source", 0).unwrap()["items"]
            .as_array()
            .unwrap()
            .is_empty());
        f.c()
            .execute("UPDATE libraries SET enabled=1 WHERE id='notes'", [])
            .unwrap();
        f.note("notes", "current", &"x".repeat(48001));
        assert!(prepare(&f.root, selection).unwrap_err().contains("48 KB"));
    }
}

pub(super) fn prepare(root: &Path, selection: Value) -> Result<Value, String> {
    let key: Key = serde_json::from_value(selection).map_err(|_| "资料定位无效")?;
    let _permit = library_runtime::cached_read_permit(root)?;
    let c = source_evidence::open_read_database(root)?;
    let (title, source, text): (String,String,String) = match key.kind.as_str() {
        "document" => c.query_row("SELECT d.title,l.name,d.markdown FROM documents d JOIN libraries l ON l.id=d.space_id WHERE d.id=?1 AND d.space_id=?2 AND l.enabled=1", params![key.id,key.library_id], |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))),
        "journal" if key.library_id.is_none() => c.query_row("SELECT substr(json_extract(payload,'$.text'),1,60),json_extract(payload,'$.date'),json_extract(payload,'$.text') FROM quick_journal_records WHERE id=?1",[&key.id], |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))),
        _ => return Err("资料类型无效".into()),
    }.map_err(|_| "这份资料尚未下载、已移除或不再可读，请重新选择")?;
    if text.trim().is_empty() || text.len() > 48000 || title.len() > 200 || source.len() > 200 {
        return Err("所选正文为空或超过 48 KB，请选择较短的已下载资料；不会自动截断原文".into());
    }
    Ok(
        json!({"id":format!("{:x}",Sha256::digest(serde_json::to_vec(&key).map_err(|e|e.to_string())?)),"title":title,"source":source,"text":text,"sha256":format!("{:x}",Sha256::digest(text.as_bytes()))}),
    )
}
