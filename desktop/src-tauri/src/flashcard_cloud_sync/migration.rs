//! Durable copy of immutable cloud objects. Never deletes either source or target objects.
use super::*;
use crate::reading_sync::object_store::{self, Configuration, Store};
mod inventory;
const PREFIXES: &[&str] = &[
    "reading/v1/changes/",
    "reading/media-v1/manifests/",
    "reading/media-v1/blobs/",
    "reading/copies-v1/changes/",
    "reading/source-v1/",
    "reading/devices-v1/",
    "reading/checkpoints-v1/",
];
fn schema(c: &Connection) -> Result<(), String> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS cloud_migration_runs(id TEXT PRIMARY KEY,source TEXT NOT NULL,target TEXT NOT NULL,state TEXT NOT NULL,error TEXT NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS cloud_migration_objects(job TEXT NOT NULL,object_key TEXT NOT NULL,state TEXT NOT NULL,size INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(job,object_key));
    CREATE TABLE IF NOT EXISTS cloud_migration_references(job TEXT NOT NULL,hash TEXT NOT NULL,size INTEGER NOT NULL,mime TEXT NOT NULL,PRIMARY KEY(job,hash));
    CREATE TABLE IF NOT EXISTS cloud_migration_card_refs(job TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(job,hash));
    CREATE TABLE IF NOT EXISTS cloud_migration_verifications(job TEXT PRIMARY KEY,scope TEXT NOT NULL,attempt TEXT NOT NULL,state TEXT NOT NULL,total INTEGER NOT NULL,source_keys TEXT NOT NULL,target_keys TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS cloud_migration_checks(attempt TEXT NOT NULL,side TEXT NOT NULL,object_key TEXT NOT NULL,size INTEGER NOT NULL,PRIMARY KEY(attempt,side,object_key));
    CREATE TABLE IF NOT EXISTS cloud_migration_payloads(job TEXT NOT NULL,object_key TEXT NOT NULL,body BLOB NOT NULL,PRIMARY KEY(job,object_key));").map_err(|e|e.to_string())?;
    inventory::schema(c)
}
fn limit(relative: &str) -> Result<usize, String> {
    if relative.starts_with("reading/media-v1/blobs/") {
        return Ok(100 * 1024 * 1024);
    }
    if relative.starts_with("media/") {
        return Ok(FLASHCARD_SYNC_MAX_MEDIA_BYTES as usize);
    }
    if relative.starts_with("changes/") || relative.starts_with("reading/checkpoints-v1/proofs/") {
        return Ok(FLASHCARD_SYNC_MAX_SNAPSHOT_BYTES);
    }
    if relative.starts_with("reading/media-v1/manifests/") {
        return Ok(16 * 1024);
    }
    if relative.starts_with("reading/copies-v1/changes/") {
        return Ok(64 * 1024);
    }
    if PREFIXES.iter().any(|p| relative.starts_with(p)) {
        return Ok(2 * 1024 * 1024);
    }
    Err("迁移对象不属于已知模块".into())
}
fn identity(relative: &str) -> Result<&str, String> {
    let name = relative
        .rsplit('/')
        .next()
        .ok_or("迁移对象身份缺失")?
        .trim_end_matches(".json");
    let name = if relative.starts_with("changes/") {
        name.rsplit('-').next().ok_or("闪卡迁移对象身份缺失")?
    } else {
        name
    };
    if name.len() != 64
        || !name
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("迁移对象身份不是 SHA256".into());
    }
    Ok(name)
}
fn validate(relative: &str, bytes: &[u8], scratch: &Connection, ns: &str) -> Result<(), String> {
    if bytes.len() > limit(relative)? || hash_bytes(bytes) != identity(relative)? {
        return Err("迁移云对象内容身份或大小不一致".into());
    }
    if relative.starts_with("reading/v1/changes/") {
        return reading_sync::maintenance_import(scratch, bytes);
    }
    if relative.starts_with("reading/media-v1/manifests/") {
        return reading_sync::media::maintenance_import(scratch, ns, bytes);
    }
    if relative.starts_with("reading/copies-v1/changes/") {
        return reading_sync::copies::maintenance_import(scratch, ns, bytes);
    }
    if relative.starts_with("changes/") {
        let change: Change = serde_json::from_slice(bytes).map_err(|_| "闪卡迁移对象格式无效")?;
        if change.format != "hub-flashcard-changes" || !matches!(change.version, 2 | 3 | 4) {
            return Err("闪卡迁移协议不受支持".into());
        }
        return flashcard_scheduler::validate_snapshot(&change.snapshot);
    }
    if relative.ends_with(".json") {
        let value: Value =
            serde_json::from_slice(bytes).map_err(|_| "迁移扩展对象不是有效 JSON")?;
        if !value.is_object() {
            return Err("迁移扩展对象格式无效".into());
        }
    }
    Ok(())
}
fn hash_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
/// Caller holds both synchronization locks. A failed/partial run leaves active configuration intact.
async fn copy_inner(
    db: &PathBuf,
    source: &dyn Store,
    target: &dyn Store,
    source_config: &Configuration,
    target_config: &Configuration,
    all: bool,
) -> Result<(), String> {
    let source_ns = source_config.namespace();
    let target_ns = target_config.namespace();
    let scope =
        serde_json::to_vec(&(source_config, target_config, all)).map_err(|e| e.to_string())?;
    let job = hash_bytes(&scope);
    let keys = inventory::acquire(db, source, &source_ns, &job, "source", "copy", all).await?;
    {
        let (mut c, _writer) = open_write_database(db)?;
        schema(&c)?;
        let tx = c.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM cloud_migration_payloads WHERE job<>?1", [&job])
            .map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO cloud_migration_runs VALUES(?1,?2,?3,'running','',?4) ON CONFLICT(id) DO UPDATE SET state='running',error='',updated_at=excluded.updated_at",params![job,source_ns,target_ns,now_timestamp()]).map_err(|e|e.to_string())?;
        keys.ensure_complete(&tx)?;
        tx.execute("INSERT OR IGNORE INTO cloud_migration_objects(job,object_key,state) SELECT ?1,key,'pending' FROM cloud_migration_inventory_keys WHERE batch=?2",params![job,keys.id]).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
    }
    let result=async {
        let scratch=Connection::open_in_memory().map_err(|e|e.to_string())?;
        scratch.execute_batch("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);").map_err(|e|e.to_string())?;
        x_bookmarks::storage::schema(&scratch)?;
        let mut copied=0;
        while let Some(next)=keys.next(&open_database(db)?,&job,None)? {
            let relative=&next;
            if copied>=100 {return Err("本批迁移已完成 100 个对象，原服务保持；再次执行可继续剩余对象".into());}
            let source_key=source.key(relative);let target_key=target.key(relative);
            source.check_network(&source_key)?;target.check_network(&target_key)?;
            let size=source.head_size(&source_key).await?.ok_or("迁移期间源对象已缺失")?;
            if size==0||size>limit(relative)? as u64 {return Err("迁移对象超过允许大小或为空".into());}
            let staged:Option<Vec<u8>>=open_database(db)?.query_row("SELECT body FROM cloud_migration_payloads WHERE job=?1 AND object_key=?2",params![job,relative],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
            let bytes=match staged {Some(v)=>v,None=>source.get(&source_key,size as usize).await?.ok_or("迁移期间源对象已缺失")?};
            if bytes.len() as u64!=size {return Err("迁移期间源对象大小变化，原服务保持".into())}
            validate(relative,&bytes,&scratch,&source_ns)?;
            if relative.starts_with("changes/") {
                let change:Change=serde_json::from_slice(&bytes).map_err(|_|"闪卡迁移协议无效")?;
                let (c,_writer)=open_write_database(db)?;
                for digest in flashcard_snapshot_media_hashes(&change.snapshot) {c.execute("INSERT OR IGNORE INTO cloud_migration_card_refs VALUES(?1,?2)",params![job,digest]).map_err(|e|e.to_string())?;}
            }
            if relative.starts_with("reading/source-v1/") {
                for (digest,mime,blob_size) in x_bookmarks::dida_reading::source_recovery::migration_inventory(&bytes)? {
                    register_reference(db,&job,&digest,blob_size,&mime)?;
                }
            }
            if relative.starts_with("reading/media-v1/manifests/") {
                let m:Value=serde_json::from_slice(&bytes).map_err(|_|"附件迁移清单无效")?;
                if m["state"]=="ready" {
                    let digest=m["hash"].as_str().ok_or("原附件身份缺失")?;
                    let blob_size=m["size"].as_u64().ok_or("原附件大小缺失")?;
                    let mime=m["mime"].as_str().ok_or("原附件格式缺失")?;
                    register_reference(db,&job,digest,blob_size,mime)?;
                }
            }
            if relative.starts_with("reading/media-v1/blobs/") {
                let expected:Option<(u64,String)>=open_database(db)?.query_row("SELECT size,mime FROM cloud_migration_references WHERE job=?1 AND hash=?2",params![job,identity(relative)?],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e|e.to_string())?;
                if let Some((size,mime))=expected {if bytes.len() as u64!=size||!infer::get(&bytes).is_some_and(|v|v.mime_type()==mime) {return Err("源云原附件实际大小或格式校验失败".into());}}
            }
            {let(c,_writer)=open_write_database(db)?;c.execute("INSERT OR REPLACE INTO cloud_migration_payloads VALUES(?1,?2,?3)",params![job,relative,bytes]).map_err(|e|e.to_string())?;}
            target.put_verified(&target_key,&bytes).await?;
            // put_verified includes actual readback. The separate verification epoch reads both clouds again.
            let (c,_writer)=open_write_database(db)?;
            if relative.starts_with("reading/media-v1/manifests/") {reading_sync::media::maintenance_import(&c,&target_ns,&bytes)?;}
            if relative.starts_with("reading/copies-v1/changes/") {reading_sync::copies::maintenance_import(&c,&target_ns,&bytes)?;}
            c.execute("UPDATE cloud_migration_objects SET state='verified',size=?3 WHERE job=?1 AND object_key=?2",params![job,relative,size]).map_err(|e|e.to_string())?;
            c.execute("DELETE FROM cloud_migration_payloads WHERE job=?1 AND object_key=?2",params![job,relative]).map_err(|e|e.to_string())?;
            copied+=1;
        }
        if !keys.dependencies(&open_database(db)?,&job)? {return Err("源云历史内容引用的原附件已缺失，原服务保持，不能声称全模块迁移完成".into());}
        let source_final=inventory::acquire(db,source,&source_ns,&job,"source","copyRecheck",all).await?;
        if !keys.equal(&open_database(db)?,&source_final)? {return Err("源云空间在迁移期间变化；请让其它设备暂停后重试，原服务保持".into());}
        let target_keys=inventory::acquire(db,target,&target_ns,&job,"target","copy",all).await?;
        if !target_keys.covers(&open_database(db)?,&keys)? {return Err("迁移目标存在未确认对象，原服务保持".into());}
        verify_objects(db,source,target,source_config,target_config,all,&job,&keys,&target_keys).await?;
        Ok::<(),String>(())
    }.await;
    let (c, _writer) = open_write_database(db)?;
    if let Err(error) = &result {
        if !error.contains("额度") && !error.contains("100 个对象") {
            c.execute(
                "UPDATE cloud_migration_verifications SET state='failed' WHERE job=?1",
                [&job],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    c.execute(
        "UPDATE cloud_migration_runs SET state=?2,error=?3,updated_at=?4 WHERE id=?1",
        params![
            job,
            if result.is_ok() {
                "verified"
            } else {
                "partial"
            },
            result.as_ref().err().cloned().unwrap_or_default(),
            now_timestamp()
        ],
    )
    .map_err(|e| e.to_string())?;
    let copied = inventory::receipt_count(&c, "copy", &job)?;
    let header: Option<(String, usize)> = c
        .query_row(
            "SELECT attempt,total FROM cloud_migration_verifications WHERE job=?1",
            [&job],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let verification = header
        .map(|(attempt, total)| {
            inventory::receipt_count(&c, "check", &attempt).map(|checked| (checked, total))
        })
        .transpose()?;
    meta(&c,"cloud_migration_report",&json!({"source":source_ns,"target":target_ns,"state":if result.is_ok(){"verified"}else{"partial"},"phase":if verification.is_some(){"verification"}else{"copy"},"copied":copied,"total":keys.count(&c)?,"verified":verification.map(|v|v.0).unwrap_or(0),"verifyTotal":verification.map(|v|v.1).unwrap_or(0),"error":result.as_ref().err(),"updatedAt":now_timestamp()}).to_string())?;
    inventory::retire(&c, &job)?;
    result
}
pub(super) async fn drain_reading(
    db: &PathBuf,
    remote: &dyn Store,
    ns: &str,
    device: &str,
) -> Result<(), String> {
    // Bounded foreground attempts; larger backlogs remain durable and continue on the next request.
    for pass in 0..4 {
        let body = reading_sync::sync_database(db, remote, ns, device).await?;
        let copies = reading_sync::copies::sync(db, remote, ns, device).await?;
        let media = reading_sync::media::sync(db, remote, ns, device).await?;
        if pass > 0
            && reading_sync::migration_pending(&body, &copies, &media) == 0
            && reading_sync::migration_body_ready(&open_database(db)?, ns)?
        {
            return Ok(());
        }
    }
    Err("阅读仍有待同步内容或附件；原服务保持，请完成同步后再次迁移".into())
}

fn register_reference(
    db: &PathBuf,
    job: &str,
    digest: &str,
    size: u64,
    mime: &str,
) -> Result<(), String> {
    let (c, _writer) = open_write_database(db)?;
    let existing: Option<(u64, String)> = c
        .query_row(
            "SELECT size,mime FROM cloud_migration_references WHERE job=?1 AND hash=?2",
            params![job, digest],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if existing.is_some_and(|v| v != (size, mime.to_string())) {
        return Err("源云共享原附件清单声明冲突".into());
    }
    c.execute(
        "INSERT OR IGNORE INTO cloud_migration_references VALUES(?1,?2,?3,?4)",
        params![job, digest, size, mime],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

// The whole migration, including formal producers/consumers, shares one byte allowance.
// Module switches apply to ordinary sync; the explicit migration includes their cloud history.
struct Metered<'a> {
    inner: &'a dyn Store,
    db: &'a PathBuf,
    policy: reading_sync::media::Policy,
    budget: Arc<Mutex<reading_sync::media::MigrationBudget>>,
}
impl Store for Metered<'_> {
    fn key(&self, r: &str) -> String {
        self.inner.key(r)
    }
    fn check_network(&self, k: &str) -> Result<(), String> {
        self.inner.check_network(k)
    }
    fn head_size<'a>(
        &'a self,
        k: &'a str,
    ) -> futures::future::BoxFuture<'a, Result<Option<u64>, String>> {
        self.inner.head_size(k)
    }
    fn get<'a>(
        &'a self,
        k: &'a str,
        max: usize,
    ) -> futures::future::BoxFuture<'a, Result<Option<Vec<u8>>, String>> {
        Box::pin(async move {
            self.inner.check_network(k)?;
            let Some(size) = self.inner.head_size(k).await? else {
                return Ok(None);
            };
            if size > max as u64 {
                return Err("迁移读取超过对象大小上限".into());
            }
            let allowance = self.budget.lock().map_err(|_| "迁移额度锁不可用")?.clone();
            let result = if k.starts_with(&self.inner.key("reading/")) {
                allowance
                    .get(self.db, &self.policy, self.inner, k, max)
                    .await?
            } else {
                self.inner.get(k, max).await?
            };
            if result.as_ref().is_some_and(|v| v.len() as u64 != size) {
                return Err("迁移对象在读取期间变化".into());
            }
            Ok(result)
        })
    }
    #[cfg(test)]
    fn list<'a>(
        &'a self,
        r: &'a str,
    ) -> futures::future::BoxFuture<'a, Result<Vec<String>, String>> {
        self.inner.list(r)
    }
    fn inventory_page<'a>(
        &'a self,
        r: &'a str,
        continuation: Option<&'a str>,
    ) -> futures::future::BoxFuture<
        'a,
        Result<crate::reading_sync::object_store::InventoryPage, String>,
    > {
        self.inner.inventory_page(r, continuation)
    }
    fn put_verified<'a>(
        &'a self,
        k: &'a str,
        b: &'a [u8],
    ) -> futures::future::BoxFuture<'a, Result<bool, String>> {
        Box::pin(async move {
            let allowance = self.budget.lock().map_err(|_| "迁移额度锁不可用")?.clone();
            if k.starts_with(&self.inner.key("reading/")) {
                allowance.put(self.db, &self.policy, self.inner, k, b).await
            } else {
                self.inner.put_verified(k, b).await
            }
        })
    }
    fn delete_exact<'a>(
        &'a self,
        _: &'a str,
    ) -> futures::future::BoxFuture<'a, Result<(), String>> {
        Box::pin(async { Err("迁移不申请删除权限".into()) })
    }
}
#[cfg(test)]
pub(super) async fn copy(
    db: &PathBuf,
    source: &dyn Store,
    target: &dyn Store,
    source_config: &Configuration,
    target_config: &Configuration,
    all: bool,
) -> Result<(), String> {
    if !cloud_sync::policy(&open_database(db)?).enabled {
        return Err("云同步总开关已关闭".into());
    }
    let policy = reading_sync::media::migration_policy(&open_database(db)?)?;
    let budget = Arc::new(Mutex::new(reading_sync::media::MigrationBudget::new(
        &policy,
    )));
    let a = Metered {
        inner: source,
        db,
        policy: policy.clone(),
        budget: budget.clone(),
    };
    let b = Metered {
        inner: target,
        db,
        policy,
        budget,
    };
    copy_inner(db, &a, &b, source_config, target_config, all).await
}

pub(crate) struct Receipt {
    source: Option<Configuration>,
    provider: String,
    revision: u64,
    reading_token: String,
    flashcard_token: String,
}
impl Receipt {
    pub(crate) fn verify(&self, c: &Connection) -> Result<(), String> {
        if !cloud_sync::policy(c).enabled
            || provider(c) != self.provider
            || object_store::configuration(c).ok() != self.source
            || metadata_u64(c, "flashcard_sync_revision", 0) != self.revision
            || flashcard_token(c)? != self.flashcard_token
            || reading_sync::migration_domain_identity(c)? != self.reading_token
        {
            return Err("迁移期间本机内容、连接或总开关变化；原服务保持，请重新迁移".into());
        }
        Ok(())
    }
}
fn receipt(c: &Connection) -> Result<Receipt, String> {
    Ok(Receipt {
        source: object_store::configuration(c).ok(),
        provider: provider(c),
        revision: metadata_u64(c, "flashcard_sync_revision", 0),
        reading_token: reading_sync::migration_domain_token(c)?,
        flashcard_token: flashcard_token(c)?,
    })
}
/// Caller holds flashcard, reading and quick-journal locks, in that order, through final commit.
pub(super) async fn prepare(
    app: &AppHandle,
    target_config: &Configuration,
    target_secret: Option<String>,
    ready: bool,
) -> Result<Receipt, String> {
    if !ready {
        return Err("请先让其它设备完成同步并暂停原服务，再迁移全部模块".into());
    }
    let db = database_path(app)?;
    let c = open_database(&db)?;
    if !cloud_sync::policy(&c).enabled {
        return Err("请先开启本设备云同步总开关，再迁移全部模块".into());
    }
    let journal_table:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='quick_journal_records')",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    if journal_table
        && c.query_row(
            "SELECT EXISTS(SELECT 1 FROM quick_journal_records WHERE namespace<>'')",
            [],
            |r| r.get::<_, bool>(0),
        )
        .map_err(|e| e.to_string())?
    {
        return Err("速记已绑定当前云空间，尚不支持随连接迁移；原连接及内容保留".into());
    }
    let source_config = object_store::configuration(&c).ok();
    let source = source_config
        .as_ref()
        .map(|cfg| object_store::configured_store(app, &c, cfg, None))
        .transpose()?;
    let target = object_store::configured_store(app, &c, target_config, target_secret.clone())?;
    let device = flashcard_sync_device_id(&c)?;
    let policy = reading_sync::media::migration_policy(&c)?;
    drop(c);
    let allowance = Arc::new(Mutex::new(reading_sync::media::MigrationBudget::new(
        &policy,
    )));
    let target = Metered {
        inner: &*target,
        db: &db,
        policy: policy.clone(),
        budget: allowance.clone(),
    };
    if let (Some(config), Some(source)) = (&source_config, &source) {
        let source = Metered {
            inner: &**source,
            db: &db,
            policy: policy.clone(),
            budget: allowance.clone(),
        };
        sync_configuration(app, config, None).await?;
        drain_reading(&db, &source, &config.namespace(), &device).await?;
    }
    sync_configuration(app, target_config, target_secret).await?;
    drain_reading(&db, &target, &target_config.namespace(), &device).await?;
    let before = receipt(&open_database(&db)?)?;
    if let (Some(config), Some(source)) = (&source_config, &source) {
        let source = Metered {
            inner: &**source,
            db: &db,
            policy,
            budget: allowance,
        };
        copy_inner(&db, &source, &target, config, target_config, true).await?;
    } else {
        copy_inner(&db, &target, &target, target_config, target_config, true).await?;
    }
    let final_check = before.verify(&open_database(&db)?);
    if let Err(error) = final_check {
        let (c, _writer) = open_write_database(&db)?;
        let mut report: Value =
            serde_json::from_str(&metadata_string(&c, "cloud_migration_report"))
                .unwrap_or_else(|_| json!({}));
        report["state"] = json!("partial");
        report["phase"] = json!("finalCheck");
        report["error"] = json!(error);
        report["updatedAt"] = json!(now_timestamp());
        meta(&c, "cloud_migration_report", &report.to_string())?;
        return Err(error);
    }
    Ok(before)
}
async fn sync_configuration(
    app: &AppHandle,
    config: &Configuration,
    secret: Option<String>,
) -> Result<(), String> {
    match config {
        Configuration::Oss { config } => {
            let remote = OssStore::new(
                config.clone(),
                secret.unwrap_or(stored_secret_get(app, OSS_SECRET)?.unwrap_or_default()),
            )?;
            let state = app.state::<AppState>();
            let blobs = blob_store_for(app, &state)?;
            sync_database(
                &remote,
                &database_path(app)?,
                &blobs,
                &config.namespace(),
                true,
                false,
            )
            .await
            .map(|_| ())
        }
    }
}
async fn verify_objects(
    db: &PathBuf,
    source: &dyn Store,
    target: &dyn Store,
    source_config: &Configuration,
    target_config: &Configuration,
    all: bool,
    job: &str,
    source_keys: &inventory::Inventory,
    target_keys: &inventory::Inventory,
) -> Result<(), String> {
    let c = open_database(db)?;
    let domain = reading_sync::migration_domain_token(&c)?;
    let scope = hash_bytes(
        &serde_json::to_vec(&(
            source_config,
            target_config,
            all,
            &domain,
            flashcard_token(&c)?,
            metadata_u64(&c, "flashcard_sync_revision", 0),
        ))
        .map_err(|e| e.to_string())?,
    );
    drop(c);
    let attempt = {
        let (mut c, _writer) = open_write_database(db)?;
        let tx = c.transaction().map_err(|e| e.to_string())?;
        source_keys.ensure_complete(&tx)?;
        target_keys.ensure_complete(&tx)?;
        let old: Option<(String, String, String)> = tx
            .query_row(
                "SELECT scope,attempt,state FROM cloud_migration_verifications WHERE job=?1",
                [job],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let reusable = if let Some((old_scope, old_attempt, state)) = &old {
            if old_scope == &scope && state == "running" {
                match (
                    inventory::previous(&tx, job, old_attempt, "source")?,
                    inventory::previous(&tx, job, old_attempt, "target")?,
                ) {
                    (Some(a), Some(b)) => {
                        source_keys.append_heartbeats(&tx, &a)?
                            && target_keys.append_heartbeats(&tx, &b)?
                    }
                    _ => false,
                }
            } else {
                false
            }
        } else {
            false
        };
        let attempt = if reusable {
            old.as_ref().unwrap().1.clone()
        } else {
            if let Some(old) = &old {
                if let Ok(path) = verification_path(db, &old.1) {
                    let _ = fs::remove_file(path);
                }
            }
            random_url_safe(24)
        };
        let total = source_keys
            .count(&tx)?
            .checked_add(target_keys.count(&tx)?)
            .ok_or("迁移核验总数超出范围")?;
        tx.execute("INSERT INTO cloud_migration_verifications VALUES(?1,?2,?3,'running',?4,'[]','[]') ON CONFLICT(job) DO UPDATE SET scope=excluded.scope,attempt=excluded.attempt,state='running',total=excluded.total",params![job,scope,attempt,total]).map_err(|e|e.to_string())?;
        inventory::compatibility(&tx, job, &attempt, source_keys, target_keys)?;
        tx.commit().map_err(|e| e.to_string())?;
        attempt
    };
    let scratch = Connection::open(verification_path(db, &attempt)?).map_err(|e| e.to_string())?;
    scratch
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);",
        )
        .map_err(|e| e.to_string())?;
    x_bookmarks::storage::schema(&scratch)?;
    let mut checked = 0;
    for (side, remote, config, keys) in [
        ("source", source, source_config, source_keys),
        ("target", target, target_config, target_keys),
    ] {
        let refs_job = format!("{attempt}:{side}");
        while let Some(next) = keys.next(&open_database(db)?, job, Some((&attempt, side)))? {
            let relative = &next;
            if checked >= 100 {
                return Err(
                    "本轮已读取核验 100 个对象；本次核验游标已保存，原服务保持，再次执行继续"
                        .into(),
                );
            }
            let key = remote.key(relative);
            remote.check_network(&key)?;
            let size = remote
                .head_size(&key)
                .await?
                .ok_or("核验期间云对象缺失，原服务保持")?;
            if size == 0 || size > limit(relative)? as u64 {
                return Err("核验对象大小无效，原服务保持".into());
            }
            let bytes = remote
                .get(&key, size as usize)
                .await?
                .ok_or("核验期间云对象缺失，原服务保持")?;
            validate(relative, &bytes, &scratch, &config.namespace())?;
            if relative.starts_with("changes/") {
                let change: Change =
                    serde_json::from_slice(&bytes).map_err(|_| "闪卡核验协议无效")?;
                let (c, _writer) = open_write_database(db)?;
                for h in flashcard_snapshot_media_hashes(&change.snapshot) {
                    c.execute(
                        "INSERT OR IGNORE INTO cloud_migration_card_refs VALUES(?1,?2)",
                        params![refs_job, h],
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
            if relative.starts_with("reading/source-v1/") {
                for (h, m, n) in
                    x_bookmarks::dida_reading::source_recovery::migration_inventory(&bytes)?
                {
                    register_reference(db, &refs_job, &h, n, &m)?;
                }
            }
            if relative.starts_with("reading/media-v1/manifests/") {
                let m: Value = serde_json::from_slice(&bytes).map_err(|_| "核验附件清单无效")?;
                if m["state"] == "ready" {
                    register_reference(
                        db,
                        &refs_job,
                        m["hash"].as_str().ok_or("附件身份缺失")?,
                        m["size"].as_u64().ok_or("附件大小缺失")?,
                        m["mime"].as_str().ok_or("附件格式缺失")?,
                    )?;
                }
                let (c, _writer) = open_write_database(db)?;
                reading_sync::media::maintenance_import(&c, &config.namespace(), &bytes)?;
            }
            if relative.starts_with("reading/copies-v1/changes/") {
                let (c, _writer) = open_write_database(db)?;
                reading_sync::copies::maintenance_import(&c, &config.namespace(), &bytes)?;
            }
            if relative.starts_with("reading/media-v1/blobs/") {
                let expected: Option<(u64, String)> = open_database(db)?
                    .query_row(
                        "SELECT size,mime FROM cloud_migration_references WHERE job=?1 AND hash=?2",
                        params![refs_job, identity(relative)?],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()
                    .map_err(|e| e.to_string())?;
                if let Some((n, m)) = expected {
                    if bytes.len() as u64 != n
                        || !infer::get(&bytes).is_some_and(|v| v.mime_type() == m)
                    {
                        return Err("核验原附件实际格式或大小不一致".into());
                    }
                }
            }
            let (c, _writer) = open_write_database(db)?;
            c.execute(
                "INSERT INTO cloud_migration_checks VALUES(?1,?2,?3,?4) ON CONFLICT(attempt,side,object_key) DO UPDATE SET size=excluded.size",
                params![attempt, side, relative, size],
            )
            .map_err(|e| e.to_string())?;
            checked += 1;
        }
        if !keys.dependencies(&open_database(db)?, &refs_job)? {
            return Err("云端历史正文或来源回执所需原附件缺失，原服务保持".into());
        }
    }
    let source_final = inventory::acquire(
        db,
        source,
        &source_config.namespace(),
        job,
        "source",
        "verifyRecheck",
        all,
    )
    .await?;
    let target_final = inventory::acquire(
        db,
        target,
        &target_config.namespace(),
        job,
        "target",
        "verifyRecheck",
        all,
    )
    .await?;
    if !source_keys.equal(&open_database(db)?, &source_final)?
        || !target_keys.equal(&open_database(db)?, &target_final)?
    {
        return Err("核验期间源或目标云清单变化，原服务保持；再次执行将重新核验".into());
    }
    let c = open_database(db)?;
    let current_scope = hash_bytes(
        &serde_json::to_vec(&(
            source_config,
            target_config,
            all,
            reading_sync::migration_domain_token(&c)?,
            flashcard_token(&c)?,
            metadata_u64(&c, "flashcard_sync_revision", 0),
        ))
        .map_err(|e| e.to_string())?,
    );
    if current_scope != scope {
        return Err("核验期间本机阅读或闪卡版本变化，原服务保持".into());
    }
    drop(c);
    let (c, _writer) = open_write_database(db)?;
    c.execute("UPDATE cloud_migration_verifications SET state='complete' WHERE job=?1 AND scope=?2 AND attempt=?3",params![job,scope,attempt]).map_err(|e|e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests;

fn verification_path(db: &PathBuf, attempt: &str) -> Result<PathBuf, String> {
    if attempt.len() != 32
        || !attempt
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Err("迁移核验尝试身份无效".into());
    }
    Ok(db
        .parent()
        .ok_or("迁移数据库目录缺失")?
        .join(format!(".cloud-migration-verification-{attempt}.sqlite3")))
}

fn flashcard_token(c: &Connection) -> Result<String, String> {
    crate::flashcard_snapshot::records::content_hash(c)
}
