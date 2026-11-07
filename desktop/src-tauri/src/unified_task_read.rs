//! Shared source projection. History capture and pending write overlays stay in the UI caller.
use super::*;

pub(crate) fn migrate_evidence(c: &Connection) -> Result<(), String> {
    for table in ["dida_tasks", "craft_task_blocks"] {
        let present:bool=c.query_row(&format!("SELECT EXISTS(SELECT 1 FROM pragma_table_info('{table}') WHERE name='evidence_revision')"),[],|r|r.get(0)).map_err(|e|e.to_string())?;
        if !present {
            c.execute_batch(&format!(
                "ALTER TABLE {table} ADD COLUMN evidence_revision INTEGER NOT NULL DEFAULT 0;"
            ))
            .map_err(|e| e.to_string())?;
        }
    }
    c.execute_batch("CREATE TRIGGER IF NOT EXISTS dida_task_evidence_changed AFTER UPDATE OF content,description,raw_json ON dida_tasks
        WHEN OLD.content IS NOT NEW.content OR OLD.description IS NOT NEW.description
          OR json_extract(CASE WHEN json_valid(OLD.raw_json) THEN OLD.raw_json ELSE '{}' END,'$.isAllDay','$.timeZone','$.time_zone','$.createdTime','$.created_time','$.createdAt','$.created_at','$.completedTime','$.completed_time') IS NOT json_extract(CASE WHEN json_valid(NEW.raw_json) THEN NEW.raw_json ELSE '{}' END,'$.isAllDay','$.timeZone','$.time_zone','$.createdTime','$.created_time','$.createdAt','$.created_at','$.completedTime','$.completed_time')
        BEGIN UPDATE dida_tasks SET evidence_revision=evidence_revision+1 WHERE library_id=NEW.library_id AND task_id=NEW.task_id; END;
        CREATE TRIGGER IF NOT EXISTS craft_task_evidence_changed AFTER UPDATE OF content ON craft_task_blocks WHEN OLD.content IS NOT NEW.content
        BEGIN UPDATE craft_task_blocks SET evidence_revision=evidence_revision+1 WHERE space_id=NEW.space_id AND block_id=NEW.block_id; END;").map_err(|e|e.to_string())?;
    Ok(())
}

pub(crate) fn load(
    connection: &Connection,
    allowed_libraries: Option<&[String]>,
) -> Result<Vec<UnifiedTaskItem>, String> {
    load_impl(connection, allowed_libraries, None)
}
pub(crate) fn load_selected(
    connection: &Connection,
    sources: &[(String, String)],
) -> Result<Vec<UnifiedTaskItem>, String> {
    if sources.is_empty() || sources.len() > 64 {
        return Err("精确任务读取需要 1–64 个来源".into());
    }
    let libraries: Vec<_> = sources
        .iter()
        .map(|s| s.0.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    load_impl(connection, Some(&libraries), Some(sources))
}
fn load_impl(
    connection: &Connection,
    allowed_libraries: Option<&[String]>,
    sources: Option<&[(String, String)]>,
) -> Result<Vec<UnifiedTaskItem>, String> {
    let scope_json = allowed_libraries
        .map(serde_json::to_string)
        .transpose()
        .map_err(|e| e.to_string())?;
    let mut tasks = Vec::new();
    let source_json = sources
        .map(serde_json::to_string)
        .transpose()
        .map_err(|e| e.to_string())?;
    {
        let mut statement = connection
            .prepare(
                "SELECT b.space_id,l.name,b.document_id,
                        COALESCE((
                          SELECT NULLIF(ci.page_title,'') FROM content_items ci
                          WHERE ci.provider='craft' AND ci.space_id=b.space_id
                            AND ci.document_id=b.document_id AND ci.page_id=b.parent_page_id
                          ORDER BY ci.ordinal LIMIT 1
                        ),d.title),
                        d.path,b.block_id,b.parent_task_id,
                        b.title,b.completed,b.depth,b.modified_at,b.parent_page_id,
                        NULLIF(b.schedule_date,''),NULLIF(b.deadline_date,''),b.created_at
                 FROM craft_task_blocks b
                 JOIN libraries l ON l.id=b.space_id
                 JOIN documents d ON d.space_id=b.space_id AND d.id=b.document_id
                 WHERE l.enabled=1 AND (?1 IS NULL OR l.id IN (SELECT value FROM json_each(?1)))
                   AND (?2 IS NULL OR EXISTS(SELECT 1 FROM json_each(?2) s WHERE json_extract(s.value,'$[0]')=b.space_id AND (json_extract(s.value,'$[1]')=b.block_id OR json_extract(s.value,'$[1]')='craft-project-page:'||COALESCE(NULLIF(b.parent_page_id,''),b.document_id))))
                 ORDER BY COALESCE(b.modified_at,0) DESC,b.title",
            )
            .map_err(|error| format!("无法准备 Craft 原生任务查询：{error}"))?;
        let rows = statement
            .query_map(
                params![scope_json.as_deref(), source_json.as_deref()],
                |row| {
                    let library_id = row.get::<_, String>(0)?;
                    let source_id = row.get::<_, String>(5)?;
                    let completed = row.get::<_, i64>(8)? != 0;
                    let created_at = row
                        .get::<_, Option<String>>(14)?
                        .and_then(|date| task_dates::valid_date(&date));
                    let created_time_source = created_at.as_ref().map(|_| "source".to_string());
                    Ok(UnifiedTaskItem {
                        id: unified_task_id(PROVIDER_CRAFT, &library_id, &source_id),
                        collection_id: String::new(),
                        provider: PROVIDER_CRAFT.to_string(),
                        library_id,
                        library_name: row.get(1)?,
                        source_id,
                        parent_task_id: row.get(6)?,
                        parent_page_id: row.get(11)?,
                        document_id: row.get(2)?,
                        document_title: row.get(3)?,
                        title: clean_task_display_title(&row.get::<_, String>(7)?),
                        completed,
                        status: if completed { "completed" } else { "open" }.to_string(),
                        is_all_day: true,
                        start_at: row.get(12)?,
                        due_at: row.get::<_, Option<String>>(13)?,
                        scheduled_at: row.get(12)?,
                        created_at,
                        created_time_source,
                        modified_at: row.get(10)?,
                        path: row.get(4)?,
                        depth: row.get::<_, i64>(9)?.max(0) as usize,
                        is_project: false,
                        linked_providers: vec![PROVIDER_CRAFT.to_string()],
                        sync_state: "unlinked".to_string(),
                        ..UnifiedTaskItem::default()
                    })
                },
            )
            .map_err(|error| format!("Craft 原生任务查询失败：{error}"))?;
        tasks.extend(
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("无法读取 Craft 原生任务：{error}"))?,
        );
    }
    {
        let mut statement = connection
            .prepare(
                "SELECT d.provider,d.space_id,l.name,d.id,d.title,d.path,d.markdown,
                        COALESCE(d.modified_at,d.indexed_at)
                 FROM documents d JOIN libraries l ON l.id=d.space_id
                 WHERE l.enabled=1 AND (?1 IS NULL OR l.id IN (SELECT value FROM json_each(?1)))
                   AND (?2 IS NULL OR EXISTS(SELECT 1 FROM json_each(?2) s WHERE json_extract(s.value,'$[0]')=d.space_id AND instr(json_extract(s.value,'$[1]'),d.id||':line:')=1))
                   AND (d.provider='obsidian'
                        OR (d.provider='craft' AND NOT EXISTS (
                          SELECT 1 FROM craft_task_blocks b
                          WHERE b.space_id=d.space_id AND b.document_id=d.id)))
                   AND (instr(d.markdown,'[ ]')>0 OR instr(d.markdown,'[x]')>0
                        OR instr(d.markdown,'[X]')>0)",
            )
            .map_err(|error| format!("无法准备 Craft/Obsidian 任务查询：{error}"))?;
        let rows = statement
            .query_map(
                params![scope_json.as_deref(), source_json.as_deref()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, Option<i64>>(7)?,
                    ))
                },
            )
            .map_err(|error| format!("Craft/Obsidian 任务查询失败：{error}"))?;
        for row in rows {
            let (
                provider,
                library_id,
                library_name,
                document_id,
                document_title,
                path,
                markdown,
                modified_at,
            ) = row.map_err(|error| format!("无法读取 Craft/Obsidian 任务：{error}"))?;
            tasks.extend(markdown_tasks(
                &provider,
                &library_id,
                &library_name,
                &document_id,
                &document_title,
                &path,
                &markdown,
                modified_at,
            ));
        }
    }
    {
        let selected_documents = if let Some(sources) = sources {
            let mut docs: Vec<_> = tasks
                .iter()
                .map(|t| (t.library_id.clone(), t.document_id.clone()))
                .collect();
            for (library, source) in sources {
                if let Some(page) = source.strip_prefix(CRAFT_PROJECT_SOURCE_PREFIX) {
                    let doc:Option<String>=connection.query_row("SELECT id FROM documents WHERE space_id=?1 AND id=?2 UNION SELECT document_id FROM content_items WHERE space_id=?1 AND page_id=?2 LIMIT 1",params![library,page],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
                    if let Some(doc) = doc {
                        docs.push((library.clone(), doc));
                    }
                }
            }
            Some(docs)
        } else {
            None
        };
        for page in load_craft_project_pages_selected(
            connection,
            allowed_libraries,
            selected_documents.as_deref(),
        )?
        .into_iter()
        .filter(|page| allowed_libraries.is_none_or(|ids| ids.contains(&page.library_id)))
        {
            let source_id = craft_project_source_id(&page.page_id);
            let child_indexes = tasks
                .iter()
                .enumerate()
                .filter(|(_, task)| {
                    task.provider == PROVIDER_CRAFT
                        && task.library_id == page.library_id
                        && task.document_id == page.document_id
                        && (task.parent_page_id == page.page_id
                            || (task.parent_page_id.is_empty() && page.page_id == page.document_id))
                        && !task.is_project
                })
                .map(|(index, _)| index)
                .collect::<Vec<_>>();
            let completed = !child_indexes.is_empty()
                && child_indexes.iter().all(|index| tasks[*index].completed);
            for index in child_indexes {
                tasks[index].depth = tasks[index].depth.saturating_add(1);
                if tasks[index].parent_task_id.is_empty() {
                    tasks[index].parent_task_id = source_id.clone();
                }
            }
            tasks.push(UnifiedTaskItem {
                id: unified_task_id(PROVIDER_CRAFT, &page.library_id, &source_id),
                collection_id: String::new(),
                provider: PROVIDER_CRAFT.to_string(),
                library_id: page.library_id,
                library_name: page.library_name,
                source_id,
                parent_task_id: String::new(),
                parent_page_id: page.page_id,
                document_id: page.document_id,
                document_title: page.document_title,
                title: page.title,
                completed,
                status: if completed { "completed" } else { "open" }.to_string(),
                is_all_day: true,
                start_at: None,
                due_at: None,
                modified_at: page.modified_at,
                path: page.path,
                depth: 0,
                is_project: true,
                linked_providers: vec![PROVIDER_CRAFT.to_string()],
                sync_state: "unlinked".to_string(),
                ..UnifiedTaskItem::default()
            });
        }
    }
    let trash_documents = load_confirmed_craft_trash_documents(&connection)?;
    exclude_confirmed_craft_trash_tasks(&mut tasks, &trash_documents);
    {
        let mut statement = connection
            .prepare(
                "SELECT t.library_id,l.name,t.task_id,t.title,t.status,t.start_at,t.due_at,
                        d.modified_at,d.path,t.raw_json,
                        COALESCE(NULLIF(p.name,''),t.project_id),t.project_id,t.completed_at
                 FROM dida_tasks t
                 JOIN libraries l ON l.id=t.library_id
                 LEFT JOIN documents d ON d.space_id=t.library_id AND d.id=t.task_id
                 LEFT JOIN dida_projects p ON p.library_id=t.library_id AND p.project_id=t.project_id
                 WHERE l.enabled=1 AND (?1 IS NULL OR l.id IN (SELECT value FROM json_each(?1)))
                   AND (?2 IS NULL OR EXISTS(SELECT 1 FROM json_each(?2) s WHERE json_extract(s.value,'$[0]')=t.library_id AND json_extract(s.value,'$[1]')=t.task_id))
                 ORDER BY COALESCE(t.due_at,''),t.title",
            )
            .map_err(|error| format!("无法准备滴答任务查询：{error}"))?;
        let rows = statement
            .query_map(
                params![scope_json.as_deref(), source_json.as_deref()],
                |row| {
                    let library_id = row.get::<_, String>(0)?;
                    let source_id = row.get::<_, String>(2)?;
                    let status = row.get::<_, i64>(4)?;
                    let raw = serde_json::from_str::<Value>(&row.get::<_, String>(9)?)
                        .unwrap_or(Value::Null);
                    let dates = task_dates::dida_dates(
                        &raw,
                        status == 2,
                        row.get::<_, Option<String>>(12)?.as_deref(),
                    );
                    let mut task = UnifiedTaskItem {
                        id: unified_task_id(PROVIDER_DIDA365, &library_id, &source_id),
                        collection_id: row.get(11)?,
                        collection_name: row.get(10)?,
                        provider: PROVIDER_DIDA365.to_string(),
                        library_id,
                        library_name: row.get(1)?,
                        source_id: source_id.clone(),
                        parent_task_id: String::new(),
                        parent_page_id: String::new(),
                        document_id: source_id,
                        document_title: row.get(10)?,
                        title: row.get(3)?,
                        completed: status == 2,
                        status: dida_display_task_status(status).to_string(),
                        is_all_day: serde_json::from_str::<Value>(&row.get::<_, String>(9)?)
                            .ok()
                            .and_then(|value| value.get("isAllDay").and_then(Value::as_bool))
                            .unwrap_or(true),
                        time_zone: value_string(&raw, &["timeZone", "time_zone"]),
                        start_at: row.get(5)?,
                        due_at: row.get(6)?,
                        modified_at: row.get(7)?,
                        path: row.get::<_, Option<String>>(8)?.unwrap_or_default(),
                        depth: 0,
                        is_project: false,
                        linked_providers: vec![PROVIDER_DIDA365.to_string()],
                        sync_state: "unlinked".to_string(),
                        ..UnifiedTaskItem::default()
                    };
                    task_dates::apply_source_dates(&mut task, dates);
                    task.status_write_blocked_reason = dida_task_status::blocked_reason(&raw);
                    Ok(task)
                },
            )
            .map_err(|error| format!("滴答任务查询失败：{error}"))?;
        tasks.extend(
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("无法读取滴答任务：{error}"))?,
        );
    }
    if let Some(sources) = sources {
        tasks.retain(|t| sources.contains(&(t.library_id.clone(), t.source_id.clone())));
    }
    Ok(tasks)
}
