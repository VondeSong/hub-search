//! Processing instructions are versioned methods, never factual citations.
use super::*;
use crate::{agent_work::skills::Catalog, knowledge_rules::Rules};
use std::collections::BTreeMap;

fn entries(value: &Value) -> Result<&[Value], String> {
    if value.is_null() {
        return Ok(&[]);
    }
    value
        .as_array()
        .filter(|v| v.len() <= 128)
        .map(Vec::as_slice)
        .ok_or("分析方法依赖损坏或超过容量".into())
}

fn rules(root: &Path, work: &Work) -> Result<Rules, String> {
    Rules::new(root, current_reader(root, work)?.catalog()?, false)
}

fn skill(catalog: &mut Option<Catalog>, root: &Path, entry: &Value) -> Result<Value, String> {
    if catalog.is_none() {
        *catalog = Some(Catalog::discover(root)?);
    }
    let catalog = catalog.as_mut().unwrap();
    let name = text(entry, "name", 150)?;
    let loaded = catalog.load(&name, "")?;
    if entry["kind"] == "skillReference" {
        let path = text(entry, "path", 1000)?;
        let reference = catalog.read_reference(&name, &path)?;
        Ok(
            json!({"kind":"skillReference","name":name,"path":path,"version":reference["version"],"skillVersion":loaded["skill"]["version"],"title":entry["title"]}),
        )
    } else {
        Ok(
            json!({"kind":"skillInstructions","name":name,"version":loaded["skill"]["version"],"instructionsHash":digest(loaded["instructions"].as_str().ok_or("方法正文缺失")?),"title":entry["title"]}),
        )
    }
}

pub(super) fn verify(root: &Path, work: &Work, value: &Value) -> Result<(), String> {
    let rows = entries(value)?;
    if rows.is_empty() {
        return Ok(());
    }
    let mut rule_reads = Vec::new();
    let mut catalog = None;
    for row in rows {
        match row["kind"].as_str() {
            Some("libraryRules") => {
                rule_reads.push(json!({"request":row["request"],"fingerprint":row["fingerprint"]}))
            }
            Some("skillInstructions" | "skillReference") => {
                if skill(&mut catalog, root, row)? != *row {
                    return Err("分析方法已变化，请重新核对".into());
                }
            }
            _ => return Err("未知的分析方法依赖".into()),
        }
    }
    if !rule_reads.is_empty() {
        rules(root, work)?.inherit(&json!(rule_reads))?;
    }
    Ok(())
}

pub(super) fn accessible(root: &Path, work: &Work, value: &Value) -> bool {
    let Ok(rows) = entries(value) else {
        return false;
    };
    if rows.is_empty() {
        return true;
    }
    let Ok(mut current) = rules(root, work) else {
        return false;
    };
    rows.iter().all(|row| match row["kind"].as_str() {
        Some("libraryRules") => row["request"]["libraryId"].as_str().is_some_and(|id| {
            current
                .load(id, row["request"]["documentId"].as_str())
                .is_ok()
        }),
        Some("skillInstructions" | "skillReference") => true,
        _ => false,
    })
}

pub(super) fn merge(old: &Value, new: &Value) -> Result<Value, String> {
    let mut result = entries(old)?.to_vec();
    for row in entries(new)? {
        if !result.contains(row) {
            result.push(row.clone());
        }
    }
    if result.len() > 128 {
        return Err("累计方法依赖超过容量，请采用完整修订".into());
    }
    Ok(json!(result))
}

pub(super) fn capture(
    root: &Path,
    c: &Connection,
    work: &Work,
    run: &str,
    record: &str,
) -> Result<Value, String> {
    // An old delivery must not acquire methods loaded by a later conversation turn.
    let mut q = c.prepare("SELECT kind,body_json FROM agent_records WHERE work_id=?1 AND ((run_id=?2 AND kind='libraryRules') OR (kind='toolResult' AND rowid <= (SELECT rowid FROM agent_records WHERE id=?3 AND work_id=?1) AND (json_extract(body_json,'$.kind') IN ('skillInstructions','skillReference') OR json_extract(body_json,'$.value.kind') IN ('skillInstructions','skillReference')))) ORDER BY rowid").map_err(|e|e.to_string())?;
    let records = q
        .query_map(params![work.id, run, record], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut methods = BTreeMap::new();
    for record in records {
        let (kind, raw) = record.map_err(|e| e.to_string())?;
        if raw.len() > 524_288 {
            return Err("方法记录超过容量".into());
        }
        let value: Value = serde_json::from_str(&raw).map_err(|_| "方法记录损坏")?;
        if kind == "libraryRules" {
            for bundle in value.as_array().ok_or("知识库工作约定记录损坏")? {
                let entries = bundle["entries"].as_array().ok_or("工作约定条目损坏")?;
                if entries.is_empty() {
                    continue;
                }
                if entries.iter().any(|e| e["kind"] != "libraryInstructions") {
                    return Err("存在尚未接入的工作约定类型".into());
                }
                let library = text(bundle, "libraryId", 1024)?;
                let title: String = c
                    .query_row(
                        "SELECT name FROM libraries WHERE id=?1 AND enabled=1",
                        [&library],
                        |r| r.get(0),
                    )
                    .map_err(|_| "工作约定对应的资料库不可访问")?;
                let request = json!({"libraryId":library,"documentId":bundle["documentId"]});
                let entry = json!({"kind":"libraryRules","title":format!("{title} · 工作约定"),"request":request,"fingerprint":text(bundle,"fingerprint",100)?});
                methods.insert(format!("rules:{request}"), entry);
            }
        } else {
            let value = if value["kind"].is_string() {
                &value
            } else {
                &value["value"]
            };
            let name = text(&value["skill"], "name", 150)?;
            let title = text(&value["skill"], "title", 300)?;
            let version = text(&value["skill"], "version", 100)?;
            let entry = match value["kind"].as_str() {
                Some("skillInstructions") => {
                    json!({"kind":"skillInstructions","name":name,"title":title,"version":version,"instructionsHash":digest(value["instructions"].as_str().ok_or("方法正文缺失")?)})
                }
                Some("skillReference") => {
                    json!({"kind":"skillReference","name":name,"title":title,"path":text(value,"path",1000)?,"version":text(value,"version",100)?,"skillVersion":version})
                }
                _ => return Err("未知的方法记录".into()),
            };
            methods.insert(format!("{}:{name}:{}", entry["kind"], entry["path"]), entry);
        }
        if methods.len() > 128 {
            return Err("分析方法超过容量".into());
        }
    }
    let result = json!(methods.into_values().collect::<Vec<_>>());
    verify(root, work, &result)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scoped_rules_and_loaded_skill_are_methods_and_changes_require_review() {
        let case = super::super::tests::Case::new();
        let path = crate::knowledge_rules::managed_directory(&case.f.root, "notes");
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(
            path.join("AGENTS.md"),
            "仅依据已选资料，计划不能视作已执行。",
        )
        .unwrap();
        let work = store::load(&case.f.c(), &case.work).unwrap();
        let guidance = Rules::new(
            &case.f.root,
            current_reader(&case.f.root, &work)
                .unwrap()
                .catalog()
                .unwrap(),
            true,
        )
        .unwrap()
        .guidance();
        let method = Catalog::discover(&case.f.root)
            .unwrap()
            .load("hub-research", "")
            .unwrap();
        store::write(&case.f.root,|c| {
            store::insert(c,&case.work,Some(&case.run),"libraryRules",&guidance)?;
            store::insert(c,&case.work,Some(&case.run),"toolResult",&method)?;
            // The immutable delivery follows the method reads in an actual run.
            let raw:String=c.query_row("SELECT body_json FROM agent_records WHERE id=?1",[&case.record],|r|r.get(0)).unwrap();
            c.execute("DELETE FROM agent_records WHERE id=?1",[&case.record]).unwrap();
            c.execute("INSERT INTO agent_records(id,work_id,run_id,kind,body_json,created_at) VALUES(?1,?2,?3,'delivery',?4,1)",params![case.record,case.work,case.run,raw]).unwrap();
            Ok(())
        }).unwrap();
        let candidates = case.read();
        assert_eq!(
            candidates["candidates"][0]["eligibility"],
            "verifiedSources"
        );
        assert!(
            candidates["candidates"][0]["methodDependencies"]
                .as_array()
                .unwrap()
                .len()
                >= 2
        );
        let saved=super::super::ui(&case.f.root,&json!({"action":"insightImport","id":case.work,"deliveryRecordId":case.record,"deliveryHash":candidates["origin"]["deliveryHash"],"findingPointer":"/report/findings/0","confirmDependencies":true,"operationId":"methods"})).unwrap();
        std::fs::write(path.join("AGENTS.md"), "新增工作约定。").unwrap();
        let detail = super::super::ui(
            &case.f.root,
            &json!({"action":"insightDetail","insightId":saved["item"]["id"]}),
        )
        .unwrap();
        assert_eq!(detail["validity"], "review");
        assert!(detail["snapshot"]["text"].is_string());
        assert_eq!(case.read()["candidates"][0]["eligibility"], "unavailable");
    }
}
