use super::*;
pub(super) const MAX_EVENT: usize = 8 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Event {
    format: u32,
    device: String,
    writer: String,
    clock: u64,
    kind: String,
    label: String,
    platform: String,
    seen_at: i64,
    retired: bool,
    checkpoint: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DeviceView {
    device: String,
    label: String,
    platform: String,
    local: bool,
    last_seen_at: i64,
    retired: bool,
    long_offline: bool,
    confirmed_checkpoint: String,
}
fn platform() -> String {
    match std::env::consts::OS {
        "windows" => "Windows",
        "android" => "Android",
        "macos" => "Mac",
        _ => "Hub",
    }
    .into()
}
fn label(device: &str) -> String {
    format!(
        "{} · {}",
        platform(),
        device.chars().take(8).collect::<String>()
    )
}
fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}
fn validate(e: &Event) -> Result<(), String> {
    if e.format != 1
        || !valid_id(&e.device)
        || !valid_id(&e.writer)
        || e.clock == 0
        || e.clock > i64::MAX as u64 - 1_000_000
        || !matches!(e.kind.as_str(), "heartbeat" | "retire" | "confirm")
        || e.label.len() > 128
        || e.platform.len() > 32
        || e.label.chars().any(char::is_control)
        || e.platform.chars().any(char::is_control)
        || e.seen_at < 0
        || (!e.checkpoint.is_empty() && !valid_hash(&e.checkpoint))
        || (e.kind != "retire" && e.device != e.writer)
    {
        return Err("云设备记录无效；未导入".into());
    }
    Ok(())
}
fn accept(c: &Connection, ns: &str, e: &Event) -> Result<(), String> {
    validate(e)?;
    let old:Option<(u64,String,String)>=c.query_row("SELECT clock,writer,body FROM cloud_device_events WHERE namespace=?1 AND device=?2 AND kind=?3",params![ns,e.device,e.kind],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|x|x.to_string())?;
    let body = serde_json::to_string(e).map_err(|x| x.to_string())?;
    if let Some((clock, writer, raw)) = old {
        if clock == e.clock && writer == e.writer && raw != body {
            return Err("云设备记录版本冲突".into());
        }
        if (clock, writer) >= (e.clock, e.writer.clone()) {
            return Ok(());
        }
    }
    c.execute("INSERT INTO cloud_device_events(namespace,device,kind,clock,writer,body) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(namespace,device,kind) DO UPDATE SET clock=excluded.clock,writer=excluded.writer,body=excluded.body",params![ns,e.device,e.kind,e.clock,e.writer,body]).map_err(|x|x.to_string())?;
    let clock = metadata_u64(c, "cloud_maintenance_clock", 0).max(e.clock);
    c.execute("INSERT INTO metadata VALUES('cloud_maintenance_clock',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[clock.to_string()]).map_err(|x|x.to_string())?;
    Ok(())
}
/// Maintenance uses the registry's exact validation/order rules, never a second protocol.
pub(super) fn maintenance_import(c: &Connection, ns: &str, body: &[u8]) -> Result<(), String> {
    if body.len() > MAX_EVENT {
        return Err("设备记录超过大小上限".into());
    }
    let e: Event = serde_json::from_slice(body).map_err(|_| "设备云格式无效")?;
    accept(c, ns, &e)
}
pub(super) fn maintenance_export_page(
    c: &Connection,
    ns: &str,
    after: i64,
) -> Result<Vec<(i64, Vec<u8>)>, String> {
    let mut q=c.prepare("SELECT local_seq,body FROM cloud_device_events WHERE namespace=?1 AND local_seq>?2 ORDER BY local_seq LIMIT 100").map_err(|e|e.to_string())?;
    let rows = q
        .query_map(params![ns, after], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    rows.map(|row| {
        let (id, body) = row.map_err(|e| e.to_string())?;
        let e: Event = serde_json::from_str(&body).map_err(|_| "本机设备记录损坏")?;
        validate(&e)?;
        Ok((id, serde_json::to_vec(&e).map_err(|e| e.to_string())?))
    })
    .collect()
}
fn stage(c: &Connection, ns: &str, mut e: Event) -> Result<(), String> {
    e.clock = metadata_u64(c, "cloud_maintenance_clock", 0)
        .checked_add(1)
        .ok_or("设备记录版本超出范围")?;
    validate(&e)?;
    let body = serde_json::to_vec(&e).map_err(|x| x.to_string())?;
    if body.len() > MAX_EVENT {
        return Err("设备记录超过大小上限".into());
    }
    let apply = |c: &Connection| -> Result<(), String> {
        accept(c, ns, &e)?;
        // Keep exactly the newest unsent event per target/kind; an acknowledged old event may
        // still remain in the immutable cloud journal and is ordered by clock, never time.
        c.execute("DELETE FROM cloud_device_pending WHERE namespace=?1 AND json_extract(CAST(body AS TEXT),'$.device')=?2 AND json_extract(CAST(body AS TEXT),'$.kind')=?3",params![ns,e.device,e.kind]).map_err(|x|x.to_string())?;
        c.execute(
            "INSERT OR IGNORE INTO cloud_device_pending(namespace,id,body) VALUES(?1,?2,?3)",
            params![ns, digest(&body), body],
        )
        .map_err(|x| x.to_string())?;
        Ok(())
    };
    if c.is_autocommit() {
        let tx = c.unchecked_transaction().map_err(|x| x.to_string())?;
        apply(&tx)?;
        tx.commit().map_err(|x| x.to_string())
    } else {
        apply(c)
    }
}
pub(super) fn observe(c: &Connection, ns: &str) -> Result<(), String> {
    let device = flashcard_sync_device_id(c)?;
    let old:Option<String>=c.query_row("SELECT body FROM cloud_device_events WHERE namespace=?1 AND device=?2 AND kind='heartbeat'",params![ns,device],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    if old
        .as_deref()
        .and_then(|v| serde_json::from_str::<Event>(v).ok())
        .is_some_and(|e| now_timestamp().saturating_sub(e.seen_at) < 600)
    {
        return Ok(());
    }
    stage(
        c,
        ns,
        Event {
            format: 1,
            writer: device.clone(),
            label: label(&device),
            platform: platform(),
            device,
            clock: 0,
            kind: "heartbeat".into(),
            seen_at: now_timestamp(),
            retired: false,
            checkpoint: String::new(),
        },
    )
}
pub(super) fn retire(c: &Connection, ns: &str, device: &str, retired: bool) -> Result<(), String> {
    let writer = flashcard_sync_device_id(c)?;
    if device == writer && retired {
        return Err("不能将本设备标记为退休".into());
    }
    let known: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM cloud_device_events WHERE namespace=?1 AND device=?2)",
            params![ns, device],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !known {
        return Err("尚未确认此设备，请先刷新设备列表".into());
    }
    stage(
        c,
        ns,
        Event {
            format: 1,
            device: device.into(),
            writer,
            clock: 0,
            kind: "retire".into(),
            label: String::new(),
            platform: String::new(),
            seen_at: now_timestamp(),
            retired,
            checkpoint: String::new(),
        },
    )
}
pub(super) fn confirm(c: &Connection, ns: &str, checkpoint: &str) -> Result<(), String> {
    if !valid_hash(checkpoint) {
        return Err("检查点身份无效".into());
    }
    let device = flashcard_sync_device_id(c)?;
    stage(
        c,
        ns,
        Event {
            format: 1,
            writer: device.clone(),
            label: label(&device),
            platform: platform(),
            device,
            clock: 0,
            kind: "confirm".into(),
            seen_at: now_timestamp(),
            retired: false,
            checkpoint: checkpoint.into(),
        },
    )?;
    c.execute(
        "INSERT INTO metadata VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![
            format!("cloud_maintenance_confirmed_{}", digest(ns.as_bytes())),
            checkpoint
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
pub(super) fn view(c: &Connection, ns: &str, current: &str) -> Result<Vec<DeviceView>, String> {
    let mut q = c
        .prepare("SELECT body FROM cloud_device_events WHERE namespace=?1 ORDER BY device,kind")
        .map_err(|e| e.to_string())?;
    let rows = q
        .query_map([ns], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut result: BTreeMap<String, DeviceView> = BTreeMap::new();
    for row in rows {
        let e: Event = serde_json::from_str(&row.map_err(|x| x.to_string())?)
            .map_err(|_| "本机设备记录损坏")?;
        validate(&e)?;
        let d = result.entry(e.device.clone()).or_insert(DeviceView {
            device: e.device.clone(),
            label: format!("Hub · {}", e.device.chars().take(8).collect::<String>()),
            platform: "Hub".into(),
            local: e.device == current,
            last_seen_at: 0,
            retired: false,
            long_offline: true,
            confirmed_checkpoint: String::new(),
        });
        match e.kind.as_str() {
            "heartbeat" => {
                if !e.label.is_empty() {
                    d.label = e.label;
                }
                if !e.platform.is_empty() {
                    d.platform = e.platform;
                }
                d.last_seen_at = e.seen_at;
            }
            "retire" => d.retired = e.retired,
            "confirm" => d.confirmed_checkpoint = e.checkpoint,
            _ => {}
        }
    }
    result.entry(current.into()).or_insert(DeviceView {
        device: current.into(),
        label: label(current),
        platform: platform(),
        local: true,
        last_seen_at: 0,
        retired: false,
        long_offline: false,
        confirmed_checkpoint: String::new(),
    });
    for d in result.values_mut() {
        d.long_offline = !d.local
            && (d.last_seen_at == 0
                || now_timestamp().saturating_sub(d.last_seen_at) >= 30 * 86400);
    }
    Ok(result.into_values().collect())
}
pub(super) async fn flush(db: &PathBuf, remote: &dyn Store, ns: &str) -> Result<(), String> {
    let pending = {
        let (c, _writer) = open_write_database(db)?;
        c.execute_batch("CREATE TABLE IF NOT EXISTS cloud_device_applied(namespace TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(namespace,id));").map_err(|e|e.to_string())?;
        let mut q=c.prepare("SELECT id,body FROM cloud_device_pending WHERE namespace=?1 ORDER BY local_seq LIMIT 100").map_err(|e|e.to_string())?;
        let rows = q
            .query_map([ns], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    for (id, body) in pending {
        check_network(remote)?;
        let key = remote.key(&format!("{DEVICE_PREFIX}{id}.json"));
        remote.put_verified(&key, &body).await?;
        if remote.get(&key, MAX_EVENT).await?.as_deref() != Some(body.as_slice()) {
            return Err("设备记录读回校验未通过，待发布记录已保留".into());
        }
        let (c, _writer) = open_write_database(db)?;
        let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT OR IGNORE INTO cloud_device_applied(namespace,id) VALUES(?1,?2)",
            params![ns, id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM cloud_device_pending WHERE namespace=?1 AND id=?2",
            params![ns, id],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub(super) async fn refresh(
    db: &PathBuf,
    remote: &dyn Store,
    ns: &str,
    observe_self: bool,
) -> Result<(), String> {
    {
        let (c, _writer) = open_write_database(db)?;
        schema(&c)?;
        c.execute_batch("CREATE TABLE IF NOT EXISTS cloud_device_applied(namespace TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(namespace,id));").map_err(|e|e.to_string())?;
    }
    check_network(remote)?;
    let inventory = crate::cloud_inventory::acquire_receive(
        db,
        remote,
        ns,
        "maintenance-device-events",
        DEVICE_PREFIX,
        "cloud_device_applied",
    )
    .await?;
    let prefix = remote.key(DEVICE_PREFIX);
    let mut receive_after = None;
    while let Some(key) = inventory.next_unapplied(
        &open_database(db)?,
        "cloud_device_applied",
        receive_after.as_deref(),
    )? {
        receive_after = Some(key.clone());
        let id = key
            .strip_prefix(&prefix)
            .and_then(|s| s.strip_suffix(".json"))
            .filter(|s| valid_hash(s))
            .ok_or("设备云对象名称无效")?;
        check_network(remote)?;
        let body = remote
            .get(&key, MAX_EVENT)
            .await?
            .ok_or("设备云对象读取时消失，请重试")?;
        if digest(&body) != id {
            return Err("设备云对象内容身份不符".into());
        }
        let e: Event = serde_json::from_slice(&body).map_err(|_| "设备云格式无效")?;
        let (c, _writer) = open_write_database(db)?;
        let tx = c.unchecked_transaction().map_err(|x| x.to_string())?;
        accept(&tx, ns, &e)?;
        tx.execute(
            "INSERT OR IGNORE INTO cloud_device_applied(namespace,id) VALUES(?1,?2)",
            params![ns, id],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|x| x.to_string())?;
    }
    {
        let (c, _writer) = open_write_database(db)?;
        inventory.release(&c)?;
    }
    if observe_self {
        let (c, _writer) = open_write_database(db)?;
        observe(&c, ns)?;
    }
    flush(db, remote, ns).await
}

#[cfg(test)]
mod inventory_tests {
    use super::*;
    use crate::reading_sync::object_store::InventoryPage;
    use futures::future::BoxFuture;
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct PagedEvents {
        body: Vec<u8>,
        id: String,
        gets: AtomicUsize,
    }
    impl Store for PagedEvents {
        fn key(&self, r: &str) -> String {
            format!("fixture/v2/{r}")
        }
        fn check_network(&self, _: &str) -> Result<(), String> {
            Ok(())
        }
        fn head_size<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<Option<u64>, String>> {
            Box::pin(async move { Ok(Some(self.body.len() as u64)) })
        }
        fn get<'a>(
            &'a self,
            key: &'a str,
            _: usize,
        ) -> BoxFuture<'a, Result<Option<Vec<u8>>, String>> {
            Box::pin(async move {
                assert!(
                    key.ends_with(&format!("{}.json", self.id)),
                    "already applied device history must not be fetched again"
                );
                self.gets.fetch_add(1, Ordering::SeqCst);
                Ok(Some(self.body.clone()))
            })
        }
        fn list<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<Vec<String>, String>> {
            Box::pin(async { panic!("device receiver must not request aggregate history") })
        }
        fn inventory_page<'a>(
            &'a self,
            r: &'a str,
            token: Option<&'a str>,
        ) -> BoxFuture<'a, Result<InventoryPage, String>> {
            Box::pin(async move {
                assert_eq!(r, DEVICE_PREFIX);
                let start = token.map(|v| v.parse::<usize>().unwrap()).unwrap_or(0);
                let end = (start + 1000).min(20_001);
                let keys = (start..end)
                    .map(|i| {
                        self.key(&format!(
                            "{DEVICE_PREFIX}{}.json",
                            if i == 20_000 {
                                self.id.clone()
                            } else {
                                format!("{i:064x}")
                            }
                        ))
                    })
                    .collect();
                Ok(InventoryPage {
                    keys,
                    directories: Vec::new(),
                    next: (end < 20_001).then(|| end.to_string()),
                })
            })
        }
        fn put_verified<'a>(
            &'a self,
            _: &'a str,
            _: &'a [u8],
        ) -> BoxFuture<'a, Result<bool, String>> {
            Box::pin(async { panic!("no pending producer in this fixture") })
        }
        fn delete_exact<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<(), String>> {
            Box::pin(async { panic!("receiver has no delete authority") })
        }
    }
    #[tokio::test]
    async fn device_receiver_large_applied_history_only_reads_new_event_and_reopens_receipt() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../task-state/project-optimization-20261011/cloud-inventory-tests")
            .join(format!("devices-{}", random_url_safe(8)));
        fs::create_dir_all(&root).unwrap();
        let db = root.join("hub.sqlite3");
        let mut c = open_database(&db).unwrap();
        schema(&c).unwrap();
        c.execute_batch("CREATE TABLE IF NOT EXISTS cloud_device_applied(namespace TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(namespace,id));").unwrap();
        let tx = c.transaction().unwrap();
        {
            let mut insert = tx
                .prepare("INSERT INTO cloud_device_applied VALUES('device-scale',?1)")
                .unwrap();
            for i in 0..20_000 {
                insert.execute([format!("{i:064x}")]).unwrap();
            }
        }
        tx.commit().unwrap();
        drop(c);
        let event = Event {
            format: 1,
            device: "fixture-device".into(),
            writer: "fixture-device".into(),
            clock: 1,
            kind: "heartbeat".into(),
            label: "Fixture".into(),
            platform: "Windows".into(),
            seen_at: 1,
            retired: false,
            checkpoint: String::new(),
        };
        let body = serde_json::to_vec(&event).unwrap();
        let remote = PagedEvents {
            id: digest(&body),
            body,
            gets: AtomicUsize::new(0),
        };
        refresh(&db, &remote, "device-scale", false).await.unwrap();
        assert_eq!(remote.gets.load(Ordering::SeqCst), 1);
        crate::forget_initialized_database(&db);
        refresh(&db, &remote, "device-scale", false).await.unwrap();
        assert_eq!(remote.gets.load(Ordering::SeqCst), 1);
        let c = open_database(&db).unwrap();
        assert_eq!(
            c.query_row(
                "SELECT count(*) FROM cloud_device_applied WHERE namespace='device-scale'",
                [],
                |r| r.get::<_, usize>(0)
            )
            .unwrap(),
            20_001
        );
        assert_eq!(c.query_row("SELECT count(*) FROM cloud_device_events WHERE namespace='device-scale' AND device='fixture-device'",[],|r|r.get::<_,usize>(0)).unwrap(),1);
        assert_eq!(
            c.query_row(
                "SELECT count(*) FROM cloud_inventory_runs WHERE namespace='device-scale'",
                [],
                |r| r.get::<_, usize>(0)
            )
            .unwrap(),
            0
        );
    }
    #[test]
    fn device_flush_creates_applied_schema_only_after_shared_writer_is_available() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../task-state/project-optimization-20261011/cloud-inventory-tests")
            .join(format!("device-writer-{}", random_url_safe(8)));
        fs::create_dir_all(&root).unwrap();
        let db = root.join("hub.sqlite3");
        {
            let (c, _writer) = open_write_database(&db).unwrap();
            schema(&c).unwrap();
            assert_eq!(c.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='cloud_device_applied'", [], |r| r.get::<_, usize>(0)).unwrap(), 0);
        }
        let writer = lock_database_writer().unwrap();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let path = db.clone();
        let worker = std::thread::spawn(move || {
            let remote = PagedEvents {
                body: Vec::new(),
                id: "0".repeat(64),
                gets: AtomicUsize::new(0),
            };
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            started_tx.send(()).unwrap();
            let result = runtime.block_on(flush(&path, &remote, "device-writer"));
            done_tx.send(result).unwrap();
        });
        started_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        let early = done_rx.recv_timeout(std::time::Duration::from_millis(500));
        let waiting = matches!(early, Err(std::sync::mpsc::RecvTimeoutError::Timeout));
        let exists_before_unlock = open_database(&db).unwrap().query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='cloud_device_applied'", [], |r| r.get::<_, usize>(0)
        ).unwrap();
        drop(writer); // Always release before any assertion; the rejected old path must terminate.
        let result = match early {
            Ok(result) => result,
            Err(_) => done_rx
                .recv_timeout(std::time::Duration::from_secs(10))
                .unwrap(),
        };
        worker.join().unwrap();
        result.unwrap();
        assert!(waiting, "device schema bypassed the shared writer gate");
        assert_eq!(
            exists_before_unlock, 0,
            "DDL became visible before acquiring the writer"
        );
        let c = open_database(&db).unwrap();
        assert_eq!(c.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='cloud_device_applied'", [], |r| r.get::<_, usize>(0)).unwrap(), 1);
        assert_eq!(
            c.query_row("SELECT count(*) FROM cloud_device_pending", [], |r| r
                .get::<_, usize>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            c.query_row("SELECT count(*) FROM cloud_device_applied", [], |r| r
                .get::<_, usize>(0))
                .unwrap(),
            0
        );
    }
}
