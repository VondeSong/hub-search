//! Shared cached evidence for host-controlled investigations. A scope is granted
//! by the caller, never deserialized from a model's tool arguments. This layer
//! does not invoke models, capture activity, synchronize or mutate source data.
use super::*;
use rusqlite::OpenFlags;
use sha2::{Digest, Sha256};
pub(crate) mod analysis;
mod attachment;
mod change_hints;
mod links;
pub(crate) mod local_text;
mod task_hints;

#[cfg(test)]
pub(crate) mod tests;

const MAX_RESULTS: usize = 50;
const MAX_READ_CHARS: usize = 20_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum EvidenceLocator {
    Note {
        library_id: String,
        document_id: String,
        page_id: Option<String>,
    },
    Attachment {
        library_id: String,
        document_id: String,
        source_item_id: String,
        chunk_id: String,
        page_number: Option<i64>,
    },
    Task {
        library_id: String,
        source_id: String,
    },
    Reading {
        item_key: String,
    },
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum EvidenceKind {
    Note,
    Task,
    Reading,
}

/// Deliberately not Deserialize: a later Agent dispatcher must retain this
/// host-issued scope while the model supplies only queries and locators.
#[derive(Clone)]
pub(crate) struct EvidenceScope {
    library_ids: Vec<String>,
    reading_item_keys: Vec<String>,
    notes: Vec<EvidenceLocator>,
    sources: Vec<EvidenceLocator>,
    attachment_library_ids: Vec<String>,
}

impl EvidenceScope {
    pub(crate) fn new(
        library_ids: Vec<String>,
        reading_item_keys: Vec<String>,
    ) -> Result<Self, String> {
        fn normalize(mut values: Vec<String>) -> Result<Vec<String>, String> {
            if values.len() > 256
                || values
                    .iter()
                    .any(|s| s.trim().is_empty() || s.len() > 1024 || s.trim() != s)
            {
                return Err("取证授权范围无效".into());
            }
            values.sort();
            values.dedup();
            Ok(values)
        }
        Ok(Self {
            library_ids: normalize(library_ids)?,
            reading_item_keys: normalize(reading_item_keys)?,
            notes: Vec::new(),
            sources: Vec::new(),
            attachment_library_ids: Vec::new(),
        })
    }
    /// Exact note/page grants do not grant sibling notes, tasks or attachments.
    pub(crate) fn with_notes(mut self, notes: Vec<EvidenceLocator>) -> Result<Self, String> {
        if notes.len() > 32 {
            return Err("一次最多授权 32 篇笔记".into());
        }
        for note in &notes {
            let EvidenceLocator::Note {
                library_id,
                document_id,
                page_id,
            } = note
            else {
                return Err("对象授权仅支持笔记页面".into());
            };
            for id in [Some(library_id), Some(document_id), page_id.as_ref()]
                .into_iter()
                .flatten()
            {
                if id.is_empty() || id.trim() != id || id.len() > 1024 {
                    return Err("笔记授权标识无效".into());
                }
            }
        }
        self.notes = notes;
        Ok(self)
    }
    /// Only host-confirmed, frozen manifest members use this path.
    /// Manual selection remains bounded by with_notes above.
    pub(crate) fn with_frozen_notes(mut self, notes: Vec<EvidenceLocator>) -> Result<Self, String> {
        if notes.is_empty()
            || notes.len() > 5000
            || serde_json::to_vec(&notes).map_err(|e| e.to_string())?.len() > 32768
        {
            return Err("固定材料范围为空或超过容量上限".into());
        }
        for chunk in notes.chunks(32) {
            Self::new(vec![], vec![])?.with_notes(chunk.to_vec())?;
        }
        for note in notes {
            if !self.notes.contains(&note) {
                self.notes.push(note);
            }
        }
        Ok(self)
    }
    pub(crate) fn permits_note(&self, locator: &EvidenceLocator) -> bool {
        let EvidenceLocator::Note {
            library_id,
            document_id,
            page_id,
        } = locator
        else {
            return false;
        };
        self.library_ids.contains(library_id) || self.notes.iter().any(|n| matches!(n,
            EvidenceLocator::Note { library_id:l,document_id:d,page_id:p } if l==library_id && d==document_id && (p.is_none() || p==page_id)))
    }
    pub(crate) fn with_sources(mut self, sources: Vec<EvidenceLocator>) -> Result<Self, String> {
        if sources.len() > 64 {
            return Err("一次最多授权 64 个任务或附件来源".into());
        }
        for locator in &sources {
            let ids = match locator {
                EvidenceLocator::Task {
                    library_id,
                    source_id,
                } => vec![library_id, source_id],
                EvidenceLocator::Attachment {
                    library_id,
                    document_id,
                    source_item_id,
                    chunk_id,
                    ..
                } => vec![library_id, document_id, source_item_id, chunk_id],
                _ => return Err("精确来源授权仅支持任务或附件".into()),
            };
            if ids
                .iter()
                .any(|v| v.trim().is_empty() || v.trim() != v.as_str() || v.len() > 1024)
            {
                return Err("来源授权标识无效".into());
            }
        }
        self.sources = sources;
        Ok(self)
    }
    fn permits_source(&self, locator: &EvidenceLocator) -> bool {
        let library = match locator {
            EvidenceLocator::Task { library_id, .. } => self.library_ids.contains(library_id),
            EvidenceLocator::Attachment { library_id, .. } => {
                self.attachment_library_ids.contains(library_id)
            }
            _ => return false,
        };
        library || self.sources.contains(locator)
    }
    pub(crate) fn with_attachment_libraries(
        mut self,
        libraries: Vec<String>,
    ) -> Result<Self, String> {
        let checked = Self::new(libraries, vec![])?;
        self.attachment_library_ids = checked.library_ids;
        Ok(self)
    }

    pub(crate) fn whole_libraries(&self) -> &[String] {
        &self.library_ids
    }

    pub(crate) fn in_library(&self, id: &str) -> Result<Self, String> {
        let mut scope = self.clone();
        scope.library_ids.retain(|v| v == id);
        scope
            .notes
            .retain(|v| matches!(v, EvidenceLocator::Note { library_id, .. } if library_id == id));
        scope.sources.retain(|v| matches!(v, EvidenceLocator::Task { library_id, .. } | EvidenceLocator::Attachment { library_id, .. } if library_id == id));
        scope.attachment_library_ids.retain(|v| v == id);
        scope.reading_item_keys.clear();
        if scope.library_ids.is_empty()
            && scope.notes.is_empty()
            && scope.sources.is_empty()
            && scope.attachment_library_ids.is_empty()
        {
            return Err("资料库不在本次授权范围".into());
        }
        Ok(scope)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "fingerprint", rename_all = "camelCase")]
pub(crate) enum EvidenceVersion {
    Document(String),
    TaskFacts(String),
    ReadingState(String),
    AttachmentInput(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EvidenceExcerpt {
    pub(crate) locator: EvidenceLocator,
    pub(crate) version: EvidenceVersion,
    pub(crate) title: String,
    pub(crate) source_path: String,
    pub(crate) content: String,
    pub(crate) start_char: usize,
    pub(crate) end_char: usize,
    pub(crate) total_chars: usize,
    pub(crate) truncated: bool,
    pub(crate) facts: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EvidenceCandidate {
    pub(crate) locator: EvidenceLocator,
    pub(crate) version: EvidenceVersion,
    pub(crate) title: String,
    pub(crate) snippet: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) match_start_char: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EvidenceSearch {
    pub(crate) candidates: Vec<EvidenceCandidate>,
    pub(crate) retrieval: &'static str,
    pub(crate) exhaustive: bool,
    pub(crate) limit_reached: bool,
    pub(crate) unavailable_candidates: usize,
}

pub(crate) struct EvidenceReader {
    root: PathBuf,
    scope: EvidenceScope,
    control: Option<crate::model_runtime::Control>,
}

struct Snapshot {
    locator: EvidenceLocator,
    version: EvidenceVersion,
    title: String,
    path: String,
    body: String,
    facts: Value,
}

fn fingerprint(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}

pub(crate) fn open_read_database(root: &Path) -> Result<Connection, String> {
    let c = Connection::open_with_flags(
        root.join("craft-search.sqlite3"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| format!("无法打开已有取证数据库：{e}"))?;
    c.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    let schema: String = c
        .query_row(
            "SELECT value FROM metadata WHERE key='schema_version'",
            [],
            |r| r.get(0),
        )
        .map_err(|_| "取证数据库尚未初始化，请先打开 Hub")?;
    if schema.parse::<i64>().ok() != Some(DATABASE_SCHEMA_VERSION) {
        return Err("取证数据库版本与当前 Hub 不兼容，请先使用匹配版本的 Hub 完成初始化".into());
    }
    Ok(c)
}

pub(crate) fn open_search_index(root: &Path, c: &Connection) -> Result<SearchIndex, String> {
    let relative: String = c.query_row(
        "SELECT relative_path FROM search_index_generations WHERE status='active' AND schema_version=?1 ORDER BY activated_at DESC LIMIT 1",
        params![SEARCH_INDEX_SCHEMA_VERSION], |r| r.get(0)
    ).map_err(|e| format!("Hub 没有可用的活动搜索索引：{e}"))?;
    SearchIndex::open_existing(&safe_generation_path(
        &root.join("tantivy-generations-v1"),
        &relative,
    )?)
}

pub(crate) struct DocumentRecord {
    pub(crate) title: String,
    pub(crate) path: String,
    pub(crate) markdown: String,
    pub(crate) blob_hash: Option<String>,
    pub(crate) provider: String,
    pub(crate) content_hash: String,
    pub(crate) library_name: String,
}

/// Shared authoritative record; domain consumers keep their own page/tag rules.
pub(crate) fn document_record(
    c: &Connection,
    library_id: &str,
    document_id: &str,
) -> Result<DocumentRecord, String> {
    c.query_row(
        "SELECT d.title,d.path,d.markdown,d.blob_hash,d.provider,d.content_hash,l.name
         FROM documents d JOIN libraries l ON l.id=d.space_id
         WHERE d.space_id=?1 AND d.id=?2 AND l.enabled=1",
        params![library_id, document_id],
        |r| {
            Ok(DocumentRecord {
                title: r.get(0)?,
                path: r.get(1)?,
                markdown: r.get(2)?,
                blob_hash: r.get(3)?,
                provider: r.get(4)?,
                content_hash: r.get(5)?,
                library_name: r.get(6)?,
            })
        },
    )
    .map_err(|_| "内容已不存在或资料库未启用".into())
}

impl DocumentRecord {
    pub(crate) fn body(&self, root: &Path) -> Result<String, String> {
        if !self.markdown.is_empty() {
            return Ok(self.markdown.clone());
        }
        let hash = self
            .blob_hash
            .as_deref()
            .ok_or("这篇 Hub 笔记没有可用正文")?;
        let bytes = BlobStore::open_existing(&root.join("blobs-v1"))?.read(hash)?;
        if format!("{:x}", Sha256::digest(&bytes)) != hash.to_ascii_lowercase() {
            return Err("笔记 Blob 内容校验失败".into());
        }
        String::from_utf8(bytes).map_err(|_| "Hub 笔记正文不是 UTF-8 文本".into())
    }
}

/// Legacy MCP keeps its response shape and media presentation. Both it and
/// investigations now use the same cached record and exact body producer.
/// Resolve a selected indexed Craft block to its actual page. Unknown or
/// ambiguous locations never fall back to the enclosing document.
pub(crate) fn resolve_note_page(
    root: &Path,
    c: &Connection,
    locator: EvidenceLocator,
) -> Result<EvidenceLocator, String> {
    let EvidenceLocator::Note {
        library_id,
        document_id,
        page_id: Some(page),
    } = &locator
    else {
        return Ok(locator);
    };
    if page == document_id {
        return Ok(locator);
    }
    // A page's own ID can also identify its card in the parent index. Preserve
    // the actual page before considering a block-to-page mapping, including
    // empty pages. Unavailable source content cannot authorize a broader page.
    let Ok(record) = document_record(c, library_id, document_id) else {
        return Ok(locator);
    };
    if record.provider != PROVIDER_CRAFT {
        return Ok(locator);
    }
    let Ok(body) = record.body(root) else {
        return Ok(locator);
    };
    if content::craft_page_evidence(&body, document_id, page).is_some() {
        return Ok(locator);
    }
    let mut q=c.prepare("SELECT DISTINCT page_id FROM content_items WHERE provider='craft' AND space_id=?1 AND document_id=?2 AND block_id=?3 AND COALESCE(source_item_id,'')='' AND length(trim(COALESCE(page_id,'')))>0 LIMIT 2").map_err(|_|"无法核对当前笔记的页面身份")?;
    let pages = q
        .query_map(params![library_id, document_id, page], |r| {
            r.get::<_, String>(0)
        })
        .map_err(|_| "无法读取当前笔记的页面身份")?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "当前笔记的页面身份无效")?;
    match pages.as_slice() {
        [] => Ok(locator),
        [page] => Ok(EvidenceLocator::Note {
            library_id: library_id.clone(),
            document_id: document_id.clone(),
            page_id: Some(page.clone()),
        }),
        _ => Err("该正文块对应多个页面，请重新同步后再调查".into()),
    }
}

pub(crate) fn note_body(
    root: &Path,
    c: &Connection,
    library: &str,
    document: &str,
    block: &str,
) -> Result<(DocumentRecord, String), String> {
    let record = document_record(c, library, document)?;
    let body = record.body(root)?;
    let body = if record.provider == PROVIDER_CRAFT && !block.is_empty() {
        craft_page_preview(&body, document, block)
    } else {
        body
    };
    Ok((record, body))
}

pub(crate) fn search_note_hits(
    root: &Path,
    c: &Connection,
    libraries: &[String],
    query: &str,
    limit: usize,
) -> Result<Vec<search_index::SearchHit>, String> {
    if libraries.is_empty() {
        return Ok(Vec::new());
    }
    open_search_index(root, c)?.search_with_space_ids_and_field_scope(
        query,
        limit.clamp(1, MAX_RESULTS),
        Some(libraries),
        None,
        None,
        true,
        true,
        true,
        true,
        true,
        "all",
    )
}

impl EvidenceReader {
    pub(crate) fn new(root: &Path, scope: EvidenceScope) -> Self {
        Self {
            root: root.into(),
            scope,
            control: None,
        }
    }
    pub(crate) fn controlled(mut self, control: crate::model_runtime::Control) -> Self {
        self.control = Some(control);
        self
    }
    fn checkpoint(&self) -> Result<(), String> {
        self.control.as_ref().map_or(Ok(()), |c| c.check())
    }

    fn visible(&self, c: &Connection) -> Result<Vec<String>, String> {
        let visible = visible_library_ids(&self.root.join("craft-search.sqlite3"), c)?;
        let mut ids = self.scope.library_ids.clone();
        ids.extend(self.scope.notes.iter().filter_map(|n| {
            if let EvidenceLocator::Note { library_id, .. } = n {
                Some(library_id.clone())
            } else {
                None
            }
        }));
        ids.extend(self.scope.sources.iter().filter_map(|s| match s {
            EvidenceLocator::Task { library_id, .. }
            | EvidenceLocator::Attachment { library_id, .. } => Some(library_id.clone()),
            _ => None,
        }));
        ids.extend(self.scope.attachment_library_ids.clone());
        ids.sort();
        ids.dedup();
        Ok(ids
            .iter()
            .filter(|id| visible.contains(id))
            .cloned()
            .collect())
    }

    fn in_snapshot<T>(
        &self,
        read: impl FnOnce(&Connection, &[String]) -> Result<T, String>,
    ) -> Result<T, String> {
        self.checkpoint()?;
        let permit = library_runtime::cached_read_permit(&self.root)?;
        let c = open_read_database(&self.root)?;
        if let Some(control) = &self.control {
            c.busy_timeout(
                control
                    .deadline(std::time::Instant::now() + std::time::Duration::from_secs(5))
                    .saturating_duration_since(std::time::Instant::now()),
            )
            .map_err(|e| e.to_string())?;
            let interrupt = control.clone();
            c.progress_handler(1000, Some(move || interrupt.check().is_err()));
        }
        c.execute_batch("BEGIN DEFERRED")
            .map_err(|e| e.to_string())?;
        let libraries = self.visible(&c)?;
        let result = read(&c, &libraries)?;
        c.execute_batch("COMMIT").map_err(|e| e.to_string())?;
        // Do not keep a long-lived transaction across model calls. Re-check
        // eligibility outside the read snapshot before returning evidence.
        if self.visible(&c)? != libraries {
            return Err("取证期间来源资格已改变，请重新取证".into());
        }
        permit.checkpoint()?;
        self.checkpoint()?;
        Ok(result)
    }

    pub(crate) fn catalog(&self) -> Result<Value, String> {
        self.in_snapshot(|c,libraries| {
            let mut sources = Vec::new();
            for id in libraries {
                sources.push(c.query_row("SELECT id,name,provider FROM libraries WHERE id=?1",[id],|r| Ok(json!({
                    "libraryId":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"provider":r.get::<_,String>(2)?
                }))).map_err(|e| e.to_string())?);
            }
            Ok(json!({"libraries":sources,"wholeLibraryIds":self.scope.library_ids,"attachmentLibraryIds":self.scope.attachment_library_ids,"exactNotes":self.scope.notes,"exactSources":self.scope.sources,"readingItemKeys":self.scope.reading_item_keys,
                "unavailableLibraries":self.scope.library_ids.iter().chain(self.scope.attachment_library_ids.iter()).chain(self.scope.sources.iter().filter_map(|s|match s {EvidenceLocator::Task{library_id,..}|EvidenceLocator::Attachment{library_id,..}=>Some(library_id),_=>None})).chain(self.scope.notes.iter().filter_map(|n|if let EvidenceLocator::Note {library_id,..}=n {Some(library_id)} else {None})).filter(|id|id.as_str()!=local_text::LIBRARY).collect::<HashSet<_>>().len().saturating_sub(libraries.len()),
                "coverage":"authorizedLocalCache","sourceFreshness":"notVerifiedWithRemote",
                "capabilities":{"notes":true,"tasks":true,"reading":true,"attachmentCitations":!self.scope.attachment_library_ids.is_empty() || self.scope.sources.iter().any(|s|matches!(s,EvidenceLocator::Attachment{..})),"attachmentCoverage":"versionBoundExtractedChunksOnly"},
                "retrieval":"lexical","exhaustive":false}))
        })
    }

    pub(crate) fn search(
        &self,
        kind: EvidenceKind,
        query: &str,
        limit: usize,
    ) -> Result<EvidenceSearch, String> {
        let query = query.trim();
        if query.is_empty() || query.chars().count() > 200 {
            return Err("取证查询需要 1–200 个字符".into());
        }
        let limit = limit.clamp(1, MAX_RESULTS);
        self.in_snapshot(|c,libraries| {
            let mut snapshots = Vec::new();
            let mut unavailable = 0;
            let reached;
            let retrieval;
            match kind {
                EvidenceKind::Note => {
                    retrieval = "tantivy_lexical";
                    let whole: Vec<_> = libraries.iter().filter(|l| self.scope.library_ids.contains(l)).cloned().collect();
                    let hits = search_note_hits(&self.root,c,&whole,query,limit)?;
                    reached = hits.len()==limit;
                    for hit in hits {
                        let locator = if !hit.source_item_id.is_empty() {
                            EvidenceLocator::Attachment { library_id:hit.space_id,document_id:hit.document_id,
                                source_item_id:hit.source_item_id,chunk_id:hit.item_id,page_number:hit.page_number }
                        } else {
                            let page_id = if hit.provider==PROVIDER_CRAFT {
                                c.query_row("SELECT COALESCE(NULLIF(page_id,''),document_id) FROM content_items WHERE id=?1 AND space_id=?2 AND document_id=?3",
                                    params![hit.item_id,hit.space_id,hit.document_id],|r| r.get::<_,String>(0)).optional().map_err(|e|e.to_string())?
                            } else { None };
                            if hit.provider==PROVIDER_CRAFT && page_id.is_none() { unavailable+=1; continue; }
                            EvidenceLocator::Note { library_id:hit.space_id,document_id:hit.document_id,page_id }
                        };
                        match self.snapshot(c,libraries,&locator) {
                            Ok(value) => snapshots.push(value),
                            Err(_) => unavailable += 1,
                        }
                    }
                    for locator in &self.scope.notes {
                        match self.snapshot(c,libraries,locator) {
                            Ok(value) if value.body.to_lowercase().contains(&query.to_lowercase()) || value.title.to_lowercase().contains(&query.to_lowercase()) => snapshots.push(value),
                            Err(_) => unavailable += 1,
                            _ => (),
                        }
                    }
                    snapshots.truncate(limit);
                }
                EvidenceKind::Task => {
                    retrieval = "task_facts_lexical";
                    snapshots = self.task_snapshots(c,libraries)?.into_iter().filter(|s| {
                        s.body.to_lowercase().contains(&query.to_lowercase())
                    }).collect();
                    reached = snapshots.len()>limit;
                    snapshots.truncate(limit);
                }
                EvidenceKind::Reading => {
                    retrieval = "collection_lexical";
                    let entries = x_bookmarks::evidence_entries(c,&self.scope.reading_item_keys,query,limit+1)?;
                    reached = entries.len()>limit;
                    snapshots = entries.into_iter().take(limit).map(reading_snapshot).collect();
                }
            }
            let mut seen = HashSet::new();
            let candidates = snapshots.into_iter().filter(|s| seen.insert(serde_json::to_string(&s.locator).unwrap_or_default())).map(|s| EvidenceCandidate {
                match_start_char:s.body.find(query).map(|byte|s.body[..byte].chars().count()),
                locator:s.locator,version:s.version,title:s.title,
                snippet:make_search_snippet(&s.body,&[query.to_string()]).chars().take(600).collect(),
            }).collect();
            Ok(EvidenceSearch { candidates,retrieval,exhaustive:false,limit_reached:reached,unavailable_candidates:unavailable })
        })
    }

    pub(crate) fn read(
        &self,
        locator: &EvidenceLocator,
        start_char: usize,
        max_chars: usize,
        expected: Option<&EvidenceVersion>,
    ) -> Result<EvidenceExcerpt, String> {
        if max_chars == 0 || max_chars > MAX_READ_CHARS {
            return Err("读取长度需要在 1–20000 字符之间".into());
        }
        self.in_snapshot(|c, libraries| {
            let s = self.snapshot(c, libraries, locator)?;
            if expected.is_some_and(|v| v != &s.version) {
                return Err("证据版本已改变，请重新检索或读取".into());
            }
            let total_chars = s.body.chars().count();
            if start_char > total_chars {
                return Err("字符起点超出当前证据范围".into());
            }
            let content: String = s.body.chars().skip(start_char).take(max_chars).collect();
            let end_char = start_char + content.chars().count();
            let mut facts = s.facts;
            // Full source facts belong to the ranged body, not an unbounded
            // metadata side channel that could bypass the excerpt limit.
            if let Some(fields) = facts.as_object_mut() {
                fields.remove("sourceFacts");
                fields.insert("sourceFreshness".into(), json!("notVerifiedWithRemote"));
            }
            Ok(EvidenceExcerpt {
                locator: s.locator,
                version: s.version,
                title: s.title,
                source_path: s.path,
                content,
                start_char,
                end_char,
                total_chars,
                truncated: start_char > 0 || end_char < total_chars,
                facts,
            })
        })
    }

    /// Re-read rather than trusting a remembered citation or an index hit.
    pub(crate) fn verify(&self, excerpt: &EvidenceExcerpt) -> Result<(), String> {
        let current = self.read(
            &excerpt.locator,
            excerpt.start_char,
            (excerpt.end_char - excerpt.start_char).max(1),
            Some(&excerpt.version),
        )?;
        if current.content != excerpt.content || current.end_char != excerpt.end_char {
            return Err("引用与当前来源不一致".into());
        }
        Ok(())
    }

    /// Old summaries are input too. Before another model request, check both
    /// read ranges and candidates against one current authorization snapshot.
    pub(crate) fn verify_bundle(
        &self,
        excerpts: &[EvidenceExcerpt],
        candidates: &[(EvidenceLocator, EvidenceVersion)],
    ) -> Result<(), String> {
        self.in_snapshot(|c, _| {
            self.verify_in_transaction(c, excerpts)?;
            self.verify_candidates_in_transaction(c, candidates)
        })
    }

    pub(crate) fn verify_candidates_in_transaction(
        &self,
        c: &Connection,
        candidates: &[(EvidenceLocator, EvidenceVersion)],
    ) -> Result<(), String> {
        let libraries = self.visible(c)?;
        for (locator, version) in candidates {
            self.checkpoint()?;
            if self.snapshot(c, &libraries, locator)?.version != *version {
                return Err("检索候选已改变，请继续新一轮调查".into());
            }
        }
        Ok(())
    }

    /// Publication uses the caller's write transaction so evidence and work
    /// revisions are checked against the same snapshot as the result commit.
    pub(crate) fn verify_in_transaction(
        &self,
        c: &Connection,
        excerpts: &[EvidenceExcerpt],
    ) -> Result<(), String> {
        let libraries = self.visible(c)?;
        for excerpt in excerpts {
            if excerpt.start_char > excerpt.end_char {
                return Err("引用范围无效".into());
            }
            let s = self.snapshot(c, &libraries, &excerpt.locator)?;
            let current: String = s
                .body
                .chars()
                .skip(excerpt.start_char)
                .take(excerpt.end_char.saturating_sub(excerpt.start_char))
                .collect();
            if s.version != excerpt.version
                || current != excerpt.content
                || excerpt.end_char > s.body.chars().count()
            {
                return Err("证据已改变，请继续调查后再采用结果".into());
            }
        }
        Ok(())
    }

    /// Coverage uses the caller snapshot and the real source length, never a
    /// historical receipt's unverified totalChars claim. No body is returned.
    pub(crate) fn verified_extent_on(
        &self,
        c: &Connection,
        excerpt: &EvidenceExcerpt,
    ) -> Result<usize, String> {
        self.verify_in_transaction(c, std::slice::from_ref(excerpt))?;
        let libraries = self.visible(c)?;
        Ok(self
            .snapshot(c, &libraries, &excerpt.locator)?
            .body
            .chars()
            .count())
    }

    fn snapshot(
        &self,
        c: &Connection,
        libraries: &[String],
        locator: &EvidenceLocator,
    ) -> Result<Snapshot, String> {
        if local_text::is_local(locator) {
            if !self.scope.notes.contains(locator) {
                return Err("文本附件未获明确授权".into());
            }
            return local_text::snapshot(&self.root, locator);
        }
        let library = match locator {
            EvidenceLocator::Note { library_id, .. }
            | EvidenceLocator::Attachment { library_id, .. }
            | EvidenceLocator::Task { library_id, .. } => Some(library_id),
            EvidenceLocator::Reading { item_key } => {
                if !self.scope.reading_item_keys.contains(item_key) {
                    return Err("阅读条目不在本次授权范围".into());
                }
                None
            }
        };
        if library.is_some_and(|id| !libraries.contains(id)) {
            return Err("资料库不在本次有效授权范围".into());
        }
        match locator {
            EvidenceLocator::Note { .. } if !self.scope.permits_note(locator) => {
                return Err("笔记不在本次授权范围".into())
            }
            EvidenceLocator::Task { library_id, .. }
            | EvidenceLocator::Attachment { library_id, .. }
                if !self.scope.permits_source(locator) =>
            {
                return Err("该来源未获资料库授权".into())
            }
            _ => (),
        }
        match locator {
            EvidenceLocator::Note {
                library_id,
                document_id,
                page_id,
            } => {
                let record = document_record(c, library_id, document_id)?;
                let full_body = record.body(&self.root)?;
                let mut body = full_body.clone();
                if let Some(page) = page_id {
                    if record.provider != PROVIDER_CRAFT {
                        return Err("该笔记不支持页面定位".into());
                    }
                    body = content::craft_page_evidence(&full_body, document_id, page)
                        .ok_or("Craft 页面已不存在或无法精确定位")?;
                }
                let version = EvidenceVersion::Document(fingerprint(
                    &json!({"locator":locator,"hash":record.content_hash,
                    "body":full_body,"title":record.title,"path":record.path}),
                ));
                Ok(Snapshot {
                    locator: locator.clone(),
                    version,
                    title: record.title,
                    path: record.path,
                    body,
                    facts: json!({"sourceHash":record.content_hash,"provider":record.provider}),
                })
            }
            EvidenceLocator::Attachment { .. } => self.attachment_snapshot(c, locator),
            EvidenceLocator::Task {
                library_id,
                source_id,
            } => self
                .task_snapshots(c, libraries)?
                .into_iter()
                .find(|s| {
                    s.facts["sources"].as_array().is_some_and(|sources| {
                        sources
                            .iter()
                            .any(|r| r["libraryId"] == *library_id && r["sourceId"] == *source_id)
                    })
                })
                .ok_or_else(|| "任务已不存在或不在本次授权范围".into()),
            EvidenceLocator::Reading { item_key } => {
                x_bookmarks::evidence_entries(c, &[item_key.clone()], "", 1)?
                    .into_iter()
                    .next()
                    .map(reading_snapshot)
                    .ok_or_else(|| "阅读条目已不存在或不可读取".into())
            }
        }
    }

    fn task_snapshots(
        &self,
        c: &Connection,
        libraries: &[String],
    ) -> Result<Vec<Snapshot>, String> {
        if libraries.is_empty() {
            return Ok(Vec::new());
        }
        let whole: Vec<_> = libraries
            .iter()
            .filter(|l| self.scope.library_ids.contains(l))
            .cloned()
            .collect();
        let mut tasks = unified_task_read::load(c, Some(&whole))?;
        let selected: Vec<_> = self
            .scope
            .sources
            .iter()
            .filter_map(|v| match v {
                EvidenceLocator::Task {
                    library_id,
                    source_id,
                } if libraries.contains(library_id) && !whole.contains(library_id) => {
                    Some((library_id.clone(), source_id.clone()))
                }
                _ => None,
            })
            .collect();
        if !selected.is_empty() {
            tasks.extend(unified_task_read::load_selected(c, &selected)?);
        }
        let mut source_facts = HashMap::new();
        for task in &tasks {
            self.checkpoint()?;
            let document_hash = if task.source_id.contains(":line:") {
                let document = document_record(c, &task.library_id, &task.document_id)?;
                Some(fingerprint(
                    &json!({"hash":document.content_hash,"body":document.body(&self.root)?}),
                ))
            } else {
                None
            };
            let description = if task.provider == PROVIDER_DIDA365 {
                c.query_row("SELECT content || char(10) || description FROM dida_tasks WHERE library_id=?1 AND task_id=?2",
                    params![task.library_id,task.source_id],|r|r.get::<_,String>(0)).map_err(|e|e.to_string())?
            } else if task.provider == PROVIDER_CRAFT && !task.is_project {
                c.query_row(
                    "SELECT content FROM craft_task_blocks WHERE space_id=?1 AND block_id=?2",
                    params![task.library_id, task.source_id],
                    |r| r.get::<_, String>(0),
                )
                .optional()
                .map_err(|e| e.to_string())?
                .unwrap_or_default()
            } else {
                String::new()
            };
            let facts = json!({"provider":task.provider,"libraryId":task.library_id,"sourceId":task.source_id,
                "documentId":task.document_id,"documentTitle":task.document_title,"title":task.title,
                "status":task.status,"statusProvenance":if task.is_project {"derivedFromCachedChildren"} else {"source"},
                "completed":task.completed,"isProject":task.is_project,"parentTaskId":task.parent_task_id,
                "startAt":task.start_at,"dueAt":task.due_at,"scheduledAt":task.scheduled_at,"isAllDay":task.is_all_day,
                "timeZone":task.time_zone,"createdAt":task.created_at,"completedAt":task.completed_at,
                "collectionId":task.collection_id,"collectionName":task.collection_name,"description":description,"documentHash":document_hash});
            source_facts.insert((task.library_id.clone(), task.source_id.clone()), facts);
        }
        // Filtered source rows enter binding projection; excluded copies cannot
        // lend their titles, dates, descriptions or library facets to evidence.
        apply_task_bindings(c, &mut tasks)?;
        tasks.sort_by(|a, b| a.id.cmp(&b.id));
        let mut snapshots = Vec::new();
        for task in tasks {
            let sources = serde_json::to_value(&task.source_refs).map_err(|e| e.to_string())?;
            let dependencies = sources
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|r| {
                    source_facts
                        .get(&(
                            r["libraryId"].as_str()?.into(),
                            r["sourceId"].as_str()?.into(),
                        ))
                        .cloned()
                })
                .collect::<Vec<_>>();
            let facts = json!({"hubTaskId":task.id,"sources":sources,"sourceFacts":dependencies,"syncState":task.sync_state});
            let body = serde_json::to_string_pretty(&facts).map_err(|e| e.to_string())?;
            snapshots.push(Snapshot {
                locator: EvidenceLocator::Task {
                    library_id: task.library_id,
                    source_id: task.source_id,
                },
                version: EvidenceVersion::TaskFacts(fingerprint(&facts)),
                title: task.title,
                path: task.path,
                body,
                facts,
            });
        }
        Ok(snapshots)
    }
}

fn reading_snapshot(entry: x_bookmarks::EvidenceEntry) -> Snapshot {
    let title = x_bookmarks::storage::display_title(&entry.item);
    let body = x_bookmarks::storage::render_task_content(&entry.item);
    let source = if entry.item.post.source.is_empty() {
        "bookmarks"
    } else {
        &entry.item.post.source
    };
    let facts = json!({"source":source,"sourceHash":entry.source_hash,"status":entry.status,"tags":entry.tags,
        "state":entry.state,"lifecycleRevision":entry.lifecycle_revision,"readVersion":entry.read_version,
        "readStateRecorded":entry.item.read,"collectedAt":entry.item.collected_at});
    Snapshot {
        locator: EvidenceLocator::Reading {
            item_key: entry.item.key,
        },
        version: EvidenceVersion::ReadingState(fingerprint(
            &json!({"facts":facts,"body":body,"title":title,"url":entry.item.post.url}),
        )),
        title,
        path: entry.item.post.url,
        body,
        facts,
    }
}
