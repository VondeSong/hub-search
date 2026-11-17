//! Coverage is a projection of recorded reads, never an estimate of unseen sources.
use super::*;
fn union(mut ranges: Vec<(u64, u64)>) -> Vec<(u64, u64)> {
    ranges.sort_unstable();
    let mut result: Vec<(u64, u64)> = Vec::new();
    for (start, end) in ranges {
        if end <= start {
            continue;
        }
        if let Some(last) = result.last_mut().filter(|v| start <= v.1) {
            last.1 = last.1.max(end);
        } else {
            result.push((start, end));
        }
    }
    result
}
fn project(rows: &[(String, String, Value)], omitted: bool) -> Value {
    let sent: std::collections::HashSet<_> = rows
        .iter()
        .filter(|(_, kind, v)| {
            (kind == "nativeProtocol" && v["stage"] == "inputSent")
                || (kind == "nativeMeasurement"
                    && v["provider"]["inputSent"]["adapter"]["stage"] == "inputSent")
        })
        .map(|(run, _, _)| run.clone())
        .collect();
    let mut texts: std::collections::BTreeMap<String, Value> = Default::default();
    let mut ranges: HashMap<String, Vec<(u64, u64)>> = HashMap::new();
    let mut images: std::collections::BTreeMap<String, Value> = Default::default();
    let mut calculations = Vec::new();
    let mut failures = Vec::new();
    for (run, kind, v) in rows {
        if kind == "evidence" {
            let e = &v["excerpt"];
            let (Some(start), Some(end), Some(total)) = (
                e["startChar"].as_u64(),
                e["endChar"].as_u64(),
                e["totalChars"].as_u64(),
            ) else {
                continue;
            };
            if end > total || start > end || !e["locator"].is_object() {
                continue;
            }
            let key = json!([e["locator"], e["version"]]).to_string();
            texts.entry(key.clone()).or_insert_with(||json!({"locator":e["locator"],"version":e["version"],"title":e["title"],"totalChars":total,"meaning":"Exact character ranges recorded for this source version. Revalidate before using as current evidence."}));
            ranges.entry(key).or_default().push((start, end));
        } else if kind == "nativeImages" {
            for value in v["images"].as_array().into_iter().flatten() {
                let key = value["grant"].to_string();
                let mut image = json!({"title":value["title"],"grant":value["grant"],"page":value["page"],"width":value["width"],"height":value["height"],"bytes":value["bytes"],"sentToModel":sent.contains(run),"meaning":"Prepared pixels; sentToModel requires the matching inputSent transport receipt. No claim about unread images/pages or interpretation accuracy."});
                if images
                    .get(&key)
                    .is_some_and(|old| old["sentToModel"] == true)
                {
                    image["sentToModel"] = json!(true);
                }
                images.insert(key, image);
            }
        } else if matches!(kind.as_str(), "analysisExecution" | "analysisInspection") {
            calculations.push(json!({"executionId":v["executionId"],"inputFiles":v["inputs"].as_array().map(|a|a.iter().map(|f|json!({"title":f["title"],"sha256":f["sha256"]})).collect::<Vec<_>>()),"outputFiles":v["files"],"reportedCoverage":v["output"]["output"]["coverage"],"meaning":"Actual execution on read-only file copies. Row/cell coverage is unknown unless separately reported and checked; no assumption that all rows were read."}));
        } else if kind == "selectedMaterialReadError" {
            failures.push(json!({"locator":v["locator"],"error":v["readError"]}));
        }
    }
    for (key, value) in &mut texts {
        let spans = union(ranges.remove(key).unwrap_or_default());
        let count: u64 = spans.iter().map(|(a, b)| b - a).sum();
        value["ranges"] = json!(spans);
        value["readChars"] = json!(count);
        value["complete"] = json!(
            count == value["totalChars"].as_u64().unwrap_or(u64::MAX)
                && spans.first().is_none_or(|p| p.0 == 0)
        );
    }
    json!({"schemaVersion":1,"texts":texts.into_values().collect::<Vec<_>>(),"images":images.into_values().collect::<Vec<_>>(),"fileExecutions":calculations,"failedReads":failures,"earlierRecordsOmitted":omitted,"totalCandidates":null,"meaning":"Recorded coverage in current authorization, not a complete inventory of everything in a library. Search hits, downloaded files, read text, transmitted pixels and computed files are distinct facts."})
}
pub(super) fn read_on(root: &Path, c: &Connection, work: &Work) -> Result<Value, String> {
    if work.state == "revoked" {
        return Ok(json!({"schemaVersion":1,"revoked":true}));
    }
    static CACHE: OnceLock<Mutex<HashMap<(PathBuf, String), (i64, i64, Value)>>> = OnceLock::new();
    let relevant="a.work_id=?1 AND r.authorization_version=?2 AND a.kind IN ('evidence','nativeImages','nativeProtocol','nativeMeasurement','analysisExecution','analysisInspection','selectedMaterialReadError')";
    let watermark:i64=c.query_row(&format!("SELECT COALESCE(MAX(a.rowid),0) FROM agent_records a JOIN agent_runs r ON r.id=a.run_id WHERE {relevant}"),params![work.id,work.authorization_version],|r|r.get(0)).map_err(|e|e.to_string())?;
    let key = (root.to_owned(), work.id.clone());
    if let Some((last, authorization, value)) = CACHE
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "覆盖缓存不可用")?
        .get(&key)
    {
        if *last == watermark && *authorization == work.authorization_version {
            return Ok(value.clone());
        }
    }
    let mut q=c.prepare(&format!("SELECT a.run_id,a.kind,CASE WHEN a.kind='evidence' THEN json_remove(a.body_json,'$.excerpt.content','$.excerpt.body','$.excerpt.text') WHEN a.kind IN ('analysisExecution','analysisInspection') THEN json_object('executionId',json_extract(a.body_json,'$.executionId'),'inputs',json_extract(a.body_json,'$.inputs'),'files',json_extract(a.body_json,'$.files'),'output',json_object('output',json_object('coverage',json_extract(a.body_json,'$.output.output.coverage')))) ELSE a.body_json END FROM agent_records a JOIN agent_runs r ON r.id=a.run_id WHERE {relevant} ORDER BY a.rowid DESC LIMIT 1025")).map_err(|e|e.to_string())?;
    let mut rows = q
        .query_map(params![work.id, work.authorization_version], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .map(|r| {
            let (a, b, raw) = r.map_err(|e| e.to_string())?;
            Ok((
                a,
                b,
                serde_json::from_str(&raw).map_err(|_| "覆盖记录损坏")?,
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let omitted = rows.len() > 1024;
    rows.truncate(1024);
    rows.reverse();
    let value = project(&rows, omitted);
    let mut cache = CACHE
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "覆盖缓存不可用")?;
    if cache.len() >= 64 {
        if let Some(key) = cache.keys().next().cloned() {
            cache.remove(&key);
        }
    }
    cache.insert(key, (watermark, work.authorization_version, value.clone()));
    Ok(value)
}
pub(super) fn context(root: &Path, work: &Work) -> Result<Value, String> {
    let c = crate::source_evidence::open_read_database(root)?;
    let mut value = read_on(root, &c, work)?;
    for field in ["texts", "images", "fileExecutions", "failedReads"] {
        if let Some(rows) = value[field].as_array_mut() {
            let omitted = rows.len().saturating_sub(16);
            rows.truncate(16);
            value[format!("{field}Omitted")] = json!(omitted);
        }
    }
    Ok(value)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn overlap_and_preparation_do_not_inflate_read_or_pixel_coverage() {
        let mut rows = vec![];
        for (a, b) in [(0, 10), (5, 15), (0, 10)] {
            rows.push(("r".into(),"evidence".into(),json!({"excerpt":{"locator":{"kind":"note","libraryId":"x","documentId":"y"},"version":"v1","title":"资料","startChar":a,"endChar":b,"totalChars":20}})));
        }
        rows.push((
            "r".into(),
            "nativeImages".into(),
            json!({"images":[{"grant":{"id":"pixels"},"page":1}]}),
        ));
        let partial = project(&rows, false);
        assert_eq!(partial["texts"][0]["readChars"], 15);
        assert_eq!(partial["texts"][0]["complete"], false);
        assert_eq!(partial["images"][0]["sentToModel"], false);
        assert!(partial["totalCandidates"].is_null());
        rows.push((
            "r".into(),
            "nativeProtocol".into(),
            json!({"stage":"inputSent"}),
        ));
        rows.push(("r".into(),"evidence".into(),json!({"excerpt":{"locator":{"kind":"note","libraryId":"x","documentId":"y"},"version":"v1","title":"资料","startChar":15,"endChar":20,"totalChars":20}})));
        let full = project(&rows, true);
        assert_eq!(full["texts"][0]["complete"], true);
        assert_eq!(full["images"][0]["sentToModel"], true);
        assert_eq!(full["earlierRecordsOmitted"], true);
    }
}
