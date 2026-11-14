//! Explicit opt-in Windows integration with an owned child prefix and real OSS HTTP.
//! Configuration is read-only; the existing secret stays in memory and no remote DELETE exists.
#![cfg(target_os = "windows")]
use super::*;
use crate::collection_models::Media;
use crate::flashcard_object_store::{OssConfig, OssStore};
use crate::reading_sync::object_store::Store;
use base64::Engine as _;
use futures::future::BoxFuture;
use rusqlite::OpenFlags;
use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

const KEY: &str = "x:test-account:real-cloud-article";
const IMAGE: &str = "https://example.invalid/hub-isolated-integration.png";
const BODY: &str = "Hub 本轮隔离云联调：正文、阅读状态、标签与小图片。";
const MAX_OBJECTS: usize = 100;
const MAX_BYTES: usize = 64 * 1024;

#[test]
#[ignore = "explicit local follow-up fixture builder only; creates one fresh owned Windows profile, without cloud or credentials"]
fn prepare_followup_windows_reading_fixture_from_formal_producer() {
    use lopdf::{dictionary, Document, Object};
    use std::io::Write as _;

    let output = std::env::var_os("HUB_CLOUD_FOLLOWUP_SEED_ROOT")
        .map(PathBuf::from)
        .expect("本地 fixture builder 要求 HUB_CLOUD_FOLLOWUP_SEED_ROOT；缺失不能当作通过");
    assert!(output.is_absolute(), "fixture 输出必须为明确绝对路径");
    let expected_input = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join(".local")
        .join("cloud-followup-20261007")
        .join("runtime")
        .join("windows-a");
    let project = checked(
        fs::canonicalize(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .parent()
                .unwrap(),
        ),
        "核验 fixture 项目根",
    );
    for ancestor in project.ancestors() {
        assert!(ordinary_directory(ancestor), "项目根不能经过重解析点");
    }
    let expected = project
        .join(".local")
        .join("cloud-followup-20261007")
        .join("runtime")
        .join("windows-a");
    assert!(
        output == expected_input || output == expected,
        "fixture 输出必须是本轮准确 owned 目录"
    );
    let mut root = project.clone();
    for segment in [".local", "cloud-followup-20261007", "runtime", "windows-a"] {
        root.push(segment);
        if !root.exists() {
            checked(fs::create_dir(&root), "建立 fixture 普通目录");
        }
        assert!(
            ordinary_directory(&root),
            "fixture 目录不能是链接或重解析点"
        );
        let resolved = checked(fs::canonicalize(&root), "解析 fixture 目录");
        assert!(resolved.starts_with(&project), "fixture 不能超出项目根");
    }
    assert_eq!(checked(fs::canonicalize(&root), "核验输出根"), expected);
    let marker = root.join(".hub-isolated-runtime-v1");
    let entries = checked(fs::read_dir(&root), "核验 fixture 空目录")
        .map(|entry| checked(entry, "读取 fixture 目录项").path())
        .collect::<Vec<_>>();
    assert!(
        entries.is_empty() || (entries.len() == 1 && entries[0] == marker),
        "拒绝复用已有数据库、文件或外来 fixture 内容"
    );
    if marker.exists() {
        assert!(!fs::symlink_metadata(&marker)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            checked(fs::read(&marker), "读取 owned marker"),
            b"Hub isolated runtime v1\n"
        );
    } else {
        let mut file = checked(
            fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&marker),
            "建立 owned marker",
        );
        checked(
            file.write_all(b"Hub isolated runtime v1\n"),
            "保存 owned marker",
        );
        checked(file.sync_all(), "确认 owned marker 落盘");
    }
    let db = root.join("craft-search.sqlite3");
    assert!(!db.exists(), "不能覆盖已有 fixture 数据库");
    let mut c = checked(open_database(&db), "建立全新正式应用数据库");
    let full_key = "x:test-account:followup-full";
    let body_key = "x:test-account:followup-body";
    let image_url = "https://example.invalid/hub-followup-original.png";
    let document_url = "https://example.invalid/hub-followup-original.pdf";
    x_bookmarks::reading_sync_test_import(
        &mut c,
        Post {
            id: "followup-full".into(),
            text: "Hub 隔离联调完整文章：保留正文、状态、标签、PNG 与 PDF 原件。".into(),
            content_status: "full".into(),
            url: "https://example.invalid/hub-followup-full".into(),
            media: vec![
                Media {
                    kind: "photo".into(),
                    url: image_url.into(),
                    preview_url: String::new(),
                },
                Media {
                    kind: "document".into(),
                    url: document_url.into(),
                    preview_url: String::new(),
                },
            ],
            ..Post::default()
        },
    );
    x_bookmarks::reading_sync_test_import(
        &mut c,
        Post {
            id: "followup-body".into(),
            text: "Hub 隔离联调纯正文文章：独立核验正文恢复。".into(),
            content_status: "complete".into(),
            url: "https://example.invalid/hub-followup-body".into(),
            ..Post::default()
        },
    );
    checked(
        x_bookmarks::properties::save_local(
            &mut c,
            full_key,
            "in_progress",
            &["本轮迁移".into(), "有原件".into()],
        ),
        "正式保存完整文章状态和标签",
    );
    checked(
        x_bookmarks::properties::save_local(&mut c, body_key, "unread", &["纯正文".into()]),
        "正式保存纯正文文章状态和标签",
    );
    let originals = root.join("fixture-originals");
    checked(fs::create_dir(&originals), "建立小原件目录");
    let image = checked(base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE+0AAAAASUVORK5CYII="), "解码合成 PNG");
    let image_path = originals.join("original.png");
    checked(fs::write(&image_path, &image), "保存合成 PNG 原件");
    let document_path = originals.join("original.pdf");
    let mut pdf = Document::with_version("1.5");
    let pages = pdf.new_object_id();
    let page = pdf.add_object(dictionary! { "Type" => "Page", "Parent" => pages });
    pdf.objects.insert(
        pages,
        Object::Dictionary(dictionary! {
            "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1,
            "MediaBox" => vec![0.into(), 0.into(), 200.into(), 200.into()]
        }),
    );
    let catalog = pdf.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
    pdf.trailer.set("Root", catalog);
    checked(
        pdf.save(&document_path),
        "由 PDF 正式 serializer 生成小 PDF 原件",
    );
    let document = checked(fs::read(&document_path), "读回 PDF 原件");
    assert!(
        image.len() < 1024 && document.len() < 4096,
        "fixture 原件必须很小"
    );
    assert_eq!(
        checked(Document::load(&document_path), "实际解析生成的 PDF")
            .get_pages()
            .len(),
        1
    );
    for (url, path) in [(image_url, &image_path), (document_url, &document_path)] {
        checked(
            x_bookmarks::storage::record_saved_media(&c, full_key, url, path),
            "正式登记原件回执",
        );
    }
    let vault = root.join("fixture-vault");
    checked(fs::create_dir(&vault), "建立本轮本地副本目录");
    let destination = checked(
        x_bookmarks::library::register_root(&c, &vault),
        "正式登记本地副本目录",
    );
    checked(
        x_bookmarks::storage::commit_note(
            &c,
            &vault.join("followup-full.md"),
            "# Hub 隔离联调完整文章\n\n本轮合成资料库副本。",
            None,
            &destination,
            full_key,
            "followup-full.md",
            "followup-fixture",
            false,
        ),
        "正式保存资料库副本及回执",
    );
    let items = x_bookmarks::reading_sync_test_items(&c, "all");
    assert_eq!(items.len(), 2);
    assert!(metadata_string(&c, "flashcard_oss_config").is_empty());
    assert!(metadata_string(&c, "flashcard_webdav_url").is_empty());
    assert!(
        !crate::cloud_sync::policy(&c).enabled,
        "builder 不得开启云同步"
    );
    let manifest = json!({
        "format":"hub-owned-followup-seed-v1", "producer":"persist_source_page via reading_sync_test_import",
        "database":"craft-search.sqlite3", "keys":[full_key,body_key],
        "fullStatus":"in_progress", "fullTags":["本轮迁移","有原件"],
        "bodyStatus":"unread", "bodyTags":["纯正文"],
        "originals":[
            {"url":image_url,"mime":"image/png","bytes":image.len(),"sha256":hash(&image)},
            {"url":document_url,"mime":"application/pdf","bytes":document.len(),"sha256":hash(&document)}
        ], "savedCopy":"fixture-vault/followup-full.md", "cloudEnabled":false,
        "credentialsWritten":false,"cloudRequests":0
    });
    checked(
        fs::write(
            root.join("fixture-manifest.json"),
            checked(
                serde_json::to_vec_pretty(&manifest),
                "编码非秘密 fixture 清单",
            ),
        ),
        "保存非秘密 fixture 清单",
    );
    drop(c);
    forget_initialized_database(&db);
    println!(
        "{}",
        json!({"status":"prepared","format":"hub-owned-followup-seed-v1","items":2,"originals":2,"cloudRequests":0,"credentialsWritten":false})
    );
}

fn checked<T, E>(result: Result<T, E>, stage: &str) -> T {
    result.unwrap_or_else(|_| panic!("真实 OSS 联调失败：{stage}（未输出连接或凭据详情）"))
}

struct Device {
    owner: PathBuf,
    root: PathBuf,
    db: PathBuf,
}
fn ordinary_directory(path: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    fs::symlink_metadata(path).is_ok_and(|metadata| {
        metadata.is_dir()
            && !metadata.file_type().is_symlink()
            && metadata.file_attributes() & 0x400 == 0
    })
}
fn fixture_parent() -> Result<PathBuf, String> {
    let project = fs::canonicalize(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or("项目目录无效")?
            .parent()
            .ok_or("项目目录无效")?,
    )
    .map_err(|_| "项目目录无法解析")?;
    let mut parent = project.clone();
    for segment in [".local", "cloud-completion-20261007", "runtime-tests"] {
        parent.push(segment);
        if !parent.exists() {
            fs::create_dir(&parent).map_err(|_| "隔离测试目录无法建立")?;
        }
        if !ordinary_directory(&parent) {
            return Err("隔离测试目录不能是链接或重解析点".into());
        }
        parent = fs::canonicalize(&parent).map_err(|_| "隔离测试目录无法解析")?;
        if !parent.starts_with(&project) {
            return Err("隔离测试目录超出本项目范围".into());
        }
    }
    Ok(parent)
}
impl Device {
    fn new(run: &str, name: &str, configuration: &OssConfig) -> Self {
        let owner = checked(fixture_parent(), "核验本项目隔离测试目录");
        let root = owner.join(format!("real-oss-{run}-{name}"));
        checked(fs::create_dir(&root), "建立全新本轮隔离资料目录");
        let db = root.join("hub.sqlite3");
        let c = checked(open_database(&db), "建立本轮隔离数据库");
        checked(x_bookmarks::storage::schema(&c), "初始化隔离阅读库");
        // X originals belong to an external Obsidian vault, including on a cloud consumer.
        let vault = root.with_extension("vault");
        checked(fs::create_dir(&vault), "建立本轮独立 Obsidian 保存库");
        checked(
            meta(
                &c,
                "collection_storage_v1",
                &json!({
                    "mode":"obsidian", "vaultPath":vault, "downloadMedia":true
                })
                .to_string(),
            ),
            "设置隔离 X 原件保存位置",
        );
        checked(
            meta(
                &c,
                "flashcard_oss_config",
                &checked(serde_json::to_string(configuration), "编码隔离连接配置"),
            ),
            "保存隔离连接配置",
        );
        for (key,value) in [
            ("flashcard_cloud_provider","oss"), ("cloud_sync_enabled","1"),
            ("cloud_sync_reading","1"), ("cloud_sync_auto","0"),
            ("reading_media_policy","{\"enabled\":true,\"download\":\"all\",\"imageMb\":1,\"documentMb\":1,\"batchMb\":4,\"dailyMb\":4,\"cacheMb\":100}"),
        ] { checked(meta(&c,key,value),"保存隔离设备开关"); }
        Self { owner, root, db }
    }
    fn c(&self) -> Connection {
        checked(open_database(&self.db), "打开隔离数据库")
    }
    fn seed(&self, image: &[u8]) {
        x_bookmarks::reading_sync_test_import(
            &mut self.c(),
            Post {
                id: "real-cloud-article".into(),
                text: BODY.into(),
                url: "https://example.invalid/hub-isolated-article".into(),
                content_status: "complete".into(),
                media: vec![Media {
                    kind: "photo".into(),
                    url: IMAGE.into(),
                    preview_url: String::new(),
                }],
                thread_cursors: vec!["synthetic-private-cursor-not-for-cloud".into()],
                ..Post::default()
            },
        );
        checked(
            x_bookmarks::properties::save_local(
                &mut self.c(),
                KEY,
                "in_progress",
                &["本轮隔离联调".into(), "小图片".into()],
            ),
            "正式保存阅读状态与标签",
        );
        let path = self.root.join("original.png");
        checked(fs::write(&path, image), "保存合成的小图片原件");
        checked(
            x_bookmarks::storage::record_saved_media(&self.c(), KEY, IMAGE, &path),
            "正式登记图片原件",
        );
    }
    async fn round(&self, remote: &BoundedOss, ns: &str, device: &str) {
        checked(
            sync_database(&self.db, remote, ns, device).await,
            "正式阅读正文同步",
        );
        let summary = checked(
            media::sync(&self.db, remote, ns, device).await,
            "正式阅读图片同步及下载",
        );
        assert_eq!(
            summary.pending_count(),
            0,
            "真实图片同步存在待处理项；未声称成功"
        );
    }
}
impl Drop for Device {
    fn drop(&mut self) {
        forget_initialized_database(&self.db);
        // Only a uniquely named fixture created beneath this project's controlled test directory.
        if ordinary_directory(&self.root) && ordinary_directory(&self.owner) {
            if let (Ok(target), Ok(owner)) =
                (fs::canonicalize(&self.root), fs::canonicalize(&self.owner))
            {
                if owner == self.owner
                    && target.parent() == Some(owner.as_path())
                    && target
                        .file_name()
                        .is_some_and(|name| name.to_string_lossy().starts_with("real-oss-"))
                {
                    let _ = fs::remove_dir_all(&target);
                    let vault = target.with_extension("vault");
                    if ordinary_directory(&vault) {
                        if let Ok(resolved) = fs::canonicalize(&vault) {
                            if resolved == vault && resolved.parent() == Some(owner.as_path()) {
                                let _ = fs::remove_dir_all(&resolved);
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Bounds are additional safety checks around the unchanged production OSS adapter.
struct BoundedOss {
    inner: OssStore,
    prefix: String,
    objects: Mutex<BTreeSet<String>>,
    requests: AtomicUsize,
}
impl BoundedOss {
    fn check(&self, key: &str) -> Result<(), String> {
        let relative = key
            .strip_prefix(&self.prefix)
            .ok_or("联调请求越过本轮独立云目录")?;
        if !relative.starts_with("reading/")
            || relative.split('/').any(|part| matches!(part, "." | ".."))
        {
            return Err("联调仅允许本轮阅读对象".into());
        }
        let mut objects = self.objects.lock().map_err(|_| "联调对象计数不可用")?;
        if !key.ends_with('/') {
            objects.insert(key.into());
        }
        if objects.len() > MAX_OBJECTS {
            return Err("联调对象超过 100 个安全上限".into());
        }
        Ok(())
    }
    fn begin(&self, key: &str) -> Result<(), String> {
        self.check(key)?;
        if self.requests.fetch_add(1, AtomicOrdering::Relaxed) >= 300 {
            return Err("联调传输调用超过 300 次安全上限".into());
        }
        let (up, down) = self.inner.transferred();
        if up + down > 128 * 1024 {
            return Err("联调累计载荷超过 128 KiB 安全上限".into());
        }
        Ok(())
    }
}
impl Store for BoundedOss {
    fn key(&self, relative: &str) -> String {
        self.inner.key(relative)
    }
    fn check_network(&self, key: &str) -> Result<(), String> {
        self.check(key)
    }
    fn head_size<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<Option<u64>, String>> {
        Box::pin(async move {
            self.begin(key)?;
            let size = self
                .inner
                .head_size(key)
                .await
                .map_err(|_| "联调云对象大小读取失败")?;
            if size.is_some_and(|v| v > MAX_BYTES as u64) {
                return Err("联调云对象超过 64 KiB 上限".into());
            }
            Ok(size)
        })
    }
    fn get<'a>(
        &'a self,
        key: &'a str,
        max: usize,
    ) -> BoxFuture<'a, Result<Option<Vec<u8>>, String>> {
        Box::pin(async move {
            self.begin(key)?;
            self.inner
                .get(key, max.min(MAX_BYTES))
                .await
                .map_err(|_| "联调云对象读取失败；连接详情已隐藏".into())
        })
    }
    fn list<'a>(&'a self, relative: &'a str) -> BoxFuture<'a, Result<Vec<String>, String>> {
        Box::pin(async move {
            self.begin(&self.inner.key(relative))?;
            let keys = self
                .inner
                .list(relative)
                .await
                .map_err(|_| "联调独立目录列表读取失败；连接详情已隐藏")?;
            if keys.len() > MAX_OBJECTS {
                return Err("联调对象列表超过 100 个安全上限".into());
            }
            for key in &keys {
                self.check(key)?;
            }
            Ok(keys)
        })
    }
    fn inventory_page<'a>(
        &'a self,
        relative: &'a str,
        continuation: Option<&'a str>,
    ) -> BoxFuture<'a, Result<crate::reading_sync::object_store::InventoryPage, String>> {
        Box::pin(async move {
            self.begin(&self.inner.key(relative))?;
            let page = self
                .inner
                .list_page(relative, continuation)
                .await
                .map_err(|_| "联调独立目录列表读取失败；连接详情已隐藏")?;
            if page.keys.len() > MAX_OBJECTS || page.next.is_some() {
                return Err("联调对象列表超过 100 个安全上限".into());
            }
            for key in &page.keys {
                self.check(key)?;
            }
            Ok(crate::reading_sync::object_store::InventoryPage {
                keys: page.keys,
                directories: Vec::new(),
                next: page.next,
            })
        })
    }
    fn put_verified<'a>(
        &'a self,
        key: &'a str,
        bytes: &'a [u8],
    ) -> BoxFuture<'a, Result<bool, String>> {
        Box::pin(async move {
            self.begin(key)?;
            if bytes.len() > MAX_BYTES {
                return Err("联调上传对象超过 64 KiB 上限".into());
            }
            self.inner
                .put_verified(key, bytes)
                .await
                .map_err(|_| "联调上传或真实读回失败；连接详情已隐藏".into())
        })
    }
    fn delete_exact<'a>(&'a self, _key: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async { Err("真实 OSS 联调不申请远端删除权限".into()) })
    }
}

#[tokio::test]
#[ignore = "explicit real OSS integration only; requires read-only config DB path and existing Windows credential"]
async fn real_oss_reading_roundtrip_from_producer_to_query_and_files() {
    let (configuration, inner, run) = isolated_oss("reading");
    let suffix_hash = hash(run.as_bytes());
    let prefix = inner.key("");
    let remote = BoundedOss {
        inner,
        prefix,
        objects: Mutex::new(BTreeSet::new()),
        requests: AtomicUsize::new(0),
    };
    reading_roundtrip(configuration, remote, run, suffix_hash).await;
}

/// Opt-in only. Reads configuration without migrating or writing the personal database.
pub(crate) fn isolated_oss(module: &str) -> (OssConfig, OssStore, String) {
    let path=std::env::var_os("HUB_OSS_INTEGRATION_CONFIG_DB")
        .map(PathBuf::from).expect("真实 OSS 联调要求 HUB_OSS_INTEGRATION_CONFIG_DB 非秘密绝对路径；环境缺失不会被当作通过");
    assert!(
        path.is_absolute() && path.is_file(),
        "真实 OSS 联调配置数据库路径无效；环境缺失不会被当作通过"
    );
    let personal = checked(
        Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        ),
        "只读打开既有 OSS 配置数据库",
    );
    checked(
        personal.pragma_update(None, "query_only", true),
        "开启配置连接只读查询约束",
    );
    let base = checked(
        crate::flashcard_cloud_sync::config(&personal).and_then(OssConfig::normalized),
        "读取并规范既有 OSS 连接配置",
    );
    drop(personal); // No domain schema migration or personal database writer is ever invoked.
    assert!(matches!(
        module,
        "reading" | "flashcards" | "quick" | "skills"
    ));
    let run = format!("20261112-{module}-{}", random_url_safe(10));
    let mut configuration = base.clone();
    configuration.prefix = format!("{}/_integration/{run}", base.prefix);
    let configuration = checked(configuration.normalized(), "建立本轮独立测试云目录");
    let entry = checked(
        crate::credential_entry("hub-flashcard-oss-secret-v1"),
        "访问现有正式 Windows 安全凭据入口",
    );
    let secret = checked(entry.get_password(), "在进程内读取已存在的 OSS 凭据");
    assert!(
        !secret.is_empty(),
        "现有 OSS 凭据为空；环境缺失不会被当作通过"
    );
    let inner = checked(
        OssStore::new(configuration.clone(), secret),
        "建立真实 OSS 适配器",
    );
    let prefix = inner.key("");
    assert!(
        !prefix.starts_with(&format!("{}/v2/", base.prefix)),
        "测试对象目录必须与个人正式 v2 子树分离"
    );
    (configuration, inner, run)
}

async fn reading_roundtrip(
    configuration: OssConfig,
    remote: BoundedOss,
    run: String,
    suffix_hash: String,
) {
    let ns = configuration.namespace();
    let a = Device::new(&run, "producer", &configuration);
    let b = Device::new(&run, "consumer", &configuration);
    let png=checked(base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE+0AAAAASUVORK5CYII="),"解码合成 PNG 原件");
    a.seed(&png);
    let none = crate::cloud_sync::attachments::Selection {
        image: false,
        video: false,
        pdf: false,
        other: false,
        max_mb: 1,
    };
    let mut rules = crate::cloud_sync::attachments::Directions {
        upload: none.clone(),
        download: none,
    };
    let save = |device: &Device, rules: &crate::cloud_sync::attachments::Directions| {
        checked(
            meta(
                &device.c(),
                "cloud_attachments_reading_v1",
                &serde_json::to_string(rules).unwrap(),
            ),
            "保存双向隔离附件策略",
        );
    };
    save(&a, &rules);
    save(&b, &rules);
    a.round(&remote, &ns, "real-cloud-producer").await;
    b.round(&remote, &ns, "real-cloud-consumer").await;
    let body_only = x_bookmarks::reading_sync_test_items(&b.c(), "in_progress");
    assert_eq!(body_only[0]["post"]["text"], BODY);
    assert_eq!(body_only[0]["savedMedia"], json!([]));
    assert!(
        !checked(remote.list("reading/").await, "核对未选附件没有上传")
            .iter()
            .any(|k| k.contains("/blobs/"))
    );
    rules.upload.image = true;
    save(&a, &rules);
    checked(
        meta(
            &a.c(),
            "reading_media_reserved",
            &(u64::MAX / 2).to_string(),
        ),
        "设置旧额度已满场景",
    );
    a.round(&remote, &ns, "real-cloud-producer").await;
    b.round(&remote, &ns, "real-cloud-consumer").await;
    assert_eq!(
        x_bookmarks::reading_sync_test_items(&b.c(), "in_progress")[0]["savedMedia"],
        json!([])
    );
    rules.download.image = true;
    save(&b, &rules);
    checked(
        meta(
            &b.c(),
            "reading_media_reserved",
            &(u64::MAX / 2).to_string(),
        ),
        "设置消费端旧额度已满场景",
    );
    b.round(&remote, &ns, "real-cloud-consumer").await;
    let items = x_bookmarks::reading_sync_test_items(&b.c(), "in_progress");
    assert_eq!(items.len(), 1, "正式阅读列表应接收到一个条目");
    let item = &items[0];
    assert_eq!(item["post"]["text"], BODY);
    assert_eq!(item["status"], "in_progress");
    assert_eq!(item["tags"], json!(["小图片", "本轮隔离联调"]));
    assert_eq!(item["cloudImported"], true);
    assert_eq!(item["savedMedia"], json!([IMAGE]));
    assert_eq!(item["post"]["threadCursors"], json!([]));
    let sequence: i64 = checked(
        b.c().query_row(
            "SELECT local_seq FROM collection_saved_media WHERE item_key=?1 AND media_url=?2",
            params![KEY, IMAGE],
            |r| r.get(0),
        ),
        "读取正式下载文件回执",
    );
    let path = checked(
        x_bookmarks::storage::recorded_media_path(&b.c(), sequence),
        "正式文件消费接口核验 PNG",
    );
    assert!(
        checked(fs::canonicalize(&path), "解析消费端文件").starts_with(checked(
            fs::canonicalize(b.root.with_extension("vault")),
            "解析消费端隔离保存库"
        )),
        "X 下载原件必须由消费端独立 Obsidian 保存库持有"
    );
    assert_eq!(checked(fs::read(&path), "读回消费端实际图片"), png);
    checked(
        x_bookmarks::properties::save_local(&mut b.c(), KEY, "read", &["反向更新".into()]),
        "正式消费端反向修改阅读状态",
    );
    b.round(&remote, &ns, "real-cloud-consumer").await;
    a.round(&remote, &ns, "real-cloud-producer").await;
    let reverse = x_bookmarks::reading_sync_test_items(&a.c(), "read");
    assert_eq!(reverse.len(), 1);
    assert_eq!(reverse[0]["tags"], json!(["反向更新"]));
    for table in [
        "collection_library_jobs",
        "collection_x_outbox",
        "collection_property_updates",
        "collection_obsidian_exports",
    ] {
        let count: usize = checked(
            b.c()
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0)),
            "检查云导入无外部来源写入副作用",
        );
        assert_eq!(count, 0, "消费端不得生成外部来源操作");
    }
    let keys = checked(remote.list("reading/").await, "读取本轮独立测试对象总数");
    assert!(keys.len() <= MAX_OBJECTS, "本轮测试对象超过 100 个");
    let (uploaded, downloaded) = remote.inner.transferred();
    assert!(
        uploaded + downloaded < 128 * 1024,
        "本轮真实载荷应远小于 1 MiB"
    );
    println!(
        "{}",
        json!({"status":"success","namespaceSuffixHash":suffix_hash,"objects":keys.len(),"uploadedBytes":uploaded,"downloadedBytes":downloaded,"producerAndQueryVerified":true,"consumerFileVerified":true,"independentDirectionsAndDeferredUploadVerified":true,"retiredBudgetDoesNotBlock":true,"reverseUpdateVerified":true,"remoteObjectsRetained":true})
    );
}
