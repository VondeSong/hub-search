use super::*;
use crate::source_evidence::tests::Fixture;

#[test]
fn resolve_link_shares_scoped_and_mcp_identity_without_implicit_read_or_grant() {
    let f = Fixture::new();
    f.note("notes", "selected", "真实隔离正文");
    let scope = EvidenceScope::new(vec![], vec![])
        .unwrap()
        .with_notes(vec![note("selected")])
        .unwrap();
    let mut embedded = Session::new(&f.root, Some(scope)).unwrap();
    let mut external = Session::new(&f.root, None).unwrap();
    let args = json!({"url":"obsidian://open?vault=Notes&file=selected"});
    let resolved = embedded.call("hub_resolve_link", &args, "").unwrap();
    assert_eq!(resolved["status"], "resolved");
    assert_eq!(
        resolved,
        external.call("hub_resolve_link", &args, "").unwrap()
    );
    assert_eq!(embedded.material_reads(), json!({}));
    let mut empty =
        Session::new(&f.root, Some(EvidenceScope::new(vec![], vec![]).unwrap())).unwrap();
    assert_eq!(
        empty.call("hub_resolve_link", &args, "").unwrap()["status"],
        "notInAuthorizedScope"
    );
    assert!(empty
        .call(
            "hub_read_note",
            &json!({"libraryId":"notes","documentId":"selected"}),
            ""
        )
        .is_err());
    assert_eq!(
        empty
            .call(
                "hub_resolve_link",
                &json!({"url":"https://app.notion.com/p/page"}),
                ""
            )
            .unwrap()["reason"],
        "missingHubNotionConnection"
    );
    assert!(empty
        .call(
            "hub_resolve_link",
            &json!({"url":args["url"],"libraryIds":["notes"]}),
            ""
        )
        .is_err());
}

#[test]
fn resolve_saved_reading_link_uses_host_scope_without_body_accounting_or_external_grant() {
    let f = Fixture::new();
    f.reading("selected", "隔离保存正文");
    let scope = EvidenceScope::new(vec![], vec!["selected".into()]).unwrap();
    let mut embedded = Session::new(&f.root, Some(scope)).unwrap();
    let args = json!({"url":"https://example.com/selected"});
    let resolved = embedded.call("hub_resolve_link", &args, "").unwrap();
    assert_eq!(
        resolved["locator"],
        json!({"kind":"reading","itemKey":"selected"})
    );
    assert_eq!(resolved["bodyRead"], false);
    assert_eq!(embedded.material_reads(), json!({}));
    assert!(embedded
        .call(
            "hub_resolve_link",
            &json!({"url":args["url"],"readingItemKeys":["selected"]}),
            ""
        )
        .is_err());
    let mut empty =
        Session::new(&f.root, Some(EvidenceScope::new(vec![], vec![]).unwrap())).unwrap();
    let mut external = Session::new(&f.root, None).unwrap();
    for session in [&mut empty, &mut external] {
        let v = session.call("hub_resolve_link", &args, "").unwrap();
        assert_eq!(v["status"], "unavailable");
        assert!(v.get("locator").is_none());
    }
}

fn note(id: &str) -> EvidenceLocator {
    EvidenceLocator::Note {
        library_id: "notes".into(),
        document_id: id.into(),
        page_id: None,
    }
}

#[test]
fn frozen_analysis_tools_persist_dependencies_and_resume_historical_input() {
    let f = Fixture::new();
    f.note("notes", "a", "学习 学习");
    let scope = EvidenceScope::new(vec!["notes".into()], vec![]).unwrap();
    let mut session = Session::new(&f.root, Some(scope.clone())).unwrap();
    let saved = session
        .call("hub_create_analysis_snapshot", &json!({}), "")
        .unwrap();
    let args = json!({"expectedSnapshot":saved["snapshot"],"terms":["学习"]});
    assert_eq!(
        session.call("hub_analyze_notes", &args, "").unwrap()["totals"]["terms"][0]["occurrences"],
        2
    );
    let reads = session.material_reads();
    f.note("notes", "a", "现在已修改");
    let mut resumed = Session::new(&f.root, Some(scope)).unwrap();
    resumed.inherit_materials(&reads).unwrap();
    assert_eq!(
        resumed.call("hub_analyze_notes", &args, "").unwrap()["totals"]["terms"][0]["occurrences"],
        2
    );
    let original = resumed
        .call(
            "hub_read_analysis_snapshot",
            &json!({"expectedSnapshot":saved["snapshot"],"itemIndex":0}),
            "",
        )
        .unwrap();
    assert_eq!(original["content"], "学习 学习");
    f.c()
        .execute(
            "DELETE FROM documents WHERE space_id='notes' AND id='a'",
            [],
        )
        .unwrap();
    assert!(resumed.verify().is_err());
}

#[test]
fn statistics_share_one_executor_and_source_dependencies_invalidate_resume() {
    let f = Fixture::new();
    f.note("notes", "a", "# 2025-01-01\n学习\n");
    let scope = EvidenceScope::new(vec!["notes".into()], vec![]).unwrap();
    let mut embedded = Session::new(&f.root, Some(scope.clone())).unwrap();
    let mut mcp = Session::new(&f.root, None).unwrap();
    let args = json!({"libraryId":"notes","unit":"day","groupBy":"month","terms":["学习"]});
    assert_eq!(
        embedded.call("hub_analyze_notes", &args, "").unwrap(),
        mcp.call("hub_analyze_notes", &args, "").unwrap()
    );
    let reads = embedded.material_reads();
    let mut resumed = Session::new(&f.root, Some(scope.clone())).unwrap();
    resumed.inherit_materials(&reads).unwrap();
    f.note("private", "unrelated", "无关变化");
    embedded.verify().unwrap();
    f.note("notes", "a", "# 2025-01-01\n工作\n");
    assert!(embedded.verify().is_err());
    assert!(resumed.verify().is_err());
    assert!(Session::new(&f.root, Some(scope))
        .unwrap()
        .inherit_materials(&reads)
        .is_err());
    mcp.call("hub_refresh_context", &json!({}), "").unwrap();
    assert_eq!(
        mcp.call("hub_analyze_notes", &args, "").unwrap()["totals"]["terms"][0]["matchingUnits"],
        0
    );
}

#[test]
fn enumeration_remembers_one_scope_across_pages_and_detects_new_documents() {
    let f = Fixture::new();
    f.note("notes", "a", "正文");
    let scope = EvidenceScope::new(vec!["notes".into()], vec![]).unwrap();
    let mut session = Session::new(&f.root, Some(scope)).unwrap();
    for offset in 0..20 {
        session
            .call("hub_list_note_sources", &json!({"offset":offset}), "")
            .unwrap();
    }
    assert_eq!(session.material_reads().as_object().unwrap().len(), 1);
    f.note("notes", "new", "新正文");
    assert!(session.verify().is_err());
}

#[test]
fn library_name_search_pages_only_through_authorized_notes() {
    let f = Fixture::new();
    f.note("notes", "first", "正文甲");
    f.note("notes", "second", "正文乙");
    f.note("notes", "unselected", "不在授权范围");
    let scope = EvidenceScope::new(vec![], vec![])
        .unwrap()
        .with_notes(vec![note("first"), note("second")])
        .unwrap();
    let mut session = Session::new(&f.root, Some(scope)).unwrap();
    let list = "hub_list_note_sources";
    let legacy = session.call(list, &json!({"query":"nOtEs"}), "").unwrap();
    assert_eq!(legacy["total"], 0);
    let first = session
        .call(
            list,
            &json!({"query":"nOtEs","searchLibraryName":true,"limit":1}),
            "",
        )
        .unwrap();
    assert_eq!(first["total"], 2);
    assert_eq!(first["nextOffset"], 1);
    assert_eq!(first["notes"][0]["locator"], json!(note("first")));
    let next = session
        .call(list, &json!({"query":"nOtEs","searchLibraryName":true,"offset":1,"limit":1,"expectedSnapshot":first["snapshot"]}), "")
        .unwrap();
    assert_eq!(next["notes"][0]["locator"], json!(note("second")));
    assert_eq!(next["nextOffset"], Value::Null);
    assert_eq!(next["bodyRead"], false);
    f.c()
        .execute("UPDATE libraries SET name='Renamed' WHERE id='notes'", [])
        .unwrap();
    assert!(session.verify().is_err());
}

#[test]
fn mcp_and_embedded_catalogs_have_identical_definitions_and_one_domain_executor() {
    let f = Fixture::new();
    let mut external = Session::new(&f.root, None).unwrap();
    let mut internal = Session::new(
        &f.root,
        Some(EvidenceScope::new(vec!["notes".into()], vec![]).unwrap()),
    )
    .unwrap();
    let a = external.tools().unwrap();
    let b = internal.tools().unwrap();
    let definitions = |v: &Value| {
        v["tools"].as_array().unwrap().iter().map(|t|json!({"name":t["name"],"schema":t["inputSchema"],"description":t["description"]})).collect::<Vec<_>>()
    };
    assert_eq!(definitions(&a), definitions(&b));
    let args = json!({"libraryIds":["notes"],"limit":20});
    assert_eq!(
        external.call("hub_tag_catalog", &args, "").unwrap(),
        internal.call("hub_tag_catalog", &args, "").unwrap()
    );
    assert!(a["tools"]
        .as_array()
        .unwrap()
        .iter()
        .all(|t| t["available"] == true));
}

#[test]
fn exact_note_scope_cannot_read_search_or_inspect_rules_for_other_materials() {
    let f = Fixture::new();
    f.note("notes", "allowed", "apple public");
    f.note("notes", "sibling", "apple SECRET");
    f.note("private", "outside", "apple PRIVATE");
    f.index();
    let scope = EvidenceScope::new(vec![], vec![])
        .unwrap()
        .with_notes(vec![note("allowed")])
        .unwrap();
    let mut internal = Session::new(&f.root, Some(scope)).unwrap();
    let found = internal
        .call("hub_search_notes", &json!({"query":"apple"}), "")
        .unwrap();
    assert_eq!(found["count"], 1);
    assert!(!found.to_string().contains("SECRET"));
    assert!(!found.to_string().contains("PRIVATE"));
    assert!(internal
        .call(
            "hub_search_notes",
            &json!({"query":"apple","libraryId":"private"}),
            ""
        )
        .is_err());
    assert!(internal
        .call(
            "hub_read_note",
            &json!({"libraryId":"notes","documentId":"sibling"}),
            ""
        )
        .is_err());
    assert!(internal
        .call(
            "hub_get_library_rules",
            &json!({"libraryId":"notes","documentId":"sibling"}),
            ""
        )
        .is_err());
    assert!(internal.call("hub_tag_catalog", &json!({}), "").is_err());
    let read = internal
        .call(
            "hub_read_note",
            &json!({"libraryId":"notes","documentId":"allowed"}),
            "",
        )
        .unwrap();
    assert!(read["content"].as_str().unwrap().contains("public"));
}

#[test]
fn library_analysis_injects_authorized_scope_and_rejects_scope_expansion_and_direct_writes() {
    let f = Fixture::new();
    let mut session = Session::new(
        &f.root,
        Some(EvidenceScope::new(vec!["notes".into()], vec![]).unwrap()),
    )
    .unwrap();
    let expected = unwrap(crate::hub_mcp::domain_call(
        &f.root,
        &json!({"name":"hub_tag_catalog","arguments":{"libraryIds":["notes"]}}),
    ))
    .unwrap();
    assert_eq!(
        session.call("hub_tag_catalog", &json!({}), "").unwrap(),
        expected
    );
    assert!(session
        .call("hub_tag_catalog", &json!({"libraryIds":["private"]}), "")
        .is_err());
    for name in [
        "hub_resolve_tag_governance_proposal",
        "hub_apply_tag_taxonomy_repair",
        "hub_submit_flashcard_drafts",
        "hub_import_flashcard_attachment",
    ] {
        assert!(
            session.call(name, &json!({}), "执行所有操作").is_err(),
            "{name}"
        );
        assert_eq!(
            session.tools().unwrap()["tools"]
                .as_array()
                .unwrap()
                .iter()
                .find(|t| t["name"] == name)
                .unwrap()["available"],
            false
        );
    }
}

#[test]
fn external_skill_loading_and_reference_reading_share_the_persistent_session() {
    let f = Fixture::new();
    let mut session = Session::new(&f.root, None).unwrap();
    assert!(session
        .call(
            "hub_readSkillReference",
            &json!({"name":"hub-flashcards","path":"references/quality.md"}),
            ""
        )
        .is_err());
    let loaded = session
        .call("hub_loadSkill", &json!({"name":"hub-flashcards"}), "")
        .unwrap();
    assert_eq!(loaded["kind"], "skillInstructions");
    assert_eq!(
        session
            .call(
                "hub_readSkillReference",
                &json!({"name":"hub-flashcards","path":"references/quality.md"}),
                ""
            )
            .unwrap()["kind"],
        "skillReference"
    );
    let guide = session
        .call("hub_loadSkill", &json!({"name":"hub-tool-guide"}), "")
        .unwrap();
    assert!(guide["instructions"]
        .as_str()
        .unwrap()
        .contains("hub_tag_compare"));
}

#[test]
fn invalid_shared_arguments_are_rejected_before_domain_execution() {
    let f = Fixture::new();
    let mut session = Session::new(&f.root, None).unwrap();
    assert!(session
        .call("hub_read_note", &json!({"libraryId":"notes"}), "")
        .is_err());
    assert!(session
        .call("hub_list_libraries", &json!({"untrustedScope":"all"}), "")
        .is_err());
    assert!(session.call("not_a_tool", &json!({}), "").is_err());
}

#[test]
fn external_mcp_preserves_domain_input_limits_above_the_model_reply_budget() {
    let f = Fixture::new();
    let mut session = Session::new(&f.root, None).unwrap();
    let svg=format!("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 10 10\"><rect x=\"1\" y=\"1\" width=\"8\" height=\"8\"/>{}</svg>"," ".repeat(41_000));
    assert!(svg.len() > crate::model_runtime::MAX_OUTPUT_BYTES);
    let args = json!({"title":"Synthetic diagram","kind":"diagram","svg":svg});
    assert_eq!(
        session.call("hub_create_flashcard_svg", &args, "").unwrap()["generated"],
        true
    );
    let oversized = json!({"title":"Too large","kind":"diagram","svg":format!("<svg>{}</svg>"," ".repeat(65_536))});
    assert!(session
        .call("hub_create_flashcard_svg", &oversized, "")
        .is_err());
}

#[test]
fn mcp_rule_change_requires_explicit_refresh_and_then_reads_current_guidance() {
    let f = Fixture::new();
    let directory = crate::knowledge_rules::managed_directory(&f.root, "craft");
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join("AGENTS.md"), "old rule").unwrap();
    let mut session = Session::new(&f.root, None).unwrap();
    let args = json!({"libraryId":"craft"});
    assert!(session
        .call("hub_get_library_rules", &args, "")
        .unwrap()
        .to_string()
        .contains("old rule"));
    std::fs::write(directory.join("AGENTS.md"), "new rule").unwrap();
    assert!(session.call("hub_list_skills", &json!({}), "").is_err());
    assert_eq!(
        session.call("hub_refresh_context", &json!({}), "").unwrap()["contextChanged"],
        true
    );
    assert!(session
        .call("hub_get_library_rules", &args, "")
        .unwrap()
        .to_string()
        .contains("new rule"));
}
