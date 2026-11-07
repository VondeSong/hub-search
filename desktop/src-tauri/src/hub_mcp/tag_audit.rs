//! Durable audit work, not a semantic classifier. All writes are Hub-local.
use super::*;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Candidate {
    item_id: String,
    tag_ids: Vec<String>,
    reason: String,
    proposal_id: Option<String>,
    summary: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuditRun {
    run_id: String,
    index_revision: String,
    audit_revision: String,
    version: u64,
    completed: bool,
    catalog_total: usize,
    catalog_cursor: Option<String>,
    catalog_done: bool,
    scanned_tags: BTreeSet<String>,
    catalog_reviewed: usize,
    pending_catalog_page: Option<Value>,
    candidates: Vec<Candidate>,
}

fn load_run(connection: &Connection, id: &str) -> Result<AuditRun, String> {
    let raw: String = connection
        .query_row(
            "SELECT state_json FROM tag_audit_runs WHERE id=?1",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or("审计记录不存在")?;
    serde_json::from_str(&raw).map_err(|error| format!("无法读取审计断点：{error}"))
}

fn audit_revision(connection: &Connection) -> Result<String, String> {
    // Counts and MAX timestamps alone miss same-size edits within a timestamp tick.
    let mut digest = Sha256::new();
    for sql in [
        format!("{HUB_TAG_ENTITIES_CTE} SELECT json_array(library_id,provider,document_id,page_id,task_id,entity_id,tag,normalized_tag) FROM all_tags ORDER BY library_id,provider,document_id,page_id,task_id,tag,normalized_tag"),
        "SELECT json_array(space_id,id,title,path,content_hash,indexed_at) FROM documents ORDER BY space_id,id".into(),
        "SELECT json_array(library_id,task_id,title,project_id,content,description,last_seen_at) FROM dida_tasks ORDER BY library_id,task_id".into(),
    ] {
        let mut statement = connection.prepare(&sql).map_err(|error|error.to_string())?;
        let rows=statement.query_map([],|row|row.get::<_,String>(0)).map_err(|error|error.to_string())?;
        for row in rows {
            let row=row.map_err(|error|error.to_string())?;
            digest.update((row.len() as u64).to_le_bytes());
            digest.update(row.as_bytes());
        }
        digest.update([0xff]);
    }
    Ok(format!("tag-audit-v1:{:x}", digest.finalize()))
}

fn report(
    run: &AuditRun,
    current_index_revision: &str,
    current_audit_revision: &str,
    arguments: &Value,
) -> Value {
    let status = argument_text(arguments, "itemStatus");
    let filtered = run
        .candidates
        .iter()
        .filter(|item| match status {
            "all" => true,
            "completed" => item.proposal_id.is_some(),
            _ => item.proposal_id.is_none(),
        })
        .collect::<Vec<_>>();
    let offset = argument_cursor(arguments);
    let limit = argument_usize(arguments, "limit", 50, 100);
    let items = filtered
        .iter()
        .skip(offset)
        .take(limit)
        .cloned()
        .collect::<Vec<_>>();
    let completed = run
        .candidates
        .iter()
        .filter(|item| item.proposal_id.is_some())
        .count();
    let tags_analyzed = run
        .candidates
        .iter()
        .filter(|item| item.proposal_id.is_some())
        .flat_map(|item| item.tag_ids.iter())
        .collect::<BTreeSet<_>>()
        .len();
    let pairs_analyzed = run
        .candidates
        .iter()
        .filter(|item| item.tag_ids.len() == 2 && item.proposal_id.is_some())
        .count();
    json!({
        "runId":run.run_id,"indexRevision":run.index_revision,"auditRevision":run.audit_revision,"version":run.version,
        "status":if run.completed {"completed"} else {"active"},
        "stale":run.index_revision != current_index_revision || run.audit_revision != current_audit_revision,
        "catalogTotal":run.catalog_total,"catalogScanned":run.scanned_tags.len(),
        "catalogReviewed":run.catalog_reviewed,"catalogDone":run.catalog_done,
        "coverage":if run.catalog_total == 0 {0.0} else {run.catalog_reviewed as f64 / run.catalog_total as f64},
        "nextCatalogCursor":run.catalog_cursor,"pendingCatalogPage":run.pending_catalog_page,
        "candidateTotal":run.candidates.len(),"candidateCompleted":completed,
        "candidatePending":run.candidates.len()-completed,"tagsAnalyzed":tags_analyzed,"pairsAnalyzed":pairs_analyzed,
        "items":items,"itemTotal":filtered.len(),
        "nextCursor":if offset+items.len()<filtered.len() {json!((offset+items.len()).to_string())} else {Value::Null}
    })
}

pub(super) fn status(data_root: &Path, arguments: &Value) -> Result<Value, String> {
    if !matches!(
        argument_text(arguments, "itemStatus"),
        "" | "pending" | "completed" | "all"
    ) {
        return Err("itemStatus 只支持 pending、completed、all".into());
    }
    if let Some(cursor) = arguments.get("cursor").filter(|v| !v.is_null()) {
        if cursor
            .as_str()
            .is_none_or(|text| text.parse::<usize>().is_err())
        {
            return Err("cursor 必须是返回的分页数字字符串".into());
        }
    }
    let database = hub_mcp_database(data_root)?;
    let mut connection = open_database(&database)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let revision = tag_index_revision(&transaction)?;
    let current_audit_revision = audit_revision(&transaction)?;
    let requested = argument_text(arguments, "runId");
    let id = if requested.is_empty() {
        transaction.query_row(
                "SELECT id FROM tag_audit_runs ORDER BY (json_extract(state_json,'$.auditRevision')=?1 AND json_extract(state_json,'$.indexRevision')=?2) DESC,updated_at DESC,id DESC LIMIT 1",
                params![current_audit_revision, revision], |row| row.get::<_,String>(0)
        ).optional().map_err(|error| error.to_string())?
    } else {
        Some(requested.to_string())
    };
    let run = id
        .map(|id| {
            load_run(&transaction, &id)
                .map(|run| report(&run, &revision, &current_audit_revision, arguments))
        })
        .transpose()?;
    Ok(
        json!({"schemaVersion":"hub.tag-audit.v1","indexRevision":revision,"auditRevision":current_audit_revision,"run":run,"sourceTagsModified":false}),
    )
}

fn required_text(arguments: &Value, field: &str, max: usize) -> Result<String, String> {
    let value = argument_text(arguments, field);
    if value.is_empty() || value.chars().count() > max {
        return Err(format!("{field} 必须为 1–{max} 个字符"));
    }
    Ok(value.to_string())
}

fn save_run(connection: &Connection, run: &AuditRun) -> Result<(), String> {
    let raw = serde_json::to_string(run).map_err(|error| error.to_string())?;
    if raw.len() > 16 * 1024 * 1024 {
        return Err("审计断点超过 16 MiB，请缩小候选范围".into());
    }
    connection
        .execute(
            "UPDATE tag_audit_runs SET state_json=?2,updated_at=?3 WHERE id=?1",
            params![run.run_id, raw, now_timestamp()],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub(super) fn step(data_root: &Path, arguments: &Value) -> Result<Value, String> {
    let encoded = serde_json::to_vec(arguments).map_err(|error| error.to_string())?;
    if encoded.len() > 256 * 1024 {
        return Err("单步审计参数超过 256 KiB".into());
    }
    let database = hub_mcp_database(data_root)?;
    let mut connection = open_database(&database)?;
    // State, receipt, catalog snapshot and any proposal are committed together.
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let revision = tag_index_revision(&transaction)?;
    let current_audit_revision = audit_revision(&transaction)?;
    let action = argument_text(arguments, "action");
    if action == "start" {
        let key = required_text(arguments, "idempotencyKey", 200)?;
        let expected = required_text(arguments, "expectedIndexRevision", 200)?;
        let expected_audit = required_text(arguments, "expectedAuditRevision", 200)?;
        let existing = transaction
            .query_row(
                "SELECT id FROM tag_audit_runs WHERE start_key=?1",
                params![key],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if let Some(id) = existing {
            let run = load_run(&transaction, &id)?;
            if run.index_revision != expected || run.audit_revision != expected_audit {
                return Err("启动幂等键已用于其他索引版本".into());
            }
            return Ok(
                json!({"schemaVersion":"hub.tag-audit.v1","indexRevision":revision,"auditRevision":current_audit_revision,"run":report(&run,&revision,&current_audit_revision,&json!({})),"replayed":true,"sourceTagsModified":false}),
            );
        }
        if expected != revision || expected_audit != current_audit_revision {
            return Err("索引已经变化，请读取新版本后启动新的审计，不要沿用旧结论".into());
        }
        let catalog = tag_catalog_on_connection(&transaction, &json!({"limit":1}))?;
        let run = AuditRun {
            run_id: format!("tag-audit-{}", random_url_safe(12)),
            index_revision: revision.clone(),
            audit_revision: current_audit_revision.clone(),
            version: 0,
            completed: false,
            catalog_total: catalog["total"].as_u64().unwrap_or(0) as usize,
            catalog_cursor: None,
            catalog_done: false,
            scanned_tags: BTreeSet::new(),
            catalog_reviewed: 0,
            pending_catalog_page: None,
            candidates: vec![],
        };
        transaction.execute("INSERT INTO tag_audit_runs(id,start_key,index_revision,state_json,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?5)",
            params![run.run_id,key,revision,serde_json::to_string(&run).map_err(|error|error.to_string())?,now_timestamp()]).map_err(|error|error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        return Ok(
            json!({"schemaVersion":"hub.tag-audit.v1","indexRevision":revision,"auditRevision":current_audit_revision,"run":report(&run,&revision,&current_audit_revision,&json!({})),"replayed":false,"sourceTagsModified":false}),
        );
    }
    let id = required_text(arguments, "runId", 100)?;
    let request_id = required_text(arguments, "requestId", 120)?;
    let request_hash = format!("{:x}", Sha256::digest(&encoded));
    let mut run = load_run(&transaction, &id)?;
    let prior = transaction
        .query_row(
            "SELECT request_hash FROM tag_audit_receipts WHERE run_id=?1 AND request_id=?2",
            params![id, request_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some(hash) = prior {
        if hash != request_hash {
            return Err("requestId 已用于不同参数；重试必须原样传回，不能覆盖旧步骤".into());
        }
        let recorded = run
            .candidates
            .iter()
            .find(|item| item.item_id == argument_text(arguments, "itemId"))
            .and_then(|item| item.proposal_id.clone());
        return Ok(
            json!({"schemaVersion":"hub.tag-audit.v1","indexRevision":revision,"auditRevision":current_audit_revision,"run":report(&run,&revision,&current_audit_revision,&json!({})),"recordedProposalId":recorded,"replayed":true,"sourceTagsModified":false}),
        );
    }
    if run.index_revision != revision || run.audit_revision != current_audit_revision {
        return Err("索引已经变化，旧审计仅可查看；请创建新审计并重新取证".into());
    }
    if arguments.get("expectedVersion").and_then(Value::as_u64) != Some(run.version) {
        return Err("审计进度已经变化，请先读取 hub_tag_audit_status 再继续".into());
    }
    if run.completed {
        return Err("审计已完成，不能追加或覆盖结果".into());
    }
    match action {
        "scan" => {
            if run.pending_catalog_page.is_some() {
                return Err("先用 queue 确认当前目录页的候选，再读取下一页".into());
            }
            if run.catalog_done {
                return Err("目录已读完，请处理剩余候选".into());
            }
            let page = tag_catalog_on_connection(
                &transaction,
                &json!({"cursor":run.catalog_cursor,"limit":100}),
            )?;
            if page["total"].as_u64() != Some(run.catalog_total as u64) {
                return Err("目录数量变化，请重新启动审计".into());
            }
            for tag in page["tags"].as_array().ok_or("目录格式错误")? {
                let tag = tag["tagId"].as_str().ok_or("目录缺少 tagId")?;
                if !run.scanned_tags.insert(tag.to_string()) {
                    return Err("目录出现重复，索引可能已变化，请重新启动审计".into());
                }
            }
            run.catalog_cursor = page["nextCursor"].as_str().map(str::to_string);
            run.catalog_done = run.catalog_cursor.is_none();
            run.pending_catalog_page = Some(page);
        }
        "queue" => {
            let items = arguments
                .get("candidates")
                .and_then(Value::as_array)
                .ok_or("candidates 必须为数组，可为空")?;
            if items.len() > 100 {
                return Err("每次最多添加 100 个候选".into());
            }
            for item in items {
                let tags = item
                    .get("tagIds")
                    .and_then(Value::as_array)
                    .ok_or("候选 tagIds 必须为数组")?;
                if tags.is_empty() || tags.len() > 2 {
                    return Err("每个候选必须包含 1 个标签或 2 个不同标签".into());
                }
                let expected_tag_count = tags.len();
                let tags = tags
                    .iter()
                    .map(|tag| {
                        tag.as_str()
                            .map(|s| s.trim().to_lowercase())
                            .ok_or("tagIds 必须是字符串".to_string())
                    })
                    .collect::<Result<BTreeSet<_>, _>>()?;
                if tags.len() != expected_tag_count
                    || tags.iter().any(|tag| !run.scanned_tags.contains(tag))
                {
                    return Err("候选必须来自本次审计已经读取的真实目录".into());
                }
                let reason = required_text(item, "reason", 1000)?;
                let tags = tags.into_iter().collect::<Vec<_>>();
                let item_id = format!(
                    "item-{:x}",
                    Sha256::digest(serde_json::to_vec(&tags).map_err(|error| error.to_string())?)
                );
                if !run.candidates.iter().any(|item| item.item_id == item_id) {
                    if run.candidates.len() >= 2000 {
                        return Err("审计候选超过 2000 个，请先缩小候选筛选范围".into());
                    }
                    run.candidates.push(Candidate {
                        item_id,
                        tag_ids: tags,
                        reason,
                        proposal_id: None,
                        summary: None,
                    });
                }
            }
            if arguments.get("acknowledgePage").and_then(Value::as_bool) == Some(true) {
                if run.pending_catalog_page.is_none() {
                    return Err("没有待确认目录页".into());
                }
                run.pending_catalog_page = None;
                run.catalog_reviewed = run.scanned_tags.len();
            }
        }
        "record" => {
            if arguments.get("submitForReview").and_then(Value::as_bool) != Some(true) {
                return Err(
                    "record 会提交待审核建议，必须明确 submitForReview=true；不得自动批准".into(),
                );
            }
            let item_id = required_text(arguments, "itemId", 100)?;
            let item = run
                .candidates
                .iter()
                .find(|item| item.item_id == item_id)
                .ok_or("候选不存在")?;
            if item.proposal_id.is_some() {
                return Err("候选已保存，不可覆盖；读取断点中的 proposalId".into());
            }
            let mut proposal = arguments
                .get("proposal")
                .filter(|p| p.is_object())
                .cloned()
                .ok_or("proposal 必须为治理建议对象")?;
            if proposal["indexRevision"].as_str() != Some(revision.as_str()) {
                return Err("建议必须基于本次审计的当前索引版本".into());
            }
            let recommendations = proposal["recommendations"]
                .as_array()
                .ok_or("缺少 recommendations")?;
            let mut tags = BTreeSet::new();
            for rec in recommendations {
                for tag in rec["sourceTagIds"].as_array().into_iter().flatten() {
                    if let Some(tag) = tag.as_str() {
                        tags.insert(tag.trim().to_lowercase());
                    }
                }
                if let Some(tag) = rec["targetTagId"]
                    .as_str()
                    .filter(|tag| !tag.trim().is_empty())
                {
                    tags.insert(tag.trim().to_lowercase());
                }
            }
            if tags != item.tag_ids.iter().cloned().collect() {
                return Err("建议涉及的标签必须与当前候选完全一致；新的关系请先入队并取证".into());
            }
            proposal["idempotencyKey"] = json!(format!("audit:{}:{}", run.run_id, item.item_id));
            proposal["generator"] = json!({"agent":"codex","workflow":"global-tag-audit","auditRunId":run.run_id,"auditItemId":item.item_id,
                "audit":{"catalogTotal":run.catalog_total,"catalogScanned":run.catalog_reviewed,
                    "candidateTagsAnalyzed":item.tag_ids.len(),"relationPairsAnalyzed":if item.tag_ids.len()==2 {1} else {0}}});
            let saved = submit_tag_proposal_on_connection(&transaction, &proposal)?;
            let item = run
                .candidates
                .iter_mut()
                .find(|item| item.item_id == item_id)
                .ok_or("候选不存在")?;
            item.proposal_id = saved["proposal"]["proposalId"].as_str().map(str::to_string);
            item.summary = saved["proposal"]["summary"].as_str().map(str::to_string);
        }
        "finish" => {
            if !run.catalog_done
                || run.pending_catalog_page.is_some()
                || run.candidates.iter().any(|item| item.proposal_id.is_none())
            {
                return Err("目录页尚未确认或存在未分析候选，不能标记完成".into());
            }
            run.completed = true;
        }
        _ => return Err("action 只支持 start、scan、queue、record、finish".into()),
    }
    run.version += 1;
    save_run(&transaction, &run)?;
    transaction
        .execute(
            "INSERT INTO tag_audit_receipts(run_id,request_id,request_hash) VALUES (?1,?2,?3)",
            params![id, request_id, request_hash],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    let recorded = run
        .candidates
        .iter()
        .find(|item| item.item_id == argument_text(arguments, "itemId"))
        .and_then(|item| item.proposal_id.clone());
    Ok(
        json!({"schemaVersion":"hub.tag-audit.v1","indexRevision":revision,"auditRevision":current_audit_revision,"run":report(&run,&revision,&current_audit_revision,&json!({})),"recordedProposalId":recorded,"replayed":false,"sourceTagsModified":false}),
    )
}

pub(super) fn tools(proposal_schema: Value) -> Vec<Value> {
    vec![
        json!({"name":"hub_tag_audit_status",
        "description":"只读恢复全局标签审计断点。省略 runId 优先返回当前索引的最近审计；否则返回最近旧审计并标记 stale。返回真实目录读取数、已确认数、当前待确认目录页、候选队列及累计完成数。默认仅返回未完成候选，按 nextCursor 翻页；跨页不冻结队列，处理候选后应重新读取 pending 首批。stale 旧审计只能查看，必须 start 新审计重取证。完成只表示扫描与候选处理完成，不表示已批准或全库语义正确。",
        "annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false},
        "inputSchema":{"type":"object","properties":{
            "runId":{"type":"string","maxLength":100},"itemStatus":{"type":"string","enum":["pending","completed","all"]},
            "cursor":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":100}
        }}}),
        json!({"name":"hub_tag_audit_step",
        "description":"持久化全局审计：start 以 expectedIndexRevision 和 idempotencyKey 建立本地进度；scan 读取并保存下一目录页（固定100条），未 queue 确认前不能再翻；queue 添加来自已读目录的单标签或标签对候选，可 candidates=[] 且 acknowledgePage=true 确认无候选；record 在用户授权提交建议后，携带 submitForReview=true，把单候选 proposal 与完成进度原子保存，返回 recordedProposalId，再调用预演；finish 仅允许目录确认完且无未处理候选。除 start 外必须携带 runId、最新 expectedVersion、唯一 requestId；同一步重试参数必须完全相同，返回当前断点，不覆盖旧操作。不同候选由 Hub 分配独立幂等键；不要另用 hub_submit_tag_governance_proposal 提交审计候选。最多2000候选，不修改来源标签、不批准内部关系。",
        "annotations":{"readOnlyHint":false,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false},
        "inputSchema":{"type":"object","properties":{
            "action":{"type":"string","enum":["start","scan","queue","record","finish"]},
            "runId":{"type":"string","minLength":1,"maxLength":100},
            "requestId":{"type":"string","minLength":1,"maxLength":120},
            "expectedVersion":{"type":"integer","minimum":0},
                "expectedIndexRevision":{"type":"string","minLength":1,"maxLength":200},
                "expectedAuditRevision":{"type":"string","minLength":1,"maxLength":200,"description":"status 返回的证据指纹，可检测数量不变的改名和正文变化"},
            "idempotencyKey":{"type":"string","minLength":1,"maxLength":200},
            "acknowledgePage":{"type":"boolean"},
            "candidates":{"type":"array","maxItems":100,"items":{"type":"object","properties":{
                "tagIds":{"type":"array","minItems":1,"maxItems":2,"uniqueItems":true,"items":{"type":"string","minLength":1}},
                "reason":{"type":"string","minLength":1,"maxLength":1000}},"required":["tagIds","reason"]}},
            "itemId":{"type":"string","minLength":1,"maxLength":100},"submitForReview":{"type":"boolean"},"proposal":proposal_schema
        },"required":["action"],"allOf":[
                {"if":{"properties":{"action":{"const":"start"}}},"then":{"required":["expectedIndexRevision","expectedAuditRevision","idempotencyKey"]},"else":{"required":["runId","requestId","expectedVersion"]}},
            {"if":{"properties":{"action":{"const":"queue"}}},"then":{"required":["candidates"]}},
            {"if":{"properties":{"action":{"const":"record"}}},"then":{"required":["itemId","proposal","submitForReview"],"properties":{"submitForReview":{"const":true}}}}
        ]}}),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        root: PathBuf,
    }
    impl Fixture {
        fn new(tags: usize) -> Self {
            let root =
                std::env::temp_dir().join(format!("hub-audit-resume-{}", random_url_safe(12)));
            std::fs::create_dir_all(&root).unwrap();
            let connection = open_database(&root.join("craft-search.sqlite3")).unwrap();
            connection
                .execute("INSERT INTO spaces(id,name,mcp_url,added_at) VALUES ('s','Test','https://example.invalid',1)", [])
                .unwrap();
            for index in 0..tags {
                let id = format!("t{index:03}");
                connection.execute("INSERT INTO documents(space_id,id,title,path,markdown,indexed_at,content_hash,provider) VALUES ('s',?1,?1,?1,'note',1,'hash','craft')",params![id]).unwrap();
                connection.execute("INSERT INTO craft_tags(space_id,document_id,page_id,tag,normalized_tag) VALUES ('s',?1,?1,?1,?1)",params![id]).unwrap();
            }
            Self { root }
        }
        fn connection(&self) -> Connection {
            open_database(&self.root.join("craft-search.sqlite3")).unwrap()
        }
        fn start(&self, key: &str) -> Value {
            let current = status(&self.root, &json!({})).unwrap();
            step(&self.root,&json!({"action":"start","idempotencyKey":key,"expectedIndexRevision":current["indexRevision"],"expectedAuditRevision":current["auditRevision"]})).unwrap()
        }
        fn args(&self, run: &Value, action: &str, request: &str) -> Value {
            json!({"action":action,"runId":run["run"]["runId"],"expectedVersion":run["run"]["version"],"requestId":request})
        }
        fn apply(&self, run: &Value, action: &str, request: &str, extra: Value) -> Value {
            let mut args = self.args(run, action, request);
            args.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            step(&self.root, &args).unwrap()
        }
        fn proposal_count(&self) -> usize {
            self.connection()
                .query_row("SELECT COUNT(*) FROM tag_governance_proposals", [], |row| {
                    row.get(0)
                })
                .unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(self.root.join("craft-search.sqlite3"));
            let _ = std::fs::remove_file(self.root.join("craft-search.sqlite3-wal"));
            let _ = std::fs::remove_file(self.root.join("craft-search.sqlite3-shm"));
            let _ = std::fs::remove_dir(&self.root);
        }
    }
    fn proposal(revision: &Value, tags: Value) -> Value {
        json!({"schemaVersion":"hub.tag-governance.v1","indexRevision":revision,"summary":"证据不足，保留独立",
            "recommendations":[{"type":"insufficient_evidence","sourceTagIds":tags,"confidence":0.3,"rationale":"样本稀疏，不建立关系","executed":false}]})
    }

    #[test]
    fn audit_resume_requires_page_ack_and_completion_is_idempotent() {
        let f = Fixture::new(0);
        assert!(status(&f.root, &json!({})).unwrap()["run"].is_null());
        let start = f.start("first");
        assert_eq!(f.start("first")["run"]["runId"], start["run"]["runId"]);
        assert!(step(&f.root, &f.args(&start, "finish", "too-early")).is_err());
        let args = f.args(&start, "scan", "scan-1");
        let scanned = step(&f.root, &args).unwrap();
        let replay = step(&f.root, &args).unwrap();
        assert_eq!(replay["replayed"], json!(true));
        assert_eq!(replay["run"]["version"], scanned["run"]["version"]);
        assert_eq!(
            status(&f.root, &json!({})).unwrap()["run"]["pendingCatalogPage"],
            scanned["run"]["pendingCatalogPage"]
        );
        assert!(step(&f.root, &f.args(&scanned, "scan", "scan-again")).is_err());
        let queued = f.apply(
            &scanned,
            "queue",
            "queue-1",
            json!({"candidates":[],"acknowledgePage":true}),
        );
        let args = f.args(&queued, "finish", "finish-1");
        let done = step(&f.root, &args).unwrap();
        assert_eq!(done["run"]["status"], json!("completed"));
        assert_eq!(step(&f.root, &args).unwrap()["replayed"], json!(true));
        assert!(step(&f.root, &f.args(&done, "queue", "after-done")).is_err());
        assert_eq!(f.proposal_count(), 0);
    }

    #[test]
    fn audit_resume_scans_full_catalog_and_deduplicates_candidate_pairs() {
        let f = Fixture::new(205);
        let mut run = f.start("catalog");
        for (page, expected) in [(0, 100), (1, 200), (2, 205)] {
            run = f.apply(&run, "scan", &format!("scan-{page}"), json!({}));
            assert_eq!(run["run"]["catalogScanned"], json!(expected));
            let mut bad = f.args(&run, "queue", &format!("bad-{page}"));
            bad["candidates"] = json!([{"tagIds":["missing"],"reason":"invalid"}]);
            bad["acknowledgePage"] = json!(true);
            assert!(step(&f.root, &bad).is_err());
            assert!(status(&f.root, &json!({})).unwrap()["run"]["pendingCatalogPage"].is_object());
            run = f.apply(
                &run,
                "queue",
                &format!("queue-{page}"),
                json!({"candidates":[],"acknowledgePage":true}),
            );
            assert_eq!(run["run"]["catalogReviewed"], json!(expected));
        }
        assert_eq!(run["run"]["coverage"], json!(1.0));
        run=f.apply(&run,"queue","pairs",json!({"candidates":[
            {"tagIds":["t000","t001"],"reason":"pair"},{"tagIds":["T001","t000"],"reason":"reverse"},
            {"tagIds":["t002"],"reason":"sparse"}]}));
        assert_eq!(run["run"]["candidateTotal"], json!(2));
        let page = status(&f.root, &json!({"limit":1})).unwrap();
        let rest = status(
            &f.root,
            &json!({"limit":1,"cursor":page["run"]["nextCursor"]}),
        )
        .unwrap();
        assert_ne!(
            page["run"]["items"][0]["itemId"],
            rest["run"]["items"][0]["itemId"]
        );
        assert!(rest["run"]["nextCursor"].is_null());
        assert!(status(&f.root, &json!({"cursor":"bad"})).is_err());
        assert!(step(&f.root, &f.args(&run, "finish", "unfinished")).is_err());
    }

    #[test]
    fn audit_resume_record_rolls_back_and_retries_without_duplicate_proposals() {
        let f = Fixture::new(2);
        let start = f.start("records");
        let scan = f.apply(&start, "scan", "scan", json!({}));
        let run = f.apply(
            &scan,
            "queue",
            "queue",
            json!({"acknowledgePage":true,"candidates":[
            {"tagIds":["t000"],"reason":"sparse"},{"tagIds":["t001"],"reason":"sparse"}]}),
        );
        let mut args = f.args(&run, "record", "record-1");
        args["itemId"] = run["run"]["items"][0]["itemId"].clone();
        args["proposal"] = proposal(&run["indexRevision"], json!(["t000"]));
        assert!(step(&f.root, &args).is_err()); // No authorization to submit.
        args["submitForReview"] = json!(true);
        let mut wrong = args.clone();
        wrong["proposal"] = proposal(&run["indexRevision"], json!(["t001"]));
        assert!(step(&f.root, &wrong).is_err());
        f.connection().execute_batch("CREATE TRIGGER audit_test_fail BEFORE UPDATE ON tag_audit_runs BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END;").unwrap();
        assert!(step(&f.root, &args).is_err());
        assert_eq!(f.proposal_count(), 0);
        assert_eq!(
            status(&f.root, &json!({})).unwrap()["run"]["candidateCompleted"],
            json!(0)
        );
        f.connection()
            .execute_batch("DROP TRIGGER audit_test_fail;")
            .unwrap();
        let recorded = step(&f.root, &args).unwrap();
        assert!(recorded["recordedProposalId"].is_string());
        let retry = step(&f.root, &args).unwrap();
        assert_eq!(retry["recordedProposalId"], recorded["recordedProposalId"]);
        assert_eq!(f.proposal_count(), 1);
        let mut conflict = args.clone();
        conflict["proposal"]["summary"] = json!("changed");
        assert!(step(&f.root, &conflict).is_err());
        let next=f.apply(&recorded,"record","record-2",json!({"itemId":recorded["run"]["items"][0]["itemId"],"submitForReview":true,"proposal":proposal(&recorded["indexRevision"],json!(["t001"]))}));
        assert_ne!(next["recordedProposalId"], recorded["recordedProposalId"]);
        assert_eq!(f.proposal_count(), 2);
        assert_eq!(next["run"]["candidateCompleted"], json!(2));
        assert_eq!(next["run"]["tagsAnalyzed"], json!(2));
        let all = status(&f.root, &json!({"itemStatus":"completed"})).unwrap();
        assert_eq!(all["run"]["items"].as_array().unwrap().len(), 2);
        let count: i64 = f
            .connection()
            .query_row("SELECT COUNT(*) FROM tag_taxonomy_relations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
        assert!(f.apply(&next, "finish", "finish", json!({}))["run"]["status"] == "completed");
    }

    #[test]
    fn audit_resume_detects_index_only_changes_and_prefers_current_run() {
        let f = Fixture::new(1);
        let old = f.start("old-index");
        f.connection().execute("INSERT INTO metadata(key,value) VALUES ('content_tag_revision','1') ON CONFLICT(key) DO UPDATE SET value='1'", []).unwrap();
        let changed = status(&f.root, &json!({})).unwrap();
        assert_eq!(changed["auditRevision"], old["auditRevision"]);
        assert_ne!(changed["indexRevision"], old["indexRevision"]);
        assert_eq!(changed["run"]["stale"], true);
        let fresh = f.start("fresh-index");
        f.connection()
            .execute(
                "UPDATE tag_audit_runs SET updated_at=9999999999 WHERE id=?1",
                [old["run"]["runId"].as_str().unwrap()],
            )
            .unwrap();
        let current = status(&f.root, &json!({})).unwrap();
        assert_eq!(current["run"]["runId"], fresh["run"]["runId"]);
        assert_eq!(current["run"]["stale"], false);
        assert_eq!(
            status(&f.root, &json!({"runId":old["run"]["runId"]})).unwrap()["run"]["stale"],
            true
        );
        assert!(step(&f.root, &f.args(&old, "scan", "old-scan"))
            .unwrap_err()
            .contains("索引已经变化"));
    }

    #[test]
    fn audit_resume_detects_same_count_changes_and_preserves_old_run() {
        let f = Fixture::new(1);
        let start = f.start("old");
        let scan = f.apply(&start, "scan", "scan", json!({}));
        f.connection()
            .execute("UPDATE documents SET title='changed' WHERE id='t000'", [])
            .unwrap();
        let changed = status(&f.root, &json!({})).unwrap();
        assert_eq!(changed["indexRevision"], start["indexRevision"]);
        assert_ne!(changed["auditRevision"], start["auditRevision"]);
        assert_eq!(changed["run"]["stale"], json!(true));
        assert!(step(&f.root, &f.args(&scan, "queue", "stale"))
            .unwrap_err()
            .contains("索引已经变化"));
        let fresh = f.start("new");
        assert_ne!(fresh["run"]["runId"], start["run"]["runId"]);
        assert_eq!(fresh["run"]["catalogScanned"], json!(0));
        assert_eq!(
            status(&f.root, &json!({})).unwrap()["run"]["runId"],
            fresh["run"]["runId"]
        );
        let old = status(&f.root, &json!({"runId":start["run"]["runId"]})).unwrap();
        assert!(old["run"]["pendingCatalogPage"].is_object());
        assert_eq!(old["run"]["stale"], json!(true));
        assert!(step(&f.root,&json!({"action":"start","idempotencyKey":"other","expectedIndexRevision":start["indexRevision"],"expectedAuditRevision":start["auditRevision"]})).is_err());
    }

    #[test]
    fn audit_resume_concurrent_steps_do_not_overwrite_each_other() {
        let f = Fixture::new(1);
        let start = f.start("concurrent");
        let a = f.args(&start, "scan", "worker-a");
        let b = f.args(&start, "scan", "worker-b");
        let root = f.root.clone();
        let worker = std::thread::spawn(move || step(&root, &a));
        let other = step(&f.root, &b);
        let first = worker.join().unwrap();
        assert_ne!(first.is_ok(), other.is_ok());
        let current = status(&f.root, &json!({})).unwrap();
        assert_eq!(current["run"]["version"], json!(1));
        assert_eq!(current["run"]["catalogScanned"], json!(1));
    }

    #[test]
    fn audit_resume_migration_from_49_preserves_indexed_data() {
        let f = Fixture::new(2);
        let database = f.root.join("craft-search.sqlite3");
        let connection = f.connection();
        connection.execute_batch("DROP TABLE tag_audit_receipts; DROP TABLE tag_audit_runs; UPDATE metadata SET value='49' WHERE key='schema_version';").unwrap();
        drop(connection);
        forget_initialized_database(&database);
        let migrated = f.connection();
        assert_eq!(
            metadata_u64(&migrated, "schema_version", 0),
            DATABASE_SCHEMA_VERSION as u64
        );
        assert_eq!(
            migrated
                .query_row("SELECT COUNT(*) FROM craft_tags", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            migrated
                .query_row("SELECT COUNT(*) FROM tag_audit_receipts", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        drop(migrated);
        assert_eq!(f.start("after-migration")["run"]["catalogTotal"], json!(2));
    }

    #[test]
    fn audit_resume_rejects_invalid_queue_and_reserved_submission_key() {
        let f = Fixture::new(2);
        let start = f.start("validation");
        let scan = f.apply(&start, "scan", "scan", json!({}));
        for candidates in [
            json!([{"tagIds":["t000","T000"],"reason":"duplicate"}]),
            json!([{"tagIds":[1],"reason":"wrong type"}]),
            json!([{"tagIds":["t000"],"reason":""}]),
            json!([{"tagIds":["t000","t001","t002"],"reason":"too broad"}]),
            json!(vec![json!({"tagIds":["t000"],"reason":"too many"}); 101]),
        ] {
            let mut args = f.args(&scan, "queue", "invalid");
            args["candidates"] = candidates;
            args["acknowledgePage"] = json!(true);
            assert!(step(&f.root, &args).is_err());
        }
        let current = status(&f.root, &json!({})).unwrap();
        assert_eq!(current["run"]["version"], scan["run"]["version"]);
        assert_eq!(current["run"]["candidateTotal"], json!(0));
        assert!(current["run"]["pendingCatalogPage"].is_object());
        let mut direct = proposal(&scan["indexRevision"], json!(["t000"]));
        direct["idempotencyKey"] = json!("audit:reserved");
        assert!(hub_submit_tag_governance_proposal(&f.root, &direct).is_err());
        assert_eq!(f.proposal_count(), 0);
    }
}
