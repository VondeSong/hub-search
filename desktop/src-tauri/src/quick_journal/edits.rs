//! Versioned mutations supplement immutable captures; only the designated desktop edits OS.
use super::*;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Edit {
    version: u8,
    id: String,
    parent: String,
    before: Record,
    after: Record,
    before_deleted: bool,
    deleted: bool,
    created_at: i64,
}
pub(super) fn schema(c: &Connection) -> Result<(), String> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS quick_journal_edits(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,record_id TEXT NOT NULL,payload TEXT NOT NULL,namespace TEXT NOT NULL DEFAULT '',uploaded INTEGER NOT NULL DEFAULT 0,applied INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '');CREATE INDEX IF NOT EXISTS quick_journal_edits_record ON quick_journal_edits(record_id,seq);") .map_err(|e|e.to_string())
}
fn original(c: &Connection, id: &str) -> Result<Record, String> {
    let raw: String = c
        .query_row(
            "SELECT payload FROM quick_journal_records WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .map_err(|_| "记录暂不可用")?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}
fn revision(r: &Record) -> Result<String, String> {
    Ok(digest(&serde_json::to_vec(r).map_err(|e| e.to_string())?))
}
fn rows(c: &Connection, id: Option<&str>) -> Result<Vec<(Edit, bool, bool, String)>, String> {
    c.prepare("SELECT payload,uploaded,applied,error FROM quick_journal_edits WHERE (?1 IS NULL OR record_id=?1) ORDER BY seq").map_err(|e|e.to_string())?.query_map([id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,bool>(1)?,r.get::<_,bool>(2)?,r.get::<_,String>(3)?))).map_err(|e|e.to_string())?.map(|r|{let (p,u,a,e)=r.map_err(|e|e.to_string())?;Ok((serde_json::from_str(&p).map_err(|e|e.to_string())?,u,a,e))}).collect()
}
pub(super) fn projected(
    c: &Connection,
    r: &Record,
    applied_only: bool,
) -> Result<(Record, String, bool, Vec<Edit>), String> {
    let mut record = r.clone();
    let mut rev = revision(r)?;
    let mut deleted = false;
    let mut history = Vec::new();
    let all = rows(c, Some(&r.id))?;
    // Cloud inventories are ordered by operation ID, so replay dependencies rather than timestamps.
    for _ in 0..all.len() {
        let Some((op, _, _, _)) = all.iter().find(|(op, _, a, e)| {
            e.is_empty()
                && (!applied_only || *a)
                && op.parent == rev
                && op.before == record
                && op.before_deleted == deleted
        }) else {
            break;
        };
        record = op.after.clone();
        rev = op.id.clone();
        deleted = op.deleted;
        history.push(op.clone());
    }
    Ok((record, rev, deleted, history))
}
fn validate(op: &Edit) -> Result<(), String> {
    op.before.validate()?;
    op.after.validate()?;
    if op.version != 1
        || !format::hex_id(&op.id, 32)
        || op.id == op.parent
        || !(format::hex_id(&op.parent, 32) || format::hex_id(&op.parent, 64))
        || op.before.id != op.after.id
        || op.created_at < 0
    {
        return Err("记录变更身份无效".into());
    }
    Ok(())
}
fn insert(c: &Connection, op: &Edit, ns: &str, uploaded: bool) -> Result<(), String> {
    validate(op)?;
    let _ = original(c, &op.before.id)?;
    let payload = serde_json::to_string(op).map_err(|e| e.to_string())?;
    let previous: Option<String> = c
        .query_row(
            "SELECT payload FROM quick_journal_edits WHERE id=?1",
            [&op.id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(previous) = previous {
        return if previous == payload {
            Ok(())
        } else {
            Err("变更 ID 已用于其他内容".into())
        };
    }
    c.execute("INSERT INTO quick_journal_edits(id,record_id,payload,namespace,uploaded) VALUES(?1,?2,?3,?4,?5)",params![op.id,op.before.id,payload,ns,uploaded]).map_err(|e|e.to_string())?;
    Ok(())
}
fn enqueue_edit(
    db: &PathBuf,
    id: &str,
    expected: &str,
    after: Record,
    deleted: bool,
) -> Result<Edit, String> {
    after.validate()?;
    let (mut c, _guard) = open_write_database(db)?;
    schema(&c)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let base = original(&tx, id)?;
    let (before, rev, before_deleted, _) = projected(&tx, &base, false)?;
    if expected != rev || after.id != id {
        return Err("原记录已变化，草稿保留，请核对最新内容后重试".into());
    }
    for a in &after.attachments {
        let bytes =
            fs::read(asset(db, &a.hash)?).map_err(|_| "附件不在本机，请先下载或重新添加")?;
        if bytes.len() != a.size || digest(&bytes) != a.hash {
            return Err("附件校验失败，草稿保留".into());
        }
    }
    let op = Edit {
        version: 1,
        id: digest(random_url_safe(32).as_bytes())[..32].to_string(),
        parent: rev,
        before,
        after,
        before_deleted,
        deleted,
        created_at: chrono::Utc::now().timestamp_millis(),
    };
    let bound: String = tx
        .query_row(
            "SELECT namespace FROM quick_journal_records WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    insert(&tx, &op, &bound, false)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(op)
}
#[tauri::command]
pub(crate) async fn update_quick_journal(
    app: AppHandle,
    id: String,
    expected_revision: String,
    record: Record,
    deleted: bool,
) -> Result<Value, String> {
    let _lock = LOCK.lock().await;
    let db = database_path(&app)?;
    let op = enqueue_edit(&db, &id, &expected_revision, record, deleted)?;
    let warning = schedule_mobile(&app).err();
    Ok(json!({"revision":op.id,"warning":warning}))
}
#[tauri::command]
pub(crate) fn quick_journal_history(app: AppHandle, id: String) -> Result<Value, String> {
    let (c, _guard) = open_write_database(&database_path(&app)?)?;
    schema(&c)?;
    history_value(&c, &id)
}
fn history_value(c: &Connection, id: &str) -> Result<Value, String> {
    let base = original(c, id)?;
    let (_, rev, _, ops) = projected(c, &base, false)?;
    let versions = std::iter::once(
        json!({"record":base,"revision":revision(&base)?,"createdAt":Value::Null,"deleted":false}),
    )
    .chain(ops.iter().map(
        |e| json!({"record":e.after,"revision":e.id,"createdAt":e.created_at,"deleted":e.deleted}),
    ))
    .collect::<Vec<_>>();
    // Failed remote writes remain recoverable even after the editor draft was committed locally.
    let conflicts = rows(c, Some(id))?
        .into_iter()
        .filter(|(_, _, _, error)| !error.is_empty())
        .map(|(op, _, _, error)| json!({"record":op.after,"revision":op.id,"createdAt":op.created_at,"deleted":op.deleted,"error":error}))
        .collect::<Vec<_>>();
    Ok(json!({"revision":rev,"versions":versions,"conflicts":conflicts}))
}
pub(super) fn decorate(c: &Connection, item: &mut Value) -> Result<(), String> {
    let original: Record =
        serde_json::from_value(item["record"].clone()).map_err(|e| e.to_string())?;
    let (r, rev, deleted, ops) = projected(c, &original, false)?;
    item["revision"] = json!(rev);
    item["deleted"] = json!(deleted);
    item["modifiedAt"] = ops
        .last()
        .map(|e| json!(e.created_at))
        .unwrap_or(Value::Null);
    if let Some(op) = ops.last() {
        item["record"] = json!(r);
        let state = rows(c, Some(&r.id))?
            .into_iter()
            .find(|(e, _, _, _)| e.id == op.id)
            .ok_or("变更记录不存在")?;
        item["uploaded"] = json!(state.1);
        item["applied"] = json!(state.2);
        if !state.2 || cfg!(mobile) {
            item["body"] = json!(r.text);
        }
    }
    let errors: Vec<String> = rows(c, Some(&r.id))?
        .into_iter()
        .filter_map(|(_, _, _, e)| (!e.is_empty()).then_some(e))
        .collect();
    if !errors.is_empty() {
        item["sourceError"] = json!(errors.join("；"));
    }
    Ok(())
}
pub(super) fn status(
    c: &Connection,
    r: &Record,
    uploaded: bool,
    applied: bool,
) -> Result<(bool, bool), String> {
    let (_, _, _, history) = projected(c, r, false)?;
    if let Some(op) = history.last() {
        let state = rows(c, Some(&r.id))?
            .into_iter()
            .find(|(e, _, _, _)| e.id == op.id)
            .ok_or("变更状态暂不可用")?;
        Ok((state.1, state.2))
    } else {
        Ok((uploaded, applied))
    }
}
fn body(r: &Record, deleted: bool) -> Result<String, String> {
    if deleted {
        Ok("<!-- hub-journal-deleted -->".into())
    } else {
        Ok(format::blocks(&r.markdown("_hub-assets"))?
            .into_iter()
            .next()
            .ok_or("记录区块无效")?
            .1)
    }
}
fn block_span(text: &str, id: &str) -> Result<Option<std::ops::Range<usize>>, String> {
    format::blocks(text)?;
    let mut begin = None;
    for (event, range) in pulldown_cmark::Parser::new(text).into_offset_iter() {
        if let pulldown_cmark::Event::Html(html) = event {
            if html.trim() == format!("<!-- hub-journal:v1 begin {id} -->") {
                begin = Some(range.start);
            }
            if html.trim() == format!("<!-- hub-journal:v1 end {id} -->") {
                return Ok(begin.map(|start| start..range.end));
            }
        }
    }
    Ok(None)
}
fn normalize(s: &str) -> String {
    s.replace("\r\n", "\n").trim().to_string()
}
fn replace_block(path: &Path, id: &str, expected: &str, next: &str) -> Result<(), String> {
    let before = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let span = block_span(&before, id)?.ok_or("原记录区块已移除，未覆盖 OS 原文")?;
    let found = format::blocks(&before)?
        .into_iter()
        .find(|(i, _)| i == id)
        .ok_or("原记录区块不可用")?
        .1;
    if normalize(&found) != normalize(expected) {
        return Err("CONFLICT:OS 正文已被修改，未覆盖原文；请核对草稿和电脑原文".into());
    }
    let next = if before.contains("\r\n") {
        next.replace('\n', "\r\n")
    } else {
        next.to_string()
    };
    let after = format!("{}{}{}", &before[..span.start], next, &before[span.end..]);
    replace_diary(path, Some(&before), &after)
}
fn checked_source(c: &Connection, id: &str) -> Result<(String, PathBuf), String> {
    let (library, path): (String, String) = c
        .query_row(
            "SELECT library_id,path FROM quick_journal_records WHERE id=?1 AND applied=1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| "等待原记录写入 OS")?;
    let vault: String = c
        .query_row(
            "SELECT location FROM libraries WHERE id=?1 AND provider='obsidian' AND enabled=1",
            [&library],
            |r| r.get(0),
        )
        .map_err(|_| "原资料库暂不可用")?;
    let path = PathBuf::from(path);
    let root = fs::canonicalize(vault).map_err(|e| e.to_string())?;
    if !fs::canonicalize(path.parent().ok_or("日记目录无效")?)
        .map_err(|e| e.to_string())?
        .starts_with(root)
        || fs::symlink_metadata(&path)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
    {
        return Err("日记路径不在原资料库内".into());
    }
    Ok((library, path))
}
fn apply_one(db: &PathBuf, op: &Edit) -> Result<(), String> {
    let c = open_database(db)?;
    let (library, source) = checked_source(&c, &op.before.id)?;
    let mut s = settings(&c)?;
    s.library_id = library;
    let target = if op.before.date == op.after.date {
        source.clone()
    } else {
        target(&c, &s, &op.after.date)?.join(format!("{}.md", op.after.date))
    };
    let old_body = body(&op.before, op.before_deleted)?;
    let new_body = body(&op.after, op.deleted)?;
    let rendered = if op.deleted {
        format!(
            "<!-- hub-journal:v1 begin {} -->\n{}\n<!-- hub-journal:v1 end {} -->\n",
            op.after.id, new_body, op.after.id
        )
    } else {
        op.after.markdown("_hub-assets")
    };
    let read = |p: &Path| -> Result<Option<String>, String> {
        match fs::read_to_string(p) {
            Ok(t) => Ok(format::blocks(&t)?
                .into_iter()
                .find(|(i, _)| i == &op.after.id)
                .map(|(_, b)| b)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    };
    let current = read(&source)?;
    if source == target {
        if current.as_deref().map(normalize) == Some(normalize(&new_body)) {
            return Ok(());
        }
        replace_block(&source, &op.before.id, &old_body, &rendered)?;
    } else {
        let dest = read(&target)?;
        if dest
            .as_deref()
            .is_some_and(|b| normalize(b) != normalize(&new_body))
        {
            return Err("CONFLICT:目标日期已有同一记录的其他内容，原文保留".into());
        }
        if current
            .as_deref()
            .is_some_and(|b| normalize(b) != normalize(&old_body))
        {
            return Err("CONFLICT:原日期正文已变化，未移动或覆盖".into());
        }
        if current.is_none() && dest.is_none() {
            return Err("CONFLICT:原记录已移除，未重新创建".into());
        }
        if dest.is_none() {
            if op.deleted {
                return Err("请先恢复回收站记录再调整日期".into());
            }
            append(&target, &op.after)?;
        }
        // A completed destination is verified before removing the old block; interruption retries are idempotent.
        if current.is_some() {
            replace_block(&source, &op.before.id, &old_body, "")?;
        }
    }
    let (c, _guard) = open_write_database(db)?;
    c.execute(
        "UPDATE quick_journal_records SET path=?2 WHERE id=?1",
        params![op.before.id, target.to_string_lossy()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
async fn assets(db: &PathBuf, store: &dyn Store, op: &Edit, mobile: bool) -> Result<bool, String> {
    let rules = {
        let c = open_database(db)?;
        crate::cloud_sync::attachments::policy(&c, "quick")?
    };
    for a in &op.after.attachments {
        let path = asset(db, &a.hash)?;
        if mobile {
            if !rules.upload.allows(
                if a.image { "image/unknown" } else { "" },
                &a.name,
                a.size as u64,
            ) {
                return Ok(false);
            }
            let b = fs::read(&path).map_err(|_| "编辑附件不在本机")?;
            if b.len() != a.size || digest(&b) != a.hash {
                return Err("编辑附件校验失败".into());
            }
            store
                .put_verified(&store.key(&format!("journal/assets/{}", a.hash)), &b)
                .await?;
        } else if !path.is_file() {
            if !rules.download.allows(
                if a.image { "image/unknown" } else { "" },
                &a.name,
                a.size as u64,
            ) {
                return Ok(false);
            }
            let Some(b) = store
                .get(&store.key(&format!("journal/assets/{}", a.hash)), a.size)
                .await?
            else {
                return Ok(false);
            };
            if b.len() != a.size || digest(&b) != a.hash {
                return Err("编辑附件校验失败".into());
            }
            data_portability::atomic_write(&path, &b)?;
        }
        if !mobile {
            let c = open_database(db)?;
            let (lib, source) = checked_source(&c, &op.before.id)?;
            let mut s = settings(&c)?;
            s.library_id = lib;
            let dir = if op.before.date == op.after.date {
                source.parent().ok_or("日记目录无效")?.to_path_buf()
            } else {
                target(&c, &s, &op.after.date)?
            };
            fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let asset_dir = dir.join("_hub-assets");
            if asset_dir.exists()
                && !fs::canonicalize(&asset_dir)
                    .map_err(|e| e.to_string())?
                    .starts_with(fs::canonicalize(&dir).map_err(|e| e.to_string())?)
            {
                return Err("附件目录不能指向日记目录外".into());
            }
            let b = fs::read(&path).map_err(|e| e.to_string())?;
            if b.len() != a.size || digest(&b) != a.hash {
                return Err("编辑附件校验失败".into());
            }
            data_portability::atomic_write(&asset_dir.join(a.filename()), &b)?;
        }
    }
    Ok(true)
}
pub(super) async fn transfer(db: &PathBuf, store: &dyn Store, ns: &str) -> Result<(), String> {
    transfer_for(db, store, ns, cfg!(mobile)).await
}
async fn transfer_for(
    db: &PathBuf,
    store: &dyn Store,
    ns: &str,
    mobile: bool,
) -> Result<(), String> {
    let all = {
        let (c, _g) = open_write_database(db)?;
        schema(&c)?;
        rows(&c, None)?
    };
    for (op, uploaded, _, _) in all {
        let bound: String = open_database(db)?
            .query_row(
                "SELECT namespace FROM quick_journal_edits WHERE id=?1",
                [&op.id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !bound.is_empty() && bound != ns {
            continue;
        }
        let source_bound: String = open_database(db)?
            .query_row(
                "SELECT namespace FROM quick_journal_records WHERE id=?1",
                [&op.before.id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if source_bound != ns {
            continue;
        }
        if !uploaded {
            if !assets(db, store, &op, true).await? {
                continue;
            }
            store
                .put_verified(
                    &store.key(&format!("journal/edits/{}.json", op.id)),
                    &serde_json::to_vec(&op).map_err(|e| e.to_string())?,
                )
                .await?;
            let (c, _g) = open_write_database(db)?;
            c.execute(
                "UPDATE quick_journal_edits SET uploaded=1,namespace=?2 WHERE id=?1",
                params![op.id, ns],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    let mut continuation = None;
    loop {
        let page = store
            .inventory_page("journal/edits/", continuation.as_deref())
            .await?;
        for key in page.keys {
            let id = key
                .strip_prefix(&store.key("journal/edits/"))
                .and_then(|s| s.strip_suffix(".json"))
                .filter(|s| format::hex_id(s, 32))
                .ok_or("云端变更名称无效")?;
            let exists: bool = open_database(db)?
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM quick_journal_edits WHERE id=?1)",
                    [id],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            if exists {
                continue;
            }
            let bytes = store.get(&key, 500_000).await?.ok_or("变更暂不可用")?;
            let op: Edit = serde_json::from_slice(&bytes).map_err(|_| "云端变更格式无效")?;
            validate(&op)?;
            if op.id != id {
                return Err("云端变更身份不匹配".into());
            }
            let (c, _g) = open_write_database(db)?;
            let bound: Option<String> = c
                .query_row(
                    "SELECT namespace FROM quick_journal_records WHERE id=?1",
                    [&op.before.id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if bound.as_deref() != Some(ns) {
                continue;
            }
            insert(&c, &op, ns, true)?;
        }
        if page.next.is_none() {
            break;
        }
        if page.next == continuation {
            return Err("变更分页游标重复".into());
        }
        continuation = page.next;
    }
    if !mobile {
        let all = rows(&open_database(db)?, None)?;
        for _ in 0..=all.len() {
            let mut progress = false;
            for (op, _, _, _) in &all {
                let c = open_database(db)?;
                let (done,error):(bool,String)=c.query_row("SELECT applied,error FROM quick_journal_edits WHERE id=?1 AND namespace=?2",params![op.id,ns],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e|e.to_string())?.unwrap_or((true,String::new()));
                if done || !error.is_empty() {
                    continue;
                }
                let base = original(&c, &op.before.id)?;
                let (before, rev, deleted, accepted) = projected(&c, &base, true)?;
                if rev != op.parent || before != op.before || deleted != op.before_deleted {
                    let parent_failed = all.iter().any(|(parent, _, _, _)| parent.id == op.parent)
                        && c.query_row(
                            "SELECT error<>'' FROM quick_journal_edits WHERE id=?1",
                            [&op.parent],
                            |r| r.get::<_, bool>(0),
                        )
                        .optional()
                        .map_err(|e| e.to_string())?
                        .unwrap_or(false);
                    let stale = op.parent == revision(&base)?
                        || accepted.iter().any(|parent| parent.id == op.parent)
                        || rev == op.parent
                        || parent_failed;
                    if stale {
                        drop(c);
                        let (c, _g) = open_write_database(db)?;
                        c.execute("UPDATE quick_journal_edits SET error='CONFLICT:原记录版本已被其他变更更新，草稿保留，未覆盖 OS' WHERE id=?1",[&op.id]).map_err(|e|e.to_string())?;
                        progress = true;
                    }
                    continue;
                }
                drop(c);
                if !assets(db, store, op, false).await? {
                    continue;
                }
                let result = apply_one(db, op);
                let error = match result {
                    Ok(()) => String::new(),
                    Err(e) if e.starts_with("CONFLICT:") => e,
                    Err(e) => return Err(e),
                };
                let (c, _g) = open_write_database(db)?;
                c.execute(
                    "UPDATE quick_journal_edits SET applied=?2,error=?3 WHERE id=?1",
                    params![op.id, error.is_empty(), error],
                )
                .map_err(|e| e.to_string())?;
                progress = true;
            }
            if !progress {
                break;
            }
        }
    }
    for (op, _, applied, error) in rows(&open_database(db)?, None)? {
        let bound: String = open_database(db)?
            .query_row(
                "SELECT namespace FROM quick_journal_edits WHERE id=?1",
                [&op.id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if bound != ns {
            continue;
        }
        let key = store.key(&format!("journal/edit-receipts/{}.json", op.id));
        if !mobile && (applied || !error.is_empty()) {
            store
                .put_verified(
                    &key,
                    &serde_json::to_vec(
                        &json!({"version":1,"id":op.id,"hash":revision_bytes(&op)?,"error":error}),
                    )
                    .map_err(|e| e.to_string())?,
                )
                .await?;
        } else if mobile && !applied && error.is_empty() {
            if let Some(bytes) = store.get(&key, 8000).await? {
                let receipt: Value = serde_json::from_slice(&bytes).map_err(|_| "编辑回执无效")?;
                if receipt["version"] != 1
                    || receipt["id"] != op.id
                    || receipt["hash"] != revision_bytes(&op)?
                {
                    return Err("编辑回执校验失败".into());
                }
                let error = receipt["error"].as_str().ok_or("编辑回执缺少状态")?;
                let (c, _g) = open_write_database(db)?;
                c.execute("UPDATE quick_journal_edits SET applied=?2,error=?3 WHERE id=?1 AND namespace=?4",params![op.id,error.is_empty(),error,ns]).map_err(|e|e.to_string())?;
            }
        }
    }
    Ok(())
}
fn revision_bytes(op: &Edit) -> Result<String, String> {
    Ok(digest(&serde_json::to_vec(op).map_err(|e| e.to_string())?))
}

#[cfg(test)]
mod tests {
    use super::super::tests::{Fixture, MemoryStore};
    use super::*;
    fn record() -> Record {
        Record {
            version: 1,
            id: "a".repeat(32),
            date: "2026-11-15".into(),
            text: "first\n\n- list".into(),
            attachments: vec![],
        }
    }
    fn seeded() -> (Fixture, Record) {
        let f = Fixture::new();
        let r = record();
        insert_record(&f.db, &r).unwrap();
        apply_local(&f.db).unwrap();
        (f, r)
    }
    #[tokio::test]
    async fn edits_keep_identity_receipts_history_and_never_replay_the_capture() {
        let (f, r) = seeded();
        let store = MemoryStore::default();
        super::super::transfer(&f.db, &store, "test").await.unwrap();
        let mut next = r.clone();
        next.text = "edited **bold**".into();
        let op = enqueue_edit(&f.db, &r.id, &revision(&r).unwrap(), next.clone(), false).unwrap();
        assert!(enqueue_edit(&f.db, &r.id, &revision(&r).unwrap(), r.clone(), false).is_err());
        super::super::transfer(&f.db, &store, "test").await.unwrap();
        super::super::transfer(&f.db, &store, "test").await.unwrap();
        let path = f.dir.join("vault/Journals/2026-11-15.md");
        let text = fs::read_to_string(&path).unwrap();
        assert_eq!(
            format::blocks(&text).unwrap(),
            vec![(r.id.clone(), next.text.clone())]
        );
        let c = open_database(&f.db).unwrap();
        let (effective, rev, deleted, history) = projected(&c, &r, false).unwrap();
        assert_eq!(effective, next);
        assert_eq!(rev, op.id);
        assert!(!deleted);
        assert_eq!(history.len(), 1);
        assert!(rows(&c, Some(&r.id)).unwrap()[0].2);
        assert_eq!(original(&c, &r.id).unwrap(), r);
    }
    #[tokio::test]
    async fn mobile_upload_waits_for_exact_desktop_receipt_and_does_not_write_its_vault() {
        let (desktop, r) = seeded();
        let phone = Fixture::new();
        let store = MemoryStore::default();
        super::super::transfer(&desktop.db, &store, "test")
            .await
            .unwrap();
        insert_record(&phone.db, &r).unwrap();
        update(
            &phone.db,
            "UPDATE quick_journal_records SET namespace=?2,uploaded=1,applied=1 WHERE id=?1",
            &r.id,
            "test",
        )
        .unwrap();
        let mut next = r.clone();
        next.text = "edited on phone".into();
        let op = enqueue_edit(
            &phone.db,
            &r.id,
            &revision(&r).unwrap(),
            next.clone(),
            false,
        )
        .unwrap();
        transfer_for(&phone.db, &store, "test", true).await.unwrap();
        assert!(!rows(&open_database(&phone.db).unwrap(), None).unwrap()[0].2);
        assert!(!phone.dir.join("vault/Journals/2026-11-15.md").exists());
        super::super::transfer(&desktop.db, &store, "test")
            .await
            .unwrap();
        transfer_for(&phone.db, &store, "test", true).await.unwrap();
        let state = rows(&open_database(&phone.db).unwrap(), None).unwrap();
        assert!(state[0].2);
        assert!(state[0].3.is_empty());
        assert_eq!(state[0].0.id, op.id);
    }
    #[tokio::test]
    async fn stale_forks_are_reported_and_reconfigured_cloud_never_receives_old_edit_payloads() {
        let (f, r) = seeded();
        let store = MemoryStore::default();
        super::super::transfer(&f.db, &store, "first")
            .await
            .unwrap();
        let mut next = r.clone();
        next.text = "accepted edit".into();
        let op = enqueue_edit(&f.db, &r.id, &revision(&r).unwrap(), next, false).unwrap();
        let mut fork = op.clone();
        fork.id = "b".repeat(32);
        fork.after.text = "stale edit".into();
        let (c, _g) = open_write_database(&f.db).unwrap();
        insert(&c, &fork, "first", false).unwrap();
        drop(c);
        drop(_g);
        super::super::transfer(&f.db, &store, "first")
            .await
            .unwrap();
        let state = rows(&open_database(&f.db).unwrap(), None).unwrap();
        assert!(state[0].2);
        assert!(!state[1].2);
        assert!(state[1].3.starts_with("CONFLICT:"));
        let other = MemoryStore::default();
        transfer_for(&f.db, &other, "other", true).await.unwrap();
        assert!(other
            .inventory_page("journal/edits/", None)
            .await
            .unwrap()
            .keys
            .is_empty());
        assert!(other
            .inventory_page("journal/edit-receipts/", None)
            .await
            .unwrap()
            .keys
            .is_empty());
    }
    #[tokio::test]
    async fn external_os_edits_conflict_without_overwrite_or_false_receipt() {
        let (f, r) = seeded();
        let store = MemoryStore::default();
        super::super::transfer(&f.db, &store, "test").await.unwrap();
        let path = f.dir.join("vault/Journals/2026-11-15.md");
        let before = fs::read_to_string(&path)
            .unwrap()
            .replace("first", "manual OS change");
        fs::write(&path, &before).unwrap();
        let mut next = r.clone();
        next.text = "phone edit".into();
        enqueue_edit(&f.db, &r.id, &revision(&r).unwrap(), next, false).unwrap();
        super::super::transfer(&f.db, &store, "test").await.unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), before);
        let states = rows(&open_database(&f.db).unwrap(), Some(&r.id)).unwrap();
        assert!(!states[0].2);
        assert!(states[0].3.starts_with("CONFLICT:"));
        let history = history_value(&open_database(&f.db).unwrap(), &r.id).unwrap();
        assert_eq!(history["versions"][0]["record"]["text"], r.text);
        assert_eq!(history["conflicts"][0]["record"]["text"], "phone edit");
        assert!(history["conflicts"][0]["error"]
            .as_str()
            .unwrap()
            .starts_with("CONFLICT:"));
    }
    #[tokio::test]
    async fn move_trash_restore_and_interrupted_move_preserve_surrounding_bytes() {
        let (f, r) = seeded();
        let store = MemoryStore::default();
        super::super::transfer(&f.db, &store, "test").await.unwrap();
        let old = f.dir.join("vault/Journals/2026-11-15.md");
        let prefix = "---\ntags: [personal]\n---\nmanual\n\n";
        fs::write(&old, format!("{prefix}{}tail\n", r.markdown("_hub-assets"))).unwrap();
        let mut moved = r.clone();
        moved.date = "2026-12-01".into();
        let op = enqueue_edit(&f.db, &r.id, &revision(&r).unwrap(), moved.clone(), false).unwrap();
        // Destination write succeeded before a simulated interruption; recovery must remove only the old block.
        let dest = f.dir.join("vault/Journals/2026-12-01.md");
        append(&dest, &moved).unwrap();
        super::super::transfer(&f.db, &store, "test").await.unwrap();
        assert_eq!(fs::read_to_string(&old).unwrap(), format!("{prefix}tail\n"));
        let del = enqueue_edit(&f.db, &r.id, &op.id, moved.clone(), true).unwrap();
        super::super::transfer(&f.db, &store, "test").await.unwrap();
        assert!(fs::read_to_string(&dest)
            .unwrap()
            .contains("hub-journal-deleted"));
        enqueue_edit(&f.db, &r.id, &del.id, moved.clone(), false).unwrap();
        super::super::transfer(&f.db, &store, "test").await.unwrap();
        assert_eq!(
            format::blocks(&fs::read_to_string(&dest).unwrap()).unwrap(),
            vec![(r.id, moved.text)]
        );
    }
}
