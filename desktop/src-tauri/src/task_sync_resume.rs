//! Reversing a user's local export exclusion is explicit and scoped to one
//! still-existing Craft source. Remote creation stays in the normal sync path.
use super::*;

pub(crate) fn resume_database(
    path: &PathBuf,
    library_id: &str,
    source_id: &str,
) -> Result<String, String> {
    let normalized = normalized_task_sync_source_id(source_id);
    if normalized.is_empty() || library_id.trim().is_empty() {
        return Err("请选择要恢复同步的 Craft 任务或项目".into());
    }
    let mut records = load_task_sync_records(path)?;
    let mut remaining_exclusions = load_task_sync_exclusions(path)?;
    remaining_exclusions.remove(&(PROVIDER_CRAFT.into(), library_id.into(), normalized.clone()));
    flatten_children_of_excluded_craft_projects(&mut records, &remaining_exclusions);
    let record = records
        .iter()
        .find(|record| {
            record.provider == PROVIDER_CRAFT
                && record.library_id == library_id
                && normalized_task_sync_source_id(&record.source_id) == normalized
        })
        .ok_or("此 Craft 任务或项目已不存在，不能恢复同步")?;
    if task_sync_source_or_ancestor_is_excluded(&records, &remaining_exclusions, record) {
        return Err("上级 Craft 任务已停止同步，请先在上级任务预览中恢复".into());
    }
    let (mut connection, _writer) = open_write_database(path)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开始恢复任务同步：{error}"))?;
    let enabled = transaction
        .query_row(
            "SELECT enabled FROM libraries WHERE id=?1 AND provider='craft'",
            [library_id],
            |row| row.get::<_, bool>(0),
        )
        .optional()
        .map_err(|error| format!("无法核对 Craft 资料库：{error}"))?
        .unwrap_or(false);
    if !enabled {
        return Err("此 Craft 资料库已停用，不能恢复任务同步".into());
    }
    let removed = transaction
        .execute(
            "DELETE FROM task_sync_exclusions
             WHERE provider='craft' AND library_id=?1 AND lower(trim(source_id))=?2",
            params![library_id, normalized],
        )
        .map_err(|error| format!("无法解除该任务的停止同步规则：{error}"))?;
    if removed > 0 {
        let hub_task_id = unified_task_id(PROVIDER_CRAFT, library_id, &record.source_id);
        let now = now_timestamp();
        transaction
            .execute(
                "INSERT INTO task_sync_events
                   (hub_task_id,origin_provider,target_provider,action,status,payload_json,
                    idempotency_key,attempts,created_at,updated_at,last_error)
                 VALUES (?1,'craft','dida365','resume_export','resolved',?2,?3,0,?4,?4,NULL)",
                params![
                    hub_task_id,
                    json!({"title":record.title,"libraryId":library_id,"sourceId":record.source_id}).to_string(),
                    format!("resume-export:{hub_task_id}:{}", random_url_safe(12)),
                    now
                ],
            )
            .map_err(|error| format!("无法记录恢复任务同步：{error}"))?;
    }
    library_runtime::commit_existing(
        path.parent().ok_or("资料库路径不可用")?,
        library_id,
        || {
            transaction
                .commit()
                .map_err(|error| format!("无法保存恢复任务同步：{error}"))
        },
    )?;
    Ok(if removed == 0 {
        "此 Craft 来源已经允许同步到滴答".into()
    } else if record.is_project_page {
        "已恢复项目同步；缺少的项目父任务会创建到收件箱，现有子任务的关联和所在清单会保留".into()
    } else {
        "已恢复任务同步；现有关联会保留，尚未关联的任务会创建到收件箱".into()
    })
}

#[tauri::command]
pub(crate) async fn resume_craft_task_sync(
    app: AppHandle,
    state: State<'_, AppState>,
    library_id: String,
    source_id: String,
) -> Result<String, String> {
    let guard_state = state.clone();
    let _sync_guard = guard_state
        .task_sync_guard
        .try_lock()
        .map_err(|_| "任务正在同步，请在本轮完成后恢复".to_string())?;
    let path = database_path(&app)?;
    tokio::task::spawn_blocking(move || resume_database(&path, &library_id, &source_id))
        .await
        .map_err(|error| format!("恢复任务同步异常：{error}"))?
}

#[cfg(test)]
mod tests;
