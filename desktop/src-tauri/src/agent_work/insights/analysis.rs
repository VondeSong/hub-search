//! Semantic judgement stays in the existing agent, under the same explicit grant.
use super::*;
pub(super) fn scope(root: &Path, work: &Work) -> Result<Vec<Value>, String> {
    if !work.grant.library_ids.is_empty() || !work.grant.attachment_library_ids.is_empty() {
        return Err("本轮关联需要明确选择的资料，不能使用整库授权".into());
    }
    work.grant.verify_manifest(root)?;
    let mut locators = work.grant.notes.clone();
    locators.extend(work.grant.sources.clone());
    locators.extend(
        work.grant
            .reading_item_keys
            .iter()
            .map(|key| EvidenceLocator::Reading {
                item_key: key.clone(),
            }),
    );
    if let Some(manifest) = &work.grant.manifest {
        locators.extend(manifest.members.clone());
    }
    let mut unique = vec![];
    for locator in locators {
        if !unique.contains(&locator) {
            unique.push(locator);
        }
    }
    if unique.is_empty() || unique.len() > 32 {
        return Err("请选择1–32份明确资料再核对，未扩大范围".into());
    }
    let reader = current_reader(root, work)?;
    unique.iter().map(|locator|{
        let e=reader.read(locator,0,1,None)?;
        Ok(json!({"locator":locator,"version":e.version,"title":e.title,"sourcePath":e.source_path}))
    }).collect()
}
pub(super) fn ui(root: &Path, args: &Value) -> Result<Value, String> {
    let id = text(args, "id", 150)?;
    store::write(root, |c| {
        let work = work_on(c, &id)?;
        let sources = scope(root, &work)?;
        if args["action"] == "insightAnalysisScope" {
            return Ok(
                json!({"workId":id,"workRevision":work.revision,"sources":sources,"remoteFreshness":"notVerified"}),
            );
        }
        let mode = text(args, "mode", 20)?;
        let question = text(args, "question", 1200)?;
        if !["semantic", "status"].contains(&mode.as_str()) {
            return Err("核对方式无效".into());
        }
        let rule = if mode == "status" {
            let locator: EvidenceLocator = serde_json::from_value(args["task"].clone())
                .map_err(|_| "请选择明确授权的任务对象")?;
            if !matches!(locator, EvidenceLocator::Task { .. })
                || !sources.iter().any(|v| v["locator"] == args["task"])
            {
                return Err("任务不在本次明确选择范围内".into());
            }
            if !sources.iter().any(|v| v["locator"]["kind"] == "note") {
                return Err("需要同时选择明确的说明笔记，不用任务标题猜完成事实".into());
            }
            format!("只核对这个明确任务 {} 与所选笔记之间的完成状态差异。先读真实任务当前状态及版本，再核对笔记中的具体产出和事件日期；计划、原型/纸面验证、实机完成分开。没有历史就不能判断多次改期，未勾选不代表未完成，缺失不能补事实。存在差异只提出有两侧引用的待确认发现，不自动完成任务或修改来源。",args["task"])
        } else {
            "按含义和用途核对已选材料与问题的关系，不以字面词命中决定相关性。逐份读取本次明确材料，近义改写也可以形成候选；同词但对象、场景或条件不同的资料要排除。说明可复用之处、适用条件和关键反例；没有答案可以没有发现。未读完要说明实际覆盖，不能宣称完整召回。".into()
        };
        let instruction=format!("本轮问题：{question}\n{rule}\n本次明确选择{}份资料，身份以原事项当前正式授权目录为准，未增加任何来源。请通过正式取证工具读取正文，不把标题当作证据；只用原事项的累计预算。\n有依据的判断使用本轮真实原文引用交付；需要保存时提供结构化 findings。沿原事项接续，不另建代理，不写外部系统、不启动后台监测。",sources.len());
        if instruction.chars().count() > 4000 {
            return Err("所选资料身份清单较长，请收窄后准备核对，未截断来源".into());
        }
        store::conversation::message_on(
            root,
            c,
            &id,
            &json!({"text":instruction,"clientMessageId":text(args,"operationId",100)?,"expectedRevision":args["expectedRevision"]}),
        )?;
        let current = work_on(c, &id)?;
        Ok(
            json!({"workId":id,"workRevision":current.revision,"sources":sources,"prepared":true,"modelStarted":false}),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source_evidence::tests::Fixture;
    #[test]
    fn preparation_preserves_grant_and_does_not_start_model() {
        let f = Fixture::new();
        f.note("notes", "progress", "纸面验证通过，但尚未实机检查。");
        let grant = Grant {
            notes: vec![EvidenceLocator::Note {
                library_id: "notes".into(),
                document_id: "progress".into(),
                page_id: None,
            }],
            ..Default::default()
        };
        let id = store::write(&f.root, |c| {
            store::create_on(c, "核对".into(), "有引用".into(), None, grant.clone())
        })
        .unwrap();
        assert_eq!(
            ui(&f.root, &json!({"action":"insightAnalysisScope","id":id})).unwrap()["sources"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let work = work_on(&f.c(), &id).unwrap();
        let request = json!({"action":"insightAnalysisPrepare","id":id,"expectedRevision":work.revision,"operationId":"semantic-1","mode":"semantic","question":"这次验证到哪一层了？"});
        let result = ui(&f.root, &request).unwrap();
        assert_eq!(result["modelStarted"], false);
        ui(&f.root, &request).unwrap();
        assert_eq!(
            serde_json::to_value(work_on(&f.c(), &id).unwrap().grant).unwrap(),
            serde_json::to_value(grant).unwrap()
        );
        let c = f.c();
        let count: i64 = c
            .query_row("SELECT COUNT(*) FROM agent_runs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
    #[test]
    fn status_comparison_requires_explicit_task_and_note() {
        let f = Fixture::new();
        f.note("notes", "progress", "已完成纸面验证，实机尚待核对");
        let grant = Grant {
            notes: vec![EvidenceLocator::Note {
                library_id: "notes".into(),
                document_id: "progress".into(),
                page_id: None,
            }],
            ..Default::default()
        };
        let id = store::write(&f.root, |c| {
            store::create_on(c, "核对".into(), "有引用".into(), None, grant)
        })
        .unwrap();
        let w = work_on(&f.c(), &id).unwrap();
        assert!(ui(&f.root,&json!({"action":"insightAnalysisPrepare","id":id,"expectedRevision":w.revision,"operationId":"status-1","mode":"status","question":"完成了吗","task":{"kind":"task","libraryId":"craft","sourceId":"unselected"}})).is_err());
        assert_eq!(work_on(&f.c(), &id).unwrap().revision, w.revision);
    }
}

#[cfg(all(test, windows))]
mod live;
