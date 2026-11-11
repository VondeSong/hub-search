//! Per-conversation choices, saved by explicit UI actions. The runtime remains
//! the only owner of provider credentials, admission and global preferences.
use super::*;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Options {
    pub model: Option<crate::model_runtime::Settings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub research_policy: Option<ResearchPolicy>,
    #[serde(default)]
    pub auto_flashcard_inbox: bool,
    #[serde(default, skip_serializing_if = "disabled")]
    pub external_mcp: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mcp_services: Vec<crate::model_runtime::mcp_services::Grant>,
    #[serde(
        default,
        skip_serializing_if = "crate::model_runtime::agent_web::Mode::disabled"
    )]
    pub web_search: crate::model_runtime::agent_web::Mode,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum ResearchPolicy {
    MaterialFirst,
    MaterialsOnly,
    Open,
}
impl Options {
    pub fn materials_only(&self) -> bool {
        self.research_policy == Some(ResearchPolicy::MaterialsOnly)
    }
    pub fn effective_web_search(&self) -> crate::model_runtime::agent_web::Mode {
        if self.materials_only() {
            Default::default()
        } else {
            self.web_search
        }
    }
    pub fn research_guide(&self) -> &'static str {
        match self.research_policy {
            Some(ResearchPolicy::MaterialFirst) => "资料策略：材料优先。先实际读取用户明确指定的核心材料，再在已授权范围检索；遇到时效变化、信息缺口或冲突时才按本轮联网授权补充公开来源。区分原文、外部来源和推断。未读完不能声称全面审阅。",
            Some(ResearchPolicy::MaterialsOnly) => "资料策略：仅依据材料。事实与引用仅来自本轮已授权材料；不搜索网页、不读取公共链接或外部 MCP、不使用共享记忆补事实，不以模型常识填补材料缺口。可以对已读材料做归纳和推理，需明确标注推断。材料不足时说明缺口。历史对话只用于理解用户要求，不作为本轮事实证据。",
            Some(ResearchPolicy::Open) => "资料策略：开放研究。以用户问题为主，可按本轮联网授权研究公开来源。所选本地材料作为背景与约束，仍只读取明确授权范围，不扩大到其他库。区分本地原文、外部来源和推断。",
            None => "",
        }
    }
}
fn disabled(v: &bool) -> bool {
    !*v
}
pub(super) fn load_on(c: &Connection, id: &str) -> Result<Options, String> {
    let raw: Option<String> = c.query_row("SELECT body_json FROM agent_records WHERE work_id=?1 AND kind='assistantOptions' ORDER BY rowid DESC LIMIT 1", [id], |r| r.get(0)).optional().map_err(|e|e.to_string())?;
    raw.map(|raw| serde_json::from_str(&raw).map_err(|_| "对话选项记录损坏".into()))
        .unwrap_or_else(|| Ok(Options::default()))
}
pub(super) fn load(root: &Path, id: &str) -> Result<Options, String> {
    load_on(&crate::source_evidence::open_read_database(root)?, id)
}
pub(super) fn configure(root: &Path, args: &Value) -> Result<Value, String> {
    let id = text(args, "id", 150)?;
    let options: Options =
        serde_json::from_value(args["options"].clone()).map_err(|_| "对话选项无效")?;
    if let Some(model) = &options.model {
        crate::model_runtime::check_settings(model)?;
    }
    crate::model_runtime::mcp_services::validate(&options.mcp_services)?;
    if !options.mcp_services.is_empty()
        && !crate::model_runtime::native_agent_provider(
            &crate::model_runtime::selected_settings(root, options.model.clone())?.provider,
        )
    {
        return Err("外部 MCP 服务仅支持 Codex；未更换所选提供方".into());
    }
    if options.external_mcp
        && !crate::model_runtime::native_agent_provider(
            &crate::model_runtime::selected_settings(root, options.model.clone())?.provider,
        )
    {
        return Err("本轮MCP通道仅支持Codex，不自动更换已选提供方".into());
    }
    if !options.effective_web_search().disabled()
        && !crate::model_runtime::native_agent_provider(
            &crate::model_runtime::selected_settings(root, options.model.clone())?.provider,
        )
    {
        return Err("联网搜索仅支持 Codex；未更换所选提供方".into());
    }
    let map = active().lock().map_err(|_| "对话运行状态不可用")?;
    if map.contains_key(&(root_key(root), id.clone())) {
        return Err("请等待本轮结束再修改选项".into());
    }
    store::write(root, |c| {
        let w = store::load(c, &id)?;
        if w.state == "revoked" || w.active_run.is_some() {
            return Err("当前对话不可修改选项".into());
        }
        if options.auto_flashcard_inbox && !matches!(w.anchor, Some(EvidenceLocator::Note { .. })) {
            return Err("自动导入只适用于当前笔记的闪卡收件箱草稿".into());
        }
        // Switching a mode is itself a visible user grant. It cannot be inferred
        // from natural language, a model result or a remembered preference.
        if options.auto_flashcard_inbox && args["confirmedAutoInbox"] != true {
            return Err("自动导入需要明确确认本次对话的授权".into());
        }
        store::insert(c, &id, None, "assistantOptions", &json!(options))
    })?;
    drop(map);
    status(root, &id)
}
// Freeze the effective selection before mutating the Work or entering the model queue.
pub(super) fn preflight(
    root: &Path,
    id: &str,
    prepare_drafts: bool,
) -> Result<crate::model_runtime::Settings, String> {
    let c = crate::source_evidence::open_read_database(root)?;
    let w = store::load(&c, id)?;
    let settings = crate::model_runtime::selected_settings(root, load_on(&c, id)?.model)?;
    let services = load_on(&c, id)?.mcp_services;
    crate::model_runtime::mcp_services::validate(&services)?;
    if !services.is_empty()
        && (!prepare_drafts || !crate::model_runtime::native_agent_provider(&settings.provider))
    {
        return Err("当前入口或提供方不支持外部 MCP 服务；未创建运行或预留额度".into());
    }
    if load_on(&c, id)?.external_mcp
        && (!prepare_drafts || !crate::model_runtime::native_agent_provider(&settings.provider))
    {
        return Err("当前入口或提供方不支持本轮MCP通道；未创建运行或预留额度".into());
    }
    if !load_on(&c, id)?.effective_web_search().disabled()
        && (!prepare_drafts || !crate::model_runtime::native_agent_provider(&settings.provider))
    {
        return Err("此入口或提供方不支持对话的联网设置；未创建运行或预留额度".into());
    }
    topics::preflight(root, &c, &w, &settings.provider, prepare_drafts)?;
    if (store::provider_budget::configured_on(&c, &w)?
        || store::material_budget::load_on(&c, id)?.is_some())
        && (!prepare_drafts
            || (!crate::model_runtime::native_agent_provider(&settings.provider)
                && !(settings.provider == "deepseek"
                    && store::provider_budget::direct::enabled_on(&c, &w)?
                    && store::material_budget::load_on(&c, id)?.is_none())))
    {
        return Err("当前模型或运行入口不支持本事项冻结的 Token/材料预算；请用 Codex 助手继续。未创建新运行、未预留额度、未启动模型，已有成果和用量保留。".into());
    }
    Ok(settings)
}
pub(super) fn operation(
    root: &Path,
    w: &Work,
    workflow: &str,
    label: &str,
    control: Control,
) -> Result<Operation, String> {
    operation_with_selection(root, w, workflow, label, control, load(root, &w.id)?.model)
}
pub(super) fn operation_with_selection(
    root: &Path,
    w: &Work,
    workflow: &str,
    label: &str,
    control: Control,
    selection: Option<crate::model_runtime::Settings>,
) -> Result<Operation, String> {
    let c = crate::source_evidence::open_read_database(root)?;
    if workflow == "agent-investigation" {
        if store::material_budget::load_on(&c, &w.id)?.is_some() {
            store::provider_budget::check_pending_admission_on(&c, w)?;
        } else {
            store::provider_budget::check_active_reservation_on(&c, w)?;
        }
    } else {
        check_model_admission_on(&c, w)?;
    }
    drop(c);
    Operation::start_selected(root, workflow, label, control, selection)
}

pub(super) fn check_model_admission_on(c: &Connection, w: &Work) -> Result<(), String> {
    if store::provider_budget::configured_on(c, w)? {
        return Err("为遵守本事项的分析额度，暂不能单独生成新草稿；未启动模型。旧草稿、报告保存和结果核对仍按原授权处理".into());
    }
    Ok(())
}

#[cfg(test)]
mod transport_tests {
    use super::*;
    #[test]
    fn old_options_keep_their_serialized_identity_and_mcp_requires_explicit_selection() {
        let old = json!({"model":null,"autoFlashcardInbox":false});
        let mut v: Options = serde_json::from_value(old.clone()).unwrap();
        assert!(!v.external_mcp);
        assert_eq!(json!(v), old);
        v.external_mcp = true;
        assert_eq!(json!(v)["externalMcp"], true);
    }
}

#[cfg(test)]
#[test]
fn cn04_options_preserve_old_identity_and_reject_unknown_modes() {
    let old = json!({"model":null,"autoFlashcardInbox":false});
    let parsed: Options = serde_json::from_value(old.clone()).unwrap();
    assert!(parsed.web_search.disabled());
    assert_eq!(json!(parsed), old);
    for mode in ["cached", "live"] {
        let mut v = old.clone();
        v["webSearch"] = json!(mode);
        assert_eq!(
            json!(serde_json::from_value::<Options>(v.clone()).unwrap()),
            v
        );
    }
    let mut invalid = old;
    invalid["webSearch"] = json!("unrestricted");
    assert!(serde_json::from_value::<Options>(invalid).is_err());
}

#[cfg(test)]
#[test]
fn research_policy_is_versioned_and_materials_only_masks_external_access_without_erasing_preferences(
) {
    let legacy = json!({"model":null,"autoFlashcardInbox":false});
    assert_eq!(
        json!(serde_json::from_value::<Options>(legacy.clone()).unwrap()),
        legacy
    );
    for policy in ["material-first", "materials-only", "open"] {
        let wire = json!({"model":null,"autoFlashcardInbox":false,"webSearch":"live","researchPolicy":policy});
        let options: Options = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(json!(options), wire);
        assert_eq!(
            options.effective_web_search().disabled(),
            policy == "materials-only"
        );
        assert!(!options.web_search.disabled());
        assert!(!options.research_guide().is_empty());
    }
    assert!(
        serde_json::from_value::<Options>(json!({"model":null,"researchPolicy":"guess"})).is_err()
    );
}
