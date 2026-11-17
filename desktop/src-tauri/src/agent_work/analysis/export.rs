//! Explicit user-selected local export, with no overwrite and a verified receipt.
use super::*;
pub(in crate::agent_work) fn save(root: &Path, args: &Value) -> Result<Value, String> {
    let selected = super::path(root, args)?;
    let source = PathBuf::from(selected["path"].as_str().ok_or("成果路径缺失")?);
    let expected = text(args, "expectedSha256", 64)?;
    if crate::craft_backup::hash_file(&source)? != expected {
        return Err("成果已变化，请重新选择导出版本".into());
    }
    let destination = PathBuf::from(text(args, "destination", 4096)?);
    if !destination.is_absolute()
        || destination
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("请选择完整导出路径".into());
    }
    let name = destination
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| valid_name(s))
        .ok_or("导出文件名无效")?;
    if !destination
        .extension()
        .and_then(|s| s.to_str())
        .is_some_and(|ext| {
            source
                .extension()
                .and_then(|s| s.to_str())
                .is_some_and(|old| ext.eq_ignore_ascii_case(old))
        })
    {
        return Err("导出文件须保留成果原有扩展名".into());
    }
    let parent = destination.parent().ok_or("导出目录缺失")?;
    crate::craft_backup::reject_links(parent)?;
    let target = parent
        .canonicalize()
        .map_err(|_| "导出目录不存在")?
        .join(name);
    crate::craft_backup::reject_links(&target)?;
    let id = text(args, "id", 150)?;
    let execution = text(args, "executionId", 150)?;
    let file = text(args, "file", 200)?;
    let export_id = digest(
        format!(
            "{id}:{execution}:{file}:{}:{expected}",
            target.to_string_lossy().to_lowercase()
        )
        .as_bytes(),
    );
    let prior = store::write(root, |c| {
        let current = store::load(c, &id)?;
        if current.state == "revoked" {
            return Err("对话授权已撤回，未导出".into());
        }
        let old:Option<String>=c.query_row("SELECT body_json FROM agent_records WHERE work_id=?1 AND kind='analysisExport' AND json_extract(body_json,'$.exportId')=?2 ORDER BY rowid DESC LIMIT 1",params![id,export_id],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        if old.is_none() {
            store::insert(
                c,
                &id,
                None,
                "analysisExport",
                &json!({"exportId":export_id,"state":"intent","executionId":execution,"file":file,"sha256":expected,"destination":target}),
            )?;
        }
        Ok(old.and_then(|s| serde_json::from_str::<Value>(&s).ok()))
    })?;
    let already_exists = target.exists();
    if already_exists {
        if crate::craft_backup::hash_file(&target)? != expected {
            return Err("目标已有不同内容，未覆盖；请选择其他文件名".into());
        }
    } else {
        use std::io::Write;
        let bytes = std::fs::read(&source).map_err(|_| "成果文件不可读")?;
        if digest(&bytes) != expected {
            return Err("成果内容已变化，未导出".into());
        }
        let mut output = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|_| "无法创建导出文件；未覆盖已有文件")?;
        output
            .write_all(&bytes)
            .and_then(|_| output.sync_all())
            .map_err(|_| "导出写入未确认，目标文件已保留，请检查后重新选择")?;
    }
    crate::craft_backup::reject_links(&target)?;
    if crate::craft_backup::hash_file(&target)? != expected {
        return Err("导出回读不匹配，未标记成功".into());
    }
    if let Some(old) = prior.filter(|v| v["state"] == "verified") {
        return Ok(old);
    }
    let receipt = json!({"exportId":export_id,"state":"verified","executionId":execution,"file":file,"sha256":expected,"destination":target,"bytes":std::fs::metadata(&target).map_err(|_|"导出文件不可读")?.len(),"alreadyExisted":already_exists,"verifiedAt":chrono::Utc::now().to_rfc3339(),"meaning":"Local file copy verified by read-back. Not a knowledge-library save, remote upload or source index receipt."});
    store::write(root, |c| {
        store::insert(c, &id, None, "analysisExport", &receipt)
    })?;
    Ok(receipt)
}
