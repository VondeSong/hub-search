//! Cheap invalidation hints, never citations or proof that a source is current.
//! Point queries deliberately exclude markdown, post_json, task bodies and blobs.
use super::*;

impl EvidenceReader {
    pub(crate) fn change_hints(&self, locators: &[EvidenceLocator]) -> Result<Value, String> {
        self.in_snapshot(|c, _| self.change_hints_in_transaction(c, locators))
    }
    pub(crate) fn change_hints_in_transaction(
        &self,
        c: &Connection,
        locators: &[EvidenceLocator],
    ) -> Result<Value, String> {
        if locators.is_empty() || locators.len() > 64 {
            return Err("自动复查只支持 1–64 个已知依赖".into());
        }
        let visible = self.visible(c)?;
        let mut hints = Vec::new();
        for locator in locators {
            self.checkpoint()?;
            if local_text::is_local(locator) {
                if !self.scope.notes.contains(locator){return Err("文本附件未获明确授权".into());}
                let version=local_text::snapshot(&self.root,locator).ok().map(|s|s.version);
                hints.push(json!({"locator":locator,"available":version.is_some(),"fingerprint":fingerprint(&json!(version))}));
                continue;
            }
            let value = match locator {
                EvidenceLocator::Note {
                    library_id,
                    document_id,
                    ..
                } => {
                    if !self.scope.permits_note(locator) {
                        return Err("复查依赖超出笔记授权".into());
                    }
                    if !visible.contains(library_id) {
                        None
                    } else {
                        c.query_row("SELECT content_hash,blob_hash,title,path FROM documents WHERE space_id=?1 AND id=?2",params![library_id,document_id],|r|Ok(json!([r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?]))).optional().map_err(|e|e.to_string())?
                    }
                }
                EvidenceLocator::Reading { item_key } => {
                    if !self.scope.reading_item_keys.contains(item_key) {
                        return Err("复查依赖超出阅读授权".into());
                    }
                    c.query_row("SELECT i.content_hash,i.read_version,i.read_at,i.collected_at,COALESCE(l.state,'active'),COALESCE(l.revision,0),p.status,p.tags FROM collection_x_items i LEFT JOIN collection_lifecycle l ON l.item_key=i.item_key LEFT JOIN collection_x_properties p ON p.item_key=i.item_key WHERE i.item_key=?1",[item_key],|r| {
                        let state:String=r.get(4)?;
                        Ok((json!([r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,i64>(2)?,r.get::<_,i64>(3)?,state,r.get::<_,i64>(5)?,r.get::<_,Option<String>>(6)?,r.get::<_,Option<String>>(7)?]),state))
                    }).optional().map_err(|e|e.to_string())?.filter(|(_,s)| matches!(s.as_str(),"active"|"archived")).map(|(v,_)|v)
                }
                EvidenceLocator::Task {
                    library_id,
                    source_id,
                } => {
                    if !self.scope.permits_source(locator) {
                        return Err("复查依赖超出任务授权".into());
                    }
                    if visible.contains(library_id) {
                        self.task_hint(c, library_id, source_id)?
                    } else {
                        None
                    }
                }
                EvidenceLocator::Attachment { library_id, .. } => {
                    if !self.scope.permits_source(locator) {
                        return Err("复查依赖超出附件授权".into());
                    }
                    if visible.contains(library_id) {
                        self.attachment_hint(c, locator)?
                    } else {
                        None
                    }
                }
            };
            let mut hint = json!({"locator":locator,"available":value.is_some(),"fingerprint":fingerprint(&json!(value))});
            if matches!(locator, EvidenceLocator::Attachment { .. }) {
                hint["ready"] = json!(value
                    .as_ref()
                    .and_then(|v| v["ready"].as_bool())
                    .unwrap_or(false));
            }
            if matches!(locator, EvidenceLocator::Task { .. }) {
                hint["bindingIdentity"] = value
                    .as_ref()
                    .map(|v| v["bindingIdentity"].clone())
                    .unwrap_or(Value::Null);
                hint["lineIdentity"] = value
                    .as_ref()
                    .map(|v| v["lineIdentity"].clone())
                    .unwrap_or(Value::Null);
            }
            hints.push(hint);
        }
        Ok(json!(hints))
    }
}
