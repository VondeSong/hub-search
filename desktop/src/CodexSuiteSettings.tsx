import { useEffect, useId, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { RefreshCw } from "lucide-react";
import { CODEX_EFFORT_LABELS, loadCodexSuiteModels, modelProviderLabel, publishCodexNotice, saveCodexSuite, useCodexSuite, type CodexModel, type CodexSettings, type ModelProvider } from "./CodexSuite";
import "./CodexSuiteSettings.css";
import { CodexAccountsSettings } from "./CodexAccountsSettings";

export function CodexSuiteSettings() {
  const suite = useCodexSuite();
  const modelSelectId = useId();
  const [draft, setDraft] = useState<CodexSettings>(suite.settings);
  const [dirty, setDirty] = useState(false);
  const [models, setModels] = useState<CodexModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [configured, setConfigured] = useState(false);
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [credentialRevision, setCredentialRevision] = useState(0);
  const provider = (dirty ? draft : suite.settings).provider ?? "codex";
  useEffect(() => { if (!dirty && suite.loaded) setDraft(suite.settings); }, [suite.settings, suite.loaded, dirty]);
  useEffect(() => {
    if (!suite.loaded) return;
    let alive = true; setLoading(true); setCatalogLoaded(false); setModels([]); setCatalogError("");
    void loadCodexSuiteModels(provider, credentialRevision > 0).then(value => { if (alive) { setModels(value); setCatalogLoaded(true); } }).catch(reason => { if (alive) setCatalogError(String(reason)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [provider, suite.loaded, credentialRevision]);
  useEffect(() => {
    if (provider !== "deepseek") return;
    let alive = true;
    void invoke<{ deepseekConfigured: boolean }>("model_runtime", { args: { action: "credentialStatus" } }).then(value => { if (alive) setConfigured(value.deepseekConfigured); }).catch(reason => { if (alive) setCatalogError(String(reason)); });
    return () => { alive = false; };
  }, [provider, credentialRevision]);
  const refresh = () => setCredentialRevision(value => value + 1);
  const change = (value: Partial<CodexSettings>) => { setDirty(true); setDraft(old => ({ ...old, ...value })); };
  const changeProvider = (next: ModelProvider) => {
    setApiKey(""); setConfigured(false);
    change({ provider: next, model: next === "deepseek" ? "deepseek-flash" : "", reasoningEffort: next === "deepseek" ? "none" : "", fast: false });
  };
  const selected = models.find(model => model.id === draft.model);
  const levels = selected?.reasoningLevels ?? [];
  const valid = provider === "codex" && !draft.model ? !draft.reasoningEffort && !draft.fast : !!selected && (!draft.reasoningEffort || levels.includes(draft.reasoningEffort)) && (!draft.fast || !!selected.fastDescription);
  const save = async () => {
    if (!valid || !suite.loaded || saving) return;
    setSaving(true);
    try { await saveCodexSuite(draft); setDirty(false); publishCodexNotice("模型设置已保存，后续请求使用新设置", "success"); }
    catch (reason) { publishCodexNotice(`保存模型设置失败：${String(reason)}`, "error", 6000); }
    finally { setSaving(false); }
  };
  const saveCredential = async (fromFile: boolean) => {
    if (credentialBusy) return;
    setCredentialBusy(true);
    try {
      let args: object;
      if (fromFile) {
        const path = await open({ title: "选择 DeepSeek 密钥文件", multiple: false, filters: [{ name: "文本文件", extensions: ["txt"] }] });
        if (!path) return;
        args = { action: "importCredential", path };
      } else args = { action: "setCredential", apiKey };
      await invoke("model_runtime", { args });
      setConfigured(true); setApiKey(""); refresh();
      publishCodexNotice("DeepSeek 密钥已保存到系统凭据库", "success");
    } catch (reason) { publishCodexNotice(String(reason), "error", 6000); }
    finally { setCredentialBusy(false); }
  };
  return <section className="settings-category codex codex-suite-settings" aria-label="模型运行设置">
    <h3>模型与运行</h3>
    <p>调查、标签、归档、闪卡和任务转换共用 Hub 的排队、预算、取消与记忆上下文。</p>
    {provider === "codex" && <CodexAccountsSettings />}
    <div className="codex-suite-fields">
      <label>模型入口<select aria-label="模型入口" disabled={!suite.loaded || saving} value={provider} onChange={event => changeProvider(event.target.value as ModelProvider)}><option value="deepseek">DeepSeek · 直接 API</option><option value="codex">Codex · 外部 CLI</option></select></label>
      {provider === "deepseek" && <div className="model-provider-credential">
        <label>API 密钥<input aria-label="DeepSeek API 密钥" type="password" autoComplete="new-password" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={configured ? "已保存，输入新密钥可替换" : "输入 DeepSeek API 密钥"} disabled={credentialBusy} /></label>
        <div className="model-provider-credential-actions"><button type="button" className="maintenance-button" disabled={credentialBusy || !apiKey.trim()} onClick={() => void saveCredential(false)}>保存密钥</button><button type="button" className="maintenance-button" disabled={credentialBusy} onClick={() => void saveCredential(true)}>从文件导入</button></div>
        <small>{configured ? "密钥已保存到系统凭据库。" : "需要自己的 DeepSeek API 密钥。"}材料会发送给 DeepSeek，按提供方实际用量计费。</small>
      </div>}
      <div className="codex-suite-model-field"><label htmlFor={modelSelectId}>模型</label><div className="codex-suite-model-row">
        <select id={modelSelectId} aria-label="模型" disabled={!suite.loaded || loading || saving} value={draft.model} onChange={event => change({ model: event.target.value, reasoningEffort: "", fast: false })}>{provider === "codex" && <option value="">CLI 默认模型</option>}{draft.model && !selected && <option value={draft.model}>{draft.model}（当前不可用）</option>}{models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select>
        <button type="button" className="maintenance-button codex-suite-refresh" aria-label="刷新模型" title="刷新模型" disabled={loading || saving} onClick={refresh}><RefreshCw size={14} className={loading ? "spin" : ""} /><span>{loading ? "正在读取模型…" : "刷新模型"}</span></button>
      </div></div>
      <label>推理强度<select aria-label="推理强度" disabled={!selected || !levels.length || saving} value={draft.reasoningEffort} onChange={event => change({ reasoningEffort: event.target.value })}><option value="">默认{selected?.defaultReasoning ? `（${CODEX_EFFORT_LABELS[selected.defaultReasoning] ?? selected.defaultReasoning}）` : ""}</option>{levels.map(level => <option key={level} value={level}>{CODEX_EFFORT_LABELS[level] ?? level}</option>)}</select></label>
      {provider === "codex" && <label>速度<select aria-label="速度" disabled={!selected?.fastDescription || saving} value={draft.fast ? "fast" : "standard"} onChange={event => change({ fast: event.target.value === "fast" })}><option value="standard">标准速度</option>{selected?.fastDescription && <option value="fast">Fast</option>}</select><small>{selected?.fastDescription ? selected.fastDescription.replace(/([\d.]+)x speed, increased usage/i, "$1 倍速，用量更多") : "Fast 由所选模型的实际能力决定"}</small></label>}
      <label>同时运行<select aria-label="同时运行数量" disabled={saving} value={draft.maxConcurrent} onChange={event => change({ maxConcurrent: Number(event.target.value) })}>{[1, 2, 3, 4].map(count => <option key={count} value={count}>{count} 个请求</option>)}</select><small>所有入口共用上限；排队请求保留提交时的提供方、模型与参数。</small></label>
    </div>
    {catalogError && <p role="alert" className="codex-suite-validation">{catalogError}</p>}
    {catalogLoaded && !valid && <p role="alert" className="codex-suite-validation">所选模型或参数当前不可用，请调整后保存。</p>}
    <p>{provider === "deepseek" ? "Hub 直接连接 DeepSeek API。" : "Codex 使用本机已有的外部 CLI 和登录状态，登录由 Codex 管理。"}生成完成后，仍按各功能的审核和写入规则处理。</p>
    <button type="button" className="maintenance-button" disabled={!dirty || !suite.loaded || !valid || loading || saving} onClick={() => void save()}>{saving ? "正在保存…" : `保存模型设置`}</button>
    <small>当前生效：{modelProviderLabel(suite.settings.provider)} · {suite.settings.model || "CLI 默认模型"}</small>
  </section>;
}
