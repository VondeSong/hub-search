//! Owns lexical job admission, pinned rebuild snapshots and generation publication.
use super::{
    library_runtime, lock_database_writer, now_timestamp, open_database, random_url_safe,
    search_index::{IndexRecord, SearchIndex},
    INDEX_JOB_BATCH_SIZE, INDEX_JOB_LEASE_SECONDS, INDEX_JOB_MAX_ATTEMPTS, PROVIDER_CRAFT,
    SEARCH_INDEX_SCHEMA_VERSION,
};
use rusqlite::{params, Connection};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    path::{Component, Path, PathBuf},
    time::{Duration, Instant},
};

pub(crate) fn safe_generation_path(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let relative = PathBuf::from(relative_path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("索引代际路径无效".to_string());
    }
    Ok(root.join(relative))
}

pub(crate) fn create_empty_search_generation(
    connection: &mut Connection,
    root: &Path,
) -> Result<SearchIndex, String> {
    let generation_id = format!("generation-{}", random_url_safe(18));
    let relative_path = format!("generations/{generation_id}");
    let generation_path = safe_generation_path(root, &relative_path)?;
    let index = SearchIndex::open(&generation_path)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开始初始索引代际事务：{error}"))?;
    transaction
        .execute(
            "UPDATE search_index_generations
             SET status='retired' WHERE status='active'",
            [],
        )
        .map_err(|error| format!("无法退役旧索引代际：{error}"))?;
    transaction
        .execute(
            "INSERT INTO search_index_generations
             (id, schema_version, relative_path, status, document_count, created_at, activated_at)
             VALUES (?1, ?2, ?3, 'active', 0, ?4, ?4)",
            params![
                generation_id,
                SEARCH_INDEX_SCHEMA_VERSION,
                relative_path,
                now_timestamp()
            ],
        )
        .map_err(|error| format!("无法记录初始索引代际：{error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("无法提交初始索引代际：{error}"))?;
    Ok(index)
}

pub(crate) fn open_or_create_active_search_index(
    connection: &mut Connection,
    root: &Path,
) -> Result<SearchIndex, String> {
    let active = connection
        .query_row(
            "SELECT id, relative_path FROM search_index_generations
             WHERE status='active' AND schema_version=?1
             ORDER BY activated_at DESC LIMIT 1",
            params![SEARCH_INDEX_SCHEMA_VERSION],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .ok();
    if let Some((generation_id, relative_path)) = active {
        match safe_generation_path(root, &relative_path).and_then(|path| SearchIndex::open(&path)) {
            Ok(index) => return Ok(index),
            Err(error) => {
                connection
                    .execute(
                        "UPDATE search_index_generations
                         SET status='failed', last_error=?1 WHERE id=?2",
                        params![error, generation_id],
                    )
                    .map_err(|update_error| format!("无法记录损坏的索引代际：{update_error}"))?;
            }
        }
    }
    create_empty_search_generation(connection, root)
}

pub(crate) fn build_and_activate_search_generation(
    connection: &mut Connection,
    root: &Path,
    build: impl FnOnce(&SearchIndex) -> Result<usize, String>,
) -> Result<SearchIndex, String> {
    let visibility = {
        let _writer = lock_database_writer()?;
        IndexVisibility::capture(connection)?
    };
    build_and_activate_guarded(connection, root, &visibility, build)
}

struct IndexVisibility {
    libraries: Vec<(String, bool)>,
    permit: Option<library_runtime::CachedReadPermit>,
    expected_generation: Option<String>,
}

impl IndexVisibility {
    fn membership(connection: &Connection) -> Result<Vec<(String, bool)>, String> {
        let mut statement = connection
            .prepare("SELECT id, enabled FROM libraries ORDER BY id")
            .map_err(|error| format!("无法读取索引资料库范围：{error}"))?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    fn capture(connection: &Connection) -> Result<Self, String> {
        let permit = connection
            .path()
            .filter(|path| !path.is_empty())
            .and_then(|path| Path::new(path).parent())
            .map(library_runtime::cached_read_permit)
            .transpose()?;
        Ok(Self {
            libraries: Self::membership(connection)?,
            permit,
            expected_generation: None,
        })
    }

    fn validate_generation(&self, connection: &Connection) -> Result<(), String> {
        if let Some(expected) = &self.expected_generation {
            let active: String = connection
                .query_row(
                    "SELECT id FROM search_index_generations WHERE status='active'",
                    [],
                    |r| r.get(0),
                )
                .map_err(|e| format!("无法核对恢复索引代际：{e}"))?;
            if &active != expected {
                return Err("资料库操作已停止：索引恢复期间活动代际已改变".into());
            }
        }
        Ok(())
    }

    fn validate_membership(&self, connection: &Connection) -> Result<(), String> {
        if Self::membership(connection)? != self.libraries {
            return Err("资料库操作已停止：索引快照期间资料库范围已改变".into());
        }
        Ok(())
    }

    fn commit<T>(&self, write: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        match &self.permit {
            Some(permit) => permit.commit(write),
            None => write(),
        }
    }
}

fn build_and_activate_guarded(
    connection: &mut Connection,
    root: &Path,
    visibility: &IndexVisibility,
    build: impl FnOnce(&SearchIndex) -> Result<usize, String>,
) -> Result<SearchIndex, String> {
    let generation_id = format!("generation-{}", random_url_safe(18));
    let relative_path = format!("generations/{generation_id}");
    let generation_path = safe_generation_path(root, &relative_path)?;
    {
        let _writer = lock_database_writer()?;
        connection
            .execute(
                "INSERT INTO search_index_generations
             (id, schema_version, relative_path, status, document_count, created_at)
             VALUES (?1, ?2, ?3, 'building', 0, ?4)",
                params![
                    generation_id,
                    SEARCH_INDEX_SCHEMA_VERSION,
                    relative_path,
                    now_timestamp()
                ],
            )
            .map_err(|error| format!("无法记录待构建索引代际：{error}"))?;
    }
    let (index, count) = match SearchIndex::open(&generation_path)
        .and_then(|index| build(&index).map(|count| (index, count)))
    {
        Ok(index) => index,
        Err(error) => {
            let _writer = lock_database_writer()?;
            let _ = connection.execute(
                "UPDATE search_index_generations
                 SET status='failed', last_error=?1 WHERE id=?2",
                params![error, generation_id],
            );
            return Err(error);
        }
    };
    if index.num_docs() != count as u64 {
        let _writer = lock_database_writer()?;
        let error = format!(
            "新索引校验失败：预期 {} 个内容项，实际 {} 个",
            count,
            index.num_docs()
        );
        let _ = connection.execute(
            "UPDATE search_index_generations
             SET status='failed', last_error=?1 WHERE id=?2",
            params![error, generation_id],
        );
        return Err(error);
    }
    let _writer = lock_database_writer()?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开始索引代际切换事务：{error}"))?;
    if let Err(error) = visibility.validate_generation(&transaction) {
        drop(transaction);
        let _ = connection.execute(
            "UPDATE search_index_generations SET status='failed',last_error=?1 WHERE id=?2",
            params![error, generation_id],
        );
        return Err(error);
    }
    transaction
        .execute(
            "UPDATE search_index_generations
             SET status='retired' WHERE status='active'",
            [],
        )
        .map_err(|error| format!("无法退役活动索引代际：{error}"))?;
    transaction
        .execute(
            "UPDATE search_index_generations
             SET status='active', document_count=?1, activated_at=?2, last_error=NULL
             WHERE id=?3 AND status='building'",
            params![count as i64, now_timestamp(), generation_id],
        )
        .map_err(|error| format!("无法激活新索引代际：{error}"))?;
    // Validate the pinned view before retiring the previous active generation.
    // Rollback retains that generation if control or membership changed.
    let committed = match visibility.validate_membership(&transaction) {
        Ok(()) => visibility.commit(|| {
            transaction
                .commit()
                .map_err(|error| format!("无法提交索引代际切换：{error}"))
        }),
        Err(error) => {
            drop(transaction);
            Err(error)
        }
    };
    if let Err(error) = committed {
        let _ = connection.execute(
            "UPDATE search_index_generations SET status='failed',last_error=?1 WHERE id=?2",
            params![error, generation_id],
        );
        return Err(error);
    }
    Ok(index)
}

pub(crate) struct PendingIndexBatch {
    pub(crate) operations: HashMap<String, library_runtime::Operation>,
    pub(crate) job_ids: Vec<i64>,
    pub(crate) job_spaces: Vec<(i64, String)>,
    pub(crate) deleted_document_keys: Vec<String>,
    pub(crate) records: Vec<IndexRecord>,
    pub(crate) rebuild: bool,
    pub(crate) rebuild_snapshot: Option<IndexRebuildSnapshot>,
}

pub(crate) struct IndexRebuildSnapshot {
    pub(crate) connection: Connection,
    pub(crate) excluded: HashSet<String>,
    visibility: IndexVisibility,
}

impl IndexRebuildSnapshot {
    pub(crate) fn open(connection: &Connection) -> Result<Self, String> {
        let path = connection
            .path()
            .filter(|path| !path.is_empty())
            .ok_or_else(|| "索引重建需要持久数据库快照".to_string())?;
        let snapshot =
            Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|error| format!("无法打开索引重建快照：{error}"))?;
        snapshot
            .execute_batch("PRAGMA busy_timeout=5000; BEGIN;")
            .map_err(|error| format!("无法开始索引重建快照：{error}"))?;
        // Pin the WAL view while the claim still owns the database writer guard.
        // Claiming changes only job metadata; later content writes remain pending.
        snapshot
            .query_row("SELECT EXISTS(SELECT 1 FROM content_items)", [], |row| {
                row.get::<_, bool>(0)
            })
            .map_err(|error| format!("无法固定索引重建快照：{error}"))?;
        let visibility = IndexVisibility::capture(&snapshot)?;
        let excluded = excluded_index_libraries(&snapshot)?;
        Ok(Self {
            connection: snapshot,
            excluded,
            visibility,
        })
    }

    pub(crate) fn has_visible_content(&self) -> Result<bool, String> {
        let excluded = serde_json::to_string(&self.excluded).map_err(|error| error.to_string())?;
        self.connection.query_row("SELECT EXISTS(
            SELECT 1 FROM content_items ci JOIN documents d ON d.space_id=ci.space_id AND d.id=ci.document_id
            WHERE ci.space_id NOT IN (SELECT value FROM json_each(?1))) OR EXISTS(
            SELECT 1 FROM source_items s JOIN documents d ON d.space_id=s.space_id AND d.id=s.document_id
            WHERE s.source_type IN ('craft_attachment','obsidian_attachment') AND length(trim(s.title))>0
              AND s.space_id NOT IN (SELECT value FROM json_each(?1)))", [excluded], |row| row.get(0))
            .map_err(|error| format!("无法读取重建快照内容：{error}"))
    }

    pub(crate) fn rebuild(&self, index: &SearchIndex) -> Result<usize, String> {
        index.rebuild_from(|append| {
            visit_index_records(&self.connection, None, &self.excluded, &mut |record| {
                if let Some(permit) = &self.visibility.permit {
                    permit.checkpoint()?;
                }
                append(record)
            })
        })
    }

    pub(crate) fn activate(
        &self,
        connection: &mut Connection,
        root: &Path,
    ) -> Result<SearchIndex, String> {
        build_and_activate_guarded(connection, root, &self.visibility, |index| {
            self.rebuild(index)
        })
    }
}

#[cfg(test)]
#[path = "search_index_runtime_tests.rs"]
mod tests;

pub(crate) fn collect_index_records(
    connection: &Connection,
    worker_id: Option<&str>,
) -> Result<Vec<IndexRecord>, String> {
    let excluded = excluded_index_libraries(connection)?;
    let mut records = Vec::new();
    visit_index_records(connection, worker_id, &excluded, &mut |record| {
        records.push(record);
        Ok(())
    })?;
    Ok(records)
}

pub(crate) fn visit_index_records(
    connection: &Connection,
    worker_id: Option<&str>,
    excluded: &HashSet<String>,
    visit: &mut dyn FnMut(IndexRecord) -> Result<(), String>,
) -> Result<(), String> {
    let sql = if worker_id.is_some() {
        "SELECT ci.id, ci.space_id, ci.document_id, ci.block_id, ci.content_type,
                d.title, ci.heading, ci.body, d.path, COALESCE(d.folder_id, ''),
                COALESCE(d.modified_at, d.indexed_at), COALESCE(ci.source_item_id, ''),
                COALESCE(s.title, ''), COALESCE(ci.page_number, 0), d.provider,
                COALESCE((SELECT group_concat(a.alias, ' ') FROM obsidian_aliases a
                          WHERE a.space_id=d.space_id AND a.document_id=d.id), ''),
                TRIM(
                  COALESCE((SELECT group_concat(t.tag, ' ') FROM obsidian_tags t
                            WHERE t.space_id=d.space_id AND t.document_id=d.id), '') || ' ' ||
                  COALESCE((SELECT group_concat(t.tag, ' ') FROM dida_task_tags t
                            WHERE t.library_id=d.space_id AND t.task_id=d.id), '') || ' ' ||
                  COALESCE((SELECT group_concat(t.tag, ' ') FROM craft_tags t
                            WHERE t.space_id=d.space_id AND t.document_id=d.id
                              AND t.page_id=COALESCE(NULLIF(ci.page_id,''),ci.document_id)), '') || ' ' ||
                  COALESCE((SELECT group_concat(t.tag, ' ') FROM hub_content_tag_memberships t
                            WHERE t.library_id=d.space_id AND t.document_id=d.id AND t.provider=d.provider
                              AND (t.provider<>'craft' OR t.page_id=COALESCE(NULLIF(ci.page_id,''),ci.document_id))), '')
                ),
                COALESCE(ci.page_id, ''), COALESCE(ci.page_title, '')
         FROM index_jobs j
         JOIN content_items ci ON ci.space_id=j.space_id AND ci.document_id=j.source_id
         JOIN documents d ON d.space_id=ci.space_id AND d.id=ci.document_id
         LEFT JOIN source_items s ON s.id=ci.source_item_id
         WHERE j.status='running' AND j.worker_id=?1 AND j.job_type='upsert_lexical'
         ORDER BY ci.space_id, ci.document_id, ci.ordinal"
    } else {
        "SELECT ci.id, ci.space_id, ci.document_id, ci.block_id, ci.content_type,
                d.title, ci.heading, ci.body, d.path, COALESCE(d.folder_id, ''),
                COALESCE(d.modified_at, d.indexed_at), COALESCE(ci.source_item_id, ''),
                COALESCE(s.title, ''), COALESCE(ci.page_number, 0), d.provider,
                COALESCE((SELECT group_concat(a.alias, ' ') FROM obsidian_aliases a
                          WHERE a.space_id=d.space_id AND a.document_id=d.id), ''),
                TRIM(
                  COALESCE((SELECT group_concat(t.tag, ' ') FROM obsidian_tags t
                            WHERE t.space_id=d.space_id AND t.document_id=d.id), '') || ' ' ||
                  COALESCE((SELECT group_concat(t.tag, ' ') FROM dida_task_tags t
                            WHERE t.library_id=d.space_id AND t.task_id=d.id), '') || ' ' ||
                  COALESCE((SELECT group_concat(t.tag, ' ') FROM craft_tags t
                            WHERE t.space_id=d.space_id AND t.document_id=d.id
                              AND t.page_id=COALESCE(NULLIF(ci.page_id,''),ci.document_id)), '') || ' ' ||
                  COALESCE((SELECT group_concat(t.tag, ' ') FROM hub_content_tag_memberships t
                            WHERE t.library_id=d.space_id AND t.document_id=d.id AND t.provider=d.provider
                              AND (t.provider<>'craft' OR t.page_id=COALESCE(NULLIF(ci.page_id,''),ci.document_id))), '')
                ),
                COALESCE(ci.page_id, ''), COALESCE(ci.page_title, '')
         FROM content_items ci
         JOIN documents d ON d.space_id=ci.space_id AND d.id=ci.document_id
         LEFT JOIN source_items s ON s.id=ci.source_item_id
         ORDER BY ci.space_id, ci.document_id, ci.ordinal"
    };
    let mut statement = connection
        .prepare(sql)
        .map_err(|error| format!("无法准备 Tantivy 内容读取：{error}"))?;
    let map_row = |row: &rusqlite::Row<'_>| {
        let space_id: String = row.get(1)?;
        let document_id: String = row.get(2)?;
        let source_item_id: String = row.get(11)?;
        let provider: String = row.get(14)?;
        let content_type: String = row.get(4)?;
        let root_title: String = row.get(5)?;
        let root_path: String = row.get(8)?;
        let page_id: String = row.get(17)?;
        let page_title: String = row.get(18)?;
        let document_key = format!("{space_id}:{document_id}");
        let is_craft_subpage = provider == PROVIDER_CRAFT
            && content_type == "craft_subpage"
            && !page_id.trim().is_empty()
            && page_id != document_id;
        let title = if is_craft_subpage && !page_title.trim().is_empty() {
            page_title
        } else {
            root_title.clone()
        };
        let path = if is_craft_subpage {
            if root_path.trim().is_empty() {
                root_title
            } else {
                format!("{} / {}", root_path.trim(), root_title)
            }
        } else {
            root_path
        };
        Ok(IndexRecord {
            provider,
            item_id: row.get(0)?,
            entity_key: if source_item_id.is_empty() {
                if is_craft_subpage {
                    format!("page:{document_key}:{page_id}")
                } else {
                    format!("document:{document_key}")
                }
            } else {
                format!("attachment:{source_item_id}")
            },
            document_key,
            space_id,
            document_id,
            block_id: row.get(3)?,
            content_type,
            source_item_id,
            source_title: row.get(12)?,
            page_number: row.get(13)?,
            title,
            heading: row.get(6)?,
            aliases: row.get(15)?,
            tags: row.get(16)?,
            body: row.get(7)?,
            path,
            folder_id: row.get(9)?,
            modified_at: row.get(10)?,
        })
    };
    let rows = if let Some(worker_id) = worker_id {
        statement.query_map(params![worker_id], map_row)
    } else {
        statement.query_map([], map_row)
    }
    .map_err(|error| format!("Tantivy 内容查询失败：{error}"))?;
    for row in rows {
        let record = row.map_err(|error| format!("Tantivy 内容无法读取：{error}"))?;
        if !excluded.contains(&record.space_id) {
            visit(record)?;
        }
    }
    drop(statement);

    let attachment_sql = if worker_id.is_some() {
        "SELECT DISTINCT s.id, s.space_id, s.document_id, s.title,
                COALESCE(s.mime_type, ''), COALESCE(s.metadata_json, '{}'),
                d.title, d.path, COALESCE(d.folder_id, ''),
                COALESCE(s.modified_at, d.modified_at, d.indexed_at), d.provider,
                COALESCE((
                  SELECT ci.page_title FROM content_items ci
                  WHERE ci.space_id=s.space_id AND ci.document_id=s.document_id
                    AND ci.page_id=json_extract(s.metadata_json,'$.blockId')
                    AND length(trim(ci.page_title))>0
                  ORDER BY ci.ordinal LIMIT 1
                ), '')
         FROM index_jobs j
         JOIN source_items s ON s.space_id=j.space_id AND s.document_id=j.source_id
         JOIN documents d ON d.space_id=s.space_id AND d.id=s.document_id
         WHERE j.status='running' AND j.worker_id=?1 AND j.job_type='upsert_lexical'
           AND s.source_type IN ('craft_attachment','obsidian_attachment')
           AND length(trim(s.title)) > 0"
    } else {
        "SELECT s.id, s.space_id, s.document_id, s.title,
                COALESCE(s.mime_type, ''), COALESCE(s.metadata_json, '{}'),
                d.title, d.path, COALESCE(d.folder_id, ''),
                COALESCE(s.modified_at, d.modified_at, d.indexed_at), d.provider,
                COALESCE((
                  SELECT ci.page_title FROM content_items ci
                  WHERE ci.space_id=s.space_id AND ci.document_id=s.document_id
                    AND ci.page_id=json_extract(s.metadata_json,'$.blockId')
                    AND length(trim(ci.page_title))>0
                  ORDER BY ci.ordinal LIMIT 1
                ), '')
         FROM source_items s
         JOIN documents d ON d.space_id=s.space_id AND d.id=s.document_id
         WHERE s.source_type IN ('craft_attachment','obsidian_attachment')
           AND length(trim(s.title)) > 0"
    };
    let mut attachment_statement = connection
        .prepare(attachment_sql)
        .map_err(|error| format!("无法准备附件索引读取：{error}"))?;
    let map_attachment = |row: &rusqlite::Row<'_>| {
        let item_id: String = row.get(0)?;
        let space_id: String = row.get(1)?;
        let document_id: String = row.get(2)?;
        let source_title: String = row.get(3)?;
        let mime_type: String = row.get(4)?;
        let metadata_json: String = row.get(5)?;
        let metadata = serde_json::from_str::<Value>(&metadata_json).unwrap_or(Value::Null);
        let link_kind = metadata
            .get("linkKind")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let block_id = metadata
            .get("blockId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or(&document_id)
            .to_string();
        let content_type = if mime_type == "application/pdf"
            || source_title.to_ascii_lowercase().ends_with(".pdf")
        {
            "pdf_attachment"
        } else if mime_type.starts_with("image/")
            || mime_type.starts_with("video/")
            || matches!(link_kind, "image" | "video")
        {
            "media_attachment"
        } else {
            "file_attachment"
        };
        let provider: String = row.get(10)?;
        let root_title: String = row.get(6)?;
        let root_path: String = row.get(7)?;
        let page_title: String = row.get(11)?;
        let is_craft_subpage =
            provider == PROVIDER_CRAFT && !page_title.trim().is_empty() && page_title != root_title;
        let title = if is_craft_subpage {
            page_title
        } else {
            root_title.clone()
        };
        let path = if is_craft_subpage {
            if root_path.trim().is_empty() {
                root_title
            } else {
                format!("{} / {}", root_path.trim(), root_title)
            }
        } else {
            root_path
        };
        Ok(IndexRecord {
            provider,
            item_id: format!("attachment-meta:{item_id}"),
            entity_key: format!("attachment:{item_id}"),
            document_key: format!("{space_id}:{document_id}"),
            space_id,
            document_id,
            block_id,
            content_type: content_type.to_string(),
            source_item_id: item_id,
            source_title: source_title.clone(),
            page_number: 0,
            title,
            heading: String::new(),
            aliases: String::new(),
            tags: String::new(),
            body: source_title,
            path,
            folder_id: row.get(8)?,
            modified_at: row.get(9)?,
        })
    };
    let attachment_rows = if let Some(worker_id) = worker_id {
        attachment_statement.query_map(params![worker_id], map_attachment)
    } else {
        attachment_statement.query_map([], map_attachment)
    }
    .map_err(|error| format!("附件索引查询失败：{error}"))?;
    for row in attachment_rows {
        let record = row.map_err(|error| format!("附件索引无法读取：{error}"))?;
        if !excluded.contains(&record.space_id) {
            visit(record)?;
        }
    }
    Ok(())
}

pub(crate) fn excluded_index_libraries(connection: &Connection) -> Result<HashSet<String>, String> {
    // Disconnected libraries retain their cache but cannot re-enter a rebuilt index.
    let mut disabled_query = connection
        .prepare("SELECT id FROM libraries WHERE enabled=0")
        .map_err(|error| format!("无法读取移除的资料库：{error}"))?;
    let mut disabled = disabled_query
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(|error| error.to_string())?;
    if let Some(root) = connection.path().and_then(|path| Path::new(path).parent()) {
        let removed = library_runtime::statuses(root)?
            .into_iter()
            .filter(|status| matches!(status.state.as_str(), "removing" | "removed"))
            .map(|status| status.library_id)
            .collect::<HashSet<_>>();
        disabled.extend(removed);
    }
    Ok(disabled)
}

pub(crate) fn claim_index_batch(
    connection: &mut Connection,
    index_empty: bool,
    worker_id: &str,
) -> Result<PendingIndexBatch, String> {
    let control_root = connection
        .path()
        .and_then(|path| Path::new(path).parent())
        .map(Path::to_path_buf);
    let stopped = if let Some(root) = &control_root {
        library_runtime::statuses(root)?
            .into_iter()
            .filter(|status| {
                matches!(
                    status.state.as_str(),
                    "paused" | "pausing" | "cancelled" | "removing" | "removed"
                )
            })
            .map(|status| status.library_id)
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let stopped = serde_json::to_string(&stopped).map_err(|error| error.to_string())?;
    let now = now_timestamp();
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开始索引任务领取事务：{error}"))?;
    transaction
        .execute(
            "UPDATE index_jobs
             SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END, worker_id=NULL, locked_at=NULL, lease_until=NULL,
                 last_error=CASE WHEN attempts>=3 THEN COALESCE(NULLIF(last_error,''),'已达到自动尝试上限，请手动重试') ELSE last_error END
             WHERE status='running' AND COALESCE(lease_until, 0) < ?1",
            params![now],
        )
        .map_err(|error| format!("无法回收超时索引任务：{error}"))?;
    let has_content: bool = transaction
        .query_row("SELECT EXISTS(SELECT 1 FROM content_items)", [], |row| {
            row.get(0)
        })
        .map_err(|error| format!("无法读取重建状态：{error}"))?;
    let mut rebuild = index_empty && has_content;
    if rebuild {
        transaction
            .execute(
                "UPDATE index_jobs
                 SET status='pending', attempts=0, next_attempt_at=0, last_error=NULL,
                     worker_id=NULL, locked_at=NULL, lease_until=NULL
                 WHERE status='failed' AND job_type IN ('upsert_lexical','delete_lexical')",
                [],
            )
            .map_err(|error| format!("无法将失败任务纳入索引重建：{error}"))?;
    }
    let limit = INDEX_JOB_BATCH_SIZE as i64;
    let mut statement = transaction
        .prepare(
            "SELECT id, space_id, source_id, job_type
             FROM index_jobs
             WHERE status='pending' AND next_attempt_at <= ?1
               AND job_type IN ('upsert_lexical','delete_lexical')
               AND NOT EXISTS(SELECT 1 FROM json_each(?3) stopped WHERE stopped.value=index_jobs.space_id)
               AND NOT EXISTS(SELECT 1 FROM libraries l WHERE l.id=index_jobs.space_id AND l.enabled=0)
             ORDER BY priority DESC, created_at
             LIMIT ?2",
        )
        .map_err(|error| format!("无法读取索引任务：{error}"))?;
    let mut rows = statement
        .query_map(params![now, limit, stopped], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|error| format!("索引任务查询失败：{error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("索引任务无法读取：{error}"))?;
    drop(statement);
    if let Some(root) = &control_root {
        rows.retain(|(_, space_id, _, _)| library_runtime::gate(root, space_id).is_ok());
    }
    let mut claim_operations = Vec::new();
    let mut claim_spaces = Vec::new();
    if let Some(root) = &control_root {
        let mut seen = HashSet::new();
        for (_, space_id, _, _) in &rows {
            if seen.insert(space_id.clone()) {
                claim_operations.push(library_runtime::begin(root, space_id, "领取搜索索引工作")?);
                claim_spaces.push(space_id.clone());
            }
        }
    }
    {
        let mut claim = transaction
            .prepare(
                "UPDATE index_jobs
                 SET status='running', attempts=attempts+1, locked_at=?1,
                     lease_until=?2, worker_id=?3, updated_at=?1
                 WHERE id=?4 AND status='pending'",
            )
            .map_err(|error| format!("无法准备索引任务领取：{error}"))?;
        for (job_id, _, _, _) in &rows {
            claim
                .execute(params![
                    now,
                    now + INDEX_JOB_LEASE_SECONDS,
                    worker_id,
                    job_id
                ])
                .map_err(|error| format!("无法领取索引任务：{error}"))?;
        }
    }
    let deleted_document_keys = rows
        .iter()
        .filter(|(_, _, _, job_type)| job_type == "delete_lexical")
        .map(|(_, space_id, source_id, _)| format!("{space_id}:{source_id}"))
        .collect();
    let mut rebuild_snapshot = if rebuild {
        Some(IndexRebuildSnapshot::open(&transaction)?)
    } else {
        None
    };
    // Removed caches can leave content_items populated while the visible index is empty.
    // An empty filtered rebuild must not start endless new generations.
    if let Some(snapshot) = &rebuild_snapshot {
        if !snapshot.has_visible_content()? {
            rebuild = false;
            rebuild_snapshot = None;
        }
    }
    let records = if rebuild || rows.is_empty() {
        Vec::new()
    } else {
        collect_index_records(&transaction, Some(worker_id))?
    };
    library_runtime::commit_operations(&claim_operations, || {
        transaction
            .commit()
            .map_err(|error| format!("无法提交索引任务领取：{error}"))
    })?;
    let batch = PendingIndexBatch {
        operations: claim_spaces.into_iter().zip(claim_operations).collect(),
        job_spaces: rows
            .iter()
            .map(|(id, space, _, _)| (*id, space.clone()))
            .collect(),
        job_ids: rows.into_iter().map(|(id, _, _, _)| id).collect(),
        deleted_document_keys,
        records,
        rebuild,
        rebuild_snapshot,
    };
    Ok(batch)
}

pub(crate) fn flush_index_jobs_budgeted(
    path: &PathBuf,
    index: SearchIndex,
    root: &PathBuf,
    batch_limit: usize,
    budget: Duration,
) -> Result<Option<SearchIndex>, String> {
    let mut connection = open_database(&path)?;
    let mut active_index = index;
    let mut replacement = None;
    let started = Instant::now();
    for _ in 0..batch_limit {
        let worker_id = random_url_safe(18);
        let batch = {
            let _writer = lock_database_writer()?;
            claim_index_batch(&mut connection, active_index.num_docs() == 0, &worker_id)?
        };
        if batch.job_ids.is_empty()
            && batch.deleted_document_keys.is_empty()
            && batch.records.is_empty()
            && !batch.rebuild
        {
            return Ok(replacement);
        }
        // Preserve the originally claimed epoch across pause/resume and execution.
        let operations = batch.operations;
        let records: Vec<_> = batch
            .records
            .into_iter()
            .filter(|record| {
                batch.rebuild
                    || operations
                        .get(&record.space_id)
                        .is_some_and(|operation| operation.checkpoint().is_ok())
            })
            .collect();
        let mut recovered = false;
        let mut result = if batch.rebuild {
            let snapshot = batch
                .rebuild_snapshot
                .as_ref()
                .ok_or_else(|| "索引重建快照缺失".to_string())?;
            snapshot.activate(&mut connection, &root).map(|new_index| {
                active_index = new_index.clone();
                replacement = Some(new_index);
            })
        } else {
            let deleted: Vec<_> = batch
                .deleted_document_keys
                .iter()
                .filter(|key| {
                    operations.iter().any(|(space, operation)| {
                        key.starts_with(&format!("{space}:")) && operation.checkpoint().is_ok()
                    })
                })
                .cloned()
                .collect();
            active_index.apply_changes(&deleted, &records)
        };
        if !batch.rebuild {
            if let Err(error) = &result {
                if error.starts_with("无法提交 Tantivy 索引：") {
                    result = recover_commit_failure(&mut connection, &root, &active_index, error)
                        .map(|new_index| {
                            active_index = new_index.clone();
                            replacement = Some(new_index);
                            recovered = true;
                        });
                }
            }
        }
        let _writer = lock_database_writer()?;
        match result {
            Ok(()) => {
                connection
                    .execute(
                        "UPDATE search_index_generations
                         SET document_count=?1 WHERE status='active'",
                        params![active_index.num_docs() as i64],
                    )
                    .map_err(|error| format!("无法更新活动索引代际统计：{error}"))?;
                if !batch.job_ids.is_empty() {
                    for (space, operation) in &operations {
                        let jobs: Vec<_> = batch
                            .job_spaces
                            .iter()
                            .filter(|(_, id)| id == space)
                            .map(|(id, _)| *id)
                            .collect();
                        match operation
                            .commit(|| complete_index_jobs(&connection, &jobs, &worker_id))
                        {
                            Ok(()) => {}
                            Err(error) if library_runtime::is_control_error(&error) => {
                                release_index_claim(&connection, &jobs, &worker_id)?;
                            }
                            Err(error) => return Err(error),
                        }
                    }
                    for (id, space) in &batch.job_spaces {
                        if !operations.contains_key(space) {
                            release_index_claim(&connection, &[*id], &worker_id)?;
                        }
                    }
                }
            }
            Err(error) => {
                if library_runtime::is_control_error(&error) {
                    release_index_claim(&connection, &batch.job_ids, &worker_id)?;
                } else {
                    fail_index_jobs(&connection, &batch.job_ids, &worker_id, &error)?;
                }
                return Err(error);
            }
        }
        // Publish the replacement to the caller before accepting another batch.
        if recovered || started.elapsed() >= budget {
            break;
        }
    }
    // Pending rows retain their identity and will be claimed by the next tick.
    Ok(replacement)
}

/// A failed commit may leave uncommitted segment files that collide on reopen.
/// Preserve them; rebuild through the existing snapshot/publication owner once.
fn recover_commit_failure(
    connection: &mut Connection,
    root: &Path,
    index: &SearchIndex,
    error: &str,
) -> Result<SearchIndex, String> {
    let snapshot = {
        let _writer = lock_database_writer()?;
        let (id, relative, previous): (String, String, Option<String>) = connection.query_row(
            "SELECT id,relative_path,last_error FROM search_index_generations WHERE status='active'",
            [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)),
        ).map_err(|e| format!("{error}; 无法定位恢复代际：{e}"))?;
        if safe_generation_path(root, &relative)? != index.directory() {
            return Err(format!("{error}; 活动索引已改变，停止恢复"));
        }
        if previous
            .as_deref()
            .is_some_and(|s| s.starts_with("commit-recovery-attempted:"))
        {
            return Err(format!("{error}; 此代际已尝试恢复，停止自动重建"));
        }
        connection
            .execute(
                "UPDATE search_index_generations SET last_error=?1 WHERE id=?2",
                params![format!("commit-recovery-attempted: {error}"), id],
            )
            .map_err(|e| format!("{error}; 无法登记恢复：{e}"))?;
        let mut snapshot = IndexRebuildSnapshot::open(connection)?;
        snapshot.visibility.expected_generation = Some(id);
        snapshot
    };
    snapshot
        .activate(connection, &root.to_path_buf())
        .map_err(|e| recovery_failure(error, e))
}

fn recovery_failure(original: &str, recovery: String) -> String {
    // Cancellation must retain its prefix so the caller releases the claim
    // without charging a failed attempt. The original is already persisted.
    if library_runtime::is_control_error(&recovery) {
        recovery
    } else {
        format!("{original}; 一次索引恢复失败：{recovery}")
    }
}

/// User pause/remove cancels this claim; it does not consume a failure retry or
/// overwrite a newer producer's pending job with the same business identity.
fn release_index_claim(connection: &Connection, ids: &[i64], worker: &str) -> Result<(), String> {
    let mut update = connection.prepare("UPDATE index_jobs SET status='pending',worker_id=NULL,locked_at=NULL,lease_until=NULL,attempts=MAX(0,attempts-1),next_attempt_at=0 WHERE id=?1 AND status='running' AND worker_id=?2")
        .map_err(|error| error.to_string())?;
    for id in ids {
        update
            .execute(params![id, worker])
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(crate) fn complete_index_jobs(
    connection: &Connection,
    job_ids: &[i64],
    worker_id: &str,
) -> Result<(), String> {
    let mut statement = connection
        .prepare(
            "UPDATE index_jobs
             SET status='completed', updated_at=?1, last_error=NULL,
                 worker_id=NULL, locked_at=NULL, lease_until=NULL, next_attempt_at=0
             WHERE id=?2 AND status='running' AND worker_id=?3",
        )
        .map_err(|error| format!("无法准备索引任务状态更新：{error}"))?;
    let timestamp = now_timestamp();
    for job_id in job_ids {
        statement
            .execute(params![timestamp, job_id, worker_id])
            .map_err(|error| format!("无法更新索引任务状态：{error}"))?;
    }
    Ok(())
}

pub(crate) fn failure_retry_plan(attempts: i64, now: i64) -> (bool, i64) {
    let exhausted = attempts >= INDEX_JOB_MAX_ATTEMPTS;
    let delay = (5_i64.saturating_mul(1_i64 << attempts.clamp(0, 6))).min(300);
    (
        exhausted,
        if exhausted {
            0
        } else {
            now.saturating_add(delay)
        },
    )
}

pub(crate) fn fail_index_jobs(
    connection: &Connection,
    job_ids: &[i64],
    worker_id: &str,
    last_error: &str,
) -> Result<(), String> {
    let now = now_timestamp();
    for job_id in job_ids {
        let attempts: i64 = connection
            .query_row(
                "SELECT attempts FROM index_jobs WHERE id=?1 AND worker_id=?2",
                params![job_id, worker_id],
                |row| row.get(0),
            )
            .unwrap_or(INDEX_JOB_MAX_ATTEMPTS);
        let (exhausted, next_attempt_at) = failure_retry_plan(attempts, now);
        connection
            .execute(
                "UPDATE index_jobs
                 SET status=?1, updated_at=?2, last_error=?3, next_attempt_at=?4,
                     worker_id=NULL, locked_at=NULL, lease_until=NULL
                 WHERE id=?5 AND status='running' AND worker_id=?6",
                params![
                    if exhausted { "failed" } else { "pending" },
                    now,
                    last_error,
                    next_attempt_at,
                    job_id,
                    worker_id
                ],
            )
            .map_err(|error| format!("无法记录索引任务失败：{error}"))?;
    }
    Ok(())
}
