//! Immutable skill bytes and adoption events travel separately from device-local sources.
use super::*;
use crate::reading_sync::object_store::{self, Store};
use std::collections::BTreeSet;

pub(crate) static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const PREFIX: &str = "skills/v1/";
const MAX_EVENTS: usize = 4096;
const MAX_EVENT_BYTES: usize = 8192;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Event {
    package: String,
    device: String,
    name: String,
    parents: Vec<String>,
    // Deletion is terminal for this package identity. An explicit reimport gets a new identity.
    version: Option<String>,
    #[serde(default)]
    paused: bool,
}

pub(super) fn migrate(c: &Connection) -> Result<(), rusqlite::Error> {
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_skill_sync_cursor (
        namespace TEXT NOT NULL, package TEXT NOT NULL, revision INTEGER NOT NULL,
        heads_json TEXT NOT NULL, PRIMARY KEY(namespace,package));
        CREATE TABLE IF NOT EXISTS agent_skill_sync_tombstones (
        package TEXT PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS agent_skill_sync_conflicts (
        package TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS agent_skill_package_paused (
        package TEXT PRIMARY KEY);",
    )
}

fn sha(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn token(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn checked(event: &Event) -> Result<(), String> {
    if !event.package.starts_with("package-")
        || !token(&event.package, 100)
        || !token(&event.device, 100)
        || !token(&event.name, 64)
        || event.parents.len() > 32
        || event.parents.iter().any(|id| !sha(id))
        || !event.parents.windows(2).all(|pair| pair[0] < pair[1])
        || event
            .version
            .as_ref()
            .is_some_and(|v| !v.strip_prefix("method-").is_some_and(sha))
    {
        return Err("技能同步事件身份无效".into());
    }
    Ok(())
}

async fn events(remote: &dyn Store) -> Result<BTreeMap<String, Event>, String> {
    let relative = format!("{PREFIX}events/");
    let prefix = remote.key(&relative);
    let mut all = BTreeMap::new();
    let mut next = None;
    let mut seen = HashSet::new();
    loop {
        remote.check_network(&prefix)?;
        let page = remote.inventory_page(&relative, next.as_deref()).await?;
        for key in page.keys {
            let id = key
                .strip_prefix(&prefix)
                .filter(|id| sha(id))
                .ok_or("技能云事件路径无效")?;
            if all.contains_key(id) {
                continue;
            }
            if all.len() >= MAX_EVENTS {
                return Err("技能云事件超过保留上限".into());
            }
            let bytes = remote
                .get(&key, MAX_EVENT_BYTES)
                .await?
                .ok_or("技能云事件暂不可读取")?;
            let event: Event = serde_json::from_slice(&bytes).map_err(|_| "技能云事件格式无效")?;
            checked(&event)?;
            if format!("{:x}", Sha256::digest(&bytes)) != id {
                return Err("技能云事件校验失败".into());
            }
            all.insert(id.to_owned(), event);
        }
        next = page.next;
        match &next {
            Some(cursor) if seen.insert(cursor.clone()) => (),
            Some(_) => return Err("技能云列表分页游标重复".into()),
            None => break,
        }
    }
    for event in all.values() {
        if event.parents.iter().any(|parent| {
            all.get(parent)
                .is_none_or(|p| p.package != event.package || p.name != event.name)
        }) {
            return Err("技能云事件的前序记录缺失或身份不一致，请重试".into());
        }
    }
    Ok(all)
}

fn heads(all: &BTreeMap<String, Event>) -> BTreeMap<String, Vec<String>> {
    let parent_ids: HashSet<_> = all.values().flat_map(|event| &event.parents).collect();
    let mut groups = BTreeMap::<String, Vec<String>>::new();
    for (id, event) in all {
        if !parent_ids.contains(id) || event.version.is_none() {
            groups
                .entry(event.package.clone())
                .or_default()
                .push(id.clone());
        }
    }
    groups
}

fn local(c: &Connection) -> Result<Vec<(String, i64, String, String, String)>, String> {
    let mut q = c.prepare("SELECT package_id,revision,name,mode,method_version FROM agent_skill_source_revisions r
        WHERE NOT EXISTS(SELECT 1 FROM agent_skill_source_revisions n WHERE n.package_id=r.package_id AND n.revision>r.revision) ORDER BY package_id LIMIT 4097").map_err(|e| e.to_string())?;
    let rows = q
        .query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    if rows.len() > MAX_EVENTS {
        return Err("本地方法同步记录超限".into());
    }
    Ok(rows)
}

fn cursor(
    c: &Connection,
    namespace: &str,
    package: &str,
) -> Result<Option<(i64, Vec<String>)>, String> {
    let raw: Option<(i64,String)> = c.query_row(
        "SELECT revision,heads_json FROM agent_skill_sync_cursor WHERE namespace=?1 AND package=?2",
        params![namespace,package], |r| Ok((r.get(0)?,r.get(1)?)))
        .optional().map_err(|e| e.to_string())?;
    raw.map(|(rev, raw)| {
        Ok((
            rev,
            serde_json::from_str(&raw).map_err(|_| "技能同步进度损坏")?,
        ))
    })
    .transpose()
}

fn set_cursor(
    c: &Connection,
    namespace: &str,
    package: &str,
    rev: i64,
    heads: &[String],
) -> Result<(), String> {
    c.execute("INSERT INTO agent_skill_sync_cursor VALUES(?1,?2,?3,?4)
        ON CONFLICT(namespace,package) DO UPDATE SET revision=excluded.revision,heads_json=excluded.heads_json",
        params![namespace, package, rev, json!(heads).to_string()]).map_err(|e| e.to_string())?;
    Ok(())
}

fn is_deleted(c: &Connection, package: &str) -> Result<bool, String> {
    c.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_skill_sync_tombstones WHERE package=?1)",
        [package],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

pub(super) fn paused(c: &Connection, package: &str) -> Result<bool, String> {
    c.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_skill_package_paused WHERE package=?1)",
        [package],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

fn set_paused(c: &Connection, package: &str, value: bool) -> Result<(), String> {
    c.execute(
        if value {
            "INSERT OR IGNORE INTO agent_skill_package_paused VALUES(?1)"
        } else {
            "DELETE FROM agent_skill_package_paused WHERE package=?1"
        },
        [package],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub(super) fn change_pause(root: &Path, args: &Value) -> Result<Value, String> {
    let id = text(args, "packageId", 100)?;
    let pause = args["paused"].as_bool().ok_or("停用设置无效")?;
    store::write(root, |c| {
        let current = source(c, &id)?;
        expected(args, &current)?;
        if paused(c, &id)? != pause {
            let version = current["methodVersion"]
                .as_str()
                .ok_or("固定方法身份缺失")?;
            let value = super::super::super::topics::method_on(c, version)?;
            accept(c, &id, &value)?;
            set_paused(c, &id, pause)?;
        }
        Ok(())
    })?;
    detail(root, &id, None)
}

pub(super) fn candidates(c: &Connection, package: Option<&str>) -> Result<Vec<Value>, String> {
    let mut q = c
        .prepare(
            "SELECT body FROM agent_skill_sync_conflicts
        WHERE (?1 IS NULL OR package=?1) ORDER BY package LIMIT 33",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = q.query([package]).map_err(|e| e.to_string())?;
    let mut values = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let raw: String = row.get(0).map_err(|e| e.to_string())?;
        values.push(serde_json::from_str(&raw).map_err(|_| "候选技能记录损坏")?);
    }
    Ok(values)
}

fn accept(c: &Connection, package: &str, value: &Value) -> Result<i64, String> {
    let name = value["content"]["name"]
        .as_str()
        .ok_or("固定技能名称缺失")?;
    let all = local(c)?;
    let current = all.iter().find(|row| row.0 == package);
    if current.is_some_and(|row| row.3 == "deleted")
        || is_deleted(c, package)?
        || all
            .iter()
            .any(|row| row.0 != package && row.2 == name && row.3 != "deleted")
        || BUILTINS
            .iter()
            .any(|doc| parse(doc, "", None).is_ok_and(|skill| skill.name == name))
    {
        return Err(format!("技能已删除或存在同名冲突，保留本机版本：{name}"));
    }
    if current.is_none() && all.iter().filter(|row| row.3 != "deleted").count() >= 32 {
        return Err("本地技能包已达32个，保留现有版本".into());
    }
    let revision = current.map_or(1, |row| row.1 + 1);
    if revision > 32 {
        return Err("本地技能包修订已达32版".into());
    }
    let key = format!("oss-{}", crate::random_url_safe(18));
    let source = current.map(|_| source(c, package)).transpose()?;
    let mode = source
        .as_ref()
        .and_then(|v| v["mode"].as_str())
        .unwrap_or("sync");
    let directory = source
        .as_ref()
        .and_then(|v| v["directory"].as_str())
        .unwrap_or("");
    save_version(c, value, directory.len() + name.len() + key.len() + 512)?;
    c.execute(
        "INSERT INTO agent_skill_source_revisions VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?8,?9)",
        params![
            package,
            revision,
            name,
            directory,
            mode,
            value["id"].as_str().unwrap(),
            value["content"]["sourceFingerprint"].as_str().unwrap(),
            key,
            store::stamp()
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(revision)
}

pub(super) fn adopt_candidate(root: &Path, args: &Value) -> Result<Value, String> {
    let package = text(args, "packageId", 100)?;
    let version = text(args, "methodVersion", 100)?;
    store::write(root, |c| {
        let item = candidates(c, Some(&package))?
            .pop()
            .ok_or("候选版本已变化，请刷新")?;
        let pause = args["paused"].as_bool().ok_or("候选状态无效")?;
        if item["fingerprint"] != args["expectedFingerprint"]
            || !item["candidates"].as_array().is_some_and(|list| {
                list.iter()
                    .any(|v| v["version"] == version && v["paused"] == pause)
            })
        {
            return Err("候选版本已变化，请刷新".into());
        }
        let value = super::super::super::topics::method_on(c, &version)?;
        let skill = validate(&value)?;
        if value["content"]["packageId"] != package
            || !skill.unavailable.is_empty()
            || !versions::compatible_contract(&value["content"]["toolContractVersion"])
        {
            return Err("候选版本在本机暂不可采用".into());
        }
        accept(c, &package, &value)?;
        set_paused(c, &package, pause)?;
        c.execute(
            "DELETE FROM agent_skill_sync_conflicts WHERE package=?1",
            [&package],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })?;
    detail(root, &package, None)
}

async fn push_version(remote: &dyn Store, version: &Value) -> Result<(), String> {
    let files = version["content"]["files"]
        .as_object()
        .ok_or("固定技能清单缺失")?;
    let mut manifest = version.clone();
    let entries = manifest["content"]["files"].as_object_mut().unwrap();
    for (path, file) in files {
        let bytes = inspection::decode(file)?;
        let digest = file["sha256"].as_str().ok_or("文件指纹缺失")?;
        remote
            .put_verified(&remote.key(&format!("{PREFIX}files/{digest}")), &bytes)
            .await?;
        entries
            .get_mut(path)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove("content");
    }
    let id = version["id"].as_str().ok_or("方法版本缺失")?;
    remote
        .put_verified(
            &remote.key(&format!("{PREFIX}versions/{id}")),
            manifest.to_string().as_bytes(),
        )
        .await?;
    Ok(())
}

async fn pull_version(remote: &dyn Store, event: &Event, id: &str) -> Result<Value, String> {
    let raw = remote
        .get(
            &remote.key(&format!("{PREFIX}versions/{id}")),
            MAX_VERSION_BYTES,
        )
        .await?
        .ok_or("云端缺少技能版本清单")?;
    let mut value: Value = serde_json::from_slice(&raw).map_err(|_| "云端技能版本清单无效")?;
    if value["id"] != id
        || value["content"]["packageId"] != event.package
        || value["content"]["name"] != event.name
    {
        return Err("云端技能清单身份不符".into());
    }
    let files = value["content"]["files"]
        .as_object_mut()
        .filter(|m| !m.is_empty() && m.len() <= 33)
        .ok_or("云端技能清单文件数无效")?;
    let mut remaining = inspection::MAX_BYTES;
    for entry in files.values_mut() {
        let digest = entry["sha256"]
            .as_str()
            .filter(|s| sha(s))
            .ok_or("云端技能文件指纹无效")?;
        let size = entry["bytes"]
            .as_u64()
            .filter(|n| *n <= remaining as u64)
            .ok_or("云端技能包超限")? as usize;
        let bytes = remote
            .get(&remote.key(&format!("{PREFIX}files/{digest}")), size.max(1))
            .await?
            .ok_or("云端技能配套文件缺失")?;
        if bytes.len() != size || format!("{:x}", Sha256::digest(&bytes)) != digest {
            return Err("云端技能配套文件校验失败".into());
        }
        remaining -= size;
        entry["content"] = match entry["encoding"].as_str() {
            Some("utf8") => json!(String::from_utf8(bytes).map_err(|_| "云端技能文字编码无效")?),
            Some("base64") => {
                use base64::{engine::general_purpose::STANDARD, Engine};
                json!(STANDARD.encode(bytes))
            }
            _ => return Err("云端技能文件编码无效".into()),
        };
    }
    validate(&value)?;
    Ok(value)
}

async fn sync(
    root: &Path,
    remote: &dyn Store,
    namespace: &str,
    device: &str,
) -> Result<Value, String> {
    let mut all = events(remote).await?;
    let rows = local(&crate::source_evidence::open_read_database(root)?)?;
    let mut uploaded = 0;
    for (package, revision, name, mode, method) in &rows {
        let (known, value, paused) = {
            let c = crate::source_evidence::open_read_database(root)?;
            if !local(&c)?.iter().any(|row| {
                &row.0 == package && row.1 == *revision && &row.3 == mode && &row.4 == method
            }) {
                continue;
            }
            let known = cursor(&c, namespace, package)?;
            if is_deleted(&c, package)?
                || (mode != "deleted" && known.as_ref().is_some_and(|(r, _)| *r == *revision))
                || all
                    .values()
                    .any(|event| event.package == *package && event.version.is_none())
            {
                continue;
            }
            let value = if mode == "deleted" {
                None
            } else {
                Some(super::super::super::topics::method_on(&c, method)?)
            };
            (known, value, paused(&c, package)?)
        };
        let event = Event {
            package: package.clone(),
            device: device.into(),
            name: name.clone(),
            parents: known.map(|(_, h)| h).unwrap_or_default(),
            version: value.as_ref().map(|_| method.clone()),
            paused,
        };
        checked(&event)?;
        let raw = serde_json::to_string(&event).map_err(|e| e.to_string())?;
        let id = hash(&raw);
        if !all.contains_key(&id) {
            if all.len() >= MAX_EVENTS {
                return Err("技能云事件超过保留上限".into());
            }
            if let Some(version) = value {
                push_version(remote, &version).await?
            }
            remote
                .put_verified(&remote.key(&format!("{PREFIX}events/{id}")), raw.as_bytes())
                .await?;
            all.insert(id.clone(), event);
            uploaded += 1;
        }
        store::write(root, |c| {
            set_cursor(c, namespace, package, *revision, &[id])
        })?;
    }

    let mut received = 0;
    let mut conflicts = Vec::new();
    for (package, ids) in heads(&all) {
        let local_before = rows.iter().find(|row| row.0 == package);
        if let Some(deleted) = ids
            .iter()
            .map(|id| &all[id])
            .find(|event| event.version.is_none())
        {
            store::write(root, |c| {
                if local(c)?.iter().any(|r| r.0 == package && r.3 != "deleted") {
                    maintenance::delete_synced(c, &package)?;
                }
                c.execute(
                    "INSERT OR IGNORE INTO agent_skill_sync_tombstones VALUES(?1,?2)",
                    params![package, deleted.name],
                )
                .map_err(|e| e.to_string())?;
                c.execute(
                    "DELETE FROM agent_skill_sync_conflicts WHERE package=?1",
                    [&package],
                )
                .map_err(|e| e.to_string())?;
                Ok(())
            })?;
            continue;
        }
        if local_before.is_some_and(|r| r.3 == "deleted") {
            continue;
        }
        let versions: BTreeSet<_> = ids
            .iter()
            .filter_map(|id| all[id].version.clone())
            .collect();
        let active_states: BTreeSet<_> = ids
            .iter()
            .map(|id| (&all[id].version, all[id].paused))
            .collect();
        let conflict = (active_states.len()>1).then(|| json!({"packageId":package,"name":all[&ids[0]].name,
            "fingerprint":hash(&json!(ids).to_string()),
            "candidates":ids.iter().map(|id|json!({"version":all[id].version,"device":all[id].device,"paused":all[id].paused})).collect::<Vec<_>>()}));
        let mut values = Vec::new();
        for id in &versions {
            let cached = {
                let c = crate::source_evidence::open_read_database(root)?;
                if is_deleted(&c, &package)? {
                    break;
                }
                super::super::super::topics::method_on(&c, id).ok()
            };
            let event = ids
                .iter()
                .map(|id| &all[id])
                .find(|e| e.version.as_deref() == Some(id))
                .unwrap();
            let value = match cached {
                Some(value) => value,
                None => pull_version(remote, event, id).await?,
            };
            validate(&value)?;
            if value["content"]["packageId"] != package || value["content"]["name"] != event.name {
                return Err("云端事件与技能包身份不一致".into());
            }
            values.push(value);
        }
        if values.len() != versions.len() {
            continue;
        }
        received += store::write(root, |c| {
            let rows = local(c)?;
            let now = rows.iter().find(|r| r.0 == package);
            if is_deleted(c, &package)?
                || now != local_before
                || now.is_some_and(|r| r.3 == "deleted")
            {
                return Ok(0);
            }
            for value in &values {
                save_version(c, value, 0)?;
            }
            let mut revision = now.map(|r| r.1).unwrap_or_default();
            if let Some(conflict) = &conflict {
                c.execute(
                    "INSERT INTO agent_skill_sync_conflicts VALUES(?1,?2)
                    ON CONFLICT(package) DO UPDATE SET body=excluded.body",
                    params![package, conflict.to_string()],
                )
                .map_err(|e| e.to_string())?;
            } else {
                let value = &values[0];
                let method = value["id"].as_str().unwrap();
                let pause = all[&ids[0]].paused;
                if now.is_none_or(|r| r.4 != method) || paused(c, &package)? != pause {
                    revision = accept(c, &package, value)?;
                    set_paused(c, &package, pause)?;
                }
                c.execute(
                    "DELETE FROM agent_skill_sync_conflicts WHERE package=?1",
                    [&package],
                )
                .map_err(|e| e.to_string())?;
            }

            set_cursor(c, namespace, &package, revision, &ids)?;
            Ok(usize::from(now.map_or(0, |r| r.1) != revision))
        })?;
        if let Some(conflict) = conflict {
            conflicts.push(conflict);
        }
    }
    Ok(json!({"uploaded":uploaded,"received":received,"conflicts":conflicts}))
}

pub(crate) async fn sync_agent_skills(app: tauri::AppHandle) -> Result<Value, String> {
    let _lock = LOCK.lock().await;
    let root = crate::active_data_root(&app)?;
    let (remote, namespace, device) = {
        let (c, _writer) =
            crate::database::open_write_database(&root.join("craft-search.sqlite3"))?;
        let policy = crate::cloud_sync::policy(&c);
        if !policy.enabled || !policy.skills {
            return Err("本机技能云同步已暂停".into());
        }
        let config = object_store::configuration(&c)?;
        (
            object_store::configured_module_store(&app, &c, &config, None, "skills/")?,
            config.namespace(),
            crate::flashcard_snapshot::flashcard_sync_device_id(&c)?,
        )
    };
    sync(&root, remote.as_ref(), &namespace, &device).await
}

pub(crate) fn cloud_skill_versions(root: &Path) -> Result<Value, String> {
    let catalog = Catalog::discover(root)?;
    Ok(json!(catalog
        .skills
        .values()
        .filter(|s| s.package.is_some() && s.unavailable.is_empty() && s.required.is_empty())
        .map(|s| {
            let mut metadata = s.metadata();
            metadata["paths"] = json!(resource_paths(&catalog.registered[&s.name]));
            metadata
        })
        .collect::<Vec<_>>()))
}

pub(crate) fn cloud_skill_payload(
    root: &Path,
    version: &str,
    chosen: &[String],
) -> Result<Value, String> {
    if chosen.len() > 32 || chosen.iter().any(|path| !inspection::text_resource(path)) {
        return Err("云端技能资源选择无效".into());
    }
    let c = crate::source_evidence::open_read_database(root)?;
    let value = super::super::super::topics::method_on(&c, version)?;
    let skill = validate(&value)?;
    let package = value["content"]["packageId"]
        .as_str()
        .ok_or("技能包身份缺失")?;
    source(&c, package)?;
    if paused(&c, package)?
        || !skill.unavailable.is_empty()
        || !skill.required.is_empty()
        || !versions::compatible_contract(&value["content"]["toolContractVersion"])
    {
        return Err("VPS 只支持不依赖 Hub 工具或脚本的文字技能".into());
    }
    if skill.instructions.len() > MAX_REFERENCE {
        return Err("VPS 技能正文最多 32 KiB".into());
    }
    let mut files = BTreeMap::new();
    files.insert(
        "SKILL.md",
        json!({"text":skill.instructions,"sha256":hash(&skill.instructions)}),
    );
    let available = resource_paths(&value);
    for rest in skill.instructions.split("](").skip(1) {
        if let Some((destination, _)) = rest.split_once(')') {
            let path = destination
                .trim_matches(['<', '>'])
                .split(['#', ' '])
                .next()
                .unwrap_or_default();
            if available.iter().any(|item| item == path) && !chosen.iter().any(|item| item == path)
            {
                return Err(format!("请选入技能正文引用的配套文件：{path}"));
            }
        }
    }
    for path in available.iter().filter(|path| chosen.contains(path)) {
        let content = read_resource(&value, path)?;
        files.insert(path, json!({"sha256":hash(&content),"text":content}));
    }
    if chosen.len() + 1 != files.len() {
        return Err("选中的技能文件缺失、重复或不可读".into());
    }
    let size: usize = files
        .values()
        .filter_map(|file| file["text"].as_str())
        .map(str::len)
        .sum();
    if size > 48 * 1024 {
        return Err("一次发送的 VPS 技能正文和参考文字合计最多 48 KiB".into());
    }
    let mut manifest = format!("{version}\n{}\n", skill.name);
    for (path, file) in &files {
        manifest.push_str(&format!("{path}\n{}\n", file["sha256"].as_str().unwrap()));
    }
    Ok(json!({"version":version,"name":skill.name,"files":files,"manifestSha256":hash(&manifest)}))
}

#[cfg(all(test, target_os = "windows"))]
mod real_source_probe;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::obsidian_edit::tests::Fixture;
    use crate::reading_sync::object_store::InventoryPage;
    use futures::future::BoxFuture;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    };

    #[derive(Default)]
    struct Objects {
        bytes: Mutex<BTreeMap<String, Vec<u8>>>,
        offline: AtomicBool,
    }

    impl Store for Objects {
        fn key(&self, relative: &str) -> String {
            format!("test/v2/{relative}")
        }
        fn check_network(&self, _: &str) -> Result<(), String> {
            if self.offline.load(Ordering::Relaxed) {
                Err("offline".into())
            } else {
                Ok(())
            }
        }
        fn head_size<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<Option<u64>, String>> {
            Box::pin(async move { Ok(self.bytes.lock().unwrap().get(key).map(|v| v.len() as u64)) })
        }
        fn get<'a>(
            &'a self,
            key: &'a str,
            max: usize,
        ) -> BoxFuture<'a, Result<Option<Vec<u8>>, String>> {
            Box::pin(async move {
                self.check_network(key)?;
                let value = self.bytes.lock().unwrap().get(key).cloned();
                if value.as_ref().is_some_and(|v| v.len() > max) {
                    return Err("oversized object".into());
                }
                Ok(value)
            })
        }
        fn inventory_page<'a>(
            &'a self,
            relative: &'a str,
            _: Option<&'a str>,
        ) -> BoxFuture<'a, Result<InventoryPage, String>> {
            Box::pin(async move {
                Ok(InventoryPage {
                    keys: self.list(relative).await?,
                    ..Default::default()
                })
            })
        }
        fn list<'a>(&'a self, relative: &'a str) -> BoxFuture<'a, Result<Vec<String>, String>> {
            Box::pin(async move {
                let prefix = self.key(relative);
                self.check_network(&prefix)?;
                Ok(self
                    .bytes
                    .lock()
                    .unwrap()
                    .keys()
                    .filter(|key| key.starts_with(&prefix))
                    .cloned()
                    .collect())
            })
        }
        fn put_verified<'a>(
            &'a self,
            key: &'a str,
            bytes: &'a [u8],
        ) -> BoxFuture<'a, Result<bool, String>> {
            Box::pin(async move {
                self.check_network(key)?;
                let mut all = self.bytes.lock().unwrap();
                match all.get(key) {
                    Some(old) if old == bytes => Ok(false),
                    Some(_) => Err("object differs".into()),
                    None => {
                        all.insert(key.into(), bytes.to_vec());
                        Ok(true)
                    }
                }
            })
        }
        fn delete_exact<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<(), String>> {
            Box::pin(async { Err("immutable test storage".into()) })
        }
    }

    #[tokio::test]
    async fn skill_distribution_retries_and_preserves_conflicting_versions_until_adopted() {
        let a = Fixture::new();
        let b = Fixture::new();
        let remote = Objects::default();
        let path = a.root.join("example");
        std::fs::create_dir_all(path.join("references")).unwrap();
        std::fs::write(
            path.join("SKILL.md"),
            "---\nname: example\ndescription: 示例流程\n---\n请读[规则](references/rules.md)。\n",
        )
        .unwrap();
        std::fs::write(path.join("references/rules.md"), "原规则").unwrap();
        let preview = ui(
            &a.root,
            &json!({"action":"skillPackagePreview","directory":path}),
        )
        .unwrap();
        let first = ui(
            &a.root,
            &json!({"action":"skillPackageImport","directory":path,"mode":"source",
            "expectedFingerprint":preview["sourceFingerprint"],"clientRequestId":"initial"}),
        )
        .unwrap();
        let id = first["source"]["packageId"].as_str().unwrap();
        let version = first["methodVersion"].as_str().unwrap();
        sync(&a.root, &remote, "test", "device-a").await.unwrap();
        let received = sync(&b.root, &remote, "test", "device-b").await.unwrap();
        assert_eq!(received["received"], 1);
        let cached = source(&b.c(), id).unwrap();
        assert_eq!(cached["directory"], "");
        assert_eq!(cached["methodVersion"], version);
        assert_eq!(
            cloud_skill_payload(&a.root, version, &["references/rules.md".into()]).unwrap(),
            cloud_skill_payload(&b.root, version, &["references/rules.md".into()]).unwrap()
        );

        std::fs::write(path.join("references/rules.md"), "更新后的规则").unwrap();
        let checked = ui(
            &a.root,
            &json!({"action":"skillPackageCheck","packageId":id,"expectedRevision":1}),
        )
        .unwrap();
        let updated = ui(
            &a.root,
            &json!({"action":"skillPackageUpdate","packageId":id,"expectedRevision":1,
            "expectedFingerprint":checked["sourceFingerprint"],"clientRequestId":"update"}),
        )
        .unwrap();
        change_pause(
            &b.root,
            &json!({"packageId":id,"expectedRevision":1,"paused":true}),
        )
        .unwrap();
        remote.offline.store(true, Ordering::Relaxed);
        assert!(sync(&a.root, &remote, "test", "device-a").await.is_err());
        assert_eq!(source(&b.c(), id).unwrap()["methodVersion"], version);
        remote.offline.store(false, Ordering::Relaxed);
        sync(&a.root, &remote, "test", "device-a").await.unwrap();
        let changed_bytes = "更新后的规则".as_bytes();
        let changed_key = remote.key(&format!(
            "{PREFIX}files/{:x}",
            Sha256::digest(changed_bytes)
        ));
        remote
            .bytes
            .lock()
            .unwrap()
            .insert(changed_key.clone(), vec![0; changed_bytes.len()]);
        assert!(sync(&b.root, &remote, "test", "device-b").await.is_err());
        assert_eq!(source(&b.c(), id).unwrap()["methodVersion"], version);
        remote
            .bytes
            .lock()
            .unwrap()
            .insert(changed_key, changed_bytes.to_vec());
        let conflict = sync(&b.root, &remote, "test", "device-b").await.unwrap();
        assert_eq!(
            conflict["conflicts"][0]["candidates"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(source(&b.c(), id).unwrap()["methodVersion"], version);
        adopt_candidate(
            &b.root,
            &json!({"packageId":id,"methodVersion":updated["methodVersion"],"paused":false,
            "expectedFingerprint":conflict["conflicts"][0]["fingerprint"]}),
        )
        .unwrap();
        sync(&b.root, &remote, "test", "device-b").await.unwrap();
        sync(&a.root, &remote, "test", "device-a").await.unwrap();
        assert_eq!(
            source(&a.c(), id).unwrap()["methodVersion"],
            updated["methodVersion"]
        );
        assert!(!paused(&b.c(), id).unwrap());

        store::write(&a.root, |c| maintenance::delete_synced(c, id)).unwrap();
        sync(&a.root, &remote, "test", "device-a").await.unwrap();
        sync(&b.root, &remote, "test", "device-b").await.unwrap();
        assert!(is_deleted(&b.c(), id).unwrap());
        assert!(source(&b.c(), id).is_err());
        assert!(cloud_skill_payload(&b.root, version, &["references/rules.md".into()]).is_err());
        assert!(path.join("SKILL.md").exists());
    }

    #[tokio::test]
    #[ignore = "explicit real OSS integration in a unique test prefix"]
    async fn real_oss_skills_sync_two_independent_databases() {
        let a = Fixture::new();
        let b = Fixture::new();
        let (_, remote, namespace) = crate::reading_sync::real_cloud_tests::isolated_oss("skills");
        let path = a.root.join("example");
        std::fs::create_dir_all(path.join("references")).unwrap();
        std::fs::write(
            path.join("SKILL.md"),
            "---\nname: example\ndescription: 测试流程\n---\n请读[规则](references/rules.md)。\n",
        )
        .unwrap();
        std::fs::write(path.join("references/rules.md"), "真实传输的匿名规则").unwrap();
        let preview = ui(
            &a.root,
            &json!({"action":"skillPackagePreview","directory":path}),
        )
        .unwrap();
        let imported = ui(
            &a.root,
            &json!({"action":"skillPackageImport","directory":path,"mode":"source",
            "expectedFingerprint":preview["sourceFingerprint"],"clientRequestId":"real-oss"}),
        )
        .unwrap();
        sync(&a.root, &remote, &namespace, "windows-a")
            .await
            .expect("isolated OSS upload");
        sync(&b.root, &remote, &namespace, "windows-b")
            .await
            .expect("isolated OSS download");
        let version = imported["methodVersion"].as_str().unwrap();
        let paths = ["references/rules.md".into()];
        assert_eq!(
            cloud_skill_payload(&a.root, version, &paths).unwrap(),
            cloud_skill_payload(&b.root, version, &paths).unwrap()
        );
    }
}
