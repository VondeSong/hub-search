//! A fixed package copy, never a source overwrite or script execution.
use super::*;
use std::{
    collections::BTreeSet,
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
};

fn roots(path: &Path) -> Result<Vec<File>, String> {
    let mut held = Vec::new();
    for p in path.ancestors() {
        held.push(inspection::locked(p, true)?);
    }
    Ok(held)
}
fn same_files(detail: &Value, files: &Value) -> bool {
    let Some(files) = files.as_object() else {
        return false;
    };
    let expected = &detail["manifest"];
    files.len() == expected.as_object().map_or(0, |v| v.len())
        && files.iter().all(|(p, v)| {
            expected[p]["bytes"] == v["bytes"] && expected[p]["sha256"] == v["sha256"]
        })
}
fn save(c: &Connection, key: &str, state: &str, detail: &Value) -> Result<(), String> {
    let raw = detail.to_string();
    if raw.len() > 32_768 {
        return Err("导出回执超过容量，未标记成功".into());
    }
    let old:i64=c.query_row("SELECT length(CAST(detail_json AS BLOB)) FROM agent_skill_package_operations WHERE id=?1",[key],|r|r.get(0)).map_err(|_|"导出意图不存在")?;
    crate::agent_work::topics::admit(c, raw.len().saturating_sub(old as usize))?;
    c.execute("UPDATE agent_skill_package_operations SET state=?1,detail_json=?2,updated_at=?3 WHERE id=?4 AND operation='export'",params![state,raw,store::stamp(),key]).map_err(|e|e.to_string())?;
    Ok(())
}

pub(in crate::agent_work::skills::packages) fn reconcile(
    root: &Path,
    op: Value,
) -> Result<Value, String> {
    if op["operation"] != "export" {
        return Ok(op);
    }
    let key = op["clientRequestId"].as_str().ok_or("导出请求身份缺失")?;
    let detail = &op["detail"];
    let target = Path::new(detail["target"].as_str().ok_or("导出位置缺失")?);
    let checked = (|| {
        let _parents = roots(target)?;
        if detail["directoryIdentity"].as_str().is_none() {
            return Err("目录所有权未能持久确认；不重新写入或认领既有文件".to_string());
        }
        let owned = inspection::locked(target, true)?;
        if crate::obsidian_edit::identity(&owned)? != detail["directoryIdentity"] {
            return Err("导出目录身份已变化，未认领替代目录".into());
        }
        let snapshot = inspection::capture(&crate::display_local_path(target))?;
        if !same_files(detail, &snapshot.files) {
            return Err("导出文件不完整或内容已变化，未报告保存成功".into());
        }
        // Keep verification handles through the receipt commit.
        store::write(root, |c| {
            let now = operation(c, key, None)?.ok_or("导出意图已不存在")?;
            if now["detail"] != *detail {
                return Err("导出回执在核对期间变化，请刷新".into());
            }
            save(c, key, "completed", detail)?;
            operation(c, key, None)?.ok_or("导出回执缺失".into())
        })
    })();
    match checked {
        Ok(v) => Ok(v),
        Err(reason) => {
            let mut v = op;
            v["state"] = json!("unverified");
            v["verificationReason"] = json!(reason);
            Ok(v)
        }
    }
}

pub(in crate::agent_work::skills::packages) fn export(
    root: &Path,
    args: &Value,
) -> Result<Value, String> {
    let (key, digest) = client(args)?;
    let c = crate::source_evidence::open_read_database(root)?;
    if let Some(op) = operation(&c, &key, Some(&digest))? {
        drop(c);
        return reconcile(root, op);
    }
    if duplicate(&c, &key, &digest)?.is_some() {
        return Err("该请求身份已属于另一项方法包保存".into());
    }
    let id = text(args, "packageId", 100)?;
    let src = source(&c, &id)?;
    expected(args, &src)?;
    let method = text(args, "methodVersion", 100)?;
    let value = crate::agent_work::topics::method_on(&c, &method)?;
    let skill = validate(&value)?;
    if value["content"]["packageId"] != id {
        return Err("导出方法不属于当前包".into());
    }
    let parent = text(args, "directory", 4096)?;
    if !Path::new(&parent).is_absolute() {
        return Err("请选择导出父文件夹的完整路径".into());
    }
    let parent = Path::new(&parent)
        .canonicalize()
        .map_err(|_| "导出父文件夹不可访问")?;
    let _parents = roots(&parent)?;
    let target = parent.join(&skill.name);
    let source_path = Path::new(src["directory"].as_str().ok_or("原方法目录缺失")?)
        .canonicalize()
        .ok();
    if source_path
        .as_ref()
        .is_some_and(|p| target.starts_with(p) || p.starts_with(&target))
    {
        return Err("导出位置不能覆盖或包含原方法目录".into());
    }
    if target.try_exists().map_err(|_| "无法核对导出位置")? {
        return Err("导出同名文件夹已存在；未覆盖任何文件，请选择其他父文件夹".into());
    }
    let files = value["content"]["files"]
        .as_object()
        .ok_or("固定包文件缺失")?;
    let manifest = Value::Object(
        files
            .iter()
            .map(|(p, v)| (p.clone(), json!({"bytes":v["bytes"],"sha256":v["sha256"]})))
            .collect(),
    );
    let detail = json!({"packageId":id,"methodVersion":method,"target":crate::display_local_path(&target),"manifest":manifest,"directoryIdentity":null,"originalFilesChanged":false,"scriptExecution":false});
    drop(c);
    let first = store::write(root, |c| {
        if let Some(op) = operation(c, &key, Some(&digest))? {
            return Ok(Some(op));
        }
        if source(c, &id)? != src || crate::agent_work::topics::method_on(c, &method)? != value {
            return Err("方法登记在导出前变化，未写文件".into());
        }
        insert_operation(c, &key, &id, "export", &digest, "prepared", &detail)?;
        Ok(None)
    })?;
    if let Some(op) = first {
        return reconcile(root, op);
    }
    // A crash before ownership is saved leaves an unclaimed directory, never a blind retry.
    std::fs::create_dir(&target)
        .map_err(|_| "导出目录未能新建；意图已保留，不能推定成功或覆盖重试")?;
    let owned = inspection::locked(&target, true)?;
    let mut detail = detail;
    detail["directoryIdentity"] = json!(crate::obsidian_edit::identity(&owned)?);
    store::write(root, |c| save(c, &key, "prepared", &detail))?;
    store::write(root, |c| {
        if source(c, &id)? != src || crate::agent_work::topics::method_on(c, &method)? != value {
            return Err("方法已变化，未继续导出；保留原文件和本次意图".into());
        }
        let mut dirs = BTreeSet::new();
        for p in files.keys() {
            let p = Path::new(p);
            if let Some(d) = p.parent() {
                for d in d.ancestors().filter(|d| !d.as_os_str().is_empty()) {
                    dirs.insert(d.to_path_buf());
                }
            }
        }
        let mut held = Vec::new();
        for d in dirs {
            let d = target.join(d);
            std::fs::create_dir(&d).map_err(|_| "无法新建导出子目录，未标记成功")?;
            held.push(inspection::locked(&d, true)?);
        }
        let mut paths = files.keys().collect::<Vec<_>>();
        paths.sort_by_key(|p| (*p == "SKILL.md", *p));
        let mut written = Vec::new();
        for p in paths {
            let bytes = inspection::decode(&files[p])?;
            let mut options = OpenOptions::new();
            options.read(true).write(true).create_new(true);
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                options.share_mode(1).custom_flags(0x00200000);
            }
            let mut file = options
                .open(target.join(p))
                .map_err(|_| "导出文件创建失败，未覆盖既有内容，未标记成功")?;
            let identity = crate::obsidian_edit::identity(&file)?;
            file.write_all(&bytes)
                .and_then(|_| file.sync_all())
                .map_err(|_| "导出写入或落盘失败，未标记成功")?;
            file.seek(SeekFrom::Start(0)).map_err(|_| "导出读回失败")?;
            let mut actual = Vec::new();
            Read::by_ref(&mut file)
                .take(49_153)
                .read_to_end(&mut actual)
                .map_err(|_| "导出读回失败")?;
            if actual != bytes {
                return Err("导出字节读回不一致，未标记成功".into());
            }
            drop(file);
            let read = inspection::locked(&target.join(p), false)?;
            if crate::obsidian_edit::identity(&read)? != identity {
                return Err("导出文件在读回期间被替换，未标记成功".into());
            }
            written.push(read);
        }
        let snapshot = inspection::capture(&crate::display_local_path(&target))?;
        if !same_files(&detail, &snapshot.files) {
            return Err("导出完整清单与固定方法不一致，未标记成功".into());
        }
        if crate::obsidian_edit::identity(&owned)? != detail["directoryIdentity"] {
            return Err("导出目录身份已变化，未标记成功".into());
        }
        save(c, &key, "completed", &detail)?;
        operation(c, &key, Some(&digest))?.ok_or("导出回执缺失".into())
    })
}
