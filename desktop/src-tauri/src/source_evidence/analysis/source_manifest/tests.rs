use super::*;
use crate::source_evidence::tests::Fixture;
fn reader(f: &Fixture) -> EvidenceReader {
    EvidenceReader::new(
        &f.root,
        EvidenceScope::new(vec!["notes".into()], vec![]).unwrap(),
    )
}
fn seed(f: &Fixture) {
    for day in 1..=40 {
        let d =
            chrono::NaiveDate::from_ymd_opt(2025, 1, 1).unwrap() + chrono::Duration::days(day - 1);
        f.note("notes", &format!("daily/{d}"), "PRIVATE_BODY_SENTINEL");
    }
    f.note("notes", "daily/undated", "UNKNOWN_DATE_BODY");
    f.note("notes", "daily-old/2025-01-01", "OTHER_DIRECTORY_BODY");
    f.note("private", "daily/2025-01-01", "UNAUTHORIZED_BODY");
}
#[test]
fn source_manifest_pages_over_explicit_library_scope_and_keeps_body_and_unknown_dates_separate() {
    let f = Fixture::new();
    seed(&f);
    let r = reader(&f);
    let base = json!({"libraryId":"notes","directory":"daily","dateFrom":"2025-01-01","dateTo":"2025-02-28","limit":7});
    let mut args = base.clone();
    let mut ids = std::collections::HashSet::new();
    let mut manifest = None;
    let mut pages = 0;
    loop {
        let page = execute(&r, &args).unwrap();
        assert_eq!(execute(&r, &args).unwrap(), page);
        assert!(!page.to_string().contains("PRIVATE_BODY"));
        assert!(!page.to_string().contains("UNAUTHORIZED"));
        assert_eq!(page["totalMembers"], 40);
        assert_eq!(page["dateCoverage"]["unknownDateMembers"], 1);
        assert_eq!(page["dateCoverage"]["excludedByDateSelection"], 1);
        assert_eq!(page["bodyRead"], false);
        assert!(page["extractedMembers"].is_null());
        if let Some(old) = &manifest {
            assert_eq!(old, &page["snapshot"]);
        } else {
            manifest = Some(page["snapshot"].clone());
        }
        for member in page["members"].as_array().unwrap() {
            assert!(ids.insert(member["locator"].to_string()));
        }
        pages += 1;
        if page["nextCursor"].is_null() {
            break;
        }
        args["cursor"] = page["nextCursor"].clone();
    }
    assert_eq!(pages, 6);
    assert_eq!(ids.len(), 40);
    let all = execute(&r, &json!({"libraryId":"notes","directory":"daily"})).unwrap();
    assert_eq!(all["totalMembers"], 41);
    assert_eq!(all["dateCoverage"]["directoryMembers"], 41);
}
#[test]
fn source_manifest_cursor_binds_members_versions_selection_and_scope() {
    let f = Fixture::new();
    seed(&f);
    let r = reader(&f);
    let args = json!({"libraryId":"notes","directory":"daily","limit":1});
    let first = execute(&r, &args).unwrap();
    let mut next = args.clone();
    next["cursor"] = first["nextCursor"].clone();
    let mut changed = next.clone();
    changed["directory"] = json!("daily-old");
    assert!(execute(&r, &changed).is_err());
    let exact = EvidenceReader::new(
        &f.root,
        EvidenceScope::new(vec![], vec![])
            .unwrap()
            .with_notes(vec![EvidenceLocator::Note {
                library_id: "notes".into(),
                document_id: "daily/2025-01-01".into(),
                page_id: None,
            }])
            .unwrap(),
    );
    assert!(execute(&exact, &next).is_err());
    f.note("notes", "daily/2025-01-01", "changed actual content");
    assert!(execute(&r, &next).is_err());
    let fresh = execute(&r, &args).unwrap();
    next["cursor"] = fresh["nextCursor"].clone();
    f.note("notes", "daily/2025-02-15", "new member");
    assert!(execute(&r, &next).is_err());
    f.c()
        .execute("UPDATE libraries SET enabled=0 WHERE id='notes'", [])
        .unwrap();
    assert!(execute(&r, &args).is_err());
}
#[test]
fn source_manifest_exact_grant_and_invalid_path_date_cannot_expand_permission() {
    let f = Fixture::new();
    seed(&f);
    let exact = EvidenceReader::new(
        &f.root,
        EvidenceScope::new(vec![], vec![])
            .unwrap()
            .with_notes(vec![EvidenceLocator::Note {
                library_id: "notes".into(),
                document_id: "daily/2025-01-01".into(),
                page_id: None,
            }])
            .unwrap(),
    );
    assert_eq!(
        execute(&exact, &json!({"libraryId":"notes","directory":"daily"})).unwrap()["totalMembers"],
        1
    );
    assert!(execute(&exact, &json!({"libraryId":"private"})).is_err());
    for directory in ["../daily", "/daily", "C:/daily", "daily//sub", "daily/."] {
        assert!(execute(&exact, &json!({"libraryId":"notes","directory":directory})).is_err());
    }
    for args in [
        json!({"libraryId":"notes","dateFrom":"2025-02-30"}),
        json!({"libraryId":"notes","dateFrom":"2025-03-01","dateTo":"2025-01-01"}),
        json!({"libraryId":"notes","limit":51}),
        json!({"libraryId":"notes","cursor":"forged"}),
    ] {
        assert!(execute(&exact, &args).is_err());
    }
    assert_eq!(file_date("daily/2024-02-29.md"), Some("2024-02-29".into()));
    assert!(file_date("daily/2025-02-29.md").is_none());
    assert!(file_date("daily/2025-01-01 summary.md").is_none());
}
#[test]
fn source_manifest_shared_entry_keeps_dependencies_across_reopen_without_writes() {
    let f = Fixture::new();
    seed(&f);
    let scope = EvidenceScope::new(vec!["notes".into()], vec![]).unwrap();
    let mut session = crate::hub_capabilities::Session::new(&f.root, Some(scope.clone())).unwrap();
    let before: i64 = f
        .c()
        .query_row("SELECT count(*) FROM agent_records", [], |r| r.get(0))
        .unwrap();
    let page = session
        .call(
            "hub_source_manifest",
            &json!({"libraryId":"notes","directory":"daily","limit":4}),
            "",
        )
        .unwrap();
    assert_eq!(page["members"].as_array().unwrap().len(), 4);
    let deps = session.material_reads();
    let mut resumed = crate::hub_capabilities::Session::new(&f.root, Some(scope)).unwrap();
    resumed.inherit_materials(&deps).unwrap();
    f.note("notes", "daily/2025-01-01", "changed");
    assert!(resumed.verify().is_err());
    assert_eq!(
        f.c()
            .query_row::<i64, _, _>("SELECT count(*) FROM agent_records", [], |r| r.get(0))
            .unwrap(),
        before
    );
}

#[test]
fn source_manifest_page_capacity_fails_explicitly_without_truncating_members() {
    let f = Fixture::new();
    for i in 0..20 {
        f.note("notes", &format!("daily/{}-{i}", "x".repeat(900)), "body");
    }
    let r = reader(&f);
    assert!(execute(
        &r,
        &json!({"libraryId":"notes","directory":"daily","limit":20})
    )
    .unwrap_err()
    .contains("48KiB"));
    let page = execute(
        &r,
        &json!({"libraryId":"notes","directory":"daily","limit":1}),
    )
    .unwrap();
    assert_eq!(page["totalMembers"], 20);
    assert_eq!(page["members"].as_array().unwrap().len(), 1);
    assert!(page["nextCursor"].is_string());
}
