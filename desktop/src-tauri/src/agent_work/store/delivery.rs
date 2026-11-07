//! Read durable partial work and previous deliveries without promoting either
//! to the current report. Every source is checked in the caller's snapshot.
use super::*;
use crate::source_evidence::EvidenceVersion;
use std::collections::HashSet;

fn records_on_run(c: &Connection, run: &str) -> Result<Vec<(String, Value)>, String> {
    let mut query = c
        .prepare("SELECT kind,body_json FROM agent_records WHERE run_id=?1 ORDER BY rowid LIMIT 64")
        .map_err(|e| e.to_string())?;
    let rows = query
        .query_map([run], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    rows.map(|row| {
        let (kind, body) = row.map_err(|e| e.to_string())?;
        let body = serde_json::from_str(&body).map_err(|_| "调查进展记录损坏")?;
        Ok((kind, body))
    })
    .collect()
}

fn candidate_valid(reader: &EvidenceReader, c: &Connection, candidate: &Value) -> bool {
    let Ok(locator) = serde_json::from_value::<EvidenceLocator>(candidate["locator"].clone())
    else {
        return false;
    };
    let Ok(version) = serde_json::from_value::<EvidenceVersion>(candidate["version"].clone())
    else {
        return false;
    };
    reader
        .verify_candidates_in_transaction(c, &[(locator, version)])
        .is_ok()
}

pub(super) fn read_on(
    root: &Path,
    c: &Connection,
    work: &Work,
    latest: Option<&Value>,
    delivery_reads: &mut super::delivery_read::DeliveryRead<'_>,
) -> Result<(Value, Vec<Value>), String> {
    if work.state == "revoked" {
        return Ok((Value::Null, Vec::new()));
    }
    let reader = work.grant.reader(root)?;
    let mut progress = Value::Null;
    if let Some(run_id) = latest.and_then(|run| run["id"].as_str()) {
        let (revision, authorization): (i64, i64) = c.query_row(
            "SELECT base_revision,authorization_version FROM agent_runs WHERE id=?1 AND work_id=?2",
            params![run_id, work.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).map_err(|e| e.to_string())?;
        if authorization == work.authorization_version {
            let mut evidence = Vec::new();
            let mut candidates = Vec::new();
            let mut intents = Vec::new();
            let mut searches = Vec::new();
            let mut seen = HashSet::new();
            let mut withheld = 0;
            for (kind, body) in records_on_run(c, run_id)? {
                match kind.as_str() {
                    "evidence" => {
                        let valid =
                            serde_json::from_value::<EvidenceExcerpt>(body["excerpt"].clone())
                                .is_ok_and(|excerpt| {
                                    reader.verify_in_transaction(c, &[excerpt]).is_ok()
                                });
                        if valid {
                            evidence.push(body);
                        } else {
                            withheld += 1;
                        }
                    }
                    "toolResult" => {
                        let Some(found) = body["search"]["candidates"].as_array() else {
                            continue;
                        };
                        let mut count = 0;
                        for candidate in found {
                            if candidate_valid(&reader, c, candidate) {
                                count += 1;
                                let key = candidate["locator"].to_string();
                                if seen.insert(key) && candidates.len() < 40 {
                                    candidates.push(candidate.clone());
                                }
                            } else {
                                withheld += 1;
                            }
                        }
                        searches.push(json!({"query":body["request"]["query"],"sourceKind":body["request"]["sourceKind"],"count":count}));
                    }
                    "intent" => intents.push(body),
                    _ => (),
                }
            }
            // Intent text and queries may describe an earlier source. They do
            // not have individual citations, so hide them if any dependency or
            // user decision changed. Valid source excerpts can still be used.
            if withheld > 0 || revision != work.revision {
                intents.clear();
                searches.clear();
            }
            progress = json!({"runId":run_id,"state":latest.map(|run|&run["state"]),"evidence":evidence,"candidates":candidates,"intents":intents,"searches":searches,"withheld":withheld,"validity":if withheld > 0 {"部分来源已变化或不可读取，旧内容已隐藏"} else {""}});
        }
    }

    let mut query = c.prepare("SELECT r.run_id,r.body_json,r.created_at,u.base_revision,u.authorization_version FROM agent_records r JOIN agent_runs u ON u.id=r.run_id WHERE r.work_id=?1 AND r.kind='delivery' ORDER BY r.rowid DESC LIMIT 3").map_err(|e| e.to_string())?;
    let saved = query
        .query_map([&work.id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut history = Vec::new();
    for (run_id, raw, created_at, revision, authorization) in saved {
        if work.report.is_some()
            && latest.is_some_and(|run| run["id"].as_str() == Some(run_id.as_str()))
        {
            continue;
        }
        let body: Value = serde_json::from_str(&raw).map_err(|_| "历史交付记录损坏")?;
        let verified = delivery_reads.verify(work, &run_id, &body, authorization);
        let (report, excerpts, validity, artifact_refs, artifact_state) = match verified {
            Ok((excerpts, projection)) => (
                body["report"].clone(),
                excerpts,
                if projection["state"] == "stale" {
                    projection["reason"]
                        .as_str()
                        .unwrap_or("图表已修订，回答需重新核对")
                        .to_owned()
                } else if revision != work.revision {
                    "你已补充或纠正决定；这是当时的结果，需要重新核对".to_owned()
                } else {
                    "这是上一轮已交付的结果，不代表本轮已经完成".to_owned()
                },
                projection["references"].clone(),
                projection["state"].clone(),
            ),
            Err(_) => (
                Value::Null,
                Vec::new(),
                "来源、授权或图表版本证据不可用，历史正文已隐藏".into(),
                json!([]),
                json!("unavailable"),
            ),
        };
        history.push(json!({"runId":run_id,"createdAt":created_at,"report":report,"evidence":excerpts,"validity":validity,"artifactRefs":artifact_refs,"artifactState":artifact_state}));
    }
    Ok((progress, history))
}
