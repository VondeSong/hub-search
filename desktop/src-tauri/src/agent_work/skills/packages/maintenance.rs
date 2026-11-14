//! Bounded package-copy lifecycle; original folders and Work outcomes are separate.
use super::*;
mod export;
pub(super) use export::{export, reconcile};

pub(super) fn migrate(c: &Connection) -> Result<(), rusqlite::Error> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS agent_skill_package_operations (
        id TEXT PRIMARY KEY,package_id TEXT NOT NULL,operation TEXT NOT NULL,request_hash TEXT NOT NULL,
        state TEXT NOT NULL,detail_json TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);")?;
    c.prepare("SELECT id,package_id,operation,request_hash,state,detail_json,created_at,updated_at FROM agent_skill_package_operations LIMIT 0")?;
    let pk:String=c.query_row("SELECT COALESCE(group_concat(name,','),'') FROM pragma_table_info('agent_skill_package_operations') WHERE pk>0",[],|r|r.get(0))?;
    if pk != "id" {
        return Err(rusqlite::Error::InvalidQuery);
    }
    Ok(())
}

fn operation(
    c: &Connection,
    key: &str,
    expected_hash: Option<&str>,
) -> Result<Option<Value>, String> {
    let row:Option<(String,String,String,String,String)>=c.query_row("SELECT package_id,operation,request_hash,state,detail_json FROM agent_skill_package_operations WHERE id=?1",[key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional().map_err(|e|e.to_string())?;
    let Some((package, kind, hash, state, raw)) = row else {
        return Ok(None);
    };
    if expected_hash.is_some_and(|h| h != hash) {
        return Err("同一方法包操作请求不能替换为不同内容".into());
    }
    if raw.len() > 32_768 {
        return Err("方法包操作回执超过容量".into());
    }
    let detail: Value = serde_json::from_str(&raw).map_err(|_| "方法包操作回执损坏")?;
    Ok(Some(
        json!({"clientRequestId":key,"packageId":package,"operation":kind,"state":state,"detail":detail}),
    ))
}

pub(super) fn request(c: &Connection, key: &str) -> Result<Option<Value>, String> {
    operation(c, key, None)
}

fn insert_operation(
    c: &Connection,
    key: &str,
    package: &str,
    kind: &str,
    hash: &str,
    state: &str,
    detail: &Value,
) -> Result<(), String> {
    if duplicate(c, key, hash)?.is_some() {
        return Err("该请求身份已属于另一项方法包保存".into());
    }
    let raw = detail.to_string();
    if raw.len() > 32_768 {
        return Err("方法包操作回执超限，未提交".into());
    }
    crate::agent_work::topics::admit(c, raw.len() + key.len() + hash.len() + 512)?;
    c.execute(
        "INSERT INTO agent_skill_package_operations VALUES(?1,?2,?3,?4,?5,?6,?7,?7)",
        params![key, package, kind, hash, state, raw, store::stamp()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

struct Removal {
    source: Value,
    methods: Vec<String>,
    reads: Vec<(String, Value, Value)>,
    fingerprint: String,
}
fn removal(c: &Connection, id: &str) -> Result<Removal, String> {
    let source = source(c, id)?;
    let mut q=c.prepare("SELECT id FROM agent_method_versions WHERE json_extract(content_json,'$.content.packageId')=?1 ORDER BY id LIMIT 33").map_err(|e|e.to_string())?;
    let methods = q
        .query_map([id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    if methods.is_empty() || methods.len() > 32 {
        return Err("方法删除范围缺失或超过32个保存版本，未修改旧内容".into());
    }
    // Follow only typed reload edges; never guess ownership from matching text.
    let mut q=c.prepare("WITH RECURSIVE affected(id) AS (
        SELECT id FROM agent_records WHERE kind='toolResult' AND (
          (json_extract(body_json,'$.kind') IN ('skillInstructions','skillReference') AND json_extract(body_json,'$.skill.origin')='registered' AND json_extract(body_json,'$.skill.packageId')=?1)
          OR (json_extract(body_json,'$.value.kind') IN ('skillInstructions','skillReference') AND json_extract(body_json,'$.value.skill.origin')='registered' AND json_extract(body_json,'$.value.skill.packageId')=?1))
        UNION SELECT r.id FROM agent_records r JOIN affected a ON json_extract(r.body_json,'$.request.recordId')=a.id
          WHERE r.kind='toolResult' AND json_extract(r.body_json,'$.request.operation')='traceResult')
        SELECT id,json_extract(body_json,'$._hubTrace'),json_extract(body_json,'$.request') FROM agent_records WHERE id IN(SELECT id FROM affected) ORDER BY id LIMIT 4097").map_err(|e|e.to_string())?;
    let raw = q
        .query_map([id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    if raw.len() > 4096 {
        return Err("方法读取回执超过本批4096条删除容量，未作部分删除".into());
    }
    let reads = raw
        .into_iter()
        .map(|(id, meta, request)| {
            Ok((
                id,
                serde_json::from_str::<Value>(&meta).map_err(|_| "方法读取身份损坏")?,
                serde_json::from_str::<Value>(&request).map_err(|_| "方法读取请求损坏")?,
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let fingerprint = hash(&json!({"source":source,"methods":methods,"reads":reads}).to_string());
    Ok(Removal {
        source,
        methods,
        reads,
        fingerprint,
    })
}

pub(super) fn delete_preview(root: &Path, args: &Value) -> Result<Value, String> {
    let id = text(args, "packageId", 100)?;
    let c = crate::source_evidence::open_read_database(root)?;
    let plan = removal(&c, &id)?;
    expected(args, &plan.source)?;
    Ok(
        json!({"packageId":id,"revision":plan.source["revision"],"fingerprint":plan.fingerprint,"methodVersions":plan.methods.len(),"readReceipts":plan.reads.len(),"scope":"删除Hub保存的方法字节、关联读取/回读副本及来源登记；保留旧报告、数据、动作、失败身份与全部用量。原文件夹、已导出副本和已发送的外部历史不修改或召回。旧方法全文不可恢复，旧运行不能继续使用。"}),
    )
}

pub(super) fn delete(root: &Path, args: &Value) -> Result<Value, String> {
    let (key, request_hash) = client(args)?;
    let id = text(args, "packageId", 100)?;
    if args["confirmed"] != true {
        return Err("请先明确确认仅删除Hub保存副本的范围与不可恢复性".into());
    }
    store::write(root, |c| {
        if let Some(saved) = operation(c, &key, Some(&request_hash))? {
            return Ok(saved);
        }
        let plan = removal(c, &id)?;
        expected(args, &plan.source)?;
        if args["expectedFingerprint"] != plan.fingerprint {
            return Err("方法或读取记录在确认后发生变化，未删除；请重新核对范围".into());
        }
        apply_removal(c, &id, &plan)?;
        let detail = json!({"packageId":id,"deletedMethodVersions":plan.methods.len(),"redactedReadReceipts":plan.reads.len(),"originalFilesChanged":false,"workUsageReset":false,"externalCopiesRecalled":false,"historicalOutcomesKept":true});
        insert_operation(c, &key, &id, "delete", &request_hash, "completed", &detail)?;
        operation(c, &key, Some(&request_hash))?.ok_or("方法删除回执缺失".into())
    })
}

pub(super) fn delete_synced(c: &Connection, id: &str) -> Result<(), String> {
    let plan = removal(c, id)?;
    apply_removal(c, id, &plan)
}

fn apply_removal(c: &Connection, id: &str, plan: &Removal) -> Result<(), String> {
    let at = store::stamp();
    for method in &plan.methods {
        let tombstone = json!({"id":method,"deleted":true,"packageId":id,"deletedAt":at,"originalContentDigest":method.strip_prefix("method-")});
        c.execute(
            "UPDATE agent_method_versions SET content_json=?1 WHERE id=?2",
            params![tombstone.to_string(), method],
        )
        .map_err(|e| e.to_string())?;
    }
    for (record, meta, request) in &plan.reads {
        let mut meta = meta.clone();
        meta["contentDeleted"] = json!(true);
        meta["deletedAt"] = json!(at);
        meta["deletedPackageId"] = json!(id);
        let body = json!({"status":"unavailable","message":"方法内容已按删除要求移除，旧回执仅保留身份和原计量，不能恢复全文","request":request,"_hubTrace":meta});
        c.execute(
            "UPDATE agent_records SET body_json=?1 WHERE id=?2",
            params![body.to_string(), record],
        )
        .map_err(|e| e.to_string())?;
    }
    // Keep request identities so an old import retry cannot recreate deleted bytes.
    c.execute("UPDATE agent_skill_source_revisions SET directory='',mode='deleted',created_at=?2 WHERE package_id=?1",params![id,at]).map_err(|e|e.to_string())?;
    Ok(())
}
