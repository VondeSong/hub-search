//! Cheap invalidation hints, never citations or proof that a source is current.
//! Point queries deliberately exclude markdown, post_json, task bodies and blobs.
use super::*;

impl EvidenceReader {
    pub(crate) fn scheduled_library_inventory(
        &self,
        c: &Connection,
    ) -> Result<Vec<(EvidenceLocator, String)>, String> {
        let visible = self.visible(c)?;
        if self
            .scope
            .library_ids
            .iter()
            .any(|id| !visible.contains(id))
        {
            return Err("定时复查的资料库当前不可用，请重新核对授权".into());
        }
        let libraries =
            serde_json::to_string(&self.scope.library_ids).map_err(|e| e.to_string())?;
        let mut query = c
            .prepare(
                "SELECT space_id,id,content_hash,blob_hash,title,path FROM documents
             WHERE space_id IN (SELECT value FROM json_each(?1))
               AND provider IN ('craft','obsidian','feishu')
             ORDER BY space_id,id LIMIT 5001",
            )
            .map_err(|error| error.to_string())?;
        let mut rows = query
            .query([libraries])
            .map_err(|error| error.to_string())?;
        let mut entries = Vec::new();
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            self.checkpoint()?;
            let locator = EvidenceLocator::Note {
                library_id: row.get(0).map_err(|e| e.to_string())?,
                document_id: row.get(1).map_err(|e| e.to_string())?,
                page_id: None,
            };
            let fields = (
                row.get::<_, String>(2).map_err(|e| e.to_string())?,
                row.get::<_, Option<String>>(3).map_err(|e| e.to_string())?,
                row.get::<_, String>(4).map_err(|e| e.to_string())?,
                row.get::<_, String>(5).map_err(|e| e.to_string())?,
            );
            entries.push((locator, fingerprint(&json!(fields))));
        }
        if entries.len() > 5000 {
            return Err("定时复查最多比较 5000 篇笔记，请缩小资料库范围".into());
        }
        Ok(entries)
    }

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
                if !self.scope.notes.contains(locator) {
                    return Err("文本附件未获明确授权".into());
                }
                let version = local_text::snapshot(&self.root, locator)
                    .ok()
                    .map(|s| s.version);
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
