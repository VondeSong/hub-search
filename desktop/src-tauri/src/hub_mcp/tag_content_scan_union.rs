//! Desktop-confirmed union scope; never changes an existing manifest.
use super::*;

pub(super) fn enabled(r: &Value) -> bool {
    r["manifestMode"] == "union"
}

pub(super) fn configure(c: &Connection, r: &Value, a: &Value) -> Result<(), String> {
    let Some(tags) = a.get("unionTags").filter(|v| !v.is_null()) else {
        return Ok(());
    };
    let dummy =
        json!({"entityId":"","libraryId":"","sourceHash":"","sourceTags":[],"internalTags":[]});
    let contexts =
        joint::contexts(c, r, &json!({"additionalTags":tags}), &dummy)?.ok_or("缺少联合选择")?;
    let snapshots=json!(contexts.as_array().unwrap().iter().map(|v|json!({"tag":v["tag"],"definitionVersion":v["definitionVersion"],"definition":v["definition"]})).collect::<Vec<_>>());
    c.execute(
        "INSERT INTO tag_content_scan_joint_selections(run_id,contexts_json) VALUES (?1,?2)",
        params![r["runId"].as_str(), snapshots.to_string()],
    )
    .map_err(|e| e.to_string())?;
    c.execute(
        "UPDATE tag_content_scan_runs SET manifest_mode='union' WHERE id=?1",
        [r["runId"].as_str()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub(super) fn scope(c: &Connection, r: &Value) -> Result<Value, String> {
    let mut libs = r["definition"]["definition"]["libraryIds"]
        .as_array()
        .ok_or("定义范围无效")?
        .clone();
    if enabled(r) {
        for tag in joint::selection(c, r)?.as_array().ok_or("联合选择不存在")? {
            libs.extend(
                tag["definition"]["libraryIds"]
                    .as_array()
                    .ok_or("额外范围无效")?
                    .clone(),
            );
        }
    }
    libs.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
    libs.dedup();
    Ok(json!(libs))
}

pub(super) fn primary_status(c: &Connection, r: &Value, e: &Value) -> Result<&'static str, String> {
    if !r["definition"]["definition"]["libraryIds"]
        .as_array()
        .ok_or("定义范围无效")?
        .contains(&e["libraryId"])
    {
        return Ok("out_of_scope");
    }
    if tag_assignment::exclusion_state(
        c,
        r["tag"].as_str().unwrap(),
        e["entityId"].as_str().unwrap(),
    )?["excluded"]
        == true
    {
        return Ok("excluded");
    }
    if ["sourceTags", "internalTags"].iter().any(|k| {
        e[k].as_array().is_some_and(|tags| {
            tags.iter().any(|t| {
                t.as_str()
                    .is_some_and(|t| t.to_lowercase() == r["tag"].as_str().unwrap())
            })
        })
    }) {
        return Ok("already_tagged");
    }
    Ok("eligible")
}

pub(super) fn unavailable(c: &Connection, r: &Value, ordinal: u64) -> Result<(), String> {
    if !enabled(r) {
        return Ok(());
    }
    for tag in joint::selection(c, r)?.as_array().ok_or("联合选择不存在")? {
        c.execute("INSERT INTO tag_content_scan_joint_items(run_id,ordinal,tag,state,source_hash) VALUES (?1,?2,?3,'unavailable','') ON CONFLICT(run_id,ordinal,tag) DO UPDATE SET state='unavailable',proposal_id='',source_hash=''",params![r["runId"].as_str(),ordinal,tag["tag"].as_str()]).map_err(|e|e.to_string())?;
    }
    Ok(())
}

pub(super) fn changed(c: &Connection, r: &Value, ordinal: u64, e: &Value) -> Result<bool, String> {
    if !enabled(r) {
        return Ok(false);
    }
    let old:Option<String>=c.query_row("SELECT json_extract(response_json,'$.result.evidence.primaryTagStatus') FROM tag_content_scan_receipts WHERE run_id=?1 AND json_extract(response_json,'$.result.ordinal')=?2 AND json_extract(response_json,'$.result.evidence.sourceHash')=?3 AND json_extract(response_json,'$.result.evidence.primaryTagStatus') IS NOT NULL AND json_extract(response_json,'$.run.version')>(SELECT reopened_version FROM tag_content_scan_items WHERE run_id=?1 AND ordinal=?2) ORDER BY json_extract(response_json,'$.run.version') DESC LIMIT 1",params![r["runId"].as_str(),ordinal,e["sourceHash"].as_str()],|row|row.get(0)).optional().map_err(|e|e.to_string())?;
    Ok(old.is_some_and(|v| primary_status(c, r, e).is_ok_and(|s| s != v)))
}
