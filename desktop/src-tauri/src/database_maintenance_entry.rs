//! GUI scheduling and explicit offline CLI use the same maintenance authority.
use crate::{database_path, local_database_maintenance as maintenance};
use serde_json::{json, Value};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc},
};
use tauri::AppHandle;

fn root(app: &AppHandle) -> Result<PathBuf, String> {
    database_path(app)?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "数据目录不可用".into())
}

#[tauri::command]
pub(crate) fn get_local_database_maintenance(app: AppHandle) -> Result<Value, String> {
    let root = root(&app)?;
    Ok(json!({"preview":maintenance::preview(&root)?, "status":maintenance::status(&root)?}))
}
#[tauri::command]
pub(crate) fn schedule_local_database_maintenance(app: AppHandle) -> Result<Value, String> {
    Ok(json!(maintenance::request(&root(&app)?)?))
}
#[tauri::command]
pub(crate) fn cancel_local_database_maintenance(app: AppHandle) -> Result<Value, String> {
    Ok(json!(maintenance::cancel_request(&root(&app)?)?))
}

fn parse(arguments: &[OsString]) -> Result<(String, PathBuf), String> {
    if arguments.len() != 4
        || arguments[0] != "--database-maintenance"
        || arguments[2] != "--data-dir"
    {
        return Err("用法：--database-maintenance preview|status|request|run|cancel|media-paths-preview|repair-media-paths|adopt-owned-data|x-media-preview|repair-x-media|cleanup-x-media --data-dir <绝对数据目录>；维护模式不能组合其它启动参数".into());
    }
    let action = arguments[1].to_str().ok_or("维护操作无效")?;
    if ![
        "preview",
        "status",
        "request",
        "run",
        "cancel",
        "media-paths-preview",
        "repair-media-paths",
        "adopt-owned-data",
        "x-media-preview",
        "repair-x-media",
        "cleanup-x-media",
    ]
    .contains(&action)
    {
        return Err("未知维护操作".into());
    }
    let root = PathBuf::from(&arguments[3]);
    if !root.is_absolute()
        || root.file_name().is_none()
        || root
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("维护数据目录必须是明确的绝对子目录".into());
    }
    Ok((action.into(), root))
}

pub fn run_cli(arguments: &[OsString]) -> Result<(), String> {
    let (action, root) = parse(arguments)?;
    let result = match action.as_str() {
        "preview" => json!(maintenance::preview(&root)?),
        "status" => json!(maintenance::status(&root)?),
        "request" => json!(maintenance::request(&root)?),
        "cancel" => json!(maintenance::cancel_request(&root)?),
        "media-paths-preview" => crate::data_backup::preview_legacy_media_paths(&root)?,
        "repair-media-paths" => crate::data_backup::repair_legacy_media_paths(&root)?,
        "adopt-owned-data" => crate::data_backup::migrate_owned_data_offline(&root)?,
        "x-media-preview" => crate::data_backup::x_media::preview(&root)?,
        "repair-x-media" => crate::data_backup::x_media::repair(&root)?,
        "cleanup-x-media" => crate::data_backup::x_media::cleanup(&root)?,
        "run" => json!(maintenance::process_pending(
            &root,
            Arc::new(AtomicBool::new(false))
        )?),
        _ => unreachable!(),
    };
    println!(
        "{}",
        serde_json::to_string(&result).map_err(|e| e.to_string())?
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_maintenance_mode_rejects_ambiguous_or_combined_startup() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let args = vec![
            OsString::from("--database-maintenance"),
            OsString::from("run"),
            OsString::from("--data-dir"),
            root.into_os_string(),
        ];
        assert_eq!(parse(&args).unwrap().0, "run");
        for action in [
            "preview",
            "status",
            "request",
            "cancel",
            "adopt-owned-data",
            "x-media-preview",
            "repair-x-media",
            "cleanup-x-media",
        ] {
            let mut other = args.clone();
            other[1] = action.into();
            assert!(parse(&other).is_ok());
        }
        let mut other = args.clone();
        other.push("--mcp".into());
        assert!(parse(&other).is_err());
        let mut other = args.clone();
        other[1] = "unknown".into();
        assert!(parse(&other).is_err());
        let mut other = args.clone();
        other[3] = "relative".into();
        assert!(parse(&other).is_err());
        assert!(parse(&[]).is_err());
    }
}
