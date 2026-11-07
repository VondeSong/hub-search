use rusqlite::{functions::FunctionFlags, params, Connection};
use serde::Serialize;
use std::{collections::HashSet, path::Path};

/// Revisions describe committed journal inputs, independently of sync clocks.
/// Install on opening both new and existing databases without scanning bodies.
pub(crate) fn install_revision(connection: &Connection) -> Result<(), String> {
    connection.execute_batch(
        "CREATE TRIGGER IF NOT EXISTS journal_document_inserted AFTER INSERT ON documents
         BEGIN
           INSERT INTO metadata(key,value) VALUES('journal_document_revision:' || NEW.space_id,'1')
             ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1;
         END;
         CREATE TRIGGER IF NOT EXISTS journal_document_deleted AFTER DELETE ON documents
         BEGIN
           INSERT INTO metadata(key,value) VALUES('journal_document_revision:' || OLD.space_id,'1')
             ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1;
         END;
         CREATE TRIGGER IF NOT EXISTS journal_document_updated
           AFTER UPDATE OF space_id,id,title,path,folder_id,markdown,modified_at,provider ON documents
           WHEN OLD.space_id IS NOT NEW.space_id OR OLD.id IS NOT NEW.id
             OR OLD.title IS NOT NEW.title OR OLD.path IS NOT NEW.path
             OR OLD.folder_id IS NOT NEW.folder_id OR OLD.markdown IS NOT NEW.markdown
             OR OLD.modified_at IS NOT NEW.modified_at OR OLD.provider IS NOT NEW.provider
         BEGIN
           INSERT INTO metadata(key,value) VALUES('journal_document_revision:' || OLD.space_id,'1')
             ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1;
           INSERT INTO metadata(key,value)
             SELECT 'journal_document_revision:' || NEW.space_id,'1' WHERE OLD.space_id IS NOT NEW.space_id
             ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1;
         END;
         CREATE TRIGGER IF NOT EXISTS journal_library_inserted AFTER INSERT ON libraries
         BEGIN
           INSERT INTO metadata(key,value) VALUES('journal_document_revision:' || NEW.id,'1')
             ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1;
         END;
         CREATE TRIGGER IF NOT EXISTS journal_library_deleted AFTER DELETE ON libraries
         BEGIN
           INSERT INTO metadata(key,value) VALUES('journal_document_revision:' || OLD.id,'1')
             ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1;
         END;
         CREATE TRIGGER IF NOT EXISTS journal_library_updated
           AFTER UPDATE OF id,name,provider,enabled ON libraries
           WHEN OLD.id IS NOT NEW.id OR OLD.name IS NOT NEW.name
             OR OLD.provider IS NOT NEW.provider OR OLD.enabled IS NOT NEW.enabled
         BEGIN
           INSERT INTO metadata(key,value) VALUES('journal_document_revision:' || OLD.id,'1')
             ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1;
           INSERT INTO metadata(key,value)
             SELECT 'journal_document_revision:' || NEW.id,'1' WHERE OLD.id IS NOT NEW.id
             ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1;
         END;",
    ).map_err(|error| format!("无法初始化日志数据版本：{error}"))
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JournalLibraryVersion {
    pub library_id: String,
    pub revision: String,
    pub name: String,
    pub provider: String,
}

pub(crate) fn versions(
    database: &Path,
    connection: &Connection,
    requested: Option<Vec<String>>,
) -> Result<Vec<JournalLibraryVersion>, String> {
    let visible = visible_scope(database, connection, requested)?;
    versions_for_scope(connection, &visible)
}

fn versions_for_scope(
    connection: &Connection,
    scope: &[String],
) -> Result<Vec<JournalLibraryVersion>, String> {
    let filter = serde_json::to_string(scope).map_err(|_| "日志资料库筛选无效")?;
    let mut statement = connection
        .prepare(
            "SELECT l.id,COALESCE(m.value,'0'),l.name,l.provider
         FROM libraries l LEFT JOIN metadata m ON m.key='journal_document_revision:' || l.id
         WHERE l.id IN (SELECT value FROM json_each(?1))
           AND l.provider IN ('craft','obsidian') ORDER BY l.id",
        )
        .map_err(|error| format!("无法准备日志数据版本：{error}"))?;
    let rows = statement
        .query_map(params![filter], |row| {
            Ok(JournalLibraryVersion {
                library_id: row.get(0)?,
                revision: row.get(1)?,
                name: row.get(2)?,
                provider: row.get(3)?,
            })
        })
        .map_err(|error| format!("无法读取日志数据版本：{error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("日志数据版本无法读取：{error}"))
}

/// Apply the same removal/disabled membership as search before selecting dates.
pub(crate) fn visible_scope(
    database: &Path,
    connection: &Connection,
    requested: Option<Vec<String>>,
) -> Result<Vec<String>, String> {
    if requested.as_ref().is_some_and(Vec::is_empty) {
        return Ok(Vec::new());
    }
    let visible = crate::visible_library_ids(database, connection)?;
    match requested {
        None => Ok(visible),
        Some(ids) => {
            let selected = ids.into_iter().collect::<HashSet<_>>();
            Ok(visible
                .into_iter()
                .filter(|id| selected.contains(id))
                .collect())
        }
    }
}

// The navigation summary and document list share one eligibility contract.
pub(crate) const FILTER: &str = "
    (?1='' OR d.space_id IN (SELECT value FROM json_each(?1)))
    AND length(trim(d.title))=10
    AND (trim(d.title) GLOB '[0-9][0-9][0-9][0-9].[0-9][0-9].[0-9][0-9]'
         OR trim(d.title) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
    AND date(replace(trim(d.title),'.','-'),'+0 days')=replace(trim(d.title),'.','-')
    AND (d.provider='craft'
         OR (d.provider='obsidian'
             AND instr('/' || lower(replace(d.path,char(92),'/')), '/journals/')>0))";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JournalSummary {
    pub count: usize,
    pub dates: Vec<JournalDate>,
}

#[derive(Debug, Serialize)]
pub(crate) struct JournalDate {
    pub date: String,
    pub sources: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JournalView {
    pub summary: JournalSummary,
    pub items: Vec<crate::IndexedSearchResult>,
}

/// Capture eligibility, navigation and the displayed page in one read snapshot.
pub(crate) fn view(
    database: &Path,
    connection: &Connection,
    requested: Option<Vec<String>>,
    limit: Option<usize>,
    date_key: Option<String>,
) -> Result<JournalView, String> {
    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| format!("无法打开日志读取快照：{error}"))?;
    let scope = visible_scope(database, &transaction, requested)?;
    let result = JournalView {
        summary: summary(&transaction, Some(scope.clone()))?,
        items: documents(&transaction, scope, limit, date_key)?,
    };
    transaction
        .commit()
        .map_err(|error| format!("无法结束日志读取快照：{error}"))?;
    Ok(result)
}

pub(crate) fn documents(
    connection: &Connection,
    scope: Vec<String>,
    limit: Option<usize>,
    date_key: Option<String>,
) -> Result<Vec<crate::IndexedSearchResult>, String> {
    if scope.is_empty() {
        return Ok(Vec::new());
    }
    let filter =
        serde_json::to_string(&scope).map_err(|error| format!("日志资料库筛选无效：{error}"))?;
    let limit = limit.unwrap_or(200).clamp(1, 500) as i64;
    let date_key = date_key.unwrap_or_default();
    if !date_key.is_empty()
        && chrono::NaiveDate::parse_from_str(&format!("{date_key}-01"), "%Y-%m-%d").is_err()
        && chrono::NaiveDate::parse_from_str(&date_key, "%Y-%m-%d").is_err()
    {
        return Err("日志日期筛选无效".into());
    }
    let query = format!(
        "SELECT d.id,d.space_id,l.name,d.title,d.path,d.folder_id,
                d.modified_at,substr(d.markdown,1,160),d.provider
         FROM documents d JOIN libraries l ON l.id=d.space_id
         WHERE {FILTER} AND (?3='' OR replace(trim(d.title),'.','-') LIKE ?3 || '%')
         ORDER BY replace(substr(trim(d.title),1,10),'.','-') DESC,
                  COALESCE(d.modified_at,0) DESC,d.space_id,d.id LIMIT ?2"
    );
    let mut statement = connection
        .prepare(&query)
        .map_err(|error| format!("无法准备日志页面查询：{error}"))?;
    let rows = statement
        .query_map(params![filter, limit, date_key], map_document)
        .map_err(|error| format!("日志页面查询失败：{error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("日志页面无法读取：{error}"))
}

fn map_document(row: &rusqlite::Row<'_>) -> rusqlite::Result<crate::IndexedSearchResult> {
    let id: String = row.get(0)?;
    let space_id: String = row.get(1)?;
    let provider: String = row.get(8)?;
    let obsidian = provider == crate::PROVIDER_OBSIDIAN;
    let title: String = row.get(3)?;
    Ok(crate::IndexedSearchResult {
        id: id.clone(),
        entity_key: format!("document:{space_id}:{id}"),
        block_id: id.clone(),
        document_id: id,
        content_type: if obsidian {
            "obsidian_markdown"
        } else {
            "document"
        }
        .into(),
        source_item_id: None,
        source_type: if obsidian {
            "obsidian_page"
        } else {
            "craft_page"
        }
        .into(),
        source_title: None,
        page_number: None,
        score: None,
        provider,
        library_id: space_id.clone(),
        library_name: row.get(2)?,
        space_id,
        space_name: row.get(2)?,
        title: title.clone(),
        document_title: title,
        path: row.get(4)?,
        folder_id: row.get(5)?,
        modified_at: row.get(6)?,
        task_status: None,
        snippet: row.get(7)?,
        match_terms: Vec::new(),
        match_field: String::new(),
        match_count: 0,
        sub_matches: Vec::new(),
    })
}

pub(crate) fn summary(
    connection: &Connection,
    space_ids: Option<Vec<String>>,
) -> Result<JournalSummary, String> {
    if space_ids.as_ref().is_some_and(Vec::is_empty) {
        return Ok(JournalSummary {
            count: 0,
            dates: Vec::new(),
        });
    }
    let filter = space_ids
        .map(|ids| serde_json::to_string(&ids))
        .transpose()
        .map_err(|error| format!("日志资料库筛选无效：{error}"))?
        .unwrap_or_default();
    let query = format!(
        "SELECT replace(trim(d.title),'.','-'),count(*),count(DISTINCT d.space_id)
         FROM documents d JOIN libraries l ON l.id=d.space_id
         WHERE {FILTER} GROUP BY replace(trim(d.title),'.','-') ORDER BY 1 DESC"
    );
    let mut statement = connection
        .prepare(&query)
        .map_err(|error| format!("无法准备日志统计：{error}"))?;
    let rows = statement
        .query_map(params![filter], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, usize>(1)?,
                row.get::<_, usize>(2)?,
            ))
        })
        .map_err(|error| format!("无法读取日志统计：{error}"))?;
    let mut result = JournalSummary {
        count: 0,
        dates: Vec::new(),
    };
    for row in rows {
        let (date, count, sources) = row.map_err(|error| format!("日志统计无法读取：{error}"))?;
        result.count += count;
        result.dates.push(JournalDate { date, sources });
    }
    Ok(result)
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PageOptions {
    pub from: Option<String>,
    pub to: Option<String>,
    pub query: Option<String>,
    pub offset: Option<usize>,
    pub limit: Option<usize>,
    pub ascending: Option<bool>,
    pub sort: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JournalRecord {
    #[serde(flatten)]
    pub item: crate::IndexedSearchResult,
    pub journal_date: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JournalPage {
    pub items: Vec<JournalRecord>,
    pub total: usize,
    pub days: usize,
    pub libraries: usize,
    pub revision: String,
}

/// Bounded pages share eligibility, statistics and a committed revision snapshot.
/// Consumers restart pagination if the snapshot changes between requests.
pub(crate) fn page(
    database: &Path,
    connection: &Connection,
    requested: Option<Vec<String>>,
    options: PageOptions,
) -> Result<JournalPage, String> {
    for date in [&options.from, &options.to].into_iter().flatten() {
        let parsed =
            chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|_| "日志日期范围无效")?;
        if date.len() != 10 || parsed.format("%Y-%m-%d").to_string() != *date {
            return Err("日志日期范围无效".into());
        }
    }
    if options
        .from
        .as_ref()
        .zip(options.to.as_ref())
        .is_some_and(|(from, to)| from > to)
    {
        return Err("日志日期范围无效".into());
    }
    // SQLite lower() only handles ASCII. Match non-English titles and bodies
    // with the same Unicode conversion applied to the requested query.
    connection
        .create_scalar_function(
            "journal_text_contains",
            2,
            FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
            |context| {
                let text: String = context.get(0)?;
                let query: String = context.get(1)?;
                Ok(text.to_lowercase().contains(&query))
            },
        )
        .map_err(|error| format!("无法准备日志搜索：{error}"))?;
    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| format!("无法打开日志读取快照：{error}"))?;
    let scope = visible_scope(database, &transaction, requested)?;
    let revision = serde_json::to_string(&versions_for_scope(&transaction, &scope)?)
        .map_err(|error| format!("日志数据版本无效：{error}"))?;
    if scope.is_empty() {
        transaction
            .commit()
            .map_err(|error| format!("无法结束日志读取快照：{error}"))?;
        return Ok(JournalPage {
            items: vec![],
            total: 0,
            days: 0,
            libraries: 0,
            revision,
        });
    }
    let filter =
        serde_json::to_string(&scope).map_err(|error| format!("日志资料库筛选无效：{error}"))?;
    let from = options.from.unwrap_or_default();
    let to = options.to.unwrap_or_default();
    let query = options.query.unwrap_or_default().trim().to_lowercase();
    let clause = format!(
        "{FILTER} AND (?2='' OR replace(trim(d.title),'.','-')>=?2)
      AND (?3='' OR replace(trim(d.title),'.','-')<=?3)
      AND (?4='' OR journal_text_contains(d.title || ' ' || COALESCE(d.markdown,'') || ' ' || COALESCE(l.name,''),?4))"
    );
    let (total, days, libraries) = transaction
        .query_row(
            &format!(
                "SELECT count(*),count(DISTINCT replace(trim(d.title),'.','-')),
                        count(DISTINCT d.space_id)
                 FROM documents d JOIN libraries l ON l.id=d.space_id WHERE {clause}"
            ),
            params![filter, from, to, query],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|error| format!("无法读取日志统计：{error}"))?;
    let direction = if options.ascending.unwrap_or(true) {
        "ASC"
    } else {
        "DESC"
    };
    let sort = if options.sort.as_deref() == Some("modified") {
        "COALESCE(d.modified_at,0)"
    } else {
        "replace(trim(d.title),'.','-')"
    };
    let limit = options.limit.unwrap_or(200).clamp(1, 500) as i64;
    let offset = options.offset.unwrap_or(0).min(i64::MAX as usize) as i64;
    let items = {
        let mut statement = transaction
            .prepare(&format!(
                "SELECT d.id,d.space_id,l.name,d.title,d.path,d.folder_id,d.modified_at,
                        COALESCE(substr(d.markdown,1,1000),''),d.provider
                 FROM documents d JOIN libraries l ON l.id=d.space_id WHERE {clause}
                 ORDER BY {sort} {direction},replace(trim(d.title),'.','-') {direction},
                          d.space_id,d.id LIMIT ?5 OFFSET ?6"
            ))
            .map_err(|error| format!("无法准备日志页面查询：{error}"))?;
        let rows = statement
            .query_map(params![filter, from, to, query, limit, offset], |row| {
                let item = map_document(row)?;
                let journal_date = item.title.trim().replace('.', "-");
                Ok(JournalRecord { item, journal_date })
            })
            .map_err(|error| format!("日志页面查询失败：{error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("日志页面无法读取：{error}"))?
    };
    transaction
        .commit()
        .map_err(|error| format!("无法结束日志读取快照：{error}"))?;
    Ok(JournalPage {
        items,
        total,
        days,
        libraries,
        revision,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn revision_fixture() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        initialize_revision_fixture(&connection);
        connection
    }

    fn initialize_revision_fixture(connection: &Connection) {
        connection.execute_batch(
            "CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
             CREATE TABLE libraries(id TEXT PRIMARY KEY,name TEXT,provider TEXT,enabled INTEGER,last_sync INTEGER);
             CREATE TABLE documents(space_id TEXT,id TEXT,title TEXT,path TEXT,folder_id TEXT,
               markdown TEXT,modified_at INTEGER,provider TEXT,indexed_at INTEGER,content_hash TEXT,
               PRIMARY KEY(space_id,id));
             INSERT INTO libraries VALUES('a','A','craft',1,1),('b','B','obsidian',1,1);",
        ).unwrap();
        install_revision(connection).unwrap();
    }

    fn page_fixture() -> (std::path::PathBuf, Connection) {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../task-state/journal-database-20261013/native-tests")
            .join(crate::random_url_safe(12));
        std::fs::create_dir_all(&root).unwrap();
        (root.join("synthetic.sqlite3"), revision_fixture())
    }

    fn insert_record(
        connection: &Connection,
        library: &str,
        id: &str,
        date: &str,
        body: &str,
        modified_at: i64,
    ) {
        connection
            .execute(
                "INSERT INTO documents VALUES(?1,?2,?3,?4,NULL,?5,?6,?7,1,'hash')",
                params![
                    library,
                    id,
                    date,
                    format!("Journals/{id}.md"),
                    body,
                    modified_at,
                    if library == "b" { "obsidian" } else { "craft" },
                ],
            )
            .unwrap();
    }

    fn revision(connection: &Connection, library: &str) -> String {
        connection.query_row(
            "SELECT COALESCE((SELECT value FROM metadata WHERE key='journal_document_revision:' || ?1),'0')",
            params![library], |row| row.get(0),
        ).unwrap()
    }

    #[test]
    fn journal_revision_tracks_every_semantic_field_and_moves_both_scopes() {
        let mut connection = revision_fixture();
        connection.execute_batch("INSERT INTO documents VALUES('a','doc','2026-10-11','path',NULL,'body',NULL,'craft',1,'hash')").unwrap();
        assert_eq!(revision(&connection, "a"), "1");
        for update in [
            "title='2026-10-12'",
            "path='new path'",
            "folder_id='folder'",
            "folder_id=NULL",
            "markdown='new body'",
            "modified_at=1",
            "modified_at=NULL",
            "provider='obsidian'",
            "id='new-id'",
        ] {
            let before = revision(&connection, "a").parse::<u64>().unwrap();
            connection
                .execute_batch(&format!("UPDATE documents SET {update}"))
                .unwrap();
            assert_eq!(
                revision(&connection, "a").parse::<u64>().unwrap(),
                before + 1,
                "{update}"
            );
        }
        let before_a = revision(&connection, "a");
        let before_b = revision(&connection, "b");
        let transaction = connection.transaction().unwrap();
        transaction
            .execute_batch("UPDATE documents SET space_id='b'")
            .unwrap();
        assert_ne!(revision(&transaction, "a"), before_a);
        assert_ne!(revision(&transaction, "b"), before_b);
        transaction.rollback().unwrap();
        assert_eq!(revision(&connection, "a"), before_a);
        assert_eq!(revision(&connection, "b"), before_b);
        connection
            .execute_batch("UPDATE documents SET space_id='b'; DELETE FROM documents")
            .unwrap();
        assert_eq!(revision(&connection, "b"), "2");
    }

    #[test]
    fn journal_revision_ignores_reindex_clocks_hash_only_and_telemetry() {
        let connection = revision_fixture();
        connection.execute_batch("INSERT INTO documents VALUES('a','doc','2026-10-11','path',NULL,'body',NULL,'craft',1,'hash')").unwrap();
        let before = revision(&connection, "a");
        connection
            .execute_batch(
                "UPDATE documents SET title=title,path=path,folder_id=folder_id,markdown=markdown,
               modified_at=modified_at,provider=provider,id=id,space_id=space_id;
             UPDATE documents SET indexed_at=2,content_hash='reindexed';
             UPDATE libraries SET last_sync=2,name=name,enabled=enabled;
             INSERT INTO metadata VALUES('ocr_heartbeat','1');",
            )
            .unwrap();
        assert_eq!(revision(&connection, "a"), before);
        assert_eq!(revision(&connection, "b"), "0");
    }

    #[test]
    fn journal_library_revision_preserves_visibility_and_metadata_aba() {
        let mut connection = revision_fixture();
        let before = revision(&connection, "a");
        connection.execute_batch("UPDATE libraries SET enabled=0 WHERE id='a'; UPDATE libraries SET enabled=1 WHERE id='a'").unwrap();
        assert_ne!(revision(&connection, "a"), before);
        assert_eq!(revision(&connection, "a"), "2");
        let before = revision(&connection, "a");
        let transaction = connection.transaction().unwrap();
        transaction
            .execute_batch("UPDATE libraries SET name='Changed',provider='obsidian' WHERE id='a'")
            .unwrap();
        assert_ne!(revision(&transaction, "a"), before);
        transaction.rollback().unwrap();
        assert_eq!(revision(&connection, "a"), before);
        connection.execute_batch("UPDATE libraries SET name='Changed' WHERE id='a'; UPDATE libraries SET name='A' WHERE id='a'; DELETE FROM libraries WHERE id='a'; INSERT INTO libraries VALUES('a','A','craft',1,1)").unwrap();
        assert_eq!(revision(&connection, "a"), "6");
        connection
            .execute_batch("UPDATE libraries SET id='c' WHERE id='a'")
            .unwrap();
        assert_eq!(revision(&connection, "a"), "7");
        assert_eq!(revision(&connection, "c"), "1");
    }

    #[test]
    fn journal_revision_installation_preserves_existing_data_and_is_idempotent() {
        let connection = revision_fixture();
        connection.execute_batch("INSERT INTO documents VALUES('a','doc','2026-10-11','path',NULL,'body',NULL,'craft',1,'hash')").unwrap();
        let before = revision(&connection, "a");
        install_revision(&connection).unwrap();
        install_revision(&connection).unwrap();
        assert_eq!(revision(&connection, "a"), before);
        assert_eq!(
            connection
                .query_row("SELECT markdown FROM documents", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "body"
        );
        assert_eq!(
            revision(&connection, "b"),
            "0",
            "old libraries require no body scan or revision backfill"
        );
    }

    #[test]
    fn journal_versions_read_only_metadata_and_follow_visible_scope() {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../task-state/project-optimization-20261011/journal-revision-tests");
        std::fs::create_dir_all(&root).unwrap();
        let owned = root.join(format!("metadata-{}", crate::random_url_safe(12)));
        std::fs::create_dir(&owned).unwrap();
        let database = owned.join("synthetic.sqlite3");
        let connection = Connection::open_in_memory().unwrap();
        // No document table or body: status projection must only read metadata.
        connection.execute_batch(
            "CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);
             CREATE TABLE libraries(id TEXT PRIMARY KEY,name TEXT,provider TEXT,enabled INTEGER);
             INSERT INTO libraries VALUES('a','A','craft',1),('b','B','obsidian',0),('c','C','craft',1);
             INSERT INTO metadata VALUES('journal_document_revision:a','9007199254740993');
             PRAGMA query_only=ON;",
        ).unwrap();
        crate::library_runtime::control(&owned, "c", "remove").unwrap();
        let result = versions(&database, &connection, None).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].library_id, "a");
        assert_eq!(result[0].revision, "9007199254740993");
        assert_eq!(serde_json::to_value(&result[0]).unwrap()["libraryId"], "a");
        assert!(versions(&database, &connection, Some(vec![]))
            .unwrap()
            .is_empty());
        assert!(
            versions(&database, &connection, Some(vec!["b".into(), "c".into()]))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn journal_revision_follows_real_same_second_producer_and_failed_transaction() {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../task-state/project-optimization-20261011/journal-revision-tests");
        std::fs::create_dir_all(&root).unwrap();
        let owned = root.join(format!("producer-{}", crate::random_url_safe(12)));
        std::fs::create_dir(&owned).unwrap();
        let database = owned.join("synthetic.sqlite3");
        let connection = crate::open_database(&database).unwrap();
        connection.execute_batch("INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES('a','craft','A',1,1)").unwrap();
        let blobs = crate::BlobStore::open(&owned.join("blobs")).unwrap();
        let write = |body: &str, indexed_at: i64| {
            crate::persist_document_batch(
                &database,
                &blobs,
                vec![crate::IndexedDocument {
                    space_id: "a".into(),
                    id: "doc".into(),
                    title: "2026-10-11".into(),
                    path: "journal".into(),
                    folder_id: None,
                    markdown: body.into(),
                    modified_at: Some(1),
                    indexed_at,
                    content_hash: body.into(),
                    attachments: vec![],
                    block_hints: vec![],
                }],
            )
        };
        write("First journal body", 1).unwrap();
        let first = versions(&database, &connection, None).unwrap();
        write("Second journal body", 1).unwrap();
        let second = versions(&database, &connection, None).unwrap();
        assert_ne!(
            first, second,
            "same time and count must retain a distinct committed revision"
        );
        assert_eq!(
            summary(&connection, Some(vec!["a".into()])).unwrap().count,
            1
        );
        write("Second journal body", 2).unwrap();
        assert_eq!(versions(&database, &connection, None).unwrap(), second);
        connection.execute_batch("CREATE TRIGGER fail_journal_test BEFORE INSERT ON content_items BEGIN SELECT RAISE(ABORT,'owned failure'); END").unwrap();
        assert!(write("Uncommitted journal body", 1).is_err());
        assert_eq!(versions(&database, &connection, None).unwrap(), second);
        assert_eq!(
            connection
                .query_row("SELECT markdown FROM documents WHERE id='doc'", [], |row| {
                    row.get::<_, String>(0)
                })
                .unwrap(),
            "Second journal body"
        );
        drop(connection);
        let reopened = crate::open_database(&database).unwrap();
        assert_eq!(versions(&database, &reopened, None).unwrap(), second);
    }

    #[test]
    fn journal_scope_excludes_retained_disabled_and_removing_libraries() {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../task-state/project-optimization-20261011/journal-scope-tests")
            .join(crate::random_url_safe(8));
        std::fs::create_dir_all(&root).unwrap();
        let database = root.join("synthetic.sqlite3");
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE libraries(id TEXT PRIMARY KEY,enabled INTEGER);
             CREATE TABLE documents(space_id TEXT,title TEXT,path TEXT,provider TEXT);
             INSERT INTO libraries VALUES('active',1),('disabled',0),('removing',1);
             INSERT INTO documents VALUES
             ('active','2026-10-11','','craft'),
             ('disabled','2026-10-11','','craft'),
             ('removing','2026-10-11','','craft');",
            )
            .unwrap();
        crate::library_runtime::control(&root, "removing", "remove").unwrap();
        let scope = visible_scope(&database, &connection, None).unwrap();
        assert_eq!(scope, vec!["active"]);
        assert_eq!(summary(&connection, Some(scope)).unwrap().count, 1);
        assert_eq!(
            visible_scope(
                &database,
                &connection,
                Some(vec!["active".into(), "disabled".into(), "removing".into()])
            )
            .unwrap(),
            vec!["active"]
        );
        assert!(visible_scope(&database, &connection, Some(vec![]))
            .unwrap()
            .is_empty());
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM documents", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            3
        );
    }

    #[test]
    fn summary_uses_metadata_and_counts_beyond_document_page_limit() {
        let connection = Connection::open_in_memory().unwrap();
        // Intentionally no markdown column: navigation must never read bodies.
        connection
            .execute_batch(
                "CREATE TABLE libraries(id TEXT PRIMARY KEY);
            CREATE TABLE documents(space_id TEXT,title TEXT,path TEXT,provider TEXT);
            INSERT INTO libraries VALUES('craft'),('vault');",
            )
            .unwrap();
        for _ in 0..1001 {
            connection
                .execute(
                    "INSERT INTO documents VALUES('craft','2026.10.11','','craft')",
                    [],
                )
                .unwrap();
        }
        connection
            .execute_batch(
                "INSERT INTO documents VALUES
            ('vault','2026-10-11','Journals/2026-10-11.md','obsidian'),
            ('vault','2026-10-10','Journals/2026-10-10.md','obsidian'),
            ('vault','2026-10-11','Notes/2026-10-11.md','obsidian'),
            ('craft','not a date','','craft');",
            )
            .unwrap();
        let result = summary(&connection, None).unwrap();
        assert_eq!(result.count, 1003);
        assert_eq!(result.dates.len(), 2);
        assert_eq!(result.dates[0].date, "2026-10-11");
        assert_eq!(result.dates[0].sources, 2);
        assert_eq!(
            summary(&connection, Some(vec!["vault".into()]))
                .unwrap()
                .count,
            2
        );
        assert_eq!(summary(&connection, Some(vec![])).unwrap().count, 0);
    }

    #[test]
    fn journal_view_preserves_scope_date_order_and_complete_navigation() {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../task-state/project-optimization-20261011/journal-view-tests")
            .join(crate::random_url_safe(12));
        std::fs::create_dir_all(&root).unwrap();
        let database = root.join("synthetic.sqlite3");
        let connection = revision_fixture();
        connection
            .execute("UPDATE libraries SET enabled=0 WHERE id='b'", [])
            .unwrap();
        connection.execute_batch(
            "INSERT INTO documents VALUES
               ('a','old','2026-10-10','Journals/old',NULL,'old body',1,'craft',9,'old'),
               ('a','b','2026-10-11','Journals/b',NULL,'second body',1,'craft',100,'b'),
               ('a','a','2026-10-11','Journals/a',NULL,'first body',1,'craft',1,'a'),
               ('b','hidden','2026-10-11','Journals/hidden',NULL,'hidden body',1,'obsidian',1,'hidden');",
        ).unwrap();
        let result = view(
            &database,
            &connection,
            None,
            Some(1),
            Some("2026-10-11".into()),
        )
        .unwrap();
        assert_eq!(result.summary.count, 3);
        assert_eq!(result.summary.dates.len(), 2);
        assert_eq!(result.items.len(), 1);
        assert_eq!(
            result.items[0].id, "a",
            "scan clocks do not affect stable ties"
        );
        assert_eq!(result.items[0].snippet, "first body");
        let empty = view(&database, &connection, Some(vec![]), None, None).unwrap();
        assert_eq!(empty.summary.count, 0);
        assert!(empty.items.is_empty());
        assert!(view(&database, &connection, None, None, Some("bad-date".into())).is_err());
        crate::library_runtime::control(&root, "a", "remove").unwrap();
        let removed = view(&database, &connection, None, None, None).unwrap();
        assert_eq!(removed.summary.count, 0);
        assert!(removed.items.is_empty());
    }

    #[test]
    fn journal_view_snapshot_keeps_navigation_and_page_on_one_committed_generation() {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../task-state/project-optimization-20261011/journal-view-tests")
            .join(crate::random_url_safe(12));
        std::fs::create_dir_all(&root).unwrap();
        let database = root.join("synthetic.sqlite3");
        let initialized = crate::open_database(&database).unwrap();
        initialized.execute_batch("INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES('a','craft','A',1,1)").unwrap();
        let blobs = crate::BlobStore::open(&root.join("blobs")).unwrap();
        let write = |id: &str, date: &str| {
            crate::persist_document_batch(
                &database,
                &blobs,
                vec![crate::IndexedDocument {
                    space_id: "a".into(),
                    id: id.into(),
                    title: date.into(),
                    path: format!("Journals/{id}"),
                    folder_id: None,
                    markdown: format!("body {id}"),
                    modified_at: Some(1),
                    indexed_at: 1,
                    content_hash: format!("hash {id}"),
                    attachments: vec![],
                    block_hints: vec![],
                }],
            )
        };
        write("old", "2026-10-10").unwrap();
        let reader =
            Connection::open_with_flags(&database, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap();
        let snapshot = reader.unchecked_transaction().unwrap();
        let scope = visible_scope(&database, &snapshot, None).unwrap();
        let navigation = summary(&snapshot, Some(scope.clone())).unwrap();
        write("new", "2026-10-11").unwrap();
        let page = documents(&snapshot, scope, Some(500), None).unwrap();
        assert_eq!(navigation.count, page.len());
        assert_eq!(
            page[0].id, "old",
            "producer commit between reads cannot enter the page snapshot"
        );
        snapshot.commit().unwrap();
        let refreshed = view(&database, &reader, None, Some(500), None).unwrap();
        assert_eq!(refreshed.summary.count, 2);
        assert_eq!(refreshed.items[0].id, "new");
        assert_eq!(refreshed.summary.dates[0].date, "2026-10-11");
    }

    #[test]
    fn journal_pages_cover_more_than_500_without_duplicate_or_missing_source_records() {
        let (database, mut connection) = page_fixture();
        let first_date = chrono::NaiveDate::from_ymd_opt(2024, 1, 1).unwrap();
        let transaction = connection.transaction().unwrap();
        for index in 0..1203 {
            let date = first_date + chrono::Duration::days(index / 3);
            let title = if index % 2 == 0 {
                date.format("%Y.%m.%d").to_string()
            } else {
                date.to_string()
            };
            insert_record(
                &transaction,
                if index % 3 == 0 { "b" } else { "a" },
                &format!("doc-{index:04}"),
                &title,
                "recorded body",
                1,
            );
        }
        // Identical source document IDs in different libraries remain distinct.
        insert_record(&transaction, "a", "shared", "2024-01-01", "a", 1);
        insert_record(&transaction, "b", "shared", "2024-01-01", "b", 1);
        transaction.commit().unwrap();
        let mut records = Vec::new();
        let mut revision = None;
        loop {
            let result = page(
                &database,
                &connection,
                None,
                PageOptions {
                    offset: Some(records.len()),
                    limit: Some(500),
                    ..Default::default()
                },
            )
            .unwrap();
            assert_eq!(result.total, 1205);
            assert_eq!(result.days, 401);
            assert_eq!(result.libraries, 2);
            assert!(result.items.len() <= 500);
            assert_eq!(
                revision.get_or_insert(result.revision.clone()),
                &result.revision
            );
            records.extend(result.items);
            if records.len() == result.total {
                break;
            }
        }
        assert_eq!(records.len(), 1205);
        assert_eq!(
            records
                .iter()
                .map(|record| &record.item.entity_key)
                .collect::<HashSet<_>>()
                .len(),
            1205
        );
        assert_eq!(
            records
                .iter()
                .filter(|record| record.item.id == "shared")
                .count(),
            2
        );
        assert!(records
            .windows(2)
            .all(|pair| pair[0].journal_date <= pair[1].journal_date));
        assert_eq!(summary(&connection, None).unwrap().count, records.len());
        let finished = page(
            &database,
            &connection,
            None,
            PageOptions {
                offset: Some(usize::MAX),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(finished.items.is_empty());
        assert_eq!(finished.total, 1205);
    }

    #[test]
    fn journal_page_scope_excludes_disabled_removed_and_explicit_empty_libraries() {
        let (database, connection) = page_fixture();
        connection
            .execute_batch("INSERT INTO libraries VALUES('removed','Removed','craft',1,1)")
            .unwrap();
        insert_record(&connection, "a", "active", "2026-10-13", "active", 1);
        insert_record(&connection, "b", "disabled", "2026-10-13", "disabled", 1);
        insert_record(
            &connection,
            "removed",
            "removed",
            "2026-10-13",
            "removed",
            1,
        );
        connection
            .execute_batch("UPDATE libraries SET enabled=0 WHERE id='b'")
            .unwrap();
        crate::library_runtime::control(database.parent().unwrap(), "removed", "remove").unwrap();
        let visible = page(&database, &connection, None, PageOptions::default()).unwrap();
        assert_eq!(visible.total, 1);
        assert_eq!(visible.items[0].item.id, "active");
        assert_eq!(visible.libraries, 1);
        let selected = page(
            &database,
            &connection,
            Some(vec![
                "a".into(),
                "a".into(),
                "b".into(),
                "removed".into(),
                "missing".into(),
            ]),
            PageOptions::default(),
        )
        .unwrap();
        assert_eq!(selected.total, 1);
        assert_eq!(selected.revision, visible.revision);
        for scope in [vec![], vec!["b".into(), "removed".into(), "missing".into()]] {
            let empty = page(&database, &connection, Some(scope), PageOptions::default()).unwrap();
            assert!(empty.items.is_empty());
            assert_eq!((empty.total, empty.days, empty.libraries), (0, 0, 0));
            assert_eq!(empty.revision, "[]");
        }
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM documents", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            3
        );
    }

    #[test]
    fn journal_page_range_includes_adjacent_month_days_and_rejects_impossible_dates() {
        let (database, connection) = page_fixture();
        for (id, date) in [
            ("before", "2026-09-26"),
            ("first", "2026.09.27"),
            ("middle", "2026-10-13"),
            ("last", "2026-11-07"),
            ("after", "2026-11-08"),
            ("invalid-day", "2026-02-30"),
            ("invalid-leap", "2025.02.29"),
            ("invalid-month", "2026-13-01"),
            ("invalid-title", "2026-10-13 notes"),
            ("leap", "2024-02-29"),
        ] {
            insert_record(&connection, "a", id, date, "body", 1);
        }
        insert_record(&connection, "b", "ordinary-note", "2026-10-13", "body", 1);
        connection
            .execute_batch(
                "UPDATE documents SET path='Notes/2026-10-13.md' WHERE id='ordinary-note'",
            )
            .unwrap();
        let calendar = page(
            &database,
            &connection,
            None,
            PageOptions {
                from: Some("2026-09-27".into()),
                to: Some("2026-11-07".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            calendar
                .items
                .iter()
                .map(|record| record.item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["first", "middle", "last"]
        );
        assert_eq!(
            (calendar.total, calendar.days, calendar.libraries),
            (3, 3, 1)
        );
        assert_eq!(
            page(&database, &connection, None, PageOptions::default())
                .unwrap()
                .total,
            6
        );
        assert_eq!(summary(&connection, None).unwrap().count, 6);
        for invalid in [
            "2026-02-30",
            "2025-02-29",
            "2026-13-01",
            "2026-1-01",
            "2026.10.13",
            "2026-10",
            "",
            " 2026-10-13",
            "+2026-10-13",
        ] {
            assert!(
                page(
                    &database,
                    &connection,
                    None,
                    PageOptions {
                        from: Some(invalid.into()),
                        ..Default::default()
                    }
                )
                .is_err(),
                "{invalid}"
            );
        }
        assert!(page(
            &database,
            &connection,
            Some(vec![]),
            PageOptions {
                to: Some("2026-02-30".into()),
                ..Default::default()
            }
        )
        .is_err());
        assert!(page(
            &database,
            &connection,
            None,
            PageOptions {
                from: Some("2026-11-01".into()),
                to: Some("2026-10-01".into()),
                ..Default::default()
            }
        )
        .is_err());
    }

    #[test]
    fn journal_page_search_matches_complete_body_library_unicode_and_literal_characters() {
        let (database, connection) = page_fixture();
        connection
            .execute_batch("UPDATE libraries SET name='工作 Archive' WHERE id='a'")
            .unwrap();
        insert_record(
            &connection,
            "a",
            "long",
            "2026-10-13",
            &format!("{} ÄPFEL 发布记录 100%_done 'quote'", "前文".repeat(1000)),
            1,
        );
        insert_record(&connection, "b", "other", "2026-10-14", "Second body", 1);
        for query in [
            " 发布记录 ",
            "äpfel",
            "100%_done",
            "'quote'",
            "工作",
            "ARCHIVE",
            "2026-10-13",
        ] {
            let result = page(
                &database,
                &connection,
                None,
                PageOptions {
                    query: Some(query.into()),
                    ..Default::default()
                },
            )
            .unwrap();
            assert_eq!(
                (result.total, result.days, result.libraries),
                (1, 1, 1),
                "{query}"
            );
            assert_eq!(result.items[0].item.id, "long");
        }
        let no_match = page(
            &database,
            &connection,
            None,
            PageOptions {
                query: Some("' OR 1=1 --".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(no_match.total, 0);
        assert!(no_match.items.is_empty());
        let whitespace = page(
            &database,
            &connection,
            None,
            PageOptions {
                query: Some(" \n\t ".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(whitespace.total, 2);
        assert_eq!(whitespace.items[0].item.snippet.chars().count(), 1000);
    }

    #[test]
    fn journal_page_date_and_modified_orders_use_stable_source_identity_ties() {
        let (database, connection) = page_fixture();
        for (library, id, date, modified) in [
            ("a", "older", "2026-10-12", 9),
            ("a", "b", "2026-10-13", 1),
            ("a", "a", "2026-10-13", 1),
            ("b", "a", "2026-10-13", 1),
            ("a", "newer", "2026-10-14", 9),
        ] {
            insert_record(&connection, library, id, date, "body", modified);
        }
        let identities = |result: JournalPage| {
            result
                .items
                .into_iter()
                .map(|record| format!("{}:{}", record.item.space_id, record.item.id))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            identities(page(&database, &connection, None, PageOptions::default()).unwrap()),
            vec!["a:older", "a:a", "a:b", "b:a", "a:newer"]
        );
        assert_eq!(
            identities(
                page(
                    &database,
                    &connection,
                    None,
                    PageOptions {
                        ascending: Some(false),
                        ..Default::default()
                    }
                )
                .unwrap()
            ),
            vec!["a:newer", "a:a", "a:b", "b:a", "a:older"]
        );
        assert_eq!(
            identities(
                page(
                    &database,
                    &connection,
                    None,
                    PageOptions {
                        sort: Some("modified".into()),
                        ..Default::default()
                    }
                )
                .unwrap()
            ),
            vec!["a:a", "a:b", "b:a", "a:older", "a:newer"]
        );
        assert_eq!(
            identities(
                page(
                    &database,
                    &connection,
                    None,
                    PageOptions {
                        sort: Some("modified".into()),
                        ascending: Some(false),
                        ..Default::default()
                    }
                )
                .unwrap()
            ),
            vec!["a:newer", "a:older", "a:a", "a:b", "b:a"]
        );
        let clamped = page(
            &database,
            &connection,
            None,
            PageOptions {
                limit: Some(0),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(clamped.items.len(), 1);
        assert_eq!(clamped.total, 5);
    }

    #[test]
    fn journal_page_revision_changes_for_committed_inputs_and_visible_membership_only() {
        let (database, mut connection) = page_fixture();
        insert_record(&connection, "a", "old", "2026-10-13", "old", 1);
        let initial = page(
            &database,
            &connection,
            Some(vec!["a".into()]),
            PageOptions::default(),
        )
        .unwrap();
        insert_record(&connection, "b", "unselected", "2026-10-13", "other", 1);
        assert_eq!(
            initial.revision,
            page(
                &database,
                &connection,
                Some(vec!["a".into()]),
                PageOptions::default()
            )
            .unwrap()
            .revision
        );
        let rollback = connection.transaction().unwrap();
        rollback
            .execute_batch("UPDATE documents SET markdown='uncommitted' WHERE space_id='a'")
            .unwrap();
        rollback.rollback().unwrap();
        assert_eq!(
            initial.revision,
            page(
                &database,
                &connection,
                Some(vec!["a".into()]),
                PageOptions::default()
            )
            .unwrap()
            .revision
        );
        connection
            .execute_batch(
                "UPDATE documents SET indexed_at=2,content_hash='same body' WHERE space_id='a'",
            )
            .unwrap();
        assert_eq!(
            initial.revision,
            page(
                &database,
                &connection,
                Some(vec!["a".into()]),
                PageOptions::default()
            )
            .unwrap()
            .revision
        );
        connection
            .execute_batch(
                "UPDATE documents SET markdown='committed same-second body' WHERE space_id='a'",
            )
            .unwrap();
        let changed = page(
            &database,
            &connection,
            Some(vec!["a".into()]),
            PageOptions::default(),
        )
        .unwrap();
        assert_ne!(initial.revision, changed.revision);
        assert_eq!(changed.items[0].item.snippet, "committed same-second body");
        connection
            .execute_batch("UPDATE libraries SET enabled=0 WHERE id='a'")
            .unwrap();
        let disabled = page(
            &database,
            &connection,
            Some(vec!["a".into()]),
            PageOptions::default(),
        )
        .unwrap();
        assert_eq!(disabled.total, 0);
        assert_ne!(changed.revision, disabled.revision);
        connection
            .execute_batch("UPDATE libraries SET enabled=1 WHERE id='a'")
            .unwrap();
        assert_ne!(
            changed.revision,
            page(
                &database,
                &connection,
                Some(vec!["a".into()]),
                PageOptions::default()
            )
            .unwrap()
            .revision
        );
    }

    #[test]
    fn journal_page_statistics_records_and_revision_share_one_read_snapshot() {
        use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
        let (database, _) = page_fixture();
        let reader = Connection::open(&database).unwrap();
        reader.execute_batch("PRAGMA journal_mode=WAL").unwrap();
        initialize_revision_fixture(&reader);
        insert_record(&reader, "a", "old", "2026-10-13", "old body", 1);
        let before = page(&database, &reader, None, PageOptions::default()).unwrap();
        let writer = Connection::open(&database).unwrap();
        let mut wrote = false;
        // Preparing the item query happens after the version and statistics have
        // been read. Commit a producer update at that exact boundary.
        reader.authorizer(Some(move |context: AuthContext<'_>| {
            if !wrote
                && matches!(
                    context.action,
                    AuthAction::Function {
                        function_name: "substr"
                    }
                )
            {
                insert_record(&writer, "a", "new", "2026-10-14", "new body", 1);
                wrote = true;
            }
            Authorization::Allow
        }));
        let snapshot = page(&database, &reader, None, PageOptions::default()).unwrap();
        assert_eq!(snapshot.total, 1);
        assert_eq!(snapshot.items.len(), 1);
        assert_eq!(snapshot.items[0].item.id, "old");
        assert_eq!(snapshot.revision, before.revision);
        reader.authorizer(None::<fn(AuthContext<'_>) -> Authorization>);
        let refreshed = page(&database, &reader, None, PageOptions::default()).unwrap();
        assert_eq!(refreshed.total, 2);
        assert_eq!(refreshed.items.len(), 2);
        assert_ne!(refreshed.revision, before.revision);
    }
}
