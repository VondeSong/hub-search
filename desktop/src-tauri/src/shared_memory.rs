//! Hub owns confirmation, scope and version eligibility. Basic Memory owns
//! Markdown materialization and retrieval; its results never grant authority.
mod backend;
pub(crate) mod proposals;
mod runtime;
#[cfg(test)]
mod tests;

use backend::{Backend, BasicMemory};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(Default::default)
}
fn safe_path(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(meta) => {
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if meta.file_attributes() & 0x400 != 0 {
                        return Err("记忆路径不接受目录联接".into());
                    }
                }
                if meta.file_type().is_symlink() {
                    return Err("记忆路径不接受符号链接".into());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}
fn database(root: &Path) -> Result<Connection, String> {
    crate::source_evidence::open_read_database(root)
}
pub(crate) fn migrate(c: &Connection) -> Result<(), String> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS memory_projects(id TEXT PRIMARY KEY,name TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS memory_work_scopes(work_id TEXT PRIMARY KEY REFERENCES agent_works(id),project_id TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS memory_entries(
            id TEXT PRIMARY KEY,project_id TEXT NOT NULL,topic_key TEXT NOT NULL,title TEXT NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('rule','decision')),version INTEGER NOT NULL,
            state TEXT NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(project_id,topic_key));
        CREATE TABLE IF NOT EXISTS memory_versions(
            id TEXT PRIMARY KEY,memory_id TEXT NOT NULL REFERENCES memory_entries(id),version INTEGER NOT NULL,
            body_hash TEXT NOT NULL,state TEXT NOT NULL,request_key TEXT NOT NULL UNIQUE,
            request_hash TEXT NOT NULL,confirmation TEXT NOT NULL,UNIQUE(memory_id,version));
        CREATE TABLE IF NOT EXISTS memory_proposals(id TEXT PRIMARY KEY,memory_id TEXT NOT NULL,project_id TEXT NOT NULL,expected_version INTEGER NOT NULL,body_json TEXT NOT NULL,source_json TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS memory_sources(revision_id TEXT PRIMARY KEY,source_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS memory_epoch(id INTEGER PRIMARY KEY CHECK(id=1),value INTEGER NOT NULL);
        INSERT OR IGNORE INTO memory_epoch VALUES(1,0);").map_err(|e| e.to_string())
}
fn write<T>(root: &Path, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
    let (c, _writer) = crate::database::open_write_database(&root.join("craft-search.sqlite3"))?;
    let permit = crate::library_runtime::cached_read_permit(root)?;
    c.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| e.to_string())?;
    let result = f(&c)?;
    permit.commit(|| c.execute_batch("COMMIT").map_err(|e| e.to_string()))?;
    Ok(result)
}
fn bump(c: &Connection) -> Result<(), String> {
    c.execute("UPDATE memory_epoch SET value=value+1 WHERE id=1", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}
fn text(args: &Value, key: &str, max: usize) -> Result<String, String> {
    let value = args[key].as_str().unwrap_or("").trim();
    if value.is_empty() || value.len() > max || value.contains('\0') {
        return Err(format!("{key} 为空或超过长度限制"));
    }
    Ok(value.to_string())
}
fn scope(c: &Connection, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Ok(());
    }
    if !c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM memory_projects WHERE id=?1)",
            [value],
            |r| r.get::<_, bool>(0),
        )
        .map_err(|e| e.to_string())?
    {
        return Err("请选择已创建的记忆项目".into());
    }
    Ok(())
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Item {
    id: String,
    revision_id: String,
    project_id: String,
    title: String,
    topic_key: String,
    kind: String,
    version: i64,
    state: String,
    body_hash: String,
}
fn load(c: &Connection, id: &str) -> Result<Item, String> {
    c.query_row("SELECT e.id,v.id,e.project_id,e.title,e.kind,e.version,e.state,v.body_hash,e.topic_key
        FROM memory_entries e JOIN memory_versions v ON v.memory_id=e.id AND v.version=e.version WHERE e.id=?1",
        [id],|r|Ok(Item{id:r.get(0)?,revision_id:r.get(1)?,project_id:r.get(2)?,title:r.get(3)?,kind:r.get(4)?,version:r.get(5)?,state:r.get(6)?,body_hash:r.get(7)?,topic_key:r.get(8)?}))
        .map_err(|_| "记忆不存在".into())
}
fn path(root: &Path, revision: &str, draft: bool) -> Result<PathBuf, String> {
    if !revision.starts_with("hm-")
        || revision.len() > 100
        || !revision
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("记忆文件身份无效".into());
    }
    let p = root
        .join(if draft {
            "shared-memory/drafts"
        } else {
            "shared-memory/notes"
        })
        .join(format!("{revision}.md"));
    safe_path(&p)?;
    Ok(p)
}
fn body(root: &Path, item: &Item) -> Result<String, String> {
    let p = path(root, &item.revision_id, false)?;
    if fs::metadata(&p).map_err(|_| "记忆正文尚不可用")?.len() > 32_768 {
        return Err("记忆正文过大".into());
    }
    let raw = fs::read_to_string(p)
        .map_err(|_| "记忆正文尚不可用")?
        .replace("\r\n", "\n");
    let raw = raw
        .strip_prefix("---\n")
        .and_then(|s| s.split_once("\n---\n").map(|(_, v)| v))
        .unwrap_or(&raw)
        .trim();
    if hash(raw.as_bytes()) != item.body_hash {
        return Err("记忆正文已在外部变化，需要重新确认".into());
    }
    Ok(raw.to_string())
}
fn status(root: &Path, work: Option<&str>, prepare: bool) -> Result<Value, String> {
    let c = database(root)?;
    let mut stmt=c.prepare("SELECT id FROM memory_entries WHERE state!='forgotten' ORDER BY updated_at DESC LIMIT 200").map_err(|e|e.to_string())?;
    let ids = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut entries = Vec::new();
    for id in ids {
        let item = load(&c, &id)?;
        let mut value = json!(item);
        value["updatedAt"] = json!(c
            .query_row(
                "SELECT updated_at FROM memory_entries WHERE id=?1",
                [&item.id],
                |r| r.get::<_, i64>(0)
            )
            .map_err(|e| e.to_string())?);
        match body(root, &item) {
            Ok(content) => value["body"] = json!(content),
            Err(reason) => {
                value["body"] = Value::Null;
                value["detail"] = json!(reason);
            }
        }
        let source: Option<String> = c
            .query_row(
                "SELECT source_json FROM memory_sources WHERE revision_id=?1",
                [&item.revision_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        value["source"] = source
            .map(|raw| serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null))
            .unwrap_or(json!({"origin":"legacyUserConfirmed"}));
        let mut revisions=c.prepare("SELECT v.version,s.source_json FROM memory_versions v LEFT JOIN memory_sources s ON s.revision_id=v.id WHERE v.memory_id=?1 ORDER BY v.version DESC").map_err(|e|e.to_string())?;
        let history=revisions.query_map([&item.id],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,Option<String>>(1)?))).map_err(|e|e.to_string())?.map(|r|{let(version,source)=r.map_err(|e|e.to_string())?;Ok(json!({"version":version,"source":source.and_then(|raw|serde_json::from_str::<Value>(&raw).ok())}))}).collect::<Result<Vec<Value>,String>>()?;
        value["history"] = json!(history);
        entries.push(value);
    }
    let mut stmt = c
        .prepare("SELECT id,name FROM memory_projects ORDER BY name,id")
        .map_err(|e| e.to_string())?;
    let projects = stmt
        .query_map([], |r| {
            Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?}))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let selected = work
        .map(|id| {
            c.query_row(
                "SELECT project_id,enabled FROM memory_work_scopes WHERE work_id=?1",
                [id],
                |r| Ok(json!({"projectId":r.get::<_,String>(0)?,"enabled":r.get::<_,bool>(1)?})),
            )
            .optional()
            .map_err(|e| e.to_string())
        })
        .transpose()?
        .flatten();
    let runtime = if prepare {
        backend::config(root).map(|_| ())
    } else {
        backend::preview(root)
    };
    Ok(
        json!({"backend":"basicMemory","configured":runtime.is_ok(),"runtimeDetail":runtime.err(),"entries":entries,"proposals":proposals::list(&c,selected.as_ref().and_then(|s|s["projectId"].as_str()).unwrap_or(""))?,"projects":projects,
        "selection":selected.unwrap_or(json!({"projectId":"","enabled":false}))}),
    )
}
fn stage(root: &Path, args: &Value) -> Result<Item, String> {
    if args["confirmed"] != true {
        return Err("只有你明确确认的内容才能成为共享记忆".into());
    }
    let title = text(args, "title", 300)?;
    let topic = text(args, "topicKey", 300)?;
    let content = text(args, "body", 6000)?.replace("\r\n", "\n");
    // Keep arbitrary source frontmatter from changing the canonical envelope.
    if content.starts_with("---") {
        return Err("记忆正文请直接填写内容，不包含文件元数据".into());
    }
    let request = text(args, "requestKey", 160)?;
    let kind = text(args, "kind", 20)?;
    if !["rule", "decision"].contains(&kind.as_str()) {
        return Err("记忆类型无效".into());
    }
    let project = args["projectId"].as_str().unwrap_or("");
    let id = format!(
        "hm-{}",
        &hash(format!("{project}\0{topic}").as_bytes())[..32]
    );
    let expected = args["expectedVersion"]
        .as_i64()
        .ok_or("请提供要更新的版本")?;
    let fingerprint = hash(
        json!([project, topic, title, kind, content, expected])
            .to_string()
            .as_bytes(),
    );
    let c = database(root)?;
    scope(&c, project)?;
    let previous = c
        .query_row(
            "SELECT memory_id,request_hash FROM memory_versions WHERE request_key=?1",
            [&request],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some((old_id, old_hash)) = previous {
        if old_hash != fingerprint {
            return Err("重复请求的内容已改变，请使用新的请求身份".into());
        }
        return load(&c, &old_id);
    }
    let mut source = proposals::source(&c, args, &id, expected)?;
    source["title"] = json!(&title);
    source["kind"] = json!(&kind);
    let old = load(&c, &id).ok();
    if old.as_ref().map(|v| v.version).unwrap_or(0) != expected {
        return Err("记忆版本已变化，请刷新后再确认".into());
    }
    if old
        .as_ref()
        .is_some_and(|v| v.state == "forgotten" || v.state == "deleting")
    {
        return Err("该主题已遗忘；请为新的明确决定使用新的主题".into());
    }
    let version = expected + 1;
    let revision = format!("{id}-v{version}");
    let draft = path(root, &revision, true)?;
    fs::create_dir_all(draft.parent().unwrap()).map_err(|e| e.to_string())?;
    // A failed prior stage may have left an unregistered draft. Never overwrite
    // it with different content.
    if draft.exists() {
        if fs::read_to_string(&draft).map_err(|e| e.to_string())? != content {
            return Err("待写文件已存在不同内容".into());
        }
    } else {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&draft)
            .map_err(|e| e.to_string())?;
        file.write_all(content.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
    }
    write(root, |c| {
        let current = load(c, &id).ok();
        if current.as_ref().map(|v| v.version).unwrap_or(0) != expected {
            return Err("记忆版本冲突".into());
        }
        c.execute("INSERT INTO memory_entries(id,project_id,topic_key,title,kind,version,state,updated_at)
            VALUES(?1,?2,?3,?4,?5,?6,'pending',?7)
            ON CONFLICT(id) DO UPDATE SET title=excluded.title,kind=excluded.kind,version=excluded.version,state='pending',updated_at=excluded.updated_at",
            params![id,project,topic,title,kind,version,chrono::Utc::now().timestamp_millis()]).map_err(|e|e.to_string())?;
        c.execute(
            "INSERT INTO memory_versions VALUES(?1,?2,?3,?4,'pending',?5,?6,'explicitUser')",
            params![
                revision,
                id,
                version,
                hash(content.as_bytes()),
                request,
                fingerprint
            ],
        )
        .map_err(|e| e.to_string())?;
        proposals::accept(c, args, &revision, &source)?;
        bump(c)?;
        load(c, &id)
    })
}
fn publish(root: &Path, item: &Item, backend: &mut impl Backend) -> Result<(), String> {
    if item.state == "active" {
        return Ok(());
    }
    if item.state != "pending" {
        return Err("该版本不能发布".into());
    }
    let draft = path(root, &item.revision_id, true)?;
    let content = fs::read_to_string(&draft).map_err(|_| "待写正文丢失，请重新确认")?;
    if hash(content.as_bytes()) != item.body_hash {
        return Err("待写正文已改变，请重新确认".into());
    }
    // Never repeat an accepted write. Reconcile the immutable file after an
    // interrupted request; a different file hash cannot be silently adopted.
    if path(root, &item.revision_id, false)?.exists() {
        body(root, item)?;
    } else {
        backend.write(&item.revision_id, &content)?;
    }
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if body(root, item).is_ok() && backend.ready(&item.revision_id)? {
            break;
        }
        if Instant::now() >= deadline {
            return Err("正文已登记，索引仍待核验；可稍后重试".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    write(root, |c| {
        let current = load(c, &item.id)?;
        if current.version != item.version || current.state != "pending" {
            return Err("待发布版本已改变".into());
        }
        body(root, item)?;
        c.execute("UPDATE memory_versions SET state='superseded' WHERE memory_id=?1 AND version<>?2 AND state!='forgotten'",
            params![item.id,item.version]).map_err(|e|e.to_string())?;
        c.execute(
            "UPDATE memory_versions SET state='active' WHERE id=?1",
            [&item.revision_id],
        )
        .map_err(|e| e.to_string())?;
        c.execute(
            "UPDATE memory_entries SET state='active' WHERE id=?1",
            [&item.id],
        )
        .map_err(|e| e.to_string())?;
        bump(c)
    })?;
    fs::remove_file(draft).map_err(|e| e.to_string())?;
    Ok(())
}
fn forget(root: &Path, id: &str, backend: &mut impl Backend) -> Result<(), String> {
    write(root, |c| {
        c.execute(
            "UPDATE memory_entries SET state='deleting' WHERE id=?1",
            [id],
        )
        .map_err(|e| e.to_string())?;
        bump(c)
    })?;
    let c = database(root)?;
    let mut stmt = c
        .prepare("SELECT id FROM memory_versions WHERE memory_id=?1")
        .map_err(|e| e.to_string())?;
    let ids = stmt
        .query_map([id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    for revision in ids {
        if path(root, &revision, false)?.exists() || backend.ready(&revision)? {
            backend.delete(&revision)?;
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        while path(root, &revision, false)?.exists() || backend.ready(&revision)? {
            if Instant::now() >= deadline {
                return Err("记忆已停止使用，清除仍未完成；请重试遗忘".into());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let draft = path(root, &revision, true)?;
        if draft.exists() {
            fs::remove_file(draft).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
fn finish_forget(root: &Path, id: &str) -> Result<(), String> {
    write(root, |c| {
        c.execute("UPDATE memory_versions SET state='forgotten',body_hash='',request_hash='',confirmation='' WHERE memory_id=?1",[id]).map_err(|e|e.to_string())?;
        c.execute(
            "UPDATE memory_entries SET state='forgotten',title='',topic_key=id WHERE id=?1",
            [id],
        )
        .map_err(|e| e.to_string())?;
        bump(c)
    })
}

pub(crate) fn ui(root: &Path, args: &Value) -> Result<Value, String> {
    if args.to_string().len() > 20_000 {
        return Err("记忆请求过大".into());
    }
    let _maintenance = crate::data_portability::maintenance_lock(root)?;
    let _guard = lock()
        .try_lock()
        .map_err(|_| "另一项记忆操作正在进行，请稍后重试")?;
    let _permit = crate::library_runtime::cached_read_permit(root)?;
    let work = args["workId"].as_str();
    match args["action"].as_str().unwrap_or("status") {
        "status" => (),
        "workProposals" => {
            let id = work.ok_or("请选择一个调查事项")?;
            let c = database(root)?;
            let visible: bool = c
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM agent_works WHERE id=?1 AND state!='revoked')",
                    [id],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            return Ok(
                json!({"proposals": if visible { proposals::for_work(&c, id)? } else { Vec::new() }}),
            );
        }
        "history" => {
            let c = database(root)?;
            let item = load(&c, &text(args, "id", 100)?)?;
            if matches!(item.state.as_str(), "deleting" | "forgotten") {
                return Err("这条记忆的历史正在清除或已遗忘".into());
            }
            let mut query = c.prepare("SELECT v.id,v.version,v.body_hash,s.source_json FROM memory_versions v LEFT JOIN memory_sources s ON s.revision_id=v.id WHERE v.memory_id=?1 ORDER BY v.version DESC LIMIT 21").map_err(|e| e.to_string())?;
            let rows = query
                .query_map([&item.id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            let mut versions = Vec::new();
            for row in rows {
                let (revision_id, version, body_hash, raw) = row.map_err(|e| e.to_string())?;
                let source = raw
                    .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
                    .unwrap_or_default();
                let revision = Item {
                    revision_id,
                    version,
                    body_hash,
                    ..item.clone()
                };
                versions.push(json!({
                    "version":version, "body":body(root, &revision).ok(), "source":source,
                    "title":if version == item.version { json!(&item.title) } else { source["title"].clone() },
                    "kind":if version == item.version { json!(&item.kind) } else { source["kind"].clone() },
                }));
            }
            return Ok(json!({"versions":versions}));
        }
        "repair" => {
            runtime::repair(root)?;
        }
        "configure" if cfg!(debug_assertions) => {
            let cfg: backend::RuntimeConfig =
                serde_json::from_value(args["runtime"].clone()).map_err(|_| "运行环境配置无效")?;
            let service = BasicMemory::start(root, &cfg)?;
            drop(service);
            let target = root.join("memory-runtime-v1.json");
            safe_path(&target)?;
            fs::write(target, serde_json::to_vec_pretty(&cfg).unwrap())
                .map_err(|e| e.to_string())?;
        }
        "createProject" => {
            let name = text(args, "name", 200)?;
            let id = format!("mp-{}", crate::random_url_safe(12));
            write(root, |c| {
                c.execute(
                    "INSERT INTO memory_projects VALUES(?1,?2)",
                    params![id, name],
                )
                .map_err(|e| e.to_string())?;
                Ok(())
            })?;
        }
        "selectScope" => {
            let work = work.ok_or("请选择一个调查事项")?;
            let project = args["projectId"].as_str().unwrap_or("");
            write(root, |c| {
                scope(c, project)?;
                let state: String = c
                    .query_row("SELECT state FROM agent_works WHERE id=?1", [work], |r| {
                        r.get(0)
                    })
                    .map_err(|_| "调查事项不存在")?;
                if state == "revoked" {
                    return Err("事项授权已撤回".into());
                }
                c.execute("INSERT INTO memory_work_scopes VALUES(?1,?2,?3) ON CONFLICT(work_id) DO UPDATE SET project_id=excluded.project_id,enabled=excluded.enabled",
                    params![work,project,args["enabled"]==true]).map_err(|e|e.to_string())?;
                bump(c)
            })?;
        }
        "put" => {
            let item = stage(root, args)?;
            if item.state == "pending" {
                let mut service = BasicMemory::start(root, &backend::config(root)?)?;
                publish(root, &item, &mut service)?;
            }
        }
        "retry" => {
            let item = load(&database(root)?, &text(args, "id", 100)?)?;
            let mut service = BasicMemory::start(root, &backend::config(root)?)?;
            publish(root, &item, &mut service)?;
        }
        "dismissProposal" => {
            let id = text(args, "proposalId", 100)?;
            write(root, |c| {
                c.execute("UPDATE memory_proposals SET state='dismissed' WHERE id=?1 AND state='awaitingConfirmation'",[id]).map_err(|e|e.to_string())?;
                Ok(())
            })?;
        }
        "deactivate" => {
            let id = text(args, "id", 100)?;
            write(root, |c| {
                if args["expectedVersion"].as_i64().is_some_and(|version| {
                    load(c, &id).map_or(true, |item| item.version != version)
                }) {
                    return Err("记忆版本已变化，请重新查看".into());
                }
                c.execute("UPDATE memory_entries SET state='inactive' WHERE id=?1 AND state IN ('active','pending')",[id]).map_err(|e|e.to_string())?;
                bump(c)
            })?;
        }
        "forget" => {
            if args["confirmed"] != true {
                return Err("请确认遗忘该记忆及其历史正文".into());
            }
            let id = text(args, "id", 100)?;
            // Eligibility is withdrawn even if the backend is currently offline.
            write(root, |c| {
                let item = load(c, &id)?;
                if args["expectedVersion"]
                    .as_i64()
                    .is_some_and(|version| item.version != version)
                {
                    return Err("记忆版本已变化，请重新查看".into());
                }
                c.execute(
                    "UPDATE memory_entries SET state='deleting' WHERE id=?1",
                    [&id],
                )
                .map_err(|e| e.to_string())?;
                c.execute("DELETE FROM memory_proposals WHERE memory_id=?1", [&id])
                    .map_err(|e| e.to_string())?;
                c.execute("DELETE FROM memory_sources WHERE revision_id IN (SELECT id FROM memory_versions WHERE memory_id=?1)",[&id]).map_err(|e|e.to_string())?;
                bump(c)
            })?;
            let mut service = BasicMemory::start(root, &backend::config(root)?)?;
            let result = forget(root, &id, &mut service);
            drop(service);
            // No background materializer can race this purge. Remove only the
            // explicitly owned derived cache (including logs/WAL), never notes
            // or the separately configured shared model cache.
            let cache = root.join("cache/shared-memory-bm");
            safe_path(&cache)?;
            if cache.exists() {
                let owned = fs::canonicalize(root.join("cache")).map_err(|e| e.to_string())?;
                let actual = fs::canonicalize(&cache).map_err(|e| e.to_string())?;
                if actual.parent() != Some(owned.as_path())
                    || actual.file_name().and_then(|s| s.to_str()) != Some("shared-memory-bm")
                {
                    return Err("记忆缓存所有权核验失败，清除尚未完成".into());
                }
                fs::remove_dir_all(actual).map_err(|_| "记忆已停用，但派生缓存尚未清除")?;
            }
            result?;
            finish_forget(root, &id)?;
        }
        _ => return Err("未知记忆操作".into()),
    }
    let mut current = status(root, work, args["prepareRuntime"] != false)?;
    if work.is_none() {
        if let Some(project) = args["projectId"].as_str() {
            let c = database(root)?;
            scope(&c, project)?;
            current["proposals"] = json!(proposals::list(&c, project)?);
        }
    }
    Ok(current)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Context {
    epoch: i64,
    project_id: String,
    rules: Vec<Value>,
    decisions: Vec<Value>,
    pub(crate) notice: Option<String>,
    omissions: Value,
    #[serde(skip)]
    items: Vec<Item>,
}
impl Context {
    pub(crate) fn audit(&self) -> Value {
        json!({"epoch":self.epoch,"projectId":self.project_id,
            "items":self.items.iter().map(|i|json!({"id":i.id,"version":i.version,"kind":i.kind,"reason":if i.kind=="rule"{"confirmedRule"}else{"basicMemoryCandidate"}})).collect::<Vec<_>>(),
            "notice":self.notice,"omissions":self.omissions,"budgetMethod":"UTF-8 bytes upper bound; each section <=2000 including JSON"})
    }
}
#[cfg(test)]
pub(crate) fn context(root: &Path, work: &str, query: &str) -> Result<Option<Context>, String> {
    context_controlled(root, work, query, None)
}
pub(crate) fn context_controlled(
    root: &Path,
    work: &str,
    query: &str,
    control: Option<&crate::model_runtime::Control>,
) -> Result<Option<Context>, String> {
    let c = database(root)?;
    let selected = || {
        c.query_row(
            "SELECT project_id FROM memory_work_scopes WHERE work_id=?1 AND enabled=1",
            [work],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())
    };
    let Some(project) = selected()? else {
        return Ok(None);
    };
    let _maintenance = crate::data_portability::maintenance_lock(root)?;
    let _guard = lock()
        .try_lock()
        .map_err(|_| "记忆正在更新，请稍后继续调查")?;
    // The initial opt-in read avoids blocking ordinary investigations. Scope
    // may change before we acquire the gate, so validate it again inside it.
    if selected()?.as_deref() != Some(project.as_str()) {
        return Err("记忆使用范围已变化，请重试本轮调查".into());
    }
    let mut service = BasicMemory::start_controlled(root, &backend::config(root)?, control)?;
    select(root, &project, query, &mut service).map(Some)
}
fn select(
    root: &Path,
    project: &str,
    query: &str,
    backend: &mut impl Backend,
) -> Result<Context, String> {
    let c = database(root)?;
    scope(&c, project)?;
    let epoch = c
        .query_row("SELECT value FROM memory_epoch WHERE id=1", [], |r| {
            r.get(0)
        })
        .map_err(|e| e.to_string())?;
    let mut result = Context {
        epoch,
        project_id: project.into(),
        rules: vec![],
        decisions: vec![],
        notice: None,
        omissions: json!({"notRetrieved":0,"budget":0}),
        items: vec![],
    };
    let mut stmt=c.prepare("SELECT id FROM memory_entries WHERE state='active' AND (project_id='' OR project_id=?1) ORDER BY id").map_err(|e|e.to_string())?;
    let ids = stmt
        .query_map([project], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut allowed = std::collections::HashMap::new();
    for id in ids {
        let item = load(&c, &id)?;
        let content = body(root, &item)?;
        let value = json!({"id":item.id,"version":item.version,"title":item.title,"body":content,"origin":"explicitUser"});
        if item.kind == "rule" {
            result.rules.push(value);
            if serde_json::to_vec(&result.rules).unwrap().len() > 2000 {
                return Err("共享规则超过预算，请整理规则或缩小项目范围".into());
            }
            result.items.push(item);
        } else {
            allowed.insert(item.revision_id.clone(), (item, value));
        }
    }
    if !allowed.is_empty() {
        let allowed_ids: Vec<_> = allowed.keys().cloned().collect();
        let candidates = backend.search(query, &allowed_ids)?;
        // Retrieval is candidate selection, never a claim that the memory
        // answers the question. The model must check its actual applicability.
        for revision in candidates {
            let Some((item, value)) = allowed.remove(&revision) else {
                continue;
            };
            if result.decisions.len() == 5 {
                result.omissions["budget"] =
                    json!(result.omissions["budget"].as_u64().unwrap() + 1);
                continue;
            }
            result.decisions.push(value);
            if serde_json::to_vec(&result.decisions).unwrap().len() > 2000 {
                result.decisions.pop();
                result.omissions["budget"] =
                    json!(result.omissions["budget"].as_u64().unwrap() + 1);
                continue;
            }
            result.items.push(item);
        }
    }
    result.omissions["notRetrieved"] = json!(allowed.len());
    if serde_json::to_vec(&result).unwrap().len() > 4000 {
        return Err("共享上下文超过总预算，请缩小范围或精简记忆".into());
    }
    verify(root, &result)?;
    Ok(result)
}
/// Historical memory-derived prose cannot reintroduce replaced/withdrawn decisions.
pub(crate) fn historical_use_valid(
    root: &Path,
    c: &Connection,
    work: &str,
    run: &str,
) -> Result<bool, String> {
    let raw:Option<String>=c.query_row("SELECT body_json FROM agent_records WHERE work_id=?1 AND run_id=?2 AND kind='sharedMemoryUse' ORDER BY rowid DESC LIMIT 1",params![work,run],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    let Some(raw) = raw else { return Ok(true) };
    let audit: Value = serde_json::from_str(&raw).map_err(|_| "历史记忆使用记录损坏")?;
    let items = audit["items"].as_array().ok_or("历史记忆使用记录缺失")?;
    if items.is_empty() {
        return Ok(true);
    }
    let selected: Option<String> = c
        .query_row(
            "SELECT project_id FROM memory_work_scopes WHERE work_id=?1 AND enabled=1",
            [work],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if selected.as_deref() != audit["projectId"].as_str() {
        return Ok(false);
    }
    for used in items {
        let Some(id) = used["id"].as_str() else {
            return Ok(false);
        };
        let item = load(c, id)?;
        if item.state != "active"
            || Some(item.version) != used["version"].as_i64()
            || body(root, &item).is_err()
        {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(crate) fn verify(root: &Path, context: &Context) -> Result<(), String> {
    let c = database(root)?;
    let epoch: i64 = c
        .query_row("SELECT value FROM memory_epoch WHERE id=1", [], |r| {
            r.get(0)
        })
        .map_err(|e| e.to_string())?;
    if epoch != context.epoch {
        return Err("共享记忆已变化，已停止使用旧上下文；请继续新一轮".into());
    }
    for item in &context.items {
        let current = load(&c, &item.id)?;
        if current.state != "active"
            || current.version != item.version
            || (!current.project_id.is_empty() && current.project_id != context.project_id)
        {
            return Err("共享记忆资格已变化".into());
        }
        body(root, &current)?;
    }
    Ok(())
}
pub(crate) fn with_current<T>(
    root: &Path,
    context: Option<&Context>,
    publish: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    if context.is_none() {
        return publish();
    }
    let _guard = lock()
        .try_lock()
        .map_err(|_| "记忆正在更新，已保存进展，请稍后继续")?;
    if let Some(context) = context {
        verify(root, context)?;
    }
    publish()
}
/// Restoring an old backup cannot silently grant eligibility to historical
/// memories or enable them for a new machine. Explicit confirmation is required.
pub(crate) fn quarantine_restored(c: &Connection) -> Result<(), String> {
    let exists:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='memory_entries' AND type='table')",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    if exists {
        c.execute_batch(
            "UPDATE memory_work_scopes SET enabled=0;
            UPDATE memory_entries SET state='review' WHERE state NOT IN ('forgotten','deleting');
            UPDATE memory_epoch SET value=value+1 WHERE id=1;",
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn shared_memory(app: tauri::AppHandle, args: Value) -> Result<Value, String> {
    let root = crate::active_data_root(&app)?;
    tokio::task::spawn_blocking(move || ui(&root, &args))
        .await
        .map_err(|_| "记忆操作中断".to_string())?
}
