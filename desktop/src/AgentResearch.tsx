import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronLeft, FolderBookmark, Pin, X } from "lucide-react";
import type { ImageGrant } from "./AgentImages";
import type { NoteLocator } from "./AgentMaterials";
import type { InvestigationLocator } from "./AgentInvestigation";
import type { ResearchPolicy } from "./AgentAssistantOptions";
import { userProfileStorage } from "./UserProfileStorage";
import { skillTitle } from "./AgentSkills";
import { useAgentLibraryRegistry } from "./useAgentLibraryRegistry";

export type ResearchGrant = {images?:ImageGrant[];libraryIds:string[];notes:NoteLocator[];sources?:InvestigationLocator[];readingItemKeys:string[]};
export type ResearchTopic = {id:string;revision:number;title:string;pinned:boolean;grant:ResearchGrant;policy:ResearchPolicy;skills:string[];versions?:{locator:InvestigationLocator;title:string;version:unknown}[]};
export type ResearchSelection = {topic:ResearchTopic;manual:ResearchGrant;manualPolicy:ResearchPolicy;includeManual:boolean};
export const policyNames:Record<ResearchPolicy,string>={"material-first":"材料优先","materials-only":"仅依据材料",open:"开放研究"};
const call=<T,>(args:Record<string,unknown>)=>invoke<T>("agent_investigation",{args});
const unique=<T,>(items:T[])=>[...new Map(items.map(item=>[item&&typeof item==="object"?JSON.stringify(item,Object.keys(item).sort()):JSON.stringify(item),item])).values()];
export function AgentActiveTopic({topic,disabled,onChange,onCancel}:{topic:ResearchTopic;disabled:boolean;onChange:(topic:ResearchTopic)=>void;onCancel:()=>void}) {
  const registry=useAgentLibraryRegistry(true);
  const pages=unique<InvestigationLocator>([...topic.grant.notes,...(topic.grant.sources||[]),...topic.grant.readingItemKeys.map(itemKey=>({kind:"reading" as const,itemKey}))]);
  const label=(locator:InvestigationLocator)=>topic.versions?.find(v=>JSON.stringify(v.locator)===JSON.stringify(locator))?.title||("documentId" in locator?locator.documentId:"itemKey" in locator?locator.itemKey:"核心材料");
  function remove(locator:InvestigationLocator){const keep=(x:InvestigationLocator)=>JSON.stringify(x)!==JSON.stringify(locator);onChange({...topic,grant:{...topic.grant,notes:topic.grant.notes.filter(keep),sources:topic.grant.sources?.filter(keep),readingItemKeys:topic.grant.readingItemKeys.filter(itemKey=>keep({kind:"reading",itemKey}))},versions:topic.versions?.filter(v=>keep(v.locator))});}
  return <div className="agent-active-topic"><details><summary><FolderBookmark size={15}/><strong>{topic.title}</strong><small>{pages.length} 份材料 · {topic.grant.libraryIds.length} 个库</small></summary><div className="agent-active-topic-sources">
    {pages.map(locator=><div key={JSON.stringify(locator)}><span>{label(locator)}</span><button type="button" disabled={disabled} aria-label={`从当前专题移除材料 ${label(locator)}`} onClick={()=>remove(locator)}><X size={13}/></button></div>)}
    {topic.grant.libraryIds.map(id=><div key={id}><span>资料库 · {registry.libraries.find(l=>l.id===id)?.name||id}</span><button type="button" disabled={disabled} aria-label={`从当前专题移除资料库 ${registry.libraries.find(l=>l.id===id)?.name||id}`} onClick={()=>onChange({...topic,grant:{...topic.grant,libraryIds:topic.grant.libraryIds.filter(x=>x!==id)}})}><X size={13}/></button></div>)}
    {topic.skills.map(name=><div key={name}><span>技能 · {skillTitle(name)}</span><button type="button" disabled={disabled} aria-label={`从当前专题移除技能 ${skillTitle(name)}`} onClick={()=>onChange({...topic,skills:topic.skills.filter(x=>x!==name)})}><X size={13}/></button></div>)}
    <p>这里的移除只影响当前对话，从下一轮生效。</p></div></details><button type="button" disabled={disabled} aria-label="取消当前专题" onClick={onCancel}><X size={13}/></button></div>;
}
export function researchGrant(manual:ResearchGrant,topic?:ResearchGrant,includeManual=false):ResearchGrant {
  const selected=topic?(includeManual?[topic,manual]:[topic]):[manual];
  return {...(selected.some(g=>g.images)?{images:unique(selected.flatMap(g=>g.images||[]))}:{}),libraryIds:unique(selected.flatMap(g=>g.libraryIds)),notes:unique(selected.flatMap(g=>g.notes)),sources:unique(selected.flatMap(g=>g.sources||[])),readingItemKeys:unique(selected.flatMap(g=>g.readingItemKeys))};
}
export function useResearchSelection(key:string){
  const load=()=>{try{const s=JSON.parse(userProfileStorage.getItem("hub.agent.research."+key)||"null");if(s?.topic?.id&&Array.isArray(s.manual?.notes)&&Array.isArray(s.manual?.libraryIds)&&Array.isArray(s.manual?.readingItemKeys)&&Array.isArray(s.topic.grant?.notes)&&Array.isArray(s.topic.grant?.libraryIds)&&Array.isArray(s.topic.grant?.readingItemKeys)&&s.topic.policy in policyNames)return s as ResearchSelection;}catch{}return null;};
  const [state,setState]=useState<{key:string;value:ResearchSelection|null}>(()=>({key,value:load()}));
  if(state.key!==key)setState({key,value:load()});
  return [state.key===key?state.value:null,(value:ResearchSelection|null)=>{setState({key,value});try{if(value)userProfileStorage.setItem("hub.agent.research."+key,JSON.stringify(value));else userProfileStorage.removeItem("hub.agent.research."+key);}catch{}}] as const;
}
export function AgentResearchPolicy({value,disabled,onChange}:{value:ResearchPolicy;disabled:boolean;onChange:(v:ResearchPolicy)=>void}){
  return <div className="agent-research-policies">{(Object.keys(policyNames) as ResearchPolicy[]).map(policy=><button type="button" key={policy} disabled={disabled} className="agent-menu-choice" aria-pressed={value===policy} onClick={()=>onChange(policy)}><span><strong>{policyNames[policy]}</strong><small>{policy==="material-first"?"先读核心材料，必要时联网补充":policy==="materials-only"?"只使用所选材料，缺少依据时说明":"围绕问题研究，保持本地资料范围"}</small></span>{value===policy&&"✓"}</button>)}</div>;
}
export function AgentResearchTopics({open,saveMode,config,active,disabled,onApply,onClose,initialId,onBack,onMetadata}:{onBack?:()=>void;onMetadata?:(topic:ResearchTopic)=>void;initialId?:string;open:boolean;saveMode:boolean;config:Omit<ResearchTopic,"id"|"revision"|"title"|"pinned">;active?:ResearchTopic;disabled:boolean;onApply:(t:ResearchTopic)=>Promise<void>;onClose:()=>void}){
  const [topics,setTopics]=useState<ResearchTopic[]>([]),[query,setQuery]=useState(""),[title,setTitle]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false),[saveSkills,setSaveSkills]=useState(true);
  const [review,setReview]=useState<{topic:ResearchTopic;grant:ResearchGrant;unavailable:{reason:string}[];changed?:{reason:string}[];versions?:ResearchTopic["versions"]}|null>(null);
  const applying=useRef(false);
  const registry=useAgentLibraryRegistry(open);
  const libraryLabel=(id:string)=>registry.libraries.find(l=>l.id===id)?.name||id;
  const sequence=useRef(0);
  useEffect(()=>{const ticket=++sequence.current;if(open){setTitle(active?.title||"");setReview(null);setError("");void call<{topics:ResearchTopic[]}>({action:"researchTopics"}).then(v=>{if(ticket===sequence.current){const values=Array.isArray(v?.topics)?v.topics:[];setTopics(values);const selected=active?.id===initialId?active:values.find(t=>t.id===initialId);if(selected&&!saveMode)void checked(selected);}},e=>{if(ticket===sequence.current)setError(String(e));});}return()=>{sequence.current++;};},[open,initialId]);
  if(!open)return null;
  async function checked(topic:ResearchTopic){const ticket=sequence.current;setBusy(true);setError("");try{const r=await call<{grant:ResearchGrant;unavailable:{reason:string}[];changed?:{reason:string}[];versions?:ResearchTopic["versions"]}>({action:"checkResearchTopic",topic});if(ticket!==sequence.current)return;setReview({topic,...r});}catch(e){setError(String(e));}finally{setBusy(false);}}
  async function save(update=false){setBusy(true);setError("");try{const {images:_,...grant}=config.grant;const topic:ResearchTopic={...config,grant,skills:saveSkills?config.skills:[],id:update&&active?active.id:crypto.randomUUID(),revision:update&&active?active.revision:0,title:title.trim(),pinned:active?.pinned||false};await call({action:"saveResearchTopic",topic});onClose();}catch(e){setError(String(e));}finally{setBusy(false);}}
  const blocked=disabled||busy;
  async function applyReviewed(){
    if(!review||blocked||applying.current)return;
    const ticket=sequence.current;applying.current=true;setBusy(true);setError("");
    try{await onApply({...review.topic,grant:review.grant,versions:review.versions||review.topic.versions});if(ticket===sequence.current)onClose();}
    catch(e){if(ticket===sequence.current)setError(String(e));}
    finally{applying.current=false;if(ticket===sequence.current)setBusy(false);}
  }
  return <section className="agent-research-topics agent-assistant-settings" aria-label={saveMode?"保存研究专题":"全部专题"} onKeyDown={e=>{if(e.key==="Escape"){e.preventDefault();e.stopPropagation();if(!busy)onClose();}}}>
    <header className="agent-popover-header"><strong>{saveMode?"保存为专题":review?"核对专题资料":"全部专题"}</strong><button type="button" aria-label="关闭专题" disabled={busy} onClick={()=>{sequence.current++;onClose();}}><X size={16}/></button></header>
    {saveMode?<><label>专题名称<input autoFocus value={title} maxLength={100} onChange={e=>setTitle(e.target.value)}/></label><p>{config.grant.notes.length} 份核心页面 · {config.grant.libraryIds.length} 个资料库 · {policyNames[config.policy]}</p><label><input type="checkbox" checked={saveSkills} onChange={e=>setSaveSkills(e.target.checked)}/>同时保存所选技能</label><p className="agent-note">保存技能：{config.skills.map(skillTitle).join("、")||"无"}。专题只复用页面、库和所选技能；图片保留在当前对话。</p><button type="button" disabled={blocked||!title.trim()} onClick={()=>void save()}>保存新专题</button>{active&&<button type="button" disabled={blocked||!title.trim()} onClick={()=>void save(true)}>更新当前专题配置</button>}</>:review?<><button type="button" onClick={()=>setReview(null)}><ChevronLeft size={14}/>返回专题</button><h3>{review.topic.title}</h3><p>资料策略：{policyNames[review.topic.policy]}</p><ul>{review.versions?.map((v,i)=><li key={i}>{v.title}</li>)}{review.grant.libraryIds.map(id=><li key={id}>资料库 · {libraryLabel(id)}</li>)}</ul><p>{review.unavailable.length?`有 ${review.unavailable.length} 项资料不可用，未自动加入。`:review.changed?.length?"核心材料已更新，请核对后应用。":"从下一轮起使用专题资料。手选资料与技能保留，默认不额外加入。"}</p><ul>{review.unavailable.map((x,i)=><li key={i}>{x.reason}</li>)}</ul>{review.changed?.map((item,i)=><p key={i}>{item.reason}</p>)}<button type="button" disabled={blocked||!review.grant.notes.length&&!review.grant.libraryIds.length&&!review.grant.readingItemKeys.length&&!review.grant.sources?.length} onClick={()=>void applyReviewed()}>{review.unavailable.length?"确认仅使用剩余资料":review.changed?.length?"确认使用更新后的资料":"应用到当前对话"}</button><button type="button" disabled={blocked||!config.grant.notes.length&&!config.grant.libraryIds.length&&!config.grant.readingItemKeys.length&&!config.grant.sources?.length} onClick={()=>{setBusy(true);void call<ResearchTopic>({action:"saveResearchTopic",topic:{...review.topic,grant:{...config.grant,images:undefined},versions:[]}}).then(async topic=>{const r=await call<{grant:ResearchGrant;unavailable:{reason:string}[];changed?:{reason:string}[];versions?:ResearchTopic["versions"]}>({action:"checkResearchTopic",topic});setReview({topic,...r});},e=>setError(String(e))).finally(()=>setBusy(false));}}>用当前选择的资料修复专题</button><p className="agent-note">修复只保存配置；核对后再确认应用，不自动改变当前对话。</p></>:<><input type="search" aria-label="搜索专题" value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索专题"/><div className="agent-topic-list">{[...topics].sort((a,b)=>Number(b.pinned)-Number(a.pinned)).filter(t=>t.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(t=><div key={t.id}><button type="button" disabled={blocked} onClick={()=>void checked(t)}><strong>{t.title}</strong><small>{policyNames[t.policy]} · {t.grant.notes.length} 份核心页面 · {t.grant.libraryIds.length} 个库</small></button><button type="button" aria-label={`${t.pinned?"取消置顶":"置顶"}${t.title}`} aria-pressed={t.pinned} disabled={blocked} onClick={()=>{setBusy(true);void call<ResearchTopic>({action:"saveResearchTopic",topic:{...t,pinned:!t.pinned}}).then(v=>{setTopics(items=>items.map(x=>x.id===v.id?v:x));onMetadata?.(v);},e=>setError(String(e))).finally(()=>setBusy(false));}}><Pin size={14}/></button></div>)}</div>{!topics.length&&<p className="agent-note">先选择资料，再从资料范围保存为专题。原有固定方法专题仍在对话详情中。</p>}</>}
    {!saveMode&&!review&&onBack&&<button type="button" onClick={onBack}>返回任务模式</button>}
    {busy&&<p role="status">正在核对并保存…</p>}{error&&<p role="alert">{error}</p>}
  </section>;
}
