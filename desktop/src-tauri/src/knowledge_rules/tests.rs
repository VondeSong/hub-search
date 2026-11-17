use super::*;
use crate::source_evidence::{tests::Fixture, EvidenceLocator, EvidenceReader, EvidenceScope};

#[test]
fn explicit_chat_attachments_inherit_hub_rules_without_library_access() {
    let f = Fixture::new();
    fs::write(f.root.join("AGENTS.md"), "只读原件").unwrap();
    let allowed = json!({"libraries":[],"wholeLibraryIds":[],"exactNotes":[{"libraryId":source_evidence::local_text::LIBRARY,"documentId":"selected"}]});
    let mut rules = Rules::new(&f.root, allowed, true).unwrap();
    let value = rules
        .load(source_evidence::local_text::LIBRARY, Some("selected"))
        .unwrap();
    assert_eq!(value["entries"][0]["instructions"], "只读原件");
    assert!(rules
        .load(source_evidence::local_text::LIBRARY, Some("other"))
        .is_err());
    assert!(rules.load("notes", Some("private")).is_err());
    fs::write(f.root.join("AGENTS.md"), "变更规则").unwrap();
    assert!(rules.verify().is_err());
}

#[test]
fn reliability_shared_rules_preserve_scopes_and_reduce_duplicate_payloads() {
    let entry = json!({"source":"library/AGENTS.md","scope":{"kind":"library","libraryId":"notes"},"version":"v1","instructions":"规则".repeat(4000)});
    let raw = json!((0..4)
        .map(|i| json!({"documentId":i,"fingerprint":i,"entries":[entry.clone()]}))
        .collect::<Vec<_>>());
    assert!(raw.to_string().len() > 65536);
    let compact = compact_guidance(raw.clone());
    assert!(compact.to_string().len() < 32768);
    assert_eq!(compact[0]["entries"][0], entry);
    assert_eq!(compact[3]["fingerprint"], 3);
    assert_eq!(compact[3]["entries"], json!([]));
    assert_eq!(compact_guidance(compact.clone()), compact);
    let mut changed = raw;
    changed[1]["entries"][0]["scope"]["libraryId"] = json!("other");
    assert_eq!(
        compact_guidance(changed)[1]["entries"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

fn setup() -> (Fixture, PathBuf, Value) {
    let f = Fixture::new();
    let vault = f.root.join("vault");
    fs::create_dir_all(vault.join("study/topic")).unwrap();
    f.c()
        .execute(
            "UPDATE libraries SET location=?1 WHERE id='notes'",
            [vault.to_string_lossy().as_ref()],
        )
        .unwrap();
    f.note("notes", "lesson", "ordinary content");
    f.c().execute("UPDATE documents SET path='study/topic/lesson.md' WHERE id='lesson' AND space_id='notes'",[]).unwrap();
    let catalog = EvidenceReader::new(
        &f.root,
        EvidenceScope::new(vec!["notes".into()], vec![]).unwrap(),
    )
    .catalog()
    .unwrap();
    (f, vault, catalog)
}

#[test]
fn reliability_inherited_rules_cannot_bypass_capacity_and_failed_load_rolls_back() {
    let (f, vault, catalog) = setup();
    let mut rules = Rules::new(&f.root, catalog.clone(), true).unwrap();
    let mut inherited = Vec::new();
    for i in 0..5 {
        let doc = format!("note{i}");
        f.note("notes", &doc, "body");
        let directory = format!("dir{i}");
        fs::create_dir_all(vault.join(&directory)).unwrap();
        fs::write(vault.join(&directory).join("AGENTS.md"), "x".repeat(30_000)).unwrap();
        f.c()
            .execute(
                "UPDATE documents SET path=?1 WHERE id=?2",
                rusqlite::params![format!("{directory}/note.md"), doc],
            )
            .unwrap();
        let mut one = Rules::new(&f.root, catalog.clone(), false).unwrap();
        one.load("notes", Some(&doc)).unwrap();
        inherited.extend(one.reads().as_array().unwrap().clone());
        let before = rules.guidance();
        let result = rules.load("notes", Some(&doc));
        if i == 4 {
            assert!(result.is_err());
            assert_eq!(rules.guidance(), before);
        } else {
            result.unwrap();
        }
    }
    let mut next = Rules::new(&f.root, catalog, true).unwrap();
    let before = next.guidance();
    assert!(next.inherit(&json!(inherited)).is_err());
    assert_eq!(next.guidance(), before);
}

#[test]
#[ignore = "read-only replay of the explicitly supplied personal-copy failure"]
fn reliability_real_rules_payload_before_and_after() {
    let root = PathBuf::from(std::env::var("HUB_RELIABILITY_ROOT").unwrap());
    let library = "obsidian:ecb87c9b2d73cdffa5caf7df";
    let notes = [
        "563969110622034c4932e4f1f146c4a546dee90b5dcda91cfc832c4c4ccf7573",
        "a019778f7cc07d7f7f5f8a069484299e82b4f17095d986de886bde8ec8703263",
        "b566bb159891548a32acdfcc197ced6e102bc0c8db63db4f24a73f8c522f3662",
    ];
    let scope = EvidenceScope::new(vec![], vec![])
        .unwrap()
        .with_notes(
            notes
                .iter()
                .map(|id| EvidenceLocator::Note {
                    library_id: library.into(),
                    document_id: (*id).into(),
                    page_id: None,
                })
                .collect(),
        )
        .unwrap();
    let catalog = EvidenceReader::new(&root, scope).catalog().unwrap();
    let rules = Rules::new(&root, catalog, true).unwrap();
    let raw = json!(rules
        .reads
        .values()
        .map(|(_, value)| value)
        .collect::<Vec<_>>());
    let compact = rules.guidance();
    assert!(raw.to_string().len() > 65_536);
    assert!(compact.to_string().len() < 65_536);
    assert_eq!(
        raw.as_array().unwrap().len(),
        compact.as_array().unwrap().len()
    );
    rules.verify().unwrap();
    println!(
        "RELIABILITY rawBytes={} compactBytes={} bundles={}",
        raw.to_string().len(),
        compact.to_string().len(),
        compact.as_array().unwrap().len()
    );
}

#[test]
fn root_and_nested_rules_have_explicit_scopes_and_override_precedence() {
    let (f, vault, catalog) = setup();
    fs::write(f.root.join("AGENTS.md"), "Hub agreement").unwrap();
    fs::write(vault.join("AGENTS.md"), "Library agreement").unwrap();
    fs::write(vault.join("study/AGENTS.md"), "Folder agreement").unwrap();
    fs::write(vault.join("study/AGENTS.override.md"), "Specific agreement").unwrap();
    fs::write(
        vault.join("study/topic/ordinary.md"),
        "DO NOT LOAD THIS AS INSTRUCTIONS",
    )
    .unwrap();
    let mut rules = Rules::new(&f.root, catalog, true).unwrap();
    let result = rules.load("notes", Some("lesson")).unwrap();
    let entries = result["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0]["scope"]["kind"], "hub");
    assert_eq!(entries[1]["scope"]["libraryId"], "notes");
    assert_eq!(entries[2]["instructions"], "Specific agreement");
    assert_eq!(entries[2]["scope"]["directory"], "study");
    assert!(!result.to_string().contains("DO NOT LOAD"));
    rules.verify().unwrap();
    // A selected override does not read or validate its shadowed sibling.
    fs::write(vault.join("study/AGENTS.md"), [0xff]).unwrap();
    rules.verify().unwrap();
}

#[test]
fn newly_added_changed_or_removed_rules_invalidate_current_and_inherited_context() {
    let (f, vault, catalog) = setup();
    let mut rules = Rules::new(&f.root, catalog.clone(), true).unwrap();
    rules.load("notes", Some("lesson")).unwrap();
    let old = rules.reads();
    fs::write(vault.join("study/topic/AGENTS.md"), "New agreement").unwrap();
    assert!(rules.verify().is_err());
    let mut next = Rules::new(&f.root, catalog.clone(), true).unwrap();
    assert!(next.inherit(&old).is_err());
    next.load("notes", Some("lesson")).unwrap();
    fs::write(vault.join("study/topic/AGENTS.md"), "Changed agreement").unwrap();
    assert!(next.verify().is_err());
    let final_rules = Rules::new(&f.root, catalog, true).unwrap();
    fs::remove_file(vault.join("AGENTS.md")).ok();
    // No root rule existed; the current snapshot remains valid.
    final_rules.verify().unwrap();
}

#[test]
fn managed_rules_support_non_filesystem_libraries_and_never_cross_library_scope() {
    let f = Fixture::new();
    let directory = managed_directory(&f.root, "craft");
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join("AGENTS.md"), "Craft-specific agreement").unwrap();
    let catalog = EvidenceReader::new(
        &f.root,
        EvidenceScope::new(vec!["craft".into()], vec![]).unwrap(),
    )
    .catalog()
    .unwrap();
    let mut rules = Rules::new(&f.root, catalog, true).unwrap();
    assert!(rules.guidance().to_string().contains("Craft-specific"));
    assert!(rules.load("private", None).is_err());
}

#[test]
fn exact_note_rules_do_not_grant_sibling_notes_and_reject_invalid_paths_and_bytes() {
    let (f, vault, _) = setup();
    f.note("notes", "sibling", "secret");
    let scope = EvidenceScope::new(vec![], vec![])
        .unwrap()
        .with_notes(vec![EvidenceLocator::Note {
            library_id: "notes".into(),
            document_id: "lesson".into(),
            page_id: None,
        }])
        .unwrap();
    let catalog = EvidenceReader::new(&f.root, scope).catalog().unwrap();
    let mut rules = Rules::new(&f.root, catalog.clone(), true).unwrap();
    assert!(rules.load("notes", Some("sibling")).is_err());
    f.c()
        .execute(
            "UPDATE documents SET path='../outside.md' WHERE id='lesson'",
            [],
        )
        .unwrap();
    assert!(Rules::new(&f.root, catalog.clone(), true).is_err());
    f.c()
        .execute(
            "UPDATE documents SET path='lesson.md' WHERE id='lesson'",
            [],
        )
        .unwrap();
    fs::write(vault.join("AGENTS.md"), [0xff, 0xfe]).unwrap();
    assert!(Rules::new(&f.root, catalog.clone(), true).is_err());
    fs::write(vault.join("AGENTS.md"), "x".repeat(MAX_FILE as usize + 1)).unwrap();
    assert!(Rules::new(&f.root, catalog, true).is_err());
}

#[test]
fn unchanged_rules_resume_and_empty_override_falls_back() {
    let (f, vault, catalog) = setup();
    fs::write(vault.join("AGENTS.override.md"), " \n").unwrap();
    fs::write(vault.join("AGENTS.md"), "Root agreement").unwrap();
    let first = Rules::new(&f.root, catalog.clone(), true).unwrap();
    let mut second = Rules::new(&f.root, catalog, true).unwrap();
    second.inherit(&first.reads()).unwrap();
    assert_eq!(first.fingerprint(), second.fingerprint());
    assert!(second.guidance().to_string().contains("Root agreement"));
    fs::remove_file(vault.join("AGENTS.md")).unwrap();
    assert!(second.verify().is_err());
}
