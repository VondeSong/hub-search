//! Bounded computations over the exact host-issued scope, never a model-supplied scope.
//! Counts describe the local cache snapshot, not remote completeness or real-world events.
use super::*;
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

const MAX_NOTES: usize = 5000;
const MAX_BYTES: usize = 32 * 1024 * 1024;

mod snapshots;
mod source_manifest;

pub(crate) fn prepare_existing_store(root: &Path) -> Result<(), String> {
    snapshots::prepare_existing_store(root)
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct Source {
    locator: EvidenceLocator,
    title: String,
    path: String,
    library: String,
    version: Value,
}

fn sources(
    reader: &EvidenceReader,
    c: &Connection,
    visible: &[String],
    args: &Value,
) -> Result<Vec<Source>, String> {
    let selected = args["libraryId"].as_str().unwrap_or_default();
    if !selected.is_empty() {
        reader.scope.in_library(selected)?;
    }
    if reader
        .scope
        .library_ids
        .iter()
        .any(|id| (selected.is_empty() || id == selected) && !visible.contains(id))
    {
        return Err("授权资料库当前不可用，请重新核对范围；未返回完整统计".into());
    }
    for note in &reader.scope.notes {
        if let EvidenceLocator::Note {
            library_id,
            document_id,
            ..
        } = note
        {
            if selected.is_empty() || library_id == selected {
                document_record(c, library_id, document_id)?;
            }
        }
    }
    let query = args["query"]
        .as_str()
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    if query.chars().count() > 200 {
        return Err("材料筛选最多 200 个字符".into());
    }
    let mut stmt = c.prepare("SELECT d.space_id,d.id,d.title,d.path,d.content_hash,d.blob_hash,length(d.markdown),l.name FROM documents d JOIN libraries l ON l.id=d.space_id WHERE l.enabled=1 AND d.provider IN ('craft','obsidian') AND (d.space_id IN (SELECT value FROM json_each(?1)) OR EXISTS(SELECT 1 FROM json_each(?2) n WHERE json_extract(n.value,'$.libraryId')=d.space_id AND json_extract(n.value,'$.documentId')=d.id)) ORDER BY d.space_id,d.id").map_err(|e|e.to_string())?;
    let mut rows = stmt
        .query(params![
            serde_json::to_string(&reader.scope.library_ids).unwrap(),
            serde_json::to_string(&reader.scope.notes).unwrap()
        ])
        .map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        reader.checkpoint()?;
        let library: String = row.get(0).map_err(|e| e.to_string())?;
        let document: String = row.get(1).map_err(|e| e.to_string())?;
        if !visible.contains(&library) || (!selected.is_empty() && library != selected) {
            continue;
        }
        let title: String = row.get(2).map_err(|e| e.to_string())?;
        let path: String = row.get(3).map_err(|e| e.to_string())?;
        if !query.is_empty()
            && !title.to_lowercase().contains(&query)
            && !path.to_lowercase().contains(&query)
        {
            continue;
        }
        let root = EvidenceLocator::Note {
            library_id: library.clone(),
            document_id: document.clone(),
            page_id: None,
        };
        let mut locators = if reader.scope.permits_note(&root) {
            vec![root]
        } else {
            reader.scope.notes.iter().filter(|n|matches!(n,EvidenceLocator::Note {library_id:l,document_id:d,..} if *l==library && *d==document)).cloned().collect::<Vec<_>>()
        };
        locators.sort_by_key(|n| serde_json::to_string(n).unwrap());
        locators.dedup();
        for locator in locators {
            result.push(Source {
                locator,
                title: title.clone(),
                path: path.clone(),
                library: row.get(7).map_err(|e| e.to_string())?,
                version: json!([
                    row.get::<_, String>(4).map_err(|e| e.to_string())?,
                    row.get::<_, Option<String>>(5).map_err(|e| e.to_string())?,
                    row.get::<_, i64>(6).map_err(|e| e.to_string())?
                ]),
            });
            if result.len() > MAX_NOTES {
                return Err(
                    "材料超过 5000 份，请缩小资料库或标题/路径筛选范围；未返回抽样统计".into(),
                );
            }
        }
    }
    Ok(result)
}

fn identity(items: &[Source], _visible: &[String]) -> String {
    fingerprint(
        &json!({"format":1,"items":items.iter().map(|s|json!([s.locator,s.title,s.path,s.library,s.version])).collect::<Vec<_>>()}),
    )
}

pub(crate) fn verify_in_transaction(
    reader: &EvidenceReader,
    c: &Connection,
    reads: &Value,
) -> Result<(), String> {
    if reads.is_null() {
        return Ok(());
    }
    let reads = reads.as_object().ok_or("材料依赖记录无效")?;
    if reads.len() > 16 {
        return Err("材料依赖超过上限".into());
    }
    let visible = reader.visible(c)?;
    for read in reads.values() {
        if source_manifest::is_manifest(&read["snapshot"]) {
            source_manifest::verify(reader, c, &visible, &read["arguments"], &read["snapshot"])?;
            continue;
        }
        if snapshots::is_frozen(&read["snapshot"]) {
            snapshots::verify(reader, c, &visible, &read["snapshot"], &read["arguments"])?;
            continue;
        }
        let current = identity(&sources(reader, c, &visible, &read["arguments"])?, &visible);
        if read["snapshot"].as_str() != Some(current.as_str()) {
            return Err("统计或材料清单来源已变化，旧结论已隐藏，请重新核对".into());
        }
    }
    Ok(())
}

pub(crate) fn verify_source_manifest(
    reader: &EvidenceReader,
    args: &Value,
    expected: &Value,
) -> Result<(), String> {
    reader.in_snapshot(|c, visible| source_manifest::verify(reader, c, visible, args, expected))
}

pub(crate) fn snapshot(reader: &EvidenceReader, args: &Value) -> Result<String, String> {
    if snapshots::is_frozen(&args["expectedSnapshot"]) {
        return reader.in_snapshot(|c, visible| {
            snapshots::verify(reader, c, visible, &args["expectedSnapshot"], args)?;
            Ok(args["expectedSnapshot"].as_str().unwrap().to_owned())
        });
    }
    reader.in_snapshot(|c, visible| Ok(identity(&sources(reader, c, visible, args)?, visible)))
}

pub(crate) fn execute(reader: &EvidenceReader, name: &str, args: &Value) -> Result<Value, String> {
    if name == "hub_source_manifest" {
        return source_manifest::execute(reader, args);
    }
    if name == "hub_create_analysis_snapshot" {
        return snapshots::create(reader, args);
    }
    if name == "hub_read_analysis_snapshot" || snapshots::is_frozen(&args["expectedSnapshot"]) {
        return snapshots::execute(reader, name, args);
    }
    reader.in_snapshot(|c,visible| {
        let items = sources(reader,c,visible,args)?;
        let snapshot = identity(&items,visible);
        if args["expectedSnapshot"].as_str().is_some_and(|v|v!=snapshot) { return Err("材料清单已经变化，请从第一页重新核对，不合并不同版本的统计".into()); }
        if name == "hub_list_note_sources" {
            let offset = args["offset"].as_u64().unwrap_or(0) as usize;
            let limit = args["limit"].as_u64().unwrap_or(30).clamp(1,50) as usize;
            let notes = items.iter().skip(offset).take(limit).map(|s|json!({"locator":s.locator,"title":s.title,"path":s.path,"libraryName":s.library})).collect::<Vec<_>>();
            let end = offset.saturating_add(notes.len());
            return Ok(json!({"notes":notes,"total":items.len(),"nextOffset":if end<items.len(){Some(end)}else{None},"snapshot":snapshot,"coverage":"authorizedLocalCache","filter":"titleOrPathContains","bodyRead":false}));
        }
        analyze(reader,c,visible,&items,args,&snapshot,None)
    })
}

#[derive(Default)]
struct Counts {
    units: usize,
    chars: usize,
    matches: Vec<usize>,
    occurrences: Vec<usize>,
}
impl Counts {
    fn add(&mut self, chars: usize, occurrences: &[usize]) {
        self.units += 1;
        self.chars += chars;
        self.matches.resize(occurrences.len(), 0);
        self.occurrences.resize(occurrences.len(), 0);
        for (i, count) in occurrences.iter().enumerate() {
            self.matches[i] += usize::from(*count > 0);
            self.occurrences[i] += count;
        }
    }
    fn value(&self, terms: &[String]) -> Value {
        json!({"units":self.units,"characters":self.chars,"terms":terms.iter().enumerate().map(|(i,t)|json!({"term":t,"matchingUnits":self.matches.get(i).copied().unwrap_or(0),"occurrences":self.occurrences.get(i).copied().unwrap_or(0)})).collect::<Vec<_>>()})
    }
}

pub(crate) fn date_headers(body: &str) -> Vec<(chrono::NaiveDate, usize, usize)> {
    static PATTERN: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(
            r"(?m)^[\t ]*(?:#{1,6}[\t ]+)?@?(\d{4})[-年/](\d{1,2})[-月/](\d{1,2})日?[\t ]*\r?$",
        )
        .unwrap()
    });
    let mut offset = 0;
    let mut fence: Option<(char, usize)> = None;
    let mut frontmatter = false;
    body.split_inclusive('\n')
        .enumerate()
        .filter_map(|(line_number, line)| {
            let start = offset;
            offset += line.len();
            let trimmed = line.trim();
            if line_number == 0 && trimmed.trim_start_matches('\u{feff}') == "---" {
                frontmatter = true;
                return None;
            }
            if frontmatter {
                if matches!(trimmed, "---" | "...") {
                    frontmatter = false;
                }
                return None;
            }
            if let Some((marker, count)) = fence {
                let run = trimmed.chars().take_while(|c| *c == marker).count();
                if run >= count && trimmed.chars().skip(run).all(char::is_whitespace) {
                    fence = None;
                }
                return None;
            }
            if let Some(marker) = trimmed.chars().next().filter(|c| matches!(c, '`' | '~')) {
                let run = trimmed.chars().take_while(|c| *c == marker).count();
                if run >= 3 {
                    fence = Some((marker, run));
                    return None;
                }
            }
            let m = PATTERN.captures(line)?;
            let date = chrono::NaiveDate::from_ymd_opt(
                m[1].parse().ok()?,
                m[2].parse().ok()?,
                m[3].parse().ok()?,
            )?;
            let whole = m.get(0)?;
            Some((date, start + whole.start(), start + whole.end()))
        })
        .collect()
}

fn analyze(
    reader: &EvidenceReader,
    c: &Connection,
    visible: &[String],
    items: &[Source],
    args: &Value,
    snapshot: &str,
    frozen: Option<&[Result<String, String>]>,
) -> Result<Value, String> {
    let terms = args["terms"]
        .as_array()
        .map(|v| {
            v.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if terms.len() > 12
        || terms
            .iter()
            .any(|s| s.trim().is_empty() || s.chars().count() > 100)
    {
        return Err("最多 12 个非空关键词，每个最多 100 字符".into());
    }
    let sensitive = args["caseSensitive"] == true;
    let needles = terms
        .iter()
        .map(|s| {
            if sensitive {
                s.clone()
            } else {
                s.to_lowercase()
            }
        })
        .collect::<Vec<_>>();
    let dated = args["unit"] == "day";
    let grouping = args["groupBy"].as_str().unwrap_or("library");
    if !dated && matches!(grouping, "month" | "year") {
        return Err("按月或年分组需要 unit=day，日期只取独占一行的日期标题".into());
    }
    if dated && grouping == "document" {
        return Err("按日去重不能同时按文档分组；请选择 library、month、year 或 none".into());
    }
    let date_arg = |key: &str| -> Result<Option<chrono::NaiveDate>, String> {
        args[key]
            .as_str()
            .map(|s| {
                chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
                    .map_err(|_| format!("{key} 需要有效的 YYYY-MM-DD 日期"))
            })
            .transpose()
    };
    let from = date_arg("dateFrom")?;
    let to = date_arg("dateTo")?;
    if !dated && (from.is_some() || to.is_some()) {
        return Err("日期筛选需要 unit=day".into());
    }
    if from.zip(to).is_some_and(|(a, b)| a > b) {
        return Err("起始日期不能晚于结束日期".into());
    }
    let started = Instant::now();
    let mut bytes = 0;
    let mut analyzed = 0;
    let mut skipped = Vec::new();
    let mut unassigned_chars = 0;
    let mut dated_sections: usize = 0;
    let mut outside_range: usize = 0;
    // Date identity includes the library: unrelated libraries are never silently merged.
    let mut units = BTreeMap::<String, (String, usize, Vec<usize>)>::new();
    for (index, item) in items.iter().enumerate() {
        reader.checkpoint()?;
        if started.elapsed() > Duration::from_secs(10) {
            return Err("统计达到单次 10 秒上限，请缩小范围；未返回部分计数".into());
        }
        let EvidenceLocator::Note { library_id, .. } = &item.locator else {
            unreachable!()
        };
        let body = match frozen
            .map(|values| values[index].clone())
            .unwrap_or_else(|| {
                reader
                    .snapshot(c, visible, &item.locator)
                    .map(|value| value.body)
            }) {
            Ok(value) => value,
            Err(error) => {
                skipped.push(json!({"locator":item.locator,"error":error}));
                continue;
            }
        };
        bytes += body.len();
        if bytes > MAX_BYTES {
            return Err("统计正文超过 32 MiB，请缩小范围；未返回抽样计数".into());
        }
        analyzed += 1;
        let headers = if dated {
            date_headers(&body)
        } else {
            Vec::new()
        };
        let sections = if dated {
            if headers.is_empty() {
                unassigned_chars += body.chars().count();
                Vec::new()
            } else {
                unassigned_chars += body[..headers[0].1].chars().count();
                headers
                    .iter()
                    .enumerate()
                    .map(|(i, (date, _, start))| {
                        (
                            Some(*date),
                            &body[*start..headers.get(i + 1).map(|h| h.1).unwrap_or(body.len())],
                        )
                    })
                    .collect::<Vec<_>>()
            }
        } else {
            vec![(None, body.as_str())]
        };
        for (date, text) in sections {
            if date.is_some() {
                dated_sections += 1;
            }
            if date.is_some_and(|d| from.is_some_and(|f| d < f) || to.is_some_and(|t| d > t)) {
                outside_range += 1;
                continue;
            }
            let key = if let Some(d) = date {
                format!("{library_id}\0{d}")
            } else {
                serde_json::to_string(&item.locator).unwrap()
            };
            let group = match grouping {
                "none" => "全部".into(),
                "month" => date.unwrap().format("%Y-%m").to_string(),
                "year" => date.unwrap().format("%Y").to_string(),
                "document" => format!("{} / {}", item.library, item.path),
                _ => format!("{} ({library_id})", item.library),
            };
            let haystack = if sensitive {
                text.to_string()
            } else {
                text.to_lowercase()
            };
            let occurrences = needles
                .iter()
                .map(|n| haystack.matches(n).count())
                .collect::<Vec<_>>();
            let entry = units
                .entry(key)
                .or_insert_with(|| (group, 0, vec![0; needles.len()]));
            entry.1 += text.chars().count();
            for (i, count) in occurrences.iter().enumerate() {
                entry.2[i] += count;
            }
        }
    }
    let mut total = Counts::default();
    let mut groups = BTreeMap::<String, Counts>::new();
    for (group, chars, occurrences) in units.values() {
        total.add(*chars, occurrences);
        groups
            .entry(group.clone())
            .or_default()
            .add(*chars, occurrences);
    }
    let complete = skipped.is_empty();
    let rows = groups
        .iter()
        .take(120)
        .map(|(key, v)| json!({"group":key,"counts":v.value(&terms)}))
        .collect::<Vec<_>>();
    Ok(
        json!({"snapshot":snapshot,"complete":complete,"coverage":"authorizedLocalCache","sourceFreshness":"notVerifiedWithRemote","analysisUnit":if dated{"uniqueDatePerLibrary"}else{"documentOrExactPage"},"documentsMatched":items.len(),"documentsAnalyzed":analyzed,"bodyBytes":bytes,"skippedCount":skipped.len(),"skipped":skipped.iter().take(20).collect::<Vec<_>>(),"totals":total.value(&terms),"groups":rows,"groupRowsTotal":groups.len(),"groupsTruncated":groups.len()>120,"datedSections":dated_sections,"duplicateDateSections":dated_sections.saturating_sub(outside_range).saturating_sub(units.len()),"outsideDateRangeSections":outside_range,"unassignedCharacters":unassigned_chars,"method":"Literal non-overlapping keyword occurrences; matchingUnits counts each unit once. Keywords can overlap each other. Date units merge repeated date headings within each library; occurrences retain all sections, including duplicate text. Only standalone YYYY-MM-DD / YYYY年M月D日 date headings are recognized. These are text mentions, not event rates or diagnoses."}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source_evidence::tests::Fixture;
    fn note(library: &str, id: &str) -> EvidenceLocator {
        EvidenceLocator::Note {
            library_id: library.into(),
            document_id: id.into(),
            page_id: None,
        }
    }
    fn reader(f: &Fixture) -> EvidenceReader {
        EvidenceReader::new(
            &f.root,
            EvidenceScope::new(vec!["notes".into()], vec![]).unwrap(),
        )
    }

    #[test]
    fn exact_cross_library_sources_do_not_expand_to_siblings() {
        let f = Fixture::new();
        f.note("notes", "a", "学习 学习");
        f.note("private", "b", "学习");
        f.note("private", "secret", "SECRET 学习");
        let scope = EvidenceScope::new(vec![], vec![])
            .unwrap()
            .with_notes(vec![note("notes", "a"), note("private", "b")])
            .unwrap();
        let reader = EvidenceReader::new(&f.root, scope);
        let list = execute(&reader, "hub_list_note_sources", &json!({})).unwrap();
        assert_eq!(list["total"], 2);
        assert!(!list.to_string().contains("secret"));
        let stats = execute(&reader, "hub_analyze_notes", &json!({"terms":["学习"]})).unwrap();
        assert_eq!(stats["totals"]["units"], 2);
        assert_eq!(stats["totals"]["terms"][0]["matchingUnits"], 2);
        assert_eq!(stats["totals"]["terms"][0]["occurrences"], 3);
        assert!(execute(&reader, "hub_analyze_notes", &json!({"libraryId":"craft"})).is_err());
    }

    #[test]
    fn enumerates_beyond_search_limits_and_binds_pages_to_snapshot() {
        let f = Fixture::new();
        for i in 0..62 {
            f.note("notes", &format!("note-{i:02}"), "正文");
        }
        let reader = reader(&f);
        let first = execute(&reader, "hub_list_note_sources", &json!({"limit":50})).unwrap();
        assert_eq!(first["total"], 62);
        assert_eq!(first["nextOffset"], 50);
        let next = execute(
            &reader,
            "hub_list_note_sources",
            &json!({"offset":50,"expectedSnapshot":first["snapshot"]}),
        )
        .unwrap();
        assert_eq!(next["notes"].as_array().unwrap().len(), 12);
        assert!(next["nextOffset"].is_null());
        f.note("notes", "added", "新增");
        assert!(execute(
            &reader,
            "hub_list_note_sources",
            &json!({"offset":50,"expectedSnapshot":first["snapshot"]})
        )
        .is_err());
    }

    #[test]
    fn dates_are_validated_deduplicated_and_grouped_from_actual_sections() {
        let f = Fixture::new();
        f.note(
            "notes",
            "jan",
            "没有日期的前言\n# 2025-01-01\n学习 学习\n# 2025-01-02\n工作\n",
        );
        f.note("notes", "duplicate", "@2025年1月1日\n学习\n");
        f.note(
            "notes",
            "undated",
            "在 2025-01-03 想到的事\n2025-02-30\n学习",
        );
        let stats = execute(
            &reader(&f),
            "hub_analyze_notes",
            &json!({"unit":"day","groupBy":"month","terms":["学习"]}),
        )
        .unwrap();
        assert_eq!(stats["documentsAnalyzed"], 3);
        assert_eq!(stats["datedSections"], 3);
        assert_eq!(stats["duplicateDateSections"], 1);
        assert_eq!(stats["totals"]["units"], 2);
        assert_eq!(stats["totals"]["terms"][0]["matchingUnits"], 1);
        assert_eq!(stats["totals"]["terms"][0]["occurrences"], 3);
        assert_eq!(stats["groups"][0]["group"], "2025-01");
        assert!(stats["unassignedCharacters"].as_u64().unwrap() > 0);
        let range = execute(
            &reader(&f),
            "hub_analyze_notes",
            &json!({"unit":"day","dateFrom":"2025-01-02","dateTo":"2025-01-02"}),
        )
        .unwrap();
        assert_eq!(range["totals"]["units"], 1);
        assert_eq!(range["outsideDateRangeSections"], 2);
    }

    #[test]
    fn missing_bodies_and_missing_exact_sources_are_never_complete_counts() {
        let f = Fixture::new();
        f.note("notes", "bad", "正文");
        f.c()
            .execute(
                "UPDATE documents SET markdown='',blob_hash=NULL WHERE id='bad'",
                [],
            )
            .unwrap();
        let stats = execute(&reader(&f), "hub_analyze_notes", &json!({})).unwrap();
        assert_eq!(stats["complete"], false);
        assert_eq!(stats["skippedCount"], 1);
        let scope = EvidenceScope::new(vec![], vec![])
            .unwrap()
            .with_notes(vec![note("notes", "absent")])
            .unwrap();
        assert!(execute(
            &EvidenceReader::new(&f.root, scope),
            "hub_analyze_notes",
            &json!({})
        )
        .is_err());
    }

    #[test]
    fn filters_are_literal_and_invalid_statistical_combinations_fail() {
        let f = Fixture::new();
        f.note("notes", "one", "APPLE apple 学习学习");
        f.note("notes", "two", "apple");
        let stats = execute(
            &reader(&f),
            "hub_analyze_notes",
            &json!({"query":"one","terms":["apple","学习"]}),
        )
        .unwrap();
        assert_eq!(stats["totals"]["terms"][0]["occurrences"], 2);
        assert_eq!(stats["totals"]["terms"][1]["occurrences"], 2);
        assert!(execute(
            &reader(&f),
            "hub_analyze_notes",
            &json!({"groupBy":"month"})
        )
        .is_err());
        assert!(execute(
            &reader(&f),
            "hub_analyze_notes",
            &json!({"unit":"day","groupBy":"document"})
        )
        .is_err());
        assert!(execute(
            &reader(&f),
            "hub_analyze_notes",
            &json!({"unit":"day","dateFrom":"2025-02-30"})
        )
        .is_err());
    }

    #[test]
    fn metadata_and_fenced_examples_do_not_create_diary_days() {
        let headers=date_headers("---\n2025-01-01\n---\n```markdown\n# 2025-01-02\n```\n# 2025-01-03\n正文\n~~~\n2025-01-04\n~~~\n");
        assert_eq!(headers.len(), 1);
        assert_eq!(headers[0].0.to_string(), "2025-01-03");
    }
}
