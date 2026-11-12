use super::*;
use std::cell::{Cell, RefCell};

#[derive(Default)]
struct Memory {
    values: RefCell<BTreeMap<String, String>>,
    reads: RefCell<Vec<String>>,
    fail_once: Cell<bool>,
    writes: Cell<usize>,
}
impl Store for Memory {
    fn get(&self, spec: &Spec) -> Result<Option<String>, String> {
        self.reads.borrow_mut().push(spec.id.clone());
        Ok(self.values.borrow().get(&spec.id).cloned())
    }
    fn put(&self, spec: &Spec, value: &str) -> Result<(), String> {
        self.writes.set(self.writes.get() + 1);
        if self.fail_once.replace(false) {
            return Err("synthetic store failure".into());
        }
        self.values
            .borrow_mut()
            .insert(spec.id.clone(), value.into());
        Ok(())
    }
    fn remove(&self, spec: &Spec) -> Result<(), String> {
        self.values.borrow_mut().remove(&spec.id);
        Ok(())
    }
}
fn fixtures() -> (BTreeMap<String, Spec>, Memory) {
    let specs = ["one", "two"]
        .into_iter()
        .map(|id| {
            (
                id.into(),
                Spec {
                    id: id.into(),
                    label: format!("Account {id}"),
                    category: "accounts".into(),
                    key: id.into(),
                    kind: Kind::Raw,
                },
            )
        })
        .collect();
    let store = Memory::default();
    store
        .values
        .borrow_mut()
        .insert("one".into(), "synthetic-secret-one".into());
    store
        .values
        .borrow_mut()
        .insert("two".into(), "synthetic-secret-two".into());
    (specs, store)
}
#[test]
fn encrypted_bundle_roundtrip_hides_values_and_rejects_wrong_password_and_tampering() {
    let (specs, store) = fixtures();
    let bundle = collect(&specs, &store, &["one".into()]).unwrap();
    let password = "synthetic migration password";
    let bytes = seal(&bundle, password).unwrap();
    assert!(!bytes
        .windows(b"synthetic-secret-one".len())
        .any(|v| v == b"synthetic-secret-one"));
    let opened = unseal(&bytes, password).unwrap();
    assert_eq!(opened.records.len(), 1);
    assert_eq!(opened.records[0].value, "synthetic-secret-one");
    assert!(unseal(&bytes, "wrong password")
        .err()
        .unwrap()
        .contains("密码不正确"));
    let mut damaged = bytes;
    let end = damaged.len() - 1;
    damaged[end] ^= 1;
    assert!(unseal(&damaged, password).is_err());
    assert!(seal(&bundle, "short").is_err());
}
#[test]
fn export_selection_never_reads_unselected_or_unknown_secrets() {
    let (specs, store) = fixtures();
    let bundle = collect(&specs, &store, &["one".into()]).unwrap();
    assert_eq!(bundle.records.len(), 1);
    assert_eq!(*store.reads.borrow(), vec!["one"]);
    store.reads.borrow_mut().clear();
    assert!(collect(&specs, &store, &["unknown".into()]).is_err());
    assert!(store.reads.borrow().is_empty());
    assert!(collect(&specs, &store, &["one".into(), "one".into()]).is_err());
    assert!(store.reads.borrow().is_empty());
}
#[test]
fn import_preserves_existing_accounts_unless_user_selects_replacement() {
    let (specs, source) = fixtures();
    let bundle = collect(&specs, &source, &["one".into(), "two".into()]).unwrap();
    let destination = Memory::default();
    destination
        .values
        .borrow_mut()
        .insert("one".into(), "existing".into());
    let result = apply(
        &specs,
        &destination,
        &bundle,
        &["one".into(), "two".into()],
        false,
    )
    .unwrap();
    assert_eq!(result["results"][0]["status"], "skipped");
    assert_eq!(result["results"][1]["status"], "imported");
    assert_eq!(destination.values.borrow()["one"], "existing");
    apply(&specs, &destination, &bundle, &["one".into()], true).unwrap();
    assert_eq!(destination.values.borrow()["one"], "synthetic-secret-one");
}
#[test]
fn failed_account_write_restores_old_value_and_reports_per_account_outcome() {
    let (specs, source) = fixtures();
    let bundle = collect(&specs, &source, &["one".into(), "two".into()]).unwrap();
    let destination = Memory::default();
    destination
        .values
        .borrow_mut()
        .insert("one".into(), "existing".into());
    destination.fail_once.set(true);
    let result = apply(
        &specs,
        &destination,
        &bundle,
        &["one".into(), "two".into()],
        true,
    )
    .unwrap();
    assert_eq!(result["results"][0]["status"], "failed");
    assert_eq!(result["results"][1]["status"], "imported");
    assert_eq!(destination.values.borrow()["one"], "existing");
    assert!(!result.to_string().contains("synthetic-secret"));
}
#[test]
fn import_rejects_missing_unknown_and_duplicate_selections_before_writing() {
    let (specs, store) = fixtures();
    let mut bundle = collect(&specs, &store, &["one".into()]).unwrap();
    assert!(apply(&specs, &store, &bundle, &["two".into()], true).is_err());
    assert!(apply(&specs, &store, &bundle, &["unknown".into()], true).is_err());
    assert_eq!(store.writes.get(), 0);
    bundle.records.push(Record {
        id: "one".into(),
        value: "duplicate".into(),
    });
    assert!(apply(&specs, &store, &bundle, &["one".into()], true).is_err());
    assert_eq!(store.writes.get(), 0);
    assert!(unseal(b"not a migration bundle", "any").is_err());
}

#[test]
fn retired_ai_secret_does_not_block_current_credential_import() {
    let root = std::env::temp_dir().join(format!(
        "hub-retired-ai-migration-{}",
        crate::random_url_safe(12)
    ));
    fs::create_dir(&root).unwrap();
    {
        let database = Connection::open(root.join("craft-search.sqlite3")).unwrap();
        database
            .execute_batch("CREATE TABLE libraries(id TEXT, name TEXT, provider TEXT)")
            .unwrap();
    }
    let current = specs(&root).unwrap();
    let active_id = "secret:hub-flashcard-oss-secret-v1".to_string();
    let retired_id = "secret:ai-tag-api-key";
    assert!(current.contains_key(&active_id));
    assert!(!current.contains_key(retired_id));
    let bundle = Bundle {
        version: 1,
        created_at: 1,
        records: vec![
            Record {
                id: active_id.clone(),
                value: "synthetic-current-password".into(),
            },
            Record {
                id: retired_id.into(),
                value: "synthetic-retired-key".into(),
            },
        ],
    };
    let destination = Memory::default();
    let result = apply(&current, &destination, &bundle, &[active_id.clone()], false).unwrap();
    assert_eq!(result["results"][0]["status"], "imported");
    assert_eq!(
        destination.values.borrow()[&active_id],
        "synthetic-current-password"
    );
    assert!(destination.reads.borrow().iter().all(|id| id != retired_id));
    assert!(!destination.values.borrow().contains_key(retired_id));
    let writes = destination.writes.get();
    assert!(apply(&current, &destination, &bundle, &[retired_id.into()], true).is_err());
    assert_eq!(destination.writes.get(), writes);
    fs::remove_dir_all(root).unwrap();
}
