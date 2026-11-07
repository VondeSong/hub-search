//! Version-bound metadata discovery within an existing grant. Not a new grant.
use super::*;
use serde::Deserialize;
const PREFIX: &str = "source-manifest-v1:";
const MAX_PAGE_BYTES: usize = 48 * 1024;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    library_id: String,
    directory: Option<String>,
    date_from: Option<String>,
    date_to: Option<String>,
    cursor: Option<String>,
    limit: Option<usize>,
}
fn relative(value: &str) -> Result<String, String> {
    let path = value.replace('\\', "/");
    if path.len() > 1024
        || path.trim() != path
        || path.starts_with('/')
        || path.contains(':')
        || path
            .split('/')
            .any(|p| p == ".." || p == "." || (!path.is_empty() && p.is_empty()))
    {
        return Err("目录或来源路径必须是资料库内的规范相对路径".into());
    }
    Ok(path)
}
fn date(value: &str) -> Option<String> {
    if value.len() != 10 {
        return None;
    }
    let parsed = chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()?;
    (parsed.format("%Y-%m-%d").to_string() == value).then(|| value.to_string())
}
fn file_date(path: &str) -> Option<String> {
    let file = path.rsplit('/').next()?;
    let (stem, extension) = file.rsplit_once('.')?;
    if !extension.eq_ignore_ascii_case("md") {
        return None;
    }
    date(stem)
}
pub(super) fn is_manifest(value: &Value) -> bool {
    value.as_str().is_some_and(|s| s.starts_with(PREFIX))
}
pub(super) fn page_on(
    reader: &EvidenceReader,
    c: &Connection,
    visible: &[String],
    args: &Value,
) -> Result<Value, String> {
    let request: Request = serde_json::from_value(args.clone()).map_err(|_| "材料清单参数无效")?;
    if request.library_id.is_empty() || request.library_id.len() > 1024 {
        return Err("材料清单需要明确资料库".into());
    }
    reader.scope.in_library(&request.library_id)?;
    if !visible.contains(&request.library_id) {
        return Err("材料清单来源当前不可用".into());
    }
    let provider: String = c
        .query_row(
            "SELECT provider FROM libraries WHERE id=?1",
            [&request.library_id],
            |r| r.get(0),
        )
        .map_err(|_| "资料库不存在")?;
    if provider != "obsidian" {
        return Err("当前目录/文件名日期清单只支持已授权的 Obsidian 来源".into());
    }
    let directory = relative(request.directory.as_deref().unwrap_or(""))?;
    for value in [&request.date_from, &request.date_to].into_iter().flatten() {
        if date(value).is_none() {
            return Err("文件名日期边界需要有效的 YYYY-MM-DD".into());
        }
    }
    if request
        .date_from
        .as_ref()
        .zip(request.date_to.as_ref())
        .is_some_and(|(a, b)| a > b)
    {
        return Err("起始日期不能晚于结束日期".into());
    }
    let limit = request.limit.unwrap_or(30);
    if !(1..=50).contains(&limit) {
        return Err("每页清单数量需要1至50".into());
    }
    let scope = fingerprint(
        &json!({"libraries":reader.scope.library_ids,"notes":reader.scope.notes,"sources":reader.scope.sources,"attachments":reader.scope.attachment_library_ids,"reading":reader.scope.reading_item_keys}),
    );
    let filter = json!({"libraryId":request.library_id,"directory":directory,"dateFrom":request.date_from,"dateTo":request.date_to,"dateBasis":"exactISODateMarkdownFileName","pathCase":"preservedExact"});
    let all = sources(reader, c, visible, &json!({"libraryId":request.library_id}))?;
    let mut directory_sources = Vec::new();
    let mut members = Vec::new();
    let mut undated = 0usize;
    let mut dated = 0usize;
    let mut excluded_dates = 0usize;
    for source in all {
        reader.checkpoint()?;
        let path = relative(&source.path)?;
        if !directory.is_empty() && !path.starts_with(&(directory.clone() + "/")) {
            continue;
        }
        let source_date = file_date(&path);
        directory_sources.push(source.clone());
        if source_date.is_some() {
            dated += 1;
        } else {
            undated += 1;
        }
        let selected = match &source_date {
            Some(d) => {
                request.date_from.as_ref().is_none_or(|f| d >= f)
                    && request.date_to.as_ref().is_none_or(|t| d <= t)
            }
            None => request.date_from.is_none() && request.date_to.is_none(),
        };
        if !selected {
            excluded_dates += 1;
            continue;
        }
        members.push(json!({"locator":source.locator,"title":source.title,"path":path,"sourceRevision":source.version,"fileDate":source_date}));
    }
    let id = format!(
        "{PREFIX}{}",
        fingerprint(
            &json!({"schemaVersion":1,"scopeRevision":scope,"filter":filter,"directorySources":directory_sources})
        )
    );
    let offset = if let Some(cursor) = request.cursor.as_deref() {
        let (base, index) = cursor.rsplit_once(':').ok_or("材料清单游标无效")?;
        if base != id {
            return Err("材料清单范围、成员或版本已变化，请重新枚举；未合并不同清单".into());
        }
        index.parse::<usize>().map_err(|_| "材料清单游标无效")?
    } else {
        0
    };
    if offset > members.len() {
        return Err("材料清单游标超过当前范围".into());
    }
    let page = members
        .iter()
        .skip(offset)
        .take(limit)
        .cloned()
        .collect::<Vec<_>>();
    let end = offset + page.len();
    let result = json!({"schemaVersion":1,"snapshot":id,"scopeRevision":scope,"selection":filter,"members":page,"totalMembers":members.len(),"offset":offset,"nextCursor":if end<members.len(){Some(format!("{id}:{end}"))}else{None},
  "dateCoverage":{"directoryMembers":directory_sources.len(),"datedMembers":dated,"unknownDateMembers":undated,"excludedByDateSelection":excluded_dates},
  "bodyRead":false,"extractedMembers":null,"coverage":"authorizedLocalCacheMetadata","sourceFreshness":"notVerifiedWithRemote","consistency":"versionBoundLiveManifest; changed membership or source revision rejects old cursor","authorization":"selection intersects existing grant; does not grant directory or library access"});
    if result.to_string().len() > MAX_PAGE_BYTES {
        return Err("材料清单单页超过48KiB，请减小页大小；未截断成员".into());
    }
    Ok(result)
}
pub(super) fn execute(reader: &EvidenceReader, args: &Value) -> Result<Value, String> {
    reader.in_snapshot(|c, visible| page_on(reader, c, visible, args))
}
pub(super) fn verify(
    reader: &EvidenceReader,
    c: &Connection,
    visible: &[String],
    args: &Value,
    expected: &Value,
) -> Result<(), String> {
    let mut args = args.clone();
    let object = args.as_object_mut().ok_or("材料清单依赖无效")?;
    object.remove("cursor");
    object.insert("limit".into(), json!(1));
    if page_on(reader, c, visible, &args)?["snapshot"] != *expected {
        return Err("材料清单来源已变化，旧结论需要重新核对".into());
    }
    Ok(())
}
#[cfg(test)]
mod tests;
