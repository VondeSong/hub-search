//! Hub-owned, versioned model guidance. No runtime dependency on a Codex install.
const FILES: &[(&str, &str)] = &[
    (
        "craft-general-archive/SKILL.md",
        include_str!("../../assets/model-skills/v1/craft-general-archive/SKILL.md"),
    ),
    (
        "craft-general-archive/references/content-workflow.md",
        include_str!(
            "../../assets/model-skills/v1/craft-general-archive/references/content-workflow.md"
        ),
    ),
    (
        "craft-general-archive/references/craft-presentation.md",
        include_str!(
            "../../assets/model-skills/v1/craft-general-archive/references/craft-presentation.md"
        ),
    ),
    (
        "craft-general-archive/references/craft-blocks.md",
        include_str!(
            "../../assets/model-skills/v1/craft-general-archive/references/craft-blocks.md"
        ),
    ),
    (
        "craft-general-archive/references/write-protocol.md",
        include_str!(
            "../../assets/model-skills/v1/craft-general-archive/references/write-protocol.md"
        ),
    ),
    (
        "craft-car-archive/SKILL.md",
        include_str!("../../assets/model-skills/v1/craft-car-archive/SKILL.md"),
    ),
    (
        "craft-car-archive/references/source-analysis.md",
        include_str!(
            "../../assets/model-skills/v1/craft-car-archive/references/source-analysis.md"
        ),
    ),
    (
        "craft-car-archive/references/automotive-evidence.md",
        include_str!(
            "../../assets/model-skills/v1/craft-car-archive/references/automotive-evidence.md"
        ),
    ),
    (
        "content-to-tasks/SKILL.md",
        include_str!("../../assets/model-skills/v1/content-to-tasks/SKILL.md"),
    ),
    (
        "content-to-tasks/references/task-conversion.md",
        include_str!("../../assets/model-skills/v1/content-to-tasks/references/task-conversion.md"),
    ),
    (
        "content-to-tasks/references/dida-adapter.md",
        include_str!("../../assets/model-skills/v1/content-to-tasks/references/dida-adapter.md"),
    ),
    (
        "content-to-tasks/references/hub-contract.md",
        include_str!("../../assets/model-skills/v1/content-to-tasks/references/hub-contract.md"),
    ),
];
pub(crate) fn load(name: &str, refs: &[&str]) -> Result<String, String> {
    let mut result = String::from("Hub 内置技能版本：1\n");
    for relative in std::iter::once("SKILL.md").chain(refs.iter().copied()) {
        let key = if let Some(value) = relative.strip_prefix("../") {
            value.to_string()
        } else {
            format!("{name}/{relative}")
        };
        let text = FILES
            .iter()
            .find(|(path, _)| *path == key)
            .map(|(_, text)| *text)
            .ok_or("Hub 内置技能引用无效，请更新应用。")?;
        result.push_str(&format!("\n--- {key} ---\n{text}"));
    }
    Ok(result)
}
#[test]
fn packaged_guidance_has_complete_reference_closure_without_codex_home() {
    assert!(
        load("craft-general-archive", &["references/write-protocol.md"])
            .unwrap()
            .contains("Hub 内置技能版本：1")
    );
    assert!(load(
        "craft-car-archive",
        &[
            "references/source-analysis.md",
            "../craft-general-archive/references/craft-blocks.md"
        ]
    )
    .is_ok());
    assert!(load(
        "content-to-tasks",
        &[
            "references/task-conversion.md",
            "references/dida-adapter.md",
            "references/hub-contract.md"
        ]
    )
    .is_ok());
    assert!(load("unknown", &[]).is_err());
}
