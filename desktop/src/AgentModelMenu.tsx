import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Check, ChevronDown, RefreshCw, RotateCcw, X, Zap } from "lucide-react";
import { cachedCodexSuiteModels, loadCodexSuiteModels, useCodexSuite, CODEX_EFFORT_LABELS, type CodexModel, type ModelProvider } from "./CodexSuite";
import { loadAgentModelPreference, rememberAgentModelPreference } from "./AgentPreferences";
import { useAgentPopover } from "./useAgentPopover";
import type { AssistantOptions } from "./AgentAssistantOptions";
import "./AgentModelMenu.css";

const sliderKeys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"];
const effortName = (effort: string) => CODEX_EFFORT_LABELS[effort] || effort || "默认";
const supportsFast = (provider: ModelProvider, model?: CodexModel) => provider === "codex" && !!model?.fastDescription?.trim();

export function AgentModelMenu({ value, disabled, onSave }: {
  value: AssistantOptions;
  disabled: boolean;
  onSave: (value: AssistantOptions) => Promise<void>;
}) {
  const runtime = useCodexSuite();
  const effective = value.model ?? (runtime.loaded ? runtime.settings : null);
  const activeProvider = effective?.provider ?? "codex";
  const hasOverride = !!value.model;
  const [provider, setProvider] = useState<ModelProvider>(activeProvider);
  const [models, setModels] = useState<CodexModel[]>(() => cachedCodexSuiteModels(activeProvider) || []);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [effort, setEffort] = useState(effective?.reasoningEffort || "");
  const alive = useRef(true), request = useRef(0), savingRef = useRef(false);
  const sliderInteraction = useRef<"pointer" | "keyboard" | null>(null);
  const modelMenu = useAgentPopover(), effortMenu = useAgentPopover();

  useEffect(() => { alive.current = true; return () => { alive.current = false; request.current++; }; }, []);
  useEffect(() => { if (runtime.loaded || hasOverride) void load(activeProvider); }, [activeProvider, runtime.loaded, hasOverride]);
  useEffect(() => { setEffort(effective?.reasoningEffort || ""); }, [activeProvider, effective?.model, effective?.reasoningEffort]);

  async function load(next: ModelProvider, refresh = false) {
    const ticket = ++request.current;
    const cached = cachedCodexSuiteModels(next);
    setProvider(next); setModels(cached || []); setLoading(true); setError("");
    try {
      const items = await loadCodexSuiteModels(next, refresh);
      if (alive.current && ticket === request.current) setModels(items);
    } catch (reason) {
      if (alive.current && ticket === request.current) setError(`${cached?.length ? "刷新失败，保留上次模型列表。" : ""}${String(reason)}`);
    } finally {
      if (alive.current && ticket === request.current) setLoading(false);
    }
  }

  async function save(next: AssistantOptions, close = false) {
    if (disabled || savingRef.current) return;
    const previous = effective;
    savingRef.current = true; setSaving(true); setError("");
    try {
      await onSave(next);
      // Preferences are updated only after the actual conversation accepts the change.
      rememberAgentModelPreference(previous);
      rememberAgentModelPreference(next.model);
      if (alive.current && close) modelMenu.close(true);
    } catch (reason) {
      if (alive.current) { setEffort(currentEffort); setError(String(reason)); }
    } finally {
      savingRef.current = false;
      if (alive.current) setSaving(false);
    }
  }

  const activeModels = provider === activeProvider ? models : cachedCodexSuiteModels(activeProvider) || [];
  const selected = activeModels.find(model => model.id === effective?.model);
  const modelName = selected?.name || effective?.model || "选择模型";
  const levels = [...new Set(selected?.reasoningLevels || [])];
  const currentEffort = effective?.reasoningEffort || "";
  const defaultEffort = selected?.defaultReasoning || "";
  const effortIndex = levels.indexOf(effort || defaultEffort);
  const currentIndex = levels.indexOf(currentEffort || defaultEffort);
  const fastAvailable = supportsFast(activeProvider, selected);
  const fastActive = activeProvider === "codex" && !!effective?.fast;
  const canConfigure = levels.length > 1 || fastAvailable;
  const resolvedEffort = currentEffort || defaultEffort;
  const barCount = resolvedEffort === "none" || currentIndex < 0 ? 0 : Math.max(1, Math.round((currentIndex + 1) / levels.length * 5));
  const blocked = disabled || saving;

  function changeEffort(level: string) {
    if (effective && (level === "" || levels.includes(level))) {
      void save({ ...value, model: { ...effective, reasoningEffort: level, fast: fastAvailable && effective.fast } });
    }
  }

  function chooseModel(model: CodexModel) {
    const previous = effective?.model === model.id && activeProvider === provider ? effective : loadAgentModelPreference(provider, model.id);
    const supportedLevels = model.reasoningLevels || [];
    const fallback = model.defaultReasoning && supportedLevels.includes(model.defaultReasoning) ? model.defaultReasoning : "";
    const reasoningEffort = previous && (previous.reasoningEffort === "" || supportedLevels.includes(previous.reasoningEffort)) ? previous.reasoningEffort : fallback;
    void save({ ...value, model: {
      provider, model: model.id, reasoningEffort,
      fast: supportsFast(provider, model) && !!previous?.fast,
      maxConcurrent: effective?.maxConcurrent || 2,
    } }, true);
  }

  return <div className="agent-model-controls" role="group" aria-label="模型设置">
    <details ref={effortMenu.ref} hidden={!canConfigure} className="agent-assistant-options agent-popover agent-option-effort" name="hub-agent-preference" onToggle={event => {
      if (event.target === event.currentTarget && event.currentTarget.open) {
        modelMenu.close(); setEffort(currentEffort); sliderInteraction.current = null;
        if (provider !== activeProvider || !error) void load(activeProvider);
      }
    }}>
      <summary aria-label={levels.length > 1 ? `调整推理强度：${effortName(currentEffort)}` : `调整响应速度：${fastActive ? "Fast" : "标准"}`} title={levels.length > 1 ? `推理强度：${effortName(currentEffort)}` : "响应速度"}>
        {levels.length > 1 ? <span className="agent-reasoning-bars" aria-hidden="true">{[0, 1, 2, 3, 4].map(index => <i key={index} data-active={index < barCount || undefined} style={{ height: `${6 + index * 3}px` }} />)}</span> : <Zap size={18} aria-hidden="true" />}
      </summary>
      <div className="agent-assistant-settings agent-effort-menu" aria-label={levels.length > 1 ? "调整推理强度" : "调整响应速度"}>
        <div className="agent-popover-header"><span>{levels.length > 1 ? "推理强度" : "响应速度"}</span><button type="button" aria-label="关闭推理与速度设置" onClick={() => effortMenu.close(true)}><X size={16} aria-hidden="true" /></button></div>
        {levels.length > 1 && <>
          <div className="agent-effort-heading"><strong aria-live="polite">{effortName(effort)}</strong><button type="button" aria-label="恢复模型默认推理强度" title="恢复模型默认推理强度" disabled={blocked} onClick={() => { setEffort(""); changeEffort(""); }}><RotateCcw size={17} aria-hidden="true" /></button></div>
          <p className="agent-effort-model">{modelName}</p>
          {effortIndex >= 0 ? <div className="agent-effort-slider" style={{ "--effort-progress": `${effortIndex / (levels.length - 1) * 100}%` } as CSSProperties}>
            <input type="range" aria-label="推理强度" aria-valuetext={effortName(effort)} min={0} max={levels.length - 1} step={1} value={effortIndex} disabled={blocked}
              onPointerDown={event => { sliderInteraction.current = "pointer"; event.currentTarget.setPointerCapture?.(event.pointerId); }}
              onKeyDown={event => { if (sliderKeys.includes(event.key)) sliderInteraction.current = "keyboard"; }}
              onChange={event => {
                const level = levels[Number(event.currentTarget.value)];
                setEffort(level);
                // Assistive technologies can change a range without pointer or keyboard events.
                if (!sliderInteraction.current) changeEffort(level);
              }}
              onPointerUp={event => { if (sliderInteraction.current === "pointer") { sliderInteraction.current = null; changeEffort(levels[Number(event.currentTarget.value)]); } }}
              onPointerCancel={() => { sliderInteraction.current = null; setEffort(currentEffort); }}
              onKeyUp={event => { if (sliderKeys.includes(event.key) && sliderInteraction.current === "keyboard") { sliderInteraction.current = null; changeEffort(levels[Number(event.currentTarget.value)]); } }}
            />
            <div className="agent-effort-ticks" aria-hidden="true">{levels.map((level, index) => <span key={level} className={index <= effortIndex ? "selected" : ""} />)}</div>
          </div> : <div className="agent-effort-levels">{levels.map(level => <button type="button" key={level} disabled={blocked} aria-pressed={level === effort} onClick={() => { setEffort(level); changeEffort(level); }}>{effortName(level)}</button>)}</div>}
          <div className="agent-effort-scale" aria-hidden="true"><span>{effortName(levels[0])}</span><span>{effortName(levels[levels.length - 1])}</span></div>
          {!effort && defaultEffort && <p className="agent-effort-default">跟随模型默认：{effortName(defaultEffort)}</p>}
        </>}
        {fastAvailable && <section className="agent-speed-setting" aria-label="响应速度">
          <button type="button" className="agent-speed-toggle" aria-label="快速模式" aria-pressed={fastActive} disabled={blocked || !effective} onClick={() => { if (effective) void save({ ...value, model: { ...effective, fast: !effective.fast } }); }}><span><Zap size={16} aria-hidden="true" />快速模式</span><span className="agent-speed-state">{fastActive ? "Fast · 已开启" : "标准"}</span></button>
          {selected?.fastDescription && <p>{selected.fastDescription}</p>}
        </section>}
        {error && <p role="alert">{error}</p>}
      </div>
    </details>

    <details ref={modelMenu.ref} className="agent-assistant-options agent-popover agent-option-model" name="hub-agent-preference" onToggle={event => {
      if (event.target === event.currentTarget && event.currentTarget.open) {
        effortMenu.close();
        if (provider !== activeProvider || !error) void load(activeProvider);
      }
    }}>
      <summary aria-label={`选择模型：${modelName}${fastActive ? "，Fast 已开启" : ""}`} title={`${modelName} · ${effortName(currentEffort)}${value.model ? "" : " · 跟随全局设置"}`}>
        {fastActive && <Zap size={13} className="agent-model-fast-active" aria-hidden="true" />}
        <span className="agent-model-name">{modelName}</span><ChevronDown size={13} aria-hidden="true" />
      </summary>
      <div className="agent-assistant-settings agent-model-menu" aria-label="选择模型">
        <div className="agent-popover-header"><strong>模型</strong><button type="button" aria-label="关闭模型选择" onClick={() => modelMenu.close(true)}><X size={16} aria-hidden="true" /></button></div>
        <div className="agent-model-providers" role="group" aria-label="模型提供方">{(["codex", "deepseek"] as const).map(item => <button type="button" key={item} aria-pressed={provider === item} disabled={saving} onClick={() => void load(item)}>{item === "codex" ? "Codex" : "DeepSeek"}</button>)}</div>
        <button type="button" className="agent-menu-choice agent-model-default" disabled={blocked} aria-pressed={!value.model} onClick={() => void save({ ...value, model: null }, true)}><span><strong>默认</strong><small>{runtime.settings?.model || "使用全局模型设置"}</small></span>{!value.model && <Check size={16} aria-hidden="true" />}</button>
        <div className="agent-model-list">
          <span className="agent-model-heading">可用模型</span>
          {models.map(model => <button type="button" className="agent-menu-choice" key={model.id} title={model.id} disabled={blocked} aria-pressed={!!value.model && effective?.model === model.id && activeProvider === provider} onClick={() => chooseModel(model)}><span>{model.name}</span>{!!value.model && effective?.model === model.id && activeProvider === provider && <Check size={16} aria-hidden="true" />}</button>)}
          {loading && !models.length && <div className="agent-model-skeleton" role="status"><span className="agent-visually-hidden">正在读取可用模型</span><i /><i /><i /></div>}
          {!loading && !models.length && !error && <p className="agent-note">没有可用模型，请刷新或检查提供方设置。</p>}
        </div>
        {provider === "deepseek" && <p className="agent-note">DeepSeek 暂仅支持文字分析；制作草稿请选 Codex。</p>}
        <div className="agent-model-footer"><span>{value.model ? "仅用于本对话" : "跟随全局设置"}</span><button type="button" className="agent-menu-refresh" aria-label="刷新可用模型" title="刷新可用模型" disabled={loading || saving} onClick={() => void load(provider, true)}><RefreshCw size={15} className={loading ? "spin" : ""} aria-hidden="true" /></button></div>
        {error && <p role="alert">{error}</p>}
      </div>
    </details>
  </div>;
}
