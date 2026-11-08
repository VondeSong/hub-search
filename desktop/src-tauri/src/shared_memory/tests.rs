use super::*;
#[path = "tests/live_continuity.rs"]
mod live_continuity;
#[path = "tests/proposals.rs"]
mod proposal_tests;
use crate::source_evidence::tests::Fixture;

struct Local {
    root: PathBuf,
    writes: usize,
    visible: bool,
}
impl Local {
    fn new(f: &Fixture) -> Self {
        Self {
            root: f.root.clone(),
            writes: 0,
            visible: true,
        }
    }
}
impl Backend for Local {
    fn write(&mut self, id: &str, body: &str) -> Result<(), String> {
        self.writes += 1;
        let p = path(&self.root, id, false)?;
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, format!("---\ntitle: {id}\n---\n\n{body}")).unwrap();
        Ok(())
    }
    fn ready(&mut self, id: &str) -> Result<bool, String> {
        Ok(self.visible && path(&self.root, id, false)?.exists())
    }
    fn search(&mut self, _: &str, _: &[String]) -> Result<Vec<String>, String> {
        let p = self.root.join("shared-memory/notes");
        if !p.exists() {
            return Ok(vec![]);
        }
        Ok(fs::read_dir(p)
            .unwrap()
            .map(|e| {
                e.unwrap()
                    .path()
                    .file_stem()
                    .unwrap()
                    .to_string_lossy()
                    .into()
            })
            .collect())
    }
    fn delete(&mut self, id: &str) -> Result<(), String> {
        let p = path(&self.root, id, false)?;
        if p.exists() {
            fs::remove_file(p).unwrap();
        }
        Ok(())
    }
}
fn request(key: &str, version: i64, content: &str) -> Value {
    json!({"title":"后端决定","topicKey":"memory-backend","projectId":"","kind":"decision",
        "body":content,"expectedVersion":version,"confirmed":true,"requestKey":key})
}
fn save(f: &Fixture, b: &mut impl Backend, request: &Value) -> Item {
    let item = stage(&f.root, request).unwrap();
    publish(&f.root, &item, b).unwrap();
    load(&f.c(), &item.id).unwrap()
}
#[test]
fn immutable_versions_and_idempotent_replay_never_overwrite_accepted_markdown() {
    let f = Fixture::new();
    let mut b = Local::new(&f);
    let first = save(&f, &mut b, &request("one", 0, "使用 Basic Memory。"));
    let repeated = stage(&f.root, &request("one", 0, "使用 Basic Memory。")).unwrap();
    publish(&f.root, &repeated, &mut b).unwrap();
    assert_eq!(b.writes, 1);
    let old_context = select(&f.root, "", "后端", &mut b).unwrap();
    let second = save(
        &f,
        &mut b,
        &request("two", 1, "Basic Memory 保存 Markdown，Hub 管理确认。"),
    );
    assert_ne!(first.revision_id, second.revision_id);
    assert_eq!(body(&f.root, &first).unwrap(), "使用 Basic Memory。");
    assert!(verify(&f.root, &old_context).is_err());
    let context = select(&f.root, "", "后端", &mut b).unwrap();
    assert_eq!(context.decisions.len(), 1);
    assert_eq!(context.items[0].version, 2);
    assert!(stage(&f.root, &request("conflict", 1, "另一个决定")).is_err());
    assert!(stage(&f.root, &request("one", 0, "改变重复请求")).is_err());
}
#[test]
fn pending_unconfirmed_inactive_and_wrong_project_never_enter_context() {
    let f = Fixture::new();
    let mut b = Local::new(&f);
    f.c()
        .execute(
            "INSERT INTO memory_projects VALUES('alpha','甲'),('beta','乙')",
            [],
        )
        .unwrap();
    let mut req = request("project", 0, "甲项目秘密");
    req["projectId"] = json!("alpha");
    let item = save(&f, &mut b, &req);
    assert!(select(&f.root, "beta", "秘密", &mut b)
        .unwrap()
        .decisions
        .is_empty());
    assert_eq!(
        select(&f.root, "alpha", "秘密", &mut b)
            .unwrap()
            .decisions
            .len(),
        1
    );
    req["confirmed"] = json!(false);
    assert!(stage(&f.root, &req).is_err());
    f.c()
        .execute(
            "UPDATE memory_entries SET state='inactive' WHERE id=?1",
            [&item.id],
        )
        .unwrap();
    assert!(select(&f.root, "alpha", "秘密", &mut b)
        .unwrap()
        .decisions
        .is_empty());
    stage(&f.root, &request("pending", 0, "未发布内容")).unwrap();
    assert!(select(&f.root, "", "未发布", &mut b)
        .unwrap()
        .decisions
        .is_empty());
}
#[test]
fn external_edit_is_never_trusted_and_rules_cannot_be_silently_truncated() {
    let f = Fixture::new();
    let mut b = Local::new(&f);
    let mut req = request("rule", 0, &"规则".repeat(400));
    req["kind"] = json!("rule");
    let item = save(&f, &mut b, &req);
    assert!(select(&f.root, "", "规则", &mut b)
        .unwrap_err()
        .contains("预算"));
    fs::write(
        path(&f.root, &item.revision_id, false).unwrap(),
        "用户没有确认的外部修改",
    )
    .unwrap();
    assert!(select(&f.root, "", "规则", &mut b)
        .unwrap_err()
        .contains("重新确认"));
}
#[test]
fn interrupted_publish_reconciles_existing_file_without_second_write() {
    let f = Fixture::new();
    let mut b = Local::new(&f);
    let item = stage(&f.root, &request("resume", 0, "只写一次")).unwrap();
    b.write(&item.revision_id, "只写一次").unwrap();
    publish(&f.root, &item, &mut b).unwrap();
    assert_eq!(b.writes, 1);
    assert_eq!(load(&f.c(), &item.id).unwrap().state, "active");
}
#[test]
fn forget_removes_all_revision_bodies_and_blocks_old_request_replay() {
    let f = Fixture::new();
    let mut b = Local::new(&f);
    let first = save(&f, &mut b, &request("old", 0, "旧正文"));
    let second = save(&f, &mut b, &request("new", 1, "新正文"));
    forget(&f.root, &second.id, &mut b).unwrap();
    finish_forget(&f.root, &second.id).unwrap();
    for item in [&first, &second] {
        assert!(!path(&f.root, &item.revision_id, false).unwrap().exists());
    }
    assert!(select(&f.root, "", "正文", &mut b)
        .unwrap()
        .decisions
        .is_empty());
    assert!(stage(&f.root, &request("old", 0, "旧正文")).is_err());
    assert!(stage(&f.root, &request("resurrect", 0, "旧正文")).is_err());
}
#[test]
fn context_is_opt_in_and_unknown_project_is_rejected() {
    let f = Fixture::new();
    assert!(context(&f.root, "unbound", "hello").unwrap().is_none());
    let mut req = request("unknown", 0, "内容");
    req["projectId"] = json!("unknown");
    assert!(stage(&f.root, &req).is_err());
    assert!(path(&f.root, "../../outside", false).is_err());
}
#[test]
fn restored_backup_never_reactivates_historical_memory() {
    let f = Fixture::new();
    let mut b = Local::new(&f);
    let item = save(&f, &mut b, &request("backup", 0, "旧备份中的决定"));
    quarantine_restored(&f.c()).unwrap();
    assert_eq!(load(&f.c(), &item.id).unwrap().state, "review");
    assert!(select(&f.root, "", "决定", &mut b)
        .unwrap()
        .decisions
        .is_empty());
}
#[test]
fn full_backup_preserves_markdown_and_restores_it_without_active_authority() {
    use crate::data_backup::{backup, restore, BackupOptions};
    use std::sync::atomic::AtomicBool;
    let f = Fixture::new();
    let destination = Fixture::new();
    let mut b = Local::new(&f);
    let item = save(&f, &mut b, &request("archive", 0, "备份保留的明确决定"));
    let output = destination.root.join("memory.hubbackup");
    let cancel = AtomicBool::new(false);
    let options = BackupOptions {
        destination: output.to_string_lossy().into(),
        include_external_sources: false,
    };
    backup(&f.root, &options, &cancel, &mut |_| {}).unwrap();
    let target = destination.root.join("restored");
    restore(&output, &target, &cancel, &mut |_| {}).unwrap();
    let c = Connection::open(target.join("craft-search.sqlite3")).unwrap();
    assert_eq!(load(&c, &item.id).unwrap().state, "review");
    assert_eq!(body(&target, &item).unwrap(), "备份保留的明确决定");
    assert!(!target.join("memory-runtime-v1.json").exists());
}
#[test]
#[ignore = "requires explicitly supplied local Basic Memory and cached Chinese model"]
fn real_basic_memory_roundtrip() {
    let python = std::env::var_os("HUB_MEMORY_TEST_PYTHON").expect("explicit runtime");
    let model_cache = std::env::var_os("HUB_MEMORY_TEST_MODELS").expect("explicit cached model");
    let f = Fixture::new();
    let cfg = backend::RuntimeConfig {
        python: python.into(),
        model_cache: model_cache.into(),
    };
    let mut bm = BasicMemory::start(&f.root, &cfg).unwrap();
    let first = save(
        &f,
        &mut bm,
        &request(
            "real-one",
            0,
            "Hub 的记忆后端采用 Basic Memory，本地 Markdown 保存正文。",
        ),
    );
    assert!(bm.ready(&first.revision_id).unwrap());
    drop(bm);
    let mut bm = BasicMemory::start(&f.root, &cfg).unwrap();
    let second = save(
        &f,
        &mut bm,
        &request(
            "real-two",
            1,
            "Hub 的记忆后端采用 Basic Memory，记忆管理参考 Lore 的版本替代机制。",
        ),
    );
    let context = select(&f.root, "", "Hub 的记忆后端是什么", &mut bm).unwrap();
    assert_eq!(context.decisions.len(), 1);
    assert_eq!(context.items[0].revision_id, second.revision_id);
    let mut retained_request = request("retained", 0, "独立的项目决定应在遗忘其他主题后仍能检索。");
    retained_request["topicKey"] = json!("independent-topic");
    let retained = save(&f, &mut bm, &retained_request);
    drop(bm);
    fs::write(
        f.root.join("memory-runtime-v1.json"),
        serde_json::to_vec(&cfg).unwrap(),
    )
    .unwrap();
    ui(
        &f.root,
        &json!({"action":"forget","id":second.id,"confirmed":true}),
    )
    .unwrap();
    assert!(!f.root.join("cache/shared-memory-bm").exists());
    let mut bm = BasicMemory::start(&f.root, &cfg).unwrap();
    let remaining = select(&f.root, "", "独立的项目决定", &mut bm).unwrap();
    assert_eq!(remaining.decisions.len(), 1);
    assert_eq!(remaining.items[0].revision_id, retained.revision_id);
    assert!(!bm.ready(&first.revision_id).unwrap());
    assert!(!bm.ready(&second.revision_id).unwrap());
}

#[test]
#[ignore = "requires the produced distribution archive; runs its real interpreter and Chinese model"]
fn packaged_runtime_prepares_repairs_and_preserves_accepted_memory() {
    let archive =
        PathBuf::from(std::env::var_os("HUB_MEMORY_TEST_ARCHIVE").expect("distribution archive"));
    let f = Fixture::new();
    let began = Instant::now();
    let cfg = runtime::ensure_from(&f.root, &archive).unwrap();
    eprintln!("packaged runtime first preparation: {:?}", began.elapsed());
    assert!(cfg.python.starts_with(f.root.join("cache/memory")));
    assert!(!f.root.join("memory-runtime-v1.json").exists());
    let mut bm = BasicMemory::start(&f.root, &cfg).unwrap();
    let item = save(
        &f,
        &mut bm,
        &request(
            "packaged-real",
            0,
            "安装 Hub 后自动使用内置 Basic Memory，中文记忆正文保存在本地 Markdown。",
        ),
    );
    assert!(bm.ready(&item.revision_id).unwrap());
    drop(bm);
    let original = fs::read(path(&f.root, &item.revision_id, false).unwrap()).unwrap();
    runtime::forget_verification(&f.root);
    let began = Instant::now();
    let restarted = runtime::ensure_from(&f.root, &archive).unwrap();
    eprintln!(
        "packaged runtime restart verification: {:?}",
        began.elapsed()
    );
    assert_eq!(restarted.python, cfg.python);
    // Damage only a derived component; repair must leave accepted data intact.
    let damaged = cfg
        .python
        .parent()
        .unwrap()
        .join("Lib/site-packages/basic_memory/__init__.py");
    fs::write(&damaged, b"broken runtime fixture\n").unwrap();
    runtime::forget_verification(&f.root);
    let began = Instant::now();
    let repaired = runtime::ensure_from(&f.root, &archive).unwrap();
    eprintln!(
        "packaged runtime damaged component repair: {:?}",
        began.elapsed()
    );
    let mut bm = BasicMemory::start(&f.root, &repaired).unwrap();
    let selected = select(&f.root, "", "安装 Hub 如何使用中文记忆", &mut bm).unwrap();
    assert!(selected
        .items
        .iter()
        .any(|found| found.revision_id == item.revision_id));
    assert_eq!(
        original,
        fs::read(path(&f.root, &item.revision_id, false).unwrap()).unwrap()
    );
    assert_eq!(
        load(&database(&f.root).unwrap(), &item.id).unwrap().version,
        1
    );
}
