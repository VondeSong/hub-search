//! One-shot local lookup. Search permission never becomes a model grant.
use super::*;
use std::collections::BTreeMap;

fn terms(raw: &str) -> Vec<String> {
    let mut counts = BTreeMap::<String, usize>::new();
    for part in raw.split(|c: char| !c.is_alphanumeric()) {
        let chars: Vec<_> = part.chars().collect();
        if chars.iter().all(char::is_ascii) {
            if (3..=32).contains(&chars.len()) {
                *counts.entry(part.to_lowercase()).or_default() += 1;
            }
        } else {
            for pair in chars.windows(2) {
                let word: String = pair.iter().collect();
                if !["的", "了", "是", "在", "与", "和", "一", "这", "个", "不"]
                    .iter()
                    .any(|s| word.contains(s))
                {
                    *counts.entry(word).or_default() += 1;
                }
            }
        }
    }
    let mut ranked: Vec<_> = counts.into_iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    ranked.into_iter().take(6).map(|v| v.0).collect()
}

pub(super) fn ui(root: &Path, args: &Value) -> Result<Value, String> {
    let permit = crate::library_runtime::cached_read_permit(root)?;
    let c = crate::source_evidence::open_read_database(root)?;
    if args["action"] == "insightHistoryLibraries" {
        let mut q = c.prepare("SELECT id FROM libraries WHERE enabled=1 AND provider IN ('craft','obsidian') ORDER BY id").map_err(|e| e.to_string())?;
        let ids = q
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let value = EvidenceReader::new(root, EvidenceScope::new(ids, vec![])?).catalog()?;
        permit.checkpoint()?;
        return Ok(json!({"libraries":value["libraries"]}));
    }
    let ids: Vec<String> =
        serde_json::from_value(args["libraryIds"].clone()).map_err(|_| "请选择本次允许检索的库")?;
    if ids.is_empty() || ids.len() > 16 {
        return Err("请选择1–16个本次允许检索的库".into());
    }
    let reader = EvidenceReader::new(root, EvidenceScope::new(ids.clone(), vec![])?);
    let catalog = reader.catalog()?;
    if catalog["unavailableLibraries"].as_u64().unwrap_or(1) != 0 {
        return Err("所选历史库已停用或不可读，请重新选择".into());
    }
    if catalog["libraries"].as_array().is_none_or(|ls| {
        ls.iter()
            .any(|l| !matches!(l["provider"].as_str(), Some("craft" | "obsidian")))
    }) {
        return Err("历史检索只支持本地 Craft 与 Obsidian 文字资料".into());
    }
    let seeds: Vec<EvidenceLocator> =
        serde_json::from_value(args["notes"].clone()).map_err(|_| "请先选择当前资料")?;
    if seeds.is_empty() || seeds.len() > 32 {
        return Err("请先选择1–32份当前资料".into());
    }
    let seed_reader = EvidenceReader::new(
        root,
        EvidenceScope::new(vec![], vec![])?.with_notes(seeds.clone())?,
    );
    let mut excerpts = Vec::new();
    let mut context = String::new();
    for seed in &seeds {
        let e = seed_reader.read(seed, 0, 1200, None)?;
        context.push_str(&format!(
            "{} {} {} {}\n",
            e.title, e.title, e.title, e.content
        ));
        excerpts.push(e);
    }
    let query = args["query"].as_str().unwrap_or_default().trim();
    if query.chars().count() > 120 {
        return Err("线索词最多120个字符".into());
    }
    let queries = if query.is_empty() {
        terms(&context)
    } else {
        vec![query.to_owned()]
    };
    let mut found: Vec<Value> = Vec::new();
    let mut limited = false;
    let mut unavailable = 0;
    for query in &queries {
        let search = reader.search(crate::source_evidence::EvidenceKind::Note, query, 20)?;
        limited |= search.limit_reached;
        unavailable += search.unavailable_candidates;
        for candidate in search.candidates {
            if !matches!(candidate.locator, EvidenceLocator::Note { .. })
                || seeds.iter().any(|s| match (s, &candidate.locator) {
                    (
                        EvidenceLocator::Note {
                            library_id: a,
                            document_id: b,
                            ..
                        },
                        EvidenceLocator::Note {
                            library_id: c,
                            document_id: d,
                            ..
                        },
                    ) => a == c && b == d,
                    _ => false,
                })
            {
                continue;
            }
            let locator = serde_json::to_value(&candidate.locator).map_err(|e| e.to_string())?;
            if let Some(old) = found.iter_mut().find(|v| v["locator"] == locator) {
                old["matchedTerms"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!(query));
                continue;
            }
            let excerpt = reader.read(&candidate.locator, 0, 1, Some(&candidate.version))?;
            let library = locator["libraryId"].as_str().unwrap_or_default();
            let name = catalog["libraries"]
                .as_array()
                .and_then(|ls| ls.iter().find(|l| l["libraryId"] == library))
                .map(|l| l["name"].clone())
                .unwrap_or(Value::Null);
            found.push(json!({"locator":locator,"version":candidate.version,"title":candidate.title,"snippet":candidate.snippet,"path":excerpt.source_path,"libraryName":name,"matchedTerms":[query]}));
        }
    }
    found.sort_by_key(|v| std::cmp::Reverse(v["matchedTerms"].as_array().unwrap().len()));
    limited |= found.len() > 10;
    found.truncate(10);
    for e in &excerpts {
        seed_reader.verify(e)?;
    }
    for candidate in &found {
        reader.read(
            &serde_json::from_value(candidate["locator"].clone()).map_err(|_| "资料身份无效")?,
            0,
            1,
            Some(
                &serde_json::from_value(candidate["version"].clone())
                    .map_err(|_| "资料版本无效")?,
            ),
        )?;
    }
    if reader.catalog()?["libraries"] != catalog["libraries"] {
        return Err("检索期间资料库资格已变化，请重新查找".into());
    }
    permit.checkpoint()?;
    Ok(
        json!({"candidates":found,"queries":queries,"limitReached":limited,"unavailableCandidates":unavailable,"exhaustive":false,"retrieval":"localLexical","sourceFreshness":"notVerifiedWithRemote"}),
    )
}

#[cfg(all(test, windows))]
mod evaluation;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source_evidence::tests::Fixture;
    #[test]
    fn history_lookup_finds_unselected_notes_without_granting_or_writing() {
        let f = Fixture::new();
        f.note("notes", "current", "本次需要验证孔位。");
        f.note("notes", "old", "孔位经验：先小样验证，再扩批。");
        f.note("private", "secret", "孔位 PRIVATE");
        f.index();
        let args = json!({"action":"insightHistorySearch","libraryIds":["notes"],"notes":[super::super::tests::note("current")],"query":"孔位"});
        let before: i64 = f
            .c()
            .query_row("SELECT count(*) FROM agent_records", [], |r| r.get(0))
            .unwrap();
        let result = ui(&f.root, &args).unwrap();
        assert_eq!(result["candidates"].as_array().unwrap().len(), 1);
        assert_eq!(result["candidates"][0]["locator"]["documentId"], "old");
        assert!(!result.to_string().contains("PRIVATE"));
        assert_eq!(result["exhaustive"], false);
        assert_eq!(
            f.c()
                .query_row("SELECT count(*) FROM agent_records", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            before
        );
        let mut empty = args.clone();
        empty["libraryIds"] = json!([]);
        assert!(ui(&f.root, &empty).is_err());
        let mut no = args.clone();
        no["query"] = json!("降噪耳机");
        assert_eq!(ui(&f.root, &no).unwrap()["candidates"], json!([]));
        f.c()
            .execute("UPDATE libraries SET enabled=0 WHERE id='notes'", [])
            .unwrap();
        assert!(ui(&f.root, &args).is_err());
    }
    #[test]
    fn inferred_terms_are_bounded_and_not_an_applicability_claim() {
        assert!(terms("a 的 了").is_empty());
        let result = terms("Obsidian 整理方法 整理方法");
        assert!(result.contains(&"整理".into()));
        assert!(result.len() <= 6);
    }
}
