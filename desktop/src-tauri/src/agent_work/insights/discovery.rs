//! A direct entry into the existing Work runner, with replayable preparation.
use super::*;

fn read_on(root: &Path, c: &Connection, id: &str) -> Result<Value, String> {
    let work = work_on(c, id)?;
    let (row, raw): (i64, String) = c.query_row("SELECT rowid,body_json FROM agent_records WHERE work_id=?1 AND kind='insightDiscovery' ORDER BY rowid DESC LIMIT 1",[id],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|_|"这项分析不是从洞察开始的")?;
    let config: Value = serde_json::from_str(&raw).map_err(|_| "发现记录损坏")?;
    if config["authorizationVersion"].as_i64() != Some(work.authorization_version) {
        return Err("资料范围已改变，请重新选择资料并核对；旧内容已隐藏".into());
    }
    let changed:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_records WHERE work_id=?1 AND kind='userMessage' AND rowid>?2)",params![id,row],|r|r.get(0)).map_err(|e|e.to_string())?;
    if changed {
        return Err("原分析已收到其他问题，请重新准备本次发现，避免把其他答复当作本次结果".into());
    }
    let sources = analysis::scope(root, &work)?.into_iter().map(|s|
        json!({"title":s["title"],"path":s["sourcePath"],"locator":s["locator"],"version":s["version"]})
    ).collect::<Vec<_>>();
    let delivery: Option<String> = c.query_row("SELECT id FROM agent_records WHERE work_id=?1 AND kind='delivery' AND rowid>?2 ORDER BY rowid DESC LIMIT 1",params![id,row],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    let results = delivery
        .map(|record| candidates_on(root, c, &work, &record))
        .transpose()?;
    Ok(
        json!({"workId":id,"workRevision":work.revision,"config":config,"sources":sources,"results":results}),
    )
}

pub(super) fn ui(root: &Path, args: &Value) -> Result<Value, String> {
    let permit = crate::library_runtime::cached_read_permit(root)?;
    let result = store::write(root, |c| {
        if args["action"] == "insightDiscoveryPreview" {
            let locator: EvidenceLocator =
                serde_json::from_value(args["locator"].clone()).map_err(|_| "资料身份无效")?;
            if !matches!(locator, EvidenceLocator::Note { .. }) {
                return Err("只能预览明确的本地笔记".into());
            }
            let locator = crate::source_evidence::resolve_note_page(root, c, locator)?;
            let version = args
                .get("version")
                .filter(|v| !v.is_null())
                .map(|v| serde_json::from_value(v.clone()).map_err(|_| "资料版本无效"))
                .transpose()?;
            let grant = Grant {
                notes: vec![locator.clone()],
                ..Default::default()
            };
            return serde_json::to_value(grant.reader(root)?.read(
                &locator,
                args["startChar"].as_u64().unwrap_or(0) as usize,
                3000,
                version.as_ref(),
            )?)
            .map_err(|e| e.to_string());
        }
        if args["action"] == "insightDiscoverySource" {
            let w = work_on(c, &text(args, "id", 150)?)?;
            let locator: EvidenceLocator =
                serde_json::from_value(args["locator"].clone()).map_err(|_| "资料身份无效")?;
            let version: crate::source_evidence::EvidenceVersion =
                serde_json::from_value(args["version"].clone()).map_err(|_| "资料版本无效")?;
            return serde_json::to_value(current_reader(root, &w)?.read(
                &locator,
                args["startChar"].as_u64().unwrap_or(0) as usize,
                3000,
                Some(&version),
            )?)
            .map_err(|e| e.to_string());
        }
        if args["action"] == "insightDiscoveryRead" {
            return read_on(root, c, &text(args, "id", 150)?);
        }
        let op = text(args, "operationId", 100)?;
        let hash = digest(&args.to_string());
        let previous: Option<(String,String)> = c.query_row("SELECT work_id,body_json FROM agent_records WHERE kind='insightDiscovery' AND json_extract(body_json,'$.operationId')=?1 ORDER BY rowid DESC LIMIT 1",[&op],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e|e.to_string())?;
        if let Some((id, raw)) = previous {
            let config: Value = serde_json::from_str(&raw).map_err(|_| "发现记录损坏")?;
            if config["requestHash"] != hash {
                return Err("相同操作身份对应不同请求".into());
            }
            return read_on(root, c, &id);
        }
        let question = text(args, "question", 1200)?;
        let notes: Vec<EvidenceLocator> =
            serde_json::from_value(args["notes"].clone()).map_err(|_| "请选择本地笔记")?;
        if notes.len() > 32
            || notes
                .iter()
                .any(|n| !matches!(n, EvidenceLocator::Note { .. }))
        {
            return Err("一次最多选择32份明确的本地笔记".into());
        }
        let mut work = args["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .map(|id| work_on(c, id))
            .transpose()?;
        let mut grant = work.as_ref().map(|w| w.grant.clone()).unwrap_or_default();
        if let Some(w) = &work {
            if w.active_run.is_some() || args["expectedRevision"].as_i64() != Some(w.revision) {
                return Err("分析仍在运行或资料已更新，请刷新后重试".into());
            }
            if !w.grant.library_ids.is_empty()
                || !w.grant.attachment_library_ids.is_empty()
                || w.grant.manifest.is_some()
                || !w.grant.images.is_empty()
            {
                return Err("本轮直接发现只使用明确选择的文字资料，请在原事项核对其他范围".into());
            }
        }
        for note in &notes {
            let note = crate::source_evidence::resolve_note_page(root, c, note.clone())?;
            if !grant.notes.contains(&note) {
                grant.notes.push(note);
            }
        }
        let count = grant.notes.len() + grant.sources.len() + grant.reading_item_keys.len();
        if count == 0 || count > 32 {
            return Err("请选择1–32份明确资料".into());
        }
        let reader = grant.reader(root)?;
        for note in &grant.notes {
            reader.read(note, 0, 1, None)?;
        }
        let target = if args["targetInsightId"]
            .as_str()
            .is_some_and(|id| !id.is_empty())
        {
            let target = state::discovery_target(root, c, args)?;
            if work.as_ref().is_none_or(|w| target["workId"] != w.id) {
                return Err("只能接续这条发现的原分析".into());
            }
            Some(target)
        } else {
            None
        };
        if work.is_none() {
            let anchor = grant.notes.first().cloned();
            let id = store::create_on(
                c,
                question.clone(),
                "找到有用的联系，说明适用条件、未知和精确出处；没有合格发现可以为空".into(),
                anchor,
                grant,
            )?;
            work = Some(store::load(c, &id)?);
        }
        let w = work.unwrap();
        let previous_text = target
            .as_ref()
            .map(|v| v["snapshot"]["text"].as_str().unwrap_or_default())
            .unwrap_or_default();
        if previous_text.chars().count() > 6000 {
            return Err("原判断超过本轮核对容量，请回原事项处理".into());
        }
        let instruction=format!("本次问题：{question}\n请读取本次明确选择的资料正文，寻找当前事情可以采用的旧经验，或记录之间有实际依据的变化。不能只因词相同就判相关。区分当前需求、旧经验、实际观察、计划、自述和未知。发现应说明为什么这次有关、适用条件与限制；未知的反例不要编造。没有有用联系可以不产生发现。\n{}\n请用正式取证工具读取原文，交付带精确引用的结构化 findings（可以为空），每条 finding.text 使用这些 Markdown 小标题组织：## 发现、## 为什么现在有关、## 适用条件、## 限制与未知；后续核对另写 ## 核对说明。每节写有原文支持的自然文字；未明确的条件写未明确，不推测补全。图片未读取的标记及访问地址不作为图片内容证据。不要固定发现条数。先回答实际问题，普通说明仍可保留。不要改写来源、任务状态或已保存发现，不启用后台观察。",if previous_text.is_empty(){String::new()}else{format!("以下是已保留的旧判断，仅供比较，不作为新的独立事实：\n{previous_text}\n请明确比较新旧依据，说明支持、削弱、反例或无关及理由；旧判断仍适用时明确说明维持。")});
        if instruction.chars().count() > 4000 {
            return Err("本次问题与原判断超过单轮容量，请收窄问题或回原分析核对".into());
        }
        store::conversation::message_on(
            root,
            c,
            &w.id,
            &json!({"text":instruction,"clientMessageId":op,"expectedRevision":w.revision,"addNotes":notes.iter().filter(|n|!w.grant.contains(n)).cloned().collect::<Vec<_>>()}),
        )?;
        let current = store::load(c, &w.id)?;
        let config = json!({"authorizationVersion":current.authorization_version,"operationId":op,"requestHash":hash,"question":question,"targetInsightId":args["targetInsightId"],"targetRevision":target.as_ref().map(|t|t["rowRevision"].clone()),"previousText":previous_text,"createdAt":store::stamp()});
        store::insert(c, &w.id, None, "insightDiscovery", &config)?;
        read_on(root, c, &w.id)
    })?;
    permit.checkpoint()?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source_evidence::tests::Fixture;
    #[test]
    fn preparation_replays_and_keeps_explicit_scope() {
        let f = Fixture::new();
        f.note("notes", "one", "先验证一个样本，再决定是否扩批。");
        let preview = ui(
            &f.root,
            &json!({"action":"insightDiscoveryPreview","locator":super::super::tests::note("one")}),
        )
        .unwrap();
        assert!(preview["content"]
            .as_str()
            .unwrap()
            .contains("先验证一个样本"));
        assert_eq!(
            f.c()
                .query_row::<i64, _, _>("SELECT COUNT(*) FROM agent_works", [], |r| r.get(0))
                .unwrap(),
            0
        );
        let mut request = json!({"action":"insightDiscoveryPrepare","question":"哪些旧经验适合当前工作？","notes":[super::super::tests::note("one")],"operationId":"discovery-start"});
        let first = ui(&f.root, &request).unwrap();
        assert_eq!(first, ui(&f.root, &request).unwrap());
        let w = store::load(&f.c(), first["workId"].as_str().unwrap()).unwrap();
        assert_eq!(w.grant.notes.len(), 1);
        assert!(w.active_run.is_none());
        assert!(first["results"].is_null());
        request["question"] = json!("不同问题");
        assert!(ui(&f.root, &request).is_err());
        store::write(&f.root, |c| {
            store::insert(c, &w.id, None, "userMessage", &json!({"text":"另一个问题"}))?;
            Ok(())
        })
        .unwrap();
        assert!(ui(&f.root, &json!({"action":"insightDiscoveryRead","id":w.id})).is_err());
    }
    #[test]
    fn rejects_missing_sources_and_non_note_inputs() {
        let f = Fixture::new();
        assert!(ui(&f.root,&json!({"action":"insightDiscoveryPrepare","question":"找联系","notes":[],"operationId":"empty"})).is_err());
        assert!(ui(&f.root,&json!({"action":"insightDiscoveryPrepare","question":"找联系","notes":[{"kind":"reading","itemKey":"bad"}],"operationId":"bad"})).is_err());
    }

    #[test]
    fn scope_changes_hide_configuration_and_previous_text() {
        let f = Fixture::new();
        f.note("notes", "one", "原始材料");
        let first=ui(&f.root,&json!({"action":"insightDiscoveryPrepare","question":"找联系","notes":[super::super::tests::note("one")],"operationId":"scope"})).unwrap();
        let id = first["workId"].as_str().unwrap();
        f.c()
            .execute(
                "UPDATE agent_works SET authorization_version=authorization_version+1 WHERE id=?1",
                [id],
            )
            .unwrap();
        assert!(ui(&f.root, &json!({"action":"insightDiscoveryRead","id":id})).is_err());
    }

    #[test]
    fn maintaining_preserves_text_and_tracks_new_evidence() {
        let case = super::super::tests::Case::new();
        let candidates = case.read();
        let mut request = json!({"action":"insightImport","id":case.work,"deliveryRecordId":case.record,"deliveryHash":candidates["origin"]["deliveryHash"],"findingPointer":"/report/findings/0","confirmDependencies":true,"operationId":"first"});
        let saved = super::super::ui(&case.f.root, &request).unwrap();
        let before = saved["item"]["snapshot"]["text"].clone();
        request["action"] = json!("insightUpdate");
        request["operationId"] = json!("keep");
        request["insightId"] = saved["item"]["id"].clone();
        request["expectedRevision"] = saved["item"]["rowRevision"].clone();
        request["findingPointer"] = json!("/report/findings/1");
        request["reviewOutcome"] = json!("maintain");
        let kept = super::super::ui(&case.f.root, &request).unwrap();
        assert_eq!(kept["item"]["snapshot"]["text"], before);
        assert_eq!(
            kept["item"]["snapshot"]["reviewOutcome"]["kind"],
            "maintain"
        );
        assert_eq!(
            kept["item"]["snapshot"]["contextDependencies"][0]["excerpt"]["locator"]["documentId"],
            "progress"
        );
        assert_eq!(kept["item"]["headRevision"], 2);
        assert_eq!(
            super::super::ui(&case.f.root, &request).unwrap()["item"]["headRevision"],
            2
        );
        case.f.note("notes", "progress", "新的文字");
        let detail = super::super::ui(
            &case.f.root,
            &json!({"action":"insightDetail","insightId":saved["item"]["id"]}),
        )
        .unwrap();
        assert_eq!(detail["validity"], "review");
    }
}
