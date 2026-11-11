import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Circle, RefreshCw, RotateCcw, X, Zap } from "lucide-react";
import { cachedCodexSuiteModels, loadCodexSuiteModels, useCodexSuite, CODEX_EFFORT_LABELS, type CodexModel, type ModelProvider } from "./CodexSuite";
import { loadAgentModelPreference, rememberAgentModelPreference } from "./AgentPreferences";
import { useAgentPopover } from "./useAgentPopover";
import type { AssistantOptions } from "./AgentAssistantOptions";
import "./AgentModelMenu.css";

const effortLabels:Record<string,string>={none:"关闭思考",low:"低",medium:"中",xhigh:"极高",ultra:"极限"};
const effortName=(value:string)=>effortLabels[value]||CODEX_EFFORT_LABELS[value]||value||"默认";
const supportsFast=(provider:ModelProvider,model?:CodexModel)=>provider==="codex"&&!!model?.fastDescription?.trim();
const descriptions:Record<string,string>={none:"直接回答，不启用推理模式",low:"较少推理投入，适合简单问题",medium:"适合日常讨论与资料整理",high:"增加推理投入，适合复杂问题",xhigh:"更充分地推理与检查，等待可能更久",max:"使用该模型最高的推理投入",ultra:"使用该模型支持的更高推理投入"};
const modelLabel=(name:string)=>name.replace(/^(GPT-\d+(?:\.\d+)?)-(Sol|Terra|Astra|Luna)$/i,"$1 $2");
const providers:ModelProvider[]=["deepseek","codex"];
export function AgentModelMenu({value,disabled,onSave}:{value:AssistantOptions;disabled:boolean;onSave:(value:AssistantOptions)=>Promise<void>}){
  const runtime=useCodexSuite(),effective=value.model??(runtime.loaded?runtime.settings:null),activeProvider=effective?.provider??"codex";
  const [catalogs,setCatalogs]=useState<Record<ModelProvider,CodexModel[]>>(()=>({codex:cachedCodexSuiteModels("codex")||[],deepseek:cachedCodexSuiteModels("deepseek")||[]}));
  const [loading,setLoading]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState("");
  const alive=useRef(true),request=useRef(0),savingRef=useRef(false),modelMenu=useAgentPopover(),effortMenu=useAgentPopover();
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;request.current++;};},[]);
  async function load(refresh=false){
    const ticket=++request.current;setLoading(true);setError("");
    const results=await Promise.allSettled(providers.map(provider=>loadCodexSuiteModels(provider,refresh)));
    if(!alive.current||ticket!==request.current)return;
    setCatalogs(current=>{const next={...current};results.forEach((result,index)=>{if(result.status==="fulfilled")next[providers[index]]=result.value;});return next;});
    const failures=results.flatMap((result,index)=>result.status==="rejected"?[`${providers[index]==="codex"?"OpenAI":"DeepSeek"}：${String(result.reason)}`]:[]);
    setError(failures.join("；"));setLoading(false);
  }
  useEffect(()=>{if(runtime.loaded||value.model)void load();},[runtime.loaded]);
  const selected=catalogs[activeProvider].find(model=>model.id===effective?.model),modelName=modelLabel(selected?.name||effective?.model||"选择模型");
  const levels=[...new Set(selected?.reasoningLevels||[])],currentEffort=effective?.reasoningEffort||"",resolvedEffort=currentEffort||selected?.defaultReasoning||"";
  const fastAvailable=supportsFast(activeProvider,selected),fastActive=activeProvider==="codex"&&!!effective?.fast,blocked=disabled||saving;
  async function save(next:AssistantOptions,close=false){
    if(disabled||savingRef.current)return;savingRef.current=true;setSaving(true);setError("");
    try{await onSave(next);rememberAgentModelPreference(effective);rememberAgentModelPreference(next.model);if(alive.current&&close){modelMenu.close(true);effortMenu.close(true);}}
    catch(reason){if(alive.current)setError(String(reason));}finally{savingRef.current=false;if(alive.current)setSaving(false);}
  }
  function chooseModel(provider:ModelProvider,model:CodexModel){
    const previous=effective?.model===model.id&&activeProvider===provider?effective:loadAgentModelPreference(provider,model.id),supported=model.reasoningLevels||[];
    const fallback=model.defaultReasoning&&supported.includes(model.defaultReasoning)?model.defaultReasoning:"";
    const reasoningEffort=previous&&(previous.reasoningEffort===""||supported.includes(previous.reasoningEffort))?previous.reasoningEffort:fallback;
    void save({...value,model:{provider,model:model.id,reasoningEffort,fast:supportsFast(provider,model)&&!!previous?.fast,maxConcurrent:effective?.maxConcurrent||2}},false);
  }
  function changeEffort(level:string){if(effective&&(level===""||levels.includes(level)))void save({...value,model:{...effective,reasoningEffort:level,fast:fastAvailable&&effective.fast}},true);}
  const bars=(count:number)=><span className="agent-reasoning-bars" aria-hidden="true">{[0,1,2,3,4].map(index=><i key={index} data-active={index<count||undefined} style={{height:6+index*3}}/>)}</span>;
  return <div className="agent-model-controls" role="group" aria-label="模型设置">

    <details ref={modelMenu.ref} className="agent-assistant-options agent-popover agent-option-model" name="hub-agent-preference" onToggle={event=>{if(event.target===event.currentTarget&&event.currentTarget.open){effortMenu.close();void load();}}}>
      <summary aria-label={`选择模型：${modelName}${fastActive?"，Fast 已开启":""}`} title={`${modelName} · ${effortName(resolvedEffort)}`}>
        {fastActive&&<Zap size={13} className="agent-model-fast-active"/>}<span className="agent-model-name">{modelName}</span>
      </summary>
      <div className="agent-assistant-settings agent-model-menu" aria-label="模型与速度">
        <div className="agent-popover-header"><span>模型与速度</span><button type="button" aria-label="关闭模型选择" onClick={()=>modelMenu.close(true)}><X size={16}/></button></div>
        <div className="agent-model-list">{providers.map(provider=><section key={provider} aria-label={provider==="codex"?"OpenAI 模型":"DeepSeek 模型"}><span className="agent-model-heading">{provider==="codex"?"OpenAI":"DeepSeek"}</span>{catalogs[provider].map(model=><button type="button" className="agent-menu-choice" key={model.id} title={model.id} disabled={blocked} aria-pressed={effective?.model===model.id&&activeProvider===provider} onClick={()=>chooseModel(provider,model)}><img className="agent-provider-icon" src={`/brands/${provider==="codex"?"openai":"deepseek"}.ico`} alt={provider==="codex"?"OpenAI":"DeepSeek"}/><span>{/^DeepSeek[- ]V/i.test(model.name)?<>DeepSeek<small>{model.name.replace(/^DeepSeek[- ]/i,"").replace(/[- ](Flash|Pro)$/i," $1")}</small></>:modelLabel(model.name)}</span>{effective?.model===model.id&&activeProvider===provider&&<Check size={16}/>}</button>)}</section>)}</div>
        {loading&&!catalogs.codex.length&&!catalogs.deepseek.length&&<p role="status">正在读取可用模型…</p>}
        {!loading&&!catalogs.codex.length&&!catalogs.deepseek.length&&!error&&<p className="agent-note">没有可用模型，请刷新或检查提供方设置。</p>}
        {fastAvailable&&<section className="agent-speed-setting" aria-label="响应速度"><strong>响应速度</strong><div className="agent-speed-segments">{[false,true].map(fast=><button type="button" key={String(fast)} disabled={blocked||!effective} aria-label={fast?"快速模式":"标准速度"} aria-pressed={fastActive===fast} onClick={()=>{if(effective)void save({...value,model:{...effective,fast}});}}>{fast?<Zap size={18}/>:<Circle size={18}/>}<span>{fast?"加速":"标准"}</span>{fastActive===fast&&<Check size={16}/>}</button>)}</div><p>加速增加用量消耗，不改变思考强度。</p></section>}
        <div className="agent-model-footer"><span>思考强度：{effortName(resolvedEffort)}</span><span>从下一次发送生效</span><button type="button" className="agent-menu-refresh" aria-label="刷新可用模型" disabled={loading||saving} onClick={()=>void load(true)}><RefreshCw size={15}/></button></div>
        <button type="button" className="agent-menu-choice agent-model-default" disabled={blocked} aria-pressed={!value.model} onClick={()=>void save({...value,model:null},true)}><span>跟随全局模型设置</span>{!value.model&&<Check size={16}/>}</button>
        {error&&<p role="alert">{error}</p>}
      </div>
    </details>
    <details ref={effortMenu.ref} hidden={!levels.length} className="agent-assistant-options agent-popover agent-option-effort" name="hub-agent-preference" onToggle={event=>{if(event.target===event.currentTarget&&event.currentTarget.open)modelMenu.close();}}>
      <summary aria-label={`调整推理强度：${effortName(resolvedEffort)}`} title={`推理深度：${effortName(resolvedEffort)}`}><span>{effortName(resolvedEffort)}</span><ChevronDown size={13}/></summary>
      <div className="agent-assistant-settings agent-effort-menu" aria-label="思考强度">
        <div className="agent-popover-header"><span>思考强度</span><button type="button" aria-label="关闭推理与速度设置" onClick={()=>effortMenu.close(true)}><X size={16}/></button></div>
        <p className="agent-effort-model">{modelName}</p>
        <div className="agent-effort-levels" role="group" aria-label="推理强度">{levels.map((level,index)=><button type="button" className="agent-menu-choice" key={level} disabled={blocked} aria-pressed={level===resolvedEffort} onClick={()=>changeEffort(level)}>{bars(level==="none"?0:Math.max(1,Math.round((index+1)/levels.length*5)))}<span><strong>{effortName(level)}</strong><small>{descriptions[level]||"使用模型提供的推理档位"}</small></span>{level===resolvedEffort&&<Check size={17}/>}</button>)}</div>
        <button type="button" className="agent-effort-reset" disabled={blocked} onClick={()=>changeEffort("")}><RotateCcw size={14}/>跟随模型默认</button>
        <p className="agent-model-effective">从下一次发送生效</p>{error&&<p role="alert">{error}</p>}
      </div>
    </details>
  </div>;
}
