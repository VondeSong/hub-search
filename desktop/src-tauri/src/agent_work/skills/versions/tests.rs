use super::*;
use crate::obsidian_edit::tests::Fixture;

fn resign(value: &mut Value) {
    value["id"] = json!(format!("method-{}", hash(&value["content"].to_string())));
}

#[test]
fn v5_method_snapshot_keeps_full_builtin_document_and_exact_roundtrip() {
    let f = Fixture::new();
    let catalog = Catalog::discover(&f.root).unwrap();
    let version = catalog.fixed_version("hub-statistics").unwrap();
    let encoded = serde_json::to_vec(&version).unwrap();
    assert!(encoded.len() < 65_536);
    let saved: Value = serde_json::from_slice(&encoded).unwrap();
    assert_eq!(
        saved["content"]["files"]["SKILL.md"],
        include_str!("../hub-statistics/SKILL.md")
    );
    let mut reopened = Catalog::discover(&f.root).unwrap();
    reopened.pin_version(&saved).unwrap();
    assert_eq!(
        reopened.load("hub-statistics", "统计当前授权材料").unwrap()["instructions"],
        catalog.skills["hub-statistics"].instructions
    );
    assert_eq!(reopened.fixed_version("hub-statistics").unwrap(), saved);
}

#[test]
fn v5_method_old_reference_bytes_restore_without_using_current_reference() {
    let f = Fixture::new();
    let mut old = Catalog::discover(&f.root)
        .unwrap()
        .fixed_version("hub-flashcards")
        .unwrap();
    old["content"]["files"]["references/quality.md"] =
        json!("这是保存版本的配套方法，不是用户事实。");
    resign(&mut old);
    let mut catalog = Catalog::discover(&f.root).unwrap();
    catalog.pin_version(&old).unwrap();
    let loaded = catalog.load("hub-flashcards", "制作卡片").unwrap();
    assert_eq!(loaded["referencePaths"], json!(["references/quality.md"]));
    let result = catalog
        .read_reference("hub-flashcards", "references/quality.md")
        .unwrap();
    assert_eq!(
        result["content"],
        old["content"]["files"]["references/quality.md"]
    );
    assert_ne!(result["content"], BUILTIN_REFERENCES[0].2);
    catalog.verify().unwrap();
    let mut reopened = Catalog::discover(&f.root).unwrap();
    reopened.pin_version(&old).unwrap();
    reopened.inherit_reads(&catalog.reads()).unwrap();
    reopened.verify().unwrap();
}

#[test]
fn v5_method_snapshot_rejects_corruption_tool_change_removed_origin_and_paths() {
    let f = Fixture::new();
    let catalog = Catalog::discover(&f.root).unwrap();
    let original = catalog.fixed_version("hub-statistics").unwrap();
    let mut bad = original.clone();
    bad["content"]["files"]["SKILL.md"] = json!("changed");
    assert!(restore(&catalog, &bad).err().unwrap().contains("指纹"));
    let mut changed = original.clone();
    changed["content"]["toolContractVersion"] = json!("other-contract");
    resign(&mut changed);
    assert!(restore(&catalog, &changed)
        .err()
        .unwrap()
        .contains("工具合同"));
    let mut removed = Catalog::discover(&f.root).unwrap();
    removed.skills.remove("hub-statistics");
    assert!(removed
        .pin_version(&original)
        .unwrap_err()
        .contains("已不可用"));
    let mut path = original.clone();
    path["content"]["files"]["references/../outside.md"] = json!("not loaded");
    resign(&mut path);
    assert!(restore(&catalog, &path).is_err());
    let mut too_large = original.clone();
    too_large["content"]["files"]["references/large.md"] = json!("x".repeat(65_536));
    resign(&mut too_large);
    assert!(restore(&catalog, &too_large).is_err());
}

#[test]
fn v5_method_pin_does_not_change_active_method_or_accept_user_package() {
    let f = Fixture::new();
    let mut catalog = Catalog::discover(&f.root).unwrap();
    let pin = catalog.fixed_version("hub-statistics").unwrap();
    let before = catalog.fingerprint();
    catalog.load("hub-research", "总结当前材料").unwrap();
    assert!(catalog
        .pin_version(&pin)
        .unwrap_err()
        .contains("合法运行边界"));
    assert_eq!(catalog.fingerprint(), before);
    let package = f.root.join("agent-skills/custom");
    std::fs::create_dir_all(&package).unwrap();
    std::fs::write(
        package.join("SKILL.md"),
        "---\nname: custom\ndescription: 合成方法\n---\n仅作为方法。\n",
    )
    .unwrap();
    let catalog = Catalog::discover(&f.root).unwrap();
    assert!(catalog
        .fixed_version("custom")
        .unwrap_err()
        .contains("用户技能包"));
}

#[test]
fn v5_method_pin_reapplies_tool_restrictions_without_duplicate_diagnostics() {
    let f = Fixture::new();
    let mut catalog = Catalog::discover(&f.root).unwrap();
    let pin = catalog.fixed_version("hub-statistics").unwrap();
    catalog.restrict_tools(HashSet::new());
    let before = catalog.metadata()["skills"].clone();
    catalog.pin_version(&pin).unwrap();
    assert_eq!(catalog.metadata()["skills"], before);
    catalog.verify().unwrap();
    assert!(catalog.load("hub-statistics", "核对材料").is_err());
}
