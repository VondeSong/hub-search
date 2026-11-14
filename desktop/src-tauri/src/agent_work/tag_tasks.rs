use super::*;
mod results;

pub(super) fn records(root: &Path, work: &str) -> Result<Vec<Value>, String> {
    results::records(root, work, "tagTaskResult")
}
fn model_context(root: &Path, body: &Value) -> Result<Value, String> {
    let mut value = results::model_view(body);
    if body["intent"]["task"] == "relations" {
        value["storedProposals"] =
            crate::hub_mcp::agent_tags::saved_relation_proposals(root, &body["result"])?;
    }
    Ok(value)
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Intent {
    task: Option<String>,
    tag: Option<String>,
    compare_tag: Option<String>,
    expected_version: Option<i64>,
    #[serde(default)]
    resume: bool,
    #[serde(default)]
    references: Vec<String>,
}
fn validate(intent: &Intent) -> Result<(), String> {
    if intent.references.len() > 16
        || intent
            .references
            .iter()
            .chain(intent.tag.iter())
            .chain(intent.compare_tag.iter())
            .any(|s| s.trim().is_empty() || s.len() > 200 || s.trim() != s)
    {
        return Err("标签引用无效或过多".into());
    }
    if let Some(task) = &intent.task {
        if !["definition", "missing", "relations"].contains(&task.as_str())
            || intent.tag.is_none()
            || intent.expected_version.is_none()
        {
            return Err("请先选择标签并核对当前定义".into());
        }
    }
    Ok(())
}
pub(super) fn configure(root: &Path, args: &Value) -> Result<Value, String> {
    let id = text(args, "id", 150)?;
    let intent: Intent =
        serde_json::from_value(args["intent"].clone()).map_err(|_| "标签任务无效")?;
    validate(&intent)?;
    let map = active().lock().map_err(|_| "运行状态不可用")?;
    if map.contains_key(&(root_key(root), id.clone())) {
        return Err("请等待本轮结束后提交标签任务".into());
    }
    store::write(root, |c| {
        let w = store::load(c, &id)?;
        if w.state == "revoked" || w.active_run.is_some() || args["expectedRevision"] != w.revision
        {
            return Err("对话已更新，请刷新后再提交标签任务".into());
        }
        store::insert(
            c,
            &id,
            None,
            "tagTask",
            &json!({"revision":w.revision,"intent":intent}),
        )
    })?;
    drop(map);
    status(root, &id)
}
pub(super) fn prepare(
    root: &Path,
    w: &Work,
    run: &str,
    control: &Control,
    budget: Budget,
    selection: Option<&Value>,
    used: &mut runner::Usage,
    ask: &mut dyn FnMut(&str, &Value) -> Result<Value, String>,
) -> Result<Option<Value>, String> {
    let Some(saved) = store::records(root, &w.id, "tagTask", 1)?
        .into_iter()
        .next()
        .filter(|v| v["revision"] == w.revision)
    else {
        return Ok(None);
    };
    let intent: Intent =
        serde_json::from_value(saved["intent"].clone()).map_err(|_| "标签任务记录损坏")?;
    validate(&intent)?;
    let guard = || -> Result<(), String> {
        control.check()?;
        let c = crate::source_evidence::open_read_database(root)?;
        let current = store::load(&c, &w.id)?;
        if current.state == "revoked"
            || current.revision != w.revision
            || current.authorization_version != w.authorization_version
        {
            return Err("资料授权或任务已变化，标签分析停止".into());
        }
        current.grant.reader(root)?.catalog()?;
        Ok(())
    };
    guard()?;
    let mut references = Vec::new();
    for tag in &intent.references {
        let d = crate::hub_mcp::agent_tags::definition(root, &json!({"tag":tag}))?;
        references.push(json!({"tag":tag,"definition":d["definition"],"instruction":"这是标签的定义参考，不是为内容补标的授权，也不开放关联资料"}));
    }
    if intent.task.is_none() {
        return Ok(Some(json!({"tagReferences":references})));
    }
    let c = crate::source_evidence::open_read_database(root)?;
    options::check_model_admission_on(&c, w)?;
    if w.grant.library_ids.is_empty() {
        return Err("请选择可检索资料库后再执行标签任务；不会自动开放核心页面所在库".into());
    }
    let current = crate::hub_mcp::agent_tags::definition(root, &json!({"tag":intent.tag}))?;
    if current["definition"]["version"].as_i64().unwrap_or(0)
        != intent.expected_version.unwrap_or(0)
    {
        return Err("标签定义已变化，请查看最新定义后重新发送".into());
    }
    let old = records(root, &w.id)?
        .into_iter()
        .find(|v| v["revision"] == w.revision && v["intent"] == saved["intent"]);
    if let Some(v) = old {
        let result = model_context(root, &v)?;
        return Ok(Some(
            json!({"tagTaskResult":result,"tagReferences":references,"instruction":"结果已保存，不要重复生成或自动批准；按真实结果回答"}),
        ));
    }
    if used.body_chars.saturating_add(15_000) > budget.body_chars {
        return Err("本轮资料已达读取边界，已有内容保留；请缩小核心材料或稍后继续标签任务".into());
    }
    let mut args = json!({"task":intent.task,"tag":intent.tag,"compareTag":intent.compare_tag,"expectedVersion":intent.expected_version,"resume":intent.resume,"libraryIds":w.grant.library_ids,"instruction":store::conversation::context(root,w)?["currentRequest"]});
    if let Some(selection) = selection {
        for key in ["provider", "model", "reasoningEffort", "fast"] {
            args[key] = selection[key].clone();
        }
    }
    let mut prior_chars = 0;
    let mut prior_entities = 0;
    if intent.task.as_deref() == Some("missing") && intent.resume {
        let checkpoint = crate::hub_mcp::agent_tags::discovery_checkpoint(root, &args)?;
        prior_chars = checkpoint["charsRead"].as_u64().unwrap_or(0) as usize;
        prior_entities = checkpoint["readEntities"].as_u64().unwrap_or(0) as usize;
        let body = json!({"revision":w.revision,"authorizationVersion":w.authorization_version,"libraryIds":w.grant.library_ids,"intent":intent,"result":checkpoint,"runId":run});
        results::save(root, w, run, &body, "tagTaskCheckpoint")?;
    }
    let result = crate::hub_mcp::agent_tags::run(root, &args, &mut |p, s| {
        guard()?;
        if used.model_calls + 1 >= budget.model_calls {
            return Err("本轮调用已达上限，已保存的建议保留".into());
        }
        if used.request_bytes.saturating_add(p.len()) > budget.request_bytes {
            return Err("本轮请求已达容量，已保存建议保留".into());
        }
        used.model_calls += 1;
        used.request_bytes += p.len();
        let value = ask(p, s)?;
        guard()?;
        Ok(value)
    })?;
    guard()?;
    used.body_chars +=
        (result["charsRead"].as_u64().unwrap_or(0) as usize).saturating_sub(prior_chars);
    used.entities_read +=
        (result["readEntities"].as_u64().unwrap_or(0) as usize).saturating_sub(prior_entities);
    let mut body = json!({"revision":w.revision,"authorizationVersion":w.authorization_version,"libraryIds":w.grant.library_ids,"intent":intent,"result":result,"runId":run});
    body["resultSnapshot"] = results::save(root, w, run, &body, "tagTaskResult")?;
    let result = model_context(root, &body)?;
    Ok(Some(
        json!({"tagTaskResult":result,"tagReferences":references,"instruction":"标签任务已通过真实服务保存待审核结果。只能说明实际结论和覆盖限制，不要重复生成、不批准、不写回。"}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tag_reference_grants_no_library_and_cancelled_generation_saves_no_draft() {
        let f = crate::source_evidence::tests::Fixture::new();
        let id = store::create(
            &f.root,
            "标签讨论".into(),
            "".into(),
            None,
            Grant::default(),
        )
        .unwrap();
        let configure_task = |id: &str, task: Option<&str>| {
            configure(&f.root, &json!({"id":id,"expectedRevision":1,"intent":{"task":task,"tag":"a","compareTag":null,"expectedVersion":0,"references":["a"]}})).unwrap()
        };
        configure_task(&id, None);
        let work = store::load(&f.c(), &id).unwrap();
        let mut used = runner::Usage::default();
        let mut calls = 0;
        let mut ask = |_: &str, _: &Value| {
            calls += 1;
            Ok(json!({}))
        };
        let reference = prepare(
            &f.root,
            &work,
            "test-run",
            &Control::default(),
            Budget::mode("deep").unwrap(),
            None,
            &mut used,
            &mut ask,
        )
        .unwrap()
        .unwrap();
        assert_eq!(reference["tagReferences"].as_array().unwrap().len(), 1);
        configure_task(&id, Some("definition"));
        assert!(prepare(
            &f.root,
            &work,
            "test-run",
            &Control::default(),
            Budget::mode("deep").unwrap(),
            None,
            &mut used,
            &mut ask
        )
        .unwrap_err()
        .contains("可检索资料库"));
        assert_eq!(calls, 0);
        assert_eq!(used.model_calls, 0);
        let id = store::create(
            &f.root,
            "起草定义".into(),
            "".into(),
            None,
            Grant {
                library_ids: vec!["notes".into()],
                ..Default::default()
            },
        )
        .unwrap();
        configure_task(&id, Some("definition"));
        let work = store::load(&f.c(), &id).unwrap();
        let control = Control::default();
        let result = prepare(
            &f.root,
            &work,
            "test-run",
            &control,
            Budget::mode("deep").unwrap(),
            None,
            &mut used,
            &mut |_, _| {
                control.cancel();
                Ok(json!({"description":"取消后不保存","include":"测试","exclude":""}))
            },
        );
        assert!(result.is_err());
        assert_eq!(used.model_calls, 1);
        assert!(store::records(&f.root, &id, "tagTaskResult", 10)
            .unwrap()
            .is_empty());
        assert!(
            crate::hub_mcp::agent_tags::definition(&f.root, &json!({"tag":"a"})).unwrap()["draft"]
                .is_null()
        );
    }
}
