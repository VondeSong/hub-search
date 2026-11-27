use crate::*;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::time::Instant;

const MAX_MATERIAL_TEXT_BYTES: usize = 48_000;
const MAX_MATERIAL_META_BYTES: usize = 200;
const MAX_BUNDLE_ITEMS: usize = 8;
const DEFAULT_RECALL_LIMIT: usize = 3;
const MAX_RECALL_LIMIT: usize = 5;

#[derive(Clone, Debug, Deserialize, serde::Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Key {
    kind: String,
    id: String,
    library_id: Option<String>,
}

struct LoadedItem {
    key: Key,
    id: String,
    title: String,
    source: String,
    text: String,
}

fn truncate_utf8(input: &str, max_bytes: usize) -> &str {
    if input.len() <= max_bytes {
        return input;
    }
    let mut end = 0;
    for (idx, ch) in input.char_indices() {
        let next = idx + ch.len_utf8();
        if next > max_bytes {
            break;
        }
        end = next;
    }
    &input[..end]
}

fn clip_utf8_with_ellipsis(input: &str, max_bytes: usize) -> String {
    let trimmed = input.trim();
    if trimmed.len() <= max_bytes {
        return trimmed.to_owned();
    }
    let suffix = "…";
    if max_bytes <= suffix.len() {
        return truncate_utf8(trimmed, max_bytes).to_owned();
    }
    let head = truncate_utf8(trimmed, max_bytes - suffix.len()).trim_end();
    format!("{head}{suffix}")
}

fn sanitize_inline_meta(input: &str) -> String {
    input
        .replace(['\r', '\n'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn snapshot_json(id: &str, title: &str, source: &str, text: &str) -> Value {
    json!({
        "id": id,
        "title": title,
        "source": source,
        "text": text,
        "sha256": format!("{:x}", Sha256::digest(text.as_bytes())),
    })
}

fn item_id(key: &Key) -> Result<String, String> {
    let encoded = serde_json::to_vec(key).map_err(|e| e.to_string())?;
    Ok(format!("{:x}", Sha256::digest(encoded)))
}

fn load_item(c: &Connection, key: &Key) -> Result<LoadedItem, String> {
    let (title, source, text): (String, String, String) = match key.kind.as_str() {
        "document" => c.query_row(
            "SELECT d.title,l.name,d.markdown FROM documents d JOIN libraries l ON l.id=d.space_id WHERE d.id=?1 AND d.space_id=?2 AND l.enabled=1",
            params![key.id, key.library_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ),
        "journal" if key.library_id.is_none() => c.query_row(
            "SELECT substr(json_extract(payload,'$.text'),1,60),json_extract(payload,'$.date'),json_extract(payload,'$.text') FROM quick_journal_records WHERE id=?1",
            [&key.id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ),
        _ => return Err("资料类型无效".into()),
    }
    .map_err(|_| "这份资料尚未下载、已移除或不再可读，请重新选择")?;
    Ok(LoadedItem {
        id: item_id(key)?,
        key: key.clone(),
        title,
        source,
        text,
    })
}

fn pack_bundle(items: &[LoadedItem], mode: &str, max_bytes: usize) -> Result<Value, String> {
    if items.is_empty() {
        return Err("请至少选择一份资料".into());
    }
    let is_auto = mode == "auto-rag";
    let header_tag = if is_auto {
        format!("【本机自动召回 · {} 份资料】\n\n", items.len())
    } else {
        format!("【手动指定 · {} 份资料】\n\n", items.len())
    };
    let mut sections = Vec::with_capacity(items.len());
    for (idx, item) in items.iter().enumerate() {
        let clean_title = clip_utf8_with_ellipsis(&sanitize_inline_meta(&item.title), 120);
        let clean_source = clip_utf8_with_ellipsis(&sanitize_inline_meta(&item.source), 80);
        sections.push(format!(
            "### [资料{}] {}（{}）\n{}",
            idx + 1,
            if clean_title.is_empty() {
                "未命名资料"
            } else {
                &clean_title
            },
            if clean_source.is_empty() {
                "本机资料"
            } else {
                &clean_source
            },
            item.text.trim()
        ));
    }
    let packed_text = format!("{header_tag}{}", sections.join("\n\n---\n\n"));
    if packed_text.trim().is_empty() || packed_text.len() > max_bytes.min(MAX_MATERIAL_TEXT_BYTES) {
        return Err("所选资料合计超过 48 KB，请减少选择；不会自动截断原文".into());
    }
    let names = items
        .iter()
        .map(|item| {
            let clean = sanitize_inline_meta(&item.title);
            if clean.is_empty() {
                "未命名资料".to_owned()
            } else {
                clean
            }
        })
        .collect::<Vec<_>>()
        .join("、");
    let title_prefix = if is_auto {
        format!("自动关联 {} 份资料：", items.len())
    } else {
        format!("已选 {} 份资料：", items.len())
    };
    let title = clip_utf8_with_ellipsis(&format!("{title_prefix}{names}"), MAX_MATERIAL_META_BYTES);
    let kb = (packed_text.len() as f64) / 1024.0;
    let source = clip_utf8_with_ellipsis(
        &format!(
            "{} · {} 份 · {:.1} KB",
            if is_auto {
                "本机自动召回"
            } else {
                "手动指定"
            },
            items.len(),
            kb
        ),
        MAX_MATERIAL_META_BYTES,
    );
    let mut id_hasher = Sha256::new();
    id_hasher.update(mode.as_bytes());
    id_hasher.update(b"\n");
    for item in items {
        id_hasher.update(item.id.as_bytes());
        id_hasher.update(b"\n");
    }
    let bundle_id = format!("{:x}", id_hasher.finalize());
    Ok(snapshot_json(&bundle_id, &title, &source, &packed_text))
}

fn extract_query_terms(query: &str) -> Vec<String> {
    let mut terms = Vec::new();
    let mut seen = HashSet::new();
    let mut push_term = |candidate: String| {
        let normalized = candidate.trim().to_lowercase();
        if normalized.chars().count() >= 2 && seen.insert(normalized.clone()) {
            terms.push(normalized);
        }
    };
    for raw in query.split(|ch: char| {
        ch.is_whitespace()
            || matches!(
                ch,
                ',' | '.'
                    | '!'
                    | '?'
                    | ';'
                    | ':'
                    | '/'
                    | '\\'
                    | '('
                    | ')'
                    | '['
                    | ']'
                    | '{'
                    | '}'
                    | '，'
                    | '。'
                    | '！'
                    | '？'
                    | '；'
                    | '：'
                    | '、'
                    | '（'
                    | '）'
                    | '《'
                    | '》'
                    | '“'
                    | '”'
                    | '"'
                    | '\''
            )
    }) {
        let token = raw.trim();
        if token.is_empty() {
            continue;
        }
        push_term(token.to_owned());
        let chars: Vec<char> = token.chars().collect();
        if chars.len() >= 4 && chars.iter().all(|c| !c.is_ascii()) {
            for win in chars.windows(2).take(12) {
                push_term(win.iter().collect());
            }
        }
    }
    if terms.is_empty() {
        let fallback = query.trim().to_lowercase();
        if !fallback.is_empty() {
            terms.push(fallback);
        }
    }
    terms.truncate(16);
    terms
}

fn excerpt_around_terms(text: &str, terms: &[String], budget_bytes: usize) -> String {
    let trimmed = text.trim();
    if trimmed.len() <= budget_bytes {
        return trimmed.to_owned();
    }
    let suffix = "\n…（本机自动召回已截取相关片段）";
    if budget_bytes <= suffix.len() + 32 {
        return clip_utf8_with_ellipsis(trimmed, budget_bytes);
    }
    let body_budget = budget_bytes - suffix.len();
    // Map lowercase UTF-8 byte offsets back to exact original UTF-8 byte offsets
    // so characters whose lowercase form changes byte length (e.g. 'İ') never drift.
    let mut lowered = String::with_capacity(trimmed.len());
    let mut lower_to_orig: Vec<usize> = Vec::with_capacity(trimmed.len());
    for (orig_byte, ch) in trimmed.char_indices() {
        for lc in ch.to_lowercase() {
            let mut buf = [0u8; 4];
            let encoded = lc.encode_utf8(&mut buf);
            lowered.push_str(encoded);
            for _ in 0..encoded.len() {
                lower_to_orig.push(orig_byte);
            }
        }
    }
    let hit_byte = terms
        .iter()
        .filter_map(|term| lowered.find(term))
        .min()
        .and_then(|pos| lower_to_orig.get(pos).copied())
        .unwrap_or(0);
    let target_start = hit_byte.saturating_sub(body_budget / 4);
    let mut start = 0;
    if target_start > 0 && target_start < trimmed.len() {
        for (idx, _) in trimmed.char_indices() {
            if idx >= target_start {
                start = idx;
                break;
            }
        }
    }
    if start > 0 {
        let prefix = "…";
        let inner_budget = body_budget.saturating_sub(prefix.len());
        let slice = truncate_utf8(&trimmed[start..], inner_budget).trim();
        format!("{prefix}{slice}{suffix}")
    } else {
        let slice = truncate_utf8(trimmed, body_budget).trim();
        format!("{slice}{suffix}")
    }
}

pub(super) fn list(root: &Path, kind: &str, query: &str, offset: u32) -> Result<Value, String> {
    if !matches!(kind, "document" | "journal") || query.chars().count() > 200 || offset > 10000 {
        return Err("资料查找范围无效".into());
    }
    let _permit = library_runtime::cached_read_permit(root)?;
    let c = source_evidence::open_read_database(root)?;
    if kind == "journal" && !c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='quick_journal_records')",[],|r|r.get::<_,bool>(0)).map_err(|e|e.to_string())? {
        return Ok(json!({"items":[],"more":false}));
    }
    let sql = if kind == "document" {
        "SELECT d.id,d.space_id,d.title,l.name,length(d.markdown),length(CAST(d.markdown AS BLOB)),substr(d.markdown,1,140) FROM documents d JOIN libraries l ON l.id=d.space_id WHERE l.enabled=1 AND length(trim(d.markdown))>0 AND (instr(lower(d.title),lower(?1))>0 OR instr(lower(d.markdown),lower(?1))>0) ORDER BY d.title,d.space_id,d.id LIMIT 21 OFFSET ?2"
    } else {
        "SELECT id,NULL,substr(json_extract(payload,'$.text'),1,60),json_extract(payload,'$.date'),length(json_extract(payload,'$.text')),length(CAST(json_extract(payload,'$.text') AS BLOB)),substr(json_extract(payload,'$.text'),1,140) FROM quick_journal_records WHERE instr(lower(json_extract(payload,'$.text')),lower(?1))>0 ORDER BY seq DESC LIMIT 21 OFFSET ?2"
    };
    let mut s = c.prepare(sql).map_err(|e| e.to_string())?;
    let rows = s
        .query_map(params![query.trim(), offset], |r| {
            let key = Key {
                kind: kind.into(),
                id: r.get(0)?,
                library_id: r.get(1)?,
            };
            Ok(json!({
                "key": key,
                "title": r.get::<_, String>(2)?,
                "source": r.get::<_, String>(3)?,
                "chars": r.get::<_, i64>(4)?,
                "bytes": r.get::<_, i64>(5)?,
                "preview": r.get::<_, String>(6)?,
            }))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(json!({"items":rows.iter().take(20).collect::<Vec<_>>(),"more":rows.len()>20}))
}

pub(super) fn prepare(root: &Path, selection: Value) -> Result<Value, String> {
    let key: Key = serde_json::from_value(selection).map_err(|_| "资料定位无效")?;
    let _permit = library_runtime::cached_read_permit(root)?;
    let c = source_evidence::open_read_database(root)?;
    let item = load_item(&c, &key)?;
    if item.text.trim().is_empty()
        || item.text.len() > MAX_MATERIAL_TEXT_BYTES
        || item.title.len() > MAX_MATERIAL_META_BYTES
        || item.source.len() > MAX_MATERIAL_META_BYTES
    {
        return Err("所选正文为空或超过 48 KB，请选择较短的已下载资料；不会自动截断原文".into());
    }
    Ok(snapshot_json(
        &item.id,
        &item.title,
        &item.source,
        &item.text,
    ))
}

pub(super) fn prepare_bundle(
    root: &Path,
    selections: Vec<Value>,
    mode: Option<String>,
    expected_sha256: Option<Vec<String>>,
) -> Result<Value, String> {
    if selections.is_empty() || selections.len() > MAX_BUNDLE_ITEMS {
        return Err(format!("单次最多选择 {MAX_BUNDLE_ITEMS} 份资料"));
    }
    if let Some(ref hashes) = expected_sha256 {
        if hashes.len() != selections.len() {
            return Err("所选资料校验信息不匹配，请重新勾选后再发送".into());
        }
    }
    let resolved_mode = match mode.as_deref() {
        Some("auto-rag") => "auto-rag",
        Some("manual") | None => "manual",
        _ => return Err("资料打包模式无效".into()),
    };
    let mut entries: Vec<(Key, Option<String>)> = Vec::new();
    let mut seen = HashSet::new();
    for (idx, raw) in selections.into_iter().enumerate() {
        let key: Key = serde_json::from_value(raw).map_err(|_| "资料定位无效")?;
        let hash = expected_sha256
            .as_ref()
            .and_then(|list| list.get(idx))
            .cloned();
        if seen.insert(key.clone()) {
            entries.push((key, hash));
        }
    }
    if entries.len() == 1 && resolved_mode == "manual" {
        let (key, expected_hash) = &entries[0];
        let single = prepare(root, serde_json::to_value(key).map_err(|e| e.to_string())?)?;
        if let Some(expected) = expected_hash {
            if single["sha256"].as_str() != Some(expected.as_str()) {
                return Err(format!(
                    "所选资料「{}」内容已更新，请重新预览确认后再发送；草稿已保留",
                    single["title"].as_str().unwrap_or("未命名资料")
                ));
            }
        }
        let total_bytes = single["text"].as_str().map(|s| s.len()).unwrap_or(0);
        return Ok(json!({
            "bundle": single,
            "items": [single],
            "totalBytes": total_bytes,
        }));
    }
    let _permit = library_runtime::cached_read_permit(root)?;
    let c = source_evidence::open_read_database(root)?;
    let mut loaded = Vec::with_capacity(entries.len());
    for (key, expected_hash) in &entries {
        let item = load_item(&c, key)?;
        if item.text.trim().is_empty() {
            return Err("所选资料中包含空正文，请重新选择".into());
        }
        if let Some(expected) = expected_hash {
            let actual = format!("{:x}", Sha256::digest(item.text.as_bytes()));
            if actual != *expected {
                return Err(format!(
                    "所选资料「{}」内容已更新，请重新预览确认后再发送；草稿已保留",
                    clip_utf8_with_ellipsis(&sanitize_inline_meta(&item.title), 60)
                ));
            }
        }
        loaded.push(item);
    }
    let bundle = pack_bundle(&loaded, resolved_mode, MAX_MATERIAL_TEXT_BYTES)?;
    let total_bytes = bundle["text"].as_str().map(|s| s.len()).unwrap_or(0);
    let item_snapshots = loaded
        .iter()
        .map(|item| {
            let safe_title = clip_utf8_with_ellipsis(
                &sanitize_inline_meta(&item.title),
                MAX_MATERIAL_META_BYTES,
            );
            let safe_source = clip_utf8_with_ellipsis(
                &sanitize_inline_meta(&item.source),
                MAX_MATERIAL_META_BYTES,
            );
            snapshot_json(&item.id, &safe_title, &safe_source, item.text.trim())
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "bundle": bundle,
        "items": item_snapshots,
        "totalBytes": total_bytes,
    }))
}

pub(super) fn recall(
    root: &Path,
    query: &str,
    limit: Option<u32>,
    max_bytes: Option<u32>,
    space_ids: Option<Vec<String>>,
) -> Result<Value, String> {
    let trimmed_owned: String = query.trim().chars().take(2000).collect();
    let trimmed = trimmed_owned.as_str();
    if trimmed.is_empty() {
        return Ok(json!({ "items": [], "bundle": Value::Null, "totalBytes": 0, "elapsedMs": 0 }));
    }
    let cap = (limit.unwrap_or(DEFAULT_RECALL_LIMIT as u32) as usize).clamp(1, MAX_RECALL_LIMIT);
    let budget = (max_bytes.unwrap_or(MAX_MATERIAL_TEXT_BYTES as u32) as usize)
        .clamp(1024, MAX_MATERIAL_TEXT_BYTES);
    let started = Instant::now();
    let _permit = library_runtime::cached_read_permit(root)?;
    let c = source_evidence::open_read_database(root)?;

    let mut stmt = c
        .prepare("SELECT id FROM libraries WHERE enabled=1 ORDER BY id")
        .map_err(|e| e.to_string())?;
    let enabled_ids: Vec<String> = stmt
        .query_map([], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    if matches!(space_ids.as_ref(), Some(ids) if ids.is_empty()) {
        return Ok(json!({
            "items": [],
            "bundle": Value::Null,
            "totalBytes": 0,
            "elapsedMs": started.elapsed().as_millis() as u64,
        }));
    }
    let filter_set: Option<HashSet<String>> = space_ids.map(|ids| ids.into_iter().collect());
    let allowed_spaces: Vec<String> = enabled_ids
        .into_iter()
        .filter(|id| filter_set.as_ref().is_none_or(|set| set.contains(id)))
        .collect();
    let allowed_space_set: HashSet<String> = allowed_spaces.iter().cloned().collect();

    let mut chosen_keys: Vec<Key> = Vec::new();
    let mut seen_keys: HashSet<Key> = HashSet::new();

    if !allowed_spaces.is_empty() {
        if let Ok(index) = source_evidence::open_search_index(root, &c) {
            if let Ok(hits) = index.search_with_space_ids_and_field_scope(
                trimmed,
                cap * 4,
                Some(&allowed_spaces),
                None,
                None,
                true,
                false,
                false,
                false,
                false,
                "all",
            ) {
                for hit in hits {
                    if chosen_keys.len() >= cap {
                        break;
                    }
                    if !allowed_space_set.contains(&hit.space_id) {
                        continue;
                    }
                    let key = Key {
                        kind: "document".into(),
                        id: hit.document_id,
                        library_id: Some(hit.space_id),
                    };
                    if seen_keys.contains(&key) {
                        continue;
                    }
                    if let Ok(item) = load_item(&c, &key) {
                        if !item.text.trim().is_empty() {
                            seen_keys.insert(key.clone());
                            chosen_keys.push(key);
                        }
                    }
                }
            }
        }
    }

    let terms = extract_query_terms(trimmed);
    if chosen_keys.len() < cap && !terms.is_empty() {
        let mut candidates: Vec<(i32, Key)> = Vec::new();
        if !allowed_spaces.is_empty() {
            let mut doc_stmt = c
                .prepare("SELECT d.id,d.space_id,d.title,d.markdown FROM documents d JOIN libraries l ON l.id=d.space_id WHERE l.enabled=1 AND length(trim(d.markdown))>0 LIMIT 400")
                .map_err(|e| e.to_string())?;
            let rows = doc_stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            for row in rows.flatten() {
                let (doc_id, space_id, title, body) = row;
                if !allowed_space_set.contains(&space_id) {
                    continue;
                }
                let key = Key {
                    kind: "document".into(),
                    id: doc_id,
                    library_id: Some(space_id),
                };
                if seen_keys.contains(&key) {
                    continue;
                }
                let title_lower = title.to_lowercase();
                let body_lower = body.to_lowercase();
                let mut score = 0i32;
                for term in &terms {
                    if title_lower.contains(term) {
                        score += 5;
                    }
                    if body_lower.contains(term) {
                        score += 2;
                    }
                }
                if score > 0 {
                    candidates.push((score, key));
                }
            }
        }
        let has_journal = c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='quick_journal_records')",
                [],
                |r| r.get::<_, bool>(0),
            )
            .unwrap_or(false);
        if has_journal && filter_set.is_none() {
            if let Ok(mut j_stmt) = c.prepare("SELECT id,json_extract(payload,'$.text') FROM quick_journal_records ORDER BY seq DESC LIMIT 120") {
                if let Ok(j_rows) = j_stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) {
                    for row in j_rows.flatten() {
                        let (jid, text) = row;
                        let key = Key { kind: "journal".into(), id: jid, library_id: None };
                        if seen_keys.contains(&key) {
                            continue;
                        }
                        let lower = text.to_lowercase();
                        let score: i32 = terms.iter().map(|term| if lower.contains(term) { 2 } else { 0 }).sum();
                        if score > 0 {
                            candidates.push((score, key));
                        }
                    }
                }
            }
        }
        candidates.sort_by(|a, b| b.0.cmp(&a.0));
        for (_, key) in candidates {
            if chosen_keys.len() >= cap {
                break;
            }
            if seen_keys.insert(key.clone()) {
                chosen_keys.push(key);
            }
        }
    }

    if chosen_keys.is_empty() {
        return Ok(json!({
            "items": [],
            "bundle": Value::Null,
            "totalBytes": 0,
            "elapsedMs": started.elapsed().as_millis() as u64,
        }));
    }

    let mut raw_items = Vec::new();
    for key in &chosen_keys {
        if let Ok(item) = load_item(&c, key) {
            if !item.text.trim().is_empty() {
                raw_items.push(item);
            }
        }
    }
    if raw_items.is_empty() {
        return Ok(json!({
            "items": [],
            "bundle": Value::Null,
            "totalBytes": 0,
            "elapsedMs": started.elapsed().as_millis() as u64,
        }));
    }

    // Compute exact header/separator overhead dynamically and reduce item count
    // when budget is tight (e.g. maxBytes=1024 with 5 hits) so pack_bundle always fits.
    let banner_bytes = format!("【本机自动召回 · {} 份资料】\n\n", raw_items.len()).len();
    let separator_bytes = "\n\n---\n\n".len();
    let header_bytes_for = |idx: usize, item: &LoadedItem| -> usize {
        let clean_title = clip_utf8_with_ellipsis(&sanitize_inline_meta(&item.title), 120);
        let clean_source = clip_utf8_with_ellipsis(&sanitize_inline_meta(&item.source), 80);
        format!(
            "### [资料{}] {}（{}）\n",
            idx + 1,
            if clean_title.is_empty() {
                "未命名资料"
            } else {
                &clean_title
            },
            if clean_source.is_empty() {
                "本机资料"
            } else {
                &clean_source
            },
        )
        .len()
    };
    let min_body_per_item = 128usize;
    while raw_items.len() > 1 {
        let headers_sum: usize = raw_items
            .iter()
            .enumerate()
            .map(|(i, item)| header_bytes_for(i, item))
            .sum();
        let total_overhead =
            banner_bytes + headers_sum + separator_bytes * raw_items.len().saturating_sub(1);
        if total_overhead + raw_items.len() * min_body_per_item <= budget {
            break;
        }
        raw_items.pop();
    }
    let raw_count = raw_items.len();
    let exact_banner = format!("【本机自动召回 · {} 份资料】\n\n", raw_count).len();
    let headers_sum: usize = raw_items
        .iter()
        .enumerate()
        .map(|(i, item)| header_bytes_for(i, item))
        .sum();
    let exact_overhead = exact_banner + headers_sum + separator_bytes * raw_count.saturating_sub(1);
    let available = budget.saturating_sub(exact_overhead);
    if available < 32 {
        return Ok(json!({
            "items": [],
            "bundle": Value::Null,
            "totalBytes": 0,
            "elapsedMs": started.elapsed().as_millis() as u64,
        }));
    }
    let mut prepared_items = Vec::with_capacity(raw_count);
    let mut used = 0usize;
    for (idx, item) in raw_items.into_iter().enumerate() {
        let remaining_slots = raw_count.saturating_sub(idx).max(1);
        let remaining_budget = available.saturating_sub(used);
        if remaining_budget < 32 {
            break;
        }
        let share = (remaining_budget / remaining_slots)
            .max(32)
            .min(remaining_budget);
        let excerpt = excerpt_around_terms(&item.text, &terms, share);
        if excerpt.trim().is_empty() {
            continue;
        }
        used += excerpt.len();
        prepared_items.push(LoadedItem {
            key: item.key,
            id: item.id,
            title: item.title,
            source: item.source,
            text: excerpt,
        });
    }
    if prepared_items.is_empty() {
        return Ok(json!({
            "items": [],
            "bundle": Value::Null,
            "totalBytes": 0,
            "elapsedMs": started.elapsed().as_millis() as u64,
        }));
    }

    let bundle = pack_bundle(&prepared_items, "auto-rag", budget)?;
    let total_bytes = bundle["text"].as_str().map(|s| s.len()).unwrap_or(0);
    let item_snapshots = prepared_items
        .iter()
        .map(|item| {
            let safe_title = clip_utf8_with_ellipsis(
                &sanitize_inline_meta(&item.title),
                MAX_MATERIAL_META_BYTES,
            );
            let safe_source = clip_utf8_with_ellipsis(
                &sanitize_inline_meta(&item.source),
                MAX_MATERIAL_META_BYTES,
            );
            snapshot_json(&item.id, &safe_title, &safe_source, &item.text)
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "items": item_snapshots,
        "bundle": bundle,
        "totalBytes": total_bytes,
        "elapsedMs": started.elapsed().as_millis() as u64,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_selection_rechecks_library_and_rejects_oversize_without_truncation() {
        let f = crate::source_evidence::tests::Fixture::new();
        f.note("notes", "current", "Source text");
        let selection = json!({"kind":"document","id":"current","libraryId":"notes"});
        let snapshot = prepare(&f.root, selection.clone()).unwrap();
        assert_eq!(snapshot["text"], "Source text");
        assert_eq!(
            snapshot["sha256"],
            format!("{:x}", Sha256::digest(b"Source text"))
        );
        f.c()
            .execute("UPDATE libraries SET enabled=0 WHERE id='notes'", [])
            .unwrap();
        assert!(prepare(&f.root, selection.clone()).is_err());
        assert!(list(&f.root, "document", "Source", 0).unwrap()["items"]
            .as_array()
            .unwrap()
            .is_empty());
        f.c()
            .execute("UPDATE libraries SET enabled=1 WHERE id='notes'", [])
            .unwrap();
        f.note("notes", "current", &"x".repeat(48001));
        assert!(prepare(&f.root, selection).unwrap_err().contains("48 KB"));
    }

    #[test]
    fn prepare_bundle_packs_multiple_materials_verifies_hashes_and_enforces_exact_utf8_budget() {
        let f = crate::source_evidence::tests::Fixture::new();
        let text_a = "第一篇中文混合检索方案说明";
        let text_b = "第二篇个人云端接入规范";
        f.note("notes", "doc-a", text_a);
        f.note("notes", "doc-b", text_b);
        let hash_a = format!("{:x}", Sha256::digest(text_a.as_bytes()));
        let hash_b = format!("{:x}", Sha256::digest(text_b.as_bytes()));
        let packed = prepare_bundle(
            &f.root,
            vec![
                json!({"kind":"document","id":"doc-a","libraryId":"notes"}),
                json!({"kind":"document","id":"doc-b","libraryId":"notes"}),
            ],
            Some("manual".into()),
            Some(vec![hash_a.clone(), hash_b.clone()]),
        )
        .unwrap();
        let text = packed["bundle"]["text"].as_str().unwrap();
        assert!(text.contains("### [资料1]"));
        assert!(text.contains("### [资料2]"));
        assert_eq!(
            packed["bundle"]["sha256"],
            format!("{:x}", Sha256::digest(text.as_bytes()))
        );
        assert!(packed["bundle"]["title"].as_str().unwrap().len() <= MAX_MATERIAL_META_BYTES);
        assert!(packed["bundle"]["source"].as_str().unwrap().len() <= MAX_MATERIAL_META_BYTES);

        // If doc-b changed after the user checked it, stale hash must be rejected.
        f.note("notes", "doc-b", "已被同步更新的新正文");
        let stale = prepare_bundle(
            &f.root,
            vec![
                json!({"kind":"document","id":"doc-a","libraryId":"notes"}),
                json!({"kind":"document","id":"doc-b","libraryId":"notes"}),
            ],
            Some("manual".into()),
            Some(vec![hash_a.clone(), hash_b]),
        )
        .unwrap_err();
        assert!(stale.contains("已更新"));

        f.note("notes", "huge", &"中".repeat(17000));
        let err = prepare_bundle(
            &f.root,
            vec![
                json!({"kind":"document","id":"doc-a","libraryId":"notes"}),
                json!({"kind":"document","id":"huge","libraryId":"notes"}),
            ],
            Some("manual".into()),
            None,
        )
        .unwrap_err();
        assert!(err.contains("48 KB"));
    }

    #[test]
    fn recall_respects_enabled_libraries_space_scope_unicode_offsets_and_tight_budget() {
        let f = crate::source_evidence::tests::Fixture::new();
        let long_cn = format!(
            "{}移动端混合检索方案核心结论：启用分库位图后延迟降至 14ms。{}",
            "前情提要".repeat(900),
            "后续补充".repeat(900)
        );
        f.note("notes", "rag-doc", &long_cn);
        f.note("other", "other-doc", "移动端混合检索方案在另一个库里的记录");

        let scoped = recall(
            &f.root,
            "移动端混合检索方案延迟是多少",
            Some(3),
            Some(4096),
            Some(vec!["notes".into()]),
        )
        .unwrap();
        let items = scoped["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        let bundle_text = scoped["bundle"]["text"].as_str().unwrap();
        assert!(bundle_text.len() <= 4096);
        assert!(bundle_text.contains("14ms"));
        assert_eq!(
            scoped["bundle"]["sha256"],
            format!("{:x}", Sha256::digest(bundle_text.as_bytes()))
        );

        // Long query (>2000 chars) must not error in recall.
        let long_query = format!("移动端混合检索方案 {}", "a".repeat(2500));
        let long_res = recall(
            &f.root,
            &long_query,
            Some(3),
            Some(4096),
            Some(vec!["notes".into()]),
        )
        .unwrap();
        assert_eq!(long_res["items"].as_array().unwrap().len(), 1);

        // Turkish dotted İ changes UTF-8 length on lowercase; needle must still be captured accurately.
        f.c()
            .execute_batch(
                "INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES('uni','obsidian','Uni',1,1),('tight','obsidian','Tight',1,1);",
            )
            .unwrap();
        let unicode_doc = format!(
            "{}needle_marker_42{}",
            "İ".repeat(8000),
            "tail".repeat(2000)
        );
        f.note("uni", "uni-doc", &unicode_doc);
        let uni_res = recall(
            &f.root,
            "needle_marker_42",
            Some(1),
            Some(2048),
            Some(vec!["uni".into()]),
        )
        .unwrap();
        let uni_text = uni_res["bundle"]["text"].as_str().unwrap();
        assert!(uni_text.len() <= 2048);
        assert!(uni_text.contains("needle_marker_42"));

        // Tight budget (1024 bytes) with 5 long hits must reduce item count cleanly and stay <= 1024.
        for idx in 0..5 {
            f.note(
                "tight",
                &format!("doc-{idx}"),
                &format!("tight_budget_token {}", "长正文内容".repeat(400)),
            );
        }
        let tight_res = recall(
            &f.root,
            "tight_budget_token",
            Some(5),
            Some(1024),
            Some(vec!["tight".into()]),
        )
        .unwrap();
        let tight_text = tight_res["bundle"]["text"].as_str().unwrap();
        assert!(tight_text.len() <= 1024);
        assert!(!tight_res["items"].as_array().unwrap().is_empty());

        f.c()
            .execute("UPDATE libraries SET enabled=0 WHERE id='notes'", [])
            .unwrap();
        let disabled = recall(
            &f.root,
            "移动端混合检索方案",
            Some(3),
            Some(4096),
            Some(vec!["notes".into()]),
        )
        .unwrap();
        assert!(disabled["items"].as_array().unwrap().is_empty());
        assert!(disabled["bundle"].is_null());

        // Explicit empty space_ids ([]) must never fall back to all libraries or journals.
        let empty_scope = recall(
            &f.root,
            "needle_marker_42",
            Some(3),
            Some(4096),
            Some(vec![]),
        )
        .unwrap();
        assert!(empty_scope["items"].as_array().unwrap().is_empty());
        assert!(empty_scope["bundle"].is_null());
    }
}
