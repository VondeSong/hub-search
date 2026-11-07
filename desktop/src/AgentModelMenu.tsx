import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowLeft, Check, ChevronDown, ChevronRight, RefreshCw, RotateCcw, Zap } from "lucide-react";
import { cachedCodexSuiteModels, loadCodexSuiteModels, useCodexSuite, CODEX_EFFORT_LABELS, type CodexModel, type ModelProvider } from "./CodexSuite";
import { useAgentPopover } from "./useAgentPopover";
import type { AssistantOptions } from "./AgentAssistantOptions";

export function AgentModelMenu({value,disabled,onSave}:{value:AssistantOptions;disabled:boolean;onSave:(value:AssistantOptions)=>Promise<void>}) {
  const runtime=useCodexSuite();
  const effective=value.model ?? (runtime.loaded ? runtime.settings : null);
  const activeProvider=effective?.provider ?? "codex";
  const [provider,setProvider]=useState<ModelProvider>(activeProvider);
  const [models,setModels]=useState<CodexModel[]>(()=>cachedCodexSuiteModels(activeProvider) || []);
  const [loading,setLoading]=useState(false), [saving,setSaving]=useState(false), [error,setError]=useState("");
  const [providersOpen,setProvidersOpen]=useState(false), [effort,setEffort]=useState("");
  const alive=useRef(true), request=useRef(0), savingRef=useRef(false);
  const menu=useAgentPopover();
  const [page,setPage]=useState<"model"|"effort">("effort");
  useEffect(()=>{if(menu.ref.current?.open)menu.ref.current.querySelector<HTMLButtonElement>(".agent-assistant-settings button")?.focus();},[page]);
  useEffect(()=>{alive.current=true;return ()=>{alive.current=false;request.current++;};},[]);
  useEffect(()=>{if(runtime.loaded || value.model)void load(activeProvider);},[activeProvider,runtime.loaded]);
  async function load(next:ModelProvider, refresh=false) {
    const ticket=++request.current, cached=cachedCodexSuiteModels(next);
    setProvider(next);setModels(cached || []);setLoading(true);setError("");
    try {const items=await loadCodexSuiteModels(next,refresh);if(alive.current && ticket===request.current)setModels(items);}
    catch(reason){if(alive.current && ticket===request.current)setError(`${cached?.length?"刷新失败，保留上次模型列表。":""}${String(reason)}`);}
    finally{if(alive.current && ticket===request.current)setLoading(false);}
  }
  async function save(next:AssistantOptions, close=true) {
    if(disabled || savingRef.current)return;
    savingRef.current=true;setSaving(true);setError("");
    try {await onSave(next);if(alive.current && close)menu.close(true);}
    catch(reason){if(alive.current){setEffort(currentEffort);setError(String(reason));}}
    finally{savingRef.current=false;if(alive.current)setSaving(false);}
  }
  const activeModels=provider===activeProvider ? models : cachedCodexSuiteModels(activeProvider) || [];
  const selected=activeModels.find(model=>model.id===effective?.model);
  const modelName=selected?.name || effective?.model || "选择模型";
  const levels=selected?.reasoningLevels || [];
  const currentEffort=effective?.reasoningEffort || "";
  const effortIndex=levels.indexOf(effort || selected?.defaultReasoning || "");
  const effortLabel=CODEX_EFFORT_LABELS[effort] || effort || "默认";
  const changeEffort=(level:string)=>{if(effective && (level==="" || levels.includes(level)))void save({...value,model:{...effective,reasoningEffort:level}},false);};
  const selectedChoice=(model:CodexModel)=>!!value.model && effective?.model===model.id && activeProvider===provider;
  return <>
    <details ref={menu.ref} className="agent-assistant-options agent-popover agent-option-model" name="hub-agent-preference" onToggle={event=>{
      if(event.target===event.currentTarget && event.currentTarget.open){setProvidersOpen(false);setEffort(currentEffort);if(provider!==activeProvider || !error)void load(activeProvider);}
    }}>
      <summary aria-label={`选择模型：${modelName}`} title={modelName}><span className="agent-model-closed-label">{modelName} · {CODEX_EFFORT_LABELS[currentEffort] || currentEffort || "默认"}</span><span className="agent-model-open-label">{page==="effort" && levels.length>1?"选择推理强度":"选择模型"}</span><ChevronDown size={14} aria-hidden="true"/></summary>
      {(page==="model" || levels.length<2) && <div className="agent-assistant-settings agent-model-menu" aria-label="选择模型">
        {levels.length>1 && <button type="button" className="agent-menu-back" onClick={()=>setPage("effort")}><ArrowLeft size={15}/>返回推理设置</button>}
        {providersOpen ? <>
          <button type="button" className="agent-menu-back" onClick={()=>setProvidersOpen(false)}><ArrowLeft size={15} aria-hidden="true"/>返回模型列表</button>
          {(["codex","deepseek"] as const).map(item=><button type="button" className="agent-menu-choice" key={item} disabled={saving} onClick={()=>{setProvidersOpen(false);void load(item);}}><span>{item==="codex"?"Codex":"DeepSeek"}</span>{provider===item && <Check size={16} aria-hidden="true"/>}</button>)}
        </> : <>
          <button type="button" className="agent-menu-choice" disabled={disabled||saving} aria-pressed={!value.model} onClick={()=>void save({...value,model:null})}><span><strong>默认</strong><small>{runtime.settings?.model || "使用全局模型设置"}</small></span>{!value.model && <Check size={16} aria-hidden="true"/>}</button>
          <div className="agent-model-list">
            <span className="agent-model-heading">可用模型</span>
            {models.map(model=><button type="button" className="agent-menu-choice" key={model.id} title={model.id} disabled={disabled||saving} aria-pressed={selectedChoice(model)} onClick={()=>void save({...value,model:{provider,model:model.id,reasoningEffort:model.defaultReasoning || "",fast:false,maxConcurrent:effective?.maxConcurrent || 2}})}><span>{model.name}</span>{selectedChoice(model) && <Check size={16} aria-hidden="true"/>}</button>)}
            {loading && !models.length && <div className="agent-model-skeleton" role="status"><span className="agent-visually-hidden">正在读取可用模型</span><i/><i/><i/></div>}
            {!loading && !models.length && !error && <p className="agent-note">没有可用模型，请刷新或检查提供方设置。</p>}
          </div>
          {provider==="deepseek" && <p className="agent-note">DeepSeek 暂仅支持文字分析；制作草稿请选 Codex。</p>}
          <div className="agent-model-footer"><button type="button" className="agent-menu-refresh" disabled={saving} onClick={()=>setProvidersOpen(true)}>{provider==="codex"?"Codex":"DeepSeek"}<ChevronRight size={14} aria-hidden="true"/></button><button type="button" className="agent-menu-refresh" aria-label="刷新可用模型" title="刷新可用模型" disabled={loading||saving} onClick={()=>void load(provider,true)}><RefreshCw size={15} className={loading?"spin":""} aria-hidden="true"/></button></div>
        </>}
        {error && <p role="alert">{error}</p>}
      </div>}
    {levels.length>1 && page==="effort" && <section aria-label="模型与推理设置">
      <div className="agent-assistant-settings agent-effort-menu" aria-label="调整推理强度">
        <div className="agent-effort-heading"><button type="button" className="agent-effort-fast" aria-label="快速模式" title="快速模式" aria-pressed={!!effective?.fast} disabled={disabled||saving||!effective} onClick={()=>{if(effective)void save({...value,model:{...effective,fast:!effective.fast}},false);}}><Zap size={20} aria-hidden="true"/></button><strong aria-live="polite">{effortLabel}</strong><button type="button" aria-label="恢复模型默认推理强度" title="恢复模型默认推理强度" disabled={disabled||saving} onClick={()=>{setEffort("");changeEffort("");}}><RotateCcw size={20} aria-hidden="true"/></button></div>
        <button type="button" className="agent-menu-choice" onClick={()=>setPage("model")}>{modelName}<ChevronRight size={14}/></button>
        {effortIndex>=0 && levels.length>1 ? <div className="agent-effort-slider" style={{"--effort-progress":`${effortIndex/(levels.length-1)*100}%`} as CSSProperties}>
          <input type="range" aria-label="推理强度" aria-valuetext={effortLabel} min={0} max={levels.length-1} step={1} value={effortIndex} disabled={disabled||saving} onChange={event=>setEffort(levels[Number(event.target.value)])} onPointerUp={event=>changeEffort(levels[Number(event.currentTarget.value)])} onKeyUp={event=>{if(["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home","End","PageUp","PageDown"].includes(event.key))changeEffort(levels[Number(event.currentTarget.value)]);}}/>
          <div className="agent-effort-ticks" aria-hidden="true">{levels.map(level=><span key={level} className={levels.indexOf(level)<=effortIndex?"selected":""}/>)}</div>
        </div> : <div className="agent-effort-levels">{levels.map(level=><button type="button" key={level} disabled={disabled||saving} aria-pressed={level===effort} onClick={()=>{setEffort(level);changeEffort(level);}}>{CODEX_EFFORT_LABELS[level] || level}</button>)}</div>}
        {error && <p role="alert">{error}</p>}
      </div>
    </section>}
    </details>
  </>;
}
