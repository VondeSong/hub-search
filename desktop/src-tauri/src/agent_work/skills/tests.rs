use super::*;
use crate::obsidian_edit::tests::Fixture;

#[test]
fn research_skill_distinguishes_local_web_and_mixed_sources_without_forcing_loading() {
    let f = Fixture::new();
    let mut catalog = Catalog::discover(&f.root).unwrap();
    let metadata = catalog.metadata();
    let research = metadata["skills"].as_array().unwrap().iter().find(|s| s["name"] == "hub-research").unwrap();
    assert!(research["description"].as_str().unwrap().contains("纯公开网页调研"));
    assert!(catalog.loaded.is_empty());
    for request in ["分析 Hub 已授权的笔记", "结合 Hub 笔记和公开网页比较", "请使用 $hub-research 分析公开网页"] {
        let loaded = catalog.load("hub-research", request).unwrap();
        let body = loaded["instructions"].as_str().unwrap();
        assert!(body.contains("引用 Hub 原文时"));
        assert!(body.contains("引用公开网页时"));
        assert!(body.contains("混合来源分别保留"));
        assert!(!body.contains("引用只选择本轮原文目录的编号"));
    }
}

fn package(f: &Fixture, name: &str, body: &str, policy: &str) -> PathBuf {
    let directory = f.root.join("agent-skills").join(name);
    std::fs::create_dir_all(directory.join("references")).unwrap();
    std::fs::write(
        directory.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: 学习审核方法\n---\n{body}\n"),
    )
    .unwrap();
    if !policy.is_empty() {
        std::fs::create_dir_all(directory.join("agents")).unwrap();
        std::fs::write(directory.join("agents/openai.yaml"), policy).unwrap();
    }
    directory
}

#[test]
fn catalog_discloses_metadata_and_loads_instructions_and_references_only_when_selected() {
    let f = Fixture::new();
    let mut catalog = Catalog::discover(&f.root).unwrap();
    assert_eq!(
        catalog.metadata()["skills"].as_array().unwrap().len(),
        BUILTINS.len()
    );
    assert!(!catalog
        .metadata()
        .to_string()
        .contains("先取得真实 draftContext"));
    assert!(catalog.loaded.is_empty());
    assert!(catalog
        .read_reference("hub-flashcards", "references/quality.md")
        .is_err());
    let loaded = catalog
        .load("hub-flashcards", "制作当前笔记的闪卡")
        .unwrap();
    assert_eq!(loaded["kind"], "skillInstructions");
    assert!(loaded["instructions"]
        .as_str()
        .unwrap()
        .contains("candidateSchema"));
    let reference = catalog
        .read_reference("hub-flashcards", "references/quality.md")
        .unwrap();
    assert!(reference["content"].as_str().unwrap().contains("否定词"));
    assert_eq!(catalog.reads().as_array().unwrap().len(), 1);
    catalog.verify().unwrap();
}

#[test]
fn explicit_only_policy_requires_the_actual_user_mention_with_token_boundaries() {
    let f = Fixture::new();
    package(
        &f,
        "study-audit",
        "审查学习范围。",
        "policy:\n  allow_implicit_invocation: false\n",
    );
    let mut catalog = Catalog::discover(&f.root).unwrap();
    assert!(catalog
        .load("study-audit", "帮我审查学习范围")
        .unwrap_err()
        .contains("明确指定"));
    for request in ["$study-audit-other", "x$study-audit", "\\$study-audit"] {
        assert!(catalog.load("study-audit", request).is_err(), "{request}");
    }
    assert!(catalog
        .load("study-audit", "请使用 $study-audit 核对。")
        .is_ok());
}

#[test]
fn unknown_dependencies_are_visible_and_do_not_grant_tools_or_read_instructions() {
    let f = Fixture::new();
    package(
        &f,
        "requires-shell",
        "不能被加载的正文。",
        "dependencies:\n  tools:\n    - type: mcp\n      value: terminal\n",
    );
    let mut catalog = Catalog::discover(&f.root).unwrap();
    let skill = catalog.metadata()["skills"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == "requires-shell")
        .unwrap()
        .clone();
    assert_eq!(skill["available"], false);
    assert!(catalog
        .load("requires-shell", "$requires-shell")
        .unwrap_err()
        .contains("terminal"));
    assert!(!catalog.loaded.contains("requires-shell"));
    assert_eq!(catalog.metadata()["scriptExecution"], false);
}

#[test]
fn malformed_and_duplicate_packages_leave_builtins_available_with_diagnostics() {
    let f = Fixture::new();
    package(&f, "hub-flashcards", "错误的覆盖。", "");
    let broken = package(&f, "broken", "正文", "");
    std::fs::write(broken.join("SKILL.md"), "没有元信息").unwrap();
    let mut catalog = Catalog::discover(&f.root).unwrap();
    assert_eq!(
        catalog.metadata()["skills"].as_array().unwrap().len(),
        BUILTINS.len()
    );
    assert_eq!(catalog.diagnostics.len(), 2);
    assert_eq!(
        catalog.load("hub-flashcards", "").unwrap()["skill"]["origin"],
        "builtin"
    );
}

#[test]
fn reference_reads_reject_traversal_absolute_paths_scripts_binary_and_oversized_files() {
    let f = Fixture::new();
    let directory = package(&f, "study-audit", "读取 references/check.md。", "");
    std::fs::write(directory.join("references/check.md"), "正常方法").unwrap();
    std::fs::write(
        directory.join("references/large.md"),
        "x".repeat(MAX_REFERENCE + 1),
    )
    .unwrap();
    std::fs::write(directory.join("references/binary.md"), [255, 254]).unwrap();
    std::fs::write(f.root.join("outside.md"), "不允许读取的文件").unwrap();
    let mut catalog = Catalog::discover(&f.root).unwrap();
    catalog.load("study-audit", "").unwrap();
    for path in [
        "references/../../outside.md",
        "references/../SKILL.md",
        "/outside.md",
        "C:/outside.md",
        "references\\check.md",
        "references/run.py",
        "references/large.md",
        "references/binary.md",
    ] {
        assert!(
            catalog.read_reference("study-audit", path).is_err(),
            "{path}"
        );
    }
    assert_eq!(
        catalog
            .read_reference("study-audit", "references/check.md")
            .unwrap()["content"],
        "正常方法"
    );
}

#[test]
fn changed_instructions_invalidate_the_run_and_native_catalog_identity() {
    let f = Fixture::new();
    let directory = package(&f, "study-audit", "第一版方法。", "");
    let mut catalog = Catalog::discover(&f.root).unwrap();
    catalog.load("study-audit", "").unwrap();
    let identity = catalog.fingerprint();
    let path = directory.join("SKILL.md");
    let old = std::fs::read_to_string(&path).unwrap();
    std::fs::write(&path, old.replace("第一版", "第二版")).unwrap();
    assert_ne!(identity, Catalog::discover(&f.root).unwrap().fingerprint());
    assert!(catalog.verify().unwrap_err().contains("已变化"));
}

#[test]
fn references_are_versioned_across_native_resumption_and_changes_reject_old_context() {
    let f = Fixture::new();
    let directory = package(&f, "study-audit", "读取 references/check.md。", "");
    let path = directory.join("references/check.md");
    std::fs::write(&path, "第一版").unwrap();
    let mut first = Catalog::discover(&f.root).unwrap();
    first.load("study-audit", "").unwrap();
    first
        .read_reference("study-audit", "references/check.md")
        .unwrap();
    let mut second = Catalog::discover(&f.root).unwrap();
    second.inherit_reads(&first.reads()).unwrap();
    std::fs::write(&path, "第二版").unwrap();
    assert!(first.verify().is_err());
    assert!(second.verify().is_err());
    assert!(Catalog::discover(&f.root)
        .unwrap()
        .inherit_reads(&first.reads())
        .is_err());
}

#[test]
fn discovery_uses_only_the_hub_data_directory_and_bounds_the_catalog() {
    let f = Fixture::new();
    let global = f.root.join(".codex/skills/unrelated");
    std::fs::create_dir_all(&global).unwrap();
    std::fs::write(global.join("SKILL.md"), "global skill").unwrap();
    for number in 0..MAX_USER_SKILLS + 2 {
        package(&f, &format!("custom-{number:02}"), "普通方法。", "");
    }
    let catalog = Catalog::discover(&f.root).unwrap();
    assert_eq!(catalog.skills.len(), BUILTINS.len() + MAX_USER_SKILLS);
    assert_eq!(catalog.diagnostics.len(), 1);
    assert!(!catalog.skills.contains_key("unrelated"));
}

#[test]
fn parser_handles_multiline_yaml_and_rejects_invalid_identity_and_limits() {
    let skill = parse(
        "---\nname: study-audit\ndescription: >-\n  审查学习\n  与复习\n---\n具体方法。\n",
        "",
        None,
    )
    .unwrap();
    assert!(skill.description.contains("审查学习"));
    for name in ["", "../outside", "Upper", "a--b", "-a", "a-"] {
        assert!(parse(
            &format!("---\nname: '{name}'\ndescription: 描述\n---\n方法。\n"),
            "",
            None
        )
        .is_err());
    }
    assert!(parse(&"x".repeat(MAX_DOCUMENT + 1), "", None).is_err());
}

#[test]
fn builtin_reference_paths_replay_missing_sleep_reference_without_granting_a_file() {
    let f = Fixture::new();
    let fixture: Value = serde_json::from_str(include_str!(
        "../artifacts/tests/sleep/fixtures/protocol-feedback-20261024.json"
    ))
    .unwrap();
    let request = &fixture["rejected"][0]["request"];
    let mut catalog = Catalog::discover(&f.root).unwrap();
    let loaded = catalog
        .load(
            request["name"].as_str().unwrap(),
            fixture["goal"].as_str().unwrap(),
        )
        .unwrap();
    assert_eq!(loaded["referencePaths"], json!([]));
    assert!(loaded["referencePolicy"]
        .as_str()
        .unwrap()
        .contains("没有配套参考文件"));
    let error = catalog
        .read_reference(
            request["name"].as_str().unwrap(),
            request["path"].as_str().unwrap(),
        )
        .unwrap_err();
    assert!(error.starts_with(fixture["rejected"][0]["expectedError"].as_str().unwrap()));
    assert!(error.contains("没有配套参考文件"));
    assert_eq!(catalog.reads(), json!([]));
    // A disclosed builtin path must be served by the very same registry.
    for document in BUILTINS {
        let name = parse(document, "", None).unwrap().name;
        let loaded = catalog.load(&name, "").unwrap();
        let expected = builtin_reference_paths(&name);
        assert_eq!(loaded["referencePaths"], json!(expected));
        for path in loaded["referencePaths"].as_array().unwrap() {
            catalog
                .read_reference(&name, path.as_str().unwrap())
                .unwrap();
        }
    }
    assert_eq!(
        catalog.reads().as_array().unwrap().len(),
        BUILTIN_REFERENCES.len()
    );
    // User packages are not declared empty or granted new paths by this change.
    package(
        &f,
        "user-method",
        "只读取明确提供的 references/check.md。",
        "",
    );
    let mut user = Catalog::discover(&f.root).unwrap();
    assert!(user.load("user-method", "").unwrap()["referencePaths"].is_null());
    if let Ok(directory) = std::env::var("HUB_SLEEP_PROTOCOL_REPORT") {
        std::fs::write(Path::new(&directory).join("skill-reference-replay.json"), serde_json::to_vec_pretty(&json!({"savedRequest":request,"replayedError":error,"statisticsReferencePaths":loaded["referencePaths"],"registryReferencesVerified":BUILTIN_REFERENCES.len(),"missingReferenceReadNotRecorded":true})).unwrap()).unwrap();
    }
}
