//! Read-only browser projections and atomic selected-card operations.
//! Full bodies are materialized only for the requested page or explicit IDs.

use crate::flashcard_study_settings::read_flashcard_study_settings;

use icu_casemap::CaseMapper;
use icu_collator::{options::CollatorOptions, Collator};
use icu_locale::{langid, locale};
use rusqlite::{
    functions::FunctionFlags, params, params_from_iter, types::Value as SqlValue, Connection,
    OptionalExtension,
};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct Query {
    pub search: String,
    pub card_type: String,
    pub stage: String,
    pub sort: String,
    pub ascending: bool,
    pub include_mastered: bool,
    pub include_subdecks: bool,
    pub column_stage: Option<String>,
}

impl Default for Query {
    fn default() -> Self {
        Self {
            search: String::new(),
            card_type: "all".into(),
            stage: "all".into(),
            sort: "updated".into(),
            ascending: false,
            include_mastered: true,
            include_subdecks: false,
            column_stage: None,
        }
    }
}

const STAGES: [&str; 5] = ["new", "due", "learning", "mastered", "suspended"];
const STAGE_SQL: &str = "CASE WHEN status='suspended' THEN 'suspended' WHEN repetitions=0 AND lapses=0 THEN 'new' WHEN due_at<=?3 THEN 'due' WHEN interval_days>=21 THEN 'mastered' ELSE 'learning' END";

fn trim(value: &str) -> &str {
    value.trim_matches(|ch: char| ch.is_whitespace() || ch == '\u{feff}')
}

fn js_number(value: f64) -> String {
    if value == 0.0 {
        return "0".into();
    }
    let absolute = value.abs();
    let raw = absolute.to_string();
    if (1e-6..1e21).contains(&absolute) {
        return value.to_string();
    }
    let (integer, fraction) = raw.split_once('.').unwrap_or((&raw, ""));
    let digits = format!("{integer}{fraction}");
    let first = digits.find(|ch| ch != '0').unwrap_or(0);
    let exponent = integer.len() as i64 - first as i64 - 1;
    let significant = digits[first..].trim_end_matches('0');
    let mantissa = if significant.len() > 1 {
        format!("{}.{}", &significant[..1], &significant[1..])
    } else {
        significant.into()
    };
    format!(
        "{}{mantissa}e{}{exponent}",
        if value < 0.0 { "-" } else { "" },
        if exponent >= 0 { "+" } else { "" }
    )
}

fn js_value(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.as_f64().map(js_number).unwrap_or_default(),
        Value::String(value) => value.clone(),
        Value::Object(_) => "[object Object]".into(),
        Value::Array(values) => values
            .iter()
            .map(|value| {
                if value.is_null() {
                    String::new()
                } else {
                    js_value(value)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
    }
}

fn prepare_text(connection: &Connection) -> Result<(), String> {
    let zh = Collator::try_new(locale!("zh-CN").into(), CollatorOptions::default())
        .map_err(|e| e.to_string())?;
    let en = Collator::try_new(locale!("en").into(), CollatorOptions::default())
        .map_err(|e| e.to_string())?;
    connection
        .create_collation("HUB_ZH", move |a, b| zh.compare(a, b))
        .map_err(|e| e.to_string())?;
    connection
        .create_collation("HUB_EN", move |a, b| en.compare(a, b))
        .map_err(|e| e.to_string())?;
    connection
        .create_scalar_function(
            "hub_text_contains",
            2,
            FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
            |ctx| {
                let text: String = ctx.get(0)?;
                let query: String = ctx.get(1)?;
                Ok(CaseMapper::new()
                    .lowercase_to_string(&text, &langid!("und"))
                    .contains(&query))
            },
        )
        .map_err(|e| e.to_string())?;
    connection
        .create_scalar_function(
            "hub_trim",
            1,
            FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
            |ctx| {
                let text: String = ctx.get(0)?;
                Ok(trim(&text).to_owned())
            },
        )
        .map_err(|e| e.to_string())?;
    // SQLite json_each represents booleans as 0/1; preserve JavaScript String(value).
    connection
        .create_scalar_function(
            "hub_json_text",
            2,
            FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
            |ctx| {
                let kind: String = ctx.get(0)?;
                Ok(match kind.as_str() {
                    "true" => "true".into(),
                    "false" => "false".into(),
                    "null" => "null".into(),
                    _ => match ctx.get_raw(1) {
                        rusqlite::types::ValueRef::Text(bytes) => {
                            let text = String::from_utf8_lossy(bytes).into_owned();
                            if kind == "object" || kind == "array" {
                                serde_json::from_str(&text)
                                    .map(|value| js_value(&value))
                                    .unwrap_or_default()
                            } else {
                                text
                            }
                        }
                        rusqlite::types::ValueRef::Integer(value) => js_number(value as f64),
                        rusqlite::types::ValueRef::Real(value) => js_number(value),
                        _ => String::new(),
                    },
                })
            },
        )
        .map_err(|e| e.to_string())
}

fn revision(connection: &Connection, expected: Option<&str>) -> Result<String, String> {
    let actual: String = connection
        .query_row(
            "SELECT value FROM metadata WHERE key='flashcard_list_revision'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| "0".into());
    if expected.is_some_and(|value| value != actual) {
        return Err("FLASHCARD_LIST_CHANGED：闪卡列表已变化，请重新读取".into());
    }
    Ok(actual)
}

fn scope(deck_id: &str, due_only: bool, include_subdecks: bool) -> String {
    let mut value = if due_only {
        "status='active' AND due_at<=?3".to_owned()
    } else {
        "status IN ('active','suspended')".to_owned()
    };
    if !deck_id.is_empty() {
        value.push_str(" AND ");
        value.push_str(crate::flashcard_decks::card_scope(include_subdecks));
    }
    value
}

fn query_parts(
    deck_id: &str,
    due_only: bool,
    query: &Query,
    as_of: i64,
) -> Result<(String, Vec<SqlValue>), String> {
    if ![
        "all",
        "qa",
        "cloze",
        "multiple_choice",
        "typed_answer",
        "ordering",
        "image_occlusion",
    ]
    .contains(&query.card_type.as_str())
        || !(query.stage == "all" || STAGES.contains(&query.stage.as_str()))
        || !["updated", "created", "due", "question", "type"].contains(&query.sort.as_str())
        || query
            .column_stage
            .as_deref()
            .is_some_and(|value| !STAGES.contains(&value))
    {
        return Err("闪卡筛选或排序条件无效".into());
    }
    let predicate = format!("{} AND (?4='' OR hub_text_contains(question,?4) OR hub_text_contains(answer,?4) OR hub_text_contains(source_title,?4) OR hub_text_contains(source_path,?4) OR EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(tags_json) THEN tags_json ELSE '[]' END) j WHERE j.type='text' AND hub_text_contains(j.value,?4)) OR EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(custom_fields_json) THEN custom_fields_json ELSE '{{}}' END) j WHERE hub_text_contains(hub_json_text(j.type,j.value),?4))) AND (?5='all' OR card_type=?5) AND (?6='all' OR ({STAGE_SQL})=?6) AND (?7<>0 OR ({STAGE_SQL})<>'mastered')", scope(deck_id, due_only, query.include_subdecks));
    let search = CaseMapper::new()
        .lowercase_to_string(trim(&query.search), &langid!("und"))
        .into_owned();
    Ok((
        predicate,
        vec![
            SqlValue::Text(deck_id.into()),
            SqlValue::Integer(i64::from(due_only)),
            SqlValue::Integer(as_of),
            SqlValue::Text(search),
            SqlValue::Text(query.card_type.clone()),
            SqlValue::Text(query.stage.clone()),
            SqlValue::Integer(i64::from(query.include_mastered)),
        ],
    ))
}

fn ordering(query: Option<&Query>) -> String {
    let tie = "CASE WHEN due_at<=?3 THEN 0 ELSE 1 END,due_at,created_at DESC,id";
    match query {
        None => tie.into(),
        Some(query) => {
            let key = match query.sort.as_str() {
                "question" => "question COLLATE HUB_ZH",
                "type" => "card_type COLLATE HUB_EN",
                "created" => "created_at",
                "due" => "due_at",
                _ => "updated_at",
            };
            format!(
                "{key} {},{tie}",
                if query.ascending { "ASC" } else { "DESC" }
            )
        }
    }
}

fn count(connection: &Connection, predicate: &str, bindings: &[SqlValue]) -> Result<i64, String> {
    connection
        .query_row(
            &format!("SELECT COUNT(*) FROM flashcards WHERE {predicate}"),
            params_from_iter(bindings),
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())
}

fn strings(
    connection: &Connection,
    sql: &str,
    bindings: &[SqlValue],
) -> Result<Vec<String>, String> {
    let mut statement = connection.prepare(sql).map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(params_from_iter(bindings), |row| row.get(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub(crate) fn read_page(
    connection: &Connection,
    deck_id: &str,
    due_only: bool,
    query: Option<&Query>,
    offset: usize,
    limit: usize,
    expected_revision: Option<&str>,
    as_of: i64,
    include_metadata: bool,
) -> Result<Value, String> {
    prepare_text(connection)?;
    let transaction = connection
        .unchecked_transaction()
        .map_err(|e| e.to_string())?;
    let actual = revision(&transaction, expected_revision)?;
    let default = Query::default();
    let (filtered, bindings) = query_parts(deck_id, due_only, query.unwrap_or(&default), as_of)?;
    let matched_total = count(&transaction, &filtered, &bindings)?;
    let mut page_predicate = filtered.clone();
    let mut page_bindings = bindings.clone();
    if let Some(stage) = query.and_then(|query| query.column_stage.as_ref()) {
        page_predicate.push_str(&format!(" AND ({STAGE_SQL})=?8"));
        page_bindings.push(SqlValue::Text(stage.clone()));
    }
    let total = count(&transaction, &page_predicate, &page_bindings)?;
    let next = page_bindings.len() + 1;
    page_bindings.push(SqlValue::Integer(limit.clamp(1, 200) as i64));
    page_bindings.push(SqlValue::Integer(
        i64::try_from(offset).map_err(|e| e.to_string())?,
    ));
    let items = {
        let mut statement = transaction.prepare(&format!("SELECT {} FROM flashcards WHERE {page_predicate} ORDER BY {} LIMIT ?{next} OFFSET ?{}", crate::flashcard_store::FLASHCARD_SELECT_FIELDS, ordering(query), next + 1)).map_err(|e| e.to_string())?;
        let rows = statement
            .query_map(
                params_from_iter(&page_bindings),
                crate::flashcard_store::flashcard_from_row,
            )
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    let mut result = json!({"items":items,"total":total,"matchedTotal":matched_total,"revision":actual,"asOf":as_of});
    if include_metadata {
        // Scope tags are independent of visible filters; field columns follow all matches.
        let scope_predicate = format!(
            "{} AND ?2>=0 AND ?3>=0",
            scope(
                deck_id,
                due_only,
                query.unwrap_or(&default).include_subdecks
            )
        );
        let scope_bindings = &bindings[..3];
        result["scopeTotal"] = json!(count(&transaction, &scope_predicate, scope_bindings)?);
        result["tags"] = json!(strings(&transaction, &format!("SELECT DISTINCT hub_trim(j.value) AS tag FROM flashcards,json_each(CASE WHEN json_valid(tags_json) THEN tags_json ELSE '[]' END) j WHERE {scope_predicate} AND j.type='text' AND hub_trim(j.value)<>'' ORDER BY tag COLLATE HUB_ZH"), scope_bindings)?);
        result["customFieldKeys"] = json!(strings(&transaction, &format!("SELECT DISTINCT j.key FROM flashcards,json_each(CASE WHEN json_valid(custom_fields_json) THEN custom_fields_json ELSE '{{}}' END) j WHERE {filtered} ORDER BY j.key COLLATE HUB_ZH"), &bindings)?);
        let mut stage_counts = serde_json::Map::new();
        for stage in STAGES {
            stage_counts.insert(stage.into(), json!(0));
        }
        let mut statement = transaction.prepare(&format!("SELECT ({STAGE_SQL}) AS stage,COUNT(*) FROM flashcards WHERE {filtered} GROUP BY stage")).map_err(|e| e.to_string())?;
        let rows = statement
            .query_map(params_from_iter(&bindings), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (stage, number) = row.map_err(|e| e.to_string())?;
            stage_counts.insert(stage, json!(number));
        }
        drop(statement);
        result["stageCounts"] = Value::Object(stage_counts);
    }
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(result)
}

pub(crate) fn selection_ids(
    connection: &Connection,
    deck_id: &str,
    due_only: bool,
    query: &Query,
    offset: usize,
    limit: usize,
    expected_revision: Option<&str>,
    as_of: i64,
) -> Result<Value, String> {
    prepare_text(connection)?;
    let transaction = connection
        .unchecked_transaction()
        .map_err(|e| e.to_string())?;
    let actual = revision(&transaction, expected_revision)?;
    let (predicate, mut bindings) = query_parts(deck_id, due_only, query, as_of)?;
    let total = count(&transaction, &predicate, &bindings)?;
    bindings.push(SqlValue::Integer(limit.clamp(1, 2000) as i64));
    bindings.push(SqlValue::Integer(
        i64::try_from(offset).map_err(|e| e.to_string())?,
    ));
    let ids = strings(
        &transaction,
        &format!(
            "SELECT id FROM flashcards WHERE {predicate} ORDER BY {} LIMIT ?8 OFFSET ?9",
            ordering(Some(query))
        ),
        &bindings,
    )?;
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(json!({"ids":ids,"total":total,"revision":actual,"asOf":as_of}))
}

pub(crate) fn review_plan(
    connection: &Connection,
    deck_id: &str,
    session_limit: usize,
    as_of: i64,
) -> Result<Value, String> {
    review_plan_with_scope(connection, deck_id, session_limit, as_of, false)
}

pub(crate) fn review_plan_with_scope(
    connection: &Connection,
    deck_id: &str,
    session_limit: usize,
    as_of: i64,
    include_subdecks: bool,
) -> Result<Value, String> {
    review_plan_details(
        connection,
        deck_id,
        session_limit,
        as_of,
        include_subdecks,
        true,
    )
}

pub(crate) fn review_plan_details(
    connection: &Connection,
    deck_id: &str,
    session_limit: usize,
    as_of: i64,
    include_subdecks: bool,
    include_session_ids: bool,
) -> Result<Value, String> {
    let transaction = connection
        .unchecked_transaction()
        .map_err(|e| e.to_string())?;
    let actual = revision(&transaction, None)?;
    let daily_limit = crate::flashcard_study_settings::read_flashcard_study_settings(&transaction)
        .daily_new_limit;
    let studied: i64 = transaction.query_row("SELECT COUNT(DISTINCT r.card_id) FROM flashcard_reviews r WHERE date(r.reviewed_at,'unixepoch','localtime')=date(?1,'unixepoch','localtime') AND ((r.previous_repetitions=0 AND r.previous_lapses=0) OR (r.previous_repetitions IS NULL AND NOT EXISTS(SELECT 1 FROM flashcard_reviews older WHERE older.card_id=r.card_id AND (older.reviewed_at<r.reviewed_at OR (older.reviewed_at=r.reviewed_at AND older.id<r.id)))))", params![as_of], |row| row.get(0)).map_err(|e| e.to_string())?;
    let predicate = format!("{} AND ?2>=0", scope(deck_id, true, include_subdecks));
    let bindings = vec![
        SqlValue::Text(deck_id.into()),
        SqlValue::Integer(1),
        SqlValue::Integer(as_of),
    ];
    let (mature, fresh): (i64,i64) = transaction.query_row(&format!("SELECT COALESCE(SUM(CASE WHEN repetitions>0 OR lapses>0 THEN 1 ELSE 0 END),0),COALESCE(SUM(CASE WHEN repetitions=0 AND lapses=0 THEN 1 ELSE 0 END),0) FROM flashcards WHERE {predicate}"), params_from_iter(&bindings), |row| Ok((row.get(0)?,row.get(1)?))).map_err(|e| e.to_string())?;
    let new_available = if daily_limit == 0 {
        fresh
    } else {
        fresh.min((daily_limit - studied).max(0))
    };
    let eligible = mature + new_available;
    let session_count = if session_limit == 0 {
        eligible
    } else {
        eligible.min(i64::try_from(session_limit).map_err(|e| e.to_string())?)
    };
    let ids = if include_session_ids {
        let mature_limit = mature.min(session_count);
        let mut mature_bindings = bindings.clone();
        mature_bindings.push(SqlValue::Integer(mature_limit));
        let mut ids = strings(&transaction, &format!("SELECT id FROM flashcards WHERE {predicate} AND (repetitions>0 OR lapses>0) ORDER BY due_at,created_at DESC,id LIMIT ?4"), &mature_bindings)?;
        let new_limit = (session_count - mature_limit).min(new_available);
        let mut new_bindings = bindings;
        new_bindings.push(SqlValue::Integer(new_limit));
        ids.extend(strings(&transaction, &format!("SELECT id FROM flashcards WHERE {predicate} AND repetitions=0 AND lapses=0 ORDER BY due_at,created_at DESC,id LIMIT ?4"), &new_bindings)?);
        ids
    } else {
        Vec::new()
    };
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(
        json!({"sessionIds":ids,"sessionCount":session_count,"eligibleCount":eligible,"newAvailable":new_available,"newWaiting":fresh-new_available,"revision":actual,"asOf":as_of}),
    )
}

pub(crate) fn update_batch(
    connection: &mut Connection,
    ids: &[String],
    deck_id: Option<String>,
    tags: Option<Vec<String>>,
    custom_fields: Option<Value>,
    timestamp: i64,
) -> Result<usize, String> {
    if ids.is_empty() {
        return Err("请选择至少一张卡片".into());
    }
    let target = deck_id.filter(|value| !trim(value).is_empty());
    if target.is_none() && tags.is_none() && custom_fields.is_none() {
        return Err("没有需要批量修改的字段".into());
    }
    let tags = tags.map(|values| {
        crate::flashcard_validation::normalize_flashcard_tag_values(Some(values)).to_string()
    });
    let fields = custom_fields.as_ref().map(|value| {
        crate::flashcard_validation::normalize_flashcard_custom_fields(Some(value)).to_string()
    });
    let selection = serde_json::to_string(ids).map_err(|e| e.to_string())?;
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    if let Some(deck_id) = &target {
        if !transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM flashcard_decks WHERE id=?1)",
                params![deck_id],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|e| e.to_string())?
        {
            return Err("目标牌组不存在".into());
        }
    }
    let old_decks = strings(&transaction, "SELECT DISTINCT deck_id FROM flashcards WHERE status IN ('active','suspended') AND id IN (SELECT value FROM json_each(?1))", &[SqlValue::Text(selection.clone())])?;
    let changed = transaction.execute("UPDATE flashcards SET deck_id=COALESCE(?1,deck_id),tags_json=COALESCE(?2,tags_json),custom_fields_json=COALESCE(?3,custom_fields_json),updated_at=?4 WHERE status IN ('active','suspended') AND id IN (SELECT value FROM json_each(?5))", params![target,tags,fields,timestamp,selection]).map_err(|e| e.to_string())?;
    if changed > 0 {
        let mut decks = old_decks;
        if let Some(target) = target {
            decks.push(target);
        }
        transaction.execute("UPDATE flashcard_decks SET updated_at=?1 WHERE id IN (SELECT value FROM json_each(?2))",params![timestamp,serde_json::to_string(&decks).map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?;
        super::mark_flashcard_sync_dirty(&transaction)?;
    }
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(changed)
}

pub(crate) fn delete_batch(
    connection: &mut Connection,
    ids: &[String],
    timestamp: i64,
) -> Result<usize, String> {
    if ids.is_empty() {
        return Err("请选择至少一张卡片".into());
    }
    let selection = serde_json::to_string(ids).map_err(|e| e.to_string())?;
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    let decks = strings(&transaction,"SELECT DISTINCT deck_id FROM flashcards WHERE status IN ('active','suspended') AND id IN (SELECT value FROM json_each(?1))", &[SqlValue::Text(selection.clone())])?;
    let changed = transaction.execute("UPDATE flashcards SET status='deleted',updated_at=?1 WHERE status IN ('active','suspended') AND id IN (SELECT value FROM json_each(?2))",params![timestamp,selection]).map_err(|e| e.to_string())?;
    if changed > 0 {
        transaction.execute("UPDATE flashcard_decks SET updated_at=?1 WHERE id IN (SELECT value FROM json_each(?2))",params![timestamp,serde_json::to_string(&decks).map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?;
        super::mark_flashcard_sync_dirty(&transaction)?;
    }
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(changed)
}

#[cfg(test)]
#[path = "flashcard_query_tests.rs"]
mod tests;
