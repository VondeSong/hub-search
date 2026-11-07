use super::*;
pub(super) const SCOPES: [(&str, &str, usize); 5] = [
    ("flashcards", "changes/", FLASHCARD_SYNC_MAX_SNAPSHOT_BYTES),
    ("reading", "reading/v1/changes/", 2 * 1024 * 1024),
    ("copies", "reading/copies-v1/changes/", 64 * 1024),
    ("manifests", "reading/media-v1/manifests/", 16 * 1024),
    ("devices", DEVICE_PREFIX, devices::MAX_EVENT),
];
fn limit(kind: &str) -> Result<usize, String> {
    if kind == "webdavSnapshot" {
        return Ok(FLASHCARD_SYNC_MAX_SNAPSHOT_BYTES);
    }
    SCOPES
        .iter()
        .find(|(k, _, _)| *k == kind)
        .map(|(_, _, max)| *max)
        .ok_or("维护类型无效".into())
}
pub(super) fn validate_key(remote: &dyn Store, kind: &str, key: &str) -> Result<(), String> {
    let (_, relative, _) = SCOPES
        .iter()
        .find(|(k, _, _)| *k == kind)
        .ok_or("维护范围无效")?;
    let prefix = remote.key(relative);
    let name = key
        .strip_prefix(&prefix)
        .and_then(|s| s.strip_suffix(".json"))
        .ok_or("维护对象不在允许的日志目录内")?;
    if name.contains('/') || name.contains('\\') || name.is_empty() {
        return Err("维护对象名称无效".into());
    }
    let hash = if kind == "flashcards" {
        name.rsplit_once('-')
            .map(|(_, h)| h)
            .ok_or("闪卡日志身份无效")?
    } else {
        name
    };
    if !valid_hash(hash) {
        return Err("维护日志哈希身份无效".into());
    }
    Ok(())
}
fn phase(db: &PathBuf, ns: &str, id: &str, configuration: &str) -> Result<String, String> {
    let c = open_database(db)?;
    check_scope(&c, ns, id, configuration)?;
    Ok(plan(&c, ns, id)?.phase)
}
fn pending(
    db: &PathBuf,
    ns: &str,
    id: &str,
    replacement: bool,
    status: &str,
) -> Result<Vec<(String, String)>, String> {
    let c = open_database(db)?;
    let mut q = c
        .prepare(progress::PENDING_SQL)
        .map_err(|e| e.to_string())?;
    let rows = q
        .query_map(params![ns, id, replacement, status], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}
fn object_body(
    db: &PathBuf,
    ns: &str,
    id: &str,
    key: &str,
    replacement: bool,
) -> Result<Vec<u8>, String> {
    open_database(db)?.query_row("SELECT body FROM cloud_maintenance_objects WHERE namespace=?1 AND run=?2 AND key=?3 AND replacement=?4",params![ns,id,key,replacement],|r|r.get(0)).map_err(|e|e.to_string())
}
fn save_status(
    db: &PathBuf,
    ns: &str,
    id: &str,
    key: &str,
    replacement: bool,
    status: &str,
) -> Result<(), String> {
    let (c, _writer) = open_write_database(db)?;
    c.execute("UPDATE cloud_maintenance_objects SET status=?5 WHERE namespace=?1 AND run=?2 AND key=?3 AND replacement=?4",params![ns,id,key,replacement,status]).map_err(|e|e.to_string())?;
    Ok(())
}
fn fail(db: &PathBuf, ns: &str, id: &str, error: &str) -> Result<Plan, String> {
    let (c, _writer) = open_write_database(db)?;
    let current = plan(&c, ns, id)?;
    set_run(&c, ns, id, "partial", &current.phase, error)?;
    plan(&c, ns, id)
}
/// Releasing local maintenance buffers is independent of cloud connectivity or the master
/// switch. Every affected batch becomes terminal so freed bytes cannot satisfy a retry.
pub(super) fn release(c: &Connection) -> Result<(), String> {
    schema(c)?;
    let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("UPDATE cloud_maintenance_runs SET state='cancelled',phase='released',error='' WHERE EXISTS(SELECT 1 FROM cloud_maintenance_objects o WHERE o.namespace=cloud_maintenance_runs.namespace AND o.run=cloud_maintenance_runs.id AND length(o.body)>0)",[]).map_err(|e|e.to_string())?;
    tx.execute("UPDATE cloud_maintenance_objects SET body=X''", [])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}
pub(super) async fn preview(
    db: &PathBuf,
    remote: &dyn Store,
    ns: &str,
    configuration: &str,
) -> Result<Plan, String> {
    preview_for(db, remote, ns, configuration, "cleanup").await
}
pub(super) async fn preview_restore(
    db: &PathBuf,
    remote: &dyn Store,
    ns: &str,
    configuration: &str,
) -> Result<Plan, String> {
    preview_for(db, remote, ns, configuration, "restore").await
}
async fn preview_for(
    db: &PathBuf,
    remote: &dyn Store,
    ns: &str,
    configuration: &str,
    purpose: &str,
) -> Result<Plan, String> {
    preview_with_snapshot(db, remote, ns, configuration, purpose, None).await
}
pub(super) async fn preview_with_snapshot(
    db: &PathBuf,
    remote: &dyn Store,
    ns: &str,
    configuration: &str,
    purpose: &str,
    snapshot: Option<Vec<u8>>,
) -> Result<Plan, String> {
    let token =
        inventory::acquire(db, remote, ns, configuration, purpose, snapshot.as_deref()).await?;
    let (c, _writer) = open_write_database(db)?;
    schema(&c)?;
    require_enabled(&c)?;
    if source(&c)? != (ns.into(), configuration.into()) {
        return Err("云连接在预览时变化，请重试".into());
    }
    let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
    // Finished retry payloads are generated scratch data, never user content. Keep their
    // proof and summary rows; a new recovery always reads authoritative cloud objects.
    tx.execute("UPDATE cloud_maintenance_objects SET body=X'' WHERE namespace=?1 AND EXISTS(SELECT 1 FROM cloud_maintenance_runs r WHERE r.namespace=cloud_maintenance_objects.namespace AND r.id=cloud_maintenance_objects.run AND r.state='complete' AND r.phase='done')",[ns]).map_err(|e|e.to_string())?;
    let count = inventory::install(&tx, ns, &token, configuration, purpose)?;
    tx.execute(
        "INSERT INTO cloud_maintenance_runs(namespace,id,configuration,state,phase,created_at,completed_at,error,proof,purpose) VALUES(?1,?2,?3,?4,?5,?6,0,'','',?7)",
        params![
            ns,
            token,
            configuration,
            if count == 0 {
                "complete"
            } else {
                "preview"
            },
            if count == 0 { "done" } else { "read" },
            now_timestamp(),
            purpose
        ],
    )
    .map_err(|e| e.to_string())?;
    if let Some(body) = snapshot {
        let key = format!("webdav-snapshot:{}", digest(&body));
        checkpoint::validate_object("webdavSnapshot", &key, &body)?;
        if body.len() > FLASHCARD_SYNC_MAX_SNAPSHOT_BYTES {
            return Err("WebDAV 快照超过安全大小限制".into());
        }
        let staged = progress::staged(&tx)?;
        if staged + body.len() as u64 > MAX_STAGED_BYTES {
            return Err("维护暂存超过 2 GB 安全上限，原历史未清理".into());
        }
        tx.execute(
            "INSERT INTO cloud_maintenance_objects VALUES(?1,?2,?3,'webdavSnapshot',?4,'read',0)",
            params![ns, token, key, body],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("UPDATE cloud_maintenance_runs SET state='preview',phase='read' WHERE namespace=?1 AND id=?2",params![ns,token]).map_err(|e|e.to_string())?;
    }
    inventory::retire(&tx, ns, &token)?;
    tx.commit().map_err(|e| e.to_string())?;
    plan(&c, ns, &token)
}
async fn read_round(db: &PathBuf, remote: &dyn Store, ns: &str, id: &str) -> Result<(), String> {
    let mut bytes = 0;
    for (key, kind) in pending(db, ns, id, false, "pending")? {
        if bytes > 0 && bytes + limit(&kind)? > ROUND_BYTES {
            break;
        }
        validate_key(remote, &kind, &key)?;
        check_network(remote)?;
        let body = remote
            .get(&key, limit(&kind)?)
            .await?
            .ok_or("历史日志在读取时消失，未把缺失当作已覆盖")?;
        checkpoint::validate_object(&kind, &key, &body)?;
        let (c, _writer) = open_write_database(db)?;
        let stored = progress::staged(&c)?;
        if stored + body.len() as u64 > MAX_STAGED_BYTES {
            return Err("维护暂存超过 2 GB 安全上限，原历史未清理".into());
        }
        c.execute("UPDATE cloud_maintenance_objects SET body=?4,status='read' WHERE namespace=?1 AND run=?2 AND key=?3 AND replacement=0",params![ns,id,key,body]).map_err(|e|e.to_string())?;
        bytes += body.len();
    }
    if pending(db, ns, id, false, "pending")?.is_empty() {
        let (c, _writer) = open_write_database(db)?;
        set_run(&c, ns, id, "prepared", "build", "")?;
    }
    Ok(())
}
async fn publish_round(db: &PathBuf, remote: &dyn Store, ns: &str, id: &str) -> Result<(), String> {
    let mut bytes = 0;
    for (key, kind) in pending(db, ns, id, true, "pending")? {
        let body = object_body(db, ns, id, &key, true)?;
        if bytes > 0 && bytes + body.len() > ROUND_BYTES {
            break;
        }
        validate_key(remote, &kind, &key)?;
        check_network(remote)?;
        remote.put_verified(&key, &body).await?;
        save_status(db, ns, id, &key, true, "published")?;
        bytes += body.len();
    }
    if pending(db, ns, id, true, "pending")?.is_empty() {
        let (c, _writer) = open_write_database(db)?;
        set_run(&c, ns, id, "prepared", "verify", "")?;
    }
    Ok(())
}
async fn verify_round(db: &PathBuf, remote: &dyn Store, ns: &str, id: &str) -> Result<(), String> {
    let mut bytes = 0;
    for (key, kind) in pending(db, ns, id, true, "published")? {
        let expected = object_body(db, ns, id, &key, true)?;
        if bytes > 0 && bytes + expected.len() > ROUND_BYTES {
            break;
        }
        validate_key(remote, &kind, &key)?;
        check_network(remote)?;
        let actual = remote
            .get(&key, limit(&kind)?)
            .await?
            .ok_or("检查点读回时缺失，原历史未清理")?;
        if actual != expected {
            return Err("检查点云端读回内容不符，原历史未清理".into());
        }
        save_status(db, ns, id, &key, true, "verified")?;
        bytes += actual.len();
    }
    if pending(db, ns, id, true, "published")?.is_empty() {
        let body = {
            let c = open_database(db)?;
            proof_stream::body(&c, ns, id)?
        };
        let key = remote.key(&format!("{PROOF_PREFIX}{}.json", digest(&body)));
        check_network(remote)?;
        remote.put_verified(&key, &body).await?;
        if remote.get(&key, ROUND_BYTES).await?.as_deref() != Some(body.as_slice()) {
            return Err("检查点索引云端验证失败，原历史未清理".into());
        }
        let (c, _writer) = open_write_database(db)?;
        set_run(&c, ns, id, "ready", "ready", "")?;
    }
    Ok(())
}
pub(super) async fn advance(
    db: &PathBuf,
    remote: &dyn Store,
    ns: &str,
    configuration: &str,
    id: &str,
) -> Result<Plan, String> {
    {
        let c = open_database(db)?;
        let purpose: String = c
            .query_row(
                "SELECT purpose FROM cloud_maintenance_runs WHERE namespace=?1 AND id=?2",
                params![ns, id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if purpose != "cleanup" {
            return Err("只读恢复批次不能发布或清理云历史".into());
        }
    }
    let current = phase(db, ns, id, configuration)?;
    let result = match current.as_str() {
        "read" => read_round(db, remote, ns, id).await,
        "build" => {
            let (c, _writer) = open_write_database(db)?;
            checkpoint::build(&c, remote, ns, id)
        }
        "publish" => publish_round(db, remote, ns, id).await,
        "verify" => verify_round(db, remote, ns, id).await,
        _ => Err("此维护批次不处于准备阶段；不会自动清理历史".into()),
    };
    if let Err(error) = result {
        return fail(db, ns, id, &error);
    }
    let c = open_database(db)?;
    plan(&c, ns, id)
}
pub(super) async fn advance_restore(
    db: &PathBuf,
    remote: &dyn Store,
    ns: &str,
    configuration: &str,
    id: &str,
) -> Result<Plan, String> {
    let current = phase(db, ns, id, configuration)?;
    let purpose: String = {
        let c = open_database(db)?;
        c.query_row(
            "SELECT purpose FROM cloud_maintenance_runs WHERE namespace=?1 AND id=?2",
            params![ns, id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?
    };
    if purpose != "restore" {
        return Err("当前批次不是只读恢复范围，请重新预览恢复".into());
    }
    let result = match current.as_str() {
        "read" => read_round(db, remote, ns, id).await,
        "build" => {
            let (c, _writer) = open_write_database(db)?;
            checkpoint::build(&c, remote, ns, id)?;
            set_run(&c, ns, id, "ready", "restoreReady", "")
        }
        "publish" => {
            let (c, _writer) = open_write_database(db)?;
            proof_stream::body(&c, ns, id)?;
            set_run(&c, ns, id, "ready", "restoreReady", "")
        }
        _ => Err("恢复范围不处于准备阶段，请重新预览或恢复记录".into()),
    };
    if let Err(error) = result {
        return fail(db, ns, id, &error);
    }
    let c = open_database(db)?;
    plan(&c, ns, id)
}
async fn recheck_sources_round(
    db: &PathBuf,
    remote: &dyn Store,
    ns: &str,
    id: &str,
    snapshot: Option<&[u8]>,
) -> Result<bool, String> {
    {
        let (c, _writer) = open_write_database(db)?;
        set_run(&c, ns, id, "running", "restoreSourceVerify", "")?;
    }
    let mut consumed = 0;
    for (key, kind) in pending(db, ns, id, false, "read")? {
        let expected = object_body(db, ns, id, &key, false)?;
        if consumed > 0 && consumed + expected.len() > ROUND_BYTES {
            break;
        }
        check_network(remote)?;
        let actual = if kind == "webdavSnapshot" {
            snapshot
                .ok_or("WebDAV 当前快照不再可读，请重新预览")?
                .to_vec()
        } else {
            validate_key(remote, &kind, &key)?;
            remote
                .get(&key, limit(&kind)?)
                .await?
                .ok_or("恢复范围中的云记录已经变化或缺失，请重新预览")?
        };
        if actual != expected {
            return Err("云记录实际内容不符，尚未恢复本机记录".into());
        }
        save_status(db, ns, id, &key, false, "restoreVerified")?;
        consumed += actual.len();
    }
    Ok(pending(db, ns, id, false, "read")?.is_empty())
}
async fn recheck_round(
    db: &PathBuf,
    remote: &dyn Store,
    ns: &str,
    id: &str,
    target: &str,
) -> Result<bool, String> {
    let body = {
        let c = open_database(db)?;
        proof_stream::body(&c, ns, id)?
    };
    let key = remote.key(&format!("{PROOF_PREFIX}{}.json", digest(&body)));
    check_network(remote)?;
    if remote.get(&key, ROUND_BYTES).await?.as_deref() != Some(body.as_slice()) {
        return Err("已验证检查点索引不再可读，停止清理或恢复".into());
    }
    let verify_phase = if target == "delete" {
        "deleteVerify"
    } else {
        "restoreVerify"
    };
    {
        let (c, _writer) = open_write_database(db)?;
        if plan(&c, ns, id)?.phase != verify_phase {
            c.execute("UPDATE cloud_maintenance_objects SET status='published' WHERE namespace=?1 AND run=?2 AND replacement=1",params![ns,id]).map_err(|e|e.to_string())?;
            set_run(&c, ns, id, "running", verify_phase, "")?;
        }
    }
    // Recheck authoritative bytes in resumable, bounded rounds. Cached success and HEAD
    // metadata never satisfy this verification stage before a deletion batch.
    let mut consumed = 0;
    for (key, kind) in pending(db, ns, id, true, "published")? {
        let expected = object_body(db, ns, id, &key, true)?;
        if consumed > 0 && consumed + expected.len() > ROUND_BYTES {
            break;
        }
        validate_key(remote, &kind, &key)?;
        check_network(remote)?;
        let bytes = remote
            .get(&key, limit(&kind)?)
            .await?
            .ok_or("替代检查点缺失，停止清理或恢复")?;
        if bytes != expected {
            return Err("替代检查点损坏，停止清理或恢复".into());
        }
        save_status(db, ns, id, &key, true, "verified")?;
        consumed += bytes.len();
    }
    if !pending(db, ns, id, true, "published")?.is_empty() {
        return Ok(false);
    }
    let (c, _writer) = open_write_database(db)?;
    set_run(&c, ns, id, "running", target, "")?;
    Ok(true)
}
pub(super) async fn clean(
    db: &PathBuf,
    remote: &dyn Store,
    ns: &str,
    configuration: &str,
    id: &str,
) -> Result<Plan, String> {
    let current = phase(db, ns, id, configuration)?;
    {
        let c = open_database(db)?;
        if plan(&c, ns, id)?.purpose != "cleanup" {
            return Err("只读恢复批次不能清理云历史".into());
        }
    }
    if !matches!(current.as_str(), "ready" | "delete" | "deleteVerify") {
        return Err("检查点尚未全部验证，不能清理历史".into());
    }
    match recheck_round(db, remote, ns, id, "delete").await {
        Err(error) => return fail(db, ns, id, &error),
        Ok(false) => {
            let c = open_database(db)?;
            return plan(&c, ns, id);
        }
        Ok(true) => {}
    }
    {
        let (c, _writer) = open_write_database(db)?;
        let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
        set_run(&tx, ns, id, "running", "delete", "")?;
        progress::prepare_delete(&tx, ns, id)?;
        tx.commit().map_err(|e| e.to_string())?;
    }
    let candidates = progress::deletion_candidates(&open_database(db)?, ns, id)?;
    for (key, kind) in &candidates {
        validate_key(remote, kind, key)?;
        check_network(remote)?;
        if let Err(error) = remote.delete_exact(key).await {
            return fail(db, ns, id, &format!("部分历史仍保留：{error}"));
        }
        save_status(db, ns, id, key, false, "deleted")?;
    }
    let (c, _writer) = open_write_database(db)?;
    let remaining = progress::deletion_remaining(&c, ns, id)?;
    if remaining == 0 {
        set_run(&c, ns, id, "complete", "done", "")?;
        // Checkpoint payloads stay for resume/restore. Covered input bytes are redundant
        // only after all deletions succeeded; this frees reusable SQLite pages, not files.
        c.execute("UPDATE cloud_maintenance_objects SET body=X'' WHERE namespace=?1 AND run=?2 AND replacement=0",params![ns,id]).map_err(|e|e.to_string())?;
    }
    plan(&c, ns, id)
}
pub(super) async fn restore(
    db: &PathBuf,
    remote: &dyn Store,
    ns: &str,
    configuration: &str,
    id: &str,
) -> Result<Plan, String> {
    restore_with_snapshot(db, remote, ns, configuration, id, None).await
}
pub(super) async fn restore_with_snapshot(
    db: &PathBuf,
    remote: &dyn Store,
    ns: &str,
    configuration: &str,
    id: &str,
    snapshot: Option<Vec<u8>>,
) -> Result<Plan, String> {
    let current = phase(db, ns, id, configuration)?;
    if !matches!(
        current.as_str(),
        "ready"
            | "delete"
            | "done"
            | "restore"
            | "restoreVerify"
            | "restoreReady"
            | "restoreSourceVerify"
    ) {
        return Err("请先完成当前云历史的检查点准备与校验，再恢复记录".into());
    }
    let purpose: String = {
        let c = open_database(db)?;
        c.query_row(
            "SELECT purpose FROM cloud_maintenance_runs WHERE namespace=?1 AND id=?2",
            params![ns, id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?
    };
    // The mutable WebDAV root may change between bounded rounds. Compare its current
    // decoded identity on every call, including the final commit, even after old bytes
    // were freed by a completed cleanup. A fresh preview is required after a change.
    let saved_snapshot: Option<String> = {
        let c = open_database(db)?;
        c.query_row("SELECT key FROM cloud_maintenance_objects WHERE namespace=?1 AND run=?2 AND replacement=0 AND kind='webdavSnapshot'",params![ns,id],|r|r.get(0)).optional().map_err(|e|e.to_string())?
    };
    if let Some(expected) = saved_snapshot {
        if snapshot
            .as_deref()
            .map(|bytes| format!("webdav-snapshot:{}", digest(bytes)))
            .as_deref()
            != Some(expected.as_str())
        {
            return fail(
                db,
                ns,
                id,
                "WebDAV 当前快照已经变化，请重新预览恢复；尚未修改本机记录",
            );
        }
    }
    let checked = if purpose == "restore" {
        recheck_sources_round(db, remote, ns, id, snapshot.as_deref()).await
    } else {
        recheck_round(db, remote, ns, id, "restore").await
    };
    match checked {
        Err(error) => return fail(db, ns, id, &error),
        Ok(false) => {
            let c = open_database(db)?;
            return plan(&c, ns, id);
        }
        Ok(true) => {}
    }
    // Restore uses the verified compatibility checkpoints, never a stale local snapshot.
    // Work is transactional, source/library effects are not replayed by formal import.
    let outcome = (|| -> Result<(), String> {
        let (mut c, _writer) = open_write_database(db)?;
        check_scope(&c, ns, id, configuration)?;
        let proof_body = proof_stream::body(&c, ns, id)?;
        let device = flashcard_sync_device_id(&c)?;
        let tx = c.transaction().map_err(|e| e.to_string())?;
        reading_sync::maintenance_capture(&tx, &device)?;
        for reviews in [false, true] {
            proof_stream::each(&tx, ns, id, |replacement| {
                let bytes:Vec<u8>=tx.query_row("SELECT body FROM cloud_maintenance_objects WHERE namespace=?1 AND run=?2 AND key=?3 AND replacement=1",params![ns,id,replacement.key],|r|r.get(0)).map_err(|e|e.to_string())?;
                if digest(&bytes) != replacement.hash {
                    return Err("本机检查点暂存损坏，恢复已回滚".into());
                }
                match replacement.kind.as_str() {
                    "flashcards" => {
                        let mut change: crate::flashcard_cloud_sync::Change =
                            serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
                        if !reviews {
                            change.snapshot.reviews.clear();
                        }
                        merge_flashcard_snapshot_in_transaction(&tx, &change.snapshot)?;
                    }
                    "reading" if !reviews => reading_sync::maintenance_import(&tx, &bytes)?,
                    "copies" if !reviews => {
                        reading_sync::copies::maintenance_import(&tx, ns, &bytes)?
                    }
                    "manifests" if !reviews => {
                        reading_sync::media::maintenance_import(&tx, ns, &bytes)?
                    }
                    "devices" if !reviews => devices::maintenance_import(&tx, ns, &bytes)?,
                    _ => {}
                }
                Ok(())
            })?;
        }
        // Apply transport knowledge only after the same transaction has imported the
        // complete verified state. Read-only recovery never marks unpublished scratch
        // checkpoints, and concurrently created cloud objects are absent from this list.
        let has_flashcards:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM cloud_maintenance_objects WHERE namespace=?1 AND run=?2 AND kind='flashcards' AND (replacement=0 OR ?3<>'restore'))",params![ns,id,purpose],|r|r.get(0)).map_err(|e|e.to_string())?;
        let mut q=tx.prepare("SELECT key,kind,replacement FROM cloud_maintenance_objects WHERE namespace=?1 AND run=?2 ORDER BY key").map_err(|e|e.to_string())?;
        let rows = q
            .query_map(params![ns, id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, bool>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (key, kind, replacement) = row.map_err(|e| e.to_string())?;
            if replacement && purpose == "restore" {
                continue;
            }
            if kind == "flashcards" {
                continue;
            }
            let table = match kind.as_str() {
                "reading" => "reading_sync_applied",
                "copies" => "reading_copy_applied",
                "manifests" => "reading_media_applied",
                _ => continue,
            };
            validate_key(remote, &kind, &key)?;
            let hash = key
                .rsplit('/')
                .next()
                .and_then(|s| s.strip_suffix(".json"))
                .filter(|s| valid_hash(s))
                .ok_or("已验证记录身份无效")?;
            tx.execute(
                &format!("INSERT OR IGNORE INTO {table}(namespace,id) VALUES(?1,?2)"),
                params![ns, hash],
            )
            .map_err(|e| e.to_string())?;
        }
        drop(q);
        if has_flashcards {
            let canonical = checkpoint::flashcard_checkpoint(&tx, ns, id)?;
            crate::flashcard_cloud_sync::maintenance_accept_database(&tx, ns, &canonical)?;
            tx.execute("INSERT OR IGNORE INTO flashcard_cloud_applied(namespace,id) SELECT namespace,key FROM cloud_maintenance_objects WHERE namespace=?1 AND run=?2 AND kind='flashcards' AND (replacement=0 OR ?3<>'restore')",params![ns,id,purpose]).map_err(|e|e.to_string())?;
        }
        mark_flashcard_sync_dirty(&tx)?;
        devices::confirm(&tx, ns, &digest(&proof_body))?;
        let remaining = progress::count(&tx, ns, id, false, "read")?;
        set_run(
            &tx,
            ns,
            id,
            if purpose == "cleanup" && remaining > 0 {
                "restored"
            } else {
                "complete"
            },
            if purpose == "cleanup" && remaining > 0 {
                "ready"
            } else {
                "done"
            },
            "",
        )?;
        tx.commit().map_err(|e| e.to_string())
    })();
    if let Err(error) = outcome {
        return fail(db, ns, id, &error);
    }
    // Confirmation publication is a durable separate retry; imported domain data stays committed.
    if let Err(error) = devices::flush(db, remote, ns).await {
        return fail(db, ns, id, &format!("记录已恢复，设备确认待发布：{error}"));
    }
    let c = open_database(db)?;
    plan(&c, ns, id)
}
