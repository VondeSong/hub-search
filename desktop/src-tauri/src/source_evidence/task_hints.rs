//! Task polling projects metadata only; body reads stay in the shared producer.
use super::*;
impl EvidenceReader {
    pub(super) fn task_hint(
        &self,
        c: &Connection,
        library: &str,
        source: &str,
    ) -> Result<Option<Value>, String> {
        let locator = EvidenceLocator::Task {
            library_id: library.into(),
            source_id: source.into(),
        };
        if !self.scope.permits_source(&locator) {
            return Err("任务不在本次授权范围".into());
        }
        let mut document = None;
        let value = if let Some((doc, _line)) = source.rsplit_once(":line:") {
            document = Some(doc.to_string());
            c.query_row("SELECT content_hash,blob_hash,title,path,provider FROM documents WHERE space_id=?1 AND id=?2",params![library,doc],|r|Ok(json!({"documentHash":r.get::<_,String>(0)?,"blob":r.get::<_,Option<String>>(1)?,"title":r.get::<_,String>(2)?,"path":r.get::<_,String>(3)?,"provider":r.get::<_,String>(4)?}))).optional().map_err(|e|e.to_string())?
        } else if let Some(page) = source.strip_prefix(CRAFT_PROJECT_SOURCE_PREFIX) {
            let row:Option<(String,String,String,String)>=c.query_row("SELECT d.id,d.content_hash,d.path,CASE WHEN d.id=?2 THEN d.title ELSE ci.page_title END FROM documents d LEFT JOIN content_items ci ON ci.space_id=d.space_id AND ci.document_id=d.id AND ci.page_id=?2 WHERE d.space_id=?1 AND (d.id=?2 OR ci.page_id=?2) LIMIT 1",params![library,page],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(|e|e.to_string())?;
            if let Some((doc, hash, path, title)) =
                row.filter(|r| craft_project_title(&r.3).is_some())
            {
                let counts:(i64,i64)=c.query_row("SELECT COUNT(*),COALESCE(SUM(completed<>0),0) FROM craft_task_blocks WHERE space_id=?1 AND document_id=?2 AND (parent_page_id=?3 OR (parent_page_id='' AND ?2=?3))",params![library,doc,page],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|e|e.to_string())?;
                document = Some(doc);
                Some(json!({"hash":hash,"path":path,"title":title,"children":counts}))
            } else {
                None
            }
        } else {
            let native:Option<(String,Value)>=c.query_row("SELECT b.document_id,b.title,b.completed,b.schedule_date,b.deadline_date,b.parent_task_id,b.parent_page_id,b.source_hash,b.evidence_revision,d.content_hash,d.title,d.path,b.created_at FROM craft_task_blocks b JOIN documents d ON d.space_id=b.space_id AND d.id=b.document_id WHERE b.space_id=?1 AND b.block_id=?2",params![library,source],|r|Ok((r.get(0)?,json!([r.get::<_,String>(1)?,r.get::<_,bool>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,String>(5)?,r.get::<_,String>(6)?,r.get::<_,String>(7)?,r.get::<_,i64>(8)?,r.get::<_,String>(9)?,r.get::<_,String>(10)?,r.get::<_,String>(11)?,r.get::<_,Option<String>>(12)?])))).optional().map_err(|e|e.to_string())?;
            if let Some((doc, value)) = native {
                document = Some(doc);
                Some(value)
            } else {
                c.query_row("SELECT t.title,t.status,t.start_at,t.due_at,t.completed_at,t.time_zone,t.project_id,t.evidence_revision,d.content_hash,d.path,p.name FROM dida_tasks t LEFT JOIN documents d ON d.space_id=t.library_id AND d.id=t.task_id LEFT JOIN dida_projects p ON p.library_id=t.library_id AND p.project_id=t.project_id WHERE t.library_id=?1 AND t.task_id=?2",params![library,source],|r|Ok(json!([r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,Option<String>>(3)?,r.get::<_,Option<String>>(4)?,r.get::<_,Option<String>>(5)?,r.get::<_,String>(6)?,r.get::<_,i64>(7)?,r.get::<_,Option<String>>(8)?,r.get::<_,Option<String>>(9)?,r.get::<_,Option<String>>(10)?]))).optional().map_err(|e|e.to_string())?
            }
        };
        if let Some(doc) = &document {
            let trashed:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM task_sync_craft_trash_documents WHERE library_id=?1 AND document_id=?2)",params![library,doc],|r|r.get(0)).map_err(|e|e.to_string())?;
            if trashed {
                return Ok(None);
            }
        }
        let Some(value) = value else { return Ok(None) };
        let links = self.task_links(c, library, source)?;
        let hub:Option<String>=c.query_row("SELECT hub_task_id FROM unified_task_bindings WHERE library_id=?1 AND source_id=?2",params![library,source],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        let conflicts:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM task_sync_events WHERE hub_task_id=?1 AND status='review' AND action='conflict')",[hub.as_deref().unwrap_or("")],|r|r.get(0)).map_err(|e|e.to_string())?;
        let excluded:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM task_sync_exclusions WHERE provider='craft' AND library_id=?1 AND source_id=?2)",params![library,normalized_task_sync_source_id(source)],|r|r.get(0)).map_err(|e|e.to_string())?;
        Ok(Some(
            json!({"facts":value,"bindingIdentity":hub.as_ref().map(|_|fingerprint(&json!([hub,links]))),"conflict":conflicts,"paused":excluded,"lineIdentity":if source.contains(":line:"){json!(fingerprint(&value))}else{Value::Null}}),
        ))
    }
    fn task_links(
        &self,
        c: &Connection,
        library: &str,
        source: &str,
    ) -> Result<Vec<EvidenceLocator>, String> {
        let mut q=c.prepare("SELECT library_id,source_id FROM unified_task_bindings WHERE hub_task_id IN (SELECT hub_task_id FROM unified_task_bindings WHERE library_id=?1 AND source_id=?2) ORDER BY library_id,source_id LIMIT 65").map_err(|e|e.to_string())?;
        let rows = q
            .query_map(params![library, source], |r| {
                Ok(EvidenceLocator::Task {
                    library_id: r.get(0)?,
                    source_id: r.get(1)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        if rows.len() > 64 {
            return Err("任务对应来源超过复查预算".into());
        }
        let visible = self.visible(c)?;
        let mut result = Vec::new();
        for locator in rows {
            let EvidenceLocator::Task {
                library_id,
                source_id,
            } = &locator
            else {
                continue;
            };
            if !self.scope.permits_source(&locator) || !visible.contains(library_id) {
                continue;
            }
            let present:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM dida_tasks WHERE library_id=?1 AND task_id=?2) OR EXISTS(SELECT 1 FROM craft_task_blocks b WHERE b.space_id=?1 AND b.block_id=?2 AND NOT EXISTS(SELECT 1 FROM task_sync_craft_trash_documents t WHERE t.library_id=b.space_id AND t.document_id=b.document_id)) OR EXISTS(SELECT 1 FROM documents d WHERE d.space_id=?1 AND (instr(?2,d.id||':line:')=1 OR ?2='craft-project-page:'||d.id)) OR EXISTS(SELECT 1 FROM content_items ci WHERE ci.space_id=?1 AND ?2='craft-project-page:'||ci.page_id)",params![library_id,source_id],|r|r.get(0)).map_err(|e|e.to_string())?;
            if present {
                result.push(locator);
            }
        }
        Ok(result)
    }
    pub(crate) fn expand_task_dependencies(
        &self,
        c: &Connection,
        locators: Vec<EvidenceLocator>,
    ) -> Result<Vec<EvidenceLocator>, String> {
        let mut result = locators.clone();
        for locator in locators {
            if let EvidenceLocator::Task {
                library_id,
                source_id,
            } = locator
            {
                for peer in self.task_links(c, &library_id, &source_id)? {
                    if !result.contains(&peer) {
                        result.push(peer);
                    }
                }
            }
            if result.len() > 64 {
                return Err("已知任务对应来源超过 64 个依赖预算".into());
            }
        }
        Ok(result)
    }
}
