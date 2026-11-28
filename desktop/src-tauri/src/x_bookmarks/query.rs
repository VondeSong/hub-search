//! Collection-only navigation and filters, evaluated against the complete local store.
use super::*;

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct Filters {
    pub(crate) compact: bool,
    pub(crate) separate_overview: bool,
    pub(crate) previous_counts: Option<[i64; 3]>,
    pub(crate) previous_counts_revision: Option<super::view_revision::Version>,
    pub(crate) item_key: Option<String>,
    pub(crate) tags: Vec<String>,
    pub(crate) library_id: Option<String>,
    pub(crate) collected_within_days: Option<u32>,
    /// Inclusive start and exclusive end in epoch seconds, supplied from the
    /// user's local civil-date window. The collection store uses milliseconds.
    pub(crate) collected_from: Option<i64>,
    pub(crate) collected_to: Option<i64>,
    pub(crate) include_abandoned: bool,
}

// Keep first-page reads on a covering index. SQLite maintains this projection on
// post changes and backfills existing collections once when creating the index.
const LIST_POST: &str = "CASE WHEN json_valid(post_json) THEN json_set(
    json_remove(post_json,'$.thread','$.quote','$.threadCursors','$.threadSeenCursors'),
    '$.text',substr(trim(json_extract(post_json,'$.text')),1,480),
    '$.quotedText','','$.links',json('[]')) ELSE post_json END";

pub(super) fn ensure_list_index(c: &Connection) -> Result<(), String> {
    c.execute_batch(&format!(
        "CREATE INDEX IF NOT EXISTS collection_list_summary_v1
        ON collection_x_items(item_key,{LIST_POST},content_hash)"
    ))
    .map_err(|e| e.to_string())
}

const STATE: &str = "COALESCE((SELECT state FROM collection_lifecycle l WHERE l.item_key=collection_x_items.item_key),'active')";
const STATUS: &str = "COALESCE((SELECT status FROM collection_x_properties p WHERE p.item_key=collection_x_items.item_key),CASE WHEN read_at>0 THEN 'read' ELSE 'unread' END)";
const SOURCE: &str = "COALESCE(NULLIF(json_extract(post_json,'$.source'),''),'bookmarks')";

/// Canonical collection projection for evidence. No navigation counts, disk
/// probes, cloud previews or write jobs are activated by this reader.
pub(crate) struct EvidenceEntry {
    pub(crate) item: Item,
    pub(crate) source_hash: String,
    pub(crate) read_version: i64,
    pub(crate) status: String,
    pub(crate) tags: Vec<String>,
    pub(crate) state: String,
    pub(crate) lifecycle_revision: i64,
}

/// URL identity only; keep the same authorization and lifecycle as evidence reads.
pub(crate) fn evidence_link_identities(
    c: &Connection,
    authorized_keys: &[String],
) -> Result<Vec<(String, String)>, String> {
    if authorized_keys.is_empty() {
        return Ok(Vec::new());
    }
    let keys = serde_json::to_string(authorized_keys).map_err(|e| e.to_string())?;
    let mut statement = c.prepare(&format!(
        "SELECT item_key,json_extract(CASE WHEN json_valid(post_json) THEN post_json ELSE '{{}}' END,'$.url')
         FROM collection_x_items WHERE item_key IN (SELECT value FROM json_each(?1))
         AND {STATE} IN ('active','archived')
         AND json_type(CASE WHEN json_valid(post_json) THEN post_json ELSE '{{}}' END,'$.url')='text'
         ORDER BY item_key"
    )).map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([keys], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

pub(crate) fn evidence_entries(
    c: &Connection,
    authorized_keys: &[String],
    query: &str,
    limit: usize,
) -> Result<Vec<EvidenceEntry>, String> {
    if authorized_keys.is_empty() {
        return Ok(Vec::new());
    }
    let keys = serde_json::to_string(authorized_keys).map_err(|e| e.to_string())?;
    let mut statement = c.prepare(&format!(
        "SELECT item_key,post_json,collected_at,read_at,content_hash,read_version,{STATE},
         COALESCE((SELECT revision FROM collection_lifecycle l WHERE l.item_key=collection_x_items.item_key),0)
         FROM collection_x_items WHERE item_key IN (SELECT value FROM json_each(?1))
         AND (?2='' OR instr(lower(post_json),lower(?2))>0)
         AND {STATE} IN ('active','archived') ORDER BY collected_at DESC,item_key LIMIT ?3"
    )).map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(params![keys, query, limit as i64], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, i64>(7)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut entries = Vec::new();
    for row in rows {
        let (key, raw, collected_at, read_at, source_hash, read_version, state, lifecycle_revision) =
            row.map_err(|e| e.to_string())?;
        let (status, tags) = properties::load(c, &key, read_at > 0)?;
        entries.push(EvidenceEntry {
            item: Item {
                key,
                post: serde_json::from_str(&raw).map_err(|_| "阅读内容损坏")?,
                collected_at,
                read: read_at > 0,
            },
            source_hash,
            read_version,
            status,
            tags,
            state,
            lifecycle_revision,
        });
    }
    Ok(entries)
}
pub(super) const BLOCKED_OPERATION: &str = "phase NOT IN ('queued','ready','paused','cancelled') AND (phase IN ('partial','failed','unknown','needs_review') OR error<>'')";

fn source_filter(source: Option<&str>) -> Result<&str, String> {
    let source = source.unwrap_or("bookmarks");
    if !matches!(source, "all" | "bookmarks" | "likes" | "telegram" | "dida") {
        return Err("未知来源筛选".into());
    }
    Ok(source)
}

fn needs_attention() -> String {
    // Paused work is reset to queued/ready with no error. A retained review or
    // uncertain write still requires attention, including when another target is running.
    let blocked = BLOCKED_OPERATION;
    let selected = "NOT EXISTS(SELECT 1 FROM collection_library_destinations d WHERE d.item_key=j.item_key AND d.target=j.target AND d.selected=0)";
    format!("(EXISTS(SELECT 1 FROM collection_library_jobs j WHERE j.item_key=collection_x_items.item_key AND {blocked} AND {selected}) OR EXISTS(SELECT 1 FROM collection_library_pending j WHERE j.item_key=collection_x_items.item_key AND {blocked} AND {selected}) OR EXISTS(SELECT 1 FROM collection_x_outbox o WHERE o.item_key=collection_x_items.item_key AND o.error<>'') OR EXISTS(SELECT 1 FROM collection_x_enrichment e WHERE e.item_key=collection_x_items.item_key AND e.error<>''))")
}

pub(crate) fn saved_copies(c: &Connection) -> Result<String, String> {
    let remote = "SELECT DISTINCT r.item_key,r.library_id FROM collection_remote_copies r JOIN collection_library_destinations d ON d.item_key=r.item_key AND d.target=r.library_id AND d.state='saved' AND d.selected=1 WHERE r.verified=1 AND r.parent_id<>'attachment'";
    let has_libraries: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='libraries')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !has_libraries {
        return Ok(remote.into());
    }
    // A default vault can have been saved before the vault was added as a library.
    // Resolve its stable root to the currently configured library instead of the old hash target.
    Ok(format!("{remote} UNION SELECT e.item_key,l.id AS library_id FROM collection_obsidian_exports e JOIN collection_roots r ON r.destination=e.destination JOIN libraries l ON l.provider='obsidian' AND rtrim(replace(replace(lower(l.location),'\\','/'),'//?/',''),'/')=rtrim(replace(replace(lower(r.root),'\\','/'),'//?/',''),'/') WHERE e.media_pending=0 AND EXISTS(SELECT 1 FROM collection_library_destinations d WHERE d.item_key=e.item_key AND d.state='saved' AND d.selected=1 AND d.target IN (l.id,'vault:'||e.destination))"))
}

pub(super) fn navigation_counts(c: &Connection, source: Option<&str>) -> Result<Value, String> {
    let source = source_filter(source)?;
    let attention = needs_attention();
    let state = "COALESCE(l.state,'active')";
    let status = "COALESCE(p.status,CASE WHEN read_at>0 THEN 'read' ELSE 'unread' END)";
    let normal = format!("{state}='active' AND {status}<>'abandoned'");
    let sql = format!(
        "SELECT
        COALESCE(SUM({normal}),0),
        COALESCE(SUM({state}='active' AND {status}='unread'),0),
        COALESCE(SUM({state}='active' AND {status}='in_progress'),0),
        COALESCE(SUM({state}='active' AND {status}='read'),0),
        COALESCE(SUM({state}='archived'),0),
        COALESCE(SUM({state}='active' AND {status}='abandoned'),0),
        COALESCE(SUM({state} IN ('active','archived') AND {attention}),0)
        FROM collection_x_items
        LEFT JOIN collection_lifecycle l ON l.item_key=collection_x_items.item_key
        LEFT JOIN collection_x_properties p ON p.item_key=collection_x_items.item_key
        WHERE (?1='all' OR {SOURCE}=?1)"
    );
    let mut counts = c
        .query_row(&sql, [source], |r| {
            Ok(json!({
                "all":r.get::<_,i64>(0)?, "unread":r.get::<_,i64>(1)?,
                "inProgress":r.get::<_,i64>(2)?, "read":r.get::<_,i64>(3)?,
                "archived":r.get::<_,i64>(4)?, "abandoned":r.get::<_,i64>(5)?,
                "needsAttention":r.get::<_,i64>(6)?
            }))
        })
        .map_err(|e| e.to_string())?;
    let copies = saved_copies(c)?;
    let normal = format!("{STATE}='active' AND {STATUS}<>'abandoned'");
    let mut statement = c.prepare(&format!("WITH saved_copies AS ({copies}) SELECT s.library_id,count(DISTINCT s.item_key) FROM saved_copies s JOIN collection_x_items ON collection_x_items.item_key=s.item_key WHERE (?1='all' OR {SOURCE}=?1) AND {normal} GROUP BY s.library_id ORDER BY s.library_id")).map_err(|e|e.to_string())?;
    let values = statement
        .query_map([source], |r| {
            Ok(json!({"libraryId":r.get::<_,String>(0)?,"count":r.get::<_,i64>(1)?}))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    counts["savedCopies"] = json!(values);
    Ok(counts)
}

/// All source badges share one scan in the caller's read snapshot.
pub(super) fn source_counts(c: &Connection) -> Result<HashMap<String, i64>, String> {
    let mut statement = c
        .prepare(&format!(
            "SELECT {SOURCE},count(*) FROM collection_x_items
        LEFT JOIN collection_lifecycle l ON l.item_key=collection_x_items.item_key
        LEFT JOIN collection_x_properties p ON p.item_key=collection_x_items.item_key
        WHERE COALESCE(l.state,'active')='active'
          AND COALESCE(p.status,CASE WHEN read_at>0 THEN 'read' ELSE 'unread' END)<>'abandoned'
        GROUP BY {SOURCE}"
        ))
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<HashMap<_, _>, _>>()
        .map_err(|e| e.to_string())
}

#[allow(clippy::too_many_arguments)]
pub(super) fn items(
    c: &Connection,
    query: String,
    unread_only: bool,
    offset: u32,
    source: Option<String>,
    status: Option<String>,
    media: Option<String>,
    sort: Option<String>,
    ascending: Option<bool>,
    sorts: Option<Vec<sorting::Rule>>,
    filters: Filters,
) -> Result<(i64, i64, i64, Vec<Value>), String> {
    items_at(
        c,
        query,
        unread_only,
        offset,
        source,
        status,
        media,
        sort,
        ascending,
        sorts,
        filters,
        chrono::Utc::now().timestamp_millis(),
    )
}

#[allow(clippy::too_many_arguments)]
fn items_at(
    c: &Connection,
    query: String,
    unread_only: bool,
    offset: u32,
    source: Option<String>,
    status: Option<String>,
    media: Option<String>,
    sort: Option<String>,
    ascending: Option<bool>,
    sorts: Option<Vec<sorting::Rule>>,
    filters: Filters,
    now_ms: i64,
) -> Result<(i64, i64, i64, Vec<Value>), String> {
    let source = source_filter(source.as_deref())?;
    let status = status
        .as_deref()
        .unwrap_or(if unread_only { "unread" } else { "all" });
    let media = media.as_deref().unwrap_or("all");
    if !matches!(
        status,
        "all" | "unread" | "read" | "in_progress" | "abandoned" | "archived" | "needs_attention"
    ) || !matches!(media, "all" | "photo" | "video" | "links")
    {
        return Err("未知筛选条件".into());
    }
    if filters.tags.len() > 30
        || filters
            .tags
            .iter()
            .any(|t| t.trim().is_empty() || t.chars().count() > 100)
        || filters
            .library_id
            .as_ref()
            .is_some_and(|id| id.trim().is_empty() || id.len() > 512)
        || filters
            .collected_within_days
            .is_some_and(|days| days == 0 || days > 36600)
        || filters
            .collected_from
            .is_some_and(|seconds| seconds.checked_mul(1000).is_none())
        || filters
            .collected_to
            .is_some_and(|seconds| seconds.checked_mul(1000).is_none())
        || matches!((filters.collected_from, filters.collected_to), (Some(from), Some(to)) if from >= to)
    {
        return Err("收藏视图筛选条件无效".into());
    }
    // Keep legacy summary fields compatible; dedicated navigation counts use
    // actual status and exclude abandoned content from the normal collection.
    let cached_counts = filters
        .previous_counts
        .filter(|v| filters.compact && v.iter().all(|n| *n >= 0));
    let (total, unread): (i64, i64) = if let Some([total, unread, _]) = cached_counts {
        (total, unread)
    } else {
        c.query_row(&format!("SELECT COALESCE(SUM({STATE}='active'),0),COALESCE(SUM({STATE}='active' AND read_at=0),0) FROM collection_x_items"), [], |r|Ok((r.get(0)?,r.get(1)?))).map_err(|e|e.to_string())?
    };
    let order = sorting::order(sorts, sort, ascending)?;
    let search = query.trim().chars().take(200).collect::<String>();
    let include_abandoned = filters.include_abandoned;
    let tags = serde_json::to_string(&filters.tags).map_err(|e| e.to_string())?;
    let item_key = filters.item_key.unwrap_or_default();
    let library_id = filters.library_id.unwrap_or_default();
    // X batch captures and both Telegram import paths store epoch milliseconds.
    let cutoff = filters
        .collected_within_days
        .map(|days| now_ms.saturating_sub(i64::from(days) * 86_400_000))
        .unwrap_or(i64::MIN)
        .max(
            filters
                .collected_from
                .map(|seconds| seconds * 1000)
                .unwrap_or(i64::MIN),
        );
    let collected_to = filters.collected_to.map(|seconds| seconds * 1000);
    let copies = saved_copies(c)?;
    let attention = needs_attention();
    let where_sql = format!("(?4='all' OR {SOURCE}=?4)
        AND (?1='' OR instr(lower(post_json),lower(?1))>0)
        AND CASE ?2 WHEN 'archived' THEN {STATE}='archived' WHEN 'needs_attention' THEN {STATE} IN ('active','archived') AND {attention} ELSE {STATE}='active' END
        AND CASE ?2 WHEN 'all' THEN (?9 OR {STATUS}<>'abandoned') WHEN 'archived' THEN 1 WHEN 'needs_attention' THEN 1 ELSE ?2={STATUS} END
        AND (?5='all' OR (?5='links' AND json_array_length(post_json,'$.links')>0)
          OR EXISTS(SELECT 1 FROM json_each(CASE WHEN json_array_length(post_json,'$.allMedia')>0 THEN json_extract(post_json,'$.allMedia') ELSE json_extract(post_json,'$.media') END) m WHERE
            (?5='photo' AND json_extract(m.value,'$.kind')='photo') OR
            (?5='video' AND json_extract(m.value,'$.kind') IN ('video','animated_gif'))))
        AND NOT EXISTS(SELECT 1 FROM json_each(?6) wanted WHERE NOT EXISTS(SELECT 1 FROM collection_x_properties p,json_each(p.tags) actual WHERE p.item_key=collection_x_items.item_key AND actual.value=wanted.value))
        AND (?7='' OR EXISTS(SELECT 1 FROM saved_copies s WHERE s.item_key=collection_x_items.item_key AND s.library_id=?7))
        AND collected_at>=?8
        AND (?10 IS NULL OR collected_at<?10)
        AND (?11='' OR item_key=?11)");
    let prefix = format!("WITH saved_copies AS ({copies})");
    let matched: i64 = if let Some([_, _, matched]) = cached_counts {
        matched
    } else {
        c.query_row(
            &format!("{prefix} SELECT count(*) FROM collection_x_items WHERE {where_sql}"),
            params![
                search,
                status,
                0,
                source,
                media,
                tags,
                library_id,
                cutoff,
                include_abandoned,
                collected_to,
                item_key
            ],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?
    };
    let body = if filters.compact {
        format!("(SELECT {LIST_POST} FROM collection_x_items AS summary INDEXED BY collection_list_summary_v1 WHERE summary.item_key=collection_x_items.item_key)")
    } else {
        "post_json".to_string()
    };
    let mut statement = c.prepare(&format!("{prefix} SELECT item_key,{body},collected_at,read_at,content_hash FROM collection_x_items WHERE {where_sql} ORDER BY {order} LIMIT 60 OFFSET ?3")).map_err(|e|e.to_string())?;
    let rows = statement
        .query_map(
            params![
                search,
                status,
                offset,
                source,
                media,
                tags,
                library_id,
                cutoff,
                include_abandoned,
                collected_to,
                item_key
            ],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, String>(4)?,
                ))
            },
        )
        .map_err(|e| e.to_string())?;
    let rows = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(statement);
    let keys = serde_json::to_string(&rows.iter().map(|row| &row.0).collect::<Vec<_>>())
        .map_err(|e| e.to_string())?;
    let mut page_properties = std::collections::HashMap::new();
    let mut properties_query = c.prepare("SELECT i.item_key,
        COALESCE(p.status,CASE WHEN i.read_at>0 THEN 'read' ELSE 'unread' END),
        COALESCE(p.tags,'[]'),EXISTS(SELECT 1 FROM reading_cloud_items cloud WHERE cloud.item_key=i.item_key)
        FROM collection_x_items i LEFT JOIN collection_x_properties p ON p.item_key=i.item_key
        WHERE i.item_key IN (SELECT value FROM json_each(?1))").map_err(|e| e.to_string())?;
    for row in properties_query
        .query_map([&keys], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, bool>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?
    {
        let (key, status, tags, cloud) = row.map_err(|e| e.to_string())?;
        let tags = serde_json::from_str::<Vec<String>>(&tags).map_err(|_| "收藏标签损坏")?;
        page_properties.insert(key, (status, tags, cloud));
    }
    let mut saved_media = std::collections::HashMap::<String, Vec<String>>::new();
    let mut assets = c
        .prepare(
            "SELECT item_key,media_url,path FROM collection_saved_media
        WHERE item_key IN (SELECT value FROM json_each(?1))",
        )
        .map_err(|e| e.to_string())?;
    for row in assets
        .query_map([&keys], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?
    {
        let (key, url, path) = row.map_err(|e| e.to_string())?;
        if Path::new(&path).is_file() {
            saved_media.entry(key).or_default().push(url);
        }
    }
    let mut page_issues = std::collections::HashMap::<String, Vec<Value>>::new();
    let mut issues_query = c
        .prepare(
            "SELECT item_key,'sourceCancellation',error FROM collection_x_outbox
        WHERE error<>'' AND item_key IN (SELECT value FROM json_each(?1))
        UNION ALL SELECT item_key,'contentUpdate',error FROM collection_x_enrichment
        WHERE error<>'' AND item_key IN (SELECT value FROM json_each(?1))",
        )
        .map_err(|e| e.to_string())?;
    for row in issues_query
        .query_map([&keys], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?
    {
        let (key, kind, error) = row.map_err(|e| e.to_string())?;
        page_issues
            .entry(key)
            .or_default()
            .push(json!({"kind":kind,"error":library::conversion::user_error(&error)}));
    }
    let mut items = Vec::new();
    let cloud_namespace = crate::reading_sync::object_store::namespace(c).unwrap_or_default();
    let mut cloud_previews = if filters.compact {
        Default::default()
    } else {
        crate::reading_sync::media::ready_previews_page(
            c,
            rows.iter().map(|row| (row.0.as_str(), row.1.as_str())),
            &cloud_namespace,
        )?
    };
    for row in rows {
        let (key, body, collected_at, read_at, revision) = row;
        let mut item = serde_json::to_value(Item {
            key,
            post: serde_json::from_str(&body).map_err(|_| "收藏内容损坏")?,
            collected_at,
            read: read_at > 0,
        })
        .map_err(|e| e.to_string())?;
        let key = item["key"].as_str().unwrap_or("").to_string();
        if filters.compact {
            item["summaryRevision"] = json!(revision);
        }
        item["savedMedia"] = json!(saved_media.remove(&key).unwrap_or_default());
        item["cloudPreviewUrls"] = json!(cloud_previews.remove(&key).unwrap_or_default());
        let (status, tags, cloud_imported) = page_properties
            .remove(&key)
            .ok_or("收藏内容在读取时已更改，请重试")?;
        item["status"] = json!(status);
        item["tags"] = json!(tags);
        item["cloudImported"] = json!(cloud_imported);
        item["attentionIssues"] = json!(page_issues.remove(&key).unwrap_or_default());
        items.push(item);
    }
    library::decorate_page(c, &mut items)?;
    Ok((total, unread, matched, items))
}

#[cfg(test)]
mod tests;
