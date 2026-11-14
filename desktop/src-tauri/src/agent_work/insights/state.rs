//! User-owned state survives delivery cleanup; all commands use the database writer.
use super::*;
#[cfg(test)]
mod tests;
mod workspace;

pub(crate) fn migrate(c: &Connection) -> rusqlite::Result<()> {
    let result = (|| {
        c.execute_batch("SAVEPOINT insight_schema;
        CREATE TABLE IF NOT EXISTS insights(id TEXT PRIMARY KEY,owner_work_id TEXT NOT NULL,head_revision INTEGER NOT NULL,row_revision INTEGER NOT NULL,body_json TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS insights_recent ON insights(updated_at DESC,id);
        CREATE TABLE IF NOT EXISTS insight_revisions(insight_id TEXT NOT NULL,revision INTEGER NOT NULL,snapshot_json TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(insight_id,revision));
        CREATE TABLE IF NOT EXISTS insight_origins(work_id TEXT NOT NULL,delivery_record_id TEXT NOT NULL,finding_pointer TEXT NOT NULL,delivery_hash TEXT NOT NULL,insight_id TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(work_id,delivery_record_id,finding_pointer));
        CREATE TABLE IF NOT EXISTS insight_events(operation_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,insight_id TEXT NOT NULL,kind TEXT NOT NULL,body_json TEXT NOT NULL,result_revision INTEGER NOT NULL,target_revision INTEGER NOT NULL,created_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS insight_events_history ON insight_events(insight_id,created_at,operation_id);")?;
        for (table, columns, pk) in [
            ("insights","id,owner_work_id,head_revision,row_revision,body_json,created_at,updated_at","id"),
            ("insight_revisions","insight_id,revision,snapshot_json,created_at","insight_id,revision"),
            ("insight_origins","work_id,delivery_record_id,finding_pointer,delivery_hash,insight_id,revision","work_id,delivery_record_id,finding_pointer"),
            ("insight_events","operation_id,request_hash,insight_id,kind,body_json,result_revision,target_revision,created_at","operation_id"),
        ] {
            c.prepare(&format!("SELECT {columns} FROM {table} LIMIT 0"))?;
            let actual:String=c.query_row("SELECT group_concat(name,',') FROM (SELECT name FROM pragma_table_info(?1) WHERE pk>0 ORDER BY pk)",[table],|r|r.get(0))?;
            if actual!=pk {return Err(rusqlite::Error::InvalidQuery);}
        }
        c.execute_batch("RELEASE insight_schema")
    })();
    result.map_err(|e| {
        let _ = c.execute_batch("ROLLBACK TO insight_schema; RELEASE insight_schema");
        e
    })
}

fn decode(raw: &str) -> Result<Value, String> {
    serde_json::from_str(raw).map_err(|_| "洞察记录损坏".into())
}
fn load(c: &Connection, id: &str) -> Result<Value, String> {
    let (work,head,row,raw,created,updated):(String,i64,i64,String,i64,i64)=c.query_row("SELECT owner_work_id,head_revision,row_revision,body_json,created_at,updated_at FROM insights WHERE id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional().map_err(|e|e.to_string())?.ok_or("发现不存在")?;
    let mut item = decode(&raw)?;
    item["id"] = json!(id);
    item["workId"] = json!(work);
    item["headRevision"] = json!(head);
    item["rowRevision"] = json!(row);
    item["createdAt"] = json!(created);
    item["updatedAt"] = json!(updated);
    Ok(item)
}
fn snapshot(c: &Connection, id: &str, revision: i64) -> Result<Value, String> {
    let raw: String = c
        .query_row(
            "SELECT snapshot_json FROM insight_revisions WHERE insight_id=?1 AND revision=?2",
            params![id, revision],
            |r| r.get(0),
        )
        .map_err(|_| "发现内容修订不存在")?;
    decode(&raw)
}
fn save(c: &Connection, item: &Value) -> Result<(), String> {
    let mut body = item.clone();
    for key in [
        "id",
        "workId",
        "headRevision",
        "rowRevision",
        "createdAt",
        "updatedAt",
    ] {
        body.as_object_mut().ok_or("发现状态损坏")?.remove(key);
    }
    c.execute("UPDATE insights SET head_revision=?2,row_revision=?3,body_json=?4,updated_at=?5 WHERE id=?1",params![item["id"].as_str(),item["headRevision"].as_i64(),item["rowRevision"].as_i64(),body.to_string(),item["updatedAt"].as_i64()]).map_err(|e|e.to_string())?;
    Ok(())
}
fn reasons(item: &Value) -> Result<Vec<Value>, String> {
    item["reasons"]
        .as_array()
        .cloned()
        .ok_or_else(|| "发现复核原因损坏".into())
}
fn open_reason(
    values: &mut Vec<Value>,
    key: &str,
    kind: &str,
    reference: Value,
    revision: i64,
    event: &str,
) {
    if values
        .iter()
        .any(|r| r["key"] == key && r["active"] == true)
    {
        return;
    }
    values.push(json!({"id":crate::random_url_safe(18),"key":key,"kind":kind,"reference":reference,"revision":revision,"active":true,"openedBy":event}));
}
fn close_reason(values: &mut [Value], key: &str, event: &str) {
    for r in values
        .iter_mut()
        .filter(|r| r["key"] == key && r["active"] == true)
    {
        r["active"] = json!(false);
        r["resolvedBy"] = json!(event);
    }
}

fn dependencies(snap: &Value) -> Result<Vec<EvidenceExcerpt>, String> {
    let mut values = Vec::new();
    for key in ["sourceCitations", "contextDependencies"] {
        for v in snap[key].as_array().ok_or("发现依赖记录损坏")? {
            let e: EvidenceExcerpt =
                serde_json::from_value(v["excerpt"].clone()).map_err(|_| "发现依据记录损坏")?;
            if !values
                .iter()
                .any(|old: &EvidenceExcerpt| old.locator == e.locator && old.version == e.version)
            {
                values.push(e);
            }
        }
    }
    if let Some(deps) = snap["reviewDependency"]["dependencies"].as_array() {
        for v in deps.iter().filter(|v| v["kind"] == "source") {
            let e: EvidenceExcerpt =
                serde_json::from_value(v["excerpt"].clone()).map_err(|_| "回顾资料依赖损坏")?;
            if !values.contains(&e) {
                values.push(e);
            }
        }
    }
    Ok(values)
}

fn access(root: &Path, c: &Connection, item: &Value, snap: &Value) -> bool {
    let Ok(work) = work_on(c, item["workId"].as_str().unwrap_or_default()) else {
        return false;
    };
    if reasons(item).map_or(true, |values| {
        values.iter().any(|r| {
            r["active"] == true
                && r["kind"] == "restore"
                && r["reference"]["authorizationVersion"]
                    .as_i64()
                    .is_none_or(|version| work.authorization_version <= version)
        })
    }) {
        return false;
    }
    if !review::accessible(c, &work, &snap["reviewDependency"]) {
        return false;
    }
    let Ok(reader) = current_reader(root, &work) else {
        return false;
    };
    let Ok(deps) = dependencies(snap) else {
        return false;
    };
    deps.iter()
        .all(|e| reader.version_in_transaction(c, &e.locator).is_ok())
}
fn view(root: &Path, c: &Connection, item: &Value, revision: Option<i64>) -> Result<Value, String> {
    let n = revision.unwrap_or(item["headRevision"].as_i64().ok_or("发现版本损坏")?);
    let snap = snapshot(c, item["id"].as_str().unwrap(), n)?;
    let mut value = item.clone();
    value["contentRevision"] = json!(n);
    value["restorePending"] = json!(reasons(item)?
        .iter()
        .any(|r| r["active"] == true && r["kind"] == "restore"));
    let allowed = access(root, c, item, &snap);
    value["validity"] = json!(if !allowed {
        "unavailable"
    } else if reasons(item)?.iter().any(|r| r["active"] == true) {
        "review"
    } else {
        "available"
    });
    if allowed {
        value["workTitle"] = json!(work_on(c, item["workId"].as_str().ok_or("缺少原事项")?)?.goal);
        value["snapshot"] = snap;
    } else {
        value["unavailableReason"] = json!("来源或原事项当前不可访问，正文和引用已隐藏");
        // Reason references may contain user corrections or source metadata.
        value["reasons"] = json!([]);
    }
    Ok(value)
}

fn event(
    c: &Connection,
    operation: &str,
    request: &Value,
    item: &Value,
    kind: &str,
    body: &Value,
    target: i64,
    now: i64,
) -> Result<(), String> {
    c.execute("INSERT INTO insight_events(operation_id,request_hash,insight_id,kind,body_json,result_revision,target_revision,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![operation,digest(&request.to_string()),item["id"].as_str(),kind,body.to_string(),item["rowRevision"].as_i64(),target,now]).map_err(|e|e.to_string())?;
    Ok(())
}
fn advance(item: &mut Value, now: i64) {
    item["rowRevision"] = json!(item["rowRevision"].as_i64().unwrap() + 1);
    item["updatedAt"] = json!(now);
}

fn reconcile(root: &Path, c: &Connection, mut item: Value, now: i64) -> Result<Value, String> {
    let old = item.clone();
    let id = item["id"].as_str().unwrap().to_owned();
    let snap = snapshot(c, &id, item["headRevision"].as_i64().unwrap())?;
    let operation = format!("check-{}", crate::random_url_safe(18));
    let mut active = reasons(&item)?;
    if let Ok(work) = work_on(c, item["workId"].as_str().unwrap()) {
        if !snap["reviewDependency"].is_null() {
            if review::verify_dependencies(root, c, &work, &snap["reviewDependency"]).is_err() {
                open_reason(
                    &mut active,
                    "reviewDependency",
                    "reviewDependencyChanged",
                    json!({}),
                    item["headRevision"].as_i64().unwrap(),
                    &operation,
                );
            } else {
                close_reason(&mut active, "reviewDependency", &operation);
            }
        }
        if let Ok(reader) = current_reader(root, &work) {
            for e in dependencies(&snap)? {
                let key = digest(&serde_json::to_string(&e.locator).map_err(|e| e.to_string())?);
                match reader.version_in_transaction(c, &e.locator) {
                    Ok(version) => {
                        close_reason(&mut active, &format!("access:{key}"), &operation);
                        if version != e.version {
                            open_reason(
                                &mut active,
                                &format!("source:{key}"),
                                "sourceChanged",
                                json!({"locator":e.locator,"observedVersion":version}),
                                item["headRevision"].as_i64().unwrap(),
                                &operation,
                            );
                        } else if reader
                            .verify_in_transaction(c, std::slice::from_ref(&e))
                            .is_ok()
                        {
                            close_reason(&mut active, &format!("source:{key}"), &operation);
                        }
                    }
                    Err(_) => open_reason(
                        &mut active,
                        &format!("access:{key}"),
                        "sourceUnavailable",
                        json!({"locator":e.locator}),
                        item["headRevision"].as_i64().unwrap(),
                        &operation,
                    ),
                }
            }
            if reader
                .verify_in_transaction(c, &dependencies(&snap)?)
                .is_ok()
                && active.iter().any(|r| {
                    r["active"] == true
                        && r["kind"] == "restore"
                        && r["reference"]["authorizationVersion"]
                            .as_i64()
                            .is_some_and(|v| work.authorization_version > v)
                })
            {
                close_reason(&mut active, "restore", &operation);
            }
        }
    }
    if item["processingState"] == "later"
        && item["snoozeUntil"].as_i64().is_some_and(|at| at <= now)
    {
        item["processingState"] = json!("attention");
        item["snoozeUntil"] = Value::Null;
    }
    item["reasons"] = json!(active);
    if item != old {
        advance(&mut item, now);
        save(c, &item)?;
        event(
            c,
            &operation,
            &json!({"kind":"reconcile"}),
            &item,
            "reconcile",
            &json!({"reasons":item["reasons"]}),
            item["headRevision"].as_i64().unwrap(),
            now,
        )?;
    }
    Ok(item)
}

fn selected(root: &Path, c: &Connection, work: &Work, args: &Value) -> Result<Value, String> {
    if args["confirmDependencies"] != true {
        return Err("请先核对该条发现的直接依据和共同背景".into());
    }
    let record = text(args, "deliveryRecordId", 150)?;
    let source = candidates_on(root, c, work, &record)?;
    if source["origin"]["deliveryHash"] != args["deliveryHash"] {
        return Err("固定交付内容已改变，未保存发现".into());
    }
    let pointer = text(args, "findingPointer", 100)?;
    let mut candidate = source["candidates"]
        .as_array()
        .and_then(|a| a.iter().find(|v| v["findingPointer"] == pointer))
        .cloned()
        .ok_or("未找到选中的结构化发现")?;
    if candidate["eligibility"] != "verifiedSources" {
        return Err("所选发现的依据当前不可采用".into());
    }
    let raw: String = c
        .query_row(
            "SELECT body_json FROM agent_records WHERE id=?1 AND work_id=?2",
            params![record, work.id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let body = decode(&raw)?;
    let all: Vec<EvidenceExcerpt> =
        serde_json::from_value(body["evidence"].clone()).map_err(|_| "交付取证记录损坏")?;
    let ids: Vec<String> =
        serde_json::from_value(args.get("contextEvidenceIds").cloned().unwrap_or(json!([])))
            .map_err(|_| "背景选择无效")?;
    if ids.len() > 32 {
        return Err("背景选择超出容量".into());
    }
    let reader = current_reader(root, work)?;
    let mut contexts = Vec::new();
    for id in ids {
        let e = id
            .strip_prefix('e')
            .and_then(|s| s.parse::<usize>().ok())
            .and_then(|n| n.checked_sub(1))
            .and_then(|i| all.get(i))
            .ok_or("背景不属于当前交付")?;
        if !matches!(
            e.locator,
            EvidenceLocator::Note { .. }
                | EvidenceLocator::Task { .. }
                | EvidenceLocator::Reading { .. }
        ) {
            return Err("背景证据类型尚未接入".into());
        }
        reader.verify_in_transaction(c, std::slice::from_ref(e))?;
        contexts.push(json!({"evidenceId":id,"excerpt":e}));
    }
    candidate["contextDependencies"] = json!(contexts);
    candidate["origin"] = source["origin"].clone();
    candidate["userContextRefs"] = json!([]);
    candidate.as_object_mut().unwrap().remove("eligibility");
    candidate
        .as_object_mut()
        .unwrap()
        .remove("requiresDependencyConfirmation");
    Ok(candidate)
}

fn operation_id(args: &Value) -> Result<String, String> {
    text(args, "operationId", 100)
}
fn expected(item: &Value, args: &Value) -> Result<(), String> {
    if item["rowRevision"] != args["expectedRevision"] {
        Err("发现已更新，请刷新并核对；未自动覆盖".into())
    } else {
        Ok(())
    }
}

pub(super) fn discovery_target(root: &Path, c: &Connection, args: &Value) -> Result<Value, String> {
    let item = reconcile(
        root,
        c,
        load(c, &text(args, "targetInsightId", 150)?)?,
        store::stamp(),
    )?;
    if item["rowRevision"] != args["targetRevision"] {
        return Err("原发现已更新，请重新打开核对".into());
    }
    let value = view(root, c, &item, None)?;
    if value["snapshot"].is_null() {
        return Err("原发现当前不可访问".into());
    }
    Ok(value)
}

pub(super) fn ui(root: &Path, args: &Value) -> Result<Value, String> {
    store::write(root, |c| ui_on(root, c, args, store::stamp()))
}

fn ui_on(root: &Path, c: &Connection, args: &Value, now: i64) -> Result<Value, String> {
    let action = args["action"].as_str().ok_or("洞察操作缺失")?;
    if workspace::handles(action) {
        return workspace::ui_on(root, c, args, now);
    }
    if action == "insightOperation" {
        let op = operation_id(args)?;
        let id: Option<String> = c
            .query_row(
                "SELECT insight_id FROM insight_events WHERE operation_id=?1",
                [op],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        return match id {
            Some(id) => {
                let item = reconcile(root, c, load(c, &id)?, now)?;
                work_on(c, item["workId"].as_str().ok_or("事项身份损坏")?)?;
                Ok(json!({"committed":true,"item":view(root,c,&item,None)?}))
            }
            None => Ok(json!({"committed":false})),
        };
    }
    if action == "insightSource" {
        let id = text(args, "insightId", 150)?;
        let item = reconcile(root, c, load(c, &id)?, now)?;
        let work = work_on(c, item["workId"].as_str().unwrap())?;
        let snap = snapshot(
            c,
            &id,
            args["revision"]
                .as_i64()
                .unwrap_or(item["headRevision"].as_i64().unwrap()),
        )?;
        if !access(root, c, &item, &snap) {
            return Err("当前不能访问该修订的来源".into());
        }
        let index = args["sourceIndex"].as_u64().ok_or("引用位置无效")? as usize;
        let source = snap["sourceCitations"]
            .as_array()
            .and_then(|v| v.get(index))
            .ok_or("引用不存在")?;
        let excerpt: EvidenceExcerpt =
            serde_json::from_value(source["excerpt"].clone()).map_err(|_| "引用记录损坏")?;
        current_reader(root, &work)?.verify_in_transaction(c, std::slice::from_ref(&excerpt))?;
        return Ok(source.clone());
    }
    if action == "insightList" {
        let before = args.get("before").filter(|v| !v.is_null());
        let before_at = before
            .map(|v| v["createdAt"].as_i64().ok_or("分页时间无效"))
            .transpose()?;
        let before_id = before
            .map(|v| v["id"].as_str().ok_or("分页身份无效"))
            .transpose()?;
        let mut q = c
            .prepare("SELECT id FROM insights WHERE (?1 IS NULL OR created_at<?1 OR (created_at=?1 AND id>?2)) ORDER BY created_at DESC,id LIMIT 201")
            .map_err(|e| e.to_string())?;
        let ids = q
            .query_map(params![before_at, before_id], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let mut items = Vec::new();
        for id in ids.iter().take(200) {
            let item = reconcile(root, c, load(c, id)?, now)?;
            items.push(view(root, c, &item, None)?);
        }
        let next = if ids.len() > 200 {
            items
                .last()
                .map(|v| json!({"createdAt":v["createdAt"],"id":v["id"]}))
        } else {
            None
        };
        return Ok(json!({"items":items,"hasMore":ids.len()>200,"nextBefore":next}));
    }
    if action == "insightDetail" {
        let id = text(args, "insightId", 150)?;
        let item = reconcile(root, c, load(c, &id)?, now)?;
        let mut out = view(root, c, &item, args["revision"].as_i64())?;
        if out["validity"] != "unavailable" {
            let mut q=c.prepare("SELECT operation_id,kind,body_json,target_revision,created_at FROM insight_events WHERE insight_id=?1 ORDER BY rowid").map_err(|e|e.to_string())?;
            let events=q.query_map([&id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,i64>(3)?,r.get::<_,i64>(4)?))).map_err(|e|e.to_string())?.map(|row|{let (event_id,kind,raw,target,at)=row.map_err(|e|e.to_string())?;
                let allowed=snapshot(c,&id,target).is_ok_and(|snap|access(root,c,&item,&snap));
                Ok(json!({"id":event_id,"kind":kind,"body":if allowed{decode(&raw)?}else{Value::Null},"restricted":!allowed,"targetRevision":target,"createdAt":at}))}).collect::<Result<Vec<_>,String>>()?;
            out["events"] = json!(events);
        }
        return Ok(out);
    }
    let op = operation_id(args)?;
    let target = args["insightId"].as_str();
    let mut item = target
        .map(|id| load(c, id).and_then(|v| reconcile(root, c, v, now)))
        .transpose()?;
    let work_id = item
        .as_ref()
        .and_then(|i| i["workId"].as_str())
        .or_else(|| args["id"].as_str())
        .ok_or("事项身份缺失")?;
    let work = work_on(c, work_id)?;
    if let Some(i) = &item {
        let snap = snapshot(
            c,
            i["id"].as_str().unwrap(),
            i["headRevision"].as_i64().unwrap(),
        )?;
        if action != "insightRestoreAccess" && !access(root, c, i, &snap) {
            return Err("发现的来源当前不可访问".into());
        }
    }
    let replay:Option<(String,String,i64)>=c.query_row("SELECT request_hash,insight_id,result_revision FROM insight_events WHERE operation_id=?1",[&op],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|e|e.to_string())?;
    if let Some((hash, id, revision)) = replay {
        if hash != digest(&args.to_string()) {
            return Err("同一操作身份对应不同请求，未重复执行".into());
        }
        let current = reconcile(root, c, load(c, &id)?, now)?;
        return Ok(
            json!({"committed":true,"replayed":true,"resultRevision":revision,"item":view(root,c,&current,None)?}),
        );
    }
    if action == "insightImport" || action == "insightUpdate" {
        let record = text(args, "deliveryRecordId", 150)?;
        let pointer = text(args, "findingPointer", 100)?;
        let origin:Option<(String,String,i64)>=c.query_row("SELECT delivery_hash,insight_id,revision FROM insight_origins WHERE work_id=?1 AND delivery_record_id=?2 AND finding_pointer=?3",params![work.id,record,pointer],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|e|e.to_string())?;
        if let Some((hash, id, revision)) = origin {
            if args["deliveryHash"] != hash {
                return Err("同一出处的内容校验值已改变".into());
            }
            if target.is_some_and(|t| t != id) {
                return Err("出处已绑定其他发现".into());
            }
            let existing = load(c, &id)?;
            let result = view(root, c, &existing, None)?;
            event(
                c,
                &op,
                args,
                &existing,
                "existingOrigin",
                &json!({"originRevision":revision}),
                revision,
                now,
            )?;
            return Ok(json!({"committed":true,"existingOrigin":true,"item":result}));
        }
        let mut candidate = selected(root, c, &work, args)?;
        if action == "insightUpdate" {
            let current = item.as_ref().ok_or("更新目标缺失")?;
            expected(current, args)?;
            if current["workId"] != candidate["origin"]["workId"] {
                return Err("首批不跨事项更新发现".into());
            }
            let previous = snapshot(
                c,
                current["id"].as_str().unwrap(),
                current["headRevision"].as_i64().unwrap(),
            )?;
            for old in previous["contextDependencies"]
                .as_array()
                .ok_or("旧背景依赖损坏")?
            {
                if !candidate["contextDependencies"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|new| new["excerpt"]["locator"] == old["excerpt"]["locator"])
                {
                    return Err("旧修订的共同背景须明确核对，不能静默移除".into());
                }
            }
            if let Some(outcome) = args["reviewOutcome"].as_str() {
                if !matches!(outcome, "maintain" | "revise") {
                    return Err("复核处理方式无效".into());
                }
                let comparison = candidate["text"].clone();
                let origin = candidate["origin"].clone();
                if outcome == "maintain" {
                    if !previous["reviewDependency"].is_null()
                        || !candidate["reviewDependency"].is_null()
                    {
                        return Err("包含回顾派生依据时请采用完整修订，不能省略派生依赖".into());
                    }
                    current_reader(root, &work)?
                        .verify_in_transaction(c, &dependencies(&previous)?)?;
                    let additions = candidate["sourceCitations"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .chain(candidate["contextDependencies"].as_array().unwrap())
                        .cloned()
                        .collect::<Vec<_>>();
                    candidate = previous.clone();
                    for addition in additions {
                        let contexts = candidate["contextDependencies"]
                            .as_array_mut()
                            .ok_or("旧背景依赖损坏")?;
                        if !contexts.iter().any(|v| v["excerpt"] == addition["excerpt"]) {
                            contexts.push(addition);
                        }
                    }
                    if candidate["contextDependencies"].as_array().unwrap().len() > 32 {
                        return Err("核对背景已超过32段，请采用完整修订并重新选择必要依据".into());
                    }
                }
                candidate["reviewOutcome"] = json!({"kind":outcome,"comparison":comparison,"origin":origin,"previousRevision":current["headRevision"]});
            }
            adopt_feedback(c, current, &mut candidate, args)?;
        } else if item.is_some() {
            return Err("首次保存不能指定已有发现".into());
        }
        if item.is_none() {
            let id = crate::random_url_safe(24);
            let body = json!({"processingState":"attention","snoozeUntil":null,"followed":true,"reasons":[],"supersedes":[]});
            c.execute(
                "INSERT INTO insights VALUES(?1,?2,0,0,?3,?4,?4)",
                params![id, work.id, body.to_string(), now],
            )
            .map_err(|e| e.to_string())?;
            item = Some(load(c, &id)?);
        }
        let mut current = item.unwrap();
        let id = current["id"].as_str().unwrap().to_owned();
        let head = current["headRevision"].as_i64().unwrap() + 1;
        current["headRevision"] = json!(head);
        advance(&mut current, now);
        let mut active = reasons(&current)?;
        for r in &mut active {
            if r["active"] == true
                && matches!(
                    r["kind"].as_str(),
                    Some("sourceChanged" | "sourceUnavailable" | "restore")
                )
            {
                r["active"] = json!(false);
                r["resolvedBy"] = json!(op);
            }
            if r["kind"] == "feedback"
                && candidate["userContextRefs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|f| f["feedbackId"] == r["reference"]["feedbackId"])
            {
                r["active"] = json!(false);
                r["resolvedBy"] = json!(op);
            }
        }
        current["reasons"] = json!(active);
        save(c, &current)?;
        c.execute(
            "INSERT INTO insight_revisions VALUES(?1,?2,?3,?4)",
            params![id, head, candidate.to_string(), now],
        )
        .map_err(|e| e.to_string())?;
        c.execute(
            "INSERT INTO insight_origins VALUES(?1,?2,?3,?4,?5,?6)",
            params![
                work.id,
                record,
                pointer,
                args["deliveryHash"].as_str(),
                id,
                head
            ],
        )
        .map_err(|e| e.to_string())?;
        event(
            c,
            &op,
            args,
            &current,
            "content",
            &json!({"origin":candidate["origin"],"reasons":current["reasons"]}),
            head,
            now,
        )?;
        return Ok(json!({"committed":true,"item":view(root,c,&current,None)?}));
    }
    let mut current = item.ok_or("发现身份缺失")?;
    expected(&current, args)?;
    let head = current["headRevision"].as_i64().unwrap();
    let before = current.clone();
    let mut body = json!({});
    match action {
        "insightRestoreAccess" => {
            if args["confirmCurrentAccess"] != true {
                return Err("请明确重新确认原事项的本机资料访问范围".into());
            }
            let mut values = reasons(&current)?;
            if !values
                .iter()
                .any(|r| r["active"] == true && r["kind"] == "restore")
            {
                return Err("该发现没有待确认的恢复访问".into());
            }
            let snap = snapshot(c, current["id"].as_str().unwrap(), head)?;
            let reader = current_reader(root, &work)?;
            for e in dependencies(&snap)? {
                reader.version_in_transaction(c, &e.locator)?;
            }
            c.execute(
                "UPDATE agent_works SET authorization_version=authorization_version+1 WHERE id=?1",
                [&work.id],
            )
            .map_err(|e| e.to_string())?;
            store::insert(
                c,
                &work.id,
                None,
                "insightRestoreAuthorization",
                &json!({"authorizationVersion":work.authorization_version+1,"grant":work.grant,"author":"user","remoteFreshness":"notVerified"}),
            )?;
            close_reason(&mut values, "restore", &op);
            current["reasons"] = json!(values);
            body = json!({"authorizationVersion":work.authorization_version+1,"scope":"same Work's saved exact source grants; current local reachability checked; remote freshness not verified"});
        }
        "insightStatus" => {
            let state = text(args, "state", 30)?;
            if !["attention", "later", "done"].contains(&state.as_str()) {
                return Err("未知处理状态".into());
            }
            let until = if state == "later" {
                Some(
                    args["snoozeUntil"]
                        .as_i64()
                        .filter(|t| *t > now)
                        .ok_or("稍后需要明确的未来时间")?,
                )
            } else {
                None
            };
            current["processingState"] = json!(state);
            current["snoozeUntil"] = json!(until);
            body["beforeState"] = json!({"processingState":before["processingState"],"snoozeUntil":before["snoozeUntil"]});
        }
        "insightFollow" => {
            current["followed"] = json!(args["followed"].as_bool().ok_or("关注状态无效")?);
        }
        "insightStar" => {
            current["starred"] = json!(args["starred"].as_bool().ok_or("星标状态无效")?);
        }
        "insightPerspective" => {
            let perspective = args["perspective"].as_str().ok_or("视角无效")?;
            if !["", "knowledge", "life", "decision"].contains(&perspective) {
                return Err("视角无效".into());
            }
            current["perspective"] = json!(perspective);
        }
        "insightFeedback" => {
            let feedback_text = text(args, "text", 3000)?;
            let kind = text(args, "kind", 30)?;
            if !["correction", "notNeeded"].contains(&kind.as_str()) {
                return Err("未知反馈类型".into());
            }
            body = json!({"text":feedback_text,"kind":kind,"feedbackId":op,"targetRevision":head});
            if kind == "correction" {
                let mut active = reasons(&current)?;
                open_reason(
                    &mut active,
                    &format!("feedback:{op}"),
                    "feedback",
                    json!({"feedbackId":op}),
                    head,
                    &op,
                );
                current["reasons"] = json!(active);
            }
        }
        "insightContinue" => {
            let ids = feedback_ids(args)?;
            if ids.is_empty() {
                return Err("请选择需要送入本轮的反馈".into());
            }
            let mut texts = Vec::new();
            for id in &ids {
                let f = feedback(c, &current, id)?;
                texts.push(f["text"].as_str().ok_or("反馈正文损坏")?.to_owned());
            }
            let original = snapshot(c, current["id"].as_str().unwrap(), head)?;
            let text = original["text"].as_str().ok_or("原发现正文损坏")?;
            let snippet = text.chars().take(800).collect::<String>();
            let label = if text.chars().count() > 800 {
                "原发现节选（请结合此前成果核对）"
            } else {
                "原发现"
            };
            let message=format!("请核对这条已保存发现并按补充修正，给出有精确资料引用的结构化发现，保留尚未完成的限制。用户补充与资料引文分开说明。\n{label}：{snippet}\n用户补充：\n{}",texts.join("\n"));
            if message.chars().count() > 4000 {
                return Err("所选补充超过单轮消息容量，请减少本次选择；全部反馈仍已保留".into());
            }
            store::conversation::message_on(
                root,
                c,
                &work.id,
                &json!({"text":message,"clientMessageId":op,"expectedRevision":work.revision}),
            )?;
            let message_id:String=c.query_row("SELECT id FROM agent_records WHERE work_id=?1 AND kind='userMessage' AND json_extract(body_json,'$.clientMessageId')=?2",params![work.id,op],|r|r.get(0)).map_err(|e|e.to_string())?;
            body = json!({"feedbackIds":ids,"messageId":message_id,"workRevision":work.revision+1,"status":"savedForNextRun"});
        }
        "insightWithdrawFeedback" => {
            let id = text(args, "feedbackId", 100)?;
            feedback(c, &current, &id)?;
            let mut active = reasons(&current)?;
            close_reason(&mut active, &format!("feedback:{id}"), &op);
            let snap = snapshot(c, current["id"].as_str().unwrap(), head)?;
            if snap["userContextRefs"]
                .as_array()
                .is_some_and(|refs| refs.iter().any(|f| f["feedbackId"] == id))
            {
                open_reason(
                    &mut active,
                    &format!("userContext:{id}"),
                    "userContextChanged",
                    json!({"feedbackId":id}),
                    head,
                    &op,
                );
            }
            current["reasons"] = json!(active);
            body = json!({"feedbackId":id,"withdrawn":true});
        }
        "insightUndoStatus" => {
            let id = text(args, "eventId", 100)?;
            let raw:String=c.query_row("SELECT body_json FROM insight_events WHERE operation_id=?1 AND insight_id=?2 AND kind='insightStatus'",params![id,current["id"].as_str()],|r|r.get(0)).map_err(|_|"该记录不是可撤销的处理动作")?;
            let previous = decode(&raw)?;
            current["processingState"] = previous["beforeState"]["processingState"].clone();
            current["snoozeUntil"] = previous["beforeState"]["snoozeUntil"].clone();
            if current["processingState"] == "later"
                && current["snoozeUntil"].as_i64().is_none_or(|t| t <= now)
            {
                current["processingState"] = json!("attention");
                current["snoozeUntil"] = Value::Null;
            }
            body = json!({"compensates":id});
        }
        "insightRelate" => {
            let ids: Vec<String> =
                serde_json::from_value(args["supersedes"].clone()).map_err(|_| "替代关系无效")?;
            if ids.len() > 12 || ids.iter().any(|id| current["id"] == *id) {
                return Err("替代关系超出范围或指向自身".into());
            }
            for id in &ids {
                let other = load(c, id)?;
                let snap = snapshot(c, id, other["headRevision"].as_i64().unwrap())?;
                if !access(root, c, &other, &snap) {
                    return Err("关联发现当前不可访问".into());
                }
            }
            current["supersedes"] = json!(ids);
            body = json!({"supersedes":ids});
        }
        _ => return Err("未知洞察操作".into()),
    }
    advance(&mut current, now);
    save(c, &current)?;
    body["reasons"] = current["reasons"].clone();
    event(c, &op, args, &current, action, &body, head, now)?;
    Ok(json!({"committed":true,"item":view(root,c,&current,None)?,"operation":body}))
}

fn feedback_ids(args: &Value) -> Result<Vec<String>, String> {
    let ids: Vec<String> =
        serde_json::from_value(args.get("feedbackIds").cloned().unwrap_or(json!([])))
            .map_err(|_| "反馈选择无效")?;
    if ids.len() > 12 || ids.iter().any(|id| id.is_empty() || id.len() > 100) {
        return Err("反馈选择超出范围".into());
    }
    Ok(ids)
}
fn feedback(c: &Connection, item: &Value, id: &str) -> Result<Value, String> {
    let raw:String=c.query_row("SELECT body_json FROM insight_events WHERE operation_id=?1 AND insight_id=?2 AND kind='insightFeedback'",params![id,item["id"].as_str()],|r|r.get(0)).map_err(|_|"反馈不属于当前发现")?;
    decode(&raw)
}
fn adopt_feedback(
    c: &Connection,
    item: &Value,
    candidate: &mut Value,
    args: &Value,
) -> Result<(), String> {
    let ids = feedback_ids(args)?;
    let run = candidate["origin"]["runId"]
        .as_str()
        .ok_or("成果运行身份缺失")?;
    let base: i64 = c
        .query_row(
            "SELECT base_revision FROM agent_runs WHERE id=?1 AND work_id=?2",
            params![run, item["workId"].as_str()],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let previous = snapshot(
        c,
        item["id"].as_str().unwrap(),
        item["headRevision"].as_i64().unwrap(),
    )?;
    let mut refs = previous["userContextRefs"]
        .as_array()
        .cloned()
        .ok_or("用户补充依赖记录损坏")?;
    for id in ids {
        if args["confirmFeedbackHandled"] != true {
            return Err("请逐条确认新成果已按所选补充修正".into());
        }
        let f = feedback(c, item, &id)?;
        let withdrawn:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM insight_events WHERE insight_id=?1 AND kind='insightWithdrawFeedback' AND json_extract(body_json,'$.feedbackId')=?2)",params![item["id"].as_str(),id],|r|r.get(0)).map_err(|e|e.to_string())?;
        if withdrawn {
            return Err("所选用户补充已撤回，不能作为当前依据".into());
        }
        let raw:Option<String>=c.query_row("SELECT body_json FROM insight_events WHERE insight_id=?1 AND kind='insightContinue' AND json_extract(body_json,'$.workRevision')=?2 AND EXISTS(SELECT 1 FROM json_each(json_extract(body_json,'$.feedbackIds')) WHERE value=?3) ORDER BY rowid DESC LIMIT 1",params![item["id"].as_str(),base,id],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        let sent = decode(&raw.ok_or("该补充未绑定至本次成果运行的正式用户消息")?)?;
        let present:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_records WHERE id=?1 AND work_id=?2 AND kind='userMessage' AND json_extract(body_json,'$.author')='user' AND json_extract(body_json,'$.revision')=?3)",params![sent["messageId"].as_str(),item["workId"].as_str(),base],|r|r.get(0)).map_err(|e|e.to_string())?;
        if !present {
            return Err("用户补充消息身份不可核对".into());
        }
        refs.retain(|v| v["feedbackId"] != id);
        refs.push(json!({"feedbackId":id,"messageId":sent["messageId"],"workRevision":base,"runId":run,"text":f["text"],"nature":"userSelfReport","adoption":"explicitUserConfirmation"}));
    }
    candidate["userContextRefs"] = json!(refs);
    Ok(())
}

pub(crate) fn quarantine_restored(c: &Connection) -> Result<(), String> {
    let exists: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='insights' AND type='table')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !exists {
        return Ok(());
    }
    let mut q = c
        .prepare("SELECT id FROM insights")
        .map_err(|e| e.to_string())?;
    let ids = q
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    for id in ids {
        let mut item = load(c, &id)?;
        let op = format!("restore-{}", crate::random_url_safe(18));
        let mut values = reasons(&item)?;
        close_reason(&mut values, "restore", &op);
        open_reason(
            &mut values,
            "restore",
            "restore",
            json!({"authorizationVersion":store::load(c,item["workId"].as_str().unwrap()).ok().map(|w|w.authorization_version),"restoredAt":store::stamp()}),
            item["headRevision"].as_i64().unwrap(),
            &op,
        );
        item["reasons"] = json!(values);
        advance(&mut item, store::stamp());
        save(c, &item)?;
        event(
            c,
            &op,
            &json!({"kind":"restore"}),
            &item,
            "restore",
            &json!({"reasons":item["reasons"]}),
            item["headRevision"].as_i64().unwrap(),
            store::stamp(),
        )?;
    }
    Ok(())
}
