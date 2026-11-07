//! Topics organize existing work and fixed methods; they never own a model budget or source write.
use super::*;
mod changes;
mod entry;

const DATA_BYTES: usize = 20 * 1_048_576;
const LINK_RESERVATION: usize = 512;

pub(super) fn migrate(c: &Connection) -> Result<(), rusqlite::Error> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS agent_method_versions (
        id TEXT PRIMARY KEY,content_json TEXT NOT NULL,created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS agent_topic_revisions (
        topic_id TEXT NOT NULL,revision INTEGER NOT NULL,method_version TEXT NOT NULL REFERENCES agent_method_versions(id),
        config_json TEXT NOT NULL,client_id TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,created_at INTEGER NOT NULL,
        PRIMARY KEY(topic_id,revision));
        CREATE TABLE IF NOT EXISTS agent_topic_works (
        topic_id TEXT NOT NULL,period TEXT NOT NULL,work_id TEXT NOT NULL,config_revision INTEGER NOT NULL,
        client_id TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,created_at INTEGER NOT NULL,
        PRIMARY KEY(topic_id,period),UNIQUE(topic_id,work_id),
        FOREIGN KEY(topic_id,config_revision) REFERENCES agent_topic_revisions(topic_id,revision));")?;
    for (table, columns, key) in [
        ("agent_method_versions", "id,content_json,created_at", "id"),
        (
            "agent_topic_revisions",
            "topic_id,revision,method_version,config_json,client_id,request_hash,created_at",
            "topic_id,revision",
        ),
        (
            "agent_topic_works",
            "topic_id,period,work_id,config_revision,client_id,request_hash,created_at",
            "topic_id,period",
        ),
    ] {
        c.prepare(&format!("SELECT {columns} FROM {table} LIMIT 0"))?;
        let primary:String=c.query_row("SELECT COALESCE(group_concat(name,','),'') FROM (SELECT name FROM pragma_table_info(?1) WHERE pk>0 ORDER BY pk)",[table],|r|r.get(0))?;
        if primary != key {
            return Err(rusqlite::Error::InvalidQuery);
        }
    }
    for (table, columns) in [
        ("agent_topic_revisions", "client_id"),
        ("agent_topic_works", "client_id"),
        ("agent_topic_works", "topic_id,work_id"),
    ] {
        let unique:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM pragma_index_list(?1) i WHERE i.[unique]=1 AND (SELECT group_concat(name,',') FROM pragma_index_info(i.name))=?2)",params![table,columns],|r|r.get(0))?;
        if !unique {
            return Err(rusqlite::Error::InvalidQuery);
        }
    }
    Ok(())
}

fn decode(raw: &str) -> Result<Value, String> {
    if raw.len() > 65_536 {
        return Err("专题或方法记录超出已有容量上限".into());
    }
    serde_json::from_str(raw).map_err(|_| "专题或方法记录损坏".into())
}
pub(super) fn admit(c: &Connection, extra: usize) -> Result<(), String> {
    let bytes:i64=c.query_row("SELECT (SELECT COALESCE(SUM(length(CAST(content_json AS BLOB))),0) FROM agent_method_versions)+(SELECT COALESCE(SUM(length(CAST(config_json AS BLOB))),0) FROM agent_topic_revisions)+(SELECT COUNT(*)*512 FROM agent_topic_works)+(SELECT COALESCE(SUM(length(CAST(directory AS BLOB))+length(CAST(name AS BLOB))+length(client_id)+length(request_hash)+512),0) FROM agent_skill_source_revisions)+(SELECT COALESCE(SUM(length(CAST(detail_json AS BLOB))+length(id)+length(request_hash)+512),0) FROM agent_skill_package_operations)",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    if extra > DATA_BYTES || bytes as usize > DATA_BYTES - extra {
        return Err("专题与方法保存容量已用尽，原配置和工作保留".into());
    }
    Ok(())
}
fn intent(args: &Value) -> Result<(String, String), String> {
    let id = text(args, "clientRequestId", 80)?;
    if !id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("专题请求身份无效".into());
    }
    Ok((id, skills::hash(&args.to_string())))
}
fn period(args: &Value) -> Result<String, String> {
    let value = text(args, "period", 7)?;
    let date = chrono::NaiveDate::parse_from_str(&format!("{value}-01"), "%Y-%m-%d")
        .map_err(|_| "周期需要明确的 YYYY-MM 月份")?;
    if date.format("%Y-%m").to_string() != value {
        return Err("周期需要明确的 YYYY-MM 月份".into());
    }
    Ok(value)
}
fn expected(args: &Value, key: &str) -> Result<i64, String> {
    args[key]
        .as_i64()
        .filter(|v| *v > 0)
        .ok_or_else(|| format!("缺少有效的 {key}"))
}
fn source_work(root: &Path, c: &Connection, id: &str) -> Result<Work, String> {
    let w = store::load(c, id)?;
    if w.state == "revoked" {
        return Err("来源授权已撤回，专题不会重新授权资料".into());
    }
    if !matches!(w.anchor, Some(EvidenceLocator::Note { .. }))
        || !w.grant.reading_item_keys.is_empty()
        || !w.grant.sources.is_empty()
        || !w.grant.images.is_empty()
        || !w.grant.attachment_library_ids.is_empty()
    {
        return Err("首批专题只支持已有 Obsidian 笔记范围".into());
    }
    let mut libraries = w.grant.library_ids.clone();
    for note in w
        .grant
        .notes
        .iter()
        .chain(w.grant.manifest.iter().flat_map(|m| m.members.iter()))
    {
        let EvidenceLocator::Note { library_id, .. } = note else {
            return Err("专题材料必须是已授权笔记".into());
        };
        libraries.push(library_id.clone());
    }
    for id in libraries {
        let provider: String = c
            .query_row(
                "SELECT provider FROM libraries WHERE id=?1 AND enabled=1",
                [id],
                |r| r.get(0),
            )
            .map_err(|_| "来源资料库不可用")?;
        if provider != "obsidian" {
            return Err("首批专题尚未接入其它来源".into());
        }
    }
    w.grant.reader(root)?.catalog()?;
    Ok(w)
}
fn source_rule(w: &Work) -> Value {
    json!({"kind":"existingWorkScope","workId":w.id,"anchor":w.anchor,"authorizationVersion":w.authorization_version,
        "scopeFingerprint":skills::hash(&json!(w.grant).to_string()),
        "selection":w.grant,"membership":if w.grant.manifest.is_some(){"fixedManifest"}else if w.grant.library_ids.is_empty(){"fixedNotes"}else{"liveAuthorizedLibrary"}})
}
pub(super) fn method_on(c: &Connection, id: &str) -> Result<Value, String> {
    let raw: String = c
        .query_row(
            "SELECT content_json FROM agent_method_versions WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .map_err(|_| "固定方法内容缺失，不能只凭引用恢复")?;
    let value = decode(&raw)?;
    if value["deleted"] == true {
        return Err(
            "固定方法内容已按明确删除要求移除；历史成果保留，不能恢复旧方法或继续旧运行".into(),
        );
    }
    if value["id"] != id || id != format!("method-{}", skills::hash(&value["content"].to_string()))
    {
        return Err("固定方法内容与身份不匹配".into());
    }
    Ok(value)
}
fn save_method(root: &Path, c: &Connection, name: &str) -> Result<String, String> {
    let value = skills::Catalog::discover(root)?.fixed_version(name)?;
    let id = value["id"].as_str().ok_or("方法身份缺失")?;
    let raw = value.to_string();
    let old: Option<String> = c
        .query_row(
            "SELECT content_json FROM agent_method_versions WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(old) = old {
        if decode(&old)? != value {
            return Err("方法版本身份冲突，旧内容保留".into());
        }
    } else {
        admit(c, raw.len())?;
        c.execute(
            "INSERT INTO agent_method_versions VALUES(?1,?2,?3)",
            params![id, raw, store::stamp()],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(id.into())
}
fn latest(c: &Connection, id: &str) -> Result<Value, String> {
    let (revision,method,raw):(i64,String,String)=c.query_row("SELECT revision,method_version,config_json FROM agent_topic_revisions WHERE topic_id=?1 ORDER BY revision DESC LIMIT 1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|_|"专题不存在")?;
    let config = decode(&raw)?;
    if config["schemaVersion"] != 1 && config["schemaVersion"] != 2 {
        return Err("专题配置版本不兼容".into());
    }
    Ok(json!({"id":id,"revision":revision,"methodVersion":method,"config":config}))
}
fn duplicate(c: &Connection, key: &str, digest: &str) -> Result<Option<String>, String> {
    let prior:Option<(String,String)>=c.query_row("SELECT topic_id,request_hash FROM agent_topic_revisions WHERE client_id=?1 UNION ALL SELECT topic_id,request_hash FROM agent_topic_works WHERE client_id=?1 UNION ALL SELECT json_extract(body_json,'$.topicId'),json_extract(body_json,'$.requestHash') FROM agent_records WHERE kind='topicBinding' AND json_extract(body_json,'$.clientRequestId')=?1 LIMIT 1",[key],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e|e.to_string())?;
    if let Some((id, saved)) = prior {
        if saved != digest {
            return Err("同一专题请求不能替换为不同内容".into());
        }
        return Ok(Some(id));
    }
    Ok(None)
}
fn append_config(
    c: &Connection,
    id: &str,
    revision: i64,
    method: &str,
    config: &Value,
    key: &str,
    digest: &str,
) -> Result<(), String> {
    let encoded = config.to_string();
    if encoded.len() > 65_536 {
        return Err("专题配置过大".into());
    }
    admit(c, encoded.len())?;
    c.execute(
        "INSERT INTO agent_topic_revisions VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![id, revision, method, encoded, key, digest, store::stamp()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
fn link(
    c: &Connection,
    id: &str,
    month: &str,
    work: &str,
    revision: i64,
    key: &str,
    digest: &str,
) -> Result<(), String> {
    let old: Option<String> = c
        .query_row(
            "SELECT work_id FROM agent_topic_works WHERE topic_id=?1 AND period=?2",
            params![id, month],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(old) = old {
        if old == work {
            return Ok(());
        }
        return Err("这个周期已有原工作；修订或失败恢复必须继续该工作，不能换事项清零用量".into());
    }
    let exists: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_topic_works WHERE topic_id=?1 AND work_id=?2)",
            params![id, work],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if exists {
        return Err("同一工作已经关联其它周期，不能改写其历史归属".into());
    }
    admit(c, LINK_RESERVATION)?;
    c.execute(
        "INSERT INTO agent_topic_works VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![id, month, work, revision, key, digest, store::stamp()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
fn read_topic(root: &Path, id: &str) -> Result<Value, String> {
    let c = crate::source_evidence::open_read_database(root)?;
    let topic = latest(&c, id)?;
    let method_id = topic["methodVersion"].as_str().ok_or("方法身份无效")?;
    let (method, compatible) = match method_on(&c, method_id) {
        Ok(method) => {
            let result = skills::Catalog::discover(root)?.pin_version(&method);
            (method, result)
        }
        Err(reason) => (json!({"id":method_id,"content":{"files":{}}}), Err(reason)),
    };
    let mut q=c.prepare("SELECT l.period,l.work_id,l.config_revision,w.goal,w.state,w.report_json IS NOT NULL,w.anchor_json,(SELECT body_json FROM agent_records m WHERE m.run_id=(SELECT id FROM agent_runs u WHERE u.work_id=l.work_id ORDER BY u.rowid DESC LIMIT 1) AND m.kind='topicMethodUse' ORDER BY m.rowid DESC LIMIT 1) FROM agent_topic_works l LEFT JOIN agent_works w ON w.id=l.work_id WHERE l.topic_id=?1 ORDER BY l.rowid DESC").map_err(|e|e.to_string())?;
    let history=q.query_map([id],|r|Ok(json!({"period":r.get::<_,String>(0)?,"workId":r.get::<_,String>(1)?,"configRevision":r.get::<_,i64>(2)?,"goal":r.get::<_,Option<String>>(3)?,"state":r.get::<_,Option<String>>(4)?,"hasReport":r.get::<_,bool>(5)?,"anchor":r.get::<_,Option<String>>(6)?.map(|s|serde_json::from_str::<Value>(&s).unwrap_or(Value::Null)),"methodAdoption":"seeOriginalRun","methodUse":r.get::<_,Option<String>>(7)?.map(|s|serde_json::from_str::<Value>(&s).unwrap_or(Value::Null))}))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    Ok(
        json!({"topic":topic,"method":method,"methodCompatible":compatible.is_ok(),"methodUnavailableReason":compatible.err(),"history":history,
        "scopePolicy":"专题保存配置与关联，不增加资料授权；整库规则的实际成员在每轮重新核对，固定成员不自动扩大。正文、数据和成果仍从原工作按当前授权打开。",
        "methodPolicy":"固定方法表示配置版本；旧工作实际是否加载，以原运行记录为准。保存专题不会创建运行或改判历史成果。"}),
    )
}

pub(super) fn version_on(c: &Connection, w: &Work) -> Result<Option<(Value, Value)>, String> {
    let raw:Option<String>=c.query_row("SELECT body_json FROM agent_records WHERE work_id=?1 AND kind='topicBinding' ORDER BY rowid DESC LIMIT 1",[&w.id],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    let Some(raw) = raw else {
        return Ok(None);
    };
    let binding = decode(&raw)?;
    if binding["schemaVersion"] != 1
        || binding["authorizationVersion"] != w.authorization_version
        || binding["scopeFingerprint"] != source_rule(w)["scopeFingerprint"]
    {
        return Err("专题材料范围或授权已变化，请在原工作重新核对绑定；累计用量保留".into());
    }
    let id = binding["topicId"].as_str().ok_or("专题绑定身份缺失")?;
    let revision = binding["configRevision"]
        .as_i64()
        .ok_or("专题绑定修订缺失")?;
    let (method,raw):(String,String)=c.query_row("SELECT method_version,config_json FROM agent_topic_revisions WHERE topic_id=?1 AND revision=?2",params![id,revision],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|_|"专题原配置已不可用，未换用最新配置")?;
    if binding["methodVersion"] != method {
        return Err("专题绑定与原方法版本不一致".into());
    }
    let mut binding = binding;
    let config = decode(&raw)?;
    if config["schemaVersion"] != 1 && config["schemaVersion"] != 2 {
        return Err("专题绑定配置版本不兼容，未启动运行".into());
    }
    binding["parameters"] = config["parameters"].clone();
    binding["parameters"]["period"] = binding["period"].clone();
    binding["defaultQuestion"] = config["defaultQuestion"].clone();
    Ok(Some((binding, method_on(c, &method)?)))
}

pub(super) fn preflight(
    root: &Path,
    c: &Connection,
    w: &Work,
    provider: &str,
    assistant: bool,
) -> Result<(), String> {
    if let Some((_, version)) = version_on(c, w)? {
        source_work(root, c, &w.id)?;
        if provider != "codex" || !assistant {
            return Err(
                "首批固定方法专题仅支持 Codex 工作助手；未创建新运行或预留，原进度与用量保留"
                    .into(),
            );
        }
        skills::Catalog::discover(root)?.pin_version(&version)?;
    }
    Ok(())
}

pub(super) fn attach_runtime(
    root: &Path,
    w: &Work,
    run: &str,
    skills: &mut Option<crate::hub_capabilities::Session>,
) -> Result<(), String> {
    let c = crate::source_evidence::open_read_database(root)?;
    if let Some((binding, version)) = version_on(&c, w)? {
        let catalog = skills.as_mut().ok_or("固定方法需要工作助手入口")?;
        catalog.pin_version(&version)?;
        catalog.set_topic_context(&binding)?;
        let mut binding = binding;
        binding["hostVersion"] = json!(env!("CARGO_PKG_VERSION"));
        store::record(root, run, "topicRunBinding", &binding)?;
    }
    Ok(())
}

pub(super) fn record_method_use(c: &Connection, work: &Work, run: &str) -> Result<(), String> {
    let raw:Option<String>=c.query_row("SELECT body_json FROM agent_records WHERE run_id=?1 AND kind='topicRunBinding' ORDER BY rowid DESC LIMIT 1",[run],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    let Some(raw) = raw else {
        return Ok(());
    };
    let binding = decode(&raw)?;
    let version = method_on(
        c,
        binding["methodVersion"]
            .as_str()
            .ok_or("固定方法身份缺失")?,
    )?;
    let (expected, instructions) = skills::fixed_instruction_identity(&version)?;
    let name = &version["content"]["name"];
    let mut q=c.prepare("SELECT body_json FROM agent_records WHERE work_id=?1 AND run_id=?2 AND kind='toolResult' ORDER BY rowid").map_err(|e|e.to_string())?;
    let rows = q
        .query_map(params![work.id, run], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut calls = Vec::new();
    for row in rows {
        let body: Value = serde_json::from_str(&row.map_err(|e| e.to_string())?)
            .map_err(|_| "工具回执记录损坏")?;
        if body["kind"] != "skillInstructions" && body["value"]["kind"] != "skillInstructions" {
            continue;
        }
        let value = store::tool_results::raw(&body)?;
        if value["skill"]["origin"] == version["content"]["origin"]
            && (version["content"]["origin"] == "builtin"
                || (value["skill"]["packageId"] == version["content"]["packageId"]
                    && value["skill"]["methodVersion"] == binding["methodVersion"]))
            && value["skill"]["name"] == *name
            && value["skill"]["version"] == expected
            && value["instructions"] == instructions
        {
            calls.push(body["_hubTrace"]["callId"].clone());
        }
    }
    let mut sent = false;
    for call in &calls {
        let present:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_records WHERE run_id=?1 AND kind='nativeContextDelivery' AND json_extract(body_json,'$.callId')=?2 AND json_extract(body_json,'$.phase') IN ('flushedToProviderStdin','flushedToExternalMcpStdout'))",params![run,call.as_str().unwrap_or_default()],|r|r.get(0)).map_err(|e|e.to_string())?;
        sent |= present;
    }
    store::insert(
        c,
        &work.id,
        Some(run),
        "topicMethodUse",
        &json!({"schemaVersion":1,"methodVersion":binding["methodVersion"],"configRevision":binding["configRevision"],"loadedThisRun":!calls.is_empty(),"sentToRuntime":sent,"callIds":calls,"semanticUse":"unverified","inheritedUse":"unverified"}),
    )
}

pub(super) fn ui(root: &Path, args: &Value) -> Result<Value, String> {
    let action = args["action"].as_str().unwrap_or_default();
    if matches!(
        action,
        "topicCreateEmpty" | "topicWorkPreview" | "topicCreateWork" | "topicWorkNavigation"
    ) {
        return entry::ui(root, args);
    }
    if action == "topicChanges" {
        return changes::inspect(root, args);
    }
    if action == "topicOpen" {
        return read_topic(root, &text(args, "topicId", 100)?);
    }
    if action == "topicList" {
        let offset = args["offset"].as_u64().unwrap_or(0);
        if offset > 5000 {
            return Err("专题分页超出范围".into());
        }
        let c = crate::source_evidence::open_read_database(root)?;
        let anchor = args
            .get("anchor")
            .map(|v| {
                serde_json::from_value::<EvidenceLocator>(v.clone()).map_err(|_| "专题来源锚点无效")
            })
            .transpose()?
            .map(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
            .transpose()?;
        let mut q=c.prepare("SELECT r.topic_id,r.revision,r.config_json FROM agent_topic_revisions r WHERE NOT EXISTS(SELECT 1 FROM agent_topic_revisions n WHERE n.topic_id=r.topic_id AND n.revision>r.revision) AND json_extract(r.config_json,'$.archived')=0 ORDER BY r.created_at DESC,r.topic_id LIMIT 26 OFFSET ?1").map_err(|e|e.to_string())?;
        let rows = q
            .query_map([offset], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let more = rows.len() > 25;
        let mut topics = Vec::new();
        for (id, revision, raw) in rows.into_iter().take(25) {
            let v = decode(&raw)?;
            if anchor
                .as_ref()
                .is_some_and(|a| *a != v["sourceRule"]["anchor"])
            {
                continue;
            }
            topics.push(json!({"id":id,"revision":revision,"title":v["title"],"parameters":v["parameters"]}));
        }
        return Ok(json!({"topics":topics,"nextOffset":if more{Some(offset+25)}else{None}}));
    }
    let (key, digest) = intent(args)?;
    let _active = if action == "topicBind" {
        let work = text(args, "workId", 150)?;
        let map = active().lock().map_err(|_| "对话运行状态不可用")?;
        if map.contains_key(&(root_key(root), work)) {
            return Err("请等待当前一轮结束后再固定专题方法".into());
        }
        Some(map)
    } else {
        None
    };
    let id = store::write(root, |c| {
        if let Some(id) = duplicate(c, &key, &digest)? {
            return Ok(id);
        }
        if action == "topicCreate" {
            let work = text(args, "workId", 150)?;
            let w = source_work(root, c, &work)?;
            if w.active_run.is_some()
                || w.report.is_none()
                || w.revision != expected(args, "expectedWorkRevision")?
            {
                return Err("请从已结束且有成果的当前工作保存专题；工作变化后先刷新".into());
            }
            let preference = args["outputPreference"].as_str().unwrap_or_default();
            if preference.chars().count() > 500 {
                return Err("输出偏好最多500字符".into());
            }
            let month = period(args)?;
            let method = save_method(root, c, &text(args, "skill", 64)?)?;
            let id = format!("topic-{}", crate::random_url_safe(18));
            let config = json!({"schemaVersion":1,"title":text(args,"title",100)?,"defaultQuestion":w.goal,"parameters":{"period":month,"outputPreference":args["outputPreference"].as_str().unwrap_or_default()},"sourceRule":source_rule(&w),"archived":false});
            let same:Option<String>=c.query_row("SELECT r.topic_id FROM agent_topic_revisions r WHERE r.config_json=?1 AND r.method_version=?2 AND NOT EXISTS(SELECT 1 FROM agent_topic_revisions n WHERE n.topic_id=r.topic_id AND n.revision>r.revision) LIMIT 1",params![config.to_string(),method],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
            if let Some(saved) = same {
                return Ok(saved);
            }
            append_config(c, &id, 1, &method, &config, &key, &digest)?;
            link(c, &id, &month, &work, 1, &format!("{key}-initial"), &digest)?;
            return Ok(id);
        }
        let id = text(args, "topicId", 100)?;
        let current = latest(c, &id)?;
        let revision = current["revision"].as_i64().ok_or("专题修订身份无效")?;
        if expected(args, "expectedRevision")? != revision {
            return Err("专题配置已在另一处变化，原内容保留，请刷新后比较".into());
        }
        let mut config = current["config"].clone();
        let mut method = current["methodVersion"]
            .as_str()
            .ok_or("方法身份无效")?
            .to_string();
        match action {
            "topicUpdate" => {
                config["title"] = json!(text(args, "title", 100)?);
                if args.get("defaultQuestion").is_some() {
                    config["defaultQuestion"] = json!(text(args, "defaultQuestion", 2000)?);
                }
                config["parameters"]["period"] = json!(period(args)?);
                let preference = args["outputPreference"].as_str().unwrap_or_default();
                if preference.chars().count() > 500 {
                    return Err("输出偏好最多500字符".into());
                }
                config["parameters"]["outputPreference"] = json!(preference);
                if let Some(directory) = args.get("periodDirectory") {
                    entry::period_directory(root, &mut config, directory)?;
                }
                if let Some(source) = args["sourceWorkId"].as_str() {
                    let rule = source_rule(&source_work(root, c, source)?);
                    if rule["anchor"] != config["sourceRule"]["anchor"] {
                        return Err("首批专题保留原笔记锚点；跨锚点导航尚未启用".into());
                    }
                    config["sourceRule"] = rule;
                }
                if let Some(name) = args["skill"].as_str() {
                    method = save_method(root, c, name)?;
                }
                if config != current["config"] || method != current["methodVersion"] {
                    append_config(c, &id, revision + 1, &method, &config, &key, &digest)?;
                }
            }
            "topicArchive" => {
                config["archived"] = args["archived"]
                    .as_bool()
                    .map(Value::Bool)
                    .ok_or("归档状态无效")?;
                append_config(c, &id, revision + 1, &method, &config, &key, &digest)?;
            }
            "topicLink" | "topicBind" => {
                if config["archived"] == true {
                    return Err("专题已归档，工作不会自动取消；继续前请先恢复专题".into());
                }
                let work = text(args, "workId", 150)?;
                let w = source_work(root, c, &work)?;
                let month = period(args)?;
                if config["sourceRule"]["periodDirectory"].is_string()
                    || config["sourceRule"]["scopeFingerprint"].is_null()
                        && config["sourceRule"]["selection"].is_object()
                {
                    entry::check_period_work(root, c, &config, &w, &month)?;
                } else {
                    if config["sourceRule"]["anchor"] != json!(w.anchor) {
                        return Err("首批专题只关联同一笔记锚点的工作".into());
                    }
                    if config["sourceRule"]["scopeFingerprint"]
                        != source_rule(&w)["scopeFingerprint"]
                    {
                        return Err(
                            "这份工作的材料范围不同；请先明确更新专题来源规则，不能静默加入新材料"
                                .into(),
                        );
                    }
                }
                if action == "topicBind" {
                    if w.active_run.is_some()
                        || w.revision != expected(args, "expectedWorkRevision")?
                    {
                        return Err("请等待当前一轮结束，并核对最新工作后再固定方法".into());
                    }
                    let snapshot = method_on(c, &method)?;
                    skills::Catalog::discover(root)?.pin_version(&snapshot)?;
                    store::insert(
                        c,
                        &work,
                        None,
                        "topicBinding",
                        &json!({"schemaVersion":1,"topicId":id,"configRevision":revision,"period":month,"methodVersion":method,
                        "authorizationVersion":w.authorization_version,"scopeFingerprint":source_rule(&w)["scopeFingerprint"],"clientRequestId":key,"requestHash":digest}),
                    )?;
                }
                link(c, &id, &month, &work, revision, &key, &digest)?;
            }
            _ => return Err("未知专题操作".into()),
        }
        Ok(id)
    })?;
    read_topic(root, &id)
}

#[cfg(test)]
mod tests;
