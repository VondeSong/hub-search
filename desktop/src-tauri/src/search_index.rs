use std::{
    collections::{HashMap, HashSet},
    ops::Bound,
    path::Path,
    sync::{Arc, Mutex},
};

use pinyin::ToPinyin;
use tantivy::{
    collector::{Collector, SegmentCollector, TopDocs},
    doc,
    query::{
        BooleanQuery, BoostQuery, FuzzyTermQuery, Occur, Query, QueryParser, RangeQuery, TermQuery,
        TermSetQuery,
    },
    schema::{
        Field, IndexRecordOption, NumericOptions, Schema, TextFieldIndexing, TextOptions, Value,
        STORED, STRING,
    },
    tokenizer::{LowerCaser, NgramTokenizer, TextAnalyzer},
    DocAddress, DocId, Index, IndexReader, ReloadPolicy, Score, SegmentReader, TantivyDocument,
    Term,
};

// Supplemental recall retains a fixed-size heap instead of growing TopDocs
// offsets. Its default Collector traversal must see equal-score documents after
// the cursor; delegating TopDocs::collect_segment would enable score pruning.
struct TopDocsAfter {
    inner: TopDocs,
    after: (Score, DocAddress),
}

struct TopDocsAfterSegment {
    inner: <TopDocs as Collector>::Child,
    segment_ord: u32,
    after: (Score, DocAddress),
    non_finite_score: bool,
}

impl Collector for TopDocsAfter {
    type Fruit = Vec<(Score, DocAddress)>;
    type Child = TopDocsAfterSegment;

    fn for_segment(
        &self,
        segment_ord: u32,
        reader: &SegmentReader,
    ) -> tantivy::Result<Self::Child> {
        Ok(TopDocsAfterSegment {
            inner: self.inner.for_segment(segment_ord, reader)?,
            segment_ord,
            after: self.after,
            non_finite_score: !self.after.0.is_finite(),
        })
    }

    fn requires_scoring(&self) -> bool {
        true
    }

    fn merge_fruits(
        &self,
        fruits: Vec<<Self::Child as SegmentCollector>::Fruit>,
    ) -> tantivy::Result<Self::Fruit> {
        if !self.after.0.is_finite() || fruits.iter().any(|(_, invalid)| *invalid) {
            return Err(tantivy::TantivyError::InvalidArgument(
                "Non-finite score in supplemental search recall".into(),
            ));
        }
        self.inner
            .merge_fruits(fruits.into_iter().map(|(hits, _)| hits).collect())
    }
}

impl SegmentCollector for TopDocsAfterSegment {
    type Fruit = (Vec<(Score, DocAddress)>, bool);

    fn collect(&mut self, doc: DocId, score: Score) {
        if !score.is_finite() {
            self.non_finite_score = true;
            return;
        }
        let address = DocAddress::new(self.segment_ord, doc);
        if score < self.after.0 || (score == self.after.0 && address > self.after.1) {
            self.inner.collect(doc, score);
        }
    }

    fn harvest(self) -> Self::Fruit {
        (self.inner.harvest(), self.non_finite_score)
    }
}

#[derive(Debug, Clone)]
pub struct IndexRecord {
    pub provider: String,
    pub item_id: String,
    pub document_key: String,
    pub entity_key: String,
    pub space_id: String,
    pub document_id: String,
    pub block_id: String,
    pub content_type: String,
    pub source_item_id: String,
    pub source_title: String,
    pub page_number: i64,
    pub title: String,
    pub heading: String,
    pub aliases: String,
    pub tags: String,
    pub body: String,
    pub path: String,
    pub folder_id: String,
    pub modified_at: i64,
}

#[derive(Debug, Clone)]
pub struct SearchSubHit {
    pub item_id: String,
    pub block_id: String,
    pub content_type: String,
    pub source_item_id: String,
    pub source_title: String,
    pub page_number: Option<i64>,
    pub heading: String,
    pub body: String,
    pub match_terms: Vec<String>,
    pub match_field: String,
}

#[derive(Debug, Clone)]
pub struct SearchHit {
    pub provider: String,
    pub item_id: String,
    pub entity_key: String,
    pub space_id: String,
    pub document_id: String,
    pub block_id: String,
    pub content_type: String,
    pub source_item_id: String,
    pub source_title: String,
    pub page_number: Option<i64>,
    pub title: String,
    pub heading: String,
    pub body: String,
    pub path: String,
    pub folder_id: Option<String>,
    pub modified_at: Option<i64>,
    pub score: f32,
    pub match_terms: Vec<String>,
    pub match_field: String,
    pub match_count: usize,
    pub sub_hits: Vec<SearchSubHit>,
}

#[derive(Debug)]
struct QueryIntent {
    terms: Vec<String>,
    phrases: Vec<String>,
    compact_ascii: Option<String>,
    single_term: bool,
}

fn query_intent(query: &str) -> QueryIntent {
    let mut terms = Vec::new();
    let mut phrases = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for character in query.trim().chars() {
        if character == '"' {
            let value = current.trim();
            if !value.is_empty() {
                if quoted {
                    phrases.push(value.to_string());
                } else {
                    terms.extend(value.split_whitespace().map(str::to_string));
                }
            }
            current.clear();
            quoted = !quoted;
        } else {
            current.push(character);
        }
    }
    let value = current.trim();
    if !value.is_empty() {
        if quoted {
            phrases.push(value.to_string());
        } else {
            terms.extend(value.split_whitespace().map(str::to_string));
        }
    }
    terms.retain(|term| !matches!(term.to_ascii_uppercase().as_str(), "AND" | "OR" | "NOT"));
    terms.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
    phrases.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
    let single_term = phrases.len() + terms.len() == 1;
    let only = phrases.first().or_else(|| terms.first());
    let compact_ascii = only.and_then(|value| {
        let compact = value
            .chars()
            .filter(|character| character.is_ascii_alphanumeric())
            .map(|character| character.to_ascii_lowercase())
            .collect::<String>();
        (!compact.is_empty()
            && value.chars().all(|character| {
                character.is_ascii_alphanumeric() || character.is_ascii_whitespace()
            }))
        .then_some(compact)
    });
    QueryIntent {
        terms,
        phrases,
        compact_ascii,
        single_term,
    }
}

fn find_case_insensitive(text: &str, needle: &str) -> bool {
    !needle.is_empty() && text.to_lowercase().contains(&needle.to_lowercase())
}

fn edit_distance(left: &str, right: &str) -> usize {
    let right_chars = right.chars().collect::<Vec<_>>();
    let mut previous = (0..=right_chars.len()).collect::<Vec<_>>();
    for (left_index, left_char) in left.chars().enumerate() {
        let mut current = vec![left_index + 1];
        for (right_index, right_char) in right_chars.iter().enumerate() {
            current.push(
                (current[right_index] + 1)
                    .min(previous[right_index + 1] + 1)
                    .min(previous[right_index] + usize::from(left_char != *right_char)),
            );
        }
        previous = current;
    }
    previous[right_chars.len()]
}

fn closest_ascii_word(text: &str, query: &str) -> Option<String> {
    let distance = if query.chars().count() >= 7 { 2 } else { 1 };
    text.split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|word| word.chars().count() >= 3)
        .filter_map(|word| {
            let normalized = word.to_ascii_lowercase();
            let score = edit_distance(&normalized, query);
            (score <= distance).then_some((score, word.to_string()))
        })
        .min_by_key(|(score, _)| *score)
        .map(|(_, word)| word)
}

fn pinyin_matches(text: &str, query: &str) -> bool {
    let (full, initials) = pinyin_forms(text);
    let compact_full = full
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>();
    let compact_initials = initials
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>();
    compact_full.contains(query)
        || compact_initials.contains(query)
        || edit_distance(&compact_full, query) <= usize::from(query.len() < 7) + 1
}

fn match_evidence(
    intent: &QueryIntent,
    title: &str,
    heading: &str,
    source_title: &str,
    aliases: &str,
    tags: &str,
    body: &str,
    path: &str,
) -> (Vec<String>, String, f32) {
    let fields = [
        ("title", title, 32.0_f32),
        ("alias", aliases, 27.0),
        ("heading", heading, 20.0),
        ("tag", tags, 15.0),
        ("attachment", source_title, 24.0),
        ("body", body, 8.0),
        ("path", path, 6.0),
    ];
    let candidates = intent
        .phrases
        .iter()
        .chain(intent.terms.iter())
        .filter(|value| !value.trim().is_empty())
        .collect::<Vec<_>>();
    let mut all_terms = Vec::new();
    let mut matched_fields = Vec::new();
    let mut best_field = "body".to_string();
    let mut best_bonus = 0.0_f32;
    for (field, text, field_bonus) in fields {
        let matches = candidates
            .iter()
            .filter(|candidate| find_case_insensitive(text, candidate))
            .map(|candidate| (*candidate).clone())
            .collect::<Vec<_>>();
        if !matches.is_empty() {
            matched_fields.push(field);
            for value in &matches {
                if !all_terms
                    .iter()
                    .any(|existing: &String| existing.eq_ignore_ascii_case(value))
                {
                    all_terms.push(value.clone());
                }
            }
            let exact_bonus = candidates
                .first()
                .filter(|_| candidates.len() == 1)
                .filter(|candidate| text.trim().eq_ignore_ascii_case(candidate.trim()))
                .map(|_| 28.0)
                .unwrap_or(0.0);
            let coverage = matches.len() as f32 / candidates.len().max(1) as f32;
            let bonus = field_bonus + exact_bonus + coverage * 12.0;
            if bonus > best_bonus {
                best_field = field.to_string();
                best_bonus = bonus;
            }
        }
    }
    if all_terms.is_empty() {
        if let Some(query) = intent.compact_ascii.as_deref() {
            for (field, text, bonus) in [
                ("title", title, 22.0_f32),
                ("alias", aliases, 20.0),
                ("heading", heading, 16.0),
                ("tag", tags, 11.0),
                ("attachment", source_title, 18.0),
                ("path", path, 10.0),
            ] {
                if !text.is_empty() && pinyin_matches(text, query) {
                    return (vec![text.to_string()], field.to_string(), bonus);
                }
            }
            for (field, text, bonus) in [
                ("title", title, 14.0_f32),
                ("alias", aliases, 13.0),
                ("heading", heading, 11.0),
                ("tag", tags, 8.0),
                ("attachment", source_title, 12.0),
                ("body", body, 5.0),
            ] {
                if let Some(word) = closest_ascii_word(text, query) {
                    return (vec![word], field.to_string(), bonus);
                }
            }
        }
    }
    let match_field = if matched_fields.len() > 1 {
        matched_fields.join(",")
    } else {
        best_field
    };
    (all_terms, match_field, best_bonus)
}

#[derive(Clone)]
struct Fields {
    provider: Field,
    item_id: Field,
    document_key: Field,
    entity_key: Field,
    space_id: Field,
    document_id: Field,
    block_id: Field,
    content_type: Field,
    source_item_id: Field,
    source_title: Field,
    page_number: Field,
    title: Field,
    heading: Field,
    aliases: Field,
    tags: Field,
    body: Field,
    path: Field,
    pinyin: Field,
    pinyin_initials: Field,
    fuzzy_text: Field,
    folder_id: Field,
    modified_at: Field,
}

#[derive(Clone)]
pub struct SearchIndex {
    directory: std::path::PathBuf,
    index: Index,
    reader: IndexReader,
    fields: Fields,
    writer: Arc<Mutex<Option<tantivy::IndexWriter<TantivyDocument>>>>,
    #[cfg(test)]
    writer_creations: Arc<std::sync::atomic::AtomicUsize>,
    #[cfg(test)]
    pub(crate) fail_next_commit: Arc<std::sync::atomic::AtomicBool>,
}

fn text_options(tokenizer: &str) -> TextOptions {
    TextOptions::default()
        .set_indexing_options(
            TextFieldIndexing::default()
                .set_tokenizer(tokenizer)
                .set_index_option(IndexRecordOption::WithFreqsAndPositions),
        )
        .set_stored()
}

fn build_schema() -> (Schema, Fields) {
    let mut builder = Schema::builder();
    let item_id = builder.add_text_field("item_id", STRING | STORED);
    let provider = builder.add_text_field("provider", STRING | STORED);
    let document_key = builder.add_text_field("document_key", STRING | STORED);
    let entity_key = builder.add_text_field("entity_key", STRING | STORED);
    let space_id = builder.add_text_field("space_id", STRING | STORED);
    let document_id = builder.add_text_field("document_id", STRING | STORED);
    let block_id = builder.add_text_field("block_id", STRING | STORED);
    let content_type = builder.add_text_field("content_type", STRING | STORED);
    let source_item_id = builder.add_text_field("source_item_id", STRING | STORED);
    let source_title = builder.add_text_field("source_title", text_options("zh_ngram"));
    let page_number = builder.add_i64_field("page_number", NumericOptions::default().set_stored());
    let title = builder.add_text_field("title", text_options("zh_ngram"));
    let heading = builder.add_text_field("heading", text_options("zh_ngram"));
    let aliases = builder.add_text_field("aliases", text_options("zh_ngram"));
    let tags = builder.add_text_field("tags", text_options("zh_ngram"));
    let body = builder.add_text_field("body", text_options("zh_ngram"));
    let path = builder.add_text_field("path", text_options("zh_ngram"));
    let pinyin = builder.add_text_field("pinyin", text_options("default"));
    let pinyin_initials = builder.add_text_field("pinyin_initials", text_options("default"));
    let fuzzy_text = builder.add_text_field("fuzzy_text", text_options("default"));
    let folder_id = builder.add_text_field("folder_id", STRING | STORED);
    let modified_at = builder.add_i64_field(
        "modified_at",
        NumericOptions::default()
            .set_indexed()
            .set_fast()
            .set_stored(),
    );
    let schema = builder.build();
    (
        schema,
        Fields {
            provider,
            item_id,
            document_key,
            entity_key,
            space_id,
            document_id,
            block_id,
            content_type,
            source_item_id,
            source_title,
            page_number,
            title,
            heading,
            aliases,
            tags,
            body,
            path,
            pinyin,
            pinyin_initials,
            fuzzy_text,
            folder_id,
            modified_at,
        },
    )
}

fn pinyin_forms(text: &str) -> (String, String) {
    let mut full = String::new();
    let mut initials = String::new();
    for character in text.chars() {
        if let Some(pinyin) = character.to_pinyin() {
            let syllable = pinyin.plain();
            full.push_str(syllable);
            initials.push(syllable.chars().next().unwrap_or_default());
        } else if character.is_ascii_alphanumeric() {
            full.push(character.to_ascii_lowercase());
            initials.push(character.to_ascii_lowercase());
        } else if !full.ends_with(' ') {
            full.push(' ');
            initials.push(' ');
        }
    }
    (full, initials)
}

fn add_index_document(
    writer: &mut tantivy::IndexWriter<TantivyDocument>,
    fields: &Fields,
    record: &IndexRecord,
) -> Result<(), String> {
    let searchable_source = format!(
        "{} {} {} {} {} {}",
        record.title, record.heading, record.aliases, record.tags, record.path, record.source_title
    );
    let (pinyin, pinyin_initials) = pinyin_forms(&searchable_source);
    writer
        .add_document(doc!(
            fields.provider => record.provider.clone(),
            fields.item_id => record.item_id.clone(),
            fields.document_key => record.document_key.clone(),
            fields.entity_key => record.entity_key.clone(),
            fields.space_id => record.space_id.clone(),
            fields.document_id => record.document_id.clone(),
            fields.block_id => record.block_id.clone(),
            fields.content_type => record.content_type.clone(),
            fields.source_item_id => record.source_item_id.clone(),
            fields.source_title => record.source_title.clone(),
            fields.page_number => record.page_number,
            fields.title => record.title.clone(),
            fields.heading => record.heading.clone(),
            fields.aliases => record.aliases.clone(),
            fields.tags => record.tags.clone(),
            fields.body => record.body.clone(),
            fields.path => record.path.clone(),
            fields.pinyin => pinyin,
            fields.pinyin_initials => pinyin_initials,
            fields.fuzzy_text => format!(
                "{} {} {} {} {} {} {}",
                record.title,
                record.heading,
                record.aliases,
                record.tags,
                record.path,
                record.source_title,
                record.body
            ),
            fields.folder_id => record.folder_id.clone(),
            fields.modified_at => record.modified_at,
        ))
        .map_err(|error| format!("无法写入 Tantivy 文档：{error}"))?;
    Ok(())
}

impl SearchIndex {
    pub fn open(directory: &Path) -> Result<Self, String> {
        Self::open_inner(directory, true)
    }

    /// A reader must never silently create an empty replacement generation.
    pub fn open_existing(directory: &Path) -> Result<Self, String> {
        Self::open_inner(directory, false)
    }

    fn open_inner(directory: &Path, create: bool) -> Result<Self, String> {
        if create {
            std::fs::create_dir_all(directory)
                .map_err(|error| format!("无法创建 Tantivy 索引目录：{error}"))?;
        } else if !directory.join("meta.json").is_file() {
            return Err("活动搜索索引尚未就绪".to_string());
        }
        let (schema, fields) = build_schema();
        let index = if directory.join("meta.json").exists() {
            Index::open_in_dir(directory)
                .map_err(|error| format!("无法打开 Tantivy 索引：{error}"))?
        } else {
            Index::create_in_dir(directory, schema)
                .map_err(|error| format!("无法创建 Tantivy 索引：{error}"))?
        };
        let analyzer = TextAnalyzer::builder(
            NgramTokenizer::new(2, 3, false)
                .map_err(|error| format!("无法初始化中文 N-gram：{error}"))?,
        )
        .filter(LowerCaser)
        .build();
        index.tokenizers().register("zh_ngram", analyzer);
        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::OnCommitWithDelay)
            .try_into()
            .map_err(|error| format!("无法创建 Tantivy Reader：{error}"))?;
        Ok(Self {
            directory: directory.to_path_buf(),
            index,
            reader,
            fields,
            writer: Arc::new(Mutex::new(None)),
            #[cfg(test)]
            writer_creations: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            #[cfg(test)]
            fail_next_commit: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        })
    }

    pub(crate) fn directory(&self) -> &Path {
        &self.directory
    }

    fn commit_error(&self, error: &tantivy::TantivyError) -> String {
        // Tantivy's IO variant can omit the affected filename. Do not invent it.
        format!(
            "无法提交 Tantivy 索引：[commit] directory={} cause={error:?}",
            self.directory.display()
        )
    }

    fn with_writer(
        &self,
        write: impl FnOnce(&mut tantivy::IndexWriter<TantivyDocument>) -> Result<(), String>,
    ) -> Result<(), String> {
        let mut owner = self
            .writer
            .lock()
            .map_err(|_| "搜索索引写入状态不可用".to_string())?;
        if owner.is_none() {
            *owner = Some(
                self.index
                    // Bound background indexing parallelism on large CPUs while
                    // retaining the full arena and every queued record.
                    .writer_with_num_threads::<TantivyDocument>(2, 96_000_000)
                    .map_err(|error| format!("无法创建 Tantivy Writer：{error}"))?,
            );
            #[cfg(test)]
            self.writer_creations
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        let result = write(owner.as_mut().expect("writer initialized"));
        if result.is_err() {
            // Drop uncommitted changes before another batch can reuse the writer.
            owner.take();
        }
        result
    }

    pub fn apply_changes(
        &self,
        deleted_document_keys: &[String],
        records: &[IndexRecord],
    ) -> Result<(), String> {
        if deleted_document_keys.is_empty() && records.is_empty() {
            return Ok(());
        }
        self.with_writer(|writer| {
            let mut keys = deleted_document_keys
                .iter()
                .cloned()
                .collect::<HashSet<_>>();
            keys.extend(records.iter().map(|record| record.document_key.clone()));
            for key in keys {
                writer.delete_term(Term::from_field_text(self.fields.document_key, &key));
            }
            for record in records {
                add_index_document(writer, &self.fields, record)?;
            }
            #[cfg(test)]
            if self
                .fail_next_commit
                .swap(false, std::sync::atomic::Ordering::SeqCst)
            {
                return Err(self.commit_error(&tantivy::TantivyError::IoError(Arc::new(
                    std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        "injected commit failure",
                    ),
                ))));
            }
            writer.commit().map_err(|error| self.commit_error(&error))?;
            self.reader
                .reload()
                .map_err(|error| format!("无法刷新 Tantivy Reader：{error}"))?;
            Ok(())
        })
    }

    pub fn rebuild_from(
        &self,
        produce: impl FnOnce(&mut dyn FnMut(IndexRecord) -> Result<(), String>) -> Result<(), String>,
    ) -> Result<usize, String> {
        let mut count = 0;
        self.with_writer(|writer| {
            writer
                .delete_all_documents()
                .map_err(|error| format!("无法清空 Tantivy 索引：{error}"))?;
            produce(&mut |record| {
                add_index_document(writer, &self.fields, &record)?;
                count += 1;
                Ok(())
            })?;
            writer
                .commit()
                .map_err(|error| format!("无法提交 Tantivy 重建：{error}"))?;
            self.reader
                .reload()
                .map_err(|error| format!("无法刷新 Tantivy Reader：{error}"))
        })?;
        Ok(count)
    }

    #[cfg(test)]
    pub fn rebuild(&self, records: &[IndexRecord]) -> Result<(), String> {
        self.rebuild_from(|append| {
            for record in records {
                append(record.clone())?;
            }
            Ok(())
        })
        .map(|_| ())
    }

    pub fn delete_space(&self, space_id: &str) -> Result<(), String> {
        self.with_writer(|writer| {
            writer.delete_term(Term::from_field_text(self.fields.space_id, space_id));
            writer
                .commit()
                .map_err(|error| format!("无法提交空间索引删除：{error}"))?;
            self.reader
                .reload()
                .map_err(|error| format!("无法刷新 Tantivy Reader：{error}"))
        })
    }

    pub fn num_docs(&self) -> u64 {
        self.reader.searcher().num_docs()
    }

    #[cfg(test)]
    pub fn search(
        &self,
        query_text: &str,
        limit: usize,
        space_id: Option<&str>,
        folder_id: Option<&str>,
        updated_after: Option<i64>,
        include_craft_pages: bool,
        include_image_ocr: bool,
        include_pdf: bool,
        include_pdf_ocr: bool,
    ) -> Result<Vec<SearchHit>, String> {
        self.search_with_filters(
            query_text,
            limit,
            space_id,
            folder_id,
            updated_after,
            include_craft_pages,
            include_image_ocr,
            include_pdf,
            include_pdf_ocr,
            true,
        )
    }

    #[cfg(test)]
    pub fn search_with_filters(
        &self,
        query_text: &str,
        limit: usize,
        space_id: Option<&str>,
        folder_id: Option<&str>,
        updated_after: Option<i64>,
        include_craft_pages: bool,
        include_image_ocr: bool,
        include_pdf: bool,
        include_pdf_ocr: bool,
        include_attachments: bool,
    ) -> Result<Vec<SearchHit>, String> {
        self.search_with_field_scope(
            query_text,
            limit,
            space_id,
            folder_id,
            updated_after,
            include_craft_pages,
            include_image_ocr,
            include_pdf,
            include_pdf_ocr,
            include_attachments,
            "all",
        )
    }

    #[cfg(test)]
    pub fn search_with_field_scope(
        &self,
        query_text: &str,
        limit: usize,
        space_id: Option<&str>,
        folder_id: Option<&str>,
        updated_after: Option<i64>,
        include_craft_pages: bool,
        include_image_ocr: bool,
        include_pdf: bool,
        include_pdf_ocr: bool,
        include_attachments: bool,
        field_scope: &str,
    ) -> Result<Vec<SearchHit>, String> {
        let space_ids = space_id.map(|id| vec![id.to_string()]);
        self.search_with_space_ids_and_field_scope(
            query_text,
            limit,
            space_ids.as_deref(),
            folder_id,
            updated_after,
            include_craft_pages,
            include_image_ocr,
            include_pdf,
            include_pdf_ocr,
            include_attachments,
            field_scope,
        )
    }

    pub fn search_with_space_ids_and_field_scope(
        &self,
        query_text: &str,
        limit: usize,
        space_ids: Option<&[String]>,
        folder_id: Option<&str>,
        updated_after: Option<i64>,
        include_craft_pages: bool,
        include_image_ocr: bool,
        include_pdf: bool,
        include_pdf_ocr: bool,
        include_attachments: bool,
        field_scope: &str,
    ) -> Result<Vec<SearchHit>, String> {
        self.search_in_folders(
            query_text,
            limit,
            space_ids,
            folder_id
                .filter(|value| !value.is_empty())
                .map(|value| vec![value.to_string()])
                .as_deref(),
            None,
            updated_after,
            include_craft_pages,
            include_image_ocr,
            include_pdf,
            include_pdf_ocr,
            include_attachments,
            field_scope,
        )
    }

    pub(crate) fn search_in_folders(
        &self,
        query_text: &str,
        limit: usize,
        space_ids: Option<&[String]>,
        folder_ids: Option<&[String]>,
        document_ids: Option<&[String]>,
        updated_after: Option<i64>,
        include_craft_pages: bool,
        include_image_ocr: bool,
        include_pdf: bool,
        include_pdf_ocr: bool,
        include_attachments: bool,
        field_scope: &str,
    ) -> Result<Vec<SearchHit>, String> {
        if !include_craft_pages && !include_image_ocr && !include_pdf && !include_attachments {
            return Ok(Vec::new());
        }
        if space_ids.is_some_and(|values| values.is_empty())
            || folder_ids.is_some_and(|values| values.is_empty())
            || document_ids.is_some_and(|values| values.is_empty())
        {
            return Ok(Vec::new());
        }
        let field_scope = match field_scope {
            "title" => "title",
            "title_heading" => "title_heading",
            "tag" => "tag",
            _ => "all",
        };
        let default_fields = match field_scope {
            "title" => vec![self.fields.title],
            "title_heading" => vec![self.fields.title, self.fields.heading],
            "tag" => vec![self.fields.tags],
            _ => vec![
                self.fields.title,
                self.fields.heading,
                self.fields.aliases,
                self.fields.tags,
                self.fields.body,
                self.fields.source_title,
            ],
        };
        let mut parser = QueryParser::for_index(&self.index, default_fields);
        parser.set_field_boost(self.fields.title, 8.0);
        if matches!(field_scope, "all" | "title_heading") {
            parser.set_field_boost(self.fields.heading, 4.0);
        }
        if field_scope == "all" {
            parser.set_field_boost(self.fields.aliases, 7.0);
            parser.set_field_boost(self.fields.tags, 2.8);
            parser.set_field_boost(self.fields.path, 1.5);
            parser.set_field_boost(self.fields.source_title, 6.0);
        }
        parser.set_conjunction_by_default();
        let query_is_empty = query_text.trim().is_empty();
        let parser_query = if query_is_empty { "*" } else { query_text };
        let explicit_path_query = query_text
            .trim()
            .strip_prefix("path:")
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let intent = query_intent(explicit_path_query.unwrap_or(query_text));
        let escaped_query = parser_query.replace('"', "\\\"");
        let exact_query = parser
            .parse_query(parser_query)
            .or_else(|_| parser.parse_query(&format!("\"{escaped_query}\"")))
            .map_err(|error| format!("无法解析搜索关键词：{error}"))?;
        let phrase_query = (!query_is_empty)
            .then(|| {
                explicit_path_query
                    .map(|value| value.replace('"', "\\\""))
                    .and_then(|value| parser.parse_query(&format!("path:\"{value}\"")).ok())
                    .or_else(|| parser.parse_query(&format!("\"{escaped_query}\"")).ok())
            })
            .flatten();
        let mut recall_clauses: Vec<(Occur, Box<dyn Query>)> =
            vec![(Occur::Should, Box::new(BoostQuery::new(exact_query, 4.0)))];
        if let Some(phrase_query) = phrase_query {
            recall_clauses.push((Occur::Should, Box::new(BoostQuery::new(phrase_query, 7.0))));
        }
        if intent.single_term {
            if let Some(compact) = intent.compact_ascii.as_deref() {
                if compact.len() >= 3 {
                    let distance = if compact.len() >= 7 { 2 } else { 1 };
                    for (field, boost) in [
                        (self.fields.pinyin, 3.2),
                        (self.fields.pinyin_initials, 3.0),
                    ] {
                        recall_clauses.push((
                            Occur::Should,
                            Box::new(BoostQuery::new(
                                Box::new(FuzzyTermQuery::new_prefix(
                                    Term::from_field_text(field, &compact),
                                    distance,
                                    true,
                                )),
                                boost,
                            )),
                        ));
                    }
                    let fuzzy_fields = match field_scope {
                        "title" => vec![(self.fields.title, 2.2)],
                        "tag" => vec![(self.fields.tags, 2.2)],
                        "title_heading" => {
                            vec![(self.fields.title, 2.2), (self.fields.heading, 1.8)]
                        }
                        _ => vec![
                            (self.fields.title, 2.2),
                            (self.fields.aliases, 2.1),
                            (self.fields.heading, 1.8),
                            (self.fields.tags, 1.4),
                            (self.fields.source_title, 2.0),
                            (self.fields.fuzzy_text, 1.0),
                        ],
                    };
                    for (field, boost) in fuzzy_fields {
                        recall_clauses.push((
                            Occur::Should,
                            Box::new(BoostQuery::new(
                                Box::new(FuzzyTermQuery::new_prefix(
                                    Term::from_field_text(field, &compact),
                                    distance,
                                    true,
                                )),
                                boost,
                            )),
                        ));
                    }
                }
            }
        }
        let recall_query = BooleanQuery::new(recall_clauses);
        let mut clauses: Vec<(Occur, Box<dyn Query>)> = vec![(Occur::Must, Box::new(recall_query))];
        if let Some(space_ids) = space_ids.filter(|values| !values.is_empty()) {
            clauses.push((
                Occur::Must,
                Box::new(BooleanQuery::new(
                    space_ids
                        .iter()
                        .filter(|value| !value.is_empty())
                        .map(|space_id| {
                            (
                                Occur::Should,
                                Box::new(TermQuery::new(
                                    Term::from_field_text(self.fields.space_id, space_id),
                                    IndexRecordOption::Basic,
                                )) as Box<dyn Query>,
                            )
                        })
                        .collect(),
                )),
            ));
        }
        if let Some(folder_ids) = folder_ids {
            clauses.push((
                Occur::Must,
                Box::new(TermSetQuery::new(folder_ids.iter().map(|folder_id| {
                    Term::from_field_text(self.fields.folder_id, folder_id)
                }))),
            ));
        }
        if let Some(document_ids) = document_ids {
            clauses.push((
                Occur::Must,
                Box::new(TermSetQuery::new(document_ids.iter().map(|document_id| {
                    Term::from_field_text(self.fields.document_id, document_id)
                }))),
            ));
        }
        if let Some(updated_after) = updated_after {
            clauses.push((
                Occur::Must,
                Box::new(RangeQuery::new_i64_bounds(
                    "modified_at".to_string(),
                    Bound::Included(updated_after),
                    Bound::Unbounded,
                )),
            ));
        }
        let mut allowed_types = Vec::new();
        if include_craft_pages {
            allowed_types.extend([
                "document",
                "craft_subpage",
                "markdown_section",
                "obsidian_markdown",
                "dida_task",
                "feishu_document",
                "feishu_bitable_record",
                "feishu_bitable_table",
            ]);
        }
        if include_image_ocr {
            allowed_types.push("image_ocr");
            allowed_types.push("media_attachment");
        }
        if include_pdf {
            allowed_types.push("pdf_page");
            allowed_types.push("pdf_attachment");
            if include_pdf_ocr {
                allowed_types.push("pdf_ocr");
            }
        }
        if include_attachments {
            allowed_types.push("file_attachment");
        }
        clauses.push((
            Occur::Must,
            Box::new(BooleanQuery::new(
                allowed_types
                    .into_iter()
                    .map(|content_type| {
                        (
                            Occur::Should,
                            Box::new(TermQuery::new(
                                Term::from_field_text(self.fields.content_type, content_type),
                                IndexRecordOption::Basic,
                            )) as Box<dyn Query>,
                        )
                    })
                    .collect(),
            )),
        ));
        let query = BooleanQuery::new(clauses);
        let searcher = self.reader.searcher();
        let mut window_limit = limit.saturating_mul(6).max(100);
        let mut top_docs = searcher
            .search(&query, &TopDocs::with_limit(window_limit))
            .map_err(|error| format!("Tantivy 搜索失败：{error}"))?;
        let mut grouped = Vec::<SearchHit>::new();
        let mut grouped_indices = HashMap::<String, usize>::new();
        loop {
            let inspected = top_docs.len();
            let next_after = top_docs.last().copied();
            let mut hits = Vec::new();
            for (score, address) in top_docs {
                let document: TantivyDocument = searcher
                    .doc(address)
                    .map_err(|error| format!("无法读取 Tantivy 结果：{error}"))?;
                let space_id = stored_text(&document, self.fields.space_id);
                let document_id = stored_text(&document, self.fields.document_id);
                let entity_key = stored_text(&document, self.fields.entity_key);
                let folder = stored_text(&document, self.fields.folder_id);
                let provider = stored_text(&document, self.fields.provider);
                let content_type = stored_text(&document, self.fields.content_type);
                let source_title = stored_text(&document, self.fields.source_title);
                let title = stored_text(&document, self.fields.title);
                let heading = stored_text(&document, self.fields.heading);
                let aliases = stored_text(&document, self.fields.aliases);
                let tags = stored_text(&document, self.fields.tags);
                let body = stored_text(&document, self.fields.body);
                let path = stored_text(&document, self.fields.path);
                let source_item_id = stored_text(&document, self.fields.source_item_id);
                if !source_item_id.is_empty() && field_scope != "all" {
                    continue;
                }
                let (mut match_terms, mut match_field, mut evidence_bonus) = match field_scope {
                    "title" => match_evidence(&intent, &title, "", "", "", "", "", ""),
                    "title_heading" => {
                        match_evidence(&intent, &title, &heading, "", "", "", "", "")
                    }
                    "tag" => match_evidence(&intent, "", "", "", "", &tags, "", ""),
                    _ => match_evidence(
                        &intent,
                        &title,
                        &heading,
                        &source_title,
                        &aliases,
                        &tags,
                        &body,
                        &path,
                    ),
                };
                let path_only_match = match_field
                    .split(',')
                    .map(str::trim)
                    .filter(|field| !field.is_empty())
                    .all(|field| field == "path");
                if !query_is_empty
                    && field_scope == "all"
                    && explicit_path_query.is_none()
                    && path_only_match
                {
                    continue;
                }
                if !source_item_id.is_empty()
                    && match_field.split(',').any(|field| field == "title")
                {
                    let attachment_evidence =
                        match_evidence(&intent, "", &heading, &source_title, "", "", &body, "");
                    if attachment_evidence.2 <= 0.0 {
                        continue;
                    }
                    (match_terms, match_field, evidence_bonus) = attachment_evidence;
                }
                if !query_is_empty && field_scope != "all" && evidence_bonus <= 0.0 {
                    continue;
                }
                hits.push(SearchHit {
                    provider,
                    item_id: stored_text(&document, self.fields.item_id),
                    entity_key,
                    space_id,
                    document_id,
                    block_id: stored_text(&document, self.fields.block_id),
                    content_type: content_type.clone(),
                    source_item_id,
                    source_title,
                    page_number: document
                        .get_first(self.fields.page_number)
                        .and_then(|value| value.as_i64())
                        .filter(|value| *value > 0),
                    title,
                    heading,
                    body,
                    path,
                    folder_id: (!folder.is_empty()).then_some(folder),
                    modified_at: document
                        .get_first(self.fields.modified_at)
                        .and_then(|value| value.as_i64()),
                    score: score
                        * match content_type.as_str() {
                            "document"
                            | "craft_subpage"
                            | "markdown_section"
                            | "obsidian_markdown"
                            | "dida_task"
                            | "feishu_document"
                            | "feishu_bitable_record"
                            | "feishu_bitable_table" => 1.0,
                            "pdf_page" => 0.88,
                            "pdf_ocr" => 0.72,
                            "image_ocr" => 0.68,
                            _ => 0.9,
                        }
                        + evidence_bonus,
                    match_terms,
                    match_field,
                    match_count: 0,
                    sub_hits: Vec::new(),
                });
            }
            hits.sort_by(|left, right| {
                right
                    .score
                    .total_cmp(&left.score)
                    .then_with(|| right.modified_at.cmp(&left.modified_at))
            });
            for mut hit in hits {
                let sub_hit = SearchSubHit {
                    item_id: hit.item_id.clone(),
                    block_id: hit.block_id.clone(),
                    content_type: hit.content_type.clone(),
                    source_item_id: hit.source_item_id.clone(),
                    source_title: hit.source_title.clone(),
                    page_number: hit.page_number,
                    heading: hit.heading.clone(),
                    body: hit.body.clone(),
                    match_terms: hit.match_terms.clone(),
                    match_field: hit.match_field.clone(),
                };
                if let Some(index) = grouped_indices.get(&hit.entity_key).copied() {
                    let primary = &mut grouped[index];
                    primary.match_count += 1;
                    if primary.sub_hits.len() < 5
                        && !primary
                            .sub_hits
                            .iter()
                            .any(|existing| existing.item_id == sub_hit.item_id)
                    {
                        primary.sub_hits.push(sub_hit);
                    }
                    continue;
                }
                if grouped.len() == limit {
                    continue;
                }
                hit.match_count = 1;
                hit.sub_hits.push(sub_hit);
                grouped_indices.insert(hit.entity_key.clone(), grouped.len());
                grouped.push(hit);
            }
            if grouped.len() == limit || inspected < window_limit {
                break;
            }
            let Some(after) = next_after else {
                break;
            };
            // The original candidate window and reranking stay intact. Only
            // underfilled results receive another bounded window, excluding
            // entities already accepted. Rejected rows still advance the raw
            // score/address cursor, so they cannot block a later valid chunk.
            let remaining_query = BooleanQuery::new(vec![
                (Occur::Must, Box::new(query.clone())),
                (
                    Occur::MustNot,
                    Box::new(TermSetQuery::new(
                        grouped_indices
                            .keys()
                            .map(|key| Term::from_field_text(self.fields.entity_key, key)),
                    )),
                ),
            ]);
            window_limit = 128;
            top_docs = searcher
                .search(
                    &remaining_query,
                    &TopDocsAfter {
                        inner: TopDocs::with_limit(window_limit),
                        after,
                    },
                )
                .map_err(|error| format!("Tantivy 补充搜索失败：{error}"))?;
        }
        grouped.sort_by(|left, right| {
            right
                .score
                .total_cmp(&left.score)
                .then_with(|| right.modified_at.cmp(&left.modified_at))
        });
        Ok(grouped)
    }
}

fn stored_text(document: &TantivyDocument, field: Field) -> String {
    document
        .get_first(field)
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn grouped_search_recalls_distinct_documents_after_repeated_chunks_fill_the_first_window() {
        let path =
            std::env::temp_dir().join(format!("hub-entity-recall-{}", crate::random_url_safe(10)));
        let index = SearchIndex::open(&path).unwrap();
        let mut records = Vec::new();
        for number in 0..480 {
            let mut value = record(
                &format!("dominant-{number}"),
                "document:dominant",
                "markdown_section",
            );
            value.heading = "same heading".into();
            value.body = "recallcrowding".into();
            records.push(value);
        }
        for number in 0..12 {
            let mut value = record(
                &format!("other-{number}"),
                &format!("document:other-{number}"),
                "markdown_section",
            );
            value.heading = "same heading".into();
            value.body = "recallcrowding".into();
            value.modified_at = number + 2;
            records.push(value);
        }
        index.apply_changes(&[], &records).unwrap();
        let hits = index
            .search(
                "recallcrowding",
                20,
                None,
                None,
                None,
                true,
                false,
                false,
                false,
            )
            .unwrap();
        assert_eq!(
            hits.len(),
            13,
            "chunk candidate capacity must not truncate entity recall"
        );
        assert_eq!(
            hits.iter()
                .map(|hit| &hit.entity_key)
                .collect::<HashSet<_>>()
                .len(),
            13
        );
        let dominant = hits
            .iter()
            .find(|hit| hit.entity_key == "document:dominant")
            .unwrap();
        assert_eq!(
            dominant.match_count, 120,
            "retain the original first-window match count"
        );
        assert_eq!(dominant.sub_hits.len(), 5);
        assert_eq!(
            hits.last().unwrap().entity_key,
            "document:dominant",
            "new entities retain adjusted score and modified-at ordering"
        );
        assert!(hits.windows(2).all(|pair| pair[0].score >= pair[1].score));
        drop(index);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn grouped_search_advances_past_rejected_windows_without_excluding_later_valid_chunks() {
        let path = std::env::temp_dir().join(format!(
            "hub-filtered-recall-{}",
            crate::random_url_safe(10)
        ));
        let index = SearchIndex::open(&path).unwrap();
        let mut records = Vec::new();
        for number in 0..400 {
            let mut value = record(
                &format!("rejected-{number}"),
                "document:later-valid",
                "pdf_page",
            );
            value.title = "recallblocked".into();
            value.heading = "same heading".into();
            value.source_item_id = "attachment-source".into();
            value.folder_id = "kept-folder".into();
            value.modified_at = 100;
            records.push(value);
        }
        let mut valid = records[0].clone();
        valid.item_id = "valid-final-chunk".into();
        valid.source_item_id.clear();
        records.push(valid);
        for (space, folder, modified) in [
            ("other-space", "kept-folder", 100),
            ("space", "other-folder", 100),
            ("space", "kept-folder", 20),
        ] {
            let mut outside = records.last().unwrap().clone();
            outside.item_id = format!("outside-{space}-{folder}-{modified}");
            outside.entity_key = outside.item_id.clone();
            outside.space_id = space.into();
            outside.folder_id = folder.into();
            outside.modified_at = modified;
            records.push(outside);
        }
        index.apply_changes(&[], &records).unwrap();
        let hits = index
            .search_with_field_scope(
                "recallblocked",
                10,
                Some("space"),
                Some("kept-folder"),
                Some(50),
                false,
                false,
                true,
                false,
                false,
                "title",
            )
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].item_id, "valid-final-chunk");
        assert_eq!(hits[0].entity_key, "document:later-valid");
        assert_eq!(hits[0].match_count, 1);
        assert_eq!(hits[0].sub_hits.len(), 1);
        drop(index);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn supplemental_cursor_preserves_equal_scores_addresses_and_exclusion_scores() {
        let path =
            std::env::temp_dir().join(format!("hub-cursor-recall-{}", crate::random_url_safe(10)));
        let index = SearchIndex::open(&path).unwrap();
        for batch in 0..3 {
            let records = (0..100)
                .map(|number| {
                    let mut value = record(
                        &format!("cursor-{batch}-{number}"),
                        if number % 3 == 0 {
                            "document:excluded"
                        } else {
                            "document:kept"
                        },
                        "markdown_section",
                    );
                    value.document_key = format!("space:cursor-{batch}");
                    value.title = "cursorwitness".into();
                    value.heading = "same heading".into();
                    value.body = "identical body".into();
                    value
                })
                .collect::<Vec<_>>();
            index.apply_changes(&[], &records).unwrap();
        }
        let searcher = index.reader.searcher();
        assert!(
            searcher.segment_readers().len() >= 2,
            "cursor fixture must retain cross-segment equal-score addresses"
        );
        let query = QueryParser::for_index(&index.index, vec![index.fields.title])
            .parse_query("cursorwitness")
            .unwrap();
        let all = searcher.search(&query, &TopDocs::with_limit(300)).unwrap();
        assert_eq!(all.len(), 300);
        assert!(all
            .windows(2)
            .all(|pair| pair[0].0 == pair[1].0 && pair[0].1 < pair[1].1));
        let after = all[99];
        let remaining = BooleanQuery::new(vec![
            (Occur::Must, query.box_clone()),
            (
                Occur::MustNot,
                Box::new(TermSetQuery::new([Term::from_field_text(
                    index.fields.entity_key,
                    "document:excluded",
                )])),
            ),
        ]);
        let expected = all
            .iter()
            .copied()
            .filter(|(_, address)| {
                *address > after.1
                    && stored_text(
                        &searcher.doc::<TantivyDocument>(*address).unwrap(),
                        index.fields.entity_key,
                    ) != "document:excluded"
            })
            .collect::<Vec<_>>();
        let mut cursor = after;
        let mut observed = Vec::new();
        loop {
            let window = searcher
                .search(
                    &remaining,
                    &TopDocsAfter {
                        inner: TopDocs::with_limit(37),
                        after: cursor,
                    },
                )
                .unwrap();
            assert!(window.len() <= 37);
            let Some(next) = window.last().copied() else {
                break;
            };
            cursor = next;
            observed.extend(window);
        }
        assert!(!expected.is_empty());
        assert_eq!(observed, expected, "MustNot preserves scores and cursor paging must keep every equal-score address exactly once");
        assert!(searcher
            .search(
                &query,
                &TopDocsAfter {
                    inner: TopDocs::with_limit(37),
                    after: (f32::NAN, after.1)
                }
            )
            .is_err());
        drop(searcher);
        drop(index);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn index_writer_is_shared_between_batches_and_failed_changes_are_discarded() {
        let path =
            std::env::temp_dir().join(format!("hub-index-writer-{}", crate::random_url_safe(10)));
        let index = SearchIndex::open(&path).unwrap();
        let first = record("first", "document:first", "markdown_section");
        index.apply_changes(&[], &[first]).unwrap();
        let clone = index.clone();
        let mut second = record("second", "document:second", "markdown_section");
        second.document_key = "space:second".into();
        clone.apply_changes(&[], &[second]).unwrap();
        assert_eq!(
            index
                .writer_creations
                .load(std::sync::atomic::Ordering::Relaxed),
            1
        );
        assert_eq!(index.num_docs(), 2);

        let mut discarded = record("discarded", "document:discarded", "markdown_section");
        discarded.document_key = "space:discarded".into();
        assert!(clone
            .with_writer(|writer| {
                add_index_document(writer, &index.fields, &discarded)?;
                Err("injected before commit".into())
            })
            .is_err());
        assert!(index.writer.lock().unwrap().is_none());
        let mut third = record("third", "document:third", "markdown_section");
        third.document_key = "space:third".into();
        index.apply_changes(&[], &[third]).unwrap();
        assert_eq!(
            index
                .writer_creations
                .load(std::sync::atomic::Ordering::Relaxed),
            2
        );
        assert_eq!(
            index.num_docs(),
            3,
            "the failed batch must not leak into the next commit"
        );
        let hits = index
            .search(
                "shared-search-token",
                10,
                None,
                None,
                None,
                true,
                true,
                true,
                true,
            )
            .unwrap();
        assert_eq!(hits.len(), 3);
        assert!(!hits
            .iter()
            .any(|hit| hit.entity_key == "document:discarded"));
        drop(clone);
        drop(index);
        let _ = std::fs::remove_dir_all(path);
    }

    fn record(item_id: &str, entity_key: &str, content_type: &str) -> IndexRecord {
        IndexRecord {
            provider: "craft".to_string(),
            item_id: item_id.to_string(),
            document_key: "space:document".to_string(),
            entity_key: entity_key.to_string(),
            space_id: "space".to_string(),
            document_id: "document".to_string(),
            block_id: "document".to_string(),
            content_type: content_type.to_string(),
            source_item_id: String::new(),
            source_title: String::new(),
            page_number: 0,
            title: "测试页面".to_string(),
            heading: item_id.to_string(),
            aliases: String::new(),
            tags: String::new(),
            body: "shared-search-token".to_string(),
            path: "测试".to_string(),
            folder_id: String::new(),
            modified_at: 1,
        }
    }

    #[derive(Clone, Copy)]
    struct QualityCase {
        name: &'static str,
        query: &'static str,
        expected_entity: &'static str,
        max_rank: usize,
        expected_field: Option<&'static str>,
        expected_type: Option<&'static str>,
        expected_page: Option<i64>,
        space_id: Option<&'static str>,
        include_pages: bool,
        include_image_ocr: bool,
        include_pdf: bool,
        include_pdf_ocr: bool,
    }

    #[derive(Clone, Copy)]
    struct AdvancedQualityCase {
        name: &'static str,
        query: &'static str,
        limit: usize,
        space_id: Option<&'static str>,
        folder_id: Option<&'static str>,
        updated_after: Option<i64>,
        include_pages: bool,
        include_image_ocr: bool,
        include_pdf: bool,
        include_pdf_ocr: bool,
        expected_count: Option<usize>,
        expected_entity: Option<&'static str>,
        max_rank: usize,
        expected_field: Option<&'static str>,
        expected_type: Option<&'static str>,
        expected_page: Option<i64>,
    }

    impl AdvancedQualityCase {
        fn new(name: &'static str, query: &'static str) -> Self {
            Self {
                name,
                query,
                limit: 10,
                space_id: None,
                folder_id: None,
                updated_after: None,
                include_pages: true,
                include_image_ocr: true,
                include_pdf: true,
                include_pdf_ocr: true,
                expected_count: None,
                expected_entity: None,
                max_rank: 1,
                expected_field: None,
                expected_type: None,
                expected_page: None,
            }
        }

        fn space(mut self, space_id: &'static str) -> Self {
            self.space_id = Some(space_id);
            self
        }

        fn folder(mut self, folder_id: &'static str) -> Self {
            self.folder_id = Some(folder_id);
            self
        }

        fn modified_after(mut self, timestamp: i64) -> Self {
            self.updated_after = Some(timestamp);
            self
        }

        fn sources(mut self, pages: bool, image_ocr: bool, pdf: bool, pdf_ocr: bool) -> Self {
            self.include_pages = pages;
            self.include_image_ocr = image_ocr;
            self.include_pdf = pdf;
            self.include_pdf_ocr = pdf_ocr;
            self
        }

        fn limit(mut self, limit: usize) -> Self {
            self.limit = limit;
            self
        }

        fn count(mut self, count: usize) -> Self {
            self.expected_count = Some(count);
            self
        }

        fn entity(mut self, entity: &'static str, max_rank: usize) -> Self {
            self.expected_entity = Some(entity);
            self.max_rank = max_rank;
            self
        }

        fn field(mut self, field: &'static str) -> Self {
            self.expected_field = Some(field);
            self
        }

        fn content_type(mut self, content_type: &'static str) -> Self {
            self.expected_type = Some(content_type);
            self
        }

        fn page(mut self, page: i64) -> Self {
            self.expected_page = Some(page);
            self
        }
    }

    fn quality_record(
        item_id: &str,
        provider: &str,
        space_id: &str,
        entity_key: &str,
        content_type: &str,
        title: &str,
        heading: &str,
        body: &str,
        path: &str,
    ) -> IndexRecord {
        let mut value = record(item_id, entity_key, content_type);
        value.provider = provider.to_string();
        value.space_id = space_id.to_string();
        value.document_id = format!("document-{item_id}");
        value.block_id = value.document_id.clone();
        value.title = title.to_string();
        value.heading = heading.to_string();
        value.body = body.to_string();
        value.path = path.to_string();
        value.modified_at = 100;
        value
    }

    fn search_quality_fixture() -> Vec<IndexRecord> {
        let mut records = vec![
            quality_record(
                "craft-title",
                "craft",
                "craft-main",
                "document:craft-title",
                "markdown_section",
                "星河搜索蓝图",
                "性能优化",
                "蓝鲸引擎支持离线索引和灯塔导航。The performance handbook is ready.",
                "项目/搜索验收-20260726",
            ),
            quality_record(
                "craft-body",
                "craft",
                "craft-main",
                "document:craft-body",
                "markdown_section",
                "普通资料页面",
                "日常记录",
                "星河搜索蓝图在正文重复出现。星河搜索蓝图用于排序对照。",
                "项目/普通资料",
            ),
            quality_record(
                "craft-partial",
                "craft",
                "craft-main",
                "document:craft-partial",
                "markdown_section",
                "星河资料",
                "普通章节",
                "这里只包含蓝鲸离线索引，不包含另一个 AND 测试词。",
                "项目/搜索验收",
            ),
            quality_record(
                "craft-or",
                "craft",
                "craft-main",
                "document:craft-or",
                "markdown_section",
                "性能资料",
                "单独测试",
                "用于显式 OR 查询的独立页面。",
                "项目/普通资料",
            ),
            quality_record(
                "craft-phrase-gap",
                "craft",
                "craft-main",
                "document:craft-phrase-gap",
                "markdown_section",
                "短语干扰项",
                "语法测试",
                "蓝鲸高速引擎中间存在其他词。",
                "项目/测试",
            ),
            quality_record(
                "obsidian-title",
                "obsidian",
                "obsidian-main",
                "document:obsidian-title",
                "obsidian_markdown",
                "北辰知识地图",
                "双链设计",
                "北辰知识地图的简短说明，正文包含海图坐标。",
                "Craft Search 验收/北辰知识地图.md",
            ),
            quality_record(
                "obsidian-body",
                "obsidian",
                "obsidian-main",
                "document:obsidian-body",
                "obsidian_markdown",
                "普通 Obsidian 笔记",
                "资料整理",
                "北辰知识地图 北辰知识地图 北辰知识地图只在正文中出现。",
                "Areas/资料整理.md",
            ),
            quality_record(
                "cross-craft-exact",
                "craft",
                "craft-main",
                "document:cross-craft-exact",
                "markdown_section",
                "跨库精确标题",
                "Craft 页面",
                "简短正文。",
                "项目/跨库",
            ),
            quality_record(
                "cross-obsidian-body",
                "obsidian",
                "obsidian-main",
                "document:cross-obsidian-body",
                "obsidian_markdown",
                "跨库普通笔记",
                "Obsidian 页面",
                "跨库精确标题在正文中重复三次：跨库精确标题，跨库精确标题。",
                "Areas/跨库.md",
            ),
        ];
        let mut pdf_native = quality_record(
            "pdf-native",
            "craft",
            "craft-main",
            "attachment:pdf-native",
            "pdf_page",
            "PDF 附件页面",
            "",
            "青铜罗盘 PDF 原生文字。",
            "项目/搜索验收",
        );
        pdf_native.source_item_id = "attachment-pdf-native".to_string();
        pdf_native.source_title = "检索验收-青铜罗盘.pdf".to_string();
        pdf_native.page_number = 2;
        records.push(pdf_native);
        let mut pdf_ocr = quality_record(
            "pdf-ocr",
            "craft",
            "craft-main",
            "attachment:pdf-ocr",
            "pdf_ocr",
            "扫描资料",
            "",
            "云帆灯塔 OCR PDF 726。",
            "项目/搜索验收",
        );
        pdf_ocr.source_item_id = "attachment-pdf-ocr".to_string();
        pdf_ocr.source_title = "扫描验收-云帆灯塔.pdf".to_string();
        pdf_ocr.page_number = 4;
        records.push(pdf_ocr);
        let mut image_ocr = quality_record(
            "image-ocr",
            "craft",
            "craft-main",
            "attachment:image-ocr",
            "image_ocr",
            "图片资料",
            "",
            "海盐星球 IMAGE OCR 726。",
            "项目/搜索验收",
        );
        image_ocr.source_item_id = "attachment-image-ocr".to_string();
        image_ocr.source_title = "图片验收-海盐星球.png".to_string();
        records.push(image_ocr);

        records.extend([
            quality_record(
                "space-craft",
                "craft",
                "craft-main",
                "document:space-craft",
                "markdown_section",
                "Craft 空间记录",
                "过滤测试",
                "空间过滤稀有词。",
                "项目/过滤",
            ),
            quality_record(
                "space-obsidian",
                "obsidian",
                "obsidian-main",
                "document:space-obsidian",
                "obsidian_markdown",
                "Obsidian 空间记录",
                "过滤测试",
                "空间过滤稀有词。",
                "Areas/过滤.md",
            ),
            quality_record(
                "multi-field",
                "craft",
                "craft-main",
                "document:multi-field",
                "markdown_section",
                "晨曦计划",
                "导航",
                "远航灯塔用于跨字段命中。",
                "项目/跨字段",
            ),
            quality_record(
                "heading-rank",
                "craft",
                "craft-main",
                "document:heading-rank",
                "markdown_section",
                "技术手册",
                "架构评审稀有词",
                "简短说明。",
                "项目/架构",
            ),
            quality_record(
                "heading-body-rank",
                "craft",
                "craft-main",
                "document:heading-body-rank",
                "markdown_section",
                "普通记录",
                "正文对照",
                "架构评审稀有词在正文重复：架构评审稀有词。",
                "项目/架构",
            ),
            quality_record(
                "weight-page",
                "craft",
                "craft-main",
                "document:weight-page",
                "markdown_section",
                "页面权重记录",
                "权重测试",
                "页面优先稀有词。",
                "项目/权重",
            ),
            quality_record(
                "aggregate-a",
                "craft",
                "craft-main",
                "document:aggregate",
                "markdown_section",
                "聚合页面",
                "第一章节",
                "实体聚合稀有词。",
                "项目/聚合",
            ),
            quality_record(
                "aggregate-b",
                "craft",
                "craft-main",
                "document:aggregate",
                "markdown_section",
                "聚合页面",
                "第二章节",
                "实体聚合稀有词。",
                "项目/聚合",
            ),
            quality_record(
                "limit-a",
                "craft",
                "craft-main",
                "document:limit-a",
                "markdown_section",
                "限制结果甲",
                "数量测试",
                "共同限制稀有词。",
                "项目/限制",
            ),
            quality_record(
                "limit-b",
                "obsidian",
                "obsidian-main",
                "document:limit-b",
                "obsidian_markdown",
                "限制结果乙",
                "数量测试",
                "共同限制稀有词。",
                "Areas/限制.md",
            ),
        ]);
        let mut folder_a = quality_record(
            "folder-a",
            "craft",
            "craft-main",
            "document:folder-a",
            "markdown_section",
            "文件夹甲",
            "过滤测试",
            "文件夹过滤稀有词。",
            "项目/文件夹甲",
        );
        folder_a.folder_id = "folder-a".to_string();
        records.push(folder_a);
        let mut folder_b = quality_record(
            "folder-b",
            "craft",
            "craft-main",
            "document:folder-b",
            "markdown_section",
            "文件夹乙",
            "过滤测试",
            "文件夹过滤稀有词。",
            "项目/文件夹乙",
        );
        folder_b.folder_id = "folder-b".to_string();
        records.push(folder_b);
        let mut date_old = quality_record(
            "date-old",
            "craft",
            "craft-main",
            "document:date-old",
            "markdown_section",
            "旧时间记录",
            "时间测试",
            "时间过滤稀有词。",
            "项目/时间",
        );
        date_old.modified_at = 100;
        records.push(date_old);
        let mut date_new = quality_record(
            "date-new",
            "craft",
            "craft-main",
            "document:date-new",
            "markdown_section",
            "新时间记录",
            "时间测试",
            "时间过滤稀有词。",
            "项目/时间",
        );
        date_new.modified_at = 900;
        records.push(date_new);

        for (item_id, entity_key, content_type, body) in [
            (
                "weight-native",
                "attachment:weight-native",
                "pdf_page",
                "分层权重稀有词。",
            ),
            (
                "weight-ocr",
                "attachment:weight-ocr",
                "pdf_ocr",
                "分层权重稀有词。",
            ),
            (
                "weight-pdf-ocr",
                "attachment:weight-pdf-ocr",
                "pdf_ocr",
                "识别层级稀有词。",
            ),
            (
                "weight-image-ocr",
                "attachment:weight-image-ocr",
                "image_ocr",
                "识别层级稀有词。",
            ),
            (
                "weight-pdf-page",
                "attachment:weight-pdf-page",
                "pdf_page",
                "页面优先稀有词。",
            ),
        ] {
            let mut attachment = quality_record(
                item_id,
                "craft",
                "craft-main",
                entity_key,
                content_type,
                "附件权重记录",
                "",
                body,
                "项目/权重",
            );
            attachment.source_item_id = item_id.to_string();
            records.push(attachment);
        }
        let mut filename = quality_record(
            "filename",
            "craft",
            "craft-main",
            "attachment:filename",
            "pdf_page",
            "附件页面",
            "",
            "正文不包含目标名称。",
            "项目/附件",
        );
        filename.source_item_id = "attachment-filename".to_string();
        filename.source_title = "附件名称稀有词.pdf".to_string();
        filename.page_number = 1;
        records.push(filename);
        records
    }

    #[test]
    fn search_quality_evaluation_suite() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "craft-search-evaluation-{}-{nonce}",
            std::process::id()
        ));
        let index = SearchIndex::open(&directory).unwrap();
        index.rebuild(&search_quality_fixture()).unwrap();

        let cases = [
            QualityCase {
                name: "exact-title",
                query: "星河搜索蓝图",
                expected_entity: "document:craft-title",
                max_rank: 1,
                expected_field: Some("title"),
                expected_type: Some("markdown_section"),
                expected_page: None,
                space_id: None,
                include_pages: true,
                include_image_ocr: true,
                include_pdf: true,
                include_pdf_ocr: true,
            },
            QualityCase {
                name: "heading",
                query: "性能优化",
                expected_entity: "document:craft-title",
                max_rank: 1,
                expected_field: Some("heading"),
                expected_type: None,
                expected_page: None,
                space_id: None,
                include_pages: true,
                include_image_ocr: true,
                include_pdf: true,
                include_pdf_ocr: true,
            },
            QualityCase {
                name: "body",
                query: "灯塔导航",
                expected_entity: "document:craft-title",
                max_rank: 1,
                expected_field: Some("body"),
                expected_type: None,
                expected_page: None,
                space_id: None,
                include_pages: true,
                include_image_ocr: true,
                include_pdf: true,
                include_pdf_ocr: true,
            },
            QualityCase {
                name: "path",
                query: "path:搜索验收",
                expected_entity: "document:craft-partial",
                max_rank: 1,
                expected_field: Some("path"),
                expected_type: None,
                expected_page: None,
                space_id: None,
                include_pages: true,
                include_image_ocr: false,
                include_pdf: false,
                include_pdf_ocr: false,
            },
            QualityCase {
                name: "and",
                query: "星河 性能",
                expected_entity: "document:craft-title",
                max_rank: 1,
                expected_field: Some("title,heading"),
                expected_type: None,
                expected_page: None,
                space_id: None,
                include_pages: true,
                include_image_ocr: true,
                include_pdf: true,
                include_pdf_ocr: true,
            },
            QualityCase {
                name: "or-first",
                query: "星河 OR 性能",
                expected_entity: "document:craft-title",
                max_rank: 1,
                expected_field: None,
                expected_type: None,
                expected_page: None,
                space_id: None,
                include_pages: true,
                include_image_ocr: true,
                include_pdf: true,
                include_pdf_ocr: true,
            },
            QualityCase {
                name: "or-recall",
                query: "星河 OR 性能",
                expected_entity: "document:craft-or",
                max_rank: 3,
                expected_field: None,
                expected_type: None,
                expected_page: None,
                space_id: None,
                include_pages: true,
                include_image_ocr: true,
                include_pdf: true,
                include_pdf_ocr: true,
            },
            QualityCase {
                name: "phrase",
                query: "\"蓝鲸引擎\"",
                expected_entity: "document:craft-title",
                max_rank: 1,
                expected_field: Some("body"),
                expected_type: None,
                expected_page: None,
                space_id: None,
                include_pages: true,
                include_image_ocr: true,
                include_pdf: true,
                include_pdf_ocr: true,
            },
            QualityCase {
                name: "pinyin",
                query: "xinghesousuolantu",
                expected_entity: "document:craft-title",
                max_rank: 1,
                expected_field: Some("title"),
                expected_type: None,
                expected_page: None,
                space_id: None,
                include_pages: true,
                include_image_ocr: true,
                include_pdf: true,
                include_pdf_ocr: true,
            },
            QualityCase {
                name: "initials",
                query: "xhsslt",
                expected_entity: "document:craft-title",
                max_rank: 1,
                expected_field: Some("title"),
                expected_type: None,
                expected_page: None,
                space_id: None,
                include_pages: true,
                include_image_ocr: true,
                include_pdf: true,
                include_pdf_ocr: true,
            },
            QualityCase {
                name: "typo",
                query: "performnce",
                expected_entity: "document:craft-title",
                max_rank: 1,
                expected_field: Some("body"),
                expected_type: None,
                expected_page: None,
                space_id: None,
                include_pages: true,
                include_image_ocr: true,
                include_pdf: true,
                include_pdf_ocr: true,
            },
            QualityCase {
                name: "pdf-native",
                query: "青铜罗盘",
                expected_entity: "attachment:pdf-native",
                max_rank: 1,
                expected_field: Some("attachment,body"),
                expected_type: Some("pdf_page"),
                expected_page: Some(2),
                space_id: None,
                include_pages: true,
                include_image_ocr: true,
                include_pdf: true,
                include_pdf_ocr: true,
            },
            QualityCase {
                name: "pdf-ocr",
                query: "云帆灯塔",
                expected_entity: "attachment:pdf-ocr",
                max_rank: 1,
                expected_field: Some("attachment,body"),
                expected_type: Some("pdf_ocr"),
                expected_page: Some(4),
                space_id: None,
                include_pages: true,
                include_image_ocr: true,
                include_pdf: true,
                include_pdf_ocr: true,
            },
            QualityCase {
                name: "image-ocr",
                query: "海盐星球",
                expected_entity: "attachment:image-ocr",
                max_rank: 1,
                expected_field: Some("attachment,body"),
                expected_type: Some("image_ocr"),
                expected_page: None,
                space_id: None,
                include_pages: true,
                include_image_ocr: true,
                include_pdf: true,
                include_pdf_ocr: true,
            },
            QualityCase {
                name: "cross-library-title",
                query: "跨库精确标题",
                expected_entity: "document:cross-craft-exact",
                max_rank: 1,
                expected_field: Some("title"),
                expected_type: None,
                expected_page: None,
                space_id: None,
                include_pages: true,
                include_image_ocr: true,
                include_pdf: true,
                include_pdf_ocr: true,
            },
            QualityCase {
                name: "obsidian-title",
                query: "北辰知识地图",
                expected_entity: "document:obsidian-title",
                max_rank: 1,
                expected_field: Some("title,body,path"),
                expected_type: Some("obsidian_markdown"),
                expected_page: None,
                space_id: Some("obsidian-main"),
                include_pages: true,
                include_image_ocr: false,
                include_pdf: false,
                include_pdf_ocr: false,
            },
            QualityCase {
                name: "obsidian-path",
                query: "path:Craft Search 验收",
                expected_entity: "document:obsidian-title",
                max_rank: 1,
                expected_field: Some("path"),
                expected_type: None,
                expected_page: None,
                space_id: Some("obsidian-main"),
                include_pages: true,
                include_image_ocr: false,
                include_pdf: false,
                include_pdf_ocr: false,
            },
        ];

        let mut failures = Vec::new();
        let mut durations = Vec::new();
        let mut primary_reciprocal_rank = 0.0_f64;
        let mut top_one = 0_usize;
        let mut recalled_at_three = 0_usize;
        let mut ranked_case_count = cases.len();
        let mut primary_ranked_case_count = cases.iter().filter(|case| case.max_rank == 1).count();
        for case in cases {
            let started = Instant::now();
            let hits = index
                .search(
                    case.query,
                    10,
                    case.space_id,
                    None,
                    None,
                    case.include_pages,
                    case.include_image_ocr,
                    case.include_pdf,
                    case.include_pdf_ocr,
                )
                .unwrap_or_else(|error| {
                    failures.push(format!("{}: query failed: {error}", case.name));
                    Vec::new()
                });
            durations.push(started.elapsed());
            let rank = hits
                .iter()
                .position(|hit| hit.entity_key == case.expected_entity)
                .map(|index| index + 1);
            if std::env::var_os("CRAFT_SEARCH_EVAL_DETAILS").is_some() && rank != Some(1) {
                eprintln!(
                    "evaluation detail: {} expected {} at {:?}; actual {:?}",
                    case.name,
                    case.expected_entity,
                    rank,
                    hits.iter()
                        .take(5)
                        .map(|hit| (hit.entity_key.as_str(), hit.score, hit.match_field.as_str()))
                        .collect::<Vec<_>>()
                );
            }
            if rank.is_some_and(|value| value <= 3) {
                recalled_at_three += 1;
            }
            if case.max_rank == 1 {
                if rank == Some(1) {
                    top_one += 1;
                }
                if let Some(rank) = rank {
                    primary_reciprocal_rank += 1.0 / rank as f64;
                }
            }
            let Some(rank) = rank else {
                failures.push(format!(
                    "{}: expected {} but got {:?}",
                    case.name,
                    case.expected_entity,
                    hits.iter()
                        .map(|hit| hit.entity_key.as_str())
                        .collect::<Vec<_>>()
                ));
                continue;
            };
            if rank > case.max_rank {
                failures.push(format!(
                    "{}: expected {} in top {}, actual rank {}",
                    case.name, case.expected_entity, case.max_rank, rank
                ));
            }
            let hit = &hits[rank - 1];
            if case
                .expected_field
                .is_some_and(|field| hit.match_field != field)
            {
                failures.push(format!(
                    "{}: expected field {:?}, got {}",
                    case.name, case.expected_field, hit.match_field
                ));
            }
            if case
                .expected_type
                .is_some_and(|kind| hit.content_type != kind)
            {
                failures.push(format!(
                    "{}: expected type {:?}, got {}",
                    case.name, case.expected_type, hit.content_type
                ));
            }
            if case
                .expected_page
                .is_some_and(|page| hit.page_number != Some(page))
            {
                failures.push(format!(
                    "{}: expected page {:?}, got {:?}",
                    case.name, case.expected_page, hit.page_number
                ));
            }
        }

        let advanced_cases = [
            AdvancedQualityCase::new("numeric-path", "path:20260726")
                .entity("document:craft-title", 1)
                .field("path"),
            AdvancedQualityCase::new("craft-space-filter", "空间过滤稀有词")
                .space("craft-main")
                .count(1)
                .entity("document:space-craft", 1),
            AdvancedQualityCase::new("obsidian-space-filter", "空间过滤稀有词")
                .space("obsidian-main")
                .count(1)
                .entity("document:space-obsidian", 1),
            AdvancedQualityCase::new("missing-space-filter", "空间过滤稀有词")
                .space("missing-space")
                .count(0),
            AdvancedQualityCase::new("folder-filter", "文件夹过滤稀有词")
                .space("craft-main")
                .folder("folder-a")
                .count(1)
                .entity("document:folder-a", 1),
            AdvancedQualityCase::new("missing-folder-filter", "文件夹过滤稀有词")
                .space("craft-main")
                .folder("missing-folder")
                .count(0),
            AdvancedQualityCase::new("modified-after-filter", "时间过滤稀有词")
                .space("craft-main")
                .modified_after(500)
                .count(1)
                .entity("document:date-new", 1),
            AdvancedQualityCase::new("too-new-filter", "时间过滤稀有词")
                .space("craft-main")
                .modified_after(1_000)
                .count(0),
            AdvancedQualityCase::new("cross-field-match", "晨曦 远航")
                .entity("document:multi-field", 1)
                .field("title,body"),
            AdvancedQualityCase::new("heading-over-body", "架构评审稀有词")
                .entity("document:heading-rank", 1)
                .field("heading"),
            AdvancedQualityCase::new("native-pdf-over-pdf-ocr", "分层权重稀有词")
                .entity("attachment:weight-native", 1)
                .content_type("pdf_page"),
            AdvancedQualityCase::new("pdf-ocr-over-image-ocr", "识别层级稀有词")
                .entity("attachment:weight-pdf-ocr", 1)
                .content_type("pdf_ocr"),
            AdvancedQualityCase::new("page-over-pdf", "页面优先稀有词")
                .entity("document:weight-page", 1)
                .content_type("markdown_section"),
            AdvancedQualityCase::new("entity-aggregation", "实体聚合稀有词")
                .count(1)
                .entity("document:aggregate", 1),
            AdvancedQualityCase::new("result-limit", "共同限制稀有词")
                .limit(1)
                .count(1),
            AdvancedQualityCase::new("all-sources-disabled", "空间过滤稀有词")
                .sources(false, false, false, false)
                .count(0),
            AdvancedQualityCase::new("pages-disabled", "北辰知识地图")
                .sources(false, true, true, true)
                .count(0),
            AdvancedQualityCase::new("pdf-disabled", "青铜罗盘")
                .sources(true, true, false, false)
                .count(0),
            AdvancedQualityCase::new("pdf-ocr-disabled", "云帆灯塔")
                .sources(true, true, true, false)
                .count(0),
            AdvancedQualityCase::new("native-pdf-retained-with-ocr-off", "分层权重稀有词")
                .sources(true, true, true, false)
                .count(1)
                .entity("attachment:weight-native", 1)
                .content_type("pdf_page"),
            AdvancedQualityCase::new("image-ocr-disabled", "海盐星球")
                .sources(true, false, true, true)
                .count(0),
            AdvancedQualityCase::new("attachment-filename", "附件名称稀有词")
                .count(1)
                .entity("attachment:filename", 1)
                .field("attachment")
                .content_type("pdf_page")
                .page(1),
        ];

        for case in advanced_cases {
            let started = Instant::now();
            let hits = index
                .search(
                    case.query,
                    case.limit,
                    case.space_id,
                    case.folder_id,
                    case.updated_after,
                    case.include_pages,
                    case.include_image_ocr,
                    case.include_pdf,
                    case.include_pdf_ocr,
                )
                .unwrap_or_else(|error| {
                    failures.push(format!("{}: query failed: {error}", case.name));
                    Vec::new()
                });
            durations.push(started.elapsed());
            if case
                .expected_count
                .is_some_and(|expected| hits.len() != expected)
            {
                failures.push(format!(
                    "{}: expected {} results, got {} ({:?})",
                    case.name,
                    case.expected_count.unwrap_or_default(),
                    hits.len(),
                    hits.iter()
                        .map(|hit| hit.entity_key.as_str())
                        .collect::<Vec<_>>()
                ));
            }
            let Some(expected_entity) = case.expected_entity else {
                continue;
            };
            ranked_case_count += 1;
            if case.max_rank == 1 {
                primary_ranked_case_count += 1;
            }
            let rank = hits
                .iter()
                .position(|hit| hit.entity_key == expected_entity)
                .map(|index| index + 1);
            if rank.is_some_and(|value| value <= 3) {
                recalled_at_three += 1;
            }
            if case.max_rank == 1 {
                if rank == Some(1) {
                    top_one += 1;
                }
                if let Some(rank) = rank {
                    primary_reciprocal_rank += 1.0 / rank as f64;
                }
            }
            let Some(rank) = rank else {
                failures.push(format!(
                    "{}: expected {} but got {:?}",
                    case.name,
                    expected_entity,
                    hits.iter()
                        .map(|hit| hit.entity_key.as_str())
                        .collect::<Vec<_>>()
                ));
                continue;
            };
            if rank > case.max_rank {
                failures.push(format!(
                    "{}: expected {} in top {}, actual rank {}",
                    case.name, expected_entity, case.max_rank, rank
                ));
            }
            let hit = &hits[rank - 1];
            if case
                .expected_field
                .is_some_and(|field| hit.match_field != field)
            {
                failures.push(format!(
                    "{}: expected field {:?}, got {}",
                    case.name, case.expected_field, hit.match_field
                ));
            }
            if case
                .expected_type
                .is_some_and(|kind| hit.content_type != kind)
            {
                failures.push(format!(
                    "{}: expected type {:?}, got {}",
                    case.name, case.expected_type, hit.content_type
                ));
            }
            if case
                .expected_page
                .is_some_and(|page| hit.page_number != Some(page))
            {
                failures.push(format!(
                    "{}: expected page {:?}, got {:?}",
                    case.name, case.expected_page, hit.page_number
                ));
            }
        }

        durations.sort_unstable();
        let p95 = durations[(durations.len() * 95).div_ceil(100).saturating_sub(1)];
        let mean_reciprocal_rank = primary_reciprocal_rank / primary_ranked_case_count as f64;
        eprintln!(
            "search quality: Top1 {}/{}, Recall@3 {}/{}, MRR {:.3}, P95 {:?}",
            top_one,
            primary_ranked_case_count,
            recalled_at_three,
            ranked_case_count,
            mean_reciprocal_rank,
            p95
        );
        assert!(
            p95 < Duration::from_millis(250),
            "search quality P95 regression: {p95:?}"
        );
        assert!(
            failures.is_empty(),
            "search quality regressions (Top1 {}/{}, Recall@3 {}/{}, MRR {:.3}, P95 {:?}):\n{}",
            top_one,
            primary_ranked_case_count,
            recalled_at_three,
            ranked_case_count,
            mean_reciprocal_rank,
            p95,
            failures.join("\n")
        );

        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn search_groups_document_chunks_and_each_attachment_separately() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "craft-search-entity-index-{}-{nonce}",
            std::process::id()
        ));
        let index = SearchIndex::open(&directory).unwrap();
        index
            .rebuild(&[
                record("document-1", "document:space:document", "markdown_section"),
                record("document-2", "document:space:document", "markdown_section"),
                record("image-1", "attachment:image-1", "image_ocr"),
                record("image-2", "attachment:image-2", "image_ocr"),
                record("pdf-page-1", "attachment:pdf-1", "pdf_page"),
                record("pdf-page-2", "attachment:pdf-1", "pdf_page"),
            ])
            .unwrap();

        let hits = index
            .search(
                "shared-search-token",
                10,
                None,
                None,
                None,
                true,
                true,
                true,
                true,
            )
            .unwrap();
        let entity_keys = hits
            .iter()
            .map(|hit| hit.entity_key.as_str())
            .collect::<HashSet<_>>();
        assert_eq!(hits.len(), 4);
        assert!(entity_keys.contains("document:space:document"));
        assert!(entity_keys.contains("attachment:image-1"));
        assert!(entity_keys.contains("attachment:image-2"));
        assert!(entity_keys.contains("attachment:pdf-1"));

        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn attachment_does_not_repeat_when_only_its_parent_page_title_matches() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "craft-search-parent-title-dedup-{}-{nonce}",
            std::process::id()
        ));
        let index = SearchIndex::open(&directory).unwrap();

        let mut page = record("page", "document:page", "markdown_section");
        page.title = "Galaxy acceptance page".to_string();
        page.body = "Ordinary page content".to_string();

        let mut attachment = record("attachment", "attachment:file", "file_attachment");
        attachment.title = page.title.clone();
        attachment.source_item_id = "file".to_string();
        attachment.source_title = "Supplier quotation.xlsx".to_string();
        attachment.body = attachment.source_title.clone();

        index.rebuild(&[page, attachment]).unwrap();

        let parent_title_hits = index
            .search_with_field_scope(
                "Galaxy", 10, None, None, None, true, true, true, true, true, "all",
            )
            .unwrap();
        assert_eq!(parent_title_hits.len(), 1);
        assert_eq!(parent_title_hits[0].entity_key, "document:page");

        let attachment_hits = index
            .search_with_field_scope(
                "quotation",
                10,
                None,
                None,
                None,
                true,
                true,
                true,
                true,
                true,
                "all",
            )
            .unwrap();
        assert_eq!(attachment_hits.len(), 1);
        assert_eq!(attachment_hits[0].entity_key, "attachment:file");
        assert!(attachment_hits[0]
            .match_field
            .split(',')
            .any(|field| field == "attachment"));

        let title_only_hits = index
            .search_with_field_scope(
                "Galaxy", 10, None, None, None, true, true, true, true, true, "title",
            )
            .unwrap();
        assert_eq!(title_only_hits.len(), 1);
        assert_eq!(title_only_hits[0].entity_key, "document:page");

        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn empty_query_supports_source_filtered_smart_collections() {
        let directory = std::env::temp_dir().join(format!(
            "craft-search-empty-filter-index-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&directory);
        let index = SearchIndex::open(&directory).unwrap();
        let page = record("page", "document:page", "document");
        let mut pdf = record("pdf", "attachment:pdf", "pdf_page");
        pdf.source_item_id = "source-pdf".to_string();
        pdf.source_title = "Roadmap.pdf".to_string();
        index.rebuild(&[page, pdf]).unwrap();

        let hits = index
            .search_with_field_scope(
                "", 10, None, None, None, false, false, true, true, false, "all",
            )
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].content_type, "pdf_page");

        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn search_supports_full_pinyin_initials_and_typo_tolerance() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "craft-search-quality-index-{}-{nonce}",
            std::process::id()
        ));
        let index = SearchIndex::open(&directory).unwrap();
        let mut item = record("quality", "document:quality", "markdown_section");
        item.title = "搜索设计".to_string();
        item.heading = "快速查找".to_string();
        item.body = "performance optimization handbook".to_string();
        index.rebuild(&[item]).unwrap();

        for query in ["sousuosheji", "sssj", "performnce"] {
            assert!(
                !index
                    .search(query, 10, None, None, None, true, true, true, true)
                    .unwrap()
                    .is_empty(),
                "{query} should match"
            );
        }

        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn aliases_tags_and_grouped_sub_hits_are_searchable() {
        let index_path = std::env::temp_dir().join(format!(
            "craft-search-metadata-index-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&index_path);
        let index = SearchIndex::open(&index_path).unwrap();

        let mut alias = record("alias", "document:alias", "obsidian_markdown");
        alias.document_key = "space:alias".to_string();
        alias.document_id = "alias".to_string();
        alias.title = "正式名称".to_string();
        alias.heading = "正式名称".to_string();
        alias.aliases = "北辰入口".to_string();
        alias.body = "普通正文".to_string();

        let mut tag = record("tag", "document:tag", "obsidian_markdown");
        tag.document_key = "space:tag".to_string();
        tag.document_id = "tag".to_string();
        tag.title = "项目记录".to_string();
        tag.heading = "项目记录".to_string();
        tag.tags = "本地优先 搜索质量".to_string();
        tag.body = "普通正文".to_string();

        let mut section_a = record("section-a", "document:grouped", "obsidian_markdown");
        section_a.document_key = "space:grouped".to_string();
        section_a.document_id = "grouped".to_string();
        section_a.heading = "第一章节".to_string();
        section_a.body = "聚合验证词出现在第一章节".to_string();
        let mut section_b = section_a.clone();
        section_b.item_id = "section-b".to_string();
        section_b.heading = "第二章节".to_string();
        section_b.body = "聚合验证词也出现在第二章节".to_string();

        index.rebuild(&[alias, tag, section_a, section_b]).unwrap();

        let alias_hits = index
            .search("北辰入口", 10, None, None, None, true, true, true, true)
            .unwrap();
        assert_eq!(alias_hits[0].entity_key, "document:alias");
        assert_eq!(alias_hits[0].match_field, "alias");

        let tag_hits = index
            .search("本地优先", 10, None, None, None, true, true, true, true)
            .unwrap();
        assert_eq!(tag_hits[0].entity_key, "document:tag");
        assert_eq!(tag_hits[0].match_field, "tag");

        let grouped = index
            .search("聚合验证词", 10, None, None, None, true, true, true, true)
            .unwrap();
        assert_eq!(grouped[0].entity_key, "document:grouped");
        assert_eq!(grouped[0].match_count, 2);
        assert_eq!(grouped[0].sub_hits.len(), 2);

        let _ = std::fs::remove_dir_all(index_path);
    }

    #[test]
    fn tag_field_scope_does_not_match_title_or_body_text() {
        let index_path = std::env::temp_dir().join(format!(
            "craft-search-tag-scope-index-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&index_path);
        let index = SearchIndex::open(&index_path).unwrap();

        let mut tagged = record("tagged", "document:tagged", "markdown_section");
        tagged.title = "Ordinary page".to_string();
        tagged.heading = "Ordinary heading".to_string();
        tagged.body = "No matching word here".to_string();
        tagged.tags = "priority".to_string();

        let mut body_only = record("body", "document:body", "markdown_section");
        body_only.title = "Priority appears in the title".to_string();
        body_only.heading = "Priority heading".to_string();
        body_only.body = "priority appears in the body".to_string();
        body_only.tags = String::new();

        index.rebuild(&[tagged, body_only]).unwrap();
        let hits = index
            .search_with_field_scope(
                "priority", 10, None, None, None, true, false, false, false, false, "tag",
            )
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].entity_key, "document:tagged");
        assert_eq!(hits[0].match_field, "tag");

        let _ = std::fs::remove_dir_all(index_path);
    }

    #[test]
    fn multi_term_search_requires_all_terms_and_reports_evidence() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "craft-search-and-query-{}-{nonce}",
            std::process::id()
        ));
        let index = SearchIndex::open(&directory).unwrap();
        let mut complete = record("complete", "document:complete", "markdown_section");
        complete.title = "项目搜索方案".to_string();
        complete.body = "包含性能优化与高亮导航".to_string();
        let mut partial = record("partial", "document:partial", "markdown_section");
        partial.title = "项目搜索方案".to_string();
        partial.body = "只有高亮导航".to_string();
        index.rebuild(&[complete, partial]).unwrap();

        let hits = index
            .search("项目 性能", 10, None, None, None, true, true, true, true)
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].entity_key, "document:complete");
        assert!(hits[0].match_terms.iter().any(|term| term == "性能"));
        assert_eq!(hits[0].match_field, "title,body");

        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn exact_title_ranks_above_body_and_pinyin_returns_chinese_evidence() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "craft-search-ranking-{}-{nonce}",
            std::process::id()
        ));
        let index = SearchIndex::open(&directory).unwrap();
        let mut title = record("title", "document:title", "obsidian_markdown");
        title.provider = "obsidian".to_string();
        title.title = "搜索设计".to_string();
        title.body = "简短说明".to_string();
        let mut body = record("body", "document:body", "markdown_section");
        body.title = "普通页面".to_string();
        body.body = "搜索设计 搜索设计 搜索设计".to_string();
        index.rebuild(&[body, title]).unwrap();

        let exact = index
            .search("搜索设计", 10, None, None, None, true, true, true, true)
            .unwrap();
        assert_eq!(exact[0].entity_key, "document:title");
        assert_eq!(exact[0].match_field, "title");

        let pinyin = index
            .search("sousuosheji", 10, None, None, None, true, true, true, true)
            .unwrap();
        assert_eq!(pinyin[0].entity_key, "document:title");
        assert!(pinyin[0].match_terms.iter().any(|term| term == "搜索设计"));

        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn quoted_phrase_requires_adjacent_terms() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "craft-search-phrase-query-{}-{nonce}",
            std::process::id()
        ));
        let index = SearchIndex::open(&directory).unwrap();
        let mut phrase = record("phrase", "document:phrase", "markdown_section");
        phrase.body = "alpha beta release notes".to_string();
        let mut separated = record("separated", "document:separated", "markdown_section");
        separated.body = "alpha stable beta release notes".to_string();
        index.rebuild(&[phrase, separated]).unwrap();

        let hits = index
            .search(
                "\"alpha beta\"",
                10,
                None,
                None,
                None,
                true,
                true,
                true,
                true,
            )
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].entity_key, "document:phrase");
        assert!(hits[0].match_terms.iter().any(|term| term == "alpha beta"));

        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn explicit_or_returns_documents_matching_either_term() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "craft-search-or-query-{}-{nonce}",
            std::process::id()
        ));
        let index = SearchIndex::open(&directory).unwrap();
        let mut alpha = record("alpha", "document:alpha", "markdown_section");
        alpha.body = "alpha release notes".to_string();
        let mut beta = record("beta", "document:beta", "markdown_section");
        beta.body = "beta release notes".to_string();
        let mut unrelated = record("unrelated", "document:unrelated", "markdown_section");
        unrelated.body = "gamma release notes".to_string();
        index.rebuild(&[alpha, beta, unrelated]).unwrap();

        let hits = index
            .search(
                "alpha OR beta",
                10,
                None,
                None,
                None,
                true,
                true,
                true,
                true,
            )
            .unwrap();
        let entity_keys = hits
            .iter()
            .map(|hit| hit.entity_key.as_str())
            .collect::<HashSet<_>>();
        assert_eq!(hits.len(), 2);
        assert!(entity_keys.contains("document:alpha"));
        assert!(entity_keys.contains("document:beta"));

        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn field_scope_restricts_results_to_page_titles_or_headings() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "craft-search-field-scope-{}-{nonce}",
            std::process::id()
        ));
        let index = SearchIndex::open(&directory).unwrap();

        let mut title = record("title", "document:title", "markdown_section");
        title.title = "星河标题页面".to_string();
        title.heading = "普通章节".to_string();
        title.body = "普通正文".to_string();

        let mut heading = record("heading", "document:heading", "markdown_section");
        heading.title = "普通页面".to_string();
        heading.heading = "星河章节".to_string();
        heading.body = "普通正文".to_string();

        let mut body = record("body", "document:body", "markdown_section");
        body.title = "另一页面".to_string();
        body.heading = "另一章节".to_string();
        body.body = "星河只在正文".to_string();

        index.rebuild(&[title, heading, body]).unwrap();

        let search = |scope| {
            index
                .search_with_field_scope(
                    "星河", 10, None, None, None, true, true, true, true, true, scope,
                )
                .unwrap()
        };

        let all = search("all");
        assert_eq!(all.len(), 3);

        let titles = search("title");
        assert_eq!(titles.len(), 1);
        assert_eq!(titles[0].entity_key, "document:title");
        assert_eq!(titles[0].match_field, "title");
        let pinyin_titles = index
            .search_with_field_scope(
                "xinghe", 10, None, None, None, true, true, true, true, true, "title",
            )
            .unwrap();
        assert_eq!(pinyin_titles.len(), 1);
        assert_eq!(pinyin_titles[0].entity_key, "document:title");

        let titles_and_headings = search("title_heading");
        let entity_keys = titles_and_headings
            .iter()
            .map(|hit| hit.entity_key.as_str())
            .collect::<HashSet<_>>();
        assert_eq!(titles_and_headings.len(), 2);
        assert!(entity_keys.contains("document:title"));
        assert!(entity_keys.contains("document:heading"));
        assert!(!entity_keys.contains("document:body"));

        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn ancestor_paths_do_not_recall_descendants_without_an_explicit_path_query() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "craft-search-ancestor-path-{}-{nonce}",
            std::process::id()
        ));
        let index = SearchIndex::open(&directory).unwrap();

        let mut parent = record("parent", "document:parent", "craft_subpage");
        parent.title = "T29".to_string();
        parent.path = "Car / T29".to_string();
        parent.body = "parent content".to_string();

        let mut child = record("child", "document:child", "craft_subpage");
        child.title = "麦克风".to_string();
        child.path = "Car / T29 / 麦克风".to_string();
        child.body = "child content".to_string();

        index.rebuild(&[parent, child]).unwrap();

        let ordinary = index
            .search_with_field_scope(
                "T29", 10, None, None, None, true, true, true, true, true, "all",
            )
            .unwrap();
        assert_eq!(ordinary.len(), 1);
        assert_eq!(ordinary[0].entity_key, "document:parent");

        let explicit_path = index
            .search_with_field_scope(
                "path:T29", 10, None, None, None, true, true, true, true, true, "all",
            )
            .unwrap();
        assert_eq!(explicit_path.len(), 2);
        assert!(explicit_path
            .iter()
            .all(|hit| hit.match_field.split(',').any(|field| field == "path")));

        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn multiple_space_ids_are_combined_as_an_inclusive_filter() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "craft-search-multiple-spaces-{}-{nonce}",
            std::process::id()
        ));
        let index = SearchIndex::open(&directory).unwrap();

        let records = ["space-a", "space-b", "space-c"]
            .into_iter()
            .map(|space_id| {
                quality_record(
                    space_id,
                    "craft",
                    space_id,
                    &format!("document:{space_id}"),
                    "markdown_section",
                    "Shared galaxy title",
                    "",
                    "",
                    "",
                )
            })
            .collect::<Vec<_>>();
        index.rebuild(&records).unwrap();

        let selected_spaces = vec!["space-a".to_string(), "space-c".to_string()];
        let hits = index
            .search_with_space_ids_and_field_scope(
                "galaxy",
                10,
                Some(&selected_spaces),
                None,
                None,
                true,
                true,
                true,
                true,
                true,
                "all",
            )
            .unwrap();
        let entity_keys = hits
            .iter()
            .map(|hit| hit.entity_key.as_str())
            .collect::<HashSet<_>>();

        assert_eq!(hits.len(), 2);
        assert!(entity_keys.contains("document:space-a"));
        assert!(entity_keys.contains("document:space-c"));
        assert!(!entity_keys.contains("document:space-b"));

        let empty_spaces = Vec::<String>::new();
        let empty_hits = index
            .search_with_space_ids_and_field_scope(
                "galaxy",
                10,
                Some(&empty_spaces),
                None,
                None,
                true,
                true,
                true,
                true,
                true,
                "all",
            )
            .unwrap();
        assert!(empty_hits.is_empty());

        let _ = std::fs::remove_dir_all(directory);
    }
}
