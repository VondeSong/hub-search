//! Ownership receipts for future consolidation output, never inferred from names.
//! A running or incomplete receipt is not permission to remove any file.
use super::*;
use std::collections::BTreeSet;

pub(crate) const VERSION: u32 = 1;
pub(crate) const PRODUCER: &str = "hub-consolidation-v1";
pub(crate) const DIRECTORY: &str = "data-backup-v1/consolidation-manifests";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ManifestFile {
    pub relative_path: String,
    pub bytes: u64,
    pub sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor_suffix: Option<String>,
    pub created_by_run: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Manifest {
    pub version: u32,
    pub producer: String,
    pub id: String,
    pub phase: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub files: Vec<ManifestFile>,
}

pub(super) struct Run {
    path: PathBuf,
    manifest: Manifest,
    planned: bool,
    created: BTreeSet<String>,
}

impl Run {
    pub(super) fn begin(root: &Path, id: &str) -> Result<Self, String> {
        if id.len() != 32 || !id.bytes().all(|value| value.is_ascii_hexdigit()) {
            return Err("整理操作标识无效".into());
        }
        let directory = root.join(DIRECTORY);
        files::reject_links(&directory)?;
        fs::create_dir_all(&directory).map_err(io_error)?;
        files::reject_links(&directory)?;
        let path = directory.join(format!("{id}.json"));
        let timestamp = now();
        let manifest = Manifest {
            version: VERSION,
            producer: PRODUCER.into(),
            id: id.into(),
            phase: "running".into(),
            created_at: timestamp,
            updated_at: timestamp,
            files: Vec::new(),
        };
        // Refuse to adopt an earlier run's record, even after an ID collision.
        files::write_new_json(&path, &manifest)?;
        Ok(Self {
            path,
            manifest,
            planned: false,
            created: BTreeSet::new(),
        })
    }

    /// Persist the complete plan once before copying. Prepared files start with
    /// createdByRun=false; only successful create-new publication grants ownership.
    pub(super) fn plan(&mut self, planned: Vec<ManifestFile>) -> Result<(), String> {
        if self.planned {
            return Err("整理文件清单已经保存".into());
        }
        let snapshot = format!("data-backup-v1/consolidate-{}.sqlite3", self.manifest.id);
        let prepared = format!("external-sources/prepared-{}/", self.manifest.id);
        let mut seen = BTreeSet::new();
        for file in &planned {
            files::safe_relative(&file.relative_path)?;
            if file.relative_path != snapshot && !file.relative_path.starts_with(&prepared) {
                return Err("整理清单包含不属于本次操作的文件".into());
            }
            if !seen.insert(file.relative_path.to_lowercase()) {
                return Err("整理清单包含重复文件路径".into());
            }
            if file.sha256.len() != 64
                || !file.sha256.bytes().all(|value| value.is_ascii_hexdigit())
            {
                return Err("整理清单缺少有效文件校验值".into());
            }
            match (&file.anchor_id, &file.anchor_suffix) {
                (None, None) if file.relative_path == snapshot && file.created_by_run => {}
                (Some(id), Some(suffix))
                    if file.relative_path.starts_with(&prepared)
                        && id
                            .strip_prefix("craft_backup_config:")
                            .is_some_and(|id| !id.is_empty())
                        && !file.created_by_run =>
                {
                    files::safe_relative(suffix)?;
                    if !file.relative_path.ends_with(&format!("/{suffix}")) {
                        return Err("整理清单的保留副本位置无效".into());
                    }
                }
                _ => return Err("整理清单的文件归属无效".into()),
            }
        }
        self.manifest.files = planned;
        self.manifest.updated_at = now();
        files::replace_json(&self.path, &self.manifest)?;
        self.planned = true;
        Ok(())
    }

    pub(super) fn created(&mut self, relative: &str) {
        self.created.insert(relative.into());
    }

    /// A failed atomic replacement leaves the last durable phase as running.
    /// A crash also leaves running; no Drop implementation fabricates a terminal state.
    pub(super) fn finish(&mut self, phase: &str) -> Result<(), String> {
        if !matches!(phase, "complete" | "failed" | "cancelled") {
            return Err("整理操作终态无效".into());
        }
        for file in &mut self.manifest.files {
            file.created_by_run |= self.created.contains(&file.relative_path);
        }
        self.manifest.phase = phase.into();
        self.manifest.updated_at = now();
        files::replace_json(&self.path, &self.manifest)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        base: PathBuf,
        root: PathBuf,
    }

    impl Fixture {
        fn new(label: &str) -> Self {
            let base = Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join("task-state/data-management-20261016/test-fixtures");
            files::reject_links(&base).unwrap();
            fs::create_dir_all(&base).unwrap();
            let base = base.canonicalize().unwrap();
            let root = base.join(format!("consolidation-manifest-{label}-{}", identifier()));
            fs::create_dir(&root).unwrap();
            Self { base, root }
        }

        fn write(&self, relative: &str, bytes: &[u8]) {
            let path = self.root.join(files::safe_relative(relative).unwrap());
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let mut output = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(path)
                .unwrap();
            output.write_all(bytes).unwrap();
            output.sync_all().unwrap();
        }

        fn read(&self, id: &str) -> Manifest {
            let bytes = fs::read(self.root.join(DIRECTORY).join(format!("{id}.json"))).unwrap();
            serde_json::from_slice(&bytes).unwrap()
        }

        // Preserve a failed fixture for diagnosis. Only a successful test reaches
        // this explicit cleanup, after verifying the exact owned child directory.
        fn cleanup(self) {
            files::reject_links(&self.root).unwrap();
            let root = self.root.canonicalize().unwrap();
            assert_eq!(root.parent(), Some(self.base.as_path()));
            assert!(root
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("consolidation-manifest-"));
            fs::remove_dir_all(root).unwrap();
        }
    }

    fn prepared_file(id: &str, suffix: &str, bytes: &[u8]) -> ManifestFile {
        ManifestFile {
            relative_path: format!(
                "external-sources/prepared-{id}/archive/Fixture - 备份/{suffix}"
            ),
            bytes: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(bytes)),
            anchor_id: Some("craft_backup_config:fixture-library".into()),
            anchor_suffix: Some(suffix.into()),
            created_by_run: false,
        }
    }

    #[test]
    fn completed_consolidation_persists_only_confirmed_created_ownership() {
        let fixture = Fixture::new("complete");
        let id = identifier();
        let mut run = Run::begin(&fixture.root, &id).unwrap();
        let initial = fixture.read(&id);
        assert_eq!(initial.phase, "running");
        assert!(initial.files.is_empty());
        let original_created_at = initial.created_at;

        let snapshot_bytes = b"synthetic snapshot bytes, never a user database";
        let snapshot = ManifestFile {
            relative_path: format!("data-backup-v1/consolidate-{id}.sqlite3"),
            bytes: snapshot_bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(snapshot_bytes)),
            anchor_id: None,
            anchor_suffix: None,
            created_by_run: true,
        };
        fixture.write(&snapshot.relative_path, snapshot_bytes);
        let copied_bytes = b"synthetic Craft archive object";
        let copied = prepared_file(&id, "objects/fixture.txt", copied_bytes);
        run.plan(vec![snapshot, copied.clone()]).unwrap();
        let planned = fixture.read(&id);
        assert_eq!(planned.phase, "running");
        assert!(planned.files[0].created_by_run);
        assert!(!planned.files[1].created_by_run);

        fixture.write(&copied.relative_path, copied_bytes);
        run.created(&copied.relative_path);
        assert!(!fixture.read(&id).files[1].created_by_run);
        run.finish("complete").unwrap();
        let complete = fixture.read(&id);
        assert_eq!(complete.version, VERSION);
        assert_eq!(complete.producer, PRODUCER);
        assert_eq!(complete.id, id);
        assert_eq!(complete.phase, "complete");
        assert_eq!(complete.created_at, original_created_at);
        assert!(complete.updated_at >= complete.created_at);
        assert_eq!(complete.files.len(), 2);
        assert!(complete.files.iter().all(|file| file.created_by_run));
        assert_eq!(
            complete.files[1].anchor_id.as_deref(),
            Some("craft_backup_config:fixture-library")
        );
        assert_eq!(
            complete.files[1].anchor_suffix.as_deref(),
            Some("objects/fixture.txt")
        );
        assert_eq!(
            complete.files[1].sha256,
            files::hash_file(
                &fixture.root.join(&copied.relative_path),
                &AtomicBool::new(false)
            )
            .unwrap()
        );
        fixture.cleanup();
    }

    #[test]
    fn failed_or_cancelled_plans_do_not_claim_uncreated_or_reused_files() {
        let fixture = Fixture::new("unowned");
        for terminal in ["failed", "cancelled"] {
            let id = identifier();
            let mut run = Run::begin(&fixture.root, &id).unwrap();
            let uncreated = prepared_file(&id, "objects/not-created.txt", b"not copied");
            let reused = prepared_file(&id, "objects/reused.txt", b"already present");
            fixture.write(&reused.relative_path, b"already present");
            run.plan(vec![uncreated.clone(), reused.clone()]).unwrap();
            // Even an unrelated notification cannot add an object to this plan.
            run.created("collection-files/not-owned-by-consolidation.txt");
            run.finish(terminal).unwrap();
            let record = fixture.read(&id);
            assert_eq!(record.phase, terminal);
            assert_eq!(record.files.len(), 2);
            assert!(record.files.iter().all(|file| !file.created_by_run));
            assert!(!fixture.root.join(uncreated.relative_path).exists());
            assert_eq!(
                fs::read(fixture.root.join(reused.relative_path)).unwrap(),
                b"already present"
            );
        }
        fixture.cleanup();
    }

    #[test]
    fn invalid_paths_and_anchors_never_publish_an_ownership_plan() {
        let fixture = Fixture::new("invalid");
        assert!(Run::begin(&fixture.root, "../outside").is_err());
        for case in 0..8 {
            let id = identifier();
            let mut run = Run::begin(&fixture.root, &id).unwrap();
            let mut file = prepared_file(&id, "objects/fixture.txt", b"fixture");
            match case {
                0 => file.relative_path = "blobs-v1/aa/not-owned".into(),
                1 => file.relative_path = "collection-files/not-owned.txt".into(),
                2 => file.relative_path = format!("external-sources/prepared-{id}/../escape.txt"),
                3 => {
                    file.relative_path = format!(
                        "external-sources/prepared-{}/archive/objects/fixture.txt",
                        identifier()
                    )
                }
                4 => file.anchor_id = Some("craft_backup_config:".into()),
                5 => file.anchor_suffix = Some("objects/different.txt".into()),
                6 => file.anchor_suffix = None,
                7 => file.created_by_run = true,
                _ => unreachable!(),
            }
            assert!(run.plan(vec![file]).is_err(), "case {case}");
            let unchanged = fixture.read(&id);
            assert_eq!(unchanged.phase, "running");
            assert!(unchanged.files.is_empty());
        }
        fixture.cleanup();
    }
}
