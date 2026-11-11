//! Database connection admission, schema upgrades and their one initialization cache.
//! Callers borrow the shared writer lock; no window or application state lives here.
use crate::content::chunk_markdown;
use crate::sources::{obsidian_frontmatter_aliases, obsidian_markdown_tags};
use crate::{craft_markdown_tags, metadata_bool, now_timestamp};
use crate::{
    flashcard_cloud_sync, flashcard_decks, flashcard_quality, flashcard_review_log,
    flashcard_scheduler, flashcard_store, journal_query, local_database_maintenance, x_bookmarks,
};
use rusqlite::{params, Connection};
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{Mutex, MutexGuard, OnceLock},
};

// Epoch 79 keeps older applications from writing past frozen Work quotas and
// recovery policies they do not understand. Existing records are not rewritten.
// Epoch 81 adds fixed method/topic bindings. Older writers must not silently
// ignore them when continuing work; existing data and budget roots are retained.
// Epoch 84 installs memory proposals and provenance for existing epoch 83 databases.
// Epoch 85 installs reusable research scopes and idempotent answer save receipts.
pub(crate) const DATABASE_SCHEMA_VERSION: i64 = 85;
#[cfg(test)]
mod recovery_version_tests;
static DATABASE_INITIALIZATION_LOCK: Mutex<()> = Mutex::new(());
static DATABASE_WRITE_LOCK: Mutex<()> = Mutex::new(());
static INITIALIZED_DATABASES: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();

#[cfg(test)]
pub(crate) fn register_initialized_fixture(path: &PathBuf) {
    INITIALIZED_DATABASES
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .unwrap()
        .insert(path.clone());
}

pub(crate) fn open_database(path: &PathBuf) -> Result<Connection, String> {
    let initialized = INITIALIZED_DATABASES.get_or_init(|| Mutex::new(HashSet::new()));
    let already_initialized = path.exists()
        && initialized
            .lock()
            .map_err(|_| "数据库初始化状态不可用".to_string())?
            .contains(path);
    if !already_initialized {
        let _initialization = DATABASE_INITIALIZATION_LOCK
            .lock()
            .map_err(|_| "数据库初始化锁不可用".to_string())?;
        let still_needs_initialization = !path.exists()
            || !initialized
                .lock()
                .map_err(|_| "数据库初始化状态不可用".to_string())?
                .contains(path);
        if still_needs_initialization {
            let _writer = lock_database_writer()?;
            let connection = initialize_database(path)?;
            initialized
                .lock()
                .map_err(|_| "数据库初始化状态不可用".to_string())?
                .insert(path.clone());
            return Ok(connection);
        }
    }
    let connection =
        Connection::open(path).map_err(|error| format!("无法打开本地索引：{error}"))?;
    connection
        .execute_batch("PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;")
        .map_err(|error| format!("无法配置本地索引连接：{error}"))?;
    Ok(connection)
}

#[cfg(test)]
pub(crate) fn forget_initialized_database(path: &PathBuf) {
    if let Some(initialized) = INITIALIZED_DATABASES.get() {
        if let Ok(mut initialized) = initialized.lock() {
            initialized.remove(path);
        }
    }
}

pub(crate) fn open_write_database(
    path: &PathBuf,
) -> Result<(Connection, MutexGuard<'static, ()>), String> {
    let connection = open_database(path)?;
    let writer = lock_database_writer()?;
    Ok((connection, writer))
}

pub(crate) fn lock_database_writer() -> Result<MutexGuard<'static, ()>, String> {
    Ok(DATABASE_WRITE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()))
}

pub(crate) fn initialize_database(path: &PathBuf) -> Result<Connection, String> {
    let mut connection =
        Connection::open(path).map_err(|error| format!("无法打开本地索引：{error}"))?;
    connection
        .execute_batch(
            "PRAGMA busy_timeout=5000;
             PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             CREATE TABLE IF NOT EXISTS metadata (
               key TEXT PRIMARY KEY,
               value TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS spaces (
               id TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               mcp_url TEXT NOT NULL,
               deep_link_template TEXT,
               added_at INTEGER NOT NULL,
               last_sync INTEGER
             );
             CREATE TABLE IF NOT EXISTS folders (
               space_id TEXT NOT NULL,
               id TEXT NOT NULL,
               name TEXT NOT NULL,
               path TEXT NOT NULL,
               PRIMARY KEY (space_id, id)
             );
             CREATE TABLE IF NOT EXISTS documents (
               space_id TEXT NOT NULL,
               id TEXT NOT NULL,
               title TEXT NOT NULL,
               path TEXT NOT NULL,
               folder_id TEXT,
               markdown TEXT NOT NULL,
               modified_at INTEGER,
               indexed_at INTEGER NOT NULL,
               content_hash TEXT NOT NULL,
               PRIMARY KEY (space_id, id)
             );
             CREATE TABLE IF NOT EXISTS content_items (
               id TEXT PRIMARY KEY,
               space_id TEXT NOT NULL,
               document_id TEXT NOT NULL,
               block_id TEXT NOT NULL,
               content_type TEXT NOT NULL,
               heading TEXT NOT NULL,
               body TEXT NOT NULL,
               ordinal INTEGER NOT NULL,
               source_hash TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS content_items_document
               ON content_items(space_id, document_id, ordinal);
             CREATE TABLE IF NOT EXISTS index_jobs (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               job_key TEXT NOT NULL UNIQUE,
               space_id TEXT NOT NULL,
               source_id TEXT NOT NULL,
               source_type TEXT NOT NULL,
               job_type TEXT NOT NULL,
               status TEXT NOT NULL DEFAULT 'pending',
               priority INTEGER NOT NULL DEFAULT 0,
               attempts INTEGER NOT NULL DEFAULT 0,
               payload TEXT,
               created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL,
               last_error TEXT
             );
             CREATE INDEX IF NOT EXISTS index_jobs_pending
               ON index_jobs(status, priority DESC, created_at);",
        )
        .map_err(|error| format!("无法初始化本地索引：{error}"))?;

    let schema_version = connection
        .query_row(
            "SELECT value FROM metadata WHERE key = 'schema_version'",
            [],
            |row| row.get(0),
        )
        .ok()
        .and_then(|value: String| value.parse::<i64>().ok())
        .unwrap_or(0);
    if schema_version > DATABASE_SCHEMA_VERSION {
        return Err(format!(
            "本地数据库版本 {schema_version} 高于当前程序支持的版本 {DATABASE_SCHEMA_VERSION}"
        ));
    }
    if schema_version < 5 {
        let documents = {
            let mut statement = connection
                .prepare("SELECT space_id, id, title, markdown FROM documents")
                .map_err(|error| format!("无法准备内容项迁移：{error}"))?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })
                .map_err(|error| format!("无法读取待迁移文档：{error}"))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("待迁移文档无法读取：{error}"))?
        };
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始内容索引迁移：{error}"))?;
        transaction
            .execute("DELETE FROM content_items", [])
            .map_err(|error| format!("无法清理旧内容项：{error}"))?;
        transaction
            .execute("DELETE FROM index_jobs", [])
            .map_err(|error| format!("无法清理旧索引任务：{error}"))?;
        for (space_id, document_id, title, markdown) in documents {
            for chunk in chunk_markdown(&space_id, &document_id, &title, &markdown) {
                transaction.execute(
                    "INSERT INTO content_items
                     (id, space_id, document_id, block_id, content_type, heading, body, ordinal, source_hash)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![chunk.id, space_id, document_id, chunk.block_id, chunk.content_type,
                        chunk.heading, chunk.body, chunk.ordinal, chunk.source_hash],
                ).map_err(|error| format!("无法迁移文档内容项：{error}"))?;
            }
            let timestamp = now_timestamp();
            transaction.execute(
                "INSERT INTO index_jobs
                 (job_key, space_id, source_id, source_type, job_type, status, priority, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 'document', 'upsert_lexical', 'pending', 10, ?4, ?4)",
                params![format!("lexical:{space_id}:{document_id}"), space_id, document_id, timestamp],
            ).map_err(|error| format!("无法创建迁移索引任务：{error}"))?;
        }
        transaction
            .execute_batch(
                "DROP TABLE IF EXISTS documents_fts;
                 INSERT INTO metadata (key, value) VALUES ('schema_version', '5')
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
            )
            .map_err(|error| format!("无法完成搜索架构迁移：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交搜索架构迁移：{error}"))?;
    }
    if schema_version < 6 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始任务队列迁移：{error}"))?;
        transaction
            .execute_batch(
                "ALTER TABLE index_jobs ADD COLUMN locked_at INTEGER;
                 ALTER TABLE index_jobs ADD COLUMN lease_until INTEGER;
                 ALTER TABLE index_jobs ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0;
                 ALTER TABLE index_jobs ADD COLUMN worker_id TEXT;
                 ALTER TABLE documents ADD COLUMN missing_syncs INTEGER NOT NULL DEFAULT 0;
                 DROP INDEX IF EXISTS index_jobs_pending;
                 CREATE INDEX index_jobs_pending
                   ON index_jobs(status, next_attempt_at, priority DESC, created_at);
                 INSERT INTO metadata (key, value) VALUES ('schema_version', '6')
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
            )
            .map_err(|error| format!("无法升级持久化任务队列：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交任务队列迁移：{error}"))?;
    }
    if schema_version < 7 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始 Blob 架构迁移：{error}"))?;
        transaction
            .execute_batch(
                "ALTER TABLE documents ADD COLUMN blob_hash TEXT;
                 CREATE TABLE IF NOT EXISTS blobs (
                   hash TEXT PRIMARY KEY,
                   size INTEGER NOT NULL,
                   mime_type TEXT,
                   relative_path TEXT NOT NULL,
                   created_at INTEGER NOT NULL,
                   verified_at INTEGER
                 );
                 CREATE TABLE IF NOT EXISTS source_items (
                   id TEXT PRIMARY KEY,
                   space_id TEXT NOT NULL,
                   document_id TEXT,
                   remote_id TEXT NOT NULL,
                   source_type TEXT NOT NULL,
                   title TEXT NOT NULL,
                   mime_type TEXT,
                   modified_at INTEGER,
                   content_hash TEXT,
                   blob_hash TEXT,
                   status TEXT NOT NULL DEFAULT 'discovered',
                   metadata_json TEXT,
                   created_at INTEGER NOT NULL,
                   updated_at INTEGER NOT NULL,
                   UNIQUE(space_id, remote_id, source_type)
                 );
                 CREATE INDEX IF NOT EXISTS source_items_document
                   ON source_items(space_id, document_id, source_type);
                 CREATE TABLE IF NOT EXISTS extractions (
                   id TEXT PRIMARY KEY,
                   source_item_id TEXT NOT NULL,
                   extractor TEXT NOT NULL,
                   extractor_version TEXT NOT NULL,
                   status TEXT NOT NULL DEFAULT 'pending',
                   text_blob_hash TEXT,
                   page_count INTEGER,
                   created_at INTEGER NOT NULL,
                   updated_at INTEGER NOT NULL,
                   last_error TEXT,
                   UNIQUE(source_item_id, extractor, extractor_version)
                 );
                 CREATE INDEX IF NOT EXISTS extractions_status
                   ON extractions(status, updated_at);
                 INSERT INTO metadata (key, value) VALUES ('schema_version', '7')
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
            )
            .map_err(|error| format!("无法升级 Blob 与提取架构：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交 Blob 架构迁移：{error}"))?;
    }
    if schema_version < 8 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始索引代际迁移：{error}"))?;
        transaction
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS search_index_generations (
                   id TEXT PRIMARY KEY,
                   schema_version INTEGER NOT NULL,
                   relative_path TEXT NOT NULL,
                   status TEXT NOT NULL,
                   document_count INTEGER NOT NULL DEFAULT 0,
                   created_at INTEGER NOT NULL,
                   activated_at INTEGER,
                   last_error TEXT
                 );
                 CREATE INDEX IF NOT EXISTS search_index_generations_status
                   ON search_index_generations(status, activated_at DESC);
                 INSERT INTO metadata (key, value) VALUES ('schema_version', '8')
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
            )
            .map_err(|error| format!("无法升级索引代际架构：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交索引代际迁移：{error}"))?;
    }
    if schema_version < 9 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始附件管线迁移：{error}"))?;
        transaction
            .execute_batch(
                "ALTER TABLE documents ADD COLUMN attachment_scan_hash TEXT;
                 ALTER TABLE content_items ADD COLUMN source_item_id TEXT;
                 ALTER TABLE content_items ADD COLUMN page_number INTEGER;
                 ALTER TABLE source_items ADD COLUMN last_seen_at INTEGER;
                 ALTER TABLE source_items ADD COLUMN missing_syncs INTEGER NOT NULL DEFAULT 0;
                 CREATE INDEX IF NOT EXISTS content_items_source_item
                   ON content_items(source_item_id, page_number, ordinal);
                 CREATE INDEX IF NOT EXISTS index_jobs_type_pending
                   ON index_jobs(job_type, status, next_attempt_at, priority DESC, created_at);
                 UPDATE source_items SET last_seen_at=updated_at WHERE last_seen_at IS NULL;
                 INSERT INTO metadata (key, value) VALUES ('schema_version', '9')
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
            )
            .map_err(|error| format!("无法升级附件与 PDF 管线：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交附件管线迁移：{error}"))?;
    }
    if schema_version < 10 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始 OCR 管线迁移：{error}"))?;
        transaction
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS ocr_pages (
                   source_item_id TEXT NOT NULL,
                   page_number INTEGER NOT NULL,
                   status TEXT NOT NULL DEFAULT 'pending',
                   body TEXT,
                   updated_at INTEGER NOT NULL,
                   last_error TEXT,
                   PRIMARY KEY (source_item_id, page_number)
                 );
                 CREATE INDEX IF NOT EXISTS ocr_pages_status
                   ON ocr_pages(status, updated_at);
                 INSERT INTO index_jobs
                   (job_key, space_id, source_id, source_type, job_type, status, priority,
                    created_at, updated_at)
                 SELECT 'extract-pdf:' || s.id, s.space_id, s.id, 'craft_attachment',
                        'extract_pdf', 'pending', 25, strftime('%s','now'), strftime('%s','now')
                 FROM source_items s
                 WHERE s.blob_hash IS NOT NULL AND s.mime_type='application/pdf'
                 ON CONFLICT(job_key) DO UPDATE SET status='pending', priority=25, attempts=0,
                   updated_at=excluded.updated_at, last_error=NULL, next_attempt_at=0,
                   worker_id=NULL, locked_at=NULL, lease_until=NULL;
                 INSERT INTO metadata (key, value) VALUES ('auto_sync_minutes', '15')
                 ON CONFLICT(key) DO NOTHING;
                 INSERT INTO metadata (key, value) VALUES ('schema_version', '10')
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
            )
            .map_err(|error| format!("无法升级 OCR 与后台维护管线：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交 OCR 管线迁移：{error}"))?;
    }
    if schema_version < 11 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始提取缓存迁移：{error}"))?;
        transaction
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS extraction_cache (
                   blob_hash TEXT NOT NULL,
                   extractor TEXT NOT NULL,
                   extractor_version TEXT NOT NULL,
                   page_number INTEGER NOT NULL,
                   status TEXT NOT NULL,
                   text_blob_hash TEXT,
                   page_count INTEGER,
                   created_at INTEGER NOT NULL,
                   updated_at INTEGER NOT NULL,
                   last_error TEXT,
                   PRIMARY KEY (blob_hash, extractor, extractor_version, page_number)
                 );
                 CREATE INDEX IF NOT EXISTS extraction_cache_status
                   ON extraction_cache(status, updated_at);
                 INSERT INTO extraction_cache
                   (blob_hash, extractor, extractor_version, page_number, status,
                    text_blob_hash, page_count, created_at, updated_at)
                 SELECT s.blob_hash, e.extractor, e.extractor_version, 0, e.status,
                        e.text_blob_hash, e.page_count, e.created_at, e.updated_at
                 FROM extractions e
                 JOIN source_items s ON s.id=e.source_item_id
                 WHERE s.blob_hash IS NOT NULL AND e.extractor='pdf_native'
                   AND e.status IN ('completed','partial','needs_ocr')
                 ON CONFLICT(blob_hash, extractor, extractor_version, page_number) DO NOTHING;
                 INSERT INTO extraction_cache
                   (blob_hash, extractor, extractor_version, page_number, status,
                    text_blob_hash, page_count, created_at, updated_at)
                 SELECT s.blob_hash, e.extractor, e.extractor_version, 1, e.status,
                        e.text_blob_hash, 1, e.created_at, e.updated_at
                 FROM extractions e
                 JOIN source_items s ON s.id=e.source_item_id
                 WHERE s.blob_hash IS NOT NULL AND e.extractor='windows_ocr'
                   AND COALESCE(s.mime_type, '') LIKE 'image/%'
                   AND e.status IN ('completed','empty')
                 ON CONFLICT(blob_hash, extractor, extractor_version, page_number) DO NOTHING;
                 INSERT INTO metadata (key, value) VALUES ('schema_version', '11')
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
            )
            .map_err(|error| format!("无法升级 Blob 提取缓存：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交提取缓存迁移：{error}"))?;
    }
    if schema_version < 12 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始成本调度迁移：{error}"))?;
        transaction
            .execute_batch(
                "ALTER TABLE index_jobs ADD COLUMN estimated_cost INTEGER NOT NULL DEFAULT 1;
                 DROP INDEX IF EXISTS index_jobs_type_pending;
                 CREATE INDEX index_jobs_type_pending
                   ON index_jobs(job_type, status, next_attempt_at, priority DESC,
                                 estimated_cost, created_at);
                 INSERT INTO metadata (key, value) VALUES ('schema_version', '12')
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
            )
            .map_err(|error| format!("无法升级成本感知调度架构：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交成本调度迁移：{error}"))?;
    }
    if schema_version < 13 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始多数据源迁移：{error}"))?;
        transaction
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS libraries (
                   id TEXT PRIMARY KEY,
                   provider TEXT NOT NULL,
                   name TEXT NOT NULL,
                   location TEXT,
                   enabled INTEGER NOT NULL DEFAULT 1,
                   added_at INTEGER NOT NULL,
                   last_sync INTEGER,
                   metadata_json TEXT
                 );
                 CREATE INDEX IF NOT EXISTS libraries_provider
                   ON libraries(provider, lower(name));
                 ALTER TABLE spaces ADD COLUMN provider TEXT NOT NULL DEFAULT 'craft';
                 ALTER TABLE folders ADD COLUMN provider TEXT NOT NULL DEFAULT 'craft';
                 ALTER TABLE documents ADD COLUMN provider TEXT NOT NULL DEFAULT 'craft';
                 ALTER TABLE content_items ADD COLUMN provider TEXT NOT NULL DEFAULT 'craft';
                 ALTER TABLE source_items ADD COLUMN provider TEXT NOT NULL DEFAULT 'craft';
                 ALTER TABLE index_jobs ADD COLUMN provider TEXT NOT NULL DEFAULT 'craft';
                 INSERT INTO libraries
                   (id, provider, name, location, enabled, added_at, last_sync, metadata_json)
                 SELECT id, 'craft', name, mcp_url, 1, added_at, last_sync,
                        json_object('deepLinkTemplate', deep_link_template)
                 FROM spaces
                 WHERE 1
                 ON CONFLICT(id) DO UPDATE SET
                   provider='craft', name=excluded.name, location=excluded.location,
                   last_sync=excluded.last_sync;
                 CREATE INDEX IF NOT EXISTS documents_provider_library
                   ON documents(provider, space_id, modified_at);
                 CREATE INDEX IF NOT EXISTS content_items_provider_library
                   ON content_items(provider, space_id, document_id, ordinal);
                 INSERT INTO metadata (key, value) VALUES ('schema_version', '13')
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
            )
            .map_err(|error| format!("无法升级多数据源架构：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交多数据源迁移：{error}"))?;
    }
    if schema_version < 14 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始 Obsidian 别名迁移：{error}"))?;
        transaction
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS obsidian_aliases (
                   space_id TEXT NOT NULL,
                   document_id TEXT NOT NULL,
                   alias TEXT NOT NULL,
                   normalized_alias TEXT NOT NULL,
                   PRIMARY KEY (space_id, document_id, normalized_alias)
                 );
                 CREATE INDEX IF NOT EXISTS obsidian_alias_lookup
                   ON obsidian_aliases(space_id, normalized_alias, document_id);
                 CREATE INDEX IF NOT EXISTS documents_obsidian_path
                   ON documents(space_id, lower(path));",
            )
            .map_err(|error| format!("无法创建 Obsidian 别名索引：{error}"))?;
        let documents = {
            let mut statement = transaction
                .prepare("SELECT space_id,id,markdown FROM documents WHERE provider='obsidian'")
                .map_err(|error| format!("无法准备 Obsidian 别名回填：{error}"))?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(|error| format!("无法读取 Obsidian 别名回填数据：{error}"))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("无法收集 Obsidian 别名回填数据：{error}"))?
        };
        for (space_id, document_id, markdown) in documents {
            for alias in obsidian_frontmatter_aliases(&markdown) {
                transaction
                    .execute(
                        "INSERT OR IGNORE INTO obsidian_aliases
                           (space_id,document_id,alias,normalized_alias)
                         VALUES (?1,?2,?3,?4)",
                        params![space_id, document_id, alias, alias.to_lowercase()],
                    )
                    .map_err(|error| format!("无法回填 Obsidian 别名：{error}"))?;
            }
        }
        transaction
            .execute(
                "INSERT INTO metadata (key,value) VALUES ('schema_version','14')
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [],
            )
            .map_err(|error| format!("无法记录 Obsidian 别名迁移：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交 Obsidian 别名迁移：{error}"))?;
    }
    if schema_version < 15 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始 Obsidian 标签迁移：{error}"))?;
        transaction
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS obsidian_tags (
                   space_id TEXT NOT NULL,
                   document_id TEXT NOT NULL,
                   tag TEXT NOT NULL,
                   normalized_tag TEXT NOT NULL,
                   PRIMARY KEY (space_id, document_id, normalized_tag)
                 );
                 CREATE INDEX IF NOT EXISTS obsidian_tag_lookup
                   ON obsidian_tags(space_id, normalized_tag, document_id);",
            )
            .map_err(|error| format!("无法创建 Obsidian 标签索引：{error}"))?;
        let documents = {
            let mut statement = transaction
                .prepare("SELECT space_id,id,markdown FROM documents WHERE provider='obsidian'")
                .map_err(|error| format!("无法准备 Obsidian 标签回填：{error}"))?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(|error| format!("无法读取 Obsidian 标签回填数据：{error}"))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("无法收集 Obsidian 标签回填数据：{error}"))?
        };
        for (space_id, document_id, markdown) in documents {
            for tag in obsidian_markdown_tags(&markdown) {
                transaction
                    .execute(
                        "INSERT OR IGNORE INTO obsidian_tags
                           (space_id,document_id,tag,normalized_tag)
                         VALUES (?1,?2,?3,?4)",
                        params![space_id, document_id, tag, tag.to_lowercase()],
                    )
                    .map_err(|error| format!("无法回填 Obsidian 标签：{error}"))?;
            }
        }
        transaction
            .execute(
                "INSERT INTO metadata (key,value) VALUES ('schema_version','15')
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [],
            )
            .map_err(|error| format!("无法记录 Obsidian 标签迁移：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交 Obsidian 标签迁移：{error}"))?;
    }
    if schema_version < 16 {
        let has_raw_document_id = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('documents')
                 WHERE name='raw_document_id'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0)
            > 0;
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始 Craft 文档链接迁移：{error}"))?;
        if !has_raw_document_id {
            transaction
                .execute("ALTER TABLE documents ADD COLUMN raw_document_id TEXT", [])
                .map_err(|error| format!("无法升级 Craft 文档链接字段：{error}"))?;
        }
        transaction
            .execute(
                "INSERT INTO metadata (key,value) VALUES ('schema_version','16')
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [],
            )
            .map_err(|error| format!("无法记录 Craft 文档链接迁移：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交 Craft 文档链接迁移：{error}"))?;
    }
    if schema_version < 17 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始滴答清单迁移：{error}"))?;
        transaction
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS dida_projects (
                   library_id TEXT NOT NULL,
                   project_id TEXT NOT NULL,
                   name TEXT NOT NULL,
                   color TEXT,
                   kind TEXT,
                   view_mode TEXT,
                   closed INTEGER NOT NULL DEFAULT 0,
                   sort_order INTEGER,
                   raw_json TEXT NOT NULL,
                   synced_at INTEGER NOT NULL,
                   PRIMARY KEY (library_id, project_id)
                 );
                 CREATE TABLE IF NOT EXISTS dida_tasks (
                   library_id TEXT NOT NULL,
                   task_id TEXT NOT NULL,
                   project_id TEXT NOT NULL,
                   parent_id TEXT,
                   title TEXT NOT NULL,
                   content TEXT NOT NULL DEFAULT '',
                   description TEXT NOT NULL DEFAULT '',
                   kind TEXT NOT NULL DEFAULT 'TEXT',
                   status INTEGER NOT NULL DEFAULT 0,
                   priority INTEGER NOT NULL DEFAULT 0,
                   start_at TEXT,
                   due_at TEXT,
                   completed_at TEXT,
                   time_zone TEXT,
                   column_id TEXT,
                   column_name TEXT,
                   url TEXT,
                   raw_json TEXT NOT NULL,
                   last_seen_at INTEGER NOT NULL,
                   missing_syncs INTEGER NOT NULL DEFAULT 0,
                   PRIMARY KEY (library_id, task_id)
                 );
                 CREATE TABLE IF NOT EXISTS dida_checklist_items (
                   library_id TEXT NOT NULL,
                   task_id TEXT NOT NULL,
                   item_id TEXT NOT NULL,
                   title TEXT NOT NULL,
                   status INTEGER NOT NULL DEFAULT 0,
                   sort_order INTEGER,
                   raw_json TEXT NOT NULL,
                   PRIMARY KEY (library_id, task_id, item_id)
                 );
                 CREATE TABLE IF NOT EXISTS dida_task_tags (
                   library_id TEXT NOT NULL,
                   task_id TEXT NOT NULL,
                   tag TEXT NOT NULL,
                   normalized_tag TEXT NOT NULL,
                   PRIMARY KEY (library_id, task_id, normalized_tag)
                 );
                 CREATE INDEX IF NOT EXISTS dida_tasks_project
                   ON dida_tasks(library_id, project_id, status, due_at);
                 CREATE INDEX IF NOT EXISTS dida_task_tags_lookup
                   ON dida_task_tags(library_id, normalized_tag, task_id);
                 INSERT INTO metadata (key,value) VALUES ('schema_version','17')
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value;",
            )
            .map_err(|error| format!("无法创建滴答清单缓存：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交滴答清单迁移：{error}"))?;
    }
    if schema_version < 18 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始滴答显示名称迁移：{error}"))?;
        transaction
            .execute_batch(
                "UPDATE libraries
                 SET name='滴答清单'
                 WHERE provider='dida365'
                   AND name='我的滴答清单'
                   AND COALESCE(json_extract(metadata_json,'$.displayNameCustomized'),0)=0;
                 UPDATE spaces
                 SET name='滴答清单'
                 WHERE provider='dida365'
                   AND name='我的滴答清单'
                   AND EXISTS (
                     SELECT 1 FROM libraries l
                     WHERE l.id=spaces.id AND l.provider='dida365'
                       AND COALESCE(json_extract(l.metadata_json,'$.displayNameCustomized'),0)=0
                   );
                 INSERT INTO metadata (key,value) VALUES ('schema_version','18')
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value;",
            )
            .map_err(|error| format!("无法迁移滴答显示名称：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交滴答显示名称迁移：{error}"))?;
    }
    if schema_version < 19 {
        let has_page_id = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('content_items')
                 WHERE name='page_id'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0)
            > 0;
        let has_page_title = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('content_items')
                 WHERE name='page_title'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0)
            > 0;
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始 Craft 子页面归属迁移：{error}"))?;
        if !has_page_id {
            transaction
                .execute(
                    "ALTER TABLE content_items
                     ADD COLUMN page_id TEXT NOT NULL DEFAULT ''",
                    [],
                )
                .map_err(|error| format!("无法添加 Craft 子页面 ID 字段：{error}"))?;
        }
        if !has_page_title {
            transaction
                .execute(
                    "ALTER TABLE content_items
                     ADD COLUMN page_title TEXT NOT NULL DEFAULT ''",
                    [],
                )
                .map_err(|error| format!("无法添加 Craft 子页面标题字段：{error}"))?;
        }
        let documents = {
            let mut statement = transaction
                .prepare(
                    "SELECT space_id,id,title,markdown
                     FROM documents WHERE provider='craft'",
                )
                .map_err(|error| format!("无法准备 Craft 子页面归属回填：{error}"))?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })
                .map_err(|error| format!("无法读取 Craft 子页面归属回填数据：{error}"))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("无法收集 Craft 子页面归属回填数据：{error}"))?
        };
        for (space_id, document_id, title, markdown) in documents {
            for chunk in chunk_markdown(&space_id, &document_id, &title, &markdown) {
                transaction
                    .execute(
                        "UPDATE content_items
                         SET page_id=?1,page_title=?2
                         WHERE id=?3 AND space_id=?4 AND document_id=?5",
                        params![
                            chunk.page_id,
                            chunk.page_title,
                            chunk.id,
                            space_id,
                            document_id
                        ],
                    )
                    .map_err(|error| format!("无法回填 Craft 子页面归属：{error}"))?;
            }
        }
        transaction
            .execute_batch(
                "UPDATE content_items
                 SET page_id=document_id,
                     page_title=COALESCE((
                       SELECT d.title FROM documents d
                       WHERE d.space_id=content_items.space_id
                         AND d.id=content_items.document_id
                     ),'')
                 WHERE page_id='';
                 INSERT INTO metadata (key,value) VALUES ('schema_version','19')
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value;",
            )
            .map_err(|error| format!("无法完成 Craft 子页面归属迁移：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交 Craft 子页面归属迁移：{error}"))?;
    }
    if schema_version < 20 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始飞书云空间名称迁移：{error}"))?;
        transaction
            .execute_batch(
                "UPDATE libraries
                 SET name='我的文档（云空间）'
                 WHERE provider='feishu'
                   AND location='space:my_library'
                   AND name='我的文档（普通文档）';
                 UPDATE spaces
                 SET name='我的文档（云空间）'
                 WHERE provider='feishu'
                   AND name='我的文档（普通文档）'
                   AND EXISTS (
                     SELECT 1 FROM libraries l
                     WHERE l.id=spaces.id AND l.provider='feishu'
                       AND l.location='space:my_library'
                   );
                 INSERT INTO metadata (key,value) VALUES ('schema_version','20')
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value;",
            )
            .map_err(|error| format!("无法迁移飞书云空间名称：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交飞书云空间名称迁移：{error}"))?;
    }
    if schema_version < 21 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始多维表格聚合迁移：{error}"))?;
        transaction
            .execute_batch(
                "INSERT INTO index_jobs
                   (job_key,space_id,source_id,source_type,job_type,status,priority,
                    created_at,updated_at,provider)
                 SELECT 'lexical:' || space_id || ':' || id,
                        space_id,id,'feishu_bitable_record','delete_lexical','pending',25,
                        strftime('%s','now'),strftime('%s','now'),'feishu'
                 FROM documents
                 WHERE provider='feishu' AND id LIKE 'bitable:%'
                 ON CONFLICT(job_key) DO UPDATE SET
                   source_type='feishu_bitable_record',job_type='delete_lexical',status='pending',
                   priority=25,attempts=0,updated_at=excluded.updated_at,last_error=NULL,
                   next_attempt_at=0,worker_id=NULL,locked_at=NULL,lease_until=NULL,
                   provider='feishu';
                 DELETE FROM content_items
                 WHERE provider='feishu' AND document_id LIKE 'bitable:%';
                 DELETE FROM documents
                 WHERE provider='feishu' AND id LIKE 'bitable:%';
                 INSERT INTO metadata (key,value) VALUES ('schema_version','21')
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value;",
            )
            .map_err(|error| format!("无法迁移多维表格聚合索引：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交多维表格聚合迁移：{error}"))?;
    }
    if schema_version < 22 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始飞书账号名称迁移：{error}"))?;
        transaction
            .execute_batch(
                "UPDATE libraries
                 SET name=COALESCE(
                   NULLIF(TRIM(json_extract(metadata_json,'$.accountName')),''),
                   name
                 )
                 WHERE provider='feishu'
                   AND location='space:my_library'
                   AND COALESCE(json_extract(metadata_json,'$.displayNameCustomized'),0)<>1;
                 UPDATE spaces
                 SET name=(SELECT l.name FROM libraries l WHERE l.id=spaces.id)
                 WHERE provider='feishu'
                   AND EXISTS (
                     SELECT 1 FROM libraries l
                     WHERE l.id=spaces.id AND l.provider='feishu'
                       AND l.location='space:my_library'
                   );
                 INSERT INTO metadata (key,value) VALUES ('schema_version','22')
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value;",
            )
            .map_err(|error| format!("无法迁移飞书账号名称：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交飞书账号名称迁移：{error}"))?;
    }
    if schema_version < 23 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始 Craft 标签迁移：{error}"))?;
        transaction
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS craft_tags (
                   space_id TEXT NOT NULL,
                   document_id TEXT NOT NULL,
                   page_id TEXT NOT NULL,
                   tag TEXT NOT NULL,
                   normalized_tag TEXT NOT NULL,
                   PRIMARY KEY (space_id, document_id, page_id, normalized_tag)
                 );
                 CREATE INDEX IF NOT EXISTS craft_tag_lookup
                   ON craft_tags(space_id, normalized_tag, document_id, page_id);",
            )
            .map_err(|error| format!("无法创建 Craft 标签索引：{error}"))?;
        let items = {
            let mut statement = transaction
                .prepare(
                    "SELECT ci.space_id,ci.document_id,COALESCE(NULLIF(ci.page_id,''),ci.document_id),ci.body
                     FROM content_items ci
                     JOIN documents d ON d.space_id=ci.space_id AND d.id=ci.document_id
                     WHERE d.provider='craft'",
                )
                .map_err(|error| format!("无法准备 Craft 标签回填：{error}"))?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })
                .map_err(|error| format!("无法读取 Craft 标签回填数据：{error}"))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("无法收集 Craft 标签回填数据：{error}"))?
        };
        for (space_id, document_id, page_id, body) in items {
            for tag in craft_markdown_tags(&body) {
                transaction
                    .execute(
                        "INSERT OR IGNORE INTO craft_tags
                           (space_id,document_id,page_id,tag,normalized_tag)
                         VALUES (?1,?2,?3,?4,?5)",
                        params![space_id, document_id, page_id, tag, tag.to_lowercase()],
                    )
                    .map_err(|error| format!("无法回填 Craft 标签：{error}"))?;
            }
        }
        transaction
            .execute_batch(
                "INSERT INTO index_jobs
                   (job_key,space_id,source_id,source_type,job_type,status,priority,
                    created_at,updated_at,provider)
                 SELECT 'lexical:' || d.space_id || ':' || d.id,
                        d.space_id,d.id,'document','upsert_lexical','pending',20,
                        strftime('%s','now'),strftime('%s','now'),d.provider
                 FROM documents d
                 WHERE d.provider IN ('craft','dida365')
                 ON CONFLICT(job_key) DO UPDATE SET
                   job_type='upsert_lexical',status='pending',priority=20,attempts=0,
                   updated_at=excluded.updated_at,last_error=NULL,next_attempt_at=0,
                   worker_id=NULL,locked_at=NULL,lease_until=NULL,provider=excluded.provider;",
            )
            .map_err(|error| format!("无法安排标签索引更新：{error}"))?;
        transaction
            .execute(
                "INSERT INTO metadata (key,value) VALUES ('schema_version','23')
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [],
            )
            .map_err(|error| format!("无法记录 Craft 标签迁移：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交 Craft 标签迁移：{error}"))?;
    }
    if schema_version < 24 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始闪卡数据迁移：{error}"))?;
        transaction
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS flashcard_decks (
                   id TEXT PRIMARY KEY,
                   name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                   created_at INTEGER NOT NULL,
                   updated_at INTEGER NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS flashcards (
                   id TEXT PRIMARY KEY,
                   deck_id TEXT NOT NULL,
                   question TEXT NOT NULL,
                   answer TEXT NOT NULL,
                   explanation TEXT NOT NULL DEFAULT '',
                   card_type TEXT NOT NULL DEFAULT 'qa',
                   source_library_id TEXT NOT NULL DEFAULT '',
                   source_document_id TEXT NOT NULL DEFAULT '',
                   source_block_id TEXT NOT NULL DEFAULT '',
                   source_title TEXT NOT NULL DEFAULT '',
                   source_path TEXT NOT NULL DEFAULT '',
                   source_hash TEXT NOT NULL DEFAULT '',
                   media_json TEXT NOT NULL DEFAULT '[]',
                   status TEXT NOT NULL DEFAULT 'active',
                   created_at INTEGER NOT NULL,
                   updated_at INTEGER NOT NULL,
                   due_at INTEGER NOT NULL,
                   interval_days REAL NOT NULL DEFAULT 0,
                   ease REAL NOT NULL DEFAULT 2.5,
                   repetitions INTEGER NOT NULL DEFAULT 0,
                   lapses INTEGER NOT NULL DEFAULT 0,
                   FOREIGN KEY (deck_id) REFERENCES flashcard_decks(id)
                 );
                 CREATE INDEX IF NOT EXISTS flashcards_due
                   ON flashcards(status, due_at, deck_id);
                 CREATE INDEX IF NOT EXISTS flashcards_source
                   ON flashcards(source_library_id, source_document_id, source_block_id);
                 CREATE TABLE IF NOT EXISTS flashcard_reviews (
                   id TEXT PRIMARY KEY,
                   card_id TEXT NOT NULL,
                   rating INTEGER NOT NULL,
                   reviewed_at INTEGER NOT NULL,
                   previous_due_at INTEGER NOT NULL,
                   next_due_at INTEGER NOT NULL,
                   previous_interval_days REAL NOT NULL,
                   next_interval_days REAL NOT NULL,
                   elapsed_ms INTEGER,
                   FOREIGN KEY (card_id) REFERENCES flashcards(id)
                 );
                 CREATE INDEX IF NOT EXISTS flashcard_reviews_card
                   ON flashcard_reviews(card_id, reviewed_at DESC);
                 INSERT INTO metadata (key,value) VALUES ('schema_version','24')
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value;",
            )
            .map_err(|error| format!("无法创建闪卡数据表：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交闪卡数据迁移：{error}"))?;
    }
    if schema_version < 25 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始闪卡收件箱迁移：{error}"))?;
        transaction
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS flashcard_import_batches (
                   id TEXT PRIMARY KEY,
                   format TEXT NOT NULL,
                   source_path TEXT NOT NULL DEFAULT '',
                   deck_name TEXT NOT NULL,
                   imported_at INTEGER NOT NULL,
                   total_count INTEGER NOT NULL,
                   valid_count INTEGER NOT NULL,
                   duplicate_count INTEGER NOT NULL,
                   invalid_count INTEGER NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS flashcard_drafts (
                   id TEXT PRIMARY KEY,
                   batch_id TEXT NOT NULL,
                   deck_name TEXT NOT NULL,
                   question TEXT NOT NULL,
                   answer TEXT NOT NULL,
                   explanation TEXT NOT NULL DEFAULT '',
                   card_type TEXT NOT NULL DEFAULT 'qa',
                   source_library_id TEXT NOT NULL DEFAULT '',
                   source_document_id TEXT NOT NULL DEFAULT '',
                   source_block_id TEXT NOT NULL DEFAULT '',
                   source_title TEXT NOT NULL DEFAULT '',
                   source_path TEXT NOT NULL DEFAULT '',
                   source_hash TEXT NOT NULL DEFAULT '',
                   media_json TEXT NOT NULL DEFAULT '[]',
                   tags_json TEXT NOT NULL DEFAULT '[]',
                   evidence TEXT NOT NULL DEFAULT '',
                   confidence REAL,
                   generation_json TEXT NOT NULL DEFAULT '{}',
                   idempotency_key TEXT NOT NULL,
                   status TEXT NOT NULL DEFAULT 'pending',
                   created_at INTEGER NOT NULL,
                   updated_at INTEGER NOT NULL,
                   FOREIGN KEY (batch_id) REFERENCES flashcard_import_batches(id)
                 );
                 CREATE INDEX IF NOT EXISTS flashcard_drafts_idempotency
                   ON flashcard_drafts(idempotency_key);
                 CREATE INDEX IF NOT EXISTS flashcard_drafts_pending
                   ON flashcard_drafts(status, created_at DESC);
                 INSERT INTO metadata (key,value) VALUES ('schema_version','25')
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value;",
            )
            .map_err(|error| format!("无法创建闪卡收件箱数据表：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交闪卡收件箱迁移：{error}"))?;
    }
    if schema_version < 26 {
        let flashcards_has_card_data = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('flashcards') WHERE name='card_data_json')",
                [],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|error| format!("无法检查闪卡多类型字段：{error}"))?;
        let drafts_has_card_data = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('flashcard_drafts') WHERE name='card_data_json')",
                [],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|error| format!("无法检查闪卡草稿多类型字段：{error}"))?;
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始多类型闪卡迁移：{error}"))?;
        if !flashcards_has_card_data {
            transaction
                .execute_batch(
                    "ALTER TABLE flashcards ADD COLUMN card_data_json TEXT NOT NULL DEFAULT '{}';",
                )
                .map_err(|error| format!("无法扩展闪卡多类型数据：{error}"))?;
        }
        if !drafts_has_card_data {
            transaction
                .execute_batch(
                    "ALTER TABLE flashcard_drafts ADD COLUMN card_data_json TEXT NOT NULL DEFAULT '{}';",
                )
                .map_err(|error| format!("无法扩展闪卡草稿多类型数据：{error}"))?;
        }
        transaction
            .execute(
                "INSERT INTO metadata (key,value) VALUES ('schema_version','26')
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [],
            )
            .map_err(|error| format!("无法记录多类型闪卡迁移版本：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交多类型闪卡迁移：{error}"))?;
    }
    if schema_version < 27 {
        let flashcard_columns = {
            let mut statement = connection
                .prepare("SELECT name FROM pragma_table_info('flashcards')")
                .map_err(|error| format!("无法检查闪卡管理字段：{error}"))?;
            let columns = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| format!("无法读取闪卡管理字段：{error}"))?
                .collect::<Result<HashSet<_>, _>>()
                .map_err(|error| format!("无法收集闪卡管理字段：{error}"))?;
            columns
        };
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始闪卡管理字段迁移：{error}"))?;
        for (column, definition) in [
            ("tags_json", "TEXT NOT NULL DEFAULT '[]'"),
            ("evidence", "TEXT NOT NULL DEFAULT ''"),
            ("confidence", "REAL"),
            ("custom_fields_json", "TEXT NOT NULL DEFAULT '{}'"),
            ("generation_json", "TEXT NOT NULL DEFAULT '{}'"),
        ] {
            if !flashcard_columns.contains(column) {
                transaction
                    .execute_batch(&format!(
                        "ALTER TABLE flashcards ADD COLUMN {column} {definition};"
                    ))
                    .map_err(|error| format!("无法扩展闪卡管理字段 {column}：{error}"))?;
            }
        }
        transaction
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS flashcard_sync_history (
                   id TEXT PRIMARY KEY,
                   started_at INTEGER NOT NULL,
                   completed_at INTEGER NOT NULL,
                   status TEXT NOT NULL,
                   uploaded_cards INTEGER NOT NULL DEFAULT 0,
                   downloaded_cards INTEGER NOT NULL DEFAULT 0,
                   merged_reviews INTEGER NOT NULL DEFAULT 0,
                   uploaded_media INTEGER NOT NULL DEFAULT 0,
                   downloaded_media INTEGER NOT NULL DEFAULT 0,
                   conflict_retries INTEGER NOT NULL DEFAULT 0,
                   error TEXT NOT NULL DEFAULT ''
                 );
                 CREATE INDEX IF NOT EXISTS flashcard_sync_history_completed
                   ON flashcard_sync_history(completed_at DESC);
                 INSERT INTO metadata (key,value) VALUES ('schema_version','27')
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value;",
            )
            .map_err(|error| format!("无法扩展闪卡管理字段：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交闪卡管理字段迁移：{error}"))?;
    }
    if schema_version < 28 {
        let deck_columns = {
            let mut statement = connection
                .prepare("SELECT name FROM pragma_table_info('flashcard_decks')")
                .map_err(|error| format!("无法检查闪卡牌组层级字段：{error}"))?;
            let columns = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| format!("无法读取闪卡牌组层级字段：{error}"))?
                .collect::<Result<HashSet<_>, _>>()
                .map_err(|error| format!("无法收集闪卡牌组层级字段：{error}"))?;
            columns
        };
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始闪卡牌组层级迁移：{error}"))?;
        transaction
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS flashcard_deck_folders (
                   id TEXT PRIMARY KEY,
                   name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                   sort_order INTEGER NOT NULL DEFAULT 0,
                   created_at INTEGER NOT NULL,
                   updated_at INTEGER NOT NULL
                 );",
            )
            .map_err(|error| format!("无法创建闪卡文件夹：{error}"))?;
        if !deck_columns.contains("folder_id") {
            transaction
                .execute_batch(
                    "ALTER TABLE flashcard_decks ADD COLUMN folder_id TEXT NOT NULL DEFAULT '';",
                )
                .map_err(|error| format!("无法增加牌组文件夹字段：{error}"))?;
        }
        if !deck_columns.contains("sort_order") {
            transaction
                .execute_batch(
                    "ALTER TABLE flashcard_decks ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;",
                )
                .map_err(|error| format!("无法增加牌组排序字段：{error}"))?;
        }
        transaction
            .execute_batch(
                "CREATE INDEX IF NOT EXISTS flashcard_decks_folder_order
                   ON flashcard_decks(folder_id,sort_order,name);
                 INSERT INTO metadata (key,value) VALUES ('schema_version','28')
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value;",
            )
            .map_err(|error| format!("无法记录闪卡牌组层级迁移：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交闪卡牌组层级迁移：{error}"))?;
    }
    if schema_version < 29 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始闪卡删除墓碑迁移：{error}"))?;
        transaction
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS flashcard_sync_tombstones (
                   entity_type TEXT NOT NULL,
                   entity_id TEXT NOT NULL,
                   deleted_at INTEGER NOT NULL,
                   PRIMARY KEY (entity_type,entity_id)
                 );
                 CREATE INDEX IF NOT EXISTS flashcard_sync_tombstones_deleted
                   ON flashcard_sync_tombstones(deleted_at);
                 INSERT INTO metadata (key,value) VALUES ('schema_version','29')
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value;",
            )
            .map_err(|error| format!("无法创建闪卡删除墓碑：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交闪卡删除墓碑迁移：{error}"))?;
    }
    if schema_version < 30 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始统一任务迁移：{error}"))?;
        transaction
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS unified_task_bindings (
                   hub_task_id TEXT NOT NULL,
                   provider TEXT NOT NULL,
                   library_id TEXT NOT NULL,
                   source_id TEXT NOT NULL,
                   document_id TEXT NOT NULL DEFAULT '',
                   source_hash TEXT NOT NULL DEFAULT '',
                   last_seen_at INTEGER NOT NULL,
                   missing_syncs INTEGER NOT NULL DEFAULT 0,
                   PRIMARY KEY (provider,library_id,source_id),
                   UNIQUE (hub_task_id,provider)
                 );
                 CREATE INDEX IF NOT EXISTS unified_task_bindings_hub
                   ON unified_task_bindings(hub_task_id);
                 CREATE TABLE IF NOT EXISTS craft_task_blocks (
                   space_id TEXT NOT NULL,
                   document_id TEXT NOT NULL,
                   block_id TEXT NOT NULL,
                   parent_page_id TEXT NOT NULL DEFAULT '',
                   parent_task_id TEXT NOT NULL DEFAULT '',
                   title TEXT NOT NULL,
                   completed INTEGER NOT NULL DEFAULT 0,
                   schedule_date TEXT NOT NULL DEFAULT '',
                   deadline_date TEXT NOT NULL DEFAULT '',
                   content TEXT NOT NULL DEFAULT '',
                   depth INTEGER NOT NULL DEFAULT 0,
                   source_hash TEXT NOT NULL,
                   modified_at INTEGER,
                   PRIMARY KEY (space_id,block_id)
                 );
                 CREATE INDEX IF NOT EXISTS craft_task_blocks_document
                   ON craft_task_blocks(space_id,document_id);
                 CREATE TABLE IF NOT EXISTS task_sync_snapshots (
                   hub_task_id TEXT NOT NULL,
                   provider TEXT NOT NULL,
                   source_hash TEXT NOT NULL,
                   applied_hash TEXT NOT NULL DEFAULT '',
                   source_modified_at INTEGER,
                   synced_at INTEGER NOT NULL,
                   PRIMARY KEY (hub_task_id,provider)
                 );
                 CREATE TABLE IF NOT EXISTS task_sync_events (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   hub_task_id TEXT NOT NULL,
                   origin_provider TEXT NOT NULL,
                   target_provider TEXT NOT NULL,
                   action TEXT NOT NULL,
                   status TEXT NOT NULL DEFAULT 'pending',
                   payload_json TEXT NOT NULL DEFAULT '{}',
                   idempotency_key TEXT NOT NULL UNIQUE,
                   attempts INTEGER NOT NULL DEFAULT 0,
                   created_at INTEGER NOT NULL,
                   updated_at INTEGER NOT NULL,
                   last_error TEXT
                 );
                 CREATE INDEX IF NOT EXISTS task_sync_events_pending
                   ON task_sync_events(status,created_at);
                 CREATE TABLE IF NOT EXISTS task_sync_tombstones (
                   hub_task_id TEXT NOT NULL,
                   provider TEXT NOT NULL,
                   source_id TEXT NOT NULL,
                   first_missing_at INTEGER NOT NULL,
                   missing_syncs INTEGER NOT NULL DEFAULT 1,
                   confirmed_at INTEGER,
                   PRIMARY KEY (provider,source_id)
                 );
                 CREATE TABLE IF NOT EXISTS task_sync_settings (
                   id INTEGER PRIMARY KEY CHECK (id=1),
                   enabled INTEGER NOT NULL DEFAULT 0,
                   craft_to_dida INTEGER NOT NULL DEFAULT 1,
                   dida_to_craft INTEGER NOT NULL DEFAULT 1,
                   sync_deletions INTEGER NOT NULL DEFAULT 1,
                   conflict_policy TEXT NOT NULL DEFAULT 'review',
                   dida_project_id TEXT NOT NULL DEFAULT '',
                   updated_at INTEGER NOT NULL
                 );
                 INSERT OR IGNORE INTO task_sync_settings
                   (id,enabled,craft_to_dida,dida_to_craft,sync_deletions,conflict_policy,dida_project_id,updated_at)
                 VALUES (1,0,1,1,1,'review','',strftime('%s','now'));
                 INSERT INTO metadata (key,value) VALUES ('schema_version','30')
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value;",
            )
            .map_err(|error| format!("无法创建统一任务同步表：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交统一任务迁移：{error}"))?;
    }
    if schema_version < 31 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始任务同步目标迁移：{error}"))?;
        let has_dida_library_id = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('task_sync_settings')
                               WHERE name='dida_library_id')",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0)
            != 0;
        if !has_dida_library_id {
            transaction
                .execute_batch(
                    "ALTER TABLE task_sync_settings ADD COLUMN dida_library_id TEXT NOT NULL DEFAULT '';",
                )
                .map_err(|error| format!("无法保存任务同步目标资料库：{error}"))?;
        }
        transaction
            .execute(
                "INSERT INTO metadata (key,value) VALUES ('schema_version','31')
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [],
            )
            .map_err(|error| format!("无法更新任务同步数据库版本：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交任务同步目标迁移：{error}"))?;
    }
    if schema_version < 32 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始 Craft 子任务迁移：{error}"))?;
        let has_parent_task_id = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('craft_task_blocks')
                               WHERE name='parent_task_id')",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0)
            != 0;
        if !has_parent_task_id {
            transaction
                .execute_batch(
                    "ALTER TABLE craft_task_blocks ADD COLUMN parent_task_id TEXT NOT NULL DEFAULT '';",
                )
                .map_err(|error| format!("无法保存 Craft 父任务标识：{error}"))?;
        }
        transaction
            .execute(
                "INSERT INTO metadata (key,value) VALUES ('schema_version','32')
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [],
            )
            .map_err(|error| format!("无法更新 Craft 子任务数据库版本：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交 Craft 子任务迁移：{error}"))?;
    }
    if schema_version < 33 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始 Craft 项目页面迁移：{error}"))?;
        transaction
            .execute(
                "INSERT INTO metadata (key,value) VALUES ('schema_version','33')
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [],
            )
            .map_err(|error| format!("无法更新 Craft 项目页面数据库版本：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交 Craft 项目页面迁移：{error}"))?;
    }
    if schema_version < 34 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始 Craft 任务日期迁移：{error}"))?;
        let has_schedule_date = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('craft_task_blocks')
                               WHERE name='schedule_date')",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0)
            != 0;
        if !has_schedule_date {
            transaction
                .execute_batch(
                    "ALTER TABLE craft_task_blocks ADD COLUMN schedule_date TEXT NOT NULL DEFAULT '';
                     ALTER TABLE craft_task_blocks ADD COLUMN deadline_date TEXT NOT NULL DEFAULT '';",
                )
                .map_err(|error| format!("无法保存 Craft 任务日期：{error}"))?;
        }
        transaction
            .execute(
                "INSERT INTO metadata (key,value) VALUES ('schema_version','34')
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [],
            )
            .map_err(|error| format!("无法更新 Craft 任务日期数据库版本：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交 Craft 任务日期迁移：{error}"))?;
    }
    if schema_version < 35 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始任务详情同步迁移：{error}"))?;
        transaction
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS task_sync_craft_content (
                   hub_task_id TEXT PRIMARY KEY,
                   content_hash TEXT NOT NULL,
                   block_ids_json TEXT NOT NULL DEFAULT '[]',
                   updated_at INTEGER NOT NULL
                 );
                 INSERT INTO metadata (key,value) VALUES ('schema_version','35')
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value;",
            )
            .map_err(|error| format!("无法创建任务详情同步记录：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交任务详情同步迁移：{error}"))?;
    }
    if schema_version < 36 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始 Craft 任务详情迁移：{error}"))?;
        let has_content = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('craft_task_blocks')
                               WHERE name='content')",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0)
            != 0;
        if !has_content {
            transaction
                .execute_batch(
                    "ALTER TABLE craft_task_blocks ADD COLUMN content TEXT NOT NULL DEFAULT '';
                     UPDATE documents SET content_hash='' WHERE provider='craft';",
                )
                .map_err(|error| format!("无法保存 Craft 任务详情：{error}"))?;
        }
        transaction
            .execute(
                "INSERT INTO metadata (key,value) VALUES ('schema_version','36')
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [],
            )
            .map_err(|error| format!("无法更新 Craft 任务详情数据库版本：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交 Craft 任务详情迁移：{error}"))?;
    }
    if schema_version < 37 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始滴答任务附件迁移：{error}"))?;
        transaction
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS task_sync_dida_attachments (
                   hub_task_id TEXT NOT NULL,
                   dida_task_id TEXT NOT NULL,
                   craft_blob_hash TEXT NOT NULL,
                   attachment_id TEXT NOT NULL,
                   file_name TEXT NOT NULL,
                   mime_type TEXT NOT NULL,
                   updated_at INTEGER NOT NULL,
                   PRIMARY KEY (hub_task_id,dida_task_id,craft_blob_hash)
                 );
                 INSERT INTO metadata (key,value) VALUES ('schema_version','37')
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value;",
            )
            .map_err(|error| format!("无法创建滴答任务附件映射：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交滴答任务附件迁移：{error}"))?;
    }
    if schema_version < 38 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始任务同步日志迁移：{error}"))?;
        transaction
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS task_sync_runs (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   started_at INTEGER NOT NULL,
                   completed_at INTEGER NOT NULL,
                   full_reconcile INTEGER NOT NULL DEFAULT 0,
                   status TEXT NOT NULL,
                   summary TEXT NOT NULL DEFAULT ''
                 );
                 CREATE INDEX IF NOT EXISTS idx_task_sync_runs_completed
                   ON task_sync_runs(completed_at DESC);
                 CREATE TABLE IF NOT EXISTS task_sync_run_entries (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   run_id INTEGER NOT NULL,
                   occurred_at INTEGER NOT NULL,
                   title TEXT NOT NULL DEFAULT '',
                   action TEXT NOT NULL,
                   source_provider TEXT NOT NULL DEFAULT '',
                   target_provider TEXT NOT NULL DEFAULT '',
                   status TEXT NOT NULL DEFAULT 'success',
                   detail TEXT NOT NULL DEFAULT '',
                   FOREIGN KEY(run_id) REFERENCES task_sync_runs(id) ON DELETE CASCADE
                 );
                 CREATE INDEX IF NOT EXISTS idx_task_sync_run_entries_run
                   ON task_sync_run_entries(run_id,id);
                 INSERT INTO metadata (key,value) VALUES ('schema_version','38')
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value;",
            )
            .map_err(|error| format!("无法创建任务同步日志：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交任务同步日志迁移：{error}"))?;
    }
    if schema_version < 39 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始 Craft 废纸篓记录迁移：{error}"))?;
        transaction
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS task_sync_craft_trash_documents (
                   library_id TEXT NOT NULL,
                   document_id TEXT NOT NULL,
                   confirmed_at INTEGER NOT NULL,
                   PRIMARY KEY(library_id,document_id)
                 );
                 CREATE INDEX IF NOT EXISTS idx_task_sync_craft_trash_confirmed
                   ON task_sync_craft_trash_documents(confirmed_at DESC);
                 INSERT OR IGNORE INTO task_sync_craft_trash_documents
                   (library_id,document_id,confirmed_at)
                 SELECT DISTINCT b.space_id,b.document_id,strftime('%s','now')
                 FROM craft_task_blocks b
                 JOIN task_sync_runs r
                   ON instr(upper(r.summary),upper(b.block_id))>0
                 WHERE instr(lower(r.summary),'cannot modify document in trash')>0;
                 INSERT INTO metadata (key,value) VALUES ('schema_version','39')
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value;",
            )
            .map_err(|error| format!("无法创建 Craft 废纸篓记录：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交 Craft 废纸篓记录迁移：{error}"))?;
    }
    if schema_version < 40 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始 Craft 任务来源墓碑迁移：{error}"))?;
        transaction
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS task_sync_craft_source_tombstones (
                   library_id TEXT NOT NULL,
                   source_id TEXT NOT NULL,
                   deleted_at INTEGER NOT NULL,
                   reason TEXT NOT NULL DEFAULT '',
                   PRIMARY KEY(library_id,source_id)
                 );
                 CREATE INDEX IF NOT EXISTS idx_task_sync_craft_source_tombstones_deleted
                   ON task_sync_craft_source_tombstones(deleted_at DESC);
                 INSERT INTO metadata (key,value) VALUES ('schema_version','40')
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value;",
            )
            .map_err(|error| format!("无法创建 Craft 任务来源墓碑：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交 Craft 任务来源墓碑迁移：{error}"))?;
    }
    if schema_version < 41 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始任务同步排除迁移：{error}"))?;
        transaction
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS task_sync_exclusions (
                   provider TEXT NOT NULL,
                   library_id TEXT NOT NULL,
                   source_id TEXT NOT NULL,
                   delete_dida INTEGER NOT NULL DEFAULT 0,
                   reason TEXT NOT NULL DEFAULT '',
                   created_at INTEGER NOT NULL,
                   PRIMARY KEY(provider,library_id,source_id)
                 );
                 CREATE INDEX IF NOT EXISTS idx_task_sync_exclusions_created
                   ON task_sync_exclusions(created_at DESC);
                 INSERT INTO metadata (key,value) VALUES ('schema_version','41')
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value;",
            )
            .map_err(|error| format!("无法创建任务同步排除记录：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交任务同步排除迁移：{error}"))?;
    }
    if schema_version < 42 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始飞书任务同步迁移：{error}"))?;
        transaction
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS feishu_task_sync_settings (
                   id INTEGER PRIMARY KEY CHECK (id=1),
                   enabled INTEGER NOT NULL DEFAULT 0,
                   feishu_library_id TEXT NOT NULL DEFAULT '',
                   dida_library_id TEXT NOT NULL DEFAULT '',
                   dida_project_id TEXT NOT NULL DEFAULT '',
                   updated_at INTEGER NOT NULL
                 );
                 INSERT OR IGNORE INTO feishu_task_sync_settings
                   (id,enabled,feishu_library_id,dida_library_id,dida_project_id,updated_at)
                 VALUES (1,0,'','','',strftime('%s','now'));
                 CREATE TABLE IF NOT EXISTS feishu_task_bindings (
                   feishu_library_id TEXT NOT NULL,
                   feishu_task_guid TEXT NOT NULL,
                   dida_library_id TEXT NOT NULL,
                   dida_task_id TEXT NOT NULL,
                   feishu_hash TEXT NOT NULL DEFAULT '',
                   dida_hash TEXT NOT NULL DEFAULT '',
                   feishu_modified_at INTEGER,
                   dida_modified_at INTEGER,
                   last_synced_at INTEGER NOT NULL,
                   PRIMARY KEY (feishu_library_id,feishu_task_guid),
                   UNIQUE (dida_library_id,dida_task_id)
                 );
                 CREATE INDEX IF NOT EXISTS idx_feishu_task_bindings_dida
                   ON feishu_task_bindings(dida_library_id,dida_task_id);
                 INSERT INTO metadata (key,value) VALUES ('schema_version','42')
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value;",
            )
            .map_err(|error| format!("无法创建飞书任务同步表：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交飞书任务同步迁移：{error}"))?;
    }
    if schema_version < 43 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始飞书账号授权迁移：{error}"))?;
        transaction
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS feishu_authorizations (
                   id TEXT PRIMARY KEY,
                   name TEXT NOT NULL,
                   app_id TEXT NOT NULL,
                   enabled INTEGER NOT NULL DEFAULT 1,
                   added_at INTEGER NOT NULL,
                   metadata_json TEXT NOT NULL DEFAULT '{}'
                 );
                 CREATE INDEX IF NOT EXISTS idx_feishu_authorizations_enabled
                   ON feishu_authorizations(enabled,added_at);
                 INSERT INTO metadata (key,value) VALUES ('schema_version','43')
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value;",
            )
            .map_err(|error| format!("无法创建飞书账号授权表：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交飞书账号授权迁移：{error}"))?;
    }
    if schema_version < 44 {
        let has_detail_hash = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('feishu_task_bindings')
                 WHERE name='feishu_detail_hash'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| format!("无法检查飞书任务详情迁移：{error}"))?
            > 0;
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始飞书任务详情迁移：{error}"))?;
        if !has_detail_hash {
            transaction
                .execute_batch(
                    "ALTER TABLE feishu_task_bindings
                     ADD COLUMN feishu_detail_hash TEXT NOT NULL DEFAULT '';",
                )
                .map_err(|error| format!("无法增加飞书任务详情哈希：{error}"))?;
        }
        transaction
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS feishu_task_attachments (
                   feishu_library_id TEXT NOT NULL,
                   task_guid TEXT NOT NULL,
                   attachment_key TEXT NOT NULL,
                   source_ref TEXT NOT NULL,
                   file_name TEXT NOT NULL,
                   mime_type TEXT NOT NULL DEFAULT '',
                   blob_hash TEXT NOT NULL,
                   size INTEGER NOT NULL DEFAULT 0,
                   updated_at INTEGER NOT NULL,
                   PRIMARY KEY(feishu_library_id,task_guid,attachment_key)
                 );
                 CREATE INDEX IF NOT EXISTS idx_feishu_task_attachments_blob
                   ON feishu_task_attachments(blob_hash);
                 INSERT INTO metadata (key,value) VALUES ('schema_version','44')
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value;",
            )
            .map_err(|error| format!("无法创建飞书任务详情缓存：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交飞书任务详情迁移：{error}"))?;
    }
    if schema_version < 45 {
        let has_interval = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('task_sync_settings')
                 WHERE name='background_sync_interval_minutes'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| format!("无法检查任务后台同步频率迁移：{error}"))?
            > 0;
        let has_last_attempt = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('task_sync_settings')
                 WHERE name='last_background_sync_attempt_at'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| format!("无法检查任务后台同步时间迁移：{error}"))?
            > 0;
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始任务后台同步设置迁移：{error}"))?;
        if !has_interval {
            transaction
                .execute_batch(
                    "ALTER TABLE task_sync_settings
                     ADD COLUMN background_sync_interval_minutes INTEGER NOT NULL DEFAULT 15;",
                )
                .map_err(|error| format!("无法增加任务后台同步频率：{error}"))?;
        }
        if !has_last_attempt {
            transaction
                .execute_batch(
                    "ALTER TABLE task_sync_settings
                     ADD COLUMN last_background_sync_attempt_at INTEGER NOT NULL DEFAULT 0;",
                )
                .map_err(|error| format!("无法增加任务后台同步时间：{error}"))?;
        }
        transaction
            .execute(
                "UPDATE task_sync_settings
                 SET last_background_sync_attempt_at=strftime('%s','now')
                 WHERE id=1 AND last_background_sync_attempt_at=0",
                [],
            )
            .map_err(|error| format!("无法初始化任务后台同步时间：{error}"))?;
        transaction
            .execute(
                "INSERT INTO metadata (key,value) VALUES ('schema_version','45')
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [],
            )
            .map_err(|error| format!("无法更新任务后台同步数据库版本：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交任务后台同步设置迁移：{error}"))?;
    }
    if schema_version < 46 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始标签治理建议迁移：{error}"))?;
        transaction
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS tag_governance_proposals (
                   id TEXT PRIMARY KEY,
                   schema_version TEXT NOT NULL,
                   index_revision TEXT NOT NULL,
                   status TEXT NOT NULL DEFAULT 'pending',
                   summary TEXT NOT NULL DEFAULT '',
                   tag_ids_json TEXT NOT NULL DEFAULT '[]',
                   proposal_json TEXT NOT NULL,
                   generator_json TEXT NOT NULL DEFAULT '{}',
                   idempotency_key TEXT NOT NULL DEFAULT '',
                   resolution_note TEXT NOT NULL DEFAULT '',
                   created_at INTEGER NOT NULL,
                   updated_at INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS tag_governance_proposals_status
                   ON tag_governance_proposals(status,created_at DESC);
                 CREATE UNIQUE INDEX IF NOT EXISTS tag_governance_proposals_idempotency
                   ON tag_governance_proposals(idempotency_key)
                   WHERE idempotency_key<>'';
                 INSERT INTO metadata (key,value) VALUES ('schema_version','46')
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value;",
            )
            .map_err(|error| format!("无法创建标签治理建议表：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交标签治理建议迁移：{error}"))?;
    }
    if schema_version < 47 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始 Hub 内部标签体系迁移：{error}"))?;
        transaction
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS tag_taxonomy_relations (
                   id TEXT PRIMARY KEY,
                   relation_type TEXT NOT NULL,
                   source_tag_id TEXT NOT NULL,
                   target_tag_id TEXT NOT NULL DEFAULT '',
                   proposal_id TEXT NOT NULL,
                   recommendation_id TEXT NOT NULL DEFAULT '',
                   recommendation_index INTEGER NOT NULL,
                   rationale TEXT NOT NULL DEFAULT '',
                   created_at INTEGER NOT NULL
                 );
                 CREATE UNIQUE INDEX IF NOT EXISTS tag_taxonomy_relations_origin
                   ON tag_taxonomy_relations(proposal_id,recommendation_index,relation_type,source_tag_id,target_tag_id);
                 CREATE INDEX IF NOT EXISTS tag_taxonomy_relations_source
                   ON tag_taxonomy_relations(source_tag_id,relation_type);
                 CREATE INDEX IF NOT EXISTS tag_taxonomy_relations_target
                   ON tag_taxonomy_relations(target_tag_id,relation_type);
                 INSERT INTO metadata (key,value) VALUES ('schema_version','47')
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value;",
            )
            .map_err(|error| format!("无法创建 Hub 内部标签关系表：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交 Hub 内部标签体系迁移：{error}"))?;
    }
    if schema_version < 48 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始历史标签治理关系回填：{error}"))?;
        transaction
            .execute_batch(
                "WITH recommendations AS (
                   SELECT proposal.id AS proposal_id,
                          proposal.updated_at AS accepted_at,
                          CAST(recommendation.key AS INTEGER) AS recommendation_index,
                          recommendation.value AS recommendation
                   FROM tag_governance_proposals proposal,
                        json_each(proposal.proposal_json,'$.recommendations') recommendation
                   WHERE proposal.status='accepted'
                 ), normalized_relations AS (
                   SELECT proposal_id,accepted_at,recommendation_index,recommendation,
                          json_extract(recommendation,'$.type') AS relation_type,
                          lower(trim(CAST(source.value AS TEXT))) AS source_tag_id,
                          lower(trim(COALESCE(json_extract(recommendation,'$.targetTagId'),''))) AS raw_target_tag_id
                   FROM recommendations,json_each(recommendation,'$.sourceTagIds') source
                 )
                 INSERT OR IGNORE INTO tag_taxonomy_relations
                   (id,relation_type,source_tag_id,target_tag_id,proposal_id,
                    recommendation_id,recommendation_index,rationale,created_at)
                 SELECT 'tag-relation-' || lower(hex(randomblob(12))),
                        relation_type,source_tag_id,
                        CASE WHEN relation_type='retire' AND raw_target_tag_id=source_tag_id
                             THEN '' ELSE raw_target_tag_id END,
                        proposal_id,
                        COALESCE(NULLIF(trim(json_extract(recommendation,'$.id')),''),
                                 'recommendation-' || (recommendation_index + 1)),
                        recommendation_index,
                        COALESCE(json_extract(recommendation,'$.rationale'),''),
                        accepted_at
                 FROM normalized_relations
                 WHERE relation_type IN ('alias','merge','parent_child','split','retire')
                   AND source_tag_id<>''
                   AND (relation_type IN ('split','retire')
                        OR (raw_target_tag_id<>'' AND raw_target_tag_id<>source_tag_id));
                 INSERT INTO metadata (key,value) VALUES ('schema_version','48')
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value;",
            )
            .map_err(|error| format!("无法回填历史标签治理关系：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交历史标签治理关系回填：{error}"))?;
    }
    if schema_version < 49 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始标签体系修复审计迁移：{error}"))?;
        transaction
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS tag_taxonomy_repair_runs (
                   id TEXT PRIMARY KEY,
                   previous_taxonomy_revision TEXT NOT NULL,
                   taxonomy_revision TEXT NOT NULL,
                   proposal_ids_json TEXT NOT NULL,
                   removed_relation_count INTEGER NOT NULL,
                   before_health_json TEXT NOT NULL,
                   after_health_json TEXT NOT NULL,
                   change_json TEXT NOT NULL,
                   note TEXT NOT NULL DEFAULT '',
                   created_at INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS tag_taxonomy_repair_runs_created
                   ON tag_taxonomy_repair_runs(created_at DESC,id DESC);
                 INSERT INTO metadata (key,value) VALUES ('schema_version','49')
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value;",
            )
            .map_err(|error| format!("无法创建标签体系修复审计表：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交标签体系修复审计迁移：{error}"))?;
    }
    if schema_version < 50 {
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        transaction.execute_batch(
            "CREATE TABLE IF NOT EXISTS tag_audit_runs (
                id TEXT PRIMARY KEY,
                start_key TEXT NOT NULL UNIQUE,
                index_revision TEXT NOT NULL,
                state_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS tag_audit_runs_recent ON tag_audit_runs(updated_at DESC,id DESC);
             CREATE TABLE IF NOT EXISTS tag_audit_receipts (
                run_id TEXT NOT NULL REFERENCES tag_audit_runs(id),
                request_id TEXT NOT NULL,
                request_hash TEXT NOT NULL,
                PRIMARY KEY(run_id,request_id)
             );
             INSERT INTO metadata(key,value) VALUES ('schema_version','50')
             ON CONFLICT(key) DO UPDATE SET value=excluded.value;"
        ).map_err(|error| format!("无法创建标签审计断点表：{error}"))?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    if schema_version < 51 {
        let transaction = connection.transaction().map_err(|e| e.to_string())?;
        transaction.execute_batch(
            "CREATE TABLE IF NOT EXISTS tag_assignment_definitions (
                tag TEXT PRIMARY KEY, version INTEGER NOT NULL,
                definition_json TEXT NOT NULL, updated_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS tag_assignment_proposals (
                id TEXT PRIMARY KEY, tag TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected','withdrawn')),
                version INTEGER NOT NULL DEFAULT 1,
                proposal_json TEXT NOT NULL, request_key TEXT NOT NULL UNIQUE,
                request_hash TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS tag_assignment_review ON tag_assignment_proposals(status,tag,created_at DESC,id DESC);
             CREATE TABLE IF NOT EXISTS hub_content_tags (
                library_id TEXT NOT NULL, provider TEXT NOT NULL, document_id TEXT NOT NULL,
                page_id TEXT NOT NULL DEFAULT '', tag TEXT NOT NULL,
                proposal_id TEXT NOT NULL UNIQUE REFERENCES tag_assignment_proposals(id),
                PRIMARY KEY(library_id,provider,document_id,page_id,tag)
             );
             CREATE VIEW IF NOT EXISTS hub_content_tag_memberships AS
             SELECT h.library_id,h.provider,h.document_id,h.page_id,
                    CASE WHEN h.provider='dida365' THEN h.document_id ELSE '' END task_id,
                    CASE WHEN h.provider='craft' THEN h.document_id || ':' || h.page_id ELSE h.document_id END entity_id,
                    h.tag,h.tag normalized_tag
             FROM hub_content_tags h JOIN documents d ON d.space_id=h.library_id AND d.id=h.document_id AND d.provider=h.provider
             WHERE h.provider<>'craft' OR h.page_id=h.document_id OR EXISTS (
                SELECT 1 FROM content_items c WHERE c.space_id=h.library_id AND c.document_id=h.document_id AND c.page_id=h.page_id
             );
             INSERT INTO metadata(key,value) VALUES ('schema_version','51')
             ON CONFLICT(key) DO UPDATE SET value=excluded.value;"
        ).map_err(|e| format!("无法迁移内容补标：{e}"))?;
        transaction.commit().map_err(|e| e.to_string())?;
    }
    if schema_version < 52 {
        let tx = connection.transaction().map_err(|e| e.to_string())?;
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS tag_content_scan_runs (
                id TEXT PRIMARY KEY, tag TEXT NOT NULL, definition_json TEXT NOT NULL,
                version INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'active',
                max_entities INTEGER NOT NULL, max_chars INTEGER NOT NULL,
                entities_read INTEGER NOT NULL DEFAULT 0, chars_read INTEGER NOT NULL DEFAULT 0,
                request_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL, created_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS tag_content_scan_items (
                run_id TEXT NOT NULL REFERENCES tag_content_scan_runs(id), ordinal INTEGER NOT NULL,
                source_json TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'unread',
                source_hash TEXT NOT NULL DEFAULT '', spans_json TEXT NOT NULL DEFAULT '[]',
                proposal_id TEXT NOT NULL DEFAULT '', decision TEXT NOT NULL DEFAULT '',
                error TEXT NOT NULL DEFAULT '', read_once INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(run_id,ordinal), UNIQUE(run_id,source_json)
             );
             CREATE TABLE IF NOT EXISTS tag_content_scan_receipts (
                run_id TEXT NOT NULL REFERENCES tag_content_scan_runs(id), request_id TEXT NOT NULL,
                request_hash TEXT NOT NULL, response_json TEXT NOT NULL,
                PRIMARY KEY(run_id,request_id)
             );
             INSERT INTO metadata(key,value) VALUES ('schema_version','52')
             ON CONFLICT(key) DO UPDATE SET value=excluded.value;"
        ).map_err(|e| format!("无法迁移内容扫描台账：{e}"))?;
        tx.commit().map_err(|e| e.to_string())?;
    }
    if schema_version < 53 {
        let tx = connection.transaction().map_err(|e| e.to_string())?;
        tx.execute_batch("CREATE TABLE IF NOT EXISTS tag_content_scan_budget_history (
            run_id TEXT NOT NULL REFERENCES tag_content_scan_runs(id), request_id TEXT NOT NULL,
            request_hash TEXT NOT NULL, change_json TEXT NOT NULL, created_at INTEGER NOT NULL,
            PRIMARY KEY(run_id,request_id));
            INSERT INTO metadata(key,value) VALUES ('schema_version','53') ON CONFLICT(key) DO UPDATE SET value=excluded.value;")
            .map_err(|e|format!("无法迁移扫描预算记录：{e}"))?;
        tx.commit().map_err(|e| e.to_string())?;
    }
    if schema_version < 54 {
        let tx = connection.transaction().map_err(|e| e.to_string())?;
        let has_reopened_version:bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('tag_content_scan_items') WHERE name='reopened_version')",[],|row|row.get(0)).map_err(|e|e.to_string())?;
        if !has_reopened_version {
            tx.execute_batch("ALTER TABLE tag_content_scan_items ADD COLUMN reopened_version INTEGER NOT NULL DEFAULT 0;").map_err(|e|format!("无法迁移重新开放版本：{e}"))?;
        }
        tx.execute_batch("CREATE TABLE IF NOT EXISTS tag_content_scan_reopen_history (
                run_id TEXT NOT NULL REFERENCES tag_content_scan_runs(id), request_id TEXT NOT NULL,
                request_hash TEXT NOT NULL, change_json TEXT NOT NULL, created_at INTEGER NOT NULL,
                PRIMARY KEY(run_id,request_id));
            INSERT INTO metadata(key,value) VALUES ('schema_version','54') ON CONFLICT(key) DO UPDATE SET value=excluded.value;")
            .map_err(|e|format!("无法迁移单项重新开放记录：{e}"))?;
        tx.commit().map_err(|e| e.to_string())?;
    }
    if schema_version < 55 {
        connection.execute_batch("BEGIN;
            CREATE TABLE IF NOT EXISTS tag_assignment_exclusion_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT, tag TEXT NOT NULL, entity_id TEXT NOT NULL,
                proposal_id TEXT NOT NULL, excluded INTEGER NOT NULL CHECK(excluded IN (0,1)),
                request_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS idx_assignment_exclusion_scope ON tag_assignment_exclusion_events(tag,entity_id,id DESC);
            INSERT INTO metadata(key,value) VALUES ('schema_version','55') ON CONFLICT(key) DO UPDATE SET value=excluded.value;
            COMMIT;").map_err(|e|format!("无法迁移补标排除偏好：{e}"))?;
    }
    // Older binaries do not understand the terminal, explicitly restorable excluded scan state.
    if schema_version < 56 {
        connection.execute("INSERT INTO metadata(key,value) VALUES ('schema_version','56') ON CONFLICT(key) DO UPDATE SET value=excluded.value", [])
            .map_err(|e|format!("无法迁移扫描排除状态版本：{e}"))?;
    }
    if schema_version < 57 {
        connection.execute_batch("BEGIN;
            CREATE TABLE IF NOT EXISTS tag_content_scan_joint_selections (run_id TEXT PRIMARY KEY REFERENCES tag_content_scan_runs(id), contexts_json TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS tag_content_scan_joint_items (run_id TEXT NOT NULL REFERENCES tag_content_scan_runs(id), ordinal INTEGER NOT NULL, tag TEXT NOT NULL, state TEXT NOT NULL, proposal_id TEXT NOT NULL DEFAULT '', source_hash TEXT NOT NULL, PRIMARY KEY(run_id,ordinal,tag));
            INSERT INTO metadata(key,value) VALUES ('schema_version','57') ON CONFLICT(key) DO UPDATE SET value=excluded.value;
            COMMIT;").map_err(|e|format!("无法迁移联合取证断点：{e}"))?;
    }
    if schema_version < 58 {
        let tx = connection.transaction().map_err(|e| e.to_string())?;
        let has_mode:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('tag_content_scan_runs') WHERE name='manifest_mode')",[],|row|row.get(0)).map_err(|e|e.to_string())?;
        if !has_mode {
            tx.execute_batch("ALTER TABLE tag_content_scan_runs ADD COLUMN manifest_mode TEXT NOT NULL DEFAULT 'single';").map_err(|e|e.to_string())?;
        }
        tx.execute_batch("
            INSERT INTO metadata(key,value) VALUES ('schema_version','58') ON CONFLICT(key) DO UPDATE SET value=excluded.value;
            ").map_err(|e|format!("无法迁移联合范围扫描：{e}"))?;
        tx.commit().map_err(|e| e.to_string())?;
    }
    if schema_version < 59 {
        connection.execute_batch("BEGIN IMMEDIATE;
            CREATE TABLE IF NOT EXISTS tag_content_scan_incremental (run_id TEXT PRIMARY KEY REFERENCES tag_content_scan_runs(id), base_run_id TEXT NOT NULL REFERENCES tag_content_scan_runs(id), baseline_hash TEXT NOT NULL);
            INSERT INTO metadata(key,value) VALUES ('schema_version','59') ON CONFLICT(key) DO UPDATE SET value=excluded.value;
            COMMIT;").map_err(|e|format!("无法迁移增量任务：{e}"))?;
    }
    if schema_version < 60 {
        connection.execute_batch("BEGIN IMMEDIATE;
            CREATE TABLE IF NOT EXISTS tag_content_scan_checks (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES tag_content_scan_runs(id), request_id TEXT NOT NULL, request_hash TEXT NOT NULL, response_json TEXT NOT NULL, UNIQUE(run_id,request_id));
            CREATE INDEX IF NOT EXISTS tag_content_scan_checks_latest ON tag_content_scan_checks(run_id,id DESC);
            INSERT INTO metadata(key,value) VALUES ('schema_version','60') ON CONFLICT(key) DO UPDATE SET value=excluded.value;
            COMMIT;").map_err(|e|format!("无法迁移检查断点：{e}"))?;
    }
    if schema_version < 61 {
        connection.execute_batch("BEGIN IMMEDIATE;
            CREATE TABLE IF NOT EXISTS tag_assignment_exclusion_reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, exclusion_event_id INTEGER NOT NULL REFERENCES tag_assignment_exclusion_events(id), reviewed_at INTEGER NOT NULL, next_review_at INTEGER NOT NULL, change_json TEXT NOT NULL, request_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS exclusion_reviews_event ON tag_assignment_exclusion_reviews(exclusion_event_id,id DESC);
            INSERT INTO metadata(key,value) VALUES ('schema_version','61') ON CONFLICT(key) DO UPDATE SET value=excluded.value;
            COMMIT;").map_err(|e|format!("无法迁移排除复核：{e}"))?;
    }
    if schema_version < 62 {
        connection.execute_batch("BEGIN IMMEDIATE;
            CREATE TABLE IF NOT EXISTS tag_assignment_definition_drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, tag TEXT NOT NULL, base_version INTEGER NOT NULL, definition_json TEXT NOT NULL, request_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS assignment_definition_drafts_tag ON tag_assignment_definition_drafts(tag,id DESC);
            INSERT INTO metadata(key,value) VALUES ('schema_version','62') ON CONFLICT(key) DO UPDATE SET value=excluded.value;
            COMMIT;").map_err(|e|format!("无法迁移定义草稿：{e}"))?;
    }
    if schema_version < 63 {
        connection.execute_batch("BEGIN IMMEDIATE;
            CREATE TABLE IF NOT EXISTS tag_source_writebacks (
              id TEXT PRIMARY KEY, plan_json TEXT NOT NULL, status TEXT NOT NULL,
              result_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
            );
            INSERT INTO metadata(key,value) VALUES ('schema_version','63') ON CONFLICT(key) DO UPDATE SET value=excluded.value;
            COMMIT;").map_err(|e| format!("无法创建标签写回记录：{e}"))?;
    }
    if schema_version < 64 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始闪卡复习撤销迁移：{error}"))?;
        for (column, definition) in [
            ("previous_ease", "REAL"),
            ("previous_repetitions", "INTEGER"),
            ("previous_lapses", "INTEGER"),
        ] {
            let exists: bool = transaction
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM pragma_table_info('flashcard_reviews') WHERE name=?1)",
                    params![column],
                    |row| row.get(0),
                )
                .map_err(|error| format!("无法检查闪卡复习撤销字段：{error}"))?;
            if !exists {
                transaction
                    .execute_batch(&format!(
                        "ALTER TABLE flashcard_reviews ADD COLUMN {column} {definition};"
                    ))
                    .map_err(|error| format!("无法添加闪卡复习撤销字段：{error}"))?;
            }
        }
        transaction
            .execute(
                "INSERT INTO metadata(key,value) VALUES ('schema_version','64') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [],
            )
            .map_err(|error| format!("无法保存闪卡复习撤销版本：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交闪卡复习撤销迁移：{error}"))?;
    }
    if schema_version < 65 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始闪卡收件箱升级：{error}"))?;
        let has_fields: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('flashcard_drafts') WHERE name='custom_fields_json')",
            [], |row| row.get(0),
        ).map_err(|error| format!("无法检查闪卡收件箱字段：{error}"))?;
        if !has_fields {
            transaction.execute_batch("ALTER TABLE flashcard_drafts ADD COLUMN custom_fields_json TEXT NOT NULL DEFAULT '{}';")
                .map_err(|error| format!("无法升级闪卡收件箱：{error}"))?;
        }
        transaction.execute_batch("INSERT INTO metadata(key,value) VALUES ('schema_version','65') ON CONFLICT(key) DO UPDATE SET value=excluded.value;")
            .map_err(|error| format!("无法保存闪卡收件箱版本：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交闪卡收件箱升级：{error}"))?;
    }
    if schema_version < 66 {
        flashcard_quality::migrate(&mut connection)?;
    }
    if schema_version < 67 {
        flashcard_scheduler::migrate(&mut connection)?;
    }
    if schema_version < 68 {
        flashcard_review_log::migrate(&mut connection)?;
    }
    if !metadata_bool(&connection, "ocr_content_type_v1", false) {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开始 OCR 内容类型迁移：{error}"))?;
        transaction
            .execute_batch(
                "UPDATE content_items AS ci
                 SET content_type='pdf_ocr'
                 WHERE ci.content_type='pdf_page'
                   AND EXISTS (
                     SELECT 1 FROM ocr_pages p
                     JOIN source_items s ON s.id=p.source_item_id
                     WHERE p.source_item_id=ci.source_item_id
                       AND p.page_number=ci.page_number
                       AND s.mime_type='application/pdf');
                 INSERT INTO index_jobs
                   (job_key, space_id, source_id, source_type, job_type, status,
                    priority, created_at, updated_at)
                 SELECT 'lexical:' || ci.space_id || ':' || ci.document_id,
                        ci.space_id, ci.document_id, 'document', 'upsert_lexical',
                        'pending', 15, strftime('%s','now'), strftime('%s','now')
                 FROM content_items ci
                 WHERE ci.content_type='pdf_ocr'
                 GROUP BY ci.space_id, ci.document_id
                 ON CONFLICT(job_key) DO UPDATE SET status='pending', priority=15,
                   attempts=0, updated_at=excluded.updated_at, last_error=NULL,
                   next_attempt_at=0, worker_id=NULL, locked_at=NULL, lease_until=NULL;
                 INSERT INTO metadata (key, value) VALUES ('ocr_content_type_v1', '1')
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value;",
            )
            .map_err(|error| format!("无法迁移 OCR 内容类型：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交 OCR 内容类型迁移：{error}"))?;
    }
    connection
        .execute_batch(
            "CREATE INDEX IF NOT EXISTS index_jobs_unestimated
        ON index_jobs(job_type,space_id)
        WHERE status='pending' AND estimated_cost<=1;
        CREATE TRIGGER IF NOT EXISTS attachment_cost_source_changed
        AFTER UPDATE OF metadata_json,blob_hash,mime_type ON source_items
        WHEN OLD.metadata_json IS NOT NEW.metadata_json OR OLD.blob_hash IS NOT NEW.blob_hash
          OR OLD.mime_type IS NOT NEW.mime_type
        BEGIN
          UPDATE index_jobs SET estimated_cost=1
          WHERE source_id=NEW.id AND status='pending'
            AND job_type IN ('download_source','import_local_source','extract_pdf','ocr_page');
        END;
        CREATE TRIGGER IF NOT EXISTS attachment_cost_pages_inserted
        AFTER INSERT ON extractions WHEN NEW.page_count IS NOT NULL
        BEGIN
          UPDATE index_jobs SET estimated_cost=1
          WHERE source_id=NEW.source_item_id AND status='pending'
            AND job_type IN ('extract_pdf','ocr_page');
        END;
        CREATE TRIGGER IF NOT EXISTS attachment_cost_pages_changed
        AFTER UPDATE OF page_count ON extractions WHEN OLD.page_count IS NOT NEW.page_count
        BEGIN
          UPDATE index_jobs SET estimated_cost=1
          WHERE source_id=NEW.source_item_id AND status='pending'
            AND job_type IN ('extract_pdf','ocr_page');
        END;",
        )
        .map_err(|error| format!("无法初始化附件成本索引：{error}"))?;
    x_bookmarks::storage::schema(&connection)?;
    x_bookmarks::library::refresh_names(&connection)?;
    connection
        .execute_batch(
            "CREATE TRIGGER IF NOT EXISTS collection_destination_library_renamed
        AFTER UPDATE OF name ON libraries WHEN OLD.name IS NOT NEW.name
        BEGIN
          UPDATE collection_lifecycle SET destination_name=NEW.name WHERE destination=NEW.id;
        END;",
        )
        .map_err(|error| format!("无法初始化收藏名称同步：{error}"))?;
    crate::index_job_metadata::schema(&connection)?;
    crate::skipped_job_archive::schema(&connection)?;
    flashcard_decks::install_hierarchy(&connection)?;
    flashcard_store::install_flashcard_list_revision(&connection)?;
    journal_query::install_revision(&connection)?;
    flashcard_cloud_sync::ensure_tracking(&connection)?;
    local_database_maintenance::ensure_sequences(
        &connection,
        local_database_maintenance::SEQUENCE_TABLES,
    )?;
    crate::task_dates::install_schema(&connection)?;
    crate::user_profile::ensure_schema(&connection)?;
    if schema_version < DATABASE_SCHEMA_VERSION {
        crate::agent_work::migrate(&connection)?;
    }
    connection
        .execute_batch(
            "CREATE INDEX IF NOT EXISTS agent_works_recent ON agent_works(updated_at DESC,id)",
        )
        .map_err(|e| format!("无法初始化对话历史索引：{e}"))?;
    if schema_version < DATABASE_SCHEMA_VERSION {
        crate::attachment_evidence::migrate(&connection)?;
        crate::unified_task_read::migrate_evidence(&connection)?;
        crate::shared_memory::migrate(&connection)?;
        connection.execute("INSERT INTO metadata(key,value) VALUES('schema_version',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[DATABASE_SCHEMA_VERSION.to_string()]).map_err(|e|e.to_string())?;
    }
    crate::attachment_queue::retire_unsupported_ocr(&connection, None)?;
    Ok(connection)
}
