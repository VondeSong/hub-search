//! Host-only Topic entry: a selection is not a grant, and creating Work never runs it.
use super::*;
#[cfg(test)]
mod tests;

fn fixed_grant(
    root: &Path,
    c: &Connection,
    anchor: &EvidenceLocator,
    grant: &Grant,
) -> Result<(), String> {
    // shortcut: first creation supports exact notes; date/library rules need the existing manifest preview before enabling.
    if !grant.library_ids.is_empty()
        || grant.manifest.is_some()
        || !grant.reading_item_keys.is_empty()
        || !grant.sources.is_empty()
        || !grant.images.is_empty()
        || !grant.attachment_library_ids.is_empty()
        || grant.notes.is_empty()
    {
        return Err(
            "本期创建目前只支持固定笔记；整库或日期清单请从原工作确认，不会复制旧月份成员".into(),
        );
    }
    if !grant.contains(anchor) {
        return Err("专题锚点不在所选笔记内".into());
    }
    for note in &grant.notes {
        let EvidenceLocator::Note { library_id, .. } = note else {
            return Err("专题创建仅支持笔记".into());
        };
        let enabled: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM libraries WHERE id=?1 AND provider='obsidian' AND enabled=1)",[library_id],|r|r.get(0)).map_err(|e|e.to_string())?;
        if !enabled {
            return Err("本期创建的 Obsidian 来源不可用".into());
        }
    }
    let catalog = grant.reader(root)?.catalog()?;
    if catalog["unavailableLibraries"].as_u64() != Some(0) {
        return Err("部分专题来源不可用，未授权或创建工作".into());
    }
    Ok(())
}
fn selection(
    root: &Path,
    c: &Connection,
    config: &Value,
) -> Result<(EvidenceLocator, Grant), String> {
    let rule = &config["sourceRule"];
    let anchor: EvidenceLocator =
        serde_json::from_value(rule["anchor"].clone()).map_err(|_| "专题来源锚点无效")?;
    let grant = if let Some(value) = rule.get("selection") {
        // Saved selection describes intent only. A fresh preview and explicit consent are still required.
        serde_json::from_value(value.clone()).map_err(|_| "专题来源选择记录无效")?
    } else {
        let w = source_work(
            root,
            c,
            rule["workId"].as_str().ok_or("原范围缺少可恢复选择")?,
        )?;
        if source_rule(&w)["scopeFingerprint"] != rule["scopeFingerprint"] {
            return Err("原范围已变化，请明确更新专题来源后再预览".into());
        }
        w.grant
    };
    if let Some(id) = rule["workId"].as_str() {
        let w = source_work(root, c, id)?;
        if source_rule(&w)["scopeFingerprint"] != rule["scopeFingerprint"] {
            return Err("原范围已变化，请明确更新专题来源后再预览".into());
        }
    }
    fixed_grant(root, c, &anchor, &grant)?;
    Ok((anchor, grant))
}
pub(super) fn period_directory(
    root: &Path,
    config: &mut Value,
    value: &Value,
) -> Result<(), String> {
    if value.is_null() {
        config["sourceRule"]
            .as_object_mut()
            .ok_or("来源规则无效")?
            .remove("periodDirectory");
        return Ok(());
    }
    let directory = value
        .as_str()
        .filter(|s| s.len() <= 1024)
        .ok_or("目录需要库内相对路径")?;
    let library = config["sourceRule"]["anchor"]["libraryId"]
        .as_str()
        .ok_or("笔记资料库缺失")?;
    // Validate with the existing metadata-only owner, including canonical path/date policy.
    source_scope::preview(
        root,
        &json!({"selection":{"libraryId":library,"directory":directory}}),
    )?;
    config["schemaVersion"] = json!(2);
    config["sourceRule"]["periodDirectory"] = json!(directory);
    Ok(())
}
pub(super) fn period_selection(config: &Value, month: &str) -> Result<Value, String> {
    period(&json!({"period":month}))?;
    let directory = config["sourceRule"]["periodDirectory"]
        .as_str()
        .ok_or("月份目录规则缺失")?;
    let library = config["sourceRule"]["anchor"]["libraryId"]
        .as_str()
        .ok_or("专题资料库无效")?;
    let (year, number) = month.split_once('-').ok_or("月份无效")?;
    let year = year.parse::<i32>().map_err(|_| "年份无效")?;
    let number = number.parse::<u32>().map_err(|_| "月份无效")?;
    let (next_year, next_month) = if number == 12 {
        (year + 1, 1)
    } else {
        (year, number + 1)
    };
    let end = chrono::NaiveDate::from_ymd_opt(next_year, next_month, 1)
        .and_then(|d| d.pred_opt())
        .ok_or("月份边界无效")?;
    Ok(
        json!({"libraryId":library,"directory":directory,"dateFrom":format!("{month}-01"),"dateTo":end.format("%Y-%m-%d").to_string()}),
    )
}
pub(super) fn period_scope(
    root: &Path,
    c: &Connection,
    config: &Value,
    month: &str,
) -> Result<(EvidenceLocator, Grant, Vec<Value>, Value), String> {
    if config["sourceRule"]["periodDirectory"].as_str().is_some() {
        if config["schemaVersion"] != 2 {
            return Err("月份规则缺少受支持的配置版本".into());
        }
        let library = config["sourceRule"]["anchor"]["libraryId"]
            .as_str()
            .ok_or("专题资料库无效")?;
        let enabled:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM libraries WHERE id=?1 AND provider='obsidian' AND enabled=1)",[library],|r|r.get(0)).map_err(|e|e.to_string())?;
        if !enabled {
            return Err("本期 Obsidian 来源不可用".into());
        }
        let (grant, manifest) =
            source_scope::resolve(root, &json!({"selection":period_selection(config,month)?}))?;
        let anchor = grant
            .manifest
            .as_ref()
            .and_then(|m| m.members.first())
            .ok_or("本期没有可授权笔记")?
            .clone();
        let notes=manifest["members"].as_array().ok_or("本期成员无效")?.iter().map(|item|json!({"locator":item["locator"],"title":item["title"],"sourcePath":item["path"],"version":item["sourceRevision"]})).collect();
        return Ok((
            anchor,
            grant,
            notes,
            json!({"kind":"periodManifest","selection":manifest["selection"],"dateCoverage":manifest["dateCoverage"],"snapshot":manifest["snapshot"],"totalMembers":manifest["totalMembers"],"bodyRead":false}),
        ));
    }
    let (anchor, grant) = selection(root, c, config)?;
    let reader = grant.reader(root)?;
    let mut notes = Vec::new();
    for note in &grant.notes {
        let value = reader.read(note, 0, 1, None)?;
        notes.push(json!({"locator":value.locator,"title":value.title,"sourcePath":value.source_path,"version":value.version}));
    }
    Ok((anchor, grant, notes, json!({"kind":"fixedNotes"})))
}
pub(super) fn check_period_work(
    root: &Path,
    c: &Connection,
    config: &Value,
    w: &Work,
    month: &str,
) -> Result<(), String> {
    let (_, grant, _, _) = period_scope(root, c, config, month)?;
    if !w
        .anchor
        .as_ref()
        .is_some_and(|anchor| grant.contains(anchor))
        || json!(skills::hash(&json!(grant).to_string())) != source_rule(w)["scopeFingerprint"]
    {
        return Err("该工作材料与本期规则不同，请在原工作明确核对范围；不能换工作清零用量".into());
    }
    Ok(())
}
fn current(c: &Connection, args: &Value) -> Result<Value, String> {
    let topic = latest(c, &text(args, "topicId", 100)?)?;
    if topic["revision"] != expected(args, "expectedRevision")? {
        return Err("专题配置已变化，请重新预览本期范围".into());
    }
    if topic["config"]["archived"] == true {
        return Err("专题已归档，请先恢复".into());
    }
    Ok(topic)
}
fn linked(c: &Connection, id: &str, month: &str) -> Result<Option<String>, String> {
    c.query_row(
        "SELECT work_id FROM agent_topic_works WHERE topic_id=?1 AND period=?2",
        params![id, month],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}
fn preview(root: &Path, c: &Connection, topic: &Value, month: &str) -> Result<Value, String> {
    let id = topic["id"].as_str().ok_or("专题身份无效")?;
    if let Some(work) = linked(c, id, month)? {
        return Ok(
            json!({"topicId":id,"revision":topic["revision"],"period":month,"existingWorkId":work}),
        );
    }
    let method = method_on(c, topic["methodVersion"].as_str().ok_or("方法身份无效")?)?;
    skills::Catalog::discover(root)?.pin_version(&method)?;
    let (anchor, grant, notes, scope) = period_scope(root, c, &topic["config"], month)?;
    let mut value = json!({"topicId":id,"revision":topic["revision"],"period":month,"methodVersion":method["id"],"defaultQuestion":topic["config"]["defaultQuestion"],"anchor":anchor,"selection":grant,"notes":notes,"scope":scope,"provider":"codex","sourceFreshness":"authorizedLocalCache; notVerifiedWithRemote"});
    value["fingerprint"] = json!(skills::hash(&value.to_string()));
    // shortcut: full-list preview is bounded; use the existing manifest cursors when an accepted scope exceeds it.
    if value.to_string().len() > 65_536 {
        return Err("完整本期预览超过64KiB，请缩小目录；未截断或授权部分成员".into());
    }
    Ok(value)
}
pub(super) fn ui(root: &Path, args: &Value) -> Result<Value, String> {
    let action = args["action"].as_str().unwrap_or_default();
    if action == "topicWorkNavigation" {
        let c = crate::source_evidence::open_read_database(root)?;
        let topic = text(args, "topicId", 100)?;
        latest(&c, &topic)?;
        let id = text(args, "workId", 150)?;
        let exists: bool = c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM agent_topic_works WHERE topic_id=?1 AND work_id=?2)",
                params![topic, id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !exists {
            return Err("该工作不属于当前专题".into());
        }
        let w = source_work(root, &c, &id)?;
        let value = w.grant.reader(root)?.read(w.source_anchor()?, 0, 1, None)?;
        let Some(EvidenceLocator::Note { library_id, .. }) = &w.anchor else {
            return Err("专题工作锚点无效".into());
        };
        let library: String = c
            .query_row(
                "SELECT name FROM libraries WHERE id=?1 AND enabled=1",
                [library_id],
                |r| r.get(0),
            )
            .map_err(|_| "资料库不可用")?;
        return Ok(
            json!({"workId":id,"source":{"anchor":w.anchor,"title":value.title,"path":value.source_path,"libraryName":library}}),
        );
    }
    if action == "topicWorkPreview" {
        let c = crate::source_evidence::open_read_database(root)?;
        return preview(root, &c, &current(&c, args)?, &period(args)?);
    }
    let (key, digest) = intent(args)?;
    let (id, work) = store::write(root, |c| {
        if let Some(id) = duplicate(c, &key, &digest)? {
            let work = if action == "topicCreateWork" {
                linked(c, &id, &period(args)?)?
            } else {
                None
            };
            return Ok((id, work));
        }
        if action == "topicCreateEmpty" {
            let anchor: EvidenceLocator =
                serde_json::from_value(args["anchor"].clone()).map_err(|_| "专题锚点无效")?;
            let grant = Grant {
                notes: vec![anchor.clone()],
                ..Default::default()
            };
            fixed_grant(root, c, &anchor, &grant)?;
            let preference = args["outputPreference"].as_str().unwrap_or_default();
            if preference.chars().count() > 500 {
                return Err("输出偏好最多500字符".into());
            }
            let method = save_method(root, c, &text(args, "skill", 64)?)?;
            let config = json!({"schemaVersion":1,"title":text(args,"title",100)?,"defaultQuestion":text(args,"defaultQuestion",2000)?,"parameters":{"period":period(args)?,"outputPreference":preference},"sourceRule":{"kind":"fixedNoteSelection","anchor":anchor,"membership":"fixedNotes","scopeFingerprint":skills::hash(&json!(grant).to_string()),"selection":grant},"archived":false});
            let id = format!("topic-{}", crate::random_url_safe(18));
            append_config(c, &id, 1, &method, &config, &key, &digest)?;
            return Ok((id, None));
        }
        let topic = current(c, args)?;
        let id = topic["id"].as_str().ok_or("专题身份无效")?;
        let month = period(args)?;
        if let Some(work) = linked(c, id, &month)? {
            return Ok((id.into(), Some(work)));
        }
        if args["confirmedScope"] != true {
            return Err("请先核对并明确授权本期列出的笔记范围".into());
        }
        let planned = preview(root, c, &topic, &month)?;
        if args["expectedPreview"] != planned["fingerprint"] {
            return Err("实际笔记版本、范围或方法已变化，请重新预览后授权".into());
        }
        let anchor = serde_json::from_value::<EvidenceLocator>(planned["anchor"].clone())
            .map_err(|_| "预览锚点无效")?;
        let grant =
            serde_json::from_value(planned["selection"].clone()).map_err(|_| "预览范围无效")?;
        let goal = text(&topic["config"], "defaultQuestion", 2000)?;
        let work = store::create_on(
            c,
            goal,
            "按本期问题交付有出处的成果，保留缺失、失败及适用限制".into(),
            anchor,
            grant,
        )?;
        // Explicit per-Work choice; global model settings and automatic writes stay unchanged.
        store::insert(
            c,
            &work,
            None,
            "assistantOptions",
            &json!(options::Options {
                native_capabilities: Default::default(),
                model: Some(crate::model_runtime::Settings::default()),
                research_policy: None,
                auto_flashcard_inbox: false,
                external_mcp: false,
                mcp_services: vec![],
                web_search: Default::default(),
            }),
        )?;
        let w = store::load(c, &work)?;
        store::insert(
            c,
            &work,
            None,
            "topicBinding",
            &json!({"schemaVersion":1,"topicId":id,"configRevision":topic["revision"],"period":month,"methodVersion":topic["methodVersion"],"authorizationVersion":w.authorization_version,"scopeFingerprint":source_rule(&w)["scopeFingerprint"],"clientRequestId":key,"requestHash":digest,"scopeConfirmation":{"previewFingerprint":planned["fingerprint"],"members":planned["notes"]}}),
        )?;
        link(
            c,
            id,
            &month,
            &work,
            topic["revision"].as_i64().ok_or("专题版本无效")?,
            &key,
            &digest,
        )?;
        Ok((id.into(), Some(work)))
    })?;
    let mut value = read_topic(root, &id)?;
    value["openedWorkId"] = json!(work);
    Ok(value)
}
