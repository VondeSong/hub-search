import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Search, X } from "lucide-react";
import { TagAssignmentInbox } from "./TagAssignmentInbox";
import { TagGovernanceInbox } from "./TagGovernanceInbox";
import type { AgentMaterial } from "./AgentMaterials";
import type { ResearchGrant } from "./AgentResearch";
import { userProfileStorage } from "./UserProfileStorage";

export type AgentTag = {tagId:string;label:string;entityCount?:number};
export type TagPreparation={active?:boolean;task:"definition"|"missing"|"relations";tag?:AgentTag;compare?:AgentTag;references:AgentTag[];resume:boolean};
export type TagTaskRecord={libraryIds?:string[];revision:number;runId:string;intent:{task:TagPreparation["task"];tag:string};result:{submitted?:{proposalId:string}[];coverage?:string;errors?:string[]}};
export const tagTaskNames={definition:"起草定义",missing:"查找漏标",relations:"比较关系"};
export function suggestedTagTask(text:string):TagPreparation["task"]|null {
  if(/(?:起草|生成|完善|修改).{0,8}标签.{0,6}定义|(?:起草|生成|完善|修改).{0,6}定义.{0,8}标签/.test(text))return "definition";
  if(/(?:查找|检查|核对|补充).{0,10}(?:漏标|漏打标签)|(?:漏标|漏打标签).{0,8}(?:查找|检查|核对)/.test(text))return "missing";
  if(/(?:比较|分析|核对).{0,10}标签.{0,8}(?:关系|区别|合并)|(?:标签关系).{0,8}(?:比较|分析|核对)/.test(text))return "relations";
  return null;
}
const initial:TagPreparation={task:"definition",references:[],resume:false};
export function useTagPreparation(key:string){
  const read=()=>{try{const v=JSON.parse(userProfileStorage.getItem("hub.agent.tags."+key)||"null");if(v&&v.task in tagTaskNames&&Array.isArray(v.references))return v as TagPreparation;}catch{}return initial;};
  const [saved,setSaved]=useState(()=>({key,value:read()}));
  if(saved.key!==key)setSaved({key,value:read()});
  return [saved.key===key?saved.value:initial,(value:TagPreparation)=>{setSaved({key,value});try{userProfileStorage.setItem("hub.agent.tags."+key,JSON.stringify(value));}catch{}}] as const;
}
export function AgentTagWorkspace({value,disabled,onChange,onCancel}:{value:TagPreparation;disabled:boolean;onChange:(v:TagPreparation)=>void;onCancel:()=>void}){
  const title=value.task==="definition"?"起草标签定义":value.task==="missing"?"查找可能漏标":"比较标签关系";
  const hint=value.task==="definition"?"确认后保存定义。":value.task==="missing"?"在当前资料库与已保存定义的交集中检查，每批最多 5 项。":"明确选择两个标签，或只选目标标签以查找相关候选。";
  return <section className="agent-mode-context agent-tag-workspace" aria-label="标签助手" title={hint}>
    <span className="agent-visually-hidden">{title}。{hint}</span>
    <nav aria-label="标签任务">{(Object.keys(tagTaskNames) as TagPreparation["task"][]).map(task=>
      <button type="button" key={task} disabled={disabled} aria-pressed={value.task===task} onClick={()=>onChange({...value,task,resume:false})}>{tagTaskNames[task]}</button>)}</nav>
    <button type="button" className="agent-mode-exit" aria-label="取消标签任务" onClick={onCancel}><X size={14}/></button>
  </section>;
}
export function AgentTagReferences({value,mode,disabled,onChange,searchOpen,onSearchClose}:{value:TagPreparation;mode:boolean;disabled:boolean;onChange:(v:TagPreparation)=>void;searchOpen:boolean;onSearchClose:()=>void}){
  const [replacing,setReplacing]=useState<string|null>(null);
  const [slot,setSlot]=useState<"tag"|"compare"|"references"|null>(null),[query,setQuery]=useState(""),[tags,setTags]=useState<AgentTag[]>([]),[cursor,setCursor]=useState<string|null>(null),[error,setError]=useState(""),[loading,setLoading]=useState(false);
  const [definition,setDefinition]=useState<{tag:string;version:number;description:string;include:string;exclude:string}|null>(null);
  const seq=useRef(0);
  useEffect(()=>{if(searchOpen){setReplacing(null);setSlot("references");}},[searchOpen]);
  async function load(more=false){const ticket=++seq.current;setLoading(true);setError("");try{const v=await invoke<{tags:AgentTag[];nextCursor:string|null}>("agent_investigation",{args:{action:"agentTags",query,limit:50,...(more&&cursor?{cursor}:{})}});if(ticket===seq.current){setTags(current=>more?[...current,...v.tags]:v.tags);setCursor(v.nextCursor);}}catch(e){if(ticket===seq.current)setError(String(e));}finally{if(ticket===seq.current)setLoading(false);}}
  useEffect(()=>{if(!slot)return;const timer=setTimeout(()=>void load(),250);return()=>{clearTimeout(timer);seq.current++;};},[query,slot]);
  async function show(tag:AgentTag){setError("");try{const d=await invoke<{definition:{version:number;definition:{description:string;include:string;exclude:string}}|null}>("tag_assignment",{args:{action:"definition",tag:tag.tagId}});setDefinition({tag:tag.tagId,version:d.definition?.version||0,description:d.definition?.definition.description||"尚未保存定义",include:d.definition?.definition.include||"",exclude:d.definition?.definition.exclude||""});}catch(e){setError(String(e));}}
  const close=()=>{setSlot(null);onSearchClose();};
  const select=(tag:AgentTag)=>{
    if(disabled||!slot)return;
    if(slot==="references"){
      if(!replacing&&value.references.length>=16){setError("最多添加 16 个标签引用");return;}
      onChange({...value,references:[...value.references.filter(t=>t.tagId!==replacing&&t.tagId!==tag.tagId),tag]});
    }else{
      const other=slot==="tag"?"compare":"tag";
      onChange({...value,[slot]:tag,...(value[other]?.tagId===tag.tagId?{[other]:value[slot]}:{})});
    }
    setDefinition(null);close();
  };
  const chip=(tag:AgentTag|undefined,kind:"tag"|"compare")=><span className="agent-tag-token"><button type="button" disabled={disabled} onClick={()=>{setSlot(kind);if(tag)void show(tag);}}>#{tag?.label||(kind==="tag"?"选择目标标签":"选择比较标签（可选）")}</button>{tag&&<button type="button" disabled={disabled} aria-label={`移除${kind==="tag"?"目标":"比较"}标签`} onClick={()=>onChange({...value,[kind]:undefined})}><X size={12}/></button>}</span>;
  return <div className="agent-tag-references" aria-label="本次标签引用">{mode&&<>{chip(value.tag,"tag")}{value.task==="relations"&&chip(value.compare,"compare")}{value.task==="missing"&&<label><input type="checkbox" disabled={disabled} checked={value.resume} onChange={e=>onChange({...value,resume:e.target.checked})}/>从已保存的候选继续</label>}</>}{!mode&&value.references.map(tag=><span className="agent-tag-token" key={tag.tagId}><button type="button" onClick={()=>{setReplacing(tag.tagId);setSlot("references");void show(tag);}}>#{tag.label}</button><button type="button" aria-label={`移除标签引用 ${tag.label}`} disabled={disabled} onClick={()=>onChange({...value,references:value.references.filter(t=>t.tagId!==tag.tagId)})}><X size={12}/></button></span>)}
    {definition&&<details open className="agent-tag-definition"><summary>#{definition.tag} · 定义{definition.version?`版本 ${definition.version}`:"未设置"}<button type="button" aria-label="关闭标签定义" onClick={()=>setDefinition(null)}><X size={12}/></button></summary><p>{definition.description}</p>{definition.include&&<p>纳入：{definition.include}</p>}{definition.exclude&&<p>排除：{definition.exclude}</p>}</details>}
    {slot&&<section className="agent-tag-picker" aria-label="选择标签"><header><label><Search size={14}/><input autoFocus aria-label="搜索全部标签" placeholder="搜索全部标签" onKeyDown={e=>{if(e.key==="Enter"&&tags[0]&&!loading){e.preventDefault();select(tags[0]);}}} value={query} onChange={e=>setQuery(e.target.value)}/></label><button type="button" aria-label="关闭标签选择" onClick={close}><X size={14}/></button></header><div>{tags.map(tag=><div key={tag.tagId}><button type="button" disabled={disabled} onClick={()=>select(tag)}>#{tag.label}<small>{tag.entityCount}</small></button><button type="button" onClick={()=>void show(tag)}>查看定义</button></div>)}</div>{cursor&&<button type="button" disabled={loading} onClick={()=>void load(true)}>加载更多标签</button>}{!loading&&!tags.length&&<p>没有找到标签</p>}{loading&&<p role="status">正在查找…</p>}</section>}{error&&<p role="alert">{error}</p>}
  </div>;
}
export function AgentTagResult({record}:{record:TagTaskRecord}){
  const ids=record.result.submitted?.map(p=>p.proposalId)||[];
  return <details className="agent-tag-result"><summary>标签任务 · {tagTaskNames[record.intent.task]} · #{record.intent.tag}</summary>{record.result.coverage&&<p>{record.result.coverage}</p>}{record.result.errors?.map((error,i)=><p role="alert" key={i}>{error}</p>)}{record.intent.task==="relations"?<TagGovernanceInbox tagId={record.intent.tag} assistantOnly proposalIds={ids}/>:<TagAssignmentInbox tagId={record.intent.tag} assistantOnly initialLibraryIds={record.libraryIds} proposalIds={ids}/>}</details>;
}

export function AgentTagRelated({tags,grant,disabled,onAdd}:{tags:AgentTag[];grant:ResearchGrant;disabled:boolean;onAdd:(item:AgentMaterial)=>void}){
  const [all,setAll]=useState(false),[items,setItems]=useState<AgentMaterial[]>([]),[error,setError]=useState("");
  const [busy,setBusy]=useState(false),[shown,setShown]=useState(false);
  const scope=JSON.stringify([tags.map(t=>t.tagId),grant]);const epoch=useRef(0);
  useEffect(()=>{epoch.current++;setItems([]);setError("");setShown(false);setBusy(false);},[scope,all]);
  if(!tags.length)return null;
  return <details className="agent-tag-related"><summary>查找标签关联资料</summary><label><input type="checkbox" checked={all} onChange={e=>setAll(e.target.checked)}/>同时包含全部标签（不选则匹配任一）</label><button type="button" disabled={disabled||busy||(!grant.libraryIds.length&&!grant.notes.length)} onClick={()=>{const ticket=++epoch.current;setBusy(true);setError("");void invoke<{materials:AgentMaterial[]}>("agent_investigation",{args:{action:"relatedTagMaterials",tags:tags.map(t=>t.tagId),matchAll:all,grant}}).then(v=>{if(ticket===epoch.current){setItems(v.materials);setShown(true);}},e=>{if(ticket===epoch.current)setError(String(e));}).finally(()=>{if(ticket===epoch.current)setBusy(false);});}}>在当前资料范围查找</button>{!grant.libraryIds.length&&!grant.notes.length&&<p>请先选择核心页面或可检索资料库。</p>}{items.map(item=><button type="button" key={JSON.stringify(item.locator)} disabled={disabled} onClick={()=>onAdd(item)}>{item.title}<small>{item.libraryName} · {item.path} · 添加为核心材料</small></button>)}{shown&&!items.length&&<p>当前范围没有找到匹配页面。</p>}{error&&<p role="alert">{error}</p>}</details>;
}
