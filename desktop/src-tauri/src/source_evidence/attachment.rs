use super::*;

impl EvidenceReader {
    pub(super) fn attachment_hint(
        &self,
        c: &Connection,
        locator: &EvidenceLocator,
    ) -> Result<Option<Value>, String> {
        let EvidenceLocator::Attachment {
            library_id,
            document_id,
            source_item_id,
            chunk_id,
            page_number,
        } = locator
        else {
            return Err("附件定位无效".into());
        };
        if !self.scope.permits_source(locator) {
            return Err("附件不在本次授权范围".into());
        }
        let source:Option<(String,Option<String>,String,String)>=c.query_row("SELECT s.status,s.blob_hash,s.title,d.path FROM source_items s JOIN documents d ON d.space_id=s.space_id AND d.id=s.document_id WHERE s.id=?1 AND s.space_id=?2 AND s.document_id=?3 AND s.status NOT IN ('unavailable','removed','missing')",params![source_item_id,library_id,document_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(|e|e.to_string())?;
        let Some((status, blob, title, path)) = source else {
            return Ok(None);
        };
        let input = crate::attachment_evidence::input_on(c, library_id, source_item_id).ok();
        let chunk:Option<Value>=c.query_row("SELECT source_hash,input_version,heading,page_number,content_type FROM content_items WHERE id=?1 AND source_item_id=?2 AND space_id=?3 AND document_id=?4",params![chunk_id,source_item_id,library_id,document_id],|r|Ok(json!({"textHash":r.get::<_,String>(0)?,"input":r.get::<_,Option<String>>(1)?,"heading":r.get::<_,String>(2)?,"page":r.get::<_,Option<i64>>(3)?,"type":r.get::<_,String>(4)?}))).optional().map_err(|e|e.to_string())?;
        let ready = input.as_ref().is_some_and(|i| {
            chunk.as_ref().is_some_and(|v| {
                v["input"] == i.version
                    && v["page"] == json!(page_number)
                    && matches!(
                        v["type"].as_str(),
                        Some("pdf_page" | "pdf_ocr" | "image_ocr")
                    )
            })
        });
        Ok(Some(
            json!({"ready":ready,"input":input.map(|v|v.version),"blob":blob,"chunk":chunk,"status":status,"title":title,"path":path}),
        ))
    }
    pub(super) fn attachment_snapshot(
        &self,
        c: &Connection,
        locator: &EvidenceLocator,
    ) -> Result<Snapshot, String> {
        let hint = self
            .attachment_hint(c, locator)?
            .ok_or("附件来源已不存在或不可用")?;
        if hint["ready"] != true {
            return Err(
                "附件片段尚无当前输入版本的提取证明，请等待原提取流程完成；旧片段不用于引用".into(),
            );
        }
        let EvidenceLocator::Attachment {
            library_id,
            document_id,
            source_item_id,
            chunk_id,
            page_number,
        } = locator
        else {
            unreachable!()
        };
        let (body,title,path,text_hash,kind):(String,String,String,String,String)=c.query_row("SELECT ci.body,s.title,d.path,ci.source_hash,ci.content_type FROM content_items ci JOIN source_items s ON s.id=ci.source_item_id JOIN documents d ON d.space_id=ci.space_id AND d.id=ci.document_id WHERE ci.id=?1 AND ci.space_id=?2 AND ci.document_id=?3 AND s.id=?4",params![chunk_id,library_id,document_id,source_item_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).map_err(|e|e.to_string())?;
        if format!("{:x}", Sha256::digest(body.as_bytes())) != text_hash {
            return Err("附件片段文字与提取指纹不一致".into());
        }
        Ok(Snapshot {
            locator: locator.clone(),
            version: EvidenceVersion::AttachmentInput(fingerprint(
                &json!({"hint":hint,"title":title,"path":path}),
            )),
            title,
            path,
            body,
            facts: json!({"inputVersion":hint["input"],"sourceHash":text_hash,"pageNumber":page_number,"extractionKind":kind,"coverage":"extractedChunkOnly","wholeAttachmentRead":false,"imagesAnalyzed":false}),
        })
    }
}
