//! A saved answer is bound to its delivery, edited body, destination and receipt.
use super::*;
use crate::obsidian_edit as files;
use crate::x_bookmarks::library::conversion as remote;
use sha2::{Digest, Sha256};
fn hash(v: &Value) -> String {
    format!("{:x}", Sha256::digest(v.to_string().as_bytes()))
}
pub(super) fn migrate(c: &Connection) -> rusqlite::Result<()> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS agent_answer_saves(id TEXT PRIMARY KEY,work_id TEXT NOT NULL,run_id TEXT NOT NULL,state TEXT NOT NULL,body_json TEXT NOT NULL,updated_at INTEGER NOT NULL);CREATE INDEX IF NOT EXISTS agent_answer_saves_work ON agent_answer_saves(work_id,updated_at DESC);")
}
fn library(c: &Connection, id: &str) -> Result<Value, String> {
    c.query_row("SELECT name,provider,COALESCE(location,'') FROM libraries WHERE id=?1 AND enabled=1 AND provider IN ('obsidian','craft','dida365')",[id],|r|Ok(json!({"name":r.get::<_,String>(0)?,"provider":r.get::<_,String>(1)?,"location":r.get::<_,String>(2)?}))).map_err(|_|"目标资料库已停用或移除".into())
}
fn load(c: &Connection, id: &str, work: &str) -> Result<Value, String> {
    let (raw, state): (String, String) = c
        .query_row(
            "SELECT body_json,state FROM agent_answer_saves WHERE id=?1 AND work_id=?2",
            params![id, work],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| "保存预览不存在")?;
    let mut plan: Value = serde_json::from_str(&raw).map_err(|_| "保存记录损坏")?;
    plan["state"] = json!(state);
    Ok(plan)
}
fn update(root: &Path, plan: &Value, state: &str) -> Result<(), String> {
    store::write(root, |c| {
        c.execute(
            "UPDATE agent_answer_saves SET state=?2,body_json=?3,updated_at=?4 WHERE id=?1",
            params![
                plan["saveId"].as_str(),
                state,
                plan.to_string(),
                store::stamp()
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
}
fn source(root: &Path, c: &Connection, w: &Work, run: &str) -> Result<Value, String> {
    let delivery = store::answer_save_context(root, c, w, run)?;
    Ok(
        json!({"sourceHash":hash(&delivery),"text":actions::obsidian::report::markdown(&delivery)?,"title":w.goal.chars().take(80).collect::<String>()}),
    )
}
fn filename(title: &str) -> Result<String, String> {
    let name = title.trim();
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if name.is_empty()
        || name.chars().count() > 100
        || name.ends_with(['.', ' '])
        || name.chars().any(|c| c < ' ' || "<>:\"/\\|?*".contains(c))
        || [
            "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
            "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
        ]
        .contains(&stem.as_str())
    {
        return Err("笔记标题不能包含路径、保留名称或特殊字符".into());
    }
    Ok(if name.to_ascii_lowercase().ends_with(".md") {
        name.into()
    } else {
        format!("{name}.md")
    })
}
pub(super) fn records(root: &Path, id: &str) -> Result<Value, String> {
    let c = crate::source_evidence::open_read_database(root)?;
    let w = store::load(&c, id)?;
    if w.state == "revoked" {
        return Ok(json!([]));
    }
    let mut q = c
        .prepare(
            "SELECT id FROM agent_answer_saves WHERE work_id=?1 ORDER BY updated_at DESC LIMIT 32",
        )
        .map_err(|e| e.to_string())?;
    let ids = q
        .query_map([id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut values = Vec::new();
    let mut validity = HashMap::<String, bool>::new();
    for save in ids {
        let mut plan = load(&c, &save, id)?;
        let run = plan["runId"].as_str().ok_or("回答身份缺失")?.to_string();
        let valid = *validity
            .entry(run.clone())
            .or_insert_with(|| source(root, &c, &w, &run).is_ok());
        if !valid {
            plan["text"] = json!("");
            plan["after"] = Value::Null;
            plan["snapshot"] = Value::Null;
            plan["confirmationToken"] = Value::Null;
            if plan["state"] == "prepared" {
                plan["state"] = json!("expired");
                plan["error"] = json!("来源或授权已变化，旧预览不再可保存");
            }
        }
        for key in ["snapshot", "after", "remote"] {
            plan.as_object_mut().unwrap().remove(key);
        }
        values.push(plan);
    }
    Ok(json!(values))
}
pub(super) fn task_origins(root: &Path, args: &Value) -> Result<Value, String> {
    let target = text(args, "libraryId", 150)?;
    let object = text(args, "objectId", 150)?;
    crate::library_runtime::gate(root, &target)?;
    let c = crate::source_evidence::open_read_database(root)?;
    if library(&c, &target)?["provider"] != "dida365" {
        return Err("任务来源必须属于当前滴答资料库".into());
    }
    let mut q = c.prepare("SELECT DISTINCT s.work_id,s.run_id FROM agent_answer_saves s JOIN agent_works w ON w.id=s.work_id WHERE s.state='verified' AND w.state!='revoked' AND json_extract(s.body_json,'$.mode')='task' AND json_extract(s.body_json,'$.provider')='dida365' AND json_extract(s.body_json,'$.libraryId')=?1 AND json_extract(s.body_json,'$.receipt.objectId')=?2 AND json_extract(s.body_json,'$.receipt.verified')=1 ORDER BY s.updated_at DESC LIMIT 8").map_err(|e|e.to_string())?;
    let rows = q
        .query_map(params![target, object], |r| {
            Ok(json!({"workId":r.get::<_,String>(0)?,"runId":r.get::<_,String>(1)?}))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    // This is navigation metadata only. Opening the Work rechecks its current
    // sources; it neither exposes its saved answer here nor starts a model.
    Ok(json!(rows))
}
pub(super) async fn ui(app: tauri::AppHandle, args: Value) -> Result<Value, String> {
    let root = crate::active_data_root(&app)?;
    let id = text(&args, "id", 150)?;
    if args["action"] == "answerDestinations" {
        let c = crate::source_evidence::open_read_database(&root)?;
        let w = store::load(&c, &id)?;
        if w.state == "revoked" {
            return Err("来源授权已撤回".into());
        }
        let mut q=c.prepare("SELECT id,name,provider FROM libraries WHERE enabled=1 AND provider IN ('obsidian','craft','dida365') ORDER BY name,id LIMIT 100").map_err(|e|e.to_string())?;
        let libraries=q.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"provider":r.get::<_,String>(2)?}))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
        return Ok(json!({"libraries":libraries}));
    }
    if args["action"] == "answerSaveSource" {
        let c = crate::source_evidence::open_read_database(&root)?;
        let w = store::load(&c, &id)?;
        return source(&root, &c, &w, &text(&args, "runId", 150)?);
    }
    if args["action"] == "answerSaveTarget" {
        let target = text(&args, "libraryId", 150)?;
        let c = crate::source_evidence::open_read_database(&root)?;
        let info = library(&c, &target)?;
        drop(c);
        return if info["provider"] == "dida365" {
            remote::answer_target(&app, &target, "dida365", None).await
        } else {
            Ok(json!({}))
        };
    }
    if args["action"] == "prepareAnswerSave" {
        let save = text(&args, "saveId", 100)?;
        let run = text(&args, "runId", 150)?;
        let title = text(&args, "title", 100)?;
        let content = text(&args, "text", 32_000)?;
        let target = text(&args, "libraryId", 150)?;
        if content.len() > 48_000 {
            return Err("正文超过单次保存的 48 KB，请编辑后重新预览".into());
        }
        let mode = text(&args, "mode", 20)?;
        if !["append", "note", "task"].contains(&mode.as_str()) {
            return Err("保存方式无效".into());
        }
        let c = crate::source_evidence::open_read_database(&root)?;
        let w = store::load(&c, &id)?;
        let origin = source(&root, &c, &w, &run)?;
        if origin["sourceHash"] != args["sourceHash"] {
            return Err("所选回答或来源已变化，请重新打开保存面板".into());
        }
        if let Ok(old) = load(&c, &save, &id) {
            return if old["requestHash"] == hash(&args) {
                Ok(old)
            } else {
                Err("同一次保存的内容已变化，请重新预览".into())
            };
        }
        let content_identity = hash(&json!([
            id,
            run,
            mode,
            target,
            title,
            content,
            args["target"],
            args["projectId"]
        ]));
        let prior:Option<String>=c.query_row("SELECT id FROM agent_answer_saves WHERE work_id=?1 AND json_extract(body_json,'$.contentIdentity')=?2 ORDER BY updated_at DESC LIMIT 1",params![id,content_identity],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        if let Some(prior) = prior {
            let old = load(&c, &prior, &id)?;
            if old["state"] == "unknown" || old["state"] == "executing" {
                return Err(
                    "这份内容已有保存结果待核对，请按历史回执的位置核对，不重复创建".into(),
                );
            }
            if old["state"] == "verified"
                || (old["state"] == "prepared"
                    && old["revision"] == w.revision
                    && old["authorizationVersion"] == w.authorization_version)
            {
                return Ok(old);
            }
        }
        let info = library(&c, &target)?;
        let provider = info["provider"].as_str().ok_or("目标类型无效")?;
        if mode == "task" && provider != "dida365" {
            return Err("行动任务请选择滴答资料库".into());
        }
        let mut plan = json!({"saveId":save,"workId":id,"runId":run,"title":title,"text":content,"mode":mode,"libraryId":target,"provider":provider,"targetName":info["name"],"sourceHash":origin["sourceHash"],"revision":w.revision,"authorizationVersion":w.authorization_version,"requestHash":hash(&args),"contentIdentity":content_identity,"confirmationToken":crate::random_url_safe(24)});
        if mode == "append" {
            let locator: EvidenceLocator =
                serde_json::from_value(args["target"].clone()).map_err(|_| "请选择目标页面")?;
            let EvidenceLocator::Note {
                library_id,
                document_id,
                page_id,
            } = locator
            else {
                return Err("插入目标必须为页面或笔记".into());
            };
            if library_id != target {
                return Err("目标页面和资料库不匹配".into());
            }
            let target_title: String = c
                .query_row(
                    "SELECT title FROM documents WHERE space_id=?1 AND id=?2 AND provider=?3",
                    params![target, document_id, provider],
                    |r| r.get(0),
                )
                .map_err(|_| "目标页面已不可用")?;
            plan["target"] = args["target"].clone();
            plan["targetTitle"] = json!(target_title);
            if provider == "obsidian" {
                if page_id.is_some() {
                    return Err("Obsidian 保存目标必须为整篇笔记".into());
                }
                let snapshot = files::snapshot(&c, &target, &document_id)?;
                plan["targetPath"] = json!(snapshot.relative_path);
                let (_, body) = files::split(&snapshot.before)?;
                plan["after"] = json!(files::compose(
                    &snapshot,
                    &format!("{body}\n\n{content}\n")
                )?);
                plan["snapshot"] = json!(snapshot);
            } else if provider == "craft" {
                plan["pageId"] = json!(page_id.unwrap_or(document_id));
            } else {
                return Err("滴答内容请使用新建笔记或创建任务".into());
            }
        } else if provider == "obsidian" {
            let name = filename(&title)?;
            let vault = std::fs::canonicalize(info["location"].as_str().ok_or("资料库路径缺失")?)
                .map_err(|_| "资料库目录不可用")?;
            let path = vault.join(&name);
            if path.exists() {
                return Err("同名笔记已经存在，请改名或选择插入已有页面".into());
            }
            plan["vault"] = json!(vault);
            plan["targetPath"] = json!(name);
        }
        drop(c);
        crate::library_runtime::gate(&root, &target)?;
        if provider != "obsidian" {
            let remote =
                remote::answer_target(&app, &target, provider, plan["pageId"].as_str()).await?;
            if provider == "dida365" {
                let project = text(&args, "projectId", 150)?;
                if !remote["projects"]
                    .as_array()
                    .is_some_and(|ps| ps.iter().any(|p| p["id"] == project))
                {
                    return Err("请选择当前连接中的滴答清单".into());
                }
                plan["projectId"] = json!(project);
                plan["projectName"] = remote["projects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|p| p["id"] == project)
                    .unwrap()["name"]
                    .clone();
            }
            plan["remote"] = remote;
        }
        store::write(&root, |c| {
            let current = store::load(c, &id)?;
            if current.revision != w.revision
                || current.authorization_version != w.authorization_version
                || current.active_run.is_some()
                || current.state == "revoked"
            {
                return Err("准备期间对话发生变化，请重新预览".into());
            }
            c.execute("UPDATE agent_answer_saves SET state='superseded' WHERE work_id=?1 AND run_id=?2 AND state='prepared'",params![id,run]).map_err(|e|e.to_string())?;
            c.execute(
                "INSERT INTO agent_answer_saves VALUES(?1,?2,?3,'prepared',?4,?5)",
                params![save, id, run, plan.to_string(), store::stamp()],
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        })?;
        plan["state"] = json!("prepared");
        return Ok(plan);
    }
    if args["action"] == "inspectAnswerSave" {
        let save = text(&args, "saveId", 100)?;
        if active()
            .lock()
            .map_err(|_| "运行状态不可用")?
            .contains_key(&(root_key(&root), id.clone()))
        {
            return Err("请在当前操作结束后核对保存结果".into());
        }
        let c = crate::source_evidence::open_read_database(&root)?;
        let w = store::load(&c, &id)?;
        if w.state == "revoked" {
            return Err("来源授权已撤回，保存记录保留但正文隐藏".into());
        }
        let mut plan = load(&c, &save, &id)?;
        if !["unknown", "executing", "verified"]
            .contains(&plan["state"].as_str().unwrap_or_default())
        {
            return Err("这份预览尚未执行保存".into());
        }
        let receipt = if plan["provider"] == "obsidian" {
            let info = library(&c, plan["libraryId"].as_str().ok_or("目标库缺失")?)?;
            let path = if plan["mode"] == "append" {
                let base: files::Snapshot =
                    serde_json::from_value(plan["snapshot"].clone()).map_err(|_| "目标快照缺失")?;
                let observed = files::snapshot(&c, &base.library_id, &base.document_id)?;
                if observed.vault != base.vault
                    || observed.relative_path != base.relative_path
                    || observed.before != plan["after"]
                {
                    return Err("目标文件与保存预览不一致，未重新写入".into());
                }
                PathBuf::from(base.vault).join(base.relative_path)
            } else {
                let vault =
                    std::fs::canonicalize(info["location"].as_str().ok_or("原资料库位置缺失")?)
                        .map_err(|_| "原资料库已不可用")?;
                if json!(vault) != plan["vault"] {
                    return Err("资料库位置已变化，未读取其他位置".into());
                }
                #[cfg(windows)]
                let _vault_guard = {
                    use std::os::windows::fs::OpenOptionsExt;
                    std::fs::OpenOptions::new()
                        .read(true)
                        .share_mode(1)
                        .custom_flags(0x02000000)
                        .open(&vault)
                        .map_err(|_| "无法锁定资料库目录")?
                };
                let path = vault.join(filename(plan["title"].as_str().ok_or("标题缺失")?)?);
                let expected = format!(
                    "# {}\n\n{}\n",
                    plan["title"].as_str().unwrap(),
                    plan["text"].as_str().ok_or("正文缺失")?
                );
                if std::fs::read(&path).map_err(|_| "未找到原保存文件")? != expected.as_bytes()
                {
                    return Err("保存文件与预览不同，未重新写入".into());
                }
                path
            };
            json!({"verified":true,"provider":"obsidian","path":path,"inspected":true})
        } else {
            drop(c);
            let object = args["objectId"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .or_else(|| plan["receipt"]["objectId"].as_str())
                .or_else(|| plan["pageId"].as_str())
                .ok_or("尚无远端保存身份，请填写已创建的页面或任务 ID 再核对")?;
            if object.len() > 200 {
                return Err("远端身份无效".into());
            }
            remote::inspect_answer(&app, &plan, object).await?
        };
        plan["receipt"] = receipt;
        plan["error"] = Value::Null;
        update(&root, &plan, "verified")?;
        return records(&root, &id)?
            .as_array()
            .and_then(|v| v.iter().find(|p| p["saveId"] == save))
            .cloned()
            .ok_or("保存记录已保留，当前授权下正文隐藏".into());
    }
    if args["action"] != "submitAnswerSave" {
        return Err("未知回答保存操作".into());
    }
    let save = text(&args, "saveId", 100)?;
    let c = crate::source_evidence::open_read_database(&root)?;
    let mut plan = load(&c, &save, &id)?;
    if plan["confirmationToken"] != args["confirmationToken"] {
        return Err("确认与保存预览不匹配".into());
    }
    let current_work = store::load(&c, &id)?;
    if current_work.state == "revoked" {
        return Err("来源授权已撤回，保存记录已保留但正文隐藏".into());
    }
    if plan["state"] == "verified" {
        return records(&root, &id)?
            .as_array()
            .and_then(|v| v.iter().find(|p| p["saveId"] == save))
            .cloned()
            .ok_or("保存回执暂不可读取".into());
    }
    if plan["state"] != "prepared" {
        return Err("上次写入结果待核对，不能重复保存；请按已记录的位置核对原件".into());
    }
    let w = store::load(&c, &id)?;
    if w.revision != plan["revision"]
        || w.authorization_version != plan["authorizationVersion"]
        || source(&root, &c, &w, plan["runId"].as_str().ok_or("回答身份缺失")?)?["sourceHash"]
            != plan["sourceHash"]
    {
        return Err("回答或授权已变化，请重新预览".into());
    }
    let library_id = plan["libraryId"].as_str().ok_or("目标库缺失")?.to_string();
    let info = library(&c, &library_id)?;
    drop(c);
    let operation = crate::library_runtime::begin(&root, &library_id, "保存助手回答")?;
    let control = Control::bounded(Duration::from_secs(300));
    let running = {
        let mut map = active().lock().map_err(|_| "运行状态不可用")?;
        let key = (root_key(&root), id.clone());
        if map.contains_key(&key) {
            return Err("当前对话正在处理，请稍后保存".into());
        }
        map.insert(
            key.clone(),
            Active {
                run_id: save.clone(),
                control: control.clone(),
                is_action: true,
            },
        );
        Running(key)
    };
    store::write(&root, |c| {
        let current = load(c, &save, &id)?;
        if current["state"] != "prepared" {
            return Err("保存状态已变化，请刷新核对，未重复执行".into());
        }
        let w = store::load(c, &id)?;
        if w.revision != plan["revision"]
            || w.authorization_version != plan["authorizationVersion"]
            || source(&root, c, &w, plan["runId"].as_str().ok_or("回答身份缺失")?)?["sourceHash"]
                != plan["sourceHash"]
        {
            return Err("保存前回答或授权已变化，未执行写入".into());
        }
        c.execute(
            "UPDATE agent_answer_saves SET state='executing',updated_at=?2 WHERE id=?1",
            params![save, store::stamp()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })?;
    let result = if plan["provider"] == "obsidian" {
        local_save(&root, &plan, &info, &operation, &control)
    } else {
        remote::save_answer(&app, &plan, control.clone(), |object| {
            let mut partial = plan.clone();
            partial["receipt"] =
                json!({"provider":plan["provider"],"objectId":object,"verified":false});
            update(&root, &partial, "executing")
        })
        .await
    };
    let latest = crate::source_evidence::open_read_database(&root)?;
    plan = load(&latest, &save, &id)?;
    drop(latest);
    match result {
        Ok(receipt) => {
            plan["receipt"] = receipt;
            update(&root, &plan, "verified")?;
            plan["state"] = json!("verified");
        }
        Err(error) => {
            plan["error"] = json!(error);
            update(&root, &plan, "unknown")?;
            plan["state"] = json!("unknown");
        }
    }
    drop(running);
    records(&root, &id)?
        .as_array()
        .and_then(|v| v.iter().find(|p| p["saveId"] == save))
        .cloned()
        .ok_or("保存记录已保留，当前授权下正文隐藏".into())
}
fn local_save(
    root: &Path,
    plan: &Value,
    info: &Value,
    operation: &crate::library_runtime::Operation,
    control: &Control,
) -> Result<Value, String> {
    control.check()?;
    let c = crate::source_evidence::open_read_database(root)?;
    let (vault, path) = if plan["mode"] == "append" {
        let base: files::Snapshot =
            serde_json::from_value(plan["snapshot"].clone()).map_err(|_| "原笔记快照损坏")?;
        let mut locked = files::LockedNote::open(&c, &base)?;
        let after = plan["after"].as_str().ok_or("预览正文缺失")?;
        operation.commit(|| {
            control.check()?;
            locked.write(after)
        })?;
        drop(locked);
        (
            PathBuf::from(&base.vault),
            PathBuf::from(&base.vault).join(&base.relative_path),
        )
    } else {
        use std::io::Write;
        let vault = std::fs::canonicalize(info["location"].as_str().ok_or("资料库路径缺失")?)
            .map_err(|_| "资料库目录不可用")?;
        if json!(vault) != plan["vault"] {
            return Err("资料库位置已改变，请重新预览".into());
        }
        #[cfg(windows)]
        let _vault_guard = {
            use std::os::windows::fs::OpenOptionsExt;
            std::fs::OpenOptions::new()
                .read(true)
                .share_mode(1)
                .custom_flags(0x02000000)
                .open(&vault)
                .map_err(|_| "无法锁定资料库目录")?
        };
        let path = vault.join(filename(plan["title"].as_str().ok_or("标题缺失")?)?);
        let body = format!(
            "# {}\n\n{}\n",
            plan["title"].as_str().unwrap(),
            plan["text"].as_str().ok_or("正文缺失")?
        );
        operation.commit(|| {
            control.check()?;
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(|_| "无法新建笔记或同名文件已存在，未覆盖")?;
            file.write_all(body.as_bytes())
                .and_then(|_| file.sync_all())
                .map_err(|_| "文件写入结果未完整确认")?;
            Ok(())
        })?;
        if std::fs::read(&path).map_err(|_| "新笔记无法回读")? != body.as_bytes() {
            return Err("新笔记读回不一致，请核对原文件".into());
        }
        (vault, path)
    };
    let indexed = crate::sync_obsidian_changed_paths_database(
        &root.join("craft-search.sqlite3"),
        plan["libraryId"].as_str().unwrap(),
        &vault,
        &std::collections::HashSet::from([path.clone()]),
    )
    .is_ok();
    Ok(
        json!({"verified":true,"provider":"obsidian","path":path,"indexed":indexed,"operation":plan["mode"]}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn task_origin_requires_exact_verified_destination_and_hides_revoked_work() {
        let f = crate::source_evidence::tests::Fixture::new();
        let id = store::create(
            &f.root,
            "核对资料".into(),
            "".into(),
            None,
            Grant::default(),
        )
        .unwrap();
        let c = f.c();
        c.execute(
            "UPDATE libraries SET provider='dida365' WHERE id='notes'",
            [],
        )
        .unwrap();
        let body = json!({"mode":"task","provider":"dida365","libraryId":"notes","receipt":{"objectId":"task-a","verified":true}});
        c.execute(
            "INSERT INTO agent_answer_saves VALUES('saved',?1,'source-run','verified',?2,1)",
            params![id, body.to_string()],
        )
        .unwrap();
        let args = json!({"libraryId":"notes","objectId":"task-a"});
        assert_eq!(
            task_origins(&f.root, &args).unwrap(),
            json!([{"workId":id,"runId":"source-run"}])
        );
        assert_eq!(
            task_origins(&f.root, &json!({"libraryId":"notes","objectId":"task-b"})).unwrap(),
            json!([])
        );
        assert!(task_origins(
            &f.root,
            &json!({"libraryId":"other-account","objectId":"task-a"})
        )
        .is_err());
        c.execute("UPDATE agent_answer_saves SET state='unknown'", [])
            .unwrap();
        assert_eq!(task_origins(&f.root, &args).unwrap(), json!([]));
        c.execute("UPDATE agent_answer_saves SET state='verified'", [])
            .unwrap();
        c.execute("UPDATE agent_works SET state='revoked' WHERE id=?1", [id])
            .unwrap();
        assert_eq!(task_origins(&f.root, &args).unwrap(), json!([]));
    }
    #[test]
    fn new_note_names_cannot_escape_the_chosen_vault() {
        for name in ["../a", "a/b", "a\\b", "CON.txt", "NUL", "a.", "a:b"] {
            assert!(filename(name).is_err(), "{name}");
        }
        assert_eq!(filename("研究笔记").unwrap(), "研究笔记.md");
    }
    #[test]
    fn local_answer_creation_preserves_existing_files_and_cancellation() {
        let f = crate::obsidian_edit::tests::Fixture::new();
        let vault = std::fs::canonicalize(&f.vault).unwrap();
        let plan = json!({"libraryId":"notes","mode":"note","title":"研究笔记","text":"选定回答正文","vault":vault});
        let info = json!({"location":f.vault});
        let operation = crate::library_runtime::begin(&f.root, "notes", "测试保存").unwrap();
        let cancelled = Control::default();
        cancelled.cancel();
        assert!(local_save(&f.root, &plan, &info, &operation, &cancelled).is_err());
        assert!(!f.vault.join("研究笔记.md").exists());
        let receipt = local_save(&f.root, &plan, &info, &operation, &Control::default()).unwrap();
        assert_eq!(receipt["verified"], true);
        let before = std::fs::read(f.vault.join("研究笔记.md")).unwrap();
        assert!(local_save(&f.root, &plan, &info, &operation, &Control::default()).is_err());
        assert_eq!(std::fs::read(f.vault.join("研究笔记.md")).unwrap(), before);
    }
    #[test]
    fn answer_append_keeps_original_frontmatter_and_refuses_changed_target() {
        let f = crate::obsidian_edit::tests::Fixture::new();
        let id = f.seed("原笔记.md", "---\r\ntags: [保留]\r\n---\r\n原有正文\r\n");
        let base = files::snapshot(&f.c(), "notes", &id).unwrap();
        let (_, body) = files::split(&base.before).unwrap();
        let after = files::compose(&base, &format!("{body}\n\n回答正文\n")).unwrap();
        let plan = json!({"libraryId":"notes","mode":"append","snapshot":base,"after":after});
        let operation = crate::library_runtime::begin(&f.root, "notes", "测试追加").unwrap();
        local_save(&f.root, &plan, &json!({}), &operation, &Control::default()).unwrap();
        assert_eq!(
            std::fs::read_to_string(f.vault.join("原笔记.md")).unwrap(),
            after
        );
        assert!(after.starts_with("---\r\ntags: [保留]\r\n---"));
        std::fs::write(f.vault.join("原笔记.md"), "其他程序修改").unwrap();
        assert!(local_save(&f.root, &plan, &json!({}), &operation, &Control::default()).is_err());
        assert_eq!(
            std::fs::read_to_string(f.vault.join("原笔记.md")).unwrap(),
            "其他程序修改"
        );
    }
}
