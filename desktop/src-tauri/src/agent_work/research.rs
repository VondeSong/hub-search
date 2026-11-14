//! Reusable research settings never grant access until the user applies them.
use super::*;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Topic {
    id: String,
    title: String,
    revision: i64,
    #[serde(default)]
    pinned: bool,
    grant: Grant,
    policy: options::ResearchPolicy,
    skills: Vec<String>,
    #[serde(default)]
    versions: Vec<CoreVersion>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CoreVersion {
    locator: EvidenceLocator,
    version: crate::source_evidence::EvidenceVersion,
    title: String,
}
pub(super) fn migrate(c: &Connection) -> rusqlite::Result<()> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS agent_research_topics(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,body_json TEXT NOT NULL,updated_at INTEGER NOT NULL);")
}
fn validate(topic: &Topic) -> Result<(), String> {
    if topic.id.is_empty()
        || topic.id.len() > 100
        || topic.title.trim().is_empty()
        || topic.title.chars().count() > 100
        || topic.skills.len() > 16
        || topic.versions.len() > 128
        || topic.skills.iter().any(|s| {
            s.is_empty()
                || s.len() > 100
                || !s
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        })
    {
        return Err("专题名称、标识或技能无效".into());
    }
    if topic.grant.manifest.is_some()
        || !topic.grant.images.is_empty()
        || !topic.grant.attachment_library_ids.is_empty()
    {
        return Err("专题只保存核心页面、可检索库和技能；图片与固定清单不自动复用".into());
    }
    topic.grant.scope()?;
    Ok(())
}
fn review(root: &Path, grant: &Grant) -> Result<Value, String> {
    let c = crate::source_evidence::open_read_database(root)?;
    let mut valid = Grant::default();
    let mut unavailable = Vec::new();
    let mut versions = Vec::new();
    for id in &grant.library_ids {
        let enabled: bool = c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM libraries WHERE id=?1 AND enabled=1)",
                [id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if enabled {
            valid.library_ids.push(id.clone());
        } else {
            unavailable.push(json!({"libraryId":id,"reason":"资料库已停用或移除"}));
        }
    }
    for note in
        grant
            .notes
            .iter()
            .chain(&grant.sources)
            .cloned()
            .chain(
                grant
                    .reading_item_keys
                    .iter()
                    .map(|item_key| EvidenceLocator::Reading {
                        item_key: item_key.clone(),
                    }),
            )
    {
        let mut one = Grant::default();
        match &note {
            EvidenceLocator::Note { .. } => one.notes.push(note.clone()),
            EvidenceLocator::Reading { item_key } => one.reading_item_keys.push(item_key.clone()),
            _ => one.sources.push(note.clone()),
        }
        match one.reader(root).and_then(|r| r.read(&note, 0, 1, None)) {
            Ok(excerpt) => {
                versions.push(CoreVersion {
                    locator: note.clone(),
                    version: excerpt.version,
                    title: excerpt.title,
                });
                match note {
                    EvidenceLocator::Note { .. } => valid.notes.push(note),
                    EvidenceLocator::Reading { item_key } => valid.reading_item_keys.push(item_key),
                    _ => valid.sources.push(note),
                }
            }
            Err(reason) => unavailable.push(json!({"locator":note,"reason":reason})),
        }
    }
    Ok(json!({"grant":valid,"unavailable":unavailable,"versions":versions}))
}
pub(super) fn check_public_read(args: &Value) -> Result<(), String> {
    let policy: Option<options::ResearchPolicy> =
        serde_json::from_value(args.get("researchPolicy").cloned().unwrap_or(Value::Null))
            .map_err(|_| "资料策略无效")?;
    if policy == Some(options::ResearchPolicy::MaterialsOnly) {
        return Err("仅依据材料时不读取公共链接；请先明确调整资料策略".into());
    }
    Ok(())
}
pub(super) fn ui(root: &Path, args: &Value) -> Result<Value, String> {
    match args["action"].as_str().unwrap_or_default() {
        "relatedTagMaterials" => {
            let grant: Grant =
                serde_json::from_value(args["grant"].clone()).map_err(|_| "资料范围无效")?;
            grant.reader(root)?.catalog()?;
            crate::hub_mcp::agent_tags::materials(
                root,
                args,
                &grant.library_ids,
                &json!(grant.notes),
            )
        }
        "researchTopics" => {
            let c = crate::source_evidence::open_read_database(root)?;
            let mut q=c.prepare("SELECT body_json FROM agent_research_topics ORDER BY updated_at DESC LIMIT 200").map_err(|e|e.to_string())?;
            let rows = q
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            let topics = rows
                .into_iter()
                .map(|s| {
                    serde_json::from_str::<Topic>(&s)
                        .map(|t| json!(t))
                        .map_err(|_| "专题记录损坏".to_string())
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(json!({"topics":topics}))
        }
        "saveResearchTopic" => {
            let mut topic: Topic =
                serde_json::from_value(args["topic"].clone()).map_err(|_| "专题配置无效")?;
            validate(&topic)?;
            if topic.versions.is_empty() {
                topic.versions =
                    serde_json::from_value(review(root, &topic.grant)?["versions"].clone())
                        .map_err(|_| "核心材料版本无法保存")?;
            }
            store::write(root, |c| {
                let old: Option<i64> = c
                    .query_row(
                        "SELECT revision FROM agent_research_topics WHERE id=?1",
                        [&topic.id],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(|e| e.to_string())?;
                if topic.revision != old.unwrap_or(0) {
                    return Err("专题已更新，请重新打开后保存".into());
                }
                topic.revision += 1;
                c.execute("INSERT INTO agent_research_topics(id,revision,body_json,updated_at) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,body_json=excluded.body_json,updated_at=excluded.updated_at",params![topic.id,topic.revision,topic_as_text(&topic)?,store::stamp()]).map_err(|e|e.to_string())?;
                Ok(json!(topic))
            })
        }
        "checkResearchTopic" => {
            let topic: Topic =
                serde_json::from_value(args["topic"].clone()).map_err(|_| "专题配置无效")?;
            validate(&topic)?;
            let mut result = review(root, &topic.grant)?;
            let current: Vec<CoreVersion> = serde_json::from_value(result["versions"].clone())
                .map_err(|_| "核心材料版本无法核对")?;
            result["changed"]=json!(current.iter().filter(|v|topic.versions.iter().any(|old|old.locator==v.locator && old.version!=v.version)).map(|v|json!({"locator":v.locator,"reason":format!("{}已更新，本次将读取当前版本",v.title)})).collect::<Vec<_>>());
            Ok(result)
        }
        "replaceResearchScope" => {
            let id = text(args, "id", 150)?;
            let grant: Grant =
                serde_json::from_value(args["grant"].clone()).map_err(|_| "资料范围无效")?;
            grant.scope()?;
            let checked = review(root, &grant)?;
            if checked["unavailable"]
                .as_array()
                .is_none_or(|v| !v.is_empty())
            {
                return Err("资料已变化或不可用，请重新核对选择；原范围保留".into());
            }
            let map = active().lock().map_err(|_| "运行状态不可用")?;
            if map.contains_key(&(root_key(root), id.clone())) {
                return Err("请等待本轮结束再切换资料范围".into());
            }
            store::write(root, |c| {
                let w = store::load(c, &id)?;
                if w.state == "revoked"
                    || w.active_run.is_some()
                    || store::lifecycle::held(&w.state)
                    || args["expectedRevision"] != w.revision
                    || args["expectedAuthorizationVersion"] != w.authorization_version
                {
                    return Err("对话或授权已变化，请刷新后重新应用".into());
                }
                let bound: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM agent_records WHERE work_id=?1 AND kind='topicBinding')", [&id], |r| r.get(0)).map_err(|e| e.to_string())?;
                if w.grant.manifest.is_some() || bound {
                    return Err("固定方法或清单专题请使用原专题入口，不替换其范围".into());
                }
                let pending:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_actions WHERE work_id=?1 AND state IN ('preparing','executing','saved','needs_review','unknown'))",[&id],|r|r.get(0)).map_err(|e|e.to_string())?;
                if pending {
                    return Err("请先核对正在保存的成果再切换范围".into());
                }
                let mut next = grant.clone();
                if next.images.len() > 2 {
                    return Err("最多选择两张图片".into());
                }
                images::verify(root, c, &next.images)?;
                next.attachment_library_ids = next.library_ids.clone();
                if json!(next) == json!(w.grant) {
                    return Ok(());
                }
                let body = json!({"text":"已明确更新下一轮资料范围，历史与累计用量保留。","author":"user","scopeOnly":true,"revision":w.revision+1,"clientMessageId":format!("scope-{}",crate::random_url_safe(18)),"scopeBefore":w.grant,"scopeAfter":next,"authorizationVersion":w.authorization_version});
                store::insert(c, &id, None, "userMessage", &body)?;
                c.execute("UPDATE agent_works SET anchor_json='null',grant_json=?2,revision=revision+1,authorization_version=authorization_version+1,report_json=NULL,state='ready',updated_at=?3 WHERE id=?1",params![id,topic_as_text(&next)?,store::stamp()]).map_err(|e|e.to_string())?;
                watch::pause_on(c, &id, "资料范围已更新，自动复查暂停")?;
                Ok(())
            })?;
            drop(map);
            status(root, &id)
        }
        _ => Err("未知资料操作".into()),
    }
}
fn topic_as_text(v: &impl Serialize) -> Result<String, String> {
    serde_json::to_string(v).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source_evidence::tests::Fixture;
    #[test]
    fn topic_versions_and_missing_sources_never_silently_expand_access() {
        let f = Fixture::new();
        let topic = json!({"id":"topic-test","revision":0,"title":"研究","grant":Grant::default(),"policy":"materials-only","skills":[]});
        let saved = ui(
            &f.root,
            &json!({"action":"saveResearchTopic","topic":topic}),
        )
        .unwrap();
        assert_eq!(saved["revision"], 1);
        assert!(ui(
            &f.root,
            &json!({"action":"saveResearchTopic","topic":topic})
        )
        .is_err());
        let checked = review(
            &f.root,
            &Grant {
                library_ids: vec!["missing".into()],
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(checked["grant"]["libraryIds"], json!([]));
        assert_eq!(checked["unavailable"].as_array().unwrap().len(), 1);
        assert!(check_public_read(&json!({"researchPolicy":"materials-only"})).is_err());
        assert!(check_public_read(&json!({"researchPolicy":"open"})).is_ok());
    }
    #[test]
    fn core_changes_remain_visible_when_a_topic_is_pinned() {
        let f = Fixture::new();
        f.note("notes", "core", "原版本");
        let topic = json!({"id":"versioned","revision":0,"title":"专题","grant":{"libraryIds":[],"notes":[{"kind":"note","libraryId":"notes","documentId":"core","pageId":null}],"readingItemKeys":[]},"policy":"material-first","skills":[]});
        let mut saved = ui(
            &f.root,
            &json!({"action":"saveResearchTopic","topic":topic}),
        )
        .unwrap();
        assert_eq!(saved["versions"].as_array().unwrap().len(), 1);
        f.note("notes", "core", "更新后的版本");
        saved["pinned"] = json!(true);
        let pinned = ui(
            &f.root,
            &json!({"action":"saveResearchTopic","topic":saved}),
        )
        .unwrap();
        let checked = ui(
            &f.root,
            &json!({"action":"checkResearchTopic","topic":pinned}),
        )
        .unwrap();
        assert_eq!(checked["changed"].as_array().unwrap().len(), 1);
        assert!(checked["unavailable"].as_array().unwrap().is_empty());
        assert_ne!(pinned["versions"], checked["versions"]);
    }
    #[test]
    fn applying_and_cancelling_scope_keeps_the_work_and_saved_budget_records() {
        let f = Fixture::new();
        f.note("notes", "manual", "手选资料");
        f.note("private", "topic", "专题资料");
        let note = |library: &str, id: &str| EvidenceLocator::Note {
            library_id: library.into(),
            document_id: id.into(),
            page_id: None,
        };
        let manual = Grant {
            notes: vec![note("notes", "manual")],
            ..Default::default()
        };
        let id =
            store::create(&f.root, "同一问题".into(), "".into(), None, manual.clone()).unwrap();
        store::write(&f.root, |c| {
            store::insert(c, &id, None, "budgetAuditSentinel", &json!({"used":123}))
        })
        .unwrap();
        let topic = Grant {
            notes: vec![note("private", "topic")],
            ..Default::default()
        };
        let first=ui(&f.root,&json!({"action":"replaceResearchScope","id":id,"grant":topic,"expectedRevision":1,"expectedAuthorizationVersion":1})).unwrap();
        assert_eq!(first["work"]["id"], id);
        assert_eq!(first["work"]["grant"]["notes"], json!(topic.notes));
        let first_work = store::load(&f.c(), &id).unwrap();
        assert_eq!(
            store::conversation::context(&f.root, &first_work).unwrap()["currentRequest"],
            "同一问题"
        );
        assert_eq!(first["conversation"]["messages"][1]["kind"], "scope");
        assert_eq!(
            store::goal::completion::requirements_on(&f.c(), &first_work)
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1,
            "scope receipt must not become a user obligation"
        );
        assert_eq!(
            first["conversation"]["messages"][1]["text"],
            "已明确更新下一轮资料范围，历史与累计用量保留。"
        );
        assert_eq!(
            first["conversation"]["messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|m| m["text"] == "同一问题")
                .count(),
            1
        );
        assert!(!store::load(&f.c(), &id)
            .unwrap()
            .grant
            .contains(&manual.notes[0]));
        assert!(ui(&f.root,&json!({"action":"replaceResearchScope","id":id,"grant":manual,"expectedRevision":1,"expectedAuthorizationVersion":1})).is_err());
        let restored=ui(&f.root,&json!({"action":"replaceResearchScope","id":id,"grant":manual,"expectedRevision":2,"expectedAuthorizationVersion":2})).unwrap();
        assert_eq!(restored["work"]["grant"]["notes"], json!(manual.notes));
        assert_eq!(
            store::records(&f.root, &id, "budgetAuditSentinel", 1).unwrap()[0]["used"],
            123
        );
        assert_eq!(
            store::records(&f.root, &id, "userMessage", 32)
                .unwrap()
                .len(),
            2
        );
        assert!(!store::load(&f.c(), &id)
            .unwrap()
            .grant
            .contains(&topic.notes[0]));
        // Existing host scope confirmations predate the explicit marker.
        f.c().execute("UPDATE agent_records SET body_json=json_remove(body_json,'$.scopeOnly') WHERE work_id=?1 AND kind='userMessage'", [&id]).unwrap();
        let restored_work = store::load(&f.c(), &id).unwrap();
        assert_eq!(
            store::goal::completion::requirements_on(&f.c(), &restored_work)
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            store::conversation::context(&f.root, &restored_work).unwrap()["currentRequest"],
            "同一问题"
        );
        let requested=super::super::ui(&f.root,&json!({"action":"message","id":id,"text":"只核对版本与范围","clientMessageId":"real-scope-question"})).unwrap();
        let changed=ui(&f.root,&json!({"action":"replaceResearchScope","id":id,"grant":topic,"expectedRevision":requested["work"]["revision"],"expectedAuthorizationVersion":requested["work"]["authorizationVersion"]})).unwrap();
        let changed_work = store::load(&f.c(), &id).unwrap();
        assert_eq!(
            store::goal::completion::requirements_on(&f.c(), &changed_work)
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            store::conversation::context(&f.root, &changed_work).unwrap()["currentRequest"],
            "只核对版本与范围"
        );
        assert_eq!(changed["work"]["id"], id);
        store::write(&f.root, |c| {
            store::insert(
                c,
                &id,
                None,
                "topicBinding",
                &json!({"topicId":"fixed-method"}),
            )
        })
        .unwrap();
        assert!(ui(&f.root, &json!({"action":"replaceResearchScope","id":id,"grant":topic,"expectedRevision":changed["work"]["revision"],"expectedAuthorizationVersion":changed["work"]["authorizationVersion"]})).unwrap_err().contains("原专题入口"));
        assert_eq!(
            json!(store::load(&f.c(), &id).unwrap().revision),
            changed["work"]["revision"]
        );
    }
    #[test]
    fn related_tag_search_intersects_explicit_pages_and_supports_any_or_all() {
        let f = Fixture::new();
        for id in ["one", "two"] {
            f.note("notes", id, "正文不自动返回");
        }
        f.note("private", "secret", "PRIVATE_SENTINEL");
        f.c().execute_batch("INSERT INTO obsidian_tags(space_id,document_id,tag,normalized_tag) VALUES('notes','one','a','a'),('notes','one','b','b'),('notes','two','a','a'),('private','secret','a','a'),('private','secret','b','b');").unwrap();
        let grant = Grant {
            library_ids: vec!["notes".into()],
            ..Default::default()
        };
        let any = ui(
            &f.root,
            &json!({"action":"relatedTagMaterials","tags":["a","b"],"grant":grant}),
        )
        .unwrap();
        assert_eq!(any["materials"].as_array().unwrap().len(), 2);
        assert!(!any.to_string().contains("secret"));
        let all = ui(
            &f.root,
            &json!({"action":"relatedTagMaterials","tags":["a","b"],"matchAll":true,"grant":grant}),
        )
        .unwrap();
        assert_eq!(all["materials"].as_array().unwrap().len(), 1);
        let grant = Grant {
            notes: vec![EvidenceLocator::Note {
                library_id: "notes".into(),
                document_id: "two".into(),
                page_id: None,
            }],
            ..Default::default()
        };
        let exact = ui(
            &f.root,
            &json!({"action":"relatedTagMaterials","tags":["a"],"grant":grant}),
        )
        .unwrap();
        assert_eq!(exact["materials"].as_array().unwrap().len(), 1);
        assert_eq!(exact["materials"][0]["locator"]["documentId"], "two");
    }
}
